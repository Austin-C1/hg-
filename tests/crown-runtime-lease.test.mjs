import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'

function clock(initial = '2026-07-11T02:00:00.000Z') {
  let value = Date.parse(initial)
  return {
    now: () => new Date(value),
    advance(milliseconds) { value += milliseconds },
  }
}

test('acquires, heartbeats, and releases a new lease with one fence', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const lease = new RuntimeLease({
      db: handle.db,
      leaseKey: 'betting-executor:test',
      ownerId: 'owner-a',
      pid: 101,
      ttlMs: 10_000,
      now: time.now,
    })
    assert.deepEqual(lease.acquire(), {
      leaseKey: 'betting-executor:test',
      ownerId: 'owner-a',
      pid: 101,
      acquiredAt: '2026-07-11T02:00:00.000Z',
      heartbeatAt: '2026-07-11T02:00:00.000Z',
      expiresAt: '2026-07-11T02:00:10.000Z',
      fencingToken: 1,
    })
    assert.equal(lease.assertFence(), 1)

    time.advance(2_000)
    assert.equal(lease.heartbeat().expiresAt, '2026-07-11T02:00:12.000Z')
    assert.equal(lease.release(), true)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM runtime_leases').get().count, 1)
    assert.equal(handle.db.prepare('SELECT expires_at FROM runtime_leases').get().expires_at, '2026-07-11T02:00:02.000Z')
  } finally {
    handle.close()
  }
})

test('rejects an active second owner and atomically increments the fence after expiry', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const first = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-a', ttlMs: 1_000, now: time.now })
    const second = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-b', ttlMs: 1_000, now: time.now })
    assert.equal(first.acquire().fencingToken, 1)
    assert.throws(() => second.acquire(), /lease-active/)

    time.advance(1_001)
    assert.equal(second.acquire().fencingToken, 2)
    assert.throws(() => first.heartbeat(), /lease-stale/)
    assert.throws(() => first.assertFence(), /lease-stale/)
    assert.equal(first.release(), false)
    assert.equal(second.assertFence(), 2)
  } finally {
    handle.close()
  }
})

test('heartbeat and assertFence use owner plus fencing token CAS', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const lease = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-a', ttlMs: 5_000, now: time.now })
    lease.acquire()
    handle.db.prepare('UPDATE runtime_leases SET fencing_token = 9 WHERE lease_key = ?').run('executor')
    assert.throws(() => lease.heartbeat(), /lease-stale/)
    assert.throws(() => lease.assertFence(), /lease-stale/)
  } finally {
    handle.close()
  }
})

test('release keeps a tombstone so a later owner receives a strictly higher fence', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const first = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-a', ttlMs: 1_000, now: time.now })
    const second = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-b', ttlMs: 1_000, now: time.now })
    const third = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-c', ttlMs: 1_000, now: time.now })
    assert.equal(first.acquire().fencingToken, 1)
    time.advance(1_001)
    assert.equal(second.acquire().fencingToken, 2)
    assert.equal(second.release(), true)
    assert.equal(third.acquire().fencingToken, 3)
    assert.throws(() => second.assertFence(2), /lease-stale/)
  } finally {
    handle.close()
  }
})

test('corrupted persisted expiry fails closed for the current owner', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const lease = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-a', ttlMs: 1_000, now: time.now })
    lease.acquire()
    handle.db.prepare("UPDATE runtime_leases SET expires_at = 'not-a-time' WHERE lease_key = 'executor'").run()
    assert.throws(() => lease.assertFence(), /lease-stale/)
    assert.throws(() => lease.heartbeat(), /lease-stale/)
  } finally {
    handle.close()
  }
})

test('a second owner cannot take over a lease with corrupted persisted expiry', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const time = clock()
  try {
    const first = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-a', ttlMs: 1000, now: time.now })
    const second = new RuntimeLease({ db: handle.db, leaseKey: 'executor', ownerId: 'owner-b', ttlMs: 1000, now: time.now })
    first.acquire()
    handle.db.prepare("UPDATE runtime_leases SET expires_at = 'corrupt' WHERE lease_key = 'executor'").run()
    assert.throws(() => second.acquire(), /lease-corrupt/)
    const row = handle.db.prepare("SELECT owner_id, fencing_token FROM runtime_leases WHERE lease_key = 'executor'").get()
    assert.equal(row.owner_id, 'owner-a')
    assert.equal(row.fencing_token, 1)
  } finally {
    handle.close()
  }
})
