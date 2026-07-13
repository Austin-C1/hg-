import { normalizeCurrency, parseDecimalToMinor } from './money.mjs'

export function normalizeLeagueNames(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].sort()
}

export function validateBettingRulePolicy(rule) {
  const leagueNames = normalizeLeagueNames(rule.leagueNames)
  if (rule.enabled && leagueNames.length === 0) throw new TypeError('league-required')
  if (rule.changedOddsMin !== null && rule.changedOddsMax !== null && rule.changedOddsMin > rule.changedOddsMax) {
    throw new TypeError('odds-range')
  }
  if ((rule.direction || 'up_reverse') !== 'up_reverse') throw new TypeError('direction')
  const currency = normalizeCurrency(rule.currency)
  const targetAmountMinor = parseDecimalToMinor(rule.targetAmount, { scale: rule.amountScale })
  return {
    ...rule,
    leagueNames,
    currency,
    direction: 'up_reverse',
    targetAmountMinor,
  }
}

export function findEnabledLeagueConflicts(rules, leagueNames, { excludeRuleId = null } = {}) {
  const wanted = new Set(normalizeLeagueNames(leagueNames))
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.enabled && rule.id !== excludeRuleId)
    .flatMap((rule) => normalizeLeagueNames(rule.leagueNames)
      .filter((leagueName) => wanted.has(leagueName))
      .map((leagueName) => ({ ruleId: rule.id, ruleName: rule.name, leagueName })))
    .sort((a, b) => a.leagueName.localeCompare(b.leagueName) || String(a.ruleId).localeCompare(String(b.ruleId)))
}
