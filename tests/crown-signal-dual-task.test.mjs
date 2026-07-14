import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { MonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'
import { AlertSettingsWatcher } from '../src/crown/monitor/alert-settings-watcher.mjs'
import { directV2Channels, persistDirectV2Signals } from '../scripts/crown-watch.mjs'

function fixture() {
  const eventIdentity = 'crown|football|gid=3001'
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_R`
  const selectionIdentity = `${marketIdentity}|home`
  const rule = { id: 'monitor-alert:prematch', type: 'odds_delta', version: 4, enabled: true, conditions: { minDelta: .03 }, cooldownSeconds: 60 }
  const change = { schemaVersion: 2, changeId: 'a'.repeat(64), type: 'odds-change', observedAt: '2026-07-10T01:00:00.000Z', eventIdentity, marketIdentity, selectionIdentity }
  const decision = {
    matched: true, strategyId: rule.id, strategyVersion: rule.version,
    trigger: { type: 'odds-change', direction: 'up', delta: .05, threshold: .03, observedAt: change.observedAt },
    target: { eventIdentity, marketIdentity, selectionIdentity, side: 'home' },
    evidence: { changeId: change.changeId, oldOdds: .94, nextOdds: .99, homeTeam: 'Home', awayTeam: 'Away', handicapRaw: '0.25', oldOddsRaw: '0.940', nextOddsRaw: '0.990', mode: 'prematch', league: 'League', marketType: 'asian_handicap', period: 'full_time', handicap: .25, minutesBeforeKickoff: 120, livePhase: null, liveMinute: null, source: { endpointKind: 'get_game_more', confidence: 'high' } },
    cooldownSeconds: 60, dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
  }
  return { ...createSignal({ rule, change, decision }), channels: ['telegram'] }
}

function seedCard(db, overrides = {}) {
  const card = { cardId: 'card-a', name: 'League card', enabled: 1, targetAmountMinor: 20, version: 7, ...overrides }
  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES (?,?,?,'0.8','1.05',?,'CNY',0,'secret-ish note',0,2,'2026-07-10T00:00:00.000Z',0,'',?,'2026-07-10T00:00:00.000Z','2026-07-10T00:00:00.000Z')`)
    .run(card.cardId, card.name, card.enabled, card.targetAmountMinor, card.version)
  db.prepare("INSERT INTO auto_betting_rule_card_leagues(card_id,league_name,created_at) VALUES (?,'League','2026-07-10T00:00:00.000Z')")
    .run(card.cardId)
  return card
}

function store() {
  const handle = openAppDatabase({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dual-task-')), 'app.sqlite') })
  return { handle, state: new MonitorStateStore({ db: handle.db }) }
}

test('matched alert Signal omits bettingRuleId and atomically creates delivery, card inbox, and cooldown', () => {
  const signal = fixture()
  assert.equal(Object.hasOwn(signal, 'bettingRuleId'), false)
  const { handle, state } = store()
  try {
    seedCard(handle.db)
    assert.equal(state.insertSignal(signal, { availableLeagueNames: new Set(['League']) }).inserted, true)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_signals').get().count, 1)
    assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='telegram'").get().count, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_cooldowns').get().count, 1)
    const inbox = handle.db.prepare('SELECT * FROM auto_betting_signal_inbox').get()
    assert.equal(inbox.card_id, 'card-a')
    assert.equal(inbox.card_version, 7)
    assert.equal(inbox.status, 'pending')
    const snapshot = JSON.parse(inbox.card_snapshot_json)
    assert.equal(snapshot.cardId, 'card-a')
    assert.equal(snapshot.targetAmountMinor, 20)
    assert.equal(Object.hasOwn(snapshot, 'mode'), false)
  } finally { handle.close() }
})

test('no enabled reviewed today card still preserves Signal and Telegram without an inbox', () => {
  const { handle, state } = store()
  try {
    seedCard(handle.db, { enabled: 0 })
    state.insertSignal(fixture(), { availableLeagueNames: new Set(['League']) })
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_signals').get().count, 1)
    assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='telegram'").get().count, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 0)
  } finally { handle.close() }
})

test('invalid calendar timestamp in matched card fails closed while preserving Signal and Telegram', () => {
  const { handle, state } = store()
  try {
    seedCard(handle.db)
    handle.db.exec('PRAGMA ignore_check_constraints=ON')
    handle.db.prepare("UPDATE auto_betting_rule_cards SET updated_at='2026-99-99T00:00:00.000Z'").run()
    assert.equal(state.insertSignal(fixture(), { availableLeagueNames: new Set(['League']) }).inserted, true)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM monitor_signals').get().count, 1)
    assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='telegram'").get().count, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 0)
  } finally { handle.close() }
})

test('forced inbox failure rolls back signal, delivery, inbox, and cooldown', () => {
  const { handle, state } = store()
  try {
    seedCard(handle.db)
    handle.db.exec("CREATE TRIGGER fail_inbox BEFORE INSERT ON auto_betting_signal_inbox BEGIN SELECT RAISE(ABORT, 'injected-inbox-failure'); END")
    assert.throws(() => state.insertSignal(fixture(), { availableLeagueNames: new Set(['League']) }), /injected-inbox-failure/)
    for (const table of ['monitor_signals', 'monitor_deliveries', 'auto_betting_signal_inbox', 'monitor_cooldowns']) {
      assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0, table)
    }
  } finally { handle.close() }
})

test('duplicate Signal is idempotent and never rewrites the original snapshot', () => {
  const { handle, state } = store()
  try {
    const signal = fixture()
    seedCard(handle.db)
    state.insertSignal(signal, { availableLeagueNames: new Set(['League']) })
    handle.db.prepare('UPDATE auto_betting_rule_cards SET target_amount_minor=999,version=8').run()
    assert.equal(state.insertSignal(signal, { availableLeagueNames: new Set(['League']) }).reason, 'duplicate')
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 1)
    const row = handle.db.prepare('SELECT card_version, card_snapshot_json FROM auto_betting_signal_inbox').get()
    assert.equal(row.card_version, 7)
    assert.equal(JSON.parse(row.card_snapshot_json).targetAmountMinor, 20)
  } finally { handle.close() }
})

test('delivery state and inbox state mutate independently', () => {
  const { handle, state } = store()
  try {
    const signal = fixture()
    seedCard(handle.db)
    state.insertSignal(signal, { availableLeagueNames: new Set(['League']) })
    handle.db.prepare("UPDATE monitor_deliveries SET status='retry', attempts=1 WHERE signal_id=?").run(signal.signalId)
    assert.equal(handle.db.prepare('SELECT status FROM auto_betting_signal_inbox').get().status, 'pending')
    handle.db.prepare("UPDATE auto_betting_signal_inbox SET status='retry', attempts=2 WHERE signal_id=?").run(signal.signalId)
    const delivery = handle.db.prepare('SELECT status, attempts FROM monitor_deliveries').get()
    assert.equal(delivery.status, 'retry')
    assert.equal(delivery.attempts, 1)
  } finally { handle.close() }
})

test('direct-v2 creates exactly one persistent telegram delivery whether Telegram is enabled or disabled', () => {
  for (const enabled of [false, true]) {
    const { handle, state } = store()
    try {
      handle.db.prepare(`UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1, total_enabled=0,
        monitor_odds_min=.8, monitor_odds_max=1.2, water_move_threshold=.03, cooldown_seconds=60,
        start_minutes_before_kickoff=180, stop_minutes_before_kickoff=5, migration_review_required=0 WHERE mode='prematch'`).run()
      const signal = fixture()
      seedCard(handle.db)
      const registry = { evaluate: (_change, context) => {
        const rule = context.rules.find((item) => item.id === 'monitor-alert:prematch')
        return [{
          matched: true, strategyId: rule.id, strategyVersion: rule.version,
          trigger: signal.trigger, target: signal.target, evidence: signal.evidence,
          cooldownSeconds: rule.cooldownSeconds, dataQuality: signal.dataQuality,
        }]
      } }
      const result = persistDirectV2Signals({
        changes: [{ schemaVersion: 2, changeId: signal.evidence.changeId, type: 'odds-change', observedAt: signal.observedAt,
          eventIdentity: signal.target.eventIdentity, marketIdentity: signal.target.marketIdentity, selectionIdentity: signal.target.selectionIdentity }],
        stateStore: state,
        alertSettingsWatcher: new AlertSettingsWatcher(handle.db),
        registry,
        availableLeagueNamesReader: () => new Set(['League']),
      })
      assert.deepEqual(directV2Channels({ telegramSettings: { oddsAlert: { enabled } } }), ['telegram'])
      assert.equal(result.inserted.length, 1)
      assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='telegram'").get().count, 1)
      assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM monitor_deliveries WHERE channel='console'").get().count, 0)
      assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 1)
    } finally { handle.close() }
  }
})

test('one direct-v2 poll fixes canonical now and reads today catalog once inside the Signal artifact transaction', () => {
  const { handle, state } = store()
  try {
    handle.db.prepare(`UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1, total_enabled=0,
      monitor_odds_min=.8, monitor_odds_max=1.2, water_move_threshold=.03, cooldown_seconds=60,
      start_minutes_before_kickoff=180, stop_minutes_before_kickoff=5, migration_review_required=0 WHERE mode='prematch'`).run()
    seedCard(handle.db)
    const expected = fixture()
    const decision = {
      matched: true, strategyId: 'monitor-alert:prematch', strategyVersion: 1,
      trigger: expected.trigger, target: expected.target, evidence: expected.evidence,
      cooldownSeconds: 60, dataQuality: expected.dataQuality,
    }
    const registry = { evaluate: (_change, context) => {
      const version = context.rules.find((rule) => rule.id === decision.strategyId).version
      return [{ ...decision, strategyVersion: version }, { ...decision, strategyVersion: version }]
    } }
    let clockCalls = 0
    let readerCalls = 0
    const seenNow = []
    const result = persistDirectV2Signals({
      changes: [{ schemaVersion: 2, changeId: expected.evidence.changeId, type: 'odds-change', observedAt: expected.observedAt,
        eventIdentity: expected.target.eventIdentity, marketIdentity: expected.target.marketIdentity, selectionIdentity: expected.target.selectionIdentity }],
      stateStore: state,
      alertSettingsWatcher: new AlertSettingsWatcher(handle.db),
      registry,
      now() {
        clockCalls += 1
        return new Date(clockCalls === 1 ? '2026-07-12T15:59:59.999Z' : '2026-07-12T16:00:00.001Z')
      },
      availableLeagueNamesReader(catalogNow) {
        readerCalls += 1
        seenNow.push(catalogNow)
        assert.equal(handle.db.isTransaction, true)
        return new Set(['League'])
      },
    })
    assert.equal(clockCalls, 1)
    assert.equal(readerCalls, 1)
    assert.deepEqual(seenNow, ['2026-07-12T15:59:59.999Z'])
    assert.equal(result.inserted.length, 1)
    assert.equal(result.duplicates, 1)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 1)
  } finally { handle.close() }
})
