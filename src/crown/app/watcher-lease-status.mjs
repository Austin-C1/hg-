import { watcherLeaseKey } from './watcher-lease-key.mjs'

function milliseconds(value) {
  const date = value instanceof Date ? value : new Date(value)
  return date.getTime()
}

export function inspectWatcherLease(db, {
  dbPath = '', runtimeDir = 'data/runtime', cwd, now = new Date(), freshnessMs = 60_000,
} = {}) {
  const nowMs = milliseconds(now)
  const maxAge = Number.isSafeInteger(freshnessMs) && freshnessMs > 0 ? freshnessMs : 60_000
  if (!Number.isFinite(nowMs) || !dbPath || dbPath === ':memory:') {
    return { row: null, exists: false, leaseActive: false, heartbeatFresh: false, fresh: false }
  }
  let leaseKey = ''
  try { leaseKey = watcherLeaseKey({ dbPath, runtimeDir, cwd }) } catch {}
  const row = leaseKey ? db.prepare(`
    SELECT lease_key, owner_id, fencing_token, heartbeat_at, expires_at
    FROM runtime_leases WHERE lease_key = ? LIMIT 1
  `).get(leaseKey) : null
  const expiresAt = Date.parse(String(row?.expires_at || ''))
  const heartbeatAt = Date.parse(String(row?.heartbeat_at || ''))
  const leaseActive = Boolean(row && Number.isFinite(expiresAt) && expiresAt > nowMs)
  const heartbeatFresh = Boolean(row && Number.isFinite(heartbeatAt) && heartbeatAt <= nowMs && nowMs - heartbeatAt <= maxAge)
  return { row: row || null, exists: Boolean(row), leaseActive, heartbeatFresh, fresh: leaseActive && heartbeatFresh }
}
