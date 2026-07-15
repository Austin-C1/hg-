import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createMonitorProcessController } from '../src/crown/app/monitor-process.mjs'
import { watcherLeaseKey } from '../src/crown/app/watcher-lease-key.mjs'

function fakeSpawnFactory(calls) {
  return function fakeSpawn(command, args, options) {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.pid = 12345
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = () => {
      child.killed = true
      child.signalCode = 'SIGTERM'
      child.emit('exit', null, 'SIGTERM')
    }
    setImmediate(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return child
  }
}

function fakeLongRunningSpawnFactory(calls) {
  let nextPid = 2000
  return function fakeSpawn(command, args, options) {
    const child = new EventEmitter()
    child.pid = nextPid
    nextPid += 1
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = () => {
      child.killed = true
      child.signalCode = 'SIGTERM'
      child.emit('exit', null, 'SIGTERM')
    }
    calls.push({ command, args, options, child })
    return child
  }
}

function fakeRecoveryHarness() {
  let nowMs = Date.parse('2026-07-13T00:00:00.000Z')
  let timerId = 0
  const timers = new Map()
  const calls = []
  const cleared = new Map()
  return {
    calls,
    now: () => new Date(nowMs),
    setTimeoutFn(callback, delay) {
      timerId += 1
      const timer = { id: timerId, callback, delay, at: nowMs + delay, cleared: false, unref() {} }
      timers.set(timer.id, timer)
      return timer
    },
    clearTimeoutFn(timer) {
      if (!timer) return
      const current = timers.get(timer.id)
      if (current) {
        current.cleared = true
        timers.delete(timer.id)
        cleared.set(timer.id, current)
      }
    },
    spawnCommand(command, args, options) {
      const child = new EventEmitter()
      child.pid = 4000 + calls.length
      child.exitCode = null
      child.signalCode = null
      child.stderr = new EventEmitter()
      child.kill = (signal = 'SIGTERM') => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      }
      calls.push({ command, args, options, child })
      return child
    },
    activeDelays: () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b),
    runDelay(delay) {
      const timer = [...timers.values()].find((candidate) => candidate.delay === delay)
      assert.ok(timer, `missing timer ${delay}`)
      timers.delete(timer.id)
      nowMs = timer.at
      timer.callback()
      return timer
    },
    runCleared(timer) {
      const value = cleared.get(timer.id) || timer
      nowMs = Math.max(nowMs, value.at)
      value.callback()
    },
    crash(index, { code = 1, signal = null, stderr = '' } = {}) {
      const child = calls[index].child
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.exitCode = code
      child.signalCode = signal
      child.emit('exit', code, signal)
    },
  }
}

test('monitor process runLoginTest starts crown-watch with --login-test and waits for exit', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeSpawnFactory(calls),
  })

  const result = await controller.runLoginTest({ maxSeconds: 7 })

  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.includes('--login-test'), true)
  assert.equal(calls[0].args.includes('--max-seconds'), true)
  assert.equal(calls[0].args.at(-1), '7')
})

test('monitor process restart reuses an unexpired managed watcher instead of killing it', () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
  })

  const first = controller.start()
  const second = controller.start({ restart: true })

  assert.equal(first.pid, 2000)
  assert.equal(second.pid, 2000)
  assert.equal(second.reused, true)
  assert.equal(second.alreadyRunning, true)
  assert.equal(second.restarted, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].child.killed, false)
  assert.equal(controller.isRunning(), true)
})

test('Dashboard child exposes the same canonical watcher lease key as its manual CLI arguments', () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
  })

  const started = controller.start()

  assert.equal(calls.length, 1)
  const dbIndex = calls[0].args.indexOf('--app-db')
  const runtimeIndex = calls[0].args.indexOf('--runtime-dir')
  assert.equal(started.leaseKey, watcherLeaseKey({
    cwd: process.cwd(),
    dbPath: calls[0].args[dbIndex + 1],
    runtimeDir: calls[0].args[runtimeIndex + 1],
  }))
})

test('a managed watcher refuses a different requested lease key without killing or reusing the child', () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
  })
  controller.start()

  assert.throws(() => controller.start({
    restart: true,
    dbPath: 'storage/other.sqlite',
    runtimeDir: 'data/other-runtime',
  }), /watcher-already-running-different-lease/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].child.killed, false)
})

test('stopAndWait resolves only after the managed watcher exits', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
  })
  controller.start()

  const result = await controller.stopAndWait()

  assert.equal(result.stopped, true)
  assert.equal(calls[0].child.killed, true)
  assert.equal(controller.isRunning(), false)
})

test('stopAndWait escalates to forced termination and waits for the watcher exit', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand(command, args, options) {
      const child = new EventEmitter()
      child.pid = 3001
      child.exitCode = null
      child.signalCode = null
      child.killed = false
      child.killSignals = []
      child.kill = (signal = 'SIGTERM') => {
        child.killed = true
        child.killSignals.push(signal)
        if (signal === 'SIGKILL') queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal) })
      }
      calls.push({ command, args, options, child })
      return child
    },
  })
  controller.start()
  const result = await controller.stopAndWait({ timeoutMs: 5, forceTimeoutMs: 20 })
  assert.equal(result.forced, true)
  assert.deepEqual(calls[0].child.killSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(controller.isRunning(), false)
})

test('stopAndWait reports a stable unsafe failure when forced termination cannot stop the watcher', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand(command, args, options) {
      const child = new EventEmitter()
      child.pid = 3002
      child.exitCode = null
      child.signalCode = null
      child.killed = false
      child.killSignals = []
      child.kill = (signal = 'SIGTERM') => { child.killed = true; child.killSignals.push(signal) }
      calls.push({ command, args, options, child })
      return child
    },
  })
  controller.start()
  await assert.rejects(controller.stopAndWait({ timeoutMs: 5, forceTimeoutMs: 5 }), /watcher-stop-unsafe/)
  assert.deepEqual(calls[0].child.killSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(controller.isRunning(), true)
})

test('waitForHealthy confirms the managed watcher has acquired its exact lease', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
    isRestartLeaseAvailable: () => ({ available: false, retryAfterMs: 1_000, pid: 2000 }),
  })
  const started = controller.start()

  const result = await controller.waitForHealthy({ timeoutMs: 20, pollMs: 1 })

  assert.deepEqual(result, { healthy: true, pid: started.pid, leaseKey: started.leaseKey })
})

test('waitForHealthy rejects an exact lease held by a different process', async () => {
  const calls = []
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
    isRestartLeaseAvailable: () => ({ available: false, retryAfterMs: 1_000, pid: 9999 }),
  })
  controller.start()

  await assert.rejects(
    controller.waitForHealthy({ timeoutMs: 5, pollMs: 1 }),
    /watcher-restart-unhealthy/,
  )
})

test('waitForLeaseAvailable waits until the stopped watcher lease is released', async () => {
  const calls = []
  let checks = 0
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: fakeLongRunningSpawnFactory(calls),
    isRestartLeaseAvailable: () => (++checks >= 2),
  })
  controller.start()
  await controller.stopAndWait()

  const result = await controller.waitForLeaseAvailable({ timeoutMs: 20, pollMs: 1 })

  assert.equal(result.available, true)
  assert.equal(checks, 2)
})

test('unexpected exits retain bounded sanitized diagnostics and recover after 2, 5, and 15 seconds only', () => {
  const harness = fakeRecoveryHarness()
  const controller = createMonitorProcessController({
    cwd: process.cwd(),
    dbPath: 'storage/test.sqlite',
    runtimeDir: 'data/runtime-test',
    spawnCommand: harness.spawnCommand,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    now: harness.now,
    isRestartLeaseAvailable: () => true,
    stableRunMs: 60_000,
  })

  controller.start()
  harness.crash(0, {
    stderr: `fatal watcher error cookie=secret-token password=hunter2 C:\\Users\\Owner\\private\\state.json\n${'x'.repeat(5000)}`,
  })
  let status = controller.getStatus()
  assert.equal(status.desiredRunning, true)
  assert.equal(status.processState, 'waiting-restart')
  assert.equal(status.restartAttempt, 1)
  assert.equal(status.nextRestartAt, '2026-07-13T00:00:02.000Z')
  assert.equal(status.lastExit.exitCode, 1)
  assert.equal(status.lastExit.signal, null)
  assert.equal(status.lastExit.exitedAt, '2026-07-13T00:00:00.000Z')
  assert.match(status.lastExit.stderrSummary, /fatal watcher error/)
  assert.doesNotMatch(status.lastExit.stderrSummary, /secret-token|hunter2|Owner|state\.json/i)
  assert.equal(Buffer.byteLength(status.lastExit.stderrSummary) <= 2048, true)
  assert.match(status.lastExit.stderrSummary, /x{50}$/)
  assert.deepEqual(harness.activeDelays(), [2000])

  harness.runDelay(2000)
  assert.equal(harness.calls.length, 2)
  harness.crash(1)
  assert.equal(controller.getStatus().restartAttempt, 2)
  assert.deepEqual(harness.activeDelays(), [5000])
  harness.runDelay(5000)
  harness.crash(2)
  assert.equal(controller.getStatus().restartAttempt, 3)
  assert.deepEqual(harness.activeDelays(), [15000])
  harness.runDelay(15000)
  harness.crash(3)
  status = controller.getStatus()
  assert.equal(status.processState, 'stopped-after-retries')
  assert.equal(status.restartAttempt, 3)
  assert.equal(status.nextRestartAt, null)
  assert.deepEqual(harness.activeDelays(), [])
})

test('manual stop and reset invalidate pending or old-generation recovery callbacks', () => {
  const harness = fakeRecoveryHarness()
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand: harness.spawnCommand,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    now: harness.now,
    isRestartLeaseAvailable: () => true,
  })
  controller.start()
  harness.crash(0)
  const pending = harness.runDelay(2000)
  assert.equal(harness.calls.length, 2)
  harness.crash(1)
  const stale = { ...harness.runDelay(5000) }
  assert.equal(harness.calls.length, 3)
  harness.crash(2)
  const stopped = controller.stop()
  assert.equal(stopped.stopped, false)
  assert.equal(controller.getStatus().desiredRunning, false)
  assert.equal(controller.getStatus().processState, 'manually-stopped')
  harness.runCleared(stale)
  harness.runCleared(pending)
  assert.equal(harness.calls.length, 3)

  controller.start()
  assert.equal(harness.calls.length, 4)
  const reset = controller.reset()
  assert.equal(reset.stopped, true)
  assert.equal(controller.getStatus().desiredRunning, false)
  assert.equal(controller.getStatus().processState, 'manually-stopped')
  assert.equal(harness.calls.length, 4)
})

test('recovery rechecks desired state and lease before every replacement spawn', () => {
  const harness = fakeRecoveryHarness()
  let leaseAvailable = false
  let checks = 0
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand: harness.spawnCommand,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    now: harness.now,
    isRestartLeaseAvailable() {
      checks += 1
      return leaseAvailable ? true : { available: false, retryAfterMs: 1000 }
    },
  })
  controller.start()
  harness.crash(0)
  harness.runDelay(2000)
  assert.equal(checks, 1)
  assert.equal(harness.calls.length, 1)
  assert.equal(controller.getStatus().processState, 'waiting-restart')
  assert.deepEqual(harness.activeDelays(), [1000])
  leaseAvailable = true
  harness.runDelay(1000)
  assert.equal(checks, 2)
  assert.equal(harness.calls.length, 2)
  assert.equal(controller.getStatus().processState, 'running')
})

test('a recovered watcher earns a fresh retry budget only after the stable-run window', () => {
  const harness = fakeRecoveryHarness()
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand: harness.spawnCommand,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    now: harness.now,
    isRestartLeaseAvailable: () => true,
    stableRunMs: 60_000,
  })
  controller.start()
  harness.crash(0)
  harness.runDelay(2000)
  assert.equal(controller.getStatus().restartAttempt, 1)
  harness.runDelay(60_000)
  assert.equal(controller.getStatus().restartAttempt, 0)
  harness.crash(1)
  assert.equal(controller.getStatus().restartAttempt, 1)
  assert.deepEqual(harness.activeDelays(), [2000])
})

test('child process error events are sanitized and enter the same bounded recovery state', () => {
  const harness = fakeRecoveryHarness()
  const controller = createMonitorProcessController({
    cwd: process.cwd(), dbPath: 'storage/test.sqlite', runtimeDir: 'data/runtime-test',
    spawnCommand: harness.spawnCommand,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    now: harness.now,
    isRestartLeaseAvailable: () => true,
  })
  controller.start()
  harness.calls[0].child.emit('error', new Error('spawn failed token=private C:\\Users\\Owner\\watcher.mjs'))
  const status = controller.getStatus()
  assert.equal(status.processState, 'waiting-restart')
  assert.equal(status.restartAttempt, 1)
  assert.match(status.lastExit.stderrSummary, /spawn failed/)
  assert.doesNotMatch(status.lastExit.stderrSummary, /private|Owner|watcher\.mjs/)
  assert.deepEqual(harness.activeDelays(), [2000])
})
