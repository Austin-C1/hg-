export function migrateFixedSettingsToRuleCards(db, { now = () => new Date().toISOString() } = {}) {
  const source = db.prepare(`
    SELECT * FROM auto_betting_settings
    WHERE mode IN ('prematch','live')
    ORDER BY CASE mode WHEN 'prematch' THEN 0 ELSE 1 END
  `).all()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO auto_betting_rule_cards (
      card_id, name, enabled, target_odds_min, target_odds_max,
      target_amount_minor, currency, amount_scale, remark, real_eligible,
      real_eligibility_version, real_eligibility_updated_at,
      migration_review_required, migration_review_reason, version,
      created_at, updated_at
    ) VALUES (?, ?, 0, ?, ?, ?, 'CNY', 0, ?, 0, 1, ?,
      1, 'fixed-mode-card-requires-league-review', 1, ?, ?)
  `)
  const insertedCardIds = []
  for (const row of source) {
    const cardId = `migrated-fixed-${row.mode}`
    const time = now()
    const result = insert.run(
      cardId,
      row.mode === 'prematch' ? '原赛前投注' : '原滚球投注',
      row.target_odds_min,
      row.target_odds_max,
      row.target_amount_minor,
      row.remark || '',
      time,
      time,
      time,
    )
    if (result.changes === 1) insertedCardIds.push(cardId)
  }
  return { insertedCardIds }
}
