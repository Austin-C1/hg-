import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runUpdatePreflight } from '../src/crown/update/update-preflight.mjs'

function createSafetyDatabase(dbPath, { requested = 0, runtimeState = 'off', unknown = false, submitStatus, reconciliation = false } = {}) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE real_betting_runtime(singleton_id INTEGER PRIMARY KEY, requested INTEGER, runtime_state TEXT);
    INSERT INTO real_betting_runtime VALUES(1, ${requested}, '${runtimeState}');
    CREATE TABLE bet_submit_attempts(submit_attempt_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE bet_reconciliation_state(submit_attempt_id TEXT PRIMARY KEY, status TEXT);
  `)
  if (unknown || submitStatus) db.prepare("INSERT INTO bet_submit_attempts VALUES('attempt-1',?)").run(submitStatus ?? 'unknown')
  if (reconciliation) db.prepare("INSERT INTO bet_reconciliation_state VALUES('attempt-1','manual_review')").run()
  db.close()
}

function controllers(calls = []) {
  let watcherRunning = true
  let workerRunning = true
  return {
    monitorController: {
      isRunning: () => watcherRunning,
      async stopAndWait() { calls.push('watcher-stop'); watcherRunning = false; return { stopped: true } },
    },
    bettingController: {
      isRunning: () => workerRunning,
      async stop() { calls.push('worker-stop'); workerRunning = false; return { stopped: true } },
    },
  }
}

test('preflight checks disk and durable betting state, then stops watcher and worker before handoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dbPath = join(root, 'app.sqlite')
  createSafetyDatabase(dbPath)
  const calls = []

  const result = await runUpdatePreflight({
    dataRoot: root,
    dbPath,
    diskPath: root,
    requiredBytes: 500,
    getAvailableBytes: async (path) => { assert.equal(path, root); calls.push('disk'); return 1_000 },
    capabilities: [
      { previewAllowed: false, submitAllowed: false, reconciliationAllowed: false },
      { previewAllowed: false, submitAllowed: false, reconciliationAllowed: false },
    ],
    ...controllers(calls),
  })

  assert.deepEqual(calls, ['disk', 'worker-stop', 'watcher-stop'])
  assert.deepEqual(result, {
    ready: true,
    requiredBytes: 500,
    availableBytes: 1_000,
    watcherStopped: true,
    workerStopped: true,
    capability: { preview: 0, submit: 0, reconciliation: 0 },
  })
  assert.doesNotMatch(JSON.stringify(result), /app\.sqlite|crown-update-preflight/)
})

test('preflight rejects insufficient disk before stopping processes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dbPath = join(root, 'app.sqlite')
  createSafetyDatabase(dbPath)
  const calls = []
  await assert.rejects(runUpdatePreflight({
    dataRoot: root,
    dbPath, diskPath: root, requiredBytes: 501, getAvailableBytes: async () => 500,
    capabilities: [], ...controllers(calls),
  }), /update-preflight-disk-space-insufficient/)
  assert.deepEqual(calls, [])
})

test('preflight rejects real intent, unknown submit, unresolved reconciliation, and nonzero capabilities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    { name: 'intent', state: { requested: 1, runtimeState: 'running' }, capabilities: [], error: /update-preflight-real-betting-not-off/ },
    { name: 'unknown', state: { unknown: true }, capabilities: [], error: /update-preflight-unknown-submit/ },
    { name: 'reconciliation', state: { reconciliation: true }, capabilities: [], error: /update-preflight-reconciliation-open/ },
    { name: 'capability', state: {}, capabilities: [{ previewAllowed: true, submitAllowed: false, reconciliationAllowed: false }], error: /update-preflight-capability-not-zero/ },
  ]
  for (const current of cases) {
    const dbPath = join(root, `${current.name}.sqlite`)
    createSafetyDatabase(dbPath, current.state)
    const calls = []
    await assert.rejects(runUpdatePreflight({
      dataRoot: root,
      dbPath, diskPath: root, requiredBytes: 1, getAvailableBytes: async () => 100,
      capabilities: current.capabilities, ...controllers(calls),
    }), current.error)
    assert.deepEqual(calls, [])
  }
})

test('preflight fails closed on watcher timeout or a worker that remains running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dbPath = join(root, 'app.sqlite')
  createSafetyDatabase(dbPath)
  await assert.rejects(runUpdatePreflight({
    dataRoot: root,
    dbPath, diskPath: root, requiredBytes: 1, getAvailableBytes: async () => 100, capabilities: [], stopTimeoutMs: 10,
    monitorController: { isRunning: () => true, stopAndWait: async () => new Promise(() => {}) },
    bettingController: { isRunning: () => false, stop: async () => ({ stopped: false }) },
  }), /update-preflight-watcher-stop-timeout/)

  await assert.rejects(runUpdatePreflight({
    dataRoot: root,
    dbPath, diskPath: root, requiredBytes: 1, getAvailableBytes: async () => 100, capabilities: [], stopTimeoutMs: 10,
    monitorController: { isRunning: () => false, stopAndWait: async () => ({ stopped: false }) },
    bettingController: { isRunning: () => true, stop: async () => ({ stopped: true }) },
  }), /update-preflight-worker-still-running/)
})

test('preflight allows only explicit safe terminal submit statuses', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const status of ['submit_prepared', 'submit_dispatched', 'future_status']) {
    const dbPath = join(root, `${status}.sqlite`)
    createSafetyDatabase(dbPath, { submitStatus: status })
    await assert.rejects(runUpdatePreflight({
      dataRoot: root,
      dbPath,
      diskPath: root,
      requiredBytes: 1,
      getAvailableBytes: async () => 100,
      capabilities: [],
      ...controllers(),
    }), /update-preflight-submit-not-terminal/)
  }

  for (const status of ['accepted', 'rejected', 'odds_changed_unsent']) {
    const dbPath = join(root, `${status}.sqlite`)
    createSafetyDatabase(dbPath, { submitStatus: status })
    const result = await runUpdatePreflight({
      dataRoot: root,
      dbPath,
      diskPath: root,
      requiredBytes: 1,
      getAvailableBytes: async () => 100,
      capabilities: [],
      ...controllers(),
    })
    assert.equal(result.ready, true)
  }
})

test('preflight requires contained paths and sanitizes callback and controller type failures', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-update-preflight-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outsideDb = join(sandbox, 'outside.sqlite')
  await mkdir(dataRoot)
  createSafetyDatabase(outsideDb)

  await assert.rejects(runUpdatePreflight({
    dataRoot,
    dbPath: outsideDb,
    diskPath: dataRoot,
    requiredBytes: 1,
    getAvailableBytes: async () => 100,
    capabilities: [],
    ...controllers(),
  }), /update-preflight-db-path-invalid/)

  const dbPath = join(dataRoot, 'app.sqlite')
  createSafetyDatabase(dbPath)
  await assert.rejects(runUpdatePreflight({
    dataRoot,
    dbPath,
    diskPath: dataRoot,
    requiredBytes: 1,
    getAvailableBytes: async () => { throw new Error('secret disk callback details') },
    capabilities: [],
    ...controllers(),
  }), (error) => error?.message === 'update-preflight-disk-check-failed')

  await assert.rejects(runUpdatePreflight({
    dataRoot,
    dbPath,
    diskPath: dataRoot,
    requiredBytes: 1,
    getAvailableBytes: async () => 100,
    capabilities: [],
    monitorController: { isRunning: 'yes', stopAndWait: async () => {} },
    bettingController: { isRunning: () => false, stop: async () => {} },
  }), /update-preflight-controller-invalid/)

  await assert.rejects(runUpdatePreflight({
    dataRoot,
    dbPath,
    diskPath: dataRoot,
    requiredBytes: 1,
    getAvailableBytes: async () => 100,
    capabilities: [],
    monitorController: { isRunning: () => false, stopAndWait: async () => {} },
    bettingController: { isRunning: () => { throw new Error('secret worker status') }, stop: async () => {} },
  }), (error) => error?.message === 'update-preflight-worker-status-failed')
})
