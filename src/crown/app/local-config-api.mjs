import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defaultDbPath, openRuntimeDatabase } from './app-db.mjs'
import { createAppRepository } from './app-repository.mjs'
import { ValidationError } from './app-validation.mjs'
import {
  buildDefaultLeagueOverview,
  readDefaultLeagues,
  writeDefaultLeagues,
} from '../config/default-leagues.mjs'
import {
  maskTelegramSettings,
  readTelegramSettings,
  sendTelegramTestMessage,
  writeTelegramSettings,
} from '../config/telegram-settings.mjs'
import { getTelegramChatIds } from '../telegram/telegram-client.mjs'
import { buildLeagueSummaries } from '../dashboard/league-aggregation.mjs'
import { readCurrentOddsState } from '../dashboard/current-odds-state.mjs'
import {
  buildMonitorCards,
  readMonitorSettings,
} from '../monitor/monitor-settings.mjs'

const MAX_BODY_BYTES = 1024 * 1024

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

function configPaths(dataOptions = {}) {
  return {
    defaultLeaguesPath: dataOptions.defaultLeaguesPath || 'config/default-leagues.json',
    monitorSettingsPath: dataOptions.monitorSettingsPath || 'config/monitor-settings.json',
    telegramSettingsPath: dataOptions.telegramSettingsPath || 'config/telegram-settings.json',
  }
}

function repositoryOptions(appOptions) {
  return {
    secretKey: appOptions.secretKey,
    env: appOptions.env || process.env,
  }
}

function repositoryDbPath(appOptions) {
  const dbPath = appOptions.dbPath || defaultDbPath(appOptions.env || process.env)
  return dbPath === ':memory:' ? dbPath : path.resolve(dbPath)
}

async function withReadRepository(appOptions = {}, handler) {
  const db = new DatabaseSync(repositoryDbPath(appOptions), { readOnly: true })
  try {
    const repo = createAppRepository(db, repositoryOptions(appOptions))
    return await handler(repo)
  } finally {
    db.close()
  }
}

async function withWriteRepository(appOptions = {}, handler) {
  const handle = openRuntimeDatabase({ dbPath: repositoryDbPath(appOptions) })
  try {
    const repo = createAppRepository(handle.db, repositoryOptions(appOptions))
    return await handler(repo)
  } finally {
    handle.close()
  }
}

function effectiveDbPath(dataOptions = {}, appOptions = {}) {
  return dataOptions.dbPath || appOptions.dbPath || defaultDbPath(appOptions.env || process.env)
}

function incompleteDataPayload(events = []) {
  const items = events.flatMap((event) => (event.dataQuality?.reasons || []).map((reason) => ({
    eventKey: event.eventKey,
    reason,
    mode: event.mode,
    league: event.league,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
  })))
  const byReason = {}
  for (const item of items) byReason[item.reason] = (byReason[item.reason] || 0) + 1
  return { total: items.length, byReason, items }
}

function monitorHealthPayload(data) {
  const events = Number(data.summary.totals.events || 0)
  return {
    ...data.health,
    available: false,
    reason: 'runtime-health-unavailable-from-current-state',
    state: {
      events: { active: events, inactive: 0, total: events },
      selections: Number(data.summary.totals.selections || 0),
      signals: 0,
      candidates: 0,
    },
    deliveries: { pending: 0, deadLetter: 0, sent: 0, total: 0 },
    incompleteData: incompleteDataPayload(data.events.items),
  }
}

function oddsSummaryPayload(data) {
  return {
    schemaVersion: data.summary.schemaVersion,
    source: data.summary.source,
    readonly: data.summary.readonly,
    totals: {
      events: Number(data.summary.totals.events || 0),
      leagues: new Set(data.events.items.map((event) => event.league).filter(Boolean)).size,
      snapshots: Number(data.summary.totals.selections || 0),
      changes: 0,
    },
    lastCapturedAt: data.summary.lastCapturedAt,
    warnings: data.events.warnings,
    monitorHealth: monitorHealthPayload(data),
  }
}

async function leaguePayload(dataOptions, appOptions) {
  const paths = configPaths(dataOptions)
  const dbPath = effectiveDbPath(dataOptions, appOptions)
  const data = await readCurrentOddsState({ dbPath })
  const defaultLeagues = await readDefaultLeagues(paths.defaultLeaguesPath)
  return withReadRepository({ ...appOptions, dbPath }, async (repo) => {
    const trackedMatches = repo.listTrackedMatches()
    return {
      items: buildLeagueSummaries(data.events.items, trackedMatches, defaultLeagues),
      defaultLeagues: buildDefaultLeagueOverview(defaultLeagues, data.events.items),
      oddsSummary: oddsSummaryPayload(data),
    }
  })
}

async function trackLeague(dataOptions, appOptions, league, tracked) {
  const dbPath = effectiveDbPath(dataOptions, appOptions)
  const data = await readCurrentOddsState({ dbPath })
  const events = data.events.items.filter((event) => event.league === league)
  await withWriteRepository({ ...appOptions, dbPath }, async (repo) => {
    if (tracked) {
      for (const event of events) {
        repo.trackMatch({
          eventKey: event.eventKey,
          league: event.league,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          mode: event.mode,
          sourceStatus: event.status,
          tracked: true,
        })
      }
      return
    }

    for (const item of repo.listTrackedMatches().filter((row) => row.league === league && row.trackingStatus === 'active')) {
      repo.untrackMatch(item.eventKey)
    }
  })
  return leaguePayload(dataOptions, appOptions)
}

async function monitorPayload(dataOptions, appOptions, settings) {
  const data = await readCurrentOddsState({ dbPath: effectiveDbPath(dataOptions, appOptions) })
  return {
    settings,
    cards: buildMonitorCards(settings, data.events.items),
    schemaVersion: data.summary.schemaVersion,
    monitorHealth: monitorHealthPayload(data),
  }
}

function mergeBot(existingBot, incomingBot = {}) {
  const merged = { ...existingBot, ...incomingBot }
  if (incomingBot.botToken === undefined) merged.botToken = existingBot.botToken
  return merged
}

function mergeTelegramSettings(existing, incoming = {}) {
  return {
    ...existing,
    oddsAlert: mergeBot(existing.oddsAlert, incoming.oddsAlert),
    betSuccess: mergeBot(existing.betSuccess, incoming.betSuccess),
  }
}

async function dispatch(req, requestUrl, options = {}) {
  const { pathname } = requestUrl
  const method = req.method || 'GET'
  const dataOptions = options.dataOptions || {}
  const appOptions = options.appOptions || {}
  const paths = configPaths(dataOptions)

  if (pathname === '/api/matches/leagues' && method === 'GET') {
    return { statusCode: 200, payload: await leaguePayload(dataOptions, appOptions) }
  }

  if (pathname === '/api/matches/leagues/track' && method === 'POST') {
    const body = await readBody(req)
    return { statusCode: 200, payload: await trackLeague(dataOptions, appOptions, String(body.league || ''), true) }
  }

  if (pathname === '/api/matches/leagues/untrack' && method === 'POST') {
    const body = await readBody(req)
    return { statusCode: 200, payload: await trackLeague(dataOptions, appOptions, String(body.league || ''), false) }
  }

  if (pathname === '/api/default-leagues' && method === 'GET') {
    const data = await readCurrentOddsState({ dbPath: effectiveDbPath(dataOptions, appOptions) })
    const config = await readDefaultLeagues(paths.defaultLeaguesPath)
    return { statusCode: 200, payload: buildDefaultLeagueOverview(config, data.events.items) }
  }

  if (pathname === '/api/default-leagues' && method === 'PUT') {
    const body = await readBody(req)
    const saved = await writeDefaultLeagues(paths.defaultLeaguesPath, body.config || body)
    const data = await readCurrentOddsState({ dbPath: effectiveDbPath(dataOptions, appOptions) })
    return { statusCode: 200, payload: buildDefaultLeagueOverview(saved, data.events.items) }
  }

  if (pathname === '/api/monitor-settings' && method === 'GET') {
    const settings = await readMonitorSettings(paths.monitorSettingsPath)
    return { statusCode: 200, payload: await monitorPayload(dataOptions, appOptions, settings) }
  }

  if (pathname === '/api/monitor-settings' && method === 'PUT') {
    return { statusCode: 410, payload: { error: 'monitor-rule-config-retired' } }
  }

  if (pathname === '/api/monitor/start' && method === 'POST') {
    return { statusCode: 410, payload: { error: 'monitor-rule-config-retired' } }
  }

  if (pathname === '/api/monitor/stop' && method === 'POST') {
    return { statusCode: 410, payload: { error: 'monitor-rule-config-retired' } }
  }

  if (pathname === '/api/settings/telegram' && method === 'GET') {
    const settings = await readTelegramSettings(paths.telegramSettingsPath)
    return { statusCode: 200, payload: maskTelegramSettings(settings) }
  }

  if (pathname === '/api/settings/telegram' && method === 'PUT') {
    const body = await readBody(req)
    const existing = await readTelegramSettings(paths.telegramSettingsPath)
    const saved = await writeTelegramSettings(paths.telegramSettingsPath, mergeTelegramSettings(existing, body.settings || body))
    return { statusCode: 200, payload: maskTelegramSettings(saved) }
  }

  if (pathname === '/api/settings/telegram/chat-ids' && method === 'POST') {
    const body = await readBody(req)
    const type = body.type === 'betSuccess' ? 'betSuccess' : 'oddsAlert'
    const settings = await readTelegramSettings(paths.telegramSettingsPath)
    const botToken = String(body.botToken || settings[type]?.botToken || '').trim()
    if (!botToken) return { statusCode: 400, payload: { error: 'missing-bot-token' } }
    const result = await getTelegramChatIds(botToken, { fetchImpl: appOptions.telegramFetch || fetch })
    if (!result.ok) return { statusCode: 400, payload: { error: result.reason, message: result.message } }
    return { statusCode: 200, payload: { chatIds: result.chatIds } }
  }

  if (pathname === '/api/settings/telegram/test' && method === 'POST') {
    const body = await readBody(req)
    const type = body.type === 'betSuccess' ? 'betSuccess' : 'oddsAlert'
    const settings = await readTelegramSettings(paths.telegramSettingsPath)
    return { statusCode: 200, payload: await sendTelegramTestMessage(settings[type], { fetchImpl: appOptions.telegramFetch || fetch }) }
  }

  return null
}

export async function handleLocalConfigApi(req, res, requestUrl, options = {}) {
  try {
    const result = await dispatch(req, requestUrl, options)
    if (!result) return false
    send(res, result.statusCode, result.payload)
    return true
  } catch (error) {
    if (error instanceof ValidationError) {
      send(res, 400, { error: error.code, fields: error.fields })
      return true
    }
    send(res, 500, { error: 'server-error' })
    return true
  }
}
