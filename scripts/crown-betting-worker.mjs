#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import { bettingRoleLeaseKeys } from '../src/crown/app/betting-process.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { AutoBettingConsumer } from '../src/crown/betting/auto-betting-consumer.mjs'
import { AutoBettingInboxStore } from '../src/crown/betting/auto-betting-inbox-store.mjs'
import { BettingWorker } from '../src/crown/betting/betting-worker.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { SimulatedBetProvider } from '../src/crown/betting/simulated-bet-provider.mjs'
import { executionCandidateFromSnapshot } from '../src/crown/betting/execution-identity.mjs'
import { createRealWorkerProvider, realCoordinatorDependencies, startRoleLeaseHeartbeat, waitForRealWorkerGo } from '../src/crown/betting/real-worker-factory.mjs'
import { listCrownCapabilities } from '../src/crown/betting/crown-capability-matrix.mjs'
import { assertRealBettingIntentRequested, blockRealBettingRuntime, collectRealBettingPreflight, refreshRealBettingRuntime } from '../src/crown/betting/real-betting-runtime.mjs'
import {
  createCrownAcceptanceWorkerConsumer,
  loadActiveCrownAcceptanceCapabilityAuthority,
} from '../src/crown/betting/crown-browser-acceptance.mjs'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))

export const BETTING_BROWSER_SHUTDOWN_TIMEOUT_MS = 20_000
const ACCEPTANCE_CANDIDATE_FRESHNESS_MS = 60_000
let workerFailureRecorded = false

function recordWorkerFailure(error) {
  if (workerFailureRecorded) return
  workerFailureRecorded = true
  const runtimeDir = String(process.env.CROWN_RUNTIME_DIR || '').trim()
  if (!runtimeDir) return
  const safeCode = String(error?.code || error?.message || 'betting-worker-failed')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 160)
  const safeMessage = String(error?.message || '')
    .replace(/[^A-Za-z0-9_.:() -]/g, '_')
    .slice(0, 240)
  const safeCause = String(error?.cause?.code || error?.cause?.message || '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 160)
  const responseFieldSet = Array.isArray(error?.diagnostics?.responseFieldSet)
    ? error.diagnostics.responseFieldSet
      .map((field) => String(field || ''))
      .filter((field) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(field))
      .slice(0, 100)
    : []
  const responseFieldSetFingerprint = /^sha256:[a-f0-9]{64}$/.test(
    String(error?.diagnostics?.responseFieldSetFingerprint || ''),
  ) ? String(error.diagnostics.responseFieldSetFingerprint) : ''
  try {
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(path.join(runtimeDir, 'crown-betting-worker-last-error.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      code: safeCode,
      ...(safeMessage && safeMessage !== safeCode ? { message: safeMessage } : {}),
      ...(safeCause ? { cause: safeCause } : {}),
      ...(responseFieldSet.length ? { responseFieldSet } : {}),
      ...(responseFieldSetFingerprint ? { responseFieldSetFingerprint } : {}),
    })}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // The original worker failure remains authoritative.
  }
}

export async function shutdownRealWorkerWithBudget(realWorker, {
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!realWorker || typeof realWorker.shutdown !== 'function') throw new TypeError('browser-runtime-shutdown-required')
  let timer
  let timedOut = false
  const shutdown = Promise.resolve().then(() => realWorker.shutdown())
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutFn(() => {
      timedOut = true
      reject(new Error('browser-runtime-shutdown-timeout'))
    }, BETTING_BROWSER_SHUTDOWN_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([shutdown, timeout])
    if (result?.ok !== true) {
      const error = new Error('browser-runtime-shutdown-unsafe')
      error.ownershipUnconfirmed = true
      throw error
    }
    return result
  } catch (error) {
    if (timedOut) error.ownershipUnconfirmed = true
    else if (error?.ownershipUnconfirmed !== true) error.ownershipUnconfirmed = true
    throw error
  } finally {
    clearTimeoutFn(timer)
  }
}

export function createRealWorkerStopBoundary(realWorker, {
  controller = new AbortController(),
} = {}) {
  if (!controller || typeof controller.abort !== 'function' || !controller.signal) {
    throw new TypeError('worker-abort-controller-required')
  }
  if (realWorker && typeof realWorker.shutdown !== 'function') {
    throw new TypeError('browser-runtime-shutdown-required')
  }
  let shutdownPromise = null
  const shutdown = () => {
    if (!realWorker) return Promise.resolve({ ok: true })
    if (!shutdownPromise) shutdownPromise = Promise.resolve().then(() => realWorker.shutdown())
    return shutdownPromise
  }
  const abort = (reason) => {
    controller.abort(reason)
    if (realWorker) void shutdown().catch(() => {})
  }
  return { controller, abort, shutdown }
}

export function argumentsFrom(argv, { env = process.env } = {}) {
  const configDir = env.CROWN_CONFIG_DIR || path.join(APP_DIR, 'config')
  const result = {
    mode: env.CROWN_BETTING_MODE || 'off',
    once: false,
    appRoot: env.CROWN_APP_ROOT || APP_DIR,
    dataRoot: env.CROWN_DATA_ROOT || env.CROWN_APP_ROOT || APP_DIR,
    dbPath: env.CROWN_DB_PATH || '',
    runtimeDir: env.CROWN_RUNTIME_DIR || path.join(APP_DIR, 'data', 'runtime'),
    profileRoot: env.CROWN_BROWSER_PROFILE_DIR || path.join(env.CROWN_RUNTIME_DIR || path.join(APP_DIR, 'data', 'runtime'), 'browser-profiles'),
    chromiumExecutable: env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
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
    else if (argument === '--app-root') result.appRoot = argv[++index] || ''
    else if (argument === '--data-root') result.dataRoot = argv[++index] || ''
    else if (argument === '--db-path') result.dbPath = argv[++index] || ''
    else if (argument === '--runtime-dir') result.runtimeDir = argv[++index] || ''
    else if (argument === '--profile-root') result.profileRoot = argv[++index] || ''
    else if (argument === '--chromium-executable') result.chromiumExecutable = argv[++index] || ''
    else if (argument === '--simulated-script-json') result.simulatedScriptJson = argv[++index] || ''
    else if (argument === '--default-leagues-config') result.defaultLeaguesConfig = argv[++index] || ''
    else if (argument === '--worker-lease-key') result.workerLeaseKey = argv[++index] || ''
    else if (argument === '--generation') result.generation = argv[++index] || ''
    else if (argument === '--ready-nonce') result.readyNonce = argv[++index] || ''
    else throw new Error(`unknown-argument:${argument}`)
  }
  if (!['off', 'simulated', 'preview', 'real'].includes(result.mode)) throw new Error('betting-worker-mode')
  if (['simulated', 'preview'].includes(result.mode) && !result.simulatedScriptJson) throw new Error('simulated-script-required')
  if (env.CROWN_PORTABLE === '1' && [
    result.appRoot, result.dataRoot, result.dbPath, result.runtimeDir, result.profileRoot,
    result.chromiumExecutable, result.defaultLeaguesConfig,
  ].some((value) => !path.isAbsolute(value))) {
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

export function acceptanceCandidateFinder(db) {
  return (direction) => {
    const now = Date.now()
    const rows = db.prepare(`SELECT selection.captured_at,selection.snapshot_json
      FROM monitor_selection_state selection
      JOIN monitor_event_state event ON event.event_key=selection.event_key
      WHERE event.active=1
      ORDER BY selection.captured_at DESC`).all()
    for (const row of rows) {
      const capturedAt = Date.parse(row.captured_at)
      if (!Number.isFinite(capturedAt) || capturedAt > now || now - capturedAt > ACCEPTANCE_CANDIDATE_FRESHNESS_MS) continue
      let snapshot
      try { snapshot = JSON.parse(row.snapshot_json) } catch { continue }
      if (snapshot?.provider !== 'crown'
        || (snapshot.mode || snapshot.event?.mode) !== direction.mode
        || snapshot.market?.period !== direction.period
        || snapshot.market?.marketType !== direction.marketType
        || snapshot.market?.lineVariant !== direction.lineVariant
        || snapshot.selection?.side !== direction.selectionSide
        || snapshot.selection?.suspended !== false) continue
      try {
        executionCandidateFromSnapshot(snapshot)
      } catch {
        continue
      }
      return {
        provider: 'crown',
        eventKey: snapshot.event?.eventKey,
        period: snapshot.market.period,
        marketType: snapshot.market.marketType,
        lineKey: snapshot.market.lineKey,
        marketIdentity: snapshot.market.marketIdentity,
        sourceSide: snapshot.selection.side,
        side: snapshot.selection.side,
        selectionIdentity: snapshot.selection.selectionIdentity,
        handicap: snapshot.market.handicap,
        handicapRaw: snapshot.market.handicapRaw,
        capturedAt: snapshot.capturedAt,
        snapshot,
      }
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
  const reconcilerLease = new RuntimeLease({ db: handle.db, leaseKey: roleKeys.reconciler })
  const store = new BetBatchStore(handle.db, { leaseKey })
  let provider
  let b2Executor = null
  let realWorker = null
  let acceptanceAuthority = null
  if (options.mode === 'real') {
    acceptanceAuthority = loadActiveCrownAcceptanceCapabilityAuthority({
      database: handle.db,
      secretKey: readOrCreateLocalSecretKey({ env: process.env }),
    })
    realWorker = createRealWorkerProvider({
      database: handle.db,
      executorLease: lease,
      reconcilerLease,
      env: process.env,
      appRoot: options.appRoot,
      dataRoot: options.dataRoot,
      runtimeDir: options.runtimeDir,
      profileRoot: options.profileRoot,
      chromiumExecutable: options.chromiumExecutable,
      dbPath: handle.dbPath,
      acceptanceAuthority,
    })
    ;({ provider, b2Executor } = realCoordinatorDependencies(realWorker))
  } else provider = new SimulatedBetProvider({ script: providerScript })
  const stopBoundary = createRealWorkerStopBoundary(realWorker)
  const { controller, abort } = stopBoundary
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
      abort(error)
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
  const acceptanceConsumer = acceptanceAuthority
    ? createCrownAcceptanceWorkerConsumer({
        authority: acceptanceAuthority,
        findCandidate: acceptanceCandidateFinder(handle.db),
        executeDirection: (input) => coordinator.executeAcceptanceCandidate(input),
        validateDirection: (input) => realWorker.b2Reconciler.validateAccepted(input),
      })
    : null
  const worker = new BettingWorker({
    mode: options.mode,
    db: handle.db,
    coordinator,
    inboxStore,
    consumer,
    acceptanceConsumer,
    lease,
    processLease: workerLease,
    realExecutionGate: exactRealGate,
    accountPauseFinalizer: realWorker?.finalizeAccountPauses || null,
  })
  let stopHeartbeat = null
  let browserStatusTimer = null
  let reconciliationLoop = null
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    workerLease.acquire()
    worker.start()
    if (options.mode === 'real') realWorker.reconciliationWorker.start()
    stopHeartbeat = startRoleLeaseHeartbeat({ leases: [workerLease, lease], controller: { abort } })
    if (options.mode === 'real') {
      if (!options.generation || !options.readyNonce || typeof process.send !== 'function') throw new Error('betting-worker-ready-channel-required')
      readyTicket = {
        type: 'ready', generation: options.generation, nonce: options.readyNonce,
        leases: {
          worker: { leaseKey: roleKeys.worker, ownerId: workerLease.ownerId, fencingToken: workerLease.fencingToken },
          executor: { leaseKey: roleKeys.executor, ownerId: lease.ownerId, fencingToken: lease.fencingToken },
          reconciler: {
            leaseKey: roleKeys.reconciler,
            ownerId: reconcilerLease.ownerId,
            fencingToken: reconcilerLease.fencingToken,
          },
        },
        browserStatus: realWorker.browserStatusSnapshot(),
      }
      process.send(readyTicket)
      await waitForRealWorkerGo({
        channel: process, generation: options.generation, nonce: options.readyNonce, signal: controller.signal,
      })
      browserStatusTimer = setInterval(() => {
        process.send?.({
          type: 'browser-status',
          generation: options.generation,
          nonce: options.readyNonce,
          snapshot: realWorker.browserStatusSnapshot(),
        })
      }, 1_000)
      browserStatusTimer.unref?.()
    }
    if (options.once) {
      if (options.mode === 'real') await realWorker.reconciliationWorker.runOnce()
      const result = await worker.runOnce()
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } else {
      if (options.mode === 'real') {
        reconciliationLoop = realWorker.reconciliationWorker.run({ signal: controller.signal })
          .then((value) => ({ value }), (error) => { abort(error); return { error } })
      }
      const loopResult = await worker.run({ signal: controller.signal })
      const reconciliationResult = await reconciliationLoop
      if (reconciliationResult?.error) throw reconciliationResult.error
      process.stdout.write(`${JSON.stringify(loopResult)}\n`)
    }
  } catch (error) {
    recordWorkerFailure(error)
    throw error
  } finally {
    abort()
    if (reconciliationLoop) await reconciliationLoop
    if (browserStatusTimer !== null) clearInterval(browserStatusTimer)
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    let releaseOwnership = true
    try {
      if (realWorker) await shutdownRealWorkerWithBudget({ shutdown: stopBoundary.shutdown })
    } catch (error) {
      releaseOwnership = error?.ownershipUnconfirmed !== true
      throw error
    } finally {
      stopHeartbeat?.()
      realWorker?.reconciliationWorker?.stop?.({ release: releaseOwnership })
      if (releaseOwnership) {
        worker.stop()
        workerLease.release()
      }
      handle.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    recordWorkerFailure(error)
    process.stderr.write(`${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
