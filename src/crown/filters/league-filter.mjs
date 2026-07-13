import { findExcludedKeyword, normalizeText } from './blacklist.mjs'

function ruleValues(rule) {
  return [rule?.name, ...(rule?.aliases || [])].filter(Boolean)
}

function matchesRule(leagueName, rule) {
  const normalizedLeague = normalizeText(leagueName)
  const matchMode = rule?.match || 'contains'

  for (const value of ruleValues(rule)) {
    const normalizedValue = normalizeText(value)
    if (!normalizedValue) continue

    if (matchMode === 'exact' && normalizedLeague === normalizedValue) return value
    if (matchMode === 'regex' && new RegExp(value, 'i').test(String(leagueName || ''))) return value
    if (matchMode === 'contains' && normalizedLeague.includes(normalizedValue)) return value
  }

  return null
}

export function isLeagueAllowed(leagueName, config = {}) {
  if (!config.enabled) {
    return { allowed: true, reason: 'disabled' }
  }

  const excludedBy = findExcludedKeyword(leagueName, config.exclude)
  if (excludedBy) {
    return { allowed: false, reason: 'excluded', excludedBy }
  }

  for (const rule of config.include || []) {
    const matchedBy = matchesRule(leagueName, rule)
    if (matchedBy) {
      return { allowed: true, reason: 'included', matchedBy, ruleName: rule.name }
    }
  }

  if (config.defaultAction === 'allow') {
    return { allowed: true, reason: 'default-allow' }
  }

  return { allowed: false, reason: 'default-ignore' }
}

export function filterByLeague(records, config = {}, getLeague = (record) => record?.event?.league ?? record?.league) {
  const kept = []
  const dropped = []

  for (const record of records || []) {
    const leagueName = getLeague(record)
    const decision = isLeagueAllowed(leagueName, config)
    if (decision.allowed) kept.push(record)
    else dropped.push({ record, decision })
  }

  return { kept, dropped }
}
