const MODES = ['prematch', 'live']
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function booleanEvidence(value) {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null
}

function numericText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function existingModes(existingRows, key) {
  const rows = Array.isArray(existingRows?.[key]) ? existingRows[key] : []
  return new Set(rows.map((row) => row?.mode).filter((mode) => MODES.includes(mode)))
}

function marketEvidence(card, key) {
  const direct = booleanEvidence(card?.[key])
  if (direct !== null) return direct
  const nested = booleanEvidence(card?.markets?.[key])
  return nested
}

function decideMonitorMode(mode, monitorJson) {
  const card = monitorJson && typeof monitorJson === 'object' ? monitorJson[mode] : null
  const reasons = []
  if (card?.enabled === true) reasons.push('legacy-enabled')

  const asianHandicap = marketEvidence(card, 'asianHandicapEnabled')
  const total = marketEvidence(card, 'totalEnabled')
  const marketEvidenceMissing = asianHandicap === null || total === null
  if (marketEvidenceMissing) reasons.push('market-evidence-missing')

  const monitorOddsMin = finiteNumber(card?.minOdds)
  const monitorOddsMax = finiteNumber(card?.maxOdds)
  const waterMoveThreshold = finiteNumber(card?.waterMoveThreshold)
  const cooldownSeconds = nonNegativeInteger(card?.cooldownSeconds)
  const commonComplete = monitorOddsMin !== null
    && monitorOddsMax !== null
    && monitorOddsMin <= monitorOddsMax
    && waterMoveThreshold !== null
    && waterMoveThreshold >= 0
    && cooldownSeconds !== null

  let startMinutesBeforeKickoff = null
  let stopMinutesBeforeKickoff = null
  let liveMinuteFrom = null
  let liveMinuteTo = null
  let includeFirstHalf = 0
  let includeHalfTime = 0
  let includeSecondHalf = 0
  let branchComplete = false
  if (mode === 'prematch') {
    startMinutesBeforeKickoff = nonNegativeInteger(card?.startMinutesBeforeKickoff)
    stopMinutesBeforeKickoff = nonNegativeInteger(card?.stopMinutesBeforeKickoff)
    branchComplete = startMinutesBeforeKickoff !== null
      && stopMinutesBeforeKickoff !== null
      && startMinutesBeforeKickoff >= stopMinutesBeforeKickoff
  } else {
    liveMinuteFrom = nonNegativeInteger(card?.liveMinuteFrom)
    liveMinuteTo = nonNegativeInteger(card?.liveMinuteTo)
    const first = booleanEvidence(card?.includeFirstHalf)
    const half = booleanEvidence(card?.includeHalfTime)
    const second = booleanEvidence(card?.includeSecondHalf)
    branchComplete = liveMinuteFrom !== null && liveMinuteTo !== null && liveMinuteFrom <= liveMinuteTo
      && first !== null && half !== null && second !== null
    includeFirstHalf = first ?? 0
    includeHalfTime = half ?? 0
    includeSecondHalf = second ?? 0
  }
  if (!commonComplete || !branchComplete) reasons.push('numeric-evidence-incomplete')

  const reviewRequired = marketEvidenceMissing || !commonComplete || !branchComplete
  return {
    mode,
    enabled: 0,
    asian_handicap_enabled: asianHandicap ?? 0,
    total_enabled: total ?? 0,
    monitor_odds_min: monitorOddsMin,
    monitor_odds_max: monitorOddsMax,
    water_move_threshold: waterMoveThreshold,
    cooldown_seconds: cooldownSeconds,
    start_minutes_before_kickoff: startMinutesBeforeKickoff,
    stop_minutes_before_kickoff: stopMinutesBeforeKickoff,
    live_minute_from: liveMinuteFrom,
    live_minute_to: liveMinuteTo,
    include_first_half: includeFirstHalf,
    include_half_time: includeHalfTime,
    include_second_half: includeSecondHalf,
    remark: typeof card?.remark === 'string' ? card.remark : '',
    migration_review_required: reviewRequired ? 1 : 0,
    migration_review_reason: reasons.join(';'),
  }
}

function isMigrationTemplate(rule) {
  return rule?.id === 'legacy-prematch' || rule?.id === 'legacy-live'
}

function validLegacyCandidate(rule, mode) {
  if (!rule || rule.mode !== mode || Number(rule.archived) !== 0) return null
  if (rule.currency !== 'CNY' || rule.amount_scale !== 0) return null
  if (rule.migration_review_required !== 0) return null
  const oddsMin = numericText(rule.target_odds_min)
  const oddsMax = numericText(rule.target_odds_max)
  const amount = rule.target_amount_minor
  if (oddsMin === null || oddsMax === null || oddsMin > oddsMax) return null
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SAFE_INTEGER) return null
  return { oddsMin, oddsMax, amount }
}

function decideBettingMode(mode, legacyRules) {
  const rules = Array.isArray(legacyRules)
    ? legacyRules.filter((rule) => rule?.mode === mode && Number(rule?.archived) === 0 && !isMigrationTemplate(rule))
    : []
  const selected = rules.length === 1 ? validLegacyCandidate(rules[0], mode) : null
  const rule = selected ? rules[0] : null
  const reasons = []
  if (rule?.enabled === 1 || rule?.monitor_enabled === 1) reasons.push('legacy-enabled')
  if (rule?.real_betting_enabled === 1) reasons.push('legacy-real-betting-enabled')
  if (!selected) reasons.push(rules.length > 1 ? 'legacy-rules-conflict' : 'legacy-evidence-incomplete')
  return {
    mode,
    enabled: 0,
    target_odds_min: selected?.oddsMin ?? null,
    target_odds_max: selected?.oddsMax ?? null,
    target_amount_minor: selected?.amount ?? null,
    currency: 'CNY',
    amount_scale: 0,
    real_eligible: 0,
    migration_review_required: selected ? 0 : 1,
    migration_review_reason: reasons.join(';'),
  }
}

export function decideAlertBettingMigration({ monitorJson = null, legacyRules = [], existingRows = {} } = {}) {
  const existingMonitorModes = existingModes(existingRows, 'monitorSettings')
  const existingBettingModes = existingModes(existingRows, 'autoBettingSettings')
  return {
    monitorSettings: MODES
      .filter((mode) => !existingMonitorModes.has(mode))
      .map((mode) => decideMonitorMode(mode, monitorJson)),
    autoBettingSettings: MODES
      .filter((mode) => !existingBettingModes.has(mode))
      .map((mode) => decideBettingMode(mode, legacyRules)),
  }
}
