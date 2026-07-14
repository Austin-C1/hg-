import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertExecutionIdentity,
  executionIdentityFromEnvelope,
} from '../src/crown/betting/execution-identity.mjs'

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
      event: { eventKey: 'crown|football|gid=8878933', ids: { gid: '8878933' } },
      market,
      selection: {
        side: 'home',
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
