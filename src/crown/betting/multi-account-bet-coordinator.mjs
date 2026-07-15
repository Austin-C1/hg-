import { createHash } from 'node:crypto'

import { matchRuleForSignal } from './betting-rule-matcher.mjs'
import { lockReverseSelection } from './locked-selection.mjs'
import { allocateStake } from './stake-allocator.mjs'
import { assertRealBettingRequested } from './real-betting-runtime.mjs'
import { cancelAuthorizedUnsubmitted } from './execution-gate.mjs'
import { deterministicSubmitAttemptId } from './b2-executor.mjs'
import { isCanonicalRealRule } from './canonical-real-rule.mjs'
import { isSafetyFinishReason } from './safety-finish-reasons.mjs'

const TERMINAL_BATCH = new Set(['completed', 'partial', 'failed', 'cancelled'])

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function safeMinor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function exactDecimal(value) {
  const source = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof source !== 'string' || !/^\d+(?:\.\d+)?$/.test(source)) return null
  const [whole, fraction = ''] = source.split('.')
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function compareDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale)
  const a = left.coefficient * 10n ** BigInt(scale - left.scale)
  const b = right.coefficient * 10n ** BigInt(scale - right.scale)
  return a < b ? -1 : a > b ? 1 : 0
}

function frozenOddsRange(batch) {
  let source = batch
  if (batch.rule_id) source = parseJson(batch.rule_snapshot_json, {}).rule
  else if (batch.card_id) source = parseJson(batch.card_snapshot_json, {})
  else if (batch.settings_version) source = parseJson(batch.settings_snapshot_json, {})
  const minimum = exactDecimal(source?.changedOddsMin ?? source?.targetOddsMin ?? source?.target_odds_min)
  const maximum = exactDecimal(source?.changedOddsMax ?? source?.targetOddsMax ?? source?.target_odds_max)
  return minimum && maximum && compareDecimal(minimum, maximum) <= 0 ? { minimum, maximum } : null
}

function oddsInFrozenRange(batch, value) {
  const range = frozenOddsRange(batch)
  const odds = exactDecimal(value)
  return Boolean(range && odds
    && compareDecimal(odds, range.minimum) >= 0
    && compareDecimal(odds, range.maximum) <= 0)
}

function submitAttemptId(childOrderId) {
  return createHash('sha256').update(`simulated-submit\n${childOrderId}`, 'utf8').digest('hex')
}

function snapshotValue(value) {
  return value?.snapshot && typeof value.snapshot === 'object' ? value.snapshot : value
}

function canonicalTimestamp(value) {
  const text = String(value || '')
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) return null
  try {
    return new Date(milliseconds).toISOString() === text ? milliseconds : null
  } catch {
    return null
  }
}

function sameStage(signal, latest, original) {
  const expectedMode = signal?.evidence?.mode
  if (!['prematch', 'live'].includes(expectedMode)) return false
  if (latest?.mode !== expectedMode || original?.mode !== expectedMode) return false
  if (latest?.event?.mode !== undefined && latest.event.mode !== expectedMode) return false
  if (original?.event?.mode !== undefined && original.event.mode !== expectedMode) return false
  const expectedPhase = expectedMode === 'live' ? signal?.evidence?.livePhase : null
  return (latest?.event?.livePhase ?? null) === expectedPhase
    && (original?.event?.livePhase ?? null) === expectedPhase
}

function sameLockedIdentity(current, original, batch) {
  if (!current || !original) return false
  const persistedSelectionIdentity = batch.rule_id === null
    ? original.selectionIdentity
    : batch.locked_selection_identity
  return current.eventKey === batch.event_key
    && current.selectionIdentity === persistedSelectionIdentity
    && current.eventKey === original.eventKey
    && current.period === original.period
    && current.marketType === original.marketType
    && current.lineKey === original.lineKey
    && current.marketIdentity === original.marketIdentity
    && current.side === original.side
    && current.selectionIdentity === original.selectionIdentity
    && current.handicap === original.handicap
}

function ruleFromRow(row) {
  if (!row) return null
  const canonicalReal = isCanonicalRealRule(row)
  return {
    id: row.id,
    version: row.version,
    enabled: canonicalReal,
    executionMode: canonicalReal ? 'real_eligible' : 'preview_only',
    direction: 'up_reverse',
    leagueNames: parseJson(row.league_names_json, []),
    changedOddsMin: Number(row.target_odds_min),
    changedOddsMax: Number(row.target_odds_max),
    currency: row.currency,
    amountScale: row.amount_scale,
    targetAmountMinor: row.target_amount_minor,
  }
}

export class MultiAccountBetCoordinator {
  constructor({
    db,
    store,
    provider,
    lease,
    findLatestSelection,
    currentLeagueNames = [],
    now = () => new Date().toISOString(),
    faultInjector = null,
    maxRounds = 100,
    realExecutionGate = assertRealBettingRequested,
    processLease = null,
    b2Executor = null,
    executionEnvironment = process.env,
  } = {}) {
    if (!db?.prepare) throw new TypeError('coordinator-db')
    if (!store) throw new TypeError('coordinator-store')
    if (typeof store.leaseKey !== 'string' || store.leaseKey === '') throw new TypeError('coordinator-store-lease')
    if (typeof provider?.preview !== 'function') throw new TypeError('coordinator-provider')
    if (b2Executor !== null && typeof b2Executor?.submit !== 'function') throw new TypeError('coordinator-b2-executor')
    if (typeof provider?.submit !== 'function' && typeof b2Executor?.submit !== 'function') {
      throw new TypeError('coordinator-provider')
    }
    if (!lease?.assertFence) throw new TypeError('coordinator-lease')
    if (store.leaseKey !== lease.leaseKey) throw new TypeError('coordinator-store-lease')
    if (typeof findLatestSelection !== 'function') throw new TypeError('findLatestSelection')
    if (typeof now !== 'function') throw new TypeError('coordinator-now')
    if (faultInjector !== null && typeof faultInjector !== 'function') throw new TypeError('faultInjector')
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new TypeError('maxRounds')
    this.db = db
    this.store = store
    this.provider = provider
    this.lease = lease
    this.findLatestSelection = findLatestSelection
    this.currentLeagueNames = currentLeagueNames
    this.now = now
    this.faultInjector = faultInjector
    this.maxRounds = maxRounds
    this.realExecutionGate = realExecutionGate
    this.processLease = processLease
    this.b2Executor = b2Executor
    this.executionEnvironment = executionEnvironment
    this.claimAndCreateModeScopedBatch = this._claimAndCreateModeScopedBatch.bind(this)
    this.claimAndCreateModeScopedBatch.ready = true
    this.claimAndCreateCardScopedBatch = this._claimAndCreateCardScopedBatch.bind(this)
    this.claimAndCreateCardScopedBatch.ready = true
  }

  async _claimAndCreateCardScopedBatch(input = {}) {
    const card = input.cardSnapshot
    if (!card || typeof card !== 'object' || Array.isArray(card)
      || !['prematch', 'live'].includes(input.bettingMode)
      || card.cardId !== input.cardId || card.version !== input.cardVersion
      || input.signal?.signalId !== input.signalId || input.signal?.evidence?.mode !== input.bettingMode) {
      throw new Error('card-scoped-input-incoherent')
    }
    if (!['simulated', 'preview', 'real'].includes(input.executionMode)) throw new TypeError('coordinator-mode')
    if (input.executionMode === 'real') {
      this.realExecutionGate(this.db)
    }
    const existingClaim = this.db.prepare('SELECT batch_id FROM bet_market_once_claims WHERE market_once_key=?')
      .get(input.marketOnceKey)
    if (existingClaim) return { status: 'already-claimed', batchId: existingClaim.batch_id || null }
    const fencingToken = this._fence()
    const previewBatch = { batch_id: `card-preview:${input.signalId}:${input.cardId}:${input.cardVersion}`,
      currency: card.currency, amount_scale: card.amountScale, unfilled_amount_minor: card.targetAmountMinor,
      targetOddsMin: card.targetOddsMin, targetOddsMax: card.targetOddsMax }
    const accounts = this._accounts(previewBatch, new Set())
    if (accounts.length === 0) return { status: 'skipped', reason: 'no-account-capacity' }
    const previews = await this._previewAccounts(previewBatch, input.lockedSelection, accounts)
    this._fence()
    if (previews.length === 0) return { status: 'skipped', reason: 'preview-incomplete' }
    const allocation = allocateStake(card.targetAmountMinor, previews.map((item) => item.capability))
    if (allocation.allocations.length === 0) return { status: 'skipped', reason: 'no-account-capacity' }
    const byAccount = new Map(previews.map((item) => [item.account.id, item]))
    const reservations = allocation.allocations.map((item) => {
      const preview = byAccount.get(item.accountId)
      return { ...item, previewMinStakeMinor: preview.capability.minStakeMinor,
        previewMaxStakeMinor: preview.capability.maxStakeMinor,
        previewBalanceMinor: preview.preview.balanceMinor ?? preview.account.balance_minor,
        previewStakeStepMinor: preview.capability.stakeStepMinor,
        previewOdds: String(preview.preview.odds ?? preview.preview.oddsRaw ?? '') }
    })
    const batchInput = {
      signalId: input.signalId, signalSnapshot: input.signal, inboxLease: input.inboxLease,
      lockedSelection: input.lockedSelection, cardId: input.cardId, cardVersion: input.cardVersion,
      cardSnapshot: card, bettingMode: input.bettingMode,
      authorizationId: null,
      eventKey: input.lockedSelection?.eventKey, lockedSelectionIdentity: JSON.stringify(input.lockedSelection || {}),
      sourceLeague: input.signal?.evidence?.leagueName || '',
      sourceOdds: String(input.lockedSelection?.snapshot?.selection?.oddsRaw ?? input.lockedSelection?.snapshot?.selection?.odds ?? ''),
      observedAt: input.signal?.observedAt || '', currency: card.currency, amountScale: card.amountScale,
      targetAmountMinor: card.targetAmountMinor, createdAt: this.now(),
    }
    return this.store.claimAndCreateCardScopedBatch(batchInput, reservations, {
      fencingToken, marketOnceKey: input.marketOnceKey, requireRealRuntime: input.executionMode === 'real',
      realLeaseEvidence: this._realLeaseEvidence(input.executionMode),
    })
  }

  async _claimAndCreateModeScopedBatch(input = {}) {
    const settings = input.settingsSnapshot
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !['prematch', 'live'].includes(input.bettingMode)
      || settings.mode !== input.bettingMode || settings.version !== input.settingsVersion
      || input.signal?.signalId !== input.signalId || input.signal?.evidence?.mode !== input.bettingMode) {
      throw new Error('mode-scoped-input-incoherent')
    }
    if (!['simulated', 'preview', 'real'].includes(input.executionMode)) throw new TypeError('coordinator-mode')
    if (input.executionMode === 'real') {
      this.realExecutionGate(this.db)
    }
    const current = this.db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(input.bettingMode)
    if (!current || Number(current.version) !== input.settingsVersion) throw new Error('settings-version-changed')
    if (Number(current.enabled) !== 1) return { status: 'skipped', reason: 'betting-mode-disabled' }
    if (Number(current.migration_review_required) !== 0) return { status: 'skipped', reason: 'migration-review-required' }
    if (current.currency !== settings.currency || Number(current.amount_scale) !== Number(settings.amountScale)
      || Number(current.target_amount_minor) !== Number(settings.targetAmountMinor)) {
      throw new Error('settings-snapshot-changed')
    }
    const existingClaim = this.db.prepare(`
      SELECT batch_id FROM bet_market_once_claims WHERE market_once_key=?
    `).get(input.marketOnceKey)
    if (existingClaim) return { status: 'already-claimed', batchId: existingClaim.batch_id || null }
    const fencingToken = this._fence()
    const previewBatch = {
      batch_id: `mode-preview:${input.signalId}:${input.bettingMode}:${input.settingsVersion}`,
      currency: settings.currency,
      amount_scale: settings.amountScale,
      unfilled_amount_minor: settings.targetAmountMinor,
      targetOddsMin: settings.targetOddsMin,
      targetOddsMax: settings.targetOddsMax,
    }
    const accounts = this._accounts(previewBatch, new Set())
    if (accounts.length === 0) return { status: 'skipped', reason: 'no-account-capacity' }
    const previews = await this._previewAccounts(previewBatch, input.lockedSelection, accounts)
    this._fence()
    if (previews.length === 0) return { status: 'skipped', reason: 'preview-incomplete' }
    const allocation = allocateStake(settings.targetAmountMinor, previews.map((item) => item.capability))
    if (allocation.allocations.length === 0) return { status: 'skipped', reason: 'no-account-capacity' }
    const byAccount = new Map(previews.map((item) => [item.account.id, item]))
    const reservations = allocation.allocations.map((item) => {
      const preview = byAccount.get(item.accountId)
      return {
        ...item,
        previewMinStakeMinor: preview.capability.minStakeMinor,
        previewMaxStakeMinor: preview.capability.maxStakeMinor,
        previewBalanceMinor: preview.preview.balanceMinor ?? preview.account.balance_minor,
        previewStakeStepMinor: preview.capability.stakeStepMinor,
        previewOdds: String(preview.preview.odds ?? preview.preview.oddsRaw ?? ''),
      }
    })
    const batchInput = {
      signalId: input.signalId,
      signalSnapshot: input.signal,
      inboxLease: input.inboxLease,
      lockedSelection: input.lockedSelection,
      bettingMode: input.bettingMode,
      settingsVersion: input.settingsVersion,
      settingsSnapshot: settings,
      authorizationId: null,
      eventKey: input.lockedSelection?.eventKey,
      lockedSelectionIdentity: JSON.stringify(input.lockedSelection || {}),
      sourceLeague: input.signal?.evidence?.leagueName || '',
      sourceOdds: String(input.lockedSelection?.snapshot?.selection?.oddsRaw ?? input.lockedSelection?.snapshot?.selection?.odds ?? ''),
      observedAt: input.signal?.observedAt || '',
      currency: settings.currency,
      amountScale: settings.amountScale,
      targetAmountMinor: settings.targetAmountMinor,
      createdAt: this.now(),
    }
    return this.store.claimAndCreateModeScopedBatch(batchInput, reservations, {
      fencingToken, marketOnceKey: input.marketOnceKey, requireRealRuntime: input.executionMode === 'real',
      realLeaseEvidence: this._realLeaseEvidence(input.executionMode),
    })
  }

  _fault(phase, details = {}) {
    this.faultInjector?.(phase, details)
  }

  _fence() {
    return this.lease.assertFence(this.lease.fencingToken)
  }

  _realLeaseEvidence(mode) {
    if (mode !== 'real') return null
    if (!this.processLease) throw new Error('real-betting-worker-fence-required')
    return {
      worker: { leaseKey: this.processLease.leaseKey, ownerId: this.processLease.ownerId, fencingToken: this.processLease.fencingToken },
      executor: { leaseKey: this.lease.leaseKey, ownerId: this.lease.ownerId, fencingToken: this.lease.fencingToken },
    }
  }

  _batchRow(batchId) {
    return this.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
  }

  _rule(ruleId) {
    return ruleFromRow(this.db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
  }

  _canonicalClaim(signalId, ruleId) {
    return this.db.prepare(`
      SELECT market_once_key, batch_id, claim_status, failure_reason
      FROM bet_market_once_claims
      WHERE signal_id = ? AND rule_id = ?
      ORDER BY created_at, market_once_key
      LIMIT 1
    `).get(signalId, ruleId)
  }

  _canonicalBatch(batchId) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM bet_market_once_claims
      WHERE batch_id = ? AND claim_status = 'batch_created'
      LIMIT 1
    `).get(batchId))
  }

  _recordAllocationFailure(claim, allocationError) {
    let claimError = null
    try {
      this._fault('beforeAllocationFailureClaimUpdate', { marketOnceKey: claim.market_once_key })
      this.db.exec('BEGIN IMMEDIATE')
      const reason = String(allocationError?.code || allocationError?.message || 'allocation-failed').slice(0, 160)
      const changed = this.db.prepare(`
        UPDATE bet_market_once_claims
        SET claim_status = 'allocation_failed', failure_reason = ?, updated_at = ?
        WHERE market_once_key = ? AND claim_status = 'claimed'
      `).run(reason, this.now(), claim.market_once_key)
      if (changed.changes !== 1) throw new Error('market-once-allocation-failure-transition')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      claimError = error
    }
    if (claimError) allocationError.cause = claimError
    throw allocationError
  }

  _batchInput(match, rule, lockedSelection) {
    return {
      signalId: match.signalId,
      ruleId: match.ruleId,
      eventKey: lockedSelection.eventKey,
      lockedSelectionIdentity: lockedSelection.selectionIdentity,
      ruleVersion: rule.version,
      ruleSnapshot: { rule, lockedSelection },
      sourceLeague: match.sourceLeague,
      sourceOdds: String(match.sourceOdds),
      observedAt: match.observedAt,
      currency: rule.currency,
      amountScale: rule.amountScale,
      targetAmountMinor: rule.targetAmountMinor,
      createdAt: this.now(),
      authorizationId: null,
    }
  }

  _leagues(signal) {
    return typeof this.currentLeagueNames === 'function' ? this.currentLeagueNames(signal) : this.currentLeagueNames
  }

  _executionAudit(batch) {
    const row = this.db.prepare(`
      SELECT signal_id, expires_at, payload_json
      FROM monitor_signals
      WHERE signal_id = ?
    `).get(batch.signal_id)
    if (!row) return { stopReason: 'signal_invalid' }

    let signal
    try { signal = JSON.parse(row.payload_json) } catch { return { stopReason: 'signal_invalid' } }
    const observedAt = canonicalTimestamp(signal?.observedAt)
    const expiresAt = canonicalTimestamp(signal?.expiresAt)
    const persistedExpiresAt = canonicalTimestamp(row.expires_at)
    const now = canonicalTimestamp(this.now())
    if (signal?.signalId !== batch.signal_id || observedAt === null || expiresAt === null || persistedExpiresAt === null || now === null) {
      return { stopReason: 'signal_invalid' }
    }
    if (signal.expiresAt !== row.expires_at) return { stopReason: 'signal_invalid' }
    if (now >= expiresAt) return { stopReason: 'expired' }
    if (signal?.evidence?.mode === 'prematch') {
      const minutes = signal.evidence.minutesBeforeKickoff
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
        return { stopReason: 'signal_invalid' }
      }
      const kickoff = observedAt + minutes * 60_000
      if (!Number.isFinite(kickoff)) return { stopReason: 'signal_invalid' }
      if (now >= kickoff) return { stopReason: 'stage_changed' }
    }

    const batchSnapshot = parseJson(batch.rule_snapshot_json, {})
    const originalLock = batch.rule_id === null
      ? parseJson(batch.locked_selection_identity, null)
      : batchSnapshot.lockedSelection
    if (!originalLock) return { stopReason: 'signal_invalid' }

    let latestSnapshot = null
    const lockedSelection = lockReverseSelection(signal, (query) => {
      const value = this.findLatestSelection(query)
      latestSnapshot = snapshotValue(value)
      return value
    })
    if (!sameStage(signal, latestSnapshot, originalLock.snapshot)) return { stopReason: 'stage_changed' }
    if (!lockedSelection || !sameLockedIdentity(lockedSelection, originalLock, batch)) {
      return { stopReason: 'market_changed' }
    }
    const latestOdds = String(lockedSelection.snapshot?.selection?.oddsRaw
      ?? lockedSelection.snapshot?.selection?.odds ?? '')
    if (!oddsInFrozenRange(batch, latestOdds)) return { stopReason: 'market_changed' }
    return { signal, lockedSelection, stopReason: '' }
  }

  _stopBatch(batchId, stopReason, fencingToken) {
    const batch = this._batchRow(batchId)
    if (batch?.authorization_id) {
      return cancelAuthorizedUnsubmitted(this.db, {
        authorizationId: batch.authorization_id,
        batchId,
        finishReason: stopReason,
        ruleId: batch.rule_id,
        leaseKey: this.lease.leaseKey,
        executorOwnerId: this.lease.ownerId,
        fencingToken,
      }, { now: () => new Date(this.now()) }).batch
    }
    return this.store.cancelUnsubmitted(batchId, {
      finishReason: stopReason,
      fencingToken,
      at: this.now(),
    })
  }

  _hasUncertainSubmission(batchId) {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM bet_child_orders
      WHERE batch_id = ? AND status IN ('submit_prepared', 'submit_dispatched', 'unknown')
      LIMIT 1
    `).get(batchId))
  }

  recover(fencingToken = this._fence()) {
    this.lease.assertFence(fencingToken)
    this.b2Executor?.recoverAcceptance?.()
    return this.store.recover({ fencingToken, at: this.now() })
  }

  async processSignal(signal, { mode = 'simulated' } = {}) {
    if (!['simulated', 'preview', 'real'].includes(mode)) throw new TypeError('coordinator-mode')
    if (mode === 'real') this.realExecutionGate(this.db)
    const fencingToken = this._fence()
    const ruleId = signal?.bettingRuleId
    const signalId = signal?.signalId
    const claim = ['simulated', 'real'].includes(mode) && signalId && ruleId ? this._canonicalClaim(signalId, ruleId) : null
    if (claim?.claim_status === 'allocation_failed') {
      return {
        mode,
        status: 'allocation_failed',
        marketOnceKey: claim.market_once_key,
        signalId,
        ruleId,
        failureReason: String(claim.failure_reason || 'allocation-failed'),
      }
    }
    if (claim?.claim_status === 'batch_created') {
      if (!String(claim.batch_id || '')) throw new Error('market-once-batch-missing')
      return this.runBatch(claim.batch_id, { mode })
    }
    const rule = this._rule(ruleId)
    const match = matchRuleForSignal(signal, { rule, currentLeagueNames: this._leagues(signal), now: this.now() })
    if (!match) return null
    const lockedSelection = lockReverseSelection(signal, this.findLatestSelection)
    if (!lockedSelection) return null
    if (mode === 'preview') {
      const previewBatch = {
        batch_id: match.batchId,
        currency: rule.currency,
        amount_scale: rule.amountScale,
        unfilled_amount_minor: rule.targetAmountMinor,
        targetOddsMin: rule.changedOddsMin,
        targetOddsMax: rule.changedOddsMax,
      }
      const previews = await this._previewAccounts(previewBatch, lockedSelection, this._accounts(previewBatch, new Set()))
      this._fence()
      const allocation = allocateStake(rule.targetAmountMinor, previews.map((item) => item.capability))
      return {
        mode: 'preview',
        status: 'preview_only',
        batchId: match.batchId,
        signalId: match.signalId,
        ruleId: match.ruleId,
        allocations: allocation.allocations,
        allocatedMinor: allocation.allocatedMinor,
        unfilledMinor: allocation.unfilledMinor,
      }
    }
    const batchInput = this._batchInput(match, rule, lockedSelection)
    if (claim?.claim_status === 'claimed') {
      const previewBatch = {
        batch_id: match.batchId,
        currency: rule.currency,
        amount_scale: rule.amountScale,
        unfilled_amount_minor: rule.targetAmountMinor,
        targetOddsMin: rule.changedOddsMin,
        targetOddsMax: rule.changedOddsMax,
      }
      let created
      try {
        const previews = await this._firstUsablePreview(previewBatch, lockedSelection, this._accounts(previewBatch, new Set()))
        if (mode === 'real') this.realExecutionGate(this.db)
        this._fence()
        const allocation = allocateStake(rule.targetAmountMinor, previews.map((item) => item.capability))
        if (allocation.allocations.length === 0) throw new Error('allocation-no-spendable-account')
        const byAccount = new Map(previews.map((item) => [item.account.id, item]))
        const reservations = allocation.allocations.map((item) => {
          const preview = byAccount.get(item.accountId)
          return {
            ...item,
            previewMinStakeMinor: preview.capability.minStakeMinor,
            previewMaxStakeMinor: preview.capability.maxStakeMinor,
            previewBalanceMinor: preview.preview.balanceMinor ?? preview.account.balance_minor,
            previewStakeStepMinor: preview.capability.stakeStepMinor,
            previewOdds: String(preview.preview.odds ?? preview.preview.oddsRaw ?? ''),
          }
        })
        const allocationOptions = {
          fencingToken,
          marketOnceKey: claim.market_once_key,
          requireRealRuntime: mode === 'real',
          realLeaseEvidence: this._realLeaseEvidence(mode),
        }
        created = this.store.createBatchWithReservations(batchInput, reservations, allocationOptions)
      } catch (error) {
        return this._recordAllocationFailure(claim, error)
      }
      this._fault('afterReserve', { batchId: created.batch.batchId, children: created.children })
      return this.runBatch(created.batch.batchId, { mode })
    }
    if (mode === 'real') throw new Error('market-once-claim-required')
    const batch = this.store.createBatch(batchInput, { fencingToken, requireRealRuntime: mode === 'real', realLeaseEvidence: this._realLeaseEvidence(mode) })
    return this.runBatch(batch.batchId, { mode })
  }

  _reservedChildren(batchId) {
    return this.db.prepare(`
      SELECT child.child_order_id, child.batch_id, child.account_id, child.requested_amount_minor,
             child.attempt, batch.authorization_id, batch.rule_id, batch.card_id,
             batch.card_snapshot_json, batch.betting_mode, batch.settings_version
      FROM bet_child_orders AS child
      JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
      INNER JOIN betting_accounts AS account ON account.id = child.account_id
      WHERE child.batch_id = ? AND child.status = 'reserved'
      ORDER BY account.bet_order, account.created_at, account.id, child.attempt
    `).all(batchId).map((row) => ({
      childOrderId: row.child_order_id,
      batchId: row.batch_id,
      accountId: row.account_id,
      amountMinor: row.requested_amount_minor,
      attempt: row.attempt,
      authorizationId: row.authorization_id,
      ruleId: row.rule_id,
      cardId: row.card_id,
      eligibilityVersion: row.card_snapshot_json ? JSON.parse(row.card_snapshot_json).realEligibilityVersion : null,
      bettingMode: row.betting_mode,
      settingsVersion: row.settings_version,
    }))
  }

  _accounts(batch, excludedAccounts) {
    return this.db.prepare(`
      SELECT id, bet_order, created_at, currency, amount_scale, per_bet_limit_minor,
             stake_step_minor, balance_minor
      FROM betting_accounts
      WHERE status = 'enabled' AND archived = 0 AND allocation_status = 'enabled' AND secret_ciphertext <> ''
        AND currency = ? AND amount_scale = ?
        AND id NOT IN (SELECT account_id FROM betting_account_locks)
      ORDER BY bet_order, created_at, id
    `).all(batch.currency, batch.amount_scale).filter((row) => !excludedAccounts.has(row.id))
  }

  _potentialAccountIds(batch, excludedAccounts) {
    return new Set(this.db.prepare(`
      SELECT id
      FROM betting_accounts
      WHERE status = 'enabled' AND archived = 0 AND allocation_status = 'enabled' AND secret_ciphertext <> ''
        AND currency = ? AND amount_scale = ?
    `).all(batch.currency, batch.amount_scale)
      .map((row) => row.id)
      .filter((accountId) => !excludedAccounts.has(accountId)))
  }

  _persistedUsedAccounts(batchId) {
    return new Set(this.db.prepare(`
      SELECT account_id
      FROM bet_batch_account_usage
      WHERE batch_id = ?
    `).all(batchId).map((row) => row.account_id))
  }

  async _previewAccounts(batch, lockedSelection, accounts) {
    this.provider.assertNextOperations?.(accounts.map(() => 'preview'))
    const settled = await Promise.allSettled(accounts.map(async (account) => ({
          account,
          preview: await this.provider.preview({
            accountId: account.id,
            batchId: batch.batch_id,
            lockedSelection,
          }),
        })))
    return settled.flatMap((entry) => {
      if (entry.status !== 'fulfilled' || entry.value.preview?.ok !== true) return []
      const { account, preview } = entry.value
      const previewOdds = String(preview.odds ?? preview.oddsRaw ?? '')
      if (!oddsInFrozenRange(batch, previewOdds)) return []
      const minStakeMinor = safeMinor(preview.minStakeMinor)
      const maxStakeMinor = safeMinor(preview.maxStakeMinor)
      const minimumOnly = preview.stakeStepMinor === null
      const stakeStepMinor = minimumOnly ? 0 : safeMinor(preview.stakeStepMinor)
      const previewBalance = preview.balanceMinor === undefined ? account.balance_minor : safeMinor(preview.balanceMinor)
      if (minStakeMinor === null || minStakeMinor === 0 || maxStakeMinor === null
        || stakeStepMinor === null || (!minimumOnly && stakeStepMinor === 0)) return []
      if (previewBalance === null || previewBalance === undefined) return []
      const currency = preview.currency || account.currency
      const amountScale = preview.amountScale ?? account.amount_scale
      if (currency !== batch.currency || amountScale !== batch.amount_scale) return []
      const availableMinor = Math.min(
        account.per_bet_limit_minor,
        maxStakeMinor,
        previewBalance,
        batch.unfilled_amount_minor,
      )
      const capacityMinor = minimumOnly && availableMinor >= minStakeMinor
        ? minStakeMinor
        : availableMinor
      if (capacityMinor < minStakeMinor
        || (!minimumOnly && (capacityMinor - minStakeMinor) % stakeStepMinor !== 0)) return []
      return [{
        account,
        preview,
          capability: {
            accountId: account.id,
            betOrder: account.bet_order,
            createdAt: account.created_at,
            perBetLimitMinor: capacityMinor,
            confirmedBalanceMinor: previewBalance,
            reservedUnknownMinor: 0,
            currency,
            amountScale,
            minStakeMinor,
            maxStakeMinor,
            capacityMinor,
            stakeStepMinor,
        },
      }]
    })
  }

  async _firstUsablePreview(batch, lockedSelection, accounts) {
    for (const account of accounts) {
      const previews = await this._previewAccounts(batch, lockedSelection, [account])
      if (previews.length > 0) return previews
    }
    return []
  }

  async _submitChild(child, lockedSelection, fencingToken, mode = 'simulated', acceptance = null) {
    if (mode === 'real') this.realExecutionGate(this.db)
    this._fence()
    if (mode === 'real') {
      if (!this.b2Executor) throw new Error('b2-executor-required')
      const previous = this.db.prepare(`
        SELECT attempt_ordinal, status, submit_attempt_id
        FROM bet_submit_attempts
        WHERE child_order_id = ?
        ORDER BY attempt_ordinal DESC
        LIMIT 1
      `).get(child.childOrderId)
      if (previous) throw new Error('submit-attempt-uncertain')
      const attemptOrdinal = 1
      const attemptId = deterministicSubmitAttemptId(child.childOrderId, attemptOrdinal)
      let outcome
      try {
        const executionScope = child.cardId !== null
          ? { cardId: child.cardId, eligibilityVersion: child.eligibilityVersion, bettingMode: child.bettingMode }
          : child.ruleId === null
            ? { bettingMode: child.bettingMode, settingsVersion: child.settingsVersion }
          : { ruleId: child.ruleId }
        outcome = await this.b2Executor.submit({
          ...executionScope,
          submitAttemptId: attemptId,
          attemptOrdinal,
          batchId: child.batchId,
          childOrderId: child.childOrderId,
          accountId: child.accountId,
          amountMinor: child.amountMinor,
          childIdentity: {
            batchId: child.batchId,
            childOrderId: child.childOrderId,
            accountId: child.accountId,
            childAttempt: child.attempt,
          },
          lockedSelection,
          hasFutureCapacity: true,
          ...(acceptance ? {
            acceptanceClaim: acceptance.candidateClaim,
            acceptanceInitialPreview: acceptance.initialPreview,
          } : {}),
        })
      } catch (error) {
        const code = String(error?.code || error?.message || '')
        if (/^(?:current-identity-mismatch|preview-(?:line|identity).*changed|crown-preview-(?:gid|mode|period|market|line-identity|side)-changed)$/.test(code)) {
          this._stopBatch(child.batchId, 'market_changed', fencingToken)
          return { accountId: child.accountId, status: 'cancelled', stopReason: 'market_changed' }
        }
        throw error
      }
      return {
        accountId: child.accountId,
        status: outcome?.child?.status || outcome?.status || 'unknown',
        ...(outcome?.reason ? { reason: outcome.reason, retryable: outcome.retryable === true } : {}),
      }
    }
    this.store.prepareSubmit(child.childOrderId, {
      submitAttemptId: submitAttemptId(child.childOrderId),
      fencingToken,
      at: this.now(),
      requireRealRuntime: mode === 'real',
      realLeaseEvidence: this._realLeaseEvidence(mode),
    })
    this._fault('afterPrepare', { child })

    let pending
    try {
      pending = Promise.resolve(this.provider.submit({
        accountId: child.accountId,
        batchId: child.batchId,
        childOrderId: child.childOrderId,
        amountMinor: child.amountMinor,
        lockedSelection,
      }))
    } catch (error) {
      pending = Promise.reject(error)
    }
    try {
      this._fault('afterSubmitStarted', { child })
    } catch (error) {
      pending.catch(() => {})
      throw error
    }
    this._fence()
    this.store.markDispatched(child.childOrderId, { fencingToken, at: this.now() })

    let result
    try {
      result = await pending
    } catch (error) {
      result = { status: 'unknown', errorCode: String(error?.code || 'provider-error') }
    }
    this._fault('afterProviderResult', { child, result })
    const status = ['accepted', 'rejected', 'unknown'].includes(result?.status) ? result.status : 'unknown'
    this._fence()
    this.store.resolveChildOrder(child.childOrderId, {
      status,
      errorCode: String(result?.errorCode || ''),
      fencingToken,
      at: this.now(),
      hasFutureCapacity: true,
    })
    return { accountId: child.accountId, status }
  }

  async executeAcceptanceCandidate({ direction, caseVersion, candidateClaim, candidate } = {}) {
    if (!candidateClaim || !direction || !Number.isSafeInteger(caseVersion)) {
      throw new TypeError('acceptance-candidate-contract')
    }
    const lockedSelection = candidate?.lockedSelection || candidate
    const fencingToken = this._fence()
    this.realExecutionGate(this.db)
    const account = this._accounts({ currency: 'CNY', amount_scale: 0 }, new Set())[0]
    if (!account) return { status: 'waiting_account' }
    const preview = await this.provider.preview({
      accountId: account.id,
      batchId: `acceptance-preview-${direction.id}-${caseVersion}`,
      lockedSelection,
      acceptanceClaim: candidateClaim,
    })
    if (preview?.ok !== true || !Number.isSafeInteger(preview.minStakeMinor) || preview.minStakeMinor < 1
      || !preview.acceptanceRawPreview) return { status: 'waiting_preview' }
    const signalId = `crown-acceptance:${direction.id}:v${caseVersion}`
    const at = this.now()
    this.db.prepare(`INSERT OR IGNORE INTO monitor_signals (
      signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json
    ) VALUES (?,?,?,1,'accepted',?,?,?)`).run(
      signalId, signalId, 'crown-browser-acceptance', at, at, '{}',
    )
    const settingsSnapshot = {
      mode: direction.mode,
      version: caseVersion,
      enabled: false,
      targetOddsMin: String(preview.odds),
      targetOddsMax: String(preview.odds),
      targetAmountMinor: preview.minStakeMinor,
      currency: 'CNY',
      amountScale: 0,
      acceptanceOnly: true,
    }
    const created = this.store.createModeScopedBatchWithReservations({
      signalId,
      bettingMode: direction.mode,
      settingsVersion: caseVersion,
      settingsSnapshot,
      eventKey: lockedSelection.eventKey,
      lockedSelectionIdentity: JSON.stringify(lockedSelection),
      sourceLeague: 'crown-browser-acceptance',
      sourceOdds: String(preview.odds),
      observedAt: at,
      currency: 'CNY',
      amountScale: 0,
      targetAmountMinor: preview.minStakeMinor,
      createdAt: at,
    }, [{
      accountId: account.id,
      amountMinor: preview.minStakeMinor,
      previewMinStakeMinor: preview.minStakeMinor,
      previewMaxStakeMinor: preview.maxStakeMinor,
      previewBalanceMinor: preview.balanceMinor,
      previewStakeStepMinor: preview.stakeStepMinor ?? 0,
      previewOdds: String(preview.odds),
    }], {
      fencingToken,
      requireRealRuntime: true,
      realLeaseEvidence: this._realLeaseEvidence('real'),
    })
    const reservedChild = created.children[0]
    if (!reservedChild) throw new Error('acceptance-child-not-created')
    const child = {
      ...reservedChild,
      ruleId: null,
      cardId: null,
      bettingMode: direction.mode,
      settingsVersion: caseVersion,
    }
    const outcome = await this._submitChild(child, lockedSelection, fencingToken, 'real', {
      candidateClaim,
      initialPreview: preview.acceptanceRawPreview,
    })
    if (outcome.status === 'pre-dispatch-cancelled') {
      this.store.cancelUnsubmitted(created.batch.batchId, {
        finishReason: outcome.reason === 'acceptance-preview-drift' ? 'market_changed' : 'manual_cancel',
        fencingToken,
        at: this.now(),
      })
    }
    return outcome
  }

  async runBatch(batchId, { mode = 'simulated' } = {}) {
    if (mode === 'real') this.realExecutionGate(this.db)
    const fencingToken = this._fence()
    const usedAccounts = this._persistedUsedAccounts(batchId)
    for (let round = 0; round < this.maxRounds; round += 1) {
      if (mode === 'real') this.realExecutionGate(this.db)
      const batch = this._batchRow(batchId)
      if (!batch) throw new Error('batch-not-found')
      if (TERMINAL_BATCH.has(batch.status)) return this.store.getBatch(batchId)
      if (isSafetyFinishReason(batch.finish_reason)) return this._stopBatch(batchId, batch.finish_reason, fencingToken)
      const audit = this._executionAudit(batch)
      if (audit.stopReason) return this._stopBatch(batchId, audit.stopReason, fencingToken)
      if (batch.status === 'waiting_result' || this._hasUncertainSubmission(batchId)) return this.store.getBatch(batchId)
      let lockedSelection = audit.lockedSelection

      let children = this._reservedChildren(batchId)
      if (children.length === 0) {
        const potentialAccountIds = this._potentialAccountIds(batch, usedAccounts)
        const accounts = this._accounts(batch, usedAccounts)
        const previews = await this._firstUsablePreview(batch, lockedSelection, accounts)
        if (mode === 'real') this.realExecutionGate(this.db)
        const allocation = allocateStake(batch.unfilled_amount_minor, previews.map((item) => item.capability))
        if (allocation.allocations.length === 0) {
          return this.store.reconcileAggregates(batchId, { hasFutureCapacity: potentialAccountIds.size > 0, fencingToken, at: this.now() })
        }
        const byAccount = new Map(previews.map((item) => [item.account.id, item]))
        children = this.store.reserveRound(batchId, allocation.allocations.map((allocation) => {
          const item = byAccount.get(allocation.accountId)
          return {
            ...allocation,
            previewMinStakeMinor: item.capability.minStakeMinor,
            previewMaxStakeMinor: item.capability.maxStakeMinor,
            previewBalanceMinor: item.preview.balanceMinor ?? item.account.balance_minor,
            previewStakeStepMinor: item.capability.stakeStepMinor,
            previewOdds: String(item.preview.odds ?? item.preview.oddsRaw ?? ''),
          }
        }), { fencingToken, requireRealRuntime: mode === 'real', realLeaseEvidence: this._realLeaseEvidence(mode) })
        for (const child of children) usedAccounts.add(child.accountId)
        this._fault('afterReserve', { batchId, children })
      }

      const beforeSubmitBatch = this._batchRow(batchId)
      if (isSafetyFinishReason(beforeSubmitBatch.finish_reason)) return this._stopBatch(batchId, beforeSubmitBatch.finish_reason, fencingToken)
      const beforeSubmitAudit = this._executionAudit(beforeSubmitBatch)
      if (beforeSubmitAudit.stopReason) return this._stopBatch(batchId, beforeSubmitAudit.stopReason, fencingToken)
      lockedSelection = beforeSubmitAudit.lockedSelection

      for (const child of children) {
        usedAccounts.add(child.accountId)
        this.provider.assertNextOperations?.(['submit'])
        await this._submitChild(child, lockedSelection, fencingToken, mode)
        const current = this.store.getBatch(batchId)
        if (TERMINAL_BATCH.has(current.status) || current.status === 'waiting_result' || current.finishReason) return current
      }
    }
    return this.store.reconcileAggregates(batchId, { hasFutureCapacity: false, fencingToken, at: this.now() })
  }
}
