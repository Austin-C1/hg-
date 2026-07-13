import assert from 'node:assert/strict'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createDefaultDownloadAndStage,
  createLinkedUpdateFetch,
  createUpdateService,
} from '../src/crown/update/update-service.mjs'

const manifest = Object.freeze({
  version: '0.2.0',
  releaseTag: 'v0.2.0',
  assetName: 'CrownMonitor-v0.2.0-update.zip',
  assetSize: 123,
  assetSha256: 'a'.repeat(64),
  files: [{ path: 'app/index.mjs', size: 1, sha256: 'b'.repeat(64) }],
})

async function identityAt(path) {
  const metadata = await lstat(path, { bigint: true })
  return { dev: metadata.dev, ino: metadata.ino }
}

function service(overrides = {}) {
  const calls = []
  const instance = createUpdateService({
    currentVersion: '0.1.0',
    discoverRelease: async ({ signal }) => {
      calls.push(['discover', signal.aborted])
      return {
        releaseTag: 'v0.2.0',
        releaseNotes: `<script>${'x'.repeat(20_000)}</script>`,
        manifestBytes: new Uint8Array([1]),
        signatureBytes: new Uint8Array([2]),
      }
    },
    verifyManifest: ({ manifestBytes, signatureBytes }) => {
      assert.deepEqual([...manifestBytes], [1])
      assert.deepEqual([...signatureBytes], [2])
      calls.push(['verify'])
      return manifest
    },
    downloadAndStage: async ({ expectedVersion, signal, onProgress }) => {
      assert.equal(expectedVersion, '0.2.0')
      assert.equal(signal.aborted, false)
      onProgress(50)
      calls.push(['stage'])
      return { versionDir: 'D:\\CrownMonitor\\versions\\0.2.0' }
    },
    runPreflight: async () => { calls.push(['preflight']); return { ready: true } },
    launchApplier: async (request) => { calls.push(['apply', request.expectedVersion]); return { handedOff: true } },
    ...overrides,
  })
  return { calls, instance }
}

test('manual check verifies the signed release and exposes only a stable status DTO', async () => {
  const { calls, instance } = service()
  assert.deepEqual(instance.getStatus(), {
    state: 'idle', currentVersion: '0.1.0', availableVersion: '', progress: 0,
    errorCode: '', cancellable: false, releaseNotes: '',
  })
  const status = await instance.check()
  assert.deepEqual(status, {
    state: 'available', currentVersion: '0.1.0', availableVersion: '0.2.0', progress: 0,
    errorCode: '', cancellable: false,
    releaseNotes: `<script>${'x'.repeat(16_376)}`,
  })
  assert.deepEqual(calls, [['discover', false], ['verify']])
  assert.doesNotMatch(JSON.stringify(status), /manifest|signature|asset|path|token/i)
})

test('install requires the exact checked version and apply handoff is not cancellable', async () => {
  const { calls, instance } = service()
  await instance.check()
  await assert.rejects(instance.install({ expectedVersion: '0.2.1' }), /update-expected-version-mismatch/)

  const status = await instance.install({ expectedVersion: '0.2.0' })
  assert.equal(status.state, 'applying')
  assert.equal(status.progress, 100)
  assert.equal(status.cancellable, false)
  assert.deepEqual(await instance.cancel(), { cancelled: false, code: 'update-not-cancellable' })
  assert.deepEqual(calls.slice(2), [['stage'], ['preflight'], ['apply', '0.2.0']])
})

test('apply handoff remains mutually exclusive even though it is no longer cancellable', async () => {
  let releaseApply
  let applying
  const applyStarted = new Promise((resolve) => { applying = resolve })
  const { instance } = service({
    launchApplier: async () => {
      applying()
      await new Promise((resolve) => { releaseApply = resolve })
    },
  })
  await instance.check()
  const install = instance.install({ expectedVersion: '0.2.0' })
  await applyStarted
  assert.deepEqual(await instance.cancel(), { cancelled: false, code: 'update-not-cancellable' })
  await assert.rejects(instance.check(), /update-operation-in-progress/)
  releaseApply()
  await install
  await assert.rejects(instance.check(), /update-apply-in-progress/)
})

test('cancel aborts a pending check and concurrent operations fail with stable codes', async () => {
  let started
  const pending = new Promise((resolve) => { started = resolve })
  const { instance } = service({
    discoverRelease: async ({ signal }) => {
      started()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const checking = instance.check()
  await pending
  await assert.rejects(instance.check(), /update-operation-in-progress/)
  assert.deepEqual(await instance.cancel(), { cancelled: true, code: 'update-cancelled' })
  await assert.rejects(checking, /update-cancelled/)
  assert.equal(instance.getStatus().state, 'idle')
})

test('callback failures are reduced to stable safe error codes', async () => {
  const { instance } = service({
    discoverRelease: async () => { throw new Error('socket token=very-secret C:\\Users\\someone') },
  })
  await assert.rejects(instance.check(), (error) => error.message === 'update-check-failed')
  assert.deepEqual(instance.getStatus(), {
    state: 'error', currentVersion: '0.1.0', availableVersion: '', progress: 0,
    errorCode: 'update-check-failed', cancellable: false, releaseNotes: '',
  })
})

test('cancel restores up-to-date state and callback-shaped update codes cannot bypass redaction', async () => {
  let checkCount = 0
  const { instance } = service({
    verifyManifest: () => ({ ...manifest, version: '0.1.0', releaseTag: 'v0.1.0' }),
    discoverRelease: async ({ signal }) => {
      checkCount += 1
      if (checkCount === 1) return { releaseTag: 'v0.1.0', manifestBytes: new Uint8Array(), signatureBytes: new Uint8Array() }
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  const upToDate = await instance.check()
  assert.equal(upToDate.state, 'up-to-date')
  assert.equal(upToDate.releaseNotes, '')
  const pending = instance.check()
  await Promise.resolve()
  await instance.cancel()
  await assert.rejects(pending, /update-cancelled/)
  assert.equal(instance.getStatus().state, 'up-to-date')

  const leaking = service({ discoverRelease: async () => { throw new Error('update-token-supersecret') } }).instance
  await assert.rejects(leaking.check(), (error) => error.message === 'update-check-failed')
  assert.equal(leaking.getStatus().errorCode, 'update-check-failed')
})

test('linked update fetch aborts for either service cancellation or the downloader timeout signal', async () => {
  for (const source of ['service', 'downloader']) {
    const serviceController = new AbortController()
    const downloaderController = new AbortController()
    let observed
    const fetchImpl = async (_url, { signal }) => {
      observed = signal
      if (signal.aborted) throw signal.reason
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const pending = createLinkedUpdateFetch(fetchImpl, serviceController.signal)('https://example.test', {
      signal: downloaderController.signal,
    })
    const expected = new Error(`${source}-abort`)
    if (source === 'service') serviceController.abort(expected)
    else downloaderController.abort(expected)
    await assert.rejects(pending, (error) => error === expected)
    assert.equal(observed.aborted, true)
  }
})

test('default download/stage uses the exact versionDir contract and cleans only operation-owned paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-default-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataRoot = join(root, 'data')
  const appRoot = join(root, 'app')
  const updateDir = join(dataRoot, 'updates')
  const versionsDir = join(appRoot, 'versions')
  await mkdir(updateDir, { recursive: true })
  await mkdir(versionsDir, { recursive: true })
  const versionDir = join(versionsDir, manifest.version)

  const result = await createDefaultDownloadAndStage({
    config: { github: { owner: 'Austin-C1', repository: 'hg-' } },
    manifest,
    dataRoot,
    appRoot,
    updateDir,
    versionsDir,
    fetchImpl: async () => assert.fail('injected downloader owns network'),
    signal: new AbortController().signal,
    onProgress: () => {},
    downloadImpl: async ({ destinationPath }) => {
      await mkdir(join(updateDir, 'downloads'), { recursive: true })
      await writeFile(destinationPath, 'owned-download')
      return {
        path: destinationPath,
        size: manifest.assetSize,
        sha256: manifest.assetSha256,
        publishedIdentity: await identityAt(destinationPath),
      }
    },
    stageImpl: async () => {
      await mkdir(versionDir)
      return { versionDir, fileCount: 1, totalSize: 1, publishedIdentity: await identityAt(versionDir) }
    },
  })
  assert.equal(result.versionDir, versionDir)
  assert.equal(Object.hasOwn(result, 'versionRoot'), false)
  await result.cleanup()
  await assert.rejects(access(versionDir), { code: 'ENOENT' })
  await assert.rejects(access(join(updateDir, 'downloads', manifest.assetName)), { code: 'ENOENT' })
})

test('cancel after staged publish cleans ownership and retry succeeds', async () => {
  let attempt = 0
  let cleanupCount = 0
  let preflightStarted
  const barrier = new Promise((resolve) => { preflightStarted = resolve })
  const { instance } = service({
    downloadAndStage: async () => {
      attempt += 1
      return { versionDir: `D:\\CrownMonitor\\versions\\0.2.0-${attempt}`, cleanup: async () => { cleanupCount += 1 } }
    },
    runPreflight: async ({ signal }) => {
      if (attempt === 1) {
        preflightStarted()
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      return { ready: true }
    },
  })
  await instance.check()
  const first = instance.install({ expectedVersion: '0.2.0' })
  await barrier
  await instance.cancel()
  await assert.rejects(first, /update-cancelled/)
  assert.equal(cleanupCount, 1)
  assert.equal(instance.getStatus().state, 'available')
  assert.equal((await instance.install({ expectedVersion: '0.2.0' })).state, 'applying')
})

test('failure after stage cleans ownership, preserves checked release, and retry succeeds', async () => {
  let attempt = 0
  let cleanupCount = 0
  const { instance } = service({
    downloadAndStage: async () => ({
      versionDir: `D:\\CrownMonitor\\versions\\0.2.0-${++attempt}`,
      cleanup: async () => { cleanupCount += 1 },
    }),
    runPreflight: async () => {
      if (attempt === 1) throw new Error('preflight failed with local details')
      return { ready: true }
    },
  })
  await instance.check()
  await assert.rejects(instance.install({ expectedVersion: '0.2.0' }), /update-install-failed/)
  assert.equal(cleanupCount, 1)
  assert.equal(instance.getStatus().state, 'available')
  assert.equal((await instance.install({ expectedVersion: '0.2.0' })).state, 'applying')
})

test('default cleanup never deletes a pre-existing version destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-preexisting-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataRoot = join(root, 'data')
  const appRoot = join(root, 'app')
  const updateDir = join(dataRoot, 'updates')
  const versionsDir = join(appRoot, 'versions')
  const versionDir = join(versionsDir, manifest.version)
  await mkdir(join(updateDir, 'downloads'), { recursive: true })
  await mkdir(versionDir, { recursive: true })
  await writeFile(join(versionDir, 'keep.txt'), 'pre-existing')

  await assert.rejects(createDefaultDownloadAndStage({
    config: { github: { owner: 'Austin-C1', repository: 'hg-' } }, manifest,
    dataRoot, appRoot, updateDir, versionsDir,
    fetchImpl: async () => assert.fail('unused'), signal: new AbortController().signal, onProgress: () => {},
    downloadImpl: async ({ destinationPath }) => {
      await writeFile(destinationPath, 'owned')
      return { path: destinationPath, publishedIdentity: await identityAt(destinationPath) }
    },
    stageImpl: async () => { throw new Error('update-version-destination-exists') },
  }), /update-version-destination-exists/)
  assert.equal(await access(join(versionDir, 'keep.txt')).then(() => true), true)
  await assert.rejects(access(join(updateDir, 'downloads', manifest.assetName)), { code: 'ENOENT' })
})

test('cleanup failure stays retryable and the next install retries ownership cleanup first', async () => {
  let cleanupAttempts = 0
  let stageAttempts = 0
  const { instance } = service({
    downloadAndStage: async () => ({
      versionDir: `D:\\CrownMonitor\\versions\\0.2.0-${++stageAttempts}`,
      cleanup: async () => {
        cleanupAttempts += 1
        if (cleanupAttempts === 1) throw new Error('transient cleanup failure')
      },
    }),
    runPreflight: async () => { if (stageAttempts === 1) throw new Error('preflight failure') },
  })
  await instance.check()
  await assert.rejects(instance.install({ expectedVersion: '0.2.0' }), /update-cleanup-failed/)
  assert.deepEqual(instance.getStatus(), {
    state: 'available', currentVersion: '0.1.0', availableVersion: '0.2.0', progress: 0,
    errorCode: 'update-cleanup-failed', cancellable: false,
    releaseNotes: `<script>${'x'.repeat(16_376)}`,
  })
  assert.equal((await instance.install({ expectedVersion: '0.2.0' })).state, 'applying')
  assert.equal(cleanupAttempts, 2)
  assert.equal(stageAttempts, 2)
})

test('default-stage retains owned cleanup across remove and parent-sync failures', async (t) => {
  for (const failurePoint of ['remove', 'sync-parent']) {
    await t.test(failurePoint, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `crown-update-cleanup-${failurePoint}-`))
      t.after(() => rm(root, { recursive: true, force: true }))
      const dataRoot = join(root, 'data')
      const appRoot = join(root, 'app')
      const updateDir = join(dataRoot, 'updates')
      const versionsDir = join(appRoot, 'versions')
      const versionDir = join(versionsDir, manifest.version)
      await mkdir(join(updateDir, 'downloads'), { recursive: true })
      await mkdir(versionsDir, { recursive: true })

      let cleanupMaySucceed = false
      let stageAttempts = 0
      let successfulVersionRemovals = 0
      const downloadAndStage = (context) => createDefaultDownloadAndStage({
        ...context,
        config: { github: { owner: 'Austin-C1', repository: 'hg-' } },
        currentVersion: '0.1.0',
        dataRoot,
        appRoot,
        updateDir,
        versionsDir,
        fetchImpl: async () => assert.fail('injected downloader owns network'),
        downloadImpl: async ({ destinationPath }) => {
          await writeFile(destinationPath, `download-${stageAttempts + 1}`)
          return {
            path: destinationPath,
            size: manifest.assetSize,
            sha256: manifest.assetSha256,
            publishedIdentity: await identityAt(destinationPath),
          }
        },
        stageImpl: async () => {
          stageAttempts += 1
          await mkdir(versionDir)
          await writeFile(join(versionDir, 'candidate.txt'), String(stageAttempts))
          return { versionDir, fileCount: 1, totalSize: 1, publishedIdentity: await identityAt(versionDir) }
        },
        removeImpl: async (path, options) => {
          if (failurePoint === 'remove' && !cleanupMaySucceed) throw new Error('transient remove failure')
          await rm(path, options)
          if (options.recursive) successfulVersionRemovals += 1
        },
        syncDirectoryImpl: async () => {
          if (failurePoint === 'sync-parent' && !cleanupMaySucceed) throw new Error('transient sync failure')
        },
      })
      const { instance } = service({ downloadAndStage })
      await instance.check()
      await assert.rejects(instance.install({ expectedVersion: '0.2.0' }), /update-cleanup-failed/)
      assert.equal(instance.getStatus().errorCode, 'update-cleanup-failed')

      cleanupMaySucceed = true
      assert.equal((await instance.install({ expectedVersion: '0.2.0' })).state, 'applying')
      assert.equal(stageAttempts, 2)
      assert.equal(successfulVersionRemovals, 1)
      assert.equal(await access(join(versionDir, 'candidate.txt')).then(() => true), true)
    })
  }
})

test('owned cleanup quarantines and preserves replacements across producer and rename races', async (t) => {
  for (const racePoint of ['after-producer', 'during-quarantine-rename']) {
    await t.test(racePoint, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `crown-update-ownership-${racePoint}-`))
      t.after(() => rm(root, { recursive: true, force: true }))
      const dataRoot = join(root, 'data')
      const appRoot = join(root, 'app')
      const updateDir = join(dataRoot, 'updates')
      const downloadsDir = join(updateDir, 'downloads')
      const versionsDir = join(appRoot, 'versions')
      const versionDir = join(versionsDir, manifest.version)
      const zipPath = join(downloadsDir, manifest.assetName)
      const ownedAway = join(downloadsDir, 'owned-away.zip')
      await mkdir(downloadsDir, { recursive: true })
      await mkdir(versionsDir, { recursive: true })

      let renameRaceArmed = racePoint === 'during-quarantine-rename'
      await assert.rejects(createDefaultDownloadAndStage({
        config: { github: { owner: 'Austin-C1', repository: 'hg-' } },
        manifest,
        currentVersion: '0.1.0',
        dataRoot,
        appRoot,
        updateDir,
        versionsDir,
        fetchImpl: async () => assert.fail('injected downloader owns network'),
        signal: new AbortController().signal,
        onProgress: () => {},
        downloadImpl: async ({ destinationPath }) => {
          await writeFile(destinationPath, 'OWNED')
          const publishedIdentity = await identityAt(destinationPath)
          if (racePoint === 'after-producer') {
            await rename(destinationPath, ownedAway)
            await writeFile(destinationPath, 'REPLACEMENT')
          }
          return { path: destinationPath, publishedIdentity }
        },
        stageImpl: async () => {
          await mkdir(versionDir)
          await writeFile(join(versionDir, 'candidate.txt'), 'candidate')
          return { versionDir, publishedIdentity: await identityAt(versionDir) }
        },
        renameImpl: async (source, destination) => {
          if (renameRaceArmed && source === zipPath) {
            renameRaceArmed = false
            await rename(source, ownedAway)
            await writeFile(source, 'REPLACEMENT')
          }
          await rename(source, destination)
        },
        removeImpl: async (path, options) => {
          if (!options.recursive) {
            assert.notEqual(await readFile(path, 'utf8'), 'REPLACEMENT', 'replacement must never be deleted')
          }
          await rm(path, options)
        },
        syncDirectoryImpl: async () => {},
      }), racePoint === 'after-producer' ? /update-download-result-invalid/ : /update-cleanup-failed/)

      const remaining = await readdir(downloadsDir)
      assert.equal(remaining.includes('owned-away.zip'), true)
      const contents = await Promise.all(remaining.map((name) => readFile(join(downloadsDir, name), 'utf8')))
      assert.equal(contents.includes('REPLACEMENT'), true)
      assert.equal(
        await access(zipPath).then(() => true).catch(() => false),
        racePoint === 'after-producer',
      )
      assert.deepEqual(await readdir(versionsDir), [])
    })
  }
})

test('default stage refuses a version directory replaced before producer return', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-stage-replaced-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataRoot = join(root, 'data')
  const appRoot = join(root, 'app')
  const updateDir = join(dataRoot, 'updates')
  const versionsDir = join(appRoot, 'versions')
  const versionDir = join(versionsDir, manifest.version)
  const ownedAway = join(versionsDir, `${manifest.version}-owned`)
  await mkdir(join(updateDir, 'downloads'), { recursive: true })
  await mkdir(versionsDir, { recursive: true })

  await assert.rejects(createDefaultDownloadAndStage({
    config: { github: { owner: 'Austin-C1', repository: 'hg-' } },
    manifest,
    currentVersion: '0.1.0',
    dataRoot,
    appRoot,
    updateDir,
    versionsDir,
    fetchImpl: async () => assert.fail('injected downloader owns network'),
    signal: new AbortController().signal,
    onProgress: () => {},
    downloadImpl: async ({ destinationPath }) => {
      await writeFile(destinationPath, 'owned-download')
      return { path: destinationPath, publishedIdentity: await identityAt(destinationPath) }
    },
    stageImpl: async () => {
      await mkdir(versionDir)
      await writeFile(join(versionDir, 'candidate.txt'), 'OWNED')
      const publishedIdentity = await identityAt(versionDir)
      await rename(versionDir, ownedAway)
      await mkdir(versionDir)
      await writeFile(join(versionDir, 'candidate.txt'), 'REPLACEMENT')
      return { versionDir, publishedIdentity }
    },
  }), /update-stage-result-invalid/)

  assert.equal(await readFile(join(versionDir, 'candidate.txt'), 'utf8'), 'REPLACEMENT')
  assert.equal(await readFile(join(ownedAway, 'candidate.txt'), 'utf8'), 'OWNED')
})

test('bootstrap launch failure cleans staged ownership and remains retryable', async () => {
  let cleanupCount = 0
  let launchAttempts = 0
  const { instance } = service({
    downloadAndStage: async () => ({
      versionDir: 'D:\\CrownMonitor\\versions\\0.2.0',
      publishedIdentity: { dev: 1n, ino: 2n },
      cleanup: async () => { cleanupCount += 1 },
    }),
    launchApplier: async () => {
      launchAttempts += 1
      if (launchAttempts === 1) throw new Error('spawn failed with local details')
    },
  })
  await instance.check()
  await assert.rejects(instance.install({ expectedVersion: '0.2.0' }), /update-apply-launch-failed/)
  assert.equal(cleanupCount, 1)
  assert.deepEqual(instance.getStatus(), {
    state: 'available', currentVersion: '0.1.0', availableVersion: '0.2.0', progress: 0,
    errorCode: 'update-apply-launch-failed', cancellable: false,
    releaseNotes: `<script>${'x'.repeat(16_376)}`,
  })
  assert.equal((await instance.install({ expectedVersion: '0.2.0' })).state, 'applying')
})
