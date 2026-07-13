import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import {
  buildChanges,
  buildEvents,
  buildSummary,
  readDashboardChanges,
  readDashboardData,
  readDashboardConfig,
} from '../src/crown/dashboard/dashboard-data.mjs'

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

function v2Snapshot({
  eventKey = 'crown|football|gid=3001',
  mode = 'prematch',
  capturedAt = '2026-07-10T01:00:00.000Z',
  startTimeRaw = null,
  startTimeUtc = null,
  timeConfidence = null,
  timeWarnings = [],
  liveMinute = null,
  warnings = [],
  league = 'Clean v2 League',
  homeTeam = 'Clean Home',
  awayTeam = 'Clean Away',
} = {}) {
  return {
    schemaVersion: 2,
    auditId: `snapshot:${eventKey}`,
    batchId: 'batch-clean-v2',
    pollId: 'poll-clean-v2',
    scopeKey: 'scope-clean-v2',
    observedAt: capturedAt,
    provider: 'crown',
    sport: 'football',
    mode,
    capturedAt,
    event: {
      eventKey,
      league,
      homeTeam,
      awayTeam,
      status: mode === 'live' ? 'live' : 'not_started',
      startTimeRaw,
      startTimeUtc,
      timeConfidence,
      timeWarnings,
      liveMinute,
    },
    market: {
      marketIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R`,
      marketType: 'asian_handicap',
      period: 'full_time',
      lineKey: 'RATIO_R',
      handicapRaw: '+0/0.5',
    },
    selection: {
      selectionIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R|home`,
      side: 'home',
      oddsRaw: '0.94',
      odds: 0.94,
    },
    warnings,
  }
}

function snapshot({ capturedAt, league = '世界杯2026(美加墨)', marketId = 'm1', oddsRaw = '0.94', side = 'home' } = {}) {
  return {
    provider: 'crown',
    mode: 'prematch',
    capturedAt,
    event: {
      league,
      homeTeam: '瑞士',
      awayTeam: '哥伦比亚',
      status: 'not_started',
    },
    market: {
      marketId,
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '+0/0.5',
    },
    selection: {
      selectionId: `${marketId}:${side}`,
      side,
      oddsRaw,
      odds: Number(oddsRaw),
    },
  }
}

test('buildSummary returns source counts, event count, league count, and latest capture time', () => {
  const snapshots = {
    exists: true,
    lineCount: 3,
    parseErrors: 0,
    updatedAt: '2026-07-08T00:00:00.000Z',
    records: [
      snapshot({ capturedAt: '2026-07-08T00:01:00.000Z', marketId: 'm1' }),
      snapshot({ capturedAt: '2026-07-08T00:02:00.000Z', marketId: 'm2' }),
      snapshot({ capturedAt: '2026-07-08T00:03:00.000Z', league: '欧洲冠军联赛外围赛', marketId: 'm3' }),
    ],
  }
  const changes = { exists: true, lineCount: 1, parseErrors: 0, updatedAt: null, records: [{ capturedAt: '2026-07-08T00:04:00.000Z' }] }

  const summary = buildSummary({ snapshots, changes, source: 'runtime-jsonl' })

  assert.equal(summary.readonly, true)
  assert.equal(summary.source, 'runtime-jsonl')
  assert.equal(summary.totals.snapshots, 3)
  assert.equal(summary.totals.changes, 1)
  assert.equal(summary.totals.events, 2)
  assert.equal(summary.totals.leagues, 2)
  assert.equal(summary.lastCapturedAt, '2026-07-08T00:04:00.000Z')
})

test('buildEvents groups by event and keeps the latest odds for each selection key', () => {
  const records = [
    snapshot({ capturedAt: '2026-07-08T00:01:00.000Z', oddsRaw: '0.94' }),
    snapshot({ capturedAt: '2026-07-08T00:02:00.000Z', oddsRaw: '0.96' }),
    snapshot({ capturedAt: '2026-07-08T00:03:00.000Z', marketId: 'm2', oddsRaw: '1.01', side: 'away' }),
  ]

  const events = buildEvents(records)

  assert.equal(events.length, 1)
  assert.equal(events[0].eventKey, 'crown|世界杯2026(美加墨)|瑞士|哥伦比亚|prematch')
  assert.equal(events[0].recordCount, 3)
  assert.equal(events[0].marketCount, 2)
  assert.equal(events[0].selectionCount, 2)
  assert.equal(events[0].lastCapturedAt, '2026-07-08T00:03:00.000Z')
  assert.equal(events[0].markets[0].selections.find((item) => item.side === 'home').oddsRaw, '0.96')
})

test('buildEvents repairs mojibake already stored in runtime snapshots', () => {
  const [event] = buildEvents([v2Snapshot({
    league: '淇勭綏鏂潚骞磋冻鐞冭仈璧汚 U19',
    homeTeam: '鑾柉绉戜腑澶檰鍐沀19',
    awayTeam: '圣彼得堡泽尼特U19',
  })])

  assert.equal(event.league, '俄罗斯青年足球联赛A U19')
  assert.equal(event.homeTeam, '莫斯科中央陆军U19')
  assert.equal(event.awayTeam, '圣彼得堡泽尼特U19')
})

test('buildEvents uses top-level v2 eventIdentity when the nested event key is unavailable', () => {
  const first = v2Snapshot({ eventKey: 'nested-key' })
  const second = structuredClone(first)
  delete first.event.eventKey
  delete second.event.eventKey
  first.eventIdentity = 'canonical-event'
  second.eventIdentity = 'canonical-event'
  second.capturedAt = '2026-07-10T01:01:00.000Z'
  second.selection.selectionIdentity = `${second.market.marketIdentity}|away`

  const [event] = buildEvents([first, second])

  assert.equal(event.eventKey, 'canonical-event')
  assert.equal(event.recordCount, 2)
})

test('buildEvents preserves distinct v2 market and selection identities', () => {
  const first = v2Snapshot({ startTimeUtc: '2026-07-10T03:00:00.000Z' })
  const second = structuredClone(first)
  second.auditId = 'snapshot:second-line'
  second.market.lineKey = 'RATIO_RE'
  second.market.marketIdentity = `${second.event.eventKey}|full_time|asian_handicap|RATIO_RE`
  second.selection.selectionIdentity = `${second.market.marketIdentity}|home`
  second.selection.odds = 0.97
  second.selection.oddsRaw = '0.97'

  const [event] = buildEvents([first, second])

  assert.equal(event.marketCount, 2)
  assert.equal(event.selectionCount, 2)
  assert.deepEqual(event.markets.map((item) => item.marketKey).sort(), [first.market.marketIdentity, second.market.marketIdentity].sort())
})

test('buildEvents keeps the best complete kickoff tuple when newer detail time is empty or invalid', () => {
  const eventKey = 'crown|football|gid=kickoff-merge'
  const list = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:00:00.000Z',
    startTimeRaw: '2026-07-10 21:00:00',
    startTimeUtc: '2026-07-10T13:00:00.000Z',
    timeConfidence: 'high',
  })
  const emptyDetail = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:01:00.000Z',
    startTimeRaw: '',
    startTimeUtc: null,
    timeConfidence: 'none',
    timeWarnings: ['kickoff-unparsed'],
  })
  const invalidDetail = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:02:00.000Z',
    startTimeRaw: 'not-a-time',
    startTimeUtc: '2026-07-10 13:00:00',
    timeConfidence: 'high',
    timeWarnings: ['detail-time-invalid'],
  })

  const [event] = buildEvents([list, emptyDetail, invalidDetail])

  assert.equal(event.startTimeRaw, '2026-07-10 21:00:00')
  assert.equal(event.startTimeUtc, '2026-07-10T13:00:00.000Z')
  assert.equal(event.startTimeBeijing, '2026-07-10 21:00:00')
  assert.equal(event.timeQuality, 'high')
  assert.deepEqual(event.timeWarnings, [])
})

test('buildEvents ranks high above inferred and uses capturedAt only within equal quality', () => {
  const eventKey = 'crown|football|gid=kickoff-quality'
  const olderHigh = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:00:00.000Z',
    startTimeRaw: '2026-07-10 20:00:00',
    startTimeUtc: '2026-07-10T12:00:00.000Z',
    timeConfidence: 'high',
  })
  const newerInferred = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:05:00.000Z',
    startTimeRaw: '07-10 09:00p',
    startTimeUtc: '2026-07-10T13:00:00.000Z',
    timeConfidence: 'medium',
    timeWarnings: ['kickoff-year-inferred'],
  })
  const newestHigh = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:10:00.000Z',
    startTimeRaw: '2026-07-10 22:00:00',
    startTimeUtc: '2026-07-10T14:00:00.000Z',
    timeConfidence: 'high',
    timeWarnings: ['latest-high'],
  })

  const highBeatsInferred = buildEvents([olderHigh, newerInferred])[0]
  assert.equal(highBeatsInferred.startTimeUtc, '2026-07-10T12:00:00.000Z')
  assert.equal(highBeatsInferred.timeQuality, 'high')

  const equalQualityUsesNewest = buildEvents([olderHigh, newestHigh])[0]
  assert.equal(equalQualityUsesNewest.startTimeRaw, '2026-07-10 22:00:00')
  assert.equal(equalQualityUsesNewest.startTimeUtc, '2026-07-10T14:00:00.000Z')
  assert.equal(equalQualityUsesNewest.startTimeBeijing, '2026-07-10 22:00:00')
  assert.deepEqual(equalQualityUsesNewest.timeWarnings, ['latest-high'])
})

test('buildEvents preserves the newest non-empty raw kickoff for invalid-only diagnostics', () => {
  const eventKey = 'crown|football|gid=kickoff-invalid'
  const invalid = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:00:00.000Z',
    startTimeRaw: 'bad-old',
    startTimeUtc: 'not-canonical',
    timeWarnings: ['kickoff-unparsed'],
  })
  const newerInvalid = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:05:00.000Z',
    startTimeRaw: 'bad-new',
    startTimeUtc: '2026-07-10T13:00:00Z',
    timeWarnings: ['newer-invalid'],
  })
  const laterMissing = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:10:00.000Z',
  })

  const [event] = buildEvents([invalid, newerInvalid, laterMissing])

  assert.equal(event.startTimeRaw, 'bad-new')
  assert.equal(event.startTimeUtc, null)
  assert.equal(event.startTimeBeijing, null)
  assert.equal(event.timeQuality, 'invalid')
  assert.deepEqual(event.timeWarnings, ['newer-invalid'])
  assert.deepEqual(event.dataQuality.reasons, ['start_time_invalid'])
})

test('buildEvents does not let a newer raw-less invalid kickoff discard an older diagnostic tuple', () => {
  const eventKey = 'crown|football|gid=kickoff-invalid-rawless'
  const olderWithRaw = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:00:00.000Z',
    startTimeRaw: 'bad-old',
    startTimeUtc: 'not-canonical-old',
    timeWarnings: ['older-with-raw'],
  })
  const newerWithoutRaw = v2Snapshot({
    eventKey,
    capturedAt: '2026-07-10T01:05:00.000Z',
    startTimeRaw: null,
    startTimeUtc: 'not-canonical-new',
    timeWarnings: ['newer-without-raw'],
  })

  const [event] = buildEvents([olderWithRaw, newerWithoutRaw])

  assert.equal(event.startTimeRaw, 'bad-old')
  assert.equal(event.startTimeUtc, null)
  assert.equal(event.startTimeBeijing, null)
  assert.equal(event.timeQuality, 'invalid')
  assert.deepEqual(event.timeWarnings, ['older-with-raw'])
})

test('buildEvents sorts canonical kickoff UTC ascending with null last and eventKey ties stable', () => {
  const records = [
    v2Snapshot({ eventKey: 'event-null', capturedAt: '2026-07-10T01:30:00.000Z' }),
    v2Snapshot({ eventKey: 'event-b', startTimeUtc: '2026-07-10T12:00:00.000Z', timeConfidence: 'high' }),
    v2Snapshot({ eventKey: 'event-c', startTimeUtc: '2026-07-10T11:00:00.000Z', timeConfidence: 'high' }),
    v2Snapshot({ eventKey: 'event-a', startTimeUtc: '2026-07-10T12:00:00.000Z', timeConfidence: 'high' }),
    v2Snapshot({ eventKey: 'event-invalid', startTimeRaw: 'bad', startTimeUtc: '2026-07-10 10:00:00' }),
  ]

  assert.deepEqual(buildEvents(records).map((event) => event.eventKey), [
    'event-c',
    'event-a',
    'event-b',
    'event-invalid',
    'event-null',
  ])
})

test('buildEvents uses the latest event mode so a prematch-to-live transition is not reported as missing kickoff', () => {
  const eventKey = 'crown|football|gid=phase-transition'
  const prematch = v2Snapshot({
    eventKey,
    mode: 'prematch',
    capturedAt: '2026-07-10T01:00:00.000Z',
    warnings: ['start_time_missing'],
  })
  const live = v2Snapshot({
    eventKey,
    mode: 'live',
    capturedAt: '2026-07-10T01:10:00.000Z',
    liveMinute: 12,
  })

  const [event] = buildEvents([prematch, live])

  assert.equal(event.mode, 'live')
  assert.deepEqual(event.dataQuality.reasons, [])
})

test('buildChanges returns newest changes first and applies the default limit', () => {
  const records = Array.from({ length: 105 }, (_, index) => ({
    provider: 'crown',
    mode: 'prematch',
    capturedAt: new Date(Date.UTC(2026, 6, 8, 0, index)).toISOString(),
    old: { oddsRaw: '0.94', odds: 0.94 },
    next: { oddsRaw: index % 2 ? '0.95' : '0.93', odds: index % 2 ? 0.95 : 0.93 },
    event: { league: '世界杯2026(美加墨)', homeTeam: '瑞士', awayTeam: '哥伦比亚' },
    market: { marketType: 'asian_handicap', handicapRaw: '+0/0.5' },
    selection: { side: 'home' },
  }))

  const changes = buildChanges(records)

  assert.equal(changes.length, 100)
  assert.equal(changes[0].capturedAt, records.at(-1).capturedAt)
  assert.equal(changes[0].direction, 'down')
  assert.equal(changes.at(-1).capturedAt, records[5].capturedAt)
})

test('buildChanges can keep one event change history beyond the global recent limit', () => {
  const selected = {
    provider: 'crown',
    mode: 'prematch',
    capturedAt: '2026-07-08T00:00:00.000Z',
    old: { oddsRaw: '0.94', odds: 0.94 },
    next: { oddsRaw: '0.97', odds: 0.97 },
    event: { eventKey: 'event-selected', league: '英超', homeTeam: '主队', awayTeam: '客队' },
    market: { marketType: 'asian_handicap', handicapRaw: '0 / 0.5' },
    selection: { side: 'home' },
  }
  const newerOtherEvents = Array.from({ length: 105 }, (_, index) => ({
    provider: 'crown',
    mode: 'prematch',
    capturedAt: new Date(Date.UTC(2026, 6, 8, 1, index)).toISOString(),
    old: { oddsRaw: '0.94', odds: 0.94 },
    next: { oddsRaw: '0.95', odds: 0.95 },
    event: { eventKey: `event-other-${index}`, league: '西甲', homeTeam: `主队${index}`, awayTeam: `客队${index}` },
    market: { marketType: 'asian_handicap', handicapRaw: '0 / 0.5' },
    selection: { side: 'home' },
  }))

  const changes = buildChanges([selected, ...newerOtherEvents], { limit: 100, eventKey: 'event-selected' })

  assert.equal(changes.length, 1)
  assert.equal(changes[0].eventKey, 'event-selected')
  assert.equal(changes[0].oldOddsRaw, '0.94')
  assert.equal(changes[0].newOddsRaw, '0.97')
})

test('buildChanges exposes before and after handicap values for detail views', () => {
  const changes = buildChanges([{
    provider: 'crown',
    mode: 'prematch',
    capturedAt: '2026-07-08T00:10:00.000Z',
    old: { odds: { raw: '0.94', value: 0.94 }, handicap: { raw: '0 / 0.5', value: 0.25 } },
    next: { odds: { raw: '0.97', value: 0.97 }, handicap: { raw: '0.5 / 1', value: 0.75 } },
    event: { league: '英超', homeTeam: '主队', awayTeam: '客队', eventKey: 'event-1' },
    market: { marketType: 'asian_handicap', period: 'full_time', handicapRaw: '0.5 / 1' },
    selection: { side: 'home' },
  }])

  assert.equal(changes[0].eventKey, 'event-1')
  assert.equal(changes[0].oldHandicapRaw, '0 / 0.5')
  assert.equal(changes[0].newHandicapRaw, '0.5 / 1')
  assert.equal(changes[0].period, 'full_time')
})

test('buildChanges reads nested schema-v2 selection odds and direction', () => {
  const [change] = buildChanges([{
    schemaVersion: 2,
    changeId: 'v2-nested-odds',
    type: 'odds-change',
    observedAt: '2026-07-10T01:01:00.000Z',
    event: { eventKey: 'event-v2', league: 'V2 League' },
    market: { marketType: 'asian_handicap', period: 'full_time', handicapRaw: '+0/0.5' },
    selection: { side: 'home', oddsRaw: '0.94', odds: 0.94 },
    old: {
      market: { handicapRaw: '+0/0.5' },
      selection: { side: 'home', oddsRaw: '0.91', odds: 0.91 },
    },
    next: {
      market: { handicapRaw: '+0/0.5' },
      selection: { side: 'home', oddsRaw: '0.94', odds: 0.94 },
    },
  }])

  assert.equal(change.oldOddsRaw, '0.91')
  assert.equal(change.newOddsRaw, '0.94')
  assert.equal(change.direction, 'up')
})

test('readDashboardConfig reports missing config as structured unavailable state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-config-'))
  const config = await readDashboardConfig(path.join(dir, 'missing.json'))

  assert.equal(config.exists, false)
  assert.equal(config.updatedAt, null)
  assert.equal(config.config, null)
  assert.equal(config.error, 'missing')
})

test('readDashboardData marks fixture fallback when runtime snapshots are empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-origin-'))
  const runtimeSnapshotPath = path.join(dir, 'runtime-snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const fixtureSnapshotPath = path.join(dir, 'fixture-snapshots.jsonl')
  const configPath = path.join(dir, 'monitored-leagues.json')

  fs.writeFileSync(runtimeSnapshotPath, '', 'utf8')
  fs.writeFileSync(changesPath, '', 'utf8')
  fs.writeFileSync(fixtureSnapshotPath, `${JSON.stringify(snapshot({ capturedAt: '2026-07-08T00:01:00.000Z' }))}\n`, 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, include: [], exclude: [] }), 'utf8')

  const data = await readDashboardData({
    snapshotPath: runtimeSnapshotPath,
    changesPath,
    fixtureSnapshotPath,
    configPath,
  })

  assert.equal(data.summary.source, 'fixture-replay')
  assert.equal(data.summary.dataOrigin.kind, 'fixture-fallback')
  assert.equal(data.summary.dataOrigin.isRuntime, false)
  assert.equal(data.summary.dataOrigin.runtime.empty, true)
  assert.ok(data.summary.warnings.includes('snapshots:runtime-empty-fallback'))
})

test('readDashboardData marks XML live source and exposes XML runtime counters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-xml-'))
  const runtimeSnapshotPath = path.join(dir, 'runtime-snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const runtimeLogPath = path.join(dir, 'crown-watch-runtime.jsonl')
  const configPath = path.join(dir, 'monitored-leagues.json')

  fs.writeFileSync(runtimeSnapshotPath, `${JSON.stringify({
    ...snapshot({ capturedAt: '2026-07-08T00:02:00.000Z' }),
    source: { endpointKey: 'POST https://m407.mos077.com/transform.php p=get_game_list', mapperVersion: 'crown-transform-xml-v2', endpointKind: 'get_game_list' },
    event: {
      eventId: '1001',
      eventKey: 'crown|gid=1001|gidm=9001|hgid=1002|ecid=8001|lid=7001',
      league: 'Fixture League',
      homeTeam: 'Alpha FC',
      awayTeam: 'Beta FC',
      status: 'not_started',
    },
    selection: { selectionId: 'local-selection', selectionKey: 'local-selection', oddsId: null, side: 'home', oddsRaw: '0.790', odds: 0.79 },
    warnings: ['crown-transform-xml', 'missing-explicit-odds-id'],
  })}\n`, 'utf8')
  fs.writeFileSync(changesPath, `${JSON.stringify({ type: 'event-added', capturedAt: '2026-07-08T00:02:00.000Z' })}\n`, 'utf8')
  fs.writeFileSync(runtimeLogPath, `${JSON.stringify({
    type: 'xml-response',
    at: '2026-07-08T00:02:01.000Z',
    endpointKind: 'get_game_list',
    xmlResponses: 2,
    getGameListCount: 2,
    getGameMoreCount: 0,
    xmlEvents: 1,
    normalizedRecords: 1,
    snapshotWrites: 1,
    changeWrites: 1,
    parseErrors: 0,
    emptyXmlResponses: 0,
    loginExpiredResponses: 0,
    lastXmlAt: '2026-07-08T00:02:01.000Z',
    lastSnapshotAt: '2026-07-08T00:02:00.000Z',
  })}\n`, 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, include: [], exclude: [] }), 'utf8')

  const data = await readDashboardData({
    snapshotPath: runtimeSnapshotPath,
    changesPath,
    runtimeLogPath,
    configPath,
  })

  assert.equal(data.summary.source, 'xml-live')
  assert.equal(data.summary.dataSource.label, 'XML live')
  assert.equal(data.summary.dataSource.lastXmlAt, '2026-07-08T00:02:01.000Z')
  assert.equal(data.summary.dataSource.xmlResponses, 2)
  assert.equal(data.summary.dataSource.eventCount, 1)
  assert.equal(data.summary.dataSource.recordCount, 1)
  assert.equal(data.summary.dataSource.changeCount, 1)
  assert.equal(data.summary.dataSource.oddsIdAvailable, false)
  assert.equal(data.summary.dataSource.bettingExecution, 'not-connected')
})

test('readDashboardData uses XML live snapshots before DOM fallback snapshots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-xml-priority-'))
  const runtimeSnapshotPath = path.join(dir, 'runtime-snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const runtimeLogPath = path.join(dir, 'crown-watch-runtime.jsonl')
  const configPath = path.join(dir, 'monitored-leagues.json')

  fs.writeFileSync(runtimeSnapshotPath, [
    JSON.stringify({
      ...snapshot({ capturedAt: '2026-07-08T00:01:00.000Z', league: 'DOM League', marketId: 'dom-market' }),
      source: { endpointKey: 'DOM current-page', mapperVersion: 'crown-football-v1' },
      warnings: ['inferred-dom-market'],
    }),
    JSON.stringify({
      ...snapshot({ capturedAt: '2026-07-08T00:02:00.000Z', league: 'XML League', marketId: 'xml-market' }),
      source: { endpointKey: 'POST https://m407.mos077.com/transform.php p=get_game_list', mapperVersion: 'crown-transform-xml-v2', endpointKind: 'get_game_list' },
      warnings: ['crown-transform-xml'],
    }),
  ].join('\n') + '\n', 'utf8')
  fs.writeFileSync(changesPath, '', 'utf8')
  fs.writeFileSync(runtimeLogPath, '', 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, include: [], exclude: [] }), 'utf8')

  const data = await readDashboardData({
    snapshotPath: runtimeSnapshotPath,
    changesPath,
    runtimeLogPath,
    configPath,
  })

  assert.equal(data.summary.source, 'xml-live')
  assert.equal(data.events.items.length, 1)
  assert.equal(data.events.items[0].league, 'XML League')
  assert.equal(data.summary.totals.events, 1)
  assert.equal(data.summary.totals.snapshots, 1)
})

test('v2 audit files are authoritative and never merge contaminated v1 facts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-v2-priority-'))
  const v1SnapshotPath = path.join(dir, 'crown-odds-snapshots.jsonl')
  const v1ChangesPath = path.join(dir, 'crown-odds-changes.jsonl')
  const v2SnapshotPath = path.join(dir, 'crown-odds-snapshots-v2.jsonl')
  const v2ChangesPath = path.join(dir, 'crown-odds-changes-v2.jsonl')
  const clean = v2Snapshot({ warnings: ['start_time_missing'] })
  const liveIncomplete = v2Snapshot({
    eventKey: 'crown|football|gid=3002',
    mode: 'live',
    startTimeUtc: '2026-07-10T00:00:00.000Z',
    liveMinute: null,
    warnings: ['live_clock_missing'],
  })
  writeJsonl(v1SnapshotPath, [snapshot({ capturedAt: '2026-07-08T00:00:00.000Z', league: 'CONTAMINATED V1' })])
  writeJsonl(v1ChangesPath, [{ type: 'event-added', capturedAt: '2026-07-08T00:01:00.000Z', event: { league: 'CONTAMINATED V1' } }])
  writeJsonl(v2SnapshotPath, [clean, liveIncomplete])
  writeJsonl(v2ChangesPath, [{
    schemaVersion: 2,
    changeId: 'a'.repeat(64),
    type: 'odds-change',
    observedAt: '2026-07-10T01:01:00.000Z',
    eventIdentity: clean.event.eventKey,
    event: clean.event,
    market: clean.market,
    selection: clean.selection,
    old: { selection: { odds: 0.91, oddsRaw: '0.91' }, market: clean.market },
    next: { selection: clean.selection, market: clean.market },
    warnings: ['start_time_missing'],
  }])

  const data = await readDashboardData({
    snapshotPath: v1SnapshotPath,
    changesPath: v1ChangesPath,
    v2SnapshotPath,
    v2ChangesPath,
    fixtureSnapshotPath: path.join(dir, 'missing-fixture.jsonl'),
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
    dbPath: path.join(dir, 'missing.sqlite'),
  })

  assert.equal(data.summary.schemaVersion, 2)
  assert.equal(data.events.schemaVersion, 2)
  assert.equal(data.changes.schemaVersion, 2)
  assert.equal(data.events.origin, 'monitor-v2')
  assert.equal(data.changes.origin, 'monitor-v2')
  assert.equal(data.summary.source, 'monitor-v2')
  assert.equal(data.summary.dataOrigin.kind, 'monitor-v2')
  assert.equal(data.summary.totals.events, 2)
  assert.equal(data.summary.totals.changes, 1)
  assert.equal(data.events.items[0].league, 'Clean v2 League')
  assert.equal(JSON.stringify(data).includes('CONTAMINATED V1'), false)
  assert.deepEqual(data.events.items.find((item) => item.mode === 'prematch').dataQuality.reasons, ['start_time_missing'])
  assert.deepEqual(data.changes.items[0].dataQuality.reasons, ['start_time_missing'])
  assert.equal(data.summary.monitorHealth.incompleteData.total, 2)
  assert.equal(data.summary.monitorHealth.incompleteData.byReason.start_time_missing, 1)
  assert.equal(data.summary.monitorHealth.incompleteData.byReason.live_clock_missing, 1)
  assert.deepEqual(data.events.items.find((item) => item.mode === 'live').dataQuality.reasons, ['live_clock_missing'])

  const changesOnly = await readDashboardChanges({
    snapshotPath: v1SnapshotPath,
    changesPath: v1ChangesPath,
    v2SnapshotPath,
    v2ChangesPath,
  })
  assert.equal(changesOnly.schemaVersion, 2)
  assert.equal(changesOnly.source, 'monitor-v2')
  assert.equal(changesOnly.origin, 'monitor-v2')
  assert.equal(changesOnly.items.length, 1)
  assert.equal(JSON.stringify(changesOnly).includes('CONTAMINATED V1'), false)
})

test('monitor diagnostics list each incomplete prematch event identity once and do not flag live kickoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-kickoff-diagnostics-'))
  const v2SnapshotPath = path.join(dir, 'crown-odds-snapshots-v2.jsonl')
  const v2ChangesPath = path.join(dir, 'crown-odds-changes-v2.jsonl')
  const missing = v2Snapshot({
    eventKey: 'event-missing-kickoff',
    league: 'Missing League',
    homeTeam: 'Missing Home',
    awayTeam: 'Missing Away',
    warnings: ['start_time_missing'],
  })
  const duplicateSelection = structuredClone(missing)
  duplicateSelection.selection.selectionIdentity = `${missing.market.marketIdentity}|away`
  duplicateSelection.selection.side = 'away'
  const live = v2Snapshot({
    eventKey: 'event-live-no-kickoff',
    mode: 'live',
    liveMinute: 22,
    league: 'Live League',
    homeTeam: 'Live Home',
    awayTeam: 'Live Away',
  })
  writeJsonl(v2SnapshotPath, [missing, duplicateSelection, live])
  writeJsonl(v2ChangesPath, [])

  const data = await readDashboardData({
    v2SnapshotPath,
    v2ChangesPath,
    dbPath: path.join(dir, 'missing.sqlite'),
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
  })

  assert.equal(data.summary.monitorHealth.incompleteData.total, 1)
  assert.deepEqual(data.summary.monitorHealth.incompleteData.byReason, { start_time_missing: 1 })
  assert.deepEqual(data.summary.monitorHealth.incompleteData.items, [{
    eventKey: 'event-missing-kickoff',
    reason: 'start_time_missing',
    mode: 'prematch',
    league: 'Missing League',
    homeTeam: 'Missing Home',
    awayTeam: 'Missing Away',
  }])
  assert.deepEqual(data.events.items.find((event) => event.eventKey === 'event-live-no-kickoff').dataQuality.reasons, [])
})

test('an existing empty or partially missing v2 generation does not fall back to v1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-v2-empty-'))
  const v1SnapshotPath = path.join(dir, 'crown-odds-snapshots.jsonl')
  const v1ChangesPath = path.join(dir, 'crown-odds-changes.jsonl')
  const v2SnapshotPath = path.join(dir, 'crown-odds-snapshots-v2.jsonl')
  const v2ChangesPath = path.join(dir, 'crown-odds-changes-v2.jsonl')
  writeJsonl(v1SnapshotPath, [snapshot({ capturedAt: '2026-07-08T00:00:00.000Z', league: 'must-not-fallback' })])
  writeJsonl(v1ChangesPath, [{ type: 'event-added', capturedAt: '2026-07-08T00:01:00.000Z' }])
  writeJsonl(v2SnapshotPath, [])

  const data = await readDashboardData({
    snapshotPath: v1SnapshotPath,
    changesPath: v1ChangesPath,
    v2SnapshotPath,
    v2ChangesPath,
    fixtureSnapshotPath: path.join(dir, 'missing-fixture.jsonl'),
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
  })

  assert.equal(data.summary.schemaVersion, 2)
  assert.equal(data.summary.totals.events, 0)
  assert.equal(data.summary.totals.changes, 0)
  assert.equal(data.summary.files.snapshots.exists, true)
  assert.equal(data.summary.files.changes.exists, false)
  assert.equal(JSON.stringify(data).includes('must-not-fallback'), false)
})

test('monitor health uses aggregate state counts and survives missing or old databases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-health-'))
  const dbPath = path.join(dir, 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  try {
    handle.db.prepare(`INSERT INTO monitor_scope_state
      (scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run('scope-today', 'batch-authoritative', '2026-07-10T01:05:00.000Z', '2026-07-10T01:05:00.000Z', '[]')
    handle.db.prepare(`INSERT INTO monitor_event_state
      (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('event-active', 1, 0, '2026-07-10T01:05:00.000Z', '{}', '{"secret":"must-not-leak"}')
    handle.db.prepare(`INSERT INTO monitor_event_state
      (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('event-inactive', 0, 2, '2026-07-10T01:00:00.000Z', '{}', '{}')
    handle.db.prepare(`INSERT INTO monitor_selection_state
      (selection_identity, event_key, captured_at, snapshot_json) VALUES (?, ?, ?, ?)`)
      .run('selection-1', 'event-active', '2026-07-10T01:05:00.000Z', '{"token":"must-not-leak"}')
    handle.db.prepare(`INSERT INTO monitor_signals
      (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('signal-1', 'key-1', 'rule-1', 1, 'matched', '2026-07-10T01:05:00.000Z', '2026-07-10T01:06:00.000Z', '{"cookie":"must-not-leak"}')
    handle.db.prepare(`INSERT INTO monitor_candidates
      (candidate_id, signal_id, status, export_status, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('candidate-1', 'signal-1', 'eligible', 'pending', '2026-07-10T01:05:00.000Z', '{"password":"must-not-leak"}')
    for (const [channel, status] of [['console', 'pending'], ['telegram', 'retry'], ['audit', 'dispatching'], ['email', 'dead-letter'], ['sms', 'sent']]) {
      handle.db.prepare(`INSERT INTO monitor_deliveries
        (signal_id, channel, status, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run('signal-1', channel, status, '2026-07-10T01:05:00.000Z', '2026-07-10T01:05:00.000Z')
    }
  } finally {
    handle.close()
  }

  const emptyV2 = path.join(dir, 'crown-odds-snapshots-v2.jsonl')
  writeJsonl(emptyV2, [])
  const data = await readDashboardData({
    v2SnapshotPath: emptyV2,
    v2ChangesPath: path.join(dir, 'crown-odds-changes-v2.jsonl'),
    dbPath,
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
  })
  assert.deepEqual(data.summary.monitorHealth.state.events, { active: 1, inactive: 1, total: 2 })
  assert.equal(data.summary.monitorHealth.state.selections, 1)
  assert.equal(data.summary.monitorHealth.state.signals, 1)
  assert.equal(data.summary.monitorHealth.state.candidates, 1)
  assert.deepEqual(data.summary.monitorHealth.deliveries, { pending: 3, deadLetter: 1, sent: 1, total: 5 })
  assert.deepEqual(data.summary.monitorHealth.lastAuthoritative, {
    scopeKey: 'scope-today',
    batchId: 'batch-authoritative',
    capturedAt: '2026-07-10T01:05:00.000Z',
    completedAt: '2026-07-10T01:05:00.000Z',
  })
  assert.equal(JSON.stringify(data.summary.monitorHealth).includes('must-not-leak'), false)

  const missing = await readDashboardData({
    v2SnapshotPath: emptyV2,
    v2ChangesPath: path.join(dir, 'missing-changes-v2.jsonl'),
    dbPath: path.join(dir, 'missing.sqlite'),
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
  })
  assert.equal(missing.summary.monitorHealth.available, false)
  assert.equal(missing.summary.monitorHealth.reason, 'database-missing')

  const oldDbPath = path.join(dir, 'old.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const oldDb = new DatabaseSync(oldDbPath)
  oldDb.exec('CREATE TABLE legacy (id TEXT)')
  oldDb.close()
  const old = await readDashboardData({
    v2SnapshotPath: emptyV2,
    v2ChangesPath: path.join(dir, 'missing-changes-v2.jsonl'),
    dbPath: oldDbPath,
    runtimeLogPath: path.join(dir, 'missing-runtime.jsonl'),
  })
  assert.equal(old.summary.monitorHealth.available, false)
  assert.equal(old.summary.monitorHealth.reason, 'schema-unavailable')
})
