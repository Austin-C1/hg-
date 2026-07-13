import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../', import.meta.url))

function running(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

export function bettingWorkerLeaseKey({ cwd = process.cwd(), dbPath = DEFAULT_DB_PATH } = {}) {
  return `betting-worker:${path.resolve(cwd, dbPath || DEFAULT_DB_PATH)}`
}

export function bettingRoleLeaseKeys({ cwd = process.cwd(), dbPath = DEFAULT_DB_PATH } = {}) {
  const suffix = path.resolve(cwd, dbPath || DEFAULT_DB_PATH)
  return {
    worker: `betting-worker:${suffix}`,
    executor: `betting-executor:${suffix}`,
    reconciler: `betting-reconciler:${suffix}`,
  }
}

function processError(code) {
  return Object.assign(new Error(code), { code })
}

export function createBettingProcessController({
  cwd, env = process.env, dbPath = env.CROWN_DB_PATH || DEFAULT_DB_PATH,
  runtimeDir = env.CROWN_RUNTIME_DIR || '',
  defaultLeaguesConfig = env.CROWN_DEFAULT_LEAGUES_CONFIG || (env.CROWN_CONFIG_DIR ? path.join(env.CROWN_CONFIG_DIR, 'default-leagues.json') : ''),
  nodeExe = env.CROWN_NODE_EXECUTABLE_PATH || process.execPath,
  workerScriptPath = path.join(cwd || DEFAULT_APP_DIR, 'scripts', 'crown-betting-worker.mjs'),
  appDir = cwd || path.dirname(path.dirname(workerScriptPath)),
  spawnCommand = spawn, readyTimeoutMs = 5000, stopTimeoutMs = 3000,
  onExit = null,
} = {}) {
  let child = null
  let readyChild = null
  let leaseKey = ''
  let currentTicket = null
  let generation = 0
  let serial = Promise.resolve()
  const expectedStops = new WeakSet()

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
        if (signal === 'SIGTERM') {
          target.removeListener('exit', finish)
          settled = true
          target.kill('SIGKILL')
          resolve(false)
        } else finish()
      }, timeoutMs)
    })
  }

  async function terminate(target) {
    if (!target) return false
    expectedStops.add(target)
    const graceful = await waitForExit(target, stopTimeoutMs, 'SIGTERM')
    if (!graceful && target.exitCode === null && target.signalCode === null) {
      await waitForExit(target, Math.min(stopTimeoutMs, 1000), 'SIGKILL')
    }
    if (child === target) { child = null; readyChild = null; leaseKey = ''; currentTicket = null }
    return true
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
        const valid = message?.type === 'ready' && message.generation === String(token) && message.nonce === nonce
          && ['worker', 'executor', 'reconciler'].every((role) => leases?.[role]?.leaseKey === expectedKeys[role]
            && typeof leases[role].ownerId === 'string' && leases[role].ownerId
            && Number.isSafeInteger(leases[role].fencingToken) && leases[role].fencingToken > 0)
          && new Set(owners).size === 3
        if (!valid) {
          return finish(processError('betting-worker-ready-invalid'))
        }
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
      await terminate(child)
    }
    if (token !== generation) throw processError('betting-worker-start-aborted')
    const nonce = randomBytes(24).toString('base64url')
    const args = [workerScriptPath, '--db-path', actionDbPath || DEFAULT_DB_PATH,
      '--mode', 'real', '--worker-lease-key', requestedLeaseKey, '--generation', String(token), '--ready-nonce', nonce]
    if (runtimeDir) args.push('--runtime-dir', runtimeDir)
    if (defaultLeaguesConfig) args.push('--default-leagues-config', defaultLeaguesConfig)
    const next = spawnCommand(nodeExe, args, {
      cwd: appDir, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    })
    child = next
    leaseKey = requestedLeaseKey
    next.once('exit', (code, signal) => {
      const unexpected = !expectedStops.has(next) && token === generation
      if (child === next) { child = null; readyChild = null; leaseKey = ''; currentTicket = null }
      Promise.resolve(onExit?.({ generation: String(token), code, signal, unexpected })).catch(() => {})
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
      activate() {
        if (child !== next || readyChild !== next || token !== generation) throw processError('betting-worker-start-aborted')
        next.send?.({ type: 'go', generation: String(token), nonce })
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

  async function stop() {
    generation += 1
    const target = child
    if (!target) return { stopped: false }
    const pid = target.pid
    await terminate(target)
    return { stopped: true, pid }
  }

  return { isRunning: () => readyChild === child && running(child), getReadyTicket: () => currentTicket, start, stop }
}
