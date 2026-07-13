import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'
import { APP_CONTRACT_VERSION } from '../src/crown/app/app-contract-version.mjs'
import { createDashboardUpdateHealthProvider } from '../scripts/crown-dashboard.mjs'

const PROBE = 'P'.repeat(43)

async function serverFixture(t, appOptions) {
  const server = createDashboardServer({ appOptions })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

function status() {
  return {
    watcher: { state: 'stopped' },
    realBetting: { requested: false, state: 'off' },
    capability: { preview: 0, submit: 0, reconciliation: 0 },
  }
}

test('candidate update health is hidden unless candidate mode and exact probe are both present', async (t) => {
  const base = await serverFixture(t, {
    installationId: 'install-fixture',
    env: {
      CROWN_UPDATE_CANDIDATE: '1',
      CROWN_UPDATE_PROBE_TOKEN: PROBE,
      CROWN_APP_VERSION: '0.2.0',
    },
    updateHealthProvider: () => status(),
  })
  assert.equal((await fetch(`${base}/api/health/update`)).status, 404)
  assert.equal((await fetch(`${base}/api/health/update`, {
    headers: { 'x-crown-update-probe': 'Q'.repeat(43) },
  })).status, 404)
  const response = await fetch(`${base}/api/health/update`, {
    headers: { 'x-crown-update-probe': PROBE },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    appId: 'crown-monitor',
    version: '0.2.0',
    appContractVersion: APP_CONTRACT_VERSION,
    installationId: 'install-fixture',
    probeToken: PROBE,
    ...status(),
  })
})

test('ordinary dashboard never exposes candidate health even with a supplied probe', async (t) => {
  let called = false
  const base = await serverFixture(t, {
    installationId: 'install-fixture',
    env: { CROWN_UPDATE_PROBE_TOKEN: PROBE, CROWN_APP_VERSION: '0.1.0' },
    updateHealthProvider: () => { called = true; return status() },
  })
  const response = await fetch(`${base}/api/health/update`, {
    headers: { 'x-crown-update-probe': PROBE },
  })
  assert.equal(response.status, 404)
  assert.equal(called, false)
})

test('candidate health fails closed when canonical runtime status is unsafe or malformed', async (t) => {
  for (const unsafe of [
    { ...status(), watcher: { state: 'running' } },
    { ...status(), realBetting: { requested: true, state: 'off' } },
    { ...status(), capability: { preview: 0, submit: 1, reconciliation: 0 } },
    { watcher: { state: 'stopped' } },
  ]) {
    const base = await serverFixture(t, {
      installationId: 'install-fixture',
      env: { CROWN_UPDATE_CANDIDATE: '1', CROWN_UPDATE_PROBE_TOKEN: PROBE, CROWN_APP_VERSION: '0.2.0' },
      updateHealthProvider: () => unsafe,
    })
    const response = await fetch(`${base}/api/health/update`, {
      headers: { 'x-crown-update-probe': PROBE },
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'update-health-unsafe' })
  }
})

test('production provider derives watcher, worker, durable real state, and canonical capabilities', async () => {
  let watcherRunning = false
  let workerRunning = false
  let closed = false
  const provider = createDashboardUpdateHealthProvider({
    dbPath: 'fixture.sqlite',
    env: {},
    monitorProcess: { isRunning: () => watcherRunning },
    bettingProcess: { isRunning: () => workerRunning },
    openDatabase: () => ({ db: {}, close: () => { closed = true } }),
    readRealBetting: () => ({ requested: false, state: 'off' }),
    readCapabilities: () => [{ previewAllowed: false, submitAllowed: false, reconciliationAllowed: false }],
  })
  assert.deepEqual(await provider(), status())
  assert.equal(closed, true)

  watcherRunning = true
  workerRunning = true
  assert.deepEqual(await provider(), {
    watcher: { state: 'running' },
    realBetting: { requested: true, state: 'running' },
    capability: { preview: 0, submit: 0, reconciliation: 0 },
  })
})
