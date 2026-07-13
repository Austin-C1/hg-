import { createHash, randomUUID } from 'node:crypto'

import { decryptSecret } from '../app/app-secret.mjs'
import { isSafetyFinishReason } from './safety-finish-reasons.mjs'
const BACKOFF_SECONDS = [5, 15, 45]

function dbOf(database) {
  const db = database?.db || database
  if (!db?.prepare || !db?.exec) throw new TypeError('b2-reconciler-db')
  return db
}

function required(value, code) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(code)
  return text
}

function iso(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('b2-reconciler-time')
  return date.toISOString()
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function hashPayload(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

function assertLease(lease) {
  if (!lease || typeof lease.assertFence !== 'function') throw new TypeError('b2-reconciler-lease')
  if (!/^betting-reconciler:\S+$/.test(String(lease.leaseKey || ''))) throw new TypeError('b2-reconciler-lease-key')
  const token = lease.fencingToken
  if (!Number.isSafeInteger(token) || token < 1) throw new Error('executor-fence-stale')
  lease.assertFence(token)
  return token
}

function assertDbLease(db, lease, now) {
  const at = iso(now)
  const token = lease.fencingToken
  const row = db.prepare(`
    SELECT fencing_token, expires_at
    FROM runtime_leases
    WHERE lease_key=? AND owner_id=?
  `).get(lease.leaseKey, lease.ownerId)
  if (
    !row
    || Number(row.fencing_token) !== token
    || !Number.isFinite(Date.parse(row.expires_at))
    || Date.parse(row.expires_at) <= Date.parse(at)
  ) throw new Error('executor-fence-stale')
  return { token, at }
}

function providerCiphertext(value, { childOrderId, submitAttemptId, secretOptions, requiredValue = false } = {}) {
  const text = String(value || '')
  if (!text) {
    if (requiredValue) throw new Error('provider-reference-ciphertext')
    return ''
  }
  const parts = text.split(':')
  if (parts.length !== 4 || parts[0] !== 'v2' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('provider-reference-ciphertext')
  }
  try {
    decryptSecret(text, {
      ...secretOptions,
      context: {
        purpose: 'crown-provider-reference',
        childOrderId: required(childOrderId, 'child-order-id'),
        submitAttemptId: required(submitAttemptId, 'submit-attempt-id'),
      },
    })
  } catch {
    throw new Error('provider-reference-ciphertext')
  }
  return text
}

function fault(injector, phase, details = {}) {
  if (injector === undefined || injector === null) return
  if (typeof injector !== 'function') throw new TypeError('b2-reconciler-fault-injector')
  injector(phase, details)
}

function attemptContext(db, submitAttemptId) {
  const row = db.prepare(`
    SELECT attempt.*, child.batch_id, child.account_id, child.requested_amount_minor,
      child.status AS child_status, batch.target_amount_minor, batch.finished_at, batch.finish_reason,
      batch.locked_selection_identity,
      budget.status AS binding_status, budget.amount_minor AS binding_amount_minor,
      auth.status AS authorization_status
    FROM bet_submit_attempts AS attempt
    JOIN bet_child_orders AS child ON child.child_order_id=attempt.child_order_id
    JOIN bet_batches AS batch ON batch.batch_id=child.batch_id
    JOIN execution_authorization_child_budgets AS budget ON budget.child_order_id=child.child_order_id
    JOIN execution_authorizations AS auth ON auth.authorization_id=attempt.authorization_id
    WHERE attempt.submit_attempt_id=?
  `).get(submitAttemptId)
  if (!row) throw new Error('reconciliation-attempt-not-found')
  return row
}

function stateResult(row) {
  return row ? {
    submitAttemptId: row.submit_attempt_id,
    status: row.status,
    pollCount: Number(row.poll_count),
    nextPollAt: row.next_poll_at,
    deadlineAt: row.deadline_at,
  } : null
}

function evidenceRow(submitAttemptId, source, decision, payload, at, operatorId = '') {
  const payloadHash = hashPayload(payload)
  const evidenceId = createHash('sha256')
    .update(`${submitAttemptId}\0${source}\0${decision}\0${payloadHash}\0${operatorId}`)
    .digest('hex')
  return { evidenceId, submitAttemptId, source, decision, payloadHash, operatorId, observedAt: at }
}

function insertEvidence(db, evidence, at) {
  db.prepare(`
    INSERT INTO bet_reconciliation_evidence (
      evidence_id, submit_attempt_id, source, decision, payload_hash,
      operator_id, observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submit_attempt_id, source, decision, payload_hash) DO NOTHING
  `).run(
    evidence.evidenceId,
    evidence.submitAttemptId,
    evidence.source,
    evidence.decision,
    evidence.payloadHash,
    evidence.operatorId,
    evidence.observedAt,
    at,
  )
}

function recomputeBatch(db, row, decision, at, { hasFutureCapacity = false } = {}) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('reserved','submit_prepared','submit_dispatched') THEN requested_amount_minor ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN status='accepted' THEN requested_amount_minor ELSE 0 END),0) AS accepted,
      COALESCE(SUM(CASE WHEN status='unknown' THEN requested_amount_minor ELSE 0 END),0) AS unknown,
      COALESCE(SUM(CASE WHEN status IN ('reserved','submit_prepared','submit_dispatched') THEN 1 ELSE 0 END),0) AS active
    FROM bet_child_orders WHERE batch_id=?
  `).get(row.batch_id)
  const occupied = BigInt(totals.reserved) + BigInt(totals.accepted) + BigInt(totals.unknown)
  let status
  if (totals.unknown > 0) status = 'waiting_result'
  else if (totals.active > 0) status = 'submitting'
  else if (totals.accepted >= row.target_amount_minor) status = 'completed'
  else if (hasFutureCapacity) status = 'waiting_capacity'
  else if (totals.accepted > 0) status = 'partial'
  else status = 'failed'
  const derivedFinishReason = status === 'waiting_result' ? 'unknown_result'
    : status === 'completed' ? 'all_accepted'
      : status === 'partial' ? 'partial_fulfillment'
        : status === 'failed' ? 'provider_rejected' : ''
  const finishReason = isSafetyFinishReason(row.finish_reason) ? row.finish_reason : derivedFinishReason
  db.prepare(`
    UPDATE bet_batches
    SET reserved_amount_minor=?, accepted_amount_minor=?, unknown_amount_minor=?,
      unfilled_amount_minor=?, status=?, finish_reason=?, finished_at=?
    WHERE batch_id=?
  `).run(
    totals.reserved,
    totals.accepted,
    totals.unknown,
    Number(BigInt(row.target_amount_minor) - occupied),
    status,
    finishReason,
    ['completed', 'partial', 'failed'].includes(status) ? (row.finished_at || at) : '',
    row.batch_id,
  )
  return { status, decision }
}

function enqueueNotification(db, row, decision, at) {
  if (decision !== 'accepted') return
  db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status, status,
      next_attempt_at, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(batch_id, child_order_id, final_status) DO NOTHING
  `).run(
    `bet:${row.batch_id}:${row.child_order_id}:${decision}`,
    row.batch_id,
    row.child_order_id,
    decision,
    at,
    JSON.stringify({ batchId: row.batch_id, childOrderId: row.child_order_id, finalStatus: decision }),
    at,
    at,
  )
}

function writeAudit(db, action, submitAttemptId, details, at) {
  db.prepare(`
    INSERT INTO execution_security_audit (
      audit_id, action, subject_type, subject_id, confirmation_digest, details_json, created_at
    ) VALUES (?, ?, 'submit_attempt', ?, '', ?, ?)
  `).run(randomUUID(), action, submitAttemptId, JSON.stringify(details), at)
}

function resolveUnknown(db, submitAttemptId, decision, {
  now,
  providerReferenceCiphertext = '',
  evidence = [],
  faultInjector,
  secretOptions,
  lease,
  deadlineAt,
  hasFutureCapacity = false,
} = {}) {
  return transaction(db, () => {
    const { at } = assertDbLease(db, lease, now)
    if (deadlineAt && Date.parse(deadlineAt) <= Date.parse(at)) {
      db.prepare(`
        UPDATE bet_reconciliation_state SET status='manual_review', updated_at=?
        WHERE submit_attempt_id=? AND status<>'resolved'
      `).run(at, submitAttemptId)
      return { status: 'manual_review' }
    }
    const row = attemptContext(db, submitAttemptId)
    const state = db.prepare('SELECT * FROM bet_reconciliation_state WHERE submit_attempt_id=?').get(submitAttemptId)
    if (state?.status === 'resolved' && row.status === decision && row.child_status === decision) {
      return { status: 'resolved', finalStatus: decision }
    }
    if (row.status !== 'unknown' || row.child_status !== 'unknown' || row.binding_status !== 'unknown') {
      throw new Error('reconciliation-ledger-not-unknown')
    }
    const encryptedReference = providerCiphertext(providerReferenceCiphertext, {
      childOrderId: row.child_order_id,
      submitAttemptId,
      secretOptions,
      requiredValue: decision === 'accepted',
    })
    for (const item of evidence) insertEvidence(db, item, at)
    db.prepare(`
      UPDATE bet_submit_attempts
      SET status=?, result_at=?, provider_reference_ciphertext=?, error_code='', updated_at=?
      WHERE submit_attempt_id=? AND status='unknown'
    `).run(decision, at, encryptedReference, at, submitAttemptId)
    db.prepare(`
      UPDATE bet_child_orders
      SET status=?, provider_reference_ciphertext=?, error_code='', resolved_at=?
      WHERE child_order_id=? AND status='unknown'
    `).run(decision, encryptedReference, at, row.child_order_id)
    fault(faultInjector, 'reconcile:after-child-update', { submitAttemptId, decision })
    const amount = Number(row.binding_amount_minor)
    const accepted = decision === 'accepted' ? amount : 0
    const authChanged = db.prepare(`
      UPDATE execution_authorizations
      SET unknown_amount_minor=unknown_amount_minor-?,
          accepted_amount_minor=accepted_amount_minor+?, updated_at=?
      WHERE authorization_id=? AND unknown_amount_minor>=?
    `).run(amount, accepted, at, row.authorization_id, amount)
    if (authChanged.changes !== 1) throw new Error('authorization-ledger-invariant')
    const bindingChanged = db.prepare(`
      UPDATE execution_authorization_child_budgets
      SET status=?, updated_at=?
      WHERE child_order_id=? AND status='unknown'
    `).run(decision === 'accepted' ? 'accepted' : 'released', at, row.child_order_id)
    if (bindingChanged.changes !== 1) throw new Error('authorization-child-binding-conflict')
    db.prepare('DELETE FROM betting_account_locks WHERE child_order_id=?').run(row.child_order_id)
    recomputeBatch(db, row, decision, at, {
      hasFutureCapacity: decision === 'rejected' ? false : hasFutureCapacity,
    })
    db.prepare(`
      UPDATE bet_reconciliation_state
      SET status='resolved', last_source=?, last_payload_hash=?, updated_at=?
      WHERE submit_attempt_id=?
    `).run(
      evidence.at(-1)?.source || 'manual',
      evidence.at(-1)?.payloadHash || '',
      at,
      submitAttemptId,
    )
    enqueueNotification(db, row, decision, at)
    writeAudit(db, `reconciliation_${decision}`, submitAttemptId, {
      decision,
      source: evidence.at(-1)?.source || 'manual',
      evidenceHash: evidence.at(-1)?.payloadHash || '',
    }, at)
    return { status: 'resolved', finalStatus: decision }
  })
}

function normalizedEvidence(submitAttemptId, source, result, at) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const strong = result.matchStrength === 'strong' && Number(result.matchCount) === 1
  const requestedDecision = String(result.decision || '')
  const decision = strong && ['accepted', 'rejected'].includes(requestedDecision)
    ? requestedDecision
    : (requestedDecision === 'no_match' ? 'no_match' : 'unknown')
  return {
    evidence: evidenceRow(submitAttemptId, source, decision, result.payload ?? {}, at),
    finalDecision: ['accepted', 'rejected'].includes(decision) ? decision : null,
    providerReferenceCiphertext: result.providerReferenceCiphertext || '',
  }
}

async function callWithDeadline(operation, { timeoutMs, deadlineAt, nowMs }) {
  const remaining = Date.parse(deadlineAt) - nowMs
  const duration = Math.max(1, Math.min(timeoutMs, Number.isFinite(remaining) ? remaining : timeoutMs))
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('reconciliation-source-timeout'))
    }, duration)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class B2Reconciler {
  constructor({
    database,
    lease,
    sourceClient,
    reconciliationMode,
    now = () => new Date(),
    faultInjector = null,
    secretKey,
    requestTimeoutMs = 5_000,
    manualAuthorizer = null,
    hasFutureCapacity = () => true,
  } = {}) {
    this.db = dbOf(database)
    this.lease = lease
    if (!sourceClient || typeof sourceClient.getDangerous !== 'function' || typeof sourceClient.getTodayWagers !== 'function') {
      throw new TypeError('reconciliation-source-client')
    }
    if (reconciliationMode !== undefined && reconciliationMode !== 'fixture') throw new Error('reconciliation-mode-forbidden')
    this.sourceClient = sourceClient
    this.reconciliationMode = reconciliationMode || null
    this.now = now
    this.faultInjector = faultInjector
    this.secretOptions = { secretKey }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
      throw new TypeError('reconciliation-request-timeout')
    }
    if (manualAuthorizer !== null && typeof manualAuthorizer !== 'function') throw new TypeError('manual-authorizer')
    if (typeof hasFutureCapacity !== 'function') throw new TypeError('reconciliation-capacity-resolver')
    this.requestTimeoutMs = requestTimeoutMs
    this.manualAuthorizer = manualAuthorizer
    this.hasFutureCapacity = hasFutureCapacity
  }

  scheduleUnknown({ submitAttemptId, deadlineAt } = {}) {
    assertLease(this.lease)
    const attemptId = required(submitAttemptId, 'submit-attempt-id')
    const deadline = required(deadlineAt, 'reconciliation-deadline')
    if (!Number.isFinite(Date.parse(deadline))) throw new TypeError('reconciliation-deadline')
    return transaction(this.db, () => {
      const { at } = assertDbLease(this.db, this.lease, this.now)
      const attempt = attemptContext(this.db, attemptId)
      if (attempt.status !== 'unknown' || attempt.child_status !== 'unknown') throw new Error('reconciliation-attempt-not-unknown')
      this.db.prepare(`
        INSERT INTO bet_reconciliation_state (
          submit_attempt_id, status, poll_count, next_poll_at, deadline_at, created_at, updated_at
        ) VALUES (?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(submit_attempt_id) DO UPDATE SET
          deadline_at=CASE
            WHEN bet_reconciliation_state.deadline_at <= excluded.deadline_at
              THEN bet_reconciliation_state.deadline_at
            ELSE excluded.deadline_at
          END,
          updated_at=excluded.updated_at
        WHERE bet_reconciliation_state.status <> 'resolved'
      `).run(attemptId, at, deadline, at, at)
      return stateResult(this.db.prepare('SELECT * FROM bet_reconciliation_state WHERE submit_attempt_id=?').get(attemptId))
    })
  }

  async runDue({ submitAttemptId } = {}) {
    assertLease(this.lease)
    const attemptId = required(submitAttemptId, 'submit-attempt-id')
    if (this.reconciliationMode !== 'fixture') return this._deferCapabilityUnavailable(attemptId)
    const fixtureContext = attemptContext(this.db, attemptId)
    let lockedIdentity
    try { lockedIdentity = JSON.parse(String(fixtureContext.locked_selection_identity || '')) } catch {}
    if (lockedIdentity?.provider !== 'fixture') throw new Error('reconciliation-capability-unverified')
    const at = iso(this.now)
    const state = this.db.prepare('SELECT * FROM bet_reconciliation_state WHERE submit_attempt_id=?').get(attemptId)
    if (!state) throw new Error('reconciliation-not-scheduled')
    if (state.status === 'resolved') return { status: 'resolved' }
    if (Date.parse(state.deadline_at) <= Date.parse(at)) {
      transaction(this.db, () => {
        const { at: transactionAt } = assertDbLease(this.db, this.lease, this.now)
        this.db.prepare(`
          UPDATE bet_reconciliation_state SET status='manual_review', updated_at=?
          WHERE submit_attempt_id=? AND status<>'resolved'
        `).run(transactionAt, attemptId)
      })
      return { status: 'manual_review' }
    }
    if (state.next_poll_at && Date.parse(state.next_poll_at) > Date.parse(at)) return stateResult(state)

    const collected = []
    let sourceFailures = 0
    let final = null
    const calls = [
      ['get_dangerous', 'getDangerous'],
      ['today_wagers', 'getTodayWagers'],
    ]
    for (const [source, method] of calls) {
      assertLease(this.lease)
      let result
      try {
        result = await callWithDeadline(
          (signal) => this.sourceClient[method]({
            submitAttemptId: attemptId,
            deadlineAt: state.deadline_at,
            signal,
          }),
          {
            timeoutMs: this.requestTimeoutMs,
            deadlineAt: state.deadline_at,
            nowMs: Date.parse(iso(this.now)),
          },
        )
      } catch {
        sourceFailures += 1
        continue
      }
      assertLease(this.lease)
      try {
        const normalized = normalizedEvidence(attemptId, source, result, at)
        if (normalized) collected.push(normalized.evidence)
        if (normalized?.finalDecision) {
          final = normalized
          break
        }
      } catch {
        sourceFailures += 1
      }
    }
    assertLease(this.lease)
    const settledAt = iso(this.now)
    if (Date.parse(state.deadline_at) <= Date.parse(settledAt)) {
      transaction(this.db, () => {
        const { at: transactionAt } = assertDbLease(this.db, this.lease, this.now)
        this.db.prepare(`
          UPDATE bet_reconciliation_state SET status='manual_review', updated_at=?
          WHERE submit_attempt_id=? AND status<>'resolved'
        `).run(transactionAt, attemptId)
      })
      return { status: 'manual_review' }
    }
    if (final) {
      const context = attemptContext(this.db, attemptId)
      fault(this.faultInjector, 'reconcile:before-transaction', { submitAttemptId: attemptId })
      return resolveUnknown(this.db, attemptId, final.finalDecision, {
        now: this.now,
        providerReferenceCiphertext: final.providerReferenceCiphertext,
        evidence: collected,
        faultInjector: this.faultInjector,
        secretOptions: this.secretOptions,
        lease: this.lease,
        deadlineAt: state.deadline_at,
        hasFutureCapacity: Boolean(this.hasFutureCapacity(context)),
      })
    }
    const nextPollCount = Number(state.poll_count) + 1
    const delay = BACKOFF_SECONDS[Math.min(nextPollCount - 1, BACKOFF_SECONDS.length - 1)]
    const errorCode = calls.length > 0 && sourceFailures === calls.length ? 'reconciliation-sources-unavailable' : ''
    return transaction(this.db, () => {
      const { at: transactionAt } = assertDbLease(this.db, this.lease, this.now)
      if (Date.parse(state.deadline_at) <= Date.parse(transactionAt)) {
        this.db.prepare(`
          UPDATE bet_reconciliation_state SET status='manual_review', updated_at=?
          WHERE submit_attempt_id=? AND status<>'resolved'
        `).run(transactionAt, attemptId)
        return { status: 'manual_review' }
      }
      const nextPollAt = new Date(Date.parse(transactionAt) + delay * 1_000).toISOString()
      for (const evidence of collected) insertEvidence(this.db, evidence, transactionAt)
      this.db.prepare(`
        UPDATE bet_reconciliation_state
        SET status='waiting', poll_count=?, next_poll_at=?,
          last_source=?, last_payload_hash=?, updated_at=?
        WHERE submit_attempt_id=? AND status<>'resolved'
      `).run(
        nextPollCount,
        nextPollAt,
        collected.at(-1)?.source || '',
        collected.at(-1)?.payloadHash || '',
        transactionAt,
        attemptId,
      )
      if (errorCode) {
        this.db.prepare(`
          UPDATE bet_submit_attempts SET error_code=?, updated_at=?
          WHERE submit_attempt_id=? AND status='unknown'
        `).run(errorCode, transactionAt, attemptId)
        writeAudit(this.db, 'reconciliation_source_error', attemptId, { errorCode }, transactionAt)
      }
      return { status: 'waiting', pollCount: nextPollCount, nextPollAt, ...(errorCode ? { errorCode } : {}) }
    })
  }

  _deferCapabilityUnavailable(attemptId) {
    const at = iso(this.now)
    const state = this.db.prepare('SELECT * FROM bet_reconciliation_state WHERE submit_attempt_id=?').get(attemptId)
    if (!state) throw new Error('reconciliation-not-scheduled')
    if (state.status === 'resolved') return { status: 'resolved' }
    if (Date.parse(state.deadline_at) <= Date.parse(at)) {
      return transaction(this.db, () => {
        const { at: transactionAt } = assertDbLease(this.db, this.lease, this.now)
        this.db.prepare(`
          UPDATE bet_reconciliation_state SET status='manual_review', updated_at=?
          WHERE submit_attempt_id=? AND status<>'resolved'
        `).run(transactionAt, attemptId)
        return { status: 'manual_review' }
      })
    }
    if (state.next_poll_at && Date.parse(state.next_poll_at) > Date.parse(at)) return stateResult(state)
    const nextPollCount = Number(state.poll_count) + 1
    const delay = BACKOFF_SECONDS[Math.min(nextPollCount - 1, BACKOFF_SECONDS.length - 1)]
    return transaction(this.db, () => {
      const { at: transactionAt } = assertDbLease(this.db, this.lease, this.now)
      const nextPollAt = new Date(Date.parse(transactionAt) + delay * 1_000).toISOString()
      this.db.prepare(`
        UPDATE bet_reconciliation_state
        SET status='waiting', poll_count=?, next_poll_at=?, updated_at=?
        WHERE submit_attempt_id=? AND status<>'resolved'
      `).run(nextPollCount, nextPollAt, transactionAt, attemptId)
      this.db.prepare(`
        UPDATE bet_submit_attempts SET error_code='reconciliation-capability-unverified', updated_at=?
        WHERE submit_attempt_id=? AND status='unknown'
      `).run(transactionAt, attemptId)
      writeAudit(this.db, 'reconciliation_source_error', attemptId, {
        errorCode: 'reconciliation-capability-unverified',
      }, transactionAt)
      return {
        status: 'waiting',
        pollCount: nextPollCount,
        nextPollAt,
        errorCode: 'reconciliation-capability-unverified',
      }
    })
  }

  resolveManually({
    submitAttemptId,
    decision,
    operatorId,
    evidencePayload,
    providerReferenceCiphertext = '',
  } = {}) {
    assertLease(this.lease)
    if (this.reconciliationMode !== 'fixture') throw new Error('manual-resolution-unavailable')
    if (!this.manualAuthorizer) throw new Error('manual-resolution-unauthorized')
    const attemptId = required(submitAttemptId, 'submit-attempt-id')
    const finalDecision = String(decision || '')
    if (!['accepted', 'rejected'].includes(finalDecision)) throw new TypeError('manual-decision')
    const operator = required(operatorId, 'manual-operator-required')
    if (!evidencePayload || typeof evidencePayload !== 'object' || Array.isArray(evidencePayload)) {
      throw new TypeError('manual-evidence-required')
    }
    const at = iso(this.now)
    const state = this.db.prepare('SELECT status FROM bet_reconciliation_state WHERE submit_attempt_id=?').get(attemptId)
    if (state?.status !== 'manual_review') throw new Error('manual-review-required')
    const fixtureContext = attemptContext(this.db, attemptId)
    let lockedIdentity
    try { lockedIdentity = JSON.parse(String(fixtureContext.locked_selection_identity || '')) } catch {}
    if (lockedIdentity?.provider !== 'fixture') throw new Error('manual-resolution-unavailable')
    const authenticatedOperator = this.manualAuthorizer({ operatorId: operator, submitAttemptId: attemptId })
    if (String(authenticatedOperator || '') !== operator) throw new Error('manual-resolution-unauthorized')
    const context = attemptContext(this.db, attemptId)
    const evidence = evidenceRow(attemptId, 'manual', finalDecision, evidencePayload, at, operator)
    fault(this.faultInjector, 'reconcile:before-transaction', { submitAttemptId: attemptId, manual: true })
    return resolveUnknown(this.db, attemptId, finalDecision, {
      now: this.now,
      providerReferenceCiphertext,
      evidence: [evidence],
      faultInjector: this.faultInjector,
      secretOptions: this.secretOptions,
      lease: this.lease,
      hasFutureCapacity: Boolean(this.hasFutureCapacity(context)),
    })
  }
}
