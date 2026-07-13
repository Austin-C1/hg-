import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { AlertSettingsWatcher, alertSettingToStrategy } from '../src/crown/monitor/alert-settings-watcher.mjs'
import { evaluateOddsDelta } from '../src/crown/monitor/odds-delta-strategy.mjs'
import { MonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'

function openDb() {
  return openAppDatabase({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-alert-watcher-')), 'app.sqlite') })
}

function setting(mode, overrides = {}) {
  return {
    mode,
    enabled: true,
    asianHandicapEnabled: true,
    totalEnabled: true,
    monitorOddsMin: 0.8,
    monitorOddsMax: 1.2,
    waterMoveThreshold: 0.03,
    cooldownSeconds: 45,
    migrationReviewRequired: false,
    version: 3,
    ...(mode === 'prematch'
      ? { startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5 }
      : { liveMinuteFrom: 1, liveMinuteTo: 90, includeFirstHalf: true, includeHalfTime: false, includeSecondHalf: true }),
    ...overrides,
  }
}

function change({ mode = 'prematch', marketType = 'asian_handicap', period = 'full_time', livePhase = 'first_half', oldOdds = 0.9, nextOdds = 0.95 } = {}) {
  const eventIdentity = 'crown|football|gid=3001'
  const side = marketType === 'total' ? 'over' : 'home'
  const lineKey = marketType === 'total' ? 'OU_OUH' : 'RATIO_R'
  const marketIdentity = `${eventIdentity}|${period}|${marketType}|${lineKey}`
  const selectionIdentity = `${marketIdentity}|${side}`
  const event = {
    eventKey: eventIdentity, identityConfidence: 'high', league: 'Test League', homeTeam: 'Home', awayTeam: 'Away', mode,
    startTimeUtc: '2026-07-10T03:00:00.000Z', livePhase: mode === 'live' ? livePhase : null, liveMinute: mode === 'live' && livePhase !== 'half_time' ? 20 : null,
  }
  const market = { marketIdentity, marketType, period, lineKey, handicap: 0.25, handicapRaw: '+0/0.5' }
  const snapshot = (odds) => ({ mode, event: { eventKey: eventIdentity }, market, selection: { selectionIdentity, side, odds, oddsRaw: odds.toFixed(3) } })
  return {
    schemaVersion: 2, changeId: 'a'.repeat(64), type: 'odds-change', observedAt: '2026-07-10T01:00:00.000Z',
    eventIdentity, marketIdentity, selectionIdentity, event, market, selection: { selectionIdentity, side }, old: snapshot(oldOdds), next: snapshot(nextOdds),
    source: { endpointKind: 'get_game_more', confidence: 'high' }, warnings: [],
  }
}

test('both alert modes produce independent validated strategies with selected markets and windows', () => {
  const prematch = alertSettingToStrategy(setting('prematch', { totalEnabled: false }))
  const live = alertSettingToStrategy(setting('live', { asianHandicapEnabled: false, includeHalfTime: true }))
  assert.equal(prematch.id, 'monitor-alert:prematch')
  assert.equal(live.id, 'monitor-alert:live')
  assert.deepEqual(prematch.scope, { modes: ['prematch'], markets: ['asian_handicap'], periods: ['full_time'], leagues: [] })
  assert.deepEqual(live.scope.markets, ['total'])
  assert.deepEqual(prematch.conditions.kickoffWindow, { startMinutesBeforeKickoff: 180, stopMinutesBeforeKickoff: 5 })
  assert.deepEqual(live.conditions.liveWindow, { phases: ['first_half', 'half_time', 'second_half'], minuteFrom: 1, minuteTo: 90 })
  assert.equal(prematch.conditions.direction, 'both')
  assert.deepEqual(prematch.conditions.oddsRange, { min: 0.8, max: 1.2 })
  for (const forbidden of ['bettingRuleId', 'targetOddsMin', 'targetOddsMax', 'targetAmountMinor', 'accountId', 'authorization']) {
    assert.equal(Object.hasOwn(prematch, forbidden), false, forbidden)
  }
})

test('AH-only, total-only, and both market checkboxes map exactly', () => {
  assert.deepEqual(alertSettingToStrategy(setting('prematch', { totalEnabled: false })).scope.markets, ['asian_handicap'])
  assert.deepEqual(alertSettingToStrategy(setting('prematch', { asianHandicapEnabled: false })).scope.markets, ['total'])
  assert.deepEqual(alertSettingToStrategy(setting('prematch')).scope.markets, ['asian_handicap', 'total'])
})

test('alert strategy matches both rising and falling water moves', () => {
  const rule = alertSettingToStrategy(setting('prematch'))
  assert.equal(evaluateOddsDelta(change(), { rule }).matched, true)
  const falling = evaluateOddsDelta(change({ oldOdds: 0.95, nextOdds: 0.9 }), { rule })
  assert.equal(falling.matched, true)
  assert.equal(falling.trigger.direction, 'down')
})

test('live alert strategy evaluates supported first-half and second-half market periods through phase filtering', () => {
  const rule = alertSettingToStrategy(setting('live'))
  assert.equal(evaluateOddsDelta(change({ mode: 'live', period: 'first_half', livePhase: 'first_half' }), { rule }).matched, true)
  assert.equal(evaluateOddsDelta(change({ mode: 'live', period: 'second_half', livePhase: 'second_half' }), { rule }).matched, true)
})

test('live second-half alert without a matched card preserves Signal, telegram delivery, and cooldown', () => {
  const handle = openDb()
  try {
    const rule = alertSettingToStrategy(setting('live'))
    const input = change({ mode: 'live', period: 'second_half', livePhase: 'second_half' })
    const decision = evaluateOddsDelta(input, { rule })
    assert.equal(decision.matched, true)
    const signal = createSignal({ rule, change: input, decision })
    const store = new MonitorStateStore({ db: handle.db })
    assert.equal(store.insertSignal({ ...signal, channels: ['telegram'] }).inserted, true)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_signals').get().count, 1)
    assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='telegram'").get().count, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 0)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_cooldowns').get().count, 1)
  } finally { handle.close() }
})

test('review pending, invalid, no-market and no-live-phase settings fail closed', () => {
  assert.equal(alertSettingToStrategy(setting('prematch', { migrationReviewRequired: true })).enabled, false)
  assert.equal(alertSettingToStrategy(setting('prematch', { asianHandicapEnabled: false, totalEnabled: false })).enabled, false)
  assert.equal(alertSettingToStrategy(setting('live', { includeFirstHalf: false, includeHalfTime: false, includeSecondHalf: false })).enabled, false)
  assert.throws(() => alertSettingToStrategy(setting('prematch', { monitorOddsMin: 2, monitorOddsMax: 1 })), /strategy|odds|invalid/i)
})

test('reload reads both alert rows, returns immutable copies, and retains last-known-good on invalid revision', () => {
  const handle = openDb()
  try {
    handle.db.prepare(`UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1, total_enabled=1,
      monitor_odds_min=.8, monitor_odds_max=1.2, water_move_threshold=.03, cooldown_seconds=30,
      start_minutes_before_kickoff=180, stop_minutes_before_kickoff=5, migration_review_required=0 WHERE mode='prematch'`).run()
    handle.db.prepare(`UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1, total_enabled=0,
      monitor_odds_min=.8, monitor_odds_max=1.2, water_move_threshold=.03, cooldown_seconds=30,
      live_minute_from=1, live_minute_to=90, include_first_half=1, migration_review_required=0 WHERE mode='live'`).run()
    const watcher = new AlertSettingsWatcher(handle.db)
    const first = watcher.reload()
    assert.equal(first.updated, true)
    assert.equal(first.strategies.length, 2)
    first.strategies[0].scope.markets.length = 0
    const unchanged = watcher.reload()
    assert.equal(unchanged.updated, false)
    assert.equal(unchanged.strategies[0].scope.markets.length > 0, true)

    handle.db.exec('PRAGMA ignore_check_constraints=ON')
    handle.db.prepare("UPDATE monitor_alert_settings SET monitor_odds_min=2, monitor_odds_max=1, version=version+1 WHERE mode='prematch'").run()
    const invalid = watcher.reload()
    assert.equal(invalid.updated, false)
    assert.equal(invalid.reason, 'alert-settings-revision-invalid')
    assert.equal(invalid.revision, first.revision)
    assert.deepEqual(invalid.strategies, unchanged.strategies)
  } finally {
    handle.close()
  }
})

test('reload rejects a missing mode row and malformed raw database booleans without replacing last-known-good', () => {
  const handle = openDb()
  try {
    const watcher = new AlertSettingsWatcher(handle.db)
    const first = watcher.reload()
    assert.equal(first.updated, true)
    handle.db.prepare("DELETE FROM monitor_alert_settings WHERE mode='live'").run()
    const missing = watcher.reload()
    assert.equal(missing.reason, 'alert-settings-revision-invalid')
    assert.equal(missing.revision, first.revision)
    assert.deepEqual(missing.strategies, first.strategies)

    handle.db.exec('PRAGMA ignore_check_constraints=ON')
    handle.db.prepare(`INSERT INTO monitor_alert_settings (mode, enabled, asian_handicap_enabled, total_enabled,
      monitor_odds_min, monitor_odds_max, water_move_threshold, cooldown_seconds, live_minute_from, live_minute_to,
      include_first_half, include_half_time, include_second_half, remark, migration_review_required,
      migration_review_reason, version, created_at, updated_at)
      VALUES ('live',2,1,0,.8,1.2,.03,30,1,90,1,0,1,'',0,'',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run()
    const malformed = watcher.reload()
    assert.equal(malformed.reason, 'alert-settings-revision-invalid')
    assert.equal(malformed.revision, first.revision)
    assert.deepEqual(malformed.strategies, first.strategies)
  } finally { handle.close() }
})

test('reload rejects duplicate mode rows returned by the database adapter', () => {
  const handle = openDb()
  try {
    const rows = handle.db.prepare("SELECT * FROM monitor_alert_settings ORDER BY mode").all()
    let duplicate = false
    const database = { prepare: () => ({ all: () => duplicate ? [rows[0], rows[0]] : rows }) }
    const watcher = new AlertSettingsWatcher(database)
    const first = watcher.reload()
    duplicate = true
    const invalid = watcher.reload()
    assert.equal(invalid.reason, 'alert-settings-revision-invalid')
    assert.equal(invalid.revision, first.revision)
    assert.deepEqual(invalid.strategies, first.strategies)
  } finally { handle.close() }
})
