import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AlertDispatcher } from '../src/crown/monitor/alert-dispatcher.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'
import {
  directV2CandidatesPath,
  parseArgs as parseWatchArgs,
  persistDirectV2Candidates,
} from '../scripts/crown-watch.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { JsonlCandidateStore, drainCandidateOutbox } from '../src/crown/storage/jsonl-candidate-store.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function candidate(overrides = {}) {
  const signalId = 'a'.repeat(64)
  const bettingRuleId = 'brule_1'
  return {
    schemaVersion: 2,
    candidateId: sha256(`${signalId}|${bettingRuleId}`),
    signalId,
    source: 'monitor-signal',
    createdAt: '2026-07-09T06:01:00.000Z',
    observedAt: '2026-07-09T06:00:00.000Z',
    expiresAt: '2026-07-09T06:05:00.000Z',
    strategy: { id: 'strategy-1', version: 1 },
    bettingRuleId,
    status: 'eligible',
    action: 'follow',
    reason: 'rule-follow',
    canonical: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      sourceSelectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      targetSelectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
    },
    trigger: { type: 'odds-change', direction: 'down', delta: 0.1, threshold: 0.03 },
    evidence: { changeId: 'b'.repeat(64), oldOdds: 0.9, nextOdds: 0.8 },
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
    target: {
      capturedAt: '2026-07-09T06:00:30.000Z',
      event: { eventKey: 'crown|football|gid=8878931', ids: { gid: '8878931' } },
      market: { marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE', period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE' },
      selection: { selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home', side: 'home', odds: 0.8, suspended: false },
    },
    ...overrides,
  }
}

function signal({ signalId = 'a'.repeat(64), bettingRuleId = 'brule_1' } = {}) {
  return {
    schemaVersion: 2,
    signalId,
    strategyId: 'strategy-1',
    strategyVersion: 1,
    observedAt: '2026-07-09T06:00:00.000Z',
    expiresAt: '2026-07-09T06:05:00.000Z',
    trigger: { type: 'odds-change', direction: 'down', delta: 0.1, threshold: 0.03 },
    target: {
      eventIdentity: 'crown|football|gid=8878931',
      marketIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE',
      selectionIdentity: 'crown|football|gid=8878931|full_time|asian_handicap|RATIO_RE|home',
      side: 'home',
    },
    evidence: { changeId: 'b'.repeat(64), oldOdds: 0.9, nextOdds: 0.8 },
    bettingRuleId,
    dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
    status: 'pending',
  }
}

function selectionSnapshot() {
  return candidate().target
}

function tempPaths(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dbPath: path.join(dir, 'crown.sqlite'),
    candidatesPath: path.join(dir, 'betting-candidates.jsonl'),
  }
}

function rows(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function dispatchSignal() {
  const eventIdentity = 'crown|football|gid=8878931'
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_RE`
  const selectionIdentity = `${marketIdentity}|home`
  const observedAt = '2026-07-09T06:00:00.000Z'
  const changeId = 'b'.repeat(64)
  return {
    ...createSignal({
      rule: {
        id: 'strategy-1',
        type: 'odds_delta',
        version: 1,
        enabled: true,
        conditions: { minDelta: 0.03 },
        cooldownSeconds: 300,
        bettingRuleId: 'brule_1',
      },
      change: {
        schemaVersion: 2,
        changeId,
        type: 'odds-change',
        observedAt,
        eventIdentity,
        marketIdentity,
        selectionIdentity,
      },
      decision: {
        matched: true,
        strategyId: 'strategy-1',
        strategyVersion: 1,
        trigger: { type: 'odds-change', direction: 'down', delta: 0.1, threshold: 0.03, observedAt },
        target: { eventIdentity, marketIdentity, selectionIdentity, side: 'home' },
        evidence: {
          changeId,
          oldOdds: 0.9,
          nextOdds: 0.8,
          homeTeam: 'Home',
          awayTeam: 'Away',
          handicapRaw: '+0/0.5',
          oldOddsRaw: '0.900',
          nextOddsRaw: '0.800',
          mode: 'prematch',
          league: 'Test League',
          marketType: 'asian_handicap',
          period: 'full_time',
          handicap: 0.25,
          minutesBeforeKickoff: 120,
          livePhase: null,
          liveMinute: null,
          source: { endpointKind: 'get_game_more', confidence: 'high' },
        },
        bettingRuleId: 'brule_1',
        cooldownSeconds: 300,
        dataQuality: { complete: true, identityConfidence: 'high', missing: [], warnings: [] },
      },
    }),
    channels: ['telegram'],
  }
}

test('direct-v2 defaults to an independent candidate JSONL while explicit CLI override is honored', () => {
  const defaults = parseWatchArgs(['--runtime-dir', 'runtime-fixture'])
  assert.equal(defaults.bettingCandidatesPath, path.join('runtime-fixture', 'betting-candidates.jsonl'))
  assert.equal(directV2CandidatesPath(defaults), path.join('runtime-fixture', 'betting-candidates-v2.jsonl'))
  const explicit = parseWatchArgs(['--runtime-dir', 'runtime-fixture', '--betting-candidates', 'custom.jsonl'])
  assert.equal(directV2CandidatesPath(explicit), 'custom.jsonl')
})

test('candidate index inserts once and exposes a bounded pending export queue', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const item = candidate()
  assert.deepEqual(store.insertCandidate(item), { inserted: true, candidateId: item.candidateId })
  assert.deepEqual(store.insertCandidate({ ...item, canonical: { ...item.canonical } }), { inserted: false, candidateId: item.candidateId, reason: 'duplicate' })
  assert.equal(store.countCandidates(), 1)
  assert.deepEqual(store.getCandidate(item.candidateId), item)
  assert.deepEqual(store.listPendingCandidateExports({ limit: 1 }), [item])
  assert.equal(store.markCandidateExportsDelivered([item.candidateId], { exportedAt: '2026-07-09T06:02:00.000Z' }), 1)
  assert.deepEqual(store.listPendingCandidateExports(), [])
  store.close()
})

test('candidate persistence rejects collisions and sensitive or raw transport fields', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const item = candidate()
  store.insertCandidate(item)
  assert.throws(() => store.insertCandidate({ ...item, reason: 'forged' }), /collision/)
  assert.throws(() => store.insertCandidate(candidate({ candidateId: sha256(`${'c'.repeat(64)}|brule_1`), signalId: 'c'.repeat(64), headers: { authorization: 'Bearer secret' } })), /sensitive|transport/i)
  assert.throws(() => store.insertCandidate(candidate({ candidateId: sha256(`${'d'.repeat(64)}|brule_1`), signalId: 'd'.repeat(64), rawProviderResponse: '<xml />' })), /raw|transport/i)
  assert.equal(store.countCandidates(), 1)
  store.close()
})

test('append failure leaves DB pending and restart retries exactly once', () => {
  const paths = tempPaths('crown-candidate-append-failure-')
  const stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const item = candidate()
  stateStore.insertCandidate(item)
  const failed = new JsonlCandidateStore({
    candidatesPath: paths.candidatesPath,
    appendFile: () => { throw new Error('injected candidate append failure') },
  })
  assert.throws(() => drainCandidateOutbox({ stateStore, candidateStore: failed }), /injected candidate append failure/)
  assert.equal(stateStore.listPendingCandidateExports().length, 1)
  failed.close()
  const restarted = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore: restarted }).exported, 1)
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore: restarted }).exported, 0)
  assert.equal(rows(paths.candidatesPath).length, 1)
  restarted.close()
  stateStore.close()
})

test('append succeeds but DB acknowledgement failure does not duplicate after restart', () => {
  const paths = tempPaths('crown-candidate-ack-failure-')
  let stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const item = candidate()
  stateStore.insertCandidate(item)
  const candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  const mark = stateStore.markCandidateExportsDelivered.bind(stateStore)
  stateStore.markCandidateExportsDelivered = () => { throw new Error('injected candidate ack failure') }
  assert.throws(() => drainCandidateOutbox({ stateStore, candidateStore }), /injected candidate ack failure/)
  assert.equal(rows(paths.candidatesPath).length, 1)
  stateStore.markCandidateExportsDelivered = mark
  stateStore.close()
  candidateStore.close()

  stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const restarted = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore: restarted }).exported, 1)
  assert.equal(rows(paths.candidatesPath).length, 1)
  assert.deepEqual(stateStore.listPendingCandidateExports(), [])
  restarted.close()
  stateStore.close()
})

test('Telegram timeout recovery keeps one Signal, one candidate row, and one JSONL line across restart', async () => {
  const paths = tempPaths('crown-candidate-delivery-restart-')
  const input = dispatchSignal()
  const item = candidate({
    signalId: input.signalId,
    candidateId: sha256(`${input.signalId}|brule_1`),
  })
  let stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  let candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  assert.deepEqual(stateStore.insertSignal(input), { inserted: true, reason: null, signalId: input.signalId })
  assert.deepEqual(stateStore.insertCandidate(item), { inserted: true, candidateId: item.candidateId })
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore }).exported, 1)
  const timedOut = new AlertDispatcher({
    store: stateStore,
    sendTimeoutMs: 15,
    senders: { telegram: () => new Promise(() => {}) },
  })
  await timedOut.tick(input.observedAt)
  assert.equal(stateStore.db.prepare('SELECT status FROM monitor_deliveries WHERE signal_id = ?').get(input.signalId).status, 'retry')
  await timedOut.stop()
  candidateStore.close()
  stateStore.close()

  stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  let sends = 0
  const restarted = new AlertDispatcher({
    store: stateStore,
    senders: { telegram: async () => { sends += 1; return { sent: true } } },
  })
  await restarted.tick('2026-07-09T06:00:05.000Z')
  assert.equal(sends, 1)
  assert.deepEqual({ ...stateStore.db.prepare(`
    SELECT status, attempts FROM monitor_deliveries WHERE signal_id = ? AND channel = 'telegram'
  `).get(input.signalId) }, { status: 'sent', attempts: 2 })
  assert.equal(stateStore.countSignals(), 1)
  assert.equal(stateStore.countCandidates(), 1)
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore }).exported, 0)
  assert.equal(rows(paths.candidatesPath).filter((row) => row.signalId === input.signalId).length, 1)
  candidateStore.close()
  stateStore.close()
})

test('state selection lookup is canonical and never crosses lineKey', () => {
  const store = openMonitorStateStore({ dbPath: ':memory:' })
  const snapshot = selectionSnapshot()
  store.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
  `).run(snapshot.selection.selectionIdentity, snapshot.event.eventKey, snapshot.capturedAt, JSON.stringify(snapshot))
  assert.deepEqual(store.findLatestSelection({
    provider: 'crown', eventKey: snapshot.event.eventKey, period: 'full_time', marketType: 'asian_handicap', lineKey: 'RATIO_RE', side: 'home',
  }), snapshot)
  assert.equal(store.findLatestSelection({
    provider: 'crown', eventKey: snapshot.event.eventKey, period: 'full_time', marketType: 'asian_handicap', lineKey: 'OTHER', side: 'home',
  }), null)
  store.close()
})

test('watcher binds candidates by signal bettingRuleId, persists skips, and replays one JSONL row', () => {
  const paths = tempPaths('crown-candidate-watcher-')
  const stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const snapshot = selectionSnapshot()
  stateStore.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
  `).run(snapshot.selection.selectionIdentity, snapshot.event.eventKey, snapshot.capturedAt, JSON.stringify(snapshot))
  const candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  const bettingRules = [
    { id: 'first-enabled', enabled: true, minOdds: 0.1, betDirectionMode: 'follow' },
    { id: 'brule_1', enabled: true, minOdds: 0.75, maxOdds: 1, betDirectionMode: 'follow' },
    { id: 'disabled', enabled: false, betDirectionMode: 'follow' },
  ]
  const signals = [
    signal(),
    signal({ signalId: 'c'.repeat(64), bettingRuleId: null }),
    signal({ signalId: 'd'.repeat(64), bettingRuleId: 'not-found' }),
    signal({ signalId: 'e'.repeat(64), bettingRuleId: 'disabled' }),
  ]
  const first = persistDirectV2Candidates({
    signals, stateStore, bettingRules, candidateStore, now: '2026-07-09T06:01:00.000Z',
  })
  const replay = persistDirectV2Candidates({
    signals, stateStore, bettingRules, candidateStore, now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(first.inserted.length, 4)
  assert.equal(first.inserted[0].bettingRuleId, 'brule_1')
  assert.equal(first.inserted[0].status, 'eligible')
  assert.deepEqual(first.inserted.slice(1).map((item) => item.skipReason), ['betting-rule-unbound', 'betting-rule-unbound', 'betting-rule-unbound'])
  assert.equal(replay.inserted.length, 0)
  assert.equal(replay.duplicates, 4)
  assert.equal(stateStore.countCandidates(), 4)
  assert.equal(rows(paths.candidatesPath).length, 4)

  const stranded = signal({ signalId: 'f'.repeat(64) })
  stateStore.db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stranded.signalId,
    `strategy-1|${stranded.target.selectionIdentity}`,
    stranded.strategyId,
    stranded.strategyVersion,
    stranded.status,
    stranded.observedAt,
    stranded.expiresAt,
    JSON.stringify(stranded),
  )
  assert.deepEqual(stateStore.listSignalsWithoutCandidates({ limit: 10 }), [stranded])
  const recovered = persistDirectV2Candidates({
    signals: [], stateStore, bettingRules, candidateStore, now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(recovered.inserted.length, 1)
  assert.equal(recovered.inserted[0].signalId, stranded.signalId)
  assert.equal(rows(paths.candidatesPath).length, 5)
  candidateStore.close()
  stateStore.close()
})

test('watcher replay short-circuits persisted candidates before mutable selection lookup across restart', () => {
  const paths = tempPaths('crown-candidate-replay-short-circuit-')
  let stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const snapshot = selectionSnapshot()
  stateStore.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
  `).run(snapshot.selection.selectionIdentity, snapshot.event.eventKey, snapshot.capturedAt, JSON.stringify(snapshot))
  let candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  const bettingRules = [{ id: 'brule_1', enabled: true, minOdds: 0.75, maxOdds: 1, betDirectionMode: 'follow' }]
  const input = signal()
  const first = persistDirectV2Candidates({
    signals: [input], stateStore, bettingRules, candidateStore, now: '2026-07-09T06:01:00.000Z',
  })
  const original = structuredClone(first.inserted[0])
  candidateStore.close()
  stateStore.close()

  stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  stateStore.db.prepare('UPDATE monitor_selection_state SET captured_at = ?, snapshot_json = ? WHERE selection_identity = ?').run(
    '2026-07-09T06:03:00.000Z',
    JSON.stringify({ ...snapshot, capturedAt: '2026-07-09T06:03:00.000Z', selection: { ...snapshot.selection, odds: 0.99 } }),
    snapshot.selection.selectionIdentity,
  )
  stateStore.findLatestSelection = () => { throw new Error('mutable lookup must not run during replay') }
  candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath })
  const replay = persistDirectV2Candidates({
    signals: [input], stateStore, bettingRules, candidateStore, now: '2026-07-09T06:04:00.000Z',
  })
  assert.equal(replay.inserted.length, 0)
  assert.equal(replay.duplicates, 1)
  assert.deepEqual(replay.existing, [original])
  assert.deepEqual(stateStore.getCandidate(original.candidateId), original)
  assert.equal(rows(paths.candidatesPath).length, 1)
  candidateStore.close()
  stateStore.close()
})

test('canonical candidate recovery defers an empty snapshot and succeeds once the exact rule version returns', () => {
  const paths = tempPaths('crown-candidate-canonical-recovery-')
  const stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  const input = signal()
  stateStore.db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.signalId, `strategy-1|${input.target.selectionIdentity}`, input.strategyId, input.strategyVersion,
    input.status, input.observedAt, input.expiresAt, JSON.stringify(input))

  const empty = persistDirectV2Candidates({
    signals: [], stateStore, bettingRules: [], canonicalRuleSnapshot: true, now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(empty.inserted.length, 0)
  assert.deepEqual(empty.deferred.map((item) => item.reason), ['betting-rule-version-unavailable'])
  assert.equal(stateStore.countCandidates(), 0)
  assert.equal(stateStore.listSignalsWithoutCandidates({ limit: 10 }).length, 1)

  const home = selectionSnapshot()
  const away = structuredClone(home)
  away.selection.side = 'away'
  away.selection.selectionIdentity = away.selection.selectionIdentity.replace(/\|home$/, '|away')
  for (const snapshot of [home, away]) {
    stateStore.db.prepare(`
      INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
      VALUES (?, ?, ?, ?)
    `).run(snapshot.selection.selectionIdentity, snapshot.event.eventKey, snapshot.capturedAt, JSON.stringify(snapshot))
  }
  const restored = persistDirectV2Candidates({
    signals: [], stateStore,
    bettingRules: [{
      id: 'brule_1', version: 1, monitorEnabled: true, monitoredSide: 'home', marketType: 'asian_handicap',
      targetOddsMin: '0.75', targetOddsMax: '1.00', targetAmountMinor: 100,
    }],
    canonicalRuleSnapshot: true,
    now: '2026-07-09T06:01:00.000Z',
  })
  assert.equal(restored.inserted.length, 1)
  assert.equal(restored.inserted[0].status, 'eligible')
  assert.equal(stateStore.countCandidates(), 1)
  assert.equal(stateStore.listSignalsWithoutCandidates({ limit: 10 }).length, 0)
  stateStore.close()
})

test('candidate sidecar first recovery reads only a bounded aligned tail', () => {
  const paths = tempPaths('crown-candidate-bounded-tail-')
  const prefix = `${JSON.stringify({ legacy: true, pad: 'x'.repeat(180) })}\n`.repeat(1000)
  const item = candidate()
  fs.writeFileSync(paths.candidatesPath, `${prefix}${JSON.stringify(item)}\n`, 'utf8')
  const reads = []
  const candidateStore = new JsonlCandidateStore({
    candidatesPath: paths.candidatesPath,
    recoveryBytes: 8192,
    scanChunkBytes: 512,
    maxLineBytes: 2048,
    readSync(fd, buffer, offset, length, position) {
      const bytesRead = fs.readSync(fd, buffer, offset, length, position)
      reads.push({ length: bytesRead, position })
      return bytesRead
    },
  })
  assert.equal(candidateStore.appendCandidates([item]).appended, 0)
  const size = fs.statSync(paths.candidatesPath).size
  assert.equal(reads.length > 0, true)
  assert.equal(Math.min(...reads.map((read) => read.position)) > 0, true)
  assert.equal(Math.max(...reads.map((read) => read.position + read.length)) <= size, true)
  assert.equal(reads.reduce((total, read) => total + read.length, 0) <= 8192 + 512, true)
  candidateStore.close()
})

test('incomplete bounded recovery fails closed when a candidate is outside the tail index', () => {
  const paths = tempPaths('crown-candidate-incomplete-tail-')
  const item = candidate()
  const suffix = `${JSON.stringify({ legacy: true, pad: 'x'.repeat(180) })}\n`.repeat(1000)
  fs.writeFileSync(paths.candidatesPath, `${JSON.stringify(item)}\n${suffix}`, 'utf8')
  const before = fs.statSync(paths.candidatesPath).size
  const candidateStore = new JsonlCandidateStore({
    candidatesPath: paths.candidatesPath,
    recoveryBytes: 8192,
    maxLineBytes: 2048,
  })
  assert.throws(() => candidateStore.appendCandidates([item]), (error) => {
    assert.equal(error.code, 'CANDIDATE_INDEX_REBUILD_REQUIRED')
    assert.equal(error.message, 'candidate-index-rebuild-required')
    return true
  })
  assert.equal(fs.statSync(paths.candidatesPath).size, before)
  candidateStore.close()
})

test('lost sidecar recovers the recent unacknowledged row from bounded tail without duplication', () => {
  const paths = tempPaths('crown-candidate-lost-sidecar-')
  const item = candidate()
  const stateStore = openMonitorStateStore({ dbPath: paths.dbPath })
  stateStore.insertCandidate(item)
  let candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath, recoveryBytes: 8192, maxLineBytes: 2048 })
  const seedSignalId = '9'.repeat(64)
  const seed = candidate({ signalId: seedSignalId, candidateId: sha256(`${seedSignalId}|brule_1`) })
  candidateStore.appendCandidates([seed])
  fs.appendFileSync(
    paths.candidatesPath,
    `${JSON.stringify({ legacy: true, pad: 'x'.repeat(180) })}\n`.repeat(1000),
    'utf8',
  )
  const mark = stateStore.markCandidateExportsDelivered.bind(stateStore)
  stateStore.markCandidateExportsDelivered = () => { throw new Error('injected ack failure before sidecar loss') }
  assert.throws(() => drainCandidateOutbox({ stateStore, candidateStore }), /injected ack failure/)
  stateStore.markCandidateExportsDelivered = mark
  assert.equal(stateStore.listPendingCandidateExports().length, 1)
  const indexPath = candidateStore.indexPath
  candidateStore.close()
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${indexPath}${suffix}`, { force: true })
  candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath, recoveryBytes: 8192, maxLineBytes: 2048 })
  assert.equal(drainCandidateOutbox({ stateStore, candidateStore }).exported, 1)
  assert.equal(rows(paths.candidatesPath).filter((row) => row.candidateId === item.candidateId).length, 1)
  assert.deepEqual(stateStore.listPendingCandidateExports(), [])
  candidateStore.close()
  stateStore.close()
})

test('candidate sidecar resets safely after truncation and rejects oversized rows before append', () => {
  const paths = tempPaths('crown-candidate-truncate-')
  const item = candidate()
  const candidateStore = new JsonlCandidateStore({ candidatesPath: paths.candidatesPath, maxLineBytes: 2048 })
  assert.equal(candidateStore.appendCandidates([item]).appended, 1)
  fs.truncateSync(paths.candidatesPath, 0)
  assert.equal(candidateStore.appendCandidates([item]).appended, 1)
  assert.equal(rows(paths.candidatesPath).length, 1)
  const oversized = { ...candidate({ signalId: 'f'.repeat(64), candidateId: sha256(`${'f'.repeat(64)}|brule_1`) }), padding: 'x'.repeat(5000) }
  assert.throws(() => candidateStore.appendCandidates([oversized]), /line|bytes|large/i)
  assert.equal(rows(paths.candidatesPath).length, 1)
  const sharedIndexPath = candidateStore.indexPath
  candidateStore.close()

  const otherPath = path.join(path.dirname(paths.candidatesPath), 'other-candidates.jsonl')
  const otherStore = new JsonlCandidateStore({ candidatesPath: otherPath, indexPath: sharedIndexPath, maxLineBytes: 2048 })
  assert.equal(otherStore.appendCandidates([item]).appended, 1)
  assert.equal(rows(otherPath).length, 1)
  otherStore.close()
})

test('candidate export acknowledgement accepts a row concurrently acknowledged by another store', () => {
  const paths = tempPaths('crown-candidate-concurrent-ack-')
  const owner = openMonitorStateStore({ dbPath: paths.dbPath })
  const other = openMonitorStateStore({ dbPath: paths.dbPath })
  const item = candidate()
  owner.insertCandidate(item)
  const candidateStore = {
    appendCandidates(candidates) {
      assert.deepEqual(candidates, [item])
      assert.equal(other.markCandidateExportsDelivered([item.candidateId]), 1)
      return { appended: 1, candidates }
    },
  }
  assert.equal(drainCandidateOutbox({ stateStore: owner, candidateStore }).exported, 1)
  assert.deepEqual(owner.listPendingCandidateExports(), [])
  other.close()
  owner.close()
})
