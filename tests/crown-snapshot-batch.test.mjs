import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSnapshotBatch,
  crownIdentity,
  marketIdentity,
  selectionIdentity,
} from '../src/crown/monitor/snapshot-batch.mjs'

test('list and game-more with the same GID share one canonical event key', () => {
  const list = crownIdentity({ gid: '3001', gidm: '9101', hgid: '3002', ecid: '8101', lid: '7101', eventId: 'evt-1' })
  const more = crownIdentity({ gid: '3001', gidm: '9101', hgid: '3002', ecid: '', lid: '7101', eventId: 'evt-1' })

  assert.equal(list.eventKey, 'crown|football|gid=3001')
  assert.equal(more.eventKey, list.eventKey)
  assert.equal(list.matchGroupKey, 'crown|football|gidm=9101|lid=7101')
  assert.equal(list.confidence, 'high')
  assert.deepEqual(list.providerIds, {
    gid: '3001',
    gidm: '9101',
    hgid: '3002',
    ecid: '8101',
    lid: '7101',
    eventId: 'evt-1',
  })
  assert.equal(more.providerIds.ecid, null)
})

test('different GIDs under one GIDM remain distinct events', () => {
  const first = crownIdentity({ gid: '10', gidm: '90', lid: '7' })
  const second = crownIdentity({ gid: '11', gidm: '90', lid: '7' })

  assert.notEqual(first.eventKey, second.eventKey)
  assert.equal(first.matchGroupKey, second.matchGroupKey)
})

test('missing GID does not invent an event key and has low identity confidence', () => {
  const identity = crownIdentity({ gidm: '90', hgid: '12' })

  assert.equal(identity.eventKey, null)
  assert.equal(identity.matchGroupKey, 'crown|football|gidm=90|lid=missing')
  assert.equal(identity.confidence, 'low')
})

test('handicap and odds changes do not change canonical market or selection identity', () => {
  const before = {
    event: { eventKey: 'crown|football|gid=3001' },
    market: { period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_R', handicap: 0.25 },
    selection: { side: 'home', odds: 0.79 },
  }
  const after = {
    ...before,
    market: { ...before.market, handicap: 0.5 },
    selection: { ...before.selection, odds: 0.91 },
  }

  assert.equal(marketIdentity(before), 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R')
  assert.equal(marketIdentity(after), marketIdentity(before))
  assert.equal(selectionIdentity(after), selectionIdentity(before))
  assert.equal(selectionIdentity(before), `${marketIdentity(before)}|home`)
})

test('market and selection identities fail closed when any canonical component is missing', () => {
  const valid = {
    event: { eventKey: 'crown|football|gid=3001' },
    market: { period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_R' },
    selection: { side: 'home' },
  }
  const invalidMarkets = [
    { ...valid, event: {} },
    { ...valid, market: { ...valid.market, period: '' } },
    { ...valid, market: { ...valid.market, marketType: null } },
    { ...valid, market: { ...valid.market, lineKey: undefined } },
  ]

  for (const record of invalidMarkets) {
    assert.equal(marketIdentity(record), null)
    assert.equal(selectionIdentity(record), null)
  }
  assert.equal(selectionIdentity({ ...valid, selection: {} }), null)
})

function sampleRecord({ eventKey = 'crown|football|gid=3001', side = 'home', odds = 0.79 } = {}) {
  return {
    event: { eventKey },
    market: { period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_R', handicap: 0.25 },
    selection: { side, odds },
  }
}

const capturedAt = '2026-07-10T00:00:00.000Z'

test('valid get_game_list produces a complete authoritative schema-v2 batch', () => {
  const classification = { hasServerResponse: true, parseError: false, loginExpired: false, gameCount: 1 }
  const records = [sampleRecord()]
  const eventRefs = [{ eventKey: 'crown|football|gid=3001' }]
  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification,
    records,
    eventRefs,
    capturedAt,
    request: { listType: 'today', showtype: 'FT', date: '2026-07-10', rtype: 'r', filter: { league: 'all' } },
    pollId: 'poll-1',
  })

  assert.equal(batch.schemaVersion, 2)
  assert.match(batch.batchId, /^[a-f0-9]{64}$/)
  assert.equal(batch.pollId, 'poll-1')
  assert.equal(batch.provider, 'crown')
  assert.equal(batch.sport, 'football')
  assert.equal(batch.endpointKind, 'get_game_list')
  assert.equal(batch.completeness, 'authoritative')
  assert.equal(batch.complete, true)
  assert.equal(batch.capturedAt, capturedAt)
  assert.equal(batch.classification, classification)
  assert.equal(batch.eventRefs, eventRefs)
  assert.equal(batch.oddsRecords, records)
})

test('server-confirmed empty get_game_list fails closed instead of becoming authoritative', () => {
  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: {
      hasServerResponse: true,
      parseError: false,
      loginExpired: false,
      gameCount: 0,
      eligibleGameCount: 0,
    },
    records: [],
    eventRefs: [],
    capturedAt,
    request: { showtype: 'FT', rtype: 'r', filter: {} },
    pollId: 'poll-empty-list',
  })

  assert.equal(batch.complete, false)
  assert.equal(batch.completeness, 'partial')
})

test('get_game_more is always partial but a valid response is complete', () => {
  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_more',
    classification: { hasServerResponse: true },
    records: [],
    eventRefs: [],
    capturedAt,
    request: { gid: '3001' },
    pollId: 'poll-2',
  })

  assert.equal(batch.completeness, 'partial')
  assert.equal(batch.complete, true)
})

test('valid list and detail responses fail closed without a non-empty poll ID', () => {
  for (const [endpointKind, classification, pollId] of [
    ['get_game_list', { hasServerResponse: true, gameCount: 0, eligibleGameCount: 0 }, null],
    ['get_game_more', { hasServerResponse: true }, '   '],
  ]) {
    const batch = buildSnapshotBatch({
      endpointKind,
      classification,
      records: [],
      eventRefs: [],
      capturedAt,
      request: endpointKind === 'get_game_list' ? { listType: 'today' } : { gid: '3001' },
      pollId,
    })

    assert.equal(batch.complete, false)
    assert.equal(batch.completeness, 'partial')
  }
})

test('one normalized poll ID is preserved across incomplete empty list and complete detail batches', () => {
  const pollId = ' poll-shared '
  const list = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: { hasServerResponse: true, gameCount: 0, eligibleGameCount: 0 },
    records: [],
    eventRefs: [],
    capturedAt,
    request: { showtype: 'FT', rtype: 'r', filter: {} },
    pollId,
  })
  const detail = buildSnapshotBatch({
    endpointKind: 'get_game_more',
    classification: { hasServerResponse: true },
    records: [],
    eventRefs: [],
    capturedAt,
    request: { gid: '3001' },
    pollId,
  })

  assert.equal(list.pollId, 'poll-shared')
  assert.equal(detail.pollId, list.pollId)
  assert.equal(list.complete, false)
  assert.equal(list.completeness, 'partial')
  assert.equal(detail.complete, true)
})

test('valid list response with an unknown request scope remains partial', () => {
  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: { hasServerResponse: true, gameCount: 0, eligibleGameCount: 0 },
    records: [],
    eventRefs: [],
    capturedAt,
    request: {},
    pollId: 'poll-unknown-scope',
  })

  assert.equal(batch.complete, false)
  assert.equal(batch.completeness, 'partial')
  assert.equal(typeof batch.scopeKey, 'string')
})

test('valid HTTP detail with an invalid normalized selection remains incomplete', () => {
  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_more',
    classification: { hasServerResponse: true },
    records: [{}],
    eventRefs: [],
    capturedAt,
    request: { gid: '3001' },
    pollId: 'poll-invalid-selection',
  })

  assert.equal(batch.complete, false)
  assert.equal(batch.completeness, 'partial')
})

test('batch ID changes when normalized odds facts change', () => {
  const input = {
    endpointKind: 'get_game_list',
    classification: { hasServerResponse: true, gameCount: 1, eligibleGameCount: 1 },
    eventRefs: [{ eventKey: 'crown|football|gid=3001' }],
    capturedAt,
    request: { showtype: 'FT', rtype: 'r', filter: {} },
    pollId: 'poll-facts',
  }
  const before = buildSnapshotBatch({ ...input, records: [sampleRecord({ odds: 0.8 })] })
  const after = buildSnapshotBatch({ ...input, records: [sampleRecord({ odds: 0.9 })] })

  assert.notEqual(before.batchId, after.batchId)
})

test('invalid list and detail responses are incomplete and never authoritative', () => {
  for (const [endpointKind, classification] of [
    ['get_game_list', { hasServerResponse: false, parseError: false, loginExpired: false }],
    ['get_game_list', { hasServerResponse: true, parseError: true, loginExpired: false }],
    ['get_game_more', { hasServerResponse: true, parseError: false, loginExpired: true }],
  ]) {
    const batch = buildSnapshotBatch({ endpointKind, classification, records: [], eventRefs: [], capturedAt, request: {} })
    assert.equal(batch.completeness, 'partial')
    assert.equal(batch.complete, false)
  }
})

test('list batches fail closed when parsed games and canonical event refs disagree', () => {
  for (const eventRefs of [[], [{ eventKey: null }]]) {
    const batch = buildSnapshotBatch({
      endpointKind: 'get_game_list',
      classification: { hasServerResponse: true, parseError: false, loginExpired: false, gameCount: 1 },
      records: [],
      eventRefs,
      capturedAt,
      request: { listType: 'today', showtype: 'FT', date: '2026-07-10', rtype: 'r', filter: {} },
    })

    assert.equal(batch.completeness, 'partial')
    assert.equal(batch.complete, false)
  }
})

test('unknown endpoint kinds fail closed instead of becoming complete batches', () => {
  const batch = buildSnapshotBatch({
    endpointKind: 'unknown',
    classification: { hasServerResponse: true, parseError: false, loginExpired: false },
    records: [],
    eventRefs: [],
    capturedAt,
    request: {},
  })

  assert.equal(batch.completeness, 'partial')
  assert.equal(batch.complete, false)
})

test('scope and batch IDs are stable across request and record ordering', () => {
  const classification = { loginExpired: false, hasServerResponse: true, parseError: false }
  const records = [sampleRecord({ side: 'away' }), sampleRecord({ side: 'home' })]
  const eventRefs = [
    { eventKey: 'crown|football|gid=3002' },
    { eventKey: 'crown|football|gid=3001' },
  ]
  const first = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification,
    records,
    eventRefs,
    capturedAt,
    request: {
      gid: 'detail-id-must-not-scope-list',
      listType: ' today ',
      showtype: 'FT',
      date: '2026-07-10',
      rtype: 'R',
      gtype: 'FT',
      ltype: '3',
      isRB: 'N',
      filter: { z: 2, a: 1 },
    },
    pollId: 'poll-first',
  })
  const replay = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification,
    records: [...records].reverse(),
    eventRefs: [...eventRefs].reverse(),
    capturedAt,
    request: {
      filter: { a: 1, z: 2 },
      rtype: 'R',
      date: '2026-07-10',
      showtype: 'FT',
      listType: 'today',
      gtype: 'FT',
      ltype: '3',
      isRB: 'N',
      gid: 'another-detail-id',
    },
    pollId: 'poll-replay',
  })

  assert.equal(first.scopeKey, replay.scopeKey)
  assert.equal(first.batchId, replay.batchId)
  assert.doesNotMatch(first.scopeKey, /detail-id/)
  assert.match(first.scopeKey, /"gtype":"ft"/)
  assert.match(first.scopeKey, /"ltype":"3"/)
  assert.match(first.scopeKey, /"isRB":"n"/)
})
