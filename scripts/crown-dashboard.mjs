#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadProjectEnv } from '../src/crown/app/env-file.mjs'
import { APP_CONTRACT_VERSION } from '../src/crown/app/app-contract-version.mjs'
import { APP_VERSION } from '../src/crown/app/app-version.mjs'
import { openAppDatabase, openRuntimeDatabase } from '../src/crown/app/app-db.mjs'
import { createBettingProcessController } from '../src/crown/app/betting-process.mjs'
import { CrownHumanLoginController } from '../src/crown/app/crown-human-login-controller.mjs'
import { createMonitorProcessController } from '../src/crown/app/monitor-process.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import {
  collectRealBettingPreflight,
  getRealBettingStatus,
  recordRealBettingWorkerExit,
  refreshRealBettingRuntime,
  requestRealBettingStop,
} from '../src/crown/betting/real-betting-runtime.mjs'
import { startDashboardServer } from '../src/crown/dashboard/static-server.mjs'
import { portableEnvironment, resolvePortablePaths } from '../src/crown/runtime/portable-paths.mjs'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))
const INSTALLATION_ID = /^[A-Za-z0-9_-]{8,128}$/

function absoluteFromApp(appDir, value, fallback) {
  return path.resolve(appDir, value || fallback)
}

export function resolveDashboardRuntime({ env = process.env } = {}) {
  const runtimeEnv = { ...env }
  if (runtimeEnv.CROWN_PORTABLE === '1') {
    if (runtimeEnv.CROWN_APP_VERSION !== APP_VERSION) throw new Error('portable-app-version-mismatch')
    const paths = resolvePortablePaths({
      appRoot: runtimeEnv.CROWN_APP_ROOT,
      dataRoot: runtimeEnv.CROWN_DATA_ROOT,
      version: runtimeEnv.CROWN_APP_VERSION,
      env: runtimeEnv,
    })
    const canonical = portableEnvironment(paths)
    for (const [name, value] of Object.entries(canonical)) {
      if (runtimeEnv[name] && runtimeEnv[name] !== value) throw new Error(`portable-environment-path-mismatch:${name}`)
      runtimeEnv[name] = value
    }
    if (!INSTALLATION_ID.test(runtimeEnv.CROWN_INSTALLATION_ID || '')) throw new Error('portable-installation-id-required')
    return { portable: true, env: runtimeEnv, paths }
  }

  loadProjectEnv({ cwd: APP_DIR, env: runtimeEnv })
  const appDir = absoluteFromApp(APP_DIR, runtimeEnv.CROWN_APP_DIR, '.')
  const runtimeDir = absoluteFromApp(appDir, runtimeEnv.CROWN_RUNTIME_DIR, 'data/runtime')
  const configDir = absoluteFromApp(appDir, runtimeEnv.CROWN_CONFIG_DIR, 'config')
  const paths = {
    appRoot: appDir,
    versionRoot: appDir,
    appDir,
    nodeExe: runtimeEnv.CROWN_NODE_EXECUTABLE_PATH || process.execPath,
    chromiumExe: runtimeEnv.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
    dataRoot: absoluteFromApp(appDir, runtimeEnv.CROWN_DATA_ROOT, '.'),
    dbPath: absoluteFromApp(appDir, runtimeEnv.CROWN_DB_PATH, 'storage/crown.sqlite'),
    secretKeyPath: absoluteFromApp(appDir, runtimeEnv.CROWN_LOCAL_SECRET_KEY_PATH, 'storage/crown-local-secret.key'),
    configDir,
    runtimeDir,
    sessionDir: absoluteFromApp(runtimeDir, runtimeEnv.CROWN_SESSION_DIR, 'crown-sessions'),
    profileDir: absoluteFromApp(runtimeDir, runtimeEnv.CROWN_BROWSER_PROFILE_DIR, 'browser-profiles'),
    logDir: absoluteFromApp(appDir, runtimeEnv.CROWN_LOG_DIR, 'logs'),
    staticDir: absoluteFromApp(appDir, runtimeEnv.CROWN_STATIC_DIR, 'frontend/dist'),
  }
  return { portable: false, env: runtimeEnv, paths }
}

export async function shutdownDashboardRuntime({
  disableRealBetting,
  bettingProcess,
  humanLoginController,
  monitorProcess,
  convergeDatabase,
  closeHttp,
  onError = (error, stage) => console.error(`dashboard shutdown ${stage}:`, error),
} = {}) {
  const errors = []
  const step = async (stage, work) => {
    if (typeof work !== 'function') return true
    try {
      await work()
      return true
    } catch (error) {
      errors.push({ stage, error })
      try { onError(error, stage) } catch {}
      return false
    }
  }
  await step('real-intent', disableRealBetting)
  await step('betting-worker', () => bettingProcess?.stop?.())
  await step('human-login', () => humanLoginController?.shutdown?.())
  const monitorStoppedSafely = await step('monitor', () => monitorProcess?.stopAndWait?.())
  let watcherStillRunning = !monitorStoppedSafely
  try {
    if (monitorProcess?.isRunning?.() === true) watcherStillRunning = true
  } catch {
    watcherStillRunning = true
  }
  if (watcherStillRunning) {
    await step('database', () => { throw new Error('database-convergence-skipped-watcher-unsafe') })
  } else {
    await step('database', convergeDatabase)
  }
  await step('http', closeHttp)
  return { ok: errors.length === 0, errors: errors.map(({ stage, error }) => ({ stage, message: error?.message || String(error) })) }
}

export function createSingleFlightRunner(run) {
  if (typeof run !== 'function') throw new TypeError('single-flight-runner-function-required')
  let inFlight = null
  const start = () => {
    if (inFlight) return inFlight
    let result
    try { result = run() } catch (error) { result = Promise.reject(error) }
    let tracked
    tracked = Promise.resolve(result).finally(() => {
      if (inFlight === tracked) inFlight = null
    })
    inFlight = tracked
    return tracked
  }
  return {
    start,
    wait: () => inFlight || Promise.resolve(),
    current: () => inFlight,
  }
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

export async function startCrownDashboard({
  env = process.env,
  registerSignals = false,
} = {}) {
  const runtime = resolveDashboardRuntime({ env })
  const { paths } = runtime
  const runtimeEnv = runtime.env
  const host = runtimeEnv.CROWN_DASHBOARD_HOST || '127.0.0.1'
  const port = Number(runtimeEnv.CROWN_DASHBOARD_PORT || 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('dashboard-port-invalid')

  const defaultLeaguesConfig = path.join(paths.configDir, 'default-leagues.json')
  const monitorProcess = createMonitorProcessController({
    appDir: paths.appDir,
    nodeExe: paths.nodeExe,
    watchScriptPath: path.join(paths.appDir, 'scripts', 'crown-watch.mjs'),
    dbPath: paths.dbPath,
    runtimeDir: paths.runtimeDir,
    configDir: paths.configDir,
    profileDir: paths.profileDir,
    env: runtimeEnv,
  })
  const bettingProcess = createBettingProcessController({
    appDir: paths.appDir,
    nodeExe: paths.nodeExe,
    workerScriptPath: path.join(paths.appDir, 'scripts', 'crown-betting-worker.mjs'),
    dbPath: paths.dbPath,
    runtimeDir: paths.runtimeDir,
    defaultLeaguesConfig,
    env: runtimeEnv,
    onExit(event) {
      const exitDatabase = openRuntimeDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
      try { recordRealBettingWorkerExit(exitDatabase.db, event) } finally { exitDatabase.close() }
    },
  })
  const startupDatabase = openAppDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
  try {
    getRealBettingStatus(startupDatabase.db, { initialize: true })
  } finally {
    startupDatabase.close()
  }

  const humanLoginController = runtime.portable
    ? new CrownHumanLoginController({
      installationId: runtimeEnv.CROWN_INSTALLATION_ID,
      appRoot: paths.appRoot,
      dataRoot: paths.dataRoot,
      runtimeDir: paths.runtimeDir,
      profileRoot: paths.profileDir,
      chromiumExecutable: paths.chromiumExe,
      loadAccount(accountId) {
        const handle = openAppDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
        try {
          const repository = createAppRepository(handle.db, {
            env: runtimeEnv,
            dbPath: paths.dbPath,
            runtimeDir: paths.runtimeDir,
          })
          return repository.getMonitorAccountForManualLogin(accountId)
        } finally {
          handle.close()
        }
      },
    })
    : null

  const dataOptions = {
    dbPath: paths.dbPath,
    runtimeDir: paths.runtimeDir,
    snapshotPath: path.join(paths.runtimeDir, 'crown-odds-snapshots.jsonl'),
    changesPath: path.join(paths.runtimeDir, 'crown-odds-changes.jsonl'),
    v2SnapshotPath: path.join(paths.runtimeDir, 'crown-odds-snapshots-v2.jsonl'),
    v2ChangesPath: path.join(paths.runtimeDir, 'crown-odds-changes-v2.jsonl'),
    runtimeLogPath: path.join(paths.runtimeDir, 'crown-watch-runtime.jsonl'),
    fixtureSnapshotPath: path.join(paths.appDir, 'data', 'fixtures', 'crown', '20260708_004011', 'replay-normalized.jsonl'),
    configPath: path.join(paths.configDir, 'monitored-leagues.json'),
    defaultLeaguesPath: defaultLeaguesConfig,
    monitorSettingsPath: path.join(paths.configDir, 'monitor-settings.json'),
    telegramSettingsPath: path.join(paths.configDir, 'telegram-settings.json'),
    allowFixtureFallback: runtimeEnv.CROWN_ALLOW_FIXTURE_FALLBACK === '1' && !runtime.portable,
  }
  const appOptions = {
    appDir: paths.appDir,
    dataRoot: paths.dataRoot,
    configDir: paths.configDir,
    runtimeDir: paths.runtimeDir,
    profileDir: paths.profileDir,
    dbPath: paths.dbPath,
    monitorProcess,
    bettingProcess,
    humanLoginController,
    env: runtimeEnv,
    installationId: runtimeEnv.CROWN_INSTALLATION_ID || '',
    version: runtimeEnv.CROWN_APP_VERSION || APP_VERSION,
    appContractVersion: APP_CONTRACT_VERSION,
  }
  const server = await startDashboardServer({ host, port, staticDir: paths.staticDir, dataOptions, appOptions })

  const runRealBettingTick = async () => {
    const tickDatabase = openRuntimeDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
    try {
      const checks = collectRealBettingPreflight(tickDatabase.db, {
        env: runtimeEnv,
        dbPath: tickDatabase.dbPath,
        runtimeDir: paths.runtimeDir,
        readyTicket: bettingProcess.getReadyTicket(),
      })
      const status = refreshRealBettingRuntime(tickDatabase.db, { checks })
      if (status.state === 'blocked') await bettingProcess.stop()
    } finally {
      tickDatabase.close()
    }
  }
  const realBettingTick = createSingleFlightRunner(runRealBettingTick)
  const tickTimer = setInterval(() => {
    realBettingTick.start().catch((error) => console.error('dashboard betting tick:', error))
  }, 1000)
  tickTimer.unref()

  let shutdownPromise = null
  const signalHandlers = new Map()
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    clearInterval(tickTimer)
    for (const [signal, handler] of signalHandlers) process.off(signal, handler)
    shutdownPromise = shutdownDashboardRuntime({
      disableRealBetting: async () => {
        const handle = openRuntimeDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
        try { requestRealBettingStop(handle.db) } finally { handle.close() }
      },
      bettingProcess,
      humanLoginController,
      monitorProcess,
      convergeDatabase: async () => {
        await realBettingTick.wait()
        const handle = openRuntimeDatabase({ dbPath: paths.dbPath, env: runtimeEnv })
        try { handle.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { handle.close() }
      },
      closeHttp: () => closeServer(server),
    })
    return shutdownPromise
  }

  if (registerSignals) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { shutdown().then((result) => { if (!result.ok) process.exitCode = 1 }) }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }
  }

  return { ...runtime, server, monitorProcess, bettingProcess, humanLoginController, shutdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCrownDashboard({ registerSignals: true }).then(({ server }) => {
    const address = server.address()
    console.log(`Crown dashboard listening on http://${address.address}:${address.port}`)
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
