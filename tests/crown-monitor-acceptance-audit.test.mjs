import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

const SCRIPT = path.resolve('scripts/crown-monitor-acceptance-audit.mjs')

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function fixture({ apiSecret = null, snapshotSecret = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-acceptance-audit-'))
  const runtimeDir = path.join(root, 'runtime')
  const dbPath = path.join(root, 'crown.sqlite')
  const output = path.join(root, 'reports', 'acceptance.json')
  const capturedAt = '2026-07-10T04:00:00.000Z'
  const eventKey = 'crown|football|gid=3001'
  const base = {
    schemaVersion: 2,
    provider: 'crown',
    sport: 'football',
    capturedAt,
    event: {
      eventKey,
      providerIds: { gid: '3001', gidm: '9001' },
      league: 'Acceptance League',
      homeTeam: 'Home',
      awayTeam: 'Away',
    },
    market: {
      marketIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R`,
      marketType: 'asian_handicap',
      period: 'full_time',
      lineKey: 'RATIO_R',
    },
    selection: {
      selectionIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R|home`,
      side: 'home',
      oddsRaw: '0.94',
      odds: 0.94,
    },
  }
  const listSnapshot = {
    ...base,
    auditId: 'snapshot:list',
    batchId: 'batch-list',
    pollId: 'poll-list',
    scopeKey: 'scope-list',
    observedAt: capturedAt,
    mode: 'prematch',
    event: { ...base.event, status: 'not_started', startTimeUtc: '2026-07-10T12:00:00.000Z', liveMinute: null },
    source: {
      endpointKey: 'POST https://crown.example/transform.php p=get_game_list',
      urlPattern: 'https://crown.example/transform.php',
      endpointKind: 'get_game_list',
      mapperVersion: 'crown-transform-xml-v2',
    },
    ...(snapshotSecret ? {
      password: snapshotSecret,
      storageState: snapshotSecret,
      storage_state: snapshotSecret,
      ticket: snapshotSecret,
      ticketId: snapshotSecret,
      ticket_id: snapshotSecret,
      rawSession: snapshotSecret,
      raw_session: snapshotSecret,
    } : {}),
  }
  const detailSnapshot = {
    ...base,
    auditId: 'snapshot:detail',
    batchId: 'batch-detail',
    pollId: 'poll-detail',
    scopeKey: 'scope-detail',
    observedAt: capturedAt,
    mode: 'live',
    event: { ...base.event, status: 'live', startTimeUtc: '2026-07-10T03:00:00.000Z', liveMinute: 52 },
    source: {
      endpointKey: 'POST https://crown.example/transform.php p=get_game_more',
      urlPattern: 'https://crown.example/transform.php',
      endpointKind: 'get_game_more',
      mapperVersion: 'crown-transform-xml-v2',
    },
  }
  writeJsonl(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl'), [
    listSnapshot,
    { ...listSnapshot, auditId: 'snapshot:list-duplicate' },
    detailSnapshot,
  ])
  writeJsonl(path.join(runtimeDir, 'crown-odds-changes-v2.jsonl'), [{
    schemaVersion: 2,
    auditId: 'change:odds',
    changeId: 'a'.repeat(64),
    type: 'odds-change',
    batchId: 'batch-detail',
    pollId: 'poll-detail',
    scopeKey: 'scope-detail',
    observedAt: capturedAt,
    eventIdentity: eventKey,
    event: detailSnapshot.event,
    market: detailSnapshot.market,
    selection: detailSnapshot.selection,
    source: detailSnapshot.source,
    old: { selection: { odds: 0.91, oddsRaw: '0.91' } },
    next: { selection: detailSnapshot.selection },
  }])
  writeJsonl(path.join(runtimeDir, 'crown-watch-runtime.jsonl'), [
    { type: 'xml-response', source: 'direct-api', method: 'POST', url: 'https://crown.example/transform.php', endpointKind: 'get_game_list' },
    { type: 'xml-response', source: 'direct-api', method: 'POST', url: 'https://crown.example/transform.php', postData: 'p=get_game_more&gtype=ft&showtype=today&lid=3001&ecid=4001', endpointKind: 'get_game_more' },
    { type: 'xml-response', source: 'direct-api', method: 'GET', url: 'https://crown.example/health' },
  ])

  const handle = openAppDatabase({ dbPath })
  try {
    if (apiSecret) {
      handle.db.prepare(`INSERT INTO betting_history
        (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('history-sensitive', null, eventKey, null, 'preview', 0, '0.94', capturedAt, JSON.stringify({ password: apiSecret }))
    }
  } finally {
    handle.close()
  }
  return { root, runtimeDir, dbPath, output }
}

function runAudit(paths, extra = []) {
  return spawnSync(process.execPath, [SCRIPT,
    '--runtime-dir', paths.runtimeDir,
    '--db-path', paths.dbPath,
    '--output', paths.output,
    ...extra,
  ], { cwd: path.resolve('.'), encoding: 'utf8' })
}

test('writes a portable, hashed, read-only acceptance report and passes safe v2 evidence', () => {
  const paths = fixture()
  const dbBefore = sha256(paths.dbPath)
  const result = runAudit(paths)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(sha256(paths.dbPath), dbBefore, 'the audit must not mutate the source database')
  const report = JSON.parse(fs.readFileSync(paths.output, 'utf8'))
  assert.equal(report.pass, true)
  assert.equal(report.checks.inputsUnchanged, true)
  assert.equal(report.rulesVersion, 'crown-monitor-acceptance-v1')
  assert.ok(report.rules.forbiddenFieldNames.includes('password'))
  assert.ok(report.rules.secretPatterns.every((entry) => entry.id && entry.description))

  for (const input of Object.values(report.inputs)) {
    assert.equal(path.isAbsolute(input.label), false)
    assert.ok(input.bytes > 0)
    assert.match(input.sha256, /^[a-f0-9]{64}$/)
  }
  assert.equal(report.inputs.snapshots.lineCount, 3)
  assert.equal(report.inputs.snapshots.parseErrors, 0)
  assert.equal(report.inputs.changes.lineCount, 1)
  assert.equal(report.inputs.runtime.lineCount, 3)
  assert.equal(report.statistics.records.snapshots, 3)
  assert.equal(report.statistics.records.changes, 1)
  assert.equal(report.statistics.records.runtime, 3)
  assert.deepEqual(report.statistics.requests, {
    total: 3,
    list: 1,
    detail: 1,
    monitor: 2,
    preview: 0,
    submit: 0,
    candidate: 0,
    unknown: 1,
  })
  assert.ok(report.statistics.factEndpointKinds.list > report.statistics.requests.list,
    'snapshot/change endpoint facts must remain separate from actual request evidence')
  assert.equal(report.statistics.identity.gidEventKeyConflicts, 0)
  assert.deepEqual(report.statistics.timeParsing.prematchStartTime, { parsed: 2, total: 2, rate: 1 })
  assert.deepEqual(report.statistics.timeParsing.liveMinute, { parsed: 1, total: 1, rate: 1 })
  assert.equal(report.statistics.changes.detailEventRemoved, 0)

  assert.deepEqual(Object.keys(report.api), ['summary', 'events', 'changes', 'bootstrap'])
  for (const endpoint of Object.values(report.api)) {
    assert.equal(endpoint.status, 200)
    assert.ok(endpoint.bytes > 0)
    assert.match(endpoint.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(endpoint.forbiddenFieldHits, [])
    assert.deepEqual(endpoint.secretPatternHits, [])
  }
  assert.deepEqual(report.security.forbiddenFieldHits, [])
  assert.deepEqual(report.security.secretPatternHits, [])
})

test('fails and records only safe hit metadata when JSONL or API data contains secrets', () => {
  const secret = 'do-not-copy-this-secret-8675309'
  const paths = fixture({ snapshotSecret: secret, apiSecret: secret })
  const result = runAudit(paths)

  assert.equal(result.status, 1)
  const reportText = fs.readFileSync(paths.output, 'utf8')
  assert.equal(reportText.includes(secret), false)
  const report = JSON.parse(reportText)
  assert.equal(report.pass, false)
  assert.ok(report.security.forbiddenFieldHits.some((hit) => hit.field === 'password' && hit.source === 'runtime/crown-odds-snapshots-v2.jsonl'))
  for (const field of ['storageState', 'storage_state', 'ticket', 'ticketId', 'ticket_id', 'rawSession', 'raw_session']) {
    assert.ok(report.rules.forbiddenFieldNames.includes(field), `${field} must be visible in the rules`) 
    assert.ok(report.security.forbiddenFieldHits.some((hit) => hit.field === field), `${field} must be detected`)
  }
  assert.ok(report.api.bootstrap.forbiddenFieldHits.some((hit) => hit.field === 'password'))
  assert.equal(report.checks.sensitiveHitsZero, false)
  assert.equal(report.checks.apiSensitiveHitsZero, false)
})

test('fails closed for missing, duplicate, unknown, or input-overwriting CLI arguments', () => {
  const paths = fixture()
  const cases = [
    ['--runtime-dir', paths.runtimeDir, '--output', paths.output],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', paths.output, '--unknown', 'x'],
    ['--runtime-dir', paths.runtimeDir, '--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', paths.output],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', path.join(paths.runtimeDir, 'report.json')],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', `${paths.dbPath}-wal`],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', `${paths.dbPath}-shm`],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', `${paths.dbPath}-journal`],
    ['--runtime-dir', paths.runtimeDir, '--db-path', paths.dbPath, '--output', `${paths.dbPath.toUpperCase()}-WAL`],
  ]
  for (const argv of cases) {
    const result = spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /acceptance-audit: invalid arguments/)
  }
})
