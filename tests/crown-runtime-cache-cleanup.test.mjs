import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { bettingRoleLeaseKeys } from '../src/crown/app/betting-process.mjs'
import { CrownHumanLoginController } from '../src/crown/app/crown-human-login-controller.mjs'
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
  const campaignId = 'a'.repeat(64)
  handle.db.prepare(`INSERT INTO crown_browser_acceptance_campaigns
    (campaign_id, schema_version, capability_version, manifest_json, manifest_hmac, status, created_at, updated_at)
    VALUES (?, 'crown-browser-api-acceptance-v1', 'capability-v1', '{}', ?, 'active', ?, ?)`)
    .run(campaignId, 'b'.repeat(64), '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  handle.db.prepare(`INSERT INTO crown_browser_acceptance_cases
    (campaign_id, direction_id, ordinal, mode, period, market_type, line_variant, selection_side,
      protocol_evidence_digest, capability_evidence_id, created_at, updated_at)
    VALUES (?, 'prematch-ah-home', 1, 'prematch', 'full_time', 'asian_handicap', 'main', 'home',
      'protocol-proof', 'capability-proof', ?, ?)`)
    .run(campaignId, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
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
    async waitForLeaseAvailable() { events.push('lease-available'); return { available: true } },
    start() { events.push('start'); return { running: true } },
    async waitForHealthy() { events.push('healthy'); return { healthy: true } },
  }
  let bettingRunning = true
  const bettingProcess = {
    isRunning: () => bettingRunning,
    async stop() { events.push('bet-stop'); bettingRunning = false; return { stopped: true } },
  }

  const preview = previewRuntimeCleanup({ workspaceDir: root, dbPath })
  assert.equal(preview.files >= removable.length, true)
  assert.equal(preview.bytes > 0, true)
  assert.equal(preview.databaseRows.betting_history, 1)
  assert.equal(preview.records >= 2, true)
  const result = await runRuntimeCleanup({ workspaceDir: root, dbPath, monitorProcess: processController, bettingProcess })
  assert.deepEqual(events, ['bet-stop', 'stop', 'lease-available', 'start', 'healthy'])
  assert.equal(result.restartedWatcher, true)
  for (const file of removable) assert.equal(fs.existsSync(file), false, file)
  for (const file of protectedFiles) assert.equal(fs.existsSync(file), true, file)

  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM monitor_audit_outbox WHERE status='delivered'").get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM monitor_audit_outbox').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM betting_history').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM tracked_matches').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM crown_browser_acceptance_cases').get().count, 0)
  assert.equal(verify.db.prepare('SELECT COUNT(*) AS count FROM crown_browser_acceptance_campaigns').get().count, 0)
  assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM betting_accounts WHERE id='keep-account'").get().count, 1)
  assert.equal(verify.db.prepare('SELECT requested FROM real_betting_runtime WHERE singleton_id=1').get().requested, 0)
  verify.close()
})

test('cleanup does not report success until the restored managed watcher is healthy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-watcher-health-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  openAppDatabase({ dbPath }).close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  const events = []
  const monitorProcess = {
    isRunning: () => true,
    async stopAndWait() { events.push('stop') },
    start() { events.push('start'); return { running: true } },
    async waitForHealthy() {
      events.push('healthy')
      throw Object.assign(new Error('watcher-restart-unhealthy'), { code: 'watcher-restart-unhealthy' })
    },
  }

  await assert.rejects(runRuntimeCleanup({ workspaceDir: root, dbPath, monitorProcess }), /watcher-restart-unhealthy/)

  assert.deepEqual(events, ['stop', 'start', 'healthy'])
  assert.equal(fs.existsSync(history), false)
})

test('cleanup labels failures after file deletion as partial instead of claiming data was preserved', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-partial-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  openAppDatabase({ dbPath }).close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  const originalRmSync = fs.rmSync
  fs.rmSync = (...args) => {
    const result = originalRmSync(...args)
    if (path.resolve(String(args[0])) === path.resolve(history)) throw new Error('simulated-after-delete-failure')
    return result
  }

  try {
    const error = await runRuntimeCleanup({ workspaceDir: root, dbPath }).then(() => null, (caught) => caught)
    assert.equal(error?.code, 'runtime-cleanup-partial')
    assert.equal(fs.existsSync(history), false)
  } finally {
    fs.rmSync = originalRmSync
  }
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

test('safe-start cleanup pauses betting accounts without starting a watcher that was previously off', async () => {
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

  assert.equal(result.restartedWatcher, false)
  assert.equal(result.accountsPaused, 1)
  assert.equal(result.monitorStartReason, 'not-running-before-cleanup')
  assert.equal(events.length, 0)
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

test('active browser profile lease blocks cleanup after managed processes stop and restores the watcher', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-profile-active-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-preview', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('browser-profile:test:account-a', 'browser-owner', 101, ?, ?, ?, 1)`)
    .run('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:10.000Z', '2999-07-15T00:00:20.000Z')
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  const events = []
  const monitorProcess = {
    isRunning: () => true,
    async stopAndWait() { events.push('stop') },
    start() { events.push('start') },
  }
  let bettingRunning = true
  const bettingProcess = {
    isRunning: () => bettingRunning,
    async stop() { events.push('bet-stop'); bettingRunning = false },
  }

  await assert.rejects(runRuntimeCleanup({
    workspaceDir: root,
    dbPath,
    monitorProcess,
    bettingProcess,
  }), /browser-profile-active/)

  assert.deepEqual(events, ['bet-stop', 'stop', 'start'])
  assert.equal(fs.existsSync(history), true)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-preview'").get().count, 1)
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM runtime_leases WHERE lease_key LIKE 'browser-profile:%'").get().count, 1)
  verify.close()
})

test('active Betting Worker role leases block unmanaged cleanup for the same database', async (t) => {
  for (const role of ['worker', 'executor']) {
    await t.test(role, async (subtest) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `crown-cache-${role}-lease-`))
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const dbPath = path.join(root, 'storage', 'crown.sqlite')
      const handle = openAppDatabase({ dbPath })
      handle.db.prepare(`INSERT INTO betting_history
        (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
        VALUES ('protected-role-lease', NULL, 'event', NULL, 'previewed', 50, '0.95',
          '2026-07-15T00:00:00.000Z', '{}')`).run()
      handle.db.prepare(`INSERT INTO runtime_leases
        (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
        VALUES (?, 'unmanaged-role', 101, ?, ?, ?, 1)`)
        .run(bettingRoleLeaseKeys({ dbPath })[role], '2026-07-15T00:00:00.000Z',
          '2026-07-15T00:00:10.000Z', '2999-07-15T00:00:20.000Z')
      handle.close()
      const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')

      await assert.rejects(runRuntimeCleanup({ workspaceDir: root, dbPath }), /betting-worker-active/)

      assert.equal(fs.existsSync(history), true)
      const verify = openAppDatabase({ dbPath })
      assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-role-lease'").get().count, 1)
      verify.close()
    })
  }
})

test('malformed lease expiry is treated as busy instead of expired', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-corrupt-lease-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-corrupt-lease', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('browser-profile:test:corrupt', 'corrupt-owner', 101, ?, ?, 'not-a-date', 1)`)
    .run('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:10.000Z')
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')

  await assert.rejects(runRuntimeCleanup({ workspaceDir: root, dbPath }), /browser-profile-active/)

  assert.equal(fs.existsSync(history), true)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-corrupt-lease'").get().count, 1)
  verify.close()
})

test('cleanup transaction blocks a profile lease acquired at the delete boundary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-lease-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-lease-race', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  const originalRmSync = fs.rmSync
  let acquireAttempted = false
  fs.rmSync = (...args) => {
    if (!acquireAttempted) {
      acquireAttempted = true
      const racer = new DatabaseSync(dbPath)
      try {
        racer.prepare(`INSERT INTO runtime_leases
          (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
          VALUES ('browser-profile:test:racer', 'racer', 202, ?, ?, ?, 1)`)
          .run('2026-07-15T00:00:00.000Z', '2026-07-15T00:00:10.000Z', '2999-07-15T00:00:20.000Z')
      } finally {
        racer.close()
      }
    }
    return originalRmSync(...args)
  }

  try {
    await assert.rejects(runRuntimeCleanup({ workspaceDir: root, dbPath }), /locked|busy/i)
  } finally {
    fs.rmSync = originalRmSync
  }

  assert.equal(acquireAttempted, true)
  assert.equal(fs.existsSync(history), true)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-lease-race'").get().count, 1)
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM runtime_leases WHERE lease_key='browser-profile:test:racer'").get().count, 0)
  verify.close()
})

test('cleanup stays busy when the Betting Worker starts while the monitor is stopping', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-worker-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-worker-race', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  const events = []
  let bettingRunning = false
  const monitorProcess = {
    isRunning: () => true,
    async stopAndWait() {
      events.push('monitor-stop')
      bettingRunning = true
    },
    start() { events.push('monitor-start') },
  }
  const bettingProcess = {
    isRunning: () => bettingRunning,
    async stop() { events.push('bet-stop'); bettingRunning = false },
  }

  await assert.rejects(runRuntimeCleanup({
    workspaceDir: root,
    dbPath,
    monitorProcess,
    bettingProcess,
  }), /betting-worker-active/)

  assert.deepEqual(events, ['monitor-stop', 'monitor-start'])
  assert.equal(fs.existsSync(history), true)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-worker-race'").get().count, 1)
  verify.close()
})

test('unsafe managed stop results block cleanup even after process status turns false', async (t) => {
  for (const unsafeStage of ['betting', 'monitor']) {
    await t.test(unsafeStage, async (subtest) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `crown-cache-${unsafeStage}-stop-`))
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const dbPath = path.join(root, 'storage', 'crown.sqlite')
      const handle = openAppDatabase({ dbPath })
      handle.db.prepare(`INSERT INTO betting_history
        (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
        VALUES ('protected-unsafe-stop', NULL, 'event', NULL, 'previewed', 50, '0.95',
          '2026-07-15T00:00:00.000Z', '{}')`).run()
      handle.close()
      const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
      const events = []
      let bettingRunning = true
      const bettingProcess = {
        isRunning: () => bettingRunning,
        async stop() {
          events.push('bet-stop')
          bettingRunning = false
          return unsafeStage === 'betting' ? { ok: false } : { ok: true }
        },
      }
      const monitorProcess = {
        isRunning: () => true,
        async stopAndWait() {
          events.push('monitor-stop')
          return unsafeStage === 'monitor' ? false : { ok: true }
        },
        start() { events.push('monitor-start') },
      }

      await assert.rejects(runRuntimeCleanup({
        workspaceDir: root,
        dbPath,
        bettingProcess,
        monitorProcess,
      }), unsafeStage === 'betting' ? /betting-worker-active/ : /watcher-active-unmanaged/)

      assert.deepEqual(events, ['bet-stop', 'monitor-stop', 'monitor-start'])
      assert.equal(fs.existsSync(history), true)
      const verify = openAppDatabase({ dbPath })
      assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-unsafe-stop'").get().count, 1)
      verify.close()
    })
  }
})

test('successful cleanup preserves expired runtime lease tombstones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-lease-tombstone-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('browser-profile:test:released', 'old-owner', 101, ?, ?, ?, 7)`)
    .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z')
  handle.close()

  await runRuntimeCleanup({ workspaceDir: root, dbPath })

  const verify = openAppDatabase({ dbPath })
  assert.deepEqual({ ...verify.db.prepare(`SELECT owner_id, fencing_token, expires_at
    FROM runtime_leases WHERE lease_key='browser-profile:test:released'`).get() }, {
    owner_id: 'old-owner',
    fencing_token: 7,
    expires_at: '2020-01-01T00:00:01.000Z',
  })
  verify.close()
})

test('failed-close browser context blocks cleanup after its profile lease expires', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-context-active-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-context-preview', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.db.prepare(`INSERT INTO runtime_leases
    (lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token)
    VALUES ('browser-profile:test:expired-but-open', 'old-owner', 101, ?, ?, ?, 3)`)
    .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z')
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')

  await assert.rejects(runRuntimeCleanup({
    workspaceDir: root,
    dbPath,
    humanLoginController: { hasUnsafeContext: () => true },
  }), /browser-profile-active/)

  assert.equal(fs.existsSync(history), true)
  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-context-preview'").get().count, 1)
  assert.equal(verify.db.prepare("SELECT expires_at FROM runtime_leases WHERE lease_key='browser-profile:test:expired-but-open'").get().expires_at, '2020-01-01T00:00:01.000Z')
  verify.close()
})

test('in-flight manual login account loading blocks cleanup before a browser context exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-login-opening-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.prepare(`INSERT INTO betting_history
    (id, betting_account_id, event_key, rule_id, status, amount, odds_raw, created_at, details_json)
    VALUES ('protected-login-opening', NULL, 'event', NULL, 'previewed', 50, '0.95',
      '2026-07-15T00:00:00.000Z', '{}')`).run()
  handle.close()
  const history = write(root, 'data/runtime/crown-odds-snapshots-v2.jsonl')
  let releaseLoad
  let markLoadStarted
  const loadGate = new Promise((resolve) => { releaseLoad = resolve })
  const loadStarted = new Promise((resolve) => { markLoadStarted = resolve })
  const status = (state) => ({
    challengeId: 'challenge-opening', accountId: 'mon_A', status: state,
    errorCode: state === 'failed' ? 'manual-login-cancelled' : '', expiresAt: 61_000,
  })
  const controller = new CrownHumanLoginController({
    bridge: {
      async openManualLogin() { return status('awaiting-user') },
      getManualLoginStatus() { return status('awaiting-user') },
      async confirmManualLogin() { return status('verified') },
      async cancelManualLogin() { return status('failed') },
    },
    async loadAccount() {
      markLoadStarted()
      await loadGate
      return { id: 'mon_A', username: 'owner', loginUrl: 'https://crown.example.com' }
    },
  })
  const opening = controller.openManualLogin({ accountId: 'mon_A' })
  await loadStarted

  try {
    await assert.rejects(runRuntimeCleanup({
      workspaceDir: root,
      dbPath,
      humanLoginController: controller,
    }), /browser-profile-active/)
    assert.equal(fs.existsSync(history), true)
    const verify = openAppDatabase({ dbPath })
    assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM betting_history WHERE id='protected-login-opening'").get().count, 1)
    verify.close()
  } finally {
    releaseLoad()
    await opening
    await controller.shutdown()
  }
})

test('portable cleanup preserves Chromium profile directories and SingletonLock while deleting cache subdirectories', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cache-singleton-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtimeDir = path.join(root, 'runtime')
  const profileDir = path.join(runtimeDir, 'browser-profiles')
  const dbPath = path.join(root, 'storage', 'crown.sqlite')
  openAppDatabase({ dbPath }).close()
  const legacyLock = write(root, 'runtime/crown-login-debug-profile/SingletonLock', 'lock')
  const legacyState = write(root, 'runtime/crown-login-debug-profile/Default/Local Storage/state.bin', 'state')
  const legacyCache = write(root, 'runtime/crown-login-debug-profile/Default/Cache/cache.bin')
  const accountLock = write(root, 'runtime/browser-profiles/account-hash/SingletonLock', 'lock')
  const accountCache = write(root, 'runtime/browser-profiles/account-hash/Default/Code Cache/cache.bin')

  await runRuntimeCleanup({ dataRoot: root, runtimeDir, profileDir, dbPath })

  assert.equal(fs.existsSync(legacyLock), true)
  assert.equal(fs.existsSync(legacyState), true)
  assert.equal(fs.existsSync(accountLock), true)
  assert.equal(fs.existsSync(legacyCache), false)
  assert.equal(fs.existsSync(accountCache), false)
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
