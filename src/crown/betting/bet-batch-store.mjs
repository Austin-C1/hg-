import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { assertMinor, normalizeCurrency } from './money.mjs'
import { reserveAuthorizationBudgetInTransaction } from './execution-gate.mjs'
import { lockReverseSelection } from './locked-selection.mjs'
import { SAFETY_FINISH_REASONS } from './safety-finish-reasons.mjs'
import { buildCardMarketOnceKey } from './market-once-store.mjs'
import { completeRuleCardSnapshot } from './auto-betting-rule-card-matcher.mjs'

const TERMINAL_STATUSES = new Set(['accepted', 'rejected', 'cancelled'])
const STOP_REASONS = SAFETY_FINISH_REASONS
const IN_TRANSACTION = Symbol('in-transaction')
const RECONCILIATION_DEADLINE_MS = 120_000

function requiredString(value, field) {
  const result = String(value || '').trim()
  if (!result) throw new TypeError(field)
  return result
}

function timestamp(value) {
  const result = value === undefined ? new Date().toISOString() : requiredString(value, 'timestamp')
  if (!Number.isFinite(Date.parse(result))) throw new TypeError('timestamp')
  return result
}

function positiveMinor(value, field) {
  assertMinor(value, field)
  if (value === 0) throw new RangeError(`${field}-positive`)
  return value
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(field)
  return value
}

function exactDecimal(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function compareDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale)
  const a = left.coefficient * 10n ** BigInt(scale - left.scale)
  const b = right.coefficient * 10n ** BigInt(scale - right.scale)
  return a < b ? -1 : a > b ? 1 : 0
}

function stableId(...parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

function batchResult(row) {
  if (!row) return null
  return {
    batchId: row.batch_id,
    signalId: row.signal_id,
    cardId: row.card_id,
    cardVersion: row.card_version,
    ruleId: row.rule_id,
    bettingMode: row.betting_mode,
    settingsVersion: row.settings_version,
    targetAmountMinor: row.target_amount_minor,
    reservedAmountMinor: row.reserved_amount_minor,
    acceptedAmountMinor: row.accepted_amount_minor,
    unknownAmountMinor: row.unknown_amount_minor,
    unfilledAmountMinor: row.unfilled_amount_minor,
    status: row.status,
    finishReason: row.finish_reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function childResult(row) {
  if (!row) return null
  return {
    childOrderId: row.child_order_id,
    batchId: row.batch_id,
    accountId: row.account_id,
    attempt: row.attempt,
    amountMinor: row.requested_amount_minor,
    status: row.status,
    submitAttemptId: row.submit_attempt_id,
  }
}

function runImmediate(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export class BetBatchStore {
  constructor(database, { fencingToken = 1, leaseKey = null, now = () => new Date(), faultInjector = null } = {}) {
    this.db = database?.db || database
    if (!this.db || typeof this.db.prepare !== 'function') throw new TypeError('database')
    this.fencingToken = positiveInteger(fencingToken, 'fencing-token')
    this.leaseKey = leaseKey === null ? null : requiredString(leaseKey, 'leaseKey')
    if (typeof now !== 'function') throw new TypeError('now')
    this.now = now
    if (faultInjector !== null && typeof faultInjector !== 'function') throw new TypeError('faultInjector')
    this.faultInjector = faultInjector
  }

  _assertRealRuntime(required, evidence = null) {
    if (!required) return
    const row = this.db.prepare('SELECT requested,runtime_state FROM real_betting_runtime WHERE singleton_id=1').get()
    if (Number(row?.requested) !== 1 || row?.runtime_state !== 'running') throw new Error('real-betting-not-requested')
    if (!evidence?.worker || !evidence?.executor) throw new Error('real-betting-role-fence-required')
    for (const role of ['worker', 'executor']) {
      const expected = evidence[role]
      const lease = this.db.prepare('SELECT owner_id,fencing_token,expires_at FROM runtime_leases WHERE lease_key=?').get(expected.leaseKey)
      const nowValue = this.now()
      const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue)
      if (!Number.isFinite(nowMs)) throw new TypeError('now')
      if (!lease || lease.owner_id !== expected.ownerId || Number(lease.fencing_token) !== expected.fencingToken
        || Date.parse(lease.expires_at) <= nowMs) throw new Error(`real-betting-${role}-fence-stale`)
    }
  }

  _fault(phase, details = {}) {
    this.faultInjector?.(phase, details)
  }

  _token(value) {
    return positiveInteger(value ?? this.fencingToken, 'fencing-token')
  }

  _batch(batchId) {
    return this.db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(requiredString(batchId, 'batchId'))
  }

  _child(childOrderId) {
    return this.db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(requiredString(childOrderId, 'childOrderId'))
  }

  _requireBatch(batchId) {
    const row = this._batch(batchId)
    if (!row) throw new Error('batch-not-found')
    return row
  }

  _requireChild(childOrderId) {
    const row = this._child(childOrderId)
    if (!row) throw new Error('child-order-not-found')
    return row
  }

  _assertUnboundChild(childOrderId) {
    if (this.db.prepare(`
      SELECT 1 FROM execution_authorization_child_budgets WHERE child_order_id = ?
    `).get(childOrderId)) {
      throw new Error('authorized-child-store-bypass')
    }
  }

  _assertUnboundBatch(batchId) {
    if (this.db.prepare(`
      SELECT 1 FROM execution_authorization_child_budgets WHERE batch_id = ? LIMIT 1
    `).get(batchId)) {
      throw new Error('authorized-child-store-bypass')
    }
  }

  _assertChildFence(childOrderId, fencingToken) {
    const lock = this.db.prepare(`
      SELECT fencing_token
      FROM betting_account_locks
      WHERE child_order_id = ?
    `).get(childOrderId)
    if (!lock || lock.fencing_token !== fencingToken) throw new Error('fencing-token')
  }

  _assertBatchFence(batchId, fencingToken) {
    const stale = this.db.prepare(`
      SELECT 1
      FROM betting_account_locks
      WHERE batch_id = ? AND fencing_token <> ?
      LIMIT 1
    `).get(batchId, fencingToken)
    if (stale) throw new Error('fencing-token')
  }

  _assertTransactionFence(fencingToken) {
    if (this.leaseKey !== null) {
      const nowIso = timestamp(this.now())
      const lease = this.db.prepare(`
        SELECT fencing_token, expires_at
        FROM runtime_leases
        WHERE lease_key = ?
      `).get(this.leaseKey)
      const expiryMs = Date.parse(lease?.expires_at)
      const nowMs = Date.parse(nowIso)
      if (!lease || lease.fencing_token !== fencingToken || !Number.isFinite(expiryMs) || !Number.isFinite(nowMs) || expiryMs <= nowMs) {
        throw new Error('fencing-token')
      }
      return
    }
    const currentFence = this.db.prepare('SELECT MAX(fencing_token) AS fencing_token FROM betting_account_locks').get().fencing_token
    if (currentFence !== null && fencingToken < currentFence) throw new Error('fencing-token')
  }

  _assertModeScopedCoherence(input, { validateLatestSelection = true } = {}) {
    const cardScoped = typeof input.cardId === 'string' && input.cardId !== ''
    if (!cardScoped) {
      const setting = this.db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(input.bettingMode)
      if (!setting || Number(setting.version) !== Number(input.settingsVersion)
        || Number(setting.enabled) !== 1 || Number(setting.migration_review_required) !== 0
        || setting.currency !== input.currency || Number(setting.amount_scale) !== Number(input.amountScale)
        || Number(setting.target_amount_minor) !== Number(input.targetAmountMinor)) {
        throw new Error('settings-snapshot-changed')
      }
    }
    const leaseOwner = requiredString(input.inboxLease?.ownerId, 'inboxLease.ownerId')
    const leaseExpiresAt = timestamp(input.inboxLease?.expiresAt)
    const now = timestamp(this.now())
    const inbox = this.db.prepare(`
      SELECT card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,
             status,lease_owner,lease_expires_at
      FROM auto_betting_signal_inbox WHERE signal_id=? AND card_id=?
    `).get(input.signalId, cardScoped ? input.cardId : (input.cardId || this.db.prepare(
      'SELECT card_id FROM auto_betting_signal_inbox WHERE signal_id=? LIMIT 1').get(input.signalId)?.card_id))
    if (!inbox || inbox.status !== 'processing' || inbox.lease_owner !== leaseOwner
      || inbox.lease_expires_at !== leaseExpiresAt || Date.parse(inbox.lease_expires_at) <= Date.parse(now)) {
      throw new Error('inbox-lease-stale')
    }
    if (cardScoped) {
      if (inbox.card_id !== input.cardId || Number(inbox.card_version) !== Number(input.cardVersion)
        || inbox.card_snapshot_json !== JSON.stringify(input.cardSnapshot)) throw new Error('inbox-snapshot-mismatch')
    } else if (inbox.mode !== input.bettingMode || Number(inbox.settings_version) !== Number(input.settingsVersion)
      || inbox.settings_snapshot_json !== JSON.stringify(input.settingsSnapshot)) throw new Error('inbox-snapshot-mismatch')
    const signalRow = this.db.prepare('SELECT payload_json FROM monitor_signals WHERE signal_id=?').get(input.signalId)
    let persisted
    try { persisted = JSON.parse(signalRow?.payload_json || '') } catch { throw new Error('signal-snapshot-changed') }
    if (JSON.stringify(persisted) !== JSON.stringify(input.signalSnapshot)) throw new Error('signal-snapshot-changed')
    if (!validateLatestSelection) return persisted
    return this._assertLatestSelectionCoherence(input, persisted)
  }

  _assertLatestSelectionCoherence(input, persisted) {
    const cardScoped = typeof input.cardId === 'string' && input.cardId !== ''
    const snapshots = this.db.prepare('SELECT captured_at, snapshot_json FROM monitor_selection_state ORDER BY captured_at DESC').all()
      .flatMap((row) => {
        try { return [{ capturedAt: row.captured_at, snapshot: JSON.parse(row.snapshot_json) }] } catch { return [] }
      })
    const family = snapshots.filter(({ snapshot }) => snapshot?.provider === 'crown'
      && snapshot?.event?.eventKey === persisted?.target?.eventIdentity
      && snapshot?.mode === input.bettingMode
      && snapshot?.market?.period === persisted?.evidence?.period
      && snapshot?.market?.marketType === persisted?.evidence?.marketType)
    const currentCapturedAt = family[0]?.capturedAt || ''
    const currentGeneration = family.filter((item) => item.capturedAt === currentCapturedAt)
    const latest = lockReverseSelection(persisted, (query) => {
      for (const candidate of currentGeneration) {
        const snapshot = candidate.snapshot
        if (snapshot?.provider === query.provider && snapshot?.event?.eventKey === query.eventKey
          && snapshot?.market?.period === query.period && snapshot?.market?.marketType === query.marketType
          && snapshot?.market?.lineKey === query.lineKey && snapshot?.selection?.side === query.side) return snapshot
      }
      return null
    })
    if (!latest) throw new Error('latest-selection-required')
    const expected = input.lockedSelection
    for (const field of ['eventKey', 'period', 'marketType', 'lineKey', 'side', 'selectionIdentity', 'handicap']) {
      if (latest[field] !== expected?.[field]) throw new Error('latest-selection-drift')
    }
    if (latest.snapshot?.mode !== input.bettingMode || latest.snapshot?.event?.mode !== input.bettingMode) {
      throw new Error('latest-stage-drift')
    }
    if ((latest.snapshot?.event?.livePhase ?? null) !== (persisted?.evidence?.livePhase ?? null)) {
      throw new Error('latest-stage-drift')
    }
    const odds = exactDecimal(String(latest.snapshot?.selection?.oddsRaw ?? latest.snapshot?.selection?.odds ?? ''))
    const scopeSnapshot = cardScoped ? input.cardSnapshot : input.settingsSnapshot
    const minimum = exactDecimal(scopeSnapshot?.targetOddsMin)
    const maximum = exactDecimal(scopeSnapshot?.targetOddsMax)
    if (!odds || !minimum || !maximum || compareDecimal(odds, minimum) < 0 || compareDecimal(odds, maximum) > 0) {
      throw new Error('latest-odds-out-of-range')
    }
    return latest
  }

  createBatch(input = {}, options = {}) {
    const { fencingToken } = options
    const signalId = requiredString(input.signalId, 'signalId')
    const ruleId = requiredString(input.ruleId, 'ruleId')
    const batchId = createHash('sha256').update(`${signalId}\n${ruleId}`, 'utf8').digest('hex')
    const targetAmountMinor = positiveMinor(input.targetAmountMinor, 'targetAmountMinor')
    const amountScale = input.amountScale
    if (!Number.isInteger(amountScale) || amountScale < 0 || amountScale > 6) throw new TypeError('amountScale')
    const currency = normalizeCurrency(input.currency)
    const ruleVersion = positiveInteger(input.ruleVersion ?? 1, 'ruleVersion')
    const createdAt = timestamp(input.createdAt)
    const ruleSnapshotJson = JSON.stringify(input.ruleSnapshot || {})
    const token = this._token(fencingToken)

    const operation = () => {
      this._assertRealRuntime(options.requireRealRuntime, options.realLeaseEvidence)
      this._assertTransactionFence(token)
      this.db.prepare(`
        INSERT OR IGNORE INTO bet_batches (
          batch_id, signal_id, rule_id, authorization_id, event_key,
          locked_selection_identity, rule_version, rule_snapshot_json,
          source_league, source_odds, observed_at, currency, amount_scale,
          target_amount_minor, unfilled_amount_minor, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(
        batchId,
        signalId,
        ruleId,
        input.authorizationId || null,
        String(input.eventKey || ''),
        String(input.lockedSelectionIdentity || ''),
        ruleVersion,
        ruleSnapshotJson,
        String(input.sourceLeague || ''),
        String(input.sourceOdds || ''),
        String(input.observedAt || ''),
        currency,
        amountScale,
        targetAmountMinor,
        targetAmountMinor,
        createdAt,
      )
      const row = this.db.prepare('SELECT * FROM bet_batches WHERE signal_id = ? AND rule_id = ?').get(signalId, ruleId)
      if (!row || row.batch_id !== batchId) throw new Error('batch-id-collision')
      return batchResult(row)
    }
    return options[IN_TRANSACTION] ? operation() : runImmediate(this.db, operation)
  }

  createModeScopedBatch(input = {}, options = {}) {
    const signalId = requiredString(input.signalId, 'signalId')
    const bettingMode = requiredString(input.bettingMode, 'bettingMode')
    if (!['prematch', 'live'].includes(bettingMode)) throw new TypeError('bettingMode')
    const settingsVersion = positiveInteger(input.settingsVersion, 'settingsVersion')
    if (!input.settingsSnapshot || typeof input.settingsSnapshot !== 'object' || Array.isArray(input.settingsSnapshot)) {
      throw new TypeError('settingsSnapshot')
    }
    if (input.settingsSnapshot.mode !== bettingMode || input.settingsSnapshot.version !== settingsVersion) {
      throw new Error('settings-snapshot-incoherent')
    }
    const settingsSnapshotJson = JSON.stringify(input.settingsSnapshot)
    const batchId = createHash('sha256').update(`${signalId}\n${bettingMode}\n${settingsVersion}`, 'utf8').digest('hex')
    const targetAmountMinor = positiveMinor(input.targetAmountMinor, 'targetAmountMinor')
    const amountScale = input.amountScale
    if (!Number.isInteger(amountScale) || amountScale < 0 || amountScale > 6) throw new TypeError('amountScale')
    const currency = normalizeCurrency(input.currency)
    const createdAt = timestamp(input.createdAt)
    const token = this._token(options.fencingToken)
    const operation = () => {
      this._assertRealRuntime(options.requireRealRuntime, options.realLeaseEvidence)
      this._assertTransactionFence(token)
      this.db.prepare(`
        INSERT OR IGNORE INTO bet_batches (
          batch_id, signal_id, rule_id, betting_mode, settings_version, settings_snapshot_json,
          authorization_id, event_key, locked_selection_identity, rule_version, rule_snapshot_json,
          source_league, source_odds, observed_at, currency, amount_scale,
          target_amount_minor, unfilled_amount_minor, status, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, '{}', ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(
        batchId, signalId, bettingMode, settingsVersion, settingsSnapshotJson,
        input.authorizationId || null, String(input.eventKey || ''), String(input.lockedSelectionIdentity || ''),
        String(input.sourceLeague || ''), String(input.sourceOdds || ''), String(input.observedAt || ''),
        currency, amountScale, targetAmountMinor, targetAmountMinor, createdAt,
      )
      const row = this.db.prepare(`
        SELECT * FROM bet_batches
        WHERE signal_id=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
      `).get(signalId, bettingMode, settingsVersion)
      if (!row || row.batch_id !== batchId || row.settings_snapshot_json !== settingsSnapshotJson) {
        throw new Error('mode-scoped-batch-conflict')
      }
      return batchResult(row)
    }
    return options[IN_TRANSACTION] ? operation() : runImmediate(this.db, operation)
  }

  createCardScopedBatch(input = {}, options = {}) {
    const signalId = requiredString(input.signalId, 'signalId')
    const cardId = requiredString(input.cardId, 'cardId')
    const cardVersion = positiveInteger(input.cardVersion, 'cardVersion')
    const bettingMode = requiredString(input.bettingMode, 'bettingMode')
    if (!['prematch', 'live'].includes(bettingMode)) throw new TypeError('bettingMode')
    if (!input.cardSnapshot || typeof input.cardSnapshot !== 'object' || Array.isArray(input.cardSnapshot)
      || input.cardSnapshot.cardId !== cardId || input.cardSnapshot.version !== cardVersion) {
      throw new Error('card-snapshot-incoherent')
    }
    const cardSnapshotJson = JSON.stringify(input.cardSnapshot)
    const batchId = createHash('sha256').update(`${signalId}\n${cardId}\n${cardVersion}`, 'utf8').digest('hex')
    const targetAmountMinor = positiveMinor(input.targetAmountMinor, 'targetAmountMinor')
    if (!Number.isInteger(input.amountScale) || input.amountScale < 0 || input.amountScale > 6) throw new TypeError('amountScale')
    const currency = normalizeCurrency(input.currency)
    const createdAt = timestamp(input.createdAt)
    const token = this._token(options.fencingToken)
    const operation = () => {
      this._assertRealRuntime(options.requireRealRuntime, options.realLeaseEvidence)
      this._assertTransactionFence(token)
      this.db.prepare(`
        INSERT OR IGNORE INTO bet_batches (
          batch_id,signal_id,card_id,card_version,card_snapshot_json,rule_id,betting_mode,
          settings_version,settings_snapshot_json,authorization_id,event_key,locked_selection_identity,
          rule_version,rule_snapshot_json,source_league,source_odds,observed_at,currency,amount_scale,
          target_amount_minor,unfilled_amount_minor,status,created_at
        ) VALUES (?,?,?,?,?,NULL,?,NULL,'{}',?,?,?,1,'{}',?,?,?,?,?,?,?,'queued',?)
      `).run(batchId, signalId, cardId, cardVersion, cardSnapshotJson, bettingMode,
        input.authorizationId || null, String(input.eventKey || ''), String(input.lockedSelectionIdentity || ''),
        String(input.sourceLeague || ''), String(input.sourceOdds || ''), String(input.observedAt || ''),
        currency, input.amountScale, targetAmountMinor, targetAmountMinor, createdAt)
      const row = this.db.prepare('SELECT * FROM bet_batches WHERE signal_id=? AND card_id=? AND card_version=?')
        .get(signalId, cardId, cardVersion)
      if (!row || row.batch_id !== batchId || row.card_snapshot_json !== cardSnapshotJson) throw new Error('card-scoped-batch-conflict')
      return batchResult(row)
    }
    return options[IN_TRANSACTION] ? operation() : runImmediate(this.db, operation)
  }

  reserveRound(batchId, allocations, options = {}) {
    const { fencingToken } = options
    const id = requiredString(batchId, 'batchId')
    const token = this._token(fencingToken)
    if (!Array.isArray(allocations) || allocations.length === 0) throw new TypeError('allocations')
    const normalized = allocations.map((allocation) => {
      if (!allocation || typeof allocation !== 'object') throw new TypeError('allocation')
      const accountId = requiredString(allocation.accountId, 'accountId')
      const amountMinor = positiveMinor(allocation.amountMinor, 'amountMinor')
      const previewMinStakeMinor = positiveMinor(allocation.previewMinStakeMinor, 'previewMinStakeMinor')
      const previewMaxStakeMinor = positiveMinor(allocation.previewMaxStakeMinor, 'previewMaxStakeMinor')
      const previewBalanceMinor = allocation.previewBalanceMinor === null
        ? null
        : assertMinor(allocation.previewBalanceMinor, 'previewBalanceMinor')
      const previewStakeStepMinor = assertMinor(allocation.previewStakeStepMinor, 'previewStakeStepMinor')
      if (amountMinor < previewMinStakeMinor || amountMinor > previewMaxStakeMinor) throw new RangeError('preview-stake-range')
      if (previewBalanceMinor !== null && amountMinor > previewBalanceMinor) throw new RangeError('preview-balance')
      if (previewStakeStepMinor === 0
        ? amountMinor !== previewMinStakeMinor
        : (amountMinor - previewMinStakeMinor) % previewStakeStepMinor !== 0) throw new RangeError('preview-stake-step')
      return {
        accountId,
        amountMinor,
        previewMinStakeMinor,
        previewMaxStakeMinor,
        previewBalanceMinor,
        previewStakeStepMinor,
        previewOdds: String(allocation.previewOdds || ''),
      }
    })
    if (new Set(normalized.map((item) => item.accountId)).size !== normalized.length) {
      throw new TypeError('accountId-duplicate')
    }

    const operation = () => {
      this._assertRealRuntime(options.requireRealRuntime, options.realLeaseEvidence)
      this._assertTransactionFence(token)
      const batch = this._requireBatch(id)
      if (['completed', 'partial', 'failed', 'cancelled'].includes(batch.status)) throw new Error('batch-terminal')
      if (STOP_REASONS.has(batch.finish_reason)) throw new Error('batch-stopped')
      this._assertBatchFence(id, token)
      this._reconcileAggregates(id, { hasFutureCapacity: true, at: timestamp() })
      const refreshed = this._requireBatch(id)
      let requestedTotal = 0
      for (const item of normalized) {
        if (item.amountMinor > Number.MAX_SAFE_INTEGER - requestedTotal) throw new RangeError('reserved-total-minor')
        requestedTotal += item.amountMinor
      }
      if (requestedTotal > refreshed.unfilled_amount_minor) throw new RangeError('batch-target-exceeded')

      const children = []
      for (const item of normalized) {
        const account = this.db.prepare(`
          SELECT status, archived, allocation_status, currency, amount_scale, per_bet_limit_minor
          FROM betting_accounts
          WHERE id = ?
        `).get(item.accountId)
        if (!account) throw new Error(`account-not-found:${item.accountId}`)
        if (account.status !== 'enabled') throw new Error(`account-disabled:${item.accountId}`)
        if (account.archived !== 0) throw new Error(`account-archived:${item.accountId}`)
        if (account.allocation_status !== 'enabled') throw new Error(`account-allocation-paused:${item.accountId}`)
        if (account.currency !== refreshed.currency) throw new Error(`account-currency-mismatch:${item.accountId}`)
        if (account.amount_scale !== refreshed.amount_scale) throw new Error(`account-amount-scale-mismatch:${item.accountId}`)
        if (item.amountMinor > account.per_bet_limit_minor) throw new Error(`account-per-bet-limit:${item.accountId}`)
        if (this.db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ?').get(item.accountId)) {
          throw new Error(`account-locked:${item.accountId}`)
        }
        const previous = this.db.prepare(`
          SELECT child_order_id
          FROM bet_batch_account_usage
          WHERE batch_id = ? AND account_id = ?
        `).get(id, item.accountId)
        if (previous) throw new Error(`account-already-used:${item.accountId}`)
        const attempt = 1
        const childOrderId = stableId(id, item.accountId, String(attempt))
        const createdAt = timestamp()
        this.db.prepare(`
          INSERT INTO bet_child_orders (
            child_order_id, batch_id, account_id, attempt, requested_amount_minor,
            preview_min_stake_minor, preview_max_stake_minor, preview_balance_minor,
            preview_stake_step_minor, preview_odds, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
        `).run(
          childOrderId,
          id,
          item.accountId,
          attempt,
          item.amountMinor,
          item.previewMinStakeMinor,
          item.previewMaxStakeMinor,
          item.previewBalanceMinor,
          item.previewStakeStepMinor,
          item.previewOdds,
          createdAt,
        )
        this.db.prepare(`
          INSERT INTO bet_batch_account_usage (
            batch_id, account_id, child_order_id, first_used_at
          ) VALUES (?, ?, ?, ?)
        `).run(id, item.accountId, childOrderId, createdAt)
        this._fault('reserve:after-child-insert', { childOrderId, batchId: id, accountId: item.accountId })
        this.db.prepare(`
          INSERT INTO betting_account_locks (
            account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at
          ) VALUES (?, ?, ?, 'reserved', ?, ?, ?)
        `).run(item.accountId, childOrderId, id, token, createdAt, createdAt)
        this._fault('reserve:after-lock-insert', { childOrderId, batchId: id, accountId: item.accountId })
        children.push(childResult(this._requireChild(childOrderId)))
      }
      this._reconcileAggregates(id, { hasFutureCapacity: true, at: timestamp() })
      return children
    }
    return options[IN_TRANSACTION] ? operation() : runImmediate(this.db, operation)
  }

  createBatchWithReservations(input = {}, allocations = [], { fencingToken, marketOnceKey = '', requireRealRuntime = false, realLeaseEvidence = null } = {}) {
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      const batch = this.createBatch(input, { fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true })
      const children = this.reserveRound(batch.batchId, allocations, { fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true })
      if (marketOnceKey) {
        const updated = this.db.prepare(`
          UPDATE bet_market_once_claims
          SET batch_id = ?, claim_status = 'batch_created', failure_reason = NULL, updated_at = ?
          WHERE market_once_key = ? AND rule_id = ? AND signal_id = ? AND claim_status = 'claimed'
        `).run(batch.batchId, timestamp(), marketOnceKey, input.ruleId, input.signalId)
        if (updated.changes !== 1) throw new Error('market-once-claim-transition')
      }
      return { batch, children }
    })
  }

  createModeScopedBatchWithReservations(input = {}, allocations = [], {
    fencingToken, marketOnceKey = '', requireRealRuntime = false, realLeaseEvidence = null,
  } = {}) {
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      const existing = this.db.prepare(`
        SELECT * FROM bet_batches
        WHERE signal_id=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
      `).get(input.signalId, input.bettingMode, input.settingsVersion)
      if (existing) {
        if (existing.settings_snapshot_json !== JSON.stringify(input.settingsSnapshot)
          || Number(existing.target_amount_minor) !== Number(input.targetAmountMinor)
          || existing.currency !== input.currency || Number(existing.amount_scale) !== Number(input.amountScale)) {
          throw new Error('mode-scoped-batch-conflict')
        }
        return { batch: batchResult(existing), children: this.listChildOrders(existing.batch_id) }
      }
      const batch = this.createModeScopedBatch(input, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-batch-insert', { batchId: batch.batchId })
      const children = this.reserveRound(batch.batchId, allocations, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-reservations', { batchId: batch.batchId })
      if (marketOnceKey) {
        const updated = this.db.prepare(`
          UPDATE bet_market_once_claims
          SET batch_id=?, claim_status='batch_created', failure_reason=NULL, updated_at=?
          WHERE market_once_key=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
            AND signal_id=? AND claim_status='claimed'
        `).run(batch.batchId, timestamp(), marketOnceKey, input.bettingMode, input.settingsVersion, input.signalId)
        if (updated.changes !== 1) throw new Error('market-once-claim-transition')
        this._fault('mode:after-claim-transition', { batchId: batch.batchId })
      }
      return { batch, children }
    })
  }

  claimAndCreateModeScopedBatch(input = {}, allocations = [], {
    fencingToken, marketOnceKey, requireRealRuntime = false, realLeaseEvidence = null,
  } = {}) {
    const key = requiredString(marketOnceKey, 'marketOnceKey')
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      if (marketOnceKey) this._assertModeScopedCoherence(input)
      const existingClaim = this.db.prepare(`
        SELECT batch_id, claim_status FROM bet_market_once_claims WHERE market_once_key=?
      `).get(key)
      if (existingClaim) return { status: 'already-claimed', batchId: existingClaim.batch_id || null }
      const at = timestamp()
      this.db.prepare(`
        INSERT INTO bet_market_once_claims (
          market_once_key, rule_id, betting_mode, settings_version, signal_id,
          batch_id, claim_status, failure_reason, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, NULL, 'claimed', NULL, ?, ?)
      `).run(key, input.bettingMode, input.settingsVersion, input.signalId, at, at)
      this._fault('mode:after-claim-insert', { marketOnceKey: key })
      const batch = this.createModeScopedBatch(input, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-batch-insert', { batchId: batch.batchId })
      const children = this.reserveRound(batch.batchId, allocations, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-reservations', { batchId: batch.batchId })
      const changed = this.db.prepare(`
        UPDATE bet_market_once_claims
        SET batch_id=?, claim_status='batch_created', failure_reason=NULL, updated_at=?
        WHERE market_once_key=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
          AND signal_id=? AND claim_status='claimed'
      `).run(batch.batchId, timestamp(), key, input.bettingMode, input.settingsVersion, input.signalId)
      if (changed.changes !== 1) throw new Error('market-once-claim-transition')
      this._fault('mode:after-claim-transition', { batchId: batch.batchId })
      return { status: 'batch_created', batchId: batch.batchId, batch, children }
    })
  }

  claimAndCreateCardScopedBatch(input = {}, allocations = [], {
    fencingToken, marketOnceKey, requireRealRuntime = false, realLeaseEvidence = null,
    authorizationId = null, executorOwnerId = null, authorizationOptions = {},
  } = {}) {
    const key = requiredString(marketOnceKey, 'marketOnceKey')
    const derivedKey = buildCardMarketOnceKey({
      cardId: input.cardId,
      signal: input.signalSnapshot,
      lockedSelection: input.lockedSelection,
    })
    if (key !== derivedKey) throw new Error('card-market-once-key-mismatch')
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      const existing = this.db.prepare('SELECT batch_id FROM bet_market_once_claims WHERE market_once_key=?').get(key)
      if (existing) return { status: 'already-claimed', batchId: existing.batch_id || null }
      const current = this.db.prepare('SELECT * FROM auto_betting_rule_cards WHERE card_id=?').get(input.cardId)
      if (!current) {
        const deleted = this.db.prepare(`SELECT status,skip_reason,batch_id FROM auto_betting_signal_inbox
          WHERE signal_id=? AND card_id=? AND card_version=?`).get(input.signalId, input.cardId, input.cardVersion)
        if (deleted?.status === 'skipped' && deleted.skip_reason === 'rule-deleted' && deleted.batch_id === null) {
          return { status: 'skipped', reason: 'rule-deleted', inboxFinalized: true }
        }
      }
      const persistedSignal = this._assertModeScopedCoherence(input, { validateLatestSelection: false })
      let reason = ''
      if (!current) reason = 'rule-deleted'
      else if (current.migration_review_required !== 0) reason = 'migration-review-required'
      else if (current.enabled !== 1) reason = 'betting-mode-disabled'
      else if (current.version !== input.cardVersion) reason = 'card-version-changed'
      const leagues = current ? this.db.prepare(`SELECT league_name FROM auto_betting_rule_card_leagues
        WHERE card_id=? ORDER BY league_name`).all(input.cardId).map((row) => row.league_name) : []
      const currentSnapshot = reason ? null : completeRuleCardSnapshot(current, leagues)
      if (!reason && !currentSnapshot) reason = 'signal-invalid'
      if (!reason && !isDeepStrictEqual(currentSnapshot, input.cardSnapshot)) {
        reason = 'card-snapshot-changed'
      }
      if (reason) {
        const finalized = this.db.prepare(`UPDATE auto_betting_signal_inbox
          SET status='skipped',skip_reason=?,batch_id=NULL,next_attempt_at='',lease_owner='',lease_expires_at='',updated_at=?
          WHERE signal_id=? AND card_id=? AND card_version=? AND status='processing'
            AND lease_owner=? AND lease_expires_at=?`).run(
          reason, timestamp(this.now()), input.signalId, input.cardId, input.cardVersion,
          input.inboxLease.ownerId, timestamp(input.inboxLease.expiresAt),
        )
        if (finalized.changes !== 1) throw new Error('inbox-lease-stale')
        return { status: 'skipped', reason, inboxFinalized: true }
      }
      this._assertLatestSelectionCoherence(input, persistedSignal)
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      const at = timestamp()
      this.db.prepare(`INSERT INTO bet_market_once_claims (
        market_once_key,card_id,card_version,rule_id,betting_mode,settings_version,signal_id,
        batch_id,claim_status,failure_reason,created_at,updated_at
      ) VALUES (?,?,?,NULL,?,NULL,?,NULL,'claimed',NULL,?,?)`)
        .run(key, input.cardId, input.cardVersion, input.bettingMode, input.signalId, at, at)
      const batch = this.createCardScopedBatch(input, { fencingToken: token, requireRealRuntime,
        realLeaseEvidence, [IN_TRANSACTION]: true })
      const children = this.reserveRound(batch.batchId, allocations, { fencingToken: token, requireRealRuntime,
        realLeaseEvidence, [IN_TRANSACTION]: true })
      if (authorizationId) {
        for (const child of children) reserveAuthorizationBudgetInTransaction(this.db, {
          authorizationId, cardId: input.cardId, eligibilityVersion: Number(current.real_eligibility_version),
          bettingMode: input.bettingMode, leaseKey: this.leaseKey, executorOwnerId, fencingToken: token,
          childOrderId: child.childOrderId, batchId: batch.batchId, accountId: child.accountId,
          amountMinor: child.amountMinor,
        }, authorizationOptions)
      }
      const changed = this.db.prepare(`UPDATE bet_market_once_claims
        SET batch_id=?,claim_status='batch_created',updated_at=?
        WHERE market_once_key=? AND card_id=? AND card_version=? AND signal_id=? AND claim_status='claimed'`)
        .run(batch.batchId, timestamp(), key, input.cardId, input.cardVersion, input.signalId)
      if (changed.changes !== 1) throw new Error('market-once-claim-transition')
      const inboxBound = this.db.prepare(`UPDATE auto_betting_signal_inbox
        SET status='batch_created',batch_id=?,skip_reason='',next_attempt_at='',
            lease_owner='',lease_expires_at='',updated_at=?
        WHERE signal_id=? AND card_id=? AND card_version=? AND status='processing'
          AND lease_owner=? AND lease_expires_at=?`)
        .run(batch.batchId, timestamp(this.now()), input.signalId, input.cardId, input.cardVersion,
          input.inboxLease.ownerId, timestamp(input.inboxLease.expiresAt))
      if (inboxBound.changes !== 1) throw new Error('inbox-lease-stale')
      return { status: 'batch_created', batchId: batch.batchId, batch, children }
    })
  }

  createAuthorizedBatchWithReservations(input = {}, allocations = [], {
    fencingToken,
    marketOnceKey = '',
    requireRealRuntime = false,
    realLeaseEvidence = null,
    authorizationId,
    executorOwnerId,
    authorizationOptions = {},
  } = {}) {
    const token = this._token(fencingToken)
    const authId = requiredString(authorizationId, 'authorizationId')
    if (input.authorizationId !== authId) throw new Error('bet-batch-authorization-mismatch')
    if (!this.leaseKey) throw new Error('executor-lease-key')
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      const existing = this.db.prepare(`
        SELECT * FROM bet_batches WHERE signal_id = ? AND rule_id = ?
      `).get(input.signalId, input.ruleId)
      if (existing) {
        const contractMatches = existing.authorization_id === authId
          && existing.signal_id === input.signalId
          && existing.rule_id === input.ruleId
          && Number(existing.target_amount_minor) === Number(input.targetAmountMinor)
          && existing.currency === input.currency
          && Number(existing.amount_scale) === Number(input.amountScale)
          && !['completed', 'partial', 'failed', 'cancelled'].includes(existing.status)
        const invalidChild = this.db.prepare(`
          SELECT 1
          FROM bet_child_orders AS child
          LEFT JOIN execution_authorization_child_budgets AS budget
            ON budget.child_order_id = child.child_order_id
          WHERE child.batch_id = ?
            AND child.status IN ('previewing','reserved','submit_prepared','submit_dispatched','unknown')
            AND (
              budget.child_order_id IS NULL
              OR budget.authorization_id <> ?
              OR budget.batch_id <> child.batch_id
              OR budget.account_id <> child.account_id
              OR budget.amount_minor <> child.requested_amount_minor
            )
          LIMIT 1
        `).get(existing.batch_id, authId)
        const claim = marketOnceKey ? this.db.prepare(`
          SELECT batch_id, claim_status FROM bet_market_once_claims WHERE market_once_key = ?
        `).get(marketOnceKey) : null
        if (!contractMatches || invalidChild || (marketOnceKey && (claim?.batch_id !== existing.batch_id || claim?.claim_status !== 'batch_created'))) {
          throw new Error('authorized-batch-conflict')
        }
        return {
          batch: batchResult(existing),
          children: this.listChildOrders(existing.batch_id),
        }
      }
      const batch = this.createBatch(input, {
        fencingToken: token,
        requireRealRuntime,
        realLeaseEvidence,
        [IN_TRANSACTION]: true,
      })
      const children = this.reserveRound(batch.batchId, allocations, {
        fencingToken: token,
        requireRealRuntime,
        realLeaseEvidence,
        [IN_TRANSACTION]: true,
      })
      for (const child of children) {
        reserveAuthorizationBudgetInTransaction(this.db, {
          authorizationId: authId,
          ruleId: input.ruleId,
          leaseKey: this.leaseKey,
          executorOwnerId,
          fencingToken: token,
          childOrderId: child.childOrderId,
          batchId: batch.batchId,
          accountId: child.accountId,
          amountMinor: child.amountMinor,
        }, authorizationOptions)
      }
      if (marketOnceKey) {
        const updated = this.db.prepare(`
          UPDATE bet_market_once_claims
          SET batch_id = ?, claim_status = 'batch_created', failure_reason = NULL, updated_at = ?
          WHERE market_once_key = ? AND rule_id = ? AND signal_id = ? AND claim_status = 'claimed'
        `).run(batch.batchId, timestamp(), marketOnceKey, input.ruleId, input.signalId)
        if (updated.changes !== 1) throw new Error('market-once-claim-transition')
      }
      return { batch, children }
    })
  }

  createAuthorizedModeScopedBatchWithReservations(input = {}, allocations = [], {
    fencingToken, marketOnceKey = '', requireRealRuntime = false, realLeaseEvidence = null,
    authorizationId, executorOwnerId, authorizationOptions = {},
  } = {}) {
    const token = this._token(fencingToken)
    const authId = requiredString(authorizationId, 'authorizationId')
    if (input.authorizationId !== authId) throw new Error('bet-batch-authorization-mismatch')
    if (!this.leaseKey) throw new Error('executor-lease-key')
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      if (marketOnceKey) this._assertModeScopedCoherence(input)
      if (marketOnceKey) {
        const existingClaim = this.db.prepare('SELECT batch_id FROM bet_market_once_claims WHERE market_once_key=?').get(marketOnceKey)
        if (existingClaim) return { status: 'already-claimed', batchId: existingClaim.batch_id || null }
        const at = timestamp()
        this.db.prepare(`
          INSERT INTO bet_market_once_claims (
            market_once_key, rule_id, betting_mode, settings_version, signal_id,
            batch_id, claim_status, failure_reason, created_at, updated_at
          ) VALUES (?, NULL, ?, ?, ?, NULL, 'claimed', NULL, ?, ?)
        `).run(marketOnceKey, input.bettingMode, input.settingsVersion, input.signalId, at, at)
        this._fault('mode:after-claim-insert', { marketOnceKey })
      }
      const existing = this.db.prepare(`
        SELECT * FROM bet_batches
        WHERE signal_id=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
      `).get(input.signalId, input.bettingMode, input.settingsVersion)
      if (existing) {
        if (existing.authorization_id !== authId
          || existing.settings_snapshot_json !== JSON.stringify(input.settingsSnapshot)
          || Number(existing.target_amount_minor) !== Number(input.targetAmountMinor)) {
          throw new Error('authorized-batch-conflict')
        }
        return { status: 'batch_created', batchId: existing.batch_id, batch: batchResult(existing), children: this.listChildOrders(existing.batch_id) }
      }
      const batch = this.createModeScopedBatch(input, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-batch-insert', { batchId: batch.batchId, authorized: true })
      const children = this.reserveRound(batch.batchId, allocations, {
        fencingToken: token, requireRealRuntime, realLeaseEvidence, [IN_TRANSACTION]: true,
      })
      this._fault('mode:after-reservations', { batchId: batch.batchId, authorized: true })
      for (const child of children) {
        reserveAuthorizationBudgetInTransaction(this.db, {
          authorizationId: authId,
          bettingMode: input.bettingMode,
          leaseKey: this.leaseKey,
          executorOwnerId,
          fencingToken: token,
          childOrderId: child.childOrderId,
          batchId: batch.batchId,
          accountId: child.accountId,
          amountMinor: child.amountMinor,
        }, authorizationOptions)
      }
      if (marketOnceKey) {
        const updated = this.db.prepare(`
          UPDATE bet_market_once_claims
          SET batch_id=?, claim_status='batch_created', failure_reason=NULL, updated_at=?
          WHERE market_once_key=? AND rule_id IS NULL AND betting_mode=? AND settings_version=?
            AND signal_id=? AND claim_status='claimed'
        `).run(batch.batchId, timestamp(), marketOnceKey, input.bettingMode, input.settingsVersion, input.signalId)
        if (updated.changes !== 1) throw new Error('market-once-claim-transition')
        this._fault('mode:after-claim-transition', { batchId: batch.batchId, authorized: true })
      }
      return { status: 'batch_created', batchId: batch.batchId, batch, children }
    })
  }

  prepareSubmit(childOrderId, { submitAttemptId, at, fencingToken, requireRealRuntime = false, realLeaseEvidence = null } = {}) {
    const id = requiredString(childOrderId, 'childOrderId')
    const attemptId = requiredString(submitAttemptId, 'submitAttemptId')
    const changedAt = timestamp(at)
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertRealRuntime(requireRealRuntime, realLeaseEvidence)
      this._assertTransactionFence(token)
      const child = this._requireChild(id)
      this._assertChildFence(id, token)
      if (child.status === 'submit_prepared' && child.submit_attempt_id === attemptId) return childResult(child)
      if (child.status !== 'reserved') throw new Error('child-not-reserved')
      this.db.prepare(`
        UPDATE bet_child_orders
        SET status = 'submit_prepared', submit_attempt_id = ?, submit_prepared_at = ?
        WHERE child_order_id = ?
      `).run(attemptId, changedAt, id)
      this.db.prepare(`
        UPDATE betting_account_locks
        SET status = 'submitting', updated_at = ?
        WHERE child_order_id = ? AND fencing_token = ?
      `).run(changedAt, id, token)
      this._fault('prepare:after-update', { childOrderId: id })
      this._reconcileAggregates(child.batch_id, { hasFutureCapacity: true, at: changedAt })
      return childResult(this._requireChild(id))
    })
  }

  markDispatched(childOrderId, { at, fencingToken } = {}) {
    const id = requiredString(childOrderId, 'childOrderId')
    const changedAt = timestamp(at)
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertTransactionFence(token)
      const child = this._requireChild(id)
      this._assertChildFence(id, token)
      if (child.status === 'submit_dispatched') return childResult(child)
      if (child.status !== 'submit_prepared') throw new Error('child-not-prepared')
      this.db.prepare(`
        UPDATE bet_child_orders
        SET status = 'submit_dispatched', submit_dispatched_at = ?, submitted_at = ?
        WHERE child_order_id = ?
      `).run(changedAt, changedAt, id)
      this._fault('dispatch:after-update', { childOrderId: id })
      this._reconcileAggregates(child.batch_id, { hasFutureCapacity: true, at: changedAt })
      return childResult(this._requireChild(id))
    })
  }

  resolveChildOrder(childOrderId, result = {}) {
    const id = requiredString(childOrderId, 'childOrderId')
    const status = requiredString(typeof result === 'string' ? result : result.status, 'status')
    if (!['accepted', 'rejected', 'unknown'].includes(status)) throw new TypeError('child-result-status')
    const options = typeof result === 'string' ? {} : result
    const changedAt = timestamp(options.at)
    const token = this._token(options.fencingToken)
    return runImmediate(this.db, () => {
      this._assertTransactionFence(token)
      const child = this._requireChild(id)
      this._assertUnboundChild(id)
      if (child.status === status) return childResult(child)
      if (TERMINAL_STATUSES.has(child.status)) throw new Error('child-terminal')
      this._assertChildFence(id, token)
      if (status !== 'rejected' && !['submit_prepared', 'submit_dispatched', 'unknown'].includes(child.status)) {
        throw new Error('child-not-submitted')
      }
      this.db.prepare(`
        UPDATE bet_child_orders
        SET status = ?,
            provider_reference_ciphertext = ?,
            error_code = ?,
            error_message = ?,
            resolved_at = ?
        WHERE child_order_id = ?
      `).run(
        status,
        String(options.providerReferenceCiphertext || child.provider_reference_ciphertext || ''),
        String(options.errorCode || ''),
        String(options.errorMessage || ''),
        status === 'unknown' ? '' : changedAt,
        id,
      )
      this._fault('resolve:after-child-update', { childOrderId: id, status })
      if (status === 'unknown') {
        this.db.prepare(`
          UPDATE betting_account_locks
          SET status = 'unknown', updated_at = ?
          WHERE child_order_id = ? AND fencing_token = ?
        `).run(changedAt, id, token)
      } else {
        this.db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ? AND fencing_token = ?').run(id, token)
      }
      this._reconcileAggregates(child.batch_id, {
        hasFutureCapacity: options.hasFutureCapacity ?? true,
        at: changedAt,
      })
      return childResult(this._requireChild(id))
    })
  }

  cancelUnsubmitted(batchId, { finishReason = 'manual_cancel', at, fencingToken } = {}) {
    const id = requiredString(batchId, 'batchId')
    const stopReason = requiredString(finishReason, 'finishReason')
    if (!STOP_REASONS.has(stopReason)) throw new TypeError('finishReason')
    const changedAt = timestamp(at)
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertTransactionFence(token)
      this._requireBatch(id)
      this._assertUnboundBatch(id)
      this._assertBatchFence(id, token)
      this.db.prepare(`
        UPDATE bet_child_orders
        SET status = 'cancelled', resolved_at = ?, error_code = ?
        WHERE batch_id = ? AND status IN ('previewing', 'reserved')
      `).run(changedAt, stopReason, id)
      this.db.prepare(`
        DELETE FROM betting_account_locks
        WHERE batch_id = ?
          AND child_order_id IN (
            SELECT child_order_id FROM bet_child_orders WHERE batch_id = ? AND status = 'cancelled'
          )
          AND fencing_token = ?
      `).run(id, id, token)
      this._reconcileAggregates(id, { hasFutureCapacity: false, finishReason: stopReason, at: changedAt, cancellation: true })
      return batchResult(this._requireBatch(id))
    })
  }

  _reconcileAggregates(batchId, {
    hasFutureCapacity = true,
    finishReason = '',
    at,
    cancellation = false,
    preserveQueued = false,
  } = {}) {
    const batch = this._requireBatch(batchId)
    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'submit_prepared', 'submit_dispatched') THEN requested_amount_minor ELSE 0 END), 0) AS reserved,
        COALESCE(SUM(CASE WHEN status = 'accepted' THEN requested_amount_minor ELSE 0 END), 0) AS accepted,
        COALESCE(SUM(CASE WHEN status = 'unknown' THEN requested_amount_minor ELSE 0 END), 0) AS unknown,
        COALESCE(SUM(CASE WHEN status IN ('previewing', 'reserved', 'submit_prepared', 'submit_dispatched') THEN 1 ELSE 0 END), 0) AS nonterminal,
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'submit_prepared', 'submit_dispatched') THEN 1 ELSE 0 END), 0) AS active_submit,
        COUNT(*) AS child_count
      FROM bet_child_orders
      WHERE batch_id = ?
    `).get(batchId)
    for (const [field, value] of Object.entries({ reserved: totals.reserved, accepted: totals.accepted, unknown: totals.unknown })) {
      assertMinor(value, field)
    }
    if (totals.accepted > Number.MAX_SAFE_INTEGER - totals.reserved) throw new Error('batch-ledger-invariant')
    const decided = totals.reserved + totals.accepted
    if (totals.unknown > Number.MAX_SAFE_INTEGER - decided) throw new Error('batch-ledger-invariant')
    const occupied = decided + totals.unknown
    if (occupied > batch.target_amount_minor) throw new Error('batch-ledger-invariant')
    const unfilled = batch.target_amount_minor - occupied
    const requestedStopReason = STOP_REASONS.has(finishReason) ? finishReason : ''
    const stopReason = requestedStopReason || (STOP_REASONS.has(batch.finish_reason) ? batch.finish_reason : '')

    let status
    if (totals.unknown > 0) status = 'waiting_result'
    else if (totals.active_submit > 0) status = 'submitting'
    else if (stopReason) status = totals.accepted > 0 ? 'partial' : 'cancelled'
    else if (totals.accepted >= batch.target_amount_minor && totals.nonterminal === 0) status = 'completed'
    else if (preserveQueued && totals.child_count === 0 && batch.status === 'queued') status = 'queued'
    else if (hasFutureCapacity) status = 'waiting_capacity'
    else if (totals.accepted > 0) status = 'partial'
    else if (cancellation) status = 'cancelled'
    else status = 'failed'

    if (['completed', 'partial', 'failed', 'cancelled'].includes(batch.status)) status = batch.status
    const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(status)
    const existingSafetyReason = STOP_REASONS.has(batch.finish_reason) ? batch.finish_reason : ''
    let stableFinishReason = stopReason || existingSafetyReason
    if (!stableFinishReason) {
      if (status === 'waiting_result') stableFinishReason = 'unknown_result'
      else if (status === 'completed') stableFinishReason = 'all_accepted'
      else if (status === 'partial') stableFinishReason = 'partial_fulfillment'
      else if (status === 'failed') stableFinishReason = totals.child_count > 0 ? 'provider_rejected' : 'no_capacity'
      else if (status === 'cancelled') stableFinishReason = String(finishReason || batch.finish_reason || 'manual_cancel')
    }
    if (['completed', 'partial', 'failed', 'cancelled'].includes(batch.status) && existingSafetyReason) {
      stableFinishReason = batch.finish_reason
    }
    const changedAt = timestamp(at)
    this.db.prepare(`
      UPDATE bet_batches
      SET reserved_amount_minor = ?, accepted_amount_minor = ?, unknown_amount_minor = ?,
          unfilled_amount_minor = ?, status = ?,
          finish_reason = ?, finished_at = ?
      WHERE batch_id = ?
    `).run(
      totals.reserved,
      totals.accepted,
      totals.unknown,
      unfilled,
      status,
      stableFinishReason,
      terminal ? (batch.finished_at || changedAt) : '',
      batchId,
    )
    return this._requireBatch(batchId)
  }

  reconcileAggregates(batchId, { hasFutureCapacity = true, finishReason = '', at, fencingToken } = {}) {
    const id = requiredString(batchId, 'batchId')
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertTransactionFence(token)
      this._assertBatchFence(id, token)
      return batchResult(this._reconcileAggregates(id, { hasFutureCapacity, finishReason, at }))
    })
  }

  recover({ at, fencingToken } = {}) {
    const changedAt = timestamp(at)
    const token = this._token(fencingToken)
    return runImmediate(this.db, () => {
      this._assertTransactionFence(token)
      const uncertain = this.db.prepare(`
        SELECT child_order_id
        FROM bet_child_orders
        WHERE status IN ('submit_prepared', 'submit_dispatched')
      `).all()
      const legacyAuthorizationReservations = this.db.prepare(`
        SELECT budget.authorization_id, SUM(budget.amount_minor) AS amount_minor
        FROM execution_authorization_child_budgets AS budget
        JOIN bet_child_orders AS child ON child.child_order_id = budget.child_order_id
        WHERE child.status IN ('submit_prepared', 'submit_dispatched')
          AND budget.status = 'reserved'
        GROUP BY budget.authorization_id
      `).all()
      this.db.prepare(`
        UPDATE bet_submit_attempts
        SET status = 'unknown',
            result_at = ?,
            error_code = CASE WHEN error_code = '' THEN 'recovery-uncertain' ELSE error_code END,
            updated_at = ?
        WHERE status IN ('submit_prepared', 'submit_dispatched')
      `).run(changedAt, changedAt)
      this.db.prepare(`
        UPDATE execution_authorization_child_budgets
        SET status = 'unknown', updated_at = ?
        WHERE status = 'reserved'
          AND child_order_id IN (
            SELECT child_order_id FROM bet_child_orders
            WHERE status IN ('submit_prepared', 'submit_dispatched')
          )
      `).run(changedAt)
      for (const reservation of legacyAuthorizationReservations) {
        const amount = Number(reservation.amount_minor)
        const changed = this.db.prepare(`
          UPDATE execution_authorizations
          SET reserved_amount_minor = reserved_amount_minor - ?,
              unknown_amount_minor = unknown_amount_minor + ?,
              updated_at = ?
          WHERE authorization_id = ? AND reserved_amount_minor >= ?
        `).run(amount, amount, changedAt, reservation.authorization_id, amount)
        if (changed.changes !== 1) throw new Error('authorization-ledger-invariant')
      }
      this.db.prepare(`
        UPDATE bet_child_orders
        SET status = 'unknown', error_code = CASE WHEN error_code = '' THEN 'recovery-uncertain' ELSE error_code END
        WHERE status IN ('submit_prepared', 'submit_dispatched')
      `).run()
      const reconciliationDeadline = new Date(
        Date.parse(changedAt) + RECONCILIATION_DEADLINE_MS,
      ).toISOString()
      this.db.prepare(`
        INSERT INTO bet_reconciliation_state (
          submit_attempt_id, status, poll_count, next_poll_at, deadline_at, created_at, updated_at
        )
        SELECT attempt.submit_attempt_id, 'pending', 0, ?, ?, ?, ?
        FROM bet_submit_attempts AS attempt
        JOIN bet_child_orders AS child ON child.child_order_id=attempt.child_order_id
        WHERE attempt.status='unknown' AND child.status='unknown'
        ON CONFLICT(submit_attempt_id) DO NOTHING
      `).run(changedAt, reconciliationDeadline, changedAt, changedAt)

      this.db.prepare(`
        DELETE FROM betting_account_locks
        WHERE child_order_id NOT IN (
          SELECT child_order_id FROM bet_child_orders
          WHERE status IN ('previewing', 'reserved', 'submit_prepared', 'submit_dispatched', 'unknown')
        )
      `).run()

      const active = this.db.prepare(`
        SELECT child_order_id, batch_id, account_id, status, created_at
        FROM bet_child_orders
        WHERE status IN ('previewing', 'reserved', 'submit_prepared', 'submit_dispatched', 'unknown')
        ORDER BY account_id,
          CASE WHEN status = 'unknown' THEN 0 ELSE 1 END,
          created_at, child_order_id
      `).all()
      this.db.prepare('DELETE FROM betting_account_locks').run()
      const lockedAccounts = new Set()
      for (const child of active) {
        if (lockedAccounts.has(child.account_id)) continue
        lockedAccounts.add(child.account_id)
        const expectedLockStatus = child.status === 'unknown'
          ? 'unknown'
          : (child.status === 'submit_prepared' || child.status === 'submit_dispatched' ? 'submitting' : 'reserved')
        this.db.prepare(`
          INSERT INTO betting_account_locks (
            account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(child.account_id, child.child_order_id, child.batch_id, expectedLockStatus, token, child.created_at || changedAt, changedAt)
      }

      const batches = this.db.prepare(`
        SELECT batch_id, status
        FROM bet_batches
        WHERE status NOT IN ('completed', 'partial', 'failed', 'cancelled')
        ORDER BY created_at, batch_id
      `).all()
      for (const batch of batches) {
        this._reconcileAggregates(batch.batch_id, {
          hasFutureCapacity: true,
          at: changedAt,
          preserveQueued: true,
        })
      }
      return { unknownCount: uncertain.length, activeLockCount: lockedAccounts.size, batchCount: batches.length }
    })
  }

  getBatch(batchId) {
    return batchResult(this._batch(batchId))
  }

  listChildOrders(batchId) {
    return this.db.prepare(`
      SELECT * FROM bet_child_orders WHERE batch_id = ? ORDER BY created_at, child_order_id
    `).all(requiredString(batchId, 'batchId')).map(childResult)
  }
}
