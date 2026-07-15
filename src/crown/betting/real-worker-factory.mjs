import { createAppRepository } from '../app/app-repository.mjs'
import { CrownBrowserApiClient } from '../login/crown-browser-api-client.mjs'
import { launchPortableChromium } from '../login/portable-chromium.mjs'
import { BrowserProfileLease } from '../runtime/browser-profile-lease.mjs'
import { B2Executor } from './b2-executor.mjs'
import { B2Reconciler } from './b2-reconciler.mjs'
import { CrownAccountExecutionProvider } from './crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from './crown-account-provider.mjs'
import { CrownAccountReconciliationProvider } from './crown-account-reconciliation-provider.mjs'
import { CrownBrowserAccountRuntime } from './crown-browser-account-runtime.mjs'
import { ReconciliationWorker } from './reconciliation-worker.mjs'
import { isCrownAcceptanceCapabilityAuthority } from './crown-browser-acceptance.mjs'

function createPreviewAdapter(previewProvider) {
  return {
    async preview(input) {
      const result = await previewProvider.preview(input)
      const preview = result.executionPreview
      if (!preview || typeof preview !== 'object'
        || !Number.isSafeInteger(result.freshBalanceCny)
        || result.freshBalanceCny < 0) return { ok: false }
      const adapted = {
        ok: true,
        minStakeMinor: preview.minStakeMinor,
        maxStakeMinor: preview.maxStakeMinor,
        balanceMinor: result.freshBalanceCny,
        stakeStepMinor: preview.stakeStepMinor,
        odds: preview.odds,
        currency: preview.currency,
        amountScale: preview.amountScale,
        lockedIdentity: result.lockedIdentity,
        capabilityEvidenceId: result.capabilityEvidenceId,
        capabilityVersion: result.capabilityVersion,
      }
      if (input.acceptanceClaim) Object.defineProperty(adapted, 'acceptanceRawPreview', { value: result })
      return adapted
    },
  }
}

export function createProductionBrowserRuntime({
  database,
  appRoot,
  dataRoot,
  profileRoot,
  chromiumExecutable,
  dbPath,
  factories = {},
} = {}) {
  const db = database?.db || database
  const createProfileLease = ({ accountId }) => (factories.profileLease
    ? factories.profileLease({ database: db, dbPath, accountId, cwd: appRoot })
    : new BrowserProfileLease({ db, dbPath, accountId, cwd: appRoot }))
  const launchBrowser = ({ accountId }) => (factories.launchBrowser
    ? factories.launchBrowser({ accountId, appRoot, dataRoot, profileRoot, chromiumExecutable })
    : launchPortableChromium({
      accountId,
      appRoot,
      dataRoot,
      profileRoot,
      executablePath: chromiumExecutable,
    }))
  const createApiClient = ({ page, origin }) => (factories.apiClient
    ? factories.apiClient({ page, origin })
    : new CrownBrowserApiClient({ page, origin }))
  return (factories.browserRuntime || ((options) => new CrownBrowserAccountRuntime(options)))({
    createProfileLease,
    launchBrowser,
    createApiClient,
  })
}

export function createRealWorkerProvider({
  database,
  executorLease,
  reconcilerLease,
  env = process.env,
  appRoot = env.CROWN_APP_ROOT || process.cwd(),
  dataRoot = env.CROWN_DATA_ROOT || appRoot,
  runtimeDir = 'data/runtime',
  profileRoot = env.CROWN_BROWSER_PROFILE_DIR || `${runtimeDir}/browser-profiles`,
  chromiumExecutable = env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
  dbPath = env.CROWN_DB_PATH || database?.dbPath || '',
  logger = null,
  acceptanceAuthority = null,
  factories = {},
} = {}) {
  if (acceptanceAuthority !== null && !isCrownAcceptanceCapabilityAuthority(acceptanceAuthority)) {
    throw new TypeError('real-worker-acceptance-authority')
  }
  const repository = (factories.repository || ((value, options) => createAppRepository(value, options)))(database, {
    env, dbPath, runtimeDir,
  })
  const browserRuntime = createProductionBrowserRuntime({
    database,
    appRoot,
    dataRoot,
    profileRoot,
    chromiumExecutable,
    dbPath,
    factories,
  })
  const previewProvider = (factories.previewProvider || ((options) => new CrownAccountPreviewProvider(options)))({
    repository, browserRuntime, executorLease, logger, acceptanceAuthority,
  })
  const executionProvider = (factories.executionProvider || ((options) => new CrownAccountExecutionProvider(options)))({
    repository, browserRuntime, executorLease, logger, acceptanceAuthority,
  })
  const reconciliationProvider = (
    factories.reconciliationProvider || ((options) => new CrownAccountReconciliationProvider(options))
  )({ repository, browserRuntime, reconcilerLease, logger, acceptanceAuthority })
  const reconciler = (factories.reconciler || ((options) => new B2Reconciler(options)))({
    database,
    lease: reconcilerLease,
    sourceClient: reconciliationProvider,
    acceptanceAuthority,
    requestTimeoutMs: 30_000,
  })
  const executor = (factories.executor || ((options) => new B2Executor(options)))({
    database,
    previewProvider,
    executionProvider,
    lease: executorLease,
    env,
    acceptanceAuthority,
    acceptedValidator: reconciler,
  })
  const reconciliationWorker = (
    factories.reconciliationWorker || ((options) => new ReconciliationWorker(options))
  )({ database, reconciler, lease: reconcilerLease })
  const previewAdapter = createPreviewAdapter(previewProvider)
  const browserStatusSnapshot = () => browserRuntime.statusSnapshot({ heartbeatAt: new Date().toISOString() })
  return {
    kind: 'crown-production',
    browserRuntime,
    previewProvider,
    executionProvider,
    reconciliationProvider,
    b2Executor: executor,
    b2Reconciler: reconciler,
    reconciliationWorker,
    previewAdapter,
    browserStatusSnapshot,
    shutdown: () => browserRuntime.shutdown(),
    finalizeAccountPauses: () => repository.finalizePendingBettingAccountPauses?.() || 0,
  }
}

export function realCoordinatorDependencies(realWorker) {
  if (!realWorker?.previewAdapter?.preview || !realWorker?.b2Executor?.submit) {
    throw new TypeError('real-worker-provider-contract')
  }
  return { provider: realWorker.previewAdapter, b2Executor: realWorker.b2Executor }
}

export function waitForRealWorkerGo({ channel, generation, nonce, signal, timeoutMs = 10_000 } = {}) {
  if (!channel?.on || !channel?.removeListener) throw new TypeError('real-worker-go-channel')
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      channel.removeListener('message', onMessage)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => { cleanup(); reject(new Error('betting-worker-start-aborted')) }
    const onMessage = (message) => {
      if (message?.type !== 'go' || message.generation !== generation || message.nonce !== nonce) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('betting-worker-go-timeout')) }, timeoutMs)
    channel.on('message', onMessage)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function startRoleLeaseHeartbeat({
  leases,
  controller,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!Array.isArray(leases) || leases.length !== 2 || !controller?.abort) throw new TypeError('real-worker-role-heartbeat')
  const ttlMs = Math.min(...leases.map((lease) => lease.ttlMs))
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3) throw new TypeError('real-worker-role-heartbeat-ttl')
  const timer = setIntervalFn(() => {
    try {
      for (const lease of leases) lease.heartbeat()
    } catch (error) { controller.abort(error) }
  }, Math.max(1, Math.floor(ttlMs / 3) - 1))
  timer?.unref?.()
  return () => clearIntervalFn(timer)
}
