import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { handleAppApi } from '../src/crown/app/app-api.mjs'
import { openAppDatabase } from '../src/crown/app/app-db.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-betting-settings-api-')), 'crown.sqlite')
}

async function request(dbPath, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  const response = { statusCode: 0, text: '', writeHead(statusCode) { this.statusCode = statusCode }, end(text) { this.text = text } }
  await handleAppApi(req, response, new URL(pathname, 'http://127.0.0.1'), { dbPath })
  return { statusCode: response.statusCode, payload: JSON.parse(response.text) }
}

test('fixed auto betting GET remains readable as migration evidence', async () => {
  const dbPath = tempDbPath()
  const handle = openAppDatabase({ dbPath, monitorJson: null })
  handle.db.exec("UPDATE auto_betting_settings SET target_odds_min=0.8, target_odds_max=1.1, target_amount_minor=100 WHERE mode='live'")
  handle.close()

  const response = await request(dbPath, 'GET', '/api/app/auto-betting-settings')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(Object.keys(response.payload.items), ['prematch', 'live'])
  assert.equal(response.payload.items.live.targetOddsMin, '0.8')
  assert.equal(response.payload.items.live.targetOddsMax, '1.1')
  assert.equal('waterMoveThreshold' in response.payload.items.live, false)
  assert.deepEqual(Object.keys(response.payload.items.prematch), [
    'mode', 'enabled', 'targetOddsMin', 'targetOddsMax', 'targetAmountMinor', 'currency', 'amountScale',
    'remark', 'realEligible', 'realEligibilityVersion', 'realEligibilityUpdatedAt',
    'migrationReviewRequired', 'migrationReviewReason', 'version', 'createdAt', 'updatedAt',
  ])
})

test('all fixed auto betting PUT payloads return one stable 410 without mutation', async () => {
  const dbPath = tempDbPath()
  const before = await request(dbPath, 'GET', '/api/app/auto-betting-settings')
  for (const mode of ['prematch', 'live']) {
    for (const body of [
      {},
      { expectedVersion: 1 },
      { expectedVersion: 1, enabled: true, secret: 'must-not-be-processed' },
    ]) {
      const response = await request(dbPath, 'PUT', `/api/app/auto-betting-settings/${mode}`, body)
      assert.deepEqual(response, {
        statusCode: 410,
        payload: { error: 'fixed-auto-betting-settings-retired' },
      })
    }
  }
  const after = await request(dbPath, 'GET', '/api/app/auto-betting-settings')
  assert.deepEqual(after.payload, before.payload)
})

test('both legacy rule route families keep GET read-only and retire every mutation before handlers', async () => {
  const dbPath = tempDbPath()
  for (const pathname of ['/api/app/auto-bet-rules', '/api/app/betting-rules']) {
    const listed = await request(dbPath, 'GET', pathname)
    assert.equal(listed.statusCode, 200)
    assert.equal(Array.isArray(listed.payload.items), true)
  }

  const mutations = [
    ['POST', '/api/app/auto-bet-rules'],
    ['POST', '/api/app/auto-bet-rules/reorder'],
    ['PUT', '/api/app/auto-bet-rules/legacy-prematch'],
    ['DELETE', '/api/app/auto-bet-rules/legacy-prematch'],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/clone'],
    ['POST', '/api/app/auto-bet-rules/legacy-prematch/enable-monitor'],
    ['POST', '/api/app/betting-rules'],
    ['PUT', '/api/app/betting-rules/rule-1'],
    ['DELETE', '/api/app/betting-rules/rule-1'],
    ['POST', '/api/app/betting-rules/rule-1/real-eligibility'],
    ['PATCH', '/api/app/betting-rules/rule-1'],
  ]
  for (const [method, pathname] of mutations) {
    const response = await request(dbPath, method, pathname, { forged: 'payload' })
    assert.equal(response.statusCode, 410, `${method} ${pathname}`)
    assert.deepEqual(response.payload, { error: 'rule-api-retired' })
  }
})
