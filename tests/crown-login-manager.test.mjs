import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CrownLoginManager } from '../src/crown/login/crown-login-manager.mjs'

function tempRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-login-manager-'))
}

function fakeContext() {
  const calls = { addCookies: [], cookies: 0, storageState: 0 }
  return {
    calls,
    async addCookies(cookies) {
      calls.addCookies.push(cookies)
    },
    async cookies() {
      calls.cookies += 1
      return [{ name: 'uid', value: 'fresh', domain: '.example.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]
    },
    async storageState() {
      calls.storageState += 1
      return { cookies: await this.cookies(), origins: [] }
    },
  }
}

function fakeLocator({ count = 1, visible = true } = {}) {
  return {
    first() { return this },
    async count() { return count },
    async isVisible() { return visible },
    async fill() {},
    async click() {},
  }
}

function fakePage({ firstState = '已登录', secondState = '已登录', form = true, human = false } = {}) {
  const calls = { fills: [], clicks: 0, goto: 0 }
  let sessionCalls = 0
  return {
    calls,
    async goto() {
      calls.goto += 1
    },
    locator(selector) {
      if (selector.includes('password')) {
        return form ? {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async fill(value) { calls.fills.push({ selector, value }) },
        } : fakeLocator({ count: 0 })
      }
      if (selector.includes('button') || selector.includes('submit')) {
        return form ? {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async click() { calls.clicks += 1 },
        } : fakeLocator({ count: 0 })
      }
      return form ? {
        first() { return this },
        async count() { return 1 },
        async isVisible() { return true },
        async fill(value) { calls.fills.push({ selector, value }) },
      } : fakeLocator({ count: 0 })
    },
    keyboard: {
      async press() {},
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate() {
      sessionCalls += 1
      if (human) {
        return { title: 'Verify', url: 'https://example.test', bodyText: '滑块验证码', inputs: [], buttons: [], iframes: [] }
      }
      const status = sessionCalls === 1 ? firstState : secondState
      if (status === '已登录') return { title: '足球', url: 'https://example.test', bodyText: '足球 让球 今日赛事', inputs: [], buttons: [], iframes: [] }
      return { title: 'Welcome', url: 'https://example.test', bodyText: 'Welcome Login', inputs: [{ type: 'text', name: 'username', visible: true, value: '' }, { type: 'password', name: 'password', visible: true, value: '' }], buttons: [] }
    },
    async screenshot({ path: screenshotPath }) {
      fs.writeFileSync(screenshotPath, 'png', 'utf8')
    },
    context() {
      return fakeContext()
    },
  }
}

function fakeCrownLoginPage() {
  const calls = { fills: [], clicks: 0, promptClicks: 0, waitedSelector: '' }
  let sessionCalls = 0
  return {
    calls,
    async goto() {},
    async waitForSelector(selector) {
      calls.waitedSelector = selector
    },
    locator(selector) {
      if (selector === '#usr') {
        return {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async fill(value) { calls.fills.push({ selector, value }) },
        }
      }
      if (selector === '#pwd') {
        return {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async fill(value) { calls.fills.push({ selector, value }) },
        }
      }
      if (selector === '#btn_login') {
        return {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async click() { calls.clicks += 1 },
        }
      }
      if (selector === '#C_no_btn:visible') {
        return {
          first() { return this },
          async count() { return 1 },
          async isVisible() { return true },
          async click() { calls.promptClicks += 1 },
        }
      }
      return fakeLocator({ count: 0 })
    },
    keyboard: { async press() {} },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate() {
      sessionCalls += 1
      if (sessionCalls === 1) {
        return {
          title: 'Welcome',
          url: 'https://m407.mos077.com',
          bodyText: '记住我的帐号 登入',
          inputs: [
            { type: 'text', id: 'usr', visible: true, value: '' },
            { type: 'password', id: 'pwd', visible: true, value: '' },
            { type: 'button', id: 'btn_login', visible: true, value: '登入' },
          ],
          buttons: [],
          iframes: [],
        }
      }
      return { title: '足球', url: 'https://m407.mos077.com', bodyText: '足球 今日赛事 让球', inputs: [], buttons: [], iframes: [] }
    },
    async screenshot({ path: screenshotPath }) {
      fs.writeFileSync(screenshotPath, 'png', 'utf8')
    },
    context() {
      return fakeContext()
    },
  }
}

test('login manager uses valid cookies without filling credentials', async () => {
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownLoginManager({ runtimeDir })
  const account = { id: 'mon_primary', username: 'mon-user', password: 'mon-pass', loginUrl: 'https://example.test' }
  manager.cookieStoreFor(account).writeCookies([{ name: 'uid', value: 'cookie', domain: '.example.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }])
  const page = fakePage({ firstState: '已登录' })

  const result = await manager.ensureLogin({ page, context: fakeContext(), account, verifyXml: async () => true })

  assert.equal(result.ok, true)
  assert.equal(result.status, '已登录')
  assert.equal(result.loginMethod, 'cookies')
  assert.equal(result.xmlVerified, true)
  assert.deepEqual(page.calls.fills, [])
})

test('login manager falls back to credentials when cookies are invalid', async () => {
  const runtimeDir = tempRuntimeDir()
  const manager = new CrownLoginManager({ runtimeDir })
  const account = { id: 'mon_primary', username: 'mon-user', password: 'mon-pass', loginUrl: 'https://example.test' }
  manager.cookieStoreFor(account).writeCookies([{ name: 'old', value: '1', domain: '.example.test', path: '/', expires: 1 }])
  const page = fakePage({ firstState: '登录失效', secondState: '已登录' })

  const result = await manager.ensureLogin({ page, context: fakeContext(), account })

  assert.equal(result.ok, true)
  assert.equal(result.loginMethod, '账号密码')
  assert.equal(result.status, '已登录')
  assert.equal(page.calls.fills.some((call) => call.value === 'mon-user'), true)
  assert.equal(page.calls.fills.some((call) => call.value === 'mon-pass'), true)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-sessions', 'mon_primary', 'storage-state.json')), true)
})

test('login manager supports the real Crown usr pwd and btn_login controls', async () => {
  const manager = new CrownLoginManager({ runtimeDir: tempRuntimeDir() })
  const account = { id: 'mon_primary', username: 'mon-user', password: 'mon-pass', loginUrl: 'https://m407.mos077.com' }
  const page = fakeCrownLoginPage()

  const result = await manager.ensureLogin({ page, context: fakeContext(), account })

  assert.equal(result.ok, true)
  assert.equal(result.loginMethod, '账号密码')
  assert.equal(page.calls.fills.some((call) => call.selector === '#usr' && call.value === 'mon-user'), true)
  assert.equal(page.calls.fills.some((call) => call.selector === '#pwd' && call.value === 'mon-pass'), true)
  assert.equal(page.calls.clicks, 1)
  assert.equal(page.calls.promptClicks, 1)
  assert.match(page.calls.waitedSelector, /#pwd/)
})

test('login manager saves diagnostics when login form is not found', async () => {
  const manager = new CrownLoginManager({ runtimeDir: tempRuntimeDir() })
  const account = { id: 'mon_primary', username: 'mon-user', password: 'mon-pass', loginUrl: 'https://example.test' }
  const result = await manager.ensureLogin({ page: fakePage({ firstState: '登录失效', form: false }), context: fakeContext(), account })

  assert.equal(result.ok, false)
  assert.equal(result.status, '表单未找到')
  assert.match(result.diagnosticPath, /login-diagnostics/)
  assert.equal(fs.existsSync(path.join(result.diagnosticPath, 'snapshot.json')), true)
})

test('login manager returns 需要人工验证 when the page asks for human verification', async () => {
  const manager = new CrownLoginManager({ runtimeDir: tempRuntimeDir() })
  const account = { id: 'mon_primary', username: 'mon-user', password: 'mon-pass', loginUrl: 'https://example.test' }
  const result = await manager.ensureLogin({ page: fakePage({ human: true }), context: fakeContext(), account })

  assert.equal(result.ok, false)
  assert.equal(result.status, '需要人工验证')
})
