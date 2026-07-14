import { createAppRepository } from '../app/app-repository.mjs'
import { CrownApiLoginManager } from '../login/crown-api-login-manager.mjs'
import { B2Executor } from './b2-executor.mjs'
import { CrownAccountExecutionProvider } from './crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from './crown-account-provider.mjs'

function createPreviewAdapter(previewProvider) {
  return {
    async preview(input) {
      const result = await previewProvider.preview(input)
      const preview = result.executionPreview
      if (!preview || typeof preview !== 'object'
        || !Number.isSafeInteger(result.freshBalanceCny)
        || result.freshBalanceCny < 0) return { ok: false }
      return {
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
    },
  }
}

export function createRealWorkerProvider({
  database,
  executorLease,
  env = process.env,
  runtimeDir = 'data/runtime',
  logger = null,
  factories = {},
} = {}) {
  const repository = (factories.repository || ((db, options) => createAppRepository(db, options)))(database, { env })
  const loginManager = (factories.loginManager || ((options) => new CrownApiLoginManager(options)))({
    runtimeDir, bettingAllowedOrigins: env.CROWN_BETTING_ALLOWED_ORIGINS || '',
  })
  const previewProvider = (factories.previewProvider || ((options) => new CrownAccountPreviewProvider(options)))({
    repository, loginManager, executorLease, logger,
  })
  const executionProvider = (factories.executionProvider || ((options) => new CrownAccountExecutionProvider(options)))({
    repository, loginManager, previewProvider, executorLease, logger,
  })
  const executor = (factories.executor || ((options) => new B2Executor(options)))({
    database, previewProvider, executionProvider, lease: executorLease, env,
  })
  const previewAdapter = createPreviewAdapter(previewProvider)
  return {
    kind: 'crown-production',
    previewProvider,
    executionProvider,
    b2Executor: executor,
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
