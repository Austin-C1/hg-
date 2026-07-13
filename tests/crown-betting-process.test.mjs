import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { bettingWorkerLeaseKey, createBettingProcessController } from '../src/crown/app/betting-process.mjs'

function fakeSpawn(calls, { ready = true, exitOnKill = true } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 4100 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.killSignals = []
    child.sent = []
    child.send = (message) => { child.sent.push(message) }
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true
      child.killSignals.push(signal)
      if (exitOnKill || signal === 'SIGKILL') queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal) })
    }
    calls.push({ command, args, options, child })
    if (ready) queueMicrotask(() => {
      const workerKey = args[args.indexOf('--worker-lease-key') + 1]
      const suffix = workerKey.slice('betting-worker:'.length)
      child.emit('message', {
        type: 'ready', generation: args[args.indexOf('--generation') + 1], nonce: args[args.indexOf('--ready-nonce') + 1],
        leases: {
          worker: { leaseKey: workerKey, ownerId: 'worker-owner', fencingToken: 1 },
          executor: { leaseKey: `betting-executor:${suffix}`, ownerId: 'executor-owner', fencingToken: 1 },
          reconciler: { leaseKey: `betting-reconciler:${suffix}`, ownerId: 'reconciler-owner', fencingToken: 1 },
        },
      })
    })
    return child
  }
}

test('betting process commits start only after canonical worker ready handshake', async () => {
  const calls = []
  const controller = createBettingProcessController({ cwd: process.cwd(), dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls) })
  const started = await controller.start()
  assert.equal(calls.length, 1)
  assert.equal(started.leaseKey, bettingWorkerLeaseKey({ cwd: process.cwd(), dbPath: 'storage/test.sqlite' }))
  assert.equal(calls[0].child.sent.length, 0)
  assert.equal(started.readyTicket.leases.executor.leaseKey.startsWith('betting-executor:'), true)
  started.activate()
  assert.deepEqual(calls[0].child.sent, [{ type: 'go', generation: started.readyTicket.generation, nonce: started.readyTicket.nonce }])
  assert.match(started.leaseKey, /^betting-worker:/)
  assert.notEqual(started.leaseKey, `betting-executor:${started.leaseKey.slice('betting-worker:'.length)}`)
  assert.notEqual(started.leaseKey, `betting-reconciler:${started.leaseKey.slice('betting-worker:'.length)}`)
  assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'real')
  assert.equal(calls[0].args[calls[0].args.indexOf('--worker-lease-key') + 1], started.leaseKey)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc'])
  assert.equal(calls[0].options.windowsHide, true)
})

test('restart waits for the old child exit before spawning and awaiting a new ready handshake', async () => {
  const calls = []
  const controller = createBettingProcessController({ dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls) })
  const first = await controller.start()
  const restarted = await controller.start({ restart: true })
  assert.equal(restarted.running, true)
  assert.notEqual(restarted.pid, first.pid)
  assert.equal(calls[0].child.killed, true)
  assert.equal(calls.length, 2)
  assert.equal((await controller.stop()).stopped, true)
})

test('stop aborts an in-flight start and waits for child exit without allowing a late ready commit', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls, { ready: false }), readyTimeoutMs: 1000,
  })
  const starting = controller.start()
  await new Promise((resolve) => setImmediate(resolve))
  const stopped = await controller.stop()
  assert.equal(stopped.stopped, true)
  await assert.rejects(starting, /betting-worker-start-aborted/)
  calls[0].child.emit('message', { type: 'ready', leaseKey: bettingWorkerLeaseKey({ dbPath: 'storage/test.sqlite' }) })
  assert.equal(controller.isRunning(), false)
})

test('stop escalates to SIGKILL after the graceful exit timeout', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls, { exitOnKill: false }), stopTimeoutMs: 5,
  })
  await controller.start()
  const result = await controller.stop()
  assert.equal(result.stopped, true)
  assert.deepEqual(calls[0].child.killSignals, ['SIGTERM', 'SIGKILL'])
})

test('current child exit reports its generation while a stopped child does not revive runtime', async () => {
  const calls = []
  const exits = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls), onExit: (event) => exits.push(event),
  })
  const started = await controller.start()
  calls[0].child.exitCode = 1
  calls[0].child.emit('exit', 1, null)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(exits.length, 1)
  assert.equal(exits[0].generation, started.readyTicket.generation)
  assert.equal(exits[0].unexpected, true)
  assert.equal(controller.isRunning(), false)
})
