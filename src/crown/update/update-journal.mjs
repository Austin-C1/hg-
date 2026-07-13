import { dirname } from 'node:path'

import { readAtomicJson, syncDirectory, writeAtomicJson } from './atomic-json-file.mjs'
import {
  ensureDataDirectory,
  validateDataPath,
} from './safe-data-path.mjs'
import { parseSemver } from './semver.mjs'
import { acquireUpdateProcessLock } from './update-process-lock.mjs'

const FIELDS = Object.freeze([
  'schemaVersion', 'updateId', 'previousVersion', 'candidateVersion', 'backupPath',
  'phase', 'currentSwitched', 'candidatePid', 'candidateInstanceId', 'updatedAt',
])
const PHASES = new Set([
  'preparing', 'backup-complete', 'staged', 'applying', 'health-checking',
  'switch-pending', 'current-switched', 'committed', 'rolling-back', 'rolled-back', 'failed',
])
const TERMINAL = new Set(['committed', 'rolled-back', 'failed'])
const NEXT = Object.freeze({
  preparing: new Set(['backup-complete', 'failed']),
  'backup-complete': new Set(['staged', 'failed']),
  staged: new Set(['applying', 'failed']),
  applying: new Set(['health-checking', 'rolling-back']),
  'health-checking': new Set(['switch-pending', 'rolling-back']),
  'switch-pending': new Set(['current-switched', 'rolling-back']),
  'current-switched': new Set(['committed', 'rolling-back']),
  'rolling-back': new Set(['rolled-back']),
  committed: new Set(),
  'rolled-back': new Set(),
  failed: new Set(),
})
const BACKUP_REQUIRED = new Set([
  'backup-complete', 'staged', 'applying', 'health-checking', 'switch-pending',
  'current-switched', 'committed', 'rolling-back', 'rolled-back',
])
const CANDIDATE_REQUIRED = new Set([
  'health-checking', 'switch-pending', 'current-switched', 'committed',
])
const CANDIDATE_FORBIDDEN = new Set(['preparing', 'backup-complete', 'staged', 'applying', 'failed'])
const SWITCH_FALSE = new Set([
  'preparing', 'backup-complete', 'staged', 'applying', 'health-checking',
  'switch-pending', 'rolled-back', 'failed',
])
const SWITCH_TRUE = new Set(['current-switched', 'committed'])

function codedError(code) {
  return new Error(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nowIso(now) {
  if (now !== undefined && typeof now !== 'function') throw codedError('update-journal-time-source-invalid')
  let value
  try {
    value = now ? now() : new Date()
  } catch {
    throw codedError('update-journal-time-failed')
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw codedError('update-journal-time-invalid')
  return date.toISOString()
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

async function normalizeJournal(value, dataRoot) {
  if (!isPlainObject(value) || Object.keys(value).length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(value, field))) {
    throw codedError('update-journal-schema-invalid')
  }
  if (value.schemaVersion !== 1 || !validId(value.updateId) || !PHASES.has(value.phase)) {
    throw codedError('update-journal-schema-invalid')
  }
  try {
    parseSemver(value.previousVersion)
    parseSemver(value.candidateVersion)
  } catch {
    throw codedError('update-journal-schema-invalid')
  }
  if (value.previousVersion === value.candidateVersion) throw codedError('update-journal-schema-invalid')
  if (typeof value.backupPath !== 'string' || typeof value.currentSwitched !== 'boolean') {
    throw codedError('update-journal-schema-invalid')
  }
  if (value.candidatePid !== null && (!Number.isSafeInteger(value.candidatePid) || value.candidatePid <= 0)) {
    throw codedError('update-journal-schema-invalid')
  }
  if (typeof value.candidateInstanceId !== 'string' || (value.candidateInstanceId && !validId(value.candidateInstanceId))) {
    throw codedError('update-journal-schema-invalid')
  }
  if (typeof value.updatedAt !== 'string') throw codedError('update-journal-schema-invalid')
  const updatedAtMs = Date.parse(value.updatedAt)
  if (!Number.isFinite(updatedAtMs) || new Date(updatedAtMs).toISOString() !== value.updatedAt) {
    throw codedError('update-journal-schema-invalid')
  }

  const hasCandidatePid = value.candidatePid !== null
  const hasCandidateInstance = value.candidateInstanceId !== ''
  if (hasCandidatePid !== hasCandidateInstance) throw codedError('update-journal-schema-invalid')
  if (BACKUP_REQUIRED.has(value.phase) !== (value.backupPath !== '')) {
    if (!(value.phase === 'failed' && value.backupPath !== '')) throw codedError('update-journal-schema-invalid')
  }
  if (value.phase === 'preparing' && value.backupPath !== '') throw codedError('update-journal-schema-invalid')
  if (CANDIDATE_REQUIRED.has(value.phase) && !hasCandidatePid) throw codedError('update-journal-schema-invalid')
  if (CANDIDATE_FORBIDDEN.has(value.phase) && hasCandidatePid) throw codedError('update-journal-schema-invalid')
  if (SWITCH_FALSE.has(value.phase) && value.currentSwitched) throw codedError('update-journal-schema-invalid')
  if (SWITCH_TRUE.has(value.phase) && !value.currentSwitched) throw codedError('update-journal-schema-invalid')

  if (value.backupPath) {
    try {
      await validateDataPath({
        dataRoot,
        targetPath: value.backupPath,
        requireExists: true,
        expectDirectory: false,
      })
    } catch {
      throw codedError('update-journal-schema-invalid')
    }
  }
  return Object.freeze({ ...value })
}

async function journalTarget({ dataRoot, journalPath } = {}) {
  if (typeof dataRoot !== 'string') throw codedError('update-journal-data-root-invalid')
  try {
    return await validateDataPath({ dataRoot, targetPath: journalPath })
  } catch {
    throw codedError('update-journal-path-invalid')
  }
}

export async function readUpdateJournal({ dataRoot, journalPath } = {}) {
  const target = await journalTarget({ dataRoot, journalPath })
  let parsed
  try {
    parsed = await readAtomicJson({ dataRoot: target.dataRoot, filePath: target.path })
  } catch {
    throw codedError('update-journal-read-failed')
  }
  return normalizeJournal(parsed, target.dataRoot)
}

class UpdateJournalSession {
  #dataRoot
  #journalPath
  #releaseLock
  #now
  #state
  #closed = false
  #serial = Promise.resolve()

  constructor({ dataRoot, journalPath, releaseLock, now, state }) {
    this.#dataRoot = dataRoot
    this.#journalPath = journalPath
    this.#releaseLock = releaseLock
    this.#now = now
    this.#state = state
  }

  get state() {
    return structuredClone(this.#state)
  }

  transition(phase, patch = {}) {
    const operation = this.#serial.then(async () => {
      if (this.#closed) throw codedError('update-journal-closed')
      if (!NEXT[this.#state.phase]?.has(phase)) throw codedError('update-journal-transition-invalid')
      const writableByPhase = {
        'backup-complete': new Set(['backupPath']),
        'health-checking': new Set(['candidatePid', 'candidateInstanceId']),
        'current-switched': new Set(['currentSwitched']),
        'rolled-back': new Set(['currentSwitched']),
      }
      const writable = writableByPhase[phase] || new Set()
      if (!isPlainObject(patch) || Object.keys(patch).some((key) => !writable.has(key))) {
        throw codedError('update-journal-patch-invalid')
      }
      const candidate = { ...this.#state, ...patch, phase, updatedAt: nowIso(this.#now) }
      const nextHasCandidate = candidate.candidatePid !== null && candidate.candidateInstanceId !== ''
      if (phase === 'backup-complete' && !candidate.backupPath) throw codedError('update-journal-backup-invalid')
      if (CANDIDATE_REQUIRED.has(phase) && !nextHasCandidate) throw codedError('update-journal-candidate-invalid')
      if (SWITCH_FALSE.has(phase) && candidate.currentSwitched) throw codedError('update-journal-switch-invalid')
      if (SWITCH_TRUE.has(phase) && !candidate.currentSwitched) throw codedError('update-journal-switch-invalid')
      const next = await normalizeJournal(candidate, this.#dataRoot)
      await writeAtomicJson({ dataRoot: this.#dataRoot, filePath: this.#journalPath, value: next })
      this.#state = next
      return this.state
    })
    this.#serial = operation.catch(() => {})
    return operation
  }

  async close() {
    await this.#serial
    if (this.#closed) return
    this.#closed = true
    await this.#releaseLock()
    await syncDirectory({ dataRoot: this.#dataRoot, directoryPath: dirname(this.#journalPath) })
  }
}

export async function startUpdateJournal({
  dataRoot,
  journalPath,
  installationId,
  updateId,
  previousVersion,
  candidateVersion,
  now,
  processIdentityProbe,
} = {}) {
  if (now !== undefined && typeof now !== 'function') throw codedError('update-journal-time-source-invalid')
  const lockCreatedAt = nowIso(now)
  const target = await journalTarget({ dataRoot, journalPath })
  try {
    await ensureDataDirectory({ dataRoot: target.dataRoot, directoryPath: dirname(target.path) })
  } catch {
    throw codedError('update-journal-path-invalid')
  }
  const lockPath = `${target.path}.lock`
  const lock = await acquireUpdateProcessLock({
    dataRoot: target.dataRoot,
    lockPath,
    installationId,
    updateId,
    createdAt: lockCreatedAt,
    processIdentityProbe,
  })
  try {
    const existingPath = await validateDataPath({ dataRoot: target.dataRoot, targetPath: target.path })
    if (existingPath.exists) {
      const existing = await readUpdateJournal({ dataRoot: target.dataRoot, journalPath: target.path })
      if (!TERMINAL.has(existing.phase)) throw codedError('update-journal-incomplete')
    }
    const state = await normalizeJournal({
      schemaVersion: 1,
      updateId,
      previousVersion,
      candidateVersion,
      backupPath: '',
      phase: 'preparing',
      currentSwitched: false,
      candidatePid: null,
      candidateInstanceId: '',
      updatedAt: nowIso(now),
    }, target.dataRoot)
    await writeAtomicJson({ dataRoot: target.dataRoot, filePath: target.path, value: state })
    return new UpdateJournalSession({
      dataRoot: target.dataRoot,
      journalPath: target.path,
      releaseLock: lock.release,
      now,
      state,
    })
  } catch (error) {
    await lock.release().catch(() => {})
    await syncDirectory({ dataRoot: target.dataRoot, directoryPath: dirname(target.path) }).catch(() => {})
    if (error instanceof Error && error.message.startsWith('update-journal-')) throw error
    throw codedError('update-journal-start-failed')
  }
}
