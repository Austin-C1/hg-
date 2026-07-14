#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { bettingRoleLeaseKeys } from '../src/crown/app/betting-process.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { AutoBettingConsumer } from '../src/crown/betting/auto-betting-consumer.mjs'
import { AutoBettingInboxStore } from '../src/crown/betting/auto-betting-inbox-store.mjs'
import { BettingWorker } from '../src/crown/betting/betting-worker.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { SimulatedBetProvider } from '../src/crown/betting/simulated-bet-provider.mjs'
import { createRealWorkerProvider, realCoordinatorDependencies, startRoleLeaseHeartbeat, waitForRealWorkerGo } from '../src/crown/betting/real-worker-factory.mjs'
import { listCrownCapabilities } from '../src/crown/betting/crown-capability-matrix.mjs'
import { assertRealBettingIntentRequested, blockRealBettingRuntime, collectRealBettingPreflight, refreshRealBettingRuntime } from '../src/crown/betting/real-betting-runtime.mjs'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))

export function argumentsFrom(argv, { env = process.env } = {}) {
  const configDir = env.CROWN_CONFIG_DIR || path.join(APP_DIR, 'config')
  const result = {
    mode: env.CROWN_BETTING_MODE || 'off',
    once: false,
    dbPath: env.CROWN_DB_PATH || '',
    runtimeDir: env.CROWN_RUNTIME_DIR || path.join(APP_DIR, 'data', 'runtime'),
    simulatedScriptJson: env.CROWN_SIMULATED_SCRIPT_JSON || '',
    defaultLeaguesConfig: env.CROWN_DEFAULT_LEAGUES_CONFIG || path.join(configDir, 'default-leagues.json'),
    workerLeaseKey: '',
    generation: '',
    readyNonce: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--once') result.once = true
    else if (argument === '--mode') result.mode = argv[++index] || ''
    else if (argument === '--db-path') result.dbPath = argv[++index] || ''
    else if (argument === '--runtime-dir') result.runtimeDir = argv[++index] || ''
    else if (argument === '--simulated-script-json') result.simulatedScriptJson = argv[++index] || ''
    else if (argument === '--default-leagues-config') result.defaultLeaguesConfig = argv[++index] || ''
    else if (argument === '--worker-lease-key') result.workerLeaseKey = argv[++index] || ''
    else if (argument === '--generation') result.generation = argv[++index] || ''
    else if (argument === '--ready-nonce') result.readyNonce = argv[++index] || ''
    else throw new Error(`unknown-argument:${argument}`)
  }
  if (!['off', 'simulated', 'preview', 'real'].includes(result.mode)) throw new Error('betting-worker-mode')
  if (['simulated', 'preview'].includes(result.mode) && !result.simulatedScriptJson) throw new Error('simulated-script-required')
  if (env.CROWN_PORTABLE === '1' && [result.dbPath, result.runtimeDir, result.defaultLeaguesConfig].some((value) => !path.isAbsolute(value))) {
    throw new Error('portable-worker-path-required')
  }
  return result
}

function latestSelectionFinder(db) {
  return (query) => {
    const rows = db.prepare('SELECT snapshot_json FROM monitor_selection_state ORDER BY captured_at DESC').all()
    for (const row of rows) {
      let snapshot
      try { snapshot = JSON.parse(row.snapshot_json) } catch { continue }
      if (snapshot?.provider === query.provider
        && snapshot?.event?.eventKey === query.eventKey
        && snapshot?.market?.period === query.period
        && snapshot?.market?.marketType === query.marketType
        && snapshot?.market?.lineKey === query.lineKey
        && snapshot?.selection?.side === query.side) return snapshot
    }
    return null
  }
}

function whitelistFrom(config) {
  return (signal) => config.leagues
    .filter((rule) => rule.enabled && rule.modes.includes(signal?.evidence?.mode))
    .map((rule) => rule.name)
}

async function readStrictDefaultLeagues(file) {
  let value
  try { value = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('default-leagues-config-invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !Array.isArray(value.leagues) || value.leagues.length === 0) throw new Error('default-leagues-config-invalid')
  const validModes = new Set(['prematch', 'live'])
  const leagues = value.leagues.map((league) => {
    if (!league || typeof league !== 'object' || Array.isArray(league)
      || typeof league.name !== 'string' || !league.name.trim()
      || typeof league.enabled !== 'boolean'
      || !Array.isArray(league.modes) || league.modes.length === 0
      || !league.modes.every((mode) => validModes.has(mode))) throw new Error('default-leagues-config-invalid')
    return { name: league.name.trim(), enabled: league.enabled, modes: [...new Set(league.modes)] }
  })
  return { version: 1, leagues }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (options.mode === 'off') {
    process.stdout.write(`${JSON.stringify({ mode: 'off', processed: 0, results: [] })}\n`)
    return
  }
  let providerScript = []
  if (options.simulatedScriptJson) {
    try { providerScript = JSON.parse(options.simulatedScriptJson) } catch { throw new Error('simulated-script-json') }
    if (!Array.isArray(providerScript)) throw new Error('simulated-script-json')
  }
  if (['simulated', 'preview'].includes(options.mode) && providerScript.length === 0) throw new Error('simulated-script-required')
  if (!options.defaultLeaguesConfig || !existsSync(options.defaultLeaguesConfig)) throw new Error('default-leagues-config-missing')
  const defaultLeagues = await readStrictDefaultLeagues(options.defaultLeaguesConfig)
  const handle = openAppDatabase({ dbPath: options.dbPath || undefined, env: process.env })
  const roleKeys = bettingRoleLeaseKeys({ dbPath: handle.dbPath })
  const workerLeaseKey = options.workerLeaseKey || roleKeys.worker
  if (workerLeaseKey !== roleKeys.worker) throw new Error('betting-worker-lease-key-mismatch')
  const workerLease = new RuntimeLease({ db: handle.db, leaseKey: roleKeys.worker })
  if (options.mode === 'real') {
    assertRealBettingIntentRequested(handle.db)
    const exact = listCrownCapabilities().filter((row) => row.evidenceStatus === 'verified' && row.submitAllowed === true)
    if (exact.length === 0) throw new Error('crown-real-capability-unavailable')
  }
  const leaseKey = roleKeys.executor
  const lease = new RuntimeLease({ db: handle.db, leaseKey })
  const store = new BetBatchStore(handle.db, { leaseKey })
  let provider
  let b2Executor = null
  let realWorker = null
  if (options.mode === 'real') {
    realWorker = createRealWorkerProvider({
      database: handle.db,
      executorLease: lease,
      env: process.env,
    })
    ;({ provider, b2Executor } = realCoordinatorDependencies(realWorker))
  } else provider = new SimulatedBetProvider({ script: providerScript })
  let readyTicket = null
  const exactRealGate = () => {
    if (options.mode !== 'real') return true
    try {
      const checks = collectRealBettingPreflight(handle.db, {
        env: process.env, dbPath: handle.dbPath, runtimeDir: options.runtimeDir, readyTicket,
      })
      const status = refreshRealBettingRuntime(handle.db, { checks })
      if (status.state !== 'running') throw new Error('real-betting-exact-preflight')
      workerLease.assertFence(workerLease.fencingToken)
      lease.assertFence(lease.fencingToken)
      return true
    } catch (error) {
      blockRealBettingRuntime(handle.db, 'collector-failed')
      controller.abort(error)
      throw error
    }
  }
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store,
    provider,
    lease,
    findLatestSelection: latestSelectionFinder(handle.db),
    currentLeagueNames: whitelistFrom(defaultLeagues),
    realExecutionGate: exactRealGate,
    processLease: workerLease,
    b2Executor,
    executionEnvironment: process.env,
  })
  const inboxStore = new AutoBettingInboxStore({
    db: handle.db,
    ownerId: workerLease.ownerId,
    now: () => new Date().toISOString(),
  })
  const consumer = new AutoBettingConsumer({
    findLatestSelection: latestSelectionFinder(handle.db),
    isGlobalRealBettingRequested: () => Number(handle.db.prepare(
      'SELECT requested FROM real_betting_runtime WHERE singleton_id=1',
    ).get()?.requested) === 1,
    claimAndCreateCardScopedBatch: coordinator.claimAndCreateCardScopedBatch,
  })
  const worker = new BettingWorker({
    mode: options.mode,
    db: handle.db,
    coordinator,
    inboxStore,
    consumer,
    lease,
    processLease: workerLease,
    realExecutionGate: exactRealGate,
    accountPauseFinalizer: realWorker?.finalizeAccountPauses || null,
  })
  let stopHeartbeat = null
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    workerLease.acquire()
    worker.start()
    stopHeartbeat = startRoleLeaseHeartbeat({ leases: [workerLease, lease], controller })
    if (options.mode === 'real') {
      if (!options.generation || !options.readyNonce || typeof process.send !== 'function') throw new Error('betting-worker-ready-channel-required')
      readyTicket = {
        type: 'ready', generation: options.generation, nonce: options.readyNonce,
        leases: {
          worker: { leaseKey: roleKeys.worker, ownerId: workerLease.ownerId, fencingToken: workerLease.fencingToken },
          executor: { leaseKey: roleKeys.executor, ownerId: lease.ownerId, fencingToken: lease.fencingToken },
        },
      }
      process.send(readyTicket)
      await waitForRealWorkerGo({
        channel: process, generation: options.generation, nonce: options.readyNonce, signal: controller.signal,
      })
    }
    if (options.once) {
      const result = await worker.runOnce()
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } else {
      const loopResult = await worker.run({ signal: controller.signal })
      process.stdout.write(`${JSON.stringify(loopResult)}\n`)
    }
  } finally {
    stopHeartbeat?.()
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    worker.stop()
    workerLease.release()
    handle.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
