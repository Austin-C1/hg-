import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MATRIX_VERSION_PREFIX = 'crown-protocol-capabilities-v2'
const DEFAULT_FIXTURES_ROOT = fileURLToPath(new URL('../../../data/fixtures/crown/betting-protocol/', import.meta.url))
const PROHIBITED_FIXTURE_TEXT = /\b(?:cookie|uid|token|ticket|password|authorization)\b/i
const ABSOLUTE_FIXTURE_PATH = /[A-Za-z]:\\|\/(?:Users|home|tmp)\//i

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

export function capabilityKey(input = {}) {
  return [input.mode, input.period, input.marketType, input.lineVariant]
    .map((value) => String(value || '').trim())
    .join('|')
}

const REQUEST_FIELD_SET = Object.freeze(['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'])
const RESPONSE_FIELD_SET = Object.freeze(['code', 'con', 'dates', 'game_sc', 'game_so', 'gold_gmax', 'gold_gmin', 'ioratio', 'league_id', 'maxcredit', 'mem_sc', 'mem_so', 'num_c', 'num_h', 'ratio', 'restsinglecredit', 'spread', 'strong', 'times'])
const REQUEST_FIELD_SET_FINGERPRINT = fingerprintCrownFieldSet(REQUEST_FIELD_SET)
const RESPONSE_FIELD_SET_FINGERPRINT = fingerprintCrownFieldSet(RESPONSE_FIELD_SET)

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
    fixturePath: row.fixturePath,
    fixtureSha256: row.fixtureSha256,
    artifactPath: row.artifactPath,
    artifactSafeDigest: row.artifactSafeDigest,
    requestRecordEvidenceId: row.requestRecordEvidenceId,
    responseRecordEvidenceId: row.responseRecordEvidenceId,
    mapperEvidence: row.mapperEvidence,
    requestFieldSet: canonicalFieldSet(row.requestFieldSet),
    requestFieldSetFingerprint: row.requestFieldSetFingerprint,
    responseFieldSet: canonicalFieldSet(row.responseFieldSet),
    responseFieldSetFingerprint: row.responseFieldSetFingerprint,
  })).sort((left, right) => left.key < right.key ? -1 : (left.key > right.key ? 1 : 0))
  return `${MATRIX_VERSION_PREFIX}:${sha256(stableJson(content)).slice(0, 16)}`
}

export const CROWN_CAPABILITY_MATRIX_VERSION = computeCrownCapabilityMatrixVersion(ROWS)

function clone(value) {
  return structuredClone(value)
}

export function listCrownCapabilities() {
  return ROWS.map(clone)
}

export function getCrownCapability(input = {}) {
  const key = capabilityKey(input)
  const row = ROWS.find((candidate) => candidate.key === key)
  return row ? clone(row) : null
}

function rowFrom(value) {
  const suppliedKey = String(value?.key || '').trim()
  const key = suppliedKey || capabilityKey(value)
  const row = ROWS.find((candidate) => candidate.key === key)
  if (!row) return null
  const rowMetadataFields = [
    'key', 'evidenceId', 'evidenceStatus', 'previewAllowed', 'submitAllowed', 'reconciliationAllowed', 'blockedReason', 'submitBlockedReason',
    'artifactPath', 'artifactSafeDigest', 'requestRecordEvidenceId', 'responseRecordEvidenceId',
    'fixturePath', 'fixtureSha256', 'mapperEvidence',
    'requestFieldSet', 'requestFieldSetFingerprint',
    'responseFieldSet', 'responseFieldSetFingerprint',
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

export function verifyCrownCapabilityMatrix({ fixturesRoot = DEFAULT_FIXTURES_ROOT } = {}) {
  const errors = []
  for (const row of ROWS) {
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
    for (const field of ['artifactPath', 'artifactSafeDigest', 'requestRecordEvidenceId', 'responseRecordEvidenceId']) {
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
      }
    }
    if (row.evidenceStatus === 'provisional' && (row.previewAllowed || row.submitAllowed)) {
      errors.push(`${row.key}:provisional-allowed`)
    }
  }
  return {
    ok: errors.length === 0,
    matrixVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    rowCount: ROWS.length,
    provisionalCount: ROWS.filter((row) => row.evidenceStatus === 'provisional').length,
    allowedPreviewCount: ROWS.filter((row) => row.previewAllowed).length,
    allowedSubmitCount: ROWS.filter((row) => row.submitAllowed).length,
    allowedReconciliationCount: ROWS.filter((row) => row.reconciliationAllowed).length,
    errors,
  }
}
