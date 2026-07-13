const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000])
const MAX_BATCH_SIZE = 100

function databaseOf(value) {
  const db = value?.db || value
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('notification-dispatcher-database')
  }
  return db
}

function requiredOwner(value) {
  const ownerId = String(value || '').trim()
  if (!ownerId || ownerId.length > 128) throw new TypeError('notification-dispatcher-owner')
  return ownerId
}

function positiveInteger(value, code, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(code)
  return value
}

function instant(now) {
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('notification-dispatcher-clock')
  return date
}

function immediate(db, operation) {
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

function safePayload(row) {
  return Object.freeze({
    notificationId: row.notification_id,
    batchId: row.batch_id,
    childOrderId: row.child_order_id,
    finalStatus: row.final_status,
    createdAt: row.created_at,
  })
}

function safeDeliveryState(value) {
  const deliveredChatTargets = Array.isArray(value?.deliveredChatTargets)
    ? [...new Set(value.deliveredChatTargets.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100)
    : []
  return Object.freeze({ deliveredChatTargets })
}

function deliveryStateFromRow(row) {
  try { return safeDeliveryState(JSON.parse(String(row.payload_json || '{}')).deliveryState) } catch { return safeDeliveryState() }
}

function payloadJson(row, deliveryState) {
  return JSON.stringify({
    batchId: row.batch_id,
    childOrderId: row.child_order_id,
    finalStatus: row.final_status,
    deliveryState: safeDeliveryState(deliveryState),
  })
}

function safeErrorCode(value, fallback = 'notification-send-failed') {
  const code = String(value || '').trim().toLowerCase()
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) && code.length <= 64 ? code : fallback
}

export class B2OutcomeDispatcher {
  constructor({
    db,
    ownerId,
    sender,
    now = () => new Date(),
    batchSize = 25,
    leaseMs = 30_000,
    sendTimeoutMs = null,
  } = {}) {
    this.db = databaseOf(db)
    this.ownerId = requiredOwner(ownerId)
    if (typeof sender !== 'function') throw new TypeError('notification-dispatcher-sender')
    if (typeof now !== 'function') throw new TypeError('notification-dispatcher-clock')
    this.sender = sender
    this.now = now
    this.batchSize = positiveInteger(batchSize, 'notification-dispatcher-batch-size', MAX_BATCH_SIZE)
    this.leaseMs = positiveInteger(leaseMs, 'notification-dispatcher-lease-ms', 3_600_000)
    this.sendTimeoutMs = sendTimeoutMs === null
      ? Math.max(1, Math.min(5_000, this.leaseMs - 1))
      : positiveInteger(sendTimeoutMs, 'notification-dispatcher-send-timeout', 60_000)
    if (this.sendTimeoutMs >= this.leaseMs) throw new TypeError('notification-dispatcher-send-timeout')
  }

  async #send(row) {
    const controller = new AbortController()
    const workingDeliveryState = {
      deliveredChatTargets: [...deliveryStateFromRow(row).deliveredChatTargets],
    }
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ sent: false, permanent: false, reason: 'notification-send-timeout', deliveryState: safeDeliveryState(workingDeliveryState) })
      }, this.sendTimeoutMs)
      timer.unref?.()
    })
    try {
      const result = await Promise.race([
        Promise.resolve(this.sender(safePayload(row), {
          signal: controller.signal,
          timeoutMs: this.sendTimeoutMs,
          deliveryState: workingDeliveryState,
        })).then((value) => ({
          sent: value === true || value?.sent === true,
          permanent: value?.permanent === true,
          reason: safeErrorCode(value?.reason),
          deliveryState: safeDeliveryState(value?.deliveryState || workingDeliveryState),
        }), () => ({
          sent: false,
          permanent: false,
          reason: 'notification-send-failed',
          deliveryState: safeDeliveryState(workingDeliveryState),
        })),
        timeout,
      ])
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  #claim() {
    const claimedAt = instant(this.now)
    const at = claimedAt.toISOString()
    const leaseExpiresAt = new Date(claimedAt.getTime() + this.leaseMs).toISOString()
    return immediate(this.db, () => {
      const rows = this.db.prepare(`
        SELECT notification_id, batch_id, child_order_id, final_status,
               attempt_count, lease_fencing_token, payload_json, created_at
        FROM bet_notification_outbox
        WHERE final_status='accepted' AND ((
          status='pending' AND (next_attempt_at='' OR next_attempt_at<=?)
        ) OR (
          status='delivering' AND lease_expires_at<>'' AND lease_expires_at<=?
        ))
        ORDER BY notification_id
        LIMIT 1
      `).all(at, at)
      const update = this.db.prepare(`
        UPDATE bet_notification_outbox
        SET status='delivering', attempt_count=attempt_count+1,
            lease_owner=?, lease_fencing_token=lease_fencing_token+1,
            lease_expires_at=?, updated_at=?
        WHERE notification_id=?
      `)
      return rows.map((row) => {
        update.run(this.ownerId, leaseExpiresAt, at, row.notification_id)
        return {
          ...row,
          attempt_count: row.attempt_count + 1,
          lease_fencing_token: row.lease_fencing_token + 1,
        }
      })
    })
  }

  #markDelivered(row, outcome) {
    const at = instant(this.now).toISOString()
    return this.db.prepare(`
      UPDATE bet_notification_outbox
      SET status='delivered', next_attempt_at='', lease_owner='',
          lease_expires_at='', last_error_code='', payload_json=?, delivered_at=?, updated_at=?
      WHERE notification_id=? AND status='delivering'
        AND lease_owner=? AND lease_fencing_token=?
    `).run(payloadJson(row, outcome.deliveryState), at, at, row.notification_id, this.ownerId, row.lease_fencing_token).changes === 1
  }

  #markFailed(row, outcome) {
    const failureAt = instant(this.now)
    const deadLetter = outcome.permanent || row.attempt_count >= 4
    const delay = RETRY_DELAYS_MS[row.attempt_count - 1]
    const nextAttemptAt = deadLetter ? '' : new Date(failureAt.getTime() + delay).toISOString()
    const result = this.db.prepare(`
      UPDATE bet_notification_outbox
      SET status=?, next_attempt_at=?, lease_owner='', lease_expires_at='',
          last_error_code=?, payload_json=?, updated_at=?
      WHERE notification_id=? AND status='delivering'
        AND lease_owner=? AND lease_fencing_token=?
    `).run(
      deadLetter ? 'dead_letter' : 'pending',
      nextAttemptAt,
      safeErrorCode(outcome.reason),
      payloadJson(row, outcome.deliveryState),
      failureAt.toISOString(),
      row.notification_id,
      this.ownerId,
      row.lease_fencing_token,
    )
    if (result.changes !== 1) return 'stale'
    return deadLetter ? 'deadLetter' : 'retried'
  }

  async runOnce() {
    const summary = { claimed: 0, delivered: 0, retried: 0, deadLetter: 0, stale: 0 }
    for (let index = 0; index < this.batchSize; index += 1) {
      const [row] = this.#claim()
      if (!row) break
      summary.claimed += 1
      let outcome
      try {
        outcome = await this.#send(row)
      } catch {
        outcome = { sent: false, permanent: false, reason: 'notification-send-failed', deliveryState: deliveryStateFromRow(row) }
      }
      if (outcome.sent) {
        if (this.#markDelivered(row, outcome)) summary.delivered += 1
        else summary.stale += 1
        continue
      }
      const status = this.#markFailed(row, outcome)
      summary[status] += 1
    }
    return summary
  }
}

export function createTelegramB2OutcomeDispatcher({ telegramConfig, ...options } = {}) {
  const sender = (payload, { signal, deliveryState } = {}) => sendTelegramBetOutcomeAlert(payload, {
    ...(telegramConfig || {}),
    signal,
    deliveryState,
  })
  return new B2OutcomeDispatcher({ ...options, sender })
}

export default B2OutcomeDispatcher
import { sendTelegramBetOutcomeAlert } from '../alerts/telegram-alert.mjs'
