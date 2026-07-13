import { CrownCookieStore } from './crown-cookie-store.mjs'
import { normalizePublicHttpsExactOrigin } from './crown-origin.mjs'
import { detectPageSession } from './crown-session-detector.mjs'
import { saveLoginDiagnostics } from './crown-login-diagnostics.mjs'

const USERNAME_SELECTORS = [
  '#usr',
  'input[id="usr"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="userid"]',
  'input[name="account"]',
  'input[name="login"]',
  'input[name="loginId"]',
  'input[id*="user" i]',
  'input[id*="usr" i]',
  'input[id*="account" i]',
  'input[type="text"]',
]

const PASSWORD_SELECTORS = [
  '#pwd',
  'input[id="pwd"]',
  'input[type="password"]',
  'input[name="password"]',
  'input[name="passwd"]',
  'input[name="pass"]',
  'input[id*="pass" i]',
]

const SUBMIT_SELECTORS = [
  '#btn_login',
  'button[type="submit"]',
  'input[type="submit"]',
  'input[type="button"][value*="登录"]',
  'input[type="button"][value*="登入"]',
  'input[type="button"][value*="Login"]',
  'button:has-text("登录")',
  'button:has-text("登入")',
  'button:has-text("Login")',
  'a:has-text("登录")',
  'a:has-text("Login")',
]

function nowIso() {
  return new Date().toISOString()
}

function accountId(account = {}) {
  return account.accountId || account.id || 'mon_primary'
}

function message(error) {
  return String(error?.message || error || '')
}

function loginError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function baseResult(account, startedAt) {
  return {
    ok: false,
    accountId: accountId(account),
    status: '未启动',
    loginMethod: '',
    cookieStatus: '不存在',
    storageStateStatus: '不存在',
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

function assertExactPageOrigin(page, origin, violated = false) {
  let currentOrigin = ''
  try { currentOrigin = new URL(String(page?.url?.() || '')).origin } catch {}
  if (violated || currentOrigin !== origin) throw loginError('crown-login-origin-violation')
}

async function installMainFrameOriginGuard({ context, page, origin }) {
  if (typeof context?.route !== 'function' || typeof context?.unroute !== 'function') {
    throw loginError('crown-login-origin-guard-unavailable')
  }
  let violated = false
  const pattern = '**/*'
  const handler = async (route) => {
    const request = route.request()
    const isMainFrameNavigation = request?.isNavigationRequest?.() === true
      && request?.frame?.() === page?.mainFrame?.()
    let allowed = true
    if (isMainFrameNavigation) {
      try { allowed = new URL(String(request.url())).origin === origin } catch { allowed = false }
    }
    if (!allowed) {
      violated = true
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  }
  await context.route(pattern, handler)
  return {
    assert() { assertExactPageOrigin(page, origin, violated) },
    async dispose() { await context.unroute(pattern, handler).catch(() => {}) },
  }
}

async function gotoLoginUrl(page, account, originGuard) {
  if (account?.loginUrl && typeof page?.goto === 'function') {
    await page.goto(account.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    originGuard.assert()
    await page.waitForSelector?.([
      '#pwd',
      'input[type="password"]',
      '#btn_login',
      'input[type="button"][value*="登入"]',
      'button:has-text("登录")',
      'button:has-text("Login")',
    ].join(','), { timeout: 20_000 }).catch(() => {})
  }
}

async function fillFirstVisible(page, selectors, value, assertOrigin = () => {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    assertOrigin()
    await locator.fill(value, { timeout: 5000 })
    return true
  }
  return false
}

async function clickFirstVisible(page, selectors, assertOrigin = () => {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    assertOrigin()
    await locator.click({ timeout: 5000 })
    return true
  }
  return false
}

async function submitLoginForm(page, assertOrigin) {
  if (await clickFirstVisible(page, SUBMIT_SELECTORS, assertOrigin)) return true
  assertOrigin()
  await page.keyboard?.press?.('Enter').catch(() => {})
  return true
}

async function dismissOptionalPostLoginPrompts(page, assertOrigin) {
  const clicked = await clickFirstVisible(page, [
    '#no_btn:visible',
    '#C_no_btn:visible',
    'button:has-text("否")',
    'div:has-text("否")',
  ], assertOrigin).catch((error) => {
    if (error?.code === 'crown-login-origin-violation') throw error
    return false
  })
  if (clicked) return true

  for (const selector of ['#C_no_btn', '#no_btn']) {
    const box = await page.locator?.(selector)?.boundingBox?.().catch(() => null)
    if (box?.width > 0 && box?.height > 0 && typeof page.mouse?.click === 'function') {
      assertOrigin()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      return true
    }
  }

  assertOrigin()
  return page.evaluate?.(() => {
    const candidates = Array.from(document.querySelectorAll('#no_btn,#C_no_btn,.btn_cancel'))
    const visible = candidates.find((element) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return Boolean(element.offsetParent) && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    })
    const target = visible || candidates.find((element) => String(element.textContent || '').trim() === '否')
    if (!target) return false
    target.click()
    return true
  }).catch(() => false)
}

async function runXmlVerification(verifyXml) {
  if (typeof verifyXml !== 'function') return { xmlVerified: false }
  const value = await verifyXml()
  if (typeof value === 'boolean') return { xmlVerified: value }
  if (value && typeof value === 'object') return { xmlVerified: Boolean(value.xmlVerified ?? value.ok), ...value }
  return { xmlVerified: false }
}

function exactOriginCookies(cookies, origin) {
  const hostname = new URL(origin).hostname.toLowerCase()
  return (Array.isArray(cookies) ? cookies : []).filter((cookie) => (
    String(cookie?.domain || '').toLowerCase().replace(/^\./, '') === hostname
  ))
}

export class CrownLoginManager {
  constructor({ runtimeDir = 'data/runtime' } = {}) {
    this.runtimeDir = runtimeDir
  }

  cookieStoreFor(account) {
    return new CrownCookieStore({ accountId: accountId(account), runtimeDir: this.runtimeDir })
  }

  async diagnostics(page, account, classifiedState, error, extraDebug = {}) {
    return saveLoginDiagnostics({
      page,
      account,
      classifiedState,
      error,
      runtimeDir: this.runtimeDir,
      extraDebug,
    })
  }

  async success(result, { account, context, store, loginMethod, verifyXml, logger }) {
    let xml
    try {
      xml = await runXmlVerification(verifyXml)
      if (xml.xmlVerified !== true) throw loginError('crown-login-readonly-verification-failed')
    } catch {
      log(logger, 'session-verification-failed', {
        accountId: accountId(account), errorCode: 'crown-login-readonly-verification-failed',
      })
      return finish(result, {
        ok: false,
        status: '登录失效',
        xmlVerified: false,
        sessionVerified: false,
        message: 'crown-login-readonly-verification-failed',
      })
    }
    let cookies
    try {
      cookies = typeof context?.cookies === 'function'
        ? exactOriginCookies(await context.cookies([account.loginUrl]), account.loginUrl)
        : []
      store.writeCookies(cookies)
    } catch {
      return finish(result, {
        ok: false,
        status: '登录失效',
        xmlVerified: true,
        sessionVerified: false,
        message: 'crown-login-cookie-save-failed',
      })
    }
    log(logger, 'exact-origin-cookies-saved', { accountId: accountId(account), cookieCount: cookies.length })
    log(logger, 'session-verified', { accountId: accountId(account), xmlVerified: xml.xmlVerified })
    return finish(result, {
      ok: true,
      status: '已登录',
      loginMethod,
      cookieStatus: '已保存',
      storageStateStatus: '不适用',
      xmlVerified: Boolean(xml.xmlVerified),
      sessionVerified: true,
      message: '',
    })
  }

  async failWithDiagnostics(result, { page, account, status, error, logger, extraDebug = {} }) {
    const diagnostic = await this.diagnostics(page, account, status, error, extraDebug)
    log(logger, 'login-diagnostics-saved', { accountId: accountId(account), diagnosticPath: diagnostic.diagnosticPath })
    log(logger, 'login-failed', { accountId: accountId(account), status, message: message(error) })
    return finish(result, {
      ok: false,
      status,
      diagnosticPath: diagnostic.diagnosticPath,
      debugSnapshot: diagnostic.snapshot,
      message: message(error),
    })
  }

  async ensureLogin({ page, context, account, verifyXml, logger } = {}) {
    const startedAt = nowIso()
    const exactAccount = {
      ...account,
      loginUrl: normalizePublicHttpsExactOrigin(account?.loginUrl),
    }
    const result = baseResult(exactAccount, startedAt)
    const store = this.cookieStoreFor(exactAccount)
    const originGuard = await installMainFrameOriginGuard({ context, page, origin: exactAccount.loginUrl })
    const assertOrigin = () => originGuard.assert()
    try {
    log(logger, 'login-start', { accountId: accountId(exactAccount) })
    log(logger, 'cookie-load-start', { accountId: accountId(exactAccount) })

    const cookieRead = store.readCookies()
    result.cookieStatus = cookieRead.status
    result.storageStateStatus = '不适用'
    if (cookieRead.status === '已过期') log(logger, 'cookie-expired', { accountId: accountId(exactAccount) })
    if (cookieRead.status === '已加载' && typeof context?.addCookies === 'function') {
      await context.addCookies(exactOriginCookies(cookieRead.cookies, exactAccount.loginUrl))
    }

    if (cookieRead.status === '已加载') {
      log(logger, 'cookie-valid', { accountId: accountId(exactAccount), cookieStatus: cookieRead.status, storageStateStatus: '不适用' })
      await gotoLoginUrl(page, exactAccount, originGuard)
      const session = await detectPageSession(page)
      if (session.humanRequired) {
        log(logger, 'human-verification-required', { accountId: accountId(exactAccount) })
        return this.failWithDiagnostics(result, { page, account: exactAccount, status: '需要人工验证', error: '需要人工验证', logger })
      }
      if (session.loggedIn) {
        return this.success(result, { account: exactAccount, context, store, loginMethod: 'cookies', verifyXml, logger })
      }
    }

    log(logger, 'credential-login-start', { accountId: accountId(exactAccount) })
    await gotoLoginUrl(page, exactAccount, originGuard)
    const beforeLogin = await detectPageSession(page)
    if (beforeLogin.humanRequired) {
      log(logger, 'human-verification-required', { accountId: accountId(exactAccount) })
      return this.failWithDiagnostics(result, { page, account: exactAccount, status: '需要人工验证', error: '需要人工验证', logger })
    }

    const usernameFilled = await fillFirstVisible(page, USERNAME_SELECTORS, exactAccount?.username || '', assertOrigin)
    const passwordFilled = await fillFirstVisible(page, PASSWORD_SELECTORS, exactAccount?.password || '', assertOrigin)
    if (!usernameFilled || !passwordFilled) {
      return this.failWithDiagnostics(result, {
        page,
        account: exactAccount,
        status: '表单未找到',
        error: '未找到账号或密码输入框',
        logger,
        extraDebug: { usernameFilled, passwordFilled },
      })
    }

    await Promise.allSettled([
      page.waitForLoadState?.('domcontentloaded', { timeout: 10_000 }),
      submitLoginForm(page, assertOrigin),
    ])
    await page.waitForTimeout?.(5000).catch(() => {})
    await dismissOptionalPostLoginPrompts(page, assertOrigin)
    await page.waitForTimeout?.(5000).catch(() => {})
    const afterLogin = await detectPageSession(page)
    if (afterLogin.humanRequired) {
      log(logger, 'human-verification-required', { accountId: accountId(exactAccount) })
      return this.failWithDiagnostics(result, { page, account: exactAccount, status: '需要人工验证', error: '需要人工验证', logger })
    }
    if (!afterLogin.loggedIn) {
      return this.failWithDiagnostics(result, {
        page,
        account: exactAccount,
        status: afterLogin.status === '未知' ? '登录失效' : afterLogin.status,
        error: afterLogin.status,
        logger,
      })
    }

    log(logger, 'credential-login-success', { accountId: accountId(exactAccount) })
    return this.success(result, { account: exactAccount, context, store, loginMethod: '账号密码', verifyXml, logger })
    } finally {
      await originGuard.dispose()
    }
  }
}

export default CrownLoginManager
