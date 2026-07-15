import fs from 'node:fs'
import path from 'node:path'

import { RuntimeLease } from '../app/runtime-lease.mjs'

function requiredAccountId(value) {
  const accountId = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) {
    throw new TypeError('browser-profile-account-id-invalid')
  }
  return accountId
}

function canonicalDatabasePath(value, cwd) {
  const dbPath = String(value || '').trim()
  if (!dbPath || dbPath === ':memory:') throw new TypeError('browser-profile-db-path-invalid')
  let canonical
  try {
    canonical = fs.realpathSync.native(path.resolve(cwd, dbPath))
  } catch {
    throw new TypeError('browser-profile-db-path-invalid')
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function browserProfileLeaseKey({ dbPath, accountId, cwd = process.cwd() } = {}) {
  return `browser-profile:${canonicalDatabasePath(dbPath, cwd)}:${requiredAccountId(accountId)}`
}

export class BrowserProfileLease extends RuntimeLease {
  constructor({
    db,
    dbPath,
    accountId,
    cwd = process.cwd(),
    heartbeatIntervalMs,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    ...options
  } = {}) {
    super({
      ...options,
      db,
      leaseKey: browserProfileLeaseKey({ dbPath, accountId, cwd }),
    })
    const intervalMs = heartbeatIntervalMs ?? Math.max(1, Math.floor(this.ttlMs / 3))
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs >= this.ttlMs) {
      throw new TypeError('browser-profile-heartbeat-interval-invalid')
    }
    if (typeof setIntervalImpl !== 'function' || typeof clearIntervalImpl !== 'function') {
      throw new TypeError('browser-profile-heartbeat-scheduler-invalid')
    }
    this.heartbeatIntervalMs = intervalMs
    this.setIntervalImpl = setIntervalImpl
    this.clearIntervalImpl = clearIntervalImpl
    this.heartbeatTimer = null
  }

  startHeartbeat({ onError } = {}) {
    if (this.heartbeatTimer !== null) return false
    this.assertFence()
    this.heartbeatTimer = this.setIntervalImpl(() => {
      try {
        this.heartbeat()
      } catch (error) {
        this.stopHeartbeat()
        onError?.(error)
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer?.unref?.()
    return true
  }

  stopHeartbeat() {
    if (this.heartbeatTimer === null) return false
    this.clearIntervalImpl(this.heartbeatTimer)
    this.heartbeatTimer = null
    return true
  }

  release() {
    this.stopHeartbeat()
    return super.release()
  }
}

export default BrowserProfileLease
