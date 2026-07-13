const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SKIP_REASONS = new Set([
  'betting-mode-disabled', 'migration-review-required', 'real-eligibility-required',
  'global-real-betting-off', 'target-odds-out-of-range', 'market-changed',
  'signal-invalid', 'preview-incomplete', 'no-account-capacity', 'market-already-claimed',
  'water-down-alert-only', 'rule-deleted',
  'card-version-changed', 'card-snapshot-changed',
])
const ERROR_CODES = new Set([
  'transient-db', 'lease-lost', 'batch-create-failed', 'consumer-transient',
  'mode-scoped-batch-adapter-unavailable',
])
const RETRY_SECONDS = [5, 15, 45]

function text(value) { return String(value ?? '').trim() }

function canonicalNow(clock) {
  const value = clock()
  const iso = value instanceof Date ? value.toISOString() : String(value || '')
  if (!UTC_TIMESTAMP.test(iso) || new Date(iso).toISOString() !== iso) throw new TypeError('canonical-clock')
  return iso
}

function plusSeconds(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

function parsedItem(row) {
  let cardSnapshot
  let signal
  try {
    cardSnapshot = JSON.parse(row.card_snapshot_json)
    signal = JSON.parse(row.payload_json)
  } catch { return null }
  if (!cardSnapshot || typeof cardSnapshot !== 'object' || Array.isArray(cardSnapshot)
    || !signal || typeof signal !== 'object' || Array.isArray(signal)
    || !['prematch', 'live'].includes(row.mode)
    || !text(row.card_id) || !Number.isSafeInteger(row.card_version) || row.card_version < 1
    || cardSnapshot.cardId !== row.card_id || cardSnapshot.version !== row.card_version
    || Object.hasOwn(cardSnapshot, 'mode')
    || signal.signalId !== row.signal_id || signal.evidence?.mode !== row.mode) return null
  return {
    signalId: row.signal_id,
    cardId: row.card_id,
    cardVersion: row.card_version,
    cardSnapshot,
    bettingMode: row.mode,
    settingsVersion: row.card_version,
    settingsSnapshot: { ...cardSnapshot, mode: row.mode },
    signal,
    attempts: row.attempts,
    createdAt: row.created_at,
  }
}

export function terminateRuleCardInboxBeforeDelete(db, { cardId, now } = {}) {
  if (!db?.prepare) throw new TypeError('db is required')
  const id = text(cardId)
  if (!id) throw new TypeError('cardId is required')
  const updatedAt = now instanceof Date ? now.toISOString() : String(now || '')
  if (!UTC_TIMESTAMP.test(updatedAt) || new Date(updatedAt).toISOString() !== updatedAt) throw new TypeError('canonical-clock')
  return Number(db.prepare(`
    UPDATE auto_betting_signal_inbox
    SET status='skipped', skip_reason='rule-deleted', next_attempt_at='',
        lease_owner='', lease_expires_at='', updated_at=?
    WHERE card_id=? AND batch_id IS NULL AND status IN ('pending','retry','processing')
  `).run(updatedAt, id).changes || 0)
}

export class AutoBettingInboxStore {
  constructor({ db, now, ownerId } = {}) {
    if (!db?.prepare || !db?.exec) throw new TypeError('db is required')
    if (typeof now !== 'function') throw new TypeError('canonical clock is required')
    if (!text(ownerId)) throw new TypeError('ownerId is required')
    this.db = db
    this.now = now
    this.ownerId = text(ownerId)
  }

  claimDue({ limit = 10, leaseSeconds = 30 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit')
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) throw new TypeError('leaseSeconds')
    const now = canonicalNow(this.now)
    const expiresAt = plusSeconds(now, leaseSeconds)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db.prepare(`
        SELECT inbox.*, signal.payload_json
        FROM auto_betting_signal_inbox AS inbox
        LEFT JOIN monitor_signals AS signal ON signal.signal_id = inbox.signal_id
        WHERE ((inbox.status IN ('pending','retry') AND inbox.next_attempt_at <= ?)
          OR (inbox.status = 'processing' AND inbox.lease_expires_at <= ?))
        ORDER BY inbox.created_at, inbox.signal_id, inbox.card_id
        LIMIT ?
      `).all(now, now, limit)
      const claimed = []
      for (const row of rows) {
        const updated = this.db.prepare(`
          UPDATE auto_betting_signal_inbox
          SET status='processing', lease_owner=?, lease_expires_at=?, updated_at=?
          WHERE signal_id=? AND card_id=? AND ((status IN ('pending','retry') AND next_attempt_at <= ?)
            OR (status='processing' AND lease_expires_at <= ?))
        `).run(this.ownerId, expiresAt, now, row.signal_id, row.card_id, now, now)
        if (updated.changes !== 1) continue
        const item = parsedItem(row)
        if (item) claimed.push({ ...item, inboxLease: { ownerId: this.ownerId, expiresAt } })
        else this.db.prepare(`
          UPDATE auto_betting_signal_inbox
          SET status='dead_letter', skip_reason='signal-invalid', next_attempt_at='',
              lease_owner='', lease_expires_at='', updated_at=?
          WHERE signal_id=? AND card_id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?
        `).run(now, row.signal_id, row.card_id, this.ownerId, now)
      }
      this.db.exec('COMMIT')
      return claimed
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  complete({ signalId, cardId, leaseOwner, batchId } = {}) {
    const id = text(batchId)
    if (!id) throw new TypeError('batchId is required')
    if (text(leaseOwner) !== this.ownerId) throw new Error('inbox-lease-stale')
    const existing = this.db.prepare(`SELECT 1 FROM auto_betting_signal_inbox
      WHERE signal_id=? AND card_id=? AND status='batch_created' AND batch_id=?
        AND lease_owner='' AND lease_expires_at=''`).get(text(signalId), text(cardId), id)
    if (existing) return true
    return this.#finish({ signalId, cardId, leaseOwner }, `status='batch_created', batch_id=?, skip_reason='', next_attempt_at=''`, [id])
  }

  skip({ signalId, cardId, leaseOwner, reason } = {}) {
    if (!SKIP_REASONS.has(reason)) throw new TypeError('skip-reason')
    return this.#finish({ signalId, cardId, leaseOwner }, `status='skipped', batch_id=NULL, skip_reason=?, next_attempt_at=''`, [reason])
  }

  retry({ signalId, cardId, leaseOwner, reason } = {}) {
    if (!ERROR_CODES.has(reason)) throw new TypeError('error-code')
    const now = canonicalNow(this.now)
    const row = this.#ownedRow({ signalId, cardId, leaseOwner }, now)
    const attempts = row.attempts + 1
    const dead = attempts > RETRY_SECONDS.length
    const result = this.db.prepare(`
      UPDATE auto_betting_signal_inbox
      SET status=?, attempts=?, next_attempt_at=?, skip_reason=?, batch_id=NULL,
          lease_owner='', lease_expires_at='', updated_at=?
      WHERE signal_id=? AND card_id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?
    `).run(dead ? 'dead_letter' : 'retry', attempts, dead ? '' : plusSeconds(now, RETRY_SECONDS[attempts - 1]), reason, now, text(signalId), text(cardId), text(leaseOwner), now)
    if (result.changes !== 1) throw new Error('inbox-lease-stale')
    return { status: dead ? 'dead_letter' : 'retry', attempts }
  }

  #ownedRow({ signalId, cardId, leaseOwner }, now) {
    if (!text(signalId) || !text(cardId) || text(leaseOwner) !== this.ownerId) throw new Error('inbox-lease-stale')
    const row = this.db.prepare(`
      SELECT attempts FROM auto_betting_signal_inbox
      WHERE signal_id=? AND card_id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?
    `).get(text(signalId), text(cardId), text(leaseOwner), now)
    if (!row) throw new Error('inbox-lease-stale')
    return row
  }

  #finish(identity, assignment, values) {
    const now = canonicalNow(this.now)
    this.#ownedRow(identity, now)
    const result = this.db.prepare(`
      UPDATE auto_betting_signal_inbox SET ${assignment}, lease_owner='', lease_expires_at='', updated_at=?
      WHERE signal_id=? AND card_id=? AND status='processing' AND lease_owner=? AND lease_expires_at>?
    `).run(...values, now, text(identity.signalId), text(identity.cardId), text(identity.leaseOwner), now)
    if (result.changes !== 1) throw new Error('inbox-lease-stale')
    return true
  }
}
