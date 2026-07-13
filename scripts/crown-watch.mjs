#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sendConsoleAlert, sendConsoleSignalAlert } from '../src/crown/alerts/console-alert.mjs'
import { sendTelegramAlert, sendTelegramSignalAlert } from '../src/crown/alerts/telegram-alert.mjs'
import { loadProjectEnv } from '../src/crown/app/env-file.mjs'
import { openAppDatabase, openRuntimeDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { buildTodayBettingLeagues } from '../src/crown/betting/today-betting-leagues.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { watcherLeaseKey } from '../src/crown/app/watcher-lease-key.mjs'
import { buildMonitorBetCandidate, buildMonitorBetCandidateFromSignal } from '../src/crown/betting/monitor-bet-signal.mjs'
import { CrownApiLoginManager, normalizeCrownBaseUrl } from '../src/crown/login/crown-api-login-manager.mjs'
import { CrownLoginManager } from '../src/crown/login/crown-login-manager.mjs'
import { normalizeDefaultLeaguesConfig } from '../src/crown/config/default-leagues.mjs'
import { normalizeTelegramSettings } from '../src/crown/config/telegram-settings.mjs'
import { classifyCrownTransformText, normalizeCrownTransformBatch } from '../src/crown/crown-transform-xml.mjs'
import { extractFootballTodayFromPage } from '../src/crown/dom-football-extractor.mjs'
import { detectEndpoint } from '../src/crown/endpoint-detector.mjs'
import { filterByLeague } from '../src/crown/filters/league-filter.mjs'
import { evaluateMonitorChange, legacyMonitorRules, normalizeMonitorSettings } from '../src/crown/monitor/monitor-settings.mjs'
import { AlertDispatcher } from '../src/crown/monitor/alert-dispatcher.mjs'
import { AlertSettingsWatcher } from '../src/crown/monitor/alert-settings-watcher.mjs'
import { openMonitorStateStore } from '../src/crown/monitor/monitor-state-store.mjs'
import { evaluateOddsDelta } from '../src/crown/monitor/odds-delta-strategy.mjs'
import { createSignal } from '../src/crown/monitor/signal.mjs'
import { buildSnapshotBatch } from '../src/crown/monitor/snapshot-batch.mjs'
import { StrategyRegistry } from '../src/crown/monitor/strategy-registry.mjs'
import { normalizeFootballResponse } from '../src/crown/normalize-football.mjs'
import { JsonlOddsStore } from '../src/crown/storage/jsonl-store.mjs'
import { drainCandidateOutbox } from '../src/crown/storage/jsonl-candidate-store.mjs'
import { JsonlV2AuditStore } from '../src/crown/storage/jsonl-v2-audit-store.mjs'
import { portableEnvironment, resolvePortablePaths } from '../src/crown/runtime/portable-paths.mjs'

const DEFAULT_URL = 'https://m321.mos077.com'
const HUMAN_VERIFICATION_RE = /(captcha|recaptcha|verify|verification|slider|slide|otp|2fa|two[-\s]?factor|验证码|滑块|二次验证|安全验证|人机验证|动态码|短信验证|谷歌验证)/i
const LOGIN_RE = /(login|sign\s*in|登录|登入|账号|帐号|用户名|用户名称|密码|login_index)/i
const WELCOME_RE = /\bwelcome\b|欢迎/i
const FOOTBALL_RE = /(football|soccer|足球|今日赛事|滚球|让球|大小)/i
const V2_SNAPSHOT_FILE = 'crown-odds-snapshots-v2.jsonl'
const V2_CHANGE_FILE = 'crown-odds-changes-v2.jsonl'
const APP_DIR = fileURLToPath(new URL('../', import.meta.url))

export function resolvePortableWatcherEnvironment(env = process.env) {
  if (env.CROWN_PORTABLE !== '1') return env
  const paths = resolvePortablePaths({
    appRoot: env.CROWN_APP_ROOT,
    dataRoot: env.CROWN_DATA_ROOT,
    version: env.CROWN_APP_VERSION,
    env,
  })
  const canonical = portableEnvironment(paths)
  for (const [name, value] of Object.entries(canonical)) {
    if (env[name] !== value) throw new Error(`portable-watcher-environment-mismatch:${name}`)
  }
  return { ...env, ...canonical }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function appendJsonl(file, record) {
  if (!file) return
  ensureParent(file)
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

function urlHost(value) {
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function classifyCrownSessionState({ title = '', url = '', bodyText = '', pageHealth = null } = {}) {
  const text = cleanText(`${title} ${url} ${bodyText}`)
  if (HUMAN_VERIFICATION_RE.test(text)) {
    return { status: '等待人工验证码', humanRequired: true, loggedIn: false }
  }
  if (pageHealth?.isFootballPage || FOOTBALL_RE.test(text)) {
    return { status: '已登录', humanRequired: false, loggedIn: true }
  }
  if (WELCOME_RE.test(String(title || '')) || WELCOME_RE.test(url) || WELCOME_RE.test(text)) {
    return { status: 'Welcome 页面', humanRequired: false, loggedIn: false }
  }
  if (pageHealth?.isLogin || LOGIN_RE.test(text)) {
    return { status: '登录失效', humanRequired: false, loggedIn: false }
  }
  if (pageHealth?.isLoading) {
    return { status: '打开网站中', humanRequired: false, loggedIn: false }
  }
  return { status: '未启动', humanRequired: false, loggedIn: false }
}

export function shouldAutoRelogin({ status, autoReloginCount = 0, maxAutoReloginCount = 3 } = {}) {
  if (status === '等待人工验证码' || status === '需要人工处理') return false
  if (!['Welcome 页面', '登录失效', '网络异常', 'XML 无响应', 'XML 无响应', '自动重登失败'].includes(status)) return false
  return Number(autoReloginCount || 0) < Number(maxAutoReloginCount ?? 3)
}

function withAppRepository(dbPath, handler) {
  const handle = openRuntimeDatabase({ dbPath })
  try {
    const repo = createAppRepository(handle.db)
    return handler(repo)
  } finally {
    handle.close()
  }
}

function existingSecretKey(env = process.env) {
  if (env.CROWN_SECRET_KEY) return env.CROWN_SECRET_KEY
  const configured = env.CROWN_LOCAL_SECRET_KEY_PATH || env.CROWN_SECRET_KEY_FILE || 'storage/crown-local-secret.key'
  const file = path.resolve(configured)
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return value || '__readonly-secret-key-unavailable__'
  } catch {
    return '__readonly-secret-key-unavailable__'
  }
}

function withExistingAppRepository(dbPath, handler) {
  if (!dbPath) throw new Error('app database path is required')
  const resolved = path.resolve(dbPath)
  if (!fs.existsSync(resolved)) throw new Error('app database does not exist')
  const db = new DatabaseSync(resolved, { readOnly: true })
  try {
    return handler(createAppRepository(db, { secretKey: existingSecretKey() }))
  } finally {
    db.close()
  }
}

function loadRuntimeMonitorAccount(args) {
  try {
    return withExistingAppRepository(args.appDbPath, (repo) => repo.getEnabledMonitorAccountForRuntime())
  } catch (error) {
    console.warn(`monitor account unavailable: ${errorMessage(error)}`)
    return null
  }
}

function loadRuntimeTrackedMatches(args) {
  if (!args?.appDbPath) return []
  try {
    return withExistingAppRepository(args.appDbPath, (repo) => repo.listTrackedMatches())
  } catch (error) {
    console.warn(`tracked matches unavailable: ${errorMessage(error)}`)
    return []
  }
}

// Schema-v1 DOM/fixture rollback compatibility only. Direct-v2 uses explicit signal.bettingRuleId below.
function loadLegacyRuntimeBettingRule(args) {
  if (!args?.appDbPath) return null
  try {
    return withExistingAppRepository(args.appDbPath, (repo) => repo.listBettingRules().find((rule) => rule.enabled) || null)
  } catch (error) {
    console.warn(`betting rule unavailable: ${errorMessage(error)}`)
    return null
  }
}

function updateRuntimeMonitorAccount(args, account, payload) {
  if (!account?.id) return null
  if (Number(args?.monitorStateVersion) === 1) return null
  try {
    return withAppRepository(args.appDbPath, (repo) => repo.updateMonitorAccountRuntime(account.id, payload))
  } catch (error) {
    console.warn(`monitor account status update failed: ${errorMessage(error)}`)
    return null
  }
}

function updateRuntimeMonitorAccountLoginResult(args, account, result) {
  if (!account?.id || !result) return null
  if (Number(args?.monitorStateVersion) === 1) return null
  try {
    return withAppRepository(args.appDbPath, (repo) => repo.updateMonitorAccountLoginResult(account.id, result))
  } catch (error) {
    console.warn(`monitor account login result update failed: ${errorMessage(error)}`)
    return null
  }
}

function errorMessage(error) {
  return String(error?.message || error || '')
}

function requestEndpointKind(request) {
  const postData = request.postData() || ''
  try {
    return new URLSearchParams(postData).get('p') || ''
  } catch {
    return ''
  }
}

function comparablePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function validateCandidateGeneration(args, version = Number(args.monitorStateVersion ?? 2)) {
  if (args.bettingCandidatesPathSet !== true) return
  const runtimeDir = args.runtimeDir || 'data/runtime'
  const selected = comparablePath(args.bettingCandidatesPath)
  const legacyReserved = comparablePath(path.join(runtimeDir, 'betting-candidates.jsonl'))
  const v2Reserved = comparablePath(path.join(runtimeDir, 'betting-candidates-v2.jsonl'))
  if (version === 1 && selected === v2Reserved) {
    throw new Error('schema-v2 candidate path is reserved and cannot be used by schema-v1')
  }
  if (version === 2 && selected === legacyReserved) {
    throw new Error('schema-v1 candidate path is reserved and cannot be used by schema-v2')
  }
}

export function parseArgs(argv, { env = process.env } = {}) {
  env = resolvePortableWatcherEnvironment(env)
  const configDir = env.CROWN_CONFIG_DIR || path.join(APP_DIR, 'config')
  const runtimeDir = env.CROWN_RUNTIME_DIR || path.join(APP_DIR, 'data', 'runtime')
  const portable = env.CROWN_PORTABLE === '1'
  const args = {
    url: DEFAULT_URL,
    profile: env.CROWN_BROWSER_PROFILE_DIR || path.join(APP_DIR, 'data', 'crown-profile'),
    profileSet: false,
    runtimeDir,
    monitorStateVersion: 2,
    leagueConfigPath: path.join(configDir, 'monitored-leagues.json'),
    defaultLeaguesPath: path.join(configDir, 'default-leagues.json'),
    monitorSettingsPath: path.join(configDir, 'monitor-settings.json'),
    telegramSettingsPath: path.join(configDir, 'telegram-settings.json'),
    alertsConfigPath: path.join(configDir, 'alerts.json'),
    appDbPath: env.CROWN_DB_PATH || path.join(APP_DIR, 'storage', 'crown.sqlite'),
    bettingCandidatesPath: '',
    bettingCandidatesPathSet: false,
    channel: portable ? '' : (env.CROWN_BROWSER_CHANNEL || ''),
    chromiumExecutablePath: env.CROWN_CHROMIUM_EXECUTABLE_PATH || '',
    headless: false,
    fromFixture: '',
    maxSeconds: 0,
    domPollSeconds: 10,
    domPollSecondsSet: false,
    maxGameMore: Number(env.CROWN_MAX_GAME_MORE || 8),
    runtimeLogPath: '',
    configReloadSeconds: 30,
    zeroDomWarnAfter: 3,
    loginTest: false,
    retainMonitorHistory: true,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    const nextValue = (option = current) => {
      const value = argv[i + 1]
      if (value === undefined || value === '' || value === '-h' || String(value).startsWith('--')) {
        throw new Error(`${option} requires a value`)
      }
      i += 1
      return value
    }
    const nextNonNegativeNumber = (option = current) => {
      const value = Number(nextValue(option))
      if (!Number.isFinite(value) || value < 0) throw new Error(`${option} must be a finite non-negative number`)
      return value
    }
    if (current === '--url') args.url = nextValue()
    else if (current === '--profile') {
      args.profile = nextValue()
      args.profileSet = true
    }
    else if (current === '--runtime-dir') args.runtimeDir = nextValue()
    else if (current === '--monitor-state-version') {
      const value = nextValue()
      if (!/^[12]$/.test(String(value ?? ''))) {
        throw new Error('--monitor-state-version must be 1 or 2')
      }
      args.monitorStateVersion = Number(value)
    }
    else if (current === '--league-config') args.leagueConfigPath = nextValue()
    else if (current === '--default-leagues-config') args.defaultLeaguesPath = nextValue()
    else if (current === '--monitor-settings') args.monitorSettingsPath = nextValue()
    else if (current === '--telegram-settings') args.telegramSettingsPath = nextValue()
    else if (current === '--alerts-config') args.alertsConfigPath = nextValue()
    else if (current === '--app-db') args.appDbPath = nextValue()
    else if (current === '--betting-candidates') {
      args.bettingCandidatesPath = nextValue()
      args.bettingCandidatesPathSet = true
    }
    else if (current === '--channel') args.channel = nextValue()
    else if (current === '--headless') args.headless = true
    else if (current === '--from-fixture') args.fromFixture = nextValue()
    else if (current === '--max-seconds') args.maxSeconds = nextNonNegativeNumber()
    else if (current === '--dom-poll-seconds') {
      args.domPollSeconds = nextNonNegativeNumber()
      args.domPollSecondsSet = true
    }
    else if (current === '--max-game-more') args.maxGameMore = nextNonNegativeNumber()
    else if (current === '--runtime-log') args.runtimeLogPath = nextValue()
    else if (current === '--login-test') args.loginTest = true
    else if (current === '--config-reload-seconds') args.configReloadSeconds = nextNonNegativeNumber()
    else if (current === '--zero-dom-warn-after') args.zeroDomWarnAfter = nextNonNegativeNumber()
    else if (current === '--help' || current === '-h') args.help = true
    else throw new Error(`Unknown argument: ${current}`)
  }

  if (args.loginTest && !args.profileSet && !portable) {
    args.profile = path.join(args.runtimeDir, 'crown-login-profile')
  }
  if (!args.bettingCandidatesPath) {
    args.bettingCandidatesPath = path.join(args.runtimeDir, 'betting-candidates.jsonl')
  }

  if (!Number.isFinite(args.maxGameMore) || args.maxGameMore < 0) {
    throw new Error('--max-game-more must be a finite non-negative number')
  }
  if (portable && (!args.chromiumExecutablePath || !path.isAbsolute(args.chromiumExecutablePath))) {
    throw new Error('portable-chromium-executable-required')
  }
  if (portable) {
    const canonicalPaths = {
      appDbPath: env.CROWN_DB_PATH,
      runtimeDir: env.CROWN_RUNTIME_DIR,
      profile: env.CROWN_BROWSER_PROFILE_DIR,
      leagueConfigPath: path.join(env.CROWN_CONFIG_DIR, 'monitored-leagues.json'),
      defaultLeaguesPath: path.join(env.CROWN_CONFIG_DIR, 'default-leagues.json'),
      monitorSettingsPath: path.join(env.CROWN_CONFIG_DIR, 'monitor-settings.json'),
      telegramSettingsPath: path.join(env.CROWN_CONFIG_DIR, 'telegram-settings.json'),
      alertsConfigPath: path.join(env.CROWN_CONFIG_DIR, 'alerts.json'),
      chromiumExecutablePath: env.CROWN_CHROMIUM_EXECUTABLE_PATH,
    }
    for (const [field, value] of Object.entries(canonicalPaths)) {
      if (args[field] !== value) throw new Error(`portable-watcher-path-mismatch:${field}`)
    }
  }
  validateCandidateGeneration(args)

  return args
}

export function directV2CandidatesPath(args = {}) {
  const explicitlyConfigured = args.bettingCandidatesPathSet === true
    || (!Object.hasOwn(args, 'bettingCandidatesPathSet') && Boolean(args.bettingCandidatesPath))
  return explicitlyConfigured
    ? args.bettingCandidatesPath
    : path.join(args.runtimeDir || 'data/runtime', 'betting-candidates-v2.jsonl')
}

export function resolveMonitorStateRouting(args = {}) {
  const version = Number(args.monitorStateVersion ?? 2)
  if (version !== 1 && version !== 2) throw new Error('--monitor-state-version must be 1 or 2')
  validateCandidateGeneration(args, version)
  const runtimeDir = args.runtimeDir || 'data/runtime'
  const legacy = version === 1
  return {
    version,
    useDirectApiV2: !legacy,
    snapshotsPath: path.join(runtimeDir, legacy ? 'crown-odds-snapshots.jsonl' : V2_SNAPSHOT_FILE),
    changesPath: path.join(runtimeDir, legacy ? 'crown-odds-changes.jsonl' : V2_CHANGE_FILE),
    candidatesPath: legacy
      ? (args.bettingCandidatesPath || path.join(runtimeDir, 'betting-candidates.jsonl'))
      : directV2CandidatesPath(args),
    warning: legacy
      ? '!!! DEPRECATED schema-v1 rollback active: its event lifecycle is contaminated by list/detail full-set semantics; use only for temporary rollback. !!!'
      : '',
  }
}

export function emitLegacyMonitorWarning(args = {}, { warn = console.warn } = {}) {
  const routing = resolveMonitorStateRouting(args)
  if (routing.warning) warn(routing.warning)
  return routing.warning
}

function printHelp() {
  console.log(`Usage:
  npm run crown:watch -- [options]
  node scripts/crown-watch.mjs [options]

Options:
  --url <url>              Page URL, default ${DEFAULT_URL}
  --profile <dir>          Persistent browser profile, default data/crown-profile
  --runtime-dir <dir>      JSONL output directory, default data/runtime
  --monitor-state-version <1|2>
                            Monitor state schema, default 2; 1 is deprecated rollback
  --league-config <file>   Monitored league config, default config/monitored-leagues.json
  --default-leagues-config <file>
                            Default league config, default config/default-leagues.json
  --monitor-settings <file>
                            Monitor settings config, default config/monitor-settings.json
  --telegram-settings <file>
                            Telegram settings config, default config/telegram-settings.json
  --alerts-config <file>   Alerts config, default config/alerts.json
  --app-db <file>          Dashboard SQLite config DB, default storage/crown.sqlite
  --betting-candidates <file>
                            Override candidate JSONL. Defaults: direct-v2 betting-candidates-v2.jsonl; legacy betting-candidates.jsonl
  --channel <name>         Development-only browser channel; Portable uses bundled Chromium
  --headless               Run browser headless
  --from-fixture <dir>     Offline verification mode using football-today-filtered.json
  --max-seconds <n>        Stop live watcher after n seconds
  --dom-poll-seconds <n>   Poll current page DOM every n seconds, default 10, 0 disables DOM polling
  --max-game-more <n>      Max get_game_more detail requests per direct API poll, default 8
  --runtime-log <file>     Poll/error JSONL log, default <runtime-dir>/crown-watch-runtime.jsonl
  --login-test             Run one login test, save LoginResult, then exit
  --config-reload-seconds <n>
                            Reload config files every n seconds, default 30, 0 disables reload
  --zero-dom-warn-after <n>
                            Warn after n consecutive DOM polls with zero events, default 3

Read-only boundary:
  The watcher opens the page, listens to page responses and WebSocket frames,
  polls visible DOM event cards, parses JSON bodies, and writes local JSONL
  files. It does not click odds, fill stakes, submit orders, or construct
  Crown betting calls.`)
}

function loadLeagueConfig(file) {
  return file && fs.existsSync(file) ? readJson(file) : null
}

function listFilesByExtension(dir, extensions) {
  if (!fs.existsSync(dir)) return []
  const allowed = new Set(extensions.map((extension) => extension.toLowerCase()))
  return fs.readdirSync(dir)
    .filter((name) => allowed.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(dir, name))
}

function endpointKindForFixtureFile(file) {
  const name = path.basename(file).toLowerCase()
  if (name.includes('more')) return 'get_game_more'
  return 'get_game_list'
}

function loadAlertsConfig(file) {
  return file && fs.existsSync(file) ? readJson(file) : {}
}

function loadDefaultLeagues(file) {
  return normalizeDefaultLeaguesConfig(file && fs.existsSync(file) ? readJson(file) : {})
}

function loadMonitorSettings(file) {
  return normalizeMonitorSettings(file && fs.existsSync(file) ? readJson(file) : {})
}

function writeMonitorSettings(file, settings) {
  if (!file) return normalizeMonitorSettings(settings)
  const normalized = normalizeMonitorSettings(settings)
  ensureParent(file)
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

function withLastAlertAt(settings, mode, at) {
  const normalized = normalizeMonitorSettings(settings)
  if (mode && normalized[mode]) normalized[mode].lastAlertAt = at
  return normalized
}

function recordMonitorLastAlert(configState, mode, at) {
  if (!configState || !mode || !at) return
  const file = configState.args?.monitorSettingsPath
  const next = writeMonitorSettings(file, withLastAlertAt(configState.current?.monitorSettings, mode, at))
  configState.current.monitorSettings = next
  if (configState.mtimes && file) configState.mtimes.monitorSettingsPath = fileMtimeMs(file)
}

function loadTelegramSettings(file) {
  return normalizeTelegramSettings(file && fs.existsSync(file) ? readJson(file) : {})
}

function configFiles(args) {
  return {
    leagueConfigPath: args.leagueConfigPath,
    defaultLeaguesPath: args.defaultLeaguesPath,
    monitorSettingsPath: args.monitorSettingsPath,
    telegramSettingsPath: args.telegramSettingsPath,
    alertsConfigPath: args.alertsConfigPath,
  }
}

function loadRuntimeConfig(args) {
  return {
    leagueConfig: loadLeagueConfig(args.leagueConfigPath),
    defaultLeagues: loadDefaultLeagues(args.defaultLeaguesPath),
    monitorSettings: loadMonitorSettings(args.monitorSettingsPath),
    telegramSettings: loadTelegramSettings(args.telegramSettingsPath),
    alertsConfig: loadAlertsConfig(args.alertsConfigPath),
  }
}

export function createRuntimeConfigState(args) {
  const files = configFiles(args)
  return {
    args,
    current: loadRuntimeConfig(args),
    mtimes: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fileMtimeMs(file)])),
  }
}

export function reloadRuntimeConfig(state) {
  const files = configFiles(state.args)
  const nextMtimes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fileMtimeMs(file)]))
  const changed = Object.keys(nextMtimes).some((key) => nextMtimes[key] !== state.mtimes[key])
  if (changed) {
    const nextCurrent = loadRuntimeConfig(state.args)
    state.current = nextCurrent
    state.mtimes = nextMtimes
  }
  return { changed, mtimes: state.mtimes }
}

export function safeReloadRuntimeConfig(state, logger = null) {
  const at = new Date().toISOString()
  const log = (record) => {
    try {
      logger?.log?.(record)
    } catch {
      // A diagnostic sink must never terminate either live watcher interval.
    }
  }
  let result
  try {
    result = reloadRuntimeConfig(state)
  } catch (error) {
    const errorCode = error instanceof SyntaxError ? 'invalid-json' : 'reload-failed'
    log({ type: 'config-reload-error', at, errorCode })
    return { changed: false, ok: false, errorCode }
  }
  if (result.changed) log({ type: 'config-reload', at })
  return { ...result, ok: true }
}

function makeRuntimeLogger(args) {
  const file = args.runtimeLogPath || path.join(args.runtimeDir, 'crown-watch-runtime.jsonl')
  return {
    file,
    log(record) {
      appendJsonl(file, record)
    },
    error(record) {
      appendJsonl(file, {
        type: 'watch-error',
        at: new Date().toISOString(),
        ...record,
      })
    },
  }
}

function makeV1Store(runtimeDir) {
  return new JsonlOddsStore({
    snapshotsPath: path.join(runtimeDir, 'crown-odds-snapshots.jsonl'),
    changesPath: path.join(runtimeDir, 'crown-odds-changes.jsonl'),
  })
}

export function createMonitorAuditStore({ runtimeDir } = {}) {
  return new JsonlV2AuditStore({
    snapshotsPath: path.join(runtimeDir, V2_SNAPSHOT_FILE),
    changesPath: path.join(runtimeDir, V2_CHANGE_FILE),
  })
}

export async function processDirectXmlV2({
  body,
  endpointKind,
  capturedAt,
  pollId,
  requestScope,
  stateStore,
  auditStore,
  metadata = {},
} = {}) {
  if (!stateStore || typeof stateStore.applyBatch !== 'function') throw new TypeError('stateStore is required')
  if (!auditStore || typeof auditStore.appendFacts !== 'function') throw new TypeError('auditStore is required')
  const normalized = normalizeCrownTransformBatch({
    body,
    metadata: { ...metadata, endpointKind, capturedAt },
  })
  const batch = buildSnapshotBatch({
    endpointKind,
    classification: normalized.classification,
    records: normalized.records,
    eventRefs: normalized.eventRefs,
    capturedAt,
    request: requestScope,
    pollId,
  })
  const applied = stateStore.applyBatch(batch)
  const drained = drainMonitorAuditOutbox({ stateStore, auditStore })
  return {
    ...applied,
    batch,
    classification: normalized.classification,
    records: normalized.records,
    eventRefs: normalized.eventRefs,
    systemTime: normalized.systemTime || '',
    normalizedCount: normalized.records.length,
    currentChanges: applied.changes,
    changes: drained.changes,
    auditSnapshots: drained.snapshots,
    drainedAuditFacts: drained.facts,
  }
}

export function directV2Channels(_config = {}) {
  return ['telegram']
}

export function createDirectV2AlertDispatcher({
  stateStore,
  configState,
  consoleSender = sendConsoleSignalAlert,
  telegramSender = sendTelegramSignalAlert,
  ...dispatcherOptions
} = {}) {
  if (!configState?.current) throw new TypeError('configState is required')
  return new AlertDispatcher({
    store: stateStore,
    ...dispatcherOptions,
    senders: {
      console: (signal) => consoleSender(signal),
      telegram: (signal) => telegramSender(signal, configState.current.telegramSettings?.oddsAlert),
    },
  })
}

export function persistDirectV2Signals({
  changes = [],
  stateStore,
  monitorSettings,
  defaultLeagues = null,
  trackedMatches = [],
  registry = null,
  alertSettingsWatcher = null,
  availableLeagueNamesReader = null,
  now = () => new Date(),
} = {}) {
  if (!stateStore || typeof stateStore.insertSignal !== 'function') throw new TypeError('stateStore is required')
  if (!Array.isArray(changes)) throw new TypeError('changes must be an array')
  const ruleSnapshot = alertSettingsWatcher?.reload?.() || null
  const rules = ruleSnapshot ? ruleSnapshot.strategies : legacyMonitorRules(monitorSettings)
  const engine = registry || new StrategyRegistry().register('odds_delta', evaluateOddsDelta)
  const byRule = new Map(rules.map((rule) => [`${rule.id}|${rule.version}`, rule]))
  if (typeof now !== 'function') throw new TypeError('now is required')
  const nowValue = now()
  const catalogNow = nowValue instanceof Date ? nowValue.toISOString() : String(nowValue || '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(catalogNow)
    || new Date(catalogNow).toISOString() !== catalogNow) throw new TypeError('canonical poll now is required')
  const readAvailableLeagueNames = availableLeagueNamesReader || ((fixedNow) => new Set(buildTodayBettingLeagues({
    db: stateStore.db,
    defaultLeagues,
    now: () => fixedNow,
  }).map((item) => item.leagueName)))
  const output = {
    inserted: [], duplicates: 0, cooldownSuppressed: 0, evaluatedChanges: changes.length,
    matchAudits: [], ruleReload: ruleSnapshot, rules, usesAlertSettings: Boolean(ruleSnapshot),
  }
  const pending = []
  for (const change of changes) {
    const decisions = engine.evaluate(change, { rules, defaultLeagues, trackedMatches })
    for (const [index, decision] of decisions.entries()) {
      output.matchAudits.push({
        changeId: change?.changeId || null,
        ruleId: decision.strategyId,
        rank: index + 1,
        priority: byRule.get(`${decision.strategyId}|${decision.strategyVersion}`)?.priority ?? null,
        matched: true,
        claimed: false,
      })
    }
    for (const decision of decisions) {
      const rule = byRule.get(`${decision.strategyId}|${decision.strategyVersion}`)
      if (!rule) continue
      const signal = createSignal({ rule, change, decision })
      pending.push({ signal, persistedSignal: { ...signal, channels: ruleSnapshot ? directV2Channels() : ['console'] } })
    }
  }
  if (pending.length > 0) {
    if (typeof stateStore.insertSignals !== 'function') throw new TypeError('stateStore.insertSignals is required')
    const persistedResults = stateStore.insertSignals(pending.map((item) => item.persistedSignal), {
      catalogReader: () => ruleSnapshot ? readAvailableLeagueNames(catalogNow) : null,
    })
    for (const [index, persisted] of persistedResults.entries()) {
      const signal = pending[index].signal
      if (persisted.inserted) output.inserted.push(signal)
      else if (persisted.reason === 'duplicate') output.duplicates += 1
      else if (persisted.reason === 'cooldown_active') output.cooldownSuppressed += 1
    }
  }
  return output
}

export function persistDirectV2Candidates({
  signals = [],
  stateStore,
  bettingRules = [],
  candidateStore = null,
  now = new Date().toISOString(),
  canonicalRuleSnapshot = false,
} = {}) {
  if (!stateStore || typeof stateStore.insertCandidate !== 'function' || typeof stateStore.findLatestSelection !== 'function') {
    throw new TypeError('candidate-capable stateStore is required')
  }
  if (!Array.isArray(signals)) throw new TypeError('signals must be an array')
  if (!Array.isArray(bettingRules)) throw new TypeError('bettingRules must be an array')
  const output = { inserted: [], existing: [], deferred: [], duplicates: 0, exported: 0 }
  const recoverable = typeof stateStore.listSignalsWithoutCandidates === 'function'
    ? stateStore.listSignalsWithoutCandidates({ limit: 100 })
    : []
  const bySignalId = new Map([...signals, ...recoverable].map((signal) => [signal?.signalId, signal]))
  for (const signal of bySignalId.values()) {
    const bindingId = typeof signal?.bettingRuleId === 'string' && signal.bettingRuleId.trim()
      ? signal.bettingRuleId.trim()
      : 'unbound'
    const candidateId = createHash('sha256').update(`${signal?.signalId}|${bindingId}`).digest('hex')
    const existing = typeof stateStore.getCandidate === 'function' ? stateStore.getCandidate(candidateId) : null
    if (existing) {
      output.existing.push(existing)
      output.duplicates += 1
      continue
    }
    const bettingRule = signal?.bettingRuleId
      ? bettingRules.find((rule) => rule.id === signal.bettingRuleId) || null
      : null
    const candidate = buildMonitorBetCandidateFromSignal(signal, {
      bettingRule,
      findLatestSelection: (query) => stateStore.findLatestSelection(query),
      now,
      deferUnresolvedBinding: canonicalRuleSnapshot,
    })
    if (candidate.status === 'deferred') {
      output.deferred.push({ signalId: signal.signalId, reason: candidate.deferReason })
      continue
    }
    const persisted = stateStore.insertCandidate(candidate)
    if (persisted.inserted) output.inserted.push(candidate)
    else if (persisted.reason === 'duplicate') output.duplicates += 1
  }
  if (candidateStore) output.exported = drainCandidateOutbox({ stateStore, candidateStore }).exported
  return output
}

export function drainMonitorAuditOutbox({ stateStore, auditStore, limit = 1000 } = {}) {
  const drained = { facts: [], snapshots: [], changes: [] }
  while (true) {
    const facts = stateStore.listPendingAuditFacts({ limit })
    if (!facts.length) return drained
    const snapshots = facts.filter((fact) => fact.kind === 'snapshot').map((fact) => fact.payload)
    const changes = facts.filter((fact) => fact.kind === 'change').map((fact) => fact.payload)
    auditStore.appendFacts({ snapshots, changes })
    const delivered = stateStore.markAuditFactsDelivered(facts.map((fact) => fact.factId))
    if (delivered !== facts.length) throw new Error('monitor audit outbox delivery acknowledgement was incomplete')
    drained.facts.push(...facts)
    drained.snapshots.push(...snapshots)
    drained.changes.push(...changes)
  }
}

export function createWatcherStats() {
  return {
    responsesSeen: 0,
    candidateResponses: 0,
    xmlResponses: 0,
    getGameListCount: 0,
    getGameMoreCount: 0,
    xmlEvents: 0,
    normalizedRecords: 0,
    filteredRecords: 0,
    snapshots: 0,
    snapshotWrites: 0,
    oddsChanges: 0,
    changeWrites: 0,
    parseErrors: 0,
    emptyXmlResponses: 0,
    loginExpiredResponses: 0,
    lastXmlAt: null,
    lastSnapshotAt: null,
    alertTriggers: 0,
    domPolls: 0,
    domEvents: 0,
    zeroDomWarnings: 0,
    consecutiveZeroDomPolls: 0,
    skippedAlerts: {},
    errors: 0,
  }
}

function addSkip(stats, reason) {
  if (!stats || !reason) return
  stats.skippedAlerts[reason] = (stats.skippedAlerts[reason] || 0) + 1
}

function incrementEndpointStats(stats, endpointKind) {
  if (endpointKind === 'get_game_list') stats.getGameListCount += 1
  if (endpointKind === 'get_game_more') stats.getGameMoreCount += 1
}

function recordXmlClassification(stats, classification, endpointKind, at) {
  if (classification.loginExpired) {
    stats.loginExpiredResponses += 1
    return false
  }
  if (classification.parseError) {
    stats.parseErrors += 1
    return false
  }
  if (!classification.hasServerResponse) return false

  stats.xmlResponses += 1
  incrementEndpointStats(stats, endpointKind)
  stats.xmlEvents += classification.gameCount || 0
  if (classification.empty) stats.emptyXmlResponses += 1
  stats.lastXmlAt = at
  return true
}

function xmlStatsPayload(stats) {
  return {
    xmlResponses: stats.xmlResponses,
    getGameListCount: stats.getGameListCount,
    getGameMoreCount: stats.getGameMoreCount,
    xmlEvents: stats.xmlEvents,
    normalizedRecords: stats.normalizedRecords,
    snapshotWrites: stats.snapshotWrites,
    changeWrites: stats.changeWrites,
    parseErrors: stats.parseErrors,
    emptyXmlResponses: stats.emptyXmlResponses,
    loginExpiredResponses: stats.loginExpiredResponses,
    lastXmlAt: stats.lastXmlAt,
    lastSnapshotAt: stats.lastSnapshotAt,
  }
}

async function notifyChanges(changes, {
  alertsConfig = {},
  monitorSettings = {},
  defaultLeagues = {},
  trackedMatches = [],
  telegramSettings = {},
  store = null,
  bettingRule = null,
  bettingCandidatesPath = '',
  onAlert = null,
} = {}, stats) {
  const cooldownState = notifyChanges.cooldownState || new Map()
  notifyChanges.cooldownState = cooldownState

  for (const change of changes) {
    if (!['odds-change', 'handicap-change', 'market-suspended', 'market-reopened'].includes(change?.type)) continue
    const decision = evaluateMonitorChange(change, { settings: monitorSettings, defaultLeagues, trackedMatches, cooldownState })
    if (!decision.triggered) {
      addSkip(stats, decision.skipReason)
      continue
    }
    if (stats) stats.alertTriggers += 1
    const alertAt = change?.capturedAt || new Date().toISOString()
    if (bettingCandidatesPath) {
      const candidate = buildMonitorBetCandidate(change, {
        monitorDecision: decision,
        bettingRule,
        findLatestSelection: (query) => store?.findLatestSelection(query),
      })
      appendJsonl(bettingCandidatesPath, candidate)
    }
    if (typeof onAlert === 'function') onAlert({ mode: decision.monitorMode, at: alertAt, change })
    if (alertsConfig.console?.enabled) sendConsoleAlert(change)
    if (telegramSettings.oddsAlert?.enabled) {
      const result = await sendTelegramAlert(change, telegramSettings.oddsAlert)
      if (!result.sent && result.reason !== 'disabled' && stats) stats.errors += 1
    }
  }
}

async function normalizeAndStore({
  body,
  metadata,
  leagueConfig,
  defaultLeagues,
  trackedMatches = [],
  monitorSettings,
  telegramSettings,
  alertsConfig,
  store,
  stats,
  bettingRule = null,
  bettingCandidatesPath = '',
  onAlert = null,
}) {
  // Schema-v1 ingestion remains only for fixture, DOM, WebSocket, and response-listener rollback compatibility.
  stats.responsesSeen += 1
  const detected = detectEndpoint({ body, metadata })
  if (!detected.detected) return { detected, records: [], normalizedCount: 0, filteredCount: 0, snapshots: [], changes: [] }

  stats.candidateResponses += 1
  const allRecords = normalizeFootballResponse({ body, metadata })
  const filtered = leagueConfig ? filterByLeague(allRecords, leagueConfig) : { kept: allRecords, dropped: [] }
  const explicitlyExcluded = new Set(filtered.dropped
    .filter((item) => item?.decision?.reason === 'excluded')
    .map((item) => item.record))
  const dashboardRecords = leagueConfig ? allRecords.filter((record) => !explicitlyExcluded.has(record)) : allRecords
  stats.normalizedRecords += allRecords.length
  stats.filteredRecords += filtered.kept.length
  const result = store.ingest(dashboardRecords, { monitorSettings })
  stats.snapshots += result.snapshots.length
  stats.snapshotWrites += result.snapshots.length
  if (result.snapshots.length) stats.lastSnapshotAt = result.snapshots.at(-1)?.capturedAt || new Date().toISOString()
  stats.oddsChanges += result.changes.filter((change) => change.type === 'odds-change').length
  stats.changeWrites += result.changes.length
  await notifyChanges(result.changes, {
    alertsConfig,
    monitorSettings,
    defaultLeagues,
    trackedMatches,
    telegramSettings,
    store,
    bettingRule,
    bettingCandidatesPath,
    onAlert,
  }, stats)
  return {
    detected,
    records: filtered.kept,
    normalizedCount: allRecords.length,
    filteredCount: filtered.kept.length,
    snapshots: result.snapshots,
    changes: result.changes,
  }
}

export async function runFixtureWatch({
  fixtureDir,
  runtimeDir = 'data/runtime',
  leagueConfigPath = 'config/monitored-leagues.json',
  defaultLeaguesPath = 'config/default-leagues.json',
  monitorSettingsPath = 'config/monitor-settings.json',
  telegramSettingsPath = 'config/telegram-settings.json',
  alertsConfigPath = 'config/alerts.json',
  bettingCandidatesPath = path.join(runtimeDir, 'betting-candidates.jsonl'),
}) {
  const stats = createWatcherStats()
  const store = makeV1Store(runtimeDir)
  const logger = makeRuntimeLogger({ runtimeDir, runtimeLogPath: '' })
  const leagueConfig = loadLeagueConfig(leagueConfigPath)
  const defaultLeagues = loadDefaultLeagues(defaultLeaguesPath)
  const monitorSettings = loadMonitorSettings(monitorSettingsPath)
  const telegramSettings = loadTelegramSettings(telegramSettingsPath)
  const alertsConfig = loadAlertsConfig(alertsConfigPath)
  const bettingRule = null
  const fixturePath = path.join(fixtureDir, 'football-today-filtered.json')

  if (fs.existsSync(fixturePath)) {
    const body = readJson(fixturePath)

    await normalizeAndStore({
      body,
      metadata: {
        method: 'LOCAL',
        url: fixturePath,
        capturedAt: body.capturedAt,
        sampleFile: 'football-today-filtered.json',
      },
      leagueConfig,
      defaultLeagues,
      monitorSettings,
      telegramSettings,
      alertsConfig,
      store,
      stats,
      bettingRule,
      bettingCandidatesPath,
    })
    return stats
  }

  const textFiles = listFilesByExtension(fixtureDir, ['.xml', '.html'])
  for (const file of textFiles) {
    const body = fs.readFileSync(file, 'utf8')
    const at = new Date().toISOString()
    const endpointKind = endpointKindForFixtureFile(file)
    const classification = classifyCrownTransformText(body)
    const validXml = recordXmlClassification(stats, classification, endpointKind, at)

    if (!validXml) {
      logger.log({
        type: classification.loginExpired ? 'xml-login-expired' : (classification.parseError ? 'xml-parse-error' : 'xml-ignored'),
        at,
        endpointKind,
        sampleFile: path.relative(fixtureDir, file).replace(/\\/g, '/'),
        host: 'fixture',
        ...xmlStatsPayload(stats),
      })
      continue
    }

    const beforeNormalized = stats.normalizedRecords
    const beforeSnapshots = stats.snapshotWrites
    const beforeChanges = stats.changeWrites
    const result = await normalizeAndStore({
      body,
      metadata: {
        method: 'POST',
        url: 'https://m407.mos077.com/transform.php',
        endpointKind,
        capturedAt: at,
        sampleFile: path.relative(fixtureDir, file).replace(/\\/g, '/'),
      },
      leagueConfig,
      defaultLeagues,
      monitorSettings,
      telegramSettings,
      alertsConfig,
      store,
      stats,
      bettingRule,
      bettingCandidatesPath,
    })
    if (result.normalizedCount === 0 && !classification.empty) stats.emptyXmlResponses += 1
    logger.log({
      type: 'xml-response',
      at,
      endpointKind,
      sampleFile: path.relative(fixtureDir, file).replace(/\\/g, '/'),
      host: 'fixture',
      xmlEventCount: classification.gameCount,
      normalizedRecordsDelta: stats.normalizedRecords - beforeNormalized,
      snapshotWritesDelta: stats.snapshotWrites - beforeSnapshots,
      changeWritesDelta: stats.changeWrites - beforeChanges,
      ...xmlStatsPayload(stats),
    })
  }

  return stats
}

async function pollDomAndStore({
  page,
  leagueConfig,
  defaultLeagues,
  trackedMatches = [],
  monitorSettings,
  telegramSettings,
  alertsConfig,
  store,
  stats,
  logger = null,
  zeroDomWarnAfter = 3,
  sessionManager = null,
  bettingRule = null,
  bettingCandidatesPath = '',
  onAlert = null,
}) {
  if (typeof page?.isClosed === 'function' && page.isClosed()) {
    logger?.log({
      type: 'dom-poll-skipped',
      pollAt: new Date().toISOString(),
      reason: 'page-closed',
      errors: stats.errors,
    })
    return null
  }
  const body = await extractFootballTodayFromPage(page)
  const pollAt = body.capturedAt || new Date().toISOString()
  const eventCards = body.counts?.included || 0
  stats.domPolls += 1
  stats.domEvents += eventCards

  const beforeErrors = stats.errors
  const result = await normalizeAndStore({
    body,
    metadata: {
      method: 'DOM',
      url: body.url || 'current-page',
      capturedAt: body.capturedAt,
      sampleFile: 'current-page-dom',
    },
    leagueConfig,
    defaultLeagues,
    trackedMatches,
    monitorSettings,
    telegramSettings,
    alertsConfig,
    store,
    stats,
    bettingRule,
    bettingCandidatesPath,
    onAlert,
  })

  const warnings = []
  if (eventCards === 0) {
    stats.consecutiveZeroDomPolls += 1
    if (zeroDomWarnAfter > 0 && stats.consecutiveZeroDomPolls >= zeroDomWarnAfter) {
      stats.zeroDomWarnings += 1
      warnings.push(`dom-events-empty:${stats.consecutiveZeroDomPolls}`)
      console.warn(`crown-watch warning: ${stats.consecutiveZeroDomPolls} consecutive DOM polls found 0 events; pageHealth=${body.pageHealth?.state || 'unknown'} title=${JSON.stringify(body.title || '')} host=${urlHost(body.url)}`)
    }
  } else {
    stats.consecutiveZeroDomPolls = 0
  }

  const sessionState = classifyCrownSessionState({
    title: body.title,
    url: body.url,
    bodyText: body.bodyText,
    pageHealth: body.pageHealth,
  })
  sessionManager?.markOnline(sessionState.loggedIn ? '正在监控赔率' : sessionState.status)
  if (['Welcome 页面', '登录失效'].includes(sessionState.status)) {
    await sessionManager?.onSessionLost(sessionState.status)
  }

  logger?.log({
    type: 'dom-poll',
    pollAt,
    pageTitle: body.title || '',
    urlHost: urlHost(body.url),
    pageHealth: body.pageHealth || null,
    eventCards,
    normalizedRecords: result.normalizedCount,
    filteredRecords: result.filteredCount,
    changes: result.changes.length,
    errors: stats.errors - beforeErrors,
    warnings,
  })

  return body
}

export async function runDomPollOnce({
  page,
  runtimeDir = 'data/runtime',
  leagueConfigPath = 'config/monitored-leagues.json',
  defaultLeaguesPath = 'config/default-leagues.json',
  monitorSettingsPath = 'config/monitor-settings.json',
  telegramSettingsPath = 'config/telegram-settings.json',
  alertsConfigPath = 'config/alerts.json',
  appDbPath = '',
  bettingCandidatesPath = path.join(runtimeDir, 'betting-candidates.jsonl'),
  runtimeLogPath = '',
  zeroDomWarnAfter = 3,
}) {
  const stats = createWatcherStats()
  const store = makeV1Store(runtimeDir)
  const leagueConfig = loadLeagueConfig(leagueConfigPath)
  const defaultLeagues = loadDefaultLeagues(defaultLeaguesPath)
  const monitorSettings = loadMonitorSettings(monitorSettingsPath)
  const telegramSettings = loadTelegramSettings(telegramSettingsPath)
  const alertsConfig = loadAlertsConfig(alertsConfigPath)
  const logger = makeRuntimeLogger({ runtimeDir, runtimeLogPath })
  const configState = {
    args: { monitorSettingsPath, appDbPath, bettingCandidatesPath },
    current: { monitorSettings },
    mtimes: { monitorSettingsPath: fileMtimeMs(monitorSettingsPath) },
  }
  const bettingRule = loadLegacyRuntimeBettingRule({ appDbPath })

  await pollDomAndStore({
    page,
    leagueConfig,
    defaultLeagues,
    trackedMatches: loadRuntimeTrackedMatches({ appDbPath }),
    monitorSettings,
    telegramSettings,
    alertsConfig,
    store,
    stats,
    logger,
    zeroDomWarnAfter,
    bettingRule,
    bettingCandidatesPath,
    onAlert: ({ mode, at }) => recordMonitorLastAlert(configState, mode, at),
  })

  return stats
}

export function browserLaunchOptions(args = {}) {
  const launchOptions = {
    headless: Boolean(args.headless),
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
    ],
  }
  if (args.chromiumExecutablePath) launchOptions.executablePath = args.chromiumExecutablePath
  else if (args.channel && args.channel !== 'chromium') launchOptions.channel = args.channel
  return launchOptions
}

async function launchContext(args) {
  const { chromium } = await import('playwright')
  fs.mkdirSync(args.profile, { recursive: true })
  return chromium.launchPersistentContext(args.profile, browserLaunchOptions(args))
}

async function pageSessionSnapshot(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || '',
      url: location.href,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
    }))
  } catch {
    return {
      title: await page.title().catch(() => ''),
      url: page.url(),
      bodyText: '',
    }
  }
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    await locator.fill(value, { timeout: 5000 })
    return true
  }
  return false
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count().catch(() => 0) === 0) continue
    if (!(await locator.isVisible().catch(() => false))) continue
    await locator.click({ timeout: 5000 })
    return true
  }
  return false
}

async function submitLoginForm(page) {
  const clicked = await clickFirstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("登入")',
    'button:has-text("Login")',
    'a:has-text("登录")',
    'a:has-text("Login")',
  ])
  if (clicked) return true
  await page.keyboard.press('Enter').catch(() => {})
  return true
}

async function performCrownLogin(page, account, { args, logger, stats } = {}) {
  const now = () => new Date().toISOString()
  const setStatus = (payload) => updateRuntimeMonitorAccount(args, account, payload)
  const loginUrl = account?.loginUrl || args.url

  setStatus({ currentMonitorStatus: '打开网站中', loginStatus: '打开网站中', lastOnlineCheckAt: now() })
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  let state = classifyCrownSessionState(await pageSessionSnapshot(page))
  if (state.humanRequired) {
    setStatus({ currentMonitorStatus: '等待人工验证码', loginStatus: '等待人工验证码', lastOnlineCheckAt: now() })
    logger?.log({ type: 'login-human-verification', at: now(), host: urlHost(loginUrl) })
    return state
  }
  if (state.loggedIn) {
    setStatus({ currentMonitorStatus: '已登录', loginStatus: '已登录', lastLoginAt: now(), lastOnlineCheckAt: now(), consecutiveFailures: 0 })
    return state
  }

  setStatus({ currentMonitorStatus: '填写账号密码中', loginStatus: '填写账号密码中', lastOnlineCheckAt: now() })
  const usernameFilled = await fillFirstVisible(page, [
    'input[name="username"]',
    'input[name="user"]',
    'input[name="userid"]',
    'input[name="account"]',
    'input[name="login"]',
    'input[id*="user" i]',
    'input[id*="account" i]',
    'input[type="text"]',
  ], account.username)
  const passwordFilled = await fillFirstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="passwd"]',
    'input[id*="pass" i]',
  ], account.password || '')

  if (!usernameFilled || !passwordFilled) {
    setStatus({ currentMonitorStatus: '需要人工处理', loginStatus: '登录失效', consecutiveFailures: Number(account.consecutiveFailures || 0) + 1 })
    logger?.log({ type: 'login-form-not-found', at: now(), usernameFilled, passwordFilled, host: urlHost(page.url()) })
    return { status: '需要人工处理', humanRequired: true, loggedIn: false }
  }

  setStatus({ currentMonitorStatus: '提交登录中', loginStatus: '提交登录中', lastOnlineCheckAt: now() })
  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }),
    submitLoginForm(page),
  ])
  await page.waitForTimeout(2000).catch(() => {})

  state = classifyCrownSessionState(await pageSessionSnapshot(page))
  if (state.humanRequired) {
    setStatus({ currentMonitorStatus: '等待人工验证码', loginStatus: '等待人工验证码', lastOnlineCheckAt: now() })
    logger?.log({ type: 'login-human-verification', at: now(), host: urlHost(page.url()) })
    return state
  }

  if (state.status === '登录失效' || state.status === 'Welcome 页面') {
    setStatus({ currentMonitorStatus: state.status, loginStatus: state.status, consecutiveFailures: Number(account.consecutiveFailures || 0) + 1, lastOnlineCheckAt: now() })
    if (stats) stats.errors += 1
    return state
  }

  setStatus({ currentMonitorStatus: '已登录', loginStatus: '已登录', lastLoginAt: now(), lastOnlineCheckAt: now(), consecutiveFailures: 0 })
  return { status: '已登录', humanRequired: false, loggedIn: true }
}

export function parseJsonPayload(payload) {
  if (payload == null) return null
  if (Buffer.isBuffer(payload)) return parseJsonPayload(payload.toString('utf8'))
  if (typeof payload === 'string') {
    const text = payload.trim()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  if (typeof payload === 'object') return payload
  return null
}

function createSessionManager({ page, context, account, args, logger, stats, loginManager }) {
  if (!account) return null
  let reloginRunning = false

  const now = () => new Date().toISOString()
  const refreshAccount = () => loadRuntimeMonitorAccount(args) || account

  return {
    markOnline(status, extra = {}) {
      updateRuntimeMonitorAccount(args, account, {
        currentMonitorStatus: status,
        loginStatus: status === '正在监控赔率' ? '已登录' : status,
        lastOnlineCheckAt: now(),
        ...extra,
      })
    },

    markXmlSuccess({ parsed = false } = {}) {
      const payload = {
        currentMonitorStatus: parsed ? '正在监控赔率' : '已登录',
        loginStatus: '已登录',
        lastOnlineCheckAt: now(),
        lastXmlResponseAt: now(),
        consecutiveFailures: 0,
      }
      if (parsed) payload.lastOddsParsedAt = now()
      updateRuntimeMonitorAccount(args, account, payload)
    },

    async onSessionLost(status) {
      if (reloginRunning) return
      const latest = refreshAccount()
      const autoReloginCount = Number(latest.autoReloginCount || 0)
      const maxAutoReloginCount = Number(latest.maxAutoReloginCount ?? 3)
      updateRuntimeMonitorAccount(args, latest, {
        currentMonitorStatus: status,
        loginStatus: status,
        lastOnlineCheckAt: now(),
        consecutiveFailures: Number(latest.consecutiveFailures || 0) + 1,
      })

      if (!shouldAutoRelogin({ status, autoReloginCount, maxAutoReloginCount })) {
        const nextStatus = status === '等待人工验证码' ? '等待人工验证码' : '需要人工处理'
        updateRuntimeMonitorAccount(args, latest, { currentMonitorStatus: nextStatus, loginStatus: status })
        return
      }

      reloginRunning = true
      try {
        const nextCount = autoReloginCount + 1
        updateRuntimeMonitorAccount(args, latest, {
          currentMonitorStatus: '自动重登中',
          loginStatus: '自动重登中',
          autoReloginCount: nextCount,
        })
        const result = await loginManager.ensureLogin({ page, context, account: latest, logger })
        updateRuntimeMonitorAccountLoginResult(args, latest, result)
        if (!result.ok) {
          updateRuntimeMonitorAccount(args, latest, { currentMonitorStatus: '自动重登失败', loginStatus: result.status })
        }
      } catch (error) {
        if (stats) stats.errors += 1
        logger?.error({ stage: 'login', phase: 'auto-relogin', endpointKind: 'document', message: errorMessage(error), host: urlHost(page.url()) })
        updateRuntimeMonitorAccount(args, latest, { currentMonitorStatus: '自动重登失败', loginStatus: '网络异常' })
      } finally {
        reloginRunning = false
      }
    },
  }
}

async function handleResponse(response, configState, store, stats, logger = null, sessionManager = null) {
  const request = response.request()
  const contentType = response.headers()['content-type'] || ''
  const url = response.url()
  const isJson = /json/i.test(contentType)
  const isCrownXml = /xml|text\/html|text\/plain/i.test(contentType) && /\/transform(?:_nl)?\.php/i.test(url)
  if (!isJson && !isCrownXml) return

  try {
    const body = isJson ? await response.json() : await response.text()
    const endpointKind = requestEndpointKind(request)
    const capturedAt = new Date().toISOString()
    let classification = null
    if (isCrownXml) {
      classification = classifyCrownTransformText(body)
      const validXml = recordXmlClassification(stats, classification, endpointKind, capturedAt)
      if (!validXml) {
        if (classification.loginExpired) await sessionManager?.onSessionLost('登录失效')
        logger?.log({
          type: classification.loginExpired ? 'xml-login-expired' : (classification.parseError ? 'xml-parse-error' : 'xml-ignored'),
          at: capturedAt,
          endpointKind,
          host: urlHost(url),
          ...xmlStatsPayload(stats),
        })
        return
      }
    }

    const beforeNormalized = stats.normalizedRecords
    const beforeSnapshots = stats.snapshotWrites
    const beforeChanges = stats.changeWrites
    const config = configState.current
    const result = await normalizeAndStore({
      body,
      metadata: {
        method: request.method(),
        url,
        endpointKind,
        capturedAt,
      },
      leagueConfig: config.leagueConfig,
      defaultLeagues: config.defaultLeagues,
      trackedMatches: loadRuntimeTrackedMatches(configState.args),
      monitorSettings: config.monitorSettings,
      telegramSettings: config.telegramSettings,
      alertsConfig: config.alertsConfig,
      store,
      stats,
      bettingRule: loadLegacyRuntimeBettingRule(configState.args),
      bettingCandidatesPath: configState.args.bettingCandidatesPath,
      onAlert: ({ mode, at }) => recordMonitorLastAlert(configState, mode, at),
    })
    if (isCrownXml) {
      if (result.normalizedCount === 0 && !classification.empty) stats.emptyXmlResponses += 1
      sessionManager?.markXmlSuccess({ parsed: result.normalizedCount > 0 })
      logger?.log({
        type: 'xml-response',
        at: capturedAt,
        endpointKind,
        host: urlHost(url),
        xmlEventCount: classification.gameCount,
        normalizedRecordsDelta: stats.normalizedRecords - beforeNormalized,
        snapshotWritesDelta: stats.snapshotWrites - beforeSnapshots,
        changeWritesDelta: stats.changeWrites - beforeChanges,
        ...xmlStatsPayload(stats),
      })
    }
  } catch (error) {
    stats.errors += 1
    logger?.error({
      stage: 'response',
      endpointKind: isJson ? 'json-response' : 'xml-response',
      message: errorMessage(error),
      host: urlHost(url),
    })
  }
}

async function handleWebSocketFrame(payload, url, configState, store, stats, logger = null) {
  try {
    const body = parseJsonPayload(payload)
    if (!body) return
    const config = configState.current
    await normalizeAndStore({
      body,
      metadata: {
        method: 'WS',
        url,
        capturedAt: new Date().toISOString(),
      },
      leagueConfig: config.leagueConfig,
      defaultLeagues: config.defaultLeagues,
      trackedMatches: loadRuntimeTrackedMatches(configState.args),
      monitorSettings: config.monitorSettings,
      telegramSettings: config.telegramSettings,
      alertsConfig: config.alertsConfig,
      store,
      stats,
      bettingRule: loadLegacyRuntimeBettingRule(configState.args),
      bettingCandidatesPath: configState.args.bettingCandidatesPath,
      onAlert: ({ mode, at }) => recordMonitorLastAlert(configState, mode, at),
    })
  } catch (error) {
    stats.errors += 1
    logger?.error({
      stage: 'websocket',
      endpointKind: 'ws-frame',
      message: errorMessage(error),
      host: urlHost(url),
    })
  }
}

function logStats(stats) {
  console.log(`crown-watch xmlResponses=${stats.xmlResponses} getGameListCount=${stats.getGameListCount} getGameMoreCount=${stats.getGameMoreCount} xmlEvents=${stats.xmlEvents} normalizedRecords=${stats.normalizedRecords} snapshotWrites=${stats.snapshotWrites} changeWrites=${stats.changeWrites} parseErrors=${stats.parseErrors} emptyXmlResponses=${stats.emptyXmlResponses} loginExpiredResponses=${stats.loginExpiredResponses} lastXmlAt=${stats.lastXmlAt || 'null'} lastSnapshotAt=${stats.lastSnapshotAt || 'null'} responses=${stats.responsesSeen} candidates=${stats.candidateResponses} domPolls=${stats.domPolls} domEvents=${stats.domEvents} filtered=${stats.filteredRecords} oddsChanges=${stats.oddsChanges} zeroDomWarnings=${stats.zeroDomWarnings} alerts=${stats.alertTriggers} skipped=${JSON.stringify(stats.skippedAlerts)} errors=${stats.errors}`)
}

function waitForAbortOrTimeout(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('aborted')
    let settled = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(reason)
    }
    const onAbort = () => finish('aborted')
    const timer = setTimeout(() => finish('timeout'), milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForProcessStop(signal) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    if (signal?.aborted) finish()
    else signal?.addEventListener('abort', finish, { once: true })
  })
}

function activeTrackedEventKeys(trackedMatches = []) {
  return new Set((trackedMatches || [])
    .filter((item) => item?.trackingStatus === 'active')
    .map((item) => String(item?.eventKey || '').trim())
    .filter(Boolean))
}

function gameMoreTargetFromSnapshot(snapshot) {
  const ids = snapshot?.event?.ids || {}
  const lid = String(ids.lid || '').trim()
  const ecid = String(ids.ecid || '').trim()
  if (!lid || !ecid) return null
  const mode = snapshot?.mode || (snapshot?.event?.status === 'live' ? 'live' : 'prematch')
  const live = mode === 'live'
  return {
    eventKey: snapshot?.event?.eventKey || '',
    lid,
    ecid,
    mode,
    showtype: live ? 'live' : 'today',
    isRB: live ? 'Y' : 'N',
  }
}

export function buildGameMoreTargets(snapshots = [], { trackedMatches = [], maxTargets = 8 } = {}) {
  const max = Math.max(0, Number(maxTargets || 0))
  if (!max) return []
  const trackedKeys = activeTrackedEventKeys(trackedMatches)
  const byEvent = new Map()
  for (const snapshot of snapshots || []) {
    const target = gameMoreTargetFromSnapshot(snapshot)
    if (!target?.eventKey || byEvent.has(target.eventKey)) continue
    byEvent.set(target.eventKey, {
      ...target,
      tracked: trackedKeys.has(target.eventKey),
    })
  }
  return [...byEvent.values()]
    .sort((a, b) => Number(b.tracked) - Number(a.tracked) || Number(b.mode === 'live') - Number(a.mode === 'live'))
    .slice(0, max)
}

async function normalizeDirectXml({
  body,
  endpointKind,
  at,
  pollId,
  requestScope,
  systemTime = '',
  baseUrl,
  config,
  configState,
  trackedMatches = [],
  stateStore,
  auditStore,
  alertSettingsWatcher = null,
  stats,
  logger,
  logExtra = {},
}) {
  stats.responsesSeen += 1
  stats.candidateResponses += 1
  const result = await processDirectXmlV2({
    body,
    endpointKind,
    capturedAt: at,
    pollId,
    requestScope,
    stateStore,
    auditStore,
    metadata: {
      method: 'POST',
      url: `${baseUrl}/transform.php`,
      endpointKind,
      capturedAt: at,
      systemTime,
    },
  })
  const classification = result.classification
  const validXml = recordXmlClassification(stats, classification, endpointKind, at)
  const beforeNormalized = stats.normalizedRecords
  const beforeSnapshots = stats.snapshotWrites
  const beforeChanges = stats.changeWrites
  const filtered = config.leagueConfig
    ? filterByLeague(result.records, config.leagueConfig)
    : { kept: result.records }
  stats.normalizedRecords += result.normalizedCount
  stats.filteredRecords += filtered.kept.length
  stats.snapshots += result.snapshots.length
  stats.snapshotWrites += result.snapshots.length
  stats.oddsChanges += result.changes.filter((change) => change.type === 'odds-change').length
  stats.changeWrites += result.changes.length
  if (result.snapshots.length) {
    stats.lastSnapshotAt = result.snapshots.at(-1)?.capturedAt || at
  }
  const signalResult = persistDirectV2Signals({
    changes: result.changes,
    stateStore,
    monitorSettings: config.monitorSettings,
    defaultLeagues: config.defaultLeagues,
    trackedMatches,
    alertSettingsWatcher,
  })
  result.signals = signalResult.inserted
  result.signalPersistence = signalResult
  stats.alertTriggers += signalResult.inserted.length
  if (!validXml) {
    logger.log({
      type: classification.loginExpired ? 'xml-login-expired' : (classification.parseError ? 'xml-parse-error' : 'xml-ignored'),
      at,
      endpointKind,
      host: urlHost(baseUrl),
      source: 'direct-api',
      ...logExtra,
      ...xmlStatsPayload(stats),
    })
    return { classification, result }
  }
  if (result.normalizedCount === 0 && !classification.empty) stats.emptyXmlResponses += 1
  logger.log({
    type: 'xml-response',
    at,
    endpointKind,
    host: urlHost(baseUrl),
    source: 'direct-api',
    ...logExtra,
    xmlEventCount: classification.gameCount,
    normalizedRecordsDelta: stats.normalizedRecords - beforeNormalized,
    snapshotWritesDelta: stats.snapshotWrites - beforeSnapshots,
    changeWritesDelta: stats.changeWrites - beforeChanges,
    ...xmlStatsPayload(stats),
  })
  return { classification, result }
}

export async function runDirectApiPollOnce(args, {
  stats,
  configState,
  logger,
  monitorAccount,
  apiLoginManager,
  stateStore,
  auditStore,
  createPollId = randomUUID,
  now = () => new Date().toISOString(),
  loadMonitorAccount = loadRuntimeMonitorAccount,
  loadTrackedMatches = loadRuntimeTrackedMatches,
  alertSettingsWatcher = null,
  updateMonitorAccount = updateRuntimeMonitorAccount,
} = {}) {
  const at = now()
  const pollId = createPollId()
  const loginExpiredBefore = stats.loginExpiredResponses
  try {
    const currentAccount = loadMonitorAccount(args) || monitorAccount
    const fetchResult = await apiLoginManager.fetchFootballToday({ account: currentAccount, logger })
    const baseUrl = normalizeCrownBaseUrl(currentAccount.loginUrl)
    const config = configState.current
    const trackedMatches = loadTrackedMatches(args)
    const list = await normalizeDirectXml({
      body: fetchResult.text,
      endpointKind: 'get_game_list',
      at,
      pollId,
      requestScope: fetchResult.requestScope,
      baseUrl,
      config,
      configState,
      trackedMatches,
      stateStore,
      auditStore,
      alertSettingsWatcher,
      stats,
      logger,
    })
    if (!list.result?.applied) {
      const loginExpired = list.classification.loginExpired === true
      updateMonitorAccount(args, currentAccount, {
        currentMonitorStatus: loginExpired ? '登录失效' : '赔率数据异常',
        loginStatus: loginExpired ? '登录失效' : '已登录',
        lastOnlineCheckAt: at,
        lastXmlResponseAt: at,
        consecutiveFailures: Number(currentAccount.consecutiveFailures || 0) + 1,
      })
      return { ok: false, reason: loginExpired ? 'login_expired' : 'data_quality', pollId, list, details: [], stats }
    }

    let detailNormalizedCount = 0
    let detailFailures = 0
    let pollSession = fetchResult.session
    const details = []
    const targets = buildGameMoreTargets(list.result.snapshots, {
      trackedMatches,
      maxTargets: args.maxGameMore,
    })
    for (const target of targets) {
      const detailAt = now()
      try {
        const detail = await apiLoginManager.fetchFootballGameMore({
          account: currentAccount,
          session: pollSession,
          target,
          logger,
        })
        pollSession = detail.session || pollSession
        const stored = await normalizeDirectXml({
          body: detail.text,
          endpointKind: 'get_game_more',
          at: detailAt,
          pollId,
          requestScope: detail.requestScope,
          systemTime: list.result.systemTime,
          baseUrl,
          config,
          configState,
          trackedMatches,
          stateStore,
          auditStore,
          alertSettingsWatcher,
          stats,
          logger,
          logExtra: {
            eventKey: target.eventKey,
            lid: target.lid,
            ecid: target.ecid,
            showtype: target.showtype,
            isRB: target.isRB,
            tracked: target.tracked,
          },
        })
        details.push(stored)
        if (!stored.result?.applied && stored.classification.loginExpired) {
          const error = new Error('crown detail session expired')
          error.code = 'failed_login'
          throw error
        }
        if (!stored.result?.applied) {
          detailFailures += 1
          stats.errors += 1
          logger.error({
            stage: 'direct-api',
            phase: 'poll-detail-data-quality',
            endpointKind: 'get_game_more',
            message: 'crown detail XML is incomplete or malformed',
            host: urlHost(baseUrl),
            eventKey: target.eventKey,
            lid: target.lid,
            ecid: target.ecid,
          })
          continue
        }
        detailNormalizedCount += stored.result?.normalizedCount || 0
      } catch (detailError) {
        if (detailError?.code === 'failed_login') throw detailError
        detailFailures += 1
        stats.errors += 1
        logger.error({
          stage: 'direct-api',
          phase: 'poll-detail',
          endpointKind: 'get_game_more',
          message: errorMessage(detailError),
          host: urlHost(baseUrl),
          eventKey: target.eventKey,
          lid: target.lid,
          ecid: target.ecid,
        })
      }
    }
    if (detailFailures > 0) {
      const degraded = {
        currentMonitorStatus: '赔率数据异常',
        loginStatus: '已登录',
        lastOnlineCheckAt: at,
        lastXmlResponseAt: at,
        consecutiveFailures: Number(currentAccount.consecutiveFailures || 0) + 1,
      }
      if (list.result.normalizedCount > 0 || detailNormalizedCount > 0) degraded.lastOddsParsedAt = at
      updateMonitorAccount(args, currentAccount, degraded)
      return { ok: false, reason: 'detail_data_quality', pollId, list, details, pollSession, stats }
    }
    const healthy = {
      currentMonitorStatus: '正在监控赔率',
      loginStatus: '已登录',
      lastOnlineCheckAt: at,
      lastXmlResponseAt: at,
      consecutiveFailures: 0,
    }
    if (list.result.normalizedCount > 0 || detailNormalizedCount > 0) healthy.lastOddsParsedAt = at
    updateMonitorAccount(args, currentAccount, healthy)
    return { ok: true, pollId, list, details, pollSession, stats }
  } catch (error) {
    stats.errors += 1
    const latest = loadMonitorAccount(args) || monitorAccount
    const loginExpired = error?.code === 'failed_login'
    if (loginExpired && stats.loginExpiredResponses === loginExpiredBefore) stats.loginExpiredResponses += 1
    logger.error({ stage: 'direct-api', phase: 'poll', endpointKind: 'get_game_list', message: errorMessage(error), host: urlHost(latest.loginUrl) })
    updateMonitorAccount(args, latest, {
      currentMonitorStatus: loginExpired ? '登录失效' : '网络异常',
      loginStatus: loginExpired ? '登录失效' : '网络异常',
      lastOnlineCheckAt: at,
      consecutiveFailures: Number(latest.consecutiveFailures || 0) + 1,
    })
    return { ok: false, reason: loginExpired ? 'login_expired' : 'network', pollId, error, stats }
  }
}

export async function runDirectApiWatch(args, { stats, configState, logger, monitorAccount }, dependencies = {}) {
  let stateStore = null
  let auditStore = null
  let dispatcher = null
  let reloadInterval = null
  let statsInterval = null
  let pollInterval = null
  let stopHandler = null
  let pollRunning = false
  let dispatcherStarted = false
  try {
    stateStore = dependencies.stateStore || (dependencies.createStateStore
      ? dependencies.createStateStore({ dbPath: args.appDbPath })
      : openMonitorStateStore({ dbPath: args.appDbPath }))
    auditStore = dependencies.auditStore || (dependencies.createAuditStore
      ? dependencies.createAuditStore({ runtimeDir: args.runtimeDir })
      : createMonitorAuditStore({ runtimeDir: args.runtimeDir }))
    if (dependencies.dispatcher) {
      dispatcher = dependencies.dispatcher
    } else if (typeof stateStore?.claimPendingDeliveries === 'function') {
      dispatcher = dependencies.createDispatcher
        ? dependencies.createDispatcher({ stateStore, configState })
        : createDirectV2AlertDispatcher({ stateStore, configState })
    }
    const apiLoginManager = dependencies.apiLoginManager || new CrownApiLoginManager({ runtimeDir: args.runtimeDir })
    const updateLoginResult = dependencies.updateLoginResult || updateRuntimeMonitorAccountLoginResult
    const pollDependencies = {
      ...dependencies,
      stats,
      configState,
      logger,
      monitorAccount,
      apiLoginManager,
      stateStore,
      auditStore,
      alertSettingsWatcher: dependencies.alertSettingsWatcher || (stateStore.db ? new AlertSettingsWatcher(stateStore.db) : null),
    }
    const pollOnce = async () => {
      if (pollRunning) return null
      pollRunning = true
      try {
        return await runDirectApiPollOnce(args, pollDependencies)
      } finally {
        pollRunning = false
      }
    }
    const loginResult = await apiLoginManager.ensureLogin({ account: monitorAccount, logger })
    updateLoginResult(args, monitorAccount, loginResult)
    if (args.loginTest || !loginResult.ok) return stats
    if (dependencies.signal?.aborted) return stats
    if (typeof dispatcher?.start === 'function') {
      dispatcherStarted = true
      if (dispatcher.start() === false) dispatcherStarted = false
    }

    const pollSeconds = Math.max(1, Number(args.domPollSeconds || monitorAccount?.oddsScanIntervalSeconds || 10))
    reloadInterval = args.configReloadSeconds > 0
      ? setInterval(() => safeReloadRuntimeConfig(configState, logger), args.configReloadSeconds * 1000)
      : null
    statsInterval = setInterval(() => logStats(stats), 30_000)

    if (args.maxSeconds > 0) {
      const deadline = Date.now() + args.maxSeconds * 1000
      while (!dependencies.signal?.aborted && Date.now() < deadline) {
        await pollOnce()
        const remaining = deadline - Date.now()
        if (remaining > 0) await waitForAbortOrTimeout(Math.min(pollSeconds * 1000, remaining), dependencies.signal)
      }
      return stats
    }

    await pollOnce()
    if (dependencies.signal?.aborted) return stats
    pollInterval = setInterval(pollOnce, pollSeconds * 1000)
    console.log('crown-watch direct API mode is running. Press Ctrl+C to stop.')
    await new Promise((resolve) => {
      stopHandler = resolve
      process.once('SIGINT', stopHandler)
      process.once('SIGTERM', stopHandler)
      if (dependencies.signal?.aborted) resolve()
      else dependencies.signal?.addEventListener('abort', resolve, { once: true })
    })
    return stats
  } finally {
    if (stopHandler) {
      process.off('SIGINT', stopHandler)
      process.off('SIGTERM', stopHandler)
      dependencies.signal?.removeEventListener('abort', stopHandler)
    }
    if (pollInterval) clearInterval(pollInterval)
    if (statsInterval) clearInterval(statsInterval)
    if (reloadInterval) clearInterval(reloadInterval)
    try {
      if (dispatcherStarted) await dispatcher?.stop?.()
    } finally {
      try {
        auditStore?.close?.()
      } finally {
        stateStore?.close?.()
      }
    }
    if (args.maxSeconds > 0 || args.loginTest) logStats(stats)
  }
}

export async function runLiveWatch(args, dependencies = {}) {
  const stats = createWatcherStats()
  const configState = createRuntimeConfigState(args)
  const logger = makeRuntimeLogger(args)
  const monitorAccount = (dependencies.loadMonitorAccount || loadRuntimeMonitorAccount)(args)
  if (monitorAccount?.loginUrl) args.url = monitorAccount.loginUrl
  if (monitorAccount?.oddsScanIntervalSeconds && !args.domPollSecondsSet) {
    args.domPollSeconds = Number(monitorAccount.oddsScanIntervalSeconds)
  }
  const stateRouting = resolveMonitorStateRouting(args)
  if (stateRouting.useDirectApiV2) {
    if (!monitorAccount?.username || !monitorAccount?.password) {
      throw new Error('schema-v2 live monitor requires an existing enabled monitor account with username and password; use --monitor-state-version 1 only for deprecated legacy DOM rollback')
    }
    return (dependencies.runDirectApiWatch || runDirectApiWatch)(args, { stats, configState, logger, monitorAccount }, {
      ...dependencies.directDependencies,
      signal: dependencies.signal || dependencies.directDependencies?.signal,
    })
  }

  const legacyBettingRule = (dependencies.loadLegacyBettingRule || loadLegacyRuntimeBettingRule)(args)
  const store = makeV1Store(args.runtimeDir)
  const context = await (dependencies.launchContext || launchContext)(args)
  const page = context.pages()[0] || await context.newPage()
  const loginManager = new CrownLoginManager({ runtimeDir: args.runtimeDir })
  const sessionManager = createSessionManager({ page, context, account: monitorAccount, args, logger, stats, loginManager })
  let loginReady = false

  page.on('response', (response) => {
    if (!loginReady) return
    handleResponse(response, configState, store, stats, logger, sessionManager)
  })
  page.on('websocket', (webSocket) => {
    webSocket.on('framereceived', (event) => handleWebSocketFrame(event.payload, webSocket.url(), configState, store, stats, logger))
  })

  const interval = setInterval(() => logStats(stats), 30_000)
  const reloadInterval = args.configReloadSeconds > 0
    ? setInterval(() => safeReloadRuntimeConfig(configState, logger), args.configReloadSeconds * 1000)
    : null
  try {
    if (monitorAccount?.username && monitorAccount?.password) {
      const loginResult = await loginManager.ensureLogin({
        page,
        context,
        account: monitorAccount,
        logger,
      })
      updateRuntimeMonitorAccountLoginResult(args, monitorAccount, loginResult)
      loginReady = loginResult.ok
      if (args.loginTest) {
        clearInterval(interval)
        if (reloadInterval) clearInterval(reloadInterval)
        await context.close()
        logStats(stats)
        return stats
      }
      if (!loginResult.ok) console.warn(`login failed: ${loginResult.status}`)
    } else {
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      loginReady = true
    }
  } catch (error) {
    stats.errors += 1
    logger.error({ stage: 'page-open', endpointKind: 'document', message: errorMessage(error), host: urlHost(args.url) })
    await sessionManager?.onSessionLost('网络异常')
    console.warn(`open page failed: ${error.message}`)
    if (args.loginTest) {
      clearInterval(interval)
      if (reloadInterval) clearInterval(reloadInterval)
      await context.close().catch(() => {})
      logStats(stats)
      return stats
    }
  }

  if (dependencies.signal?.aborted) {
    clearInterval(interval)
    if (reloadInterval) clearInterval(reloadInterval)
    await context.close().catch(() => {})
    return stats
  }

  let domPollRunning = false
  const runDomPoll = async () => {
    if (domPollRunning) return
    domPollRunning = true
    try {
      if (!loginReady) {
        logger.log({
          type: 'dom-poll-skipped',
          pollAt: new Date().toISOString(),
          reason: 'login-not-ready',
          errors: stats.errors,
        })
        return
      }
      const config = configState.current
      await (dependencies.pollDomAndStore || pollDomAndStore)({
        page,
        leagueConfig: config.leagueConfig,
        defaultLeagues: config.defaultLeagues,
        trackedMatches: (dependencies.loadTrackedMatches || loadRuntimeTrackedMatches)(args),
        monitorSettings: config.monitorSettings,
        telegramSettings: config.telegramSettings,
        alertsConfig: config.alertsConfig,
        store,
        stats,
        logger,
        zeroDomWarnAfter: args.zeroDomWarnAfter,
        sessionManager,
        bettingRule: legacyBettingRule,
        bettingCandidatesPath: stateRouting.candidatesPath,
        onAlert: ({ mode, at }) => recordMonitorLastAlert(configState, mode, at),
      })
    } catch (error) {
      stats.errors += 1
      logger.error({ stage: 'dom', phase: 'poll', endpointKind: 'dom-football', message: errorMessage(error), host: urlHost(page.url()) })
      console.warn(`DOM poll failed: ${error.message}`)
    } finally {
      domPollRunning = false
    }
  }
  let domInterval = null
  if (args.domPollSeconds > 0) {
    await runDomPoll()
    if (!dependencies.signal?.aborted) domInterval = setInterval(runDomPoll, args.domPollSeconds * 1000)
  }

  if (dependencies.signal?.aborted) {
    clearInterval(interval)
    if (reloadInterval) clearInterval(reloadInterval)
    if (domInterval) clearInterval(domInterval)
    await context.close()
    return stats
  }

  if (args.maxSeconds > 0) {
    await waitForAbortOrTimeout(args.maxSeconds * 1000, dependencies.signal)
    clearInterval(interval)
    if (reloadInterval) clearInterval(reloadInterval)
    if (domInterval) clearInterval(domInterval)
    await context.close()
    logStats(stats)
    return stats
  }

  console.log('crown-watch is running. Press Ctrl+C to stop.')
  await waitForProcessStop(dependencies.signal)
  clearInterval(interval)
  if (reloadInterval) clearInterval(reloadInterval)
  if (domInterval) clearInterval(domInterval)
  await context.close()
  return stats
}

export async function runWithWatcherLease(args, dependencies = {}) {
  const ttlMs = dependencies.watcherLeaseTtlMs ?? 15_000
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 2) throw new TypeError('watcher-lease-ttl')
  const resolvedDbPath = path.resolve(String(args.appDbPath || ''))
  const databaseExists = dependencies.watcherDatabaseExists || fs.existsSync
  if (!args.appDbPath || !databaseExists(resolvedDbPath)) throw new Error('watcher-db-missing')
  const openDatabase = dependencies.openWatcherDatabase || openAppDatabase
  const handle = openDatabase({ dbPath: resolvedDbPath })
  const leaseKey = watcherLeaseKey({ dbPath: handle.dbPath || args.appDbPath, runtimeDir: args.runtimeDir })
  const lease = dependencies.createWatcherLease
    ? dependencies.createWatcherLease({ db: handle.db, leaseKey, ttlMs, now: dependencies.watcherLeaseNow })
    : new RuntimeLease({ db: handle.db, leaseKey, ttlMs, now: dependencies.watcherLeaseNow || (() => new Date()) })
  const controller = new AbortController()
  const inheritedSignal = dependencies.signal
  const forwardAbort = () => controller.abort(inheritedSignal?.reason)
  if (inheritedSignal?.aborted) forwardAbort()
  else inheritedSignal?.addEventListener('abort', forwardAbort, { once: true })
  const scheduleHeartbeat = dependencies.setWatcherHeartbeatInterval || setInterval
  const clearHeartbeat = dependencies.clearWatcherHeartbeatInterval || clearInterval
  const heartbeatMs = Math.max(1, Math.floor(ttlMs / 3))
  let acquired = false
  let heartbeatTimer = null
  let leaseFailed = false
  let leaseFailure = null
  try {
    lease.acquire()
    acquired = true
    heartbeatTimer = scheduleHeartbeat(() => {
      if (leaseFailed) return
      try {
        lease.heartbeat()
      } catch (error) {
        leaseFailed = true
        leaseFailure = error
        controller.abort(error)
      }
    }, heartbeatMs)
    heartbeatTimer?.unref?.()
    emitLegacyMonitorWarning(args, { warn: dependencies.warn || console.warn })
    const watch = dependencies.runLiveWatch || runLiveWatch
    let result
    try {
      result = await watch(args, { ...dependencies, signal: controller.signal })
    } catch (error) {
      if (leaseFailure) throw leaseFailure
      throw error
    }
    if (leaseFailure) throw leaseFailure
    return result
  } finally {
    if (heartbeatTimer !== null) clearHeartbeat(heartbeatTimer)
    inheritedSignal?.removeEventListener('abort', forwardAbort)
    if (acquired) lease.release()
    handle.close()
  }
}

export async function executeFromArgs(args, dependencies = {}) {
  if (args.fromFixture) {
    emitLegacyMonitorWarning(args, { warn: dependencies.warn || console.warn })
    const stats = await (dependencies.runFixtureWatch || runFixtureWatch)({
      fixtureDir: args.fromFixture,
      runtimeDir: args.runtimeDir,
      leagueConfigPath: args.leagueConfigPath,
      defaultLeaguesPath: args.defaultLeaguesPath,
      monitorSettingsPath: args.monitorSettingsPath,
      telegramSettingsPath: args.telegramSettingsPath,
      alertsConfigPath: args.alertsConfigPath,
      bettingCandidatesPath: args.bettingCandidatesPath,
    })
    if (dependencies.logStats !== false) logStats(stats)
    return stats
  }

  return runWithWatcherLease(args, dependencies)
}

async function main() {
  if (process.env.CROWN_PORTABLE !== '1') loadProjectEnv({ cwd: APP_DIR })
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  await executeFromArgs(args)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
