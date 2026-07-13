import crypto from 'node:crypto'

import { normalizePublicHttpsExactOrigin } from './crown-origin.mjs'

const ACTIVE_STATES = new Set(['opening', 'awaiting-user', 'verifying'])
const PUBLIC_STATES = new Set(['idle', 'opening', 'awaiting-user', 'verifying', 'verified', 'failed'])

export class ManualLoginError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ManualLoginError'
    this.code = code
  }
}

function fail(code) {
  throw new ManualLoginError(code)
}

function requiredId(value, code) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) fail(code)
  return normalized
}

function requiredUsername(value) {
  const normalized = String(value || '').trim()
  if (!normalized) fail('manual-login-username-required')
  return normalized
}

function safeNow(now) {
  const value = Number(now())
  if (!Number.isSafeInteger(value) || value < 0) fail('manual-login-clock-invalid')
  return value
}

function requestValue(request, field) {
  const value = request?.[field]
  return typeof value === 'function' ? value.call(request) : value
}

function urlAtExactOrigin(value, origin, expectedPath = '') {
  try {
    const url = new URL(String(value || ''))
    return url.origin === origin && (!expectedPath || url.pathname === expectedPath)
  } catch {
    return false
  }
}

function xmlValue(text, tag) {
  const match = String(text || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  if (!match) return ''
  return match[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function safeUid(value) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 4096 || /[\u0000-\u001f\u007f]/.test(normalized)) return ''
  return normalized
}

function cookieObject(cookies, origin) {
  const hostname = new URL(origin).hostname.toLowerCase()
  const result = Object.create(null)
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const domain = String(cookie?.domain || '').toLowerCase().replace(/^\./, '')
    if (domain !== hostname) continue
    const name = String(cookie?.name || '')
    const value = String(cookie?.value ?? '')
    if (!name || /[\u0000-\u0020\u007f()<>@,;:\\"/\[\]?={}]/.test(name)) continue
    if (Object.hasOwn(result, name) && result[name] !== value) {
      fail('manual-login-cookie-conflict')
    }
    result[name] = value
  }
  return { ...result }
}

function verifiedSession(result, candidate, origin) {
  if (
    result?.classification?.hasServerResponse !== true
    || result.classification.loginExpired === true
    || result.classification.parseError === true
    || result?.requestScope?.endpointKind !== 'get_game_list'
  ) fail('manual-login-verification-failed')

  const session = result?.session
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    fail('manual-login-verification-failed')
  }
  let baseUrl
  try {
    baseUrl = normalizePublicHttpsExactOrigin(session.baseUrl)
  } catch {
    fail('manual-login-verification-failed')
  }
  if (
    safeUid(session.uid) !== candidate.uid
    || String(session.accountId || '') !== candidate.accountId
    || String(session.username || '').trim() !== candidate.username
    || baseUrl !== origin
    || !session.cookies
    || typeof session.cookies !== 'object'
    || Array.isArray(session.cookies)
  ) fail('manual-login-verification-failed')

  return {
    uid: candidate.uid,
    cookies: { ...session.cookies },
    accountId: candidate.accountId,
    username: candidate.username,
    baseUrl: origin,
    savedAt: Number.isSafeInteger(Number(session.savedAt)) ? Number(session.savedAt) : candidate.savedAt,
  }
}

async function closeContext(challenge) {
  if (!challenge.closePromise) {
    challenge.closed = true
    challenge.closePromise = (async () => {
      try {
        await challenge.context?.close?.()
      } catch {
        // Browser cleanup must not replace the stable login result.
      } finally {
        challenge.context = null
        challenge.page = null
      }
    })()
  }
  await challenge.closePromise
}

export class ManualLoginBridge {
  constructor({
    installationId,
    launchBrowser,
    verifyGameList,
    replaceSessionAtomically,
    challengeTtlMs = 5 * 60_000,
    tombstoneTtlMs = 60_000,
    maxTombstones = 256,
    now = Date.now,
    randomBytes = crypto.randomBytes,
  } = {}) {
    this.installationId = requiredId(installationId, 'manual-login-installation-id-invalid')
    if (typeof launchBrowser !== 'function') fail('manual-login-browser-launcher-required')
    if (typeof verifyGameList !== 'function') fail('manual-login-verifier-required')
    if (typeof replaceSessionAtomically !== 'function') fail('manual-login-session-writer-required')
    if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs <= 0 || challengeTtlMs > 10 * 60_000) {
      fail('manual-login-challenge-ttl-invalid')
    }
    if (!Number.isSafeInteger(tombstoneTtlMs) || tombstoneTtlMs <= 0 || tombstoneTtlMs > 10 * 60_000) {
      fail('manual-login-tombstone-ttl-invalid')
    }
    if (!Number.isSafeInteger(maxTombstones) || maxTombstones < 1 || maxTombstones > 1_024) {
      fail('manual-login-tombstone-limit-invalid')
    }
    if (typeof now !== 'function' || typeof randomBytes !== 'function') fail('manual-login-dependency-invalid')

    this.launchBrowser = launchBrowser
    this.verifyGameList = verifyGameList
    this.replaceSessionAtomically = replaceSessionAtomically
    this.challengeTtlMs = challengeTtlMs
    this.tombstoneTtlMs = tombstoneTtlMs
    this.maxTombstones = maxTombstones
    this.now = now
    this.randomBytes = randomBytes
    this.challenges = new Map()
    this.activeByAccount = new Map()
  }

  _challengeId({ nonce, accountId, origin }) {
    const binding = crypto.createHash('sha256')
      .update(this.installationId)
      .update('\0')
      .update(accountId)
      .update('\0')
      .update(origin)
      .update('\0')
      .update(nonce)
      .digest('hex')
      .slice(0, 32)
    return `${nonce}.${binding}`
  }

  _public(challenge) {
    if (!PUBLIC_STATES.has(challenge.status)) fail('manual-login-state-invalid')
    return {
      challengeId: challenge.challengeId,
      accountId: challenge.accountId,
      origin: challenge.origin,
      status: challenge.status,
      errorCode: challenge.errorCode,
      expiresAt: challenge.expiresAt,
    }
  }

  _lookup({ accountId, challengeId }) {
    this._pruneTombstones(safeNow(this.now))
    const normalizedAccountId = requiredId(accountId, 'manual-login-account-id-invalid')
    const normalizedChallengeId = String(challengeId || '').trim()
    const challenge = this.challenges.get(normalizedChallengeId)
    if (!challenge) fail('manual-login-challenge-not-found')
    const expectedId = this._challengeId(challenge)
    if (
      challenge.challengeId !== expectedId
      || challenge.installationId !== this.installationId
      || challenge.accountId !== normalizedAccountId
    ) fail('manual-login-challenge-binding-mismatch')
    return challenge
  }

  _recordUid(challenge, uid) {
    if (challenge.evidenceFrozen) return
    const normalized = safeUid(uid)
    if (!normalized) return
    if (challenge.uid && challenge.uid !== normalized) {
      this._markSecurityViolation(challenge, 'manual-login-session-evidence-conflict')
      return
    }
    challenge.uid = normalized
    challenge.uidSequence = challenge.loginSequence
  }

  _captureRequest(challenge, request) {
    if (challenge.evidenceFrozen) return
    if (String(requestValue(request, 'method') || '').toUpperCase() !== 'POST') return
    let form
    try {
      form = new URLSearchParams(String(requestValue(request, 'postData') || ''))
    } catch {
      return
    }
    const url = requestValue(request, 'url')
    if (urlAtExactOrigin(url, challenge.origin, '/transform_nl.php')) {
      if (
        form.getAll('p').length !== 1
        || form.get('p') !== 'chk_login'
        || form.getAll('username').length !== 1
        || form.get('username') !== challenge.account.username
      ) return
      challenge.loginSequence += 1
      challenge.loginSucceededSequence = 0
      challenge.loginRequests.set(request, challenge.loginSequence)
      challenge.uid = ''
      challenge.uidSequence = 0
      return
    }
    if (!urlAtExactOrigin(url, challenge.origin, '/transform.php')) return
    if (
      challenge.loginSequence < 1
      || challenge.loginSucceededSequence !== challenge.loginSequence
      || form.getAll('p').length !== 1
      || form.get('p') !== 'get_game_list'
      || form.getAll('uid').length !== 1
    ) return
    this._recordUid(challenge, form.get('uid'))
  }

  _captureResponse(challenge, response) {
    const task = (async () => {
      if (challenge.evidenceFrozen) return
      if (!urlAtExactOrigin(requestValue(response, 'url'), challenge.origin, '/transform_nl.php')) return
      const loginRequest = requestValue(response, 'request')
      const sequence = challenge.loginRequests.get(loginRequest)
      if (!sequence || sequence !== challenge.loginSequence) return
      const status = Number(requestValue(response, 'status'))
      if (!Number.isInteger(status) || status < 200 || status >= 300) return
      const body = await response?.text?.()
      if (challenge.evidenceFrozen || sequence !== challenge.loginSequence) return
      if (xmlValue(body, 'status') !== '200') return
      challenge.loginSucceededSequence = sequence
      this._recordUid(challenge, xmlValue(body, 'uid'))
    })().catch(() => {})
    challenge.evidenceTasks.add(task)
    task.finally(() => challenge.evidenceTasks.delete(task))
  }

  _attachPage(challenge, page) {
    if (!page || challenge.attachedPages.has(page)) return
    challenge.attachedPages.add(page)
    page.on?.('request', (request) => this._captureRequest(challenge, request))
    page.on?.('response', (response) => this._captureResponse(challenge, response))
    page.on?.('download', (download) => {
      this._markSecurityViolation(challenge, 'manual-login-download-blocked')
      Promise.resolve(download?.cancel?.()).catch(() => {})
    })
    page.on?.('framenavigated', (frame) => {
      const url = requestValue(frame, 'url')
      if (url && url !== 'about:blank' && !urlAtExactOrigin(url, challenge.origin)) {
        this._markSecurityViolation(challenge, 'manual-login-cross-origin-navigation')
      }
    })
  }

  async _installGuards(challenge) {
    const { context, page } = challenge
    if (typeof context.route !== 'function') fail('manual-login-browser-context-invalid')
    await context.route('**/*', async (route, request) => {
      const navigation = Boolean(requestValue(request, 'isNavigationRequest'))
      const url = requestValue(request, 'url')
      if (navigation && !urlAtExactOrigin(url, challenge.origin)) {
        this._markSecurityViolation(challenge, 'manual-login-cross-origin-navigation')
        await route.abort?.('blockedbyclient')
        return
      }
      await route.continue?.()
    })
    this._attachPage(challenge, page)
    const primaryUrl = page.url?.()
    if (primaryUrl && primaryUrl !== 'about:blank' && !urlAtExactOrigin(primaryUrl, challenge.origin)) {
      this._markSecurityViolation(challenge, 'manual-login-cross-origin-navigation')
    }
    for (const existingPage of context.pages?.() || []) {
      if (existingPage === page) continue
      this._markSecurityViolation(challenge, 'manual-login-unexpected-page')
      await existingPage?.close?.().catch(() => {})
    }
    context.on?.('page', (newPage) => {
      if (newPage === page) return
      this._markSecurityViolation(challenge, 'manual-login-unexpected-page')
      Promise.resolve(newPage?.close?.()).catch(() => {})
    })
  }

  _clearActive(challenge) {
    if (this.activeByAccount.get(challenge.accountId) === challenge.challengeId) {
      this.activeByAccount.delete(challenge.accountId)
    }
  }

  _markSecurityViolation(challenge, code) {
    if (challenge.evidenceFrozen || !ACTIVE_STATES.has(challenge.status)) return
    challenge.securityViolation = code
    challenge.generation += 1
  }

  _pruneTombstones(now) {
    const tombstones = []
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.terminalAt === null) continue
      if (now >= challenge.terminalAt + this.tombstoneTtlMs) {
        this.challenges.delete(challengeId)
      } else {
        tombstones.push(challenge)
      }
    }
    tombstones.sort((left, right) => left.terminalAt - right.terminalAt)
    for (let index = 0; index < tombstones.length - this.maxTombstones; index += 1) {
      this.challenges.delete(tombstones[index].challengeId)
    }
  }

  _markTerminal(challenge, status, errorCode) {
    challenge.status = status
    challenge.errorCode = errorCode
    challenge.generation += 1
    challenge.evidenceFrozen = true
    challenge.terminalAt = safeNow(this.now)
    challenge.uid = ''
    challenge.uidSequence = 0
    challenge.loginSucceededSequence = 0
    challenge.account = { id: challenge.accountId, accountId: challenge.accountId, loginUrl: challenge.origin }
    challenge.evidenceTasks.clear()
    challenge.loginRequests = new WeakMap()
    this._clearActive(challenge)
    this._pruneTombstones(challenge.terminalAt)
  }

  async _fail(challenge, code) {
    if (challenge.terminalAt !== null) {
      throw new ManualLoginError(challenge.errorCode || code)
    }
    this._markTerminal(challenge, 'failed', code)
    await closeContext(challenge)
    throw new ManualLoginError(code)
  }

  _expired(challenge) {
    return ACTIVE_STATES.has(challenge.status) && safeNow(this.now) >= challenge.expiresAt
  }

  async _assertConfirmFence(challenge, generation) {
    if (challenge.errorCode || challenge.status === 'failed') {
      throw new ManualLoginError(challenge.errorCode || 'manual-login-challenge-state-invalid')
    }
    if (challenge.securityViolation) return this._fail(challenge, 'manual-login-security-violation')
    if (this._expired(challenge)) return this._fail(challenge, 'manual-login-challenge-expired')
    if (
      challenge.status !== 'verifying'
      || challenge.generation !== generation
      || this.activeByAccount.get(challenge.accountId) !== challenge.challengeId
    ) fail('manual-login-challenge-state-invalid')
  }

  async _assertOpenFence(challenge, generation, returnedContext = null) {
    if (this._expired(challenge) && challenge.terminalAt === null) {
      this._markTerminal(challenge, 'failed', 'manual-login-challenge-expired')
    }
    if (challenge.securityViolation && challenge.terminalAt === null) {
      this._markTerminal(challenge, 'failed', 'manual-login-security-violation')
    }
    const valid = challenge.terminalAt === null
      && challenge.status === 'opening'
      && challenge.generation === generation
      && this.activeByAccount.get(challenge.accountId) === challenge.challengeId
    if (valid) return

    if (returnedContext && returnedContext !== challenge.context) {
      await returnedContext.close?.().catch(() => {})
    } else {
      await closeContext(challenge)
    }
    throw new ManualLoginError(challenge.errorCode || 'manual-login-challenge-state-invalid')
  }

  async openManualLogin({ account } = {}) {
    this._pruneTombstones(safeNow(this.now))
    const accountId = requiredId(account?.accountId || account?.id, 'manual-login-account-id-invalid')
    const username = requiredUsername(account?.username)
    const origin = normalizePublicHttpsExactOrigin(account?.loginUrl || account?.websiteUrl)
    const activeId = this.activeByAccount.get(accountId)
    const active = activeId ? this.challenges.get(activeId) : null
    if (active && ACTIVE_STATES.has(active.status) && !this._expired(active)) {
      fail('manual-login-busy')
    }
    if (active && this._expired(active)) {
      this._markTerminal(active, 'failed', 'manual-login-challenge-expired')
      await closeContext(active)
    }

    const nonceBytes = this.randomBytes(24)
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length < 16) fail('manual-login-nonce-invalid')
    const nonce = nonceBytes.toString('base64url')
    const challengeId = this._challengeId({ nonce, accountId, origin })
    const createdAt = safeNow(this.now)
    const challenge = {
      challengeId,
      nonce,
      installationId: this.installationId,
      accountId,
      origin,
      account: { id: accountId, accountId, username, loginUrl: origin },
      status: 'opening',
      errorCode: '',
      createdAt,
      expiresAt: createdAt + this.challengeTtlMs,
      context: null,
      page: null,
      closed: false,
      closePromise: null,
      uid: '',
      uidSequence: 0,
      loginSequence: 0,
      loginSucceededSequence: 0,
      securityViolation: '',
      evidenceFrozen: false,
      generation: 0,
      commitStarted: false,
      terminalAt: null,
      evidenceTasks: new Set(),
      attachedPages: new WeakSet(),
      loginRequests: new WeakMap(),
    }
    this.challenges.set(challengeId, challenge)
    this.activeByAccount.set(accountId, challengeId)
    const openGeneration = challenge.generation

    try {
      const browser = await this.launchBrowser({ accountId, origin })
      if (!browser?.context || !browser?.page) fail('manual-login-browser-context-invalid')
      await this._assertOpenFence(challenge, openGeneration, browser.context)
      challenge.context = browser.context
      challenge.page = browser.page
      await this._installGuards(challenge)
      await this._assertOpenFence(challenge, openGeneration)
      if (challenge.securityViolation) return this._fail(challenge, 'manual-login-security-violation')
      await challenge.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this._assertOpenFence(challenge, openGeneration)
      if (challenge.securityViolation || !urlAtExactOrigin(challenge.page.url?.(), origin)) {
        return this._fail(challenge, 'manual-login-security-violation')
      }
      challenge.status = 'awaiting-user'
      return this._public(challenge)
    } catch (error) {
      if (error instanceof ManualLoginError) {
        if (challenge.terminalAt === null && challenge.status !== 'failed') {
          challenge.status = 'failed'
          challenge.errorCode = error.code
          this._clearActive(challenge)
          await closeContext(challenge)
        }
        throw error
      }
      return this._fail(challenge, 'manual-login-browser-open-failed')
    }
  }

  getManualLoginStatus(input = {}) {
    const challenge = this._lookup(input)
    if (this._expired(challenge)) {
      this._markTerminal(challenge, 'failed', 'manual-login-challenge-expired')
      void closeContext(challenge)
    }
    return this._public(challenge)
  }

  async confirmManualLogin(input = {}) {
    const challenge = this._lookup(input)
    if (this._expired(challenge)) return this._fail(challenge, 'manual-login-challenge-expired')
    if (challenge.status !== 'awaiting-user') fail('manual-login-challenge-state-invalid')
    challenge.status = 'verifying'
    const generation = ++challenge.generation

    await Promise.allSettled([...challenge.evidenceTasks])
    await this._assertConfirmFence(challenge, generation)
    if (!urlAtExactOrigin(challenge.page?.url?.(), challenge.origin)) {
      return this._fail(challenge, 'manual-login-security-violation')
    }
    if (
      !challenge.uid
      || challenge.uidSequence !== challenge.loginSequence
      || challenge.loginSucceededSequence !== challenge.loginSequence
    ) {
      return this._fail(challenge, 'manual-login-session-evidence-missing')
    }

    let cookies
    try {
      cookies = cookieObject(await challenge.context.cookies([challenge.origin]), challenge.origin)
    } catch (error) {
      if (error instanceof ManualLoginError) return this._fail(challenge, 'manual-login-security-violation')
      return this._fail(challenge, 'manual-login-cookie-read-failed')
    }
    await this._assertConfirmFence(challenge, generation)

    const candidate = {
      uid: challenge.uid,
      cookies,
      accountId: challenge.accountId,
      username: challenge.account.username,
      baseUrl: challenge.origin,
      savedAt: safeNow(this.now),
    }
    const accountForSave = { ...challenge.account }
    challenge.evidenceFrozen = true
    await closeContext(challenge)
    await this._assertConfirmFence(challenge, generation)

    let session
    try {
      const result = await this.verifyGameList(candidate, { signal: input.signal })
      session = verifiedSession(result, candidate, challenge.origin)
    } catch {
      return this._fail(challenge, 'manual-login-verification-failed')
    }
    await this._assertConfirmFence(challenge, generation)

    try {
      challenge.commitStarted = true
      await this._assertConfirmFence(challenge, generation)
      await this.replaceSessionAtomically({ account: accountForSave, session })
    } catch {
      return this._fail(challenge, 'manual-login-session-save-failed')
    }

    this._markTerminal(challenge, 'verified', '')
    await closeContext(challenge)
    return this._public(challenge)
  }

  async cancelManualLogin(input = {}) {
    const challenge = this._lookup(input)
    if (!ACTIVE_STATES.has(challenge.status)) fail('manual-login-challenge-state-invalid')
    if (challenge.commitStarted) fail('manual-login-challenge-state-invalid')
    this._markTerminal(challenge, 'failed', 'manual-login-cancelled')
    await closeContext(challenge)
    return this._public(challenge)
  }
}

export default ManualLoginBridge
