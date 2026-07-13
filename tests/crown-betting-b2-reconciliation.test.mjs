import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { encryptSecret } from '../src/crown/app/app-secret.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'

const BASE_TIME = '2026-07-11T00:00:00.000Z'
const RECONCILER_MODULE = '../src/crown/betting/b2-reconciler.mjs'
const reconcilerModule = import(RECONCILER_MODULE)
const LOCKED_IDENTITY = Object.freeze({
  provider: 'fixture',
  eventId: '8878933',
  mode: 'live',
  period: 'full_time',
  marketType: 'asian_handicap',
  lineKey: 'ah:ft:-0.25',
  handicap: '-0 / 0.5',
  side: 'home',
})
const PROVIDER_REFERENCE_KEY = 'b2-reconciliation-provider-reference-test-key'
const PROVIDER_REFERENCE_CIPHERTEXT = encryptSecret('reconciled-provider-reference', {
  secretKey: PROVIDER_REFERENCE_KEY,
  context: {
    purpose: 'crown-provider-reference',
    childOrderId: 'child-reconcile',
    submitAttemptId: 'attempt-reconcile',
  },
})

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-b2-reconciliation-')), 'crown.sqlite')
}

function clockAt(iso = BASE_TIME) {
  let milliseconds = Date.parse(iso)
  return {
    now: () => new Date(milliseconds),
    advance(seconds) { milliseconds += seconds * 1_000 },
    set(value) { milliseconds = Date.parse(value) },
    iso: () => new Date(milliseconds).toISOString(),
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function seedUnknownLedger(db) {
  db.exec(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (
      'signal-reconcile', 'signal-reconcile-key', 'b2-reconciliation-test', 1,
      'ready', '${BASE_TIME}', '2026-07-11T02:00:00.000Z', '{}'
    );

    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES (
      'rule-reconcile', 'rule', 1, 'real_eligible', 'CNY', 2, 20,
      '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO betting_accounts (
      id, label, username, status, archived, currency, amount_scale,
      per_bet_limit_minor, stake_step_minor, created_at, updated_at
    ) VALUES (
      'account-reconcile', 'account', 'account', 'enabled', 0, 'CNY', 2,
      50, 1, '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO execution_authorizations (
      authorization_id, currency, amount_scale, rule_ids_json,
      max_total_amount_minor, hard_cap_amount_minor, unknown_amount_minor,
      valid_from, expires_at, status, created_at, updated_at
    ) VALUES (
      'auth-reconcile', 'CNY', 2, '["rule-reconcile"]', 100, 100, 20,
      '${BASE_TIME}', '2026-07-12T00:00:00.000Z', 'active',
      '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, authorization_id,
      locked_selection_identity, currency, amount_scale,
      target_amount_minor, unknown_amount_minor, unfilled_amount_minor,
      status, created_at
    ) VALUES (
      'batch-reconcile', 'signal-reconcile', 'rule-reconcile', 'auth-reconcile',
      '${JSON.stringify(LOCKED_IDENTITY)}', 'CNY', 2, 20, 20, 0,
      'waiting_result', '${BASE_TIME}'
    );

    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor,
      preview_balance_minor, preview_stake_step_minor, preview_odds,
      submit_attempt_id, submit_prepared_at, submit_dispatched_at,
      status, error_code, created_at, submitted_at
    ) VALUES (
      'child-reconcile', 'batch-reconcile', 'account-reconcile', 20,
      10, 50, 100, 1, '0.83', 'attempt-reconcile', '${BASE_TIME}', '${BASE_TIME}',
      'unknown', 'provider-pending', '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO execution_authorization_child_budgets (
      child_order_id, authorization_id, batch_id, account_id,
      amount_minor, status, created_at, updated_at
    ) VALUES (
      'child-reconcile', 'auth-reconcile', 'batch-reconcile', 'account-reconcile',
      20, 'unknown', '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token,
      acquired_at, updated_at
    ) VALUES (
      'account-reconcile', 'child-reconcile', 'batch-reconcile', 'unknown', 1,
      '${BASE_TIME}', '${BASE_TIME}'
    );

    INSERT INTO bet_submit_attempts (
      submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
      amount_minor, fencing_token, capability_version, capability_evidence_id,
      preview_odds, locked_identity_json, preview_snapshot_json, status,
      prepared_at, created_at, updated_at
    ) VALUES (
      'attempt-reconcile', 'child-reconcile', 'auth-reconcile', 1,
      20, 1, 'crown-capability-v1:test', 'fixture:reconciliation:test',
      '0.83', '${JSON.stringify(LOCKED_IDENTITY)}',
      '{"balanceMinor":100,"maxStakeMinor":50,"minStakeMinor":10,"odds":"0.83","stakeStepMinor":1}',
      'submit_prepared', '${BASE_TIME}', '${BASE_TIME}', '${BASE_TIME}'
    );

    UPDATE bet_submit_attempts
    SET status = 'submit_dispatched', dispatched_at = '${BASE_TIME}', updated_at = '${BASE_TIME}'
    WHERE submit_attempt_id = 'attempt-reconcile';

    UPDATE bet_submit_attempts
    SET status = 'unknown', result_at = '${BASE_TIME}',
        error_code = 'provider-pending', updated_at = '${BASE_TIME}'
    WHERE submit_attempt_id = 'attempt-reconcile';
  `)
}

function acquireLease(db, clock, ownerId = 'reconciler-one') {
  const lease = new RuntimeLease({
    db,
    leaseKey: 'betting-reconciler:b2-reconciliation-test',
    ownerId,
    pid: ownerId === 'reconciler-one' ? 1 : 2,
    ttlMs: 600_000,
    now: clock.now,
  })
  lease.acquire()
  return lease
}

function setup({ dbPath = ':memory:', clock = clockAt() } = {}) {
  const handle = openAppDatabase({ dbPath })
  seedUnknownLedger(handle.db)
  const lease = acquireLease(handle.db, clock)
  return { handle, db: handle.db, lease, clock, dbPath }
}

async function api() {
  const value = await reconcilerModule
  assert.equal(typeof value.B2Reconciler, 'function', 'missing B2Reconciler export')
  return value
}

function makeReconciler(B2Reconciler, context, sourceClient, overrides = {}) {
  return new B2Reconciler({
    database: context.db,
    lease: context.lease,
    sourceClient,
    reconciliationMode: 'fixture',
    now: context.clock.now,
    secretKey: PROVIDER_REFERENCE_KEY,
    manualAuthorizer: ({ operatorId }) => operatorId,
    hasFutureCapacity: () => false,
    ...overrides,
  })
}

function noMatch(source, sequence) {
  return {
    decision: 'no_match',
    matchStrength: 'none',
    matchCount: 0,
    payload: { source, sequence, result: 'none' },
  }
}

function strongDecision(decision, payload = {}) {
  return {
    decision,
    matchStrength: 'strong',
    matchCount: 1,
    providerReferenceCiphertext: decision === 'accepted' ? PROVIDER_REFERENCE_CIPHERTEXT : '',
    payload: { decision, ...payload },
  }
}

function reconciliationState(db) {
  return db.prepare(`
    SELECT * FROM bet_reconciliation_state
    WHERE submit_attempt_id = 'attempt-reconcile'
  `).get()
}

function ledgerSnapshot(db) {
  return {
    child: db.prepare("SELECT * FROM bet_child_orders WHERE child_order_id = 'child-reconcile'").get(),
    batch: db.prepare("SELECT * FROM bet_batches WHERE batch_id = 'batch-reconcile'").get(),
    authorization: db.prepare("SELECT * FROM execution_authorizations WHERE authorization_id = 'auth-reconcile'").get(),
    binding: db.prepare("SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = 'child-reconcile'").get(),
    lock: db.prepare("SELECT * FROM betting_account_locks WHERE child_order_id = 'child-reconcile'").get(),
    attempt: db.prepare("SELECT * FROM bet_submit_attempts WHERE submit_attempt_id = 'attempt-reconcile'").get(),
  }
}

function assertStillUnknown(db) {
  const ledger = ledgerSnapshot(db)
  assert.equal(ledger.child.status, 'unknown')
  assert.equal(ledger.batch.status, 'waiting_result')
  assert.equal(ledger.batch.unknown_amount_minor, 20)
  assert.equal(ledger.authorization.unknown_amount_minor, 20)
  assert.equal(ledger.binding.status, 'unknown')
  assert.equal(ledger.lock.status, 'unknown')
  assert.equal(ledger.attempt.status, 'unknown')
}

test('reconciliation polls evidenced sources in order and resumes 5/15/45 second backoff after restart', async () => {
  const { B2Reconciler } = await api()
  const dbPath = tempDbPath()
  const clock = clockAt()
  let context = setup({ dbPath, clock })
  const calls = []
  const sourceClient = {
    async getDangerous() {
      calls.push('get_dangerous')
      return noMatch('get_dangerous', calls.length)
    },
    async getTodayWagers() {
      calls.push('today_wagers')
      return noMatch('today_wagers', calls.length)
    },
  }
  let reconciler = makeReconciler(B2Reconciler, context, sourceClient)

  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  assert.deepEqual({
    status: reconciliationState(context.db).status,
    pollCount: reconciliationState(context.db).poll_count,
    nextPollAt: reconciliationState(context.db).next_poll_at,
  }, { status: 'pending', pollCount: 0, nextPollAt: BASE_TIME })

  await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.deepEqual(calls, ['get_dangerous', 'today_wagers'])
  assert.deepEqual({
    status: reconciliationState(context.db).status,
    pollCount: reconciliationState(context.db).poll_count,
    nextPollAt: reconciliationState(context.db).next_poll_at,
  }, { status: 'waiting', pollCount: 1, nextPollAt: '2026-07-11T00:00:05.000Z' })

  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:03:00.000Z',
  })
  assert.equal(reconciliationState(context.db).deadline_at, '2026-07-11T00:02:00.000Z')
  assert.equal(reconciliationState(context.db).poll_count, 1)

  clock.advance(5)
  context.lease.release()
  context.handle.close()
  const reopened = openAppDatabase({ dbPath })
  context = { handle: reopened, db: reopened.db, clock, dbPath, lease: acquireLease(reopened.db, clock, 'reconciler-two') }
  reconciler = makeReconciler(B2Reconciler, context, sourceClient)
  await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.equal(reconciliationState(context.db).poll_count, 2)
  assert.equal(reconciliationState(context.db).next_poll_at, '2026-07-11T00:00:20.000Z')

  clock.advance(15)
  await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.equal(reconciliationState(context.db).poll_count, 3)
  assert.equal(reconciliationState(context.db).next_poll_at, '2026-07-11T00:01:05.000Z')
  assert.deepEqual(calls, [
    'get_dangerous', 'today_wagers',
    'get_dangerous', 'today_wagers',
    'get_dangerous', 'today_wagers',
  ])
  assertStillUnknown(context.db)
  context.handle.close()
})

test('deadline equality stops reconciliation without another source call', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  let networkCalls = 0
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { networkCalls += 1; return noMatch('get_dangerous', networkCalls) },
    async getTodayWagers() { networkCalls += 1; return noMatch('today_wagers', networkCalls) },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:00:10.000Z',
  })
  context.clock.advance(10)

  const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })

  assert.equal(result.status, 'manual_review')
  assert.equal(networkCalls, 0)
  assert.equal(reconciliationState(context.db).status, 'manual_review')
  assert.equal(reconciliationState(context.db).poll_count, 0)
  assertStillUnknown(context.db)
  context.handle.close()
})

test('strong accepted and rejected evidence atomically resolves every unknown ledger and is idempotent', async (t) => {
  const { B2Reconciler } = await api()
  for (const decision of ['accepted', 'rejected']) {
    await t.test(decision, async () => {
      const context = setup()
      let sourceCalls = 0
      const rawMarker = `sensitive-${decision}-provider-marker`
      const sourceClient = {
        async getDangerous() {
          sourceCalls += 1
          return decision === 'accepted'
            ? noMatch('get_dangerous', sourceCalls)
            : strongDecision(decision, { rawMarker })
        },
        async getTodayWagers() {
          sourceCalls += 1
          if (decision !== 'accepted') throw new Error('today-wagers-must-not-run-after-strong-evidence')
          return strongDecision(decision, { rawMarker })
        },
      }
      const reconciler = makeReconciler(B2Reconciler, context, sourceClient)
      reconciler.scheduleUnknown({
        submitAttemptId: 'attempt-reconcile',
        deadlineAt: '2026-07-11T00:02:00.000Z',
      })
      const safetyReason = decision === 'accepted' ? 'manual_cancel' : 'market_changed'
      context.db.prepare('UPDATE bet_batches SET finish_reason=?').run(safetyReason)

      const first = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
      assert.equal(first.finalStatus, decision)
      assert.equal(sourceCalls, decision === 'accepted' ? 2 : 1)
      const ledger = ledgerSnapshot(context.db)
      assert.equal(ledger.child.status, decision)
      assert.equal(ledger.attempt.status, decision)
      assert.equal(ledger.batch.unknown_amount_minor, 0)
      assert.equal(ledger.authorization.unknown_amount_minor, 0)
      assert.equal(ledger.lock, undefined)
      assert.equal(ledger.batch.finish_reason, safetyReason)
      assert.equal(reconciliationState(context.db).status, 'resolved')
      assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE final_status='accepted'").get().count,
        decision === 'accepted' ? 1 : 0)
      assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE final_status<>'accepted'").get().count, 0)
      if (decision === 'accepted') {
        assert.equal(ledger.batch.status, 'completed')
        assert.equal(ledger.batch.accepted_amount_minor, 20)
        assert.equal(ledger.authorization.accepted_amount_minor, 20)
        assert.equal(ledger.binding.status, 'accepted')
        assert.equal(ledger.attempt.provider_reference_ciphertext, PROVIDER_REFERENCE_CIPHERTEXT)
      } else {
        assert.equal(ledger.batch.status, 'failed')
        assert.equal(ledger.batch.unfilled_amount_minor, 20)
        assert.equal(ledger.authorization.accepted_amount_minor, 0)
        assert.equal(ledger.binding.status, 'released')
      }
      const evidence = context.db.prepare('SELECT * FROM bet_reconciliation_evidence').all()
      assert.equal(evidence.length, decision === 'accepted' ? 2 : 1)
      const finalEvidence = evidence.find((row) => row.decision === decision)
      assert.equal(finalEvidence.source, decision === 'accepted' ? 'today_wagers' : 'get_dangerous')
      assert.match(finalEvidence.payload_hash, /^[0-9a-f]{64}$/)
      assert.equal(JSON.stringify(evidence).includes(rawMarker), false)

      const resolvedSnapshot = ledgerSnapshot(context.db)
      const second = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
      assert.equal(second.status, 'resolved')
      assert.equal(sourceCalls, decision === 'accepted' ? 2 : 1)
      assert.deepEqual(ledgerSnapshot(context.db), resolvedSnapshot)
      assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, evidence.length)
      assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_notification_outbox').get().count, decision === 'accepted' ? 1 : 0)
      context.handle.close()
    })
  }
})

test('a fault inside strong-evidence resolution rolls back the entire betting ledger and evidence', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const before = ledgerSnapshot(context.db)
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return strongDecision('accepted', { result: 'accepted' }) },
    async getTodayWagers() { return null },
  }, {
    faultInjector(phase) {
      if (phase === 'reconcile:after-child-update') throw new Error('fault:reconcile:after-child-update')
    },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:02:00.000Z',
  })

  await assert.rejects(
    () => reconciler.runDue({ submitAttemptId: 'attempt-reconcile' }),
    /fault:reconcile:after-child-update/,
  )
  assert.deepEqual(ledgerSnapshot(context.db), before)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 0)
  context.handle.close()
})

test('accepted reconciliation preserves every production authorization and runtime stop reason', async () => {
  const { B2Reconciler } = await api()
  for (const reason of ['real_betting_stopped', 'authorization_revoked', 'authorization_expired']) {
    const context = setup()
    const reconciler = makeReconciler(B2Reconciler, context, {
      async getDangerous() { return strongDecision('accepted', { reason }) },
      async getTodayWagers() { throw new Error('must-not-run') },
    })
    reconciler.scheduleUnknown({ submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:02:00.000Z' })
    context.db.prepare('UPDATE bet_batches SET finish_reason=?').run(reason)
    const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
    const ledger = ledgerSnapshot(context.db)
    assert.equal(result.finalStatus, 'accepted')
    assert.equal(ledger.batch.status, 'completed')
    assert.equal(ledger.batch.accepted_amount_minor, 20)
    assert.equal(ledger.batch.finish_reason, reason)
    context.handle.close()
  }
})

test('weak, multiple, and absent matches preserve unknown without false acceptance', async (t) => {
  const { B2Reconciler } = await api()
  const cases = [
    {
      name: 'weak',
      result: { decision: 'accepted', matchStrength: 'weak', matchCount: 1, payload: { result: 'possible' } },
      evidenceCount: 1,
    },
    {
      name: 'multiple',
      result: { decision: 'accepted', matchStrength: 'strong', matchCount: 2, payload: { result: 'ambiguous' } },
      evidenceCount: 1,
    },
    { name: 'absent', result: null, evidenceCount: 0 },
  ]
  for (const current of cases) {
    await t.test(current.name, async () => {
      const context = setup()
      const reconciler = makeReconciler(B2Reconciler, context, {
        async getDangerous() { return current.result },
        async getTodayWagers() { return null },
      })
      reconciler.scheduleUnknown({
        submitAttemptId: 'attempt-reconcile',
        deadlineAt: '2026-07-11T00:02:00.000Z',
      })

      const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })

      assert.equal(result.status, 'waiting')
      assertStillUnknown(context.db)
      assert.equal(reconciliationState(context.db).poll_count, 1)
      assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, current.evidenceCount)
      if (current.evidenceCount) {
        assert.equal(context.db.prepare('SELECT decision FROM bet_reconciliation_evidence').get().decision, 'unknown')
      }
      context.handle.close()
    })
  }
})

test('manual resolution requires operator and evidence and stores only append-only hash plus server time', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return null },
    async getTodayWagers() { return null },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  context.db.prepare(`
    UPDATE bet_reconciliation_state SET status='manual_review'
    WHERE submit_attempt_id='attempt-reconcile'
  `).run()
  const before = ledgerSnapshot(context.db)
  const evidencePayload = { caseId: 'case-7', note: 'sensitive-manual-evidence-marker' }

  assert.throws(() => reconciler.resolveManually({
    submitAttemptId: 'attempt-reconcile',
    decision: 'accepted',
    operatorId: '',
    evidencePayload,
  }), /manual-operator-required/)
  assert.throws(() => reconciler.resolveManually({
    submitAttemptId: 'attempt-reconcile',
    decision: 'accepted',
    operatorId: 'operator-1',
  }), /manual-evidence-required/)
  assert.deepEqual(ledgerSnapshot(context.db), before)

  const result = reconciler.resolveManually({
    submitAttemptId: 'attempt-reconcile',
    decision: 'accepted',
    operatorId: 'operator-1',
    evidencePayload,
    providerReferenceCiphertext: PROVIDER_REFERENCE_CIPHERTEXT,
  })
  assert.equal(result.finalStatus, 'accepted')
  const evidence = context.db.prepare('SELECT * FROM bet_reconciliation_evidence').get()
  assert.equal(evidence.source, 'manual')
  assert.equal(evidence.decision, 'accepted')
  assert.equal(evidence.operator_id, 'operator-1')
  assert.equal(evidence.observed_at, BASE_TIME)
  assert.equal(evidence.payload_hash, payloadHash(evidencePayload))
  assert.equal(Object.keys(evidence).some((key) => /payload.*json|raw/i.test(key)), false)
  assert.equal(JSON.stringify(evidence).includes('sensitive-manual-evidence-marker'), false)
  assert.throws(() => context.db.prepare("UPDATE bet_reconciliation_evidence SET operator_id = 'operator-2'").run(), /immutable/i)
  assert.throws(() => context.db.prepare('DELETE FROM bet_reconciliation_evidence').run(), /immutable/i)
  context.handle.close()
})

test('source failures become stable redacted errors and keep the unknown schedule retryable', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const rawMarker = 'sensitive-source-error-marker'
  const calls = []
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { calls.push('get_dangerous'); throw new Error(`transport failed ${rawMarker}`) },
    async getTodayWagers() { calls.push('today_wagers'); throw new Error(`response failed ${rawMarker}`) },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile',
    deadlineAt: '2026-07-11T00:02:00.000Z',
  })

  const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })

  assert.deepEqual(calls, ['get_dangerous', 'today_wagers'])
  assert.equal(result.errorCode, 'reconciliation-sources-unavailable')
  assert.equal(result.status, 'waiting')
  assert.equal(reconciliationState(context.db).poll_count, 1)
  assert.equal(reconciliationState(context.db).next_poll_at, '2026-07-11T00:00:05.000Z')
  assert.equal(ledgerSnapshot(context.db).attempt.error_code, 'reconciliation-sources-unavailable')
  assertStillUnknown(context.db)
  const auditText = context.db.prepare('SELECT action, details_json FROM execution_security_audit').all()
    .map((row) => `${row.action}:${row.details_json}`).join('\n')
  assert.equal(auditText.includes(rawMarker), false)
  assert.equal(JSON.stringify(result).includes(rawMarker), false)
  context.handle.close()
})

test('a lease takeover between source evidence and BEGIN cannot resolve the ledger', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const before = ledgerSnapshot(context.db)
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return strongDecision('accepted') },
    async getTodayWagers() { return null },
  }, {
    faultInjector(phase) {
      if (phase !== 'reconcile:before-transaction') return
      context.db.prepare(`
        UPDATE runtime_leases
        SET owner_id='takeover-owner', fencing_token=fencing_token+1,
            expires_at='2026-07-11T01:00:00.000Z'
        WHERE lease_key=?
      `).run(context.lease.leaseKey)
    },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  await assert.rejects(() => reconciler.runDue({ submitAttemptId: 'attempt-reconcile' }), /executor-fence-stale/)
  assert.deepEqual(ledgerSnapshot(context.db), before)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 0)
  context.handle.close()
})

test('a lease expiring between source evidence and BEGIN cannot resolve the ledger', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const before = ledgerSnapshot(context.db)
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return strongDecision('accepted') },
    async getTodayWagers() { return null },
  }, {
    faultInjector(phase) {
      if (phase === 'reconcile:before-transaction') context.clock.advance(601)
    },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T01:00:00.000Z',
  })
  await assert.rejects(() => reconciler.runDue({ submitAttemptId: 'attempt-reconcile' }), /executor-fence-stale/)
  assert.deepEqual(ledgerSnapshot(context.db), before)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 0)
  context.handle.close()
})

test('a response arriving at the deadline remains unknown and moves to manual review', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() {
      context.clock.advance(10)
      return strongDecision('accepted')
    },
    async getTodayWagers() { return null },
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:00:10.000Z',
  })
  const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.equal(result.status, 'manual_review')
  assertStillUnknown(context.db)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 0)
  context.handle.close()
})

test('rejected evidence is terminal unfilled even when a capacity callback says more accounts exist', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return strongDecision('rejected') },
    async getTodayWagers() { return null },
  }, { hasFutureCapacity: () => true })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.equal(ledgerSnapshot(context.db).batch.status, 'failed')
  context.handle.close()
})

test('manual resolution requires an authenticated authorizer and manual-review state', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  const reconciler = makeReconciler(B2Reconciler, context, {
    async getDangerous() { return null },
    async getTodayWagers() { return null },
  }, { manualAuthorizer: null })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  assert.throws(() => reconciler.resolveManually({
    submitAttemptId: 'attempt-reconcile', decision: 'rejected',
    operatorId: 'self-reported', evidencePayload: { caseId: 'case' },
  }), /manual-resolution-unauthorized/)
  assertStillUnknown(context.db)
  context.handle.close()
})

test('production capability-unverified reconciliation defers safely without source network', async () => {
  const { B2Reconciler } = await api()
  const context = setup()
  let networkCalls = 0
  const reconciler = new B2Reconciler({
    database: context.db,
    lease: context.lease,
    sourceClient: {
      async getDangerous() { networkCalls += 1; return strongDecision('accepted') },
      async getTodayWagers() { networkCalls += 1; return strongDecision('accepted') },
    },
    now: context.clock.now,
  })
  reconciler.scheduleUnknown({
    submitAttemptId: 'attempt-reconcile', deadlineAt: '2026-07-11T00:02:00.000Z',
  })
  const result = await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' })
  assert.equal(result.status, 'waiting')
  assert.equal(result.pollCount, 1)
  assert.equal(result.nextPollAt, '2026-07-11T00:00:05.000Z')
  assert.equal(result.errorCode, 'reconciliation-capability-unverified')
  assert.throws(() => reconciler.resolveManually({}), /manual-resolution-unavailable/)
  assert.equal(networkCalls, 0)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_reconciliation_evidence').get().count, 0)
  assert.equal(context.db.prepare("SELECT error_code FROM bet_submit_attempts WHERE submit_attempt_id='attempt-reconcile'").get().error_code, 'reconciliation-capability-unverified')
  assertStillUnknown(context.db)
  context.clock.set('2026-07-11T00:02:00.000Z')
  assert.deepEqual(await reconciler.runDue({ submitAttemptId: 'attempt-reconcile' }), { status: 'manual_review' })
  assert.equal(networkCalls, 0)
  context.handle.close()
})
