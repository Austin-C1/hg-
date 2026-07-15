import assert from 'node:assert/strict'
import test from 'node:test'

const modulePromise = import('../src/crown/betting/reconciliation-worker.mjs').catch(() => ({}))

function fakeDatabase(rows) {
  const queries = []
  return {
    queries,
    prepare(sql) {
      queries.push(sql)
      return { all(_now, _limit) { return rows } }
    },
  }
}

test('reconciliation worker scans durable due attempts on start and never creates a Submit', async () => {
  const { ReconciliationWorker } = await modulePromise
  assert.equal(typeof ReconciliationWorker, 'function')

  const calls = []
  const lease = {
    leaseKey: 'betting-reconciler:C:\\data\\crown.sqlite',
    fencingToken: 0,
    ttlMs: 30_000,
    acquire() { this.fencingToken = 7; calls.push('acquire'); return { fencingToken: 7 } },
    assertFence() { calls.push('fence'); return 7 },
    heartbeat() { calls.push('heartbeat') },
    release() { calls.push('release'); return true },
  }
  const db = fakeDatabase([
    { submit_attempt_id: 'attempt-a' },
    { submit_attempt_id: 'attempt-b' },
  ])
  const reconciler = {
    async runDue({ submitAttemptId }) { calls.push(`query:${submitAttemptId}`); return { status: 'waiting' } },
    submit() { throw new Error('submit-must-not-exist') },
  }
  const worker = new ReconciliationWorker({ database: db, reconciler, lease, now: () => new Date('2026-07-15T00:00:00.000Z') })

  worker.start()
  const result = await worker.runOnce()
  worker.stop()

  assert.deepEqual(result, {
    processed: 2,
    results: [
      { submitAttemptId: 'attempt-a', status: 'waiting' },
      { submitAttemptId: 'attempt-b', status: 'waiting' },
    ],
  })
  assert.deepEqual(calls.filter((item) => item.startsWith('query:')), ['query:attempt-a', 'query:attempt-b'])
  assert.match(db.queries[0], /bet_reconciliation_state/)
  assert.match(db.queries[0], /next_poll_at/)
  assert.deepEqual(calls.filter((item) => ['acquire', 'release'].includes(item)), ['acquire', 'release'])
})

test('reconciliation worker due scan resumes from SQLite after a new worker instance', async () => {
  const { ReconciliationWorker } = await modulePromise
  assert.equal(typeof ReconciliationWorker, 'function')
  const processed = []
  const lease = () => ({
    leaseKey: 'betting-reconciler:C:\\data\\crown.sqlite', fencingToken: 1, ttlMs: 30_000,
    acquire() {}, assertFence() {}, heartbeat() {}, release() {},
  })
  const db = fakeDatabase([{ submit_attempt_id: 'persisted-attempt' }])
  for (let restart = 0; restart < 2; restart += 1) {
    const worker = new ReconciliationWorker({
      database: db,
      lease: lease(),
      reconciler: { async runDue(input) { processed.push([restart, input.submitAttemptId]); return { status: 'waiting' } } },
    })
    worker.start()
    await worker.runOnce()
    worker.stop()
  }
  assert.deepEqual(processed, [[0, 'persisted-attempt'], [1, 'persisted-attempt']])
})

test('reconciliation lease heartbeat failure is surfaced through the loop instead of escaping the timer', async () => {
  const { ReconciliationWorker } = await modulePromise
  let heartbeat
  const worker = new ReconciliationWorker({
    database: fakeDatabase([]),
    reconciler: { async runDue() {} },
    lease: {
      leaseKey: 'betting-reconciler:C:\\data\\crown.sqlite', fencingToken: 1, ttlMs: 30_000,
      acquire() {}, assertFence() {}, heartbeat() { throw new Error('reconciler-lease-lost') }, release() {},
    },
    setIntervalFn(callback) { heartbeat = callback; return { unref() {} } },
    clearIntervalFn() {},
  })
  worker.start()
  assert.doesNotThrow(() => heartbeat())
  await assert.rejects(() => worker.runOnce(), /reconciler-lease-lost/)
  worker.stop()
})

test('unsafe browser shutdown can stop local timers without releasing reconciler ownership', async () => {
  const { ReconciliationWorker } = await modulePromise
  let releases = 0
  const worker = new ReconciliationWorker({
    database: fakeDatabase([]),
    reconciler: { async runDue() {} },
    lease: {
      leaseKey: 'betting-reconciler:C:\\data\\crown.sqlite', fencingToken: 1, ttlMs: 30_000,
      acquire() {}, assertFence() {}, heartbeat() {}, release() { releases += 1 },
    },
  })
  worker.start()
  worker.stop({ release: false })
  assert.equal(releases, 0)
})
