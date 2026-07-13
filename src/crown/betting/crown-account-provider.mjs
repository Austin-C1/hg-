import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  getCrownCapability,
} from './crown-capability-matrix.mjs'
import { buildStrictCrownPreviewFields, buildStrictCrownPreviewWireFields } from './crown-order-field-mapper.mjs'
import { parseCrownPreviewResponseStrict } from './crown-bet-response-parser.mjs'
import { assertLockedSelectionEnvelope, executionIdentityFromEnvelope } from './execution-identity.mjs'

const DEFAULT_CAPABILITY_RESOLVER = Object.freeze({
  resolvePreview(input) {
    return assertCrownCapability(getCrownCapability(input), { operation: 'preview' })
  },
  assertFieldSets(capability, observed) {
    return assertCrownCapabilityFieldSets(capability, observed)
  },
})

function requiredText(value, code) {
  const text = String(value || '').trim()
  if (!text) throw new TypeError(code)
  return text
}

function bettingAccountId(value) {
  const accountId = requiredText(value, 'betting-account-id-required')
  if (accountId === 'mon_primary') throw new Error('betting-account-monitor-forbidden')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) throw new Error('betting-account-id-invalid')
  return accountId
}

function canonicalLine(value) {
  const parts = String(value || '').split('/').map((part) => part.trim())
  if (parts.length < 1 || parts.length > 2) {
    throw new Error('crown-preview-locked-line-invalid')
  }
  return parts.map((part) => {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(part)
    const fraction = match?.[3] || ''
    if (!match || fraction.length > 6) throw new Error('crown-preview-locked-line-invalid')
    const coefficientText = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, '') || '0'
    if (BigInt(coefficientText) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('crown-preview-locked-line-invalid')
    }
    const normalizedFraction = fraction.replace(/0+$/, '')
    const isZero = /^0+$/.test(coefficientText)
    return `${match[1] && !isZero ? '-' : ''}${match[2]}${normalizedFraction ? `.${normalizedFraction}` : ''}`
  }).join(' / ')
}

function capabilityInput(lockedSelection) {
  return {
    mode: lockedSelection.mode || lockedSelection.event?.mode,
    period: lockedSelection.market?.period,
    marketType: lockedSelection.market?.marketType,
    lineVariant: lockedSelection.market?.lineVariant,
  }
}

function assertLockedSelection(value) {
  const envelope = assertLockedSelectionEnvelope(value)
  if (envelope.provider !== 'crown') throw new Error('crown-preview-provider-mismatch')
  if (!String(envelope.snapshot.event?.ids?.gid || '').trim()) throw new Error('missing-crown-gid')
  executionIdentityFromEnvelope(envelope, { provider: 'crown' })
  return envelope
}

function assertResolver(value) {
  if (!value || typeof value.resolvePreview !== 'function' || typeof value.assertFieldSets !== 'function') {
    throw new TypeError('crown-capability-resolver')
  }
  return value
}

function assertLease(value) {
  if (!value || typeof value.assertFence !== 'function') throw new TypeError('crown-preview-executor-lease')
  if (!/^betting-executor:\S+$/.test(String(value.leaseKey || ''))) throw new Error('crown-preview-executor-lease-key')
  return value
}

function safeLog(logger, type, payload) {
  const row = { type, at: new Date().toISOString(), ...payload }
  if (typeof logger === 'function') logger(row)
  else if (typeof logger?.log === 'function') logger.log(row)
}

function responseIdentity(orderFields, expectedIdentity) {
  const identity = {
    provider: 'crown',
    gid: requiredText(orderFields.identity?.gid, 'missing-crown-gid'),
    mode: requiredText(orderFields.identity?.mode, 'missing-crown-preview-mode'),
    period: requiredText(orderFields.identity?.period, 'missing-crown-preview-period'),
    market: requiredText(orderFields.identity?.market, 'missing-crown-preview-market'),
    line: requiredText(orderFields.identity?.line, 'missing-crown-line'),
    side: requiredText(orderFields.identity?.side, 'missing-crown-preview-side'),
  }
  if (identity.gid !== expectedIdentity.gid) throw new Error('crown-preview-gid-changed')
  if (identity.mode !== expectedIdentity.mode) throw new Error('crown-preview-mode-changed')
  if (identity.period !== expectedIdentity.period) throw new Error('crown-preview-period-changed')
  if (identity.market !== expectedIdentity.market) throw new Error('crown-preview-market-changed')
  if (identity.line !== expectedIdentity.line) {
    throw new Error('crown-preview-line-identity-changed')
  }
  if (identity.side !== expectedIdentity.side) throw new Error('crown-preview-side-changed')
  return identity
}

export class CrownAccountPreviewProvider {
  constructor(options = {}) {
    const offlineFixture = options.offlineFixture === true
    if (Object.hasOwn(options, 'capabilityResolver') && !offlineFixture) {
      throw new Error('crown-capability-resolver-injection-forbidden')
    }
    const {
      repository,
      loginManager,
      executorLease,
      logger = null,
      capabilityResolver,
    } = options
    this.repository = repository
    this.loginManager = loginManager
    this.executorLease = assertLease(executorLease)
    this.capabilityResolver = offlineFixture
      ? assertResolver(capabilityResolver)
      : DEFAULT_CAPABILITY_RESOLVER
    this.offlineFixture = offlineFixture
    this.logger = logger
  }

  _assertFence() {
    const fencingToken = this.executorLease.fencingToken
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new Error('crown-preview-executor-fence')
    const current = this.executorLease.assertFence(fencingToken)
    if (current !== fencingToken) throw new Error('crown-preview-executor-fence')
    return fencingToken
  }

  async preview(input = {}) {
    if (Object.hasOwn(input, 'capability')) throw new Error('preview-capability-caller-forbidden')
    const accountId = bettingAccountId(input.accountId)
    const batchId = requiredText(input.batchId, 'bet-batch-id-required')
    const lockedSelection = assertLockedSelection(input.lockedSelection)
    const snapshot = lockedSelection.snapshot
    const expectedIdentity = executionIdentityFromEnvelope(lockedSelection, { provider: 'crown' })
    const capability = await this.capabilityResolver.resolvePreview(capabilityInput(snapshot))
    const orderFields = buildStrictCrownPreviewFields(snapshot, { capability })
    const lockedIdentity = responseIdentity(orderFields, expectedIdentity)
    const expectedLine = canonicalLine(snapshot.market.handicapRaw)

    this._assertFence()
    if (typeof this.repository?.getBettingAccountForExecution !== 'function') {
      throw new TypeError('crown-preview-account-repository')
    }
    const account = this.repository.getBettingAccountForExecution(accountId)
    if (account?.id !== accountId) throw new Error('betting-account-identity-mismatch')
    if (this.offlineFixture) {
      let hostname = ''
      try { hostname = new URL(account.loginUrl).hostname.toLowerCase() } catch {}
      if (hostname !== 'example.test' && !hostname.endsWith('.example.test')) {
        throw new Error('offline-preview-fixture-origin-required')
      }
    }
    if (typeof this.loginManager?.ensureBettingSession !== 'function') {
      throw new TypeError('crown-preview-login-manager')
    }
    safeLog(this.logger, 'crown-preview-login-start', { accountId, batchId, capabilityEvidenceId: capability.evidenceId })
    const authenticated = await this.loginManager.ensureBettingSession({
      account,
      logger: this.logger,
      assertFence: () => this._assertFence(),
      requireVerifiedProtocolVersion: true,
    })
    const session = authenticated?.session
    if (
      !session
      || session.accountId !== accountId
      || session.username !== account.username
      || session.baseUrl !== account.loginUrl
      || !String(session.uid || '').trim()
    ) {
      throw new Error('betting-session-owner-mismatch')
    }
    const wireFields = buildStrictCrownPreviewWireFields(orderFields.preview, {
      capability,
      protocolVersion: session.protocolVersion,
      protocolVersionEvidence: session.protocolVersionEvidence,
    })
    await this.capabilityResolver.assertFieldSets(capability, {
      requestFieldSet: Object.keys(wireFields),
    })

    this._assertFence()
    if (typeof this.loginManager?.client?.postForm !== 'function') throw new TypeError('crown-preview-transport')
    const cookies = { ...(session.cookies || {}) }
    safeLog(this.logger, 'crown-preview-request-start', { accountId, batchId, capabilityEvidenceId: capability.evidenceId })
    let response
    try {
      response = await this.loginManager.client.postForm({
        baseUrl: session.baseUrl,
        endpointPath: '/transform.php',
        form: {
          uid: session.uid,
          ...wireFields,
        },
        cookies,
      })
    } catch {
      const error = new Error('crown-preview-request-failed')
      error.code = 'crown-preview-request-failed'
      throw error
    }
    this._assertFence()

    const parsed = parseCrownPreviewResponseStrict(response.text)
    await this.capabilityResolver.assertFieldSets(capability, {
      responseFieldSet: parsed.responseFieldSet,
    })
    if (parsed.line.exact !== expectedLine) throw new Error('crown-preview-line-changed')
    if (typeof this.loginManager?.bettingStoreFor !== 'function') throw new TypeError('crown-preview-session-store')
    const ownedAccount = { ...account, accountId }
    this.loginManager.bettingStoreFor(ownedAccount).saveSession(ownedAccount, {
      ...session,
      cookies: response.cookies,
      savedAt: Date.now(),
    })
    safeLog(this.logger, 'crown-preview-result', {
      accountId,
      batchId,
      capabilityEvidenceId: capability.evidenceId,
      capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
      status: parsed.ok ? 'previewed' : 'preview-rejected',
      responseCode: parsed.code,
      responseFieldSetFingerprint: parsed.responseFieldSetFingerprint,
    })
    return {
      status: parsed.ok ? 'previewed' : 'preview-rejected',
      accountId,
      batchId,
      operation: orderFields.operation,
      capabilityEvidenceId: capability.evidenceId,
      lockedIdentity,
      preview: parsed,
      capacityMinor: null,
      currency: parsed.currency,
      stakeStep: parsed.stakeStep,
      realExecutionEligible: false,
      realExecutionBlockers: [
        'preview-capacity-unverified',
        'preview-currency-unverified',
        'preview-stake-step-unverified',
      ],
    }
  }
}

export function createOfflineCrownAccountPreviewFixture(options = {}) {
  if (!Object.hasOwn(options, 'capabilityResolver')) throw new TypeError('offline-capability-resolver-required')
  return new CrownAccountPreviewProvider({ ...options, offlineFixture: true })
}

export default CrownAccountPreviewProvider
