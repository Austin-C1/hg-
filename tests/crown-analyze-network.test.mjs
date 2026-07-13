import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { analyzeFixture, normalizeUrlPattern } from '../scripts/crown-analyze-network.mjs'

test('normalizes endpoint patterns by removing dynamic query keys', () => {
  const pattern = normalizeUrlPattern('https://example.test/api/matches?ts=1&league=world&nonce=abc&_=')

  assert.equal(pattern, 'example.test/api/matches?league=world')
})

test('groups JSON responses and ranks football odds endpoints', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-analyzer-'))
  fs.mkdirSync(path.join(fixtureDir, 'json-responses'), { recursive: true })

  fs.writeFileSync(
    path.join(fixtureDir, 'network.jsonl'),
    [
      JSON.stringify({
        type: 'response',
        method: 'GET',
        url: 'https://example.test/api/matches?league=world&ts=1',
        status: 200,
        resourceType: 'xhr',
        contentType: 'application/json',
        savedBody: 'json-responses/0001.json',
      }),
      JSON.stringify({
        type: 'response',
        method: 'GET',
        url: 'https://example.test/api/matches?league=world&ts=2',
        status: 200,
        resourceType: 'fetch',
        contentType: 'application/json',
        savedBody: 'json-responses/0002.json',
      }),
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(fixtureDir, 'football-today-filtered.json'),
    JSON.stringify({
      prematch: [
        {
          league: '世界杯2026(美加墨)',
          teams: ['Home 0', 'Away 0'],
        },
      ],
      live: [],
    }),
    'utf8',
  )

  const body = {
    events: Array.from({ length: 20 }, (_, index) => ({
      eventId: `event-${index}`,
      league: '世界杯2026(美加墨)',
      homeTeam: `Home ${index}`,
      awayTeam: `Away ${index}`,
      handicap: '0/0.5',
      odds: index === 0 ? '0.86' : '0.95',
    })),
  }

  fs.writeFileSync(
    path.join(fixtureDir, 'json-responses', '0001.json'),
    JSON.stringify({
      url: 'https://example.test/api/matches?league=world&ts=1',
      method: 'GET',
      status: 200,
      capturedAt: '2026-07-08T00:40:11.000+08:00',
      body,
    }),
    'utf8',
  )
  fs.writeFileSync(
    path.join(fixtureDir, 'json-responses', '0002.json'),
    JSON.stringify({
      url: 'https://example.test/api/matches?league=world&ts=2',
      method: 'GET',
      status: 200,
      capturedAt: '2026-07-08T00:40:12.000+08:00',
      body,
    }),
    'utf8',
  )

  const report = await analyzeFixture(fixtureDir)

  assert.equal(report.candidates[0].endpointKey, 'GET example.test/api/matches?league=world')
  assert.equal(report.candidates[0].responseCount, 2)
  assert.equal(report.candidates[0].classification, 'football-prematch')
  assert.ok(report.candidates[0].score >= 80)
  assert.ok(report.candidates[0].keyPaths.includes('body.events[].league'))
  assert.ok(report.candidates[0].arrayLengths.includes(20))
  assert.ok(fs.existsSync(path.join(fixtureDir, 'endpoint-candidates.json')))
  assert.ok(fs.existsSync(path.join(fixtureDir, 'endpoint-candidates.md')))
})
