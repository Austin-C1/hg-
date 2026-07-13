import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createWindowsUpdateHandoff } from '../src/crown/update/windows-update-handoff.mjs'

const NOW = '2026-07-13T08:00:00.000Z'

async function identityAt(path) {
  const metadata = await lstat(path, { bigint: true })
  return { dev: metadata.dev, ino: metadata.ino }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-handoff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appRoot = join(root, 'app')
  const dataRoot = join(root, 'data')
  const runtimeDir = join(dataRoot, 'runtime')
  const updateDir = join(dataRoot, 'updates')
  const backupDir = join(dataRoot, 'backups')
  const currentPath = join(appRoot, 'current.json')
  const statePath = join(runtimeDir, 'launcher-state.json')
  const bootstrapPath = join(appRoot, 'launcher', 'update-bootstrap.ps1')
  const versionDir = join(appRoot, 'versions', '0.2.0')
  await mkdir(join(appRoot, 'launcher'), { recursive: true })
  await mkdir(versionDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(updateDir, { recursive: true })
  await mkdir(backupDir, { recursive: true })
  await writeFile(currentPath, '{"schemaVersion":1,"version":"0.1.0"}\n')
  await writeFile(bootstrapPath, '# fixture\n')
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    installationId: 'install-A',
    version: '0.1.0',
    port: 8787,
    pid: process.pid,
    processStartTime: NOW,
    launchNonce: 'N'.repeat(43),
    stopToken: 'S'.repeat(43),
  })}\n`)
  return { root, appRoot, dataRoot, runtimeDir, updateDir, backupDir, currentPath, statePath, bootstrapPath, versionDir }
}

test('portable handoff publishes one exact apply request before launching visible bootstrap', async (t) => {
  const paths = await fixture(t)
  const launches = []
  const handoff = createWindowsUpdateHandoff({
    ...paths,
    dbPath: join(paths.dataRoot, 'storage', 'crown.sqlite'),
    installationId: 'install-A',
    currentVersion: '0.1.0',
    processStartTime: NOW,
    probeCurrent: async ({ state, probeToken }) => {
      assert.equal(state.pid, process.pid)
      assert.match(probeToken, /^[A-Za-z0-9_-]{43}$/)
      return true
    },
    launchBootstrap: async (value) => { launches.push(value) },
    randomToken: () => randomBytes(32).toString('base64url'),
    randomId: () => 'update-A',
  })

  const result = await handoff({
    expectedVersion: '0.2.0',
    versionDir: paths.versionDir,
    publishedIdentity: await identityAt(paths.versionDir),
  })
  assert.equal(result.started, true)
  assert.equal(result.updateId, 'update-A')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].visible, true)
  assert.equal(launches[0].requestPath, result.requestPath)
  const request = JSON.parse(await readFile(result.requestPath, 'utf8'))
  assert.deepEqual(Object.keys(request), [
    'schemaVersion', 'operation', 'installationId', 'updateId', 'previousVersion',
    'candidateVersion', 'expectedVersion', 'dataRoot', 'journalPath', 'dbPath',
    'backupPath', 'appRoot', 'currentPath', 'candidateIdentity', 'oldProcess',
  ])
  assert.equal(request.operation, 'apply')
  assert.equal(request.previousVersion, '0.1.0')
  assert.equal(request.candidateVersion, '0.2.0')
  assert.equal(request.dataRoot, paths.dataRoot)
  assert.equal(request.appRoot, paths.appRoot)
  assert.equal(request.journalPath, join(paths.updateDir, 'operations', 'update-A', 'journal.json'))
  assert.deepEqual(request.candidateIdentity, {
    dev: String((await identityAt(paths.versionDir)).dev),
    ino: String((await identityAt(paths.versionDir)).ino),
  })
  assert.deepEqual(request.oldProcess, {
    pid: process.pid,
    processStartTime: NOW,
    installationId: 'install-A',
    processInstanceId: 'N'.repeat(43),
    probeToken: request.oldProcess.probeToken,
  })
  assert.match(request.oldProcess.probeToken, /^[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(JSON.stringify(request), /stopToken|password|cookie|session/i)
})

test('handoff fails closed on stale identity, wrong version directory, or bootstrap launch failure', async (t) => {
  const paths = await fixture(t)
  const common = {
    ...paths,
    dbPath: join(paths.dataRoot, 'storage', 'crown.sqlite'),
    installationId: 'install-A',
    currentVersion: '0.1.0',
    processStartTime: NOW,
    randomToken: () => 'P'.repeat(43),
    randomId: () => 'update-B',
  }
  const publishedIdentity = await identityAt(paths.versionDir)
  await assert.rejects(createWindowsUpdateHandoff({
    ...common,
    probeCurrent: async () => false,
    launchBootstrap: async () => assert.fail('must not launch'),
  })({ expectedVersion: '0.2.0', versionDir: paths.versionDir, publishedIdentity }), /update-handoff-current-process-unverified/)

  await assert.rejects(createWindowsUpdateHandoff({
    ...common,
    probeCurrent: async () => true,
    launchBootstrap: async () => assert.fail('must not launch'),
  })({ expectedVersion: '0.2.0', versionDir: join(paths.root, 'outside'), publishedIdentity }), /update-handoff-version-path-invalid/)

  const handoff = createWindowsUpdateHandoff({
    ...common,
    probeCurrent: async () => true,
    launchBootstrap: async () => { throw new Error('spawn failed') },
  })
  await assert.rejects(handoff({ expectedVersion: '0.2.0', versionDir: paths.versionDir, publishedIdentity }), /update-handoff-bootstrap-failed/)
  const requestPath = join(paths.updateDir, 'active-request.json')
  assert.equal(await readFile(requestPath, 'utf8').then(() => true, () => false), false)
})

test('handoff never accepts a launcher state owned by another process or installation', async (t) => {
  const paths = await fixture(t)
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
  const publishedIdentity = await identityAt(paths.versionDir)
  for (const patch of [
    { pid: process.pid + 1 },
    { installationId: 'install-other' },
    { processStartTime: '2026-07-13T08:00:01.000Z' },
    { version: '0.1.1' },
  ]) {
    await writeFile(paths.statePath, `${JSON.stringify({ ...state, ...patch })}\n`)
    const handoff = createWindowsUpdateHandoff({
      ...paths,
      dbPath: join(paths.dataRoot, 'storage', 'crown.sqlite'),
      installationId: 'install-A',
      currentVersion: '0.1.0',
      processStartTime: NOW,
      probeCurrent: async () => true,
      launchBootstrap: async () => assert.fail('must not launch'),
    })
    await assert.rejects(handoff({ expectedVersion: '0.2.0', versionDir: paths.versionDir, publishedIdentity }), /update-handoff-launcher-state-mismatch/)
  }
})

test('handoff refuses a staged directory replaced after publication', async (t) => {
  const paths = await fixture(t)
  const publishedIdentity = await identityAt(paths.versionDir)
  await rename(paths.versionDir, `${paths.versionDir}-owned`)
  await mkdir(paths.versionDir)
  const handoff = createWindowsUpdateHandoff({
    ...paths,
    dbPath: join(paths.dataRoot, 'storage', 'crown.sqlite'),
    installationId: 'install-A',
    currentVersion: '0.1.0',
    processStartTime: NOW,
    probeCurrent: async () => assert.fail('must not probe'),
    launchBootstrap: async () => assert.fail('must not launch'),
  })
  await assert.rejects(
    handoff({ expectedVersion: '0.2.0', versionDir: paths.versionDir, publishedIdentity }),
    /update-handoff-path-invalid/,
  )
})
