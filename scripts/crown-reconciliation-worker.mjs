#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { openRuntimeDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import { reconciliationLeaseKey } from '../src/crown/app/reconciliation-process.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { B2Reconciler } from '../src/crown/betting/b2-reconciler.mjs'
import { CrownAccountReconciliationProvider } from '../src/crown/betting/crown-account-reconciliation-provider.mjs'
import { CrownBrowserAccountRuntime } from '../src/crown/betting/crown-browser-account-runtime.mjs'
import { loadActiveCrownAcceptanceCapabilityAuthority } from '../src/crown/betting/crown-browser-acceptance.mjs'
import { ReconciliationWorker } from '../src/crown/betting/reconciliation-worker.mjs'
import { CrownBrowserApiClient } from '../src/crown/login/crown-browser-api-client.mjs'
import { launchPortableChromium } from '../src/crown/login/portable-chromium.mjs'
import { BrowserProfileLease } from '../src/crown/runtime/browser-profile-lease.mjs'

const SHUTDOWN_TIMEOUT_MS = 20_000

export function argumentsFrom(argv, { env = process.env } = {}) {
  const appRoot = env.CROWN_APP_ROOT || process.cwd()
  const dataRoot = env.CROWN_DATA_ROOT || appRoot
  const runtimeDir = env.CROWN_RUNTIME_DIR || path.join(dataRoot, 'data', 'runtime')
  const result = {
    appRoot,
    dataRoot,
    runtimeDir,
    profileRoot: env.CROWN_BROWSER_PROFILE_DIR || path.join(runtimeDir, 'browser-profiles'),
    chromiumExecutable: env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
    dbPath: env.CROWN_DB_PATH || '',
    reconcilerLeaseKey: '',
    generation: '',
    readyNonce: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--app-root') result.appRoot = argv[++index] || ''
    else if (argument === '--data-root') result.dataRoot = argv[++index] || ''
    else if (argument === '--runtime-dir') result.runtimeDir = argv[++index] || ''
    else if (argument === '--profile-root') result.profileRoot = argv[++index] || ''
    else if (argument === '--chromium-executable') result.chromiumExecutable = argv[++index] || ''
    else if (argument === '--db-path') result.dbPath = argv[++index] || ''
    else if (argument === '--reconciler-lease-key') result.reconcilerLeaseKey = argv[++index] || ''
    else if (argument === '--generation') result.generation = argv[++index] || ''
    else if (argument === '--ready-nonce') result.readyNonce = argv[++index] || ''
    else throw new Error(`unknown-argument:${argument}`)
  }
  return result
}

async function shutdownBrowser(runtime) {
  let timer
  const shutdown = Promise.resolve().then(() => runtime.shutdown())
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('browser-runtime-shutdown-timeout'))
    }, SHUTDOWN_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([shutdown, timeout])
    if (result?.ok !== true) {
      const error = new Error('browser-runtime-shutdown-unsafe')
      error.ownershipUnconfirmed = true
      throw error
    }
  } catch (error) {
    error.ownershipUnconfirmed = true
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (!options.dbPath || !options.reconcilerLeaseKey || !options.generation || !options.readyNonce
    || typeof process.send !== 'function') throw new Error('reconciliation-worker-ready-channel-required')
  const handle = openRuntimeDatabase({ dbPath: options.dbPath, env: process.env })
  const expectedLeaseKey = reconciliationLeaseKey({ cwd: options.appRoot, dbPath: handle.dbPath })
  if (options.reconcilerLeaseKey !== expectedLeaseKey) {
    handle.close()
    throw new Error('reconciliation-worker-lease-key-mismatch')
  }
  const lease = new RuntimeLease({ db: handle.db, leaseKey: expectedLeaseKey })
  const repository = createAppRepository(handle.db, {
    env: process.env,
    dbPath: handle.dbPath,
    runtimeDir: options.runtimeDir,
  })
  const secretKey = readOrCreateLocalSecretKey({ env: process.env })
  const acceptanceAuthority = loadActiveCrownAcceptanceCapabilityAuthority({
    database: handle.db,
    secretKey,
  })
  const browserRuntime = new CrownBrowserAccountRuntime({
    createProfileLease: ({ accountId }) => new BrowserProfileLease({
      db: handle.db,
      dbPath: handle.dbPath,
      accountId,
      cwd: options.appRoot,
    }),
    launchBrowser: ({ accountId }) => launchPortableChromium({
      accountId,
      appRoot: options.appRoot,
      dataRoot: options.dataRoot,
      profileRoot: options.profileRoot,
      executablePath: options.chromiumExecutable,
    }),
    createApiClient: ({ page, origin }) => new CrownBrowserApiClient({ page, origin }),
  })
  const provider = new CrownAccountReconciliationProvider({
    repository,
    browserRuntime,
    reconcilerLease: lease,
    acceptanceAuthority,
  })
  const reconciler = new B2Reconciler({
    database: handle.db,
    lease,
    sourceClient: provider,
    acceptanceAuthority,
    secretKey,
    requestTimeoutMs: 30_000,
  })
  const worker = new ReconciliationWorker({ database: handle.db, reconciler, lease })
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    worker.start()
    process.send({
      type: 'ready',
      generation: options.generation,
      nonce: options.readyNonce,
      lease: {
        leaseKey: expectedLeaseKey,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
      },
    })
    await worker.run({ signal: controller.signal })
  } finally {
    controller.abort()
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    let releaseOwnership = true
    try {
      await shutdownBrowser(browserRuntime)
    } catch (error) {
      releaseOwnership = error?.ownershipUnconfirmed !== true
      throw error
    } finally {
      worker.stop({ release: releaseOwnership })
      handle.close()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
