import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { readAtomicJson, writeAtomicJson } from './atomic-json-file.mjs'
import { APP_CONTRACT_VERSION } from '../app/app-contract-version.mjs'
import { listCrownCapabilities } from '../betting/crown-capability-matrix.mjs'
import { validateDataPath } from './safe-data-path.mjs'
import { parseSemver } from './semver.mjs'
import { verifySqliteDatabase } from './sqlite-backup.mjs'
import { updateError } from './update-error.mjs'
import { checkCandidateHealth } from './update-health.mjs'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'updateId', 'installationId', 'version', 'pid',
  'processStartTime', 'processInstanceId', 'probeToken', 'port',
  'authorizationNonce', 'stopToken',
])
const STATE_FIELDS = Object.freeze([
  'schemaVersion', 'installationId', 'version', 'port', 'pid',
  'processStartTime', 'launchNonce', 'stopToken',
])
const SAFE_ENV = Object.freeze({
  CROWN_WATCHER_AUTOSTART: '0',
  CROWN_BETTING_WORKER_AUTOSTART: '0',
  CROWN_REAL_BETTING_REQUESTED: '0',
  CROWN_REAL_BETTING_ENABLED: '0',
  CROWN_BETTING_MODE: 'off',
})

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactFields(value, fields) {
  return plainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
}

function validIso(value) {
  const millis = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(millis) && new Date(millis).toISOString() === value
}

function normalizeProcess(value, code = 'update-process-record-invalid') {
  if (!plainObject(value)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !validIso(value.processStartTime)
    || !ID.test(value.installationId || '')
    || !ID.test(value.processInstanceId || '')
    || !TOKEN.test(value.probeToken || '')) throw updateError(code)
  return Object.freeze({
    pid: value.pid,
    processStartTime: value.processStartTime,
    installationId: value.installationId,
    processInstanceId: value.processInstanceId,
    probeToken: value.probeToken,
  })
}

function normalizeCandidate(value, request, expected = {}) {
  if (!exactFields(value, CANDIDATE_FIELDS)
    || value.schemaVersion !== 1
    || value.updateId !== request.updateId
    || value.installationId !== request.installationId
    || value.version !== request.candidateVersion
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !validIso(value.processStartTime)
    || !ID.test(value.processInstanceId || '')
    || !TOKEN.test(value.probeToken || '')
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
    || !TOKEN.test(value.authorizationNonce || '')
    || !TOKEN.test(value.stopToken || '')
    || value.processInstanceId === value.stopToken
    || (expected.probeToken && value.probeToken !== expected.probeToken)
    || (expected.authorizationNonce && value.authorizationNonce !== expected.authorizationNonce)) {
    throw updateError('update-candidate-process-invalid')
  }
  return Object.freeze({ ...value })
}

function normalizeState(value) {
  if (!exactFields(value, STATE_FIELDS)
    || value.schemaVersion !== 1
    || !ID.test(value.installationId || '')
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !validIso(value.processStartTime)
    || !TOKEN.test(value.launchNonce || '')
    || !TOKEN.test(value.stopToken || '')
    || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw updateError('update-launcher-state-invalid')
  }
  try { parseSemver(value.version) } catch { throw updateError('update-launcher-state-invalid') }
  return Object.freeze({ ...value })
}

function safeChildEnvironment(overrides = {}) {
  const base = {}
  for (const key of ['SystemRoot', 'WINDIR', 'LOCALAPPDATA', 'ComSpec', 'PATH']) {
    if (typeof process.env[key] === 'string') base[key] = process.env[key]
  }
  return { ...base, ...SAFE_ENV, ...overrides }
}

function powershellExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
}

async function spawnPowerShell({ scriptPath, args = [], env = {}, detached = true } = {}) {
  const child = spawn(powershellExecutable(), [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args,
  ], {
    cwd: resolve(scriptPath, '..', '..'),
    detached,
    windowsHide: false,
    stdio: 'ignore',
    env,
  })
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise)
    child.once('error', reject)
  })
  child.unref()
}

async function runNode({ nodePath, args, workingDirectory, env } = {}) {
  const child = spawn(nodePath, args, {
    cwd: workingDirectory,
    windowsHide: false,
    stdio: 'ignore',
    env,
  })
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', resolvePromise)
  }).catch(() => null)
  if (code !== 0) throw updateError('update-candidate-migration-failed')
}

async function windowsProcessStartTime(pid) {
  if (process.platform !== 'win32') throw updateError('update-windows-runtime-required')
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-Process -Id ${pid} -ErrorAction Stop`,
    "$p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)",
  ].join(';')
  const child = spawn(powershellExecutable(), ['-NoLogo', '-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: safeChildEnvironment(),
  })
  const chunks = []
  let size = 0
  child.stdout.on('data', (chunk) => {
    size += chunk.length
    if (size <= 1024) chunks.push(chunk)
  })
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', resolvePromise)
  }).catch(() => null)
  if (code !== 0 || size > 1024) return null
  const value = Buffer.concat(chunks).toString('utf8').trim()
  return validIso(value) ? value : null
}

async function boundedHealth(url, record, version, fetchImpl) {
  let response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { accept: 'application/json', 'x-crown-launcher-probe': record.probeToken },
      })
    } catch { throw updateError('update-health-network-error') }
    if (response?.status !== 200) throw updateError('update-health-http-error')
    const text = await response.text()
    if (Buffer.byteLength(text) > 16 * 1024) throw updateError('update-process-identity-mismatch')
    const value = JSON.parse(text)
    if (value?.ok !== true || value.app !== 'crown-dashboard'
      || value.installationId !== record.installationId
      || value.version !== version
      || value.launchNonce !== record.processInstanceId
      || value.launcherPid !== record.pid
      || value.launcherProcessStartTime !== record.processStartTime
      || value.launcherProbe !== record.probeToken
      || typeof value.appContractVersion !== 'string' || value.appContractVersion.length === 0) {
      throw updateError('update-process-identity-mismatch')
    }
    return value
  } catch (error) {
    if (error?.code?.startsWith?.('update-')) throw error
    throw updateError('update-process-identity-mismatch')
  } finally {
    clearTimeout(timer)
  }
}

export function createWindowsUpdateRuntime(request, options = {}) {
  if (!plainObject(request)
    || !ID.test(request.installationId || '')
    || !ID.test(request.updateId || '')
    || !['apply', 'recover'].includes(request.operation)
    || typeof request.appRoot !== 'string'
    || typeof request.dataRoot !== 'string') throw updateError('update-windows-runtime-request-invalid')
  try { parseSemver(request.previousVersion); parseSemver(request.candidateVersion) } catch {
    throw updateError('update-windows-runtime-request-invalid')
  }
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw updateError('update-windows-runtime-required')
  const dataRoot = resolve(request.dataRoot)
  const appRoot = resolve(request.appRoot)
  const runtimeDir = join(dataRoot, 'runtime')
  const operationDir = join(dataRoot, 'updates', 'operations', request.updateId)
  const statePath = join(runtimeDir, 'launcher-state.json')
  const stopPath = join(runtimeDir, 'launcher-stop-request.json')
  const candidatePath = join(operationDir, 'candidate.json')
  const authorizedPath = join(operationDir, 'candidate-authorized.json')
  const abortPath = join(operationDir, 'candidate-abort.json')
  const launcherPath = join(appRoot, 'launcher', 'start.ps1')
  const spawnLauncher = options.spawnLauncher ?? spawnPowerShell
  const getProcessStartTime = options.getProcessStartTime ?? windowsProcessStartTime
  const sleep = options.sleep ?? ((ms) => delay(ms))
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
  const fixedProbeToken = options.probeToken
  const runBundledNode = options.runBundledNode ?? runNode
  const verifyDatabase = options.verifyDatabase ?? verifySqliteDatabase
  const capabilityRows = options.capabilityRows ?? listCrownCapabilities()

  async function readCandidate(expected = {}) {
    let value
    try { value = await readAtomicJson({ dataRoot, filePath: candidatePath }) } catch {
      throw updateError('update-candidate-process-invalid')
    }
    return normalizeCandidate(value, request, expected)
  }

  async function readState() {
    let value
    try { value = await readAtomicJson({ dataRoot, filePath: statePath }) } catch {
      throw updateError('update-launcher-state-invalid')
    }
    return normalizeState(value)
  }

  async function locate(record) {
    const expected = normalizeProcess(record)
    const actualStart = await getProcessStartTime(expected.pid)
    if (actualStart === null) return { state: 'dead' }
    if (actualStart !== expected.processStartTime) throw updateError('update-process-identity-mismatch')
    let source
    try {
      const state = await readState()
      if (state.pid === expected.pid && state.processStartTime === expected.processStartTime
        && state.installationId === expected.installationId && state.launchNonce === expected.processInstanceId) {
        source = { port: state.port, version: state.version, stopToken: state.stopToken, kind: 'old' }
      }
    } catch {}
    if (!source) {
      let candidateValue
      try { candidateValue = await readCandidate() } catch {}
      if (candidateValue && candidateValue.pid === expected.pid
        && candidateValue.processStartTime === expected.processStartTime
        && candidateValue.installationId === expected.installationId
        && candidateValue.processInstanceId === expected.processInstanceId
        && candidateValue.probeToken === expected.probeToken) {
        source = { port: candidateValue.port, version: candidateValue.version, candidate: candidateValue, kind: 'candidate' }
      }
    }
    if (!source) throw updateError('update-process-identity-mismatch')
    if (source.kind === 'old') {
      await boundedHealth(`http://127.0.0.1:${source.port}/api/health`, expected, source.version, fetchImpl)
    }
    return { state: 'alive', process: expected, source }
  }

  async function probeProcess(record) {
    const located = await locate(record)
    return located.state === 'dead' ? { state: 'dead' } : { state: 'alive', ...located.process }
  }

  async function stopProcess(record) {
    const located = await locate(record)
    if (located.state === 'dead') return { stopped: true }
    if (located.source.kind === 'old') {
      await writeAtomicJson({
        dataRoot,
        filePath: stopPath,
        value: {
          schemaVersion: 1,
          installationId: located.process.installationId,
          pid: located.process.pid,
          processStartTime: located.process.processStartTime,
          launchNonce: located.process.processInstanceId,
          stopToken: located.source.stopToken,
        },
      })
    } else {
      await writeAtomicJson({ dataRoot, filePath: abortPath, value: { ...located.source.candidate, abort: true } })
    }
    return { stopped: true }
  }

  async function startCandidate({ version, authorize } = {}) {
    if (version !== request.candidateVersion || typeof authorize !== 'function') {
      throw updateError('update-candidate-launch-invalid')
    }
    const authorizationNonce = randomToken()
    const probeToken = fixedProbeToken ?? randomToken()
    if (!TOKEN.test(authorizationNonce || '') || !TOKEN.test(probeToken || '') || authorizationNonce === probeToken) {
      throw updateError('update-candidate-random-invalid')
    }
    await mkdir(operationDir, { recursive: true })
    try {
      await validateDataPath({ dataRoot, targetPath: operationDir, requireExists: true, expectDirectory: true })
      await validateDataPath({ dataRoot: appRoot, targetPath: launcherPath, requireExists: true, expectDirectory: false })
    } catch { throw updateError('update-candidate-path-invalid') }
    await spawnLauncher({
      scriptPath: launcherPath,
      args: [
        '-NoBrowser', '-CandidateVersion', version,
        '-CandidateUpdateId', request.updateId,
        '-CandidateProbeToken', probeToken,
        '-CandidateAuthorizationNonce', authorizationNonce,
        '-CandidateOperationDir', operationDir,
      ],
      env: safeChildEnvironment(),
      detached: true,
    })
    let value
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try { value = await readCandidate({ probeToken, authorizationNonce }); break } catch (error) {
          if (attempt === 299) throw error
          await sleep(100)
        }
      }
      const actualStart = await getProcessStartTime(value.pid)
      if (actualStart !== value.processStartTime) throw updateError('update-candidate-process-invalid')
      const record = normalizeProcess(value, 'update-candidate-process-invalid')
      await authorize(record)
      await writeAtomicJson({ dataRoot, filePath: authorizedPath, value: { ...value, authorized: true } })
      return record
    } catch (error) {
      if (value) await writeAtomicJson({ dataRoot, filePath: abortPath, value: { ...value, abort: true } }).catch(() => {})
      if (error?.code?.startsWith?.('update-')) throw error
      throw updateError('update-candidate-process-invalid')
    }
  }

  async function resolveCandidateProcess(journal) {
    if (!plainObject(journal) || journal.updateId !== request.updateId) {
      throw updateError('update-recovery-process-unverifiable')
    }
    let value
    try { value = await readCandidate() } catch {
      if (journal.candidatePid === null || journal.candidatePid === undefined) return null
      throw updateError('update-recovery-process-unverifiable')
    }
    if (journal.candidatePid !== null && journal.candidatePid !== undefined
      && (journal.candidatePid !== value.pid || journal.candidateInstanceId !== value.processInstanceId)) {
      throw updateError('update-recovery-process-unverifiable')
    }
    return normalizeProcess(value, 'update-recovery-process-unverifiable')
  }

  async function startPrevious({ version } = {}) {
    if (version !== request.previousVersion) throw updateError('update-previous-version-invalid')
    if (request.operation === 'recover') return { started: false, reason: 'launcher-recovery-continues' }
    await spawnLauncher({
      scriptPath: launcherPath,
      args: ['-NoBrowser'],
      env: safeChildEnvironment(),
      detached: true,
    })
    return { started: true, version }
  }

  async function migrateCandidate({ version } = {}) {
    if (version !== request.candidateVersion) throw updateError('update-candidate-version-invalid')
    const versionRoot = join(appRoot, 'versions', version)
    const appDir = join(versionRoot, 'app')
    const nodePath = join(versionRoot, 'runtime', 'node', 'node.exe')
    const databaseModule = join(appDir, 'src', 'crown', 'app', 'app-db.mjs')
    try {
      for (const [targetPath, expectDirectory] of [[versionRoot, true], [appDir, true], [nodePath, false], [databaseModule, false]]) {
        await validateDataPath({ dataRoot: appRoot, targetPath, requireExists: true, expectDirectory })
      }
      await validateDataPath({ dataRoot, targetPath: request.dbPath, requireExists: true, expectDirectory: false })
    } catch { throw updateError('update-candidate-migration-path-invalid') }
    const source = [
      "import { pathToFileURL } from 'node:url'",
      "const module = await import(pathToFileURL(process.env.CROWN_UPDATE_DATABASE_MODULE).href)",
      "const handle = module.openAppDatabase({ dbPath: process.env.CROWN_DB_PATH, env: process.env })",
      'handle.close()',
    ].join(';')
    await runBundledNode({
      nodePath,
      args: ['--input-type=module', '--eval', source],
      workingDirectory: appDir,
      env: safeChildEnvironment({
        CROWN_PORTABLE: '1',
        CROWN_APP_ROOT: appRoot,
        CROWN_VERSION_ROOT: versionRoot,
        CROWN_APP_DIR: appDir,
        CROWN_APP_VERSION: version,
        CROWN_DATA_ROOT: dataRoot,
        CROWN_DB_PATH: request.dbPath,
        CROWN_UPDATE_DATABASE_MODULE: databaseModule,
      }),
    })
    return { migrated: true, version }
  }

  async function checkHealth({
    process: candidateProcess,
    expectedVersion,
    expectedInstallationId,
    requiredRuntimeState,
  } = {}) {
    if (expectedVersion !== request.candidateVersion
      || expectedInstallationId !== request.installationId
      || requiredRuntimeState?.watcher !== 'stopped'
      || requiredRuntimeState?.worker !== 'stopped'
      || requiredRuntimeState?.capability?.preview !== 0
      || requiredRuntimeState?.capability?.submit !== 0
      || requiredRuntimeState?.capability?.reconciliation !== 0) {
      throw updateError('update-health-expectation-invalid')
    }
    if (!Array.isArray(capabilityRows)
      || capabilityRows.some((row) => row?.previewAllowed !== false
        || row?.submitAllowed !== false
        || row?.reconciliationAllowed !== false)) {
      throw updateError('update-health-capability-not-zero')
    }
    const candidateRecord = await readCandidate()
    let authorization
    try { authorization = await readAtomicJson({ dataRoot, filePath: authorizedPath }) } catch {
      throw updateError('update-health-candidate-not-authorized')
    }
    if (!exactFields(authorization, [...CANDIDATE_FIELDS, 'authorized'])
      || authorization.authorized !== true
      || CANDIDATE_FIELDS.some((field) => authorization[field] !== candidateRecord[field])) {
      throw updateError('update-health-candidate-not-authorized')
    }
    const processRecord = normalizeProcess(candidateProcess, 'update-candidate-process-invalid')
    if (processRecord.pid !== candidateRecord.pid
      || processRecord.processStartTime !== candidateRecord.processStartTime
      || processRecord.installationId !== candidateRecord.installationId
      || processRecord.processInstanceId !== candidateRecord.processInstanceId
      || processRecord.probeToken !== candidateRecord.probeToken) {
      throw updateError('update-candidate-process-invalid')
    }
    await locate(processRecord)
    let database
    try { database = await verifyDatabase({ dataRoot, dbPath: request.dbPath }) } catch {
      throw updateError('update-health-database-invalid')
    }
    if (!Number.isSafeInteger(database?.userVersion) || database.userVersion < 0) {
      throw updateError('update-health-database-invalid')
    }
    let checked
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        await boundedHealth(
          `http://127.0.0.1:${candidateRecord.port}/api/health`,
          processRecord,
          expectedVersion,
          fetchImpl,
        )
        checked = await checkCandidateHealth({
          dataRoot,
          healthUrl: `http://127.0.0.1:${candidateRecord.port}/api/health/update`,
          probeToken: candidateRecord.probeToken,
          expectedAppId: 'crown-monitor',
          expectedVersion,
          expectedAppContractVersion: APP_CONTRACT_VERSION,
          expectedInstallationId,
          expectedSchemaVersion: database.userVersion,
          dbPath: request.dbPath,
          fetchImpl,
          timeoutMs: 2_000,
        })
        break
      } catch (error) {
        const code = error?.code || error?.message
        const retryable = ['update-health-network-error', 'update-health-http-error', 'update-health-timeout'].includes(code)
        if (!retryable || attempt === 299) {
          throw updateError(typeof code === 'string' && code.startsWith('update-health-') ? code : 'update-health-candidate-failed')
        }
        await sleep(100)
      }
    }
    return {
      ok: true,
      version: expectedVersion,
      installationId: expectedInstallationId,
      schemaVersion: checked.schemaVersion,
      watcher: 'stopped',
      worker: 'stopped',
      capability: { preview: 0, submit: 0, reconciliation: 0 },
    }
  }

  return Object.freeze({
    probeProcess,
    stopProcess,
    migrateCandidate,
    startCandidate,
    checkHealth,
    resolveCandidateProcess,
    startPrevious,
    operationDir,
    candidatePath,
    authorizedPath,
    abortPath,
  })
}

export { SAFE_ENV as WINDOWS_UPDATE_SAFE_ENV }
