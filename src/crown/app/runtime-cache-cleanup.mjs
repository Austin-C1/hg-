import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openAppDatabase } from './app-db.mjs'

const CACHE_DIR_NAMES = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache'])
const RUNTIME_FILES = [
  'crown-odds-snapshots-v2.jsonl',
  'crown-odds-changes-v2.jsonl',
  'crown-odds-snapshots.jsonl',
  'crown-odds-changes.jsonl',
  'betting-candidates-v2.jsonl',
  'betting-candidates.jsonl',
  'crown-watch-runtime.jsonl',
  'betting-candidate-dry-run-audit.jsonl',
  'crown-dashboard-8787.log',
  'crown-odds-snapshots-v2.jsonl.audit-index.sqlite',
  'crown-odds-snapshots-v2.jsonl.audit-index.sqlite-wal',
  'crown-odds-snapshots-v2.jsonl.audit-index.sqlite-shm',
  'betting-candidates-v2.jsonl.candidate-index.sqlite',
  'betting-candidates-v2.jsonl.candidate-index.sqlite-wal',
  'betting-candidates-v2.jsonl.candidate-index.sqlite-shm',
]
const GENERATED_DIRS = [
  'data/crown-probe',
  'data/crown-probe-smoke',
  'data/runtime/login-diagnostics',
  'data/runtime/betting-intents',
  'data/runtime/crown-login-debug-profile',
  'data/runtime/crown-login-debug-profile-2',
  'data/runtime/crown-login-debug-profile-3',
  'data/runtime/crown-login-debug-profile-4',
  'data/runtime/crown-login-debug-profile-5',
  'output/playwright',
  'output/verification',
  'output/task11-review-v1-live',
  'output/runtime',
  'logs',
  '.playwright-cli',
]
const RESET_TABLES = [
  'bet_notification_outbox',
  'bet_reconciliation_evidence',
  'bet_reconciliation_state',
  'bet_submit_attempts',
  'execution_authorization_child_budgets',
  'betting_account_locks',
  'bet_child_orders',
  'bet_batches',
  'bet_market_once_claims',
  'execution_security_audit',
  'execution_authorizations',
  'betting_history',
  'auto_betting_signal_inbox',
  'monitor_candidates',
  'monitor_deliveries',
  'monitor_cooldowns',
  'monitor_audit_outbox',
  'monitor_signals',
  'monitor_selection_state',
  'monitor_event_state',
  'monitor_scope_state',
  'runtime_leases',
  'tracked_matches',
]

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function walkDirectories(root, visit) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (visit(file, entry.name) === false) continue
    walkDirectories(file, visit)
  }
}

function sizeOf(target) {
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    total += sizeOf(path.join(target, entry.name))
  }
  return total
}

function cleanupTargets({ workspaceDir = process.cwd(), runtimeDir = 'data/runtime' } = {}) {
  const root = path.resolve(workspaceDir)
  const runtime = path.resolve(root, runtimeDir)
  if (!inside(root, runtime)) throw new Error('runtime cache path is outside workspace')
  const targets = []
  const add = (candidate, category) => {
    const resolved = path.resolve(candidate)
    if (!inside(root, resolved)) throw new Error('runtime cache target is outside workspace')
    if (fs.existsSync(resolved)) targets.push({ path: resolved, category })
  }
  for (const name of RUNTIME_FILES) add(path.join(runtime, name), 'monitor-history')
  for (const relative of GENERATED_DIRS) add(path.join(root, relative), 'generated-output')
  add(path.join(root, 'frontend/tsconfig.tsbuildinfo'), 'generated-output')
  for (const name of ['crown-login-debug.png', 'crown-login-after-click.png', 'crown-login-after-no.png', 'crown-login-after-no-btn.png']) {
    add(path.join(root, 'output', name), 'generated-output')
  }
  walkDirectories(path.join(root, 'data'), (directory, name) => {
    if (!CACHE_DIR_NAMES.has(name)) return true
    add(directory, 'browser-cache')
    return false
  })
  const sorted = targets.sort((left, right) => left.path.length - right.path.length)
  return sorted.filter((item, index) => !sorted.slice(0, index).some((parent) => inside(parent.path, item.path)))
}

function databaseHistoryCounts(dbPath) {
  const empty = Object.fromEntries(RESET_TABLES.map((table) => [table, 0]))
  if (!fs.existsSync(dbPath)) return empty
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name))
    return Object.fromEntries(RESET_TABLES.map((table) => [
      table,
      tables.has(table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count || 0) : 0,
    ]))
  } finally {
    db.close()
  }
}

export function previewRuntimeCleanup(options = {}) {
  const root = path.resolve(options.workspaceDir || process.cwd())
  const dbPath = path.resolve(root, options.dbPath || 'storage/crown.sqlite')
  if (!inside(root, dbPath)) throw new Error('app database is outside workspace')
  const targets = cleanupTargets(options)
  const categories = {}
  let bytes = 0
  let files = 0
  for (const target of targets) {
    const targetBytes = sizeOf(target.path)
    bytes += targetBytes
    const stat = fs.lstatSync(target.path)
    const targetFiles = stat.isDirectory() ? countFiles(target.path) : 1
    files += targetFiles
    categories[target.category] = (categories[target.category] || 0) + targetBytes
  }
  const databaseRows = databaseHistoryCounts(dbPath)
  const records = Object.values(databaseRows).reduce((sum, count) => sum + count, 0)
  return { bytes, files, records, categories, databaseRows }
}

function countFiles(target) {
  let count = 0
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const file = path.join(target, entry.name)
    count += entry.isDirectory() ? countFiles(file) : 1
  }
  return count
}

function resetRuntimeDatabase(dbPath) {
  const resolved = path.resolve(dbPath)
  if (!fs.existsSync(resolved)) throw new Error('app database does not exist')
  const db = new DatabaseSync(resolved)
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name))
    const before = databaseHistoryCounts(resolved)
    let accountsPaused = 0
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DROP TRIGGER IF EXISTS bet_submit_attempts_immutable_delete')
      db.exec('DROP TRIGGER IF EXISTS bet_reconciliation_evidence_immutable_delete')
      db.exec('DROP TRIGGER IF EXISTS auto_betting_signal_inbox_append_only_delete')
      for (const table of RESET_TABLES) if (tables.has(table)) db.exec(`DELETE FROM "${table}"`)
      if (tables.has('real_betting_runtime')) {
        db.exec("UPDATE real_betting_runtime SET requested=0, runtime_state='off', reason_code='', updated_at='' WHERE singleton_id=1")
      }
      if (tables.has('betting_accounts')) {
        accountsPaused = Number(db.prepare(`UPDATE betting_accounts
          SET allocation_status='paused', execution_status='idle'
          WHERE archived=0 AND allocation_status <> 'paused'`).run().changes || 0)
      }
      if (tables.has('monitor_accounts')) {
        db.exec(`UPDATE monitor_accounts SET
          login_status='未启动', current_monitor_status='未启动', last_login_at='', last_online_check_at='',
          last_xml_response_at='', last_odds_parsed_at='', consecutive_failures=0, auto_relogin_count=0,
          last_login_result_json='{}', last_login_result_at='', last_login_diagnostics_path=''`)
      }
      db.exec('COMMIT')
      db.exec('PRAGMA foreign_keys = ON')
      return { databaseRows: before, accountsPaused }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

function configuredMonitorAccount(dbPath) {
  if (!fs.existsSync(dbPath)) return false
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='monitor_accounts'").get()
    if (!table) return false
    return Boolean(db.prepare(`SELECT 1 AS configured FROM monitor_accounts
      WHERE enabled=1 AND trim(secret_ciphertext) <> '' ORDER BY updated_at DESC LIMIT 1`).get())
  } finally {
    db.close()
  }
}

function hasActiveWatcherLease(dbPath, now = new Date().toISOString()) {
  if (!fs.existsSync(dbPath)) return false
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='runtime_leases'").get()
    if (!table) return false
    return Boolean(db.prepare("SELECT 1 AS active FROM runtime_leases WHERE lease_key LIKE 'watcher:%' AND expires_at > ? LIMIT 1").get(now))
  } finally {
    db.close()
  }
}

export async function runRuntimeCleanup({
  workspaceDir = process.cwd(),
  runtimeDir = 'data/runtime',
  dbPath = 'storage/crown.sqlite',
  monitorProcess = null,
  bettingProcess = null,
} = {}) {
  const root = path.resolve(workspaceDir)
  const resolvedDbPath = path.resolve(root, dbPath)
  if (!inside(root, resolvedDbPath)) throw new Error('app database is outside workspace')
  const wasRunning = Boolean(monitorProcess?.isRunning?.())
  const bettingWasRunning = Boolean(bettingProcess?.isRunning?.())
  if (!wasRunning && hasActiveWatcherLease(resolvedDbPath)) throw new Error('watcher-active-unmanaged')
  if (wasRunning && typeof monitorProcess?.stopAndWait !== 'function') throw new Error('watcher cannot be stopped safely')
  if (bettingWasRunning) await bettingProcess.stop()
  if (wasRunning) await monitorProcess.stopAndWait()
  let result
  let shouldStartMonitor = wasRunning
  let monitorStartReason = wasRunning ? 'restore-running-watcher' : 'not-configured'
  try {
    const preview = previewRuntimeCleanup({ workspaceDir: root, runtimeDir, dbPath: resolvedDbPath })
    for (const target of cleanupTargets({ workspaceDir: root, runtimeDir }).sort((left, right) => right.path.length - left.path.length)) {
      fs.rmSync(target.path, { recursive: true, force: true })
    }
    const reset = resetRuntimeDatabase(resolvedDbPath)
    const reopened = openAppDatabase({ dbPath: resolvedDbPath })
    reopened.close()
    if (configuredMonitorAccount(resolvedDbPath)) {
      shouldStartMonitor = true
      monitorStartReason = 'enabled-configured-account'
    }
    result = {
      ...preview,
      databaseRows: reset.databaseRows,
      accountsPaused: reset.accountsPaused,
      restartedWatcher: false,
      monitorStartReason,
      bettingStopped: bettingWasRunning,
      cleanedAt: new Date().toISOString(),
    }
  } finally {
    if (shouldStartMonitor) monitorProcess.start({ dbPath: resolvedDbPath, runtimeDir: path.resolve(root, runtimeDir) })
  }
  if (shouldStartMonitor) result.restartedWatcher = true
  return result
}
