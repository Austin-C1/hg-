export function isCanonicalRealRule(row) {
  return Boolean(row
    && Number(row.archived) === 0
    && Number(row.monitor_enabled) === 1
    && Number(row.real_betting_enabled) === 1
    && Number(row.migration_review_required) === 0)
}

export function assertCanonicalRealRule(row) {
  if (!row) throw new Error('betting-rule-not-found')
  if (!isCanonicalRealRule(row)) throw new Error('rule-real-disabled')
  return row
}

export const CANONICAL_REAL_RULE_SQL = `
  archived = 0
  AND monitor_enabled = 1
  AND real_betting_enabled = 1
  AND migration_review_required = 0
`
