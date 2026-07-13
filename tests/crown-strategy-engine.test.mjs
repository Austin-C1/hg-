import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LEAGUES_CONFIG } from '../src/crown/config/default-leagues.mjs'
import { legacyMonitorRule, legacyMonitorRules, normalizeMonitorSettings, startMonitorMode } from '../src/crown/monitor/monitor-settings.mjs'
import { evaluateOddsDelta } from '../src/crown/monitor/odds-delta-strategy.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'
import { StrategyRegistry } from '../src/crown/monitor/strategy-registry.mjs'

function prematchChange(overrides = {}) {
  const eventKey = 'crown|football|gid=3001'
  const marketIdentity = `${eventKey}|full_time|asian_handicap|RATIO_R`
  const selectionIdentity = `${marketIdentity}|home`
  const base = {
    schemaVersion: 2,
    changeId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    type: 'odds-change',
    observedAt: '2026-07-10T01:00:00.000Z',
    eventIdentity: eventKey,
    marketIdentity,
    selectionIdentity,
    event: {
      eventKey,
      identityConfidence: 'high',
      league: '世界杯2026(美加墨)',
      homeTeam: '主队',
      awayTeam: '客队',
      mode: 'prematch',
      startTimeUtc: '2026-07-10T03:00:00.000Z',
      livePhase: null,
      liveMinute: null,
    },
    market: {
      marketIdentity,
      marketType: 'asian_handicap',
      period: 'full_time',
      lineKey: 'RATIO_R',
      handicap: 0.25,
      handicapRaw: '+0/0.5',
    },
    selection: { selectionIdentity, side: 'home', odds: 0.99 },
    old: {
      mode: 'prematch',
      event: { eventKey },
      market: { marketIdentity, marketType: 'asian_handicap', period: 'full_time', lineKey: 'RATIO_R' },
      selection: { selectionIdentity, side: 'home', odds: 0.94, oddsRaw: '0.940' },
    },
    next: {
      mode: 'prematch',
      event: { eventKey },
      market: { marketIdentity, marketType: 'asian_handicap', period: 'full_time', lineKey: 'RATIO_R' },
      selection: { selectionIdentity, side: 'home', odds: 0.99, oddsRaw: '0.990' },
    },
    source: { endpointKind: 'get_game_more', confidence: 'high' },
    warnings: [],
  }
  return {
    ...base,
    ...overrides,
    event: { ...base.event, ...(overrides.event || {}) },
    market: { ...base.market, ...(overrides.market || {}) },
    selection: { ...base.selection, ...(overrides.selection || {}) },
    old: overrides.old === undefined ? base.old : overrides.old,
    next: overrides.next === undefined ? base.next : overrides.next,
  }
}

function liveChange(overrides = {}) {
  const eventOverrides = overrides.event || {}
  return prematchChange({
    old: { ...prematchChange().old, mode: 'live' },
    next: { ...prematchChange().next, mode: 'live' },
    ...overrides,
    event: {
      mode: 'live',
      startTimeUtc: '2026-07-10T00:00:00.000Z',
      livePhase: 'first_half',
      liveMinute: 20,
      ...eventOverrides,
    },
  })
}

function prematchRule(overrides = {}) {
  const settings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.03,
      waterMoveDirection: 'both',
      cooldownSeconds: 60,
      prematchStartMinutesBeforeKickoff: 180,
      prematchStopMinutesBeforeKickoff: 5,
      bettingRuleId: 'bet-rule-explicit',
    },
  }), 'handicap')
  const rule = legacyMonitorRule(settings)
  return {
    ...rule,
    ...overrides,
    scope: { ...rule.scope, ...(overrides.scope || {}) },
    conditions: { ...rule.conditions, ...(overrides.conditions || {}) },
  }
}

function liveRule(overrides = {}) {
  const settings = startMonitorMode(normalizeMonitorSettings({
    live: {
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.03,
      waterMoveDirection: 'both',
      cooldownSeconds: 90,
      liveMinuteFrom: 10,
      liveMinuteTo: 75,
      includeFirstHalf: true,
      includeSecondHalf: true,
      includeHalfTime: false,
      bettingRuleId: 'bet-rule-live',
    },
  }), 'live')
  const rule = legacyMonitorRule(settings)
  return {
    ...rule,
    ...overrides,
    scope: { ...rule.scope, ...(overrides.scope || {}) },
    conditions: { ...rule.conditions, ...(overrides.conditions || {}) },
  }
}

test('legacy monitor cards become complete stable odds_delta rules without guessing a betting rule', () => {
  const configured = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      activePeriods: ['prematch'],
      minOdds: 0.8,
      maxOdds: 1.2,
      waterMoveThreshold: 0.04,
      waterMoveDirection: 'up',
      cooldownSeconds: 45,
      prematchStartMinutesBeforeKickoff: 120,
      prematchStopMinutesBeforeKickoff: 8,
      bettingRuleId: 'brule-7',
    },
  }), 'handicap')
  const [rule] = legacyMonitorRules(configured)

  assert.deepEqual(rule, {
    id: 'legacy-monitor-prematch-odds-delta',
    type: 'odds_delta',
    version: 1,
    enabled: true,
    scope: {
      modes: ['prematch'],
      markets: ['asian_handicap', 'total'],
      periods: ['full_time', 'first_half'],
      leagues: [],
    },
    conditions: {
      minDelta: 0.04,
      direction: 'up',
      oddsRange: { min: 0.8, max: 1.2 },
      kickoffWindow: { startMinutesBeforeKickoff: 120, stopMinutesBeforeKickoff: 8 },
      liveWindow: null,
    },
    cooldownSeconds: 45,
    bettingRuleId: 'brule-7',
  })
  assert.equal(legacyMonitorRule(configured).id, rule.id)

  const noBinding = startMonitorMode(normalizeMonitorSettings({ handicap: { bettingRuleId: null } }), 'handicap')
  assert.equal(legacyMonitorRule(noBinding).bettingRuleId, null)
  assert.deepEqual(legacyMonitorRules(normalizeMonitorSettings({})), [])
})

test('live legacy rule carries explicit phase and minute policy', () => {
  const rule = liveRule()
  assert.deepEqual(rule.scope.modes, ['live'])
  assert.deepEqual(rule.conditions.liveWindow, {
    minuteFrom: 10,
    minuteTo: 75,
    phases: ['first_half', 'second_half'],
  })
  assert.equal(rule.conditions.kickoffWindow, null)
  assert.equal(rule.bettingRuleId, 'bet-rule-live')
})

test('independent prematch and live cards produce two complete strategy rules', () => {
  let settings = startMonitorMode(normalizeMonitorSettings({}), 'prematch')
  settings.live = {
    ...settings.live,
    enabled: true,
    waterMoveThreshold: 0.03,
    liveMinuteFrom: 20,
    liveMinuteTo: 65,
    includeFirstHalf: false,
    includeSecondHalf: true,
    includeHalfTime: true,
  }
  settings = normalizeMonitorSettings(settings)
  const [prematch, live] = legacyMonitorRules(settings)
  assert.deepEqual(prematch.scope.modes, ['prematch'])
  assert.equal(prematch.conditions.liveWindow, null)
  assert.deepEqual(live.scope.modes, ['live'])
  assert.deepEqual(live.conditions.liveWindow, {
    minuteFrom: 20,
    minuteTo: 65,
    phases: ['second_half', 'half_time'],
  })
  assert.equal(evaluateOddsDelta(liveChange({ event: { livePhase: 'second_half', liveMinute: 52 } }), { rule: live }).matched, true)
})

test('odds_delta rejects incomplete or unsupported strategy rule schemas', async (t) => {
  const base = prematchRule()
  const cases = [
    ['id', { ...base, id: '' }],
    ['id', { ...base, id: 123 }],
    ['version', { ...base, version: 0 }],
    ['type', { ...base, type: 'handicap_move' }],
    ['enabled', omit(base, 'enabled')],
    ['scope.modes', { ...base, scope: {} }],
    ['scope.modes', { ...base, scope: { ...base.scope, modes: [] } }],
    ['scope.modes', { ...base, scope: { ...base.scope, modes: ['unknown'] } }],
    ['scope.markets', { ...base, scope: { ...base.scope, markets: [] } }],
    ['scope.markets', { ...base, scope: { ...base.scope, markets: ['moneyline'] } }],
    ['scope.periods', { ...base, scope: { ...base.scope, periods: [] } }],
    ['scope.periods', { ...base, scope: { ...base.scope, periods: ['unsupported_period'] } }],
    ['scope.leagues', { ...base, scope: { ...base.scope, leagues: null } }],
    ['scope.leagues', { ...base, scope: { ...base.scope, leagues: [''] } }],
    ['conditions', omit(base, 'conditions')],
    ['conditions.minDelta', { ...base, conditions: { ...base.conditions, minDelta: -1 } }],
    ['conditions.minDelta', { ...base, conditions: { ...base.conditions, minDelta: null } }],
    ['conditions.direction', { ...base, conditions: { ...base.conditions, direction: 'flat' } }],
    ['conditions.oddsRange', { ...base, conditions: { ...base.conditions, oddsRange: null } }],
    ['conditions.oddsRange.min', { ...base, conditions: { ...base.conditions, oddsRange: { min: 'bad', max: 1.2 } } }],
    ['conditions.oddsRange', { ...base, conditions: { ...base.conditions, oddsRange: { min: 1.3, max: 1.2 } } }],
    ['conditions.kickoffWindow', { ...base, conditions: { ...base.conditions, kickoffWindow: null } }],
    ['conditions.kickoffWindow', { ...base, conditions: omit(base.conditions, 'kickoffWindow') }],
    ['conditions.liveWindow', { ...base, conditions: omit(base.conditions, 'liveWindow') }],
    ['conditions.liveWindow', { ...base, conditions: { ...base.conditions, liveWindow: {} } }],
    ['conditions.kickoffWindow', { ...base, conditions: { ...base.conditions, kickoffWindow: { startMinutesBeforeKickoff: 5, stopMinutesBeforeKickoff: 10 } } }],
    ['cooldownSeconds', { ...base, cooldownSeconds: -1 }],
    ['signalTtlSeconds', { ...base, signalTtlSeconds: 0 }],
    ['signalTtlSeconds', { ...base, signalTtlSeconds: 1.5 }],
    ['signalTtlSeconds', { ...base, signalTtlSeconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['bettingRuleId', { ...base, bettingRuleId: 123 }],
    ['bettingRuleId', { ...base, bettingRuleId: { id: 'brule-object' } }],
  ]

  for (const [field, rule] of cases) {
    await t.test(field, () => {
      assert.equal(evaluateOddsDelta(prematchChange(), { rule }).skipReason, `strategy_rule_invalid:${field}`)
    })
  }
})

test('live strategy rule requires a complete live window', async (t) => {
  const base = liveRule()
  const cases = [
    ['conditions.kickoffWindow', { ...base, conditions: omit(base.conditions, 'kickoffWindow') }],
    ['conditions.liveWindow', { ...base, conditions: { ...base.conditions, liveWindow: null } }],
    ['conditions.liveWindow.phases', { ...base, conditions: { ...base.conditions, liveWindow: { ...base.conditions.liveWindow, phases: [] } } }],
    ['conditions.liveWindow.phases', { ...base, conditions: { ...base.conditions, liveWindow: { ...base.conditions.liveWindow, phases: ['break'] } } }],
    ['conditions.liveWindow', { ...base, conditions: { ...base.conditions, liveWindow: { ...base.conditions.liveWindow, minuteFrom: 80, minuteTo: 75 } } }],
  ]
  for (const [field, rule] of cases) {
    await t.test(field, () => {
      assert.equal(evaluateOddsDelta(liveChange(), { rule }).skipReason, `strategy_rule_invalid:${field}`)
    })
  }
})

test('registry rejects duplicate registrations and ignores disabled or unknown rules', () => {
  const engine = new StrategyRegistry().register('odds_delta', evaluateOddsDelta)
  assert.throws(() => engine.register('odds_delta', evaluateOddsDelta), /strategy-already-registered:odds_delta/)
  assert.deepEqual(engine.evaluate(prematchChange(), {
    rules: [
      { ...prematchRule(), enabled: false },
      { ...prematchRule(), id: 'unknown', type: 'unknown' },
    ],
    now: '2026-07-10T01:00:00.000Z',
  }), [])
})

test('registry enforces a synchronous cloneable evaluator contract', () => {
  assert.throws(
    () => new StrategyRegistry().register('async-test', async () => ({ matched: true })),
    /strategy-evaluator-must-be-synchronous:async-test/,
  )

  const thenable = new StrategyRegistry().register('thenable-test', () => Promise.resolve({ matched: true }))
  assert.throws(
    () => thenable.evaluate(prematchChange(), { rules: [{ id: 'thenable', type: 'thenable-test', enabled: true }] }),
    /strategy-evaluator-returned-thenable:thenable-test/,
  )

  const evaluator = new StrategyRegistry().register('clone-test', () => ({ matched: true }))
  assert.throws(
    () => evaluator.evaluate(prematchChange(), {
      rules: [{ id: 'clone', type: 'clone-test', enabled: true }],
      notCloneable: () => {},
    }),
    /strategy-context-not-cloneable/,
  )
})

test('registered strategies match independently for the same change', () => {
  const engine = new StrategyRegistry().register('odds_delta', evaluateOddsDelta)
  const decisions = engine.evaluate(prematchChange(), {
    rules: [
      { ...prematchRule(), id: 'rule-a', bettingRuleId: 'bet-a' },
      { ...prematchRule(), id: 'rule-b', bettingRuleId: 'bet-b' },
    ],
    now: '2026-07-10T01:00:00.000Z',
  })

  assert.deepEqual(decisions.map((item) => item.strategyId), ['rule-a', 'rule-b'])
  assert.notStrictEqual(decisions[0], decisions[1])
  assert.deepEqual(decisions.map((item) => item.bettingRuleId), ['bet-a', 'bet-b'])
})

test('registry gives each rule an isolated mutable context copy', () => {
  const mutable = { count: 0 }
  const engine = new StrategyRegistry().register('mutating-test', (_change, context) => {
    const before = context.mutable.count
    context.mutable.count += 1
    return { matched: true, strategyId: context.rule.id, before }
  })
  const decisions = engine.evaluate(prematchChange(), {
    rules: [
      { id: 'isolated-a', type: 'mutating-test', enabled: true },
      { id: 'isolated-b', type: 'mutating-test', enabled: true },
    ],
    mutable,
  })
  assert.deepEqual(decisions.map(({ before }) => before), [0, 0])
  assert.equal(mutable.count, 0)
})

test('registry ranks matching rules by priority then createdAt and id', () => {
  const engine = new StrategyRegistry().register('rank-test', (_change, { rule }) => ({
    matched: true,
    strategyId: rule.id,
    priority: rule.priority,
    createdAt: rule.createdAt,
  }))
  const decisions = engine.evaluate({}, { rules: [
    { id: 'z', type: 'rank-test', enabled: true, priority: 2, createdAt: '2026-07-11T00:00:00.000Z' },
    { id: 'b', type: 'rank-test', enabled: true, priority: 1, createdAt: '2026-07-11T00:00:01.000Z' },
    { id: 'a', type: 'rank-test', enabled: true, priority: 1, createdAt: '2026-07-11T00:00:01.000Z' },
  ] })
  assert.deepEqual(decisions.map((item) => item.strategyId), ['a', 'b', 'z'])
})

test('odds_delta accepts only odds-change and leaves inputs unchanged', () => {
  const change = prematchChange({ type: 'handicap-change' })
  const rule = prematchRule()
  const beforeChange = structuredClone(change)
  const beforeRule = structuredClone(rule)

  assert.deepEqual(evaluateOddsDelta(change, { rule }), {
    matched: false,
    skipReason: 'unsupported-change-type',
    dataQuality: assertDataQuality(false),
  })
  assert.deepEqual(change, beforeChange)
  assert.deepEqual(rule, beforeRule)

  for (const type of ['market-suspended', 'market-reopened', 'event-added', 'event-removed']) {
    assert.equal(evaluateOddsDelta(prematchChange({ type }), { rule }).skipReason, 'unsupported-change-type')
  }
})

test('odds_delta fails closed when canonical identities or confidence are unsafe', () => {
  const rule = prematchRule()
  assert.equal(evaluateOddsDelta(prematchChange({ selectionIdentity: null, selection: { selectionIdentity: null } }), { rule }).skipReason, 'data_incomplete:selection_identity_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ eventIdentity: null, event: { eventKey: null } }), { rule }).skipReason, 'data_incomplete:event_identity_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ event: { identityConfidence: 'low' } }), { rule }).skipReason, 'data_incomplete:identity_confidence_low')
  assert.equal(evaluateOddsDelta(prematchChange({ event: { identityConfidence: undefined } }), { rule }).skipReason, 'data_incomplete:identity_confidence_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ event: { identityConfidence: 'unknown' } }), { rule }).skipReason, 'data_incomplete:identity_confidence_not_high')
  assert.equal(evaluateOddsDelta(prematchChange({ eventIdentity: 'fallback-event', event: { eventKey: 'fallback-event' } }), { rule }).skipReason, 'data_incomplete:event_identity_invalid')
  assert.equal(evaluateOddsDelta(prematchChange({ selectionIdentity: 'fallback-selection', selection: { selectionIdentity: 'fallback-selection' } }), { rule }).skipReason, 'data_incomplete:selection_identity_invalid')
})

test('odds_delta requires stable change evidence and canonical identity hierarchy', () => {
  const rule = prematchRule()
  assert.equal(evaluateOddsDelta(prematchChange({ changeId: '' }), { rule }).skipReason, 'data_incomplete:change_id_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ changeId: 'unstable-runtime-id' }), { rule }).skipReason, 'data_incomplete:change_id_invalid')
  assert.equal(evaluateOddsDelta(prematchChange({ observedAt: null }), { rule }).skipReason, 'data_incomplete:observed_at_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ observedAt: 'invalid' }), { rule }).skipReason, 'data_incomplete:observed_at_invalid')
  assert.equal(evaluateOddsDelta(prematchChange({ marketIdentity: null, market: { marketIdentity: null } }), { rule }).skipReason, 'data_incomplete:market_identity_missing')

  const otherMarket = 'crown|football|gid=4001|full_time|asian_handicap|RATIO_R'
  assert.equal(evaluateOddsDelta(prematchChange({ marketIdentity: otherMarket, market: { marketIdentity: otherMarket } }), { rule }).skipReason, 'data_incomplete:market_identity_invalid')
  assert.equal(evaluateOddsDelta(prematchChange({ selectionIdentity: `${otherMarket}|home`, selection: { selectionIdentity: `${otherMarket}|home` } }), { rule }).skipReason, 'data_incomplete:selection_identity_invalid')
  assert.equal(evaluateOddsDelta(prematchChange({ selection: { side: 'away' } }), { rule }).skipReason, 'data_incomplete:selection_side_invalid')

  const mismatchedNextSide = prematchChange()
  mismatchedNextSide.next.selection.side = 'away'
  assert.equal(evaluateOddsDelta(mismatchedNextSide, { rule }).skipReason, 'data_incomplete:selection_side_invalid')
  const mismatchedOldSide = prematchChange()
  mismatchedOldSide.old.selection.side = 'away'
  assert.equal(evaluateOddsDelta(mismatchedOldSide, { rule }).skipReason, 'data_incomplete:selection_side_invalid')

  const mismatchedOld = prematchChange()
  mismatchedOld.old.selection.selectionIdentity = `${mismatchedOld.marketIdentity}|away`
  assert.equal(evaluateOddsDelta(mismatchedOld, { rule }).skipReason, 'data_incomplete:selection_identity_invalid')
  const mismatchedNextMarket = prematchChange()
  mismatchedNextMarket.next.market.marketIdentity = 'crown|football|gid=4001|full_time|asian_handicap|RATIO_R'
  assert.equal(evaluateOddsDelta(mismatchedNextMarket, { rule }).skipReason, 'data_incomplete:market_identity_invalid')
  for (const [field, value] of [['period', 'first_half'], ['marketType', 'total'], ['lineKey', 'RATIO_OU']]) {
    const mismatchedFact = prematchChange()
    mismatchedFact.next.market[field] = value
    assert.equal(evaluateOddsDelta(mismatchedFact, { rule }).skipReason, 'data_incomplete:market_identity_invalid')
  }

  const derived = prematchChange({ selection: { side: null } })
  derived.next.selection.side = null
  const decision = evaluateOddsDelta(derived, { rule })
  assert.equal(decision.matched, true)
  assert.equal(decision.target.side, 'home')
  assert.equal(decision.evidence.changeId, derived.changeId)
})

test('odds_delta accepts only canonical ISO UTC fact and evaluation timestamps', () => {
  const rule = prematchRule()
  for (const observedAt of ['0', '2026-07-10T01:00:00.000', '2026-02-30T01:00:00.000Z']) {
    assert.equal(evaluateOddsDelta(prematchChange({ observedAt }), { rule }).skipReason, 'data_incomplete:observed_at_invalid')
  }
  for (const startTimeUtc of ['0', '2026-07-10T03:00:00.000', '2026-02-30T03:00:00.000Z']) {
    assert.equal(evaluateOddsDelta(prematchChange({ event: { startTimeUtc } }), { rule }).skipReason, 'data_incomplete:start_time_invalid')
  }
  for (const now of ['0', '2026-07-10T01:00:00.000', '2026-02-30T01:00:00.000Z']) {
    assert.equal(evaluateOddsDelta(prematchChange(), { rule, now }).skipReason, 'data_incomplete:evaluation_time_invalid')
  }
})

test('odds_delta fails closed on missing odds and prematch time evidence', () => {
  const rule = prematchRule()
  const missingOld = prematchChange()
  delete missingOld.old.selection.odds
  assert.equal(evaluateOddsDelta(missingOld, { rule }).skipReason, 'data_incomplete:old_odds_missing')

  const missingNext = prematchChange()
  delete missingNext.next.selection.odds
  assert.equal(evaluateOddsDelta(missingNext, { rule }).skipReason, 'data_incomplete:next_odds_missing')
  assert.equal(evaluateOddsDelta(prematchChange({ event: { startTimeUtc: null } }), { rule }).skipReason, 'data_incomplete:start_time_missing')
})

test('odds_delta fails closed when live clock or phase is missing', () => {
  const rule = liveRule()
  assert.equal(evaluateOddsDelta(liveChange({ event: { liveMinute: null } }), { rule }).skipReason, 'data_incomplete:live_clock_missing')
  assert.equal(evaluateOddsDelta(liveChange({ event: { livePhase: null } }), { rule }).skipReason, 'data_incomplete:live_period_missing')
})

test('mode, market and period scope suppress mismatched changes', () => {
  const rule = prematchRule()
  assert.equal(evaluateOddsDelta(liveChange(), { rule }).skipReason, 'mode-not-allowed')
  const unsupportedMarket = coherentIdentityChange({ marketType: 'moneyline' })
  assert.equal(evaluateOddsDelta(unsupportedMarket, { rule }).skipReason, 'market-not-allowed')
  const unsupportedPeriod = coherentIdentityChange({ period: 'second_half' })
  assert.equal(evaluateOddsDelta(unsupportedPeriod, { rule }).skipReason, 'period-not-allowed')
})

test('direction, delta and next odds range are enforced', () => {
  assert.equal(evaluateOddsDelta(prematchChange(), { rule: prematchRule({ conditions: { direction: 'down' } }) }).skipReason, 'direction-mismatch')

  const small = prematchChange()
  small.old.selection.odds = 0.97
  assert.equal(evaluateOddsDelta(small, { rule: prematchRule() }).skipReason, 'delta-below-threshold')

  const high = prematchChange()
  high.next.selection.odds = 1.3
  assert.equal(evaluateOddsDelta(high, { rule: prematchRule() }).skipReason, 'odds-out-of-range')
})

test('numeric no-op odds changes never produce a Signal even with zero threshold', () => {
  const change = prematchChange()
  change.old.selection.odds = 0.99
  change.old.selection.oddsRaw = '0.990'
  change.next.selection.odds = 0.99
  change.next.selection.oddsRaw = '0.99'
  assert.equal(evaluateOddsDelta(change, {
    rule: prematchRule({ conditions: { minDelta: 0 } }),
  }).skipReason, 'no-odds-change')
})

test('prematch kickoff and live windows use deterministic observed time evidence', () => {
  assert.equal(evaluateOddsDelta(prematchChange(), {
    rule: prematchRule(),
    now: '2026-07-09T20:00:00.000Z',
  }).skipReason, 'kickoff-window-mismatch')

  assert.equal(evaluateOddsDelta(liveChange({ event: { liveMinute: 5 } }), { rule: liveRule() }).skipReason, 'live-window-mismatch')
  assert.equal(evaluateOddsDelta(liveChange({ event: { livePhase: 'half_time', liveMinute: null } }), { rule: liveRule() }).skipReason, 'live-window-mismatch')
})

test('injected now controls window evaluation without rewriting factual observedAt', () => {
  const decision = evaluateOddsDelta(prematchChange(), {
    rule: prematchRule(),
    now: '2026-07-10T01:30:00.000Z',
  })
  assert.equal(decision.matched, true)
  assert.equal(decision.trigger.observedAt, '2026-07-10T01:00:00.000Z')
  assert.equal(decision.evidence.minutesBeforeKickoff, 90)
})

test('default league policy applies while active manual tracking can bypass it', () => {
  const change = prematchChange({ event: { league: '不在默认名单的联赛' } })
  const context = {
    rule: prematchRule(),
    defaultLeagues: DEFAULT_LEAGUES_CONFIG,
    now: '2026-07-10T01:00:00.000Z',
  }
  assert.equal(evaluateOddsDelta(change, context).skipReason, 'league-not-allowed')

  const tracked = {
    eventKey: change.eventIdentity,
    league: change.event.league,
    homeTeam: change.event.homeTeam,
    awayTeam: change.event.awayTeam,
    mode: 'prematch',
    trackingStatus: 'active',
  }
  assert.equal(evaluateOddsDelta(change, { ...context, trackedMatches: [tracked] }).matched, true)
  assert.equal(evaluateOddsDelta(change, { ...context, trackedMatches: [{ ...tracked, trackingStatus: 'inactive' }] }).skipReason, 'league-not-allowed')
})

test('manual tracking fallback never overrides a conflicting event identity or matches empty legacy fields', () => {
  const change = prematchChange({ event: { league: '非默认联赛' } })
  const context = { rule: prematchRule(), defaultLeagues: DEFAULT_LEAGUES_CONFIG }
  const matchingNames = {
    league: change.event.league,
    homeTeam: change.event.homeTeam,
    awayTeam: change.event.awayTeam,
    mode: 'prematch',
    trackingStatus: 'active',
  }
  assert.equal(evaluateOddsDelta(change, {
    ...context,
    trackedMatches: [{ ...matchingNames, eventKey: 'crown|football|gid=9999' }],
  }).skipReason, 'league-not-allowed')
  assert.equal(evaluateOddsDelta(change, {
    ...context,
    trackedMatches: [matchingNames],
  }).matched, true)

  const emptyTeam = prematchChange({ event: { league: '非默认联赛', homeTeam: '' } })
  assert.equal(evaluateOddsDelta(emptyTeam, {
    ...context,
    trackedMatches: [{ ...matchingNames, eventKey: null, homeTeam: '' }],
  }).skipReason, 'league-not-allowed')
})

test('explicit strategy league scope is enforced', () => {
  const rule = prematchRule({ scope: { leagues: ['另一联赛'] } })
  const change = prematchChange()
  assert.equal(evaluateOddsDelta(change, { rule }).skipReason, 'league-not-allowed')
  assert.equal(evaluateOddsDelta(change, {
    rule,
    trackedMatches: [{ eventKey: change.eventIdentity, mode: 'prematch', trackingStatus: 'active' }],
  }).skipReason, 'league-not-allowed')
})

test('matched decision contains complete Signal evidence and preserves explicit bettingRuleId', () => {
  const decision = evaluateOddsDelta(prematchChange(), {
    rule: prematchRule(),
    defaultLeagues: DEFAULT_LEAGUES_CONFIG,
  })
  assert.equal(decision.matched, true)
  assert.equal(decision.strategyId, 'legacy-monitor-prematch-odds-delta')
  assert.equal(decision.strategyVersion, 1)
  assert.equal(decision.bettingRuleId, 'bet-rule-explicit')
  assert.equal(decision.cooldownSeconds, 60)
  assert.equal(decision.target.selectionIdentity, prematchChange().selectionIdentity)
  assert.equal(decision.target.eventIdentity, prematchChange().eventIdentity)
  assert.deepEqual(decision.trigger, {
    type: 'odds-change',
    direction: 'up',
    delta: 0.05,
    threshold: 0.03,
    observedAt: '2026-07-10T01:00:00.000Z',
  })
  assert.equal(decision.evidence.oldOdds, 0.94)
  assert.equal(decision.evidence.nextOdds, 0.99)
  assert.equal(decision.evidence.homeTeam, '主队')
  assert.equal(decision.evidence.awayTeam, '客队')
  assert.equal(decision.evidence.handicapRaw, '+0/0.5')
  assert.equal(decision.evidence.oldOddsRaw, '0.940')
  assert.equal(decision.evidence.nextOddsRaw, '0.990')
  assert.equal(decision.dataQuality.complete, true)
})

function assertDataQuality(complete) {
  return {
    complete,
    identityConfidence: 'unknown',
    missing: [],
    warnings: [],
  }
}

function omit(value, key) {
  const copy = structuredClone(value)
  delete copy[key]
  return copy
}

function coherentIdentityChange({ marketType = 'asian_handicap', period = 'full_time', lineKey = 'RATIO_R', side = 'home' } = {}) {
  const change = prematchChange()
  const marketIdentity = `${change.eventIdentity}|${period}|${marketType}|${lineKey}`
  const selectionIdentity = `${marketIdentity}|${side}`
  change.marketIdentity = marketIdentity
  change.selectionIdentity = selectionIdentity
  change.market = { ...change.market, marketIdentity, marketType, period, lineKey }
  change.selection = { ...change.selection, selectionIdentity, side }
  change.old = {
    ...change.old,
    market: { ...change.old.market, marketIdentity, marketType, period, lineKey },
    selection: { ...change.old.selection, selectionIdentity, side },
  }
  change.next = {
    ...change.next,
    market: { ...change.next.market, marketIdentity, marketType, period, lineKey },
    selection: { ...change.next.selection, selectionIdentity, side },
  }
  return change
}

function matchedSignalInput({ rule = prematchRule(), change = prematchChange() } = {}) {
  const decision = evaluateOddsDelta(change, {
    rule,
    defaultLeagues: DEFAULT_LEAGUES_CONFIG,
  })
  assert.equal(decision.matched, true)
  return { rule, change, decision }
}

test('the same matched rule and Change always produce one deterministic Signal ID', () => {
  const input = matchedSignalInput()
  const first = createSignal(input)
  const second = createSignal({
    decision: Object.fromEntries(Object.entries(input.decision).reverse()),
    change: Object.fromEntries(Object.entries(input.change).reverse()),
    rule: Object.fromEntries(Object.entries(input.rule).reverse()),
  })

  assert.equal(first.signalId, second.signalId)
  assert.equal(first.signalKey, `${input.rule.id}|${input.change.selectionIdentity}`)
  assert.equal(first.observedAt, input.change.observedAt)
  assert.equal(first.expiresAt, '2026-07-10T01:01:00.000Z')
  assert.equal(first.status, 'pending')
  assert.equal(first.bettingRuleId, 'bet-rule-explicit')
  assert.equal(first.evidence.homeTeam, '主队')
  assert.equal(first.evidence.oldOddsRaw, '0.940')
})

test('Signal ID binds strategy/version, selection, Change, direction, and threshold', () => {
  const base = matchedSignalInput()
  const baseId = createSignal(base).signalId
  const variants = []

  for (const patch of [
    { rule: { ...base.rule, id: `${base.rule.id}-other` } },
    { rule: { ...base.rule, version: base.rule.version + 1 } },
    { change: coherentIdentityChange({ side: 'away' }) },
    { change: prematchChange({ changeId: 'b'.repeat(64) }) },
    {
      change: prematchChange({
        old: { ...prematchChange().old, selection: { ...prematchChange().old.selection, odds: 1.04, oddsRaw: '1.040' } },
      }),
    },
    { rule: prematchRule({ conditions: { minDelta: 0.04 } }) },
  ]) {
    const rule = patch.rule ?? base.rule
    const change = patch.change ?? base.change
    variants.push(createSignal(matchedSignalInput({ rule, change })).signalId)
  }

  assert.equal(new Set([baseId, ...variants]).size, variants.length + 1)
})

test('Signal persists only normalized evidence and rejects incomplete/noncanonical input', () => {
  const input = matchedSignalInput()
  input.change.rawProviderResponse = '<secret />'
  input.change.headers = { authorization: 'Bearer secret' }
  input.decision.evidence.raw = '<secret />'
  input.decision.evidence.session = 'secret'
  input.decision.target.candidate = { candidateId: 'candidate-secret' }
  input.decision.dataQuality.token = 'secret'
  const signal = createSignal(input)
  const encoded = JSON.stringify(signal)

  assert.doesNotMatch(encoded, /secret|rawProviderResponse|headers|authorization|candidate|token/i)
  assert.deepEqual(Object.keys(signal.evidence).sort(), [
    'awayTeam',
    'changeId',
    'handicap',
    'handicapRaw',
    'homeTeam',
    'league',
    'liveMinute',
    'livePhase',
    'marketType',
    'minutesBeforeKickoff',
    'mode',
    'nextOdds',
    'nextOddsRaw',
    'oldOdds',
    'oldOddsRaw',
    'period',
    'source',
  ])

  assert.throws(() => createSignal({ ...input, decision: { ...input.decision, matched: false } }), /matched decision/)
  assert.throws(() => createSignal({ ...input, change: { ...input.change, changeId: 'legacy-change-id' } }), /changeId/)
  assert.throws(() => createSignal({ ...input, decision: {
    ...input.decision,
    target: { ...input.decision.target, selectionIdentity: 'not-canonical' },
  } }), /selectionIdentity/)
  assert.throws(() => createSignal({ ...input, rule: { ...input.rule, cooldownSeconds: -1 } }), /cooldownSeconds/)
  assert.throws(() => createSignal({
    ...input,
    rule: { ...input.rule, signalTtlSeconds: 60 },
    decision: { ...input.decision, signalTtlSeconds: 30 },
  }), /signalTtlSeconds/)
  assert.throws(() => createSignal({ ...input, change: { ...input.change, schemaVersion: 1 } }), /schemaVersion/)
  assert.throws(() => createSignal({ ...input, change: {
    ...input.change,
    marketIdentity: `${input.change.eventIdentity}|first_half|asian_handicap|RATIO_R`,
  } }), /marketIdentity/)
  assert.throws(() => createSignal({ ...input, decision: {
    ...input.decision,
    trigger: { ...input.decision.trigger, type: 'handicap-change' },
  } }), /trigger.type/)
  assert.throws(() => createSignal({ ...input, decision: {
    ...input.decision,
    trigger: { ...input.decision.trigger, threshold: 0.01 },
  } }), /threshold/)
})
