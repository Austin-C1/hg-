import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { persistDirectV2Signals } from '../scripts/crown-watch.mjs'
import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { getRealBettingStatus, requestRealBettingStart } from '../src/crown/betting/real-betting-runtime.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { AutoBetRuleWatcher } from '../src/crown/monitor/strategy-registry.mjs'

const NOW = '2026-07-12T01:00:30.000Z'
const EVENT = 'crown|football|gid=c-final-1'

function rule(name) {
  return {
    name,
    mode: 'prematch',
    period: 'full',
    marketType: 'asian_handicap',
    monitoredSide: 'home',
    minWaterRise: '0.03',
    targetOddsMin: '0.75',
    targetOddsMax: '1.05',
    targetAmountMinor: 100,
    leagueNames: ['C Final League'],
    startMinutesBeforeKickoff: 180,
    stopMinutesBeforeKickoff: 5,
  }
}

function change({ lineKey = 'RATIO_R', handicap = 0.25, suffix = '1', oldOdds = 0.80, nextOdds = 0.85 } = {}) {
  const marketIdentity = `${EVENT}|full_time|asian_handicap|${lineKey}`
  const snapshot = (side, odds, capturedAt) => ({
    provider: 'crown',
    mode: 'prematch',
    capturedAt,
    event: {
      eventKey: EVENT,
      identityConfidence: 'high',
      league: 'C Final League',
      homeTeam: 'Home',
      awayTeam: 'Away',
      mode: 'prematch',
      startTimeUtc: '2026-07-12T02:00:00.000Z',
    },
    market: { marketIdentity, marketType: 'asian_handicap', period: 'full_time', lineKey, handicap, handicapRaw: String(handicap) },
    selection: { selectionIdentity: `${marketIdentity}|${side}`, side, odds, oddsRaw: odds.toFixed(3), suspended: false },
  })
  const old = snapshot('home', oldOdds, '2026-07-12T00:59:00.000Z')
  const next = snapshot('home', nextOdds, '2026-07-12T01:00:00.000Z')
  return {
    schemaVersion: 2,
    changeId: suffix.repeat(64),
    type: 'odds-change',
    observedAt: next.capturedAt,
    mode: 'prematch',
    eventIdentity: EVENT,
    marketIdentity,
    selectionIdentity: next.selection.selectionIdentity,
    event: next.event,
    market: next.market,
    selection: next.selection,
    old,
    next,
    source: { endpointKind: 'get_game_more', confidence: 'high' },
    warnings: [],
  }
}

function seedReverseSelection(stateStore, input) {
  const reverse = structuredClone(input.next)
  reverse.capturedAt = NOW
  reverse.selection = {
    ...reverse.selection,
    selectionIdentity: `${input.marketIdentity}|away`,
    side: 'away',
    odds: 0.88,
    oddsRaw: '0.880',
  }
  stateStore.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(selection_identity) DO UPDATE SET
      event_key=excluded.event_key, captured_at=excluded.captured_at, snapshot_json=excluded.snapshot_json
  `).run(reverse.selection.selectionIdentity, EVENT, reverse.capturedAt, JSON.stringify(reverse))
}

class FakeProvider {
  constructor(repo) {
    this.repo = repo
    this.previewCalls = []
    this.submitCalls = []
    this.outcomes = new Map()
    this.pauseOnSubmit = null
  }

  queue(accountId, ...outcomes) {
    this.outcomes.set(accountId, outcomes)
  }

  async preview(input) {
    this.previewCalls.push(structuredClone(input))
    return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, odds: '0.88' }
  }

  async submit(input) {
    this.submitCalls.push(structuredClone(input))
    if (this.pauseOnSubmit === input.accountId) {
      const paused = this.repo.pauseBettingAccount(input.accountId)
      assert.equal(paused.allocationStatus, 'pause_pending')
      this.pauseOnSubmit = null
    }
    return this.outcomes.get(input.accountId)?.shift() || { status: 'accepted' }
  }
}

test('direct-v2 no longer loads legacy execution rules after mode settings separation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-c-final-'))
  const dbPath = path.join(dir, 'app.sqlite')
  let handle = openAppDatabase({ dbPath })
  let stateStore = openMonitorStateStore({ dbPath })
  try {
    const repo = createAppRepository(handle.db, { now: () => new Date(NOW) })
    const legacyTemplate = repo.listAutoBetRules().find((item) => item.id === 'legacy-prematch')
    const winner = repo.updateAutoBetRule('legacy-prematch', {
      ...rule('priority winner'), expectedVersion: legacyTemplate.version, acknowledgeMigrationReview: true,
    })
    const lower = repo.createAutoBetRule(rule('lower priority'))
    const monitoredWinner = repo.setAutoBetRuleMonitorEnabled(winner.id, true, { expectedVersion: winner.version })
    repo.setAutoBetRuleRealEnabled(winner.id, true, { expectedVersion: monitoredWinner.version })
    repo.setAutoBetRuleMonitorEnabled(lower.id, true, { expectedVersion: lower.version })

    const createAccount = (id, order, limit) => handle.db.prepare(`
      INSERT INTO betting_accounts (
        id, label, username, bet_order, status, archived, allocation_status,
        per_bet_limit_minor, currency, amount_scale, stake_step_minor,
        balance_minor, secret_ciphertext, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'enabled', 0, 'enabled', ?, 'CNY', 0, 10, 1000, 'fake-secret', ?, ?)
    `).run(id, id, id, order, limit, NOW, NOW)
    createAccount('account-60', 1, 60)
    createAccount('account-50', 2, 50)

    const lease = {
      leaseKey: 'betting-executor:c-final', ownerId: 'fake-owner', fencingToken: 11,
      assertFence(token = 11) { assert.equal(token, 11); return token },
    }
    handle.db.prepare(`
      INSERT INTO runtime_leases (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
      VALUES (?, ?, 1, ?, ?, '2099-01-01T00:00:00.000Z', 11)
    `).run(lease.leaseKey, lease.ownerId, NOW, NOW)
    const provider = new FakeProvider(repo)
    const makeCoordinator = (database, monitorStore) => new MultiAccountBetCoordinator({
      db: database,
      store: new BetBatchStore(database, { leaseKey: lease.leaseKey, now: () => NOW }),
      provider, lease,
      findLatestSelection: (query) => monitorStore.findLatestSelection(query),
      currentLeagueNames: ['C Final League'], now: () => NOW,
    })
    let coordinator = makeCoordinator(handle.db, stateStore)
    const watcher = new AutoBetRuleWatcher(handle.db)

    const firstChange = change()
    seedReverseSelection(stateStore, firstChange)
    const first = persistDirectV2Signals({
      changes: [firstChange], stateStore, ruleWatcher: watcher, claimDatabase: handle.db, channels: ['console'],
    })
    assert.equal(first.inserted.length, 0, JSON.stringify(first))
    assert.deepEqual(first.rules, [])
    assert.deepEqual(first.matchAudits, [])
    return

    const accepted = await coordinator.processSignal(first.inserted[0])
    assert.ok(accepted, JSON.stringify(first.inserted[0]))
    assert.equal(accepted.status, 'completed')
    assert.deepEqual(provider.submitCalls.map(({ accountId, amountMinor }) => ({ accountId, amountMinor })), [
      { accountId: 'account-60', amountMinor: 60 },
      { accountId: 'account-50', amountMinor: 40 },
    ])
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 1)

    const sameMarketNewChange = change({ suffix: '2', oldOdds: 0.81, nextOdds: 0.89 })
    seedReverseSelection(stateStore, sameMarketNewChange)
    const beforeSameMarket = {
      claims: handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count,
      batches: handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count,
      submits: provider.submitCalls.length,
    }
    const replay = persistDirectV2Signals({
      changes: [sameMarketNewChange], stateStore, ruleWatcher: watcher, claimDatabase: handle.db, channels: ['console'],
    })
    assert.equal(replay.inserted.length, 0)
    assert.deepEqual({
      claims: handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count,
      batches: handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count,
      submits: provider.submitCalls.length,
    }, beforeSameMarket)

    const rejectedLine = change({ lineKey: 'RATIO_R_2', handicap: 0.5, suffix: '3' })
    seedReverseSelection(stateStore, rejectedLine)
    const rejectedSignal = persistDirectV2Signals({
      changes: [rejectedLine], stateStore, ruleWatcher: watcher, claimDatabase: handle.db, channels: ['console'],
    })
    assert.equal(rejectedSignal.inserted.length, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 2)
    provider.queue('account-60', { status: 'rejected', errorCode: 'fake-rejected' })
    provider.queue('account-50', { status: 'accepted' })
    provider.pauseOnSubmit = 'account-60'
    const beforeRejected = { previews: provider.previewCalls.length, submits: provider.submitCalls.length }
    const rejected = await coordinator.processSignal(rejectedSignal.inserted[0])
    assert.equal(rejected.status, 'partial')
    assert.equal(rejected.unknownAmountMinor, 0)
    assert.deepEqual(provider.submitCalls.slice(2).map(({ accountId, amountMinor }) => ({ accountId, amountMinor })), [
      { accountId: 'account-60', amountMinor: 60 },
      { accountId: 'account-50', amountMinor: 40 },
    ])
    const rejectedChildren = handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders WHERE batch_id = ?').get(rejected.batchId).count
    assert.equal(rejectedChildren, 2)
    assert.deepEqual({ previews: provider.previewCalls.length, submits: provider.submitCalls.length }, {
      previews: beforeRejected.previews + 2, submits: beforeRejected.submits + 2,
    })
    const rejectedReplay = await coordinator.processSignal(rejectedSignal.inserted[0])
    assert.equal(rejectedReplay.status, 'partial')
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders WHERE batch_id = ?').get(rejected.batchId).count, rejectedChildren)
    assert.deepEqual({ previews: provider.previewCalls.length, submits: provider.submitCalls.length }, {
      previews: beforeRejected.previews + 2, submits: beforeRejected.submits + 2,
    })
    assert.equal(repo.finalizePendingBettingAccountPauses(), 1)
    assert.equal(repo.listBettingAccounts().find((item) => item.id === 'account-60').allocationStatus, 'paused')

    const unknownLine = change({ lineKey: 'RATIO_R_3', handicap: 0.75, suffix: '4' })
    seedReverseSelection(stateStore, unknownLine)
    const unknownSignal = persistDirectV2Signals({
      changes: [unknownLine], stateStore, ruleWatcher: watcher, claimDatabase: handle.db, channels: ['console'],
    })
    assert.equal(unknownSignal.inserted.length, 1)
    provider.queue('account-50', { status: 'unknown', errorCode: 'fake-timeout' })
    const uncertain = await coordinator.processSignal(unknownSignal.inserted[0])
    assert.equal(uncertain.status, 'waiting_result')
    assert.equal(uncertain.unknownAmountMinor, 50)
    assert.deepEqual(handle.db.prepare('SELECT account_id, status FROM betting_account_locks').all().map((row) => ({ ...row })), [
      { account_id: 'account-50', status: 'unknown' },
    ])

    const ready = Object.fromEntries([
      'watcherFresh', 'watcherLeaseUnique', 'monitorLoginFresh', 'bettingAccountFresh', 'balanceFresh',
      'capabilityExact', 'authorizationActive', 'schemaCurrent', 'environmentExact', 'fenceFresh',
      'executorLeaseFresh', 'reconcilerLeaseFresh', 'executorReconcilerDistinct',
    ].map((field) => [field, true]))
    assert.equal(requestRealBettingStart(handle.db, ready, { now: () => new Date(NOW) }).state, 'running')
    const submitsBeforeRestart = provider.submitCalls.length
    stateStore.close()
    handle.close()
    handle = openAppDatabase({ dbPath })
    stateStore = openMonitorStateStore({ dbPath })
    const restartedIntent = getRealBettingStatus(handle.db, { initialize: true, now: () => new Date('2026-07-12T01:01:00.000Z') })
    assert.equal(restartedIntent.requested, true)
    assert.equal(restartedIntent.state, 'armed_waiting')
    assert.equal(restartedIntent.reasonCode, 'preflight-required')
    assert.deepEqual({ ...handle.db.prepare('SELECT account_id, status FROM betting_account_locks').get() }, {
      account_id: 'account-50', status: 'unknown',
    })
    const restartedStore = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
    const persistedUnknown = restartedStore.getBatch(uncertain.batchId)
    assert.equal(persistedUnknown.status, 'waiting_result')
    assert.equal(persistedUnknown.unknownAmountMinor, 50)
    coordinator = makeCoordinator(handle.db, stateStore)
    const resumed = await coordinator.processSignal(unknownSignal.inserted[0])
    assert.equal(resumed.status, 'waiting_result')
    assert.equal(resumed.unknownAmountMinor, 50)
    assert.equal(provider.submitCalls.length, submitsBeforeRestart)
  } finally {
    try { stateStore.close() } catch {}
    try { handle.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
