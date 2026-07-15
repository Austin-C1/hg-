#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { bettingRoleLeaseKeys } from '../src/crown/app/betting-process.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import { watcherLeaseKey } from '../src/crown/app/watcher-lease-key.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dashboardEntry = path.resolve(projectRoot, 'scripts/crown-dashboard.mjs')
const watcherEntry = path.resolve(projectRoot, 'scripts/crown-watch.mjs')
const workerEntry = path.resolve(projectRoot, 'scripts/crown-betting-worker.mjs')
const operationsSummaryPath = '/api/app/operations-summary'
const syntheticOrigin = 'https://runtime-health.crown-audit.net'
const processQueryTimeoutMs = 10_000

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function boundedText(value, maximum = 8_192) {
  const text = String(value || '')
  return Buffer.byteLength(text) <= maximum ? text : Buffer.from(text).subarray(-maximum).toString('utf8')
}

function parseViewport(value, label) {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(value || '')
  if (!match) throw new Error(`runtime-health-${label}-viewport-invalid`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error(`runtime-health-${label}-viewport-invalid`)
  }
  return { width, height }
}

function parseArgs(argv) {
  const options = { fixture: false, desktop: null, mobile: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--fixture') options.fixture = true
    else if (argument === '--desktop') options.desktop = parseViewport(argv[++index], 'desktop')
    else if (argument === '--mobile') options.mobile = parseViewport(argv[++index], 'mobile')
    else throw new Error('runtime-health-arguments-invalid')
  }
  if (!options.fixture) throw new Error('runtime-health-fixture-required')
  if (!options.desktop || !options.mobile) throw new Error('runtime-health-viewports-required')
  return options
}

function readLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'release', 'windows-runtime-lock.json'), 'utf8'))
    const playwrightPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules', 'playwright', 'package.json'), 'utf8'))
    if (lock?.platform !== 'win32' || lock?.arch !== 'x64' || !lock?.chromium?.browserVersion) throw new Error()
    if (playwrightPackage.version !== lock.chromium.playwrightVersion) throw new Error()
    return lock
  } catch {
    throw new Error('runtime-health-lock-invalid')
  }
}

export function chromiumExecutable({ env = process.env, exists = fs.existsSync } = {}) {
  const executable = env.CROWN_CHROMIUM_EXECUTABLE_PATH?.trim()
  if (!executable) throw new Error('runtime-health-chromium-required')
  if (path.basename(executable).toLowerCase() !== 'chrome.exe' || !exists(executable)) {
    throw new Error('runtime-health-chromium-invalid')
  }
  return path.resolve(executable)
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function runtimePaths(stateRoot, marker) {
  return {
    stateRoot,
    storageDir: path.join(stateRoot, 'storage'),
    dbPath: path.join(stateRoot, 'storage', 'crown.sqlite'),
    secretKeyPath: path.join(stateRoot, 'storage', 'crown-local-secret.key'),
    configDir: path.join(stateRoot, 'config'),
    runtimeDir: path.join(stateRoot, 'runtime'),
    browserProfilesDir: path.join(stateRoot, 'runtime', 'browser-profiles'),
    auditProfileDir: path.join(stateRoot, `chromium-profile-${marker}`),
    networkBootstrapPath: path.join(stateRoot, 'network-bootstrap.mjs'),
    networkLogPath: path.join(stateRoot, 'network-decisions.log'),
  }
}

function seedIsolatedRuntime(paths) {
  for (const directory of [paths.storageDir, paths.configDir, paths.runtimeDir, paths.browserProfilesDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  const defaultLeagues = {
    version: 1,
    leagues: [{ name: 'Audit League', aliases: [], enabled: true, autoTrack: true, modes: ['prematch', 'live'] }],
  }
  writeJson(path.join(paths.configDir, 'default-leagues.json'), defaultLeagues)
  writeJson(path.join(paths.configDir, 'monitored-leagues.json'), {
    enabled: true,
    defaultAction: 'ignore',
    include: [{ name: 'Audit League', aliases: [], match: 'exact' }],
    exclude: [],
  })
  writeJson(path.join(paths.configDir, 'monitor-settings.json'), {
    version: 2,
    prematch: {
      enabled: true, minOdds: 0, maxOdds: 2, waterMoveThreshold: 0.01,
      waterMoveDirection: 'both', cooldownSeconds: 60, remark: '',
      startMinutesBeforeKickoff: 999, stopMinutesBeforeKickoff: 0,
    },
    live: {
      enabled: true, minOdds: 0, maxOdds: 2, waterMoveThreshold: 0.01,
      waterMoveDirection: 'both', cooldownSeconds: 60, remark: '',
      liveMinuteFrom: 0, liveMinuteTo: 120, includeFirstHalf: true,
      includeHalfTime: true, includeSecondHalf: true,
    },
  })
  writeJson(path.join(paths.configDir, 'telegram-settings.json'), {
    version: 1,
    oddsAlert: { enabled: false, botToken: '', chatIds: [] },
    betSuccess: { enabled: false, botToken: '', chatIds: [] },
  })
  writeJson(path.join(paths.configDir, 'alerts.json'), {
    console: { enabled: false },
    telegram: { enabled: false, botTokenEnv: '', chatIdEnv: '' },
  })

  const secretEnv = {
    ...process.env,
    CROWN_SECRET_KEY: '',
    CROWN_SECRET_KEY_FILE: '',
    CROWN_LOCAL_SECRET_KEY_PATH: paths.secretKeyPath,
  }
  const secretKey = readOrCreateLocalSecretKey({ env: secretEnv, cwd: projectRoot, keyPath: paths.secretKeyPath })
  const handle = openAppDatabase({ dbPath: paths.dbPath, env: secretEnv, monitorJson: null })
  try {
    const repo = createAppRepository(handle.db, {
      secretKey,
      env: secretEnv,
      dbPath: paths.dbPath,
      runtimeDir: paths.runtimeDir,
      cwd: projectRoot,
    })
    const now = new Date().toISOString()
    const monitor = repo.savePrimaryMonitorAccount({
      label: 'Runtime health monitor',
      username: 'audit-monitor',
      loginUrl: syntheticOrigin,
      enabled: true,
      secret: 'audit-monitor-password',
      oddsScanIntervalSeconds: 1,
      maxAutoReloginCount: 1,
      notes: '',
    })
    handle.db.prepare(`
      UPDATE monitor_accounts
      SET last_odds_parsed_at=?, last_xml_response_at=?, last_online_check_at=?,
          login_status='已登录', current_monitor_status='正在监控赔率'
      WHERE id=?
    `).run(now, now, now, monitor.id)
    handle.db.prepare(`
      UPDATE monitor_alert_settings
      SET enabled=1, asian_handicap_enabled=1, total_enabled=1,
          migration_review_required=0, migration_review_reason='', updated_at=?
      WHERE mode IN ('prematch','live')
    `).run(now)
    handle.db.prepare(`
      INSERT INTO monitor_event_state (
        event_key,match_group_key,active,missing_count,last_seen_at,provider_ids_json,event_json
      ) VALUES ('crown|runtime-health|audit','crown|runtime-health|audit',1,0,?,'{}',?)
    `).run(now, JSON.stringify({
      eventKey: 'crown|runtime-health|audit',
      league: 'Audit League',
      mode: 'prematch',
      startTimeUtc: now,
    }))
    repo.createAutoBettingRuleCard({
      name: 'Runtime health rule',
      enabled: true,
      leagueNames: ['Audit League'],
      targetOddsMin: '0.80',
      targetOddsMax: '1.10',
      targetAmountMinor: 50,
      remark: '',
    }, { defaultLeagues })
    const bettingAccount = repo.createBettingAccount({
      label: 'audit-betting',
      username: 'audit-betting',
      websiteUrl: syntheticOrigin,
      secret: 'audit-betting-password',
      status: 'enabled',
      betOrder: 1,
      perBetLimit: '50',
      currency: 'CNY',
      notes: '',
    })
    handle.db.prepare(`
      UPDATE betting_accounts
      SET allocation_status='enabled', access_status='available', access_checked_at=?,
          access_error_code='', reported_balance='1000', reported_currency='CNY',
          reported_balance_updated_at=?
      WHERE id=?
    `).run(now, now, bettingAccount.id)
    for (const table of [
      'crown_browser_acceptance_campaigns', 'auto_betting_signal_inbox', 'bet_batches',
      'bet_submit_attempts', 'bet_reconciliation_state', 'betting_account_locks',
    ]) {
      if (Number(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) !== 0) {
        throw new Error('runtime-health-seed-not-empty')
      }
    }
    return { bettingAccountId: bettingAccount.id, bettingUsername: bettingAccount.username }
  } finally {
    handle.close()
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 64 * 1024) {
        reject(new Error('runtime-health-fixture-request-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function startLoopbackProtocolFixture() {
  const state = { chkLogin: 0, getGameList: 0, unexpected: 0 }
  const server = http.createServer((request, response) => {
    ;(async () => {
      if (request.method !== 'POST') {
        state.unexpected += 1
        response.writeHead(404).end()
        return
      }
      const form = new URLSearchParams(await readRequestBody(request))
      const operation = form.get('p') || ''
      response.setHeader('content-type', 'application/xml; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      if (request.url === '/transform_nl.php' && operation === 'chk_login') {
        state.chkLogin += 1
        response.writeHead(200).end('<serverresponse><status>200</status><uid>audit-uid</uid><ver>runtime-health-v1</ver></serverresponse>')
        return
      }
      if (request.url === '/transform.php' && operation === 'get_game_list') {
        state.getGameList += 1
        response.writeHead(200).end('<serverresponse><system_time>2026-07-15 00:00:00</system_time></serverresponse>')
        return
      }
      state.unexpected += 1
      response.writeHead(404).end('<serverresponse><status>404</status></serverresponse>')
    })().catch(() => {
      state.unexpected += 1
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    server,
    state,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

export function networkBootstrapSource() {
  return `import fs from 'node:fs'

const syntheticOrigin = new URL(process.env.CROWN_RUNTIME_HEALTH_SYNTHETIC_ORIGIN || '').origin
const fixtureOrigin = new URL(process.env.CROWN_RUNTIME_HEALTH_FIXTURE_ORIGIN || '').origin
const decisionLog = process.env.CROWN_RUNTIME_HEALTH_NETWORK_LOG || ''
if (!decisionLog || syntheticOrigin !== 'https://runtime-health.crown-audit.net' || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(fixtureOrigin)) {
  throw new Error('runtime-health-network-bootstrap-invalid')
}
const originalFetch = globalThis.fetch.bind(globalThis)
const knownOperations = new Set(['chk_login', 'get_game_list', 'FT_order_view', 'FT_bet', 'get_today_wagers'])
const record = value => fs.appendFileSync(decisionLog, value + '\\n', 'utf8')
const operationFrom = options => {
  const body = options?.body
  let form = null
  if (typeof body === 'string') form = new URLSearchParams(body)
  else if (body instanceof URLSearchParams) form = body
  const operation = form?.get('p') || ''
  return knownOperations.has(operation) ? operation : 'OTHER'
}
globalThis.fetch = async (input, options = {}) => {
  const source = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (source.origin === syntheticOrigin) {
    const operation = operationFrom(options)
    record('ALLOW:' + operation)
    const target = new URL(source.pathname + source.search, fixtureOrigin)
    return originalFetch(target, { ...options, redirect: 'manual' })
  }
  if (source.origin === fixtureOrigin) return originalFetch(input, options)
  if (source.protocol === 'http:' || source.protocol === 'https:') {
    record('DENY')
    throw new Error('runtime-health-network-blocked')
  }
  record('DENY')
  throw new Error('runtime-health-network-blocked')
}
`
}

export function isolatedChildBaseEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const normalized = key.toUpperCase()
    return normalized !== 'NODE_OPTIONS' && !normalized.startsWith('CROWN_')
  }))
}

function dashboardEnvironment(paths, fixtureOrigin, executablePath) {
  fs.writeFileSync(paths.networkBootstrapPath, networkBootstrapSource(), 'utf8')
  fs.writeFileSync(paths.networkLogPath, '', 'utf8')
  return {
    ...isolatedChildBaseEnvironment(),
    NODE_OPTIONS: `--import=${pathToFileURL(paths.networkBootstrapPath).href}`,
    CROWN_PORTABLE: '0',
    CROWN_APP_DIR: projectRoot,
    CROWN_APP_ROOT: projectRoot,
    CROWN_DATA_ROOT: paths.stateRoot,
    CROWN_DB_PATH: paths.dbPath,
    CROWN_RUNTIME_DIR: paths.runtimeDir,
    CROWN_BROWSER_PROFILE_DIR: paths.browserProfilesDir,
    CROWN_CONFIG_DIR: paths.configDir,
    CROWN_LOCAL_SECRET_KEY_PATH: paths.secretKeyPath,
    CROWN_SECRET_KEY: '',
    CROWN_SECRET_KEY_FILE: '',
    CROWN_STATIC_DIR: path.join(projectRoot, 'frontend', 'dist'),
    CROWN_NODE_EXECUTABLE_PATH: process.execPath,
    CROWN_CHROMIUM_EXECUTABLE_PATH: executablePath,
    CROWN_DASHBOARD_HOST: '127.0.0.1',
    CROWN_DASHBOARD_PORT: '0',
    CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
    CROWN_DASHBOARD_SESSION_KEY: '',
    CROWN_DASHBOARD_ALLOWED_HOSTS: '',
    CROWN_DASHBOARD_ALLOWED_ORIGINS: '',
    CROWN_ALLOW_FIXTURE_FALLBACK: '0',
    CROWN_BETTING_ALLOWED_ORIGINS: syntheticOrigin,
    CROWN_RUNTIME_HEALTH_SYNTHETIC_ORIGIN: syntheticOrigin,
    CROWN_RUNTIME_HEALTH_FIXTURE_ORIGIN: fixtureOrigin,
    CROWN_RUNTIME_HEALTH_NETWORK_LOG: paths.networkLogPath,
  }
}

async function startDashboardEntry(env) {
  const child = spawn(process.execPath, [dashboardEntry], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = boundedText(stdout + chunk) })
  child.stderr.on('data', chunk => { stderr = boundedText(stderr + chunk) })
  try {
    const ready = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('exit', onExit)
        child.stdout.off('data', onReady)
        error ? reject(error) : resolve(value)
      }
      const onReady = () => {
        const match = /Crown dashboard listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
        if (match) finish(null, Number(match[1]))
      }
      const onExit = () => finish(new Error('runtime-health-dashboard-start-failed'))
      child.stdout.on('data', onReady)
      child.once('exit', onExit)
      const timer = setTimeout(() => finish(new Error('runtime-health-dashboard-start-failed')), 20_000)
      onReady()
    })
    return { child, port: ready, origin: `http://127.0.0.1:${ready}`, stderr: () => stderr }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL')
    throw error
  }
}

async function stopDashboardEntry(entry) {
  if (!entry?.child || entry.child.exitCode !== null) return true
  const child = entry.child
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  let timer
  const completed = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 25_000) }),
  ])
  clearTimeout(timer)
  if (completed) return true
  const forcedExit = once(child, 'exit')
  child.kill('SIGKILL')
  await Promise.race([forcedExit, delay(5_000)])
  throw new Error('runtime-health-dashboard-cleanup-failed')
}

async function jsonRequest(url, options = {}) {
  let response
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) })
  } catch {
    throw new Error('runtime-health-dashboard-request-failed')
  }
  let payload
  try { payload = await response.json() } catch { throw new Error('runtime-health-dashboard-response-invalid') }
  if (!response.ok) throw new Error('runtime-health-dashboard-request-failed')
  return payload
}

async function readSecurityContext(origin) {
  const payload = await jsonRequest(`${origin}/api/app/security-context`)
  if (payload?.dashboardAccessMode !== 'local-trust' || typeof payload.csrfToken !== 'string' || !payload.csrfToken) {
    throw new Error('runtime-health-dashboard-security-invalid')
  }
  return payload
}

async function readOperationsSummary(origin) {
  const payload = await jsonRequest(`${origin}${operationsSummaryPath}`)
  if (!payload?.item || typeof payload.item !== 'object') throw new Error('runtime-health-operations-summary-invalid')
  return payload.item
}

async function postOperation(origin, pathname, body, csrfToken) {
  return jsonRequest(`${origin}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body || {}),
  })
}

async function waitUntil(read, accept, errorCode, { timeoutMs = 30_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() <= deadline) {
    try {
      last = await read()
      if (accept(last)) return last
    } catch {}
    await delay(pollMs)
  }
  throw new Error(errorCode)
}

function ledgerCheckError() {
  return new Error('runtime-health-ledger-check-failed')
}

export function readRuntimeLeases(dbPath) {
  if (!fs.existsSync(dbPath)) throw ledgerCheckError()
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db.prepare(`
      SELECT lease_key,owner_id,pid,acquired_at,heartbeat_at,expires_at,fencing_token
      FROM runtime_leases ORDER BY lease_key
    `).all().map(row => ({
      leaseKey: row.lease_key,
      ownerId: row.owner_id,
      pid: Number(row.pid),
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      fencingToken: Number(row.fencing_token),
    }))
  } catch (error) {
    if (error?.message === 'runtime-health-ledger-check-failed') throw error
    throw ledgerCheckError()
  } finally {
    db?.close()
  }
}

export function readAccountLockCount(dbPath) {
  if (!fs.existsSync(dbPath)) throw ledgerCheckError()
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return Number(db.prepare('SELECT COUNT(*) AS count FROM betting_account_locks').get().count)
  } catch (error) {
    if (error?.message === 'runtime-health-ledger-check-failed') throw error
    throw ledgerCheckError()
  } finally {
    db?.close()
  }
}

function leaseActive(row, now = Date.now()) {
  return Boolean(row && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > now)
}

function activeLeases(dbPath) {
  const now = Date.now()
  return readRuntimeLeases(dbPath).filter(row => leaseActive(row, now))
}

function roleLeaseSet(rows, keys) {
  const now = Date.now()
  const found = Object.fromEntries(Object.entries(keys).map(([role, key]) => [
    role,
    rows.find(row => row.leaseKey === key && leaseActive(row, now)) || null,
  ]))
  return found
}

function verifyRoleLeases(roles) {
  const rows = Object.values(roles)
  const now = Date.now()
  const uniqueOwners = rows.length === 3 && rows.every(Boolean) && new Set(rows.map(row => row.ownerId)).size === 3
  const heartbeatsFresh = rows.every(row => {
    const heartbeat = Date.parse(row?.heartbeatAt || '')
    return Number.isSafeInteger(row?.pid) && row.pid > 0 && Number.isFinite(heartbeat)
      && now - heartbeat >= 0 && now - heartbeat <= 5_000 && leaseActive(row, now)
  })
  if (!uniqueOwners || !heartbeatsFresh) throw new Error('runtime-health-worker-leases-invalid')
  return { uniqueOwners, heartbeatsFresh }
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = boundedText(stdout + chunk, 4 * 1024 * 1024) })
    child.stderr.on('data', chunk => { stderr = boundedText(stderr + chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

export async function windowsProcessSnapshot({ pids = [], executablePath = '', marker = '' } = {}) {
  if (process.platform !== 'win32') throw new Error('runtime-health-process-query-unsupported')
  const query = `$ErrorActionPreference='Stop'
$ids=@(); if($env:CROWN_RUNTIME_HEALTH_PIDS){$ids=@($env:CROWN_RUNTIME_HEALTH_PIDS.Split(',') | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ })}
$exe=$env:CROWN_RUNTIME_HEALTH_EXECUTABLE
$marker=$env:CROWN_RUNTIME_HEALTH_MARKER
$rows=@(Get-CimInstance Win32_Process | Where-Object {
  ($ids.Count -gt 0 -and $ids -contains [int]$_.ProcessId) -or
  ($exe -and $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath),[IO.Path]::GetFullPath($exe),[StringComparison]::OrdinalIgnoreCase)) -or
  ($marker -and [string]$_.CommandLine -like ('*'+$marker+'*'))
} | ForEach-Object {
  $created=''; if($_.CreationDate){$created=$_.CreationDate.ToUniversalTime().ToString('o')}
  [pscustomobject]@{pid=[int]$_.ProcessId;parentProcessId=[int]$_.ParentProcessId;executablePath=[string]$_.ExecutablePath;creationDate=$created;commandLine=[string]$_.CommandLine}
})
[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress -Depth 3))`
  const result = await Promise.race([
    spawnCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      env: {
        ...process.env,
        CROWN_RUNTIME_HEALTH_PIDS: [...new Set(pids)].join(','),
        CROWN_RUNTIME_HEALTH_EXECUTABLE: executablePath,
        CROWN_RUNTIME_HEALTH_MARKER: marker,
      },
    }),
    delay(processQueryTimeoutMs).then(() => ({ code: -1, stdout: '', stderr: '' })),
  ])
  if (result.code !== 0) throw new Error('runtime-health-process-query-failed')
  try {
    const rows = JSON.parse(result.stdout || '[]')
    if (!Array.isArray(rows)) throw new Error()
    return rows.map(row => ({
      pid: Number(row.pid),
      parentProcessId: Number(row.parentProcessId),
      executablePath: String(row.executablePath || ''),
      creationDate: String(row.creationDate || ''),
      commandLine: String(row.commandLine || ''),
    }))
  } catch {
    throw new Error('runtime-health-process-query-failed')
  }
}

function samePath(left, right) {
  const normalized = value => path.resolve(String(value || '')).toLowerCase()
  return Boolean(left && right && normalized(left) === normalized(right))
}

function processIdentity(row) {
  return `${row.pid}|${row.creationDate}|${path.resolve(row.executablePath).toLowerCase()}`
}

export function captureOwnedChromiumTree(snapshot, { marker, executablePath, previous = [] } = {}) {
  const exact = snapshot.filter(row => samePath(row.executablePath, executablePath))
  const candidates = exact.filter(row => row.commandLine.includes(marker))
  const candidatePids = new Set(candidates.map(row => row.pid))
  const roots = candidates.filter(row => !candidatePids.has(row.parentProcessId))
  if (roots.length !== 1) throw new Error('runtime-health-chromium-ownership-invalid')
  const ownedPids = new Set([roots[0].pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of exact) {
      if (!ownedPids.has(row.pid) && ownedPids.has(row.parentProcessId)) {
        ownedPids.add(row.pid)
        changed = true
      }
    }
  }
  const merged = new Map(previous.map(row => [processIdentity(row), row]))
  for (const row of exact.filter(item => ownedPids.has(item.pid))) merged.set(processIdentity(row), row)
  return [...merged.values()].sort((left, right) => left.pid - right.pid)
}

export async function waitForOwnedChromiumExit({
  ownedProcesses,
  executablePath = '',
  snapshot = () => windowsProcessSnapshot({ executablePath }),
  timeoutMs = 10_000,
  pollMs = 100,
} = {}) {
  const identities = new Set((ownedProcesses || []).map(processIdentity))
  const deadline = Date.now() + timeoutMs
  while (true) {
    let rows
    try { rows = await snapshot() } catch { throw new Error('runtime-health-process-query-failed') }
    const remaining = rows.filter(row => identities.has(processIdentity(row)))
    if (!remaining.length || Date.now() >= deadline) return remaining
    await delay(pollMs)
  }
}

function commandHasEntry(row, entry) {
  const command = String(row?.commandLine || '').replaceAll('/', '\\').toLowerCase()
  return command.includes(path.resolve(entry).replaceAll('/', '\\').toLowerCase())
}

async function assertActualEntryProcesses({ dashboardPid, watcherLease, bettingLeases }) {
  const pids = [dashboardPid, watcherLease.pid, ...Object.values(bettingLeases).map(row => row.pid)]
  const rows = await windowsProcessSnapshot({ pids })
  const byPid = new Map(rows.map(row => [row.pid, row]))
  if (!commandHasEntry(byPid.get(dashboardPid), dashboardEntry)) throw new Error('runtime-health-dashboard-process-invalid')
  if (!commandHasEntry(byPid.get(watcherLease.pid), watcherEntry)) throw new Error('runtime-health-watcher-process-invalid')
  if (!Object.values(bettingLeases).every(lease => commandHasEntry(byPid.get(lease.pid), workerEntry))) {
    throw new Error('runtime-health-worker-process-invalid')
  }
  return true
}

export function projectOperationsSummary(summary = {}) {
  const directions = Array.isArray(summary.browserBetting?.directions) ? summary.browserBetting.directions : []
  const count = directions.filter(row => row?.previewAllowed === true
    && row?.submitAllowed === true && row?.reconciliationAllowed === true).length
  const campaignUnknown = summary.browserBetting?.campaign === null
    ? 0
    : summary.browserBetting?.campaign?.unknownCount
  const unknownSources = [
    summary.batches?.unknownAmountMinor,
    summary.accounts?.unknown,
    summary.reconciliation?.open,
    campaignUnknown,
  ]
  const unknownCount = unknownSources.every(value => Number.isSafeInteger(value) && value >= 0)
    ? unknownSources.reduce((total, value) => total + value, 0)
    : -1
  return {
    transportReady: summary.browserBetting?.transportKind === 'browser-page-fetch',
    capabilityReadyCount: count,
    unknownCount,
  }
}

export function operationsMonitorModesReady(summary = {}) {
  return ['prematch', 'live'].every(mode => {
    const setting = summary.monitorAlerts?.[mode]
    return setting?.enabled === true
      && setting.reviewRequired === false
      && (setting.markets?.asianHandicap === true || setting.markets?.total === true)
  })
}

function installPageObservers(page, consoleErrors) {
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.type())
  })
  page.on('pageerror', () => consoleErrors.push('pageerror'))
  page.on('response', response => {
    if (response.status() >= 500) consoleErrors.push('http-5xx')
  })
}

async function pageHasNoOverflow(page, expectedWidth) {
  return page.evaluate(width => document.documentElement.scrollWidth <= width && document.body.scrollWidth <= width, expectedWidth)
}

async function inspectActualFrontend(page, origin, viewport, bettingUsername) {
  await page.setViewportSize(viewport)
  const routes = [
    { pathname: '/operations', heading: '运行控制台' },
    { pathname: '/matches', heading: '比赛选择' },
    { pathname: '/betting-rules', heading: '投注规则' },
    { pathname: '/betting-accounts', heading: '投注账号配置' },
  ]
  let ok = true
  for (const route of routes) {
    await page.goto(`${origin}${route.pathname}`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: route.heading, level: 1 }).waitFor({ timeout: 15_000 })
    await page.waitForTimeout(200)
    ok &&= await pageHasNoOverflow(page, viewport.width)
    if (route.pathname === '/operations') {
      ok &&= await page.evaluate(() => {
        const matrix = document.querySelector('[aria-label="八方向能力矩阵"]')
        const text = document.body.textContent || ''
        return matrix?.querySelectorAll(':scope > li').length === 8
          && text.includes('browser-page-fetch')
          && Boolean(document.querySelector('[aria-label="风险状态"]'))
          && Boolean(document.querySelector('[aria-label="最近投注批次"]'))
      })
    }
    if (route.pathname === '/betting-accounts') {
      ok &&= await page.evaluate(username => {
        const text = document.body.textContent || ''
        return text.includes(username) && [...document.querySelectorAll('button')].some(button => button.textContent?.includes('人工登录'))
      }, bettingUsername)
    }
  }
  return ok
}

async function clickConfirm(page, buttonName, confirmName) {
  await page.getByRole('button', { name: buttonName }).click()
  const confirm = page.getByRole('button', { name: confirmName }).last()
  await confirm.waitFor({ state: 'visible', timeout: 10_000 })
  await confirm.click()
}

async function waitForChromiumOwnership(executablePath, marker) {
  const deadline = Date.now() + 10_000
  let lastError
  while (Date.now() <= deadline) {
    const rows = await windowsProcessSnapshot({ executablePath, marker })
    try { return captureOwnedChromiumTree(rows, { marker, executablePath }) }
    catch (error) { lastError = error }
    await delay(100)
  }
  throw lastError || new Error('runtime-health-chromium-ownership-invalid')
}

function networkDecisionCounts(file) {
  const values = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : []
  const count = label => values.filter(value => value === label).length
  return {
    denied: count('DENY'),
    chkLogin: count('ALLOW:chk_login'),
    getGameList: count('ALLOW:get_game_list'),
    preview: count('ALLOW:FT_order_view'),
    submit: count('ALLOW:FT_bet'),
    wagers: count('ALLOW:get_today_wagers'),
    other: count('ALLOW:OTHER'),
  }
}

async function stopOperationsIfPossible(entry, dbPath) {
  if (!entry?.origin || entry.child.exitCode !== null) return
  try {
    const security = await readSecurityContext(entry.origin)
    await postOperation(entry.origin, '/api/app/real-betting/stop', {}, security.csrfToken).catch(() => {})
    await postOperation(entry.origin, '/api/app/monitor-account/actions', { action: 'stop' }, security.csrfToken).catch(() => {})
  } catch {}
  if (!dbPath) return
  await waitUntil(
    () => activeLeases(dbPath),
    rows => rows.length === 0,
    'runtime-health-ledger-cleanup-timeout',
    { timeoutMs: 20_000 },
  ).catch(() => {})
}

export async function runAudit(argv) {
  const options = parseArgs(argv)
  const lock = readLock()
  const executablePath = chromiumExecutable()
  const staticIndex = path.join(projectRoot, 'frontend', 'dist', 'index.html')
  if (!fs.existsSync(staticIndex)) throw new Error('runtime-health-frontend-required')
  if (process.platform !== 'win32') throw new Error('runtime-health-windows-required')

  const marker = randomUUID()
  const tempParent = path.resolve(process.env.CROWN_RUNTIME_HEALTH_TEMP_PARENT || os.tmpdir())
  fs.mkdirSync(tempParent, { recursive: true })
  const stateRoot = path.join(tempParent, `crown-runtime-health-${marker}`)
  fs.mkdirSync(stateRoot)
  const paths = runtimePaths(stateRoot, marker)
  const consoleErrors = []
  const allowedDashboardOrigins = new Set()
  let browserNetworkDenials = 0
  let protocolFixture = null
  let context = null
  let page = null
  let dashboard = null
  let secondDashboard = null
  let dashboardEnv = null
  let ownedChromium = []
  let runError = null
  let cleanupError = null
  let observedWatcherLease = null
  let observedBettingLeases = null
  let observedLeaseQuality = { uniqueOwners: false, heartbeatsFresh: false }
  let projection = { transportReady: false, capabilityReadyCount: 0, unknownCount: 0 }
  let monitorModesReady = false
  let desktopOk = false
  let mobileOk = false
  let orphanChromiumCount = 0
  let orphanLeaseCount = 0
  let orphanAccountLockCount = 0

  try {
    const seeded = seedIsolatedRuntime(paths)
    protocolFixture = await startLoopbackProtocolFixture()
    dashboardEnv = dashboardEnvironment(paths, protocolFixture.origin, executablePath)
    dashboard = await startDashboardEntry(dashboardEnv)
    allowedDashboardOrigins.add(dashboard.origin)

    context = await chromium.launchPersistentContext(paths.auditProfileDir, {
      executablePath,
      headless: true,
      serviceWorkers: 'block',
      viewport: options.desktop,
      args: [
        `--crown-runtime-health-owner=${marker}`,
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    })
    const actualVersion = context.browser()?.version()
    if (actualVersion !== lock.chromium.browserVersion) throw new Error('runtime-health-chromium-version-mismatch')
    ownedChromium = await waitForChromiumOwnership(executablePath, marker)
    await context.route('**/*', route => {
      let target
      try { target = new URL(route.request().url()) } catch { target = null }
      if (target?.protocol === 'http:' && allowedDashboardOrigins.has(target.origin)) return route.continue()
      browserNetworkDenials += 1
      return route.abort('blockedbyclient')
    })
    page = context.pages()[0] || await context.newPage()
    installPageObservers(page, consoleErrors)
    await page.goto(`${dashboard.origin}/operations`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '运行控制台', level: 1 }).waitFor({ timeout: 15_000 })
    const security = await readSecurityContext(dashboard.origin)

    await page.getByRole('button', { name: '启动监控' }).click()
    const watcherKey = watcherLeaseKey({ dbPath: paths.dbPath, runtimeDir: paths.runtimeDir, cwd: projectRoot })
    observedWatcherLease = await waitUntil(
      () => activeLeases(paths.dbPath),
      rows => Boolean(rows.find(row => row.leaseKey === watcherKey)),
      'runtime-health-watcher-start-failed',
    ).then(rows => rows.find(row => row.leaseKey === watcherKey))
    await waitUntil(
      () => readOperationsSummary(dashboard.origin),
      summary => summary?.watcher?.active === true && summary?.readiness?.monitor?.ready === true
        && summary?.readiness?.rules?.ready === true && summary?.readiness?.accounts?.ready === true
        && operationsMonitorModesReady(summary),
      'runtime-health-readiness-failed',
    )
    const acquiredWatcherHeartbeat = observedWatcherLease.heartbeatAt
    observedWatcherLease = await waitUntil(
      () => activeLeases(paths.dbPath).find(row => row.leaseKey === watcherKey) || null,
      row => row?.ownerId === observedWatcherLease.ownerId
        && row.heartbeatAt !== acquiredWatcherHeartbeat
        && protocolFixture.state.chkLogin >= 1
        && protocolFixture.state.getGameList >= 1,
      'runtime-health-watcher-heartbeat-failed',
      { timeoutMs: 10_000, pollMs: 50 },
    )

    const startButton = page.getByRole('button', { name: '开启真实投注' })
    await waitUntil(() => startButton.isEnabled(), enabled => enabled === true, 'runtime-health-real-start-disabled')
    await clickConfirm(page, '开启真实投注', '确认开启')
    await waitUntil(
      () => readOperationsSummary(dashboard.origin),
      summary => summary?.runtime?.state === 'running',
      'runtime-health-worker-start-failed',
      { timeoutMs: 45_000 },
    )
    const roleKeys = bettingRoleLeaseKeys({ cwd: projectRoot, dbPath: paths.dbPath })
    observedBettingLeases = await waitUntil(
      () => roleLeaseSet(readRuntimeLeases(paths.dbPath), roleKeys),
      roles => Object.values(roles).every(Boolean),
      'runtime-health-worker-leases-missing',
    )
    observedLeaseQuality = verifyRoleLeases(observedBettingLeases)
    await assertActualEntryProcesses({
      dashboardPid: dashboard.child.pid,
      watcherLease: observedWatcherLease,
      bettingLeases: observedBettingLeases,
    })

    const previousRoles = observedBettingLeases
    const restartResponse = await postOperation(dashboard.origin, '/api/app/real-betting/start', {}, security.csrfToken)
    if (restartResponse?.item?.state !== 'running') throw new Error('runtime-health-worker-restart-failed')
    observedBettingLeases = await waitUntil(
      () => roleLeaseSet(readRuntimeLeases(paths.dbPath), roleKeys),
      roles => Object.values(roles).every(Boolean) && Object.keys(roles).some(role => {
        const before = previousRoles[role]
        const after = roles[role]
        return before.ownerId !== after.ownerId || before.fencingToken !== after.fencingToken || before.pid !== after.pid
      }),
      'runtime-health-worker-restart-failed',
      { timeoutMs: 45_000 },
    )
    observedLeaseQuality = verifyRoleLeases(observedBettingLeases)
    await assertActualEntryProcesses({
      dashboardPid: dashboard.child.pid,
      watcherLease: observedWatcherLease,
      bettingLeases: observedBettingLeases,
    })

    await clickConfirm(page, '停止真实投注', '确认停止')
    await waitUntil(
      () => readOperationsSummary(dashboard.origin),
      summary => summary?.runtime?.state === 'off',
      'runtime-health-worker-stop-failed',
      { timeoutMs: 45_000 },
    )
    await waitUntil(
      () => roleLeaseSet(readRuntimeLeases(paths.dbPath), roleKeys),
      roles => Object.values(roles).every(row => !row),
      'runtime-health-worker-leases-not-released',
    )
    await clickConfirm(page, '停止监控', '确认停止')
    await waitUntil(
      () => readOperationsSummary(dashboard.origin),
      summary => summary?.watcher?.active === false,
      'runtime-health-watcher-stop-failed',
    )
    await waitUntil(
      () => activeLeases(paths.dbPath),
      rows => !rows.some(row => row.leaseKey === watcherKey),
      'runtime-health-watcher-lease-not-released',
    )

    const finalSummary = await readOperationsSummary(dashboard.origin)
    projection = projectOperationsSummary(finalSummary)
    monitorModesReady = operationsMonitorModesReady(finalSummary)
    desktopOk = await inspectActualFrontend(page, dashboard.origin, options.desktop, seeded.bettingUsername)
    mobileOk = await inspectActualFrontend(page, dashboard.origin, options.mobile, seeded.bettingUsername)

    await stopDashboardEntry(dashboard)
    dashboard = null
    secondDashboard = await startDashboardEntry(dashboardEnv)
    allowedDashboardOrigins.add(secondDashboard.origin)
    const restartedSummary = await readOperationsSummary(secondDashboard.origin)
    if (restartedSummary?.runtime?.state !== 'off' || activeLeases(paths.dbPath).length !== 0 || readAccountLockCount(paths.dbPath) !== 0) {
      throw new Error('runtime-health-restart-state-invalid')
    }
    await page.setViewportSize(options.desktop)
    await page.goto(`${secondDashboard.origin}/operations`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '运行控制台', level: 1 }).waitFor({ timeout: 15_000 })
    await stopDashboardEntry(secondDashboard)
    secondDashboard = null

    const decisions = networkDecisionCounts(paths.networkLogPath)
    if (protocolFixture.state.chkLogin < 1 || protocolFixture.state.getGameList < 1 || protocolFixture.state.unexpected !== 0
      || decisions.chkLogin < 1 || decisions.getGameList < 1 || decisions.denied !== 0
      || decisions.preview !== 0 || decisions.submit !== 0 || decisions.wagers !== 0 || decisions.other !== 0) {
      throw new Error('runtime-health-network-audit-failed')
    }
  } catch (error) {
    runError = error
  } finally {
    for (const entry of [secondDashboard, dashboard]) {
      if (!entry) continue
      await stopOperationsIfPossible(entry, paths.dbPath)
      try { await stopDashboardEntry(entry) } catch { cleanupError ||= new Error('runtime-health-dashboard-cleanup-failed') }
    }
    if (protocolFixture) {
      try { await protocolFixture.close() } catch { cleanupError ||= new Error('runtime-health-fixture-cleanup-failed') }
    }
    if (context) {
      try {
        const beforeClose = await windowsProcessSnapshot({ executablePath, marker })
        ownedChromium = captureOwnedChromiumTree(beforeClose, { marker, executablePath, previous: ownedChromium })
      } catch { cleanupError ||= new Error('runtime-health-process-query-failed') }
      try { await context.close() } catch { cleanupError ||= new Error('runtime-health-browser-cleanup-failed') }
      try {
        const remaining = await waitForOwnedChromiumExit({ ownedProcesses: ownedChromium, executablePath })
        orphanChromiumCount = remaining.length
        if (remaining.length) {
          for (const row of [...remaining].reverse()) {
            try { process.kill(row.pid, 'SIGKILL') } catch {}
          }
          cleanupError ||= new Error('runtime-health-owned-chromium-orphan')
        }
      } catch { cleanupError ||= new Error('runtime-health-process-query-failed') }
    }
    try {
      orphanLeaseCount = activeLeases(paths.dbPath).length
      orphanAccountLockCount = readAccountLockCount(paths.dbPath)
      if (orphanLeaseCount || orphanAccountLockCount) cleanupError ||= new Error('runtime-health-ledger-cleanup-failed')
    } catch { cleanupError ||= new Error('runtime-health-ledger-check-failed') }
    try { fs.rmSync(stateRoot, { recursive: true, force: true }) }
    catch { cleanupError ||= new Error('runtime-health-state-cleanup-failed') }
  }

  if (cleanupError) {
    cleanupError.cause = runError
    cleanupError.orphanLeaseCount = orphanLeaseCount
    cleanupError.orphanAccountLockCount = orphanAccountLockCount
    throw cleanupError
  }
  if (runError) throw runError
  const health = {
    schemaVersion: 'crown-runtime-health-v1',
    uniqueOwners: observedLeaseQuality.uniqueOwners && Boolean(observedWatcherLease?.ownerId)
      && !Object.values(observedBettingLeases || {}).some(row => row.ownerId === observedWatcherLease.ownerId),
    heartbeatsFresh: observedLeaseQuality.heartbeatsFresh,
    capabilityReadyCount: projection.capabilityReadyCount,
    unknownCount: projection.unknownCount,
    orphanChromiumCount,
    orphanLeaseCount,
    orphanAccountLockCount,
    desktopOk,
    mobileOk,
    consoleErrorCount: consoleErrors.length + browserNetworkDenials,
  }
  if (!projection.transportReady || !monitorModesReady || !health.uniqueOwners || !health.heartbeatsFresh || health.capabilityReadyCount !== 8
    || health.unknownCount !== 0 || health.orphanChromiumCount !== 0 || health.orphanLeaseCount !== 0
    || health.orphanAccountLockCount !== 0 || !health.desktopOk || !health.mobileOk || health.consoleErrorCount !== 0) {
    throw new Error('runtime-health-audit-failed')
  }
  process.stdout.write(`${JSON.stringify(health)}\n`)
}

function safeError(error) {
  const message = String(error?.message || '')
  return /^runtime-health-[a-z0-9-]+$/.test(message) ? message : 'runtime-health-internal-failed'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runAudit(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`)
    process.exitCode = 1
  }
}
