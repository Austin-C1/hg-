import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { normalizeAutoBetRule, reverseSelectionSide } from '../src/crown/betting/auto-bet-rule.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-auto-rule-')), 'crown.sqlite')
}

test('fresh database creates disabled canonical migration templates and singleton runtime state', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath() })
  const rules = handle.db.prepare(`
    SELECT id, currency, amount_scale, priority, monitor_enabled,
           real_betting_enabled, migration_review_required
    FROM betting_rules
    WHERE id IN ('legacy-prematch', 'legacy-live')
    ORDER BY id
  `).all()
  const runtime = handle.db.prepare('SELECT singleton_id, requested, runtime_state, reason_code FROM real_betting_runtime').all()
  handle.close()

  assert.equal(rules.length, 2)
  for (const rule of rules) {
    assert.equal(rule.currency, 'CNY')
    assert.equal(rule.amount_scale, 0)
    assert.equal(rule.priority, 1)
    assert.equal(rule.monitor_enabled, 0)
    assert.equal(rule.real_betting_enabled, 0)
    assert.equal(rule.migration_review_required, 1)
  }
  assert.deepEqual(runtime.map((row) => ({ ...row })), [{ singleton_id: 1, requested: 0, runtime_state: 'off', reason_code: null }])
})

test('migration templates and legacy empty timestamps receive canonical ISO timestamps', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  first.db.prepare("UPDATE betting_rules SET created_at='', updated_at='' WHERE id='legacy-prematch'").run()
  first.close()
  const reopened = openAppDatabase({ dbPath })
  try {
    for (const row of reopened.db.prepare("SELECT created_at,updated_at FROM betting_rules WHERE id IN ('legacy-prematch','legacy-live')").all()) {
      assert.equal(new Date(row.created_at).toISOString(), row.created_at)
      assert.equal(new Date(row.updated_at).toISOString(), row.updated_at)
    }
  } finally { reopened.close() }
})

test('legacy database migration is deterministic, fail-closed, and archives the manual rule', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE betting_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      per_account_bet_amount REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE betting_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      username TEXT NOT NULL,
      daily_limit REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO betting_rules VALUES
      ('brule_manual', 'Manual dry-run rule', 10, 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z'),
      ('legacy-custom', 'legacy custom', 25, 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');
    INSERT INTO betting_accounts VALUES
      ('legacy-account', 'legacy', 'legacy', 100, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const rule = migrated.db.prepare(`
    SELECT currency, amount_scale, target_amount_minor, priority,
           monitor_enabled, real_betting_enabled, migration_review_required
    FROM betting_rules WHERE id = ?
  `).get('legacy-custom')
  const account = migrated.db.prepare(`
    SELECT currency, amount_scale, stake_step_minor, allocation_status
    FROM betting_accounts WHERE id = ?
  `).get('legacy-account')
  const archived = migrated.db.prepare('SELECT archived FROM betting_rules WHERE id=?').get('brule_manual').archived
  migrated.close()

  assert.equal(rule.currency, 'CNY')
  assert.equal(rule.amount_scale, 0)
  assert.equal(rule.target_amount_minor, 25)
  assert.equal(rule.priority, 1)
  assert.equal(rule.monitor_enabled, 0)
  assert.equal(rule.real_betting_enabled, 0)
  assert.equal(rule.migration_review_required, 1)
  assert.equal(archived, 1)
  assert.deepEqual({ ...account }, {
    currency: 'CNY',
    amount_scale: 0,
    stake_step_minor: 1,
    allocation_status: 'paused',
  })
})

test('reopening the database does not duplicate deterministic migration state', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  first.db.prepare(`
    INSERT INTO bet_market_once_claims (market_once_key, rule_id, created_at)
    VALUES ('market-once-1', 'legacy-prematch', '2026-07-11T00:00:00.000Z')
  `).run()
  first.db.prepare(`
    UPDATE betting_rules
    SET name='reviewed template', migration_review_required=0, target_amount_minor=5
    WHERE id='legacy-prematch'
  `).run()
  first.db.prepare(`
    UPDATE real_betting_runtime
    SET requested=1, runtime_state='armed_waiting', reason_code='review-test', updated_at='2026-07-11'
    WHERE singleton_id=1
  `).run()
  first.close()

  const second = openAppDatabase({ dbPath })
  const templateCount = second.db.prepare(`
    SELECT COUNT(*) AS count FROM betting_rules
    WHERE id IN ('legacy-prematch', 'legacy-live')
  `).get().count
  const runtimeCount = second.db.prepare('SELECT COUNT(*) AS count FROM real_betting_runtime').get().count
  const claimCount = second.db.prepare("SELECT COUNT(*) AS count FROM bet_market_once_claims WHERE market_once_key = 'market-once-1'").get().count
  const template = second.db.prepare("SELECT name, migration_review_required, target_amount_minor FROM betting_rules WHERE id='legacy-prematch'").get()
  const runtime = second.db.prepare('SELECT requested, runtime_state, reason_code FROM real_betting_runtime WHERE singleton_id=1').get()
  second.close()

  assert.equal(templateCount, 2)
  assert.equal(runtimeCount, 1)
  assert.equal(claimCount, 1)
  assert.deepEqual({ ...template }, { name: 'reviewed template', migration_review_required: 0, target_amount_minor: 5 })
  assert.deepEqual({ ...runtime }, { requested: 1, runtime_state: 'armed_waiting', reason_code: 'review-test' })
})

test('canonical rule normalizer returns integer CNY data and reverses compatible sides', () => {
  const rule = normalizeAutoBetRule({
    name: 'prematch home rise',
    monitorEnabled: true,
    realBettingEnabled: false,
    mode: 'prematch',
    period: 'full',
    marketType: 'asian_handicap',
    monitoredSide: 'home',
    minWaterRise: '0.03',
    targetOddsMin: '0.80',
    targetOddsMax: '1.10',
    targetAmountMinor: 100,
    leagueNames: ['A', ' A ', 'B'],
    startMinutesBeforeKickoff: 60,
    stopMinutesBeforeKickoff: 5,
  })

  assert.equal(rule.currency, 'CNY')
  assert.equal(rule.amountScale, 0)
  assert.equal(rule.targetAmountMinor, 100)
  assert.deepEqual(rule.leagueNames, ['A', 'B'])
  assert.equal(rule.startMinutesBeforeKickoff, 60)
  assert.equal(rule.stopMinutesBeforeKickoff, 5)
  assert.equal(rule.liveMinuteFrom, null)
  assert.equal(rule.liveMinuteTo, null)
  assert.equal(reverseSelectionSide('home'), 'away')
  assert.equal(reverseSelectionSide('away'), 'home')
  assert.equal(reverseSelectionSide('over'), 'under')
  assert.equal(reverseSelectionSide('under'), 'over')
})

test('canonical rule normalizer rejects unsafe or incompatible input', () => {
  const base = {
    name: 'safe rule',
    monitorEnabled: true,
    realBettingEnabled: false,
    mode: 'prematch',
    period: 'full',
    marketType: 'asian_handicap',
    monitoredSide: 'home',
    minWaterRise: '0.03',
    targetOddsMin: '0.80',
    targetOddsMax: '1.10',
    targetAmountMinor: 100,
    leagueNames: ['A'],
    startMinutesBeforeKickoff: 60,
    stopMinutesBeforeKickoff: 5,
  }

  assert.throws(() => normalizeAutoBetRule({ ...base, monitoredSide: 'over' }), (error) => /side/i.test(error.fields?.monitoredSide))
  assert.throws(() => normalizeAutoBetRule({ ...base, targetAmountMinor: 1.5 }), (error) => /integer/i.test(error.fields?.targetAmountMinor))
  assert.throws(() => normalizeAutoBetRule({ ...base, leagueNames: [] }), (error) => /league/i.test(error.fields?.leagueNames))
  assert.throws(() => normalizeAutoBetRule({ ...base, monitorEnabled: false, realBettingEnabled: true }), (error) => /monitor/i.test(error.fields?.monitorEnabled))
  assert.throws(() => normalizeAutoBetRule({ ...base, startMinutesBeforeKickoff: 4, stopMinutesBeforeKickoff: 5 }), (error) => /window|kickoff/i.test(error.fields?.startMinutesBeforeKickoff))
  assert.throws(() => normalizeAutoBetRule({
    ...base,
    mode: 'live',
    marketType: 'total',
    monitoredSide: 'over',
    liveMinuteFrom: 20,
    liveMinuteTo: 10,
  }), (error) => /window|live/i.test(error.fields?.liveMinuteFrom))
  for (const field of ['monitorEnabled', 'realBettingEnabled', 'archived', 'migrationReviewRequired']) {
    for (const value of ['false', 0, null]) {
      assert.throws(
        () => normalizeAutoBetRule({ ...base, [field]: value }),
        (error) => /boolean/i.test(error.fields?.[field]),
        `${field}=${String(value)}`,
      )
    }
  }
  assert.throws(() => normalizeAutoBetRule({ ...base, priority: 0 }), (error) => /integer/i.test(error.fields?.priority))
  assert.throws(() => normalizeAutoBetRule({ ...base, targetAmountMinor: 0 }), (error) => /integer/i.test(error.fields?.targetAmountMinor))
  assert.throws(
    () => {
      const incomplete = { ...base, monitorEnabled: false }
      delete incomplete.stopMinutesBeforeKickoff
      normalizeAutoBetRule(incomplete)
    },
    (error) => /window|kickoff/i.test(error.fields?.startMinutesBeforeKickoff),
  )
  for (const field of [
    'priority', 'targetAmountMinor', 'startMinutesBeforeKickoff',
    'stopMinutesBeforeKickoff', 'liveMinuteFrom', 'liveMinuteTo',
  ]) {
    for (const value of [true, '100', [100], {}, null, '']) {
      assert.throws(
        () => normalizeAutoBetRule({ ...base, [field]: value }),
        (error) => /integer/i.test(error.fields?.[field]),
        `${field} rejects ${JSON.stringify(value)}`,
      )
    }
  }
})

test('canonical rule normalizer validates partial patches against current canonical state', () => {
  const current = normalizeAutoBetRule({
    name: 'current',
    priority: 1,
    monitorEnabled: false,
    realBettingEnabled: false,
    mode: 'prematch',
    period: 'full',
    marketType: 'asian_handicap',
    monitoredSide: 'home',
    minWaterRise: '0.03',
    targetOddsMin: '0.80',
    targetOddsMax: '1.10',
    targetAmountMinor: 100,
    leagueNames: ['A'],
    startMinutesBeforeKickoff: 60,
    stopMinutesBeforeKickoff: 5,
  })

  assert.deepEqual(normalizeAutoBetRule({ priority: 2 }, { partial: true, current }), { priority: 2 })
  assert.throws(
    () => normalizeAutoBetRule({ priority: 2 }, { partial: true }),
    (error) => /current/i.test(error.fields?.current),
  )
  assert.throws(
    () => normalizeAutoBetRule({ realBettingEnabled: true }, { partial: true, current }),
    (error) => /monitor/i.test(error.fields?.monitorEnabled),
  )
  assert.throws(
    () => normalizeAutoBetRule({ marketType: 'total' }, { partial: true, current }),
    (error) => /side/i.test(error.fields?.monitoredSide),
  )
  const realCurrent = { ...current, monitorEnabled: true, realBettingEnabled: true }
  assert.throws(
    () => normalizeAutoBetRule({ monitorEnabled: false }, { partial: true, current: realCurrent }),
    (error) => /monitor/i.test(error.fields?.monitorEnabled),
  )
  assert.deepEqual(
    normalizeAutoBetRule({ mode: 'live', liveMinuteFrom: 1, liveMinuteTo: 90 }, { partial: true, current }),
    {
      mode: 'live',
      startMinutesBeforeKickoff: null,
      stopMinutesBeforeKickoff: null,
      liveMinuteFrom: 1,
      liveMinuteTo: 90,
    },
  )
})

test('legacy canonical rebuild fixes defaults and checks while preserving dependent objects', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE betting_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      per_account_bet_amount REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      market_type TEXT NOT NULL DEFAULT 'asian_handicap',
      currency TEXT NOT NULL DEFAULT '',
      amount_scale INTEGER NOT NULL DEFAULT 2,
      target_amount_minor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE betting_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      username TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'disabled',
      daily_limit REAL NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      amount_scale INTEGER NOT NULL DEFAULT 2,
      stake_step_minor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE legacy_dependencies (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES betting_rules(id),
      account_id TEXT NOT NULL REFERENCES betting_accounts(id)
    );
    CREATE TABLE legacy_trigger_log (value TEXT NOT NULL);
    CREATE INDEX legacy_rule_name_idx ON betting_rules(name);
    CREATE TRIGGER legacy_rule_update_trigger AFTER UPDATE ON betting_rules
    BEGIN
      INSERT INTO legacy_trigger_log(value) VALUES (NEW.id);
    END;
    INSERT INTO betting_rules VALUES
      ('legacy-real-shape', 'legacy', 25, 1, 'asian_handicap', '', 2, 0, '2026-07-09', '2026-07-09');
    INSERT INTO betting_accounts VALUES
      ('legacy-enabled-account', 'legacy', 'legacy', 'enabled', 100, 0, '', 2, 0, '2026-07-09', '2026-07-09');
    INSERT INTO legacy_dependencies VALUES ('dep', 'legacy-real-shape', 'legacy-enabled-account');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const ruleInfo = new Map(migrated.db.prepare('PRAGMA table_info(betting_rules)').all().map((row) => [row.name, row]))
  const accountInfo = new Map(migrated.db.prepare('PRAGMA table_info(betting_accounts)').all().map((row) => [row.name, row]))
  const ruleSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='betting_rules'").get().sql
  const accountSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='betting_accounts'").get().sql
  assert.equal(ruleInfo.get('currency').dflt_value, "'CNY'")
  assert.equal(ruleInfo.get('amount_scale').dflt_value, '0')
  assert.equal(accountInfo.get('currency').dflt_value, "'CNY'")
  assert.equal(accountInfo.get('amount_scale').dflt_value, '0')
  assert.equal(accountInfo.get('stake_step_minor').dflt_value, '1')
  assert.match(ruleSql, /market_type IN \('asian_handicap','total'\)/)
  assert.match(accountSql, /allocation_status IN \('enabled', 'pause_pending', 'paused', 'checking'\)/)
  assert.equal(migrated.db.prepare("SELECT allocation_status FROM betting_accounts WHERE id='legacy-enabled-account'").get().allocation_status, 'paused')
  assert.throws(() => migrated.db.prepare(`
    INSERT INTO betting_rules (id, name, market_type, created_at, updated_at)
    VALUES ('invalid-market', 'invalid', 'team_total', '', '')
  `).run(), /constraint/i)
  assert.equal(migrated.db.prepare("SELECT COUNT(*) count FROM legacy_dependencies WHERE id='dep'").get().count, 1)
  assert.equal(migrated.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='index' AND name='legacy_rule_name_idx'").get().count, 1)
  assert.equal(migrated.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='trigger' AND name='legacy_rule_update_trigger'").get().count, 1)
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
  migrated.db.prepare(`
    UPDATE betting_rules
    SET migration_review_required=0, target_amount_minor=75, monitor_enabled=1
    WHERE id='legacy-real-shape'
  `).run()
  migrated.close()

  const reopened = openAppDatabase({ dbPath })
  assert.deepEqual(
    { ...reopened.db.prepare("SELECT migration_review_required, target_amount_minor, monitor_enabled FROM betting_rules WHERE id='legacy-real-shape'").get() },
    { migration_review_required: 0, target_amount_minor: 75, monitor_enabled: 1 },
  )
  reopened.close()
})
