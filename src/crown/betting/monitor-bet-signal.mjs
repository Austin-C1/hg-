import crypto from 'node:crypto'

const SUPPORTED_DIRECTION_MODES = new Set(['auto', 'follow', 'reverse'])
const CANONICAL_EVENT_IDENTITY = /^crown\|football\|gid=[^|\s]+$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function canonicalTimestamp(value) {
  if (!ISO_TIMESTAMP.test(String(value || ''))) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export function oppositeSide(side) {
  if (side === 'home') return 'away'
  if (side === 'away') return 'home'
  if (side === 'over') return 'under'
  if (side === 'under') return 'over'
  return null
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function targetOdds(target) {
  return numberOrNull(target?.selection?.odds)
    ?? numberOrNull(target?.selection?.oddsRaw)
    ?? numberOrNull(target?.odds?.value)
    ?? numberOrNull(target?.odds?.raw)
}

function snapshotOdds(snapshot) {
  return targetOdds(snapshot)
}

function directionFromChange(change) {
  const oldOdds = snapshotOdds(change?.old)
  const nextOdds = snapshotOdds(change?.next)
  if (oldOdds === null || nextOdds === null) return null
  if (nextOdds > oldOdds) return 'up'
  if (nextOdds < oldOdds) return 'down'
  return 'flat'
}

function sourceSnapshot(change) {
  return change?.next || null
}

function eventKeyOf(change) {
  const snapshot = sourceSnapshot(change)
  return snapshot?.event?.eventKey || change?.event?.eventKey || snapshot?.event?.eventId || change?.event?.eventId || ''
}

function monitorMeta(decision = {}) {
  return {
    mode: decision.monitorMode || '',
    direction: decision.direction || '',
    delta: decision.delta ?? null,
  }
}

function newCandidateBase(change, monitorDecision = {}, bettingRule = null) {
  return {
    candidateId: `bcand_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    source: 'monitor-alert',
    changeKey: change?.key || '',
    monitor: monitorMeta(monitorDecision),
    bettingRuleId: bettingRule?.id || null,
  }
}

function skipped(change, skipReason, { monitorDecision = {}, bettingRule = null, details = {} } = {}) {
  return {
    ...newCandidateBase(change, monitorDecision, bettingRule),
    status: 'skipped',
    skipReason,
    ...details,
  }
}

function directionMode(rule = {}) {
  if (typeof rule?.monitoredSide === 'string') return 'reverse'
  return SUPPORTED_DIRECTION_MODES.has(rule?.betDirectionMode) ? rule.betDirectionMode : 'auto'
}

function ruleEnabled(rule) {
  return typeof rule?.monitorEnabled === 'boolean' ? rule.monitorEnabled : rule?.enabled !== false
}

function decideAction(mode, direction) {
  if (mode === 'follow') return { action: 'follow', reason: 'rule-follow' }
  if (mode === 'reverse') return { action: 'reverse', reason: 'rule-reverse' }
  if (direction === 'up') return { action: 'reverse', reason: 'monitor-up-reverse' }
  if (direction === 'down') return { action: 'follow', reason: 'monitor-down-follow' }
  return { action: null, reason: 'unsupported-direction' }
}

export function buildMonitorBetCandidate(change, {
  monitorDecision = {},
  bettingRule = null,
  findLatestSelection = null,
} = {}) {
  if (!monitorDecision?.triggered) {
    return skipped(change, 'monitor-not-triggered', { monitorDecision, bettingRule })
  }
  if (!bettingRule) {
    return skipped(change, 'betting-rule-missing', { monitorDecision })
  }
  if (!ruleEnabled(bettingRule)) {
    return skipped(change, 'betting-rule-disabled', { monitorDecision, bettingRule })
  }

  const source = sourceSnapshot(change)
  if (!source) {
    return skipped(change, 'source-selection-missing', { monitorDecision, bettingRule })
  }

  const mode = directionMode(bettingRule)
  const direction = monitorDecision.direction || directionFromChange(change)
  const { action, reason } = decideAction(mode, direction)
  if (!action) {
    return skipped(change, 'unsupported-direction', {
      monitorDecision,
      bettingRule,
      details: { betDirectionMode: mode, direction },
    })
  }

  let target = source
  if (action === 'reverse') {
    const sourceSide = source?.selection?.side || change?.selection?.side || ''
    const targetSide = oppositeSide(sourceSide)
    if (!targetSide) {
      return skipped(change, 'opposite-side-unsupported', {
        monitorDecision,
        bettingRule,
        details: { betDirectionMode: mode, action, sourceSide },
      })
    }
    target = typeof findLatestSelection === 'function'
      ? findLatestSelection({
        provider: 'crown',
        eventKey: eventKeyOf(change),
        period: source?.market?.period || change?.market?.period,
        marketType: source?.market?.marketType || change?.market?.marketType,
        lineKey: source?.market?.lineKey || change?.market?.lineKey || source?.market?.ratioField || change?.market?.ratioField,
        side: targetSide,
      })
      : null
    if (!target) {
      return skipped(change, 'opposite-selection-not-found', {
        monitorDecision,
        bettingRule,
        details: { betDirectionMode: mode, action, sourceSide, targetSide },
      })
    }
  }

  if (target?.selection?.suspended) {
    return skipped(change, 'target-selection-suspended', {
      monitorDecision,
      bettingRule,
      details: { betDirectionMode: mode, action, reason },
    })
  }

  const odds = targetOdds(target)
  const minOdds = numberOrNull(bettingRule.targetOddsMin ?? bettingRule.minOdds) ?? 0
  const maxOdds = numberOrNull(bettingRule.targetOddsMax ?? bettingRule.maxOdds)
  if (odds === null) {
    return skipped(change, 'target-odds-missing', {
      monitorDecision,
      bettingRule,
      details: { betDirectionMode: mode, action, reason },
    })
  }
  if (minOdds > 0 && odds < minOdds) {
    return skipped(change, 'betting-odds-below-min', {
      monitorDecision,
      bettingRule,
      details: { betDirectionMode: mode, action, reason, odds, minOdds },
    })
  }
  if (maxOdds !== null && odds > maxOdds) {
    return skipped(change, 'betting-odds-above-max', {
      monitorDecision,
      bettingRule,
      details: { betDirectionMode: mode, action, reason, odds, maxOdds },
    })
  }

  return {
    ...newCandidateBase(change, monitorDecision, bettingRule),
    status: 'eligible',
    action,
    reason,
    betDirectionMode: mode,
    minOdds,
    maxOdds,
    odds,
    event: target.event || change?.event || null,
    market: target.market || change?.market || null,
    sourceSelection: source.selection || change?.selection || null,
    target,
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function signalCandidateBase(signal, { bettingRuleId }) {
  return {
    schemaVersion: 2,
    candidateId: sha256(`${signal.signalId}|${bettingRuleId || 'unbound'}`),
    signalId: signal.signalId,
    source: 'monitor-signal',
    createdAt: signal.observedAt,
    observedAt: signal.observedAt,
    expiresAt: signal.expiresAt,
    strategy: {
      id: signal.strategyId,
      version: signal.strategyVersion,
    },
    bettingRuleId: bettingRuleId || null,
    trigger: signal.trigger,
    evidence: signal.evidence,
    dataQuality: signal.dataQuality,
    canonical: {
      eventIdentity: signal.target.eventIdentity,
      marketIdentity: signal.target.marketIdentity,
      sourceSelectionIdentity: signal.target.selectionIdentity,
    },
  }
}

function skippedSignalCandidate(signal, skipReason, options, details = {}) {
  return {
    ...signalCandidateBase(signal, options),
    status: 'skipped',
    action: null,
    reason: skipReason,
    skipReason,
    ...details,
  }
}

function deferredSignalCandidate(signal, deferReason, options, details = {}) {
  return {
    ...signalCandidateBase(signal, options),
    status: 'deferred',
    action: null,
    reason: deferReason,
    deferReason,
    ...details,
  }
}

function canonicalSignalParts(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) throw new TypeError('signal is required')
  if (signal.schemaVersion !== 2) throw new TypeError('signal.schemaVersion must be 2')
  if (!/^[a-f0-9]{64}$/.test(String(signal.signalId || ''))) throw new TypeError('signal.signalId must be a SHA-256 hash')
  if (!CANONICAL_EVENT_IDENTITY.test(String(signal.target?.eventIdentity || ''))) {
    throw new TypeError('signal.target.eventIdentity must be canonical')
  }
  const marketIdentity = String(signal.target?.marketIdentity || '')
  const prefix = `${signal.target.eventIdentity}|`
  const marketParts = marketIdentity.startsWith(prefix) ? marketIdentity.slice(prefix.length).split('|') : []
  if (marketParts.length !== 3 || marketParts.some((part) => !part)) {
    throw new TypeError('signal.target.marketIdentity must be canonical')
  }
  const [period, marketType, lineKey] = marketParts
  const side = String(signal.target?.side || '')
  if (!side || signal.target?.selectionIdentity !== `${marketIdentity}|${side}`) {
    throw new TypeError('signal.target.selectionIdentity must be canonical')
  }
  for (const [name, value] of [['observedAt', signal.observedAt], ['expiresAt', signal.expiresAt]]) {
    if (!canonicalTimestamp(value)) {
      throw new TypeError(`signal.${name} must be a canonical timestamp`)
    }
  }
  return { eventKey: signal.target.eventIdentity, marketIdentity, period, marketType, lineKey, side }
}

function unwrappedSnapshot(value) {
  if (value?.snapshot && typeof value.snapshot === 'object') return value.snapshot
  return value
}

function snapshotSelectionIdentity(value) {
  return value?.selection?.selectionIdentity
    || value?.selectionIdentity
    || ''
}

function snapshotMarketIdentity(value) {
  return value?.market?.marketIdentity
    || value?.marketIdentity
    || ''
}

function snapshotCapturedAt(value) {
  return value?.capturedAt || ''
}

function lookupSnapshot(findLatestSelection, query) {
  if (typeof findLatestSelection !== 'function') return null
  return unwrappedSnapshot(findLatestSelection(query)) || null
}

function validateTargetSnapshot(signal, snapshot, expected, { now, bettingRule, action, reason, sourceSnapshot: source }) {
  const baseOptions = { bettingRuleId: signal.bettingRuleId, now }
  if (!snapshot) {
    return skippedSignalCandidate(signal, expected.side === signal.target.side ? 'source-selection-missing' : 'opposite-selection-not-found', baseOptions, {
      action,
      reason,
    })
  }
  if (snapshotSelectionIdentity(snapshot) !== expected.selectionIdentity
    || snapshotMarketIdentity(snapshot) !== expected.marketIdentity
    || snapshot?.event?.eventKey !== expected.eventKey) {
    return skippedSignalCandidate(signal, 'target-identity-mismatch', baseOptions, { action, reason })
  }
  const capturedAt = snapshotCapturedAt(snapshot)
  if (!canonicalTimestamp(capturedAt)) {
    return skippedSignalCandidate(signal, 'target-state-invalid', baseOptions, { action, reason })
  }
  if (Date.parse(capturedAt) < Date.parse(signal.observedAt)) {
    return skippedSignalCandidate(signal, 'target-state-stale', baseOptions, { action, reason })
  }
  if (Date.parse(capturedAt) > Date.parse(now)) {
    return skippedSignalCandidate(signal, 'target-state-invalid', baseOptions, { action, reason })
  }
  if (snapshot?.selection?.suspended === true) {
    return skippedSignalCandidate(signal, 'target-selection-suspended', baseOptions, { action, reason })
  }
  const odds = targetOdds(snapshot)
  if (odds === null) return skippedSignalCandidate(signal, 'target-odds-missing', baseOptions, { action, reason })
  const minOdds = numberOrNull(bettingRule.targetOddsMin ?? bettingRule.minOdds)
  const maxOdds = numberOrNull(bettingRule.targetOddsMax ?? bettingRule.maxOdds)
  if (minOdds !== null && odds < minOdds) {
    return skippedSignalCandidate(signal, 'betting-odds-below-min', baseOptions, { action, reason, odds, minOdds })
  }
  if (maxOdds !== null && odds > maxOdds) {
    return skippedSignalCandidate(signal, 'betting-odds-above-max', baseOptions, { action, reason, odds, maxOdds })
  }
  return {
    ...signalCandidateBase(signal, baseOptions),
    status: 'eligible',
    action,
    reason,
    betDirectionMode: directionMode(bettingRule),
    minOdds,
    maxOdds,
    odds,
    sourceSelection: source,
    target: snapshot,
    canonical: {
      eventIdentity: expected.eventKey,
      marketIdentity: expected.marketIdentity,
      sourceSelectionIdentity: signal.target.selectionIdentity,
      targetSelectionIdentity: expected.selectionIdentity,
    },
  }
}

export function buildMonitorBetCandidateFromSignal(signal, {
  bettingRule = null,
  findLatestSelection = null,
  now = new Date().toISOString(),
  deferUnresolvedBinding = false,
} = {}) {
  const parts = canonicalSignalParts(signal)
  if (!canonicalTimestamp(now)) {
    throw new TypeError('now must be a canonical timestamp')
  }
  const boundId = typeof signal.bettingRuleId === 'string' && signal.bettingRuleId.trim()
    ? signal.bettingRuleId.trim()
    : null
  const baseOptions = { bettingRuleId: boundId, now }
  if (!boundId) {
    if (deferUnresolvedBinding) return deferredSignalCandidate(signal, 'betting-rule-version-unavailable', baseOptions)
    return skippedSignalCandidate(signal, 'betting-rule-unbound', baseOptions, { bindingStatus: 'unbound' })
  }
  if (!bettingRule || bettingRule.id !== boundId) {
    if (deferUnresolvedBinding) return deferredSignalCandidate(signal, 'betting-rule-version-unavailable', baseOptions)
    return skippedSignalCandidate(signal, 'betting-rule-unbound', baseOptions, { bindingStatus: 'not-found' })
  }
  const canonicalBinding = deferUnresolvedBinding || signal.strategyId === boundId
  if (canonicalBinding && bettingRule.version !== signal.strategyVersion) {
    return deferredSignalCandidate(signal, 'betting-rule-version-unavailable', baseOptions, {
      requiredVersion: signal.strategyVersion,
      availableVersion: bettingRule.version ?? null,
    })
  }
  if (!ruleEnabled(bettingRule)) {
    if (deferUnresolvedBinding) return deferredSignalCandidate(signal, 'betting-rule-version-unavailable', baseOptions)
    return skippedSignalCandidate(signal, 'betting-rule-unbound', baseOptions, { bindingStatus: 'disabled' })
  }
  if (Date.parse(now) >= Date.parse(signal.expiresAt)) {
    return skippedSignalCandidate(signal, 'signal-expired', baseOptions)
  }
  if (signal.status !== 'pending') {
    return skippedSignalCandidate(signal, 'signal-not-pending', baseOptions)
  }
  if (bettingRule.marketType && bettingRule.marketType !== parts.marketType) {
    return skippedSignalCandidate(signal, 'betting-market-mismatch', baseOptions, {
      configuredMarketType: bettingRule.marketType,
      signalMarketType: parts.marketType,
    })
  }

  const mode = directionMode(bettingRule)
  const { action, reason } = decideAction(mode, signal.trigger?.direction)
  if (!action) return skippedSignalCandidate(signal, 'unsupported-direction', baseOptions)
  const commonQuery = {
    provider: 'crown',
    eventKey: parts.eventKey,
    period: parts.period,
    marketType: parts.marketType,
    lineKey: parts.lineKey,
  }
  const source = lookupSnapshot(findLatestSelection, { ...commonQuery, side: parts.side })
  if (!source) return skippedSignalCandidate(signal, 'source-selection-missing', baseOptions, { action, reason })
  if (snapshotSelectionIdentity(source) !== signal.target.selectionIdentity
    || snapshotMarketIdentity(source) !== parts.marketIdentity
    || source?.event?.eventKey !== parts.eventKey) {
    return skippedSignalCandidate(signal, 'source-identity-mismatch', baseOptions, { action, reason })
  }
  if (action === 'reverse') {
    const sourceCapturedAt = snapshotCapturedAt(source)
    if (!canonicalTimestamp(sourceCapturedAt) || Date.parse(sourceCapturedAt) > Date.parse(now)) {
      return skippedSignalCandidate(signal, 'source-state-invalid', baseOptions, { action, reason })
    }
    if (Date.parse(sourceCapturedAt) < Date.parse(signal.observedAt)) {
      return skippedSignalCandidate(signal, 'source-state-stale', baseOptions, { action, reason })
    }
    if (source?.selection?.suspended === true) {
      return skippedSignalCandidate(signal, 'source-selection-suspended', baseOptions, { action, reason })
    }
    if (targetOdds(source) === null) {
      return skippedSignalCandidate(signal, 'source-odds-missing', baseOptions, { action, reason })
    }
  }
  const targetSide = action === 'reverse' ? oppositeSide(parts.side) : parts.side
  if (!targetSide) return skippedSignalCandidate(signal, 'opposite-side-unsupported', baseOptions, { action, reason })
  const target = action === 'follow'
    ? source
    : lookupSnapshot(findLatestSelection, { ...commonQuery, side: targetSide })
  return validateTargetSnapshot(signal, target, {
    eventKey: parts.eventKey,
    marketIdentity: parts.marketIdentity,
    selectionIdentity: `${parts.marketIdentity}|${targetSide}`,
    side: targetSide,
  }, { now, bettingRule, action, reason, sourceSnapshot: source })
}
