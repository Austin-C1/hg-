import { createHash, randomUUID } from 'node:crypto'

import { decryptSecret } from '../app/app-secret.mjs'
import { CrownAccountExecutionProvider } from './crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from './crown-account-provider.mjs'
import { assertCanonicalRealRule } from './canonical-real-rule.mjs'
import { assertExecutionIdentity, executionIdentityFromEnvelope } from './execution-identity.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  getCrownCapability,
} from './crown-capability-matrix.mjs'
import { isSafetyFinishReason } from './safety-finish-reasons.mjs'

const FIXTURE_CAPABILITY_VERSION = 'b2-ledger-fixture-v1'
const FIXTURE_CAPABILITY_EVIDENCE_ID = 'fixture:b2-ledger:offline:v1'
const TERMINAL_ATTEMPT_STATUSES = new Set(['accepted', 'rejected', 'unknown', 'odds_changed_unsent'])

export function deterministicSubmitAttemptId(childOrderId, attemptOrdinal) {
  const childId = required(childOrderId, 'child-order-id')
  if (![1, 2].includes(Number(attemptOrdinal))) throw new Error('submit-attempt-ordinal')
  return createHash('sha256').update(`b2-submit\n${childId}\n${attemptOrdinal}`, 'utf8').digest('hex')
}

function dbOf(database) {
  const db = database?.db || database
  if (!db?.prepare || !db?.exec) throw new TypeError('b2-executor-db')
  return db
}

function required(value, code) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(code)
  return text
}

function safeMinor(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(code)
  return value
}

function atFrom(options = {}) {
  const now = options.now || (() => new Date())
  if (typeof now !== 'function') throw new TypeError('b2-executor-now')
  const value = now()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('b2-executor-time')
  return date.toISOString()
}

function envFrom(options = {}) {
  const env = options.env || process.env
  const currency = String(env.CROWN_REAL_CURRENCY || '')
  const scale = Number(String(env.CROWN_REAL_AMOUNT_SCALE || ''))
  const hardCapMinor = Number(String(env.CROWN_REAL_MAX_TOTAL_MINOR || ''))
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('real-environment-currency')
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new TypeError('real-environment-scale')
  safeMinor(hardCapMinor, 'real-environment-hard-cap', { positive: true })
  return { currency, scale, hardCapMinor }
}

function immediate(db, operation) {
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

function fault(options, phase, details = {}) {
  if (options.faultInjector === undefined || options.faultInjector === null) return
  if (typeof options.faultInjector !== 'function') throw new TypeError('b2-fault-injector')
  options.faultInjector(phase, details)
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function stableJson(value) {
  return JSON.stringify(stable(value))
}

function objectValue(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code)
  return value
}

function parseJsonObject(value, code) {
  let parsed
  try { parsed = JSON.parse(String(value || '')) } catch { throw new Error(code) }
  return objectValue(parsed, code)
}

function assertFence(db, input, at) {
  const leaseKey = required(input.leaseKey, 'executor-lease-key')
  if (!/^betting-executor:\S+$/.test(leaseKey)) throw new Error('executor-lease-key')
  const ownerId = required(input.executorOwnerId, 'executor-owner-id')
  const fencingToken = safeMinor(input.fencingToken, 'executor-fencing-token', { positive: true })
  const lease = db.prepare(`
    SELECT fencing_token, expires_at
    FROM runtime_leases
    WHERE lease_key = ? AND owner_id = ?
  `).get(leaseKey, ownerId)
  if (
    !lease
    || Number(lease.fencing_token) !== fencingToken
    || !Number.isFinite(Date.parse(lease.expires_at))
    || Date.parse(lease.expires_at) <= Date.parse(at)
  ) throw new Error('executor-fence-stale')
  return fencingToken
}

function parseRuleIds(row) {
  let value
  try { value = JSON.parse(row.rule_ids_json) } catch { throw new Error('authorization-corrupt') }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
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
  let cards
  try { cards = JSON.parse(row.card_scopes_json || '[]') } catch { throw new Error('authorization-corrupt') }
  const cardScoped = Array.isArray(cards) && cards.length > 0 && versions && typeof versions === 'object'
    && !Array.isArray(versions) && Object.keys(versions).length === 0
  if (!Array.isArray(modes) || new Set(modes).size !== modes.length
    || modes.some((mode) => !['prematch', 'live'].includes(mode))
    || !versions || typeof versions !== 'object' || Array.isArray(versions)
    || (!cardScoped && JSON.stringify(Object.keys(versions).sort()) !== JSON.stringify([...modes].sort()))
    || (!cardScoped && modes.some((mode) => !Number.isSafeInteger(versions[mode]) || versions[mode] < 1))) {
    throw new Error('authorization-corrupt')
  }
  return { modes, versions }
}

function parseCardScopes(row) {
  let scopes
  try { scopes = JSON.parse(row.card_scopes_json || '[]') } catch { throw new Error('authorization-corrupt') }
  if (!Array.isArray(scopes) || new Set(scopes.map((scope) => scope?.cardId)).size !== scopes.length
    || scopes.some((scope) => !scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.keys(scope).sort().join('|') !== 'cardId|eligibilityVersion'
      || typeof scope.cardId !== 'string' || !scope.cardId
      || !Number.isSafeInteger(scope.eligibilityVersion) || scope.eligibilityVersion < 1)) throw new Error('authorization-corrupt')
  return scopes
}

function requireContext(db, input, options, at, { settlement = false } = {}) {
  const authorizationId = required(input.authorizationId, 'authorization-id')
  const childOrderId = required(input.childOrderId, 'child-order-id')
  const row = db.prepare(`
    SELECT
      budget.authorization_id, budget.status AS binding_status,
      budget.amount_minor AS binding_amount_minor,
      child.*, batch.rule_id, batch.card_id, batch.card_version, batch.card_snapshot_json,
      batch.betting_mode, batch.settings_version,
      batch.authorization_id AS batch_authorization_id,
      batch.currency AS batch_currency, batch.amount_scale AS batch_amount_scale,
      batch.locked_selection_identity, batch.rule_snapshot_json, batch.target_amount_minor, batch.rule_version,
      rule.version AS current_rule_version, rule.monitor_enabled, rule.real_betting_enabled,
      rule.archived AS rule_archived, rule.migration_review_required,
      rule.currency AS rule_currency,
      rule.amount_scale AS rule_amount_scale,
      setting.enabled AS setting_enabled, setting.real_eligible AS setting_real_eligible,
      setting.real_eligibility_version AS setting_eligibility_version,
      setting.migration_review_required AS setting_migration_review_required,
      setting.currency AS setting_currency, setting.amount_scale AS setting_amount_scale,
      account.status AS account_status, account.archived AS account_archived,
      account.currency AS account_currency, account.amount_scale AS account_amount_scale,
      account.per_bet_limit_minor, account.stake_step_minor,
      auth.status AS authorization_status, auth.currency AS authorization_currency,
      auth.amount_scale AS authorization_amount_scale, auth.rule_ids_json,
      auth.betting_modes_json, auth.eligibility_versions_json, auth.card_scopes_json,
      auth.max_total_amount_minor, auth.reserved_amount_minor AS authorization_reserved_minor,
      auth.hard_cap_amount_minor AS authorization_hard_cap_minor,
      auth.accepted_amount_minor AS authorization_accepted_minor,
      auth.unknown_amount_minor AS authorization_unknown_minor,
      auth.valid_from, auth.expires_at
    FROM execution_authorization_child_budgets AS budget
    JOIN bet_child_orders AS child ON child.child_order_id = budget.child_order_id
    JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
    LEFT JOIN betting_rules AS rule ON rule.id = batch.rule_id
    LEFT JOIN auto_betting_settings AS setting ON setting.mode = batch.betting_mode
    JOIN betting_accounts AS account ON account.id = child.account_id
    JOIN execution_authorizations AS auth ON auth.authorization_id = budget.authorization_id
    WHERE budget.child_order_id = ?
  `).get(childOrderId)
  if (!row) throw new Error('authorization-child-binding-not-found')
  if (row.authorization_id !== authorizationId || row.batch_authorization_id !== authorizationId) {
    throw new Error('authorization-child-binding-conflict')
  }
  const inputHasRule = input.ruleId !== undefined && input.ruleId !== null
  const inputHasCard = input.cardId !== undefined && input.cardId !== null
  const inputHasMode = input.bettingMode !== undefined || input.settingsVersion !== undefined
  if (Number(inputHasRule) + Number(inputHasCard) + Number(inputHasMode && !inputHasCard) !== 1) throw new Error('execution-scope-xor')
  const rowHasRule = typeof row.rule_id === 'string' && row.rule_id !== ''
  const rowHasCard = typeof row.card_id === 'string' && row.card_id !== '' && Number.isSafeInteger(Number(row.card_version))
  const rowHasMode = !rowHasCard && ['prematch', 'live'].includes(row.betting_mode) && Number.isSafeInteger(Number(row.settings_version))
  if (Number(rowHasRule) + Number(rowHasCard) + Number(rowHasMode) !== 1
    || rowHasRule !== inputHasRule || rowHasCard !== inputHasCard) throw new Error('execution-scope-xor')
  if (input.batchId !== undefined && required(input.batchId, 'batch-id') !== row.batch_id) throw new Error('bet-batch-mismatch')
  if (input.accountId !== undefined && required(input.accountId, 'account-id') !== row.account_id) throw new Error('bet-account-mismatch')
  if (input.ruleId !== undefined && required(input.ruleId, 'rule-id') !== row.rule_id) throw new Error('bet-batch-rule-mismatch')
  if (input.cardId !== undefined && required(input.cardId, 'card-id') !== row.card_id) throw new Error('bet-batch-card-mismatch')
  if (input.bettingMode !== undefined && required(input.bettingMode, 'betting-mode') !== row.betting_mode) throw new Error('bet-batch-mode-mismatch')
  if (inputHasMode && !inputHasCard && (!Number.isSafeInteger(input.settingsVersion) || input.settingsVersion < 1
    || Number(input.settingsVersion) !== Number(row.settings_version))) throw new Error('bet-batch-settings-version-mismatch')
  if (Number(row.binding_amount_minor) !== Number(row.requested_amount_minor)) throw new Error('authorization-child-binding-corrupt')
  if (rowHasCard) {
    let snapshot
    try { snapshot = JSON.parse(row.card_snapshot_json) } catch { throw new Error('bet-batch-card-snapshot') }
    if (snapshot?.cardId !== row.card_id || Number(snapshot?.version) !== Number(row.card_version)
      || Number(snapshot?.realEligibilityVersion) !== Number(input.eligibilityVersion)) throw new Error('bet-batch-card-snapshot')
    const scope = parseCardScopes(row).find((item) => item.cardId === row.card_id)
    if (!scope || scope.eligibilityVersion !== snapshot.realEligibilityVersion) throw new Error('authorization-card-scope')
    if (!parseModeScope(row).modes.includes(row.betting_mode)) throw new Error('authorization-mode-scope')
    if (parseRuleIds(row).length !== 0) throw new Error('authorization-scope-mixed')
  }
  if (settlement) return row
  const env = envFrom(options)
  if (row.authorization_status !== 'active') throw new Error(`authorization-${row.authorization_status || 'inactive'}`)
  const validFrom = Date.parse(row.valid_from)
  const expiresAt = Date.parse(row.expires_at)
  if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt) || validFrom > Date.parse(at) || expiresAt <= Date.parse(at)) {
    throw new Error('authorization-expired')
  }
  if (
    row.authorization_currency !== env.currency
    || Number(row.authorization_amount_scale) !== env.scale
    || row.batch_currency !== env.currency
    || Number(row.batch_amount_scale) !== env.scale
    || row.account_currency !== env.currency
    || Number(row.account_amount_scale) !== env.scale
  ) throw new Error('execution-money-mismatch')
  if (rowHasCard) {
    // Card identity and authorization scope were validated above even for settlement/recovery.
  } else if (rowHasMode) {
    const { modes, versions } = parseModeScope(row)
    if (parseRuleIds(row).length !== 0 || !modes.includes(row.betting_mode)) throw new Error('authorization-mode-scope')
    if (Number(row.setting_real_eligible) !== 1
      || Number(row.setting_eligibility_version) !== versions[row.betting_mode]) throw new Error('mode-eligibility-version')
    if (Number(row.setting_enabled) !== 1) throw new Error('betting-mode-disabled')
    if (Number(row.setting_migration_review_required) !== 0) throw new Error('migration-review-required')
    if (row.setting_currency !== env.currency || Number(row.setting_amount_scale) !== env.scale) throw new Error('execution-money-mismatch')
  } else {
    if (row.rule_currency !== env.currency || Number(row.rule_amount_scale) !== env.scale) throw new Error('execution-money-mismatch')
    if (!parseRuleIds(row).includes(row.rule_id)) throw new Error('authorization-rule-scope')
    assertCanonicalRealRule({
      archived: row.rule_archived,
      monitor_enabled: row.monitor_enabled,
      real_betting_enabled: row.real_betting_enabled,
      migration_review_required: row.migration_review_required,
    })
    if (Number(row.rule_version) !== Number(row.current_rule_version)) throw new Error('rule-version-changed')
  }
  if (
    Number(row.authorization_hard_cap_minor) !== env.hardCapMinor
    || Number(row.max_total_amount_minor) > env.hardCapMinor
  ) throw new Error('authorization-environment-mismatch')
  if (row.account_status !== 'enabled' || Number(row.account_archived) !== 0) throw new Error('betting-account-disabled')
  const committed = BigInt(row.authorization_reserved_minor)
    + BigInt(row.authorization_accepted_minor)
    + BigInt(row.authorization_unknown_minor)
  if (committed > BigInt(row.max_total_amount_minor) || committed > BigInt(env.hardCapMinor)) {
    throw new Error('authorization-budget-exceeded')
  }
  return row
}

function capabilityInput(input) {
  const identity = objectValue(input.currentIdentity, 'current-identity-required')
  return {
    mode: identity.mode,
    period: identity.period,
    marketType: identity.marketType,
    lineVariant: identity.lineVariant || 'main',
  }
}

function assertCapability(input, options) {
  const identity = objectValue(input.currentIdentity, 'current-identity-required')
  if (identity.provider === 'fixture') {
    if (
      String(input.capabilityVersion) !== FIXTURE_CAPABILITY_VERSION
      || String(input.capabilityEvidenceId) !== FIXTURE_CAPABILITY_EVIDENCE_ID
    ) throw new Error('b2-fixture-capability-mismatch')
    return
  }
  if (identity.provider !== 'crown') throw new Error('crown-capability-provider-mismatch')
  if (String(input.capabilityVersion) !== CROWN_CAPABILITY_MATRIX_VERSION) throw new Error('crown-capability-version-mismatch')
  const row = getCrownCapability(capabilityInput(input))
  const capability = assertCrownCapability(row, { operation: 'submit' })
  if (capability.evidenceId !== String(input.capabilityEvidenceId)) throw new Error('crown-capability-evidence-mismatch')
}

function assertPreview(row, input) {
  const locked = assertExecutionIdentity(objectValue(input.lockedIdentity, 'locked-identity-required'))
  const current = assertExecutionIdentity(objectValue(input.currentIdentity, 'current-identity-required'))
  let persisted
  try {
    const snapshot = parseJsonObject(row.rule_snapshot_json, 'rule-snapshot-corrupt')
    if (snapshot.lockedSelection && typeof snapshot.lockedSelection === 'object' && !Array.isArray(snapshot.lockedSelection)) {
      persisted = snapshot.lockedSelection
      if (String(persisted.selectionIdentity || '') !== String(row.locked_selection_identity || '')) {
        throw new Error('locked-identity-corrupt')
      }
    }
  } catch (error) {
    if (error?.message !== 'rule-snapshot-corrupt') throw error
  }
  if (!persisted) persisted = parseJsonObject(row.locked_selection_identity, 'locked-identity-corrupt')
  const expectedPersisted = executionIdentityFromEnvelope(persisted, { provider: current.provider })
  if (stableJson(locked) !== stableJson(expectedPersisted)) throw new Error('locked-identity-mismatch')
  if (stableJson(current) !== stableJson(locked)) throw new Error('current-identity-mismatch')
  const preview = objectValue(input.preview, 'preview-required')
  const min = safeMinor(preview.minStakeMinor, 'preview-min-stake', { positive: true })
  const max = safeMinor(preview.maxStakeMinor, 'preview-max-stake', { positive: true })
  const balance = safeMinor(preview.balanceMinor, 'preview-balance')
  const step = safeMinor(preview.stakeStepMinor, 'preview-stake-step', { positive: true })
  const amount = safeMinor(Number(row.requested_amount_minor), 'requested-amount', { positive: true })
  if (min > max || amount < min || amount > max || amount > balance) throw new Error('preview-capacity-blocked')
  if ((amount - min) % step !== 0) throw new Error('preview-stake-step-mismatch')
  if (amount > Number(row.per_bet_limit_minor)) throw new Error('account-per-bet-limit')
  if (step !== Number(row.stake_step_minor)) throw new Error('account-stake-step-mismatch')
  const odds = required(preview.odds, 'preview-odds')
  const line = required(preview.line, 'preview-line')
  if (line !== String(current.line || '')) throw new Error('preview-line-changed')
  return { min, max, balance, step, amount, odds, line, locked, current, preview }
}

function attemptResult(row) {
  if (!row) return null
  return {
    submitAttemptId: row.submit_attempt_id,
    childOrderId: row.child_order_id,
    authorizationId: row.authorization_id,
    attemptOrdinal: Number(row.attempt_ordinal),
    amountMinor: Number(row.amount_minor),
    status: row.status,
    previewOdds: row.preview_odds,
    preparedAt: row.prepared_at,
    dispatchedAt: row.dispatched_at,
    resultAt: row.result_at,
  }
}

function childResult(row) {
  return row ? {
    childOrderId: row.child_order_id,
    batchId: row.batch_id,
    accountId: row.account_id,
    requestedAmountMinor: Number(row.requested_amount_minor),
    submitAttemptId: row.submit_attempt_id,
    status: row.status,
  } : null
}

function batchResult(row) {
  return row ? {
    batchId: row.batch_id,
    status: row.status,
    reservedAmountMinor: Number(row.reserved_amount_minor),
    acceptedAmountMinor: Number(row.accepted_amount_minor),
    unknownAmountMinor: Number(row.unknown_amount_minor),
    finishReason: row.finish_reason,
  } : null
}

function recomputeBatch(db, batchId, at, { hasFutureCapacity = true } = {}) {
  const batch = db.prepare('SELECT * FROM bet_batches WHERE batch_id = ?').get(batchId)
  if (!batch) throw new Error('bet-batch-not-found')
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('reserved','submit_prepared','submit_dispatched') THEN requested_amount_minor ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN status='accepted' THEN requested_amount_minor ELSE 0 END),0) AS accepted,
      COALESCE(SUM(CASE WHEN status='unknown' THEN requested_amount_minor ELSE 0 END),0) AS unknown,
      COALESCE(SUM(CASE WHEN status IN ('previewing','reserved','submit_prepared','submit_dispatched') THEN 1 ELSE 0 END),0) AS nonterminal,
      COALESCE(SUM(CASE WHEN status IN ('reserved','submit_prepared','submit_dispatched') THEN 1 ELSE 0 END),0) AS active_submit
    FROM bet_child_orders WHERE batch_id = ?
  `).get(batchId)
  const occupied = BigInt(totals.reserved) + BigInt(totals.accepted) + BigInt(totals.unknown)
  if (occupied > BigInt(batch.target_amount_minor)) throw new Error('batch-ledger-invariant')
  let status
  if (totals.unknown > 0) status = 'waiting_result'
  else if (totals.active_submit > 0) status = 'submitting'
  else if (totals.accepted >= batch.target_amount_minor && totals.nonterminal === 0) status = 'completed'
  else if (hasFutureCapacity) status = 'waiting_capacity'
  else if (totals.accepted > 0) status = 'partial'
  else status = 'failed'
  const terminal = ['completed', 'partial', 'failed', 'cancelled'].includes(status)
  const derivedFinishReason = status === 'waiting_result' ? 'unknown_result'
    : status === 'completed' ? 'all_accepted'
      : status === 'partial' ? 'partial_fulfillment'
        : status === 'failed' ? 'provider_rejected' : ''
  const finishReason = isSafetyFinishReason(batch.finish_reason) ? batch.finish_reason : derivedFinishReason
  db.prepare(`
    UPDATE bet_batches
    SET reserved_amount_minor=?, accepted_amount_minor=?, unknown_amount_minor=?,
        unfilled_amount_minor=?, status=?, finish_reason=?, finished_at=?
    WHERE batch_id=?
  `).run(
    totals.reserved,
    totals.accepted,
    totals.unknown,
    Number(BigInt(batch.target_amount_minor) - occupied),
    status,
    finishReason,
    terminal ? (batch.finished_at || at) : '',
    batchId,
  )
}

function writeAudit(db, action, subjectId, details, at) {
  db.prepare(`
    INSERT INTO execution_security_audit (
      audit_id, action, subject_type, subject_id, confirmation_digest, details_json, created_at
    ) VALUES (?, ?, 'submit_attempt', ?, '', ?, ?)
  `).run(randomUUID(), action, subjectId, JSON.stringify(details), at)
}

function result(db, childOrderId, submitAttemptId) {
  const child = db.prepare('SELECT * FROM bet_child_orders WHERE child_order_id=?').get(childOrderId)
  return {
    child: childResult(child),
    batch: batchResult(db.prepare('SELECT * FROM bet_batches WHERE batch_id=?').get(child.batch_id)),
    attempt: attemptResult(db.prepare('SELECT * FROM bet_submit_attempts WHERE submit_attempt_id=?').get(submitAttemptId)),
  }
}

export function assertAuthorizedSubmitContext(database, input = {}, options = {}) {
  const db = dbOf(database)
  const at = atFrom(options)
  return immediate(db, () => {
    assertFence(db, input, at)
    const row = requireContext(db, input, options, at)
    if (row.binding_status !== 'reserved' || row.status !== 'reserved') throw new Error('authorization-child-not-reserved')
    return { childOrderId: row.child_order_id, batchId: row.batch_id, authorizationId: row.authorization_id }
  })
}

export function prepareAuthorizedSubmit(database, input = {}, options = {}) {
  assertCapability(input, options)
  const db = dbOf(database)
  const at = atFrom(options)
  const submitAttemptId = required(input.submitAttemptId, 'submit-attempt-id')
  const ordinal = Number(input.attemptOrdinal)
  if (![1, 2].includes(ordinal)) throw new Error('submit-attempt-ordinal')
  return immediate(db, () => {
    const fencingToken = assertFence(db, input, at)
    const row = requireContext(db, input, options, at)
    if (row.binding_status !== 'reserved') throw new Error('authorization-child-not-reserved')
    const previous = db.prepare(`
      SELECT * FROM bet_submit_attempts WHERE child_order_id=? ORDER BY attempt_ordinal
    `).all(row.child_order_id)
    if (ordinal === 1 && (previous.length !== 0 || row.status !== 'reserved')) throw new Error('submit-attempt-state')
    if (ordinal === 2 && (
      previous.length !== 1
      || Number(previous[0].attempt_ordinal) !== 1
      || previous[0].status !== 'odds_changed_unsent'
      || row.status !== 'reserved'
    )) throw new Error('submit-attempt-limit')
    const preview = assertPreview(row, input)
    db.prepare(`
      INSERT INTO bet_submit_attempts (
        submit_attempt_id, child_order_id, authorization_id, attempt_ordinal,
        amount_minor, fencing_token, capability_version, capability_evidence_id,
        locked_identity_json, preview_snapshot_json, preview_odds, status,
        prepared_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submit_prepared', ?, ?, ?)
    `).run(
      submitAttemptId,
      row.child_order_id,
      row.authorization_id,
      ordinal,
      preview.amount,
      fencingToken,
      required(input.capabilityVersion, 'capability-version'),
      required(input.capabilityEvidenceId, 'capability-evidence-id'),
      stableJson(preview.locked),
      stableJson(preview.preview),
      preview.odds,
      at,
      at,
      at,
    )
    fault(options, 'prepare:after-attempt-insert', { childOrderId: row.child_order_id, submitAttemptId })
    const childChanged = db.prepare(`
      UPDATE bet_child_orders
      SET status='submit_prepared', submit_attempt_id=?, submit_prepared_at=?,
          preview_min_stake_minor=?, preview_max_stake_minor=?, preview_balance_minor=?,
          preview_stake_step_minor=?, preview_odds=?
      WHERE child_order_id=? AND status='reserved'
    `).run(
      submitAttemptId,
      at,
      preview.min,
      preview.max,
      preview.balance,
      preview.step,
      preview.odds,
      row.child_order_id,
    )
    if (childChanged.changes !== 1) throw new Error('child-not-reserved')
    fault(options, 'prepare:after-child-update', { childOrderId: row.child_order_id, submitAttemptId })
    const lockChanged = db.prepare(`
      UPDATE betting_account_locks
      SET status='submitting', fencing_token=?, updated_at=?
      WHERE child_order_id=? AND account_id=?
    `).run(fencingToken, at, row.child_order_id, row.account_id)
    if (lockChanged.changes !== 1) throw new Error('child-order-lock-missing')
    fault(options, 'prepare:after-lock-update', { childOrderId: row.child_order_id, submitAttemptId })
    recomputeBatch(db, row.batch_id, at)
    fault(options, 'prepare:after-batch-recompute', { childOrderId: row.child_order_id, submitAttemptId })
    writeAudit(db, 'submit_prepared', submitAttemptId, {
      childOrderId: row.child_order_id,
      capabilityVersion: String(input.capabilityVersion),
      capabilityEvidenceId: String(input.capabilityEvidenceId),
      attemptOrdinal: ordinal,
    }, at)
    return result(db, row.child_order_id, submitAttemptId)
  })
}

function requireAttemptContext(db, input, options, at, contextOptions) {
  const row = requireContext(db, input, options, at, contextOptions)
  const submitAttemptId = required(input.submitAttemptId, 'submit-attempt-id')
  const attempt = db.prepare('SELECT * FROM bet_submit_attempts WHERE submit_attempt_id=?').get(submitAttemptId)
  if (!attempt || attempt.child_order_id !== row.child_order_id || attempt.authorization_id !== row.authorization_id) {
    throw new Error('submit-attempt-mismatch')
  }
  return { row, attempt, submitAttemptId }
}

export function recordAuthorizedDispatch(database, input = {}, options = {}) {
  const db = dbOf(database)
  const at = atFrom(options)
  return immediate(db, () => {
    const fencingToken = assertFence(db, input, at)
    const { row, attempt, submitAttemptId } = requireAttemptContext(db, input, options, at)
    if (attempt.status === 'submit_dispatched' && row.status === 'submit_dispatched') return result(db, row.child_order_id, submitAttemptId)
    if (attempt.status !== 'submit_prepared' || row.status !== 'submit_prepared' || row.submit_attempt_id !== submitAttemptId) {
      throw new Error('submit-attempt-not-prepared')
    }
    db.prepare(`
      UPDATE bet_submit_attempts
      SET status='submit_dispatched', dispatched_at=?, updated_at=?
      WHERE submit_attempt_id=? AND status='submit_prepared'
    `).run(at, at, submitAttemptId)
    db.prepare(`
      UPDATE bet_child_orders
      SET status='submit_dispatched', submit_dispatched_at=?
      WHERE child_order_id=? AND status='submit_prepared' AND submit_attempt_id=?
    `).run(at, row.child_order_id, submitAttemptId)
    const lockChanged = db.prepare(`
      UPDATE betting_account_locks
      SET status='submitting', fencing_token=?, updated_at=?
      WHERE child_order_id=?
    `).run(fencingToken, at, row.child_order_id)
    if (lockChanged.changes !== 1) throw new Error('child-order-lock-missing')
    writeAudit(db, 'submit_dispatched', submitAttemptId, { childOrderId: row.child_order_id }, at)
    return result(db, row.child_order_id, submitAttemptId)
  })
}

function ledgerOutcome(kind) {
  if (kind === 'accepted') return { child: 'accepted', attempt: 'accepted', binding: 'accepted' }
  if (kind === 'rejected') return { child: 'rejected', attempt: 'rejected', binding: 'released' }
  if (['timeout', 'disconnect', 'pending'].includes(kind)) return { child: 'unknown', attempt: 'unknown', binding: 'unknown' }
  return null
}

function providerReferenceCiphertext(value, { childOrderId, submitAttemptId, secretOptions, requiredValue = false } = {}) {
  const text = String(value || '')
  if (!text) {
    if (requiredValue) throw new Error('provider-reference-ciphertext')
    return ''
  }
  const parts = text.split(':')
  if (
    parts.length !== 4
    || parts[0] !== 'v2'
    || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) throw new Error('provider-reference-ciphertext')
  try {
    decryptSecret(text, {
      ...secretOptions,
      context: {
        purpose: 'crown-provider-reference',
        childOrderId: required(childOrderId, 'child-order-id'),
        submitAttemptId: required(submitAttemptId, 'submit-attempt-id'),
      },
    })
  } catch {
    throw new Error('provider-reference-ciphertext')
  }
  return text
}

function updateAuthorization(db, context, bindingStatus, at) {
  if (context.binding_status === bindingStatus) return
  if (context.binding_status !== 'reserved') throw new Error('authorization-child-binding-terminal')
  const amount = Number(context.binding_amount_minor)
  const accepted = bindingStatus === 'accepted' ? amount : 0
  const unknown = bindingStatus === 'unknown' ? amount : 0
  const changed = db.prepare(`
    UPDATE execution_authorizations
    SET reserved_amount_minor=reserved_amount_minor-?,
        accepted_amount_minor=accepted_amount_minor+?,
        unknown_amount_minor=unknown_amount_minor+?, updated_at=?
    WHERE authorization_id=? AND reserved_amount_minor>=?
  `).run(amount, accepted, unknown, at, context.authorization_id, amount)
  if (changed.changes !== 1) throw new Error('authorization-ledger-invariant')
  const binding = db.prepare(`
    UPDATE execution_authorization_child_budgets
    SET status=?, updated_at=?
    WHERE child_order_id=? AND authorization_id=? AND status='reserved'
  `).run(bindingStatus, at, context.child_order_id, context.authorization_id)
  if (binding.changes !== 1) throw new Error('authorization-child-binding-conflict')
}

function enqueueNotification(db, context, finalStatus, at) {
  if (finalStatus !== 'accepted') return
  const notificationId = `bet:${context.batch_id}:${context.child_order_id}:${finalStatus}`
  db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status, status,
      next_attempt_at, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    ON CONFLICT(batch_id, child_order_id, final_status) DO NOTHING
  `).run(
    notificationId,
    context.batch_id,
    context.child_order_id,
    finalStatus,
    at,
    JSON.stringify({ batchId: context.batch_id, childOrderId: context.child_order_id, finalStatus }),
    at,
    at,
  )
}

export function recordAuthorizedOutcome(database, input = {}, options = {}) {
  const db = dbOf(database)
  const at = atFrom(options)
  const outcome = objectValue(input.outcome, 'submit-outcome-required')
  const kind = required(outcome.kind, 'submit-outcome-kind')
  return immediate(db, () => {
    const fencingToken = assertFence(db, input, at)
    const { row, attempt, submitAttemptId } = requireAttemptContext(db, input, options, at, { settlement: true })
    const standard = ledgerOutcome(kind)
    if (standard) {
      if (attempt.status === standard.attempt && row.status === standard.child) return result(db, row.child_order_id, submitAttemptId)
      if (attempt.status !== 'submit_dispatched' || row.status !== 'submit_dispatched') throw new Error('submit-attempt-not-dispatched')
      const encryptedReference = providerReferenceCiphertext(outcome.providerReferenceCiphertext, {
        childOrderId: row.child_order_id,
        submitAttemptId,
        secretOptions: options,
        requiredValue: standard.child === 'accepted',
      })
      db.prepare(`
        UPDATE bet_submit_attempts
        SET status=?, result_at=?, provider_reference_ciphertext=?, error_code=?, updated_at=?
        WHERE submit_attempt_id=? AND status='submit_dispatched'
      `).run(
        standard.attempt,
        at,
        encryptedReference,
        standard.child === 'unknown' ? `provider-${kind}` : '',
        at,
        submitAttemptId,
      )
      fault(options, 'outcome:after-attempt-update', { childOrderId: row.child_order_id, kind })
      db.prepare(`
        UPDATE bet_child_orders
        SET status=?, provider_reference_ciphertext=?, error_code=?, resolved_at=?
        WHERE child_order_id=? AND status='submit_dispatched' AND submit_attempt_id=?
      `).run(
        standard.child,
        encryptedReference,
        standard.child === 'unknown' ? `provider-${kind}` : '',
        standard.child === 'unknown' ? '' : at,
        row.child_order_id,
        submitAttemptId,
      )
      if (standard.child === 'unknown') {
        db.prepare(`
          UPDATE betting_account_locks SET status='unknown', fencing_token=?, updated_at=?
          WHERE child_order_id=?
        `).run(fencingToken, at, row.child_order_id)
      } else {
        db.prepare('DELETE FROM betting_account_locks WHERE child_order_id=?').run(row.child_order_id)
      }
      fault(options, 'outcome:after-child-update', { childOrderId: row.child_order_id, kind })
      recomputeBatch(db, row.batch_id, at, {
        hasFutureCapacity: standard.child === 'rejected' ? false : (input.hasFutureCapacity ?? true),
      })
      fault(options, 'outcome:after-batch-recompute', { childOrderId: row.child_order_id, kind })
      updateAuthorization(db, row, standard.binding, at)
      fault(options, 'outcome:after-authorization-update', { childOrderId: row.child_order_id, kind })
      enqueueNotification(db, row, standard.child, at)
      writeAudit(db, `submit_${standard.child}`, submitAttemptId, { childOrderId: row.child_order_id, outcome: kind }, at)
      return result(db, row.child_order_id, submitAttemptId)
    }

    if (kind === 'odds_changed_unsent') {
      if (attempt.status !== 'submit_dispatched' || row.status !== 'submit_dispatched') throw new Error('submit-attempt-not-dispatched')
      if (Number(attempt.attempt_ordinal) === 1) {
        db.prepare(`
          UPDATE bet_submit_attempts
          SET status='odds_changed_unsent', result_at=?, error_code='odds-changed-unsent', updated_at=?
          WHERE submit_attempt_id=? AND status='submit_dispatched'
        `).run(at, at, submitAttemptId)
        db.prepare(`
          UPDATE bet_child_orders
          SET status='reserved', error_code='odds-changed-unsent', resolved_at=''
          WHERE child_order_id=? AND status='submit_dispatched'
        `).run(row.child_order_id)
        db.prepare(`
          UPDATE betting_account_locks SET status='reserved', fencing_token=?, updated_at=?
          WHERE child_order_id=?
        `).run(fencingToken, at, row.child_order_id)
        recomputeBatch(db, row.batch_id, at)
        writeAudit(db, 'submit_odds_changed_unsent', submitAttemptId, { childOrderId: row.child_order_id }, at)
        return result(db, row.child_order_id, submitAttemptId)
      }
      db.prepare(`
        UPDATE bet_submit_attempts
        SET status='unknown', result_at=?, error_code='second-odds-change', updated_at=?
        WHERE submit_attempt_id=? AND status='submit_dispatched'
      `).run(at, at, submitAttemptId)
      db.prepare(`
        UPDATE bet_child_orders SET status='unknown', error_code='second-odds-change', resolved_at=''
        WHERE child_order_id=? AND status='submit_dispatched'
      `).run(row.child_order_id)
      db.prepare(`
        UPDATE betting_account_locks SET status='unknown', fencing_token=?, updated_at=?
        WHERE child_order_id=?
      `).run(fencingToken, at, row.child_order_id)
      recomputeBatch(db, row.batch_id, at)
      updateAuthorization(db, row, 'unknown', at)
      enqueueNotification(db, row, 'unknown', at)
      writeAudit(db, 'submit_unknown', submitAttemptId, { childOrderId: row.child_order_id, outcome: 'second-odds-change' }, at)
      return result(db, row.child_order_id, submitAttemptId)
    }

    if (kind === 'line_changed') {
      if (attempt.status !== 'odds_changed_unsent' || row.status !== 'reserved' || Number(attempt.attempt_ordinal) !== 1) {
        throw new Error('line-change-state')
      }
      const current = objectValue(outcome.currentIdentity, 'current-identity-required')
      const locked = parseJsonObject(attempt.locked_identity_json, 'locked-identity-corrupt')
      if (stableJson(current) === stableJson(locked)) throw new Error('line-change-not-observed')
      db.prepare(`
        UPDATE bet_child_orders SET status='rejected', error_code='line-changed', resolved_at=?
        WHERE child_order_id=? AND status='reserved'
      `).run(at, row.child_order_id)
      db.prepare('DELETE FROM betting_account_locks WHERE child_order_id=?').run(row.child_order_id)
      recomputeBatch(db, row.batch_id, at, { hasFutureCapacity: input.hasFutureCapacity ?? false })
      updateAuthorization(db, row, 'released', at)
      enqueueNotification(db, row, 'rejected', at)
      writeAudit(db, 'submit_line_changed', submitAttemptId, { childOrderId: row.child_order_id }, at)
      return result(db, row.child_order_id, submitAttemptId)
    }
    throw new TypeError('submit-outcome-kind')
  })
}

export function recoverAuthorizedAttempts(database, input = {}, options = {}) {
  const db = dbOf(database)
  const at = atFrom(options)
  const authorizationId = required(input.authorizationId, 'authorization-id')
  return immediate(db, () => {
    const fencingToken = assertFence(db, input, at)
    const rows = db.prepare(`
      SELECT attempt.*, child.batch_id, child.account_id, child.requested_amount_minor,
             child.status AS child_status, budget.status AS binding_status,
             budget.amount_minor AS binding_amount_minor,
             batch.card_id,batch.card_version,batch.card_snapshot_json,batch.betting_mode,
             auth.rule_ids_json,auth.betting_modes_json,auth.eligibility_versions_json,auth.card_scopes_json
      FROM bet_submit_attempts AS attempt
      JOIN bet_child_orders AS child ON child.child_order_id=attempt.child_order_id
      JOIN execution_authorization_child_budgets AS budget ON budget.child_order_id=child.child_order_id
      JOIN bet_batches AS batch ON batch.batch_id=child.batch_id
      JOIN execution_authorizations AS auth ON auth.authorization_id=attempt.authorization_id
      WHERE attempt.authorization_id=?
        AND attempt.status IN ('submit_prepared','submit_dispatched','unknown')
      ORDER BY attempt.child_order_id, attempt.attempt_ordinal
    `).all(authorizationId)
    let recoveredCount = 0
    const batches = new Set()
    for (const row of rows) {
      if (row.card_id !== null) {
        let snapshot
        try { snapshot = JSON.parse(row.card_snapshot_json) } catch { throw new Error('bet-batch-card-snapshot') }
        if (snapshot?.cardId !== row.card_id || Number(snapshot?.version) !== Number(row.card_version)) {
          throw new Error('bet-batch-card-snapshot')
        }
        const scope = parseCardScopes(row).find((item) => item.cardId === row.card_id)
        if (!scope || scope.eligibilityVersion !== snapshot.realEligibilityVersion) throw new Error('authorization-card-scope')
        if (!parseModeScope(row).modes.includes(row.betting_mode)) throw new Error('authorization-mode-scope')
      }
      if (row.status !== 'unknown') {
        db.prepare(`
          UPDATE bet_submit_attempts
          SET status='unknown', result_at=?, error_code='recovery-uncertain', updated_at=?
          WHERE submit_attempt_id=? AND status IN ('submit_prepared','submit_dispatched')
        `).run(at, at, row.submit_attempt_id)
        recoveredCount += 1
      }
      if (row.child_status !== 'unknown') {
        db.prepare(`
          UPDATE bet_child_orders
          SET status='unknown', error_code='recovery-uncertain', resolved_at=''
          WHERE child_order_id=? AND status IN ('submit_prepared','submit_dispatched')
        `).run(row.child_order_id)
      }
      upsertUnknownLock(db, row, fencingToken, at)
      if (row.binding_status === 'reserved') {
        const amount = Number(row.binding_amount_minor)
        const authChanged = db.prepare(`
          UPDATE execution_authorizations
          SET reserved_amount_minor=reserved_amount_minor-?, unknown_amount_minor=unknown_amount_minor+?, updated_at=?
          WHERE authorization_id=? AND reserved_amount_minor>=?
        `).run(amount, amount, at, authorizationId, amount)
        if (authChanged.changes !== 1) throw new Error('authorization-ledger-invariant')
        db.prepare(`
          UPDATE execution_authorization_child_budgets SET status='unknown', updated_at=?
          WHERE child_order_id=? AND status='reserved'
        `).run(at, row.child_order_id)
      }
      batches.add(row.batch_id)
      enqueueNotification(db, row, 'unknown', at)
      writeAudit(db, 'submit_recovered_unknown', row.submit_attempt_id, { childOrderId: row.child_order_id }, at)
    }
    for (const batchId of batches) recomputeBatch(db, batchId, at)
    return { recoveredCount, authorizationId, batchIds: [...batches].sort() }
  })
}

function upsertUnknownLock(db, row, fencingToken, at) {
  db.prepare(`
    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token, acquired_at, updated_at
    ) VALUES (?, ?, ?, 'unknown', ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      child_order_id=excluded.child_order_id,
      batch_id=excluded.batch_id,
      status='unknown',
      fencing_token=excluded.fencing_token,
      updated_at=excluded.updated_at
    WHERE betting_account_locks.child_order_id=excluded.child_order_id
  `).run(row.account_id, row.child_order_id, row.batch_id, fencingToken, row.created_at || at, at)
  const lock = db.prepare(`
    SELECT child_order_id, batch_id, status, fencing_token
    FROM betting_account_locks WHERE account_id=?
  `).get(row.account_id)
  if (
    !lock
    || lock.child_order_id !== row.child_order_id
    || lock.batch_id !== row.batch_id
    || lock.status !== 'unknown'
    || Number(lock.fencing_token) !== fencingToken
  ) throw new Error('recovery-lock-conflict')
}

export function recoverAuthorizedAttempt(database, input = {}, options = {}) {
  const db = dbOf(database)
  const at = atFrom(options)
  return immediate(db, () => {
    const fencingToken = assertFence(db, input, at)
    const { row, attempt, submitAttemptId } = requireAttemptContext(db, input, options, at, { settlement: true })
    if (!['submit_prepared', 'submit_dispatched', 'unknown'].includes(attempt.status)) {
      throw new Error('submit-attempt-not-recoverable')
    }
    if (attempt.status !== 'unknown') {
      db.prepare(`
        UPDATE bet_submit_attempts
        SET status='unknown', result_at=?, error_code='recovery-uncertain', updated_at=?
        WHERE submit_attempt_id=? AND status IN ('submit_prepared','submit_dispatched')
      `).run(at, at, submitAttemptId)
    }
    if (row.status !== 'unknown') {
      db.prepare(`
        UPDATE bet_child_orders
        SET status='unknown', error_code='recovery-uncertain', resolved_at=''
        WHERE child_order_id=? AND status IN ('submit_prepared','submit_dispatched')
      `).run(row.child_order_id)
    }
    if (row.binding_status === 'reserved') updateAuthorization(db, row, 'unknown', at)
    upsertUnknownLock(db, row, fencingToken, at)
    recomputeBatch(db, row.batch_id, at)
    enqueueNotification(db, row, 'unknown', at)
    writeAudit(db, 'submit_recovered_unknown', submitAttemptId, { childOrderId: row.child_order_id }, at)
    return result(db, row.child_order_id, submitAttemptId)
  })
}

export class B2Executor {
  constructor({
    database,
    previewProvider,
    executionProvider,
    lease,
    env = process.env,
    now = () => new Date(),
    secretKey,
  } = {}) {
    this.database = dbOf(database)
    if (!(previewProvider instanceof CrownAccountPreviewProvider)) throw new TypeError('b2-preview-provider')
    if (!(executionProvider instanceof CrownAccountExecutionProvider)) throw new TypeError('b2-execution-provider')
    if (!lease || typeof lease.assertFence !== 'function') throw new TypeError('b2-executor-lease')
    if (!/^betting-executor:\S+$/.test(String(lease.leaseKey || ''))) throw new TypeError('b2-executor-lease-key')
    this.previewProvider = previewProvider
    this.executionProvider = executionProvider
    this.lease = lease
    this.options = { env, now, secretKey }
  }

  _gate(input) {
    const fencingToken = this.lease.fencingToken
    this.lease.assertFence(fencingToken)
    const scope = input.ruleId !== undefined && input.ruleId !== null
      ? { ruleId: input.ruleId }
      : input.cardId !== undefined && input.cardId !== null
        ? { cardId: input.cardId, eligibilityVersion: input.eligibilityVersion, bettingMode: input.bettingMode }
        : { bettingMode: input.bettingMode, settingsVersion: input.settingsVersion }
    return {
      authorizationId: input.authorizationId,
      ...scope,
      batchId: input.batchId,
      childOrderId: input.childOrderId,
      accountId: input.accountId,
      leaseKey: this.lease.leaseKey,
      executorOwnerId: this.lease.ownerId,
      fencingToken,
    }
  }

  async submit(input = {}) {
    const gate = this._gate(input)
    assertAuthorizedSubmitContext(this.database, gate, this.options)
    const previewResult = await this.previewProvider.preview({
      accountId: input.accountId,
      batchId: input.batchId,
      lockedSelection: input.lockedSelection,
    })
    if (previewResult?.realExecutionEligible !== true) throw new Error('preview-real-execution-blocked')
    const trusted = {
      ...input,
      ...gate,
      capabilityEvidenceId: previewResult.capabilityEvidenceId,
      capabilityVersion: previewResult.capabilityVersion,
      lockedIdentity: previewResult.lockedIdentity,
      currentIdentity: previewResult.lockedIdentity,
      preview: previewResult.executionPreview,
    }
    const prepared = prepareAuthorizedSubmit(this.database, trusted, this.options)
    let dispatched = false
    const onNetworkStarted = () => {
      if (dispatched) throw new Error('provider-network-started-twice')
      recordAuthorizedDispatch(this.database, {
        ...gate,
        submitAttemptId: input.submitAttemptId,
      }, this.options)
      dispatched = true
    }
    let outcome
    try {
      outcome = await this.executionProvider.submit({
        accountId: input.accountId,
        batchId: input.batchId,
        childOrderId: input.childOrderId,
        submitAttemptId: input.submitAttemptId,
        attemptOrdinal: input.attemptOrdinal,
        capabilityVersion: trusted.capabilityVersion,
        capabilityEvidenceId: trusted.capabilityEvidenceId,
        lockedIdentity: trusted.lockedIdentity,
        currentIdentity: trusted.currentIdentity,
        preview: trusted.preview,
        onNetworkStarted,
      })
    } catch {
      if (!dispatched) {
        recoverAuthorizedAttempt(this.database, {
          ...gate,
          submitAttemptId: input.submitAttemptId,
        }, this.options)
        return { ...prepared, status: 'unknown', reason: 'provider-before-dispatch-uncertain' }
      }
      outcome = { kind: 'disconnect' }
    }
    if (!dispatched) {
      recoverAuthorizedAttempt(this.database, {
        ...gate,
        submitAttemptId: input.submitAttemptId,
      }, this.options)
      return { ...prepared, status: 'unknown', reason: 'provider-dispatch-contract' }
    }
    return recordAuthorizedOutcome(this.database, {
      ...gate,
      submitAttemptId: input.submitAttemptId,
      outcome,
      hasFutureCapacity: input.hasFutureCapacity,
    }, this.options)
  }

  recover(authorizationId) {
    const fencingToken = this.lease.fencingToken
    this.lease.assertFence(fencingToken)
    return recoverAuthorizedAttempts(this.database, {
      authorizationId,
      leaseKey: this.lease.leaseKey,
      executorOwnerId: this.lease.ownerId,
      fencingToken,
    }, this.options)
  }
}
