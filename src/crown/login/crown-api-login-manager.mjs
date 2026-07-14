import fs from 'node:fs'
import path from 'node:path'

import { classifyCrownTransformText } from '../crown-transform-xml.mjs'
import { saveLoginDiagnostics } from './crown-login-diagnostics.mjs'
import { normalizePublicHttpsExactOrigin } from './crown-origin.mjs'

function nowIso() {
  return new Date().toISOString()
}

function exactIntegerCny(value) {
  const match = /^(0|[1-9]\d*)(?:\.0+)?$/.exec(String(value || '').trim())
  if (!match) return null
  const integer = BigInt(match[1])
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : null
}

function accountId(account = {}) {
  return account.accountId || account.id || 'mon_primary'
}

function parseBettingOrigin(value, { allowlist = false } = {}) {
  try {
    return normalizePublicHttpsExactOrigin(value)
  } catch (error) {
    if (allowlist) throw new CrownApiLoginError('failed_config', 'betting-origin-allowlist-invalid')
    const messages = {
      'crown-origin-credentials-forbidden': 'betting-origin-credentials-forbidden',
      'crown-origin-https-required': 'betting-origin-https-required',
      'crown-origin-exact-required': 'betting-origin-exact-required',
      'crown-origin-public-host-required': 'betting-origin-private-forbidden',
      'crown-origin-ip-forbidden': 'betting-origin-private-forbidden',
    }
    throw new CrownApiLoginError(
      'failed_config',
      messages[String(error?.message || '')] || 'betting-origin-invalid',
    )
  }
}

function bettingOriginAllowlist(value) {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean)
  return new Set(entries.map((entry) => parseBettingOrigin(entry, { allowlist: true })))
}

function bettingAccount(account, allowedOriginValue, { allowConfiguredOrigin = false } = {}) {
  const value = String(account?.accountId || account?.id || '').trim()
  if (!value) throw new CrownApiLoginError('failed_config', 'betting-account-id-required')
  if (value === 'mon_primary') throw new CrownApiLoginError('failed_config', 'betting-account-monitor-forbidden')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new CrownApiLoginError('failed_config', 'betting-account-id-invalid')
  }
  const username = String(account?.username || '').trim()
  if (!username) throw new CrownApiLoginError('failed_config', 'betting-account-username-required')
  const allowedOrigins = bettingOriginAllowlist(allowedOriginValue)
  const loginUrl = parseBettingOrigin(account?.loginUrl || account?.websiteUrl)
  if (!allowedOrigins.has(loginUrl) && !(allowConfiguredOrigin && allowedOrigins.size === 0)) {
    throw new CrownApiLoginError('failed_config', 'betting-origin-not-allowed')
  }
  return { ...account, id: value, accountId: value, username, loginUrl }
}

function message(error) {
  return String(error?.message || error || '')
}

function baseResult(account, startedAt) {
  return {
    ok: false,
    accountId: accountId(account),
    status: '未启动',
    loginMethod: '',
    cookieStatus: '不存在',
    storageStateStatus: '不适用',
    xmlVerified: false,
    sessionVerified: false,
    diagnosticPath: '',
    debugSnapshot: null,
    startedAt,
    finishedAt: '',
    message: '',
  }
}

function finish(result, patch = {}) {
  return {
    ...result,
    ...patch,
    finishedAt: patch.finishedAt || nowIso(),
  }
}

function log(logger, type, payload = {}) {
  if (typeof logger === 'function') logger({ type, at: nowIso(), ...payload })
  else if (typeof logger?.log === 'function') logger.log({ type, at: nowIso(), ...payload })
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJsonFile(file, value) {
  ensureParent(file)
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function normalizeCrownBaseUrl(value) {
  try {
    return normalizePublicHttpsExactOrigin(value)
  } catch (error) {
    throw new CrownApiLoginError('failed_config', String(error?.message || 'crown-origin-invalid'))
  }
}

function xmlTag(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'))
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')).trim() : ''
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function parseCrownApiLoginResponse(xmlText) {
  return {
    status: xmlTag(xmlText, 'status'),
    uid: xmlTag(xmlText, 'uid') || null,
    messageCode: xmlTag(xmlText, 'msg') || null,
    message: xmlTag(xmlText, 'code_message') || null,
    balance: xmlTag(xmlText, 'balance') || xmlTag(xmlText, 'credit') || xmlTag(xmlText, 'money') || null,
    protocolVersion: xmlTag(xmlText, 'ver') || null,
  }
}

export function parseCrownAccountSummaryResponse(xmlText) {
  const code = xmlTag(xmlText, 'code')
  const enabled = xmlTag(xmlText, 'enable')
  const maxcredit = xmlTag(xmlText, 'maxcredit')
  const rawCurrency = xmlTag(xmlText, 'currency').toUpperCase()
  const reportedBalance = /^\d+(?:\.\d+)?$/.test(maxcredit) ? maxcredit : null
  const reportedCurrency = rawCurrency === 'RMB' ? 'CNY' : (/^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : '')
  return {
    valid: code === 'get_all_data' && enabled === 'Y',
    reportedBalance,
    reportedCurrency,
  }
}

export function parseCrownApiSessionFailure(xmlText) {
  const text = String(xmlText || '')
  if (/<!doctype\s+html|<html\b|login_index|sign\s*in/i.test(text) && !/<serverresponse\b/i.test(text)) return 'login_page'
  const status = xmlTag(text, 'status')
  const code = xmlTag(text, 'code')
  const result = status || code
  if (!result || result === '200' || /^success$/i.test(result)) return ''
  return [xmlTag(text, 'msg'), xmlTag(text, 'code_message')].filter(Boolean).join(': ') || result
}

function parseCrownApiGameMoreFailure(xmlText) {
  const code = xmlTag(xmlText, 'code')
  if (code === '617' || code === '637') return ''
  return parseCrownApiSessionFailure(xmlText)
}

function setCookieHeaders(headers) {
  if (!headers) return []
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = typeof headers.get === 'function' ? headers.get('set-cookie') : ''
  if (!combined) return []
  return String(combined).split(/,\s*(?=[^;,]+=)/).filter(Boolean)
}

function applySetCookies(headers, cookies) {
  for (const header of setCookieHeaders(headers)) {
    const pair = String(header || '').split(';')[0]
    const name = pair.substring(0, pair.indexOf('=')).trim()
    const value = pair.substring(pair.indexOf('=') + 1)
    if (name) cookies[name] = value
  }
}

function cookieHeader(cookies = {}) {
  return Object.entries(cookies)
    .filter(([name]) => String(name || '').trim())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

const REQUEST_SCOPE_FIELDS = {
  get_game_list: ['p3type', 'date', 'gtype', 'showtype', 'rtype', 'ltype', 'filter', 'cupFantasy', 'sorttype', 'specialClick', 'isFantasy'],
  get_game_more: ['gtype', 'showtype', 'ltype', 'isRB', 'lid', 'specialClick', 'mode', 'from', 'filter', 'ecid'],
}

export function crownRequestScopeFromForm(form = {}) {
  const endpointKind = String(form.p || '').trim()
  const scope = { endpointKind }
  for (const key of REQUEST_SCOPE_FIELDS[endpointKind] || []) {
    if (Object.hasOwn(form, key)) scope[key] = String(form[key] ?? '')
  }
  return scope
}

async function decodeResponseText(response) {
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

export class CrownApiLoginError extends Error {
  constructor(code, errorMessage, details = {}) {
    super(errorMessage)
    this.code = code
    this.details = details
  }
}

const FENCE_ERRORS = new WeakSet()

async function assertFenceNow(assertFence) {
  if (assertFence === undefined || assertFence === null) return
  if (typeof assertFence !== 'function') {
    throw new CrownApiLoginError('failed_config', 'betting-fence-invalid')
  }
  try {
    await assertFence()
  } catch (error) {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') FENCE_ERRORS.add(error)
    throw error
  }
}

async function networkWithFence(operation, assertFence) {
  try {
    const result = await operation()
    await assertFenceNow(assertFence)
    return result
  } catch (error) {
    if (FENCE_ERRORS.has(error)) throw error
    await assertFenceNow(assertFence)
    throw error
  }
}

function sanitizedBettingError(error) {
  if (((typeof error === 'object' && error !== null) || typeof error === 'function') && FENCE_ERRORS.has(error)) return error
  if (!(error instanceof CrownApiLoginError)) return error
  const stableConfigMessage = error.code === 'failed_config'
    && /^betting-[a-z0-9-]+$/.test(String(error.message || ''))
  const messages = {
    failed_config: 'betting-session-config-failed',
    failed_login: 'betting-session-login-failed',
    failed_http: 'betting-session-http-failed',
    failed_network: 'betting-session-network-failed',
    failed_xml: 'betting-session-xml-failed',
  }
  return new CrownApiLoginError(
    error.code,
    stableConfigMessage ? error.message : (messages[error.code] || 'betting-session-failed'),
  )
}

export class CrownApiSessionStore {
  constructor({ accountId: id = 'mon_primary', runtimeDir = 'data/runtime', strictOwner = false } = {}) {
    this.accountId = id
    this.runtimeDir = runtimeDir
    this.strictOwner = strictOwner
  }

  sessionDir() {
    return path.join(this.runtimeDir, 'crown-sessions', this.accountId)
  }

  sessionPath() {
    return path.join(this.sessionDir(), 'api-session.json')
  }

  readSession(account = {}) {
    const file = this.sessionPath()
    if (!fs.existsSync(file)) return { status: '不存在', session: null, path: file }
    try {
      const session = readJsonFile(file)
      const baseUrl = normalizeCrownBaseUrl(account.loginUrl)
      const username = String(account.username || '').trim()
      const ownerMatches = !this.strictOwner || session.accountId === this.accountId
      if (!session?.uid || !ownerMatches || session.username !== username || session.baseUrl !== baseUrl) {
        return { status: '不匹配', session: null, path: file }
      }
      return { status: '已加载', session, path: file }
    } catch (error) {
      return { status: '加载失败', session: null, path: file, message: message(error) }
    }
  }

  saveSession(account = {}, session = {}) {
    if (this.strictOwner && session.accountId !== this.accountId) {
      throw new CrownApiLoginError('failed_config', 'betting-session-owner-mismatch')
    }
    const normalized = {
      uid: String(session.uid || ''),
      cookies: session.cookies && typeof session.cookies === 'object' ? session.cookies : {},
      accountId: this.accountId,
      username: String(account.username || session.username || '').trim(),
      baseUrl: normalizeCrownBaseUrl(account.loginUrl || session.baseUrl),
      savedAt: Number(session.savedAt || Date.now()),
    }
    writeJsonFile(this.sessionPath(), normalized)
    return { status: '已保存', session: normalized, path: this.sessionPath() }
  }

  assertOwner(account = {}, session = {}) {
    if (!this.strictOwner) return session
    const expectedUsername = String(account.username || '').trim()
    const expectedBaseUrl = normalizeCrownBaseUrl(account.loginUrl)
    if (
      session.accountId !== this.accountId
      || session.username !== expectedUsername
      || normalizeCrownBaseUrl(session.baseUrl) !== expectedBaseUrl
      || !String(session.uid || '').trim()
    ) {
      throw new CrownApiLoginError('failed_config', 'betting-session-owner-mismatch')
    }
    return session
  }

  invalidate() {
    fs.rmSync(this.sessionPath(), { force: true })
  }
}

export class CrownApiClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl
  }

  async postForm({ baseUrl, endpointPath, form, cookies = {}, signal }) {
    if (typeof this.fetchImpl !== 'function') throw new CrownApiLoginError('failed_config', 'fetch is unavailable')
    const url = `${baseUrl.replace(/\/$/, '')}${endpointPath}`
    const headers = {
      accept: 'application/xml,text/xml,*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'user-agent': 'Mozilla/5.0',
    }
    const currentCookieHeader = cookieHeader(cookies)
    if (currentCookieHeader) headers.cookie = currentCookieHeader
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal,
    })
    if (response.status >= 300 && response.status < 400) {
      throw new CrownApiLoginError('failed_http', 'crown redirect blocked', { status: response.status })
    }
    applySetCookies(response.headers, cookies)
    const text = await decodeResponseText(response)
    if (!response.ok) throw new CrownApiLoginError('failed_http', `crown http ${response.status}`, { status: response.status, text })
    return { text, cookies }
  }

  async login(account = {}) {
    const username = String(account.username || '').trim()
    const password = String(account.password || '').trim()
    if (!username) throw new CrownApiLoginError('failed_config', 'crown username is empty')
    if (!password) throw new CrownApiLoginError('failed_config', 'crown password is empty')
    const baseUrl = normalizeCrownBaseUrl(account.loginUrl)
    const cookies = {}
    const { text } = await this.postForm({
      baseUrl,
      endpointPath: '/transform_nl.php',
      form: {
        p: 'chk_login',
        langx: 'zh-cn',
        username,
        password,
        app: 'N',
        auto: 'CDBHGD',
        blackbox: '',
      },
      cookies,
    })
    const login = parseCrownApiLoginResponse(text)
    if (login.status !== '200' || !login.uid) {
      const details = [login.messageCode, login.message].filter(Boolean).join(': ')
      throw new CrownApiLoginError('failed_login', details || `crown login failed with status ${login.status || 'unknown'}`, { login, text })
    }
    const protocolVersion = String(login.protocolVersion || '').trim()
    return {
      login,
      session: {
        uid: login.uid,
        cookies: { ...cookies },
        accountId: account.accountId || account.id || 'mon_primary',
        username,
        baseUrl,
        savedAt: Date.now(),
        ...(protocolVersion ? {
          protocolVersion,
          protocolVersionEvidence: {
            source: 'production-login-response',
            captured: true,
            verified: true,
          },
        } : {}),
      },
    }
  }

  async fetchGameList(session = {}, { signal } = {}) {
    const cookies = { ...(session.cookies || {}) }
    const form = {
      uid: session.uid,
      langx: 'zh-cn',
      p: 'get_game_list',
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
    }
    const { text } = await this.postForm({
      baseUrl: normalizeCrownBaseUrl(session.baseUrl),
      endpointPath: '/transform.php',
      form,
      cookies,
      signal,
    })
    const failure = parseCrownApiSessionFailure(text)
    if (failure) throw new CrownApiLoginError('failed_login', `crown session expired: ${failure}`, { text, failure })
    return {
      text,
      classification: classifyCrownTransformText(text),
      requestScope: crownRequestScopeFromForm(form),
      session: {
        ...session,
        cookies,
        savedAt: Date.now(),
      },
    }
  }

  async fetchAccountSummary(session = {}) {
    const cookies = { ...(session.cookies || {}) }
    const form = {
      uid: session.uid,
      p: 'get_member_data',
      langx: 'zh-cn',
      change: 'all',
    }
    const { text } = await this.postForm({
      baseUrl: normalizeCrownBaseUrl(session.baseUrl),
      endpointPath: '/transform.php',
      form,
      cookies,
    })
    const summary = parseCrownAccountSummaryResponse(text)
    if (!summary.valid) {
      const failure = parseCrownApiSessionFailure(text)
      if (failure) throw new CrownApiLoginError('failed_login', `crown session expired: ${failure}`)
      throw new CrownApiLoginError('failed_xml', 'crown account summary is invalid')
    }
    return {
      summary,
      session: { ...session, cookies, savedAt: Date.now() },
    }
  }

  async fetchGameMore(session = {}, target = {}) {
    const lid = String(target.lid || '').trim()
    const ecid = String(target.ecid || '').trim()
    if (!lid || !ecid) {
      throw new CrownApiLoginError('failed_config', 'crown get_game_more requires lid and ecid')
    }

    const mode = String(target.mode || '').toLowerCase()
    const live = target.isRB === 'Y' || target.showtype === 'live' || mode === 'live'
    const cookies = { ...(session.cookies || {}) }
    const form = {
      uid: session.uid,
      langx: 'zh-cn',
      p: 'get_game_more',
      gtype: 'ft',
      showtype: live ? 'live' : 'today',
      ltype: '3',
      isRB: live ? 'Y' : 'N',
      lid,
      specialClick: '',
      mode: 'CUP',
      from: 'game_more',
      filter: 'Main',
      ts: String(target.ts || Date.now()),
      ecid,
    }
    const { text } = await this.postForm({
      baseUrl: normalizeCrownBaseUrl(session.baseUrl),
      endpointPath: '/transform.php',
      form,
      cookies,
    })
    const failure = parseCrownApiGameMoreFailure(text)
    if (failure) throw new CrownApiLoginError('failed_login', `crown session expired: ${failure}`, { text, failure })
    return {
      text,
      classification: classifyCrownTransformText(text),
      requestScope: crownRequestScopeFromForm(form),
      session: {
        ...session,
        cookies,
        savedAt: Date.now(),
      },
    }
  }
}

function statusForError(error) {
  if (error?.code === 'failed_config') return '配置错误'
  if (error?.code === 'failed_http' || error?.code === 'failed_network') return '网络异常'
  if (error?.code === 'failed_xml') return 'XML 无响应'
  return '登录失效'
}

export class CrownApiLoginManager {
  constructor({
    runtimeDir = 'data/runtime',
    fetchImpl = globalThis.fetch,
    bettingAllowedOrigins = process.env.CROWN_BETTING_ALLOWED_ORIGINS || '',
    now = () => new Date(),
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('crown-api-now')
    this.runtimeDir = runtimeDir
    this.client = new CrownApiClient({ fetchImpl })
    this.bettingAllowedOrigins = String(bettingAllowedOrigins || '')
    this.now = now
    this.verifiedBettingProtocols = new Map()
  }

  storeFor(account) {
    return new CrownApiSessionStore({ accountId: accountId(account), runtimeDir: this.runtimeDir })
  }

  bettingStoreFor(account) {
    return new CrownApiSessionStore({ accountId: account.accountId, runtimeDir: this.runtimeDir, strictOwner: true })
  }

  _rememberVerifiedBettingProtocol(account, session) {
    if (
      !session
      || session.accountId !== account.accountId
      || session.username !== account.username
      || normalizeCrownBaseUrl(session.baseUrl) !== normalizeCrownBaseUrl(account.loginUrl)
      || !String(session.uid || '').trim()
      || !String(session.protocolVersion || '').trim()
      || session.protocolVersionEvidence?.captured !== true
      || session.protocolVersionEvidence?.verified !== true
      || session.protocolVersionEvidence?.source !== 'production-login-response'
    ) return
    this.verifiedBettingProtocols.set(account.accountId, Object.freeze({
      accountId: account.accountId,
      username: account.username,
      baseUrl: normalizeCrownBaseUrl(account.loginUrl),
      uid: String(session.uid),
      protocolVersion: String(session.protocolVersion).trim(),
      protocolVersionEvidence: Object.freeze({
        source: 'production-login-response',
        captured: true,
        verified: true,
      }),
    }))
  }

  verifiedBettingSessionFor({ account, session } = {}) {
    const exactAccount = bettingAccount(account, this.bettingAllowedOrigins)
    const trusted = this.verifiedBettingProtocols.get(exactAccount.accountId)
    if (
      !trusted
      || !session
      || session.accountId !== trusted.accountId
      || session.username !== trusted.username
      || normalizeCrownBaseUrl(session.baseUrl) !== trusted.baseUrl
      || String(session.uid || '') !== trusted.uid
    ) return null
    return {
      ...session,
      protocolVersion: trusted.protocolVersion,
      protocolVersionEvidence: trusted.protocolVersionEvidence,
    }
  }

  async _ensureSession({
    account, logger, store, assertFence = null, requireVerifiedProtocolVersion = false,
  }) {
    await assertFenceNow(assertFence)
    log(logger, 'api-session-load-start', { accountId: accountId(account) })
    const cached = store.readSession(account)
    if (cached.session && store.strictOwner && requireVerifiedProtocolVersion) {
      await assertFenceNow(assertFence)
      store.invalidate()
      log(logger, 'betting-protocol-version-refresh-required', { accountId: accountId(account) })
    } else if (cached.session) {
      try {
        const verified = await networkWithFence(() => this.client.fetchGameList(cached.session), assertFence)
        await assertFenceNow(assertFence)
        const saved = store.saveSession(account, verified.session)
        log(logger, 'api-session-valid', { accountId: accountId(account) })
        return {
          ...verified,
          loginMethod: '接口缓存',
          cookieStatus: cached.status,
          savedStatus: saved.status,
        }
      } catch (error) {
        if (error?.code !== 'failed_login') throw error
        await assertFenceNow(assertFence)
        store.invalidate()
        log(logger, 'api-session-expired', { accountId: accountId(account), errorCode: 'failed_login' })
      }
    }

    log(logger, 'api-login-start', { accountId: accountId(account) })
    const fresh = await networkWithFence(() => this.client.login(account), assertFence)
    const verified = await networkWithFence(() => this.client.fetchGameList(fresh.session), assertFence)
    await assertFenceNow(assertFence)
    if (store.strictOwner && requireVerifiedProtocolVersion) {
      this._rememberVerifiedBettingProtocol(account, verified.session)
    }
    const saved = store.saveSession(account, verified.session)
    log(logger, 'api-login-success', { accountId: accountId(account) })
    return {
      ...verified,
      login: fresh.login,
      loginMethod: '接口登录',
      cookieStatus: saved.status,
      savedStatus: saved.status,
    }
  }

  async ensureSession({ account, logger } = {}) {
    return this._ensureSession({ account, logger, store: this.storeFor(account) })
  }

  async ensureBettingSession({
    account, logger, assertFence = null, requireVerifiedProtocolVersion = false,
  } = {}) {
    const exactAccount = bettingAccount(account, this.bettingAllowedOrigins)
    try {
      return await this._ensureSession({
        account: exactAccount,
        logger,
        store: this.bettingStoreFor(exactAccount),
        assertFence,
        requireVerifiedProtocolVersion,
      })
    } catch (error) {
      throw sanitizedBettingError(error)
    }
  }

  async fetchBettingFootballToday({ account, logger, assertFence = null } = {}) {
    return this.ensureBettingSession({ account, logger, assertFence })
  }

  async fetchFreshExecutionBalance({
    account, session = null, logger, assertFence = null, requireVerifiedProtocolVersion = false,
  } = {}) {
    const exactAccount = bettingAccount(account, this.bettingAllowedOrigins)
    try {
      const store = this.bettingStoreFor(exactAccount)
      const authenticated = session
        ? { session: store.assertOwner(exactAccount, session) }
        : await this._ensureSession({
            account: exactAccount,
            logger,
            store,
            assertFence,
            requireVerifiedProtocolVersion,
          })
      const accountSummary = await networkWithFence(
        () => this.client.fetchAccountSummary(authenticated.session),
        assertFence,
      )
      await assertFenceNow(assertFence)
      if (requireVerifiedProtocolVersion) {
        this._rememberVerifiedBettingProtocol(exactAccount, accountSummary.session)
      }
      const balanceCny = exactIntegerCny(accountSummary.summary?.reportedBalance)
      if (
        accountSummary.summary?.valid !== true
        || accountSummary.summary?.reportedCurrency !== 'CNY'
        || String(exactAccount.currency || 'CNY').trim().toUpperCase() !== 'CNY'
        || balanceCny === null
      ) {
        const error = new Error('betting-execution-balance-unavailable')
        error.code = 'balance-unavailable'
        throw error
      }
      store.saveSession(exactAccount, accountSummary.session)
      const observed = this.now()
      const observedAt = observed instanceof Date ? observed.toISOString() : new Date(observed).toISOString()
      const result = {
        balanceCny,
        currency: 'CNY',
        observedAt,
        source: 'get_member_data',
      }
      Object.defineProperty(result, 'session', {
        value: accountSummary.session,
        enumerable: false,
        configurable: false,
        writable: false,
      })
      log(logger, 'betting-execution-balance-refreshed', {
        accountId: exactAccount.accountId,
        currency: 'CNY',
      })
      return Object.freeze(result)
    } catch (error) {
      throw sanitizedBettingError(error)
    }
  }

  async testBettingAccountAccess({ account, logger } = {}) {
    try {
      const exactAccount = bettingAccount(account, this.bettingAllowedOrigins, { allowConfiguredOrigin: true })
      const fresh = await this.client.login(exactAccount)
      const verified = await this.client.fetchGameList(fresh.session)
      if (!verified.classification?.hasServerResponse
        || verified.classification?.loginExpired
        || verified.classification?.parseError) {
        throw new CrownApiLoginError('failed_xml', 'crown football access verification failed')
      }
      const accountSummary = await this.client.fetchAccountSummary(verified.session)
      this.bettingStoreFor(exactAccount).saveSession(exactAccount, accountSummary.session)
      const reportedBalance = accountSummary.summary.reportedBalance || fresh.login.balance || null
      const reportedCurrency = accountSummary.summary.reportedCurrency
        || String(exactAccount.currency || '').trim().toUpperCase()
      const expectedCurrency = String(exactAccount.currency || 'CNY').trim().toUpperCase()
      const usableBalance = /^\d+(?:\.\d+)?$/.test(String(reportedBalance || ''))
        && Number.isFinite(Number(reportedBalance)) && Number(reportedBalance) >= 0
        && reportedCurrency === expectedCurrency
      if (!usableBalance) {
        return {
          ok: false, status: 'failed', errorCode: 'balance-unavailable',
          reportedBalance: null, reportedCurrency: '', balanceSource: 'none',
        }
      }
      log(logger, 'betting-account-access-verified', { accountId: exactAccount.accountId })
      return {
        ok: true,
        status: 'available',
        errorCode: '',
        reportedBalance,
        reportedCurrency,
        balanceSource: accountSummary.summary.reportedBalance ? 'account-summary' : (fresh.login.balance ? 'login' : 'none'),
      }
    } catch (error) {
      const safe = sanitizedBettingError(error)
      const messageText = String(safe?.message || '')
      let errorCode = 'access-failed'
      if (messageText === 'betting-origin-not-allowed') errorCode = 'origin-not-allowed'
      else if (safe?.code === 'failed_login') errorCode = 'login-failed'
      else if (safe?.code === 'failed_http' || safe?.code === 'failed_network') errorCode = 'network-failed'
      else if (safe?.code === 'failed_xml') errorCode = 'access-invalid'
      else if (safe?.code === 'failed_config') errorCode = 'configuration-failed'
      return {
        ok: false,
        status: 'failed',
        errorCode,
        reportedBalance: null,
        reportedCurrency: '',
        balanceSource: 'none',
      }
    }
  }

  async fetchBettingFootballGameMore({ account, session = null, target, logger, assertFence = null } = {}) {
    const exactAccount = bettingAccount(account, this.bettingAllowedOrigins)
    try {
      await assertFenceNow(assertFence)
      const store = this.bettingStoreFor(exactAccount)
      const current = session
        ? { session: store.assertOwner(exactAccount, session) }
        : await this._ensureSession({ account: exactAccount, logger, store, assertFence })
      const result = await networkWithFence(
        () => this.client.fetchGameMore(current.session, target),
        assertFence,
      )
      await assertFenceNow(assertFence)
      const saved = store.saveSession(exactAccount, result.session)
      return { ...result, session: saved.session }
    } catch (error) {
      throw sanitizedBettingError(error)
    }
  }

  async fetchFootballToday({ account, logger } = {}) {
    return this.ensureSession({ account, logger })
  }

  async fetchFootballGameMore({ account, session = null, target, logger } = {}) {
    const current = session ? { session } : await this.ensureSession({ account, logger })
    const result = await this.client.fetchGameMore(current.session, target)
    if (account) this.storeFor(account).saveSession(account, result.session)
    return result
  }

  async failWithDiagnostics(result, { account, error, logger } = {}) {
    const diagnostic = await saveLoginDiagnostics({
      page: null,
      account,
      classifiedState: statusForError(error),
      error,
      runtimeDir: this.runtimeDir,
      extraDebug: {
        apiLogin: true,
        login: error?.details?.login || null,
        responseText: error?.details?.text || '',
        failure: error?.details?.failure || '',
      },
    })
    log(logger, 'api-login-diagnostics-saved', { accountId: accountId(account), diagnosticPath: diagnostic.diagnosticPath })
    return finish(result, {
      ok: false,
      status: statusForError(error),
      diagnosticPath: diagnostic.diagnosticPath,
      debugSnapshot: diagnostic.snapshot,
      message: message(error),
    })
  }

  async ensureLogin({ account, logger } = {}) {
    const startedAt = nowIso()
    const result = baseResult(account, startedAt)
    try {
      const verified = await this.ensureSession({ account, logger })
      const xmlVerified = Boolean(verified.classification?.hasServerResponse && !verified.classification?.loginExpired && !verified.classification?.parseError)
      if (!xmlVerified) throw new CrownApiLoginError('failed_xml', 'crown XML verification failed', { classification: verified.classification, text: verified.text })
      log(logger, 'api-session-verified', { accountId: accountId(account), xmlVerified })
      return finish(result, {
        ok: true,
        status: '已登录',
        loginMethod: verified.loginMethod,
        cookieStatus: verified.loginMethod === '接口缓存' ? '已加载' : verified.cookieStatus,
        storageStateStatus: '不适用',
        xmlVerified,
        sessionVerified: true,
        requestScope: verified.requestScope,
        message: '',
      })
    } catch (error) {
      return this.failWithDiagnostics(result, { account, error, logger })
    }
  }
}

export default CrownApiLoginManager
