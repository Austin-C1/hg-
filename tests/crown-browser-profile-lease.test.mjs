import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { BrowserProfileLease } from '../src/crown/runtime/browser-profile-lease.mjs'

function heartbeatFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-profile-heartbeat-'))
  const dbPath = path.join(root, 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  const clock = { value: Date.parse('2026-07-15T00:00:00.000Z') }
  const scheduler = {
    callback: null,
    intervalMs: 0,
    clearCalls: [],
    unrefCalls: 0,
  }
  const timer = { unref() { scheduler.unrefCalls += 1 } }
  const lease = new BrowserProfileLease({
    db: handle.db,
    dbPath,
    accountId: 'account-a',
    ownerId: 'owner-a',
    pid: 101,
    ttlMs: 3_000,
    heartbeatIntervalMs: 1_000,
    now: () => new Date(clock.value),
    setIntervalImpl(callback, intervalMs) {
      scheduler.callback = callback
      scheduler.intervalMs = intervalMs
      return timer
    },
    clearIntervalImpl(value) { scheduler.clearCalls.push(value) },
  })
  t.after(() => {
    handle.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { clock, dbPath, handle, lease, scheduler, timer }
}

test('profile leases canonicalize the database path, isolate accounts, and preserve RuntimeLease fencing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-profile-lease-'))
  const dbPath = path.join(root, 'crown.sqlite')
  const aliasDirectory = path.join(root, 'alias')
  fs.mkdirSync(aliasDirectory)
  const handle = openAppDatabase({ dbPath })
  t.after(() => {
    handle.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const worker = new BrowserProfileLease({
    db: handle.db,
    dbPath,
    accountId: 'account-a',
    ownerId: 'worker-owner',
    pid: 101,
  })
  const manualLogin = new BrowserProfileLease({
    db: handle.db,
    dbPath: path.join(aliasDirectory, '..', 'crown.sqlite'),
    accountId: 'account-a',
    ownerId: 'manual-owner',
    pid: 202,
  })
  const otherAccount = new BrowserProfileLease({
    db: handle.db,
    dbPath,
    accountId: 'account-b',
    ownerId: 'worker-owner',
    pid: 101,
  })

  assert.equal(worker.leaseKey, manualLogin.leaseKey)
  assert.notEqual(worker.leaseKey, otherAccount.leaseKey)
  assert.equal(worker.acquire().fencingToken, 1)
  assert.throws(() => manualLogin.acquire(), /lease-active/)
  assert.equal(otherAccount.acquire().fencingToken, 1)

  handle.db.prepare('UPDATE runtime_leases SET fencing_token = 9 WHERE lease_key = ?').run(worker.leaseKey)
  assert.throws(() => worker.assertFence(), /lease-stale/)
  assert.equal(worker.release(), false)
  assert.equal(otherAccount.release(), true)
})

test('profile heartbeat renews the lease on schedule and stops after a stale fence', (t) => {
  const { clock, handle, lease, scheduler, timer } = heartbeatFixture(t)
  const errors = []
  lease.acquire()

  assert.equal(lease.startHeartbeat({ onError: (error) => errors.push(error) }), true)
  assert.equal(scheduler.intervalMs, 1_000)
  assert.equal(scheduler.unrefCalls, 1)

  clock.value += 1_000
  scheduler.callback()
  assert.equal(
    handle.db.prepare('SELECT expires_at FROM runtime_leases WHERE lease_key = ?').get(lease.leaseKey).expires_at,
    '2026-07-15T00:00:04.000Z',
  )

  handle.db.prepare('UPDATE runtime_leases SET fencing_token = 9 WHERE lease_key = ?').run(lease.leaseKey)
  scheduler.callback()
  assert.match(errors[0]?.message || '', /lease-stale/)
  assert.deepEqual(scheduler.clearCalls, [timer])
  assert.equal(lease.stopHeartbeat(), false)
})

test('stopping profile heartbeat does not shorten the persisted lease expiry', (t) => {
  const { handle, lease, scheduler, timer } = heartbeatFixture(t)
  const acquired = lease.acquire()
  lease.startHeartbeat()

  assert.equal(lease.stopHeartbeat(), true)
  const persisted = handle.db.prepare('SELECT expires_at FROM runtime_leases WHERE lease_key = ?').get(lease.leaseKey)
  assert.equal(persisted.expires_at, acquired.expiresAt)
  assert.deepEqual(scheduler.clearCalls, [timer])
})

test('releasing a profile lease stops heartbeat and preserves the fencing tombstone', (t) => {
  const { clock, dbPath, handle, lease, scheduler, timer } = heartbeatFixture(t)
  const acquired = lease.acquire()
  lease.startHeartbeat()
  clock.value += 500

  assert.equal(lease.release(), true)
  assert.deepEqual(scheduler.clearCalls, [timer])
  const tombstone = handle.db.prepare(
    'SELECT fencing_token, expires_at FROM runtime_leases WHERE lease_key = ?',
  ).get(lease.leaseKey)
  assert.equal(tombstone.fencing_token, acquired.fencingToken)
  assert.equal(tombstone.expires_at, '2026-07-15T00:00:00.500Z')

  const successor = new BrowserProfileLease({
    db: handle.db,
    dbPath,
    accountId: 'account-a',
    ownerId: 'owner-b',
    pid: 202,
    ttlMs: 3_000,
    now: () => new Date(clock.value),
  })
  assert.equal(successor.acquire().fencingToken, acquired.fencingToken + 1)
  assert.equal(successor.release(), true)
})
