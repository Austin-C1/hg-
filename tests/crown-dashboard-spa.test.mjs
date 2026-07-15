import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

async function withServer(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-spa-'))
  const staticDir = path.join(dir, 'dist')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>皇冠抓水投注</title><div id="root"></div>', 'utf8')

  const server = createDashboardServer({ staticDir })
  t.after(() => server.close())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await handler(`http://127.0.0.1:${server.address().port}`)
}

test('static server returns React index for every client route and keeps API or asset misses 404', async (t) => {
  await withServer(t, async (baseUrl) => {
    for (const route of ['/matches', '/default-leagues', '/monitor-account', '/monitor-alerts', '/betting-rules', '/monitor-settings', '/auto-bet-rules', '/betting-accounts', '/betting-history', '/operations']) {
      const response = await fetch(`${baseUrl}${route}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/html/)
      assert.match(await response.text(), /皇冠抓水投注/)
    }

    const restoredTab = await fetch(`${baseUrl}/restored-browser-tab`)
    assert.equal(restoredTab.status, 200)
    assert.match(restoredTab.headers.get('content-type'), /text\/html/)

    assert.equal((await fetch(`${baseUrl}/api/missing`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/assets/missing.js`)).status, 404)
  })
})
