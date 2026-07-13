import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { filterByLeague, isLeagueAllowed } from '../src/crown/filters/league-filter.mjs'

const config = JSON.parse(fs.readFileSync('config/monitored-leagues.json', 'utf8'))

test('allows configured leagues and aliases', () => {
  assert.equal(isLeagueAllowed('世界杯2026(美加墨)', config).allowed, true)
  assert.equal(isLeagueAllowed('今日 世界杯2026 让球', config).allowed, true)
  assert.equal(isLeagueAllowed('欧洲冠军联赛外围赛', config).allowed, true)
})

test('ignores unknown leagues by default', () => {
  const result = isLeagueAllowed('球会友谊赛', config)

  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'default-ignore')
})

test('exclude keywords override include matches', () => {
  const result = isLeagueAllowed('世界杯2026 电竞足球', config)

  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'excluded')
})

test('filters normalized records by event league', () => {
  const records = [
    { event: { league: '世界杯2026(美加墨)' } },
    { event: { league: '巴西乙组联赛' } },
    { event: { league: '欧洲冠军联赛外围赛 虚拟' } },
  ]

  const result = filterByLeague(records, config)

  assert.equal(result.kept.length, 1)
  assert.equal(result.dropped.length, 2)
  assert.equal(result.kept[0].event.league, '世界杯2026(美加墨)')
})
