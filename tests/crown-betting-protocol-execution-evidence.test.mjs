import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  analyzeCrownProtocolCapture,
  buildCrownExecutionEvidenceCandidate,
  writeCrownExecutionEvidenceCandidate,
} from '../scripts/crown-betting-protocol-analyze.mjs'
import { createProtocolStore } from '../src/crown/betting-protocol/protocol-store.mjs'
import { verifyCrownCapabilityMatrix } from '../src/crown/betting/crown-capability-matrix.mjs'

const CAPABILITY = Object.freeze({
  mode: 'live',
  period: 'full_time',
  marketType: 'asian_handicap',
  lineVariant: 'main',
})
const HMAC_KEY = Buffer.alloc(32, 17)

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function watcherEvidence(overrides = {}) {
  return {
    schemaVersion: 'crown-watcher-execution-evidence-v1',
    captureId: 'capture',
    capturedAt: '2026-07-14T00:00:02.500Z',
    auditId: `snapshot:${'a'.repeat(64)}`,
    batchId: 'b'.repeat(64),
    gid: 'event-offline',
    mode: 'live',
    eventStatus: 'live',
    period: 'full_time',
    marketType: 'asian_handicap',
    ratioField: 'RATIO_RE',
    line: '-0.5 / 1',
    side: 'home',
    oddsField: 'IOR_REH',
    odds: '0.96',
    suspended: false,
    ...overrides,
  }
}

function writeWatcherEvidence(captureDir, overrides = {}) {
  const evidence = watcherEvidence(overrides)
  fs.writeFileSync(
    path.join(captureDir, 'public', 'watcher-execution-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  return evidence
}

function tupleHmac(domain, values) {
  const chunks = [domain, ...values].map((value) => {
    const bytes = Buffer.from(String(value), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    return Buffer.concat([length, bytes])
  })
  return `hmac-sha256:${createHmac('sha256', HMAC_KEY).update(Buffer.concat(chunks)).digest('hex')}`
}

function xml(fields) {
  return `<serverresponse>${Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `<${key}>${value}</${key}>`).join('')}</serverresponse>`
}

function previewResponse(overrides = {}) {
  return xml({
    aid: 'offline', code: '501', con: '1', currency: 'RMB', currency_value: '1',
    dates: 'offline', dg: 'N', fast_check: 'N', game_sc: '0', game_so: '0',
    gold_gmax: '500', gold_gmin: '10', important: 'N', ioratio: '0.96',
    league_id: 'league', league_name: 'offline', ltype: '3', max_gold: '500',
    maxcredit: '500', mem_sc: '0', mem_so: '0', ms: '0', num_c: '0', num_h: '0',
    pay_type: 'offline', ptype: '', ratio: '50', restsinglecredit: '500',
    spread: '-0.5 / 1', strong: 'H', systime: 'offline', team_id_c: 'away',
    team_id_h: 'home', team_name_c: 'offline', team_name_h: 'offline', times: '0',
    ts: 'offline', username: 'Cafe\u0301 Owner',
    ...overrides,
  })
}

function submitResponse(overrides = {}) {
  return xml({
    ball_act: 'offline', code: '560', concede: '1', date: 'offline', dg_mode: 'N',
    gid: 'event-offline', gold: '50', gtype: 'FT', imp: 'N', ioratio: '0.96',
    isyesterday: 'N', league: 'offline', league_id: 'league', maxcredit: '500',
    mid: 'member-offline', ms: '0', mtype: 'offline', nowcredit: '450', ptype: '',
    ratio: '50', rtype: 'REH', spread: '-0.5 / 1', strong: 'Y', systime: 'offline',
    team_c: 'offline', team_h: 'offline', team_id_c: 'away', team_id_h: 'home',
    ticket_id: 'result-offline', time: 'offline', timestamp: '1', type: 'offline',
    username: 'Cafe\u0301 Owner', wtype: 'RE',
    ...overrides,
  })
}

function baseRecords() {
  const accountName = 'Cafe\u0301 Owner'
  return [{
    seq: 1, type: 'request', at: '2026-07-14T00:00:01.000Z', method: 'POST',
    url: 'https://offline.invalid/transform_nl.php', headers: {},
    postData: 'p=chk_login&username=offline&password=offline',
  }, {
    seq: 1, type: 'response', at: '2026-07-14T00:00:02.000Z', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform_nl.php', headers: {},
    responseBody: xml({ status: '200', username: accountName, mid: 'member-offline', currency: 'RMB', uid: 'uid-offline' }),
  }, {
    seq: 2, type: 'request', at: '2026-07-14T00:00:03.000Z', method: 'POST',
    url: 'https://offline.invalid/transform.php', headers: { cookie: 'beta=2; alpha=1' },
    postData: 'p=FT_order_view&gid=event-offline&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=uid-offline',
  }, {
    seq: 2, type: 'response', at: '2026-07-14T00:00:04.000Z', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php', headers: {}, responseBody: previewResponse(),
  }, {
    seq: 3, type: 'request', at: '2026-07-14T00:00:05.000Z', method: 'POST',
    url: 'https://offline.invalid/transform.php', headers: { cookie: 'alpha=1; beta=2' },
    postData: 'p=FT_bet&uid=uid-offline&ver=v1&langx=zh-cn&gid=event-offline&gtype=FT&wtype=RE&rtype=REH&chose_team=H&golds=50&ioratio=0.96&con=1&ratio=50&autoOdd=Y&timestamp=1783987204990&timestamp2=&isRB=Y&imp=N&ptype=&isYesterday=N&f=&odd_f_type=H',
  }, {
    seq: 3, type: 'response', at: '2026-07-14T00:00:06.000Z', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php', headers: {}, responseBody: submitResponse(),
  }]
}

function createCapture(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-execution-evidence-'))
  const records = baseRecords()
  mutate(records)
  const store = createProtocolStore({ rootDir: root, runId: 'capture' })
  for (const record of records) store.append(record)
  writeWatcherEvidence(store.runDir)
  return store.runDir
}

function build(captureDir, options = {}) {
  return buildCrownExecutionEvidenceCandidate(captureDir, {
    capabilityContext: CAPABILITY,
    hmacKey: HMAC_KEY,
    ...options,
  })
}

function removeCaptureRow(captureDir, kind, index) {
  const file = path.join(captureDir, 'private', `${kind}-network.jsonl`)
  const rows = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/)
  rows.splice(index, 1)
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
}

const ANALYZER_PUBLIC_OUTPUTS = Object.freeze([
  'protocol-evidence.json',
  'protocol-summary.json',
  'protocol-map.md',
  'protocol-catalog.safe.json',
  'static-wire-evidence.safe.json',
  'eight-direction-candidates.safe.json',
])

function assertNoAnalyzerPublicOutputs(captureDir) {
  for (const name of ANALYZER_PUBLIC_OUTPUTS) {
    assert.equal(fs.existsSync(path.join(captureDir, 'public', name)), false, name)
  }
}

function writeHistoricalLegacyManifest(captureDir) {
  fs.writeFileSync(path.join(captureDir, 'public', 'manifest.json'), `${JSON.stringify({
    generatedAt: '2026-07-14T00:00:00.000Z',
    url: 'https://offline.invalid',
    profile: 'data/crown-profile',
    allowOddsClick: false,
    allowStakeFill: false,
    allowRealSubmit: false,
    maxStake: 0,
  })}\n`, 'utf8')
}

test('default protocol store run ids do not collide within one second', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-protocol-store-'))
  const first = createProtocolStore({ rootDir: root })
  const second = createProtocolStore({ rootDir: root })
  assert.notEqual(first.runDir, second.runDir)
})

test('protocol store rejects unsafe public manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-protocol-store-'))
  const store = createProtocolStore({ rootDir: root })
  assert.throws(() => store.writeManifest({
    scenario: 'discover', url: 'https://offline.invalid/private?uid=secret',
  }), /unsafe-crown-protocol-evidence/)
  assert.doesNotThrow(() => store.writeManifest({
    schemaVersion: 'crown-protocol-capture-manifest-v2',
    scenario: 'discover', submitPolicy: 'block-at-route',
  }))
})

test('legacy raw and redacted captures remain analyzable without new recorder ordinals', () => {
  const captureDir = createCapture()
  fs.renameSync(
    path.join(captureDir, 'private', 'redacted-network.jsonl'),
    path.join(captureDir, 'public', 'redacted-network.jsonl'),
  )
  writeHistoricalLegacyManifest(captureDir)
  const result = analyzeCrownProtocolCapture(captureDir, { hmacKey: HMAC_KEY, legacyLayout: true })

  assert.equal(result.recordCount, baseRecords().length)
  assert.equal(result.safeArtifacts, false)
  assert.equal(fs.existsSync(path.join(captureDir, 'public', 'protocol-evidence.json')), true)
})

test('modern analyzer validates the private raw and redacted pair before writing safe artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-capture-'))
  const store = createProtocolStore({ rootDir: root, runId: 'modern' })
  store.append({
    captureRunId: 'modern', direction: 'discover', sessionGeneration: 'generation',
    seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'fetch',
    url: 'https://offline.invalid/list.json', headers: {}, postData: '',
  })
  const redacted = path.join(store.privateDir, 'redacted-network.jsonl')
  const row = JSON.parse(fs.readFileSync(redacted, 'utf8'))
  fs.writeFileSync(redacted, `${JSON.stringify({ ...row, method: 'POST' })}\n`)

  assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
    hmacKey: HMAC_KEY,
  }), /redaction-pair-mismatch/)
  assertNoAnalyzerPublicOutputs(store.runDir)
})

test('modern analyzer removes stale legacy public redacted JSONL on success and failure', async (t) => {
  function createModernRun(runId) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-stale-public-'))
    const store = createProtocolStore({ rootDir: root, runId })
    store.append({
      captureRunId: runId, direction: 'discover', sessionGeneration: 'generation',
      seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'fetch',
      url: 'https://offline.invalid/list.json', headers: {}, postData: '',
    })
    const stale = path.join(store.publicDir, 'redacted-network.jsonl')
    fs.writeFileSync(stale, '{"gid":"stale-dynamic-detail"}\n', 'utf8')
    return { store, stale }
  }

  await t.test('successful rebuild', () => {
    const { store, stale } = createModernRun('modern-stale-success')
    analyzeCrownProtocolCapture(store.runDir, { hmacKey: HMAC_KEY })
    assert.equal(fs.existsSync(stale), false)
  })

  await t.test('failed rebuild', () => {
    const { store, stale } = createModernRun('modern-stale-failure')
    const redacted = path.join(store.privateDir, 'redacted-network.jsonl')
    const row = JSON.parse(fs.readFileSync(redacted, 'utf8'))
    fs.writeFileSync(redacted, `${JSON.stringify({ ...row, method: 'POST' })}\n`, 'utf8')
    assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /redaction-pair-mismatch/)
    assert.equal(fs.existsSync(stale), false)
  })

  for (const [name, mutate, expected] of [[
    'invalid private raw JSONL',
    (store) => fs.writeFileSync(path.join(store.privateDir, 'raw-network.jsonl'), '{', 'utf8'),
    /raw-capture-invalid/,
  ], [
    'invalid private redacted JSONL',
    (store) => fs.writeFileSync(path.join(store.privateDir, 'redacted-network.jsonl'), '{', 'utf8'),
    /redacted-capture-invalid/,
  ], [
    'invalid manifest',
    (store) => fs.writeFileSync(path.join(store.publicDir, 'manifest.json'), '{', 'utf8'),
    /manifest-invalid/,
  ]]) {
    await t.test(name, () => {
      const { store, stale } = createModernRun(`modern-stale-${name.replaceAll(' ', '-')}`)
      mutate(store)
      assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
        hmacKey: HMAC_KEY,
      }), expected)
      assert.equal(fs.existsSync(stale), false)
    })
  }
})

test('modern analyzer requires a complete private pair and never uses the legacy public fallback', async (t) => {
  function createModernRun(runId) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-private-pair-'))
    const store = createProtocolStore({ rootDir: root, runId })
    store.append({
      captureRunId: runId, direction: 'discover', sessionGeneration: 'generation',
      seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'fetch',
      url: 'https://offline.invalid/list.json', headers: {}, postData: '',
    })
    return store
  }

  await t.test('v2 manifest cannot fall back to public redacted JSONL', () => {
    const store = createModernRun('v2-public-fallback')
    store.writeManifest({
      schemaVersion: 'crown-protocol-capture-manifest-v2',
      scenario: 'discover', submitPolicy: 'block-at-route',
    })
    fs.renameSync(
      path.join(store.privateDir, 'redacted-network.jsonl'),
      path.join(store.publicDir, 'redacted-network.jsonl'),
    )

    assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /(?:modern-layout-incomplete|capture-files-unavailable)/)
    assertNoAnalyzerPublicOutputs(store.runDir)
  })

  await t.test('private redacted without raw is a modern signal', () => {
    const store = createModernRun('private-redacted-only')
    fs.rmSync(path.join(store.privateDir, 'raw-network.jsonl'))

    assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /(?:modern-layout-incomplete|capture-files-unavailable)/)
    assertNoAnalyzerPublicOutputs(store.runDir)
  })

  await t.test('stripped private pair without manifest cannot downgrade to legacy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-stripped-pair-'))
    const store = createProtocolStore({ rootDir: root, runId: 'stripped-private-pair' })
    store.append({
      direction: 'discover', seq: 1, type: 'request', method: 'GET', resourceType: 'fetch',
      url: 'https://offline.invalid/list.json', headers: {}, postData: '',
    })

    assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /modern-layout-incomplete/)
    assertNoAnalyzerPublicOutputs(store.runDir)
  })
})

test('modern analyzer rejects incomplete recorder metadata instead of silently treating it as legacy', () => {
  for (const [runId, removeFields] of [
    ['partial-modern', ['eventOrdinal']],
    ['manifest-modern', ['eventOrdinal', 'captureRunId', 'sessionGeneration']],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-layout-'))
    const store = createProtocolStore({ rootDir: root, runId })
    const record = {
      captureRunId: runId, direction: 'discover', sessionGeneration: 'generation',
      seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'fetch',
      url: 'https://offline.invalid/list.json', headers: {}, postData: '',
    }
    for (const field of removeFields) delete record[field]
    store.append(record)
    store.writeManifest({
      schemaVersion: 'crown-protocol-capture-manifest-v2',
      scenario: 'discover', submitPolicy: 'block-at-route',
    })

    assert.throws(() => analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /crown-protocol-catalog:modern-layout-incomplete/)
  }
})

test('builds a public-safe accepted candidate from one exact offline attempt', () => {
  const captureDir = createCapture()
  const candidate = build(captureDir)

  assert.equal(candidate.schemaVersion, 'crown-execution-evidence-candidate-v3')
  assert.match(candidate.captureDigest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(candidate.capability, CAPABILITY)
  assert.equal(candidate.accountBinding, tupleHmac(
    'crown-execution-evidence/account/v1', ['Caf\u00e9 Owner', 'member-offline'],
  ))
  assert.equal(candidate.sessionBinding, tupleHmac(
    'crown-execution-evidence/session/v1', ['uid-offline', 'alpha', '1', 'beta', '2'],
  ))
  assert.equal(candidate.executionIdentityBinding, tupleHmac(
    'crown-execution-evidence/execution/v1',
    [
      'live', 'full_time', 'asian_handicap', 'main', 'event-offline', 'FT', 'RE', 'H',
      '-0.5 / 1', 'preview-strong', 'H', 'submit-strong', 'Y',
    ],
  ))
  assert.equal(candidate.resultReferenceBinding, tupleHmac(
    'crown-execution-evidence/result/v1', ['result-offline', 'member-offline'],
  ))
  assert.equal(candidate.currency, 'CNY')
  assert.deepEqual(candidate.direct.preview, {
    code: '501', minimum: '10', maximum: '500', odds: '0.96', line: '-0.5 / 1',
  })
  assert.deepEqual(candidate.direct.submit, { code: '560', amount: '50', odds: '0.96' })
  assert.deepEqual(candidate.submitWireEvidence, {
    con: '1', conSource: 'preview-response:con', ratio: '50', ratioSource: 'preview-response:ratio',
    f: '', timestamp2: '', timestampSource: 'submit-request:epoch-ms',
  })
  assert.deepEqual(candidate.chronology, {
    maxWatcherToSubmitMs: 60000,
    watcherCapturedAt: '2026-07-14T00:00:02.500Z',
    previewRequestAt: '2026-07-14T00:00:03.000Z',
    previewResponseAt: '2026-07-14T00:00:04.000Z',
    submitTimestampAt: '2026-07-14T00:00:04.990Z',
    submitRequestAt: '2026-07-14T00:00:05.000Z',
    submitResponseAt: '2026-07-14T00:00:06.000Z',
  })
  assert.equal(candidate.outcome, 'accepted')
  assert.equal(candidate.outcomeEvidence, 'direct-response')
  assert.equal(candidate.evidenceIncomplete, false)
  assert.deepEqual(candidate.incompleteReasons, [])
  assert.deepEqual(candidate.stakeQuantum, {
    amountMinor: 50, provenance: 'local-conservative-policy',
  })
  assert.deepEqual(candidate.records.map((record) => record.ordinal), [1, 2, 3, 4])
  assert.ok(candidate.records.every((record) => /^hmac-sha256:[a-f0-9]{64}$/.test(record.recordEvidenceId)))
  assert.deepEqual(candidate.records.map((record) => record.excludedSensitiveFieldCount), [1, 1, 1, 3])
  assert.equal(candidate.records[0].fieldSet.includes('uid'), false)
  assert.equal(candidate.records[3].fieldSet.includes('mid'), false)
  assert.equal(candidate.records[3].fieldSet.includes('ticket_id'), false)

  const serialized = JSON.stringify(candidate)
  for (const forbidden of ['uid-offline', 'alpha', 'beta', 'member-offline', 'result-offline', 'Cafe']) {
    assert.equal(serialized.includes(forbidden), false)
  }
  assert.doesNotMatch(serialized, /\[masked:|https?:\/\/|[A-Za-z]:\\/)
  assert.deepEqual([
    verifyCrownCapabilityMatrix().allowedPreviewCount,
    verifyCrownCapabilityMatrix().allowedSubmitCount,
    verifyCrownCapabilityMatrix().allowedReconciliationCount,
  ], [8, 4, 0])
})

test('derives capability only from content-bound same-capture watcher evidence', () => {
  const captureDir = createCapture()
  const evidence = JSON.parse(fs.readFileSync(
    path.join(captureDir, 'public', 'watcher-execution-evidence.json'), 'utf8',
  ))
  const candidate = buildCrownExecutionEvidenceCandidate(captureDir, {
    capabilityContext: { ...CAPABILITY, period: 'first_half', lineVariant: 'alternate' },
    hmacKey: HMAC_KEY,
  })
  const digest = `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(evidence))).digest('hex')}`

  assert.deepEqual(candidate.capability, CAPABILITY)
  assert.equal(candidate.watcherEvidenceDigest, digest)
  assert.equal(candidate.watcherEvidenceBinding, tupleHmac(
    'crown-execution-evidence/watcher/v1', [
      digest, evidence.auditId, evidence.batchId, evidence.gid, evidence.mode,
      evidence.period, evidence.marketType, evidence.ratioField, evidence.line,
      evidence.side, evidence.oddsField, evidence.odds,
    ],
  ))
  assert.deepEqual(candidate.watcherEvidence, {
    capturedAt: evidence.capturedAt,
    auditId: evidence.auditId,
    batchId: evidence.batchId,
    ratioField: evidence.ratioField,
    oddsField: evidence.oddsField,
  })
})

test('fails closed when independent watcher evidence is missing or does not close the exact row', async (t) => {
  await t.test('missing evidence', () => {
    const captureDir = createCapture()
    fs.rmSync(path.join(captureDir, 'public', 'watcher-execution-evidence.json'))
    assert.throws(() => build(captureDir), /watcher-evidence-unavailable/)
  })
  for (const [name, overrides] of [
    ['ratio field', { ratioField: 'RATIO_HRE' }],
    ['side odds field', { oddsField: 'IOR_REC' }],
    ['line', { line: '-1' }],
    ['odds', { odds: '0.95' }],
    ['gid', { gid: 'other-event' }],
  ]) {
    await t.test(name, () => {
      const captureDir = createCapture()
      writeWatcherEvidence(captureDir, overrides)
      assert.throws(() => build(captureDir), /watcher-evidence-(?:mapping|execution)-drift/)
    })
  }
})

test('fails closed when Submit wire derivation or same-time chronology drifts', async (t) => {
  for (const [name, mutate, pattern] of [
    ['con', (records) => { records[3].responseBody = previewResponse({ con: '2' }) }, /submit-wire-derivation-drift/],
    ['ratio', (records) => { records[3].responseBody = previewResponse({ ratio: '49' }) }, /submit-wire-derivation-drift/],
    ['timestamp format', (records) => { records[4].postData = records[4].postData.replace('timestamp=1783987204990', 'timestamp=1') }, /submit-timestamp-unverified/],
    ['timestamp after request', (records) => { records[4].postData = records[4].postData.replace('timestamp=1783987204990', 'timestamp=1783987206000') }, /execution-chronology-drift/],
  ]) {
    await t.test(name, () => {
      const captureDir = createCapture(mutate)
      assert.throws(() => build(captureDir), pattern)
    })
  }

  for (const [name, capturedAt] of [
    ['watcher too old', '2026-07-13T23:58:00.000Z'],
    ['watcher after Preview', '2026-07-14T00:00:03.500Z'],
  ]) {
    await t.test(name, () => {
      const captureDir = createCapture()
      writeWatcherEvidence(captureDir, { capturedAt })
      assert.throws(() => build(captureDir), /watcher-evidence-chronology/)
    })
  }
})

test('writes only the safe candidate and never the HMAC key', () => {
  const captureDir = createCapture()
  const result = writeCrownExecutionEvidenceCandidate(captureDir, {
    capabilityContext: CAPABILITY,
    hmacKey: HMAC_KEY,
  })
  const output = fs.readFileSync(path.join(captureDir, 'public', 'execution-evidence-candidate.json'), 'utf8')

  assert.equal(result.candidate.outcome, 'accepted')
  assert.equal(output.includes(HMAC_KEY.toString('hex')), false)
  assert.equal(output.includes('result-offline'), false)
  assert.match(result.candidateDigest, /^sha256:[a-f0-9]{64}$/)
})

test('keeps outcome unknown unless code 560 and a direct result are both present', async (t) => {
  await t.test('code 560 without result', () => {
    const captureDir = createCapture((records) => {
      records.at(-1).responseBody = submitResponse({ ticket_id: undefined })
    })
    const candidate = build(captureDir)

    assert.equal(candidate.outcome, 'unknown')
    assert.equal(candidate.resultReferenceBinding, undefined)
    assert.ok(candidate.incompleteReasons.includes('direct-submit-outcome-unproven'))
    assert.ok(candidate.incompleteReasons.includes('accepted-attempt-required'))
  })

  await t.test('non-560 code with direct result', () => {
    const captureDir = createCapture((records) => {
      records.at(-1).responseBody = submitResponse({ code: '555' })
    })
    const candidate = build(captureDir)

    assert.equal(candidate.outcome, 'unknown')
    assert.match(candidate.resultReferenceBinding, /^hmac-sha256:[a-f0-9]{64}$/)
    assert.ok(candidate.incompleteReasons.includes('direct-submit-outcome-unproven'))
    assert.ok(candidate.incompleteReasons.includes('accepted-attempt-required'))
  })
})

test('fails closed when direct submit response identity is missing or drifts', async (t) => {
  const expected = { gid: 'event-offline', gtype: 'FT', wtype: 'RE', rtype: 'REH' }
  for (const [field, value] of Object.entries(expected)) {
    await t.test(`${field} drift`, () => {
      const captureDir = createCapture((records) => {
        records.at(-1).responseBody = submitResponse({ [field]: `${value}-drift` })
      })
      assert.throws(() => build(captureDir), /submit-response-identity-drift/)
    })

    await t.test(`${field} missing`, () => {
      const captureDir = createCapture((records) => {
        records.at(-1).responseBody = submitResponse({ [field]: undefined })
      })
      assert.throws(() => build(captureDir), /submit-response-identity-drift/)
    })
  }
})

test('fails closed when raw and public capture rows are not one-to-one', async (t) => {
  await t.test('raw capture is missing one row', () => {
    const captureDir = createCapture()
    removeCaptureRow(captureDir, 'raw', 2)
    assert.throws(() => build(captureDir), /redaction-pair-missing/)
  })

  await t.test('private redacted capture is missing one row', () => {
    const captureDir = createCapture()
    removeCaptureRow(captureDir, 'redacted', 2)
    assert.throws(() => build(captureDir), /redaction-pair-missing/)
  })
})

test('stores raw and redacted rows privately while preserving the legacy accepted candidate', () => {
  const captureDir = createCapture()
  const privateRedacted = path.join(captureDir, 'private', 'redacted-network.jsonl')
  const publicRedacted = path.join(captureDir, 'public', 'redacted-network.jsonl')

  assert.equal(fs.existsSync(privateRedacted), true)
  assert.equal(fs.existsSync(publicRedacted), false)
  const privateCandidate = build(captureDir)

  fs.renameSync(privateRedacted, publicRedacted)
  writeHistoricalLegacyManifest(captureDir)
  const legacyCandidate = build(captureDir, { legacyLayout: true })
  assert.deepEqual(legacyCandidate, privateCandidate)
  assert.deepEqual([
    verifyCrownCapabilityMatrix().allowedPreviewCount,
    verifyCrownCapabilityMatrix().allowedSubmitCount,
    verifyCrownCapabilityMatrix().allowedReconciliationCount,
  ], [8, 4, 0])
})

test('fails closed when response pairing or request/response order drifts', async (t) => {
  await t.test('submit response sequence does not pair', () => {
    const captureDir = createCapture((records) => {
      records.at(-1).seq = 99
    })
    assert.throws(() => build(captureDir), /record-sequence/)
  })

  await t.test('preview response appears before its request', () => {
    const captureDir = createCapture((records) => {
      ;[records[2], records[3]] = [records[3], records[2]]
    })
    assert.throws(() => build(captureDir), /preview-attempt-unavailable/)
  })

  await t.test('preview response appears after Submit request', () => {
    const captureDir = createCapture((records) => {
      ;[records[3], records[4]] = [records[4], records[3]]
    })
    assert.throws(() => build(captureDir), /preview-attempt-unavailable/)
  })

  await t.test('submit response appears before Submit request', () => {
    const captureDir = createCapture((records) => {
      ;[records[4], records[5]] = [records[5], records[4]]
    })
    assert.throws(() => build(captureDir), /record-sequence/)
  })
})

test('binds endpoint strong values separately and accepts a proven N relationship', () => {
  const captureDir = createCapture((records) => {
    records[2].postData = records[2].postData.replace('chose_team=H', 'chose_team=C')
    records[4].postData = records[4].postData
      .replace('chose_team=H', 'chose_team=C')
      .replace('rtype=REH', 'rtype=REC')
    records.at(-1).responseBody = submitResponse({ rtype: 'REC', strong: 'N' })
  })
  writeWatcherEvidence(captureDir, { side: 'away', oddsField: 'IOR_REC' })
  const candidate = build(captureDir)

  assert.equal(candidate.executionIdentityBinding, tupleHmac(
    'crown-execution-evidence/execution/v1',
    [
      'live', 'full_time', 'asian_handicap', 'main', 'event-offline', 'FT', 'RE', 'C',
      '-0.5 / 1', 'preview-strong', 'H', 'submit-strong', 'N',
    ],
  ))
  assert.equal(candidate.incompleteReasons.includes('endpoint-strong-semantics-unproven'), false)
  assert.equal(Object.hasOwn(candidate.direct.preview, 'strong'), false)
  assert.equal(Object.hasOwn(candidate.direct.submit, 'strong'), false)
})

test('fails closed when endpoint strong domains or their proven relation drift', () => {
  const relationDrift = createCapture((records) => {
    records.at(-1).responseBody = submitResponse({ strong: 'N' })
  })
  assert.throws(() => build(relationDrift), /execution-strong-drift/)

  const invalidDomain = createCapture((records) => {
    records.at(-1).responseBody = submitResponse({ strong: 'C' })
  })
  assert.throws(() => build(invalidDomain), /execution-strong-unverified/)
})

test('fails closed on unsafe pairing, duplicate fields, drift, truncation, and missing bindings', async (t) => {
  const cases = [
    ['redaction pair mismatch', () => {
      const dir = createCapture()
      const file = path.join(dir, 'private', 'redacted-network.jsonl')
      const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
      rows[2].method = 'GET'
      fs.writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`)
      return [dir, {}, /redaction-pair-mismatch/]
    }],
    ['duplicate field', () => [createCapture((records) => {
      records[4].postData += '&gid=other'
    }), {}, /duplicate-field/]],
    ['unknown sensitive field', () => [createCapture((records) => {
      records[4].postData += '&account_token=offline'
    }), {}, /unknown-sensitive-field/]],
    ['extra critical field', () => [createCapture((records) => {
      records[4].postData += '&critical_extra=offline'
    }), {}, /critical-field-set/]],
    ['session drift', () => [createCapture((records) => {
      records[4].headers.cookie = 'alpha=1; beta=3'
    }), {}, /session-binding-drift/]],
    ['session unavailable', () => [createCapture((records) => {
      records[2].headers.cookie = 'alpha=1; alpha=2'
    }), {}, /session-binding-unavailable/]],
    ['account drift', () => [createCapture((records) => {
      records.splice(4, 0, {
        seq: 20, type: 'response', method: 'POST', status: 200,
        url: 'https://offline.invalid/account.php', headers: {},
        responseBody: xml({ username: 'different', mid: 'member-offline' }),
      })
    }), {}, /account-binding-drift/]],
    ['account unavailable', () => [createCapture((records) => {
      records[1].responseBody = xml({ status: '200', mid: 'member-offline', currency: 'RMB' })
    }), {}, /account-binding-unavailable/]],
    ['currency unverified', () => [createCapture((records) => {
      records[1].responseBody = xml({ status: '200', username: 'offline', mid: 'member-offline', currency: 'USD' })
    }), {}, /currency-unverified/]],
    ['truncated response', () => [createCapture((records) => {
      records[3].responseBody += '...[truncated]'
    }), {}, /body-truncated/]],
    ['multiple submit attempts', () => [createCapture((records) => {
      records.splice(5, 0, { ...records[4], seq: 4 })
    }), {}, /submit-attempt-ambiguous/]],
  ]

  for (const [name, setup] of cases) {
    await t.test(name, () => {
      const [captureDir, options, expected] = setup()
      assert.throws(() => build(captureDir, options), expected)
    })
  }
  assert.throws(() => build(createCapture(), { hmacKey: Buffer.alloc(31) }), /hmac-key-too-short/)
})

test('legacy manifest and watcher evidence reject duplicate JSON keys', async (t) => {
  await t.test('historical legacy manifest', () => {
    const captureDir = createCapture()
    fs.renameSync(
      path.join(captureDir, 'private', 'redacted-network.jsonl'),
      path.join(captureDir, 'public', 'redacted-network.jsonl'),
    )
    fs.writeFileSync(path.join(captureDir, 'public', 'manifest.json'), [
      '{',
      '"generatedAt":"2026-07-14T00:00:00.000Z",',
      '"url":"https://offline.invalid",',
      '"profile":"data/crown-profile",',
      '"allowOddsClick":false,',
      '"allowStakeFill":false,',
      '"allowRealSubmit":false,',
      '"\\u0061llowRealSubmit":true,',
      '"maxStake":0',
      '}',
    ].join(''), 'utf8')

    assert.throws(() => analyzeCrownProtocolCapture(captureDir, {
      hmacKey: HMAC_KEY, legacyLayout: true,
    }), /manifest-invalid/)
    assertNoAnalyzerPublicOutputs(captureDir)
  })

  await t.test('watcher execution evidence', () => {
    const captureDir = createCapture()
    const evidence = watcherEvidence()
    const serialized = JSON.stringify(evidence).replace(
      '"suspended":false', '"suspended":false,"\\u0073uspended":true',
    )
    fs.writeFileSync(
      path.join(captureDir, 'public', 'watcher-execution-evidence.json'), serialized, 'utf8',
    )

    assert.throws(() => build(captureDir), /watcher-evidence-unavailable/)
  })
})

test('execution candidate writer clears stale output on every failed rebuild and publishes atomically', () => {
  const captureDir = createCapture()
  const target = path.join(captureDir, 'public', 'execution-evidence-candidate.json')
  const options = { capabilityContext: CAPABILITY, hmacKey: HMAC_KEY }

  writeCrownExecutionEvidenceCandidate(captureDir, options)
  assert.equal(fs.existsSync(target), true)
  assert.throws(() => writeCrownExecutionEvidenceCandidate(captureDir, {
    ...options, hmacKey: Buffer.alloc(31),
  }), /hmac-key-too-short/)
  assert.equal(fs.existsSync(target), false)

  writeCrownExecutionEvidenceCandidate(captureDir, options)
  fs.rmSync(path.join(captureDir, 'public', 'watcher-execution-evidence.json'))
  assert.throws(() => writeCrownExecutionEvidenceCandidate(captureDir, options), /watcher-evidence-unavailable/)
  assert.equal(fs.existsSync(target), false)
  assert.deepEqual(
    fs.readdirSync(path.join(captureDir, 'public')).filter((name) => name.startsWith('.tmp-crown-protocol-')),
    [],
  )
})
