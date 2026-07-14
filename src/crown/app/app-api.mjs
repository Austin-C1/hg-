import { openAppDatabase, readAppSchemaVersion } from './app-db.mjs'
import { APP_CONTRACT_VERSION } from './app-contract-version.mjs'
import { SecretKeyRequiredError } from './app-secret.mjs'
import { createAppRepository } from './app-repository.mjs'
import {
  ValidationError,
  validateRuleCardCreatePayload,
  validateRuleCardDeletePayload,
  validateRuleCardUpdatePayload,
  validateManualLoginMutationPayload,
} from './app-validation.mjs'
import { readLoginDiagnostics } from '../login/crown-login-diagnostics.mjs'
import { CrownApiLoginManager } from '../login/crown-api-login-manager.mjs'
import { realBettingDto } from './real-betting-dto.mjs'
import { readDashboardData } from '../dashboard/dashboard-data.mjs'
import { previewRuntimeCleanup, runRuntimeCleanup } from './runtime-cache-cleanup.mjs'
import { readDefaultLeagues } from '../config/default-leagues.mjs'
import { upgradeRuleRealEligibility } from '../betting/execution-gate.mjs'
import {
  armRealBettingStart,
  collectRealBettingPreflight,
  commitRealBettingRunning,
  evaluateRealBettingStaticPreflight,
  getRealBettingStatus,
  refreshRealBettingRuntime,
  requestRealBettingStart,
  requestRealBettingStop,
} from '../betting/real-betting-runtime.mjs'

const MAX_BODY_BYTES = 1024 * 1024
function effectiveRuntimeDir(options = {}) {
  return options.runtimeDir || options.dataOptions?.runtimeDir || 'data/runtime'
}

async function realBettingService(options, db) {
  if (options.realBettingRuntime) return options.realBettingRuntime
  const readChecks = async (readyTicket = null) => {
    const effectiveTicket = readyTicket || options.bettingProcess?.getReadyTicket?.() || null
    return typeof options.realBettingPreflight === 'function'
    ? await options.realBettingPreflight({ db, readyTicket: effectiveTicket })
    : collectRealBettingPreflight(db, {
      env: options.env || process.env, now: options.now, readyTicket: effectiveTicket,
      dbPath: options.dbPath, runtimeDir: effectiveRuntimeDir(options),
    })
  }
  return {
    getStatus: async () => {
      const status = refreshRealBettingRuntime(db, { checks: await readChecks(), now: options.now })
      if (status.state === 'blocked') await options.bettingProcess?.stop?.()
      return status
    },
    start: async () => {
      armRealBettingStart(db, { now: options.now })
      await options.bettingProcess?.stop?.()
      const checks = await readChecks()
      const preflight = evaluateRealBettingStaticPreflight(checks)
      if (!preflight.ready) return requestRealBettingStart(db, checks, { now: options.now })
      try {
        const started = await options.bettingProcess?.start?.({ dbPath: options.dbPath })
        if (!started?.readyTicket) throw new Error('betting-worker-ready-ticket-required')
        const freshChecks = await readChecks(started?.readyTicket || null)
        const committed = commitRealBettingRunning(db, freshChecks, { now: options.now })
        if (committed.state !== 'running') {
          await options.bettingProcess?.stop?.()
          return committed
        }
        started?.activate?.()
        return committed
      } catch {
        await options.bettingProcess?.stop?.()
        const current = getRealBettingStatus(db, { checks, now: options.now })
        if (!current.requested) return current
        return requestRealBettingStart(db, { ...checks, fenceFresh: false }, { now: options.now })
      }
    },
    stop: async () => {
      const status = requestRealBettingStop(db, { checks: {}, now: options.now })
      await options.bettingProcess?.stop?.()
      return status
    },
  }
}

function send(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new ValidationError('payload-too-large', { body: 'payload too large' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationError('invalid-json', { body: 'invalid JSON' })
  }
}

function routeParts(pathname) {
  try {
    return pathname.replace(/^\/api\/app\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  } catch (error) {
    if (error instanceof URIError) {
      throw new ValidationError('invalid-path', { path: 'invalid path encoding' })
    }
    throw error
  }
}

function methodNotAllowed(res) {
  send(res, 405, { error: 'method-not-allowed' })
  return true
}

const MONITOR_ALERT_FIELD_MESSAGES = {
  body: 'request body is invalid',
  mode: 'mode is invalid',
  expectedVersion: 'expectedVersion is invalid',
  acknowledgeMigrationReview: 'migration review acknowledgement is invalid',
  enabled: 'enabled setting is invalid',
  asianHandicapEnabled: 'asian handicap setting is invalid',
  totalEnabled: 'total setting is invalid',
  monitorOddsMin: 'monitor odds minimum is invalid',
  monitorOddsMax: 'monitor odds maximum is invalid',
  waterMoveThreshold: 'water move threshold is invalid',
  cooldownSeconds: 'cooldown seconds is invalid',
  startMinutesBeforeKickoff: 'prematch start minute is invalid',
  stopMinutesBeforeKickoff: 'prematch stop minute is invalid',
  liveMinuteFrom: 'live start minute is invalid',
  liveMinuteTo: 'live stop minute is invalid',
  includeFirstHalf: 'first-half setting is invalid',
  includeHalfTime: 'half-time setting is invalid',
  includeSecondHalf: 'second-half setting is invalid',
  remark: 'remark is invalid',
}

function safeMonitorAlertFields(fields) {
  return Object.fromEntries(Object.keys(fields || {})
    .filter((field) => Object.hasOwn(MONITOR_ALERT_FIELD_MESSAGES, field))
    .map((field) => [field, MONITOR_ALERT_FIELD_MESSAGES[field]]))
}

async function withRepository(options, handler) {
  if (options.repository) return handler(options.repository, options.repositoryDb || null)
  const handle = openAppDatabase({ dbPath: options.dbPath, env: options.env || process.env })
  try {
    const repo = createAppRepository(handle.db, {
      secretKey: options.secretKey,
      env: options.env || process.env,
      now: options.now,
      dbPath: handle.dbPath,
      runtimeDir: effectiveRuntimeDir(options),
    })
    return await handler(repo, handle.db)
  } finally {
    handle.close()
  }
}

function loadDefaultLeagues(options) {
  return readDefaultLeagues(options.dataOptions?.defaultLeaguesPath || 'config/default-leagues.json')
}

function autoBettingRuleCardDto(item) {
  return {
    cardId: item.cardId,
    name: item.name,
    enabled: item.enabled,
    leagueNames: item.leagueNames,
    targetOddsMin: item.targetOddsMin,
    targetOddsMax: item.targetOddsMax,
    targetAmountMinor: item.targetAmountMinor,
    currency: item.currency,
    amountScale: item.amountScale,
    remark: item.remark,
    realEligible: item.realEligible,
    realEligibilityVersion: item.realEligibilityVersion,
    migrationReviewRequired: item.migrationReviewRequired,
    migrationReviewReason: item.migrationReviewReason,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    recentSignal: typeof item.recentSignal === 'string' ? item.recentSignal.slice(0, 64) : null,
    recentBatch: typeof item.recentBatch === 'string' ? item.recentBatch.slice(0, 64) : null,
    recentResult: typeof item.recentResult === 'string' ? item.recentResult.slice(0, 64) : null,
  }
}

function todayBettingLeagueDto(item) {
  return {
    leagueName: item.leagueName,
    source: item.source,
    todayMatchCount: item.todayMatchCount,
    ownerCardId: item.ownerCardId,
    ownerCardName: item.ownerCardName,
    selectable: item.selectable,
    availableToday: item.availableToday,
  }
}

const MANUAL_LOGIN_STATES = new Set(['idle', 'opening', 'awaiting-user', 'verifying', 'verified', 'failed'])

function manualLoginDto(item, expectedAccountId) {
  const accountId = String(item?.accountId || '')
  const challengeId = String(item?.challengeId || '')
  const status = String(item?.status || '')
  const errorCode = String(item?.errorCode || '')
  const expiresAt = Number(item?.expiresAt)
  if (
    accountId !== String(expectedAccountId || '')
    || !challengeId
    || !MANUAL_LOGIN_STATES.has(status)
    || (errorCode && !/^manual-login-[a-z0-9-]+$/.test(errorCode))
    || !Number.isSafeInteger(expiresAt)
    || expiresAt < 0
  ) throw Object.assign(new Error('manual-login-state-invalid'), { code: 'manual-login-state-invalid' })
  return { challengeId, accountId, status, errorCode, expiresAt }
}

function humanLoginController(options) {
  if (!options.humanLoginController) {
    throw Object.assign(new Error('manual-login-unavailable'), { code: 'manual-login-unavailable' })
  }
  return options.humanLoginController
}

async function dispatch(req, requestUrl, options = {}) {
  const parts = routeParts(requestUrl.pathname)
  const method = req.method || 'GET'

  if (parts.length === 1 && parts[0] === 'security-context') {
    if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    return {
      statusCode: 200,
      payload: {
        ...(options.csrfToken ? { csrfToken: options.csrfToken } : {}),
        dashboardAccessMode: options.dashboardAccessMode || 'readonly',
        appContractVersion: APP_CONTRACT_VERSION,
        schemaVersion: readAppSchemaVersion({ dbPath: options.dbPath, env: options.env || process.env }),
      },
    }
  }

  if (parts.length === 1 && parts[0] === 'runtime-cache-cleanup') {
    const cleanupBoundary = options.dataRoot
      ? { dataRoot: options.dataRoot }
      : { workspaceDir: options.appDir || options.cwd }
    const cleanup = options.runtimeCleanup || {
      preview: () => previewRuntimeCleanup({
        ...cleanupBoundary, runtimeDir: effectiveRuntimeDir(options), profileDir: options.profileDir, dbPath: options.dbPath,
      }),
      run: () => runRuntimeCleanup({
        ...cleanupBoundary, runtimeDir: effectiveRuntimeDir(options), profileDir: options.profileDir, dbPath: options.dbPath,
        monitorProcess: options.monitorProcess, bettingProcess: options.bettingProcess, env: options.env || process.env,
      }),
    }
    if (method === 'GET') return { statusCode: 200, payload: { item: await cleanup.preview() } }
    if (method === 'POST') return { statusCode: 200, payload: { item: await cleanup.run() } }
    return { statusCode: 405, payload: { error: 'method-not-allowed' } }
  }

  if (parts[0] === 'system-update') {
    return { statusCode: 404, payload: { error: 'not-found' } }
  }

  if (['betting-rules', 'auto-bet-rules'].includes(parts[0]) && method !== 'GET') {
    return { statusCode: 410, payload: { error: 'rule-api-retired' } }
  }

  if (parts[0] === 'execution-authorizations' && method !== 'GET') {
    return { statusCode: 410, payload: { error: 'execution-authorization-retired' } }
  }

  return withRepository(options, async (repo, db) => {
    if (parts.length === 1 && parts[0] === 'auto-betting-rule-cards') {
      if (method === 'GET') {
        return { statusCode: 200, payload: { items: repo.listAutoBettingRuleCards().map(autoBettingRuleCardDto) } }
      }
      if (method === 'POST') {
        const body = validateRuleCardCreatePayload(await readBody(req))
        const item = repo.createAutoBettingRuleCard(body, { defaultLeagues: await loadDefaultLeagues(options) })
        return { statusCode: 200, payload: { item: autoBettingRuleCardDto(item) } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'auto-betting-rule-cards') {
      if (method === 'PUT') {
        const body = validateRuleCardUpdatePayload(await readBody(req))
        const item = repo.updateAutoBettingRuleCard(parts[1], body, { defaultLeagues: await loadDefaultLeagues(options) })
        return { statusCode: 200, payload: { item: autoBettingRuleCardDto(item) } }
      }
      if (method === 'DELETE') {
        const body = validateRuleCardDeletePayload(await readBody(req))
        repo.deleteAutoBettingRuleCard(parts[1], body)
        return { statusCode: 200, payload: { ok: true } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'today-betting-leagues') {
      if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      const items = repo.listTodayBettingLeagues(requestUrl.searchParams.get('cardId'), {
        defaultLeagues: await loadDefaultLeagues(options),
      })
      return { statusCode: 200, payload: { items: items.map(todayBettingLeagueDto) } }
    }

    if (parts.length === 1 && parts[0] === 'league-options') {
      if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      const rows = db.prepare(`
        SELECT league FROM tracked_matches WHERE tracking_status = 'active' AND trim(league) <> ''
        UNION
        SELECT league_name AS league FROM betting_rule_leagues WHERE trim(league_name) <> ''
        UNION
        SELECT json_extract(event_json, '$.league') AS league
        FROM monitor_event_state
        WHERE active = 1 AND trim(COALESCE(json_extract(event_json, '$.league'), '')) <> ''
        ORDER BY league
      `).all()
      const defaults = await readDefaultLeagues(options.dataOptions?.defaultLeaguesPath || 'config/default-leagues.json')
      const items = new Set(rows.map((row) => String(row.league)))
      for (const league of defaults.leagues || []) {
        if (league.enabled && String(league.name || '').trim()) items.add(String(league.name).trim())
      }
      return { statusCode: 200, payload: { items: [...items].sort((a, b) => a.localeCompare(b)) } }
    }

    if (parts.length === 1 && parts[0] === 'real-betting-status') {
      if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      const service = await realBettingService(options, db)
      return { statusCode: 200, payload: { item: realBettingDto(await service.getStatus()) } }
    }

    if (parts.length === 1 && parts[0] === 'operations-summary') {
      if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      return {
        statusCode: 200,
        payload: { item: repo.getOperationsSummary(options.monitorProcess?.getStatus?.() || null) },
      }
    }

    if (parts.length === 2 && parts[0] === 'real-betting' && ['start', 'stop'].includes(parts[1])) {
      if (method !== 'POST') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      await readBody(req)
      const service = await realBettingService(options, db)
      const item = parts[1] === 'start' ? await service.start() : await service.stop()
      return { statusCode: 200, payload: { item: realBettingDto(item) } }
    }

    if (parts.length === 1 && parts[0] === 'bootstrap' && method === 'GET') {
      const data = await readDashboardData({
        ...(options.dataOptions || {}),
        dbPath: options.dataOptions?.dbPath || options.dbPath,
      })
      return {
        statusCode: 200,
        payload: {
          ...repo.bootstrap(),
          appContractVersion: APP_CONTRACT_VERSION,
          schemaVersion: repo.getSchemaVersion(),
          oddsSummary: data.summary,
          events: data.events,
          changes: data.changes,
          ...(options.csrfToken ? { csrfToken: options.csrfToken } : {}),
          dashboardAccessMode: options.dashboardAccessMode || 'readonly',
        },
      }
    }

    if (parts.length === 1 && parts[0] === 'tracked-matches' && method === 'POST') {
      const body = await readBody(req)
      return { statusCode: 200, payload: { item: repo.trackMatch(body) } }
    }

    if (parts.length === 1 && parts[0] === 'monitor-account') {
      if (method === 'GET') return { statusCode: 200, payload: { item: repo.getPrimaryMonitorAccount() } }
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.savePrimaryMonitorAccount(await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'monitor-account' && parts[1] === 'login-diagnostics') {
      if (method === 'GET') {
        const item = repo.getPrimaryMonitorAccount()
        return { statusCode: 200, payload: readLoginDiagnostics(item.lastLoginDiagnosticsPath) }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'monitor-account' && parts[1] === 'actions') {
      if (method === 'POST') {
        const body = await readBody(req)
        const action = String(body.action || '')
        if (action === 'relogin' && options.monitorProcess) {
          if (typeof options.monitorProcess.stopAndWait !== 'function') {
            throw Object.assign(new Error('watcher-stop-unsafe'), { code: 'watcher-stop-unsafe' })
          }
          await options.monitorProcess.stopAndWait()
          if (options.monitorProcess.isRunning?.() === true) {
            throw Object.assign(new Error('watcher-stop-unsafe'), { code: 'watcher-stop-unsafe' })
          }
        }
        const item = repo.applyMonitorAccountAction(action)
        if (action === 'stop') {
          options.monitorProcess?.stop?.()
        } else if (action === 'relogin') {
          options.monitorProcess?.start?.({ action, dbPath: options.dbPath })
        } else if (action === 'test-login') {
          if (typeof options.monitorProcess?.runLoginTest === 'function') {
            await options.monitorProcess.runLoginTest({ action, dbPath: options.dbPath })
          } else {
            options.monitorProcess?.start?.({ action, dbPath: options.dbPath })
          }
          const latest = repo.getPrimaryMonitorAccount()
          return { statusCode: 200, payload: { item: latest, loginResult: latest.lastLoginResult } }
        } else if (action === 'start') {
          options.monitorProcess?.start?.({ action, dbPath: options.dbPath, restart: true })
        }
        return { statusCode: 200, payload: { item } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'monitor-accounts') {
      if (method === 'GET') return { statusCode: 200, payload: { items: repo.listMonitorAccounts() } }
      if (method === 'POST') return { statusCode: 200, payload: { item: repo.createMonitorAccount(await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length >= 4 && parts[0] === 'monitor-accounts' && parts[2] === 'manual-login') {
      if (!['password-session', 'local-trust'].includes(options.dashboardAccessMode)) {
        return { statusCode: 401, payload: { error: 'authentication-required' } }
      }
      const controller = humanLoginController(options)
      const accountId = parts[1]
      if (parts.length === 4 && parts[3] === 'open') {
        if (method !== 'POST') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
        validateManualLoginMutationPayload(await readBody(req))
        const item = await controller.openManualLogin({ accountId })
        return { statusCode: 200, payload: { item: manualLoginDto(item, accountId) } }
      }
      if (parts.length === 4) {
        if (method !== 'GET') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
        const challengeId = parts[3]
        const item = controller.getManualLoginStatus({ accountId, challengeId })
        return { statusCode: 200, payload: { item: manualLoginDto(item, accountId) } }
      }
      if (parts.length === 5 && ['confirm', 'cancel'].includes(parts[4])) {
        if (method !== 'POST') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
        validateManualLoginMutationPayload(await readBody(req))
        const challengeId = parts[3]
        const operation = parts[4] === 'confirm'
          ? controller.confirmManualLogin.bind(controller)
          : controller.cancelManualLogin.bind(controller)
        const item = await operation({ accountId, challengeId })
        return { statusCode: 200, payload: { item: manualLoginDto(item, accountId) } }
      }
      return { statusCode: 404, payload: { error: 'not-found' } }
    }

    if (parts.length === 2 && parts[0] === 'monitor-accounts') {
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.updateMonitorAccount(parts[1], await readBody(req)) } }
      if (method === 'DELETE') return { statusCode: 200, payload: repo.deleteMonitorAccount(parts[1]) }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'monitor-rules') {
      if (method === 'GET') return { statusCode: 200, payload: { items: repo.listMonitorRules() } }
      if (method === 'POST') return { statusCode: 200, payload: { item: repo.createMonitorRule(await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'monitor-rules') {
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.updateMonitorRule(parts[1], await readBody(req)) } }
      if (method === 'DELETE') return { statusCode: 200, payload: repo.deleteMonitorRule(parts[1]) }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'betting-rules') {
      if (method === 'GET') return { statusCode: 200, payload: { items: repo.listBettingRules() } }
      if (method === 'POST') return { statusCode: 200, payload: { item: repo.createBettingRule(await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'monitor-alert-settings') {
      if (method === 'GET') return { statusCode: 200, payload: repo.getMonitorAlertSettings() }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'monitor-alert-settings' && ['prematch', 'live'].includes(parts[1])) {
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.updateMonitorAlertSetting(parts[1], await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'auto-betting-settings') {
      if (method === 'GET') return { statusCode: 200, payload: repo.getAutoBettingSettings() }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'auto-betting-settings' && ['prematch', 'live'].includes(parts[1])) {
      if (method === 'PUT') return { statusCode: 410, payload: { error: 'fixed-auto-betting-settings-retired' } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'auto-bet-rules') {
      if (method === 'GET') return { statusCode: 200, payload: { items: repo.listAutoBetRules() } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'betting-rules') {
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.updateBettingRule(parts[1], await readBody(req)) } }
      if (method === 'DELETE') return { statusCode: 200, payload: repo.deleteBettingRule(parts[1]) }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 3 && parts[0] === 'betting-rules' && parts[2] === 'real-eligibility') {
      if (method === 'POST') {
        const body = await readBody(req)
        try {
          upgradeRuleRealEligibility(db, { ruleId: parts[1], confirmation: body.confirmation }, {
            env: options.env || process.env,
            now: options.now,
          })
        } catch (error) {
          if (String(error?.message || '').endsWith('-not-found')) throw error
          throw new ValidationError(String(error?.message || 'rule-upgrade-failed'))
        }
        const item = repo.listBettingRules().find((rule) => rule.id === parts[1])
        return { statusCode: 200, payload: { item } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'bet-batches') {
      if (method === 'GET') {
        return { statusCode: 200, payload: { items: repo.listBetBatches({ limit: requestUrl.searchParams.get('limit') }) } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 3 && parts[0] === 'bet-batches' && parts[2] === 'children') {
      if (method === 'GET') {
        return { statusCode: 200, payload: { items: repo.listBetBatchChildren(parts[1], { limit: requestUrl.searchParams.get('limit') }) } }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'betting-accounts') {
      if (method === 'GET') return { statusCode: 200, payload: { items: repo.listBettingAccounts() } }
      if (method === 'POST') return { statusCode: 200, payload: { item: repo.createBettingAccount(await readBody(req)) } }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 2 && parts[0] === 'betting-accounts') {
      if (method === 'PUT') return { statusCode: 200, payload: { item: repo.updateBettingAccount(parts[1], await readBody(req)) } }
      if (method === 'DELETE') return { statusCode: 200, payload: repo.deleteBettingAccount(parts[1]) }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 3 && parts[0] === 'betting-accounts' && ['pause', 'enable'].includes(parts[2])) {
      if (method !== 'POST') return { statusCode: 405, payload: { error: 'method-not-allowed' } }
      if (parts[2] === 'pause') {
        return { statusCode: 200, payload: { item: repo.pauseBettingAccount(parts[1]) } }
      }
      const checking = repo.beginEnableBettingAccount(parts[1])
      const checker = options.bettingAccountAccessChecker || {
        check(exactAccount) {
          const manager = new CrownApiLoginManager({
            runtimeDir: effectiveRuntimeDir(options),
            fetchImpl: options.fetchImpl || globalThis.fetch,
            bettingAllowedOrigins: (options.env || process.env).CROWN_BETTING_ALLOWED_ORIGINS || '',
          })
          return manager.testBettingAccountAccess({ account: exactAccount })
        },
      }
      let checked
      try {
        checked = await checker.check(checking.account)
      } catch {
        checked = {
          ok: false, status: 'failed', errorCode: 'access-failed',
          reportedBalance: null, reportedCurrency: '', balanceSource: 'none',
        }
      }
      const item = repo.completeEnableBettingAccount(checking, checked)
      return {
        statusCode: 200,
        payload: {
          item,
          result: {
            ok: item.allocationStatus === 'enabled',
            status: item.accessStatus,
            errorCode: item.accessErrorCode,
            reportedBalance: item.reportedBalance,
            reportedCurrency: item.reportedCurrency,
            balanceSource: ['account-summary', 'login'].includes(checked?.balanceSource) ? checked.balanceSource : 'none',
          },
        },
      }
    }

    if (parts.length === 3 && parts[0] === 'betting-accounts' && parts[2] === 'actions') {
      if (method === 'POST') {
        const body = await readBody(req)
        if (body.action !== 'check-access') throw new ValidationError('validation-error', { action: 'unsupported action' })
        const account = repo.getBettingAccountForAccessCheck(parts[1])
        const checker = options.bettingAccountAccessChecker || {
          check(exactAccount) {
            const manager = new CrownApiLoginManager({
              runtimeDir: effectiveRuntimeDir(options),
              fetchImpl: options.fetchImpl || globalThis.fetch,
              bettingAllowedOrigins: (options.env || process.env).CROWN_BETTING_ALLOWED_ORIGINS || '',
            })
            return manager.testBettingAccountAccess({ account: exactAccount })
          },
        }
        const checked = await checker.check(account)
        const item = repo.recordBettingAccountAccessCheck(parts[1], checked)
        const balanceSource = ['account-summary', 'login'].includes(checked?.balanceSource) ? checked.balanceSource : 'none'
        return {
          statusCode: 200,
          payload: {
            item,
            result: {
              ok: item.accessStatus === 'available',
              status: item.accessStatus,
              errorCode: item.accessErrorCode,
              reportedBalance: item.reportedBalance,
              reportedCurrency: item.reportedCurrency,
              balanceSource,
            },
          },
        }
      }
      return { statusCode: 405, payload: { error: 'method-not-allowed' } }
    }

    if (parts.length === 1 && parts[0] === 'betting-history' && method === 'GET') {
      return { statusCode: 200, payload: { items: repo.listBettingHistory() } }
    }

    return { statusCode: 404, payload: { error: 'not-found' } }
  })
}

export async function handleAppApi(req, res, requestUrl, options = {}) {
  try {
    const result = await dispatch(req, requestUrl, options)
    send(res, result.statusCode, result.payload)
  } catch (error) {
    if (error instanceof ValidationError) {
      const fields = requestUrl.pathname.startsWith('/api/app/monitor-alert-settings')
        ? safeMonitorAlertFields(error.fields)
        : error.fields
      send(res, 400, { error: error.code, fields })
      return true
    }
    if (['validation-error', 'league-required', 'league-not-available-today'].includes(error?.code)) {
      const fields = requestUrl.pathname.startsWith('/api/app/monitor-alert-settings')
        ? safeMonitorAlertFields(error.fields)
        : (error.fields || {})
      send(res, 400, { error: error.code, fields })
      return true
    }
    if (error?.code === 'league-owned-by-another-card') {
      send(res, 409, {
        error: 'league-owned-by-another-card',
        fields: {
          leagueNames: Array.isArray(error.fields?.leagueNames)
            ? error.fields.leagueNames.filter((leagueName) => typeof leagueName === 'string')
            : [],
          ownerName: typeof error.fields?.ownerName === 'string' ? error.fields.ownerName : '',
        },
      })
      return true
    }
    if (error?.code === 'auto-betting-card-version-conflict') {
      send(res, 409, { error: 'auto-betting-card-version-conflict' })
      return true
    }
    if (error?.code === 'auto-betting-card-not-found') {
      send(res, 404, { error: 'auto-betting-card-not-found' })
      return true
    }
    if (error?.code === 'betting-rule-conflict' || String(error?.message || '') === 'betting-rule-conflict') {
      send(res, 409, { error: 'betting-rule-conflict', conflict: error.conflict || null })
      return true
    }
    if (error?.code === 'auto-bet-rule-version-conflict' || String(error?.message || '') === 'auto-bet-rule-version-conflict') {
      send(res, 409, { error: 'auto-bet-rule-version-conflict' })
      return true
    }
    if (['monitor-alert-settings-version-conflict', 'auto-betting-settings-version-conflict'].includes(error?.code)
      || ['monitor-alert-settings-version-conflict', 'auto-betting-settings-version-conflict'].includes(String(error?.message || ''))) {
      send(res, 409, { error: error.code || error.message })
      return true
    }
    if (String(error?.message || '') === 'betting-account-locked') {
      send(res, 409, { error: 'betting-account-locked' })
      return true
    }
    if (String(error?.message || '') === 'betting-account-busy') {
      send(res, 409, { error: 'betting-account-busy' })
      return true
    }
    if (String(error?.message || '') === 'betting-account-per-bet-limit') {
      send(res, 400, { error: 'betting-account-limit-required' })
      return true
    }
    if (error instanceof SecretKeyRequiredError || error?.code === 'secret-key-required') {
      send(res, 400, { error: 'secret-key-required', fields: { secret: 'secret storage is unavailable' } })
      return true
    }
    if (String(error?.message || '') === 'local-secret-key-unavailable') {
      send(res, 500, { error: 'local-secret-key-unavailable', fields: { secret: 'local secret key file is not writable' } })
      return true
    }
    if (error?.code === 'watcher-stop-unsafe' || String(error?.message || '') === 'watcher-stop-unsafe') {
      send(res, 503, { error: 'watcher-stop-unsafe' })
      return true
    }
    const manualLoginCode = String(error?.code || error?.message || '')
    if (/^manual-login-[a-z0-9-]+$/.test(manualLoginCode)) {
      const statusCode = [
        'manual-login-account-not-found',
        'manual-login-challenge-not-found',
        'manual-login-challenge-binding-mismatch',
      ].includes(manualLoginCode) ? 404
        : manualLoginCode === 'manual-login-challenge-expired' ? 410
          : ['manual-login-busy', 'manual-login-challenge-state-invalid', 'manual-login-controller-closing'].includes(manualLoginCode) ? 409
            : ['manual-login-verification-failed', 'manual-login-session-evidence-missing'].includes(manualLoginCode) ? 422
              : ['manual-login-unavailable', 'manual-login-browser-open-failed'].includes(manualLoginCode) ? 503
                : 400
      send(res, statusCode, { error: manualLoginCode })
      return true
    }
    send(res, 500, { error: 'server-error' })
  }
  return true
}

export { methodNotAllowed }
