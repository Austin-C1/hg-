import { createHash } from 'node:crypto'

const SHA256 = /^[a-f0-9]{64}$/
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const EVENT_IDENTITY = /^crown\|football\|gid=[^|\s]+$/
const SELECTION_IDENTITY = /^crown\|football\|gid=[^|\s]+\|[^|\s]+\|[^|\s]+\|[^|\s]+\|[^|\s]+$/
const DIRECTIONS = new Set(['up', 'down'])
const MARKET_SIDES = new Map([
  ['asian_handicap', new Set(['home', 'away'])],
  ['total', new Set(['over', 'under'])],
])
const PERIODS = new Set(['full_time', 'first_half', 'second_half'])
const MODES = new Set(['prematch', 'live'])
const LIVE_PHASES = new Set(['first_half', 'second_half', 'half_time'])
const ENDPOINT_KINDS = new Set(['get_game_list', 'get_game_more'])
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low', 'unknown'])
const SOURCE_FIELDS = ['endpointKey', 'urlPattern', 'endpointKind', 'mapperVersion', 'sampleFile', 'confidence', 'dataSource']
const EVIDENCE_FIELDS = [
  'changeId',
  'oldOdds',
  'nextOdds',
  'homeTeam',
  'awayTeam',
  'handicapRaw',
  'oldOddsRaw',
  'nextOddsRaw',
  'mode',
  'league',
  'marketType',
  'period',
  'handicap',
  'minutesBeforeKickoff',
  'livePhase',
  'liveMinute',
]

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function canonicalTimestamp(value, name) {
  requiredString(value, name)
  const milliseconds = Date.parse(value)
  if (!UTC_TIMESTAMP.test(value) || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`)
  }
  return value
}

function safeString(value, name, { nullable = false, maximumLength = 2048 } = {}) {
  if (value === null && nullable) return null
  const result = requiredString(value, name).trim()
  if (result.length > maximumLength || /[<>\u0000-\u001f]/.test(result)) {
    throw new TypeError(`${name} must be normalized text`)
  }
  return result
}

function finite(value, name, { minimum = Number.NEGATIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be a finite number${Number.isFinite(minimum) ? ` >= ${minimum}` : ''}`)
  }
  return Object.is(value, -0) ? 0 : value
}

function nullableScalar(value, name) {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError(`${name} must be a normalized scalar`)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (object(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  if (typeof value === 'number' && Object.is(value, -0)) return 0
  return value
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

function own(value, field, name) {
  if (!object(value) || !Object.hasOwn(value, field)) throw new TypeError(`${name}.${field} is required`)
  return value[field]
}

function rounded(value) {
  return Number(Number(value).toFixed(6))
}

function normalizedSource(value) {
  if (value === null) return null
  if (!object(value)) throw new TypeError('signal.evidence.source must be an object or null')
  const endpointKind = safeString(own(value, 'endpointKind', 'signal.evidence.source'), 'signal.evidence.source.endpointKind')
  if (!ENDPOINT_KINDS.has(endpointKind)) throw new TypeError('signal.evidence.source.endpointKind is not supported')
  const source = { endpointKind }
  for (const field of SOURCE_FIELDS) {
    if (field === 'endpointKind' || !Object.hasOwn(value, field)) continue
    if (field === 'confidence') {
      const confidence = safeString(value[field], 'signal.evidence.source.confidence', { maximumLength: 32 })
      if (!CONFIDENCE_LEVELS.has(confidence)) throw new TypeError('signal.evidence.source.confidence is not supported')
      source[field] = confidence
      continue
    }
    source[field] = safeString(value[field], `signal.evidence.source.${field}`)
  }
  return source
}

function normalizedTarget(value) {
  if (!object(value)) throw new TypeError('signal.target must be an object')
  const eventIdentity = safeString(own(value, 'eventIdentity', 'signal.target'), 'signal.target.eventIdentity')
  if (!EVENT_IDENTITY.test(eventIdentity)) throw new TypeError('signal.target.eventIdentity must be canonical')
  const marketIdentity = safeString(own(value, 'marketIdentity', 'signal.target'), 'signal.target.marketIdentity')
  const selectionIdentity = safeString(own(value, 'selectionIdentity', 'signal.target'), 'signal.target.selectionIdentity')
  const side = safeString(own(value, 'side', 'signal.target'), 'signal.target.side', { maximumLength: 16 })
  if (!SELECTION_IDENTITY.test(selectionIdentity)) throw new TypeError('signal.target.selectionIdentity must be canonical')

  const marketParts = marketIdentity.startsWith(`${eventIdentity}|`)
    ? marketIdentity.slice(eventIdentity.length + 1).split('|')
    : []
  if (marketParts.length !== 3 || marketParts.some((part) => !part)) {
    throw new TypeError('signal.target.marketIdentity must extend eventIdentity canonically')
  }
  const [period, marketType, lineKey] = marketParts
  if (!PERIODS.has(period)) throw new TypeError('signal.target.marketIdentity period is not supported')
  if (!MARKET_SIDES.has(marketType)) throw new TypeError('signal.target.marketIdentity marketType is not supported')
  if (!MARKET_SIDES.get(marketType).has(side)) throw new TypeError('signal.target.side is not supported for marketType')
  if (selectionIdentity !== `${marketIdentity}|${side}`) {
    throw new TypeError('signal.target.side must match selectionIdentity')
  }
  return { eventIdentity, marketIdentity, selectionIdentity, side, period, marketType, lineKey }
}

function normalizedTrigger(value, observedAt) {
  if (!object(value)) throw new TypeError('signal.trigger must be an object')
  const type = safeString(own(value, 'type', 'signal.trigger'), 'signal.trigger.type', { maximumLength: 32 })
  if (type !== 'odds-change') throw new TypeError('signal.trigger.type must be odds-change')
  const direction = safeString(own(value, 'direction', 'signal.trigger'), 'signal.trigger.direction', { maximumLength: 16 })
  if (!DIRECTIONS.has(direction)) throw new TypeError('signal.trigger.direction must be up or down')
  const delta = finite(own(value, 'delta', 'signal.trigger'), 'signal.trigger.delta', { minimum: Number.MIN_VALUE })
  const threshold = finite(own(value, 'threshold', 'signal.trigger'), 'signal.trigger.threshold', { minimum: 0 })
  if (delta < threshold) throw new TypeError('signal.trigger.delta must reach signal.trigger.threshold')
  const triggerObservedAt = canonicalTimestamp(own(value, 'observedAt', 'signal.trigger'), 'signal.trigger.observedAt')
  if (triggerObservedAt !== observedAt) throw new TypeError('signal.trigger.observedAt must match signal.observedAt')
  return { type, direction, delta, threshold, observedAt: triggerObservedAt }
}

function nullableFinite(value, name, { minimum = Number.NEGATIVE_INFINITY, integer = false } = {}) {
  if (value === null) return null
  const result = finite(value, name, { minimum })
  if (integer && !Number.isInteger(result)) throw new TypeError(`${name} must be an integer or null`)
  return result
}

function normalizedEvidence(value, { trigger, target }) {
  if (!object(value)) throw new TypeError('signal.evidence must be an object')
  const changeId = safeString(own(value, 'changeId', 'signal.evidence'), 'signal.evidence.changeId', { maximumLength: 64 })
  if (!SHA256.test(changeId)) throw new TypeError('signal.evidence.changeId must be a canonical SHA-256 hash')
  const oldOdds = finite(own(value, 'oldOdds', 'signal.evidence'), 'signal.evidence.oldOdds')
  const nextOdds = finite(own(value, 'nextOdds', 'signal.evidence'), 'signal.evidence.nextOdds')
  const actualDirection = nextOdds > oldOdds ? 'up' : nextOdds < oldOdds ? 'down' : 'flat'
  if (actualDirection !== trigger.direction) throw new TypeError('signal.evidence odds direction must match signal.trigger.direction')
  if (rounded(Math.abs(nextOdds - oldOdds)) !== trigger.delta) {
    throw new TypeError('signal.evidence odds delta must match signal.trigger.delta')
  }
  const homeTeam = safeString(own(value, 'homeTeam', 'signal.evidence'), 'signal.evidence.homeTeam')
  const awayTeam = safeString(own(value, 'awayTeam', 'signal.evidence'), 'signal.evidence.awayTeam')
  const handicapRaw = safeString(own(value, 'handicapRaw', 'signal.evidence'), 'signal.evidence.handicapRaw', { maximumLength: 64 })
  const oldOddsRaw = safeString(own(value, 'oldOddsRaw', 'signal.evidence'), 'signal.evidence.oldOddsRaw', { maximumLength: 64 })
  const nextOddsRaw = safeString(own(value, 'nextOddsRaw', 'signal.evidence'), 'signal.evidence.nextOddsRaw', { maximumLength: 64 })
  if (!Number.isFinite(Number(oldOddsRaw)) || Number(oldOddsRaw) !== oldOdds) {
    throw new TypeError('signal.evidence.oldOddsRaw must match signal.evidence.oldOdds')
  }
  if (!Number.isFinite(Number(nextOddsRaw)) || Number(nextOddsRaw) !== nextOdds) {
    throw new TypeError('signal.evidence.nextOddsRaw must match signal.evidence.nextOdds')
  }

  const mode = safeString(own(value, 'mode', 'signal.evidence'), 'signal.evidence.mode', { maximumLength: 16 })
  if (!MODES.has(mode)) throw new TypeError('signal.evidence.mode is not supported')
  const leagueInput = own(value, 'league', 'signal.evidence')
  const league = leagueInput === null ? null : safeString(leagueInput, 'signal.evidence.league')
  const marketType = safeString(own(value, 'marketType', 'signal.evidence'), 'signal.evidence.marketType', { maximumLength: 32 })
  const period = safeString(own(value, 'period', 'signal.evidence'), 'signal.evidence.period', { maximumLength: 32 })
  if (marketType !== target.marketType) throw new TypeError('signal.evidence.marketType must match signal.target.marketIdentity')
  if (period !== target.period) throw new TypeError('signal.evidence.period must match signal.target.marketIdentity')
  const handicap = nullableFinite(own(value, 'handicap', 'signal.evidence'), 'signal.evidence.handicap')
  const minutesBeforeKickoff = nullableFinite(
    own(value, 'minutesBeforeKickoff', 'signal.evidence'),
    'signal.evidence.minutesBeforeKickoff',
    { minimum: 0 },
  )
  const livePhaseInput = own(value, 'livePhase', 'signal.evidence')
  const livePhase = livePhaseInput === null
    ? null
    : safeString(livePhaseInput, 'signal.evidence.livePhase', { maximumLength: 32 })
  if (livePhase !== null && !LIVE_PHASES.has(livePhase)) throw new TypeError('signal.evidence.livePhase is not supported')
  const liveMinute = nullableFinite(own(value, 'liveMinute', 'signal.evidence'), 'signal.evidence.liveMinute', {
    minimum: 0,
    integer: true,
  })
  if (mode === 'prematch' && (minutesBeforeKickoff === null || livePhase !== null || liveMinute !== null)) {
    throw new TypeError('signal.evidence prematch time fields are incoherent')
  }
  if (mode === 'live') {
    if (minutesBeforeKickoff !== null || livePhase === null) throw new TypeError('signal.evidence live time fields are incoherent')
    if (livePhase === 'half_time' ? liveMinute !== null : liveMinute === null) {
      throw new TypeError('signal.evidence liveMinute is incoherent with livePhase')
    }
  }
  const source = normalizedSource(own(value, 'source', 'signal.evidence'))
  return {
    changeId,
    oldOdds,
    nextOdds,
    homeTeam,
    awayTeam,
    handicapRaw,
    oldOddsRaw,
    nextOddsRaw,
    mode,
    league,
    marketType,
    period,
    handicap,
    minutesBeforeKickoff,
    livePhase,
    liveMinute,
    source,
  }
}

function normalizedDataQuality(value) {
  if (!object(value)) throw new TypeError('signal.dataQuality must be an object')
  if (own(value, 'complete', 'signal.dataQuality') !== true) throw new TypeError('signal.dataQuality.complete must be true')
  const identityConfidence = safeString(
    own(value, 'identityConfidence', 'signal.dataQuality'),
    'signal.dataQuality.identityConfidence',
    { maximumLength: 16 },
  )
  if (identityConfidence !== 'high') throw new TypeError('signal.dataQuality.identityConfidence must be high')
  const missing = own(value, 'missing', 'signal.dataQuality')
  const warnings = own(value, 'warnings', 'signal.dataQuality')
  if (!Array.isArray(missing) || !missing.every((item) => typeof item === 'string')) {
    throw new TypeError('signal.dataQuality.missing must be a string array')
  }
  if (missing.length !== 0) throw new TypeError('signal.dataQuality.missing must be empty for a matched Signal')
  if (!Array.isArray(warnings) || !warnings.every((item) => typeof item === 'string')) {
    throw new TypeError('signal.dataQuality.warnings must be a string array')
  }
  return {
    complete: true,
    identityConfidence: 'high',
    missing: [],
    warnings: warnings.map((warning) => safeString(warning, 'signal.dataQuality.warning')),
  }
}

export function normalizeSignalForPersistence(signal) {
  if (!object(signal)) throw new TypeError('signal must be an object')
  if (own(signal, 'schemaVersion', 'signal') !== 2) throw new TypeError('signal.schemaVersion must be 2')
  const strategyId = safeString(own(signal, 'strategyId', 'signal'), 'signal.strategyId')
  const strategyVersion = own(signal, 'strategyVersion', 'signal')
  if (!Number.isInteger(strategyVersion) || strategyVersion <= 0) {
    throw new TypeError('signal.strategyVersion must be a positive integer')
  }
  const status = safeString(own(signal, 'status', 'signal'), 'signal.status', { maximumLength: 32 })
  if (status !== 'pending') throw new TypeError('signal.status must be pending')
  const observedAt = canonicalTimestamp(own(signal, 'observedAt', 'signal'), 'signal.observedAt')
  const expiresAt = canonicalTimestamp(own(signal, 'expiresAt', 'signal'), 'signal.expiresAt')
  if (Date.parse(expiresAt) < Date.parse(observedAt)) throw new TypeError('signal.expiresAt must not be before signal.observedAt')
  const targetWithParts = normalizedTarget(own(signal, 'target', 'signal'))
  const target = {
    eventIdentity: targetWithParts.eventIdentity,
    marketIdentity: targetWithParts.marketIdentity,
    selectionIdentity: targetWithParts.selectionIdentity,
    side: targetWithParts.side,
  }
  const trigger = normalizedTrigger(own(signal, 'trigger', 'signal'), observedAt)
  const evidence = normalizedEvidence(own(signal, 'evidence', 'signal'), { trigger, target: targetWithParts })
  const dataQuality = normalizedDataQuality(own(signal, 'dataQuality', 'signal'))
  const hasBettingRuleId = Object.hasOwn(signal, 'bettingRuleId')
  const bettingRuleInput = hasBettingRuleId ? signal.bettingRuleId : undefined
  const bettingRuleId = bettingRuleInput === null
    ? null
    : bettingRuleInput === undefined ? undefined : safeString(bettingRuleInput, 'signal.bettingRuleId')
  const signalKey = safeString(own(signal, 'signalKey', 'signal'), 'signal.signalKey')
  const expectedSignalKey = `${strategyId}|${target.selectionIdentity}`
  if (signalKey !== expectedSignalKey) throw new TypeError('signal.signalKey must match strategyId and target.selectionIdentity')
  const signalId = safeString(own(signal, 'signalId', 'signal'), 'signal.signalId', { maximumLength: 64 })
  const expectedSignalId = stableHash({
    strategyId,
    strategyVersion,
    selectionIdentity: target.selectionIdentity,
    changeId: evidence.changeId,
    direction: trigger.direction,
    threshold: trigger.threshold,
  })
  if (!SHA256.test(signalId) || signalId !== expectedSignalId) {
    throw new TypeError('signal.signalId must match canonical Signal content')
  }
  return {
    schemaVersion: 2,
    signalId,
    signalKey,
    strategyId,
    strategyVersion,
    observedAt,
    expiresAt,
    trigger,
    target,
    evidence,
    ...(hasBettingRuleId ? { bettingRuleId } : {}),
    dataQuality,
    status,
  }
}

function selectedSource(value) {
  if (value === null || value === undefined) return null
  if (!object(value)) throw new TypeError('decision.evidence.source must be an object or null')
  const source = {}
  for (const field of SOURCE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue
    const selected = nullableScalar(value[field], `decision.evidence.source.${field}`)
    if (selected !== null && selected !== '') source[field] = selected
  }
  return source
}

function selectedEvidence(value, changeId) {
  if (!object(value)) throw new TypeError('decision.evidence must be an object')
  const evidence = {}
  for (const field of EVIDENCE_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`decision.evidence.${field} is required`)
    evidence[field] = nullableScalar(value[field], `decision.evidence.${field}`)
  }
  if (evidence.changeId !== changeId) throw new TypeError('decision.evidence.changeId must match change.changeId')
  evidence.source = selectedSource(value.source)
  return evidence
}

function selectedDataQuality(value) {
  if (!object(value)) throw new TypeError('decision.dataQuality must be an object')
  if (typeof value.complete !== 'boolean') throw new TypeError('decision.dataQuality.complete must be a boolean')
  const identityConfidence = nullableScalar(value.identityConfidence ?? null, 'decision.dataQuality.identityConfidence')
  const missing = value.missing
  const warnings = value.warnings
  if (!Array.isArray(missing) || !missing.every((item) => typeof item === 'string')) {
    throw new TypeError('decision.dataQuality.missing must be a string array')
  }
  if (!Array.isArray(warnings) || !warnings.every((item) => typeof item === 'string')) {
    throw new TypeError('decision.dataQuality.warnings must be a string array')
  }
  return { complete: value.complete, identityConfidence, missing: [...missing], warnings: [...warnings] }
}

export function createSignal({ rule, change, decision } = {}) {
  if (!object(rule)) throw new TypeError('rule is required')
  if (!object(change)) throw new TypeError('change is required')
  if (!object(decision) || decision.matched !== true) throw new TypeError('a matched decision is required')
  if (change.schemaVersion !== 2) throw new TypeError('change.schemaVersion must be 2')
  if (rule.type !== 'odds_delta' || rule.enabled !== true) throw new TypeError('rule must be an enabled odds_delta strategy')

  const strategyId = requiredString(rule.id, 'rule.id')
  if (!Number.isInteger(rule.version) || rule.version <= 0) throw new TypeError('rule.version must be a positive integer')
  if (decision.strategyId !== strategyId) throw new TypeError('decision.strategyId must match rule.id')
  if (decision.strategyVersion !== rule.version) throw new TypeError('decision.strategyVersion must match rule.version')

  const changeId = requiredString(change.changeId, 'change.changeId')
  if (!SHA256.test(changeId)) throw new TypeError('change.changeId must be a canonical SHA-256 hash')
  const selectionIdentity = requiredString(change.selectionIdentity, 'change.selectionIdentity')
  if (!SELECTION_IDENTITY.test(selectionIdentity)) throw new TypeError('change.selectionIdentity must be canonical')
  const observedAt = canonicalTimestamp(change.observedAt, 'change.observedAt')

  if (!object(decision.target)) throw new TypeError('decision.target must be an object')
  const eventIdentity = requiredString(decision.target.eventIdentity, 'decision.target.eventIdentity')
  if (!EVENT_IDENTITY.test(eventIdentity)) throw new TypeError('decision.target.eventIdentity must be canonical')
  const marketIdentity = requiredString(decision.target.marketIdentity, 'decision.target.marketIdentity')
  if (change.eventIdentity !== eventIdentity) throw new TypeError('decision.target.eventIdentity must match change.eventIdentity')
  if (change.marketIdentity !== marketIdentity) throw new TypeError('decision.target.marketIdentity must match change.marketIdentity')
  const targetSelectionIdentity = requiredString(decision.target.selectionIdentity, 'decision.target.selectionIdentity')
  if (targetSelectionIdentity !== selectionIdentity || !SELECTION_IDENTITY.test(targetSelectionIdentity)) {
    throw new TypeError('decision.target.selectionIdentity must match the canonical change selectionIdentity')
  }
  if (!marketIdentity.startsWith(`${eventIdentity}|`) || !targetSelectionIdentity.startsWith(`${marketIdentity}|`)) {
    throw new TypeError('decision target identities must be canonical and coherent')
  }
  const side = requiredString(decision.target.side, 'decision.target.side')
  if (targetSelectionIdentity !== `${marketIdentity}|${side}`) throw new TypeError('decision.target.side must match selectionIdentity')

  if (!object(decision.trigger)) throw new TypeError('decision.trigger must be an object')
  const triggerObservedAt = canonicalTimestamp(decision.trigger.observedAt, 'decision.trigger.observedAt')
  if (triggerObservedAt !== observedAt) throw new TypeError('decision.trigger.observedAt must match change.observedAt')
  const direction = requiredString(decision.trigger.direction, 'decision.trigger.direction')
  if (!DIRECTIONS.has(direction)) throw new TypeError('decision.trigger.direction must be up or down')
  const threshold = finite(decision.trigger.threshold, 'decision.trigger.threshold', { minimum: 0 })
  const delta = finite(decision.trigger.delta, 'decision.trigger.delta', { minimum: 0 })
  const triggerType = requiredString(decision.trigger.type, 'decision.trigger.type')
  if (triggerType !== change.type) throw new TypeError('decision.trigger.type must match change.type')
  const configuredThreshold = finite(rule.conditions?.minDelta, 'rule.conditions.minDelta', { minimum: 0 })
  if (threshold !== configuredThreshold) throw new TypeError('decision.trigger.threshold must match rule.conditions.minDelta')

  const cooldownSeconds = finite(rule.cooldownSeconds, 'rule.cooldownSeconds', { minimum: 0 })
  if (decision.cooldownSeconds !== cooldownSeconds) throw new TypeError('decision.cooldownSeconds must match rule.cooldownSeconds')
  const hasSignalTtl = Object.hasOwn(rule, 'signalTtlSeconds')
  if (hasSignalTtl && (!Number.isSafeInteger(rule.signalTtlSeconds) || rule.signalTtlSeconds <= 0)) {
    throw new TypeError('rule.signalTtlSeconds must be a positive safe integer')
  }
  if (Object.hasOwn(decision, 'signalTtlSeconds')) {
    if (!Number.isSafeInteger(decision.signalTtlSeconds) || decision.signalTtlSeconds <= 0) {
      throw new TypeError('decision.signalTtlSeconds must be a positive safe integer')
    }
    if (!hasSignalTtl || decision.signalTtlSeconds !== rule.signalTtlSeconds) {
      throw new TypeError('decision.signalTtlSeconds must match rule.signalTtlSeconds')
    }
  }
  const signalTtlSeconds = hasSignalTtl ? rule.signalTtlSeconds : cooldownSeconds
  const hasBettingRuleId = Object.hasOwn(rule, 'bettingRuleId')
  const bettingRuleId = rule.bettingRuleId === null || rule.bettingRuleId === undefined
    ? null
    : requiredString(rule.bettingRuleId, 'rule.bettingRuleId')
  if ((decision.bettingRuleId ?? null) !== bettingRuleId) {
    throw new TypeError('decision.bettingRuleId must match rule.bettingRuleId')
  }
  const expiresAt = new Date(Date.parse(observedAt) + signalTtlSeconds * 1000).toISOString()
  const trigger = { type: triggerType, direction, delta, threshold, observedAt }
  const target = { eventIdentity, marketIdentity, selectionIdentity, side }
  const evidence = selectedEvidence(decision.evidence, changeId)
  const dataQuality = selectedDataQuality(decision.dataQuality)
  const signalId = stableHash({
    strategyId,
    strategyVersion: rule.version,
    selectionIdentity,
    changeId,
    direction,
    threshold,
  })

  return normalizeSignalForPersistence({
    schemaVersion: 2,
    signalId,
    signalKey: `${strategyId}|${selectionIdentity}`,
    strategyId,
    strategyVersion: rule.version,
    observedAt,
    expiresAt,
    trigger,
    target,
    evidence,
    ...(hasBettingRuleId ? { bettingRuleId } : {}),
    dataQuality,
    status: 'pending',
  })
}
