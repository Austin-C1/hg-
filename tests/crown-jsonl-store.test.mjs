import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeMonitorSettings, startMonitorMode } from '../src/crown/monitor/monitor-settings.mjs'
import { JsonlOddsStore, stableSelectionKey } from '../src/crown/storage/jsonl-store.mjs'
import { JsonlV2AuditStore } from '../src/crown/storage/jsonl-v2-audit-store.mjs'

function record(oddsRaw, overrides = {}) {
  const event = {
    eventId: 'event-1',
    eventKey: 'crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1',
    league: 'Fixture League',
    homeTeam: 'Home FC',
    awayTeam: 'Away FC',
    ...overrides.event,
  }
  const market = {
    marketId: 'market-1',
    marketKey: 'market-1',
    marketType: 'asian_handicap',
    period: 'full_time',
    handicapRaw: '+0/0.5',
    handicap: 0.25,
    ...overrides.market,
  }
  const selection = {
    selectionId: 'selection-1',
    selectionKey: 'selection-1',
    side: 'home',
    oddsRaw,
    odds: Number.isFinite(Number(oddsRaw)) ? Number(oddsRaw) : null,
    suspended: false,
    ...overrides.selection,
  }
  return {
    provider: 'crown',
    mode: 'prematch',
    capturedAt: overrides.capturedAt || '2026-07-08T00:40:11.000+08:00',
    source: { endpointKey: 'DOM https://m321.mos077.com/', mapperVersion: 'crown-football-v1' },
    event,
    market,
    selection,
    warnings: ['inferred-dom-market'],
  }
}

test('stores snapshots and appends odds changes by stable selection key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  assert.equal(stableSelectionKey(record('0.94')), 'crown|crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1|market-1|selection-1')
  assert.deepEqual(store.ingest([record('0.94')]).changes.map((change) => change.type), ['event-added'])
  const second = store.ingest([record('0.95')])

  assert.equal(second.changes.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'snapshots.jsonl'), 'utf8').trim().split(/\r?\n/)[1]).selection.oddsRaw, '0.95')
  const changes = fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const change = changes.find((item) => item.type === 'odds-change')
  assert.equal(change.old.odds.raw, '0.94')
  assert.equal(change.next.odds.raw, '0.95')
  assert.equal(change.mode, 'prematch')
  assert.equal(change.confidence, 'low')
  assert.deepEqual(change.warnings, ['inferred-dom-market'])
  assert.equal(change.old.mode, 'prematch')
  assert.equal(change.next.source.endpointKey, 'DOM https://m321.mos077.com/')
  assert.equal(change.old.handicap.raw, '+0/0.5')
  assert.equal(change.next.market.marketType, 'asian_handicap')
  assert.equal(change.next.selection.selectionId, 'selection-1')
})

test('schema-v2 ingestion is a pure append sink and never decorates factual changes as candidates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const store = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  const snapshots = [{ schemaVersion: 2, batchId: 'batch-v2', selection: { odds: 0.94 } }]
  const changes = [{
    schemaVersion: 2,
    changeId: 'change-v2',
    type: 'odds-change',
    batchId: 'batch-v2',
    old: { selection: { odds: 0.92 } },
    next: { selection: { odds: 0.94 } },
  }]
  const result = store.appendFacts({ snapshots, changes })

  assert.equal(result.snapshots.length, 1)
  assert.equal(result.changes.length, 1)
  assert.match(result.snapshots[0].auditId, /^snapshot:/)
  assert.equal(result.changes[0].auditId, 'change:change-v2')
  const persistedSnapshots = fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  const persistedChanges = fs.readFileSync(changesPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.deepEqual(persistedSnapshots, result.snapshots)
  assert.deepEqual(persistedChanges, result.changes)
  assert.equal(Object.hasOwn(persistedChanges[0], 'candidate'), false)
  assert.equal(Object.hasOwn(persistedChanges[0], 'candidateReason'), false)
})

test('schema-v2 audit append is idempotent after a write succeeds before delivery acknowledgement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-idempotent-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const facts = {
    snapshots: [{ schemaVersion: 2, auditId: 'snapshot:stable-1', batchId: 'batch-1' }],
    changes: [{ schemaVersion: 2, auditId: 'change:stable-1', changeId: 'stable-1', type: 'odds-change' }],
  }

  const firstStore = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  firstStore.appendFacts(facts)
  const secondStore = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  secondStore.appendFacts(facts)

  assert.equal(fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).length, 1)
  assert.equal(fs.readFileSync(changesPath, 'utf8').trim().split(/\r?\n/).length, 1)
  secondStore.close()
  firstStore.close()
})

test('schema-v2 audit separates a truncated diagnostic tail before appending parseable facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-tail-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  fs.writeFileSync(snapshotsPath, '{partial', 'utf8')
  fs.writeFileSync(changesPath, '{partial', 'utf8')
  const store = new JsonlV2AuditStore({ snapshotsPath, changesPath })

  store.appendFacts({
    snapshots: [{ schemaVersion: 2, auditId: 'snapshot:tail', batchId: 'tail-batch' }],
    changes: [{ schemaVersion: 2, auditId: 'change:tail', changeId: 'tail', type: 'odds-change' }],
  })
  store.close()

  for (const file of [snapshotsPath, changesPath]) {
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    assert.equal(rows[0], '{partial')
    assert.doesNotThrow(() => JSON.parse(rows[1]))
    assert.equal(rows.length, 2)
  }
})

test('schema-v2 audit indexes JSONL incrementally without readFileSync of the data files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-chunks-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  fs.writeFileSync(snapshotsPath, `${'{"schemaVersion":2,"auditId":"snapshot:old","batchId":"old"}\n'}${' '.repeat(2 * 1024 * 1024)}\n`, 'utf8')
  fs.writeFileSync(changesPath, '', 'utf8')
  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = (file, ...args) => {
    if ([snapshotsPath, changesPath].includes(String(file))) throw new Error('JSONL readFileSync forbidden')
    return originalReadFileSync(file, ...args)
  }
  try {
    const store = new JsonlV2AuditStore({ snapshotsPath, changesPath, scanChunkBytes: 4096 })
    store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:new', batchId: 'new' }], changes: [] })
    store.close()
  } finally {
    fs.readFileSync = originalReadFileSync
  }
  assert.match(fs.readFileSync(snapshotsPath, 'utf8'), /snapshot:new/)
})

test('schema-v2 audit rebuilds sidecar index after append-before-index crash and rejects auditId collisions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-recovery-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const indexPath = path.join(dir, 'audit-index.sqlite')
  const row = { schemaVersion: 2, auditId: 'snapshot:crash', batchId: 'crash' }
  const first = new JsonlV2AuditStore({ snapshotsPath, changesPath, indexPath })
  first.close()
  fs.appendFileSync(snapshotsPath, `${JSON.stringify(row)}\n`, 'utf8')

  const second = new JsonlV2AuditStore({ snapshotsPath, changesPath, indexPath })
  second.appendFacts({ snapshots: [row], changes: [] })
  assert.equal(fs.readFileSync(snapshotsPath, 'utf8').trim().split(/\r?\n/).length, 1)
  assert.throws(() => second.appendFacts({ snapshots: [{ ...row, batchId: 'different' }], changes: [] }), /collision/)
  second.close()
  assert.throws(() => second.appendFacts({ snapshots: [row], changes: [] }), /closed/)
})

test('schema-v2 audit lock rejects a live writer and cleans a dead-pid stale lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-lock-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const indexPath = path.join(dir, 'audit-index.sqlite')
  const lockPath = `${indexPath}.lock`
  const store = new JsonlV2AuditStore({ snapshotsPath, changesPath, indexPath })
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8')
  assert.throws(() => store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:locked' }], changes: [] }), (error) => error?.code === 'AUDIT_WRITER_BUSY')
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, createdAt: new Date().toISOString() }), 'utf8')
  store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:stale' }], changes: [] })
  assert.equal(fs.existsSync(lockPath), false)
  store.close()
})

test('schema-v2 audit uses the sidecar transaction as the authoritative cross-connection writer mutex', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-db-lock-'))
  const options = {
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
    indexPath: path.join(dir, 'audit-index.sqlite'),
  }
  const first = new JsonlV2AuditStore(options)
  const second = new JsonlV2AuditStore(options)
  first.db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => second.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:mutex' }], changes: [] }), (error) => error?.code === 'AUDIT_WRITER_BUSY')
  } finally {
    first.db.exec('ROLLBACK')
    second.close()
    first.close()
  }
})

test('schema-v2 audit treats an old lock as stale even when its PID has been reused by a live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-reused-pid-'))
  const options = {
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
    indexPath: path.join(dir, 'audit-index.sqlite'),
    staleLockMs: 1000,
  }
  const store = new JsonlV2AuditStore(options)
  const lockPath = `${options.indexPath}.lock`
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    token: 'old-process-token',
  }), 'utf8')
  const oldTime = new Date(Date.now() - 60_000)
  fs.utimesSync(lockPath, oldTime, oldTime)

  store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:reused-pid' }], changes: [] })

  assert.equal(fs.existsSync(lockPath), false)
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: 'invalid', token: 'old-mtime-token' }), 'utf8')
  fs.utimesSync(lockPath, oldTime, oldTime)
  store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:old-mtime' }], changes: [] })
  assert.equal(fs.existsSync(lockPath), false)
  store.close()
})

test('schema-v2 audit removes only its newly created lock when metadata write fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-lock-write-'))
  const indexPath = path.join(dir, 'audit-index.sqlite')
  const lockPath = `${indexPath}.lock`
  let failWrite = true
  const store = new JsonlV2AuditStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
    indexPath,
    writeLockMetadata(fd, text, encoding) {
      if (failWrite) {
        failWrite = false
        throw new Error('injected lock metadata write failure')
      }
      fs.writeFileSync(fd, text, encoding)
    },
  })

  assert.throws(() => store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:first' }], changes: [] }), /injected lock metadata write failure/)
  assert.equal(fs.existsSync(lockPath), false)
  assert.doesNotThrow(() => store.appendFacts({ snapshots: [{ schemaVersion: 2, auditId: 'snapshot:second' }], changes: [] }))
  assert.equal(fs.existsSync(lockPath), false)
  store.close()
})

test('schema-v2 audit validation rejects legacy, sensitive, and candidate payloads before either file is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-v2-reject-'))
  const snapshotsPath = path.join(dir, 'snapshots.jsonl')
  const changesPath = path.join(dir, 'changes.jsonl')
  const store = new JsonlV2AuditStore({ snapshotsPath, changesPath })
  const validSnapshot = { schemaVersion: 2, batchId: 'valid-snapshot' }
  const validChange = { schemaVersion: 2, changeId: 'valid-change', type: 'odds-change' }
  const rejected = [
    { snapshots: [{ schemaVersion: 1 }], changes: [] },
    { snapshots: [validSnapshot], changes: [{ ...validChange, source: { headers: { cookie: 'sid=secret' } } }] },
    { snapshots: [{ ...validSnapshot, storage_state: { token: 'secret' } }], changes: [validChange] },
    { snapshots: [validSnapshot], changes: [{ ...validChange, candidate: true }] },
    { snapshots: [validSnapshot], changes: [{ ...validChange, candidateReason: 'threshold_reached' }] },
  ]

  for (const facts of rejected) {
    assert.throws(() => store.appendFacts(facts), /schemaVersion|sensitive|candidate/)
    assert.equal(fs.readFileSync(snapshotsPath, 'utf8'), '')
    assert.equal(fs.readFileSync(changesPath, 'utf8'), '')
  }
})

test('ignores snapshots outside handicap and total markets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-markets-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  const result = store.ingest([
    record('1.80', { market: { marketType: 'moneyline' }, selection: { side: 'home' } }),
    record('0.94', { market: { marketType: 'total' }, selection: { side: 'over' } }),
  ])

  assert.equal(result.snapshots.length, 1)
  assert.equal(result.snapshots[0].market.marketType, 'total')
  assert.deepEqual(result.changes.map((change) => change.type), ['event-added'])
  const snapshots = fs.readFileSync(path.join(dir, 'snapshots.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  assert.deepEqual(snapshots.map((item) => item.market.marketType), ['total'])
})

test('detects handicap changes even when selection keys move with the line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  store.ingest([record('0.94')])
  const second = store.ingest([record('0.94', {
    market: { marketId: 'market-2', marketKey: 'market-2', handicapRaw: '2/2.5', handicap: 2.25 },
    selection: { selectionId: 'selection-2', selectionKey: 'selection-2' },
  })])

  assert.deepEqual(second.changes.map((change) => change.type), ['handicap-change'])
  const handicap = second.changes[0]
  assert.equal(handicap.old.handicap.raw, '+0/0.5')
  assert.equal(handicap.next.handicap.raw, '2/2.5')
  assert.equal(handicap.old.selection.selectionId, 'selection-1')
  assert.equal(handicap.next.selection.selectionId, 'selection-2')
})

test('detects suspended, reopened, event-added, and event-removed changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  assert.deepEqual(store.ingest([record('0.94')]).changes.map((change) => change.type), ['event-added'])

  const suspended = store.ingest([record('', { selection: { odds: null, suspended: true } })])
  assert.deepEqual(suspended.changes.map((change) => change.type), ['market-suspended'])
  assert.equal(suspended.changes[0].old.selection.suspended, false)
  assert.equal(suspended.changes[0].next.selection.suspended, true)

  const reopened = store.ingest([record('0.96')])
  assert.deepEqual(reopened.changes.map((change) => change.type).sort(), ['market-reopened', 'odds-change'])

  const added = record('0.88', {
    event: {
      eventId: 'event-2',
      eventKey: 'crown|gid=event-2|gidm=gm-2|hgid=hg-2|ecid=ec-2|lid=lid-2',
      homeTeam: 'New Home',
      awayTeam: 'New Away',
    },
    market: { marketId: 'market-new', marketKey: 'market-new' },
    selection: { selectionId: 'selection-new', selectionKey: 'selection-new' },
  })
  const removedAndAdded = store.ingest([added])
  assert.deepEqual(removedAndAdded.changes.map((change) => change.type).sort(), ['event-added', 'event-removed'])
  assert.equal(removedAndAdded.changes.find((change) => change.type === 'event-removed').old.event.eventKey, 'crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1')
})

test('marks odds changes as variation candidates when the monitor threshold is reached', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-candidate-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })
  const monitorSettings = startMonitorMode(normalizeMonitorSettings({
    handicap: {
      waterMoveThreshold: 0.03,
      waterMoveDirection: 'both',
    },
  }), 'handicap')

  store.ingest([record('0.94')], { monitorSettings })
  const second = store.ingest([record('0.98')], { monitorSettings })

  assert.equal(second.changes.length, 1)
  assert.equal(second.changes[0].type, 'odds-change')
  assert.equal(second.changes[0].candidate, true)
  assert.equal(second.changes[0].candidateReason, 'threshold_reached')
  assert.equal(second.changes[0].delta, 0.04)
  assert.equal(second.changes[0].threshold, 0.03)

  const persisted = fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .find((change) => change.type === 'odds-change')
  assert.equal(persisted.candidate, true)
})

test('finds latest selection snapshot by event, market, period, and side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-latest-selection-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  store.ingest([
    record('0.94', { selection: { side: 'home', selectionId: 'home-1', selectionKey: 'home-1' } }),
    record('0.88', { selection: { side: 'away', selectionId: 'away-1', selectionKey: 'away-1' } }),
  ])

  const away = store.findLatestSelection({
    provider: 'crown',
    eventKey: 'crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1',
    period: 'full_time',
    marketType: 'asian_handicap',
    side: 'away',
  })

  assert.equal(away.selection.side, 'away')
  assert.equal(away.selection.oddsRaw, '0.88')
})

test('finds latest reverse selection on the same market line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-latest-selection-line-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  store.ingest([
    record('0.88', {
      market: { lineKey: 'RATIO_AR', ratioField: 'RATIO_AR', marketId: 'market-ar', marketKey: 'market-ar' },
      selection: { side: 'away', selectionId: 'away-ar', selectionKey: 'away-ar' },
    }),
    record('1.02', {
      market: { lineKey: 'RATIO_FR', ratioField: 'RATIO_FR', marketId: 'market-fr', marketKey: 'market-fr' },
      selection: { side: 'away', selectionId: 'away-fr', selectionKey: 'away-fr' },
    }),
  ])

  const away = store.findLatestSelection({
    provider: 'crown',
    eventKey: 'crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineKey: 'RATIO_FR',
    side: 'away',
  })

  assert.equal(away.selection.selectionId, 'away-fr')
  assert.equal(away.selection.oddsRaw, '1.02')
})
