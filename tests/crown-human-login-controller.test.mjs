import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CrownHumanLoginController,
  replaceOwnerBoundSessionAtomically,
} from '../src/crown/app/crown-human-login-controller.mjs'

const ORIGIN = 'https://crown.example.com'

function fakeStatus(status = 'awaiting-user') {
  return {
    challengeId: 'challenge-safe',
    accountId: 'mon_A',
    origin: ORIGIN,
    status,
    errorCode: status === 'failed' ? 'manual-login-cancelled' : '',
    expiresAt: 61_000,
    password: 'must-not-leak',
    cookies: { SID: 'must-not-leak' },
    uid: 'must-not-leak',
    nonce: 'must-not-leak',
  }
}

test('controller loads the bound account, delegates to ManualLoginBridge and exposes only safe states', async () => {
  const calls = []
  const bridge = {
    async openManualLogin({ account }) { calls.push({ type: 'open', account }); return fakeStatus() },
    getManualLoginStatus(input) { calls.push({ type: 'status', ...input }); return fakeStatus() },
    async confirmManualLogin(input) { calls.push({ type: 'confirm', ...input }); return fakeStatus('verified') },
    async cancelManualLogin(input) { calls.push({ type: 'cancel', ...input }); return fakeStatus('failed') },
  }
  const controller = new CrownHumanLoginController({
    bridge,
    loadAccount: async (accountId) => ({
      id: accountId,
      username: 'owner-user',
      password: 'stored-password-is-not-forwarded',
      loginUrl: ORIGIN,
    }),
  })

  const opened = await controller.openManualLogin({ accountId: 'mon_A' })
  assert.deepEqual(opened, {
    challengeId: 'challenge-safe', accountId: 'mon_A', status: 'awaiting-user', errorCode: '', expiresAt: 61_000,
  })
  assert.deepEqual(calls[0], {
    type: 'open',
    account: { id: 'mon_A', accountId: 'mon_A', username: 'owner-user', loginUrl: ORIGIN },
  })
  assert.doesNotMatch(JSON.stringify(opened), /password|cookie|uid|nonce|origin/i)

  assert.equal(controller.getManualLoginStatus({ accountId: 'mon_A', challengeId: 'challenge-safe' }).status, 'awaiting-user')
  assert.equal((await controller.confirmManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' })).status, 'verified')
  assert.equal(calls.some((call) => call.type === 'confirm'), true)
})

test('controller rejects cross-account challenge use before delegating', async () => {
  let statusCalls = 0
  const controller = new CrownHumanLoginController({
    bridge: {
      async openManualLogin() { return fakeStatus() },
      getManualLoginStatus() { statusCalls += 1; return fakeStatus() },
      async confirmManualLogin() { return fakeStatus('verified') },
      async cancelManualLogin() { return fakeStatus('failed') },
    },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })

  assert.throws(() => controller.getManualLoginStatus({
    accountId: 'mon_B', challengeId: 'challenge-safe',
  }), /manual-login-challenge-binding-mismatch/)
  assert.equal(statusCalls, 0)
})

class FakePage extends EventEmitter {
  constructor() {
    super()
    this.currentUrl = 'about:blank'
  }

  async goto(origin) { this.currentUrl = `${origin}/login` }
  url() { return this.currentUrl }
}

class FakeContext extends EventEmitter {
  constructor(page) {
    super()
    this.page = page
    this.closeCalls = 0
    this.storageStateCalls = 0
  }

  pages() { return [] }
  async newPage() { return this.page }
  async route(_pattern, handler) { this.routeHandler = handler }
  async cookies(urls) {
    assert.deepEqual(urls, [ORIGIN])
    return [
      { name: 'SID', value: 'exact-cookie', domain: 'crown.example.com', path: '/' },
      { name: 'FOREIGN', value: 'foreign-cookie', domain: 'evil.example.com', path: '/' },
    ]
  }
  async storageState() { this.storageStateCalls += 1; throw new Error('forbidden storageState') }
  async close() { this.closeCalls += 1 }
}

function loginRequest() {
  return {
    method: () => 'POST',
    url: () => `${ORIGIN}/transform_nl.php`,
    postData: () => 'p=chk_login&username=owner-user',
    isNavigationRequest: () => false,
  }
}

test('default controller uses bundled Chromium and fake read-only get_game_list before atomic owner save', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-controller-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appRoot = path.join(root, 'app')
  const dataRoot = path.join(root, 'data')
  const runtimeDir = path.join(dataRoot, 'runtime')
  const profileRoot = path.join(runtimeDir, 'browser-profiles')
  const executablePath = path.join(appRoot, 'runtime', 'chromium', 'chrome.exe')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, 'fake executable')

  const page = new FakePage()
  const context = new FakeContext(page)
  const launches = []
  const chromium = {
    async launchPersistentContext(profileDir, options) {
      launches.push({ profileDir, options })
      return context
    },
  }
  const verified = []
  const controller = new CrownHumanLoginController({
    installationId: 'install-A',
    appRoot,
    dataRoot,
    runtimeDir,
    profileRoot,
    chromiumExecutable: executablePath,
    chromium,
    loadAccount: async () => ({
      id: 'mon_A', username: 'owner-user', password: 'not-used', loginUrl: ORIGIN,
    }),
    apiClient: {
      async fetchGameList(session) {
        verified.push(structuredClone(session))
        return {
          classification: { hasServerResponse: true, loginExpired: false, parseError: false },
          requestScope: { endpointKind: 'get_game_list' },
          session: { ...session, savedAt: 2_000 },
        }
      },
    },
  })

  const opened = await controller.openManualLogin({ accountId: 'mon_A' })
  const request = loginRequest()
  page.emit('request', request)
  page.emit('response', {
    request: () => request,
    url: () => `${ORIGIN}/transform_nl.php`,
    status: () => 200,
    text: async () => '<serverresponse><status>200</status><uid>owner-uid</uid></serverresponse>',
  })
  const confirmed = await controller.confirmManualLogin({
    accountId: 'mon_A', challengeId: opened.challengeId,
  })

  assert.equal(confirmed.status, 'verified')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].options.executablePath, fs.realpathSync(executablePath))
  assert.equal(launches[0].options.headless, false)
  assert.equal(Object.hasOwn(launches[0].options, 'channel'), false)
  assert.equal(context.storageStateCalls, 0)
  assert.equal(verified.length, 1)
  assert.deepEqual(verified[0].cookies, { SID: 'exact-cookie' })

  const sessionPath = path.join(runtimeDir, 'crown-sessions', 'mon_A', 'api-session.json')
  const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
  assert.deepEqual(saved, {
    schemaVersion: 1,
    uid: 'owner-uid',
    cookies: { SID: 'exact-cookie' },
    accountId: 'mon_A',
    username: 'owner-user',
    baseUrl: ORIGIN,
    savedAt: 2_000,
  })
  assert.doesNotMatch(fs.readFileSync(sessionPath, 'utf8'), /not-used|foreign-cookie/)
})

test('atomic session replacement uses a contained safe path and publishes one complete owner session', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-session-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  const runtimeDir = path.join(dataRoot, 'runtime')
  const target = path.join(runtimeDir, 'crown-sessions', 'mon_A', 'api-session.json')
  await replaceOwnerBoundSessionAtomically({
    dataRoot,
    runtimeDir,
    account: { id: 'mon_A', username: 'owner-user', loginUrl: ORIGIN },
    session: {
      uid: 'new-uid', cookies: { SID: 'new-cookie' }, accountId: 'mon_A',
      username: 'owner-user', baseUrl: ORIGIN, savedAt: 2_000,
    },
  })

  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).uid, 'new-uid')
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['api-session.json'])
})

test('atomic session replacement rejects root-relative, device, and junction paths before publishing', async (t) => {
  const session = {
    uid: 'new-uid', cookies: { SID: 'new-cookie' }, accountId: 'mon_A',
    username: 'owner-user', baseUrl: ORIGIN, savedAt: 2_000,
  }
  const account = { id: 'mon_A', username: 'owner-user', loginUrl: ORIGIN }
  for (const dataRoot of ['\\unsafe-root-relative', '\\\\?\\C:\\unsafe-device']) {
    await assert.rejects(() => replaceOwnerBoundSessionAtomically({
      dataRoot, runtimeDir: `${dataRoot}\\runtime`, account, session,
    }), /manual-login-data-root-invalid|portable-path/)
  }

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-junction-'))
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-external-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  const runtimeDir = path.join(dataRoot, 'runtime')
  fs.symlinkSync(external, runtimeDir, 'junction')
  await assert.rejects(() => replaceOwnerBoundSessionAtomically({ dataRoot, runtimeDir, account, session }), /atomic-json-path-invalid/)
  assert.deepEqual(fs.readdirSync(external), [])
})

test('confirm revalidates account deletion, username, and origin before bridge verification', async () => {
  const changes = [
    { id: 'mon_A', username: 'renamed-owner', loginUrl: ORIGIN },
    { id: 'mon_A', username: 'owner', loginUrl: 'https://changed.example.com' },
    null,
  ]
  for (const changed of changes) {
    let current = { id: 'mon_A', username: 'owner', loginUrl: ORIGIN }
    let confirmCalls = 0
    const controller = new CrownHumanLoginController({
      bridge: {
        async openManualLogin() { return fakeStatus() },
        getManualLoginStatus() { return fakeStatus() },
        async confirmManualLogin() { confirmCalls += 1; return fakeStatus('verified') },
        async cancelManualLogin() { return fakeStatus('failed') },
      },
      loadAccount: async () => {
        if (!current) throw new Error('deleted')
        return current
      },
    })
    await controller.openManualLogin({ accountId: 'mon_A' })
    current = changed

    await assert.rejects(() => controller.confirmManualLogin({
      accountId: 'mon_A', challengeId: 'challenge-safe',
    }), /manual-login-account-binding-changed/)
    assert.equal(confirmCalls, 0)
  }
})

test('save-time account binding drift preserves the previous owner session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-save-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appRoot = path.join(root, 'app')
  const dataRoot = path.join(root, 'data')
  const runtimeDir = path.join(dataRoot, 'runtime')
  const profileRoot = path.join(runtimeDir, 'browser-profiles')
  const executablePath = path.join(appRoot, 'runtime', 'chromium', 'chrome.exe')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, 'fake executable')
  const target = path.join(runtimeDir, 'crown-sessions', 'mon_A', 'api-session.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '{"old":true}\n')
  let current = { id: 'mon_A', username: 'owner-user', loginUrl: ORIGIN }
  let releaseVerification
  const verificationGate = new Promise((resolve) => { releaseVerification = resolve })
  let verificationStarted
  const started = new Promise((resolve) => { verificationStarted = resolve })
  const page = new FakePage()
  const context = new FakeContext(page)
  const controller = new CrownHumanLoginController({
    installationId: 'install-A', appRoot, dataRoot, runtimeDir, profileRoot,
    chromiumExecutable: executablePath,
    chromium: { async launchPersistentContext() { return context } },
    loadAccount: async () => ({ ...current }),
    apiClient: {
      async fetchGameList(session) {
        verificationStarted()
        await verificationGate
        return {
          classification: { hasServerResponse: true, loginExpired: false, parseError: false },
          requestScope: { endpointKind: 'get_game_list' },
          session: { ...session, savedAt: 2_000 },
        }
      },
    },
  })
  const opened = await controller.openManualLogin({ accountId: 'mon_A' })
  const request = loginRequest()
  page.emit('request', request)
  page.emit('response', {
    request: () => request, url: () => `${ORIGIN}/transform_nl.php`, status: () => 200,
    text: async () => '<serverresponse><status>200</status><uid>owner-uid</uid></serverresponse>',
  })
  const confirming = controller.confirmManualLogin({ accountId: 'mon_A', challengeId: opened.challengeId })
  await started
  current = { ...current, loginUrl: 'https://changed.example.com' }
  releaseVerification()
  await assert.rejects(confirming, /manual-login-session-save-failed/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}\n')
})

test('shutdown abort reaches the default read-only get_game_list and cannot publish an unfinished confirm', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-human-abort-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appRoot = path.join(root, 'app')
  const dataRoot = path.join(root, 'data')
  const runtimeDir = path.join(dataRoot, 'runtime')
  const profileRoot = path.join(runtimeDir, 'browser-profiles')
  const executablePath = path.join(appRoot, 'runtime', 'chromium', 'chrome.exe')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.writeFileSync(executablePath, 'fake executable')
  const target = path.join(runtimeDir, 'crown-sessions', 'mon_A', 'api-session.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '{"old":true}\n')
  let observedSignal
  let verificationStarted
  const started = new Promise((resolve) => { verificationStarted = resolve })
  const page = new FakePage()
  const context = new FakeContext(page)
  const controller = new CrownHumanLoginController({
    installationId: 'install-A', appRoot, dataRoot, runtimeDir, profileRoot,
    chromiumExecutable: executablePath,
    chromium: { async launchPersistentContext() { return context } },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner-user', loginUrl: ORIGIN }),
    apiClient: {
      async fetchGameList(_session, { signal }) {
        observedSignal = signal
        verificationStarted()
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      },
    },
  })
  const opened = await controller.openManualLogin({ accountId: 'mon_A' })
  const request = loginRequest()
  page.emit('request', request)
  page.emit('response', {
    request: () => request, url: () => `${ORIGIN}/transform_nl.php`, status: () => 200,
    text: async () => '<serverresponse><status>200</status><uid>owner-uid</uid></serverresponse>',
  })
  const confirming = controller.confirmManualLogin({ accountId: 'mon_A', challengeId: opened.challengeId })
  await started
  const shutdown = controller.shutdown()
  const [confirmResult, shutdownResult] = await Promise.allSettled([confirming, shutdown])

  assert.equal(observedSignal.aborted, true)
  assert.equal(confirmResult.status, 'rejected')
  assert.doesNotMatch(String(confirmResult.reason), /verified|ok/i)
  assert.deepEqual(shutdownResult, { status: 'fulfilled', value: { ok: true } })
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}\n')
})

test('shutdown aborts and waits for in-flight confirmation, then rejects every new operation', async () => {
  let confirmSignal
  const bridge = {
    async openManualLogin() { return fakeStatus() },
    getManualLoginStatus() { return fakeStatus() },
    async confirmManualLogin(input) {
      confirmSignal = input.signal
      await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }))
      return fakeStatus('failed')
    },
    async cancelManualLogin() { return fakeStatus('failed') },
  }
  const controller = new CrownHumanLoginController({
    bridge,
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })
  const confirming = controller.confirmManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' })
  await new Promise((resolve) => setImmediate(resolve))
  const shutdown = controller.shutdown()
  const [confirmed, stopped] = await Promise.all([confirming, shutdown])

  assert.equal(confirmSignal.aborted, true)
  assert.equal(confirmed.status, 'failed')
  assert.deepEqual(stopped, { ok: true })
  assert.throws(() => controller.getManualLoginStatus({ accountId: 'mon_A', challengeId: 'challenge-safe' }), /manual-login-controller-closing/)
  await assert.rejects(() => controller.confirmManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' }), /manual-login-controller-closing/)
  await assert.rejects(() => controller.cancelManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' }), /manual-login-controller-closing/)
})

test('shutdown remains bounded when an injected operation ignores its AbortSignal', async () => {
  const never = new Promise(() => {})
  const controller = new CrownHumanLoginController({
    shutdownWaitMs: 20,
    bridge: {
      async openManualLogin() { return fakeStatus() },
      getManualLoginStatus() { return fakeStatus() },
      async confirmManualLogin() { return never },
      async cancelManualLogin() { return fakeStatus('failed') },
    },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })
  void controller.confirmManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' }).catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const startedAt = Date.now()
  const result = await controller.shutdown()
  assert.deepEqual(result, { ok: true })
  assert.equal(Date.now() - startedAt < 500, true)
})

test('terminal challenges are removed from controller bindings', async () => {
  const controller = new CrownHumanLoginController({
    bridge: {
      async openManualLogin() { return fakeStatus() },
      getManualLoginStatus() { return fakeStatus() },
      async confirmManualLogin() { return fakeStatus('verified') },
      async cancelManualLogin() { return fakeStatus('failed') },
    },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })
  await controller.cancelManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' })
  assert.throws(() => controller.getManualLoginStatus({
    accountId: 'mon_A', challengeId: 'challenge-safe',
  }), /manual-login-challenge-binding-mismatch/)
})

test('controller challenge and operation collections enforce a fixed capacity and recover after terminal cleanup', async () => {
  const controller = new CrownHumanLoginController({
    maxActiveChallenges: 1,
    bridge: {
      async openManualLogin() { return fakeStatus() },
      getManualLoginStatus() { return fakeStatus() },
      async confirmManualLogin() { return fakeStatus('verified') },
      async cancelManualLogin() { return fakeStatus('failed') },
    },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })
  await assert.rejects(() => controller.openManualLogin({ accountId: 'mon_A' }), /manual-login-busy/)
  await controller.cancelManualLogin({ accountId: 'mon_A', challengeId: 'challenge-safe' })
  assert.equal((await controller.openManualLogin({ accountId: 'mon_A' })).status, 'awaiting-user')
})

test('shutdown cancels tracked challenges and closes every tracked browser without starting a watcher', async () => {
  const calls = []
  const bridge = {
    async openManualLogin() { return fakeStatus() },
    getManualLoginStatus() { return fakeStatus() },
    async confirmManualLogin() { return fakeStatus('verified') },
    async cancelManualLogin(input) { calls.push(input); return fakeStatus('failed') },
  }
  const controller = new CrownHumanLoginController({
    bridge,
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })
  await controller.openManualLogin({ accountId: 'mon_A' })

  const result = await controller.shutdown()
  assert.deepEqual(calls, [{ accountId: 'mon_A', challengeId: 'challenge-safe' }])
  assert.deepEqual(result, { ok: true })
})

test('shutdown waits for an in-flight open and cancels the challenge returned during shutdown', async () => {
  let releaseOpen
  const openGate = new Promise((resolve) => { releaseOpen = resolve })
  const cancelled = []
  const controller = new CrownHumanLoginController({
    bridge: {
      async openManualLogin() { await openGate; return fakeStatus() },
      getManualLoginStatus() { return fakeStatus() },
      async confirmManualLogin() { return fakeStatus('verified') },
      async cancelManualLogin(input) { cancelled.push(input); return fakeStatus('failed') },
    },
    loadAccount: async () => ({ id: 'mon_A', username: 'owner', loginUrl: ORIGIN }),
  })

  const opening = controller.openManualLogin({ accountId: 'mon_A' })
  await new Promise((resolve) => setImmediate(resolve))
  const shutdown = controller.shutdown()
  releaseOpen()
  await Promise.all([opening, shutdown])

  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].accountId, 'mon_A')
  assert.equal(cancelled[0].challengeId, 'challenge-safe')
  assert.equal(cancelled[0].signal.aborted, true)
  await assert.rejects(() => controller.openManualLogin({ accountId: 'mon_A' }), /manual-login-controller-closing/)
})
