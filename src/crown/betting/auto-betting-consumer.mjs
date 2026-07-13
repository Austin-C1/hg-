import { lockReverseSelection } from './locked-selection.mjs'
import { buildCardMarketOnceKey, marketOnceKey } from './market-once-store.mjs'

const MODES = new Set(['prematch', 'live'])
const EXECUTION_MODES = new Set(['preview', 'simulated', 'real'])
const BATCH_SKIP_REASONS = new Set([
  'preview-incomplete', 'no-account-capacity', 'rule-deleted', 'betting-mode-disabled',
  'migration-review-required', 'real-eligibility-required', 'card-version-changed',
  'card-snapshot-changed', 'signal-invalid',
])

function decimal(value) {
  const input = typeof value === 'number' ? String(value) : value
  if (typeof input !== 'string' || input.length > 128 || !/^\d+(?:\.\d+)?$/.test(input)) return null
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > 18) return null
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function compare(left, right) {
  const scale = Math.max(left.scale, right.scale)
  const a = left.coefficient * 10n ** BigInt(scale - left.scale)
  const b = right.coefficient * 10n ** BigInt(scale - right.scale)
  return a < b ? -1 : a > b ? 1 : 0
}

function skip(reason) { return { status: 'skipped', reason } }

function coherent(item) {
  const settings = item?.settingsSnapshot
  const signal = item?.signal
  return item && typeof item === 'object' && settings && typeof settings === 'object' && !Array.isArray(settings)
    && signal && typeof signal === 'object' && !Array.isArray(signal)
    && typeof item.signalId === 'string' && item.signalId !== '' && signal.signalId === item.signalId
    && MODES.has(item.bettingMode) && signal.evidence?.mode === item.bettingMode
    && Number.isSafeInteger(item.settingsVersion) && item.settingsVersion >= 1
    && settings.mode === item.bettingMode && settings.version === item.settingsVersion
    && typeof settings.enabled === 'boolean'
    && typeof settings.realEligible === 'boolean'
    && typeof settings.migrationReviewRequired === 'boolean'
    && Number.isSafeInteger(settings.realEligibilityVersion) && settings.realEligibilityVersion >= 1
}

function coherentCard(item) {
  const card = item?.cardSnapshot
  const signal = item?.signal
  return item && typeof item === 'object' && card && typeof card === 'object' && !Array.isArray(card)
    && signal && typeof signal === 'object' && !Array.isArray(signal)
    && typeof item.signalId === 'string' && item.signalId !== '' && signal.signalId === item.signalId
    && typeof item.cardId === 'string' && item.cardId.trim() !== '' && card.cardId === item.cardId
    && Number.isSafeInteger(item.cardVersion) && item.cardVersion >= 1 && card.version === item.cardVersion
    && MODES.has(signal.evidence?.mode)
    && typeof card.enabled === 'boolean' && typeof card.realEligible === 'boolean'
    && typeof card.migrationReviewRequired === 'boolean'
    && Number.isSafeInteger(card.realEligibilityVersion) && card.realEligibilityVersion >= 1
}

function validConfiguration(settings) {
  const minimum = decimal(settings.targetOddsMin)
  const maximum = decimal(settings.targetOddsMax)
  return minimum && maximum && compare(minimum, maximum) <= 0
    && Number.isSafeInteger(settings.targetAmountMinor) && settings.targetAmountMinor > 0
    && settings.currency === 'CNY' && settings.amountScale === 0
}

function changeFor(signal, lockedSelection) {
  return {
    eventIdentity: lockedSelection.eventKey,
    mode: signal.evidence.mode,
    market: {
      period: lockedSelection.period,
      marketType: lockedSelection.marketType,
      lineKey: lockedSelection.lineKey,
      handicap: lockedSelection.handicap,
    },
  }
}

export class AutoBettingConsumer {
  constructor({ findLatestSelection, isGlobalRealBettingRequested,
    claimAndCreateCardScopedBatch = null, claimAndCreateModeScopedBatch = null } = {}) {
    const cardPath = typeof claimAndCreateCardScopedBatch === 'function'
    const adapter = cardPath ? claimAndCreateCardScopedBatch : claimAndCreateModeScopedBatch
    for (const [name, value] of Object.entries({ findLatestSelection, isGlobalRealBettingRequested, adapter })) {
      if (typeof value !== 'function') throw new TypeError(`${name} is required`)
    }
    this.findLatestSelection = findLatestSelection
    this.isGlobalRealBettingRequested = isGlobalRealBettingRequested
    this.claimAndCreateCardScopedBatch = claimAndCreateCardScopedBatch
    this.claimAndCreateModeScopedBatch = claimAndCreateModeScopedBatch
    this.cardInboxReady = cardPath
  }

  canProcess() {
    return (this.claimAndCreateCardScopedBatch || this.claimAndCreateModeScopedBatch)?.ready === true
  }

  async process(item, { executionMode, authorizationId = null } = {}) {
    if (!EXECUTION_MODES.has(executionMode)) throw new TypeError('executionMode')
    if (!this.canProcess()) {
      throw Object.assign(new Error('mode-scoped-batch-adapter-unavailable'), {
        code: 'mode-scoped-batch-adapter-unavailable',
      })
    }
    const isCard = item?.cardId !== undefined || item?.cardSnapshot !== undefined
    if (!(isCard ? coherentCard(item) : coherent(item))) return skip('signal-invalid')
    const settings = isCard ? item.cardSnapshot : item.settingsSnapshot
    const bettingMode = isCard ? item.signal.evidence.mode : item.bettingMode
    const direction = item.signal.trigger?.direction
    if (direction === 'down') return skip('water-down-alert-only')
    if (direction !== 'up') return skip('signal-invalid')
    if (settings.enabled !== true) return skip('betting-mode-disabled')
    if (settings.migrationReviewRequired === true) return skip('migration-review-required')
    if (!validConfiguration(settings)) return skip('signal-invalid')
    if (executionMode === 'real' && settings.realEligible !== true) return skip('real-eligibility-required')
    if (executionMode === 'real' && this.isGlobalRealBettingRequested() !== true) return skip('global-real-betting-off')

    const lockedSelection = lockReverseSelection(item.signal, this.findLatestSelection)
    if (!lockedSelection) return skip('market-changed')
    if (lockedSelection.snapshot?.mode !== bettingMode
      || lockedSelection.snapshot?.event?.mode !== bettingMode) return skip('market-changed')
    const odds = decimal(lockedSelection.snapshot?.selection?.oddsRaw ?? lockedSelection.snapshot?.selection?.odds)
    const minimum = decimal(settings.targetOddsMin)
    const maximum = decimal(settings.targetOddsMax)
    if (!odds || compare(odds, minimum) < 0 || compare(odds, maximum) > 0) return skip('target-odds-out-of-range')

    const change = changeFor(item.signal, lockedSelection)
    const key = isCard
      ? buildCardMarketOnceKey({ cardId: item.cardId, signal: item.signal, lockedSelection })
      : marketOnceKey(change, lockedSelection.side)
    const result = await (isCard ? this.claimAndCreateCardScopedBatch : this.claimAndCreateModeScopedBatch)({
      change,
      actualSide: lockedSelection.side,
      signalId: item.signalId,
      signal: item.signal,
      lockedSelection,
      ...(isCard ? { cardId: item.cardId, cardVersion: item.cardVersion, cardSnapshot: settings }
        : { settingsSnapshot: settings, settingsVersion: item.settingsVersion }),
      bettingMode,
      executionMode,
      authorizationId,
      marketOnceKey: key,
      inboxLease: item.inboxLease,
    })
    if (result?.status === 'already-claimed') return skip('market-already-claimed')
    const batchId = typeof result === 'string' ? result : result?.batchId
    if (result?.status === 'batch_created' && typeof batchId === 'string' && batchId.trim()) {
      return { status: 'batch_created', batchId: batchId.trim() }
    }
    if (BATCH_SKIP_REASONS.has(result?.reason)) return { ...skip(result.reason), inboxFinalized: result.inboxFinalized === true }
    throw Object.assign(new Error('batch-create-failed'), { code: 'batch-create-failed' })
  }
}
