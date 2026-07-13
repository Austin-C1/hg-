import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { detectEndpoint } from '../src/crown/endpoint-detector.mjs'
import { normalizeFootballResponse } from '../src/crown/normalize-football.mjs'
import { validateNormalizedOddsRecord } from '../src/crown/schema/normalized-odds.schema.mjs'

const fixture = JSON.parse(fs.readFileSync('data/fixtures/crown/20260708_004011/football-today-filtered.json', 'utf8'))
const leagueConfig = JSON.parse(fs.readFileSync('config/monitored-leagues.json', 'utf8'))

function countEventsByMode(records) {
  const byMode = {}
  for (const record of records) {
    byMode[record.mode] ??= new Set()
    byMode[record.mode].add(record.event.eventId)
  }
  return Object.fromEntries(Object.entries(byMode).map(([mode, ids]) => [mode, ids.size]))
}

test('detects DOM football fixture payloads without network access', () => {
  const detected = detectEndpoint({
    metadata: { method: 'LOCAL', url: 'data/fixtures/crown/20260708_004011/football-today-filtered.json' },
    body: fixture,
  })

  assert.equal(detected.detected, true)
  assert.equal(detected.kind, 'dom-football-fixture')
  assert.equal(detected.sport, 'football')
})

test('normalizes fixture records while preserving the raw event baseline where odds exist', () => {
  const records = normalizeFootballResponse({
    body: fixture,
    metadata: { method: 'LOCAL', url: 'football-today-filtered.json', capturedAt: fixture.capturedAt },
  })

  const counts = countEventsByMode(records)
  assert.equal(fixture.counts.prematch, 20)
  assert.equal(fixture.counts.live, 18)
  assert.equal(counts.prematch, 20)
  assert.ok(counts.live >= 17 && counts.live <= 18)
  assert.equal(records.some((record) => record.event.league === '世界杯2026(美加墨)'), true)
  assert.equal(records.some((record) => /电竞|虚拟|virtual|fantasy/i.test(record.event.league)), false)

  const first = records[0]
  assert.equal(first.provider, 'crown')
  assert.equal(first.sport, 'football')
  assert.ok(first.event.league)
  assert.ok(first.event.homeTeam)
  assert.ok(first.event.awayTeam)
  assert.ok(first.event.status)
  assert.ok(first.selection.oddsRaw)
  assert.deepEqual([...new Set(records.map((record) => record.market.marketType))].sort(), ['asian_handicap', 'total'])
  assert.equal(Array.isArray(first.warnings), true)
  assert.deepEqual(validateNormalizedOddsRecord(first), [])
})

test('applies monitored-league filtering after normalization', () => {
  const records = normalizeFootballResponse({
    body: fixture,
    metadata: { method: 'LOCAL', url: 'football-today-filtered.json', capturedAt: fixture.capturedAt },
    leagueConfig,
  })

  const counts = countEventsByMode(records)
  assert.equal(counts.prematch, 10)
  assert.equal(counts.live, 5)
  assert.deepEqual(
    [...new Set(records.map((record) => record.event.league))].sort(),
    ['世界杯2026(美加墨)', '欧洲冠军联赛外围赛'],
  )
})

test('DOM normalization skips records without handicap or total markets', () => {
  const records = normalizeFootballResponse({
    body: {
      capturedAt: '2026-07-08T00:40:11.000+08:00',
      prematch: [
        {
          id: 'event-1',
          mode: 'prematch',
          league: '世界杯2026(美加墨)',
          teams: ['主队'],
          summaryText: '今日 12:00 主队',
          text: '今日 12:00 主队 冷门盘 主 1.23',
        },
      ],
      live: [],
    },
    metadata: { method: 'LOCAL', url: 'synthetic' },
  })

  assert.equal(records.length, 0)
})
