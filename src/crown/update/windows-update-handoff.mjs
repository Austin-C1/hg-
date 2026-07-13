import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { readAtomicJson, syncDirectory, writeAtomicJson } from './atomic-json-file.mjs'
import { sameFileIdentity, validateDataPath } from './safe-data-path.mjs'
import { parseSemver } from './semver.mjs'
import { updateError } from './update-error.mjs'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATE_FIELDS = Object.freeze([
  'schemaVersion', 'installationId', 'version', 'port', 'pid',
  'processStartTime', 'launchNonce', 'stopToken',
])

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function validIso(value) {
  const millis = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(millis) && new Date(millis).toISOString() === value
}

function normalizeIdentity(value, code) {
  if (!value || !['bigint', 'number'].includes(typeof value.dev)
    || !['bigint', 'number'].includes(typeof value.ino)) throw updateError(code)
  if ((typeof value.dev === 'number' && (!Number.isSafeInteger(value.dev) || value.dev < 0))
    || (typeof value.ino === 'number' && (!Number.isSafeInteger(value.ino) || value.ino < 0))) {
    throw updateError(code)
  }
  let dev
  let ino
  try {
    dev = BigInt(value.dev)
    ino = BigInt(value.ino)
  } catch { throw updateError(code) }
  if (dev < 0n || ino < 0n) throw updateError(code)
  return Object.freeze({ dev, ino })
}

function exactState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== STATE_FIELDS.length
    || STATE_FIELDS.some((field) => !Object.hasOwn(value, field))
    || value.schemaVersion !== 1
    || !ID.test(value.installationId || '')
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !validIso(value.processStartTime)
    || !TOKEN.test(value.launchNonce || '')
    || !TOKEN.test(value.stopToken || '')
    || value.launchNonce === value.stopToken) {
    throw updateError('update-handoff-launcher-state-invalid')
  }
  try { parseSemver(value.version) } catch { throw updateError('update-handoff-launcher-state-invalid') }
  return Object.freeze({ ...value })
}

async function defaultProbeCurrent({ state, probeToken, signal }) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal,
      headers: { accept: 'application/json', 'x-crown-launcher-probe': probeToken },
    })
  } catch { return false }
  if (response.status !== 200) return false
  let text
  try { text = await response.text() } catch { return false }
  if (Buffer.byteLength(text) > 16 * 1024) return false
  let value
  try { value = JSON.parse(text) } catch { return false }
  return value?.ok === true
    && value.app === 'crown-dashboard'
    && value.installationId === state.installationId
    && value.version === state.version
    && value.launchNonce === state.launchNonce
    && value.launcherPid === state.pid
    && value.launcherProcessStartTime === state.processStartTime
    && value.launcherProbe === probeToken
}

async function defaultLaunchBootstrap({ bootstrapPath, requestPath, visible }) {
  if (process.platform !== 'win32' || visible !== true) throw updateError('update-handoff-bootstrap-unavailable')
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', bootstrapPath, '-RequestPath', requestPath,
  ], {
    cwd: dirname(dirname(bootstrapPath)),
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      ComSpec: process.env.ComSpec,
      PATH: process.env.PATH,
    },
  })
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise)
    child.once('error', reject)
  })
  child.unref()
}

function requiredPath(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw updateError(code)
  return resolve(value)
}

async function removeOwnedRequest({ dataRoot, requestPath, expectedIdentity }) {
  const quarantinePath = resolve(dirname(requestPath), `.${basename(requestPath)}.${randomUUID()}.failed`)
  try {
    const before = await validateDataPath({ dataRoot, targetPath: requestPath, requireExists: true, expectDirectory: false })
    if (!sameFileIdentity(before.identity, expectedIdentity)) throw new Error('identity mismatch')
    const quarantine = await validateDataPath({ dataRoot, targetPath: quarantinePath })
    if (quarantine.exists) throw new Error('quarantine exists')
    await rename(requestPath, quarantinePath)
    const moved = await validateDataPath({ dataRoot, targetPath: quarantinePath, requireExists: true, expectDirectory: false })
    if (!sameFileIdentity(moved.identity, expectedIdentity)) throw new Error('identity mismatch')
    await rm(quarantinePath)
    const after = await validateDataPath({ dataRoot, targetPath: quarantinePath })
    if (after.exists) throw new Error('still present')
    await syncDirectory({ dataRoot, directoryPath: dirname(requestPath) })
  } catch (error) {
    throw updateError('update-handoff-request-cleanup-failed', error)
  }
}

export function createWindowsUpdateHandoff(options = {}) {
  const appRoot = requiredPath(options.appRoot, 'update-handoff-app-root-invalid')
  const dataRoot = requiredPath(options.dataRoot, 'update-handoff-data-root-invalid')
  const runtimeDir = requiredPath(options.runtimeDir, 'update-handoff-runtime-root-invalid')
  const updateDir = requiredPath(options.updateDir, 'update-handoff-update-root-invalid')
  const backupDir = requiredPath(options.backupDir, 'update-handoff-backup-root-invalid')
  const dbPath = requiredPath(options.dbPath, 'update-handoff-database-path-invalid')
  const currentPath = requiredPath(options.currentPath, 'update-handoff-current-path-invalid')
  const statePath = requiredPath(options.statePath, 'update-handoff-state-path-invalid')
  const bootstrapPath = requiredPath(options.bootstrapPath, 'update-handoff-bootstrap-path-invalid')
  const installationId = options.installationId
  const currentVersion = options.currentVersion
  const processId = options.processId ?? process.pid
  const processStartTime = options.processStartTime ?? process.env.CROWN_LAUNCHER_PROCESS_START_TIME
  const probeCurrent = options.probeCurrent ?? defaultProbeCurrent
  const launchBootstrap = options.launchBootstrap ?? defaultLaunchBootstrap
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
  const randomId = options.randomId ?? (() => `update-${randomUUID()}`)
  if (!ID.test(installationId || '') || !Number.isSafeInteger(processId) || processId < 1 || !validIso(processStartTime)) {
    throw updateError('update-handoff-runtime-identity-invalid')
  }
  try { parseSemver(currentVersion) } catch { throw updateError('update-handoff-current-version-invalid') }
  if (typeof probeCurrent !== 'function' || typeof launchBootstrap !== 'function'
    || typeof randomToken !== 'function' || typeof randomId !== 'function') {
    throw updateError('update-handoff-runtime-invalid')
  }

  return async function launchWindowsUpdate({ expectedVersion, versionDir, publishedIdentity } = {}) {
    try { parseSemver(expectedVersion) } catch { throw updateError('update-handoff-candidate-version-invalid') }
    const expectedVersionDir = resolve(appRoot, 'versions', expectedVersion)
    if (typeof versionDir !== 'string' || !samePath(versionDir, expectedVersionDir)) {
      throw updateError('update-handoff-version-path-invalid')
    }
    const candidateIdentity = normalizeIdentity(publishedIdentity, 'update-handoff-version-identity-invalid')
    try {
      const candidate = await validateDataPath({ dataRoot: appRoot, targetPath: expectedVersionDir, requireExists: true, expectDirectory: true })
      if (!sameFileIdentity(candidate.identity, candidateIdentity)) throw new Error('identity mismatch')
      await validateDataPath({ dataRoot: appRoot, targetPath: bootstrapPath, requireExists: true, expectDirectory: false })
      await validateDataPath({ dataRoot, targetPath: runtimeDir, requireExists: true, expectDirectory: true })
      await validateDataPath({ dataRoot, targetPath: updateDir, requireExists: true, expectDirectory: true })
      await validateDataPath({ dataRoot, targetPath: backupDir, requireExists: true, expectDirectory: true })
    } catch { throw updateError('update-handoff-path-invalid') }

    let state
    try { state = exactState(await readAtomicJson({ dataRoot, filePath: statePath })) } catch (error) {
      if (error?.code?.startsWith?.('update-')) throw error
      throw updateError('update-handoff-launcher-state-invalid')
    }
    if (state.installationId !== installationId || state.version !== currentVersion
      || state.pid !== processId || state.processStartTime !== processStartTime) {
      throw updateError('update-handoff-launcher-state-mismatch')
    }
    const probeToken = randomToken()
    const updateId = randomId()
    if (!TOKEN.test(probeToken || '') || !ID.test(updateId || '')) throw updateError('update-handoff-random-invalid')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    let verified = false
    try { verified = await probeCurrent({ state, probeToken, signal: controller.signal }) } catch { verified = false } finally { clearTimeout(timer) }
    if (verified !== true) throw updateError('update-handoff-current-process-unverified')

    const requestPath = resolve(updateDir, 'active-request.json')
    const operationDir = resolve(updateDir, 'operations', updateId)
    const request = {
      schemaVersion: 1,
      operation: 'apply',
      installationId,
      updateId,
      previousVersion: currentVersion,
      candidateVersion: expectedVersion,
      expectedVersion,
      dataRoot,
      journalPath: resolve(operationDir, 'journal.json'),
      dbPath,
      backupPath: resolve(backupDir, `${updateId}.sqlite`),
      appRoot,
      currentPath,
      candidateIdentity: { dev: String(candidateIdentity.dev), ino: String(candidateIdentity.ino) },
      oldProcess: {
        pid: state.pid,
        processStartTime: state.processStartTime,
        installationId,
        processInstanceId: state.launchNonce,
        probeToken,
      },
    }
    let requestIdentity
    try { requestIdentity = await writeAtomicJson({ dataRoot, filePath: requestPath, value: request }) } catch {
      throw updateError('update-handoff-request-write-failed')
    }
    try { await launchBootstrap({ bootstrapPath, requestPath, visible: true }) } catch (error) {
      await removeOwnedRequest({ dataRoot, requestPath, expectedIdentity: requestIdentity })
      if (error?.code === 'update-handoff-bootstrap-unavailable') throw error
      throw updateError('update-handoff-bootstrap-failed', error)
    }
    return Object.freeze({ started: true, updateId, requestPath })
  }
}
