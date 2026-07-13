import { listCrownCapabilities } from './crown-capability-matrix.mjs'
import { bettingRoleLeaseKeys } from '../app/betting-process.mjs'
import { inspectWatcherLease } from '../app/watcher-lease-status.mjs'
import { CANONICAL_REAL_RULE_SQL } from './canonical-real-rule.mjs'

const PREFLIGHT = Object.freeze([
  ['watcherFresh', 'watcher-not-fresh'],
  ['watcherLeaseUnique', 'watcher-lease-not-unique'],
  ['monitorLoginFresh', 'monitor-login-not-fresh'],
  ['bettingAccountFresh', 'betting-account-login-not-fresh'],
  ['balanceFresh', 'betting-account-balance-not-fresh'],
  ['capabilityExact', 'capability-evidence-not-exact'],
  ['authorizationActive', 'authorization-not-active'],
  ['schemaCurrent', 'schema-not-current'],
  ['environmentExact', 'environment-not-exact'],
  ['fenceFresh', 'fence-not-fresh'],
  ['executorLeaseFresh', 'executor-lease-not-fresh'],
  ['reconcilerLeaseFresh', 'reconciler-lease-not-fresh'],
  ['executorReconcilerDistinct', 'executor-reconciler-lease-not-distinct'],
])

export const REAL_BETTING_SCHEMA_CONTRACT_VERSION = 1

function dbOf(database) {
  const db = database?.db || database
  if (!db?.prepare || !db?.exec) throw new TypeError('real-betting-runtime-db')
  return db
}

function at(options = {}) {
  const value = (options.now || (() => new Date()))()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('real-betting-runtime-time')
  return date.toISOString()
}

function rowStatus(row) {
  return {
    requested: Number(row?.requested || 0) === 1,
    state: row?.runtime_state || 'off',
    reasonCode: row?.reason_code || '',
    updatedAt: row?.updated_at || '',
  }
}

function ensureRow(db) {
  db.prepare(`
    INSERT INTO real_betting_runtime (singleton_id, requested, runtime_state, reason_code, updated_at)
    VALUES (1, 0, 'off', '', '')
    ON CONFLICT(singleton_id) DO NOTHING
  `).run()
}

function update(db, { requested, state, reasonCode }, updatedAt) {
  db.prepare(`
    UPDATE real_betting_runtime
    SET requested = ?, runtime_state = ?, reason_code = ?, updated_at = ?
    WHERE singleton_id = 1
  `).run(requested ? 1 : 0, state, reasonCode || '', updatedAt)
  return rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id = 1').get())
}

function immediate(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function evaluateRealBettingPreflight(checks = {}) {
  const preflight = PREFLIGHT.map(([field, code]) => ({ code, ready: checks[field] === true }))
  const blockingReasons = preflight.filter((item) => !item.ready).map((item) => item.code)
  return { ready: blockingReasons.length === 0, reasonCode: blockingReasons[0] || '', blockingReasons, preflight }
}

export function evaluatePureModePreflight({ authorizedModes, eligibilityVersions, settings, capabilities, hardCapAmountMinor } = {}) {
  const modes = Array.isArray(authorizedModes) ? authorizedModes : []
  const rows = Array.isArray(settings) ? settings : []
  const evidence = Array.isArray(capabilities) ? capabilities : []
  const versions = eligibilityVersions && typeof eligibilityVersions === 'object' && !Array.isArray(eligibilityVersions)
    ? eligibilityVersions : {}
  const uniqueModes = [...new Set(modes)]
  const settingsByMode = new Map(rows.map((row) => [row.mode, row]))
  const cap = Number(hardCapAmountMinor)
  const scopeExact = modes.length > 0 && uniqueModes.length === modes.length
    && modes.every((mode) => ['prematch', 'live'].includes(mode)
      && settingsByMode.has(mode)
      && Number.isSafeInteger(Number(settingsByMode.get(mode).targetAmountMinor))
      && Number(settingsByMode.get(mode).targetAmountMinor) > 0
      && Number.isSafeInteger(cap) && cap > 0
      && Number(settingsByMode.get(mode).targetAmountMinor) <= cap
      && Number.isSafeInteger(Number(versions[mode]))
      && Number(versions[mode]) === Number(settingsByMode.get(mode).realEligibilityVersion))
    && Object.keys(versions).sort().join('|') === [...modes].sort().join('|')
  const capabilityExact = scopeExact && modes.every((mode) => {
    const modeRows = evidence.filter((row) => row.mode === mode)
    return modeRows.length > 0 && modeRows.every((row) => row.evidenceStatus === 'verified'
      && row.previewAllowed === true && row.submitAllowed === true && row.reconciliationAllowed === true)
  })
  return { scopeExact, capabilityExact }
}

function fresh(timestamp, nowMs, freshnessMs) {
  const value = Date.parse(String(timestamp || ''))
  return Number.isFinite(value) && value <= nowMs && nowMs - value <= freshnessMs
}

export function collectRealBettingPreflight(database, options = {}) {
  const db = dbOf(database)
  const nowMs = Date.parse(at(options))
  const freshnessMs = Number.isSafeInteger(options.freshnessMs) && options.freshnessMs > 0 ? options.freshnessMs : 60_000
  const dbPath = String(options.dbPath || database?.dbPath || '')
  let roleKeys = null
  if (dbPath && dbPath !== ':memory:') {
    roleKeys = bettingRoleLeaseKeys({ dbPath, cwd: options.cwd })
  }
  const watcherStatus = inspectWatcherLease(db, {
    dbPath, runtimeDir: options.runtimeDir || 'data/runtime', cwd: options.cwd, now: new Date(nowMs), freshnessMs,
  })
  const leaseFor = (key) => key ? db.prepare('SELECT lease_key,owner_id,fencing_token,heartbeat_at,expires_at FROM runtime_leases WHERE lease_key=?').get(key) : null
  const active = (row) => Boolean(row && Date.parse(row.expires_at) > nowMs)
  const watcher = watcherStatus.row
  const executor = leaseFor(roleKeys?.executor)
  const reconciler = leaseFor(roleKeys?.reconciler)
  const worker = leaseFor(roleKeys?.worker)
  const ticket = options.readyTicket
  const held = (role, row) => Boolean(active(row) && ticket?.leases?.[role]
    && ticket.leases[role].leaseKey === row.lease_key
    && ticket.leases[role].ownerId === row.owner_id
    && Number(ticket.leases[role].fencingToken) === Number(row.fencing_token)
    && fresh(row.heartbeat_at, nowMs, freshnessMs))
  const acquirable = (row) => !active(row)
  const monitor = db.prepare('SELECT * FROM monitor_accounts WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1').get()
  let monitorResult = {}
  try { monitorResult = JSON.parse(monitor?.last_login_result_json || '{}') } catch {}
  const accounts = db.prepare("SELECT * FROM betting_accounts WHERE status='enabled' AND archived=0").all()
  const freshAccounts = accounts.filter((row) => row.access_status === 'available' && fresh(row.access_checked_at, nowMs, freshnessMs))
  const balancedAccounts = freshAccounts.filter((row) => (
    (row.balance_minor !== null && fresh(row.balance_updated_at, nowMs, freshnessMs))
    || (row.reported_balance !== null && fresh(row.reported_balance_updated_at, nowMs, freshnessMs))
  ))
  const env = options.env || process.env
  const currency = String(env.CROWN_REAL_CURRENCY || '')
  const amountScale = Number(env.CROWN_REAL_AMOUNT_SCALE)
  const hardCap = Number(env.CROWN_REAL_MAX_TOTAL_MINOR)
  const environmentValid = /^[A-Z]{3}$/.test(currency) && Number.isInteger(amountScale)
    && amountScale >= 0 && amountScale <= 6 && Number.isSafeInteger(hardCap) && hardCap > 0
  const authorizations = db.prepare("SELECT * FROM execution_authorizations WHERE status='active'").all()
  const authorization = authorizations.length === 1 ? authorizations[0] : null
  const authorizationFresh = Boolean(authorization && Date.parse(authorization.valid_from) <= nowMs && Date.parse(authorization.expires_at) > nowMs)
  const environmentExact = Boolean(environmentValid && authorizationFresh
    && authorization.currency === currency && Number(authorization.amount_scale) === amountScale
    && Number(authorization.hard_cap_amount_minor) === hardCap
    && Number(authorization.max_total_amount_minor) <= hardCap)
  const requiredTables = ['real_betting_runtime', 'runtime_leases', 'monitor_accounts', 'betting_accounts', 'betting_rules', 'execution_authorizations', 'execution_authorization_child_budgets', 'bet_batches', 'bet_child_orders', 'bet_submit_attempts', 'bet_reconciliation_state']
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
  const requiredColumns = {
    real_betting_runtime: ['requested', 'runtime_state', 'reason_code'],
    runtime_leases: ['lease_key', 'owner_id', 'fencing_token', 'heartbeat_at', 'expires_at'],
    execution_authorizations: ['rule_ids_json', 'betting_modes_json', 'eligibility_versions_json', 'card_scopes_json', 'hard_cap_amount_minor', 'status', 'valid_from', 'expires_at'],
    bet_submit_attempts: ['capability_version', 'capability_evidence_id', 'fencing_token', 'status'],
  }
  const schemaColumnsCurrent = Object.entries(requiredColumns).every(([table, columns]) => {
    if (!tables.has(table)) return false
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
    return columns.every((column) => present.has(column))
  })
  const requiredSchemaObjects = [
    'execution_authorizations_active_idx',
    'bet_submit_attempts_child_status_idx',
    'bet_submit_attempts_immutable_update',
    'bet_submit_attempts_immutable_delete',
    'bet_submit_attempts_initial_status',
    'bet_submit_attempts_status_transition',
    'bet_reconciliation_state_due_idx',
    'bet_reconciliation_evidence_immutable_update',
    'bet_reconciliation_evidence_immutable_delete',
    'execution_authorizations_safe_insert',
    'execution_authorizations_safe_update',
  ]
  const schemaObjects = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')").all().map((row) => row.name))
  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys) === 1
  const integrityCurrent = db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
  const schemaObjectsCurrent = requiredSchemaObjects.every((name) => schemaObjects.has(name))
  const realRules = db.prepare(`SELECT id,mode,period,market_type FROM betting_rules WHERE ${CANONICAL_REAL_RULE_SQL}`).all()
  const capabilities = listCrownCapabilities()
  const legacyCapabilityExact = realRules.length > 0 && realRules.every((rule) => capabilities.some((row) =>
    row.mode === rule.mode && row.period === (rule.period === 'full' ? 'full_time' : rule.period)
      && row.marketType === rule.market_type && row.lineVariant === 'main'
      && row.evidenceStatus === 'verified' && row.previewAllowed === true
      && row.submitAllowed === true && row.reconciliationAllowed === true))
  let authorizationRuleIds = []
  let authorizationModes = []
  let authorizationEligibilityVersions = {}
  let authorizationCardScopes = []
  try { authorizationRuleIds = JSON.parse(authorization?.rule_ids_json || '[]') } catch {}
  try { authorizationModes = JSON.parse(authorization?.betting_modes_json || '[]') } catch {}
  try { authorizationEligibilityVersions = JSON.parse(authorization?.eligibility_versions_json || '{}') } catch {}
  try { authorizationCardScopes = JSON.parse(authorization?.card_scopes_json || '[]') } catch {}
  const expectedRuleIds = realRules.map((row) => row.id).sort()
  const eligibleModes = db.prepare(`
    SELECT mode, real_eligibility_version, target_amount_minor
    FROM auto_betting_settings
    WHERE enabled=1 AND real_eligible=1 AND migration_review_required=0
      AND currency=? AND amount_scale=?
    ORDER BY mode
  `).all(currency, amountScale)
  const expectedModes = eligibleModes.map((row) => row.mode)
  const pureMode = evaluatePureModePreflight({
    authorizedModes: authorizationModes,
    eligibilityVersions: authorizationEligibilityVersions,
    settings: eligibleModes.map((row) => ({ mode: row.mode, realEligibilityVersion: row.real_eligibility_version,
      targetAmountMinor: row.target_amount_minor })),
    capabilities,
    hardCapAmountMinor: hardCap,
  })
  const legacyScopeExact = expectedRuleIds.length > 0
    && JSON.stringify([...authorizationRuleIds].sort()) === JSON.stringify(expectedRuleIds)
    && authorizationModes.length === 0
  const modeScopeExact = expectedModes.length > 0 && authorizationRuleIds.length === 0 && pureMode.scopeExact
  const eligibleCards = db.prepare(`SELECT card_id,real_eligibility_version,target_amount_minor
    FROM auto_betting_rule_cards WHERE enabled=1 AND real_eligible=1 AND migration_review_required=0
      AND currency=? AND amount_scale=? ORDER BY card_id`).all(currency, amountScale)
  const expectedCardScopes = eligibleCards.map((row) => ({ cardId: row.card_id, eligibilityVersion: Number(row.real_eligibility_version) }))
  const cardScopeExact = expectedCardScopes.length > 0 && authorizationRuleIds.length === 0
    && Array.isArray(authorizationCardScopes)
    && JSON.stringify([...authorizationCardScopes].sort((a, b) => String(a?.cardId).localeCompare(String(b?.cardId)))) === JSON.stringify(expectedCardScopes)
    && authorizationModes.length > 0 && new Set(authorizationModes).size === authorizationModes.length
    && authorizationModes.every((mode) => ['prematch', 'live'].includes(mode))
    && eligibleCards.every((row) => Number.isSafeInteger(Number(row.target_amount_minor))
      && Number(row.target_amount_minor) > 0 && Number(row.target_amount_minor) <= hardCap)
  const cardCapabilityExact = cardScopeExact && authorizationModes.every((mode) => {
    const rows = capabilities.filter((row) => row.mode === mode)
    return rows.length > 0 && rows.every((row) => row.evidenceStatus === 'verified'
      && row.previewAllowed === true && row.submitAllowed === true && row.reconciliationAllowed === true)
  })
  const authorizationScopeExact = legacyScopeExact || modeScopeExact || cardScopeExact
  const capabilityExact = legacyScopeExact ? legacyCapabilityExact : cardScopeExact ? cardCapabilityExact : modeScopeExact ? pureMode.capabilityExact : false
  const postReady = Boolean(ticket)
  const rolesReady = postReady
    ? held('worker', worker) && held('executor', executor) && held('reconciler', reconciler)
    : acquirable(worker) && acquirable(executor) && acquirable(reconciler)
  return {
    watcherFresh: watcherStatus.fresh,
    watcherLeaseUnique: watcherStatus.exists,
    monitorLoginFresh: Boolean(monitor && monitorResult.ok === true && monitorResult.sessionVerified === true
      && fresh(monitor.last_login_result_at, nowMs, freshnessMs)),
    bettingAccountFresh: freshAccounts.length > 0,
    balanceFresh: balancedAccounts.length > 0,
    capabilityExact,
    authorizationActive: authorizationFresh && authorizationScopeExact,
    schemaCurrent: REAL_BETTING_SCHEMA_CONTRACT_VERSION === 1 && requiredTables.every((table) => tables.has(table))
      && schemaColumnsCurrent && schemaObjectsCurrent && foreignKeysEnabled && integrityCurrent,
    environmentExact,
    fenceFresh: rolesReady,
    executorLeaseFresh: postReady ? held('executor', executor) : acquirable(executor),
    reconcilerLeaseFresh: postReady ? held('reconciler', reconciler) : acquirable(reconciler),
    executorReconcilerDistinct: postReady ? Boolean(held('executor', executor) && held('reconciler', reconciler)
      && executor.lease_key !== reconciler.lease_key && executor.owner_id !== reconciler.owner_id) : Boolean(roleKeys && roleKeys.executor !== roleKeys.reconciler),
  }
}

export function refreshRealBettingRuntime(database, { checks, ...options } = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id=1').get())
  const evidence = checks || collectRealBettingPreflight(db, options)
  const preflight = evaluateRealBettingPreflight(evidence)
  if (current.requested && current.state === 'running' && !preflight.ready) {
    return statusWithPreflight(update(db, { requested: true, state: 'blocked', reasonCode: preflight.reasonCode }, at(options)), evidence)
  }
  return statusWithPreflight(current, evidence)
}

export function recordRealBettingWorkerExit(database, { unexpected = true, ...options } = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id=1').get())
  if (!current.requested) return statusWithPreflight(current, {})
  if (!unexpected) return statusWithPreflight(current, {})
  return statusWithPreflight(update(db, { requested: true, state: 'blocked', reasonCode: 'worker-exited' }, at(options)), {})
}

export function blockRealBettingRuntime(database, reasonCode = 'preflight-required', options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id=1').get())
  if (!current.requested) return statusWithPreflight(current, {})
  return statusWithPreflight(update(db, { requested: true, state: 'blocked', reasonCode }, at(options)), {})
}

function statusWithPreflight(status, checks) {
  const { preflight, blockingReasons } = evaluateRealBettingPreflight(checks)
  return { ...status, preflight, blockingReasons }
}

export function getRealBettingStatus(database, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id = 1').get())
  if (options.initialize === true && current.requested && current.state !== 'armed_waiting') {
    return statusWithPreflight(
      update(db, { requested: true, state: 'armed_waiting', reasonCode: 'preflight-required' }, at(options)),
      options.checks || {},
    )
  }
  return statusWithPreflight(current, options.checks || {})
}

export function requestRealBettingStart(database, checks = {}, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const updatedAt = at(options)
  return immediate(db, () => {
    update(db, { requested: true, state: 'armed_waiting', reasonCode: 'preflight-required' }, updatedAt)
    const preflight = evaluateRealBettingPreflight(checks)
    if (!preflight.ready) {
      return statusWithPreflight(
        update(db, { requested: true, state: 'armed_waiting', reasonCode: preflight.reasonCode }, updatedAt),
        checks,
      )
    }
    return statusWithPreflight(update(db, { requested: true, state: 'running', reasonCode: '' }, updatedAt), checks)
  })
}

export function armRealBettingStart(database, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  return update(db, { requested: true, state: 'armed_waiting', reasonCode: 'preflight-required' }, at(options))
}

export function commitRealBettingRunning(database, checks = {}, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const preflight = evaluateRealBettingPreflight(checks)
  if (!preflight.ready) {
    return statusWithPreflight(update(db, { requested: true, state: 'armed_waiting', reasonCode: preflight.reasonCode }, at(options)), checks)
  }
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id=1').get())
  if (!current.requested) return statusWithPreflight(current, checks)
  return statusWithPreflight(update(db, { requested: true, state: 'running', reasonCode: '' }, at(options)), checks)
}

export function assertRealBettingRequested(database) {
  const status = getRealBettingStatus(database)
  if (!status.requested || status.state !== 'running') {
    const error = new Error('real-betting-not-requested')
    error.code = 'real-betting-not-requested'
    throw error
  }
  return true
}

export function assertRealBettingIntentRequested(database) {
  const status = getRealBettingStatus(database)
  if (!status.requested) {
    const error = new Error('real-betting-not-requested')
    error.code = 'real-betting-not-requested'
    throw error
  }
  return true
}

function cancelProvablyUnsent(db, updatedAt) {
  const reserved = db.prepare(`
    SELECT child.child_order_id, child.batch_id
    FROM bet_child_orders AS child
    JOIN bet_batches AS batch ON batch.batch_id = child.batch_id
    WHERE child.status = 'reserved' AND batch.authorization_id IS NOT NULL
      AND batch.status NOT IN ('completed','partial','failed','cancelled')
  `).all()
  for (const child of reserved) {
    const budget = db.prepare(`
      SELECT authorization_id, amount_minor
      FROM execution_authorization_child_budgets
      WHERE child_order_id = ? AND status = 'reserved'
    `).get(child.child_order_id)
    if (!budget) throw new Error('real-betting-stop-budget-missing')
    const cancelled = db.prepare(`
      UPDATE bet_child_orders
      SET status = 'cancelled', error_code = 'real_betting_stopped', resolved_at = ?
      WHERE child_order_id = ? AND status = 'reserved'
    `).run(updatedAt, child.child_order_id)
    if (cancelled.changes !== 1) throw new Error('real-betting-stop-child-cas')
    db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(child.child_order_id)
    if (budget) {
      const released = db.prepare(`
        UPDATE execution_authorization_child_budgets SET status = 'released', updated_at = ?
        WHERE child_order_id = ? AND status = 'reserved'
      `).run(updatedAt, child.child_order_id)
      if (released.changes !== 1) throw new Error('real-betting-stop-budget-cas')
      const authorization = db.prepare(`
        UPDATE execution_authorizations
        SET reserved_amount_minor = reserved_amount_minor - ?, updated_at = ?
        WHERE authorization_id = ? AND reserved_amount_minor >= ?
      `).run(budget.amount_minor, updatedAt, budget.authorization_id, budget.amount_minor)
      if (authorization.changes !== 1) throw new Error('real-betting-stop-authorization-cas')
    }
  }
  for (const batchId of new Set(reserved.map((child) => child.batch_id))) {
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('reserved','submit_prepared','submit_dispatched') THEN requested_amount_minor ELSE 0 END),0) AS reserved,
        COALESCE(SUM(CASE WHEN status='accepted' THEN requested_amount_minor ELSE 0 END),0) AS accepted,
        COALESCE(SUM(CASE WHEN status='unknown' THEN requested_amount_minor ELSE 0 END),0) AS unknown,
        COALESCE(SUM(CASE WHEN status IN ('submit_prepared','submit_dispatched') THEN 1 ELSE 0 END),0) AS active
      FROM bet_child_orders WHERE batch_id = ?
    `).get(batchId)
    const batch = db.prepare('SELECT target_amount_minor,status,finished_at FROM bet_batches WHERE batch_id = ?').get(batchId)
    const occupied = totals.reserved + totals.accepted + totals.unknown
    if (!batch || occupied > batch.target_amount_minor) throw new Error('real-betting-stop-batch-ledger')
    const status = totals.unknown > 0 ? 'waiting_result'
      : totals.active > 0 ? 'submitting'
        : totals.accepted > 0 ? 'partial' : 'cancelled'
    const terminal = ['partial', 'cancelled'].includes(status)
    const aggregate = db.prepare(`
      UPDATE bet_batches SET reserved_amount_minor=?,accepted_amount_minor=?,unknown_amount_minor=?,
        unfilled_amount_minor=?,status=?,finish_reason='real_betting_stopped',finished_at=?
      WHERE batch_id=? AND status NOT IN ('completed','partial','failed','cancelled')
    `).run(totals.reserved, totals.accepted, totals.unknown, batch.target_amount_minor - occupied,
      status, terminal ? (batch.finished_at || updatedAt) : '', batchId)
    if (aggregate.changes !== 1) throw new Error('real-betting-stop-batch-cas')
  }
  return reserved.length
}

export function requestRealBettingStop(database, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const updatedAt = at(options)
  return immediate(db, () => {
    update(db, { requested: false, state: 'stopping', reasonCode: 'stop-requested' }, updatedAt)
    cancelProvablyUnsent(db, updatedAt)
    return statusWithPreflight(update(db, { requested: false, state: 'off', reasonCode: '' }, updatedAt), options.checks || {})
  })
}
