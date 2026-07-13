import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

async function withServer(t, handler, { changes = [], appDbPath = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-server-'))
  const staticDir = path.join(dir, 'public')
  const runtimeDir = path.join(dir, 'runtime')
  const configPath = path.join(dir, 'monitored-leagues.json')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Crown Football Monitor</title>', 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, include: [], exclude: [] }), 'utf8')
  writeJsonl(path.join(runtimeDir, 'crown-odds-snapshots.jsonl'), [{
    provider: 'crown',
    mode: 'prematch',
    capturedAt: '2026-07-08T00:00:00.000Z',
    event: { league: '世界杯2026(美加墨)', homeTeam: '瑞士', awayTeam: '哥伦比亚' },
    market: { marketId: 'm1', marketType: 'asian_handicap', handicapRaw: '+0/0.5' },
    selection: { selectionId: 's1', side: 'home', oddsRaw: '0.94' },
  }])
  writeJsonl(path.join(runtimeDir, 'crown-odds-changes.jsonl'), changes)

  const server = createDashboardServer({
    staticDir,
    appOptions: { dbPath: appDbPath || path.join(dir, 'expected-missing.sqlite') },
    dataOptions: {
      snapshotPath: path.join(runtimeDir, 'crown-odds-snapshots.jsonl'),
      changesPath: path.join(runtimeDir, 'crown-odds-changes.jsonl'),
      configPath,
    },
  })
  t.after(() => server.close())

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await handler(`http://127.0.0.1:${port}`)
}

test('dashboard server exposes read-only JSON APIs and static HTML', async (t) => {
  await withServer(t, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).readonly, true)

    for (const endpoint of ['/api/summary', '/api/events', '/api/changes', '/api/config']) {
      const response = await fetch(`${baseUrl}${endpoint}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      const payload = await response.json()
      assert.equal(typeof payload, 'object')
      if (endpoint === '/api/events') assert.ok(Array.isArray(payload.items))
      if (endpoint === '/api/changes') assert.ok(Array.isArray(payload.items))
    }

    const index = await fetch(`${baseUrl}/`)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type'), /text\/html/)
    assert.match(await index.text(), /Crown Football Monitor/)

    const missing = await fetch(`${baseUrl}/missing`)
    assert.equal(missing.status, 404)
  })
})

test('summary health reads the database path supplied to the dashboard app', async (t) => {
  const missingDbPath = path.join(os.tmpdir(), `crown-dashboard-explicit-missing-${Date.now()}`, 'state.sqlite')
  await withServer(t, async (baseUrl) => {
    const summary = await (await fetch(`${baseUrl}/api/summary`)).json()
    assert.equal(summary.monitorHealth.available, false)
    assert.equal(summary.monitorHealth.reason, 'database-missing')
  }, { appDbPath: missingDbPath })
})

test('changes API can return one event history even when it is outside the global recent limit', async (t) => {
  const selected = {
    provider: 'crown',
    mode: 'prematch',
    capturedAt: '2026-07-08T00:00:00.000Z',
    old: { oddsRaw: '0.94', odds: 0.94 },
    next: { oddsRaw: '0.97', odds: 0.97 },
    event: { eventKey: 'event-selected', league: '英超', homeTeam: '主队', awayTeam: '客队' },
    market: { marketType: 'asian_handicap', handicapRaw: '0 / 0.5' },
    selection: { side: 'home' },
  }
  const newerOtherEvents = Array.from({ length: 105 }, (_, index) => ({
    provider: 'crown',
    mode: 'prematch',
    capturedAt: new Date(Date.UTC(2026, 6, 8, 1, index)).toISOString(),
    old: { oddsRaw: '0.94', odds: 0.94 },
    next: { oddsRaw: '0.95', odds: 0.95 },
    event: { eventKey: `event-other-${index}`, league: '西甲', homeTeam: `主队${index}`, awayTeam: `客队${index}` },
    market: { marketType: 'asian_handicap', handicapRaw: '0 / 0.5' },
    selection: { side: 'home' },
  }))

  await withServer(t, async (baseUrl) => {
    const globalPayload = await (await fetch(`${baseUrl}/api/changes`)).json()
    assert.equal(globalPayload.items.some((item) => item.eventKey === 'event-selected'), false)

    const selectedPayload = await (await fetch(`${baseUrl}/api/changes?eventKey=event-selected&limit=1000`)).json()
    assert.equal(selectedPayload.items.length, 1)
    assert.equal(selectedPayload.items[0].eventKey, 'event-selected')
    assert.equal(selectedPayload.items[0].newOddsRaw, '0.97')
  }, { changes: [selected, ...newerOtherEvents] })
})
