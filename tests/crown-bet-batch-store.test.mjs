import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { deterministicBatchId } from '../src/crown/betting/betting-rule-matcher.mjs'
import { authorizeExecution } from '../src/crown/betting/execution-gate.mjs'

const NOW = '2026-07-10T12:00:00.000Z'

function temporaryDbPath() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'crown-batch-store-')), 'app.sqlite')
}

function seed(db, { signals = ['signal-a', 'signal-b', 'signal-c'], accounts = ['account-a', 'account-b', 'account-c'] } = {}) {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, monitor_enabled, real_betting_enabled, migration_review_required, archived,
      currency, amount_scale, target_amount_minor, created_at, updated_at
    ) VALUES ('rule-a', 'Rule A', 1, 1, 0, 0, 'CNY', 0, 1000, ?, ?)
  `).run(NOW, NOW)
  for (const signalId of signals) {
    db.prepare(`
      INSERT INTO monitor_signals (
        signal_id, signal_key, strategy_id, strategy_version, status,
        observed_at, expires_at, payload_json
      ) VALUES (?, ?, 'strategy-a', 1, 'ready', ?, '2026-07-10T12:05:00.000Z', '{}')
    `).run(signalId, `key-${signalId}`, NOW)
  }
  accounts.forEach((accountId, index) => {
    db.prepare(`
      INSERT INTO betting_accounts (
        id, label, username, status, archived, allocation_status, currency, amount_scale,
        per_bet_limit_minor, stake_step_minor, balance_minor, bet_order,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'enabled', 0, 'enabled', 'CNY', 0, 1000, 10, 1000, ?, ?, ?)
    `).run(accountId, accountId, accountId, index + 1, NOW, NOW)
  })
}

function batchInput(signalId, targetAmountMinor = 100) {
  return {
    signalId,
    ruleId: 'rule-a',
    eventKey: `event-${signalId}`,
    lockedSelectionIdentity: `selection-${signalId}`,
    ruleVersion: 1,
    ruleSnapshot: { id: 'rule-a', version: 1 },
    sourceLeague: 'League A',
    sourceOdds: '0.95',
    observedAt: NOW,
    currency: 'CNY',
    amountScale: 0,
    targetAmountMinor,
    createdAt: NOW,
  }
}

function allocation(accountId, amountMinor) {
  return {
    accountId,
    amountMinor,
    previewMinStakeMinor: 10,
    previewMaxStakeMinor: 1000,
    previewBalanceMinor: 1000,
    previewStakeStepMinor: 10,
    previewOdds: '0.96',
  }
}

function batchRow(db, batchId) {
  return db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
}

function childRow(db, childOrderId) {
  return db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(childOrderId)
}

function clock(initial = '2026-07-11T02:00:00.000Z') {
  let value = Date.parse(initial)
  return { now: () => new Date(value), advance(milliseconds) { value += milliseconds } }
}

test('authorized batch allocation atomically creates child budget bindings while children remain reserved', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db, { signals: ['signal-a', 'signal-b'], accounts: ['account-a', 'account-b', 'account-c'] })
  handle.db.prepare(`
    UPDATE betting_rules
    SET enabled = 1, execution_mode = 'real_eligible'
    WHERE id = 'rule-a'
  `).run()
  const current = clock(NOW)
  const env = {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '0',
    CROWN_REAL_MAX_TOTAL_MINOR: '1000',
  }
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:authorized-allocation',
    ownerId: 'authorized-allocation-owner',
    pid: 1,
    ttlMs: 60_000,
    now: current.now,
  })
  lease.acquire()
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'authorization-allocation',
    currency: 'CNY',
    amountScale: 0,
    ruleIds: ['rule-a'],
    maxTotalAmountMinor: 200,
    confirmation: 'OFFLINE AUTHORIZED ALLOCATION TEST',
  }, { env, now: current.now })
  const store = new BetBatchStore(handle.db, {
    fencingToken: lease.fencingToken,
    leaseKey: lease.leaseKey,
    now: () => NOW,
  })

  const created = store.createAuthorizedBatchWithReservations({
    ...batchInput('signal-a', 100),
    authorizationId: authorization.authorizationId,
  }, [allocation('account-a', 60), allocation('account-b', 40)], {
    fencingToken: lease.fencingToken,
    authorizationId: authorization.authorizationId,
    executorOwnerId: lease.ownerId,
    authorizationOptions: { env, now: current.now },
  })

  assert.equal(handle.db.prepare('SELECT authorization_id FROM bet_batches').get().authorization_id, authorization.authorizationId)
  assert.deepEqual(handle.db.prepare(`
    SELECT child.status AS child_status, budget.status AS binding_status,
           budget.authorization_id, budget.amount_minor
    FROM bet_child_orders AS child
    JOIN execution_authorization_child_budgets AS budget
      ON budget.child_order_id = child.child_order_id
    ORDER BY child.account_id
  `).all().map((row) => ({ ...row })), [
    { child_status: 'reserved', binding_status: 'reserved', authorization_id: authorization.authorizationId, amount_minor: 60 },
    { child_status: 'reserved', binding_status: 'reserved', authorization_id: authorization.authorizationId, amount_minor: 40 },
  ])
  assert.equal(handle.db.prepare('SELECT reserved_amount_minor FROM execution_authorizations').get().reserved_amount_minor, 100)
  assert.equal(created.children.length, 2)

  const legacy = store.createBatch(batchInput('signal-b', 40), { fencingToken: lease.fencingToken })
  store.reserveRound(legacy.batchId, [allocation('account-c', 40)], { fencingToken: lease.fencingToken })
  const before = {
    auth: handle.db.prepare('SELECT reserved_amount_minor FROM execution_authorizations').get().reserved_amount_minor,
    bindings: handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count,
  }
  assert.throws(() => store.createAuthorizedBatchWithReservations({
    ...batchInput('signal-b', 40),
    authorizationId: authorization.authorizationId,
  }, [allocation('account-c', 40)], {
    fencingToken: lease.fencingToken,
    authorizationId: authorization.authorizationId,
    executorOwnerId: lease.ownerId,
    authorizationOptions: { env, now: current.now },
  }), /authorized-batch-conflict/)
  assert.deepEqual({
    auth: handle.db.prepare('SELECT reserved_amount_minor FROM execution_authorizations').get().reserved_amount_minor,
    bindings: handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count,
  }, before)
  handle.close()
})

test('local recovery converts legacy authorized attempts and budgets to unknown without remote reconciliation', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db, { signals: ['signal-a'], accounts: ['account-a'] })
  handle.db.prepare(`UPDATE betting_rules SET enabled=1,execution_mode='real_eligible' WHERE id='rule-a'`).run()
  const current = clock(NOW)
  const env = {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '0',
    CROWN_REAL_MAX_TOTAL_MINOR: '1000',
  }
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:legacy-recovery',
    ownerId: 'legacy-recovery-owner',
    pid: 1,
    ttlMs: 60_000,
    now: current.now,
  })
  lease.acquire()
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'authorization-legacy-recovery',
    currency: 'CNY',
    amountScale: 0,
    ruleIds: ['rule-a'],
    maxTotalAmountMinor: 20,
    confirmation: 'OFFLINE LEGACY RECOVERY TEST',
  }, { env, now: current.now })
  const store = new BetBatchStore(handle.db, {
    fencingToken: lease.fencingToken,
    leaseKey: lease.leaseKey,
    now: () => NOW,
  })
  try {
    const created = store.createAuthorizedBatchWithReservations({
      ...batchInput('signal-a', 20),
      authorizationId: authorization.authorizationId,
    }, [allocation('account-a', 20)], {
      fencingToken: lease.fencingToken,
      authorizationId: authorization.authorizationId,
      executorOwnerId: lease.ownerId,
      authorizationOptions: { env, now: current.now },
    })
    const child = created.children[0]
    store.prepareSubmit(child.childOrderId, {
      submitAttemptId: 'legacy-recovery-attempt',
      fencingToken: lease.fencingToken,
      at: NOW,
    })
    handle.db.prepare(`INSERT INTO bet_submit_attempts (
      submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,fencing_token,
      capability_version,capability_evidence_id,preview_odds,locked_identity_json,preview_snapshot_json,
      status,prepared_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'submit_prepared',?,?,?)`).run(
      'legacy-recovery-attempt', child.childOrderId, authorization.authorizationId, 1, 20, lease.fencingToken,
      'v1', 'e1', '0.88', '{}', '{}', NOW, NOW, NOW,
    )

    const recovered = store.recover({ fencingToken: lease.fencingToken, at: NOW })
    assert.equal(recovered.unknownCount, 1)
    assert.deepEqual({ ...handle.db.prepare(`SELECT child.status AS child_status,attempt.status AS attempt_status,
      budget.status AS budget_status,lock.status AS lock_status
      FROM bet_child_orders AS child
      JOIN bet_submit_attempts AS attempt ON attempt.child_order_id=child.child_order_id
      JOIN execution_authorization_child_budgets AS budget ON budget.child_order_id=child.child_order_id
      JOIN betting_account_locks AS lock ON lock.child_order_id=child.child_order_id`).get() }, {
      child_status: 'unknown', attempt_status: 'unknown', budget_status: 'unknown', lock_status: 'unknown',
    })
    assert.deepEqual({ ...handle.db.prepare(`SELECT reserved_amount_minor,unknown_amount_minor
      FROM execution_authorizations WHERE authorization_id=?`).get(authorization.authorizationId) }, {
      reserved_amount_minor: 0,
      unknown_amount_minor: 20,
    })
  } finally {
    lease.release()
    handle.close()
  }
})

test('recovery keeps duplicate migrated in-flight attempts unknown behind one conservative account lock', () => {
  const dbPath = temporaryDbPath()
  const seeded = openAppDatabase({ dbPath })
  seed(seeded.db, { signals: ['signal-a'], accounts: ['account-a'] })
  try {
    seeded.db.prepare(`
      INSERT INTO bet_batches (
        batch_id,signal_id,rule_id,event_key,locked_selection_identity,currency,amount_scale,
        target_amount_minor,reserved_amount_minor,unfilled_amount_minor,status,created_at
      ) VALUES ('legacy-duplicate-batch','signal-a','rule-a','event','selection','CNY',0,
        20,20,0,'submitting',?)
    `).run(NOW)
    seeded.db.prepare(`
      INSERT INTO bet_child_orders (
        child_order_id,batch_id,account_id,attempt,requested_amount_minor,submit_attempt_id,
        submit_prepared_at,submit_dispatched_at,submitted_at,status,created_at
      ) VALUES
        ('legacy-prepared','legacy-duplicate-batch','account-a',1,10,'legacy-attempt-prepared',
          ?,'','','submit_prepared',?),
        ('legacy-dispatched','legacy-duplicate-batch','account-a',2,10,'legacy-attempt-dispatched',
          ?,?,?,'submit_dispatched',?)
    `).run(NOW, NOW, NOW, NOW, NOW, NOW)
    seeded.db.prepare(`
      INSERT INTO bet_submit_attempts (
        submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,fencing_token,
        capability_version,capability_evidence_id,preview_odds,locked_identity_json,preview_snapshot_json,
        status,prepared_at,dispatched_at,created_at,updated_at
      ) VALUES
        ('legacy-attempt-prepared','legacy-prepared',NULL,1,10,1,
          'v1','e1','0.88','{}','{}','submit_prepared',?,'',?,?),
        ('legacy-attempt-dispatched','legacy-dispatched',NULL,2,10,1,
          'v1','e1','0.88','{}','{}','submit_prepared',?,'',?,?)
    `).run(NOW, NOW, NOW, NOW, NOW, NOW)
    seeded.db.prepare(`
      UPDATE bet_submit_attempts
      SET status='submit_dispatched',dispatched_at=?,updated_at=?
      WHERE submit_attempt_id='legacy-attempt-dispatched'
    `).run(NOW, NOW)
    seeded.db.prepare(`
      INSERT INTO betting_account_locks (
        account_id,child_order_id,batch_id,status,fencing_token,acquired_at,updated_at
      ) VALUES ('account-a','legacy-dispatched','legacy-duplicate-batch','submitting',1,?,?)
    `).run(NOW, NOW)
  } finally {
    seeded.close()
  }

  const handle = openAppDatabase({ dbPath })
  const store = new BetBatchStore(handle.db, { fencingToken: 2, now: () => NOW })
  try {
    const recovered = store.recover({ fencingToken: 2, at: NOW })

    assert.equal(recovered.unknownCount, 2)
    assert.equal(recovered.activeLockCount, 1)
    assert.deepEqual(handle.db.prepare(`
      SELECT child_order_id,status,error_code FROM bet_child_orders
      WHERE batch_id='legacy-duplicate-batch' ORDER BY attempt
    `).all().map((row) => ({ ...row })), [
      { child_order_id: 'legacy-prepared', status: 'unknown', error_code: 'recovery-uncertain' },
      { child_order_id: 'legacy-dispatched', status: 'unknown', error_code: 'recovery-uncertain' },
    ])
    assert.deepEqual(handle.db.prepare(`
      SELECT submit_attempt_id,status,error_code FROM bet_submit_attempts ORDER BY attempt_ordinal
    `).all().map((row) => ({ ...row })), [
      { submit_attempt_id: 'legacy-attempt-prepared', status: 'unknown', error_code: 'recovery-uncertain' },
      { submit_attempt_id: 'legacy-attempt-dispatched', status: 'unknown', error_code: 'recovery-uncertain' },
    ])
    const locks = handle.db.prepare(`
      SELECT lock.account_id,lock.status,child.status AS child_status
      FROM betting_account_locks AS lock
      JOIN bet_child_orders AS child ON child.child_order_id=lock.child_order_id
    `).all().map((row) => ({ ...row }))
    assert.deepEqual(locks, [{ account_id: 'account-a', status: 'unknown', child_status: 'unknown' }])
  } finally {
    handle.close()
  }
})

test('createBatch is deterministic and idempotent for signalId + ruleId', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const signalId = 'a'.repeat(64)
  seed(handle.db, { signals: [signalId] })
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })

  const first = store.createBatch(batchInput(signalId, 120))
  const replay = store.createBatch({ ...batchInput(signalId, 999), sourceLeague: 'Changed replay data' })

  assert.equal(first.batchId, deterministicBatchId(signalId, 'rule-a'))
  assert.equal(replay.batchId, first.batchId)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 1)
  assert.equal(batchRow(handle.db, first.batchId).target_amount_minor, 120)
  assert.equal(batchRow(handle.db, first.batchId).unfilled_amount_minor, 120)
  handle.close()
})

test('reserveRound atomically arbitrates account locks across batches', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 7 })
  const first = store.createBatch(batchInput('signal-a'))
  const second = store.createBatch(batchInput('signal-b'))

  const [firstChild] = store.reserveRound(first.batchId, [allocation('account-a', 60)])
  assert.equal(childRow(handle.db, firstChild.childOrderId).status, 'reserved')
  assert.equal(handle.db.prepare("SELECT fencing_token FROM betting_account_locks WHERE account_id = 'account-a'").get().fencing_token, 7)

  assert.throws(() => store.reserveRound(second.batchId, [
    allocation('account-b', 30),
    allocation('account-a', 40),
  ]), /account-locked:account-a/)
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM bet_child_orders WHERE batch_id = ?").get(second.batchId).count, 0)
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE account_id = 'account-b'").get().count, 0)
  handle.close()
})

test('pause_pending blocks new allocation but does not invalidate an existing reserved child', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db, { signals: ['signal-a', 'signal-b'], accounts: ['account-a'] })
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const existing = store.createBatch(batchInput('signal-a', 40))
  const [child] = store.reserveRound(existing.batchId, [allocation('account-a', 40)])
  handle.db.prepare("UPDATE betting_accounts SET allocation_status='pause_pending' WHERE id='account-a'").run()
  assert.doesNotThrow(() => store.prepareSubmit(child.childOrderId, { submitAttemptId: 'existing-child', at: NOW }))
  store.markDispatched(child.childOrderId, { at: NOW })
  store.resolveChildOrder(child.childOrderId, { status: 'accepted', at: NOW })

  const next = store.createBatch(batchInput('signal-b', 40))
  assert.throws(() => store.reserveRound(next.batchId, [allocation('account-a', 40)]), /account-allocation-paused/)
  handle.close()
})

test('reserveRound rechecks account eligibility and hard limit inside the transaction', () => {
  const cases = [
    {
      name: 'disabled',
      update: "UPDATE betting_accounts SET status = 'disabled' WHERE id = 'account-a'",
      allocation: allocation('account-a', 40),
      error: /account-disabled/,
    },
    {
      name: 'archived',
      update: "UPDATE betting_accounts SET archived = 1 WHERE id = 'account-a'",
      allocation: allocation('account-a', 40),
      error: /account-archived/,
    },
    {
      name: 'hard limit',
      update: "UPDATE betting_accounts SET per_bet_limit_minor = 30 WHERE id = 'account-a'",
      allocation: allocation('account-a', 40),
      error: /account-per-bet-limit/,
    },
  ]

  for (const current of cases) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    seed(handle.db)
    const store = new BetBatchStore(handle.db, { fencingToken: 1 })
    const batch = store.createBatch(batchInput('signal-a'))
    handle.db.exec(current.update)
    assert.throws(() => store.reserveRound(batch.batchId, [current.allocation]), current.error, current.name)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 0, current.name)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM betting_account_locks').get().count, 0, current.name)
    handle.close()
  }
})

test('reserveRound ignores legacy account step zero while retaining provider preview step validation', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  handle.db.prepare("UPDATE betting_accounts SET stake_step_minor = 0 WHERE id = 'account-a'").run()
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a'))
  assert.doesNotThrow(() => store.reserveRound(batch.batchId, [allocation('account-a', 40)]))
  store.cancelUnsubmitted(batch.batchId, { at: NOW })

  const second = store.createBatch(batchInput('signal-b'))
  assert.throws(() => store.reserveRound(second.batchId, [{
    ...allocation('account-a', 45),
    previewMinStakeMinor: 10,
    previewStakeStepMinor: 10,
  }]), /preview-stake-step/)
  handle.close()
})

test('reserveRound validates preview stake steps from preview minimum offset', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  handle.db.prepare("UPDATE betting_accounts SET stake_step_minor = 10 WHERE id = 'account-a'").run()
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a'))
  const offsetAllocation = {
    ...allocation('account-a', 55),
    previewMinStakeMinor: 55,
    previewMaxStakeMinor: 75,
    previewStakeStepMinor: 10,
  }
  assert.doesNotThrow(() => store.reserveRound(batch.batchId, [offsetAllocation]))
  store.cancelUnsubmitted(batch.batchId, { at: NOW })

  const second = store.createBatch(batchInput('signal-b'))
  assert.throws(() => store.reserveRound(second.batchId, [{ ...offsetAllocation, amountMinor: 60 }]), /preview-stake-step/)
  handle.close()
})

test('reserveRound rolls back child rows, locks, and cached amounts after an injected failure', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const baseStore = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = baseStore.createBatch(batchInput('signal-a'))
  const failingStore = new BetBatchStore(handle.db, {
    fencingToken: 1,
    faultInjector(phase) {
      if (phase === 'reserve:after-child-insert') throw new Error('injected-reserve-failure')
    },
  })

  assert.throws(() => failingStore.reserveRound(batch.batchId, [allocation('account-a', 60)]), /injected-reserve-failure/)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 0)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batch_account_usage').get().count, 0)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM betting_account_locks').get().count, 0)
  assert.deepEqual(
    { ...handle.db.prepare('SELECT reserved_amount_minor, accepted_amount_minor, unknown_amount_minor, unfilled_amount_minor FROM bet_batches').get() },
    { reserved_amount_minor: 0, accepted_amount_minor: 0, unknown_amount_minor: 0, unfilled_amount_minor: 100 },
  )
  handle.close()
})

test('an injected failure after an accepted write rolls back and recovery treats the dispatched order as unknown', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const baseStore = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = baseStore.createBatch(batchInput('signal-a'))
  const [child] = baseStore.reserveRound(batch.batchId, [allocation('account-a', 40)])
  baseStore.prepareSubmit(child.childOrderId, { submitAttemptId: 'crash-submit', at: NOW })
  baseStore.markDispatched(child.childOrderId, { at: NOW })
  const failingStore = new BetBatchStore(handle.db, {
    fencingToken: 1,
    faultInjector(phase) {
      if (phase === 'resolve:after-child-update') throw new Error('injected-accepted-commit-failure')
    },
  })

  assert.throws(
    () => failingStore.resolveChildOrder(child.childOrderId, { status: 'accepted', at: NOW }),
    /injected-accepted-commit-failure/,
  )
  assert.equal(childRow(handle.db, child.childOrderId).status, 'submit_dispatched')
  assert.equal(batchRow(handle.db, batch.batchId).reserved_amount_minor, 40)
  assert.equal(handle.db.prepare("SELECT status FROM betting_account_locks WHERE account_id = 'account-a'").get().status, 'submitting')

  const recoveredStore = new BetBatchStore(handle.db, { fencingToken: 2 })
  assert.equal(recoveredStore.recover({ at: NOW }).unknownCount, 1)
  assert.equal(childRow(handle.db, child.childOrderId).status, 'unknown')
  assert.equal(batchRow(handle.db, batch.batchId).unknown_amount_minor, 40)
  handle.close()
})

test('prepare/dispatched and accepted/rejected/unknown transfer ledger amounts and locks atomically', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 3 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [accepted, rejected, unknown] = store.reserveRound(batch.batchId, [
    allocation('account-a', 40),
    allocation('account-b', 30),
    allocation('account-c', 20),
  ])
  assert.deepEqual(
    Object.fromEntries(['reserved_amount_minor', 'accepted_amount_minor', 'unknown_amount_minor', 'unfilled_amount_minor'].map((key) => [key, batchRow(handle.db, batch.batchId)[key]])),
    { reserved_amount_minor: 90, accepted_amount_minor: 0, unknown_amount_minor: 0, unfilled_amount_minor: 10 },
  )

  for (const child of [accepted, rejected, unknown]) {
    store.prepareSubmit(child.childOrderId, { submitAttemptId: `submit-${child.childOrderId}`, at: NOW })
    store.markDispatched(child.childOrderId, { at: NOW })
  }
  store.resolveChildOrder(accepted.childOrderId, { status: 'accepted', at: NOW })
  store.resolveChildOrder(rejected.childOrderId, { status: 'rejected', errorCode: 'provider-rejected', at: NOW })
  store.resolveChildOrder(unknown.childOrderId, { status: 'unknown', errorCode: 'timeout', at: NOW })

  assert.deepEqual(
    Object.fromEntries(['reserved_amount_minor', 'accepted_amount_minor', 'unknown_amount_minor', 'unfilled_amount_minor', 'status'].map((key) => [key, batchRow(handle.db, batch.batchId)[key]])),
    { reserved_amount_minor: 0, accepted_amount_minor: 40, unknown_amount_minor: 20, unfilled_amount_minor: 40, status: 'waiting_result' },
  )
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE account_id IN ('account-a', 'account-b')").get().count, 0)
  assert.deepEqual(
    { ...handle.db.prepare("SELECT status, fencing_token FROM betting_account_locks WHERE account_id = 'account-c'").get() },
    { status: 'unknown', fencing_token: 3 },
  )
  handle.close()
})

test('reconcileAggregates repairs cached totals from child rows and applies waiting/terminal priority', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })

  const waiting = store.createBatch(batchInput('signal-a', 100))
  const [waitingChild] = store.reserveRound(waiting.batchId, [allocation('account-a', 40)])
  store.prepareSubmit(waitingChild.childOrderId, { submitAttemptId: 'waiting-submit', at: NOW })
  store.markDispatched(waitingChild.childOrderId, { at: NOW })
  store.resolveChildOrder(waitingChild.childOrderId, { status: 'rejected', at: NOW })
  handle.db.prepare('UPDATE bet_batches SET reserved_amount_minor = 10, unfilled_amount_minor = 90 WHERE batch_id = ?').run(waiting.batchId)
  store.reconcileAggregates(waiting.batchId, { hasFutureCapacity: true })
  assert.deepEqual(
    { ...handle.db.prepare('SELECT reserved_amount_minor, unfilled_amount_minor, status FROM bet_batches WHERE batch_id = ?').get(waiting.batchId) },
    { reserved_amount_minor: 0, unfilled_amount_minor: 100, status: 'waiting_capacity' },
  )

  const partial = store.createBatch(batchInput('signal-b', 100))
  const [partialChild] = store.reserveRound(partial.batchId, [allocation('account-a', 40)])
  store.prepareSubmit(partialChild.childOrderId, { submitAttemptId: 'partial-submit', at: NOW })
  store.markDispatched(partialChild.childOrderId, { at: NOW })
  store.resolveChildOrder(partialChild.childOrderId, { status: 'accepted', at: NOW, hasFutureCapacity: false })
  assert.equal(batchRow(handle.db, partial.batchId).status, 'partial')

  const failed = store.createBatch(batchInput('signal-c', 100))
  const [failedChild] = store.reserveRound(failed.batchId, [allocation('account-a', 40)])
  store.prepareSubmit(failedChild.childOrderId, { submitAttemptId: 'failed-submit', at: NOW })
  store.markDispatched(failedChild.childOrderId, { at: NOW })
  store.resolveChildOrder(failedChild.childOrderId, { status: 'rejected', at: NOW, hasFutureCapacity: false })
  assert.equal(batchRow(handle.db, failed.batchId).status, 'failed')
  handle.close()
})

test('reserveRound never reuses an account in the same batch after a rejection releases its lock', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [child] = store.reserveRound(batch.batchId, [allocation('account-a', 40)])
  store.prepareSubmit(child.childOrderId, { submitAttemptId: 'rejected-submit', at: NOW })
  store.markDispatched(child.childOrderId, { at: NOW })
  store.resolveChildOrder(child.childOrderId, { status: 'rejected', at: NOW, hasFutureCapacity: true })

  assert.throws(
    () => store.reserveRound(batch.batchId, [allocation('account-a', 40)]),
    /account-already-used:account-a/,
  )
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders WHERE batch_id = ?').get(batch.batchId).count, 1)
  assert.deepEqual({ ...handle.db.prepare(`SELECT batch_id,account_id,child_order_id
    FROM bet_batch_account_usage WHERE batch_id=?`).get(batch.batchId) }, {
    batch_id: batch.batchId, account_id: 'account-a', child_order_id: child.childOrderId,
  })
  handle.close()
})

test('completed wins only after target is accepted and no child remains nonterminal', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 50))
  const [child] = store.reserveRound(batch.batchId, [allocation('account-a', 50)])
  store.prepareSubmit(child.childOrderId, { submitAttemptId: 'complete-submit', at: NOW })
  store.markDispatched(child.childOrderId, { at: NOW })
  store.resolveChildOrder(child.childOrderId, { status: 'accepted', at: NOW, hasFutureCapacity: false })

  assert.deepEqual(
    { ...handle.db.prepare('SELECT accepted_amount_minor, unfilled_amount_minor, status, finished_at FROM bet_batches WHERE batch_id = ?').get(batch.batchId) },
    { accepted_amount_minor: 50, unfilled_amount_minor: 0, status: 'completed', finished_at: NOW },
  )
  handle.close()
})

test('public aggregate reconciliation cannot reopen a terminal batch for new reservations', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [child] = store.reserveRound(batch.batchId, [allocation('account-a', 40)])
  store.prepareSubmit(child.childOrderId, { submitAttemptId: 'partial-terminal', at: NOW })
  store.markDispatched(child.childOrderId, { at: NOW })
  store.resolveChildOrder(child.childOrderId, { status: 'accepted', at: NOW, hasFutureCapacity: false })
  assert.equal(batchRow(handle.db, batch.batchId).status, 'partial')

  store.reconcileAggregates(batch.batchId)
  assert.equal(batchRow(handle.db, batch.batchId).status, 'partial')
  assert.throws(() => store.reserveRound(batch.batchId, [allocation('account-b', 60)]), /batch-terminal/)
  handle.close()
})

test('cancelUnsubmitted cancels only provably unsent reservations', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [prepared, reserved] = store.reserveRound(batch.batchId, [allocation('account-a', 40), allocation('account-b', 40)])
  store.prepareSubmit(prepared.childOrderId, { submitAttemptId: 'prepared-submit', at: NOW })
  store.cancelUnsubmitted(batch.batchId, { at: NOW })

  assert.equal(childRow(handle.db, reserved.childOrderId).status, 'cancelled')
  assert.equal(childRow(handle.db, prepared.childOrderId).status, 'submit_prepared')
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE account_id = 'account-b'").get().count, 0)
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE account_id = 'account-a'").get().count, 1)
  handle.close()
})

test('manual cancel intent survives submitted and unknown children and permanently blocks new reservations', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [submitted, unsent] = store.reserveRound(batch.batchId, [allocation('account-a', 40), allocation('account-b', 40)])
  store.prepareSubmit(submitted.childOrderId, { submitAttemptId: 'cancel-pending', at: NOW })
  store.markDispatched(submitted.childOrderId, { at: NOW })
  store.cancelUnsubmitted(batch.batchId, { finishReason: 'manual_cancel', at: NOW })

  assert.equal(childRow(handle.db, unsent.childOrderId).status, 'cancelled')
  assert.equal(batchRow(handle.db, batch.batchId).status, 'submitting')
  assert.equal(batchRow(handle.db, batch.batchId).finish_reason, 'manual_cancel')
  assert.throws(() => store.reserveRound(batch.batchId, [allocation('account-c', 60)]), /batch-stopped/)

  store.resolveChildOrder(submitted.childOrderId, { status: 'unknown', at: NOW })
  assert.equal(batchRow(handle.db, batch.batchId).status, 'waiting_result')
  assert.equal(batchRow(handle.db, batch.batchId).finish_reason, 'manual_cancel')
  store.resolveChildOrder(submitted.childOrderId, { status: 'rejected', at: NOW })
  assert.equal(batchRow(handle.db, batch.batchId).status, 'cancelled')
  assert.equal(batchRow(handle.db, batch.batchId).finish_reason, 'manual_cancel')
  assert.throws(() => store.reserveRound(batch.batchId, [allocation('account-c', 60)]), /batch-terminal/)
  handle.close()
})

test('execution stop reason survives prepared recovery while cancelling only provably unsent children', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const store = new BetBatchStore(handle.db, { fencingToken: 1 })
  const batch = store.createBatch(batchInput('signal-a', 100))
  const [prepared, reserved] = store.reserveRound(batch.batchId, [allocation('account-a', 40), allocation('account-b', 40)])
  store.prepareSubmit(prepared.childOrderId, { submitAttemptId: 'market-change-pending', at: NOW })

  store.cancelUnsubmitted(batch.batchId, { finishReason: 'market_changed', at: NOW })
  assert.equal(childRow(handle.db, prepared.childOrderId).status, 'submit_prepared')
  assert.equal(childRow(handle.db, reserved.childOrderId).status, 'cancelled')
  assert.equal(batchRow(handle.db, batch.batchId).status, 'submitting')
  assert.equal(batchRow(handle.db, batch.batchId).finish_reason, 'market_changed')

  store.recover({ at: NOW })
  assert.equal(childRow(handle.db, prepared.childOrderId).status, 'unknown')
  assert.equal(batchRow(handle.db, batch.batchId).status, 'waiting_result')
  assert.equal(batchRow(handle.db, batch.batchId).finish_reason, 'market_changed')
  assert.throws(() => store.reserveRound(batch.batchId, [allocation('account-c', 60)]), /batch-stopped/)
  handle.close()
})

test('reopen recovery turns prepared/dispatched into unknown, preserves reserved, and fences stale writers', () => {
  const dbPath = temporaryDbPath()
  const first = openAppDatabase({ dbPath })
  seed(first.db)
  const staleStore = new BetBatchStore(first.db, { fencingToken: 10 })
  const batch = staleStore.createBatch(batchInput('signal-a', 100))
  const [prepared, dispatched, reserved] = staleStore.reserveRound(batch.batchId, [
    allocation('account-a', 30), allocation('account-b', 30), allocation('account-c', 30),
  ])
  staleStore.prepareSubmit(prepared.childOrderId, { submitAttemptId: 'prepared', at: NOW })
  staleStore.prepareSubmit(dispatched.childOrderId, { submitAttemptId: 'dispatched', at: NOW })
  staleStore.markDispatched(dispatched.childOrderId, { at: NOW })

  const reopened = openAppDatabase({ dbPath })
  const recoveredStore = new BetBatchStore(reopened.db, { fencingToken: 11 })
  const recovered = recoveredStore.recover({ at: '2026-07-10T12:01:00.000Z' })
  assert.equal(recovered.unknownCount, 2)
  assert.equal(childRow(reopened.db, prepared.childOrderId).status, 'unknown')
  assert.equal(childRow(reopened.db, dispatched.childOrderId).status, 'unknown')
  assert.equal(childRow(reopened.db, reserved.childOrderId).status, 'reserved')
  assert.deepEqual(
    reopened.db.prepare('SELECT status, fencing_token FROM betting_account_locks ORDER BY account_id').all().map((row) => ({ ...row })),
    [
      { status: 'unknown', fencing_token: 11 },
      { status: 'unknown', fencing_token: 11 },
      { status: 'reserved', fencing_token: 11 },
    ],
  )
  assert.equal(batchRow(reopened.db, batch.batchId).status, 'waiting_result')
  assert.throws(() => staleStore.recover({ at: '2026-07-10T12:01:30.000Z' }), /fencing-token/)
  assert.equal(reopened.db.prepare("SELECT MIN(fencing_token) AS token FROM betting_account_locks").get().token, 11)
  assert.throws(() => staleStore.prepareSubmit(reserved.childOrderId, { submitAttemptId: 'stale-write', at: NOW }), /fencing-token/)

  recoveredStore.cancelUnsubmitted(batch.batchId, { at: NOW })
  assert.equal(childRow(reopened.db, reserved.childOrderId).status, 'cancelled')
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE status = 'reserved'").get().count, 0)
  assert.equal(recoveredStore.recover({ at: '2026-07-10T12:02:00.000Z' }).unknownCount, 0)
  reopened.close()
  first.close()
})

test('strict executor lease fencing rejects every stale mutation across batches and with zero active locks', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seed(handle.db)
  const time = clock()
  const firstLease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:test', ownerId: 'owner-1', ttlMs: 1000, now: time.now })
  const secondLease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:test', ownerId: 'owner-2', ttlMs: 1000, now: time.now })
  firstLease.acquire()
  const stale = new BetBatchStore(handle.db, { fencingToken: 1, leaseKey: 'betting-executor:test', now: time.now })
  const firstBatch = stale.createBatch(batchInput('signal-a'), { fencingToken: 1 })
  const secondBatch = stale.createBatch(batchInput('signal-b'), { fencingToken: 1 })

  time.advance(1001)
  secondLease.acquire()
  const current = new BetBatchStore(handle.db, { fencingToken: 2, leaseKey: 'betting-executor:test', now: time.now })
  assert.throws(() => stale.createBatch(batchInput('signal-c'), { fencingToken: 1 }), /fencing-token/)
  assert.throws(() => stale.recover({ fencingToken: 1, at: NOW }), /fencing-token/)

  const [child] = current.reserveRound(firstBatch.batchId, [allocation('account-a', 40)], { fencingToken: 2 })
  assert.throws(() => stale.reserveRound(secondBatch.batchId, [allocation('account-b', 40)], { fencingToken: 1 }), /fencing-token/)
  assert.throws(() => stale.reconcileAggregates(firstBatch.batchId, { fencingToken: 1 }), /fencing-token/)
  assert.throws(() => stale.cancelUnsubmitted(firstBatch.batchId, { fencingToken: 1, at: NOW }), /fencing-token/)
  assert.throws(() => stale.prepareSubmit(child.childOrderId, { submitAttemptId: 'stale', fencingToken: 1, at: NOW }), /fencing-token/)

  current.prepareSubmit(child.childOrderId, { submitAttemptId: 'current', fencingToken: 2, at: NOW })
  current.markDispatched(child.childOrderId, { fencingToken: 2, at: NOW })
  assert.throws(() => stale.resolveChildOrder(child.childOrderId, { status: 'accepted', fencingToken: 1, at: NOW }), /fencing-token/)
  current.resolveChildOrder(child.childOrderId, { status: 'accepted', fencingToken: 2, at: NOW })
  handle.db.prepare("UPDATE runtime_leases SET expires_at = 'corrupt' WHERE lease_key = 'betting-executor:test'").run()
  assert.throws(() => current.createBatch(batchInput('signal-c'), { fencingToken: 2 }), /fencing-token/)
  handle.close()
})
