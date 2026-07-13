import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findEnabledLeagueConflicts,
  normalizeLeagueNames,
  validateBettingRulePolicy,
} from '../src/crown/betting/betting-rule-policy.mjs'

function validRule(overrides = {}) {
  return {
    enabled: true,
    leagueNames: ['英超'],
    targetAmount: '100.00',
    currency: 'CNY',
    amountScale: 2,
    changedOddsMin: null,
    changedOddsMax: null,
    direction: 'up_reverse',
    executionMode: 'preview_only',
    ...overrides,
  }
}

test('normalizes league names with trim, deduplication, and stable sort order', () => {
  assert.deepEqual(normalizeLeagueNames([' 西甲 ', '英超', '西甲', '', '  ', '德甲']), ['德甲', '英超', '西甲'])
})

test('rejects an enabled rule without leagues', () => {
  assert.throws(() => validateBettingRulePolicy(validRule({ leagueNames: [] })), /league-required/)
})

test('rejects inverted changed-odds bounds and mutable direction', () => {
  assert.throws(() => validateBettingRulePolicy(validRule({ changedOddsMin: 1.01, changedOddsMax: 0.99 })), /odds-range/)
  assert.throws(() => validateBettingRulePolicy(validRule({ direction: 'follow' })), /direction/)
})

test('rejects invalid currency, scale, and non-positive target amount', () => {
  assert.throws(() => validateBettingRulePolicy(validRule({ currency: 'cnyy' })), /currency/)
  assert.throws(() => validateBettingRulePolicy(validRule({ amountScale: 7 })), /amount-scale/)
  assert.throws(() => validateBettingRulePolicy(validRule({ targetAmount: '0.00' })), /amount-positive/)
})

test('finds only exact enabled league ownership conflicts', () => {
  const rules = [
    { id: 'r1', name: '英超规则', enabled: true, leagueNames: ['英超'] },
    { id: 'r2', name: '关闭规则', enabled: false, leagueNames: ['西甲'] },
  ]
  assert.deepEqual(findEnabledLeagueConflicts(rules, ['英超', '英格兰超级联赛', '西甲']), [
    { ruleId: 'r1', ruleName: '英超规则', leagueName: '英超' },
  ])
})
