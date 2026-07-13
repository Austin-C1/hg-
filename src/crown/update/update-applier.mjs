import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { readAtomicJson, syncDirectory, writeAtomicJson } from './atomic-json-file.mjs'
import { openVerifiedDataFile, sameFileIdentity, validateDataPath } from './safe-data-path.mjs'
import { createVerifiedSqliteBackup, verifySqliteDatabase } from './sqlite-backup.mjs'
import { compareSemver, parseSemver } from './semver.mjs'
import { readUpdateJournal, startUpdateJournal } from './update-journal.mjs'
import { stableUpdateError, updateError, UpdateError } from './update-error.mjs'
import { acquireUpdateProcessLock } from './update-process-lock.mjs'

const SAFE_RUNTIME_ENV = Object.freeze({
  CROWN_WATCHER_AUTOSTART: '0',
  CROWN_BETTING_WORKER_AUTOSTART: '0',
  CROWN_REAL_BETTING_REQUESTED: '0',
  CROWN_REAL_BETTING_ENABLED: '0',
})
const TERMINAL_PHASES = new Set(['committed', 'rolled-back', 'failed'])
const PRE_APPLY_PHASES = new Set(['preparing', 'backup-complete', 'staged'])
const PROCESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const APPLY_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'operation', 'installationId', 'updateId',
  'previousVersion', 'candidateVersion', 'expectedVersion',
  'dataRoot', 'journalPath', 'dbPath', 'backupPath',
  'appRoot', 'currentPath', 'candidateIdentity', 'oldProcess',
])

export class UpdateCrashSignal extends Error {
  constructor(point) {
    super('update-simulated-crash')
    this.name = 'UpdateCrashSignal'
    this.point = point
  }
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw updateError(code)
  return value
}

function validIso(value) {
  const millis = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(millis) && new Date(millis).toISOString() === value
}

function normalizeProcessRecord(value, code = 'update-process-record-invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw updateError(code)
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !validIso(value.processStartTime)) throw updateError(code)
  if (!PROCESS_ID.test(value.installationId || '') || !PROCESS_ID.test(value.processInstanceId || '')) throw updateError(code)
  if (!TOKEN.test(value.probeToken || '')) throw updateError(code)
  return Object.freeze({
    pid: value.pid,
    processStartTime: value.processStartTime,
    installationId: value.installationId,
    processInstanceId: value.processInstanceId,
    probeToken: value.probeToken,
  })
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeSerializedIdentity(value) {
  if (!plainObject(value)
    || Object.keys(value).sort().join(',') !== 'dev,ino'
    || !/^(0|[1-9][0-9]*)$/.test(value.dev || '')
    || !/^(0|[1-9][0-9]*)$/.test(value.ino || '')) {
    throw updateError('update-apply-request-invalid')
  }
  return Object.freeze({ dev: BigInt(value.dev), ino: BigInt(value.ino) })
}

async function normalizeApplyRequest(value, expectedDataRoot) {
  if (!plainObject(value)
    || Object.keys(value).length !== APPLY_REQUEST_FIELDS.length
    || APPLY_REQUEST_FIELDS.some((field) => !Object.hasOwn(value, field))
    || value.schemaVersion !== 1
    || !['apply', 'recover'].includes(value.operation)
    || !PROCESS_ID.test(value.installationId || '')
    || !PROCESS_ID.test(value.updateId || '')
    || value.dataRoot !== expectedDataRoot) {
    throw updateError('update-apply-request-invalid')
  }
  try {
    parseSemver(value.previousVersion)
    parseSemver(value.candidateVersion)
    parseSemver(value.expectedVersion)
  } catch {
    throw updateError('update-apply-request-invalid')
  }
  if (value.candidateVersion !== value.expectedVersion
    || compareSemver(value.candidateVersion, value.previousVersion) <= 0) {
    throw updateError('update-apply-request-invalid')
  }
  for (const path of [value.journalPath, value.dbPath, value.backupPath]) {
    try { await validateDataPath({ dataRoot: expectedDataRoot, targetPath: path }) } catch {
      throw updateError('update-apply-request-path-invalid')
    }
  }
  try {
    await validateDataPath({ dataRoot: value.appRoot, targetPath: value.currentPath, requireExists: true, expectDirectory: false })
    const expectedCandidateIdentity = normalizeSerializedIdentity(value.candidateIdentity)
    const candidate = await validateDataPath({
      dataRoot: value.appRoot,
      targetPath: join(value.appRoot, 'versions', value.expectedVersion),
      requireExists: true,
      expectDirectory: true,
    })
    if (!sameFileIdentity(candidate.identity, expectedCandidateIdentity)) throw new Error('identity mismatch')
  } catch {
    throw updateError('update-apply-request-path-invalid')
  }
  const oldProcess = normalizeProcessRecord(value.oldProcess, 'update-apply-request-invalid')
  return Object.freeze({ ...value, oldProcess })
}

export async function readUpdateApplyRequest({ dataRoot, requestPath } = {}) {
  let target
  try {
    target = await validateDataPath({ dataRoot, targetPath: requestPath, requireExists: true, expectDirectory: false })
  } catch {
    throw updateError('update-apply-request-path-invalid')
  }
  let value
  try { value = await readAtomicJson({ dataRoot: target.dataRoot, filePath: target.path }) } catch {
    throw updateError('update-apply-request-read-failed')
  }
  return normalizeApplyRequest(value, target.dataRoot)
}

export async function runUpdateApplyRequest({
  dataRoot,
  requestPath,
  createRuntime,
  applyImpl = applyUpdate,
  recoverImpl = recoverUpdate,
} = {}) {
  const runtimeFactory = requiredFunction(createRuntime, 'update-apply-runtime-unavailable')
  const request = await readUpdateApplyRequest({ dataRoot, requestPath })
  let runtime
  try { runtime = await runtimeFactory(request) } catch (error) {
    throw updateError('update-apply-runtime-failed', error)
  }
  if (!plainObject(runtime)) throw updateError('update-apply-runtime-invalid')
  const options = { ...runtime, ...request }
  return request.operation === 'apply'
    ? requiredFunction(applyImpl, 'update-apply-runner-invalid')(options)
    : requiredFunction(recoverImpl, 'update-recovery-runner-invalid')(options)
}

function sameProcess(left, right) {
  return left.pid === right.pid
    && left.processStartTime === right.processStartTime
    && left.installationId === right.installationId
    && left.processInstanceId === right.processInstanceId
    && left.probeToken === right.probeToken
}

async function proveProcessIdentity(record, probeProcess) {
  const expected = normalizeProcessRecord(record)
  let result
  try {
    result = await probeProcess(expected)
  } catch {
    throw updateError('update-process-identity-unavailable')
  }
  if (!result || result.state !== 'alive') throw updateError('update-process-identity-mismatch')
  const actual = normalizeProcessRecord(result, 'update-process-identity-mismatch')
  if (!sameProcess(expected, actual)) throw updateError('update-process-identity-mismatch')
  return expected
}

async function classifyProcessIdentity(record, probeProcess) {
  const expected = normalizeProcessRecord(record)
  let result
  try { result = await probeProcess(expected) } catch { throw updateError('update-process-identity-unavailable') }
  if (result?.state === 'dead') return { state: 'dead', process: expected }
  if (!result || result.state !== 'alive') throw updateError('update-process-identity-mismatch')
  const actual = normalizeProcessRecord(result, 'update-process-identity-mismatch')
  if (!sameProcess(expected, actual)) throw updateError('update-process-identity-mismatch')
  return { state: 'alive', process: expected }
}

async function stopExactProcess(record, {
  probeProcess,
  stopProcess,
  stopTimeoutMs = 5_000,
  stopPollMs = 50,
}) {
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0
    || !Number.isSafeInteger(stopPollMs) || stopPollMs <= 0 || stopPollMs > stopTimeoutMs) {
    throw updateError('update-process-stop-timeout-invalid')
  }
  const proven = await proveProcessIdentity(record, probeProcess)
  let result
  try {
    result = await stopProcess(proven)
  } catch {
    throw updateError('update-process-stop-failed')
  }
  if (!result || result.stopped !== true) throw updateError('update-process-stop-failed')
  const deadline = Date.now() + stopTimeoutMs
  for (;;) {
    const state = await classifyProcessIdentity(proven, probeProcess)
    if (state.state === 'dead') return
    if (Date.now() >= deadline) throw updateError('update-process-still-running')
    await delay(Math.min(stopPollMs, Math.max(1, deadline - Date.now())))
  }
}

async function ensureProcessStopped(record, controls) {
  const state = await classifyProcessIdentity(record, controls.probeProcess)
  if (state.state === 'dead') return
  await stopExactProcess(state.process, controls)
}

function nowIso(now) {
  let value
  try { value = now ? now() : new Date() } catch { throw updateError('update-time-failed') }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw updateError('update-time-invalid')
  return date.toISOString()
}

export async function writeAtomicCurrent({ appRoot, currentPath, version } = {}) {
  try { parseSemver(version) } catch { throw updateError('update-current-version-invalid') }
  try {
    await validateDataPath({ dataRoot: appRoot, targetPath: currentPath })
  } catch {
    throw updateError('update-current-path-invalid')
  }
  try {
    await writeAtomicJson({ dataRoot: appRoot, filePath: currentPath, value: { schemaVersion: 1, version } })
    const published = await readAtomicJson({
      dataRoot: appRoot,
      filePath: currentPath,
      validate(value) {
        if (!value || Object.keys(value).sort().join(',') !== 'schemaVersion,version'
          || value.schemaVersion !== 1 || value.version !== version) throw new Error('invalid')
        return value
      },
    })
    if (published.version !== version) throw new Error('invalid')
  } catch (error) {
    if (error instanceof UpdateError) throw error
    throw updateError('update-current-write-failed')
  }
}

async function copyOpenFile(source, destination) {
  const buffer = Buffer.allocUnsafe(256 * 1024)
  let position = 0
  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written)
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
        throw updateError('update-restore-copy-failed')
      }
      written += result.bytesWritten
    }
    position += bytesRead
  }
}

async function removeSqliteSidecars({ dataRoot, dbPath }) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${dbPath}${suffix}`
    let sidecar
    try { sidecar = await validateDataPath({ dataRoot, targetPath: sidecarPath }) } catch {
      throw updateError('update-restore-sidecar-invalid')
    }
    if (!sidecar.exists) continue
    try {
      const current = await validateDataPath({
        dataRoot,
        targetPath: sidecar.path,
        requireExists: true,
        expectDirectory: false,
      })
      if (!sameFileIdentity(sidecar.identity, current.identity)) throw new Error('changed')
      await rm(sidecar.path)
      const after = await validateDataPath({ dataRoot, targetPath: sidecar.path })
      if (after.exists) throw new Error('still-present')
    } catch {
      throw updateError('update-restore-sidecar-remove-failed')
    }
  }
  await syncDirectory({ dataRoot, directoryPath: dirname(dbPath) })
}

export async function restoreVerifiedSqliteBackup({ dataRoot, backupPath, dbPath, faultInjector } = {}) {
  let source
  let destination
  try {
    source = await validateDataPath({ dataRoot, targetPath: backupPath, requireExists: true, expectDirectory: false })
    destination = await validateDataPath({ dataRoot, targetPath: dbPath, requireExists: true, expectDirectory: false })
  } catch {
    throw updateError('update-restore-path-invalid')
  }
  await verifySqliteDatabase({ dataRoot: source.dataRoot, dbPath: source.path })
  const temporaryPath = join(dirname(destination.path), `.${randomUUID()}.restore.sqlite`)
  let sourceFile
  let temporaryFile
  try {
    sourceFile = await openVerifiedDataFile({
      dataRoot: source.dataRoot,
      filePath: source.path,
      flags: 'r',
      expectedIdentity: source.identity,
    })
    await invokeFault(faultInjector, 'after-source-open')
    temporaryFile = await openVerifiedDataFile({
      dataRoot: source.dataRoot,
      filePath: temporaryPath,
      flags: 'wx+',
      mode: 0o600,
    })
    await copyOpenFile(sourceFile.handle, temporaryFile.handle)
    await temporaryFile.handle.sync()
    const sourceAfterCopy = await validateDataPath({
      dataRoot: source.dataRoot,
      targetPath: source.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(source.identity, sourceAfterCopy.identity)) {
      throw updateError('update-restore-source-changed')
    }
    await sourceFile.handle.close()
    sourceFile = undefined
    await temporaryFile.handle.close()
    temporaryFile = undefined
    await verifySqliteDatabase({ dataRoot: source.dataRoot, dbPath: temporaryPath })
    const beforePublish = await validateDataPath({ dataRoot, targetPath: destination.path, requireExists: true, expectDirectory: false })
    if (beforePublish.identity.dev !== destination.identity.dev || beforePublish.identity.ino !== destination.identity.ino) {
      throw updateError('update-restore-database-changed')
    }
    await removeSqliteSidecars({ dataRoot: source.dataRoot, dbPath: destination.path })
    await invokeFault(faultInjector, 'after-sidecars-removed')
    const afterSidecars = await validateDataPath({
      dataRoot: source.dataRoot,
      targetPath: destination.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(afterSidecars.identity, destination.identity)) {
      throw updateError('update-restore-database-changed')
    }
    await rename(temporaryPath, destination.path)
    await verifySqliteDatabase({ dataRoot: source.dataRoot, dbPath: destination.path })
    await syncDirectory({ dataRoot: source.dataRoot, directoryPath: dirname(destination.path) })
  } catch (error) {
    await sourceFile?.handle.close().catch(() => {})
    await temporaryFile?.handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    if (error instanceof UpdateError) throw error
    throw updateError('update-restore-database-failed')
  }
}

async function invokeFault(faultInjector, point, context = {}) {
  if (faultInjector === undefined) return
  if (typeof faultInjector !== 'function') throw updateError('update-fault-injector-invalid')
  await faultInjector(point, Object.freeze({ ...context }))
}

async function rollbackActive({
  journal, candidateProcess, probeProcess, stopProcess, restoreDatabase, writeCurrent,
  startPrevious, backupPath, dataRoot, dbPath, appRoot, currentPath, previousVersion,
  oldStopped, databaseMayBeMutated,
  stopTimeoutMs, stopPollMs,
  faultInjector,
}) {
  await journal.transition('rolling-back')
  if (candidateProcess) await ensureProcessStopped(candidateProcess, {
    probeProcess, stopProcess, stopTimeoutMs, stopPollMs,
  })
  if (databaseMayBeMutated) {
    await restoreDatabase({ dataRoot, dbPath, backupPath })
    await writeCurrent({ appRoot, currentPath, version: previousVersion })
  }
  await journal.transition('rolled-back', { currentSwitched: false })
  await invokeFault(faultInjector, 'after-rollback-terminal-before-old-start')
  if (oldStopped) {
    await startPrevious({ version: previousVersion, env: { ...SAFE_RUNTIME_ENV } })
    await invokeFault(faultInjector, 'after-old-start')
  }
}

export async function applyUpdate(options = {}) {
  const {
    dataRoot, journalPath, dbPath, backupPath, appRoot, currentPath,
    installationId, updateId, previousVersion, candidateVersion, expectedVersion,
    oldProcess, now, faultInjector,
    stopTimeoutMs = 5_000, stopPollMs = 50,
  } = options
  if (candidateVersion !== expectedVersion) throw updateError('update-expected-version-mismatch')
  if (compareSemver(candidateVersion, previousVersion) <= 0) throw updateError('update-candidate-version-invalid')
  if (!PROCESS_ID.test(installationId || '') || !PROCESS_ID.test(updateId || '')) throw updateError('update-identity-invalid')

  const startJournal = options.startJournal ?? startUpdateJournal
  const createBackup = options.createBackup ?? createVerifiedSqliteBackup
  const probeProcess = requiredFunction(options.probeProcess, 'update-process-probe-required')
  const stopProcess = requiredFunction(options.stopProcess, 'update-process-stop-required')
  const migrateCandidate = requiredFunction(options.migrateCandidate, 'update-migration-runner-required')
  const startCandidate = requiredFunction(options.startCandidate, 'update-candidate-launcher-required')
  const checkHealth = requiredFunction(options.checkHealth, 'update-health-check-required')
  const writeCurrent = options.writeCurrent ?? writeAtomicCurrent
  const restoreDatabase = options.restoreDatabase ?? restoreVerifiedSqliteBackup
  const startPrevious = requiredFunction(options.startPrevious, 'update-previous-launcher-required')
  requiredFunction(startJournal, 'update-journal-runner-invalid')
  requiredFunction(createBackup, 'update-backup-runner-invalid')
  requiredFunction(writeCurrent, 'update-current-writer-invalid')
  requiredFunction(restoreDatabase, 'update-restore-runner-invalid')

  let journal
  let candidateProcess = null
  let oldStopped = false
  let databaseMayBeMutated = false
  try {
    journal = await startJournal({
      dataRoot, journalPath, installationId, updateId, previousVersion, candidateVersion, now,
      processIdentityProbe: options.processIdentityProbe,
    })
    await invokeFault(faultInjector, 'after-journal-start')
    const backup = await createBackup({ dataRoot, sourcePath: dbPath, backupPath })
    if (!backup || backup.path !== backupPath) throw updateError('update-backup-result-invalid')
    await journal.transition('backup-complete', { backupPath })
    await invokeFault(faultInjector, 'after-backup')
    await journal.transition('staged')
    await journal.transition('applying')

    const provenOld = normalizeProcessRecord(oldProcess)
    if (provenOld.installationId !== installationId) throw updateError('update-process-identity-mismatch')
    await ensureProcessStopped(provenOld, { probeProcess, stopProcess, stopTimeoutMs, stopPollMs })
    oldStopped = true
    await invokeFault(faultInjector, 'after-old-stop')

    databaseMayBeMutated = true
    await migrateCandidate({ version: candidateVersion, env: { ...SAFE_RUNTIME_ENV } })
    await invokeFault(faultInjector, 'after-migration')
    let authorizedCandidate = null
    const launchedCandidate = await startCandidate({
      version: candidateVersion,
      env: { ...SAFE_RUNTIME_ENV },
      async authorize(record) {
        if (authorizedCandidate) throw updateError('update-candidate-authorization-reused')
        const candidate = normalizeProcessRecord(record, 'update-candidate-process-invalid')
        if (candidate.installationId !== installationId) throw updateError('update-candidate-process-invalid')
        await journal.transition('health-checking', {
          candidatePid: candidate.pid,
          candidateInstanceId: candidate.processInstanceId,
        })
        authorizedCandidate = candidate
        candidateProcess = candidate
        await invokeFault(faultInjector, 'after-candidate-authorized', { candidatePid: candidate.pid })
      },
    })
    const returnedCandidate = normalizeProcessRecord(launchedCandidate, 'update-candidate-process-invalid')
    if (!candidateProcess) candidateProcess = returnedCandidate
    if (returnedCandidate.installationId !== installationId) throw updateError('update-candidate-process-invalid')
    if (!authorizedCandidate) throw updateError('update-candidate-authorization-missing')
    if (!sameProcess(returnedCandidate, authorizedCandidate)) throw updateError('update-candidate-authorization-mismatch')
    await invokeFault(faultInjector, 'after-candidate-start', { candidatePid: candidateProcess.pid })
    const health = await checkHealth({
      process: candidateProcess,
      expectedVersion: candidateVersion,
      expectedInstallationId: installationId,
      requiredRuntimeState: { watcher: 'stopped', worker: 'stopped', capability: { preview: 0, submit: 0, reconciliation: 0 } },
    })
    if (!health || health.ok !== true) throw updateError('update-candidate-health-failed')
    await invokeFault(faultInjector, 'after-health')
    await journal.transition('switch-pending')
    await writeCurrent({ appRoot, currentPath, version: candidateVersion })
    await journal.transition('current-switched', { currentSwitched: true })
    await invokeFault(faultInjector, 'after-current-switch')
    await journal.transition('committed')
    await journal.close()
    return { ok: true, version: candidateVersion, rolledBack: false }
  } catch (error) {
    if (error instanceof UpdateCrashSignal) {
      await journal?.close().catch(() => {})
      throw error
    }
    const original = stableUpdateError(error, 'update-apply-failed')
    if (journal) {
      try {
        if (original.code === 'update-process-stop-failed') {
          // The stop result is ambiguous. Leave the non-terminal journal for
          // identity-bound launcher recovery instead of touching a live DB.
        } else if (PRE_APPLY_PHASES.has(journal.state.phase)) {
          await journal.transition('failed')
        } else if (!TERMINAL_PHASES.has(journal.state.phase)) {
          await rollbackActive({
            journal, candidateProcess, probeProcess, stopProcess, restoreDatabase, writeCurrent,
            startPrevious, backupPath, dataRoot, dbPath, appRoot, currentPath, previousVersion,
            oldStopped, databaseMayBeMutated,
            stopTimeoutMs, stopPollMs,
            faultInjector,
          })
        }
      } catch (rollbackError) {
        await journal.close().catch(() => {})
        throw updateError('update-rollback-failed', rollbackError)
      }
      await journal.close().catch(() => {})
    }
    throw original
  }
}

async function persistRecoveryState({ dataRoot, journalPath, journal, phase, now }) {
  const value = {
    ...journal,
    phase,
    currentSwitched: phase === 'committed' || phase === 'current-switched',
    updatedAt: nowIso(now),
  }
  if (phase === 'rolled-back' || phase === 'failed') value.currentSwitched = false
  await writeAtomicJson({ dataRoot, filePath: journalPath, value })
  return value
}

export async function recoverUpdate(options = {}) {
  const {
    dataRoot, journalPath, installationId, updateId,
    previousVersion, candidateVersion, now,
  } = options
  if (!PROCESS_ID.test(installationId || '')) throw updateError('update-identity-invalid')
  if (!PROCESS_ID.test(updateId || '')) throw updateError('update-identity-invalid')
  const acquireRecoveryLock = options.acquireRecoveryLock ?? acquireUpdateProcessLock
  requiredFunction(acquireRecoveryLock, 'update-recovery-lock-invalid')
  let lock
  try {
    lock = await acquireRecoveryLock({
      dataRoot,
      lockPath: `${journalPath}.lock`,
      installationId,
      updateId: 'recovery',
      createdAt: nowIso(now),
      processIdentityProbe: options.processIdentityProbe,
    })
    let journalTarget
    try { journalTarget = await validateDataPath({ dataRoot, targetPath: journalPath }) } catch {
      throw updateError('update-recovery-journal-invalid')
    }
    if (!journalTarget.exists) return { recovered: false, action: 'none', phase: 'missing' }
    let journal
    try { journal = await readUpdateJournal({ dataRoot, journalPath }) } catch (error) {
      throw updateError('update-recovery-journal-invalid', error)
    }
    if (journal.updateId !== updateId
      || journal.previousVersion !== previousVersion
      || journal.candidateVersion !== candidateVersion) {
      throw updateError('update-recovery-journal-mismatch')
    }
    if (TERMINAL_PHASES.has(journal.phase)) {
      if (journal.phase === 'rolled-back') {
        return { recovered: false, action: 'start-current', phase: journal.phase, version: journal.previousVersion }
      }
      return { recovered: false, action: 'none', phase: journal.phase }
    }
    if (PRE_APPLY_PHASES.has(journal.phase)) {
      await persistRecoveryState({ dataRoot, journalPath, journal, phase: 'failed', now })
      return { recovered: true, action: 'marked-failed', version: journal.previousVersion }
    }

    const resolveCandidateProcess = requiredFunction(options.resolveCandidateProcess, 'update-recovery-process-resolver-required')
    const probeProcess = requiredFunction(options.probeProcess, 'update-process-probe-required')
    const stopProcess = requiredFunction(options.stopProcess, 'update-process-stop-required')
    const restoreDatabase = options.restoreDatabase ?? restoreVerifiedSqliteBackup
    const writeCurrent = options.writeCurrent ?? writeAtomicCurrent
    const startPrevious = requiredFunction(options.startPrevious, 'update-previous-launcher-required')
    requiredFunction(restoreDatabase, 'update-restore-runner-invalid')
    requiredFunction(writeCurrent, 'update-current-writer-invalid')

    const oldProcess = normalizeProcessRecord(options.oldProcess, 'update-recovery-old-process-unverifiable')
    if (oldProcess.installationId !== installationId) throw updateError('update-process-identity-mismatch')
    const oldState = await classifyProcessIdentity(oldProcess, probeProcess)
    if (oldState.state === 'alive') await stopExactProcess(oldState.process, {
      probeProcess, stopProcess,
      stopTimeoutMs: options.stopTimeoutMs,
      stopPollMs: options.stopPollMs,
    })

    let candidate
    try { candidate = await resolveCandidateProcess(journal) } catch {
      throw updateError('update-recovery-process-unverifiable')
    }
    if (candidate !== null) {
      const resolved = normalizeProcessRecord(candidate, 'update-recovery-process-unverifiable')
      if (resolved.installationId !== installationId
        || (journal.candidatePid !== null && (
          resolved.pid !== journal.candidatePid
          || resolved.processInstanceId !== journal.candidateInstanceId
        ))) {
        throw updateError('update-process-identity-mismatch')
      }
      if (resolved.pid === oldProcess.pid && resolved.processStartTime === oldProcess.processStartTime) {
        throw updateError('update-process-identity-mismatch')
      }
      await ensureProcessStopped(resolved, {
        probeProcess, stopProcess,
        stopTimeoutMs: options.stopTimeoutMs,
        stopPollMs: options.stopPollMs,
      })
    } else if (journal.candidatePid !== null) {
      throw updateError('update-recovery-process-unverifiable')
    }
    await restoreDatabase({ dataRoot, dbPath: options.dbPath, backupPath: journal.backupPath })
    await writeCurrent({ appRoot: options.appRoot, currentPath: options.currentPath, version: journal.previousVersion })
    await persistRecoveryState({ dataRoot, journalPath, journal, phase: 'rolled-back', now })
    await invokeFault(options.faultInjector, 'after-rollback-terminal-before-old-start')
    await startPrevious({ version: journal.previousVersion, env: { ...SAFE_RUNTIME_ENV } })
    await invokeFault(options.faultInjector, 'after-old-start')
    return { recovered: true, action: 'rolled-back', version: journal.previousVersion }
  } finally {
    await lock?.release?.().catch(() => {})
  }
}

export { SAFE_RUNTIME_ENV }
