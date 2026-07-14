import { isDefaultLeagueMatched } from '../config/default-leagues.mjs'

const VALID_MARKETS = new Set(['asian_handicap', 'total'])
const VALID_MODES = new Set(['prematch', 'live'])
const VALID_PERIODS = new Set(['full_time', 'first_half', 'second_half'])
const VALID_DIRECTIONS = new Set(['up', 'down', 'both'])
const VALID_LIVE_PHASES = new Set(['first_half', 'second_half', 'half_time'])
const CANONICAL_EVENT_IDENTITY = /^crown\|football\|gid=[^|\s]+$/
const STABLE_CHANGE_ID = /^[a-f0-9]{64}$/
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function text(value) {
  return String(value ?? '').trim()
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(value, key) {
  return object(value) && Object.hasOwn(value, key)
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nullableFiniteNumber(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function canonicalUtcMilliseconds(value) {
  if (typeof value !== 'string' || !CANONICAL_UTC_TIMESTAMP.test(value)) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null
  return milliseconds
}

function validStringArray(value, supported, { empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0)) return false
  return value.every((item) => typeof item === 'string' && item.trim() && (!supported || supported.has(item)))
}

function validateKickoffWindow(value) {
  if (!object(value)) return false
  const start = value.startMinutesBeforeKickoff
  const stop = value.stopMinutesBeforeKickoff
  return nonNegativeNumber(start) && nonNegativeNumber(stop) && start >= stop
}

function validateLiveWindow(value) {
  if (!object(value)) return 'conditions.liveWindow'
  if (!validStringArray(value.phases, VALID_LIVE_PHASES)) return 'conditions.liveWindow.phases'
  if (!nonNegativeNumber(value.minuteFrom) || !nonNegativeNumber(value.minuteTo) || value.minuteFrom > value.minuteTo) {
    return 'conditions.liveWindow'
  }
  return null
}

function invalidRuleField(rule) {
  if (typeof rule?.id !== 'string' || !rule.id.trim()) return 'id'
  if (!Number.isInteger(rule?.version) || rule.version <= 0) return 'version'
  if (rule?.type !== 'odds_delta') return 'type'
  if (typeof rule?.enabled !== 'boolean') return 'enabled'
  if (!validStringArray(rule?.scope?.modes, VALID_MODES)) return 'scope.modes'
  if (!validStringArray(rule?.scope?.markets, VALID_MARKETS, { empty: rule?.enabled === false })) return 'scope.markets'
  if (!validStringArray(rule?.scope?.periods, VALID_PERIODS)) return 'scope.periods'
  if (!validStringArray(rule?.scope?.leagues, null, { empty: true })) return 'scope.leagues'
  if (!object(rule?.conditions)) return 'conditions'
  if (!nonNegativeNumber(rule.conditions.minDelta)) return 'conditions.minDelta'
  if (!VALID_DIRECTIONS.has(rule.conditions.direction)) return 'conditions.direction'
  const range = rule.conditions.oddsRange
  if (!object(range)) return 'conditions.oddsRange'
  if (!own(range, 'min') || !nullableFiniteNumber(range.min)) return 'conditions.oddsRange.min'
  if (!own(range, 'max') || !nullableFiniteNumber(range.max)) return 'conditions.oddsRange.max'
  if (range.min !== null && range.max !== null && range.min > range.max) return 'conditions.oddsRange'
  if (!own(rule.conditions, 'kickoffWindow')) return 'conditions.kickoffWindow'
  if (!own(rule.conditions, 'liveWindow')) return 'conditions.liveWindow'
  if (rule.scope.modes.includes('prematch')) {
    if (!validateKickoffWindow(rule.conditions.kickoffWindow)) return 'conditions.kickoffWindow'
  } else if (rule.conditions.kickoffWindow !== null) return 'conditions.kickoffWindow'
  if (rule.scope.modes.includes('live')) {
    const invalidLiveWindow = rule.enabled === false && Array.isArray(rule.conditions.liveWindow?.phases)
      && rule.conditions.liveWindow.phases.length === 0
      ? null
      : validateLiveWindow(rule.conditions.liveWindow)
    if (invalidLiveWindow) return invalidLiveWindow
  } else if (rule.conditions.liveWindow !== null) return 'conditions.liveWindow'
  if (!nonNegativeNumber(rule.cooldownSeconds)) return 'cooldownSeconds'
  if (own(rule, 'signalTtlSeconds')
    && (!Number.isSafeInteger(rule.signalTtlSeconds) || rule.signalTtlSeconds <= 0)) return 'signalTtlSeconds'
  if (own(rule, 'bettingRuleId') && !(rule.bettingRuleId === null
    || (typeof rule.bettingRuleId === 'string' && rule.bettingRuleId.trim()))) return 'bettingRuleId'
  return null
}

export function validateOddsDeltaRule(rule) {
  const invalidField = invalidRuleField(rule)
  if (invalidField) throw new TypeError(`strategy_rule_invalid:${invalidField}`)
  return rule
}

function rounded(value) {
  return Number(Number(value).toFixed(6))
}

function modeOf(change) {
  return text(change?.mode || change?.event?.mode || change?.next?.mode || change?.next?.event?.mode || change?.old?.mode || change?.old?.event?.mode)
}

function oddsOf(snapshot) {
  return finite(snapshot?.selection?.odds ?? snapshot?.odds?.value ?? snapshot?.odds ?? snapshot?.oddsRaw)
}

function oddsRawOf(snapshot, odds) {
  const raw = text(snapshot?.selection?.oddsRaw ?? snapshot?.odds?.raw ?? snapshot?.oddsRaw)
  return raw || Number(odds).toFixed(3)
}

function dataQuality(change, { complete = false, missing = [], warnings = null } = {}) {
  return {
    complete,
    identityConfidence: text(change?.event?.identityConfidence || change?.identityConfidence) || 'unknown',
    missing: [...missing],
    warnings: Array.isArray(warnings) ? [...warnings] : Array.isArray(change?.warnings) ? [...change.warnings] : [],
  }
}

function skipped(change, skipReason, missing = []) {
  return {
    matched: false,
    skipReason,
    dataQuality: dataQuality(change, { complete: false, missing }),
  }
}

function scoped(values, value) {
  return !Array.isArray(values) || values.length === 0 || values.includes(value)
}

function directionOf(oldOdds, nextOdds) {
  if (nextOdds > oldOdds) return 'up'
  if (nextOdds < oldOdds) return 'down'
  return 'flat'
}

function trackedModeAllowed(item, mode) {
  const trackedMode = text(item?.mode)
  return !trackedMode || !mode || trackedMode === mode
}

function trackedMatch(change, mode, item) {
  if (item?.trackingStatus !== 'active' || !trackedModeAllowed(item, mode)) return false
  const eventIdentity = text(change?.eventIdentity || change?.event?.eventKey)
  const trackedIdentity = text(item?.eventKey)
  if (trackedIdentity) return Boolean(eventIdentity) && eventIdentity === trackedIdentity
  const values = [
    text(change?.event?.league),
    text(change?.event?.homeTeam),
    text(change?.event?.awayTeam),
    text(item?.league),
    text(item?.homeTeam),
    text(item?.awayTeam),
  ]
  if (values.some((value) => !value)) return false
  return values[0] === values[3] && values[1] === values[4] && values[2] === values[5]
}

function manuallyTracked(change, mode, trackedMatches) {
  return Array.isArray(trackedMatches) && trackedMatches.some((item) => trackedMatch(change, mode, item))
}

function leagueSkipReason(change, mode, rule, { defaultLeagues, trackedMatches }) {
  const league = text(change?.event?.league)
  const explicitLeagues = rule?.scope?.leagues
  if (Array.isArray(explicitLeagues) && explicitLeagues.length && !explicitLeagues.includes(league)) return 'league-not-allowed'
  if (manuallyTracked(change, mode, trackedMatches)) return null
  if (!defaultLeagues) return null
  const decision = isDefaultLeagueMatched(league, mode, defaultLeagues)
  if (decision.status === 'disabled') return 'default-league-disabled'
  if (decision.status === 'mode_disabled') return 'mode-not-allowed'
  if (decision.status !== 'hit') return 'league-not-allowed'
  return null
}

function observedMilliseconds(change, now) {
  return canonicalUtcMilliseconds(now ?? change?.observedAt)
}

function kickoffDecision(change, rule, now) {
  const window = rule?.conditions?.kickoffWindow
  if (!window) return null
  const startTimeUtc = change?.event?.startTimeUtc
  if (!text(startTimeUtc)) return skipped(change, 'data_incomplete:start_time_missing', ['startTimeUtc'])
  const start = canonicalUtcMilliseconds(startTimeUtc)
  if (start === null) return skipped(change, 'data_incomplete:start_time_invalid', ['startTimeUtc'])
  const observed = observedMilliseconds(change, now)
  if (observed === null) return skipped(change, 'data_incomplete:observed_at_missing', ['observedAt'])
  const minutesBeforeKickoff = Math.floor((start - observed) / 60_000)
  const startLimit = finite(window.startMinutesBeforeKickoff)
  const stopLimit = finite(window.stopMinutesBeforeKickoff)
  if ((startLimit !== null && minutesBeforeKickoff > startLimit) || (stopLimit !== null && minutesBeforeKickoff < stopLimit)) {
    return { ...skipped(change, 'kickoff-window-mismatch'), minutesBeforeKickoff }
  }
  return { minutesBeforeKickoff }
}

function liveDecision(change, rule) {
  const window = rule?.conditions?.liveWindow
  if (!window) return null
  const phase = text(change?.event?.livePhase)
  const minute = finite(change?.event?.liveMinute)
  if (!phase) return skipped(change, 'data_incomplete:live_period_missing', ['livePhase'])
  const phases = Array.isArray(window.phases) ? window.phases : []
  if (phases.length && !phases.includes(phase)) return { ...skipped(change, 'live-window-mismatch'), livePhase: phase, liveMinute: minute }
  if (phase === 'half_time') return { livePhase: phase, liveMinute: null }
  if (minute === null) return skipped(change, 'data_incomplete:live_clock_missing', ['liveMinute'])
  const from = finite(window.minuteFrom)
  const to = finite(window.minuteTo)
  if ((from !== null && minute < from) || (to !== null && minute > to)) {
    return { ...skipped(change, 'live-window-mismatch'), livePhase: phase, liveMinute: minute }
  }
  return { livePhase: phase, liveMinute: minute }
}

export function evaluateOddsDelta(change, { rule, defaultLeagues = null, trackedMatches = null, now = null } = {}) {
  const invalidField = invalidRuleField(rule)
  if (invalidField) return skipped(change, `strategy_rule_invalid:${invalidField}`)
  if (change?.type !== 'odds-change') return skipped({}, 'unsupported-change-type')
  if (!rule.enabled) return skipped(change, 'strategy-disabled')

  const changeId = text(change?.changeId)
  const observedAt = text(change?.observedAt)
  if (!changeId) return skipped(change, 'data_incomplete:change_id_missing', ['changeId'])
  if (!STABLE_CHANGE_ID.test(changeId)) return skipped(change, 'data_incomplete:change_id_invalid', ['changeId'])
  if (!observedAt) return skipped(change, 'data_incomplete:observed_at_missing', ['observedAt'])
  if (canonicalUtcMilliseconds(observedAt) === null) return skipped(change, 'data_incomplete:observed_at_invalid', ['observedAt'])
  if (now !== null && now !== undefined && canonicalUtcMilliseconds(now) === null) {
    return skipped(change, 'data_incomplete:evaluation_time_invalid', ['now'])
  }
  const eventIdentity = text(change?.eventIdentity || change?.event?.eventKey)
  const marketIdentity = text(change?.marketIdentity || change?.market?.marketIdentity)
  const selectionIdentity = text(change?.selectionIdentity || change?.selection?.selectionIdentity)
  if (!eventIdentity) return skipped(change, 'data_incomplete:event_identity_missing', ['eventIdentity'])
  if (!marketIdentity) return skipped(change, 'data_incomplete:market_identity_missing', ['marketIdentity'])
  if (!selectionIdentity) return skipped(change, 'data_incomplete:selection_identity_missing', ['selectionIdentity'])
  const identityConfidence = text(change?.event?.identityConfidence || change?.identityConfidence).toLowerCase()
  if (!identityConfidence) return skipped(change, 'data_incomplete:identity_confidence_missing', ['identityConfidence'])
  if (identityConfidence === 'low') return skipped(change, 'data_incomplete:identity_confidence_low', ['identityConfidence'])
  if (identityConfidence !== 'high') return skipped(change, 'data_incomplete:identity_confidence_not_high', ['identityConfidence'])
  if (!CANONICAL_EVENT_IDENTITY.test(eventIdentity)) return skipped(change, 'data_incomplete:event_identity_invalid', ['eventIdentity'])
  if (text(change?.event?.eventKey) && text(change.event.eventKey) !== eventIdentity) {
    return skipped(change, 'data_incomplete:event_identity_invalid', ['eventIdentity'])
  }

  if (!marketIdentity.startsWith(`${eventIdentity}|`)) return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
  const marketParts = marketIdentity.slice(eventIdentity.length + 1).split('|')
  if (marketParts.length !== 3 || marketParts.some((part) => !part)) return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
  const [identityPeriod, identityMarketType, identityLineKey] = marketParts
  if (text(change?.market?.marketIdentity) && text(change.market.marketIdentity) !== marketIdentity) {
    return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
  }
  if ((text(change?.market?.period) && text(change.market.period) !== identityPeriod)
    || (text(change?.market?.marketType) && text(change.market.marketType) !== identityMarketType)
    || (text(change?.market?.lineKey) && text(change.market.lineKey) !== identityLineKey)) {
    return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
  }

  if (!selectionIdentity.startsWith(`${marketIdentity}|`) || selectionIdentity.slice(marketIdentity.length + 1).includes('|')) {
    return skipped(change, 'data_incomplete:selection_identity_invalid', ['selectionIdentity'])
  }
  if (text(change?.selection?.selectionIdentity) && text(change.selection.selectionIdentity) !== selectionIdentity) {
    return skipped(change, 'data_incomplete:selection_identity_invalid', ['selectionIdentity'])
  }
  for (const snapshot of [change?.old, change?.next]) {
    if (text(snapshot?.event?.eventKey) !== eventIdentity) {
      return skipped(change, 'data_incomplete:event_identity_invalid', ['eventIdentity'])
    }
    if (text(snapshot?.market?.marketIdentity) !== marketIdentity) {
      return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
    }
    if (text(snapshot?.market?.period) !== identityPeriod
      || text(snapshot?.market?.marketType) !== identityMarketType
      || text(snapshot?.market?.lineKey) !== identityLineKey) {
      return skipped(change, 'data_incomplete:market_identity_invalid', ['marketIdentity'])
    }
    if (text(snapshot?.selection?.selectionIdentity) && text(snapshot.selection.selectionIdentity) !== selectionIdentity) {
      return skipped(change, 'data_incomplete:selection_identity_invalid', ['selectionIdentity'])
    }
  }
  const derivedSide = selectionIdentity.slice(marketIdentity.length + 1)

  const oldOdds = oddsOf(change?.old)
  const nextOdds = oddsOf(change?.next)
  if (oldOdds === null) return skipped(change, 'data_incomplete:old_odds_missing', ['old.odds'])
  if (nextOdds === null) return skipped(change, 'data_incomplete:next_odds_missing', ['next.odds'])
  const homeTeam = text(change?.event?.homeTeam)
  const awayTeam = text(change?.event?.awayTeam)

  const mode = modeOf(change)
  const marketType = identityMarketType
  const period = identityPeriod
  if (!scoped(rule?.scope?.modes, mode)) return skipped(change, 'mode-not-allowed')
  if (!VALID_MARKETS.has(marketType) || !scoped(rule?.scope?.markets, marketType)) return skipped(change, 'market-not-allowed')
  if (!scoped(rule?.scope?.periods, period)) return skipped(change, 'period-not-allowed')
  const supportedSides = marketType === 'asian_handicap' ? ['home', 'away'] : ['over', 'under']
  if (!supportedSides.includes(derivedSide)) return skipped(change, 'data_incomplete:selection_identity_invalid', ['selectionIdentity'])
  if (rule.monitoredSide && rule.monitoredSide !== derivedSide) return skipped(change, 'monitored-side-mismatch')
  const explicitSides = [change?.selection?.side, change?.old?.selection?.side, change?.next?.selection?.side]
    .map(text)
    .filter(Boolean)
  if (explicitSides.some((side) => side !== derivedSide)) {
    return skipped(change, 'data_incomplete:selection_side_invalid', ['selection.side'])
  }

  const leagueReason = leagueSkipReason(change, mode, rule, { defaultLeagues, trackedMatches })
  if (leagueReason) return skipped(change, leagueReason)
  if (!homeTeam) return skipped(change, 'data_incomplete:home_team_missing', ['homeTeam'])
  if (!awayTeam) return skipped(change, 'data_incomplete:away_team_missing', ['awayTeam'])
  const handicapRaw = text(
    change?.market?.handicapRaw
      ?? change?.next?.market?.handicapRaw
      ?? change?.old?.market?.handicapRaw,
  )
  if (!handicapRaw) {
    return skipped(change, 'data_incomplete:handicap_raw_missing', ['market.handicapRaw'])
  }

  const kickoff = mode === 'prematch' ? kickoffDecision(change, rule, now) : null
  if (kickoff?.matched === false) return kickoff
  const live = mode === 'live' ? liveDecision(change, rule) : null
  if (live?.matched === false) return live

  const direction = directionOf(oldOdds, nextOdds)
  const delta = rounded(Math.abs(nextOdds - oldOdds))
  if (direction === 'flat' || delta === 0) return skipped(change, 'no-odds-change')
  const configuredDirection = text(rule?.conditions?.direction) || 'both'
  if (configuredDirection !== 'both' && direction !== configuredDirection) return skipped(change, 'direction-mismatch')
  const threshold = finite(rule?.conditions?.minDelta) ?? 0
  if (delta < threshold) return skipped(change, 'delta-below-threshold')

  const range = rule?.conditions?.oddsRange || {}
  const minOdds = finite(range.min)
  const maxOdds = finite(range.max)
  if ((minOdds !== null && nextOdds < minOdds) || (maxOdds !== null && nextOdds > maxOdds)) return skipped(change, 'odds-out-of-range')

  return {
    matched: true,
    strategyId: rule.id,
    strategyVersion: rule.version,
    trigger: {
      type: 'odds-change',
      direction,
      delta,
      threshold,
      observedAt,
    },
    target: {
      eventIdentity,
      marketIdentity,
      selectionIdentity,
      side: derivedSide,
    },
    evidence: {
      changeId,
      oldOdds,
      nextOdds,
      homeTeam,
      awayTeam,
      handicapRaw,
      oldOddsRaw: oddsRawOf(change?.old, oldOdds),
      nextOddsRaw: oddsRawOf(change?.next, nextOdds),
      mode,
      league: text(change?.event?.league) || null,
      marketType,
      period,
      handicap: change?.market?.handicap ?? change?.next?.market?.handicap ?? null,
      minutesBeforeKickoff: kickoff?.minutesBeforeKickoff ?? null,
      livePhase: live?.livePhase ?? null,
      liveMinute: live?.liveMinute ?? null,
      source: change?.source ?? null,
    },
    bettingRuleId: rule.bettingRuleId ?? null,
    cooldownSeconds: finite(rule.cooldownSeconds) ?? 0,
    ...(own(rule, 'signalTtlSeconds') ? { signalTtlSeconds: rule.signalTtlSeconds } : {}),
    dataQuality: dataQuality(change, { complete: true }),
  }
}
