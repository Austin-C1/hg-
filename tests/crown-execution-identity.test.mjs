import assert from 'node:assert/strict'
import test from 'node:test'

import * as executionIdentityModule from '../src/crown/betting/execution-identity.mjs'

const {
  assertExecutionIdentity,
  executionCandidateFromSnapshot,
  executionIdentityFromEnvelope,
} = executionIdentityModule

function envelope(overrides = {}) {
  const market = {
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    lineKey: 'ah:ft:-0.25',
    handicapRaw: '-0 / 0.5',
    ...(overrides.market || {}),
  }
  return {
    provider: 'crown',
    eventKey: 'crown|football|gid=8878933',
    selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|ah:ft:-0.25|home',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineKey: 'ah:ft:-0.25',
    side: 'home',
    snapshot: {
      provider: 'crown',
      mode: 'live',
      capturedAt: '2026-07-11T02:01:00.000Z',
      event: { eventKey: 'crown|football|gid=8878933', mode: 'live', ids: { gid: '8878933' } },
      market,
      selection: {
        side: 'home',
        oddsField: 'IOR_REH',
        oddsRaw: '0.770',
        selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|ah:ft:-0.25|home',
      },
    },
    ...overrides,
  }
}

test('canonical execution identity carries market and explicit line variant through every boundary', () => {
  const identity = executionIdentityFromEnvelope(envelope(), { provider: 'crown' })
  assert.deepEqual(identity, {
    provider: 'crown',
    gid: '8878933',
    mode: 'live',
    period: 'full_time',
    market: 'asian_handicap',
    lineVariant: 'main',
    line: '-0 / 0.5',
    side: 'home',
  })
  assert.deepEqual(assertExecutionIdentity(identity), identity)
})

test('monitor snapshot becomes the exact ten-field execution candidate DTO', () => {
  assert.equal(typeof executionCandidateFromSnapshot, 'function')
  const candidate = executionCandidateFromSnapshot(envelope().snapshot)

  assert.deepEqual(candidate, {
    gid: '8878933',
    mode: 'live',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    selectionSide: 'home',
    handicapRaw: '-0 / 0.5',
    oddsField: 'IOR_REH',
    oddsRaw: '0.770',
    observedAt: '2026-07-11T02:01:00.000Z',
  })
})

test('execution candidate conversion fails closed for unknown or incomplete snapshots', () => {
  assert.equal(typeof executionCandidateFromSnapshot, 'function')
  const invalid = [
    { event: { eventKey: '', ids: { gid: '' } } },
    { mode: 'unknown', event: { mode: 'unknown' } },
    { market: { lineVariant: 'unknown' } },
    { selection: { oddsField: '' } },
    { selection: { oddsRaw: '' } },
    { capturedAt: '' },
  ]
  for (const override of invalid) {
    const base = envelope().snapshot
    const value = {
      ...base,
      ...override,
      event: { ...base.event, ...(override.event || {}) },
      market: { ...base.market, ...(override.market || {}) },
      selection: { ...base.selection, ...(override.selection || {}) },
    }
    assert.throws(() => executionCandidateFromSnapshot(value), TypeError)
  }
})

test('canonical execution identity distinguishes two handicap values that share one Crown lineKey', () => {
  const first = executionIdentityFromEnvelope(envelope(), { provider: 'crown' })
  const secondEnvelope = envelope({
    market: { handicapRaw: '-0.5' },
  })
  const second = executionIdentityFromEnvelope(secondEnvelope, { provider: 'crown' })

  assert.equal(first.line, '-0 / 0.5')
  assert.equal(second.line, '-0.5')
  assert.notDeepEqual(first, second)
})

test('canonical execution identity never guesses a missing line variant or accepts marketType aliases', () => {
  const missingVariant = envelope()
  delete missingVariant.snapshot.market.lineVariant
  assert.throws(() => executionIdentityFromEnvelope(missingVariant, { provider: 'crown' }), /missing-crown-line-variant/)
  assert.throws(() => assertExecutionIdentity({
    provider: 'crown', gid: '8878933', mode: 'live', period: 'full_time',
    marketType: 'asian_handicap', lineVariant: 'main', line: 'ah:ft:-0.25', side: 'home',
  }), /execution-identity-shape/)
})
