import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { MonitorStateStore, openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'
import { buildSnapshotBatch } from '../src/crown/monitor/snapshot-batch.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-monitor-state-')), 'crown.sqlite')
}

function persistentSignal({
  changeId = 'a'.repeat(64),
  strategyId = 'strategy-1',
  selectionIdentity = 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R|home',
  observedAt = '2026-07-10T01:00:00.000Z',
  expiresAt = '2026-07-10T01:01:00.000Z',
  threshold = 0.03,
  oldOdds = 0.94,
  nextOdds = 0.99,
  handicap = 0.25,
  minutesBeforeKickoff = 120,
  channels = ['console', 'telegram'],
} = {}) {
  const eventIdentity = 'crown|football|gid=3001'
  const marketIdentity = 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R'
  const cooldownSeconds = (Date.parse(expiresAt) - Date.parse(observedAt)) / 1000
  const rule = {
    id: strategyId,
    type: 'odds_delta',
    version: 1,
    enabled: true,
    conditions: { minDelta: threshold },
    cooldownSeconds,
    bettingRuleId: 'bet-rule-1',
  }
  const change = {
    schemaVersion: 2,
    changeId,
    type: 'odds-change',
    observedAt,
    eventIdentity,
    marketIdentity,
    selectionIdentity,
  }
  const decision = {
    matched: true,
    strategyId,
    strategyVersion: 1,
    trigger: {
      type: 'odds-change',
      direction: 'up',
      delta: Number(Math.abs(nextOdds - oldOdds).toFixed(6)),
      threshold,
      observedAt,
    },
    target: {
      eventIdentity,
      marketIdentity,
      selectionIdentity,
      side: 'home',
    },
    evidence: {
      changeId,
      oldOdds,
      nextOdds,
      homeTeam: 'Home',
      awayTeam: 'Away',
      handicapRaw: String(handicap),
      oldOddsRaw: Number(oldOdds).toFixed(3),
      nextOddsRaw: Number(nextOdds).toFixed(3),
      mode: 'prematch',
      league: 'Test League',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicap,
      minutesBeforeKickoff,
      livePhase: null,
      liveMinute: null,
      source: { endpointKind: 'get_game_more', confidence: 'high' },
    },
    bettingRuleId: 'bet-rule-1',
    cooldownSeconds,
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
  }
  return { ...createSignal({ rule, change, decision }), channels }
}

function normalizedRecord({
  gid = '3001',
  side = 'home',
  odds = 0.91,
  oddsRaw = String(odds),
  handicap = 0.25,
  handicapRaw = '+0/0.5',
  suspended = false,
  capturedAt = '2026-07-10T01:02:03.000Z',
} = {}) {
  const eventKey = `crown|football|gid=${gid}`
  const selectionId = `${eventKey}|full_time|asian_handicap|RATIO_R|${side}`
  return {
    provider: 'crown',
    sport: 'football',
    mode: 'prematch',
    capturedAt,
    source: { endpointKey: 'POST /transform.php', mapperVersion: 'crown-transform-xml-v2' },
    event: {
      eventKey,
      matchGroupKey: 'crown|football|gidm=9001|lid=7001',
      providerIds: { gid, gidm: '9001', lid: '7001' },
      league: 'Test League',
      homeTeam: 'Home',
      awayTeam: 'Away',
    },
    market: {
      period: 'full_time',
      marketType: 'asian_handicap',
      lineKey: 'RATIO_R',
      marketIdentity: `${eventKey}|full_time|asian_handicap|RATIO_R`,
      handicap,
      handicapRaw,
    },
    selection: { side, odds, oddsRaw, suspended, selectionIdentity: selectionId },
    warnings: [],
  }
}

function eventRef(gid) {
  return {
    eventKey: `crown|football|gid=${gid}`,
    matchGroupKey: `crown|football|gidm=9${gid}|lid=7001`,
    providerIds: { gid, gidm: `9${gid}`, lid: '7001' },
    league: 'Test League',
    homeTeam: `Home ${gid}`,
    awayTeam: `Away ${gid}`,
    source: { endpointKey: 'POST /transform.php', endpointKind: 'get_game_list', mapperVersion: 'crown-transform-xml-v2' },
    warnings: [],
  }
}

function listBatch(gids, {
  batchId = `list-${gids.join('-')}`,
  pollId = batchId,
  scopeKey = 'list-scope',
  capturedAt = '2026-07-10T01:00:00.000Z',
  source = { endpointKey: 'POST /transform.php current-list', endpointKind: 'get_game_list', mapperVersion: 'crown-transform-xml-v2' },
} = {}) {
  return batch({
    batchId,
    pollId,
    scopeKey,
    capturedAt,
    source,
    completeness: 'authoritative',
    complete: true,
    eventRefs: gids.map(eventRef),
    oddsRecords: [],
  })
}

function detailBatch(gid, odds, {
  batchId = `detail-${gid}-${odds}`,
  pollId = batchId,
  scopeKey = `detail-scope-${gid}`,
  capturedAt = '2026-07-10T01:01:00.000Z',
  ...recordOverrides
} = {}) {
  const record = normalizedRecord({ gid, odds, capturedAt, ...recordOverrides })
  return batch({
    batchId,
    pollId,
    scopeKey,
    capturedAt,
    completeness: 'partial',
    complete: true,
    eventRefs: [eventRef(gid)],
    oddsRecords: [record],
  })
}

function batch({
  batchId = 'batch-1',
  pollId = 'poll-1',
  scopeKey = 'scope-today-ft',
  capturedAt = '2026-07-10T01:02:03.000Z',
  completeness = 'authoritative',
  complete = true,
  endpointKind,
  source,
  eventRefs,
  oddsRecords,
} = {}) {
  const record = normalizedRecord({ capturedAt })
  return {
    schemaVersion: 2,
    batchId,
    pollId,
    scopeKey,
    capturedAt,
    completeness,
    complete,
    ...(endpointKind ? { endpointKind } : {}),
    ...(source ? { source } : {}),
    eventRefs: eventRefs ?? [{
      eventKey: record.event.eventKey,
      matchGroupKey: record.event.matchGroupKey,
      providerIds: record.event.providerIds,
      league: record.event.league,
      homeTeam: record.event.homeTeam,
      awayTeam: record.event.awayTeam,
    }],
    oddsRecords: oddsRecords ?? [record],
  }
}

test('authoritative list followed by details preserves active events and emits only the factual odds change', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })

  const first = store.applyBatch(listBatch(['3001', '3002']))
  assert.deepEqual(first.changes.map((change) => change.type), ['event-added', 'event-added'])
  assert.deepEqual(store.applyBatch(detailBatch('3001', 0.92)).changes, [])
  assert.deepEqual(store.applyBatch(detailBatch('3002', 0.88)).changes, [])
  assert.equal(store.getEvent('crown|football|gid=3001').active, true)
  assert.equal(store.getEvent('crown|football|gid=3002').active, true)
  assert.deepEqual(store.getScope('list-scope').eventKeys, [
    'crown|football|gid=3001',
    'crown|football|gid=3002',
  ])

  const changed = store.applyBatch(detailBatch('3001', 0.96, {
    batchId: 'detail-3001-changed',
    pollId: 'poll-detail-3001-changed',
    capturedAt: '2026-07-10T01:02:00.000Z',
  }))
  assert.deepEqual(changed.changes.map((change) => change.type), ['odds-change'])
  const [change] = changed.changes
  assert.equal(change.schemaVersion, 2)
  assert.match(change.changeId, /^[a-f0-9]{64}$/)
  assert.equal(change.batchId, 'detail-3001-changed')
  assert.equal(change.pollId, 'poll-detail-3001-changed')
  assert.equal(change.scopeKey, 'detail-scope-3001')
  assert.equal(change.observedAt, '2026-07-10T01:02:00.000Z')
  assert.equal(change.event.eventKey, 'crown|football|gid=3001')
  assert.equal(change.market.marketIdentity, 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R')
  assert.equal(change.selection.selectionIdentity, 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R|home')
  assert.equal(change.eventIdentity, 'crown|football|gid=3001')
  assert.equal(change.marketIdentity, 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R')
  assert.equal(change.selectionIdentity, 'crown|football|gid=3001|full_time|asian_handicap|RATIO_R|home')
  assert.equal(change.old.selection.odds, 0.92)
  assert.equal(change.next.selection.odds, 0.96)
  assert.deepEqual(change.source, normalizedRecord().source)
  assert.equal(change.confidence, 'unknown')
  assert.deepEqual(change.warnings, [])
  store.close()
})

test('state facts and durable audit outbox commit together and survive restart until delivered', () => {
  const dbPath = tempDbPath()
  const first = openMonitorStateStore({ dbPath })
  const baseline = first.applyBatch(detailBatch('3001', 0.92, {
    batchId: 'audit-baseline',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  assert.equal(baseline.snapshots.length, 1)
  assert.equal(first.listPendingAuditFacts().length, 1)

  const changed = first.applyBatch(detailBatch('3001', 0.96, {
    batchId: 'audit-change',
    capturedAt: '2026-07-10T01:01:00.000Z',
  }))
  assert.deepEqual(changed.changes.map((change) => change.type), ['odds-change'])
  const pending = first.listPendingAuditFacts()
  assert.equal(pending.length, 3)
  assert.deepEqual(pending.map((fact) => fact.kind).sort(), ['change', 'snapshot', 'snapshot'])
  assert.equal(new Set(pending.map((fact) => fact.factId)).size, 3)
  assert.equal(pending.find((fact) => fact.kind === 'change').payload.changeId, changed.changes[0].changeId)
  first.close()

  const second = openMonitorStateStore({ dbPath })
  assert.equal(second.listPendingAuditFacts().length, 3)
  const ids = second.listPendingAuditFacts().map((fact) => fact.factId)
  assert.equal(second.markAuditFactsDelivered(ids, { deliveredAt: '2026-07-10T01:02:00.000Z' }), 3)
  assert.deepEqual(second.listPendingAuditFacts(), [])
  assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM monitor_audit_outbox').get().count, 0)
  assert.equal(second.markAuditFactsDelivered(ids, { deliveredAt: '2026-07-10T01:03:00.000Z' }), 0)
  second.close()
})

test('same-scope authoritative removal requires two misses, survives restart, and uses the confirming batch facts', () => {
  const dbPath = tempDbPath()
  const first = openMonitorStateStore({ dbPath })
  first.applyBatch(listBatch(['3001', '3002'], {
    batchId: 'list-both',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  first.applyBatch(detailBatch('3002', 0.88, {
    batchId: 'detail-b-baseline',
    capturedAt: '2026-07-10T01:00:30.000Z',
  }))
  const firstMiss = first.applyBatch(listBatch(['3001'], {
    batchId: 'list-first-miss',
    capturedAt: '2026-07-10T01:01:00.000Z',
  }))
  assert.equal(firstMiss.changes.some((change) => change.type === 'event-removed'), false)
  assert.equal(first.getEvent('crown|football|gid=3002').missingCount, 1)
  assert.equal(first.getEvent('crown|football|gid=3002').active, true)
  assert.deepEqual(first.getScope('list-scope').eventKeys, [
    'crown|football|gid=3001',
    'crown|football|gid=3002',
  ])
  first.close()

  const second = openMonitorStateStore({ dbPath })
  const confirmingSource = {
    endpointKey: 'POST /transform.php confirming-removal',
    endpointKind: 'get_game_list',
    mapperVersion: 'crown-transform-xml-v2',
  }
  const secondMiss = second.applyBatch(listBatch(['3001'], {
    batchId: 'list-second-miss',
    pollId: 'poll-second-miss',
    capturedAt: '2026-07-10T01:02:00.000Z',
    source: confirmingSource,
  }))
  const removed = secondMiss.changes.filter((change) => change.type === 'event-removed')
  assert.equal(removed.length, 1)
  assert.equal(removed[0].event.eventKey, 'crown|football|gid=3002')
  assert.equal(removed[0].observedAt, '2026-07-10T01:02:00.000Z')
  assert.equal(removed[0].batchId, 'list-second-miss')
  assert.equal(removed[0].pollId, 'poll-second-miss')
  assert.deepEqual(removed[0].source, confirmingSource)
  assert.equal(second.getEvent('crown|football|gid=3002').active, false)
  assert.equal(second.getEvent('crown|football|gid=3002').missingCount, 0)
  assert.deepEqual(second.getScope('list-scope').eventKeys, ['crown|football|gid=3001'])
  assert.notEqual(second.getSelection('crown|football|gid=3002|full_time|asian_handicap|RATIO_R|home'), null)
  second.close()
})

test('reappearance resets a first miss and another authoritative scope cannot age the event', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3001', '3002'], { batchId: 'scope-one-first' }))
  store.applyBatch(listBatch(['3003'], {
    batchId: 'scope-two-first',
    scopeKey: 'other-list-scope',
    capturedAt: '2026-07-10T01:00:30.000Z',
  }))
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 0)

  store.applyBatch(listBatch(['3001'], {
    batchId: 'scope-one-miss',
    capturedAt: '2026-07-10T01:01:00.000Z',
  }))
  const reappeared = store.applyBatch(listBatch(['3001', '3002'], {
    batchId: 'scope-one-reappeared',
    capturedAt: '2026-07-10T01:02:00.000Z',
  }))
  assert.equal(reappeared.changes.some((change) => change.type === 'event-removed'), false)
  assert.equal(store.getEvent('crown|football|gid=3002').active, true)
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 0)
  assert.equal(store.getEvent('crown|football|gid=3003').active, true)
  store.close()
})

test('one authoritative scope can remove a shared event without deactivating another scope ownership', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3001', '3002'], {
    batchId: 'shared-scope-a-first',
    scopeKey: 'shared-scope-a',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  const firstInB = store.applyBatch(listBatch(['3002', '3003'], {
    batchId: 'shared-scope-b-first',
    scopeKey: 'shared-scope-b',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  assert.deepEqual(firstInB.changes.map((change) => change.type), ['event-added', 'event-added'])
  store.applyBatch(listBatch(['3001'], {
    batchId: 'shared-scope-a-miss-one',
    scopeKey: 'shared-scope-a',
    capturedAt: '2026-07-10T01:01:00.000Z',
  }))
  const removedFromA = store.applyBatch(listBatch(['3001'], {
    batchId: 'shared-scope-a-miss-two',
    scopeKey: 'shared-scope-a',
    capturedAt: '2026-07-10T01:02:00.000Z',
  }))

  assert.equal(removedFromA.changes.filter((change) => change.type === 'event-removed').length, 1)
  assert.deepEqual(store.getScope('shared-scope-a').eventKeys, ['crown|football|gid=3001'])
  assert.equal(store.getScope('shared-scope-a').missingCounts['crown|football|gid=3002'], undefined)
  assert.deepEqual(store.getScope('shared-scope-b').eventKeys, [
    'crown|football|gid=3002',
    'crown|football|gid=3003',
  ])
  assert.equal(store.getEvent('crown|football|gid=3002').active, true)
  store.close()
})

test('global missingCount rolls up scope misses without another scope observation clearing them', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3001', '3002'], {
    batchId: 'rollup-a-first',
    scopeKey: 'rollup-scope-a',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  store.applyBatch(listBatch(['3001'], {
    batchId: 'rollup-a-miss-one',
    scopeKey: 'rollup-scope-a',
    capturedAt: '2026-07-10T01:01:00.000Z',
  }))
  assert.equal(store.getScope('rollup-scope-a').missingCounts['crown|football|gid=3002'], 1)
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 1)

  store.applyBatch(listBatch(['3002'], {
    batchId: 'rollup-b-observes',
    scopeKey: 'rollup-scope-b',
    capturedAt: '2026-07-10T01:02:00.000Z',
  }))
  assert.equal(store.getScope('rollup-scope-a').missingCounts['crown|football|gid=3002'], 1)
  assert.equal(store.getScope('rollup-scope-b').missingCounts['crown|football|gid=3002'], undefined)
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 1)

  const removed = store.applyBatch(listBatch(['3001'], {
    batchId: 'rollup-a-miss-two',
    scopeKey: 'rollup-scope-a',
    capturedAt: '2026-07-10T01:03:00.000Z',
  })).changes.find((change) => change.type === 'event-removed')
  assert.equal(removed.old.missingCount, 1)
  assert.equal(removed.next.missingCount, 2)
  assert.equal(store.getEvent('crown|football|gid=3002').active, true)
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 0)
  store.close()
})

test('an older first batch in another scope cannot overwrite newer global event facts', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const newer = listBatch(['3200'], {
    batchId: 'facts-newer-scope',
    scopeKey: 'facts-newer-scope',
    capturedAt: '2026-07-10T02:00:00.000Z',
  })
  newer.eventRefs[0] = {
    ...newer.eventRefs[0],
    matchGroupKey: 'crown|football|gidm=newer|lid=newer-lid',
    providerIds: { gid: '3200', gidm: 'newer', lid: 'newer-lid' },
    homeTeam: 'Newer Home',
    awayTeam: 'Newer Away',
  }
  store.applyBatch(newer)

  const olderOtherScope = listBatch(['3200'], {
    batchId: 'facts-older-other-scope',
    scopeKey: 'facts-older-other-scope',
    capturedAt: '2026-07-10T01:00:00.000Z',
  })
  olderOtherScope.eventRefs[0] = {
    ...olderOtherScope.eventRefs[0],
    matchGroupKey: 'crown|football|gidm=older|lid=older-lid',
    providerIds: { gid: '3200', gidm: 'older', lid: 'older-lid' },
    homeTeam: 'Older Home',
    awayTeam: 'Older Away',
  }
  assert.equal(store.applyBatch(olderOtherScope).applied, true)

  assert.deepEqual(store.getEvent('crown|football|gid=3200'), {
    eventKey: 'crown|football|gid=3200',
    matchGroupKey: 'crown|football|gidm=newer|lid=newer-lid',
    active: true,
    missingCount: 0,
    lastSeenAt: '2026-07-10T02:00:00.000Z',
    providerIds: { gid: '3200', gidm: 'newer', lid: 'newer-lid' },
    event: {
      eventKey: 'crown|football|gid=3200',
      matchGroupKey: 'crown|football|gidm=newer|lid=newer-lid',
      providerIds: { gid: '3200', gidm: 'newer', lid: 'newer-lid' },
      league: 'Test League',
      homeTeam: 'Newer Home',
      awayTeam: 'Newer Away',
    },
  })
  assert.deepEqual(store.getScope('facts-older-other-scope').eventKeys, [])
  store.close()
})

test('event removal uses the current scope lastSeen even when another scope has newer event facts', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3300'], {
    batchId: 'evidence-a-seen',
    scopeKey: 'evidence-scope-a',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  store.applyBatch(listBatch(['3300'], {
    batchId: 'evidence-b-newer',
    scopeKey: 'evidence-scope-b',
    capturedAt: '2026-07-10T04:00:00.000Z',
  }))
  store.applyBatch(listBatch([], {
    batchId: 'evidence-a-miss-one',
    scopeKey: 'evidence-scope-a',
    capturedAt: '2026-07-10T02:00:00.000Z',
  }))
  const removed = store.applyBatch(listBatch([], {
    batchId: 'evidence-a-miss-two',
    scopeKey: 'evidence-scope-a',
    capturedAt: '2026-07-10T03:00:00.000Z',
  })).changes.find((change) => change.type === 'event-removed')

  assert.equal(removed.old.capturedAt, '2026-07-10T01:00:00.000Z')
  assert.equal(removed.next.capturedAt, '2026-07-10T03:00:00.000Z')
  assert.equal(store.getScope('evidence-scope-a').missingCounts['crown|football|gid=3300'], undefined)
  assert.equal(store.getScope('evidence-scope-a').lastSeen['crown|football|gid=3300'], '2026-07-10T01:00:00.000Z')
  assert.equal(store.getScope('evidence-scope-a').removedAt['crown|football|gid=3300'], '2026-07-10T03:00:00.000Z')
  assert.equal(store.getEvent('crown|football|gid=3300').active, true)
  store.close()
})

test('an older new authoritative scope cannot revive a globally newer removal', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3400'], {
    batchId: 'revive-owner-seen',
    scopeKey: 'revive-owner',
    capturedAt: '2026-07-10T02:00:00.000Z',
  }))
  store.applyBatch(listBatch([], {
    batchId: 'revive-owner-miss-one',
    scopeKey: 'revive-owner',
    capturedAt: '2026-07-10T03:00:00.000Z',
  }))
  store.applyBatch(listBatch([], {
    batchId: 'revive-owner-removed',
    scopeKey: 'revive-owner',
    capturedAt: '2026-07-10T04:00:00.000Z',
  }))
  assert.equal(store.getEvent('crown|football|gid=3400').active, false)

  const olderNewScope = store.applyBatch(listBatch(['3400'], {
    batchId: 'revive-older-new-scope',
    scopeKey: 'revive-older-new-scope',
    capturedAt: '2026-07-10T01:00:00.000Z',
  }))
  assert.equal(olderNewScope.applied, true)
  assert.equal(store.getEvent('crown|football|gid=3400').active, false)

  store.applyBatch(listBatch(['3400'], {
    batchId: 'revive-newer-same-scope',
    scopeKey: 'revive-older-new-scope',
    capturedAt: '2026-07-10T05:00:00.000Z',
  }))
  assert.equal(store.getEvent('crown|football|gid=3400').active, true)
  store.close()
})

test('partial details persist baselines without creating or advancing scope rows', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  store.applyBatch(listBatch(['3500'], {
    batchId: 'detail-count-list',
    scopeKey: 'detail-count-list',
    capturedAt: '2026-07-10T05:00:00.000Z',
  }))
  const initialScopeCount = handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_scope_state').get().count
  for (let index = 0; index < 25; index += 1) {
    const capturedAt = new Date(Date.parse('2026-07-10T05:01:00.000Z') + index * 1000).toISOString()
    const result = store.applyBatch(detailBatch('3500', 0.9 + index / 1000, {
      batchId: `detail-count-${index}`,
      scopeKey: `detail-count-scope-${index}`,
      capturedAt,
    }))
    assert.equal(result.snapshots[0].schemaVersion, 2)
  }

  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_scope_state').get().count, initialScopeCount)
  assert.equal(store.getScope('detail-count-scope-0'), null)
  assert.notEqual(store.getSelection('crown|football|gid=3500|full_time|asian_handicap|RATIO_R|home'), null)
  store.close()
  handle.close()
})

test('scope lifecycle reader remains compatible with legacy arrays and active-missing objects', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const insert = handle.db.prepare(`
    INSERT INTO monitor_scope_state (
      scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json
    ) VALUES (?, ?, ?, ?, ?)
  `)
  insert.run('legacy-array', 'legacy-array-batch', '2026-07-10T01:00:00.000Z', '2026-07-10T01:00:00.000Z', JSON.stringify([
    'crown|football|gid=3600',
  ]))
  insert.run('legacy-object', 'legacy-object-batch', '2026-07-10T02:00:00.000Z', '2026-07-10T02:00:00.000Z', JSON.stringify({
    active: ['crown|football|gid=3601'],
    missing: { 'crown|football|gid=3601': 1 },
  }))

  assert.deepEqual(store.getScope('legacy-array'), {
    scopeKey: 'legacy-array',
    lastBatchId: 'legacy-array-batch',
    lastCapturedAt: '2026-07-10T01:00:00.000Z',
    lastCompleteAt: '2026-07-10T01:00:00.000Z',
    eventKeys: ['crown|football|gid=3600'],
    missingCounts: {},
    lastSeen: {},
    removedAt: {},
  })
  assert.deepEqual(store.getScope('legacy-object'), {
    scopeKey: 'legacy-object',
    lastBatchId: 'legacy-object-batch',
    lastCapturedAt: '2026-07-10T02:00:00.000Z',
    lastCompleteAt: '2026-07-10T02:00:00.000Z',
    eventKeys: ['crown|football|gid=3601'],
    missingCounts: { 'crown|football|gid=3601': 1 },
    lastSeen: {},
    removedAt: {},
  })
  store.close()
  handle.close()
})

test('incomplete batches are validated but never write scope, event, or selection state', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const incomplete = batch({
    batchId: 'incomplete-batch',
    complete: false,
  })

  assert.deepEqual(store.applyBatch(incomplete), {
    applied: false,
    status: 'incomplete',
    batch: incomplete,
    changes: [],
    snapshots: [],
    observedEventKeys: [],
  })
  for (const table of ['monitor_scope_state', 'monitor_event_state', 'monitor_selection_state']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }

  const invalid = batch({ batchId: 'invalid-incomplete', complete: false })
  invalid.oddsRecords[0].selection.selectionIdentity = 'invalid'
  assert.throws(() => store.applyBatch(invalid), /selectionIdentity/)
  for (const table of ['monitor_scope_state', 'monitor_event_state', 'monitor_selection_state']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }
  store.close()
  handle.close()
})

test('two empty list responses cannot age or remove existing scope, event, and selection checkpoints', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const request = { showtype: 'FT', rtype: 'r', filter: {} }
  const refs = [eventRef('3001'), eventRef('3002')]
  const initialList = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: { hasServerResponse: true, gameCount: 2, eligibleGameCount: 2 },
    records: [],
    eventRefs: refs,
    capturedAt: '2026-07-10T06:00:00.000Z',
    request,
    pollId: 'poll-empty-safety-baseline',
  })

  assert.equal(initialList.completeness, 'authoritative')
  store.applyBatch(initialList)
  store.applyBatch(detailBatch('3001', 0.92, {
    batchId: 'empty-safety-detail-3001',
    capturedAt: '2026-07-10T06:01:00.000Z',
  }))
  store.applyBatch(detailBatch('3002', 0.88, {
    batchId: 'empty-safety-detail-3002',
    capturedAt: '2026-07-10T06:01:00.000Z',
  }))

  const scopeBefore = store.getScope(initialList.scopeKey)
  const eventsBefore = refs.map((ref) => store.getEvent(ref.eventKey))
  const selectionIdentities = [
    'crown|football|gid=3001|full_time|asian_handicap|RATIO_R|home',
    'crown|football|gid=3002|full_time|asian_handicap|RATIO_R|home',
  ]
  const selectionsBefore = selectionIdentities.map((identity) => store.getSelection(identity))

  for (const [index, capturedAt] of [
    '2026-07-10T06:02:00.000Z',
    '2026-07-10T06:03:00.000Z',
  ].entries()) {
    const emptyList = buildSnapshotBatch({
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
      request,
      pollId: `poll-empty-safety-${index + 1}`,
    })
    const result = store.applyBatch(emptyList)

    assert.equal(emptyList.complete, false)
    assert.equal(emptyList.completeness, 'partial')
    assert.equal(result.applied, false)
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(result.changes, [])
  }

  assert.deepEqual(store.getScope(initialList.scopeKey), scopeBefore)
  assert.deepEqual(refs.map((ref) => store.getEvent(ref.eventKey)), eventsBefore)
  assert.deepEqual(selectionIdentities.map((identity) => store.getSelection(identity)), selectionsBefore)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_event_state WHERE active = 0').get().count, 0)
  store.close()
  handle.close()
})

test('two GIDs under one GIDM persist as two canonical events and selections without SQLite conflicts', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const gids = ['4101', '4102']
  const records = gids.map((gid, index) => normalizedRecord({
    gid,
    odds: 0.91 + index * 0.01,
    capturedAt: `2026-07-10T07:0${index + 1}:00.000Z`,
  }))
  const refs = records.map((record) => ({
    eventKey: record.event.eventKey,
    matchGroupKey: record.event.matchGroupKey,
    providerIds: record.event.providerIds,
    league: record.event.league,
    homeTeam: record.event.homeTeam,
    awayTeam: record.event.awayTeam,
  }))

  store.applyBatch(batch({
    batchId: 'same-gidm-list',
    pollId: 'same-gidm-list',
    scopeKey: 'same-gidm-scope',
    capturedAt: '2026-07-10T07:00:00.000Z',
    eventRefs: refs,
    oddsRecords: [],
  }))
  for (const [index, record] of records.entries()) {
    store.applyBatch(batch({
      batchId: `same-gidm-detail-${index + 1}`,
      pollId: `same-gidm-detail-${index + 1}`,
      scopeKey: `same-gidm-detail-scope-${index + 1}`,
      capturedAt: record.capturedAt,
      completeness: 'partial',
      eventRefs: [refs[index]],
      oddsRecords: [record],
    }))
  }

  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_event_state').get().count, 2)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_selection_state').get().count, 2)
  assert.deepEqual(
    handle.db.prepare('SELECT event_key FROM monitor_event_state ORDER BY event_key').all().map((row) => row.event_key),
    gids.map((gid) => `crown|football|gid=${gid}`),
  )
  assert.deepEqual(
    handle.db.prepare('SELECT selection_identity FROM monitor_selection_state ORDER BY selection_identity').all().map((row) => row.selection_identity),
    gids.map((gid) => `crown|football|gid=${gid}|full_time|asian_handicap|RATIO_R|home`),
  )
  store.close()
  handle.close()
})

test('stale batches and stale selection records cannot overwrite newer facts', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3001', '3002'], {
    batchId: 'new-list',
    capturedAt: '2026-07-10T02:00:00.000Z',
  }))
  const staleBatch = listBatch(['3001'], {
    batchId: 'stale-list',
    capturedAt: '2026-07-10T02:00:00.000Z',
  })
  const staleResult = store.applyBatch(staleBatch)
  assert.equal(staleResult.applied, false)
  assert.equal(staleResult.status, 'stale_batch')
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 0)
  assert.deepEqual(store.getScope('list-scope').eventKeys, [
    'crown|football|gid=3001',
    'crown|football|gid=3002',
  ])

  store.applyBatch(detailBatch('3001', 0.92, {
    batchId: 'selection-baseline',
    scopeKey: 'detail-stale-record',
    capturedAt: '2026-07-10T02:01:00.000Z',
  }))
  const staleRecordBatch = detailBatch('3001', 0.99, {
    batchId: 'new-envelope-old-record',
    scopeKey: 'detail-stale-record',
    capturedAt: '2026-07-10T02:02:00.000Z',
  })
  staleRecordBatch.oddsRecords[0].capturedAt = '2026-07-10T02:01:00.000Z'
  const staleRecord = store.applyBatch(staleRecordBatch)
  assert.deepEqual(staleRecord.changes, [])
  assert.deepEqual(staleRecord.snapshots, [])
  assert.equal(store.getSelection(staleRecordBatch.oddsRecords[0].selection.selectionIdentity).snapshot.selection.odds, 0.92)
  store.close()
})

test('partial unknown events keep inactive baselines and separate detail scopes do not block each other', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const unknown = store.applyBatch(detailBatch('3999', 0.91, {
    batchId: 'unknown-detail',
    scopeKey: 'unknown-detail-scope',
    capturedAt: '2026-07-10T03:00:00.000Z',
  }))
  assert.equal(unknown.applied, true)
  assert.deepEqual(unknown.changes, [])
  assert.equal(store.getEvent('crown|football|gid=3999').active, false)
  assert.notEqual(store.getSelection('crown|football|gid=3999|full_time|asian_handicap|RATIO_R|home'), null)

  const other = store.applyBatch(detailBatch('4000', 0.87, {
    batchId: 'other-detail-same-time',
    scopeKey: 'other-detail-scope',
    capturedAt: '2026-07-10T03:00:00.000Z',
  }))
  assert.equal(other.applied, true)
  assert.equal(store.getEvent('crown|football|gid=4000').active, false)
  store.close()
})

test('selection identity ignores handicap and emits handicap, suspension, reopen, and simultaneous odds facts', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const baseline = detailBatch('3001', 0.92, {
    batchId: 'facts-baseline',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:00:00.000Z',
  })
  store.applyBatch(baseline)
  const identity = baseline.oddsRecords[0].selection.selectionIdentity

  const handicap = store.applyBatch(detailBatch('3001', 0.92, {
    batchId: 'facts-handicap',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:01:00.000Z',
    handicap: 0.5,
    handicapRaw: '+0.5',
  }))
  assert.deepEqual(handicap.changes.map((change) => change.type), ['handicap-change'])
  assert.equal(handicap.changes[0].selection.selectionIdentity, identity)

  const suspended = store.applyBatch(detailBatch('3001', null, {
    batchId: 'facts-suspended',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:02:00.000Z',
    oddsRaw: '',
    handicap: 0.5,
    handicapRaw: '+0.5',
    suspended: true,
  }))
  assert.deepEqual(suspended.changes.map((change) => change.type), ['market-suspended'])

  const reopened = store.applyBatch(detailBatch('3001', 0.97, {
    batchId: 'facts-reopened',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:03:00.000Z',
    handicap: 0.5,
    handicapRaw: '+0.5',
  }))
  assert.deepEqual(reopened.changes.map((change) => change.type), ['odds-change', 'market-reopened'])
  assert.notEqual(reopened.changes[0].changeId, reopened.changes[1].changeId)

  const replayStore = openMonitorStateStore({ dbPath: ':memory:' })
  replayStore.applyBatch(baseline)
  replayStore.applyBatch(detailBatch('3001', 0.92, {
    batchId: 'facts-handicap',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:01:00.000Z',
    handicap: 0.5,
    handicapRaw: '+0.5',
  }))
  replayStore.applyBatch(detailBatch('3001', null, {
    batchId: 'facts-suspended',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:02:00.000Z',
    oddsRaw: '',
    handicap: 0.5,
    handicapRaw: '+0.5',
    suspended: true,
  }))
  const replay = replayStore.applyBatch(detailBatch('3001', 0.97, {
    batchId: 'facts-reopened',
    scopeKey: 'facts-detail',
    capturedAt: '2026-07-10T04:03:00.000Z',
    handicap: 0.5,
    handicapRaw: '+0.5',
  }))
  assert.deepEqual(replay.changes.map((change) => change.changeId), reopened.changes.map((change) => change.changeId))
  store.close()
  replayStore.close()
})

test('canonical market and selection identities are persisted and emitted when detail records omit copies', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const first = detailBatch('3100', 0.91, {
    batchId: 'derived-identity-first',
    scopeKey: 'derived-identity-scope',
    capturedAt: '2026-07-10T04:10:00.000Z',
  })
  delete first.oddsRecords[0].market.marketIdentity
  delete first.oddsRecords[0].selection.selectionIdentity
  store.applyBatch(first)

  const second = detailBatch('3100', 0.95, {
    batchId: 'derived-identity-second',
    scopeKey: 'derived-identity-scope',
    capturedAt: '2026-07-10T04:11:00.000Z',
  })
  delete second.oddsRecords[0].market.marketIdentity
  delete second.oddsRecords[0].selection.selectionIdentity
  const result = store.applyBatch(second)
  const canonicalMarket = 'crown|football|gid=3100|full_time|asian_handicap|RATIO_R'
  const canonicalSelection = `${canonicalMarket}|home`

  assert.deepEqual(result.changes.map((change) => change.type), ['odds-change'])
  assert.equal(result.changes[0].marketIdentity, canonicalMarket)
  assert.equal(result.changes[0].selectionIdentity, canonicalSelection)
  assert.equal(result.changes[0].next.market.marketIdentity, canonicalMarket)
  assert.equal(result.changes[0].next.selection.selectionIdentity, canonicalSelection)
  assert.equal(store.getSelection(canonicalSelection).selectionIdentity, canonicalSelection)
  store.close()
})

test('authoritative event existence comes only from eventRefs, even when a missing event has an odds row', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  store.applyBatch(listBatch(['3001', '3002'], { batchId: 'refs-first' }))
  const misleadingOdds = normalizedRecord({ gid: '3002', capturedAt: '2026-07-10T05:01:00.000Z' })
  store.applyBatch(batch({
    batchId: 'refs-first-miss',
    pollId: 'refs-first-miss',
    scopeKey: 'list-scope',
    capturedAt: '2026-07-10T05:01:00.000Z',
    completeness: 'authoritative',
    complete: true,
    eventRefs: [eventRef('3001')],
    oddsRecords: [misleadingOdds],
  }))
  assert.equal(store.getEvent('crown|football|gid=3002').missingCount, 1)
  assert.equal(store.getEvent('crown|football|gid=3002').active, true)
  store.close()
})

test('monitor state survives close and reopen with exact normalized values', () => {
  const dbPath = tempDbPath()
  const input = batch()
  const selectionId = input.oddsRecords[0].selection.selectionIdentity
  const first = openMonitorStateStore({ dbPath })

  const result = first.applyBatch(input)
  assert.deepEqual(result.changes.map((change) => change.type), ['event-added'])
  first.close()

  const second = openMonitorStateStore({ dbPath })
  assert.deepEqual(second.getScope(input.scopeKey), {
    scopeKey: input.scopeKey,
    lastBatchId: input.batchId,
    lastCapturedAt: input.capturedAt,
    lastCompleteAt: input.capturedAt,
    eventKeys: ['crown|football|gid=3001'],
    missingCounts: {},
    lastSeen: { 'crown|football|gid=3001': input.capturedAt },
    removedAt: {},
  })
  assert.deepEqual(second.getEvent('crown|football|gid=3001'), {
    eventKey: 'crown|football|gid=3001',
    matchGroupKey: 'crown|football|gidm=9001|lid=7001',
    active: true,
    missingCount: 0,
    lastSeenAt: input.capturedAt,
    providerIds: { gid: '3001', gidm: '9001', lid: '7001' },
    event: input.oddsRecords[0].event,
  })
  assert.deepEqual(second.getSelection(selectionId), {
    selectionIdentity: selectionId,
    eventKey: 'crown|football|gid=3001',
    capturedAt: input.capturedAt,
    snapshot: { schemaVersion: 2, ...input.oddsRecords[0] },
  })
  second.close()
})

test('one invalid selection rolls back the whole batch', () => {
  const store = openMonitorStateStore({ dbPath: tempDbPath() })
  const valid = normalizedRecord()
  const invalid = normalizedRecord({ side: 'away' })
  invalid.selection.selectionIdentity = 'not-canonical'
  const input = batch({ oddsRecords: [valid, invalid] })

  assert.throws(() => store.applyBatch(input), /selectionIdentity/)
  assert.equal(store.getScope(input.scopeKey), null)
  assert.equal(store.getEvent(valid.event.eventKey), null)
  assert.equal(store.getSelection(valid.selection.selectionIdentity), null)
  assert.deepEqual(store.listPendingAuditFacts(), [])
  store.close()
})

test('conflicting supplied selection identity copies roll back the whole batch', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const record = normalizedRecord()
  const canonicalIdentity = record.selection.selectionIdentity
  record.selectionIdentity = canonicalIdentity
  record.selection.selectionIdentity = 'not-canonical'
  const input = batch({ oddsRecords: [record] })

  assert.throws(() => store.applyBatch(input), /selectionIdentity/)
  assert.equal(store.getScope(input.scopeKey), null)
  assert.equal(store.getEvent(record.event.eventKey), null)
  assert.equal(store.getSelection(canonicalIdentity), null)
  store.close()
})

test('batch envelope and canonical event identities fail closed', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const invalidBatches = [
    { ...batch(), schemaVersion: 1 },
    { ...batch(), batchId: '' },
    { ...batch(), scopeKey: '   ' },
    { ...batch(), capturedAt: 'not-a-time' },
    batch({ eventRefs: [{ eventKey: 'legacy-event-key' }], oddsRecords: [] }),
    batch({ eventRefs: [], oddsRecords: [{ ...normalizedRecord(), event: { eventKey: 'legacy-event-key' } }] }),
  ]

  for (const input of invalidBatches) {
    assert.throws(() => store.applyBatch(input))
  }
  assert.equal(store.getScope('scope-today-ft'), null)
  store.close()
})

test('partial batches preserve the authoritative scope checkpoint', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const first = batch({
    eventRefs: [
      { eventKey: 'crown|football|gid=3001', providerIds: { gid: '3001' } },
      { eventKey: 'crown|football|gid=3002', providerIds: { gid: '3002' } },
    ],
    oddsRecords: [],
  })
  store.applyBatch(first)
  const authoritativeCheckpoint = store.getScope(first.scopeKey)
  store.applyBatch(batch({
    batchId: 'batch-detail',
    capturedAt: '2026-07-10T01:03:03.000Z',
    completeness: 'partial',
    eventRefs: [{ eventKey: 'crown|football|gid=3001', providerIds: { gid: '3001' } }],
    oddsRecords: [normalizedRecord({ capturedAt: '2026-07-10T01:03:03.000Z' })],
  }))

  assert.deepEqual(store.getScope(first.scopeKey), authoritativeCheckpoint)
  store.close()
})

function sensitiveKeys(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveKeys(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return []
  const forbidden = /^(authorization|cookie|cookies|password|token|session|headers|rawhttpheaders|ticketid)$/i
  return Object.entries(value).flatMap(([key, item]) => [
    ...(forbidden.test(key.replaceAll(/[-_]/g, '')) ? [`${path}.${key}`] : []),
    ...sensitiveKeys(item, `${path}.${key}`),
  ])
}

test('persisted JSON contains normalized business data without sensitive keys', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const input = batch()
  input.classification = { headers: { authorization: 'Bearer secret' }, session: 'secret' }
  input.eventRefs[0].providerIds.token = 'secret'
  input.eventRefs[0].rawHttpResponse = 'secret'
  input.oddsRecords[0].source.headers = { cookie: 'sid=secret' }
  input.oddsRecords[0].event.password = 'secret'
  input.oddsRecords[0].event.rawProviderResponse = 'secret'
  input.oddsRecords[0].selection.ticketId = 'secret'
  store.applyBatch(input)

  const jsonColumns = [
    ...handle.db.prepare('SELECT provider_ids_json AS value FROM monitor_event_state').all(),
    ...handle.db.prepare('SELECT event_json AS value FROM monitor_event_state').all(),
    ...handle.db.prepare('SELECT snapshot_json AS value FROM monitor_selection_state').all(),
  ]
  for (const row of jsonColumns) {
    assert.deepEqual(sensitiveKeys(JSON.parse(row.value)), [])
    assert.doesNotMatch(row.value, /secret/)
  }
  store.close()
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_scope_state').get().count, 1)
  handle.close()
})

test('owned close is idempotent while external database lifetime belongs to its caller', () => {
  const owned = openMonitorStateStore({ dbPath: tempDbPath() })
  owned.close()
  assert.doesNotThrow(() => owned.close())

  const handle = openAppDatabase({ dbPath: ':memory:' })
  const external = new MonitorStateStore({ db: handle.db })
  external.close()
  assert.equal(handle.db.prepare('SELECT 1 AS value').get().value, 1)
  handle.close()
})

test('signal insertion is idempotent and delivery primitives persist due work', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const signal = persistentSignal({ channels: [' console ', 'telegram', 'console'] })

  assert.deepEqual(store.insertSignal(signal), { inserted: true, reason: null, signalId: signal.signalId })
  assert.deepEqual(store.insertSignal({ ...signal, channels: ['console'] }), {
    inserted: false,
    reason: 'duplicate',
    signalId: signal.signalId,
  })
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_signals').get().count, 1)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM monitor_deliveries').get().count, 2)
  const { channels: _channels, ...expectedSignal } = signal
  assert.deepEqual(store.getSignal(signal.signalId), expectedSignal)
  assert.deepEqual(store.getCooldown(signal.signalKey), {
    signalKey: signal.signalKey,
    expiresAt: signal.expiresAt,
  })

  const due = store.claimPendingDeliveries({ now: signal.observedAt, limit: 1 })
  assert.equal(due.length, 1)
  assert.equal(due[0].signalId, signal.signalId)
  assert.equal(due[0].attempts, 0)
  assert.deepEqual(due[0].signal, expectedSignal)

  store.completeDelivery({
    signalId: due[0].signalId,
    channel: due[0].channel,
    claimToken: due[0].claimToken,
    status: 'retry',
    attempts: 1,
    errorCode: 'temporary',
    nextAttemptAt: '2026-07-10T01:05:00.000Z',
    updatedAt: '2026-07-10T01:00:01.000Z',
  })
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT status, attempts, next_attempt_at, last_error_code, updated_at
    FROM monitor_deliveries WHERE signal_id = ? AND channel = ?
  `).get(due[0].signalId, due[0].channel) }, {
    status: 'retry',
    attempts: 1,
    next_attempt_at: '2026-07-10T01:05:00.000Z',
    last_error_code: 'temporary',
    updated_at: '2026-07-10T01:00:01.000Z',
  })
  store.close()
  handle.close()
})

test('persistent cooldown survives restart, isolates strategies, and expires deterministically', () => {
  const dbPath = tempDbPath()
  const first = openMonitorStateStore({ dbPath })
  const original = persistentSignal()
  assert.equal(first.insertSignal(original).inserted, true)
  first.close()

  const second = openMonitorStateStore({ dbPath })
  const duringCooldown = persistentSignal({
    changeId: 'b'.repeat(64),
    observedAt: '2026-07-10T01:00:30.000Z',
    expiresAt: '2026-07-10T01:01:30.000Z',
  })
  assert.deepEqual(second.insertSignal(duringCooldown), {
    inserted: false,
    reason: 'cooldown_active',
    signalId: duringCooldown.signalId,
    signalKey: duringCooldown.signalKey,
    cooldownExpiresAt: original.expiresAt,
  })
  assert.equal(second.getSignal(duringCooldown.signalId), null)
  assert.deepEqual(second.getCooldown(original.signalKey), {
    signalKey: original.signalKey,
    expiresAt: original.expiresAt,
  })

  const otherStrategy = persistentSignal({
    changeId: 'c'.repeat(64),
    strategyId: 'strategy-2',
    observedAt: duringCooldown.observedAt,
    expiresAt: duringCooldown.expiresAt,
  })
  assert.equal(second.insertSignal(otherStrategy).inserted, true)

  const afterExpiry = persistentSignal({
    changeId: 'd'.repeat(64),
    observedAt: original.expiresAt,
    expiresAt: '2026-07-10T01:02:00.000Z',
  })
  assert.equal(second.insertSignal(afterExpiry).inserted, true)
  assert.equal(second.getSignal(afterExpiry.signalId).signalId, afterExpiry.signalId)
  assert.equal(second.getCooldown(afterExpiry.signalKey).expiresAt, afterExpiry.expiresAt)

  assert.deepEqual(second.insertSignal(original), {
    inserted: false,
    reason: 'duplicate',
    signalId: original.signalId,
  })
  assert.equal(second.countSignals(), 3)
  second.close()
})

test('signal, unique channel deliveries, and cooldown roll back atomically on failure', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const signal = persistentSignal()
  handle.db.exec(`
    CREATE TRIGGER reject_monitor_delivery
    BEFORE INSERT ON monitor_deliveries
    BEGIN
      SELECT RAISE(ABORT, 'injected-delivery-failure');
    END;
  `)

  assert.throws(() => store.insertSignal(signal), /injected-delivery-failure/)
  assert.equal(store.getSignal(signal.signalId), null)
  assert.equal(store.getCooldown(signal.signalKey), null)
  assert.equal(store.countSignals(), 0)
  assert.equal(store.countDeliveries(), 0)
  store.close()
  handle.close()
})

test('Signal delivery channels are explicit, non-empty, normalized, and supported', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const missing = persistentSignal({ changeId: '1'.repeat(64) })
  delete missing.channels
  const invalid = [
    missing,
    persistentSignal({ changeId: '2'.repeat(64), channels: [] }),
    persistentSignal({ changeId: '3'.repeat(64), channels: ['   '] }),
    persistentSignal({ changeId: '4'.repeat(64), channels: ['email'] }),
    persistentSignal({ changeId: '5'.repeat(64), channels: [42] }),
  ]

  for (const signal of invalid) assert.throws(() => store.insertSignal(signal), /channels|channel/)
  assert.equal(store.countSignals(), 0)
  assert.equal(store.countCooldowns(), 0)
  assert.equal(store.countDeliveries(), 0)
  store.close()
})

test('ignored Signal or Delivery inserts are hard failures and roll back the transaction', () => {
  for (const target of ['monitor_signals', 'monitor_deliveries']) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    const store = new MonitorStateStore({ db: handle.db })
    const signal = persistentSignal({ changeId: target === 'monitor_signals' ? '6'.repeat(64) : '7'.repeat(64) })
    handle.db.exec(`
      CREATE TRIGGER ignore_${target}
      BEFORE INSERT ON ${target}
      ${target === 'monitor_deliveries' ? "WHEN NEW.channel = 'telegram'" : ''}
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `)

    assert.throws(() => store.insertSignal(signal), /insert/i)
    assert.equal(store.countSignals(), 0)
    assert.equal(store.countCooldowns(), 0)
    assert.equal(store.countDeliveries(), 0)
    store.close()
    handle.close()
  }
})

test('a pre-existing conflicting Delivery cannot silently produce a partial Signal transaction', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const signal = persistentSignal({ changeId: '8'.repeat(64), channels: ['console'] })
  handle.db.prepare(`
    INSERT INTO monitor_deliveries (
      signal_id, channel, status, attempts, next_attempt_at, last_error_code, updated_at
    ) VALUES (?, 'console', 'pending', 0, ?, '', ?)
  `).run(signal.signalId, signal.observedAt, signal.observedAt)

  assert.throws(() => store.insertSignal(signal), /UNIQUE|constraint|delivery/i)
  assert.equal(store.countSignals(), 0)
  assert.equal(store.countCooldowns(), 0)
  assert.equal(store.countDeliveries(), 1)
  store.close()
  handle.close()
})

test('ignored or aborted cooldown inserts roll back Signal and all channel deliveries', () => {
  for (const behavior of ['IGNORE', "ABORT, 'injected-cooldown-failure'"]) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    const store = new MonitorStateStore({ db: handle.db })
    const signal = persistentSignal({ changeId: behavior.startsWith('IGNORE') ? 'c'.repeat(64) : 'd'.repeat(64) })
    handle.db.exec(`
      CREATE TRIGGER reject_cooldown_insert
      BEFORE INSERT ON monitor_cooldowns
      BEGIN
        SELECT RAISE(${behavior});
      END;
    `)

    assert.throws(() => store.insertSignal(signal), /cooldown|injected/i)
    assert.equal(store.countSignals(), 0)
    assert.equal(store.countDeliveries(), 0)
    assert.equal(store.countCooldowns(), 0)
    store.close()
    handle.close()
  }
})

test('expired cooldown cleanup rolls back when the new cooldown write is ignored', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  handle.db.prepare('INSERT INTO monitor_cooldowns (signal_key, expires_at) VALUES (?, ?)')
    .run('expired-before-failure', '2026-07-10T00:00:00.000Z')
  handle.db.exec(`
    CREATE TRIGGER ignore_new_cooldown
    BEFORE INSERT ON monitor_cooldowns
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `)
  const signal = persistentSignal({
    changeId: 'e'.repeat(64),
    observedAt: '2026-07-10T02:00:00.000Z',
    expiresAt: '2026-07-10T02:01:00.000Z',
  })

  assert.throws(() => store.insertSignal(signal), /cooldown/i)
  assert.equal(store.countSignals(), 0)
  assert.equal(store.countDeliveries(), 0)
  assert.equal(store.countCooldowns(), 1)
  assert.deepEqual(store.getCooldown('expired-before-failure'), {
    signalKey: 'expired-before-failure',
    expiresAt: '2026-07-10T00:00:00.000Z',
  })
  store.close()
  handle.close()
})

test('canonical Signal numbers survive JSON and database restart without negative zero drift', () => {
  const signal = persistentSignal({
    changeId: '9'.repeat(64),
    threshold: -0,
    oldOdds: -0,
    nextOdds: 0.1,
    handicap: -0,
    minutesBeforeKickoff: 120.125,
  })
  for (const value of [signal.trigger.threshold, signal.evidence.oldOdds, signal.evidence.handicap]) {
    assert.equal(Object.is(value, -0), false)
  }
  const { channels, ...payload } = signal
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)

  const dbPath = tempDbPath()
  const first = openMonitorStateStore({ dbPath })
  const reordered = { ...Object.fromEntries(Object.entries(payload).reverse()), channels }
  assert.equal(first.insertSignal(reordered).inserted, true)
  first.close()
  const second = openMonitorStateStore({ dbPath })
  assert.deepEqual(second.getSignal(payload.signalId), payload)
  second.close()
})

test('incomplete or incoherent Signal payloads fail before persistence', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const missingTarget = persistentSignal({ changeId: 'e'.repeat(64) })
  delete missingTarget.target
  const wrongKey = persistentSignal({ changeId: 'f'.repeat(64) })
  wrongKey.signalKey = `another-strategy|${wrongKey.target.selectionIdentity}`
  const noncanonicalTime = persistentSignal({ changeId: '7'.repeat(64) })
  noncanonicalTime.observedAt = '2026-07-10T09:00:00+08:00'
  noncanonicalTime.expiresAt = '2026-07-10T09:01:00+08:00'
  noncanonicalTime.trigger.observedAt = noncanonicalTime.observedAt
  const sideways = structuredClone(persistentSignal({ changeId: '1'.repeat(64) }))
  sideways.trigger.direction = 'sideways'
  const negativeThreshold = structuredClone(persistentSignal({ changeId: '2'.repeat(64) }))
  negativeThreshold.trigger.threshold = -0.01
  const forgedId = structuredClone(persistentSignal({ changeId: '3'.repeat(64) }))
  forgedId.signalId = '9'.repeat(64)
  const brokenHierarchy = structuredClone(persistentSignal({ changeId: '4'.repeat(64) }))
  brokenHierarchy.target.marketIdentity = `${brokenHierarchy.target.eventIdentity}|first_half|asian_handicap|RATIO_R`
  const brokenSide = structuredClone(persistentSignal({ changeId: '5'.repeat(64) }))
  brokenSide.target.side = 'away'
  const badQuality = structuredClone(persistentSignal({ changeId: '6'.repeat(64) }))
  badQuality.dataQuality.complete = false
  const objectOdds = structuredClone(persistentSignal({ changeId: '8'.repeat(64) }))
  objectOdds.evidence.oldOdds = { rawProviderResponse: '<serverresponse />' }
  const rawDelta = structuredClone(persistentSignal({ changeId: '9'.repeat(64) }))
  rawDelta.trigger.delta = '<serverresponse />'
  const rawEndpointKind = structuredClone(persistentSignal({ changeId: '0'.repeat(64) }))
  rawEndpointKind.evidence.source.endpointKind = '<serverresponse>raw XML</serverresponse>'
  const inconsistentOdds = structuredClone(persistentSignal({ changeId: 'b'.repeat(64) }))
  inconsistentOdds.evidence.nextOdds = 0.9

  assert.throws(() => store.insertSignal(missingTarget), /target/)
  assert.throws(() => store.insertSignal(wrongKey), /signalKey/)
  assert.throws(() => store.insertSignal(noncanonicalTime), /canonical UTC timestamp/)
  assert.throws(() => store.insertSignal(sideways), /direction/)
  assert.throws(() => store.insertSignal(negativeThreshold), /threshold/)
  assert.throws(() => store.insertSignal(forgedId), /signalId/)
  assert.throws(() => store.insertSignal(brokenHierarchy), /marketIdentity|selectionIdentity/)
  assert.throws(() => store.insertSignal(brokenSide), /side/)
  assert.throws(() => store.insertSignal(badQuality), /dataQuality\.complete/)
  assert.throws(() => store.insertSignal(objectOdds), /oldOdds/)
  assert.throws(() => store.insertSignal(rawDelta), /delta/)
  assert.throws(() => store.insertSignal(rawEndpointKind), /endpointKind/)
  assert.throws(() => store.insertSignal(inconsistentOdds), /direction|delta/)
  assert.equal(store.countSignals(), 0)
  assert.equal(store.countCooldowns(), 0)
  assert.equal(store.countDeliveries(), 0)
  store.close()
})

test('expired cooldown cleanup is bounded per insertion', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const store = new MonitorStateStore({ db: handle.db })
  const insert = handle.db.prepare('INSERT INTO monitor_cooldowns (signal_key, expires_at) VALUES (?, ?)')
  for (let index = 0; index < 5; index += 1) {
    insert.run(`expired-${index}`, `2026-07-10T00:0${index}:00.000Z`)
  }

  const signal = persistentSignal({ observedAt: '2026-07-10T02:00:00.000Z', expiresAt: '2026-07-10T02:01:00.000Z' })
  assert.equal(store.insertSignal(signal, { cleanupLimit: 2 }).inserted, true)
  assert.equal(store.countCooldowns(), 4)
  assert.equal(store.getCooldown('expired-0'), null)
  assert.equal(store.getCooldown('expired-1'), null)
  assert.notEqual(store.getCooldown('expired-2'), null)
  store.close()
  handle.close()
})

test('persisted Signal payload is complete and strips sensitive or non-Signal fields', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const signal = persistentSignal()
  signal.headers = { authorization: 'Bearer secret' }
  signal.evidence.session = 'secret'
  signal.evidence.rawProviderResponse = '<secret />'
  signal.evidence.candidate = { candidateId: 'candidate-secret' }
  signal.dataQuality.token = 'secret'
  store.insertSignal(signal)

  const persisted = store.getSignal(signal.signalId)
  const encoded = JSON.stringify(persisted)
  assert.doesNotMatch(encoded, /secret|authorization|session|rawProviderResponse|candidate|token/i)
  assert.equal(persisted.signalId, signal.signalId)
  assert.equal(persisted.evidence.changeId, signal.evidence.changeId)
  assert.equal(persisted.target.selectionIdentity, signal.target.selectionIdentity)
  store.close()
})
