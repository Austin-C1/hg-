import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { watcherLeaseKey } from './watcher-lease-key.mjs'

const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_RUNTIME_DIR = 'data/runtime'
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../../', import.meta.url))
const RESTART_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000])
const MAX_STDERR_BYTES = 2_048
const MAX_CAPTURE_BYTES = 8_192

function isChildRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('monitor-process-time-invalid')
  return date.toISOString()
}

function appendBoundedCapture(existing, chunk) {
  const combined = Buffer.concat([existing, Buffer.from(chunk)])
  if (combined.length <= MAX_CAPTURE_BYTES) return combined
  const half = Math.floor(MAX_CAPTURE_BYTES / 2)
  return Buffer.concat([combined.subarray(0, half), combined.subarray(combined.length - half)])
}

function boundedText(text, maxBytes) {
  const value = String(text || '')
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) return encoded.toString('utf8')
  const headBytes = Math.floor((maxBytes - 3) / 2)
  const tailBytes = maxBytes - 3 - headBytes
  let head = ''
  let headSize = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (headSize + size > headBytes) break
    head += character
    headSize += size
  }
  let tail = ''
  let tailSize = 0
  for (const character of [...value].reverse()) {
    const size = Buffer.byteLength(character)
    if (tailSize + size > tailBytes) break
    tail = character + tail
    tailSize += size
  }
  return `${head}…${tail}`
}

function sanitizedStderr(buffer) {
  const text = Buffer.from(buffer || '').toString('utf8')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b(authorization|cookie|password|passwd|secret|session|ticket|token)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n]*/g, '[path]')
    .replace(/(^|\s)\/(?:[^\s/]+\/)+[^\s]*/g, '$1[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  return boundedText(text, MAX_STDERR_BYTES)
}

function safeExitCode(value) {
  return Number.isSafeInteger(value) ? value : null
}

function safeSignal(value) {
  const signal = String(value || '')
  return /^[A-Za-z0-9_-]{1,32}$/.test(signal) ? signal : null
}

function defaultRestartLeaseAvailability({ dbPath, leaseKey, appDir, now }) {
  const resolvedDbPath = path.resolve(appDir, dbPath)
  if (!fs.existsSync(resolvedDbPath)) return true
  let db
  try {
    db = new DatabaseSync(resolvedDbPath, { readOnly: true })
    const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='runtime_leases'").get()
    if (!table) return true
    const row = db.prepare('SELECT pid,expires_at FROM runtime_leases WHERE lease_key = ? LIMIT 1').get(leaseKey)
    if (!row) return true
    const nowMs = new Date(now).getTime()
    const expiresAt = Date.parse(String(row.expires_at || ''))
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return true
    return {
      available: false,
      retryAfterMs: Math.max(250, expiresAt - nowMs + 25),
      pid: Number.isSafeInteger(row.pid) && row.pid > 0 ? row.pid : null,
    }
  } catch {
    return { available: false, retryAfterMs: 1_000 }
  } finally {
    db?.close()
  }
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
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => new Date(),
  isRestartLeaseAvailable = defaultRestartLeaseAvailability,
  stableRunMs = 60_000,
} = {}) {
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('monitor-process-timer-invalid')
  }
  if (typeof now !== 'function' || typeof isRestartLeaseAvailable !== 'function') {
    throw new TypeError('monitor-process-dependency-invalid')
  }
  if (!Number.isSafeInteger(stableRunMs) || stableRunMs < 0) {
    throw new TypeError('monitor-process-stable-window-invalid')
  }

  let child = null
  let childLeaseKey = ''
  let generation = 0
  let desiredRunning = false
  let processState = 'manually-stopped'
  let lastExit = null
  let restartAttempt = 0
  let nextRestartAt = null
  let restartTimer = null
  let stableTimer = null
  let lastLaunch = null

  function nowIso() {
    return timestamp(now())
  }

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

  function clearRestartTimer() {
    if (restartTimer !== null) clearTimeoutFn(restartTimer)
    restartTimer = null
    nextRestartAt = null
  }

  function clearStableTimer() {
    if (stableTimer !== null) clearTimeoutFn(stableTimer)
    stableTimer = null
  }

  function normalizeLeaseAvailability(value) {
    if (value === true) return { available: true, retryAfterMs: 0, pid: null }
    if (value === false) return { available: false, retryAfterMs: 1_000, pid: null }
    const retryAfterMs = Number(value?.retryAfterMs || 1_000)
    return {
      available: value?.available === true,
      retryAfterMs: Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1_000,
      pid: Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null,
    }
  }

  function scheduleRestartTimer(expectedGeneration, delayMs) {
    clearRestartTimer()
    processState = 'waiting-restart'
    nextRestartAt = new Date(Date.parse(nowIso()) + delayMs).toISOString()
    restartTimer = setTimeoutFn(() => {
      restartTimer = null
      nextRestartAt = null
      if (!desiredRunning || generation !== expectedGeneration || !lastLaunch) return
      let availability
      try {
        availability = normalizeLeaseAvailability(isRestartLeaseAvailable({
          dbPath: lastLaunch.dbPath,
          runtimeDir: lastLaunch.runtimeDir,
          leaseKey: lastLaunch.leaseKey,
          appDir,
          now: nowIso(),
        }))
      } catch {
        availability = { available: false, retryAfterMs: 1_000 }
      }
      if (!availability.available) {
        scheduleRestartTimer(expectedGeneration, availability.retryAfterMs)
        return
      }
      try {
        spawnManaged(lastLaunch, { recovery: true, expectedGeneration })
      } catch (error) {
        lastExit = {
          exitCode: null,
          signal: null,
          exitedAt: nowIso(),
          stderrSummary: sanitizedStderr(Buffer.from(String(error?.message || 'watcher-spawn-failed'))),
        }
        scheduleRecovery(expectedGeneration)
      }
    }, delayMs)
    restartTimer?.unref?.()
  }

  function scheduleRecovery(failedGeneration) {
    if (!desiredRunning || generation !== failedGeneration) return
    if (restartAttempt >= RESTART_DELAYS_MS.length) {
      clearRestartTimer()
      processState = 'stopped-after-retries'
      return
    }
    restartAttempt += 1
    scheduleRestartTimer(failedGeneration, RESTART_DELAYS_MS[restartAttempt - 1])
  }

  function spawnManaged(launch, { recovery = false, expectedGeneration = generation } = {}) {
    if (recovery && (!desiredRunning || generation !== expectedGeneration)) return null
    const nextChild = spawnCommand(nodeExe, watchArgs(launch), {
      cwd: appDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    const nextGeneration = generation + 1
    generation = nextGeneration
    child = nextChild
    childLeaseKey = launch.leaseKey
    processState = 'running'
    nextRestartAt = null
    let stderrCapture = Buffer.alloc(0)
    nextChild.stderr?.on?.('data', (chunk) => {
      stderrCapture = appendBoundedCapture(stderrCapture, chunk)
    })

    clearStableTimer()
    if (recovery && restartAttempt > 0 && stableRunMs > 0) {
      stableTimer = setTimeoutFn(() => {
        stableTimer = null
        if (desiredRunning && generation === nextGeneration && child === nextChild && isChildRunning(nextChild)) {
          restartAttempt = 0
        }
      }, stableRunMs)
      stableTimer?.unref?.()
    }

    let finalized = false
    const finalizeExit = (code, signal, error = null) => {
      if (finalized) return
      finalized = true
      if (generation !== nextGeneration || child !== nextChild) return
      clearStableTimer()
      child = null
      childLeaseKey = ''
      if (error) stderrCapture = appendBoundedCapture(stderrCapture, Buffer.from(String(error?.message || 'watcher-process-error')))
      lastExit = {
        exitCode: safeExitCode(code),
        signal: safeSignal(signal),
        exitedAt: nowIso(),
        stderrSummary: sanitizedStderr(stderrCapture),
      }
      if (!desiredRunning) {
        processState = 'manually-stopped'
        nextRestartAt = null
        return
      }
      scheduleRecovery(nextGeneration)
    }
    nextChild.once('error', (error) => finalizeExit(null, null, error))
    nextChild.once('exit', (code, signal) => finalizeExit(code, signal))

    return {
      running: true,
      pid: nextChild.pid,
      reused: false,
      alreadyRunning: false,
      restarted: recovery,
      previousPid: null,
      leaseKey: launch.leaseKey,
    }
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
      desiredRunning = true
      processState = 'running'
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

    void restart
    clearRestartTimer()
    clearStableTimer()
    desiredRunning = true
    restartAttempt = 0
    lastLaunch = {
      action,
      dbPath: actionDbPath || DEFAULT_DB_PATH,
      runtimeDir: actionRuntimeDir || DEFAULT_RUNTIME_DIR,
      maxSeconds,
      leaseKey: requestedLeaseKey,
    }
    return spawnManaged(lastLaunch)
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
      const timer = setTimeoutFn(() => {
        if (settled) return
        settled = true
        nextChild.kill?.()
        resolve({ ok: false, pid: nextChild.pid, code: null, signal: 'timeout', timedOut: true })
      }, timeout)
      nextChild.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        resolve({ ok: code === 0, pid: nextChild.pid, code, signal, timedOut: false })
      })
    })
  }

  function markStoppedIntent() {
    desiredRunning = false
    restartAttempt = 0
    clearRestartTimer()
    clearStableTimer()
    processState = isChildRunning(child) ? 'stopping' : 'manually-stopped'
  }

  function stop() {
    markStoppedIntent()
    if (!isChildRunning(child)) return { stopped: false }
    const pid = child.pid
    child.kill()
    return { stopped: true, pid }
  }

  function reset() {
    return stop()
  }

  function signalAndWait(target, signal, timeoutMs) {
    if (!isChildRunning(target)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (exited) => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        target.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = () => finish(true)
      target.once('exit', onExit)
      try { target.kill(signal) } catch { return finish(false) }
      if (!isChildRunning(target)) return finish(true)
      timer = setTimeoutFn(() => finish(false), Math.max(1, Number(timeoutMs || 1)))
    })
  }

  async function stopAndWait({ timeoutMs = 10_000, forceTimeoutMs = 2_000 } = {}) {
    markStoppedIntent()
    if (!isChildRunning(child)) return { stopped: false }
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
    processState = 'manually-stopped'
    return { stopped: true, pid, forced }
  }

  async function waitForHealthy({ timeoutMs = 10_000, pollMs = 50 } = {}) {
    const target = child
    const expectedLeaseKey = childLeaseKey
    const deadline = Date.now() + Math.max(1, Number(timeoutMs || 1))
    const interval = Math.max(1, Number(pollMs || 1))
    while (Date.now() <= deadline) {
      if (!desiredRunning || child !== target || !isChildRunning(target) || childLeaseKey !== expectedLeaseKey) {
        const error = new Error('watcher-restart-unhealthy')
        error.code = 'watcher-restart-unhealthy'
        throw error
      }
      let availability
      try {
        availability = normalizeLeaseAvailability(isRestartLeaseAvailable({
          dbPath: lastLaunch?.dbPath || dbPath,
          runtimeDir: lastLaunch?.runtimeDir || runtimeDir,
          leaseKey: expectedLeaseKey,
          appDir,
          now: nowIso(),
        }))
      } catch {
        availability = { available: true, retryAfterMs: interval }
      }
      if (!availability.available && availability.pid === target.pid) {
        return { healthy: true, pid: target.pid, leaseKey: expectedLeaseKey }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeoutFn(resolve, Math.min(interval, remaining)))
    }
    const error = new Error('watcher-restart-unhealthy')
    error.code = 'watcher-restart-unhealthy'
    throw error
  }

  async function waitForLeaseAvailable({ timeoutMs = 20_000, pollMs = 50 } = {}) {
    const expectedLeaseKey = lastLaunch?.leaseKey || childLeaseKey
    if (!expectedLeaseKey) throw new Error('watcher-stop-unsafe')
    const deadline = Date.now() + Math.max(1, Number(timeoutMs || 1))
    const interval = Math.max(1, Number(pollMs || 1))
    while (Date.now() <= deadline) {
      let availability
      try {
        availability = normalizeLeaseAvailability(isRestartLeaseAvailable({
          dbPath: lastLaunch?.dbPath || dbPath,
          runtimeDir: lastLaunch?.runtimeDir || runtimeDir,
          leaseKey: expectedLeaseKey,
          appDir,
          now: nowIso(),
        }))
      } catch {
        availability = { available: false }
      }
      if (availability.available) return { available: true, leaseKey: expectedLeaseKey }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) => setTimeoutFn(resolve, Math.min(interval, remaining)))
    }
    const error = new Error('watcher-stop-unsafe')
    error.code = 'watcher-stop-unsafe'
    throw error
  }

  function getStatus() {
    return {
      desiredRunning,
      processState,
      lastExit: lastExit ? { ...lastExit } : null,
      restartAttempt,
      nextRestartAt,
    }
  }

  return {
    isRunning: () => isChildRunning(child),
    getStatus,
    start,
    runLoginTest,
    stop,
    stopAndWait,
    waitForLeaseAvailable,
    waitForHealthy,
    reset,
  }
}
