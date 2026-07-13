import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { handleAppApi } from '../src/crown/app/app-api.mjs'
import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'
import { requestRealBettingStart } from '../src/crown/betting/real-betting-runtime.mjs'

const TEST_DASHBOARD_PASSWORD = 'app-api-test-password'
const TEST_DASHBOARD_SALT = Buffer.from('app-api-security-salt')
const TEST_DASHBOARD_PASSWORD_SCRYPT = `scrypt:${TEST_DASHBOARD_SALT.toString('base64url')}:${scryptSync(TEST_DASHBOARD_PASSWORD, TEST_DASHBOARD_SALT, 32).toString('base64url')}`
const securityByOrigin = new Map()

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

async function withAppServer(t, handler, env = {}, extraAppOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-api-'))
  const staticDir = path.join(dir, 'public')
  const runtimeDir = path.join(dir, 'runtime')
  const configPath = path.join(dir, 'monitored-leagues.json')
  const defaultLeaguesPath = path.join(dir, 'default-leagues.json')
  const monitorSettingsPath = path.join(dir, 'monitor-settings.json')
  const telegramSettingsPath = path.join(dir, 'telegram-settings.json')
  const dbPath = path.join(dir, 'crown.sqlite')
  const separateDataDbPath = path.join(dir, 'current-state.sqlite')
  const {
    prepareDatabase,
    prepareDataDatabase,
    writeRuntimeJsonl = true,
    useSeparateDataDatabase = false,
    useEnvDefaultDatabase = false,
    lightweightSecurityContext = false,
    ...appOptions
  } = extraAppOptions
  const dataDbPath = useSeparateDataDatabase ? separateDataDbPath : dbPath
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Crown App</title>', 'utf8')
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, include: [], exclude: [] }), 'utf8')
  fs.writeFileSync(defaultLeaguesPath, JSON.stringify({
    version: 1,
    leagues: [
      { name: '英超', aliases: [], enabled: true, autoTrack: true, modes: ['prematch', 'live'] },
      { name: '停用联赛', aliases: [], enabled: false, autoTrack: true, modes: ['prematch'] },
    ],
  }), 'utf8')
  fs.writeFileSync(monitorSettingsPath, JSON.stringify({
    version: 1,
    runningMode: null,
    handicap: { enabled: false, activePeriods: ['prematch'], waterMoveThreshold: 0.03 },
    live: { enabled: false, waterMoveThreshold: 0.03, liveMinuteFrom: 10, liveMinuteTo: 75 },
  }), 'utf8')
  fs.writeFileSync(telegramSettingsPath, JSON.stringify({
    version: 1,
    oddsAlert: { enabled: false, botName: '赔率波动报警机器人', botToken: '', chatId: '', parseMode: 'HTML', testMessage: 'test' },
    betSuccess: { enabled: false, botName: '投注成功通知机器人', botToken: '', chatId: '', parseMode: 'HTML', testMessage: 'test' },
  }), 'utf8')
  if (writeRuntimeJsonl) {
    writeJsonl(path.join(runtimeDir, 'crown-odds-snapshots.jsonl'), [{
      provider: 'crown',
      mode: 'prematch',
      capturedAt: '2026-07-08T00:00:00.000Z',
      event: { league: '英超', homeTeam: '主队', awayTeam: '客队', status: 'open' },
      market: { marketId: 'm1', marketType: 'asian_handicap', handicapRaw: '+0' },
      selection: { selectionId: 's1', side: 'home', oddsRaw: '0.94' },
    }])
    writeJsonl(path.join(runtimeDir, 'crown-odds-changes.jsonl'), [])
  }

  if (typeof prepareDatabase === 'function') {
    const handle = openAppDatabase({ dbPath })
    try {
      prepareDatabase(handle.db)
    } finally {
      handle.close()
    }
  }
  if (useSeparateDataDatabase) {
    const handle = openAppDatabase({ dbPath: dataDbPath })
    try {
      if (typeof prepareDataDatabase === 'function') prepareDataDatabase(handle.db)
    } finally {
      handle.close()
    }
  }

  const server = createDashboardServer({
    staticDir,
    appOptions: {
      ...(useEnvDefaultDatabase ? {} : { dbPath }),
      env: {
        ...(useEnvDefaultDatabase ? { CROWN_DB_PATH: dbPath } : {}),
        CROWN_LOCAL_SECRET_KEY_PATH: path.join(dir, 'local-secret.key'),
        CROWN_DASHBOARD_PASSWORD_SCRYPT: TEST_DASHBOARD_PASSWORD_SCRYPT,
        CROWN_DASHBOARD_SESSION_KEY: 'app-api-test-session-signing-key',
        ...env,
      },
      ...appOptions,
    },
    dataOptions: {
      snapshotPath: path.join(runtimeDir, 'crown-odds-snapshots.jsonl'),
      changesPath: path.join(runtimeDir, 'crown-odds-changes.jsonl'),
      configPath,
      defaultLeaguesPath,
      monitorSettingsPath,
      telegramSettingsPath,
      ...(useSeparateDataDatabase ? { dbPath: dataDbPath } : {}),
    },
  })
  t.after(() => server.close())

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`
  const login = await fetch(`${baseUrl}/api/app/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ password: TEST_DASHBOARD_PASSWORD }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]
  const securityContext = await fetch(`${baseUrl}/api/app/${lightweightSecurityContext ? 'security-context' : 'bootstrap'}`, { headers: { cookie } })
  const csrfToken = (await securityContext.json()).csrfToken
  assert.match(csrfToken, /^[A-Za-z0-9_-]{32,}$/)
  securityByOrigin.set(baseUrl, { cookie, csrfToken })
  try {
    await handler(baseUrl, {
      monitorSettingsPath,
      defaultLeaguesPath,
      snapshotPath: path.join(runtimeDir, 'crown-odds-snapshots.jsonl'),
      changesPath: path.join(runtimeDir, 'crown-odds-changes.jsonl'),
      dbPath,
      dataDbPath,
    })
  } finally {
    securityByOrigin.delete(baseUrl)
  }
}

function seedBatchProjection(db) {
  const now = '2026-07-11T02:00:00.000Z'
  db.prepare("INSERT INTO betting_rules (id, name, currency, amount_scale, target_amount_minor, created_at, updated_at) VALUES ('rule-api', 'API rule', 'CNY', 2, 5000, ?, ?)").run(now, now)
  db.prepare("INSERT INTO monitor_signals (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json) VALUES ('signal-api', 'key-api', 'strategy', 1, 'ready', ?, ?, '{}')").run(now, '2026-07-11T02:05:00.000Z')
  db.prepare("INSERT INTO betting_accounts (id, label, username, currency, amount_scale, per_bet_limit_minor, stake_step_minor, created_at, updated_at) VALUES ('account-api', 'API account', 'api-user', 'CNY', 2, 5000, 50, ?, ?)").run(now, now)
  db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, currency, amount_scale, target_amount_minor,
      accepted_amount_minor, status, finish_reason, created_at, finished_at
    ) VALUES ('batch-api', 'signal-api', 'rule-api', 'CNY', 2, 5000, 5000, 'completed', 'target_filled', ?, ?)
  `).run(now, '2026-07-11T02:02:00.000Z')
  db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor, preview_balance_minor,
      preview_stake_step_minor, preview_odds, provider_reference_ciphertext,
      status, created_at, resolved_at
    ) VALUES ('child-api', 'batch-api', 'account-api', 5000, 100, 5000, 20000, 50, '0.88', 'must-not-leak', 'accepted', ?, ?)
  `).run(now, '2026-07-11T02:02:00.000Z')
}

function seedAcceptedTodayAccount(db) {
  const createdAt = '2026-07-11T00:00:00.000Z'
  db.prepare("INSERT INTO betting_rules (id, name, currency, amount_scale, target_amount_minor, created_at, updated_at) VALUES ('rule-today', 'Today rule', 'CNY', 2, 5000, ?, ?)").run(createdAt, createdAt)
  db.prepare("INSERT INTO betting_accounts (id, label, username, currency, amount_scale, per_bet_limit_minor, stake_step_minor, created_at, updated_at) VALUES ('account-today', 'Today account', 'today-user', 'CNY', 2, 5000, 50, ?, ?)").run(createdAt, createdAt)
  db.prepare("INSERT INTO monitor_signals (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json) VALUES ('signal-today', 'key-today', 'strategy', 1, 'ready', ?, ?, '{}')").run(createdAt, '2026-07-20T00:00:00.000Z')
  db.prepare("INSERT INTO bet_batches (batch_id, signal_id, rule_id, currency, amount_scale, target_amount_minor, accepted_amount_minor, status, created_at, finished_at) VALUES ('batch-today', 'signal-today', 'rule-today', 'CNY', 2, 5000, 5000, 'completed', ?, ?)").run(createdAt, '2026-07-11T16:05:00.000Z')
  db.prepare("INSERT INTO bet_child_orders (child_order_id, batch_id, account_id, requested_amount_minor, status, created_at, resolved_at) VALUES ('child-today', 'batch-today', 'account-today', 5000, 'accepted', ?, ?)").run(createdAt, '2026-07-11T16:05:00.000Z')
}

function seedCurrentOddsProjection(db) {
  const capturedAt = '2026-07-13T12:05:00.000Z'
  const event = {
    eventKey: 'sqlite-event',
    league: '英超',
    homeTeam: 'SQLite 主队',
    awayTeam: 'SQLite 客队',
    mode: 'prematch',
    status: 'not_started',
    startTimeRaw: '2026-07-13 20:00:00',
    startTimeUtc: '2026-07-13T12:00:00.000Z',
    timeConfidence: 'high',
  }
  const snapshot = {
    schemaVersion: 2,
    provider: 'crown',
    sport: 'football',
    mode: 'prematch',
    capturedAt,
    event,
    market: {
      marketIdentity: 'sqlite-event|full_time|asian_handicap|RATIO_R',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '+0.5',
    },
    selection: {
      selectionIdentity: 'sqlite-home',
      side: 'home',
      oddsRaw: '0.97',
      odds: 0.97,
    },
  }
  db.prepare(`INSERT INTO monitor_scope_state
    (scope_key, last_batch_id, last_captured_at, last_complete_at, event_keys_json)
    VALUES (?, ?, ?, ?, ?)`)
    .run('scope-api', 'batch-api-current', capturedAt, capturedAt, JSON.stringify(['sqlite-event']))
  db.prepare(`INSERT INTO monitor_event_state
    (event_key, active, missing_count, last_seen_at, provider_ids_json, event_json)
    VALUES (?, 1, 0, ?, '{}', ?)`)
    .run('sqlite-event', capturedAt, JSON.stringify(event))
  db.prepare(`INSERT INTO monitor_selection_state
    (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)`)
    .run('sqlite-home', 'sqlite-event', capturedAt, JSON.stringify(snapshot))
  db.prepare(`INSERT INTO monitor_signals
    (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json)
    VALUES ('runtime-signal', 'runtime-key', 'runtime', 1, 'ready', ?, ?, '{}')`)
    .run(capturedAt, '2026-07-13T12:10:00.000Z')
  db.prepare(`INSERT INTO monitor_candidates
    (candidate_id, signal_id, status, export_status, created_at, exported_at, payload_json)
    VALUES ('runtime-candidate', 'runtime-signal', 'ready', 'pending', ?, '', '{}')`)
    .run(capturedAt)
  db.prepare(`INSERT INTO monitor_deliveries
    (signal_id, channel, status, attempts, next_attempt_at, last_error_code, updated_at)
    VALUES ('runtime-signal', 'telegram', 'pending', 0, ?, '', ?)`)
    .run(capturedAt, capturedAt)
}

async function jsonFetch(url, options = {}) {
  const security = securityByOrigin.get(new URL(url).origin)
  const method = String(options.method || 'GET').toUpperCase()
  const mutationHeaders = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && security
    ? { origin: new URL(url).origin, 'x-csrf-token': security.csrfToken }
    : {}
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(security ? { cookie: security.cookie } : {}),
      ...mutationHeaders,
      ...(options.headers || {}),
    },
  })
  const payload = await response.json()
  return { response, payload }
}

async function directAppApi({ dbPath, method, pathname, body, env, now = () => new Date('2026-07-11T00:00:00.000Z') }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  let statusCode = 0
  let responseBody = ''
  const res = {
    writeHead(status) { statusCode = status },
    end(chunk = '') { responseBody += String(chunk) },
  }
  await handleAppApi(req, res, new URL(pathname, 'http://127.0.0.1'), { dbPath, env, now })
  return { status: statusCode, payload: JSON.parse(responseBody) }
}

test('operations summary API keeps the item envelope and exposes only safe separated settings', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-operations-api-')), 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  handle.db.exec(`
    UPDATE monitor_alert_settings SET migration_review_required=0;
    UPDATE auto_betting_settings SET migration_review_required=0;
    UPDATE monitor_alert_settings SET enabled=1, asian_handicap_enabled=1 WHERE mode='prematch';
    UPDATE auto_betting_settings SET enabled=1, target_odds_min='0.8', target_odds_max='1.1',
      target_amount_minor=100, real_eligible=1, version=4, real_eligibility_version=6 WHERE mode='prematch'
  `)
  handle.db.exec('DELETE FROM auto_betting_rule_card_leagues; DELETE FROM auto_betting_rule_cards')
  const time = '2026-07-12T00:00:00.000Z'
  handle.db.prepare(`INSERT INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,remark,
    real_eligible,real_eligibility_version,real_eligibility_updated_at,migration_review_required,
    migration_review_reason,version,created_at,updated_at
  ) VALUES ('card','card',1,'0.8','1.1',100,'CNY',0,'',0,1,?,0,'',1,?,?)`).run(time, time, time)
  handle.db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('card','英超',?),('card','西甲',?)").run(time, time)
  handle.close()

  const response = await directAppApi({ dbPath, method: 'GET', pathname: '/api/app/operations-summary' })
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.payload), ['item'])
  assert.deepEqual(response.payload.item.monitorAlerts.prematch, {
    enabled: true, reviewRequired: false, markets: { asianHandicap: true, total: false },
  })
  assert.deepEqual(response.payload.item.ruleCards, { total: 1, enabled: 1, reviewRequired: 0, ownedLeagues: 2 })
  assert.equal('autoBetting' in response.payload.item, false)
  assert.doesNotMatch(JSON.stringify(response.payload), /targetOdds|targetAmount|remark|migrationReviewReason|authorization|capabilityEvidence|secret/i)
})

test('manual runtime cleanup API previews and applies only on explicit POST', async (t) => {
  const calls = []
  const runtimeCleanup = {
    preview() { calls.push('preview'); return { bytes: 1234, files: 7, categories: { 'monitor-history': 900 } } },
    async run() { calls.push('run'); return { bytes: 1234, files: 7, categories: { 'monitor-history': 900 }, databaseRows: {}, restartedWatcher: true, cleanedAt: '2026-07-12T04:00:00.000Z' } },
  }
  await withAppServer(t, async (baseUrl, { defaultLeaguesPath, snapshotPath, changesPath }) => {
    const preview = await jsonFetch(`${baseUrl}/api/app/runtime-cache-cleanup`)
    assert.equal(preview.response.status, 200)
    assert.equal(preview.payload.item.bytes, 1234)
    assert.deepEqual(calls, ['preview'])

    const applied = await jsonFetch(`${baseUrl}/api/app/runtime-cache-cleanup`, { method: 'POST', body: '{}' })
    assert.equal(applied.response.status, 200)
    assert.equal(applied.payload.item.restartedWatcher, true)
    assert.deepEqual(calls, ['preview', 'run'])
  }, {}, { runtimeCleanup })
})

test('bootstrap exposes canonical templates through sanitized auto-bet DTOs', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-canonical-bootstrap-')), 'crown.sqlite')
  const response = await directAppApi({ dbPath, method: 'GET', pathname: '/api/app/auto-bet-rules' })
  assert.equal(response.status, 200)
  assert.ok(response.payload.items.some((item) => item.migrationReviewRequired === true))
  const serialized = JSON.stringify(response.payload)
  for (const field of ['amountScale', 'stakeStep', 'bettingRuleId', 'providerReference', 'authorization']) {
    assert.equal(serialized.includes(field), false, field)
  }
})

test('legacy canonical create API is retired without changing historical reads', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-canonical-create-switches-')), 'crown.sqlite')
  const base = {
    name: 'API create switches', mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home',
    minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100,
    leagueNames: ['英超'], startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5,
  }
  const created = await directAppApi({
    dbPath, method: 'POST', pathname: '/api/app/auto-bet-rules',
    body: { ...base, monitorEnabled: true, realBettingEnabled: true },
  })
  assert.equal(created.status, 410)
  assert.deepEqual(created.payload, { error: 'rule-api-retired' })

  const listed = await directAppApi({ dbPath, method: 'GET', pathname: '/api/app/auto-bet-rules' })
  assert.equal(listed.status, 200)
  assert.equal(listed.payload.items.some((item) => item.name === 'API create switches'), false)

  const invalid = await directAppApi({
    dbPath, method: 'POST', pathname: '/api/app/auto-bet-rules',
    body: { ...base, name: 'invalid API real only', monitorEnabled: false, realBettingEnabled: true },
  })
  assert.equal(invalid.status, 410)
  assert.deepEqual(invalid.payload, { error: 'rule-api-retired' })
})

test('direct app API retires betting-rule CRUD and real-eligibility before handler execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-api-execution-'))
  const dbPath = path.join(dir, 'crown.sqlite')
  const env = {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '2',
    CROWN_REAL_MAX_TOTAL_MINOR: '1000',
  }
  const handle = openAppDatabase({ dbPath })
  const repo = createAppRepository(handle.db, { secretKey: 'test-secret-key-with-more-than-32-characters' })
  const rule = repo.createBettingRule({
    name: 'API real eligibility rule',
    enabled: true,
    leagueNames: ['API League'],
    targetAmount: '1.00',
    currency: 'CNY',
    amountScale: 2,
  })
  handle.close()

  for (const [method, pathname] of [
    ['POST', '/api/app/betting-rules'],
    ['PUT', `/api/app/betting-rules/${rule.id}`],
    ['DELETE', `/api/app/betting-rules/${rule.id}`],
    ['POST', `/api/app/betting-rules/${rule.id}/real-eligibility`],
  ]) {
    const result = await directAppApi({ dbPath, env, method, pathname, body: { forged: 'payload' } })
    assert.deepEqual(result, { status: 410, payload: { error: 'rule-api-retired' } })
  }
  const listed = await directAppApi({ dbPath, env, method: 'GET', pathname: '/api/app/betting-rules' })
  assert.equal(listed.status, 200)
  assert.equal(listed.payload.items.some((item) => item.id === rule.id), true)
})

test('app API bootstraps odds and persisted configuration', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const tracked = await jsonFetch(`${baseUrl}/api/app/tracked-matches`, {
      method: 'POST',
      body: JSON.stringify({
        eventKey: 'crown|英超|主队|客队|prematch',
        league: '英超',
        homeTeam: '主队',
        awayTeam: '客队',
        mode: 'prematch',
        sourceStatus: 'open',
        tracked: true,
      }),
    })
    assert.equal(tracked.response.status, 200)
    assert.equal(tracked.payload.item.trackingStatus, 'active')

    const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
    assert.equal(bootstrap.response.status, 200)
    assert.equal(bootstrap.payload.trackedMatches.length, 1)
    assert.equal(bootstrap.payload.oddsSummary.totals.events, 1)
    assert.equal(bootstrap.payload.events.items.length, 1)
    assert.equal(bootstrap.payload.oddsSummary.monitorHealth.available, true)
    assert.equal(bootstrap.payload.oddsSummary.monitorHealth.state.events.total, 0)
  })
})

test('app API creates, updates, and deletes monitor accounts and rules', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const account = await jsonFetch(`${baseUrl}/api/app/monitor-accounts`, {
      method: 'POST',
      body: JSON.stringify({
        label: '主监控账号',
        username: 'monitor-user',
        loginUrl: 'https://monitor.example.com',
        status: 'enabled',
        secret: 'monitor-password',
      }),
    })
    assert.equal(account.response.status, 200)
    assert.equal(account.payload.item.hasSecret, true)
    assert.equal(JSON.stringify(account.payload).includes('monitor-password'), false)

    const updatedAccount = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/${account.payload.item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: '备用监控账号', status: 'disabled' }),
    })
    assert.equal(updatedAccount.payload.item.label, '备用监控账号')

    const rule = await jsonFetch(`${baseUrl}/api/app/monitor-rules`, {
      method: 'POST',
      body: JSON.stringify({ name: '英超变化', enabled: true, leagueFilter: '英超', minOddsChange: 0.05, pollSeconds: 8 }),
    })
    assert.equal(rule.response.status, 200)
    assert.equal(rule.payload.item.name, '英超变化')

    const updatedRule = await jsonFetch(`${baseUrl}/api/app/monitor-rules/${rule.payload.item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '英超变化更新', pollSeconds: 12 }),
    })
    assert.equal(updatedRule.payload.item.name, '英超变化更新')
    assert.equal(updatedRule.payload.item.pollSeconds, 12)

    const deletedRule = await jsonFetch(`${baseUrl}/api/app/monitor-rules/${rule.payload.item.id}`, { method: 'DELETE' })
    assert.deepEqual(deletedRule.payload, { ok: true })

    const deletedAccount = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/${account.payload.item.id}`, { method: 'DELETE' })
    assert.deepEqual(deletedAccount.payload, { ok: true })
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' })
})

test('manual-login API routes inherit security guards, reject payload fields, stay watcher-off, and return safe status only', async (t) => {
  const calls = []
  const monitorProcess = {
    start() { calls.push({ type: 'watcher-start' }) },
    stop() { calls.push({ type: 'watcher-stop' }) },
  }
  const unsafeStatus = (status, errorCode = '') => ({
    challengeId: 'challenge-safe',
    accountId: 'mon_owner',
    status,
    errorCode,
    expiresAt: 61_000,
    origin: 'https://monitor.example.com',
    password: 'raw-password',
    cookies: { SID: 'raw-cookie' },
    uid: 'raw-uid',
    nonce: 'raw-nonce',
    raw: '<serverresponse>raw</serverresponse>',
  })
  const humanLoginController = {
    async openManualLogin(input) { calls.push({ type: 'open', ...input }); return unsafeStatus('awaiting-user') },
    getManualLoginStatus(input) { calls.push({ type: 'status', ...input }); return unsafeStatus('awaiting-user') },
    async confirmManualLogin(input) { calls.push({ type: 'confirm', ...input }); return unsafeStatus('verified') },
    async cancelManualLogin(input) { calls.push({ type: 'cancel', ...input }); return unsafeStatus('failed', 'manual-login-cancelled') },
  }

  await withAppServer(t, async (baseUrl) => {
    const opened = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/open`, {
      method: 'POST', body: '{}',
    })
    assert.equal(opened.response.status, 200)
    assert.deepEqual(opened.payload.item, {
      challengeId: 'challenge-safe', accountId: 'mon_owner', status: 'awaiting-user', errorCode: '', expiresAt: 61_000,
    })

    const status = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/challenge-safe`)
    assert.equal(status.response.status, 200)
    assert.equal(status.payload.item.status, 'awaiting-user')

    const unauthenticatedStatus = await fetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/challenge-safe`)
    assert.equal(unauthenticatedStatus.status, 401)
    assert.deepEqual(await unauthenticatedStatus.json(), { error: 'authentication-required' })

    const confirmed = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/challenge-safe/confirm`, {
      method: 'POST', body: '{}',
    })
    assert.equal(confirmed.response.status, 200)
    assert.equal(confirmed.payload.item.status, 'verified')

    const cancelled = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/challenge-safe/cancel`, {
      method: 'POST', body: '{}',
    })
    assert.equal(cancelled.response.status, 200)
    assert.equal(cancelled.payload.item.errorCode, 'manual-login-cancelled')

    for (const response of [opened, status, confirmed, cancelled]) {
      assert.deepEqual(Object.keys(response.payload.item), ['challengeId', 'accountId', 'status', 'errorCode', 'expiresAt'])
      assert.doesNotMatch(JSON.stringify(response.payload), /raw-password|raw-cookie|raw-uid|raw-nonce|serverresponse|"origin"/i)
    }
    assert.equal(calls.some((call) => call.type.startsWith('watcher-')), false)

    const forbiddenBody = await jsonFetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/open`, {
      method: 'POST', body: JSON.stringify({ password: 'must-not-enter-route' }),
    })
    assert.equal(forbiddenBody.response.status, 400)
    assert.deepEqual(forbiddenBody.payload, {
      error: 'validation-error', fields: { password: 'password is not allowed' },
    })
    assert.doesNotMatch(JSON.stringify(forbiddenBody.payload), /must-not-enter-route/)

    const security = securityByOrigin.get(baseUrl)
    const missingOrigin = await fetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/open`, {
      method: 'POST',
      headers: { cookie: security.cookie, 'x-csrf-token': security.csrfToken, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(missingOrigin.status, 403)
    assert.deepEqual(await missingOrigin.json(), { error: 'origin-required' })

    const badCsrf = await fetch(`${baseUrl}/api/app/monitor-accounts/mon_owner/manual-login/open`, {
      method: 'POST',
      headers: { cookie: security.cookie, origin: baseUrl, 'x-csrf-token': 'wrong', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(badCsrf.status, 403)
    assert.deepEqual(await badCsrf.json(), { error: 'csrf-invalid' })
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, {
    monitorProcess,
    humanLoginController,
  })
})

test('monitor account API rejects default-scheme and path-truncating URLs', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    for (const loginUrl of ['monitor.example.com', 'https://monitor.example.com/login']) {
      const result = await jsonFetch(`${baseUrl}/api/app/monitor-accounts`, {
        method: 'POST',
        body: JSON.stringify({ label: 'invalid', username: 'owner', loginUrl, secret: 'password' }),
      })
      assert.equal(result.response.status, 400)
      assert.equal(result.payload.error, 'validation-error')
      assert.equal(Object.hasOwn(result.payload.fields, 'loginUrl'), true)
    }
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' })
})

test('app API exposes one Crown monitor account position with runtime status actions', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const saved = await jsonFetch(`${baseUrl}/api/app/monitor-account`, {
      method: 'PUT',
      body: JSON.stringify({
        label: 'Primary Crown monitor',
        username: 'monitor-user',
        loginUrl: 'https://monitor.example.com',
        enabled: true,
        secret: 'monitor-password',
        oddsScanIntervalSeconds: 9,
        maxAutoReloginCount: 3,
      }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.payload.item.label, 'Primary Crown monitor')
    assert.equal(saved.payload.item.enabled, true)
    assert.equal(saved.payload.item.hasSecret, true)
    assert.equal(saved.payload.item.oddsScanIntervalSeconds, 9)
    assert.equal(saved.payload.item.maxAutoReloginCount, 3)
    assert.equal(saved.payload.item.currentMonitorStatus, '未启动')
    assert.equal(JSON.stringify(saved.payload).includes('monitor-password'), false)

    const start = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    })
    assert.equal(start.payload.item.currentMonitorStatus, '打开网站中')

    const clear = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'clear-state' }),
    })
    assert.equal(clear.payload.item.currentMonitorStatus, '未启动')
    assert.equal(clear.payload.item.consecutiveFailures, 0)
    assert.equal(clear.payload.item.autoReloginCount, 0)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' })
})

test('app API preserves exact monitor origin and starts or stops the watcher process', async (t) => {
  const processCalls = []
  const monitorProcess = {
    start(options) {
      processCalls.push({ type: 'start', ...options })
      return { running: true, pid: 12345 }
    },
    stop() {
      processCalls.push({ type: 'stop' })
      return { stopped: true }
    },
  }

  await withAppServer(t, async (baseUrl) => {
    const saved = await jsonFetch(`${baseUrl}/api/app/monitor-account`, {
      method: 'PUT',
      body: JSON.stringify({
        label: 'Primary Crown monitor',
        username: 'monitor-user',
        loginUrl: 'https://m407.mos077.com',
        enabled: true,
        secret: 'monitor-password',
      }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.payload.item.loginUrl, 'https://m407.mos077.com')

    const start = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    })
    assert.equal(start.response.status, 200)
    assert.equal(processCalls[0].type, 'start')
    assert.equal(processCalls[0].action, 'start')
    assert.equal(processCalls[0].restart, true)
    assert.match(processCalls[0].dbPath, /crown\.sqlite$/)

    const stop = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'stop' }),
    })
    assert.equal(stop.response.status, 200)
    assert.deepEqual(processCalls[1], { type: 'stop' })
  }, { CROWN_SECRET_KEY: '' }, { monitorProcess })
})

test('monitor relogin waits for delayed watcher exit before starting a replacement', async (t) => {
  const events = []
  let releaseExit
  const exitGate = new Promise((resolve) => { releaseExit = resolve })
  let running = true
  const monitorProcess = {
    stop() { events.push('sync-stop') },
    async stopAndWait() {
      events.push('stop-wait')
      await exitGate
      running = false
      events.push('old-exit')
      return { stopped: true }
    },
    isRunning: () => running,
    start() {
      events.push(running ? 'start-before-exit' : 'start-after-exit')
      running = true
      return { running: true }
    },
  }

  await withAppServer(t, async (baseUrl) => {
    await jsonFetch(`${baseUrl}/api/app/monitor-account`, {
      method: 'PUT',
      body: JSON.stringify({
        label: 'Primary Crown monitor', username: 'monitor-user', loginUrl: 'https://m407.mos077.com',
        enabled: true, secret: 'monitor-password',
      }),
    })
    const relogin = jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST', body: JSON.stringify({ action: 'relogin' }),
    })
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const beforeExit = [...events]
    releaseExit()
    const result = await relogin

    assert.deepEqual(beforeExit, ['stop-wait'])
    assert.equal(result.response.status, 200)
    assert.deepEqual(events, ['stop-wait', 'old-exit', 'start-after-exit'])
  }, { CROWN_SECRET_KEY: '' }, { monitorProcess })
})

test('monitor relogin returns a stable unsafe error and never starts a replacement', async (t) => {
  const events = []
  const monitorProcess = {
    stop() { events.push('sync-stop') },
    async stopAndWait() {
      events.push('stop-wait')
      const error = new Error('watcher-stop-unsafe')
      error.code = 'watcher-stop-unsafe'
      throw error
    },
    isRunning: () => true,
    start() { events.push('start'); return { running: true } },
  }

  await withAppServer(t, async (baseUrl) => {
    await jsonFetch(`${baseUrl}/api/app/monitor-account`, {
      method: 'PUT',
      body: JSON.stringify({
        label: 'Primary Crown monitor', username: 'monitor-user', loginUrl: 'https://m407.mos077.com',
        enabled: true, secret: 'monitor-password',
      }),
    })
    const result = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST', body: JSON.stringify({ action: 'relogin' }),
    })

    assert.equal(result.response.status, 503)
    assert.deepEqual(result.payload, { error: 'watcher-stop-unsafe' })
    assert.deepEqual(events, ['stop-wait'])
  }, { CROWN_SECRET_KEY: '' }, { monitorProcess })
})

test('app API waits for test-login short run and returns LoginResult plus diagnostics', async (t) => {
  const monitorProcess = {
    async runLoginTest(options) {
      const diagnosticPath = path.join(path.dirname(options.dbPath), 'login-diagnostics', '20260709-000000-mon_primary')
      fs.mkdirSync(diagnosticPath, { recursive: true })
      fs.writeFileSync(path.join(diagnosticPath, 'snapshot.json'), JSON.stringify({
        title: 'Welcome',
        inputs: [{ name: 'username', value: 'monitor-user' }],
        cookies: [{ name: 'uid', value: 'cookie-uid' }],
        account: { username: 'monitor-user', password: 'monitor-password' },
      }), 'utf8')

      const handle = openAppDatabase({ dbPath: options.dbPath })
      try {
        const repo = createAppRepository(handle.db, { secretKey: 'api-secret-key-with-more-than-32-characters' })
        repo.updateMonitorAccountLoginResult('mon_primary', {
          ok: true,
          accountId: 'mon_primary',
          status: '已登录',
          loginMethod: 'cookies',
          cookieStatus: '已加载',
          storageStateStatus: '已加载',
          xmlVerified: true,
          sessionVerified: true,
          diagnosticPath,
          startedAt: '2026-07-09T00:00:00.000Z',
          finishedAt: '2026-07-09T00:00:02.000Z',
          message: '',
        })
      } finally {
        handle.close()
      }
      return { ok: true }
    },
  }

  await withAppServer(t, async (baseUrl) => {
    await jsonFetch(`${baseUrl}/api/app/monitor-account`, {
      method: 'PUT',
      body: JSON.stringify({
        label: 'Primary Crown monitor',
        username: 'monitor-user',
        loginUrl: 'https://m407.mos077.com',
        enabled: true,
        secret: 'monitor-password',
      }),
    })

    const login = await jsonFetch(`${baseUrl}/api/app/monitor-account/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'test-login' }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.payload.loginResult.status, '已登录')
    assert.equal(login.payload.item.lastLoginResult.loginMethod, 'cookies')

    const diagnostics = await jsonFetch(`${baseUrl}/api/app/monitor-account/login-diagnostics`)
    assert.equal(diagnostics.response.status, 200)
    assert.equal(diagnostics.payload.item.schemaVersion, 2)
    assert.equal(diagnostics.payload.item.accountId, 'mon_primary')
    assert.equal(diagnostics.payload.item.page.formControlCount, 1)
    const serialized = JSON.stringify(diagnostics.payload)
    assert.doesNotMatch(serialized, /monitor-user|monitor-password|cookie-uid/)
    assert.doesNotMatch(serialized, /"(?:cookies?|storageState|password|inputs?|bodyText|extraDebug|authorization)"/i)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, { monitorProcess })
})

test('app API stores secret values with an auto-generated local key when CROWN_SECRET_KEY is missing', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const account = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST',
      body: JSON.stringify({
        label: '投注账号',
        username: 'bet-user',
        secret: 'must-not-store',
        perBetLimit: '100',
        currency: 'CNY',
      }),
    })

    assert.equal(account.response.status, 200, JSON.stringify(account.payload))
    assert.equal(account.payload.item.hasSecret, true)
    assert.equal(JSON.stringify(account.payload).includes('must-not-store'), false)
  }, { CROWN_SECRET_KEY: '' })
})

test('app API exposes decimal-string account contracts while retired rule mutation stays closed', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const rule = await jsonFetch(`${baseUrl}/api/app/betting-rules`, {
      method: 'POST',
      body: JSON.stringify({
        name: '只预览',
        enabled: true,
        leagueNames: [' 英超 ', '英超'],
        targetAmount: '100.00',
        currency: 'CNY',
        amountScale: 2,
        changedOddsMin: '0.80',
        changedOddsMax: '1.10',
      }),
    })
    assert.equal(rule.response.status, 410)
    assert.deepEqual(rule.payload, { error: 'rule-api-retired' })

    const updatedRule = await jsonFetch(`${baseUrl}/api/app/betting-rules/retired-rule`, {
      method: 'PUT',
      body: JSON.stringify({ executionMode: 'real_eligible' }),
    })
    assert.equal(updatedRule.response.status, 410)
    assert.equal(updatedRule.payload.error, 'rule-api-retired')

    const account = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST',
      body: JSON.stringify({
        label: '人工复核账号',
        username: 'bet-user',
        websiteUrl: 'https://example.test',
        status: 'enabled',
        betOrder: 1,
        perBetLimit: '100',
        currency: 'CNY',
        secret: 'bet-secret',
      }),
    })
    assert.equal(account.payload.item.hasSecret, true)
    assert.equal(typeof account.payload.item.perBetLimit, 'string')
    assert.equal(Object.hasOwn(account.payload.item, 'stakeStep'), false)
    assert.equal(account.payload.item.balance, null)
    assert.equal(account.payload.item.acceptedTodayCount, 0)
    assert.equal(account.payload.item.acceptedTodayAmount, '0')
    assert.equal(Object.hasOwn(account.payload.item, 'dailyLimit'), false)
    assert.equal(JSON.stringify(account.payload).includes('bet-secret'), false)

    const updatedAccount = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${account.payload.item.id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: '人工复核账号更新', status: 'disabled' }),
    })
    assert.equal(updatedAccount.payload.item.label, '人工复核账号更新')
    assert.equal(updatedAccount.payload.item.acceptedTodayCount, 0)
    assert.equal(updatedAccount.payload.item.acceptedTodayAmount, '0')

    const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
    assert.equal(bootstrap.payload.bettingRules.filter((item) => item.id === 'retired-rule').length, 0)
    for (const templateId of ['legacy-prematch', 'legacy-live']) {
      const templates = bootstrap.payload.bettingRules.filter((item) => item.id === templateId)
      assert.equal(templates.length, 1, templateId)
      assert.equal(templates[0].enabled, false, `${templateId}.enabled`)
      assert.equal(templates[0].executionMode, 'preview_only', `${templateId}.executionMode`)
    }
    assert.equal(bootstrap.payload.bettingAccounts.length, 1)
    assert.deepEqual(bootstrap.payload.bettingHistory, [])

    assert.deepEqual((await jsonFetch(`${baseUrl}/api/app/betting-rules/retired-rule`, { method: 'DELETE' })).payload, { error: 'rule-api-retired' })
    assert.deepEqual((await jsonFetch(`${baseUrl}/api/app/betting-accounts/${account.payload.item.id}`, { method: 'DELETE' })).payload, { ok: true })
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' })
})

test('app API checks one betting account access and returns only persisted display health', async (t) => {
  const checked = []
  await withAppServer(t, async (baseUrl) => {
    const created = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST',
      body: JSON.stringify({
        username: 'access-user', websiteUrl: 'https://access.example.test', status: 'disabled', betOrder: 0,
        perBetLimit: '100', currency: 'CNY', secret: 'access-password',
      }),
    })
    const accountId = created.payload.item.id
    const response = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${accountId}/actions`, {
      method: 'POST', body: JSON.stringify({ action: 'check-access' }),
    })

    assert.equal(response.response.status, 200)
    assert.equal(checked.length, 1)
    assert.equal(checked[0].id, accountId)
    assert.equal(checked[0].password, 'access-password')
    assert.deepEqual(response.payload.result, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '1950', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    })
    assert.equal(response.payload.item.accessStatus, 'available')
    assert.equal(response.payload.item.reportedBalance, '1950')
    assert.equal(response.payload.item.balance, null)
    assert.doesNotMatch(JSON.stringify(response.payload), /access-password|uid|cookies|session|raw/i)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, {
    bettingAccountAccessChecker: {
      async check(account) {
        checked.push(account)
        return { ok: true, status: 'available', errorCode: '', reportedBalance: '1950', reportedCurrency: 'CNY', balanceSource: 'account-summary' }
      },
    },
  })
})

test('account pause and enable APIs use the fresh access chain and expose no Crown raw fields', async (t) => {
  const checked = []
  await withAppServer(t, async (baseUrl) => {
    const created = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST',
      body: JSON.stringify({
        username: 'action-user', websiteUrl: 'https://access.example.test', status: 'enabled', betOrder: 1,
        perBetLimit: '100', currency: 'CNY', secret: 'action-password',
      }),
    })
    const accountId = created.payload.item.id
    const paused = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${accountId}/pause`, { method: 'POST', body: '{}' })
    assert.equal(paused.response.status, 200)
    assert.equal(paused.payload.item.allocationStatus, 'paused')

    const enabled = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${accountId}/enable`, { method: 'POST', body: '{}' })
    assert.equal(enabled.response.status, 200)
    assert.equal(enabled.payload.item.allocationStatus, 'enabled')
    assert.equal(enabled.payload.item.accessStatus, 'available')
    assert.deepEqual(checked, [{ id: accountId, username: 'action-user', password: 'action-password' }])
    assert.doesNotMatch(JSON.stringify(enabled.payload), /action-password|uid-secret|cookie-secret|rawLogin/i)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, {
    bettingAccountAccessChecker: {
      async check(account) {
        checked.push({ id: account.id, username: account.username, password: account.password })
        return {
          ok: true, status: 'available', errorCode: '', reportedBalance: '1950', reportedCurrency: 'CNY',
          balanceSource: 'account-summary', rawLogin: 'uid-secret cookie-secret',
        }
      },
    },
  })
})

test('account enable API explains a missing positive per-bet limit', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const response = await jsonFetch(`${baseUrl}/api/app/betting-accounts/legacy-zero-limit/enable`, {
      method: 'POST', body: '{}',
    })

    assert.equal(response.response.status, 400)
    assert.deepEqual(response.payload, { error: 'betting-account-limit-required' })
  }, {}, { prepareDatabase(db) {
    const now = '2026-07-12T05:00:00.000Z'
    db.prepare(`
      INSERT INTO betting_accounts (
        id, label, username, website_url, bet_order, status, per_bet_limit_minor,
        currency, amount_scale, stake_step_minor, secret_ciphertext, created_at, updated_at
      ) VALUES ('legacy-zero-limit', 'legacy', 'legacy', 'https://example.test', 1, 'enabled', 0,
        'CNY', 0, 1, 'non-empty-legacy-ciphertext', ?, ?)
    `).run(now, now)
  } })
})

test('account enable API keeps the account paused and returns balance-unavailable without raw provider text', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const created = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST', body: JSON.stringify({
        username: 'no-balance', websiteUrl: 'https://access.example.test', status: 'enabled', betOrder: 1,
        perBetLimit: '100', currency: 'CNY', secret: 'secret-value',
      }),
    })
    await jsonFetch(`${baseUrl}/api/app/betting-accounts/${created.payload.item.id}/pause`, { method: 'POST', body: '{}' })
    const enabled = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${created.payload.item.id}/enable`, { method: 'POST', body: '{}' })
    assert.equal(enabled.payload.item.allocationStatus, 'paused')
    assert.equal(enabled.payload.result.errorCode, 'balance-unavailable')
    assert.doesNotMatch(JSON.stringify(enabled.payload), /secret-value|raw crown failure/i)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, {
    bettingAccountAccessChecker: { async check() {
      return { ok: true, status: 'available', reportedBalance: null, reportedCurrency: 'USD', raw: 'raw crown failure' }
    } },
  })
})

test('account enable API safely migrates a legacy disabled account only after fresh access succeeds', async (t) => {
  let checks = 0
  await withAppServer(t, async (baseUrl) => {
    const created = await jsonFetch(`${baseUrl}/api/app/betting-accounts`, {
      method: 'POST', body: JSON.stringify({
        username: 'legacy-disabled', websiteUrl: 'https://access.example.test', status: 'disabled', betOrder: 1,
        perBetLimit: '100', currency: 'CNY', secret: 'legacy-password',
      }),
    })
    const enabled = await jsonFetch(`${baseUrl}/api/app/betting-accounts/${created.payload.item.id}/enable`, { method: 'POST', body: '{}' })
    assert.equal(enabled.response.status, 200)
    assert.equal(enabled.payload.item.status, 'enabled')
    assert.equal(enabled.payload.item.allocationStatus, 'enabled')
    assert.equal(checks, 1)
  }, { CROWN_SECRET_KEY: 'api-secret-key-with-more-than-32-characters' }, {
    bettingAccountAccessChecker: { async check() {
      checks += 1
      return { ok: true, status: 'available', errorCode: '', reportedBalance: '100', reportedCurrency: 'CNY', balanceSource: 'account-summary' }
    } },
  })
})

test('concurrent retired betting-rule saves both return stable 410', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const body = (name, leagueName) => JSON.stringify({
      name, enabled: true, leagueNames: [leagueName], targetAmount: '50.00', currency: 'CNY', amountScale: 2,
    })
    const [a, b] = await Promise.all([
      jsonFetch(`${baseUrl}/api/app/betting-rules`, { method: 'POST', body: body('A', '英超') }),
      jsonFetch(`${baseUrl}/api/app/betting-rules`, { method: 'POST', body: body('B', '英超') }),
    ])
    assert.deepEqual([a.response.status, b.response.status], [410, 410])
    assert.deepEqual(a.payload, { error: 'rule-api-retired' })
    assert.deepEqual(b.payload, { error: 'rule-api-retired' })

    const alias = await jsonFetch(`${baseUrl}/api/app/betting-rules`, { method: 'POST', body: body('Alias', '英格兰超级联赛') })
    assert.equal(alias.response.status, 410)
  })
})

test('retired betting-rule mutations cannot create or change historical rule state', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const body = (name, enabled, leagueNames) => JSON.stringify({
      name, enabled, leagueNames, targetAmount: '50.00', currency: 'CNY', amountScale: 2,
    })
    const disabled = await jsonFetch(`${baseUrl}/api/app/betting-rules`, {
      method: 'POST',
      body: body('停用规则', false, ['A']),
    })
    assert.equal(disabled.response.status, 410)
    assert.deepEqual(disabled.payload, { error: 'rule-api-retired' })

    const changed = await jsonFetch(`${baseUrl}/api/app/betting-rules/retired-rule`, {
      method: 'PUT',
      body: JSON.stringify({ leagueNames: ['B'] }),
    })
    assert.deepEqual(changed.payload, { error: 'rule-api-retired' })

    const ownerA = await jsonFetch(`${baseUrl}/api/app/betting-rules`, {
      method: 'POST',
      body: body('A 所有者', true, ['A']),
    })
    assert.equal(ownerA.response.status, 410)

    const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
    assert.equal(bootstrap.payload.bettingRules.some((rule) => rule.id === 'retired-rule'), false)

    const ownerB = await jsonFetch(`${baseUrl}/api/app/betting-rules`, {
      method: 'POST',
      body: body('B 所有者', true, ['B']),
    })
    assert.equal(ownerB.response.status, 410)
    const conflict = await jsonFetch(`${baseUrl}/api/app/betting-rules/retired-rule`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(conflict.response.status, 410)
    assert.deepEqual(conflict.payload, { error: 'rule-api-retired' })

    const afterConflict = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
    assert.equal(afterConflict.payload.bettingRules.some((rule) => rule.id === 'retired-rule'), false)
  })
})

test('app API exposes masked decimal-string batch and child projections', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const batches = await jsonFetch(`${baseUrl}/api/app/bet-batches?limit=10`)
    assert.equal(batches.response.status, 200)
    assert.equal(batches.payload.items[0].batchId, 'batch-api')
    assert.equal(batches.payload.items[0].targetAmount, '50.00')
    assert.equal(batches.payload.items[0].acceptedAmount, '50.00')
    assert.equal(batches.payload.items[0].finishReason, 'target_filled')
    assert.equal(Object.hasOwn(batches.payload.items[0], 'targetAmountMinor'), false)

    const children = await jsonFetch(`${baseUrl}/api/app/bet-batches/batch-api/children?limit=10`)
    assert.equal(children.response.status, 200)
    assert.equal(children.payload.items[0].requestedAmount, '50.00')
    assert.equal(children.payload.items[0].previewStakeStep, '0.50')
    assert.equal(children.payload.items[0].providerReference, '[masked]')
    assert.equal(JSON.stringify(children.payload).includes('must-not-leak'), false)
    assert.equal(Object.hasOwn(children.payload.items[0], 'providerReferenceCiphertext'), false)
  }, {}, { prepareDatabase: seedBatchProjection })
})

test('app API returns accepted-today account ledger statistics using injected Shanghai time', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const bootstrap = await jsonFetch(`${baseUrl}/api/app/bootstrap`)
    const accounts = await jsonFetch(`${baseUrl}/api/app/betting-accounts`)

    assert.equal(bootstrap.payload.bettingAccounts[0].acceptedTodayCount, 1)
    assert.equal(bootstrap.payload.bettingAccounts[0].acceptedTodayAmount, '50.00')
    assert.equal(accounts.payload.items[0].acceptedTodayCount, 1)
    assert.equal(accounts.payload.items[0].acceptedTodayAmount, '50.00')
  }, {}, {
    prepareDatabase: seedAcceptedTodayAccount,
    now: () => new Date('2026-07-11T16:30:00.000Z'),
  })
})

test('page APIs use SQLite current state when runtime JSONL files do not exist', async (t) => {
  await withAppServer(t, async (baseUrl, { defaultLeaguesPath, snapshotPath, changesPath }) => {
    const leagues = await jsonFetch(`${baseUrl}/api/matches/leagues`)
    assert.equal(leagues.response.status, 200)
    assert.equal(leagues.payload.items.length, 1)
    assert.equal(leagues.payload.items[0].league, '英超')
    assert.equal(leagues.payload.items[0].events[0].eventKey, 'sqlite-event')
    assert.equal(leagues.payload.items[0].events[0].homeTeam, 'SQLite 主队')
    assert.equal(leagues.payload.items[0].events[0].selectionCount, 1)
    assert.equal(leagues.payload.items[0].tracked, true)
    assert.equal(leagues.payload.defaultLeagues.stats.configuredCount, 2)
    assert.equal(leagues.payload.oddsSummary.source, 'monitor-v2')
    assert.deepEqual(leagues.payload.oddsSummary.totals, { events: 1, leagues: 1, snapshots: 1, changes: 0 })
    assert.equal(leagues.payload.oddsSummary.monitorHealth.available, false)
    assert.equal(leagues.payload.oddsSummary.monitorHealth.reason, 'runtime-health-unavailable-from-current-state')
    assert.equal(leagues.payload.oddsSummary.monitorHealth.state.events.active, 1)
    assert.equal(leagues.payload.oddsSummary.monitorHealth.state.selections, 1)

    const tracked = await jsonFetch(`${baseUrl}/api/matches/leagues/track`, {
      method: 'POST', body: JSON.stringify({ league: '英超' }),
    })
    assert.equal(tracked.response.status, 200)
    assert.equal(tracked.payload.items[0].trackingSource, 'manual')
    assert.equal(tracked.payload.items[0].events[0].eventKey, 'sqlite-event')

    const untracked = await jsonFetch(`${baseUrl}/api/matches/leagues/untrack`, {
      method: 'POST', body: JSON.stringify({ league: '英超' }),
    })
    assert.equal(untracked.response.status, 200)
    assert.equal(untracked.payload.items[0].trackingSource, 'default')
    assert.equal(untracked.payload.items[0].events[0].eventKey, 'sqlite-event')

    const defaults = await jsonFetch(`${baseUrl}/api/default-leagues`)
    assert.equal(defaults.response.status, 200)
    assert.equal(defaults.payload.items.find((item) => item.name === '英超').status, 'hit')
    assert.deepEqual(defaults.payload.items.find((item) => item.name === '英超').matchedLeagues, ['英超'])

    const leagueOptions = await jsonFetch(`${baseUrl}/api/app/league-options`)
    assert.equal(leagueOptions.response.status, 200)
    assert.deepEqual(leagueOptions.payload.items, ['英超'])

    const monitor = await jsonFetch(`${baseUrl}/api/monitor-settings`)
    assert.equal(monitor.response.status, 200)
    assert.equal(monitor.payload.cards.live.status, 'closed')
    assert.equal(monitor.payload.cards.prematch.status, 'closed')
    assert.equal(monitor.payload.cards.prematch.trackedEventCount, 1)
    assert.equal(monitor.payload.cards.prematch.trackedSelectionCount, 1)
    assert.deepEqual(Object.keys(monitor.payload.settings).sort(), ['live', 'prematch', 'version'])
    assert.equal(Object.hasOwn(monitor.payload.settings.prematch, 'activePeriods'), false)
    assert.equal(monitor.payload.monitorHealth.available, false)
    assert.equal(monitor.payload.monitorHealth.reason, 'runtime-health-unavailable-from-current-state')
    assert.equal(monitor.payload.monitorHealth.source, 'monitor-v2')
    assert.equal(monitor.payload.monitorHealth.state.events.active, 1)
    assert.equal(monitor.payload.monitorHealth.deliveries.pending, 0)
    assert.deepEqual(monitor.payload.monitorHealth.incompleteData, { total: 0, byReason: {}, items: [] })
    assert.equal(monitor.payload.monitorHealth.lastAuthoritative.batchId, 'batch-api-current')

    const updatedDefaults = await jsonFetch(`${baseUrl}/api/default-leagues`, {
      method: 'PUT',
      body: JSON.stringify({
        version: 1,
        leagues: [{ name: '英超', enabled: true, autoTrack: true, modes: ['prematch'] }],
      }),
    })
    assert.equal(updatedDefaults.response.status, 200)
    assert.equal(updatedDefaults.payload.items[0].status, 'hit')
    assert.deepEqual(updatedDefaults.payload.items[0].matchedLeagues, ['英超'])
    assert.equal(JSON.parse(fs.readFileSync(defaultLeaguesPath, 'utf8')).leagues.length, 1)

    assert.equal(fs.existsSync(snapshotPath), false)
    assert.equal(fs.existsSync(changesPath), false)
    assert.doesNotMatch(JSON.stringify([leagues.payload, monitor.payload]), /Fixture|示例联赛|fixture-fallback/)

    const telegram = await jsonFetch(`${baseUrl}/api/settings/telegram`, {
      method: 'PUT',
      body: JSON.stringify({
        oddsAlert: {
          enabled: true,
          botName: '赔率波动报警机器人',
          botToken: '123456:secret-token',
          chatId: '10001',
          parseMode: 'HTML',
          testMessage: 'hello',
        },
      }),
    })
    assert.equal(telegram.payload.oddsAlert.hasBotToken, true)
    assert.equal(JSON.stringify(telegram.payload).includes('secret-token'), false)
  }, {}, {
    prepareDatabase: seedCurrentOddsProjection,
    writeRuntimeJsonl: false,
    lightweightSecurityContext: true,
  })
})

test('page league GET remains readable while another connection holds BEGIN IMMEDIATE', async (t) => {
  await withAppServer(t, async (baseUrl, { dbPath }) => {
    const writer = new DatabaseSync(dbPath)
    writer.exec('BEGIN IMMEDIATE')
    try {
      const leagues = await jsonFetch(`${baseUrl}/api/matches/leagues`)
      assert.equal(leagues.response.status, 200)
      assert.equal(leagues.payload.items[0].events[0].eventKey, 'sqlite-event')
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  }, {}, {
    prepareDatabase: seedCurrentOddsProjection,
    writeRuntimeJsonl: false,
    lightweightSecurityContext: true,
  })
})

test('local page repository reads do not use the schema-migrating app database opener', () => {
  const source = fs.readFileSync(new URL('../src/crown/app/local-config-api.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bopenAppDatabase\b/)
})

test('page projection and tracked-match repository use the same effective dataOptions database', async (t) => {
  await withAppServer(t, async (baseUrl, { dbPath, dataDbPath }) => {
    const tracked = await jsonFetch(`${baseUrl}/api/matches/leagues/track`, {
      method: 'POST', body: JSON.stringify({ league: '英超' }),
    })
    assert.equal(tracked.response.status, 200)
    assert.equal(tracked.payload.items[0].events[0].eventKey, 'sqlite-event')
    assert.equal(tracked.payload.items[0].trackingSource, 'manual')

    const appDb = openAppDatabase({ dbPath })
    const dataDb = openAppDatabase({ dbPath: dataDbPath })
    try {
      assert.equal(appDb.db.prepare('SELECT COUNT(*) AS count FROM tracked_matches').get().count, 0)
      assert.equal(dataDb.db.prepare('SELECT COUNT(*) AS count FROM tracked_matches').get().count, 1)
    } finally {
      appDb.close()
      dataDb.close()
    }
  }, {}, {
    useSeparateDataDatabase: true,
    prepareDataDatabase: seedCurrentOddsProjection,
    writeRuntimeJsonl: false,
    lightweightSecurityContext: true,
  })
})

test('page projection and repositories share the env default database without explicit dbPath options', async (t) => {
  await withAppServer(t, async (baseUrl, { dbPath }) => {
    const leagues = await jsonFetch(`${baseUrl}/api/matches/leagues`)
    assert.equal(leagues.response.status, 200)
    assert.equal(leagues.payload.items[0].events[0].eventKey, 'sqlite-event')
    const league = leagues.payload.items[0].league

    const tracked = await jsonFetch(`${baseUrl}/api/matches/leagues/track`, {
      method: 'POST', body: JSON.stringify({ league }),
    })
    assert.equal(tracked.response.status, 200)

    const inspect = new DatabaseSync(dbPath, { readOnly: true })
    try {
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM tracked_matches').get().count, 1)
      assert.equal(inspect.prepare('SELECT tracking_status FROM tracked_matches').get().tracking_status, 'active')
    } finally {
      inspect.close()
    }
    assert.equal(tracked.payload.items[0].trackingSource, 'manual')
  }, {}, {
    useEnvDefaultDatabase: true,
    prepareDatabase: seedCurrentOddsProjection,
    writeRuntimeJsonl: false,
    lightweightSecurityContext: true,
  })
})

test('historical events and changes APIs retain runtime JSONL compatibility', async (t) => {
  await withAppServer(t, async (baseUrl) => {
    const events = await jsonFetch(`${baseUrl}/api/events`)
    const changes = await jsonFetch(`${baseUrl}/api/changes`)
    assert.equal(events.response.status, 200)
    assert.equal(events.payload.items.length, 1)
    assert.equal(events.payload.items[0].homeTeam, '主队')
    assert.equal(events.payload.origin, 'dom-fallback')
    assert.equal(changes.response.status, 200)
    assert.deepEqual(changes.payload.items, [])
  })
})

test('retired monitor card write routes never modify monitor-settings JSON', async (t) => {
  await withAppServer(t, async (baseUrl, { monitorSettingsPath }) => {
    const before = fs.readFileSync(monitorSettingsPath)
    const beforeMtime = fs.statSync(monitorSettingsPath).mtimeMs
    const requests = [
      ['/api/monitor-settings', { settings: { version: 2, prematch: { enabled: true } } }, 'PUT'],
      ['/api/monitor/start', { mode: 'prematch' }, 'POST'],
      ['/api/monitor/stop', { mode: 'live' }, 'POST'],
    ]
    for (const [url, body, method] of requests) {
      const response = await jsonFetch(`${baseUrl}${url}`, { method, body: JSON.stringify(body) })
      assert.equal(response.response.status, 410)
      assert.deepEqual(response.payload, { error: 'monitor-rule-config-retired' })
    }
    assert.deepEqual(fs.readFileSync(monitorSettingsPath), before)
    assert.equal(fs.statSync(monitorSettingsPath).mtimeMs, beforeMtime)
  })
})

test('app API fetches Telegram chat ids without persisting bot token', async (t) => {
  const telegramCalls = []
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/settings/telegram/chat-ids`, {
      method: 'POST',
      body: JSON.stringify({ botToken: '123456:secret-token' }),
    })

    assert.equal(result.response.status, 200)
    assert.deepEqual(result.payload.chatIds, ['10001'])

    const settings = await jsonFetch(`${baseUrl}/api/settings/telegram`)
    assert.equal(JSON.stringify(settings.payload).includes('secret-token'), false)
  }, {}, {
    telegramFetch: async (url) => {
      telegramCalls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: [{ message: { chat: { id: 10001 } } }],
        }),
      }
    },
  })

  assert.equal(telegramCalls.length, 1)
  assert.match(telegramCalls[0], /getUpdates/)
})

test('app API fetches Telegram chat ids with the stored bot token', async (t) => {
  const telegramCalls = []
  await withAppServer(t, async (baseUrl) => {
    await jsonFetch(`${baseUrl}/api/settings/telegram`, {
      method: 'PUT',
      body: JSON.stringify({
        oddsAlert: {
          enabled: true,
          botToken: '123456:stored-token',
        },
      }),
    })

    const result = await jsonFetch(`${baseUrl}/api/settings/telegram/chat-ids`, {
      method: 'POST',
      body: JSON.stringify({ type: 'oddsAlert' }),
    })

    assert.equal(result.response.status, 200)
    assert.deepEqual(result.payload.chatIds, ['10001'])
  }, {}, {
    telegramFetch: async (url) => {
      telegramCalls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: [{ message: { chat: { id: 10001 } } }],
        }),
      }
    },
  })

  assert.equal(telegramCalls.length, 1)
  assert.match(telegramCalls[0], /123456:stored-token/)
})

test('app API sends Telegram test message with injected telegram fetch', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options)
    throw new Error('global fetch should not be used')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const telegramCalls = []
  await withAppServer(t, async (baseUrl) => {
    await jsonFetch(`${baseUrl}/api/settings/telegram`, {
      method: 'PUT',
      body: JSON.stringify({
        oddsAlert: {
          enabled: true,
          botName: '赔率波动报警机器人',
          botToken: '123456:secret-token',
          chatIds: ['10001', '-10002:88'],
          parseMode: 'HTML',
          testMessage: 'hello',
        },
      }),
    })

    const result = await jsonFetch(`${baseUrl}/api/settings/telegram/test`, {
      method: 'POST',
      body: JSON.stringify({ type: 'oddsAlert' }),
    })

    assert.equal(result.response.status, 200)
    assert.equal(result.payload.sent, true)
  }, {}, {
    telegramFetch: async (url, options) => {
      telegramCalls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })

  assert.equal(telegramCalls.length, 2)
  assert.equal(telegramCalls[0].body.chat_id, '10001')
  assert.equal(telegramCalls[1].body.chat_id, '-10002')
  assert.equal(telegramCalls[1].body.message_thread_id, 88)
})

test('real betting status/start/stop API delegates to the fenced runtime and exposes only bounded safe DTO fields', async (t) => {
  const calls = []
  const status = (requested, state, reasonCode = '') => ({
    requested,
    state,
    reasonCode,
    updatedAt: '2026-07-11T03:00:00.000Z',
    blockingReasons: reasonCode ? [reasonCode] : [],
    preflight: [{ code: 'watcher-not-fresh', ready: !reasonCode }],
    providerToken: 'must-not-leak',
    authorization: { confirmationDigest: 'must-not-leak' },
  })
  const realBettingRuntime = {
    getStatus() { calls.push('status'); return status(false, 'off') },
    start() { calls.push('start'); return status(true, 'armed_waiting', 'watcher-not-fresh') },
    stop() { calls.push('stop'); return status(false, 'off') },
  }
  await withAppServer(t, async (baseUrl) => {
    const read = await jsonFetch(`${baseUrl}/api/app/real-betting-status`)
    const start = await jsonFetch(`${baseUrl}/api/app/real-betting/start`, { method: 'POST', body: '{}' })
    const stop = await jsonFetch(`${baseUrl}/api/app/real-betting/stop`, { method: 'POST', body: '{}' })
    assert.deepEqual(calls, ['status', 'start', 'stop'])
    assert.equal(read.payload.item.state, 'off')
    assert.equal(start.payload.item.state, 'armed_waiting')
    assert.deepEqual(start.payload.item.blockingReasons, ['watcher-not-fresh'])
    assert.equal(stop.payload.item.requested, false)
    const serialized = JSON.stringify([read.payload, start.payload, stop.payload])
    assert.doesNotMatch(serialized, /must-not-leak|providerToken|authorization|confirmationDigest/i)
  }, {}, { realBettingRuntime })
})

test('real betting restart arms and stops the old worker before collecting fresh preflight evidence', async (t) => {
  const events = []
  const ready = Object.fromEntries([
    'watcherFresh', 'watcherLeaseUnique', 'monitorLoginFresh', 'bettingAccountFresh', 'balanceFresh',
    'capabilityExact', 'authorizationActive', 'schemaCurrent', 'environmentExact', 'fenceFresh',
    'executorLeaseFresh', 'reconcilerLeaseFresh', 'executorReconcilerDistinct',
  ].map((field) => [field, true]))
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/app/real-betting/start`, { method: 'POST', body: '{}' })
    assert.equal(result.payload.item.state, 'running')
    assert.deepEqual(events, ['stop', 'preflight', 'start', 'preflight', 'go'])
  }, {}, {
    realBettingPreflight() { events.push('preflight'); return ready },
    bettingProcess: {
      stop() { events.push('stop'); return { stopped: true } },
      start() { events.push('start'); return { running: true, activate() { events.push('go') } } },
    },
  })
})

test('concurrent stop cancels an in-flight ready handshake before runtime can commit running', async (t) => {
  let rejectStart
  let stopCalls = 0
  const ready = Object.fromEntries([
    'watcherFresh', 'watcherLeaseUnique', 'monitorLoginFresh', 'bettingAccountFresh', 'balanceFresh',
    'capabilityExact', 'authorizationActive', 'schemaCurrent', 'environmentExact', 'fenceFresh',
    'executorLeaseFresh', 'reconcilerLeaseFresh', 'executorReconcilerDistinct',
  ].map((field) => [field, true]))
  await withAppServer(t, async (baseUrl) => {
    const starting = jsonFetch(`${baseUrl}/api/app/real-betting/start`, { method: 'POST', body: '{}' })
    await new Promise((resolve) => setImmediate(resolve))
    const during = await jsonFetch(`${baseUrl}/api/app/real-betting-status`)
    assert.notEqual(during.payload.item.state, 'running')
    const stopped = await jsonFetch(`${baseUrl}/api/app/real-betting/stop`, { method: 'POST', body: '{}' })
    rejectStart(Object.assign(new Error('betting-worker-start-aborted'), { code: 'betting-worker-start-aborted' }))
    const startResult = await starting
    assert.equal(stopped.payload.item.state, 'off')
    assert.notEqual(startResult.payload.item.state, 'running')
  }, {}, {
    realBettingPreflight: () => ready,
    bettingProcess: {
      start: () => new Promise((_resolve, reject) => { rejectStart = reject }),
      async stop() { stopCalls += 1; return { stopped: stopCalls > 1 } },
    },
  })
})

test('production collector keeps capability-zero start armed and never spawns a worker', async (t) => {
  let starts = 0
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/app/real-betting/start`, { method: 'POST', body: '{}' })
    assert.equal(result.payload.item.state, 'armed_waiting')
    assert.ok(result.payload.item.blockingReasons.includes('capability-evidence-not-exact'))
    assert.equal(starts, 0)
  }, {
    CROWN_REAL_CURRENCY: 'CNY', CROWN_REAL_AMOUNT_SCALE: '0', CROWN_REAL_MAX_TOTAL_MINOR: '100',
  }, { bettingProcess: { async stop() { return { stopped: false } }, async start() { starts += 1 } } })
})

test('production status refresh blocks stale persisted running and stops its worker', async (t) => {
  let stops = 0
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/app/real-betting-status`)
    assert.equal(result.payload.item.requested, true)
    assert.equal(result.payload.item.state, 'blocked')
    assert.ok(result.payload.item.blockingReasons.length > 0)
    assert.equal(stops, 1)
  }, {
    CROWN_REAL_CURRENCY: 'CNY', CROWN_REAL_AMOUNT_SCALE: '0', CROWN_REAL_MAX_TOTAL_MINOR: '100',
  }, {
    prepareDatabase(db) { requestRealBettingStart(db, Object.fromEntries([
      'watcherFresh', 'watcherLeaseUnique', 'monitorLoginFresh', 'bettingAccountFresh', 'balanceFresh',
      'capabilityExact', 'authorizationActive', 'schemaCurrent', 'environmentExact', 'fenceFresh',
      'executorLeaseFresh', 'reconcilerLeaseFresh', 'executorReconcilerDistinct',
    ].map((field) => [field, true]))) },
    bettingProcess: { async stop() { stops += 1; return { stopped: true } } },
  })
})
