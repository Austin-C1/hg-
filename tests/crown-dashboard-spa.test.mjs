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

test('static server returns React index for app routes and keeps unknown routes 404', async (t) => {
  await withServer(t, async (baseUrl) => {
    for (const route of ['/matches', '/default-leagues', '/monitor-account', '/monitor-alerts', '/betting-rules', '/monitor-settings', '/auto-bet-rules', '/betting-accounts', '/operations']) {
      const response = await fetch(`${baseUrl}${route}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/html/)
      assert.match(await response.text(), /皇冠抓水投注/)
    }

    const missing = await fetch(`${baseUrl}/missing`)
    assert.equal(missing.status, 404)
  })
})
