import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_MONITOR_SETTINGS,
  evaluateChangeCandidate,
  evaluateMonitorChange,
  legacyMonitorRules,
  normalizeMonitorSettings,
  readMonitorSettings,
  startMonitorMode,
  stopMonitorMode,
  writeMonitorSettings,
} from '../src/crown/monitor/monitor-settings.mjs'

function completeLegacySettings(overrides = {}) {
  return {
    version: 1,
    runningMode: 'handicap',
    handicap: {
      enabled: true,
      activePeriods: ['prematch'],
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.04,
      waterMoveDirection: 'up',
      cooldownSeconds: 45,
      prematchStartMinutesBeforeKickoff: 120,
      prematchStopMinutesBeforeKickoff: 8,
      remark: 'prematch legacy',
      lastAlertAt: '2026-07-10T01:00:00.000Z',
      stoppedReason: '',
      bettingRuleId: 'bet-prematch',
    },
    live: {
      enabled: false,
      minOdds: 0.7,
      maxOdds: 1.3,
      waterMoveThreshold: 0.05,
      waterMoveDirection: 'down',
      cooldownSeconds: 90,
      liveMinuteFrom: 10,
      liveMinuteTo: 75,
      includeFirstHalf: true,
      includeSecondHalf: true,
      includeHalfTime: false,
      remark: 'live legacy',
      lastAlertAt: null,
      stoppedReason: '因另一个模式启动而关闭',
      bettingRuleId: 'bet-live',
    },
    ...overrides,
  }
}

test('version 2 settings expose only independent prematch and live cards', () => {
  assert.equal(DEFAULT_MONITOR_SETTINGS.version, 2)
  assert.deepEqual(Object.keys(DEFAULT_MONITOR_SETTINGS).sort(), ['live', 'prematch', 'version'])
  assert.equal(Object.hasOwn(DEFAULT_MONITOR_SETTINGS, 'runningMode'), false)
  assert.equal(Object.hasOwn(DEFAULT_MONITOR_SETTINGS, 'handicap'), false)
  assert.equal(Object.hasOwn(DEFAULT_MONITOR_SETTINGS.prematch, 'activePeriods'), false)

  const normalized = normalizeMonitorSettings(DEFAULT_MONITOR_SETTINGS)
  assert.deepEqual(normalized, DEFAULT_MONITOR_SETTINGS)
  assert.deepEqual(normalizeMonitorSettings(normalized), normalized)
})

test('legacy version 1 migrates every prematch field and never exposes old keys', () => {
  const migrated = normalizeMonitorSettings(completeLegacySettings())
  assert.deepEqual(migrated, {
    version: 2,
    prematch: {
      enabled: true,
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.04,
      waterMoveDirection: 'up',
      cooldownSeconds: 45,
      startMinutesBeforeKickoff: 120,
      stopMinutesBeforeKickoff: 8,
      remark: 'prematch legacy',
      lastAlertAt: '2026-07-10T01:00:00.000Z',
      stoppedReason: '',
      bettingRuleId: 'bet-prematch',
    },
    live: {
      enabled: false,
      minOdds: 0.7,
      maxOdds: 1.3,
      waterMoveThreshold: 0.05,
      waterMoveDirection: 'down',
      cooldownSeconds: 90,
      liveMinuteFrom: 10,
      liveMinuteTo: 75,
      includeFirstHalf: true,
      includeSecondHalf: true,
      includeHalfTime: false,
      remark: 'live legacy',
      lastAlertAt: null,
      stoppedReason: '',
      bettingRuleId: 'bet-live',
    },
  })
})

test('legacy mutual-stop reasons are cleared for both target modes', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.stoppedReason = '因另一个模式启动而关闭'
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.stoppedReason, '')
  assert.equal(migrated.live.stoppedReason, '')
})

test('legacy file migration saves version 2 and repeated reads are idempotent', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-settings-v2-')), 'settings.json')
  fs.writeFileSync(file, JSON.stringify(completeLegacySettings()), 'utf8')
  const migrated = await readMonitorSettings(file)
  const saved = await writeMonitorSettings(file, migrated)
  const reread = await readMonitorSettings(file)
  assert.deepEqual(saved, migrated)
  assert.deepEqual(reread, migrated)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['live', 'prematch', 'version'])
})

test('legacy handicap live source falls back to published live-window defaults', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['live']
  delete legacy.live
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, false)
  assert.equal(migrated.live.enabled, true)
  assert.equal(migrated.live.waterMoveThreshold, 0.04)
  assert.equal(migrated.live.liveMinuteFrom, 10)
  assert.equal(migrated.live.liveMinuteTo, 75)
  assert.equal(migrated.live.bettingRuleId, 'bet-prematch')
})

test('legacy handicap live source does not require prematch kickoff fields', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['live']
  delete legacy.handicap.prematchStartMinutesBeforeKickoff
  delete legacy.handicap.prematchStopMinutesBeforeKickoff
  delete legacy.live
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, false)
  assert.match(migrated.prematch.stoppedReason, /复核/)
  assert.equal(migrated.live.enabled, true)
  assert.equal(migrated.live.waterMoveThreshold, 0.04)
  assert.equal(migrated.live.bettingRuleId, 'bet-prematch')
})

test('independent complete legacy live card migrates without a handicap card', () => {
  const legacy = completeLegacySettings()
  legacy.live.enabled = true
  delete legacy.handicap
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, false)
  assert.match(migrated.prematch.stoppedReason, /复核/)
  assert.equal(migrated.live.enabled, true)
  assert.equal(migrated.live.waterMoveThreshold, 0.05)
  assert.equal(migrated.live.bettingRuleId, 'bet-live')
})

test('independent complete legacy live card ignores invalid handicap periods', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['invalid-period']
  legacy.live.enabled = true
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, false)
  assert.match(migrated.prematch.stoppedReason, /复核/)
  assert.equal(migrated.live.enabled, true)
  assert.equal(migrated.live.stoppedReason, '')
})

test('legacy live with no independent card or explicit handicap live source closes for review', () => {
  const legacy = completeLegacySettings()
  delete legacy.live
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.live.enabled, false)
  assert.match(migrated.live.stoppedReason, /复核/)
})

test('conflicting legacy live sources close live for review', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['prematch', 'live']
  legacy.live.enabled = true
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, true)
  assert.equal(migrated.live.enabled, false)
  assert.match(migrated.live.stoppedReason, /复核/)
})

test('explicit handicap live conflicts with a disabled but complete live card', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['prematch', 'live']
  legacy.live.enabled = false
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.live.enabled, false)
  assert.match(migrated.live.stoppedReason, /复核/)
})

test('matching legacy live sources can enable together', () => {
  const legacy = completeLegacySettings()
  legacy.handicap.activePeriods = ['prematch', 'live']
  legacy.live = {
    ...legacy.live,
    enabled: true,
    minOdds: legacy.handicap.minOdds,
    maxOdds: legacy.handicap.maxOdds,
    waterMoveThreshold: legacy.handicap.waterMoveThreshold,
    waterMoveDirection: legacy.handicap.waterMoveDirection,
    cooldownSeconds: legacy.handicap.cooldownSeconds,
  }
  const migrated = normalizeMonitorSettings(legacy)
  assert.equal(migrated.prematch.enabled, true)
  assert.equal(migrated.live.enabled, true)
})

test('missing or invalid legacy fields close affected modes for review', () => {
  const missing = completeLegacySettings()
  delete missing.handicap.waterMoveThreshold
  const missingResult = normalizeMonitorSettings(missing)
  assert.equal(missingResult.prematch.enabled, false)
  assert.match(missingResult.prematch.stoppedReason, /复核/)

  const invalid = completeLegacySettings()
  invalid.live.enabled = 'true'
  const invalidResult = normalizeMonitorSettings(invalid)
  assert.equal(invalidResult.live.enabled, false)
  assert.match(invalidResult.live.stoppedReason, /复核/)
})

test('invalid version 2 booleans numbers directions and windows fail closed', async (t) => {
  const cases = [
    ['enabled boolean', { prematch: { enabled: 'true' } }],
    ['threshold number', { prematch: { waterMoveThreshold: 'bad' } }],
    ['direction', { prematch: { waterMoveDirection: 'flat' } }],
    ['empty odds number', { prematch: { minOdds: '' } }],
    ['odds range', { prematch: { minOdds: 1.2, maxOdds: 0.8 } }],
    ['kickoff window', { prematch: { startMinutesBeforeKickoff: 5, stopMinutesBeforeKickoff: 10 } }],
    ['live phase boolean', { live: { includeFirstHalf: 1 } }],
    ['live minute window', { live: { liveMinuteFrom: 80, liveMinuteTo: 75 } }],
  ]
  for (const [name, patch] of cases) {
    await t.test(name, () => {
      const settings = structuredClone(DEFAULT_MONITOR_SETTINGS)
      const mode = patch.prematch ? 'prematch' : 'live'
      Object.assign(settings[mode], patch[mode], { enabled: patch[mode].enabled ?? true })
      const normalized = normalizeMonitorSettings(settings)
      assert.equal(normalized[mode].enabled, false)
      assert.match(normalized[mode].stoppedReason, /复核/)
    })
  }
})

test('prematch and live start and stop independently with handicap as input-only alias', () => {
  const prematch = startMonitorMode(DEFAULT_MONITOR_SETTINGS, 'handicap')
  const both = startMonitorMode(prematch, 'live')
  assert.equal(both.prematch.enabled, true)
  assert.equal(both.live.enabled, true)
  assert.deepEqual(Object.keys(both).sort(), ['live', 'prematch', 'version'])

  const liveOnly = stopMonitorMode(both, 'handicap')
  assert.equal(liveOnly.prematch.enabled, false)
  assert.equal(liveOnly.live.enabled, true)
})

test('both enabled cards project stable fixed-market strategy rules', () => {
  const settings = structuredClone(DEFAULT_MONITOR_SETTINGS)
  settings.prematch.enabled = true
  settings.prematch.bettingRuleId = 'bet-prematch'
  settings.live.enabled = true
  settings.live.bettingRuleId = 'bet-live'
  const rules = legacyMonitorRules(settings)
  assert.deepEqual(rules.map((rule) => rule.id), [
    'legacy-monitor-prematch-odds-delta',
    'legacy-monitor-live-odds-delta',
  ])
  assert.deepEqual(rules.map((rule) => rule.scope.modes), [['prematch'], ['live']])
  assert.deepEqual(rules.map((rule) => rule.scope.markets), [
    ['asian_handicap', 'total'],
    ['asian_handicap', 'total'],
  ])
  assert.deepEqual(rules.map((rule) => rule.bettingRuleId), ['bet-prematch', 'bet-live'])
})

test('simultaneous modes evaluate their own thresholds independently', () => {
  const settings = structuredClone(DEFAULT_MONITOR_SETTINGS)
  settings.prematch.enabled = true
  settings.prematch.waterMoveThreshold = 0.04
  settings.live.enabled = true
  settings.live.waterMoveThreshold = 0.1
  assert.equal(evaluateMonitorChange(change(), { settings }).triggered, true)
  assert.equal(
    evaluateMonitorChange(change({ mode: 'live', event: { ...change().event, clock: "20'" } }), { settings }).skipReason,
    'water_move_below_threshold',
  )
})

function change(overrides = {}) {
  return {
    capturedAt: '2026-07-08T10:00:00.000Z',
    old: { oddsRaw: '0.94', odds: 0.94, capturedAt: '2026-07-08T09:59:00.000Z' },
    next: { oddsRaw: '0.99', odds: 0.99, capturedAt: '2026-07-08T10:00:00.000Z' },
    event: {
      eventId: 'event-1',
      league: '世界杯2026(美加墨)',
      homeTeam: '瑞士',
      awayTeam: '哥伦比亚',
      startTimeUtc: '2026-07-08T12:00:00.000Z',
      clock: null,
      status: 'not_started',
    },
    market: { marketId: 'market-1', marketType: 'asian_handicap', period: 'full_time' },
    selection: { selectionId: 'selection-1', side: 'home', oddsRaw: '0.99', odds: 0.99 },
    mode: 'prematch',
    ...overrides,
  }
}

test('starting one monitor mode leaves the other mode unchanged', () => {
  const startedHandicap = startMonitorMode(normalizeMonitorSettings({}), 'handicap')
  assert.equal(startedHandicap.prematch.enabled, true)
  assert.equal(startedHandicap.live.enabled, false)

  const startedLive = startMonitorMode(startedHandicap, 'live')
  assert.equal(startedLive.live.enabled, true)
  assert.equal(startedLive.prematch.enabled, true)

  const stopped = stopMonitorMode(startedLive, 'live')
  assert.equal(stopped.live.enabled, false)
  assert.equal(stopped.prematch.enabled, true)
})

test('prematch handicap monitor skips events outside configured kickoff window', () => {
  const settings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      prematchStartMinutesBeforeKickoff: 180,
      prematchStopMinutesBeforeKickoff: 5,
      waterMoveThreshold: 0.02,
    },
  }), 'handicap')

  assert.equal(evaluateMonitorChange(change(), { settings, now: '2026-07-08T10:00:00.000Z' }).triggered, true)
  assert.equal(
    evaluateMonitorChange(change(), { settings, now: '2026-07-08T08:00:00.000Z' }).skipReason,
    'prematch_time_out_of_range',
  )
})

test('live monitor enforces live minute limits and missing clock handling', () => {
  const settings = startMonitorMode(normalizeMonitorSettings({
    live: {
      liveMinuteFrom: 10,
      liveMinuteTo: 75,
      waterMoveThreshold: 0.02,
    },
  }), 'live')

  assert.equal(evaluateMonitorChange(change({ mode: 'live', event: { ...change().event, clock: "12'" } }), { settings }).triggered, true)
  assert.equal(
    evaluateMonitorChange(change({ mode: 'live', event: { ...change().event, clock: "3'" } }), { settings }).skipReason,
    'live_minute_out_of_range',
  )
  assert.equal(
    evaluateMonitorChange(change({ mode: 'live', event: { ...change().event, clock: null } }), { settings }).skipReason,
    'live_clock_missing',
  )
})

test('water move threshold, direction, odds range, and cooldown can suppress alerts', () => {
  const settings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.04,
      waterMoveDirection: 'up',
      cooldownSeconds: 60,
    },
  }), 'handicap')
  const cooldownState = new Map()

  assert.equal(evaluateMonitorChange(change({ old: { oddsRaw: '0.94', odds: 0.94 }, next: { oddsRaw: '0.96', odds: 0.96 } }), { settings }).skipReason, 'water_move_below_threshold')
  assert.equal(evaluateMonitorChange(change({ old: { oddsRaw: '0.99', odds: 0.99 }, next: { oddsRaw: '0.94', odds: 0.94 } }), { settings }).skipReason, 'water_move_below_threshold')
  assert.equal(evaluateMonitorChange(change({ next: { oddsRaw: '1.4', odds: 1.4 } }), { settings }).skipReason, 'odds_out_of_range')

  const first = evaluateMonitorChange(change(), { settings, cooldownState })
  assert.equal(first.triggered, true)
  assert.equal(evaluateMonitorChange(change(), { settings, cooldownState }).skipReason, 'cooldown_active')
})

test('monitor evaluation records default league skip reasons', () => {
  const settings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      waterMoveThreshold: 0.02,
    },
  }), 'handicap')

  assert.equal(
    evaluateMonitorChange(change(), { settings, defaultLeagues: { leagues: [] } }).skipReason,
    'league_not_allowed',
  )
  assert.equal(
    evaluateMonitorChange(change(), {
      settings,
      defaultLeagues: { leagues: [{ name: '世界杯2026(美加墨)', aliases: [], enabled: false, autoTrack: true, modes: ['prematch'] }] },
    }).skipReason,
    'default_league_disabled',
  )
})

test('manual tracked matches can trigger alerts outside the default league whitelist', () => {
  const settings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      waterMoveThreshold: 0.02,
    },
  }), 'handicap')
  const trackedChange = change({
    event: {
      ...change().event,
      eventKey: 'manual-event-1',
      league: '美国足球乙组联赛',
      homeTeam: '主队',
      awayTeam: '客队',
    },
  })

  assert.equal(
    evaluateMonitorChange(trackedChange, {
      settings,
      defaultLeagues: { leagues: [] },
      trackedMatches: [{
        eventKey: 'manual-event-1',
        league: '美国足球乙组联赛',
        homeTeam: '主队',
        awayTeam: '客队',
        mode: 'prematch',
        trackingStatus: 'active',
      }],
    }).triggered,
    true,
  )
  assert.equal(
    evaluateMonitorChange(trackedChange, {
      settings,
      defaultLeagues: { leagues: [] },
      trackedMatches: [{
        eventKey: 'manual-event-1',
        league: '美国足球乙组联赛',
        homeTeam: '主队',
        awayTeam: '客队',
        mode: 'prematch',
        trackingStatus: 'inactive',
      }],
    }).skipReason,
    'league_not_allowed',
  )
})

test('monitor settings drop max tracking limits and expose threshold candidate decisions', () => {
  const normalized = normalizeMonitorSettings({
    handicap: {
      maxTrackedLeagues: 2,
      maxTrackedEvents: 5,
      waterMoveThreshold: 0.04,
      waterMoveDirection: 'up',
    },
  })

  assert.equal(Object.hasOwn(normalized.prematch, 'maxTrackedLeagues'), false)
  assert.equal(Object.hasOwn(normalized.prematch, 'maxTrackedEvents'), false)

  const settings = startMonitorMode(normalized, 'handicap')
  assert.deepEqual(
    evaluateChangeCandidate(change({
      old: { oddsRaw: '0.94', odds: 0.94 },
      next: { oddsRaw: '0.99', odds: 0.99 },
    }), { settings }),
    {
      candidate: true,
      reason: 'threshold_reached',
      monitorMode: 'prematch',
      delta: 0.05,
      direction: 'up',
      threshold: 0.04,
    },
  )
  assert.equal(
    evaluateChangeCandidate(change({
      old: { oddsRaw: '0.94', odds: 0.94 },
      next: { oddsRaw: '0.97', odds: 0.97 },
    }), { settings }).candidate,
    false,
  )
})
