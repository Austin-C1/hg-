import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  getCrownCapability,
} from './crown-capability-matrix.mjs'
import { buildStrictCrownSubmitWireFields } from './crown-order-field-mapper.mjs'
import { parseCrownSubmitResponseStrict } from './crown-bet-response-parser.mjs'
import {
  assertExecutionIdentity,
  assertLockedSelectionEnvelope,
  executionIdentityFromEnvelope,
} from './execution-identity.mjs'

function text(value, code) {
  const result = String(value || '').trim()
  if (!result) throw new TypeError(code)
  return result
}

function accountId(value) {
  const result = text(value, 'betting-account-id-required')
  if (result === 'mon_primary') throw new Error('betting-account-monitor-forbidden')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) throw new Error('betting-account-id-invalid')
  return result
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function exactHttpsOrigin(value, code) {
  const raw = text(value, code)
  let url
  try { url = new URL(raw) } catch { throw new Error(code) }
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || raw !== url.origin) throw new Error(code)
  return url.origin
}

function safeLog(logger, type, payload) {
  const row = { type, at: new Date().toISOString(), ...payload }
  if (typeof logger === 'function') logger(row)
  else if (typeof logger?.log === 'function') logger.log(row)
}

function assertLease(value) {
  if (!value || typeof value.assertFence !== 'function') throw new TypeError('crown-submit-executor-lease')
  if (!/^betting-executor:\S+$/.test(String(value.leaseKey || ''))) throw new Error('crown-submit-executor-lease-key')
  return value
}

function decimal(value, code) {
  const result = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(result)) throw new Error(code)
  const [whole, fraction = ''] = result.split('.')
  const normalized = fraction.replace(/0+$/, '')
  return normalized ? `${whole}.${normalized}` : whole
}

function identityOf(input = {}) {
  const lockedIdentity = assertExecutionIdentity(input.lockedIdentity)
  const lockedSelection = assertLockedSelectionEnvelope(input.lockedSelection)
  const envelopeIdentity = executionIdentityFromEnvelope(lockedSelection, { provider: 'crown' })
  if (!same(lockedIdentity, envelopeIdentity)) throw new Error('crown-submit-locked-identity-drift')
  return { lockedIdentity, lockedSelection }
}

export class CrownAccountExecutionProvider {
  constructor({ repository, loginManager, previewProvider, executorLease, logger = null } = {}) {
    if (typeof repository?.getBettingAccountForExecution !== 'function'
      || typeof repository?.getCurrentCrownSelectionForExecution !== 'function'
      || typeof repository?.sealCrownProviderReference !== 'function') {
      throw new TypeError('crown-submit-account-repository')
    }
    if (typeof loginManager?.bettingStoreFor !== 'function'
      || typeof loginManager?.client?.postForm !== 'function') {
      throw new TypeError('crown-submit-login-manager')
    }
    if (typeof previewProvider?.preview !== 'function') throw new TypeError('crown-submit-preview-provider')
    this.repository = repository
    this.loginManager = loginManager
    this.previewProvider = previewProvider
    this.executorLease = assertLease(executorLease)
    this.logger = logger
  }

  _assertFence() {
    const token = this.executorLease.fencingToken
    if (!Number.isSafeInteger(token) || token < 1) throw new Error('crown-submit-executor-fence')
    if (this.executorLease.assertFence(token) !== token) throw new Error('crown-submit-executor-fence')
    return token
  }

  async submit(input = {}) {
    for (const name of ['capability', 'capabilityResolver', 'form', 'wireFields', 'submitFields', 'currentIdentity']) {
      if (Object.hasOwn(input, name)) throw new Error('crown-submit-caller-wire-forbidden')
    }
    if (String(input.capabilityVersion || '') !== CROWN_CAPABILITY_MATRIX_VERSION) {
      throw new Error('crown-capability-version-mismatch')
    }
    const { lockedIdentity, lockedSelection } = identityOf(input)
    const capability = assertCrownCapability(getCrownCapability({
      mode: lockedIdentity.mode,
      period: lockedIdentity.period,
      marketType: lockedIdentity.market,
      lineVariant: lockedIdentity.lineVariant,
    }), { operation: 'submit' })
    if (text(input.capabilityEvidenceId, 'crown-capability-evidence-required') !== capability.evidenceId) {
      throw new Error('crown-capability-evidence-mismatch')
    }
    const ownerId = accountId(input.accountId)
    const childOrderId = text(input.childOrderId, 'child-order-id-required')
    const submitAttemptId = text(input.submitAttemptId, 'submit-attempt-id-required')
    const amountMinor = input.amountMinor
    if (!Number.isSafeInteger(amountMinor) || amountMinor !== 50
      || input.remainingChildAmountMinor !== amountMinor) throw new Error('crown-submit-amount-blocked')
    if (typeof input.onNetworkStarted !== 'function') throw new TypeError('crown-submit-network-callback')

    this._assertFence()
    const currentSelection = this.repository.getCurrentCrownSelectionForExecution(lockedSelection)
    const currentIdentity = executionIdentityFromEnvelope(currentSelection, { provider: 'crown' })
    if (!same(lockedIdentity, currentIdentity)) throw new Error('crown-submit-current-identity-drift')
    const preparedOdds = decimal(input.preview?.odds, 'crown-submit-fresh-preview-drift')
    const currentOdds = decimal(
      currentSelection.snapshot?.selection?.oddsRaw ?? currentSelection.snapshot?.selection?.odds,
      'crown-submit-fresh-preview-drift',
    )
    if (preparedOdds !== currentOdds) throw new Error('crown-submit-fresh-preview-drift')

    const fresh = await this.previewProvider.preview({
      accountId: ownerId,
      batchId: text(input.batchId, 'bet-batch-id-required'),
      lockedSelection: currentSelection,
    })
    this._assertFence()
    if (fresh?.capabilityVersion !== input.capabilityVersion
      || fresh?.capabilityEvidenceId !== input.capabilityEvidenceId
      || !same(fresh?.lockedIdentity, currentIdentity)) {
      throw new Error('crown-submit-current-identity-drift')
    }
    const freshExecutionPreview = fresh.executionPreview
    const freshBalanceCny = fresh.freshBalanceCny
    const preparedPreview = input.preview
    if (!freshExecutionPreview || typeof freshExecutionPreview !== 'object'
      || !Number.isSafeInteger(freshBalanceCny)
      || !same(freshExecutionPreview.lockedIdentity, currentIdentity)
      || freshExecutionPreview.minStakeMinor !== preparedPreview?.minStakeMinor
      || freshExecutionPreview.maxStakeMinor !== preparedPreview?.maxStakeMinor
      || freshExecutionPreview.stakeStepMinor !== preparedPreview?.stakeStepMinor
      || freshExecutionPreview.stakeStepProvenance !== preparedPreview?.stakeStepProvenance
      || freshExecutionPreview.currency !== preparedPreview?.currency
      || freshExecutionPreview.amountScale !== preparedPreview?.amountScale
      || freshExecutionPreview.line !== lockedIdentity.line
      || freshExecutionPreview.line !== preparedPreview?.line
      || freshExecutionPreview.submitCon !== preparedPreview?.submitCon
      || freshExecutionPreview.submitRatio !== preparedPreview?.submitRatio
      || decimal(freshExecutionPreview.odds, 'crown-submit-fresh-preview-drift') !== preparedOdds
      || freshBalanceCny !== preparedPreview?.balanceMinor
      || amountMinor < freshExecutionPreview.minStakeMinor
      || amountMinor > freshExecutionPreview.maxStakeMinor
      || amountMinor > freshBalanceCny
      || (amountMinor - freshExecutionPreview.minStakeMinor) % freshExecutionPreview.stakeStepMinor !== 0) {
      throw new Error('crown-submit-fresh-preview-drift')
    }
    const freshPreview = { ...freshExecutionPreview, balanceMinor: freshBalanceCny }

    this._assertFence()
    const account = this.repository.getBettingAccountForExecution(ownerId)
    if (account?.id !== ownerId || account.currency !== 'CNY'
      || !Number.isSafeInteger(account.perBetLimitMinor)
      || amountMinor > account.perBetLimitMinor) throw new Error('crown-submit-account-contract')
    const origin = exactHttpsOrigin(account.loginUrl, 'crown-submit-origin-invalid')
    const store = this.loginManager.bettingStoreFor({ ...account, accountId: ownerId })
    const storedSession = store?.readSession?.({ ...account, accountId: ownerId })?.session
    const session = this.loginManager.verifiedBettingSessionFor?.({
      account: { ...account, accountId: ownerId },
      session: storedSession,
    })
    if (!session
      || session.accountId !== ownerId
      || session.username !== account.username
      || exactHttpsOrigin(session.baseUrl, 'crown-submit-session-origin') !== origin
      || !text(session.uid, 'crown-submit-session-owner')
      || !text(session.protocolVersion, 'crown-submit-session-version')
      || session.protocolVersionEvidence?.captured !== true
      || session.protocolVersionEvidence?.verified !== true
      || !['production-login-response', 'production-session-metadata'].includes(
        String(session.protocolVersionEvidence?.source || ''),
      )) throw new Error('crown-submit-session-owner')

    const wireFields = buildStrictCrownSubmitWireFields({
      lockedIdentity,
      currentIdentity,
      preview: freshPreview,
      amountMinor,
    }, {
      capability,
      protocolVersion: session.protocolVersion,
      protocolVersionEvidence: session.protocolVersionEvidence,
    })
    assertCrownCapabilityFieldSets(capability, { submitRequestFieldSet: Object.keys(wireFields) })

    this._assertFence()
    let callbackCount = 0
    const markNetworkStarted = () => {
      callbackCount += 1
      if (callbackCount !== 1) throw new Error('provider-network-started-twice')
      input.onNetworkStarted()
    }
    const cookies = { ...(session.cookies || {}) }
    safeLog(this.logger, 'crown-submit-request-start', {
      accountId: ownerId, childOrderId, capabilityEvidenceId: capability.evidenceId,
    })
    let response
    try {
      markNetworkStarted()
      response = await this.loginManager.client.postForm({
        baseUrl: origin,
        endpointPath: '/transform.php',
        form: { uid: session.uid, ...wireFields },
        cookies,
      })
    } catch (cause) {
      if (cause?.message === 'provider-network-started-twice') throw cause
      const error = new Error('crown-submit-request-failed')
      error.code = 'crown-submit-request-failed'
      throw error
    }
    this._assertFence()
    if (callbackCount !== 1) throw new Error('crown-submit-network-contract')

    const expected = {
      gid: wireFields.gid,
      gtype: wireFields.gtype,
      wtype: wireFields.wtype,
      rtype: wireFields.rtype,
      amount: wireFields.golds,
      odds: wireFields.ioratio,
    }
    const outcome = parseCrownSubmitResponseStrict(response?.text, {
      expected,
      expectedFieldSet: capability.submitResponseFieldSet,
      sealReference: (reference) => this.repository.sealCrownProviderReference(reference, {
        childOrderId, submitAttemptId,
      }),
    })
    this._assertFence()
    if (exactHttpsOrigin(session.baseUrl, 'crown-submit-session-origin') !== origin
      || session.accountId !== ownerId || session.username !== account.username) {
      throw new Error('crown-submit-session-owner')
    }
    store.saveSession({ ...account, accountId: ownerId }, {
      ...session,
      cookies: response?.cookies || cookies,
      savedAt: Date.now(),
    })
    safeLog(this.logger, 'crown-submit-result', {
      accountId: ownerId,
      childOrderId,
      capabilityEvidenceId: capability.evidenceId,
      status: outcome.kind,
    })
    return outcome.kind === 'accepted'
      ? outcome
      : { kind: 'unknown' }
  }
}

export default CrownAccountExecutionProvider
