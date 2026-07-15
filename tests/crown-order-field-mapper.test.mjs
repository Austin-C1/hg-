import assert from 'node:assert/strict'
import test from 'node:test'

import { getCrownCapability } from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  buildStrictCrownPreviewFields,
  buildStrictCrownPreviewWireFields,
  buildStrictCrownSubmitWireFields,
} from '../src/crown/betting/crown-order-field-mapper.mjs'

const DIRECTIONS = Object.freeze([
  ['prematch', 'asian_handicap', 'home', 'RATIO_R', 'IOR_RH', 'R', 'H'],
  ['prematch', 'asian_handicap', 'away', 'RATIO_R', 'IOR_RC', 'R', 'C'],
  ['prematch', 'total', 'over', 'RATIO_OUO', 'IOR_OUC', 'OU', 'C'],
  ['prematch', 'total', 'under', 'RATIO_OUU', 'IOR_OUH', 'OU', 'H'],
  ['live', 'asian_handicap', 'home', 'RATIO_RE', 'IOR_REH', 'RE', 'H'],
  ['live', 'asian_handicap', 'away', 'RATIO_RE', 'IOR_REC', 'RE', 'C'],
  ['live', 'total', 'over', 'RATIO_ROUO', 'IOR_ROUC', 'ROU', 'C'],
  ['live', 'total', 'under', 'RATIO_ROUU', 'IOR_ROUH', 'ROU', 'H'],
])

function capability(direction) {
  const [mode, marketType, selectionSide] = direction
  return getCrownCapability({
    mode, period: 'full_time', marketType, lineVariant: 'main', selectionSide,
  })
}

function record(direction, overrides = {}) {
  const [mode, marketType, side, ratioField, oddsField] = direction
  return {
    mode,
    event: { ids: { gid: '8878933' } },
    market: {
      marketType, period: 'full_time', lineVariant: 'main', ratioField,
      handicapRaw: marketType === 'total' ? '2.5' : '-0 / 0.5',
    },
    selection: { side, oddsField, oddsRaw: '0.96' },
    ...overrides,
  }
}

test('strict Preview mapper uses the exact captured side wire for all eight directions', () => {
  for (const direction of DIRECTIONS) {
    const [, , side, , , wtype, choseTeam] = direction
    const row = capability(direction)
    const mapped = buildStrictCrownPreviewFields(record(direction), { capability: row })
    assert.equal(mapped.operation, 'FT_order_view')
    assert.deepEqual(mapped.preview, {
      gid: '8878933', gtype: 'FT', wtype, chose_team: choseTeam,
    })
    assert.equal(mapped.identity.side, side)
    const wire = buildStrictCrownPreviewWireFields(mapped.preview, {
      capability: row,
      protocolVersion: 'fixture-version',
      protocolVersionEvidence: {
        source: 'production-session-metadata', captured: true, verified: true,
      },
    })
    assert.deepEqual(Object.keys(wire).sort(), row.requestFieldSets.preview)
    assert.equal(wire.ver, 'fixture-version')
  }
})

test('strict Preview mapper fails closed on side, ratio, odds, and field-set drift', () => {
  const row = capability(DIRECTIONS[4])
  assert.throws(
    () => buildStrictCrownPreviewFields(record(DIRECTIONS[5]), { capability: row }),
    /selectionSide/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(record(DIRECTIONS[4], {
      market: { ...record(DIRECTIONS[4]).market, ratioField: 'RATIO_UNKNOWN' },
    }), { capability: row }),
    /ratioField/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(record(DIRECTIONS[4], {
      selection: { ...record(DIRECTIONS[4]).selection, oddsField: 'IOR_UNKNOWN' },
    }), { capability: row }),
    /oddsField/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(record(DIRECTIONS[4]), {
      capability: { ...row, requestFieldSets: { ...row.requestFieldSets, preview: ['gid'] } },
    }),
    /request-keys/,
  )
})

test('strict Preview wire requires a verified runtime protocol version', () => {
  const row = capability(DIRECTIONS[4])
  const mapped = buildStrictCrownPreviewFields(record(DIRECTIONS[4]), { capability: row })
  assert.throws(
    () => buildStrictCrownPreviewWireFields(mapped.preview, { capability: row }),
    /field-source-unproven:ver/,
  )
  assert.throws(
    () => buildStrictCrownPreviewWireFields({ ...mapped.preview, extra: 'x' }, {
      capability: row,
      protocolVersion: 'fixture-version',
      protocolVersionEvidence: {
        source: 'production-session-metadata', captured: true, verified: true,
      },
    }),
    /invalid-crown-preview-request-fields/,
  )
})

test('strict Submit mapper does not infer a wire for an unaccepted side', () => {
  const home = capability(DIRECTIONS[0])
  const identity = {
    provider: 'crown', gid: '1', mode: 'prematch', period: 'full_time',
    market: 'asian_handicap', lineVariant: 'main', line: '0.5', side: 'home',
  }
  assert.throws(() => buildStrictCrownSubmitWireFields({
    lockedIdentity: identity,
    currentIdentity: identity,
  }, { capability: home }), /unverified-crown-submit-capability/)
})

test('strict Submit mapper accepts the exact fresh minimum without a fabricated 50-unit quantum', () => {
  const away = capability(DIRECTIONS[1])
  const identity = {
    provider: 'crown', gid: '8878933', mode: 'prematch', period: 'full_time',
    market: 'asian_handicap', lineVariant: 'main', line: '0.5 / 1', side: 'away',
  }
  const preview = {
    lockedIdentity: identity,
    line: identity.line,
    currency: 'CNY',
    amountScale: 0,
    minStakeMinor: 73,
    maxStakeMinor: 999,
    balanceMinor: 500,
    stakeStepMinor: null,
    stakeStepProvenance: 'not-evidenced-in-preview-response',
    odds: '0.96',
    submitCon: '1',
    submitRatio: '50',
  }
  const options = {
    capability: away,
    protocolVersion: 'fixture-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  }

  const wire = buildStrictCrownSubmitWireFields({
    lockedIdentity: identity,
    currentIdentity: { ...identity },
    preview,
    amountMinor: 73,
  }, options)
  assert.equal(wire.golds, '73')

  assert.throws(() => buildStrictCrownSubmitWireFields({
    lockedIdentity: identity,
    currentIdentity: { ...identity },
    preview,
    amountMinor: 74,
  }, options), /crown-submit-stake-step-unverified/)
})

test('strict Submit mapper permits above-minimum amounts only with an evidenced step', () => {
  const away = capability(DIRECTIONS[1])
  const identity = {
    provider: 'crown', gid: '8878933', mode: 'prematch', period: 'full_time',
    market: 'asian_handicap', lineVariant: 'main', line: '0.5 / 1', side: 'away',
  }
  const base = {
    lockedIdentity: identity,
    line: identity.line,
    currency: 'CNY', amountScale: 0,
    minStakeMinor: 73, maxStakeMinor: 999, balanceMinor: 500,
    stakeStepMinor: 5,
    odds: '0.96', submitCon: '1', submitRatio: '50',
  }
  const options = {
    capability: away,
    protocolVersion: 'fixture-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  }
  assert.equal(buildStrictCrownSubmitWireFields({
    lockedIdentity: identity,
    currentIdentity: { ...identity },
    preview: { ...base, stakeStepProvenance: 'provider-preview-response' },
    amountMinor: 83,
  }, options).golds, '83')
  assert.throws(() => buildStrictCrownSubmitWireFields({
    lockedIdentity: identity,
    currentIdentity: { ...identity },
    preview: { ...base, stakeStepProvenance: 'local-conservative-policy' },
    amountMinor: 83,
  }, options), /crown-submit-stake-step-unverified/)
})
