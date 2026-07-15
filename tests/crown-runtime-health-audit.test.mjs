import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const script = path.join(root, 'scripts', 'crown-runtime-health-audit.mjs')
const lockedChromium = process.env.CROWN_CHROMIUM_EXECUTABLE_PATH?.trim() || ''
const moduleUrl = pathToFileURL(script).href
let imported

async function auditModule() {
  imported ||= import(moduleUrl)
  return imported
}

function spawnResult(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function runAudit({ args = [], env = {} } = {}) {
  return spawnResult(process.execPath, [
    script, '--fixture', '--desktop', '1440x900', '--mobile', '390x844', ...args,
  ], { env: { ...process.env, ...env } })
}

function assertDirectoryEmpty(directory) {
  assert.deepEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], [])
}

test('health audit module is import-safe for focused unit tests', async () => {
  const result = await spawnResult(process.execPath, [
    '--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)})`,
  ])
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' })
})

test('structural guard requires production entries and rejects self-certified health fixtures', () => {
  const source = fs.readFileSync(script, 'utf8')
  for (const required of [
    'scripts/crown-dashboard.mjs',
    'scripts/crown-watch.mjs',
    'scripts/crown-betting-worker.mjs',
    '/api/app/operations-summary',
  ]) assert.equal(source.includes(required), true, required)
  for (const forbidden of ['dashboardHtml', 'runFixtureChild', "'/api/health'", 'browser.isConnected']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  assert.doesNotMatch(source, /capabilityReadyCount\s*:\s*8\b/)
})

test('locked Chromium contract fails closed without using a Playwright cache fallback', async t => {
  const { chromiumExecutable } = await auditModule()
  assert.equal(typeof chromiumExecutable, 'function')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown health chromium contract '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fakeChrome = path.join(dir, 'chrome.exe')
  fs.writeFileSync(fakeChrome, '')

  assert.throws(() => chromiumExecutable({ env: {} }), /runtime-health-chromium-required/)
  assert.throws(() => chromiumExecutable({ env: { CROWN_CHROMIUM_EXECUTABLE_PATH: process.execPath } }), /runtime-health-chromium-invalid/)
  assert.throws(() => chromiumExecutable({ env: { CROWN_CHROMIUM_EXECUTABLE_PATH: path.join(dir, 'missing', 'chrome.exe') } }), /runtime-health-chromium-invalid/)
  assert.equal(chromiumExecutable({ env: { CROWN_CHROMIUM_EXECUTABLE_PATH: fakeChrome } }), path.resolve(fakeChrome))
})

test('audit CLI rejects missing explicit Chromium without leaking a path', async () => {
  const result = await runAudit({ env: { CROWN_CHROMIUM_EXECUTABLE_PATH: '' } })
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /runtime-health-chromium-required/)
  assert.doesNotMatch(result.stderr, /[A-Za-z]:\\|Users[\\/]/i)
})

test('isolated child environment discards inherited Crown state and Node preload hooks', async () => {
  const { isolatedChildBaseEnvironment } = await auditModule()
  assert.equal(typeof isolatedChildBaseEnvironment, 'function')
  assert.deepEqual(isolatedChildBaseEnvironment({
    PATH: 'safe-path',
    SystemRoot: 'safe-root',
    CROWN_DB_PATH: 'user-database',
    crown_runtime_dir: 'user-runtime',
    NODE_OPTIONS: '--import=user-hook.mjs',
  }), {
    PATH: 'safe-path',
    SystemRoot: 'safe-root',
  })
})

test('actual Operations projection never turns 7/8 or missing reconciliation into 8/8', async () => {
  const { projectOperationsSummary } = await auditModule()
  assert.equal(typeof projectOperationsSummary, 'function')
  const directions = Array.from({ length: 8 }, (_, index) => ({
    key: `direction-${index}`,
    previewAllowed: true,
    submitAllowed: true,
    reconciliationAllowed: true,
  }))
  const summary = {
    browserBetting: { transportKind: 'browser-page-fetch', directions, campaign: null },
    batches: { unknownAmountMinor: 0 },
    accounts: { unknown: 0 },
    reconciliation: { open: 0 },
  }

  assert.deepEqual(projectOperationsSummary(summary), {
    transportReady: true,
    capabilityReadyCount: 8,
    unknownCount: 0,
  })
  assert.equal(projectOperationsSummary({
    ...summary,
    browserBetting: { ...summary.browserBetting, directions: directions.slice(0, 7) },
  }).capabilityReadyCount, 7)
  assert.equal(projectOperationsSummary({
    ...summary,
    browserBetting: {
      ...summary.browserBetting,
      directions: directions.map((item, index) => index === 3 ? { ...item, reconciliationAllowed: false } : item),
    },
  }).capabilityReadyCount, 7)
})

test('actual Operations projection preserves every nonzero unknown source', async () => {
  const { projectOperationsSummary } = await auditModule()
  assert.equal(typeof projectOperationsSummary, 'function')
  const summary = {
    browserBetting: { transportKind: 'browser-page-fetch', directions: [], campaign: { unknownCount: 4 } },
    batches: { unknownAmountMinor: 1 },
    accounts: { unknown: 2 },
    reconciliation: { open: 3 },
  }
  const result = projectOperationsSummary(summary)
  assert.equal(result.unknownCount, 10)
  assert.equal(projectOperationsSummary({ ...summary, accounts: {} }).unknownCount, -1)
  assert.equal(projectOperationsSummary({
    ...summary,
    browserBetting: { ...summary.browserBetting, campaign: {} },
  }).unknownCount, -1)
})

test('actual Operations mode readiness requires both configured watcher modes', async () => {
  const { operationsMonitorModesReady } = await auditModule()
  const readyMode = {
    enabled: true,
    reviewRequired: false,
    markets: { asianHandicap: true, total: false },
  }
  const summary = { monitorAlerts: { prematch: readyMode, live: readyMode } }
  assert.equal(operationsMonitorModesReady(summary), true)
  assert.equal(operationsMonitorModesReady({
    monitorAlerts: { ...summary.monitorAlerts, live: { ...readyMode, enabled: false } },
  }), false)
  assert.equal(operationsMonitorModesReady({
    monitorAlerts: {
      ...summary.monitorAlerts,
      prematch: { ...readyMode, reviewRequired: true },
    },
  }), false)
  assert.equal(operationsMonitorModesReady({
    monitorAlerts: {
      ...summary.monitorAlerts,
      live: { ...readyMode, markets: { asianHandicap: false, total: false } },
    },
  }), false)
  assert.equal(operationsMonitorModesReady({ monitorAlerts: { prematch: readyMode } }), false)
})

test('network bootstrap blocks a non-synthetic URL before any network access', async t => {
  const { networkBootstrapSource } = await auditModule()
  assert.equal(typeof networkBootstrapSource, 'function')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown health network bootstrap '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bootstrap = path.join(dir, 'network-bootstrap.mjs')
  const logPath = path.join(dir, 'network-decisions.log')
  fs.writeFileSync(bootstrap, networkBootstrapSource(), 'utf8')

  const result = await spawnResult(process.execPath, [
    '--import', pathToFileURL(bootstrap).href,
    '--input-type=module',
    '-e', "fetch('https://must-not-resolve.invalid/').catch(error => process.stdout.write(error.message))",
  ], {
    env: {
      ...process.env,
      CROWN_RUNTIME_HEALTH_SYNTHETIC_ORIGIN: 'https://runtime-health.crown-audit.net',
      CROWN_RUNTIME_HEALTH_FIXTURE_ORIGIN: 'http://127.0.0.1:9',
      CROWN_RUNTIME_HEALTH_NETWORK_LOG: logPath,
    },
  })

  assert.deepEqual(result, { code: 0, stdout: 'runtime-health-network-blocked', stderr: '' })
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'DENY\n')
})

test('owned Chromium tracking reports a persistent exact process and fails closed on query error', async () => {
  const { captureOwnedChromiumTree, waitForOwnedChromiumExit } = await auditModule()
  assert.equal(typeof captureOwnedChromiumTree, 'function')
  assert.equal(typeof waitForOwnedChromiumExit, 'function')
  const executablePath = 'C:\\locked\\chrome.exe'
  const marker = 'audit-owner-guid'
  const rootProcess = {
    pid: 2101,
    parentProcessId: 100,
    executablePath,
    creationDate: '2026-07-15T00:00:00.000Z',
    commandLine: `chrome.exe --crown-runtime-health-owner=${marker}`,
  }
  const childProcess = {
    pid: 2102,
    parentProcessId: 2101,
    executablePath,
    creationDate: '2026-07-15T00:00:01.000Z',
    commandLine: 'chrome.exe --type=utility',
  }
  const owned = captureOwnedChromiumTree([rootProcess, childProcess], { marker, executablePath })
  assert.deepEqual(owned.map(item => item.pid).sort(), [2101, 2102])
  assert.equal((await waitForOwnedChromiumExit({
    ownedProcesses: owned,
    snapshot: async () => [rootProcess, childProcess],
    timeoutMs: 0,
    pollMs: 0,
  })).length, 2)
  await assert.rejects(() => waitForOwnedChromiumExit({
    ownedProcesses: owned,
    snapshot: async () => { throw new Error('cim unavailable') },
    timeoutMs: 0,
    pollMs: 0,
  }), /runtime-health-process-query-failed/)
})

test('ledger inspection fails closed when the isolated database is missing', async () => {
  const { readRuntimeLeases, readAccountLockCount } = await auditModule()
  const missing = path.join(os.tmpdir(), `crown-health-missing-${process.pid}-${Date.now()}`, 'crown.sqlite')
  assert.throws(() => readRuntimeLeases(missing), /runtime-health-ledger-check-failed/)
  assert.throws(() => readAccountLockCount(missing), /runtime-health-ledger-check-failed/)
})

test('post-start failure cleans isolated runtime state and owned processes', {
  timeout: 120_000,
  skip: !lockedChromium || !fs.existsSync(lockedChromium),
}, async t => {
  assert.equal(path.basename(lockedChromium).toLowerCase(), 'chrome.exe')
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-health-cleanup-test-'))
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }))

  const result = await runAudit({
    args: ['--mobile', '80x200'],
    env: { CROWN_RUNTIME_HEALTH_TEMP_PARENT: tempParent },
  })

  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /runtime-health-(?:worker-restart|audit)-failed/)
  assertDirectoryEmpty(tempParent)
  const { windowsProcessSnapshot } = await auditModule()
  assert.deepEqual(await windowsProcessSnapshot({ marker: tempParent }), [])
})
