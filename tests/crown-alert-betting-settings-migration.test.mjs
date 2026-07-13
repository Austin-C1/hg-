import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { decideAlertBettingMigration } from '../src/crown/app/alert-betting-settings-migration.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-separated-migration-')), 'crown.sqlite')
}

function monitorJson() {
  return {
    version: 2,
    prematch: {
      enabled: true,
      minOdds: 0.72,
      maxOdds: 1.16,
      waterMoveThreshold: 0.04,
      cooldownSeconds: 90,
      startMinutesBeforeKickoff: 180,
      stopMinutesBeforeKickoff: 5,
      remark: 'legacy prematch',
    },
    live: {
      enabled: false,
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.03,
      cooldownSeconds: 60,
      liveMinuteFrom: 10,
      liveMinuteTo: 75,
      includeFirstHalf: true,
      includeHalfTime: false,
      includeSecondHalf: true,
    },
  }
}

function candidate(overrides = {}) {
  return {
    id: 'legacy-candidate',
    mode: 'prematch',
    archived: 0,
    currency: 'CNY',
    amount_scale: 0,
    target_odds_min: '0.80',
    target_odds_max: '1.10',
    target_amount_minor: 100,
    migration_review_required: 0,
    enabled: 1,
    real_betting_enabled: 1,
    ...overrides,
  }
}

test('pure migration copies explicit monitor numerics but never opens a mode without market evidence', () => {
  const result = decideAlertBettingMigration({ monitorJson: monitorJson(), legacyRules: [], existingRows: {} })
  const prematch = result.monitorSettings.find((row) => row.mode === 'prematch')
  assert.deepEqual(prematch, {
    mode: 'prematch',
    enabled: 0,
    asian_handicap_enabled: 0,
    total_enabled: 0,
    monitor_odds_min: 0.72,
    monitor_odds_max: 1.16,
    water_move_threshold: 0.04,
    cooldown_seconds: 90,
    start_minutes_before_kickoff: 180,
    stop_minutes_before_kickoff: 5,
    live_minute_from: null,
    live_minute_to: null,
    include_first_half: 0,
    include_half_time: 0,
    include_second_half: 0,
    remark: 'legacy prematch',
    migration_review_required: 1,
    migration_review_reason: 'legacy-enabled;market-evidence-missing',
  })
})

test('pure migration selects exactly one valid canonical CNY candidate and stays disabled/ineligible', () => {
  const result = decideAlertBettingMigration({ monitorJson: null, legacyRules: [candidate()], existingRows: {} })
  const prematch = result.autoBettingSettings.find((row) => row.mode === 'prematch')
  assert.deepEqual(prematch, {
    mode: 'prematch',
    enabled: 0,
    target_odds_min: 0.8,
    target_odds_max: 1.1,
    target_amount_minor: 100,
    currency: 'CNY',
    amount_scale: 0,
    real_eligible: 0,
    migration_review_required: 0,
    migration_review_reason: 'legacy-enabled;legacy-real-betting-enabled',
  })
})

test('conflicts, zero, missing fields, and unfinished review remain review-required and off', () => {
  const cases = [
    [candidate(), candidate({ id: 'conflict', target_amount_minor: 200 })],
    [candidate({ target_amount_minor: 0 })],
    [candidate({ target_odds_max: null })],
    [candidate({ migration_review_required: 1 })],
  ]
  for (const legacyRules of cases) {
    const result = decideAlertBettingMigration({ monitorJson: null, legacyRules, existingRows: {} })
    const prematch = result.autoBettingSettings.find((row) => row.mode === 'prematch')
    assert.equal(prematch.enabled, 0)
    assert.equal(prematch.real_eligible, 0)
    assert.equal(prematch.migration_review_required, 1)
    assert.equal(prematch.target_amount_minor, null)
  }
})

test('database initialization applies migration atomically and reopening preserves a manually versioned row', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath, monitorJson: monitorJson() })
  try {
    const alert = first.db.prepare(`
      SELECT enabled, asian_handicap_enabled, total_enabled, monitor_odds_min,
             migration_review_required
      FROM monitor_alert_settings WHERE mode='prematch'
    `).get()
    assert.deepEqual({ ...alert }, {
      enabled: 0,
      asian_handicap_enabled: 0,
      total_enabled: 0,
      monitor_odds_min: 0.72,
      migration_review_required: 1,
    })
    first.db.prepare(`
      UPDATE monitor_alert_settings
      SET monitor_odds_min=0.91, version=2, migration_review_reason='manually-reviewed'
      WHERE mode='prematch'
    `).run()
    const cardUpdate = first.db.prepare(`
      UPDATE auto_betting_rule_cards
      SET version=5, remark='manually-reviewed-card'
      WHERE card_id='migrated-fixed-prematch'
    `).run()
    assert.equal(cardUpdate.changes, 1)
  } finally {
    first.close()
  }

  const second = openAppDatabase({ dbPath, monitorJson: monitorJson() })
  try {
    const row = second.db.prepare(`
      SELECT monitor_odds_min, version, migration_review_reason
      FROM monitor_alert_settings WHERE mode='prematch'
    `).get()
    assert.deepEqual({ ...row }, { monitor_odds_min: 0.91, version: 2, migration_review_reason: 'manually-reviewed' })
    assert.equal(second.db.prepare('SELECT COUNT(*) count FROM monitor_alert_settings').get().count, 2)
    assert.equal(second.db.prepare('SELECT COUNT(*) count FROM auto_betting_settings').get().count, 2)
    assert.equal(second.db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_cards').get().count, 2)
    assert.deepEqual({ ...second.db.prepare(`
      SELECT version, remark FROM auto_betting_rule_cards
      WHERE card_id='migrated-fixed-prematch'
    `).get() }, { version: 5, remark: 'manually-reviewed-card' })
  } finally {
    second.close()
  }
})

test('legacy water_rise_threshold is rebuilt to water_move_threshold without changing settings metadata', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE monitor_alert_settings (
      mode TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      asian_handicap_enabled INTEGER NOT NULL,
      total_enabled INTEGER NOT NULL,
      monitor_odds_min REAL,
      monitor_odds_max REAL,
      water_rise_threshold REAL,
      cooldown_seconds INTEGER,
      start_minutes_before_kickoff INTEGER,
      stop_minutes_before_kickoff INTEGER,
      live_minute_from INTEGER,
      live_minute_to INTEGER,
      include_first_half INTEGER NOT NULL,
      include_half_time INTEGER NOT NULL,
      include_second_half INTEGER NOT NULL,
      remark TEXT NOT NULL,
      migration_review_required INTEGER NOT NULL,
      migration_review_reason TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO monitor_alert_settings VALUES
      ('prematch',0,1,1,0.8,1.2,0.04,90,180,5,NULL,NULL,0,0,0,'prematch-note',0,'reviewed',7,'created-p','updated-p'),
      ('live',0,1,0,0.7,1.3,0.02,45,NULL,NULL,10,75,1,0,1,'live-note',1,'pending',9,'created-l','updated-l');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath, monitorJson: null })
  try {
    const columns = migrated.db.prepare('PRAGMA table_info(monitor_alert_settings)').all().map((row) => row.name)
    assert.equal(columns.includes('water_move_threshold'), true)
    assert.equal(columns.includes('water_rise_threshold'), false)
    const rows = migrated.db.prepare(`
      SELECT mode, water_move_threshold, version, migration_review_required,
             migration_review_reason, remark, created_at, updated_at
      FROM monitor_alert_settings ORDER BY mode
    `).all().map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      { mode: 'live', water_move_threshold: 0.02, version: 9, migration_review_required: 1,
        migration_review_reason: 'pending', remark: 'live-note', created_at: 'created-l', updated_at: 'updated-l' },
      { mode: 'prematch', water_move_threshold: 0.04, version: 7, migration_review_required: 0,
        migration_review_reason: 'reviewed', remark: 'prematch-note', created_at: 'created-p', updated_at: 'updated-p' },
    ])
  } finally { migrated.close() }
})

test('existing REAL auto betting settings rebuild to canonical TEXT without changing row metadata', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE auto_betting_settings (
      mode TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      target_odds_min REAL,
      target_odds_max REAL,
      target_amount_minor INTEGER,
      currency TEXT NOT NULL,
      amount_scale INTEGER NOT NULL,
      remark TEXT NOT NULL,
      real_eligible INTEGER NOT NULL,
      real_eligibility_version INTEGER NOT NULL,
      real_eligibility_updated_at TEXT NOT NULL,
      migration_review_required INTEGER NOT NULL,
      migration_review_reason TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO auto_betting_settings VALUES
      ('prematch',0,0.8,1.1,100,'CNY',0,'legacy prematch',1,9,'eligibility-at',0,'reviewed',7,'created-p','updated-p'),
      ('live',0,0.000000000000000001,1.25,200,'CNY',0,'legacy live',0,4,'eligibility-live',1,'pending',5,'created-l','updated-l');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath, monitorJson: null })
  try {
    const info = migrated.db.prepare('PRAGMA table_info(auto_betting_settings)').all()
    assert.equal(info.find((row) => row.name === 'target_odds_min').type, 'TEXT')
    assert.equal(info.find((row) => row.name === 'target_odds_max').type, 'TEXT')
    const rows = migrated.db.prepare(`
      SELECT *, typeof(target_odds_min) min_type, typeof(target_odds_max) max_type
      FROM auto_betting_settings ORDER BY mode
    `).all().map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      {
        mode: 'live', enabled: 0, target_odds_min: '0.000000000000000001', target_odds_max: '1.25',
        target_amount_minor: 200, currency: 'CNY', amount_scale: 0, remark: 'legacy live',
        real_eligible: 0, real_eligibility_version: 4, real_eligibility_updated_at: 'eligibility-live',
        migration_review_required: 1, migration_review_reason: 'pending', version: 5,
        created_at: 'created-l', updated_at: 'updated-l', min_type: 'text', max_type: 'text',
      },
      {
        mode: 'prematch', enabled: 0, target_odds_min: '0.8', target_odds_max: '1.1',
        target_amount_minor: 100, currency: 'CNY', amount_scale: 0, remark: 'legacy prematch',
        real_eligible: 1, real_eligibility_version: 9, real_eligibility_updated_at: 'eligibility-at',
        migration_review_required: 0, migration_review_reason: 'reviewed', version: 7,
        created_at: 'created-p', updated_at: 'updated-p', min_type: 'text', max_type: 'text',
      },
    ])
  } finally {
    migrated.close()
  }
})

test('negative scientific legacy odds abort TEXT rebuild and roll back every setting field', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE auto_betting_settings (
      mode TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      target_odds_min REAL,
      target_odds_max REAL,
      target_amount_minor INTEGER,
      currency TEXT NOT NULL,
      amount_scale INTEGER NOT NULL,
      remark TEXT NOT NULL,
      real_eligible INTEGER NOT NULL,
      real_eligibility_version INTEGER NOT NULL,
      real_eligibility_updated_at TEXT NOT NULL,
      migration_review_required INTEGER NOT NULL,
      migration_review_reason TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO auto_betting_settings VALUES
      ('prematch',1,-1e-7,1.1,100,'CNY',0,'negative legacy',1,12,'eligibility-at',0,'reviewed',11,'created','updated');
  `)
  legacy.close()

  assert.throws(
    () => openAppDatabase({ dbPath, monitorJson: null }),
    (error) => error?.code === 'legacy-auto-betting-odds-invalid'
      && error?.message === 'legacy-auto-betting-odds-invalid',
  )

  const unchanged = new DatabaseSync(dbPath)
  try {
    const info = unchanged.prepare('PRAGMA table_info(auto_betting_settings)').all()
    assert.equal(info.find((row) => row.name === 'target_odds_min').type, 'REAL')
    assert.equal(unchanged.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name='auto_betting_settings__canonical_rebuild'").get().count, 0)
    assert.deepEqual({ ...unchanged.prepare('SELECT * FROM auto_betting_settings').get() }, {
      mode: 'prematch', enabled: 1, target_odds_min: -1e-7, target_odds_max: 1.1,
      target_amount_minor: 100, currency: 'CNY', amount_scale: 0, remark: 'negative legacy',
      real_eligible: 1, real_eligibility_version: 12, real_eligibility_updated_at: 'eligibility-at',
      migration_review_required: 0, migration_review_reason: 'reviewed', version: 11,
      created_at: 'created', updated_at: 'updated',
    })
  } finally {
    unchanged.close()
  }
})

test('existing task-1 scope tables rebuild additively for nullable legacy rule identity', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE monitor_signals (
      signal_id TEXT PRIMARY KEY,
      signal_key TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    INSERT INTO monitor_signals VALUES ('legacy-signal','key','strategy',1,'ready','','','{}');
    CREATE TABLE bet_batches (
      batch_id TEXT PRIMARY KEY,
      signal_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      betting_mode TEXT,
      settings_version INTEGER,
      settings_snapshot_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (signal_id, rule_id)
    );
    INSERT INTO bet_batches VALUES ('legacy-batch','legacy-signal','legacy-prematch',NULL,NULL,'{}');
    CREATE TABLE bet_market_once_claims (
      market_once_key TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      betting_mode TEXT,
      settings_version INTEGER,
      signal_id TEXT NOT NULL DEFAULT '',
      batch_id TEXT,
      claim_status TEXT NOT NULL DEFAULT 'claimed',
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO bet_market_once_claims
      (market_once_key,rule_id,created_at) VALUES ('legacy-claim','legacy-prematch','');
    CREATE TABLE legacy_scope_trigger_log (value TEXT NOT NULL);
    CREATE INDEX legacy_batch_rule_idx ON bet_batches(rule_id);
    CREATE INDEX legacy_claim_rule_idx ON bet_market_once_claims(rule_id);
    CREATE TRIGGER legacy_batch_update_trigger AFTER UPDATE ON bet_batches
    BEGIN
      INSERT INTO legacy_scope_trigger_log(value) VALUES ('batch:' || NEW.batch_id);
    END;
    CREATE TRIGGER legacy_claim_update_trigger AFTER UPDATE ON bet_market_once_claims
    BEGIN
      INSERT INTO legacy_scope_trigger_log(value) VALUES ('claim:' || NEW.market_once_key);
    END;
    CREATE TABLE legacy_scope_dependencies (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES bet_batches(batch_id),
      market_once_key TEXT NOT NULL REFERENCES bet_market_once_claims(market_once_key)
    );
    INSERT INTO legacy_scope_dependencies VALUES ('dep','legacy-batch','legacy-claim');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath, monitorJson: null })
  try {
    const info = (table, column) => migrated.db.prepare(`PRAGMA table_info(${table})`).all().find((row) => row.name === column)
    assert.equal(info('bet_batches', 'rule_id').notnull, 0)
    assert.equal(info('bet_market_once_claims', 'rule_id').notnull, 0)
    assert.equal(migrated.db.prepare("SELECT rule_id FROM bet_batches WHERE batch_id='legacy-batch'").get().rule_id, 'legacy-prematch')
    assert.equal(migrated.db.prepare("SELECT rule_id FROM bet_market_once_claims WHERE market_once_key='legacy-claim'").get().rule_id, 'legacy-prematch')
    for (const name of [
      'legacy_batch_rule_idx', 'legacy_claim_rule_idx',
      'legacy_batch_update_trigger', 'legacy_claim_update_trigger',
    ]) assert.equal(migrated.db.prepare('SELECT COUNT(*) count FROM sqlite_master WHERE name=?').get(name).count, 1)
    assert.equal(migrated.db.prepare("SELECT COUNT(*) count FROM legacy_scope_dependencies WHERE id='dep'").get().count, 1)
    assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
    migrated.db.prepare("UPDATE bet_batches SET finished_at='' WHERE batch_id='legacy-batch'").run()
    migrated.db.prepare("UPDATE bet_market_once_claims SET updated_at='' WHERE market_once_key='legacy-claim'").run()
    assert.deepEqual(
      migrated.db.prepare('SELECT value FROM legacy_scope_trigger_log ORDER BY value').all().map((row) => row.value),
      ['batch:legacy-batch', 'claim:legacy-claim'],
    )
    migrated.db.prepare(`
      INSERT INTO monitor_signals VALUES ('scoped-signal','key-2','strategy',1,'ready','','','{}')
    `).run()
    migrated.db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, betting_mode, settings_version, settings_snapshot_json
      ) VALUES ('scoped-batch','scoped-signal',NULL,'live',7,'{}')
    `).run()
    assert.throws(() => migrated.db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, betting_mode, settings_version, settings_snapshot_json
      ) VALUES ('scoped-duplicate','scoped-signal',NULL,'live',7,'{}')
    `).run(), /unique|constraint/i)
  } finally {
    migrated.close()
  }

  const reopened = openAppDatabase({ dbPath, monitorJson: null })
  try {
    assert.equal(reopened.db.prepare('SELECT COUNT(*) count FROM bet_batches').get().count, 2)
    assert.equal(reopened.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 1)
    assert.equal(reopened.db.prepare('SELECT COUNT(*) count FROM legacy_scope_dependencies').get().count, 1)
    assert.equal(reopened.db.prepare('SELECT COUNT(*) count FROM legacy_scope_trigger_log').get().count, 2)
    for (const name of [
      'legacy_batch_rule_idx', 'legacy_claim_rule_idx',
      'legacy_batch_update_trigger', 'legacy_claim_update_trigger',
      'bet_batches_signal_mode_settings_idx',
    ]) assert.equal(reopened.db.prepare('SELECT COUNT(*) count FROM sqlite_master WHERE name=?').get(name).count, 1)
    assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    reopened.close()
  }
})
