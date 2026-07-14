import { isDefaultLeagueMatched } from '../config/default-leagues.mjs'

function readEvent(row) {
  try {
    const event = JSON.parse(row.event_json)
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null
    return { ...event, eventKey: row.event_key }
  } catch {
    return null
  }
}

export function buildTodayBettingLeagues({ db, defaultLeagues }) {
  const manualKeys = new Set(db.prepare(
    "SELECT event_key FROM tracked_matches WHERE tracking_status='active'",
  ).all().map((row) => row.event_key))
  const leagues = new Map()

  for (const row of db.prepare(
    'SELECT event_key, event_json FROM monitor_event_state WHERE active=1 ORDER BY rowid',
  ).all()) {
    const event = readEvent(row)
    if (!event) continue
    const leagueName = String(event.league || '').trim()
    if (!leagueName) continue

    const defaultHit = isDefaultLeagueMatched(leagueName, event.mode, defaultLeagues).status === 'hit'
    const manualHit = manualKeys.has(row.event_key)
    if (!defaultHit && !manualHit) continue

    const item = leagues.get(leagueName) || {
      leagueName,
      defaultHit: false,
      manualHit: false,
      eventKeys: new Set(),
    }
    item.defaultHit ||= defaultHit
    item.manualHit ||= manualHit
    item.eventKeys.add(row.event_key)
    leagues.set(leagueName, item)
  }

  return [...leagues.values()].map((item) => ({
    leagueName: item.leagueName,
    source: item.defaultHit && item.manualHit ? 'both' : item.defaultHit ? 'default' : 'manual',
    todayMatchCount: item.eventKeys.size,
  }))
}
