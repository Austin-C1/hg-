import crypto from 'node:crypto'
import path from 'node:path'

import { CrownApiClient } from '../login/crown-api-login-manager.mjs'
import {
  ManualLoginBridge,
  ManualLoginError,
} from '../login/manual-login-bridge.mjs'
import { normalizePublicHttpsExactOrigin } from '../login/crown-origin.mjs'
import { launchPortableChromium } from '../login/portable-chromium.mjs'
import { assertPathWithin, normalizeFullyQualifiedWindowsPath } from '../runtime/portable-paths.mjs'
import { writeAtomicJson } from '../update/atomic-json-file.mjs'

const SAFE_STATES = new Set(['idle', 'opening', 'awaiting-user', 'verifying', 'verified', 'failed'])

function fail(code) {
  throw new ManualLoginError(code)
}

function safeId(value, code = 'manual-login-account-id-invalid') {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) fail(code)
  return normalized
}

function safeCookies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('manual-login-session-owner-mismatch')
  }
  const cookies = {}
  for (const name of Object.keys(value).sort()) {
    if (!name || /[\u0000-\u0020\u007f()<>@,;:\\"/\[\]?={}]/.test(name)) {
      fail('manual-login-session-owner-mismatch')
    }
    if (typeof value[name] !== 'string') fail('manual-login-session-owner-mismatch')
    cookies[name] = value[name]
  }
  return cookies
}

function normalizedOwnerSession(account, session) {
  const accountId = safeId(account?.accountId || account?.id)
  const username = String(account?.username || '').trim()
  const origin = normalizePublicHttpsExactOrigin(account?.loginUrl)
  const uid = String(session?.uid || '').trim()
  const savedAt = Number(session?.savedAt)
  if (
    !username
    || !uid
    || uid.length > 4096
    || /[\u0000-\u001f\u007f]/.test(uid)
    || session?.accountId !== accountId
    || String(session?.username || '').trim() !== username
    || normalizePublicHttpsExactOrigin(session?.baseUrl) !== origin
    || !Number.isSafeInteger(savedAt)
    || savedAt < 0
  ) fail('manual-login-session-owner-mismatch')
  return {
    schemaVersion: 1,
    uid,
    cookies: safeCookies(session.cookies),
    accountId,
    username,
    baseUrl: origin,
    savedAt,
  }
}

export async function replaceOwnerBoundSessionAtomically({
  dataRoot,
  runtimeDir,
  account,
  session,
} = {}) {
  let normalizedDataRoot
  let normalizedRuntimeDir
  try {
    normalizedDataRoot = normalizeFullyQualifiedWindowsPath(dataRoot, 'manual-login-data-root-invalid')
  } catch {
    fail('manual-login-data-root-invalid')
  }
  try {
    normalizedRuntimeDir = normalizeFullyQualifiedWindowsPath(runtimeDir, 'manual-login-runtime-dir-invalid')
  } catch {
    fail('manual-login-runtime-dir-invalid')
  }
  try {
    assertPathWithin(normalizedDataRoot, normalizedRuntimeDir, 'runtimeDir')
  } catch {
    fail('manual-login-session-path-outside-data-root')
  }
  const normalized = normalizedOwnerSession(account, session)
  const sessionDir = path.join(normalizedRuntimeDir, 'crown-sessions', normalized.accountId)
  const target = path.join(sessionDir, 'api-session.json')
  try {
    assertPathWithin(normalizedDataRoot, target, 'sessionFile')
  } catch {
    fail('manual-login-session-path-outside-data-root')
  }
  await writeAtomicJson({ dataRoot: normalizedDataRoot, filePath: target, value: normalized })
  return { status: 'saved', accountId: normalized.accountId }
}

function safeStatus(value) {
  const status = String(value?.status || '')
  if (!SAFE_STATES.has(status)) fail('manual-login-state-invalid')
  const challengeId = String(value?.challengeId || '').trim()
  const accountId = safeId(value?.accountId)
  const errorCode = String(value?.errorCode || '')
  const expiresAt = Number(value?.expiresAt)
  if (
    !/^[A-Za-z0-9._-]{1,256}$/.test(challengeId)
    || (errorCode && !/^manual-login-[a-z0-9-]+$/.test(errorCode))
    || !Number.isSafeInteger(expiresAt)
    || expiresAt < 0
  ) {
    fail('manual-login-state-invalid')
  }
  return {
    challengeId,
    accountId,
    status,
    errorCode,
    expiresAt,
  }
}

async function loadExactBoundAccount(loadAccount, expected) {
  let loaded
  try { loaded = await loadAccount(expected.accountId) } catch { fail('manual-login-account-binding-changed') }
  let origin
  try { origin = normalizePublicHttpsExactOrigin(loaded?.loginUrl) } catch { fail('manual-login-account-binding-changed') }
  const accountId = String(loaded?.accountId || loaded?.id || '')
  const username = String(loaded?.username || '').trim()
  if (accountId !== expected.accountId || username !== expected.username || origin !== expected.origin) {
    fail('manual-login-account-binding-changed')
  }
  return { id: accountId, accountId, username, loginUrl: origin }
}

function boundedAllSettled(promises, timeoutMs) {
  const complete = Promise.allSettled(promises)
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  return Promise.race([complete, timeout]).finally(() => clearTimeout(timer))
}

export class CrownHumanLoginController {
  constructor({
    bridge = null,
    loadAccount,
    installationId,
    appRoot,
    dataRoot,
    runtimeDir,
    profileRoot,
    chromiumExecutable,
    chromium,
    apiClient,
    fetchImpl = globalThis.fetch,
    randomBytes = crypto.randomBytes,
    shutdownWaitMs = 15_000,
    maxActiveChallenges = 64,
  } = {}) {
    if (typeof loadAccount !== 'function') fail('manual-login-account-loader-required')
    if (!Number.isSafeInteger(shutdownWaitMs) || shutdownWaitMs < 10 || shutdownWaitMs > 60_000) {
      fail('manual-login-shutdown-timeout-invalid')
    }
    if (!Number.isSafeInteger(maxActiveChallenges) || maxActiveChallenges < 1 || maxActiveChallenges > 256) {
      fail('manual-login-capacity-invalid')
    }
    this.loadAccount = loadAccount
    this.bindings = new Map()
    this.contexts = new Map()
    this.operations = new Map()
    this.closing = false
    this.shutdownPromise = null
    this.shutdownWaitMs = shutdownWaitMs
    this.maxActiveChallenges = maxActiveChallenges

    if (bridge) {
      this.bridge = bridge
      return
    }

    const client = apiClient || new CrownApiClient({ fetchImpl })
    this.bridge = new ManualLoginBridge({
      installationId,
      randomBytes,
      launchBrowser: async ({ accountId }) => {
        const browser = await launchPortableChromium({
          chromium,
          appRoot,
          dataRoot,
          executablePath: chromiumExecutable,
          profileRoot,
          accountId,
        })
        if (this.closing || this.contexts.size >= this.maxActiveChallenges) {
          await browser.context?.close?.().catch(() => {})
          fail(this.closing ? 'manual-login-controller-closing' : 'manual-login-busy')
        }
        this.contexts.set(browser.context, accountId)
        return browser
      },
      verifyGameList: (session, { signal } = {}) => client.fetchGameList(session, { signal }),
      replaceSessionAtomically: async ({ account, session }) => {
        const expected = {
          accountId: String(account?.accountId || account?.id || ''),
          username: String(account?.username || '').trim(),
          origin: normalizePublicHttpsExactOrigin(account?.loginUrl),
        }
        const current = await loadExactBoundAccount(this.loadAccount, expected)
        return replaceOwnerBoundSessionAtomically({ dataRoot, runtimeDir, account: current, session })
      },
    })
  }

  _assertOpen() {
    if (this.closing) fail('manual-login-controller-closing')
  }

  _runOperation(operation) {
    this._assertOpen()
    if (this.operations.size >= this.maxActiveChallenges) fail('manual-login-busy')
    const abortController = new AbortController()
    let promise
    promise = Promise.resolve()
      .then(() => operation(abortController.signal))
      .finally(() => this.operations.delete(promise))
    this.operations.set(promise, abortController)
    return promise
  }

  _binding(input) {
    const accountId = safeId(input?.accountId)
    const challengeId = String(input?.challengeId || '').trim()
    const binding = this.bindings.get(challengeId)
    if (!binding || binding.accountId !== accountId) fail('manual-login-challenge-binding-mismatch')
    return { binding, accountId, challengeId }
  }

  _remember(result, owner) {
    const safe = safeStatus(result)
    if (safe.accountId !== owner.accountId) fail('manual-login-challenge-binding-mismatch')
    if (['verified', 'failed'].includes(safe.status)) {
      this.bindings.delete(safe.challengeId)
    } else if (!this.closing) {
      this.bindings.set(safe.challengeId, { ...owner, status: safe.status })
    }
    return safe
  }

  async _closeAccountContexts(accountId) {
    const owned = [...this.contexts.entries()].filter(([, owner]) => owner === accountId)
    for (const [context] of owned) this.contexts.delete(context)
    await boundedAllSettled(owned.map(([context]) => Promise.resolve().then(() => context?.close?.())), this.shutdownWaitMs)
  }

  async _adopt(result, owner) {
    const safe = this._remember(result, owner)
    if (['verified', 'failed'].includes(safe.status)) await this._closeAccountContexts(safe.accountId)
    return safe
  }

  async _openManualLogin({ accountId: inputAccountId } = {}, signal) {
    const accountId = safeId(inputAccountId)
    let loaded
    try {
      loaded = await this.loadAccount(accountId)
    } catch {
      fail('manual-login-account-not-found')
    }
    if (!loaded || String(loaded.id || loaded.accountId || '') !== accountId) {
      fail('manual-login-account-not-found')
    }
    let origin
    try {
      origin = normalizePublicHttpsExactOrigin(loaded.loginUrl)
    } catch {
      fail('manual-login-account-origin-invalid')
    }
    const username = String(loaded.username || '').trim()
    if (!username) fail('manual-login-account-username-required')

    const owner = { accountId, username, origin }
    const result = await this.bridge.openManualLogin({
      account: { id: accountId, accountId, username, loginUrl: origin },
      signal,
    })
    return { result, owner }
  }

  async openManualLogin(input = {}) {
    this._assertOpen()
    if (this.bindings.size + this.operations.size >= this.maxActiveChallenges) fail('manual-login-busy')
    return this._runOperation(async (signal) => {
      const { result, owner } = await this._openManualLogin(input, signal)
      let safe = this._remember(result, owner)
      if (this.closing || signal.aborted) {
        const cancelled = await this.bridge.cancelManualLogin({
          accountId: safe.accountId, challengeId: safe.challengeId, signal,
        })
        safe = await this._adopt(cancelled, owner)
      }
      return safe
    })
  }

  getManualLoginStatus(input = {}) {
    this._assertOpen()
    const { binding, accountId, challengeId } = this._binding(input)
    const safe = this._remember(this.bridge.getManualLoginStatus({ accountId, challengeId }), binding)
    if (['verified', 'failed'].includes(safe.status)) void this._closeAccountContexts(accountId)
    return safe
  }

  async confirmManualLogin(input = {}) {
    this._assertOpen()
    const { binding, accountId, challengeId } = this._binding(input)
    return this._runOperation(async (signal) => {
      try {
        await loadExactBoundAccount(this.loadAccount, binding)
        const result = await this.bridge.confirmManualLogin({ accountId, challengeId, signal })
        if (signal.aborted && safeStatus(result).status === 'verified') {
          fail('manual-login-controller-closing')
        }
        return await this._adopt(
          result,
          binding,
        )
      } catch (error) {
        this.bindings.delete(challengeId)
        await boundedAllSettled([
          Promise.resolve().then(() => this.bridge.cancelManualLogin({ accountId, challengeId, signal })),
          this._closeAccountContexts(accountId),
        ], this.shutdownWaitMs)
        throw error
      }
    })
  }

  async cancelManualLogin(input = {}) {
    this._assertOpen()
    const { binding, accountId, challengeId } = this._binding(input)
    return this._runOperation(async (signal) => {
      try {
        return await this._adopt(
          await this.bridge.cancelManualLogin({ accountId, challengeId, signal }),
          binding,
        )
      } catch (error) {
        this.bindings.delete(challengeId)
        await this._closeAccountContexts(accountId)
        throw error
      }
    })
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = (async () => {
      for (const abortController of this.operations.values()) abortController.abort()
      const active = [...this.bindings.entries()]
        .filter(([, binding]) => ['opening', 'awaiting-user', 'verifying'].includes(binding.status))
      const cancellations = active.map(([challengeId, binding]) => Promise.resolve().then(() => this.bridge.cancelManualLogin({
        accountId: binding.accountId,
        challengeId,
      })))
      await boundedAllSettled([...cancellations, ...this.operations.keys()], this.shutdownWaitMs)
      const contexts = [...this.contexts.keys()]
      this.contexts.clear()
      this.bindings.clear()
      await boundedAllSettled(contexts.map((context) => Promise.resolve().then(() => context?.close?.())), this.shutdownWaitMs)
      return { ok: true }
    })()
    return this.shutdownPromise
  }
}

export default CrownHumanLoginController
