import { CrownCookieStore } from './crown-cookie-store.mjs'
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

async function gotoLoginUrl(page, account) {
  if (account?.loginUrl && typeof page?.goto === 'function') {
    await page.goto(account.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
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

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    await locator.fill(value, { timeout: 5000 })
    return true
  }
  return false
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    await locator.click({ timeout: 5000 })
    return true
  }
  return false
}

async function submitLoginForm(page) {
  if (await clickFirstVisible(page, SUBMIT_SELECTORS)) return true
  await page.keyboard?.press?.('Enter').catch(() => {})
  return true
}

async function dismissOptionalPostLoginPrompts(page) {
  const clicked = await clickFirstVisible(page, [
    '#no_btn:visible',
    '#C_no_btn:visible',
    'button:has-text("否")',
    'div:has-text("否")',
  ]).catch(() => false)
  if (clicked) return true

  for (const selector of ['#C_no_btn', '#no_btn']) {
    const box = await page.locator?.(selector)?.boundingBox?.().catch(() => null)
    if (box?.width > 0 && box?.height > 0 && typeof page.mouse?.click === 'function') {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      return true
    }
  }

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
    await store.saveFromContext(context)
    log(logger, 'storage-state-saved', { accountId: accountId(account) })
    const xml = await runXmlVerification(verifyXml)
    log(logger, 'session-verified', { accountId: accountId(account), xmlVerified: xml.xmlVerified })
    return finish(result, {
      ok: true,
      status: '已登录',
      loginMethod,
      cookieStatus: result.cookieStatus,
      storageStateStatus: result.storageStateStatus,
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
    const result = baseResult(account, startedAt)
    const store = this.cookieStoreFor(account)
    log(logger, 'login-start', { accountId: accountId(account) })
    log(logger, 'cookie-load-start', { accountId: accountId(account) })

    const cookieRead = store.readCookies()
    const storageRead = store.readStorageState()
    result.cookieStatus = cookieRead.status
    result.storageStateStatus = storageRead.status
    if (cookieRead.status === '已过期') log(logger, 'cookie-expired', { accountId: accountId(account) })
    await store.loadIntoContext(context)

    if (cookieRead.status === '已加载' || storageRead.status === '已加载') {
      log(logger, 'cookie-valid', { accountId: accountId(account), cookieStatus: cookieRead.status, storageStateStatus: storageRead.status })
      await gotoLoginUrl(page, account)
      const session = await detectPageSession(page)
      if (session.humanRequired) {
        log(logger, 'human-verification-required', { accountId: accountId(account) })
        return this.failWithDiagnostics(result, { page, account, status: '需要人工验证', error: '需要人工验证', logger })
      }
      if (session.loggedIn) {
        return this.success(result, { account, context, store, loginMethod: 'cookies', verifyXml, logger })
      }
    }

    log(logger, 'credential-login-start', { accountId: accountId(account) })
    await gotoLoginUrl(page, account)
    const beforeLogin = await detectPageSession(page)
    if (beforeLogin.humanRequired) {
      log(logger, 'human-verification-required', { accountId: accountId(account) })
      return this.failWithDiagnostics(result, { page, account, status: '需要人工验证', error: '需要人工验证', logger })
    }

    const usernameFilled = await fillFirstVisible(page, USERNAME_SELECTORS, account?.username || '')
    const passwordFilled = await fillFirstVisible(page, PASSWORD_SELECTORS, account?.password || '')
    if (!usernameFilled || !passwordFilled) {
      return this.failWithDiagnostics(result, {
        page,
        account,
        status: '表单未找到',
        error: '未找到账号或密码输入框',
        logger,
        extraDebug: { usernameFilled, passwordFilled },
      })
    }

    await Promise.allSettled([
      page.waitForLoadState?.('domcontentloaded', { timeout: 10_000 }),
      submitLoginForm(page),
    ])
    await page.waitForTimeout?.(5000).catch(() => {})
    await dismissOptionalPostLoginPrompts(page)
    await page.waitForTimeout?.(5000).catch(() => {})
    const afterLogin = await detectPageSession(page)
    if (afterLogin.humanRequired) {
      log(logger, 'human-verification-required', { accountId: accountId(account) })
      return this.failWithDiagnostics(result, { page, account, status: '需要人工验证', error: '需要人工验证', logger })
    }
    if (!afterLogin.loggedIn) {
      return this.failWithDiagnostics(result, {
        page,
        account,
        status: afterLogin.status === '未知' ? '登录失效' : afterLogin.status,
        error: afterLogin.status,
        logger,
      })
    }

    log(logger, 'credential-login-success', { accountId: accountId(account) })
    return this.success(result, { account, context, store, loginMethod: '账号密码', verifyXml, logger })
  }
}

export default CrownLoginManager
