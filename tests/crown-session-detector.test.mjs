import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectPageSession,
  detectSessionFromSnapshot,
  detectXmlSession,
  isHumanVerificationText,
  isLoginFormSnapshot,
} from '../src/crown/login/crown-session-detector.mjs'

test('session detector classifies Welcome pages', () => {
  const result = detectSessionFromSnapshot({ title: 'Welcome', bodyText: 'Welcome' })

  assert.equal(result.status, 'Welcome 页面')
  assert.equal(result.loggedIn, false)
})

test('session detector classifies visible login forms as 登录失效', () => {
  const snapshot = {
    title: 'Login',
    inputs: [
      { type: 'text', name: 'username', visible: true, value: '' },
      { type: 'password', name: 'password', visible: true, value: '' },
    ],
    buttons: [{ text: 'Login', visible: true }],
  }

  assert.equal(isLoginFormSnapshot(snapshot), true)
  assert.equal(detectSessionFromSnapshot(snapshot).status, '登录失效')
})

test('session detector classifies human verification text', () => {
  assert.equal(isHumanVerificationText('请完成滑块验证码安全验证'), true)
  assert.equal(detectSessionFromSnapshot({ bodyText: '请完成滑块验证码安全验证' }).status, '需要人工验证')
})

test('session detector classifies football odds pages without a login form as 已登录', () => {
  const result = detectSessionFromSnapshot({
    title: '足球 今日赛事',
    bodyText: '滚球 让球 大小 今日比赛',
    inputs: [],
  })

  assert.equal(result.status, '已登录')
  assert.equal(result.loggedIn, true)
})

test('session detector classifies XML login-expired HTML as 登录失效', () => {
  const result = detectXmlSession('<html><title>Login</title><body>login_index password</body></html>')

  assert.equal(result.status, '登录失效')
  assert.equal(result.xmlVerified, false)
})

test('session detector reads a Playwright page into a snapshot', async () => {
  const page = {
    async evaluate() {
      return {
        title: '足球',
        url: 'https://example.test',
        bodyText: '足球 让球',
        inputs: [],
        buttons: [],
        iframes: [],
      }
    },
  }

  assert.equal((await detectPageSession(page)).status, '已登录')
})
