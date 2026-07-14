import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { defaultDbPath, openAppDatabase, openRuntimeDatabase } from '../src/crown/app/app-db.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-db-')), 'crown.sqlite')
}

test('runtime database connection opens an initialized file without running schema work', () => {
  const dbPath = tempDbPath()
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)')
  seed.close()

  const handle = openRuntimeDatabase({ dbPath })
  assert.deepEqual(handle.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['marker'])
  handle.close()
})

test('portable database uses an explicit absolute path and rejects repository-relative fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-db-'))
  const dataRoot = path.join(dir, 'data')
  const dbPath = path.join(dataRoot, 'storage', 'crown.sqlite')
  const env = { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot, CROWN_DB_PATH: dbPath }
  const handle = openAppDatabase({ env })

  assert.equal(handle.dbPath, path.resolve(dbPath))
  handle.close()
  assert.equal(fs.existsSync(dbPath), true)
  assert.throws(
    () => openAppDatabase({ env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot } }),
    /portable-db-path-required/,
  )
  assert.throws(
    () => openAppDatabase({ dbPath: 'storage/portable.sqlite', env }),
    /portable-db-path-absolute-required/,
  )
})

test('portable database requires a fully-qualified data root and stays contained within it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-db-root-'))
  const dataRoot = path.join(dir, 'data')
  const dbPath = path.join(dataRoot, 'storage', 'crown.sqlite')
  const outsidePath = path.join(dir, 'data-sibling', 'crown.sqlite')

  assert.throws(
    () => {
      const handle = openAppDatabase({ dbPath, env: { CROWN_PORTABLE: '1' } })
      handle.close()
    },
    /portable-data-root-required/,
  )
  assert.throws(
    () => defaultDbPath({ CROWN_PORTABLE: '1', CROWN_DATA_ROOT: '\\data', CROWN_DB_PATH: dbPath }),
    /portable-data-root-invalid/,
  )
  assert.throws(
    () => {
      const handle = openAppDatabase({
        dbPath: outsidePath,
        env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot },
      })
      handle.close()
    },
    /portable-path-outside-data-root:dbPath/,
  )
})

test('portable database rejects drive-root-relative paths and in-memory storage', () => {
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-db-qualified-')), 'data')

  assert.throws(
    () => defaultDbPath({ CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot, CROWN_DB_PATH: '\\crown.sqlite' }),
    /portable-db-path-absolute-required/,
  )
  assert.throws(
    () => {
      const handle = openAppDatabase({ dbPath: ':memory:', env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot } })
      handle.close()
    },
    /portable-db-memory-forbidden/,
  )
})

test('app database creates the required SQLite tables', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath() })
  const rows = handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  handle.close()

  const names = rows.map((row) => row.name).sort()
  assert.deepEqual(names, [
    'app_schema_meta',
    'auto_betting_rule_card_leagues',
    'auto_betting_rule_cards',
    'auto_betting_settings',
    'auto_betting_signal_inbox',
    'bet_batch_account_usage',
    'bet_batches',
    'bet_child_orders',
    'bet_market_once_claims',
    'bet_notification_outbox',
    'bet_reconciliation_evidence',
    'bet_reconciliation_state',
    'bet_submit_attempts',
    'betting_account_locks',
    'betting_accounts',
    'betting_history',
    'betting_rule_leagues',
    'betting_rules',
    'execution_authorization_child_budgets',
    'execution_authorizations',
    'execution_security_audit',
    'monitor_accounts',
    'monitor_alert_settings',
    'monitor_audit_outbox',
    'monitor_candidates',
    'monitor_cooldowns',
    'monitor_deliveries',
    'monitor_event_state',
    'monitor_rules',
    'monitor_scope_state',
    'monitor_selection_state',
    'monitor_signals',
    'real_betting_runtime',
    'runtime_leases',
    'tracked_matches',
  ])
})

test('app database creates integer money columns and stable betting defaults', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const expectedMoneyColumns = {
    betting_rules: ['target_amount_minor'],
    betting_accounts: ['per_bet_limit_minor', 'stake_step_minor', 'balance_minor'],
    bet_batches: [
      'target_amount_minor',
      'reserved_amount_minor',
      'accepted_amount_minor',
      'unknown_amount_minor',
      'unfilled_amount_minor',
    ],
    bet_child_orders: [
      'requested_amount_minor',
      'preview_min_stake_minor',
      'preview_max_stake_minor',
      'preview_balance_minor',
      'preview_stake_step_minor',
    ],
    execution_authorizations: [
      'max_total_amount_minor',
      'hard_cap_amount_minor',
      'reserved_amount_minor',
      'accepted_amount_minor',
      'unknown_amount_minor',
    ],
    execution_authorization_child_budgets: ['amount_minor'],
    bet_submit_attempts: ['amount_minor'],
  }

  for (const [table, expectedColumns] of Object.entries(expectedMoneyColumns)) {
    const columns = new Map(handle.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row]))
    for (const column of expectedColumns) {
      assert.equal(columns.get(column)?.type, 'INTEGER', `${table}.${column}`)
    }
  }

  const defaults = {
    betting_rules: ['execution_mode', "'preview_only'"],
    betting_accounts: ['execution_status', "'idle'"],
    bet_batches: ['status', "'queued'"],
    bet_child_orders: ['status', "'previewing'"],
    betting_account_locks: ['status', "'reserved'"],
    execution_authorizations: ['status', "'active'"],
    execution_authorization_child_budgets: ['status', "'reserved'"],
    bet_submit_attempts: ['status', "'submit_prepared'"],
    bet_reconciliation_state: ['status', "'pending'"],
    bet_notification_outbox: ['status', "'pending'"],
  }
  for (const [table, [column, expectedDefault]] of Object.entries(defaults)) {
    const row = handle.db.prepare(`PRAGMA table_info(${table})`).all().find((entry) => entry.name === column)
    assert.equal(row?.dflt_value, expectedDefault, `${table}.${column}`)
  }

  const leagueNames = handle.db.prepare('PRAGMA table_info(betting_rules)').all()
    .find((entry) => entry.name === 'league_names_json')
  assert.equal(leagueNames?.type, 'TEXT')
  assert.equal(leagueNames?.notnull, 1)
  assert.equal(leagueNames?.dflt_value, "'[]'")

  handle.close()
})

test('submit attempts allow the new virtual-account execution path without an authorization row', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const authorization = handle.db.prepare('PRAGMA table_info(bet_submit_attempts)').all()
    .find((row) => row.name === 'authorization_id')
  assert.equal(authorization?.notnull, 0)
  handle.close()
})

test('submit attempt migration preserves authorized history and accepts neutral attempts', () => {
  const dbPath = tempDbPath()
  const seeded = openAppDatabase({ dbPath })
  seeded.db.exec(`
    INSERT INTO monitor_signals (
      signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json
    ) VALUES (
      'migration-signal','migration-signal','migration-test',1,'ready',
      '2026-07-12T00:00:00.000Z','2026-07-12T00:05:00.000Z','{}'
    );
    INSERT INTO betting_rules (id,name,enabled,currency,amount_scale,target_amount_minor,created_at,updated_at)
    VALUES ('migration-rule','migration rule',1,'CNY',0,20,'2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z');
    INSERT INTO betting_accounts (
      id,label,username,status,allocation_status,per_bet_limit_minor,currency,amount_scale,
      stake_step_minor,created_at,updated_at
    ) VALUES (
      'migration-account','migration account','migration-account','enabled','enabled',100,'CNY',0,
      1,'2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z'
    );
    INSERT INTO execution_authorizations (
      authorization_id,currency,amount_scale,rule_ids_json,max_total_amount_minor,
      hard_cap_amount_minor,valid_from,expires_at,status,created_at,updated_at
    ) VALUES (
      'migration-authorization','CNY',0,'["migration-rule"]',100,100,
      '2026-07-12T00:00:00.000Z','2026-07-12T00:01:00.000Z','expired',
      '2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z'
    );
    INSERT INTO bet_batches (
      batch_id,signal_id,rule_id,authorization_id,event_key,locked_selection_identity,
      currency,amount_scale,target_amount_minor,reserved_amount_minor,unfilled_amount_minor,status,created_at
    ) VALUES (
      'migration-batch','migration-signal','migration-rule','migration-authorization','event','identity',
      'CNY',0,20,20,0,'submitting','2026-07-12T00:00:00.000Z'
    );
    INSERT INTO bet_child_orders (
      child_order_id,batch_id,account_id,attempt,requested_amount_minor,
      preview_min_stake_minor,preview_max_stake_minor,preview_balance_minor,
      preview_stake_step_minor,preview_odds,submit_attempt_id,submit_prepared_at,status,created_at
    ) VALUES (
      'migration-child','migration-batch','migration-account',1,20,1,100,100,1,'0.91',
      'migration-submit-authorized','2026-07-12T00:00:00.000Z','submit_prepared','2026-07-12T00:00:00.000Z'
    );
    INSERT INTO bet_submit_attempts (
      submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,fencing_token,
      capability_version,capability_evidence_id,preview_odds,locked_identity_json,preview_snapshot_json,
      status,prepared_at,created_at,updated_at
    ) VALUES (
      'migration-submit-authorized','migration-child','migration-authorization',1,20,1,
      'migration-v1','migration-evidence','0.91','{"provider":"fixture"}','{}',
      'submit_prepared','2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z'
    );
  `)
  seeded.close()

  const legacy = new DatabaseSync(dbPath)
  const currentSql = legacy.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bet_submit_attempts'").get().sql
  const legacySql = currentSql
    .replace('CREATE TABLE bet_submit_attempts', 'CREATE TABLE bet_submit_attempts__legacy_not_null')
    .replace('authorization_id TEXT,', 'authorization_id TEXT NOT NULL,')
  assert.match(legacySql, /authorization_id TEXT NOT NULL/)
  legacy.exec('PRAGMA foreign_keys=OFF')
  legacy.exec('DROP TRIGGER bet_submit_attempts_immutable_update')
  legacy.exec('DROP TRIGGER bet_submit_attempts_immutable_delete')
  legacy.exec('DROP TRIGGER bet_submit_attempts_initial_status')
  legacy.exec('DROP TRIGGER bet_submit_attempts_status_transition')
  legacy.exec('DROP INDEX bet_submit_attempts_child_status_idx')
  legacy.exec(legacySql)
  legacy.exec('INSERT INTO bet_submit_attempts__legacy_not_null SELECT * FROM bet_submit_attempts')
  legacy.exec('DROP TABLE bet_submit_attempts')
  legacy.exec('ALTER TABLE bet_submit_attempts__legacy_not_null RENAME TO bet_submit_attempts')
  legacy.exec('PRAGMA foreign_keys=ON')
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const authorizationColumn = migrated.db.prepare('PRAGMA table_info(bet_submit_attempts)').all()
    .find((row) => row.name === 'authorization_id')
  assert.equal(authorizationColumn?.notnull, 0)
  assert.equal(migrated.db.prepare(`SELECT authorization_id FROM bet_submit_attempts
    WHERE submit_attempt_id='migration-submit-authorized'`).get().authorization_id, 'migration-authorization')
  assert.deepEqual({ ...migrated.db.prepare(`SELECT batch_id,account_id,child_order_id
    FROM bet_batch_account_usage WHERE batch_id='migration-batch'`).get() }, {
    batch_id: 'migration-batch', account_id: 'migration-account', child_order_id: 'migration-child',
  })
  migrated.db.prepare(`INSERT INTO bet_submit_attempts (
    submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,fencing_token,
    capability_version,capability_evidence_id,preview_odds,locked_identity_json,preview_snapshot_json,
    status,prepared_at,created_at,updated_at
  ) VALUES (
    'migration-submit-neutral','migration-child',NULL,2,20,1,
    'migration-v1','migration-evidence','0.91','{"provider":"fixture"}','{}',
    'submit_prepared','2026-07-12T00:00:01.000Z','2026-07-12T00:00:01.000Z','2026-07-12T00:00:01.000Z'
  )`).run()
  assert.equal(migrated.db.prepare("SELECT authorization_id FROM bet_submit_attempts WHERE submit_attempt_id='migration-submit-neutral'").get().authorization_id, null)
  assert.throws(() => migrated.db.prepare(`UPDATE bet_submit_attempts SET amount_minor=21
    WHERE submit_attempt_id='migration-submit-neutral'`).run(), /bet-submit-attempt-immutable/)
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
  migrated.close()
})

test('account-usage migration cancels only duplicate unsent children and keeps the first historical use', () => {
  const dbPath = tempDbPath()
  const seeded = openAppDatabase({ dbPath })
  seeded.db.exec(`
    INSERT INTO monitor_signals (
      signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json
    ) VALUES ('usage-signal','usage-key','migration-test',1,'ready',
      '2026-07-13T00:00:00.000Z','2026-07-13T00:05:00.000Z','{}');
    INSERT INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at)
    VALUES ('usage-rule','usage rule','CNY',0,100,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z');
    INSERT INTO betting_accounts (
      id,label,username,status,allocation_status,per_bet_limit_minor,currency,amount_scale,
      stake_step_minor,created_at,updated_at
    ) VALUES ('usage-account','usage account','usage-account','enabled','enabled',100,'CNY',0,1,
      '2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z');
    INSERT INTO bet_batches (
      batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,
      reserved_amount_minor,accepted_amount_minor,unfilled_amount_minor,status,created_at
    ) VALUES ('usage-batch','usage-signal','usage-rule','CNY',0,100,40,40,20,'submitting',
      '2026-07-13T00:00:00.000Z');
    INSERT INTO bet_child_orders (
      child_order_id,batch_id,account_id,attempt,requested_amount_minor,
      preview_min_stake_minor,preview_max_stake_minor,preview_balance_minor,
      preview_stake_step_minor,preview_odds,status,resolved_at,created_at
    ) VALUES
      ('usage-first','usage-batch','usage-account',1,40,1,100,100,1,'0.88','accepted',
        '2026-07-13T00:00:01.000Z','2026-07-13T00:00:00.000Z'),
      ('usage-duplicate','usage-batch','usage-account',2,40,1,100,100,1,'0.88','reserved','',
        '2026-07-13T00:00:02.000Z');
    INSERT INTO betting_account_locks (
      account_id,child_order_id,batch_id,status,fencing_token,acquired_at,updated_at
    ) VALUES ('usage-account','usage-duplicate','usage-batch','reserved',1,
      '2026-07-13T00:00:02.000Z','2026-07-13T00:00:02.000Z');
  `)
  seeded.close()

  const migrated = openAppDatabase({ dbPath })
  assert.deepEqual({ ...migrated.db.prepare(`SELECT batch_id,account_id,child_order_id
    FROM bet_batch_account_usage WHERE batch_id='usage-batch'`).get() }, {
    batch_id: 'usage-batch',
    account_id: 'usage-account',
    child_order_id: 'usage-first',
  })
  assert.deepEqual(migrated.db.prepare(`SELECT child_order_id,status,error_code
    FROM bet_child_orders WHERE batch_id='usage-batch' ORDER BY attempt`).all().map((row) => ({ ...row })), [
    { child_order_id: 'usage-first', status: 'accepted', error_code: '' },
    { child_order_id: 'usage-duplicate', status: 'cancelled', error_code: 'account-already-used-migration' },
  ])
  assert.equal(migrated.db.prepare(`SELECT COUNT(*) AS count FROM betting_account_locks
    WHERE account_id='usage-account'`).get().count, 0)
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), [])
  migrated.close()
})

test('app database migrates configured rule leagues into the dedicated JSON column', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE betting_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE betting_rule_leagues (
      rule_id TEXT NOT NULL,
      league_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (rule_id, league_name),
      UNIQUE (league_name),
      FOREIGN KEY (rule_id) REFERENCES betting_rules(id) ON DELETE CASCADE
    );
    INSERT INTO betting_rules (id, name, enabled, created_at, updated_at)
    VALUES ('legacy-rule', 'legacy rule', 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');
    INSERT INTO betting_rule_leagues (rule_id, league_name, created_at)
    VALUES ('legacy-rule', 'B', '2026-07-09T00:00:00.000Z'), ('legacy-rule', 'A', '2026-07-09T00:00:00.000Z');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const row = migrated.db.prepare("SELECT league_names_json FROM betting_rules WHERE id = 'legacy-rule'").get()
  const ownershipCount = migrated.db.prepare("SELECT COUNT(*) AS count FROM betting_rule_leagues WHERE rule_id = 'legacy-rule'").get().count
  migrated.close()

  assert.deepEqual(JSON.parse(row.league_names_json), ['A', 'B'])
  assert.equal(ownershipCount, 0)
})

test('app database migrates the persisted real hard-cap snapshot without losing authorizations', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE execution_authorizations (
      authorization_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'real',
      currency TEXT NOT NULL DEFAULT '',
      amount_scale INTEGER NOT NULL DEFAULT 2,
      rule_ids_json TEXT NOT NULL DEFAULT '[]',
      max_total_amount_minor INTEGER NOT NULL DEFAULT 0,
      reserved_amount_minor INTEGER NOT NULL DEFAULT 0,
      accepted_amount_minor INTEGER NOT NULL DEFAULT 0,
      unknown_amount_minor INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      confirmation_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO execution_authorizations (
      authorization_id, currency, max_total_amount_minor, status
    ) VALUES ('legacy-authorization', 'CNY', 100, 'expired');
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const column = migrated.db.prepare('PRAGMA table_info(execution_authorizations)').all()
    .find((row) => row.name === 'hard_cap_amount_minor')
  const row = migrated.db.prepare("SELECT * FROM execution_authorizations WHERE authorization_id = 'legacy-authorization'").get()

  assert.equal(column?.type, 'INTEGER')
  assert.equal(column?.notnull, 1)
  assert.equal(column?.dflt_value, '0')
  assert.equal(row.max_total_amount_minor, 100)
  assert.equal(row.hard_cap_amount_minor, 0)
  assert.throws(() => migrated.db.prepare(`
    UPDATE execution_authorizations
    SET hard_cap_amount_minor = 9223372036854775807
    WHERE authorization_id = 'legacy-authorization'
  `).run(), /constraint/i)
  assert.throws(() => migrated.db.prepare(`
    UPDATE execution_authorizations
    SET max_total_amount_minor = 9223372036854775807
    WHERE authorization_id = 'legacy-authorization'
  `).run(), /constraint/i)
  assert.throws(() => migrated.db.prepare(`
    UPDATE execution_authorizations
    SET reserved_amount_minor = 1.5
    WHERE authorization_id = 'legacy-authorization'
  `).run(), /constraint/i)
  migrated.db.prepare("UPDATE execution_authorizations SET reserved_amount_minor = 60 WHERE authorization_id = 'legacy-authorization'").run()
  assert.throws(() => migrated.db.prepare(`
    UPDATE execution_authorizations
    SET accepted_amount_minor = 50
    WHERE authorization_id = 'legacy-authorization'
  `).run(), /constraint/i)
  migrated.close()
})

test('app database rejects unsafe legacy authorization rows in SQL before JavaScript reads them', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE execution_authorizations (
      authorization_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'real', currency TEXT NOT NULL DEFAULT 'CNY',
      amount_scale INTEGER NOT NULL DEFAULT 2, rule_ids_json TEXT NOT NULL DEFAULT '[]',
      max_total_amount_minor INTEGER NOT NULL DEFAULT 0,
      reserved_amount_minor INTEGER NOT NULL DEFAULT 0,
      accepted_amount_minor INTEGER NOT NULL DEFAULT 0,
      unknown_amount_minor INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', confirmation_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO execution_authorizations (
      authorization_id, max_total_amount_minor, status
    ) VALUES ('unsafe-legacy', 9223372036854775807, 'expired');
  `)
  legacy.close()

  assert.throws(
    () => openAppDatabase({ dbPath }),
    (error) => error?.message === 'execution-authorization-legacy-invalid' && error?.code !== 'ERR_OUT_OF_RANGE',
  )
})

test('app database limits every ledger amount to JavaScript safe integers', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const maxSafe = 9007199254740991
  const moneyColumns = {
    betting_rules: ['target_amount_minor'],
    betting_accounts: ['per_bet_limit_minor', 'stake_step_minor', 'balance_minor'],
    execution_authorizations: [
      'max_total_amount_minor',
      'hard_cap_amount_minor',
      'reserved_amount_minor',
      'accepted_amount_minor',
      'unknown_amount_minor',
    ],
    execution_authorization_child_budgets: ['amount_minor'],
    bet_batches: [
      'target_amount_minor',
      'reserved_amount_minor',
      'accepted_amount_minor',
      'unknown_amount_minor',
      'unfilled_amount_minor',
    ],
    bet_child_orders: [
      'requested_amount_minor',
      'preview_min_stake_minor',
      'preview_max_stake_minor',
      'preview_balance_minor',
      'preview_stake_step_minor',
    ],
  }
  for (const [table, columns] of Object.entries(moneyColumns)) {
    const sql = handle.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql
      .replace(/\s+/g, ' ')
    for (const column of columns) {
      assert.equal(sql.includes(`typeof(${column}) = 'integer'`), true, `${table}.${column} integer check`)
      assert.equal(sql.includes(`${column} <= ${maxSafe}`), true, `${table}.${column} safe integer check`)
    }
  }

  handle.db.prepare(`
    INSERT INTO betting_rules (
      id, name, currency, amount_scale, target_amount_minor, created_at, updated_at
    ) VALUES ('safe-rule', 'safe', 'CNY', 2, ?, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(maxSafe)
  assert.equal(handle.db.prepare("SELECT target_amount_minor FROM betting_rules WHERE id = 'safe-rule'").get().target_amount_minor, maxSafe)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO betting_rules (id, name, target_amount_minor, created_at, updated_at)
    VALUES ('unsafe-rule', 'unsafe', 9223372036854775807, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(), /constraint/i)

  handle.db.prepare(`
    INSERT INTO betting_accounts (
      id, label, username, per_bet_limit_minor, stake_step_minor, balance_minor, created_at, updated_at
    ) VALUES ('safe-account', 'safe', 'safe', ?, ?, ?, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(maxSafe, maxSafe, maxSafe)
  assert.equal(handle.db.prepare("SELECT balance_minor FROM betting_accounts WHERE id = 'safe-account'").get().balance_minor, maxSafe)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO betting_accounts (id, label, username, balance_minor, created_at, updated_at)
    VALUES ('unsafe-account', 'unsafe', 'unsafe', 9223372036854775807, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(), /constraint/i)

  handle.db.prepare(`
    INSERT INTO execution_authorizations (
      authorization_id, max_total_amount_minor, status
    ) VALUES ('safe-authorization', ?, 'expired')
  `).run(maxSafe)
  assert.equal(handle.db.prepare("SELECT max_total_amount_minor FROM execution_authorizations WHERE authorization_id = 'safe-authorization'").get().max_total_amount_minor, maxSafe)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO execution_authorizations (
      authorization_id, max_total_amount_minor, status
    ) VALUES ('unsafe-authorization', 9223372036854775807, 'expired')
  `).run(), /constraint/i)

  handle.db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (
      'safe-signal', 'safe-signal-key', 'safe-strategy', 1, 'ready',
      '2026-07-10T00:00:00.000Z', '2026-07-10T00:05:00.000Z', '{}'
    )
  `).run()
  handle.db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (
      'unsafe-signal', 'unsafe-signal-key', 'safe-strategy', 1, 'ready',
      '2026-07-10T00:00:00.000Z', '2026-07-10T00:05:00.000Z', '{}'
    )
  `).run()
  handle.db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, target_amount_minor, unfilled_amount_minor
    ) VALUES ('safe-batch', 'safe-signal', 'safe-rule', ?, ?)
  `).run(maxSafe, maxSafe)
  assert.equal(handle.db.prepare("SELECT target_amount_minor FROM bet_batches WHERE batch_id = 'safe-batch'").get().target_amount_minor, maxSafe)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_batches (batch_id, signal_id, rule_id, target_amount_minor)
    VALUES ('unsafe-batch', 'unsafe-signal', 'safe-rule', 9223372036854775807)
  `).run(), /constraint/i)

  handle.db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor,
      preview_balance_minor, preview_stake_step_minor
    ) VALUES ('safe-child', 'safe-batch', 'safe-account', ?, ?, ?, ?, ?)
  `).run(maxSafe, maxSafe, maxSafe, maxSafe, maxSafe)
  assert.equal(handle.db.prepare("SELECT requested_amount_minor FROM bet_child_orders WHERE child_order_id = 'safe-child'").get().requested_amount_minor, maxSafe)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, attempt, requested_amount_minor
    ) VALUES ('unsafe-child', 'safe-batch', 'safe-account', 2, 9223372036854775807)
  `).run(), /constraint/i)

  handle.close()
})

test('app database enforces betting uniqueness, foreign keys, locks, and amount checks', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })

  function uniqueColumns(table) {
    return handle.db.prepare(`PRAGMA index_list(${table})`).all()
      .filter((index) => index.unique)
      .map((index) => handle.db.prepare(`PRAGMA index_info(${index.name})`).all().map((row) => row.name).join(','))
  }

  assert.equal(uniqueColumns('bet_batches').includes('signal_id,rule_id'), true)
  assert.equal(uniqueColumns('bet_batch_account_usage').includes('batch_id,account_id'), true)
  assert.equal(uniqueColumns('betting_rule_leagues').includes('league_name'), true)

  const lockAccount = handle.db.prepare('PRAGMA table_info(betting_account_locks)').all()
    .find((column) => column.name === 'account_id')
  assert.equal(lockAccount?.pk, 1)

  const expectedForeignKeys = {
    betting_rule_leagues: ['rule_id->betting_rules.id'],
    bet_batches: [
      'authorization_id->execution_authorizations.authorization_id',
      'rule_id->betting_rules.id',
      'signal_id->monitor_signals.signal_id',
    ],
    bet_child_orders: ['account_id->betting_accounts.id', 'batch_id->bet_batches.batch_id'],
    bet_batch_account_usage: [
      'account_id->betting_accounts.id',
      'batch_id->bet_batches.batch_id',
      'child_order_id->bet_child_orders.child_order_id',
    ],
    execution_authorization_child_budgets: [
      'account_id->betting_accounts.id',
      'authorization_id->execution_authorizations.authorization_id',
      'batch_id->bet_batches.batch_id',
      'child_order_id->bet_child_orders.child_order_id',
    ],
    betting_account_locks: [
      'account_id->betting_accounts.id',
      'batch_id->bet_batches.batch_id',
      'child_order_id->bet_child_orders.child_order_id',
    ],
  }
  for (const [table, expected] of Object.entries(expectedForeignKeys)) {
    const actual = handle.db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map((row) => `${row.from}->${row.table}.${row.to}`)
      .sort()
    assert.deepEqual(actual, expected.sort(), table)
  }

  for (const table of ['betting_rules', 'betting_accounts', 'bet_batches', 'bet_child_orders', 'execution_authorizations', 'execution_authorization_child_budgets']) {
    const sql = handle.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql
    assert.match(sql, /typeof\s*\(/i, `${table} integer check`)
    assert.match(sql, table === 'execution_authorization_child_budgets' ? />=\s*1|>\s*0/i : />=\s*0/i, `${table} non-negative check`)
  }

  assert.throws(() => handle.db.prepare(`
    INSERT INTO betting_rules (id, name, target_amount_minor, created_at, updated_at)
    VALUES ('bad-rule', 'bad', 1.5, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO betting_accounts (id, label, username, per_bet_limit_minor, created_at, updated_at)
    VALUES ('bad-account', 'bad', 'bad', -1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run(), /constraint/i)

  handle.close()
})

test('app database creates monitor v2 state columns with required constraints', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const expected = {
    monitor_scope_state: [
      ['scope_key', 0, null, 1],
      ['last_batch_id', 1, null, 0],
      ['last_captured_at', 1, null, 0],
      ['last_complete_at', 1, null, 0],
      ['event_keys_json', 1, "'[]'", 0],
    ],
    monitor_event_state: [
      ['event_key', 0, null, 1],
      ['match_group_key', 0, null, 0],
      ['active', 1, '1', 0],
      ['missing_count', 1, '0', 0],
      ['last_seen_at', 1, null, 0],
      ['provider_ids_json', 1, "'{}'", 0],
      ['event_json', 1, "'{}'", 0],
    ],
    monitor_selection_state: [
      ['selection_identity', 0, null, 1],
      ['event_key', 1, null, 0],
      ['captured_at', 1, null, 0],
      ['snapshot_json', 1, null, 0],
    ],
    monitor_signals: [
      ['signal_id', 0, null, 1],
      ['signal_key', 1, null, 0],
      ['strategy_id', 1, null, 0],
      ['strategy_version', 1, null, 0],
      ['status', 1, null, 0],
      ['observed_at', 1, null, 0],
      ['expires_at', 1, null, 0],
      ['payload_json', 1, null, 0],
    ],
    monitor_cooldowns: [
      ['signal_key', 0, null, 1],
      ['expires_at', 1, null, 0],
    ],
    monitor_deliveries: [
      ['signal_id', 1, null, 1],
      ['channel', 1, null, 2],
      ['status', 1, null, 0],
      ['attempts', 1, '0', 0],
      ['next_attempt_at', 1, null, 0],
      ['last_error_code', 1, "''", 0],
      ['updated_at', 1, null, 0],
    ],
    monitor_audit_outbox: [
      ['fact_id', 0, null, 1],
      ['fact_kind', 1, null, 0],
      ['batch_id', 1, null, 0],
      ['status', 1, "'pending'", 0],
      ['payload_json', 1, null, 0],
      ['created_at', 1, null, 0],
      ['delivered_at', 1, "''", 0],
    ],
    monitor_candidates: [
      ['candidate_id', 0, null, 1],
      ['signal_id', 1, null, 0],
      ['status', 1, null, 0],
      ['export_status', 1, "'pending'", 0],
      ['created_at', 1, null, 0],
      ['exported_at', 1, "''", 0],
      ['payload_json', 1, null, 0],
    ],
  }

  for (const [table, columns] of Object.entries(expected)) {
    const actual = handle.db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => [row.name, row.notnull, row.dflt_value, row.pk])
    assert.deepEqual(actual, columns, table)
  }
  handle.close()
})

test('app database creates login result columns for monitor accounts', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath() })
  const columns = handle.db.prepare('PRAGMA table_info(monitor_accounts)').all().map((row) => row.name)
  handle.close()

  assert.equal(columns.includes('last_login_result_json'), true)
  assert.equal(columns.includes('last_login_result_at'), true)
  assert.equal(columns.includes('last_login_diagnostics_path'), true)
})

test('app database creates betting rule direction mode column', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath() })
  const columns = handle.db.prepare('PRAGMA table_info(betting_rules)').all().map((row) => row.name)
  handle.close()

  assert.equal(columns.includes('bet_direction_mode'), true)
})

test('app database creates canonical auto-bet rule and allocation columns', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const ruleColumns = handle.db.prepare('PRAGMA table_info(betting_rules)').all().map((row) => row.name)
  const accountColumns = handle.db.prepare('PRAGMA table_info(betting_accounts)').all().map((row) => row.name)
  handle.close()

  for (const column of [
    'priority', 'monitor_enabled', 'real_betting_enabled', 'archived', 'mode', 'period',
    'market_type', 'monitored_side', 'min_water_rise', 'target_odds_min', 'target_odds_max',
    'migration_review_required',
  ]) assert.equal(ruleColumns.includes(column), true, column)
  assert.equal(accountColumns.includes('allocation_status'), true)
})

test('app database creates betting account manual order column', () => {
  const handle = openAppDatabase({ dbPath: tempDbPath() })
  const columns = handle.db.prepare('PRAGMA table_info(betting_accounts)').all().map((row) => row.name)
  handle.close()

  assert.equal(columns.includes('bet_order'), true)
})

test('app database translates legacy dry-run test data names', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  first.db.prepare(`
    INSERT INTO betting_rules (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run('brule_manual', 'Manual dry-run rule', '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z')
  first.db.prepare(`
    INSERT INTO betting_accounts (id, label, username, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('bet_manual', 'manual-dry-run', 'manual-dry-run', '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z')
  first.close()

  const second = openAppDatabase({ dbPath })
  const rule = second.db.prepare('SELECT name FROM betting_rules WHERE id = ?').get('brule_manual')
  const account = second.db.prepare('SELECT label, username FROM betting_accounts WHERE id = ?').get('bet_manual')
  second.close()

  assert.equal(rule.name, '手动预览规则')
  assert.equal(account.label, '手动预览账号')
  assert.equal(account.username, '手动预览账号')
})

test('app database migrates legacy betting rules safely and preserves betting history', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE betting_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      per_account_bet_amount REAL NOT NULL DEFAULT 0,
      per_account_daily_limit REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      market_type TEXT NOT NULL DEFAULT 'asian_handicap',
      min_odds REAL,
      max_odds REAL,
      bet_direction_mode TEXT NOT NULL DEFAULT 'auto',
      max_single_amount REAL NOT NULL DEFAULT 0,
      max_event_amount REAL NOT NULL DEFAULT 0,
      stop_loss_amount REAL NOT NULL DEFAULT 0,
      preview_only INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE betting_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE betting_history (
      id TEXT PRIMARY KEY,
      betting_account_id TEXT,
      event_key TEXT,
      rule_id TEXT,
      status TEXT NOT NULL DEFAULT 'preview',
      amount REAL NOT NULL DEFAULT 0,
      odds_raw TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO betting_rules (
      id, name, per_account_bet_amount, enabled, created_at, updated_at
    ) VALUES (
      'legacy-rule', 'legacy enabled rule', 12.34, 1,
      '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z'
    );
    INSERT INTO betting_history (
      id, rule_id, status, amount, created_at, details_json
    ) VALUES (
      'legacy-history', 'legacy-rule', 'preview', 12.34,
      '2026-07-09T00:00:00.000Z', '{"legacy":true}'
    );
  `)
  legacy.close()

  const migrated = openAppDatabase({ dbPath })
  const rule = migrated.db.prepare(`
    SELECT enabled, execution_mode, target_amount_minor
    FROM betting_rules
    WHERE id = 'legacy-rule'
  `).get()
  const history = migrated.db.prepare(`
    SELECT id, rule_id, status, amount, details_json
    FROM betting_history
    WHERE id = 'legacy-history'
  `).get()
  const migratedRuleSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'betting_rules'").get().sql
  const migratedAccountSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'betting_accounts'").get().sql
  assert.equal(rule.enabled, 0)
  assert.equal(rule.execution_mode, 'preview_only')
  assert.equal(rule.target_amount_minor, 0)
  assert.equal(history.id, 'legacy-history')
  assert.equal(history.rule_id, 'legacy-rule')
  assert.equal(history.status, 'preview')
  assert.equal(history.amount, 12.34)
  assert.equal(history.details_json, '{"legacy":true}')
  assert.match(migratedRuleSql, /target_amount_minor <= 9007199254740991/)
  assert.match(migratedAccountSql, /per_bet_limit_minor <= 9007199254740991/)
  assert.match(migratedAccountSql, /stake_step_minor <= 9007199254740991/)
  assert.match(migratedAccountSql, /balance_minor <= 9007199254740991/)
  migrated.db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES (
      'new-rule', 'new enabled rule', 1, 'preview_only', 'CNY', 2,
      100, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
    )
  `).run()
  migrated.close()

  const reopened = openAppDatabase({ dbPath })
  assert.equal(reopened.db.prepare("SELECT enabled FROM betting_rules WHERE id = 'new-rule'").get().enabled, 1)
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM betting_history WHERE id = 'legacy-history'").get().count, 1)
  reopened.close()
})

test('app database rolls back schema changes when legacy rule safety migration is interrupted', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE betting_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO betting_rules (id, name, enabled, created_at, updated_at)
    VALUES (
      'interrupted-rule', 'legacy enabled rule', 1,
      '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z'
    );
    CREATE TRIGGER fail_rule_safety_update
    BEFORE UPDATE OF enabled ON betting_rules
    BEGIN
      SELECT RAISE(ABORT, 'migration-interrupted');
    END;
  `)
  legacy.close()

  assert.throws(() => openAppDatabase({ dbPath }), /migration-interrupted/)

  const afterFailure = new DatabaseSync(dbPath)
  const columnsAfterFailure = afterFailure.prepare('PRAGMA table_info(betting_rules)').all().map((row) => row.name)
  assert.equal(columnsAfterFailure.includes('execution_mode'), false)
  assert.equal(afterFailure.prepare("SELECT enabled FROM betting_rules WHERE id = 'interrupted-rule'").get().enabled, 1)
  afterFailure.exec('DROP TRIGGER fail_rule_safety_update')
  afterFailure.close()

  const recovered = openAppDatabase({ dbPath })
  const rule = recovered.db.prepare(`
    SELECT enabled, execution_mode
    FROM betting_rules
    WHERE id = 'interrupted-rule'
  `).get()
  assert.equal(rule.enabled, 0)
  assert.equal(rule.execution_mode, 'preview_only')
  recovered.close()
})

test('app database persists rows after close and reopen', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  first.db.prepare(`
    INSERT INTO tracked_matches (
      event_key, league, home_team, away_team, mode, source_status, tracking_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('crown|联赛|主队|客队|prematch', '联赛', '主队', '客队', 'prematch', 'open', 'active', '2026-07-08T00:00:00.000Z', '2026-07-08T00:00:00.000Z')
  first.close()

  const second = openAppDatabase({ dbPath })
  const row = second.db.prepare('SELECT league, home_team, away_team FROM tracked_matches WHERE event_key = ?').get('crown|联赛|主队|客队|prematch')
  second.close()

  assert.equal(row.league, '联赛')
  assert.equal(row.home_team, '主队')
  assert.equal(row.away_team, '客队')
})
