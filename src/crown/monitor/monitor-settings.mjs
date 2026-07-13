import { readJsonConfig, writeJsonConfig } from '../config/json-config.mjs'
import { isDefaultLeagueMatched } from '../config/default-leagues.mjs'

export const MONITOR_SETTINGS_PATH = 'config/monitor-settings.json'

const STOPPED_BY_OTHER = '因另一个模式启动而关闭'
const MIGRATION_REVIEW_REASON = '旧监控配置存在缺失、非法或冲突，请复核后重新启用'

export const DEFAULT_MONITOR_SETTINGS = {
  version: 2,
  prematch: {
    enabled: false,
    minOdds: null,
    maxOdds: null,
    waterMoveThreshold: 0.03,
    waterMoveDirection: 'both',
    cooldownSeconds: 60,
    startMinutesBeforeKickoff: 180,
    stopMinutesBeforeKickoff: 5,
    remark: '',
    lastAlertAt: null,
    stoppedReason: '',
    bettingRuleId: null,
  },
  live: {
    enabled: false,
    minOdds: null,
    maxOdds: null,
    waterMoveThreshold: 0.03,
    waterMoveDirection: 'both',
    cooldownSeconds: 60,
    liveMinuteFrom: 10,
    liveMinuteTo: 75,
    includeFirstHalf: true,
    includeSecondHalf: true,
    includeHalfTime: false,
    remark: '',
    lastAlertAt: null,
    stoppedReason: '',
    bettingRuleId: null,
  },
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function validBoolean(value) {
  return typeof value === 'boolean'
}

function finiteNumber(value, { nullable = false, nonNegative = false } = {}) {
  if (nullable && value === null) return { valid: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { valid: false, value: null }
  if (nonNegative && value < 0) return { valid: false, value: null }
  return { valid: true, value }
}

function readNumber(source, key, fallback, options = {}) {
  if (!own(source, key)) return { valid: false, value: fallback }
  const result = finiteNumber(source[key], options)
  return { valid: result.valid, value: result.valid ? result.value : fallback }
}

function readOptionalString(source, key, fallback = '') {
  if (!own(source, key)) return fallback
  return cleanString(source[key])
}

function readLastAlertAt(source) {
  if (!own(source, 'lastAlertAt') || source.lastAlertAt === null || source.lastAlertAt === '') return null
  return cleanString(source.lastAlertAt) || null
}

function commonCard(source, defaults) {
  const minOdds = readNumber(source, 'minOdds', defaults.minOdds, { nullable: true, nonNegative: true })
  const maxOdds = readNumber(source, 'maxOdds', defaults.maxOdds, { nullable: true, nonNegative: true })
  const threshold = readNumber(source, 'waterMoveThreshold', defaults.waterMoveThreshold, { nonNegative: true })
  const cooldown = readNumber(source, 'cooldownSeconds', defaults.cooldownSeconds, { nonNegative: true })
  const directionValid = own(source, 'waterMoveDirection') && ['up', 'down', 'both'].includes(source.waterMoveDirection)
  const enabledValid = own(source, 'enabled') && validBoolean(source.enabled)
  const rangeValid = minOdds.value === null || maxOdds.value === null || minOdds.value <= maxOdds.value
  return {
    card: {
      enabled: enabledValid ? source.enabled : false,
      minOdds: minOdds.value,
      maxOdds: maxOdds.value,
      waterMoveThreshold: threshold.value,
      waterMoveDirection: directionValid ? source.waterMoveDirection : defaults.waterMoveDirection,
      cooldownSeconds: cooldown.value,
      remark: readOptionalString(source, 'remark'),
      lastAlertAt: readLastAlertAt(source),
      stoppedReason: readOptionalString(source, 'stoppedReason'),
      bettingRuleId: readOptionalString(source, 'bettingRuleId') || null,
    },
    valid: enabledValid && minOdds.valid && maxOdds.valid && rangeValid
      && threshold.valid && directionValid && cooldown.valid,
  }
}

function normalizePrematchCard(source, { legacy = false } = {}) {
  const defaults = DEFAULT_MONITOR_SETTINGS.prematch
  const common = commonCard(source, defaults)
  const startKey = legacy ? 'prematchStartMinutesBeforeKickoff' : 'startMinutesBeforeKickoff'
  const stopKey = legacy ? 'prematchStopMinutesBeforeKickoff' : 'stopMinutesBeforeKickoff'
  const start = readNumber(source, startKey, defaults.startMinutesBeforeKickoff, { nonNegative: true })
  const stop = readNumber(source, stopKey, defaults.stopMinutesBeforeKickoff, { nonNegative: true })
  const valid = common.valid && start.valid && stop.valid && start.value >= stop.value
  return {
    card: {
      ...common.card,
      enabled: valid ? common.card.enabled : false,
      startMinutesBeforeKickoff: start.value,
      stopMinutesBeforeKickoff: stop.value,
      stoppedReason: valid ? common.card.stoppedReason : MIGRATION_REVIEW_REASON,
    },
    valid,
  }
}

function normalizeLiveCard(source, { allowPublishedWindowDefaults = false } = {}) {
  const defaults = DEFAULT_MONITOR_SETTINGS.live
  const common = commonCard(source, defaults)
  const number = (key) => {
    if (allowPublishedWindowDefaults && !own(source, key)) return { valid: true, value: defaults[key] }
    return readNumber(source, key, defaults[key], { nonNegative: true })
  }
  const bool = (key) => {
    if (allowPublishedWindowDefaults && !own(source, key)) return { valid: true, value: defaults[key] }
    return { valid: own(source, key) && validBoolean(source[key]), value: validBoolean(source[key]) ? source[key] : defaults[key] }
  }
  const from = number('liveMinuteFrom')
  const to = number('liveMinuteTo')
  const first = bool('includeFirstHalf')
  const second = bool('includeSecondHalf')
  const halfTime = bool('includeHalfTime')
  const valid = common.valid && from.valid && to.valid && from.value <= to.value
    && first.valid && second.valid && halfTime.valid
  return {
    card: {
      ...common.card,
      enabled: valid ? common.card.enabled : false,
      liveMinuteFrom: from.value,
      liveMinuteTo: to.value,
      includeFirstHalf: first.value,
      includeSecondHalf: second.value,
      includeHalfTime: halfTime.value,
      stoppedReason: valid ? common.card.stoppedReason : MIGRATION_REVIEW_REASON,
    },
    valid,
  }
}

function validLegacyPeriods(source) {
  if (!own(source, 'activePeriods') || !Array.isArray(source.activePeriods)) return null
  if (source.activePeriods.some((mode) => !['prematch', 'live'].includes(mode))) return null
  return [...new Set(source.activePeriods)]
}

function sameCommonParameters(left, right) {
  return ['minOdds', 'maxOdds', 'waterMoveThreshold', 'waterMoveDirection', 'cooldownSeconds']
    .every((key) => left[key] === right[key])
}

function migrateLegacySettings(source) {
  const handicapSource = object(source.handicap) ? source.handicap : null
  const liveSource = object(source.live) ? source.live : null
  const periods = handicapSource ? validLegacyPeriods(handicapSource) : null
  const legacyHandicapCommon = handicapSource
    ? commonCard(handicapSource, DEFAULT_MONITOR_SETTINGS.prematch)
    : { card: structuredClone(DEFAULT_MONITOR_SETTINGS.prematch), valid: false }
  const legacyPrematch = handicapSource
    ? normalizePrematchCard(handicapSource, { legacy: true })
    : { card: structuredClone(DEFAULT_MONITOR_SETTINGS.prematch), valid: false }
  const prematchValid = legacyPrematch.valid && periods !== null
  const prematch = {
    ...legacyPrematch.card,
    enabled: prematchValid ? legacyPrematch.card.enabled && periods.includes('prematch') : false,
    stoppedReason: prematchValid
      ? (legacyPrematch.card.stoppedReason === STOPPED_BY_OTHER ? '' : legacyPrematch.card.stoppedReason)
      : MIGRATION_REVIEW_REASON,
  }

  const handicapProvidesLive = legacyHandicapCommon.valid && periods !== null
    && legacyHandicapCommon.card.enabled && periods.includes('live')
  let liveResult
  let liveHasUsableSource = false
  if (liveSource) {
    liveResult = normalizeLiveCard(liveSource, { allowPublishedWindowDefaults: true })
    liveHasUsableSource = liveResult.valid
  } else if (handicapProvidesLive) {
    liveResult = normalizeLiveCard({
      ...handicapSource,
      enabled: true,
      stoppedReason: '',
    }, { allowPublishedWindowDefaults: true })
    liveHasUsableSource = liveResult.valid
  } else {
    liveResult = {
      card: { ...structuredClone(DEFAULT_MONITOR_SETTINGS.live), stoppedReason: MIGRATION_REVIEW_REASON },
      valid: false,
    }
  }

  const liveSourceEnabled = Boolean(liveSource && liveResult.valid && liveResult.card.enabled)
  const sourcesConflict = Boolean(handicapProvidesLive && liveSource && liveResult.valid
    && !sameCommonParameters(legacyHandicapCommon.card, liveResult.card))
  const liveValid = liveHasUsableSource && !sourcesConflict
  const live = {
    ...liveResult.card,
    enabled: liveValid ? Boolean(handicapProvidesLive || liveSourceEnabled) : false,
    stoppedReason: liveValid && liveResult.card.stoppedReason !== STOPPED_BY_OTHER
      ? liveResult.card.stoppedReason
      : (liveValid ? '' : MIGRATION_REVIEW_REASON),
  }
  return { version: 2, prematch, live }
}

function normalizeVersion2Settings(source) {
  const prematchResult = object(source.prematch)
    ? normalizePrematchCard(source.prematch)
    : { card: { ...DEFAULT_MONITOR_SETTINGS.prematch, stoppedReason: MIGRATION_REVIEW_REASON }, valid: false }
  const liveResult = object(source.live)
    ? normalizeLiveCard(source.live)
    : { card: { ...DEFAULT_MONITOR_SETTINGS.live, stoppedReason: MIGRATION_REVIEW_REASON }, valid: false }
  return { version: 2, prematch: prematchResult.card, live: liveResult.card }
}

export function normalizeMonitorSettings(input = {}) {
  const source = object(input) ? input : {}
  return source.version === 2 ? normalizeVersion2Settings(source) : migrateLegacySettings(source)
}

function canonicalMonitorMode(mode) {
  if (mode === 'handicap') return 'prematch'
  return mode === 'prematch' || mode === 'live' ? mode : null
}

export function startMonitorMode(settings, mode) {
  const normalized = normalizeMonitorSettings(settings)
  const canonical = canonicalMonitorMode(mode)
  if (!canonical) return normalized
  normalized[canonical].enabled = true
  normalized[canonical].stoppedReason = ''
  return normalizeMonitorSettings(normalized)
}

export function stopMonitorMode(settings, mode) {
  const normalized = normalizeMonitorSettings(settings)
  const canonical = canonicalMonitorMode(mode)
  if (canonical) normalized[canonical].enabled = false
  if (!mode) {
    normalized.prematch.enabled = false
    normalized.live.enabled = false
  }
  return normalizeMonitorSettings(normalized)
}

function odds(value) {
  const number = Number(value?.odds?.value ?? value?.odds ?? value?.oddsRaw ?? value)
  return Number.isFinite(number) ? number : null
}

function changeDirection(change) {
  const oldOdds = odds(change?.old)
  const nextOdds = odds(change?.next)
  if (oldOdds === null || nextOdds === null) return 'unknown'
  if (nextOdds > oldOdds) return 'up'
  if (nextOdds < oldOdds) return 'down'
  return 'flat'
}

function absDelta(change) {
  const oldOdds = odds(change?.old)
  const nextOdds = odds(change?.next)
  if (oldOdds === null || nextOdds === null) return null
  return Math.abs(nextOdds - oldOdds)
}

function selectionKey(change) {
  return [
    change?.event?.eventId || 'unknown-event',
    change?.market?.marketId || 'unknown-market',
    change?.selection?.selectionId || 'unknown-selection',
  ].join('|')
}

function skipped(reason, extra = {}) {
  return { triggered: false, skipped: true, skipReason: reason, ...extra }
}

function modeOf(change) {
  return change?.mode || change?.event?.mode || 'prematch'
}

function changeEventKey(change) {
  return cleanString(change?.event?.eventKey || change?.next?.event?.eventKey || change?.old?.event?.eventKey || change?.event?.eventId)
}

function trackedMatchModeAllowed(item, recordMode) {
  const trackedMode = cleanString(item?.mode)
  return !trackedMode || !recordMode || trackedMode === recordMode
}

function matchesTrackedMatch(change, recordMode, item) {
  if (item?.trackingStatus !== 'active') return false
  if (!trackedMatchModeAllowed(item, recordMode)) return false

  const eventKey = changeEventKey(change)
  const trackedEventKey = cleanString(item?.eventKey)
  if (eventKey && trackedEventKey && eventKey === trackedEventKey) return true

  return cleanString(change?.event?.league) === cleanString(item?.league)
    && cleanString(change?.event?.homeTeam) === cleanString(item?.homeTeam)
    && cleanString(change?.event?.awayTeam) === cleanString(item?.awayTeam)
}

function isTrackedMatch(change, recordMode, trackedMatches = []) {
  if (!Array.isArray(trackedMatches)) return false
  return trackedMatches.some((item) => matchesTrackedMatch(change, recordMode, item))
}

function minutesBeforeKickoff(change, now) {
  const start = Date.parse(change?.event?.startTimeUtc || '')
  const current = Date.parse(now || change?.capturedAt || new Date().toISOString())
  if (!Number.isFinite(start) || !Number.isFinite(current)) return null
  return Math.floor((start - current) / 60_000)
}

export function parseLiveMinute(clock) {
  const text = cleanString(clock).toLowerCase()
  if (!text) return null
  if (['ht', 'half time', 'half-time', '中场'].includes(text)) return 'half_time'
  const minute = Number((text.match(/\d+/) || [])[0])
  return Number.isFinite(minute) ? minute : null
}

function livePeriodAllowed(minute, card) {
  if (minute === 'half_time') return card.includeHalfTime
  if (minute <= 45) return card.includeFirstHalf
  return card.includeSecondHalf
}

function checkOddsRange(change, card) {
  const nextOdds = odds(change?.next)
  if (nextOdds === null) return false
  if (card.minOdds !== null && nextOdds < card.minOdds) return false
  if (card.maxOdds !== null && nextOdds > card.maxOdds) return false
  return true
}

function checkWaterMove(change, card) {
  const delta = absDelta(change)
  const dir = changeDirection(change)
  if (delta === null) return false
  if (card.waterMoveDirection !== 'both' && dir !== card.waterMoveDirection) return false
  return delta >= card.waterMoveThreshold
}

function cooldownActive(key, card, cooldownState, nowMs) {
  if (!cooldownState || !card.cooldownSeconds) return false
  const previous = cooldownState.get(key)
  return previous && nowMs - previous < card.cooldownSeconds * 1000
}

function roundDelta(value) {
  if (value === null || value === undefined) return null
  return Number(Number(value).toFixed(6))
}

export function evaluateChangeCandidate(change, { settings = DEFAULT_MONITOR_SETTINGS } = {}) {
  const normalized = normalizeMonitorSettings(settings)
  const mode = modeOf(change) === 'live' ? 'live' : 'prematch'
  const card = normalized[mode]
  const delta = roundDelta(absDelta(change))
  const dir = changeDirection(change)
  const threshold = card?.waterMoveThreshold ?? DEFAULT_MONITOR_SETTINGS.prematch.waterMoveThreshold

  if (change?.type && change.type !== 'odds-change') {
    return { candidate: false, reason: 'unsupported_change_type', monitorMode: mode, delta, direction: dir, threshold }
  }
  if (delta === null) return { candidate: false, reason: 'odds_missing', monitorMode: mode, delta, direction: dir, threshold }
  if (card?.waterMoveDirection && card.waterMoveDirection !== 'both' && dir !== card.waterMoveDirection) {
    return { candidate: false, reason: 'direction_mismatch', monitorMode: mode, delta, direction: dir, threshold }
  }
  if (delta < threshold) {
    return { candidate: false, reason: 'threshold_not_reached', monitorMode: mode, delta, direction: dir, threshold }
  }
  return { candidate: true, reason: 'threshold_reached', monitorMode: mode, delta, direction: dir, threshold }
}

export function evaluateMonitorChange(change, { settings = DEFAULT_MONITOR_SETTINGS, defaultLeagues = null, trackedMatches = null, now = null, cooldownState = null } = {}) {
  const normalized = normalizeMonitorSettings(settings)
  const recordMode = modeOf(change) === 'live' ? 'live' : 'prematch'
  const mode = recordMode
  const card = normalized[mode]
  if (!card.enabled) return skipped('mode_disabled')

  if (defaultLeagues && !isTrackedMatch(change, recordMode, trackedMatches)) {
    const leagueDecision = isDefaultLeagueMatched(change?.event?.league, recordMode, defaultLeagues)
    if (leagueDecision.status === 'missing') return skipped('league_not_allowed')
    if (leagueDecision.status === 'disabled') return skipped('default_league_disabled')
    if (leagueDecision.status === 'mode_disabled') return skipped('mode_disabled')
  }

  if (recordMode === 'prematch') {
    const minutes = minutesBeforeKickoff(change, now)
    if (minutes !== null) {
      const max = card.startMinutesBeforeKickoff
      const min = card.stopMinutesBeforeKickoff
      if (minutes > max || minutes < min) return skipped('prematch_time_out_of_range', { minutesBeforeKickoff: minutes })
    }
  }

  if (recordMode === 'live') {
    const minute = parseLiveMinute(change?.event?.clock)
    if (minute === null) return skipped('live_clock_missing')
    if (!livePeriodAllowed(minute, card)) return skipped('live_minute_out_of_range', { liveMinute: minute })
    if (minute !== 'half_time' && (minute < card.liveMinuteFrom || minute > card.liveMinuteTo)) {
      return skipped('live_minute_out_of_range', { liveMinute: minute })
    }
  }

  if (!checkOddsRange(change, card)) return skipped('odds_out_of_range')
  if (!checkWaterMove(change, card)) return skipped('water_move_below_threshold')

  const key = selectionKey(change)
  const nowMs = Date.parse(now || change?.capturedAt || new Date().toISOString())
  if (cooldownActive(key, card, cooldownState, nowMs)) return skipped('cooldown_active', { key })
  if (cooldownState) cooldownState.set(key, nowMs)

  return {
    triggered: true,
    skipped: false,
    monitorMode: mode,
    key,
    delta: absDelta(change),
    direction: changeDirection(change),
  }
}

function legacyRuleForCard(mode, card) {
  const modes = [mode]
  const phases = [
    card.includeFirstHalf ? 'first_half' : null,
    card.includeSecondHalf ? 'second_half' : null,
    card.includeHalfTime ? 'half_time' : null,
  ].filter(Boolean)

  return {
    id: `legacy-monitor-${mode}-odds-delta`,
    type: 'odds_delta',
    version: 1,
    enabled: true,
    scope: {
      modes,
      markets: ['asian_handicap', 'total'],
      periods: ['full_time', 'first_half'],
      leagues: [],
    },
    conditions: {
      minDelta: card.waterMoveThreshold,
      direction: card.waterMoveDirection,
      oddsRange: { min: card.minOdds, max: card.maxOdds },
      kickoffWindow: modes.includes('prematch') ? {
        startMinutesBeforeKickoff: card.startMinutesBeforeKickoff,
        stopMinutesBeforeKickoff: card.stopMinutesBeforeKickoff,
      } : null,
      liveWindow: modes.includes('live') ? {
        minuteFrom: card.liveMinuteFrom,
        minuteTo: card.liveMinuteTo,
        phases,
      } : null,
    },
    cooldownSeconds: card.cooldownSeconds,
    bettingRuleId: card.bettingRuleId,
  }
}

export function legacyMonitorRules(settings = DEFAULT_MONITOR_SETTINGS) {
  const normalized = normalizeMonitorSettings(settings)
  return ['prematch', 'live']
    .filter((mode) => normalized[mode].enabled)
    .map((mode) => legacyRuleForCard(mode, normalized[mode]))
}

export function legacyMonitorRule(settings = DEFAULT_MONITOR_SETTINGS) {
  return legacyMonitorRules(settings)[0] ?? null
}

export function buildMonitorCards(settings = DEFAULT_MONITOR_SETTINGS, events = []) {
  const normalized = normalizeMonitorSettings(settings)
  const cards = {}
  for (const mode of ['prematch', 'live']) {
    const card = normalized[mode]
    const relevant = (events || []).filter((event) => event.mode === mode)
    cards[mode] = {
      status: card.enabled ? 'running' : 'closed',
      effectiveLeagueCount: new Set(relevant.map((event) => event.league).filter(Boolean)).size,
      trackedEventCount: relevant.length,
      trackedSelectionCount: relevant.reduce((sum, event) => sum + Number(event.selectionCount || 0), 0),
      lastAlertAt: card.lastAlertAt || null,
      stoppedReason: card.stoppedReason || '',
    }
  }
  return cards
}

export async function readMonitorSettings(file = MONITOR_SETTINGS_PATH) {
  return readJsonConfig(file, DEFAULT_MONITOR_SETTINGS, normalizeMonitorSettings)
}

export async function writeMonitorSettings(file = MONITOR_SETTINGS_PATH, settings) {
  return writeJsonConfig(file, settings, normalizeMonitorSettings)
}
