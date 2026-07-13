import { createHash } from 'node:crypto'

const SHA256 = /^[a-f0-9]{64}$/
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const EXECUTION_MODES = new Set(['preview_only', 'real_eligible'])
const LIVE_PHASES = new Set(['first_half', 'second_half', 'half_time'])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function canonicalTimestamp(value) {
  if (!UTC_TIMESTAMP.test(String(value || ''))) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null
  return milliseconds
}

function nullableBound(value) {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

function containsExact(collection, value) {
  if (Array.isArray(collection)) return collection.includes(value)
  if (collection instanceof Set) return collection.has(value)
  return false
}

function timeEvidenceMatches(signal, nowMilliseconds, observedMilliseconds) {
  const evidence = signal.evidence
  if (evidence?.mode === 'prematch') {
    const minutes = evidence.minutesBeforeKickoff
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return false
    if (evidence.livePhase !== null || evidence.liveMinute !== null) return false
    const kickoffMilliseconds = observedMilliseconds + minutes * 60_000
    return Number.isFinite(kickoffMilliseconds) && nowMilliseconds < kickoffMilliseconds
  }

  if (evidence?.mode !== 'live') return false
  if (evidence.minutesBeforeKickoff !== null || !LIVE_PHASES.has(evidence.livePhase)) return false
  if (evidence.livePhase === 'half_time') return evidence.liveMinute === null
  if (!Number.isInteger(evidence.liveMinute) || evidence.liveMinute < 0) return false
  if (evidence.livePhase === 'first_half') return evidence.liveMinute <= 45
  return evidence.liveMinute >= 45
}

export function deterministicBatchId(signalId, ruleId) {
  if (!SHA256.test(String(signalId || ''))) throw new TypeError('signalId must be a SHA-256 hash')
  if (!nonEmptyString(ruleId)) throw new TypeError('ruleId must be a non-empty string')
  return createHash('sha256').update(`${signalId}\n${ruleId}`, 'utf8').digest('hex')
}

export function matchRuleForSignal(signal, {
  rule = null,
  currentLeagueNames = [],
  now = new Date().toISOString(),
} = {}) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return null
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null
  if (!SHA256.test(String(signal.signalId || '')) || signal.schemaVersion !== 2 || signal.status !== 'pending') return null
  if (signal.trigger?.type !== 'odds-change' || signal.trigger?.direction !== 'up') return null
  if (signal.dataQuality?.complete !== true || signal.dataQuality?.identityConfidence !== 'high') return null
  if (rule.enabled !== true || !EXECUTION_MODES.has(rule.executionMode)) return null
  if ((rule.direction || 'up_reverse') !== 'up_reverse' || !nonEmptyString(rule.id)) return null

  const league = signal.evidence?.league
  if (!nonEmptyString(league)) return null
  if (!containsExact(rule.leagueNames, league) || !containsExact(currentLeagueNames, league)) return null

  const sourceOdds = signal.evidence?.nextOdds
  if (typeof sourceOdds !== 'number' || !Number.isFinite(sourceOdds)) return null
  const minimum = nullableBound(rule.changedOddsMin)
  const maximum = nullableBound(rule.changedOddsMax)
  if (Number.isNaN(minimum) || Number.isNaN(maximum)) return null
  if (minimum !== null && sourceOdds < minimum) return null
  if (maximum !== null && sourceOdds > maximum) return null

  const observedMilliseconds = canonicalTimestamp(signal.observedAt)
  const expiresMilliseconds = canonicalTimestamp(signal.expiresAt)
  const nowMilliseconds = canonicalTimestamp(now)
  if (observedMilliseconds === null || expiresMilliseconds === null || nowMilliseconds === null) return null
  if (expiresMilliseconds < observedMilliseconds) return null
  if (nowMilliseconds < observedMilliseconds || nowMilliseconds >= expiresMilliseconds) return null
  if (!timeEvidenceMatches(signal, nowMilliseconds, observedMilliseconds)) return null

  return {
    batchId: deterministicBatchId(signal.signalId, rule.id),
    signalId: signal.signalId,
    ruleId: rule.id,
    ruleVersion: Number.isInteger(rule.version) && rule.version > 0 ? rule.version : null,
    sourceLeague: league,
    sourceOdds,
    executionMode: rule.executionMode,
    observedAt: signal.observedAt,
    expiresAt: signal.expiresAt,
  }
}
