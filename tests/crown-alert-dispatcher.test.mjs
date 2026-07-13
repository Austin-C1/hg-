import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AlertDispatcher } from '../src/crown/monitor/alert-dispatcher.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'

function signal({
  changeId = 'a'.repeat(64),
  observedAt = '2026-07-10T01:00:00.000Z',
  channels = ['telegram'],
  gid = '3001',
} = {}) {
  const eventIdentity = `crown|football|gid=${gid}`
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_R`
  const selectionIdentity = `${marketIdentity}|home`
  const rule = {
    id: 'legacy-monitor-handicap-odds-delta',
    type: 'odds_delta',
    version: 1,
    enabled: true,
    conditions: { minDelta: 0.03 },
    cooldownSeconds: 60,
    bettingRuleId: 'bet-rule-1',
  }
  const change = {
    schemaVersion: 2,
    changeId,
    type: 'odds-change',
    observedAt,
    eventIdentity,
    marketIdentity,
    selectionIdentity,
  }
  const decision = {
    matched: true,
    strategyId: rule.id,
    strategyVersion: 1,
    trigger: { type: 'odds-change', direction: 'up', delta: 0.05, threshold: 0.03, observedAt },
    target: { eventIdentity, marketIdentity, selectionIdentity, side: 'home' },
    evidence: {
      changeId,
      oldOdds: 0.94,
      nextOdds: 0.99,
      homeTeam: 'Home',
      awayTeam: 'Away',
      handicapRaw: '+0/0.5',
      oldOddsRaw: '0.940',
      nextOddsRaw: '0.990',
      mode: 'prematch',
      league: 'Test League',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicap: 0.25,
      minutesBeforeKickoff: 120,
      livePhase: null,
      liveMinute: null,
      source: { endpointKind: 'get_game_more', confidence: 'high' },
    },
    bettingRuleId: 'bet-rule-1',
    cooldownSeconds: 60,
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: ['clock-estimated'] },
  }
  return { ...createSignal({ rule, change, decision }), channels }
}

function dbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dispatcher-')), 'state.sqlite')
}

function delivery(store, signalId, channel = 'telegram') {
  return store.db.prepare(`
    SELECT status, attempts, next_attempt_at AS nextAttemptAt, last_error_code AS errorCode
    FROM monitor_deliveries WHERE signal_id = ? AND channel = ?
  `).get(signalId, channel)
}

test('failed delivery retries after 5 seconds and a later success records both attempts', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal()
  store.insertSignal(input)
  let sends = 0
  const dispatcher = new AlertDispatcher({
    store,
    senders: { telegram: async () => { sends += 1; if (sends === 1) throw Object.assign(new Error('network secret'), { code: 'network-error' }) } },
    sendTimeoutMs: 50,
  })

  await dispatcher.tick(input.observedAt)
  assert.deepEqual({ ...delivery(store, input.signalId) }, {
    status: 'retry', attempts: 1, nextAttemptAt: '2026-07-10T01:00:05.000Z', errorCode: 'network-error',
  })
  assert.equal((await dispatcher.tick('2026-07-10T01:00:04.999Z')).claimed, 0)
  await dispatcher.tick('2026-07-10T01:00:05.000Z')
  assert.deepEqual({ ...delivery(store, input.signalId) }, {
    status: 'sent', attempts: 2, nextAttemptAt: '2026-07-10T01:00:05.000Z', errorCode: '',
  })
  store.close()
})

test('sender timeout does not block forever and becomes a retry without leaking messages', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal()
  store.insertSignal(input)
  const dispatcher = new AlertDispatcher({
    store,
    senders: { telegram: () => new Promise(() => {}) },
    sendTimeoutMs: 15,
  })
  const started = Date.now()
  await dispatcher.tick(input.observedAt)
  assert.ok(Date.now() - started < 250)
  assert.deepEqual({ ...delivery(store, input.signalId) }, {
    status: 'retry', attempts: 1, nextAttemptAt: '2026-07-10T01:00:05.000Z', errorCode: 'delivery-timeout',
  })
  await dispatcher.stop()
  store.close()
})

test('retry schedule is 5/15/45 seconds and attempt four dead-letters', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal()
  store.insertSignal(input)
  const dispatcher = new AlertDispatcher({ store, senders: { telegram: async () => { throw new Error('do not persist me') } } })
  const times = [
    input.observedAt,
    '2026-07-10T01:00:05.000Z',
    '2026-07-10T01:00:20.000Z',
    '2026-07-10T01:01:05.000Z',
  ]
  const expected = [
    ['retry', 1, '2026-07-10T01:00:05.000Z'],
    ['retry', 2, '2026-07-10T01:00:20.000Z'],
    ['retry', 3, '2026-07-10T01:01:05.000Z'],
    ['dead-letter', 4, '2026-07-10T01:01:05.000Z'],
  ]
  for (let index = 0; index < times.length; index += 1) {
    await dispatcher.tick(times[index])
    const row = delivery(store, input.signalId)
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt], expected[index])
    assert.equal(row.errorCode, 'delivery-failed')
  }
  store.close()
})

test('missing sender and permanent configuration failures use stable redacted dead-letter codes', async () => {
  for (const [senders, code, expectedAttempts] of [
    [{}, 'channel-not-configured', 1],
    [{ telegram: async () => ({ sent: false, reason: 'missing-config', permanent: true }) }, 'missing-config', 1],
    [{ telegram: async () => { throw Object.assign(new Error('token=123:secret'), { code: 'token=123:secret', permanent: true }) } }, 'delivery-failed', 1],
  ]) {
    const store = openMonitorStateStore({ dbPath: ':memory:' })
    const input = signal()
    store.insertSignal(input)
    await new AlertDispatcher({ store, senders }).tick(input.observedAt)
    const row = delivery(store, input.signalId)
    assert.equal(row.status, 'dead-letter')
    assert.equal(row.attempts, expectedAttempts)
    assert.equal(row.errorCode, code)
    assert.doesNotMatch(JSON.stringify(row), /123:secret|token=/i)
    store.close()
  }
})

test('each tick is bounded and overlapping ticks claim a delivery only once', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  for (let index = 0; index < 5; index += 1) {
    store.insertSignal(signal({ changeId: String(index).repeat(64), gid: String(3001 + index) }))
  }
  let sends = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const dispatcher = new AlertDispatcher({
    store,
    batchSize: 2,
    sendTimeoutMs: 100,
    senders: { telegram: async () => { sends += 1; await gate } },
  })
  const a = dispatcher.tick('2026-07-10T01:00:00.000Z')
  const b = dispatcher.tick('2026-07-10T01:00:00.000Z')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(sends, 2)
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(first.claimed, 2)
  assert.equal(second.claimed, 2)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM monitor_deliveries WHERE status = 'pending'").get().count, 3)
  store.close()
})

test('105 Signal deliveries drain in bounded batches exactly once without stranded work', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const total = 105
  for (let index = 0; index < total; index += 1) {
    store.insertSignal(signal({
      changeId: index.toString(16).padStart(64, '0'),
      gid: String(10_000 + index),
    }))
  }
  const sends = new Map()
  const dispatcher = new AlertDispatcher({
    store,
    batchSize: 20,
    senders: {
      telegram: async (input) => {
        sends.set(input.signalId, (sends.get(input.signalId) ?? 0) + 1)
        return { sent: true }
      },
    },
  })

  const claimedByTick = []
  while (true) {
    const result = await dispatcher.tick('2026-07-10T01:00:00.000Z')
    if (result.claimed === 0) break
    claimedByTick.push(result.claimed)
  }

  assert.deepEqual(claimedByTick, [20, 20, 20, 20, 20, 5])
  assert.equal(sends.size, total)
  assert.equal([...sends.values()].every((count) => count === 1), true)
  assert.deepEqual(store.db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM monitor_deliveries
    GROUP BY status
    ORDER BY status
  `).all().map((row) => ({ ...row })), [{ status: 'sent', count: total }])
  assert.equal(store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM monitor_deliveries
    WHERE status IN ('pending', 'retry', 'dispatching')
  `).get().count, 0)
  store.close()
})

test('channel failures are isolated and two dispatcher instances cannot claim the same row', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal({ channels: ['console', 'telegram'] })
  store.insertSignal(input)
  const dispatcher = new AlertDispatcher({
    store,
    senders: {
      console: async () => ({ sent: true }),
      telegram: async () => { throw Object.assign(new Error('offline'), { code: 'network-error' }) },
    },
  })
  const result = await dispatcher.tick(input.observedAt)
  assert.deepEqual(result, { claimed: 2, sent: 1, retried: 1, deadLettered: 0, failedCompletions: 0 })
  assert.equal(delivery(store, input.signalId, 'console').status, 'sent')
  assert.equal(delivery(store, input.signalId, 'telegram').status, 'retry')
  store.close()

  const claimStore = openMonitorStateStore({ dbPath: ':memory:' })
  const another = signal({ changeId: 'c'.repeat(64), gid: '3002', observedAt: '2026-07-10T01:02:00.000Z' })
  claimStore.insertSignal(another)
  let sends = 0
  const options = { store: claimStore, batchSize: 1, senders: { telegram: async () => { sends += 1 } } }
  const [a, b] = await Promise.all([
    new AlertDispatcher(options).tick(another.observedAt),
    new AlertDispatcher(options).tick(another.observedAt),
  ])
  assert.equal(a.claimed + b.claimed, 1)
  assert.equal(sends, 1)
  claimStore.close()
})

test('a retry survives restart and an expired dispatch lease is recoverable', async () => {
  const file = dbPath()
  const input = signal()
  let store = openMonitorStateStore({ dbPath: file })
  store.insertSignal(input)
  await new AlertDispatcher({ store, senders: { telegram: async () => { throw new Error('offline') } } }).tick(input.observedAt)
  store.close()

  store = openMonitorStateStore({ dbPath: file })
  let sends = 0
  await new AlertDispatcher({ store, senders: { telegram: async () => { sends += 1 } } }).tick('2026-07-10T01:00:05.000Z')
  assert.equal(sends, 1)
  assert.equal(delivery(store, input.signalId).status, 'sent')

  const second = signal({ changeId: 'b'.repeat(64), observedAt: '2026-07-10T01:02:00.000Z' })
  store.insertSignal(second)
  const claimed = store.claimPendingDeliveries({ now: second.observedAt, limit: 1, leaseMs: 1000 })
  assert.equal(claimed.length, 1)
  store.close()
  store = openMonitorStateStore({ dbPath: file })
  await new AlertDispatcher({ store, senders: { telegram: async () => { sends += 1 } } }).tick('2026-07-10T01:02:01.000Z')
  assert.equal(delivery(store, second.signalId).status, 'sent')
  store.close()
})

test('a failed channel mutates delivery state but leaves active event and selection baselines byte-equivalent', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const eventKey = 'crown|football|gid=3001'
  const selectionIdentity = `${eventKey}|full_time|asian_handicap|RATIO_R|home`
  store.db.prepare(`
    INSERT INTO monitor_scope_state (
      scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    'crown|football|today',
    'batch-1',
    '2026-07-10T00:59:00.000Z',
    '2026-07-10T00:59:00.000Z',
    JSON.stringify({ active: [eventKey], missing: {}, lastSeen: { [eventKey]: '2026-07-10T00:59:00.000Z' }, removedAt: {} }),
  )
  store.db.prepare(`
    INSERT INTO monitor_event_state (
      event_key, match_group_key, active, missing_count, last_seen_at, provider_ids_json, event_json
    ) VALUES (?, ?, 1, 0, ?, ?, ?)
  `).run(eventKey, 'match-3001', '2026-07-10T00:59:00.000Z', JSON.stringify({ gid: '3001' }), JSON.stringify({ league: 'Test League' }))
  store.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
  `).run(selectionIdentity, eventKey, '2026-07-10T00:59:00.000Z', JSON.stringify({ odds: 0.94, suspended: false }))
  const baselineBefore = {
    scope: store.getScope('crown|football|today'),
    event: store.getEvent(eventKey),
    selection: store.getSelection(selectionIdentity),
  }

  const input = signal()
  store.insertSignal(input)
  await new AlertDispatcher({
    store,
    senders: { telegram: async () => { throw Object.assign(new Error('offline'), { code: 'network-error' }) } },
  }).tick(input.observedAt)

  assert.equal(delivery(store, input.signalId).status, 'retry')
  assert.deepEqual({
    scope: store.getScope('crown|football|today'),
    event: store.getEvent(eventKey),
    selection: store.getSelection(selectionIdentity),
  }, baselineBefore)
  store.close()
})

test('an expired sender cannot complete work after another worker reclaimed its lease', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal()
  store.insertSignal(input)
  const stale = store.claimPendingDeliveries({ now: input.observedAt, limit: 1, leaseMs: 1000 })[0]
  const current = store.claimPendingDeliveries({ now: '2026-07-10T01:00:01.000Z', limit: 1, leaseMs: 1000 })[0]
  assert.ok(current)
  assert.notEqual(current.claimToken, stale.claimToken)
  assert.throws(() => store.completeDelivery({
    ...stale,
    status: 'sent',
    attempts: 1,
    errorCode: '',
    nextAttemptAt: '2026-07-10T01:00:01.000Z',
    updatedAt: '2026-07-10T01:00:01.000Z',
  }), /stale/)
  assert.equal(store.completeDelivery({
    ...current,
    status: 'sent',
    attempts: 1,
    errorCode: '',
    nextAttemptAt: '2026-07-10T01:00:01.000Z',
    updatedAt: '2026-07-10T01:00:01.000Z',
  }), true)
  store.close()
})

test('start is idempotent, uses an unref timer, and stop waits for the bounded active tick', async () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const input = signal()
  store.insertSignal(input)
  const dispatcher = new AlertDispatcher({ store, pollMs: 1000, sendTimeoutMs: 15, senders: { telegram: () => new Promise(() => {}) } })
  assert.equal(dispatcher.start(), true)
  assert.equal(dispatcher.start(), false)
  assert.equal(dispatcher.timer?.hasRef?.(), false)
  const started = Date.now()
  await dispatcher.stop()
  assert.ok(Date.now() - started < 250)
  store.close()
})
