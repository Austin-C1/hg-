import fs from 'node:fs'
import path from 'node:path'

import { evaluateChangeCandidate } from '../monitor/monitor-settings.mjs'

const CAPTURED_MARKET_TYPES = new Set(['asian_handicap', 'total'])
const DEFAULT_PRELOAD_BYTES = 64 * 1024 * 1024

function clean(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

function isCapturedMarket(record) {
  return CAPTURED_MARKET_TYPES.has(record?.market?.marketType)
}

export function stableEventKey(record) {
  return clean(record?.event?.eventKey, clean(record?.event?.eventId, 'unknown-event'))
}

export function stableMarketKey(record) {
  return clean(record?.market?.marketKey, clean(record?.market?.marketId, 'unknown-market'))
}

export function stableSelectionKey(record) {
  return [
    record?.provider || 'unknown',
    stableEventKey(record),
    stableMarketKey(record),
    clean(record?.selection?.selectionKey, clean(record?.selection?.selectionId, 'unknown-selection')),
  ].join('|')
}

export function stableSelectionIdentityKeyFromParts({
  provider = 'unknown',
  eventKey = 'unknown-event',
  period = 'unknown-period',
  marketType = 'unknown-market-type',
  lineKey = 'unknown-line',
  side = 'unknown-side',
} = {}) {
  return [
    provider || 'unknown',
    eventKey || 'unknown-event',
    period || 'unknown-period',
    marketType || 'unknown-market-type',
    lineKey || 'unknown-line',
    side || 'unknown-side',
  ].join('|')
}

function marketLineKey(record) {
  return clean(record?.market?.lineKey, clean(record?.market?.ratioField, 'unknown-line'))
}

function stableSelectionIdentityKey(record) {
  return stableSelectionIdentityKeyFromParts({
    provider: record?.provider || 'unknown',
    eventKey: stableEventKey(record),
    period: clean(record?.market?.period, 'unknown-period'),
    marketType: clean(record?.market?.marketType, 'unknown-market-type'),
    lineKey: marketLineKey(record),
    side: clean(record?.selection?.side, 'unknown-side'),
  })
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function appendJsonl(file, rows) {
  if (!rows.length) return
  ensureParent(file)
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

function readJsonl(file, { maxBytes = 0 } = {}) {
  if (!fs.existsSync(file)) return []
  let text = ''
  const limit = Number(maxBytes || 0)
  if (limit > 0) {
    const stat = fs.statSync(file)
    const size = Math.min(stat.size, limit)
    const start = stat.size - size
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size)
      fs.readSync(fd, buffer, 0, size, start)
      text = buffer.toString('utf8')
      if (start > 0) text = text.replace(/^[^\r\n]*(?:\r?\n|$)/, '')
    } finally {
      fs.closeSync(fd)
    }
  } else {
    text = fs.readFileSync(file, 'utf8')
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function oddsSnapshot(record) {
  return {
    odds: {
      raw: record?.selection?.oddsRaw ?? null,
      value: record?.selection?.odds ?? null,
      format: record?.selection?.oddsFormat || null,
      field: record?.selection?.oddsField || null,
    },
    handicap: {
      raw: record?.market?.handicapRaw ?? null,
      value: record?.market?.handicap ?? null,
      field: record?.market?.ratioField || null,
    },
    event: record?.event || null,
    market: {
      marketId: record?.market?.marketId || null,
      marketKey: record?.market?.marketKey || null,
      idScope: record?.market?.idScope || null,
      marketType: record?.market?.marketType || null,
      period: record?.market?.period || null,
      handicapRaw: record?.market?.handicapRaw ?? null,
      handicap: record?.market?.handicap ?? null,
      ratioField: record?.market?.ratioField || null,
      lineKey: record?.market?.lineKey || null,
      isMainMarket: record?.market?.isMainMarket ?? null,
    },
    selection: {
      selectionId: record?.selection?.selectionId || null,
      selectionKey: record?.selection?.selectionKey || null,
      idScope: record?.selection?.idScope || null,
      oddsId: record?.selection?.oddsId ?? null,
      side: record?.selection?.side || null,
      oddsRaw: record?.selection?.oddsRaw ?? null,
      odds: record?.selection?.odds ?? null,
      oddsField: record?.selection?.oddsField || null,
      oddsFormat: record?.selection?.oddsFormat || null,
      suspended: Boolean(record?.selection?.suspended),
    },
    mode: record?.mode || record?.event?.mode || null,
    source: record?.source || null,
    warnings: Array.isArray(record?.warnings) ? record.warnings : [],
    capturedAt: record?.capturedAt ?? null,
  }
}

function confidenceFor(record) {
  if (record?.source?.confidence) return record.source.confidence
  const warnings = Array.isArray(record?.warnings) ? record.warnings : []
  if (warnings.some((warning) => /^inferred-/.test(String(warning)) || /^local-/.test(String(warning)))) return 'low'
  return 'unknown'
}

function makeChange(type, key, record, previous, next) {
  return {
    type,
    key,
    capturedAt: record?.capturedAt || next?.capturedAt || previous?.capturedAt || new Date().toISOString(),
    mode: record?.mode || next?.mode || previous?.mode || null,
    source: record?.source || next?.source || previous?.source || null,
    confidence: confidenceFor(record || next || previous),
    warnings: Array.isArray(record?.warnings) ? record.warnings : (next?.warnings || previous?.warnings || []),
    old: previous,
    next,
    event: record?.event || next?.event || previous?.event || null,
    market: record?.market || next?.market || previous?.market || null,
    selection: record?.selection || next?.selection || previous?.selection || null,
  }
}

function attachCandidate(change, monitorSettings) {
  if (!monitorSettings || change?.type !== 'odds-change') return change
  const decision = evaluateChangeCandidate(change, { settings: monitorSettings })
  return {
    ...change,
    candidate: decision.candidate,
    candidateReason: decision.reason,
    monitorMode: decision.monitorMode,
    delta: decision.delta,
    direction: decision.direction,
    threshold: decision.threshold,
  }
}

function eventRepresentative(records) {
  const map = new Map()
  for (const record of records) {
    const key = stableEventKey(record)
    if (!map.has(key)) map.set(key, record)
  }
  return map
}

export class JsonlOddsStore {
  constructor({
    snapshotsPath = 'data/runtime/crown-odds-snapshots.jsonl',
    changesPath = 'data/runtime/crown-odds-changes.jsonl',
    preloadBytes = Number(process.env.CROWN_STORE_PRELOAD_BYTES || DEFAULT_PRELOAD_BYTES),
  } = {}) {
    this.snapshotsPath = snapshotsPath
    this.changesPath = changesPath
    this.preloadBytes = Number.isFinite(Number(preloadBytes)) ? Number(preloadBytes) : DEFAULT_PRELOAD_BYTES
    this.latest = new Map()
    this.latestByIdentity = new Map()
    this.activeEventKeys = new Set()
    this.eventSnapshots = new Map()
    this.ensureFiles()
    this.loadExistingSnapshots()
  }

  ensureFiles() {
    for (const file of [this.snapshotsPath, this.changesPath]) {
      ensureParent(file)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8')
    }
  }

  loadExistingSnapshots() {
    for (const record of readJsonl(this.snapshotsPath, { maxBytes: this.preloadBytes })) {
      if (!isCapturedMarket(record)) continue
      const snapshot = oddsSnapshot(record)
      this.latest.set(stableSelectionKey(record), snapshot)
      this.latestByIdentity.set(stableSelectionIdentityKey(record), snapshot)
      const eventKey = stableEventKey(record)
      this.activeEventKeys.add(eventKey)
      this.eventSnapshots.set(eventKey, snapshot)
    }
  }

  detectEventChanges(records) {
    if (!records.length) return []
    const changes = []
    const representatives = eventRepresentative(records)
    const currentEventKeys = new Set(representatives.keys())

    for (const [eventKey, record] of representatives.entries()) {
      if (!this.activeEventKeys.has(eventKey)) {
        const snapshot = oddsSnapshot(record)
        changes.push(makeChange('event-added', eventKey, record, null, snapshot))
      }
    }

    for (const eventKey of this.activeEventKeys) {
      if (currentEventKeys.has(eventKey)) continue
      const previous = this.eventSnapshots.get(eventKey) || null
      changes.push(makeChange('event-removed', eventKey, null, previous, null))
      for (const key of [...this.latest.keys()]) {
        const snapshot = this.latest.get(key)
        if (snapshot?.event?.eventKey === eventKey || snapshot?.event?.eventId === eventKey) this.latest.delete(key)
      }
      for (const [key, snapshot] of [...this.latestByIdentity.entries()]) {
        if (snapshot?.event?.eventKey === eventKey || snapshot?.event?.eventId === eventKey) this.latestByIdentity.delete(key)
      }
      this.eventSnapshots.delete(eventKey)
    }

    this.activeEventKeys = currentEventKeys
    return changes
  }

  detectSelectionChanges(records) {
    const changes = []
    for (const record of records) {
      const key = stableSelectionKey(record)
      const identityKey = stableSelectionIdentityKey(record)
      const previous = this.latestByIdentity.get(identityKey)
      const next = oddsSnapshot(record)

      if (previous) {
        if (previous.odds.raw !== next.odds.raw && !next.selection.suspended) {
          changes.push(makeChange('odds-change', key, record, previous, next))
        }
        if (previous.handicap.raw !== next.handicap.raw) {
          changes.push(makeChange('handicap-change', key, record, previous, next))
        }
        if (!previous.selection.suspended && next.selection.suspended) {
          changes.push(makeChange('market-suspended', key, record, previous, next))
        }
        if (previous.selection.suspended && !next.selection.suspended) {
          changes.push(makeChange('market-reopened', key, record, previous, next))
        }
      }

      this.latest.set(key, next)
      this.latestByIdentity.set(identityKey, next)
      this.eventSnapshots.set(stableEventKey(record), next)
    }
    return changes
  }

  detectChanges(records) {
    return [
      ...this.detectEventChanges(records),
      ...this.detectSelectionChanges(records),
    ]
  }

  findLatestSelection({ provider = 'crown', eventKey, period, marketType, lineKey = null, side } = {}) {
    const key = stableSelectionIdentityKeyFromParts({ provider, eventKey, period, marketType, lineKey: lineKey || 'unknown-line', side })
    const exact = this.latestByIdentity.get(key)
    if (exact || lineKey) return exact || null
    for (const snapshot of this.latestByIdentity.values()) {
      if (
        snapshot?.event?.eventKey === eventKey &&
        snapshot?.market?.period === period &&
        snapshot?.market?.marketType === marketType &&
        snapshot?.selection?.side === side
      ) return snapshot
    }
    return null
  }

  ingest(records = [], { monitorSettings = null } = {}) {
    const capturedRecords = records.filter(isCapturedMarket)
    appendJsonl(this.snapshotsPath, capturedRecords)
    const changes = this.detectChanges(capturedRecords).map((change) => attachCandidate(change, monitorSettings))
    appendJsonl(this.changesPath, changes)
    return { snapshots: capturedRecords, changes }
  }
}
