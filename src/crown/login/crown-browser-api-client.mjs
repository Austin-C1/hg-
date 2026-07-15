import { createHash } from 'node:crypto'

import { classifyCrownTransformText } from '../crown-transform-xml.mjs'
import {
  crownRequestScopeFromForm,
  parseCrownAccountSummaryResponse,
  parseCrownApiLoginResponse,
  parseCrownApiSessionFailure,
} from './crown-api-login-manager.mjs'
import { normalizePublicHttpsExactOrigin } from './crown-origin.mjs'

const OPERATIONS = Object.freeze({
  login: Object.freeze({ path: '/transform_nl.php', p: 'chk_login' }),
  gameList: Object.freeze({ path: '/transform.php', p: 'get_game_list' }),
  accountSummary: Object.freeze({ path: '/transform.php', p: 'get_member_data' }),
  preview: Object.freeze({ path: '/transform.php', p: 'FT_order_view' }),
  submit: Object.freeze({ path: '/transform.php', p: 'FT_bet' }),
  result: Object.freeze({ path: '/transform.php', p: 'get_today_wagers' }),
})

const RESERVED_TRANSPORT_FIELDS = new Set(['endpoint', 'endpointPath', 'method', 'path', 'url'])

export class CrownBrowserApiError extends Error {
  constructor(code) {
    super(code)
    this.name = 'CrownBrowserApiError'
    this.code = code
  }
}

function fail(code) {
  throw new CrownBrowserApiError(code)
}

function requiredText(value, code) {
  const text = String(value ?? '').trim()
  if (!text) fail(code)
  return text
}

function normalizedWireFields(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`browser-${operation}-wire-invalid`)
  }
  const result = Object.create(null)
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!key || RESERVED_TRANSPORT_FIELDS.has(key)) fail(`browser-${operation}-endpoint-not-allowed`)
    if (fieldValue === null || fieldValue === undefined || typeof fieldValue === 'object') {
      fail(`browser-${operation}-wire-invalid`)
    }
    result[key] = String(fieldValue)
  }
  return result
}

function assertNotAborted(signal, operation) {
  if (signal?.aborted) fail(`browser-${operation}-aborted`)
}

function accountId(account) {
  return requiredText(account?.accountId || account?.id, 'browser-login-account-required')
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

export class CrownBrowserApiClient {
  constructor({ page, origin, requestTimeoutMs = 30_000 } = {}) {
    this.origin = normalizePublicHttpsExactOrigin(origin)
    if (!page || typeof page.evaluate !== 'function' || typeof page.url !== 'function') {
      fail('browser-page-required')
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
      fail('browser-request-timeout-invalid')
    }
    this.page = page
    this.requestTimeoutMs = requestTimeoutMs
    this.poisoned = false
    this._installGuards()
  }

  async login({ account, signal } = {}) {
    const username = requiredText(account?.username, 'browser-login-username-required')
    const password = requiredText(account?.password, 'browser-login-password-required')
    this._assertAccountOrigin(account)
    const response = await this._post('login', {
      p: OPERATIONS.login.p,
      langx: 'zh-cn',
      username,
      password,
      app: 'N',
      auto: 'CDBHGD',
      blackbox: '',
    }, { signal })
    const login = parseCrownApiLoginResponse(response.text)
    if (login.status !== '200' || !login.uid) fail('browser-login-rejected')
    const protocolVersion = String(login.protocolVersion || response.protocolVersionMetadata || '').trim()
    const protocolVersionSource = login.protocolVersion
      ? 'production-login-response'
      : 'production-session-metadata'
    return {
      login,
      session: {
        accountId: accountId(account),
        username,
        origin: this.origin,
        baseUrl: this.origin,
        uid: login.uid,
        ...(protocolVersion ? {
          protocolVersion,
          protocolVersionEvidence: {
            source: protocolVersionSource,
            captured: true,
            verified: true,
          },
        } : {}),
      },
    }
  }

  async fetchGameList(session, { signal } = {}) {
    const form = {
      uid: this._sessionUid(session),
      langx: 'zh-cn',
      p: OPERATIONS.gameList.p,
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
    const response = await this._post('game-list', form, { signal, descriptor: OPERATIONS.gameList })
    const classification = classifyCrownTransformText(response.text)
    if (
      parseCrownApiSessionFailure(response.text)
      || classification.loginExpired === true
      || classification.hasServerResponse !== true
      || classification.parseError === true
    ) {
      fail('browser-game-list-session-invalid')
    }
    return {
      text: response.text,
      classification,
      requestScope: crownRequestScopeFromForm(form),
      session,
      transport: response.transport,
    }
  }

  async fetchAccountSummary(session, { signal } = {}) {
    const response = await this._post('account-summary', {
      uid: this._sessionUid(session),
      p: OPERATIONS.accountSummary.p,
      langx: 'zh-cn',
      change: 'all',
    }, { signal, descriptor: OPERATIONS.accountSummary })
    const summary = parseCrownAccountSummaryResponse(response.text)
    if (!summary.valid) fail('browser-account-summary-invalid')
    return { summary, session, transport: response.transport }
  }

  postPreview({ session, wireFields, signal } = {}) {
    return this._bettingPost('preview', OPERATIONS.preview, session, wireFields, signal)
  }

  async postSubmit({ session, wireFields, signal, beforeDispatch } = {}) {
    const fields = this._bettingFields('submit', OPERATIONS.submit, session, wireFields)
    this._assertUsable()
    assertNotAborted(signal, 'submit')
    this._assertPageOrigin()
    if (typeof beforeDispatch !== 'function') fail('browser-submit-before-dispatch-required')
    await beforeDispatch()
    return this._evaluatePost('submit', OPERATIONS.submit, fields, signal)
  }

  queryResult(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['session', 'signal'].includes(key))) {
      fail('browser-result-input-not-allowed')
    }
    const timestamp = String(Date.now())
    if (!/^\d{13}$/.test(timestamp)) fail('browser-result-timestamp-invalid')
    return this._post('result', {
      LS: 'g',
      chk_cw: 'N',
      db_slow: 'N',
      format: 'json',
      langx: 'zh-cn',
      p: OPERATIONS.result.p,
      selGtype: 'ALL',
      ts: timestamp,
      uid: this._sessionUid(input.session),
    }, { signal: input.signal, descriptor: OPERATIONS.result })
  }

  _assertAccountOrigin(account) {
    let origin
    try {
      origin = normalizePublicHttpsExactOrigin(account?.loginUrl || account?.origin)
    } catch {
      fail('browser-login-origin-invalid')
    }
    if (origin !== this.origin) fail('browser-login-origin-mismatch')
  }

  _assertUsable() {
    if (this.poisoned) fail('browser-page-security-violation')
  }

  _installGuards() {
    const poison = () => { this.poisoned = true }
    this.page.on?.('download', (download) => {
      poison()
      Promise.resolve().then(() => download?.cancel?.()).catch(() => {})
    })
    this.page.on?.('crash', poison)
    this.page.on?.('framenavigated', (frame) => {
      const mainFrame = this.page.mainFrame?.()
      if (mainFrame && frame !== mainFrame) return
      const value = typeof frame?.url === 'function' ? frame.url() : frame?.url
      if (value === 'about:blank') return
      try {
        if (new URL(String(value || '')).origin !== this.origin) poison()
      } catch {
        poison()
      }
    })

    const context = this.page.context?.()
    context?.on?.('page', (popup) => {
      if (popup === this.page) return
      poison()
      Promise.resolve().then(() => popup?.close?.()).catch(() => {})
    })
    context?.on?.('close', poison)
    context?.browser?.()?.on?.('disconnected', poison)
  }

  _assertSessionOrigin(session) {
    const values = [session?.origin, session?.baseUrl].filter((value) => value !== undefined)
    if (!values.length) fail('browser-session-origin-required')
    for (const value of values) {
      let origin
      try {
        origin = normalizePublicHttpsExactOrigin(value)
      } catch {
        fail('browser-session-origin-invalid')
      }
      if (origin !== this.origin) fail('browser-session-origin-mismatch')
    }
  }

  _assertPageOrigin() {
    let origin
    try {
      origin = new URL(String(this.page.url() || '')).origin
    } catch {
      fail('browser-page-origin-mismatch')
    }
    if (origin !== this.origin) fail('browser-page-origin-mismatch')
  }

  _sessionUid(session) {
    this._assertSessionOrigin(session)
    return requiredText(session?.uid, 'browser-session-uid-required')
  }

  _bettingFields(operation, descriptor, session, wireFields) {
    const fields = normalizedWireFields(wireFields, operation)
    if (fields.p !== descriptor.p) fail(`browser-${operation}-operation-not-allowed`)
    const uid = this._sessionUid(session)
    if (fields.uid !== undefined && fields.uid !== uid) fail(`browser-${operation}-session-mismatch`)
    fields.uid = uid
    return fields
  }

  async _bettingPost(operation, descriptor, session, wireFields, signal) {
    const fields = this._bettingFields(operation, descriptor, session, wireFields)
    return this._post(operation, fields, { signal, descriptor })
  }

  async _post(operation, fields, { signal, descriptor = OPERATIONS.login } = {}) {
    this._assertUsable()
    assertNotAborted(signal, operation)
    this._assertPageOrigin()
    return this._evaluatePost(operation, descriptor, fields, signal)
  }

  async _evaluatePost(operation, descriptor, fields, signal) {
    this._assertUsable()
    assertNotAborted(signal, operation)
    this._assertPageOrigin()
    let result
    try {
      result = await this.page.evaluate(async ({
        endpointPath, expectedOrigin, expectedUrl, formFields, timeoutMs,
      }) => {
        if (
          globalThis.location?.origin !== expectedOrigin
          || new URL(endpointPath, globalThis.document?.baseURI).href !== expectedUrl
        ) throw new Error('browser-page-origin-mismatch')
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)
        try {
          let protocolVersionMetadata = ''
          try {
            protocolVersionMetadata = typeof globalThis.top?.ver === 'string'
              ? globalThis.top.ver.trim()
              : ''
          } catch {}
          const response = await fetch(endpointPath, {
            method: 'POST',
            headers: {
              accept: 'application/xml,text/xml,*/*',
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
            body: new URLSearchParams(formFields),
            credentials: 'include',
            redirect: 'error',
            signal: controller.signal,
          })
          const safeResponse = response.redirected !== true && response.url === expectedUrl
          return {
            ok: response.ok,
            status: response.status,
            redirected: response.redirected,
            url: response.url,
            text: safeResponse ? await response.text() : null,
            protocolVersionMetadata,
          }
        } finally {
          clearTimeout(timeout)
        }
      }, {
        endpointPath: descriptor.path,
        expectedOrigin: this.origin,
        expectedUrl: `${this.origin}${descriptor.path}`,
        formFields: fields,
        timeoutMs: this.requestTimeoutMs,
      })
    } catch {
      fail(`browser-${operation}-network-failure`)
    }

    this._assertUsable()
    assertNotAborted(signal, operation)
    this._assertPageOrigin()
    let responseUrl
    try {
      responseUrl = new URL(String(result?.url || ''))
    } catch {
      fail(`browser-${operation}-response-invalid`)
    }
    if (result.redirected === true) fail(`browser-${operation}-redirect-blocked`)
    if (responseUrl.origin !== this.origin || responseUrl.pathname !== descriptor.path) {
      fail(`browser-${operation}-response-origin-mismatch`)
    }
    if (result.ok !== true || !Number.isSafeInteger(result.status) || result.status < 200 || result.status >= 300) {
      fail(`browser-${operation}-http-failure`)
    }
    if (typeof result.text !== 'string') fail(`browser-${operation}-response-invalid`)
    const protocolVersionMetadata = operation === 'login'
      && /^[A-Za-z0-9._-]{1,256}$/.test(String(result.protocolVersionMetadata || ''))
      ? String(result.protocolVersionMetadata)
      : null
    return {
      text: result.text,
      ...(protocolVersionMetadata ? { protocolVersionMetadata } : {}),
      transport: {
        operation: descriptor.p,
        endpointPath: descriptor.path,
        method: 'POST',
        status: result.status,
        requestFieldSet: Object.keys(fields).sort(),
        requestFieldSetFingerprint: sha256(JSON.stringify(Object.keys(fields).sort())),
        ...(operation === 'result' ? { requestTimestampDigest: sha256(fields.ts) } : {}),
      },
    }
  }
}
