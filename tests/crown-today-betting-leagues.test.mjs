import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { buildTodayBettingLeagues } from '../src/crown/betting/today-betting-leagues.mjs'

const FIXTURE_TIMESTAMP = '2026-07-12T04:00:00.000Z'

function createDb() {
  return openAppDatabase({ dbPath: ':memory:', monitorJson: null })
}

function seedEvent(db, { eventKey, league, startTimeUtc, mode = 'prematch', active = 1 }) {
  db.prepare(`
    INSERT INTO monitor_event_state (
      event_key, match_group_key, active, missing_count, last_seen_at,
      provider_ids_json, event_json
    ) VALUES (?, ?, ?, 0, ?, '{}', ?)
  `).run(
    eventKey,
    eventKey,
    active,
    startTimeUtc || FIXTURE_TIMESTAMP,
    JSON.stringify({ eventKey, league, startTimeUtc, mode }),
  )
}

function seedTracked(db, { eventKey, league = 'unused', trackingStatus = 'active' }) {
  db.prepare(`
    INSERT INTO tracked_matches (
      event_key, league, home_team, away_team, mode, source_status,
      tracking_status, created_at, updated_at
    ) VALUES (?, ?, 'Home', 'Away', 'prematch', '', ?, ?, ?)
  `).run(eventKey, league, trackingStatus, FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP)
}

const defaultLeagues = {
  leagues: [
    { name: '英超', enabled: true, modes: ['prematch'] },
    { name: '西甲', enabled: false, modes: ['prematch', 'live'] },
    { name: '德甲', enabled: true, modes: ['live'] },
  ],
}

test('catalog contains today default hits and exact today manual tracking only', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, { eventKey: 'today-default', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'today-manual', league: '友谊赛', startTimeUtc: '2026-07-12T05:00:00.000Z', mode: 'live' })
    seedEvent(handle.db, { eventKey: 'tomorrow', league: '意甲', startTimeUtc: '2026-07-12T16:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'unrelated-same-league', league: '友谊赛', startTimeUtc: '2026-07-12T06:00:00.000Z' })
    seedTracked(handle.db, { eventKey: 'today-manual' })
    seedTracked(handle.db, { eventKey: 'missing-event', league: '友谊赛' })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [
      { leagueName: '英超', source: 'default', todayMatchCount: 1 },
      { leagueName: '友谊赛', source: 'manual', todayMatchCount: 1 },
    ])
  } finally {
    handle.close()
  }
})

test('catalog treats the currently open Crown event set as today across the Beijing date boundary', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, {
      eventKey: 'crown-today-beijing-tomorrow',
      league: '英超',
      startTimeUtc: '2026-07-12T16:00:00.000Z',
    })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [
      { leagueName: '英超', source: 'default', todayMatchCount: 1 },
    ])
  } finally {
    handle.close()
  }
})

test('catalog honors default enabled and exact mode and ignores inactive events and tracked rows', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, { eventKey: 'disabled-default', league: '西甲', startTimeUtc: '2026-07-12T02:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'wrong-mode', league: '德甲', startTimeUtc: '2026-07-12T03:00:00.000Z', mode: 'prematch' })
    seedEvent(handle.db, { eventKey: 'inactive-event', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000Z', active: 0 })
    seedEvent(handle.db, { eventKey: 'inactive-tracked', league: '友谊赛', startTimeUtc: '2026-07-12T05:00:00.000Z' })
    seedTracked(handle.db, { eventKey: 'inactive-tracked', trackingStatus: 'inactive' })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [])
  } finally {
    handle.close()
  }
})

test('catalog merges default and manual source and counts each event once', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, { eventKey: 'both', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'default-only', league: '英超', startTimeUtc: '2026-07-12T05:00:00.000Z' })
    seedTracked(handle.db, { eventKey: 'both' })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [
      { leagueName: '英超', source: 'both', todayMatchCount: 2 },
    ])
  } finally {
    handle.close()
  }
})

test('catalog includes every active Crown event regardless of the Beijing kickoff date', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, { eventKey: 'before', league: '英超', startTimeUtc: '2026-07-11T15:59:59.999Z' })
    seedEvent(handle.db, { eventKey: 'start', league: '英超', startTimeUtc: '2026-07-11T16:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'end', league: '英超', startTimeUtc: '2026-07-12T15:59:59.999Z' })
    seedEvent(handle.db, { eventKey: 'after', league: '英超', startTimeUtc: '2026-07-12T16:00:00.000Z' })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [
      { leagueName: '英超', source: 'default', todayMatchCount: 4 },
    ])
  } finally {
    handle.close()
  }
})

test('catalog does not require kickoff time when the active Crown state proves the market is open', () => {
  const handle = createDb()
  try {
    seedEvent(handle.db, { eventKey: 'canonical', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'no-zone', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000' })
    seedEvent(handle.db, { eventKey: 'date-only', league: '英超', startTimeUtc: '2026-07-12' })
    seedEvent(handle.db, { eventKey: 'offset-zone', league: '英超', startTimeUtc: '2026-07-12T04:00:00.000+00:00' })
    seedEvent(handle.db, { eventKey: 'missing-millis', league: '英超', startTimeUtc: '2026-07-12T04:00:00Z' })
    seedEvent(handle.db, { eventKey: 'normalized-invalid-date', league: '英超', startTimeUtc: '2026-02-30T04:00:00.000Z' })
    seedEvent(handle.db, { eventKey: 'invalid', league: '英超', startTimeUtc: 'not-a-date' })
    seedEvent(handle.db, { eventKey: 'missing', league: '英超', startTimeUtc: null })

    assert.deepEqual(buildTodayBettingLeagues({ db: handle.db, defaultLeagues }), [
      { leagueName: '英超', source: 'default', todayMatchCount: 8 },
    ])
  } finally {
    handle.close()
  }
})
