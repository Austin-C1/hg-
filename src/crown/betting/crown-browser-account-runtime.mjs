import { randomUUID } from 'node:crypto'

import { normalizePublicHttpsExactOrigin } from '../login/crown-origin.mjs'
import { takePortableChromiumFailureOwnership } from '../login/portable-chromium.mjs'

function fail(code) {
  throw Object.assign(new Error(code), { code })
}

function safeRuntimeError(error, fallback = 'browser-account-context-create-failed') {
  const candidate = String(error?.code || error?.message || '').trim()
  const code = /^(?:browser|portable-chromium|lease)(?:-[a-z0-9]+)+$/.test(candidate)
    ? candidate
    : fallback
  return Object.assign(new Error(code), { code })
}

function accountId(value) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    fail('browser-account-id-invalid')
  }
  return normalized
}

function normalizedAccount(account) {
  const id = accountId(account?.accountId || account?.id)
  const username = String(account?.username || '').trim()
  if (!username) fail('browser-account-username-required')
  let origin
  try {
    origin = normalizePublicHttpsExactOrigin(account?.loginUrl || account?.websiteUrl)
  } catch {
    fail('browser-account-origin-invalid')
  }
  return {
    ...account,
    id,
    accountId: id,
    username,
    loginUrl: origin,
    origin,
  }
}

function sameBinding(state, account) {
  return state.accountId === account.accountId
    && state.username === account.username
    && state.origin === account.origin
}

function verifiedGameList(result) {
  return result?.classification?.hasServerResponse === true
    && result.classification.loginExpired !== true
    && result.classification.parseError !== true
    && result?.requestScope?.endpointKind === 'get_game_list'
}

async function executorFence(assertFence) {
  if (typeof assertFence !== 'function') fail('browser-account-executor-fence-required')
  await assertFence()
}

export class CrownBrowserAccountRuntime {
  constructor({
    createProfileLease,
    launchBrowser,
    createApiClient,
    generation = randomUUID,
    now = () => new Date(),
  } = {}) {
    if (typeof createProfileLease !== 'function') fail('browser-profile-lease-factory-required')
    if (typeof launchBrowser !== 'function') fail('browser-launcher-required')
    if (typeof createApiClient !== 'function') fail('browser-api-client-factory-required')
    if (typeof generation !== 'function') fail('browser-context-generation-factory-required')
    if (typeof now !== 'function') fail('browser-runtime-clock-required')
    this.createProfileLease = createProfileLease
    this.launchBrowser = launchBrowser
    this.createApiClient = createApiClient
    this.generation = generation
    this.now = now
    this.states = new Map()
    this.unresolvedStates = new Map()
    this.queues = new Map()
    this.sessionStatuses = new Map()
    this.closing = false
  }

  _setStatus(id, state, lastApiSuccessAt) {
    const previous = this.sessionStatuses.get(id)
    this.sessionStatuses.set(id, {
      accountId: id,
      state,
      lastApiSuccessAt: lastApiSuccessAt === undefined ? previous?.lastApiSuccessAt || null : lastApiSuccessAt,
    })
  }

  _recordApiSuccess(state) {
    const value = this.now()
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) fail('browser-runtime-clock-invalid')
    state.lastApiSuccessAt = date.toISOString()
    this._setStatus(state.accountId, 'ready', state.lastApiSuccessAt)
  }

  statusSnapshot({ heartbeatAt = new Date().toISOString() } = {}) {
    const parsedHeartbeat = typeof heartbeatAt === 'string' ? Date.parse(heartbeatAt) : NaN
    const heartbeat = Number.isFinite(parsedHeartbeat) && new Date(parsedHeartbeat).toISOString() === heartbeatAt
      ? heartbeatAt
      : null
    const statuses = new Map([...this.sessionStatuses].map(([id, status]) => [id, { ...status }]))
    for (const id of this.queues.keys()) {
      if (!this.states.has(id) && ![...this.unresolvedStates.values()].some((state) => state.accountId === id)) {
        const previous = statuses.get(id)
        statuses.set(id, { accountId: id, state: 'starting', lastApiSuccessAt: previous?.lastApiSuccessAt || null })
      }
    }
    for (const state of this.states.values()) {
      statuses.set(state.accountId, {
        accountId: state.accountId,
        state: state.closing || state.accepting !== true ? 'stale' : 'ready',
        lastApiSuccessAt: state.lastApiSuccessAt || null,
      })
    }
    for (const state of this.unresolvedStates.values()) {
      statuses.set(state.accountId, {
        accountId: state.accountId,
        state: 'blocked',
        lastApiSuccessAt: state.lastApiSuccessAt || null,
      })
    }
    return {
      accounts: [...statuses.values()].sort((left, right) => left.accountId.localeCompare(right.accountId)).map((status) => ({
        accountId: status.accountId,
        state: status.state,
        lastHeartbeatAt: heartbeat,
        lastApiSuccessAt: status.lastApiSuccessAt,
      })),
    }
  }

  _queue(id, operation) {
    const previous = this.queues.get(id) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.queues.set(id, current)
    return current.finally(() => {
      if (this.queues.get(id) === current) this.queues.delete(id)
    })
  }

  async _assertState(state, assertFence) {
    await executorFence(assertFence)
    state.lease.assertFence()
    if (
      state.accepting !== true
      || this.closing
      || this.states.get(state.accountId) !== state
      || (state.session && state.contextGeneration !== state.session.contextGeneration)
    ) fail('browser-account-context-stale')
  }

  _watchContext(state) {
    const invalidate = () => {
      if (state.closing || state.accepting !== true) return
      state.accepting = false
      void this._queue(state.accountId, () => this._closeState(state))
    }
    state.page?.on?.('crash', invalidate)
    state.page?.on?.('download', (download) => {
      Promise.resolve(download?.cancel?.()).catch(() => {})
      invalidate()
    })
    state.page?.on?.('framenavigated', (frame) => {
      const mainFrame = state.page?.mainFrame?.()
      if (mainFrame && frame !== mainFrame) return
      const value = typeof frame?.url === 'function' ? frame.url() : frame?.url
      if (!value || value === 'about:blank') return
      try {
        if (new URL(String(value)).origin !== state.origin) invalidate()
      } catch {
        invalidate()
      }
    })
    state.context?.on?.('page', (page) => {
      if (page === state.page) return
      Promise.resolve(page?.close?.()).catch(() => {})
      invalidate()
    })
    state.context?.on?.('close', invalidate)
    state.context?.on?.('disconnected', invalidate)
  }

  async _closeState(state) {
    if (!state) return false
    if (state.closePromise) return state.closePromise
    state.accepting = false
    state.closing = true
    if (this.states.get(state.accountId) === state) this.states.delete(state.accountId)
    state.closePromise = (async () => {
      let closed = !state.launchStarted && !state.context
      try {
        if (state.context && typeof state.context.close === 'function') {
          await state.context.close()
          closed = true
        }
      } catch {
        // A profile lease is only released after Chromium confirms closure.
      } finally {
        try { state.lease.stopHeartbeat?.() } catch {}
      }
      if (closed) {
        try { state.lease.release() } catch {}
        this.unresolvedStates.delete(state.contextGeneration)
        state.session = null
        state.client = null
        state.page = null
        state.context = null
      } else {
        this.unresolvedStates.set(state.contextGeneration, state)
      }
      return closed
    })()
    return state.closePromise
  }

  async _createState(account, assertFence, signal) {
    let state = null
    try {
      await executorFence(assertFence)
      if (this.closing) fail('browser-account-runtime-closing')
      if ([...this.unresolvedStates.values()].some((current) => current.accountId === account.accountId)) {
        fail('browser-account-context-close-unresolved')
      }
      const contextGeneration = String(this.generation())
      if (!contextGeneration) fail('browser-context-generation-invalid')
      const lease = this.createProfileLease({ accountId: account.accountId, account })
      if (!lease || typeof lease.acquire !== 'function' || typeof lease.assertFence !== 'function') {
        fail('browser-profile-lease-invalid')
      }
      state = {
        accountId: account.accountId,
        username: account.username,
        origin: account.origin,
        contextGeneration,
        lease,
        context: null,
        page: null,
        client: null,
        session: null,
        accepting: true,
        closing: false,
        closePromise: null,
        launchStarted: false,
        lastApiSuccessAt: this.sessionStatuses.get(account.accountId)?.lastApiSuccessAt || null,
      }
      lease.acquire()
      lease.assertFence()
      lease.startHeartbeat?.({
        onError: () => {
          state.accepting = false
          void this._queue(state.accountId, () => this._closeState(state))
        },
      })
      state.launchStarted = true
      const browser = await this.launchBrowser({
        accountId: account.accountId,
        account,
        profileLease: lease,
      })
      if (!browser?.context || !browser?.page) fail('browser-context-invalid')
      state.context = browser.context
      state.page = browser.page
      this.states.set(account.accountId, state)
      this._watchContext(state)

      await this._assertState(state, assertFence)
      let pageOrigin = ''
      try { pageOrigin = new URL(String(state.page.url?.() || '')).origin } catch {}
      if (pageOrigin !== account.origin) {
        await state.page.goto(account.origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      }
      await state.page.waitForTimeout?.(500)
      await this._assertState(state, assertFence)

      const client = this.createApiClient({ page: state.page, context: state.context, origin: account.origin })
      if (!client || typeof client.login !== 'function' || typeof client.fetchGameList !== 'function') {
        fail('browser-api-client-invalid')
      }
      state.client = client
      const loginResult = await client.login({ account, signal })
      await this._assertState(state, assertFence)
      const loginSession = loginResult?.session
      if (
        !loginSession
        || loginSession.accountId !== account.accountId
        || loginSession.username !== account.username
        || String(loginSession.uid || '').trim() === ''
        || String(loginSession.protocolVersion || '').trim() === ''
        || !['production-login-response', 'production-session-metadata']
          .includes(loginSession.protocolVersionEvidence?.source)
        || loginSession.protocolVersionEvidence?.captured !== true
        || loginSession.protocolVersionEvidence?.verified !== true
      ) fail('browser-login-session-invalid')
      let sessionOrigin
      try {
        sessionOrigin = normalizePublicHttpsExactOrigin(
          loginSession.origin || loginSession.baseUrl,
        )
      } catch {
        fail('browser-login-session-invalid')
      }
      if (sessionOrigin !== account.origin) fail('browser-login-session-invalid')

      state.session = Object.freeze({
        accountId: account.accountId,
        username: account.username,
        origin: account.origin,
        baseUrl: account.origin,
        uid: String(loginSession.uid),
        protocolVersion: String(loginSession.protocolVersion),
        protocolVersionEvidence: Object.freeze({
          source: loginSession.protocolVersionEvidence?.source,
          captured: loginSession.protocolVersionEvidence?.captured === true,
          verified: loginSession.protocolVersionEvidence?.verified === true,
        }),
        contextGeneration: state.contextGeneration,
      })
      const gameList = await client.fetchGameList(state.session, { signal })
      await this._assertState(state, assertFence)
      if (!verifiedGameList(gameList)) fail('browser-game-list-verification-failed')
      this._recordApiSuccess(state)
      return state.session
    } catch (error) {
      const safeError = safeRuntimeError(error)
      const failedBrowser = takePortableChromiumFailureOwnership(error)
      if (state && !state.context && failedBrowser?.context) {
        state.context = failedBrowser.context
      }
      if (state) await this._closeState(state)
      const code = String(safeError.code || '')
      this._setStatus(account.accountId,
        /(?:login|game-list)/.test(code) ? 'login_required'
          : /(?:lease|close-unresolved|context-stale)/.test(code) ? 'blocked' : 'error')
      throw safeError
    }
  }

  async _ensure(account, assertFence, signal) {
    if (this.closing) fail('browser-account-runtime-closing')
    if ([...this.unresolvedStates.values()].some((state) => state.accountId === account.accountId)) {
      fail('browser-account-context-close-unresolved')
    }
    const current = this.states.get(account.accountId)
    if (current && sameBinding(current, account) && current.accepting === true) {
      try {
        await this._assertState(current, assertFence)
        this._setStatus(current.accountId, 'ready', current.lastApiSuccessAt || null)
        return current.session
      } catch (error) {
        await this._closeState(current)
        throw error
      }
    }
    if (current) await this._closeState(current)
    return this._createState(account, assertFence, signal)
  }

  ensureBettingSession({ account, assertFence, signal } = {}) {
    if (this.closing) return Promise.reject(Object.assign(new Error('browser-account-runtime-closing'), { code: 'browser-account-runtime-closing' }))
    const normalized = normalizedAccount(account)
    this._setStatus(normalized.accountId, 'starting')
    return this._queue(normalized.accountId, () => this._ensure(normalized, assertFence, signal))
  }

  _boundState(account, session) {
    const state = this.states.get(account.accountId)
    if (
      !state
      || !sameBinding(state, account)
      || state.accepting !== true
      || !session
      || session.accountId !== state.accountId
      || session.username !== state.username
      || session.contextGeneration !== state.contextGeneration
      || String(session.uid || '') !== String(state.session?.uid || '')
    ) fail('browser-betting-session-stale')
    return state
  }

  async _request({ account, session, assertFence, invoke }) {
    const state = this._boundState(account, session)
    try {
      await this._assertState(state, assertFence)
      const result = await invoke(state.client, state.session)
      await this._assertState(state, assertFence)
      this._recordApiSuccess(state)
      return result
    } catch (error) {
      await this._closeState(state)
      throw error
    }
  }

  fetchFreshExecutionBalance({ account, session, assertFence, signal } = {}) {
    const normalized = normalizedAccount(account)
    return this._queue(normalized.accountId, () => this._request({
      account: normalized,
      session,
      assertFence,
      invoke: async (client, trustedSession) => {
        if (typeof client.fetchAccountSummary !== 'function') fail('browser-account-summary-client-required')
        const result = await client.fetchAccountSummary(trustedSession, { signal })
        return { ...result, session: trustedSession }
      },
    }))
  }

  postPreviewForm({ account, session, wireFields, assertFence, signal } = {}) {
    const normalized = normalizedAccount(account)
    return this._queue(normalized.accountId, () => this._request({
      account: normalized,
      session,
      assertFence,
      invoke: (client, trustedSession) => client.postPreview({
        session: trustedSession,
        wireFields,
        signal,
      }),
    }))
  }

  postSubmitForm({ account, session, wireFields, assertFence, signal, beforeDispatch } = {}) {
    const normalized = normalizedAccount(account)
    return this._queue(normalized.accountId, () => this._request({
      account: normalized,
      session,
      assertFence,
      invoke: (client, trustedSession) => client.postSubmit({
        session: trustedSession,
        wireFields,
        signal,
        beforeDispatch: async () => {
          await this._assertState(this._boundState(normalized, trustedSession), assertFence)
          if (typeof beforeDispatch !== 'function') fail('browser-submit-before-dispatch-required')
          await beforeDispatch()
          await this._assertState(this._boundState(normalized, trustedSession), assertFence)
        },
      }),
    }))
  }

  queryResultForm(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['account', 'session', 'assertFence', 'signal'].includes(key))) {
      fail('browser-result-input-not-allowed')
    }
    const { account, session, assertFence, signal } = input
    const normalized = normalizedAccount(account)
    return this._queue(normalized.accountId, () => this._request({
      account: normalized,
      session,
      assertFence,
      invoke: (client, trustedSession) => client.queryResult({
        session: trustedSession,
        signal,
      }),
    }))
  }

  verifiedBettingSessionFor({ account, session } = {}) {
    let normalized
    try { normalized = normalizedAccount(account) } catch { return null }
    try {
      const state = this._boundState(normalized, session)
      state.lease.assertFence()
      return state.session
    } catch {
      return null
    }
  }

  closeAccount({ accountId: inputAccountId } = {}) {
    const id = accountId(inputAccountId)
    return this._queue(id, async () => {
      const active = this.states.get(id)
      if (active) {
        const closed = await this._closeState(active)
        if (closed) this.sessionStatuses.delete(id)
        else this._setStatus(id, 'blocked')
        return closed
      }
      const closed = ![...this.unresolvedStates.values()].some((state) => state.accountId === id)
      if (closed) this.sessionStatuses.delete(id)
      else this._setStatus(id, 'blocked')
      return closed
    })
  }

  async shutdown() {
    this.closing = true
    const results = []
    const closeActiveStates = async () => {
      const active = [...this.states.values()]
      if (active.length === 0) return
      results.push(...await Promise.allSettled(active.map((state) => this._closeState(state))))
    }
    await closeActiveStates()
    while (this.queues.size > 0) {
      await Promise.allSettled([...new Set(this.queues.values())])
      await closeActiveStates()
    }
    return {
      ok: results.every((result) => result.status === 'fulfilled' && result.value === true)
        && this.states.size === 0
        && this.unresolvedStates.size === 0
        && this.queues.size === 0,
    }
  }
}

export default CrownBrowserAccountRuntime
