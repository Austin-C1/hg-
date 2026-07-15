import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import {
  buildGameMoreTargets,
  classifyCrownSessionState,
  createRuntimeConfigState,
  parseJsonPayload,
  reloadRuntimeConfig,
  safeReloadRuntimeConfig,
  runDomPollOnce,
  runFixtureWatch,
  shouldAutoRelogin,
} from '../scripts/crown-watch.mjs'

test('direct API watch builds get_game_more targets with tracked matches first', () => {
  const liveTracked = {
    mode: 'live',
    event: {
      eventKey: 'event-live-tracked',
      status: 'live',
      ids: { lid: '101', ecid: '201' },
    },
  }
  const prematchUntracked = {
    mode: 'prematch',
    event: {
      eventKey: 'event-prematch',
      status: 'not_started',
      ids: { lid: '102', ecid: '202' },
    },
  }
  const liveUntracked = {
    mode: 'live',
    event: {
      eventKey: 'event-live',
      status: 'live',
      ids: { lid: '103', ecid: '203' },
    },
  }

  const targets = buildGameMoreTargets([prematchUntracked, liveUntracked, liveTracked, liveTracked], {
    trackedMatches: [{ eventKey: 'event-live-tracked', trackingStatus: 'active' }],
    maxTargets: 2,
  })

  assert.deepEqual(targets.map((target) => target.eventKey), ['event-live-tracked', 'event-live'])
  assert.equal(targets[0].showtype, 'live')
  assert.equal(targets[0].isRB, 'Y')
  assert.equal(targets[0].tracked, true)
})

test('direct API watch game_more targets preserve the hot prematch list scope', () => {
  const prematch = {
    mode: 'prematch',
    event: {
      eventKey: 'event-prematch-hot',
      status: 'not_started',
      ids: { lid: '102', ecid: '202' },
    },
  }

  const [target] = buildGameMoreTargets([prematch], {
    maxTargets: 1,
    prematchShowtype: 'hot',
  })

  assert.equal(target.showtype, 'hot')
  assert.equal(target.isRB, 'N')
})

test('watch fixture mode writes runtime snapshot and change files without browser actions', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-'))
  const stats = await runFixtureWatch({
    fixtureDir: 'data/fixtures/crown/20260708_004011',
    runtimeDir,
    leagueConfigPath: 'config/monitored-leagues.json',
  })

  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots.jsonl')
  const changesPath = path.join(runtimeDir, 'crown-odds-changes.jsonl')
  assert.ok(fs.existsSync(snapshotsPath))
  assert.ok(fs.existsSync(changesPath))
  assert.equal(fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).length, stats.normalizedRecords)
  assert.ok(stats.normalizedRecords > stats.filteredRecords)
  assert.equal(stats.filteredRecords, 60)
  assert.equal(stats.oddsChanges, 0)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')), false)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')), false)
})

test('watch fixture mode can replay transform XML fixtures and report XML counters', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-xml-'))
  const stats = await runFixtureWatch({
    fixtureDir: 'data/fixtures/crown/transform-xml',
    runtimeDir,
    leagueConfigPath: '',
  })

  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots.jsonl')
  const runtimeLogPath = path.join(runtimeDir, 'crown-watch-runtime.jsonl')
  const snapshots = fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const logs = fs.readFileSync(runtimeLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

  assert.equal(stats.xmlResponses, 5)
  assert.equal(stats.getGameListCount, 4)
  assert.equal(stats.getGameMoreCount, 1)
  assert.equal(stats.loginExpiredResponses, 1)
  assert.equal(stats.parseErrors, 1)
  assert.equal(stats.xmlEvents >= 1, true)
  assert.equal(stats.normalizedRecords, snapshots.length)
  assert.equal(stats.snapshotWrites, snapshots.length)
  assert.equal(stats.lastXmlAt !== null, true)
  assert.equal(logs.some((row) => row.type === 'xml-response'), true)
  assert.equal(snapshots.every((record) => record.selection.oddsId === null), true)
})

test('XML snapshots are written for dashboard even when monitored league filter keeps none', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-xml-unfiltered-'))
  const leagueConfigPath = path.join(runtimeDir, 'monitored-leagues.json')
  fs.writeFileSync(leagueConfigPath, JSON.stringify({
    enabled: true,
    defaultAction: 'ignore',
    include: [{ name: '不存在的联赛', match: 'exact' }],
    exclude: [],
  }), 'utf8')

  const stats = await runFixtureWatch({
    fixtureDir: 'data/fixtures/crown/transform-xml',
    runtimeDir,
    leagueConfigPath,
  })

  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots.jsonl')
  const snapshots = fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

  assert.ok(stats.normalizedRecords > 0)
  assert.equal(stats.filteredRecords, 0)
  assert.equal(snapshots.length, stats.normalizedRecords)
  assert.equal(snapshots.some((record) => record.source.mapperVersion?.startsWith('crown-transform-xml')), true)
})

test('DOM poll mode extracts current page events, normalizes them, and writes JSONL', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-dom-'))
  const fixture = JSON.parse(fs.readFileSync('data/fixtures/crown/20260708_004011/football-today-filtered.json', 'utf8'))
  const page = {
    async evaluate(extractor) {
      assert.equal(typeof extractor, 'function')
      return {
        capturedAt: fixture.capturedAt,
        url: 'https://m321.mos077.com/',
        title: 'Welcome',
        viewport: { width: 1440, height: 960, scrollX: 0, scrollY: 0 },
        localStorage: [],
        sessionStorage: [],
        bodyText: '',
        candidates: [],
        containers: [],
        eventCards: [...fixture.prematch, ...fixture.live],
      }
    },
  }

  const stats = await runDomPollOnce({
    page,
    runtimeDir,
    leagueConfigPath: 'config/monitored-leagues.json',
  })

  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots.jsonl')
  const lines = fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/)
  const first = JSON.parse(lines[0])

  assert.equal(lines.length, stats.normalizedRecords)
  assert.equal(stats.domPolls, 1)
  assert.equal(stats.domEvents, 38)
  assert.ok(stats.normalizedRecords > stats.filteredRecords)
  assert.equal(stats.filteredRecords, 60)
  assert.match(first.source.endpointKey, /^DOM /)
  assert.ok(first.warnings.includes('inferred-dom-market'))
})

test('DOM poll alerts for manually tracked matches outside the default league whitelist', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-manual-alert-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const monitorSettingsPath = path.join(runtimeDir, 'monitor-settings.json')
  const defaultLeaguesPath = path.join(runtimeDir, 'default-leagues.json')
  const telegramSettingsPath = path.join(runtimeDir, 'telegram-settings.json')
  const alertsConfigPath = path.join(runtimeDir, 'alerts.json')
  const bettingCandidatesPath = path.join(runtimeDir, 'betting-candidates.jsonl')
  const fixture = JSON.parse(fs.readFileSync('data/fixtures/crown/20260708_004011/football-today-filtered.json', 'utf8'))
  const baseEvent = {
    ...fixture.prematch[0],
    id: 'manual-alert-event',
    league: '美国足球乙组联赛',
    teams: ['主队', '客队'],
    summaryText: '今日 16:00 主队 客队',
    text: '今日 16:00 主队 客队 让球 +0/0.5 0.94 -0/0.5 0.95 大/小 大 2/2.5 1.03 小 2/2.5 0.85',
  }
  const eventKey = 'dom|event=manual-alert-event|league=美国足球乙组联赛|home=主队|away=客队|mode=prematch'

  fs.writeFileSync(defaultLeaguesPath, JSON.stringify({ version: 1, leagues: [] }), 'utf8')
  fs.writeFileSync(telegramSettingsPath, JSON.stringify({
    version: 1,
    oddsAlert: { enabled: false, botToken: '', chatIds: [] },
    betSuccess: { enabled: false, botToken: '', chatIds: [] },
  }), 'utf8')
  fs.writeFileSync(alertsConfigPath, JSON.stringify({ console: { enabled: false } }), 'utf8')
  fs.writeFileSync(monitorSettingsPath, JSON.stringify({
    version: 1,
    runningMode: 'handicap',
    handicap: {
      enabled: true,
      activePeriods: ['prematch'],
      minOdds: 0,
      maxOdds: 2,
      waterMoveThreshold: 0.01,
      waterMoveDirection: 'both',
      cooldownSeconds: 0,
      prematchStartMinutesBeforeKickoff: 999,
      prematchStopMinutesBeforeKickoff: 0,
    },
    live: { enabled: false },
  }), 'utf8')

  const handle = openAppDatabase({ dbPath })
  try {
    const repo = createAppRepository(handle.db, { secretKey: 'watch-test-secret-key-with-more-than-32-chars' })
    repo.trackMatch({
      eventKey,
      league: '美国足球乙组联赛',
      homeTeam: '主队',
      awayTeam: '客队',
      mode: 'prematch',
      sourceStatus: 'xml-live',
      tracked: true,
    })
    repo.createBettingRule({
      name: '报警候选规则',
      enabled: true,
      leagueNames: ['美国足球乙组联赛'],
      targetAmount: '50.00',
      currency: 'CNY',
      amountScale: 2,
      changedOddsMin: 0.5,
      changedOddsMax: 2,
      direction: 'up_reverse',
    })
  } finally {
    handle.close()
  }

  const pageFor = (event) => ({
    async evaluate(extractor) {
      assert.equal(typeof extractor, 'function')
      return {
        capturedAt: '2026-07-08T08:00:00.000Z',
        url: 'https://m321.mos077.com/',
        title: 'Football',
        viewport: { width: 1440, height: 960, scrollX: 0, scrollY: 0 },
        localStorage: [],
        sessionStorage: [],
        bodyText: event.text,
        candidates: [],
        containers: [],
        eventCards: [event],
      }
    },
  })

  await runDomPollOnce({
    page: pageFor(baseEvent),
    runtimeDir,
    leagueConfigPath: '',
    defaultLeaguesPath,
    monitorSettingsPath,
    telegramSettingsPath,
    alertsConfigPath,
    appDbPath: dbPath,
    bettingCandidatesPath,
  })
  const stats = await runDomPollOnce({
    page: pageFor({ ...baseEvent, text: baseEvent.text.replace('0.94', '0.99') }),
    runtimeDir,
    leagueConfigPath: '',
    defaultLeaguesPath,
    monitorSettingsPath,
    telegramSettingsPath,
    alertsConfigPath,
    appDbPath: dbPath,
    bettingCandidatesPath,
  })

  assert.equal(stats.oddsChanges > 0, true)
  assert.equal(stats.alertTriggers, 1)
  assert.equal(stats.skippedAlerts.league_not_allowed || 0, 0)
  assert.equal(JSON.parse(fs.readFileSync(monitorSettingsPath, 'utf8')).prematch.lastAlertAt, '2026-07-08T08:00:00.000Z')

  assert.equal(fs.existsSync(bettingCandidatesPath), true)
  const candidates = fs.readFileSync(bettingCandidatesPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].source, 'monitor-alert')
  assert.equal(candidates[0].status, 'eligible')
  assert.equal(candidates[0].betDirectionMode, 'auto')
  assert.equal(candidates[0].action, 'reverse')
  assert.equal(JSON.stringify(candidates).includes('FT_bet'), false)
})

test('WebSocket non-JSON frames are ignored instead of treated as watcher errors', () => {
  assert.equal(parseJsonPayload('ping'), null)
  assert.equal(parseJsonPayload(''), null)
})

test('DOM poll writes page health status and warns after consecutive empty pages', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-health-'))
  const originalWarn = console.warn
  const warnings = []
  console.warn = (message) => warnings.push(String(message))
  const page = {
    async evaluate() {
      return {
        capturedAt: '2026-07-08T00:00:00.000Z',
        url: 'https://m321.mos077.com/',
        title: 'Welcome',
        viewport: { width: 1440, height: 960, scrollX: 0, scrollY: 0 },
        localStorage: [],
        sessionStorage: [],
        bodyText: 'loading',
        candidates: [],
        containers: [],
        eventCards: [],
      }
    },
  }

  let stats
  try {
    stats = await runDomPollOnce({
      page,
      runtimeDir,
      zeroDomWarnAfter: 1,
    })
  } finally {
    console.warn = originalWarn
  }

  const runtimeLogPath = path.join(runtimeDir, 'crown-watch-runtime.jsonl')
  const log = JSON.parse(fs.readFileSync(runtimeLogPath, 'utf8').trim())
  assert.equal(stats.domPolls, 1)
  assert.equal(stats.zeroDomWarnings, 1)
  assert.equal(warnings.length, 1)
  assert.equal(log.type, 'dom-poll')
  assert.equal(log.pageTitle, 'Welcome')
  assert.equal(log.urlHost, 'm321.mos077.com')
  assert.equal(log.eventCards, 0)
  assert.equal(log.normalizedRecords, 0)
  assert.equal(log.filteredRecords, 0)
  assert.equal(log.changes, 0)
  assert.equal(log.errors, 0)
  assert.equal(log.pageHealth.isWelcome, true)
  assert.equal(log.pageHealth.isLoading, true)
  assert.equal(log.pageHealth.isFootballPage, false)
  assert.ok(log.warnings.includes('dom-events-empty:1'))
})

test('Crown session classifier pauses on human verification and caps auto relogin at three attempts', () => {
  assert.equal(
    classifyCrownSessionState({ title: 'Login', url: 'https://example.test', bodyText: 'captcha slider verification' }).status,
    '等待人工验证码',
  )
  assert.equal(
    classifyCrownSessionState({ title: 'Welcome', url: 'https://example.test/Welcome', bodyText: 'Welcome' }).status,
    'Welcome 页面',
  )
  assert.equal(shouldAutoRelogin({ status: 'Welcome 页面', autoReloginCount: 2, maxAutoReloginCount: 3 }), true)
  assert.equal(shouldAutoRelogin({ status: 'Welcome 页面', autoReloginCount: 3, maxAutoReloginCount: 3 }), false)
  assert.equal(shouldAutoRelogin({ status: '等待人工验证码', autoReloginCount: 0, maxAutoReloginCount: 3 }), false)
})

test('runtime config reload picks up monitored league file changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-config-'))
  const leagueConfigPath = path.join(dir, 'monitored-leagues.json')
  fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['世界杯2026(美加墨)'], exclude: [] }), 'utf8')

  const state = createRuntimeConfigState({ leagueConfigPath })
  assert.deepEqual(state.current.leagueConfig.include, ['世界杯2026(美加墨)'])

  await new Promise((resolve) => setTimeout(resolve, 5))
  fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['欧洲冠军联赛外围赛'], exclude: [] }), 'utf8')

  const result = reloadRuntimeConfig(state)
  assert.equal(result.changed, true)
  assert.deepEqual(state.current.leagueConfig.include, ['欧洲冠军联赛外围赛'])
})

test('runtime config reload detects content changes when the filesystem mtime does not advance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-config-mtime-'))
  const leagueConfigPath = path.join(dir, 'monitored-leagues.json')
  const originalStatSync = fs.statSync
  const fixedMtime = originalStatSync(leagueConfigPath, { throwIfNoEntry: false })?.mtimeMs ?? 123
  fs.statSync = (target, ...args) => {
    const metadata = originalStatSync(target, ...args)
    if (path.resolve(String(target)) !== path.resolve(leagueConfigPath)) return metadata
    return new Proxy(metadata, {
      get(value, property) {
        return property === 'mtimeMs' ? fixedMtime : Reflect.get(value, property, value)
      },
    })
  }
  try {
    fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['League A'], exclude: [] }), 'utf8')
    const state = createRuntimeConfigState({ leagueConfigPath })
    fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['League B'], exclude: [] }), 'utf8')

    const result = reloadRuntimeConfig(state)
    assert.equal(result.changed, true)
    assert.deepEqual(state.current.leagueConfig.include, ['League B'])
  } finally {
    fs.statSync = originalStatSync
  }
})

test('safe runtime config reload keeps last-known-good state after malformed JSON and retries later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-safe-config-'))
  const leagueConfigPath = path.join(dir, 'monitored-leagues.json')
  fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['League A'], exclude: [] }), 'utf8')
  const state = createRuntimeConfigState({ leagueConfigPath })
  const originalCurrent = structuredClone(state.current)
  const originalMtimes = { ...state.mtimes }
  const records = []
  const logger = { log(record) { records.push(record) }, error(record) { records.push(record) } }

  await new Promise((resolve) => setTimeout(resolve, 5))
  fs.writeFileSync(leagueConfigPath, '{partial "token":"secret-value"', 'utf8')
  const failed = safeReloadRuntimeConfig(state, logger)
  assert.deepEqual(failed, { changed: false, ok: false, errorCode: 'invalid-json' })
  assert.deepEqual(state.current, originalCurrent)
  assert.deepEqual(state.mtimes, originalMtimes)
  assert.equal(records.at(-1).type, 'config-reload-error')
  assert.equal(records.at(-1).errorCode, 'invalid-json')
  assert.doesNotMatch(JSON.stringify(records), /secret-value|partial|token/i)

  await new Promise((resolve) => setTimeout(resolve, 5))
  fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['League B'], exclude: [] }), 'utf8')
  const recovered = safeReloadRuntimeConfig(state, logger)
  assert.equal(recovered.ok, true)
  assert.equal(recovered.changed, true)
  assert.deepEqual(state.current.leagueConfig.include, ['League B'])
  assert.notDeepEqual(state.mtimes, originalMtimes)
  assert.equal(records.at(-1).type, 'config-reload')

  await new Promise((resolve) => setTimeout(resolve, 5))
  fs.writeFileSync(leagueConfigPath, JSON.stringify({ enabled: true, include: ['League C'], exclude: [] }), 'utf8')
  const withBrokenLogger = safeReloadRuntimeConfig(state, { log() { throw new Error('logger unavailable') } })
  assert.equal(withBrokenLogger.ok, true)
  assert.equal(withBrokenLogger.changed, true)
  assert.deepEqual(state.current.leagueConfig.include, ['League C'])
})
