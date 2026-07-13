import { statfs } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import { listCrownCapabilities } from '../betting/crown-capability-matrix.mjs'
import {
  openVerifiedDataFile,
  sameFileIdentity,
  validateDataPath,
} from './safe-data-path.mjs'

const SAFE_SUBMIT_TERMINALS = Object.freeze(['accepted', 'rejected', 'odds_changed_unsent'])

function codedError(code) {
  return new Error(code)
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw codedError(code)
  return value
}

async function availableBytes(path) {
  try {
    const value = await statfs(path, { bigint: true })
    const bytes = value.bavail * value.bsize
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
    return Number(bytes)
  } catch {
    throw codedError('update-preflight-disk-check-failed')
  }
}

function capabilityCounts(capabilities) {
  if (!Array.isArray(capabilities)) throw codedError('update-preflight-capability-invalid')
  try {
    return {
      preview: capabilities.filter((item) => item?.previewAllowed === true).length,
      submit: capabilities.filter((item) => item?.submitAllowed === true).length,
      reconciliation: capabilities.filter((item) => item?.reconciliationAllowed === true).length,
    }
  } catch {
    throw codedError('update-preflight-capability-invalid')
  }
}

async function readSafetyState({ dataRoot, dbPath }) {
  let opened
  let db
  try {
    opened = await openVerifiedDataFile({ dataRoot, filePath: dbPath, flags: 'r' })
    db = new DatabaseSync(dbPath, { readOnly: true })
    const afterOpen = await validateDataPath({
      dataRoot,
      targetPath: dbPath,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterOpen.identity)) {
      throw codedError('update-preflight-database-identity-changed')
    }

    const requiredTables = new Set(['real_betting_runtime', 'bet_submit_attempts', 'bet_reconciliation_state'])
    const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
    if ([...requiredTables].some((name) => !existing.has(name))) throw codedError('update-preflight-database-invalid')
    const runtimeRows = db.prepare('SELECT requested,runtime_state FROM real_betting_runtime').all()
    if (runtimeRows.length !== 1 || Number(runtimeRows[0].requested) !== 0 || runtimeRows[0].runtime_state !== 'off') {
      throw codedError('update-preflight-real-betting-not-off')
    }
    const unknown = Number(db.prepare("SELECT COUNT(*) AS count FROM bet_submit_attempts WHERE status='unknown'").get()?.count || 0)
    if (unknown !== 0) throw codedError('update-preflight-unknown-submit')
    const placeholders = SAFE_SUBMIT_TERMINALS.map(() => '?').join(',')
    const unresolved = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM bet_submit_attempts
      WHERE status NOT IN (${placeholders})
    `).get(...SAFE_SUBMIT_TERMINALS)?.count || 0)
    if (unresolved !== 0) throw codedError('update-preflight-submit-not-terminal')
    const openReconciliation = Number(db.prepare("SELECT COUNT(*) AS count FROM bet_reconciliation_state WHERE status<>'resolved'").get()?.count || 0)
    if (openReconciliation !== 0) throw codedError('update-preflight-reconciliation-open')

    const afterRead = await validateDataPath({
      dataRoot,
      targetPath: dbPath,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterRead.identity)) {
      throw codedError('update-preflight-database-identity-changed')
    }
    return true
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('update-preflight-')) throw error
    throw codedError('update-preflight-database-invalid')
  } finally {
    try { db?.close() } catch {}
    await opened?.handle.close().catch(() => {})
  }
}

async function bounded(operation, timeoutMs, timeoutCode) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(codedError(timeoutCode)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function controllerRunning(controller, kind) {
  let running
  try {
    running = controller.isRunning()
  } catch {
    throw codedError(`update-preflight-${kind}-status-failed`)
  }
  if (typeof running !== 'boolean') throw codedError(`update-preflight-${kind}-status-invalid`)
  return running
}

async function preflightPaths({ dataRoot, dbPath, diskPath }) {
  if (typeof dataRoot !== 'string') throw codedError('update-preflight-data-root-invalid')
  let database
  try {
    database = await validateDataPath({
      dataRoot,
      targetPath: dbPath,
      requireExists: true,
      expectDirectory: false,
    })
  } catch {
    throw codedError('update-preflight-db-path-invalid')
  }
  let disk
  try {
    disk = await validateDataPath({
      dataRoot,
      targetPath: diskPath,
      requireExists: true,
      allowRoot: true,
      expectDirectory: true,
    })
  } catch {
    throw codedError('update-preflight-disk-path-invalid')
  }
  return { dataRoot: database.dataRoot, dbPath: database.path, diskPath: disk.path }
}

export async function runUpdatePreflight({
  dataRoot,
  dbPath,
  diskPath,
  requiredBytes,
  getAvailableBytes = availableBytes,
  capabilities,
  monitorController,
  bettingController,
  stopTimeoutMs = 10_000,
} = {}) {
  const paths = await preflightPaths({ dataRoot, dbPath, diskPath })
  safeInteger(requiredBytes, 'update-preflight-required-bytes-invalid')
  if (typeof getAvailableBytes !== 'function') throw codedError('update-preflight-disk-check-invalid')
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0) throw codedError('update-preflight-stop-timeout-invalid')
  if (
    typeof monitorController?.isRunning !== 'function'
    || typeof monitorController?.stopAndWait !== 'function'
    || typeof bettingController?.isRunning !== 'function'
    || typeof bettingController?.stop !== 'function'
  ) throw codedError('update-preflight-controller-invalid')

  let available
  try {
    available = safeInteger(
      await getAvailableBytes(paths.diskPath),
      'update-preflight-available-bytes-invalid',
    )
  } catch (error) {
    if (error?.message === 'update-preflight-available-bytes-invalid') throw error
    throw codedError('update-preflight-disk-check-failed')
  }
  if (available < requiredBytes) throw codedError('update-preflight-disk-space-insufficient')
  await readSafetyState(paths)
  let selectedCapabilities = capabilities
  if (selectedCapabilities === undefined) {
    try {
      selectedCapabilities = listCrownCapabilities()
    } catch {
      throw codedError('update-preflight-capability-invalid')
    }
  }
  const capability = capabilityCounts(selectedCapabilities)
  if (capability.preview !== 0 || capability.submit !== 0 || capability.reconciliation !== 0) {
    throw codedError('update-preflight-capability-not-zero')
  }

  if (controllerRunning(bettingController, 'worker')) {
    try {
      await bounded(() => bettingController.stop(), stopTimeoutMs, 'update-preflight-worker-stop-timeout')
    } catch (error) {
      if (error?.message === 'update-preflight-worker-stop-timeout') throw error
      throw codedError('update-preflight-worker-stop-failed')
    }
  }
  if (controllerRunning(bettingController, 'worker')) throw codedError('update-preflight-worker-still-running')

  if (controllerRunning(monitorController, 'watcher')) {
    try {
      await bounded(() => monitorController.stopAndWait({ timeoutMs: stopTimeoutMs }), stopTimeoutMs, 'update-preflight-watcher-stop-timeout')
    } catch (error) {
      if (error?.message === 'update-preflight-watcher-stop-timeout' || error?.message === 'watcher-stop-timeout') {
        throw codedError('update-preflight-watcher-stop-timeout')
      }
      throw codedError('update-preflight-watcher-stop-failed')
    }
  }
  if (controllerRunning(monitorController, 'watcher')) throw codedError('update-preflight-watcher-still-running')

  await readSafetyState(paths)
  return {
    ready: true,
    requiredBytes,
    availableBytes: available,
    watcherStopped: true,
    workerStopped: true,
    capability,
  }
}
