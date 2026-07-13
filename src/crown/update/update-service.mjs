import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { downloadAsset } from './download-asset.mjs'
import { fetchReleaseManifestPair } from './github-release-client.mjs'
import { RELEASE_CONFIG } from './release-config.mjs'
import { stageVerifiedZip } from './safe-extract.mjs'
import { compareSemver } from './semver.mjs'
import { sameFileIdentity, validateDataPath } from './safe-data-path.mjs'
import { syncDirectory } from './atomic-json-file.mjs'
import { runUpdatePreflight } from './update-preflight.mjs'
import { verifyUpdateManifest } from './update-signature.mjs'
import { isUpdateCancellation, stableUpdateError, updateError, UpdateError } from './update-error.mjs'

const STATES = new Set(['idle', 'checking', 'available', 'up-to-date', 'downloading', 'applying', 'error'])
const RETRY_OWNED_CLEANUP = Symbol('retry-owned-cleanup')
const MAX_RELEASE_NOTES_LENGTH = 16_384

function requireFunction(value, code) {
  if (typeof value !== 'function') throw updateError(code)
  return value
}

function requireVersion(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw updateError(code)
  return value
}

function publicStatus(status) {
  return Object.freeze({
    state: status.state,
    currentVersion: status.currentVersion,
    availableVersion: status.availableVersion,
    progress: status.progress,
    errorCode: status.errorCode,
    cancellable: status.cancellable,
    releaseNotes: status.releaseNotes,
  })
}

export function createLinkedUpdateFetch(fetchImpl, signal) {
  return (url, options = {}) => {
    const sources = [signal, options.signal].filter((candidate) => candidate instanceof AbortSignal)
    const alreadyAborted = sources.find((candidate) => candidate.aborted)
    if (alreadyAborted) return Promise.reject(alreadyAborted.reason)
    const controller = new AbortController()
    const bindings = sources.map((source) => {
      const abort = () => controller.abort(source.reason)
      source.addEventListener('abort', abort, { once: true })
      return { source, abort }
    })
    return Promise.resolve()
      .then(() => fetchImpl(url, { ...options, signal: controller.signal }))
      .finally(() => {
        for (const binding of bindings) binding.source.removeEventListener('abort', binding.abort)
      })
  }
}

function releaseApiUrl(config) {
  return `${config.github.apiUrl}/latest`
}

function assetDownloadUrl(config, manifest) {
  const owner = encodeURIComponent(config.github.owner)
  const repository = encodeURIComponent(config.github.repository)
  return `https://github.com/${owner}/${repository}/releases/download/${encodeURIComponent(manifest.releaseTag)}/${encodeURIComponent(manifest.assetName)}`
}

function defaultDiscoverRelease({ config, fetchImpl, signal }) {
  return fetchReleaseManifestPair({
    releaseApiUrl: releaseApiUrl(config),
    manifestAssetName: 'update-manifest.json',
    signatureAssetName: 'update-manifest.sig',
    fetchImpl: createLinkedUpdateFetch(fetchImpl, signal),
  })
}

async function captureOwnedPath({
  root,
  path,
  directory,
  code,
  expectedIdentity,
  renameImpl = rename,
  removeImpl = rm,
  syncDirectoryImpl = syncDirectory,
}) {
  if (!expectedIdentity || !['bigint', 'number'].includes(typeof expectedIdentity.dev)
    || !['bigint', 'number'].includes(typeof expectedIdentity.ino)) {
    throw updateError(code)
  }
  let target
  try {
    target = await validateDataPath({
      dataRoot: root,
      targetPath: path,
      requireExists: true,
      expectDirectory: directory,
    })
  } catch {
    throw updateError(code)
  }
  if (!sameFileIdentity(expectedIdentity, target.identity)) throw updateError(code)
  const quarantinePath = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.cleanup`)
  try {
    const quarantine = await validateDataPath({ dataRoot: target.dataRoot, targetPath: quarantinePath })
    if (quarantine.exists) throw new Error('quarantine exists')
  } catch {
    throw updateError(code)
  }
  let phase = 'quarantine'
  return async () => {
    if (phase === 'done') return
    if (phase === 'ownership-lost') throw updateError('update-cleanup-ownership-lost')
    try {
      if (phase === 'quarantine') {
        try {
          await validateDataPath({
            dataRoot: target.dataRoot,
            targetPath: target.path,
            requireExists: true,
            expectDirectory: directory,
          })
        } catch {
          throw updateError('update-cleanup-ownership-lost')
        }
        await renameImpl(target.path, quarantinePath)
        phase = 'verify-quarantine'
      }
      if (phase === 'verify-quarantine') {
        let quarantined
        try {
          quarantined = await validateDataPath({
            dataRoot: target.dataRoot,
            targetPath: quarantinePath,
            requireExists: true,
            expectDirectory: directory,
          })
        } catch {
          phase = 'ownership-lost'
          throw updateError('update-cleanup-ownership-lost')
        }
        if (!sameFileIdentity(expectedIdentity, quarantined.identity)) {
          phase = 'ownership-lost'
          throw updateError('update-cleanup-ownership-lost')
        }
        phase = 'remove-quarantine'
      }
      if (phase === 'remove-quarantine') {
        let quarantined
        try {
          quarantined = await validateDataPath({
            dataRoot: target.dataRoot,
            targetPath: quarantinePath,
            requireExists: true,
            expectDirectory: directory,
          })
        } catch {
          phase = 'ownership-lost'
          throw updateError('update-cleanup-ownership-lost')
        }
        if (!sameFileIdentity(expectedIdentity, quarantined.identity)) {
          phase = 'ownership-lost'
          throw updateError('update-cleanup-ownership-lost')
        }
        await removeImpl(quarantinePath, { recursive: directory, force: false })
        phase = 'verify-absent'
      }
      if (phase === 'verify-absent') {
        const after = await validateDataPath({ dataRoot: target.dataRoot, targetPath: quarantinePath })
        if (after.exists) throw updateError('update-cleanup-ownership-lost')
        phase = 'sync-parent'
      }
      if (phase === 'sync-parent') {
        await syncDirectoryImpl({ dataRoot: target.dataRoot, directoryPath: dirname(target.path) })
        phase = 'done'
      }
    } catch (error) {
      if (error instanceof UpdateError) throw error
      throw updateError('update-cleanup-failed', error)
    }
  }
}

async function ensureAbsent({ root, path, code }) {
  let target
  try { target = await validateDataPath({ dataRoot: root, targetPath: path }) } catch {
    throw updateError('update-cleanup-path-invalid')
  }
  if (target.exists) throw updateError(code)
}

export async function createDefaultDownloadAndStage({
  config,
  manifest,
  currentVersion,
  dataRoot,
  appRoot,
  updateDir,
  versionsDir,
  fetchImpl,
  signal,
  onProgress,
  downloadImpl = downloadAsset,
  stageImpl = stageVerifiedZip,
  renameImpl = rename,
  removeImpl = rm,
  syncDirectoryImpl = syncDirectory,
}) {
  if (signal.aborted) throw signal.reason
  const zipPath = join(updateDir, 'downloads', manifest.assetName)
  const expectedVersionDir = join(versionsDir, manifest.version)
  if (currentVersion !== undefined && manifest.version === currentVersion) throw updateError('update-cleanup-current-version-forbidden')
  await ensureAbsent({ root: dataRoot, path: zipPath, code: 'update-asset-destination-exists' })
  await ensureAbsent({ root: appRoot, path: expectedVersionDir, code: 'update-version-destination-exists' })
  let cleanupDownload = null
  let cleanupVersion = null
  try {
    const downloaded = await downloadImpl({
      url: assetDownloadUrl(config, manifest),
      destinationPath: zipPath,
      expectedSize: manifest.assetSize,
      expectedSha256: manifest.assetSha256,
      maxBytes: manifest.assetSize,
      fetchImpl: createLinkedUpdateFetch(fetchImpl, signal),
    })
    if (!downloaded || downloaded.path !== zipPath) throw updateError('update-download-result-invalid')
    cleanupDownload = await captureOwnedPath({
      root: dataRoot,
      path: zipPath,
      directory: false,
      code: 'update-download-result-invalid',
      expectedIdentity: downloaded.publishedIdentity,
      renameImpl,
      removeImpl,
      syncDirectoryImpl,
    })
    if (signal.aborted) throw signal.reason
    onProgress(70)
    const staged = await stageImpl({ zipPath, versionsDir, version: manifest.version, files: manifest.files })
    if (!staged || staged.versionDir !== expectedVersionDir) throw updateError('update-stage-result-invalid')
    cleanupVersion = await captureOwnedPath({
      root: appRoot,
      path: staged.versionDir,
      directory: true,
      code: 'update-stage-result-invalid',
      expectedIdentity: staged.publishedIdentity,
      renameImpl,
      removeImpl,
      syncDirectoryImpl,
    })
    if (signal.aborted) throw signal.reason
    onProgress(90)
    await cleanupDownload()
    cleanupDownload = null
    return Object.freeze({
      versionDir: staged.versionDir,
      publishedIdentity: Object.freeze({ ...staged.publishedIdentity }),
      cleanup: cleanupVersion,
    })
  } catch (error) {
    const retryCleanup = async () => {
      let cleanupFailure = null
      for (const cleanup of [cleanupVersion, cleanupDownload]) {
        if (!cleanup) continue
        try { await cleanup() } catch (current) { cleanupFailure ??= current }
      }
      if (cleanupFailure) throw updateError('update-cleanup-failed', cleanupFailure)
    }
    try {
      await retryCleanup()
    } catch (cleanupFailure) {
      const failure = updateError('update-cleanup-failed', cleanupFailure)
      Object.defineProperty(failure, RETRY_OWNED_CLEANUP, { value: retryCleanup })
      throw failure
    }
    throw error
  }
}

export function createUpdateService(options = {}) {
  const config = options.config ?? RELEASE_CONFIG
  const currentVersion = requireVersion(options.currentVersion, 'update-current-version-invalid')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const discoverRelease = options.discoverRelease
    ?? ((context) => defaultDiscoverRelease({ ...context, config, fetchImpl }))
  const verifyManifest = options.verifyManifest
    ?? ((pair) => verifyUpdateManifest({
      ...pair,
      trustedKeys: config.trustedKeys,
      expectedAppId: config.appId,
      expectedChannel: config.channel,
      expectedPackageType: config.packageType,
      // Signature authenticity is checked even for an equal/older latest release;
      // service comparison below decides whether it is actually available.
      currentVersion: '0.0.0-0',
      updaterVersion: config.updaterVersion,
    }))
  const downloadAndStage = options.downloadAndStage
    ?? ((context) => createDefaultDownloadAndStage({
      ...context,
      config,
      fetchImpl,
      currentVersion,
      dataRoot: options.dataRoot,
      appRoot: options.appRoot,
      updateDir: options.updateDir,
      versionsDir: options.versionsDir,
    }))
  const preflight = options.runPreflight
    ?? (() => runUpdatePreflight({
      dataRoot: options.dataRoot,
      dbPath: options.dbPath,
      diskPath: options.updateDir,
      requiredBytes: verifiedManifest.assetSize * 3,
      capabilities: options.capabilities,
      monitorController: options.monitorController,
      bettingController: options.bettingController,
    }))
  const launchApplier = requireFunction(options.launchApplier, 'update-applier-launcher-required')
  requireFunction(discoverRelease, 'update-discovery-invalid')
  requireFunction(verifyManifest, 'update-verifier-invalid')
  requireFunction(downloadAndStage, 'update-downloader-invalid')
  requireFunction(preflight, 'update-preflight-invalid')

  let status = {
    state: 'idle', currentVersion, availableVersion: '', progress: 0, errorCode: '', cancellable: false, releaseNotes: '',
  }
  let active = null
  let verifiedManifest = null
  let pendingCleanup = null

  const set = (patch) => {
    status = { ...status, ...patch }
    if (!STATES.has(status.state)) throw updateError('update-state-invalid')
  }

  const begin = (state) => {
    if (active) throw updateError('update-operation-in-progress')
    if (status.state === 'applying') throw updateError('update-apply-in-progress')
    const controller = new AbortController()
    controller.previousStatus = { ...status }
    active = controller
    set({ state, progress: 0, errorCode: '', cancellable: true })
    return controller
  }

  const finish = (controller) => {
    if (active === controller) active = null
  }

  const cancelled = (controller) => controller.signal.aborted || isUpdateCancellation(controller.signal.reason)

  return Object.freeze({
    getStatus() { return publicStatus(status) },

    async check() {
      const controller = begin('checking')
      try {
        const pair = await discoverRelease({ signal: controller.signal })
        if (cancelled(controller)) throw updateError('update-cancelled')
        const manifest = await verifyManifest({
          manifestBytes: pair?.manifestBytes,
          signatureBytes: pair?.signatureBytes,
        })
        if (!manifest || pair.releaseTag !== manifest.releaseTag) throw updateError('update-release-tag-mismatch')
        if (cancelled(controller)) throw updateError('update-cancelled')
        verifiedManifest = manifest
        const available = compareSemver(manifest.version, currentVersion) > 0
        const releaseNotes = typeof pair.releaseNotes === 'string'
          ? pair.releaseNotes.slice(0, MAX_RELEASE_NOTES_LENGTH)
          : ''
        set({
          state: available ? 'available' : 'up-to-date',
          availableVersion: available ? manifest.version : '',
          progress: 0,
          errorCode: '',
          cancellable: false,
          releaseNotes: available ? releaseNotes : '',
        })
        return publicStatus(status)
      } catch (error) {
        if (cancelled(controller) || isUpdateCancellation(error)) {
          set({ ...controller.previousStatus, cancellable: false })
          throw updateError('update-cancelled')
        }
        const safe = stableUpdateError(error, 'update-check-failed')
        set({ state: 'error', availableVersion: '', progress: 0, errorCode: safe.code, cancellable: false, releaseNotes: '' })
        throw safe
      } finally {
        finish(controller)
      }
    },

    async install({ expectedVersion } = {}) {
      if (active) throw updateError('update-operation-in-progress')
      if (!verifiedManifest || status.state !== 'available') throw updateError('update-release-not-checked')
      if (expectedVersion !== verifiedManifest.version) throw updateError('update-expected-version-mismatch')
      const controller = begin('downloading')
      let staged = null
      let handoffAttempted = false
      try {
        if (pendingCleanup) {
          try {
            await pendingCleanup()
            pendingCleanup = null
          } catch (error) {
            throw updateError('update-cleanup-failed', error)
          }
        }
        staged = await downloadAndStage({
          manifest: verifiedManifest,
          expectedVersion,
          signal: controller.signal,
          onProgress(value) {
            if (Number.isFinite(value) && value >= 0 && value <= 99 && active === controller) {
              set({ progress: Math.trunc(value) })
            }
          },
        })
        if (!staged || typeof staged.versionDir !== 'string' || staged.versionDir.length === 0
          || (staged.cleanup !== undefined && typeof staged.cleanup !== 'function')) {
          throw updateError('update-stage-result-invalid')
        }
        if (cancelled(controller)) throw updateError('update-cancelled')
        await preflight({ manifest: verifiedManifest, staged, signal: controller.signal })
        if (cancelled(controller)) throw updateError('update-cancelled')
        set({ progress: 99, cancellable: false })
        handoffAttempted = true
        await launchApplier({
          expectedVersion,
          manifest: verifiedManifest,
          versionDir: staged.versionDir,
          publishedIdentity: staged.publishedIdentity,
        })
        set({ state: 'applying', progress: 100, cancellable: false })
        return publicStatus(status)
      } catch (error) {
        if (status.state !== 'applying' && typeof error?.[RETRY_OWNED_CLEANUP] === 'function') {
          pendingCleanup = error[RETRY_OWNED_CLEANUP]
          const safe = updateError('update-cleanup-failed', error)
          set({ state: 'available', progress: 0, errorCode: safe.code, cancellable: false })
          throw safe
        }
        if (status.state !== 'applying' && staged?.cleanup) {
          try {
            await staged.cleanup()
          } catch (cleanupError) {
            pendingCleanup = staged.cleanup
            const safe = updateError('update-cleanup-failed', cleanupError)
            set({ state: 'available', progress: 0, errorCode: safe.code, cancellable: false })
            throw safe
          }
        }
        if (cancelled(controller) || isUpdateCancellation(error)) {
          set({ state: 'available', progress: 0, errorCode: '', cancellable: false })
          throw updateError('update-cancelled')
        }
        const safe = stableUpdateError(error, handoffAttempted ? 'update-apply-launch-failed' : 'update-install-failed')
        set({ state: 'available', progress: 0, errorCode: safe.code, cancellable: false })
        throw safe
      } finally {
        finish(controller)
      }
    },

    async cancel() {
      if (!active || !status.cancellable || status.state === 'applying') {
        return { cancelled: false, code: 'update-not-cancellable' }
      }
      active.abort(updateError('update-cancelled'))
      return { cancelled: true, code: 'update-cancelled' }
    },
  })
}
