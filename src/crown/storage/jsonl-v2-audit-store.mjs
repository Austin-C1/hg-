import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SENSITIVE_KEYS = new Set([
  'accesstoken', 'authorization', 'cookie', 'cookies', 'headers', 'httpheaders',
  'password', 'passwd', 'rawheaders', 'rawhttpheaders', 'refreshtoken', 'session',
  'sessionid', 'storagestate', 'ticket', 'ticketid', 'token',
])
const CANDIDATE_KEYS = new Set(['candidate', 'candidatereason'])

function normalizedKey(key) {
  return String(key).replaceAll(/[-_\s]/g, '').toLowerCase()
}

function ensureFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
}

function assertSafeValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) throw new TypeError('schema-v2 audit facts must not be cyclic')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item, seen)
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key)
      if (SENSITIVE_KEYS.has(normalized)) throw new TypeError(`schema-v2 audit facts contain sensitive key: ${key}`)
      if (CANDIDATE_KEYS.has(normalized)) throw new TypeError(`schema-v2 audit facts must not contain candidate key: ${key}`)
      assertSafeValue(item, seen)
    }
  }
  seen.delete(value)
}

function assertRows(rows, name) {
  if (!Array.isArray(rows)) throw new TypeError(`${name} must be an array`)
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError(`${name} rows must be objects`)
    if (row.schemaVersion !== 2) throw new TypeError(`${name} rows must use schemaVersion 2`)
    assertSafeValue(row)
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value ?? null
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function payloadHash(row) {
  return createHash('sha256').update(stableJson(row)).digest('hex')
}

function withAuditId(row, kind) {
  if (typeof row.auditId === 'string' && row.auditId.trim()) return row
  if (kind === 'change' && typeof row.changeId === 'string' && row.changeId.trim()) {
    return { ...row, auditId: `change:${row.changeId.trim()}` }
  }
  const hash = createHash('sha256').update(stableJson({ kind, row })).digest('hex')
  return { ...row, auditId: `${kind}:${hash}` }
}

function ensureTrailingNewline(file) {
  const fd = fs.openSync(file, 'r+')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return
    const last = Buffer.allocUnsafe(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    if (last[0] !== 0x0a) fs.writeSync(fd, Buffer.from('\n'), 0, 1, size)
  } finally {
    fs.closeSync(fd)
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function lockIsStale(lockPath, staleMs) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    const createdAt = Date.parse(lock.createdAt)
    const timestamp = Number.isFinite(createdAt) ? createdAt : fs.statSync(lockPath).mtimeMs
    if (Date.now() - timestamp > staleMs) return true
    if (!isAlive(Number(lock.pid))) return true
    return false
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs
    } catch {
      return true
    }
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function acquireLock(lockPath, staleMs, writeLockMetadata) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        writeLockMetadata(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token }), 'utf8')
      } catch (writeError) {
        let ownsPath = false
        try {
          ownsPath = sameFile(fs.fstatSync(fd), fs.statSync(lockPath))
        } catch {
          ownsPath = false
        }
        try {
          fs.closeSync(fd)
        } catch {
          // Preserve the metadata write failure.
        }
        if (ownsPath) fs.rmSync(lockPath, { force: true })
        throw writeError
      }
      return { fd, token }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (attempt === 0 && lockIsStale(lockPath, staleMs)) {
        fs.rmSync(lockPath, { force: true })
        continue
      }
      const busy = new Error('schema-v2 audit writer is busy')
      busy.code = 'AUDIT_WRITER_BUSY'
      throw busy
    }
  }
  throw new Error('unable to acquire schema-v2 audit writer lock')
}

function releaseLock(lockPath, lock) {
  try {
    fs.closeSync(lock.fd)
  } finally {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (current.token === lock.token) fs.rmSync(lockPath, { force: true })
    } catch {
      // The lock is already absent or no longer belongs to this writer.
    }
  }
}

function indexSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_facts (
      kind TEXT NOT NULL,
      audit_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      PRIMARY KEY (kind, audit_id)
    );
    CREATE TABLE IF NOT EXISTS audit_file_state (
      kind TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      indexed_offset INTEGER NOT NULL DEFAULT 0
    );
  `)
}

function indexParsedRow(db, kind, row) {
  if (typeof row?.auditId !== 'string' || !row.auditId) return
  const hash = payloadHash(row)
  const existing = db.prepare('SELECT payload_hash FROM audit_facts WHERE kind = ? AND audit_id = ?').get(kind, row.auditId)
  if (existing && existing.payload_hash !== hash) throw new TypeError(`schema-v2 auditId collision: ${row.auditId}`)
  if (!existing) db.prepare('INSERT INTO audit_facts (kind, audit_id, payload_hash) VALUES (?, ?, ?)').run(kind, row.auditId, hash)
}

function scanCompleteLines({ db, kind, file, startOffset, chunkBytes, maxLineBytes }) {
  const fd = fs.openSync(file, 'r')
  let position = startOffset
  let indexedOffset = startOffset
  let pending = Buffer.alloc(0)
  let discarding = false
  const chunk = Buffer.allocUnsafe(chunkBytes)
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position)
      if (!bytesRead) break
      const current = chunk.subarray(0, bytesRead)
      let segmentStart = 0
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] !== 0x0a) continue
        const segment = current.subarray(segmentStart, index)
        if (!discarding && pending.length + segment.length <= maxLineBytes) {
          const line = pending.length ? Buffer.concat([pending, segment]) : segment
          const text = line.toString('utf8').replace(/\r$/, '').trim()
          if (text) {
            try {
              indexParsedRow(db, kind, JSON.parse(text))
            } catch (error) {
              if (/auditId collision/.test(String(error?.message || ''))) throw error
            }
          }
        }
        pending = Buffer.alloc(0)
        discarding = false
        indexedOffset = position + index + 1
        segmentStart = index + 1
      }
      const remainder = current.subarray(segmentStart)
      if (!discarding) {
        if (pending.length + remainder.length > maxLineBytes) {
          pending = Buffer.alloc(0)
          discarding = true
        } else if (remainder.length) {
          pending = pending.length ? Buffer.concat([pending, remainder]) : Buffer.from(remainder)
        }
      }
      position += bytesRead
    }
    return indexedOffset
  } finally {
    fs.closeSync(fd)
  }
}

function syncIndex({ db, kind, file, chunkBytes, maxLineBytes }) {
  const resolved = path.resolve(file)
  const size = fs.statSync(file).size
  let state = db.prepare('SELECT file_path, indexed_offset FROM audit_file_state WHERE kind = ?').get(kind)
  if (!state || state.file_path !== resolved || Number(state.indexed_offset) > size) {
    db.prepare('DELETE FROM audit_facts WHERE kind = ?').run(kind)
    db.prepare(`
      INSERT INTO audit_file_state (kind, file_path, indexed_offset) VALUES (?, ?, 0)
      ON CONFLICT(kind) DO UPDATE SET file_path = excluded.file_path, indexed_offset = 0
    `).run(kind, resolved)
    state = { indexed_offset: 0 }
  }
  const startOffset = Number(state.indexed_offset || 0)
  if (startOffset === size) return
  const indexedOffset = scanCompleteLines({ db, kind, file, startOffset, chunkBytes, maxLineBytes })
  db.prepare('UPDATE audit_file_state SET indexed_offset = ? WHERE kind = ?').run(indexedOffset, kind)
}

function beginWriterTransaction(db) {
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    if (/locked|busy/i.test(String(error?.message || ''))) {
      const busy = new Error('schema-v2 audit writer is busy')
      busy.code = 'AUDIT_WRITER_BUSY'
      throw busy
    }
    throw error
  }
}

function writerError(error) {
  if (error?.code === 'AUDIT_WRITER_BUSY') return error
  if (/locked|busy/i.test(String(error?.message || ''))) {
    const busy = new Error('schema-v2 audit writer is busy', { cause: error })
    busy.code = 'AUDIT_WRITER_BUSY'
    return busy
  }
  return error
}

function rollbackWriterTransaction(db) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // Transaction already ended while propagating the original failure.
  }
}

function missingRows(db, kind, rows) {
  const result = []
  const staged = new Map()
  const select = db.prepare('SELECT payload_hash FROM audit_facts WHERE kind = ? AND audit_id = ?')
  for (const row of rows) {
    const hash = payloadHash(row)
    const previousHash = staged.get(row.auditId) ?? select.get(kind, row.auditId)?.payload_hash
    if (previousHash && previousHash !== hash) throw new TypeError(`schema-v2 auditId collision: ${row.auditId}`)
    if (!previousHash) {
      result.push(row)
      staged.set(row.auditId, hash)
    }
  }
  return result
}

export class JsonlV2AuditStore {
  constructor({
    snapshotsPath = 'data/runtime/crown-v2-snapshots.jsonl',
    changesPath = 'data/runtime/crown-v2-changes.jsonl',
    indexPath = `${snapshotsPath}.audit-index.sqlite`,
    lockPath = `${indexPath}.lock`,
    scanChunkBytes = 64 * 1024,
    maxLineBytes = 8 * 1024 * 1024,
    staleLockMs = 30_000,
    writeLockMetadata = fs.writeFileSync,
  } = {}) {
    this.snapshotsPath = snapshotsPath
    this.changesPath = changesPath
    this.indexPath = indexPath
    this.lockPath = lockPath
    this.scanChunkBytes = Math.max(1024, Number(scanChunkBytes || 0))
    this.maxLineBytes = Math.max(this.scanChunkBytes, Number(maxLineBytes || 0))
    this.staleLockMs = Math.max(1000, Number(staleLockMs || 0))
    this.writeLockMetadata = writeLockMetadata
    this.closed = false
    ensureFile(this.snapshotsPath)
    ensureFile(this.changesPath)
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true })
    const db = new DatabaseSync(this.indexPath)
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 0')
      indexSchema(db)
      this.db = db
    } catch (error) {
      db.close()
      throw writerError(error)
    }
  }

  appendFacts({ snapshots = [], changes = [] } = {}) {
    if (this.closed) throw new Error('schema-v2 audit store is closed')
    const normalizedSnapshots = snapshots.map((row) => withAuditId(row, 'snapshot'))
    const normalizedChanges = changes.map((row) => withAuditId(row, 'change'))
    assertRows(normalizedSnapshots, 'snapshots')
    assertRows(normalizedChanges, 'changes')
    for (const row of [...normalizedSnapshots, ...normalizedChanges]) {
      if (Buffer.byteLength(JSON.stringify(row), 'utf8') > this.maxLineBytes) {
        throw new TypeError(`schema-v2 audit fact exceeds max line bytes: ${row.auditId}`)
      }
    }
    let lock = null
    let transactionOpen = false
    try {
      beginWriterTransaction(this.db)
      transactionOpen = true
      lock = acquireLock(this.lockPath, this.staleLockMs, this.writeLockMetadata)
      const groups = [
        ['snapshot', this.snapshotsPath, normalizedSnapshots],
        ['change', this.changesPath, normalizedChanges],
      ]
      for (const [kind, file, rows] of groups) {
        ensureTrailingNewline(file)
        syncIndex({ db: this.db, kind, file, chunkBytes: this.scanChunkBytes, maxLineBytes: this.maxLineBytes })
        const missing = missingRows(this.db, kind, rows)
        if (missing.length) fs.appendFileSync(file, `${missing.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
        syncIndex({ db: this.db, kind, file, chunkBytes: this.scanChunkBytes, maxLineBytes: this.maxLineBytes })
      }
      this.db.exec('COMMIT')
      transactionOpen = false
      return { snapshots: normalizedSnapshots, changes: normalizedChanges }
    } catch (error) {
      if (transactionOpen) rollbackWriterTransaction(this.db)
      throw writerError(error)
    } finally {
      if (lock) releaseLock(this.lockPath, lock)
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
