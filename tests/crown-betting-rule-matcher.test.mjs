import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  deterministicBatchId,
  matchRuleForSignal,
} from '../src/crown/betting/betting-rule-matcher.mjs'

function signal(overrides = {}) {
  const base = {
    schemaVersion: 2,
    signalId: 'a'.repeat(64),
    status: 'pending',
    observedAt: '2026-07-11T02:00:00.000Z',
    expiresAt: '2026-07-11T02:05:00.000Z',
    trigger: { type: 'odds-change', direction: 'up' },
    target: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      side: 'home',
    },
    evidence: {
      league: '英超',
      nextOdds: 0.91,
      mode: 'prematch',
      marketType: 'asian_handicap',
      period: 'full_time',
      minutesBeforeKickoff: 30,
      livePhase: null,
      liveMinute: null,
    },
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
  }
  return {
    ...base,
    ...overrides,
    trigger: { ...base.trigger, ...overrides.trigger },
    target: { ...base.target, ...overrides.target },
    evidence: { ...base.evidence, ...overrides.evidence },
    dataQuality: { ...base.dataQuality, ...overrides.dataQuality },
  }
}

function rule(overrides = {}) {
  return {
    id: 'brule_1',
    version: 4,
    enabled: true,
    executionMode: 'preview_only',
    direction: 'up_reverse',
    leagueNames: ['英超'],
    changedOddsMin: null,
    changedOddsMax: null,
    ...overrides,
  }
}

const context = {
  rule: rule(),
  currentLeagueNames: ['英超'],
  now: '2026-07-11T02:01:00.000Z',
}

test('an up Signal creates one deterministic signal-plus-rule match', () => {
  const expected = createHash('sha256').update(`${'a'.repeat(64)}\nbrule_1`, 'utf8').digest('hex')
  assert.equal(deterministicBatchId('a'.repeat(64), 'brule_1'), expected)
  assert.equal(deterministicBatchId('a'.repeat(64), 'brule_1'), expected)

  const match = matchRuleForSignal(signal(), context)
  assert.equal(match.batchId, expected)
  assert.equal(match.signalId, 'a'.repeat(64))
  assert.equal(match.ruleId, 'brule_1')
  assert.equal(match.sourceLeague, '英超')
  assert.equal(match.sourceOdds, 0.91)
  assert.equal(match.executionMode, 'preview_only')
})

test('down Signals and unsupported rule execution modes create no batch', () => {
  assert.equal(matchRuleForSignal(signal({ trigger: { direction: 'down' } }), context), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, rule: rule({ enabled: false }) }), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, rule: rule({ executionMode: 'off' }) }), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, rule: rule({ executionMode: 'real_eligible' }) }).executionMode, 'real_eligible')
})

test('requires exact configured league and exact current whitelist membership', () => {
  assert.equal(matchRuleForSignal(signal({ evidence: { league: '英超 ' } }), context), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, rule: rule({ leagueNames: ['英格兰超级联赛'] }) }), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, currentLeagueNames: ['英格兰超级联赛'] }), null)
  assert.equal(matchRuleForSignal(signal({ evidence: { league: null } }), context), null)
})

test('applies nullable inclusive bounds to source evidence.nextOdds only', () => {
  assert.notEqual(matchRuleForSignal(signal({ evidence: { nextOdds: 0.8 } }), {
    ...context,
    rule: rule({ changedOddsMin: 0.8, changedOddsMax: 1 }),
  }), null)
  assert.notEqual(matchRuleForSignal(signal({ evidence: { nextOdds: 1 } }), {
    ...context,
    rule: rule({ changedOddsMin: 0.8, changedOddsMax: 1 }),
  }), null)
  assert.equal(matchRuleForSignal(signal({ evidence: { nextOdds: 0.799 } }), {
    ...context,
    rule: rule({ changedOddsMin: 0.8, changedOddsMax: null }),
  }), null)
  assert.equal(matchRuleForSignal(signal({ evidence: { nextOdds: 1.001 } }), {
    ...context,
    rule: rule({ changedOddsMin: null, changedOddsMax: 1 }),
  }), null)
  assert.notEqual(matchRuleForSignal(signal({ evidence: { nextOdds: 99 } }), context), null)
})

test('freshness and prematch kickoff boundaries fail closed', () => {
  assert.equal(matchRuleForSignal(signal(), { ...context, now: '2026-07-11T02:05:00.000Z' }), null)
  assert.equal(matchRuleForSignal(signal(), { ...context, now: '2026-07-11T01:59:59.999Z' }), null)
  assert.equal(matchRuleForSignal(signal({
    expiresAt: '2026-07-11T03:00:00.000Z',
    evidence: { minutesBeforeKickoff: 2 },
  }), { ...context, now: '2026-07-11T02:02:00.000Z' }), null)
  assert.equal(matchRuleForSignal(signal({ evidence: { minutesBeforeKickoff: null } }), context), null)
  assert.equal(matchRuleForSignal(signal({ evidence: { minutesBeforeKickoff: 0 } }), context), null)
})

test('live clock accepts coherent phases and fails closed for missing time', () => {
  const live = signal({
    evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: 'second_half', liveMinute: 57 },
  })
  assert.notEqual(matchRuleForSignal(live, context), null)
  assert.notEqual(matchRuleForSignal(signal({
    evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: 'half_time', liveMinute: null },
  }), context), null)
  assert.equal(matchRuleForSignal(signal({
    evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: null, liveMinute: null },
  }), context), null)
  assert.equal(matchRuleForSignal(signal({
    evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: 'second_half', liveMinute: null },
  }), context), null)
  assert.equal(matchRuleForSignal(signal({
    evidence: { mode: 'live', minutesBeforeKickoff: null, livePhase: 'half_time', liveMinute: 45 },
  }), context), null)
})

test('non-pending or incomplete persisted facts fail closed', () => {
  assert.equal(matchRuleForSignal(signal({ status: 'handled' }), context), null)
  assert.equal(matchRuleForSignal(signal({ dataQuality: { complete: false } }), context), null)
  assert.equal(matchRuleForSignal(signal({ dataQuality: { identityConfidence: 'low' } }), context), null)
})
