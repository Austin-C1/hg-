import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openRuntimeDatabase } from './app-db.mjs'
import { createReconciliationProcessController, reconciliationLeaseKey } from './reconciliation-process.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../', import.meta.url))

export const BETTING_PROCESS_STOP_TIMEOUT_MS = 25_000

function running(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

export function bettingWorkerLeaseKey({ cwd = process.cwd(), dbPath = DEFAULT_DB_PATH } = {}) {
  const suffix = reconciliationLeaseKey({ cwd, dbPath }).slice('betting-reconciler:'.length)
  return `betting-worker:${suffix}`
}

export function bettingRoleLeaseKeys({ cwd = process.cwd(), dbPath = DEFAULT_DB_PATH } = {}) {
  const reconciler = reconciliationLeaseKey({ cwd, dbPath })
  const suffix = reconciler.slice('betting-reconciler:'.length)
  return {
    worker: `betting-worker:${suffix}`,
    executor: `betting-executor:${suffix}`,
    reconciler,
  }
}

function safeBrowserStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'accounts')
    || !Array.isArray(value.accounts) || value.accounts.length > 100) return null
  const statuses = new Set(['starting', 'login_required', 'ready', 'stale', 'blocked', 'error'])
  const timestamp = (input) => {
    if (input === null) return null
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))) return undefined
    const canonical = new Date(input).toISOString()
    return canonical === input ? canonical : undefined
  }
  const accounts = []
  for (const item of value.accounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'accountId,lastApiSuccessAt,lastHeartbeatAt,state') return null
    const accountId = String(item.accountId || '')
    const lastHeartbeatAt = timestamp(item.lastHeartbeatAt)
    const lastApiSuccessAt = timestamp(item.lastApiSuccessAt)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)
      || !statuses.has(item.state)
      || lastHeartbeatAt === undefined
      || lastApiSuccessAt === undefined) return null
    accounts.push({ accountId, state: item.state, lastHeartbeatAt, lastApiSuccessAt })
  }
  accounts.sort((left, right) => left.accountId.localeCompare(right.accountId))
  return { accounts }
}

export function hasOpenReconciliationWork(database) {
  const db = database?.db || database
  return Boolean(db.prepare(`
    SELECT attempt.submit_attempt_id
    FROM bet_submit_attempts AS attempt
    JOIN bet_child_orders AS child ON child.child_order_id=attempt.child_order_id
    LEFT JOIN bet_reconciliation_state AS state ON state.submit_attempt_id=attempt.submit_attempt_id
    WHERE (
      attempt.status IN ('submit_prepared','submit_dispatched')
      AND child.status IN ('submit_prepared','submit_dispatched')
    ) OR (
      state.status IN ('pending','waiting')
      AND attempt.status='unknown' AND child.status='unknown'
    )
    LIMIT 1
  `).get())
}

function dueReconciliation({ dbPath, env }) {
  let handle
  try {
    handle = openRuntimeDatabase({ dbPath, env })
    return hasOpenReconciliationWork(handle.db)
  } catch {
    return false
  } finally {
    handle?.close()
  }
}

function processError(code) {
  return Object.assign(new Error(code), { code })
}

export function createBettingProcessController({
  cwd, env = process.env, dbPath = env.CROWN_DB_PATH || DEFAULT_DB_PATH,
  runtimeDir = env.CROWN_RUNTIME_DIR || '',
  appRoot = env.CROWN_APP_ROOT || cwd || DEFAULT_APP_DIR,
  dataRoot = env.CROWN_DATA_ROOT || appRoot,
  profileRoot = env.CROWN_BROWSER_PROFILE_DIR || path.join(runtimeDir || dataRoot, 'browser-profiles'),
  chromiumExecutable = env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
  defaultLeaguesConfig = env.CROWN_DEFAULT_LEAGUES_CONFIG || (env.CROWN_CONFIG_DIR ? path.join(env.CROWN_CONFIG_DIR, 'default-leagues.json') : ''),
  nodeExe = env.CROWN_NODE_EXECUTABLE_PATH || process.execPath,
  workerScriptPath = path.join(cwd || DEFAULT_APP_DIR, 'scripts', 'crown-betting-worker.mjs'),
  appDir = cwd || path.dirname(path.dirname(workerScriptPath)),
  spawnCommand = spawn, readyTimeoutMs = 5000, stopTimeoutMs = BETTING_PROCESS_STOP_TIMEOUT_MS,
  reconciliationProcess = null,
  hasDueReconciliation = null,
  onExit = null,
} = {}) {
  let child = null
  let readyChild = null
  let leaseKey = ''
  let currentTicket = null
  let browserStatus = { accounts: [] }
  let currentNonce = ''
  let generation = 0
  let serial = Promise.resolve()
  let reconciliationHandoff = null
  const expectedStops = new WeakSet()
  const lateReconciliationHandoffs = new WeakMap()
  const reconcilerProcess = reconciliationProcess || createReconciliationProcessController({
    cwd: appDir,
    env,
    appRoot,
    dataRoot,
    runtimeDir,
    profileRoot,
    chromiumExecutable,
    dbPath,
    nodeExe,
  })
  const reconciliationDue = hasDueReconciliation || (() => dueReconciliation({ dbPath, env }))

  function ensureReconciliation(actionDbPath = dbPath) {
    if (reconcilerProcess.isRunning?.()) return Promise.resolve({ running: true, reused: true })
    if (reconciliationHandoff) return reconciliationHandoff
    const result = Promise.resolve().then(() => reconcilerProcess.start({ dbPath: actionDbPath }))
    reconciliationHandoff = result
    result.then(
      () => { if (reconciliationHandoff === result) reconciliationHandoff = null },
      () => { if (reconciliationHandoff === result) reconciliationHandoff = null },
    )
    return result
  }

  function waitForExit(target, timeoutMs, signal = 'SIGTERM') {
    if (!target || target.exitCode !== null || target.signalCode !== null) return Promise.resolve(false)
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
      }, timeoutMs)
    })
  }

  async function terminate(target) {
    if (!target) return { stopped: false, graceful: true, exited: true }
    expectedStops.add(target)
    const graceful = await waitForExit(target, stopTimeoutMs, 'SIGTERM')
    let exited = graceful || !running(target)
    if (!graceful && target.exitCode === null && target.signalCode === null) {
      exited = await waitForExit(target, Math.min(stopTimeoutMs, 1000), 'SIGKILL') || !running(target)
    }
    if (child === target) {
      readyChild = null
      currentTicket = null
      currentNonce = ''
      browserStatus = { accounts: [] }
      if (exited) {
        child = null
        leaseKey = ''
      }
    }
    return { stopped: true, graceful, exited }
  }

  function awaitReady(target, expectedKeys, token, nonce) {
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
        if (token !== generation) return finish(processError('betting-worker-start-aborted'))
        const leases = message?.leases
        const owners = leases ? Object.values(leases).map((item) => item?.ownerId) : []
        const initialBrowserStatus = safeBrowserStatus(message?.browserStatus)
        const valid = message?.type === 'ready' && message.generation === String(token) && message.nonce === nonce
          && ['worker', 'executor', 'reconciler'].every((role) => leases?.[role]?.leaseKey === expectedKeys[role]
            && typeof leases[role].ownerId === 'string' && leases[role].ownerId
            && Number.isSafeInteger(leases[role].fencingToken) && leases[role].fencingToken > 0)
          && owners.length === 3 && new Set(owners).size === 3
          && initialBrowserStatus !== null
        if (!valid) {
          return finish(processError('betting-worker-ready-invalid'))
        }
        browserStatus = initialBrowserStatus
        finish(null, message)
      }
      const onExit = () => finish(processError(token === generation ? 'betting-worker-early-exit' : 'betting-worker-start-aborted'))
      target.on('message', onMessage)
      target.once('exit', onExit)
      const timer = setTimeout(() => finish(processError('betting-worker-ready-timeout')), readyTimeoutMs)
    })
  }

  async function startOperation(token, { restart = false, dbPath: actionDbPath = dbPath } = {}) {
    if (token !== generation) throw processError('betting-worker-start-aborted')
    const expectedKeys = bettingRoleLeaseKeys({ cwd: appDir, dbPath: actionDbPath })
    const requestedLeaseKey = expectedKeys.worker
    if (child) {
      if (!restart && readyChild === child && leaseKey === requestedLeaseKey && running(child)) {
        return { running: true, pid: child.pid, reused: true, leaseKey }
      }
      const stopped = await terminate(child)
      if (!stopped.exited) throw processError('betting-worker-stop-unsafe')
    }
    reconciliationHandoff = null
    const reconciliationStop = await reconcilerProcess.stop()
    if (reconciliationStop?.safe !== true) throw processError('reconciliation-worker-stop-unsafe')
    if (token !== generation) throw processError('betting-worker-start-aborted')
    const nonce = randomBytes(24).toString('base64url')
    const args = [workerScriptPath, '--db-path', actionDbPath || DEFAULT_DB_PATH,
      '--mode', 'real', '--worker-lease-key', requestedLeaseKey, '--generation', String(token), '--ready-nonce', nonce]
    args.push('--app-root', appRoot, '--data-root', dataRoot, '--profile-root', profileRoot,
      '--chromium-executable', chromiumExecutable)
    if (runtimeDir) args.push('--runtime-dir', runtimeDir)
    if (defaultLeaguesConfig) args.push('--default-leagues-config', defaultLeaguesConfig)
    const next = spawnCommand(nodeExe, args, {
      cwd: appDir, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    })
    child = next
    leaseKey = requestedLeaseKey
    currentNonce = nonce
    const onBrowserStatus = (message) => {
      if (next !== child || token !== generation || message?.type !== 'browser-status'
        || message.generation !== String(token) || message.nonce !== currentNonce) return
      const safe = safeBrowserStatus(message.snapshot)
      if (safe) browserStatus = safe
    }
    next.on('message', onBrowserStatus)
    next.once('exit', (code, signal) => {
      next.removeListener('message', onBrowserStatus)
      const unexpected = !expectedStops.has(next) && token === generation
      const lateHandoffGeneration = lateReconciliationHandoffs.get(next)
      lateReconciliationHandoffs.delete(next)
      const handoffGeneration = unexpected ? token : lateHandoffGeneration
      if (child === next) {
        child = null
        readyChild = null
        leaseKey = ''
        currentTicket = null
        currentNonce = ''
        browserStatus = { accounts: [] }
      }
      void (async () => {
        try {
          await onExit?.({ generation: String(token), code, signal, unexpected })
        } finally {
          if (handoffGeneration === generation && await reconciliationDue()) {
            reconciliationHandoff = null
            await reconcilerProcess.stop()
            if (handoffGeneration === generation) void ensureReconciliation(actionDbPath).catch(() => {})
          }
        }
      })().catch(() => {})
    })
    let ticket
    try {
      ticket = await awaitReady(next, expectedKeys, token, nonce)
    } catch (error) {
      await terminate(next)
      throw error
    }
    if (token !== generation || child !== next) {
      await terminate(next)
      throw processError('betting-worker-start-aborted')
    }
    readyChild = next
    currentTicket = ticket
    return {
      running: true, pid: next.pid, reused: false, leaseKey: requestedLeaseKey, readyTicket: ticket,
      async activate() {
        if (child !== next || readyChild !== next || token !== generation) throw processError('betting-worker-start-aborted')
        if (typeof next.send !== 'function') throw processError('betting-worker-go-failed')
        await new Promise((resolve, reject) => {
          try {
            next.send({ type: 'go', generation: String(token), nonce }, (error) => {
              if (error) return reject(processError('betting-worker-go-failed'))
              if (child !== next || readyChild !== next || token !== generation) {
                return reject(processError('betting-worker-start-aborted'))
              }
              resolve(true)
            })
          } catch {
            reject(processError('betting-worker-go-failed'))
          }
        })
        return true
      },
    }
  }

  function start(options = {}) {
    const token = ++generation
    const result = serial.then(() => startOperation(token, options))
    serial = result.catch(() => {})
    return result
  }

  async function stop({ startReconciliation = false, suppressSafetyHandoff = false } = {}) {
    const stopGeneration = ++generation
    const target = child
    let result = { stopped: false, graceful: true, exited: true }
    if (target) {
      const pid = target.pid
      result = { ...await terminate(target), pid }
      const needsSafetyHandoff = !suppressSafetyHandoff && result.graceful !== true
      if ((startReconciliation || needsSafetyHandoff) && !result.exited) {
        lateReconciliationHandoffs.set(target, stopGeneration)
      } else {
        lateReconciliationHandoffs.delete(target)
      }
    }
    const needsSafetyHandoff = Boolean(!suppressSafetyHandoff && target && result.graceful !== true)
    const handoff = !suppressSafetyHandoff && (startReconciliation || needsSafetyHandoff)
      && result.exited && await reconciliationDue()
    let reconciliationSafe = true
    if (handoff) {
      void ensureReconciliation(dbPath).catch(() => {})
    } else {
      reconciliationHandoff = null
      const reconciliationStop = await reconcilerProcess.stop()
      reconciliationSafe = reconciliationStop?.safe === true
      if (!suppressSafetyHandoff && !reconciliationSafe && await reconciliationDue()) {
        void ensureReconciliation(dbPath).catch(() => {})
      }
    }
    const safe = result.graceful && result.exited && reconciliationSafe
    return {
      stopped: result.stopped,
      ...(result.pid ? { pid: result.pid } : {}),
      safe,
      ...(safe ? {} : { ok: false }),
    }
  }

  return {
    isRunning: () => readyChild === child && running(child),
    isStopped: () => child === null && readyChild === null && !running(child),
    getReadyTicket: () => currentTicket,
    getBrowserStatus: () => ({
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
      ...structuredClone(browserStatus),
    }),
    start,
    stop,
  }
}
