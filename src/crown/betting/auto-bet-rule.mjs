import { ValidationError } from '../app/app-validation.mjs'

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/
const ENUMS = {
  mode: ['prematch', 'live'],
  period: ['full', 'first_half', 'second_half'],
  marketType: ['asian_handicap', 'total'],
  monitoredSide: ['home', 'away', 'over', 'under'],
}

function fail(field, message = `invalid ${field}`) {
  throw new ValidationError('validation-error', { [field]: message })
}

function has(input, field) {
  return Object.prototype.hasOwnProperty.call(input, field)
}

function text(input, field, fallback, { required = false } = {}) {
  const value = has(input, field) ? String(input[field] ?? '').trim() : fallback
  if (required && !value) fail(field, `${field} is required`)
  return value
}

function boolean(input, field, fallback) {
  if (!has(input, field)) return fallback
  if (typeof input[field] !== 'boolean') fail(field, `${field} must be a boolean`)
  return input[field]
}

function integer(input, field, fallback, { min = 0 } = {}) {
  if (!has(input, field)) return fallback
  const raw = input[field]
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) {
    fail(field, `${field} must be a safe integer`)
  }
  return raw
}

function decimal(input, field, fallback) {
  const value = text(input, field, fallback)
  if (!DECIMAL_PATTERN.test(value)) fail(field, `${field} must be a non-negative decimal string`)
  return value
}

function enumeration(input, field, fallback) {
  const value = text(input, field, fallback)
  if (!ENUMS[field].includes(value)) fail(field)
  return value
}

function leagues(input, partial) {
  if (!has(input, 'leagueNames')) return partial ? undefined : []
  if (!Array.isArray(input.leagueNames)) fail('leagueNames')
  return [...new Set(input.leagueNames.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function set(result, input, field, value, partial) {
  if (!partial || has(input, field)) result[field] = value
}

export function reverseSelectionSide(side) {
  const reversed = { home: 'away', away: 'home', over: 'under', under: 'over' }[side]
  if (!reversed) fail('side')
  return reversed
}

export function normalizeAutoBetRule(input, { partial = false, current = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('body', 'JSON object is required')
  if (partial) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) fail('current', 'current canonical rule is required')
    const merged = { ...current, ...input }
    const nonCurrentWindowFields = merged.mode === 'live'
      ? ['startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff']
      : ['liveMinuteFrom', 'liveMinuteTo']
    for (const field of nonCurrentWindowFields) {
      if (!has(input, field) && merged[field] === null) delete merged[field]
    }
    const normalized = normalizeAutoBetRule(merged)
    const result = {}
    for (const field of Object.keys(input)) {
      if (Object.prototype.hasOwnProperty.call(normalized, field)) result[field] = normalized[field]
    }
    if (has(input, 'mode')) {
      for (const field of ['startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff', 'liveMinuteFrom', 'liveMinuteTo']) {
        result[field] = normalized[field]
      }
    }
    return result
  }

  const result = {}
  const name = text(input, 'name', '', { required: !partial })
  const priority = integer(input, 'priority', 1, { min: 1 })
  const monitorEnabled = boolean(input, 'monitorEnabled', false)
  const realBettingEnabled = boolean(input, 'realBettingEnabled', false)
  const archived = boolean(input, 'archived', false)
  const mode = enumeration(input, 'mode', 'prematch')
  const period = enumeration(input, 'period', 'full')
  const marketType = enumeration(input, 'marketType', 'asian_handicap')
  const monitoredSide = enumeration(input, 'monitoredSide', marketType === 'total' ? 'over' : 'home')
  const minWaterRise = decimal(input, 'minWaterRise', '0.01')
  const targetOddsMin = decimal(input, 'targetOddsMin', '0')
  const targetOddsMax = decimal(input, 'targetOddsMax', '2')
  const targetAmountMinor = integer(input, 'targetAmountMinor', 1, { min: 1 })
  const leagueNames = leagues(input, partial)
  const startMinutesBeforeKickoff = integer(input, 'startMinutesBeforeKickoff', null)
  const stopMinutesBeforeKickoff = integer(input, 'stopMinutesBeforeKickoff', null)
  const liveMinuteFrom = integer(input, 'liveMinuteFrom', null)
  const liveMinuteTo = integer(input, 'liveMinuteTo', null)
  const migrationReviewRequired = boolean(input, 'migrationReviewRequired', false)

  const validatePair = !partial || (has(input, 'marketType') && has(input, 'monitoredSide'))
  if (validatePair && marketType === 'asian_handicap' && !['home', 'away'].includes(monitoredSide)) fail('monitoredSide', 'side is incompatible with marketType')
  if (validatePair && marketType === 'total' && !['over', 'under'].includes(monitoredSide)) fail('monitoredSide', 'side is incompatible with marketType')
  if (Number(targetOddsMin) > Number(targetOddsMax)) fail('targetOddsMax', 'target odds range is invalid')
  if (realBettingEnabled && has(input, 'monitorEnabled') && !monitorEnabled) fail('monitorEnabled', 'real betting requires monitor enabled')
  if (!partial && realBettingEnabled && !monitorEnabled) fail('monitorEnabled', 'real betting requires monitor enabled')
  if (monitorEnabled && leagueNames && leagueNames.length === 0) fail('leagueNames', 'enabled monitor requires at least one league')

  if (mode === 'prematch') {
    if (startMinutesBeforeKickoff !== null && stopMinutesBeforeKickoff !== null && startMinutesBeforeKickoff < stopMinutesBeforeKickoff) {
      fail('startMinutesBeforeKickoff', 'prematch kickoff window is invalid')
    }
    if (startMinutesBeforeKickoff === null || stopMinutesBeforeKickoff === null) {
      fail('startMinutesBeforeKickoff', 'prematch kickoff window is incomplete')
    }
  } else {
    if (liveMinuteFrom !== null && liveMinuteTo !== null && liveMinuteFrom > liveMinuteTo) fail('liveMinuteFrom', 'live window is invalid')
    if (liveMinuteFrom === null || liveMinuteTo === null) fail('liveMinuteFrom', 'live window is incomplete')
  }

  set(result, input, 'name', name, partial)
  set(result, input, 'priority', priority, partial)
  set(result, input, 'monitorEnabled', monitorEnabled, partial)
  set(result, input, 'realBettingEnabled', realBettingEnabled, partial)
  set(result, input, 'archived', archived, partial)
  set(result, input, 'mode', mode, partial)
  set(result, input, 'period', period, partial)
  set(result, input, 'marketType', marketType, partial)
  set(result, input, 'monitoredSide', monitoredSide, partial)
  set(result, input, 'minWaterRise', minWaterRise, partial)
  set(result, input, 'targetOddsMin', targetOddsMin, partial)
  set(result, input, 'targetOddsMax', targetOddsMax, partial)
  set(result, input, 'targetAmountMinor', targetAmountMinor, partial)
  if (!partial || has(input, 'leagueNames')) result.leagueNames = leagueNames
  if (!partial) {
    if (has(input, 'currency') && text(input, 'currency', '').toUpperCase() !== 'CNY') fail('currency', 'currency must be CNY')
    if (has(input, 'amountScale') && integer(input, 'amountScale', 0) !== 0) fail('amountScale', 'amountScale must be 0 for CNY')
    result.currency = 'CNY'
    result.amountScale = 0
    result.startMinutesBeforeKickoff = mode === 'prematch' ? startMinutesBeforeKickoff : null
    result.stopMinutesBeforeKickoff = mode === 'prematch' ? stopMinutesBeforeKickoff : null
    result.liveMinuteFrom = mode === 'live' ? liveMinuteFrom : null
    result.liveMinuteTo = mode === 'live' ? liveMinuteTo : null
  } else {
    set(result, input, 'startMinutesBeforeKickoff', startMinutesBeforeKickoff, true)
    set(result, input, 'stopMinutesBeforeKickoff', stopMinutesBeforeKickoff, true)
    set(result, input, 'liveMinuteFrom', liveMinuteFrom, true)
    set(result, input, 'liveMinuteTo', liveMinuteTo, true)
    if (has(input, 'currency')) {
      if (text(input, 'currency', '').toUpperCase() !== 'CNY') fail('currency', 'currency must be CNY')
      result.currency = 'CNY'
    }
    if (has(input, 'amountScale')) {
      if (integer(input, 'amountScale', 0) !== 0) fail('amountScale', 'amountScale must be 0 for CNY')
      result.amountScale = 0
    }
  }
  set(result, input, 'migrationReviewRequired', migrationReviewRequired, partial)
  return result
}
