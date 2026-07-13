import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openAppDatabase } from '../app/app-db.mjs'
import { readOrCreateLocalSecretKey } from '../app/app-secret.mjs'
import {
  DEFAULT_LEAGUES_CONFIG,
  validateDefaultLeagueSeed,
} from '../config/default-leagues.mjs'
import { assertPathWithin } from './portable-paths.mjs'

const DEFAULT_APP_CONFIG_DIR = fileURLToPath(new URL('../../../config/', import.meta.url))
const IDENTITY_FILE = 'installation.json'
const INITIALIZATION_LOCK_FILE = '.portable-initialize.lock'
const INSTALLATION_ID = /^[A-Za-z0-9_-]{8,128}$/
const LOCK_NONCE = /^[A-Za-z0-9_-]{8,128}$/
const DEFAULT_LOCK_OPTIONS = Object.freeze({
  waitTimeoutMs: 30_000,
  pollIntervalMs: 25,
  staleAfterMs: 120_000,
})

function portableInstanceError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function validatedDataRoot(dataRoot) {
  try {
    return assertPathWithin(dataRoot, dataRoot, 'dataRoot')
  } catch (error) {
    throw portableInstanceError('portable-data-root-invalid', error)
  }
}

function validatedAppConfigDir(appConfigDir) {
  try {
    return assertPathWithin(appConfigDir, appConfigDir, 'appConfigDir')
  } catch (error) {
    throw portableInstanceError('portable-app-config-dir-invalid', error)
  }
}

function pathSegments(target) {
  const normalized = path.win32.normalize(target)
  const parsed = path.win32.parse(normalized)
  const segments = [parsed.root]
  let current = parsed.root
  for (const segment of normalized.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = path.win32.join(current, segment)
    segments.push(current)
  }
  return segments
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function pathSafetyError(scope, kind, field) {
  const prefix = scope === 'data' ? 'portable-data' : scope === 'appConfig' ? 'portable-app-config' : 'portable-seed'
  return portableInstanceError(`${prefix}-${kind}-forbidden${field ? `:${field}` : ''}`)
}

function inspectNormalPath(target, { scope, field = '', type, mustExist = false }) {
  const segments = pathSegments(target)
  let finalStats = null
  for (let index = 0; index < segments.length; index += 1) {
    const stats = lstatOrNull(segments[index])
    if (!stats) {
      if (mustExist) throw pathSafetyError(scope, 'missing', field)
      return null
    }
    if (stats.isSymbolicLink()) throw pathSafetyError(scope, 'reparse', field)
    const isFinal = index === segments.length - 1
    if (!isFinal && !stats.isDirectory()) throw pathSafetyError(scope, 'type', field)
    if (isFinal) finalStats = stats
  }
  if (type === 'directory' && !finalStats?.isDirectory()) throw pathSafetyError(scope, 'type', field)
  if (type === 'file' && !finalStats?.isFile()) throw pathSafetyError(scope, 'type', field)
  return finalStats
}

function ensureNormalDirectory(target, { scope = 'data', field = '' } = {}) {
  inspectNormalPath(target, { scope, field, type: 'directory' })
  fs.mkdirSync(target, { recursive: true })
  inspectNormalPath(target, { scope, field, type: 'directory', mustExist: true })
  return target
}

function assertNormalDataFile(dataRoot, file, field) {
  assertPathWithin(dataRoot, file, field)
  return inspectNormalPath(file, { scope: 'data', field, type: 'file' })
}

function installationIdentityPath(dataRoot) {
  return path.join(validatedDataRoot(dataRoot), IDENTITY_FILE)
}

function parseInstallationIdentity(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw portableInstanceError('portable-installation-identity-invalid', error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'installationId,schemaVersion'
    || parsed.schemaVersion !== 1
    || typeof parsed.installationId !== 'string'
    || !INSTALLATION_ID.test(parsed.installationId)) {
    throw portableInstanceError('portable-installation-identity-invalid')
  }
  return parsed.installationId
}

export function readInstallationId(dataRoot) {
  const file = installationIdentityPath(dataRoot)
  assertNormalDataFile(dataRoot, file, 'installationIdentity')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw portableInstanceError('portable-installation-identity-missing')
    throw portableInstanceError('portable-installation-identity-unavailable', error)
  }
  return parseInstallationIdentity(text)
}

function readBundledSeed(appConfigDir) {
  inspectNormalPath(appConfigDir, { scope: 'appConfig', type: 'directory', mustExist: true })
  const sourceFile = path.join(appConfigDir, 'default-leagues.json')
  const seedStats = inspectNormalPath(sourceFile, { scope: 'seed', type: 'file' })
  if (!seedStats) return validateDefaultLeagueSeed(DEFAULT_LEAGUES_CONFIG)
  try {
    return validateDefaultLeagueSeed(JSON.parse(fs.readFileSync(sourceFile, 'utf8')))
  } catch (error) {
    if (error?.code === 'default-league-seed-unsafe') throw error
    throw portableInstanceError('default-league-seed-unsafe', error)
  }
}

function createInstallationIdentity(dataRoot, randomId) {
  const file = installationIdentityPath(dataRoot)
  if (assertNormalDataFile(dataRoot, file, 'installationIdentity')) {
    return { installationId: readInstallationId(dataRoot), status: 'existing' }
  }
  const installationId = randomId()
  if (typeof installationId !== 'string' || !INSTALLATION_ID.test(installationId)) {
    throw portableInstanceError('portable-installation-id-invalid')
  }
  const contents = `${JSON.stringify({ schemaVersion: 1, installationId }, null, 2)}\n`
  try {
    fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx' })
    return { installationId, status: 'created' }
  } catch (error) {
    if (error?.code === 'EEXIST') return { installationId: readInstallationId(dataRoot), status: 'existing' }
    throw portableInstanceError('portable-installation-identity-unavailable', error)
  }
}

function seedDefaultLeagues({ dataRoot, config }) {
  const target = assertPathWithin(dataRoot, path.join(dataRoot, 'config', 'default-leagues.json'), 'defaultLeaguesPath')
  ensureNormalDirectory(path.dirname(target), { field: 'config' })
  assertNormalDataFile(dataRoot, target, 'defaultLeaguesPath')
  try {
    fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return 'created'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'existing'
    throw portableInstanceError('default-league-seed-unavailable', error)
  }
}

function normalizedLockOptions(options = {}) {
  const result = { ...DEFAULT_LOCK_OPTIONS }
  for (const field of Object.keys(result)) {
    if (options[field] === undefined) continue
    const value = Number(options[field])
    if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) {
      throw portableInstanceError(`portable-initialization-lock-option-invalid:${field}`)
    }
    result[field] = value
  }
  return result
}

function parseLockRecord(text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'createdAt,nonce,pid,schemaVersion'
    || record.schemaVersion !== 1
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || typeof record.createdAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
    || new Date(record.createdAt).toISOString() !== record.createdAt
    || typeof record.nonce !== 'string' || !LOCK_NONCE.test(record.nonce)) return null
  return record
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function processState(pid) {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

function writeCompleteLockCandidate(dataRoot, record) {
  const temp = assertPathWithin(
    dataRoot,
    path.join(dataRoot, `.portable-initialize.${record.pid}.${record.nonce}.tmp`),
    'initializationLockTemp',
  )
  let handle
  try {
    handle = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(handle, `${JSON.stringify(record)}\n`, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
  return temp
}

function tryAcquireInitializationLock(dataRoot, record) {
  const lockPath = assertPathWithin(dataRoot, path.join(dataRoot, INITIALIZATION_LOCK_FILE), 'initializationLock')
  assertNormalDataFile(dataRoot, lockPath, 'initializationLock')
  const candidate = writeCompleteLockCandidate(dataRoot, record)
  try {
    fs.linkSync(candidate, lockPath)
    return { acquired: true, lockPath }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw portableInstanceError('portable-initialization-lock-unavailable', error)
    return { acquired: false, lockPath }
  } finally {
    try {
      fs.unlinkSync(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw portableInstanceError('portable-initialization-lock-unavailable', error)
    }
  }
}

function readLockSnapshot(dataRoot, lockPath) {
  const stats = assertNormalDataFile(dataRoot, lockPath, 'initializationLock')
  if (!stats) return null
  let text
  try {
    text = fs.readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw portableInstanceError('portable-initialization-lock-unavailable', error)
  }
  return { stats, text, record: parseLockRecord(text) }
}

function removeDeadLock(dataRoot, lockPath, snapshot) {
  const current = readLockSnapshot(dataRoot, lockPath)
  if (!current || current.text !== snapshot.text
    || current.stats.dev !== snapshot.stats.dev || current.stats.ino !== snapshot.stats.ino) return false
  if (processState(snapshot.record.pid) !== 'dead') return false
  try {
    fs.unlinkSync(lockPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw portableInstanceError('portable-initialization-lock-unavailable', error)
  }
}

function acquireInitializationLock(dataRoot, options) {
  const settings = normalizedLockOptions(options)
  const startedAt = Date.now()
  const nonce = crypto.randomBytes(18).toString('base64url')
  const record = { schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString(), nonce }

  while (true) {
    const attempt = tryAcquireInitializationLock(dataRoot, record)
    if (attempt.acquired) {
      return () => {
        const current = readLockSnapshot(dataRoot, attempt.lockPath)
        if (!current || current.record?.nonce !== nonce || current.record.pid !== process.pid) {
          throw portableInstanceError('portable-initialization-lock-lost')
        }
        fs.unlinkSync(attempt.lockPath)
      }
    }

    const snapshot = readLockSnapshot(dataRoot, attempt.lockPath)
    if (!snapshot) continue
    const elapsed = Date.now() - startedAt
    const lockAge = snapshot.record
      ? Date.now() - Date.parse(snapshot.record.createdAt)
      : Date.now() - snapshot.stats.mtimeMs
    if (!snapshot.record && lockAge >= settings.staleAfterMs) {
      throw portableInstanceError('portable-initialization-lock-unverifiable')
    }
    if (snapshot.record && lockAge >= settings.staleAfterMs) {
      const ownerState = processState(snapshot.record.pid)
      if (ownerState === 'unknown') throw portableInstanceError('portable-initialization-lock-unverifiable')
      if (ownerState === 'dead' && removeDeadLock(dataRoot, attempt.lockPath, snapshot)) continue
    }
    if (elapsed >= settings.waitTimeoutMs) throw portableInstanceError('portable-initialization-lock-timeout')
    sleepSync(Math.min(settings.pollIntervalMs, settings.waitTimeoutMs - elapsed))
  }
}

export function initializePortableData({
  appConfigDir = DEFAULT_APP_CONFIG_DIR,
  dataRoot,
  randomId = () => crypto.randomBytes(24).toString('base64url'),
  lockOptions,
} = {}) {
  const root = validatedDataRoot(dataRoot)
  const seed = readBundledSeed(validatedAppConfigDir(appConfigDir))
  ensureNormalDirectory(root, { field: 'dataRoot' })
  const releaseLock = acquireInitializationLock(root, lockOptions)
  try {
    inspectNormalPath(root, { scope: 'data', field: 'dataRoot', type: 'directory', mustExist: true })
    if (assertNormalDataFile(root, installationIdentityPath(root), 'installationIdentity')) readInstallationId(root)

    const identity = createInstallationIdentity(root, randomId)
    const defaultLeagues = seedDefaultLeagues({ dataRoot: root, config: seed })
    const storageDir = assertPathWithin(root, path.join(root, 'storage'), 'storageDir')
    ensureNormalDirectory(storageDir, { field: 'storage' })
    const secretKeyPath = assertPathWithin(root, path.join(storageDir, 'crown-local-secret.key'), 'secretKeyPath')
    const dbPath = assertPathWithin(root, path.join(storageDir, 'crown.sqlite'), 'dbPath')
    const keyExisted = Boolean(assertNormalDataFile(root, secretKeyPath, 'secretKeyPath'))
    const dbExisted = Boolean(assertNormalDataFile(root, dbPath, 'dbPath'))
    const env = {
      CROWN_PORTABLE: '1',
      CROWN_DATA_ROOT: root,
      CROWN_DB_PATH: dbPath,
      CROWN_LOCAL_SECRET_KEY_PATH: secretKeyPath,
    }

    readOrCreateLocalSecretKey({ env })
    assertNormalDataFile(root, secretKeyPath, 'secretKeyPath')
    openAppDatabase({ dbPath, env, monitorJson: null }).close()
    assertNormalDataFile(root, dbPath, 'dbPath')

    const resources = {
      defaultLeagues,
      installationIdentity: identity.status,
      localSecretKey: keyExisted ? 'existing' : 'created',
      database: dbExisted ? 'existing' : 'created',
    }
    return {
      created: Object.values(resources).some((status) => status === 'created'),
      installationId: identity.installationId,
      leagueCount: seed.leagues.length,
      resources,
    }
  } finally {
    releaseLock()
  }
}
