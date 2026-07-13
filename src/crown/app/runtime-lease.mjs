import { randomUUID } from 'node:crypto'

function requiredText(value, field) {
  const text = String(value || '').trim()
  if (!text) throw new TypeError(`${field}-required`)
  return text
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('lease-time')
  return date.toISOString()
}

function inImmediateTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // BEGIN can fail before a transaction exists.
    }
    throw error
  }
}

function leaseRow(row) {
  if (!row) return null
  return {
    leaseKey: row.lease_key,
    ownerId: row.owner_id,
    pid: Number(row.pid),
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    fencingToken: Number(row.fencing_token),
  }
}

function staleLeaseError() {
  return Object.assign(new Error('lease-stale'), { code: 'lease-stale' })
}

export class RuntimeLease {
  constructor({
    db,
    leaseKey,
    ownerId = randomUUID(),
    pid = process.pid,
    ttlMs = 15_000,
    now = () => new Date(),
  } = {}) {
    if (!db?.prepare || !db?.exec) throw new TypeError('lease-db')
    if (!Number.isSafeInteger(pid) || pid < 0) throw new TypeError('lease-pid')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('lease-ttl')
    if (typeof now !== 'function') throw new TypeError('lease-now')
    this.db = db
    this.leaseKey = requiredText(leaseKey, 'lease-key')
    this.ownerId = requiredText(ownerId, 'lease-owner')
    this.pid = pid
    this.ttlMs = ttlMs
    this.now = now
    this.fencingToken = null
  }

  acquire() {
    const nowIso = timestamp(this.now())
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString()
    const result = inImmediateTransaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM runtime_leases WHERE lease_key = ?').get(this.leaseKey)
      if (!existing) {
        this.db.prepare(`
          INSERT INTO runtime_leases (
            lease_key, owner_id, pid, acquired_at, heartbeat_at, expires_at, fencing_token
          ) VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(this.leaseKey, this.ownerId, this.pid, nowIso, nowIso, expiresAt)
      } else {
        const existingExpiry = Date.parse(existing.expires_at)
        if (!Number.isFinite(existingExpiry)) {
          const error = new Error('lease-corrupt')
          error.code = 'lease-corrupt'
          throw error
        }
        if (existingExpiry > Date.parse(nowIso)) {
          const error = new Error('lease-active')
          error.code = 'lease-active'
          error.lease = leaseRow(existing)
          throw error
        }
        const nextFence = Number(existing.fencing_token) + 1
        if (!Number.isSafeInteger(nextFence)) throw new RangeError('lease-fence-range')
        this.db.prepare(`
          UPDATE runtime_leases
          SET owner_id = ?, pid = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, fencing_token = ?
          WHERE lease_key = ?
        `).run(this.ownerId, this.pid, nowIso, nowIso, expiresAt, nextFence, this.leaseKey)
      }
      return leaseRow(this.db.prepare('SELECT * FROM runtime_leases WHERE lease_key = ?').get(this.leaseKey))
    })
    this.fencingToken = result.fencingToken
    return result
  }

  assertFence(fencingToken = this.fencingToken) {
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw staleLeaseError()
    const nowIso = timestamp(this.now())
    const row = this.db.prepare(`
      SELECT fencing_token, expires_at
      FROM runtime_leases
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
    `).get(this.leaseKey, this.ownerId, fencingToken)
    const expiryMilliseconds = Date.parse(row?.expires_at)
    if (!row || !Number.isFinite(expiryMilliseconds) || expiryMilliseconds <= Date.parse(nowIso)) throw staleLeaseError()
    return Number(row.fencing_token)
  }

  heartbeat() {
    const fencingToken = this.fencingToken
    if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw staleLeaseError()
    const nowIso = timestamp(this.now())
    const expiresAt = new Date(Date.parse(nowIso) + this.ttlMs).toISOString()
    const result = this.db.prepare(`
      UPDATE runtime_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
        AND julianday(expires_at) IS NOT NULL
        AND julianday(expires_at) > julianday(?)
    `).run(nowIso, expiresAt, this.leaseKey, this.ownerId, fencingToken, nowIso)
    if (result.changes !== 1) throw staleLeaseError()
    return leaseRow(this.db.prepare('SELECT * FROM runtime_leases WHERE lease_key = ?').get(this.leaseKey))
  }

  release() {
    if (!Number.isSafeInteger(this.fencingToken) || this.fencingToken < 1) return false
    const releasedAt = timestamp(this.now())
    const result = this.db.prepare(`
      UPDATE runtime_leases
      SET heartbeat_at = ?, expires_at = ?
      WHERE lease_key = ? AND owner_id = ? AND fencing_token = ?
    `).run(releasedAt, releasedAt, this.leaseKey, this.ownerId, this.fencingToken)
    if (result.changes === 1) this.fencingToken = null
    return result.changes === 1
  }
}
