import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

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
  verifyCrownCapabilityMatrix,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import { buildStrictCrownPreviewFields, buildStrictCrownPreviewWireFields } from '../src/crown/betting/crown-order-field-mapper.mjs'
import { parseCrownPreviewResponseStrict } from '../src/crown/betting/crown-bet-response-parser.mjs'
import { buildCrownProtocolArtifact, summarizeCrownProtocol } from '../scripts/crown-betting-protocol-analyze.mjs'

const FIXTURES_ROOT = path.resolve('data/fixtures/crown/betting-protocol')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('matrix has two evidence-bound preview rows and keeps submit and reconciliation closed', () => {
  const rows = listCrownCapabilities()

  assert.match(CROWN_CAPABILITY_MATRIX_VERSION, /^crown-protocol-capabilities-v2:[a-f0-9]{16}$/)
  assert.equal(computeCrownCapabilityMatrixVersion(rows), CROWN_CAPABILITY_MATRIX_VERSION)
  assert.deepEqual(rows.map((row) => row.key), [
    'live|first_half|total|main',
    'live|full_time|asian_handicap|main',
  ])

  for (const row of rows) {
    assert.equal(row.key, capabilityKey(row))
    assert.equal(row.evidenceStatus, 'verified')
    assert.equal(row.previewAllowed, false)
    assert.equal(row.submitAllowed, false)
    assert.equal(row.reconciliationAllowed, false)
    assert.equal(row.blockedReason, 'crown-preview-field-source-unproven')
    assert.equal(row.submitBlockedReason, 'crown-submit-evidence-missing')
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

test('provenance-evidenced row still blocks preview when a wire value source is unproven', () => {
  const candidate = getCrownCapability({
    mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
  })
  assert.equal(candidate?.evidenceStatus, 'verified')
  assert.throws(() => assertCrownCapability(candidate, { operation: 'preview' }), /crown-preview-field-source-unproven/)
  assert.throws(() => assertCrownCapability(candidate, { operation: 'submit' }), /crown-capability-submit-blocked/)
  assert.throws(() => assertCrownCapability(candidate, { operation: 'reconciliation' }), /crown-capability-reconciliation-blocked/)

  for (const input of [
    { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main' },
    { mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'alternate_a' },
    { mode: 'live', period: 'first_half', marketType: 'asian_handicap', lineVariant: 'main' },
    { mode: 'live', period: 'full_time', marketType: 'total', lineVariant: 'main' },
    { mode: 'live', period: 'full_time', marketType: 'moneyline', lineVariant: 'main' },
  ]) {
    assert.equal(getCrownCapability(input), null)
    assert.throws(() => assertCrownCapability(input, { operation: 'preview' }), /crown-capability-blocked/)
  }
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
    rowCount: 2,
    provisionalCount: 0,
    allowedPreviewCount: 0,
    allowedSubmitCount: 0,
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
    assert.match(fixture.requestRecordEvidenceId, /^sha256:[a-f0-9]{64}$/)
    assert.match(fixture.responseRecordEvidenceId, /^sha256:[a-f0-9]{64}$/)
    assert.match(fixture.artifactSafeDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(typeof fixture.artifactPath, 'string')
  }
})

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
  ), /duplicate-preview-response-field/)
})

test('safe analyzer links event line side and stake irreversibly while capability stays 0/0/0', () => {
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
  ], [0, 0, 0])
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
  const xml = '<serverresponse><code>501</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>0 / 0.5</spread><strong>H</strong><extra><leaf>x</leaf></extra></serverresponse>'
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
