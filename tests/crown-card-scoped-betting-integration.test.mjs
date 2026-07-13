import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { lockReverseSelection } from '../src/crown/betting/locked-selection.mjs'
import { marketOnceKey } from '../src/crown/betting/market-once-store.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { authorizeExecution, assertExecutionGate } from '../src/crown/betting/execution-gate.mjs'
import {
  B2Executor,
  prepareAuthorizedSubmit,
  recoverAuthorizedAttempt,
  recoverAuthorizedAttempts,
} from '../src/crown/betting/b2-executor.mjs'
import { CrownAccountPreviewProvider } from '../src/crown/betting/crown-account-provider.mjs'
import { CrownAccountExecutionProvider } from '../src/crown/betting/crown-account-execution-provider.mjs'

const NOW = '2026-07-12T00:00:00.000Z'
const ENV = { CROWN_REAL_CURRENCY: 'CNY', CROWN_REAL_AMOUNT_SCALE: '0', CROWN_REAL_MAX_TOTAL_MINOR: '1000' }

function fixture(db, { signalId = 'signal-card', cardId = 'card-a', lineKey = 'RATIO_RE', accountId = 'account-a' } = {}) {
  const leagueName = cardId === 'card-a' ? '英超' : `${cardId}联赛`
  const eventKey = 'crown|football|gid=card-1'
  const marketIdentity = `${eventKey}|full_time|asian_handicap|${lineKey}`
  const signal = { signalId, observedAt: NOW, expiresAt: '2026-07-12T00:05:00.000Z',
    target: { eventIdentity: eventKey, marketIdentity, selectionIdentity: `${marketIdentity}|home`, side: 'home' },
    trigger: { direction: 'up' }, evidence: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap',
      handicap: -0.5, handicapRaw: '-0.5', leagueName, livePhase: null } }
  const card = { cardId, name: cardId, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05',
    targetAmountMinor: 100, currency: 'CNY', amountScale: 0, remark: '', realEligible: true,
    realEligibilityVersion: 2, realEligibilityUpdatedAt: NOW, migrationReviewRequired: false,
    migrationReviewReason: '', version: 3, leagueNames: [leagueName], createdAt: NOW, updatedAt: NOW }
  const selection = { provider: 'crown', mode: 'prematch', capturedAt: '2026-07-12T00:00:01.000Z',
    event: { eventKey, mode: 'prematch', livePhase: null },
    market: { marketIdentity, period: 'full_time', marketType: 'asian_handicap', lineKey, handicap: -0.5, handicapRaw: '-0.5' },
    selection: { selectionIdentity: `${marketIdentity}|away`, side: 'away', odds: '0.91', suspended: false } }
  db.prepare(`INSERT OR IGNORE INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES (?,?,1,?,?,?,'CNY',0,'',1,2,?,0,'',3,?,?)`)
    .run(cardId, cardId, card.targetOddsMin, card.targetOddsMax, card.targetAmountMinor, NOW, NOW, NOW)
  db.prepare(`INSERT OR IGNORE INTO auto_betting_rule_card_leagues (card_id,league_name,created_at)
    VALUES (?,?,?)`).run(cardId, leagueName, NOW)
  db.prepare(`INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
    VALUES (?,?,'card-test',1,'ready',?,'2026-07-12T00:05:00.000Z',?)`).run(signalId, signalId, NOW, JSON.stringify(signal))
  db.prepare(`INSERT INTO auto_betting_signal_inbox (
    signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,status,
    next_attempt_at,lease_owner,lease_expires_at,created_at,updated_at
  ) VALUES (?,?,3,?,'prematch',3,?,'processing','','inbox-owner','2026-07-12T00:01:00.000Z',?,?)`)
    .run(signalId, cardId, JSON.stringify(card), JSON.stringify(card), NOW, NOW)
  db.prepare(`INSERT OR REPLACE INTO monitor_selection_state (selection_identity,event_key,captured_at,snapshot_json) VALUES (?,?,?,?)`)
    .run(selection.selection.selectionIdentity, eventKey, selection.capturedAt, JSON.stringify(selection))
  db.prepare(`INSERT INTO betting_accounts (
    id,label,username,status,archived,allocation_status,secret_ciphertext,currency,amount_scale,
    per_bet_limit_minor,stake_step_minor,balance_minor,bet_order,created_at,updated_at
  ) VALUES (?,?,?,'enabled',0,'enabled','fixture','CNY',0,1000,10,1000,1,?,?)`).run(accountId, accountId, accountId, NOW, NOW)
  return { signal, card, selection, lockedSelection: lockReverseSelection(signal, () => selection),
    accountId, inboxLease: { ownerId: 'inbox-owner', expiresAt: '2026-07-12T00:01:00.000Z' } }
}

function allocation(accountId = 'account-a') {
  return [{ accountId, amountMinor: 100, previewMinStakeMinor: 10,
    previewMaxStakeMinor: 1000, previewBalanceMinor: 1000, previewStakeStepMinor: 10, previewOdds: '0.91' }]
}

function actualKey(data) {
  return marketOnceKey({ eventIdentity: data.lockedSelection.eventKey, mode: data.signal.evidence.mode, market: {
    period: data.lockedSelection.period, marketType: data.lockedSelection.marketType,
    lineKey: data.lockedSelection.lineKey, handicap: data.lockedSelection.handicap,
  } }, data.lockedSelection.side, { cardId: data.card.cardId })
}

function create(store, data, marketOnceKeyValue) {
  return store.claimAndCreateCardScopedBatch({
    signalId: data.signal.signalId, signalSnapshot: data.signal, inboxLease: data.inboxLease,
    lockedSelection: data.lockedSelection, cardId: data.card.cardId, cardVersion: data.card.version,
    cardSnapshot: data.card, bettingMode: data.signal.evidence.mode, eventKey: data.lockedSelection.eventKey,
    lockedSelectionIdentity: JSON.stringify(data.lockedSelection), sourceLeague: '英超', sourceOdds: '0.91',
    observedAt: NOW, currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW,
  }, allocation(data.accountId), { fencingToken: 1, marketOnceKey: marketOnceKeyValue })
}

test('card-scoped atomic claim persists immutable card snapshot and signal mode', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const data = fixture(handle.db)
  const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
  const key = actualKey(data)
  const created = create(store, data, key)
  assert.equal(created.status, 'batch_created')
  assert.deepEqual({ ...handle.db.prepare(`SELECT status,batch_id,lease_owner,lease_expires_at
    FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?`).get(data.signal.signalId, data.card.cardId) }, {
    status: 'batch_created', batch_id: created.batchId, lease_owner: '', lease_expires_at: '',
  })
  assert.deepEqual({ ...handle.db.prepare('SELECT card_id,card_version,betting_mode FROM bet_batches').get() }, {
    card_id: 'card-a', card_version: 3, betting_mode: 'prematch',
  })
  handle.db.prepare("UPDATE auto_betting_rule_cards SET name='edited',enabled=0,version=4 WHERE card_id='card-a'").run()
  assert.deepEqual(JSON.parse(handle.db.prepare('SELECT card_snapshot_json FROM bet_batches').get().card_snapshot_json), data.card)
  handle.close()
})

test('card deletion between preview and atomic claim creates no claim, batch, child, or lock', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const data = fixture(handle.db)
  handle.db.prepare("DELETE FROM auto_betting_rule_cards WHERE card_id='card-a'").run()
  const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
  assert.deepEqual(create(store, data, actualKey(data)), {
    status: 'skipped', reason: 'rule-deleted', inboxFinalized: true,
  })
  assert.deepEqual({ ...handle.db.prepare(`SELECT status,skip_reason,batch_id,lease_owner,lease_expires_at
    FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?`).get(data.signal.signalId, data.card.cardId) }, {
    status: 'skipped', skip_reason: 'rule-deleted', batch_id: null, lease_owner: '', lease_expires_at: '',
  })
  for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0)
  }
  handle.close()
})

for (const [label, mutation, reason, real] of [
  ['version edit', "UPDATE auto_betting_rule_cards SET name='edited',version=4,updated_at='2026-07-12T00:00:01.000Z' WHERE card_id='card-a'", 'card-version-changed', false],
  ['disable', "UPDATE auto_betting_rule_cards SET enabled=0 WHERE card_id='card-a'", 'betting-mode-disabled', false],
  ['review reopen', "UPDATE auto_betting_rule_cards SET enabled=0,migration_review_required=1,migration_review_reason='review-again' WHERE card_id='card-a'", 'migration-review-required', false],
  ['eligibility revoke', "UPDATE auto_betting_rule_cards SET real_eligible=0,real_eligibility_version=3,real_eligibility_updated_at='2026-07-12T00:00:01.000Z' WHERE card_id='card-a'", 'real-eligibility-required', true],
  ['authorization eligibility mismatch', "UPDATE auto_betting_rule_cards SET real_eligible=1 WHERE card_id='card-a'", 'real-eligibility-required', true],
]) {
  test(`atomic card claim fail-closes current ${label} and terminalizes the inbox`, () => {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    const data = fixture(handle.db)
    handle.db.exec(mutation)
    const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
    const options = real ? {
      fencingToken: 1, marketOnceKey: actualKey(data), requireRealRuntime: true,
      realLeaseEvidence: { worker: true, executor: true }, authorizationId: 'auth-never-used',
      executorOwnerId: 'owner', authorizationOptions: { env: ENV, now: () => new Date(NOW) },
    } : { fencingToken: 1, marketOnceKey: actualKey(data) }
    const input = {
      signalId: data.signal.signalId, signalSnapshot: data.signal, inboxLease: data.inboxLease,
      lockedSelection: data.lockedSelection, cardId: data.card.cardId, cardVersion: data.card.version,
      cardSnapshot: data.card, bettingMode: data.signal.evidence.mode, eventKey: data.lockedSelection.eventKey,
      lockedSelectionIdentity: JSON.stringify(data.lockedSelection), sourceLeague: '英超', sourceOdds: '0.91',
      observedAt: NOW, currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW,
    }
    const result = store.claimAndCreateCardScopedBatch(input, allocation(data.accountId), options)
    assert.deepEqual(result, { status: 'skipped', reason, inboxFinalized: true })
    assert.deepEqual({ ...handle.db.prepare(`SELECT status,skip_reason,batch_id,lease_owner,lease_expires_at
      FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?`).get(data.signal.signalId, data.card.cardId) }, {
      status: 'skipped', skip_reason: reason, batch_id: null, lease_owner: '', lease_expires_at: '',
    })
    for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
      assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0)
    }
    handle.close()
  })
}

for (const [cardLabel, mutation, reason, real] of [
  ['version edit', "UPDATE auto_betting_rule_cards SET name='edited',version=4,updated_at='2026-07-12T00:00:01.000Z' WHERE card_id='card-a'", 'card-version-changed', false],
  ['disable', "UPDATE auto_betting_rule_cards SET enabled=0 WHERE card_id='card-a'", 'betting-mode-disabled', false],
  ['review reopen', "UPDATE auto_betting_rule_cards SET enabled=0,migration_review_required=1,migration_review_reason='review-again' WHERE card_id='card-a'", 'migration-review-required', false],
  ['eligibility revoke', "UPDATE auto_betting_rule_cards SET real_eligible=0,real_eligibility_version=3,real_eligibility_updated_at='2026-07-12T00:00:01.000Z' WHERE card_id='card-a'", 'real-eligibility-required', true],
]) {
  for (const marketState of ['missing', 'drift']) {
    test(`current ${cardLabel} wins over latest selection ${marketState} and commits the card terminal reason`, () => {
      const handle = openAppDatabase({ dbPath: ':memory:' })
      const data = fixture(handle.db)
      handle.db.exec(mutation)
      if (marketState === 'missing') handle.db.prepare('DELETE FROM monitor_selection_state').run()
      else {
        const row = handle.db.prepare('SELECT selection_identity,snapshot_json FROM monitor_selection_state').get()
        const snapshot = JSON.parse(row.snapshot_json)
        snapshot.selection.odds = '9.99'
        handle.db.prepare('UPDATE monitor_selection_state SET snapshot_json=? WHERE selection_identity=?')
          .run(JSON.stringify(snapshot), row.selection_identity)
      }
      const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
      const input = {
        signalId: data.signal.signalId, signalSnapshot: data.signal, inboxLease: data.inboxLease,
        lockedSelection: data.lockedSelection, cardId: data.card.cardId, cardVersion: data.card.version,
        cardSnapshot: data.card, bettingMode: data.signal.evidence.mode, eventKey: data.lockedSelection.eventKey,
        lockedSelectionIdentity: JSON.stringify(data.lockedSelection), sourceLeague: '英超', sourceOdds: '0.91',
        observedAt: NOW, currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW,
      }
      const options = { fencingToken: 1, marketOnceKey: actualKey(data), ...(real ? {
        requireRealRuntime: true, realLeaseEvidence: { worker: true, executor: true },
        authorizationId: 'auth-never-used', executorOwnerId: 'owner',
        authorizationOptions: { env: ENV, now: () => new Date(NOW) },
      } : {}) }
      assert.deepEqual(store.claimAndCreateCardScopedBatch(input, allocation(data.accountId), options), {
        status: 'skipped', reason, inboxFinalized: true,
      })
      assert.deepEqual({ ...handle.db.prepare(`SELECT status,skip_reason,attempts,batch_id
        FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?`).get(data.signal.signalId, data.card.cardId) }, {
        status: 'skipped', skip_reason: reason, attempts: 0, batch_id: null,
      })
      assert.equal(handle.db.prepare("SELECT COUNT(*) count FROM auto_betting_signal_inbox WHERE status IN ('retry','dead_letter')").get().count, 0)
      for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
        assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0)
      }
      handle.close()
    })
  }
}

test('valid current card keeps latest market drift as rollback-only market semantics', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const data = fixture(handle.db)
  const row = handle.db.prepare('SELECT selection_identity,snapshot_json FROM monitor_selection_state').get()
  const snapshot = JSON.parse(row.snapshot_json)
  snapshot.selection.odds = '9.99'
  handle.db.prepare('UPDATE monitor_selection_state SET snapshot_json=? WHERE selection_identity=?')
    .run(JSON.stringify(snapshot), row.selection_identity)
  const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
  assert.throws(() => create(store, data, actualKey(data)), /latest-odds-out-of-range/)
  assert.deepEqual({ ...handle.db.prepare(`SELECT status,skip_reason,attempts,batch_id
    FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?`).get(data.signal.signalId, data.card.cardId) }, {
    status: 'processing', skip_reason: '', attempts: 0, batch_id: null,
  })
  for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0)
  }
  handle.close()
})

test('authorization stores exact card scopes and keeps allowed signal modes without rereading deleted card', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  fixture(handle.db)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:card-test', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'auth-card', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch', 'live'], cardScopes: [{ cardId: 'card-a', eligibilityVersion: 2 }],
    maxTotalAmountMinor: 200, confirmation: 'AUTHORIZE CARD',
  }, { env: ENV, now: () => new Date(NOW) })
  assert.deepEqual(authorization.cardScopes, [{ cardId: 'card-a', eligibilityVersion: 2 }])
  assert.deepEqual(authorization.bettingModes, ['live', 'prematch'])
  assert.deepEqual(JSON.parse(handle.db.prepare('SELECT card_scopes_json FROM execution_authorizations').get().card_scopes_json),
    [{ cardId: 'card-a', eligibilityVersion: 2 }])
  handle.db.prepare("DELETE FROM auto_betting_rule_cards WHERE card_id='card-a'").run()
  assert.doesNotThrow(() => assertExecutionGate(handle.db, {
    authorizationId: 'auth-card', cardId: 'card-a', eligibilityVersion: 2, bettingMode: 'prematch',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: ENV, now: () => new Date(NOW) }))
  assert.throws(() => assertExecutionGate(handle.db, {
    authorizationId: 'auth-card', cardId: 'card-a', eligibilityVersion: 3, bettingMode: 'prematch',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: ENV, now: () => new Date(NOW) }), /authorization-card-scope/)
  handle.close()
})

test('real card batch atomically binds child budget to exact authorization card scope', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const data = fixture(handle.db)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:card-bind', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  authorizeExecution(handle.db, { authorizationId: 'auth-card-bind', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], cardScopes: [{ cardId: 'card-a', eligibilityVersion: 2 }],
    maxTotalAmountMinor: 200, confirmation: 'AUTHORIZE CARD BIND' }, { env: ENV, now: () => new Date(NOW) })
  const store = new BetBatchStore(handle.db, { fencingToken: lease.fencingToken, leaseKey: lease.leaseKey,
    now: () => new Date(NOW) })
  const result = store.claimAndCreateCardScopedBatch({
    signalId: data.signal.signalId, signalSnapshot: data.signal, inboxLease: data.inboxLease,
    lockedSelection: data.lockedSelection, cardId: data.card.cardId, cardVersion: data.card.version,
    cardSnapshot: data.card, bettingMode: 'prematch', authorizationId: 'auth-card-bind',
    eventKey: data.lockedSelection.eventKey, lockedSelectionIdentity: JSON.stringify(data.lockedSelection),
    sourceLeague: '英超', sourceOdds: '0.91', observedAt: NOW, currency: 'CNY', amountScale: 0,
    targetAmountMinor: 100, createdAt: NOW,
  }, allocation(data.accountId), { fencingToken: lease.fencingToken, marketOnceKey: actualKey(data),
    authorizationId: 'auth-card-bind', executorOwnerId: lease.ownerId,
    authorizationOptions: { env: ENV, now: () => new Date(NOW) } })
  assert.equal(result.status, 'batch_created')
  assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM execution_authorization_child_budgets').get().count, 1)
  assert.equal(handle.db.prepare("SELECT reserved_amount_minor FROM execution_authorizations WHERE authorization_id='auth-card-bind'").get().reserved_amount_minor, 100)
  handle.close()
})

test('atomic card store rejects a caller-supplied wrong market key before claim or batch', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const data = fixture(handle.db)
  const store = new BetBatchStore(handle.db, { now: () => new Date(NOW) })
  assert.throws(() => create(store, data, 'market_once_wrong'), /card-market-once-key-mismatch/)
  for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0)
  }
  handle.close()
})

test('temp SQLite fake provider keeps market ownership per card and exact line while an exact duplicate claims once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-market-'))
  const handle = openAppDatabase({ dbPath: path.join(tempDir, 'crown.sqlite') })
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:card-market', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  const store = new BetBatchStore(handle.db, { fencingToken: lease.fencingToken, leaseKey: lease.leaseKey,
    now: () => new Date(NOW) })
  const cases = [
    fixture(handle.db, { signalId: 'signal-a', cardId: 'card-a', lineKey: 'RATIO_RE', accountId: 'account-a' }),
    fixture(handle.db, { signalId: 'signal-b', cardId: 'card-b', lineKey: 'RATIO_RE', accountId: 'account-b' }),
    fixture(handle.db, { signalId: 'signal-c', cardId: 'card-a', lineKey: 'RATIO_RE_A', accountId: 'account-c' }),
    fixture(handle.db, { signalId: 'signal-d', cardId: 'card-a', lineKey: 'RATIO_RE', accountId: 'account-d' }),
  ]
  let previewCalls = 0
  let submitCalls = 0
  const provider = {
    async preview() { previewCalls += 1; return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000,
      balanceMinor: 1000, stakeStepMinor: 10, odds: '0.91', currency: 'CNY', amountScale: 0 } },
    async submit() { submitCalls += 1; return { kind: 'accepted' } },
  }
  const run = (data) => {
    const coordinator = new MultiAccountBetCoordinator({ db: handle.db, store, provider, lease,
      findLatestSelection: () => data.selection, now: () => NOW })
    return coordinator.claimAndCreateCardScopedBatch({ signalId: data.signal.signalId, signal: data.signal,
      inboxLease: data.inboxLease, lockedSelection: data.lockedSelection, cardId: data.card.cardId,
      cardVersion: data.card.version, cardSnapshot: data.card, bettingMode: data.signal.evidence.mode,
      executionMode: 'simulated', marketOnceKey: actualKey(data) })
  }
  const first = await run(cases[0])
  assert.equal(first.status, 'batch_created')
  assert.equal((await run(cases[1])).status, 'batch_created')
  assert.equal((await run(cases[2])).status, 'batch_created')
  handle.db.prepare("UPDATE auto_betting_rule_cards SET enabled=0,version=4 WHERE card_id='card-a'").run()
  assert.deepEqual(await run(cases[3]), { status: 'already-claimed', batchId: first.batchId })
  assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_market_once_claims').get().count, 3)
  assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM bet_batches').get().count, 3)
  assert.deepEqual({ previewCalls, submitCalls }, { previewCalls: 9, submitCalls: 0 })
  handle.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function authorizedCardContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-b2-'))
  const handle = openAppDatabase({ dbPath: path.join(tempDir, 'crown.sqlite') })
  const data = fixture(handle.db)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:card-b2', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  authorizeExecution(handle.db, { authorizationId: 'auth-card-b2', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], cardScopes: [{ cardId: 'card-a', eligibilityVersion: 2 }],
    maxTotalAmountMinor: 200, confirmation: 'AUTHORIZE CARD B2' }, { env: ENV, now: () => new Date(NOW) })
  const store = new BetBatchStore(handle.db, { fencingToken: lease.fencingToken, leaseKey: lease.leaseKey,
    now: () => new Date(NOW) })
  const created = store.claimAndCreateCardScopedBatch({
    signalId: data.signal.signalId, signalSnapshot: data.signal, inboxLease: data.inboxLease,
    lockedSelection: data.lockedSelection, cardId: 'card-a', cardVersion: 3, cardSnapshot: data.card,
    bettingMode: 'prematch', authorizationId: 'auth-card-b2', eventKey: data.lockedSelection.eventKey,
    lockedSelectionIdentity: JSON.stringify(data.lockedSelection), sourceLeague: '英超', sourceOdds: '0.91',
    observedAt: NOW, currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW,
  }, allocation(data.accountId), { fencingToken: lease.fencingToken, marketOnceKey: actualKey(data),
    authorizationId: 'auth-card-b2', executorOwnerId: lease.ownerId,
    authorizationOptions: { env: ENV, now: () => new Date(NOW) } })
  const child = created.children[0]
  const identity = { provider: 'fixture', gid: 'card-1', mode: 'prematch', period: 'full_time',
    market: 'asian_handicap', line: 'RATIO_RE', side: 'away' }
  const gate = { authorizationId: 'auth-card-b2', cardId: 'card-a', eligibilityVersion: 2,
    bettingMode: 'prematch', leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken, batchId: created.batchId, childOrderId: child.childOrderId,
    accountId: child.accountId }
  const prepare = { ...gate, submitAttemptId: 'submit-card-b2-1', attemptOrdinal: 1,
    capabilityVersion: 'b2-ledger-fixture-v1', capabilityEvidenceId: 'fixture:b2-ledger:offline:v1',
    lockedIdentity: identity, currentIdentity: identity,
    preview: { minStakeMinor: 10, maxStakeMinor: 1000, balanceMinor: 1000,
      stakeStepMinor: 10, odds: '0.91', line: 'RATIO_RE' } }
  return { handle, data, lease, created, child, gate, prepare,
    cleanup() { handle.close(); fs.rmSync(tempDir, { recursive: true, force: true }) } }
}

test('B2 rejects card authorization scope mismatch before provider preview or submit', async () => {
  const context = authorizedCardContext()
  let previewCalls = 0
  let submitCalls = 0
  const previewProvider = Object.create(CrownAccountPreviewProvider.prototype)
  previewProvider.preview = async () => { previewCalls += 1; throw new Error('preview-called') }
  const executionProvider = Object.create(CrownAccountExecutionProvider.prototype)
  executionProvider.submit = async () => { submitCalls += 1; throw new Error('submit-called') }
  const executor = new B2Executor({ database: context.handle.db, previewProvider, executionProvider,
    lease: context.lease, env: ENV, now: () => new Date(NOW), secretKey: 'card-b2-key' })
  context.handle.db.prepare(`UPDATE execution_authorizations SET card_scopes_json=? WHERE authorization_id=?`)
    .run(JSON.stringify([{ cardId: 'card-other', eligibilityVersion: 2 }]), 'auth-card-b2')
  await assert.rejects(() => executor.submit({ ...context.prepare, lockedSelection: context.data.lockedSelection,
    amountMinor: 100, childIdentity: { batchId: context.created.batchId,
      childOrderId: context.child.childOrderId, accountId: context.child.accountId, childAttempt: 1 },
    hasFutureCapacity: false }), /authorization-card-scope/)
  assert.deepEqual({ previewCalls, submitCalls }, { previewCalls: 0, submitCalls: 0 })
  assert.equal(context.handle.db.prepare('SELECT COUNT(*) count FROM bet_submit_attempts').get().count, 0)
  context.cleanup()
})

test('single and authorization-wide recovery validate immutable card scope and never resubmit', () => {
  for (const wide of [false, true]) {
    const context = authorizedCardContext()
    prepareAuthorizedSubmit(context.handle.db, context.prepare, { env: ENV, now: () => new Date(NOW) })
    context.handle.db.prepare('UPDATE execution_authorizations SET card_scopes_json=? WHERE authorization_id=?')
      .run(JSON.stringify([{ cardId: 'card-other', eligibilityVersion: 2 }]), 'auth-card-b2')
    let providerCalls = 0
    const recovery = wide
      ? () => recoverAuthorizedAttempts(context.handle.db, {
          authorizationId: 'auth-card-b2', leaseKey: context.lease.leaseKey,
          executorOwnerId: context.lease.ownerId, fencingToken: context.lease.fencingToken,
        }, { env: ENV, now: () => new Date(NOW) })
      : () => recoverAuthorizedAttempt(context.handle.db, {
          ...context.gate, submitAttemptId: context.prepare.submitAttemptId,
        }, { env: ENV, now: () => new Date(NOW) })
    assert.throws(() => { recovery(); providerCalls += 1 }, /authorization-card-scope/)
    assert.equal(providerCalls, 0)
    assert.equal(context.handle.db.prepare('SELECT status FROM bet_submit_attempts').get().status, 'submit_prepared')
    assert.equal(context.handle.db.prepare('SELECT status FROM bet_child_orders').get().status, 'submit_prepared')
    context.cleanup()
  }
})
