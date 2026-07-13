import assert from 'node:assert/strict'
import test from 'node:test'

import { buildLeagueSummaries } from '../src/crown/dashboard/league-aggregation.mjs'

const defaultLeagues = {
  leagues: [
    {
      name: '世界杯2026(美加墨)',
      aliases: ['世界杯2026'],
      enabled: true,
      autoTrack: true,
      modes: ['prematch', 'live'],
    },
  ],
}

test('league summaries aggregate current events without expanding matches by default', () => {
  const events = [
    {
      eventKey: 'e1',
      league: '世界杯2026(美加墨)',
      homeTeam: '瑞士',
      awayTeam: '哥伦比亚',
      mode: 'prematch',
      status: 'not_started',
      selectionCount: 14,
      lastCapturedAt: '2026-07-08T00:01:00.000Z',
    },
    {
      eventKey: 'e2',
      league: '世界杯2026(美加墨)',
      homeTeam: '阿根廷',
      awayTeam: '埃及',
      mode: 'live',
      status: 'live',
      selectionCount: 7,
      lastCapturedAt: '2026-07-08T00:02:00.000Z',
    },
    {
      eventKey: 'e3',
      league: '英超',
      homeTeam: '主队',
      awayTeam: '客队',
      mode: 'prematch',
      status: 'not_started',
      selectionCount: 10,
      lastCapturedAt: '2026-07-08T00:03:00.000Z',
    },
  ]
  const trackedMatches = [{ eventKey: 'e3', league: '英超', trackingStatus: 'active' }]

  const summaries = buildLeagueSummaries(events, trackedMatches, defaultLeagues)

  assert.equal(summaries.length, 2)
  assert.deepEqual(
    summaries.find((item) => item.league === '世界杯2026(美加墨)'),
    {
      league: '世界杯2026(美加墨)',
      prematchEventCount: 1,
      liveEventCount: 1,
      totalOddsCount: 21,
      inDefaultWhitelist: true,
      defaultAutoTracked: true,
      tracked: true,
      trackingSource: 'default',
      lastCapturedAt: '2026-07-08T00:02:00.000Z',
      events: events.slice(0, 2),
    },
  )
  assert.equal(summaries.find((item) => item.league === '英超').tracked, true)
  assert.equal(summaries.find((item) => item.league === '英超').trackingSource, 'manual')
})
