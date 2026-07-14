import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { AutoBettingConsumer } from '../src/crown/betting/auto-betting-consumer.mjs'
import { AutoBettingInboxStore } from '../src/crown/betting/auto-betting-inbox-store.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { BettingWorker, waitFor } from '../src/crown/betting/betting-worker.mjs'
import { createRealWorkerProvider, realCoordinatorDependencies, startRoleLeaseHeartbeat, waitForRealWorkerGo } from '../src/crown/betting/real-worker-factory.mjs'
import { blockRealBettingRuntime, getRealBettingStatus, requestRealBettingStart } from '../src/crown/betting/real-betting-runtime.mjs'

function fakeCoordinator() {
  return {
    recovered: [],
    signals: [],
    batches: [],
    recover(fencingToken) { this.recovered.push(fencingToken) },
    async processSignal(signal) { this.signals.push(signal); return { batchId: signal.signalId } },
    async runBatch(batchId) { this.batches.push(batchId); return { batchId } },
  }
}

test('off mode performs zero lease, database, provider, or coordinator work', async () => {
  const coordinator = fakeCoordinator()
  const worker = new BettingWorker({
    mode: 'off',
    db: null,
    coordinator,
    lease: { acquire() { throw new Error('lease-called') } },
  })
  assert.deepEqual(await worker.runOnce(), { mode: 'off', processed: 0, results: [] })
  assert.equal(coordinator.signals.length, 0)
})

test('worker recovers unfinished batches before claiming and consuming inbox only', async () => {
  const order = []
  const db = {
    prepare(sql) {
      assert.doesNotMatch(sql, /monitor_signals/)
      if (sql.includes('FROM bet_batches')) return { all: () => [{ batch_id: 'batch-old' }] }
      throw new Error(`unexpected-sql:${sql}`)
    },
  }
  const inboxStore = {
    claimDue() { order.push('claim'); return [{ signalId: 'signal-new', cardId: 'card-a', inboxLease: { ownerId: 'inbox-owner' }, bettingMode: 'prematch' }] },
    complete(input) { order.push(`complete:${input.signalId}:${input.cardId}:${input.leaseOwner}:${input.batchId}`) },
  }
  const worker = new BettingWorker({
    mode: 'simulated', db, inboxStore,
    consumer: { async process(item) { order.push(`consume:${item.signalId}`); return { status: 'batch_created', batchId: 'batch-new' } } },
    coordinator: {
      recover() {},
      async runBatch(batchId) { order.push(`recover:${batchId}`); return { batchId } },
    },
    lease: { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence() {}, heartbeat() {}, release() {} },
  })
  const result = await worker.runOnce()
  assert.equal(result.processed, 2)
  assert.deepEqual(order, ['recover:batch-old', 'claim', 'consume:signal-new', 'complete:signal-new:card-a:inbox-owner:batch-new'])
})

test('preview idempotency comes from persisted inbox status rather than a process seen set', async () => {
  const items = [[{ signalId: 'signal-a', bettingMode: 'prematch' }], []]
  let consumed = 0
  const worker = new BettingWorker({
    mode: 'preview', db: { prepare() { throw new Error('preview-ledger-read') } },
    inboxStore: {
      claimDue() { return items.shift() },
      skip() {},
    },
    consumer: { async process() { consumed += 1; return { status: 'skipped', reason: 'preview-incomplete' } } },
    coordinator: {},
    lease: { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence() {}, heartbeat() {}, release() {} },
  })
  assert.equal((await worker.runOnce()).processed, 1)
  assert.equal((await worker.runOnce()).processed, 0)
  assert.equal(consumed, 1)
  assert.equal(Object.hasOwn(worker, 'seenSignalIds'), false)
})

test('worker sends card inbox to the formal card-scoped consumer and completes composite identity', async () => {
  let processCalls = 0
  let terminal
  const item = {
    signalId: 'signal-card', cardId: 'card-a', cardSnapshot: { cardId: 'card-a' },
    signal: { trigger: { direction: 'up' } }, inboxLease: { ownerId: 'inbox-owner' },
  }
  const worker = new BettingWorker({
    mode: 'preview', db: { prepare() { throw new Error('unexpected-db-read') } }, coordinator: {},
    inboxStore: {
      claimDue: () => terminal ? [] : [item],
      complete(input) { terminal = input },
    },
    consumer: { cardInboxReady: true, async process(received) {
      processCalls += 1
      assert.equal(received, item)
      return { status: 'batch_created', batchId: 'batch-card' }
    } },
    lease: { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence() {}, heartbeat() {}, release() {} },
  })
  const result = await worker.runOnce()
  assert.deepEqual(result.results, [{ status: 'batch_created', batchId: 'batch-card' }])
  assert.equal(processCalls, 1)
  assert.deepEqual(terminal, {
    signalId: 'signal-card', cardId: 'card-a', leaseOwner: 'inbox-owner', batchId: 'batch-card',
  })
})

test('downward Signal reaches terminal skipped inbox state without selection, claim, or batch work', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const signalId = 'd'.repeat(64)
  const observedAt = '2026-07-12T00:00:00.000Z'
  const marketIdentity = 'crown|football|gid=1|full_time|asian_handicap|RATIO_RE'
  const signal = {
    signalId, observedAt,
    trigger: { type: 'odds-change', direction: 'down', delta: 0.05, threshold: 0.03, observedAt },
    target: { eventIdentity: 'crown|football|gid=1', marketIdentity, selectionIdentity: `${marketIdentity}|home`, side: 'home' },
    evidence: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', handicap: -0.5, handicapRaw: '-0.5' },
  }
  const settings = { mode: 'prematch', enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 20, currency: 'CNY', amountScale: 0, realEligible: false, realEligibilityVersion: 2, migrationReviewRequired: false, version: 7 }
  const card = { ...settings, cardId: 'card-down', name: 'card', leagueNames: ['英超'] }
  delete card.mode
  handle.db.prepare(`INSERT INTO monitor_signals
    (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
    VALUES (?,'down-signal','strategy',1,'ready',?,'2026-07-12T01:00:00.000Z',?)`).run(signalId, observedAt, JSON.stringify(signal))
  handle.db.prepare(`INSERT INTO auto_betting_signal_inbox
    (signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,next_attempt_at,created_at,updated_at)
    VALUES (?,'card-down',7,?,'prematch',7,?,?,?,?)`).run(signalId, JSON.stringify(card), JSON.stringify(card), observedAt, observedAt, observedAt)
  const atomicAdapter = async () => { throw new Error('atomic-claim-called') }
  atomicAdapter.ready = true
  const worker = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator: fakeCoordinator(),
    inboxStore: new AutoBettingInboxStore({ db: handle.db, now: () => observedAt, ownerId: 'owner-down' }),
    consumer: new AutoBettingConsumer({
      findLatestSelection: () => { throw new Error('selection-called') },
      isGlobalRealBettingRequested: () => false,
      claimAndCreateModeScopedBatch: atomicAdapter,
    }),
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:down', ownerId: 'owner-down' }),
  })
  try {
    const result = await worker.runOnce()
    assert.deepEqual(result.results, [{ status: 'skipped', reason: 'water-down-alert-only' }])
    assert.deepEqual({ ...handle.db.prepare(`
      SELECT status, skip_reason, lease_owner, lease_expires_at, batch_id
      FROM auto_betting_signal_inbox WHERE signal_id=?
    `).get(signalId) }, {
      status: 'skipped', skip_reason: 'water-down-alert-only', lease_owner: '', lease_expires_at: '', batch_id: null,
    })
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_batches').get().count, 0)
  } finally { worker.stop(); handle.close() }
})

test('card inbox waits for formal adapter readiness then terminalizes a deleted card without claim or batch', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const signalId = 'e'.repeat(64)
  const observedAt = '2026-07-12T00:00:00.000Z'
  const marketIdentity = 'crown|football|gid=1|full_time|asian_handicap|RATIO_RE'
  const signal = {
    signalId, observedAt,
    target: { eventIdentity: 'crown|football|gid=1', marketIdentity, selectionIdentity: `${marketIdentity}|home`, side: 'home' },
    trigger: { type: 'odds-change', direction: 'up', delta: 0.05, threshold: 0.03, observedAt },
    evidence: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', handicap: -0.5, handicapRaw: '-0.5' },
  }
  const settings = { mode: 'prematch', enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 20, currency: 'CNY', amountScale: 0, realEligible: false, realEligibilityVersion: 2, migrationReviewRequired: false, version: 7 }
  const card = { ...settings, cardId: 'card-atomic', name: 'card', leagueNames: ['英超'] }
  delete card.mode
  const latest = {
    provider: 'crown', mode: 'prematch', capturedAt: '2026-07-12T00:00:01.000Z',
    event: { eventKey: 'crown|football|gid=1', mode: 'prematch' },
    market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', handicap: -0.5 },
    selection: { selectionIdentity: `${marketIdentity}|away`, side: 'away', odds: '0.9', suspended: false },
  }
  handle.db.prepare(`INSERT INTO monitor_signals
    (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
    VALUES (?,'atomic-retry','strategy',1,'ready',?,'2026-07-12T01:00:00.000Z',?)`).run(signalId, observedAt, JSON.stringify(signal))
  handle.db.prepare(`INSERT INTO auto_betting_signal_inbox
    (signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,next_attempt_at,created_at,updated_at)
    VALUES (?,'card-atomic',7,?,'prematch',7,?,?,?,?)`).run(signalId, JSON.stringify(card), JSON.stringify(card), observedAt, observedAt, observedAt)
  const coordinator = fakeCoordinator()
  let now = observedAt
  let atomicCalls = 0
  const atomicAdapter = async (payload) => {
    atomicCalls += 1
    handle.db.exec('BEGIN IMMEDIATE')
    try {
      handle.db.prepare(`UPDATE auto_betting_signal_inbox SET status='skipped',skip_reason='rule-deleted',
        lease_owner='',lease_expires_at='',updated_at=? WHERE signal_id=? AND card_id=? AND status='processing'`)
        .run(now, payload.signalId, payload.cardId)
      handle.db.exec('COMMIT')
      return { status: 'skipped', reason: 'rule-deleted', inboxFinalized: true }
    } catch (error) { handle.db.exec('ROLLBACK'); throw error }
  }
  atomicAdapter.ready = false
  const worker = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator,
    inboxStore: new AutoBettingInboxStore({ db: handle.db, now: () => now, ownerId: 'owner-a' }),
    consumer: new AutoBettingConsumer({
      findLatestSelection: () => latest,
      isGlobalRealBettingRequested: () => false,
      claimAndCreateCardScopedBatch: atomicAdapter,
    }),
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:atomic-ready', ownerId: 'owner-a' }),
  })
  try {
    for (const value of [observedAt, '2026-07-12T00:00:05.000Z', '2026-07-12T01:00:00.000Z', '2026-07-13T00:00:00.000Z']) {
      now = value
      assert.deepEqual(await worker.runOnce(), { mode: 'simulated', processed: 0, results: [] })
      assert.deepEqual({ ...handle.db.prepare(`SELECT status,attempts,next_attempt_at,lease_owner,lease_expires_at
        FROM auto_betting_signal_inbox`).get() }, {
        status: 'pending', attempts: 0, next_attempt_at: observedAt, lease_owner: '', lease_expires_at: '',
      })
      assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 0)
    }
    assert.equal(atomicCalls, 0)
    atomicAdapter.ready = true
    assert.deepEqual((await worker.runOnce()).results[0], { status: 'skipped', reason: 'rule-deleted', inboxFinalized: true })
    assert.equal(atomicCalls, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_batches').get().count, 0)
    assert.deepEqual({ ...handle.db.prepare('SELECT status,skip_reason FROM auto_betting_signal_inbox').get() }, {
      status: 'skipped', skip_reason: 'rule-deleted',
    })
  } finally { worker.stop(); handle.close() }
})

test('exported real worker factory constructs executor-only production seams and ignores legacy eligibility flags', async () => {
  let previewCalls = 0
  let submitCalls = 0
  let previewOptions = null
  let executionOptions = null
  const repository = {}
  const loginManager = {}
  const executorLease = {}
  const database = { prepare() { throw new Error('database-work-before-invocation') }, exec() { throw new Error('database-work-before-invocation') } }
  const provider = createRealWorkerProvider({
    database, executorLease, env: {},
    factories: {
      repository: () => repository, loginManager: () => loginManager,
      previewProvider: (options) => { previewOptions = options; return { async preview() {
        previewCalls += 1
        if (previewCalls === 2) return {
          preview: { minStakeMinor: 1, maxStakeMinor: 50, stakeStepMinor: 1, odds: '0.95' },
          freshBalanceCny: 80,
        }
        return {
          realExecutionEligible: false,
          freshBalanceCny: 80,
          executionPreview: {
            minStakeMinor: 1, maxStakeMinor: 50, balanceMinor: 100, stakeStepMinor: 1,
            odds: '0.95', currency: 'CNY', amountScale: 0,
          },
          lockedIdentity: 'locked', capabilityEvidenceId: 'evidence', capabilityVersion: 1,
        }
      } } },
      executionProvider: (options) => { executionOptions = options; return {} },
      executor: () => ({ async submit() { submitCalls += 1; return { status: 'unknown' } } }),
    },
  })
  assert.equal(provider.kind, 'crown-production')
  assert.equal(typeof provider.previewProvider.preview, 'function')
  assert.equal(typeof provider.executionProvider, 'object')
  assert.equal(typeof provider.b2Executor.submit, 'function')
  assert.equal(Object.hasOwn(provider, 'b2Reconciler'), false)
  assert.equal(previewCalls, 0)
  assert.equal(submitCalls, 0)
  assert.equal(previewOptions.repository, repository)
  assert.equal(previewOptions.loginManager, loginManager)
  assert.equal(previewOptions.executorLease, executorLease)
  assert.equal(executionOptions.repository, repository)
  assert.equal(executionOptions.loginManager, loginManager)
  assert.equal(executionOptions.previewProvider, provider.previewProvider)
  assert.equal(executionOptions.executorLease, executorLease)
  assert.deepEqual(realCoordinatorDependencies(provider), {
    provider: provider.previewAdapter,
    b2Executor: provider.b2Executor,
  })
  assert.deepEqual(await provider.previewAdapter.preview({}), {
    ok: true,
    minStakeMinor: 1, maxStakeMinor: 50, balanceMinor: 80, stakeStepMinor: 1,
    odds: '0.95', currency: 'CNY', amountScale: 0,
    lockedIdentity: 'locked', capabilityEvidenceId: 'evidence', capabilityVersion: 1,
  })
  assert.deepEqual(await provider.previewAdapter.preview({}), { ok: false })
  await provider.b2Executor.submit({})
  assert.equal(previewCalls, 2)
  assert.equal(submitCalls, 1)
})

test('real worker does not load legacy authorizations or schedule reconciliation', async () => {
  const queries = []
  const db = {
    prepare(sql) {
      queries.push(sql)
      if (sql.includes('FROM bet_batches')) return { all: () => [] }
      if (sql.includes('FROM monitor_signals')) return { all: () => [] }
      throw new Error(`unexpected-sql:${sql}`)
    },
  }
  const lease = { fencingToken: 1, acquire() { return { fencingToken: 1 } }, assertFence() { return 1 }, heartbeat() {} }
  const worker = new BettingWorker({
    mode: 'real', db, lease, processLease: { fencingToken: 1, assertFence() {}, heartbeat() {} },
    realExecutionGate() {},
    coordinator: { recover() {}, async runBatch(id) { return { batchId: id } } },
  })
  await worker.runOnce()
  assert.equal(queries.some((sql) => /execution_authorizations|bet_reconciliation_state/.test(sql)), false)
})

test('real worker performs local crash recovery once and keeps uncertain children locked as unknown', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const now = '2026-07-14T00:00:00.000Z'
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:real-local-recovery',
    ownerId: 'real-local-recovery-owner',
    now: () => new Date(now),
  })
  const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => now })
  let recoverCalls = 0
  try {
    handle.db.prepare("INSERT INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at) VALUES ('rule','Rule','CNY',0,20,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO betting_accounts (id,label,username,status,currency,amount_scale,per_bet_limit_minor,stake_step_minor,created_at,updated_at) VALUES ('a1','A1','u1','enabled','CNY',0,50,1,?,?),('a2','A2','u2','enabled','CNY',0,50,1,?,?)").run(now, now, now, now)
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('signal','key','strategy',1,'ready',?,?,'{}')").run(now, '2026-07-14T01:00:00.000Z')
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,reserved_amount_minor,status,created_at) VALUES ('batch','signal','rule','CNY',0,20,20,'submitting',?)").run(now)
    handle.db.prepare(`INSERT INTO bet_child_orders (
      child_order_id,batch_id,account_id,attempt,requested_amount_minor,submit_attempt_id,
      submit_prepared_at,submit_dispatched_at,submitted_at,status,created_at
    ) VALUES
      ('prepared','batch','a1',1,10,'attempt-prepared',?,'','','submit_prepared',?),
      ('dispatched','batch','a2',1,10,'attempt-dispatched',?,?,?,'submit_dispatched',?)`)
      .run(now, now, now, now, now, now)
    handle.db.prepare(`INSERT INTO bet_submit_attempts (
      submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,fencing_token,
      capability_version,capability_evidence_id,preview_odds,locked_identity_json,preview_snapshot_json,
      status,prepared_at,created_at,updated_at
    ) VALUES
      ('attempt-prepared','prepared',NULL,1,10,1,'v1','e1','0.88','{}','{}','submit_prepared',?,?,?),
      ('attempt-dispatched','dispatched',NULL,1,10,1,'v1','e1','0.88','{}','{}','submit_prepared',?,?,?)`)
      .run(now, now, now, now, now, now)
    handle.db.prepare(`UPDATE bet_submit_attempts SET status='submit_dispatched',dispatched_at=?,updated_at=?
      WHERE submit_attempt_id='attempt-dispatched'`).run(now, now)
    handle.db.prepare("INSERT INTO betting_account_locks (account_id,child_order_id,batch_id,status,fencing_token,acquired_at,updated_at) VALUES ('a1','prepared','batch','submitting',1,?,?),('a2','dispatched','batch','submitting',1,?,?)").run(now, now, now, now)

    const worker = new BettingWorker({
      mode: 'real', db: handle.db, lease,
      coordinator: {
        recover(fencingToken) {
          recoverCalls += 1
          return store.recover({ fencingToken, at: now })
        },
        async runBatch(batchId) { return { batchId } },
      },
      realExecutionGate() {},
    })
    await worker.runOnce()
    await worker.runOnce()

    assert.equal(recoverCalls, 1)
    assert.deepEqual(handle.db.prepare('SELECT child_order_id,status,error_code FROM bet_child_orders ORDER BY child_order_id').all().map((row) => ({ ...row })), [
      { child_order_id: 'dispatched', status: 'unknown', error_code: 'recovery-uncertain' },
      { child_order_id: 'prepared', status: 'unknown', error_code: 'recovery-uncertain' },
    ])
    assert.deepEqual(handle.db.prepare(`SELECT submit_attempt_id,status,error_code,result_at
      FROM bet_submit_attempts ORDER BY submit_attempt_id`).all().map((row) => ({ ...row })), [
      { submit_attempt_id: 'attempt-dispatched', status: 'unknown', error_code: 'recovery-uncertain', result_at: now },
      { submit_attempt_id: 'attempt-prepared', status: 'unknown', error_code: 'recovery-uncertain', result_at: now },
    ])
    assert.deepEqual(handle.db.prepare('SELECT account_id,status FROM betting_account_locks ORDER BY account_id').all().map((row) => ({ ...row })), [
      { account_id: 'a1', status: 'unknown' },
      { account_id: 'a2', status: 'unknown' },
    ])
    worker.stop()
  } finally { handle.close() }
})

test('real worker passes only execution mode to the consumer and never binds an authorization', async () => {
  const queries = []
  const processOptions = []
  const db = {
    prepare(sql) {
      queries.push(sql)
      if (sql.includes('FROM bet_batches')) return { all: () => [] }
      if (sql.includes('execution_authorizations')) return { get: () => ({ authorization_id: 'legacy-auth' }) }
      throw new Error(`unexpected-sql:${sql}`)
    },
  }
  const lease = { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence: () => 1, heartbeat() {} }
  const worker = new BettingWorker({
    mode: 'real', db, lease, processLease: { fencingToken: 1, assertFence() {}, heartbeat() {} },
    realExecutionGate() {}, coordinator: { recover() {}, async runBatch(id) { return { batchId: id } } },
    inboxStore: { claimDue: () => [{ signalId: 'signal-a' }], complete() {} },
    consumer: { async process(_item, options) { processOptions.push(options); return { status: 'batch_created', batchId: 'batch-a' } } },
  })
  const result = await worker.runOnce()
  assert.equal(result.processed, 1)
  assert.deepEqual(processOptions, [{ executionMode: 'real' }])
  assert.equal(queries.some((sql) => sql.includes('execution_authorizations')), false)
})

test('exported real worker GO barrier permits no work before exact generation and nonce', async () => {
  const channel = new EventEmitter()
  let work = 0
  const pending = waitForRealWorkerGo({ channel, generation: '7', nonce: 'nonce', timeoutMs: 1000 })
    .then(() => { work += 1 })
  channel.emit('message', { type: 'go', generation: '6', nonce: 'nonce' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(work, 0)
  channel.emit('message', { type: 'go', generation: '7', nonce: 'nonce' })
  await pending
  assert.equal(work, 1)
  assert.equal(channel.listenerCount('message'), 0)
})

test('worker and executor leases heartbeat below TTL/3 and one failure aborts the worker controller', () => {
  let callback
  let interval
  let cleared = false
  let calls = 0
  const controller = new AbortController()
  const leases = [1, 2].map((value) => ({
    ttlMs: 3000,
    heartbeat() { calls += 1; if (value === 2) throw new Error('lease-lost') },
  }))
  const stop = startRoleLeaseHeartbeat({
    leases, controller,
    setIntervalFn(fn, ms) { callback = fn; interval = ms; return { unref() {} } },
    clearIntervalFn() { cleared = true },
  })
  assert.ok(interval < 1000)
  callback()
  assert.equal(calls, 2)
  assert.equal(controller.signal.aborted, true)
  stop()
  assert.equal(cleared, true)
})

test('an active executor lease makes a second worker fail closed before recovery or Signal reads', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const firstCoordinator = fakeCoordinator()
  const secondCoordinator = fakeCoordinator()
  const first = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator: firstCoordinator,
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:test', ownerId: 'owner-a' }),
  })
  const second = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator: secondCoordinator,
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:test', ownerId: 'owner-b' }),
  })
  try {
    first.start()
    assert.throws(() => second.start(), /lease-active/)
    assert.equal(secondCoordinator.recovered.length, 0)
    assert.equal(secondCoordinator.signals.length, 0)
  } finally {
    first.stop()
    handle.close()
  }
})

test('reads claimed inbox items and passes the active fence to recovery', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  const payload = { schemaVersion: 2, signalId: 'a'.repeat(64), status: 'pending' }
  const consumed = []
  const worker = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator,
    inboxStore: { claimDue: () => [{ signalId: payload.signalId, signal: payload }], complete() {} },
    consumer: { async process(item) { consumed.push(item.signal); return { status: 'batch_created', batchId: 'batch-a' } } },
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:test', ownerId: 'owner-a' }),
  })
  try {
    const result = await worker.runOnce()
    assert.equal(result.processed, 1)
    assert.deepEqual(consumed, [payload])
    assert.deepEqual(coordinator.recovered, [1])
  } finally {
    worker.stop()
    handle.close()
  }
})

test('preview worker relies on persisted inbox terminal state across polls', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  const payload = { schemaVersion: 2, signalId: 'b'.repeat(64), status: 'pending' }
  let terminal = false
  const worker = new BettingWorker({
    mode: 'preview', db: handle.db, coordinator,
    inboxStore: {
      claimDue: () => terminal ? [] : [{ signalId: payload.signalId, signal: payload }],
      skip() { terminal = true },
    },
    consumer: { async process(item) { coordinator.signals.push(item.signal); return { status: 'skipped', reason: 'preview-incomplete' } } },
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:preview', ownerId: 'preview-owner' }),
  })
  try {
    assert.equal((await worker.runOnce()).processed, 1)
    assert.equal((await worker.runOnce()).processed, 0)
    assert.equal(coordinator.signals.length, 1)
  } finally {
    worker.stop()
    handle.close()
  }
})

test('preview worker acquires the lease without recovering or mutating the betting ledger', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  handle.db.prepare("INSERT INTO betting_rules (id, name, created_at, updated_at) VALUES ('rule', 'rule', '', '')").run()
  handle.db.prepare("INSERT INTO betting_accounts (id, label, username, status, currency, amount_scale, stake_step_minor, per_bet_limit_minor, created_at, updated_at) VALUES ('account', 'account', 'account', 'enabled', 'CNY', 0, 10, 100, '', '')").run()
  handle.db.prepare("INSERT INTO monitor_signals (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json) VALUES ('signal', 'key', 'strategy', 1, 'ready', '', '', '{}')").run()
  handle.db.prepare("INSERT INTO bet_batches (batch_id, signal_id, rule_id, currency, amount_scale, target_amount_minor, reserved_amount_minor, unfilled_amount_minor, status, created_at) VALUES ('batch', 'signal', 'rule', 'CNY', 0, 50, 50, 0, 'submitting', '')").run()
  handle.db.prepare("INSERT INTO bet_child_orders (child_order_id, batch_id, account_id, requested_amount_minor, preview_min_stake_minor, preview_max_stake_minor, preview_stake_step_minor, status, created_at) VALUES ('child', 'batch', 'account', 50, 10, 50, 10, 'submit_prepared', '')").run()
  handle.db.prepare("INSERT INTO betting_account_locks (account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at) VALUES ('account', 'child', 'batch', 'submitting', 1, '', '')").run()
  const ledger = () => JSON.stringify({
    batches: handle.db.prepare('SELECT * FROM bet_batches ORDER BY batch_id').all(),
    children: handle.db.prepare('SELECT * FROM bet_child_orders ORDER BY child_order_id').all(),
    locks: handle.db.prepare('SELECT * FROM betting_account_locks ORDER BY account_id').all(),
  })
  const before = ledger()
  const worker = new BettingWorker({
    mode: 'preview', db: handle.db, coordinator,
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:preview-readonly', ownerId: 'preview-owner' }),
  })
  try {
    await worker.runOnce()
    assert.deepEqual(coordinator.recovered, [])
    assert.deepEqual(coordinator.batches, [])
    assert.equal(ledger(), before)
  } finally {
    worker.stop()
    handle.close()
  }
})

test('runOnce heartbeats after every processed Signal', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  const items = ['c'.repeat(64), 'd'.repeat(64)].map((signalId) => ({ signalId }))
  let heartbeats = 0
  const lease = {
    fencingToken: 1,
    acquire() { return { fencingToken: 1 } },
    assertFence() { return 1 },
    heartbeat() { heartbeats += 1 },
    release() { return true },
  }
  const worker = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator, lease,
    inboxStore: { claimDue: () => items.splice(0), skip() {} },
    consumer: { async process() { return { status: 'skipped', reason: 'preview-incomplete' } } },
  })
  try {
    assert.equal((await worker.runOnce()).processed, 2)
    assert.equal(heartbeats, 2)
  } finally {
    worker.stop()
    handle.close()
  }
})

test('worker lease loss aborts before scan and successful work heartbeats the held worker fence', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  let held = false
  let heartbeats = 0
  const processLease = {
    fencingToken: 3,
    assertFence() { if (!held) throw new Error('lease-stale'); return 3 },
    heartbeat() { heartbeats += 1 },
  }
  const executorLease = { fencingToken: 4, acquire: () => ({ fencingToken: 4 }), assertFence: () => 4, heartbeat() {}, release: () => true }
  const worker = new BettingWorker({ mode: 'simulated', db: handle.db, coordinator, lease: executorLease, processLease })
  try {
    await assert.rejects(worker.runOnce(), /lease-stale/)
    held = true
    await worker.runOnce()
    assert.ok(heartbeats >= 1)
  } finally { worker.stop(); handle.close() }
})

test('real worker collector failure blocks runtime before scan without provider work', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  const ready = Object.fromEntries([
    'ruleCardsEnabled', 'bettingAccountAvailable', 'capabilityExact', 'schemaCurrent',
    'fenceFresh', 'executorLeaseFresh',
  ].map((field) => [field, true]))
  requestRealBettingStart(handle.db, ready)
  const lease = { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence: () => 1, heartbeat() {}, release: () => true }
  const worker = new BettingWorker({
    mode: 'real', db: handle.db, coordinator, lease,
    processLease: { fencingToken: 2, assertFence: () => 2, heartbeat() {} },
    realExecutionGate(db) {
      blockRealBettingRuntime(db, 'collector-failed')
      throw new Error('collector-failed')
    },
  })
  try {
    await assert.rejects(worker.runOnce(), /collector-failed/)
    assert.equal(coordinator.signals.length, 0)
    assert.equal(getRealBettingStatus(handle.db).state, 'blocked')
  } finally { worker.stop(); handle.close() }
})

test('runOnce resumes recoverable batches before Signals and audits waiting_result without treating it as a new Signal', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  handle.db.prepare("INSERT INTO betting_rules (id, name, created_at, updated_at) VALUES ('rule', 'rule', '', '')").run()
  for (const [signalId, status] of [['resume-signal', 'submitting'], ['unknown-signal', 'waiting_result']]) {
    handle.db.prepare(`
      INSERT INTO monitor_signals (
        signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
      ) VALUES (?, ?, 'strategy', 1, 'ready', '2026-07-11T02:00:00.000Z', '2026-07-11T02:05:00.000Z', '{}')
    `).run(signalId, `key-${signalId}`)
    handle.db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, target_amount_minor, unfilled_amount_minor, status, created_at
      ) VALUES (?, ?, 'rule', 100, 100, ?, '')
    `).run(`batch-${signalId}`, signalId, status)
  }
  const worker = new BettingWorker({
    mode: 'simulated', db: handle.db, coordinator,
    lease: new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:resume', ownerId: 'resume-owner' }),
  })
  try {
    await worker.runOnce()
    assert.deepEqual(coordinator.batches, ['batch-resume-signal', 'batch-unknown-signal'])
  } finally {
    worker.stop()
    handle.close()
  }
})

test('real worker finalizes drained pause-pending accounts after recovery and every resumed batch', async () => {
  const order = []
  const db = {
    prepare(sql) {
      if (sql.includes('FROM bet_batches')) return { all: () => [{ batch_id: 'batch-drained' }] }
      if (sql.includes('FROM monitor_signals')) return { all: () => [] }
      throw new Error(`unexpected-sql:${sql}`)
    },
  }
  const worker = new BettingWorker({
    mode: 'real', db,
    coordinator: {
      recover() { order.push('recover') },
      async runBatch(id) { order.push(`batch:${id}`); return { batchId: id } },
    },
    lease: { fencingToken: 1, acquire: () => ({ fencingToken: 1 }), assertFence() {}, heartbeat() {}, release() {} },
    processLease: { fencingToken: 1, assertFence() {}, heartbeat() {} },
    realExecutionGate() {},
    accountPauseFinalizer() { order.push('finalize') },
  })
  await worker.runOnce()
  assert.deepEqual(order, ['recover', 'finalize', 'batch:batch-drained', 'finalize', 'finalize'])
})

test('continuous loop heartbeats and stops through an AbortSignal', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const coordinator = fakeCoordinator()
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:loop', ownerId: 'loop-owner' })
  const worker = new BettingWorker({ mode: 'simulated', db: handle.db, coordinator, lease })
  const controller = new AbortController()
  let waits = 0
  try {
    const result = await worker.run({
      signal: controller.signal,
      pollIntervalMs: 1,
      async wait() {
        waits += 1
        if (waits === 2) controller.abort()
      },
    })
    assert.equal(result.iterations, 2)
    assert.equal(waits, 2)
    const row = handle.db.prepare("SELECT heartbeat_at FROM runtime_leases WHERE lease_key = 'betting-executor:loop'").get()
    assert.equal(typeof row.heartbeat_at, 'string')
  } finally {
    worker.stop()
    handle.close()
  }
})

test('waitFor removes its abort listener after a natural timer completion', async () => {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(_event, listener) { listeners.add(listener) },
    removeEventListener(_event, listener) { listeners.delete(listener) },
  }
  await waitFor(1, signal)
  assert.equal(listeners.size, 0)
})

test('CLI defaults to off and --once exits without creating or opening a database', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-worker-off-')), 'must-not-exist.sqlite')
  const result = spawnSync(process.execPath, ['scripts/crown-betting-worker.mjs', '--once', '--db-path', dbPath], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, CROWN_BETTING_MODE: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { mode: 'off', processed: 0, results: [] })
  assert.equal(existsSync(dbPath), false)
})

test('simulated CLI without an explicit result script fails before opening a database', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-worker-script-')), 'must-not-exist.sqlite')
  const result = spawnSync(process.execPath, ['scripts/crown-betting-worker.mjs', '--mode', 'simulated', '--once', '--db-path', dbPath], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, CROWN_SIMULATED_SCRIPT_JSON: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /simulated-script-required/)
  assert.equal(existsSync(dbPath), false)
})

test('real CLI rejects a non-canonical worker lease key derived from another database', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crown-worker-bad-key-'))
  const dbPath = path.join(directory, 'app.sqlite')
  const result = spawnSync(process.execPath, [
    'scripts/crown-betting-worker.mjs', '--mode', 'real', '--once', '--db-path', dbPath,
    '--worker-lease-key', `betting-worker:${path.join(directory, 'other.sqlite')}`,
  ], { cwd: path.resolve('.'), encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /betting-worker-lease-key-mismatch/)
})

test('preview CLI also requires an explicit simulation script before opening a database', () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'crown-worker-preview-script-')), 'must-not-exist.sqlite')
  const result = spawnSync(process.execPath, ['scripts/crown-betting-worker.mjs', '--mode', 'preview', '--once', '--db-path', dbPath], {
    cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, CROWN_SIMULATED_SCRIPT_JSON: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /simulated-script-required/)
  assert.equal(existsSync(dbPath), false)
})

for (const mode of ['simulated', 'preview']) {
  test(`${mode} CLI rejects an explicitly empty simulation script before opening a database`, () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), `crown-worker-empty-${mode}-`)), 'must-not-exist.sqlite')
    const result = spawnSync(process.execPath, [
      'scripts/crown-betting-worker.mjs', '--mode', mode, '--once', '--db-path', dbPath,
      '--simulated-script-json', '[]',
    ], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /simulated-script-required/)
    assert.equal(existsSync(dbPath), false)
  })
}

test('CLI fails closed before opening a database when the whitelist config is missing', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'crown-worker-whitelist-'))
  const dbPath = path.join(directory, 'must-not-exist.sqlite')
  const missingConfig = path.join(directory, 'missing-leagues.json')
  const result = spawnSync(process.execPath, [
    'scripts/crown-betting-worker.mjs', '--mode', 'preview', '--once', '--db-path', dbPath,
    '--default-leagues-config', missingConfig, '--simulated-script-json', '[{"operation":"preview","result":{"ok":false}}]',
  ], { cwd: path.resolve('.'), encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /default-leagues-config-missing/)
  assert.equal(existsSync(dbPath), false)
})

for (const [name, config] of [
  ['missing schema', {}],
  ['empty modes', { version: 1, leagues: [{ name: '英超', enabled: true, modes: [] }] }],
  ['invalid mode', { version: 1, leagues: [{ name: '英超', enabled: true, modes: ['all'] }] }],
]) {
  test(`CLI rejects ${name} whitelist config before opening a database`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'crown-worker-invalid-whitelist-'))
    const dbPath = path.join(directory, 'must-not-exist.sqlite')
    const configPath = path.join(directory, 'leagues.json')
    writeFileSync(configPath, JSON.stringify(config))
    const result = spawnSync(process.execPath, [
      'scripts/crown-betting-worker.mjs', '--mode', 'preview', '--once', '--db-path', dbPath,
      '--default-leagues-config', configPath,
      '--simulated-script-json', '[{"operation":"preview","result":{"ok":false}}]',
    ], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /default-leagues-config-invalid/)
    assert.equal(existsSync(dbPath), false)
  })
}
