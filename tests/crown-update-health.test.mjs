import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkCandidateHealth, createHealthProbeToken } from '../src/crown/update/update-health.mjs'

function createHealthDatabase(dbPath, { foreignViolation = false } = {}) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA foreign_keys=OFF;
    PRAGMA user_version=7;
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    INSERT INTO parent VALUES(1);
    INSERT INTO child VALUES(1, ${foreignViolation ? 99 : 1});
  `)
  db.close()
}

function healthy(probeToken) {
  return {
    appId: 'crown-monitor',
    version: '0.1.1',
    appContractVersion: 'crown-app-v1',
    installationId: 'install-A',
    probeToken,
    watcher: { state: 'stopped' },
    realBetting: { requested: false, state: 'off' },
    capability: { preview: 0, submit: 0, reconciliation: 0 },
  }
}

function invoke({ root, dbPath, payload, fetchImpl, probeToken: expectedProbeToken } = {}) {
  const probeToken = expectedProbeToken ?? payload?.probeToken ?? createHealthProbeToken()
  return checkCandidateHealth({
    dataRoot: root,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath: dbPath ?? join(root, 'app.sqlite'),
    fetchImpl: fetchImpl ?? (async (_url, options) => {
      assert.equal(options.redirect, 'manual')
      assert.equal(options.headers['x-crown-update-probe'], probeToken)
      return new Response(JSON.stringify(payload ?? healthy(probeToken)), { headers: { 'content-type': 'application/json' } })
    }),
    timeoutMs: 20,
  })
}

test('candidate health binds a random probe to app, installation, version, contract, DB, stopped services, and zero capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  createHealthDatabase(join(root, 'app.sqlite'))
  const probeToken = createHealthProbeToken()
  assert.match(probeToken, /^[A-Za-z0-9_-]{43}$/)
  await assert.rejects(checkCandidateHealth({
    dataRoot: root,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    dbPath: join(root, 'app.sqlite'),
    fetchImpl: async () => assert.fail('missing schema expectation must fail before fetch'),
  }), /update-health-schema-expectation-invalid/)

  const result = await invoke({ root, payload: healthy(probeToken) })

  assert.deepEqual(result, {
    ok: true,
    appId: 'crown-monitor',
    version: '0.1.1',
    appContractVersion: 'crown-app-v1',
    installationId: 'install-A',
    schemaVersion: 7,
    watcherStopped: true,
    realBettingOff: true,
    capability: { preview: 0, submit: 0, reconciliation: 0 },
  })
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${probeToken}|${root.replaceAll('\\', '\\\\')}`))
})

test('candidate health rejects probe token, installation id, version, and contract mismatches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  createHealthDatabase(join(root, 'app.sqlite'))
  const token = createHealthProbeToken()
  const cases = [
    { field: 'probeToken', value: createHealthProbeToken(), error: /update-health-probe-mismatch/ },
    { field: 'installationId', value: 'install-B', error: /update-health-installation-mismatch/ },
    { field: 'version', value: '0.1.2', error: /update-health-version-mismatch/ },
    { field: 'appContractVersion', value: 'crown-app-v2', error: /update-health-contract-mismatch/ },
  ]
  for (const current of cases) {
    await assert.rejects(invoke({ root, probeToken: token, payload: { ...healthy(token), [current.field]: current.value } }), current.error)
  }
})

test('candidate health rejects running watcher, real betting intent/state, and any nonzero capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  createHealthDatabase(join(root, 'app.sqlite'))
  const token = createHealthProbeToken()
  const cases = [
    { payload: { ...healthy(token), watcher: { state: 'running' } }, error: /update-health-watcher-not-stopped/ },
    { payload: { ...healthy(token), realBetting: { requested: true, state: 'off' } }, error: /update-health-real-betting-not-off/ },
    { payload: { ...healthy(token), realBetting: { requested: false, state: 'running' } }, error: /update-health-real-betting-not-off/ },
    { payload: { ...healthy(token), capability: { preview: 0, submit: 1, reconciliation: 0 } }, error: /update-health-capability-not-zero/ },
  ]
  for (const current of cases) await assert.rejects(invoke({ root, payload: current.payload }), current.error)
})

test('candidate health rejects foreign-key corruption, non-loopback URLs, redirects, and timeouts with stable errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dbPath = join(root, 'invalid.sqlite')
  createHealthDatabase(dbPath, { foreignViolation: true })
  const token = createHealthProbeToken()
  await assert.rejects(invoke({ root, dbPath, payload: healthy(token) }), /update-health-database-invalid/)

  await assert.rejects(checkCandidateHealth({
    dataRoot: root,
    healthUrl: 'https://example.com/health', probeToken: token,
    expectedAppId: 'crown-monitor', expectedVersion: '0.1.1', expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A', expectedSchemaVersion: 7, dbPath,
    fetchImpl: async () => assert.fail('non-loopback must fail before fetch'),
  }), /update-health-url-not-loopback/)

  const validDb = join(root, 'valid.sqlite')
  createHealthDatabase(validDb)
  await assert.rejects(invoke({ root, dbPath: validDb, payload: healthy(token), fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9999/other' } }) }), /update-health-redirect-not-allowed/)
  await assert.rejects(invoke({ root, dbPath: validDb, payload: healthy(token), fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), /update-health-timeout/)

  const racedDb = join(root, 'raced.sqlite')
  createHealthDatabase(racedDb)
  await assert.rejects(invoke({
    root,
    dbPath: racedDb,
    payload: healthy(token),
    fetchImpl: async () => {
      const db = new DatabaseSync(racedDb)
      db.exec('PRAGMA foreign_keys=OFF; INSERT INTO child VALUES(2, 99)')
      db.close()
      return new Response(JSON.stringify(healthy(token)), { headers: { 'content-type': 'application/json' } })
    },
  }), /update-health-database-invalid/)
})

test('candidate health requires a contained database and sanitizes fetch callback failures', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outsideDb = join(sandbox, 'outside.sqlite')
  await mkdir(dataRoot)
  createHealthDatabase(outsideDb)
  const token = createHealthProbeToken()

  await assert.rejects(checkCandidateHealth({
    dataRoot,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken: token,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath: outsideDb,
    fetchImpl: async () => assert.fail('outside database must fail before fetch'),
  }), /update-health-database-path-invalid/)

  const dbPath = join(dataRoot, 'app.sqlite')
  createHealthDatabase(dbPath)
  await assert.rejects(checkCandidateHealth({
    dataRoot,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken: token,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath,
    fetchImpl: async () => { throw new Error('secret fetch callback details') },
  }), (error) => error?.message === 'update-health-network-error')

  await assert.rejects(checkCandidateHealth({
    dataRoot,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken: token,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath,
    fetchImpl: 'not-a-function',
  }), /update-health-fetch-invalid/)
})

test('candidate health sanitizes malformed response objects returned by callback code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dbPath = join(root, 'app.sqlite')
  createHealthDatabase(dbPath)
  const token = createHealthProbeToken()
  await assert.rejects(checkCandidateHealth({
    dataRoot: root,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken: token,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath,
    fetchImpl: async () => ({
      get status() { throw new Error('secret response getter details') },
    }),
  }), (error) => error?.message === 'update-health-response-invalid')

  await assert.rejects(checkCandidateHealth({
    dataRoot: root,
    healthUrl: 'http://127.0.0.1:8787/api/app/health',
    probeToken: token,
    expectedAppId: 'crown-monitor',
    expectedVersion: '0.1.1',
    expectedAppContractVersion: 'crown-app-v1',
    expectedInstallationId: 'install-A',
    expectedSchemaVersion: 7,
    dbPath,
    fetchImpl: async () => ({
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          throw new Error('update-health-secret-stream-details')
        },
      },
    }),
  }), (error) => error?.message === 'update-health-network-error')
})
