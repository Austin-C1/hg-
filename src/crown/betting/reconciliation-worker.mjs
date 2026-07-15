function dbOf(database) {
  const db = database?.db || database
  if (!db?.prepare) throw new TypeError('reconciliation-worker-db')
  return db
}

function timestamp(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('reconciliation-worker-time')
  return date.toISOString()
}

function waitForNextPoll(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

export class ReconciliationWorker {
  constructor({
    database,
    reconciler,
    lease,
    now = () => new Date(),
    batchSize = 20,
    pollIntervalMs = 1_000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.db = dbOf(database)
    if (!reconciler || typeof reconciler.runDue !== 'function') throw new TypeError('reconciliation-worker-reconciler')
    if (!lease || typeof lease.acquire !== 'function' || typeof lease.assertFence !== 'function'
      || typeof lease.heartbeat !== 'function' || typeof lease.release !== 'function'
      || !/^betting-reconciler:\S+$/.test(String(lease.leaseKey || ''))) {
      throw new TypeError('reconciliation-worker-lease')
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new TypeError('reconciliation-worker-batch-size')
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
      throw new TypeError('reconciliation-worker-poll-interval')
    }
    if (!Number.isSafeInteger(lease.ttlMs) || lease.ttlMs < 3) throw new TypeError('reconciliation-worker-lease-ttl')
    this.reconciler = reconciler
    this.lease = lease
    this.now = now
    this.batchSize = batchSize
    this.pollIntervalMs = pollIntervalMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.heartbeatTimer = null
    this.failure = null
    this.started = false
  }

  start() {
    if (this.started) return false
    this.lease.acquire()
    this.lease.assertFence()
    this.started = true
    this.failure = null
    const intervalMs = Math.max(1, Math.floor(this.lease.ttlMs / 3) - 1)
    this.heartbeatTimer = this.setIntervalFn(() => {
      try {
        this.lease.heartbeat()
      } catch (error) {
        this.failure = error
        if (this.heartbeatTimer !== null) this.clearIntervalFn(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
    }, intervalMs)
    this.heartbeatTimer?.unref?.()
    return true
  }

  async runOnce() {
    if (!this.started) throw new Error('reconciliation-worker-not-started')
    if (this.failure) throw this.failure
    this.lease.assertFence()
    const at = timestamp(this.now)
    const rows = this.db.prepare(`
      SELECT submit_attempt_id
      FROM bet_reconciliation_state
      WHERE status IN ('pending','waiting')
        AND (next_poll_at <= ? OR deadline_at <= ?)
      ORDER BY next_poll_at, deadline_at, submit_attempt_id
      LIMIT ?
    `).all(at, at, this.batchSize)
    const results = []
    for (const row of rows) {
      this.lease.assertFence()
      const submitAttemptId = String(row.submit_attempt_id || '')
      if (!submitAttemptId) throw new Error('reconciliation-worker-attempt-id')
      const result = await this.reconciler.runDue({ submitAttemptId })
      results.push({ submitAttemptId, ...result })
    }
    return { processed: results.length, results }
  }

  async run({ signal } = {}) {
    let processed = 0
    while (!signal?.aborted && this.started) {
      const result = await this.runOnce()
      processed += result.processed
      if (!signal?.aborted) await waitForNextPoll(this.pollIntervalMs, signal)
    }
    return { processed }
  }

  stop({ release = true } = {}) {
    if (!this.started) return false
    this.started = false
    if (this.heartbeatTimer !== null) this.clearIntervalFn(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (release) this.lease.release()
    return true
  }
}

export default ReconciliationWorker
