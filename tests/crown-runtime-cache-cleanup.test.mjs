import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { previewRuntimeCleanup, runRuntimeCleanup } from '../src/crown/app/runtime-cache-cleanup.mjs'

function write(root, relative, text = 'cache') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

test('manual cleanup removes only reproducible work data and preserves functional state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-cleanup-'))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  const insert = handle.db.prepare(`INSERT INTO monitor_audit_outbox
    (fact_id, fact_kind, batch_id, status, payload_json, created_at, delivered_at)
    VALUES (?, 'snapshot', 'batch', ?, '{}', '2026-07-12T00:00:00.000Z', ?)`)
  insert.run('delivered', 'delivered', '2026-07-12T00:01:00.000Z')
  insert.run('pending', 'pending', '')
  handle.db.prepare("INSERT INTO betting_accounts (id, label, username, created_at, updated_at) VALUES ('keep-account', '保留账号', 'user', ?, ?)").run('2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  handle.db.prepare("INSERT INTO bet_market_once_claims (market_once_key, rule_id, signal_id, claim_status, created_at) VALUES ('old-market', 'legacy-live', 'old-signal', 'claimed', ?)").run('2026-07-11T00:00:00.000Z')
  handle.db.prepare("INSERT INTO tracked_matches (event_key, league, home_team, away_team, mode, created_at, updated_at) VALUES ('old-event', '联赛', '主队', '客队', 'live', ?, ?)").run('2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('old-preview', NULL, 'event', NULL, 'previewed', 10, '0.95', '2026-07-11T00:00:00.000Z', '{}')`).run()
  handle.close()

  const removable = [
    write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl'),
    write(root, 'data/runtime/crown-odds-changes-v2.jsonl'),
    write(root, 'data/runtime/betting-candidates-v2.jsonl'),
    write(root, 'data/runtime/crown-watch-runtime.jsonl'),
    write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl.audit-index.sqlite'),
    write(root, 'data/crown-profile/Default/Cache/cache.bin'),
    write(root, 'output/verification/result.sqlite'),
    write(root, 'logs/watcher.log'),
    write(root, '.playwright-cli/page.yml'),
  ]
  const protectedFiles = [
    write(root, 'data/runtime/crown-sessions/session.json'),
    write(root, 'data/runtime/betting-protocol-captures/run/private/raw-network.jsonl'),
    write(root, 'data/runtime/betting-execution-audit.jsonl'),
    write(root, 'data/fixtures/crown/fixture.json'),
    write(root, 'frontend/dist/index.html'),
  ]
  const events = []
  const processController = {
    isRunning: () => true,
    async stopAndWait() { events.push('stop') },
    start() { events.push('start'); return { running: true } },
  }
  const bettingProcess = {
    isRunning: () => true,
    async stop() { events.push('bet-stop'); return { stopped: true } },
  }

  const preview = previewRuntimeCleanup({ workspaceDir: root, dbPath })
  assert.equal(preview.files >= removable.length, true)
  assert.equal(preview.bytes > 0, true)
  assert.equal(preview.databaseRows.betting_history, 1)
  assert.equal(preview.records >= 2, true)
  const result = await runRuntimeCleanup({ workspaceDir: root, dbPath, monitorProcess: processController, bettingProcess })
  assert.deepEqual(events, ['bet-stop', 'stop', 'start'])
  assert.equal(result.restartedWatcher, true)
  for (const file of removable) assert.equal(fs.existsSync(file), false, file)
  for (const file of protectedFiles) assert.equal(fs.existsSync(file), true, file)

  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM monitor_audit_outbox WHERE status='delivered'").get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM monitor_audit_outbox').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM betting_history').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM tracked_matches').get().count, 0)
  assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM betting_accounts WHERE id='keep-account'").get().count, 1)
  assert.equal(verify.db.prepare('SELECT requested FROM real_betting_runtime WHERE singleton_id=1').get().requested, 0)
  verify.close()
})

test('failed cleanup still restores a watcher that was running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-cleanup-fail-'))
  const events = []
  const processController = {
    isRunning: () => true,
    async stopAndWait() { events.push('stop') },
    start() { events.push('start') },
  }
  await assert.rejects(runRuntimeCleanup({
    workspaceDir: root,
    dbPath: path.join(root, 'storage', 'missing.sqlite'),
    monitorProcess: processController,
  }), /database/i)
  assert.deepEqual(events, ['stop', 'start'])
})

test('safe-start cleanup pauses betting accounts and starts an enabled configured monitor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-safe-start-'))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  const time = '2026-07-12T00:00:00.000Z'
  handle.db.prepare(`INSERT INTO monitor_accounts (
    id, label, username, status, enabled, secret_ciphertext, created_at, updated_at
  ) VALUES ('mon_primary', 'monitor', 'monitor-user', 'enabled', 1, 'encrypted-secret', ?, ?)`)
    .run(time, time)
  handle.db.prepare(`INSERT INTO betting_accounts (
    id, label, username, allocation_status, created_at, updated_at
  ) VALUES ('bet-enabled', 'enabled account', 'bet-user', 'enabled', ?, ?)`)
    .run(time, time)
  handle.db.prepare(`UPDATE real_betting_runtime
    SET requested=1, runtime_state='running', updated_at=? WHERE singleton_id=1`).run(time)
  handle.close()

  const events = []
  const monitorProcess = {
    isRunning: () => false,
    start(options) { events.push(['start', options]); return { running: true } },
  }

  const result = await runRuntimeCleanup({ workspaceDir: root, dbPath, monitorProcess })

  assert.equal(result.restartedWatcher, true)
  assert.equal(result.accountsPaused, 1)
  assert.equal(result.monitorStartReason, 'enabled-configured-account')
  assert.equal(events.length, 1)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT allocation_status FROM betting_accounts WHERE id='bet-enabled'").get().allocation_status, 'paused')
  const runtime = verify.db.prepare('SELECT requested, runtime_state FROM real_betting_runtime WHERE singleton_id=1').get()
  assert.equal(runtime.requested, 0)
  assert.equal(runtime.runtime_state, 'off')
  verify.close()
})

test('manual cleanup refuses an active unmanaged watcher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-cleanup-unmanaged-'))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('watcher:test', 'manual-cli', 999, ?, ?, ?, 1)`)
    .run('2026-07-12T00:00:00.000Z', '2026-07-12T00:00:10.000Z', '2999-07-12T00:00:20.000Z')
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')

  await assert.rejects(runRuntimeCleanup({ workspaceDir: root, dbPath }), /watcher-active-unmanaged/)
  assert.equal(fs.existsSync(history), true)
})

test('daily reset preserves dynamic cards and ownership while clearing card runtime snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-cleanup-'))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  const now = '2026-07-12T00:00:00.000Z'
  handle.db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('keep-card','保留卡片',1,'0.8','1.05',100,'CNY',0,'备注',0,1,?,0,'',2,?,?)`).run(now, now, now)
  handle.db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('keep-card','英超',?)").run(now)
  const before = JSON.stringify({
    card: { ...handle.db.prepare("SELECT * FROM auto_betting_rule_cards WHERE card_id='keep-card'").get() },
    league: { ...handle.db.prepare("SELECT * FROM auto_betting_rule_card_leagues WHERE card_id='keep-card'").get() },
  })
  const snapshot = JSON.stringify({ cardId: 'keep-card', version: 2 })
  handle.db.prepare("INSERT INTO monitor_signals VALUES ('cleanup-signal','cleanup-key','test',1,'ready',?,'2026-07-12T01:00:00.000Z','{}')").run(now)
  handle.db.prepare(`INSERT INTO auto_betting_signal_inbox (
    signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,
    status,created_at,updated_at
  ) VALUES ('cleanup-signal','keep-card',2,?,'prematch',2,?,'pending',?,?)`).run(snapshot, snapshot, now, now)
  handle.db.prepare(`INSERT INTO bet_batches (
    batch_id,signal_id,card_id,card_version,card_snapshot_json,rule_id,betting_mode,
    target_amount_minor,unfilled_amount_minor,status,created_at
  ) VALUES ('cleanup-batch','cleanup-signal','keep-card',2,?,NULL,'prematch',100,100,'queued',?)`).run(snapshot, now)
  handle.db.prepare(`INSERT INTO bet_market_once_claims (
    market_once_key,card_id,card_version,rule_id,betting_mode,settings_version,signal_id,
    batch_id,claim_status,created_at,updated_at
  ) VALUES ('cleanup-market','keep-card',2,NULL,'prematch',NULL,'cleanup-signal',
    'cleanup-batch','batch_created',?,?)`).run(now, now)
  handle.close()

  const preview = previewRuntimeCleanup({ workspaceDir: root, dbPath })
  assert.equal(preview.databaseRows.auto_betting_signal_inbox, 1)
  await runRuntimeCleanup({ workspaceDir: root, dbPath })
  const verify = openAppDatabase({ dbPath })
  assert.equal(JSON.stringify({
    card: { ...verify.db.prepare("SELECT * FROM auto_betting_rule_cards WHERE card_id='keep-card'").get() },
    league: { ...verify.db.prepare("SELECT * FROM auto_betting_rule_card_leagues WHERE card_id='keep-card'").get() },
  }), before)
  assert.equal(verify.db.prepare('SELECT COUNT(*) count FROM auto_betting_signal_inbox').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) count FROM bet_batches').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 0)
  assert.equal(verify.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  verify.close()
})
