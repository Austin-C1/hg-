import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  getCrownCapability,
} from './crown-capability-matrix.mjs'
import { isCrownAcceptanceCapabilityAuthority } from './crown-browser-acceptance.mjs'
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

function assertBrowserRuntime(value) {
  if (!value
    || typeof value.verifiedBettingSessionFor !== 'function'
    || typeof value.postSubmitForm !== 'function') {
    throw new TypeError('crown-submit-browser-runtime')
  }
  return value
}

function safeMinor(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(code)
  return value
}

function assertFreshMoney(preview, amountMinor) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.currency !== 'CNY' || preview.amountScale !== 0) {
    throw new Error('crown-submit-fresh-preview-drift')
  }
  const minimum = safeMinor(preview.minStakeMinor, 'crown-submit-fresh-preview-drift', { positive: true })
  const maximum = safeMinor(preview.maxStakeMinor, 'crown-submit-fresh-preview-drift', { positive: true })
  const balance = safeMinor(preview.balanceMinor, 'crown-submit-fresh-preview-drift')
  if (minimum > maximum || amountMinor < minimum || amountMinor > maximum || amountMinor > balance) {
    throw new Error('crown-submit-fresh-preview-drift')
  }
  if (amountMinor === minimum) return
  const step = preview.stakeStepMinor
  if (!Number.isSafeInteger(step) || step < 1
    || !['provider-preview-response', 'verified-account-policy'].includes(preview.stakeStepProvenance)
    || (amountMinor - minimum) % step !== 0) {
    throw new Error('crown-submit-fresh-preview-drift')
  }
}

export class CrownAccountExecutionProvider {
  constructor({ repository, browserRuntime, executorLease, logger = null, acceptanceAuthority = null } = {}) {
    if (typeof repository?.getBettingAccountForExecution !== 'function'
      || typeof repository?.getCurrentCrownSelectionForExecution !== 'function'
      || typeof repository?.sealCrownProviderReference !== 'function') {
      throw new TypeError('crown-submit-account-repository')
    }
    this.repository = repository
    this.browserRuntime = assertBrowserRuntime(browserRuntime)
    this.executorLease = assertLease(executorLease)
    if (acceptanceAuthority !== null && !isCrownAcceptanceCapabilityAuthority(acceptanceAuthority)) {
      throw new TypeError('crown-acceptance-authority')
    }
    this.acceptanceAuthority = acceptanceAuthority
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
    const capabilityInput = {
      mode: lockedIdentity.mode,
      period: lockedIdentity.period,
      marketType: lockedIdentity.market,
      lineVariant: lockedIdentity.lineVariant,
      selectionSide: lockedIdentity.side,
    }
    if (input.acceptanceClaim && !this.acceptanceAuthority) throw new Error('crown-acceptance-authority-required')
    const capability = input.acceptanceClaim
      ? this.acceptanceAuthority.resolveCapability({
          operation: 'submit', direction: capabilityInput, candidateClaim: input.acceptanceClaim,
        })
      : assertCrownCapability(getCrownCapability(capabilityInput), { operation: 'submit' })
    if (text(input.capabilityEvidenceId, 'crown-capability-evidence-required') !== capability.evidenceId) {
      throw new Error('crown-capability-evidence-mismatch')
    }
    const ownerId = accountId(input.accountId)
    const childOrderId = text(input.childOrderId, 'child-order-id-required')
    const submitAttemptId = text(input.submitAttemptId, 'submit-attempt-id-required')
    const amountMinor = input.amountMinor
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1
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

    const preparedPreview = input.preview
    if (!same(preparedPreview?.lockedIdentity, currentIdentity)
      || preparedPreview?.line !== lockedIdentity.line
      || decimal(preparedPreview?.odds, 'crown-submit-fresh-preview-drift') !== preparedOdds
      || !/^[-]?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(preparedPreview?.submitCon || ''))
      || !/^[-]?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(preparedPreview?.submitRatio || ''))) {
      throw new Error('crown-submit-fresh-preview-drift')
    }
    assertFreshMoney(preparedPreview, amountMinor)

    this._assertFence()
    const account = this.repository.getBettingAccountForExecution(ownerId)
    if (account?.id !== ownerId || account.currency !== 'CNY'
      || !Number.isSafeInteger(account.perBetLimitMinor)
      || amountMinor > account.perBetLimitMinor) throw new Error('crown-submit-account-contract')
    const origin = exactHttpsOrigin(account.loginUrl, 'crown-submit-origin-invalid')
    const session = this.browserRuntime.verifiedBettingSessionFor({
      account,
      session: input.browserSession,
    })
    if (!session || session !== input.browserSession
      || session.accountId !== ownerId
      || session.username !== account.username
      || !text(session.contextGeneration, 'crown-submit-session-generation')
      || exactHttpsOrigin(session.baseUrl, 'crown-submit-session-origin') !== origin
      || !text(session.uid, 'crown-submit-session-owner')
      || !text(session.protocolVersion, 'crown-submit-session-version')
      || session.protocolVersionEvidence?.captured !== true
      || session.protocolVersionEvidence?.verified !== true
      || !['production-login-response', 'production-session-metadata']
        .includes(session.protocolVersionEvidence?.source)
      || Object.hasOwn(session, 'cookies')) throw new Error('crown-submit-session-owner')

    const wireFields = buildStrictCrownSubmitWireFields({
      lockedIdentity,
      currentIdentity,
      preview: preparedPreview,
      amountMinor,
    }, {
      capability,
      protocolVersion: session.protocolVersion,
      protocolVersionEvidence: session.protocolVersionEvidence,
    })
    assertCrownCapabilityFieldSets(getCrownCapability(capabilityInput), {
      submitRequestFieldSet: Object.keys(wireFields),
    })

    this._assertFence()
    safeLog(this.logger, 'crown-submit-request-start', {
      accountId: ownerId, childOrderId, capabilityEvidenceId: capability.evidenceId,
      transportKind: 'browser-page-fetch',
    })
    let response
    try {
      response = await this.browserRuntime.postSubmitForm({
        account,
        session,
        wireFields,
        assertFence: () => this._assertFence(),
        signal: input.signal,
        beforeDispatch: input.onNetworkStarted,
      })
    } catch (cause) {
      const error = new Error('crown-submit-request-failed')
      error.code = 'crown-submit-request-failed'
      throw error
    }
    this._assertFence()
    if (response?.transport?.operation !== capability.endpoints.submit.functionName
      || response?.transport?.endpointPath !== capability.endpoints.submit.path) {
      throw new Error('crown-submit-transport-invalid')
    }

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
    safeLog(this.logger, 'crown-submit-result', {
      accountId: ownerId,
      childOrderId,
      capabilityEvidenceId: capability.evidenceId,
      status: outcome.kind,
      transportKind: 'browser-page-fetch',
    })
    return outcome.kind === 'accepted'
      ? { ...outcome, transportKind: 'browser-page-fetch' }
      : { kind: 'unknown', transportKind: 'browser-page-fetch' }
  }
}

export default CrownAccountExecutionProvider
