import crypto from 'node:crypto'

import { monitorAlertSettingFromRow } from './alert-settings.mjs'
import { alertSettingToStrategy } from './strategy-registry.mjs'

function clone(value) {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError('alert-settings-snapshot-not-cloneable', { cause: error })
  }
}

const BOOLEAN_COLUMNS = [
  'enabled', 'asian_handicap_enabled', 'total_enabled', 'include_first_half', 'include_half_time',
  'include_second_half', 'migration_review_required',
]

function finiteOrNull(value, name) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError(`invalid alert setting ${name}`)
}

function integerOrNull(value, name) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`invalid alert setting ${name}`)
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) throw new TypeError('monitor alert settings must contain exactly two rows')
  const modes = rows.map((row) => row?.mode)
  if (new Set(modes).size !== 2 || !modes.includes('prematch') || !modes.includes('live')) {
    throw new TypeError('monitor alert settings must contain prematch and live exactly once')
  }
  for (const row of rows) {
    for (const column of BOOLEAN_COLUMNS) {
      if (row[column] !== 0 && row[column] !== 1) throw new TypeError(`invalid alert setting boolean:${column}`)
    }
    for (const column of ['monitor_odds_min', 'monitor_odds_max', 'water_move_threshold']) finiteOrNull(row[column], column)
    for (const column of ['cooldown_seconds', 'start_minutes_before_kickoff', 'stop_minutes_before_kickoff', 'live_minute_from', 'live_minute_to']) {
      integerOrNull(row[column], column)
    }
    if (!Number.isSafeInteger(row.version) || row.version < 1) throw new TypeError('invalid alert setting version')
    if (row.monitor_odds_min !== null && row.monitor_odds_max !== null && row.monitor_odds_min > row.monitor_odds_max) {
      throw new TypeError('invalid alert setting odds range')
    }
    if (row.mode === 'prematch') {
      if (row.live_minute_from !== null || row.live_minute_to !== null
        || row.include_first_half !== 0 || row.include_half_time !== 0 || row.include_second_half !== 0) {
        throw new TypeError('invalid prematch alert setting live fields')
      }
      if (row.start_minutes_before_kickoff !== null && row.stop_minutes_before_kickoff !== null
        && row.start_minutes_before_kickoff < row.stop_minutes_before_kickoff) {
        throw new TypeError('invalid prematch alert setting window')
      }
    } else {
      if (row.start_minutes_before_kickoff !== null || row.stop_minutes_before_kickoff !== null) {
        throw new TypeError('invalid live alert setting prematch fields')
      }
      if (row.live_minute_from !== null && row.live_minute_to !== null && row.live_minute_from > row.live_minute_to) {
        throw new TypeError('invalid live alert setting window')
      }
    }
  }
}

export { alertSettingToStrategy }

export class AlertSettingsWatcher {
  #database
  #revision = null
  #strategies = []

  constructor(database) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
    this.#database = database
  }

  reload() {
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM monitor_alert_settings
        WHERE mode IN ('prematch','live')
        ORDER BY CASE mode WHEN 'prematch' THEN 0 ELSE 1 END
      `).all()
      validateRows(rows)
      const candidateRevision = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
      if (candidateRevision === this.#revision) {
        return { updated: false, reason: 'revision-unchanged', revision: this.#revision, strategies: clone(this.#strategies) }
      }
      const strategies = rows.map((row) => alertSettingToStrategy(monitorAlertSettingFromRow(row)))
      this.#strategies = clone(strategies)
      this.#revision = candidateRevision
      return { updated: true, revision: this.#revision, strategies: clone(this.#strategies) }
    } catch (error) {
      return {
        updated: false,
        reason: 'alert-settings-revision-invalid',
        revision: this.#revision,
        strategies: clone(this.#strategies),
        error,
      }
    }
  }
}
