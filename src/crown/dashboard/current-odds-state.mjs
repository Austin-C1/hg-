import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildEvents } from './dashboard-data.mjs'

const SOURCE = 'monitor-v2'
const projectionCache = new Map()

function fileVersion(file) {
  try {
    const stat = fs.statSync(file, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

function databaseVersion(dbPath) {
  return `${fileVersion(dbPath)}|wal:${fileVersion(`${dbPath}-wal`)}`
}

function parsedObject(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function selectionRecord(row, event) {
  const snapshot = parsedObject(row.snapshot_json)
  if (!snapshot) return null
  return {
    ...snapshot,
    capturedAt: row.captured_at,
    event: { ...event, ...(snapshot.event || {}), eventKey: row.event_key },
  }
}

function eventRecord(row, event) {
  return {
    schemaVersion: 2,
    capturedAt: row.last_seen_at,
    mode: event.mode,
    event: { ...event, eventKey: row.event_key },
  }
}

export async function readCurrentOddsState({ dbPath }) {
  const resolvedDbPath = path.resolve(dbPath)
  const versionBefore = databaseVersion(resolvedDbPath)
  const cached = projectionCache.get(resolvedDbPath)
  if (cached?.version === versionBefore) return cached.result

  const db = new DatabaseSync(resolvedDbPath, { readOnly: true })
  let transactionOpen = false
  let result
  try {
    db.exec('BEGIN')
    transactionOpen = true
    const rows = db.prepare(`
      SELECT
        e.event_key,
        e.last_seen_at,
        e.event_json,
        s.captured_at,
        s.snapshot_json
      FROM monitor_event_state AS e
      LEFT JOIN monitor_selection_state AS s
        ON s.event_key = e.event_key
      WHERE e.active = 1
      ORDER BY e.event_key, s.captured_at, s.selection_identity
    `).all()
    const scopes = db.prepare(`
      SELECT scope_key, last_batch_id, last_captured_at, last_complete_at
      FROM monitor_scope_state
      ORDER BY last_complete_at DESC, scope_key
    `).all()

    const warnings = new Set()
    const records = []
    const fallbackEventKeys = new Set()
    const grouped = new Map()
    for (const row of rows) {
      if (!grouped.has(row.event_key)) grouped.set(row.event_key, [])
      grouped.get(row.event_key).push(row)
    }

    for (const [eventKey, eventRows] of grouped) {
      const first = eventRows[0]
      const event = parsedObject(first.event_json)
      if (!event) warnings.add(`event-json-invalid:${eventKey}`)
      let selectionCount = 0
      for (const row of eventRows) {
        if (row.snapshot_json === null) continue
        const record = selectionRecord(row, event || {})
        if (!record) {
          warnings.add(`selection-json-invalid:${eventKey}`)
          continue
        }
        records.push(record)
        selectionCount += 1
      }
      if (selectionCount === 0) {
        records.push(eventRecord(first, event || {}))
        fallbackEventKeys.add(eventKey)
      }
    }

    const items = buildEvents(records).map((item) => fallbackEventKeys.has(item.eventKey)
      ? { ...item, recordCount: 0, marketCount: 0, selectionCount: 0, markets: [] }
      : item)
    const totals = {
      events: items.length,
      selections: items.reduce((total, item) => total + item.selectionCount, 0),
      scopes: scopes.length,
    }
    const last = scopes[0]

    result = {
      events: {
        schemaVersion: 2,
        source: SOURCE,
        origin: SOURCE,
        items,
        warnings: [...warnings].sort(),
      },
      summary: {
        schemaVersion: 2,
        source: SOURCE,
        readonly: true,
        totals,
        lastCapturedAt: items.reduce((latest, item) => {
          if (!item.lastCapturedAt) return latest
          return !latest || Date.parse(item.lastCapturedAt) > Date.parse(latest) ? item.lastCapturedAt : latest
        }, null),
      },
      health: {
        available: true,
        source: SOURCE,
        lastAuthoritative: last ? {
          scopeKey: last.scope_key,
          batchId: last.last_batch_id,
          capturedAt: last.last_captured_at,
          completedAt: last.last_complete_at,
        } : null,
      },
    }
    db.exec('COMMIT')
    transactionOpen = false
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original read failure.
      }
    }
    throw error
  } finally {
    db.close()
  }

  const versionAfter = databaseVersion(resolvedDbPath)
  if (versionAfter === versionBefore) {
    projectionCache.set(resolvedDbPath, { version: versionAfter, result })
  }
  return result
}
