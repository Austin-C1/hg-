import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CrownBrowserAccountRuntime } from '../src/crown/betting/crown-browser-account-runtime.mjs'
import { launchPortableChromium } from '../src/crown/login/portable-chromium.mjs'

const ORIGIN = 'https://crown.example.com'
const OTHER_ORIGIN = 'https://other-crown.example.com'

function account(accountId, username = accountId, loginUrl = ORIGIN) {
  return { id: accountId, accountId, username, password: 'test-only', loginUrl }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function runtimeHarness({
  gateFirstPreview = false,
  closeReleasesPreview = false,
  gateFirstLaunch = false,
  closeReject = false,
  heartbeatStartReject = false,
  launchReject = false,
  leaseAcquireReject = false,
  launchBrowserImpl = null,
  now,
} = {}) {
  const events = []
  const leases = []
  const launches = []
  const apiCalls = []
  const loginCalls = []
  const previewStarted = deferred()
  const releasePreview = deferred()
  const launchStarted = deferred()
  const releaseLaunch = deferred()
  let firstPreviewGated = false
  let firstLaunchGated = false
  let submitDispatches = 0
  let activeRequests = 0
  let maxActiveRequests = 0

  function createProfileLease({ accountId }) {
    const lease = {
      accountId,
      leaseKey: `browser-profile:test:${accountId}`,
      fencingToken: null,
      stale: false,
      assertFenceCalls: 0,
      releaseCalls: 0,
      startHeartbeatCalls: 0,
      stopHeartbeatCalls: 0,
      acquire() {
        events.push(`lease-acquire:${accountId}`)
        if (leaseAcquireReject) {
          const error = Object.assign(new Error('lease-active'), {
            code: 'lease-active',
            lease: { leaseKey: 'browser-profile:C:\\Users\\private-db\\storage.sqlite:account-a' },
          })
          throw error
        }
        this.fencingToken = 1
        return { leaseKey: this.leaseKey, fencingToken: 1 }
      },
      assertFence() {
        this.assertFenceCalls += 1
        events.push(`profile-fence:${accountId}`)
        if (this.stale) throw Object.assign(new Error('lease-stale'), { code: 'lease-stale' })
        return this.fencingToken
      },
      heartbeat() { return { leaseKey: this.leaseKey, fencingToken: this.assertFence() } },
      startHeartbeat() {
        this.startHeartbeatCalls += 1
        if (heartbeatStartReject) throw new Error('heartbeat-start-failed')
      },
      stopHeartbeat() { this.stopHeartbeatCalls += 1 },
      release() {
        this.releaseCalls += 1
        events.push(`lease-release:${accountId}`)
        if (this.stale || this.fencingToken === null) return false
        this.fencingToken = null
        return true
      },
    }
    leases.push(lease)
    return lease
  }

  async function launchBrowser({ accountId }) {
    events.push(`profile-create:${accountId}`)
    events.push(`launch:${accountId}`)
    if (gateFirstLaunch && !firstLaunchGated) {
      firstLaunchGated = true
      launchStarted.resolve()
      await releaseLaunch.promise
    }
    if (launchReject) throw new Error('launch failed for C:\\private-profile-sentinel')
    if (launchBrowserImpl) return launchBrowserImpl({ accountId })
    const contextId = `${accountId}:${launches.length + 1}`
    const context = new EventEmitter()
    const page = new EventEmitter()
    let pageUrl = 'about:blank'
    const mainFrame = { url: () => pageUrl }
    context.closed = false
    context.closeCalls = 0
    context.storageStateCalls = 0
    context.cookieJar = Object.create(null)
    context.pages = () => [page]
    context.storageState = async () => {
      context.storageStateCalls += 1
      throw new Error('storage-state-forbidden')
    }
    context.close = async () => {
      if (context.closed) return
      context.closeCalls += 1
      if (closeReject) throw new Error('context-close-failed')
      context.closed = true
      if (closeReleasesPreview) releasePreview.resolve()
      context.emit('close')
    }
    page.contextId = contextId
    page.locatorCalls = 0
    page.url = () => pageUrl
    page.mainFrame = () => mainFrame
    page.goto = async (url) => {
      pageUrl = String(url)
      events.push(`goto:${accountId}`)
    }
    page.waitForTimeout = async (timeoutMs) => {
      events.push(`page-settle:${accountId}:${timeoutMs}`)
    }
    page.locator = () => {
      page.locatorCalls += 1
      throw new Error('dom-locator-forbidden')
    }
    const launched = { accountId, contextId, context, page, profileDir: `profile:${accountId}` }
    launches.push(launched)
    return launched
  }

  function createApiClient({ page }) {
    const run = async (operation, input = {}) => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      apiCalls.push({ operation, contextId: page.contextId, input })
      try {
        if (gateFirstPreview && operation === 'preview' && !firstPreviewGated) {
          firstPreviewGated = true
          previewStarted.resolve()
          await releasePreview.promise
        }
        if (operation === 'submit') {
          await input.beforeDispatch?.()
          submitDispatches += 1
        }
        return { text: `<serverresponse><code>${operation}</code></serverresponse>` }
      } finally {
        activeRequests -= 1
      }
    }
    return {
      async login({ account: current }) {
        events.push(`login:${current.accountId}`)
        loginCalls.push({
          accountId: current.accountId,
          username: current.username,
          origin: current.loginUrl,
          contextId: page.contextId,
        })
        const session = {
          accountId: current.accountId,
          username: current.username,
          origin: current.loginUrl,
          baseUrl: current.loginUrl,
          uid: `uid:${current.accountId}`,
          protocolVersion: 'v1',
          protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
        }
        return { login: { status: '200', uid: session.uid, protocolVersion: 'v1' }, session }
      },
      async fetchGameList(session) {
        return {
          text: '<serverresponse><code>get_game_list</code></serverresponse>',
          classification: { hasServerResponse: true, loginExpired: false, parseError: false },
          requestScope: { endpointKind: 'get_game_list' },
          session,
        }
      },
      fetchAccountSummary: (session) => run('balance', { session }),
      postPreview: ({ session, wireFields }) => run('preview', { session, wireFields }),
      postSubmit: ({ session, wireFields, beforeDispatch }) => run('submit', { session, wireFields, beforeDispatch }),
      queryResult: (input = {}) => run('result', input),
    }
  }

  const runtime = new CrownBrowserAccountRuntime({ createProfileLease, launchBrowser, createApiClient, now })
  return {
    apiCalls,
    events,
    launches,
    leases,
    launchStarted,
    loginCalls,
    maxActiveRequests: () => maxActiveRequests,
    previewStarted,
    releaseLaunch,
    releasePreview,
    runtime,
    submitDispatches: () => submitDispatches,
  }
}

test('safe status snapshot records only real successful API time and never exposes the context UUID', async () => {
  const times = [
    new Date('2026-07-15T01:00:00.000Z'),
    new Date('2026-07-15T01:00:01.000Z'),
  ]
  const harness = runtimeHarness({ now: () => times.shift() || new Date('2026-07-15T01:00:02.000Z') })
  const current = account('account-a', 'alice')
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
  assert.ok(harness.events.includes('page-settle:account-a:500'))
  assert.ok(harness.events.indexOf('page-settle:account-a:500') < harness.events.indexOf('login:account-a'))
  const afterLogin = harness.runtime.statusSnapshot({ heartbeatAt: '2026-07-15T01:00:00.500Z' })
  assert.deepEqual(afterLogin, { accounts: [{
    accountId: 'account-a', state: 'ready', lastHeartbeatAt: '2026-07-15T01:00:00.500Z',
    lastApiSuccessAt: '2026-07-15T01:00:00.000Z',
  }] })
  await harness.runtime.fetchFreshExecutionBalance({ account: current, session, assertFence: async () => {} })
  const afterBalance = harness.runtime.statusSnapshot({ heartbeatAt: '2026-07-15T01:00:01.500Z' })
  assert.equal(afterBalance.accounts[0].lastApiSuccessAt, '2026-07-15T01:00:01.000Z')
  assert.doesNotMatch(JSON.stringify(afterBalance), /uid:|contextGeneration|browser-generation|password|cookie/i)
  await harness.runtime.shutdown()
})

test('same-account calls share one context and are serialized without DOM or storageState', async () => {
  const harness = runtimeHarness({ gateFirstPreview: true })
  const current = account('account-a', 'alice')
  let executorFenceCalls = 0
  const assertFence = async () => { executorFenceCalls += 1 }
  const [firstSession, secondSession] = await Promise.all([
    harness.runtime.ensureBettingSession({ account: current, assertFence }),
    harness.runtime.ensureBettingSession({ account: current, assertFence }),
  ])

  assert.equal(harness.launches.length, 1)
  assert.equal(firstSession.contextGeneration, secondSession.contextGeneration)
  assert.ok(firstSession.contextGeneration)
  assert.ok(harness.events.indexOf('lease-acquire:account-a') < harness.events.indexOf('profile-create:account-a'))
  assert.ok(harness.events.indexOf('profile-create:account-a') < harness.events.indexOf('launch:account-a'))

  const first = harness.runtime.postPreviewForm({
    account: current,
    session: firstSession,
    wireFields: { p: 'FT_order_view', gid: 'one' },
    assertFence,
  })
  await harness.previewStarted.promise
  const second = harness.runtime.postPreviewForm({
    account: current,
    session: firstSession,
    wireFields: { p: 'FT_order_view', gid: 'two' },
    assertFence,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.apiCalls.filter((call) => call.operation === 'preview').length, 1)
  harness.releasePreview.resolve()
  await Promise.all([first, second])
  await harness.runtime.postSubmitForm({
    account: current,
    session: firstSession,
    wireFields: { p: 'FT_bet', gid: 'one' },
    assertFence,
    beforeDispatch: async () => {},
  })

  assert.equal(harness.launches.length, 1)
  assert.equal(harness.maxActiveRequests(), 1)
  assert.equal(new Set(harness.apiCalls.map((call) => call.contextId)).size, 1)
  assert.equal(harness.launches[0].context.storageStateCalls, 0)
  assert.equal(harness.launches[0].page.locatorCalls, 0)
  assert.ok(executorFenceCalls >= 6)
  assert.ok(harness.leases[0].assertFenceCalls >= 6)
  await harness.runtime.shutdown()
})

test('result query forwarding exposes no caller-controlled wire fields', async () => {
  const harness = runtimeHarness()
  const current = account('account-a', 'alice')
  const assertFence = async () => {}
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence })

  await harness.runtime.queryResultForm({ account: current, session, assertFence })
  const query = harness.apiCalls.find((call) => call.operation === 'result')
  assert.deepEqual(Object.keys(query.input).sort(), ['session', 'signal'])
  assert.equal(Object.hasOwn(query.input, 'wireFields'), false)
  assert.throws(() => harness.runtime.queryResultForm({
    account: current,
    session,
    assertFence,
    wireFields: { p: 'get_today_wagers' },
  }), /browser-result-input-not-allowed/)
  assert.equal(harness.apiCalls.filter((call) => call.operation === 'result').length, 1)
  await harness.runtime.shutdown()
})

test('different accounts receive isolated leases, contexts, and context generations', async () => {
  const harness = runtimeHarness()
  const [first, second] = await Promise.all([
    harness.runtime.ensureBettingSession({ account: account('account-a'), assertFence: async () => {} }),
    harness.runtime.ensureBettingSession({ account: account('account-b'), assertFence: async () => {} }),
  ])

  assert.equal(harness.launches.length, 2)
  assert.notEqual(harness.launches[0].context, harness.launches[1].context)
  assert.notEqual(harness.launches[0].context.cookieJar, harness.launches[1].context.cookieJar)
  assert.notEqual(harness.leases[0].leaseKey, harness.leases[1].leaseKey)
  assert.notEqual(first.contextGeneration, second.contextGeneration)
  assert.equal(Object.hasOwn(first, 'cookies'), false)
  assert.equal(Object.hasOwn(second, 'cookies'), false)
  assert.equal(harness.launches.every(({ context }) => context.storageStateCalls === 0), true)
  await harness.runtime.shutdown()
})

test('username or origin drift closes the old context and performs a fresh login', async () => {
  const harness = runtimeHarness()
  const assertFence = async () => {}
  const firstAccount = account('account-a', 'alice')
  const first = await harness.runtime.ensureBettingSession({ account: firstAccount, assertFence })
  const renamedAccount = account('account-a', 'alice-renamed')
  const second = await harness.runtime.ensureBettingSession({ account: renamedAccount, assertFence })
  const movedAccount = account('account-a', 'alice-renamed', OTHER_ORIGIN)
  const third = await harness.runtime.ensureBettingSession({ account: movedAccount, assertFence })

  assert.equal(harness.launches.length, 3)
  assert.equal(harness.launches[0].context.closeCalls, 1)
  assert.equal(harness.launches[1].context.closeCalls, 1)
  assert.notEqual(first.contextGeneration, second.contextGeneration)
  assert.notEqual(second.contextGeneration, third.contextGeneration)
  assert.deepEqual(harness.loginCalls.map(({ username, origin }) => ({ username, origin })), [
    { username: 'alice', origin: ORIGIN },
    { username: 'alice-renamed', origin: ORIGIN },
    { username: 'alice-renamed', origin: OTHER_ORIGIN },
  ])
  assert.equal(harness.runtime.verifiedBettingSessionFor({ account: firstAccount, session: first }), null)
  assert.equal(harness.runtime.verifiedBettingSessionFor({ account: renamedAccount, session: second }), null)
  await harness.runtime.shutdown()
})

test('Submit rechecks executor and profile fences immediately before one caller callback', async () => {
  const harness = runtimeHarness()
  const current = account('account-a')
  const assertFence = async () => { harness.events.push('executor-fence') }
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence })
  harness.events.length = 0
  let callbackCalls = 0

  await harness.runtime.postSubmitForm({
    account: current,
    session,
    wireFields: { p: 'FT_bet', gid: 'game-1' },
    assertFence,
    beforeDispatch: async () => {
      callbackCalls += 1
      harness.events.push('caller-before-dispatch')
    },
  })

  const callbackIndex = harness.events.indexOf('caller-before-dispatch')
  assert.equal(callbackCalls, 1)
  assert.equal(harness.submitDispatches(), 1)
  assert.ok(callbackIndex >= 2)
  assert.deepEqual(harness.events.slice(callbackIndex - 2, callbackIndex + 1), [
    'executor-fence',
    'profile-fence:account-a',
    'caller-before-dispatch',
  ])
  await harness.runtime.shutdown()
})

test('Submit aborts before browser dispatch when a fence is lost inside async beforeDispatch', async () => {
  const harness = runtimeHarness()
  const current = account('account-a')
  const assertFence = async () => {}
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence })
  let callbackCalls = 0

  await assert.rejects(() => harness.runtime.postSubmitForm({
    account: current,
    session,
    wireFields: { p: 'FT_bet', gid: 'game-1' },
    assertFence,
    beforeDispatch: async () => {
      callbackCalls += 1
      harness.leases[0].stale = true
      await new Promise((resolve) => setImmediate(resolve))
    },
  }), /lease-stale/)

  assert.equal(callbackCalls, 1)
  assert.equal(harness.submitDispatches(), 0)
  assert.equal(harness.launches[0].context.closeCalls, 1)
  await harness.runtime.shutdown()
})

test('shutdown drains an in-flight launch and closes the resulting context', async () => {
  const harness = runtimeHarness({ gateFirstLaunch: true })
  const current = account('account-a')
  const ensure = harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
  await harness.launchStarted.promise

  const shutdown = harness.runtime.shutdown()
  harness.releaseLaunch.resolve()

  await assert.rejects(ensure, /browser-account-context-stale/)
  assert.deepEqual(await shutdown, { ok: true })
  assert.equal(harness.launches.length, 1)
  assert.equal(harness.launches[0].context.closeCalls, 1)
  assert.equal(harness.leases[0].releaseCalls, 1)
  await assert.rejects(() => harness.runtime.ensureBettingSession({
    account: current,
    assertFence: async () => {},
  }), /browser-account-runtime-closing/)
})

test('shutdown closes an active context before waiting for its in-flight browser request', async () => {
  const harness = runtimeHarness({ gateFirstPreview: true, closeReleasesPreview: true })
  const current = account('account-a')
  const assertFence = async () => {}
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence })
  const preview = harness.runtime.postPreviewForm({
    account: current,
    session,
    wireFields: { p: 'FT_order', gid: 'game-1' },
    assertFence,
  })
  await harness.previewStarted.promise

  const shutdown = harness.runtime.shutdown()
  const outcome = await Promise.race([
    shutdown.then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ])
  if (outcome === 'timed-out') harness.releasePreview.resolve()
  await assert.rejects(preview, /browser-account-context-stale/)
  assert.deepEqual(await shutdown, { ok: true })
  assert.equal(outcome, 'closed')
  assert.equal(harness.launches[0].context.closeCalls, 1)
  assert.equal(harness.leases[0].releaseCalls, 1)
})

test('heartbeat startup failure releases the acquired profile lease before any launch', async () => {
  const harness = runtimeHarness({ heartbeatStartReject: true })

  await assert.rejects(() => harness.runtime.ensureBettingSession({
    account: account('account-a'),
    assertFence: async () => {},
  }), /browser-account-context-create-failed/)

  assert.equal(harness.launches.length, 0)
  assert.equal(harness.leases[0].releaseCalls, 1)
  assert.deepEqual(await harness.runtime.shutdown(), { ok: true })
})

test('launch errors do not expose a browser profile path', async () => {
  const harness = runtimeHarness({ launchReject: true })
  let failure

  try {
    await harness.runtime.ensureBettingSession({
      account: account('account-a'),
      assertFence: async () => {},
    })
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.code, 'browser-account-context-create-failed')
  assert.equal(failure?.message, 'browser-account-context-create-failed')
  assert.doesNotMatch(String(failure?.stack), /private-profile-sentinel|launch failed/i)
  assert.equal(Object.hasOwn(failure, 'lease'), false)
  assert.equal(harness.leases[0].releaseCalls, 0)
  assert.deepEqual(await harness.runtime.shutdown(), { ok: false })
})

test('active profile lease errors expose only the stable code', async () => {
  const harness = runtimeHarness({ leaseAcquireReject: true })
  let failure

  try {
    await harness.runtime.ensureBettingSession({
      account: account('account-a'),
      assertFence: async () => {},
    })
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.code, 'lease-active')
  assert.equal(failure?.message, 'lease-active')
  assert.equal(Object.hasOwn(failure, 'lease'), false)
  assert.doesNotMatch(JSON.stringify(failure), /private-db|storage\.sqlite/i)
  assert.equal(harness.launches.length, 0)
  assert.deepEqual(await harness.runtime.shutdown(), { ok: true })
})

test('runtime takes failed portable launch ownership and retries the unconfirmed context close', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-runtime-portable-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appRoot = path.join(root, 'app')
  const dataRoot = path.join(root, 'data')
  const profileRoot = path.join(dataRoot, 'profiles')
  const executablePath = path.join(appRoot, 'chromium.exe')
  fs.mkdirSync(appRoot, { recursive: true })
  fs.writeFileSync(executablePath, '')

  const context = new EventEmitter()
  let closeCalls = 0
  context.pages = () => [{}, {}]
  context.close = async () => {
    closeCalls += 1
    if (closeCalls === 1) throw new Error('first-close-failed')
    context.emit('close')
  }
  const harness = runtimeHarness({
    launchBrowserImpl: ({ accountId }) => launchPortableChromium({
      chromium: { launchPersistentContext: async () => context },
      appRoot,
      dataRoot,
      executablePath,
      profileRoot,
      accountId,
    }),
  })

  await assert.rejects(() => harness.runtime.ensureBettingSession({
    account: account('account-a'),
    assertFence: async () => {},
  }), /portable-chromium-unexpected-pages/)

  assert.equal(closeCalls, 2)
  assert.equal(harness.leases[0].releaseCalls, 1)
  assert.deepEqual(await harness.runtime.shutdown(), { ok: true })
})

test('a rejected context close stops heartbeat without releasing the profile lease', async () => {
  const harness = runtimeHarness({ closeReject: true })
  const current = account('account-a')
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })

  assert.equal(await harness.runtime.closeAccount({ accountId: current.accountId }), false)
  assert.equal(harness.launches[0].context.closeCalls, 1)
  assert.equal(harness.leases[0].stopHeartbeatCalls, 1)
  assert.equal(harness.leases[0].releaseCalls, 0)
  assert.equal(harness.runtime.verifiedBettingSessionFor({ account: current, session }), null)
  await assert.rejects(() => harness.runtime.ensureBettingSession({
    account: current,
    assertFence: async () => {},
  }), /browser-account-context-close-unresolved/)
  assert.equal(harness.launches.length, 1)
  assert.deepEqual(await harness.runtime.shutdown(), { ok: false })
  assert.equal(harness.leases[0].releaseCalls, 0)
})

test('popup, download, and cross-origin navigation each invalidate and close the session', async () => {
  for (const event of ['popup', 'download', 'cross-origin-navigation']) {
    const harness = runtimeHarness()
    const current = account('account-a')
    const session = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
    const launched = harness.launches[0]
    let blockedSideEffectCalls = 0

    if (event === 'popup') {
      launched.context.emit('page', {
        async close() { blockedSideEffectCalls += 1 },
      })
    } else if (event === 'download') {
      launched.page.emit('download', {
        async cancel() { blockedSideEffectCalls += 1 },
      })
    } else {
      launched.page.mainFrame().url = () => `${OTHER_ORIGIN}/index.php`
      launched.page.emit('framenavigated', launched.page.mainFrame())
    }
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(launched.context.closeCalls, 1, event)
    assert.equal(harness.runtime.verifiedBettingSessionFor({ account: current, session }), null, event)
    if (event !== 'cross-origin-navigation') assert.equal(blockedSideEffectCalls, 1, event)
    await harness.runtime.shutdown()
  }
})

test('cross-origin subframe navigation does not invalidate the same-origin betting page', async () => {
  const harness = runtimeHarness()
  const current = account('account-a')
  const session = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
  const launched = harness.launches[0]

  launched.page.emit('framenavigated', { url: () => `${OTHER_ORIGIN}/embedded-content` })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(launched.context.closeCalls, 0)
  assert.equal(harness.runtime.verifiedBettingSessionFor({ account: current, session }), session)
  await harness.runtime.shutdown()
})

test('page crash and profile lease loss invalidate the session and close its context', async () => {
  const harness = runtimeHarness()
  const current = account('account-a')
  const first = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
  harness.launches[0].page.emit('crash', new Error('page-crashed'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.launches[0].context.closeCalls, 1)

  const second = await harness.runtime.ensureBettingSession({ account: current, assertFence: async () => {} })
  assert.notEqual(second.contextGeneration, first.contextGeneration)
  assert.equal(harness.launches.length, 2)

  harness.leases.at(-1).stale = true
  await assert.rejects(() => harness.runtime.postPreviewForm({
    account: current,
    session: second,
    wireFields: { p: 'FT_order_view', gid: 'game-1' },
    assertFence: async () => {},
  }), /lease-stale/)
  assert.equal(harness.launches.at(-1).context.closeCalls, 1)
  assert.equal(harness.launches.every(({ context }) => context.storageStateCalls === 0), true)
  await harness.runtime.shutdown()
})
