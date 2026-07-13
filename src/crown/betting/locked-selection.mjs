import { oppositeSide } from './monitor-bet-signal.mjs'

const CANONICAL_EVENT_IDENTITY = /^crown\|football\|gid=[^|\s]+$/
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MARKET_SIDES = new Map([
  ['asian_handicap', new Set(['home', 'away'])],
  ['total', new Set(['over', 'under'])],
])
const PERIODS = new Set(['full_time', 'first_half'])

function canonicalTimestamp(value) {
  if (!UTC_TIMESTAMP.test(String(value || ''))) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return null
  return milliseconds
}

function signalMarket(signal) {
  const eventKey = signal?.target?.eventIdentity
  const marketIdentity = signal?.target?.marketIdentity
  const sourceSide = signal?.target?.side
  if (!CANONICAL_EVENT_IDENTITY.test(String(eventKey || ''))) return null
  if (typeof marketIdentity !== 'string' || !marketIdentity.startsWith(`${eventKey}|`)) return null
  const parts = marketIdentity.slice(eventKey.length + 1).split('|')
  if (parts.length !== 3 || parts.some((part) => !part)) return null
  const [period, marketType, lineKey] = parts
  if (!PERIODS.has(period) || !MARKET_SIDES.get(marketType)?.has(sourceSide)) return null
  if (signal.target.selectionIdentity !== `${marketIdentity}|${sourceSide}`) return null
  if (signal.evidence?.period !== period || signal.evidence?.marketType !== marketType) return null
  const sourceHandicap = signal.evidence?.handicap
  if (typeof sourceHandicap !== 'number' || !Number.isFinite(sourceHandicap)) return null
  const side = oppositeSide(sourceSide)
  if (!side) return null
  return {
    eventKey,
    marketIdentity,
    period,
    marketType,
    lineKey,
    sourceSide,
    sourceHandicap,
    sourceHandicapRaw: signal.evidence?.handicapRaw,
    side,
  }
}

function unwrappedSnapshot(value) {
  return value?.snapshot && typeof value.snapshot === 'object' ? value.snapshot : value
}

export function lockReverseSelection(signal, findLatestSelection) {
  const market = signalMarket(signal)
  if (!market || typeof findLatestSelection !== 'function') return null
  const snapshot = unwrappedSnapshot(findLatestSelection({
    provider: 'crown',
    eventKey: market.eventKey,
    period: market.period,
    marketType: market.marketType,
    lineKey: market.lineKey,
    side: market.side,
  }))
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null

  const expectedSelectionIdentity = `${market.marketIdentity}|${market.side}`
  if (snapshot.provider !== 'crown') return null
  if (snapshot.event?.eventKey !== market.eventKey) return null
  if (snapshot.market?.period !== market.period || snapshot.market?.marketType !== market.marketType) return null
  if (snapshot.market?.lineKey !== market.lineKey || snapshot.market?.marketIdentity !== market.marketIdentity) return null
  const handicap = snapshot.market?.handicap
  if (typeof handicap !== 'number' || !Number.isFinite(handicap) || handicap !== market.sourceHandicap) return null
  if (snapshot.selection?.side !== market.side) return null
  if (snapshot.selection?.selectionIdentity !== expectedSelectionIdentity) return null
  if (snapshot.selection?.suspended !== false) return null

  const capturedMilliseconds = canonicalTimestamp(snapshot.capturedAt)
  const observedMilliseconds = canonicalTimestamp(signal?.observedAt)
  if (capturedMilliseconds === null || observedMilliseconds === null || capturedMilliseconds < observedMilliseconds) return null

  return {
    provider: 'crown',
    eventKey: market.eventKey,
    period: market.period,
    marketType: market.marketType,
    lineKey: market.lineKey,
    marketIdentity: market.marketIdentity,
    sourceSide: market.sourceSide,
    side: market.side,
    selectionIdentity: expectedSelectionIdentity,
    handicap,
    handicapRaw: snapshot.market?.handicapRaw,
    capturedAt: snapshot.capturedAt,
    snapshot,
  }
}
