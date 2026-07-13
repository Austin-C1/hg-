import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

const NOW = '2026-07-11T00:00:00.000Z'
const LATER = '2026-07-11T00:05:00.000Z'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-b2-schema-')), 'crown.sqlite')
}

function seedLedger(db) {
  db.exec(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES ('signal-1', 'signal-key-1', 'strategy-1', 1, 'ready', '${NOW}', '${LATER}', '{}');

    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES ('rule-1', 'rule', 1, 'real_eligible', 'CNY', 2, 100, '${NOW}', '${NOW}');

    INSERT INTO betting_accounts (
      id, label, username, status, per_bet_limit_minor, currency,
      amount_scale, stake_step_minor, created_at, updated_at
    ) VALUES ('account-1', 'account', 'account', 'enabled', 100, 'CNY', 2, 1, '${NOW}', '${NOW}');

    INSERT INTO execution_authorizations (
      authorization_id, currency, amount_scale, rule_ids_json,
      max_total_amount_minor, hard_cap_amount_minor, valid_from,
      expires_at, status, created_at, updated_at
    ) VALUES ('authorization-1', 'CNY', 2, '["rule-1"]', 100, 100,
      '${NOW}', '${LATER}', 'active', '${NOW}', '${NOW}');

    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, authorization_id, target_amount_minor,
      unfilled_amount_minor, currency, amount_scale, created_at
    ) VALUES ('batch-1', 'signal-1', 'rule-1', 'authorization-1', 100, 100, 'CNY', 2, '${NOW}');

    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor,
      preview_balance_minor, preview_stake_step_minor, preview_odds,
      status, created_at
    ) VALUES ('child-1', 'batch-1', 'account-1', 100, 1, 100, 100, 1, '0.95', 'reserved', '${NOW}');
  `)
}

function insertAttempt(db, {
  id = 'attempt-1',
  childOrderId = 'child-1',
  ordinal = 1,
  amountMinor = 100,
  status = 'submit_prepared',
  previewOdds = '0.95',
  lockedIdentityJson = '{"eventKey":"event-1","lineKey":"line-1"}',
  previewSnapshotJson = '{"odds":"0.95","maxStakeMinor":100}',
} = {}) {
  return db.prepare(`
    INSERT INTO bet_submit_attempts (
      submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
      amount_minor, fencing_token, capability_version,
      capability_evidence_id, preview_odds, locked_identity_json, preview_snapshot_json,
      status, prepared_at, created_at, updated_at
    ) VALUES (?, ?, 'authorization-1', ?, ?, 7, 'crown-capability-v1',
      'capability-evidence-1', ?, ?, ?, ?, '${NOW}', '${NOW}', '${NOW}')
  `).run(id, childOrderId, ordinal, amountMinor, previewOdds, lockedIdentityJson, previewSnapshotJson, status)
}

test('B2 schema creates durable attempt, reconciliation, evidence, and notification tables', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const tables = new Set(handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  for (const table of [
    'bet_submit_attempts',
    'bet_reconciliation_state',
    'bet_reconciliation_evidence',
    'bet_notification_outbox',
  ]) {
    assert.equal(tables.has(table), true, table)
  }

  const attemptColumns = new Set(handle.db.prepare('PRAGMA table_info(bet_submit_attempts)').all().map((row) => row.name))
  for (const column of [
    'submit_attempt_id', 'child_order_id', 'authorization_id', 'attempt_ordinal',
    'amount_minor', 'fencing_token', 'capability_version', 'capability_evidence_id',
    'preview_odds', 'locked_identity_json', 'preview_snapshot_json', 'status', 'prepared_at',
    'dispatched_at', 'result_at', 'provider_reference_ciphertext',
    'result_payload_hash', 'error_code', 'created_at', 'updated_at',
  ]) {
    assert.equal(attemptColumns.has(column), true, `bet_submit_attempts.${column}`)
  }

  const foreignKeys = (table) => handle.db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map((row) => `${row.from}->${row.table}.${row.to}`)
    .sort()
  assert.deepEqual(foreignKeys('bet_submit_attempts'), [
    'authorization_id->execution_authorizations.authorization_id',
    'child_order_id->bet_child_orders.child_order_id',
  ])
  assert.deepEqual(foreignKeys('bet_reconciliation_state'), [
    'submit_attempt_id->bet_submit_attempts.submit_attempt_id',
  ])
  assert.deepEqual(foreignKeys('bet_reconciliation_evidence'), [
    'submit_attempt_id->bet_submit_attempts.submit_attempt_id',
  ])
  assert.deepEqual(foreignKeys('bet_notification_outbox'), [
    'batch_id->bet_batches.batch_id',
    'child_order_id->bet_child_orders.child_order_id',
  ])

  const triggerNames = new Set(handle.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name))
  for (const trigger of [
    'bet_submit_attempts_immutable_update',
    'bet_submit_attempts_immutable_delete',
    'bet_submit_attempts_initial_status',
    'bet_submit_attempts_status_transition',
    'bet_reconciliation_evidence_immutable_update',
    'bet_reconciliation_evidence_immutable_delete',
    'bet_notification_outbox_status_transition',
  ]) {
    assert.equal(triggerNames.has(trigger), true, trigger)
  }
  handle.close()
})

test('submit attempts preserve immutable identity while allowing only valid lifecycle transitions', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seedLedger(handle.db)
  insertAttempt(handle.db)

  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-duplicate', ordinal: 1 }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-ordinal-0', ordinal: 0 }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-ordinal-3', ordinal: 3 }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-fractional', ordinal: 1.5 }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-bad-money', ordinal: 2, amountMinor: 1.5 }), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_submit_attempts (
      submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
      amount_minor, fencing_token, capability_version, capability_evidence_id,
      locked_identity_json, preview_snapshot_json, prepared_at, created_at, updated_at
    ) VALUES ('attempt-unsafe-money', 'child-1', 'authorization-1', 2,
      9223372036854775807, 7, 'v1', 'evidence', '{}', '{}', '${NOW}', '${NOW}', '${NOW}')
  `).run(), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-bad-identity', ordinal: 2, lockedIdentityJson: 'not-json' }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-bad-preview', ordinal: 2, previewSnapshotJson: '[]' }), /constraint/i)
  assert.throws(() => insertAttempt(handle.db, { id: 'attempt-no-child', childOrderId: 'missing-child' }), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_submit_attempts (
      submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
      amount_minor, fencing_token, capability_version, capability_evidence_id,
      locked_identity_json, preview_snapshot_json, status, prepared_at,
      dispatched_at, result_at, created_at, updated_at
    ) VALUES ('attempt-direct-result', 'child-1', 'authorization-1', 2,
      100, 7, 'v1', 'evidence', '{}', '{}', 'accepted', '${NOW}',
      '${NOW}', '${NOW}', '${NOW}', '${NOW}')
  `).run(), /must-start-prepared/i)

  assert.throws(() => handle.db.prepare("UPDATE bet_submit_attempts SET amount_minor = 99 WHERE submit_attempt_id = 'attempt-1'").run(), /immutable/i)
  assert.throws(() => handle.db.prepare("DELETE FROM bet_submit_attempts WHERE submit_attempt_id = 'attempt-1'").run(), /immutable/i)
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'accepted', dispatched_at = '${NOW}', result_at = '${NOW}'
    WHERE submit_attempt_id = 'attempt-1'
  `).run(), /transition/i)

  handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'submit_dispatched', dispatched_at = '${NOW}', updated_at = '${NOW}'
    WHERE submit_attempt_id = 'attempt-1'
  `).run()
  handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'unknown', result_at = '${NOW}', error_code = 'provider-timeout',
        result_payload_hash = '${HASH_A}', updated_at = '${NOW}'
    WHERE submit_attempt_id = 'attempt-1'
  `).run()
  handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'accepted', result_at = '${LATER}',
        provider_reference_ciphertext = 'enc:v1:ciphertext', updated_at = '${LATER}'
    WHERE submit_attempt_id = 'attempt-1'
  `).run()
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_submit_attempts SET status = 'rejected' WHERE submit_attempt_id = 'attempt-1'
  `).run(), /transition/i)

  insertAttempt(handle.db, { id: 'attempt-2', ordinal: 2, previewOdds: '0.96' })
  handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'submit_dispatched', dispatched_at = '${NOW}', updated_at = '${NOW}'
    WHERE submit_attempt_id = 'attempt-2'
  `).run()
  handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'odds_changed_unsent', result_at = '${NOW}',
        error_code = 'odds-changed-not-accepted', updated_at = '${NOW}'
    WHERE submit_attempt_id = 'attempt-2'
  `).run()
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_submit_attempts
    SET status = 'accepted', result_at = '${LATER}', updated_at = '${LATER}'
    WHERE submit_attempt_id = 'attempt-2'
  `).run(), /transition/i)

  const row = handle.db.prepare("SELECT * FROM bet_submit_attempts WHERE submit_attempt_id = 'attempt-1'").get()
  assert.equal(row.status, 'accepted')
  assert.equal(row.provider_reference_ciphertext, 'enc:v1:ciphertext')
  assert.equal(row.error_code, 'provider-timeout')
  assert.equal(row.preview_odds, '0.95')
  assert.equal(handle.db.prepare("SELECT status FROM bet_submit_attempts WHERE submit_attempt_id = 'attempt-2'").get().status, 'odds_changed_unsent')
  assert.equal(handle.db.prepare("SELECT preview_odds FROM bet_submit_attempts WHERE submit_attempt_id = 'attempt-2'").get().preview_odds, '0.96')
  handle.close()
})

test('reconciliation schedule is durable and evidence is append-only and idempotent', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seedLedger(handle.db)
  insertAttempt(handle.db)

  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_reconciliation_state (
      submit_attempt_id, status, poll_count, next_poll_at, deadline_at,
      last_source, last_payload_hash, created_at, updated_at
    ) VALUES ('attempt-1', 'waiting', 0, '${NOW}', '', '', '', '${NOW}', '${NOW}')
  `).run(), /constraint/i)
  handle.db.prepare(`
    INSERT INTO bet_reconciliation_state (
      submit_attempt_id, status, poll_count, next_poll_at, deadline_at,
      last_source, last_payload_hash, created_at, updated_at
    ) VALUES ('attempt-1', 'waiting', 2, '${NOW}', '${LATER}',
      'get_dangerous', '${HASH_A}', '${NOW}', '${NOW}')
  `).run()
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_reconciliation_state SET poll_count = 1.5 WHERE submit_attempt_id = 'attempt-1'
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_reconciliation_state SET poll_count = -1 WHERE submit_attempt_id = 'attempt-1'
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_reconciliation_state SET status = 'retry-forever' WHERE submit_attempt_id = 'attempt-1'
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_reconciliation_state SET last_source = 'unverified-endpoint' WHERE submit_attempt_id = 'attempt-1'
  `).run(), /constraint/i)

  handle.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-1', 'attempt-1', 'get_dangerous', 'unknown', '${HASH_A}', '', '${NOW}', '${NOW}')
  `).run()
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-duplicate', 'attempt-1', 'get_dangerous', 'unknown', '${HASH_A}', '', '${LATER}', '${LATER}')
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-manual-no-operator', 'attempt-1', 'manual', 'accepted', '${HASH_B}', '', '${NOW}', '${NOW}')
  `).run(), /constraint/i)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-bad-hash', 'attempt-1', 'today_wagers', 'accepted', 'raw-payload', '', '${NOW}', '${NOW}')
  `).run(), /constraint/i)
  handle.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-manual', 'attempt-1', 'manual', 'accepted', '${HASH_B}', 'operator-1', '${NOW}', '${NOW}')
  `).run()
  assert.throws(() => handle.db.prepare("UPDATE bet_reconciliation_evidence SET decision = 'rejected' WHERE evidence_id = 'evidence-1'").run(), /immutable/i)
  assert.throws(() => handle.db.prepare("DELETE FROM bet_reconciliation_evidence WHERE evidence_id = 'evidence-1'").run(), /immutable/i)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 2)
  handle.close()
})

test('notification outbox enforces idempotency, leases, backoff, and safe payloads', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seedLedger(handle.db)

  const insertNotification = ({
    id = 'notification-1',
    finalStatus = 'accepted',
    status = 'pending',
    attemptCount = 0,
    payloadJson = '{"batchId":"batch-1","childOrderId":"child-1","finalStatus":"accepted"}',
  } = {}) => handle.db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status, status,
      attempt_count, next_attempt_at, lease_owner, lease_fencing_token,
      lease_expires_at, payload_json, created_at, updated_at
    ) VALUES (?, 'batch-1', 'child-1', ?, ?, ?, '${NOW}', '', 0, '', ?, '${NOW}', '${NOW}')
  `).run(id, finalStatus, status, attemptCount, payloadJson)

  insertNotification()
  assert.throws(() => insertNotification({ id: 'notification-duplicate' }), /constraint/i)
  assert.throws(() => insertNotification({ id: 'notification-bad-status', finalStatus: 'success' }), /constraint/i)
  assert.throws(() => insertNotification({ id: 'notification-bad-delivery', finalStatus: 'unknown', status: 'sending' }), /constraint/i)
  assert.throws(() => insertNotification({ id: 'notification-bad-count', finalStatus: 'unknown', attemptCount: 1.5 }), /constraint/i)
  assert.throws(() => insertNotification({ id: 'notification-bad-json', finalStatus: 'unknown', payloadJson: '[]' }), /constraint/i)
  insertNotification({
    id: 'notification-alert',
    finalStatus: 'circuit_open',
    payloadJson: '{"batchId":"batch-1","childOrderId":"child-1","finalStatus":"circuit_open"}',
  })

  handle.db.prepare(`
    UPDATE bet_notification_outbox
    SET status = 'delivering', attempt_count = 1, lease_owner = 'worker-1',
        lease_fencing_token = 8, lease_expires_at = '${LATER}', updated_at = '${NOW}'
    WHERE notification_id = 'notification-1'
  `).run()
  handle.db.prepare(`
    UPDATE bet_notification_outbox
    SET status = 'delivered', delivered_at = '${LATER}', updated_at = '${LATER}'
    WHERE notification_id = 'notification-1'
  `).run()
  const row = handle.db.prepare("SELECT * FROM bet_notification_outbox WHERE notification_id = 'notification-1'").get()
  assert.equal(row.status, 'delivered')
  assert.equal(row.attempt_count, 1)
  assert.equal(row.lease_fencing_token, 8)
  assert.throws(() => handle.db.prepare(`
    UPDATE bet_notification_outbox
    SET status = 'pending', delivered_at = '', updated_at = '${LATER}'
    WHERE notification_id = 'notification-1'
  `).run(), /transition/i)

  handle.db.exec(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES ('signal-2', 'signal-key-2', 'strategy-1', 1, 'ready', '${NOW}', '${LATER}', '{}');
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, authorization_id, target_amount_minor,
      unfilled_amount_minor, currency, amount_scale, created_at
    ) VALUES ('batch-2', 'signal-2', 'rule-1', 'authorization-1', 100, 100, 'CNY', 2, '${NOW}');
  `)
  assert.throws(() => handle.db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status, payload_json,
      created_at, updated_at
    ) VALUES ('notification-mismatch', 'batch-2', 'child-1', 'failed', '{}', '${NOW}', '${NOW}')
  `).run(), /child-batch-mismatch/i)
  handle.close()
})

test('B2 schema migration preserves legacy rows and is idempotent across reopen', () => {
  const dbPath = tempDbPath()
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE tracked_matches (
      event_key TEXT PRIMARY KEY,
      league TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      mode TEXT NOT NULL,
      source_status TEXT NOT NULL DEFAULT '',
      tracking_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO tracked_matches (
      event_key, league, home_team, away_team, mode, created_at, updated_at
    ) VALUES ('legacy-event', 'legacy-league', 'home', 'away', 'prematch', '${NOW}', '${NOW}');
  `)
  legacy.close()

  const first = openAppDatabase({ dbPath })
  seedLedger(first.db)
  insertAttempt(first.db)
  first.db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES ('evidence-1', 'attempt-1', 'today_wagers', 'accepted', '${HASH_A}', '', '${NOW}', '${NOW}')
  `).run()
  first.db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status, payload_json,
      created_at, updated_at
    ) VALUES ('notification-1', 'batch-1', 'child-1', 'accepted', '{}', '${NOW}', '${NOW}')
  `).run()
  first.close()

  const second = openAppDatabase({ dbPath })
  second.close()
  const third = openAppDatabase({ dbPath })
  assert.equal(third.db.prepare("SELECT COUNT(*) AS count FROM tracked_matches WHERE event_key = 'legacy-event'").get().count, 1)
  assert.equal(third.db.prepare('SELECT COUNT(*) AS count FROM bet_submit_attempts').get().count, 1)
  assert.equal(third.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 1)
  assert.equal(third.db.prepare('SELECT COUNT(*) AS count FROM bet_notification_outbox').get().count, 1)
  assert.equal(third.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'bet_%immutable%'").get().count, 5)
  third.close()
})
