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
  getRealBettingStatus,
  refreshRealBettingRuntime,
  recordRealBettingWorkerExit,
  requestRealBettingStart,
  requestRealBettingStop,
} from '../src/crown/betting/real-betting-runtime.mjs'

const READY = Object.freeze({
  watcherFresh: true,
  watcherLeaseUnique: true,
  monitorLoginFresh: true,
  bettingAccountFresh: true,
  balanceFresh: true,
  capabilityExact: true,
  authorizationActive: true,
  schemaCurrent: true,
  environmentExact: true,
  fenceFresh: true,
  executorLeaseFresh: true,
  reconcilerLeaseFresh: true,
  executorReconcilerDistinct: true,
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
    assert.equal(reopened.preflight.length, 13)
    assert.equal(reopened.blockingReasons.length, 13)
    const restarted = requestRealBettingStart(handle.db, { ...READY, watcherFresh: false })
    assert.equal(restarted.requested, true)
    assert.equal(restarted.state, 'armed_waiting')
    assert.equal(restarted.reasonCode, 'watcher-not-fresh')
  } finally {
    handle.close()
  }
})

test('every required startup condition fails closed with one stable safe reason', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    for (const [field, expectedReason] of [
      ['watcherFresh', 'watcher-not-fresh'],
      ['watcherLeaseUnique', 'watcher-lease-not-unique'],
      ['monitorLoginFresh', 'monitor-login-not-fresh'],
      ['bettingAccountFresh', 'betting-account-login-not-fresh'],
      ['balanceFresh', 'betting-account-balance-not-fresh'],
      ['capabilityExact', 'capability-evidence-not-exact'],
      ['authorizationActive', 'authorization-not-active'],
      ['schemaCurrent', 'schema-not-current'],
      ['environmentExact', 'environment-not-exact'],
      ['fenceFresh', 'fence-not-fresh'],
      ['executorLeaseFresh', 'executor-lease-not-fresh'],
      ['reconcilerLeaseFresh', 'reconciler-lease-not-fresh'],
      ['executorReconcilerDistinct', 'executor-reconciler-lease-not-distinct'],
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
      env: { CROWN_REAL_CURRENCY: 'CNY', CROWN_REAL_AMOUNT_SCALE: '0', CROWN_REAL_MAX_TOTAL_MINOR: '100' },
      now: () => new Date('2026-07-11T02:00:00.000Z'),
    })
    assert.equal(checks.schemaCurrent, true)
    assert.equal(checks.capabilityExact, false)
    assert.equal(checks.authorizationActive, false)
    requestRealBettingStart(handle.db, READY)
    const refreshed = refreshRealBettingRuntime(handle.db, { checks, now: () => new Date('2026-07-11T02:00:01.000Z') })
    assert.equal(refreshed.state, 'blocked')
    assert.equal(refreshed.reasonCode, 'watcher-not-fresh')
    assert.throws(() => assertRealBettingRequested(handle.db), /real-betting-not-requested/)
  } finally { handle.close() }
})


test('exact collector ignores foreign-prefix leases and validates the current ready ticket roles', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-exact-preflight-')), 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  const now = () => new Date('2026-07-11T02:00:00.000Z')
  try {
    new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:another-db', ownerId: 'foreign', now }).acquire()
    const before = collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now })
    assert.equal(before.executorLeaseFresh, true)
    assert.equal(before.reconcilerLeaseFresh, true)
    assert.equal(before.fenceFresh, true)
    const keys = bettingRoleLeaseKeys({ dbPath: handle.dbPath })
    const roles = {}
    for (const [role, ownerId] of [['worker', 'worker-owner'], ['executor', 'executor-owner'], ['reconciler', 'reconciler-owner']]) {
      const lease = new RuntimeLease({ db: handle.db, leaseKey: keys[role], ownerId, now })
      lease.acquire()
      roles[role] = { leaseKey: keys[role], ownerId, fencingToken: lease.fencingToken }
    }
    const after = collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now, readyTicket: { leases: roles } })
    assert.equal(after.executorLeaseFresh, true)
    assert.equal(after.reconcilerLeaseFresh, true)
    assert.equal(after.executorReconcilerDistinct, true)
    assert.equal(after.fenceFresh, true)
    const forged = structuredClone(roles)
    forged.executor.fencingToken += 1
    assert.equal(collectRealBettingPreflight(handle.db, { dbPath: handle.dbPath, now, readyTicket: { leases: forged } }).fenceFresh, false)
  } finally { handle.close() }
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

test('stop immediately closes the claim gate and cancels only provably unsent children', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const now = '2026-07-11T02:00:00.000Z'
  try {
    handle.db.prepare("INSERT INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at) VALUES ('r','R','CNY',2,100,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO betting_accounts (id,label,username,status,currency,amount_scale,per_bet_limit_minor,stake_step_minor,created_at,updated_at) VALUES ('a','A','u','enabled','CNY',2,100,1,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s','k','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s2','k2','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s3','k3','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s4','k4','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO execution_authorizations (authorization_id,currency,amount_scale,rule_ids_json,max_total_amount_minor,hard_cap_amount_minor,reserved_amount_minor,accepted_amount_minor,valid_from,expires_at,status,created_at,updated_at) VALUES ('auth','CNY',2,'[\"r\"]',100,100,20,10,?,?,'active',?,?)").run(now, '2026-07-11T03:00:00.000Z', now, now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,authorization_id,currency,amount_scale,target_amount_minor,status,created_at) VALUES ('b','s','r','auth','CNY',2,100,'submitting',?)").run(now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,status,created_at) VALUES ('preview-b','s2','r','CNY',2,100,'submitting',?)").run(now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,created_at) VALUES ('preview-reserved','preview-b','a',1,10,'reserved',?)").run(now)
    for (const [attempt, id, status] of [[1, 'reserved', 'reserved'], [2, 'prepared', 'submit_prepared'], [3, 'dispatched', 'submit_dispatched'], [4, 'unknown', 'unknown']]) {
      handle.db.prepare('INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, 'b', 'a', attempt, 10, status, now)
    }
    handle.db.prepare("INSERT INTO execution_authorization_child_budgets (child_order_id,authorization_id,batch_id,account_id,amount_minor,status,created_at,updated_at) VALUES ('reserved','auth','b','a',10,'reserved',?,?)").run(now, now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,authorization_id,currency,amount_scale,target_amount_minor,reserved_amount_minor,accepted_amount_minor,unfilled_amount_minor,status,created_at) VALUES ('mixed-b','s3','r','auth','CNY',2,100,10,10,80,'submitting',?)").run(now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,created_at,resolved_at) VALUES ('mixed-accepted','mixed-b','a',1,10,'accepted',?,?)").run(now, now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,created_at) VALUES ('mixed-reserved','mixed-b','a',2,10,'reserved',?)").run(now)
    handle.db.prepare("INSERT INTO execution_authorization_child_budgets (child_order_id,authorization_id,batch_id,account_id,amount_minor,status,created_at,updated_at) VALUES ('mixed-accepted','auth','mixed-b','a',10,'accepted',?,?),('mixed-reserved','auth','mixed-b','a',10,'reserved',?,?)").run(now, now, now, now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,authorization_id,currency,amount_scale,target_amount_minor,status,created_at,finished_at) VALUES ('terminal-b','s4','r','auth','CNY',2,100,'completed',?,?)").run(now, now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,created_at) VALUES ('terminal-reserved','terminal-b','a',1,10,'reserved',?)").run(now)
    requestRealBettingStart(handle.db, READY)
    assert.doesNotThrow(() => assertRealBettingRequested(handle.db))

    const stopped = requestRealBettingStop(handle.db, { now: () => new Date(now) })
    assert.equal(stopped.requested, false)
    assert.equal(stopped.state, 'off')
    assert.throws(() => assertRealBettingRequested(handle.db), /real-betting-not-requested/)
    const states = Object.fromEntries(handle.db.prepare('SELECT child_order_id,status FROM bet_child_orders ORDER BY child_order_id').all().map((row) => [row.child_order_id, row.status]))
    assert.deepEqual(states, { dispatched: 'submit_dispatched', 'mixed-accepted': 'accepted', 'mixed-reserved': 'cancelled', prepared: 'submit_prepared', 'preview-reserved': 'reserved', reserved: 'cancelled', 'terminal-reserved': 'reserved', unknown: 'unknown' })
    assert.deepEqual({ ...handle.db.prepare("SELECT status,reserved_amount_minor,accepted_amount_minor,unfilled_amount_minor,finish_reason FROM bet_batches WHERE batch_id='mixed-b'").get() }, {
      status: 'partial', reserved_amount_minor: 0, accepted_amount_minor: 10, unfilled_amount_minor: 90, finish_reason: 'real_betting_stopped',
    })
    assert.equal(handle.db.prepare("SELECT reserved_amount_minor FROM execution_authorizations WHERE authorization_id='auth'").get().reserved_amount_minor, 0)
  } finally {
    handle.close()
  }
})

test('stop rolls back intent and child cancellation when authorization reserved CAS is inconsistent', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const now = '2026-07-11T02:00:00.000Z'
  try {
    handle.db.prepare("INSERT INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at) VALUES ('r','R','CNY',2,10,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO betting_accounts (id,label,username,status,currency,amount_scale,per_bet_limit_minor,stake_step_minor,created_at,updated_at) VALUES ('a','A','u','enabled','CNY',2,10,1,?,?)").run(now, now)
    handle.db.prepare("INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES ('s','k','v',1,'ready',?,?,'{}')").run(now, '2026-07-11T03:00:00.000Z')
    handle.db.prepare("INSERT INTO execution_authorizations (authorization_id,currency,amount_scale,rule_ids_json,max_total_amount_minor,hard_cap_amount_minor,reserved_amount_minor,valid_from,expires_at,status,created_at,updated_at) VALUES ('auth','CNY',2,'[\"r\"]',10,10,0,?,?,'active',?,?)").run(now, '2026-07-11T03:00:00.000Z', now, now)
    handle.db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,authorization_id,currency,amount_scale,target_amount_minor,reserved_amount_minor,status,created_at) VALUES ('b','s','r','auth','CNY',2,10,10,'submitting',?)").run(now)
    handle.db.prepare("INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,requested_amount_minor,status,created_at) VALUES ('child','b','a',10,'reserved',?)").run(now)
    handle.db.prepare("INSERT INTO execution_authorization_child_budgets (child_order_id,authorization_id,batch_id,account_id,amount_minor,status,created_at,updated_at) VALUES ('child','auth','b','a',10,'reserved',?,?)").run(now, now)
    requestRealBettingStart(handle.db, READY, { now: () => new Date(now) })

    assert.throws(() => requestRealBettingStop(handle.db, { now: () => new Date(now) }), /real-betting-stop-authorization-cas/)
    assert.equal(handle.db.prepare("SELECT status FROM bet_child_orders WHERE child_order_id='child'").get().status, 'reserved')
    assert.equal(handle.db.prepare("SELECT status FROM execution_authorization_child_budgets WHERE child_order_id='child'").get().status, 'reserved')
    assert.equal(getRealBettingStatus(handle.db).state, 'running')
  } finally { handle.close() }
})
