import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  capabilityKey,
  computeCrownCapabilityMatrixVersion,
  fingerprintCrownFieldSet,
  fingerprintCrownProtocolArtifact,
  getCrownCapability,
  listCrownCapabilities,
  validateCrownExecutionEvidence,
  verifyCrownCapabilityMatrix,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import { buildStrictCrownPreviewFields, buildStrictCrownPreviewWireFields } from '../src/crown/betting/crown-order-field-mapper.mjs'
import { parseCrownPreviewResponseStrict } from '../src/crown/betting/crown-bet-response-parser.mjs'
import { buildCrownProtocolArtifact, summarizeCrownProtocol } from '../scripts/crown-betting-protocol-analyze.mjs'

const FIXTURES_ROOT = path.resolve('data/fixtures/crown/betting-protocol')
const EVIDENCE_CAPABILITY = Object.freeze({
  mode: 'live',
  period: 'full_time',
  marketType: 'asian_handicap',
  lineVariant: 'main',
})
const EXECUTION_RECORD_BINDING_FIELDS = Object.freeze([
  'sequence', 'capturedAt', 'captureId', 'accountBinding', 'sessionBinding', 'executionIdentityDigest',
  'operation', 'truncated', 'inferredFromLaterState', 'stakeLimits', 'stake', 'outcome', 'orderCreated',
  'persistentOrderIdDigest', 'rejectionCode',
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function evidenceDigest(character) {
  return `sha256:${character.repeat(64)}`
}

function completeExecutionEvidence(capability = EVIDENCE_CAPABILITY) {
  const capture = {
    id: 'capture-20260713-120000',
    source: 'production-capture',
    synthetic: false,
    truncated: false,
    inferredFromLaterState: false,
    accountBinding: evidenceDigest('a'),
    sessionBinding: evidenceDigest('b'),
  }
  const record = (sequence, executionIdentityDigest) => ({
    sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 13, 4, 0, sequence)).toISOString(),
    recordEvidenceId: evidenceDigest(String(sequence)),
    captureId: capture.id,
    accountBinding: capture.accountBinding,
    sessionBinding: capture.sessionBinding,
    executionIdentityDigest,
  })
  const attempt = ({ outcome, startSequence, amountMinor, identityCharacter }) => {
    const executionIdentityDigest = evidenceDigest(identityCharacter)
    const money = {
      currency: 'CNY',
      amountMinor,
      serverMinMinor: 50,
      serverMaxMinor: 500,
      localStakeQuantumMinor: 50,
      localStakeQuantumProvenance: 'local-conservative-policy',
      sources: {
        currency: { stage: 'account-summary', field: 'currency' },
        amountMinor: { stage: 'submit-request', field: 'gold' },
        serverMinMinor: { stage: 'preview-response', field: 'gold_gmin' },
        serverMaxMinor: { stage: 'preview-response', field: 'gold_gmax' },
        localStakeQuantumMinor: { stage: 'local-policy', field: 'local-conservative-policy' },
      },
    }
    return {
      outcome,
      capability: { ...capability },
      executionIdentityDigest,
      money,
      preview: {
        request: { ...record(startSequence, executionIdentityDigest), operation: 'FT_order_view' },
        response: {
          ...record(startSequence + 1, executionIdentityDigest),
          operation: 'FT_order_view',
          truncated: false,
          inferredFromLaterState: false,
          stakeLimits: {
            minMinor: money.serverMinMinor,
            maxMinor: money.serverMaxMinor,
          },
        },
      },
      submit: {
        request: {
          ...record(startSequence + 2, executionIdentityDigest),
          operation: 'FT_bet',
          stake: { currency: money.currency, amountMinor: money.amountMinor },
        },
        response: {
          ...record(startSequence + 3, executionIdentityDigest),
          operation: 'FT_bet',
          truncated: false,
          inferredFromLaterState: false,
          outcome,
          orderCreated: outcome === 'accepted',
          ...(outcome === 'accepted'
            ? { persistentOrderIdDigest: evidenceDigest('f') }
            : { rejectionCode: 'stake-below-current-minimum' }),
        },
      },
    }
  }
  return {
    capability: { ...capability },
    capture,
    attempts: [
      attempt({ outcome: 'accepted', startSequence: 1, amountMinor: 100, identityCharacter: 'c' }),
      attempt({ outcome: 'rejected', startSequence: 5, amountMinor: 150, identityCharacter: 'd' }),
    ],
  }
}

function stableEvidenceValue(value) {
  if (Array.isArray(value)) return value.map(stableEvidenceValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableEvidenceValue(value[key])]))
  }
  return value
}

function executionRecordBinding(record = {}) {
  return Object.fromEntries(EXECUTION_RECORD_BINDING_FIELDS.map((field) => [field, record[field]]))
}

function signArtifactRecord(record) {
  const structure = {
    endpointKind: record.endpointKind,
    method: record.method,
    status: record.status,
    recordType: record.recordType,
    stage: record.stage,
    blocked: record.blocked,
    responseCode: record.responseCode,
    request: record.request,
    response: record.response,
    execution: executionRecordBinding(record),
  }
  const structuralFingerprint = `sha256:${sha256(JSON.stringify(stableEvidenceValue(structure)))}`
  const recordEvidenceId = `sha256:${sha256(JSON.stringify(stableEvidenceValue({
    endpointKind: record.endpointKind,
    method: record.method,
    status: record.status,
    structuralFingerprint,
    occurrence: record.occurrence,
  })))}`
  return { ...record, structuralFingerprint, recordEvidenceId }
}

function executionEvidenceRecordEntries(evidence) {
  return evidence.attempts.flatMap((attempt) => [
    { evidence: attempt.preview.request, stage: 'preview', recordType: 'request' },
    { evidence: attempt.preview.response, stage: 'preview', recordType: 'response' },
    { evidence: attempt.submit.request, stage: 'submit', recordType: 'request' },
    { evidence: attempt.submit.response, stage: 'submit', recordType: 'response' },
  ])
}

function writeLinkedExecutionArtifact({ fixturesRoot, row, fixture }) {
  const emptyFields = { fieldSet: [], fieldSetFingerprint: null }
  const records = executionEvidenceRecordEntries(fixture).map((entry, index) => {
    const fields = entry.recordType === 'request'
      ? (entry.stage === 'preview' ? row.requestFieldSet : ['gold', 'p'])
      : (entry.stage === 'preview'
          ? row.responseFieldSet
          : (entry.evidence.outcome === 'accepted' ? ['bet_id', 'code'] : ['code', 'error']))
    const fieldEvidence = { fieldSet: [...fields].sort(), fieldSetFingerprint: fingerprintCrownFieldSet(fields) }
    const record = signArtifactRecord({
      occurrence: index + 1,
      endpointKind: 'transform',
      method: 'POST',
      status: entry.recordType === 'response' ? 200 : null,
      recordType: entry.recordType,
      stage: entry.stage,
      blocked: false,
      responseCode: entry.recordType === 'response'
        ? (entry.stage === 'preview' ? '501' : entry.evidence.outcome)
        : null,
      request: entry.recordType === 'request' ? fieldEvidence : emptyFields,
      response: entry.recordType === 'response' ? fieldEvidence : emptyFields,
      ...executionRecordBinding(entry.evidence),
    })
    entry.evidence.recordEvidenceId = record.recordEvidenceId
    return record
  })
  const artifact = { schemaVersion: 2, captureId: fixture.capture.id, records }
  artifact.artifactSafeDigest = fingerprintCrownProtocolArtifact(artifact)
  row.artifactSafeDigest = artifact.artifactSafeDigest
  fixture.artifactSafeDigest = artifact.artifactSafeDigest
  row.requestRecordEvidenceId = records[0].recordEvidenceId
  fixture.requestRecordEvidenceId = records[0].recordEvidenceId
  row.responseRecordEvidenceId = records[1].recordEvidenceId
  fixture.responseRecordEvidenceId = records[1].recordEvidenceId
  fs.writeFileSync(path.join(fixturesRoot, row.artifactPath), `${JSON.stringify(artifact, null, 2)}\n`)
}

async function importEnabledRuntimeMatrix(fixtureState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `crown-runtime-authority-${fixtureState}-`))
  const fixturesRoot = path.join(root, 'fixtures')
  fs.mkdirSync(path.join(fixturesRoot, 'artifacts'), { recursive: true })
  const rows = listCrownCapabilities()
  for (const row of rows) {
    fs.copyFileSync(path.join(FIXTURES_ROOT, row.fixturePath), path.join(fixturesRoot, row.fixturePath))
    fs.copyFileSync(path.join(FIXTURES_ROOT, row.artifactPath), path.join(fixturesRoot, row.artifactPath))
  }

  const row = rows[0]
  const originalProvenance = {
    fixtureSha256: row.fixtureSha256,
    artifactSafeDigest: row.artifactSafeDigest,
    requestRecordEvidenceId: row.requestRecordEvidenceId,
    responseRecordEvidenceId: row.responseRecordEvidenceId,
  }
  const fixtureFile = path.join(fixturesRoot, row.fixturePath)
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
  fixture.previewAllowed = true
  fixture.submitAllowed = true
  if (fixtureState !== 'incomplete') {
    Object.assign(fixture, completeExecutionEvidence(fixture.capability))
    fixture.capture.id = fixture.captureId
    for (const entry of executionEvidenceRecordEntries(fixture)) entry.evidence.captureId = fixture.captureId
    writeLinkedExecutionArtifact({ fixturesRoot, row, fixture })
  }
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  const pinnedSha256 = sha256(fs.readFileSync(fixtureFile))
  if (fixtureState === 'hash-drift') fs.appendFileSync(fixtureFile, ' ')
  if (fixtureState === 'missing') fs.rmSync(fixtureFile)

  const sourceFile = path.resolve('src/crown/betting/crown-capability-matrix.mjs')
  let source = fs.readFileSync(sourceFile, 'utf8')
  source = source.replace(
    /const DEFAULT_FIXTURES_ROOT = .*\r?\n/,
    `const DEFAULT_FIXTURES_ROOT = ${JSON.stringify(fixturesRoot)}\n`,
  )
  source = source.replace('previewAllowed: false', 'previewAllowed: true')
  source = source.replace('submitAllowed: false', 'submitAllowed: true')
  source = source.replace(originalProvenance.fixtureSha256, pinnedSha256)
  source = source.replace(originalProvenance.artifactSafeDigest, row.artifactSafeDigest)
  source = source.replace(originalProvenance.requestRecordEvidenceId, row.requestRecordEvidenceId)
  source = source.replace(originalProvenance.responseRecordEvidenceId, row.responseRecordEvidenceId)
  const moduleFile = path.join(root, `crown-capability-matrix-${fixtureState}.mjs`)
  fs.writeFileSync(moduleFile, source)
  return import(`${pathToFileURL(moduleFile).href}?fixtureState=${fixtureState}`)
}

test('matrix enables only the accepted prematch full-time main asian-handicap row', () => {
  const rows = listCrownCapabilities()

  assert.match(CROWN_CAPABILITY_MATRIX_VERSION, /^crown-protocol-capabilities-v2:[a-f0-9]{16}$/)
  assert.equal(computeCrownCapabilityMatrixVersion(rows), CROWN_CAPABILITY_MATRIX_VERSION)
  assert.deepEqual(rows.map((row) => row.key), [
    'live|first_half|total|main',
    'live|full_time|asian_handicap|main',
    'prematch|full_time|asian_handicap|main',
  ])

  for (const row of rows) {
    assert.equal(row.key, capabilityKey(row))
    assert.equal(row.evidenceStatus, 'verified')
    const enabled = row.key === 'prematch|full_time|asian_handicap|main'
    assert.equal(row.previewAllowed, enabled)
    assert.equal(row.submitAllowed, enabled)
    assert.equal(row.reconciliationAllowed, false)
    assert.equal(row.blockedReason, enabled ? '' : 'crown-preview-field-source-unproven')
    assert.equal(row.submitBlockedReason, enabled ? '' : 'crown-submit-evidence-missing')
    assert.match(row.evidenceId, /^crown-capture-/)
    assert.equal(path.isAbsolute(row.fixturePath), false)
    assert.equal(typeof row.mapperEvidence, 'object')
    assert.deepEqual(row.requestFieldSet, [...row.requestFieldSet].sort())
    assert.deepEqual(row.responseFieldSet, [...row.responseFieldSet].sort())
    assert.equal(row.requestFieldSetFingerprint, fingerprintCrownFieldSet(row.requestFieldSet))
    assert.equal(row.responseFieldSetFingerprint, fingerprintCrownFieldSet(row.responseFieldSet))
    assert.deepEqual(row.requestFieldSet, ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'])
    assert.ok(row.responseFieldSet.length > 6)
    assert.ok(row.responseFieldSet.includes('maxcredit'))
    assert.ok(row.responseFieldSet.includes('times'))
    assert.match(row.fixtureSha256, /^[a-f0-9]{64}$/)
  }
})

test('legacy preview-only fixtures stay incomplete while the accepted candidate is enabled', () => {
  assert.equal(typeof validateCrownExecutionEvidence, 'function')

  for (const row of listCrownCapabilities()) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, row.fixturePath), 'utf8'))
    if (row.executionEvidenceSchema === 'crown-execution-evidence-candidate-v3') {
      assert.equal(row.previewAllowed, true)
      assert.equal(row.submitAllowed, true)
      continue
    }
    const result = validateCrownExecutionEvidence(fixture)
    assert.equal(result.status, 'evidenceIncomplete')
    assert.equal(result.evidenceIncomplete, true)
    assert.equal(result.previewEvidenceComplete, false)
    assert.equal(result.submitEvidenceComplete, false)
    assert.ok(result.errors.length > 0)
    assert.equal(row.previewAllowed, false)
    assert.equal(row.submitAllowed, false)
  }
})

test('accepted-only structurally complete evidence is valid while canonical enablement stays exact', () => {
  const result = validateCrownExecutionEvidence(completeExecutionEvidence())
  assert.deepEqual(result, {
    status: 'structureComplete',
    evidenceIncomplete: false,
    previewEvidenceComplete: true,
    submitEvidenceComplete: true,
    errors: [],
  })

  const matrix = verifyCrownCapabilityMatrix()
  assert.deepEqual([matrix.allowedPreviewCount, matrix.allowedSubmitCount], [1, 1])
  assert.deepEqual(listCrownCapabilities().filter((row) => row.previewAllowed || row.submitAllowed).map((row) => row.key), [
    'prematch|full_time|asian_handicap|main',
  ])
})

test('synthetic, inferred, truncated, or partial execution records stay evidenceIncomplete', () => {
  const cases = [
    ['synthetic capture', (value) => { value.capture.synthetic = true }, 'synthetic-evidence'],
    ['later state capture', (value) => { value.capture.inferredFromLaterState = true }, 'later-state-inference'],
    ['truncated preview response', (value) => { value.attempts[0].preview.response.truncated = true }, 'response-truncated'],
    ['later state submit response', (value) => { value.attempts[0].submit.response.inferredFromLaterState = true }, 'response-inferred-from-later-state'],
    ['missing submit request', (value) => { delete value.attempts[0].submit.request }, 'preview-submit-records-required'],
    ['missing record provenance', (value) => { delete value.attempts[0].submit.request.recordEvidenceId }, 'record-provenance-required'],
    ['invalid persistent order id', (value) => { value.attempts[0].submit.response.persistentOrderIdDigest = 'redacted' }, 'accepted-order-id-required'],
  ]

  for (const [label, mutate, expectedError] of cases) {
    const evidence = completeExecutionEvidence()
    mutate(evidence)
    const result = validateCrownExecutionEvidence(evidence)
    assert.equal(result.status, 'evidenceIncomplete', label)
    assert.equal(result.previewEvidenceComplete, false, label)
    assert.equal(result.submitEvidenceComplete, false, label)
    assert.ok(result.errors.includes(expectedError), `${label}: ${result.errors.join(', ')}`)
  }
})

test('capture, account, session, identity, and timeline drift stay evidenceIncomplete', () => {
  const cases = [
    ['capability drift', (value) => { value.attempts[1].capability.marketType = 'total' }, 'capability-drift'],
    ['capture drift', (value) => { value.attempts[0].submit.request.captureId = 'other-capture' }, 'capture-binding-drift'],
    ['account drift', (value) => { value.attempts[0].preview.response.accountBinding = evidenceDigest('e') }, 'account-binding-drift'],
    ['session drift', (value) => { value.attempts[1].submit.response.sessionBinding = evidenceDigest('e') }, 'session-binding-drift'],
    ['identity drift', (value) => { value.attempts[0].submit.request.executionIdentityDigest = evidenceDigest('e') }, 'execution-identity-drift'],
    ['sequence drift', (value) => { value.attempts[0].submit.request.sequence = 2 }, 'timeline-order'],
    ['timestamp drift', (value) => { value.attempts[1].preview.request.capturedAt = '2026-07-13T04:00:01.000Z' }, 'timeline-order'],
    ['preview operation drift', (value) => { value.attempts[0].preview.request.operation = 'FT_bet' }, 'preview-operation'],
    ['submit operation drift', (value) => { value.attempts[0].submit.request.operation = 'FT_order_view' }, 'submit-operation'],
  ]

  for (const [label, mutate, expectedError] of cases) {
    const evidence = completeExecutionEvidence()
    mutate(evidence)
    const result = validateCrownExecutionEvidence(evidence)
    assert.equal(result.status, 'evidenceIncomplete', label)
    assert.ok(result.errors.includes(expectedError), `${label}: ${result.errors.join(', ')}`)
  }
})

test('execution evidence must match the capability row being considered', () => {
  const result = validateCrownExecutionEvidence(completeExecutionEvidence(), {
    expectedCapability: { ...EVIDENCE_CAPABILITY, period: 'first_half' },
  })
  assert.equal(result.status, 'evidenceIncomplete')
  assert.ok(result.errors.includes('capability-mismatch'))
})

test('CNY integer stake, server bounds, local quantum, and exact field sources cannot drift', () => {
  const cases = [
    ['currency', (value) => { value.attempts[0].money.currency = 'USD' }, 'cny-money-required'],
    ['integer amount', (value) => { value.attempts[0].money.amountMinor = 100.5 }, 'integer-money-required'],
    ['submit amount drift', (value) => { value.attempts[0].submit.request.stake.amountMinor = 150 }, 'money-drift'],
    ['preview minimum drift', (value) => { value.attempts[0].preview.response.stakeLimits.minMinor = 100 }, 'money-drift'],
    ['outside server range', (value) => { value.attempts[0].money.amountMinor = 550; value.attempts[0].submit.request.stake.amountMinor = 550 }, 'money-range'],
    ['off local quantum', (value) => { value.attempts[0].money.amountMinor = 125; value.attempts[0].submit.request.stake.amountMinor = 125 }, 'money-step'],
    ['missing quantum source', (value) => { delete value.attempts[0].money.sources.localStakeQuantumMinor }, 'money-source-required'],
    ['wrong minimum source', (value) => { value.attempts[0].money.sources.serverMinMinor.stage = 'later-order-history' }, 'money-source-required'],
  ]

  for (const [label, mutate, expectedError] of cases) {
    const evidence = completeExecutionEvidence()
    mutate(evidence)
    const result = validateCrownExecutionEvidence(evidence)
    assert.equal(result.status, 'evidenceIncomplete', label)
    assert.ok(result.errors.includes(expectedError), `${label}: ${result.errors.join(', ')}`)
  }
})

test('provenance-evidenced row still blocks preview when a wire value source is unproven', () => {
  const candidate = getCrownCapability({
    mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
  })
  assert.equal(candidate?.evidenceStatus, 'verified')
  assert.throws(() => assertCrownCapability(candidate, { operation: 'preview' }), /crown-preview-field-source-unproven/)
  assert.throws(() => assertCrownCapability(candidate, { operation: 'submit' }), /crown-capability-submit-blocked/)
  assert.throws(() => assertCrownCapability(candidate, { operation: 'reconciliation' }), /crown-capability-reconciliation-blocked/)

  for (const input of [
    { mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'alternate_a' },
    { mode: 'live', period: 'first_half', marketType: 'asian_handicap', lineVariant: 'main' },
    { mode: 'live', period: 'full_time', marketType: 'total', lineVariant: 'main' },
    { mode: 'live', period: 'full_time', marketType: 'moneyline', lineVariant: 'main' },
  ]) {
    assert.equal(getCrownCapability(input), null)
    assert.throws(() => assertCrownCapability(input, { operation: 'preview' }), /crown-capability-blocked/)
  }
  const enabled = getCrownCapability({
    mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
  })
  assert.equal(assertCrownCapability(enabled, { operation: 'preview' }).key, enabled.key)
  assert.equal(assertCrownCapability(enabled, { operation: 'submit' }).key, enabled.key)
  assert.throws(() => assertCrownCapability(enabled, { operation: 'reconciliation' }), /reconciliation-blocked/)
})

test('public assertions reject forged row metadata and always trust the canonical matrix', () => {
  const canonical = getCrownCapability({
    mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
  })
  const forged = {
    ...canonical,
    evidenceStatus: 'verified',
    previewAllowed: true,
    submitAllowed: true,
  }

  assert.throws(() => assertCrownCapability(forged, { operation: 'preview' }), /crown-capability-metadata-mismatch/)
  assert.throws(() => assertCrownCapability(forged, { operation: 'submit' }), /crown-capability-metadata-mismatch/)
  assert.throws(() => assertCrownCapabilityFieldSets(forged, {
    requestFieldSet: forged.requestFieldSet,
    responseFieldSet: forged.responseFieldSet,
  }), /crown-capability-metadata-mismatch/)
})

test('matrix verifies fixture hashes, evidence metadata, and field-set fingerprints', () => {
  const result = verifyCrownCapabilityMatrix()
  assert.deepEqual(result, {
    ok: true,
    matrixVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    rowCount: 3,
    provisionalCount: 0,
    allowedPreviewCount: 1,
    allowedSubmitCount: 1,
    allowedReconciliationCount: 0,
    errors: [],
  })

  for (const row of listCrownCapabilities()) {
    const bytes = fs.readFileSync(path.join(FIXTURES_ROOT, row.fixturePath))
    const fixture = JSON.parse(bytes)
    assert.equal(row.fixtureSha256, sha256(bytes))
    assert.equal(fixture.evidenceId, row.evidenceId)
    assert.equal(fixture.evidenceStatus, row.evidenceStatus)
    assert.deepEqual(fixture.capability, {
      mode: row.mode,
      period: row.period,
      marketType: row.marketType,
      lineVariant: row.lineVariant,
    })
    assert.deepEqual(fixture.requestFieldSet, row.requestFieldSet)
    assert.deepEqual(fixture.responseFieldSet, row.responseFieldSet)
    assert.equal(fixture.requestFieldSetFingerprint, row.requestFieldSetFingerprint)
    assert.equal(fixture.responseFieldSetFingerprint, row.responseFieldSetFingerprint)
    assert.match(fixture.requestRecordEvidenceId, /^(?:sha256|hmac-sha256):[a-f0-9]{64}$/)
    assert.match(fixture.responseRecordEvidenceId, /^(?:sha256|hmac-sha256):[a-f0-9]{64}$/)
    assert.match(fixture.artifactSafeDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(typeof fixture.artifactPath, 'string')
  }
})

test('matrix authority requires complete execution evidence before any row can enable preview or submit', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-execution-gate-'))
  fs.mkdirSync(path.join(tempRoot, 'artifacts'))
  const rows = listCrownCapabilities()
  for (const row of rows) {
    fs.copyFileSync(path.join(FIXTURES_ROOT, row.fixturePath), path.join(tempRoot, row.fixturePath))
    fs.copyFileSync(path.join(FIXTURES_ROOT, row.artifactPath), path.join(tempRoot, row.artifactPath))
    if (row.watcherEvidencePath) {
      fs.copyFileSync(path.join(FIXTURES_ROOT, row.watcherEvidencePath), path.join(tempRoot, row.watcherEvidencePath))
    }
  }

  const row = rows[0]
  const fixtureFile = path.join(tempRoot, row.fixturePath)
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
  row.previewAllowed = true
  row.submitAllowed = true
  fixture.previewAllowed = true
  fixture.submitAllowed = true
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  row.fixtureSha256 = sha256(fs.readFileSync(fixtureFile))

  const incomplete = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot, rows })
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.errors.join('\n'), /execution-evidence-incomplete/)

  Object.assign(fixture, completeExecutionEvidence(fixture.capability))
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  row.fixtureSha256 = sha256(fs.readFileSync(fixtureFile))
  const mismatchedCapture = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot, rows })
  assert.equal(mismatchedCapture.ok, false)
  assert.match(mismatchedCapture.errors.join('\n'), /execution-capture-id/)

  fixture.capture.id = fixture.captureId
  for (const attempt of fixture.attempts) {
    for (const record of [attempt.preview.request, attempt.preview.response, attempt.submit.request, attempt.submit.response]) {
      record.captureId = fixture.captureId
    }
  }
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  row.fixtureSha256 = sha256(fs.readFileSync(fixtureFile))
  const previewOnlyArtifact = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot, rows })
  assert.equal(previewOnlyArtifact.ok, false)
  assert.match(previewOnlyArtifact.errors.join('\n'), /execution-artifact-record/)

  writeLinkedExecutionArtifact({ fixturesRoot: tempRoot, row, fixture })
  fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
  row.fixtureSha256 = sha256(fs.readFileSync(fixtureFile))
  const linkedArtifact = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot, rows })
  assert.equal(linkedArtifact.ok, true, linkedArtifact.errors.join('\n'))
  assert.deepEqual([linkedArtifact.allowedPreviewCount, linkedArtifact.allowedSubmitCount], [2, 2])

  assert.deepEqual(listCrownCapabilities().filter((candidate) => candidate.previewAllowed || candidate.submitAllowed)
    .map((candidate) => candidate.key), ['prematch|full_time|asian_handicap|main'])
})

for (const fixtureState of ['incomplete', 'hash-drift', 'missing']) {
  test(`runtime authority fails closed for an enabled canonical row with ${fixtureState} fixture evidence`, async () => {
    const runtimeMatrix = await importEnabledRuntimeMatrix(fixtureState)
    const capability = { mode: 'live', period: 'first_half', marketType: 'total', lineVariant: 'main' }
    const verification = runtimeMatrix.verifyCrownCapabilityMatrix()
    assert.equal(verification.ok, false)
    assert.match(verification.errors.join('\n'), {
      incomplete: /execution-evidence-incomplete/,
      'hash-drift': /fixture-sha256/,
      missing: /fixture-missing/,
    }[fixtureState])
    assert.throws(() => runtimeMatrix.listCrownCapabilities(), /crown-capability-matrix-unverified/)
    assert.throws(() => runtimeMatrix.getCrownCapability(capability), /crown-capability-matrix-unverified/)
    assert.throws(
      () => runtimeMatrix.assertCrownCapability(capability, { operation: 'preview' }),
      /crown-capability-matrix-unverified/,
    )
  })
}

test('fixture byte drift and field-set drift invalidate verification', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-fixtures-'))
  for (const fixtureRow of listCrownCapabilities()) {
    fs.copyFileSync(
      path.join(FIXTURES_ROOT, fixtureRow.fixturePath),
      path.join(tempRoot, fixtureRow.fixturePath),
    )
  }
  const row = listCrownCapabilities()[0]
  const file = path.join(tempRoot, row.fixturePath)

  fs.appendFileSync(file, ' ')
  const byteDrift = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot })
  assert.equal(byteDrift.ok, false)
  assert.match(byteDrift.errors.join('\n'), /fixture-sha256/)

  fs.copyFileSync(path.join(FIXTURES_ROOT, row.fixturePath), file)
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  fixture.responseFieldSet.push('unexpected_provider_field')
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
  const fieldDrift = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot })
  assert.equal(fieldDrift.ok, false)
  assert.match(fieldDrift.errors.join('\n'), /response-field-set-fingerprint/)
})

test('artifact provenance drift invalidates an otherwise unchanged fixture', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-provenance-'))
  fs.mkdirSync(path.join(tempRoot, 'artifacts'))
  for (const candidate of listCrownCapabilities()) {
    fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.fixturePath), path.join(tempRoot, candidate.fixturePath))
    fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.artifactPath), path.join(tempRoot, candidate.artifactPath))
    if (candidate.watcherEvidencePath) {
      fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.watcherEvidencePath), path.join(tempRoot, candidate.watcherEvidencePath))
    }
  }
  const row = listCrownCapabilities()[0]
  const fixture = JSON.parse(fs.readFileSync(path.join(tempRoot, row.fixturePath), 'utf8'))
  const artifactFile = path.join(tempRoot, fixture.artifactPath)
  const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'))
  artifact.records[0].status = artifact.records[0].status === 200 ? 201 : 200
  fs.writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`)

  const result = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /artifact-(?:digest|record-evidence)/)
})

test('matrix digest accepts a matching embedded artifact digest and rejects a forged one', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-embedded-digest-'))
  fs.mkdirSync(path.join(tempRoot, 'artifacts'))
  for (const candidate of listCrownCapabilities()) {
    fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.fixturePath), path.join(tempRoot, candidate.fixturePath))
    const source = path.join(FIXTURES_ROOT, candidate.artifactPath)
    const target = path.join(tempRoot, candidate.artifactPath)
    const artifact = JSON.parse(fs.readFileSync(source, 'utf8'))
    if (candidate.executionEvidenceSchema === 'crown-execution-evidence-candidate-v3') {
      fs.writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`)
      fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.watcherEvidencePath), path.join(tempRoot, candidate.watcherEvidencePath))
      continue
    }
    artifact.artifactSafeDigest = fingerprintCrownProtocolArtifact(artifact)
    fs.writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`)
  }
  assert.equal(verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot }).ok, true)

  const row = listCrownCapabilities()[0]
  const target = path.join(tempRoot, row.artifactPath)
  const forged = JSON.parse(fs.readFileSync(target, 'utf8'))
  forged.artifactSafeDigest = `sha256:${'0'.repeat(64)}`
  fs.writeFileSync(target, `${JSON.stringify(forged, null, 2)}\n`)
  const result = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /artifact-embedded-digest/)
})

test('matrix rejects re-digested Submit wire and chronology tampering', async (t) => {
  for (const [name, mutate, expected] of [
    ['wire', (candidate) => { candidate.submitWireEvidence.con = '2' }, /execution-submit-wire/],
    ['chronology', (candidate) => { candidate.chronology.watcherCapturedAt = '2026-07-13T23:58:55.980Z' }, /execution-chronology/],
  ]) {
    await t.test(name, () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `crown-capability-${name}-`))
      fs.mkdirSync(path.join(tempRoot, 'artifacts'))
      const rows = listCrownCapabilities()
      for (const candidate of rows) {
        fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.fixturePath), path.join(tempRoot, candidate.fixturePath))
        fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.artifactPath), path.join(tempRoot, candidate.artifactPath))
        if (candidate.watcherEvidencePath) {
          fs.copyFileSync(path.join(FIXTURES_ROOT, candidate.watcherEvidencePath), path.join(tempRoot, candidate.watcherEvidencePath))
        }
      }
      const row = rows.find((candidate) => candidate.submitAllowed)
      const fixtureFile = path.join(tempRoot, row.fixturePath)
      const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
      const artifactFile = path.join(tempRoot, row.artifactPath)
      const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'))
      mutate(artifact)
      const { candidateDigest: _oldDigest, ...content } = artifact
      artifact.candidateDigest = `sha256:${sha256(JSON.stringify(stableEvidenceValue(content)))}`
      row.artifactSafeDigest = artifact.candidateDigest
      fixture.executionCandidateDigest = artifact.candidateDigest
      fixture.artifactSafeDigest = artifact.candidateDigest
      fs.writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`)
      fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`)
      row.fixtureSha256 = sha256(fs.readFileSync(fixtureFile))

      const result = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot, rows })
      assert.equal(result.ok, false)
      assert.match(result.errors.join('\n'), expected)
    })
  }
})

test('missing fixture field-set metadata is reported as verification failure', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-missing-fields-'))
  for (const fixtureRow of listCrownCapabilities()) {
    fs.copyFileSync(
      path.join(FIXTURES_ROOT, fixtureRow.fixturePath),
      path.join(tempRoot, fixtureRow.fixturePath),
    )
  }
  const row = listCrownCapabilities()[0]
  const file = path.join(tempRoot, row.fixturePath)
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete fixture.responseFieldSet
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)

  let result
  assert.doesNotThrow(() => { result = verifyCrownCapabilityMatrix({ fixturesRoot: tempRoot }) })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /response-field-set/)
})

test('strict parser and mapper can reuse one order-independent field-set contract', () => {
  const row = listCrownCapabilities()[0]
  assert.doesNotThrow(() => assertCrownCapabilityFieldSets(row, {
    requestFieldSet: [...row.requestFieldSet].reverse(),
    responseFieldSet: [...row.responseFieldSet].reverse(),
  }))
  assert.throws(() => assertCrownCapabilityFieldSets(row, {
    requestFieldSet: row.requestFieldSet,
    responseFieldSet: [...row.responseFieldSet, 'changed_field'],
  }), /crown-capability-response-field-set/)
})

test('each verified fixture drives its exact mapper fields and parser output', () => {
  const records = {
    'live|full_time|asian_handicap|main': {
      mode: 'live', event: { ids: { gid: 'fixture-ah' } },
      market: { marketType: 'asian_handicap', period: 'full_time', lineVariant: 'main', lineKey: 'ah:ft:main', ratioField: 'RATIO_RE', handicapRaw: '0 / 0.5' },
      selection: { side: 'home', oddsField: 'IOR_REH' },
    },
    'live|first_half|total|main': {
      mode: 'live', event: { ids: { gid: 'fixture-total' } },
      market: { marketType: 'total', period: 'first_half', lineVariant: 'main', lineKey: 'total:1h:main', ratioField: 'RATIO_HROUO', handicapRaw: '4 / 4.5' },
      selection: { side: 'under', oddsField: 'IOR_HROUH' },
    },
    'prematch|full_time|asian_handicap|main': {
      mode: 'prematch', event: { ids: { gid: 'fixture-prematch-ah' } },
      market: { marketType: 'asian_handicap', period: 'full_time', lineVariant: 'main', lineKey: 'RATIO_R', ratioField: 'RATIO_R', handicapRaw: '0.5 / 1' },
      selection: { side: 'home', oddsField: 'IOR_RH' },
    },
  }

  for (const row of listCrownCapabilities()) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, row.fixturePath), 'utf8'))
    const testCapability = { ...row, previewAllowed: true }
    const mapped = buildStrictCrownPreviewFields(records[row.key], { capability: testCapability })
    const wire = buildStrictCrownPreviewWireFields(mapped.preview, {
      capability: testCapability,
      protocolVersion: 'fixture-version',
      protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
    })
    assert.deepEqual(Object.keys(wire).sort(), fixture.requestFieldSet)
    assert.equal(mapped.capabilityEvidenceId, fixture.evidenceId)

    if (!fixture.redactedResponseBody) {
      assert.equal(fixture.executionEvidenceSchema, 'crown-execution-evidence-candidate-v3')
      continue
    }
    const parsed = parseCrownPreviewResponseStrict(fixture.redactedResponseBody)
    assert.deepEqual(parsed.responseFieldSet, fixture.responseFieldSet)
    assert.equal(parsed.responseFieldSetFingerprint, fixture.responseFieldSetFingerprint)
    assert.equal(parsed.ok, true)
  }
})

test('wire mapping rejects capability defaults and parser rejects response field drift', () => {
  const row = { ...listCrownCapabilities()[0], previewAllowed: true }
  const preview = { gid: '1', gtype: 'FT', wtype: 'ROU', chose_team: 'H' }
  assert.throws(() => buildStrictCrownPreviewWireFields(preview, {
    capability: { ...row, mapperEvidence: { ...row.mapperEvidence, wireDefaults: { ...row.mapperEvidence.wireDefaults, ver: 'forged' } } },
  }), /crown-preview-field-source-unproven:ver/)
  assert.throws(() => buildStrictCrownPreviewWireFields(preview, {
    capability: row, protocolVersion: 'plain-unproved-version',
  }), /crown-preview-field-source-unproven:ver/)

  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, row.fixturePath), 'utf8'))
  assert.throws(() => parseCrownPreviewResponseStrict(
    fixture.redactedResponseBody.replace('</serverresponse>', '<unexpected>x</unexpected></serverresponse>'),
    { expectedFieldSet: row.responseFieldSet },
  ), /crown-preview-response-field-set/)
  assert.throws(() => parseCrownPreviewResponseStrict(
    fixture.redactedResponseBody.replace('</serverresponse>', '<code>error</code></serverresponse>'),
  ), /duplicate-preview-(?:response-field|field:code)/)
  assert.throws(() => parseCrownPreviewResponseStrict(
    fixture.redactedResponseBody.replace('</serverresponse>', '<con>duplicate</con></serverresponse>'),
  ), /duplicate-preview-(?:response-field|field:con)/)
})

test('safe analyzer links event line side and stake irreversibly without broadening the 1/1/0 matrix', () => {
  const records = summarizeCrownProtocol([{
    seq: 1, type: 'request', method: 'POST', url: '/transform.php', classification: { stage: 'preview' },
    postData: { p: 'FT_order_view', gid: 'event-secret', gtype: 'FT', wtype: 'RE', chose_team: 'H', langx: 'zh-cn', odd_f_type: 'H', ver: 'v1', uid: 'secret' },
  }, {
    seq: 1, type: 'response', method: 'POST', url: '/transform.php', status: 200, classification: { stage: 'preview' },
    responseBody: '<serverresponse><code>501</code><spread>-0.25</spread><strong>H</strong></serverresponse>',
  }], {
    linkageContext: { event: 'event-secret', line: '-0.25', side: 'home', stake: '50' },
    linkageKey: Buffer.alloc(32, 7),
  })
  assert.equal(records[0].linkageTag, records[1].linkageTag)
  assert.match(records[0].linkageTag, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(records), /event-secret|-0\.25|"50"/)
  assert.equal(summarizeCrownProtocol([{
    seq: 1, type: 'request', postData: { p: 'FT_order_view', gid: 'event-secret', chose_team: 'H' },
  }, {
    seq: 1, type: 'response', responseBody: '<serverresponse><spread>-0.5</spread></serverresponse>',
  }], {
    linkageContext: { event: 'event-secret', line: '-0.25', side: 'home', stake: '50' },
    linkageKey: Buffer.alloc(32, 7),
  })[0].linkageTag, null)
  const drift = summarizeCrownProtocol([{
    seq: 1, type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=event-secret&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret&extra=drift',
  }, {
    seq: 1, type: 'response', method: 'POST', url: '/transform.php', status: 200,
    responseBody: '<serverresponse><code>501</code><spread>-0.25</spread></serverresponse>',
  }], {
    linkageContext: { event: 'event-secret', line: '-0.25', side: 'home', stake: '50' },
    linkageKey: Buffer.alloc(32, 7),
  })
  assert.equal(drift[0].linkageTag, null)
  assert.equal(drift[1].linkageTag, null)
  const duplicateResponse = summarizeCrownProtocol([{
    seq: 1, type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=event-secret&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret',
  }, {
    seq: 1, type: 'response', method: 'POST', url: '/transform.php', status: 200,
    responseBody: '<serverresponse><code>501</code><code>error</code><spread>-0.25</spread><strong>H</strong></serverresponse>',
  }], {
    linkageContext: { event: 'event-secret', line: '-0.25', side: 'home', stake: '50' },
    linkageKey: Buffer.alloc(32, 7),
  })
  assert.equal(duplicateResponse[1].response.fieldSetValid, false)
  assert.equal(duplicateResponse[1].responseFieldSetFingerprint, null)
  assert.ok(duplicateResponse.every((record) => record.linkageTag === null))
  const conflict = buildCrownProtocolArtifact([{
    seq: 1, type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=event-secret&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret',
  }, {
    seq: 1, type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=other&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret',
  }, {
    seq: 1, type: 'response', method: 'POST', url: '/transform.php', status: 200,
    responseBody: '<serverresponse><code>501</code><spread>-0.25</spread></serverresponse>',
  }], {
    linkageContext: { event: 'event-secret', line: '-0.25', side: 'home', stake: '50' },
    linkageKey: Buffer.alloc(32, 7),
  })
  assert.ok(conflict.records.every((record) => record.linkageTag === null))
  assert.equal(conflict.artifactSafeDigest, fingerprintCrownProtocolArtifact(conflict))
  const matrix = verifyCrownCapabilityMatrix()
  assert.deepEqual([
    matrix.allowedPreviewCount, matrix.allowedSubmitCount, matrix.allowedReconciliationCount,
  ], [1, 1, 0])
})

test('sanitized fixtures contain no credential, session, ticket, or absolute-path material', () => {
  for (const row of listCrownCapabilities()) {
    const text = fs.readFileSync(path.join(FIXTURES_ROOT, row.fixturePath), 'utf8')
    assert.doesNotMatch(text, /\b(?:cookie|uid|token|ticket|password|authorization)\b/i)
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/(?:Users|home|tmp)\//i)
    assert.doesNotMatch(text, /data[\\/]runtime/i)
    assert.equal(JSON.parse(text).evidenceStatus, 'verified')
  }
})

test('analyzer emits no origin, private path, or raw sample body', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-protocol-analyzer-'))
  const publicDir = path.join(root, 'public')
  fs.mkdirSync(publicDir)
  fs.writeFileSync(path.join(publicDir, 'redacted-network.jsonl'), `${JSON.stringify({
    type: 'response', method: 'POST', url: 'https://private.example.test/transform.php',
    status: 200, classification: { stage: 'preview' },
    responseBody: '<serverresponse><code>501</code><secret_field>must-not-leak</secret_field></serverresponse>',
  })}\n`)

  const result = spawnSync(process.execPath, ['scripts/crown-betting-protocol-analyze.mjs', root], {
    cwd: path.resolve('.'), encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const output = [
    fs.readFileSync(path.join(publicDir, 'protocol-summary.json'), 'utf8'),
    fs.readFileSync(path.join(publicDir, 'protocol-map.md'), 'utf8'),
  ].join('\n')
  assert.doesNotMatch(output, /private\.example\.test|must-not-leak/)
  assert.equal(output.includes(root), false)
  assert.doesNotMatch(output, /samplePostData|sampleResponse/)
  assert.match(output, /sha256:[a-f0-9]{64}/)
})

test('analyzer evidence hashes only sanitized structure and drops generic secret fields', () => {
  const record = (secretValue) => ({
    type: 'request', method: 'POST', url: 'https://private.example.test/transform.php',
    classification: { stage: 'preview' }, status: 200,
    postData: {
      p: 'FT_order_view', gtype: 'FT', wtype: 'RE', chose_team: 'H', gid: '123',
      secret_field: secretValue, username: secretValue, uid: secretValue, session_key: secretValue,
    },
  })
  const left = summarizeCrownProtocol([record('first-secret')])[0]
  const right = summarizeCrownProtocol([record('second-secret')])[0]

  assert.equal(left.request.fieldSetValid, false)
  assert.equal(left.requestFieldSetFingerprint, null)
  assert.equal(right.request.fieldSetValid, false)
  assert.equal(right.requestFieldSetFingerprint, null)
  assert.equal(JSON.stringify(left).includes('secret_field'), false)
  assert.equal(JSON.stringify(left).includes('first-secret'), false)
})

test('analyzer field set matches strict parser for nested opening tags', () => {
  const xml = '<serverresponse><code>501</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>0 / 0.5</spread><strong>H</strong><con>1</con><ratio>50</ratio><extra><leaf>x</leaf></extra></serverresponse>'
  const analyzed = summarizeCrownProtocol([{
    type: 'response', method: 'POST', url: '/transform.php', status: 200,
    classification: { stage: 'preview' }, responseBody: xml,
  }])[0]
  const parsed = parseCrownPreviewResponseStrict(xml)
  assert.deepEqual(analyzed.responseFieldSet, parsed.responseFieldSet)
  assert.ok(analyzed.responseFieldSet.includes('extra'))
  assert.ok(analyzed.responseFieldSet.includes('leaf'))
})

test('analyzer artifact omits all body values except evidenced response code', () => {
  const [request, response] = summarizeCrownProtocol([{
    type: 'request', method: 'POST', url: '/transform.php',
    classification: { stage: 'preview' },
    postData: { p: 'REQUEST_ENUM_SENTINEL', gtype: 'TYPE_ENUM_SENTINEL', gid: 'EVENT_SENTINEL' },
  }, {
    type: 'response', method: 'POST', url: '/transform.php', status: 200,
    classification: { stage: 'preview' },
    responseBody: '<serverresponse><code>501</code><gold_gmin>10001</gold_gmin><ioratio>98765</ioratio><spread>VALUE_SENTINEL</spread><strong>SIDE_SENTINEL</strong></serverresponse>',
  }])
  const serialized = JSON.stringify({ request, response })
  for (const value of ['REQUEST_ENUM_SENTINEL', 'TYPE_ENUM_SENTINEL', 'EVENT_SENTINEL', '10001', '98765', 'VALUE_SENTINEL', 'SIDE_SENTINEL']) {
    assert.equal(serialized.includes(value), false, value)
  }
  assert.equal(response.responseCode, '501')
})
