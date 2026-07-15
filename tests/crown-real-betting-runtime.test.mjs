import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { bettingRoleLeaseKeys } from '../src/crown/app/betting-process.mjs'
import {
  assertRealBettingRequested,
  collectRealBettingPreflight,
  evaluatePureModePreflight,
  getRealBettingStatus,
  hasOpenBetReconciliation,
  refreshRealBettingRuntime,
  recordRealBettingWorkerExit,
  requestRealBettingStart,
  requestRealBettingStop,
} from '../src/crown/betting/real-betting-runtime.mjs'

const READY = Object.freeze({
  ruleCardsEnabled: true,
  bettingAccountAvailable: true,
  capabilityExact: true,
  schemaCurrent: true,
  fenceFresh: true,
  executorLeaseFresh: true,
})

test('startup clears a persisted legacy account freshness reason even when already armed', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    handle.db.prepare(`UPDATE real_betting_runtime
      SET requested=1,runtime_state='armed_waiting',reason_code='betting-account-login-not-fresh',updated_at='2026-07-13T00:00:00.000Z'
      WHERE singleton_id=1`).run()
    const status = getRealBettingStatus(handle.db, {
      initialize: true,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })
    assert.equal(status.state, 'armed_waiting')
    assert.equal(status.reasonCode, 'preflight-required')
    assert.equal(status.updatedAt, '2026-07-14T00:00:00.000Z')
  } finally { handle.close() }
})

test('armed tick replaces a legacy account freshness reason with the current preflight blocker', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    handle.db.prepare(`UPDATE real_betting_runtime
      SET requested=1,runtime_state='armed_waiting',reason_code='betting-account-balance-not-fresh',updated_at='2026-07-13T00:00:00.000Z'
      WHERE singleton_id=1`).run()
    const status = refreshRealBettingRuntime(handle.db, {
      checks: { ...READY, capabilityExact: false },
      now: () => new Date('2026-07-14T00:00:01.000Z'),
    })
    assert.equal(status.state, 'armed_waiting')
    assert.equal(status.reasonCode, 'capability-evidence-not-exact')
    assert.deepEqual(status.blockingReasons, ['capability-evidence-not-exact'])
  } finally { handle.close() }
})

test('start intent survives reopen but derived running state must restart armed and re-run fresh preflight', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-real-runtime-')), 'app.sqlite')
  let handle = openAppDatabase({ dbPath })
  try {
    const started = requestRealBettingStart(handle.db, READY, { now: () => new Date('2026-07-11T01:00:00.000Z') })
    assert.equal(started.requested, true)
    assert.equal(started.state, 'running')
  } finally {
    handle.close()
  }

  handle = openAppDatabase({ dbPath })
  try {
    const reopened = getRealBettingStatus(handle.db, { initialize: true, now: () => new Date('2026-07-11T01:00:01.000Z') })
    assert.equal(reopened.requested, true)
    assert.equal(reopened.state, 'armed_waiting')
    assert.equal(reopened.reasonCode, 'preflight-required')
    assert.equal(reopened.updatedAt, '2026-07-11T01:00:01.000Z')
    assert.equal(reopened.preflight.length, 6)
    assert.equal(reopened.blockingReasons.length, 6)
    const restarted = requestRealBettingStart(handle.db, { ...READY, ruleCardsEnabled: false })
    assert.equal(restarted.requested, true)
    assert.equal(restarted.state, 'armed_waiting')
    assert.equal(restarted.reasonCode, 'betting-rule-card-not-enabled')
  } finally {
    handle.close()
  }
})

test('every required startup condition fails closed with one stable safe reason', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    for (const [field, expectedReason] of [
      ['ruleCardsEnabled', 'betting-rule-card-not-enabled'],
      ['bettingAccountAvailable', 'betting-account-unavailable'],
      ['capabilityExact', 'capability-evidence-not-exact'],
      ['schemaCurrent', 'schema-not-current'],
      ['fenceFresh', 'fence-not-fresh'],
      ['executorLeaseFresh', 'executor-lease-not-fresh'],
    ]) {
      const status = requestRealBettingStart(handle.db, { ...READY, [field]: false })
      assert.equal(status.state, 'armed_waiting', field)
      assert.equal(status.reasonCode, expectedReason, field)
    }
    assert.equal(requestRealBettingStart(handle.db, READY).state, 'running')
  } finally {
    handle.close()
  }
})

test('production collector derives evidence from DB and capability matrix instead of supplied booleans', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const checks = collectRealBettingPreflight(handle.db, {
      env: {},
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })
    assert.equal(checks.schemaCurrent, true)
    assert.equal(checks.capabilityExact, false)
    assert.equal(checks.ruleCardsEnabled, false)
    assert.equal(checks.bettingAccountAvailable, false)
    assert.equal(Object.hasOwn(checks, 'authorizationActive'), false)
    assert.equal(Object.hasOwn(checks, 'environmentExact'), false)
    requestRealBettingStart(handle.db, READY)
    const refreshed = refreshRealBettingRuntime(handle.db, { checks, now: () => new Date('2026-07-11T02:00:01.000Z') })
    assert.equal(refreshed.state, 'blocked')
    assert.equal(refreshed.reasonCode, 'betting-rule-card-not-enabled')
    assert.throws(() => assertRealBettingRequested(handle.db), /real-betting-not-requested/)
  } finally { handle.close() }
})

test('collector accepts enabled virtual cards without eligibility but only counts CNY integer accounts', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    handle.db.prepare(`
      INSERT INTO auto_betting_rule_cards (
        card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,
        real_eligible,real_eligibility_updated_at,created_at,updated_at
      ) VALUES ('card-a','Card A',1,'0.8','1.05',20,0,'','','')
    `).run()
    handle.db.prepare(`
      INSERT INTO betting_accounts (
        id,label,username,status,allocation_status,currency,amount_scale,
        access_status,per_bet_limit_minor,stake_step_minor,created_at,updated_at
      ) VALUES ('account-a','Account A','user-a','enabled','enabled','USD',2,'failed',50,1,'','')
    `).run()
    const usd = collectRealBettingPreflight(handle.db, { now: () => new Date('2026-07-11T02:00:00.000Z') })
    assert.equal(usd.ruleCardsEnabled, true)
    assert.equal(usd.bettingAccountAvailable, false)

    handle.db.prepare("UPDATE betting_accounts SET currency='CNY',amount_scale=0 WHERE id='account-a'").run()
    const cny = collectRealBettingPreflight(handle.db, { now: () => new Date('2026-07-11T02:00:00.000Z') })
    assert.equal(cny.bettingAccountAvailable, true)
  } finally { handle.close() }
})


test('exact collector ignores foreign-prefix leases and validates worker plus executor ticket roles only', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-exact-preflight-')), 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  const now = () => new Date('2026-07-11T02:00:00.000Z')
  try {
    new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:another-db', ownerId: 'foreign', now }).acquire()
    const before = collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now })
    assert.equal(before.executorLeaseFresh, true)
    assert.equal(before.fenceFresh, true)
    const keys = bettingRoleLeaseKeys({ dbPath: handle.dbPath })
    assert.deepEqual(Object.keys(keys), ['worker', 'executor', 'reconciler'])
    const roles = {}
    for (const [role, ownerId] of [
      ['worker', 'worker-owner'],
      ['executor', 'executor-owner'],
      ['reconciler', 'reconciler-owner'],
    ]) {
      const lease = new RuntimeLease({ db: handle.db, leaseKey: keys[role], ownerId, now })
      lease.acquire()
      roles[role] = { leaseKey: keys[role], ownerId, fencingToken: lease.fencingToken }
    }
    const after = collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now, readyTicket: { leases: roles } })
    assert.equal(after.executorLeaseFresh, true)
    assert.equal(after.fenceFresh, true)
    const forged = structuredClone(roles)
    forged.reconciler.fencingToken += 1
    assert.equal(collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now, readyTicket: { leases: forged } }).fenceFresh, false)
  } finally { handle.close() }
})

test('pure capability gate requires Preview and Submit but never reconciliation, eligibility versions, or a hard cap', () => {
  const settings = [{ cardId: 'card-a', enabled: true }]
  const capabilities = [{ evidenceStatus: 'verified', previewAllowed: true, submitAllowed: true, reconciliationAllowed: false }]
  assert.deepEqual(evaluatePureModePreflight({
    authorizedModes: [], eligibilityVersions: {}, settings, capabilities, hardCapAmountMinor: 0,
  }), { scopeExact: true, capabilityExact: true })
})

test('reconciliation takeover treats future waiting unknown rows as open work', () => {
  let sql = ''
  const database = {
    prepare(value) {
      sql = value
      return { get: () => ({ submit_attempt_id: 'attempt-future' }) }
    },
    exec() {},
  }
  assert.equal(hasOpenBetReconciliation(database), true)
  assert.match(sql, /status IN \('pending','waiting'\)/)
  assert.match(sql, /attempt\.status='unknown'/)
  assert.match(sql, /child\.status='unknown'/)
  assert.doesNotMatch(sql, /next_poll_at\s*<=/)
})

test('unexpected current worker exit blocks requested runtime while stopped intent remains off', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    requestRealBettingStart(handle.db, READY)
    const blocked = recordRealBettingWorkerExit(handle.db, { unexpected: true })
    assert.equal(blocked.requested, true)
    assert.equal(blocked.state, 'blocked')
    assert.equal(blocked.reasonCode, 'worker-exited')
    assert.throws(() => assertRealBettingRequested(handle.db), /real-betting-not-requested/)
    requestRealBettingStop(handle.db)
    assert.equal(recordRealBettingWorkerExit(handle.db, { unexpected: true }).state, 'off')
  } finally { handle.close() }
})

test('stop immediately closes the claim gate, releases unsent locks, and preserves unknown locks without authorization budgets', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const now = '2026-07-11T02:00:00.000Z'
  try {
    handle.db.prepare("INSERT INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at) VALUES ('r','R','CNY',0,50,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO betting_accounts (id,label,username,status,currency,amount_scale,per_bet_limit_minor,stake_step_minor,created_at,updated_at) VALUES ('a1','A1','u1','enabled','CNY',0,50,1,?,?),('a2','A2','u2','enabled','CNY',0,50,1,?,?)").run(now, now, now, now)
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s','k','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s2','k2','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,reserved_amount_minor,unfilled_amount_minor,status,created_at) VALUES ('b','s','r','CNY',0,50,20,30,'submitting',?)").run(now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,unknown_amount_minor,unfilled_amount_minor,status,created_at) VALUES ('unknown-b','s2','r','CNY',0,50,20,30,'waiting_result',?)").run(now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,requested_amount_minor,status,created_at) VALUES ('reserved','b','a1',20,'reserved',?),('unknown','unknown-b','a2',20,'unknown',?)").run(now, now)
    handle.db.prepare("INSERT INTO betting_account_locks (account_id,child_order_id,batch_id,status,fencing_token,acquired_at,updated_at) VALUES ('a1','reserved','b','reserved',1,?,?),('a2','unknown','unknown-b','unknown',1,?,?)").run(now, now, now, now)
    requestRealBettingStart(handle.db, READY)
    assert.doesNotThrow(() => assertRealBettingRequested(handle.db))

    const stopped = requestRealBettingStop(handle.db, { now: () => new Date(now) })
    assert.equal(stopped.requested, false)
    assert.equal(stopped.state, 'off')
    assert.throws(() => assertRealBettingRequested(handle.db), /real-betting-not-requested/)
    assert.deepEqual(Object.fromEntries(handle.db.prepare('SELECT child_order_id,status FROM bet_child_orders ORDER BY child_order_id').all().map((row) => [row.child_order_id, row.status])), {
      reserved: 'cancelled', unknown: 'unknown',
    })
    assert.deepEqual(handle.db.prepare('SELECT account_id,status FROM betting_account_locks ORDER BY account_id').all().map((row) => ({ ...row })), [{ account_id: 'a2', status: 'unknown' }])
    assert.deepEqual({ ...handle.db.prepare("SELECT status,reserved_amount_minor,unknown_amount_minor,unfilled_amount_minor,finish_reason FROM bet_batches WHERE batch_id='b'").get() }, {
      status: 'cancelled', reserved_amount_minor: 0, unknown_amount_minor: 0, unfilled_amount_minor: 50, finish_reason: 'real_betting_stopped',
    })
  } finally {
    handle.close()
  }
})
