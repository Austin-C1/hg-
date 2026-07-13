import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createDirectV2AlertDispatcher,
  createWatcherStats,
  persistDirectV2Candidates,
  persistDirectV2Signals,
  processDirectXmlV2,
  runDirectApiPollOnce,
  runDirectApiWatch,
} from '../scripts/crown-watch.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { AlertDispatcher } from '../src/crown/monitor/alert-dispatcher.mjs'
import { JsonlV2AuditStore } from '../src/crown/storage/jsonl-v2-audit-store.mjs'

const listXml = fs.readFileSync('data/fixtures/crown/transform-xml/get-game-list-today.xml', 'utf8')

function detailXml(gid, { withoutEcid = true, changedOdds = null } = {}) {
  const block = listXml.match(new RegExp(`<game id="${gid}">[\\s\\S]*?</game>`))?.[0]
  assert.ok(block, `fixture game ${gid} must exist`)
  let game = block
  if (withoutEcid) game = game.replace(/\s*<ECID>[\s\S]*?<\/ECID>/i, '')
  if (changedOdds !== null) game = game.replace(/<IOR_RH>[\s\S]*?<\/IOR_RH>/i, `<IOR_RH>${changedOdds}</IOR_RH>`)
  return `<?xml version="1.0" encoding="UTF-8"?><serverresponse><dataCount>1</dataCount>${game}</serverresponse>`
}

function lines(file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : []
}

test('direct Crown XML v2 chain preserves list lifecycle across details and audits one later odds change', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-watch-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')
  const changesPath = path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  const pollId = 'poll-list-and-details'
  const listScope = {
    endpointKind: 'get_game_list',
    p3type: '', date: '', gtype: 'ft', showtype: 'today', rtype: 'r', ltype: '3', filter: 'MIX',
  }
  const detailScope = (gid, lid, ecid) => ({
    endpointKind: 'get_game_more', gid, gtype: 'ft', showtype: 'today', ltype: '3', isRB: 'N', lid, filter: 'Main', ecid,
  })

  try {
    const list = await processDirectXmlV2({
      body: listXml,
      endpointKind: 'get_game_list',
      capturedAt: '2026-07-08T12:00:00.000Z',
      pollId,
      requestScope: listScope,
      stateStore,
      auditStore,
    })
    const detailA = await processDirectXmlV2({
      body: detailXml('1001'),
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T12:00:01.000Z',
      pollId,
      requestScope: detailScope('1001', '7001', '8001'),
      stateStore,
      auditStore,
    })
    const detailB = await processDirectXmlV2({
      body: detailXml('2001'),
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T12:00:02.000Z',
      pollId,
      requestScope: detailScope('2001', '7002', '8002'),
      stateStore,
      auditStore,
    })
    const changedA = await processDirectXmlV2({
      body: detailXml('1001', { changedOdds: '0.810' }),
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T12:00:03.000Z',
      pollId,
      requestScope: detailScope('1001', '7001', '8001'),
      stateStore,
      auditStore,
    })

    assert.equal(list.batch.completeness, 'authoritative')
    assert.deepEqual(list.batch.eventRefs.map((event) => event.eventKey), [
      'crown|football|gid=1001',
      'crown|football|gid=2001',
    ])
    assert.equal(detailA.batch.eventRefs[0].providerIds.ecid, null)
    assert.equal(detailA.batch.eventRefs[0].eventKey, list.batch.eventRefs[0].eventKey)
    assert.equal(detailA.changes.some((change) => change.type === 'event-removed'), false)
    assert.equal(detailB.changes.some((change) => change.type === 'event-removed'), false)
    assert.equal(changedA.changes.filter((change) => change.type === 'odds-change').length, 1)
    assert.equal(changedA.changes[0].event.eventKey, 'crown|football|gid=1001')
    assert.equal(stateStore.getEvent('crown|football|gid=1001').active, true)
    assert.equal(stateStore.getEvent('crown|football|gid=2001').active, true)

    const beforeInvalid = {
      scope: stateStore.getScope(list.batch.scopeKey),
      eventA: stateStore.getEvent('crown|football|gid=1001'),
      eventB: stateStore.getEvent('crown|football|gid=2001'),
      snapshotLines: lines(snapshotsPath).length,
      changeLines: lines(changesPath).length,
    }
    const invalid = await processDirectXmlV2({
      body: '<serverresponse><game><GID>1001</GID>',
      endpointKind: 'get_game_list',
      capturedAt: '2026-07-08T12:00:04.000Z',
      pollId: 'poll-invalid',
      requestScope: listScope,
      stateStore,
      auditStore,
    })
    assert.equal(invalid.applied, false)
    assert.equal(invalid.status, 'incomplete')
    assert.deepEqual(stateStore.getScope(list.batch.scopeKey), beforeInvalid.scope)
    assert.deepEqual(stateStore.getEvent('crown|football|gid=1001'), beforeInvalid.eventA)
    assert.deepEqual(stateStore.getEvent('crown|football|gid=2001'), beforeInvalid.eventB)
    assert.equal(lines(snapshotsPath).length, beforeInvalid.snapshotLines)
    assert.equal(lines(changesPath).length, beforeInvalid.changeLines)

    const changes = lines(changesPath)
    assert.equal(changes.filter((change) => change.type === 'odds-change').length, 1)
    assert.equal(changes.some((change) => change.type === 'event-removed'), false)
    const auditText = `${fs.readFileSync(snapshotsPath, 'utf8')}\n${fs.readFileSync(changesPath, 'utf8')}`
    assert.doesNotMatch(auditText, /"candidate(?:Reason)?"/i)
    assert.doesNotMatch(auditText, /"(?:uid|cookie|cookies|token|password|session)"/i)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots.jsonl')), false)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-changes.jsonl')), false)
  } finally {
    stateStore.close()
  }
})

test('fresh direct-v2 watcher poll warms authoritative and detail baselines before exactly one later Signal', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-dry-init-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({
    snapshotsPath: path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl'),
    changesPath: path.join(runtimeDir, 'crown-odds-changes-v2.jsonl'),
  })
  const stats = createWatcherStats()
  const account = { id: 'mon_primary', loginUrl: 'https://fixture.invalid', consecutiveFailures: 0 }
  const configState = {
    current: {
      leagueConfig: null,
      defaultLeagues: null,
      telegramSettings: { oddsAlert: { enabled: false } },
      monitorSettings: {
        version: 2,
        prematch: {
          enabled: true,
          minOdds: null,
          maxOdds: null,
          waterMoveThreshold: 0.01,
          waterMoveDirection: 'both',
          cooldownSeconds: 60,
          startMinutesBeforeKickoff: 2880,
          stopMinutesBeforeKickoff: 0,
          remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
        },
        live: {
          enabled: false, minOdds: null, maxOdds: null, waterMoveThreshold: 0.03,
          waterMoveDirection: 'both', cooldownSeconds: 60, liveMinuteFrom: 10, liveMinuteTo: 75,
          includeFirstHalf: true, includeSecondHalf: true, includeHalfTime: false,
          remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
        },
      },
    },
  }
  let detailFetches = 0
  let clock = 0
  const listXmlWithSystemTime = listXml.replace(
    '<serverresponse>',
    '<serverresponse><system_time>2026-07-08 08:00:00</system_time>',
  )
  const times = [
    '2026-07-08T12:00:00.000Z',
    '2026-07-08T12:00:01.000Z',
    '2026-07-08T12:00:02.000Z',
    '2026-07-08T12:00:03.000Z',
  ]
  const apiLoginManager = {
    async fetchFootballToday() {
      return {
        text: listXmlWithSystemTime,
        session: { uid: 'fixture' },
        requestScope: {
          endpointKind: 'get_game_list',
          p3type: '', date: '', gtype: 'ft', showtype: 'today', rtype: 'r', ltype: '3', filter: 'MIX',
        },
      }
    },
    async fetchFootballGameMore({ target }) {
      detailFetches += 1
      return {
        text: detailXml('1001', { changedOdds: detailFetches === 1 ? null : '0.810' }),
        session: { uid: 'fixture' },
        requestScope: {
          endpointKind: 'get_game_more', gid: '1001', gtype: 'ft', showtype: 'today', ltype: '3',
          isRB: 'N', lid: target.lid, filter: 'Main', ecid: target.ecid,
        },
      }
    },
  }
  const logger = { log() {}, error() {} }
  const args = {
    appDbPath: dbPath,
    maxGameMore: 1,
  }
  const dependencies = {
    stats,
    configState,
    logger,
    monitorAccount: account,
    apiLoginManager,
    stateStore,
    auditStore,
    createPollId: () => `poll-${clock}`,
    now: () => times[clock++],
    loadMonitorAccount: () => account,
    loadTrackedMatches: () => [],
    updateMonitorAccount() {},
  }

  try {
    const warmup = await runDirectApiPollOnce(args, dependencies)
    assert.equal(warmup.ok, true)
    assert.equal(stateStore.countSignals(), 0)
    assert.equal(warmup.details[0].result.records[0].event.startTimeUtc, '2026-07-09T01:00:00.000Z')
    assert.equal(warmup.details[0].result.records[0].event.timeZone, 'UTC-04:00')
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')), true)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots.jsonl')), false)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-changes.jsonl')), false)

    const changed = await runDirectApiPollOnce(args, dependencies)
    assert.equal(changed.ok, true)
    assert.equal(stateStore.countSignals(), 1)
    assert.equal(stateStore.db.prepare("SELECT COUNT(*) AS count FROM monitor_signals WHERE json_extract(payload_json, '$.trigger.type') = 'odds-change'").get().count, 1)
  } finally {
    auditStore.close()
    stateStore.close()
  }
})

test('drained Change is evaluated into one persistent Signal and dispatched without replay duplication', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-signal-chain-'))
  const stateStore = openMonitorStateStore({ dbPath: path.join(runtimeDir, 'state.sqlite') })
  const auditStore = new JsonlV2AuditStore({
    snapshotsPath: path.join(runtimeDir, 's.jsonl'),
    changesPath: path.join(runtimeDir, 'c.jsonl'),
  })
  const common = {
    endpointKind: 'get_game_more',
    pollId: 'signal-chain-poll',
    requestScope: { endpointKind: 'get_game_more', lid: '7001', ecid: '8001' },
    stateStore,
    auditStore,
  }
  try {
    await processDirectXmlV2({ ...common, body: detailXml('1001'), capturedAt: '2026-07-08T12:00:00.000Z' })
    const changed = await processDirectXmlV2({
      ...common,
      body: detailXml('1001', { changedOdds: '0.810' }),
      capturedAt: '2026-07-08T12:00:01.000Z',
    })
    const monitorSettings = {
      version: 2,
      prematch: {
        enabled: true,
        minOdds: null,
        maxOdds: null,
        waterMoveThreshold: 0.01,
        waterMoveDirection: 'both',
        cooldownSeconds: 60,
        startMinutesBeforeKickoff: 180,
        stopMinutesBeforeKickoff: 5,
        remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
      },
      live: {
        enabled: false, minOdds: null, maxOdds: null, waterMoveThreshold: 0.03,
        waterMoveDirection: 'both', cooldownSeconds: 60, liveMinuteFrom: 10, liveMinuteTo: 75,
        includeFirstHalf: true, includeSecondHalf: true, includeHalfTime: false,
        remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
      },
    }
    const first = persistDirectV2Signals({
      changes: changed.changes,
      stateStore,
      monitorSettings,
      defaultLeagues: null,
      trackedMatches: [],
    })
    let deliverySettled = false
    const deliveryPromise = new AlertDispatcher({
      store: stateStore,
      sendTimeoutMs: 15,
      senders: { console: () => new Promise(() => {}) },
    }).tick(changed.changes[0].observedAt).finally(() => { deliverySettled = true })
    const replay = persistDirectV2Signals({
      changes: changed.changes,
      stateStore,
      monitorSettings,
      defaultLeagues: null,
      trackedMatches: [],
    })
    assert.equal(deliverySettled, false)
    await deliveryPromise
    assert.equal(first.inserted.length, 1)
    assert.equal(replay.inserted.length, 0)
    assert.equal(replay.duplicates, 1)
    assert.equal(stateStore.countSignals(), 1)
    assert.equal(stateStore.countDeliveries(), 1)
    assert.equal(stateStore.db.prepare('SELECT status FROM monitor_deliveries').get().status, 'retry')
    const row = stateStore.db.prepare('SELECT payload_json FROM monitor_signals').get()
    const signal = JSON.parse(row.payload_json)
    assert.equal(signal.evidence.changeId, changed.changes[0].changeId)
    assert.equal(signal.strategyId, 'legacy-monitor-prematch-odds-delta')
  } finally {
    auditStore.close()
    stateStore.close()
  }
})

test('audit outbox retries partial JSONL failure after restart without duplicate facts and returns the original change', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-outbox-retry-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')
  const changesPath = path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')
  const realAudit = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  let stateStore = openMonitorStateStore({ dbPath })
  const common = {
    endpointKind: 'get_game_more',
    pollId: 'poll-outbox',
    requestScope: { endpointKind: 'get_game_more', lid: '7001', ecid: '8001' },
  }
  try {
    await processDirectXmlV2({
      ...common,
      body: detailXml('1001'),
      capturedAt: '2026-07-08T12:10:00.000Z',
      stateStore,
      auditStore: realAudit,
    })

    const partialFailure = {
      appendFacts(facts) {
        realAudit.appendFacts({ snapshots: facts.snapshots, changes: [] })
        throw new Error('injected changes append failure')
      },
    }
    await assert.rejects(processDirectXmlV2({
      ...common,
      body: detailXml('1001', { changedOdds: '0.810' }),
      capturedAt: '2026-07-08T12:10:01.000Z',
      stateStore,
      auditStore: partialFailure,
    }), /injected changes append failure/)
    assert.equal(stateStore.listPendingAuditFacts().length, 9)
    const snapshotsAfterFailure = lines(snapshotsPath).length
    const changesAfterFailure = lines(changesPath).length
    stateStore.close()

    stateStore = openMonitorStateStore({ dbPath })
    const retried = await processDirectXmlV2({
      ...common,
      body: detailXml('1001', { changedOdds: '0.810' }),
      capturedAt: '2026-07-08T12:10:01.000Z',
      stateStore,
      auditStore: realAudit,
    })
    assert.equal(retried.applied, true)
    assert.equal(retried.status, 'applied')
    assert.equal(retried.snapshots.length, 0)
    assert.deepEqual(retried.currentChanges, [])
    assert.equal(retried.changes.filter((change) => change.type === 'odds-change').length, 1)
    assert.deepEqual(stateStore.listPendingAuditFacts(), [])
    assert.equal(lines(snapshotsPath).length, snapshotsAfterFailure)
    assert.equal(lines(changesPath).length, changesAfterFailure + 1)
    assert.equal(lines(changesPath).filter((row) => row.changeId === retried.changes[0].changeId).length, 1)
  } finally {
    stateStore.close()
  }
})

test('audit retry after append succeeds but delivery mark fails does not duplicate JSONL rows', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-outbox-ack-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const snapshotsPath = path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')
  const changesPath = path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')
  const auditStore = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  let stateStore = openMonitorStateStore({ dbPath })
  const originalMark = stateStore.markAuditFactsDelivered?.bind(stateStore)
  stateStore.markAuditFactsDelivered = () => { throw new Error('injected mark failure') }
  const input = {
    body: detailXml('1001'),
    endpointKind: 'get_game_more',
    capturedAt: '2026-07-08T12:20:00.000Z',
    pollId: 'poll-ack',
    requestScope: { endpointKind: 'get_game_more', lid: '7001', ecid: '8001' },
    stateStore,
    auditStore,
  }
  try {
    await assert.rejects(processDirectXmlV2(input), /injected mark failure/)
    assert.equal(lines(snapshotsPath).length, 8)
    assert.equal(stateStore.listPendingAuditFacts().length, 8)
    stateStore.markAuditFactsDelivered = originalMark
    stateStore.close()

    stateStore = openMonitorStateStore({ dbPath })
    const retried = await processDirectXmlV2({ ...input, stateStore })
    assert.equal(retried.changes.length, 0)
    assert.equal(lines(snapshotsPath).length, 8)
    assert.deepEqual(stateStore.listPendingAuditFacts(), [])
  } finally {
    stateStore.close()
  }
})

test('truncated JSONL tails remain diagnostic rows while outbox facts are exported before acknowledgement', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-tail-outbox-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const snapshotsPath = path.join(runtimeDir, 's.jsonl')
  const changesPath = path.join(runtimeDir, 'c.jsonl')
  fs.writeFileSync(snapshotsPath, '{partial', 'utf8')
  fs.writeFileSync(changesPath, '{partial', 'utf8')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  try {
    const result = await processDirectXmlV2({
      body: detailXml('1001'),
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T12:30:00.000Z',
      pollId: 'tail-outbox',
      requestScope: { endpointKind: 'get_game_more', lid: '7001', ecid: '8001' },
      stateStore,
      auditStore,
    })
    const persisted = fs.readFileSync(snapshotsPath, 'utf8').split(/\r?\n/).filter(Boolean)
    assert.equal(persisted[0], '{partial')
    const parsed = persisted.slice(1).map(JSON.parse)
    assert.equal(parsed.length, result.snapshots.length)
    assert.deepEqual(new Set(parsed.map((row) => row.auditId)), new Set(result.drainedAuditFacts.map((fact) => fact.factId)))
    assert.deepEqual(stateStore.listPendingAuditFacts(), [])
  } finally {
    auditStore.close()
    stateStore.close()
  }
})

function disabledRuntimeConfig() {
  return {
    leagueConfig: null,
    defaultLeagues: { enabled: false, leagues: [] },
    monitorSettings: { runningMode: 'stopped', handicap: { enabled: false }, live: { enabled: false } },
    telegramSettings: { oddsAlert: { enabled: false } },
    alertsConfig: { console: { enabled: false } },
  }
}

function directArgs(runtimeDir, dbPath) {
  return {
    runtimeDir,
    appDbPath: dbPath,
    maxSeconds: 0.01,
    domPollSeconds: 1,
    configReloadSeconds: 0,
    maxGameMore: 2,
    bettingCandidatesPath: '',
  }
}

test('finite direct watcher wiring shares poll scope, chains rotated detail sessions, writes v2 paths, and closes state', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-wiring-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const stateStore = openMonitorStateStore({ dbPath })
  let closeCalls = 0
  const originalClose = stateStore.close.bind(stateStore)
  stateStore.close = () => { closeCalls += 1; originalClose() }
  const auditStore = new JsonlV2AuditStore({
    snapshotsPath: path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl'),
    changesPath: path.join(runtimeDir, 'crown-odds-changes-v2.jsonl'),
  })
  const detailSessions = []
  let sessionNumber = 0
  const manager = {
    async ensureLogin() { return { ok: true, status: '已登录' } },
    async fetchFootballToday() {
      return {
        text: listXml,
        requestScope: { endpointKind: 'get_game_list', showtype: 'today', rtype: 'r', filter: 'WIRE-LIST', gtype: 'ft', ltype: '3', date: '' },
        session: { cookies: { SESSION: 'list-session' } },
      }
    },
    async fetchFootballGameMore({ session, target }) {
      detailSessions.push(session.cookies.SESSION)
      sessionNumber += 1
      return {
        text: detailXml(target.eventKey.endsWith('1001') ? '1001' : '2001'),
        requestScope: { endpointKind: 'get_game_more', lid: target.lid, ecid: target.ecid, filter: `WIRE-DETAIL-${sessionNumber}` },
        session: { cookies: { SESSION: `detail-session-${sessionNumber}` } },
      }
    },
  }
  const account = { id: 'mon_primary', username: 'u', password: 'p', loginUrl: 'https://fixture.invalid', consecutiveFailures: 0 }
  const updates = []
  const stats = createWatcherStats()

  await runDirectApiWatch(directArgs(runtimeDir, dbPath), {
    stats,
    configState: { current: disabledRuntimeConfig(), args: directArgs(runtimeDir, dbPath) },
    logger: { log() {}, error() {} },
    monitorAccount: account,
  }, {
    apiLoginManager: manager,
    stateStore,
    auditStore,
    createPollId: () => 'shared-wiring-poll',
    loadMonitorAccount: () => account,
    loadTrackedMatches: () => [],
    loadBettingRule: () => null,
    updateMonitorAccount: (_args, _account, payload) => updates.push(payload),
    updateLoginResult() {},
  })

  assert.deepEqual(detailSessions, ['list-session', 'detail-session-1'])
  assert.equal(closeCalls, 1)
  assert.equal(stateStore.closed, true)
  assert.ok(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')))
  assert.ok(fs.existsSync(path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')))
  assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots.jsonl')), false)
  const auditRows = [...lines(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')), ...lines(path.join(runtimeDir, 'crown-odds-changes-v2.jsonl'))]
  assert.equal(auditRows.every((row) => row.pollId === 'shared-wiring-poll'), true)
  assert.equal(auditRows.some((row) => row.scopeKey.includes('WIRE-LIST')), true)
  assert.equal(auditRows.some((row) => row.scopeKey.includes('WIRE-DETAIL-1')), true)
  assert.equal(updates.at(-1).consecutiveFailures, 0)
})

test('direct poll marks incomplete authoritative XML as data-quality failure without advancing parsed odds health', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-invalid-health-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
  const account = { id: 'mon_primary', loginUrl: 'https://fixture.invalid', consecutiveFailures: 2, lastOddsParsedAt: 'old-odds-at' }
  const updates = []
  const stats = createWatcherStats()
  let detailCalls = 0
  try {
    const result = await runDirectApiPollOnce(directArgs(runtimeDir, dbPath), {
      stats,
      configState: { current: disabledRuntimeConfig() },
      logger: { log() {}, error() {} },
      monitorAccount: account,
      apiLoginManager: {
        async fetchFootballToday() {
          return {
            text: '<serverresponse><game><GID>1001</GID>',
            requestScope: { endpointKind: 'get_game_list', showtype: 'today', rtype: 'r', filter: 'MIX' },
            session: {},
          }
        },
        async fetchFootballGameMore() { detailCalls += 1 },
      },
      stateStore,
      auditStore,
      createPollId: () => 'invalid-poll',
      loadMonitorAccount: () => account,
      loadTrackedMatches: () => [],
      loadBettingRule: () => null,
      updateMonitorAccount: (_args, _account, payload) => updates.push(payload),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'data_quality')
    assert.equal(detailCalls, 0)
    assert.equal(stats.parseErrors, 1)
    assert.equal(updates.at(-1).currentMonitorStatus, '赔率数据异常')
    assert.equal(updates.at(-1).loginStatus, '已登录')
    assert.equal(updates.at(-1).consecutiveFailures, 3)
    assert.equal(Object.hasOwn(updates.at(-1), 'lastOddsParsedAt'), false)
  } finally {
    stateStore.close()
  }
})

test('direct poll counts login-expired response or thrown session failure once and records failed health', async () => {
  for (const [name, fetchFootballToday] of [
    ['response', async () => ({ text: '<html><body>login_index</body></html>', requestScope: {}, session: {} })],
    ['throw', async () => { const error = new Error('expired'); error.code = 'failed_login'; throw error }],
  ]) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `crown-v2-login-${name}-`))
    const dbPath = path.join(runtimeDir, 'crown.sqlite')
    const stateStore = openMonitorStateStore({ dbPath })
    const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
    const account = { id: 'mon_primary', loginUrl: 'https://fixture.invalid', consecutiveFailures: 0 }
    const updates = []
    try {
      const result = await runDirectApiPollOnce(directArgs(runtimeDir, dbPath), {
        stats: createWatcherStats(),
        configState: { current: disabledRuntimeConfig() },
        logger: { log() {}, error() {} },
        monitorAccount: account,
        apiLoginManager: { fetchFootballToday },
        stateStore,
        auditStore,
        createPollId: () => `login-${name}`,
        loadMonitorAccount: () => account,
        loadTrackedMatches: () => [],
        loadBettingRule: () => null,
        updateMonitorAccount: (_args, _account, payload) => updates.push(payload),
      })
      assert.equal(result.ok, false, name)
      assert.equal(result.stats.loginExpiredResponses, 1, name)
      assert.equal(updates.at(-1).currentMonitorStatus, '登录失效', name)
      assert.equal(updates.at(-1).loginStatus, '登录失效', name)
      assert.equal(updates.at(-1).consecutiveFailures, 1, name)
    } finally {
      stateStore.close()
    }
  }
})

test('direct poll treats a login-expired detail response as one session failure', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-detail-login-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
  const account = { id: 'mon_primary', loginUrl: 'https://fixture.invalid', consecutiveFailures: 0 }
  const updates = []
  const stats = createWatcherStats()
  try {
    const result = await runDirectApiPollOnce(directArgs(runtimeDir, dbPath), {
      stats,
      configState: { current: disabledRuntimeConfig() },
      logger: { log() {}, error() {} },
      monitorAccount: account,
      apiLoginManager: {
        async fetchFootballToday() {
          return {
            text: listXml,
            requestScope: { endpointKind: 'get_game_list', showtype: 'today', rtype: 'r', filter: 'MIX' },
            session: {},
          }
        },
        async fetchFootballGameMore() {
          return { text: '<html><body>login_index</body></html>', requestScope: {}, session: {} }
        },
      },
      stateStore,
      auditStore,
      createPollId: () => 'detail-login',
      loadMonitorAccount: () => account,
      loadTrackedMatches: () => [],
      loadBettingRule: () => null,
      updateMonitorAccount: (_args, _account, payload) => updates.push(payload),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'login_expired')
    assert.equal(stats.loginExpiredResponses, 1)
    assert.equal(updates.at(-1).currentMonitorStatus, '登录失效')
    assert.equal(updates.at(-1).consecutiveFailures, 1)
  } finally {
    stateStore.close()
  }
})

test('direct poll keeps malformed details degraded instead of overwriting health as normal', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-detail-degraded-'))
  const dbPath = path.join(runtimeDir, 'crown.sqlite')
  const stateStore = openMonitorStateStore({ dbPath })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
  const account = { id: 'mon_primary', loginUrl: 'https://fixture.invalid', consecutiveFailures: 2, lastOddsParsedAt: 'old' }
  const updates = []
  const stats = createWatcherStats()
  try {
    const result = await runDirectApiPollOnce(directArgs(runtimeDir, dbPath), {
      stats,
      configState: { current: disabledRuntimeConfig() },
      logger: { log() {}, error() {} },
      monitorAccount: account,
      apiLoginManager: {
        async fetchFootballToday() {
          return {
            text: listXml,
            requestScope: { endpointKind: 'get_game_list', showtype: 'today', rtype: 'r', filter: 'MIX' },
            session: {},
          }
        },
        async fetchFootballGameMore() {
          return { text: '<serverresponse><game><GID>1001</GID>', requestScope: { endpointKind: 'get_game_more' }, session: {} }
        },
      },
      stateStore,
      auditStore,
      createPollId: () => 'detail-degraded',
      loadMonitorAccount: () => account,
      loadTrackedMatches: () => [],
      loadBettingRule: () => null,
      updateMonitorAccount: (_args, _account, payload) => updates.push(payload),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'detail_data_quality')
    assert.equal(stats.parseErrors, 2)
    assert.equal(stats.errors, 2)
    assert.equal(updates.at(-1).currentMonitorStatus, '赔率数据异常')
    assert.equal(updates.at(-1).loginStatus, '已登录')
    assert.equal(updates.at(-1).consecutiveFailures, 3)
  } finally {
    stateStore.close()
    auditStore.close?.()
  }
})

test('direct watcher closes state when audit construction fails and closes audit before state otherwise', async () => {
  const args = directArgs(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-resource-')), ':memory:')
  const runtime = {
    stats: createWatcherStats(),
    configState: { current: disabledRuntimeConfig(), args },
    logger: { log() {}, error() {} },
    monitorAccount: { id: 'mon_primary', username: 'u', password: 'p', loginUrl: 'https://fixture.invalid' },
  }
  const closed = []
  await assert.rejects(runDirectApiWatch(args, runtime, {
    createStateStore: () => ({ close() { closed.push('state') } }),
    createAuditStore: () => { throw new Error('audit construction failed') },
  }), /audit construction failed/)
  assert.deepEqual(closed, ['state'])

  closed.length = 0
  await runDirectApiWatch({ ...args, loginTest: true }, runtime, {
    createStateStore: () => ({ close() { closed.push('state') } }),
    createAuditStore: () => ({ close() { closed.push('audit') } }),
    apiLoginManager: { async ensureLogin() { return { ok: true } } },
    updateLoginResult() {},
  })
  assert.deepEqual(closed, ['audit', 'state'])

  closed.length = 0
  let starts = 0
  await runDirectApiWatch({ ...args, loginTest: true }, runtime, {
    createStateStore: () => ({ close() { closed.push('state') } }),
    createAuditStore: () => ({ close() { closed.push('audit') } }),
    dispatcher: { start() { starts += 1 }, async stop() { closed.push('dispatcher') } },
    apiLoginManager: { async ensureLogin() { return { ok: true } } },
    updateLoginResult() {},
  })
  assert.equal(starts, 0)
  assert.deepEqual(closed, ['audit', 'state'])

  for (const [name, ensureLogin, rejects] of [
    ['not-ok', async () => ({ ok: false }), false],
    ['throws', async () => { throw new Error('login failed') }, true],
  ]) {
    closed.length = 0
    starts = 0
    const work = runDirectApiWatch({ ...args, loginTest: false }, runtime, {
      createStateStore: () => ({ close() { closed.push('state') } }),
      createAuditStore: () => ({ close() { closed.push('audit') } }),
      dispatcher: { start() { starts += 1 }, async stop() { closed.push('dispatcher') } },
      apiLoginManager: { ensureLogin },
      updateLoginResult() {},
    })
    if (rejects) await assert.rejects(work, /login failed/, name)
    else await work
    assert.equal(starts, 0, name)
    assert.deepEqual(closed, ['audit', 'state'], name)
  }

  closed.length = 0
  starts = 0
  await runDirectApiWatch({ ...args, loginTest: false, maxSeconds: 0.001 }, runtime, {
    createStateStore: () => ({ close() { closed.push('state') } }),
    createAuditStore: () => ({ close() { closed.push('audit') } }),
    dispatcher: { start() { starts += 1 }, async stop() { closed.push('dispatcher') } },
    apiLoginManager: {
      async ensureLogin() { return { ok: true } },
      async fetchFootballToday() { throw new Error('poll unavailable') },
    },
    loadMonitorAccount: () => runtime.monitorAccount,
    updateMonitorAccount() {},
    updateLoginResult() {},
  })
  assert.equal(starts, 1)
  assert.deepEqual(closed, ['dispatcher', 'audit', 'state'])
})

test('direct dispatcher sender reads the latest reloaded Telegram config at delivery time', async () => {
  const seen = []
  const configState = { current: { telegramSettings: { oddsAlert: { enabled: true, chatId: 'old' } } } }
  const dispatcher = createDirectV2AlertDispatcher({
    stateStore: { claimPendingDeliveries() { return [] }, completeDelivery() {} },
    configState,
    telegramSender: async (_signal, config) => { seen.push(config.chatId); return { sent: true } },
  })
  configState.current = { telegramSettings: { oddsAlert: { enabled: true, chatId: 'new' } } }
  await dispatcher.senders.telegram({ signalId: 'test' })
  assert.deepEqual(seen, ['new'])
})

const acceptanceSequenceDir = path.resolve('data/fixtures/crown/monitor-v2-sequence')

function acceptanceMonitorSettings(mode = 'prematch') {
  const canonicalMode = mode === 'handicap' ? 'prematch' : mode
  return {
    version: 2,
    prematch: {
      enabled: canonicalMode === 'prematch',
      minOdds: null,
      maxOdds: null,
      waterMoveThreshold: 0.01,
      waterMoveDirection: 'both',
      cooldownSeconds: 60,
      startMinutesBeforeKickoff: 2880,
      stopMinutesBeforeKickoff: 0,
      remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
    },
    live: {
      enabled: canonicalMode === 'live',
      minOdds: null,
      maxOdds: null,
      waterMoveThreshold: 0.01,
      waterMoveDirection: 'both',
      cooldownSeconds: 60,
      liveMinuteFrom: 0,
      liveMinuteTo: 120,
      includeFirstHalf: true,
      includeSecondHalf: true,
      includeHalfTime: false,
      remark: '', lastAlertAt: null, stoppedReason: '', bettingRuleId: null,
    },
  }
}

function readAcceptanceSequence() {
  const manifestPath = path.join(acceptanceSequenceDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return {
    manifest,
    steps: manifest.steps.map((step) => ({
      ...step,
      body: fs.readFileSync(path.join(acceptanceSequenceDir, step.file), 'utf8'),
    })),
  }
}

function sortedIds(stateStore, table, idColumn) {
  return stateStore.db.prepare(`SELECT ${idColumn} AS id FROM ${table} ORDER BY ${idColumn}`).all().map((row) => row.id)
}

async function applyAcceptanceSequence({ stateStore, auditStore, steps }) {
  for (const step of steps) {
    const result = await processDirectXmlV2({
      body: step.body,
      endpointKind: step.endpointKind,
      capturedAt: step.capturedAt,
      pollId: step.pollId,
      requestScope: step.requestScope,
      stateStore,
      auditStore,
    })
    const signalResult = persistDirectV2Signals({
      changes: result.changes,
      stateStore,
      monitorSettings: acceptanceMonitorSettings(),
    })
    persistDirectV2Candidates({
      signals: signalResult.inserted,
      stateStore,
      bettingRules: [],
      now: step.capturedAt,
    })
  }
}

function deterministicIds(stateStore, changesPath) {
  const changeIds = fs.readFileSync(changesPath, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).changeId)
    .sort()
  return {
    changeIds,
    signalIds: sortedIds(stateStore, 'monitor_signals', 'signal_id'),
    candidateIds: sortedIds(stateStore, 'monitor_candidates', 'candidate_id'),
  }
}

test('disk sequence is sanitized, ordered list-to-details, and deterministic across fresh databases and replay', async () => {
  const { manifest, steps } = readAcceptanceSequence()
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(steps.map((step) => step.sessionOrder), [0, 1, 2, 3])
  assert.deepEqual(steps.map((step) => step.endpointKind), [
    'get_game_list',
    'get_game_more',
    'get_game_more',
    'get_game_more',
  ])
  assert.equal(new Set(steps.map((step) => step.pollId)).size, 1)
  assert.deepEqual(steps.filter((step) => step.endpointKind === 'get_game_more').map((step) => step.requestScope.gid), [
    '1001',
    '2001',
    '1001',
  ])
  const fixtureText = fs.readdirSync(acceptanceSequenceDir)
    .map((file) => fs.readFileSync(path.join(acceptanceSequenceDir, file), 'utf8'))
    .concat(steps.map((step) => step.body))
    .join('\n')
  assert.doesNotMatch(fixtureText, /(?:cookie|password|token|auth|bearer)/i)

  const runs = []
  for (let index = 0; index < 2; index += 1) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `crown-v2-deterministic-${index}-`))
    const stateStore = openMonitorStateStore({ dbPath: path.join(runtimeDir, 'state.sqlite') })
    const changesPath = path.join(runtimeDir, 'changes.jsonl')
    const auditStore = new JsonlV2AuditStore({
      snapshotsPath: path.join(runtimeDir, 'snapshots.jsonl'),
      changesPath,
    })
    try {
      await applyAcceptanceSequence({ stateStore, auditStore, steps })
      const first = deterministicIds(stateStore, changesPath)
      assert.equal(first.changeIds.length, 3)
      assert.equal(first.changeIds.length, new Set(first.changeIds).size)
      assert.equal(first.signalIds.length, 1)
      assert.equal(first.signalIds.length, new Set(first.signalIds).size)
      assert.equal(first.candidateIds.length, 1)
      assert.equal(first.candidateIds.length, new Set(first.candidateIds).size)
      await applyAcceptanceSequence({ stateStore, auditStore, steps })
      assert.deepEqual(deterministicIds(stateStore, changesPath), first)
      runs.push(first)
    } finally {
      auditStore.close()
      stateStore.close()
    }
  }
  assert.deepEqual(runs[1], runs[0])
})

function persistedCoreState(stateStore) {
  return {
    scopes: stateStore.db.prepare('SELECT * FROM monitor_scope_state ORDER BY scope_key').all(),
    events: stateStore.db.prepare('SELECT * FROM monitor_event_state ORDER BY event_key').all(),
    selections: stateStore.db.prepare('SELECT * FROM monitor_selection_state ORDER BY selection_identity').all(),
  }
}

test('incomplete list, login-expired payload, and stale detail do not pollute seeded active state or baselines', async () => {
  const { steps } = readAcceptanceSequence()
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-fault-matrix-'))
  const stateStore = openMonitorStateStore({ dbPath: path.join(runtimeDir, 'state.sqlite') })
  const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
  try {
    for (const step of steps.slice(0, 3)) {
      await processDirectXmlV2({ ...step, stateStore, auditStore })
    }
    const seeded = persistedCoreState(stateStore)
    assert.equal(seeded.scopes.length, 1)
    assert.equal(seeded.events.every((row) => row.active === 1), true)
    assert.ok(seeded.selections.length > 0)

    const faults = [
      { body: '<serverresponse><game><GID>1001</GID>', endpointKind: 'get_game_list', capturedAt: '2026-07-08T12:01:00.000Z', pollId: 'fault-incomplete', requestScope: steps[0].requestScope },
      { body: '<html><body>login_index</body></html>', endpointKind: 'get_game_list', capturedAt: '2026-07-08T12:01:01.000Z', pollId: 'fault-login', requestScope: steps[0].requestScope },
      { ...steps[3], capturedAt: '2026-07-08T11:59:59.000Z', pollId: 'fault-stale' },
    ]
    for (const fault of faults) {
      await processDirectXmlV2({ ...fault, stateStore, auditStore })
      assert.deepEqual(persistedCoreState(stateStore), seeded)
    }
  } finally {
    auditStore.close()
    stateStore.close()
  }
})

test('missing kickoff time or live minute still persists factual baselines but produces no Signal', async () => {
  const { steps } = readAcceptanceSequence()
  const cases = [
    {
      name: 'prematch-start-time',
      mode: 'handicap',
      step: steps[1],
      strip: (body) => body.replace(/\s*<(?:DATETIME|GAME_DATE_TIME)>[\s\S]*?<\/(?:DATETIME|GAME_DATE_TIME)>/gi, ''),
      assertMissing: (change) => assert.equal(change.event.startTimeUtc, null),
    },
    {
      name: 'live-minute',
      mode: 'live',
      step: steps[2],
      strip: (body) => body.replace(/<RETIMESET>[\s\S]*?<\/RETIMESET>/i, '<RETIMESET>2H^08:00</RETIMESET>'),
      assertMissing: (change) => {
        assert.equal(change.event.livePhase, 'second_half')
        assert.equal(change.event.liveMinute, null)
      },
    },
  ]
  for (const entry of cases) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), `crown-v2-missing-${entry.name}-`))
    const stateStore = openMonitorStateStore({ dbPath: path.join(runtimeDir, 'state.sqlite') })
    const auditStore = new JsonlV2AuditStore({ snapshotsPath: path.join(runtimeDir, 's.jsonl'), changesPath: path.join(runtimeDir, 'c.jsonl') })
    const baseBody = entry.strip(entry.step.body)
    const changedBody = baseBody.replace(/<IOR_(?:R|RE)H>[\s\S]*?<\/IOR_(?:R|RE)H>/i, (tag) => tag.replace(/>[^<]+</, '>0.810<'))
    try {
      await processDirectXmlV2({ ...entry.step, body: baseBody, pollId: `missing-${entry.name}`, capturedAt: '2026-07-08T12:00:00.000Z', stateStore, auditStore })
      const changed = await processDirectXmlV2({ ...entry.step, body: changedBody, pollId: `missing-${entry.name}`, capturedAt: '2026-07-08T12:00:01.000Z', stateStore, auditStore })
      const oddsChanges = changed.changes.filter((change) => change.type === 'odds-change')
      assert.equal(oddsChanges.length, 1, entry.name)
      entry.assertMissing(oddsChanges[0])
      const signals = persistDirectV2Signals({
        changes: changed.changes,
        stateStore,
        monitorSettings: acceptanceMonitorSettings(entry.mode),
      })
      assert.equal(signals.inserted.length, 0, entry.name)
      assert.equal(stateStore.countSignals(), 0, entry.name)
      assert.ok(stateStore.getEvent(oddsChanges[0].event.eventKey), entry.name)
      assert.ok(stateStore.getSelection(oddsChanges[0].selectionIdentity), entry.name)
    } finally {
      auditStore.close()
      stateStore.close()
    }
  }
})
