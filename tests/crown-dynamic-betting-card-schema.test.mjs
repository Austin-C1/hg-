import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

const NOW = '2026-07-12T00:00:00.000Z'

function insertCard(db, cardId, overrides = {}) {
  const row = {
    cardId,
    name: cardId,
    enabled: 0,
    targetOddsMin: '0.8',
    targetOddsMax: '1.05',
    targetAmountMinor: 100,
    migrationReviewRequired: 0,
    ...overrides,
  }
  return db.prepare(`
    INSERT INTO auto_betting_rule_cards (
      card_id, name, enabled, target_odds_min, target_odds_max,
      target_amount_minor, currency, amount_scale, remark, real_eligible,
      real_eligibility_version, real_eligibility_updated_at,
      migration_review_required, migration_review_reason, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'CNY', 0, '', 0, 1, ?, ?, '', 1, ?, ?)
  `).run(
    row.cardId, row.name, row.enabled, row.targetOddsMin, row.targetOddsMax,
    row.targetAmountMinor, NOW, row.migrationReviewRequired, NOW, NOW,
  )
}

test('dynamic cards enforce card shape and globally unique league ownership', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    const cardColumns = handle.db.prepare('PRAGMA table_info(auto_betting_rule_cards)').all().map((row) => row.name)
    assert.deepEqual(cardColumns, [
      'card_id', 'name', 'enabled', 'target_odds_min', 'target_odds_max',
      'target_amount_minor', 'currency', 'amount_scale', 'remark', 'real_eligible',
      'real_eligibility_version', 'real_eligibility_updated_at',
      'migration_review_required', 'migration_review_reason', 'version', 'created_at', 'updated_at',
    ])

    insertCard(handle.db, 'card-a')
    insertCard(handle.db, 'card-b')
    handle.db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('card-a','英超',?)").run(NOW)
    assert.throws(() => handle.db.prepare(
      "INSERT INTO auto_betting_rule_card_leagues VALUES ('card-b','英超',?)",
    ).run(NOW), /UNIQUE constraint failed/)
  } finally {
    handle.close()
  }
})

test('migration review cards may be incomplete but reviewed cards require complete canonical values', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    assert.doesNotThrow(() => insertCard(handle.db, 'review-card', {
      targetOddsMin: null,
      targetOddsMax: null,
      targetAmountMinor: null,
      migrationReviewRequired: 1,
    }))
    assert.throws(() => insertCard(handle.db, 'incomplete-card', {
      targetOddsMin: null,
      targetOddsMax: null,
      targetAmountMinor: null,
      migrationReviewRequired: 0,
    }), /constraint/i)
    assert.throws(() => insertCard(handle.db, 'fractional-amount', {
      targetAmountMinor: 1.5,
    }), /constraint/i)
  } finally {
    handle.close()
  }
})

test('schema contract and historical card identities are additive without card foreign keys', () => {
  const handle = openAppDatabase({ dbPath: ':memory:', monitorJson: null })
  try {
    assert.deepEqual({ ...handle.db.prepare(
      "SELECT meta_value FROM app_schema_meta WHERE meta_key='schema_contract'",
    ).get() }, { meta_value: 'dynamic-betting-cards-v1' })

    const expected = {
      auto_betting_signal_inbox: ['card_id', 'card_version', 'card_snapshot_json'],
      bet_batches: ['card_id', 'card_version', 'card_snapshot_json'],
      bet_market_once_claims: ['card_id', 'card_version'],
      execution_authorizations: ['card_scopes_json'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      const info = handle.db.prepare(`PRAGMA table_info(${table})`).all()
      for (const column of columns) {
        const actual = info.find((row) => row.name === column)
        assert.ok(actual, `${table}.${column}`)
        if (column !== 'card_scopes_json') {
          const expectedNotNull = table === 'auto_betting_signal_inbox' ? 1 : 0
          assert.equal(actual.notnull, expectedNotNull,
            `${table}.${column} follows its current identity/history contract`)
        }
      }
      const foreignKeys = handle.db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      assert.equal(
        foreignKeys.some((row) => row.from === 'card_id' || row.table === 'auto_betting_rule_cards'),
        false,
        `${table}.card_id must not block physical card deletion`,
      )
    }
    const authorizationScope = handle.db.prepare(
      'PRAGMA table_info(execution_authorizations)',
    ).all().find((row) => row.name === 'card_scopes_json')
    assert.equal(authorizationScope.dflt_value, "'[]'")
  } finally {
    handle.close()
  }
})
