import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import * as dashboardRuntime from '../scripts/crown-dashboard.mjs'
import { argumentsFrom as bettingWorkerArguments } from '../scripts/crown-betting-worker.mjs'
import { browserLaunchOptions, parseArgs as parseWatcherArgs } from '../scripts/crown-watch.mjs'
import { APP_CONTRACT_VERSION } from '../src/crown/app/app-contract-version.mjs'
import { APP_VERSION } from '../src/crown/app/app-version.mjs'
import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createBettingProcessController } from '../src/crown/app/betting-process.mjs'
import { createMonitorProcessController } from '../src/crown/app/monitor-process.mjs'
import { previewRuntimeCleanup, runRuntimeCleanup } from '../src/crown/app/runtime-cache-cleanup.mjs'
import { readDashboardData } from '../src/crown/dashboard/dashboard-data.mjs'
import { portableEnvironment, resolvePortablePaths } from '../src/crown/runtime/portable-paths.mjs'

const WATCH_SCRIPT = fileURLToPath(new URL('../scripts/crown-watch.mjs', import.meta.url))
const { startCrownDashboard, shutdownDashboardRuntime } = dashboardRuntime
const ENTRYPOINT_URLS = [
  new URL('../scripts/crown-dashboard.mjs', import.meta.url).href,
  new URL('../scripts/crown-watch.mjs', import.meta.url).href,
  new URL('../scripts/crown-betting-worker.mjs', import.meta.url).href,
]

function portableFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const paths = resolvePortablePaths({
    appRoot: path.join(root, 'CrownMonitor'),
    dataRoot: path.join(root, 'data'),
    version: APP_VERSION,
    env: {},
  })
  fs.mkdirSync(paths.staticDir, { recursive: true })
  fs.writeFileSync(path.join(paths.staticDir, 'index.html'), '<!doctype html><title>Portable Crown</title>', 'utf8')
  return {
    root,
    paths,
    env: {
      ...process.env,
      ...portableEnvironment(paths),
      CROWN_INSTALLATION_ID: 'install-A',
      CROWN_DASHBOARD_HOST: '127.0.0.1',
      CROWN_DASHBOARD_PORT: '0',
      CROWN_DASHBOARD_ALLOWED_HOSTS: '',
      CROWN_DASHBOARD_ALLOWED_ORIGINS: '',
    },
  }
}

function longRunningSpawn(calls) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 9000 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true
      child.signalCode = signal
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    calls.push({ command, args, options, child })
    return child
  }
}

function readyBettingSpawn(calls) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 9100 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.send = () => {}
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true
      child.signalCode = signal
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    calls.push({ command, args, options, child })
    queueMicrotask(() => {
      const worker = args[args.indexOf('--worker-lease-key') + 1]
      const suffix = worker.slice('betting-worker:'.length)
      child.emit('message', {
        type: 'ready',
        generation: args[args.indexOf('--generation') + 1],
        nonce: args[args.indexOf('--ready-nonce') + 1],
        leases: {
          worker: { leaseKey: worker, ownerId: 'worker-owner', fencingToken: 1 },
          executor: { leaseKey: `betting-executor:${suffix}`, ownerId: 'executor-owner', fencingToken: 1 },
          reconciler: { leaseKey: `betting-reconciler:${suffix}`, ownerId: 'reconciler-owner', fencingToken: 1 },
        },
        browserStatus: { accounts: [] },
      })
    })
    return child
  }
}

test('Dashboard, watcher and worker entrypoints are import-safe', () => {
  const script = `await Promise.all(${JSON.stringify(ENTRYPOINT_URLS)}.map((url) => import(url))); process.stdout.write('imported')`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'imported')
})

test('Portable betting worker starts without development protocol fixtures', (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('.'), '.tmp-crown-worker-no-fixtures-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.cpSync(path.resolve('src'), path.join(root, 'src'), { recursive: true })
  fs.cpSync(path.resolve('scripts'), path.join(root, 'scripts'), { recursive: true })

  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'crown-betting-worker.mjs'), '--mode', 'off'], {
    cwd: root,
    env: { ...process.env, CROWN_BETTING_MODE: 'off' },
    encoding: 'utf8',
  })
  assert.equal(fs.existsSync(path.join(root, 'data', 'fixtures')), false)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'off', processed: 0, results: [] })
})

test('monitor and betting controllers spawn explicit binaries, scripts, config and runtime paths', async () => {
  const monitorCalls = []
  const watchScriptPath = 'D:\\App\\versions\\0.1.0\\app\\scripts\\crown-watch.mjs'
  const workerScriptPath = 'D:\\App\\versions\\0.1.0\\app\\scripts\\crown-betting-worker.mjs'
  const appDir = 'D:\\App\\versions\\0.1.0\\app'
  const nodeExe = 'D:\\App\\versions\\0.1.0\\runtime\\node\\node.exe'
  const dbPath = 'C:\\Data\\storage\\crown.sqlite'
  const runtimeDir = 'C:\\Data\\runtime'
  const configDir = 'C:\\Data\\config'
  const monitor = createMonitorProcessController({
    appDir, nodeExe, watchScriptPath, dbPath, runtimeDir, configDir,
    spawnCommand: longRunningSpawn(monitorCalls),
  })

  monitor.start()
  assert.equal(monitorCalls[0].command, nodeExe)
  assert.deepEqual(monitorCalls[0].args.slice(0, 5), [watchScriptPath, '--app-db', dbPath, '--runtime-dir', runtimeDir])
  assert.equal(monitorCalls[0].args[monitorCalls[0].args.indexOf('--league-config') + 1], path.win32.join(configDir, 'monitored-leagues.json'))
  assert.equal(monitorCalls[0].args[monitorCalls[0].args.indexOf('--default-leagues-config') + 1], path.win32.join(configDir, 'default-leagues.json'))
  assert.equal(monitorCalls[0].options.cwd, appDir)
  await monitor.stopAndWait()

  const bettingCalls = []
  const defaultLeaguesConfig = path.win32.join(configDir, 'default-leagues.json')
  const betting = createBettingProcessController({
    appDir, nodeExe, workerScriptPath, dbPath, runtimeDir, defaultLeaguesConfig,
    spawnCommand: readyBettingSpawn(bettingCalls),
  })
  await betting.start()
  assert.equal(bettingCalls[0].command, nodeExe)
  assert.equal(bettingCalls[0].args[0], workerScriptPath)
  assert.equal(bettingCalls[0].args[bettingCalls[0].args.indexOf('--runtime-dir') + 1], runtimeDir)
  assert.equal(bettingCalls[0].args[bettingCalls[0].args.indexOf('--default-leagues-config') + 1], defaultLeaguesConfig)
  assert.equal(bettingCalls[0].options.cwd, appDir)
  await betting.stop()
})

test('Portable watcher reconstructs the full graph and rejects a tampered system Chromium path', (t) => {
  const fixture = portableFixture(t)
  const portable = parseWatcherArgs([], {
    env: {
      ...fixture.env,
      CROWN_BROWSER_CHANNEL: 'msedge',
    },
  })
  assert.equal(portable.chromiumExecutablePath, fixture.paths.chromiumExe)
  assert.equal(portable.channel, '')
  assert.equal(portable.runtimeDir, fixture.paths.runtimeDir)
  assert.deepEqual(browserLaunchOptions(portable), {
    headless: false,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-sandbox'],
    executablePath: fixture.paths.chromiumExe,
  })

  const development = parseWatcherArgs(['--channel', 'chrome'], { env: {} })
  assert.equal(development.channel, 'chrome')
  assert.equal(browserLaunchOptions(development).channel, 'chrome')
  assert.equal('executablePath' in browserLaunchOptions(development), false)
  assert.throws(() => parseWatcherArgs([], {
    env: { ...fixture.env, CROWN_CHROMIUM_EXECUTABLE_PATH: 'C:\\Program Files\\Microsoft\\Edge\\msedge.exe' },
  }), /portable-watcher-environment-mismatch:CROWN_CHROMIUM_EXECUTABLE_PATH/)
  assert.throws(() => parseWatcherArgs([], { env: { CROWN_PORTABLE: '1' } }), /portable/)
})

test('Portable watcher does not load a caller cwd .env file', (t) => {
  const { root, env } = portableFixture(t)
  const foreignCwd = path.join(root, 'foreign-cwd')
  fs.mkdirSync(foreignCwd)
  fs.writeFileSync(path.join(foreignCwd, '.env'), 'CROWN_MAX_GAME_MORE=-1\n', 'utf8')
  const result = spawnSync(process.execPath, [WATCH_SCRIPT, '--help'], {
    cwd: foreignCwd,
    env: { ...env, CROWN_MAX_GAME_MORE: '' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})

test('betting worker arguments take DB, runtime and config from explicit Portable inputs', () => {
  const options = bettingWorkerArguments([], {
    env: {
      CROWN_PORTABLE: '1',
      CROWN_BETTING_MODE: 'off',
      CROWN_APP_ROOT: 'D:\\App\\versions\\0.1.0\\app',
      CROWN_DATA_ROOT: 'C:\\Data',
      CROWN_DB_PATH: 'C:\\Data\\storage\\crown.sqlite',
      CROWN_RUNTIME_DIR: 'C:\\Data\\runtime',
      CROWN_BROWSER_PROFILE_DIR: 'C:\\Data\\runtime\\browser-profiles',
      CROWN_CHROMIUM_EXECUTABLE_PATH: 'D:\\App\\versions\\0.1.0\\runtime\\chromium\\chrome.exe',
      CROWN_DEFAULT_LEAGUES_CONFIG: 'C:\\Data\\config\\default-leagues.json',
    },
  })
  assert.equal(options.dbPath, 'C:\\Data\\storage\\crown.sqlite')
  assert.equal(options.runtimeDir, 'C:\\Data\\runtime')
  assert.equal(options.profileRoot, 'C:\\Data\\runtime\\browser-profiles')
  assert.equal(options.chromiumExecutable, 'D:\\App\\versions\\0.1.0\\runtime\\chromium\\chrome.exe')
  assert.equal(options.defaultLeaguesConfig, 'C:\\Data\\config\\default-leagues.json')
})

test('production dashboard data never falls back to bundled fixtures unless explicitly enabled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-no-fixture-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fixtureSnapshotPath = path.join(root, 'fixture.jsonl')
  fs.writeFileSync(fixtureSnapshotPath, `${JSON.stringify({
    provider: 'crown', mode: 'prematch', capturedAt: '2026-07-13T00:00:00.000Z',
    event: { eventKey: 'fixture-event', league: 'fixture', homeTeam: 'A', awayTeam: 'B' },
    market: { marketId: 'm1', marketType: 'asian_handicap', handicapRaw: '0' },
    selection: { selectionId: 's1', side: 'home', oddsRaw: '0.90' },
  })}\n`, 'utf8')

  const data = await readDashboardData({
    snapshotPath: path.join(root, 'missing-runtime.jsonl'),
    changesPath: path.join(root, 'missing-changes.jsonl'),
    fixtureSnapshotPath,
    configPath: path.join(root, 'missing-config.json'),
    dbPath: path.join(root, 'missing.sqlite'),
  })
  assert.notEqual(data.summary.source, 'fixture-replay')
  assert.equal(data.events.items.length, 0)
})

test('Dashboard starts from a foreign cwd, ignores its .env, exposes opaque health and leaves child processes off', async (t) => {
  const { root, paths, env } = portableFixture(t)
  const foreignCwd = path.join(root, 'foreign-cwd')
  fs.mkdirSync(foreignCwd)
  fs.writeFileSync(path.join(foreignCwd, '.env'), 'CROWN_DASHBOARD_HOST=203.0.113.1\nCROWN_DASHBOARD_PORT=not-a-port\n', 'utf8')
  const previousCwd = process.cwd()
  process.chdir(foreignCwd)

  let runtime = null
  try {
    runtime = await startCrownDashboard({ env, registerSignals: false })
    assert.equal(runtime.monitorProcess.isRunning(), false)
    assert.equal(runtime.bettingProcess.isRunning(), false)
    assert.ok(runtime.humanLoginController)
    assert.ok(runtime.bettingHumanLoginController)
    assert.notEqual(runtime.humanLoginController, runtime.bettingHumanLoginController)
    const address = runtime.server.address()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.installationId, 'install-A')
    assert.equal(health.version, APP_VERSION)
    assert.equal(health.appContractVersion, APP_CONTRACT_VERSION)
    assert.doesNotMatch(JSON.stringify(health), new RegExp(paths.dataRoot.replaceAll('\\', '\\\\'), 'i'))
  } finally {
    await runtime?.shutdown()
    process.chdir(previousCwd)
  }
})

test('ordered shutdown continues every safe stop after an earlier failure', async () => {
  const events = []
  const errors = []
  const result = await shutdownDashboardRuntime({
    disableRealBetting: async () => { events.push('real-intent'); throw new Error('intent-failed') },
    bettingProcess: { stop: async () => { events.push('worker') } },
    humanLoginController: { shutdown: async () => { events.push('human-login') } },
    monitorProcess: { stopAndWait: async () => { events.push('monitor') } },
    convergeDatabase: async () => { events.push('database') },
    closeHttp: async () => { events.push('http') },
    onError: (error) => errors.push(error.message),
  })
  assert.deepEqual(events, ['real-intent', 'worker', 'human-login', 'monitor', 'database', 'http'])
  assert.equal(result.ok, false)
  assert.deepEqual(errors, ['intent-failed'])
})

test('ordered shutdown has no delivery cancellation stage', async () => {
  const events = []
  const result = await shutdownDashboardRuntime({
    disableRealBetting: async () => { events.push('real-intent') },
    monitorProcess: { stopAndWait: async () => { events.push('monitor') } },
    closeHttp: async () => { events.push('http') },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(events, ['real-intent', 'monitor', 'http'])
  assert.equal('createDashboardUpdateService' in dashboardRuntime, false)
  assert.equal('createDashboardUpdateHealthProvider' in dashboardRuntime, false)
})

test('ordered shutdown skips SQLite convergence when the watcher remains alive but still closes HTTP', async () => {
  const events = []
  const errors = []
  const result = await shutdownDashboardRuntime({
    disableRealBetting: async () => { events.push('real-intent') },
    bettingProcess: { stop: async () => { events.push('worker') } },
    monitorProcess: {
      stopAndWait: async () => { events.push('monitor'); throw new Error('watcher-stop-unsafe') },
      isRunning: () => true,
    },
    convergeDatabase: async () => { events.push('database') },
    closeHttp: async () => { events.push('http') },
    onError: (error) => errors.push(error.message),
  })
  assert.deepEqual(events, ['real-intent', 'worker', 'monitor', 'http'])
  assert.equal(result.ok, false)
  assert.deepEqual(errors, ['watcher-stop-unsafe', 'database-convergence-skipped-watcher-unsafe'])
})

test('ordered shutdown treats unsafe human-login results as failures and skips SQLite convergence', async (t) => {
  for (const unsafeResult of [false, { ok: false }]) {
    await t.test(JSON.stringify(unsafeResult), async () => {
      const events = []
      const errors = []
      const result = await shutdownDashboardRuntime({
        disableRealBetting: async () => { events.push('real-intent') },
        bettingProcess: { stop: async () => { events.push('worker') } },
        humanLoginController: {
          shutdown: async () => { events.push('human-login'); return unsafeResult },
        },
        monitorProcess: {
          stopAndWait: async () => { events.push('monitor') },
          isRunning: () => false,
        },
        convergeDatabase: async () => { events.push('database') },
        closeHttp: async () => { events.push('http') },
        onError: (error) => errors.push(error.message),
      })

      assert.deepEqual(events, ['real-intent', 'worker', 'human-login', 'monitor', 'http'])
      assert.equal(result.ok, false)
      assert.deepEqual(errors, [
        'human-login-reported-unsafe',
        'database-convergence-skipped-human-login-unsafe',
      ])
    })
  }
})

test('ordered shutdown treats unsafe Betting Worker stop results as a database convergence gate', async (t) => {
  for (const unsafeResult of [false, { ok: false }]) {
    await t.test(JSON.stringify(unsafeResult), async () => {
      const events = []
      const errors = []
      const result = await shutdownDashboardRuntime({
        disableRealBetting: async () => { events.push('real-intent') },
        bettingProcess: {
          stop: async () => { events.push('worker'); return unsafeResult },
        },
        humanLoginController: {
          shutdown: async () => { events.push('human-login'); return { ok: true } },
        },
        monitorProcess: {
          stopAndWait: async () => { events.push('monitor') },
          isRunning: () => false,
        },
        convergeDatabase: async () => { events.push('database') },
        closeHttp: async () => { events.push('http') },
        onError: (error) => errors.push(error.message),
      })

      assert.deepEqual(events, ['real-intent', 'worker', 'human-login', 'monitor', 'http'])
      assert.equal(result.ok, false)
      assert.deepEqual(errors, [
        'betting-worker-reported-unsafe',
        'database-convergence-skipped-betting-worker-unsafe',
      ])
    })
  }
})

test('single-flight real betting tick preserves the only in-flight promise across overlapping intervals', async () => {
  assert.equal(typeof dashboardRuntime.createSingleFlightRunner, 'function')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let runs = 0
  const runner = dashboardRuntime.createSingleFlightRunner(async () => { runs += 1; await gate })
  const first = runner.start()
  const overlap = runner.start()
  assert.equal(overlap, first)
  assert.equal(runs, 1)
  let waited = false
  const waiting = runner.wait().then(() => { waited = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(waited, false)
  release()
  await waiting
  assert.equal(waited, true)
  assert.equal(runner.current(), null)
})

test('dashboard shutdown drains the in-flight betting tick before stopping the worker', async () => {
  const events = []
  const workerStopOptions = []
  let releaseTick
  const tick = new Promise((resolve) => { releaseTick = resolve })
  const shuttingDown = shutdownDashboardRuntime({
    waitForRealBettingTick: async () => {
      events.push('tick-wait')
      await tick
      events.push('tick-finished')
    },
    disableRealBetting: async () => { events.push('real-intent') },
    bettingProcess: { stop: async (options) => { events.push('worker-stop'); workerStopOptions.push(options) } },
    monitorProcess: { stopAndWait: async () => { events.push('monitor-stop') } },
    convergeDatabase: async () => { events.push('database') },
    closeHttp: async () => { events.push('http') },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['tick-wait'])
  releaseTick()
  const result = await shuttingDown

  assert.equal(result.ok, true)
  assert.deepEqual(events, [
    'tick-wait', 'tick-finished', 'real-intent', 'worker-stop', 'monitor-stop', 'database', 'http',
  ])
  assert.deepEqual(workerStopOptions, [{ suppressSafetyHandoff: true }])
})

test('dashboard supervises reconciliation only when a betting start cannot be in flight', () => {
  assert.equal(typeof dashboardRuntime.shouldSuperviseReconciliation, 'function')
  for (const state of ['off', 'blocked', 'stopping']) {
    assert.equal(dashboardRuntime.shouldSuperviseReconciliation(state), true, state)
  }
  for (const state of ['armed_waiting', 'running']) {
    assert.equal(dashboardRuntime.shouldSuperviseReconciliation(state), false, state)
  }
})

test('Portable cleanup deletes only allowlisted targets inside data root', async (t) => {
  const { root, paths, env } = portableFixture(t)
  const database = openAppDatabase({ dbPath: paths.dbPath, env })
  database.close()
  const runtimeHistory = path.join(paths.runtimeDir, 'crown-watch-runtime.jsonl')
  const configSentinel = path.join(paths.configDir, 'keep.json')
  const configCacheSentinel = path.join(paths.configDir, 'Cache', 'keep.json')
  const sessionSentinel = path.join(paths.sessionDir, 'keep.json')
  const sessionCacheSentinel = path.join(paths.sessionDir, 'Cache', 'keep.bin')
  const unrelatedRuntimeCache = path.join(paths.runtimeDir, 'unrelated', 'Cache', 'keep.bin')
  const browserCache = path.join(paths.profileDir, 'Default', 'Cache', 'cache.bin')
  const outsideSentinel = path.join(root, 'outside.txt')
  for (const file of [runtimeHistory, configSentinel, configCacheSentinel, sessionSentinel, sessionCacheSentinel, unrelatedRuntimeCache, browserCache, outsideSentinel]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'keep', 'utf8')
  }

  await runRuntimeCleanup({
    dataRoot: paths.dataRoot,
    runtimeDir: paths.runtimeDir,
    profileDir: paths.profileDir,
    dbPath: paths.dbPath,
    env,
  })

  assert.equal(fs.existsSync(runtimeHistory), false)
  assert.equal(fs.existsSync(configSentinel), true)
  assert.equal(fs.existsSync(configCacheSentinel), true)
  assert.equal(fs.existsSync(sessionSentinel), true)
  assert.equal(fs.existsSync(sessionCacheSentinel), true)
  assert.equal(fs.existsSync(unrelatedRuntimeCache), true)
  assert.equal(fs.existsSync(browserCache), false)
  assert.equal(fs.existsSync(outsideSentinel), true)
})

test('Portable cleanup rejects data root, runtime and profile junctions before reading deletion targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cleanup-reparse-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'crown-watch-runtime.jsonl'), 'outside', 'utf8')

  const actualData = path.join(root, 'actual-data')
  fs.mkdirSync(path.join(actualData, 'runtime', 'browser-profiles'), { recursive: true })
  const dataRootLink = path.join(root, 'data-root-link')
  fs.symlinkSync(actualData, dataRootLink, 'junction')
  assert.throws(() => previewRuntimeCleanup({
    dataRoot: dataRootLink,
    runtimeDir: path.join(dataRootLink, 'runtime'),
    profileDir: path.join(dataRootLink, 'runtime', 'browser-profiles'),
    dbPath: path.join(dataRootLink, 'storage', 'crown.sqlite'),
  }), /runtime-cleanup-unsafe-reparse/)

  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(dataRoot)
  const runtimeLink = path.join(dataRoot, 'runtime')
  fs.symlinkSync(outside, runtimeLink, 'junction')
  assert.throws(() => previewRuntimeCleanup({
    dataRoot,
    runtimeDir: runtimeLink,
    profileDir: path.join(runtimeLink, 'browser-profiles'),
    dbPath: path.join(dataRoot, 'storage', 'crown.sqlite'),
  }), /runtime-cleanup-unsafe-reparse/)
  fs.rmSync(runtimeLink)

  const runtimeDir = path.join(dataRoot, 'runtime')
  fs.mkdirSync(runtimeDir)
  const profileLink = path.join(runtimeDir, 'browser-profiles')
  fs.symlinkSync(outside, profileLink, 'junction')
  assert.throws(() => previewRuntimeCleanup({
    dataRoot,
    runtimeDir,
    profileDir: profileLink,
    dbPath: path.join(dataRoot, 'storage', 'crown.sqlite'),
  }), /runtime-cleanup-unsafe-reparse/)
  fs.rmSync(profileLink)
  const profileDir = path.join(runtimeDir, 'browser-profiles')
  const cacheDir = path.join(profileDir, 'Default', 'Cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.symlinkSync(outside, path.join(cacheDir, 'outside-link'), 'junction')
  assert.throws(() => previewRuntimeCleanup({
    dataRoot,
    runtimeDir,
    profileDir,
    dbPath: path.join(dataRoot, 'storage', 'crown.sqlite'),
  }), /runtime-cleanup-unsafe-reparse/)
  assert.equal(fs.readFileSync(path.join(outside, 'crown-watch-runtime.jsonl'), 'utf8'), 'outside')
})
