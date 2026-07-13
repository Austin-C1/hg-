import assert from 'node:assert/strict'
import test from 'node:test'

import { lockReverseSelection } from '../src/crown/betting/locked-selection.mjs'

function signal(overrides = {}) {
  const base = {
    signalId: 'a'.repeat(64),
    observedAt: '2026-07-11T02:00:00.000Z',
    target: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      side: 'home',
    },
    evidence: {
      marketType: 'asian_handicap',
      period: 'full_time',
      handicap: -0.5,
      handicapRaw: '-0.5',
    },
  }
  return {
    ...base,
    ...overrides,
    target: { ...base.target, ...overrides.target },
    evidence: { ...base.evidence, ...overrides.evidence },
  }
}

function snapshot(overrides = {}) {
  const marketIdentity = 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE'
  const base = {
    provider: 'crown',
    capturedAt: '2026-07-11T02:01:00.000Z',
    event: { eventKey: 'crown|football|gid=8878931' },
    market: {
      marketIdentity,
      period: 'full_time',
      marketType: 'asian_handicap',
      lineKey: 'RATIO_RE',
      handicap: -0.5,
      handicapRaw: '-0.50',
    },
    selection: {
      selectionIdentity: `${marketIdentity}|away`,
      side: 'away',
      odds: 0.88,
      suspended: false,
    },
  }
  return {
    ...base,
    ...overrides,
    event: { ...base.event, ...overrides.event },
    market: { ...base.market, ...overrides.market },
    selection: { ...base.selection, ...overrides.selection },
  }
}

test('locks the strict opposite selection on the same canonical market line', () => {
  const queries = []
  const latest = snapshot()
  const locked = lockReverseSelection(signal(), (query) => {
    queries.push(query)
    return latest
  })

  assert.deepEqual(queries, [{
    provider: 'crown',
    eventKey: 'crown|football|gid=8878931',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineKey: 'RATIO_RE',
    side: 'away',
  }])
  assert.equal(locked.provider, 'crown')
  assert.equal(locked.eventKey, 'crown|football|gid=8878931')
  assert.equal(locked.period, 'full_time')
  assert.equal(locked.marketType, 'asian_handicap')
  assert.equal(locked.lineKey, 'RATIO_RE')
  assert.equal(locked.sourceSide, 'home')
  assert.equal(locked.side, 'away')
  assert.equal(locked.marketIdentity, signal().target.marketIdentity)
  assert.equal(locked.selectionIdentity, `${signal().target.marketIdentity}|away`)
  assert.equal(locked.handicap, -0.5)
  assert.equal(locked.handicapRaw, '-0.50')
  assert.deepEqual(locked.snapshot, latest)
})

test('locks over to under for a total market', () => {
  const totalIdentity = 'crown|football|gid=8878931|first_half|total|RATIO_OUH'
  const input = signal({
    target: {
      marketIdentity: totalIdentity,
      selectionIdentity: `${totalIdentity}|over`,
      side: 'over',
    },
    evidence: { marketType: 'total', period: 'first_half', handicap: 2.5, handicapRaw: '2.5' },
  })
  const locked = lockReverseSelection(input, () => snapshot({
    market: {
      marketIdentity: totalIdentity,
      period: 'first_half',
      marketType: 'total',
      lineKey: 'RATIO_OUH',
      handicap: 2.5,
      handicapRaw: '2.50',
    },
    selection: { selectionIdentity: `${totalIdentity}|under`, side: 'under' },
  }))
  assert.equal(locked.side, 'under')
  assert.equal(locked.handicap, 2.5)
  assert.equal(locked.handicapRaw, '2.50')
})

test('rejects an Asian handicap value change hidden behind the same line identity', () => {
  assert.equal(lockReverseSelection(signal(), () => snapshot({
    market: { handicap: -0.75, handicapRaw: '-0.75' },
  })), null)
})

test('rejects a total value change hidden behind the same line identity', () => {
  const totalIdentity = 'crown|football|gid=8878931|first_half|total|RATIO_OUH'
  const input = signal({
    target: {
      marketIdentity: totalIdentity,
      selectionIdentity: `${totalIdentity}|over`,
      side: 'over',
    },
    evidence: { marketType: 'total', period: 'first_half', handicap: 2.5, handicapRaw: '2.5' },
  })
  assert.equal(lockReverseSelection(input, () => snapshot({
    market: {
      marketIdentity: totalIdentity,
      period: 'first_half',
      marketType: 'total',
      lineKey: 'RATIO_OUH',
      handicap: 3,
      handicapRaw: '3.0',
    },
    selection: { selectionIdentity: `${totalIdentity}|under`, side: 'under' },
  })), null)
})

test('fails closed unless both source and latest handicap values are finite numbers', () => {
  assert.equal(lockReverseSelection(signal({ evidence: { handicap: null } }), () => snapshot()), null)
  assert.equal(lockReverseSelection(signal({ evidence: { handicap: Number.NaN } }), () => snapshot()), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ market: { handicap: null } })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ market: { handicap: Number.POSITIVE_INFINITY } })), null)
})

test('rejects a missing, suspended, or same-side result', () => {
  assert.equal(lockReverseSelection(signal(), () => null), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ selection: { suspended: true } })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({
    selection: { selectionIdentity: `${signal().target.marketIdentity}|home`, side: 'home' },
  })), null)
})

test('rejects another event, period, market type, provider, or malformed identity', () => {
  assert.equal(lockReverseSelection(signal(), () => snapshot({ provider: 'other' })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ event: { eventKey: 'crown|football|gid=999' } })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ market: { period: 'first_half' } })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ market: { marketType: 'total' } })), null)
  assert.equal(lockReverseSelection(signal(), () => snapshot({ market: { marketIdentity: 'malformed' } })), null)
  assert.equal(lockReverseSelection(signal({ evidence: { period: 'first_half' } }), () => snapshot()), null)
})

test('rejects an adjacent line instead of chasing it', () => {
  const adjacentIdentity = 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE_ALT'
  assert.equal(lockReverseSelection(signal(), () => snapshot({
    market: { marketIdentity: adjacentIdentity, lineKey: 'RATIO_RE_ALT' },
    selection: { selectionIdentity: `${adjacentIdentity}|away` },
  })), null)
})

test('fails closed for unsupported or incoherent source identities', () => {
  assert.equal(lockReverseSelection(signal({ target: { side: 'draw' } }), () => snapshot()), null)
  assert.equal(lockReverseSelection(signal({
    target: { selectionIdentity: `${signal().target.marketIdentity}|away` },
  }), () => snapshot()), null)
  assert.equal(lockReverseSelection(signal({
    target: { marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap' },
  }), () => snapshot()), null)
})
