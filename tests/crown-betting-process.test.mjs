import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  BETTING_PROCESS_STOP_TIMEOUT_MS,
  bettingRoleLeaseKeys,
  bettingWorkerLeaseKey,
  createBettingProcessController,
} from '../src/crown/app/betting-process.mjs'
import { reconciliationLeaseKey } from '../src/crown/app/reconciliation-process.mjs'

const bettingProcessModulePromise = import('../src/crown/app/betting-process.mjs')

function fakeSpawn(calls, { ready = true, exitOnKill = true, exitOnSigkill = true } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 4100 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.killSignals = []
    child.sent = []
    child.send = (message, callback) => {
      child.sent.push(message)
      queueMicrotask(() => callback?.(null))
    }
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true
      child.killSignals.push(signal)
      if (exitOnKill || (signal === 'SIGKILL' && exitOnSigkill)) {
        queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal) })
      }
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
        browserStatus: { accounts: [] },
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
  await started.activate()
  assert.deepEqual(calls[0].child.sent, [{ type: 'go', generation: started.readyTicket.generation, nonce: started.readyTicket.nonce }])
  assert.match(started.leaseKey, /^betting-worker:/)
  assert.notEqual(started.leaseKey, `betting-executor:${started.leaseKey.slice('betting-worker:'.length)}`)
  assert.deepEqual(Object.keys(bettingRoleLeaseKeys({ cwd: process.cwd(), dbPath: 'storage/test.sqlite' })), ['worker', 'executor', 'reconciler'])
  assert.equal(started.readyTicket.leases.reconciler.leaseKey.startsWith('betting-reconciler:'), true)
  assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'real')
  assert.equal(calls[0].args[calls[0].args.indexOf('--worker-lease-key') + 1], started.leaseKey)
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc'])
  assert.equal(calls[0].options.windowsHide, true)
})

test('betting process reports a failed GO delivery instead of claiming activation', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls),
  })
  const started = await controller.start()
  calls[0].child.send = (_message, callback) => {
    queueMicrotask(() => callback?.(new Error('ipc channel closed')))
  }

  await assert.rejects(started.activate(), /betting-worker-go-failed/)
})

test('betting process uses a 25 second parent stop grace', () => {
  assert.equal(BETTING_PROCESS_STOP_TIMEOUT_MS, 25_000)
})

test('betting process stops reconciliation before spawn and restarts it only for due unknown work', async () => {
  const events = []
  const calls = []
  const reconciliationProcess = {
    async stop() { events.push('reconciler-stop'); return { stopped: true, safe: true } },
    async start() { events.push('reconciler-start'); return { running: true } },
  }
  const spawnCommand = (...args) => {
    events.push('betting-spawn')
    return fakeSpawn(calls)(...args)
  }
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand,
    reconciliationProcess,
    hasDueReconciliation: async () => true,
  })

  await controller.start()
  assert.deepEqual(events, ['reconciler-stop', 'betting-spawn'])
  await controller.stop({ startReconciliation: true })
  assert.deepEqual(events, [
    'reconciler-stop', 'betting-spawn', 'reconciler-start',
  ])
})

test('open reconciliation work includes prepared or dispatched attempts before state exists', async () => {
  const { hasOpenReconciliationWork } = await bettingProcessModulePromise
  assert.equal(typeof hasOpenReconciliationWork, 'function')
  let sql = ''
  const database = {
    prepare(value) {
      sql = value
      return { get: () => ({ submit_attempt_id: 'attempt-dispatched' }) }
    },
  }
  assert.equal(hasOpenReconciliationWork(database), true)
  assert.match(sql, /LEFT JOIN bet_reconciliation_state/)
  assert.match(sql, /attempt\.status IN \('submit_prepared','submit_dispatched'\)/)
  assert.match(sql, /child\.status IN \('submit_prepared','submit_dispatched'\)/)
  assert.match(sql, /state\.status IN \('pending','waiting'\)/)
})

test('worker and standalone reconciliation use the same canonical database lease key', () => {
  const dbPath = 'storage/test.sqlite'
  assert.equal(
    bettingRoleLeaseKeys({ cwd: process.cwd(), dbPath }).reconciler,
    reconciliationLeaseKey({ cwd: process.cwd(), dbPath }),
  )
})

test('betting start fails closed when reconciliation ownership did not stop safely', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls),
    reconciliationProcess: {
      async stop() { return { stopped: true, safe: false } },
      async start() { throw new Error('must-not-start') },
    },
  })
  await assert.rejects(() => controller.start(), /reconciliation-worker-stop-unsafe/)
  assert.equal(calls.length, 0)
})

test('unexpected betting child exit hands open unknown work to reconciliation', async () => {
  const calls = []
  let starts = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls),
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      async stop() { return { stopped: false, safe: true } },
      async start() { starts += 1; return { running: true } },
    },
  })
  await controller.start()
  calls[0].child.exitCode = 1
  calls[0].child.emit('exit', 1, null)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(starts, 1)
})

test('unexpected exit starts the generation-bound takeover even while crashed leases are unsafe', async () => {
  const calls = []
  let starts = 0
  let stops = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls),
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      async stop() { stops += 1; return { stopped: false, safe: stops === 1 } },
      async start() { starts += 1; return { running: true } },
      isRunning() { return false },
    },
  })
  await controller.start()
  calls[0].child.exitCode = 1
  calls[0].child.emit('exit', 1, null)
  for (let index = 0; index < 10 && starts === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(starts, 1)
})

test('repeated reconciliation handoff reuses the running standalone process without stop-start churn', async () => {
  let running = false
  let starts = 0
  let stops = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      isRunning() { return running },
      async stop() { stops += 1; running = false; return { stopped: true, safe: true } },
      async start() { starts += 1; running = true; return { running: true } },
    },
  })

  await controller.stop({ startReconciliation: true })
  await controller.stop({ startReconciliation: true })
  assert.equal(starts, 1)
  assert.equal(stops, 0)
})

test('forced but confirmed betting exit schedules takeover without awaiting the ownership TTL', async () => {
  const calls = []
  let starts = 0
  let finishStart
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, { exitOnKill: false }),
    stopTimeoutMs: 1,
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      isRunning() { return false },
      async stop() { return { stopped: false, safe: true } },
      start() {
        starts += 1
        return new Promise((resolve) => { finishStart = resolve })
      },
    },
  })
  await controller.start()
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('handoff-stop-timeout')), 100)
    timer.unref?.()
  })
  const result = await Promise.race([controller.stop({ startReconciliation: true }), timeout])
  assert.equal(result.safe, false)
  assert.equal(starts, 1)
  finishStart?.({ running: true })
})

test('browser status IPC accepts only current generation and safe allowlisted account fields', async () => {
  const calls = []
  const controller = createBettingProcessController({ dbPath: 'storage/test.sqlite', spawnCommand: fakeSpawn(calls) })
  const started = await controller.start()
  assert.deepEqual(controller.getBrowserStatus(), { generation: 1, accounts: [] })
  const current = {
    type: 'browser-status',
    generation: started.readyTicket.generation,
    nonce: started.readyTicket.nonce,
    snapshot: {
      accounts: [{
        accountId: 'account-a', state: 'ready',
        lastHeartbeatAt: '2026-07-15T00:00:00.000Z',
        lastApiSuccessAt: '2026-07-14T23:59:59.000Z',
      }],
    },
  }
  calls[0].child.emit('message', current)
  assert.deepEqual(controller.getBrowserStatus(), { generation: 1, ...current.snapshot })

  calls[0].child.emit('message', {
    ...current,
    generation: String(Number(current.generation) - 1),
    snapshot: { accounts: [{
      accountId: 'stale', state: 'ready', lastHeartbeatAt: '2026-07-15T00:00:01.000Z', lastApiSuccessAt: null,
    }] },
  })
  calls[0].child.emit('message', {
    ...current,
    snapshot: { accounts: [{ ...current.snapshot.accounts[0], cookie: 'secret' }] },
  })
  assert.deepEqual(controller.getBrowserStatus(), { generation: 1, ...current.snapshot })
  assert.equal(controller.isStopped(), false)
  assert.equal('sendAccountCommand' in controller, false)
  await controller.stop()
  assert.equal(controller.isStopped(), true)
  assert.deepEqual(controller.getBrowserStatus(), { generation: 2, accounts: [] })
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

test('unconfirmed old child exit blocks restart and keeps its reference for a later kill retry', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, { exitOnKill: false, exitOnSigkill: false }),
    stopTimeoutMs: 1,
    reconciliationProcess: {
      isRunning() { return false },
      async stop() { return { stopped: false, safe: true } },
      async start() { return { running: true } },
    },
  })
  await controller.start()
  const restartError = await controller.start({ restart: true }).then(() => null, (error) => error)
  const stopped = await controller.stop()

  assert.match(restartError?.message || '', /betting-worker-stop-unsafe/)
  assert.equal(calls.length, 1)
  assert.equal(stopped.safe, false)
  assert.deepEqual(calls[0].child.killSignals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL'])
})

test('late confirmed exit after any unsafe stop still starts reconciliation', async () => {
  const calls = []
  let starts = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, { exitOnKill: false, exitOnSigkill: false }),
    stopTimeoutMs: 1,
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      isRunning() { return false },
      async stop() { return { stopped: false, safe: true } },
      async start() { starts += 1; return { running: true } },
    },
  })
  await controller.start()
  const stopped = await controller.stop()
  assert.equal(stopped.safe, false)
  assert.equal(starts, 0)

  calls[0].child.signalCode = 'SIGKILL'
  calls[0].child.emit('exit', null, 'SIGKILL')
  for (let index = 0; index < 10 && starts === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(starts, 1)
})

test('final shutdown suppresses safety handoff after a forced betting child exit', async () => {
  const calls = []
  let starts = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, { exitOnKill: false }),
    stopTimeoutMs: 1,
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      isRunning() { return false },
      async stop() { return { stopped: false, safe: true } },
      async start() { starts += 1; return { running: true } },
    },
  })
  await controller.start()

  const stopped = await controller.stop({ suppressSafetyHandoff: true })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(stopped.safe, false)
  assert.equal(starts, 0)
})

test('unsafe ownership after a graceful child exit still starts reconciliation', async () => {
  const calls = []
  let starts = 0
  let stops = 0
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls),
    hasDueReconciliation: async () => true,
    reconciliationProcess: {
      isRunning() { return false },
      async stop() { stops += 1; return { stopped: false, safe: stops === 1 } },
      async start() { starts += 1; return { running: true } },
    },
  })
  await controller.start()

  const stopped = await controller.stop()
  for (let index = 0; index < 10 && starts === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(stopped.safe, false)
  assert.equal(starts, 1)
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
