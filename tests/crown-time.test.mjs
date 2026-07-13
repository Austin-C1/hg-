import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseCrownKickoff,
  parseCrownLiveClock,
} from '../src/crown/monitor/crown-time.mjs'

test('parses GAME_DATE_TIME as Asia/Shanghai and emits UTC', () => {
  assert.deepEqual(parseCrownKickoff({
    gameDateTime: '2026-07-08 21:00:00',
    capturedAt: '2026-07-08T10:00:00.000Z',
  }), {
    raw: '2026-07-08 21:00:00',
    utc: '2026-07-08T13:00:00.000Z',
    local: '2026-07-08 21:00:00',
    timeZone: 'Asia/Shanghai',
    source: 'GAME_DATE_TIME',
    confidence: 'high',
    warnings: [],
  })
})

test('uses historical Asia/Shanghai daylight-saving rules', () => {
  assert.equal(parseCrownKickoff({
    gameDateTime: '1990-07-01 12:00:00',
  }).utc, '1990-07-01T03:00:00.000Z')
})

test('adds the nearest reasonable year to Crown DATETIME across New Year', () => {
  assert.deepEqual(parseCrownKickoff({
    datetime: '12-31 11:30p',
    capturedAt: '2027-01-01T00:10:00.000+08:00',
  }), {
    raw: '12-31 11:30p',
    utc: '2026-12-31T15:30:00.000Z',
    local: '2026-12-31 23:30:00',
    timeZone: 'Asia/Shanghai',
    source: 'DATETIME',
    confidence: 'medium',
    warnings: ['kickoff-year-inferred'],
  })
})

test('can select the next year for Crown DATETIME', () => {
  assert.equal(parseCrownKickoff({
    datetime: '01-01 12:30a',
    capturedAt: '2026-12-31T23:50:00.000+08:00',
  }).utc, '2026-12-31T16:30:00.000Z')
})

test('rejects an inferred DATETIME outside the reasonable fixture window', () => {
  assert.deepEqual(parseCrownKickoff({
    datetime: '01-01 12:00p',
    capturedAt: '2026-07-10T00:00:00.000+08:00',
  }), {
    raw: '01-01 12:00p',
    utc: null,
    local: null,
    timeZone: 'Asia/Shanghai',
    source: null,
    confidence: 'none',
    warnings: ['kickoff-unparsed'],
  })
})

test('handles Crown DATETIME 12-hour boundaries', () => {
  assert.equal(parseCrownKickoff({
    datetime: '07-08 12:00a',
    capturedAt: '2026-07-08T00:00:00.000+08:00',
  }).utc, '2026-07-07T16:00:00.000Z')
  assert.equal(parseCrownKickoff({
    datetime: '07-08 12:00p',
    capturedAt: '2026-07-08T00:00:00.000+08:00',
  }).utc, '2026-07-08T04:00:00.000Z')
})

test('returns an explicit warning instead of throwing for an invalid kickoff', () => {
  assert.deepEqual(parseCrownKickoff({
    gameDateTime: '2026-02-30 21:00:00',
    datetime: 'not-a-time',
    capturedAt: '2026-07-08T10:00:00.000Z',
  }), {
    raw: '2026-02-30 21:00:00',
    utc: null,
    local: null,
    timeZone: 'Asia/Shanghai',
    source: null,
    confidence: 'none',
    warnings: ['kickoff-unparsed'],
  })
})

test('fails closed when the kickoff input itself is invalid', () => {
  assert.deepEqual(parseCrownKickoff(null), {
    raw: null,
    utc: null,
    local: null,
    timeZone: 'Asia/Shanghai',
    source: null,
    confidence: 'none',
    warnings: ['kickoff-unparsed'],
  })
})

test('parses Crown RETIMESET without reading the half number as minutes', () => {
  assert.deepEqual(parseCrownLiveClock('1H^08:00'), {
    raw: '1H^08:00',
    phase: 'first_half',
    elapsedMinute: 8,
    seconds: 0,
    warnings: [],
  })
  assert.deepEqual(parseCrownLiveClock('2H^52:41'), {
    raw: '2H^52:41',
    phase: 'second_half',
    elapsedMinute: 52,
    seconds: 41,
    warnings: [],
  })
})

test('recognizes half-time markers', () => {
  for (const marker of ['HT', 'HALF-TIME', 'Half Time', '中场']) {
    assert.deepEqual(parseCrownLiveClock(marker), {
      raw: marker,
      phase: 'half_time',
      elapsedMinute: null,
      seconds: 0,
      warnings: [],
    })
  }
})

test('fails closed for an ambiguous second-half clock', () => {
  assert.deepEqual(parseCrownLiveClock('2H^08:00'), {
    raw: '2H^08:00',
    phase: 'second_half',
    elapsedMinute: null,
    seconds: 0,
    warnings: ['ambiguous-live-clock'],
  })
})

test('treats 44 as ambiguous and accepts the second-half 45-minute boundary', () => {
  assert.equal(parseCrownLiveClock('2H^44:59').elapsedMinute, null)
  assert.equal(parseCrownLiveClock('2H^45:00').elapsedMinute, 45)
})

test('returns a warning for an unrecognized live clock', () => {
  assert.deepEqual(parseCrownLiveClock('playing'), {
    raw: 'playing',
    phase: null,
    elapsedMinute: null,
    seconds: null,
    warnings: ['live-clock-unparsed'],
  })
})

test('derives the Crown source offset from system_time and parses both DATETIME shapes', () => {
  const context = {
    systemTime: '2026-07-10 05:58:18',
    capturedAt: '2026-07-10T09:58:19.000Z',
  }
  assert.equal(parseCrownKickoff({
    ...context,
    datetime: '07-10 05:30a',
  }).utc, '2026-07-10T09:30:00.000Z')
  assert.equal(parseCrownKickoff({
    ...context,
    datetime: '2026-07-10 05:30:00',
  }).utc, '2026-07-10T09:30:00.000Z')
})

test('fails closed when a provided Crown system_time cannot establish a trustworthy offset', () => {
  assert.equal(parseCrownKickoff({
    systemTime: '2026-07-10 05:58:18',
    capturedAt: '2026-07-12T09:58:19.000Z',
    datetime: '2026-07-10 05:30:00',
  }).utc, null)
})
