import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCrownOrderFields,
  buildStrictCrownPreviewFields,
  buildStrictCrownPreviewWireFields,
} from '../src/crown/betting/crown-order-field-mapper.mjs'

function liveCapability(overrides = {}) {
  return {
    evidenceStatus: 'verified',
    previewAllowed: true,
    evidenceId: 'fixture:live-full-time-asian-handicap-main:v1',
    mode: 'live',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    mapperEvidence: {
      ratioFields: ['RATIO_RE'],
      oddsFields: ['IOR_REC', 'IOR_REH'],
      oddsFieldsBySide: { home: 'IOR_REH', away: 'IOR_REC' },
      wtype: 'RE',
      wireDefaults: { langx: 'zh-cn', odd_f_type: 'H', p: 'FT_order_view' },
    },
    requestFieldSet: ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'],
    ...overrides,
  }
}

function liveRecord(overrides = {}) {
  return {
    mode: 'live',
    event: { ids: { gid: '8878933' } },
    market: {
      marketType: 'asian_handicap',
      period: 'full_time',
      lineVariant: 'main',
      lineKey: 'ah:ft:-0.25',
      ratioField: 'RATIO_RE',
      handicapRaw: '-0 / 0.5',
    },
    selection: { side: 'home', oddsField: 'IOR_REH', oddsRaw: '1.09' },
    ...overrides,
  }
}

test('maps live asian handicap home selection to Crown fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8878933' } },
    market: { marketType: 'asian_handicap', period: 'full_time', ratioField: 'RATIO_RE', handicapRaw: '-0 / 0.5' },
    selection: { side: 'home', oddsField: 'IOR_REH', oddsRaw: '1.09' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'RE')
  assert.equal(fields.preview.chose_team, 'H')
  assert.equal(fields.submit.rtype, 'REH')
  assert.equal(fields.submit.golds, '50')
})

test('maps live first-half total under selection to Crown fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8878931' } },
    market: { marketType: 'total', period: 'first_half', ratioField: 'RATIO_HROUO', handicapRaw: '4 / 4.5' },
    selection: { side: 'under', oddsField: 'IOR_HROUH', oddsRaw: '0.75' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'ROU')
  assert.equal(fields.preview.chose_team, 'C')
  assert.equal(fields.submit.rtype, 'ROUC')
  assert.equal(fields.submit.f, '1R')
})

test('maps prematch full-time total under selection to Crown preview fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8892295' } },
    market: { marketType: 'total', period: 'full_time', ratioField: 'RATIO_OUO', handicapRaw: '2.5' },
    selection: { side: 'under', oddsField: 'IOR_OUH', oddsRaw: '0.71' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'OU')
  assert.equal(fields.preview.chose_team, 'C')
  assert.equal(fields.submit.rtype, 'OUC')
  assert.equal(fields.submit.isRB, 'N')
  assert.equal(fields.submit.f, '')
})

test('maps prematch first-half total under selection to Crown preview fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8892295' } },
    market: { marketType: 'total', period: 'first_half', ratioField: 'RATIO_HOUO', handicapRaw: '1' },
    selection: { side: 'under', oddsField: 'IOR_HOUH', oddsRaw: '0.71' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'OU')
  assert.equal(fields.preview.chose_team, 'C')
  assert.equal(fields.submit.rtype, 'OUC')
  assert.equal(fields.submit.isRB, 'N')
  assert.equal(fields.submit.f, '1R')
})

test('maps prematch first-half asian handicap away selection to Crown preview fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8892295' } },
    market: { marketType: 'asian_handicap', period: 'first_half', ratioField: 'RATIO_HR', handicapRaw: '0' },
    selection: { side: 'away', oddsField: 'IOR_HRC', oddsRaw: '0.99' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'R')
  assert.equal(fields.preview.chose_team, 'C')
  assert.equal(fields.submit.rtype, 'RC')
  assert.equal(fields.submit.isRB, 'N')
  assert.equal(fields.submit.f, '1R')
})

test('rejects unsupported markets before request construction', () => {
  assert.throws(() => buildCrownOrderFields({
    event: { ids: { gid: '1' } },
    market: { marketType: 'moneyline', period: 'full_time' },
    selection: { side: 'home', oddsRaw: '1.2' },
    stake: 10,
  }), /unsupported-crown-market/)
})

test('rejects alternate-line handicap fields that are not verified for execution', () => {
  assert.throws(() => buildCrownOrderFields({
    event: { ids: { gid: '1001' } },
    market: { marketType: 'asian_handicap', period: 'full_time', ratioField: 'RATIO_AR', handicapRaw: '0 / 0.5' },
    selection: { side: 'home', oddsField: 'IOR_ARH', oddsRaw: '0.79' },
    stake: 50,
  }), /unsupported-crown-market/)
})

test('strict mapper constructs only evidenced FT_order_view fields and preserves lock identity', () => {
  const fields = buildStrictCrownPreviewFields(liveRecord(), { capability: liveCapability() })

  assert.equal(fields.operation, 'FT_order_view')
  assert.deepEqual(fields.preview, {
    gid: '8878933',
    gtype: 'FT',
    wtype: 'RE',
    chose_team: 'H',
  })
  assert.deepEqual(Object.keys(fields.preview).sort(), ['chose_team', 'gid', 'gtype', 'wtype'])
  const wire = buildStrictCrownPreviewWireFields(fields.preview, {
    capability: liveCapability(),
    protocolVersion: 'fixture-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  })
  assert.deepEqual(Object.keys(wire).sort(), liveCapability().requestFieldSet)
  assert.equal(wire.p, 'FT_order_view')
  assert.equal(wire.langx, 'zh-cn')
  assert.equal(wire.odd_f_type, 'H')
  assert.equal(wire.ver, 'fixture-version')
  assert.deepEqual(fields.identity, {
    gid: '8878933',
    mode: 'live',
    period: 'full_time',
    market: 'asian_handicap',
    lineVariant: 'main',
    line: '-0 / 0.5',
    side: 'home',
  })
  assert.equal(fields.capabilityEvidenceId, 'fixture:live-full-time-asian-handicap-main:v1')
  assert.equal('submit' in fields, false)
})

test('strict mapper requires explicit verified preview capability evidence', () => {
  assert.throws(() => buildStrictCrownPreviewFields(liveRecord()), /missing-crown-preview-capability/)
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), { capability: liveCapability({ evidenceStatus: 'provisional' }) }),
    /unverified-crown-preview-capability/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), { capability: liveCapability({ previewAllowed: false }) }),
    /unverified-crown-preview-capability/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), { capability: liveCapability({ evidenceId: '' }) }),
    /missing-crown-preview-evidence/,
  )
})

test('strict mapper rejects unsupported prematch evidence, alternate, and capability mismatches', () => {
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord({ mode: 'prematch' }), {
      capability: liveCapability({ mode: 'prematch' }),
    }),
    /crown-preview-capability-mismatch:wtype/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord({
      market: { ...liveRecord().market, lineVariant: 'alternate' },
    }), { capability: liveCapability({ lineVariant: 'alternate' }) }),
    /unsupported-crown-preview-line-variant/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), {
      capability: liveCapability({ period: 'first_half' }),
    }),
    /crown-preview-capability-mismatch:period/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), {
      capability: liveCapability({
        mapperEvidence: { ...liveCapability().mapperEvidence, oddsFieldsBySide: { home: 'IOR_UNKNOWN' } },
      }),
    }),
    /crown-preview-capability-mismatch:oddsField/,
  )
})

test('strict mapper rejects capability request-key drift instead of forwarding extra fields', () => {
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), {
      capability: liveCapability({ requestFieldSet: ['gid', 'gtype', 'wtype', 'chose_team', 'uid'] }),
    }),
    /invalid-crown-preview-request-keys/,
  )
  assert.throws(
    () => buildStrictCrownPreviewFields(liveRecord(), {
      capability: liveCapability({
        mapperEvidence: { ...liveCapability().mapperEvidence, wtype: 'OU' },
      }),
    }),
    /crown-preview-capability-mismatch:wtype/,
  )
})

test('strict wire mapper blocks missing version source and exact-field drift', () => {
  const mapped = buildStrictCrownPreviewFields(liveRecord(), { capability: liveCapability() })
  assert.throws(
    () => buildStrictCrownPreviewWireFields(mapped.preview, { capability: liveCapability() }),
    /crown-preview-field-source-unproven:ver/,
  )
  assert.throws(
    () => buildStrictCrownPreviewWireFields({ ...mapped.preview, extra: 'x' }, {
      capability: liveCapability(), protocolVersion: 'fixture-version',
    }),
    /invalid-crown-preview-request-fields/,
  )
})
