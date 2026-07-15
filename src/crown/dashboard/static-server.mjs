import fs from 'node:fs/promises'
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { APP_CONTRACT_VERSION } from '../app/app-contract-version.mjs'
import { APP_VERSION } from '../app/app-version.mjs'
import { handleAppApi } from '../app/app-api.mjs'
import { handleLocalConfigApi } from '../app/local-config-api.mjs'
import { readDashboardChanges, readDashboardConfig, readDashboardData } from './dashboard-data.mjs'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const DEFAULT_STATIC_DIR = 'frontend/dist'
const INSTALLATION_ID = /^[A-Za-z0-9_-]{8,128}$/
const LAUNCHER_TOKEN = /^[A-Za-z0-9_-]{43}$/
const LAUNCHER_START_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SESSION_COOKIE = 'crown_dashboard_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const DEFAULT_SESSION_MAX = 256
const DEFAULT_LOGIN_MAX_FAILURES = 5
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAILURE_ENTRY_MAX = 1024
const scryptAsync = promisify(scrypt)

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
])

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers)
  res.end(body)
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
}

function commaList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function parsedHost(value) {
  try {
    const parsed = new URL(`http://${String(value || '').trim()}`)
    return { host: parsed.host.toLowerCase(), hostname: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%', 1)[0]
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

function boundedEnvironmentInteger(value, fallback, { min = 1, max } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  if (!/^\d+$/.test(String(value))) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

function hostAllowed(value, configured) {
  const candidate = parsedHost(value)
  if (!candidate) return false
  const allowed = commaList(configured)
  if (!allowed.length) return isLoopback(candidate.hostname)
  return allowed.some((item) => {
    const expected = parsedHost(item)
    if (!expected) return false
    return item.includes(':') ? candidate.host === expected.host : candidate.hostname === expected.hostname
  })
}

function parsedOrigin(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed
  } catch {
    return null
  }
}

function originAllowed(value, configured, requestHost) {
  const origin = parsedOrigin(value)
  const host = parsedHost(requestHost)
  if (!origin || !host || origin.host.toLowerCase() !== host.host) return false
  const allowed = commaList(configured)
  if (!allowed.length) return isLoopback(origin.hostname.toLowerCase())
  return allowed.some((item) => parsedOrigin(item)?.origin.toLowerCase() === origin.origin.toLowerCase())
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return ''
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseScryptHash(value) {
  const match = /^scrypt:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(String(value || ''))
  if (!match) return null
  const salt = Buffer.from(match[1], 'base64url')
  const digest = Buffer.from(match[2], 'base64url')
  if (!salt.length || digest.length < 16) return null
  return { salt, digest }
}

function createDashboardSecurity(env = process.env) {
  const sessions = new Map()
  const failures = new Map()
  const passwordHash = parseScryptHash(env.CROWN_DASHBOARD_PASSWORD_SCRYPT)
  const signingKey = String(env.CROWN_DASHBOARD_SESSION_KEY || '')
  const localCsrfToken = randomBytes(32).toString('base64url')
  const sessionMax = boundedEnvironmentInteger(env.CROWN_DASHBOARD_SESSION_MAX, DEFAULT_SESSION_MAX, { max: 4096 })
  const loginMaxFailures = boundedEnvironmentInteger(env.CROWN_DASHBOARD_LOGIN_MAX_FAILURES, DEFAULT_LOGIN_MAX_FAILURES, { max: 50 })

  function cleanupSessions(now = Date.now()) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token)
    }
  }

  function cleanupFailures(now = Date.now()) {
    for (const [address, failure] of failures) {
      if (failure.resetAt <= now) failures.delete(address)
    }
  }

  function failureFor(remoteAddress, now = Date.now()) {
    cleanupFailures(now)
    return failures.get(String(remoteAddress || 'unknown')) || null
  }

  function recordFailure(remoteAddress, now = Date.now()) {
    const key = String(remoteAddress || 'unknown')
    const current = failureFor(key, now)
    if (!current && failures.size >= LOGIN_FAILURE_ENTRY_MAX) failures.delete(failures.keys().next().value)
    failures.set(key, {
      count: (current?.count || 0) + 1,
      resetAt: current?.resetAt || now + LOGIN_FAILURE_WINDOW_MS,
    })
  }

  function signature(token) {
    return createHmac('sha256', signingKey).update(token).digest('base64url')
  }

  function sessionFor(req) {
    if (!signingKey) return null
    const signed = cookieValue(req.headers.cookie, SESSION_COOKIE)
    const separator = signed.lastIndexOf('.')
    if (separator <= 0) return null
    const token = signed.slice(0, separator)
    if (!safeEqual(signed.slice(separator + 1), signature(token))) return null
    const now = Date.now()
    cleanupSessions(now)
    const session = sessions.get(token)
    if (!session) return null
    return session
  }

  function localTrustFor(req, { remoteConfigurationPresent = false } = {}) {
    if (passwordHash || signingKey || remoteConfigurationPresent) return null
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return null
    const requestHost = parsedHost(req.headers?.host)
    if (!requestHost || !isLoopback(requestHost.hostname)) return null
    return { csrfToken: localCsrfToken, accessMode: 'local-trust' }
  }

  async function authenticate(password, remoteAddress) {
    if (!passwordHash || !signingKey) return { configured: false }
    const now = Date.now()
    cleanupSessions(now)
    const failure = failureFor(remoteAddress, now)
    if (failure?.count >= loginMaxFailures) {
      return {
        configured: true,
        authenticated: false,
        rateLimited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((failure.resetAt - now) / 1000)),
      }
    }
    const supplied = await scryptAsync(String(password || ''), passwordHash.salt, passwordHash.digest.length)
    if (!timingSafeEqual(Buffer.from(supplied), passwordHash.digest)) {
      recordFailure(remoteAddress)
      return { configured: true, authenticated: false }
    }
    failures.delete(String(remoteAddress || 'unknown'))
    while (sessions.size >= sessionMax) sessions.delete(sessions.keys().next().value)
    const token = randomBytes(32).toString('base64url')
    const session = {
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    sessions.set(token, session)
    return { configured: true, authenticated: true, cookie: `${token}.${signature(token)}`, session }
  }

  return { authenticate, sessionFor, localTrustFor }
}

async function readSessionBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024) throw new Error('payload-too-large')
    chunks.push(chunk)
  }
  try {
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    throw new Error('invalid-json')
  }
}

function requestIsHttps(req) {
  if (req.socket?.encrypted === true) return true
  return String(req.headers['x-forwarded-proto'] || '').split(',', 1)[0].trim().toLowerCase() === 'https'
}

function isMutating(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase())
}

function parsePositiveInteger(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(5000, Math.floor(parsed))
}

function changesDataOptions(requestUrl, dataOptions = {}) {
  return {
    ...dataOptions,
    changeLimit: parsePositiveInteger(requestUrl.searchParams.get('limit'), dataOptions.changeLimit),
    changeEventKey: requestUrl.searchParams.get('eventKey') || dataOptions.changeEventKey || null,
  }
}

async function serveApi(req, requestUrl, res, {
  dataOptions = {},
  appOptions = {},
  csrfToken = null,
  dashboardAccessMode = 'readonly',
} = {}) {
  const { pathname } = requestUrl
  const handledLocal = await handleLocalConfigApi(req, res, requestUrl, { dataOptions, appOptions })
  if (handledLocal) return true

  if (pathname.startsWith('/api/app/')) {
    await handleAppApi(req, res, requestUrl, {
      ...appOptions,
      dataOptions,
      csrfToken,
      dashboardAccessMode,
    })
    return true
  }

  if (pathname === '/api/health') {
    const configuredInstallationId = appOptions.installationId || appOptions.env?.CROWN_INSTALLATION_ID || ''
    const launcherEnv = appOptions.env || {}
    const launchNonce = String(launcherEnv.CROWN_LAUNCHER_NONCE || '')
    const launcherProcessStartTime = String(launcherEnv.CROWN_LAUNCHER_PROCESS_START_TIME || '')
    const suppliedProbe = String(req.headers['x-crown-launcher-probe'] || '')
    const launcherBinding = LAUNCHER_TOKEN.test(launchNonce)
      && LAUNCHER_START_TIME.test(launcherProcessStartTime)
      && new Date(launcherProcessStartTime).toISOString() === launcherProcessStartTime
      ? {
          launchNonce,
          launcherPid: process.pid,
          launcherProcessStartTime,
          launcherProbe: LAUNCHER_TOKEN.test(suppliedProbe) ? suppliedProbe : '',
        }
      : {}
    sendJson(res, 200, {
      ok: true,
      app: 'crown-dashboard',
      readonly: true,
      installationId: INSTALLATION_ID.test(configuredInstallationId) ? configuredInstallationId : '',
      version: APP_VERSION,
      appContractVersion: APP_CONTRACT_VERSION,
      ...launcherBinding,
    })
    return true
  }

  if (pathname === '/api/health/update') {
    sendJson(res, 404, { error: 'not-found' })
    return true
  }

  if (pathname === '/api/config') {
    sendJson(res, 200, await readDashboardConfig(dataOptions.configPath))
    return true
  }

  if (pathname === '/api/changes') {
    sendJson(res, 200, await readDashboardChanges(changesDataOptions(requestUrl, dataOptions)))
    return true
  }

  if (pathname === '/api/summary' || pathname === '/api/events') {
    const data = await readDashboardData({
      ...dataOptions,
      dbPath: dataOptions.dbPath || appOptions.dbPath,
    })
    if (pathname === '/api/summary') sendJson(res, 200, data.summary)
    if (pathname === '/api/events') sendJson(res, 200, data.events)
    return true
  }

  return false
}

function staticTarget(staticDir, pathname) {
  const root = path.resolve(staticDir)
  const decoded = decodeURIComponent(pathname)
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

function isSpaRoute(pathname) {
  return pathname.startsWith('/')
    && pathname !== '/api'
    && !pathname.startsWith('/api/')
    && !pathname.startsWith('/assets/')
    && path.posix.extname(pathname) === ''
}

async function serveStatic(pathname, res, staticDir) {
  if (pathname === '/system-update') {
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  if (pathname === '/favicon.ico') {
    send(res, 204, '')
    return
  }

  const target = staticTarget(staticDir, pathname)
  if (!target) {
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }

  try {
    const stat = await fs.stat(target)
    if (!stat.isFile()) {
      send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    const type = MIME_TYPES.get(path.extname(target).toLowerCase()) || 'application/octet-stream'
    send(res, 200, await fs.readFile(target), { 'content-type': type })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const fallback = staticTarget(staticDir, '/')
    if (fallback && isSpaRoute(pathname)) {
      try {
        send(res, 200, await fs.readFile(fallback), { 'content-type': MIME_TYPES.get('.html') })
        return
      } catch (fallbackError) {
        if (fallbackError?.code !== 'ENOENT') throw fallbackError
      }
    }
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' })
  }
}

export function createDashboardServer({ staticDir = DEFAULT_STATIC_DIR, dataOptions = {}, appOptions = {} } = {}) {
  const securityEnv = appOptions.env || process.env
  const security = createDashboardSecurity(securityEnv)
  return http.createServer((req, res) => {
    ;(async () => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
      const allowedHostsConfigured = commaList(securityEnv.CROWN_DASHBOARD_ALLOWED_HOSTS).length > 0
      const allowedOriginsConfigured = commaList(securityEnv.CROWN_DASHBOARD_ALLOWED_ORIGINS).length > 0
      if (!allowedHostsConfigured && !allowedOriginsConfigured && !isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'remote-not-allowed' })
        return
      }
      if (!hostAllowed(req.headers.host, securityEnv.CROWN_DASHBOARD_ALLOWED_HOSTS)) {
        sendJson(res, 403, { error: 'host-not-allowed' })
        return
      }
      const origin = req.headers.origin
      if (origin && !originAllowed(origin, securityEnv.CROWN_DASHBOARD_ALLOWED_ORIGINS, req.headers.host)) {
        sendJson(res, 403, { error: 'origin-not-allowed' })
        return
      }
      if (requestUrl.pathname.startsWith('/api/')) {
        if (requestUrl.pathname === '/api/app/session') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!origin) {
            sendJson(res, 403, { error: 'origin-required' })
            return
          }
          let body
          try {
            body = await readSessionBody(req)
          } catch (error) {
            sendJson(res, error.message === 'payload-too-large' ? 413 : 400, { error: error.message })
            return
          }
          const result = await security.authenticate(body.password, req.socket.remoteAddress)
          if (!result.configured) {
            sendJson(res, 503, { error: 'dashboard-security-not-configured' })
            return
          }
          if (!result.authenticated) {
            if (result.rateLimited) {
              send(res, 429, JSON.stringify({ error: 'login-rate-limited' }), {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(result.retryAfterSeconds),
              })
              return
            }
            sendJson(res, 401, { error: 'invalid-credentials' })
            return
          }
          const secure = requestIsHttps(req) ? '; Secure' : ''
          send(res, 200, JSON.stringify({ authenticated: true }), {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': `${SESSION_COOKIE}=${result.cookie}; HttpOnly; SameSite=Strict; Path=/${secure}`,
          })
          return
        }

        const session = security.sessionFor(req)
        const localTrust = session ? null : security.localTrustFor(req, {
          remoteConfigurationPresent: allowedHostsConfigured || allowedOriginsConfigured,
        })
        const requestAccess = session
          ? { csrfToken: session.csrfToken, accessMode: 'password-session' }
          : (localTrust || { csrfToken: null, accessMode: 'readonly' })
        if (isMutating(req.method)) {
          if (!origin) {
            sendJson(res, 403, { error: 'origin-required' })
            return
          }
          if (!requestAccess.csrfToken) {
            sendJson(res, 401, { error: 'authentication-required' })
            return
          }
          if (!safeEqual(req.headers['x-csrf-token'], requestAccess.csrfToken)) {
            sendJson(res, 403, { error: 'csrf-invalid' })
            return
          }
        }
        const handled = await serveApi(req, requestUrl, res, {
          dataOptions,
          appOptions,
          csrfToken: requestAccess.csrfToken,
          dashboardAccessMode: requestAccess.accessMode,
        })
        if (!handled) sendJson(res, 404, { error: 'not-found' })
        return
      }
      await serveStatic(requestUrl.pathname, res, staticDir)
    })().catch(() => {
      sendJson(res, 500, { error: 'server-error' })
    })
  })
}

export async function startDashboardServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  staticDir = DEFAULT_STATIC_DIR,
  dataOptions = {},
  appOptions = {},
} = {}) {
  const server = createDashboardServer({ staticDir, dataOptions, appOptions })
  await new Promise((resolve) => server.listen(port, host, resolve))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startDashboardServer()
  const address = server.address()
  console.log(`Crown dashboard listening on http://${address.address}:${address.port}`)
}
