import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import {
  assertExecutionGate,
  authorizeExecution,
  cancelAuthorizedUnsubmitted,
  recoverAuthorizedChildOrders,
  releaseAuthorizationBudget,
  reserveAuthorizationBudget,
  resolveAuthorizedChildOrder,
  resolveAuthorizationBudget,
  revokeAuthorization,
  upgradeRuleRealEligibility,
} from '../src/crown/betting/execution-gate.mjs'

const BASE_TIME = '2026-07-11T00:00:00.000Z'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-execution-gate-')), 'crown.sqlite')
}

function realEnv(overrides = {}) {
  return {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '2',
    CROWN_REAL_MAX_TOTAL_MINOR: '100',
    ...overrides,
  }
}

function insertRule(db, id, { executionMode = 'real_eligible', currency = 'CNY', amountScale = 2 } = {}) {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, monitor_enabled, real_betting_enabled,
      migration_review_required, archived, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES (?, ?, 1, ?, 1, 1, 0, 0, ?, ?, 50, ?, ?)
  `).run(id, id, executionMode, currency, amountScale, BASE_TIME, BASE_TIME)
}

function insertAccount(db, id, { currency = 'CNY', amountScale = 2 } = {}) {
  db.prepare(`
    INSERT INTO betting_accounts (
      id, label, username, status, archived, currency, amount_scale,
      per_bet_limit_minor, stake_step_minor, created_at, updated_at
    ) VALUES (?, ?, ?, 'enabled', 0, ?, ?, 50, 1, ?, ?)
  `).run(id, id, id, currency, amountScale, BASE_TIME, BASE_TIME)
}

function insertBatch(db, batchId, { ruleId = 'rule-real', amountMinor = 100, currency = 'CNY', amountScale = 2 } = {}) {
  const signalId = `signal-${batchId}`
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (?, ?, 'execution-gate-test', 1, 'ready', ?, ?, '{}')
  `).run(signalId, signalId, BASE_TIME, '2026-07-11T01:00:00.000Z')
  db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, currency, amount_scale,
      target_amount_minor, unfilled_amount_minor, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(batchId, signalId, ruleId, currency, amountScale, amountMinor, amountMinor, BASE_TIME)
}

function insertReservedChild(db, {
  childOrderId,
  batchId,
  accountId = `account-${childOrderId}`,
  amountMinor,
  fencingToken = 1,
} = {}) {
  if (!db.prepare('SELECT 1 FROM betting_accounts WHERE id = ?').get(accountId)) insertAccount(db, accountId)
  db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor,
      preview_stake_step_minor, status, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, 1, 'reserved', ?)
  `).run(childOrderId, batchId, accountId, amountMinor, amountMinor, BASE_TIME)
  db.prepare(`
    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at
    ) VALUES (?, ?, ?, 'reserved', ?, ?, ?)
  `).run(accountId, childOrderId, batchId, fencingToken, BASE_TIME, BASE_TIME)
  return { childOrderId, batchId, accountId, amountMinor }
}

function acquireExecutorLease(db, { now = () => new Date(BASE_TIME), ownerId = 'executor-1', ttlMs = 60_000, leaseKey = 'betting-executor:test' } = {}) {
  const lease = new RuntimeLease({
    db,
    leaseKey,
    ownerId,
    pid: 1,
    ttlMs,
    now,
  })
  lease.acquire()
  return lease
}

function authorize(db, overrides = {}, options = {}) {
  return authorizeExecution(db, {
    authorizationId: overrides.authorizationId,
    currency: 'CNY',
    amountScale: 2,
    ruleIds: ['rule-real'],
    maxTotalAmountMinor: 100,
    confirmation: 'AUTHORIZE REAL EXECUTION',
    ...overrides,
  }, {
    env: realEnv(),
    now: () => new Date(BASE_TIME),
    ...options,
  })
}

test('authorization defaults to 15 minutes, caps at 24 hours, stores only a digest, and owns one active slot', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  const second = openAppDatabase({ dbPath })
  const phrase = 'AUTHORIZE REAL EXECUTION'

  assert.throws(() => assertExecutionGate(first.db, {
    authorizationId: 'missing',
    ruleId: 'rule-real',
    leaseKey: 'betting-executor:test',
    executorOwnerId: 'missing-owner',
    fencingToken: 1,
  }, { env: realEnv(), now: () => new Date(BASE_TIME) }), /authorization-required/)

  const authorization = authorizeExecution(first.db, {
    authorizationId: 'auth-default',
    currency: 'CNY',
    amountScale: 2,
    ruleIds: ['rule-real', 'rule-real'],
    maxTotalAmountMinor: 80,
    confirmation: phrase,
  }, { env: realEnv(), now: () => new Date(BASE_TIME) })

  assert.equal(Date.parse(authorization.expiresAt) - Date.parse(authorization.validFrom), 15 * 60_000)
  assert.deepEqual(authorization.ruleIds, ['rule-real'])
  assert.match(authorization.confirmationDigest, /^[a-f0-9]{64}$/)
  assert.notEqual(authorization.confirmationDigest, phrase)
  assert.doesNotMatch(JSON.stringify(first.db.prepare('SELECT * FROM execution_authorizations').all()), new RegExp(phrase))
  assert.throws(() => authorize(second.db, { authorizationId: 'auth-second' }), /authorization-active/)

  revokeAuthorization(first.db, { authorizationId: authorization.authorizationId }, { now: () => new Date(BASE_TIME) })
  const audit = first.db.prepare(`
    SELECT action, confirmation_digest FROM execution_security_audit
    WHERE subject_type = 'execution_authorization' AND subject_id = 'auth-default'
    ORDER BY created_at, audit_id
  `).all()
  assert.deepEqual(audit.map((row) => row.action).sort(), ['execution_authorization_created', 'execution_authorization_revoked'])
  assert.match(audit.find((row) => row.action === 'execution_authorization_created').confirmation_digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(phrase))
  assert.throws(() => authorize(first.db, {
    authorizationId: 'auth-too-long',
    durationMs: 24 * 60 * 60_000 + 1,
  }), /authorization-duration/)
  assert.doesNotThrow(() => authorize(first.db, {
    authorizationId: 'auth-24-hours',
    durationMs: 24 * 60 * 60_000,
  }))

  second.close()
  first.close()
})

test('real eligibility upgrade is separate, confirmed, environment-bound, and independently audited', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-upgrade', { executionMode: 'preview_only' })
  insertRule(handle.db, 'rule-disabled', { executionMode: 'preview_only' })
  handle.db.prepare("UPDATE betting_rules SET enabled = 0 WHERE id = 'rule-disabled'").run()
  insertRule(handle.db, 'rule-wrong-money', { executionMode: 'preview_only', currency: 'USD' })
  insertRule(handle.db, 'rule-over-cap', { executionMode: 'preview_only' })
  handle.db.prepare("UPDATE betting_rules SET target_amount_minor = 101 WHERE id = 'rule-over-cap'").run()
  const confirmation = 'UPGRADE RULE FOR REAL EXECUTION'
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }

  assert.throws(() => upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-upgrade' }, options), /rule-upgrade-confirmation/)
  assert.throws(() => upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-disabled', confirmation }, options), /rule-upgrade-disabled/)
  assert.throws(() => upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-wrong-money', confirmation }, options), /rule-money-mismatch/)
  assert.throws(() => upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-over-cap', confirmation }, options), /rule-target-hard-cap/)

  const upgraded = upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-upgrade', confirmation }, options)
  assert.equal(upgraded.executionMode, 'real_eligible')
  assert.equal(upgraded.version, 2)
  assert.throws(() => upgradeRuleRealEligibility(handle.db, { ruleId: 'rule-upgrade', confirmation }, options), /rule-already-real-eligible/)

  const audit = handle.db.prepare("SELECT * FROM execution_security_audit WHERE subject_id = 'rule-upgrade'").get()
  assert.equal(audit.action, 'rule_real_eligibility_upgraded')
  assert.equal(audit.subject_type, 'betting_rule')
  assert.match(audit.confirmation_digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(handle.db.prepare('SELECT * FROM execution_security_audit').all()), new RegExp(confirmation))

  handle.close()
})

test('execution authorization and reservation require the canonical real rule switches', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-canonical' })
  handle.db.prepare("UPDATE betting_rules SET real_betting_enabled=0 WHERE id='rule-real'").run()
  assert.throws(() => assertExecutionGate(handle.db, {
    authorizationId: authorization.authorizationId, ruleId: 'rule-real',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: realEnv(), now: () => new Date(BASE_TIME) }), /rule-real-disabled/)
  handle.close()
})

test('authorization requires an exact environment triple and an environment change invalidates the active row', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)

  for (const env of [
    realEnv({ CROWN_REAL_CURRENCY: 'cny' }),
    realEnv({ CROWN_REAL_AMOUNT_SCALE: '02' }),
    realEnv({ CROWN_REAL_MAX_TOTAL_MINOR: '0100' }),
    realEnv({ CROWN_REAL_MAX_TOTAL_MINOR: '' }),
  ]) {
    assert.throws(() => authorize(handle.db, { authorizationId: `bad-${Math.random()}` }, { env }), /real-environment/)
  }
  assert.throws(() => authorize(handle.db, { currency: 'USD' }), /authorization-currency/)
  assert.throws(() => authorize(handle.db, { amountScale: 3 }), /authorization-scale/)
  assert.throws(() => authorize(handle.db, { maxTotalAmountMinor: 101 }), /authorization-hard-cap/)

  const authorization = authorize(handle.db, { authorizationId: 'auth-env', maxTotalAmountMinor: 80 })
  insertBatch(handle.db, 'batch-env-invalid', { amountMinor: 10 })
  const envChild = insertReservedChild(handle.db, { childOrderId: 'child-env-invalid', batchId: 'batch-env-invalid', amountMinor: 10 })
  reserveAuthorizationBudget(handle.db, {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    ...envChild,
  }, { env: realEnv(), now: () => new Date(BASE_TIME) })
  assert.throws(() => assertExecutionGate(handle.db, {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }, {
    env: realEnv({ CROWN_REAL_MAX_TOTAL_MINOR: '101' }),
    now: () => new Date(BASE_TIME),
  }), /authorization-environment-mismatch/)
  assert.equal(handle.db.prepare("SELECT status FROM execution_authorizations WHERE authorization_id = 'auth-env'").get().status, 'revoked')
  assert.equal(handle.db.prepare("SELECT reserved_amount_minor FROM execution_authorizations WHERE authorization_id = 'auth-env'").get().reserved_amount_minor, 0)
  assert.equal(handle.db.prepare("SELECT status FROM bet_child_orders WHERE child_order_id = 'child-env-invalid'").get().status, 'cancelled')

  handle.close()

  for (const changedEnv of [
    realEnv({ CROWN_REAL_CURRENCY: 'USD' }),
    realEnv({ CROWN_REAL_AMOUNT_SCALE: '3' }),
  ]) {
    const changed = openAppDatabase({ dbPath: ':memory:' })
    insertRule(changed.db, 'rule-real')
    const changedLease = acquireExecutorLease(changed.db)
    const active = authorize(changed.db, { authorizationId: `auth-${changedEnv.CROWN_REAL_CURRENCY}-${changedEnv.CROWN_REAL_AMOUNT_SCALE}` })
    assert.throws(() => assertExecutionGate(changed.db, {
      authorizationId: active.authorizationId,
      ruleId: 'rule-real',
      leaseKey: changedLease.leaseKey,
      executorOwnerId: changedLease.ownerId,
      fencingToken: changedLease.fencingToken,
    }, { env: changedEnv, now: () => new Date(BASE_TIME) }), /authorization-environment-mismatch/)
    assert.equal(changed.db.prepare('SELECT status FROM execution_authorizations WHERE authorization_id = ?').get(active.authorizationId).status, 'revoked')
    changed.close()
  }
})

test('execution gate requires scoped canonical-real DB rules plus matching rule and account money contracts', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  insertRule(handle.db, 'rule-preview', { executionMode: 'preview_only' })
  handle.db.prepare("UPDATE betting_rules SET real_betting_enabled=0 WHERE id='rule-preview'").run()
  insertRule(handle.db, 'rule-outside')
  insertRule(handle.db, 'rule-usd', { currency: 'USD' })
  insertAccount(handle.db, 'account-real')
  insertAccount(handle.db, 'account-usd', { currency: 'USD' })
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, {
    authorizationId: 'auth-scope',
    ruleIds: ['rule-real', 'rule-preview', 'rule-usd'],
  })
  const gate = {
    authorizationId: authorization.authorizationId,
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }

  assert.equal(assertExecutionGate(handle.db, { ...gate, ruleId: 'rule-real', accountId: 'account-real' }, options).authorizationId, authorization.authorizationId)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, ruleId: 'rule-outside' }, options), /authorization-rule-scope/)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, ruleId: 'rule-preview' }, options), /rule-real-disabled/)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, ruleId: 'rule-usd' }, options), /rule-money-mismatch/)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, ruleId: 'rule-real', accountId: 'account-usd' }, options), /account-money-mismatch/)

  handle.close()
})

test('revoked, expired, and exhausted authorizations fail closed while sent budget remains reconcilable', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  const gate = { ruleId: 'rule-real', leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken }

  const revoked = authorize(handle.db, { authorizationId: 'auth-revoked' })
  insertBatch(handle.db, 'batch-revoked-release', { amountMinor: 10 })
  const revokedChild = insertReservedChild(handle.db, {
    childOrderId: 'child-revoked-release', batchId: 'batch-revoked-release', amountMinor: 10,
  })
  reserveAuthorizationBudget(handle.db, { ...gate, authorizationId: revoked.authorizationId, ...revokedChild }, options)
  revokeAuthorization(handle.db, { authorizationId: revoked.authorizationId }, options)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, authorizationId: revoked.authorizationId }, options), /authorization-revoked/)
  assert.equal(releaseAuthorizationBudget(handle.db, {
    ...gate,
    authorizationId: revoked.authorizationId,
    childOrderId: revokedChild.childOrderId,
    amountMinor: 10,
  }, { env: {}, now: () => new Date(BASE_TIME) }).reservedAmountMinor, 0)
  assert.equal(handle.db.prepare("SELECT status FROM bet_child_orders WHERE child_order_id = 'child-revoked-release'").get().status, 'cancelled')
  assert.equal(handle.db.prepare("SELECT 1 FROM betting_account_locks WHERE child_order_id = 'child-revoked-release'").get(), undefined)

  const expired = authorize(handle.db, { authorizationId: 'auth-expired', durationMs: 1 })
  insertBatch(handle.db, 'batch-expired-unknown', { amountMinor: 20 })
  const expiredChild = insertReservedChild(handle.db, {
    childOrderId: 'child-expired-unknown', batchId: 'batch-expired-unknown', amountMinor: 10,
  })
  const expiredReservedChild = insertReservedChild(handle.db, {
    childOrderId: 'child-expired-reserved', batchId: 'batch-expired-unknown', amountMinor: 10,
  })
  reserveAuthorizationBudget(handle.db, { ...gate, authorizationId: expired.authorizationId, ...expiredChild }, options)
  reserveAuthorizationBudget(handle.db, { ...gate, authorizationId: expired.authorizationId, ...expiredReservedChild }, options)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'submit_prepared' WHERE child_order_id = ?").run(expiredChild.childOrderId)
  handle.db.prepare("UPDATE betting_account_locks SET status = 'submitting' WHERE child_order_id = ?").run(expiredChild.childOrderId)
  const later = { env: realEnv(), now: () => new Date(Date.parse(BASE_TIME) + 2) }
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, authorizationId: expired.authorizationId }, later), /authorization-expired/)
  assert.equal(handle.db.prepare("SELECT status FROM execution_authorizations WHERE authorization_id = 'auth-expired'").get().status, 'expired')
  assert.equal(handle.db.prepare('SELECT status FROM bet_child_orders WHERE child_order_id = ?').get(expiredChild.childOrderId).status, 'submit_prepared')
  assert.equal(handle.db.prepare('SELECT status FROM bet_child_orders WHERE child_order_id = ?').get(expiredReservedChild.childOrderId).status, 'cancelled')
  handle.db.prepare("UPDATE bet_child_orders SET status = 'unknown' WHERE child_order_id = ?").run(expiredChild.childOrderId)
  const reconciledExpired = resolveAuthorizationBudget(handle.db, {
    ...gate,
    authorizationId: expired.authorizationId,
    childOrderId: expiredChild.childOrderId,
  }, { env: {}, now: later.now })
  assert.equal(reconciledExpired.status, 'expired')
  assert.equal(reconciledExpired.unknownAmountMinor, 10)

  const exhausted = authorize(handle.db, { authorizationId: 'auth-exhausted' })
  insertBatch(handle.db, 'batch-1')
  const exhaustedChild = insertReservedChild(handle.db, { childOrderId: 'child-exhausted', batchId: 'batch-1', amountMinor: 100 })
  reserveAuthorizationBudget(handle.db, { ...gate, authorizationId: exhausted.authorizationId, ...exhaustedChild }, options)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'accepted' WHERE child_order_id = ?").run(exhaustedChild.childOrderId)
  const resolved = resolveAuthorizationBudget(handle.db, {
    ...gate,
    authorizationId: exhausted.authorizationId,
    childOrderId: exhaustedChild.childOrderId,
  }, options)
  assert.equal(resolved.status, 'exhausted')
  assert.equal(resolved.acceptedAmountMinor, 100)
  assert.throws(() => assertExecutionGate(handle.db, { ...gate, authorizationId: exhausted.authorizationId }, options), /authorization-exhausted/)

  handle.close()
})

test('revocation releases only provably unsent child bindings and preserves prepared, dispatched, and unknown money', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-mixed-revoke' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(handle.db, 'batch-mixed-revoke', { amountMinor: 40 })
  const children = ['reserved', 'prepared', 'dispatched', 'unknown'].map((kind) => insertReservedChild(handle.db, {
    childOrderId: `child-${kind}`,
    batchId: 'batch-mixed-revoke',
    amountMinor: 10,
  }))
  for (const child of children) reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'submit_prepared' WHERE child_order_id = 'child-prepared'").run()
  handle.db.prepare("UPDATE bet_child_orders SET status = 'submit_dispatched' WHERE child_order_id = 'child-dispatched'").run()
  handle.db.prepare("UPDATE bet_child_orders SET status = 'unknown' WHERE child_order_id = 'child-unknown'").run()
  resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-unknown' }, options)

  const revoked = revokeAuthorization(handle.db, { authorizationId: authorization.authorizationId }, options)
  assert.deepEqual({ reserved: revoked.reservedAmountMinor, unknown: revoked.unknownAmountMinor }, { reserved: 20, unknown: 10 })
  assert.deepEqual(handle.db.prepare(`
    SELECT child_order_id, status FROM bet_child_orders
    WHERE batch_id = 'batch-mixed-revoke' ORDER BY child_order_id
  `).all().map((row) => ({ ...row })), [
    { child_order_id: 'child-dispatched', status: 'submit_dispatched' },
    { child_order_id: 'child-prepared', status: 'submit_prepared' },
    { child_order_id: 'child-reserved', status: 'cancelled' },
    { child_order_id: 'child-unknown', status: 'unknown' },
  ])
  const batch = handle.db.prepare("SELECT reserved_amount_minor, unknown_amount_minor, unfilled_amount_minor FROM bet_batches WHERE batch_id = 'batch-mixed-revoke'").get()
  assert.deepEqual({ ...batch }, { reserved_amount_minor: 20, unknown_amount_minor: 10, unfilled_amount_minor: 10 })
  assert.equal(handle.db.prepare("SELECT 1 FROM betting_account_locks WHERE child_order_id = 'child-reserved'").get(), undefined)
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM betting_account_locks WHERE batch_id = 'batch-mixed-revoke'").get().count, 3)

  handle.close()
})

test('BEGIN IMMEDIATE reservations enforce the hard cap across database connections and batches', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  insertRule(first.db, 'rule-real')
  const lease = acquireExecutorLease(first.db)
  const authorization = authorize(first.db, { authorizationId: 'auth-budget' })
  insertBatch(first.db, 'batch-a', { amountMinor: 60 })
  insertBatch(first.db, 'batch-b', { amountMinor: 40 })
  insertBatch(first.db, 'batch-over', { amountMinor: 50 })
  const childA = insertReservedChild(first.db, { childOrderId: 'child-a', batchId: 'batch-a', amountMinor: 60 })
  const childB = insertReservedChild(first.db, { childOrderId: 'child-b', batchId: 'batch-b', amountMinor: 40 })
  const childOver = insertReservedChild(first.db, { childOrderId: 'child-over', batchId: 'batch-over', amountMinor: 50 })
  const second = openAppDatabase({ dbPath })
  const input = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }

  assert.equal(reserveAuthorizationBudget(first.db, { ...input, ...childA }, options).reservedAmountMinor, 60)
  assert.equal(reserveAuthorizationBudget(first.db, { ...input, ...childA }, options).reservedAmountMinor, 60)
  assert.throws(() => reserveAuthorizationBudget(second.db, { ...input, ...childOver }, options), /authorization-budget-exceeded/)
  assert.equal(reserveAuthorizationBudget(second.db, { ...input, ...childB }, options).reservedAmountMinor, 100)
  const row = first.db.prepare("SELECT * FROM execution_authorizations WHERE authorization_id = 'auth-budget'").get()
  assert.equal(row.reserved_amount_minor + row.accepted_amount_minor + row.unknown_amount_minor, 100)
  assert.equal(row.max_total_amount_minor, 100)
  assert.equal(row.hard_cap_amount_minor, 100)
  assert.deepEqual(first.db.prepare(`
    SELECT batch_id, authorization_id, reserved_amount_minor, unfilled_amount_minor
    FROM bet_batches WHERE batch_id IN ('batch-a', 'batch-b') ORDER BY batch_id
  `).all().map((row) => ({ ...row })), [
    { batch_id: 'batch-a', authorization_id: authorization.authorizationId, reserved_amount_minor: 60, unfilled_amount_minor: 0 },
    { batch_id: 'batch-b', authorization_id: authorization.authorizationId, reserved_amount_minor: 40, unfilled_amount_minor: 0 },
  ])
  assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count, 2)

  second.close()
  first.close()
})

test('release and resolve transfer only reserved budget to accepted or unknown without exceeding safe integers', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-transfer' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }

  assert.throws(() => reserveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'bad', amountMinor: Number.MAX_SAFE_INTEGER + 1 }, options), /amount-minor/)
  assert.throws(() => reserveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'missing', amountMinor: 1 }, options), /child-order-not-found/)
  insertBatch(handle.db, 'batch-release', { amountMinor: 20 })
  insertBatch(handle.db, 'batch-accepted', { amountMinor: 30 })
  insertBatch(handle.db, 'batch-unknown', { amountMinor: 40 })
  insertBatch(handle.db, 'batch-rejected', { amountMinor: 10 })
  const children = [
    insertReservedChild(handle.db, { childOrderId: 'child-release', batchId: 'batch-release', amountMinor: 20 }),
    insertReservedChild(handle.db, { childOrderId: 'child-accepted', batchId: 'batch-accepted', amountMinor: 30 }),
    insertReservedChild(handle.db, { childOrderId: 'child-unknown', batchId: 'batch-unknown', amountMinor: 40 }),
    insertReservedChild(handle.db, { childOrderId: 'child-rejected', batchId: 'batch-rejected', amountMinor: 10 }),
  ]
  for (const child of children) reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'cancelled' WHERE child_order_id = 'child-release'").run()
  assert.equal(releaseAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-release' }, options).reservedAmountMinor, 80)
  assert.equal(releaseAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-release' }, options).reservedAmountMinor, 80)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'accepted' WHERE child_order_id = 'child-accepted'").run()
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-accepted' }, options).acceptedAmountMinor, 30)
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-accepted' }, options).acceptedAmountMinor, 30)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'unknown' WHERE child_order_id = 'child-unknown'").run()
  const unknown = resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-unknown' }, options)
  assert.deepEqual({
    reserved: unknown.reservedAmountMinor,
    accepted: unknown.acceptedAmountMinor,
    unknown: unknown.unknownAmountMinor,
  }, { reserved: 10, accepted: 30, unknown: 40 })
  handle.db.prepare("UPDATE bet_child_orders SET status = 'accepted' WHERE child_order_id = 'child-unknown'").run()
  const acceptedAfterUnknown = resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-unknown' }, options)
  assert.deepEqual({ accepted: acceptedAfterUnknown.acceptedAmountMinor, unknown: acceptedAfterUnknown.unknownAmountMinor }, { accepted: 70, unknown: 0 })
  handle.db.prepare("UPDATE bet_child_orders SET status = 'rejected' WHERE child_order_id = 'child-rejected'").run()
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-rejected' }, options).reservedAmountMinor, 0)
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-rejected' }, options).reservedAmountMinor, 0)

  assert.deepEqual(handle.db.prepare(`
    SELECT batch_id, reserved_amount_minor, accepted_amount_minor, unknown_amount_minor, unfilled_amount_minor, status
    FROM bet_batches ORDER BY batch_id
  `).all().map((row) => ({ ...row })), [
    { batch_id: 'batch-accepted', reserved_amount_minor: 0, accepted_amount_minor: 30, unknown_amount_minor: 0, unfilled_amount_minor: 0, status: 'completed' },
    { batch_id: 'batch-rejected', reserved_amount_minor: 0, accepted_amount_minor: 0, unknown_amount_minor: 0, unfilled_amount_minor: 10, status: 'waiting_capacity' },
    { batch_id: 'batch-release', reserved_amount_minor: 0, accepted_amount_minor: 0, unknown_amount_minor: 0, unfilled_amount_minor: 20, status: 'waiting_capacity' },
    { batch_id: 'batch-unknown', reserved_amount_minor: 0, accepted_amount_minor: 40, unknown_amount_minor: 0, unfilled_amount_minor: 0, status: 'completed' },
  ])
  assert.equal(handle.db.prepare(`
    SELECT COUNT(*) AS count FROM betting_account_locks
    WHERE child_order_id IN ('child-release', 'child-accepted', 'child-unknown', 'child-rejected')
  `).get().count, 0)
  const authorizationAfterReconcile = handle.db.prepare("SELECT reserved_amount_minor, accepted_amount_minor, unknown_amount_minor FROM execution_authorizations WHERE authorization_id = 'auth-transfer'").get()
  assert.deepEqual({ ...authorizationAfterReconcile }, { reserved_amount_minor: 0, accepted_amount_minor: 70, unknown_amount_minor: 0 })

  insertBatch(handle.db, 'batch-never-bound', { amountMinor: 1 })
  insertReservedChild(handle.db, { childOrderId: 'child-never-bound', batchId: 'batch-never-bound', amountMinor: 1 })
  assert.throws(() => releaseAuthorizationBudget(handle.db, { ...gate, childOrderId: 'child-never-bound' }, options), /authorization-child-binding-not-found/)

  handle.close()
})

test('authorization child binding rolls back crash points and replays reserve plus repeated reject exactly once', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-crash-replay' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(handle.db, 'batch-crash-replay', { amountMinor: 25 })
  const child = insertReservedChild(handle.db, {
    childOrderId: 'child-crash-replay', batchId: 'batch-crash-replay', amountMinor: 25,
  })

  assert.throws(() => reserveAuthorizationBudget(handle.db, { ...gate, ...child }, {
    ...options,
    faultInjector(phase) {
      if (phase === 'reserve:after-authorization-update') throw new Error('crash-after-auth-reserve')
    },
  }), /crash-after-auth-reserve/)
  assert.equal(handle.db.prepare("SELECT reserved_amount_minor FROM execution_authorizations WHERE authorization_id = 'auth-crash-replay'").get().reserved_amount_minor, 0)
  assert.equal(handle.db.prepare("SELECT 1 FROM execution_authorization_child_budgets WHERE child_order_id = 'child-crash-replay'").get(), undefined)
  assert.equal(handle.db.prepare("SELECT authorization_id FROM bet_batches WHERE batch_id = 'batch-crash-replay'").get().authorization_id, null)

  assert.equal(reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options).reservedAmountMinor, 25)
  assert.equal(reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options).reservedAmountMinor, 25)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'rejected' WHERE child_order_id = 'child-crash-replay'").run()
  assert.throws(() => resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: child.childOrderId }, {
    ...options,
    faultInjector(phase) {
      if (phase === 'resolve:after-authorization-update') throw new Error('crash-after-auth-resolve')
    },
  }), /crash-after-auth-resolve/)
  assert.equal(handle.db.prepare("SELECT reserved_amount_minor FROM execution_authorizations WHERE authorization_id = 'auth-crash-replay'").get().reserved_amount_minor, 25)
  assert.equal(handle.db.prepare("SELECT status FROM execution_authorization_child_budgets WHERE child_order_id = 'child-crash-replay'").get().status, 'reserved')
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: child.childOrderId }, options).reservedAmountMinor, 0)
  assert.equal(resolveAuthorizationBudget(handle.db, { ...gate, childOrderId: child.childOrderId }, options).reservedAmountMinor, 0)

  handle.close()
})

test('every gate and budget mutation rejects a stale executor fence after lease takeover', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  let nowMs = Date.parse(BASE_TIME)
  const now = () => new Date(nowMs)
  const firstLease = acquireExecutorLease(handle.db, { now, ownerId: 'old-executor', ttlMs: 10 })
  const authorization = authorize(handle.db, { authorizationId: 'auth-fence' }, { now })
  const oldGate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: firstLease.leaseKey,
    executorOwnerId: firstLease.ownerId,
    fencingToken: firstLease.fencingToken,
  }
  nowMs += 11
  const nextLease = acquireExecutorLease(handle.db, { now, ownerId: 'new-executor', ttlMs: 60_000 })
  const options = { env: realEnv(), now }

  assert.throws(() => assertExecutionGate(handle.db, oldGate, options), /executor-fence-stale/)
  assert.throws(() => reserveAuthorizationBudget(handle.db, { ...oldGate, childOrderId: 'stale', amountMinor: 1 }, options), /executor-fence-stale/)
  assert.throws(() => releaseAuthorizationBudget(handle.db, { ...oldGate, childOrderId: 'stale' }, options), /executor-fence-stale/)
  assert.throws(() => resolveAuthorizationBudget(handle.db, { ...oldGate, childOrderId: 'stale' }, options), /executor-fence-stale/)
  assert.throws(() => assertExecutionGate(handle.db, { ...oldGate, fencingToken: nextLease.fencingToken }, options), /executor-fence-stale/)
  assert.doesNotThrow(() => assertExecutionGate(handle.db, {
    ...oldGate,
    executorOwnerId: nextLease.ownerId,
    fencingToken: nextLease.fencingToken,
  }, options))

  const watcherLease = acquireExecutorLease(handle.db, { now, ownerId: 'watcher-owner', leaseKey: 'watcher:test' })
  assert.throws(() => assertExecutionGate(handle.db, {
    ...oldGate,
    leaseKey: watcherLease.leaseKey,
    executorOwnerId: watcherLease.ownerId,
    fencingToken: watcherLease.fencingToken,
  }, options), /executor-lease-key/)

  handle.close()
})

test('bound authorization children reject ordinary Store outcomes and cancellation while recovery preserves uncertain money', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-store-bypass' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(handle.db, 'batch-store-bypass', { amountMinor: 25 })
  const child = insertReservedChild(handle.db, {
    childOrderId: 'child-store-bypass', batchId: 'batch-store-bypass', amountMinor: 25,
  })
  reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options)
  const store = new BetBatchStore(handle.db, {
    fencingToken: lease.fencingToken,
    leaseKey: lease.leaseKey,
    now: options.now,
  })
  store.prepareSubmit(child.childOrderId, { submitAttemptId: 'attempt-store-bypass', at: BASE_TIME })
  store.markDispatched(child.childOrderId, { at: BASE_TIME })

  const before = {
    child: { ...handle.db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(child.childOrderId) },
    batch: { ...handle.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(child.batchId) },
    authorization: { ...handle.db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorizationId) },
    binding: { ...handle.db.prepare('SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(child.childOrderId) },
  }
  assert.throws(() => store.resolveChildOrder(child.childOrderId, { status: 'accepted', at: BASE_TIME }), /authorized-child-store-bypass/)
  assert.throws(() => store.cancelUnsubmitted(child.batchId, { at: BASE_TIME }), /authorized-child-store-bypass/)
  assert.deepEqual({ ...handle.db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(child.childOrderId) }, before.child)
  assert.deepEqual({ ...handle.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(child.batchId) }, before.batch)
  assert.deepEqual({ ...handle.db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorizationId) }, before.authorization)
  assert.deepEqual({ ...handle.db.prepare('SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(child.childOrderId) }, before.binding)

  assert.deepEqual(store.recover({ at: BASE_TIME }), {
    unknownCount: 1,
    activeLockCount: 1,
    batchCount: 1,
  })
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT status, error_code FROM bet_child_orders WHERE child_order_id = ?
  `).get(child.childOrderId) }, { status: 'unknown', error_code: 'recovery-uncertain' })
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT reserved_amount_minor, unknown_amount_minor
    FROM execution_authorizations WHERE authorization_id = ?
  `).get(authorization.authorizationId) }, { reserved_amount_minor: 0, unknown_amount_minor: 25 })
  assert.equal(handle.db.prepare(`
    SELECT status FROM execution_authorization_child_budgets WHERE child_order_id = ?
  `).get(child.childOrderId).status, 'unknown')
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT child_order_id, status FROM betting_account_locks WHERE account_id = ?
  `).get(child.accountId) }, { child_order_id: child.childOrderId, status: 'unknown' })

  handle.close()
})

test('authorized child outcome rolls back child, batch, authorization, binding, and lock at every crash point', () => {
  for (const crashPhase of ['resolve:after-child', 'resolve:after-batch', 'resolve:before-authorization']) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    insertRule(handle.db, 'rule-real')
    const lease = acquireExecutorLease(handle.db)
    const authorization = authorize(handle.db, { authorizationId: `auth-${crashPhase}` })
    const gate = {
      authorizationId: authorization.authorizationId,
      ruleId: 'rule-real',
      leaseKey: lease.leaseKey,
      executorOwnerId: lease.ownerId,
      fencingToken: lease.fencingToken,
    }
    const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
    insertBatch(handle.db, `batch-${crashPhase}`, { amountMinor: 25 })
    const child = insertReservedChild(handle.db, {
      childOrderId: `child-${crashPhase}`, batchId: `batch-${crashPhase}`, amountMinor: 25,
    })
    reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options)
    const store = new BetBatchStore(handle.db, {
      fencingToken: lease.fencingToken,
      leaseKey: lease.leaseKey,
      now: options.now,
    })
    store.prepareSubmit(child.childOrderId, { submitAttemptId: `attempt-${crashPhase}`, at: BASE_TIME })
    store.markDispatched(child.childOrderId, { at: BASE_TIME })
    const before = {
      child: { ...handle.db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(child.childOrderId) },
      batch: { ...handle.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(child.batchId) },
      authorization: { ...handle.db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorizationId) },
      binding: { ...handle.db.prepare('SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(child.childOrderId) },
      lock: { ...handle.db.prepare('SELECT * FROM betting_account_locks WHERE child_order_id = ?').get(child.childOrderId) },
    }

    assert.throws(() => resolveAuthorizedChildOrder(handle.db, {
      ...gate,
      childOrderId: child.childOrderId,
      status: 'accepted',
      providerReferenceCiphertext: 'ciphertext-only',
    }, {
      ...options,
      faultInjector(phase) {
        if (phase === crashPhase) throw new Error(`crash-${crashPhase}`)
      },
    }), new RegExp(`crash-${crashPhase}`))
    assert.deepEqual({ ...handle.db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(child.childOrderId) }, before.child)
    assert.deepEqual({ ...handle.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(child.batchId) }, before.batch)
    assert.deepEqual({ ...handle.db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorizationId) }, before.authorization)
    assert.deepEqual({ ...handle.db.prepare('SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(child.childOrderId) }, before.binding)
    assert.deepEqual({ ...handle.db.prepare('SELECT * FROM betting_account_locks WHERE child_order_id = ?').get(child.childOrderId) }, before.lock)

    const resolved = resolveAuthorizedChildOrder(handle.db, {
      ...gate,
      childOrderId: child.childOrderId,
      status: 'accepted',
      providerReferenceCiphertext: 'ciphertext-only',
    }, options)
    assert.equal(resolved.child.status, 'accepted')
    assert.equal(resolved.batch.status, 'completed')
    assert.deepEqual({
      reserved: resolved.authorization.reservedAmountMinor,
      accepted: resolved.authorization.acceptedAmountMinor,
      unknown: resolved.authorization.unknownAmountMinor,
      binding: resolved.bindingStatus,
    }, { reserved: 0, accepted: 25, unknown: 0, binding: 'accepted' })
    assert.equal(handle.db.prepare('SELECT 1 FROM betting_account_locks WHERE child_order_id = ?').get(child.childOrderId), undefined)
    assert.deepEqual(resolveAuthorizedChildOrder(handle.db, {
      ...gate,
      childOrderId: child.childOrderId,
      status: 'accepted',
    }, options), resolved)
    handle.close()
  }
})

test('gate cancellation releases only bound unsent money and gate recovery atomically preserves uncertain money', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-cancel-recover' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(handle.db, 'batch-cancel-recover', { amountMinor: 20 })
  const reserved = insertReservedChild(handle.db, {
    childOrderId: 'child-cancel-reserved', batchId: 'batch-cancel-recover', amountMinor: 10,
  })
  const prepared = insertReservedChild(handle.db, {
    childOrderId: 'child-cancel-prepared', batchId: 'batch-cancel-recover', amountMinor: 10,
  })
  reserveAuthorizationBudget(handle.db, { ...gate, ...reserved }, options)
  reserveAuthorizationBudget(handle.db, { ...gate, ...prepared }, options)
  const store = new BetBatchStore(handle.db, {
    fencingToken: lease.fencingToken,
    leaseKey: lease.leaseKey,
    now: options.now,
  })
  store.prepareSubmit(prepared.childOrderId, { submitAttemptId: 'attempt-cancel-recover', at: BASE_TIME })

  const cancelled = cancelAuthorizedUnsubmitted(handle.db, {
    ...gate,
    batchId: 'batch-cancel-recover',
    finishReason: 'manual_cancel',
  }, options)
  assert.equal(cancelled.cancelledCount, 1)
  assert.equal(cancelled.releasedAmountMinor, 10)
  assert.deepEqual(handle.db.prepare(`
    SELECT child_order_id, status FROM bet_child_orders
    WHERE batch_id = 'batch-cancel-recover' ORDER BY child_order_id
  `).all().map((row) => ({ ...row })), [
    { child_order_id: 'child-cancel-prepared', status: 'submit_prepared' },
    { child_order_id: 'child-cancel-reserved', status: 'cancelled' },
  ])
  assert.deepEqual({
    reserved: cancelled.authorization.reservedAmountMinor,
    unknown: cancelled.authorization.unknownAmountMinor,
    batchStatus: cancelled.batch.status,
  }, { reserved: 10, unknown: 0, batchStatus: 'submitting' })

  const recovered = recoverAuthorizedChildOrders(handle.db, gate, options)
  assert.equal(recovered.unknownCount, 1)
  assert.deepEqual({
    reserved: recovered.authorization.reservedAmountMinor,
    unknown: recovered.authorization.unknownAmountMinor,
    batchStatus: recovered.batches[0].status,
  }, { reserved: 0, unknown: 10, batchStatus: 'waiting_result' })
  assert.equal(handle.db.prepare("SELECT status FROM execution_authorization_child_budgets WHERE child_order_id = 'child-cancel-prepared'").get().status, 'unknown')
  assert.equal(handle.db.prepare("SELECT status FROM betting_account_locks WHERE child_order_id = 'child-cancel-prepared'").get().status, 'unknown')
  const repeatedRecovery = recoverAuthorizedChildOrders(handle.db, gate, options)
  assert.deepEqual({
    reconciled: repeatedRecovery.reconciledCount,
    unknown: repeatedRecovery.unknownCount,
    reserved: repeatedRecovery.authorization.reservedAmountMinor,
    unknownMinor: repeatedRecovery.authorization.unknownAmountMinor,
    batchStatus: repeatedRecovery.batches[0].status,
  }, { reconciled: 0, unknown: 0, reserved: 0, unknownMinor: 10, batchStatus: 'waiting_result' })
  handle.close()
})

test('restart repair closes the legacy split window without duplicating accepted or unknown budget', () => {
  const dbPath = tempDbPath()
  const first = openAppDatabase({ dbPath })
  insertRule(first.db, 'rule-real')
  const lease = acquireExecutorLease(first.db)
  const authorization = authorize(first.db, { authorizationId: 'auth-restart-repair' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(first.db, 'batch-restart-repair', { amountMinor: 20 })
  const accepted = insertReservedChild(first.db, {
    childOrderId: 'child-repair-accepted', batchId: 'batch-restart-repair', amountMinor: 10,
  })
  const prepared = insertReservedChild(first.db, {
    childOrderId: 'child-repair-prepared', batchId: 'batch-restart-repair', amountMinor: 10,
  })
  reserveAuthorizationBudget(first.db, { ...gate, ...accepted }, options)
  reserveAuthorizationBudget(first.db, { ...gate, ...prepared }, options)
  first.db.prepare("UPDATE bet_child_orders SET status = 'accepted', resolved_at = ? WHERE child_order_id = ?").run(BASE_TIME, accepted.childOrderId)
  first.db.prepare("UPDATE bet_child_orders SET status = 'submit_prepared', submit_attempt_id = 'repair-attempt', submit_prepared_at = ? WHERE child_order_id = ?").run(BASE_TIME, prepared.childOrderId)
  first.db.prepare("UPDATE betting_account_locks SET status = 'submitting' WHERE child_order_id = ?").run(prepared.childOrderId)
  first.close()

  const reopened = openAppDatabase({ dbPath })
  const repaired = recoverAuthorizedChildOrders(reopened.db, gate, options)
  assert.deepEqual({
    reconciled: repaired.reconciledCount,
    unknown: repaired.unknownCount,
    reserved: repaired.authorization.reservedAmountMinor,
    accepted: repaired.authorization.acceptedAmountMinor,
    unknownMinor: repaired.authorization.unknownAmountMinor,
  }, { reconciled: 2, unknown: 1, reserved: 0, accepted: 10, unknownMinor: 10 })
  assert.deepEqual(reopened.db.prepare(`
    SELECT child_order_id, status FROM bet_child_orders
    WHERE batch_id = 'batch-restart-repair' ORDER BY child_order_id
  `).all().map((row) => ({ ...row })), [
    { child_order_id: 'child-repair-accepted', status: 'accepted' },
    { child_order_id: 'child-repair-prepared', status: 'unknown' },
  ])
  assert.deepEqual(reopened.db.prepare(`
    SELECT child_order_id, status FROM execution_authorization_child_budgets
    WHERE batch_id = 'batch-restart-repair' ORDER BY child_order_id
  `).all().map((row) => ({ ...row })), [
    { child_order_id: 'child-repair-accepted', status: 'accepted' },
    { child_order_id: 'child-repair-prepared', status: 'unknown' },
  ])
  assert.deepEqual({ ...reopened.db.prepare(`
    SELECT reserved_amount_minor, accepted_amount_minor, unknown_amount_minor, unfilled_amount_minor, status
    FROM bet_batches WHERE batch_id = 'batch-restart-repair'
  `).get() }, {
    reserved_amount_minor: 0,
    accepted_amount_minor: 10,
    unknown_amount_minor: 10,
    unfilled_amount_minor: 0,
    status: 'waiting_result',
  })
  assert.equal(reopened.db.prepare("SELECT 1 FROM betting_account_locks WHERE child_order_id = 'child-repair-accepted'").get(), undefined)
  assert.equal(reopened.db.prepare("SELECT status FROM betting_account_locks WHERE child_order_id = 'child-repair-prepared'").get().status, 'unknown')
  const second = recoverAuthorizedChildOrders(reopened.db, gate, options)
  assert.deepEqual({
    reconciled: second.reconciledCount,
    unknown: second.unknownCount,
    accepted: second.authorization.acceptedAmountMinor,
    unknownMinor: second.authorization.unknownAmountMinor,
  }, { reconciled: 0, unknown: 0, accepted: 10, unknownMinor: 10 })
  reopened.close()
})

test('every execution gate entry reconciles a legacy terminal child split before evaluating new work', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertRule(handle.db, 'rule-real')
  const lease = acquireExecutorLease(handle.db)
  const authorization = authorize(handle.db, { authorizationId: 'auth-gate-reconcile' })
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-real',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
  }
  const options = { env: realEnv(), now: () => new Date(BASE_TIME) }
  insertBatch(handle.db, 'batch-gate-reconcile', { amountMinor: 10 })
  const child = insertReservedChild(handle.db, {
    childOrderId: 'child-gate-reconcile', batchId: 'batch-gate-reconcile', amountMinor: 10,
  })
  reserveAuthorizationBudget(handle.db, { ...gate, ...child }, options)
  handle.db.prepare("UPDATE bet_child_orders SET status = 'accepted', resolved_at = ? WHERE child_order_id = ?")
    .run(BASE_TIME, child.childOrderId)

  assert.equal(assertExecutionGate(handle.db, gate, options).authorizationId, authorization.authorizationId)
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT reserved_amount_minor, accepted_amount_minor, unknown_amount_minor
    FROM execution_authorizations WHERE authorization_id = ?
  `).get(authorization.authorizationId) }, {
    reserved_amount_minor: 0,
    accepted_amount_minor: 10,
    unknown_amount_minor: 0,
  })
  assert.equal(handle.db.prepare('SELECT status FROM execution_authorization_child_budgets WHERE child_order_id = ?').get(child.childOrderId).status, 'accepted')
  assert.equal(handle.db.prepare('SELECT 1 FROM betting_account_locks WHERE child_order_id = ?').get(child.childOrderId), undefined)
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT reserved_amount_minor, accepted_amount_minor, unknown_amount_minor, unfilled_amount_minor, status
    FROM bet_batches WHERE batch_id = ?
  `).get(child.batchId) }, {
    reserved_amount_minor: 0,
    accepted_amount_minor: 10,
    unknown_amount_minor: 0,
    unfilled_amount_minor: 0,
    status: 'completed',
  })
  handle.close()
})
