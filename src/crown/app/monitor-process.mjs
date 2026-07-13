import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { watcherLeaseKey } from './watcher-lease-key.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_RUNTIME_DIR = 'data/runtime'
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../', import.meta.url))

function isChildRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

export function createMonitorProcessController({
  cwd,
  env = process.env,
  dbPath = env.CROWN_DB_PATH || DEFAULT_DB_PATH,
  runtimeDir = env.CROWN_RUNTIME_DIR || DEFAULT_RUNTIME_DIR,
  configDir = env.CROWN_CONFIG_DIR || '',
  profileDir = env.CROWN_BROWSER_PROFILE_DIR || '',
  nodeExe = env.CROWN_NODE_EXECUTABLE_PATH || process.execPath,
  watchScriptPath = path.join(cwd || DEFAULT_APP_DIR, 'scripts', 'crown-watch.mjs'),
  appDir = cwd || path.dirname(path.dirname(watchScriptPath)),
  spawnCommand = spawn,
} = {}) {
  let child = null
  let childLeaseKey = ''

  function watchArgs({ action = 'start', dbPath: actionDbPath = dbPath, runtimeDir: actionRuntimeDir = runtimeDir, maxSeconds = 0 } = {}) {
    const args = [
      watchScriptPath,
      '--app-db',
      actionDbPath || DEFAULT_DB_PATH,
      '--runtime-dir',
      actionRuntimeDir || DEFAULT_RUNTIME_DIR,
    ]
    if (configDir) {
      args.push(
        '--league-config', path.join(configDir, 'monitored-leagues.json'),
        '--default-leagues-config', path.join(configDir, 'default-leagues.json'),
        '--monitor-settings', path.join(configDir, 'monitor-settings.json'),
        '--telegram-settings', path.join(configDir, 'telegram-settings.json'),
        '--alerts-config', path.join(configDir, 'alerts.json'),
      )
    }
    if (profileDir) args.push('--profile', profileDir)
    if (action === 'test-login') args.push('--login-test')
    const seconds = Number(maxSeconds || (action === 'test-login' ? 120 : 0))
    if (seconds > 0) args.push('--max-seconds', String(seconds))
    return args
  }

  function start({ action = 'start', dbPath: actionDbPath = dbPath, runtimeDir: actionRuntimeDir = runtimeDir, maxSeconds = 0, restart = false } = {}) {
    const requestedLeaseKey = watcherLeaseKey({
      dbPath: actionDbPath || DEFAULT_DB_PATH,
      runtimeDir: actionRuntimeDir || DEFAULT_RUNTIME_DIR,
      cwd: appDir,
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

    const nextChild = spawnCommand(nodeExe, watchArgs({ action, dbPath: actionDbPath, runtimeDir: actionRuntimeDir, maxSeconds }), {
      cwd: appDir,
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
    const nextChild = spawnCommand(nodeExe, watchArgs({
      action: 'test-login',
      dbPath: actionDbPath,
      runtimeDir: actionRuntimeDir,
      maxSeconds,
    }), {
      cwd: appDir,
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
    return { stopped: true, pid }
  }

  function signalAndWait(target, signal, timeoutMs) {
    if (!isChildRunning(target)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (exited) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        target.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      target.once('exit', onExit)
      try { target.kill(signal) } catch { return finish(false) }
      if (!isChildRunning(target)) return finish(true)
      timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs || 1)))
    })
  }

  async function stopAndWait({ timeoutMs = 10_000, forceTimeoutMs = 2_000 } = {}) {
    if (!isChildRunning(child)) return Promise.resolve({ stopped: false })
    const stopping = child
    const pid = stopping.pid
    const graceful = await signalAndWait(stopping, 'SIGTERM', timeoutMs)
    let forced = false
    if (!graceful) {
      forced = true
      const forceExited = await signalAndWait(stopping, 'SIGKILL', forceTimeoutMs)
      if (!forceExited) {
        const error = new Error('watcher-stop-unsafe')
        error.code = 'watcher-stop-unsafe'
        error.pid = pid
        throw error
      }
    }
    if (child === stopping) {
      child = null
      childLeaseKey = ''
    }
    return { stopped: true, pid, forced }
  }

  return {
    isRunning: () => isChildRunning(child),
    start,
    runLoginTest,
    stop,
    stopAndWait,
  }
}
