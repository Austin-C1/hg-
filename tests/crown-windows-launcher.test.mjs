import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagingRoot = path.join(repoRoot, 'packaging', 'windows')
const startScript = path.join(packagingRoot, 'launcher', 'start.ps1')
const stopScript = path.join(packagingRoot, 'launcher', 'stop.ps1')
const requiredFiles = [
  '启动程序.cmd',
  '停止程序.cmd',
  '首次使用说明.txt',
  'launcher/start.ps1',
  'launcher/stop.ps1',
  'launcher/update-bootstrap.ps1',
]

const powershell = 'powershell.exe'
let bundledNodeCache = null

test.after(() => {
  if (bundledNodeCache) fs.rmSync(bundledNodeCache, { force: true })
})

function psArgs(script, extra = []) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra]
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
    else throw new Error(`unsupported-fixture-entry:${entry.name}`)
  }
}

function cachedBundledNode() {
  const source = fs.statSync(process.execPath)
  const cache = path.join(os.tmpdir(), `crown-launcher-node-${source.size}.exe`)
  let cached
  try { cached = fs.statSync(cache) } catch {}
  if (!cached || cached.size !== source.size) {
    const temporary = `${cache}.${process.pid}.tmp`
    fs.copyFileSync(process.execPath, temporary)
    try { fs.renameSync(temporary, cache) } catch (error) {
      fs.rmSync(temporary, { force: true })
      if (error.code !== 'EEXIST') throw error
    }
  }
  bundledNodeCache = cache
  return cache
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  if (lastError) throw lastError
  throw new Error('wait-timeout')
}

function makePortableFixture(t, { dashboard = 'healthy' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '皇冠 启动测试 '))
  copyTree(packagingRoot, root)
  const version = '0.1.0'
  const versionRoot = path.join(root, 'versions', version)
  const appDir = path.join(versionRoot, 'app')
  const runtimeNodeDir = path.join(versionRoot, 'runtime', 'node')
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(appDir, 'src', 'crown', 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(appDir, 'config'), { recursive: true })
  fs.mkdirSync(path.join(appDir, 'frontend', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(versionRoot, 'runtime', 'chromium'), { recursive: true })
  fs.mkdirSync(runtimeNodeDir, { recursive: true })
  fs.linkSync(cachedBundledNode(), path.join(runtimeNodeDir, 'node.exe'))
  fs.writeFileSync(path.join(versionRoot, 'runtime', 'chromium', 'chrome.exe'), '')
  fs.writeFileSync(path.join(root, 'current.json'), `${JSON.stringify({ schemaVersion: 1, version })}\n`)
  fs.writeFileSync(path.join(appDir, 'config', 'default-leagues.json'), '{"version":1,"leagues":[]}\n')
  fs.writeFileSync(path.join(appDir, 'src', 'crown', 'runtime', 'portable-instance.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
export function initializePortableData({ dataRoot }) {
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true })
  const inheritedKeys = [
    'CROWN_SECRET_KEY', 'CROWN_BETTING_ALLOWED_ORIGINS', 'CROWN_REAL_MAX_TOTAL_MINOR',
    'CROWN_REAL_CURRENCY', 'CROWN_REAL_AMOUNT_SCALE', 'CROWN_BETTING_MODE',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'OPENSSL_CONF', 'SSLKEYLOGFILE',
  ]
  fs.writeFileSync(path.join(dataRoot, 'runtime', 'initializer-env.json'), JSON.stringify(Object.fromEntries(
    inheritedKeys.map((key) => [key, process.env[key] ?? null]),
  )))
  const identity = path.join(dataRoot, 'installation.json')
  if (!fs.existsSync(identity)) fs.writeFileSync(identity, JSON.stringify({ schemaVersion: 1, installationId: 'install-fixture' }) + '\\n')
  return { installationId: 'install-fixture' }
}
`)
  const portRaceSetup = dashboard === 'port-race' ? `
  const attemptFile = path.join(runtimeDir, 'fake-port-attempts.txt')
  const attempt = fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, 'utf8')) + 1 : 1
  fs.writeFileSync(attemptFile, String(attempt))
  if (attempt === 1) { const error = new Error('address in use'); error.code = 'EADDRINUSE'; throw error }
` : ''
  const syncBlockSetup = dashboard === 'sync-block' ? `
  const blockDeadline = Date.now() + 15_000
  while (!fs.existsSync(path.join(runtimeDir, 'fake-sync-release.txt')) && Date.now() < blockDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
` : ''
  const delayedHealthGuard = dashboard === 'delayed-health' ? `
    if (!fs.existsSync(path.join(runtimeDir, 'fake-health-ready.txt'))) {
      res.writeHead(503)
      res.end(JSON.stringify({ ok: false }))
      return
    }
` : ''
  const healthyBody = `
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
export async function startCrownDashboard({ env = process.env } = {}) {
  const runtimeDir = env.CROWN_RUNTIME_DIR
  fs.mkdirSync(runtimeDir, { recursive: true })
  ${portRaceSetup}
  fs.appendFileSync(path.join(runtimeDir, 'fake-starts.jsonl'), JSON.stringify({
    pid: process.pid,
    processStartTime: env.CROWN_LAUNCHER_PROCESS_START_TIME,
    nonce: env.CROWN_LAUNCHER_NONCE,
  }) + '\\n')
  const activeFile = path.join(runtimeDir, 'fake-active-' + process.pid + '.txt')
  fs.writeFileSync(activeFile, 'active')
  const activeCount = fs.readdirSync(runtimeDir).filter((name) => name.startsWith('fake-active-')).length
  const maxFile = path.join(runtimeDir, 'fake-active-max.txt')
  const previousMax = fs.existsSync(maxFile) ? Number(fs.readFileSync(maxFile, 'utf8')) : 0
  fs.writeFileSync(maxFile, String(Math.max(previousMax, activeCount)))
  ${syncBlockSetup}
  fs.writeFileSync(path.join(runtimeDir, 'fake-startup.json'), JSON.stringify({
    appRoot: env.CROWN_APP_ROOT,
    appDir: env.CROWN_APP_DIR,
    dataRoot: env.CROWN_DATA_ROOT,
    node: process.execPath,
    chromium: env.CROWN_CHROMIUM_EXECUTABLE_PATH,
    installationId: env.CROWN_INSTALLATION_ID,
    watcherAutostart: env.CROWN_WATCHER_AUTOSTART || '',
    workerAutostart: env.CROWN_BETTING_WORKER_AUTOSTART || '',
    inherited: Object.fromEntries([
      'CROWN_SECRET_KEY', 'CROWN_BETTING_ALLOWED_ORIGINS', 'CROWN_REAL_MAX_TOTAL_MINOR',
      'CROWN_REAL_CURRENCY', 'CROWN_REAL_AMOUNT_SCALE', 'CROWN_BETTING_MODE',
      'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'OPENSSL_CONF', 'SSLKEYLOGFILE',
    ].map((key) => [key, env[key] ?? null])),
  }))
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/health') { res.writeHead(404); res.end(); return }
    ${delayedHealthGuard}
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      ok: true,
      readonly: true,
      app: 'crown-dashboard',
      installationId: env.CROWN_INSTALLATION_ID,
      version: env.CROWN_APP_VERSION,
      appContractVersion: 'dynamic-betting-cards-v1',
      launchNonce: env.CROWN_LAUNCHER_NONCE,
      launcherPid: process.pid,
      launcherProcessStartTime: env.CROWN_LAUNCHER_PROCESS_START_TIME,
      launcherProbe: req.headers['x-crown-launcher-probe'] || '',
    }))
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(Number(env.CROWN_DASHBOARD_PORT), '127.0.0.1', resolve))
  return {
    async shutdown() {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(activeFile, { force: true })
      fs.writeFileSync(path.join(runtimeDir, 'fake-shutdown.txt'), 'ordered')
      return { ok: true, errors: [] }
    },
  }
}
`
  const hangingBody = `
import fs from 'node:fs'
import path from 'node:path'
export async function startCrownDashboard({ env = process.env } = {}) {
  fs.mkdirSync(env.CROWN_RUNTIME_DIR, { recursive: true })
  fs.writeFileSync(path.join(env.CROWN_RUNTIME_DIR, 'fake-hanging-pid.txt'), String(process.pid))
  const keepAlive = setInterval(() => {}, 1000)
  return {
    async shutdown() { clearInterval(keepAlive); return { ok: true, errors: [] } },
  }
}
`
  fs.writeFileSync(path.join(appDir, 'scripts', 'crown-dashboard.mjs'), dashboard === 'hanging' ? hangingBody : healthyBody)
  const localAppData = path.join(root, '本地 数据')
  fs.mkdirSync(localAppData, { recursive: true })
  const dataRoot = path.join(localAppData, 'CrownMonitor')
  const fixture = { root, version, appDir, localAppData, dataRoot }
  t.after(async () => {
    const stateFile = path.join(dataRoot, 'runtime', 'launcher-state.json')
    if (fs.existsSync(stateFile)) {
      try {
        await runPowerShell(path.join(root, 'launcher', 'stop.ps1'), {
          env: launcherEnv(fixture),
          extra: ['-StopTimeoutSeconds', '3'],
        })
      } catch {}
    }
    await sleep(250)
    const pidFiles = [
      path.join(dataRoot, 'runtime', 'fake-starts.jsonl'),
      path.join(dataRoot, 'runtime', 'fake-hanging-pid.txt'),
    ]
    const recordedPids = []
    for (const file of pidFiles) {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8').trim()
      if (!text) continue
      if (file.endsWith('.jsonl')) recordedPids.push(...text.split('\n').map((line) => JSON.parse(line).pid))
      else recordedPids.push(Number(text))
    }
    const stillAlive = recordedPids.some((pid) => {
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return true
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (!stillAlive) fs.rmSync(root, { recursive: true, force: true })
  })
  return fixture
}

function launcherEnv(fixture, overrides = {}) {
  return {
    SystemRoot: process.env.SystemRoot,
    windir: process.env.windir,
    ComSpec: process.env.ComSpec,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LOCALAPPDATA: fixture.localAppData,
    CROWN_LAUNCHER_NO_BROWSER: '1',
    CROWN_WATCHER_AUTOSTART: '',
    CROWN_BETTING_WORKER_AUTOSTART: '',
    ...overrides,
  }
}

function launchStart(fixture, extra = [], envOverrides = {}) {
  return spawn(powershell, psArgs(path.join(fixture.root, 'launcher', 'start.ps1'), ['-NoBrowser', ...extra]), {
    cwd: os.tmpdir(),
    env: launcherEnv(fixture, envOverrides),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runPowerShell(script, { env = process.env, extra = [] } = {}) {
  return childResult(spawn(powershell, psArgs(script, extra), {
    cwd: os.tmpdir(),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
}

async function childResult(child) {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  const code = child.exitCode !== null
    ? child.exitCode
    : await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
  return { code, stdout, stderr }
}

test('Windows package exposes only self-relative manual launch, stop, and update bootstrap entrypoints', () => {
  for (const relative of requiredFiles) {
    assert.equal(fs.existsSync(path.join(packagingRoot, ...relative.split('/'))), true, relative)
  }
  const startCmd = fs.readFileSync(path.join(packagingRoot, '启动程序.cmd'), 'utf8')
  const stopCmd = fs.readFileSync(path.join(packagingRoot, '停止程序.cmd'), 'utf8')
  const startPs = fs.readFileSync(startScript, 'utf8')
  const stopPs = fs.readFileSync(stopScript, 'utf8')
  const updater = fs.readFileSync(path.join(packagingRoot, 'launcher', 'update-bootstrap.ps1'), 'utf8')
  const all = [startCmd, stopCmd, startPs, stopPs, updater].join('\n')

  assert.match(startCmd, /%~dp0/)
  assert.match(stopCmd, /%~dp0/)
  assert.match(startCmd, /pause/i)
  assert.match(startPs, /\$PSScriptRoot/)
  assert.match(stopPs, /\$PSScriptRoot/)
  assert.match(startPs, /current\.json/)
  assert.match(startPs, /launcher-state\.json/)
  assert.match(stopPs, /launcher-state\.json/)
  assert.match(startPs, /processStartTime/)
  assert.match(stopPs, /processStartTime/)
  assert.match(startPs, /launchNonce/)
  assert.match(startPs, /stopToken/)
  assert.match(stopPs, /launchNonce/)
  assert.match(stopPs, /stopToken/)
  assert.match(startPs, /Security\.Cryptography\.SHA256|SHA256/)
  assert.match(startPs, /Threading\.Mutex|Mutex/)
  assert.match(startPs, /ReparsePoint/)
  assert.match(stopPs, /ReparsePoint/)
  assert.match(startPs, /Verify-PublishedState/)
  assert.match(startPs, /EADDRINUSE/)
  assert.match(startPs, /127\.0\.0\.1/)
  assert.match(stopPs, /127\.0\.0\.1/)
  assert.match(startPs, /portable-instance\.mjs/)
  assert.match(startPs, /WaitForExit/)
  assert.match(startPs, /SIGHUP/)
  assert.match(updater, /runtime[\\/]node[\\/]node\.exe/)
  assert.match(updater, /crown-update-apply\.mjs/)
  assert.match(updater, /--request/)
  assert.doesNotMatch(updater, /Invoke-WebRequest|Start-BitsTransfer|curl\.exe|https?:\/\//i)
  assert.doesNotMatch(all, /C:\\Users\\|Desktop\\|Program Files.*(?:node|chrome|edge)|msedge\.exe|chrome\.exe.*Program Files/i)
  assert.doesNotMatch(all, /\b(?:node|node\.exe)\b\s+["']?scripts[\\/]crown-dashboard/i)
  assert.doesNotMatch(stopPs, /Get-Process\s+(?:node|node\.exe)|taskkill[^\r\n]*\/IM|Stop-Process[^\r\n]*-Name/i)
  assert.doesNotMatch(startPs, /WATCHER_AUTOSTART\s*=\s*['"]?1|BETTING_WORKER_AUTOSTART\s*=\s*['"]?1/i)
})

test('Dashboard health binds a per-request probe to launcher nonce and wrapper process identity', async (t) => {
  const nonce = randomBytes(32).toString('base64url')
  const probe = randomBytes(32).toString('base64url')
  const processStartTime = '2026-07-13T00:00:00.000Z'
  const server = createDashboardServer({
    appOptions: {
      installationId: 'install-fixture',
      env: {
        CROWN_INSTALLATION_ID: 'install-fixture',
        CROWN_LAUNCHER_NONCE: nonce,
        CROWN_LAUNCHER_PROCESS_START_TIME: processStartTime,
      },
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { 'x-crown-launcher-probe': probe },
  })
  const health = await response.json()
  assert.equal(health.launchNonce, nonce)
  assert.equal(health.launcherPid, process.pid)
  assert.equal(health.launcherProcessStartTime, processStartTime)
  assert.equal(health.launcherProbe, probe)
  assert.equal(JSON.stringify(health).includes('stopToken'), false)
})

test('launcher rejects drive-relative LOCALAPPDATA instead of resolving it through caller cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-drive-relative-'))
  try {
    copyTree(packagingRoot, root)
    fs.writeFileSync(path.join(root, 'current.json'), '{"schemaVersion":1,"version":"0.1.0"}\n')
    const result = await runPowerShell(path.join(root, 'launcher', 'start.ps1'), {
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: 'C:relative-data' },
      extra: ['-NoBrowser'],
    })
    assert.notEqual(result.code, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /launcher-localappdata-invalid/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('launcher rejects a LOCALAPPDATA junction before portable initialization or bundled Node execution', async () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-reparse-root-'))
  const packageRoot = path.join(container, 'package')
  const actualLocal = path.join(container, 'actual-local')
  const linkedLocal = path.join(container, 'linked-local')
  fs.mkdirSync(packageRoot)
  fs.mkdirSync(actualLocal)
  copyTree(packagingRoot, packageRoot)
  fs.writeFileSync(path.join(packageRoot, 'current.json'), '{"schemaVersion":1,"version":"0.1.0"}\n')
  fs.symlinkSync(actualLocal, linkedLocal, 'junction')
  try {
    const result = await runPowerShell(path.join(packageRoot, 'launcher', 'start.ps1'), {
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: linkedLocal },
      extra: ['-NoBrowser'],
    })
    assert.notEqual(result.code, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /launcher-reparse-forbidden/)
    assert.equal(fs.existsSync(path.join(actualLocal, 'CrownMonitor')), false)
  } finally {
    fs.unlinkSync(linkedLocal)
    fs.rmSync(container, { recursive: true, force: true })
  }
})

test('update bootstrap uses only previous-version bundled Node and the contained exact request', async (t) => {
  const fixture = makePortableFixture(t)
  const updateDir = path.join(fixture.dataRoot, 'updates')
  const requestPath = path.join(updateDir, 'active-request.json')
  const markerPath = path.join(updateDir, 'bootstrap-marker.json')
  fs.mkdirSync(path.join(fixture.dataRoot, 'storage'), { recursive: true })
  fs.mkdirSync(path.join(fixture.dataRoot, 'backups'), { recursive: true })
  fs.mkdirSync(updateDir, { recursive: true })
  fs.writeFileSync(path.join(fixture.appDir, 'scripts', 'crown-update-apply.mjs'), `
    import fs from 'node:fs'
    fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
      execPath: process.execPath,
      argv: process.argv.slice(2),
      dataRoot: process.env.CROWN_DATA_ROOT,
      watcher: process.env.CROWN_WATCHER_AUTOSTART,
      worker: process.env.CROWN_BETTING_WORKER_AUTOSTART,
      realRequested: process.env.CROWN_REAL_BETTING_REQUESTED,
      realEnabled: process.env.CROWN_REAL_BETTING_ENABLED,
    }))
  `)
  fs.writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 1, operation: 'apply', installationId: 'install-fixture', updateId: 'update-A',
    previousVersion: '0.1.0', candidateVersion: '0.2.0', expectedVersion: '0.2.0',
    dataRoot: fixture.dataRoot, journalPath: path.join(updateDir, 'journal.json'),
    dbPath: path.join(fixture.dataRoot, 'storage', 'crown.sqlite'),
    backupPath: path.join(fixture.dataRoot, 'backups', 'update-A.sqlite'),
    appRoot: fixture.root, currentPath: path.join(fixture.root, 'current.json'),
    candidateIdentity: { dev: '0', ino: '0' },
    oldProcess: {
      pid: process.pid, processStartTime: '2026-07-13T08:00:00.000Z', installationId: 'install-fixture',
      processInstanceId: 'N'.repeat(43), probeToken: 'P'.repeat(43),
    },
  })}\n`)
  const result = await runPowerShell(path.join(fixture.root, 'launcher', 'update-bootstrap.ps1'), {
    env: launcherEnv(fixture),
    extra: ['-RequestPath', requestPath],
  })
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const marker = readJson(markerPath)
  assert.equal(path.resolve(marker.execPath), path.resolve(path.join(fixture.root, 'versions', '0.1.0', 'runtime', 'node', 'node.exe')))
  assert.deepEqual(marker.argv, ['--request', requestPath])
  assert.equal(marker.dataRoot, fixture.dataRoot)
  assert.equal(marker.watcher, '0')
  assert.equal(marker.worker, '0')
  assert.equal(marker.realRequested, '0')
  assert.equal(marker.realEnabled, '0')
})

test('update bootstrap rejects missing, outside, or mismatched requests before bundled Node runs', async (t) => {
  const fixture = makePortableFixture(t)
  const outside = path.join(fixture.root, 'outside-request.json')
  fs.writeFileSync(outside, '{}\n')
  for (const extra of [[], ['-RequestPath', outside]]) {
    const result = await runPowerShell(path.join(fixture.root, 'launcher', 'update-bootstrap.ps1'), {
      env: launcherEnv(fixture), extra,
    })
    assert.notEqual(result.code, 0)
    assert.match(`${result.stdout}\n${result.stderr}`.replace(/\s/g, ''), /update-bootstrap-(?:request-required|request-outside-data-root)/)
  }
})

test('candidate launcher publishes exact identity and waits for durable updater authorization before Dashboard import', async (t) => {
  const fixture = makePortableFixture(t)
  const operationDir = path.join(fixture.dataRoot, 'updates', 'operations', 'update-A')
  fs.mkdirSync(operationDir, { recursive: true })
  const probeToken = 'P'.repeat(43)
  const authorizationNonce = 'A'.repeat(43)
  const child = launchStart(fixture, [
    '-CandidateVersion', fixture.version,
    '-CandidateUpdateId', 'update-A',
    '-CandidateProbeToken', probeToken,
    '-CandidateAuthorizationNonce', authorizationNonce,
    '-CandidateOperationDir', operationDir,
  ])
  const candidatePath = path.join(operationDir, 'candidate.json')
  let candidate
  try { candidate = await waitFor(() => fs.existsSync(candidatePath) && readJson(candidatePath)) } catch (error) {
    child.kill()
    const result = await childResult(child)
    assert.fail(`candidate-not-published:${error.message}\n${result.stdout}\n${result.stderr}`)
  }
  assert.deepEqual(Object.keys(candidate), [
    'schemaVersion', 'updateId', 'installationId', 'version', 'pid', 'processStartTime',
    'processInstanceId', 'probeToken', 'port', 'authorizationNonce', 'stopToken',
  ])
  assert.equal(candidate.updateId, 'update-A')
  assert.equal(candidate.installationId, 'install-fixture')
  assert.equal(candidate.version, fixture.version)
  assert.equal(candidate.probeToken, probeToken)
  assert.equal(candidate.authorizationNonce, authorizationNonce)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json')), false)
  await sleep(300)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json')), false)

  fs.writeFileSync(path.join(operationDir, 'candidate-authorized.json'), `${JSON.stringify({ ...candidate, authorized: true })}\n`)
  const statePath = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  const state = await waitFor(() => fs.existsSync(statePath) && readJson(statePath))
  assert.equal(state.pid, candidate.pid)
  assert.equal(state.processStartTime, candidate.processStartTime)
  assert.equal(state.launchNonce, candidate.processInstanceId)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json')), true)
  const stop = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), {
    env: launcherEnv(fixture), extra: ['-StopTimeoutSeconds', '5'],
  })
  assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`)
  const result = await Promise.race([
    childResult(child),
    sleep(8_000).then(() => { child.kill(); throw new Error('candidate-launcher-exit-timeout') }),
  ])
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
})

test('candidate launcher exact abort stops before Dashboard import and never publishes normal state', async (t) => {
  const fixture = makePortableFixture(t)
  const operationDir = path.join(fixture.dataRoot, 'updates', 'operations', 'update-abort')
  fs.mkdirSync(operationDir, { recursive: true })
  const child = launchStart(fixture, [
    '-CandidateVersion', fixture.version,
    '-CandidateUpdateId', 'update-abort',
    '-CandidateProbeToken', 'P'.repeat(43),
    '-CandidateAuthorizationNonce', 'A'.repeat(43),
    '-CandidateOperationDir', operationDir,
  ])
  const candidatePath = path.join(operationDir, 'candidate.json')
  let candidate
  try { candidate = await waitFor(() => fs.existsSync(candidatePath) && readJson(candidatePath)) } catch (error) {
    child.kill()
    const result = await childResult(child)
    assert.fail(`candidate-not-published:${error.message}\n${result.stdout}\n${result.stderr}`)
  }
  fs.writeFileSync(path.join(operationDir, 'candidate-abort.json'), `${JSON.stringify({ ...candidate, abort: true })}\n`)
  const result = await childResult(child)
  assert.notEqual(result.code, 0)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json')), false)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')), false)
})

test('normal launcher resumes the exact pending apply when its journal was never created', async (t) => {
  const fixture = makePortableFixture(t)
  const updateDir = path.join(fixture.dataRoot, 'updates')
  const requestPath = path.join(updateDir, 'active-request.json')
  const markerPath = path.join(updateDir, 'recovery-marker.json')
  fs.mkdirSync(path.join(fixture.dataRoot, 'storage'), { recursive: true })
  fs.mkdirSync(path.join(fixture.dataRoot, 'backups'), { recursive: true })
  fs.mkdirSync(updateDir, { recursive: true })
  const oldOperationDir = path.join(updateDir, 'operations', 'update-old')
  const newOperationDir = path.join(updateDir, 'operations', 'update-new')
  fs.mkdirSync(oldOperationDir, { recursive: true })
  fs.writeFileSync(path.join(oldOperationDir, 'journal.json'), `${JSON.stringify({
    schemaVersion: 1,
    updateId: 'update-old',
    previousVersion: '0.0.9',
    candidateVersion: '0.1.0',
    backupPath: '',
    phase: 'committed',
    currentSwitched: true,
    candidatePid: null,
    candidateInstanceId: '',
    updatedAt: '2026-07-13T07:00:00.000Z',
  })}\n`)
  fs.writeFileSync(path.join(fixture.root, 'current.json'), '{broken-current\n')
  fs.writeFileSync(path.join(fixture.appDir, 'scripts', 'crown-update-apply.mjs'), `
    import fs from 'node:fs'
    const requestPath = process.argv[process.argv.indexOf('--request') + 1]
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    if (request.operation !== 'apply') process.exit(91)
    fs.writeFileSync(${JSON.stringify(path.join(fixture.root, 'current.json'))}, JSON.stringify({ schemaVersion: 1, version: '0.1.0' }) + '\\n')
    fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ operation: request.operation, requestPath, candidateIdentity: request.candidateIdentity }))
  `)
  fs.writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 1, operation: 'apply', installationId: 'install-fixture', updateId: 'update-new',
    previousVersion: '0.1.0', candidateVersion: '0.2.0', expectedVersion: '0.2.0',
    dataRoot: fixture.dataRoot, journalPath: path.join(newOperationDir, 'journal.json'),
    dbPath: path.join(fixture.dataRoot, 'storage', 'crown.sqlite'),
    backupPath: path.join(fixture.dataRoot, 'backups', 'update-recover.sqlite'),
    appRoot: fixture.root, currentPath: path.join(fixture.root, 'current.json'),
    candidateIdentity: { dev: '0', ino: '0' },
    oldProcess: {
      pid: 999999, processStartTime: '2026-07-13T08:00:00.000Z', installationId: 'install-fixture',
      processInstanceId: 'N'.repeat(43), probeToken: 'P'.repeat(43),
    },
  })}\n`)
  const child = launchStart(fixture)
  const statePath = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  try { await waitFor(() => fs.existsSync(statePath) && readJson(statePath)) } catch (error) {
    child.kill()
    const result = await childResult(child)
    assert.fail(`recovery-launch-failed:${error.message}\n${result.stdout}\n${result.stderr}`)
  }
  const marker = readJson(markerPath)
  assert.equal(marker.operation, 'apply')
  assert.equal(path.resolve(marker.requestPath), path.resolve(requestPath))
  assert.deepEqual(marker.candidateIdentity, { dev: '0', ino: '0' })
  const stop = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), {
    env: launcherEnv(fixture), extra: ['-StopTimeoutSeconds', '5'],
  })
  assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`)
  const result = await Promise.race([
    childResult(child),
    sleep(8_000).then(() => { child.kill(); throw new Error('recovery-launcher-exit-timeout') }),
  ])
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
})

test('normal launcher constructs an exact recovery request when the durable journal exists', async (t) => {
  const fixture = makePortableFixture(t)
  const updateDir = path.join(fixture.dataRoot, 'updates')
  const journalPath = path.join(updateDir, 'journal.json')
  const requestPath = path.join(updateDir, 'active-request.json')
  const markerPath = path.join(updateDir, 'recovery-marker.json')
  fs.mkdirSync(path.join(fixture.dataRoot, 'storage'), { recursive: true })
  fs.mkdirSync(path.join(fixture.dataRoot, 'backups'), { recursive: true })
  fs.mkdirSync(updateDir, { recursive: true })
  fs.writeFileSync(journalPath, '{}\n')
  fs.writeFileSync(path.join(fixture.root, 'current.json'), '{broken-current\n')
  fs.writeFileSync(path.join(fixture.appDir, 'scripts', 'crown-update-apply.mjs'), `
    import fs from 'node:fs'
    const requestPath = process.argv[process.argv.indexOf('--request') + 1]
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
    if (request.operation !== 'recover') process.exit(91)
    fs.writeFileSync(${JSON.stringify(path.join(fixture.root, 'current.json'))}, JSON.stringify({ schemaVersion: 1, version: '0.1.0' }) + '\\n')
    fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ operation: request.operation, requestPath, candidateIdentity: request.candidateIdentity }))
  `)
  fs.writeFileSync(requestPath, `${JSON.stringify({
    schemaVersion: 1, operation: 'apply', installationId: 'install-fixture', updateId: 'update-recover-journal',
    previousVersion: '0.1.0', candidateVersion: '0.2.0', expectedVersion: '0.2.0',
    dataRoot: fixture.dataRoot, journalPath,
    dbPath: path.join(fixture.dataRoot, 'storage', 'crown.sqlite'),
    backupPath: path.join(fixture.dataRoot, 'backups', 'update-recover-journal.sqlite'),
    appRoot: fixture.root, currentPath: path.join(fixture.root, 'current.json'),
    candidateIdentity: { dev: '0', ino: '0' },
    oldProcess: {
      pid: 999999, processStartTime: '2026-07-13T08:00:00.000Z', installationId: 'install-fixture',
      processInstanceId: 'N'.repeat(43), probeToken: 'P'.repeat(43),
    },
  })}\n`)
  const child = launchStart(fixture)
  const statePath = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  try { await waitFor(() => fs.existsSync(statePath) && readJson(statePath)) } catch (error) {
    child.kill()
    const result = await childResult(child)
    assert.fail(`recovery-launch-failed:${error.message}\n${result.stdout}\n${result.stderr}`)
  }
  const marker = readJson(markerPath)
  assert.equal(marker.operation, 'recover')
  assert.match(path.basename(marker.requestPath), /^recovery-request-/)
  assert.deepEqual(marker.candidateIdentity, { dev: '0', ino: '0' })
  const stop = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), {
    env: launcherEnv(fixture), extra: ['-StopTimeoutSeconds', '5'],
  })
  assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`)
  const result = await childResult(child)
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
})

test('launcher fails closed on malformed canonical current metadata before starting bundled Node', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-bad-current-'))
  try {
    copyTree(packagingRoot, root)
    fs.writeFileSync(path.join(root, 'current.json'), '{"schemaVersion":1,"version":"..\\\\outside"}\n')
    fs.mkdirSync(path.join(root, 'data'))
    const result = await runPowerShell(path.join(root, 'launcher', 'start.ps1'), {
      env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: path.join(root, 'data') },
      extra: ['-NoBrowser'],
    })
    assert.notEqual(result.code, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /launcher-current-invalid/)
    assert.equal(fs.existsSync(path.join(root, 'versions', 'outside')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('launcher starts from a foreign cwd and Chinese path, falls back from 8787, reuses the exact instance, and stops gracefully', async (t) => {
  const fixture = makePortableFixture(t)
  let blocker
  let ownsPort8787 = false
  try {
    blocker = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, app: 'not-crown-dashboard' }))
    })
    ownsPort8787 = await new Promise((resolve, reject) => {
      blocker.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error))
      blocker.listen(8787, '127.0.0.1', () => resolve(true))
    })

    const first = launchStart(fixture)
    const firstResultPromise = childResult(first)
    const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
    const state = await Promise.race([
      waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 }),
      firstResultPromise.then((result) => { throw new Error(`launcher-exited-before-state:${result.code}\n${result.stdout}\n${result.stderr}`) }),
    ])
    assert.equal(state.schemaVersion, 1)
    assert.deepEqual(Object.keys(state).sort(), ['installationId', 'launchNonce', 'pid', 'port', 'processStartTime', 'schemaVersion', 'stopToken', 'version'])
    assert.equal(state.installationId, 'install-fixture')
    assert.equal(state.version, fixture.version)
    if (ownsPort8787) assert.notEqual(state.port, 8787)
    else assert.equal(Number.isSafeInteger(state.port) && state.port > 0, true)
    assert.equal(Number.isSafeInteger(state.pid) && state.pid > 0, true)
    assert.equal(new Date(state.processStartTime).toISOString(), state.processStartTime)
    assert.match(state.launchNonce, /^[A-Za-z0-9_-]{43}$/)
    assert.match(state.stopToken, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(state.launchNonce, state.stopToken)

    const health = await (await fetch(`http://127.0.0.1:${state.port}/api/health`)).json()
    assert.equal(health.installationId, state.installationId)
    assert.equal(health.launchNonce, state.launchNonce)
    assert.equal(health.launcherPid, state.pid)
    assert.equal(health.launcherProcessStartTime, state.processStartTime)
    const startup = readJson(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json'))
    assert.equal(startup.appRoot, fixture.root)
    assert.equal(startup.appDir, fixture.appDir)
    assert.equal(startup.dataRoot, fixture.dataRoot)
    assert.equal(startup.node.toLowerCase(), path.join(fixture.root, 'versions', fixture.version, 'runtime', 'node', 'node.exe').toLowerCase())
    assert.equal(startup.watcherAutostart, '0')
    assert.equal(startup.workerAutostart, '0')

    const reused = await runPowerShell(path.join(fixture.root, 'launcher', 'start.ps1'), {
      env: launcherEnv(fixture),
      extra: ['-NoBrowser'],
    })
    assert.equal(reused.code, 0, `${reused.stdout}\n${reused.stderr}`)
    assert.match(reused.stdout, /launcher-reused/)
    assert.equal(readJson(stateFile).pid, state.pid)

    const stop = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), {
      env: launcherEnv(fixture),
    })
    assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`)
    assert.match(stop.stdout, /launcher-stopped/)
    const firstResult = await firstResultPromise
    assert.equal(firstResult.code, 0, `${firstResult.stdout}\n${firstResult.stderr}`)
    assert.equal(fs.readFileSync(path.join(fixture.dataRoot, 'runtime', 'fake-shutdown.txt'), 'utf8'), 'ordered')
    assert.equal(fs.existsSync(stateFile), false)
  } finally {
    if (blocker?.listening) await new Promise((resolve) => blocker.close(resolve))
  }
})

test('crash-releasing OS mutex serializes concurrent starts to one child and one healthy reuse', async (t) => {
  const fixture = makePortableFixture(t)
  const first = launchStart(fixture)
  const second = launchStart(fixture)
  const firstResult = childResult(first)
  const secondResult = childResult(second)
  const startsFile = path.join(fixture.dataRoot, 'runtime', 'fake-starts.jsonl')
  const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  let starts = []
  let stopResult
  try {
    await waitFor(() => fs.existsSync(stateFile) && fs.existsSync(startsFile), { timeoutMs: 25_000 })
    await sleep(1000)
    starts = fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } finally {
    stopResult = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
    for (const item of starts) {
      if (item.pid === process.pid) throw new Error('unsafe-test-pid')
      try { process.kill(item.pid, 0); process.kill(item.pid) } catch {}
    }
  }
  const results = await Promise.all([firstResult, secondResult])
  assert.equal(starts.length, 1)
  assert.equal(stopResult.code, 0, `${stopResult.stdout}\n${stopResult.stderr}`)
  assert.equal(results.filter((item) => /launcher-started/.test(item.stdout)).length, 1, JSON.stringify(results))
  assert.equal(results.filter((item) => /launcher-reused/.test(item.stdout)).length, 1, JSON.stringify(results))
})

test('OS mutex is abandoned automatically when the launcher process crashes and the live wrapper remains reusable', async (t) => {
  const fixture = makePortableFixture(t)
  const first = launchStart(fixture)
  const firstResult = childResult(first)
  const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  const state = await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 })
  assert.equal(first.kill(), true)
  await firstResult

  const reused = await runPowerShell(path.join(fixture.root, 'launcher', 'start.ps1'), {
    env: launcherEnv(fixture),
    extra: ['-NoBrowser'],
  })
  assert.equal(reused.code, 0, `${reused.stdout}\n${reused.stderr}`)
  assert.match(reused.stdout, /launcher-reused/)
  assert.equal(readJson(stateFile).pid, state.pid)

  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
})

test('wrapper exits when its exact launcher parent dies before state publication, then one clean restart succeeds', async (t) => {
  const fixture = makePortableFixture(t, { dashboard: 'sync-block' })
  const first = launchStart(fixture, ['-HealthTimeoutSeconds', '20'])
  const firstResult = childResult(first)
  const runtimeDir = path.join(fixture.dataRoot, 'runtime')
  const startsFile = path.join(runtimeDir, 'fake-starts.jsonl')
  const stateFile = path.join(runtimeDir, 'launcher-state.json')
  let oldPid
  let restarted
  try {
    const starts = await waitFor(() => fs.existsSync(startsFile)
      && fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), { timeoutMs: 25_000 })
    oldPid = starts[0].pid
    assert.equal(fs.existsSync(stateFile), false)
    assert.equal(first.kill(), true)
    await firstResult

    restarted = launchStart(fixture)
    const restartedResult = childResult(restarted)
    const orphanOutcome = await waitFor(() => {
      const activeMaxFile = path.join(runtimeDir, 'fake-active-max.txt')
      if (fs.existsSync(activeMaxFile) && Number(fs.readFileSync(activeMaxFile, 'utf8')) > 1) return 'overlap'
      if (fs.readdirSync(runtimeDir).some((name) => name.startsWith('.launcher-abort-') && name.endsWith('.json'))) return 'abort'
      return false
    }, { timeoutMs: 10_000 })
    assert.equal(orphanOutcome, 'abort')
    assert.equal(fs.readFileSync(path.join(runtimeDir, 'fake-active-max.txt'), 'utf8'), '1')
    fs.writeFileSync(path.join(runtimeDir, 'fake-sync-release.txt'), 'release')

    await waitFor(() => !isProcessAlive(oldPid), { timeoutMs: 8_000 })
    assert.equal(fs.existsSync(stateFile), false)
    assert.equal(fs.readFileSync(path.join(runtimeDir, 'fake-shutdown.txt'), 'utf8'), 'ordered')

    const state = await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 })
    const allStarts = fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(allStarts.length, 2)
    assert.equal(state.pid, allStarts[1].pid)
    assert.notEqual(state.pid, oldPid)
    assert.equal(isProcessAlive(oldPid), false)
    await waitFor(() => fs.readdirSync(runtimeDir).filter((name) => name.startsWith('launcher-startup-claim')).length === 0)

    const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
    assert.equal((await restartedResult).code, 0)
  } finally {
    if (first.exitCode === null) first.kill()
    if (oldPid && isProcessAlive(oldPid)) {
      try { process.kill(oldPid) } catch {}
    }
    if (restarted?.exitCode === null) restarted.kill()
    if (fs.existsSync(startsFile)) {
      for (const item of fs.readFileSync(startsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) {
        if (item.pid !== process.pid && isProcessAlive(item.pid)) {
          try { process.kill(item.pid) } catch {}
        }
      }
    }
  }
})

test('reserved pre-child claim recovers when its exact parent dies before launch authorization', async (t) => {
  const fixture = makePortableFixture(t)
  const runtimeDir = path.join(fixture.dataRoot, 'runtime')
  const claimFile = path.join(runtimeDir, 'launcher-startup-claim.json')
  const first = launchStart(fixture)
  const firstResult = childResult(first)
  await waitFor(() => {
    if (!fs.existsSync(claimFile)) return false
    const claim = readJson(claimFile)
    return claim.status === 'reserved' && claim.childLaunchAuthorized === false
  }, { timeoutMs: 25_000, intervalMs: 1 })
  assert.equal(first.kill(), true)
  await firstResult

  const restarted = launchStart(fixture)
  const restartedResult = childResult(restarted)
  const stateFile = path.join(runtimeDir, 'launcher-state.json')
  await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 })
  const starts = fs.readFileSync(path.join(runtimeDir, 'fake-starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(starts.length, 1)
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'fake-active-max.txt'), 'utf8'), '1')
  await waitFor(() => !fs.existsSync(claimFile))
  assert.equal(fs.readdirSync(runtimeDir).some((name) => name.startsWith('.launcher-backup-')), false)
  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  assert.equal((await restartedResult).code, 0)
})

test('reserved post-Process.Start claim is cleaned by its bound wrapper before immediate restart', async (t) => {
  const fixture = makePortableFixture(t)
  const runtimeDir = path.join(fixture.dataRoot, 'runtime')
  const claimFile = path.join(runtimeDir, 'launcher-startup-claim.json')
  const first = launchStart(fixture)
  const firstResult = childResult(first)
  await waitFor(() => {
    if (!fs.existsSync(claimFile)) return false
    const claim = readJson(claimFile)
    return claim.status === 'reserved' && claim.childLaunchAuthorized === true && claim.childProcessStartReturned === true
  }, { timeoutMs: 25_000, intervalMs: 1 })
  assert.equal(first.kill(), true)
  await firstResult

  const restarted = launchStart(fixture)
  const restartedResult = childResult(restarted)
  const stateFile = path.join(runtimeDir, 'launcher-state.json')
  await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 })
  const starts = fs.readFileSync(path.join(runtimeDir, 'fake-starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(starts.length, 1)
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'fake-active-max.txt'), 'utf8'), '1')
  await waitFor(() => !fs.existsSync(claimFile))
  assert.equal(fs.readdirSync(runtimeDir).some((name) => name.startsWith('.launcher-backup-')), false)
  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  assert.equal((await restartedResult).code, 0)
})

test('startup claim fails closed on corruption, multiple claims and tampering, but reclaims an expired PID-reuse snapshot', async (t) => {
  const fixture = makePortableFixture(t)
  const runtimeDir = path.join(fixture.dataRoot, 'runtime')
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.mkdirSync(path.join(fixture.dataRoot, 'config'), { recursive: true })
  fs.mkdirSync(path.join(fixture.dataRoot, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(fixture.dataRoot, 'installation.json'), JSON.stringify({ schemaVersion: 1, installationId: 'install-fixture' }) + '\n')
  const claimFile = path.join(runtimeDir, 'launcher-startup-claim.json')
  const token = () => randomBytes(32).toString('base64url')
  const validClaim = {
    schemaVersion: 1,
    status: 'active',
    installationId: 'install-fixture',
    version: fixture.version,
    pid: process.pid,
    processStartTime: '2000-01-01T00:00:00.000Z',
    launchNonce: token(),
    stopToken: token(),
    parentPid: process.pid,
    parentProcessStartTime: '2000-01-01T00:00:00.000Z',
    parentLeasePath: path.join(runtimeDir, '.launcher-parent-stale.json'),
    parentLeaseToken: token(),
    abortPath: path.join(runtimeDir, '.launcher-abort-stale.json'),
  }
  const validReserved = {
    schemaVersion: 1,
    status: 'reserved',
    installationId: 'install-fixture',
    version: fixture.version,
    parentPid: process.pid,
    parentProcessStartTime: '2000-01-01T00:00:00.000Z',
    launchNonce: token(),
    parentLeasePath: path.join(runtimeDir, '.launcher-parent-reserved.json'),
    parentLeaseToken: token(),
    abortPath: path.join(runtimeDir, '.launcher-abort-reserved.json'),
    childLaunchAuthorized: false,
    childProcessStartReturned: false,
  }

  fs.writeFileSync(validReserved.parentLeasePath, JSON.stringify({
    schemaVersion: 1,
    parentPid: validReserved.parentPid,
    parentProcessStartTime: validReserved.parentProcessStartTime,
    launchNonce: validReserved.launchNonce,
    leaseToken: validReserved.parentLeaseToken,
  }) + '\n')
  fs.writeFileSync(claimFile, JSON.stringify(validReserved) + '\n')
  const recoveredReserved = launchStart(fixture)
  const recoveredReservedResult = childResult(recoveredReserved)
  const recoveredStateFile = path.join(runtimeDir, 'launcher-state.json')
  await Promise.race([
    waitFor(() => fs.existsSync(recoveredStateFile) && readJson(recoveredStateFile), { timeoutMs: 25_000 }),
    recoveredReservedResult.then((result) => { throw new Error(`reserved-recovery-exited:${result.code}\n${result.stdout}\n${result.stderr}`) }),
  ])
  const recoveredStop = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(recoveredStop.code, 0, `${recoveredStop.stdout}\n${recoveredStop.stderr}`)
  assert.equal((await recoveredReservedResult).code, 0)

  fs.writeFileSync(claimFile, '{broken')
  const corrupt = await runPowerShell(path.join(fixture.root, 'launcher', 'start.ps1'), { env: launcherEnv(fixture), extra: ['-NoBrowser'] })
  assert.notEqual(corrupt.code, 0)
  assert.match(`${corrupt.stdout}\n${corrupt.stderr}`, /launcher-startup-claim-invalid/)

  fs.writeFileSync(claimFile, JSON.stringify(validClaim) + '\n')
  fs.writeFileSync(path.join(runtimeDir, 'launcher-startup-claim-extra.json'), JSON.stringify(validClaim) + '\n')
  const multiple = await runPowerShell(path.join(fixture.root, 'launcher', 'start.ps1'), { env: launcherEnv(fixture), extra: ['-NoBrowser'] })
  assert.notEqual(multiple.code, 0)
  assert.match(`${multiple.stdout}\n${multiple.stderr}`, /launcher-startup-claim-multiple/)
  fs.rmSync(path.join(runtimeDir, 'launcher-startup-claim-extra.json'))

  fs.writeFileSync(claimFile, JSON.stringify({ ...validClaim, abortPath: path.join(fixture.root, 'outside-abort.json') }) + '\n')
  const outside = await runPowerShell(path.join(fixture.root, 'launcher', 'start.ps1'), { env: launcherEnv(fixture), extra: ['-NoBrowser'] })
  assert.notEqual(outside.code, 0)
  assert.match(`${outside.stdout}\n${outside.stderr}`, /launcher-startup-claim-path-outside-runtime/)

  fs.writeFileSync(claimFile, JSON.stringify(validClaim) + '\n')
  const restarted = launchStart(fixture)
  const resultPromise = childResult(restarted)
  const stateFile = path.join(runtimeDir, 'launcher-state.json')
  await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 })
  assert.equal(isProcessAlive(process.pid), true)
  await waitFor(() => !fs.existsSync(claimFile))
  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  assert.equal((await resultPromise).code, 0)
})

test('launcher strips inherited CROWN and Node/OpenSSL injection environment before every bundled Node call', async (t) => {
  const fixture = makePortableFixture(t)
  const toxicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-toxic-env-'))
  t.after(() => fs.rmSync(toxicRoot, { recursive: true, force: true }))
  const preloadMarker = path.join(toxicRoot, 'preload-ran.txt')
  const preloadFile = path.join(toxicRoot, 'preload.cjs')
  const emptyFile = path.join(toxicRoot, 'empty.pem')
  fs.writeFileSync(preloadFile, `require('node:fs').appendFileSync(${JSON.stringify(preloadMarker)}, process.argv.join(' ') + '\\n')\n`)
  fs.writeFileSync(emptyFile, '')
  const toxic = {
    CROWN_SECRET_KEY: 'must-not-leak',
    CROWN_BETTING_ALLOWED_ORIGINS: 'https://attacker.invalid',
    CROWN_REAL_MAX_TOTAL_MINOR: '999999999',
    CROWN_REAL_CURRENCY: 'EVIL',
    CROWN_REAL_AMOUNT_SCALE: '99',
    CROWN_BETTING_MODE: 'real',
    CROWN_WATCHER_AUTOSTART: '1',
    CROWN_BETTING_WORKER_AUTOSTART: '1',
    NODE_OPTIONS: `--require=${preloadFile}`,
    NODE_PATH: toxicRoot,
    NODE_EXTRA_CA_CERTS: emptyFile,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    OPENSSL_CONF: emptyFile,
    SSLKEYLOGFILE: path.join(toxicRoot, 'tls-keys.log'),
  }
  const started = launchStart(fixture, [], toxic)
  const resultPromise = childResult(started)
  const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  const state = await Promise.race([
    waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 25_000 }),
    resultPromise.then((result) => { throw new Error(`launcher-exited-before-state:${result.code}\n${result.stdout}\n${result.stderr}`) }),
  ])

  assert.equal(fs.existsSync(preloadMarker), false)
  const initializerEnv = readJson(path.join(fixture.dataRoot, 'runtime', 'initializer-env.json'))
  const wrapperEnv = readJson(path.join(fixture.dataRoot, 'runtime', 'fake-startup.json')).inherited
  for (const snapshot of [initializerEnv, wrapperEnv]) {
    assert.equal(snapshot.CROWN_SECRET_KEY, null)
    assert.equal(snapshot.CROWN_BETTING_ALLOWED_ORIGINS, null)
    assert.equal(snapshot.CROWN_REAL_MAX_TOTAL_MINOR, null)
    assert.equal(snapshot.CROWN_REAL_CURRENCY, null)
    assert.equal(snapshot.CROWN_REAL_AMOUNT_SCALE, null)
    assert.equal(snapshot.CROWN_BETTING_MODE, 'off')
    assert.equal(snapshot.NODE_OPTIONS, null)
    assert.equal(snapshot.NODE_PATH, null)
    assert.equal(snapshot.NODE_EXTRA_CA_CERTS, null)
    assert.equal(snapshot.NODE_TLS_REJECT_UNAUTHORIZED, null)
    assert.equal(snapshot.OPENSSL_CONF, null)
    assert.equal(snapshot.SSLKEYLOGFILE, null)
  }

  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  assert.equal((await resultPromise).code, 0)
  assert.equal(state.installationId, 'install-fixture')
})

test('stop refuses PID start-time reuse and malformed state without terminating any process', async (t) => {
  const fixture = makePortableFixture(t)
  const first = launchStart(fixture)
  const resultPromise = childResult(first)
  const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  const state = await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile))

  const wrongTime = { ...state, processStartTime: '2000-01-01T00:00:00.000Z' }
  fs.writeFileSync(stateFile, `${JSON.stringify(wrongTime)}\n`)
  const refused = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.notEqual(refused.code, 0)
  assert.match(`${refused.stdout}\n${refused.stderr}`, /launcher-process-(?:identity-mismatch|not-running)/)
  if (isProcessAlive(state.pid)) assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/health`)).status, 200)

  fs.writeFileSync(stateFile, '{broken-json')
  const malformed = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.notEqual(malformed.code, 0)
  assert.match(`${malformed.stdout}\n${malformed.stderr}`, /launcher-state-invalid/)
  if (isProcessAlive(state.pid)) assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/health`)).status, 200)

  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`)
  const wasAliveBeforeStop = isProcessAlive(state.pid)
  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  if (wasAliveBeforeStop) assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  else assert.match(`${stopped.stdout}\n${stopped.stderr}`, /launcher-process-not-running/)
  assert.equal((await resultPromise).code, 0)
})

test('launcher retries a raced EADDRINUSE with a fresh loopback port and bounded new identity', async (t) => {
  const fixture = makePortableFixture(t, { dashboard: 'port-race' })
  const started = launchStart(fixture)
  const resultPromise = childResult(started)
  const stateFile = path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')
  const state = await waitFor(() => fs.existsSync(stateFile) && readJson(stateFile), { timeoutMs: 20_000 })
  assert.equal(fs.readFileSync(path.join(fixture.dataRoot, 'runtime', 'fake-port-attempts.txt'), 'utf8'), '2')
  const starts = fs.readFileSync(path.join(fixture.dataRoot, 'runtime', 'fake-starts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].nonce, state.launchNonce)
  const stopped = await runPowerShell(path.join(fixture.root, 'launcher', 'stop.ps1'), { env: launcherEnv(fixture) })
  assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`)
  assert.equal((await resultPromise).code, 0)
})

test('health timeout fails without publishing launcher state or leaving its fake child alive', async (t) => {
  const fixture = makePortableFixture(t, { dashboard: 'hanging' })
  const child = launchStart(fixture, ['-HealthTimeoutSeconds', '2'])
  const result = await childResult(child)
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /launcher-health-timeout/)
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, 'runtime', 'launcher-state.json')), false)
  const pid = Number(fs.readFileSync(path.join(fixture.dataRoot, 'runtime', 'fake-hanging-pid.txt'), 'utf8'))
  assert.throws(() => process.kill(pid, 0))
})
