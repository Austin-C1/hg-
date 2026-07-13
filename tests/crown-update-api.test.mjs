import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'
import { updateError } from '../src/crown/update/update-error.mjs'
import { createDashboardUpdateService, shutdownDashboardRuntime } from '../scripts/crown-dashboard.mjs'

const STATUS = Object.freeze({
  state: 'available',
  currentVersion: '0.1.0',
  availableVersion: '0.2.0',
  progress: 0,
  errorCode: '',
  cancellable: false,
  releaseNotes: '修复更新流程\n<script>alert(1)</script>',
  rollbackReason: 'update-health-check-failed',
  manifest: { secret: 'must-not-leak' },
  nonce: 'must-not-leak',
})

function makeService(overrides = {}) {
  const calls = []
  return {
    calls,
    getStatus() { calls.push(['getStatus']); return STATUS },
    async check() { calls.push(['check']); return STATUS },
    async install(input) { calls.push(['install', input]); return { ...STATUS, state: 'applying', progress: 100 } },
    async cancel() { calls.push(['cancel']); return { cancelled: true, code: 'update-cancelled' } },
    ...overrides,
  }
}

async function withServer(service, run) {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-api-'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>test</title>')
  const server = createDashboardServer({
    staticDir: root,
    appOptions: {
      updateService: service,
      env: {},
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

async function security(baseUrl) {
  const response = await fetch(`${baseUrl}/api/app/security-context`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.match(payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/)
  return payload.csrfToken
}

function mutation(baseUrl, path, csrfToken, body = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  })
}

test('GET system update returns only the stable public DTO', async () => {
  const service = makeService()
  await withServer(service, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/app/system-update`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      item: {
        state: 'available',
        currentVersion: '0.1.0',
        availableVersion: '0.2.0',
        progress: 0,
        errorCode: '',
        cancellable: false,
        releaseNotes: '修复更新流程\n<script>alert(1)</script>',
        rollbackReason: 'update-health-check-failed',
      },
    })
    assert.deepEqual(service.calls, [['getStatus']])
  })
})

test('manual check, exact install and cancel call only the injected update service', async () => {
  const service = makeService()
  await withServer(service, async ({ baseUrl }) => {
    const csrfToken = await security(baseUrl)

    const checked = await mutation(baseUrl, '/api/app/system-update/check', csrfToken)
    assert.equal(checked.status, 200)
    assert.equal((await checked.json()).item.state, 'available')

    const installed = await mutation(baseUrl, '/api/app/system-update/install', csrfToken, { expectedVersion: '0.2.0' })
    assert.equal(installed.status, 200)
    assert.equal((await installed.json()).item.state, 'applying')

    const cancelled = await mutation(baseUrl, '/api/app/system-update/cancel', csrfToken)
    assert.equal(cancelled.status, 200)
    assert.deepEqual(await cancelled.json(), { item: { cancelled: true, code: 'update-cancelled' } })

    assert.deepEqual(service.calls, [
      ['check'],
      ['install', { expectedVersion: '0.2.0' }],
      ['cancel'],
    ])
  })
})

test('install requires an exact expectedVersion-only body before calling the service', async () => {
  const service = makeService()
  await withServer(service, async ({ baseUrl }) => {
    const csrfToken = await security(baseUrl)
    for (const body of [
      {},
      { expectedVersion: 2 },
      { expectedVersion: '0.2' },
      { expectedVersion: '0.2.0', manifest: {} },
    ]) {
      const response = await mutation(baseUrl, '/api/app/system-update/install', csrfToken, body)
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: 'update-expected-version-invalid' })
    }
    assert.deepEqual(service.calls, [])
  })
})

test('mutations retain Origin and CSRF guards', async () => {
  const service = makeService()
  await withServer(service, async ({ baseUrl }) => {
    const csrfToken = await security(baseUrl)
    const noOrigin = await fetch(`${baseUrl}/api/app/system-update/check`, {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(noOrigin.status, 403)
    assert.deepEqual(await noOrigin.json(), { error: 'origin-required' })

    const badCsrf = await mutation(baseUrl, '/api/app/system-update/check', 'wrong')
    assert.equal(badCsrf.status, 403)
    assert.deepEqual(await badCsrf.json(), { error: 'csrf-invalid' })
    assert.deepEqual(service.calls, [])
  })
})

test('stable update errors are returned without exposing unknown service failures', async () => {
  const stable = makeService({ async check() { throw updateError('update-operation-in-progress') } })
  await withServer(stable, async ({ baseUrl }) => {
    const response = await mutation(baseUrl, '/api/app/system-update/check', await security(baseUrl))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'update-operation-in-progress' })
  })

  const unavailable = makeService({ async check() { throw updateError('update-unavailable') } })
  await withServer(unavailable, async ({ baseUrl }) => {
    const response = await mutation(baseUrl, '/api/app/system-update/check', await security(baseUrl))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'update-unavailable' })
  })

  const unsafe = makeService({ async check() { throw Object.assign(new Error('password=secret'), { code: 'update-secret-secret' }) } })
  await withServer(unsafe, async ({ baseUrl }) => {
    const response = await mutation(baseUrl, '/api/app/system-update/check', await security(baseUrl))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: 'server-error' })
  })
})

test('system update route rejects unsupported methods and is unavailable without a service', async () => {
  await withServer(undefined, async ({ baseUrl }) => {
    const getResponse = await fetch(`${baseUrl}/api/app/system-update`)
    assert.equal(getResponse.status, 503)
    assert.deepEqual(await getResponse.json(), { error: 'update-unavailable' })
  })

  const service = makeService()
  await withServer(service, async ({ baseUrl }) => {
    const csrfToken = await security(baseUrl)
    const response = await fetch(`${baseUrl}/api/app/system-update`, {
      method: 'PUT',
      headers: { origin: baseUrl, 'x-csrf-token': csrfToken },
    })
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { error: 'method-not-allowed' })
  })
})

test('system update browser route serves the SPA shell', async () => {
  await withServer(makeService(), async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/system-update`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<title>test<\/title>/)
  })
})

test('Dashboard keeps updates offline and unavailable when no trusted public key is configured', async () => {
  let fetchCalls = 0
  const service = createDashboardUpdateService({
    config: { trustedKeys: Object.freeze({}) },
    currentVersion: '0.1.0',
    fetchImpl: async () => { fetchCalls += 1; throw new Error('network-must-not-run') },
  })
  assert.deepEqual(service.getStatus(), {
    state: 'unavailable', currentVersion: '0.1.0', availableVersion: '', progress: 0,
    errorCode: 'update-unavailable', cancellable: false, releaseNotes: '', rollbackReason: '',
  })
  await assert.rejects(service.check(), /update-unavailable/)
  await assert.rejects(service.install({ expectedVersion: '0.2.0' }), /update-unavailable/)
  assert.deepEqual(await service.cancel(), { cancelled: false, code: 'update-not-cancellable' })
  assert.equal(fetchCalls, 0)
})

test('Dashboard shutdown cancels only a cancellable download and never interrupts apply', async () => {
  const calls = []
  const base = {
    disableRealBetting: async () => { calls.push('real-intent') },
    bettingProcess: { stop: async () => {} },
    monitorProcess: { stopAndWait: async () => {}, isRunning: () => false },
    convergeDatabase: async () => {},
    closeHttp: async () => {},
  }
  await shutdownDashboardRuntime({
    ...base,
    updateService: {
      getStatus: () => ({ state: 'downloading', cancellable: true }),
      cancel: async () => { calls.push('cancel-download'); return { cancelled: true } },
    },
  })
  assert.deepEqual(calls.slice(0, 2), ['cancel-download', 'real-intent'])

  calls.length = 0
  await shutdownDashboardRuntime({
    ...base,
    updateService: {
      getStatus: () => ({ state: 'applying', cancellable: false }),
      cancel: async () => { calls.push('cancel-apply') },
    },
  })
  assert.deepEqual(calls, ['real-intent'])
})
