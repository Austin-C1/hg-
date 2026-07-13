import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectLoginSnapshot,
  readLoginDiagnostics,
  saveLoginDiagnostics,
} from '../src/crown/login/crown-login-diagnostics.mjs'

function tempRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-login-diagnostics-'))
}

function fakePage() {
  const calls = { screenshot: 0, context: 0 }
  return {
    calls,
    async evaluate() {
      return {
        title: 'Welcome monitor-user',
        url: 'https://example.test/login?token=url-token#session-secret',
        bodyText: 'Login password=body-secret',
        inputs: [
          { type: 'text', name: 'username', id: 'u', placeholder: '账号', visible: true, value: 'mon-user' },
          { type: 'password', name: 'password', id: 'p', placeholder: '密码', visible: true, value: 'mon-pass' },
        ],
        buttons: [{ text: 'Login', type: 'submit', visible: true }],
        iframes: [{ src: 'https://example.test/frame?uid=frame-secret', title: 'frame' }],
        localStorage: [{ name: 'token', value: 'local-token' }],
        sessionStorage: [{ name: 'authorization', value: 'Bearer session-token' }],
      }
    },
    async screenshot() {
      calls.screenshot += 1
      throw new Error('screenshot must not be captured')
    },
    context() {
      calls.context += 1
      return {
        async cookies() {
          return [{ name: 'uid', value: 'cookie-uid' }]
        },
        async storageState() {
          return { cookies: [{ name: 'uid', value: 'cookie-uid' }], origins: [] }
        },
      }
    },
  }
}

const FORBIDDEN_KEYS = /^(?:cookies?|storageState|password|inputs?|bodyText|localStorage|sessionStorage|extraDebug|authorization|setCookie)$/i
const SECRET_VALUES = /mon-user|mon-pass|body-secret|url-token|session-secret|frame-secret|local-token|session-token|cookie-uid|debug-token|Bearer abc|uid=abc/

function assertSafeDiagnostic(value) {
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized, SECRET_VALUES)
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit)
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      assert.doesNotMatch(key, FORBIDDEN_KEYS)
      visit(child)
    }
  }
  visit(value)
}

test('login diagnostics persist only a safe summary and never capture context or page pixels', async () => {
  const runtimeDir = tempRuntimeDir()
  const page = fakePage()
  const result = await saveLoginDiagnostics({
    page,
    account: { id: 'mon_primary', username: 'mon-user', password: 'mon-pass' },
    classifiedState: '表单未找到',
    error: new Error('password=mon-pass'),
    runtimeDir,
    extraDebug: { token: 'debug-token', usernameFilled: true, passwordFilled: false },
  })

  assert.match(result.diagnosticPath, /login-diagnostics[\\/]\d{8}-\d{6}-mon_primary$/)
  assert.equal(fs.existsSync(path.join(result.diagnosticPath, 'snapshot.json')), true)
  assert.equal(result.screenshotPath, '')
  assert.equal(fs.existsSync(path.join(result.diagnosticPath, 'screenshot.png')), false)
  assert.equal(page.calls.screenshot, 0)
  assert.equal(page.calls.context, 0)
  assert.equal(result.snapshot.accountId, 'mon_primary')
  assert.equal(result.snapshot.classifiedState, '表单未找到')
  assert.equal(result.snapshot.page.origin, 'https://example.test')
  assert.equal(result.snapshot.page.formControlCount, 2)
  assert.equal(result.snapshot.page.secretFieldPresent, true)
  assertSafeDiagnostic(result.snapshot)
  assertSafeDiagnostic(JSON.parse(fs.readFileSync(path.join(result.diagnosticPath, 'snapshot.json'), 'utf8')))
})

test('readLoginDiagnostics sanitizes legacy snapshots before returning them to the API', () => {
  const diagnosticPath = path.join(tempRuntimeDir(), 'login-diagnostics', 'legacy')
  fs.mkdirSync(diagnosticPath, { recursive: true })
  fs.writeFileSync(path.join(diagnosticPath, 'snapshot.json'), JSON.stringify({
    title: 'Welcome monitor-user',
    url: 'https://example.test/login?token=url-token',
    bodyText: 'password=body-secret',
    inputs: [{ name: 'username', value: 'mon-user' }, { type: 'password', value: 'mon-pass' }],
    cookies: [{ name: 'uid', value: 'cookie-uid' }],
    storageState: { cookies: [{ value: 'cookie-uid' }] },
    extraDebug: { authorization: 'Bearer abc', setCookie: 'uid=abc' },
    account: { id: 'mon_primary', username: 'mon-user', password: 'mon-pass' },
    classifiedState: 'Welcome 页面',
    errorMessage: 'password=mon-pass',
  }), 'utf8')

  const snapshot = readLoginDiagnostics(diagnosticPath).item
  assert.equal(snapshot.accountId, 'mon_primary')
  assert.equal(snapshot.classifiedState, 'Welcome 页面')
  assertSafeDiagnostic(snapshot)
})

test('collectLoginSnapshot returns counts and flags instead of raw page or debug values', async () => {
  const page = fakePage()
  const snapshot = await collectLoginSnapshot(page, {
    authorization: 'Bearer abc',
    setCookie: 'uid=abc',
    usernameFilled: true,
  })

  assert.deepEqual(snapshot.page, {
    available: true,
    origin: 'https://example.test',
    titlePresent: true,
    formControlCount: 2,
    visibleFormControlCount: 2,
    secretFieldPresent: true,
    actionCount: 1,
    frameCount: 1,
    browserDataEntryCount: 2,
  })
  assert.equal(snapshot.debugSummary.provided, true)
  assert.equal(snapshot.debugSummary.booleanTrueCount, 1)
  assertSafeDiagnostic(snapshot)
})
