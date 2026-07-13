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
