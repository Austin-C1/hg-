import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { handleAppApi } from '../src/crown/app/app-api.mjs'
import { Readable } from 'node:stream'
import { watcherLeaseKey } from '../src/crown/app/watcher-lease-key.mjs'
import { realBettingStatusCoreDto } from '../src/crown/app/real-betting-dto.mjs'

const NOW = '2026-07-11T12:00:00.000Z'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-operations-'))
  const dbPath = path.join(root, 'app.sqlite')
  const runtimeDir = path.join(root, 'runtime')
  const handle = openAppDatabase({ dbPath })
  const repo = createAppRepository(handle.db, { now: () => new Date(NOW), dbPath, runtimeDir })
  return { ...handle, repo, runtimeDir }
}

function setAlert(db, mode, { enabled, reviewRequired = false, asianHandicap = true, total = false }) {
  db.prepare(`UPDATE monitor_alert_settings SET
    enabled = ?, migration_review_required = ?, asian_handicap_enabled = ?, total_enabled = ?
    WHERE mode = ?`
  ).run(Number(enabled), Number(reviewRequired), Number(asianHandicap), Number(total), mode)
}

function setAutoBetting(db, mode, { enabled, reviewRequired = false, realEligible = false, version = 1, eligibilityVersion = 1 }) {
  db.prepare(`UPDATE auto_betting_settings SET
    enabled = ?, migration_review_required = ?, target_odds_min = '0.8', target_odds_max = '1.1',
    target_amount_minor = 100, real_eligible = ?, version = ?, real_eligibility_version = ?
    WHERE mode = ?`
  ).run(Number(enabled), Number(reviewRequired), Number(realEligible), version, eligibilityVersion, mode)
}

test('operations summary aggregates bounded runtime, risk and backlog state without secret fields', () => {
  const { db, dbPath, runtimeDir, close, repo } = fixture()
  db.prepare(`UPDATE real_betting_runtime
    SET requested = 1, runtime_state = 'blocked', reason_code = 'capability-evidence-not-exact', updated_at = ?
    WHERE singleton_id = 1`
  ).run('2026-07-11T11:59:55.000Z')
  db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES (?, 'private-owner', 123, ?, ?, ?, 7)`
  ).run(watcherLeaseKey({ dbPath, runtimeDir }), '2026-07-11T11:59:00.000Z', '2026-07-11T11:59:58.000Z', '2026-07-11T12:00:28.000Z')
  db.prepare(`INSERT INTO monitor_accounts
    (id, label, username, enabled, status, last_odds_parsed_at, secret_ciphertext, created_at, updated_at)
    VALUES ('monitor', '监控', 'private-user', 1, 'enabled', ?, 'secret', ?, ?)`
  ).run('2026-07-11T11:59:50.000Z', NOW, NOW)
  setAlert(db, 'prematch', { enabled: true, asianHandicap: true, total: true })
  setAlert(db, 'live', { enabled: true, asianHandicap: false, total: true })
  setAutoBetting(db, 'prematch', { enabled: true, realEligible: true, version: 3, eligibilityVersion: 5 })
  setAutoBetting(db, 'live', { enabled: true, realEligible: false, version: 7, eligibilityVersion: 9 })
  db.exec('DELETE FROM auto_betting_rule_card_leagues; DELETE FROM auto_betting_rule_cards')

  for (const [id, enabled, review] of [['card-1', 1, 0], ['card-2', 0, 1], ['card-3', 0, 0]]) {
    db.prepare(`INSERT INTO auto_betting_rule_cards (
      card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
      real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
      migration_review_reason,version,created_at,updated_at
    ) VALUES (?,?,?,'0.8','1.05',100,'CNY',0,'',0,1,?,?,?,1,?,?)`)
      .run(id, id, enabled, NOW, review, review ? 'review' : '', NOW, NOW)
  }
  for (const [cardId, league] of [['card-1', '英超'], ['card-1', '西甲'], ['card-2', '德甲']]) {
    db.prepare('INSERT INTO auto_betting_rule_card_leagues VALUES (?,?,?)').run(cardId, league, NOW)
  }

  db.prepare(`INSERT INTO betting_rules
    (id, name, monitor_enabled, real_betting_enabled, enabled, archived, target_amount_minor, created_at, updated_at)
    VALUES ('rule', '规则', 1, 1, 1, 0, 100, ?, ?)`
  ).run(NOW, NOW)
  for (const [suffix, observedAt] of [['recent', '2026-07-11T11:55:00.000Z'], ['old', '2026-07-09T11:55:00.000Z']]) {
    db.prepare(`INSERT INTO monitor_signals
      (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json)
      VALUES (?, ?, 'rule', 1, 'ready', ?, ?, '{}')`
    ).run(`signal-${suffix}`, `key-${suffix}`, observedAt, '2026-07-12T00:00:00.000Z')
  }

  const accounts = [
    ['enabled', 'enabled', 'idle'],
    ['pending', 'pause_pending', 'reserved'],
    ['paused', 'paused', 'unknown'],
  ]
  for (const [id, allocation, execution] of accounts) {
    db.prepare(`INSERT INTO betting_accounts
      (id, label, username, status, archived, allocation_status, per_bet_limit_minor,
       execution_status, secret_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, 'enabled', 0, ?, 100, ?, 'secret', ?, ?)`
    ).run(id, id, `${id}-private-user`, allocation, execution, NOW, NOW)
  }

  db.prepare(`INSERT INTO bet_batches
    (batch_id, signal_id, rule_id, target_amount_minor, unknown_amount_minor,
     unfilled_amount_minor, status, finish_reason, created_at)
    VALUES ('batch-unknown', 'signal-recent', 'rule', 100, 40, 60,
      'waiting_result', 'provider-private-reference', ?)`
  ).run('2026-07-11T11:56:00.000Z')
  db.prepare(`INSERT INTO bet_child_orders
    (child_order_id, batch_id, account_id, requested_amount_minor, status,
     provider_reference_ciphertext, created_at, resolved_at)
    VALUES ('child', 'batch-unknown', 'paused', 40, 'unknown', 'private-provider-ref', ?, ?)`
  ).run('2026-07-11T11:56:00.000Z', '2026-07-11T11:57:00.000Z')
  db.prepare(`INSERT INTO betting_account_locks
    (account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at)
    VALUES ('paused', 'child', 'batch-unknown', 'unknown', 1, ?, ?)`
  ).run(NOW, NOW)

  // Foreign-key-safe submit/reconciliation rows are not needed to prove aggregate SQL;
  // this fixture temporarily disables FK only for compact operational-state seeding.
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(`INSERT INTO execution_authorizations
    (authorization_id, currency, rule_ids_json, max_total_amount_minor, hard_cap_amount_minor,
     valid_from, expires_at, status, created_at, updated_at)
    VALUES ('auth', 'CNY', '["rule"]', 100, 100, ?, ?, 'revoked', ?, ?)`
  ).run('2026-07-11T00:00:00.000Z', '2026-07-12T00:00:00.000Z', NOW, NOW)
  db.prepare(`INSERT INTO bet_submit_attempts
    (submit_attempt_id, child_order_id, authorization_id, attempt_ordinal, amount_minor,
     fencing_token, capability_version, capability_evidence_id, preview_odds,
     locked_identity_json, preview_snapshot_json, status, prepared_at, result_at,
     created_at, updated_at)
    VALUES ('attempt', 'child', 'auth', 1, 40, 1, 'v', 'e', '0.9', '{}', '{}',
      'submit_prepared', ?, '', ?, ?)`
  ).run(NOW, NOW, NOW)
  db.prepare(`UPDATE bet_submit_attempts
    SET status = 'unknown', result_at = ?, error_code = 'timeout', updated_at = ?
    WHERE submit_attempt_id = 'attempt'`
  ).run(NOW, NOW)
  db.prepare(`INSERT INTO bet_reconciliation_state
    (submit_attempt_id, status, next_poll_at, deadline_at, created_at, updated_at)
    VALUES ('attempt', 'dead_letter', ?, ?, ?, ?)`
  ).run('2026-07-11T11:59:00.000Z', '2026-07-11T11:59:30.000Z', NOW, NOW)
  db.prepare(`INSERT INTO bet_notification_outbox
    (notification_id, batch_id, child_order_id, final_status, status, payload_json, created_at, updated_at)
    VALUES ('notice', 'batch-unknown', 'child', 'unknown', 'pending', '{}', ?, ?)`
  ).run(NOW, NOW)

  const item = repo.getOperationsSummary()
  close()

  assert.equal(item.serverTime, NOW)
  assert.deepEqual(item.freshness, {
    lastOddsAt: '2026-07-11T11:59:50.000Z', ageMs: 10_000, state: 'fresh', staleAfterMs: 60_000,
  })
  assert.deepEqual(item.watcher, {
    active: true, unique: true, activeCount: 1,
    heartbeatAt: '2026-07-11T11:59:58.000Z', expiresAt: '2026-07-11T12:00:28.000Z', fencingToken: 7,
  })
  assert.deepEqual(item.runtime, {
    requested: true, state: 'blocked', reasonCode: 'capability-evidence-not-exact', updatedAt: '2026-07-11T11:59:55.000Z',
  })
  assert.deepEqual(item.monitorAlerts, {
    prematch: { enabled: true, reviewRequired: false, markets: { asianHandicap: true, total: true } },
    live: { enabled: true, reviewRequired: false, markets: { asianHandicap: false, total: true } },
  })
  assert.deepEqual(item.ruleCards, { total: 3, enabled: 1, reviewRequired: 1, ownedLeagues: 3 })
  assert.equal('autoBetting' in item, false)
  assert.deepEqual(item.readiness, {
    monitor: { state: 'ready', ready: true, reason: '' },
    rules: { state: 'ready', ready: true, reason: '' },
    accounts: { state: 'ready', ready: true, reason: '' },
    realBetting: { state: 'blocked', ready: false, reason: 'capability-evidence-not-exact' },
  })
  assert.deepEqual(item.rules, { total: 3, monitorEnabled: 1, realEnabled: 1, hitCount: 2, recentHitCount: 1 })
  assert.deepEqual(item.accounts, {
    total: 3, enabled: 1, pausePending: 1, paused: 1, checking: 0, locked: 1, unknown: 1,
  })
  assert.equal(item.batches.recentLimit, 20)
  assert.equal(item.batches.recentCount, 1)
  assert.equal(item.batches.unknownAmountMinor, 40)
  assert.equal(item.reconciliation.deadLetter, 1)
  assert.equal(item.reconciliation.due, 0)
  assert.deepEqual(item.notifications, { backlog: 1, pending: 1, delivering: 0, deadLetter: 0 })
  assert.equal(item.recentBatches.length, 1)
  assert.deepEqual(Object.keys(item.recentBatches[0]).sort(), ['acceptedAmountMinor', 'batchId', 'createdAt', 'status', 'unknownAmountMinor'].sort())
  assert.doesNotMatch(JSON.stringify(item), /private|secret|providerReference|ownerId|leaseKey/i)
  assert.doesNotMatch(JSON.stringify(item), /targetOdds|targetAmount|remark|migrationReviewReason|eligibilityUpdatedAt/i)
})

test('operations readiness uses dynamic cards without a fixed mode intersection and keeps stable reasons', () => {
  const { db, dbPath, runtimeDir, close, repo } = fixture()
  db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES (?, 'owner', 1, ?, ?, ?, 1)`
  ).run(watcherLeaseKey({ dbPath, runtimeDir }), '2026-07-11T11:59:00.000Z', '2026-07-11T11:59:58.000Z', '2026-07-11T12:00:28.000Z')
  db.prepare(`INSERT INTO monitor_accounts
    (id, label, username, enabled, status, last_odds_parsed_at, secret_ciphertext, created_at, updated_at)
    VALUES ('monitor', 'monitor', 'user', 1, 'enabled', ?, 'ciphertext', ?, ?)`
  ).run('2026-07-11T11:59:50.000Z', NOW, NOW)

  const reasons = new Set([
    '', 'monitor-alerts-disabled', 'auto-betting-disabled', 'settings-review-required', 'rule-cards-not-ready',
  ])
  const summary = () => {
    const item = repo.getOperationsSummary()
    assert.ok(reasons.has(item.readiness.monitor.reason), item.readiness.monitor.reason)
    assert.ok(reasons.has(item.readiness.rules.reason), item.readiness.rules.reason)
    return item
  }

  db.exec(`UPDATE monitor_alert_settings SET enabled=0, migration_review_required=0;
    DELETE FROM auto_betting_rule_card_leagues; DELETE FROM auto_betting_rule_cards`)
  assert.deepEqual(summary().readiness.monitor, { state: 'action-required', ready: false, reason: 'monitor-alerts-disabled' })
  assert.deepEqual(summary().readiness.rules, { state: 'action-required', ready: false, reason: 'auto-betting-disabled' })

  setAlert(db, 'prematch', { enabled: true })
  assert.deepEqual(summary().readiness.monitor, { state: 'ready', ready: true, reason: '' })
  assert.deepEqual(summary().readiness.rules, { state: 'action-required', ready: false, reason: 'auto-betting-disabled' })

  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,currency,amount_scale,remark,real_eligible,real_eligibility_version,
    real_eligibility_updated_at,migration_review_required,migration_review_reason,version,created_at,updated_at
  ) VALUES ('review','review',0,'CNY',0,'',0,1,?,1,'review',1,?,?)`).run(NOW, NOW, NOW)
  assert.deepEqual(summary().readiness.rules, { state: 'action-required', ready: false, reason: 'settings-review-required' })

  db.exec("DELETE FROM auto_betting_rule_cards WHERE card_id='review'")
  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('ready','ready',1,'0.8','1.05',100,'CNY',0,'',0,1,?,0,'',1,?,?)`).run(NOW, NOW, NOW)
  db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('ready','英超',?)").run(NOW)
  setAlert(db, 'prematch', { enabled: false })
  assert.equal(summary().readiness.rules.ready, true)
  assert.equal(summary().monitorAlerts.prematch.enabled, false)
  close()
})

test('operations rule readiness validates every enabled card and fails closed on corrupted storage', () => {
  const { db, close, repo } = fixture()
  db.exec('DELETE FROM auto_betting_rule_card_leagues; DELETE FROM auto_betting_rule_cards')
  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('validated','validated',1,'0.8','1.05',100,'CNY',0,'',0,1,?,0,'',1,?,?)`).run(NOW, NOW, NOW)
  db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('validated','英超',?)").run(NOW)
  const readiness = () => repo.getOperationsSummary().readiness.rules
  const reset = () => db.prepare(`UPDATE auto_betting_rule_cards SET
    name='validated',enabled=1,target_odds_min='0.8',target_odds_max='1.05',target_amount_minor=100,
    currency='CNY',amount_scale=0,remark='',real_eligible=0,real_eligibility_version=1,
    real_eligibility_updated_at=?,migration_review_required=0,migration_review_reason='',version=1,
    created_at=?,updated_at=? WHERE card_id='validated'`).run(NOW, NOW, NOW)

  assert.deepEqual(readiness(), { state: 'ready', ready: true, reason: '' })
  db.exec('PRAGMA ignore_check_constraints=ON')
  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('corrupt-peer','corrupt',1,'','1.05',100,'CNY',0,'',0,1,?,0,'',1,?,?)`).run(NOW, NOW, NOW)
  db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('corrupt-peer','西甲',?)").run(NOW)
  assert.deepEqual(readiness(), { state: 'action-required', ready: false, reason: 'rule-cards-not-ready' })
  db.exec("DELETE FROM auto_betting_rule_card_leagues WHERE card_id='corrupt-peer'; DELETE FROM auto_betting_rule_cards WHERE card_id='corrupt-peer'")
  for (const [name, mutate] of [
    ['empty name', () => db.exec("UPDATE auto_betting_rule_cards SET name='' WHERE card_id='validated'")],
    ['empty odds', () => db.exec("UPDATE auto_betting_rule_cards SET target_odds_min='' WHERE card_id='validated'")],
    ['invalid odds', () => db.exec("UPDATE auto_betting_rule_cards SET target_odds_min='01.2' WHERE card_id='validated'")],
    ['noncanonical odds', () => db.exec("UPDATE auto_betting_rule_cards SET target_odds_min='0.80' WHERE card_id='validated'")],
    ['inverse odds', () => db.exec("UPDATE auto_betting_rule_cards SET target_odds_min='2',target_odds_max='1' WHERE card_id='validated'")],
    ['unsafe amount', () => db.exec("UPDATE auto_betting_rule_cards SET target_amount_minor=9007199254740992.0 WHERE card_id='validated'")],
    ['unsafe review flag', () => db.exec("UPDATE auto_betting_rule_cards SET migration_review_required=9007199254740992 WHERE card_id='validated'")],
  ]) {
    mutate()
    assert.deepEqual(readiness(), { state: 'action-required', ready: false, reason: 'rule-cards-not-ready' }, name)
    reset()
  }
  for (const mutate of [
    () => db.exec("UPDATE auto_betting_rule_cards SET real_eligibility_version=0 WHERE card_id='validated'"),
    () => db.exec("UPDATE auto_betting_rule_cards SET real_eligible=2 WHERE card_id='validated'"),
    () => db.exec("UPDATE auto_betting_rule_cards SET real_eligibility_updated_at='bad' WHERE card_id='validated'"),
  ]) {
    mutate()
    assert.deepEqual(readiness(), { state: 'ready', ready: true, reason: '' })
    reset()
  }
  db.exec("DELETE FROM auto_betting_rule_card_leagues WHERE card_id='validated'")
  assert.deepEqual(readiness(), { state: 'action-required', ready: false, reason: 'rule-cards-not-ready' })
  close()
})

test('operations summary bounds recent batches and reports missing freshness', () => {
  const { db, close, repo } = fixture()
  db.prepare(`INSERT INTO betting_rules (id, name, created_at, updated_at) VALUES ('rule', 'rule', ?, ?)`
  ).run(NOW, NOW)
  for (let index = 0; index < 35; index += 1) {
    db.prepare(`INSERT INTO monitor_signals
      (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json)
      VALUES (?, ?, 'rule', 1, 'ready', ?, ?, '{}')`
    ).run(`signal-${index}`, `key-${index}`, NOW, '2026-07-12T00:00:00.000Z')
    db.prepare(`INSERT INTO bet_batches
      (batch_id, signal_id, rule_id, target_amount_minor, unfilled_amount_minor, status, created_at)
      VALUES (?, ?, 'rule', 1, 1, 'failed', ?)`
    ).run(`batch-${String(index).padStart(2, '0')}`, `signal-${index}`, new Date(Date.parse(NOW) - index * 1000).toISOString())
  }
  const item = repo.getOperationsSummary()
  close()
  assert.equal(item.freshness.state, 'missing')
  assert.deepEqual(item.readiness, {
    monitor: { state: 'blocked', ready: false, reason: 'monitor-account-not-configured' },
    rules: { state: 'action-required', ready: false, reason: 'settings-review-required' },
    accounts: { state: 'action-required', ready: false, reason: 'betting-accounts-paused' },
    realBetting: { state: 'off', ready: false, reason: 'global-real-betting-off' },
  })
  assert.equal(item.batches.recentCount, 20)
  assert.equal(item.recentBatches.length, 8)
})

test('operations summary counts unresolved unknown money outside the recent 20 batches', () => {
  const { db, close, repo } = fixture()
  db.prepare(`INSERT INTO betting_rules (id, name, created_at, updated_at) VALUES ('rule', 'rule', ?, ?)`
  ).run(NOW, NOW)
  for (let index = 0; index < 21; index += 1) {
    db.prepare(`INSERT INTO monitor_signals
      (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json)
      VALUES (?, ?, 'rule', 1, 'ready', ?, ?, '{}')`
    ).run(`signal-${index}`, `key-${index}`, NOW, '2026-07-12T00:00:00.000Z')
    db.prepare(`INSERT INTO bet_batches
      (batch_id, signal_id, rule_id, target_amount_minor, unknown_amount_minor,
       unfilled_amount_minor, status, created_at)
      VALUES (?, ?, 'rule', 100, ?, ?, ?, ?)`
    ).run(`batch-${index}`, `signal-${index}`, index === 20 ? 77 : 0,
      index === 20 ? 23 : 100, index === 20 ? 'waiting_result' : 'failed',
      new Date(Date.parse(NOW) - index * 1000).toISOString())
  }
  const item = repo.getOperationsSummary()
  close()
  assert.equal(item.batches.recentCount, 20)
  assert.equal(item.batches.unknownAmountMinor, 77)
})

test('operations summary uses only the exact watcher lease and rejects a stale heartbeat', () => {
  const { db, dbPath, runtimeDir, close, repo } = fixture()
  db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('watcher:another-db:another-runtime', 'other', 1, ?, ?, ?, 1)`
  ).run('2026-07-11T11:59:00.000Z', '2026-07-11T11:59:59.000Z', '2026-07-11T12:01:00.000Z')
  assert.deepEqual(repo.getOperationsSummary().watcher, {
    active: false, unique: false, activeCount: 0, heartbeatAt: null, expiresAt: null, fencingToken: 0,
  })

  db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES (?, 'exact', 2, ?, ?, ?, 9)`
  ).run(watcherLeaseKey({ dbPath, runtimeDir }), '2026-07-11T11:57:00.000Z', '2026-07-11T11:58:00.000Z', '2026-07-11T12:01:00.000Z')
  assert.deepEqual(repo.getOperationsSummary().watcher, {
    active: false, unique: true, activeCount: 0,
    heartbeatAt: '2026-07-11T11:58:00.000Z', expiresAt: '2026-07-11T12:01:00.000Z', fencingToken: 9,
  })
  close()
})

test('runtime DTO normalizes invalid boundaries and operations summary cannot leak polluted reasons or timestamps', () => {
  assert.deepEqual(realBettingStatusCoreDto({
    requested: true, state: 'C:\\private\\state', reasonCode: 'C:\\private\\reason', updatedAt: 'C:\\private\\time',
  }), { requested: true, state: 'blocked', reasonCode: '', updatedAt: '' })

  const { db, close, repo } = fixture()
  db.prepare(`UPDATE real_betting_runtime SET requested=1, runtime_state='blocked', reason_code=?, updated_at=? WHERE singleton_id=1`)
    .run('C:\\private\\reason', 'C:\\private\\time')
  assert.deepEqual(repo.getOperationsSummary().runtime, {
    requested: true, state: 'blocked', reasonCode: '', updatedAt: '',
  })
  close()
})

test('runtime DTO drops deprecated account freshness reasons and preserves current configuration reasons', () => {
  for (const reasonCode of [
    'betting-account-login-not-fresh',
    'betting-account-balance-not-fresh',
  ]) {
    assert.equal(realBettingStatusCoreDto({ requested: true, state: 'armed_waiting', reasonCode }).reasonCode, '')
  }
  for (const reasonCode of [
    'betting-rule-card-not-enabled',
    'betting-account-unavailable',
  ]) {
    assert.equal(realBettingStatusCoreDto({ requested: true, state: 'armed_waiting', reasonCode }).reasonCode, reasonCode)
  }
})

test('operations summary preserves allowlisted pure-mode armed waiting reasons and filters raw pollution', () => {
  const { db, close, repo } = fixture()
  const stableReasons = [
    'capability-evidence-not-exact',
    'authorization-not-active',
    'fence-not-fresh',
    'executor-lease-not-fresh',
    'reconciler-lease-not-fresh',
    'executor-reconciler-lease-not-distinct',
  ]
  for (const reason of stableReasons) {
    db.prepare(`UPDATE real_betting_runtime
      SET requested=1, runtime_state='armed_waiting', reason_code=?, updated_at=?
      WHERE singleton_id=1`
    ).run(reason, NOW)
    assert.deepEqual(repo.getOperationsSummary().readiness.realBetting, {
      state: 'action-required', ready: false, reason,
    })
  }

  for (const reason of ['', 'C:\\private\\runtime-error']) {
    db.prepare(`UPDATE real_betting_runtime
      SET requested=1, runtime_state='armed_waiting', reason_code=?, updated_at=?
      WHERE singleton_id=1`
    ).run(reason, NOW)
    assert.deepEqual(repo.getOperationsSummary().readiness.realBetting, {
      state: 'action-required', ready: false, reason: 'safety-preflight-pending',
    })
  }
  close()
})

async function callEndpoint({ dbPath, method, monitorProcess }) {
  const req = Readable.from([])
  req.method = method
  let status = 0
  let body = ''
  const res = {
    writeHead(value) { status = value },
    end(value = '') { body += String(value) },
  }
  await handleAppApi(req, res, new URL('/api/app/operations-summary', 'http://127.0.0.1'), {
    dbPath,
    now: () => new Date(NOW),
    monitorProcess,
  })
  return { status, payload: JSON.parse(body) }
}

test('operations summary endpoint is GET-only and returns the bounded safe DTO', async () => {
  const { dbPath, close } = fixture()
  close()

  const get = await callEndpoint({ dbPath, method: 'GET' })
  assert.equal(get.status, 200)
  assert.equal(get.payload.item.serverTime, NOW)
  assert.equal(get.payload.item.batches.recentLimit, 20)
  assert.equal(get.payload.item.recentBatches.length, 0)
  assert.doesNotMatch(JSON.stringify(get.payload), /secret|providerReference|ownerId|leaseKey/i)

  const post = await callEndpoint({ dbPath, method: 'POST' })
  assert.deepEqual(post, { status: 405, payload: { error: 'method-not-allowed' } })
})

test('operations summary projects bounded Watcher recovery diagnostics from the process controller', async () => {
  const { dbPath, close } = fixture()
  close()
  const monitorProcess = {
    getStatus() {
      return {
        desiredRunning: true,
        processState: 'waiting-restart',
        restartAttempt: 2,
        nextRestartAt: '2026-07-11T12:00:05.000Z',
        lastExit: {
          exitCode: 1,
          signal: null,
          exitedAt: '2026-07-11T12:00:00.000Z',
          stderrSummary: 'watcher transport failed',
        },
      }
    },
  }

  const result = await callEndpoint({ dbPath, method: 'GET', monitorProcess })
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload.item.watcher.process, monitorProcess.getStatus())
})
