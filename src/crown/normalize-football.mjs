import { filterByLeague } from './filters/league-filter.mjs'
import { isNormalFootballMatch, normalizeCrownTransformXml } from './crown-transform-xml.mjs'
import { detectEndpoint } from './endpoint-detector.mjs'

const MAPPER_VERSION = 'crown-football-v1'
const LINE = '[+-]?\\d+(?:\\.\\d+)?(?:\\/\\d+(?:\\.\\d+)?)?'
const ODDS = '[+-]?\\d+(?:\\.\\d+)?'
const DECIMAL_ODDS_RE = /(?<![\d.])([+-]?\d+\.\d{1,3})(?![\d.])/g

function endpointKey(metadata = {}) {
  const method = String(metadata.method || 'GET').toUpperCase()
  const url = String(metadata.url || metadata.requestUrl || 'unknown')
  return `${method} ${url}`
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function statusFromMode(mode) {
  if (mode === 'prematch') return 'not_started'
  if (mode === 'live') return 'live'
  return 'unknown'
}

function inferClock(event) {
  if (event.mode !== 'live') return null
  return String(event.summaryText || event.text || '').match(/(上半场|下半场|中场|半场休息|加时)?\s*\d{1,2}:\d{2}/)?.[0]?.trim() || null
}

function baseWarnings(event) {
  const warnings = ['inferred-dom-market']
  if (!event.teams?.[1]) warnings.push('missing-away-team')
  return warnings
}

function makeRecord({ event, metadata, marketType, period, handicapRaw = null, selectionSide, oddsRaw, marketSuffix }) {
  const warnings = baseWarnings(event)
  if (marketType === 'unknown') warnings.push('unknown-market')
  if (marketType !== 'unknown') warnings.push('local-market-id', 'local-selection-id')

  const eventKey = `dom|event=${event.id || 'unknown-event'}|league=${String(event.league || '').trim()}|home=${String(event.teams?.[0] || '').trim()}|away=${String(event.teams?.[1] || '').trim()}|mode=${event.mode || 'unknown'}`
  const marketKey = `${eventKey}|period=${period}|market=${marketSuffix || marketType}|handicap=${handicapRaw ? String(handicapRaw).replace(/\s+/g, '') : 'none'}`
  const selectionKey = `${marketKey}|side=${selectionSide}`

  return {
    provider: 'crown',
    sport: 'football',
    mode: event.mode || 'unknown',
    capturedAt: metadata.capturedAt || event.capturedAt || new Date(0).toISOString(),
    source: {
      endpointKey: endpointKey(metadata),
      urlPattern: metadata.url || 'unknown',
      mapperVersion: MAPPER_VERSION,
      sampleFile: metadata.sampleFile || null,
    },
    event: {
      eventId: String(event.id || ''),
      eventKey,
      league: String(event.league || ''),
      homeTeam: String(event.teams?.[0] || ''),
      awayTeam: String(event.teams?.[1] || ''),
      startTimeRaw: event.summaryText || null,
      startTimeUtc: null,
      status: statusFromMode(event.mode),
      score: null,
      clock: inferClock(event),
    },
    market: {
      marketId: marketKey,
      marketKey,
      idScope: 'local',
      providerMarketId: null,
      marketType,
      period,
      handicapRaw,
      handicap: null,
      ratioField: null,
      isMainMarket: 'unknown',
    },
    selection: {
      selectionId: selectionKey,
      selectionKey,
      idScope: 'local',
      providerSelectionId: null,
      oddsId: null,
      side: selectionSide,
      oddsRaw: String(oddsRaw),
      odds: toNumber(oddsRaw),
      oddsField: null,
      oddsFormat: 'unknown',
      suspended: false,
    },
    warnings,
  }
}

function addAsianHandicap(records, event, metadata, text, period, marketSuffix = 'asian_handicap') {
  const re = new RegExp(`让球\\s+(${LINE})\\s+(${ODDS})\\s+(${LINE})\\s+(${ODDS})`, 'i')
  const match = text.match(re)
  if (!match) return false

  records.push(makeRecord({
    event,
    metadata,
    marketType: 'asian_handicap',
    period,
    handicapRaw: match[1],
    selectionSide: 'home',
    oddsRaw: match[2],
    marketSuffix,
  }))
  records.push(makeRecord({
    event,
    metadata,
    marketType: 'asian_handicap',
    period,
    handicapRaw: match[3],
    selectionSide: 'away',
    oddsRaw: match[4],
    marketSuffix,
  }))
  return true
}

function addTotal(records, event, metadata, text, period, marketSuffix = 'total') {
  const re = new RegExp(`大\\/小\\s+大\\s+(${LINE})\\s+(${ODDS})\\s+小\\s+(${LINE})\\s+(${ODDS})`, 'i')
  const match = text.match(re)
  if (!match) return false

  records.push(makeRecord({
    event,
    metadata,
    marketType: 'total',
    period,
    handicapRaw: match[1],
    selectionSide: 'over',
    oddsRaw: match[2],
    marketSuffix,
  }))
  records.push(makeRecord({
    event,
    metadata,
    marketType: 'total',
    period,
    handicapRaw: match[3],
    selectionSide: 'under',
    oddsRaw: match[4],
    marketSuffix,
  }))
  return true
}

function addMoneyline(records, event, metadata, text, period, marketSuffix = 'moneyline') {
  const re = new RegExp(`独赢\\s+主\\s+(${ODDS})\\s+客\\s+(${ODDS})\\s+和\\s+(${ODDS})`, 'i')
  const match = text.match(re)
  if (!match) return false

  for (const [side, oddsRaw] of [['home', match[1]], ['away', match[2]], ['draw', match[3]]]) {
    records.push(makeRecord({
      event,
      metadata,
      marketType: 'moneyline',
      period,
      selectionSide: side,
      oddsRaw,
      marketSuffix,
    }))
  }
  return true
}

function fullTimeSection(text) {
  const marker = text.search(/上半场\s*(?=让球|大\/小|独赢)/)
  return marker === -1 ? text : text.slice(0, marker)
}

function normalizeEvent(event, metadata) {
  if (!isNormalFootballMatch({
    league: event.league,
    homeTeam: event.teams?.[0],
    awayTeam: event.teams?.[1],
  })) return []

  const records = []
  const text = String(event.text || '')

  const fullTimeText = fullTimeSection(text)
  addAsianHandicap(records, event, metadata, fullTimeText, 'full_time')
  addTotal(records, event, metadata, fullTimeText, 'full_time')

  return records
}

function normalizeDomFixture(body, metadata) {
  const records = []
  for (const mode of ['prematch', 'live']) {
    for (const event of body?.[mode] || []) {
      records.push(...normalizeEvent({
        ...event,
        mode: event.mode || mode,
        capturedAt: body.capturedAt,
      }, { ...metadata, capturedAt: metadata.capturedAt || body.capturedAt }))
    }
  }
  return records
}

function normalizeMetadataResponse() {
  return []
}

export function normalizeFootballResponse({ body, metadata = {}, fieldMap = null, leagueConfig = null } = {}) {
  void fieldMap
  const detected = detectEndpoint({ body, metadata })
  let records = []

  if (detected.kind === 'crown-transform-xml') records = normalizeCrownTransformXml({ body, metadata })
  else if (detected.kind === 'dom-football-fixture') records = normalizeDomFixture(body, metadata)
  else if (detected.kind === 'football-metadata') records = normalizeMetadataResponse(body, metadata)
  else if (body && Array.isArray(body.prematch) && Array.isArray(body.live)) records = normalizeDomFixture(body, metadata)

  if (leagueConfig) {
    return filterByLeague(records, leagueConfig).kept
  }

  return records
}
