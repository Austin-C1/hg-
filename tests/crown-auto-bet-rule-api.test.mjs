import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { handleAppApi } from '../src/crown/app/app-api.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-auto-rule-api-')), 'crown.sqlite')
}

async function request(dbPath, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  let status = 0
  let text = ''
  const res = { writeHead(value) { status = value }, end(chunk = '') { text += String(chunk) } }
  await handleAppApi(req, res, new URL(pathname, 'http://127.0.0.1'), { dbPath })
  return { status, payload: JSON.parse(text) }
}

test('legacy auto-bet rules remain available as sanitized historical read-only DTOs', async () => {
  const response = await request(tempDbPath(), 'GET', '/api/app/auto-bet-rules')
  assert.equal(response.status, 200)
  assert.equal(Array.isArray(response.payload.items), true)
  assert.equal(response.payload.items.length >= 2, true)
  const serialized = JSON.stringify(response.payload)
  for (const forbidden of ['secret', 'providerReference', 'authorization', 'cookie', 'password']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

test('every legacy auto-bet rule mutation returns one stable retired response', async () => {
  const dbPath = tempDbPath()
  const cases = [
    ['POST', '/api/app/auto-bet-rules', {}],
    ['POST', '/api/app/auto-bet-rules/reorder', { items: [] }],
    ['PUT', '/api/app/auto-bet-rules/legacy-prematch', { expectedVersion: 1 }],
    ['DELETE', '/api/app/auto-bet-rules/legacy-prematch', { expectedVersion: 1 }],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/clone', { expectedVersion: 1 }],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/enable-monitor', { expectedVersion: 1 }],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/disable-monitor', { expectedVersion: 1 }],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/enable-real', { expectedVersion: 1 }],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/disable-real', { expectedVersion: 1 }],
  ]
  for (const [method, pathname, body] of cases) {
    const response = await request(dbPath, method, pathname, body)
    assert.equal(response.status, 410, `${method} ${pathname}`)
    assert.deepEqual(response.payload, { error: 'rule-api-retired' })
  }
})
