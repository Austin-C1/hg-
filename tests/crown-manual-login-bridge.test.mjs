import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  ManualLoginBridge,
  ManualLoginError,
} from '../src/crown/login/manual-login-bridge.mjs'

const ORIGIN = 'https://crown.example.com'

class FakePage extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.currentUrl = url
    this.gotoCalls = []
    this.closeCalls = 0
  }

  async goto(url, options) {
    this.gotoCalls.push({ url, options })
    this.currentUrl = `${url}/login`
  }

  url() {
    return this.currentUrl
  }

  async close() {
    this.closeCalls += 1
  }
}

class FakeContext extends EventEmitter {
  constructor(page, extraPages = []) {
    super()
    this.page = page
    this.extraPages = extraPages
    this.routes = []
    this.cookieCalls = []
    this.closeCalls = 0
    this.storageStateCalls = 0
  }

  async route(pattern, handler) {
    this.routes.push({ pattern, handler })
  }

  pages() {
    return [this.page, ...this.extraPages]
  }

  async cookies(urls) {
    this.cookieCalls.push(urls)
    return [
      { name: 'SID', value: 'exact-cookie', domain: 'crown.example.com', path: '/', secure: true },
      { name: 'FOREIGN', value: 'foreign-cookie', domain: 'evil.example.com', path: '/', secure: true },
    ]
  }

  async storageState() {
    this.storageStateCalls += 1
    throw new Error('storageState must never be called')
  }

  async close() {
    this.closeCalls += 1
  }
}

function request({ url = `${ORIGIN}/transform_nl.php`, body = 'p=chk_login&username=owner-user', navigation = false } = {}) {
  return {
    url: () => url,
    method: () => 'POST',
    postData: () => body,
    isNavigationRequest: () => navigation,
  }
}

function gameListRequest({ uid = 'owner-uid' } = {}) {
  return request({ url: `${ORIGIN}/transform.php`, body: `p=get_game_list&uid=${encodeURIComponent(uid)}` })
}

function response({ url = `${ORIGIN}/transform_nl.php`, body = '<serverresponse><status>200</status><uid>owner-uid</uid></serverresponse>', associatedRequest = request() } = {}) {
  return {
    url: () => url,
    status: () => 200,
    text: async () => body,
    request: () => associatedRequest,
  }
}

function setup({ verifyResult, verifyGameList, launchBrowser, now = () => 1_000, ttlMs = 60_000, tombstoneTtlMs, maxTombstones, randomBytes, extraPages = [] } = {}) {
  const page = new FakePage()
  const context = new FakeContext(page, extraPages)
  const launched = []
  const verified = []
  const committed = []
  const bridge = new ManualLoginBridge({
    installationId: 'install-A',
    challengeTtlMs: ttlMs,
    ...(tombstoneTtlMs === undefined ? {} : { tombstoneTtlMs }),
    ...(maxTombstones === undefined ? {} : { maxTombstones }),
    now,
    randomBytes: randomBytes || (() => Buffer.alloc(24, 7)),
    launchBrowser: launchBrowser || (async (options) => {
      launched.push(options)
      return { context, page, profileDir: 'opaque-profile' }
    }),
    verifyGameList: verifyGameList || (async (session) => {
      verified.push(structuredClone(session))
      if (verifyResult instanceof Error) throw verifyResult
      return verifyResult || {
        classification: { hasServerResponse: true, loginExpired: false, parseError: false },
        requestScope: { endpointKind: 'get_game_list' },
        session: { ...session, savedAt: 1_100 },
      }
    }),
    replaceSessionAtomically: async ({ account, session }) => {
      committed.push({ account: structuredClone(account), session: structuredClone(session) })
    },
  })

  return { bridge, page, context, launched, verified, committed }
}

function setupWithFinalizer({ now = () => 1_000, ttlMs = 60_000, gotoFailure = false } = {}) {
  const events = []
  const page = new FakePage()
  const context = new FakeContext(page)
  let finalizeCalls = 0
  if (gotoFailure) {
    page.goto = async (url, options) => {
      page.gotoCalls.push({ url, options })
      throw new Error('test-goto-failure')
    }
  }
  const value = setup({
    now,
    ttlMs,
    launchBrowser: async () => ({
      context,
      page,
      async finalize() {
        finalizeCalls += 1
        events.push('finalize')
        await context.close()
        return true
      },
    }),
    verifyGameList: async (session) => {
      events.push('verify')
      return {
        classification: { hasServerResponse: true, loginExpired: false, parseError: false },
        requestScope: { endpointKind: 'get_game_list' },
        session: { ...session, savedAt: 1_100 },
      }
    },
  })
  return { ...value, page, context, events, finalizeCalls: () => finalizeCalls }
}

function account(overrides = {}) {
  return {
    accountId: 'monitor-A',
    username: 'owner-user',
    password: 'must-not-be-used-by-bridge',
    loginUrl: ORIGIN,
    ...overrides,
  }
}

async function open(setupValue, accountValue = account()) {
  return setupValue.bridge.openManualLogin({ account: accountValue })
}

async function emitSuccessfulLogin(value, { uid = 'owner-uid', uidInResponse = false } = {}) {
  const loginRequest = request()
  value.page.emit('request', loginRequest)
  const uidXml = uidInResponse ? `<uid>${uid}</uid>` : ''
  value.page.emit('response', response({
    associatedRequest: loginRequest,
    body: `<serverresponse><status>200</status>${uidXml}</serverresponse>`,
  }))
  await new Promise((resolve) => setImmediate(resolve))
  if (!uidInResponse) value.page.emit('request', gameListRequest({ uid }))
}

test('opens a short-lived owner-bound manual challenge without automating human verification', async () => {
  const value = setup()
  const result = await open(value)

  assert.equal(result.status, 'awaiting-user')
  assert.equal(result.accountId, 'monitor-A')
  assert.equal(result.origin, ORIGIN)
  assert.equal(result.expiresAt, 61_000)
  assert.match(result.challengeId, /^[A-Za-z0-9_-]+\.[a-f0-9]{32}$/)
  assert.deepEqual(value.launched, [{ accountId: 'monitor-A', origin: ORIGIN }])
  assert.deepEqual(value.page.gotoCalls, [{
    url: ORIGIN,
    options: { waitUntil: 'domcontentloaded', timeout: 60_000 },
  }])
  assert.equal('locator' in value.page, false)
  assert.equal('evaluate' in value.page, false)
  assert.equal(value.context.storageStateCalls, 0)
  assert.doesNotMatch(JSON.stringify(result), /password|cookie|owner-uid|nonce/i)
})

test('accepts UID only from exact-origin transform evidence, verifies read-only game list, then commits owner-bound session', async () => {
  const value = setup()
  const challenge = await open(value)
  await emitSuccessfulLogin(value)

  const result = await value.bridge.confirmManualLogin({
    accountId: 'monitor-A',
    challengeId: challenge.challengeId,
  })

  assert.equal(result.status, 'verified')
  assert.equal(result.errorCode, '')
  assert.equal(value.verified.length, 1)
  assert.deepEqual(value.verified[0], {
    uid: 'owner-uid',
    cookies: { SID: 'exact-cookie' },
    accountId: 'monitor-A',
    username: 'owner-user',
    baseUrl: ORIGIN,
    savedAt: 1_000,
  })
  assert.equal(value.committed.length, 1)
  assert.deepEqual(value.committed[0].session, {
    ...value.verified[0],
    savedAt: 1_100,
  })
  assert.deepEqual(value.context.cookieCalls, [[ORIGIN]])
  assert.equal(value.context.storageStateCalls, 0)
  assert.equal(value.context.closeCalls, 1)
  assert.doesNotMatch(JSON.stringify(result), /owner-uid|exact-cookie|password|storageState/i)
})

test('successful confirmation verifies before one idempotent browser finalizer', async () => {
  const value = setupWithFinalizer()
  const challenge = await open(value)
  await emitSuccessfulLogin(value)

  const result = await value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  })

  assert.equal(result.status, 'verified')
  assert.deepEqual(value.events, ['verify', 'finalize'])
  assert.equal(value.finalizeCalls(), 1)
  assert.equal(value.context.closeCalls, 1)
  await assert.rejects(() => value.bridge.cancelManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), /manual-login-challenge-state-invalid/)
  assert.equal(value.finalizeCalls(), 1)
})

test('cancel, goto failure, and expiry each use the same finalizer exactly once', async () => {
  const cancelled = setupWithFinalizer()
  const cancelChallenge = await open(cancelled)
  await cancelled.bridge.cancelManualLogin({
    accountId: 'monitor-A', challengeId: cancelChallenge.challengeId,
  })
  assert.equal(cancelled.finalizeCalls(), 1, 'cancel')
  cancelled.bridge.getManualLoginStatus({ accountId: 'monitor-A', challengeId: cancelChallenge.challengeId })
  assert.equal(cancelled.finalizeCalls(), 1, 'cancel remains idempotent')

  const gotoFailed = setupWithFinalizer({ gotoFailure: true })
  await assert.rejects(() => open(gotoFailed), /manual-login-browser-open-failed/)
  assert.equal(gotoFailed.finalizeCalls(), 1, 'goto failure')

  let timestamp = 1_000
  const expired = setupWithFinalizer({ now: () => timestamp, ttlMs: 100 })
  const expiredChallenge = await open(expired)
  timestamp = 1_100
  await assert.rejects(() => expired.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: expiredChallenge.challengeId,
  }), /manual-login-challenge-expired/)
  assert.equal(expired.finalizeCalls(), 1, 'expiry')
  expired.bridge.getManualLoginStatus({ accountId: 'monitor-A', challengeId: expiredChallenge.challengeId })
  assert.equal(expired.finalizeCalls(), 1, 'expiry remains idempotent')
})

test('unexpected context close or disconnect enters one finalized failed terminal state', async () => {
  for (const event of ['close', 'disconnected']) {
    const value = setupWithFinalizer()
    const challenge = await open(value)
    value.context.emit(event)
    await new Promise((resolve) => setImmediate(resolve))

    const status = value.bridge.getManualLoginStatus({
      accountId: 'monitor-A', challengeId: challenge.challengeId,
    })
    assert.equal(status.status, 'failed', event)
    assert.equal(status.errorCode, 'manual-login-context-closed', event)
    assert.equal(value.finalizeCalls(), 1, event)
    value.bridge.getManualLoginStatus({ accountId: 'monitor-A', challengeId: challenge.challengeId })
    assert.equal(value.finalizeCalls(), 1, `${event} remains idempotent`)
  }
})

test('can derive UID from an exact-origin transform_nl response and ignores foreign evidence', async () => {
  const value = setup()
  const challenge = await open(value)
  const loginRequest = request()
  value.page.emit('request', loginRequest)
  value.page.emit('response', response({
    url: 'https://evil.example.com/transform_nl.php',
    body: '<serverresponse><status>200</status><uid>foreign-uid</uid></serverresponse>',
    associatedRequest: loginRequest,
  }))
  value.page.emit('response', response({ associatedRequest: loginRequest }))

  const result = await value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  })

  assert.equal(result.status, 'verified')
  assert.equal(value.verified[0].uid, 'owner-uid')
})

test('blocks cross-origin navigation and download attempts and refuses confirmation', async () => {
  const value = setup()
  const challenge = await open(value)
  const route = {
    aborted: 0,
    continued: 0,
    async abort() { this.aborted += 1 },
    async continue() { this.continued += 1 },
  }
  await value.context.routes[0].handler(route, request({
    url: 'https://evil.example.com/redirect',
    navigation: true,
    body: '',
  }))
  let downloadCancelled = 0
  value.page.emit('download', { async cancel() { downloadCancelled += 1 } })
  await new Promise((resolve) => setImmediate(resolve))

  await assert.rejects(() => value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-security-violation')

  assert.equal(route.aborted, 1)
  assert.equal(route.continued, 0)
  assert.equal(downloadCancelled, 1)
  assert.equal(value.verified.length, 0)
  assert.equal(value.committed.length, 0)
})

test('requires complete confirmation, exact binding and an unexpired challenge', async () => {
  let timestamp = 1_000
  const value = setup({ now: () => timestamp, ttlMs: 5_000 })
  const challenge = await open(value)

  assert.throws(() => value.bridge.getManualLoginStatus({
    accountId: 'monitor-B', challengeId: challenge.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-challenge-binding-mismatch')

  await assert.rejects(() => value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-session-evidence-missing')
  assert.equal(value.committed.length, 0)

  const next = setup({ now: () => timestamp, ttlMs: 5_000 })
  const expiring = await open(next)
  timestamp = 6_001
  await assert.rejects(() => next.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: expiring.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-challenge-expired')
  assert.equal(next.committed.length, 0)
})

test('does not replace the old session when read-only verification fails', async () => {
  const value = setup({ verifyResult: new Error('fake verification failure with secret-uid') })
  const challenge = await open(value)
  await emitSuccessfulLogin(value)

  await assert.rejects(() => value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-verification-failed')

  assert.equal(value.verified.length, 1)
  assert.equal(value.committed.length, 0)
  const status = value.bridge.getManualLoginStatus({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  })
  assert.equal(status.status, 'failed')
  assert.equal(status.errorCode, 'manual-login-verification-failed')
  assert.doesNotMatch(JSON.stringify(status), /secret-uid|cookie|password/i)
})

test('rejects false-positive verification and cancellation never commits a session', async () => {
  const invalidVerification = setup({ verifyResult: {
    classification: { hasServerResponse: false, loginExpired: false, parseError: false },
    requestScope: { endpointKind: 'get_game_list' },
  } })
  const challenge = await open(invalidVerification)
  await emitSuccessfulLogin(invalidVerification)
  await assert.rejects(() => invalidVerification.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), (error) => error instanceof ManualLoginError && error.code === 'manual-login-verification-failed')
  assert.equal(invalidVerification.committed.length, 0)

  const cancelled = setup()
  const cancelChallenge = await open(cancelled)
  const result = await cancelled.bridge.cancelManualLogin({
    accountId: 'monitor-A', challengeId: cancelChallenge.challengeId,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'manual-login-cancelled')
  assert.equal(cancelled.committed.length, 0)
  assert.equal(cancelled.context.closeCalls, 1)
})

test('cancelling while read-only verification is pending fences the confirm and never commits', async () => {
  let releaseVerification
  const verificationGate = new Promise((resolve) => { releaseVerification = resolve })
  const value = setup({
    verifyGameList: async (session) => {
      value.verified.push(structuredClone(session))
      await verificationGate
      return {
        classification: { hasServerResponse: true, loginExpired: false, parseError: false },
        requestScope: { endpointKind: 'get_game_list' },
        session: { ...session, savedAt: 1_100 },
      }
    },
  })
  const challenge = await open(value)
  await emitSuccessfulLogin(value)
  const confirming = value.bridge.confirmManualLogin({ accountId: 'monitor-A', challengeId: challenge.challengeId })
  while (value.verified.length === 0) await new Promise((resolve) => setImmediate(resolve))

  const cancelled = await value.bridge.cancelManualLogin({ accountId: 'monitor-A', challengeId: challenge.challengeId })
  releaseVerification()
  assert.equal(cancelled.errorCode, 'manual-login-cancelled')
  await assert.rejects(confirming, /manual-login-cancelled/)
  assert.equal(value.committed.length, 0)
})

test('an expired challenge cannot delete the replacement active challenge mapping', async () => {
  let timestamp = 1_000
  let nonce = 0
  const value = setup({
    now: () => timestamp,
    ttlMs: 100,
    randomBytes: () => Buffer.alloc(24, ++nonce),
  })
  const first = await open(value)
  timestamp = 1_100
  const second = await open(value)
  const oldStatus = value.bridge.getManualLoginStatus({ accountId: 'monitor-A', challengeId: first.challengeId })
  assert.equal(oldStatus.errorCode, 'manual-login-challenge-expired')
  await assert.rejects(open(value), /manual-login-busy/)
  const current = value.bridge.getManualLoginStatus({ accountId: 'monitor-A', challengeId: second.challengeId })
  assert.equal(current.status, 'awaiting-user')
})

test('UID evidence must follow the configured username login transaction', async () => {
  const value = setup()
  const challenge = await open(value)
  const wrongOwner = request({ body: 'p=chk_login&username=old-profile-user' })
  value.page.emit('request', wrongOwner)
  value.page.emit('response', response({ associatedRequest: wrongOwner }))
  await assert.rejects(value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), /manual-login-session-evidence-missing/)
  assert.equal(value.committed.length, 0)
})

test('pre-existing extra pages are rejected before navigation or session verification', async () => {
  const stalePopup = new FakePage('https://evil.example.net/already-open')
  const value = setup({ extraPages: [stalePopup] })
  await assert.rejects(open(value), /manual-login-security-violation/)
  assert.equal(stalePopup.closeCalls, 1)
  assert.equal(value.verified.length, 0)
  assert.equal(value.committed.length, 0)
})

test('a security event during verification fences session persistence and terminal state scrubs evidence', async () => {
  let releaseCookies
  let markCookiesStarted
  const cookieGate = new Promise((resolve) => { releaseCookies = resolve })
  const cookiesStarted = new Promise((resolve) => { markCookiesStarted = resolve })
  const value = setup()
  const originalCookies = value.context.cookies.bind(value.context)
  value.context.cookies = async (urls) => {
    markCookiesStarted()
    await cookieGate
    return originalCookies(urls)
  }
  const challenge = await open(value)
  await emitSuccessfulLogin(value)
  const confirming = value.bridge.confirmManualLogin({ accountId: 'monitor-A', challengeId: challenge.challengeId })
  await cookiesStarted
  value.page.emit('download', { async cancel() {} })
  releaseCookies()

  await assert.rejects(confirming, /manual-login-security-violation/)
  assert.equal(value.committed.length, 0)
  const terminal = value.bridge.challenges.get(challenge.challengeId)
  assert.equal(terminal.uid, '')
  assert.equal(terminal.context, null)
  assert.equal(terminal.page, null)
  assert.equal(terminal.account.username, undefined)
})

test('a transform request before the bound login response cannot supply stale-profile UID evidence', async () => {
  const value = setup()
  const challenge = await open(value)
  const loginRequest = request()
  value.page.emit('request', loginRequest)
  value.page.emit('request', gameListRequest({ uid: 'stale-profile-uid' }))
  value.page.emit('response', response({
    associatedRequest: loginRequest,
    body: '<serverresponse><status>200</status></serverresponse>',
  }))

  await assert.rejects(value.bridge.confirmManualLogin({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), /manual-login-session-evidence-missing/)
  assert.equal(value.committed.length, 0)
})

test('terminal challenges are scrubbed, expire quickly, and remain capacity bounded', async () => {
  let timestamp = 1_000
  let nonce = 0
  const value = setup({
    now: () => timestamp,
    tombstoneTtlMs: 100,
    maxTombstones: 2,
    randomBytes: () => Buffer.alloc(24, ++nonce),
  })
  for (let index = 0; index < 3; index += 1) {
    const accountValue = account({ accountId: `monitor-${index}` })
    const challenge = await open(value, accountValue)
    await value.bridge.cancelManualLogin({ accountId: accountValue.accountId, challengeId: challenge.challengeId })
  }
  assert.equal(value.bridge.challenges.size, 2)
  for (const challenge of value.bridge.challenges.values()) {
    assert.equal(challenge.uid, '')
    assert.equal(challenge.account.username, undefined)
  }

  timestamp = 1_100
  const active = await open(value, account({ accountId: 'monitor-fresh' }))
  assert.equal(active.status, 'awaiting-user')
  assert.equal(value.bridge.challenges.size, 1)
})

test('browser guard failures become scrubbed bounded terminal challenges', async () => {
  let nonce = 0
  const contexts = []
  const value = setup({
    maxTombstones: 2,
    randomBytes: () => Buffer.alloc(24, ++nonce),
    launchBrowser: async () => {
      const context = new FakeContext(null)
      contexts.push(context)
      return { context, page: null }
    },
  })

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(() => open(value, account({ accountId: `invalid-${index}` })),
      /manual-login-browser-context-invalid/)
  }

  assert.equal(contexts.every((context) => context.closeCalls === 1), true)
  assert.equal(value.bridge.challenges.size, 2)
  for (const challenge of value.bridge.challenges.values()) {
    assert.equal(challenge.status, 'failed')
    assert.equal(challenge.errorCode, 'manual-login-browser-context-invalid')
    assert.equal(challenge.terminalAt, 1_000)
    assert.equal(challenge.uid, '')
    assert.equal(challenge.account.username, undefined)
    assert.equal(challenge.evidenceTasks.size, 0)
  }
})

test('an opening challenge that expires cannot resume after a replacement challenge becomes active', async () => {
  let timestamp = 1_000
  let nonce = 0
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const firstPage = new FakePage()
  const firstContext = new FakeContext(firstPage)
  const secondPage = new FakePage()
  const secondContext = new FakeContext(secondPage)
  let launchCount = 0
  const value = setup({
    now: () => timestamp,
    ttlMs: 100,
    randomBytes: () => Buffer.alloc(24, ++nonce),
    launchBrowser: async () => {
      launchCount += 1
      if (launchCount === 1) {
        await firstGate
        return { context: firstContext, page: firstPage }
      }
      return { context: secondContext, page: secondPage }
    },
  })

  const firstOpening = open(value)
  await new Promise((resolve) => setImmediate(resolve))
  timestamp = 1_100
  const second = await open(value)
  releaseFirst()
  await assert.rejects(firstOpening, /manual-login-challenge-expired/)
  assert.equal(second.status, 'awaiting-user')
  assert.equal(firstContext.closeCalls, 1)
  assert.equal(secondContext.closeCalls, 0)
})

test('time zero terminal tombstones are still recognized and pruned', async () => {
  let timestamp = 0
  const value = setup({ now: () => timestamp, tombstoneTtlMs: 10 })
  const challenge = await open(value)
  await value.bridge.cancelManualLogin({ accountId: 'monitor-A', challengeId: challenge.challengeId })
  assert.equal(value.bridge.challenges.get(challenge.challengeId).terminalAt, 0)
  timestamp = 10
  assert.throws(() => value.bridge.getManualLoginStatus({
    accountId: 'monitor-A', challengeId: challenge.challengeId,
  }), /manual-login-challenge-not-found/)
})
