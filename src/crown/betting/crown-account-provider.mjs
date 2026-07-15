import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  getCrownCapability,
} from './crown-capability-matrix.mjs'
import { buildStrictCrownPreviewFields, buildStrictCrownPreviewWireFields } from './crown-order-field-mapper.mjs'
import { parseCrownPreviewResponseStrict } from './crown-bet-response-parser.mjs'
import { assertLockedSelectionEnvelope, executionIdentityFromEnvelope } from './execution-identity.mjs'
import { isCrownAcceptanceCapabilityAuthority } from './crown-browser-acceptance.mjs'

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

function exactCnyInteger(value, code) {
  const match = /^(0|[1-9]\d*)(?:\.0+)?$/.exec(String(value || '').trim())
  if (!match) throw new Error(code)
  const number = BigInt(match[1])
  if (number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code)
  return Number(number)
}

function assertBrowserRuntime(value) {
  if (!value
    || typeof value.ensureBettingSession !== 'function'
    || typeof value.fetchFreshExecutionBalance !== 'function'
    || typeof value.postPreviewForm !== 'function') {
    throw new TypeError('crown-preview-browser-runtime')
  }
  return value
}

function assertBrowserSession(session, account) {
  if (!session
    || session.accountId !== account.id
    || session.username !== account.username
    || !String(session.contextGeneration || '').trim()
    || !String(session.uid || '').trim()
    || !String(session.protocolVersion || '').trim()
    || !['production-login-response', 'production-session-metadata']
      .includes(session.protocolVersionEvidence?.source)
    || session.protocolVersionEvidence?.captured !== true
    || session.protocolVersionEvidence?.verified !== true
    || Object.hasOwn(session, 'cookies')) {
    throw new Error('betting-session-owner-mismatch')
  }
  if (session.origin !== account.loginUrl || session.baseUrl !== account.loginUrl) {
    throw new Error('betting-session-owner-mismatch')
  }
  return session
}

function capabilityInput(lockedSelection) {
  return {
    mode: lockedSelection.mode || lockedSelection.event?.mode,
    period: lockedSelection.market?.period,
    marketType: lockedSelection.market?.marketType,
    lineVariant: lockedSelection.market?.lineVariant,
    selectionSide: lockedSelection.selection?.side,
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
    lineVariant: requiredText(orderFields.identity?.lineVariant, 'missing-crown-line-variant'),
    line: requiredText(orderFields.identity?.line, 'missing-crown-line'),
    side: requiredText(orderFields.identity?.side, 'missing-crown-preview-side'),
  }
  if (identity.gid !== expectedIdentity.gid) throw new Error('crown-preview-gid-changed')
  if (identity.mode !== expectedIdentity.mode) throw new Error('crown-preview-mode-changed')
  if (identity.period !== expectedIdentity.period) throw new Error('crown-preview-period-changed')
  if (identity.market !== expectedIdentity.market) throw new Error('crown-preview-market-changed')
  if (identity.lineVariant !== expectedIdentity.lineVariant) throw new Error('crown-preview-line-variant-changed')
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
      browserRuntime,
      executorLease,
      logger = null,
      capabilityResolver,
      acceptanceAuthority = null,
    } = options
    if (acceptanceAuthority !== null && !isCrownAcceptanceCapabilityAuthority(acceptanceAuthority)) {
      throw new TypeError('crown-acceptance-authority')
    }
    if (acceptanceAuthority !== null && offlineFixture) throw new Error('crown-acceptance-offline-forbidden')
    this.repository = repository
    this.browserRuntime = assertBrowserRuntime(browserRuntime)
    this.executorLease = assertLease(executorLease)
    this.capabilityResolver = offlineFixture
      ? assertResolver(capabilityResolver)
      : DEFAULT_CAPABILITY_RESOLVER
    this.acceptanceAuthority = acceptanceAuthority
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
    const direction = capabilityInput(snapshot)
    const resolver = input.acceptanceClaim
      ? Object.freeze({
          resolvePreview(value) {
            return this.acceptanceAuthority.resolveCapability({
              operation: 'preview', direction: value, candidateClaim: input.acceptanceClaim,
            })
          },
          assertFieldSets(capability, observed) {
            return assertCrownCapabilityFieldSets(getCrownCapability({
              mode: capability.mode,
              period: capability.period,
              marketType: capability.marketType,
              lineVariant: capability.lineVariant,
              selectionSide: capability.selectionSide,
            }), observed)
          },
          acceptanceAuthority: this.acceptanceAuthority,
        })
      : this.capabilityResolver
    if (input.acceptanceClaim && !this.acceptanceAuthority) throw new Error('crown-acceptance-authority-required')
    const capability = await resolver.resolvePreview(direction)
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
      if (hostname !== 'offline-preview.example.com') {
        throw new Error('offline-preview-fixture-origin-required')
      }
    }
    safeLog(this.logger, 'crown-preview-login-start', { accountId, batchId, capabilityEvidenceId: capability.evidenceId })
    const session = assertBrowserSession(await this.browserRuntime.ensureBettingSession({
      account,
      assertFence: () => this._assertFence(),
      signal: input.signal,
    }), account)
    const wireFields = buildStrictCrownPreviewWireFields(orderFields.preview, {
      capability,
      protocolVersion: session.protocolVersion,
      protocolVersionEvidence: session.protocolVersionEvidence,
    })
    await resolver.assertFieldSets(capability, {
      requestFieldSet: Object.keys(wireFields),
    })

    const freshBalance = await this.browserRuntime.fetchFreshExecutionBalance({
      account,
      session,
      assertFence: () => this._assertFence(),
      signal: input.signal,
    })
    if (freshBalance?.session !== session
      || freshBalance?.summary?.valid !== true
      || freshBalance.summary.reportedCurrency !== 'CNY'
      || freshBalance?.transport?.operation !== 'get_member_data') {
      throw new Error('crown-preview-fresh-balance-invalid')
    }
    const freshBalanceCny = exactCnyInteger(
      freshBalance.summary.reportedBalance,
      'crown-preview-fresh-balance-invalid',
    )

    this._assertFence()
    safeLog(this.logger, 'crown-preview-request-start', { accountId, batchId, capabilityEvidenceId: capability.evidenceId })
    let response
    try {
      response = await this.browserRuntime.postPreviewForm({
        account,
        session,
        wireFields,
        assertFence: () => this._assertFence(),
        signal: input.signal,
      })
    } catch {
      const error = new Error('crown-preview-request-failed')
      error.code = 'crown-preview-request-failed'
      throw error
    }
    this._assertFence()
    if (response?.transport?.operation !== capability.endpoints.preview.functionName
      || response?.transport?.endpointPath !== capability.endpoints.preview.path) {
      throw new Error('crown-preview-transport-invalid')
    }

    const livePreview = capability.mode === 'live'
    const parsed = parseCrownPreviewResponseStrict(response.text, {
      expectedFieldSet: livePreview
        ? [...capability.responseFieldSets.preview, 'score']
        : capability.responseFieldSets.preview,
    })
    if (!livePreview) {
      await resolver.assertFieldSets(capability, {
        responseFieldSet: parsed.responseFieldSet,
      })
    }
    if (parsed.line.exact !== expectedLine) throw new Error('crown-preview-line-changed')
    const minStakeMinor = exactCnyInteger(parsed.minStake.exact, 'crown-preview-cny-integer-required')
    const maxStakeMinor = exactCnyInteger(parsed.maxStake.exact, 'crown-preview-cny-integer-required')
    const submitValue = (value) => /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(value || ''))
    const providerStakeStep = parsed.stakeStep?.verified === true
      && Number.isSafeInteger(parsed.stakeStep.value)
      && parsed.stakeStep.value > 0
      ? parsed.stakeStep.value
      : null
    const accountStakeStep = Number.isSafeInteger(account.stakeStepMinor)
      && account.stakeStepMinor > 0
      ? account.stakeStepMinor
      : null
    const verifiedStakeStep = providerStakeStep ?? accountStakeStep
    const stakeStepProvenance = providerStakeStep !== null
      ? parsed.stakeStep.source
      : accountStakeStep !== null
        ? 'verified-account-policy'
        : parsed.stakeStep.source
    const exactExecutionRow = parsed.ok === true
      && capability.previewAllowed === true
      && capability.submitAllowed === true
      && capability.selectionSide === lockedIdentity.side
      && account.currency === 'CNY'
      && account.amountScale === 0
      && accountStakeStep !== null
      && Number.isSafeInteger(account.perBetLimitMinor)
      && account.perBetLimitMinor >= minStakeMinor
      && freshBalanceCny >= minStakeMinor
      && minStakeMinor > 0
      && maxStakeMinor >= minStakeMinor
      && submitValue(parsed.submitCon?.exact)
      && submitValue(parsed.submitRatio?.exact)
    const executionPreview = exactExecutionRow ? Object.freeze({
      minStakeMinor,
      maxStakeMinor,
      stakeStepMinor: verifiedStakeStep,
      stakeStepProvenance,
      odds: parsed.odds.exact,
      line: parsed.line.exact,
      submitCon: parsed.submitCon.exact,
      submitRatio: parsed.submitRatio.exact,
      currency: 'CNY',
      amountScale: 0,
      lockedIdentity,
    }) : null
    safeLog(this.logger, 'crown-preview-result', {
      accountId,
      batchId,
      capabilityEvidenceId: capability.evidenceId,
      capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
      status: parsed.ok ? 'previewed' : 'preview-rejected',
      responseCode: parsed.code,
      responseFieldSetFingerprint: parsed.responseFieldSetFingerprint,
      transportKind: 'browser-page-fetch',
    })
    const result = {
      status: parsed.ok ? 'previewed' : 'preview-rejected',
      accountId,
      batchId,
      operation: orderFields.operation,
      capabilityEvidenceId: capability.evidenceId,
      capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
      transportKind: 'browser-page-fetch',
      lockedIdentity,
      preview: parsed,
      capacityMinor: exactExecutionRow
        ? (verifiedStakeStep === null
            ? minStakeMinor
            : minStakeMinor + Math.floor(
              (Math.min(maxStakeMinor, freshBalanceCny, account.perBetLimitMinor) - minStakeMinor) / verifiedStakeStep,
            ) * verifiedStakeStep)
        : null,
      freshBalanceCny,
      balanceObservedAt: new Date().toISOString(),
      currency: exactExecutionRow
        ? { value: 'CNY', source: 'account-summary', verified: true }
        : parsed.currency,
      stakeStep: exactExecutionRow
        ? parsed.stakeStep
        : parsed.stakeStep,
      realExecutionEligible: exactExecutionRow,
      realExecutionBlockers: exactExecutionRow ? [] : [
        'preview-capacity-unverified',
        'preview-currency-unverified',
        'preview-stake-step-unverified',
      ],
    }
    if (executionPreview) result.executionPreview = executionPreview
    Object.defineProperty(result, 'browserSession', { value: session })
    return result
  }
}

export function createOfflineCrownAccountPreviewFixture(options = {}) {
  if (!Object.hasOwn(options, 'capabilityResolver')) throw new TypeError('offline-capability-resolver-required')
  return new CrownAccountPreviewProvider({ ...options, offlineFixture: true })
}

export default CrownAccountPreviewProvider
