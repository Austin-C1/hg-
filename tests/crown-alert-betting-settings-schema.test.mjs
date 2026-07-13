import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-separated-settings-')), 'crown.sqlite')
}

test('fresh database has exactly two disabled rows per separated settings table', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath(), monitorJson: null })
  try {
    const alerts = handle.db.prepare(`
      SELECT mode, enabled, asian_handicap_enabled, total_enabled
      FROM monitor_alert_settings ORDER BY mode
    `).all().map((row) => ({ ...row }))
    const betting = handle.db.prepare(`
      SELECT mode, enabled, real_eligible, currency, amount_scale
      FROM auto_betting_settings ORDER BY mode
    `).all().map((row) => ({ ...row }))

    assert.deepEqual(alerts, [
      { mode: 'live', enabled: 0, asian_handicap_enabled: 0, total_enabled: 0 },
      { mode: 'prematch', enabled: 0, asian_handicap_enabled: 0, total_enabled: 0 },
    ])
    assert.deepEqual(betting, [
      { mode: 'live', enabled: 0, real_eligible: 0, currency: 'CNY', amount_scale: 0 },
      { mode: 'prematch', enabled: 0, real_eligible: 0, currency: 'CNY', amount_scale: 0 },
    ])
  } finally {
    handle.close()
  }
})

test('fresh auto betting odds columns store canonical decimal text', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const info = handle.db.prepare('PRAGMA table_info(auto_betting_settings)').all()
    assert.equal(info.find((row) => row.name === 'target_odds_min').type, 'TEXT')
    assert.equal(info.find((row) => row.name === 'target_odds_max').type, 'TEXT')
    handle.db.prepare(`
      UPDATE auto_betting_settings
      SET target_odds_min='0.123456789012345677', target_odds_max='0.123456789012345678'
      WHERE mode='prematch'
    `).run()
    const row = handle.db.prepare(`
      SELECT target_odds_min, target_odds_max, typeof(target_odds_min) min_type, typeof(target_odds_max) max_type
      FROM auto_betting_settings WHERE mode='prematch'
    `).get()
    assert.deepEqual({ ...row }, {
      target_odds_min: '0.123456789012345677',
      target_odds_max: '0.123456789012345678',
      min_type: 'text',
      max_type: 'text',
    })
  } finally {
    handle.close()
  }
})

test('separated settings and inbox enforce modes, state, branches, and safe amounts', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    assert.throws(() => handle.db.prepare(`
      INSERT INTO monitor_alert_settings (mode, created_at, updated_at)
      VALUES ('halftime', '', '')
    `).run(), /constraint/i)
    assert.throws(() => handle.db.prepare(`
      UPDATE monitor_alert_settings SET live_minute_from=1 WHERE mode='prematch'
    `).run(), /constraint/i)
    assert.throws(() => handle.db.prepare(`
      UPDATE monitor_alert_settings
      SET enabled=1, migration_review_required=0
      WHERE mode='live'
    `).run(), /constraint/i)
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => handle.db.prepare(`
        UPDATE auto_betting_settings SET target_amount_minor=? WHERE mode='prematch'
      `).run(amount), /constraint/i, `unsafe amount ${amount}`)
    }
    assert.throws(() => handle.db.prepare(`
      INSERT INTO auto_betting_signal_inbox (
        signal_id, mode, settings_version, settings_snapshot_json, status, created_at, updated_at
      ) VALUES ('invalid-state', 'prematch', 1, '{}', 'done', '', '')
    `).run(), /constraint/i)
  } finally {
    handle.close()
  }
})

test('inbox persists one immutable settings identity and complete retry/lease lifecycle fields', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const columns = handle.db.prepare('PRAGMA table_info(auto_betting_signal_inbox)').all().map((row) => row.name)
    assert.deepEqual(columns, [
      'signal_id', 'card_id', 'card_version', 'card_snapshot_json',
      'mode', 'settings_version', 'settings_snapshot_json', 'status',
      'skip_reason', 'attempts', 'next_attempt_at', 'lease_owner', 'lease_expires_at',
      'batch_id', 'created_at', 'updated_at',
    ])
    const insert = handle.db.prepare(`
      INSERT INTO auto_betting_signal_inbox (
        signal_id, card_id, card_version, card_snapshot_json,
        mode, settings_version, settings_snapshot_json, status,
        skip_reason, attempts, next_attempt_at, lease_owner, lease_expires_at,
        batch_id, created_at, updated_at
      ) VALUES (?, ?, 3, ?, 'live', 3, ?, ?, '', 0, '', ?, ?, ?, '', '')
    `)
    for (const [index, status] of ['pending', 'processing', 'retry', 'skipped', 'batch_created', 'dead_letter'].entries()) {
      insert.run(
        `signal-${index}`,
        `card-${index}`,
        JSON.stringify({ cardId: `card-${index}`, version: 3 }),
        '{"enabled":false}',
        status,
        status === 'processing' ? 'worker-1' : '',
        status === 'processing' ? '2026-07-12T01:00:00.000Z' : '',
        status === 'batch_created' ? 'batch-1' : null,
      )
    }
    assert.throws(() => insert.run('signal-0', 'card-0', '{"cardId":"card-0","version":3}', '{}', 'pending', '', '', null), /unique|constraint/i)
    assert.throws(() => handle.db.prepare(`
      UPDATE auto_betting_signal_inbox
      SET settings_version=4, settings_snapshot_json='{"enabled":true}'
      WHERE signal_id='signal-0'
    `).run(), /immutable/i)
    assert.throws(() => handle.db.prepare(`
      INSERT OR REPLACE INTO auto_betting_signal_inbox (
        signal_id,card_id,card_version,card_snapshot_json,
        mode,settings_version,settings_snapshot_json,status,created_at,updated_at
      ) VALUES ('signal-0','card-0',99,'{"cardId":"card-0","version":99}',
        'prematch',99,'{"enabled":true}','pending','','')
    `).run(), /immutable|append.only/i)
    assert.throws(() => handle.db.prepare(`
      DELETE FROM auto_betting_signal_inbox WHERE signal_id='signal-0'
    `).run(), /append.only/i)
    assert.equal('resetAutoBettingSignalInbox' in handle, false)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 6)
  } finally {
    handle.close()
  }
})

test('inbox status enforces lease and batch consistency', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const insert = (id, status, owner = '', expiry = '', batchId = null) => handle.db.prepare(`
      INSERT INTO auto_betting_signal_inbox (
        signal_id, mode, settings_version, settings_snapshot_json, status,
        lease_owner, lease_expires_at, batch_id, created_at, updated_at
      ) VALUES (?, 'prematch', 1, '{}', ?, ?, ?, ?, '', '')
    `).run(id, status, owner, expiry, batchId)
    assert.throws(() => insert('processing-no-lease', 'processing'), /lease|constraint/i)
    assert.throws(() => insert('pending-fake-lease', 'pending', 'worker', 'later'), /lease|constraint/i)
    assert.throws(() => insert('batch-missing', 'batch_created'), /batch|constraint/i)
    assert.throws(() => insert('pending-fake-batch', 'pending', '', '', 'batch-x'), /batch|constraint/i)
  } finally {
    handle.close()
  }
})

test('execution records add mode/settings scope without removing legacy rule evidence', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const info = (table) => handle.db.prepare(`PRAGMA table_info(${table})`).all()
    const columns = (table) => info(table).map((row) => row.name)
    assert.equal(columns('bet_batches').includes('rule_id'), true)
    assert.equal(columns('bet_batches').includes('betting_mode'), true)
    assert.equal(columns('bet_batches').includes('settings_version'), true)
    assert.equal(columns('bet_batches').includes('settings_snapshot_json'), true)
    assert.equal(columns('bet_market_once_claims').includes('rule_id'), true)
    assert.equal(columns('bet_market_once_claims').includes('betting_mode'), true)
    assert.equal(columns('bet_market_once_claims').includes('settings_version'), true)
    assert.equal(columns('execution_authorizations').includes('rule_ids_json'), true)
    assert.equal(columns('execution_authorizations').includes('betting_modes_json'), true)
    assert.equal(columns('execution_authorizations').includes('eligibility_versions_json'), true)
    assert.equal(info('bet_batches').find((row) => row.name === 'rule_id').notnull, 0)
    assert.equal(info('bet_market_once_claims').find((row) => row.name === 'rule_id').notnull, 0)

    handle.db.prepare(`
      INSERT INTO monitor_signals (
        signal_id, signal_key, strategy_id, strategy_version, status,
        observed_at, expires_at, payload_json
      ) VALUES ('new-signal', 'key', 'strategy', 1, 'ready', '', '', '{}')
    `).run()
    handle.db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, betting_mode, settings_version, settings_snapshot_json
      ) VALUES ('new-batch', 'new-signal', NULL, 'prematch', 2, '{}')
    `).run()
    assert.throws(() => handle.db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, betting_mode, settings_version, settings_snapshot_json
      ) VALUES ('duplicate-scope', 'new-signal', NULL, 'prematch', 2, '{}')
    `).run(), /unique|constraint/i)
    handle.db.prepare(`
      INSERT INTO bet_market_once_claims (
        market_once_key, rule_id, betting_mode, settings_version, created_at
      ) VALUES ('new-claim', NULL, 'live', 4, '')
    `).run()
    for (const sql of [
      "INSERT INTO bet_market_once_claims (market_once_key,rule_id,betting_mode,created_at) VALUES ('missing-version',NULL,'live','')",
      "INSERT INTO bet_market_once_claims (market_once_key,rule_id,settings_version,created_at) VALUES ('missing-mode',NULL,1,'')",
    ]) assert.throws(() => handle.db.exec(sql), /scope|constraint/i)
  } finally {
    handle.close()
  }
})

test('authorization mode scope rejects unknown, duplicate, missing, extra, or unsafe eligibility versions', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const insert = (id, modes, versions) => handle.db.prepare(`
      INSERT INTO execution_authorizations (
        authorization_id, betting_modes_json, eligibility_versions_json, status
      ) VALUES (?, ?, ?, 'revoked')
    `).run(id, JSON.stringify(modes), JSON.stringify(versions))
    insert('valid-scope', ['prematch', 'live'], { prematch: 1, live: 2 })
    for (const [id, modes, versions] of [
      ['unknown-mode', ['halftime'], { halftime: 1 }],
      ['duplicate-mode', ['prematch', 'prematch'], { prematch: 1 }],
      ['missing-version', ['prematch'], {}],
      ['extra-version', ['prematch'], { prematch: 1, live: 1 }],
      ['zero-version', ['live'], { live: 0 }],
      ['fraction-version', ['live'], { live: 1.5 }],
    ]) assert.throws(() => insert(id, modes, versions), /authorization.*scope|constraint/i, id)
  } finally {
    handle.close()
  }
})
