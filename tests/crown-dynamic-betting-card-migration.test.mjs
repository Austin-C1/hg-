import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

const NOW = '2026-07-12T01:00:00.000Z'
const LATER = '2026-07-12T02:00:00.000Z'
const migrationModule = await import('../src/crown/betting/dynamic-card-migration.mjs').catch(() => ({}))
const { migrateFixedSettingsToRuleCards } = migrationModule

test('fixed prematch and live rows migrate once into disabled review cards', () => {
  assert.equal(typeof migrateFixedSettingsToRuleCards, 'function')
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    handle.db.exec('DELETE FROM auto_betting_rule_cards')
    handle.db.prepare(`
      UPDATE auto_betting_settings
      SET target_odds_min=?, target_odds_max=?, target_amount_minor=?, remark=?,
          real_eligible=1, real_eligibility_version=9, real_eligibility_updated_at=?
      WHERE mode='prematch'
    `).run('0.8', '1.05', 100, 'legacy prematch', NOW)
    handle.db.prepare(`
      UPDATE auto_betting_settings
      SET target_odds_min=NULL, target_odds_max=NULL, target_amount_minor=NULL,
          remark='legacy live', real_eligible=1, real_eligibility_version=7,
          real_eligibility_updated_at=?
      WHERE mode='live'
    `).run(NOW)

    assert.deepEqual(migrateFixedSettingsToRuleCards(handle.db, { now: () => NOW }), {
      insertedCardIds: ['migrated-fixed-prematch', 'migrated-fixed-live'],
    })
    assert.deepEqual(handle.db.prepare(`
      SELECT card_id, name, enabled, target_odds_min, target_odds_max,
             target_amount_minor, remark, real_eligible, real_eligibility_version,
             migration_review_required, migration_review_reason, version,
             created_at, updated_at
      FROM auto_betting_rule_cards ORDER BY name
    `).all().map((row) => ({ ...row })), [
      {
        card_id: 'migrated-fixed-live', name: '原滚球投注', enabled: 0,
        target_odds_min: null, target_odds_max: null, target_amount_minor: null,
        remark: 'legacy live', real_eligible: 0, real_eligibility_version: 1,
        migration_review_required: 1,
        migration_review_reason: 'fixed-mode-card-requires-league-review',
        version: 1, created_at: NOW, updated_at: NOW,
      },
      {
        card_id: 'migrated-fixed-prematch', name: '原赛前投注', enabled: 0,
        target_odds_min: '0.8', target_odds_max: '1.05', target_amount_minor: 100,
        remark: 'legacy prematch', real_eligible: 0, real_eligibility_version: 1,
        migration_review_required: 1,
        migration_review_reason: 'fixed-mode-card-requires-league-review',
        version: 1, created_at: NOW, updated_at: NOW,
      },
    ])
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_card_leagues').get().count, 0)

    handle.db.prepare(`
      UPDATE auto_betting_rule_cards SET version=4, remark='manually edited', updated_at=?
      WHERE card_id='migrated-fixed-prematch'
    `).run(LATER)
    assert.deepEqual(migrateFixedSettingsToRuleCards(handle.db, { now: () => LATER }), {
      insertedCardIds: [],
    })
    assert.deepEqual({ ...handle.db.prepare(`
      SELECT version, remark, updated_at FROM auto_betting_rule_cards
      WHERE card_id='migrated-fixed-prematch'
    `).get() }, { version: 4, remark: 'manually edited', updated_at: LATER })
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_cards').get().count, 2)
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_settings').get().count, 2)
  } finally {
    handle.close()
  }
})
