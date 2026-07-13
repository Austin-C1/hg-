import {
  parseCrownKickoff,
  parseCrownLiveClock,
} from './monitor/crown-time.mjs'
import {
  crownIdentity,
  marketIdentity,
  selectionIdentity,
} from './monitor/snapshot-batch.mjs'
import { repairCrownText } from './crown-text.mjs'

const MAPPER_VERSION = 'crown-transform-xml-v4'
const EXCLUDED_FOOTBALL_RE = /(电竞|电子|虚拟|梦幻足球|e\s*[-_ ]?\s*football|efootball|esport|virtual|fantasy|GT体育|2\s*[xX]\s*6\s*分钟)/i

const ALTERNATE_LINE_CODES = ['A', 'B', 'C', 'D', 'E', 'F']

function side(odds, ratio = null) {
  return { odds, ratio }
}

function handicapSpec({ period, code }) {
  return {
    marketType: 'asian_handicap',
    period,
    ratio: `RATIO_${code}`,
    lineKey: `RATIO_${code}`,
    home: `IOR_${code}H`,
    away: `IOR_${code}C`,
  }
}

function totalSpec({ period, code, overOdds = `IOR_${code}C`, underOdds = `IOR_${code}H` }) {
  return {
    marketType: 'total',
    period,
    lineKey: `RATIO_${code}O`,
    over: side(overOdds, `RATIO_${code}O`),
    under: side(underOdds, `RATIO_${code}U`),
  }
}

const PAIR_MARKETS = [
  { marketType: 'asian_handicap', period: 'full_time', ratio: 'RATIO_R', home: 'IOR_RH', away: 'IOR_RC' },
  { marketType: 'asian_handicap', period: 'full_time', ratio: 'RATIO_RE', home: 'IOR_REH', away: 'IOR_REC' },
  { marketType: 'asian_handicap', period: 'first_half', ratio: 'RATIO_HR', home: 'IOR_HRH', away: 'IOR_HRC' },
  { marketType: 'asian_handicap', period: 'first_half', ratio: 'RATIO_HRE', home: 'IOR_HREH', away: 'IOR_HREC' },
  { marketType: 'asian_handicap', period: 'full_time', ratio: 'RATIO_PR', lineKey: 'RATIO_PR', home: 'IOR_PRH', away: 'IOR_PRC' },
  { marketType: 'asian_handicap', period: 'first_half', ratio: 'RATIO_HPR', lineKey: 'RATIO_HPR', home: 'IOR_HPRH', away: 'IOR_HPRC' },
  ...ALTERNATE_LINE_CODES.map((code) => handicapSpec({ period: 'full_time', code: `${code}R` })),
  ...ALTERNATE_LINE_CODES.map((code) => handicapSpec({ period: 'full_time', code: `${code}RE` })),
  totalSpec({ period: 'full_time', code: 'OU', overOdds: 'IOR_OUC', underOdds: 'IOR_OUH' }),
  totalSpec({ period: 'full_time', code: 'ROU', overOdds: 'IOR_ROUC', underOdds: 'IOR_ROUH' }),
  totalSpec({ period: 'first_half', code: 'HOU', overOdds: 'IOR_HOUC', underOdds: 'IOR_HOUH' }),
  totalSpec({ period: 'first_half', code: 'HROU', overOdds: 'IOR_HROUC', underOdds: 'IOR_HROUH' }),
  ...ALTERNATE_LINE_CODES.map((code) => totalSpec({ period: 'full_time', code: `${code}OU`, overOdds: `IOR_${code}OUO`, underOdds: `IOR_${code}OUU` })),
  ...ALTERNATE_LINE_CODES.map((code) => totalSpec({ period: 'full_time', code: `${code}ROU`, overOdds: `IOR_${code}ROUO`, underOdds: `IOR_${code}ROUU` })),
]

function endpointKey(metadata = {}) {
  const method = String(metadata.method || 'POST').toUpperCase()
  const url = String(metadata.url || metadata.requestUrl || 'unknown')
  const endpointKind = metadata.endpointKind ? ` p=${metadata.endpointKind}` : ''
  return `${method} ${url}${endpointKind}`
}

function textOf(body) {
  if (typeof body === 'string') return body
  if (body && typeof body.text === 'string') return body.text
  if (body && typeof body.body === 'string') return body.body
  return ''
}

function hasValidServerResponseStructure(text) {
  const cleaned = String(text || '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  const tags = cleaned.match(/<\s*\/?\s*[A-Za-z][A-Za-z0-9_.:-]*\b[^>]*>/g) || []
  const stack = []
  let rootSeen = false
  let rootClosed = false

  for (const rawTag of tags) {
    const match = rawTag.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]*)/)
    const closing = match?.[1] === '/'
    const name = String(match?.[2] || '').toLowerCase()
    const selfClosing = !closing && /\/\s*>$/.test(rawTag)

    if (closing) {
      if (stack.pop() !== name) return false
      if (stack.length === 0) rootClosed = true
      continue
    }

    if (stack.length === 0) {
      if (rootSeen || rootClosed || name !== 'serverresponse') return false
      rootSeen = true
      if (selfClosing) {
        rootClosed = true
        continue
      }
    }

    if (!selfClosing) stack.push(name)
  }

  return rootSeen && rootClosed && stack.length === 0
}

export function classifyCrownTransformText(value) {
  const text = textOf(value).trim()
  const hasServerResponse = /<serverresponse\b/i.test(text)
  const hasHtml = /<!doctype\s+html|<html\b|login|sign\s*in/i.test(text)
  const parseError = hasServerResponse && !hasValidServerResponseStructure(text)
  const gameCount = parseError ? 0 : tagBlocks(text, 'game').length
  return {
    hasServerResponse,
    loginExpired: hasHtml && !hasServerResponse,
    parseError,
    empty: hasServerResponse && !parseError && gameCount === 0,
    gameCount,
  }
}

export function isCrownTransformXml({ body, metadata = {} } = {}) {
  const text = textOf(body)
  const url = String(metadata.url || metadata.requestUrl || metadata.sampleFile || metadata.endpointKind || '')
  if (!text) return false
  const looksLikeTransform = /\/transform(?:_nl)?\.php|get[-_]?game|transform-xml/i.test(url)
  const hasCrownXml = /<serverresponse\b/i.test(text)
  const hasOddsFields = /<IOR_[A-Z0-9_]+>/i.test(text) || /<RATIO_[A-Z0-9_]+>/i.test(text)
  return hasCrownXml && (looksLikeTransform || hasOddsFields)
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function firstTagText(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'))
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')).trim() : ''
}

function tagBlocks(text, tagName) {
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?</${tagName}>`, 'gi')
  return [...String(text || '').matchAll(re)].map((match) => match[0])
}

function stripOuterTag(block, tagName) {
  return String(block || '')
    .replace(new RegExp(`^<${tagName}\\b[^>]*>`, 'i'), '')
    .replace(new RegExp(`</${tagName}>$`, 'i'), '')
}

function parseDirectChildFields(block, tagName = 'game') {
  const inner = stripOuterTag(block, tagName)
  const fields = {}
  const re = /<([A-Za-z][A-Za-z0-9_]*)\b[^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of inner.matchAll(re)) {
    const key = match[1].toLowerCase()
    const value = decodeXml(match[2].replace(/<[^>]+>/g, '')).trim()
    fields[key] = value
  }
  return fields
}

function field(fields, ...names) {
  for (const name of names) {
    const value = fields[String(name).toLowerCase()]
    if (value != null && String(value).trim() !== '') return String(value).trim()
  }
  return ''
}

function hasField(fields, name) {
  return Object.hasOwn(fields, String(name).toLowerCase())
}

function numberOrNull(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function isDecimal(value) {
  return numberOrNull(value) != null
}

function handicapValue(value) {
  const text = String(value ?? '').replace(/\+/g, '').trim()
  if (!text) return null
  const parts = text.split('/').map((part) => Number(part.trim())).filter((number) => Number.isFinite(number))
  if (!parts.length) return null
  return parts.reduce((sum, number) => sum + number, 0) / parts.length
}

function keyValue(value, fallback = 'none') {
  if (value === null || value === undefined || value === '') return fallback
  return String(value).replace(/\s+/g, '')
}

function upper(name) {
  return String(name || '').toUpperCase()
}

function modeOf(fields) {
  const showtype = field(fields, 'showtype').toLowerCase()
  const isRb = field(fields, 'is_rb').toUpperCase()
  if (showtype === 'rb' || isRb === 'Y') return 'live'
  return 'prematch'
}

function statusOf(mode) {
  if (mode === 'live') return 'live'
  if (mode === 'prematch') return 'not_started'
  return 'unknown'
}

function scoreOf(fields) {
  const home = field(fields, 'score_h')
  const away = field(fields, 'score_c')
  return home !== '' && away !== '' ? `${home}-${away}` : null
}

function legacyEventKey(fields) {
  return [
    ['gid', field(fields, 'gid')],
    ['gidm', field(fields, 'gidm')],
    ['hgid', field(fields, 'hgid')],
    ['ecid', field(fields, 'ecid')],
    ['lid', field(fields, 'lid')],
  ].map(([name, value]) => `${name}=${value || 'missing'}`).join('|')
}

function baseEvent(fields, mode, metadata) {
  const providerIds = {
    gid: field(fields, 'gid') || null,
    gidm: field(fields, 'gidm') || null,
    hgid: field(fields, 'hgid') || null,
    ecid: field(fields, 'ecid') || null,
    lid: field(fields, 'lid') || null,
    eventId: field(fields, 'eventid') || null,
  }
  const identity = crownIdentity(providerIds)
  const kickoff = parseCrownKickoff({
    gameDateTime: field(fields, 'game_date_time'),
    datetime: field(fields, 'datetime'),
    capturedAt: metadata.capturedAt,
    systemTime: metadata.systemTime,
  })
  const rawClock = field(fields, 'retimeset')
  const liveClock = mode === 'live'
    ? parseCrownLiveClock(rawClock)
    : { raw: rawClock || null, phase: null, elapsedMinute: null, warnings: [] }
  return {
    eventId: field(fields, 'gid'),
    eventKey: identity.eventKey,
    legacyEventKey: `crown|${legacyEventKey(fields)}`,
    matchGroupKey: identity.matchGroupKey,
    identityConfidence: identity.confidence,
    league: repairCrownText(field(fields, 'league')),
    homeTeam: repairCrownText(field(fields, 'team_h')),
    awayTeam: repairCrownText(field(fields, 'team_c')),
    startTimeRaw: kickoff.raw,
    startTimeUtc: kickoff.utc,
    startTimeLocal: kickoff.local,
    timeZone: kickoff.timeZone,
    timeSource: kickoff.source,
    timeConfidence: kickoff.confidence,
    timeWarnings: kickoff.warnings,
    status: statusOf(mode),
    score: scoreOf(fields),
    clock: liveClock.raw,
    livePhase: liveClock.phase,
    liveMinute: liveClock.elapsedMinute,
    liveClockWarnings: liveClock.warnings,
    providerIds: identity.providerIds,
    ids: identity.providerIds,
  }
}

function source(metadata) {
  return {
    endpointKey: endpointKey(metadata),
    urlPattern: metadata.url || 'unknown',
    endpointKind: metadata.endpointKind || null,
    mapperVersion: MAPPER_VERSION,
    sampleFile: metadata.sampleFile || null,
    confidence: 'high',
    dataSource: 'xml-live',
  }
}

function baseWarnings() {
  return [
    'crown-transform-xml',
    'real-event-id',
    'local-market-id',
    'local-selection-id',
    'missing-explicit-odds-id',
  ]
}

function marketClosed(fields, period) {
  const gopen = field(fields, 'gopen').toUpperCase()
  const hgopen = field(fields, 'hgopen').toUpperCase()
  return gopen === 'N' || (period === 'first_half' && hgopen === 'N')
}

function marketKeyFor(event, period, marketType, handicap, lineKey) {
  return `${event.eventKey}|period=${period}|market=${marketType}|line=${keyValue(lineKey)}|handicap=${keyValue(handicap)}`
}

function makeRecord({ fields, metadata, mode, period, marketType, ratioField = null, oddsField, side, oddsRaw, lineKey = null }) {
  const event = baseEvent(fields, mode, metadata)
  const handicapRaw = ratioField ? field(fields, ratioField) || null : null
  const handicap = handicapValue(handicapRaw)
  const marketLineKey = upper(lineKey || ratioField || 'unknown-line')
  const legacyMarketKey = marketKeyFor(event, period, marketType, handicap, marketLineKey)
  const legacySelectionKey = `${legacyMarketKey}|side=${side}`
  const identityRecord = {
    event,
    market: { period, marketType, lineKey: marketLineKey },
    selection: { side },
  }
  const canonicalMarketIdentity = marketIdentity(identityRecord)
  const canonicalSelectionIdentity = selectionIdentity(identityRecord)
  const suspended = marketClosed(fields, period) || !isDecimal(oddsRaw)
  const warnings = baseWarnings()
  if (suspended) warnings.push('market-suspended')
  if (marketClosed(fields, period)) warnings.push('market-closed')
  if (ratioField && !handicapRaw) warnings.push('missing-ratio-field')

  return {
    provider: 'crown',
    sport: 'football',
    mode,
    capturedAt: metadata.capturedAt || new Date().toISOString(),
    source: source(metadata),
    event,
    market: {
      marketId: canonicalMarketIdentity,
      marketKey: canonicalMarketIdentity,
      marketIdentity: canonicalMarketIdentity,
      legacyMarketKey,
      idScope: 'local',
      providerMarketId: null,
      marketType,
      period,
      handicapRaw,
      handicap,
      ratioField: ratioField ? upper(ratioField) : null,
      lineKey: marketLineKey,
      isMainMarket: 'unknown',
      crownStrong: field(fields, 'strong') || null,
    },
    selection: {
      selectionId: canonicalSelectionIdentity,
      selectionKey: canonicalSelectionIdentity,
      selectionIdentity: canonicalSelectionIdentity,
      legacySelectionKey,
      idScope: 'local',
      providerSelectionId: null,
      oddsId: null,
      side,
      oddsRaw: String(oddsRaw ?? ''),
      odds: numberOrNull(oddsRaw),
      oddsField: upper(oddsField),
      oddsFormat: 'crown-ior',
      suspended,
    },
    warnings,
  }
}

const SPEC_META_KEYS = new Set(['marketType', 'period', 'ratio', 'lineKey'])

function normalizeSideSpec(spec, entry) {
  if (typeof entry === 'string') return { oddsField: entry, ratioField: spec.ratio || null }
  return {
    oddsField: entry?.odds || '',
    ratioField: entry?.ratio || spec.ratio || null,
  }
}

function addPair(records, fields, metadata, mode, spec) {
  const entries = Object.entries(spec).filter(([key]) => !SPEC_META_KEYS.has(key))
  const sideRefs = entries.map(([, entry]) => normalizeSideSpec(spec, entry))
  const hasAnyRatio = sideRefs.some((ref) => ref.ratioField && field(fields, ref.ratioField))
  const hasAnyOdds = sideRefs.some((ref) => ref.oddsField && hasField(fields, ref.oddsField))
  if (!hasAnyRatio && !hasAnyOdds) return

  for (const [selectionSide, entry] of entries) {
    const { oddsField, ratioField } = normalizeSideSpec(spec, entry)
    if (!hasField(fields, oddsField)) continue
    records.push(makeRecord({
      fields,
      metadata,
      mode,
      period: spec.period,
      marketType: spec.marketType,
      ratioField,
      lineKey: spec.lineKey || ratioField,
      side: selectionSide,
      oddsField,
      oddsRaw: field(fields, oddsField),
    }))
  }
}

function isExcludedFootballGame(fields) {
  return EXCLUDED_FOOTBALL_RE.test([
    repairCrownText(field(fields, 'league')),
    repairCrownText(field(fields, 'team_h')),
    repairCrownText(field(fields, 'team_c')),
  ].join(' '))
}

function hasCanonicalEventFields(fields) {
  return Boolean(field(fields, 'gid') && field(fields, 'team_h') && field(fields, 'team_c'))
}

function isFootballGame(fields) {
  return !isExcludedFootballGame(fields) && hasCanonicalEventFields(fields)
}

function normalizeGame(fields, metadata) {
  const mode = modeOf(fields)
  if (!isFootballGame(fields)) return []

  const records = []
  for (const spec of PAIR_MARKETS) addPair(records, fields, metadata, mode, spec)
  return records
}

export function parseCrownTransformGames(xmlText) {
  return tagBlocks(xmlText, 'game').map((block) => parseDirectChildFields(block, 'game'))
}

export function normalizeCrownTransformBatch({ body, metadata = {} } = {}) {
  const xmlText = textOf(body)
  if (!xmlText) {
    return {
      classification: { ...classifyCrownTransformText(xmlText), eligibleGameCount: 0, excludedGameCount: 0 },
      eventRefs: [],
      records: [],
    }
  }
  const classification = classifyCrownTransformText(xmlText)
  if (classification.loginExpired || classification.parseError || !classification.hasServerResponse) {
    return {
      classification: { ...classification, eligibleGameCount: 0, excludedGameCount: 0 },
      eventRefs: [],
      records: [],
    }
  }
  const responseSystemTime = firstTagText(xmlText, 'system_time') || String(metadata?.systemTime || '').trim()
  const normalizedMetadata = {
    ...(metadata || {}),
    capturedAt: metadata?.capturedAt || new Date().toISOString(),
    systemTime: responseSystemTime,
  }
  const parsedGames = parseCrownTransformGames(xmlText)
  const eligibleGames = parsedGames.filter((fields) => !isExcludedFootballGame(fields))
  const games = eligibleGames.filter(hasCanonicalEventFields)
  return {
    systemTime: responseSystemTime,
    classification: {
      ...classification,
      eligibleGameCount: eligibleGames.length,
      excludedGameCount: parsedGames.length - eligibleGames.length,
      invalidEventRefCount: eligibleGames.length - games.length,
    },
    eventRefs: games.map((fields) => baseEvent(fields, modeOf(fields), normalizedMetadata)),
    records: games.flatMap((fields) => normalizeGame(fields, normalizedMetadata)),
  }
}

export function normalizeCrownTransformXml(input = {}) {
  return normalizeCrownTransformBatch(input).records
}
