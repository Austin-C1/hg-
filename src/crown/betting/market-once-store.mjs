import crypto from 'node:crypto'
import { assertRealBettingRequested } from './real-betting-runtime.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function lengthPrefixed(parts) {
  return parts.map((value) => {
    const encoded = text(value)
    return `${Buffer.byteLength(encoded, 'utf8')}:${encoded}`
  }).join('|')
}

function marketParts(change) {
  const next = change?.next || {}
  const eventIdentity = text(change?.eventIdentity || change?.event?.eventKey || next?.event?.eventKey)
  const mode = text(change?.mode || change?.event?.mode || next?.mode || next?.event?.mode)
  const period = text(change?.market?.period || next?.market?.period)
  const marketType = text(change?.market?.marketType || next?.market?.marketType)
  const lineIdentity = text(change?.market?.lineKey || next?.market?.lineKey || change?.market?.ratioField || next?.market?.ratioField)
  const lineValue = change?.market?.handicap ?? next?.market?.handicap ?? change?.market?.lineValue ?? next?.market?.lineValue
  return { eventIdentity, mode, period, marketType, lineIdentity, lineValue }
}

function assertCompatibleSide(marketType, actualSide) {
  const compatibleSides = marketType === 'asian_handicap'
    ? new Set(['home', 'away'])
    : marketType === 'total'
      ? new Set(['over', 'under'])
      : null
  if (!compatibleSides?.has(text(actualSide))) throw new TypeError('actualSide is incompatible with marketType')
}

export function marketOnceKey(change, actualSide, { cardId = null } = {}) {
  const parts = marketParts(change)
  assertCompatibleSide(parts.marketType, actualSide)
  const values = cardId === null
    ? [parts.eventIdentity, parts.mode, parts.period, parts.marketType, parts.lineIdentity, parts.lineValue, actualSide]
    : [text(cardId), parts.eventIdentity, parts.mode, parts.period, parts.marketType, parts.lineIdentity, parts.lineValue, actualSide]
  if (values.some((value) => value === null || value === undefined || text(value) === '')) {
    throw new TypeError('market-once identity is incomplete')
  }
  const digest = crypto.createHash('sha256').update(lengthPrefixed(values)).digest('hex')
  return `market_once_${digest}`
}

export function buildCardMarketOnceKey({ cardId, signal, lockedSelection } = {}) {
  const mode = text(signal?.evidence?.mode)
  if (!['prematch', 'live'].includes(mode)) throw new TypeError('card-market-once-mode')
  return marketOnceKey({
    eventIdentity: lockedSelection?.eventKey,
    mode,
    market: {
      period: lockedSelection?.period,
      marketType: lockedSelection?.marketType,
      lineKey: lockedSelection?.lineKey,
      handicap: lockedSelection?.handicap,
    },
  }, lockedSelection?.side, { cardId })
}

export function claimMarketOnce(database, claim = {}) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
  if (!claim.change) assertCompatibleSide(text(claim.marketType), claim.actualSide)
  const derivedKey = claim.change ? marketOnceKey(claim.change, claim.actualSide) : ''
  const key = text(claim.marketOnceKey || derivedKey)
  if (derivedKey && claim.marketOnceKey && text(claim.marketOnceKey) !== derivedKey) {
    throw new TypeError('marketOnceKey does not match change and actualSide')
  }
  const ruleId = text(claim.ruleId)
  const bettingMode = text(claim.bettingMode)
  const settingsVersion = claim.settingsVersion
  const modeScoped = ['prematch', 'live'].includes(bettingMode)
    && Number.isSafeInteger(settingsVersion) && settingsVersion >= 1
  if (!key || (!ruleId && !modeScoped)) throw new TypeError('marketOnceKey and claim scope are required')
  const createdAt = text(claim.createdAt) || new Date().toISOString()
  const insert = () => {
    if (claim.mode === 'real') {
      const runtime = database.prepare('SELECT requested,runtime_state FROM real_betting_runtime WHERE singleton_id=1').get()
      if (Number(runtime?.requested) !== 1 || runtime?.runtime_state !== 'running') throw new Error('real-betting-not-requested')
    }
    return database.prepare(`
    INSERT INTO bet_market_once_claims (
      market_once_key, rule_id, betting_mode, settings_version, signal_id, batch_id, claim_status, failure_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', NULL, ?, ?)
    ON CONFLICT(market_once_key) DO NOTHING
    `).run(key, ruleId || null, modeScoped ? bettingMode : null, modeScoped ? settingsVersion : null, text(claim.signalId), claim.batchId ?? null, createdAt, createdAt)
  }
  let result
  if (claim.mode === 'real') {
    database.exec('BEGIN IMMEDIATE')
    try { result = insert(); database.exec('COMMIT') } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      throw error
    }
  } else result = insert()
  const response = { claimed: result.changes === 1, marketOnceKey: key, ruleId: ruleId || null }
  return modeScoped ? { ...response, bettingMode, settingsVersion } : response
}

function rank(matches) {
  return [...matches].sort((a, b) => {
    const priority = (Number.isInteger(a?.priority) ? a.priority : Number.MAX_SAFE_INTEGER)
      - (Number.isInteger(b?.priority) ? b.priority : Number.MAX_SAFE_INTEGER)
    return priority || text(a?.createdAt).localeCompare(text(b?.createdAt)) || text(a?.strategyId || a?.id).localeCompare(text(b?.strategyId || b?.id))
  })
}

export function claimRankedRuleMatches(database, {
  mode = 'simulated',
  change,
  actualSide,
  matches = [],
  claim = {},
  createWinner = null,
} = {}) {
  if (mode === 'real') assertRealBettingRequested(database)
  const ranked = rank(matches)
  const key = marketOnceKey(change, actualSide)
  const audits = ranked.map((match, index) => ({
    ruleId: text(match.strategyId || match.id),
    priority: match.priority ?? null,
    rank: index + 1,
    marketOnceKey: key,
    matched: true,
    claimed: false,
  }))
  if (!ranked.length) return { marketOnceKey: key, audits, winner: null, result: null }
  const selected = ranked[0]
  const ownership = claimMarketOnce(database, {
    ...claim,
    mode,
    marketOnceKey: key,
    change,
    actualSide,
    ruleId: text(selected.strategyId || selected.id),
  })
  if (!ownership.claimed) return { marketOnceKey: key, audits, winner: null, result: null }
  audits[0].claimed = true
  const result = typeof createWinner === 'function' ? createWinner(selected, ownership) : null
  return { marketOnceKey: key, audits, winner: selected, result }
}
