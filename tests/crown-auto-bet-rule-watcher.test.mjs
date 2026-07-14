import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { persistDirectV2Candidates, persistDirectV2Signals } from '../scripts/crown-watch.mjs'
import { AlertSettingsWatcher } from '../src/crown/monitor/alert-settings-watcher.mjs'
import {
  AutoBetRuleWatcher,
  autoBetRuleToStrategyRule,
} from '../src/crown/monitor/strategy-registry.mjs'
import {
  claimRankedRuleMatches,
  marketOnceKey,
} from '../src/crown/betting/market-once-store.mjs'
import { assertRealBettingRequested, requestRealBettingStart, requestRealBettingStop } from '../src/crown/betting/real-betting-runtime.mjs'

function database() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-rule-watcher-')), 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.dbPath = dbPath
  return handle
}

function canonicalOddsChange() {
  const eventIdentity = 'crown|football|gid=3001'
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_R`
  const selectionIdentity = `${marketIdentity}|home`
  const snapshot = (side, odds, capturedAt) => ({
    capturedAt,
    mode: 'prematch',
    event: { eventKey: eventIdentity, identityConfidence: 'high', league: 'Test League', homeTeam: 'Home', awayTeam: 'Away', mode: 'prematch', startTimeUtc: '2026-07-11T03:00:00.000Z' },
    market: { marketIdentity, marketType: 'asian_handicap', period: 'full_time', lineKey: 'RATIO_R', handicap: 0.25, handicapRaw: '+0/0.5' },
    selection: { selectionIdentity: `${marketIdentity}|${side}`, side, odds, oddsRaw: odds.toFixed(3), suspended: false },
  })
  const old = snapshot('home', 0.8, '2026-07-11T00:59:00.000Z')
  const next = snapshot('home', 0.85, '2026-07-11T01:00:00.000Z')
  return {
    schemaVersion: 2,
    changeId: 'a'.repeat(64),
    type: 'odds-change',
    observedAt: '2026-07-11T01:00:00.000Z',
    mode: 'prematch',
    eventIdentity,
    marketIdentity,
    selectionIdentity,
    event: next.event,
    market: next.market,
    selection: next.selection,
    old,
    next,
    source: { endpointKind: 'get_game_more', confidence: 'high' },
    warnings: [],
  }
}

function rule(name, mode = 'prematch') {
  const item = {
    name,
    mode,
    period: 'full',
    marketType: 'asian_handicap',
    monitoredSide: 'home',
    minWaterRise: '0.03',
    targetOddsMin: '0.75',
    targetOddsMax: '1.05',
    targetAmountMinor: 100,
    leagueNames: ['Test League'],
  }
  if (mode === 'prematch') return { ...item, startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5 }
  return { ...item, liveMinuteFrom: 10, liveMinuteTo: 75 }
}

function enable(repo, item) {
  return repo.setAutoBetRuleMonitorEnabled(item.id, true, { expectedVersion: item.version })
}

function change(lineKey = 'RATIO_R', handicap = 0.25) {
  const eventIdentity = 'crown|football|gid=3001'
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|${lineKey}`
  return {
    mode: 'prematch',
    eventIdentity,
    marketIdentity,
    selectionIdentity: `${marketIdentity}|home`,
    event: { eventKey: eventIdentity },
    market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineKey, handicap },
    selection: { side: 'home' },
    next: { mode: 'prematch', event: { eventKey: eventIdentity }, market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineKey, handicap }, selection: { side: 'home' } },
  }
}

test('rule watcher atomically swaps a fully valid revision and keeps last-known-good on one invalid row', () => {
  const handle = database()
  try {
    const repo = createAppRepository(handle.db)
    const first = enable(repo, repo.createAutoBetRule(rule('first')))
    const second = enable(repo, repo.createAutoBetRule(rule('second')))
    const watcher = new AutoBetRuleWatcher(handle.db)
    const initial = watcher.reload()
    assert.equal(initial.updated, true)
    assert.deepEqual(initial.rules.map((item) => item.id), [first.id, second.id])
    assert.deepEqual(initial.rules.map((item) => item.priority), [first.priority, second.priority])

    handle.db.prepare("UPDATE betting_rules SET min_water_rise = 'invalid', version = version + 1 WHERE id = ?").run(second.id)
    const rejected = watcher.reload()
    assert.equal(rejected.updated, false)
    assert.equal(rejected.reason, 'rule-revision-invalid')
    assert.equal(rejected.revision, initial.revision)
    assert.deepEqual(rejected.rules, initial.rules)

  } finally {
    handle.close()
  }
})

test('rule watcher rejects malformed row identity/version/time before replacing last-known-good', () => {
  const handle = database()
  try {
    const repo = createAppRepository(handle.db)
    enable(repo, repo.createAutoBetRule(rule('stable-contract')))
    let corruption = null
    const watcher = new AutoBetRuleWatcher({
      prepare(sql) {
        const statement = handle.db.prepare(sql)
        return {
          all() {
            const rows = statement.all()
            return corruption ? rows.map((row, index) => index === 0 ? { ...row, ...corruption } : row) : rows
          },
        }
      },
    })
    const initial = watcher.reload()
    for (const [field, value] of [['id', ''], ['version', 0], ['created_at', 'not-a-timestamp']]) {
      corruption = { [field]: value }
      const invalid = watcher.reload()
      assert.equal(invalid.reason, 'rule-revision-invalid', `${field} is rejected before LKG swap`)
      assert.equal(invalid.revision, initial.revision)
      assert.deepEqual(invalid.rules, initial.rules)
    }
  } finally {
    handle.close()
  }
})

test('rule watcher keeps last-known-good when the atomic SELECT throws', () => {
  const handle = database()
  try {
    const repo = createAppRepository(handle.db)
    enable(repo, repo.createAutoBetRule(rule('stable')))
    let failRead = false
    const watcher = new AutoBetRuleWatcher({
      prepare(sql) {
        if (failRead) throw new Error('sqlite-read-failed')
        return handle.db.prepare(sql)
      },
    })
    const initial = watcher.reload()
    failRead = true
    const failed = watcher.reload()
    assert.equal(failed.reason, 'rule-revision-invalid')
    assert.equal(failed.revision, initial.revision)
    assert.deepEqual(failed.rules, initial.rules)
  } finally {
    handle.close()
  }
})

test('canonical auto-bet rules become reverse-only ranked strategy rules', () => {
  const strategy = autoBetRuleToStrategyRule({
    id: 'rule-a', version: 3, priority: 2, createdAt: '2026-07-11T00:00:00.000Z',
    monitorEnabled: true, archived: false, ...rule('A'),
  })
  assert.equal(strategy.conditions.direction, 'up')
  assert.equal(strategy.conditions.oddsRange.min, null)
  assert.equal(strategy.conditions.oddsRange.max, null)
  assert.equal(strategy.betDirectionMode, 'reverse')
  assert.equal(strategy.bettingRuleId, 'rule-a')
})

test('priority winner owns one market forever while every matching rule keeps an audit', () => {
  const handle = database()
  try {
    const matches = [
      { strategyId: 'priority-2', priority: 2, createdAt: '2026-07-11T00:00:00.000Z' },
      { strategyId: 'priority-1', priority: 1, createdAt: '2026-07-11T00:00:01.000Z' },
    ]
    let triggers = 0
    const first = claimRankedRuleMatches(handle.db, {
      change: change(), actualSide: 'away', matches,
      createWinner: () => { triggers += 1; return { candidate: true, batch: true } },
    })
    assert.equal(first.audits.length, 2)
    assert.equal(first.winner.strategyId, 'priority-1')
    assert.equal(first.audits.filter((audit) => audit.claimed).length, 1)
    assert.equal(triggers, 1)

    for (const terminalStatus of ['rejected', 'partial', 'unknown', 'restart', 'replay']) {
      const replay = claimRankedRuleMatches(handle.db, {
        change: change(), actualSide: 'away', matches,
        claim: { claimStatus: terminalStatus },
        createWinner: () => { triggers += 1 },
      })
      assert.equal(replay.winner, null)
      assert.equal(replay.audits.length, 2)
    }
    assert.equal(triggers, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 1)
  } finally {
    handle.close()
  }
})

test('real market claim is rejected after stop before winner creation', () => {
  const handle = database()
  try {
    requestRealBettingStop(handle.db)
    let creates = 0
    assert.throws(() => claimRankedRuleMatches(handle.db, {
      mode: 'real', change: change(), actualSide: 'away',
      matches: [{ strategyId: 'real-rule', priority: 1, createdAt: '2026-07-11T00:00:00.000Z' }],
      createWinner: () => { creates += 1 },
    }), /real-betting-not-requested/)
    assert.equal(creates, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  } finally { handle.close() }
})

test('claim transaction rechecks intent after an outer gate passes and another connection stops', () => {
  const first = database()
  const second = openAppDatabase({ dbPath: first.dbPath })
  try {
    const ready = Object.fromEntries([
      'ruleCardsEnabled', 'bettingAccountAvailable', 'capabilityExact',
      'schemaCurrent', 'fenceFresh', 'executorLeaseFresh',
    ].map((field) => [field, true]))
    requestRealBettingStart(first.db, ready)
    assert.doesNotThrow(() => assertRealBettingRequested(first.db))
    requestRealBettingStop(second.db)
    assert.throws(() => claimRankedRuleMatches(first.db, {
      mode: 'real', change: change(), actualSide: 'away',
      matches: [{ strategyId: 'real-rule', priority: 1, createdAt: '2026-07-11T00:00:00.000Z' }],
    }), /real-betting-not-requested/)
    assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  } finally { second.close(); first.close() }
})

test('market-once key ignores odds but changes for line identity or value', () => {
  const base = change()
  const sameWithOdds = structuredClone(base)
  sameWithOdds.next.selection.odds = 0.88
  assert.equal(marketOnceKey(base, 'away'), marketOnceKey(sameWithOdds, 'away'))
  assert.notEqual(marketOnceKey(base, 'away'), marketOnceKey(change('RATIO_R_2', 0.25), 'away'))
  assert.notEqual(marketOnceKey(base, 'away'), marketOnceKey(change('RATIO_R', 0.5), 'away'))
  assert.notEqual(marketOnceKey(base, 'away'), marketOnceKey(base, 'home'))
  assert.throws(() => marketOnceKey(base, 'over'), /actualSide|marketType/)
  const total = change()
  total.market.marketType = 'total'
  total.next.market.marketType = 'total'
  total.marketIdentity = total.marketIdentity.replace('asian_handicap', 'total')
  total.market.marketIdentity = total.marketIdentity
  total.next.market.marketIdentity = total.marketIdentity
  assert.throws(() => marketOnceKey(total, 'home'), /actualSide|marketType/)
})

test('alert-settings watcher without a matching card produces Signal and delivery without inbox or Candidate coupling', () => {
  const handle = database()
  const stateStore = openMonitorStateStore({ dbPath: handle.dbPath })
  try {
    handle.db.prepare(`UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1, total_enabled=0,
      monitor_odds_min=.8, monitor_odds_max=1.2, water_move_threshold=.03, cooldown_seconds=60,
      start_minutes_before_kickoff=180, stop_minutes_before_kickoff=5, migration_review_required=0 WHERE mode='prematch'`).run()
    const watcher = new AlertSettingsWatcher(handle.db)
    const input = canonicalOddsChange()
    const source = { ...input.next, capturedAt: '2026-07-11T01:00:10.000Z' }
    const reverse = structuredClone(source)
    reverse.selection = { ...reverse.selection, selectionIdentity: `${input.marketIdentity}|away`, side: 'away', odds: 0.85, oddsRaw: '0.850' }
    for (const snapshot of [source, reverse]) {
      stateStore.db.prepare(`
        INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
        VALUES (?, ?, ?, ?)
      `).run(snapshot.selection.selectionIdentity, snapshot.event.eventKey, snapshot.capturedAt, JSON.stringify(snapshot))
    }

    const first = persistDirectV2Signals({
      changes: [input], stateStore, alertSettingsWatcher: watcher,
    })
    assert.equal(first.inserted.length, 1)
    assert.equal(Date.parse(first.inserted[0].expiresAt) > Date.parse(first.inserted[0].observedAt), true)
    assert.equal(Object.hasOwn(first.inserted[0], 'bettingRuleId'), false)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM auto_betting_signal_inbox').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_deliveries').get().count, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
    assert.equal(stateStore.countSignals(), 1)
    assert.equal(stateStore.countCandidates(), 0)

    const replay = persistDirectV2Signals({
      changes: [input], stateStore, alertSettingsWatcher: watcher,
    })
    assert.equal(replay.inserted.length, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM auto_betting_signal_inbox').get().count, 0)
    assert.equal(stateStore.countSignals(), 1)
    assert.equal(stateStore.countCandidates(), 0)
  } finally {
    stateStore.close()
    handle.close()
  }
})

test('direct-v2 poll source has no legacy betting-rule or candidate-store dependency', () => {
  const source = fs.readFileSync(new URL('../scripts/crown-watch.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function runDirectApiPollOnce')
  const end = source.indexOf('\nexport async function runDirectApiWatch', start)
  const directPoll = source.slice(start, end)
  assert.equal(directPoll.includes('loadBettingRules'), false)
  assert.equal(directPoll.includes('bettingRules'), false)
  assert.equal(directPoll.includes('candidateStore'), false)

  const persistStart = source.indexOf('export function persistDirectV2Signals')
  const persistBody = source.slice(persistStart, source.indexOf('\nexport function persistDirectV2Candidates', persistStart))
  const signature = persistBody.slice(0, persistBody.indexOf('} = {})'))
  assert.equal(signature.includes('channels'), false)
})
