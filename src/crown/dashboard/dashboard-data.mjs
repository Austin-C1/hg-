import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { repairCrownText } from '../crown-text.mjs'
import { readJsonlFile, readJsonlFileFiltered, toProjectRelativePath } from './jsonl-reader.mjs'

const DEFAULT_SNAPSHOT_PATH = 'data/runtime/crown-odds-snapshots.jsonl'
const DEFAULT_CHANGES_PATH = 'data/runtime/crown-odds-changes.jsonl'
const DEFAULT_V2_SNAPSHOT_PATH = 'data/runtime/crown-odds-snapshots-v2.jsonl'
const DEFAULT_V2_CHANGES_PATH = 'data/runtime/crown-odds-changes-v2.jsonl'
const DEFAULT_DB_PATH = 'storage/crown.sqlite'
const DEFAULT_RUNTIME_LOG_PATH = 'data/runtime/crown-watch-runtime.jsonl'
const DEFAULT_FIXTURE_SNAPSHOT_PATH = 'data/fixtures/crown/20260708_004011/replay-normalized.jsonl'
const DEFAULT_CONFIG_PATH = 'config/monitored-leagues.json'
const DEFAULT_CHANGE_LIMIT = 100
const DEFAULT_SNAPSHOT_READ_LINES = 20_000
const DEFAULT_CHANGE_READ_LINES = 5_000
const DEFAULT_RUNTIME_LOG_READ_LINES = 2_000
const KICKOFF_QUALITY_RANK = new Map([
  ['missing', 1],
  ['invalid', 2],
  ['inferred', 3],
  ['high', 4],
])
const BEIJING_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function clean(value, fallback = '') {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function timeValue(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function factTimestamp(record) {
  return record?.capturedAt || record?.observedAt || null
}

function newestIso(records, selector = factTimestamp) {
  let latest = null
  for (const record of records) {
    const value = selector(record)
    if (!value) continue
    if (!latest || timeValue(value) > timeValue(latest)) latest = value
  }
  return latest
}

function compareCapturedDesc(a, b) {
  return timeValue(factTimestamp(b)) - timeValue(factTimestamp(a))
}

function textOrNull(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function canonicalUtc(value) {
  const text = textOrNull(value)
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) return null
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString() === text ? text : null
}

function normalizedTimeWarnings(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(textOrNull).filter(Boolean))]
}

function kickoffProjection(event = {}, capturedAt = null) {
  const startTimeRaw = textOrNull(event?.startTimeRaw)
  const suppliedUtc = textOrNull(event?.startTimeUtc)
  const startTimeUtc = canonicalUtc(suppliedUtc)
  const timeWarnings = normalizedTimeWarnings(event?.timeWarnings)
  const confidence = String(event?.timeConfidence || '').trim().toLowerCase()
  let timeQuality = 'missing'
  if (startTimeUtc) {
    timeQuality = confidence === 'high' && !timeWarnings.includes('kickoff-year-inferred') ? 'high' : 'inferred'
  } else if (startTimeRaw || suppliedUtc) {
    timeQuality = 'invalid'
  }
  return {
    startTimeRaw,
    startTimeUtc,
    startTimeBeijing: startTimeUtc ? formatBeijing(startTimeUtc) : null,
    timeQuality,
    timeWarnings,
    capturedAt: factTimestamp({ capturedAt }),
  }
}

function formatBeijing(startTimeUtc) {
  const milliseconds = Date.parse(startTimeUtc)
  if (!Number.isFinite(milliseconds)) return null
  const parts = Object.fromEntries(
    BEIJING_FORMATTER.formatToParts(new Date(milliseconds))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function preferKickoff(current, candidate) {
  if (!current) return candidate
  const qualityDifference = (KICKOFF_QUALITY_RANK.get(candidate.timeQuality) || 0)
    - (KICKOFF_QUALITY_RANK.get(current.timeQuality) || 0)
  if (qualityDifference > 0) return candidate
  if (qualityDifference < 0) return current
  if (candidate.timeQuality === 'invalid') {
    if (current.startTimeRaw && !candidate.startTimeRaw) return current
    if (candidate.startTimeRaw && !current.startTimeRaw) return candidate
  }
  return timeValue(candidate.capturedAt) >= timeValue(current.capturedAt) ? candidate : current
}

function compareKickoffAsc(a, b) {
  const left = canonicalUtc(a?.startTimeUtc)
  const right = canonicalUtc(b?.startTimeUtc)
  if (left && right) {
    const difference = Date.parse(left) - Date.parse(right)
    if (difference) return difference
  } else if (left) {
    return -1
  } else if (right) {
    return 1
  }
  return clean(a?.eventKey).localeCompare(clean(b?.eventKey))
}

function fileMetadata(file) {
  const meta = {
    exists: Boolean(file?.exists),
    path: file?.path || null,
    lineCount: file?.lineCount || 0,
    parseErrors: file?.parseErrors || 0,
    updatedAt: file?.updatedAt || null,
  }
  if (file?.error) meta.error = file.error
  if (file?.truncated) meta.truncated = true
  return meta
}

function dataWarnings(files) {
  const warnings = []
  for (const [name, file] of Object.entries(files)) {
    if (!file?.exists) warnings.push(`${name}:missing`)
    if (file?.parseErrors) warnings.push(`${name}:parse-errors:${file.parseErrors}`)
  }
  return warnings
}

function dataOrigin({ source, runtimeSnapshots, fallbackSnapshots }) {
  const usingRuntime = source === 'xml-live' || source === 'dom-fallback' || source === 'runtime-jsonl'
  return {
    kind: usingRuntime ? source : 'fixture-fallback',
    isRuntime: usingRuntime,
    runtime: {
      exists: Boolean(runtimeSnapshots?.exists),
      empty: !runtimeSnapshots?.records?.length,
      lineCount: runtimeSnapshots?.lineCount || 0,
      updatedAt: runtimeSnapshots?.updatedAt || null,
    },
    fallback: fallbackSnapshots ? {
      exists: Boolean(fallbackSnapshots.exists),
      lineCount: fallbackSnapshots.lineCount || 0,
      updatedAt: fallbackSnapshots.updatedAt || null,
    } : null,
  }
}

export function stableEventKey(record) {
  if (record?.event?.eventKey) return clean(record.event.eventKey)
  if (record?.eventIdentity) return clean(record.eventIdentity)
  return [
    clean(record?.provider, 'unknown'),
    clean(record?.event?.league),
    clean(record?.event?.homeTeam),
    clean(record?.event?.awayTeam),
    clean(record?.mode || record?.event?.mode, 'unknown'),
  ].join('|')
}

export function stableOddsKey(record) {
  if (record?.selection?.selectionIdentity) return clean(record.selection.selectionIdentity)
  return [
    clean(record?.market?.marketIdentity, clean(record?.market?.marketKey, clean(record?.market?.marketId))),
    clean(record?.market?.marketType),
    clean(record?.market?.handicapRaw),
    clean(record?.selection?.selectionKey, clean(record?.selection?.selectionId)),
    clean(record?.selection?.side),
  ].join('|')
}

function normalizedQualityReason(value) {
  const reason = clean(value).replace(/^data_incomplete:/, '')
  if (reason.includes('start_time_missing')) return 'start_time_missing'
  if (reason.includes('start_time_invalid')) return 'start_time_invalid'
  if (reason.includes('live_clock_missing')) return 'live_clock_missing'
  return null
}

function recordDataQualityReasons(record) {
  const reasons = new Set()
  for (const warning of record?.warnings || []) {
    const reason = normalizedQualityReason(warning)
    if (reason) reasons.add(reason)
  }
  if (record?.schemaVersion === 2) {
    const mode = record?.mode || record?.event?.mode
    const kickoff = kickoffProjection(record?.event, factTimestamp(record))
    if (mode === 'prematch' && kickoff.timeQuality === 'missing') reasons.add('start_time_missing')
    if (mode === 'prematch' && kickoff.timeQuality === 'invalid') reasons.add('start_time_invalid')
    const liveMinute = record?.event?.liveMinute
    if (mode === 'live' && (liveMinute === null || liveMinute === undefined || liveMinute === '' || !Number.isFinite(Number(liveMinute)))) {
      reasons.add('live_clock_missing')
    }
  }
  return [...reasons].sort()
}

function dataQuality(reasons = []) {
  const normalized = [...new Set(reasons.filter(Boolean))].sort()
  return { complete: normalized.length === 0, reasons: normalized }
}

function marketKey(record) {
  if (record?.market?.marketIdentity) return clean(record.market.marketIdentity)
  if (record?.market?.marketKey) return clean(record.market.marketKey)
  return [
    clean(record?.market?.marketId),
    clean(record?.market?.marketType),
    clean(record?.market?.period),
    clean(record?.market?.handicapRaw),
  ].join('|')
}

function selectionPayload(record) {
  return {
    selectionKey: stableOddsKey(record),
    selectionId: record?.selection?.selectionId || null,
    oddsId: record?.selection?.oddsId ?? null,
    side: record?.selection?.side || null,
    oddsRaw: record?.selection?.oddsRaw ?? null,
    odds: record?.selection?.odds ?? null,
    oddsFormat: record?.selection?.oddsFormat || null,
    suspended: Boolean(record?.selection?.suspended),
    capturedAt: record?.capturedAt || null,
    warnings: Array.isArray(record?.warnings) ? record.warnings : [],
  }
}

function sortSelection(a, b) {
  const order = new Map([['home', 1], ['away', 2], ['draw', 3], ['over', 4], ['under', 5]])
  return (order.get(a.side) || 99) - (order.get(b.side) || 99)
    || clean(a.selectionId).localeCompare(clean(b.selectionId))
}

export function buildEvents(snapshotRecords = []) {
  const groups = new Map()

  for (const record of snapshotRecords) {
    const eventKey = stableEventKey(record)
    if (!groups.has(eventKey)) {
      groups.set(eventKey, {
        eventKey,
        provider: record?.provider || null,
        sport: record?.sport || null,
        league: repairCrownText(record?.event?.league),
        homeTeam: repairCrownText(record?.event?.homeTeam),
        awayTeam: repairCrownText(record?.event?.awayTeam),
        mode: record?.mode || record?.event?.mode || 'unknown',
        status: record?.event?.status || 'unknown',
        score: record?.event?.score ?? null,
        clock: record?.event?.clock ?? null,
        kickoff: null,
        recordCount: 0,
        lastCapturedAt: null,
        latestBySelection: new Map(),
        warnings: new Set(),
        dataQualityReasons: new Set(),
      })
    }

    const group = groups.get(eventKey)
    group.recordCount += 1
    for (const warning of record?.warnings || []) group.warnings.add(warning)
    for (const reason of recordDataQualityReasons(record)) {
      if (!reason.startsWith('start_time_')) group.dataQualityReasons.add(reason)
    }
    group.kickoff = preferKickoff(group.kickoff, kickoffProjection(record?.event, factTimestamp(record)))

    if (!group.lastCapturedAt || timeValue(record?.capturedAt) >= timeValue(group.lastCapturedAt)) {
      group.provider = record?.provider || group.provider
      group.sport = record?.sport || group.sport
      group.mode = record?.mode || record?.event?.mode || group.mode
      group.status = record?.event?.status || group.status
      group.score = record?.event?.score ?? group.score
      group.clock = record?.event?.clock ?? group.clock
      group.lastCapturedAt = record?.capturedAt || group.lastCapturedAt
    }

    const oddsKey = stableOddsKey(record)
    const previous = group.latestBySelection.get(oddsKey)
    if (!previous || timeValue(record?.capturedAt) >= timeValue(previous?.capturedAt)) {
      group.latestBySelection.set(oddsKey, record)
    }
  }

  return [...groups.values()].map((group) => {
    const kickoff = group.kickoff || kickoffProjection()
    if (group.mode === 'prematch' && kickoff.timeQuality === 'missing') group.dataQualityReasons.add('start_time_missing')
    if (group.mode === 'prematch' && kickoff.timeQuality === 'invalid') group.dataQualityReasons.add('start_time_invalid')
    const markets = new Map()
    for (const record of group.latestBySelection.values()) {
      const key = marketKey(record)
      if (!markets.has(key)) {
        markets.set(key, {
          marketKey: key,
          marketId: record?.market?.marketId || null,
          idScope: record?.market?.idScope || null,
          marketType: record?.market?.marketType || null,
          period: record?.market?.period || null,
          handicapRaw: record?.market?.handicapRaw ?? null,
          handicap: record?.market?.handicap ?? null,
          ratioField: record?.market?.ratioField || null,
          isMainMarket: record?.market?.isMainMarket ?? null,
          selections: [],
        })
      }
      markets.get(key).selections.push(selectionPayload(record))
    }

    const marketItems = [...markets.values()]
      .map((market) => ({ ...market, selections: market.selections.sort(sortSelection) }))
      .sort((a, b) => clean(a.marketType).localeCompare(clean(b.marketType))
        || clean(a.period).localeCompare(clean(b.period))
        || clean(a.handicapRaw).localeCompare(clean(b.handicapRaw))
        || clean(a.marketId).localeCompare(clean(b.marketId)))

    return {
      eventKey: group.eventKey,
      provider: group.provider,
      sport: group.sport,
      league: group.league,
      homeTeam: group.homeTeam,
      awayTeam: group.awayTeam,
      mode: group.mode,
      status: group.status,
      score: group.score,
      clock: group.clock,
      startTimeRaw: kickoff.startTimeRaw,
      startTimeUtc: kickoff.startTimeUtc,
      startTimeBeijing: kickoff.startTimeBeijing,
      timeQuality: kickoff.timeQuality,
      timeWarnings: kickoff.timeWarnings,
      recordCount: group.recordCount,
      marketCount: marketItems.length,
      selectionCount: group.latestBySelection.size,
      lastCapturedAt: group.lastCapturedAt,
      warnings: [...group.warnings].sort(),
      dataQuality: dataQuality([...group.dataQualityReasons]),
      markets: marketItems,
    }
  }).sort(compareKickoffAsc)
}

function changeDirection(change) {
  const oldValue = change?.old?.selection ?? change?.old
  const nextValue = change?.next?.selection ?? change?.next
  const oldOdds = Number(oldValue?.odds?.value ?? oldValue?.odds ?? oldValue?.oddsRaw)
  const newOdds = Number(nextValue?.odds?.value ?? nextValue?.odds ?? nextValue?.oddsRaw)
  if (!Number.isFinite(oldOdds) || !Number.isFinite(newOdds)) return 'unknown'
  if (newOdds > oldOdds) return 'up'
  if (newOdds < oldOdds) return 'down'
  return 'flat'
}

function changeOddsRaw(value) {
  const selection = value?.selection ?? value
  return selection?.odds?.raw ?? selection?.oddsRaw ?? null
}

function changeHandicapRaw(value) {
  return value?.handicap?.raw ?? value?.handicapRaw ?? value?.market?.handicapRaw ?? null
}

function isXmlSnapshot(record) {
  return record?.source?.mapperVersion === 'crown-transform-xml-v2'
    || record?.source?.mapperVersion === 'crown-transform-xml-v1'
    || record?.source?.dataSource === 'xml-live'
    || (Array.isArray(record?.warnings) && record.warnings.includes('crown-transform-xml'))
}

function sourceFromSnapshots(snapshotRecords, fallbackSource) {
  if (fallbackSource === 'fixture-replay') return fallbackSource
  if (snapshotRecords.some(isXmlSnapshot)) return 'xml-live'
  if (snapshotRecords.length) return 'dom-fallback'
  return fallbackSource
}

function maxNumber(records, key) {
  let max = 0
  for (const record of records || []) {
    const value = Number(record?.[key])
    if (Number.isFinite(value) && value > max) max = value
  }
  return max
}

function runtimeXmlStats(runtimeLog = { records: [] }) {
  const records = runtimeLog?.records || []
  const xmlRows = records.filter((record) => record?.type === 'xml-response')
  return {
    file: fileMetadata(runtimeLog),
    xmlResponses: maxNumber(records, 'xmlResponses') || xmlRows.length,
    getGameListCount: maxNumber(records, 'getGameListCount'),
    getGameMoreCount: maxNumber(records, 'getGameMoreCount'),
    xmlEvents: maxNumber(records, 'xmlEvents'),
    normalizedRecords: maxNumber(records, 'normalizedRecords'),
    snapshotWrites: maxNumber(records, 'snapshotWrites'),
    changeWrites: maxNumber(records, 'changeWrites'),
    parseErrors: maxNumber(records, 'parseErrors'),
    emptyXmlResponses: maxNumber(records, 'emptyXmlResponses'),
    loginExpiredResponses: maxNumber(records, 'loginExpiredResponses'),
    lastXmlAt: newestIso(records, (record) => record?.lastXmlAt || (record?.type === 'xml-response' ? record?.at : null)),
    lastSnapshotAt: newestIso(records, (record) => record?.lastSnapshotAt),
  }
}

function sourceLabel(source) {
  if (source === 'xml-live') return 'XML live'
  if (source === 'dom-fallback') return 'DOM fallback'
  if (source === 'fixture-replay') return 'fixture replay'
  return source
}

function oddsIdAvailable(records) {
  return records.some((record) => record?.selection?.oddsId !== null && record?.selection?.oddsId !== undefined && record?.selection?.oddsId !== '')
}

function preferXmlRuntimeSnapshots(runtimeSnapshots) {
  const records = runtimeSnapshots?.records || []
  const xmlRecords = records.filter(isXmlSnapshot)
  if (!xmlRecords.length) return runtimeSnapshots
  return {
    ...runtimeSnapshots,
    records: xmlRecords,
  }
}

export function buildChanges(changeRecords = [], { limit = DEFAULT_CHANGE_LIMIT, eventKey = null } = {}) {
  const records = eventKey
    ? changeRecords.filter((change) => stableEventKey(change) === eventKey)
    : changeRecords

  return [...records]
    .sort(compareCapturedDesc)
    .slice(0, limit)
    .map((change) => ({
      type: change?.type || 'odds-change',
      key: change?.key || change?.changeId || null,
      capturedAt: factTimestamp(change),
      eventKey: stableEventKey(change),
      provider: change?.provider || null,
      mode: change?.mode || change?.event?.mode || null,
      league: repairCrownText(change?.event?.league),
      homeTeam: repairCrownText(change?.event?.homeTeam),
      awayTeam: repairCrownText(change?.event?.awayTeam),
      marketType: change?.market?.marketType || null,
      period: change?.market?.period || null,
      handicapRaw: change?.market?.handicapRaw ?? null,
      side: change?.selection?.side || null,
      oldHandicapRaw: changeHandicapRaw(change?.old),
      newHandicapRaw: changeHandicapRaw(change?.next),
      oldOddsRaw: changeOddsRaw(change?.old),
      newOddsRaw: changeOddsRaw(change?.next),
      direction: changeDirection(change),
      dataQuality: dataQuality(recordDataQualityReasons(change)),
    }))
}

async function readChangesFile(changesPath, { changeLimit = DEFAULT_CHANGE_LIMIT, changeEventKey = null, changeReadLines = DEFAULT_CHANGE_READ_LINES } = {}) {
  if (changeEventKey) {
    return readJsonlFileFiltered(changesPath, {
      limit: changeLimit,
      predicate: (record) => stableEventKey(record) === changeEventKey,
    })
  }
  return readJsonlFile(changesPath, { maxLines: Math.max(changeLimit, changeReadLines) })
}

function resolvedAuditPaths({
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  changesPath = DEFAULT_CHANGES_PATH,
  v2SnapshotPath,
  v2ChangesPath,
} = {}) {
  const runtimeDir = path.dirname(snapshotPath)
  return {
    snapshotPath,
    changesPath,
    v2SnapshotPath: v2SnapshotPath || (snapshotPath === DEFAULT_SNAPSHOT_PATH
      ? DEFAULT_V2_SNAPSHOT_PATH
      : path.join(runtimeDir, path.basename(DEFAULT_V2_SNAPSHOT_PATH))),
    v2ChangesPath: v2ChangesPath || (changesPath === DEFAULT_CHANGES_PATH
      ? DEFAULT_V2_CHANGES_PATH
      : path.join(path.dirname(changesPath), path.basename(DEFAULT_V2_CHANGES_PATH))),
  }
}

async function readAuditGeneration(options = {}) {
  const paths = resolvedAuditPaths(options)
  const v2Snapshots = await readJsonlFile(paths.v2SnapshotPath, { maxLines: options.snapshotReadLines || DEFAULT_SNAPSHOT_READ_LINES })
  const v2Changes = await readChangesFile(paths.v2ChangesPath, options)
  const useV2 = v2Snapshots.exists || v2Changes.exists
  if (useV2) return { schemaVersion: 2, snapshots: v2Snapshots, changes: v2Changes, paths }
  return {
    schemaVersion: 1,
    snapshots: await readJsonlFile(paths.snapshotPath, { maxLines: options.snapshotReadLines || DEFAULT_SNAPSHOT_READ_LINES }),
    changes: await readChangesFile(paths.changesPath, options),
    paths,
  }
}

export async function readDashboardChanges({
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  changesPath = DEFAULT_CHANGES_PATH,
  v2SnapshotPath,
  v2ChangesPath,
  changeLimit = DEFAULT_CHANGE_LIMIT,
  changeEventKey = null,
  changeReadLines = DEFAULT_CHANGE_READ_LINES,
} = {}) {
  const generation = await readAuditGeneration({
    snapshotPath,
    changesPath,
    v2SnapshotPath,
    v2ChangesPath,
    snapshotReadLines: 1,
    changeLimit,
    changeEventKey,
    changeReadLines,
  })
  const changes = generation.changes
  return {
    schemaVersion: generation.schemaVersion,
    source: generation.schemaVersion === 2 ? 'monitor-v2' : 'runtime-jsonl',
    origin: generation.schemaVersion === 2 ? 'monitor-v2' : 'runtime-jsonl',
    items: buildChanges(changes.records, { limit: changeLimit, eventKey: changeEventKey }),
    warnings: dataWarnings({ changes }),
    file: fileMetadata(changes),
  }
}

export function buildSummary({ snapshots, changes, source = 'runtime-jsonl', origin = null, schemaVersion = 1 }) {
  const snapshotRecords = snapshots?.records || []
  const changeRecords = changes?.records || []
  const events = buildEvents(snapshotRecords)
  const leagues = new Set(events.map((event) => event.league).filter(Boolean))
  const lastSnapshotAt = newestIso(snapshotRecords)
  const lastChangeAt = newestIso(changeRecords)

  return {
    schemaVersion,
    readonly: true,
    source,
    dataOrigin: origin,
    files: {
      snapshots: fileMetadata(snapshots),
      changes: fileMetadata(changes),
    },
    totals: {
      events: events.length,
      leagues: leagues.size,
      snapshots: snapshotRecords.length,
      changes: changeRecords.length,
    },
    lastCapturedAt: newestIso([{ capturedAt: lastSnapshotAt }, { capturedAt: lastChangeAt }]),
  }
}

function incompleteDataSummary(snapshotRecords = [], changeRecords = []) {
  const facts = new Map()
  const byReason = {}
  for (const event of buildEvents([...snapshotRecords, ...changeRecords])) {
    for (const reason of event.dataQuality?.reasons || []) {
      const key = `${event.eventKey}\u0000${reason}`
      if (facts.has(key)) continue
      facts.set(key, {
        eventKey: event.eventKey,
        reason,
        mode: event.mode,
        league: event.league,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
      })
    }
  }
  const items = [...facts.values()].sort((a, b) => a.eventKey.localeCompare(b.eventKey) || a.reason.localeCompare(b.reason))
  for (const { reason } of items) {
    byReason[reason] = (byReason[reason] || 0) + 1
  }
  return { total: items.length, byReason, items }
}

function unavailableMonitorHealth(reason, incompleteData) {
  return {
    available: false,
    reason,
    state: {
      events: { active: 0, inactive: 0, total: 0 },
      selections: 0,
      signals: 0,
      candidates: 0,
    },
    deliveries: { pending: 0, deadLetter: 0, sent: 0, total: 0 },
    lastAuthoritative: null,
    incompleteData,
  }
}

async function readMonitorHealth({ dbPath = DEFAULT_DB_PATH, incompleteData }) {
  const resolved = path.resolve(dbPath)
  try {
    await fs.access(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') return unavailableMonitorHealth('database-missing', incompleteData)
    return unavailableMonitorHealth('database-unavailable', incompleteData)
  }

  let db
  try {
    db = new DatabaseSync(resolved, { readOnly: true })
    const requiredTables = [
      'monitor_scope_state', 'monitor_event_state', 'monitor_selection_state',
      'monitor_signals', 'monitor_candidates', 'monitor_deliveries',
    ]
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (${requiredTables.map(() => '?').join(',')})
    `).all(...requiredTables)
    if (rows.length !== requiredTables.length) return unavailableMonitorHealth('schema-unavailable', incompleteData)

    const events = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN active <> 1 THEN 1 ELSE 0 END) AS inactive
      FROM monitor_event_state
    `).get()
    const selections = db.prepare('SELECT COUNT(*) AS total FROM monitor_selection_state').get()
    const signals = db.prepare('SELECT COUNT(*) AS total FROM monitor_signals').get()
    const candidates = db.prepare('SELECT COUNT(*) AS total FROM monitor_candidates').get()
    const deliveries = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('pending', 'retry', 'dispatching') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'dead-letter' THEN 1 ELSE 0 END) AS dead_letter,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
      FROM monitor_deliveries
    `).get()
    const last = db.prepare(`
      SELECT scope_key, last_batch_id, last_captured_at, last_complete_at
      FROM monitor_scope_state
      WHERE last_complete_at <> ''
      ORDER BY last_complete_at DESC, scope_key
      LIMIT 1
    `).get()
    return {
      available: true,
      reason: null,
      state: {
        events: {
          active: Number(events?.active || 0),
          inactive: Number(events?.inactive || 0),
          total: Number(events?.total || 0),
        },
        selections: Number(selections?.total || 0),
        signals: Number(signals?.total || 0),
        candidates: Number(candidates?.total || 0),
      },
      deliveries: {
        pending: Number(deliveries?.pending || 0),
        deadLetter: Number(deliveries?.dead_letter || 0),
        sent: Number(deliveries?.sent || 0),
        total: Number(deliveries?.total || 0),
      },
      lastAuthoritative: last ? {
        scopeKey: last.scope_key,
        batchId: last.last_batch_id,
        capturedAt: last.last_captured_at,
        completedAt: last.last_complete_at,
      } : null,
      incompleteData,
    }
  } catch {
    return unavailableMonitorHealth('database-unavailable', incompleteData)
  } finally {
    db?.close()
  }
}

function attachDataSource(summary, { snapshotRecords, runtimeLogStats }) {
  const hasOddsId = oddsIdAvailable(snapshotRecords)
  summary.dataSource = {
    kind: summary.source,
    label: sourceLabel(summary.source),
    lastXmlAt: runtimeLogStats.lastXmlAt || newestIso(snapshotRecords.filter(isXmlSnapshot)),
    xmlResponses: runtimeLogStats.xmlResponses,
    getGameListCount: runtimeLogStats.getGameListCount,
    getGameMoreCount: runtimeLogStats.getGameMoreCount,
    xmlEvents: runtimeLogStats.xmlEvents,
    normalizedRecords: runtimeLogStats.normalizedRecords,
    snapshotWrites: runtimeLogStats.snapshotWrites,
    changeWrites: runtimeLogStats.changeWrites,
    parseErrors: runtimeLogStats.parseErrors,
    emptyXmlResponses: runtimeLogStats.emptyXmlResponses,
    loginExpiredResponses: runtimeLogStats.loginExpiredResponses,
    lastSnapshotAt: runtimeLogStats.lastSnapshotAt || newestIso(snapshotRecords),
    eventCount: summary.totals.events,
    recordCount: summary.totals.snapshots,
    changeCount: summary.totals.changes,
    oddsIdAvailable: hasOddsId,
    oddsIdStatus: hasOddsId ? 'available' : 'null-not-available',
    bettingExecution: 'not-connected',
  }
  return summary
}

export async function readDashboardConfig(configPath = DEFAULT_CONFIG_PATH) {
  const displayPath = toProjectRelativePath(configPath)
  let stat
  try {
    stat = await fs.stat(configPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {
      exists: false,
      path: displayPath,
      updatedAt: null,
      config: null,
      error: 'missing',
    }
  }

  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    return {
      exists: true,
      path: displayPath,
      updatedAt: stat.mtime.toISOString(),
      config,
      error: null,
    }
  } catch {
    return {
      exists: true,
      path: displayPath,
      updatedAt: stat.mtime.toISOString(),
      config: null,
      error: 'invalid-json',
    }
  }
}

export async function readDashboardData({
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  changesPath = DEFAULT_CHANGES_PATH,
  v2SnapshotPath,
  v2ChangesPath,
  dbPath = DEFAULT_DB_PATH,
  runtimeLogPath = DEFAULT_RUNTIME_LOG_PATH,
  fixtureSnapshotPath = DEFAULT_FIXTURE_SNAPSHOT_PATH,
  allowFixtureFallback = false,
  configPath = DEFAULT_CONFIG_PATH,
  changeLimit = DEFAULT_CHANGE_LIMIT,
  changeEventKey = null,
  snapshotReadLines = DEFAULT_SNAPSHOT_READ_LINES,
  changeReadLines = DEFAULT_CHANGE_READ_LINES,
  runtimeLogReadLines = DEFAULT_RUNTIME_LOG_READ_LINES,
} = {}) {
  const generation = await readAuditGeneration({
    snapshotPath,
    changesPath,
    v2SnapshotPath,
    v2ChangesPath,
    snapshotReadLines,
    changeLimit,
    changeEventKey,
    changeReadLines,
  })
  const runtimeSnapshots = generation.snapshots
  const changes = generation.changes
  const runtimeLog = await readJsonlFile(runtimeLogPath, { maxLines: runtimeLogReadLines })
  const xmlStats = runtimeXmlStats(runtimeLog)
  let snapshots = generation.schemaVersion === 2 ? runtimeSnapshots : preferXmlRuntimeSnapshots(runtimeSnapshots)
  let source = generation.schemaVersion === 2 ? 'monitor-v2' : 'runtime-jsonl'
  const warnings = dataWarnings({ snapshots: runtimeSnapshots, changes })

  if (allowFixtureFallback && generation.schemaVersion !== 2 && (!runtimeSnapshots.exists || snapshots.records.length === 0)) {
    snapshots = await readJsonlFile(fixtureSnapshotPath)
    source = 'fixture-replay'
    warnings.push(runtimeSnapshots.exists ? 'snapshots:runtime-empty-fallback' : 'snapshots:runtime-missing-fallback')
    if (!snapshots.exists) warnings.push('snapshots:fallback-missing')
    if (snapshots.parseErrors) warnings.push(`snapshots:fallback-parse-errors:${snapshots.parseErrors}`)
  }
  if (generation.schemaVersion !== 2) source = sourceFromSnapshots(snapshots.records, source)

  const config = await readDashboardConfig(configPath)
  const summary = buildSummary({ snapshots, changes, source, schemaVersion: generation.schemaVersion })
  summary.dataOrigin = generation.schemaVersion === 2 ? {
    kind: 'monitor-v2',
    isRuntime: true,
    runtime: {
      exists: Boolean(runtimeSnapshots.exists),
      empty: !runtimeSnapshots.records.length,
      lineCount: runtimeSnapshots.lineCount || 0,
      updatedAt: runtimeSnapshots.updatedAt || null,
    },
    fallback: null,
  } : dataOrigin({
    source,
    runtimeSnapshots,
    fallbackSnapshots: source === 'fixture-replay' ? snapshots : null,
  })
  summary.files.runtimeLog = fileMetadata(runtimeLog)
  attachDataSource(summary, { snapshotRecords: snapshots.records, runtimeLogStats: xmlStats })
  const eventItems = buildEvents(snapshots.records)
  const changeItems = buildChanges(changes.records, { limit: changeLimit, eventKey: changeEventKey })
  summary.monitorHealth = await readMonitorHealth({
    dbPath,
    incompleteData: incompleteDataSummary(snapshots.records, changes.records),
  })

  return {
    summary: { ...summary, warnings },
    events: { schemaVersion: generation.schemaVersion, source, origin: source, items: eventItems, warnings },
    changes: { schemaVersion: generation.schemaVersion, source, origin: source, items: changeItems, warnings: dataWarnings({ changes }) },
    config,
  }
}
