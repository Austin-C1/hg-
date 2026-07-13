import { assertRealBettingRequested } from './real-betting-runtime.mjs'

const MODES = new Set(['off', 'simulated', 'preview', 'real'])

export function waitFor(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export class BettingWorker {
  constructor({ mode = 'off', db = null, coordinator = null, inboxStore = null, consumer = null, lease = null, processLease = null, realExecutionGate = assertRealBettingRequested, authorizationId = null, b2Executor = null, b2Reconciler = null, accountPauseFinalizer = null, claimLimit = 10, claimLeaseSeconds = 30 } = {}) {
    if (!MODES.has(mode)) throw new TypeError('betting-worker-mode')
    if (!Number.isSafeInteger(claimLimit) || claimLimit < 1) throw new TypeError('claimLimit')
    if (!Number.isSafeInteger(claimLeaseSeconds) || claimLeaseSeconds < 1) throw new TypeError('claimLeaseSeconds')
    this.mode = mode
    this.db = db
    this.coordinator = coordinator
    this.inboxStore = inboxStore || { claimDue: () => [] }
    this.consumer = consumer || { process: async () => { throw new Error('betting-worker-consumer-unavailable') } }
    this.lease = lease
    this.realExecutionGate = realExecutionGate
    this.processLease = processLease
    this.authorizationId = authorizationId
    this.b2Executor = b2Executor
    this.b2Reconciler = b2Reconciler
    this.accountPauseFinalizer = accountPauseFinalizer
    this.claimLimit = claimLimit
    this.claimLeaseSeconds = claimLeaseSeconds
    this.started = false
  }

  start() {
    if (this.mode === 'off') return null
    if (this.started) return { fencingToken: this.lease.fencingToken }
    if (!this.db?.prepare || !this.coordinator || !this.inboxStore?.claimDue
      || !this.consumer?.process || !this.lease?.acquire) throw new TypeError('betting-worker-dependencies')
    const acquired = this.lease.acquire()
    if (this.mode === 'simulated') this.coordinator.recover(acquired.fencingToken)
    this.started = true
    return acquired
  }

  async runOnce() {
    if (this.mode === 'off') return { mode: 'off', processed: 0, results: [] }
    this.processLease?.assertFence?.(this.processLease.fencingToken)
    if (!this.started) this.start()
    this.lease.assertFence(this.lease.fencingToken)
    if (this.mode === 'real') await this._recoverRealAttempts()
    if (this.mode === 'real') this._finalizeAccountPauses()
    if (this.mode === 'real') this.realExecutionGate(this.db)
    const results = []
    const recoverableBatches = ['simulated', 'real'].includes(this.mode) ? this.db.prepare(`
      SELECT batch_id
      FROM bet_batches
      WHERE status NOT IN ('completed', 'partial', 'failed', 'cancelled')
      ORDER BY created_at, batch_id
    `).all() : []
    for (const batch of recoverableBatches) {
      if (this.mode === 'real') this.realExecutionGate(this.db)
      this.lease.assertFence(this.lease.fencingToken)
      try {
        results.push(await this.coordinator.runBatch(batch.batch_id, { mode: this.mode }))
      } finally {
        if (this.mode === 'real') this._finalizeAccountPauses()
      }
      this.lease.heartbeat()
    }
    if (typeof this.consumer.canProcess === 'function' && this.consumer.canProcess() !== true) {
      this.processLease?.heartbeat?.()
      if (this.mode === 'real') this._finalizeAccountPauses()
      return { mode: this.mode, processed: results.length, results }
    }
    const items = this.inboxStore.claimDue({ limit: this.claimLimit, leaseSeconds: this.claimLeaseSeconds })
    for (const item of items) {
      if (this.mode === 'real') this.realExecutionGate(this.db)
      this.lease.assertFence(this.lease.fencingToken)
      const authorizationId = this.mode === 'real'
        ? (this.authorizationId || this.db.prepare(`
            SELECT authorization_id FROM execution_authorizations
            WHERE status = 'active'
            ORDER BY created_at, authorization_id
            LIMIT 1
          `).get()?.authorization_id || null)
        : null
      try {
        const result = await this.consumer.process(item, { executionMode: this.mode, authorizationId })
        const inboxIdentity = {
          signalId: item.signalId,
          cardId: item.cardId,
          leaseOwner: item.inboxLease?.ownerId,
        }
        if (result?.status === 'batch_created') this.inboxStore.complete({ ...inboxIdentity, batchId: result.batchId })
        else if (result?.status === 'skipped' && result.inboxFinalized !== true) {
          this.inboxStore.skip({ ...inboxIdentity, reason: result.reason })
        }
        else if (result?.status !== 'skipped') throw Object.assign(new Error('consumer-transient'), { code: 'consumer-transient' })
        results.push(result)
      } catch (error) {
        if (String(error?.message || '').includes('inbox-lease-stale')) throw error
        const code = [
          'transient-db', 'lease-lost', 'batch-create-failed', 'consumer-transient',
          'mode-scoped-batch-adapter-unavailable',
        ].includes(error?.code)
          ? error.code
          : 'consumer-transient'
        this.inboxStore.retry({
          signalId: item.signalId,
          cardId: item.cardId,
          leaseOwner: item.inboxLease?.ownerId,
          reason: code,
        })
        results.push({ status: 'retry', errorCode: code })
      } finally {
        if (this.mode === 'real') this._finalizeAccountPauses()
      }
      this.lease.heartbeat()
    }
    this.processLease?.heartbeat?.()
    if (this.mode === 'real') this._finalizeAccountPauses()
    return { mode: this.mode, processed: results.length, results }
  }

  _finalizeAccountPauses() {
    if (this.accountPauseFinalizer === null) return 0
    if (typeof this.accountPauseFinalizer !== 'function') throw new TypeError('account-pause-finalizer')
    return this.accountPauseFinalizer()
  }

  async _recoverRealAttempts() {
    const authorizations = this.db.prepare(`
      SELECT DISTINCT batch.authorization_id
      FROM bet_batches AS batch
      JOIN bet_child_orders AS child ON child.batch_id = batch.batch_id
      WHERE batch.authorization_id IS NOT NULL
        AND child.status IN ('submit_prepared', 'submit_dispatched', 'unknown')
      ORDER BY batch.authorization_id
    `).all()
    if (authorizations.length > 0 && (!this.b2Executor?.recover || !this.b2Reconciler?.scheduleUnknown || !this.b2Reconciler?.runDue)) {
      throw new Error('b2-recovery-dependencies-required')
    }
    for (const row of authorizations) this.b2Executor.recover(row.authorization_id)
    const unknown = this.db.prepare(`
      SELECT attempt.submit_attempt_id, auth.expires_at AS deadline_at
      FROM bet_submit_attempts AS attempt
      JOIN execution_authorizations AS auth ON auth.authorization_id = attempt.authorization_id
      LEFT JOIN bet_reconciliation_state AS state ON state.submit_attempt_id = attempt.submit_attempt_id
      WHERE attempt.status = 'unknown' AND COALESCE(state.status, '') <> 'resolved'
      ORDER BY attempt.submit_attempt_id
    `).all()
    for (const row of unknown) {
      this.b2Reconciler.scheduleUnknown({ submitAttemptId: row.submit_attempt_id, deadlineAt: row.deadline_at })
      await this.b2Reconciler.runDue({ submitAttemptId: row.submit_attempt_id })
    }
  }

  async run({ signal = null, pollIntervalMs = 1000, wait = waitFor } = {}) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new TypeError('pollIntervalMs')
    if (typeof wait !== 'function') throw new TypeError('wait')
    if (this.mode === 'off') return { mode: 'off', iterations: 0, processed: 0 }
    let iterations = 0
    let processed = 0
    while (!signal?.aborted) {
      const result = await this.runOnce()
      iterations += 1
      processed += result.processed
      this.lease.heartbeat()
      this.processLease?.assertFence?.(this.processLease.fencingToken)
      if (signal?.aborted) break
      await wait(pollIntervalMs, signal)
    }
    return { mode: this.mode, iterations, processed }
  }

  stop() {
    if (!this.started) return false
    const released = this.lease.release()
    this.started = false
    return released
  }
}
