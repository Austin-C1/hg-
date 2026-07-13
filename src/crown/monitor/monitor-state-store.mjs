import { createHash } from 'node:crypto'

import { openAppDatabase } from '../app/app-db.mjs'
import {
  marketIdentity as canonicalMarketIdentity,
  selectionIdentity as canonicalSelectionIdentity,
} from './snapshot-batch.mjs'
import { normalizeSignalForPersistence } from './signal.mjs'
import { matchEnabledRuleCardForSignal } from '../betting/auto-betting-rule-card-matcher.mjs'

const CANONICAL_EVENT_KEY = /^crown\|football\|gid=[^|\s]+$/
const DELIVERY_CHANNELS = new Set(['console', 'telegram'])
const DELIVERY_FINAL_STATUSES = new Set(['retry', 'sent', 'dead-letter'])
const DELIVERY_ERROR_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/
const SENSITIVE_ERROR_CODE = /(authorization|cookie|password|secret|session|ticket|token)/i
const SENSITIVE_KEY = new Set([
  'authorization',
  'cookie',
  'cookies',
  'headers',
  'httpheaders',
  'password',
  'passwd',
  'rawheaders',
  'rawhttpheaders',
  'session',
  'sessionid',
  'ticket',
  'ticketid',
  'token',
  'accesstoken',
  'refreshtoken',
])
const RAW_TRANSPORT_KEY = new Set(['body', 'rawbody', 'rawproviderresponse', 'rawresponse', 'rawxml', 'responsebody', 'storagestate'])
const CANDIDATE_STATUSES = new Set(['eligible', 'skipped'])
const SNAPSHOT_FIELDS = ['provider', 'sport', 'mode', 'capturedAt', 'source', 'event', 'market', 'selection', 'warnings']
const EVENT_FIELDS = [
  'eventId',
  'eventKey',
  'legacyEventKey',
  'matchGroupKey',
  'identityConfidence',
  'league',
  'homeTeam',
  'awayTeam',
  'mode',
  'startTimeRaw',
  'startTimeUtc',
  'startTimeLocal',
  'timeZone',
  'timeSource',
  'timeConfidence',
  'timeWarnings',
  'status',
  'score',
  'clock',
  'livePhase',
  'liveMinute',
  'liveClockWarnings',
  'providerIds',
  'ids',
]
const SOURCE_FIELDS = ['endpointKey', 'urlPattern', 'endpointKind', 'mapperVersion', 'sampleFile', 'confidence', 'dataSource']
const MARKET_FIELDS = [
  'marketId',
  'marketKey',
  'marketIdentity',
  'legacyMarketKey',
  'idScope',
  'providerMarketId',
  'marketType',
  'period',
  'handicapRaw',
  'handicap',
  'ratioField',
  'lineKey',
  'isMainMarket',
  'crownStrong',
]
const SELECTION_FIELDS = [
  'selectionId',
  'selectionKey',
  'selectionIdentity',
  'legacySelectionKey',
  'idScope',
  'providerSelectionId',
  'oddsId',
  'side',
  'oddsRaw',
  'odds',
  'oddsField',
  'oddsFormat',
  'suspended',
]

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requiredTimestamp(value, name) {
  requiredString(value, name)
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be a valid timestamp`)
  return value
}

function requiredCanonicalTimestamp(value, name) {
  requiredTimestamp(value, name)
  if (new Date(Date.parse(value)).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC timestamp`)
  }
  return value
}

function assertCanonicalEventKey(value, providerIds = null) {
  requiredString(value, 'eventKey')
  if (!CANONICAL_EVENT_KEY.test(value)) throw new TypeError('eventKey must be canonical')
  const gid = String(providerIds?.gid ?? '').trim()
  if (gid && value !== `crown|football|gid=${gid}`) {
    throw new TypeError('eventKey must match providerIds.gid')
  }
  return value
}

function normalizedKey(key) {
  return String(key).replaceAll(/[-_]/g, '').toLowerCase()
}

function safeJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) throw new TypeError('normalized JSON must not be cyclic')
  seen.add(value)

  let result
  if (Array.isArray(value)) {
    result = value.map((item) => safeJsonValue(item, seen) ?? null)
  } else {
    result = {}
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.has(normalizedKey(key))) continue
      const safe = safeJsonValue(item, seen)
      if (safe !== undefined) result[key] = safe
    }
  }
  seen.delete(value)
  return result
}

function assertCandidateSafe(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) throw new TypeError('candidate payload must not be cyclic')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertCandidateSafe(item, seen)
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizedKey(key)
      if (SENSITIVE_KEY.has(normalized)) throw new TypeError(`candidate payload contains sensitive transport key:${key}`)
      if (RAW_TRANSPORT_KEY.has(normalized)) throw new TypeError(`candidate payload contains raw transport key:${key}`)
      assertCandidateSafe(item, seen)
    }
  }
  seen.delete(value)
}

function normalizedCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('candidate is required')
  assertCandidateSafe(candidate)
  if (candidate.schemaVersion !== 2) throw new TypeError('candidate.schemaVersion must be 2')
  const signalId = requiredString(candidate.signalId, 'candidate.signalId')
  if (!/^[a-f0-9]{64}$/.test(signalId)) throw new TypeError('candidate.signalId must be a SHA-256 hash')
  const bettingRuleId = candidate.bettingRuleId === null || candidate.bettingRuleId === undefined
    ? null
    : requiredString(candidate.bettingRuleId, 'candidate.bettingRuleId')
  const candidateId = requiredString(candidate.candidateId, 'candidate.candidateId')
  const expected = createHash('sha256').update(`${signalId}|${bettingRuleId || 'unbound'}`).digest('hex')
  if (candidateId !== expected) throw new TypeError('candidate.candidateId must match signal and betting rule binding')
  const status = requiredString(candidate.status, 'candidate.status')
  if (!CANDIDATE_STATUSES.has(status)) throw new TypeError('candidate.status must be eligible or skipped')
  const createdAt = requiredCanonicalTimestamp(candidate.createdAt, 'candidate.createdAt')
  const payload = safeJsonValue(candidate)
  return { candidateId, signalId, status, createdAt, payload }
}

function selectedFields(input, fields) {
  const selected = {}
  for (const key of fields) {
    if (Object.hasOwn(input, key)) selected[key] = input[key]
  }
  return safeJsonValue(selected)
}

function normalizedEvent(event) {
  return selectedFields(event, EVENT_FIELDS)
}

function normalizedSnapshot(record) {
  const selected = { schemaVersion: 2, ...selectedFields(record, SNAPSHOT_FIELDS) }
  if (selected.source) selected.source = selectedFields(selected.source, SOURCE_FIELDS)
  if (selected.event) selected.event = normalizedEvent(selected.event)
  if (selected.market) selected.market = selectedFields(selected.market, MARKET_FIELDS)
  if (selected.selection) selected.selection = selectedFields(selected.selection, SELECTION_FIELDS)
  const marketIdentity = canonicalMarketIdentity(record)
  const selectionIdentity = canonicalSelectionIdentity(record)
  if (selected.market && marketIdentity) selected.market.marketIdentity = marketIdentity
  if (selected.selection && selectionIdentity) selected.selection.selectionIdentity = selectionIdentity
  return selected
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parsedScopeEvents(value) {
  const parsed = parseJson(value, [])
  if (Array.isArray(parsed)) return { active: parsed, missing: {}, lastSeen: {}, removedAt: {} }
  if (!parsed || typeof parsed !== 'object') return { active: [], missing: {}, lastSeen: {}, removedAt: {} }
  const active = Array.isArray(parsed.active) ? parsed.active : []
  const missing = parsed.missing && typeof parsed.missing === 'object' && !Array.isArray(parsed.missing)
    ? parsed.missing
    : {}
  const lastSeen = parsed.lastSeen && typeof parsed.lastSeen === 'object' && !Array.isArray(parsed.lastSeen)
    ? parsed.lastSeen
    : {}
  const removedAt = parsed.removedAt && typeof parsed.removedAt === 'object' && !Array.isArray(parsed.removedAt)
    ? parsed.removedAt
    : {}
  return { active, missing, lastSeen, removedAt }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value ?? null
}

function factsEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function currentSource(record, batch) {
  const source = record?.source ?? batch?.source ?? (batch?.endpointKind ? { endpointKind: batch.endpointKind } : null)
  return source ? selectedFields(source, SOURCE_FIELDS) : null
}

function currentWarnings(record, batch) {
  if (Array.isArray(record?.warnings)) return safeJsonValue(record.warnings)
  if (Array.isArray(batch?.warnings)) return safeJsonValue(batch.warnings)
  return []
}

function currentConfidence(record, batch) {
  return record?.source?.confidence ?? record?.identityConfidence ?? batch?.source?.confidence ?? 'unknown'
}

function changeId(change) {
  return createHash('sha256').update(JSON.stringify(stableValue({
    type: change.type,
    batchId: change.batchId,
    eventKey: change.event?.eventKey ?? null,
    marketIdentity: change.market?.marketIdentity ?? null,
    selectionIdentity: change.selection?.selectionIdentity ?? null,
    old: change.old,
    next: change.next,
  }))).digest('hex')
}

function factualChange({ type, batch, record, old = null, next = null, event = null }) {
  const eventValue = record?.event ?? event ?? next?.event ?? old?.event ?? null
  const market = record?.market ?? next?.market ?? old?.market ?? null
  const selection = record?.selection ?? next?.selection ?? old?.selection ?? null
  const canonicalMarket = record ? canonicalMarketIdentity(record) : null
  const canonicalSelection = record ? canonicalSelectionIdentity(record) : null
  const change = {
    schemaVersion: 2,
    type,
    batchId: batch.batchId,
    pollId: batch.pollId,
    scopeKey: batch.scopeKey,
    observedAt: batch.capturedAt,
    source: currentSource(record ?? event, batch),
    old,
    next,
    event: eventValue ? normalizedEvent(eventValue) : null,
    market: market ? selectedFields(market, MARKET_FIELDS) : null,
    selection: selection ? selectedFields(selection, SELECTION_FIELDS) : null,
    eventIdentity: eventValue?.eventKey ?? null,
    marketIdentity: canonicalMarket ?? market?.marketIdentity ?? null,
    selectionIdentity: canonicalSelection ?? selection?.selectionIdentity ?? null,
    confidence: currentConfidence(record ?? event, batch),
    warnings: currentWarnings(record ?? event, batch),
  }
  return { ...change, changeId: changeId(change) }
}

function auditSnapshot(batch, snapshot) {
  const selectionIdentity = snapshot?.selection?.selectionIdentity ?? null
  const hash = createHash('sha256').update(JSON.stringify(stableValue({
    kind: 'snapshot',
    batchId: batch.batchId,
    selectionIdentity,
    snapshot,
  }))).digest('hex')
  return {
    ...snapshot,
    auditId: `snapshot:${hash}`,
    batchId: batch.batchId,
    pollId: batch.pollId,
    scopeKey: batch.scopeKey,
    observedAt: batch.capturedAt,
  }
}

function auditChange(change) {
  return {
    ...change,
    auditId: `change:${change.changeId}`,
  }
}

function mapScope(row) {
  if (!row) return null
  const eventState = parsedScopeEvents(row.event_keys_json)
  return {
    scopeKey: row.scope_key,
    lastBatchId: row.last_batch_id,
    lastCapturedAt: row.last_captured_at,
    lastCompleteAt: row.last_complete_at,
    eventKeys: eventState.active,
    missingCounts: eventState.missing,
    lastSeen: eventState.lastSeen,
    removedAt: eventState.removedAt,
  }
}

function mapEvent(row) {
  if (!row) return null
  return {
    eventKey: row.event_key,
    matchGroupKey: row.match_group_key,
    active: row.active === 1,
    missingCount: row.missing_count,
    lastSeenAt: row.last_seen_at,
    providerIds: parseJson(row.provider_ids_json, {}),
    event: parseJson(row.event_json, {}),
  }
}

function mapSelection(row) {
  if (!row) return null
  return {
    selectionIdentity: row.selection_identity,
    eventKey: row.event_key,
    capturedAt: row.captured_at,
    snapshot: parseJson(row.snapshot_json, {}),
  }
}

function scopeLifecycleAt(scope, eventKey) {
  const timestamps = []
  if (scope.eventKeys.includes(eventKey)) timestamps.push(scope.lastSeen[eventKey] ?? scope.lastCompleteAt)
  if (scope.removedAt[eventKey]) timestamps.push(scope.removedAt[eventKey])
  return timestamps.reduce((latest, value) => {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest
  }, Number.NEGATIVE_INFINITY)
}

function normalizedEventInput(input) {
  const providerIds = safeJsonValue(input?.providerIds ?? input?.ids ?? {})
  const eventKey = assertCanonicalEventKey(input?.eventKey, providerIds)
  return {
    eventKey,
    matchGroupKey: typeof input?.matchGroupKey === 'string' && input.matchGroupKey.trim() ? input.matchGroupKey : null,
    providerIds,
    event: normalizedEvent(input),
  }
}

function deliveryChannels(signal) {
  const input = signal.channels ?? signal.deliveryChannels
  if (!Array.isArray(input)) throw new TypeError('signal channels must be an array')
  if (input.length === 0) throw new TypeError('signal channels must not be empty')
  const channels = input.map((channel) => {
    if (typeof channel !== 'string') throw new TypeError('channel must be a string')
    const normalized = channel.trim()
    if (!normalized) throw new TypeError('channel must be a non-empty string')
    if (!DELIVERY_CHANNELS.has(normalized)) throw new TypeError(`unsupported signal channel:${normalized}`)
    return normalized
  })
  return [...new Set(channels)]
}

export class MonitorStateStore {
  constructor({ db, close = null } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
      throw new TypeError('db is required')
    }
    this.db = db
    this.closeDatabase = typeof close === 'function' ? close : null
    this.closed = false
  }

  assertOpen() {
    if (this.closed) throw new Error('monitor state store is closed')
  }

  getScope(scopeKey) {
    this.assertOpen()
    return mapScope(this.db.prepare('SELECT * FROM monitor_scope_state WHERE scope_key = ?').get(scopeKey))
  }

  getEvent(eventKey) {
    this.assertOpen()
    return mapEvent(this.db.prepare('SELECT * FROM monitor_event_state WHERE event_key = ?').get(eventKey))
  }

  getSelection(selectionIdentity) {
    this.assertOpen()
    return mapSelection(this.db.prepare('SELECT * FROM monitor_selection_state WHERE selection_identity = ?').get(selectionIdentity))
  }

  findLatestSelection({ provider = 'crown', eventKey, period, marketType, lineKey, side } = {}) {
    this.assertOpen()
    if (provider !== 'crown') return null
    for (const [value, name] of [[eventKey, 'eventKey'], [period, 'period'], [marketType, 'marketType'], [lineKey, 'lineKey'], [side, 'side']]) {
      requiredString(value, name)
    }
    if (!CANONICAL_EVENT_KEY.test(eventKey)) return null
    return this.getSelection(`${eventKey}|${period}|${marketType}|${lineKey}|${side}`)?.snapshot ?? null
  }

  getSignal(signalId) {
    this.assertOpen()
    const row = this.db.prepare('SELECT payload_json FROM monitor_signals WHERE signal_id = ?').get(signalId)
    return row ? parseJson(row.payload_json, {}) : null
  }

  getCooldown(signalKey) {
    this.assertOpen()
    const row = this.db.prepare('SELECT signal_key, expires_at FROM monitor_cooldowns WHERE signal_key = ?').get(signalKey)
    return row ? { signalKey: row.signal_key, expiresAt: row.expires_at } : null
  }

  countSignals() {
    this.assertOpen()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM monitor_signals').get().count)
  }

  countCooldowns() {
    this.assertOpen()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM monitor_cooldowns').get().count)
  }

  countDeliveries() {
    this.assertOpen()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM monitor_deliveries').get().count)
  }

  getCandidate(candidateId) {
    this.assertOpen()
    const row = this.db.prepare('SELECT payload_json FROM monitor_candidates WHERE candidate_id = ?').get(candidateId)
    return row ? parseJson(row.payload_json, {}) : null
  }

  countCandidates() {
    this.assertOpen()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM monitor_candidates').get().count)
  }

  listSignalsWithoutCandidates({ limit = 100 } = {}) {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    return this.db.prepare(`
      SELECT s.payload_json
      FROM monitor_signals s
      LEFT JOIN monitor_candidates c ON c.signal_id = s.signal_id
      WHERE c.signal_id IS NULL
      ORDER BY s.observed_at, s.signal_id
      LIMIT ?
    `).all(limit).map((row) => parseJson(row.payload_json, {}))
  }

  insertCandidate(candidate) {
    this.assertOpen()
    const normalized = normalizedCandidate(candidate)
    const encoded = JSON.stringify(normalized.payload)
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO monitor_candidates (
        candidate_id, signal_id, status, export_status, created_at, exported_at, payload_json
      ) VALUES (?, ?, ?, 'pending', ?, '', ?)
    `).run(normalized.candidateId, normalized.signalId, normalized.status, normalized.createdAt, encoded)
    if (result.changes === 1) return { inserted: true, candidateId: normalized.candidateId }
    const existing = this.db.prepare('SELECT payload_json FROM monitor_candidates WHERE candidate_id = ?').get(normalized.candidateId)
    if (!existing) throw new Error('monitor candidate insert was ignored without an existing row')
    if (!factsEqual(parseJson(existing.payload_json, {}), normalized.payload)) {
      throw new TypeError(`monitor candidate ID collision:${normalized.candidateId}`)
    }
    return { inserted: false, candidateId: normalized.candidateId, reason: 'duplicate' }
  }

  listPendingCandidateExports({ limit = 100 } = {}) {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    return this.db.prepare(`
      SELECT payload_json FROM monitor_candidates
      WHERE export_status = 'pending'
      ORDER BY created_at, candidate_id
      LIMIT ?
    `).all(limit).map((row) => parseJson(row.payload_json, {}))
  }

  markCandidateExportsDelivered(candidateIds, { exportedAt = new Date().toISOString() } = {}) {
    this.assertOpen()
    if (!Array.isArray(candidateIds)) throw new TypeError('candidateIds must be an array')
    requiredCanonicalTimestamp(exportedAt, 'exportedAt')
    const ids = [...new Set(candidateIds.map((candidateId) => requiredString(candidateId, 'candidateId')))]
    if (!ids.length) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.db.prepare(`
        UPDATE monitor_candidates
        SET export_status = 'exported', exported_at = ?
        WHERE candidate_id = ? AND export_status = 'pending'
      `)
      const select = this.db.prepare('SELECT export_status FROM monitor_candidates WHERE candidate_id = ?')
      let delivered = 0
      for (const candidateId of ids) {
        const changed = Number(update.run(exportedAt, candidateId).changes || 0)
        if (changed === 1) {
          delivered += 1
          continue
        }
        const row = select.get(candidateId)
        if (row?.export_status === 'exported') {
          delivered += 1
          continue
        }
        throw new Error(`monitor candidate export acknowledgement failed:${candidateId}`)
      }
      this.db.exec('COMMIT')
      return delivered
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  applyBatch(batch) {
    this.assertOpen()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (batch?.schemaVersion !== 2) throw new TypeError('schemaVersion must be 2')
      const batchId = requiredString(batch.batchId, 'batchId')
      requiredString(batch.pollId, 'pollId')
      const scopeKey = requiredString(batch.scopeKey, 'scopeKey')
      const capturedAt = requiredTimestamp(batch.capturedAt, 'capturedAt')
      if (!Array.isArray(batch.eventRefs)) throw new TypeError('eventRefs must be an array')
      if (!Array.isArray(batch.oddsRecords)) throw new TypeError('oddsRecords must be an array')

      const normalizedEventRefs = batch.eventRefs.map((eventRef) => ({
        input: eventRef,
        normalized: normalizedEventInput(eventRef),
      }))
      const normalizedRecords = batch.oddsRecords.map((record) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new TypeError('selection row must be an object')
        }
        const event = normalizedEventInput(record.event)
        const identity = canonicalSelectionIdentity(record)
        if (!identity) throw new TypeError('selectionIdentity must be canonical')
        for (const suppliedIdentity of [record.selectionIdentity, record.selection?.selectionIdentity]) {
          if (suppliedIdentity !== undefined && suppliedIdentity !== identity) {
            throw new TypeError('selectionIdentity must match the canonical identity')
          }
        }
        const selectionCapturedAt = record.capturedAt ?? capturedAt
        requiredTimestamp(selectionCapturedAt, 'selection capturedAt')
        return {
          input: record,
          event,
          identity,
          capturedAt: selectionCapturedAt,
          snapshot: normalizedSnapshot(record),
        }
      })

      if (batch.complete !== true) {
        this.db.exec('ROLLBACK')
        return {
          applied: false,
          status: 'incomplete',
          batch,
          changes: [],
          snapshots: [],
          observedEventKeys: [],
        }
      }

      const authoritativeComplete = batch.completeness === 'authoritative'
      const authoritativeScopes = authoritativeComplete
        ? this.db.prepare("SELECT * FROM monitor_scope_state WHERE last_complete_at <> ''").all().map(mapScope)
        : []
      const existingScope = authoritativeScopes.find((scope) => scope.scopeKey === scopeKey) ?? null
      if (authoritativeComplete && existingScope && Date.parse(capturedAt) <= Date.parse(existingScope.lastCapturedAt)) {
        this.db.exec('ROLLBACK')
        return {
          applied: false,
          status: 'stale_batch',
          batch,
          changes: [],
          snapshots: [],
          observedEventKeys: [],
        }
      }

      const authoritativeEventKeys = new Set()
      if (authoritativeComplete) {
        for (const { normalized } of normalizedEventRefs) {
          const eventKey = normalized.eventKey
          const alreadyActiveInScope = existingScope?.eventKeys.includes(eventKey) ?? false
          const latestOtherLifecycleAt = authoritativeScopes
            .filter((scope) => scope.scopeKey !== scopeKey)
            .reduce((latest, scope) => Math.max(latest, scopeLifecycleAt(scope, eventKey)), Number.NEGATIVE_INFINITY)
          if (alreadyActiveInScope || Date.parse(capturedAt) >= latestOtherLifecycleAt) {
            authoritativeEventKeys.add(eventKey)
          }
        }
      }
      const observedEventKeys = new Set()
      const snapshots = []
      const changes = []
      for (const { input: eventRef, normalized } of normalizedEventRefs) {
        observedEventKeys.add(normalized.eventKey)
        const activeInScope = existingScope?.eventKeys.includes(normalized.eventKey) ?? false
        const lifecycleObserved = authoritativeEventKeys.has(normalized.eventKey)
        if (authoritativeComplete && lifecycleObserved && !activeInScope) {
          changes.push(factualChange({
            type: 'event-added',
            batch,
            event: eventRef,
            next: { capturedAt, event: normalized.event },
          }))
        }
        this.upsertEvent(normalized, capturedAt, { authoritative: authoritativeComplete && lifecycleObserved })
      }

      for (const row of normalizedRecords) {
        const { input: record, event, identity, capturedAt: selectionCapturedAt, snapshot } = row
        observedEventKeys.add(event.eventKey)
        const previousRow = this.getSelection(identity)
        if (previousRow && Date.parse(selectionCapturedAt) <= Date.parse(previousRow.capturedAt)) continue
        this.upsertEvent(event, selectionCapturedAt, { authoritative: false })
        const previous = previousRow?.snapshot ?? null
        if (previous) {
          const oldOdds = { raw: previous.selection?.oddsRaw ?? null, value: previous.selection?.odds ?? null }
          const nextOdds = { raw: snapshot.selection?.oddsRaw ?? null, value: snapshot.selection?.odds ?? null }
          const oldHandicap = { raw: previous.market?.handicapRaw ?? null, value: previous.market?.handicap ?? null }
          const nextHandicap = { raw: snapshot.market?.handicapRaw ?? null, value: snapshot.market?.handicap ?? null }
          const wasSuspended = Boolean(previous.selection?.suspended)
          const isSuspended = Boolean(snapshot.selection?.suspended)
          if (!factsEqual(oldOdds, nextOdds) && !isSuspended) {
            changes.push(factualChange({ type: 'odds-change', batch, record, old: previous, next: snapshot }))
          }
          if (!factsEqual(oldHandicap, nextHandicap)) {
            changes.push(factualChange({ type: 'handicap-change', batch, record, old: previous, next: snapshot }))
          }
          if (!wasSuspended && isSuspended) {
            changes.push(factualChange({ type: 'market-suspended', batch, record, old: previous, next: snapshot }))
          }
          if (wasSuspended && !isSuspended) {
            changes.push(factualChange({ type: 'market-reopened', batch, record, old: previous, next: snapshot }))
          }
        }
        this.db.prepare(`
          INSERT INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(selection_identity) DO UPDATE SET
            event_key = excluded.event_key,
            captured_at = excluded.captured_at,
            snapshot_json = excluded.snapshot_json
        `).run(identity, event.eventKey, selectionCapturedAt, JSON.stringify(snapshot))
        snapshots.push(snapshot)
      }

      if (!authoritativeComplete) {
        this.enqueueAuditFacts(batch, snapshots, changes)
        this.db.exec('COMMIT')
        return { applied: true, status: 'applied', batch, changes, snapshots, observedEventKeys: [...observedEventKeys].sort() }
      }

      let eventKeys = existingScope?.eventKeys ?? []
      const missingCounts = { ...(existingScope?.missingCounts ?? {}) }
      const lastSeen = { ...(existingScope?.lastSeen ?? {}) }
      const removedAt = { ...(existingScope?.removedAt ?? {}) }
      const nextActiveEventKeys = new Set(authoritativeEventKeys)
      for (const eventKey of authoritativeEventKeys) {
        delete missingCounts[eventKey]
        lastSeen[eventKey] = capturedAt
        delete removedAt[eventKey]
      }
      for (const eventKey of existingScope?.eventKeys ?? []) {
        if (authoritativeEventKeys.has(eventKey)) continue
        const existing = this.getEvent(eventKey)
        if (!existing) continue
        const missingCount = Number(missingCounts[eventKey] ?? 0) + 1
        if (missingCount >= 2) {
          delete missingCounts[eventKey]
          removedAt[eventKey] = capturedAt
          changes.push(factualChange({
            type: 'event-removed',
            batch,
            event: existing.event,
            old: {
              capturedAt: lastSeen[eventKey] ?? existingScope?.lastCompleteAt ?? existing.lastSeenAt,
              event: existing.event,
              active: true,
              missingCount: missingCount - 1,
            },
            next: {
              capturedAt,
              event: existing.event,
              active: false,
              missingCount,
            },
          }))
        } else {
          missingCounts[eventKey] = missingCount
          nextActiveEventKeys.add(eventKey)
        }
      }
      eventKeys = [...nextActiveEventKeys].sort()
      const lastCompleteAt = capturedAt
      this.db.prepare(`
        INSERT INTO monitor_scope_state (
          scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          last_batch_id = excluded.last_batch_id,
          last_captured_at = excluded.last_captured_at,
          last_complete_at = excluded.last_complete_at,
          event_keys_json = excluded.event_keys_json
      `).run(scopeKey, batchId, capturedAt, lastCompleteAt, JSON.stringify({
        active: eventKeys,
        missing: missingCounts,
        lastSeen,
        removedAt,
      }))
      const nextScope = {
        scopeKey,
        lastBatchId: batchId,
        lastCapturedAt: capturedAt,
        lastCompleteAt,
        eventKeys,
        missingCounts,
        lastSeen,
        removedAt,
      }
      const rollupScopes = authoritativeScopes.filter((scope) => scope.scopeKey !== scopeKey)
      rollupScopes.push(nextScope)
      this.refreshEventRollups(new Set([
        ...observedEventKeys,
        ...(existingScope?.eventKeys ?? []),
        ...eventKeys,
        ...Object.keys(missingCounts),
        ...Object.keys(removedAt),
      ]), rollupScopes)

      this.enqueueAuditFacts(batch, snapshots, changes)
      this.db.exec('COMMIT')
      return { applied: true, status: 'applied', batch, changes, snapshots, observedEventKeys: [...observedEventKeys].sort() }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertEvent(input, capturedAt, { authoritative = false } = {}) {
    const existing = this.getEvent(input.eventKey)
    const providerIds = Object.keys(input.providerIds).length > 0 ? input.providerIds : existing?.providerIds ?? {}
    const event = safeJsonValue({ ...(existing?.event ?? {}), ...input.event, providerIds })
    const matchGroupKey = input.matchGroupKey ?? existing?.matchGroupKey ?? null
    if (!existing) {
      this.db.prepare(`
        INSERT INTO monitor_event_state (
          event_key, match_group_key, active, missing_count, last_seen_at, provider_ids_json, event_json
        ) VALUES (?, ?, ?, 0, ?, ?, ?)
      `).run(
        input.eventKey,
        matchGroupKey,
        authoritative ? 1 : 0,
        capturedAt,
        JSON.stringify(providerIds),
        JSON.stringify(event),
      )
      return
    }

    if (authoritative && !existing.active) {
      this.db.prepare('UPDATE monitor_event_state SET active = 1 WHERE event_key = ?').run(input.eventKey)
    }
    if (Date.parse(capturedAt) <= Date.parse(existing.lastSeenAt)) return
    this.db.prepare(`
      UPDATE monitor_event_state
      SET match_group_key = ?, last_seen_at = ?, provider_ids_json = ?, event_json = ?
      WHERE event_key = ?
    `).run(
      matchGroupKey,
      capturedAt,
      JSON.stringify(providerIds),
      JSON.stringify(event),
      input.eventKey,
    )
  }

  refreshEventRollups(eventKeys, scopeStates) {
    if (!eventKeys.size) return
    const update = this.db.prepare(`
      UPDATE monitor_event_state SET active = ?, missing_count = ? WHERE event_key = ?
    `)
    for (const eventKey of eventKeys) {
      let active = false
      let missingCount = 0
      for (const scope of scopeStates) {
        if (scope.eventKeys.includes(eventKey)) active = true
        const scopedMissing = Number(scope.missingCounts[eventKey] ?? 0)
        if (Number.isFinite(scopedMissing)) missingCount = Math.max(missingCount, scopedMissing)
      }
      update.run(active ? 1 : 0, missingCount, eventKey)
    }
  }

  enqueueAuditFacts(batch, snapshots, changes) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO monitor_audit_outbox (
        fact_id, fact_kind, batch_id, status, payload_json, created_at, delivered_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, '')
    `)
    for (const payload of snapshots.map((snapshot) => auditSnapshot(batch, snapshot))) {
      insert.run(payload.auditId, 'snapshot', batch.batchId, JSON.stringify(payload), batch.capturedAt)
    }
    for (const payload of changes.map(auditChange)) {
      insert.run(payload.auditId, 'change', batch.batchId, JSON.stringify(payload), batch.capturedAt)
    }
  }

  listPendingAuditFacts({ limit = 1000 } = {}) {
    this.assertOpen()
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    return this.db.prepare(`
      SELECT fact_id, fact_kind, batch_id, payload_json, created_at
      FROM monitor_audit_outbox
      WHERE status = 'pending'
      ORDER BY created_at, fact_id
      LIMIT ?
    `).all(limit).map((row) => ({
      factId: row.fact_id,
      kind: row.fact_kind,
      batchId: row.batch_id,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
    }))
  }

  markAuditFactsDelivered(factIds, { deliveredAt = new Date().toISOString() } = {}) {
    this.assertOpen()
    if (!Array.isArray(factIds)) throw new TypeError('factIds must be an array')
    requiredTimestamp(deliveredAt, 'deliveredAt')
    const ids = [...new Set(factIds.map((factId) => requiredString(factId, 'factId')))]
    if (!ids.length) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.db.prepare(`
        UPDATE monitor_audit_outbox
        SET status = 'delivered', delivered_at = ?
        WHERE fact_id = ? AND status = 'pending'
      `)
      let delivered = 0
      const remove = this.db.prepare(`
        DELETE FROM monitor_audit_outbox
        WHERE fact_id = ? AND status = 'delivered'
      `)
      for (const factId of ids) {
        const changed = Number(update.run(deliveredAt, factId).changes || 0)
        delivered += changed
        if (changed) remove.run(factId)
      }
      this.db.exec('COMMIT')
      return delivered
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  insertSignal(signal, { cleanupLimit = 100, availableLeagueNames = null } = {}) {
    return this.insertSignals([signal], {
      cleanupLimit,
      catalogReader: () => availableLeagueNames,
    })[0]
  }

  insertSignals(signals, { cleanupLimit = 100, catalogReader } = {}) {
    this.assertOpen()
    if (!Array.isArray(signals) || signals.length === 0) throw new TypeError('signals must be a non-empty array')
    if (typeof catalogReader !== 'function') throw new TypeError('catalogReader is required')
    if (!Number.isInteger(cleanupLimit) || cleanupLimit < 1) throw new TypeError('cleanupLimit must be a positive integer')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const availableLeagueNames = catalogReader()
      if (availableLeagueNames !== null && !(availableLeagueNames instanceof Set)) {
        throw new TypeError('catalogReader must return a Set or null')
      }
      const results = signals.map((signal) => this.#insertSignalInTransaction(signal, {
        cleanupLimit,
        availableLeagueNames,
      }))
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  #insertSignalInTransaction(signal, { cleanupLimit, availableLeagueNames }) {
    const payload = normalizeSignalForPersistence(signal)
    const signalId = payload.signalId
    const signalKey = payload.signalKey
    const strategyId = payload.strategyId
    const status = payload.status
    const observedAt = payload.observedAt
    const expiresAt = payload.expiresAt
    const channels = deliveryChannels(signal)
    const duplicate = this.db.prepare('SELECT 1 AS found FROM monitor_signals WHERE signal_id = ?').get(signalId)
    if (duplicate) {
      this.deleteExpiredCooldowns(observedAt, cleanupLimit)
      return { inserted: false, reason: 'duplicate', signalId }
    }

    this.deleteExpiredCooldowns(observedAt, cleanupLimit)
    const cooldown = this.db.prepare(`
      SELECT expires_at FROM monitor_cooldowns
      WHERE signal_key = ? AND expires_at > ?
    `).get(signalKey, observedAt)
    if (cooldown) {
      return {
        inserted: false,
        reason: 'cooldown_active',
        signalId,
        signalKey,
        cooldownExpiresAt: cooldown.expires_at,
      }
    }

    const cardSnapshot = matchEnabledRuleCardForSignal(this.db, payload, { availableLeagueNames })

    const result = this.db.prepare(`
      INSERT INTO monitor_signals (
        signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(signalId, signalKey, strategyId, payload.strategyVersion, status, observedAt, expiresAt, JSON.stringify(payload))
    if (result.changes !== 1) throw new Error('monitor signal insert did not write exactly one row')
    const insertDelivery = this.db.prepare(`
      INSERT INTO monitor_deliveries (
        signal_id, channel, status, attempts, next_attempt_at, last_error_code, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, '', ?)
    `)
    for (const channel of channels) {
      const deliveryResult = insertDelivery.run(signalId, channel, observedAt, observedAt)
      if (deliveryResult.changes !== 1) {
        throw new Error(`monitor delivery insert did not write exactly one row:${channel}`)
      }
    }
    if (cardSnapshot) {
      const inboxResult = this.db.prepare(`
        INSERT INTO auto_betting_signal_inbox (
          signal_id, card_id, card_version, card_snapshot_json,
          mode, settings_version, settings_snapshot_json, status, skip_reason, attempts,
          next_attempt_at, lease_owner, lease_expires_at, batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', 0, ?, '', '', NULL, ?, ?)
      `).run(
        signalId,
        cardSnapshot.cardId,
        cardSnapshot.version,
        JSON.stringify(cardSnapshot),
        payload.evidence.mode,
        cardSnapshot.version,
        JSON.stringify(cardSnapshot),
        observedAt,
        observedAt,
        observedAt,
      )
      if (inboxResult.changes !== 1) throw new Error('auto betting signal inbox insert did not write exactly one row')
    }
    const cooldownResult = this.db.prepare(`
      INSERT INTO monitor_cooldowns (signal_key, expires_at)
      VALUES (?, ?)
      ON CONFLICT(signal_key) DO UPDATE SET expires_at = excluded.expires_at
    `).run(signalKey, expiresAt)
    if (cooldownResult.changes !== 1) {
      throw new Error('monitor cooldown insert did not write exactly one row')
    }
    return { inserted: true, reason: null, signalId }
  }

  deleteExpiredCooldowns(now, limit) {
    return Number(this.db.prepare(`
      DELETE FROM monitor_cooldowns
      WHERE signal_key IN (
        SELECT signal_key FROM monitor_cooldowns
        WHERE expires_at <= ?
        ORDER BY expires_at, signal_key
        LIMIT ?
      )
    `).run(now, limit).changes || 0)
  }

  claimPendingDeliveries({ now, limit = 100, leaseMs = 30_000 } = {}) {
    this.assertOpen()
    requiredCanonicalTimestamp(now, 'now')
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer')
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const candidates = this.db.prepare(`
        SELECT signal_id, channel, status, attempts, next_attempt_at, updated_at
        FROM monitor_deliveries
        WHERE status IN ('pending', 'retry', 'dispatching') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, updated_at, signal_id, channel
        LIMIT ?
      `).all(now, limit)
      const update = this.db.prepare(`
        UPDATE monitor_deliveries
        SET status = 'dispatching', next_attempt_at = ?, updated_at = ?
        WHERE signal_id = ? AND channel = ?
          AND status = ? AND attempts = ? AND next_attempt_at = ? AND updated_at = ?
      `)
      const claimedKeys = []
      for (const row of candidates) {
        const result = update.run(
          leaseExpiresAt,
          now,
          row.signal_id,
          row.channel,
          row.status,
          row.attempts,
          row.next_attempt_at,
          row.updated_at,
        )
        if (result.changes === 1) claimedKeys.push([row.signal_id, row.channel])
      }
      const select = this.db.prepare(`
        SELECT d.*, s.payload_json
        FROM monitor_deliveries d
        JOIN monitor_signals s ON s.signal_id = d.signal_id
        WHERE d.signal_id = ? AND d.channel = ? AND d.status = 'dispatching'
      `)
      const claimed = claimedKeys.map(([signalId, channel]) => select.get(signalId, channel)).filter(Boolean).map((row) => ({
        signalId: row.signal_id,
        channel: row.channel,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastErrorCode: row.last_error_code,
        updatedAt: row.updated_at,
        claimToken: row.updated_at,
        signal: parseJson(row.payload_json, {}),
      }))
      this.db.exec('COMMIT')
      return claimed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeDelivery({ signalId, channel, status, attempts, errorCode = '', nextAttemptAt, updatedAt, claimToken } = {}) {
    this.assertOpen()
    requiredString(signalId, 'signalId')
    requiredString(channel, 'channel')
    requiredString(status, 'status')
    if (!DELIVERY_FINAL_STATUSES.has(status)) throw new TypeError('status must be retry, sent, or dead-letter')
    requiredCanonicalTimestamp(nextAttemptAt, 'nextAttemptAt')
    const row = this.db.prepare(`
      SELECT status, attempts, updated_at FROM monitor_deliveries WHERE signal_id = ? AND channel = ?
    `).get(signalId, channel)
    if (!row) throw new Error('monitor delivery not found')
    if (row.status !== 'dispatching') throw new Error('monitor delivery is not claimed')
    requiredCanonicalTimestamp(claimToken, 'claimToken')
    if (row.updated_at !== claimToken) throw new Error('monitor delivery claim is stale')
    const nextAttempts = attempts === undefined ? row.attempts + 1 : attempts
    if (!Number.isInteger(nextAttempts) || nextAttempts !== row.attempts + 1) {
      throw new TypeError('attempts must increment the claimed delivery exactly once')
    }
    const savedUpdatedAt = updatedAt ?? new Date().toISOString()
    requiredCanonicalTimestamp(savedUpdatedAt, 'updatedAt')
    const savedErrorCode = String(errorCode ?? '')
    if (status === 'sent' && savedErrorCode !== '') throw new TypeError('sent delivery cannot retain an error code')
    if (savedErrorCode && (!DELIVERY_ERROR_CODE.test(savedErrorCode) || SENSITIVE_ERROR_CODE.test(savedErrorCode))) {
      throw new TypeError('errorCode must be a sanitized stable code')
    }
    const result = this.db.prepare(`
      UPDATE monitor_deliveries
      SET status = ?, attempts = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
      WHERE signal_id = ? AND channel = ? AND status = 'dispatching' AND attempts = ? AND updated_at = ?
    `).run(status, nextAttempts, nextAttemptAt, savedErrorCode, savedUpdatedAt, signalId, channel, row.attempts, claimToken)
    if (result.changes !== 1) throw new Error('monitor delivery completion lost its claim')
    return true
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.closeDatabase?.()
  }
}

export function openMonitorStateStore({ dbPath } = {}) {
  const handle = openAppDatabase({ dbPath })
  return new MonitorStateStore({ db: handle.db, close: () => handle.close() })
}
