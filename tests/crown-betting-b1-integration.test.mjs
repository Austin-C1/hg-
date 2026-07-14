import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { BettingWorker } from '../src/crown/betting/betting-worker.mjs'
import { deterministicBatchId } from '../src/crown/betting/betting-rule-matcher.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { SimulatedBetProvider } from '../src/crown/betting/simulated-bet-provider.mjs'

const INITIAL_NOW = '2026-07-11T02:01:00.000Z'
const LEAGUE = 'Integration League'
const RULE_ID = 'rule-b1-integration'

function mutableClock(initial = INITIAL_NOW) {
  let milliseconds = Date.parse(initial)
  return {
    date: () => new Date(milliseconds),
    iso: () => new Date(milliseconds).toISOString(),
    advance: (amount) => { milliseconds += amount },
  }
}

function signal({
  signalId,
  gid,
  observedAt = '2026-07-11T02:00:00.000Z',
  expiresAt = '2026-07-11T03:00:00.000Z',
} = {}) {
  const eventIdentity = `crown|football|gid=${gid}`
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_RE`
  return {
    schemaVersion: 2,
    signalId,
    status: 'pending',
    bettingRuleId: RULE_ID,
    observedAt,
    expiresAt,
    trigger: { type: 'odds-change', direction: 'up' },
    target: {
      eventIdentity,
      marketIdentity,
      selectionIdentity: `${marketIdentity}|home`,
      side: 'home',
    },
    evidence: {
      league: LEAGUE,
      nextOdds: 0.91,
      mode: 'prematch',
      marketType: 'asian_handicap',
      period: 'full_time',
      minutesBeforeKickoff: 60,
      livePhase: null,
      liveMinute: null,
      handicap: -0.5,
      handicapRaw: '-0.5',
    },
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
  }
}

function latestSelection(query, { odds = '0.88' } = {}) {
  const marketIdentity = `${query.eventKey}|${query.period}|${query.marketType}|${query.lineKey}`
  return {
    provider: 'crown',
    mode: 'prematch',
    capturedAt: INITIAL_NOW,
    event: { eventKey: query.eventKey, mode: 'prematch', livePhase: null },
    market: {
      marketIdentity,
      period: query.period,
      marketType: query.marketType,
      lineKey: query.lineKey,
      handicap: -0.5,
      handicapRaw: '-0.50',
    },
    selection: {
      selectionIdentity: `${marketIdentity}|${query.side}`,
      side: query.side,
      odds: Number(odds),
      oddsRaw: odds,
      suspended: false,
    },
  }
}

function temporaryDatabase(t, label) {
  const directory = mkdtempSync(path.join(tmpdir(), `crown-b1-${label}-`))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'app.sqlite')
}

function seedDatabase(db, {
  targetAmountMinor,
  accounts,
  signals,
} = {}) {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, monitor_enabled, real_betting_enabled,
      migration_review_required, archived, currency, amount_scale, target_amount_minor,
      league_names_json, version, bet_direction_mode, created_at, updated_at
    ) VALUES (?, 'B1 integration rule', 1, 'preview_only', 1, 1, 0, 0, 'CNY', 0, ?, ?, 1, 'up_reverse', ?, ?)
  `).run(RULE_ID, targetAmountMinor, JSON.stringify([LEAGUE]), INITIAL_NOW, INITIAL_NOW)

  accounts.forEach((account, index) => {
    db.prepare(`
      INSERT INTO betting_accounts (
        id, label, username, bet_order, status, archived, allocation_status, per_bet_limit_minor,
        currency, amount_scale, stake_step_minor, balance_minor, secret_ciphertext,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'enabled', 0, 'enabled', ?, 'CNY', 0, 10, ?, 'simulated-secret', ?, ?)
    `).run(
      account.id,
      account.id,
      account.id,
      index + 1,
      account.limit,
      account.balance ?? 10_000,
      INITIAL_NOW,
      INITIAL_NOW,
    )
  })

  signals.forEach((input, index) => {
    db.prepare(`
      INSERT INTO monitor_signals (
        signal_id, signal_key, strategy_id, strategy_version, status,
        observed_at, expires_at, payload_json
      ) VALUES (?, ?, 'b1-integration', 1, 'ready', ?, ?, ?)
    `).run(
      input.signalId,
      `b1-integration-${index}`,
      input.observedAt,
      input.expiresAt,
      JSON.stringify(input),
    )
  })
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

class InstrumentedSimulatedProvider extends SimulatedBetProvider {
  constructor(options) {
    super(options)
    this.active = { preview: 0, submit: 0 }
    this.maximum = { preview: 0, submit: 0 }
    this.activeByAccount = new Map()
    this.maximumByAccount = new Map()
  }

  async #tracked(operation, input, run) {
    this.active[operation] += 1
    this.maximum[operation] = Math.max(this.maximum[operation], this.active[operation])
    const active = this.activeByAccount.get(input.accountId) || { preview: 0, submit: 0 }
    const maximum = this.maximumByAccount.get(input.accountId) || { preview: 0, submit: 0 }
    active[operation] += 1
    maximum[operation] = Math.max(maximum[operation], active[operation])
    this.activeByAccount.set(input.accountId, active)
    this.maximumByAccount.set(input.accountId, maximum)
    try {
      await tick()
      return await run()
    } finally {
      this.active[operation] -= 1
      active[operation] -= 1
    }
  }

  preview(input) {
    return this.#tracked('preview', input, () => super.preview(input))
  }

  submit(input) {
    return this.#tracked('submit', input, () => super.submit(input))
  }
}

function previewResult({ max = 1_000, balance = 10_000, odds = '0.88' } = {}) {
  return {
    ok: true,
    minStakeMinor: 10,
    maxStakeMinor: max,
    stakeStepMinor: 10,
    balanceMinor: balance,
    currency: 'CNY',
    amountScale: 0,
    odds,
  }
}

function executor(handle, {
  ownerId,
  clock,
  provider,
  ttlMs = 60 * 60 * 1_000,
  maxRounds = 100,
} = {}) {
  const leaseKey = `betting-executor:${path.resolve(handle.dbPath)}`
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey,
    ownerId,
    pid: 1,
    ttlMs,
    now: clock.date,
  })
  const store = new BetBatchStore(handle.db, {
    leaseKey,
    now: clock.date,
  })
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store,
    provider,
    lease,
    findLatestSelection: (query) => latestSelection(query),
    currentLeagueNames: [LEAGUE],
    now: clock.iso,
    maxRounds,
  })
  const worker = new BettingWorker({ mode: 'simulated', db: handle.db, coordinator, lease })
  return { leaseKey, lease, store, coordinator, worker }
}

async function processLegacySignals(context, ...signals) {
  context.worker.start()
  const results = []
  for (const input of signals) {
    results.push(await context.coordinator.processSignal(input, { mode: 'simulated' }))
  }
  return results
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function ledgerSnapshot(db) {
  return plain({
    batches: db.prepare(`
      SELECT batch_id, signal_id, rule_id, event_key, locked_selection_identity,
             target_amount_minor, reserved_amount_minor, accepted_amount_minor,
             unknown_amount_minor, unfilled_amount_minor, status, finish_reason
      FROM bet_batches
      ORDER BY signal_id, batch_id
    `).all(),
    children: db.prepare(`
      SELECT child_order_id, batch_id, account_id, attempt, requested_amount_minor,
             preview_min_stake_minor, preview_max_stake_minor,
             preview_balance_minor, preview_stake_step_minor, preview_odds,
             status, submit_attempt_id, error_code
      FROM bet_child_orders
      ORDER BY batch_id, account_id, attempt, child_order_id
    `).all(),
    locks: db.prepare(`
      SELECT account_id, child_order_id, batch_id, status, fencing_token
      FROM betting_account_locks
      ORDER BY account_id
    `).all(),
  })
}

function assertMoneyInvariants(db) {
  const batches = db.prepare('SELECT * FROM bet_batches ORDER BY batch_id').all()
  for (const batch of batches) {
    for (const field of [
      'target_amount_minor',
      'reserved_amount_minor',
      'accepted_amount_minor',
      'unknown_amount_minor',
      'unfilled_amount_minor',
    ]) {
      assert.equal(Number.isSafeInteger(batch[field]), true, `${batch.batch_id}:${field}`)
      assert.equal(batch[field] >= 0, true, `${batch.batch_id}:${field}:nonnegative`)
    }
    assert.equal(
      batch.target_amount_minor,
      batch.reserved_amount_minor
        + batch.accepted_amount_minor
        + batch.unknown_amount_minor
        + batch.unfilled_amount_minor,
      `${batch.batch_id}:batch-total`,
    )
    const childTotals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'submit_prepared', 'submit_dispatched') THEN requested_amount_minor ELSE 0 END), 0) AS reserved,
        COALESCE(SUM(CASE WHEN status = 'accepted' THEN requested_amount_minor ELSE 0 END), 0) AS accepted,
        COALESCE(SUM(CASE WHEN status = 'unknown' THEN requested_amount_minor ELSE 0 END), 0) AS unknown
      FROM bet_child_orders
      WHERE batch_id = ?
    `).get(batch.batch_id)
    assert.equal(childTotals.reserved, batch.reserved_amount_minor)
    assert.equal(childTotals.accepted, batch.accepted_amount_minor)
    assert.equal(childTotals.unknown, batch.unknown_amount_minor)
  }
}

async function completedFixture(t, label) {
  const dbPath = temporaryDatabase(t, label)
  const handle = openAppDatabase({ dbPath })
  const input = signal({ signalId: 'a'.repeat(64), gid: 'deterministic-complete' })
  seedDatabase(handle.db, {
    targetAmountMinor: 120,
    accounts: [{ id: 'account-a', limit: 60 }, { id: 'account-b', limit: 60 }],
    signals: [input],
  })
  const clock = mutableClock()
  const provider = new InstrumentedSimulatedProvider({
    now: clock.date,
    script: [
      { operation: 'preview', result: previewResult({ max: 60 }) },
      { operation: 'submit', result: { status: 'accepted' } },
      { operation: 'preview', result: previewResult({ max: 60 }) },
      { operation: 'submit', result: { status: 'accepted' } },
    ],
  })
  const context = executor(handle, { ownerId: 'completed-owner', clock, provider })
  try {
    const first = await processLegacySignals(context, input)
    assert.equal(first.length, 1)
    const callsAfterFirstRun = provider.calls.length
    const snapshotAfterFirstRun = ledgerSnapshot(handle.db)
    const replay = await context.worker.runOnce()
    assert.equal(replay.processed, 0)
    assert.equal(provider.calls.length, callsAfterFirstRun)
    assert.deepEqual(ledgerSnapshot(handle.db), snapshotAfterFirstRun)
    assert.equal(provider.networkCallCount, 0)
    assert.deepEqual(provider.calls.map((call) => call.operation), ['preview', 'submit', 'preview', 'submit'])
    assert.equal(provider.calls.some((call) => call.operation === 'FT_bet'), false)
    assert.equal(provider.maximum.preview, 1)
    assert.equal(provider.maximum.submit, 1)
    assertMoneyInvariants(handle.db)
    const batch = handle.db.prepare('SELECT * FROM bet_batches').get()
    assert.equal(batch.batch_id, deterministicBatchId(input.signalId, RULE_ID))
    assert.equal(batch.status, 'completed')
    assert.equal(batch.accepted_amount_minor, 120)
    assert.equal(batch.unfilled_amount_minor, 0)
    return ledgerSnapshot(handle.db)
  } finally {
    context.worker.stop()
    handle.close()
  }
}

test('two fresh databases produce identical deterministic ledgers, replay stably, and submit different accounts sequentially', async (t) => {
  const first = await completedFixture(t, 'deterministic-a')
  const second = await completedFixture(t, 'deterministic-b')
  assert.deepEqual(second, first)
  assert.equal(first.batches.length, 1)
  assert.equal(first.children.length, 2)
  assert.equal(new Set(first.children.map((child) => child.child_order_id)).size, 2)
})

test('one account is used at most once per batch and leaves the remainder unfilled', async (t) => {
  const dbPath = temporaryDatabase(t, 'single-account')
  const handle = openAppDatabase({ dbPath })
  const input = signal({ signalId: 'b'.repeat(64), gid: 'single-account' })
  seedDatabase(handle.db, {
    targetAmountMinor: 120,
    accounts: [{ id: 'account-only', limit: 60 }],
    signals: [input],
  })
  const clock = mutableClock()
  const provider = new InstrumentedSimulatedProvider({
    now: clock.date,
    script: [
      { operation: 'preview', result: previewResult({ max: 60 }) },
      { operation: 'submit', result: { status: 'accepted' } },
    ],
  })
  const context = executor(handle, { ownerId: 'single-owner', clock, provider })
  try {
    await processLegacySignals(context, input)
    const children = plain(handle.db.prepare(`
      SELECT account_id, attempt, requested_amount_minor, status
      FROM bet_child_orders
      ORDER BY attempt
    `).all())
    assert.deepEqual(children, [
      { account_id: 'account-only', attempt: 1, requested_amount_minor: 60, status: 'accepted' },
    ])
    const batch = handle.db.prepare('SELECT * FROM bet_batches').get()
    assert.equal(batch.status, 'partial')
    assert.equal(batch.finish_reason, 'partial_fulfillment')
    assert.equal(batch.accepted_amount_minor, 60)
    assert.equal(batch.unfilled_amount_minor, 60)
    assert.deepEqual(provider.calls.map((call) => call.operation), ['preview', 'submit'])
    assert.equal(provider.maximumByAccount.get('account-only').submit, 1)
    assert.equal(provider.networkCallCount, 0)
    assert.equal(provider.calls.some((call) => call.operation === 'FT_bet'), false)
    assertMoneyInvariants(handle.db)
  } finally {
    context.worker.stop()
    handle.close()
  }
})

async function unknownRestartFixture(t, label) {
  const dbPath = temporaryDatabase(t, label)
  const clock = mutableClock()
  const firstSignal = signal({
    signalId: 'c'.repeat(64),
    gid: 'deterministic-unknown',
    observedAt: '2026-07-11T02:00:00.000Z',
  })
  const secondSignal = signal({
    signalId: 'd'.repeat(64),
    gid: 'deterministic-contender',
    observedAt: '2026-07-11T02:00:01.000Z',
  })

  const firstHandle = openAppDatabase({ dbPath })
  seedDatabase(firstHandle.db, {
    targetAmountMinor: 50,
    accounts: [{ id: 'shared-account', limit: 50 }],
    signals: [firstSignal, secondSignal],
  })
  const firstProvider = new InstrumentedSimulatedProvider({
    now: clock.date,
    script: [
      { operation: 'preview', result: previewResult({ max: 50 }) },
      { operation: 'submit', result: { status: 'unknown', errorCode: 'simulated-timeout' } },
    ],
  })
  const first = executor(firstHandle, {
    ownerId: 'crashed-owner',
    clock,
    provider: firstProvider,
    ttlMs: 1_000,
  })
  await processLegacySignals(first, firstSignal, secondSignal)
  assert.equal(firstProvider.networkCallCount, 0)
  assert.deepEqual(firstProvider.calls.map((call) => call.operation), ['preview', 'submit'])
  const unknownBatchId = deterministicBatchId(firstSignal.signalId, RULE_ID)
  const contenderBatchId = deterministicBatchId(secondSignal.signalId, RULE_ID)
  assert.equal(firstHandle.db.prepare('SELECT status FROM bet_batches WHERE batch_id = ?').get(unknownBatchId).status, 'waiting_result')
  assert.equal(firstHandle.db.prepare('SELECT status FROM bet_batches WHERE batch_id = ?').get(contenderBatchId).status, 'waiting_capacity')
  assert.equal(firstHandle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders WHERE batch_id = ?').get(contenderBatchId).count, 0)
  assert.equal(firstHandle.db.prepare('SELECT fencing_token FROM betting_account_locks').get().fencing_token, 1)
  assertMoneyInvariants(firstHandle.db)

  // Simulate a process crash: close the database without releasing the first lease.
  firstHandle.close()
  clock.advance(2_000)

  const secondHandle = openAppDatabase({ dbPath })
  const restartProvider = new InstrumentedSimulatedProvider({ now: clock.date, script: [] })
  const restarted = executor(secondHandle, {
    ownerId: 'takeover-owner',
    clock,
    provider: restartProvider,
    ttlMs: 60_000,
  })
  try {
    const recovered = await restarted.worker.runOnce()
    assert.equal(recovered.processed, 2)
    assert.equal(restarted.lease.fencingToken, 2)
    assert.equal(restartProvider.networkCallCount, 0)
    assert.equal(restartProvider.calls.length, 0)
    assert.equal(secondHandle.db.prepare('SELECT fencing_token FROM betting_account_locks').get().fencing_token, 2)
    assert.equal(secondHandle.db.prepare('SELECT unknown_amount_minor FROM bet_batches WHERE batch_id = ?').get(unknownBatchId).unknown_amount_minor, 50)
    assert.equal(secondHandle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 1)

    const staleStore = new BetBatchStore(secondHandle.db, {
      leaseKey: restarted.leaseKey,
      fencingToken: 1,
      now: clock.date,
    })
    assert.throws(
      () => staleStore.reconcileAggregates(unknownBatchId, { fencingToken: 1 }),
      /fencing-token/,
    )

    const beforeReplay = ledgerSnapshot(secondHandle.db)
    await restarted.worker.runOnce()
    assert.deepEqual(ledgerSnapshot(secondHandle.db), beforeReplay)
    assert.equal(restartProvider.calls.length, 0)
    assertMoneyInvariants(secondHandle.db)
    return ledgerSnapshot(secondHandle.db)
  } finally {
    restarted.worker.stop()
    secondHandle.close()
  }
}

test('unknown retains its account lock, deterministic contention waits, and expired lease takeover never resubmits', async (t) => {
  const first = await unknownRestartFixture(t, 'unknown-a')
  const second = await unknownRestartFixture(t, 'unknown-b')
  assert.deepEqual(second, first)
  assert.equal(first.batches.find((batch) => batch.signal_id === 'c'.repeat(64)).status, 'waiting_result')
  assert.equal(first.batches.find((batch) => batch.signal_id === 'd'.repeat(64)).status, 'waiting_capacity')
  assert.equal(first.children.length, 1)
  assert.equal(first.children[0].status, 'unknown')
  assert.equal(first.locks.length, 1)
  assert.equal(first.locks[0].status, 'unknown')
  assert.equal(first.locks[0].fencing_token, 2)
})

async function partialFixture(t, label) {
  const dbPath = temporaryDatabase(t, label)
  const handle = openAppDatabase({ dbPath })
  const input = signal({
    signalId: 'e'.repeat(64),
    gid: 'deterministic-partial',
    expiresAt: '2026-07-11T02:05:00.000Z',
  })
  seedDatabase(handle.db, {
    targetAmountMinor: 100,
    accounts: [{ id: 'partial-account', limit: 50 }],
    signals: [input],
  })
  const clock = mutableClock()
  const provider = new InstrumentedSimulatedProvider({
    now: clock.date,
    script: [
      { operation: 'preview', result: previewResult({ max: 50 }) },
      { operation: 'submit', result: { status: 'accepted' } },
    ],
  })
  const context = executor(handle, {
    ownerId: 'partial-owner',
    clock,
    provider,
    ttlMs: 60 * 60 * 1_000,
    maxRounds: 1,
  })
  try {
    await processLegacySignals(context, input)
    let batch = handle.db.prepare('SELECT * FROM bet_batches').get()
    assert.equal(batch.status, 'partial')
    assert.equal(batch.finish_reason, 'partial_fulfillment')
    assert.equal(batch.accepted_amount_minor, 50)
    assert.equal(batch.unfilled_amount_minor, 50)
    assert.equal(provider.calls.length, 2)

    clock.advance(4 * 60 * 1_000)
    await context.worker.runOnce()
    batch = handle.db.prepare('SELECT * FROM bet_batches').get()
    assert.equal(batch.status, 'partial')
    assert.equal(batch.finish_reason, 'partial_fulfillment')
    assert.equal(batch.accepted_amount_minor, 50)
    assert.equal(batch.unknown_amount_minor, 0)
    assert.equal(batch.unfilled_amount_minor, 50)
    assert.equal(provider.calls.length, 2)
    assert.equal(provider.networkCallCount, 0)
    assert.equal(provider.calls.some((call) => call.operation === 'FT_bet'), false)
    assertMoneyInvariants(handle.db)
    return ledgerSnapshot(handle.db)
  } finally {
    context.worker.stop()
    handle.close()
  }
}

test('accepted money becomes a deterministic partial result after the only account is used and expiry never resubmits', async (t) => {
  const first = await partialFixture(t, 'partial-a')
  const second = await partialFixture(t, 'partial-b')
  assert.deepEqual(second, first)
  assert.equal(first.batches[0].status, 'partial')
  assert.equal(first.batches[0].finish_reason, 'partial_fulfillment')
  assert.equal(first.children.length, 1)
  assert.equal(first.children[0].status, 'accepted')
})
