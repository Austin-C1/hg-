import { spawn } from 'node:child_process'
import path from 'node:path'

import { watcherLeaseKey } from './watcher-lease-key.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_RUNTIME_DIR = 'data/runtime'

function isChildRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null && !child.killed)
}

export function createMonitorProcessController({
  cwd = process.cwd(),
  env = process.env,
  dbPath = env.CROWN_DB_PATH || DEFAULT_DB_PATH,
  runtimeDir = DEFAULT_RUNTIME_DIR,
  spawnCommand = spawn,
} = {}) {
  let child = null
  let childLeaseKey = ''

  function watchArgs({ action = 'start', dbPath: actionDbPath = dbPath, runtimeDir: actionRuntimeDir = runtimeDir, maxSeconds = 0 } = {}) {
    const args = [
      path.resolve(cwd, 'scripts/crown-watch.mjs'),
      '--app-db',
      actionDbPath || DEFAULT_DB_PATH,
      '--runtime-dir',
      actionRuntimeDir || DEFAULT_RUNTIME_DIR,
    ]
    if (action === 'test-login') args.push('--login-test')
    const seconds = Number(maxSeconds || (action === 'test-login' ? 120 : 0))
    if (seconds > 0) args.push('--max-seconds', String(seconds))
    return args
  }

  function start({ action = 'start', dbPath: actionDbPath = dbPath, runtimeDir: actionRuntimeDir = runtimeDir, maxSeconds = 0, restart = false } = {}) {
    const requestedLeaseKey = watcherLeaseKey({
      dbPath: actionDbPath || DEFAULT_DB_PATH,
      runtimeDir: actionRuntimeDir || DEFAULT_RUNTIME_DIR,
      cwd,
    })
    if (isChildRunning(child)) {
      if (childLeaseKey !== requestedLeaseKey) {
        const error = new Error('watcher-already-running-different-lease')
        error.code = 'watcher-already-running-different-lease'
        error.activeLeaseKey = childLeaseKey
        error.requestedLeaseKey = requestedLeaseKey
        throw error
      }
      return {
        running: true,
        pid: child.pid,
        reused: true,
        alreadyRunning: true,
        restarted: false,
        previousPid: null,
        leaseKey: childLeaseKey,
      }
    }

    const nextChild = spawnCommand(process.execPath, watchArgs({ action, dbPath: actionDbPath, runtimeDir: actionRuntimeDir, maxSeconds }), {
      cwd,
      env,
      stdio: 'ignore',
      windowsHide: true,
    })
    child = nextChild
    childLeaseKey = requestedLeaseKey
    nextChild.once('exit', () => {
      if (child === nextChild) {
        child = null
        childLeaseKey = ''
      }
    })
    return {
      running: true,
      pid: nextChild.pid,
      reused: false,
      alreadyRunning: false,
      restarted: false,
      previousPid: null,
      leaseKey: requestedLeaseKey,
    }
  }

  function runLoginTest({ dbPath: actionDbPath = dbPath, runtimeDir: actionRuntimeDir = runtimeDir, maxSeconds = 120, timeoutMs = 0 } = {}) {
    const nextChild = spawnCommand(process.execPath, watchArgs({
      action: 'test-login',
      dbPath: actionDbPath,
      runtimeDir: actionRuntimeDir,
      maxSeconds,
    }), {
      cwd,
      env,
      stdio: 'ignore',
      windowsHide: true,
    })
    const timeout = Number(timeoutMs || (Number(maxSeconds || 120) * 1000) + 5000)

    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        nextChild.kill?.()
        resolve({ ok: false, pid: nextChild.pid, code: null, signal: 'timeout', timedOut: true })
      }, timeout)
      nextChild.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, pid: nextChild.pid, code, signal, timedOut: false })
      })
    })
  }

  function stop() {
    if (!isChildRunning(child)) return { stopped: false }
    const pid = child.pid
    child.kill()
    child = null
    childLeaseKey = ''
    return { stopped: true, pid }
  }

  function stopAndWait({ timeoutMs = 10_000 } = {}) {
    if (!isChildRunning(child)) return Promise.resolve({ stopped: false })
    const stopping = child
    const pid = stopping.pid
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (child === stopping) {
          child = null
          childLeaseKey = ''
        }
        resolve({ stopped: true, pid })
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error('watcher-stop-timeout')
        error.code = 'watcher-stop-timeout'
        reject(error)
      }, Math.max(1, Number(timeoutMs || 10_000)))
      stopping.once('exit', finish)
      stopping.kill()
      if (!isChildRunning(stopping)) finish()
    })
  }

  return {
    isRunning: () => isChildRunning(child),
    start,
    runLoginTest,
    stop,
    stopAndWait,
  }
}
