import { createHash } from 'node:crypto'

import { parseJsonRejectDuplicateKeys } from '../betting-protocol/capture-redaction.mjs'
import { isCrownAcceptanceCapabilityAuthority } from './crown-browser-acceptance.mjs'

const REQUEST_FIELDS = Object.freeze([
  'LS', 'chk_cw', 'db_slow', 'format', 'langx', 'p', 'selGtype', 'ts', 'uid',
])
const REQUEST_FIELD_SET_FINGERPRINT = 'sha256:51b7c7559e3518183e358abecb8cb8a0a4faf0811e1cc83608243f42190ce374'
const EMPTY_RESPONSE_FIELDS = Object.freeze(['amout_gold', 'code', 'count', 'pay_type', 'ts', 'wagers'])
const NONEMPTY_RESPONSE_FIELDS = Object.freeze([...EMPTY_RESPONSE_FIELDS, 'allGidAry'].sort())
const WAGER_FIELDS = Object.freeze([
  'adddate', 'addtime', 'ball_act_class', 'ball_act_ret', 'ball_map', 'ballact',
  'bet_gtype', 'bet_showtype', 'bet_wtype', 'cancel_apn', 'cancel_line', 'code_value',
  'concede', 'delaysec', 'fore_result', 'gid', 'gidfl', 'gold', 'gtype', 'ioratio',
  'league', 'mainGid', 'odd_f', 'oddf_type', 'org_score', 'pname', 'ptype', 'ratio',
  'result', 'rtype', 'score', 'showtype', 'stop_time', 'strong', 'team_c_ratio',
  'team_c_show', 'team_h_ratio', 'team_h_show', 'team_id_c', 'team_id_h', 'type',
  'w_id', 'w_ms', 'win_gold', 'wtype',
].sort())
const EXPECTED_IDENTITY_FIELDS = Object.freeze([
  'bet_gtype', 'bet_wtype', 'concede', 'gid', 'gold', 'ioratio', 'type',
])
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/

function fail(code) {
  throw Object.assign(new Error(code), { code })
}

function sortedKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
}

function exactKeys(value, expected) {
  return JSON.stringify(sortedKeys(value)) === JSON.stringify(expected)
}

function digest(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`
}

function allNumbersFinite(value) {
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'number' && !Number.isFinite(current)) return false
    if (Array.isArray(current)) pending.push(...current)
    else if (current && typeof current === 'object') pending.push(...Object.values(current))
  }
  return true
}

function safePayload(response, transport, reasonCode, parsed = null) {
  const responseFields = sortedKeys(parsed)
  const firstWager = Array.isArray(parsed?.wagers) && parsed.wagers.length ? parsed.wagers[0] : null
  return {
    reasonCode,
    responseDigest: digest(response?.text),
    transportOperation: transport.operation === 'get_today_wagers' ? 'get_today_wagers' : 'drift',
    transportPath: transport.endpointPath === '/transform.php' ? '/transform.php' : 'drift',
    transportMethod: transport.method === 'POST' ? 'POST' : 'drift',
    transportStatus: Number.isSafeInteger(transport.status) ? transport.status : 0,
    requestFieldSetFingerprint: DIGEST_RE.test(String(transport.requestFieldSetFingerprint || ''))
      ? transport.requestFieldSetFingerprint : '',
    responseFieldSetFingerprint: responseFields.length ? digest(JSON.stringify(responseFields)) : '',
    wagerFieldSetFingerprint: firstWager ? digest(JSON.stringify(sortedKeys(firstWager))) : '',
  }
}

function unknownResult(matchCount, payload) {
  return {
    decision: 'unknown',
    matchStrength: matchCount > 1 ? 'multiple' : 'none',
    matchCount,
    providerReferenceCiphertext: '',
    payload,
  }
}

function pendingResult(payload) {
  return {
    decision: 'pending',
    matchStrength: 'none',
    matchCount: 0,
    providerReferenceCiphertext: '',
    payload,
  }
}

function exactTransport(transport) {
  const fields = Array.isArray(transport?.requestFieldSet) ? [...transport.requestFieldSet].sort() : []
  return transport?.operation === 'get_today_wagers'
    && transport?.endpointPath === '/transform.php'
    && transport?.method === 'POST'
    && transport?.status === 200
    && JSON.stringify(fields) === JSON.stringify(REQUEST_FIELDS)
    && transport.requestFieldSetFingerprint === REQUEST_FIELD_SET_FINGERPRINT
    && DIGEST_RE.test(String(transport.requestTimestampDigest || ''))
}

function exactWagerShape(record) {
  if (!exactKeys(record, WAGER_FIELDS) || typeof record.gidfl !== 'number' || !Number.isFinite(record.gidfl)) return false
  return WAGER_FIELDS.every((field) => field === 'gidfl' || typeof record[field] === 'string')
    && /^[A-Z]{2}\d{11}$/.test(record.w_id)
    && record.mainGid === record.gid
}

function exactResponseShape(payload, transport) {
  if (!allNumbersFinite(payload)
    || typeof payload?.amout_gold !== 'string'
    || typeof payload?.code !== 'string'
    || !Number.isSafeInteger(payload?.count) || payload.count < 0
    || typeof payload?.pay_type !== 'number' || !Number.isFinite(payload.pay_type)
    || typeof payload?.ts !== 'string' || !/^\d{13}$/.test(payload.ts)
    || digest(payload.ts) !== transport.requestTimestampDigest
    || !Array.isArray(payload?.wagers)
    || payload.count !== payload.wagers.length) return false
  if (payload.count === 0) return exactKeys(payload, EMPTY_RESPONSE_FIELDS)
  if (!exactKeys(payload, NONEMPTY_RESPONSE_FIELDS)
    || !payload.allGidAry || typeof payload.allGidAry !== 'object' || Array.isArray(payload.allGidAry)
    || !Array.isArray(payload.allGidAry.FT)
    || !payload.allGidAry.FT.every((value) => typeof value === 'string')
    || !payload.wagers.every(exactWagerShape)) return false
  return payload.wagers.every((record) => payload.allGidAry.FT.includes(record.gid))
}

function exactExpectedIdentity(identity) {
  return exactKeys(identity, EXPECTED_IDENTITY_FIELDS)
    && EXPECTED_IDENTITY_FIELDS.every((field) => typeof identity[field] === 'string')
    && identity.bet_gtype === 'FT'
}

function identityMatches(record, identity) {
  return EXPECTED_IDENTITY_FIELDS.every((field) => {
    if (field !== 'ioratio') return record[field] === identity[field]
    const canonical = (value) => {
      const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value || ''))
      if (!match) return null
      const fraction = (match[2] || '').replace(/0+$/, '')
      return `${match[1]}${fraction ? `.${fraction}` : ''}`
    }
    return canonical(record[field]) !== null && canonical(record[field]) === canonical(identity[field])
  })
}

export class CrownAccountReconciliationProvider {
  constructor({ repository, browserRuntime, reconcilerLease, acceptanceAuthority = null } = {}) {
    if (!repository || typeof repository !== 'object') fail('crown-reconciliation-repository-required')
    if (!browserRuntime || typeof browserRuntime.queryResultForm !== 'function') {
      fail('crown-reconciliation-browser-runtime-required')
    }
    if (!reconcilerLease || typeof reconcilerLease.assertFence !== 'function') {
      fail('crown-reconciliation-lease-required')
    }
    if (acceptanceAuthority !== null && !isCrownAcceptanceCapabilityAuthority(acceptanceAuthority)) {
      fail('crown-acceptance-authority')
    }
    this.repository = repository
    this.browserRuntime = browserRuntime
    this.reconcilerLease = reconcilerLease
    this.acceptanceAuthority = acceptanceAuthority
  }

  _assertFence() {
    const token = this.reconcilerLease.fencingToken
    if (!Number.isSafeInteger(token) || token < 1 || this.reconcilerLease.assertFence(token) !== token) {
      fail('crown-reconciliation-fence')
    }
  }

  async queryResult(input = {}) {
    if (!this.acceptanceAuthority) fail('crown-reconciliation-capability-unverified')
    this._assertFence()
    const binding = this.acceptanceAuthority.resolveReconciliation({ submitAttemptId: input.submitAttemptId })
    if (typeof this.repository.getBettingAccountForExecution !== 'function') {
      fail('crown-reconciliation-repository-required')
    }
    const account = this.repository.getBettingAccountForExecution(binding.accountId)
    if (!account || account.id !== binding.accountId) fail('crown-reconciliation-account-binding')
    if (typeof this.browserRuntime.ensureBettingSession !== 'function') {
      fail('crown-reconciliation-browser-runtime-required')
    }
    const session = await this.browserRuntime.ensureBettingSession({
      account,
      assertFence: () => this._assertFence(),
      signal: input.signal,
    })
    if (session?.accountId !== account.id || session?.username !== account.username
      || session?.baseUrl !== account.loginUrl) fail('crown-reconciliation-session-binding')
    this._assertFence()
    const response = await this.browserRuntime.queryResultForm({
      account,
      session,
      assertFence: () => this._assertFence(),
      signal: input.signal,
    })
    this._assertFence()
    const transport = response?.transport || {}
    if (!exactTransport(transport)) {
      return unknownResult(0, safePayload(response, transport, 'result-transport-drift'))
    }
    let payload
    try { payload = parseJsonRejectDuplicateKeys(String(response?.text || '')) } catch {
      return unknownResult(0, safePayload(response, transport, 'result-schema-drift'))
    }
    if (!exactResponseShape(payload, transport)) {
      return unknownResult(0, safePayload(response, transport, 'result-schema-drift', payload))
    }
    const hasBoundReference = Boolean(binding.sealedProviderReference)
    const matches = payload.wagers.filter((record) => hasBoundReference
      ? this.acceptanceAuthority.matchesReconciliationReference(
        record.w_id.slice(2), { submitAttemptId: input.submitAttemptId },
      )
      : identityMatches(record, binding.expectedResultIdentity))
    if (matches.length === 0) {
      return pendingResult(safePayload(response, transport, 'result-pending', payload))
    }
    if (matches.length > 1) {
      return unknownResult(matches.length, safePayload(response, transport, 'result-reference-multiple', payload))
    }
    if (!exactExpectedIdentity(binding.expectedResultIdentity)
      || !identityMatches(matches[0], binding.expectedResultIdentity)) {
      return unknownResult(1, safePayload(response, transport, 'result-identity-drift', payload))
    }
    const providerReferenceCiphertext = hasBoundReference
      ? binding.sealedProviderReference
      : this.repository.sealCrownProviderReference?.(matches[0].w_id.slice(2), {
        childOrderId: binding.childOrderId,
        submitAttemptId: binding.submitAttemptId,
      })
    if (typeof providerReferenceCiphertext !== 'string' || !providerReferenceCiphertext) {
      return unknownResult(1, safePayload(response, transport, 'result-reference-seal-failed', payload))
    }
    return {
      decision: 'accepted',
      matchStrength: 'strong',
      matchCount: 1,
      providerReferenceCiphertext,
      payload: safePayload(response, transport, 'result-accepted', payload),
    }
  }

  async getDangerous(input = {}) {
    if (!this.acceptanceAuthority) fail('crown-reconciliation-capability-unverified')
    this._assertFence()
    this.acceptanceAuthority.resolveReconciliation({ submitAttemptId: input.submitAttemptId })
    return {
      decision: 'no_match', matchStrength: 'none', matchCount: 0,
      providerReferenceCiphertext: '', payload: { source: 'acceptance-disabled-dangerous-source' },
    }
  }

  getTodayWagers(input) {
    return this.queryResult(input)
  }
}

export default CrownAccountReconciliationProvider
