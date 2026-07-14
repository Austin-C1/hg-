import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { matchEnabledRuleCardForSignal } from '../src/crown/betting/auto-betting-rule-card-matcher.mjs'

const NOW = '2026-07-12T00:00:00.000Z'

function seedCard(db, overrides = {}) {
  const card = {
    cardId: 'card-a', name: '英超卡', enabled: 1, targetOddsMin: '0.8', targetOddsMax: '1.05',
    targetAmountMinor: 100, realEligible: 0, realEligibilityVersion: 2,
    migrationReviewRequired: 0, version: 3, league: '英超', ...overrides,
  }
  db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,
    remark,real_eligible,real_eligibility_version,real_eligibility_updated_at,
    migration_review_required,migration_review_reason,version,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,'CNY',0,'',?,?,? ,?,'',?,?,?)`).run(
    card.cardId, card.name, card.enabled, card.targetOddsMin, card.targetOddsMax,
    card.targetAmountMinor, card.realEligible, card.realEligibilityVersion, NOW,
    card.migrationReviewRequired, card.version, NOW, NOW,
  )
  db.prepare('INSERT INTO auto_betting_rule_card_leagues (card_id,league_name,created_at) VALUES (?,?,?)')
    .run(card.cardId, card.league, NOW)
  return card
}

function signal({ league = '英超', mode = 'prematch' } = {}) {
  return { evidence: { league, mode } }
}

test('one exact league owner yields one immutable mode-free card snapshot', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    seedCard(handle.db)
    const context = { availableLeagueNames: new Set(['英超']) }
    const prematch = matchEnabledRuleCardForSignal(handle.db, signal(), context)
    const live = matchEnabledRuleCardForSignal(handle.db, signal({ mode: 'live' }), context)
    assert.equal(prematch.cardId, 'card-a')
    assert.equal(live.cardId, 'card-a')
    assert.equal(Object.hasOwn(prematch, 'mode'), false)
    assert.equal(prematch.targetAmountMinor, 100)
    assert.deepEqual(prematch.leagueNames, ['英超'])
    assert.equal(Object.hasOwn(prematch, 'realEligible'), false)
    assert.equal(Object.hasOwn(prematch, 'realEligibilityVersion'), false)
    assert.equal(Object.hasOwn(prematch, 'realEligibilityUpdatedAt'), false)
    assert.equal(prematch.createdAt, NOW)
    assert.equal(prematch.updatedAt, NOW)
    assert.equal(Object.isFrozen(prematch), true)
    assert.equal(Object.isFrozen(prematch.leagueNames), true)
    assert.equal(matchEnabledRuleCardForSignal(handle.db, signal({ league: '西甲' }), context), null)
  } finally { handle.close() }
})

test('matcher fail-closes for unavailable, disabled, review-required, or corrupt cards', () => {
  for (const scenario of [
    { availableLeagueNames: new Set(), overrides: {} },
    { availableLeagueNames: new Set(['英超']), overrides: { enabled: 0 } },
    { availableLeagueNames: new Set(['英超']), overrides: { migrationReviewRequired: 1, targetOddsMin: null, targetOddsMax: null, targetAmountMinor: null } },
  ]) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    try {
      seedCard(handle.db, scenario.overrides)
      assert.equal(matchEnabledRuleCardForSignal(handle.db, signal(), scenario), null)
    } finally { handle.close() }
  }

  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    seedCard(handle.db)
    handle.db.exec('PRAGMA ignore_check_constraints=ON')
    handle.db.prepare("UPDATE auto_betting_rule_cards SET target_odds_min='broken'").run()
    assert.equal(matchEnabledRuleCardForSignal(handle.db, signal(), { availableLeagueNames: new Set(['英超']) }), null)
  } finally { handle.close() }
})

test('manual today catalog names are eligible by exact name without mode filtering', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    seedCard(handle.db, { league: '友谊赛' })
    assert.equal(matchEnabledRuleCardForSignal(
      handle.db,
      signal({ league: '友谊赛', mode: 'live' }),
      { availableLeagueNames: new Set(['友谊赛']) },
    )?.cardId, 'card-a')
    assert.equal(matchEnabledRuleCardForSignal(
      handle.db,
      signal({ league: ' 友谊赛 ', mode: 'prematch' }),
      { availableLeagueNames: new Set(['友谊赛']) },
    )?.cardId, 'card-a')
  } finally { handle.close() }
})

test('snapshot completeness rejects reversed odds', () => {
  for (const mutation of [
    "UPDATE auto_betting_rule_cards SET target_odds_min='1.1',target_odds_max='0.8'",
  ]) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    try {
      seedCard(handle.db)
      handle.db.exec('PRAGMA ignore_check_constraints=ON')
      handle.db.exec(mutation)
      assert.equal(matchEnabledRuleCardForSignal(
        handle.db, signal(), { availableLeagueNames: new Set(['英超']) },
      ), null)
    } finally { handle.close() }
  }
})

test('legacy eligibility fields do not enter or gate the executable card snapshot', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    seedCard(handle.db)
    handle.db.prepare("UPDATE auto_betting_rule_cards SET real_eligible=1,real_eligibility_version=99,real_eligibility_updated_at='2026-07-12T00:00:01.000Z'").run()
    const snapshot = matchEnabledRuleCardForSignal(
      handle.db, signal(), { availableLeagueNames: new Set(['英超']) },
    )
    assert.equal(snapshot?.cardId, 'card-a')
    assert.equal(Object.hasOwn(snapshot, 'realEligible'), false)
    assert.equal(Object.hasOwn(snapshot, 'realEligibilityVersion'), false)
    assert.equal(Object.hasOwn(snapshot, 'realEligibilityUpdatedAt'), false)
  } finally { handle.close() }
})

test('snapshot completeness rejects unsafe decimals, malformed current timestamps, and non-text fields', () => {
  for (const mutation of [
    "UPDATE auto_betting_rule_cards SET target_odds_max='9007199254740991.1'",
    "UPDATE auto_betting_rule_cards SET updated_at='2026-07-12 00:00:00'",
    "UPDATE auto_betting_rule_cards SET remark=x'31'",
  ]) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    try {
      seedCard(handle.db)
      handle.db.exec('PRAGMA ignore_check_constraints=ON')
      handle.db.exec(mutation)
      assert.equal(matchEnabledRuleCardForSignal(
        handle.db, signal(), { availableLeagueNames: new Set(['英超']) },
      ), null, mutation)
    } finally { handle.close() }
  }
})
