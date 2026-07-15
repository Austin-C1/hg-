import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'

const modulePromise = import('../src/crown/app/reconciliation-process.mjs').catch(() => ({}))
const workerScriptPromise = import('../scripts/crown-reconciliation-worker.mjs').catch(() => ({}))

async function waitFor(condition, description, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timeout:${description}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function fakeSpawn(calls, { exitOnTerm = true, exitOnKill = true } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 9200 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killSignals = []
    child.kill = (signal = 'SIGTERM') => {
      child.killSignals.push(signal)
      if (signal === 'SIGTERM' && !exitOnTerm) return
      if (signal === 'SIGKILL' && !exitOnKill) return
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
    }
    calls.push({ command, args, options, child })
    queueMicrotask(() => child.emit('message', {
      type: 'ready',
      generation: args[args.indexOf('--generation') + 1],
      nonce: args[args.indexOf('--ready-nonce') + 1],
      lease: {
        leaseKey: args[args.indexOf('--reconciler-lease-key') + 1],
        ownerId: 'reconciler-owner',
        fencingToken: 3,
      },
    }))
    return child
  }
}

test('independent reconciliation process is read-only, fenced, and receives explicit portable paths', async () => {
  const { createReconciliationProcessController, reconciliationLeaseKey } = await modulePromise
  assert.equal(typeof createReconciliationProcessController, 'function')
  assert.equal(typeof reconciliationLeaseKey, 'function')

  const calls = []
  const cwd = path.resolve('C:/crown-app')
  const values = {
    appRoot: cwd,
    dataRoot: path.join(cwd, 'data'),
    runtimeDir: path.join(cwd, 'data/runtime'),
    profileRoot: path.join(cwd, 'data/runtime/browser-profiles'),
    chromiumExecutable: path.join(cwd, 'runtime/chromium/chrome.exe'),
    dbPath: path.join(cwd, 'data/storage/crown.sqlite'),
  }
  const controller = createReconciliationProcessController({
    cwd,
    ...values,
    spawnCommand: fakeSpawn(calls),
  })
  const started = await controller.start()
  assert.equal(started.running, true)
  assert.equal(started.leaseKey, reconciliationLeaseKey({ cwd, dbPath: values.dbPath }))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc'])
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(calls[0].args.includes('--mode'), false)
  for (const [flag, value] of [
    ['--app-root', values.appRoot], ['--data-root', values.dataRoot],
    ['--runtime-dir', values.runtimeDir], ['--profile-root', values.profileRoot],
    ['--chromium-executable', values.chromiumExecutable], ['--db-path', values.dbPath],
  ]) assert.equal(calls[0].args[calls[0].args.indexOf(flag) + 1], value)
  assert.deepEqual(await controller.stop(), { stopped: true, safe: true })
})

test('start waits without spinning for all ownership TTLs, recovers once, then spawns', async () => {
  const calls = []
  const events = []
  let checks = 0
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: (...args) => {
      events.push('spawn')
      return fakeSpawn(calls)(...args)
    },
    ownershipReleased: () => {
      checks += 1
      events.push(`ownership-${checks}`)
      return checks >= 3
    },
    recoverUncertain: async () => { events.push('recover') },
    ownershipWaitMs: 50,
    ownershipPollMs: 2,
  })

  await controller.start()
  assert.deepEqual(events, ['ownership-1', 'ownership-2', 'ownership-3', 'recover', 'ownership-4', 'spawn'])
  assert.equal(calls.length, 1)
  await controller.stop()
})

test('stop cancels ownership wait before any stale-generation spawn', async () => {
  const calls = []
  let checks = 0
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls),
    ownershipReleased: () => {
      checks += 1
      return false
    },
    recoverUncertain: async () => {},
    ownershipWaitMs: 50,
    ownershipPollMs: 2,
  })

  const starting = controller.start()
  await waitFor(() => checks > 0, 'ownership-check')
  await controller.stop()
  await assert.rejects(starting, /reconciliation-worker-start-aborted/)
  assert.equal(calls.length, 0)
})

test('generation is rechecked after an asynchronous ownership check before spawn', async () => {
  const calls = []
  let releaseFirstCheck
  let checks = 0
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls),
    ownershipReleased: () => {
      checks += 1
      if (checks === 1) return new Promise((resolve) => { releaseFirstCheck = resolve })
      return true
    },
    recoverUncertain: async () => {},
    ownershipWaitMs: 50,
    ownershipPollMs: 2,
  })

  const starting = controller.start()
  await waitFor(() => Boolean(releaseFirstCheck), 'async-ownership-check')
  assert.deepEqual(await controller.stop(), { stopped: false, safe: true })
  releaseFirstCheck(true)
  await assert.rejects(starting, /reconciliation-worker-start-aborted/)
  assert.equal(calls.length, 0)
})

test('concurrent ensure-start calls share one ownership wait and one child', async () => {
  const calls = []
  let released = false
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls),
    ownershipReleased: () => released,
    recoverUncertain: async () => {},
    ownershipWaitMs: 50,
    ownershipPollMs: 2,
  })

  const first = controller.start()
  const second = controller.start()
  assert.equal(second, first)
  released = true
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.pid, b.pid)
  assert.equal(calls.length, 1)
  await controller.stop()
})

test('desired standalone process restarts after an unexpected exit and stop cancels recovery', async () => {
  const calls = []
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls),
    ownershipReleased: () => true,
    recoverUncertain: async () => {},
    ownershipWaitMs: 50,
    ownershipPollMs: 2,
  })
  await controller.start()

  calls[0].child.exitCode = 1
  calls[0].child.emit('exit', 1, null)
  await waitFor(() => calls.length === 2, 'reconciliation-restart')
  assert.equal(controller.isRunning(), true)

  await controller.stop()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 2)
})

test('active worker and executor roles block standalone ownership takeover', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-reconciliation-ownership-'))
  const dbPath = path.join(directory, 'app.sqlite')
  const handle = openAppDatabase({ dbPath })
  t.after(() => {
    handle.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const { createReconciliationProcessController, reconciliationLeaseKey } = await modulePromise
  const canonical = reconciliationLeaseKey({ cwd: directory, dbPath }).slice('betting-reconciler:'.length)
  for (const role of ['worker', 'executor']) {
    new RuntimeLease({ db: handle.db, leaseKey: `betting-${role}:${canonical}`, ttlMs: 60_000 }).acquire()
  }
  const calls = []
  const controller = createReconciliationProcessController({
    cwd: directory,
    appRoot: directory,
    dbPath,
    spawnCommand: fakeSpawn(calls),
    recoverUncertain: async () => {},
    ownershipWaitMs: 5,
    ownershipPollMs: 1,
  })

  await assert.rejects(controller.start(), /reconciliation-worker-stop-unsafe/)
  assert.equal(calls.length, 0)
})

test('forced reconciliation termination reports unsafe ownership and cannot authorize betting takeover', async () => {
  const calls = []
  let released = true
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls, { exitOnTerm: false }),
    stopTimeoutMs: 1,
    ownershipReleased: () => released,
  })
  await controller.start()
  released = false
  const result = await controller.stop()
  assert.deepEqual(result, { stopped: true, safe: false })
})

test('unconfirmed SIGKILL keeps the child reference so a later stop retries termination', async () => {
  const calls = []
  let released = true
  const controller = (await modulePromise).createReconciliationProcessController({
    cwd: path.resolve('C:/crown-app'),
    dbPath: path.resolve('C:/crown-app/data/crown.sqlite'),
    spawnCommand: fakeSpawn(calls, { exitOnTerm: false, exitOnKill: false }),
    stopTimeoutMs: 1,
    ownershipReleased: () => released,
    recoverUncertain: async () => {},
  })
  await controller.start()
  released = false

  assert.deepEqual(await controller.stop(), { stopped: true, safe: false })
  assert.deepEqual(await controller.stop(), { stopped: true, safe: false })
  assert.deepEqual(calls[0].child.killSignals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL'])
})

test('read-only reconciliation worker accepts only explicit runtime and handshake arguments', async () => {
  const { argumentsFrom } = await workerScriptPromise
  assert.equal(typeof argumentsFrom, 'function')
  const values = {
    appRoot: 'C:\\app',
    dataRoot: 'C:\\data',
    runtimeDir: 'C:\\data\\runtime',
    profileRoot: 'C:\\data\\runtime\\profiles',
    chromiumExecutable: 'C:\\app\\chromium\\chrome.exe',
    dbPath: 'C:\\data\\storage\\crown.sqlite',
    reconcilerLeaseKey: 'betting-reconciler:C:\\data\\storage\\crown.sqlite',
    generation: '4',
    readyNonce: 'nonce',
  }
  const options = argumentsFrom([
    '--app-root', values.appRoot,
    '--data-root', values.dataRoot,
    '--runtime-dir', values.runtimeDir,
    '--profile-root', values.profileRoot,
    '--chromium-executable', values.chromiumExecutable,
    '--db-path', values.dbPath,
    '--reconciler-lease-key', values.reconcilerLeaseKey,
    '--generation', values.generation,
    '--ready-nonce', values.readyNonce,
  ], { env: {} })
  assert.deepEqual(options, values)
  assert.throws(() => argumentsFrom(['--mode', 'real'], { env: {} }), /unknown-argument/)
})

test('standalone reconciliation worker loads acceptance authority and allows browser query time', () => {
  const source = fs.readFileSync(path.resolve('scripts/crown-reconciliation-worker.mjs'), 'utf8')
  assert.match(source, /loadActiveCrownAcceptanceCapabilityAuthority/)
  assert.match(source, /acceptanceAuthority/)
  assert.match(source, /requestTimeoutMs:\s*30_000/)
})
