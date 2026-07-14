import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MATRIX_VERSION_PREFIX = 'crown-protocol-capabilities-v2'
const DEFAULT_FIXTURES_ROOT = fileURLToPath(new URL('../../../data/fixtures/crown/betting-protocol/', import.meta.url))
const PROHIBITED_FIXTURE_TEXT = /\b(?:cookie|uid|token|ticket|password|authorization)\b/i
const ABSOLUTE_FIXTURE_PATH = /[A-Za-z]:\\|\/(?:Users|home|tmp)\//i
const EVIDENCE_DIGEST = /^(?:sha256|hmac-sha256):[a-f0-9]{64}$/
const REJECTION_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EXECUTION_CAPABILITY_FIELDS = Object.freeze(['mode', 'period', 'marketType', 'lineVariant'])
const EXECUTION_RECORD_BINDING_FIELDS = Object.freeze([
  'sequence', 'capturedAt', 'captureId', 'accountBinding', 'sessionBinding', 'executionIdentityDigest',
  'operation', 'truncated', 'inferredFromLaterState', 'stakeLimits', 'stake', 'outcome', 'orderCreated',
  'persistentOrderIdDigest', 'rejectionCode',
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stable(value))
}

export function fingerprintCrownProtocolArtifact(artifact = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new TypeError('crown-protocol-artifact')
  }
  const { artifactSafeDigest: _embeddedDigest, ...content } = artifact
  return `sha256:${sha256(stableJson(content))}`
}

function canonicalFieldSet(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw new TypeError('crown-capability-field-set')
  const normalized = fields.map((field) => String(field || '').trim())
  if (normalized.some((field) => !field)) throw new TypeError('crown-capability-field-set')
  return [...new Set(normalized)].sort()
}

export function fingerprintCrownFieldSet(fields) {
  return `sha256:${sha256(JSON.stringify(canonicalFieldSet(fields)))}`
}

function executionEvidenceResult(errors) {
  const uniqueErrors = Object.freeze([...new Set(errors)])
  const evidenceIncomplete = uniqueErrors.length > 0
  return Object.freeze({
    status: evidenceIncomplete ? 'evidenceIncomplete' : 'structureComplete',
    evidenceIncomplete,
    previewEvidenceComplete: !evidenceIncomplete,
    submitEvidenceComplete: !evidenceIncomplete,
    errors: uniqueErrors,
  })
}

function evidenceObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validEvidenceDigest(value) {
  return typeof value === 'string' && EVIDENCE_DIGEST.test(value)
}

function validEvidenceSource(source, stage) {
  return evidenceObject(source)
    && source.stage === stage
    && typeof source.field === 'string'
    && source.field.trim().length > 0
}

function executionEvidenceCapability(value, { exact = false } = {}) {
  if (!evidenceObject(value)) return null
  if (exact && !same(Object.keys(value).sort(), [...EXECUTION_CAPABILITY_FIELDS].sort())) return null
  const result = Object.fromEntries(EXECUTION_CAPABILITY_FIELDS.map((field) => [field, String(value[field] || '').trim()]))
  return Object.values(result).every(Boolean) ? result : null
}

function executionEvidenceRecordEntries(evidence = {}) {
  return (Array.isArray(evidence?.attempts) ? evidence.attempts : []).flatMap((attempt) => [
    { evidence: attempt?.preview?.request, stage: 'preview', recordType: 'request' },
    { evidence: attempt?.preview?.response, stage: 'preview', recordType: 'response' },
    { evidence: attempt?.submit?.request, stage: 'submit', recordType: 'request' },
    { evidence: attempt?.submit?.response, stage: 'submit', recordType: 'response' },
  ])
}

function executionRecordBinding(record = {}) {
  return Object.fromEntries(EXECUTION_RECORD_BINDING_FIELDS.map((field) => [field, record?.[field]]))
}

function validateExecutionMoney(attempt, errors) {
  const money = attempt?.money
  if (!evidenceObject(money)) {
    errors.push('money-required')
    return
  }
  if (money.currency !== 'CNY') errors.push('cny-money-required')
  const integerFields = ['amountMinor', 'serverMinMinor', 'serverMaxMinor', 'localStakeQuantumMinor']
  const integerMoney = integerFields.every((field) => Number.isSafeInteger(money[field]) && money[field] > 0)
  if (!integerMoney) {
    errors.push('integer-money-required')
  } else {
    if (money.serverMinMinor > money.serverMaxMinor
      || money.amountMinor < money.serverMinMinor
      || money.amountMinor > money.serverMaxMinor) {
      errors.push('money-range')
    }
    if (money.localStakeQuantumProvenance !== 'local-conservative-policy'
      || money.localStakeQuantumMinor !== 50
      || money.amountMinor < 50
      || (money.amountMinor - 50) % money.localStakeQuantumMinor !== 0) errors.push('money-step')
  }

  if (!same(attempt?.preview?.response?.stakeLimits, {
    minMinor: money.serverMinMinor,
    maxMinor: money.serverMaxMinor,
  }) || !same(attempt?.submit?.request?.stake, {
    currency: money.currency,
    amountMinor: money.amountMinor,
  })) errors.push('money-drift')

  const sourceStages = {
    currency: 'account-summary',
    amountMinor: 'submit-request',
    serverMinMinor: 'preview-response',
    serverMaxMinor: 'preview-response',
    localStakeQuantumMinor: 'local-policy',
  }
  if (Object.entries(sourceStages).some(([field, stage]) => !validEvidenceSource(money.sources?.[field], stage))) {
    errors.push('money-source-required')
  }
}

export function validateCrownExecutionEvidence(evidence = {}, { expectedCapability } = {}) {
  const errors = []
  const capability = executionEvidenceCapability(evidence?.capability, { exact: true })
  const expected = expectedCapability === undefined
    ? capability
    : executionEvidenceCapability(expectedCapability)
  if (!capability) errors.push('capability-required')
  if (expectedCapability !== undefined && !expected) errors.push('expected-capability-required')
  if (capability && expected && !same(capability, expected)) errors.push('capability-mismatch')

  const capture = evidence?.capture
  if (!evidenceObject(capture)) {
    errors.push('capture-required')
  } else {
    if (capture.source !== 'production-capture') errors.push('production-capture-required')
    if (capture.synthetic !== false) errors.push('synthetic-evidence')
    if (capture.truncated !== false) errors.push('capture-truncated')
    if (capture.inferredFromLaterState !== false) errors.push('later-state-inference')
    if (typeof capture.id !== 'string' || !capture.id.trim()) errors.push('capture-binding-required')
    if (!validEvidenceDigest(capture.accountBinding)) errors.push('account-binding-required')
    if (!validEvidenceDigest(capture.sessionBinding)) errors.push('session-binding-required')
  }

  const attempts = Array.isArray(evidence?.attempts) ? evidence.attempts : []
  if (attempts.length === 0) errors.push('attempts-required')
  const timeline = []
  const recordEvidenceIds = new Set()
  for (const attempt of attempts) {
    const records = [
      attempt?.preview?.request,
      attempt?.preview?.response,
      attempt?.submit?.request,
      attempt?.submit?.response,
    ]
    if (records.some((record) => !evidenceObject(record))) {
      errors.push('preview-submit-records-required')
      continue
    }

    const attemptCapability = executionEvidenceCapability(attempt?.capability, { exact: true })
    if (!attemptCapability || !capability || !same(attemptCapability, capability)) errors.push('capability-drift')

    if (attempt.preview.request.operation !== 'FT_order_view' || attempt.preview.response.operation !== 'FT_order_view') {
      errors.push('preview-operation')
    }
    if (attempt.submit.request.operation !== 'FT_bet' || attempt.submit.response.operation !== 'FT_bet') {
      errors.push('submit-operation')
    }
    if (attempt.preview.response.truncated !== false || attempt.submit.response.truncated !== false) {
      errors.push('response-truncated')
    }
    if (attempt.preview.response.inferredFromLaterState !== false
      || attempt.submit.response.inferredFromLaterState !== false) {
      errors.push('response-inferred-from-later-state')
    }

    const identity = attempt.executionIdentityDigest
    if (!validEvidenceDigest(identity)) {
      errors.push('execution-identity-required')
    }
    for (const record of records) {
      if (!validEvidenceDigest(record.recordEvidenceId)) {
        errors.push('record-provenance-required')
      } else if (recordEvidenceIds.has(record.recordEvidenceId)) {
        errors.push('duplicate-record-provenance')
      } else {
        recordEvidenceIds.add(record.recordEvidenceId)
      }
      if (record.captureId !== capture?.id) errors.push('capture-binding-drift')
      if (record.accountBinding !== capture?.accountBinding) errors.push('account-binding-drift')
      if (record.sessionBinding !== capture?.sessionBinding) errors.push('session-binding-drift')
      if (record.executionIdentityDigest !== identity || !validEvidenceDigest(record.executionIdentityDigest)) {
        errors.push('execution-identity-drift')
      }
      timeline.push(record)
    }

    validateExecutionMoney(attempt, errors)
    const outcome = attempt.outcome
    const response = attempt.submit.response
    if (!['accepted', 'rejected'].includes(outcome) || response.outcome !== outcome) {
      errors.push('explicit-submit-outcome-required')
    } else if (outcome === 'accepted') {
      if (response.orderCreated !== true || !validEvidenceDigest(response.persistentOrderIdDigest)) {
        errors.push('accepted-order-id-required')
      }
    } else if (response.orderCreated !== false
      || typeof response.rejectionCode !== 'string'
      || !REJECTION_CODE.test(response.rejectionCode)
      || response.persistentOrderIdDigest !== undefined) {
      errors.push('explicit-rejection-required')
    }
  }

  let previousSequence = null
  let previousTime = null
  for (const record of timeline) {
    const capturedAt = typeof record.capturedAt === 'string' ? Date.parse(record.capturedAt) : Number.NaN
    if (!Number.isSafeInteger(record.sequence)
      || record.sequence < 1
      || !Number.isFinite(capturedAt)
      || (previousSequence !== null && record.sequence <= previousSequence)
      || (previousTime !== null && capturedAt < previousTime)) {
      errors.push('timeline-order')
    }
    previousSequence = record.sequence
    previousTime = capturedAt
  }
  if (!attempts.some((attempt) => attempt?.outcome === 'accepted')) errors.push('accepted-evidence-required')
  return executionEvidenceResult(errors)
}

export function capabilityKey(input = {}) {
  return [input.mode, input.period, input.marketType, input.lineVariant]
    .map((value) => String(value || '').trim())
    .join('|')
}

const REQUEST_FIELD_SET = Object.freeze(['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'])
const RESPONSE_FIELD_SET = Object.freeze(['code', 'con', 'dates', 'game_sc', 'game_so', 'gold_gmax', 'gold_gmin', 'ioratio', 'league_id', 'maxcredit', 'mem_sc', 'mem_so', 'num_c', 'num_h', 'ratio', 'restsinglecredit', 'spread', 'strong', 'times'])
const REQUEST_FIELD_SET_FINGERPRINT = fingerprintCrownFieldSet(REQUEST_FIELD_SET)
const RESPONSE_FIELD_SET_FINGERPRINT = fingerprintCrownFieldSet(RESPONSE_FIELD_SET)
const ACCEPTED_PREVIEW_RESPONSE_FIELD_SET = Object.freeze([
  'aid', 'code', 'con', 'currency', 'currency_value', 'dates', 'dg', 'fast_check',
  'game_sc', 'game_so', 'gold_gmax', 'gold_gmin', 'important', 'ioratio', 'league_id',
  'league_name', 'ltype', 'max_gold', 'maxcredit', 'mem_sc', 'mem_so', 'ms', 'num_c',
  'num_h', 'pay_type', 'ptype', 'ratio', 'restsinglecredit', 'spread', 'strong', 'systime',
  'team_id_c', 'team_id_h', 'team_name_c', 'team_name_h', 'times', 'ts',
])
const ACCEPTED_SUBMIT_REQUEST_FIELD_SET = Object.freeze([
  'autoOdd', 'chose_team', 'con', 'f', 'gid', 'golds', 'gtype', 'imp', 'ioratio',
  'isRB', 'isYesterday', 'langx', 'odd_f_type', 'p', 'ptype', 'ratio', 'rtype',
  'timestamp', 'timestamp2', 'ver', 'wtype',
])
const ACCEPTED_SUBMIT_RESPONSE_FIELD_SET = Object.freeze([
  'ball_act', 'code', 'concede', 'date', 'dg_mode', 'gid', 'gold', 'gtype', 'imp',
  'ioratio', 'isyesterday', 'league', 'league_id', 'maxcredit', 'ms', 'mtype',
  'nowcredit', 'ptype', 'ratio', 'rtype', 'spread', 'strong', 'systime', 'team_c',
  'team_h', 'team_id_c', 'team_id_h', 'time', 'timestamp', 'type', 'wtype',
])

const ROWS = [
  {
    mode: 'live',
    period: 'first_half',
    marketType: 'total',
    lineVariant: 'main',
    evidenceStatus: 'verified',
    previewAllowed: false,
    submitAllowed: false,
    reconciliationAllowed: false,
    blockedReason: 'crown-preview-field-source-unproven',
    submitBlockedReason: 'crown-submit-evidence-missing',
    evidenceId: 'crown-capture-20260709-112647-live-first-half-total-main',
    fixturePath: 'live-first-half-total-main.verified.json',
    fixtureSha256: 'a643b692d94c5049dbc2353a6a293eaafdb7d0c8ad4fe49b239eb7a355573984',
    artifactPath: 'artifacts/20260709-112647-preview.safe.json',
    artifactSafeDigest: 'sha256:4235cbd8970636b6c7d5b114c23ad42273bf77347b7077fb5bef465c86ae9cb3',
    requestRecordEvidenceId: 'sha256:7cc4d5e89750ac9ed3a111008560354f37f3a1b0ed3fb7eb0ec51b67c2588726',
    responseRecordEvidenceId: 'sha256:e315f1335d3e6d5cb15ea1e2c70e9cefbfbe4b68ea592acbddcc79e3945d2ca3',
    mapperEvidence: {
      ratioFields: ['RATIO_HROUO', 'RATIO_HROUU'],
      oddsFields: ['IOR_HROUC', 'IOR_HROUH'],
      oddsFieldsBySide: { over: 'IOR_HROUC', under: 'IOR_HROUH' },
      periodMarker: '1R',
      wtype: 'ROU',
      wireDefaults: { langx: 'zh-cn', odd_f_type: 'H', p: 'FT_order_view' },
      unprovenWireValueSources: ['ver'],
    },
    requestFieldSet: REQUEST_FIELD_SET,
    requestFieldSetFingerprint: REQUEST_FIELD_SET_FINGERPRINT,
    responseFieldSet: RESPONSE_FIELD_SET,
    responseFieldSetFingerprint: RESPONSE_FIELD_SET_FINGERPRINT,
  },
  {
    mode: 'live',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    evidenceStatus: 'verified',
    previewAllowed: false,
    submitAllowed: false,
    reconciliationAllowed: false,
    blockedReason: 'crown-preview-field-source-unproven',
    submitBlockedReason: 'crown-submit-evidence-missing',
    evidenceId: 'crown-capture-20260709-111046-live-full-time-asian-handicap-main',
    fixturePath: 'live-full-time-asian-handicap-main.verified.json',
    fixtureSha256: '9b9786f0f1db01368ff7ec72effb68996ca4adbf4cc92ef752d89e4d3d206896',
    artifactPath: 'artifacts/20260709-111046-preview.safe.json',
    artifactSafeDigest: 'sha256:adb8605b51f52532b75aed83e7e6e9c74b73df875241db9cd684f19d6ed6ee8f',
    requestRecordEvidenceId: 'sha256:7cc4d5e89750ac9ed3a111008560354f37f3a1b0ed3fb7eb0ec51b67c2588726',
    responseRecordEvidenceId: 'sha256:e315f1335d3e6d5cb15ea1e2c70e9cefbfbe4b68ea592acbddcc79e3945d2ca3',
    mapperEvidence: {
      ratioFields: ['RATIO_RE'],
      oddsFields: ['IOR_REC', 'IOR_REH'],
      oddsFieldsBySide: { away: 'IOR_REC', home: 'IOR_REH' },
      wtype: 'RE',
      wireDefaults: { langx: 'zh-cn', odd_f_type: 'H', p: 'FT_order_view' },
      unprovenWireValueSources: ['ver'],
    },
    requestFieldSet: REQUEST_FIELD_SET,
    requestFieldSetFingerprint: REQUEST_FIELD_SET_FINGERPRINT,
    responseFieldSet: RESPONSE_FIELD_SET,
    responseFieldSetFingerprint: RESPONSE_FIELD_SET_FINGERPRINT,
  },
  {
    mode: 'prematch',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    evidenceStatus: 'verified',
    previewAllowed: true,
    submitAllowed: true,
    reconciliationAllowed: false,
    blockedReason: '',
    submitBlockedReason: '',
    evidenceId: 'crown-capture-20260714-085221-prematch-full-time-asian-handicap-main-accepted',
    executionEvidenceSchema: 'crown-execution-evidence-candidate-v3',
    fixturePath: 'prematch-full-time-asian-handicap-main.accepted.json',
    fixtureSha256: '1c3743ffb56f69a7831ead579703cc369224d8da57f9c910d28b4f40f95d0c63',
    artifactPath: 'artifacts/20260714-085221-accepted.safe.json',
    artifactSafeDigest: 'sha256:eff5e36b4eee4dc422c37a5001aba9cf1d9a1508352d8cbf4bdc33786bb1495f',
    watcherEvidencePath: 'artifacts/20260714-085221-watcher.safe.json',
    watcherEvidenceDigest: 'sha256:25f70de00c9d9cfbc57aa28edc14ab7d1e67953e20e59f3f3697eb12f212ac68',
    requestRecordEvidenceId: 'hmac-sha256:cf82c7ee24ac1243e7f3fcd1e9ef2ae17305c2223220810714f95e231decdca2',
    responseRecordEvidenceId: 'hmac-sha256:d94a1ef61f3174a3f0f4ee64707ed9ac634b6eaf491b4e36675cc7c9fa15465e',
    submitRequestRecordEvidenceId: 'hmac-sha256:1c056229f662268cc816ac1f98602c6628ae03e576da8f7f85285b91d0ac2644',
    submitResponseRecordEvidenceId: 'hmac-sha256:bc36fdba80ffa3dcbd71e2a3e962efa55e4157d25d7ff15f76f6d6fcc778564e',
    mapperEvidence: {
      ratioFields: ['RATIO_R'],
      oddsFields: ['IOR_RC', 'IOR_RH'],
      oddsFieldsBySide: { away: 'IOR_RC', home: 'IOR_RH' },
      wtype: 'R',
      wireDefaults: { langx: 'zh-cn', odd_f_type: 'H', p: 'FT_order_view' },
      submitWireDefaults: {
        autoOdd: 'Y', f: '1R', imp: 'N', isRB: 'N', isYesterday: 'N',
        langx: 'zh-cn', odd_f_type: 'H', p: 'FT_bet', ptype: '', timestamp2: '',
      },
      submitWireSources: {
        con: 'preview-response:con', ratio: 'preview-response:ratio', timestamp: 'request-epoch-ms',
      },
      unprovenWireValueSources: [],
    },
    requestFieldSet: REQUEST_FIELD_SET,
    requestFieldSetFingerprint: REQUEST_FIELD_SET_FINGERPRINT,
    responseFieldSet: ACCEPTED_PREVIEW_RESPONSE_FIELD_SET,
    responseFieldSetFingerprint: fingerprintCrownFieldSet(ACCEPTED_PREVIEW_RESPONSE_FIELD_SET),
    submitRequestFieldSet: ACCEPTED_SUBMIT_REQUEST_FIELD_SET,
    submitRequestFieldSetFingerprint: fingerprintCrownFieldSet(ACCEPTED_SUBMIT_REQUEST_FIELD_SET),
    submitResponseFieldSet: ACCEPTED_SUBMIT_RESPONSE_FIELD_SET,
    submitResponseFieldSetFingerprint: fingerprintCrownFieldSet(ACCEPTED_SUBMIT_RESPONSE_FIELD_SET),
  },
].map((row) => Object.freeze({ ...row, key: capabilityKey(row) }))

export function computeCrownCapabilityMatrixVersion(rows = ROWS) {
  const content = rows.map((row) => ({
    key: capabilityKey(row),
    evidenceStatus: row.evidenceStatus,
    previewAllowed: row.previewAllowed,
    submitAllowed: row.submitAllowed,
    reconciliationAllowed: row.reconciliationAllowed,
    blockedReason: row.blockedReason,
    submitBlockedReason: row.submitBlockedReason,
    evidenceId: row.evidenceId,
    executionEvidenceSchema: row.executionEvidenceSchema,
    fixturePath: row.fixturePath,
    fixtureSha256: row.fixtureSha256,
    artifactPath: row.artifactPath,
    artifactSafeDigest: row.artifactSafeDigest,
    watcherEvidencePath: row.watcherEvidencePath,
    watcherEvidenceDigest: row.watcherEvidenceDigest,
    requestRecordEvidenceId: row.requestRecordEvidenceId,
    responseRecordEvidenceId: row.responseRecordEvidenceId,
    submitRequestRecordEvidenceId: row.submitRequestRecordEvidenceId,
    submitResponseRecordEvidenceId: row.submitResponseRecordEvidenceId,
    mapperEvidence: row.mapperEvidence,
    requestFieldSet: canonicalFieldSet(row.requestFieldSet),
    requestFieldSetFingerprint: row.requestFieldSetFingerprint,
    responseFieldSet: canonicalFieldSet(row.responseFieldSet),
    responseFieldSetFingerprint: row.responseFieldSetFingerprint,
    submitRequestFieldSet: row.submitRequestFieldSet ? canonicalFieldSet(row.submitRequestFieldSet) : undefined,
    submitRequestFieldSetFingerprint: row.submitRequestFieldSetFingerprint,
    submitResponseFieldSet: row.submitResponseFieldSet ? canonicalFieldSet(row.submitResponseFieldSet) : undefined,
    submitResponseFieldSetFingerprint: row.submitResponseFieldSetFingerprint,
  })).sort((left, right) => left.key < right.key ? -1 : (left.key > right.key ? 1 : 0))
  return `${MATRIX_VERSION_PREFIX}:${sha256(stableJson(content)).slice(0, 16)}`
}

export const CROWN_CAPABILITY_MATRIX_VERSION = computeCrownCapabilityMatrixVersion(ROWS)

function clone(value) {
  return structuredClone(value)
}

let canonicalRuntimeVerification = null

function assertCanonicalRuntimeAuthority() {
  if (!ROWS.some((row) => row.previewAllowed || row.submitAllowed)) return
  canonicalRuntimeVerification ||= verifyCrownCapabilityMatrix()
  if (!canonicalRuntimeVerification.ok) throw new Error('crown-capability-matrix-unverified')
}

export function listCrownCapabilities() {
  assertCanonicalRuntimeAuthority()
  return ROWS.map(clone)
}

export function getCrownCapability(input = {}) {
  assertCanonicalRuntimeAuthority()
  const key = capabilityKey(input)
  const row = ROWS.find((candidate) => candidate.key === key)
  return row ? clone(row) : null
}

function rowFrom(value) {
  assertCanonicalRuntimeAuthority()
  const suppliedKey = String(value?.key || '').trim()
  const key = suppliedKey || capabilityKey(value)
  const row = ROWS.find((candidate) => candidate.key === key)
  if (!row) return null
  const rowMetadataFields = [
    'key', 'evidenceId', 'evidenceStatus', 'previewAllowed', 'submitAllowed', 'reconciliationAllowed', 'blockedReason', 'submitBlockedReason',
    'artifactPath', 'artifactSafeDigest', 'watcherEvidencePath', 'watcherEvidenceDigest',
    'requestRecordEvidenceId', 'responseRecordEvidenceId',
    'submitRequestRecordEvidenceId', 'submitResponseRecordEvidenceId', 'executionEvidenceSchema',
    'fixturePath', 'fixtureSha256', 'mapperEvidence',
    'requestFieldSet', 'requestFieldSetFingerprint',
    'responseFieldSet', 'responseFieldSetFingerprint',
    'submitRequestFieldSet', 'submitRequestFieldSetFingerprint',
    'submitResponseFieldSet', 'submitResponseFieldSetFingerprint',
  ]
  const suppliedRow = value && rowMetadataFields.some((field) => Object.hasOwn(value, field))
  if (suppliedRow && !same(value, row)) throw new Error('crown-capability-metadata-mismatch')
  return row
}

export function assertCrownCapability(value, { operation = 'preview' } = {}) {
  const row = rowFrom(value)
  if (!row) throw new Error('crown-capability-blocked')
  if (operation === 'submit' && !row.submitAllowed) throw new Error('crown-capability-submit-blocked')
  if (operation === 'reconciliation' && !row.reconciliationAllowed) throw new Error('crown-capability-reconciliation-blocked')
  if (!['preview', 'submit', 'reconciliation'].includes(operation)) throw new Error('crown-capability-operation-blocked')
  if (row.evidenceStatus === 'provisional') throw new Error('crown-capability-provisional')
  if (operation === 'preview' && !row.previewAllowed) throw new Error(row.blockedReason || 'crown-capability-preview-blocked')
  return clone(row)
}

export function assertCrownCapabilityFieldSets(value, observed = {}) {
  const row = rowFrom(value)
  if (!row) throw new Error('crown-capability-blocked')
  let checked = false
  if (observed.requestFieldSet !== undefined) {
    checked = true
    if (fingerprintCrownFieldSet(observed.requestFieldSet) !== row.requestFieldSetFingerprint) {
      throw new Error('crown-capability-request-field-set')
    }
  }
  if (observed.responseFieldSet !== undefined) {
    checked = true
    if (fingerprintCrownFieldSet(observed.responseFieldSet) !== row.responseFieldSetFingerprint) {
      throw new Error('crown-capability-response-field-set')
    }
  }
  for (const name of ['submitRequest', 'submitResponse']) {
    const observedName = `${name}FieldSet`
    if (observed[observedName] !== undefined) {
      checked = true
      if (!row[`${name}FieldSetFingerprint`]
        || fingerprintCrownFieldSet(observed[observedName]) !== row[`${name}FieldSetFingerprint`]) {
        throw new Error(`crown-capability-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-field-set`)
      }
    }
  }
  if (!checked) throw new Error('crown-capability-field-set-required')
  return clone(row)
}

function same(left, right) {
  return stableJson(left) === stableJson(right)
}

function fixtureTarget(fixturesRoot, fixturePath) {
  if (!fixturePath || path.isAbsolute(fixturePath)) return null
  const root = path.resolve(fixturesRoot)
  const target = path.resolve(root, fixturePath)
  return target.startsWith(root + path.sep) ? target : null
}

function fixtureFieldSetFingerprint(row, fixture, name, errors) {
  const fields = fixture[`${name}FieldSet`]
  const fingerprint = fixture[`${name}FieldSetFingerprint`]
  let computed = null
  try {
    computed = fingerprintCrownFieldSet(fields)
  } catch {
    errors.push(`${row.key}:${name}-field-set`)
  }
  if (computed !== null && fingerprint !== computed) {
    errors.push(`${row.key}:${name}-field-set-fingerprint`)
  }
  if (fingerprint !== row[`${name}FieldSetFingerprint`]) {
    errors.push(`${row.key}:${name}-field-set-contract`)
  }
}

function artifactRecordStructure(record) {
  const execution = executionRecordBinding(record)
  const hasExecutionBinding = EXECUTION_RECORD_BINDING_FIELDS.some((field) => record?.[field] !== undefined)
  return {
    endpointKind: record.endpointKind,
    method: record.method,
    status: record.status,
    recordType: record.recordType,
    stage: record.stage,
    blocked: record.blocked,
    responseCode: record.responseCode,
    request: record.request,
    response: record.response,
    ...(hasExecutionBinding ? { execution } : {}),
  }
}

function verifyArtifactRecord(record, errors, label) {
  if (!record) { errors.push(`${label}:artifact-record-evidence`); return }
  const structuralFingerprint = `sha256:${sha256(stableJson(artifactRecordStructure(record)))}`
  if (record.structuralFingerprint !== structuralFingerprint) errors.push(`${label}:artifact-record-structure`)
  const recordEvidenceId = `sha256:${sha256(stableJson({
    endpointKind: record.endpointKind,
    method: record.method,
    status: record.status,
    structuralFingerprint,
    occurrence: record.occurrence,
  }))}`
  if (record.recordEvidenceId !== recordEvidenceId) errors.push(`${label}:artifact-record-evidence`)
}

function verifyExecutionEvidenceArtifact(row, fixture, artifact, errors) {
  if (fixture.capture?.id !== fixture.captureId || artifact?.captureId !== fixture.captureId) {
    errors.push(`${row.key}:execution-capture-id`)
  }
  for (const entry of executionEvidenceRecordEntries(fixture)) {
    const artifactRecord = artifact?.records?.find((record) => record.recordEvidenceId === entry.evidence?.recordEvidenceId)
    if (!artifactRecord) {
      errors.push(`${row.key}:execution-artifact-record`)
      continue
    }
    verifyArtifactRecord(artifactRecord, errors, `${row.key}:execution`)
    if (artifactRecord.stage !== entry.stage
      || artifactRecord.recordType !== entry.recordType
      || !same(executionRecordBinding(artifactRecord), executionRecordBinding(entry.evidence))) {
      errors.push(`${row.key}:execution-artifact-record`)
    }
  }
}

function fingerprintExecutionCandidate(candidate) {
  if (!evidenceObject(candidate)) return ''
  const { candidateDigest: _candidateDigest, ...content } = candidate
  return `sha256:${sha256(stableJson(content))}`
}

function verifyAcceptedExecutionCandidate(row, fixture, candidate, watcher, errors) {
  const label = row.key
  if (candidate?.schemaVersion !== 'crown-execution-evidence-candidate-v3'
    || fixture.executionEvidenceSchema !== candidate.schemaVersion
    || row.executionEvidenceSchema !== candidate.schemaVersion) errors.push(`${label}:execution-schema`)
  if (candidate?.candidateDigest !== fingerprintExecutionCandidate(candidate)
    || candidate?.candidateDigest !== row.artifactSafeDigest
    || fixture.executionCandidateDigest !== candidate?.candidateDigest) errors.push(`${label}:execution-candidate-digest`)
  if (!same(candidate?.capability, fixture.capability) || !same(candidate?.capability, {
    mode: row.mode, period: row.period, marketType: row.marketType, lineVariant: row.lineVariant,
  })) errors.push(`${label}:execution-capability`)
  for (const field of [
    'captureDigest', 'accountBinding', 'sessionBinding', 'executionIdentityBinding',
    'resultReferenceBinding', 'watcherEvidenceBinding',
  ]) {
    if (!validEvidenceDigest(candidate?.[field])) errors.push(`${label}:execution-${field}`)
  }
  const watcherDigest = evidenceObject(watcher) ? `sha256:${sha256(stableJson(watcher))}` : ''
  if (watcherDigest !== row.watcherEvidenceDigest
    || watcherDigest !== fixture.watcherEvidenceDigest
    || watcherDigest !== candidate?.watcherEvidenceDigest
    || watcher?.schemaVersion !== 'crown-watcher-execution-evidence-v1'
    || watcher?.captureId !== fixture.captureId
    || watcher?.gid !== '8903285'
    || watcher?.mode !== 'prematch'
    || watcher?.eventStatus !== 'not_started'
    || watcher?.period !== 'full_time'
    || watcher?.marketType !== 'asian_handicap'
    || watcher?.ratioField !== 'RATIO_R'
    || watcher?.line !== '0.5 / 1'
    || watcher?.side !== 'away'
    || watcher?.oddsField !== 'IOR_RC'
    || !['0.96', '0.960'].includes(watcher?.odds)
    || watcher?.suspended !== false
    || !same(candidate?.watcherEvidence, {
      capturedAt: watcher?.capturedAt,
      auditId: watcher?.auditId,
      batchId: watcher?.batchId,
      ratioField: watcher?.ratioField,
      oddsField: watcher?.oddsField,
    })) errors.push(`${label}:watcher-evidence`)
  if (candidate?.currency !== 'CNY'
    || candidate?.outcome !== 'accepted'
    || candidate?.outcomeEvidence !== 'direct-response'
    || candidate?.evidenceIncomplete !== false
    || !Array.isArray(candidate?.incompleteReasons)
    || candidate.incompleteReasons.length !== 0) errors.push(`${label}:execution-accepted-only`)
  if (!same(candidate?.stakeQuantum, { amountMinor: 50, provenance: 'local-conservative-policy' })) {
    errors.push(`${label}:execution-local-quantum`)
  }
  if (!same(candidate?.direct?.preview, {
    code: '501', minimum: '50', maximum: '20000', odds: '0.96', line: '0.5 / 1',
  }) || !same(candidate?.direct?.submit, { code: '560', amount: '50', odds: '0.96' })) {
    errors.push(`${label}:execution-direct-contract`)
  }
  if (!same(candidate?.submitWireEvidence, {
    con: '1', conSource: 'preview-response:con',
    ratio: '50', ratioSource: 'preview-response:ratio',
    f: '1R', timestamp2: '', timestampSource: 'submit-request:epoch-ms',
  })) errors.push(`${label}:execution-submit-wire`)
  const chronology = candidate?.chronology
  const chronologyExpected = {
    maxWatcherToSubmitMs: 60000,
    watcherCapturedAt: '2026-07-14T00:58:55.980Z',
    previewRequestAt: '2026-07-14T00:59:28.553Z',
    previewResponseAt: '2026-07-14T00:59:28.791Z',
    submitTimestampAt: '2026-07-14T00:59:30.804Z',
    submitRequestAt: '2026-07-14T00:59:30.835Z',
    submitResponseAt: '2026-07-14T00:59:31.397Z',
  }
  const times = chronology ? [
    chronology.watcherCapturedAt, chronology.previewRequestAt, chronology.previewResponseAt,
    chronology.submitTimestampAt, chronology.submitRequestAt, chronology.submitResponseAt,
  ].map(Date.parse) : []
  if (!same(chronology, chronologyExpected)
    || times.length !== 6 || times.some((value) => !Number.isFinite(value))
    || times.some((value, index) => index > 0 && value < times[index - 1])
    || times[3] - times[0] > chronologyExpected.maxWatcherToSubmitMs
    || times[4] - times[3] > 1000) errors.push(`${label}:execution-chronology`)
  const expectedRecords = [
    ['preview', 'request', row.requestRecordEvidenceId, row.requestFieldSet, row.requestFieldSetFingerprint],
    ['preview', 'response', row.responseRecordEvidenceId, row.responseFieldSet, row.responseFieldSetFingerprint],
    ['submit', 'request', row.submitRequestRecordEvidenceId, row.submitRequestFieldSet, row.submitRequestFieldSetFingerprint],
    ['submit', 'response', row.submitResponseRecordEvidenceId, row.submitResponseFieldSet, row.submitResponseFieldSetFingerprint],
  ]
  if (!Array.isArray(candidate?.records) || candidate.records.length !== expectedRecords.length) {
    errors.push(`${label}:execution-records`)
    return
  }
  expectedRecords.forEach(([stage, recordType, recordEvidenceId, fieldSet, fieldSetFingerprint], index) => {
    const record = candidate.records[index]
    if (record?.ordinal !== index + 1 || record?.stage !== stage || record?.recordType !== recordType
      || record?.recordEvidenceId !== recordEvidenceId || !validEvidenceDigest(record?.recordEvidenceId)
      || !same(record?.fieldSet, fieldSet) || record?.fieldSetFingerprint !== fieldSetFingerprint
      || record?.fieldSetFingerprint !== fingerprintCrownFieldSet(record?.fieldSet || [])) {
      errors.push(`${label}:execution-record-${stage}-${recordType}`)
    }
  })
}

export function verifyCrownCapabilityMatrix({ fixturesRoot = DEFAULT_FIXTURES_ROOT, rows = ROWS } = {}) {
  const errors = []
  for (const row of rows) {
    const target = fixtureTarget(fixturesRoot, row.fixturePath)
    if (!target) {
      errors.push(`${row.key}:fixture-path`)
      continue
    }
    let bytes
    try {
      bytes = fs.readFileSync(target)
    } catch {
      errors.push(`${row.key}:fixture-missing`)
      continue
    }
    const text = bytes.toString('utf8')
    if (sha256(bytes) !== row.fixtureSha256) errors.push(`${row.key}:fixture-sha256`)
    if (PROHIBITED_FIXTURE_TEXT.test(text)) errors.push(`${row.key}:fixture-sensitive-text`)
    if (ABSOLUTE_FIXTURE_PATH.test(text) || /data[\\/]runtime/i.test(text)) errors.push(`${row.key}:fixture-path-material`)

    let fixture
    try {
      fixture = JSON.parse(text)
    } catch {
      errors.push(`${row.key}:fixture-json`)
      continue
    }
    if (fixture.evidenceId !== row.evidenceId) errors.push(`${row.key}:evidence-id`)
    if (fixture.evidenceStatus !== row.evidenceStatus) errors.push(`${row.key}:evidence-status`)
    if (fixture.previewAllowed !== row.previewAllowed) errors.push(`${row.key}:preview-allowed`)
    if (fixture.submitAllowed !== row.submitAllowed) errors.push(`${row.key}:submit-allowed`)
    if (fixture.reconciliationAllowed !== row.reconciliationAllowed) errors.push(`${row.key}:reconciliation-allowed`)
    if (fixture.blockedReason !== row.blockedReason) errors.push(`${row.key}:blocked-reason`)
    if (fixture.submitBlockedReason !== row.submitBlockedReason) errors.push(`${row.key}:submit-blocked-reason`)
    if (!same(fixture.capability, {
      mode: row.mode,
      period: row.period,
      marketType: row.marketType,
      lineVariant: row.lineVariant,
    })) errors.push(`${row.key}:fixture-capability`)
    if (!same(fixture.mapperEvidence, row.mapperEvidence)) errors.push(`${row.key}:mapper-evidence`)
    if (!same(fixture.requestFieldSet, row.requestFieldSet)) errors.push(`${row.key}:request-field-set`)
    fixtureFieldSetFingerprint(row, fixture, 'request', errors)
    if (!same(fixture.responseFieldSet, row.responseFieldSet)) errors.push(`${row.key}:response-field-set`)
    fixtureFieldSetFingerprint(row, fixture, 'response', errors)
    if ((row.previewAllowed || row.submitAllowed)
      && row.executionEvidenceSchema !== 'crown-execution-evidence-candidate-v3'
      && validateCrownExecutionEvidence(fixture, { expectedCapability: row }).evidenceIncomplete) {
      errors.push(`${row.key}:execution-evidence-incomplete`)
    }
    for (const field of [
      'artifactPath', 'artifactSafeDigest', 'requestRecordEvidenceId', 'responseRecordEvidenceId',
      'submitRequestRecordEvidenceId', 'submitResponseRecordEvidenceId', 'executionEvidenceSchema',
      'watcherEvidencePath', 'watcherEvidenceDigest',
    ]) {
      if (row[field] === undefined && fixture[field] === undefined) continue
      if (fixture[field] !== row[field]) errors.push(`${row.key}:${field}`)
    }
    const artifactTarget = fixtureTarget(fixturesRoot, row.artifactPath)
    if (!artifactTarget) {
      errors.push(`${row.key}:artifact-path`)
    } else {
      let artifactText = ''
      let artifact
      try {
        artifactText = fs.readFileSync(artifactTarget, 'utf8')
        artifact = JSON.parse(artifactText)
      } catch {
        errors.push(`${row.key}:artifact-missing`)
      }
      if (artifact) {
        if (PROHIBITED_FIXTURE_TEXT.test(artifactText) || ABSOLUTE_FIXTURE_PATH.test(artifactText)) {
          errors.push(`${row.key}:artifact-sensitive-text`)
        }
        if (row.executionEvidenceSchema === 'crown-execution-evidence-candidate-v3') {
          let watcher
          let watcherText = ''
          const watcherTarget = fixtureTarget(fixturesRoot, row.watcherEvidencePath)
          try {
            watcherText = fs.readFileSync(watcherTarget, 'utf8')
            watcher = JSON.parse(watcherText)
          } catch {
            errors.push(`${row.key}:watcher-evidence-missing`)
          }
          if (PROHIBITED_FIXTURE_TEXT.test(watcherText) || ABSOLUTE_FIXTURE_PATH.test(watcherText)) {
            errors.push(`${row.key}:watcher-evidence-sensitive-text`)
          }
          verifyAcceptedExecutionCandidate(row, fixture, artifact, watcher, errors)
        } else {
          const digest = fingerprintCrownProtocolArtifact(artifact)
          if (artifact.artifactSafeDigest && artifact.artifactSafeDigest !== digest) {
            errors.push(`${row.key}:artifact-embedded-digest`)
          }
          if (digest !== row.artifactSafeDigest) errors.push(`${row.key}:artifact-digest`)
          if (artifact.captureId !== fixture.captureId) errors.push(`${row.key}:artifact-capture-id`)
          const requestRecord = artifact.records?.find((record) => record.recordEvidenceId === row.requestRecordEvidenceId)
          const responseRecord = artifact.records?.find((record) => record.recordEvidenceId === row.responseRecordEvidenceId)
          verifyArtifactRecord(requestRecord, errors, row.key)
          verifyArtifactRecord(responseRecord, errors, row.key)
          if (!same(requestRecord?.request?.fieldSet, row.requestFieldSet)
            || requestRecord?.request?.fieldSetFingerprint !== row.requestFieldSetFingerprint) {
            errors.push(`${row.key}:artifact-request-field-set`)
          }
          if (!same(responseRecord?.response?.fieldSet, row.responseFieldSet)
            || responseRecord?.response?.fieldSetFingerprint !== row.responseFieldSetFingerprint) {
            errors.push(`${row.key}:artifact-response-field-set`)
          }
          if (row.previewAllowed || row.submitAllowed) {
            verifyExecutionEvidenceArtifact(row, fixture, artifact, errors)
          }
        }
      }
    }
    if (row.evidenceStatus === 'provisional' && (row.previewAllowed || row.submitAllowed)) {
      errors.push(`${row.key}:provisional-allowed`)
    }
  }
  return {
    ok: errors.length === 0,
    matrixVersion: computeCrownCapabilityMatrixVersion(rows),
    rowCount: rows.length,
    provisionalCount: rows.filter((row) => row.evidenceStatus === 'provisional').length,
    allowedPreviewCount: rows.filter((row) => row.previewAllowed).length,
    allowedSubmitCount: rows.filter((row) => row.submitAllowed).length,
    allowedReconciliationCount: rows.filter((row) => row.reconciliationAllowed).length,
    errors,
  }
}
