import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { CrownBrowserApiClient } from '../src/crown/login/crown-browser-api-client.mjs'

const ORIGIN = 'https://crown.example.com'

function bettingSession(origin = ORIGIN) {
  return {
    accountId: 'account-a',
    username: 'alice',
    origin,
    baseUrl: origin,
    uid: 'uid-a',
    protocolVersion: 'v1',
    contextGeneration: 'context-a',
  }
}

const PREVIEW_WIRE = {
  p: 'FT_order_view',
  gid: 'game-1',
  gtype: 'FT',
  wtype: 'R',
  chose_team: 'H',
  langx: 'zh-cn',
  odd_f_type: 'H',
  ver: 'v1',
}

const SUBMIT_WIRE = {
  p: 'FT_bet',
  gid: 'game-1',
  gtype: 'FT',
  wtype: 'R',
  rtype: 'RH',
  isRB: 'N',
  chose_team: 'H',
  f: '1R',
  golds: '50',
  ioratio: '0.96',
  ratio: '-0.5',
  ver: 'v1',
}

function responseText(operation) {
  if (operation === 'chk_login') {
    return '<serverresponse><status>200</status><uid>browser-uid</uid><ver>browser-v1</ver></serverresponse>'
  }
  if (operation === 'get_game_list') {
    return '<serverresponse><system_time>2026-07-15 01:00:00</system_time></serverresponse>'
  }
  if (operation === 'get_member_data') {
    return '<serverresponse><code>get_all_data</code><enable>Y</enable><maxcredit>1250</maxcredit><currency>RMB</currency></serverresponse>'
  }
  if (operation === 'FT_order_view') {
    return '<serverresponse><code>501</code><gold_gmin>50</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.96</ioratio><spread>-0.5</spread></serverresponse>'
  }
  return '<serverresponse><code>560</code><ticket_id>private-reference</ticket_id><gid>game-1</gid><gtype>FT</gtype><wtype>R</wtype><rtype>RH</rtype><ioratio>0.96</ioratio><gold>50</gold><spread>-0.5</spread></serverresponse>'
}

function browserHarness(t, { failSubmit = false, pageProtocolVersion = 'page-v1' } = {}) {
  const originalFetch = globalThis.fetch
  const events = []
  const requests = []
  let insideEvaluate = false
  let pageUrl = `${ORIGIN}/index.php`
  let documentBaseUrl = pageUrl
  let nodeFetchCalls = 0
  let contextRequestCalls = 0
  let responseTextReads = 0
  let responseRedirected = false
  let responseUrl = ''
  let responseBody = ''

  globalThis.fetch = async (url, options = {}) => {
    if (!insideEvaluate) {
      nodeFetchCalls += 1
      throw new Error('node-global-fetch-forbidden')
    }
    events.push('fetch')
    const form = new URLSearchParams(String(options.body || ''))
    const operation = form.get('p')
    requests.push({ url: String(url), options, form })
    if (failSubmit && operation === 'FT_bet') throw new Error('browser-submit-network-failure')
    const text = responseBody || responseText(operation)
    const bytes = new TextEncoder().encode(text)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      redirected: responseRedirected,
      type: 'basic',
      url: responseUrl || `${ORIGIN}${String(url)}`,
      headers: { get: () => null, entries: () => [][Symbol.iterator]() },
      async text() { responseTextReads += 1; return text },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    }
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const context = new EventEmitter()
  const browser = new EventEmitter()
  context.browser = () => browser
  Object.defineProperty(context, 'request', {
    get() {
      contextRequestCalls += 1
      throw new Error('context-request-forbidden')
    },
  })
  let frameUrl = pageUrl
  const mainFrame = { url: () => frameUrl }
  const page = new EventEmitter()
  Object.assign(page, {
    url: () => pageUrl,
    mainFrame: () => mainFrame,
    context: () => context,
    async evaluate(callback, argument) {
      events.push('evaluate')
      insideEvaluate = true
      const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
      const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
      const topDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'top')
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: new URL(pageUrl).origin },
      })
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { baseURI: documentBaseUrl },
      })
      Object.defineProperty(globalThis, 'top', {
        configurable: true,
        value: { ver: pageProtocolVersion },
      })
      try {
        return await callback(argument)
      } finally {
        if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor)
        else delete globalThis.location
        if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
        else delete globalThis.document
        if (topDescriptor) Object.defineProperty(globalThis, 'top', topDescriptor)
        else delete globalThis.top
        insideEvaluate = false
      }
    },
  })

  return {
    events,
    browser,
    context,
    mainFrame,
    page,
    requests,
    setPageUrl(value) { pageUrl = value },
    setDocumentBase(value) { documentBaseUrl = value },
    setFrameUrl(value) { frameUrl = value },
    setResponse(value = {}) {
      responseRedirected = value.redirected === true
      responseUrl = String(value.url || '')
      responseBody = String(value.body || '')
    },
    responseTextReads: () => responseTextReads,
    stats: () => ({ nodeFetchCalls, contextRequestCalls }),
  }
}

async function rejectedError(operation) {
  try {
    await operation()
  } catch (error) {
    return error
  }
  assert.fail('expected operation to reject')
}

test('login, game list, and account summary stay in the page and expose no cookies', async (t) => {
  const harness = browserHarness(t)
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  const authenticated = await client.login({
    account: {
      id: 'account-a',
      accountId: 'account-a',
      username: 'alice',
      password: 'private-password',
      loginUrl: ORIGIN,
    },
  })
  assert.deepEqual(Object.keys(authenticated.session).sort(), [
    'accountId', 'baseUrl', 'origin', 'protocolVersion', 'protocolVersionEvidence', 'uid', 'username',
  ])
  assert.equal(authenticated.session.protocolVersion, 'browser-v1')
  assert.equal(Object.hasOwn(authenticated.session, 'cookies'), false)
  assert.doesNotMatch(JSON.stringify(authenticated), /private-password/)

  const gameList = await client.fetchGameList(authenticated.session)
  const accountSummary = await client.fetchAccountSummary(authenticated.session)
  assert.equal(gameList.requestScope.endpointKind, 'get_game_list')
  assert.deepEqual(accountSummary.summary, {
    valid: true,
    reportedBalance: '1250',
    reportedCurrency: 'CNY',
  })
  assert.deepEqual(harness.requests.map(({ url, form }) => [url, form.get('p')]), [
    ['/transform_nl.php', 'chk_login'],
    ['/transform.php', 'get_game_list'],
    ['/transform.php', 'get_member_data'],
  ])
  assert.deepEqual(harness.stats(), { nodeFetchCalls: 0, contextRequestCalls: 0 })
})

test('login uses exact-origin production page version when the current login response omits ver', async (t) => {
  const harness = browserHarness(t, { pageProtocolVersion: 'page-current-v2' })
  harness.setResponse({
    body: '<serverresponse><status>200</status><uid>browser-uid</uid></serverresponse>',
  })
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })

  const authenticated = await client.login({
    account: {
      id: 'account-a', accountId: 'account-a', username: 'alice',
      password: 'private-password', loginUrl: ORIGIN,
    },
  })

  assert.equal(authenticated.session.protocolVersion, 'page-current-v2')
  assert.deepEqual(authenticated.session.protocolVersionEvidence, {
    source: 'production-session-metadata', captured: true, verified: true,
  })
})

test('game-list session failure is rejected even inside a well-formed XML envelope', async (t) => {
  const harness = browserHarness(t)
  harness.setResponse({
    url: `${ORIGIN}/transform.php`,
    body: '<serverresponse><status>403</status><msg>login_required</msg></serverresponse>',
  })
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  await assert.rejects(() => client.fetchGameList(bettingSession()), /browser-game-list-session-invalid/)
})

test('Preview and Submit use only exact-origin page fetch with browser credentials', async (t) => {
  const harness = browserHarness(t)
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })

  await client.postPreview({ session: bettingSession(), wireFields: PREVIEW_WIRE })
  await client.postSubmit({
    session: bettingSession(),
    wireFields: SUBMIT_WIRE,
    beforeDispatch: async () => { harness.events.push('beforeDispatch') },
  })

  assert.equal(harness.requests.length, 2)
  for (const request of harness.requests) {
    assert.equal(request.url, '/transform.php')
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.credentials, 'include')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.form.get('uid'), 'uid-a')
  }
  assert.deepEqual(harness.events.slice(-3), ['beforeDispatch', 'evaluate', 'fetch'])
  assert.deepEqual(harness.stats(), { nodeFetchCalls: 0, contextRequestCalls: 0 })
})

test('Submit invokes beforeDispatch once and never retries a failed browser fetch', async (t) => {
  const harness = browserHarness(t, { failSubmit: true })
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  let beforeDispatchCalls = 0

  await assert.rejects(() => client.postSubmit({
    session: bettingSession(),
    wireFields: SUBMIT_WIRE,
    beforeDispatch: async () => {
      beforeDispatchCalls += 1
      harness.events.push('beforeDispatch')
    },
  }), /browser-submit-network-failure/)

  assert.equal(beforeDispatchCalls, 1)
  assert.equal(harness.requests.length, 1)
  assert.deepEqual(harness.events, ['beforeDispatch', 'evaluate', 'fetch'])
  assert.deepEqual(harness.stats(), { nodeFetchCalls: 0, contextRequestCalls: 0 })
})

test('rejects non-exact origins, page origin drift, and unknown betting operations', async (t) => {
  assert.throws(() => new CrownBrowserApiClient({ page: {}, origin: 'http://crown.example.com' }), /https|origin/i)
  assert.throws(() => new CrownBrowserApiClient({ page: {}, origin: `${ORIGIN}/path` }), /origin|exact/i)

  const harness = browserHarness(t)
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  harness.setPageUrl('https://other.example.com/index.php')
  await assert.rejects(() => client.postPreview({
    session: bettingSession(),
    wireFields: PREVIEW_WIRE,
  }), /origin/i)

  harness.setPageUrl(`${ORIGIN}/index.php`)
  await assert.rejects(() => client.postPreview({
    session: bettingSession(),
    wireFields: { ...PREVIEW_WIRE, p: 'unknown_operation' },
  }), /operation|endpoint|preview/i)
  assert.equal(harness.requests.length, 0)
})

test('page fetch rejects a cross-origin document base before transport', async (t) => {
  const harness = browserHarness(t)
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  harness.setDocumentBase('https://other.example.com/base/')
  await assert.rejects(() => client.postPreview({
    session: bettingSession(),
    wireFields: PREVIEW_WIRE,
  }), /browser-preview-network-failure/)
  assert.equal(harness.requests.length, 0)
})

test('result query constructs the verified nine-field descriptor and safe transport metadata', async (t) => {
  const harness = browserHarness(t)
  harness.setResponse({
    url: `${ORIGIN}/transform.php`,
    body: JSON.stringify({ amout_gold: '0', code: '0', count: 0, pay_type: 0, ts: '', wagers: [] }),
  })
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })

  const response = await client.queryResult({ session: bettingSession() })
  const request = harness.requests.at(-1)
  assert.deepEqual([...request.form.keys()].sort(), [
    'LS', 'chk_cw', 'db_slow', 'format', 'langx', 'p', 'selGtype', 'ts', 'uid',
  ])
  assert.deepEqual(Object.fromEntries([...request.form].filter(([key]) => key !== 'ts' && key !== 'uid')), {
    p: 'get_today_wagers',
    langx: 'zh-cn',
    LS: 'g',
    selGtype: 'ALL',
    chk_cw: 'N',
    format: 'json',
    db_slow: 'N',
  })
  assert.equal(request.form.get('uid'), 'uid-a')
  assert.match(request.form.get('ts'), /^\d{13}$/)
  assert.equal(request.form.has('ver'), false)
  assert.deepEqual(response.transport, {
    operation: 'get_today_wagers',
    endpointPath: '/transform.php',
    method: 'POST',
    status: 200,
    requestFieldSet: ['LS', 'chk_cw', 'db_slow', 'format', 'langx', 'p', 'selGtype', 'ts', 'uid'],
    requestFieldSetFingerprint: 'sha256:51b7c7559e3518183e358abecb8cb8a0a4faf0811e1cc83608243f42190ce374',
    requestTimestampDigest: response.transport.requestTimestampDigest,
  })
  assert.match(response.transport.requestTimestampDigest, /^sha256:[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(response.transport), /uid-a/)

  assert.throws(() => client.queryResult({
    session: bettingSession(),
    wireFields: { p: 'get_today_wagers' },
  }), /browser-result-input-not-allowed/)
  assert.equal(harness.requests.length, 1)
})

test('redirected and foreign responses are rejected before their body crosses the page boundary', async (t) => {
  const harness = browserHarness(t)
  const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
  const secretBody = '<serverresponse><uid>secret-uid</uid><ticket_id>secret-ticket</ticket_id></serverresponse>'

  harness.setResponse({ redirected: true, url: `${ORIGIN}/transform.php`, body: secretBody })
  const redirectError = await rejectedError(() => client.postPreview({
    session: bettingSession(),
    wireFields: PREVIEW_WIRE,
  }))
  assert.match(String(redirectError), /redirect-blocked/)
  assert.doesNotMatch(String(redirectError), /secret-uid|secret-ticket/)
  assert.equal(harness.responseTextReads(), 0)

  harness.setResponse({ url: 'https://other.example.com/transform.php', body: secretBody })
  const foreignError = await rejectedError(() => client.postPreview({
    session: bettingSession(),
    wireFields: PREVIEW_WIRE,
  }))
  assert.match(String(foreignError), /response-origin-mismatch/)
  assert.doesNotMatch(String(foreignError), /secret-uid|secret-ticket/)
  assert.equal(harness.responseTextReads(), 0)
})

test('browser security and lifecycle events poison the client', async (t) => {
  const expectPoisoned = async (harness, client) => {
    await assert.rejects(() => client.postPreview({
      session: bettingSession(),
      wireFields: PREVIEW_WIRE,
    }), /browser-page-security-violation/)
    assert.equal(harness.requests.length, 0)
  }

  await t.test('popup is closed', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    let closeCalls = 0
    harness.context.emit('page', { async close() { closeCalls += 1 } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeCalls, 1)
    await expectPoisoned(harness, client)
  })

  await t.test('download is cancelled', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    let cancelCalls = 0
    harness.page.emit('download', { async cancel() { cancelCalls += 1 } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelCalls, 1)
    await expectPoisoned(harness, client)
  })

  await t.test('cross-origin main-frame navigation remains poisoned after returning', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    harness.setFrameUrl('https://other.example.com/login')
    harness.page.emit('framenavigated', harness.mainFrame)
    harness.setFrameUrl(`${ORIGIN}/index.php`)
    await expectPoisoned(harness, client)
  })

  await t.test('page crash', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    harness.page.emit('crash')
    await expectPoisoned(harness, client)
  })

  await t.test('context close', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    harness.context.emit('close')
    await expectPoisoned(harness, client)
  })

  await t.test('browser disconnect', async (t) => {
    const harness = browserHarness(t)
    const client = new CrownBrowserApiClient({ page: harness.page, origin: ORIGIN })
    harness.browser.emit('disconnected')
    await expectPoisoned(harness, client)
  })
})
