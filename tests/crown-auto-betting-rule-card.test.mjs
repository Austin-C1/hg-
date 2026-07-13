import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeRuleCardCreate,
  normalizeRuleCardUpdate,
} from '../src/crown/betting/auto-betting-rule-card.mjs'

const validBody = {
  name: '  主卡  ',
  enabled: false,
  leagueNames: ['英超', ' 英超 ', '友谊赛'],
  targetOddsMin: '0000.123456789012345678',
  targetOddsMax: '0.123456789012345679',
  targetAmountMinor: 100,
  remark: '',
}

const context = { availableLeagueNames: ['英超', '友谊赛'] }

function hasCode(code) {
  return (error) => error?.code === code
}

test('create requires exact complete fields and one currently available league', () => {
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, leagueNames: [] }, context), hasCode('league-required'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, leagueNames: ['昨日联赛'] }, context), hasCode('league-not-available-today'))
  const { remark, ...missing } = validBody
  assert.throws(() => normalizeRuleCardCreate(missing, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, unexpected: true }, context), hasCode('validation-error'))
})

test('create canonicalizes trimmed values without losing 18 decimal places', () => {
  assert.deepEqual(normalizeRuleCardCreate(validBody, context), {
    name: '主卡',
    enabled: false,
    leagueNames: ['英超', '友谊赛'],
    targetOddsMin: '0.123456789012345678',
    targetOddsMax: '0.123456789012345679',
    targetAmountMinor: 100,
    currency: 'CNY',
    amountScale: 0,
    remark: '',
  })
})

test('card validation rejects noncanonical types, unordered decimal bounds, and unsafe amounts', () => {
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, name: ' ' }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, enabled: 0 }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, leagueNames: [' '] }, context), hasCode('league-required'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, targetOddsMin: 0.8 }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, targetOddsMin: '0.123456789012345679', targetOddsMax: '0.123456789012345678' }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, targetOddsMin: '0.1234567890123456789' }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({
    ...validBody,
    targetOddsMin: '9007199254740991.1',
    targetOddsMax: '9007199254740991.1',
  }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, targetAmountMinor: Number.MAX_SAFE_INTEGER + 1 }, context), hasCode('validation-error'))
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, remark: null }, context), hasCode('validation-error'))
})

test('update permits own stale leagues but rejects newly added stale leagues', () => {
  const update = { ...validBody, expectedVersion: 4, leagueNames: ['旧联赛', '英超'] }
  assert.deepEqual(normalizeRuleCardUpdate(update, {
    availableLeagueNames: ['英超'],
    existingLeagueNames: ['旧联赛'],
  }), {
    name: '主卡',
    enabled: false,
    leagueNames: ['旧联赛', '英超'],
    targetOddsMin: '0.123456789012345678',
    targetOddsMax: '0.123456789012345679',
    targetAmountMinor: 100,
    currency: 'CNY',
    amountScale: 0,
    remark: '',
  })
  assert.throws(() => normalizeRuleCardUpdate({ ...update, leagueNames: ['其他旧联赛'] }, {
    availableLeagueNames: ['英超'],
    existingLeagueNames: ['旧联赛'],
  }), hasCode('league-not-available-today'))
  assert.throws(() => normalizeRuleCardUpdate({ ...update, expectedVersion: 0 }, {
    availableLeagueNames: ['英超'], existingLeagueNames: ['旧联赛'],
  }), hasCode('validation-error'))
})
