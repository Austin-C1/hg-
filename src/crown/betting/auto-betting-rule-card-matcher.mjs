const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_SAFE_DECIMAL = { coefficient: 9007199254740991n, scale: 0 }

function decimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > 18) return null
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function orderedOdds(minimumValue, maximumValue) {
  const minimum = decimal(minimumValue)
  const maximum = decimal(maximumValue)
  if (!minimum || !maximum) return false
  const scale = Math.max(minimum.scale, maximum.scale)
  const normalizedMinimum = minimum.coefficient * 10n ** BigInt(scale - minimum.scale)
  const normalizedMaximum = maximum.coefficient * 10n ** BigInt(scale - maximum.scale)
  const safeMaximum = MAX_SAFE_DECIMAL.coefficient * 10n ** BigInt(scale)
  return normalizedMinimum <= normalizedMaximum && normalizedMaximum <= safeMaximum
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function exactText(value) {
  return typeof value === 'string' && value.trim() === value && value !== '' ? value : null
}

export function completeRuleCardSnapshot(row, leagueNames) {
  if (!row || !exactText(row.card_id) || !exactText(row.name)
    || row.enabled !== 1 || row.migration_review_required !== 0
    || !orderedOdds(row.target_odds_min, row.target_odds_max)
    || !Number.isSafeInteger(row.target_amount_minor) || row.target_amount_minor < 1
    || row.currency !== 'CNY' || row.amount_scale !== 0
    || typeof row.remark !== 'string' || typeof row.migration_review_reason !== 'string'
    || !Number.isSafeInteger(row.version) || row.version < 1
    || !canonicalTimestamp(row.created_at) || !canonicalTimestamp(row.updated_at)
    || !Array.isArray(leagueNames) || leagueNames.length === 0
    || leagueNames.some((name) => !exactText(name))) return null
  const frozenLeagues = Object.freeze([...leagueNames])
  return Object.freeze({
    cardId: row.card_id,
    name: row.name,
    enabled: true,
    targetOddsMin: row.target_odds_min,
    targetOddsMax: row.target_odds_max,
    targetAmountMinor: row.target_amount_minor,
    currency: 'CNY',
    amountScale: 0,
    remark: row.remark,
    migrationReviewRequired: false,
    migrationReviewReason: row.migration_review_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leagueNames: frozenLeagues,
  })
}

export function matchEnabledRuleCardForSignal(db, signal, { availableLeagueNames } = {}) {
  if (!db?.prepare || !(availableLeagueNames instanceof Set)) return null
  const league = String(signal?.evidence?.league || '').trim()
  if (!league || !availableLeagueNames.has(league)) return null
  const row = db.prepare(`
    SELECT cards.*
    FROM auto_betting_rule_card_leagues AS leagues
    INNER JOIN auto_betting_rule_cards AS cards ON cards.card_id=leagues.card_id
    WHERE leagues.league_name=? AND cards.enabled=1 AND cards.migration_review_required=0
  `).get(league)
  if (!row) return null
  const leagueNames = db.prepare(`
    SELECT league_name FROM auto_betting_rule_card_leagues
    WHERE card_id=? ORDER BY league_name
  `).all(row.card_id).map((item) => item.league_name)
  return completeRuleCardSnapshot(row, leagueNames)
}
