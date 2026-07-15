import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { AutoBettingInboxStore, terminateRuleCardInboxBeforeDelete } from '../src/crown/betting/auto-betting-inbox-store.mjs'

const SIGNAL_ID = 'a'.repeat(64)
const T0 = '2026-07-12T00:00:00.000Z'

function snapshot(overrides = {}) {
  return {
    cardId: 'card-a', name: 'card', enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05',
    targetAmountMinor: 20, currency: 'CNY', amountScale: 0, realEligible: false,
    realEligibilityVersion: 2, migrationReviewRequired: false, version: 7, leagueNames: ['英超'], ...overrides,
  }
}

function insert(handle, { signalId = SIGNAL_ID, card = snapshot(), mode = 'prematch', status = 'pending', nextAttemptAt = T0, leaseOwner = '', leaseExpiresAt = '', createdAt = T0 } = {}) {
  const signal = { signalId, observedAt: T0, evidence: { mode } }
  handle.db.prepare(`INSERT INTO monitor_signals
    (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
    VALUES (?,?,'strategy',1,'ready',?,'2026-07-12T01:00:00.000Z',?)`)
    .run(signalId, `key-${signalId}`, T0, JSON.stringify(signal))
  handle.db.prepare(`INSERT INTO auto_betting_signal_inbox
    (signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,
     status,next_attempt_at,lease_owner,lease_expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?)`)
    .run(signalId, card.cardId, card.version, JSON.stringify(card), mode, card.version, JSON.stringify(card),
      status, nextAttemptAt, leaseOwner, leaseExpiresAt, createdAt, createdAt)
}

function identity(ownerId = 'owner', overrides = {}) {
  return { signalId: SIGNAL_ID, cardId: 'card-a', leaseOwner: ownerId, ...overrides }
}

test('fresh schema uses composite inbox identity and historical card identity has no foreign key', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const pk = handle.db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all()
      .filter((row) => row.pk).map((row) => row.name)
    assert.deepEqual(pk, ['signal_id', 'card_id'])
    assert.equal(handle.db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all()
      .find((row) => row.name === 'card_id').notnull, 1)
    assert.equal(handle.db.prepare('PRAGMA foreign_key_list(auto_betting_signal_inbox)').all()
      .some((row) => row.from === 'card_id'), false)
  } finally { handle.close() }
})

test('legacy nullable card rows migrate safely to terminal historical composite rows', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-inbox-legacy-')), 'app.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE auto_betting_signal_inbox (
    signal_id TEXT PRIMARY KEY, mode TEXT NOT NULL, settings_version INTEGER NOT NULL,
    settings_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '', lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT '', batch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    card_id TEXT, card_version INTEGER, card_snapshot_json TEXT);
    INSERT INTO auto_betting_signal_inbox VALUES
    ('legacy-signal','prematch',7,'{"mode":"prematch","version":7}','processing','',1,'','legacy-owner','2099-01-01T00:00:00.000Z',NULL,'${T0}','${T0}',NULL,NULL,NULL)`)
  legacy.close()
  const handle = openAppDatabase({ dbPath })
  try {
    const row = { ...handle.db.prepare(`SELECT card_id,card_version,status,skip_reason,lease_owner
      FROM auto_betting_signal_inbox WHERE signal_id='legacy-signal'`).get() }
    assert.deepEqual(row, {
      card_id: 'legacy-fixed:prematch:1', card_version: 7, status: 'skipped',
      skip_reason: 'rule-deleted', lease_owner: '',
    })
    assert.equal(handle.db.prepare('PRAGMA foreign_key_list(auto_betting_signal_inbox)').all()
      .some((item) => item.from === 'card_id'), false)
  } finally { handle.close() }
})

test('pre-card inbox schema with no card columns upgrades before card indexes and triggers are created', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-inbox-pre-card-')), 'app.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE auto_betting_signal_inbox (
    signal_id TEXT PRIMARY KEY, mode TEXT NOT NULL, settings_version INTEGER NOT NULL,
    settings_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '', lease_owner TEXT NOT NULL DEFAULT '',
    lease_expires_at TEXT NOT NULL DEFAULT '', batch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO auto_betting_signal_inbox VALUES
    ('pre-card','live',4,'{"mode":"live","version":4}','pending','',0,'${T0}','','',NULL,'${T0}','${T0}')`)
  legacy.close()
  const handle = openAppDatabase({ dbPath })
  try {
    const columns = handle.db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all()
    assert.deepEqual(columns.filter((row) => row.pk).map((row) => row.name), ['signal_id', 'card_id'])
    assert.deepEqual({ ...handle.db.prepare(`SELECT card_id,status,skip_reason
      FROM auto_betting_signal_inbox WHERE signal_id='pre-card'`).get() }, {
      card_id: 'legacy-fixed:live:1', status: 'skipped', skip_reason: 'rule-deleted',
    })
  } finally { handle.close() }
})

test('partial composite schema rebuilds all card columns NOT NULL without synthetic identity collisions', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-inbox-partial-card-')), 'app.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE auto_betting_signal_inbox (
    signal_id TEXT NOT NULL, card_id TEXT, card_version INTEGER, card_snapshot_json TEXT,
    mode TEXT NOT NULL, settings_version INTEGER NOT NULL, settings_snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL, skip_reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT '', lease_owner TEXT NOT NULL DEFAULT '', lease_expires_at TEXT NOT NULL DEFAULT '',
    batch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(signal_id,card_id));
    INSERT INTO auto_betting_signal_inbox VALUES
      ('same','legacy-fixed:prematch:2','1','{"cardId":"legacy-fixed:prematch:2","version":1}',
       'prematch',1,'{}','skipped','rule-deleted',0,'','','',NULL,'${T0}','${T0}'),
      ('same',NULL,NULL,NULL,'prematch',2,'{"mode":"prematch","version":2}',
       'pending','',0,'${T0}','','',NULL,'${T0}','${T0}')`)
  legacy.close()
  const handle = openAppDatabase({ dbPath })
  try {
    const cardColumns = handle.db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all()
      .filter((row) => ['card_id', 'card_version', 'card_snapshot_json'].includes(row.name))
    assert.equal(cardColumns.every((row) => row.notnull === 1), true)
    const rows = handle.db.prepare("SELECT card_id,status FROM auto_betting_signal_inbox WHERE signal_id='same' ORDER BY card_id").all()
    assert.equal(rows.length, 2)
    assert.equal(new Set(rows.map((row) => row.card_id)).size, 2)
    assert.equal(rows.some((row) => row.card_id === 'legacy-fixed:prematch:2' && row.status === 'skipped'), true)
    assert.equal(rows.some((row) => row.card_id === 'legacy-fixed:prematch:2:1' && row.status === 'skipped'), true)
  } finally { handle.close() }
})

test('delete seam terminalizes only unbatched pending retry and processing rows for one card', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const ids = ['a', 'b', 'c'].map((value) => value.repeat(64))
    insert(handle, { signalId: ids[0], status: 'pending' })
    insert(handle, { signalId: ids[1], status: 'retry' })
    insert(handle, { signalId: ids[2], status: 'processing', leaseOwner: 'worker', leaseExpiresAt: '2099-01-01T00:00:00.000Z' })
    assert.equal(terminateRuleCardInboxBeforeDelete(handle.db, { cardId: 'card-a', now: T0 }), 3)
    assert.deepEqual(handle.db.prepare(`SELECT status,skip_reason,lease_owner,lease_expires_at
      FROM auto_betting_signal_inbox ORDER BY signal_id`).all().map((row) => ({ ...row })), ids.map(() => ({
      status: 'skipped', skip_reason: 'rule-deleted', lease_owner: '', lease_expires_at: '',
    })))
    assert.equal(terminateRuleCardInboxBeforeDelete(handle.db, { cardId: 'card-a', now: T0 }), 0)
  } finally { handle.close() }
})

test('store constructor does not mutate connection pragmas', () => {
  assert.doesNotThrow(() => new AutoBettingInboxStore({
    db: { prepare() {}, exec(sql) { throw new Error(`unexpected-connection-mutation:${sql}`) } },
    now: () => T0,
    ownerId: 'owner',
  }))
})

test('two owners cannot claim the same due inbox item', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    insert(handle)
    const first = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner-a' })
    const second = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner-b' })
    assert.equal(first.claimDue({ limit: 10, leaseSeconds: 30 }).length, 1)
    assert.equal(second.claimDue({ limit: 10, leaseSeconds: 30 }).length, 0)
  } finally { handle.close() }
})

test('two independent database connections claim a due item exactly once', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-inbox-claim-')), 'app.sqlite')
  const firstHandle = openAppDatabase({ dbPath })
  const secondHandle = openAppDatabase({ dbPath })
  try {
    insert(firstHandle)
    const first = new AutoBettingInboxStore({ db: firstHandle.db, now: () => T0, ownerId: 'owner-a' })
    const second = new AutoBettingInboxStore({ db: secondHandle.db, now: () => T0, ownerId: 'owner-b' })
    const claims = [first.claimDue({ limit: 1, leaseSeconds: 30 }), second.claimDue({ limit: 1, leaseSeconds: 30 })]
    assert.equal(claims.flat().length, 1)
    assert.equal(claims.flat()[0].signalId, SIGNAL_ID)
  } finally { secondHandle.close(); firstHandle.close() }
})

test('two concurrent database connections claim a due item exactly once', async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-inbox-concurrent-')), 'app.sqlite')
  const setup = openAppDatabase({ dbPath })
  insert(setup)
  setup.close()
  const appDbUrl = pathToFileURL(path.resolve('src/crown/app/app-db.mjs')).href
  const storeUrl = pathToFileURL(path.resolve('src/crown/betting/auto-betting-inbox-store.mjs')).href
  const source = `
    import { parentPort, workerData } from 'node:worker_threads'
    const [{ openAppDatabase }, { AutoBettingInboxStore }] = await Promise.all([
      import(workerData.appDbUrl), import(workerData.storeUrl),
    ])
    const handle = openAppDatabase({ dbPath: workerData.dbPath })
    handle.db.exec('PRAGMA busy_timeout = 5000')
    parentPort.postMessage({ type: 'ready' })
    parentPort.once('message', () => {
      try {
        const store = new AutoBettingInboxStore({ db: handle.db, now: () => workerData.now, ownerId: workerData.ownerId })
        parentPort.postMessage({ type: 'result', count: store.claimDue({ limit: 1, leaseSeconds: 30 }).length })
      } finally { handle.close() }
    })
  `
  const connection = (ownerId) => {
    const worker = new Worker(source, { eval: true, type: 'module', workerData: { appDbUrl, storeUrl, dbPath, now: T0, ownerId } })
    const ready = new Promise((resolve, reject) => {
      const onMessage = (message) => { if (message?.type === 'ready') { worker.off('error', reject); resolve() } }
      worker.on('message', onMessage)
      worker.once('error', reject)
    })
    const result = new Promise((resolve, reject) => {
      worker.on('message', (message) => { if (message?.type === 'result') resolve(message.count) })
      worker.once('error', reject)
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`claim-worker-exit:${code}`)) })
    })
    return { worker, ready, result }
  }
  const first = connection('owner-a')
  await first.ready
  const second = connection('owner-b')
  await second.ready
  first.worker.postMessage('go')
  second.worker.postMessage('go')
  const counts = await Promise.all([first.result, second.result])
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1)
})

test('claim order is deterministic by created_at then signal_id', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const ids = { early: 'c'.repeat(64), low: 'a'.repeat(64), high: 'b'.repeat(64) }
    insert(handle, { signalId: ids.high, createdAt: '2026-07-12T00:00:01.000Z' })
    insert(handle, { signalId: ids.low, createdAt: '2026-07-12T00:00:01.000Z' })
    insert(handle, { signalId: ids.early, createdAt: T0 })
    const store = new AutoBettingInboxStore({ db: handle.db, now: () => '2026-07-12T00:00:02.000Z', ownerId: 'owner' })
    assert.deepEqual(store.claimDue({ limit: 3, leaseSeconds: 30 }).map((item) => item.signalId), [ids.early, ids.low, ids.high])
  } finally { handle.close() }
})

test('claim sweep terminalizes expired Signals before browser Preview', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    insert(handle)
    const store = new AutoBettingInboxStore({
      db: handle.db,
      now: () => '2026-07-12T01:00:00.001Z',
      ownerId: 'owner',
    })
    assert.deepEqual(store.claimDue({ limit: 1, leaseSeconds: 30 }), [])
    assert.deepEqual({ ...handle.db.prepare(`
      SELECT status,skip_reason,lease_owner,lease_expires_at
      FROM auto_betting_signal_inbox
    `).get() }, {
      status: 'skipped', skip_reason: 'signal-expired', lease_owner: '', lease_expires_at: '',
    })
  } finally { handle.close() }
})

test('expired lease can be taken over and stale owner cannot mutate it', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    insert(handle, { status: 'processing', leaseOwner: 'owner-a', leaseExpiresAt: '2026-07-11T23:59:59.000Z' })
    const stale = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner-a' })
    const current = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner-b' })
    assert.equal(current.claimDue({ limit: 1, leaseSeconds: 30 })[0].signalId, SIGNAL_ID)
    assert.throws(() => stale.complete(identity('owner-a', { batchId: 'batch-stale' })), /inbox-lease-stale/)
    current.complete(identity('owner-b', { batchId: 'batch-current' }))
    assert.deepEqual({ ...handle.db.prepare('SELECT status,batch_id,lease_owner FROM auto_betting_signal_inbox').get() }, {
      status: 'batch_created', batch_id: 'batch-current', lease_owner: '',
    })
  } finally { handle.close() }
})

test('current owner can renew a processing lease during slow browser work', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  let now = T0
  try {
    insert(handle)
    const current = new AutoBettingInboxStore({ db: handle.db, now: () => now, ownerId: 'owner-a' })
    const other = new AutoBettingInboxStore({ db: handle.db, now: () => now, ownerId: 'owner-b' })
    assert.equal(current.claimDue({ limit: 1, leaseSeconds: 30 }).length, 1)
    now = '2026-07-12T00:00:20.000Z'
    assert.deepEqual(current.renew(identity('owner-a', { leaseSeconds: 30 })), {
      ownerId: 'owner-a', expiresAt: '2026-07-12T00:00:50.000Z',
    })
    assert.equal(handle.db.prepare('SELECT lease_expires_at FROM auto_betting_signal_inbox').get().lease_expires_at,
      '2026-07-12T00:00:50.000Z')
    now = '2026-07-12T00:00:31.000Z'
    assert.deepEqual(other.claimDue({ limit: 1, leaseSeconds: 30 }), [])
    now = '2026-07-12T00:00:51.000Z'
    assert.equal(other.claimDue({ limit: 1, leaseSeconds: 30 }).length, 1)
  } finally { handle.close() }
})

test('retry uses 5/15/45 seconds and fourth failure dead-letters', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  let now = T0
  try {
    insert(handle)
    const store = new AutoBettingInboxStore({ db: handle.db, now: () => now, ownerId: 'owner' })
    for (const [index, expected] of [
      '2026-07-12T00:00:05.000Z', '2026-07-12T00:00:20.000Z', '2026-07-12T00:01:05.000Z',
    ].entries()) {
      assert.equal(store.claimDue({ limit: 1, leaseSeconds: 30 }).length, 1)
      store.retry(identity('owner', { reason: 'transient-db' }))
      const row = { ...handle.db.prepare('SELECT status,attempts,next_attempt_at,skip_reason FROM auto_betting_signal_inbox').get() }
      assert.deepEqual(row, { status: 'retry', attempts: index + 1, next_attempt_at: expected, skip_reason: 'transient-db' })
      now = expected
    }
    assert.equal(store.claimDue({ limit: 1, leaseSeconds: 30 }).length, 1)
    store.retry(identity('owner', { reason: 'transient-db' }))
    assert.deepEqual({ ...handle.db.prepare('SELECT status,attempts,next_attempt_at,lease_owner FROM auto_betting_signal_inbox').get() }, {
      status: 'dead_letter', attempts: 4, next_attempt_at: '', lease_owner: '',
    })
  } finally { handle.close() }
})

test('invalid snapshot identity is dead-lettered instead of returned forever', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    insert(handle, { mode: 'live' })
    handle.db.exec('DROP TRIGGER auto_betting_signal_inbox_card_immutable')
    handle.db.prepare("UPDATE auto_betting_signal_inbox SET card_snapshot_json='{}'").run()
    const store = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner' })
    assert.deepEqual(store.claimDue({ limit: 1, leaseSeconds: 30 }), [])
    assert.deepEqual({ ...handle.db.prepare('SELECT status,skip_reason FROM auto_betting_signal_inbox').get() }, {
      status: 'dead_letter', skip_reason: 'signal-invalid',
    })
  } finally { handle.close() }
})

test('terminal methods require a live current-owner lease and stable allowlisted values', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    insert(handle)
    const store = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner' })
    assert.throws(() => store.complete(identity('owner', { batchId: '' })), /batchId/)
    assert.throws(() => store.skip(identity('owner', { reason: 'raw provider failure with cookie' })), /skip-reason/)
    assert.throws(() => store.retry(identity('owner', { reason: 'raw provider failure with cookie' })), /error-code/)
    assert.throws(() => store.skip(identity('owner', { reason: 'rule-deleted' })), /inbox-lease-stale/)
  } finally { handle.close() }
})

for (const [name, mutate] of [
  ['complete', (store, signalId) => store.complete(identity('owner', { signalId, batchId: 'batch-immutable' }))],
  ['retry', (store, signalId) => store.retry(identity('owner', { signalId, reason: 'transient-db' }))],
  ['skip', (store, signalId) => store.skip(identity('owner', { signalId, reason: 'signal-invalid' }))],
]) {
  test(`claim and ${name} preserve immutable mode/version/snapshot bytes`, () => {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    try {
      insert(handle)
      const immutable = () => ({ ...handle.db.prepare(
        'SELECT card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json FROM auto_betting_signal_inbox WHERE signal_id=?',
      ).get(SIGNAL_ID) })
      const before = immutable()
      const store = new AutoBettingInboxStore({ db: handle.db, now: () => T0, ownerId: 'owner' })
      assert.equal(store.claimDue({ limit: 1, leaseSeconds: 30 }).length, 1)
      assert.deepEqual(immutable(), before)
      mutate(store, SIGNAL_ID)
      assert.deepEqual(immutable(), before)
    } finally { handle.close() }
  })
}
