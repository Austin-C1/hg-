import { createAppRepository } from '../app/app-repository.mjs'
import { CrownApiLoginManager } from '../login/crown-api-login-manager.mjs'
import { B2Executor } from './b2-executor.mjs'
import { CrownAccountExecutionProvider } from './crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from './crown-account-provider.mjs'
import { B2Reconciler } from './b2-reconciler.mjs'

function createPreviewAdapter(previewProvider) {
  return {
    async preview(input) {
      const result = await previewProvider.preview(input)
      if (result?.realExecutionEligible !== true) return { ok: false }
      const preview = result.executionPreview || result.preview
      if (!preview || typeof preview !== 'object') throw new Error('preview-execution-contract')
      return {
        ok: true,
        minStakeMinor: preview.minStakeMinor,
        maxStakeMinor: preview.maxStakeMinor,
        balanceMinor: preview.balanceMinor,
        stakeStepMinor: preview.stakeStepMinor,
        odds: preview.odds,
        currency: preview.currency,
        amountScale: preview.amountScale,
        lockedIdentity: result.lockedIdentity,
        capabilityEvidenceId: result.capabilityEvidenceId,
        capabilityVersion: result.capabilityVersion,
      }
    },
  }
}

export function createRealWorkerProvider({
  database,
  executorLease,
  reconcilerLease,
  env = process.env,
  runtimeDir = 'data/runtime',
  factories = {},
} = {}) {
  const repository = (factories.repository || ((db, options) => createAppRepository(db, options)))(database, { env })
  const loginManager = (factories.loginManager || ((options) => new CrownApiLoginManager(options)))({
    runtimeDir, bettingAllowedOrigins: env.CROWN_BETTING_ALLOWED_ORIGINS || '',
  })
  const previewProvider = (factories.previewProvider || ((options) => new CrownAccountPreviewProvider(options)))({
    repository, loginManager, executorLease,
  })
  const executionProvider = (factories.executionProvider || (() => new CrownAccountExecutionProvider()))()
  const executor = (factories.executor || ((options) => new B2Executor(options)))({
    database, previewProvider, executionProvider, lease: executorLease, env,
  })
  const sourceClient = (factories.sourceClient || (() => ({
    async getDangerous() { throw new Error('reconciliation-capability-unverified') },
    async getTodayWagers() { throw new Error('reconciliation-capability-unverified') },
  })))()
  const b2Reconciler = (factories.reconciler || ((options) => new B2Reconciler(options)))({
    database,
    lease: reconcilerLease,
    sourceClient,
  })
  const previewAdapter = createPreviewAdapter(previewProvider)
  return {
    kind: 'crown-production',
    previewProvider,
    executionProvider,
    b2Executor: executor,
    b2Reconciler,
    previewAdapter,
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
  if (!Array.isArray(leases) || leases.length !== 3 || !controller?.abort) throw new TypeError('real-worker-role-heartbeat')
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
