import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMonitorBetCandidate,
  buildMonitorBetCandidateFromSignal,
  oppositeSide,
} from '../src/crown/betting/monitor-bet-signal.mjs'

function snapshot(side, oddsRaw = '0.80') {
  return {
    odds: { raw: oddsRaw, value: Number(oddsRaw), field: side === 'home' ? 'IOR_REH' : 'IOR_REC' },
    handicap: { raw: '0', value: 0, field: 'RATIO_RE' },
    event: {
      eventId: '8878931',
      eventKey: 'crown|gid=8878931',
      league: '美国足球冠军联赛',
      homeTeam: '主队',
      awayTeam: '客队',
      ids: { gid: '8878931' },
    },
    market: {
      marketId: 'm1',
      marketKey: 'm1',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '0',
      ratioField: 'RATIO_RE',
    },
    selection: {
      selectionId: `${side}-1`,
      selectionKey: `${side}-1`,
      side,
      oddsRaw,
      odds: Number(oddsRaw),
      oddsField: side === 'home' ? 'IOR_REH' : 'IOR_REC',
      suspended: false,
    },
    mode: 'prematch',
    capturedAt: '2026-07-09T06:00:00.000Z',
  }
}

function change(direction = 'up') {
  return {
    type: 'odds-change',
    key: 'change-1',
    capturedAt: '2026-07-09T06:00:00.000Z',
    old: snapshot('home', direction === 'up' ? '0.80' : '0.90'),
    next: snapshot('home', direction === 'up' ? '0.90' : '0.80'),
    event: snapshot('home').event,
    market: snapshot('home').market,
    selection: snapshot('home').selection,
  }
}

test('opposite side is deterministic for supported markets', () => {
  assert.equal(oppositeSide('home'), 'away')
  assert.equal(oppositeSide('away'), 'home')
  assert.equal(oppositeSide('over'), 'under')
  assert.equal(oppositeSide('under'), 'over')
  assert.equal(oppositeSide('draw'), null)
})

test('odds up creates reverse-side candidate', () => {
  const candidate = buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up', monitorMode: 'handicap', delta: 0.1 },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.82') : null,
  })
  assert.equal(candidate.status, 'eligible')
  assert.equal(candidate.action, 'reverse')
  assert.equal(candidate.target.selection.side, 'away')
  assert.equal(candidate.reason, 'monitor-up-reverse')
})

test('reverse lookup keeps the same market line', () => {
  let lookup = null
  const candidate = buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up', monitorMode: 'handicap', delta: 0.1 },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
    findLatestSelection: (query) => {
      lookup = query
      return query.side === 'away' && query.lineKey === 'RATIO_RE' ? snapshot('away', '0.82') : null
    },
  })

  assert.equal(candidate.status, 'eligible')
  assert.equal(lookup.lineKey, 'RATIO_RE')
})

test('odds down creates same-side candidate', () => {
  const candidate = buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down', monitorMode: 'handicap', delta: 0.1 },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
  })
  assert.equal(candidate.status, 'eligible')
  assert.equal(candidate.action, 'follow')
  assert.equal(candidate.target.selection.side, 'home')
  assert.equal(candidate.reason, 'monitor-down-follow')
})

test('candidate is skipped when monitor did not trigger or odds is below betting lower limit', () => {
  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: false },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
  }).skipReason, 'monitor-not-triggered')

  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down' },
    bettingRule: { id: 'brule_1', minOdds: 0.85 },
  }).skipReason, 'betting-odds-below-min')
})

test('betting rule can force follow or reverse direction', () => {
  assert.equal(buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up' },
    bettingRule: { id: 'brule_1', minOdds: 0.75, betDirectionMode: 'follow' },
  }).action, 'follow')

  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down' },
    bettingRule: { id: 'brule_1', minOdds: 0.75, betDirectionMode: 'reverse' },
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.82') : null,
  }).action, 'reverse')
})

test('canonical rule always reverses home rise to away and checks the reverse price range', () => {
  const canonicalRule = {
    id: 'abrule_1', monitorEnabled: true, marketType: 'asian_handicap', monitoredSide: 'home',
    targetOddsMin: '0.80', targetOddsMax: '0.90',
  }
  const eligible = buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up' },
    bettingRule: canonicalRule,
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.85') : null,
  })
  assert.equal(eligible.status, 'eligible')
  assert.equal(eligible.action, 'reverse')
  assert.equal(eligible.target.selection.side, 'away')

  const sourceInRangeButReverseOut = buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up' },
    bettingRule: canonicalRule,
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.95') : null,
  })
  assert.equal(sourceInRangeButReverseOut.skipReason, 'betting-odds-above-max')
})

test('canonical total rule always reverses over rise to under', () => {
  const input = change('up')
  input.next.selection.side = 'over'
  input.selection.side = 'over'
  input.next.market.marketType = 'total'
  input.market.marketType = 'total'
  const candidate = buildMonitorBetCandidate(input, {
    monitorDecision: { triggered: true, direction: 'up' },
    bettingRule: { id: 'abrule_total', monitorEnabled: true, marketType: 'total', monitoredSide: 'over', targetOddsMin: '0.75', targetOddsMax: '1.1' },
    findLatestSelection: ({ side }) => side === 'under' ? { ...snapshot('away', '0.86'), selection: { ...snapshot('away', '0.86').selection, side: 'under' } } : null,
  })
  assert.equal(candidate.status, 'eligible')
  assert.equal(candidate.action, 'reverse')
  assert.equal(candidate.target.selection.side, 'under')
})

function signal(overrides = {}) {
  return {
    schemaVersion: 2,
    signalId: 'a'.repeat(64),
    signalKey: 'strategy-1|crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
    strategyId: 'strategy-1',
    strategyVersion: 3,
    observedAt: '2026-07-09T06:00:00.000Z',
    expiresAt: '2026-07-09T06:05:00.000Z',
    trigger: {
      type: 'odds-change',
      direction: 'down',
      delta: 0.1,
      threshold: 0.03,
      observedAt: '2026-07-09T06:00:00.000Z',
    },
    target: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      side: 'home',
    },
    evidence: {
      changeId: 'b'.repeat(64),
      oldOdds: 0.9,
      nextOdds: 0.8,
      mode: 'prematch',
      league: 'Test League',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicap: 0,
      minutesBeforeKickoff: 60,
      livePhase: null,
      liveMinute: null,
      source: { endpointKind: 'get_game_more' },
    },
    bettingRuleId: 'brule_1',
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
    status: 'pending',
    ...overrides,
  }
}

function canonicalSnapshot(side = 'home', odds = 0.8, overrides = {}) {
  const row = snapshot(side, String(odds))
  row.event.eventKey = 'crown|football|gid=8878931'
  row.market.lineKey = 'RATIO_RE'
  row.market.marketIdentity = `crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE`
  row.selection.selectionIdentity = `${row.market.marketIdentity}|${side}`
  row.capturedAt = '2026-07-09T06:00:30.000Z'
  return { ...row, ...overrides }
}

test('one Signal and betting rule produce one deterministic candidate ID', () => {
  const input = signal()
  const options = {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, maxOdds: 1.2, betDirectionMode: 'follow' },
    findLatestSelection: () => canonicalSnapshot('home', 0.8),
    now: '2026-07-09T06:01:00.000Z',
  }
  const a = buildMonitorBetCandidateFromSignal(input, options)
  const b = buildMonitorBetCandidateFromSignal({ ...input, target: { ...input.target } }, options)
  assert.equal(a.candidateId, b.candidateId)
  assert.equal(a.candidateId.length, 64)
  assert.equal(a.signalId, input.signalId)
  assert.equal(a.status, 'eligible')
  assert.equal(a.strategy.id, 'strategy-1')
  assert.equal(a.strategy.version, 3)
  assert.equal(a.createdAt, input.observedAt)
  assert.equal(a.target.selection.selectionIdentity, input.target.selectionIdentity)
})

test('candidate creation time is stable across evaluation times', () => {
  const input = signal()
  const options = {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, betDirectionMode: 'follow' },
    findLatestSelection: () => canonicalSnapshot('home', 0.8),
  }
  const first = buildMonitorBetCandidateFromSignal(input, { ...options, now: '2026-07-09T06:01:00.000Z' })
  const later = buildMonitorBetCandidateFromSignal(input, { ...options, now: '2026-07-09T06:04:00.000Z' })
  assert.equal(first.createdAt, input.observedAt)
  assert.equal(later.createdAt, input.observedAt)
  assert.equal(first.candidateId, later.candidateId)
})

test('unbound, missing, and disabled betting rules fail closed with one skip reason', () => {
  const now = '2026-07-09T06:01:00.000Z'
  const unbound = buildMonitorBetCandidateFromSignal(signal({ bettingRuleId: null }), { now })
  const missing = buildMonitorBetCandidateFromSignal(signal(), { now, bettingRule: null })
  const disabled = buildMonitorBetCandidateFromSignal(signal(), {
    now,
    bettingRule: { id: 'brule_1', enabled: false },
  })
  for (const candidate of [unbound, missing, disabled]) {
    assert.equal(candidate.status, 'skipped')
    assert.equal(candidate.skipReason, 'betting-rule-unbound')
  }
  assert.equal(unbound.bindingStatus, 'unbound')
  assert.equal(missing.bindingStatus, 'not-found')
  assert.equal(disabled.bindingStatus, 'disabled')
  assert.equal(unbound.candidateId, buildMonitorBetCandidateFromSignal(signal({ bettingRuleId: null }), { now }).candidateId)
})

test('follow and reverse read only the canonical same line latest state', () => {
  const queries = []
  const lookup = (query) => {
    queries.push(query)
    return canonicalSnapshot(query.side, query.side === 'home' ? 0.8 : 0.82)
  }
  const follow = buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, betDirectionMode: 'follow' },
    findLatestSelection: lookup,
    now: '2026-07-09T06:01:00.000Z',
  })
  const reverse = buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, betDirectionMode: 'reverse' },
    findLatestSelection: lookup,
    now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(follow.action, 'follow')
  assert.equal(reverse.action, 'reverse')
  assert.deepEqual(queries.map(({ eventKey, period, marketType, lineKey, side }) => ({ eventKey, period, marketType, lineKey, side })), [
    { eventKey: 'crown|football|gid=8878931', period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', side: 'home' },
    { eventKey: 'crown|football|gid=8878931', period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', side: 'home' },
    { eventKey: 'crown|football|gid=8878931', period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', side: 'away' },
  ])
})

test('Signal candidate rejects mismatched line, suspension, odds limits, expiry, and stale state', () => {
  const base = {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, maxOdds: 1, betDirectionMode: 'follow' },
    now: '2026-07-09T06:01:00.000Z',
  }
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    findLatestSelection: () => canonicalSnapshot('home', 0.8, { market: { ...canonicalSnapshot().market, lineKey: 'OTHER', marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|OTHER' } }),
  }).skipReason, 'source-identity-mismatch')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    findLatestSelection: () => canonicalSnapshot('home', 0.8, { selection: { ...canonicalSnapshot().selection, suspended: true } }),
  }).skipReason, 'target-selection-suspended')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    findLatestSelection: () => canonicalSnapshot('home', 0.7),
  }).skipReason, 'betting-odds-below-min')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    findLatestSelection: () => canonicalSnapshot('home', 1.1),
  }).skipReason, 'betting-odds-above-max')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    now: '2026-07-09T06:06:00.000Z',
    findLatestSelection: () => canonicalSnapshot('home', 0.8),
  }).skipReason, 'signal-expired')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...base,
    findLatestSelection: () => canonicalSnapshot('home', 0.8, { capturedAt: '2026-07-09T05:59:59.000Z' }),
  }).skipReason, 'target-state-stale')
})

test('reverse candidate also validates the source state before reading its opposite side', () => {
  const rule = { id: 'brule_1', enabled: true, minOdds: 0.75, betDirectionMode: 'reverse' }
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: rule,
    now: '2026-07-09T06:01:00.000Z',
    findLatestSelection: ({ side }) => side === 'home'
      ? canonicalSnapshot('home', 0.8, { selection: { ...canonicalSnapshot().selection, suspended: true } })
      : canonicalSnapshot('away', 0.82),
  }).skipReason, 'source-selection-suspended')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: rule,
    now: '2026-07-09T06:01:00.000Z',
    findLatestSelection: ({ side }) => side === 'home'
      ? canonicalSnapshot('home', 0.8, { capturedAt: '2026-07-09T05:59:59.000Z' })
      : canonicalSnapshot('away', 0.82),
  }).skipReason, 'source-state-stale')
})

test('Signal candidate rejects a betting rule bound to another market type', () => {
  const result = buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: { id: 'brule_1', enabled: true, marketType: 'total', minOdds: 0.75, betDirectionMode: 'follow' },
    findLatestSelection: () => canonicalSnapshot('home', 0.8),
    now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.skipReason, 'betting-market-mismatch')
})

test('Signal candidate defers when the canonical rule version is unavailable', () => {
  let lookups = 0
  const result = buildMonitorBetCandidateFromSignal(signal(), {
    bettingRule: { id: 'brule_1', version: 4, monitorEnabled: true, monitoredSide: 'home', targetOddsMin: '0.75', targetOddsMax: '1.00' },
    findLatestSelection: () => { lookups += 1; return canonicalSnapshot('away', 0.8) },
    now: '2026-07-09T06:01:00.000Z',
    deferUnresolvedBinding: true,
  })
  assert.equal(result.status, 'deferred')
  assert.equal(result.deferReason, 'betting-rule-version-unavailable')
  assert.equal(lookups, 0)
})

test('Signal candidate rejects non-roundtripping calendar timestamps and expires at equality', () => {
  const options = {
    bettingRule: { id: 'brule_1', enabled: true, minOdds: 0.75, betDirectionMode: 'follow' },
    findLatestSelection: () => canonicalSnapshot('home', 0.8),
  }
  assert.throws(() => buildMonitorBetCandidateFromSignal(signal({ observedAt: '2026-02-31T06:00:00.000Z' }), {
    ...options, now: '2026-03-03T06:00:01.000Z',
  }), /observedAt|canonical/)
  assert.throws(() => buildMonitorBetCandidateFromSignal(signal(), {
    ...options, now: '2026-02-31T06:01:00.000Z',
  }), /now|canonical/)
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...options, now: signal().expiresAt,
  }).skipReason, 'signal-expired')
  assert.equal(buildMonitorBetCandidateFromSignal(signal(), {
    ...options,
    findLatestSelection: () => canonicalSnapshot('home', 0.8, { capturedAt: '2026-02-31T06:00:30.000Z' }),
    now: '2026-07-09T06:01:00.000Z',
  }).skipReason, 'target-state-invalid')
})
