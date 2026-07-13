import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value ?? null
}

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function ensureFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
}

function ensureTrailingNewline(file) {
  const fd = fs.openSync(file, 'r+')
  try {
    const size = fs.fstatSync(fd).size
    if (!size) return
    const last = Buffer.allocUnsafe(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    if (last[0] !== 0x0a) fs.writeSync(fd, Buffer.from('\n'), 0, 1, size)
  } finally {
    fs.closeSync(fd)
  }
}

function indexCandidateLine(db, line) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (typeof row?.candidateId !== 'string' || !row.candidateId) return
  const hash = payloadHash(row)
  const existing = db.prepare('SELECT payload_hash FROM candidate_exports WHERE candidate_id = ?').get(row.candidateId)
  if (existing && existing.payload_hash !== hash) throw new TypeError(`candidateId collision in JSONL:${row.candidateId}`)
  if (!existing) db.prepare('INSERT INTO candidate_exports (candidate_id, payload_hash) VALUES (?, ?)').run(row.candidateId, hash)
}

function scanNewCompleteLines(db, file, startOffset, { chunkBytes, maxLineBytes, readSync }) {
  const fd = fs.openSync(file, 'r')
  const chunk = Buffer.allocUnsafe(chunkBytes)
  let position = startOffset
  let indexedOffset = startOffset
  let pending = Buffer.alloc(0)
  let discarding = false
  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position)
      if (!bytesRead) return indexedOffset
      const current = chunk.subarray(0, bytesRead)
      let segmentStart = 0
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] !== 0x0a) continue
        const segment = current.subarray(segmentStart, index)
        if (!discarding && pending.length + segment.length <= maxLineBytes) {
          const line = pending.length ? Buffer.concat([pending, segment]) : segment
          const text = line.toString('utf8').replace(/\r$/, '').trim()
          if (text) indexCandidateLine(db, text)
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
  } finally {
    fs.closeSync(fd)
  }
}

function alignedTailStart(file, startOffset, { chunkBytes, readSync }) {
  if (startOffset <= 0) return 0
  const fd = fs.openSync(file, 'r')
  const previous = Buffer.allocUnsafe(1)
  const chunk = Buffer.allocUnsafe(chunkBytes)
  try {
    if (readSync(fd, previous, 0, 1, startOffset - 1) === 1 && previous[0] === 0x0a) return startOffset
    let position = startOffset
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position)
      if (!bytesRead) return position
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a)
      if (newline >= 0) return position + newline + 1
      position += bytesRead
    }
  } finally {
    fs.closeSync(fd)
  }
}

function syncIndex(db, candidatesPath, scanOptions) {
  const resolved = path.resolve(candidatesPath)
  const size = fs.statSync(candidatesPath).size
  let state = db.prepare('SELECT file_path, indexed_offset, recovery_incomplete FROM candidate_file_state WHERE id = 1').get()
  const reset = !state
    || state.file_path !== resolved
    || Number(state.indexed_offset) > size
    || (Number(state.indexed_offset) === 0 && size > scanOptions.recoveryBytes)
  if (reset) {
    db.prepare('DELETE FROM candidate_exports').run()
    const desiredStart = Math.max(0, size - scanOptions.recoveryBytes)
    const recoveryStart = alignedTailStart(candidatesPath, desiredStart, scanOptions)
    const recoveryIncomplete = desiredStart > 0 ? 1 : 0
    db.prepare(`
      INSERT INTO candidate_file_state (id, file_path, indexed_offset, recovery_incomplete) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        indexed_offset = excluded.indexed_offset,
        recovery_incomplete = excluded.recovery_incomplete
    `).run(resolved, recoveryStart, recoveryIncomplete)
    state = { indexed_offset: recoveryStart, recovery_incomplete: recoveryIncomplete }
  }
  const offset = scanNewCompleteLines(db, candidatesPath, Number(state.indexed_offset || 0), scanOptions)
  db.prepare('UPDATE candidate_file_state SET indexed_offset = ? WHERE id = 1').run(offset)
  return { recoveryIncomplete: Number(state.recovery_incomplete || 0) === 1 }
}

function validateRows(rows, maxLineBytes) {
  if (!Array.isArray(rows)) throw new TypeError('candidates must be an array')
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('candidate rows must be objects')
    if (row.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(String(row.candidateId || ''))) {
      throw new TypeError('candidate rows must have schemaVersion 2 and a canonical candidateId')
    }
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > maxLineBytes) {
      throw new TypeError(`candidate row exceeds max line bytes:${row.candidateId}`)
    }
  }
}

export class JsonlCandidateStore {
  constructor({
    candidatesPath = 'data/runtime/betting-candidates.jsonl',
    indexPath = `${candidatesPath}.candidate-index.sqlite`,
    appendFile = fs.appendFileSync,
    scanChunkBytes = 64 * 1024,
    maxLineBytes = 256 * 1024,
    recoveryBytes = 32 * 1024 * 1024,
    readSync = fs.readSync,
  } = {}) {
    this.candidatesPath = candidatesPath
    this.indexPath = indexPath
    this.appendFile = appendFile
    this.scanOptions = {
      chunkBytes: Math.max(256, Number(scanChunkBytes || 0)),
      maxLineBytes: Math.max(1024, Number(maxLineBytes || 0)),
      readSync,
    }
    this.scanOptions.recoveryBytes = Math.max(
      this.scanOptions.maxLineBytes * 2,
      Number(recoveryBytes || 0),
    )
    this.closed = false
    ensureFile(candidatesPath)
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    this.db = new DatabaseSync(indexPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_exports (
        candidate_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidate_file_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        file_path TEXT NOT NULL,
        indexed_offset INTEGER NOT NULL DEFAULT 0,
        recovery_incomplete INTEGER NOT NULL DEFAULT 0
      );
    `)
    const stateColumns = new Set(this.db.prepare('PRAGMA table_info(candidate_file_state)').all().map((row) => row.name))
    if (!stateColumns.has('recovery_incomplete')) {
      this.db.exec('ALTER TABLE candidate_file_state ADD COLUMN recovery_incomplete INTEGER NOT NULL DEFAULT 0')
    }
  }

  appendCandidates(candidates = []) {
    if (this.closed) throw new Error('candidate JSONL store is closed')
    validateRows(candidates, this.scanOptions.maxLineBytes)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      ensureTrailingNewline(this.candidatesPath)
      const indexState = syncIndex(this.db, this.candidatesPath, this.scanOptions)
      const select = this.db.prepare('SELECT payload_hash FROM candidate_exports WHERE candidate_id = ?')
      const staged = new Map()
      const missing = []
      for (const candidate of candidates) {
        const hash = payloadHash(candidate)
        const existingHash = staged.get(candidate.candidateId) ?? select.get(candidate.candidateId)?.payload_hash
        if (existingHash && existingHash !== hash) throw new TypeError(`candidateId collision in JSONL:${candidate.candidateId}`)
        if (!existingHash) {
          if (indexState.recoveryIncomplete) {
            const error = new Error('candidate-index-rebuild-required')
            error.code = 'CANDIDATE_INDEX_REBUILD_REQUIRED'
            throw error
          }
          staged.set(candidate.candidateId, hash)
          missing.push(candidate)
        }
      }
      if (missing.length) this.appendFile(this.candidatesPath, `${missing.map(JSON.stringify).join('\n')}\n`, 'utf8')
      syncIndex(this.db, this.candidatesPath, this.scanOptions)
      this.db.exec('COMMIT')
      return { appended: missing.length, candidates }
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

export function drainCandidateOutbox({ stateStore, candidateStore, limit = 100 } = {}) {
  if (!stateStore || typeof stateStore.listPendingCandidateExports !== 'function') throw new TypeError('stateStore is required')
  if (!candidateStore || typeof candidateStore.appendCandidates !== 'function') throw new TypeError('candidateStore is required')
  const output = { exported: 0 }
  while (true) {
    const candidates = stateStore.listPendingCandidateExports({ limit })
    if (!candidates.length) return output
    candidateStore.appendCandidates(candidates)
    const ids = candidates.map((candidate) => candidate.candidateId)
    const delivered = stateStore.markCandidateExportsDelivered(ids)
    if (delivered !== ids.length) throw new Error('candidate export acknowledgement was incomplete')
    output.exported += ids.length
  }
}
