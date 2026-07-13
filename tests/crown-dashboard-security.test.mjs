import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

const PASSWORD = 'local-dashboard-password'
const SESSION_KEY = 'test-session-signing-key-that-is-not-returned'

function passwordScrypt(password = PASSWORD) {
  const salt = Buffer.from('dashboard-security-test-salt')
  const digest = scryptSync(password, salt, 32)
  return `scrypt:${salt.toString('base64url')}:${digest.toString('base64url')}`
}

async function startServer(t, env = {}, { remoteAddress = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-security-'))
  const staticDir = path.join(dir, 'public')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Dashboard</title>', 'utf8')

  const server = createDashboardServer({
    staticDir,
    appOptions: {
      dbPath: path.join(dir, 'crown.sqlite'),
      env: {
        CROWN_LOCAL_SECRET_KEY_PATH: path.join(dir, 'local-secret.key'),
        CROWN_DASHBOARD_PASSWORD_SCRYPT: passwordScrypt(),
        CROWN_DASHBOARD_SESSION_KEY: SESSION_KEY,
        ...env,
      },
    },
  })
  if (remoteAddress) {
    server.prependListener('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: remoteAddress })
    })
  }
  t.after(() => server.close())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  })
  return { response, payload: await response.json() }
}

async function rawJsonFetch(url, options = {}) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        response: {
          status: response.statusCode,
          headers: { get: (name) => {
            const value = response.headers[String(name).toLowerCase()]
            return Array.isArray(value) ? value.join(', ') : value || null
          } },
        },
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

async function login(baseUrl, { password = PASSWORD, headers = {} } = {}) {
  return jsonFetch(`${baseUrl}/api/app/session`, {
    method: 'POST',
    headers: { origin: baseUrl, ...headers },
    body: JSON.stringify({ password }),
  })
}

function cookiePair(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] || ''
}

test('unconfigured loopback dashboard is passwordless but still requires same-origin CSRF', async (t) => {
  const baseUrl = await startServer(t, {
    CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
    CROWN_DASHBOARD_SESSION_KEY: '',
  })

  const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
  assert.equal(bootstrap.response.status, 200)
  assert.equal(bootstrap.payload.dashboardAccessMode, 'local-trust')
  assert.match(bootstrap.payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)

  const body = JSON.stringify({
    eventKey: 'crown|football|gid=passwordless-local',
    league: '英超',
    homeTeam: '主队',
    awayTeam: '客队',
    mode: 'prematch',
  })
  const missingCsrf = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { origin: baseUrl }, body,
  })
  assert.equal(missingCsrf.response.status, 403)
  assert.deepEqual(missingCsrf.payload, { error: 'csrf-invalid' })

  const wrongCsrf = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { origin: baseUrl, 'x-csrf-token': 'wrong' }, body,
  })
  assert.equal(wrongCsrf.response.status, 403)
  assert.deepEqual(wrongCsrf.payload, { error: 'csrf-invalid' })

  const accepted = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { origin: baseUrl, 'x-csrf-token': bootstrap.payload.csrfToken }, body,
  })
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.payload.item.eventKey, 'crown|football|gid=passwordless-local')
})

test('settings and rule-card mutations are rejected before route dispatch without same-origin CSRF', async (t) => {
  const baseUrl = await startServer(t, {
    CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
    CROWN_DASHBOARD_SESSION_KEY: '',
  })
  const context = await jsonFetch(`${baseUrl}/api/app/security-context`)
  const routes = [
    ['PUT', '/api/app/monitor-alert-settings/prematch'],
    ['PUT', '/api/app/auto-betting-settings/prematch'],
    ['POST', '/api/app/auto-bet-rules'],
    ['POST', '/api/app/auto-betting-rule-cards'],
    ['PUT', '/api/app/auto-betting-rule-cards/card-1'],
    ['DELETE', '/api/app/auto-betting-rule-cards/card-1'],
  ]
  for (const [method, pathname] of routes) {
    const missingToken = await jsonFetch(`${baseUrl}${pathname}`, {
      method,
      headers: { origin: baseUrl },
      body: '{}',
    })
    assert.equal(missingToken.response.status, 403, `${pathname} missing token`)
    assert.deepEqual(missingToken.payload, { error: 'csrf-invalid' })

    const wrongOrigin = await jsonFetch(`${baseUrl}${pathname}`, {
      method,
      headers: { origin: 'https://evil.example', 'x-csrf-token': context.payload.csrfToken },
      body: '{}',
    })
    assert.equal(wrongOrigin.response.status, 403, `${pathname} wrong origin`)
    assert.deepEqual(wrongOrigin.payload, { error: 'origin-not-allowed' })
  }
})

test('security context returns local CSRF without building the full dashboard bootstrap', async (t) => {
  const baseUrl = await startServer(t, {
    CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
    CROWN_DASHBOARD_SESSION_KEY: '',
  })

  const context = await jsonFetch(`${baseUrl}/api/app/security-context`)

  assert.equal(context.response.status, 200)
  assert.equal(context.payload.dashboardAccessMode, 'local-trust')
  assert.match(context.payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.deepEqual(Object.keys(context.payload).sort(), ['appContractVersion', 'csrfToken', 'dashboardAccessMode', 'schemaVersion'])
})

test('passwordless mode rejects a remote peer that forges loopback Host and Origin', async (t) => {
  const baseUrl = await startServer(t, {
    CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
    CROWN_DASHBOARD_SESSION_KEY: '',
  }, { remoteAddress: '203.0.113.20' })

  const response = await rawJsonFetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { host: 'localhost', origin: 'http://localhost' },
  })
  assert.equal(response.response.status, 403)
  assert.deepEqual(response.payload, { error: 'remote-not-allowed' })
})

test('loopback read-only GET stays compatible while mutation requires a session', async (t) => {
  const baseUrl = await startServer(t)

  const health = await jsonFetch(`${baseUrl}/api/health`)
  assert.equal(health.response.status, 200)

  const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
  assert.equal(bootstrap.response.status, 200)
  assert.equal(bootstrap.payload.csrfToken, undefined)
  assert.equal(bootstrap.payload.dashboardAccessMode, 'readonly')

  const mutation = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST',
    headers: { origin: baseUrl },
    body: '{}',
  })
  assert.equal(mutation.response.status, 401)
  assert.deepEqual(mutation.payload, { error: 'authentication-required' })
})

test('session verifies scrypt password and returns only an opaque signed cookie', async (t) => {
  const baseUrl = await startServer(t)

  const wrong = await login(baseUrl, { password: 'wrong-password' })
  assert.equal(wrong.response.status, 401)
  assert.deepEqual(wrong.payload, { error: 'invalid-credentials' })
  assert.equal(wrong.response.headers.get('set-cookie'), null)

  const authenticated = await login(baseUrl)
  assert.equal(authenticated.response.status, 200)
  assert.deepEqual(authenticated.payload, { authenticated: true })
  const setCookie = authenticated.response.headers.get('set-cookie') || ''
  assert.match(setCookie, /^crown_dashboard_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/)
  assert.match(setCookie, /; HttpOnly/i)
  assert.match(setCookie, /; SameSite=Strict/i)
  assert.match(setCookie, /; Path=\//i)
  assert.doesNotMatch(setCookie, /; Secure/i)
  assert.doesNotMatch(JSON.stringify(authenticated.payload), new RegExp(PASSWORD))
  assert.doesNotMatch(JSON.stringify(authenticated.payload), new RegExp(SESSION_KEY))
  assert.doesNotMatch(JSON.stringify(authenticated.payload), /crown_dashboard_session/i)

  const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { cookie: cookiePair(authenticated.response) },
  })
  assert.equal(bootstrap.response.status, 200)
  assert.match(bootstrap.payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(bootstrap.payload.dashboardAccessMode, 'password-session')
  assert.equal(Object.keys(bootstrap.payload).filter((key) => /password|session|cookie|signing/i.test(key)).length, 0)

  const signedCookie = cookiePair(authenticated.response)
  const tamperedCookie = `${signedCookie.slice(0, -1)}${signedCookie.endsWith('A') ? 'B' : 'A'}`
  const tampered = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST',
    headers: { cookie: tamperedCookie, origin: baseUrl, 'x-csrf-token': bootstrap.payload.csrfToken },
    body: '{}',
  })
  assert.equal(tampered.response.status, 401)
  assert.deepEqual(tampered.payload, { error: 'authentication-required' })
})

test('every mutating API requires same-origin and the server-side CSRF value', async (t) => {
  const baseUrl = await startServer(t)
  const authenticated = await login(baseUrl)
  const cookie = cookiePair(authenticated.response)
  const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`, { headers: { cookie } })
  const csrfToken = bootstrap.payload.csrfToken
  const body = JSON.stringify({
    eventKey: 'crown|football|gid=security-test',
    league: '英超',
    homeTeam: '主队',
    awayTeam: '客队',
    mode: 'prematch',
  })

  const noOrigin = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken }, body,
  })
  assert.equal(noOrigin.response.status, 403)
  assert.deepEqual(noOrigin.payload, { error: 'origin-required' })

  const wrongCsrf = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { cookie, origin: baseUrl, 'x-csrf-token': 'wrong' }, body,
  })
  assert.equal(wrongCsrf.response.status, 403)
  assert.deepEqual(wrongCsrf.payload, { error: 'csrf-invalid' })

  const accepted = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST', headers: { cookie, origin: baseUrl, 'x-csrf-token': csrfToken }, body,
  })
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.payload.item.eventKey, 'crown|football|gid=security-test')
})

test('execution-control endpoints are rejected by session and CSRF checks before routing', async (t) => {
  const baseUrl = await startServer(t)
  const paths = [
    '/api/app/betting-rules/rule-test/real-eligibility',
    '/api/app/execution-authorizations',
    '/api/app/execution-authorizations/auth-test/revoke',
  ]

  for (const pathname of paths) {
    const unauthenticated = await jsonFetch(`${baseUrl}${pathname}`, {
      method: 'POST', headers: { origin: baseUrl }, body: '{}',
    })
    assert.equal(unauthenticated.response.status, 401)
    assert.deepEqual(unauthenticated.payload, { error: 'authentication-required' })
  }

  const authenticated = await login(baseUrl)
  const cookie = cookiePair(authenticated.response)
  for (const pathname of paths) {
    const invalidCsrf = await jsonFetch(`${baseUrl}${pathname}`, {
      method: 'POST', headers: { cookie, origin: baseUrl, 'x-csrf-token': 'invalid' }, body: '{}',
    })
    assert.equal(invalidCsrf.response.status, 403)
    assert.deepEqual(invalidCsrf.payload, { error: 'csrf-invalid' })
  }
})

test('Host and Origin deny non-loopback by default before routing', async (t) => {
  const baseUrl = await startServer(t)

  const badHost = await rawJsonFetch(`${baseUrl}/api/health`, { headers: { host: 'dashboard.example.test' } })
  assert.equal(badHost.response.status, 403)
  assert.deepEqual(badHost.payload, { error: 'host-not-allowed' })

  const badOrigin = await jsonFetch(`${baseUrl}/api/health`, { headers: { origin: 'https://evil.example' } })
  assert.equal(badOrigin.response.status, 403)
  assert.deepEqual(badOrigin.payload, { error: 'origin-not-allowed' })
})

test('loopback defaults reject a remote peer that forges localhost Host and Origin', async (t) => {
  const baseUrl = await startServer(t, {}, { remoteAddress: '203.0.113.10' })
  const response = await rawJsonFetch(`${baseUrl}/api/app/session`, {
    method: 'POST',
    headers: { host: 'localhost', origin: 'http://localhost' },
    body: JSON.stringify({ password: PASSWORD }),
  })

  assert.equal(response.response.status, 403)
  assert.deepEqual(response.payload, { error: 'remote-not-allowed' })
})

test('explicit Host and Origin allowlists permit one matching non-loopback origin', async (t) => {
  const baseUrl = await startServer(t, {
    CROWN_DASHBOARD_ALLOWED_HOSTS: 'dashboard.example.test',
    CROWN_DASHBOARD_ALLOWED_ORIGINS: 'https://dashboard.example.test',
  }, { remoteAddress: '203.0.113.10' })

  const authenticated = await rawJsonFetch(`${baseUrl}/api/app/session`, {
    method: 'POST',
    headers: {
      host: 'dashboard.example.test',
      origin: 'https://dashboard.example.test',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(authenticated.response.status, 200)
  assert.match(authenticated.response.headers.get('set-cookie') || '', /; Secure/i)
})

test('session storage is bounded and evicts the oldest authenticated session', async (t) => {
  const baseUrl = await startServer(t, { CROWN_DASHBOARD_SESSION_MAX: '2' })
  const first = await login(baseUrl)
  const second = await login(baseUrl)
  const third = await login(baseUrl)
  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.equal(third.response.status, 200)

  const evicted = await jsonFetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { cookie: cookiePair(first.response) },
  })
  const retained = await jsonFetch(`${baseUrl}/api/app/bootstrap`, {
    headers: { cookie: cookiePair(third.response) },
  })
  assert.equal(evicted.payload.csrfToken, undefined)
  assert.match(retained.payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)
})

test('expired session returns 401, is purged, and cannot be revived by rewinding the clock', async (t) => {
  const originalNow = Date.now
  const loginTime = Date.parse('2026-07-11T00:00:00.000Z')
  let now = loginTime
  Date.now = () => now
  t.after(() => { Date.now = originalNow })

  const baseUrl = await startServer(t)
  const authenticated = await login(baseUrl)
  const cookie = cookiePair(authenticated.response)
  const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`, { headers: { cookie } })
  assert.match(bootstrap.payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)

  now += 8 * 60 * 60 * 1000 + 1
  const expiredMutation = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'x-csrf-token': bootstrap.payload.csrfToken },
    body: '{}',
  })
  assert.equal(expiredMutation.response.status, 401)
  assert.deepEqual(expiredMutation.payload, { error: 'authentication-required' })

  now = loginTime
  const purged = await jsonFetch(`${baseUrl}/api/app/bootstrap`, { headers: { cookie } })
  assert.equal(purged.payload.csrfToken, undefined)
})

test('failed login rate limit is per remote IP and successful login clears failures', async (t) => {
  const baseUrl = await startServer(t, { CROWN_DASHBOARD_LOGIN_MAX_FAILURES: '2' })
  assert.equal((await login(baseUrl, { password: 'wrong-one' })).response.status, 401)
  assert.equal((await login(baseUrl)).response.status, 200)
  assert.equal((await login(baseUrl, { password: 'wrong-two' })).response.status, 401)
  assert.equal((await login(baseUrl, { password: 'wrong-three' })).response.status, 401)

  const blocked = await login(baseUrl)
  assert.equal(blocked.response.status, 429)
  assert.deepEqual(blocked.payload, { error: 'login-rate-limited' })
  assert.match(blocked.response.headers.get('retry-after') || '', /^\d+$/)
})
