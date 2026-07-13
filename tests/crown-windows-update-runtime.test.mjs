import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createWindowsUpdateRuntime } from '../src/crown/update/windows-update-runtime.mjs'

const START = '2026-07-13T08:00:00.000Z'
const OLD_NONCE = 'O'.repeat(43)
const PROBE = 'P'.repeat(43)
const AUTH = 'A'.repeat(43)
const STOP = 'S'.repeat(43)

async function fixture(t, operation = 'apply') {
  const root = await mkdtemp(join(tmpdir(), 'crown-windows-update-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appRoot = join(root, 'app')
  const dataRoot = join(root, 'data')
  const updateDir = join(dataRoot, 'updates')
  const runtimeDir = join(dataRoot, 'runtime')
  const operationDir = join(updateDir, 'operations', 'update-A')
  const dbPath = join(dataRoot, 'storage', 'crown.sqlite')
  const currentPath = join(appRoot, 'current.json')
  await mkdir(join(appRoot, 'launcher'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.1.0', 'runtime', 'node'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.1.0', 'app', 'scripts'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.2.0', 'runtime', 'node'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.2.0', 'app', 'scripts'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.2.0', 'app', 'src', 'crown', 'app'), { recursive: true })
  await mkdir(join(dataRoot, 'storage'), { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(operationDir, { recursive: true })
  await writeFile(join(appRoot, 'launcher', 'start.ps1'), '# fixture\n')
  await writeFile(join(appRoot, 'versions', '0.1.0', 'runtime', 'node', 'node.exe'), '')
  await writeFile(join(appRoot, 'versions', '0.2.0', 'runtime', 'node', 'node.exe'), '')
  await writeFile(join(appRoot, 'versions', '0.2.0', 'app', 'scripts', 'crown-dashboard.mjs'), '')
  await writeFile(join(appRoot, 'versions', '0.2.0', 'app', 'src', 'crown', 'app', 'app-db.mjs'), '')
  await writeFile(currentPath, '{"schemaVersion":1,"version":"0.1.0"}\n')
  const database = new DatabaseSync(dbPath)
  database.exec('CREATE TABLE runtime_fixture(id INTEGER PRIMARY KEY); PRAGMA user_version=7')
  database.close()
  const candidateStat = await stat(join(appRoot, 'versions', '0.2.0'), { bigint: true })
  const request = {
    schemaVersion: 1,
    operation,
    installationId: 'install-A',
    updateId: 'update-A',
    previousVersion: '0.1.0',
    candidateVersion: '0.2.0',
    expectedVersion: '0.2.0',
    dataRoot,
    journalPath: join(updateDir, 'journal.json'),
    dbPath,
    backupPath: join(dataRoot, 'backups', 'update-A.sqlite'),
    appRoot,
    currentPath,
    candidateIdentity: { dev: String(candidateStat.dev), ino: String(candidateStat.ino) },
    oldProcess: {
      pid: 101,
      processStartTime: START,
      installationId: 'install-A',
      processInstanceId: OLD_NONCE,
      probeToken: PROBE,
    },
  }
  return { root, appRoot, dataRoot, updateDir, runtimeDir, operationDir, dbPath, currentPath, request }
}

function candidate(paths, patch = {}) {
  return {
    schemaVersion: 1,
    updateId: 'update-A',
    installationId: 'install-A',
    version: '0.2.0',
    pid: 202,
    processStartTime: START,
    processInstanceId: 'C'.repeat(43),
    probeToken: PROBE,
    port: 8788,
    authorizationNonce: AUTH,
    stopToken: STOP,
    ...patch,
  }
}

test('candidate is journal-authorized before the exact authorization file is published', async (t) => {
  const paths = await fixture(t)
  const events = []
  let childRecord
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    randomToken: () => AUTH,
    probeToken: PROBE,
    spawnLauncher: async ({ args, env }) => {
      events.push('spawn')
      assert.deepEqual(args.slice(0, 2), ['-NoBrowser', '-CandidateVersion'])
      assert.equal(env.CROWN_WATCHER_AUTOSTART, '0')
      assert.equal(env.CROWN_BETTING_WORKER_AUTOSTART, '0')
      assert.equal(env.CROWN_REAL_BETTING_REQUESTED, '0')
      childRecord = candidate(paths)
      await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(childRecord)}\n`)
    },
    getProcessStartTime: async (pid) => pid === 202 ? START : null,
    sleep: async () => {},
  })

  const returned = await runtime.startCandidate({
    version: '0.2.0',
    env: {},
    async authorize(record) {
      events.push('authorize')
      assert.deepEqual(record, {
        pid: 202,
        processStartTime: START,
        installationId: 'install-A',
        processInstanceId: 'C'.repeat(43),
        probeToken: PROBE,
      })
      assert.equal(await readFile(join(paths.operationDir, 'candidate-authorized.json'), 'utf8').then(() => true, () => false), false)
    },
  })

  events.push('returned')
  assert.deepEqual(events, ['spawn', 'authorize', 'returned'])
  assert.deepEqual(returned, {
    pid: 202,
    processStartTime: START,
    installationId: 'install-A',
    processInstanceId: 'C'.repeat(43),
    probeToken: PROBE,
  })
  const authorized = JSON.parse(await readFile(join(paths.operationDir, 'candidate-authorized.json'), 'utf8'))
  assert.deepEqual(authorized, { ...childRecord, authorized: true })
})

test('candidate launch fails closed on schema or OS start-time mismatch and publishes only an exact abort', async (t) => {
  const paths = await fixture(t)
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    randomToken: () => AUTH,
    probeToken: PROBE,
    spawnLauncher: async () => {
      await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(candidate(paths, { processStartTime: '2026-07-13T08:00:01.000Z' }))}\n`)
    },
    getProcessStartTime: async () => START,
    sleep: async () => {},
  })
  await assert.rejects(runtime.startCandidate({ version: '0.2.0', authorize: async () => assert.fail('must not authorize') }), /update-candidate-process-invalid/)
  const abort = JSON.parse(await readFile(join(paths.operationDir, 'candidate-abort.json'), 'utf8'))
  assert.deepEqual(abort, { ...candidate(paths, { processStartTime: '2026-07-13T08:00:01.000Z' }), abort: true })
  assert.equal(Object.hasOwn(abort, 'authorized'), false)
})

test('probe and stop bind old and candidate processes to PID/start/install/instance/probe without process-name kill', async (t) => {
  const paths = await fixture(t)
  const state = {
    schemaVersion: 1, installationId: 'install-A', version: '0.1.0', port: 8787,
    pid: 101, processStartTime: START, launchNonce: OLD_NONCE, stopToken: STOP,
  }
  await writeFile(join(paths.runtimeDir, 'launcher-state.json'), `${JSON.stringify(state)}\n`)
  await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(candidate(paths))}\n`)
  const calls = []
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    getProcessStartTime: async (pid) => pid === 101 || pid === 202 ? START : null,
    fetchImpl: async (url, options) => {
      calls.push([url, options.headers['x-crown-launcher-probe']])
      const old = url.includes('8787')
      return new Response(JSON.stringify({
        ok: true, app: 'crown-dashboard', readonly: true, installationId: 'install-A',
        version: old ? '0.1.0' : '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
        launchNonce: old ? OLD_NONCE : 'C'.repeat(43), launcherPid: old ? 101 : 202,
        launcherProcessStartTime: START, launcherProbe: PROBE,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const old = paths.request.oldProcess
  assert.deepEqual(await runtime.probeProcess(old), { state: 'alive', ...old })
  await runtime.stopProcess(old)
  assert.deepEqual(JSON.parse(await readFile(join(paths.runtimeDir, 'launcher-stop-request.json'), 'utf8')), {
    schemaVersion: 1, installationId: 'install-A', pid: 101, processStartTime: START,
    launchNonce: OLD_NONCE, stopToken: STOP,
  })
  const candidateProcess = {
    pid: 202, processStartTime: START, installationId: 'install-A',
    processInstanceId: 'C'.repeat(43), probeToken: PROBE,
  }
  assert.deepEqual(await runtime.probeProcess(candidateProcess), { state: 'alive', ...candidateProcess })
  await runtime.stopProcess(candidateProcess)
  assert.deepEqual(JSON.parse(await readFile(join(paths.operationDir, 'candidate-abort.json'), 'utf8')), { ...candidate(paths), abort: true })
  assert.deepEqual(calls, [
    ['http://127.0.0.1:8787/api/health', PROBE],
    ['http://127.0.0.1:8787/api/health', PROBE],
  ])
})

test('dead exact PID is classified dead while PID reuse is never stopped', async (t) => {
  const paths = await fixture(t)
  const dead = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32', getProcessStartTime: async () => null,
  })
  assert.deepEqual(await dead.probeProcess(paths.request.oldProcess), { state: 'dead' })

  const reused = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32', getProcessStartTime: async () => '2026-07-13T08:00:01.000Z',
  })
  await assert.rejects(reused.probeProcess(paths.request.oldProcess), /update-process-identity-mismatch/)
  await assert.rejects(reused.stopProcess(paths.request.oldProcess), /update-process-identity-mismatch/)
})

test('recovery resolves only the exact operation candidate and never starts a second launcher', async (t) => {
  const paths = await fixture(t, 'recover')
  await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(candidate(paths))}\n`)
  let spawned = false
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    spawnLauncher: async () => { spawned = true },
    getProcessStartTime: async () => START,
  })
  assert.deepEqual(await runtime.resolveCandidateProcess({
    updateId: 'update-A', candidatePid: 202, candidateInstanceId: 'C'.repeat(43),
  }), {
    pid: 202, processStartTime: START, installationId: 'install-A',
    processInstanceId: 'C'.repeat(43), probeToken: PROBE,
  })
  assert.deepEqual(await runtime.startPrevious({ version: '0.1.0' }), { started: false, reason: 'launcher-recovery-continues' })
  assert.equal(spawned, false)
})

test('apply rollback starts previous through the stable launcher with all real execution switches off', async (t) => {
  const paths = await fixture(t)
  const launches = []
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    spawnLauncher: async (value) => { launches.push(value) },
  })
  assert.deepEqual(await runtime.startPrevious({ version: '0.1.0', env: {} }), { started: true, version: '0.1.0' })
  assert.equal(launches.length, 1)
  assert.deepEqual(launches[0].args, ['-NoBrowser'])
  assert.equal(launches[0].env.CROWN_WATCHER_AUTOSTART, '0')
  assert.equal(launches[0].env.CROWN_BETTING_WORKER_AUTOSTART, '0')
  assert.equal(launches[0].env.CROWN_REAL_BETTING_REQUESTED, '0')
  assert.equal(launches[0].env.CROWN_REAL_BETTING_ENABLED, '0')
})

test('migration runs only candidate bundled Node and candidate database module with all execution switches off', async (t) => {
  const paths = await fixture(t)
  const calls = []
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    runBundledNode: async (value) => { calls.push(value) },
  })
  assert.deepEqual(await runtime.migrateCandidate({ version: '0.2.0', env: {} }), { migrated: true, version: '0.2.0' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodePath, join(paths.appRoot, 'versions', '0.2.0', 'runtime', 'node', 'node.exe'))
  assert.equal(calls[0].workingDirectory, join(paths.appRoot, 'versions', '0.2.0', 'app'))
  assert.equal(calls[0].env.CROWN_DB_PATH, paths.dbPath)
  assert.equal(calls[0].env.CROWN_WATCHER_AUTOSTART, '0')
  assert.equal(calls[0].env.CROWN_BETTING_WORKER_AUTOSTART, '0')
  assert.equal(calls[0].env.CROWN_REAL_BETTING_REQUESTED, '0')
  assert.equal(calls[0].env.CROWN_REAL_BETTING_ENABLED, '0')
  assert.match(calls[0].args.join(' '), /openAppDatabase/)
})

test('candidate health proves HTTP identity, SQLite integrity, stopped services, and capability 0\/0\/0', async (t) => {
  const paths = await fixture(t)
  const record = candidate(paths)
  await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(record)}\n`)
  await writeFile(join(paths.operationDir, 'candidate-authorized.json'), `${JSON.stringify({ ...record, authorized: true })}\n`)
  let verified = 0
  const healthUrls = []
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    getProcessStartTime: async () => START,
    verifyDatabase: async ({ dataRoot, dbPath }) => {
      assert.equal(dataRoot, paths.dataRoot)
      assert.equal(dbPath, paths.dbPath)
      verified += 1
      return { userVersion: 7 }
    },
    capabilityRows: [
      { previewAllowed: false, submitAllowed: false, reconciliationAllowed: false },
    ],
    fetchImpl: async (url, options) => {
      healthUrls.push(url)
      return new Response(JSON.stringify(url.endsWith('/api/health/update') ? {
      appId: 'crown-monitor', version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
      installationId: 'install-A', probeToken: options.headers['x-crown-update-probe'],
      watcher: { state: 'stopped' }, realBetting: { requested: false, state: 'off' },
      capability: { preview: 0, submit: 0, reconciliation: 0 },
    } : {
      ok: true, app: 'crown-dashboard', readonly: true, installationId: 'install-A',
      version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
      launchNonce: 'C'.repeat(43), launcherPid: 202, launcherProcessStartTime: START,
      launcherProbe: options.headers['x-crown-launcher-probe'],
      }), { status: 200 })
    },
  })
  const result = await runtime.checkHealth({
    process: {
      pid: 202, processStartTime: START, installationId: 'install-A',
      processInstanceId: 'C'.repeat(43), probeToken: PROBE,
    },
    expectedVersion: '0.2.0',
    expectedInstallationId: 'install-A',
    requiredRuntimeState: { watcher: 'stopped', worker: 'stopped', capability: { preview: 0, submit: 0, reconciliation: 0 } },
  })
  assert.deepEqual(result, {
    ok: true, version: '0.2.0', installationId: 'install-A', schemaVersion: 7,
    watcher: 'stopped', worker: 'stopped', capability: { preview: 0, submit: 0, reconciliation: 0 },
  })
  assert.equal(verified, 1)
  assert.deepEqual(healthUrls, [
    'http://127.0.0.1:8788/api/health',
    'http://127.0.0.1:8788/api/health/update',
  ])
})

test('candidate health rejects any production capability above zero before commit', async (t) => {
  const paths = await fixture(t)
  const record = candidate(paths)
  await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(record)}\n`)
  await writeFile(join(paths.operationDir, 'candidate-authorized.json'), `${JSON.stringify({ ...record, authorized: true })}\n`)
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    getProcessStartTime: async () => START,
    verifyDatabase: async () => ({ userVersion: 7 }),
    capabilityRows: [{ previewAllowed: false, submitAllowed: true, reconciliationAllowed: false }],
    fetchImpl: async (url, options) => new Response(JSON.stringify(url.endsWith('/api/health/update') ? {
      appId: 'crown-monitor', version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
      installationId: 'install-A', probeToken: options.headers['x-crown-update-probe'],
      watcher: { state: 'stopped' }, realBetting: { requested: false, state: 'off' },
      capability: { preview: 0, submit: 0, reconciliation: 0 },
    } : {
      ok: true, app: 'crown-dashboard', readonly: true, installationId: 'install-A',
      version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
      launchNonce: 'C'.repeat(43), launcherPid: 202, launcherProcessStartTime: START,
      launcherProbe: options.headers['x-crown-launcher-probe'],
    }), { status: 200 }),
  })
  await assert.rejects(runtime.checkHealth({
    process: {
      pid: 202, processStartTime: START, installationId: 'install-A',
      processInstanceId: 'C'.repeat(43), probeToken: PROBE,
    },
    expectedVersion: '0.2.0', expectedInstallationId: 'install-A',
    requiredRuntimeState: { watcher: 'stopped', worker: 'stopped', capability: { preview: 0, submit: 0, reconciliation: 0 } },
  }), /update-health-capability-not-zero/)
})

test('candidate health waits for the authorized Dashboard to bind both launcher and update probes', async (t) => {
  const paths = await fixture(t)
  const record = candidate(paths)
  await writeFile(join(paths.operationDir, 'candidate.json'), `${JSON.stringify(record)}\n`)
  await writeFile(join(paths.operationDir, 'candidate-authorized.json'), `${JSON.stringify({ ...record, authorized: true })}\n`)
  let launcherAttempts = 0
  const runtime = createWindowsUpdateRuntime(paths.request, {
    platform: 'win32',
    getProcessStartTime: async () => START,
    verifyDatabase: async () => ({ userVersion: 7 }),
    capabilityRows: [{ previewAllowed: false, submitAllowed: false, reconciliationAllowed: false }],
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      if (url.endsWith('/api/health')) {
        launcherAttempts += 1
        if (launcherAttempts === 1) throw new Error('not listening yet')
        return new Response(JSON.stringify({
          ok: true, app: 'crown-dashboard', readonly: true, installationId: 'install-A',
          version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
          launchNonce: 'C'.repeat(43), launcherPid: 202, launcherProcessStartTime: START,
          launcherProbe: options.headers['x-crown-launcher-probe'],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        appId: 'crown-monitor', version: '0.2.0', appContractVersion: 'dynamic-betting-cards-v1',
        installationId: 'install-A', probeToken: options.headers['x-crown-update-probe'],
        watcher: { state: 'stopped' }, realBetting: { requested: false, state: 'off' },
        capability: { preview: 0, submit: 0, reconciliation: 0 },
      }), { status: 200 })
    },
  })
  const result = await runtime.checkHealth({
    process: {
      pid: 202, processStartTime: START, installationId: 'install-A',
      processInstanceId: 'C'.repeat(43), probeToken: PROBE,
    },
    expectedVersion: '0.2.0', expectedInstallationId: 'install-A',
    requiredRuntimeState: { watcher: 'stopped', worker: 'stopped', capability: { preview: 0, submit: 0, reconciliation: 0 } },
  })
  assert.equal(result.ok, true)
  assert.equal(launcherAttempts, 2)
})
