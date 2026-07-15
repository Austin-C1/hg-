import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openRuntimeDatabase } from './app-db.mjs'
import { RuntimeLease } from './runtime-lease.mjs'
import { BetBatchStore } from '../betting/bet-batch-store.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const DEFAULT_OWNERSHIP_WAIT_MS = 20_000
const DEFAULT_OWNERSHIP_POLL_MS = 250

function running(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function processError(code) {
  return Object.assign(new Error(code), { code })
}

export function canonicalBettingDatabasePath({ cwd = process.cwd(), dbPath = DEFAULT_DB_PATH } = {}) {
  const resolved = path.resolve(cwd, dbPath || DEFAULT_DB_PATH)
  let canonical = resolved
  try { canonical = fs.realpathSync.native(resolved) } catch {}
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function reconciliationLeaseKey(options = {}) {
  return `betting-reconciler:${canonicalBettingDatabasePath(options)}`
}

function databaseOwnershipReleased({ cwd, dbPath, env }) {
  if (!fs.existsSync(path.resolve(cwd, dbPath))) return true
  let handle
  try {
    handle = openRuntimeDatabase({ dbPath, env })
    const canonical = canonicalBettingDatabasePath({ cwd, dbPath: handle.dbPath })
    const roleKeys = ['worker', 'executor', 'reconciler'].map((role) => `betting-${role}:${canonical}`)
    const profilePrefix = `browser-profile:${canonical}:`
    const rows = handle.db.prepare(`
      SELECT lease_key, expires_at
      FROM runtime_leases
      WHERE lease_key IN (?,?,?) OR substr(lease_key,1,?)=?
    `).all(...roleKeys, profilePrefix.length, profilePrefix)
    const now = Date.now()
    return rows.every((row) => Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) <= now)
  } catch {
    return false
  } finally {
    handle?.close()
  }
}

function recoverUncertainBettingWork({ cwd, dbPath, env }) {
  const canonical = canonicalBettingDatabasePath({ cwd, dbPath })
  if (!fs.existsSync(canonical)) return { unknownCount: 0 }
  const handle = openRuntimeDatabase({ dbPath: canonical, env })
  const leaseKey = `betting-executor:${canonical}`
  const lease = new RuntimeLease({ db: handle.db, leaseKey })
  try {
    const acquired = lease.acquire()
    const store = new BetBatchStore(handle.db, { leaseKey, fencingToken: acquired.fencingToken })
    return store.recover({ fencingToken: acquired.fencingToken })
  } finally {
    lease.release()
    handle.close()
  }
}

export function createReconciliationProcessController({
  cwd,
  env = process.env,
  appRoot = env.CROWN_APP_ROOT || cwd || DEFAULT_APP_DIR,
  dataRoot = env.CROWN_DATA_ROOT || appRoot,
  runtimeDir = env.CROWN_RUNTIME_DIR || path.join(dataRoot, 'data', 'runtime'),
  profileRoot = env.CROWN_BROWSER_PROFILE_DIR || path.join(runtimeDir, 'browser-profiles'),
  chromiumExecutable = env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
  dbPath = env.CROWN_DB_PATH || DEFAULT_DB_PATH,
  nodeExe = env.CROWN_NODE_EXECUTABLE_PATH || process.execPath,
  workerScriptPath = path.join(cwd || DEFAULT_APP_DIR, 'scripts', 'crown-reconciliation-worker.mjs'),
  spawnCommand = spawn,
  readyTimeoutMs = 5_000,
  stopTimeoutMs = 25_000,
  ownershipReleased = null,
  recoverUncertain = null,
  ownershipWaitMs = DEFAULT_OWNERSHIP_WAIT_MS,
  ownershipPollMs = DEFAULT_OWNERSHIP_POLL_MS,
} = {}) {
  if (!Number.isSafeInteger(ownershipWaitMs) || ownershipWaitMs < 1
    || !Number.isSafeInteger(ownershipPollMs) || ownershipPollMs < 1) {
    throw new TypeError('reconciliation-worker-ownership-wait-invalid')
  }
  let child = null
  let readyChild = null
  let generation = 0
  let serial = Promise.resolve()
  let startPromise = null
  let desiredRunning = false
  let recoveryTimer = null
  const expectedStops = new WeakSet()
  const verifyOwnershipReleased = ownershipReleased || (() => databaseOwnershipReleased({ cwd: appRoot, dbPath, env }))
  const recover = recoverUncertain || (() => recoverUncertainBettingWork({ cwd: appRoot, dbPath, env }))

  function assertGeneration(token) {
    if (token !== generation || !desiredRunning) throw processError('reconciliation-worker-start-aborted')
  }

  async function waitForOwnership(token) {
    const deadline = Date.now() + ownershipWaitMs
    while (true) {
      assertGeneration(token)
      if (await verifyOwnershipReleased()) {
        assertGeneration(token)
        return
      }
      assertGeneration(token)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw processError('reconciliation-worker-stop-unsafe')
      await new Promise((resolve) => setTimeout(resolve, Math.min(ownershipPollMs, remaining)))
    }
  }

  function awaitReady(target, leaseKey, token, nonce) {
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        target.removeListener('message', onMessage)
        target.removeListener('exit', onExit)
      }
      const finish = (error, value) => {
        if (settled) return
        settled = true
        cleanup()
        error ? reject(error) : resolve(value)
      }
      const onMessage = (message) => {
        if (token !== generation) return finish(processError('reconciliation-worker-start-aborted'))
        const lease = message?.lease
        const valid = message?.type === 'ready'
          && message.generation === String(token)
          && message.nonce === nonce
          && lease?.leaseKey === leaseKey
          && typeof lease.ownerId === 'string' && lease.ownerId
          && Number.isSafeInteger(lease.fencingToken) && lease.fencingToken > 0
        if (!valid) return finish(processError('reconciliation-worker-ready-invalid'))
        finish(null, message)
      }
      const onExit = () => finish(processError('reconciliation-worker-early-exit'))
      target.on('message', onMessage)
      target.once('exit', onExit)
      const timer = setTimeout(() => finish(processError('reconciliation-worker-ready-timeout')), readyTimeoutMs)
    })
  }

  function waitForExit(target, signal = 'SIGTERM') {
    if (!running(target)) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        target.removeListener('exit', finish)
        resolve(true)
      }
      target.once('exit', finish)
      target.kill(signal)
      const timer = setTimeout(() => {
        target.removeListener('exit', finish)
        settled = true
        resolve(false)
      }, signal === 'SIGTERM' ? stopTimeoutMs : Math.min(stopTimeoutMs, 1_000))
    })
  }

  async function terminate(target) {
    if (!target) return { stopped: false, graceful: true, exited: true }
    expectedStops.add(target)
    const graceful = await waitForExit(target)
    let exited = graceful || !running(target)
    if (!exited) exited = await waitForExit(target, 'SIGKILL') || !running(target)
    if (child === target) {
      readyChild = null
      if (exited) child = null
    }
    return { stopped: true, graceful, exited }
  }

  async function startOperation(token) {
    assertGeneration(token)
    if (running(readyChild) && child === readyChild) {
      return { running: true, pid: child.pid, reused: true, leaseKey: reconciliationLeaseKey({ cwd: appRoot, dbPath }) }
    }
    if (child) {
      const stopped = await terminate(child)
      if (!stopped.exited) throw processError('reconciliation-worker-stop-unsafe')
    }
    await waitForOwnership(token)
    assertGeneration(token)
    await recover()
    assertGeneration(token)
    if (!await verifyOwnershipReleased()) throw processError('reconciliation-worker-stop-unsafe')
    assertGeneration(token)
    const leaseKey = reconciliationLeaseKey({ cwd: appRoot, dbPath })
    const nonce = randomBytes(24).toString('base64url')
    const args = [
      workerScriptPath,
      '--app-root', appRoot,
      '--data-root', dataRoot,
      '--runtime-dir', runtimeDir,
      '--profile-root', profileRoot,
      '--chromium-executable', chromiumExecutable,
      '--db-path', dbPath,
      '--reconciler-lease-key', leaseKey,
      '--generation', String(token),
      '--ready-nonce', nonce,
    ]
    const next = spawnCommand(nodeExe, args, {
      cwd: appRoot,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    child = next
    next.once('exit', () => {
      if (child === next) { child = null; readyChild = null }
      if (!expectedStops.has(next) && desiredRunning && token === generation && recoveryTimer === null) {
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null
          if (desiredRunning && token === generation) void start().catch(() => {})
        }, ownershipPollMs)
        recoveryTimer?.unref?.()
      }
    })
    try {
      await awaitReady(next, leaseKey, token, nonce)
    } catch (error) {
      await terminate(next)
      throw error
    }
    if (token !== generation || !desiredRunning || child !== next) {
      await terminate(next)
      throw processError('reconciliation-worker-start-aborted')
    }
    readyChild = next
    return { running: true, pid: next.pid, reused: false, leaseKey }
  }

  function start() {
    desiredRunning = true
    if (running(readyChild) && child === readyChild) {
      return Promise.resolve({
        running: true,
        pid: child.pid,
        reused: true,
        leaseKey: reconciliationLeaseKey({ cwd: appRoot, dbPath }),
      })
    }
    if (startPromise) return startPromise
    if (recoveryTimer !== null) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
    const token = ++generation
    const result = serial.then(() => startOperation(token))
    serial = result.catch(() => {})
    startPromise = result
    result.then(
      () => { if (startPromise === result) startPromise = null },
      () => { if (startPromise === result) startPromise = null },
    )
    return result
  }

  async function stop() {
    desiredRunning = false
    generation += 1
    startPromise = null
    if (recoveryTimer !== null) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
    const target = child
    const stopped = await terminate(target)
    const ownershipSafe = stopped.exited && await verifyOwnershipReleased()
    return { stopped: stopped.stopped, safe: stopped.graceful && ownershipSafe }
  }

  return { isRunning: () => readyChild === child && running(child), start, stop }
}
