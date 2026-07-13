import { isDefaultLeagueMatched, normalizeDefaultLeaguesConfig } from '../config/default-leagues.mjs'

function timeValue(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function activeTrackedLeagues(trackedMatches = []) {
  return new Set((trackedMatches || [])
    .filter((item) => item?.trackingStatus === 'active')
    .map((item) => item?.league)
    .filter(Boolean))
}

export function buildLeagueSummaries(events = [], trackedMatches = [], defaultLeagues = {}) {
  const groups = new Map()
  const manualTracked = activeTrackedLeagues(trackedMatches)
  const defaults = normalizeDefaultLeaguesConfig(defaultLeagues)

  for (const event of events || []) {
    const league = String(event?.league || '').trim()
    if (!league) continue
    if (!groups.has(league)) {
      groups.set(league, {
        league,
        prematchEventCount: 0,
        liveEventCount: 0,
        totalOddsCount: 0,
        inDefaultWhitelist: false,
        defaultAutoTracked: false,
        tracked: false,
        trackingSource: 'none',
        lastCapturedAt: null,
        events: [],
      })
    }

    const group = groups.get(league)
    group.events.push(event)
    if (event.mode === 'live') group.liveEventCount += 1
    else if (event.mode === 'prematch') group.prematchEventCount += 1
    group.totalOddsCount += Number(event.selectionCount || 0)
    if (!group.lastCapturedAt || timeValue(event.lastCapturedAt) > timeValue(group.lastCapturedAt)) {
      group.lastCapturedAt = event.lastCapturedAt || group.lastCapturedAt
    }

    const defaultMatch = isDefaultLeagueMatched(league, event.mode, defaults)
    if (defaultMatch.matched) group.inDefaultWhitelist = true
    if (defaultMatch.status === 'hit' && defaultMatch.autoTrack) group.defaultAutoTracked = true
  }

  for (const group of groups.values()) {
    const manuallyTracked = manualTracked.has(group.league)
    group.tracked = manuallyTracked || group.defaultAutoTracked
    group.trackingSource = manuallyTracked ? 'manual' : (group.defaultAutoTracked ? 'default' : 'none')
  }

  return [...groups.values()].sort((a, b) => b.prematchEventCount + b.liveEventCount - (a.prematchEventCount + a.liveEventCount)
    || a.league.localeCompare(b.league))
}
