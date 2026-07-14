import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { encryptSecret } from '../src/crown/app/app-secret.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { CrownAccountExecutionProvider } from '../src/crown/betting/crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from '../src/crown/betting/crown-account-provider.mjs'
import {
  authorizeExecution,
  recoverAuthorizedChildOrders,
  reserveAuthorizationBudget,
  resolveAuthorizedChildOrder,
} from '../src/crown/betting/execution-gate.mjs'

const BASE_TIME = '2026-07-11T00:00:00.000Z'
const LATER_TIME = '2026-07-11T00:00:02.000Z'
const PROVIDER_REFERENCE_KEY = 'b2-executor-provider-reference-test-key'
const B2_MODULE = '../src/crown/betting/b2-executor.mjs'
const b2Module = import(B2_MODULE)

const LOCKED_IDENTITY = Object.freeze({
  provider: 'fixture',
  gid: '8878933',
  mode: 'live',
  period: 'full_time',
  market: 'asian_handicap',
  lineVariant: 'main',
  line: '-0 / 0.5',
  side: 'home',
})
const PERSISTED_ENVELOPE = Object.freeze({
  provider: 'crown', eventKey: 'crown|football|gid=8878933', period: 'full_time',
  marketType: 'asian_handicap', lineKey: 'ah:ft:-0.25', side: 'home',
  selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|ah:ft:-0.25|home',
  snapshot: {
    provider: 'crown', mode: 'live',
    event: { eventKey: 'crown|football|gid=8878933', ids: { gid: '8878933' } },
    market: { period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main', lineKey: 'ah:ft:-0.25', handicapRaw: '-0 / 0.5' },
    selection: { side: 'home', selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|ah:ft:-0.25|home' },
  },
})
const PROVIDER_REFERENCE_CIPHERTEXT = encryptSecret('provider-reference', {
  secretKey: PROVIDER_REFERENCE_KEY,
  context: {
    purpose: 'crown-provider-reference',
    childOrderId: 'child-real',
    submitAttemptId: 'submit-child-real-1',
  },
})

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-b2-executor-')), 'crown.sqlite')
}

function realEnv() {
  return {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '2',
    CROWN_REAL_MAX_TOTAL_MINOR: '100',
  }
}

function optionsAt(at = BASE_TIME, overrides = {}) {
  return {
    env: realEnv(),
    now: () => new Date(at),
    secretKey: PROVIDER_REFERENCE_KEY,
    ...overrides,
  }
}

function insertRule(db, ruleId = 'rule-real') {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, monitor_enabled, real_betting_enabled,
      migration_review_required, archived, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES (?, ?, 1, 'real_eligible', 1, 1, 0, 0, 'CNY', 2, 20, ?, ?)
  `).run(ruleId, ruleId, BASE_TIME, BASE_TIME)
}

function insertAccount(db, accountId = 'account-real') {
  db.prepare(`
    INSERT INTO betting_accounts (
      id, label, username, status, archived, currency, amount_scale,
      per_bet_limit_minor, stake_step_minor, created_at, updated_at
    ) VALUES (?, ?, ?, 'enabled', 0, 'CNY', 2, 50, 1, ?, ?)
  `).run(accountId, accountId, accountId, BASE_TIME, BASE_TIME)
}

function insertBatchAndChild(db, {
  batchId = 'batch-real',
  childOrderId = 'child-real',
  accountId = 'account-real',
  ruleId = 'rule-real',
  amountMinor = 20,
  fencingToken = 1,
} = {}) {
  const signalId = `signal-${batchId}`
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (?, ?, 'b2-red-test', 1, 'ready', ?, ?, '{}')
  `).run(signalId, signalId, BASE_TIME, '2026-07-11T01:00:00.000Z')
  db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, locked_selection_identity, rule_snapshot_json,
      currency, amount_scale, target_amount_minor, unfilled_amount_minor,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'CNY', 2, ?, ?, 'queued', ?)
  `).run(batchId, signalId, ruleId, PERSISTED_ENVELOPE.selectionIdentity,
    JSON.stringify({
      rule: { changedOddsMin: '0.75', changedOddsMax: '1.18' },
      lockedSelection: PERSISTED_ENVELOPE,
    }), amountMinor, amountMinor, BASE_TIME)
  db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor, preview_balance_minor,
      preview_stake_step_minor, preview_odds, status, created_at
    ) VALUES (?, ?, ?, ?, 10, 50, 100, 1, '0.83', 'reserved', ?)
  `).run(childOrderId, batchId, accountId, amountMinor, BASE_TIME)
  db.prepare(`
    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token,
      acquired_at, updated_at
    ) VALUES (?, ?, ?, 'reserved', ?, ?, ?)
  `).run(accountId, childOrderId, batchId, fencingToken, BASE_TIME, BASE_TIME)
  return { batchId, childOrderId, accountId, ruleId, amountMinor }
}

function acquireLease(db, {
  ownerId = 'executor-one',
  at = BASE_TIME,
  ttlMs = 1_000,
  leaseKey = 'betting-executor:b2-test',
} = {}) {
  const lease = new RuntimeLease({
    db,
    leaseKey,
    ownerId,
    pid: ownerId === 'executor-one' ? 1 : 2,
    ttlMs,
    now: () => new Date(at),
  })
  lease.acquire()
  return lease
}

function setup({ dbPath = ':memory:' } = {}) {
  const handle = openAppDatabase({ dbPath })
  insertRule(handle.db)
  insertAccount(handle.db)
  const lease = acquireLease(handle.db)
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'auth-real',
    currency: 'CNY',
    amountScale: 2,
    ruleIds: ['rule-real'],
    maxTotalAmountMinor: 100,
    confirmation: 'AUTHORIZE REAL EXECUTION',
  }, optionsAt())
  const child = insertBatchAndChild(handle.db, { fencingToken: lease.fencingToken })
  reserveAuthorizationBudget(handle.db, {
    authorizationId: authorization.authorizationId,
    ruleId: child.ruleId,
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    childOrderId: child.childOrderId,
    batchId: child.batchId,
    accountId: child.accountId,
    amountMinor: child.amountMinor,
  }, optionsAt())
  return { handle, db: handle.db, lease, authorization, child, dbPath }
}

function setupUnbound() {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db)
  handle.db.prepare("UPDATE betting_rules SET amount_scale=0,target_amount_minor=20 WHERE id='rule-real'").run()
  insertAccount(handle.db)
  handle.db.prepare("UPDATE betting_accounts SET amount_scale=0,allocation_status='enabled' WHERE id='account-real'").run()
  const lease = acquireLease(handle.db)
  const child = insertBatchAndChild(handle.db, { fencingToken: lease.fencingToken })
  handle.db.prepare("UPDATE bet_batches SET amount_scale=0 WHERE batch_id=?").run(child.batchId)
  return { handle, db: handle.db, lease, child }
}

function gateInput(context) {
  return {
    authorizationId: context.authorization.authorizationId,
    ruleId: context.child.ruleId,
    leaseKey: context.lease.leaseKey,
    executorOwnerId: context.lease.ownerId,
    fencingToken: context.lease.fencingToken,
    childOrderId: context.child.childOrderId,
    batchId: context.child.batchId,
    accountId: context.child.accountId,
  }
}

function previewInput({ odds = '0.83', identity = LOCKED_IDENTITY } = {}) {
  return {
    capabilityEvidenceId: 'fixture:b2-ledger:offline:v1',
    capabilityVersion: 'b2-ledger-fixture-v1',
    lockedIdentity: structuredClone(LOCKED_IDENTITY),
    currentIdentity: structuredClone(identity),
    preview: {
      minStakeMinor: 10,
      maxStakeMinor: 50,
      balanceMinor: 100,
      stakeStepMinor: 1,
      odds,
      line: identity.line,
    },
  }
}

function prepareInput(context, ordinal = 1, overrides = {}) {
  return {
    ...gateInput(context),
    submitAttemptId: `submit-${context.child.childOrderId}-${ordinal}`,
    attemptOrdinal: ordinal,
    ...previewInput(overrides),
  }
}

function childRow(db, childOrderId = 'child-real') {
  return db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(childOrderId)
}

function batchRow(db, batchId = 'batch-real') {
  return db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
}

function authRow(db, authorizationId = 'auth-real') {
  return db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorizationId)
}

function bindingRow(db, childOrderId = 'child-real') {
  return db.prepare('SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(childOrderId)
}

function lockRow(db, childOrderId = 'child-real') {
  return db.prepare('SELECT * FROM betting_account_locks WHERE child_order_id = ?').get(childOrderId)
}

function attemptRows(db, childOrderId = 'child-real') {
  return db.prepare(`
    SELECT * FROM bet_submit_attempts
    WHERE child_order_id = ?
    ORDER BY attempt_ordinal
  `).all(childOrderId)
}

function ledgerSnapshot(db) {
  return {
    child: db.prepare('SELECT * FROM bet_child_orders ORDER BY child_order_id').all(),
    batch: db.prepare('SELECT * FROM bet_batches ORDER BY batch_id').all(),
    authorization: db.prepare('SELECT * FROM execution_authorizations ORDER BY authorization_id').all(),
    binding: db.prepare('SELECT * FROM execution_authorization_child_budgets ORDER BY child_order_id').all(),
    lock: db.prepare('SELECT * FROM betting_account_locks ORDER BY account_id').all(),
    attempts: db.prepare('SELECT * FROM bet_submit_attempts ORDER BY child_order_id, attempt_ordinal').all(),
  }
}

async function api() {
  const value = await b2Module
  for (const name of [
    'prepareAuthorizedSubmit',
    'recordAuthorizedDispatch',
    'recordAuthorizedOutcome',
    'recoverAuthorizedAttempt',
    'recoverAuthorizedAttempts',
  ]) assert.equal(typeof value[name], 'function', `missing B2 export: ${name}`)
  return value
}

test('prepareAuthorizedSubmit commits gate, attempt, child, batch, and lock as one transaction', async () => {
  const { prepareAuthorizedSubmit } = await api()
  const context = setup()

  const result = prepareAuthorizedSubmit(context.db, prepareInput(context), optionsAt())

  assert.equal(result.child.status, 'submit_prepared')
  assert.equal(result.attempt.status, 'submit_prepared')
  assert.equal(result.attempt.attemptOrdinal, 1)
  assert.equal(childRow(context.db).status, 'submit_prepared')
  assert.equal(childRow(context.db).submit_attempt_id, 'submit-child-real-1')
  assert.equal(batchRow(context.db).status, 'submitting')
  assert.equal(batchRow(context.db).reserved_amount_minor, 20)
  assert.equal(authRow(context.db).reserved_amount_minor, 20)
  assert.equal(bindingRow(context.db).status, 'reserved')
  assert.equal(lockRow(context.db).status, 'submitting')
  assert.deepEqual(attemptRows(context.db).map((row) => ({
    id: row.submit_attempt_id,
    ordinal: row.attempt_ordinal,
    status: row.status,
  })), [{ id: 'submit-child-real-1', ordinal: 1, status: 'submit_prepared' }])
  context.handle.close()
})

test('prepare uses the current strict Preview step instead of the legacy account step', async () => {
  const { prepareAuthorizedSubmit } = await api()
  const context = setup()
  const input = prepareInput(context)
  input.preview.stakeStepMinor = 10

  const result = prepareAuthorizedSubmit(context.db, input, optionsAt())

  assert.equal(result.child.status, 'submit_prepared')
  assert.equal(childRow(context.db).preview_stake_step_minor, 10)
  assert.equal(context.db.prepare("SELECT stake_step_minor FROM betting_accounts WHERE id='account-real'").get().stake_step_minor, 1)
  context.handle.close()
})

test('prepare rejects a fresh Preview odds value outside the frozen rule range before creating an attempt', async () => {
  const { prepareAuthorizedSubmit } = await api()
  const context = setup()

  assert.throws(
    () => prepareAuthorizedSubmit(context.db, prepareInput(context, 1, { odds: '1.19' }), optionsAt()),
    /preview-odds-out-of-range/,
  )
  assert.equal(attemptRows(context.db).length, 0)
  assert.equal(childRow(context.db).status, 'reserved')
  context.handle.close()
})

test('B2 continuously rechecks canonical real switch and persisted batch rule version before prepare', async () => {
  const { prepareAuthorizedSubmit } = await api()
  const switchedOff = setup()
  switchedOff.db.prepare("UPDATE betting_rules SET real_betting_enabled=0 WHERE id='rule-real'").run()
  assert.throws(() => prepareAuthorizedSubmit(switchedOff.db, prepareInput(switchedOff), optionsAt()), /rule-real-disabled/)
  switchedOff.handle.close()

  const versionChanged = setup()
  versionChanged.db.prepare("UPDATE betting_rules SET monitor_enabled=1,real_betting_enabled=1,migration_review_required=0,version=version+1 WHERE id='rule-real'").run()
  assert.throws(() => prepareAuthorizedSubmit(versionChanged.db, prepareInput(versionChanged), optionsAt()), /rule-version-changed/)
  versionChanged.handle.close()
})

test('prepare invalidates an authorization when its persisted hard cap or time window no longer matches', async () => {
  const { prepareAuthorizedSubmit } = await api()
  for (const mutation of [
    "UPDATE execution_authorizations SET hard_cap_amount_minor=99 WHERE authorization_id='auth-real'",
    "UPDATE execution_authorizations SET expires_at='corrupt' WHERE authorization_id='auth-real'",
  ]) {
    const context = setup()
    context.db.exec(mutation)
    assert.throws(() => prepareAuthorizedSubmit(context.db, prepareInput(context), optionsAt()),
      /authorization-(?:environment-mismatch|expired)/)
    assert.equal(attemptRows(context.db).length, 0)
    assert.equal(childRow(context.db).status, 'reserved')
    context.handle.close()
  }
})

test('prepareAuthorizedSubmit rolls back every durable ledger when a fault lands inside prepare', async (t) => {
  const { prepareAuthorizedSubmit } = await api()
  for (const phase of [
    'prepare:after-attempt-insert',
    'prepare:after-child-update',
    'prepare:after-lock-update',
    'prepare:after-batch-recompute',
  ]) {
    await t.test(phase, () => {
      const context = setup()
      const before = ledgerSnapshot(context.db)
      assert.throws(() => prepareAuthorizedSubmit(context.db, prepareInput(context), optionsAt(BASE_TIME, {
        faultInjector(current) {
          if (current === phase) throw new Error(`fault:${phase}`)
        },
      })), new RegExp(`fault:${phase}`))
      assert.deepEqual(ledgerSnapshot(context.db), before)
      context.handle.close()
    })
  }
})

test('the child is prepared before Provider entry and dispatched only after the network call begins', async () => {
  const { prepareAuthorizedSubmit, recordAuthorizedDispatch } = await api()
  const context = setup()
  const attempt = prepareInput(context)
  prepareAuthorizedSubmit(context.db, attempt, optionsAt())
  let providerCalls = 0

  async function fakeProviderSubmit({ onNetworkStarted }) {
    assert.equal(childRow(context.db).status, 'submit_prepared')
    assert.equal(attemptRows(context.db)[0].status, 'submit_prepared')
    providerCalls += 1
    onNetworkStarted()
    assert.equal(childRow(context.db).status, 'submit_dispatched')
    assert.equal(attemptRows(context.db)[0].status, 'submit_dispatched')
    return { kind: 'accepted' }
  }

  await fakeProviderSubmit({
    onNetworkStarted() {
      recordAuthorizedDispatch(context.db, {
        ...gateInput(context),
        submitAttemptId: attempt.submitAttemptId,
      }, optionsAt())
    },
  })
  assert.equal(providerCalls, 1)
  assert.equal(lockRow(context.db).status, 'submitting')
  context.handle.close()
})

test('production B2Executor rejects caller-supplied fake preview or execution providers', async () => {
  const { B2Executor } = await api()
  const context = setup()
  assert.throws(() => new B2Executor({
    database: context.db,
    previewProvider: { preview: async () => ({ realExecutionEligible: true }) },
    executionProvider: { submit: async () => ({ kind: 'accepted' }) },
    lease: context.lease,
  }), /b2-preview-provider/)
  assert.equal(attemptRows(context.db).length, 0)
  context.handle.close()
})

test('production B2Executor refuses a parsed Preview response without an evidence-complete executionPreview', async () => {
  const { B2Executor } = await api()
  const context = setupUnbound()
  const previewProvider = Object.create(CrownAccountPreviewProvider.prototype)
  previewProvider.preview = async () => ({
    ...previewInput(),
    freshBalanceCny: 100,
  })
  let submitCalls = 0
  const executionProvider = Object.create(CrownAccountExecutionProvider.prototype)
  executionProvider.submit = async () => {
    submitCalls += 1
    return { kind: 'pending' }
  }
  const executor = new B2Executor({
    database: context.db,
    previewProvider,
    executionProvider,
    lease: context.lease,
    env: realEnv(),
    now: () => new Date(BASE_TIME),
  })

  await assert.rejects(() => executor.submit({
    ruleId: context.child.ruleId,
    batchId: context.child.batchId,
    childOrderId: context.child.childOrderId,
    accountId: context.child.accountId,
    submitAttemptId: 'submit-child-real-1',
    attemptOrdinal: 1,
    lockedSelection: PERSISTED_ENVELOPE,
  }), /preview-execution-contract/)
  assert.equal(submitCalls, 0)
  assert.equal(attemptRows(context.db).length, 0)
  context.handle.close()
})

test('production B2Executor passes the persisted child amount and locked selection to one provider attempt', async () => {
  const { B2Executor } = await api()
  const context = setupUnbound()
  const previewProvider = Object.create(CrownAccountPreviewProvider.prototype)
  previewProvider.preview = async () => ({
    executionPreview: {
      minStakeMinor: 10, maxStakeMinor: 50, stakeStepMinor: 1,
      odds: '0.83', line: LOCKED_IDENTITY.line, currency: 'CNY', amountScale: 0,
    },
    freshBalanceCny: 100,
    lockedIdentity: structuredClone(LOCKED_IDENTITY),
    capabilityEvidenceId: 'fixture:b2-ledger:offline:v1',
    capabilityVersion: 'b2-ledger-fixture-v1',
  })
  let submitted = null
  const executionProvider = Object.create(CrownAccountExecutionProvider.prototype)
  executionProvider.submit = async (input) => {
    submitted = structuredClone({ ...input, onNetworkStarted: undefined })
    input.onNetworkStarted()
    return { kind: 'pending' }
  }
  const executor = new B2Executor({
    database: context.db,
    previewProvider,
    executionProvider,
    lease: context.lease,
    env: realEnv(),
    now: () => new Date(BASE_TIME),
  })
  const result = await executor.submit({
    ruleId: context.child.ruleId,
    batchId: context.child.batchId,
    childOrderId: context.child.childOrderId,
    accountId: context.child.accountId,
    submitAttemptId: 'submit-child-real-1',
    attemptOrdinal: 1,
    lockedSelection: PERSISTED_ENVELOPE,
  })
  assert.equal(result.child.status, 'unknown')
  assert.equal(submitted.amountMinor, context.child.amountMinor)
  assert.equal(submitted.remainingChildAmountMinor, context.child.amountMinor)
  assert.deepEqual(submitted.lockedSelection, PERSISTED_ENVELOPE)
  assert.equal(submitted.preview.balanceMinor, 100)
  assert.equal(attemptRows(context.db).length, 1)
  context.handle.close()
})

test('neutral B2 ledger executes without authorization rows while preserving attempt, fence, and lock semantics', async () => {
  const { prepareSubmitAttempt, recordSubmitDispatch, recordSubmitOutcome } = await api()
  const context = setupUnbound()
  const gate = {
    ruleId: context.child.ruleId,
    leaseKey: context.lease.leaseKey,
    executorOwnerId: context.lease.ownerId,
    fencingToken: context.lease.fencingToken,
    childOrderId: context.child.childOrderId,
    batchId: context.child.batchId,
    accountId: context.child.accountId,
  }
  const attempt = {
    ...gate,
    submitAttemptId: 'submit-child-real-1',
    attemptOrdinal: 1,
    ...previewInput(),
  }

  prepareSubmitAttempt(context.db, attempt, optionsAt())
  recordSubmitDispatch(context.db, { ...gate, submitAttemptId: attempt.submitAttemptId }, optionsAt())
  recordSubmitOutcome(context.db, {
    ...gate,
    submitAttemptId: attempt.submitAttemptId,
    outcome: { kind: 'accepted', providerReferenceCiphertext: PROVIDER_REFERENCE_CIPHERTEXT },
    hasFutureCapacity: false,
  }, optionsAt())

  assert.equal(childRow(context.db).status, 'accepted')
  assert.equal(attemptRows(context.db)[0].authorization_id, null)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM execution_authorizations').get().count, 0)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count, 0)
  assert.equal(lockRow(context.db), undefined)
  context.handle.close()
})

test('only accepted and rejected are definite after dispatch; every other provider outcome locks unknown', async (t) => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recordAuthorizedOutcome,
  } = await api()
  const cases = [
    { kind: 'accepted', child: 'accepted', attempt: 'accepted', batch: 'completed', binding: 'accepted', accepted: 20, unknown: 0, lock: null },
    { kind: 'rejected', child: 'rejected', attempt: 'rejected', batch: 'failed', binding: 'released', accepted: 0, unknown: 0, lock: null },
    { kind: 'timeout', child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown' },
    { kind: 'disconnect', child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown' },
    { kind: 'pending', child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown' },
    { kind: 'odds_changed_unsent', child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown' },
    {
      kind: 'line_changed',
      outcome: { kind: 'line_changed', currentIdentity: { ...LOCKED_IDENTITY, line: '0 / 0.5' } },
      child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown',
    },
    { kind: 'unclassified', child: 'unknown', attempt: 'unknown', batch: 'waiting_result', binding: 'unknown', accepted: 0, unknown: 20, lock: 'unknown' },
  ]

  for (const expected of cases) {
    await t.test(expected.kind, () => {
      const context = setup()
      const attempt = prepareInput(context)
      prepareAuthorizedSubmit(context.db, attempt, optionsAt())
      recordAuthorizedDispatch(context.db, {
        ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
      }, optionsAt())
      recordAuthorizedOutcome(context.db, {
        ...gateInput(context),
        submitAttemptId: attempt.submitAttemptId,
        outcome: expected.outcome || {
          kind: expected.kind,
          providerReferenceCiphertext: expected.kind === 'accepted' ? PROVIDER_REFERENCE_CIPHERTEXT : '',
        },
        hasFutureCapacity: false,
      }, optionsAt())

      assert.equal(childRow(context.db).status, expected.child)
      assert.equal(attemptRows(context.db)[0].status, expected.attempt)
      assert.equal(batchRow(context.db).status, expected.batch)
      assert.equal(bindingRow(context.db).status, expected.binding)
      assert.equal(authRow(context.db).reserved_amount_minor, 0)
      assert.equal(authRow(context.db).accepted_amount_minor, expected.accepted)
      assert.equal(authRow(context.db).unknown_amount_minor, expected.unknown)
      assert.equal(lockRow(context.db)?.status || null, expected.lock)
      context.handle.close()
    })
  }
})

test('a dispatched order records its definite outcome after authorization or environment changes', async () => {
  const { prepareAuthorizedSubmit, recordAuthorizedDispatch, recordAuthorizedOutcome } = await api()
  const context = setup()
  const attempt = prepareInput(context)
  prepareAuthorizedSubmit(context.db, attempt, optionsAt())
  recordAuthorizedDispatch(context.db, {
    ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
  }, optionsAt())
  context.db.prepare(`
    UPDATE execution_authorizations SET status='revoked', updated_at=?
    WHERE authorization_id=?
  `).run(LATER_TIME, gateInput(context).authorizationId)

  recordAuthorizedOutcome(context.db, {
    ...gateInput(context),
    submitAttemptId: attempt.submitAttemptId,
    outcome: { kind: 'accepted', providerReferenceCiphertext: PROVIDER_REFERENCE_CIPHERTEXT },
    hasFutureCapacity: false,
  }, optionsAt(BASE_TIME, {
    env: {
      CROWN_REAL_CURRENCY: 'USD',
      CROWN_REAL_AMOUNT_SCALE: '0',
      CROWN_REAL_MAX_TOTAL_MINOR: '1',
    },
  }))

  assert.equal(childRow(context.db).status, 'accepted')
  assert.equal(attemptRows(context.db)[0].status, 'accepted')
  assert.equal(bindingRow(context.db).status, 'accepted')
  assert.equal(authRow(context.db).accepted_amount_minor, 20)
  context.handle.close()
})

test('accepted B2 outcome preserves every production in-flight safety reason', async () => {
  const { prepareAuthorizedSubmit, recordAuthorizedDispatch, recordAuthorizedOutcome } = await api()
  for (const reason of ['manual_cancel', 'real_betting_stopped', 'authorization_revoked', 'authorization_expired']) {
    const context = setup()
    const attempt = prepareInput(context)
    prepareAuthorizedSubmit(context.db, attempt, optionsAt())
    recordAuthorizedDispatch(context.db, { ...gateInput(context), submitAttemptId: attempt.submitAttemptId }, optionsAt())
    context.db.prepare('UPDATE bet_batches SET finish_reason=? WHERE batch_id=?').run(reason, context.child.batchId)
    const result = recordAuthorizedOutcome(context.db, { ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
      outcome: { kind: 'accepted', providerReferenceCiphertext: PROVIDER_REFERENCE_CIPHERTEXT }, hasFutureCapacity: false }, optionsAt())
    assert.equal(result.batch.status, 'completed')
    assert.equal(result.batch.acceptedAmountMinor, 20)
    assert.equal(result.batch.finishReason, reason)
    context.handle.close()
  }
})

test('recordAuthorizedOutcome rolls back child, batch, authorization, lock, binding, and attempt together', async (t) => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recordAuthorizedOutcome,
  } = await api()
  for (const phase of [
    'outcome:after-attempt-update',
    'outcome:after-child-update',
    'outcome:after-batch-recompute',
    'outcome:after-authorization-update',
  ]) {
    await t.test(phase, () => {
      const context = setup()
      const attempt = prepareInput(context)
      prepareAuthorizedSubmit(context.db, attempt, optionsAt())
      recordAuthorizedDispatch(context.db, {
        ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
      }, optionsAt())
      const before = ledgerSnapshot(context.db)
      assert.throws(() => recordAuthorizedOutcome(context.db, {
        ...gateInput(context),
        submitAttemptId: attempt.submitAttemptId,
        outcome: { kind: 'accepted', providerReferenceCiphertext: PROVIDER_REFERENCE_CIPHERTEXT },
        hasFutureCapacity: false,
      }, optionsAt(BASE_TIME, {
        faultInjector(current) {
          if (current === phase) throw new Error(`fault:${phase}`)
        },
      })), new RegExp(`fault:${phase}`))
      assert.deepEqual(ledgerSnapshot(context.db), before)
      context.handle.close()
    })
  }
})

test('restart recovery never submits prepared, dispatched, or unknown attempts again', async (t) => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recordAuthorizedOutcome,
    recoverAuthorizedAttempts,
  } = await api()
  for (const startingStatus of ['submit_prepared', 'submit_dispatched', 'unknown']) {
    await t.test(startingStatus, () => {
      const dbPath = tempDbPath()
      const context = setup({ dbPath })
      const attempt = prepareInput(context)
      let ftBetCalls = 0
      prepareAuthorizedSubmit(context.db, attempt, optionsAt())
      if (startingStatus !== 'submit_prepared') {
        ftBetCalls += 1
        recordAuthorizedDispatch(context.db, {
          ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
        }, optionsAt())
      }
      if (startingStatus === 'unknown') {
        recordAuthorizedOutcome(context.db, {
          ...gateInput(context),
          submitAttemptId: attempt.submitAttemptId,
          outcome: { kind: 'pending' },
        }, optionsAt())
      }
      if (startingStatus === 'submit_prepared') {
        context.db.prepare('DELETE FROM betting_account_locks WHERE child_order_id=?').run(context.child.childOrderId)
      }
      const beforeRestartCalls = ftBetCalls
      context.handle.close()

      const reopened = openAppDatabase({ dbPath })
      const takeover = acquireLease(reopened.db, { ownerId: 'executor-two', at: LATER_TIME })
      recoverAuthorizedAttempts(reopened.db, {
        authorizationId: context.authorization.authorizationId,
        leaseKey: takeover.leaseKey,
        executorOwnerId: takeover.ownerId,
        fencingToken: takeover.fencingToken,
      }, optionsAt(LATER_TIME))

      assert.equal(ftBetCalls, beforeRestartCalls)
      assert.equal(childRow(reopened.db).status, 'unknown')
      assert.equal(attemptRows(reopened.db)[0].status, 'unknown')
      assert.equal(batchRow(reopened.db).status, 'waiting_result')
      assert.equal(bindingRow(reopened.db).status, 'unknown')
      assert.equal(authRow(reopened.db).unknown_amount_minor, 20)
      assert.equal(lockRow(reopened.db).status, 'unknown')
      assert.equal(lockRow(reopened.db).fencing_token, takeover.fencingToken)
      reopened.close()
    })
  }
})

test('single-attempt recovery never marks concurrent sibling orders under the same authorization unknown', async () => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recoverAuthorizedAttempt,
  } = await api()
  const context = setup()
  insertAccount(context.db, 'account-sibling')
  const sibling = insertBatchAndChild(context.db, {
    batchId: 'batch-sibling',
    childOrderId: 'child-sibling',
    accountId: 'account-sibling',
    fencingToken: context.lease.fencingToken,
  })
  reserveAuthorizationBudget(context.db, {
    authorizationId: context.authorization.authorizationId,
    ruleId: sibling.ruleId,
    leaseKey: context.lease.leaseKey,
    executorOwnerId: context.lease.ownerId,
    fencingToken: context.lease.fencingToken,
    childOrderId: sibling.childOrderId,
    batchId: sibling.batchId,
    accountId: sibling.accountId,
    amountMinor: sibling.amountMinor,
  }, optionsAt())
  const primaryAttempt = prepareInput(context)
  prepareAuthorizedSubmit(context.db, primaryAttempt, optionsAt())
  const siblingContext = { ...context, child: sibling }
  const siblingAttempt = prepareInput(siblingContext)
  prepareAuthorizedSubmit(context.db, siblingAttempt, optionsAt())
  recordAuthorizedDispatch(context.db, {
    ...gateInput(siblingContext), submitAttemptId: siblingAttempt.submitAttemptId,
  }, optionsAt())

  recoverAuthorizedAttempt(context.db, {
    ...gateInput(context), submitAttemptId: primaryAttempt.submitAttemptId,
  }, optionsAt())

  assert.equal(childRow(context.db, context.child.childOrderId).status, 'unknown')
  assert.equal(childRow(context.db, sibling.childOrderId).status, 'submit_dispatched')
  assert.equal(attemptRows(context.db, sibling.childOrderId)[0].status, 'submit_dispatched')
  assert.equal(bindingRow(context.db, sibling.childOrderId).status, 'reserved')
  context.handle.close()
})

test('legacy execution-gate outcome and recovery APIs cannot mutate a B2 attempt ledger', async () => {
  const { prepareAuthorizedSubmit, recordAuthorizedDispatch } = await api()
  const context = setup()
  const attempt = prepareInput(context)
  prepareAuthorizedSubmit(context.db, attempt, optionsAt())
  recordAuthorizedDispatch(context.db, {
    ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
  }, optionsAt())
  assert.throws(() => resolveAuthorizedChildOrder(context.db, {
    ...gateInput(context), status: 'accepted',
  }, optionsAt()), /b2-attempt-store-bypass/)
  assert.throws(() => recoverAuthorizedChildOrders(context.db, {
    authorizationId: context.authorization.authorizationId,
    leaseKey: context.lease.leaseKey,
    executorOwnerId: context.lease.ownerId,
    fencingToken: context.lease.fencingToken,
  }, optionsAt()), /b2-attempt-store-bypass/)
  assert.equal(childRow(context.db).status, 'submit_dispatched')
  assert.equal(attemptRows(context.db)[0].status, 'submit_dispatched')
  context.handle.close()
})

test('a dispatched odds_changed_unsent result is unknown and cannot create a second attempt', async () => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recordAuthorizedOutcome,
  } = await api()
  const context = setup()
  const first = prepareInput(context, 1)
  prepareAuthorizedSubmit(context.db, first, optionsAt())
  recordAuthorizedDispatch(context.db, {
    ...gateInput(context), submitAttemptId: first.submitAttemptId,
  }, optionsAt())
  recordAuthorizedOutcome(context.db, {
    ...gateInput(context),
    submitAttemptId: first.submitAttemptId,
    outcome: { kind: 'odds_changed_unsent' },
  }, optionsAt())

  assert.equal(childRow(context.db).status, 'unknown')
  assert.equal(batchRow(context.db).status, 'waiting_result')
  assert.equal(authRow(context.db).reserved_amount_minor, 0)
  assert.equal(authRow(context.db).unknown_amount_minor, 20)
  assert.equal(bindingRow(context.db).status, 'unknown')
  assert.equal(lockRow(context.db).status, 'unknown')
  assert.deepEqual(attemptRows(context.db).map((row) => [row.attempt_ordinal, row.status]), [
    [1, 'unknown'],
  ])

  const second = prepareInput(context, 2, { odds: '0.79' })
  assert.throws(() => prepareAuthorizedSubmit(context.db, second, optionsAt()), /submit-attempt-(?:ordinal|limit|state)|authorization-child-not-reserved/)
  assert.deepEqual(attemptRows(context.db).map((row) => [row.attempt_ordinal, row.status]), [[1, 'unknown']])
  context.handle.close()
})

test('stale fencing tokens cannot prepare, dispatch, resolve, or recover attempts', async () => {
  const {
    prepareAuthorizedSubmit,
    recordAuthorizedDispatch,
    recordAuthorizedOutcome,
    recoverAuthorizedAttempts,
  } = await api()
  const context = setup()
  const attempt = prepareInput(context)
  prepareAuthorizedSubmit(context.db, attempt, optionsAt())
  const takeover = acquireLease(context.db, { ownerId: 'executor-two', at: LATER_TIME })

  assert.throws(() => recordAuthorizedDispatch(context.db, {
    ...gateInput(context), submitAttemptId: attempt.submitAttemptId,
  }, optionsAt(LATER_TIME)), /executor-(?:lease|fence|fencing)|fencing-token/)
  assert.throws(() => recordAuthorizedOutcome(context.db, {
    ...gateInput(context), submitAttemptId: attempt.submitAttemptId, outcome: { kind: 'pending' },
  }, optionsAt(LATER_TIME)), /executor-(?:lease|fence|fencing)|fencing-token/)
  assert.throws(() => recoverAuthorizedAttempts(context.db, {
    authorizationId: context.authorization.authorizationId,
    leaseKey: context.lease.leaseKey,
    executorOwnerId: context.lease.ownerId,
    fencingToken: context.lease.fencingToken,
  }, optionsAt(LATER_TIME)), /executor-(?:lease|fence|fencing)|fencing-token/)
  assert.throws(() => prepareAuthorizedSubmit(context.db, {
    ...prepareInput(context, 1),
    submitAttemptId: 'stale-duplicate-attempt',
  }, optionsAt(LATER_TIME)), /executor-(?:lease|fence|fencing)|fencing-token/)

  assert.equal(childRow(context.db).status, 'submit_prepared')
  assert.deepEqual(attemptRows(context.db).map((row) => row.status), ['submit_prepared'])
  assert.equal(takeover.fencingToken, context.lease.fencingToken + 1)
  context.handle.close()
})
