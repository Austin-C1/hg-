import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { lockReverseSelection } from '../src/crown/betting/locked-selection.mjs'
import { buildCardMarketOnceKey } from '../src/crown/betting/market-once-store.mjs'

const NOW = '2026-07-12T00:00:00.000Z'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-delete-'))
  const dbPath = path.join(root, 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  const repo = createAppRepository(handle.db, { now: () => new Date(NOW), dbPath })
  handle.db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('card-a','Card A',1,'0.8','1.05',100,'CNY',0,'',0,1,?,0,'',1,?,?)`).run(NOW, NOW, NOW)
  handle.db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('card-a','英超',?)").run(NOW)
  const cardSnapshot = { cardId: 'card-a', name: 'Card A', enabled: true,
    targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100,
    currency: 'CNY', amountScale: 0, remark: '', realEligible: false,
    realEligibilityVersion: 1, realEligibilityUpdatedAt: NOW, migrationReviewRequired: false,
    migrationReviewReason: '', version: 1, createdAt: NOW, updatedAt: NOW, leagueNames: ['英超'] }
  const snapshot = JSON.stringify(cardSnapshot)
  for (const [signalId, status, batchId] of [
    ['signal-pending', 'pending', null], ['signal-processing', 'processing', null], ['signal-bound', 'batch_created', 'batch-bound'],
  ]) {
    handle.db.prepare(`INSERT INTO monitor_signals
      (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
      VALUES (?,?,'test',1,'ready',?,'2026-07-12T01:00:00.000Z','{}')`).run(signalId, signalId, NOW)
    handle.db.prepare(`INSERT INTO auto_betting_signal_inbox (
      signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,
      status,skip_reason,lease_owner,lease_expires_at,batch_id,created_at,updated_at
    ) VALUES (?,?,1,?,'prematch',1,?,?,?,?,?,?,?,?)`).run(
      signalId, 'card-a', snapshot, snapshot, status, '',
      status === 'processing' ? 'worker' : '', status === 'processing' ? '2026-07-12T00:10:00.000Z' : '', batchId, NOW, NOW,
    )
  }
  handle.db.prepare(`INSERT INTO bet_batches (
    batch_id,signal_id,card_id,card_version,card_snapshot_json,rule_id,betting_mode,
    target_amount_minor,unfilled_amount_minor,status,created_at
  ) VALUES ('batch-bound','signal-bound','card-a',1,?,NULL,'prematch',100,100,'queued',?)`).run(snapshot, NOW)
  const eventKey = 'crown|football|gid=race'
  const marketIdentity = `${eventKey}|full_time|asian_handicap|RATIO_RE`
  const signal = { signalId: 'signal-processing', observedAt: NOW,
    target: { eventIdentity: eventKey, marketIdentity, selectionIdentity: `${marketIdentity}|home`, side: 'home' },
    evidence: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', handicap: -0.5, livePhase: null } }
  handle.db.prepare("UPDATE monitor_signals SET payload_json=? WHERE signal_id='signal-processing'").run(JSON.stringify(signal))
  const selection = { provider: 'crown', mode: 'prematch', capturedAt: '2026-07-12T00:00:01.000Z',
    event: { eventKey, mode: 'prematch', livePhase: null },
    market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', handicap: -0.5 },
    selection: { selectionIdentity: `${marketIdentity}|away`, side: 'away', odds: '0.91', suspended: false } }
  handle.db.prepare('INSERT INTO monitor_selection_state(selection_identity,event_key,captured_at,snapshot_json) VALUES (?,?,?,?)')
    .run(selection.selection.selectionIdentity, eventKey, selection.capturedAt, JSON.stringify(selection))
  handle.db.prepare(`INSERT INTO betting_accounts (
    id,label,username,status,archived,allocation_status,secret_ciphertext,currency,amount_scale,
    per_bet_limit_minor,stake_step_minor,balance_minor,bet_order,created_at,updated_at
  ) VALUES ('race-account','race','race','enabled',0,'enabled','fixture','CNY',0,1000,10,1000,1,?,?)`).run(NOW, NOW)
  const lockedSelection = lockReverseSelection(signal, () => selection)
  return { ...handle, repo, race: { signal, cardSnapshot, lockedSelection,
    marketOnceKey: buildCardMarketOnceKey({ cardId: 'card-a', signal, lockedSelection }) } }
}

test('delete atomically terminates only unbound active inbox, preserves bound history, and releases league', () => {
  const { db, repo, close } = fixture()
  assert.deepEqual(repo.deleteAutoBettingRuleCard('card-a', { expectedVersion: 1 }), { ok: true })
  assert.deepEqual({ ...db.prepare("SELECT status,skip_reason,lease_owner FROM auto_betting_signal_inbox WHERE signal_id='signal-pending'").get() },
    { status: 'skipped', skip_reason: 'rule-deleted', lease_owner: '' })
  assert.deepEqual({ ...db.prepare("SELECT status,skip_reason,lease_owner FROM auto_betting_signal_inbox WHERE signal_id='signal-processing'").get() },
    { status: 'skipped', skip_reason: 'rule-deleted', lease_owner: '' })
  assert.deepEqual({ ...db.prepare("SELECT status,batch_id FROM auto_betting_signal_inbox WHERE signal_id='signal-bound'").get() },
    { status: 'batch_created', batch_id: 'batch-bound' })
  assert.equal(db.prepare("SELECT status FROM bet_batches WHERE batch_id='batch-bound'").get().status, 'queued')
  assert.equal(db.prepare("SELECT COUNT(*) count FROM auto_betting_rule_card_leagues WHERE league_name='英超'").get().count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) count FROM auto_betting_rule_cards WHERE card_id='card-a'").get().count, 0)
  close()
})

test('delete rejects missing card and stale expectedVersion without changing active inbox', () => {
  const { db, repo, close } = fixture()
  assert.throws(() => repo.deleteAutoBettingRuleCard('card-a', { expectedVersion: 2 }), { code: 'auto-betting-card-version-conflict' })
  assert.equal(db.prepare("SELECT status FROM auto_betting_signal_inbox WHERE signal_id='signal-pending'").get().status, 'pending')
  assert.throws(() => repo.deleteAutoBettingRuleCard('missing', { expectedVersion: 1 }), { code: 'auto-betting-card-not-found' })
  close()
})

test('a physically deleted migrated card is not recreated when the database reopens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-delete-reopen-'))
  const dbPath = path.join(root, 'app.sqlite')
  const first = openAppDatabase({ dbPath })
  const row = first.db.prepare("SELECT version FROM auto_betting_rule_cards WHERE card_id='migrated-fixed-prematch'").get()
  const repo = createAppRepository(first.db, { now: () => new Date(NOW), dbPath })
  repo.deleteAutoBettingRuleCard('migrated-fixed-prematch', { expectedVersion: row.version })
  first.close()
  const reopened = openAppDatabase({ dbPath })
  assert.equal(reopened.db.prepare("SELECT COUNT(*) count FROM auto_betting_rule_cards WHERE card_id='migrated-fixed-prematch'").get().count, 0)
  reopened.close()
})

function workerResult(worker) {
  return new Promise((resolve, reject) => {
    let message
    worker.once('message', (value) => { message = value })
    worker.once('error', reject)
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker-exit-${code}`)); else resolve(message) })
  })
}

test('concurrent atomic card batch creation and delete serialize to complete outcomes only', async () => {
  const { dbPath, race, close } = fixture()
  close()
  const sync = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const common = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(workerData.dbPath); db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    const ready = new Int32Array(workerData.sync);
    Atomics.add(ready, 0, 1); Atomics.notify(ready, 0); Atomics.wait(ready, 1, 0);
  `
  const repoUrl = new URL('../src/crown/app/app-repository.mjs', import.meta.url).href
  const storeUrl = new URL('../src/crown/betting/bet-batch-store.mjs', import.meta.url).href
  const createCode = `${common}
    const { BetBatchStore } = await import(${JSON.stringify(storeUrl)});
    try { const store=new BetBatchStore(db,{now:()=>new Date(${JSON.stringify(NOW)})});
      const r=store.claimAndCreateCardScopedBatch(workerData.input,[{accountId:'race-account',amountMinor:100,
        previewMinStakeMinor:10,previewMaxStakeMinor:1000,previewBalanceMinor:1000,previewStakeStepMinor:10,previewOdds:'0.91'}],
        {fencingToken:1,marketOnceKey:workerData.marketOnceKey}); parentPort.postMessage({ok:true,status:r.status});
    } catch(e) { parentPort.postMessage({ok:false,error:e.message}); } finally { db.close(); }`
  const deleteCode = `${common}
    const { createAppRepository } = await import(${JSON.stringify(repoUrl)});
    try { const repo=createAppRepository(db,{now:()=>new Date(${JSON.stringify(NOW)}),dbPath:workerData.dbPath});
      parentPort.postMessage({ok:true,result:repo.deleteAutoBettingRuleCard('card-a',{expectedVersion:1})});
    } catch(e) { parentPort.postMessage({ok:false,error:e.message}); } finally { db.close(); }`
  const input = { signalId: race.signal.signalId, signalSnapshot: race.signal,
    inboxLease: { ownerId: 'worker', expiresAt: '2026-07-12T00:10:00.000Z' },
    lockedSelection: race.lockedSelection, cardId: 'card-a', cardVersion: 1, cardSnapshot: race.cardSnapshot,
    bettingMode: 'prematch', eventKey: race.lockedSelection.eventKey,
    lockedSelectionIdentity: JSON.stringify(race.lockedSelection), sourceLeague: '英超', sourceOdds: '0.91',
    observedAt: NOW, currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW }
  const createWorker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(createCode)}`),
    { workerData: { sync, dbPath, input, marketOnceKey: race.marketOnceKey } })
  const deleteWorker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(deleteCode)}`),
    { workerData: { sync, dbPath } })
  const ready = new Int32Array(sync)
  while (Atomics.load(ready, 0) < 2) await new Promise((resolve) => setImmediate(resolve))
  Atomics.store(ready, 1, 1); Atomics.notify(ready, 1, 2)
  const [created, deleted] = await Promise.all([workerResult(createWorker), workerResult(deleteWorker)])
  assert.equal(deleted.ok, true)

  const verify = openAppDatabase({ dbPath })
  assert.equal(verify.db.prepare("SELECT COUNT(*) count FROM auto_betting_rule_cards WHERE card_id='card-a'").get().count, 0)
  const counts = Object.fromEntries(['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']
    .map((table) => [table, verify.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]))
  const inbox = { ...verify.db.prepare("SELECT status,skip_reason,batch_id FROM auto_betting_signal_inbox WHERE signal_id='signal-processing'").get() }
  if (created.ok && created.status === 'batch_created') {
    assert.deepEqual(counts, { bet_market_once_claims: 1, bet_batches: 2, bet_child_orders: 1, betting_account_locks: 1 })
    assert.equal(inbox.status, 'batch_created')
    assert.ok(inbox.batch_id)
  } else {
    assert.deepEqual(created, { ok: true, status: 'skipped' })
    assert.deepEqual(counts, { bet_market_once_claims: 0, bet_batches: 1, bet_child_orders: 0, betting_account_locks: 0 })
    assert.deepEqual(inbox, { status: 'skipped', skip_reason: 'rule-deleted', batch_id: null })
  }
  assert.equal(verify.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  verify.close()
})
