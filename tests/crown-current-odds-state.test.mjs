import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { readCurrentOddsState } from '../src/crown/dashboard/current-odds-state.mjs'

function createStateDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-current-odds-state-'))
  const dbPath = path.join(dir, 'state.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE monitor_scope_state (
      scope_key TEXT PRIMARY KEY,
      last_batch_id TEXT NOT NULL,
      last_captured_at TEXT NOT NULL,
      last_complete_at TEXT NOT NULL,
      event_keys_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE monitor_event_state (
      event_key TEXT PRIMARY KEY,
      match_group_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      missing_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      provider_ids_json TEXT NOT NULL DEFAULT '{}',
      event_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE monitor_selection_state (
      selection_identity TEXT PRIMARY KEY,
      event_key TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `)
  return { db, dbPath }
}

function snapshot({
  eventKey = 'event-active',
  capturedAt,
  oddsRaw,
  selectionIdentity = 'canonical-home',
} = {}) {
  return {
    schemaVersion: 2,
    provider: 'crown',
    sport: 'football',
    mode: 'prematch',
    capturedAt,
    event: {
      eventKey,
      league: 'League A',
      homeTeam: 'Home A',
      awayTeam: 'Away A',
      mode: 'prematch',
      status: 'not_started',
      startTimeRaw: '2026-07-13 20:00:00',
      startTimeUtc: '2026-07-13T12:00:00.000Z',
      timeConfidence: 'high',
    },
    market: {
      marketIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R`,
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '+0.5',
    },
    selection: {
      selectionIdentity,
      side: 'home',
      oddsRaw,
      odds: Number(oddsRaw),
    },
  }
}

test('projects active SQLite state with latest canonical selection and event-only fallback', async () => {
  const { db, dbPath } = createStateDatabase()
  try {
    db.prepare(`INSERT INTO monitor_scope_state
      (scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run('scope-today', 'batch-2', '2026-07-13T12:05:00.000Z', '2026-07-13T12:05:00.000Z', '{"token":"must-not-leak"}')

    const insertEvent = db.prepare(`INSERT INTO monitor_event_state
      (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
    insertEvent.run('event-active', 1, 0, '2026-07-13T12:02:00.000Z',
      '{"gid":"secret-provider-id"}',
      JSON.stringify({ eventKey: 'event-active', league: 'League A', homeTeam: 'Home A', awayTeam: 'Away A', mode: 'prematch' }))
    insertEvent.run('event-only', 1, 0, '2026-07-13T12:03:00.000Z',
      '{"gid":"event-only-provider-id"}',
      JSON.stringify({
        eventKey: 'event-only', league: 'League B', homeTeam: 'Home B', awayTeam: 'Away B', mode: 'prematch',
        startTimeRaw: 'bad-time', startTimeUtc: 'not-canonical', timeWarnings: ['kickoff-unparsed'], cookie: 'must-not-leak',
      }))
    insertEvent.run('event-inactive', 0, 2, '2026-07-13T12:04:00.000Z',
      '{"gid":"inactive-provider-id"}',
      JSON.stringify({ eventKey: 'event-inactive', league: 'Hidden League', token: 'must-not-leak' }))

    const insertSelection = db.prepare(`INSERT INTO monitor_selection_state
      (selection_identity, event_key, captured_at, snapshot_json) VALUES (?, ?, ?, ?)`)
    insertSelection.run('db-old', 'event-active', '2026-07-13T12:01:00.000Z', JSON.stringify(snapshot({
      capturedAt: '2026-07-13T12:01:00.000Z', oddsRaw: '0.91',
    })))
    insertSelection.run('db-new', 'event-active', '2026-07-13T12:02:00.000Z', JSON.stringify({
      ...snapshot({ capturedAt: '2026-07-13T12:02:00.000Z', oddsRaw: '0.97' }),
      authorization: 'must-not-leak',
    }))
    insertSelection.run('inactive-selection', 'event-inactive', '2026-07-13T12:04:00.000Z', JSON.stringify(snapshot({
      eventKey: 'event-inactive', capturedAt: '2026-07-13T12:04:00.000Z', oddsRaw: '9.99',
    })))
  } finally {
    db.close()
  }

  const before = fs.statSync(dbPath)
  const result = await readCurrentOddsState({ dbPath })
  const after = fs.statSync(dbPath)

  assert.deepEqual(result.events.items.map((row) => row.eventKey), ['event-active', 'event-only'])
  const active = result.events.items[0]
  assert.equal(active.selectionCount, 1)
  assert.equal(active.markets[0].selections[0].oddsRaw, '0.97')
  assert.equal(active.startTimeRaw, '2026-07-13 20:00:00')
  assert.equal(active.startTimeUtc, '2026-07-13T12:00:00.000Z')
  assert.equal(active.startTimeBeijing, '2026-07-13 20:00:00')
  assert.equal(active.timeQuality, 'high')

  const eventOnly = result.events.items[1]
  assert.equal(eventOnly.league, 'League B')
  assert.equal(eventOnly.selectionCount, 0)
  assert.equal(eventOnly.marketCount, 0)
  assert.deepEqual(eventOnly.markets, [])
  assert.equal(eventOnly.timeQuality, 'invalid')

  assert.equal(result.summary.source, 'monitor-v2')
  assert.equal(result.summary.readonly, true)
  assert.deepEqual(result.summary.totals, { events: 2, selections: 1, scopes: 1 })
  assert.deepEqual(result.health.lastAuthoritative, {
    scopeKey: 'scope-today',
    batchId: 'batch-2',
    capturedAt: '2026-07-13T12:05:00.000Z',
    completedAt: '2026-07-13T12:05:00.000Z',
  })
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)

  const serialized = JSON.stringify(result)
  for (const secret of [
    'provider_ids_json', 'secret-provider-id', 'event-only-provider-id', 'inactive-provider-id',
    'must-not-leak', 'authorization', 'cookie', 'token', 'snapshot_json', 'event_json', 'Hidden League', '9.99',
  ]) assert.equal(serialized.includes(secret), false, `must not expose ${secret}`)
})

test('returns an empty projection and allowlisted parse warnings for malformed JSON', async () => {
  const empty = createStateDatabase()
  empty.db.close()
  const emptyResult = await readCurrentOddsState({ dbPath: empty.dbPath })
  assert.deepEqual(emptyResult.events.items, [])
  assert.deepEqual(emptyResult.events.warnings, [])
  assert.deepEqual(emptyResult.summary.totals, { events: 0, selections: 0, scopes: 0 })
  assert.equal(emptyResult.health.available, true)
  assert.equal(emptyResult.health.lastAuthoritative, null)

  const malformed = createStateDatabase()
  try {
    malformed.db.prepare(`INSERT INTO monitor_event_state
      (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
      VALUES (?, 1, 0, ?, ?, ?)`)
      .run('broken-event', '2026-07-13T12:00:00.000Z', '{not-json provider secret', '{not-json event secret')
    malformed.db.prepare(`INSERT INTO monitor_selection_state
      (selection_identity, event_key, captured_at, snapshot_json) VALUES (?, ?, ?, ?)`)
      .run('broken-selection', 'broken-event', '2026-07-13T12:00:00.000Z', '{not-json snapshot secret')
  } finally {
    malformed.db.close()
  }

  const result = await readCurrentOddsState({ dbPath: malformed.dbPath })
  assert.deepEqual(result.events.items.map((row) => row.eventKey), ['broken-event'])
  assert.deepEqual(result.events.warnings, [
    'event-json-invalid:broken-event',
    'selection-json-invalid:broken-event',
  ])
  assert.equal(result.events.items[0].selectionCount, 0)
  assert.equal(JSON.stringify(result).includes('not-json'), false)
  assert.equal(JSON.stringify(result).includes('provider secret'), false)
})

test('reuses the cached projection object when database metadata is unchanged without a WAL file', async () => {
  const { db, dbPath } = createStateDatabase()
  db.close()
  assert.equal(fs.existsSync(`${dbPath}-wal`), false)

  const first = await readCurrentOddsState({ dbPath })
  const second = await readCurrentOddsState({ dbPath })

  assert.strictEqual(second, first)
})

test('invalidates the cached projection after committed WAL-only scope, selection, and event changes', async () => {
  const { db: keeper, dbPath } = createStateDatabase()
  keeper.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  keeper.prepare(`INSERT INTO monitor_scope_state
    (scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json)
    VALUES (?, ?, ?, ?, ?)`)
    .run('scope-a', 'batch-1', '2026-07-13T12:00:00.000Z', '2026-07-13T12:00:00.000Z', '[]')
  keeper.prepare(`INSERT INTO monitor_event_state
    (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
    VALUES (?, 1, 0, ?, '{}', ?)`)
    .run('event-active', '2026-07-13T12:00:00.000Z', JSON.stringify(snapshot({
      capturedAt: '2026-07-13T12:00:00.000Z', oddsRaw: '0.90',
    }).event))
  keeper.prepare(`INSERT INTO monitor_selection_state
    (selection_identity, event_key, captured_at, snapshot_json) VALUES (?, ?, ?, ?)`)
    .run('canonical-home', 'event-active', '2026-07-13T12:00:00.000Z', JSON.stringify(snapshot({
      capturedAt: '2026-07-13T12:00:00.000Z', oddsRaw: '0.90',
    })))
  try {
    const initial = await readCurrentOddsState({ dbPath })
    assert.equal(fs.existsSync(`${dbPath}-wal`), true)
    const mainVersion = fs.statSync(dbPath, { bigint: true })

    const scopeWriter = new DatabaseSync(dbPath)
    scopeWriter.prepare(`UPDATE monitor_scope_state
      SET last_batch_id = ?, last_captured_at = ?, last_complete_at = ? WHERE scope_key = ?`)
      .run('batch-2', '2026-07-13T12:01:00.000Z', '2026-07-13T12:01:00.000Z', 'scope-a')
    scopeWriter.close()
    assert.equal(fs.existsSync(`${dbPath}-wal`), true)
    const afterScope = await readCurrentOddsState({ dbPath })
    assert.notStrictEqual(afterScope, initial)
    assert.equal(afterScope.health.lastAuthoritative.batchId, 'batch-2')

    const selectionWriter = new DatabaseSync(dbPath)
    selectionWriter.prepare(`UPDATE monitor_selection_state
      SET captured_at = ?, snapshot_json = ? WHERE selection_identity = ?`)
      .run('2026-07-13T12:02:00.000Z', JSON.stringify(snapshot({
        capturedAt: '2026-07-13T12:02:00.000Z', oddsRaw: '0.97',
      })), 'canonical-home')
    selectionWriter.close()
    assert.equal(fs.existsSync(`${dbPath}-wal`), true)
    const afterSelection = await readCurrentOddsState({ dbPath })
    assert.notStrictEqual(afterSelection, afterScope)
    assert.equal(afterSelection.events.items[0].markets[0].selections[0].oddsRaw, '0.97')

    const eventWriter = new DatabaseSync(dbPath)
    eventWriter.prepare('UPDATE monitor_event_state SET active = 0, last_seen_at = ? WHERE event_key = ?')
      .run('2026-07-13T12:03:00.000Z', 'event-active')
    eventWriter.close()
    assert.equal(fs.existsSync(`${dbPath}-wal`), true)
    const afterEvent = await readCurrentOddsState({ dbPath })
    assert.notStrictEqual(afterEvent, afterSelection)
    assert.deepEqual(afterEvent.events.items, [])

    const unchangedMain = fs.statSync(dbPath, { bigint: true })
    assert.equal(unchangedMain.size, mainVersion.size)
    assert.equal(unchangedMain.mtimeNs, mainVersion.mtimeNs)
  } finally {
    keeper.close()
  }
})

test('preserves the original read failure when best-effort rollback also fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-current-odds-state-error-'))
  const dbPath = path.join(dir, 'incomplete.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
  db.close()

  const originalExec = DatabaseSync.prototype.exec
  DatabaseSync.prototype.exec = function exec(sql) {
    if (sql === 'ROLLBACK') throw new Error('rollback-sentinel')
    return originalExec.call(this, sql)
  }
  try {
    await assert.rejects(readCurrentOddsState({ dbPath }), (error) => {
      assert.match(error.message, /monitor_event_state/)
      assert.doesNotMatch(error.message, /rollback-sentinel/)
      return true
    })
  } finally {
    DatabaseSync.prototype.exec = originalExec
  }
})
