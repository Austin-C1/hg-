import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { SimulatedBetProvider } from '../src/crown/betting/simulated-bet-provider.mjs'
import { BettingWorker } from '../src/crown/betting/betting-worker.mjs'
import { prepareSubmitAttempt, recordSubmitDispatch, recordSubmitOutcome } from '../src/crown/betting/b2-executor.mjs'
import { collectRealBettingPreflight, requestRealBettingStart, requestRealBettingStop } from '../src/crown/betting/real-betting-runtime.mjs'

const NOW = '2026-07-11T02:01:00.000Z'
const SIGNAL_ID = 'a'.repeat(64)

function signal(overrides = {}) {
  const base = {
    schemaVersion: 2,
    signalId: SIGNAL_ID,
    status: 'pending',
    bettingRuleId: 'rule-a',
    observedAt: '2026-07-11T02:00:00.000Z',
    expiresAt: '2026-07-11T02:05:00.000Z',
    trigger: { type: 'odds-change', direction: 'up' },
    target: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      side: 'home',
    },
    evidence: {
      league: '英超', nextOdds: 0.91, mode: 'prematch', marketType: 'asian_handicap', period: 'full_time',
      minutesBeforeKickoff: 30, livePhase: null, liveMinute: null, handicap: -0.5, handicapRaw: '-0.5',
    },
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
  }
  return {
    ...base,
    ...overrides,
    trigger: { ...base.trigger, ...overrides.trigger },
    target: { ...base.target, ...overrides.target },
    evidence: { ...base.evidence, ...overrides.evidence },
    dataQuality: { ...base.dataQuality, ...overrides.dataQuality },
  }
}

function latestSelection(overrides = {}) {
  const marketIdentity = signal().target.marketIdentity
  const base = {
    provider: 'crown', mode: 'prematch', capturedAt: NOW,
    event: { eventKey: signal().target.eventIdentity, mode: 'prematch', ids: { gid: '8878931' }, livePhase: null },
    market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main', lineKey: 'RATIO_RE', handicap: -0.5, handicapRaw: '-0.50' },
    selection: { selectionIdentity: `${marketIdentity}|away`, side: 'away', odds: 0.88, suspended: false },
  }
  return {
    ...base,
    ...overrides,
    event: { ...base.event, ...overrides.event },
    market: { ...base.market, ...overrides.market },
    selection: { ...base.selection, ...overrides.selection },
  }
}

function seed(db, {
  target = 100,
  accounts = [{ id: 'account-a', limit: 50 }, { id: 'account-b', limit: 50 }],
  signalInput = signal(),
} = {}) {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, monitor_enabled, real_betting_enabled,
      migration_review_required, archived, currency, amount_scale, target_amount_minor,
      league_names_json, version, bet_direction_mode, created_at, updated_at
    ) VALUES ('rule-a', 'Rule A', 1, 'preview_only', 1, 1, 0, 0, 'CNY', 0, ?, '["英超"]', 1, 'up_reverse', ?, ?)
  `).run(target, NOW, NOW)
  for (const [index, account] of accounts.entries()) {
    db.prepare(`
      INSERT INTO betting_accounts (
        id, label, username, bet_order, status, archived, allocation_status, per_bet_limit_minor,
        currency, amount_scale, stake_step_minor, balance_minor, secret_ciphertext,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'enabled', 0, 'enabled', ?, 'CNY', 0, 10, 1000, 'simulated-secret', ?, ?)
    `).run(account.id, account.id, account.id, index + 1, account.limit, NOW, NOW)
  }
  const input = signalInput
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (?, 'signal-key', 'strategy', 1, 'ready', ?, ?, ?)
  `).run(input.signalId, input.observedAt, input.expiresAt, JSON.stringify(input))
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

class ConcurrentProvider {
  constructor({ submitByAccount = {}, onSubmit = null } = {}) {
    this.submitByAccount = Object.fromEntries(Object.entries(submitByAccount).map(([key, values]) => [key, [...values]]))
    this.onSubmit = onSubmit
    this.previewCalls = []
    this.submitCalls = []
    this.activePreview = 0
    this.activeSubmit = 0
    this.maxActivePreview = 0
    this.maxActiveSubmit = 0
  }

  get networkCallCount() { return 0 }

  async preview(input) {
    this.previewCalls.push(structuredClone(input))
    this.activePreview += 1
    this.maxActivePreview = Math.max(this.maxActivePreview, this.activePreview)
    await tick()
    this.activePreview -= 1
    return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, odds: '0.88' }
  }

  async submit(input) {
    this.submitCalls.push(structuredClone(input))
    this.onSubmit?.(input)
    this.activeSubmit += 1
    this.maxActiveSubmit = Math.max(this.maxActiveSubmit, this.activeSubmit)
    await tick()
    this.activeSubmit -= 1
    return this.submitByAccount[input.accountId]?.shift() || { status: 'accepted' }
  }
}

function fixture(options = {}) {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db, options)
  const lease = {
    leaseKey: 'betting-executor:test',
    ownerId: 'owner',
    fencingToken: 7,
    assertFence(token = 7) {
      if (token !== 7) throw new Error('lease-stale')
      return 7
    },
  }
  handle.db.prepare(`
    INSERT INTO runtime_leases (
      lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token
    ) VALUES ('betting-executor:test', 'owner', 1, ?, ?, '2026-07-11T02:10:00.000Z', 7)
  `).run(NOW, NOW)
  const store = new BetBatchStore(handle.db, {
    fencingToken: 999,
    leaseKey: 'betting-executor:test',
    now: () => NOW,
    faultInjector: options.storeFaultInjector,
  })
  const provider = options.provider || new ConcurrentProvider({
    onSubmit() {
      const locks = handle.db.prepare('SELECT fencing_token FROM betting_account_locks').all()
      assert.equal(locks.every((row) => row.fencing_token === 7), true)
    },
  })
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store,
    provider,
    lease,
    findLatestSelection: options.findLatestSelection || (() => latestSelection()),
    currentLeagueNames: ['英超'],
    now: options.now || (() => NOW),
    faultInjector: options.faultInjector,
  })
  return { handle, store, provider, lease, coordinator }
}

function coordinatorContractDependencies() {
  const lease = {
    leaseKey: 'betting-executor:contract',
    assertFence: () => 1,
  }
  return {
    db: { prepare() {} },
    store: { leaseKey: lease.leaseKey },
    lease,
    findLatestSelection: () => null,
  }
}

test('accepts a preview-only provider when B2 owns the submit contract', () => {
  const dependencies = coordinatorContractDependencies()

  assert.doesNotThrow(() => new MultiAccountBetCoordinator({
    ...dependencies,
    provider: { async preview() {} },
    b2Executor: { async submit() {} },
  }))
})

test('rejects a coordinator when neither provider nor B2 can submit', () => {
  const dependencies = coordinatorContractDependencies()

  assert.throws(() => new MultiAccountBetCoordinator({
    ...dependencies,
    provider: { async preview() {} },
  }), /coordinator-provider/)
})

test('canonical claim allocation rollback leaves no batch children or locks and records stable failure', async () => {
  let injected = false
  const context = fixture({
    target: 100,
    accounts: [{ id: 'account-a', limit: 60 }, { id: 'account-b', limit: 50 }],
    storeFaultInjector(phase) {
      if (!injected && phase === 'reserve:after-child-insert') {
        injected = true
        throw new Error('injected-atomic-allocation-failure')
      }
    },
  })
  try {
    context.handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, signal_id, claim_status, created_at, updated_at
      ) VALUES ('market-once-task-4', 'rule-a', ?, 'claimed', ?, ?)
    `).run(SIGNAL_ID, NOW, NOW)

    await assert.rejects(context.coordinator.processSignal(signal()), /injected-atomic-allocation-failure/)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM betting_account_locks').get().count, 0)
    assert.deepEqual({ ...context.handle.db.prepare(`
      SELECT batch_id, claim_status, failure_reason
      FROM bet_market_once_claims WHERE market_once_key = 'market-once-task-4'
    `).get() }, {
      batch_id: null,
      claim_status: 'allocation_failed',
      failure_reason: 'injected-atomic-allocation-failure',
    })

    const calls = { previews: context.provider.previewCalls.length, submits: context.provider.submitCalls.length }
    const replay = await context.coordinator.processSignal(signal())
    assert.deepEqual(replay, {
      mode: 'simulated',
      status: 'allocation_failed',
      marketOnceKey: 'market-once-task-4',
      signalId: SIGNAL_ID,
      ruleId: 'rule-a',
      failureReason: 'injected-atomic-allocation-failure',
    })
    assert.deepEqual({ previews: context.provider.previewCalls.length, submits: context.provider.submitCalls.length }, calls)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('allocation_failed claim remains terminal after coordinator restart', async () => {
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }] })
  try {
    context.handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, signal_id, claim_status, failure_reason, created_at, updated_at
      ) VALUES ('market-once-terminal-restart', 'rule-a', ?, 'allocation_failed', 'stable-failure', ?, ?)
    `).run(SIGNAL_ID, NOW, NOW)
    context.handle.db.prepare("UPDATE betting_rules SET enabled = 0 WHERE id = 'rule-a'").run()
    const restarted = restartCoordinator(context, { now: () => signal().expiresAt })
    const result = await restarted.processSignal(signal())
    assert.equal(result.status, 'allocation_failed')
    assert.equal(result.failureReason, 'stable-failure')
    assert.equal(context.provider.previewCalls.length, 0)
    assert.equal(context.provider.submitCalls.length, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('claim update failure preserves the original allocation error and attaches the update failure as cause', async () => {
  const context = fixture({
    target: 60,
    accounts: [{ id: 'account-a', limit: 60 }],
    storeFaultInjector(phase) {
      if (phase === 'reserve:after-child-insert') throw new Error('original-allocation-error')
    },
    faultInjector(phase) {
      if (phase === 'beforeAllocationFailureClaimUpdate') throw new Error('claim-update-error')
    },
  })
  try {
    context.handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, signal_id, claim_status, created_at, updated_at
      ) VALUES ('market-once-claim-update-fails', 'rule-a', ?, 'claimed', ?, ?)
    `).run(SIGNAL_ID, NOW, NOW)
    await assert.rejects(context.coordinator.processSignal(signal()), (error) => {
      assert.equal(error.message, 'original-allocation-error')
      assert.equal(error.cause?.message, 'claim-update-error')
      return true
    })
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
    assert.equal(context.handle.db.prepare(`
      SELECT claim_status FROM bet_market_once_claims WHERE market_once_key = 'market-once-claim-update-fails'
    `).get().claim_status, 'claimed')
  } finally {
    context.handle.close()
  }
})

test('canonical allocation is sequential, honors each configured per-account limit, and continues after rejection', async () => {
  const provider = new ConcurrentProvider({ submitByAccount: {
    'account-a': [{ status: 'rejected', errorCode: 'sim-rejected' }],
    'account-b': [{ status: 'accepted' }],
  } })
  const context = fixture({
    target: 100,
    accounts: [{ id: 'account-a', limit: 60 }, { id: 'account-b', limit: 50 }],
    provider,
  })
  try {
    context.handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, signal_id, claim_status, created_at, updated_at
      ) VALUES ('market-once-no-redistribution', 'rule-a', ?, 'claimed', ?, ?)
    `).run(SIGNAL_ID, NOW, NOW)
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'partial')
    assert.deepEqual(provider.submitCalls.map(({ accountId, amountMinor }) => ({ accountId, amountMinor })), [
      { accountId: 'account-a', amountMinor: 60 },
      { accountId: 'account-b', amountMinor: 50 },
    ])
    assert.equal(provider.maxActivePreview, 1)
    assert.equal(provider.maxActiveSubmit, 1)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 2)
    assert.deepEqual({ ...context.handle.db.prepare(`
      SELECT claim_status, failure_reason FROM bet_market_once_claims
      WHERE market_once_key = 'market-once-no-redistribution'
    `).get() }, { claim_status: 'batch_created', failure_reason: null })
  } finally {
    context.handle.close()
  }
})

test('batch_created claim replay resumes its bound batch without creating or submitting again', async () => {
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }] })
  try {
    context.handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, signal_id, claim_status, created_at, updated_at
      ) VALUES ('market-once-batch-replay', 'rule-a', ?, 'claimed', ?, ?)
    `).run(SIGNAL_ID, NOW, NOW)
    const first = await context.coordinator.processSignal(signal())
    const counts = {
      batches: context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count,
      children: context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count,
      previews: context.provider.previewCalls.length,
      submits: context.provider.submitCalls.length,
    }
    const replay = await context.coordinator.processSignal(signal())
    assert.equal(replay.batchId, first.batchId)
    assert.deepEqual({
      batches: context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count,
      children: context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count,
      previews: context.provider.previewCalls.length,
      submits: context.provider.submitCalls.length,
    }, counts)
  } finally {
    context.handle.close()
  }
})

function restartCoordinator(context, options = {}) {
  return new MultiAccountBetCoordinator({
    db: context.handle.db,
    store: context.store,
    provider: context.provider,
    lease: context.lease,
    findLatestSelection: options.findLatestSelection || (() => latestSelection()),
    currentLeagueNames: ['英超'],
    now: options.now || (() => NOW),
  })
}

test('real worker without mode inbox performs no preview, batch creation, or network submit', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-real-toctou-')), 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  const stopHandle = openAppDatabase({ dbPath })
  seed(handle.db, { target: 50, accounts: [{ id: 'account-a', limit: 50 }] })
  const ready = Object.fromEntries([
    'watcherFresh', 'watcherLeaseUnique', 'monitorLoginFresh', 'bettingAccountFresh', 'balanceFresh',
    'capabilityExact', 'authorizationActive', 'schemaCurrent', 'environmentExact', 'fenceFresh',
    'executorLeaseFresh', 'reconcilerLeaseFresh', 'executorReconcilerDistinct',
  ].map((field) => [field, true]))
  requestRealBettingStart(handle.db, ready, { now: () => new Date(NOW) })
  handle.db.prepare(`INSERT INTO bet_market_once_claims
    (market_once_key,rule_id,signal_id,claim_status,created_at,updated_at)
    VALUES ('real-stop-claim','rule-a',?,'claimed',?,?)`).run(SIGNAL_ID, NOW, NOW)
  let previewCount = 0
  let submitCount = 0
  const provider = {
    async preview() {
      previewCount += 1
      requestRealBettingStop(stopHandle.db, { now: () => new Date(NOW) })
      return { ok: true, minStakeMinor: 10, maxStakeMinor: 50, stakeStepMinor: 10, balanceMinor: 100, odds: '0.88' }
    },
    async submit() { submitCount += 1; return { status: 'accepted' } },
  }
  const lease = {
    leaseKey: 'betting-executor:real-test', ownerId: 'real-owner', fencingToken: 8,
    acquire() { return { fencingToken: 8 } }, assertFence() { return 8 }, heartbeat() {}, release() { return true },
  }
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key,owner_id,pid,acquired_at,heartbeat_at,expires_at,fencing_token)
    VALUES ('betting-executor:real-test','real-owner',1,?,?,?,8)`)
    .run(NOW, NOW, '2099-07-11T02:10:00.000Z')
  const processLease = {
    leaseKey: `betting-worker:${path.resolve(dbPath)}`, ownerId: 'worker-owner', fencingToken: 1,
    assertFence() { return 1 }, heartbeat() {},
  }
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key,owner_id,pid,acquired_at,heartbeat_at,expires_at,fencing_token)
    VALUES (?, 'worker-owner',1,?,?,'2099-07-11T02:10:00.000Z',1)`)
    .run(processLease.leaseKey, NOW, NOW)
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }),
    provider,
    lease,
    findLatestSelection: () => latestSelection(),
    currentLeagueNames: [signal().evidence.league],
    now: () => NOW,
    realExecutionGate: () => true,
    processLease,
  })
  const worker = new BettingWorker({
    mode: 'real', db: handle.db, coordinator, lease, processLease,
    realExecutionGate: () => true, authorizationId: 'offline-stop-authorization',
  })
  try {
    let outcome
    let failure
    try { outcome = await worker.runOnce() } catch (error) { failure = error }
    assert.equal(previewCount, 0, JSON.stringify({ outcome, failure: failure?.message }))
    assert.equal(failure, undefined)
    assert.deepEqual(outcome, { mode: 'real', processed: 0, results: [] })
    assert.equal(submitCount, 0)
    const batches = handle.db.prepare('SELECT batch_id,status,finish_reason FROM bet_batches').all()
    assert.equal(batches.length, 0, JSON.stringify(batches))
  } finally {
    worker.stop()
    stopHandle.close()
    handle.close()
  }
})

test('real Coordinator creates no authorization budget and delegates the reserved child only to B2', async () => {
  const context = fixture({ target: 50, accounts: [{ id: 'account-a', limit: 50 }] })
  const env = {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '0',
    CROWN_REAL_MAX_TOTAL_MINOR: '50',
  }
  context.handle.db.prepare(`
    UPDATE betting_rules SET execution_mode = 'real_eligible' WHERE id = 'rule-a'
  `).run()
  context.handle.db.prepare(`
    UPDATE runtime_leases SET expires_at = '2099-07-11T02:10:00.000Z'
    WHERE lease_key = ?
  `).run(context.lease.leaseKey)
  context.handle.db.prepare(`
    INSERT INTO bet_market_once_claims (
      market_once_key, rule_id, signal_id, claim_status, created_at, updated_at
    ) VALUES ('real-b2-claim', 'rule-a', ?, 'claimed', ?, ?)
  `).run(SIGNAL_ID, NOW, NOW)
  const ready = Object.fromEntries([
    'ruleCardsEnabled', 'bettingAccountAvailable', 'capabilityExact',
    'schemaCurrent', 'fenceFresh', 'executorLeaseFresh',
  ].map((field) => [field, true]))
  requestRealBettingStart(context.handle.db, ready, { now: () => new Date(NOW) })
  const processLease = {
    leaseKey: 'betting-worker:coordinator-b2', ownerId: 'worker-owner', fencingToken: 9,
    assertFence() { return 9 }, heartbeat() {},
  }
  context.handle.db.prepare(`
    INSERT INTO runtime_leases (
      lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token
    ) VALUES (?, ?, 1, ?, ?, '2099-07-11T02:10:00.000Z', 9)
  `).run(processLease.leaseKey, processLease.ownerId, NOW, NOW)

  let b2Input = null
  const b2Executor = {
    async submit(input) {
      b2Input = structuredClone(input)
      const child = context.handle.db.prepare(`
        SELECT child.status, child.submit_attempt_id, batch.authorization_id,
               budget.status AS binding_status, budget.amount_minor
        FROM bet_child_orders AS child
        JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
        LEFT JOIN execution_authorization_child_budgets AS budget ON budget.child_order_id = child.child_order_id
        WHERE child.child_order_id = ?
      `).get(input.childOrderId)
      assert.deepEqual({ ...child }, {
        status: 'reserved',
        submit_attempt_id: '',
        authorization_id: null,
        binding_status: null,
        amount_minor: null,
      })
      throw new Error('offline-b2-stop-after-authority-check')
    },
  }
  const store = context.store
  store.prepareSubmit = () => { throw new Error('legacy-store-prepare-must-not-run') }
  const coordinator = new MultiAccountBetCoordinator({
    db: context.handle.db,
    store,
    provider: context.provider,
    b2Executor,
    lease: context.lease,
    processLease,
    findLatestSelection: () => latestSelection(),
    currentLeagueNames: [signal().evidence.league],
    now: () => NOW,
    realExecutionGate: () => true,
    executionEnvironment: env,
  })
  try {
    await assert.rejects(
      coordinator.processSignal(signal(), { mode: 'real' }),
      /offline-b2-stop-after-authority-check/,
    )
    assert.equal(Object.hasOwn(b2Input, 'authorizationId'), false)
    assert.equal(b2Input.ruleId, 'rule-a')
    assert.equal(b2Input.accountId, 'account-a')
    assert.equal(b2Input.amountMinor, 50)
    assert.equal(b2Input.attemptOrdinal, 1)
    assert.match(b2Input.submitAttemptId, /^[a-f0-9]{64}$/)
    assert.equal(b2Input.lockedSelection.selectionIdentity, latestSelection().selection.selectionIdentity)
    assert.equal(context.provider.submitCalls.length, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_submit_attempts').get().count, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorizations').get().count, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('temp-file real Coordinator reaches the neutral immutable B2 ledger and reopens unknown without resubmit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-real-shaped-'))
  const dbPath = path.join(dir, 'app.sqlite')
  const env = { CROWN_REAL_CURRENCY: 'CNY', CROWN_REAL_AMOUNT_SCALE: '0', CROWN_REAL_MAX_TOTAL_MINOR: '50' }
  let handle = openAppDatabase({ dbPath })
  try {
    seed(handle.db, { target: 50, accounts: [{ id: 'account-a', limit: 50 }] })
    const lease = {
      leaseKey: 'betting-executor:real-shaped', ownerId: 'fixture-owner', fencingToken: 17,
      assertFence(token = 17) { assert.equal(token, 17); return 17 },
    }
    const processLease = {
      leaseKey: `betting-worker:${path.resolve(dbPath)}`, ownerId: 'fixture-worker', fencingToken: 18,
      assertFence(token = 18) { assert.equal(token, 18); return 18 },
    }
    for (const item of [lease, processLease]) handle.db.prepare(`
      INSERT INTO runtime_leases (lease_key,owner_id,pid,acquired_at,heartbeat_at,expires_at,fencing_token)
      VALUES (?,?,1,?,?,'2099-01-01T00:00:00.000Z',?)
    `).run(item.leaseKey, item.ownerId, NOW, NOW, item.fencingToken)
    handle.db.prepare(`INSERT INTO bet_market_once_claims
      (market_once_key,rule_id,signal_id,claim_status,created_at,updated_at)
      VALUES ('real-shaped-claim','rule-a',?,'claimed',?,?)`).run(SIGNAL_ID, NOW, NOW)
    const productionChecks = collectRealBettingPreflight(handle, { env, now: () => new Date(NOW) })
    assert.equal(productionChecks.capabilityExact, false)
    const ready = Object.fromEntries([
      'ruleCardsEnabled','bettingAccountAvailable','capabilityExact',
      'schemaCurrent','fenceFresh','executorLeaseFresh',
    ].map((field) => [field, true]))
    requestRealBettingStart(handle.db, ready, { now: () => new Date(NOW) })
    const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
    store.prepareSubmit = () => { throw new Error('legacy-store-prepare-must-not-run') }
    store.markDispatched = () => { throw new Error('legacy-store-dispatch-must-not-run') }
    let fixtureSubmits = 0
    const options = { env, now: () => new Date(NOW) }
    const b2Executor = { async submit(input) {
      fixtureSubmits += 1
      const fixtureIdentity = {
        provider: 'fixture', gid: '8878931', mode: 'prematch', period: 'full_time',
        market: 'asian_handicap', lineVariant: 'main', line: '-0.50', side: 'away',
      }
      const gate = {
        ruleId: input.ruleId, batchId: input.batchId,
        childOrderId: input.childOrderId, accountId: input.accountId,
        leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
        submitAttemptId: input.submitAttemptId,
      }
      prepareSubmitAttempt(handle.db, {
        ...gate, attemptOrdinal: input.attemptOrdinal,
        capabilityVersion: 'b2-ledger-fixture-v1', capabilityEvidenceId: 'fixture:b2-ledger:offline:v1',
        lockedIdentity: fixtureIdentity, currentIdentity: fixtureIdentity,
        preview: { minStakeMinor: 10, maxStakeMinor: 50, balanceMinor: 100, stakeStepMinor: 10, odds: '0.88', line: fixtureIdentity.line },
      }, options)
      recordSubmitDispatch(handle.db, gate, options)
      return recordSubmitOutcome(handle.db, { ...gate, outcome: { kind: 'pending' }, hasFutureCapacity: false }, options)
    } }
    const provider = new ConcurrentProvider()
    const coordinator = new MultiAccountBetCoordinator({
      db: handle.db, store, provider, b2Executor, lease, processLease,
      findLatestSelection: () => latestSelection(), currentLeagueNames: [signal().evidence.league],
      now: () => NOW, realExecutionGate: () => true, executionEnvironment: env,
    })
    const result = await coordinator.processSignal(signal(), { mode: 'real' })
    assert.equal(result.status, 'waiting_result', JSON.stringify({
      result,
      children: handle.db.prepare('SELECT status,error_code,error_message FROM bet_child_orders').all(),
      attempts: handle.db.prepare('SELECT status,error_code FROM bet_submit_attempts').all(),
    }))
    assert.equal(fixtureSubmits, 1)
    assert.equal(provider.submitCalls.length, 0)
    assert.deepEqual(handle.db.prepare('SELECT status,attempt_ordinal FROM bet_submit_attempts').all().map((row) => ({ ...row })), [
      { status: 'unknown', attempt_ordinal: 1 },
    ])
    handle.close()
    handle = openAppDatabase({ dbPath })
    const reopenedStore = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
    const reopened = new MultiAccountBetCoordinator({
      db: handle.db, store: reopenedStore, provider, b2Executor, lease, processLease,
      findLatestSelection: () => latestSelection(), currentLeagueNames: [signal().evidence.league],
      now: () => NOW, realExecutionGate: () => true,
    })
    const reopenedBatchId = handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
    assert.equal((await reopened.runBatch(reopenedBatchId, { mode: 'real' })).status, 'waiting_result')
    assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM bet_submit_attempts WHERE status='unknown'").get().count, 1)
    assert.equal(fixtureSubmits, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM execution_authorizations').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM execution_authorization_child_budgets').get().count, 0)
  } finally {
    try { handle.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real Coordinator refuses a second submit after a dispatched attempt has an uncertain result', async () => {
  let submitted = null
  const db = {
    prepare(sql) {
      if (sql.includes('FROM bet_submit_attempts')) {
        return { get: () => ({ attempt_ordinal: 1, status: 'odds_changed_unsent', submit_attempt_id: 'first-id' }) }
      }
      throw new Error(`unexpected-sql:${sql}`)
    },
  }
  const lease = {
    leaseKey: 'betting-executor:ordinal', ownerId: 'owner', fencingToken: 4,
    assertFence() { return 4 },
  }
  const coordinator = new MultiAccountBetCoordinator({
    db,
    store: { leaseKey: lease.leaseKey },
    provider: { async preview() {}, async submit() { throw new Error('legacy-submit') } },
    b2Executor: { async submit(input) { submitted = input; return { child: { status: 'accepted' } } } },
    lease,
    findLatestSelection: () => null,
    realExecutionGate: () => true,
  })
  await assert.rejects(coordinator._submitChild({
    authorizationId: 'auth-ordinal', ruleId: 'rule-a', batchId: 'batch-a',
    childOrderId: 'child-a', accountId: 'account-a', amountMinor: 20, attempt: 1,
  }, { provider: 'fixture' }, 4, 'real'), /submit-attempt-uncertain/)
  assert.equal(submitted, null)
})

test('real child preview identity drift stops the whole batch before legacy submit', async () => {
  let stopped = null
  let networkCalls = 0
  const childStates = new Map([['child-a', 'reserved'], ['child-b', 'reserved']])
  const db = { prepare: () => ({ get: () => undefined }) }
  const lease = { leaseKey: 'betting-executor:drift', ownerId: 'owner', fencingToken: 5, assertFence: () => 5 }
  const coordinator = new MultiAccountBetCoordinator({
    db,
    store: { leaseKey: lease.leaseKey },
    provider: { async preview() {}, async submit() { throw new Error('legacy-submit') } },
    b2Executor: {
      async submit(input) {
        if (input.childOrderId === 'child-a') throw new Error('current-identity-mismatch')
        await tick()
        if (childStates.get(input.childOrderId) === 'cancelled') throw new Error('authorization-child-not-reserved')
        networkCalls += 1
        return { child: { status: 'accepted' } }
      },
    },
    lease,
    findLatestSelection: () => null,
    realExecutionGate: () => true,
  })
  coordinator._stopBatch = (batchId, reason) => {
    stopped = { batchId, reason }
    for (const [childId, status] of childStates) if (status === 'reserved') childStates.set(childId, 'cancelled')
    return { status: 'cancelled' }
  }
  const childA = {
    authorizationId: 'auth-a', ruleId: 'rule-a', batchId: 'batch-a',
    childOrderId: 'child-a', accountId: 'account-a', amountMinor: 20, attempt: 1,
  }
  const childB = { ...childA, childOrderId: 'child-b', accountId: 'account-b' }
  const settled = await Promise.allSettled([
    coordinator._submitChild(childA, { provider: 'fixture' }, 5, 'real'),
    coordinator._submitChild(childB, { provider: 'fixture' }, 5, 'real'),
  ])
  assert.deepEqual(stopped, { batchId: 'batch-a', reason: 'market_changed' })
  assert.equal(settled[0].status, 'fulfilled')
  assert.equal(settled[0].value.status, 'cancelled')
  assert.equal(settled[1].status, 'rejected')
  assert.equal(childStates.get('child-b'), 'cancelled')
  assert.equal(networkCalls, 0)

  childStates.set('child-b', 'submit_prepared')
  const prepared = await coordinator._submitChild(childB, { provider: 'fixture' }, 5, 'real')
  assert.equal(prepared.status, 'accepted')
  assert.equal(childStates.get('child-b'), 'submit_prepared')
  assert.equal(networkCalls, 1)
})

test('requires a strict lease-keyed Store instead of relying only on an external fence check', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  assert.throws(() => new MultiAccountBetCoordinator({
    db: handle.db,
    store: new BetBatchStore(handle.db, { fencingToken: 7 }),
    provider: new ConcurrentProvider(),
    lease: { fencingToken: 7, assertFence: () => 7 },
    findLatestSelection: () => latestSelection(),
    currentLeagueNames: ['英超'],
  }), /coordinator-store-lease/)
  handle.close()
})

test('requires the Store and RuntimeLease to use the exact same lease key', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  assert.throws(() => new MultiAccountBetCoordinator({
    db: handle.db,
    store: new BetBatchStore(handle.db, { fencingToken: 7, leaseKey: 'betting-executor:other' }),
    provider: new ConcurrentProvider(),
    lease: { leaseKey: 'betting-executor:test', fencingToken: 7, assertFence: () => 7 },
    findLatestSelection: () => latestSelection(),
    currentLeagueNames: ['英超'],
  }), /coordinator-store-lease/)
  handle.close()
})

function lockAccountForAnotherBatch(context, accountId) {
  const otherSignalId = 'b'.repeat(64)
  context.handle.db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
    ) VALUES (?, 'other-key', 'strategy', 1, 'ready', ?, ?, '{}')
  `).run(otherSignalId, signal().observedAt, signal().expiresAt)
  const other = context.store.createBatch({
    signalId: otherSignalId, ruleId: 'rule-a', currency: 'CNY', amountScale: 0,
    targetAmountMinor: 60, ruleVersion: 1, createdAt: NOW,
  }, { fencingToken: 7 })
  context.store.reserveRound(other.batchId, [{
    accountId, amountMinor: 60, previewMinStakeMinor: 10, previewMaxStakeMinor: 60,
    previewBalanceMinor: 1000, previewStakeStepMinor: 10, previewOdds: '0.88',
  }], { fencingToken: 7 })
}

test('a persisted rejection never retries the rejected account while a locked unused account waits', async () => {
  const provider = new ConcurrentProvider({ submitByAccount: {
    'account-a': [{ status: 'rejected', errorCode: 'sim-rejected' }],
  } })
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }, { id: 'account-b', limit: 60 }], provider })
  try {
    lockAccountForAnotherBatch(context, 'account-b')
    const first = await context.coordinator.processSignal(signal())
    assert.equal(first.status, 'waiting_capacity')
    assert.deepEqual(provider.submitCalls.map((call) => call.accountId), ['account-a'])
    const replay = await context.coordinator.processSignal(signal())
    assert.equal(replay.status, 'waiting_capacity')
    assert.deepEqual(provider.submitCalls.map((call) => call.accountId), ['account-a'])
  } finally {
    context.handle.close()
  }
})

test('temporary preview failure waits for capacity while definitively having no eligible account fails', async () => {
  const transientProvider = {
    networkCallCount: 0,
    async preview() { throw Object.assign(new Error('temporary-preview'), { code: 'temporary-preview' }) },
    async submit() { throw new Error('submit-not-expected') },
  }
  const waiting = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }], provider: transientProvider })
  try {
    assert.equal((await waiting.coordinator.processSignal(signal())).status, 'waiting_capacity')
  } finally {
    waiting.handle.close()
  }

  const failed = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }] })
  try {
    failed.handle.db.prepare("UPDATE betting_accounts SET status = 'disabled'").run()
    assert.equal((await failed.coordinator.processSignal(signal())).status, 'failed')
  } finally {
    failed.handle.close()
  }
})

test('a fresh Preview outside the frozen rule odds range is never reserved or submitted', async () => {
  let submitCalls = 0
  const provider = {
    networkCallCount: 0,
    async preview() {
      return {
        ok: true,
        minStakeMinor: 10,
        maxStakeMinor: 100,
        stakeStepMinor: 10,
        balanceMinor: 100,
        odds: '1.19',
      }
    },
    async submit() { submitCalls += 1; return { status: 'accepted' } },
  }
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }], provider })
  try {
    context.handle.db.prepare(`UPDATE betting_rules
      SET target_odds_min='0.75', target_odds_max='1.18'
      WHERE id='rule-a'`).run()
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'waiting_capacity')
    assert.equal(submitCalls, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) count FROM bet_child_orders').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('waiting capacity expires without another preview or submit', async () => {
  let currentTime = NOW
  let previews = 0
  let submits = 0
  const provider = {
    networkCallCount: 0,
    async preview() {
      previews += 1
      throw Object.assign(new Error('temporary-preview'), { code: 'temporary-preview' })
    },
    async submit() { submits += 1; return { status: 'accepted' } },
  }
  const context = fixture({
    target: 60,
    accounts: [{ id: 'account-a', limit: 60 }],
    provider,
    now: () => currentTime,
  })
  try {
    assert.equal((await context.coordinator.processSignal(signal())).status, 'waiting_capacity')
    const previewsBeforeExpiry = previews
    currentTime = signal().expiresAt
    const result = await context.coordinator.runBatch(context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.finishReason, 'expired')
    assert.equal(previews, previewsBeforeExpiry)
    assert.equal(submits, 0)
  } finally {
    context.handle.close()
  }
})

for (const change of ['market', 'stage']) {
  test(`afterReserve recovery stops before submit when the locked ${change} changes`, async () => {
    let latest = change === 'stage'
      ? latestSelection({ mode: 'live', event: { mode: 'live', livePhase: 'first_half' } })
      : latestSelection()
    const signalInput = change === 'stage'
      ? signal({ evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: 'first_half', liveMinute: 30 } })
      : signal()
    let crashed = false
    const context = fixture({
      target: 60,
      accounts: [{ id: 'account-a', limit: 60 }],
      signalInput,
      findLatestSelection: () => latest,
      faultInjector(phase) {
        if (!crashed && phase === 'afterReserve') {
          crashed = true
          throw new Error('crash:afterReserve')
        }
      },
    })
    try {
      await assert.rejects(context.coordinator.processSignal(signalInput), /crash:afterReserve/)
      assert.equal(context.provider.submitCalls.length, 0)
      latest = change === 'market'
        ? latestSelection({ market: { handicap: -0.75, handicapRaw: '-0.75' } })
        : latestSelection({ mode: 'live', event: { mode: 'live', livePhase: 'second_half' } })
      const restarted = restartCoordinator(context, { findLatestSelection: () => latest })
      const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
      const result = await restarted.runBatch(batchId)
      assert.equal(result.status, 'cancelled')
      assert.equal(result.finishReason, change === 'market' ? 'market_changed' : 'stage_changed')
      assert.equal(context.provider.submitCalls.length, 0)
      assert.deepEqual(context.store.listChildOrders(batchId).map((child) => child.status), ['cancelled'])
    } finally {
      context.handle.close()
    }
  })
}

for (const [name, changedSelection, finishReason] of [
  ['mode', latestSelection({ mode: 'live', event: { mode: 'live', livePhase: 'first_half' } }), 'stage_changed'],
  ['period', latestSelection({
    market: {
      period: 'first_half',
      marketIdentity: 'crown|football|gid=8878931|first_half|asian_handicap|RATIO_RE',
    },
  }), 'market_changed'],
  ['market type', latestSelection({
    market: {
      marketType: 'total',
      marketIdentity: 'crown|football|gid=8878931|full_time|total|RATIO_RE',
    },
  }), 'market_changed'],
  ['side', latestSelection({
    selection: {
      side: 'home',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
    },
  }), 'market_changed'],
  ['suspension', latestSelection({ selection: { suspended: true } }), 'market_changed'],
]) {
  test(`afterReserve recovery stops before submit when ${name} changes`, async () => {
    let latest = latestSelection()
    let crashed = false
    const context = fixture({
      target: 60,
      accounts: [{ id: 'account-a', limit: 60 }],
      findLatestSelection: () => latest,
      faultInjector(phase) {
        if (!crashed && phase === 'afterReserve') {
          crashed = true
          throw new Error('crash:afterReserve')
        }
      },
    })
    try {
      await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
      latest = changedSelection
      const restarted = restartCoordinator(context, { findLatestSelection: () => latest })
      const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
      const result = await restarted.runBatch(batchId)
      assert.equal(result.status, 'cancelled')
      assert.equal(result.finishReason, finishReason)
      assert.equal(context.provider.submitCalls.length, 0)
    } finally {
      context.handle.close()
    }
  })
}

test('odds changes keep the locked identity and submit with the latest snapshot', async () => {
  let latest = latestSelection()
  let crashed = false
  const context = fixture({
    target: 60,
    accounts: [{ id: 'account-a', limit: 60 }],
    findLatestSelection: () => latest,
    faultInjector(phase) {
      if (!crashed && phase === 'afterReserve') {
        crashed = true
        throw new Error('crash:afterReserve')
      }
    },
  })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
    latest = latestSelection({ selection: { odds: 1.01 } })
    const restarted = restartCoordinator(context, { findLatestSelection: () => latest })
    const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
    assert.equal((await restarted.runBatch(batchId)).status, 'completed')
    assert.equal(context.provider.submitCalls.length, 1)
    assert.equal(context.provider.submitCalls[0].lockedSelection.snapshot.selection.odds, 1.01)
  } finally {
    context.handle.close()
  }
})

test('afterReserve prematch recovery stops at kickoff even when the Signal has not expired', async () => {
  let currentTime = NOW
  let crashed = false
  const signalInput = signal({
    expiresAt: '2026-07-11T02:06:00.000Z',
    evidence: { minutesBeforeKickoff: 5 },
  })
  const context = fixture({
    target: 60,
    accounts: [{ id: 'account-a', limit: 60 }],
    signalInput,
    now: () => currentTime,
    faultInjector(phase) {
      if (!crashed && phase === 'afterReserve') {
        crashed = true
        throw new Error('crash:afterReserve')
      }
    },
  })
  try {
    await assert.rejects(context.coordinator.processSignal(signalInput), /crash:afterReserve/)
    currentTime = '2026-07-11T02:05:00.000Z'
    const restarted = restartCoordinator(context, { now: () => currentTime })
    const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
    const result = await restarted.runBatch(batchId)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.finishReason, 'stage_changed')
    assert.equal(context.provider.submitCalls.length, 0)
  } finally {
    context.handle.close()
  }
})

test('recovery fails closed when persisted prematch time evidence is no longer canonical', async () => {
  let crashed = false
  const context = fixture({
    target: 60,
    accounts: [{ id: 'account-a', limit: 60 }],
    faultInjector(phase) {
      if (!crashed && phase === 'afterReserve') {
        crashed = true
        throw new Error('crash:afterReserve')
      }
    },
  })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
    const persisted = signal({ observedAt: '2026-07-11T02:00:00Z' })
    context.handle.db.prepare('UPDATE monitor_signals SET payload_json = ? WHERE signal_id = ?')
      .run(JSON.stringify(persisted), persisted.signalId)
    const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
    const result = await restartCoordinator(context).runBatch(batchId)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.finishReason, 'signal_invalid')
    assert.equal(context.provider.submitCalls.length, 0)
  } finally {
    context.handle.close()
  }
})

for (const resolvedStatus of ['accepted', 'unknown']) {
  test(`expiry cancels unsent siblings while preserving ${resolvedStatus} money and locks`, async () => {
    let currentTime = NOW
    let crashed = false
    const context = fixture({
      target: 100,
      accounts: [{ id: 'account-a', limit: 50 }, { id: 'account-b', limit: 50 }],
      now: () => currentTime,
      faultInjector(phase) {
        if (!crashed && phase === 'afterReserve') {
          crashed = true
          throw new Error('crash:afterReserve')
        }
      },
    })
    try {
      await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
      const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
      context.store.reserveRound(batchId, [{
        accountId: 'account-b', amountMinor: 50, previewMinStakeMinor: 10, previewMaxStakeMinor: 50,
        previewBalanceMinor: 1000, previewStakeStepMinor: 10, previewOdds: '0.88',
      }], { fencingToken: 7 })
      const [resolved, unsent] = context.store.listChildOrders(batchId)
      context.store.prepareSubmit(resolved.childOrderId, { submitAttemptId: 'manual-result', fencingToken: 7, at: NOW })
      context.store.markDispatched(resolved.childOrderId, { fencingToken: 7, at: NOW })
      context.store.resolveChildOrder(resolved.childOrderId, { status: resolvedStatus, fencingToken: 7, at: NOW })
      currentTime = signal().expiresAt
      const restarted = restartCoordinator(context, { now: () => currentTime })
      const result = await restarted.runBatch(resolved.batchId)
      assert.equal(result.status, resolvedStatus === 'accepted' ? 'partial' : 'waiting_result')
      assert.equal(result.finishReason, 'expired')
      assert.equal(result.acceptedAmountMinor, resolvedStatus === 'accepted' ? 50 : 0)
      assert.equal(result.unknownAmountMinor, resolvedStatus === 'unknown' ? 50 : 0)
      assert.equal(context.store.listChildOrders(resolved.batchId).find((child) => child.childOrderId === unsent.childOrderId).status, 'cancelled')
      assert.equal(context.provider.submitCalls.length, 0)
      const locks = context.handle.db.prepare('SELECT child_order_id, status FROM betting_account_locks').all()
      assert.deepEqual(locks.map((row) => ({ ...row })), resolvedStatus === 'unknown'
        ? [{ child_order_id: resolved.childOrderId, status: 'unknown' }]
        : [])
    } finally {
      context.handle.close()
    }
  })
}

test('worker audits an expired waiting_result batch, cancels its reserved sibling, and never submits', async () => {
  let currentTime = NOW
  let crashed = false
  const context = fixture({
    target: 100,
    accounts: [{ id: 'account-a', limit: 50 }, { id: 'account-b', limit: 50 }],
    now: () => currentTime,
    faultInjector(phase) {
      if (!crashed && phase === 'afterReserve') {
        crashed = true
        throw new Error('crash:afterReserve')
      }
    },
  })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
    const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
    context.store.reserveRound(batchId, [{
      accountId: 'account-b', amountMinor: 50, previewMinStakeMinor: 10, previewMaxStakeMinor: 50,
      previewBalanceMinor: 1000, previewStakeStepMinor: 10, previewOdds: '0.88',
    }], { fencingToken: 7 })
    const [unknown, reserved] = context.store.listChildOrders(batchId)
    context.store.prepareSubmit(unknown.childOrderId, { submitAttemptId: 'unknown-result', fencingToken: 7, at: NOW })
    context.store.markDispatched(unknown.childOrderId, { fencingToken: 7, at: NOW })
    context.store.resolveChildOrder(unknown.childOrderId, { status: 'unknown', fencingToken: 7, at: NOW })
    currentTime = signal().expiresAt
    Object.assign(context.lease, {
      acquire() { return { fencingToken: 7 } },
      heartbeat() {},
      release() { return true },
    })
    const restarted = restartCoordinator(context, { now: () => currentTime })
    const worker = new BettingWorker({ mode: 'simulated', db: context.handle.db, coordinator: restarted, lease: context.lease })

    const run = await worker.runOnce()
    const result = context.store.getBatch(unknown.batchId)
    assert.equal(run.processed, 1)
    assert.equal(result.status, 'waiting_result')
    assert.equal(result.finishReason, 'expired')
    assert.equal(context.store.listChildOrders(unknown.batchId).find((child) => child.childOrderId === reserved.childOrderId).status, 'cancelled')
    assert.equal(context.provider.submitCalls.length, 0)
    worker.stop()
  } finally {
    context.handle.close()
  }
})

test('waiting_result keeps its first manual stop intent when a later audit reaches expiry', async () => {
  let currentTime = NOW
  let crashed = false
  const context = fixture({
    target: 100,
    accounts: [{ id: 'account-a', limit: 50 }, { id: 'account-b', limit: 50 }],
    now: () => currentTime,
    faultInjector(phase) {
      if (!crashed && phase === 'afterReserve') {
        crashed = true
        throw new Error('crash:afterReserve')
      }
    },
  })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /crash:afterReserve/)
    const [unknown] = context.store.listChildOrders(context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id)
    context.store.prepareSubmit(unknown.childOrderId, { submitAttemptId: 'manual-stop-unknown', fencingToken: 7, at: NOW })
    context.store.markDispatched(unknown.childOrderId, { fencingToken: 7, at: NOW })
    context.store.resolveChildOrder(unknown.childOrderId, { status: 'unknown', fencingToken: 7, at: NOW })
    const stopped = context.store.cancelUnsubmitted(unknown.batchId, { finishReason: 'manual_cancel', fencingToken: 7, at: NOW })
    assert.equal(stopped.status, 'waiting_result')
    assert.equal(stopped.finishReason, 'manual_cancel')

    currentTime = signal().expiresAt
    const result = await restartCoordinator(context, { now: () => currentTime }).runBatch(unknown.batchId)
    assert.equal(result.status, 'waiting_result')
    assert.equal(result.finishReason, 'manual_cancel')
    assert.equal(context.provider.submitCalls.length, 0)
  } finally {
    context.handle.close()
  }
})

test('preview script exhaustion before a usable account leaves the idempotent batch queued with no child mutations', async () => {
  const provider = new SimulatedBetProvider({ script: [{
    operation: 'preview',
    result: { ok: false },
  }] })
  const context = fixture({ provider })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /simulated-script-exhausted/)
    assert.deepEqual(provider.calls.map((call) => call.operation), ['preview'])
    assert.deepEqual({ ...context.handle.db.prepare('SELECT status FROM bet_batches').get() }, { status: 'queued' })
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('submit script exhaustion leaves children reserved and succeeds after script repair without duplicate preview', async () => {
  const preview = { ok: true, minStakeMinor: 10, maxStakeMinor: 50, stakeStepMinor: 10, balanceMinor: 1000, odds: '0.88' }
  const provider = new SimulatedBetProvider({ script: [
    { operation: 'preview', result: preview },
  ] })
  const context = fixture({ provider })
  try {
    await assert.rejects(context.coordinator.processSignal(signal()), /simulated-script-exhausted/)
    assert.deepEqual(provider.calls.map((call) => call.operation), ['preview'])
    assert.deepEqual(context.handle.db.prepare('SELECT status FROM bet_child_orders ORDER BY child_order_id').all().map((row) => row.status), ['reserved'])

    provider.script.push(
      { operation: 'submit', result: { status: 'accepted' } },
      { operation: 'preview', result: preview },
      { operation: 'submit', result: { status: 'accepted' } },
    )
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'completed')
    assert.deepEqual(provider.calls.map((call) => call.operation), ['preview', 'submit', 'preview', 'submit'])
  } finally {
    context.handle.close()
  }
})

test('previews and submits accounts strictly in order and replays one Signal idempotently', async () => {
  const context = fixture()
  try {
    const first = await context.coordinator.processSignal(signal())
    assert.equal(first.status, 'completed')
    assert.equal(context.provider.maxActivePreview, 1)
    assert.equal(context.provider.maxActiveSubmit, 1)
    assert.deepEqual(context.provider.submitCalls.map((call) => call.accountId), ['account-a', 'account-b'])
    assert.deepEqual(context.provider.submitCalls.map((call) => call.amountMinor), [50, 50])
    assert.equal(context.provider.submitCalls.length, 2)
    assert.equal(context.provider.submitCalls.reduce((sum, call) => sum + call.amountMinor, 0), 100)
    assert.equal(context.provider.networkCallCount, 0)

    const replay = await context.coordinator.processSignal(signal())
    assert.equal(replay.batchId, first.batchId)
    assert.equal(context.provider.submitCalls.length, 2)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 1)
  } finally {
    context.handle.close()
  }
})

test('preview mode performs concurrent read-only previews without creating a batch or submitting', async () => {
  const context = fixture()
  try {
    const result = await context.coordinator.processSignal(signal(), { mode: 'preview' })
    assert.equal(result.mode, 'preview')
    assert.equal(result.status, 'preview_only')
    assert.equal(result.allocations.reduce((sum, item) => sum + item.amountMinor, 0), 100)
    assert.equal(context.provider.maxActivePreview, 2)
    assert.equal(context.provider.submitCalls.length, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('a Preview without step evidence allocates only its exact minimum', async () => {
  const provider = new ConcurrentProvider()
  provider.preview = async function preview(input) {
    this.previewCalls.push(structuredClone(input))
    return {
      ok: true,
      minStakeMinor: 60,
      maxStakeMinor: 1000,
      stakeStepMinor: null,
      balanceMinor: 1000,
      odds: '0.88',
    }
  }
  const context = fixture({
    target: 120,
    accounts: [{ id: 'account-a', limit: 200 }],
    provider,
  })
  try {
    const result = await context.coordinator.processSignal(signal())

    assert.equal(result.status, 'partial')
    assert.equal(result.acceptedAmountMinor, 60)
    assert.equal(result.unfilledAmountMinor, 60)
    assert.deepEqual(provider.submitCalls.map((call) => call.amountMinor), [60])
    assert.equal(context.handle.db.prepare(`
      SELECT preview_stake_step_minor FROM bet_child_orders
    `).get().preview_stake_step_minor, 0)
  } finally {
    context.handle.close()
  }
})

test('passes the Signal to the current whitelist source and fails closed on a mode mismatch', async () => {
  const context = fixture()
  let received = null
  context.coordinator.currentLeagueNames = (input) => {
    received = input
    return input?.evidence?.mode === 'live' ? ['英超'] : []
  }
  try {
    assert.equal(await context.coordinator.processSignal(signal()), null)
    assert.equal(received.signalId, signal().signalId)
    assert.equal(context.provider.previewCalls.length, 0)
    assert.equal(context.handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 0)
  } finally {
    context.handle.close()
  }
})

test('uses one account at most once per batch and leaves the remainder unfilled', async () => {
  const context = fixture({ target: 100, accounts: [{ id: 'account-a', limit: 60 }] })
  try {
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'partial')
    assert.equal(result.unfilledAmountMinor, 40)
    assert.deepEqual(context.provider.submitCalls.map((call) => call.amountMinor), [60])
    assert.equal(context.provider.maxActiveSubmit, 1)
  } finally {
    context.handle.close()
  }
})

test('per-account limit is editable configuration rather than a fixed 50 CNY ceiling', async () => {
  const context = fixture({ target: 80, accounts: [{ id: 'account-a', limit: 80 }] })
  try {
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'completed')
    assert.deepEqual(context.provider.submitCalls.map((call) => call.amountMinor), [80])
  } finally {
    context.handle.close()
  }
})

test('skips an account when the exact remaining amount violates Preview minimum or step', async () => {
  for (const target of [5, 15]) {
    const provider = new ConcurrentProvider()
    provider.preview = async function preview(input) {
      this.previewCalls.push(structuredClone(input))
      return input.accountId === 'account-a'
        ? { ok: true, minStakeMinor: 10, maxStakeMinor: 100, stakeStepMinor: 10, balanceMinor: 1000, odds: '0.88' }
        : { ok: true, minStakeMinor: 5, maxStakeMinor: 100, stakeStepMinor: 5, balanceMinor: 1000, odds: '0.88' }
    }
    const context = fixture({
      target,
      accounts: [{ id: 'account-a', limit: 100 }, { id: 'account-b', limit: 100 }],
      provider,
    })
    try {
      const result = await context.coordinator.processSignal(signal())
      assert.equal(result.status, 'completed')
      assert.deepEqual(provider.previewCalls.map((call) => call.accountId), ['account-a', 'account-b'])
      assert.deepEqual(provider.submitCalls.map((call) => [call.accountId, call.amountMinor]), [['account-b', target]])
    } finally {
      context.handle.close()
    }
  }
})

test('releases a rejected amount and offers it to the next unused account', async () => {
  const provider = new ConcurrentProvider({ submitByAccount: {
    'account-a': [{ status: 'rejected', errorCode: 'sim-rejected' }],
    'account-b': [{ status: 'accepted' }],
  } })
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }, { id: 'account-b', limit: 60 }], provider })
  try {
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'completed')
    assert.equal(result.acceptedAmountMinor, 60)
    assert.equal(result.unfilledAmountMinor, 0)
    assert.deepEqual(provider.submitCalls.map((call) => call.accountId), ['account-a', 'account-b'])
    assert.deepEqual(context.handle.db.prepare('SELECT status FROM bet_child_orders ORDER BY created_at, child_order_id').all().map((row) => row.status), ['rejected', 'accepted'])
  } finally {
    context.handle.close()
  }
})

test('keeps unknown amount and account lock without another submit', async () => {
  const provider = new ConcurrentProvider({ submitByAccount: { 'account-a': [{ status: 'unknown', errorCode: 'sim-timeout' }] } })
  const context = fixture({ target: 60, accounts: [{ id: 'account-a', limit: 60 }], provider })
  try {
    const result = await context.coordinator.processSignal(signal())
    assert.equal(result.status, 'waiting_result')
    assert.equal(result.unknownAmountMinor, 60)
    assert.equal(provider.submitCalls.length, 1)
    assert.deepEqual({ ...context.handle.db.prepare('SELECT status, fencing_token FROM betting_account_locks').get() }, { status: 'unknown', fencing_token: 7 })
    await context.coordinator.runBatch(result.batchId)
    assert.equal(provider.submitCalls.length, 1)
  } finally {
    context.handle.close()
  }
})

for (const crashPhase of ['afterReserve', 'afterPrepare', 'afterSubmitStarted', 'afterProviderResult']) {
  test(`restart after ${crashPhase} never duplicates a simulated submit`, async () => {
    let crashed = false
    const provider = new ConcurrentProvider()
    const context = fixture({
      target: 60,
      accounts: [{ id: 'account-a', limit: 60 }],
      provider,
      faultInjector(phase) {
        if (!crashed && phase === crashPhase) {
          crashed = true
          throw new Error(`crash:${phase}`)
        }
      },
    })
    try {
      await assert.rejects(context.coordinator.processSignal(signal()), new RegExp(`crash:${crashPhase}`))
      await tick()
      const callsBeforeRestart = provider.submitCalls.length
      const restarted = new MultiAccountBetCoordinator({
        db: context.handle.db,
        store: new BetBatchStore(context.handle.db, { fencingToken: 999, leaseKey: 'betting-executor:test', now: () => NOW }),
        provider,
        lease: context.lease,
        findLatestSelection: () => latestSelection(),
        currentLeagueNames: ['英超'],
        now: () => NOW,
      })
      const batchId = context.handle.db.prepare('SELECT batch_id FROM bet_batches').get().batch_id
      const workerLease = {
        leaseKey: 'betting-executor:test', fencingToken: 7,
        acquire() { return { fencingToken: 7 } }, assertFence() { return 7 }, heartbeat() {}, release() { return true },
      }
      const worker = new BettingWorker({ mode: 'simulated', db: context.handle.db, coordinator: restarted, lease: workerLease })
      await worker.runOnce()
      const result = restarted.store.getBatch(batchId)
      const expectedCalls = crashPhase === 'afterReserve' ? 1 : callsBeforeRestart
      assert.equal(provider.submitCalls.length, expectedCalls)
      if (crashPhase === 'afterReserve') assert.equal(result.status, 'completed')
      else assert.equal(result.status, 'waiting_result')
      assert.equal(provider.networkCallCount, 0)
    } finally {
      context.handle.close()
    }
  })
}
