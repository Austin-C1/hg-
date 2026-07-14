import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CrownApiClient,
  CrownApiLoginManager,
  CrownApiSessionStore,
  crownRequestScopeFromForm,
  normalizeCrownBaseUrl,
} from '../src/crown/login/crown-api-login-manager.mjs'

const BETTING_ALLOWED_ORIGINS = 'https://m407.mos077.com'

test('Crown API base URL requires the shared canonical public HTTPS exact origin', () => {
  assert.equal(normalizeCrownBaseUrl('https://crown.example.com'), 'https://crown.example.com')
  for (const value of [
    'crown.example.com',
    'https://crown.example.com/login',
    'http://crown.example.com',
    'https://localhost',
    'https://8.8.8.8',
  ]) {
    assert.throws(() => normalizeCrownBaseUrl(value), /crown-origin-/)
  }
})

function tempRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-api-login-'))
}

function response(body, { status = 200, cookies = [] } = {}) {
  const headers = {
    get(name) {
      if (String(name).toLowerCase() !== 'set-cookie') return null
      return cookies.join(', ')
    },
    getSetCookie() {
      return cookies
    },
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async arrayBuffer() {
      return Buffer.from(body, 'utf8')
    },
  }
}

function byteResponse(bytes, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null }, getSetCookie() { return [] } },
    async arrayBuffer() { return bytes },
  }
}

function fakeFetch(responses, calls = []) {
  return async (url, options = {}) => {
    calls.push({
      url: String(url),
      body: Object.fromEntries(new URLSearchParams(String(options.body || ''))),
      headers: options.headers || {},
      redirect: options.redirect,
    })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return next
  }
}

function loginXml(uid = 'uid-123') {
  return `<serverresponse><status>200</status><uid>${uid}</uid><balance>123.45</balance></serverresponse>`
}

function gameListXml() {
  return `
    <serverresponse>
      <game>
        <GID>41001</GID>
        <GIDM>41001</GIDM>
        <LID>900</LID>
        <LEAGUE>England Premier League</LEAGUE>
        <TEAM_H>Arsenal</TEAM_H>
        <TEAM_C>Chelsea</TEAM_C>
        <RATIO_R>0 / 0.5</RATIO_R>
        <IOR_RH>0.92</IOR_RH>
        <IOR_RC>0.98</IOR_RC>
      </game>
    </serverresponse>
  `
}

test('Crown API response decoding preserves valid UTF-8 and falls back to GB18030 only for invalid UTF-8 bytes', async () => {
  const utf8Xml = '<serverresponse><LEAGUE>俄罗斯青年足球联赛 U19</LEAGUE><TEAM_H>莫斯科中央陆军U19</TEAM_H></serverresponse>'
  const gbXml = Buffer.concat([
    Buffer.from('<serverresponse><LEAGUE>', 'ascii'),
    Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]),
    Buffer.from('</LEAGUE></serverresponse>', 'ascii'),
  ])
  const client = new CrownApiClient({
    fetchImpl: fakeFetch([byteResponse(Buffer.from(utf8Xml, 'utf8')), byteResponse(gbXml)]),
  })

  const utf8 = await client.postForm({
    baseUrl: 'https://crown.example.com', endpointPath: '/transform.php', form: { p: 'get_game_list' },
  })
  const gb = await client.postForm({
    baseUrl: 'https://crown.example.com', endpointPath: '/transform.php', form: { p: 'get_game_list' },
  })

  assert.equal(utf8.text, utf8Xml)
  assert.match(gb.text, /<LEAGUE>中文<\/LEAGUE>/)
})

test('Crown request scopes use endpoint-specific allowlists', () => {
  assert.deepEqual(crownRequestScopeFromForm({
    p: 'get_game_list', uid: 'secret-uid', showtype: 'today', rtype: 'r', filter: 'MIX', gtype: 'ft',
    password: 'secret', arbitrary: 'drop-me',
  }), {
    endpointKind: 'get_game_list',
    gtype: 'ft',
    showtype: 'today',
    rtype: 'r',
    filter: 'MIX',
  })
  assert.deepEqual(crownRequestScopeFromForm({
    p: 'get_game_more', uid: 'secret-uid', lid: '7001', ecid: '8001', filter: 'Main', ts: 'volatile', token: 'secret',
  }), {
    endpointKind: 'get_game_more',
    lid: '7001',
    filter: 'Main',
    ecid: '8001',
  })
  assert.deepEqual(crownRequestScopeFromForm({ p: 'unknown', filter: 'must-not-pass' }), { endpointKind: 'unknown' })
})

test('manual betting account access check fresh-logins, verifies football, and reads display-only Crown credit', async () => {
  const calls = []
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: '',
    fetchImpl: fakeFetch([
      response(loginXml(), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified; Path=/'] }),
      response('<serverresponse><code>get_all_data</code><enable>Y</enable><currency>RMB</currency><maxcredit>1950</maxcredit><cash>0</cash></serverresponse>'),
    ], calls),
  })

  assert.equal(typeof manager.testBettingAccountAccess, 'function')
  if (typeof manager.testBettingAccountAccess !== 'function') return
  const account = {
    id: 'bet-access', accountId: 'bet-access', username: 'bet-user', password: 'bet-password',
    loginUrl: 'https://m407.mos077.com',
  }
  const result = await manager.testBettingAccountAccess({ account })

  assert.deepEqual(result, {
    ok: true,
    status: 'available',
    errorCode: '',
    reportedBalance: '1950',
    reportedCurrency: 'CNY',
    balanceSource: 'account-summary',
  })
  assert.deepEqual(calls.map((call) => call.body.p), ['chk_login', 'get_game_list', 'get_member_data'])
  assert.equal(calls[2].body.change, 'all')
  assert.equal(calls.some((call) => call.body.p === 'FT_order_view' || call.body.p === 'FT_bet'), false)
  assert.equal(JSON.stringify(result).includes('uid-123'), false)
  assert.equal(JSON.stringify(result).includes('bet-password'), false)
  await assert.rejects(() => manager.ensureBettingSession({ account }), /betting-origin-not-allowed/)
  assert.equal(calls.length, 3)
})

test('manual betting access fails closed with a stable code when member balance is unusable', async () => {
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(), bettingAllowedOrigins: '',
    fetchImpl: fakeFetch([
      response(loginXml(), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified; Path=/'] }),
      response('<serverresponse><code>get_all_data</code><enable>Y</enable><currency>USD</currency><maxcredit>-1</maxcredit></serverresponse>'),
    ], []),
  })
  const result = await manager.testBettingAccountAccess({ account: {
    id: 'bet-balance', accountId: 'bet-balance', username: 'user', password: 'secret',
    loginUrl: 'https://m407.mos077.com', currency: 'CNY',
  } })
  assert.deepEqual(result, {
    ok: false, status: 'failed', errorCode: 'balance-unavailable',
    reportedBalance: null, reportedCurrency: '', balanceSource: 'none',
  })
})

test('execution balance refresh uses the current betting session and returns exact integer CNY', async () => {
  const calls = []
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    now: () => new Date('2026-07-13T08:00:00.000Z'),
    fetchImpl: fakeFetch([
      response(loginXml(), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified; Path=/'] }),
      response('<serverresponse><code>get_all_data</code><enable>Y</enable><currency>RMB</currency><maxcredit>1950.00</maxcredit></serverresponse>', {
        cookies: ['SESSION=balanced; Path=/'],
      }),
    ], calls),
  })
  const account = {
    id: 'bet-execution-balance', accountId: 'bet-execution-balance', username: 'bet-user', password: 'bet-password',
    loginUrl: BETTING_ALLOWED_ORIGINS, currency: 'CNY',
  }

  const result = await manager.fetchFreshExecutionBalance({ account })

  assert.deepEqual({
    balanceCny: result.balanceCny,
    currency: result.currency,
    observedAt: result.observedAt,
    accountId: result.session.accountId,
  }, {
    balanceCny: 1950,
    currency: 'CNY',
    observedAt: '2026-07-13T08:00:00.000Z',
    accountId: account.id,
  })
  assert.deepEqual(calls.map((call) => call.body.p), ['chk_login', 'get_game_list', 'get_member_data'])
  assert.equal(result.session.cookies.SESSION, 'balanced')
  assert.doesNotMatch(JSON.stringify(result), /bet-password|owner-uid/)
})

for (const [name, memberXml] of [
  ['non-CNY currency', '<serverresponse><code>get_all_data</code><enable>Y</enable><currency>USD</currency><maxcredit>10</maxcredit></serverresponse>'],
  ['fractional CNY', '<serverresponse><code>get_all_data</code><enable>Y</enable><currency>RMB</currency><maxcredit>10.5</maxcredit></serverresponse>'],
  ['unsafe integer', `<serverresponse><code>get_all_data</code><enable>Y</enable><currency>RMB</currency><maxcredit>${Number.MAX_SAFE_INTEGER + 1}</maxcredit></serverresponse>`],
]) {
  test(`execution balance refresh rejects ${name}`, async () => {
    const manager = new CrownApiLoginManager({
      runtimeDir: tempRuntimeDir(),
      bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
      fetchImpl: fakeFetch([
        response(loginXml()),
        response(gameListXml()),
        response(memberXml),
      ]),
    })
    await assert.rejects(() => manager.fetchFreshExecutionBalance({ account: {
      id: 'bet-invalid-balance', accountId: 'bet-invalid-balance', username: 'bet-user', password: 'bet-password',
      loginUrl: BETTING_ALLOWED_ORIGINS, currency: 'CNY',
    } }), /betting-execution-balance-unavailable/)
  })
}

test('Crown API login posts chk_login, verifies XML, and saves an API session', async () => {
  const calls = []
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([
      response(loginXml(), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified; Path=/'] }),
    ], calls),
  })

  const result = await manager.ensureLogin({
    account: {
      id: 'mon_primary',
      username: 'monitor-user',
      password: 'monitor-password',
      loginUrl: 'https://m407.mos077.com',
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, '已登录')
  assert.equal(result.loginMethod, '接口登录')
  assert.equal(result.cookieStatus, '已保存')
  assert.equal(result.storageStateStatus, '不适用')
  assert.equal(result.xmlVerified, true)
  assert.equal(calls[0].url, 'https://m407.mos077.com/transform_nl.php')
  assert.equal(calls[0].body.p, 'chk_login')
  assert.equal(calls[0].body.username, 'monitor-user')
  assert.equal(calls[0].body.password, 'monitor-password')
  assert.equal(calls[0].body.auto, 'CDBHGD')
  assert.equal(calls[1].url, 'https://m407.mos077.com/transform.php')
  assert.equal(calls[1].body.p, 'get_game_list')
  assert.equal(calls[1].body.uid, 'uid-123')
  assert.deepEqual(result.requestScope, {
    endpointKind: 'get_game_list',
    p3type: '',
    date: '',
    gtype: 'ft',
    showtype: 'today',
    rtype: 'r',
    ltype: '3',
    filter: 'MIX',
    cupFantasy: 'N',
    sorttype: 'L',
    specialClick: '',
    isFantasy: 'N',
  })
  assert.equal(JSON.stringify(result.requestScope).includes('uid-123'), false)
  assert.equal(JSON.stringify(result.requestScope).includes('SESSION'), false)

  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'crown-sessions', 'mon_primary', 'api-session.json'), 'utf8'))
  assert.equal(saved.uid, 'uid-123')
  assert.equal(saved.cookies.SESSION, 'verified')
})

test('betting session accepts protocolVersion only from captured verified production response metadata', async () => {
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response('<serverresponse><status>200</status><uid>owner-uid</uid><ver>prod-v20260713</ver></serverresponse>'),
      response(gameListXml()),
    ]),
  })
  const account = {
    id: 'bet-protocol', accountId: 'bet-protocol', username: 'bet-user', password: 'bet-password',
    loginUrl: 'https://m407.mos077.com',
  }
  const result = await manager.ensureBettingSession({ account })
  assert.equal(result.session.protocolVersion, 'prod-v20260713')
  assert.deepEqual(result.session.protocolVersionEvidence, {
    source: 'production-login-response', captured: true, verified: true,
  })
  const saved = fs.readFileSync(path.join(runtimeDir, 'crown-sessions', account.id, 'api-session.json'), 'utf8')
  assert.doesNotMatch(saved, /prod-v20260713|protocolVersion|bet-password|rawBody|responseBody/)
})

test('betting preview provenance cannot be forged by a cached session file', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet-forged-version', username: 'bet-user', password: 'bet-password',
    loginUrl: 'https://m407.mos077.com',
  }
  const sessionDir = path.join(runtimeDir, 'crown-sessions', account.id)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'api-session.json'), JSON.stringify({
    uid: 'forged-uid', cookies: { SESSION: 'forged' }, accountId: account.id,
    username: account.username, baseUrl: account.loginUrl, savedAt: 1,
    protocolVersion: 'forged-version',
    protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
  }))
  const calls = []
  const manager = new CrownApiLoginManager({
    runtimeDir, bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response('<serverresponse><status>200</status><uid>fresh-uid</uid><ver>fresh-version</ver></serverresponse>'),
      response(gameListXml()),
    ], calls),
  })
  const result = await manager.ensureBettingSession({
    account, requireVerifiedProtocolVersion: true,
  })
  assert.deepEqual(calls.map((call) => call.body.p), ['chk_login', 'get_game_list'])
  assert.equal(calls.some((call) => call.body.uid === 'forged-uid'), false)
  assert.equal(result.session.protocolVersion, 'fresh-version')
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(
    path.join(sessionDir, 'api-session.json'), 'utf8',
  ))).includes('protocolVersion'), false)
})

test('Crown API login reuses a cached API session before logging in again', async () => {
  const runtimeDir = tempRuntimeDir()
  const first = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([
      response(loginXml('cached-uid'), { cookies: ['SESSION=cached; Path=/'] }),
      response(gameListXml()),
    ]),
  })
  const account = { id: 'mon_primary', username: 'monitor-user', password: 'monitor-password', loginUrl: 'https://m407.mos077.com' }
  await first.ensureLogin({ account })

  const calls = []
  const second = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([response(gameListXml())], calls),
  })
  const result = await second.ensureLogin({ account })

  assert.equal(result.ok, true)
  assert.equal(result.loginMethod, '接口缓存')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.p, 'get_game_list')
  assert.equal(calls[0].body.uid, 'cached-uid')
})

test('Crown API login invalidates failed cached sessions and logs in again', async () => {
  const calls = []
  const runtimeDir = tempRuntimeDir()
  fs.mkdirSync(path.join(runtimeDir, 'crown-sessions', 'mon_primary'), { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'crown-sessions', 'mon_primary', 'api-session.json'), JSON.stringify({
    uid: 'old-uid',
    cookies: { SESSION: 'old' },
    username: 'monitor-user',
    baseUrl: 'https://m407.mos077.com',
    savedAt: 1,
  }, null, 2), 'utf8')
  const manager = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([
      response('<serverresponse><status>error</status><msg>doubleLogin</msg></serverresponse>'),
      response(loginXml('fresh-uid'), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml()),
    ], calls),
  })

  const result = await manager.ensureLogin({
    account: { id: 'mon_primary', username: 'monitor-user', password: 'monitor-password', loginUrl: 'https://m407.mos077.com' },
  })

  assert.equal(result.ok, true)
  assert.equal(result.loginMethod, '接口登录')
  assert.deepEqual(calls.map((call) => call.body.p), ['get_game_list', 'chk_login', 'get_game_list'])
  assert.equal(calls[2].body.uid, 'fresh-uid')
})

test('Crown API login saves diagnostics when chk_login fails', async () => {
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([
      response('<serverresponse><status>error</status><msg>101</msg><code_message>bad password</code_message></serverresponse>'),
    ]),
  })

  const result = await manager.ensureLogin({
    account: { id: 'mon_primary', username: 'monitor-user', password: 'monitor-password', loginUrl: 'https://m407.mos077.com' },
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, '登录失效')
  assert.match(result.diagnosticPath, /login-diagnostics/)
  const snapshot = JSON.parse(fs.readFileSync(path.join(result.diagnosticPath, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.accountId, 'mon_primary')
  assert.equal(snapshot.classifiedState, '登录失效')
  assert.equal(snapshot.hasError, true)
  assert.equal(snapshot.debugSummary.provided, true)
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /monitor-user|monitor-password|bad password/)
  assert.doesNotMatch(serialized, /"(?:cookies?|storageState|password|inputs?|bodyText|extraDebug|authorization)"/i)
})

test('Crown API client fetches get_game_more detail XML with event identifiers', async () => {
  const calls = []
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownApiLoginManager({
    runtimeDir,
    fetchImpl: fakeFetch([
      response(`<?xml version="1.0"?><serverresponse><code>617</code><game><GID>41001</GID><LID>900</LID><ECID>800</ECID><LEAGUE>Detail League</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C><RATIO_RE>0</RATIO_RE><IOR_REH>0.92</IOR_REH><IOR_REC>0.98</IOR_REC></game></serverresponse>`),
    ], calls),
  })

  const result = await manager.fetchFootballGameMore({
    account: { id: 'mon_primary', username: 'monitor-user', loginUrl: 'https://m407.mos077.com' },
    session: {
      uid: 'uid-123',
      cookies: { SESSION: 'cached' },
      username: 'monitor-user',
      baseUrl: 'https://m407.mos077.com',
    },
    target: {
      lid: '900',
      ecid: '800',
      mode: 'live',
    },
  })

  assert.equal(result.classification.hasServerResponse, true)
  assert.equal(result.classification.gameCount, 1)
  assert.equal(calls[0].url, 'https://m407.mos077.com/transform.php')
  assert.equal(calls[0].body.p, 'get_game_more')
  assert.equal(calls[0].body.uid, 'uid-123')
  assert.equal(calls[0].body.lid, '900')
  assert.equal(calls[0].body.ecid, '800')
  assert.equal(calls[0].body.showtype, 'live')
  assert.equal(calls[0].body.isRB, 'Y')
  assert.equal(calls[0].body.from, 'game_more')
  assert.deepEqual(result.requestScope, {
    endpointKind: 'get_game_more',
    gtype: 'ft',
    showtype: 'live',
    ltype: '3',
    isRB: 'Y',
    lid: '900',
    specialClick: '',
    mode: 'CUP',
    from: 'game_more',
    filter: 'Main',
    ecid: '800',
  })
  assert.equal(Object.hasOwn(result.requestScope, 'uid'), false)
  assert.equal(Object.hasOwn(result.requestScope, 'ts'), false)
  assert.equal(JSON.stringify(result.requestScope).includes('SESSION'), false)
})

test('Crown API detail fetch exposes rotated response cookies for the next request', async () => {
  const calls = []
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    fetchImpl: fakeFetch([
      response(gameListXml(), { cookies: ['SESSION=rotated-one; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=rotated-two; Path=/'] }),
    ], calls),
  })
  const initial = {
    uid: 'uid-rotate',
    cookies: { SESSION: 'initial' },
    username: 'monitor-user',
    baseUrl: 'https://m407.mos077.com',
  }
  const first = await manager.fetchFootballGameMore({
    session: initial,
    target: { lid: '900', ecid: '800', mode: 'prematch' },
  })
  const second = await manager.fetchFootballGameMore({
    session: first.session,
    target: { lid: '901', ecid: '801', mode: 'prematch' },
  })

  assert.equal(calls[0].headers.cookie, 'SESSION=initial')
  assert.equal(first.session.cookies.SESSION, 'rotated-one')
  assert.equal(calls[1].headers.cookie, 'SESSION=rotated-one')
  assert.equal(second.session.cookies.SESSION, 'rotated-two')
})

test('betting session rejects missing, monitor, and unsafe account ids before file or network access', async () => {
  const runtimeDir = tempRuntimeDir()
  let networkCalls = 0
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('network-must-not-run')
    },
  })
  const base = { username: 'bet-user', password: 'bet-password', loginUrl: 'https://m407.mos077.com' }

  await assert.rejects(() => manager.ensureBettingSession({ account: base }), /betting-account-id-required/)
  await assert.rejects(() => manager.ensureBettingSession({ account: { ...base, id: 'mon_primary' } }), /betting-account-monitor-forbidden/)
  await assert.rejects(() => manager.ensureBettingSession({ account: { ...base, id: '..\\mon_primary' } }), /betting-account-id-invalid/)
  assert.equal(networkCalls, 0)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-sessions')), false)
})

test('betting sessions isolate same-credential accounts and preserve owner through fresh, cached, and rotated cookies', async () => {
  const runtimeDir = tempRuntimeDir()
  const calls = []
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response(loginXml('uid-account-a'), { cookies: ['SESSION=fresh-a; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified-a; Path=/'] }),
      response(loginXml('uid-account-b'), { cookies: ['SESSION=fresh-b; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified-b; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=detail-a; Path=/'] }),
    ], calls),
  })
  const shared = { username: 'same-user', password: 'same-password', loginUrl: 'https://m407.mos077.com' }
  const accountA = { ...shared, id: 'bet_account_a' }
  const accountB = { ...shared, id: 'bet_account_b' }

  const freshA = await manager.ensureBettingSession({ account: accountA })
  const freshB = await manager.ensureBettingSession({ account: accountB })
  assert.equal(freshA.session.accountId, accountA.id)
  assert.equal(freshB.session.accountId, accountB.id)
  const fileA = path.join(runtimeDir, 'crown-sessions', accountA.id, 'api-session.json')
  const fileB = path.join(runtimeDir, 'crown-sessions', accountB.id, 'api-session.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(fileA, 'utf8')), {
    uid: 'uid-account-a',
    cookies: { SESSION: 'verified-a' },
    accountId: accountA.id,
    username: shared.username,
    baseUrl: shared.loginUrl,
    savedAt: freshA.session.savedAt,
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(fileB, 'utf8')), {
    uid: 'uid-account-b',
    cookies: { SESSION: 'verified-b' },
    accountId: accountB.id,
    username: shared.username,
    baseUrl: shared.loginUrl,
    savedAt: freshB.session.savedAt,
  })

  const detail = await manager.fetchBettingFootballGameMore({
    account: accountA,
    session: freshA.session,
    target: { lid: '900', ecid: '800', mode: 'prematch' },
  })
  assert.equal(detail.session.accountId, accountA.id)
  assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf8')).accountId, accountA.id)
  assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf8')).cookies.SESSION, 'detail-a')

  const cachedCalls = []
  const cachedManager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response(gameListXml(), { cookies: ['SESSION=cached-a; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=cached-b; Path=/'] }),
    ], cachedCalls),
  })
  const cachedA = await cachedManager.ensureBettingSession({ account: accountA })
  const cachedB = await cachedManager.ensureBettingSession({ account: accountB })
  assert.deepEqual(cachedCalls.map((call) => call.body.uid), ['uid-account-a', 'uid-account-b'])
  assert.equal(cachedA.loginMethod, '接口缓存')
  assert.equal(cachedB.loginMethod, '接口缓存')
  assert.equal(cachedA.session.accountId, accountA.id)
  assert.equal(cachedB.session.accountId, accountB.id)
  assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf8')).accountId, accountA.id)
  assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf8')).accountId, accountB.id)
})

test('betting cached session with a different owner is never sent and is replaced by the exact account session', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet_exact_owner',
    username: 'same-user',
    password: 'same-password',
    loginUrl: 'https://m407.mos077.com',
  }
  const sessionDir = path.join(runtimeDir, 'crown-sessions', account.id)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'api-session.json'), JSON.stringify({
    uid: 'wrong-owner-uid',
    cookies: { SESSION: 'wrong-owner-cookie' },
    accountId: 'bet_other_owner',
    username: account.username,
    baseUrl: account.loginUrl,
    savedAt: 1,
  }), 'utf8')
  const calls = []
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response(loginXml('exact-owner-uid'), { cookies: ['SESSION=exact-owner; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=exact-owner-verified; Path=/'] }),
    ], calls),
  })

  const result = await manager.ensureBettingSession({ account })
  assert.deepEqual(calls.map((call) => call.body.p), ['chk_login', 'get_game_list'])
  assert.equal(calls.some((call) => call.body.uid === 'wrong-owner-uid'), false)
  assert.equal(result.session.accountId, account.id)
  const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'api-session.json'), 'utf8'))
  assert.equal(saved.accountId, account.id)
  assert.equal(saved.uid, 'exact-owner-uid')
})

test('betting detail rejects a mismatched supplied session owner before network access', async () => {
  let networkCalls = 0
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('network-must-not-run')
    },
  })
  const account = { id: 'bet_detail_owner', username: 'same-user', loginUrl: 'https://m407.mos077.com' }
  await assert.rejects(() => manager.fetchBettingFootballGameMore({
    account,
    session: {
      uid: 'secret-uid',
      cookies: { SESSION: 'secret-cookie' },
      accountId: 'bet_wrong_owner',
      username: account.username,
      baseUrl: account.loginUrl,
    },
    target: { lid: '900', ecid: '800', mode: 'prematch' },
  }), /betting-session-owner-mismatch/)
  assert.equal(networkCalls, 0)
})

test('betting session logs contain owner id and stable event codes but no credentials or session material', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet_safe_logs',
    username: 'sensitive-user',
    password: 'sensitive-password',
    loginUrl: 'https://m407.mos077.com',
  }
  const sessionDir = path.join(runtimeDir, 'crown-sessions', account.id)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'api-session.json'), JSON.stringify({
    uid: 'sensitive-uid',
    cookies: { SESSION: 'sensitive-cookie' },
    accountId: account.id,
    username: account.username,
    baseUrl: account.loginUrl,
    savedAt: 1,
  }), 'utf8')
  const logs = []
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: BETTING_ALLOWED_ORIGINS,
    fetchImpl: fakeFetch([
      response('<serverresponse><status>error</status><msg>sensitive-uid</msg><code_message>sensitive-password sensitive-cookie</code_message></serverresponse>'),
      response(loginXml('safe-new-uid'), { cookies: ['SESSION=safe-new-cookie; Path=/'] }),
      response(gameListXml()),
    ]),
  })

  await manager.ensureBettingSession({ account, logger: (entry) => logs.push(entry) })
  const serialized = JSON.stringify(logs)
  assert.match(serialized, /bet_safe_logs/)
  assert.doesNotMatch(serialized, /sensitive-user|sensitive-password|sensitive-uid|sensitive-cookie/)
})

test('strict owner store rejects an ownerless session instead of relabeling foreign credentials', () => {
  const runtimeDir = tempRuntimeDir()
  const store = new CrownApiSessionStore({ accountId: 'bet_target', runtimeDir, strictOwner: true })

  assert.throws(() => store.saveSession({
    username: 'target-user',
    loginUrl: 'https://m407.mos077.com',
  }, {
    uid: 'foreign-uid',
    cookies: { SESSION: 'foreign-cookie' },
    username: 'foreign-user',
    baseUrl: 'https://foreign.example.com',
  }), /betting-session-owner-mismatch/)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-sessions', 'bet_target', 'api-session.json')), false)
})

test('betting login failure exposes only a stable sanitized error', async () => {
  const rawResponse = '<serverresponse><status>error</status><msg>fake-sensitive-uid</msg><code_message>fake-sensitive-password fake-sensitive-cookie</code_message></serverresponse>'
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins: 'https://crown.example.com',
    fetchImpl: async () => response(rawResponse),
  })

  const error = await manager.ensureBettingSession({
    account: {
      id: 'bet_error',
      username: 'fake-user',
      password: 'fake-password',
      loginUrl: 'https://crown.example.com',
    },
  }).then(() => null, (reason) => reason)
  const serialized = JSON.stringify({ message: error?.message, details: error?.details })

  assert.equal(error?.code, 'failed_login')
  assert.equal(error?.message, 'betting-session-login-failed')
  assert.deepEqual(error?.details, {})
  assert.doesNotMatch(serialized, /fake-sensitive-(?:uid|password|cookie)/)
  assert.doesNotMatch(serialized, /serverresponse|code_message/)
})

test('betting origin allowlist is empty by default and rejects non-allowlisted origins before network access', async () => {
  let networkCalls = 0
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins: '',
    fetchImpl: async () => { networkCalls += 1; throw new Error('network-must-not-run') },
  })
  const account = {
    id: 'bet_origin', username: 'user', password: 'password', loginUrl: 'https://crown.example.com',
  }

  await assert.rejects(() => manager.ensureBettingSession({ account }), /betting-origin-not-allowed/)
  await assert.rejects(() => manager.fetchBettingFootballToday({ account }), /betting-origin-not-allowed/)
  await assert.rejects(() => manager.fetchBettingFootballGameMore({
    account,
    session: { uid: 'uid', cookies: {}, accountId: account.id, username: account.username, baseUrl: account.loginUrl },
    target: { lid: '1', ecid: '2', mode: 'live' },
  }), /betting-origin-not-allowed/)
  assert.equal(networkCalls, 0)
})

test('betting origin allowlist requires public HTTPS exact origins without URL credentials', async () => {
  for (const origin of [
    'http://crown.example.com',
    'https://localhost',
    'https://service.internal',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://user:password@crown.example.com',
    'https://crown.example.com/path',
  ]) {
    const invalidManager = new CrownApiLoginManager({
      runtimeDir: tempRuntimeDir(),
      bettingAllowedOrigins: origin,
      fetchImpl: async () => { throw new Error('network-must-not-run') },
    })
    await assert.rejects(() => invalidManager.ensureBettingSession({
      account: { id: 'bet_invalid_allowlist', username: 'user', password: 'password', loginUrl: 'https://crown.example.com' },
    }), /betting-origin-allowlist-invalid/)
  }

  let networkCalls = 0
  const manager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins: 'https://crown.example.com, https://other.example.com:8443',
    fetchImpl: async () => { networkCalls += 1; throw new Error('network-must-not-run') },
  })
  const base = { id: 'bet_origin_exact', username: 'user', password: 'password' }
  await assert.rejects(() => manager.ensureBettingSession({
    account: { ...base, loginUrl: 'https://not-allowed.example.com' },
  }), /betting-origin-not-allowed/)
  await assert.rejects(() => manager.ensureBettingSession({
    account: { ...base, loginUrl: 'https://user:password@crown.example.com' },
  }), /betting-origin-credentials-forbidden/)
  await assert.rejects(() => manager.ensureBettingSession({
    account: { ...base, loginUrl: 'http://crown.example.com' },
  }), /betting-origin-https-required/)
  for (const loginUrl of [
    'https://crown.example.com/',
    'https://crown.example.com/path',
    'https://crown.example.com?mode=bet',
    'https://crown.example.com#bet',
  ]) {
    await assert.rejects(() => manager.ensureBettingSession({
      account: { ...base, loginUrl },
    }), /betting-origin-exact-required/)
  }
  assert.equal(networkCalls, 0)
})

test('Crown API requests use manual redirects and reject 3xx without adopting redirect cookies', async () => {
  const calls = []
  const cookies = { SESSION: 'owner-cookie' }
  const client = new CrownApiClient({
    fetchImpl: fakeFetch([
      response('', { status: 302, cookies: ['SESSION=redirect-cookie; Path=/'] }),
    ], calls),
  })

  const error = await client.postForm({
    baseUrl: 'https://crown.example.com',
    endpointPath: '/transform.php',
    form: { p: 'get_game_list', uid: 'owner-uid' },
    cookies,
  }).then(() => null, (reason) => reason)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].redirect, 'manual')
  assert.equal(error?.code, 'failed_http')
  assert.equal(error?.message, 'crown redirect blocked')
  assert.deepEqual(cookies, { SESSION: 'owner-cookie' })
})

test('betting session fence runs around networks and before persistence', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet_fenced_fresh', username: 'owner', password: 'password', loginUrl: 'https://crown.example.com',
  }
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: 'https://crown.example.com',
    fetchImpl: fakeFetch([
      response(loginXml('fenced-uid'), { cookies: ['SESSION=fresh; Path=/'] }),
      response(gameListXml(), { cookies: ['SESSION=verified; Path=/'] }),
    ]),
  })
  const checks = []

  await manager.ensureBettingSession({
    account,
    assertFence() { checks.push(checks.length + 1) },
  })

  assert.deepEqual(checks, [1, 2, 3, 4])
  const saved = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'crown-sessions', account.id, 'api-session.json'), 'utf8'))
  assert.equal(saved.uid, 'fenced-uid')
  assert.equal(saved.cookies.SESSION, 'verified')
})

test('lease loss before cached-session invalidation propagates unchanged and preserves the old owner file', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet_fenced_cached', username: 'owner', password: 'password', loginUrl: 'https://crown.example.com',
  }
  const store = new CrownApiSessionStore({ accountId: account.id, runtimeDir, strictOwner: true })
  store.saveSession(account, {
    uid: 'old-owner-uid', cookies: { SESSION: 'old-owner-cookie' }, accountId: account.id,
    username: account.username, baseUrl: account.loginUrl,
  })
  const before = fs.readFileSync(store.sessionPath(), 'utf8')
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: 'https://crown.example.com',
    fetchImpl: fakeFetch([response('<serverresponse><status>error</status><msg>expired</msg></serverresponse>')]),
  })
  const leaseError = new Error('lease-owner-stale-before-invalidate')
  let checks = 0

  const error = await manager.ensureBettingSession({
    account,
    assertFence() {
      checks += 1
      if (checks === 3) throw leaseError
    },
  }).then(() => null, (reason) => reason)

  assert.equal(error, leaseError)
  assert.equal(checks, 3)
  assert.equal(fs.readFileSync(store.sessionPath(), 'utf8'), before)
})

test('lease loss after betting detail network propagates unchanged and does not save rotated cookies', async () => {
  const runtimeDir = tempRuntimeDir()
  const account = {
    id: 'bet_fenced_detail', username: 'owner', loginUrl: 'https://crown.example.com',
  }
  const store = new CrownApiSessionStore({ accountId: account.id, runtimeDir, strictOwner: true })
  const session = store.saveSession(account, {
    uid: 'owner-uid', cookies: { SESSION: 'owner-cookie' }, accountId: account.id,
    username: account.username, baseUrl: account.loginUrl,
  }).session
  const before = fs.readFileSync(store.sessionPath(), 'utf8')
  const manager = new CrownApiLoginManager({
    runtimeDir,
    bettingAllowedOrigins: 'https://crown.example.com',
    fetchImpl: fakeFetch([response(gameListXml(), { cookies: ['SESSION=rotated-cookie; Path=/'] })]),
  })
  const leaseError = new Error('lease-owner-stale-after-detail')
  let checks = 0

  const error = await manager.fetchBettingFootballGameMore({
    account,
    session,
    target: { lid: '900', ecid: '800', mode: 'live' },
    assertFence() {
      checks += 1
      if (checks === 2) throw leaseError
    },
  }).then(() => null, (reason) => reason)

  assert.equal(error, leaseError)
  assert.equal(checks, 2)
  assert.equal(fs.readFileSync(store.sessionPath(), 'utf8'), before)
})
