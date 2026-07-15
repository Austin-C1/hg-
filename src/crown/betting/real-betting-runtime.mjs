import { listCrownCapabilities } from './crown-capability-matrix.mjs'
import { bettingRoleLeaseKeys } from '../app/betting-process.mjs'

const PREFLIGHT = Object.freeze([
  ['ruleCardsEnabled', 'betting-rule-card-not-enabled'],
  ['bettingAccountAvailable', 'betting-account-unavailable'],
  ['capabilityExact', 'capability-evidence-not-exact'],
  ['schemaCurrent', 'schema-not-current'],
  ['fenceFresh', 'fence-not-fresh'],
  ['executorLeaseFresh', 'executor-lease-not-fresh'],
])
const STATIC_PREFLIGHT = Object.freeze(PREFLIGHT.slice(0, 4))

export const REAL_BETTING_SCHEMA_CONTRACT_VERSION = 2

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

function evaluatePreflight(checks, requirements) {
  const preflight = requirements.map(([field, code]) => ({ code, ready: checks[field] === true }))
  const blockingReasons = preflight.filter((item) => !item.ready).map((item) => item.code)
  return { ready: blockingReasons.length === 0, reasonCode: blockingReasons[0] || '', blockingReasons, preflight }
}

export function evaluateRealBettingPreflight(checks = {}) {
  return evaluatePreflight(checks, PREFLIGHT)
}

export function evaluateRealBettingStaticPreflight(checks = {}) {
  return evaluatePreflight(checks, STATIC_PREFLIGHT)
}

export function evaluatePureModePreflight({ settings, capabilities } = {}) {
  const rows = Array.isArray(settings) ? settings : []
  const evidence = Array.isArray(capabilities) ? capabilities : []
  const scopeExact = rows.length > 0 && rows.every((row) => row && typeof row === 'object' && row.enabled !== false)
  const modes = [...new Set(rows.map((row) => row.mode).filter((mode) => ['prematch', 'live'].includes(mode)))]
  const exact = (row) => row?.evidenceStatus === 'verified'
    && row.previewAllowed === true && row.submitAllowed === true
  const capabilityExact = scopeExact && (modes.length > 0
    ? modes.every((mode) => evidence.some((row) => row.mode === mode && exact(row)))
    : evidence.some(exact))
  return { scopeExact, capabilityExact }
}

export function hasOpenBetReconciliation(database) {
  const db = dbOf(database)
  return Boolean(db.prepare(`
    SELECT state.submit_attempt_id
    FROM bet_reconciliation_state AS state
    JOIN bet_submit_attempts AS attempt
      ON attempt.submit_attempt_id=state.submit_attempt_id
    JOIN bet_child_orders AS child
      ON child.child_order_id=attempt.child_order_id
    WHERE state.status IN ('pending','waiting')
      AND attempt.status='unknown'
      AND child.status='unknown'
    LIMIT 1
  `).get())
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
  const leaseFor = (key) => key ? db.prepare('SELECT lease_key,owner_id,fencing_token,heartbeat_at,expires_at FROM runtime_leases WHERE lease_key=?').get(key) : null
  const active = (row) => Boolean(row && Date.parse(row.expires_at) > nowMs)
  const executor = leaseFor(roleKeys?.executor)
  const worker = leaseFor(roleKeys?.worker)
  const reconciler = leaseFor(roleKeys?.reconciler)
  const ticket = options.readyTicket
  const held = (role, row) => Boolean(active(row) && ticket?.leases?.[role]
    && ticket.leases[role].leaseKey === row.lease_key
    && ticket.leases[role].ownerId === row.owner_id
    && Number(ticket.leases[role].fencingToken) === Number(row.fencing_token)
    && Number.isFinite(Date.parse(row.heartbeat_at))
    && nowMs - Date.parse(row.heartbeat_at) >= 0
    && nowMs - Date.parse(row.heartbeat_at) <= freshnessMs)
  const acquirable = (row) => !active(row)
  const accounts = db.prepare(`
    SELECT id FROM betting_accounts
    WHERE status='enabled' AND archived=0 AND allocation_status='enabled'
      AND currency='CNY' AND amount_scale=0
    ORDER BY bet_order, created_at, id
  `).all()
  const cards = db.prepare(`
    SELECT card_id, target_amount_minor
    FROM auto_betting_rule_cards
    WHERE enabled=1 AND migration_review_required=0
      AND currency='CNY' AND amount_scale=0 AND target_amount_minor > 0
    ORDER BY card_id
  `).all()
  const capabilities = listCrownCapabilities()
  const pure = evaluatePureModePreflight({
    settings: cards.map((row) => ({ ...row, enabled: true })),
    capabilities,
  })
  const requiredTables = [
    'real_betting_runtime', 'runtime_leases', 'betting_accounts', 'auto_betting_rule_cards',
    'bet_batches', 'bet_child_orders', 'bet_submit_attempts', 'betting_account_locks',
  ]
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
  const requiredColumns = {
    real_betting_runtime: ['requested', 'runtime_state', 'reason_code'],
    runtime_leases: ['lease_key', 'owner_id', 'fencing_token', 'heartbeat_at', 'expires_at'],
    betting_accounts: ['status', 'archived', 'allocation_status', 'bet_order', 'currency', 'amount_scale'],
    auto_betting_rule_cards: ['enabled', 'migration_review_required', 'target_amount_minor', 'currency', 'amount_scale'],
    bet_submit_attempts: [
      'capability_version', 'capability_evidence_id', 'execution_candidate_digest',
      'fencing_token', 'status',
    ],
    betting_account_locks: ['account_id', 'child_order_id', 'batch_id', 'status', 'fencing_token'],
  }
  const schemaColumnsCurrent = Object.entries(requiredColumns).every(([table, columns]) => {
    if (!tables.has(table)) return false
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
    return columns.every((column) => present.has(column))
  })
  const requiredSchemaObjects = [
    'bet_submit_attempts_child_status_idx',
    'bet_submit_attempts_immutable_update',
    'bet_submit_attempts_immutable_delete',
    'bet_submit_attempts_initial_status',
    'bet_submit_attempts_status_transition',
  ]
  const schemaObjects = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')").all().map((row) => row.name))
  const foreignKeysEnabled = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys) === 1
  const integrityCurrent = db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
  const schemaObjectsCurrent = requiredSchemaObjects.every((name) => schemaObjects.has(name))
  const postReady = Boolean(ticket)
  const distinctRoles = postReady
    ? Boolean(held('worker', worker) && held('executor', executor) && held('reconciler', reconciler)
      && new Set([worker.lease_key, executor.lease_key, reconciler.lease_key]).size === 3
      && new Set([worker.owner_id, executor.owner_id, reconciler.owner_id]).size === 3)
    : Boolean(roleKeys && new Set([roleKeys.worker, roleKeys.executor, roleKeys.reconciler]).size === 3)
  const rolesReady = postReady
    ? distinctRoles
    : acquirable(worker) && acquirable(executor) && acquirable(reconciler) && distinctRoles
  return {
    ruleCardsEnabled: cards.length > 0,
    bettingAccountAvailable: accounts.length > 0,
    capabilityExact: pure.capabilityExact,
    schemaCurrent: REAL_BETTING_SCHEMA_CONTRACT_VERSION === 2 && requiredTables.every((table) => tables.has(table))
      && schemaColumnsCurrent && schemaObjectsCurrent && foreignKeysEnabled && integrityCurrent,
    fenceFresh: rolesReady,
    executorLeaseFresh: postReady ? held('executor', executor) : acquirable(executor),
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
  if (current.requested && current.state === 'armed_waiting') {
    const reasonCode = preflight.ready ? 'preflight-required' : preflight.reasonCode
    if (current.reasonCode !== reasonCode) {
      return statusWithPreflight(
        update(db, { requested: true, state: 'armed_waiting', reasonCode }, at(options)),
        evidence,
      )
    }
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
  if (options.initialize === true && current.requested) {
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
    WHERE child.status = 'reserved'
      AND batch.status NOT IN ('completed','partial','failed','cancelled')
  `).all()
  for (const child of reserved) {
    const cancelled = db.prepare(`
      UPDATE bet_child_orders
      SET status = 'cancelled', error_code = 'real_betting_stopped', resolved_at = ?
      WHERE child_order_id = ? AND status = 'reserved'
    `).run(updatedAt, child.child_order_id)
    if (cancelled.changes !== 1) throw new Error('real-betting-stop-child-cas')
    db.prepare('DELETE FROM betting_account_locks WHERE child_order_id = ?').run(child.child_order_id)
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
