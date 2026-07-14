import { createHash, randomUUID } from 'node:crypto'

import { assertMinor } from './money.mjs'
import { assertCanonicalRealRule } from './canonical-real-rule.mjs'
import { CROWN_CAPABILITY_MATRIX_VERSION } from './crown-capability-matrix.mjs'
import { isSafetyFinishReason } from './safety-finish-reasons.mjs'

const DEFAULT_AUTHORIZATION_DURATION_MS = 15 * 60_000
const MAX_AUTHORIZATION_DURATION_MS = 24 * 60 * 60_000

function executionDb(database) {
  const db = database?.db || database
  if (!db?.prepare || !db?.exec) throw new TypeError('execution-gate-db')
  return db
}

function requiredText(value, field) {
  const result = String(value ?? '').trim()
  if (!result) throw new TypeError(`${field}-required`)
  return result
}

function nowIso(now) {
  if (typeof now !== 'function') throw new TypeError('execution-gate-now')
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('execution-gate-time')
  return date.toISOString()
}

function realEnvironment(env) {
  const currency = String(env?.CROWN_REAL_CURRENCY ?? '')
  const scaleText = String(env?.CROWN_REAL_AMOUNT_SCALE ?? '')
  const capText = String(env?.CROWN_REAL_MAX_TOTAL_MINOR ?? '')
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('real-environment-currency')
  if (!/^[0-6]$/.test(scaleText)) throw new TypeError('real-environment-scale')
  if (!/^[1-9]\d*$/.test(capText)) throw new TypeError('real-environment-hard-cap')
  const hardCapAmountMinor = Number(capText)
  if (!Number.isSafeInteger(hardCapAmountMinor) || hardCapAmountMinor < 1) {
    throw new TypeError('real-environment-hard-cap')
  }
  return {
    currency,
    amountScale: Number(scaleText),
    hardCapAmountMinor,
  }
}

function normalizeRuleIds(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError('authorization-rule-ids')
  const result = [...new Set(value.map((ruleId) => requiredText(ruleId, 'authorization-rule-id')))].sort()
  if (!allowEmpty && result.length === 0) throw new TypeError('authorization-rule-ids')
  return result
}

const BETTING_MODES = new Set(['prematch', 'live'])

function normalizeBettingModes(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError('authorization-betting-modes')
  const result = [...new Set(value.map((mode) => requiredText(mode, 'authorization-betting-mode')))].sort()
  if ((!allowEmpty && result.length === 0) || result.some((mode) => !BETTING_MODES.has(mode))) {
    throw new TypeError('authorization-betting-modes')
  }
  return result
}

function normalizeEligibilityVersions(value, modes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authorization-eligibility-versions')
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify(modes)) throw new TypeError('authorization-eligibility-versions')
  const result = {}
  for (const mode of modes) {
    if (!Number.isSafeInteger(value[mode]) || value[mode] < 1) throw new TypeError('authorization-eligibility-versions')
    result[mode] = value[mode]
  }
  return result
}

function normalizeCardScopes(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError('authorization-card-scopes')
  const result = value.map((scope) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.keys(scope).sort().join('|') !== 'cardId|eligibilityVersion') throw new TypeError('authorization-card-scopes')
    const cardId = requiredText(scope.cardId, 'authorization-card-id')
    if (!Number.isSafeInteger(scope.eligibilityVersion) || scope.eligibilityVersion < 1) throw new TypeError('authorization-card-scopes')
    return { cardId, eligibilityVersion: scope.eligibilityVersion }
  }).sort((a, b) => a.cardId.localeCompare(b.cardId))
  if (new Set(result.map((scope) => scope.cardId)).size !== result.length) throw new TypeError('authorization-card-scopes')
  return result
}

function positiveMinor(value, field = 'amount') {
  assertMinor(value, field)
  if (value === 0) throw new RangeError(`${field}-minor-positive`)
  return value
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

function committedGateDenial(message) {
  const error = new Error(message)
  error.commitGateStatus = true
  return error
}

function runGateImmediate(db, operation) {
  let denial = null
  const result = runImmediate(db, () => {
    try {
      return operation()
    } catch (error) {
      if (!error?.commitGateStatus) throw error
      denial = error
      return null
    }
  })
  if (denial) throw denial
  return result
}

function injectFault(options, phase, details = {}) {
  if (options.faultInjector === undefined || options.faultInjector === null) return
  if (typeof options.faultInjector !== 'function') throw new TypeError('execution-gate-fault-injector')
  options.faultInjector(phase, details)
}

function parseRuleIds(row) {
  let value
  try { value = JSON.parse(row.rule_ids_json) } catch { throw new Error('authorization-corrupt') }
  if (!Array.isArray(value) || value.some((ruleId) => typeof ruleId !== 'string' || !ruleId)) {
    throw new Error('authorization-corrupt')
  }
  return value
}

function parseModeScope(row) {
  let modes
  let versions
  try {
    modes = JSON.parse(row.betting_modes_json || '[]')
    versions = JSON.parse(row.eligibility_versions_json || '{}')
  } catch { throw new Error('authorization-corrupt') }
  try {
    const bettingModes = normalizeBettingModes(modes, { allowEmpty: true })
    const cardScopes = JSON.parse(row.card_scopes_json || '[]')
    if (Array.isArray(cardScopes) && cardScopes.length > 0 && Object.keys(versions).length === 0) {
      return { bettingModes, eligibilityVersions: {} }
    }
    return { bettingModes, eligibilityVersions: normalizeEligibilityVersions(versions, bettingModes) }
  } catch { throw new Error('authorization-corrupt') }
}

function parseCardScopes(row) {
  try { return normalizeCardScopes(JSON.parse(row.card_scopes_json || '[]'), { allowEmpty: true }) }
  catch { throw new Error('authorization-corrupt') }
}

function authorizationResult(row) {
  if (!row) return null
  const modeScope = parseModeScope(row)
  return {
    authorizationId: row.authorization_id,
    mode: row.mode,
    currency: row.currency,
    amountScale: Number(row.amount_scale),
    ruleIds: parseRuleIds(row),
    cardScopes: parseCardScopes(row),
    ...modeScope,
    maxTotalAmountMinor: Number(row.max_total_amount_minor),
    hardCapAmountMinor: Number(row.hard_cap_amount_minor),
    reservedAmountMinor: Number(row.reserved_amount_minor),
    acceptedAmountMinor: Number(row.accepted_amount_minor),
    unknownAmountMinor: Number(row.unknown_amount_minor),
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    status: row.status,
    confirmationDigest: row.confirmation_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function batchResult(row) {
  if (!row) return null
  return {
    batchId: row.batch_id,
    signalId: row.signal_id,
    ruleId: row.rule_id,
    targetAmountMinor: Number(row.target_amount_minor),
    reservedAmountMinor: Number(row.reserved_amount_minor),
    acceptedAmountMinor: Number(row.accepted_amount_minor),
    unknownAmountMinor: Number(row.unknown_amount_minor),
    unfilledAmountMinor: Number(row.unfilled_amount_minor),
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
    attempt: Number(row.attempt),
    amountMinor: Number(row.requested_amount_minor),
    status: row.status,
    submitAttemptId: row.submit_attempt_id,
  }
}

function environmentMatches(row, configured) {
  return configured !== null
    && row.currency === configured.currency
    && Number(row.amount_scale) === configured.amountScale
    && Number(row.hard_cap_amount_minor) === configured.hardCapAmountMinor
    && Number(row.max_total_amount_minor) <= configured.hardCapAmountMinor
}

function recomputeBatchCaches(db, batchId, {
  at,
  stopReason = '',
  hasFutureCapacity = true,
  cancellation = false,
  preserveQueued = false,
} = {}) {
  const batch = db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
  if (!batch) throw new Error('bet-batch-not-found')
  const totals = db.prepare(`
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
  for (const [field, value] of Object.entries(totals)) assertMinor(value, `batch-${field}`)
  const occupied = BigInt(totals.reserved) + BigInt(totals.accepted) + BigInt(totals.unknown)
  if (occupied > BigInt(batch.target_amount_minor)) throw new Error('batch-ledger-invariant')
  const unfilled = Number(BigInt(batch.target_amount_minor) - occupied)
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
  const stableFinishReason = stopReason || (isSafetyFinishReason(batch.finish_reason) ? batch.finish_reason : '')
    || (status === 'waiting_result' ? 'unknown_result'
      : status === 'completed' ? 'all_accepted'
        : status === 'partial' ? 'partial_fulfillment'
          : status === 'failed' ? (totals.child_count > 0 ? 'provider_rejected' : 'no_capacity')
            : status === 'cancelled' ? 'manual_cancel' : '')
  db.prepare(`
    UPDATE bet_batches
    SET reserved_amount_minor = ?, accepted_amount_minor = ?, unknown_amount_minor = ?,
        unfilled_amount_minor = ?, status = ?, finish_reason = ?, finished_at = ?
    WHERE batch_id = ?
  `).run(
    totals.reserved,
    totals.accepted,
    totals.unknown,
    unfilled,
    status,
    stableFinishReason,
    terminal ? (batch.finished_at || at) : '',
    batchId,
  )
}

function cancelProvablyUnsentAuthorizationChildren(db, authorizationId, { at, reason }) {
  const rows = db.prepare(`
    SELECT budget.child_order_id, budget.batch_id, budget.amount_minor, child.status
    FROM execution_authorization_child_budgets AS budget
    JOIN bet_child_orders AS child ON child.child_order_id = budget.child_order_id
    WHERE budget.authorization_id = ?
      AND budget.status = 'reserved'
      AND child.status IN ('reserved', 'rejected', 'cancelled')
    ORDER BY budget.batch_id, budget.child_order_id
  `).all(authorizationId)
  let releasedMinor = 0
  const batchIds = new Set()
  for (const row of rows) {
    if (row.amount_minor > Number.MAX_SAFE_INTEGER - releasedMinor) throw new Error('authorization-ledger-invariant')
    releasedMinor += row.amount_minor
    batchIds.add(row.batch_id)
    if (row.status === 'reserved') {
      db.prepare(`
        UPDATE bet_child_orders
        SET status = 'cancelled', resolved_at = ?, error_code = ?
        WHERE child_order_id = ? AND status = 'reserved'
      `).run(at, reason, row.child_order_id)
      db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(row.child_order_id)
    }
    db.prepare(`
      UPDATE execution_authorization_child_budgets
      SET status = 'released', updated_at = ?
      WHERE child_order_id = ? AND status = 'reserved'
    `).run(at, row.child_order_id)
  }
  if (releasedMinor > 0) {
    const changed = db.prepare(`
      UPDATE execution_authorizations
      SET reserved_amount_minor = reserved_amount_minor - ?, updated_at = ?
      WHERE authorization_id = ? AND reserved_amount_minor >= ?
    `).run(releasedMinor, at, authorizationId, releasedMinor)
    if (changed.changes !== 1) throw new Error('authorization-ledger-invariant')
  }
  for (const batchId of batchIds) recomputeBatchCaches(db, batchId, { at, stopReason: reason })
  return { cancelledCount: rows.filter((row) => row.status === 'reserved').length, releasedMinor }
}

function writeExecutionSecurityAudit(db, {
  action,
  subjectType,
  subjectId,
  confirmationDigest = '',
  details = {},
  at,
}) {
  db.prepare(`
    INSERT INTO execution_security_audit (
      audit_id, action, subject_type, subject_id,
      confirmation_digest, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), action, subjectType, subjectId, confirmationDigest, JSON.stringify(details), at)
}

function refreshAuthorization(db, row, { configured, at }) {
  if (!row || row.status !== 'active') return row
  const atMs = Date.parse(at)
  const validFromMs = Date.parse(row.valid_from)
  const expiresAtMs = Date.parse(row.expires_at)
  let nextStatus = 'active'
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= atMs) {
    nextStatus = 'expired'
  } else if (!Number.isFinite(validFromMs) || validFromMs > atMs) {
    nextStatus = 'revoked'
  } else if (!environmentMatches(row, configured)) {
    nextStatus = 'revoked'
  } else if (
    Number(row.reserved_amount_minor) === 0
    && BigInt(row.accepted_amount_minor) + BigInt(row.unknown_amount_minor) >= BigInt(row.max_total_amount_minor)
  ) {
    nextStatus = 'exhausted'
  }
  if (nextStatus === 'active') return row
  if (nextStatus === 'expired' || nextStatus === 'revoked') {
    cancelProvablyUnsentAuthorizationChildren(db, row.authorization_id, {
      at,
      reason: nextStatus === 'expired' ? 'authorization_expired' : 'authorization_revoked',
    })
  }
  db.prepare(`
    UPDATE execution_authorizations
    SET status = ?, updated_at = ?
    WHERE authorization_id = ? AND status = 'active'
  `).run(nextStatus, at, row.authorization_id)
  return db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(row.authorization_id)
}

function authorizationStatusError(status) {
  if (status === 'revoked') return committedGateDenial('authorization-revoked')
  if (status === 'expired') return committedGateDenial('authorization-expired')
  if (status === 'exhausted') return committedGateDenial('authorization-exhausted')
  return committedGateDenial('authorization-inactive')
}

function requireAuthorization(db, authorizationId) {
  const row = db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?')
    .get(requiredText(authorizationId, 'authorization-id'))
  if (!row) throw new Error('authorization-required')
  return row
}

function assertExecutorFence(db, input, at) {
  const leaseKey = requiredText(input.leaseKey, 'executor-lease-key')
  if (!/^betting-executor:\S+$/.test(leaseKey)) throw new Error('executor-lease-key')
  const executorOwnerId = requiredText(input.executorOwnerId, 'executor-owner-id')
  const fencingToken = input.fencingToken
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new Error('executor-fence-stale')
  const lease = db.prepare(`
    SELECT fencing_token, expires_at
    FROM runtime_leases
    WHERE lease_key = ? AND owner_id = ?
  `).get(leaseKey, executorOwnerId)
  const expiresAt = Date.parse(lease?.expires_at)
  if (!lease || Number(lease.fencing_token) !== fencingToken || !Number.isFinite(expiresAt) || expiresAt <= Date.parse(at)) {
    throw new Error('executor-fence-stale')
  }
  return fencingToken
}

function assertExecutionGateInTransaction(db, input, { configured, at }) {
  let authorization = requireAuthorization(db, input.authorizationId)
  const environmentWasMatching = environmentMatches(authorization, configured)
  authorization = refreshAuthorization(db, authorization, { configured, at })
  if (authorization.status !== 'active') {
    if (!environmentWasMatching && authorization.status === 'revoked') {
      throw committedGateDenial('authorization-environment-mismatch')
    }
    throw authorizationStatusError(authorization.status)
  }
  const fencingToken = assertExecutorFence(db, input, at)
  reconcileAuthorizationBindingsInTransaction(db, authorization.authorization_id, {
    at,
    fencingToken,
    recoverUncertain: false,
  })
  authorization = requireAuthorization(db, authorization.authorization_id)
  if (authorization.status !== 'active') throw authorizationStatusError(authorization.status)

  let rule = null
  let setting = null
  if (input.cardId !== undefined && input.cardId !== null) {
    const cardId = requiredText(input.cardId, 'card-id')
    const eligibilityVersion = input.eligibilityVersion
    if (!Number.isSafeInteger(eligibilityVersion) || eligibilityVersion < 1) throw new TypeError('eligibility-version')
    const bettingMode = requiredText(input.bettingMode, 'betting-mode')
    if (!BETTING_MODES.has(bettingMode)) throw new TypeError('betting-mode')
    const scope = parseCardScopes(authorization).find((item) => item.cardId === cardId)
    if (!scope || scope.eligibilityVersion !== eligibilityVersion) throw new Error('authorization-card-scope')
    if (!parseModeScope(authorization).bettingModes.includes(bettingMode)) throw new Error('authorization-mode-scope')
    if (parseRuleIds(authorization).length !== 0) throw new Error('authorization-scope-mixed')
  } else if (input.bettingMode !== undefined && input.bettingMode !== null) {
    const bettingMode = requiredText(input.bettingMode, 'betting-mode')
    if (!BETTING_MODES.has(bettingMode)) throw new TypeError('betting-mode')
    const { bettingModes, eligibilityVersions } = parseModeScope(authorization)
    if (!bettingModes.includes(bettingMode)) throw new Error('authorization-mode-scope')
    if (parseRuleIds(authorization).length !== 0) throw new Error('authorization-scope-mixed')
    setting = db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(bettingMode)
    if (!setting) throw new Error('auto-betting-mode-not-found')
    if (Number(setting.real_eligible) !== 1
      || Number(setting.real_eligibility_version) !== eligibilityVersions[bettingMode]) {
      throw new Error('mode-eligibility-version')
    }
    if (Number(setting.enabled) !== 1) throw new Error('betting-mode-disabled')
    if (Number(setting.migration_review_required) !== 0) throw new Error('migration-review-required')
    if (setting.currency !== authorization.currency || Number(setting.amount_scale) !== Number(authorization.amount_scale)) {
      throw new Error('mode-money-mismatch')
    }
    positiveMinor(Number(setting.target_amount_minor), 'mode-target')
  } else {
    const ruleId = requiredText(input.ruleId, 'rule-id')
    if (!parseRuleIds(authorization).includes(ruleId)) throw new Error('authorization-rule-scope')
    if (parseModeScope(authorization).bettingModes.length !== 0) throw new Error('authorization-scope-mixed')
    rule = db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId)
    if (!rule) throw new Error('betting-rule-not-found')
    assertCanonicalRealRule(rule)
    if (rule.currency !== authorization.currency || Number(rule.amount_scale) !== Number(authorization.amount_scale)) {
      throw new Error('rule-money-mismatch')
    }
  }

  let account = null
  if (input.accountId !== undefined && input.accountId !== null) {
    const accountId = requiredText(input.accountId, 'account-id')
    account = db.prepare('SELECT * FROM betting_accounts WHERE id = ?').get(accountId)
    if (!account) throw new Error('betting-account-not-found')
    if (account.currency !== authorization.currency || Number(account.amount_scale) !== Number(authorization.amount_scale)) {
      throw new Error('account-money-mismatch')
    }
  }
  return { authorization, rule, setting, account }
}

function requireBudgetChild(db, childOrderId) {
  const row = db.prepare(`
    SELECT
      child.child_order_id, child.batch_id, child.account_id, child.requested_amount_minor, child.status AS child_status,
      batch.rule_id, batch.card_id, batch.card_version, batch.card_snapshot_json,
      batch.betting_mode, batch.authorization_id, batch.currency, batch.amount_scale
    FROM bet_child_orders AS child
    JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
    WHERE child.child_order_id = ?
  `).get(requiredText(childOrderId, 'child-order-id'))
  if (!row) throw new Error('child-order-not-found')
  return row
}

function operationContext(options = {}) {
  const configured = realEnvironment(options.env || process.env)
  const at = nowIso(options.now || (() => new Date()))
  return { configured, at }
}

export function upgradeRuleRealEligibility(database, input = {}, options = {}) {
  const db = executionDb(database)
  const configured = realEnvironment(options.env || process.env)
  const at = nowIso(options.now || (() => new Date()))
  const ruleId = requiredText(input.ruleId, 'rule-id')
  const confirmation = String(input.confirmation ?? '').trim()
  if (!confirmation) throw new TypeError('rule-upgrade-confirmation')

  return runImmediate(db, () => {
    const rule = db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId)
    if (!rule) throw new Error('betting-rule-not-found')
    if (Number(rule.enabled) !== 1) throw new Error('rule-upgrade-disabled')
    if (rule.execution_mode !== 'preview_only') throw new Error('rule-already-real-eligible')
    if (rule.currency !== configured.currency || Number(rule.amount_scale) !== configured.amountScale) {
      throw new Error('rule-money-mismatch')
    }
    const targetAmountMinor = positiveMinor(Number(rule.target_amount_minor), 'rule-target')
    if (targetAmountMinor > configured.hardCapAmountMinor) throw new Error('rule-target-hard-cap')

    const auditId = randomUUID()
    const confirmationDigest = createHash('sha256')
      .update(`${auditId}\0${ruleId}\0${confirmation}`, 'utf8')
      .digest('hex')
    const version = Number(rule.version) + 1
    if (!Number.isSafeInteger(version) || version < 2) throw new Error('rule-version-invalid')
    const changed = db.prepare(`
      UPDATE betting_rules
      SET execution_mode = 'real_eligible', version = ?, updated_at = ?
      WHERE id = ? AND enabled = 1 AND execution_mode = 'preview_only'
    `).run(version, at, ruleId)
    if (changed.changes !== 1) throw new Error('rule-upgrade-conflict')
    db.prepare(`
      INSERT INTO execution_security_audit (
        audit_id, action, subject_type, subject_id,
        confirmation_digest, details_json, created_at
      ) VALUES (?, 'rule_real_eligibility_upgraded', 'betting_rule', ?, ?, ?, ?)
    `).run(
      auditId,
      ruleId,
      confirmationDigest,
      JSON.stringify({
        fromExecutionMode: 'preview_only',
        toExecutionMode: 'real_eligible',
        currency: configured.currency,
        amountScale: configured.amountScale,
        targetAmountMinor,
        hardCapAmountMinor: configured.hardCapAmountMinor,
        version,
      }),
      at,
    )
    return {
      ruleId,
      executionMode: 'real_eligible',
      currency: configured.currency,
      amountScale: configured.amountScale,
      targetAmountMinor,
      version,
      updatedAt: at,
    }
  })
}

export function upgradeAutoBettingModeEligibility(database, input = {}, options = {}) {
  const db = executionDb(database)
  const configured = realEnvironment(options.env || process.env)
  const at = nowIso(options.now || (() => new Date()))
  const mode = requiredText(input.mode, 'betting-mode')
  if (!BETTING_MODES.has(mode)) throw new TypeError('betting-mode')
  const expectedVersion = input.expectedEligibilityVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected-eligibility-version')
  const expectedConfirmation = `UPGRADE AUTO BETTING ${mode} ELIGIBILITY ${expectedVersion} ${configured.currency}/${configured.amountScale}/${configured.hardCapAmountMinor} ${CROWN_CAPABILITY_MATRIX_VERSION}`
  if (input.confirmation !== expectedConfirmation) throw new Error('mode-eligibility-confirmation')
  return runImmediate(db, () => {
    const row = db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(mode)
    if (!row) throw new Error('auto-betting-mode-not-found')
    if (Number(row.real_eligibility_version) !== expectedVersion) throw new Error('mode-eligibility-version-conflict')
    if (Number(row.real_eligible) === 1) throw new Error('mode-already-real-eligible')
    if (Number(row.enabled) !== 1) throw new Error('mode-eligibility-disabled')
    if (Number(row.migration_review_required) !== 0) throw new Error('migration-review-required')
    if (row.currency !== configured.currency || Number(row.amount_scale) !== configured.amountScale) throw new Error('mode-money-mismatch')
    const targetAmountMinor = positiveMinor(Number(row.target_amount_minor), 'mode-target')
    if (targetAmountMinor > configured.hardCapAmountMinor) throw new Error('mode-target-hard-cap')
    const nextVersion = expectedVersion + 1
    const auditId = randomUUID()
    const confirmationDigest = createHash('sha256').update(`${auditId}\0${mode}\0${input.confirmation}`, 'utf8').digest('hex')
    const changed = db.prepare(`
      UPDATE auto_betting_settings
      SET real_eligible=1, real_eligibility_version=?, real_eligibility_updated_at=?
      WHERE mode=? AND real_eligible=0 AND real_eligibility_version=?
    `).run(nextVersion, at, mode, expectedVersion)
    if (changed.changes !== 1) throw new Error('mode-eligibility-version-conflict')
    writeExecutionSecurityAudit(db, {
      action: 'auto_betting_mode_eligibility_upgraded', subjectType: 'auto_betting_mode', subjectId: mode,
      confirmationDigest,
      details: { currency: configured.currency, amountScale: configured.amountScale, targetAmountMinor,
        hardCapAmountMinor: configured.hardCapAmountMinor, fromEligibilityVersion: expectedVersion,
        toEligibilityVersion: nextVersion, capabilityMatrixVersion: CROWN_CAPABILITY_MATRIX_VERSION }, at,
    })
    return { bettingMode: mode, realEligible: true, realEligibilityVersion: nextVersion, updatedAt: at }
  })
}

export function revokeAutoBettingModeEligibility(database, input = {}, options = {}) {
  const db = executionDb(database)
  const at = nowIso(options.now || (() => new Date()))
  const mode = requiredText(input.mode, 'betting-mode')
  if (!BETTING_MODES.has(mode)) throw new TypeError('betting-mode')
  const expectedVersion = input.expectedEligibilityVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new TypeError('expected-eligibility-version')
  return runImmediate(db, () => {
    const row = db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(mode)
    if (!row) throw new Error('auto-betting-mode-not-found')
    if (Number(row.real_eligibility_version) !== expectedVersion) throw new Error('mode-eligibility-version-conflict')
    const nextVersion = expectedVersion + 1
    const changed = db.prepare(`
      UPDATE auto_betting_settings
      SET real_eligible=0, real_eligibility_version=?, real_eligibility_updated_at=?
      WHERE mode=? AND real_eligibility_version=?
    `).run(nextVersion, at, mode, expectedVersion)
    if (changed.changes !== 1) throw new Error('mode-eligibility-version-conflict')
    writeExecutionSecurityAudit(db, {
      action: 'auto_betting_mode_eligibility_revoked', subjectType: 'auto_betting_mode', subjectId: mode,
      details: { fromEligibilityVersion: expectedVersion, toEligibilityVersion: nextVersion }, at,
    })
    return { bettingMode: mode, realEligible: false, realEligibilityVersion: nextVersion, updatedAt: at }
  })
}

export function authorizeExecution(database, input = {}, options = {}) {
  const db = executionDb(database)
  const configured = realEnvironment(options.env || process.env)
  const at = nowIso(options.now || (() => new Date()))
  if (input.currency !== configured.currency) throw new Error('authorization-currency')
  if (input.amountScale !== configured.amountScale) throw new Error('authorization-scale')
  const maxTotalAmountMinor = positiveMinor(input.maxTotalAmountMinor, 'max-total-amount')
  if (maxTotalAmountMinor > configured.hardCapAmountMinor) throw new Error('authorization-hard-cap')
  const hasCardScope = input.cardScopes !== undefined
  const hasModeScope = hasCardScope || input.bettingModes !== undefined || input.eligibilityVersions !== undefined
  const ruleIds = hasModeScope ? normalizeRuleIds(input.ruleIds || [], { allowEmpty: true }) : normalizeRuleIds(input.ruleIds)
  const bettingModes = hasModeScope ? normalizeBettingModes(input.bettingModes) : []
  const eligibilityVersions = hasCardScope ? {} : normalizeEligibilityVersions(input.eligibilityVersions || {}, bettingModes)
  const cardScopes = normalizeCardScopes(input.cardScopes || [], { allowEmpty: !hasCardScope })
  if (hasModeScope && ruleIds.length !== 0) throw new TypeError('authorization-scope-mixed')
  const confirmation = requiredText(input.confirmation, 'authorization-confirmation')
  const durationMs = input.durationMs ?? DEFAULT_AUTHORIZATION_DURATION_MS
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_AUTHORIZATION_DURATION_MS) {
    throw new TypeError('authorization-duration')
  }
  const authorizationId = input.authorizationId === undefined
    ? randomUUID()
    : requiredText(input.authorizationId, 'authorization-id')
  const expiresAt = new Date(Date.parse(at) + durationMs).toISOString()
  const confirmationDigest = createHash('sha256')
    .update(`${authorizationId}\0${confirmation}`, 'utf8')
    .digest('hex')

  return runImmediate(db, () => {
    for (const scope of cardScopes) {
      const card = db.prepare('SELECT * FROM auto_betting_rule_cards WHERE card_id=?').get(scope.cardId)
      if (!card) throw new Error('auto-betting-card-not-found')
      if (Number(card.enabled) !== 1) throw new Error('betting-card-disabled')
      if (Number(card.migration_review_required) !== 0) throw new Error('migration-review-required')
      if (Number(card.real_eligible) !== 1 || Number(card.real_eligibility_version) !== scope.eligibilityVersion) {
        throw new Error('card-eligibility-version')
      }
      if (card.currency !== configured.currency || Number(card.amount_scale) !== configured.amountScale) throw new Error('card-money-mismatch')
      if (positiveMinor(Number(card.target_amount_minor), 'card-target') > configured.hardCapAmountMinor) throw new Error('card-target-hard-cap')
    }
    for (const bettingMode of hasCardScope ? [] : bettingModes) {
      const setting = db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(bettingMode)
      if (!setting) throw new Error('auto-betting-mode-not-found')
      if (Number(setting.enabled) !== 1) throw new Error('betting-mode-disabled')
      if (Number(setting.migration_review_required) !== 0) throw new Error('migration-review-required')
      if (Number(setting.real_eligible) !== 1
        || Number(setting.real_eligibility_version) !== eligibilityVersions[bettingMode]) {
        throw new Error('mode-eligibility-version')
      }
      if (setting.currency !== configured.currency || Number(setting.amount_scale) !== configured.amountScale) {
        throw new Error('mode-money-mismatch')
      }
      const targetAmountMinor = positiveMinor(Number(setting.target_amount_minor), 'mode-target')
      if (targetAmountMinor > configured.hardCapAmountMinor) throw new Error('mode-target-hard-cap')
    }
    const activeRows = db.prepare("SELECT * FROM execution_authorizations WHERE status = 'active'").all()
    for (const row of activeRows) refreshAuthorization(db, row, { configured, at })
    if (db.prepare("SELECT 1 FROM execution_authorizations WHERE status = 'active' LIMIT 1").get()) {
      throw new Error('authorization-active')
    }
    db.prepare(`
      INSERT INTO execution_authorizations (
        authorization_id, mode, currency, amount_scale, rule_ids_json,
        betting_modes_json, eligibility_versions_json, card_scopes_json,
        max_total_amount_minor, hard_cap_amount_minor,
        reserved_amount_minor, accepted_amount_minor, unknown_amount_minor,
        valid_from, expires_at, status, confirmation_digest, created_at, updated_at
      ) VALUES (?, 'real', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'active', ?, ?, ?)
    `).run(
      authorizationId,
      configured.currency,
      configured.amountScale,
      JSON.stringify(ruleIds),
      JSON.stringify(bettingModes),
      JSON.stringify(eligibilityVersions),
      JSON.stringify(cardScopes),
      maxTotalAmountMinor,
      configured.hardCapAmountMinor,
      at,
      expiresAt,
      confirmationDigest,
      at,
      at,
    )
    writeExecutionSecurityAudit(db, {
      action: 'execution_authorization_created',
      subjectType: 'execution_authorization',
      subjectId: authorizationId,
      confirmationDigest,
      details: {
        currency: configured.currency,
        amountScale: configured.amountScale,
        ruleIds,
        bettingModes,
        eligibilityVersions,
        cardScopes,
        maxTotalAmountMinor,
        hardCapAmountMinor: configured.hardCapAmountMinor,
        validFrom: at,
        expiresAt,
      },
      at,
    })
    return authorizationResult(db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorizationId))
  })
}

export function revokeAuthorization(database, input = {}, options = {}) {
  const db = executionDb(database)
  const at = nowIso(options.now || (() => new Date()))
  return runImmediate(db, () => {
    const row = requireAuthorization(db, input.authorizationId)
    if (row.status === 'active') {
      const cancellation = cancelProvablyUnsentAuthorizationChildren(db, row.authorization_id, {
        at,
        reason: 'authorization_revoked',
      })
      db.prepare(`
        UPDATE execution_authorizations
        SET status = 'revoked', updated_at = ?
        WHERE authorization_id = ? AND status = 'active'
      `).run(at, row.authorization_id)
      writeExecutionSecurityAudit(db, {
        action: 'execution_authorization_revoked',
        subjectType: 'execution_authorization',
        subjectId: row.authorization_id,
        details: cancellation,
        at,
      })
    }
    return authorizationResult(db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(row.authorization_id))
  })
}

export function assertExecutionGate(database, input = {}, options = {}) {
  const db = executionDb(database)
  const context = operationContext(options)
  return runGateImmediate(db, () => {
    const result = assertExecutionGateInTransaction(db, input, context)
    return {
      authorizationId: result.authorization.authorization_id,
      ruleId: result.rule?.id || null,
      bettingMode: result.setting?.mode || null,
      accountId: result.account?.id || null,
      authorization: authorizationResult(result.authorization),
    }
  })
}

function reserveAuthorizationBudgetOperation(db, input, options) {
  const amountMinor = positiveMinor(input.amountMinor)
  const context = operationContext(options)
  assertExecutorFence(db, input, context.at)
  const child = requireBudgetChild(db, input.childOrderId)
  if (input.batchId !== undefined && requiredText(input.batchId, 'batch-id') !== child.batch_id) throw new Error('bet-batch-mismatch')
  if (input.accountId !== undefined && requiredText(input.accountId, 'account-id') !== child.account_id) throw new Error('bet-account-mismatch')
  if (input.ruleId !== undefined && requiredText(input.ruleId, 'rule-id') !== child.rule_id) throw new Error('bet-batch-rule-mismatch')
  if (input.bettingMode !== undefined && requiredText(input.bettingMode, 'betting-mode') !== child.betting_mode) throw new Error('bet-batch-mode-mismatch')
  if (amountMinor !== Number(child.requested_amount_minor)) throw new Error('authorization-child-amount-mismatch')
  const { authorization } = assertExecutionGateInTransaction(db, {
    ...input,
    ...(child.card_id !== null ? {
      cardId: child.card_id,
      eligibilityVersion: JSON.parse(child.card_snapshot_json).realEligibilityVersion ?? input.eligibilityVersion,
      bettingMode: child.betting_mode,
    } : child.rule_id === null ? { bettingMode: child.betting_mode } : { ruleId: child.rule_id }),
    accountId: child.account_id,
  }, context)
  if (child.currency !== authorization.currency || Number(child.amount_scale) !== Number(authorization.amount_scale)) {
    throw new Error('bet-batch-money-mismatch')
  }
  const existing = db.prepare(`
    SELECT * FROM execution_authorization_child_budgets WHERE child_order_id = ?
  `).get(child.child_order_id)
  if (existing) {
    if (
      existing.authorization_id !== authorization.authorization_id
      || existing.batch_id !== child.batch_id
      || existing.account_id !== child.account_id
      || Number(existing.amount_minor) !== amountMinor
    ) {
      throw new Error('authorization-child-binding-conflict')
    }
    return authorizationResult(db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorization_id))
  }
  if (child.child_status !== 'reserved') throw new Error('authorization-child-not-reserved')
  if (child.authorization_id !== null && child.authorization_id !== authorization.authorization_id) {
    throw new Error('bet-batch-authorization-mismatch')
  }
  const committed = BigInt(authorization.reserved_amount_minor)
    + BigInt(authorization.accepted_amount_minor)
    + BigInt(authorization.unknown_amount_minor)
    + BigInt(amountMinor)
  if (committed > BigInt(authorization.max_total_amount_minor) || committed > BigInt(context.configured.hardCapAmountMinor)) {
    throw new Error('authorization-budget-exceeded')
  }
  const changed = db.prepare(`
    UPDATE execution_authorizations
    SET reserved_amount_minor = reserved_amount_minor + ?, updated_at = ?
    WHERE authorization_id = ? AND status = 'active'
  `).run(amountMinor, context.at, authorization.authorization_id)
  if (changed.changes !== 1) throw new Error('authorization-inactive')
  injectFault(options, 'reserve:after-authorization-update', { childOrderId: child.child_order_id })
  const batchChanged = db.prepare(`
    UPDATE bet_batches
    SET authorization_id = ?
    WHERE batch_id = ?
      AND (authorization_id IS NULL OR authorization_id = ?)
  `).run(
    authorization.authorization_id,
    child.batch_id,
    authorization.authorization_id,
  )
  if (batchChanged.changes !== 1) throw new Error('bet-batch-authorization-mismatch')
  db.prepare(`
    INSERT INTO execution_authorization_child_budgets (
      child_order_id, authorization_id, batch_id, account_id,
      amount_minor, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
  `).run(
    child.child_order_id,
    authorization.authorization_id,
    child.batch_id,
    child.account_id,
    amountMinor,
    context.at,
    context.at,
  )
  injectFault(options, 'reserve:after-binding-insert', { childOrderId: child.child_order_id })
  recomputeBatchCaches(db, child.batch_id, { at: context.at, preserveQueued: true })
  injectFault(options, 'reserve:after-batch-recompute', { childOrderId: child.child_order_id })
  return authorizationResult(db.prepare('SELECT * FROM execution_authorizations WHERE authorization_id = ?').get(authorization.authorization_id))
}

export function reserveAuthorizationBudgetInTransaction(database, input = {}, options = {}) {
  return reserveAuthorizationBudgetOperation(executionDb(database), input, options)
}

export function reserveAuthorizationBudget(database, input = {}, options = {}) {
  const db = executionDb(database)
  return runGateImmediate(db, () => reserveAuthorizationBudgetOperation(db, input, options))
}

function childBudgetOutcome(status) {
  if (status === 'accepted') return 'accepted'
  if (status === 'unknown') return 'unknown'
  if (status === 'rejected' || status === 'cancelled') return 'released'
  return null
}

function requireAuthorizationBinding(db, input) {
  const childOrderId = requiredText(input.childOrderId, 'child-order-id')
  const row = db.prepare(`
    SELECT
      budget.child_order_id, budget.authorization_id, budget.batch_id AS binding_batch_id,
      budget.account_id AS binding_account_id, budget.amount_minor, budget.status AS binding_status,
      child.batch_id, child.account_id, child.requested_amount_minor, child.status AS child_status,
      child.attempt, child.submit_attempt_id, child.provider_reference_ciphertext,
      child.error_code, child.error_message, child.created_at,
      batch.authorization_id AS batch_authorization_id, batch.rule_id,
      batch.currency, batch.amount_scale
    FROM execution_authorization_child_budgets AS budget
    JOIN bet_child_orders AS child ON child.child_order_id = budget.child_order_id
    JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
    WHERE budget.child_order_id = ?
  `).get(childOrderId)
  if (!row) throw new Error('authorization-child-binding-not-found')
  const authorizationId = requiredText(input.authorizationId, 'authorization-id')
  if (row.authorization_id !== authorizationId) throw new Error('authorization-child-binding-conflict')
  if (
    row.binding_batch_id !== row.batch_id
    || row.binding_account_id !== row.account_id
    || Number(row.amount_minor) !== Number(row.requested_amount_minor)
  ) {
    throw new Error('authorization-child-binding-corrupt')
  }
  if (row.batch_authorization_id !== authorizationId) throw new Error('bet-batch-authorization-mismatch')
  if (input.batchId !== undefined && requiredText(input.batchId, 'batch-id') !== row.batch_id) throw new Error('bet-batch-mismatch')
  if (input.accountId !== undefined && requiredText(input.accountId, 'account-id') !== row.account_id) throw new Error('bet-account-mismatch')
  if (input.ruleId !== undefined && requiredText(input.ruleId, 'rule-id') !== row.rule_id) throw new Error('bet-batch-rule-mismatch')
  return row
}

function assertNoB2AttemptBypass(db, childOrderId) {
  const attempt = db.prepare(`
    SELECT 1 FROM bet_submit_attempts WHERE child_order_id = ? LIMIT 1
  `).get(childOrderId)
  if (attempt) throw new Error('b2-attempt-store-bypass')
}

function applyAuthorizationBindingOutcome(db, authorizationId, binding, targetStatus, at, { afterAuthorization } = {}) {
  if (!['accepted', 'unknown', 'released'].includes(targetStatus)) throw new Error('authorization-child-outcome')
  if (binding.binding_status === targetStatus) return false
  const amountMinor = Number(binding.amount_minor)
  positiveMinor(amountMinor, 'authorization-child-amount')
  let reservedDelta = 0
  let acceptedDelta = 0
  let unknownDelta = 0
  if (binding.binding_status === 'reserved') {
    reservedDelta = -amountMinor
    if (targetStatus === 'accepted') acceptedDelta = amountMinor
    if (targetStatus === 'unknown') unknownDelta = amountMinor
  } else if (binding.binding_status === 'unknown' && targetStatus === 'accepted') {
    unknownDelta = -amountMinor
    acceptedDelta = amountMinor
  } else if (binding.binding_status === 'unknown' && targetStatus === 'released') {
    unknownDelta = -amountMinor
  } else {
    throw new Error('authorization-child-binding-terminal')
  }
  const changed = db.prepare(`
    UPDATE execution_authorizations
    SET
      reserved_amount_minor = reserved_amount_minor + ?,
      accepted_amount_minor = accepted_amount_minor + ?,
      unknown_amount_minor = unknown_amount_minor + ?,
      updated_at = ?
    WHERE authorization_id = ?
      AND reserved_amount_minor + ? >= 0
      AND accepted_amount_minor + ? >= 0
      AND unknown_amount_minor + ? >= 0
  `).run(
    reservedDelta,
    acceptedDelta,
    unknownDelta,
    at,
    authorizationId,
    reservedDelta,
    acceptedDelta,
    unknownDelta,
  )
  if (changed.changes !== 1) throw new Error('authorization-ledger-invariant')
  afterAuthorization?.()
  const bindingChanged = db.prepare(`
    UPDATE execution_authorization_child_budgets
    SET status = ?, updated_at = ?
    WHERE child_order_id = ? AND authorization_id = ? AND status = ?
  `).run(targetStatus, at, binding.child_order_id, authorizationId, binding.binding_status)
  if (bindingChanged.changes !== 1) throw new Error('authorization-child-binding-conflict')
  binding.binding_status = targetStatus
  return true
}

function exhaustAuthorizationIfSpent(db, authorizationId, at) {
  const authorization = requireAuthorization(db, authorizationId)
  if (
    authorization.status === 'active'
    && Number(authorization.reserved_amount_minor) === 0
    && BigInt(authorization.accepted_amount_minor) + BigInt(authorization.unknown_amount_minor) >= BigInt(authorization.max_total_amount_minor)
  ) {
    db.prepare(`
      UPDATE execution_authorizations
      SET status = 'exhausted', updated_at = ?
      WHERE authorization_id = ? AND status = 'active'
    `).run(at, authorizationId)
  }
  return requireAuthorization(db, authorizationId)
}

function upsertAuthorizedChildLock(db, row, fencingToken, at) {
  const expectedStatus = row.child_status === 'unknown'
    ? 'unknown'
    : (row.child_status === 'submit_prepared' || row.child_status === 'submit_dispatched' ? 'submitting' : 'reserved')
  db.prepare(`
    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      child_order_id = excluded.child_order_id,
      batch_id = excluded.batch_id,
      status = excluded.status,
      fencing_token = excluded.fencing_token,
      updated_at = excluded.updated_at
    WHERE betting_account_locks.child_order_id = excluded.child_order_id
  `).run(
    row.account_id,
    row.child_order_id,
    row.batch_id,
    expectedStatus,
    fencingToken,
    row.created_at || at,
    at,
  )
  const lock = db.prepare('SELECT child_order_id, fencing_token FROM betting_account_locks WHERE account_id = ?').get(row.account_id)
  if (!lock || lock.child_order_id !== row.child_order_id || Number(lock.fencing_token) !== fencingToken) {
    throw new Error('recovery-lock-conflict')
  }
}

function reconcileAuthorizationBindingsInTransaction(db, authorizationId, {
  at,
  fencingToken,
  recoverUncertain = false,
} = {}) {
  requireAuthorization(db, authorizationId)
  const rows = db.prepare(`
    SELECT
      budget.child_order_id, budget.authorization_id, budget.batch_id AS binding_batch_id,
      budget.account_id AS binding_account_id, budget.amount_minor, budget.status AS binding_status,
      child.batch_id, child.account_id, child.requested_amount_minor, child.status AS child_status,
      child.attempt, child.submit_attempt_id, child.provider_reference_ciphertext,
      child.error_code, child.error_message, child.created_at,
      batch.authorization_id AS batch_authorization_id, batch.rule_id,
      batch.currency, batch.amount_scale
    FROM execution_authorization_child_budgets AS budget
    JOIN bet_child_orders AS child ON child.child_order_id = budget.child_order_id
    JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
    WHERE budget.authorization_id = ?
    ORDER BY child.created_at, child.child_order_id
  `).all(authorizationId)
  let unknownCount = 0
  let reconciledCount = 0
  const batchIds = new Set()
  for (const row of rows) {
    if (
      row.binding_batch_id !== row.batch_id
      || row.binding_account_id !== row.account_id
      || Number(row.amount_minor) !== Number(row.requested_amount_minor)
      || row.batch_authorization_id !== authorizationId
    ) {
      throw new Error('authorization-child-binding-corrupt')
    }
    batchIds.add(row.batch_id)
    let changed = false
    if (recoverUncertain && ['submit_prepared', 'submit_dispatched'].includes(row.child_status)) {
      db.prepare(`
        UPDATE bet_child_orders
        SET status = 'unknown',
            error_code = CASE WHEN error_code = '' THEN 'recovery-uncertain' ELSE error_code END,
            resolved_at = ''
        WHERE child_order_id = ? AND status IN ('submit_prepared', 'submit_dispatched')
      `).run(row.child_order_id)
      row.child_status = 'unknown'
      unknownCount += 1
      changed = true
    }
    const targetStatus = childBudgetOutcome(row.child_status)
    if (targetStatus && applyAuthorizationBindingOutcome(db, authorizationId, row, targetStatus, at)) changed = true
    if (!targetStatus && row.binding_status !== 'reserved') throw new Error('authorization-child-binding-terminal')
    if (['previewing', 'reserved', 'submit_prepared', 'submit_dispatched', 'unknown'].includes(row.child_status)) {
      upsertAuthorizedChildLock(db, row, fencingToken, at)
    } else {
      db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(row.child_order_id)
    }
    if (changed) reconciledCount += 1
  }
  for (const batchId of batchIds) recomputeBatchCaches(db, batchId, { at, preserveQueued: true })
  const authorization = exhaustAuthorizationIfSpent(db, authorizationId, at)
  return {
    reconciledCount,
    unknownCount,
    authorization: authorizationResult(authorization),
    batches: [...batchIds].sort().map((batchId) => batchResult(db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId))),
  }
}

export function resolveAuthorizedChildOrder(database, input = {}, options = {}) {
  const db = executionDb(database)
  const context = operationContext(options)
  const status = requiredText(input.status, 'status')
  if (!['accepted', 'rejected', 'unknown'].includes(status)) throw new TypeError('child-result-status')
  return runImmediate(db, () => {
    const fencingToken = assertExecutorFence(db, input, context.at)
    let authorization = requireAuthorization(db, input.authorizationId)
    authorization = refreshAuthorization(db, authorization, context)
    const binding = requireAuthorizationBinding(db, input)
    assertNoB2AttemptBypass(db, binding.child_order_id)
    if (binding.currency !== authorization.currency || Number(binding.amount_scale) !== Number(authorization.amount_scale)) {
      throw new Error('bet-batch-money-mismatch')
    }
    if (!parseRuleIds(authorization).includes(binding.rule_id)) throw new Error('authorization-rule-scope')
    const targetBindingStatus = childBudgetOutcome(status)
    if (binding.child_status !== status) {
      if (['accepted', 'rejected', 'cancelled'].includes(binding.child_status)) throw new Error('child-terminal')
      if (status !== 'rejected' && !['submit_prepared', 'submit_dispatched', 'unknown'].includes(binding.child_status)) {
        throw new Error('child-not-submitted')
      }
      const lock = db.prepare('SELECT fencing_token FROM betting_account_locks WHERE child_order_id = ?').get(binding.child_order_id)
      if (!lock || Number(lock.fencing_token) !== fencingToken) throw new Error('child-order-fencing-token')
      db.prepare(`
        UPDATE bet_child_orders
        SET status = ?, provider_reference_ciphertext = ?, error_code = ?, error_message = ?, resolved_at = ?
        WHERE child_order_id = ?
      `).run(
        status,
        String(input.providerReferenceCiphertext || binding.provider_reference_ciphertext || ''),
        String(input.errorCode || ''),
        String(input.errorMessage || ''),
        status === 'unknown' ? '' : context.at,
        binding.child_order_id,
      )
      binding.child_status = status
      if (status === 'unknown') {
        db.prepare(`
          UPDATE betting_account_locks SET status = 'unknown', updated_at = ?
          WHERE child_order_id = ? AND fencing_token = ?
        `).run(context.at, binding.child_order_id, fencingToken)
      } else {
        db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ? AND fencing_token = ?')
          .run(binding.child_order_id, fencingToken)
      }
    }
    injectFault(options, 'resolve:after-child', { childOrderId: binding.child_order_id, status })
    recomputeBatchCaches(db, binding.batch_id, {
      at: context.at,
      hasFutureCapacity: status === 'rejected' ? false : (input.hasFutureCapacity ?? true),
    })
    injectFault(options, 'resolve:after-batch', { childOrderId: binding.child_order_id, status })
    injectFault(options, 'resolve:before-authorization', { childOrderId: binding.child_order_id, status })
    applyAuthorizationBindingOutcome(db, authorization.authorization_id, binding, targetBindingStatus, context.at)
    authorization = exhaustAuthorizationIfSpent(db, authorization.authorization_id, context.at)
    return {
      child: childResult(db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id = ?').get(binding.child_order_id)),
      batch: batchResult(db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(binding.batch_id)),
      authorization: authorizationResult(authorization),
      bindingStatus: targetBindingStatus,
    }
  })
}

export function cancelAuthorizedUnsubmitted(database, input = {}, options = {}) {
  const db = executionDb(database)
  const at = nowIso(options.now || (() => new Date()))
  const batchId = requiredText(input.batchId, 'batch-id')
  const authorizationId = requiredText(input.authorizationId, 'authorization-id')
  const finishReason = requiredText(input.finishReason || 'manual_cancel', 'finish-reason')
  if (!isSafetyFinishReason(finishReason)) {
    throw new TypeError('finish-reason')
  }
  return runImmediate(db, () => {
    assertExecutorFence(db, input, at)
    requireAuthorization(db, authorizationId)
    const batch = db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
    if (!batch) throw new Error('bet-batch-not-found')
    if (batch.authorization_id !== authorizationId) throw new Error('bet-batch-authorization-mismatch')
    const rows = db.prepare(`
      SELECT child.child_order_id, child.status AS child_status,
             budget.authorization_id, budget.amount_minor, budget.status AS binding_status
      FROM bet_child_orders AS child
      LEFT JOIN execution_authorization_child_budgets AS budget ON budget.child_order_id = child.child_order_id
      WHERE child.batch_id = ? AND child.status IN ('previewing', 'reserved')
      ORDER BY child.child_order_id
    `).all(batchId)
    let releasedAmountMinor = 0
    const boundRows = []
    for (const row of rows) {
      if (row.authorization_id !== null && row.authorization_id !== authorizationId) {
        throw new Error('authorization-child-binding-conflict')
      }
      db.prepare(`
        UPDATE bet_child_orders SET status = 'cancelled', resolved_at = ?, error_code = ?
        WHERE child_order_id = ? AND status IN ('previewing', 'reserved')
      `).run(at, finishReason, row.child_order_id)
      db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(row.child_order_id)
      if (row.authorization_id !== null) {
        if (row.binding_status !== 'reserved') throw new Error('authorization-child-binding-terminal')
        const amountMinor = Number(row.amount_minor)
        if (amountMinor > Number.MAX_SAFE_INTEGER - releasedAmountMinor) throw new Error('authorization-ledger-invariant')
        releasedAmountMinor += amountMinor
        boundRows.push({
          child_order_id: row.child_order_id,
          amount_minor: amountMinor,
          binding_status: row.binding_status,
        })
      }
    }
    injectFault(options, 'cancel:after-child', { batchId })
    recomputeBatchCaches(db, batchId, { at, stopReason: finishReason, cancellation: true, hasFutureCapacity: false })
    injectFault(options, 'cancel:after-batch', { batchId })
    injectFault(options, 'cancel:before-authorization', { batchId })
    for (const row of boundRows) applyAuthorizationBindingOutcome(db, authorizationId, row, 'released', at)
    const authorization = exhaustAuthorizationIfSpent(db, authorizationId, at)
    return {
      cancelledCount: rows.length,
      releasedAmountMinor,
      batch: batchResult(db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)),
      authorization: authorizationResult(authorization),
    }
  })
}

export function reconcileAuthorizationBindings(database, input = {}, options = {}) {
  const db = executionDb(database)
  const at = nowIso(options.now || (() => new Date()))
  return runImmediate(db, () => {
    const fencingToken = assertExecutorFence(db, input, at)
    return reconcileAuthorizationBindingsInTransaction(db, requiredText(input.authorizationId, 'authorization-id'), {
      at,
      fencingToken,
      recoverUncertain: false,
    })
  })
}

export function recoverAuthorizedChildOrders(database, input = {}, options = {}) {
  const db = executionDb(database)
  const at = nowIso(options.now || (() => new Date()))
  return runImmediate(db, () => {
    const fencingToken = assertExecutorFence(db, input, at)
    const b2Attempt = db.prepare(`
      SELECT 1
      FROM bet_submit_attempts
      WHERE authorization_id = ?
        AND status IN ('submit_prepared', 'submit_dispatched', 'unknown')
      LIMIT 1
    `).get(requiredText(input.authorizationId, 'authorization-id'))
    if (b2Attempt) throw new Error('b2-attempt-store-bypass')
    return reconcileAuthorizationBindingsInTransaction(db, requiredText(input.authorizationId, 'authorization-id'), {
      at,
      fencingToken,
      recoverUncertain: true,
    })
  })
}

function reconcileAuthorizationBudget(database, input, options, { releaseOnly = false } = {}) {
  const db = executionDb(database)
  let configured = null
  try { configured = realEnvironment(options.env || process.env) } catch {}
  const at = nowIso(options.now || (() => new Date()))
  return runImmediate(db, () => {
    let authorization = requireAuthorization(db, input.authorizationId)
    const fencingToken = assertExecutorFence(db, input, at)
    authorization = refreshAuthorization(db, authorization, { configured, at })
    const binding = requireAuthorizationBinding(db, input)
    assertNoB2AttemptBypass(db, binding.child_order_id)
    const childOrderId = binding.child_order_id
    const targetStatus = childBudgetOutcome(binding.child_status)
    if (!targetStatus) throw new Error('authorization-child-unresolved')
    if (releaseOnly && targetStatus !== 'released') throw new Error('authorization-child-not-releasable')
    if (input.outcome !== undefined) {
      const requested = input.outcome === 'rejected' ? 'released' : requiredText(input.outcome, 'authorization-outcome')
      if (requested !== targetStatus) throw new Error('authorization-child-outcome-mismatch')
    }
    applyAuthorizationBindingOutcome(db, authorization.authorization_id, binding, targetStatus, at, {
      afterAuthorization() {
        injectFault(options, 'resolve:after-authorization-update', { childOrderId, targetStatus })
      },
    })
    if (binding.child_status === 'unknown') upsertAuthorizedChildLock(db, binding, fencingToken, at)
    else db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(childOrderId)
    recomputeBatchCaches(db, binding.batch_id, { at, preserveQueued: true })
    authorization = exhaustAuthorizationIfSpent(db, authorization.authorization_id, at)
    return authorizationResult(authorization)
  })
}

export function releaseAuthorizationBudget(database, input = {}, options = {}) {
  return reconcileAuthorizationBudget(database, input, options, { releaseOnly: true })
}

export function resolveAuthorizationBudget(database, input = {}, options = {}) {
  return reconcileAuthorizationBudget(database, input, options)
}
