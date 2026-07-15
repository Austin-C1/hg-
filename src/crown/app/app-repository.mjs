import crypto from 'node:crypto'

import { validateBettingRulePolicy } from '../betting/betting-rule-policy.mjs'
import { terminateRuleCardInboxBeforeDelete } from '../betting/auto-betting-inbox-store.mjs'
import { completeRuleCardSnapshot } from '../betting/auto-betting-rule-card-matcher.mjs'
import { normalizeAutoBetRule } from '../betting/auto-bet-rule.mjs'
import {
  normalizeRuleCardCreate,
  normalizeRuleCardUpdate,
} from '../betting/auto-betting-rule-card.mjs'
import { buildTodayBettingLeagues } from '../betting/today-betting-leagues.mjs'
import {
  autoBettingSettingFromRow,
  autoBettingSettingsSummary,
  normalizeAutoBettingSetting,
} from '../betting/auto-betting-settings.mjs'
import { formatMinor, normalizeCurrency, parseDecimalToMinor } from '../betting/money.mjs'
import { decryptSecret, encryptSecret, redactSecretFields } from './app-secret.mjs'
import { inspectWatcherLease } from './watcher-lease-status.mjs'
import { browserBettingDto, realBettingStatusCoreDto } from './real-betting-dto.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  listCrownCapabilities,
} from '../betting/crown-capability-matrix.mjs'
import {
  monitorAlertSettingFromRow,
  monitorAlertSettingsSummary,
  normalizeMonitorAlertSetting,
} from '../monitor/alert-settings.mjs'
import {
  ValidationError,
  normalizeBettingAccount,
  normalizeBettingHistoryInput,
  normalizeLoginResult,
  normalizeBettingRule,
  normalizeAutoBetRuleReorder,
  normalizeExpectedVersion,
  validateAutoBetRuleCasPayload,
  validateAutoBetRuleCreatePayload,
  validateAutoBetRuleUpdatePayload,
  normalizeMonitorAccount,
  normalizeMonitorRule,
  normalizeTrackedMatch,
} from './app-validation.mjs'

function nowIso() {
  return new Date().toISOString()
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function boolToInt(value) {
  return value ? 1 : 0
}

const WATCHER_PROCESS_STATES = new Set([
  'running', 'waiting-restart', 'stopped-after-retries', 'manually-stopped', 'stopping',
])

function boundedUtf8(value, maximumBytes = 2048) {
  let result = ''
  for (const character of String(value || '')) {
    if (Buffer.byteLength(result + character, 'utf8') > maximumBytes) break
    result += character
  }
  return result
}

function safeProcessTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString() === text ? text : null
}

function watcherProcessDto(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const processState = WATCHER_PROCESS_STATES.has(value.processState) ? value.processState : 'manually-stopped'
  const restartAttempt = Number.isSafeInteger(value.restartAttempt) && value.restartAttempt >= 0 && value.restartAttempt <= 3
    ? value.restartAttempt
    : 0
  const exitCode = value.lastExit?.exitCode === null
    ? null
    : Number.isSafeInteger(value.lastExit?.exitCode) && value.lastExit.exitCode >= 0
      ? value.lastExit.exitCode
      : null
  const signal = typeof value.lastExit?.signal === 'string' && /^SIG[A-Z0-9]+$/.test(value.lastExit.signal)
    ? value.lastExit.signal
    : null
  const lastExit = value.lastExit && typeof value.lastExit === 'object' && !Array.isArray(value.lastExit)
    ? {
        exitCode,
        signal,
        exitedAt: safeProcessTimestamp(value.lastExit.exitedAt),
        stderrSummary: boundedUtf8(value.lastExit.stderrSummary),
      }
    : null
  return {
    desiredRunning: value.desiredRunning === true,
    processState,
    lastExit,
    restartAttempt,
    nextRestartAt: safeProcessTimestamp(value.nextRestartAt),
  }
}

function intToBool(value) {
  return Boolean(value)
}

const PRIMARY_MONITOR_ACCOUNT_ID = 'mon_primary'
const BETTING_ACCOUNT_CHECK_TIMEOUT_MS = 2 * 60 * 1000

function requiredRow(row, type) {
  if (!row) throw new Error(`${type}-not-found`)
  return row
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.keys(value).length ? value : null
  } catch {
    return null
  }
}

function mapTrackedMatch(row) {
  return {
    eventKey: row.event_key,
    league: row.league,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    mode: row.mode,
    sourceStatus: row.source_status,
    trackingStatus: row.tracking_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMonitorAccount(row) {
  if (!row) {
    return {
      id: PRIMARY_MONITOR_ACCOUNT_ID,
      label: '',
      username: '',
      loginUrl: '',
      status: 'disabled',
      enabled: false,
      hasSecret: false,
      secretUpdatedAt: '',
      notes: '',
      loginStatus: '未启动',
      currentMonitorStatus: '未启动',
      lastLoginAt: null,
      lastOnlineCheckAt: null,
      lastXmlResponseAt: null,
      lastOddsParsedAt: null,
      consecutiveFailures: 0,
      oddsScanIntervalSeconds: 10,
      autoReloginCount: 0,
      maxAutoReloginCount: 3,
      lastLoginResult: null,
      lastLoginResultAt: null,
      lastLoginDiagnosticsPath: null,
      createdAt: '',
      updatedAt: '',
    }
  }
  const lastLoginResult = parseJsonObject(row.last_login_result_json)
  return redactSecretFields({
    id: row.id,
    label: row.label,
    username: row.username,
    loginUrl: String(row.login_url || '').trim(),
    status: row.status,
    enabled: intToBool(row.enabled),
    secret_ciphertext: row.secret_ciphertext,
    secretUpdatedAt: row.secret_updated_at,
    notes: row.notes,
    loginStatus: row.login_status || '未启动',
    currentMonitorStatus: row.current_monitor_status || '未启动',
    lastLoginAt: row.last_login_at || null,
    lastOnlineCheckAt: row.last_online_check_at || null,
    lastXmlResponseAt: row.last_xml_response_at || null,
    lastOddsParsedAt: row.last_odds_parsed_at || null,
    consecutiveFailures: row.consecutive_failures || 0,
    oddsScanIntervalSeconds: row.odds_scan_interval_seconds || 10,
    autoReloginCount: row.auto_relogin_count || 0,
    maxAutoReloginCount: row.max_auto_relogin_count ?? 3,
    lastLoginResult,
    lastLoginResultAt: row.last_login_result_at || null,
    lastLoginDiagnosticsPath: row.last_login_diagnostics_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function mapMonitorRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: intToBool(row.enabled),
    leagueFilter: row.league_filter,
    modeFilter: row.mode_filter,
    marketFilter: row.market_filter,
    minOddsChange: row.min_odds_change,
    pollSeconds: row.poll_seconds,
    alertEnabled: intToBool(row.alert_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapBettingRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: intToBool(row.enabled),
    leagueNames: JSON.parse(row.league_names_json),
    targetAmount: formatMinor(row.target_amount_minor, { scale: row.amount_scale }),
    currency: row.currency,
    amountScale: row.amount_scale,
    changedOddsMin: row.changed_odds_min,
    changedOddsMax: row.changed_odds_max,
    direction: 'up_reverse',
    executionMode: row.execution_mode,
    version: row.version,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAutoBetRule(row) {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    monitorEnabled: intToBool(row.monitor_enabled),
    realBettingEnabled: intToBool(row.real_betting_enabled),
    archived: intToBool(row.archived),
    mode: row.mode,
    period: row.period,
    marketType: row.market_type,
    monitoredSide: row.monitored_side,
    minWaterRise: row.min_water_rise,
    targetOddsMin: row.target_odds_min,
    targetOddsMax: row.target_odds_max,
    targetAmountMinor: row.target_amount_minor,
    leagueNames: JSON.parse(row.league_names_json || '[]'),
    startMinutesBeforeKickoff: row.start_minutes_before_kickoff,
    stopMinutesBeforeKickoff: row.stop_minutes_before_kickoff,
    liveMinuteFrom: row.live_minute_from,
    liveMinuteTo: row.live_minute_to,
    migrationReviewRequired: intToBool(row.migration_review_required),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAutoBettingRuleCard(row, leagueNames = []) {
  return {
    cardId: row.card_id,
    name: row.name,
    enabled: intToBool(row.enabled),
    leagueNames,
    targetOddsMin: row.target_odds_min,
    targetOddsMax: row.target_odds_max,
    targetAmountMinor: row.target_amount_minor,
    currency: row.currency,
    amountScale: row.amount_scale,
    remark: row.remark,
    realEligible: intToBool(row.real_eligible),
    realEligibilityVersion: row.real_eligibility_version,
    realEligibilityUpdatedAt: row.real_eligibility_updated_at,
    migrationReviewRequired: intToBool(row.migration_review_required),
    migrationReviewReason: row.migration_review_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SIGNAL_SUMMARY = Object.freeze({ ready: '待处理', processing: '处理中', expired: '已过期', completed: '已完成' })
const BATCH_SUMMARY = Object.freeze({ queued: '排队中', allocating: '分配中', waiting_capacity: '等待额度',
  submitting: '提交中', waiting_result: '等待结果', completed: '已完成', partial: '部分完成',
  failed: '失败', cancelled: '已取消' })
const RESULT_SUMMARY = Object.freeze({ previewing: '预览中', reserved: '已预留', submit_prepared: '待提交',
  submit_dispatched: '已提交', accepted: '已接受', rejected: '已拒绝', unknown: '待确认', cancelled: '已取消' })

function recentRuleCardSummaries(db, cardId) {
  const signal = db.prepare(`SELECT signal.status FROM auto_betting_signal_inbox AS inbox
    INNER JOIN monitor_signals AS signal ON signal.signal_id=inbox.signal_id
    WHERE inbox.card_id=? ORDER BY signal.observed_at DESC,signal.signal_id DESC LIMIT 1`).get(cardId)
  const batch = db.prepare(`SELECT status FROM bet_batches WHERE card_id=?
    ORDER BY created_at DESC,batch_id DESC LIMIT 1`).get(cardId)
  const result = db.prepare(`SELECT child.status FROM bet_child_orders AS child
    INNER JOIN bet_batches AS batch ON batch.batch_id=child.batch_id
    WHERE batch.card_id=?
    ORDER BY COALESCE(NULLIF(child.resolved_at,''),NULLIF(child.submitted_at,''),child.created_at) DESC,
      child.child_order_id DESC LIMIT 1`).get(cardId)
  return {
    recentSignal: signal ? `Signal：${SIGNAL_SUMMARY[signal.status] || '状态未知'}` : null,
    recentBatch: batch ? `批次：${BATCH_SUMMARY[batch.status] || '状态未知'}` : null,
    recentResult: result ? `结果：${RESULT_SUMMARY[result.status] || '状态未知'}` : null,
  }
}

function mapBettingAccount(row) {
  return redactSecretFields({
    id: row.id,
    label: row.label,
    username: row.username,
    websiteUrl: normalizeLoginUrlValue(row.website_url),
    betOrder: Number(row.bet_order || 0),
    status: row.status,
    archived: intToBool(row.archived),
    allocationStatus: row.allocation_status || 'paused',
    perBetLimit: String(row.per_bet_limit_minor),
    currency: row.currency,
    balance: row.balance_minor === null ? null : String(row.balance_minor),
    balanceUpdatedAt: row.balance_updated_at || null,
    executionStatus: row.lock_status || row.execution_status || 'idle',
    accessStatus: row.access_status || 'unchecked',
    accessCheckedAt: row.access_checked_at || null,
    accessErrorCode: row.access_error_code || '',
    reportedBalance: row.reported_balance ?? null,
    reportedCurrency: row.reported_currency || '',
    reportedBalanceUpdatedAt: row.reported_balance_updated_at || null,
    secret_ciphertext: row.secret_ciphertext,
    secretUpdatedAt: row.secret_updated_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function shanghaiDayBounds(nowValue) {
  const date = new Date(nowValue)
  if (!Number.isFinite(date.getTime())) throw new TypeError('now')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  const start = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`)
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  }
}

function formatBigIntMinor(minor, scale) {
  const digits = minor.toString().padStart(scale + 1, '0')
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
}

function acceptedTodayStats(db, accounts, nowValue) {
  const { start, end } = shanghaiDayBounds(nowValue)
  const statement = db.prepare(`
    SELECT
      bet_child_orders.account_id,
      bet_child_orders.requested_amount_minor,
      bet_batches.amount_scale
    FROM bet_child_orders
    INNER JOIN bet_batches ON bet_batches.batch_id = bet_child_orders.batch_id
    INNER JOIN betting_accounts
      ON betting_accounts.id = bet_child_orders.account_id
     AND betting_accounts.currency = bet_batches.currency
    WHERE bet_child_orders.status = 'accepted'
      AND bet_child_orders.resolved_at >= ?
      AND bet_child_orders.resolved_at < ?
    ORDER BY bet_child_orders.account_id, bet_child_orders.child_order_id
  `)
  statement.setReadBigInts(true)
  const totals = new Map(accounts.map((account) => [account.id, {
    count: 0,
    minor: 0n,
    scale: 0,
  }]))
  for (const row of statement.all(start, end)) {
    const total = totals.get(row.account_id)
    if (!total) continue
    const rowScale = Number(row.amount_scale)
    if (rowScale > total.scale) {
      total.minor *= 10n ** BigInt(rowScale - total.scale)
      total.scale = rowScale
    }
    total.minor += row.requested_amount_minor * (10n ** BigInt(total.scale - rowScale))
    total.count += 1
  }
  return new Map([...totals].map(([accountId, total]) => [accountId, {
    acceptedTodayCount: total.count,
    acceptedTodayAmount: formatBigIntMinor(total.minor, total.scale),
  }]))
}

function withAcceptedTodayStats(db, accounts, nowValue) {
  const stats = acceptedTodayStats(db, accounts, nowValue)
  return accounts.map((account) => ({ ...account, ...stats.get(account.id) }))
}

function mapBettingAccountForExecution(row, secretOptions) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    password: decryptSecret(row.secret_ciphertext, secretOptions),
    loginUrl: normalizeLoginUrlValue(row.website_url),
    websiteUrl: normalizeLoginUrlValue(row.website_url),
    betOrder: Number(row.bet_order || 0),
    status: row.status,
    archived: intToBool(row.archived),
    perBetLimit: String(row.per_bet_limit_minor),
    perBetLimitMinor: row.per_bet_limit_minor,
    currency: row.currency,
    balance: row.balance_minor === null ? null : String(row.balance_minor),
    balanceMinor: row.balance_minor,
    balanceUpdatedAt: row.balance_updated_at || null,
    executionStatus: row.lock_status || row.execution_status || 'idle',
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function bettingAccountEnableRevision(row) {
  return JSON.stringify([
    row.id, row.label, row.username, row.website_url, row.bet_order, row.purpose,
    row.status, row.archived, row.allocation_status, row.per_bet_limit_minor,
    row.currency, row.amount_scale, row.stake_step_minor, row.balance_minor,
    row.balance_updated_at, row.execution_status, row.access_status,
    row.access_checked_at, row.access_error_code, row.reported_balance,
    row.reported_currency, row.reported_balance_updated_at, row.secret_ciphertext,
    row.secret_updated_at, row.notes, row.created_at, row.updated_at,
  ])
}

function bettingExecutionAccountId(value) {
  const accountId = String(value || '').trim()
  if (!accountId) throw new TypeError('betting-account-id-required')
  if (accountId === PRIMARY_MONITOR_ACCOUNT_ID) throw new TypeError('betting-account-monitor-forbidden')
  return accountId
}

function assertBettingAccountExecutionContract(row) {
  if (row.status !== 'enabled') throw new Error('betting-account-disabled')
  if (Number(row.archived) !== 0) throw new Error('betting-account-archived')
  if (!String(row.username || '').trim()) throw new Error('betting-account-username')
  if (!String(row.secret_ciphertext || '').trim()) throw new Error('betting-account-secret')
  const loginUrl = normalizeLoginUrlValue(row.website_url)
  let url
  try { url = new URL(loginUrl) } catch { throw new Error('betting-account-url') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.host) throw new Error('betting-account-url')
  try {
    if (normalizeCurrency(row.currency) !== row.currency) throw new Error('betting-account-currency')
  } catch {
    throw new Error('betting-account-currency')
  }
  if (row.currency !== 'CNY' || row.amount_scale !== 0) {
    throw new Error('betting-account-scale')
  }
  if (!Number.isSafeInteger(row.per_bet_limit_minor) || row.per_bet_limit_minor < 1) {
    throw new Error('betting-account-per-bet-limit')
  }
}

function mapBetBatch(row) {
  const scale = row.amount_scale
  return {
    batchId: row.batch_id,
    signalId: row.signal_id,
    ruleId: row.rule_id,
    eventKey: row.event_key,
    lockedSelectionIdentity: row.locked_selection_identity,
    ruleVersion: row.rule_version,
    sourceLeague: row.source_league,
    sourceOdds: row.source_odds,
    currency: row.currency,
    amountScale: scale,
    targetAmount: formatMinor(row.target_amount_minor, { scale }),
    reservedAmount: formatMinor(row.reserved_amount_minor, { scale }),
    acceptedAmount: formatMinor(row.accepted_amount_minor, { scale }),
    unknownAmount: formatMinor(row.unknown_amount_minor, { scale }),
    unfilledAmount: formatMinor(row.unfilled_amount_minor, { scale }),
    status: row.status,
    finishReason: row.finish_reason,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function mapBetChildOrder(row) {
  const scale = row.amount_scale
  return {
    childOrderId: row.child_order_id,
    batchId: row.batch_id,
    accountId: row.account_id,
    attempt: row.attempt,
    currency: row.currency,
    amountScale: scale,
    requestedAmount: formatMinor(row.requested_amount_minor, { scale }),
    previewMinStake: formatMinor(row.preview_min_stake_minor, { scale }),
    previewMaxStake: formatMinor(row.preview_max_stake_minor, { scale }),
    previewBalance: row.preview_balance_minor === null ? null : formatMinor(row.preview_balance_minor, { scale }),
    previewStakeStep: formatMinor(row.preview_stake_step_minor, { scale }),
    previewOdds: row.preview_odds,
    providerReference: row.provider_reference_ciphertext ? '[masked]' : null,
    submitAttemptId: row.submit_attempt_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    submitPreparedAt: row.submit_prepared_at,
    submitDispatchedAt: row.submit_dispatched_at,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
  }
}

function boundedLimit(value, { fallback = 50, max = 100 } = {}) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) return fallback
  return Math.min(number, max)
}

const BET_TARGET_HISTORY_STATUSES = new Set(['all', 'active', 'completed', 'partial', 'failed', 'waiting_result'])
const BET_TARGET_HISTORY_MODES = new Set(['all', 'prematch', 'live'])
const UNAVAILABLE_HISTORY_TEXT = '历史信息不可用'

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function historyCursor(row) {
  return Buffer.from(JSON.stringify([row.created_at, row.batch_id]), 'utf8').toString('base64url')
}

function parseHistoryCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || !parsed[0] || !parsed[1]) throw new Error('cursor')
    return { createdAt: parsed[0], batchId: parsed[1] }
  } catch {
    throw new ValidationError('validation-error', { cursor: 'invalid cursor' })
  }
}

function lockedHistorySelection(row) {
  const direct = safeJsonObject(row.locked_selection_identity)
  if (direct) return direct
  const legacy = safeJsonObject(row.rule_snapshot_json)
  return legacy && safeJsonObject(JSON.stringify(legacy.lockedSelection))
}

function historyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : UNAVAILABLE_HISTORY_TEXT
}

function historySnapshot(row) {
  const locked = lockedHistorySelection(row)
  if (!locked) return null
  const snapshot = locked.snapshot && typeof locked.snapshot === 'object' && !Array.isArray(locked.snapshot)
    ? locked.snapshot
    : {}
  const event = snapshot.event && typeof snapshot.event === 'object' && !Array.isArray(snapshot.event)
    ? snapshot.event
    : {}
  const market = snapshot.market && typeof snapshot.market === 'object' && !Array.isArray(snapshot.market)
    ? snapshot.market
    : {}
  const selection = snapshot.selection && typeof snapshot.selection === 'object' && !Array.isArray(snapshot.selection)
    ? snapshot.selection
    : {}
  const signal = safeJsonObject(row.signal_payload_json)
  const evidence = signal?.evidence && typeof signal.evidence === 'object' && !Array.isArray(signal.evidence)
    ? signal.evidence
    : {}
  const period = locked.period || market.period || evidence.period
  const marketType = locked.marketType || market.marketType || evidence.marketType
  const side = locked.side || selection.side
  const handicapRaw = locked.handicapRaw || market.handicapRaw || evidence.handicapRaw
  if (![period, marketType, side, handicapRaw].every((value) => typeof value === 'string' && value.trim())) return null
  return {
    match: {
      leagueName: historyText(event.leagueName || event.league || evidence.leagueName || evidence.league || row.source_league),
      homeTeam: historyText(event.homeTeam || evidence.homeTeam),
      awayTeam: historyText(event.awayTeam || evidence.awayTeam),
    },
    direction: {
      mode: historyText(row.betting_mode || snapshot.mode || evidence.mode),
      period: historyText(period),
      marketType: historyText(marketType),
      side: historyText(side),
      handicapRaw: historyText(handicapRaw),
    },
  }
}

function decimalOdds(value) {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(value || '').trim())
  if (!match) return null
  const fraction = match[2] || ''
  return { minor: BigInt(`${match[1]}${fraction}`), scale: fraction.length }
}

function decimalFromScaled(value, scale) {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const text = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '')
    : digits
  return negative ? `-${text}` : text
}

function formatHistoryMinor(value, scale) {
  const digits = value.toString().padStart(scale + 1, '0')
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
}

function acceptedHistorySummary(children, amountScale) {
  const acceptedBetCount = children.length
  const completedMinor = children.reduce((sum, row) => sum + BigInt(row.requested_amount_minor), 0n)
  const odds = children.map((row) => decimalOdds(row.preview_odds))
  let averageAcceptedOdds = null
  if (children.length > 0 && odds.every(Boolean)) {
    const oddsScale = Math.max(...odds.map((item) => item.scale))
    const weighted = children.reduce((sum, row, index) => {
      const item = odds[index]
      return sum + BigInt(row.requested_amount_minor) * item.minor * (10n ** BigInt(oddsScale - item.scale))
    }, 0n)
    const total = completedMinor
    if (total > 0n) averageAcceptedOdds = decimalFromScaled((weighted + total / 2n) / total, oddsScale)
  }
  return {
    acceptedBetCount,
    averageAcceptedOdds,
    completedAmount: formatHistoryMinor(completedMinor, amountScale),
  }
}

function mapBetTargetHistory(row, children) {
  const immutable = historySnapshot(row) || {
    match: {
      leagueName: UNAVAILABLE_HISTORY_TEXT,
      homeTeam: UNAVAILABLE_HISTORY_TEXT,
      awayTeam: UNAVAILABLE_HISTORY_TEXT,
    },
    direction: {
      mode: historyText(row.betting_mode),
      period: UNAVAILABLE_HISTORY_TEXT,
      marketType: UNAVAILABLE_HISTORY_TEXT,
      side: UNAVAILABLE_HISTORY_TEXT,
      handicapRaw: UNAVAILABLE_HISTORY_TEXT,
    },
  }
  return {
    historyKey: crypto.createHash('sha256').update(row.batch_id, 'utf8').digest('hex'),
    createdAt: row.created_at,
    finishedAt: row.finished_at || null,
    ...immutable,
    status: row.status,
    finishReason: row.finish_reason,
    ...acceptedHistorySummary(children, row.amount_scale),
    targetAmount: formatMinor(row.target_amount_minor, { scale: row.amount_scale }),
    unknownAmount: formatMinor(row.unknown_amount_minor, { scale: row.amount_scale }),
    currency: row.currency,
  }
}

function mapBettingHistory(row) {
  const details = JSON.parse(row.details_json || '{}')
  const event = details.intent?.event || details.event || {}
  const market = details.intent?.market || details.marketDetails || {}
  const homeTeam = event.homeTeam || details.homeTeam || ''
  const awayTeam = event.awayTeam || details.awayTeam || ''
  const detailTeams = Array.isArray(details.teams) ? details.teams.join(' vs ') : String(details.teams || '')
  const teams = detailTeams || (homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : '') || row.event_key || ''
  const marketText = String(details.market || details.handicap || [
    market.marketType || '',
    market.handicapRaw || '',
  ].filter(Boolean).join(' ') || '')
  const betTime = String(details.betTime || row.created_at || '')
  return {
    id: row.id,
    accountId: row.betting_account_id,
    bettingAccountId: row.betting_account_id,
    leagueName: String(details.leagueName || event.league || ''),
    teams,
    market: marketText,
    handicap: String(details.handicap || market.handicapRaw || ''),
    betTime,
    eventKey: row.event_key,
    ruleId: row.rule_id,
    status: row.status,
    amount: row.amount,
    oddsRaw: row.odds_raw,
    createdAt: row.created_at,
    details,
  }
}

function maybeEncrypt(secret, options) {
  if (secret === undefined) return null
  if (!secret) return ''
  return encryptSecret(secret, options)
}

function monitorEnabled(item, existing = null) {
  if (item.enabled !== undefined) return Boolean(item.enabled)
  if (item.status !== undefined) return item.status === 'enabled'
  return existing ? Boolean(existing.enabled) : false
}

function monitorStatus(item, enabled, existing = null) {
  if (item.status) return item.status
  if (enabled) return 'enabled'
  return existing?.status || 'disabled'
}

function defaultStatus(value, fallback = '未启动') {
  return value === undefined || value === null || value === '' ? fallback : value
}

function normalizeLoginUrlValue(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  return `https://${text}`
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

function readRuleCard(db, cardId) {
  const row = db.prepare('SELECT * FROM auto_betting_rule_cards WHERE card_id = ?').get(cardId)
  if (!row) return null
  const leagueNames = db.prepare(`
    SELECT league_name FROM auto_betting_rule_card_leagues
    WHERE card_id = ? ORDER BY created_at, league_name
  `).all(cardId).map((item) => item.league_name)
  return { ...mapAutoBettingRuleCard(row, leagueNames), ...recentRuleCardSummaries(db, cardId) }
}

function insertCardLeagues(db, cardId, leagueNames, createdAt) {
  const insert = db.prepare(`
    INSERT INTO auto_betting_rule_card_leagues (card_id, league_name, created_at)
    VALUES (?, ?, ?)
  `)
  for (const leagueName of leagueNames) insert.run(cardId, leagueName, createdAt)
}

function isRuleCardLeagueUniqueError(error) {
  return error?.code === 'ERR_SQLITE_ERROR'
    && error?.errcode === 2067
    && error?.message === 'UNIQUE constraint failed: auto_betting_rule_card_leagues.league_name'
}

function ruleCardLeagueConflictError(db, leagueNames, excludeCardId = '') {
  const rows = db.prepare(`
    SELECT leagues.league_name, cards.card_id, cards.name
    FROM auto_betting_rule_card_leagues AS leagues
    INNER JOIN auto_betting_rule_cards AS cards ON cards.card_id = leagues.card_id
    WHERE leagues.league_name IN (${leagueNames.map(() => '?').join(',')})
      AND cards.card_id <> ?
    ORDER BY leagues.created_at, leagues.league_name
  `).all(...leagueNames, excludeCardId)
  const error = new Error('league-owned-by-another-card')
  error.code = 'league-owned-by-another-card'
  error.fields = {
    leagueNames: rows.map((row) => row.league_name),
    ownerName: rows[0]?.name || '',
  }
  return error
}

function cardVersionConflict() {
  const error = new Error('auto-betting-card-version-conflict')
  error.code = 'auto-betting-card-version-conflict'
  return error
}

function cardNotFound() {
  const error = new Error('auto-betting-card-not-found')
  error.code = 'auto-betting-card-not-found'
  return error
}

function safeCount(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : 0
}

function autoBetRuleVersionConflict() {
  const error = new Error('auto-bet-rule-version-conflict')
  error.code = 'auto-bet-rule-version-conflict'
  return error
}

function settingsVersionConflict(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function assertAutoBetRuleVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) throw autoBetRuleVersionConflict()
}

function assertAutoBetRuleCanEnable(item, { real = false } = {}) {
  if (item.archived) throw new ValidationError('validation-error', { archived: 'archived rule cannot be enabled' })
  if (item.migrationReviewRequired) throw new ValidationError('validation-error', { migrationReviewRequired: 'rule requires migration review' })
  const candidate = {
    ...item,
    monitorEnabled: true,
    realBettingEnabled: real,
  }
  for (const field of item.mode === 'live'
    ? ['startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff']
    : ['liveMinuteFrom', 'liveMinuteTo']) delete candidate[field]
  normalizeAutoBetRule(candidate)
  if (real && !item.monitorEnabled) throw new ValidationError('validation-error', { monitorEnabled: 'real betting requires monitor enabled' })
}

function asValidationError(error, field = 'body') {
  if (error instanceof ValidationError) return error
  const code = String(error?.message || 'validation-error')
  if (error?.code === 'validation-error' && error?.fields && typeof error.fields === 'object') {
    return new ValidationError(code, error.fields)
  }
  return new ValidationError(code, { [field]: code })
}

function validateRule(item) {
  try {
    return validateBettingRulePolicy(item)
  } catch (error) {
    throw asValidationError(error)
  }
}

function validateAccountAmounts(item) {
  if (item.currency !== 'CNY' || typeof item.perBetLimit !== 'string' || !/^[1-9]\d*$/.test(item.perBetLimit)) {
    throw new ValidationError('integer-cny-required', { perBetLimit: 'perBetLimit must be a positive integer CNY string' })
  }
  const perBetLimitMinor = Number(item.perBetLimit)
  if (!Number.isSafeInteger(perBetLimitMinor)) {
    throw new ValidationError('integer-cny-required', { perBetLimit: 'perBetLimit must be a positive safe integer CNY string' })
  }
  return { ...item, currency: 'CNY', amountScale: 0, stakeStepMinor: 1, perBetLimitMinor }
}

function isLeagueUniqueError(error) {
  return String(error?.message || '').includes('betting_rule_leagues.league_name')
}

function findBettingRuleConflict(db, leagueNames, excludeRuleId = '') {
  const findOwner = db.prepare(`
    SELECT
      betting_rule_leagues.league_name,
      betting_rules.id AS rule_id,
      betting_rules.name AS rule_name
    FROM betting_rule_leagues
    INNER JOIN betting_rules ON betting_rules.id = betting_rule_leagues.rule_id
    WHERE betting_rule_leagues.league_name = ?
      AND betting_rules.id <> ?
    LIMIT 1
  `)
  for (const leagueName of leagueNames) {
    const row = findOwner.get(leagueName, excludeRuleId)
    if (row) return { leagueName: row.league_name, ruleId: row.rule_id, ruleName: row.rule_name }
  }
  return null
}

function bettingRuleConflictError(db, leagueNames, excludeRuleId = '') {
  const error = new Error('betting-rule-conflict')
  error.code = 'betting-rule-conflict'
  error.conflict = findBettingRuleConflict(db, leagueNames, excludeRuleId)
  return error
}

function assertNoBettingRuleConflict(db, leagueNames, excludeRuleId = '') {
  if (findBettingRuleConflict(db, leagueNames, excludeRuleId)) {
    throw bettingRuleConflictError(db, leagueNames, excludeRuleId)
  }
}

const RULE_EXECUTION_FIELDS = ['enabled', 'leagueNames', 'targetAmount', 'currency', 'amountScale', 'changedOddsMin', 'changedOddsMax', 'direction', 'executionMode']

function executionRuleChanged(before, after) {
  return RULE_EXECUTION_FIELDS.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
}

export function createAppRepository(db, {
  secretKey, env = process.env, now = () => new Date(), dbPath = '', runtimeDir = 'data/runtime', cwd,
} = {}) {
  const secretOptions = { secretKey, env }
  const currentIso = () => {
    const value = typeof now === 'function' ? now() : now
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isFinite(date.getTime())) throw new TypeError('now')
    return date.toISOString()
  }

  return {
    sealCrownProviderReference(value, { childOrderId, submitAttemptId } = {}) {
      const reference = String(value || '')
      const child = String(childOrderId || '').trim()
      const attempt = String(submitAttemptId || '').trim()
      if (!reference || !child || !attempt) throw new Error('provider-reference-context')
      return encryptSecret(reference, {
        ...secretOptions,
        context: {
          purpose: 'crown-provider-reference',
          childOrderId: child,
          submitAttemptId: attempt,
        },
      })
    },

    getSchemaVersion() {
      return db.prepare("SELECT meta_value FROM app_schema_meta WHERE meta_key = 'schema_contract'").get()?.meta_value || ''
    },

    bootstrap() {
      return {
        trackedMatches: this.listTrackedMatches(),
        monitorAccounts: this.listMonitorAccounts(),
        monitorRules: this.listMonitorRules(),
        bettingRules: this.listBettingRules(),
        bettingAccounts: this.listBettingAccounts(),
        bettingHistory: this.listBettingHistory(),
      }
    },

    getMonitorAlertSettings() {
      const rows = db.prepare("SELECT * FROM monitor_alert_settings WHERE mode IN ('prematch','live') ORDER BY CASE mode WHEN 'prematch' THEN 0 ELSE 1 END").all()
      const items = Object.fromEntries(rows.map((row) => [row.mode, monitorAlertSettingFromRow(row)]))
      return { items, summary: monitorAlertSettingsSummary(items) }
    },

    updateMonitorAlertSetting(mode, payload) {
      let normalized
      try {
        normalized = normalizeMonitorAlertSetting(mode, payload)
      } catch (error) {
        throw asValidationError(error)
      }
      return runImmediate(db, () => {
        const current = requiredRow(db.prepare('SELECT * FROM monitor_alert_settings WHERE mode = ?').get(mode), 'monitor-alert-settings')
        if (current.version !== normalized.expectedVersion) throw settingsVersionConflict('monitor-alert-settings-version-conflict')
        if (normalized.acknowledgeMigrationReview && !current.migration_review_required) {
          throw new ValidationError('validation-error', { acknowledgeMigrationReview: 'migration review is not required' })
        }
        if (normalized.item.enabled && current.migration_review_required && !normalized.acknowledgeMigrationReview) {
          throw new ValidationError('validation-error', { enabled: 'migration review must be completed before enabling' })
        }
        const item = normalized.item
        const prematch = mode === 'prematch'
        const changed = db.prepare(`
          UPDATE monitor_alert_settings SET
            enabled = ?, asian_handicap_enabled = ?, total_enabled = ?,
            monitor_odds_min = ?, monitor_odds_max = ?, water_move_threshold = ?, cooldown_seconds = ?,
            start_minutes_before_kickoff = ?, stop_minutes_before_kickoff = ?,
            live_minute_from = ?, live_minute_to = ?, include_first_half = ?, include_half_time = ?, include_second_half = ?,
            remark = ?,
            migration_review_required = ?, migration_review_reason = ?,
            version = version + 1, updated_at = ?
          WHERE mode = ? AND version = ?
        `).run(
          boolToInt(item.enabled), boolToInt(item.asianHandicapEnabled), boolToInt(item.totalEnabled),
          item.monitorOddsMin, item.monitorOddsMax, item.waterMoveThreshold, item.cooldownSeconds,
          prematch ? item.startMinutesBeforeKickoff : null, prematch ? item.stopMinutesBeforeKickoff : null,
          prematch ? null : item.liveMinuteFrom, prematch ? null : item.liveMinuteTo,
          prematch ? 0 : boolToInt(item.includeFirstHalf), prematch ? 0 : boolToInt(item.includeHalfTime), prematch ? 0 : boolToInt(item.includeSecondHalf),
          item.remark,
          normalized.acknowledgeMigrationReview ? 0 : current.migration_review_required,
          normalized.acknowledgeMigrationReview ? '' : current.migration_review_reason,
          currentIso(), mode, normalized.expectedVersion,
        )
        if (changed.changes !== 1) throw settingsVersionConflict('monitor-alert-settings-version-conflict')
        if (normalized.acknowledgeMigrationReview) {
          db.prepare(`
            INSERT INTO execution_security_audit (
              audit_id, action, subject_type, subject_id,
              confirmation_digest, details_json, created_at
            ) VALUES (?, 'monitor_alert_migration_review_completed', 'monitor_alert_setting', ?, '', ?, ?)
          `).run(
            crypto.randomUUID(), mode,
            JSON.stringify({ fromVersion: normalized.expectedVersion, toVersion: normalized.expectedVersion + 1 }), currentIso(),
          )
        }
        return monitorAlertSettingFromRow(db.prepare('SELECT * FROM monitor_alert_settings WHERE mode = ?').get(mode))
      })
    },

    getAutoBettingSettings() {
      const rows = db.prepare("SELECT * FROM auto_betting_settings WHERE mode IN ('prematch','live') ORDER BY CASE mode WHEN 'prematch' THEN 0 ELSE 1 END").all()
      const items = Object.fromEntries(rows.map((row) => [row.mode, autoBettingSettingFromRow(row)]))
      return { items, summary: autoBettingSettingsSummary(items) }
    },

    updateAutoBettingSetting(mode, payload) {
      let normalized
      try {
        normalized = normalizeAutoBettingSetting(mode, payload)
      } catch (error) {
        throw asValidationError(error)
      }
      return runImmediate(db, () => {
        const current = requiredRow(db.prepare('SELECT * FROM auto_betting_settings WHERE mode = ?').get(mode), 'auto-betting-settings')
        if (current.version !== normalized.expectedVersion) throw settingsVersionConflict('auto-betting-settings-version-conflict')
        if (normalized.item.enabled && current.migration_review_required) {
          throw new ValidationError('validation-error', { enabled: 'migration review must be completed before enabling' })
        }
        const item = normalized.item
        const changed = db.prepare(`
          UPDATE auto_betting_settings SET
            enabled = ?, target_odds_min = ?, target_odds_max = ?, target_amount_minor = ?,
            currency = ?, amount_scale = ?, remark = ?, version = version + 1, updated_at = ?
          WHERE mode = ? AND version = ?
        `).run(
          boolToInt(item.enabled), item.targetOddsMin, item.targetOddsMax, item.targetAmountMinor,
          item.currency, item.amountScale, item.remark, currentIso(), mode, normalized.expectedVersion,
        )
        if (changed.changes !== 1) throw settingsVersionConflict('auto-betting-settings-version-conflict')
        return autoBettingSettingFromRow(db.prepare('SELECT * FROM auto_betting_settings WHERE mode = ?').get(mode))
      })
    },

    listAutoBettingRuleCards() {
      return db.prepare(`
        SELECT * FROM auto_betting_rule_cards ORDER BY created_at, card_id
      `).all().map((row) => readRuleCard(db, row.card_id))
    },

    listTodayBettingLeagues(cardId, { defaultLeagues }) {
      const catalog = buildTodayBettingLeagues({
        db,
        defaultLeagues,
      })
      const owners = new Map(db.prepare(`
        SELECT leagues.league_name, cards.card_id, cards.name
        FROM auto_betting_rule_card_leagues AS leagues
        INNER JOIN auto_betting_rule_cards AS cards ON cards.card_id = leagues.card_id
      `).all().map((row) => [row.league_name, row]))
      const items = catalog.map((item) => {
        const owner = owners.get(item.leagueName)
        return {
          ...item,
          ownerCardId: owner?.card_id || null,
          ownerCardName: owner?.name || null,
          selectable: !owner || owner.card_id === cardId,
          availableToday: true,
        }
      })
      const availableNames = new Set(catalog.map((item) => item.leagueName))
      for (const [leagueName, owner] of owners) {
        if (owner.card_id !== cardId || availableNames.has(leagueName)) continue
        items.push({
          leagueName,
          source: 'stale',
          todayMatchCount: 0,
          ownerCardId: owner.card_id,
          ownerCardName: owner.name,
          selectable: true,
          availableToday: false,
        })
      }
      return items
    },

    createAutoBettingRuleCard(payload, { defaultLeagues }) {
      return runImmediate(db, () => {
        const catalog = buildTodayBettingLeagues({
          db,
          defaultLeagues,
        })
        const item = normalizeRuleCardCreate(payload, {
          availableLeagueNames: catalog.map((entry) => entry.leagueName),
        })
        const cardId = id('betcard')
        const time = currentIso()
        db.prepare(`
          INSERT INTO auto_betting_rule_cards (
            card_id, name, enabled, target_odds_min, target_odds_max,
            target_amount_minor, currency, amount_scale, remark, real_eligible,
            real_eligibility_version, real_eligibility_updated_at,
            migration_review_required, migration_review_reason, version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'CNY', 0, ?, 0, 1, ?, 0, '', 1, ?, ?)
        `).run(
          cardId, item.name, boolToInt(item.enabled), item.targetOddsMin,
          item.targetOddsMax, item.targetAmountMinor, item.remark, time, time, time,
        )
        try {
          insertCardLeagues(db, cardId, item.leagueNames, time)
        } catch (error) {
          if (isRuleCardLeagueUniqueError(error)) {
            throw ruleCardLeagueConflictError(db, item.leagueNames, cardId)
          }
          throw error
        }
        return readRuleCard(db, cardId)
      })
    },

    updateAutoBettingRuleCard(cardId, payload, { defaultLeagues }) {
      return runImmediate(db, () => {
        const current = readRuleCard(db, cardId)
        if (!current) {
          const error = new Error('auto-betting-card-not-found')
          error.code = 'auto-betting-card-not-found'
          throw error
        }
        const catalog = buildTodayBettingLeagues({
          db,
          defaultLeagues,
        })
        const item = normalizeRuleCardUpdate(payload, {
          availableLeagueNames: catalog.map((entry) => entry.leagueName),
          existingLeagueNames: current.leagueNames,
        })
        if (current.version !== payload.expectedVersion) throw cardVersionConflict()
        const time = currentIso()
        const changed = db.prepare(`
          UPDATE auto_betting_rule_cards SET
            name = ?, enabled = ?, target_odds_min = ?, target_odds_max = ?,
            target_amount_minor = ?, currency = 'CNY', amount_scale = 0,
            remark = ?, real_eligible = 0,
            real_eligibility_version = real_eligibility_version + 1,
            real_eligibility_updated_at = ?, migration_review_required = 0,
            migration_review_reason = '', version = version + 1, updated_at = ?
          WHERE card_id = ? AND version = ?
        `).run(
          item.name, boolToInt(item.enabled), item.targetOddsMin,
          item.targetOddsMax, item.targetAmountMinor, item.remark, time, time,
          cardId, payload.expectedVersion,
        )
        if (changed.changes !== 1) throw cardVersionConflict()
        db.prepare('DELETE FROM auto_betting_rule_card_leagues WHERE card_id = ?').run(cardId)
        try {
          insertCardLeagues(db, cardId, item.leagueNames, time)
        } catch (error) {
          if (isRuleCardLeagueUniqueError(error)) {
            throw ruleCardLeagueConflictError(db, item.leagueNames, cardId)
          }
          throw error
        }
        return readRuleCard(db, cardId)
      })
    },

    deleteAutoBettingRuleCard(cardId, payload) {
      const expectedVersion = normalizeExpectedVersion(payload)
      return runImmediate(db, () => {
        const card = db.prepare('SELECT card_id,version FROM auto_betting_rule_cards WHERE card_id=?').get(cardId)
        if (!card) throw cardNotFound()
        if (Number(card.version) !== expectedVersion) throw cardVersionConflict()
        terminateRuleCardInboxBeforeDelete(db, { cardId: card.card_id, now: new Date(currentIso()) })
        const deleted = db.prepare('DELETE FROM auto_betting_rule_cards WHERE card_id=? AND version=?')
          .run(card.card_id, expectedVersion)
        if (deleted.changes !== 1) throw cardVersionConflict()
        return { ok: true }
      })
    },

    listTrackedMatches() {
      return db.prepare('SELECT * FROM tracked_matches ORDER BY updated_at DESC, event_key ASC').all().map(mapTrackedMatch)
    },

    trackMatch(payload) {
      const item = normalizeTrackedMatch(payload)
      if (!item.tracked) return this.untrackMatch(item.eventKey)
      const time = nowIso()
      db.prepare(`
        INSERT INTO tracked_matches (
          event_key, league, home_team, away_team, mode, source_status, tracking_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          league = excluded.league,
          home_team = excluded.home_team,
          away_team = excluded.away_team,
          mode = excluded.mode,
          source_status = excluded.source_status,
          tracking_status = 'active',
          updated_at = excluded.updated_at
      `).run(item.eventKey, item.league, item.homeTeam, item.awayTeam, item.mode, item.sourceStatus, time, time)
      return mapTrackedMatch(db.prepare('SELECT * FROM tracked_matches WHERE event_key = ?').get(item.eventKey))
    },

    untrackMatch(eventKey) {
      const time = nowIso()
      const row = db.prepare('SELECT * FROM tracked_matches WHERE event_key = ?').get(eventKey)
      if (!row) throw new Error('tracked-match-not-found')
      db.prepare('UPDATE tracked_matches SET tracking_status = ?, updated_at = ? WHERE event_key = ?').run('inactive', time, eventKey)
      return mapTrackedMatch(db.prepare('SELECT * FROM tracked_matches WHERE event_key = ?').get(eventKey))
    },

    listMonitorAccounts() {
      return db.prepare('SELECT * FROM monitor_accounts ORDER BY updated_at DESC, label ASC').all().map(mapMonitorAccount)
    },

    getMonitorAccountForManualLogin(accountId) {
      const row = requiredRow(
        db.prepare('SELECT id, username, login_url FROM monitor_accounts WHERE id = ?').get(accountId),
        'monitor-account',
      )
      return {
        id: row.id,
        accountId: row.id,
        username: String(row.username || '').trim(),
        loginUrl: String(row.login_url || '').trim(),
      }
    },

    getBettingAccountForManualLogin(accountId) {
      const row = requiredRow(
        db.prepare(`SELECT id, username, website_url
          FROM betting_accounts WHERE id = ? AND archived = 0`).get(accountId),
        'betting-account',
      )
      return {
        id: row.id,
        accountId: row.id,
        username: String(row.username || '').trim(),
        loginUrl: String(row.website_url || '').trim(),
      }
    },

    getPrimaryMonitorAccount() {
      const row = db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID)
        || db.prepare('SELECT * FROM monitor_accounts ORDER BY updated_at DESC, label ASC LIMIT 1').get()
      return mapMonitorAccount(row)
    },

    savePrimaryMonitorAccount(payload) {
      const existing = db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID)
      const item = normalizeMonitorAccount(payload, { partial: Boolean(existing) })
      const time = nowIso()
      const encrypted = maybeEncrypt(item.secret, secretOptions)
      const enabled = monitorEnabled(item, existing)
      const status = monitorStatus(item, enabled, existing)
      if (enabled) db.prepare('UPDATE monitor_accounts SET enabled = 0, status = ? WHERE id <> ?').run('disabled', PRIMARY_MONITOR_ACCOUNT_ID)

      db.prepare(`
        INSERT INTO monitor_accounts (
          id, label, username, login_url, status, enabled, login_status, current_monitor_status,
          last_login_at, last_online_check_at, last_xml_response_at, last_odds_parsed_at,
          consecutive_failures, odds_scan_interval_seconds, auto_relogin_count, max_auto_relogin_count,
          last_login_result_json, last_login_result_at, last_login_diagnostics_path,
          secret_ciphertext, secret_updated_at, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          username = excluded.username,
          login_url = excluded.login_url,
          status = excluded.status,
          enabled = excluded.enabled,
          login_status = excluded.login_status,
          current_monitor_status = excluded.current_monitor_status,
          last_login_at = excluded.last_login_at,
          last_online_check_at = excluded.last_online_check_at,
          last_xml_response_at = excluded.last_xml_response_at,
          last_odds_parsed_at = excluded.last_odds_parsed_at,
          consecutive_failures = excluded.consecutive_failures,
          odds_scan_interval_seconds = excluded.odds_scan_interval_seconds,
          auto_relogin_count = excluded.auto_relogin_count,
          max_auto_relogin_count = excluded.max_auto_relogin_count,
          last_login_result_json = excluded.last_login_result_json,
          last_login_result_at = excluded.last_login_result_at,
          last_login_diagnostics_path = excluded.last_login_diagnostics_path,
          secret_ciphertext = excluded.secret_ciphertext,
          secret_updated_at = excluded.secret_updated_at,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(
        PRIMARY_MONITOR_ACCOUNT_ID,
        item.label || existing?.label || '',
        item.username || existing?.username || '',
        item.loginUrl ?? existing?.login_url ?? '',
        status,
        boolToInt(enabled),
        defaultStatus(item.loginStatus, existing?.login_status || '未启动'),
        defaultStatus(item.currentMonitorStatus, existing?.current_monitor_status || '未启动'),
        item.lastLoginAt ?? existing?.last_login_at ?? '',
        item.lastOnlineCheckAt ?? existing?.last_online_check_at ?? '',
        item.lastXmlResponseAt ?? existing?.last_xml_response_at ?? '',
        item.lastOddsParsedAt ?? existing?.last_odds_parsed_at ?? '',
        item.consecutiveFailures ?? existing?.consecutive_failures ?? 0,
        item.oddsScanIntervalSeconds ?? existing?.odds_scan_interval_seconds ?? 10,
        item.autoReloginCount ?? existing?.auto_relogin_count ?? 0,
        item.maxAutoReloginCount ?? existing?.max_auto_relogin_count ?? 3,
        item.lastLoginResult ? JSON.stringify(item.lastLoginResult) : existing?.last_login_result_json || '{}',
        item.lastLoginResultAt ?? existing?.last_login_result_at ?? '',
        item.lastLoginDiagnosticsPath ?? existing?.last_login_diagnostics_path ?? '',
        encrypted === null ? existing?.secret_ciphertext || '' : encrypted,
        encrypted === null ? existing?.secret_updated_at || '' : (encrypted ? time : ''),
        item.notes ?? existing?.notes ?? '',
        existing?.created_at || time,
        time,
      )
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID))
    },

    applyMonitorAccountAction(action) {
      const existing = db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID)
      if (!existing) this.savePrimaryMonitorAccount({ label: '', username: '', loginUrl: '', enabled: false })
      const time = nowIso()
      if (action === 'clear-state') {
        db.prepare(`
          UPDATE monitor_accounts SET
            login_status = '未启动',
            current_monitor_status = '未启动',
            last_login_at = '',
            last_online_check_at = '',
            last_xml_response_at = '',
            last_odds_parsed_at = '',
            last_login_result_json = '{}',
            last_login_result_at = '',
            last_login_diagnostics_path = '',
            consecutive_failures = 0,
            auto_relogin_count = 0,
            updated_at = ?
          WHERE id = ?
        `).run(time, PRIMARY_MONITOR_ACCOUNT_ID)
        return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID))
      }

      const statusByAction = {
        start: '打开网站中',
        stop: '已停止',
        'test-login': '打开网站中',
        relogin: '自动重登中',
      }
      const nextStatus = statusByAction[action]
      if (!nextStatus) throw new Error('invalid-monitor-account-action')
      db.prepare(`
        UPDATE monitor_accounts SET
          enabled = CASE WHEN ? = 'stop' THEN enabled ELSE 1 END,
          status = CASE WHEN ? = 'stop' THEN status ELSE 'enabled' END,
          current_monitor_status = ?,
          updated_at = ?
        WHERE id = ?
      `).run(action, action, nextStatus, time, PRIMARY_MONITOR_ACCOUNT_ID)
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(PRIMARY_MONITOR_ACCOUNT_ID))
    },

    updateMonitorAccountRuntime(accountId, payload = {}) {
      const existing = requiredRow(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId), 'monitor-account')
      const item = normalizeMonitorAccount(payload, { partial: true })
      const time = nowIso()
      db.prepare(`
        UPDATE monitor_accounts SET
          login_status = ?,
          current_monitor_status = ?,
          last_login_at = ?,
          last_online_check_at = ?,
          last_xml_response_at = ?,
          last_odds_parsed_at = ?,
          consecutive_failures = ?,
          auto_relogin_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        item.loginStatus ?? existing.login_status,
        item.currentMonitorStatus ?? existing.current_monitor_status,
        item.lastLoginAt ?? existing.last_login_at,
        item.lastOnlineCheckAt ?? existing.last_online_check_at,
        item.lastXmlResponseAt ?? existing.last_xml_response_at,
        item.lastOddsParsedAt ?? existing.last_odds_parsed_at,
        item.consecutiveFailures ?? existing.consecutive_failures,
        item.autoReloginCount ?? existing.auto_relogin_count,
        time,
        accountId,
      )
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId))
    },

    updateMonitorAccountLoginResult(accountId, payload = {}) {
      const existing = requiredRow(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId), 'monitor-account')
      const result = normalizeLoginResult(payload)
      const time = result.finishedAt || nowIso()
      const consecutiveFailures = result.ok ? 0 : Number(existing.consecutive_failures || 0) + 1
      db.prepare(`
        UPDATE monitor_accounts SET
          login_status = ?,
          current_monitor_status = ?,
          last_login_at = ?,
          last_online_check_at = ?,
          last_login_result_json = ?,
          last_login_result_at = ?,
          last_login_diagnostics_path = ?,
          consecutive_failures = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        result.status || existing.login_status,
        result.status || existing.current_monitor_status,
        result.ok ? time : existing.last_login_at,
        time,
        JSON.stringify(result),
        time,
        result.ok ? (result.diagnosticPath || '') : (result.diagnosticPath || existing.last_login_diagnostics_path || ''),
        consecutiveFailures,
        time,
        accountId,
      )
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId))
    },

    getEnabledMonitorAccountForRuntime() {
      const row = db.prepare(`
        SELECT * FROM monitor_accounts
        WHERE enabled = 1 AND status = 'enabled'
        ORDER BY updated_at DESC, label ASC
        LIMIT 1
      `).get()
      if (!row) return null
      return {
        ...mapMonitorAccount(row),
        password: decryptSecret(row.secret_ciphertext, secretOptions),
      }
    },

    createMonitorAccount(payload) {
      const item = normalizeMonitorAccount(payload)
      const time = nowIso()
      const accountId = id('mon')
      const ciphertext = maybeEncrypt(item.secret, secretOptions) || ''
      const enabled = monitorEnabled(item)
      const status = monitorStatus(item, enabled)
      if (enabled) db.prepare('UPDATE monitor_accounts SET enabled = 0, status = ? WHERE id <> ?').run('disabled', accountId)
      db.prepare(`
        INSERT INTO monitor_accounts (
          id, label, username, login_url, status, enabled, odds_scan_interval_seconds,
          max_auto_relogin_count, secret_ciphertext, secret_updated_at, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(accountId, item.label, item.username, item.loginUrl, status, boolToInt(enabled), item.oddsScanIntervalSeconds ?? 10, item.maxAutoReloginCount ?? 3, ciphertext, ciphertext ? time : '', item.notes, time, time)
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId))
    },

    updateMonitorAccount(accountId, payload) {
      const existing = requiredRow(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId), 'monitor-account')
      const item = normalizeMonitorAccount(payload, { partial: true })
      const time = nowIso()
      const encrypted = maybeEncrypt(item.secret, secretOptions)
      const enabled = monitorEnabled(item, existing)
      const status = monitorStatus(item, enabled, existing)
      if (enabled) db.prepare('UPDATE monitor_accounts SET enabled = 0, status = ? WHERE id <> ?').run('disabled', accountId)
      db.prepare(`
        UPDATE monitor_accounts SET
          label = ?, username = ?, login_url = ?, status = ?, enabled = ?,
          odds_scan_interval_seconds = ?, max_auto_relogin_count = ?,
          secret_ciphertext = ?, secret_updated_at = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        item.label || existing.label,
        item.username || existing.username,
        item.loginUrl ?? existing.login_url,
        status,
        boolToInt(enabled),
        item.oddsScanIntervalSeconds ?? existing.odds_scan_interval_seconds,
        item.maxAutoReloginCount ?? existing.max_auto_relogin_count,
        encrypted === null ? existing.secret_ciphertext : encrypted,
        encrypted === null ? existing.secret_updated_at : (encrypted ? time : ''),
        item.notes ?? existing.notes,
        time,
        accountId,
      )
      return mapMonitorAccount(db.prepare('SELECT * FROM monitor_accounts WHERE id = ?').get(accountId))
    },

    deleteMonitorAccount(accountId) {
      db.prepare('DELETE FROM monitor_accounts WHERE id = ?').run(accountId)
      return { ok: true }
    },

    listMonitorRules() {
      return db.prepare('SELECT * FROM monitor_rules ORDER BY updated_at DESC, name ASC').all().map(mapMonitorRule)
    },

    createMonitorRule(payload) {
      const item = normalizeMonitorRule(payload)
      const time = nowIso()
      const ruleId = id('mrule')
      db.prepare(`
        INSERT INTO monitor_rules (
          id, name, enabled, league_filter, mode_filter, market_filter, min_odds_change, poll_seconds,
          alert_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ruleId, item.name, boolToInt(item.enabled), item.leagueFilter, item.modeFilter, item.marketFilter, item.minOddsChange, item.pollSeconds, boolToInt(item.alertEnabled), time, time)
      return mapMonitorRule(db.prepare('SELECT * FROM monitor_rules WHERE id = ?').get(ruleId))
    },

    updateMonitorRule(ruleId, payload) {
      const existing = requiredRow(db.prepare('SELECT * FROM monitor_rules WHERE id = ?').get(ruleId), 'monitor-rule')
      const item = normalizeMonitorRule(payload, { partial: true })
      const time = nowIso()
      db.prepare(`
        UPDATE monitor_rules SET
          name = ?, enabled = ?, league_filter = ?, mode_filter = ?, market_filter = ?,
          min_odds_change = ?, poll_seconds = ?, alert_enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        item.name || existing.name,
        item.enabled === undefined ? existing.enabled : boolToInt(item.enabled),
        item.leagueFilter ?? existing.league_filter,
        item.modeFilter ?? existing.mode_filter,
        item.marketFilter ?? existing.market_filter,
        item.minOddsChange ?? existing.min_odds_change,
        item.pollSeconds ?? existing.poll_seconds,
        item.alertEnabled === undefined ? existing.alert_enabled : boolToInt(item.alertEnabled),
        time,
        ruleId,
      )
      return mapMonitorRule(db.prepare('SELECT * FROM monitor_rules WHERE id = ?').get(ruleId))
    },

    deleteMonitorRule(ruleId) {
      db.prepare('DELETE FROM monitor_rules WHERE id = ?').run(ruleId)
      return { ok: true }
    },

    listAutoBetRules() {
      return db.prepare('SELECT * FROM betting_rules ORDER BY archived ASC, priority ASC, created_at ASC, id ASC').all().map(mapAutoBetRule)
    },

    createAutoBetRule(payload) {
      validateAutoBetRuleCreatePayload(payload)
      const item = normalizeAutoBetRule(payload)
      if (item.monitorEnabled) assertAutoBetRuleCanEnable(item)
      if (item.realBettingEnabled) assertAutoBetRuleCanEnable(item, { real: true })
      const time = currentIso()
      const ruleId = id('abrule')
      return runImmediate(db, () => {
        const priority = db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM betting_rules WHERE archived = 0').get().priority
        db.prepare(`
          INSERT INTO betting_rules (
            id, name, priority, monitor_enabled, real_betting_enabled, archived,
            mode, period, market_type, monitored_side, min_water_rise,
            target_odds_min, target_odds_max, currency, amount_scale, target_amount_minor,
            league_names_json, start_minutes_before_kickoff, stop_minutes_before_kickoff,
            live_minute_from, live_minute_to, migration_review_required, version,
            execution_mode, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'CNY', 0, ?, ?, ?, ?, ?, ?, ?, 1,
            'preview_only', 0, ?, ?)
        `).run(
          ruleId, item.name, priority, boolToInt(item.monitorEnabled), boolToInt(item.realBettingEnabled),
          item.mode, item.period, item.marketType, item.monitoredSide,
          item.minWaterRise, item.targetOddsMin, item.targetOddsMax, item.targetAmountMinor,
          JSON.stringify(item.leagueNames), item.startMinutesBeforeKickoff, item.stopMinutesBeforeKickoff,
          item.liveMinuteFrom, item.liveMinuteTo, boolToInt(item.migrationReviewRequired), time, time,
        )
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
      })
    },

    updateAutoBetRule(ruleId, payload) {
      validateAutoBetRuleUpdatePayload(payload)
      const expectedVersion = normalizeExpectedVersion(payload)
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'auto-bet-rule')
        assertAutoBetRuleVersion(row, expectedVersion)
        const existing = mapAutoBetRule(row)
        const patch = { ...payload }
        delete patch.expectedVersion
        const acknowledgeMigrationReview = patch.acknowledgeMigrationReview === true
        delete patch.acknowledgeMigrationReview
        if (existing.migrationReviewRequired && Object.prototype.hasOwnProperty.call(patch, 'migrationReviewRequired')) {
          throw new ValidationError('validation-error', { migrationReviewRequired: 'migration review is cleared only by explicit acknowledgement' })
        }
        delete patch.migrationReviewRequired
        if (acknowledgeMigrationReview) {
          if (!existing.migrationReviewRequired) {
            throw new ValidationError('validation-error', { acknowledgeMigrationReview: 'rule does not require migration review' })
          }
          const requiredReviewFields = [
            'name', 'leagueNames', 'mode', 'period', 'marketType', 'monitoredSide', 'minWaterRise',
            'targetOddsMin', 'targetOddsMax', 'targetAmountMinor',
            ...(patch.mode === 'live' ? ['liveMinuteFrom', 'liveMinuteTo'] : ['startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff']),
          ]
          const missing = requiredReviewFields.find((field) => !Object.prototype.hasOwnProperty.call(patch, field))
          if (missing) throw new ValidationError('validation-error', { acknowledgeMigrationReview: `complete canonical edit required: ${missing}` })
          patch.migrationReviewRequired = false
        }
        const item = { ...existing, ...normalizeAutoBetRule(patch, { partial: true, current: existing }) }
        const time = currentIso()
        db.prepare(`
          UPDATE betting_rules SET
            name = ?, mode = ?, period = ?, market_type = ?, monitored_side = ?,
            min_water_rise = ?, target_odds_min = ?, target_odds_max = ?, target_amount_minor = ?,
            league_names_json = ?, start_minutes_before_kickoff = ?, stop_minutes_before_kickoff = ?,
            live_minute_from = ?, live_minute_to = ?, migration_review_required = ?,
            version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(
          item.name, item.mode, item.period, item.marketType, item.monitoredSide,
          item.minWaterRise, item.targetOddsMin, item.targetOddsMax, item.targetAmountMinor,
          JSON.stringify(item.leagueNames), item.startMinutesBeforeKickoff, item.stopMinutesBeforeKickoff,
          item.liveMinuteFrom, item.liveMinuteTo, boolToInt(item.migrationReviewRequired),
          time, ruleId, expectedVersion,
        )
        if (acknowledgeMigrationReview) {
          db.prepare(`
            INSERT INTO execution_security_audit (
              audit_id, action, subject_type, subject_id,
              confirmation_digest, details_json, created_at
            ) VALUES (?, 'auto_bet_rule_migration_review_completed', 'betting_rule', ?, '', ?, ?)
          `).run(
            crypto.randomUUID(), ruleId,
            JSON.stringify({ fromVersion: expectedVersion, toVersion: expectedVersion + 1 }), time,
          )
        }
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
      })
    },

    cloneAutoBetRule(ruleId, payload) {
      validateAutoBetRuleCasPayload(payload)
      const expectedVersion = normalizeExpectedVersion(payload)
      return runImmediate(db, () => {
        const source = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'auto-bet-rule')
        assertAutoBetRuleVersion(source, expectedVersion)
        const existingNames = new Set(db.prepare('SELECT name FROM betting_rules').all().map((row) => row.name))
        const baseName = `${source.name} (copy)`
        let name = baseName
        let suffix = 2
        while (existingNames.has(name)) name = `${baseName} ${suffix++}`
        const priority = db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS priority FROM betting_rules WHERE archived = 0').get().priority
        const cloneId = id('abrule')
        const time = currentIso()
        db.prepare(`
          INSERT INTO betting_rules (
            id, name, priority, monitor_enabled, real_betting_enabled, archived,
            mode, period, market_type, monitored_side, min_water_rise,
            target_odds_min, target_odds_max, currency, amount_scale, target_amount_minor,
            league_names_json, start_minutes_before_kickoff, stop_minutes_before_kickoff,
            live_minute_from, live_minute_to, migration_review_required, version,
            execution_mode, enabled, created_at, updated_at
          ) SELECT ?, ?, ?, 0, 0, 0, mode, period, market_type, monitored_side,
            min_water_rise, target_odds_min, target_odds_max, 'CNY', 0, target_amount_minor,
            league_names_json, start_minutes_before_kickoff, stop_minutes_before_kickoff,
            live_minute_from, live_minute_to, 0, 1, 'preview_only', 0, ?, ?
          FROM betting_rules WHERE id = ?
        `).run(cloneId, name, priority, time, time, ruleId)
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(cloneId))
      })
    },

    reorderAutoBetRules(payload) {
      const { items } = normalizeAutoBetRuleReorder(payload)
      return runImmediate(db, () => {
        const rows = db.prepare('SELECT * FROM betting_rules WHERE archived = 0 ORDER BY priority ASC, created_at ASC, id ASC').all()
        if (items.length !== rows.length) throw new ValidationError('validation-error', { items: 'items must cover every non-archived rule exactly once' })
        const byId = new Map(rows.map((row) => [row.id, row]))
        for (const item of items) {
          const row = byId.get(item.id)
          if (!row) throw new ValidationError('validation-error', { items: 'items contain an unknown or archived rule' })
          assertAutoBetRuleVersion(row, item.expectedVersion)
        }
        const time = currentIso()
        const update = db.prepare('UPDATE betting_rules SET priority = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        items.forEach((item, index) => {
          const row = byId.get(item.id)
          const priority = index + 1
          if (row.priority !== priority) update.run(priority, time, item.id, item.expectedVersion)
        })
        return items.map((item) => mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(item.id)))
      })
    },

    setAutoBetRuleMonitorEnabled(ruleId, enabled, payload) {
      validateAutoBetRuleCasPayload(payload)
      const expectedVersion = normalizeExpectedVersion(payload)
      if (typeof enabled !== 'boolean') throw new ValidationError('validation-error', { monitorEnabled: 'monitorEnabled must be a boolean' })
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'auto-bet-rule')
        assertAutoBetRuleVersion(row, expectedVersion)
        const item = mapAutoBetRule(row)
        if (enabled) assertAutoBetRuleCanEnable(item)
        if (!enabled && item.realBettingEnabled) {
          throw new ValidationError('validation-error', { monitorEnabled: 'disable real betting before disabling monitor' })
        }
        db.prepare('UPDATE betting_rules SET monitor_enabled = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
          .run(boolToInt(enabled), currentIso(), ruleId, expectedVersion)
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
      })
    },

    setAutoBetRuleRealEnabled(ruleId, enabled, payload) {
      validateAutoBetRuleCasPayload(payload)
      const expectedVersion = normalizeExpectedVersion(payload)
      if (typeof enabled !== 'boolean') throw new ValidationError('validation-error', { realBettingEnabled: 'realBettingEnabled must be a boolean' })
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'auto-bet-rule')
        assertAutoBetRuleVersion(row, expectedVersion)
        const item = mapAutoBetRule(row)
        if (enabled) assertAutoBetRuleCanEnable(item, { real: true })
        db.prepare('UPDATE betting_rules SET real_betting_enabled = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
          .run(boolToInt(enabled), currentIso(), ruleId, expectedVersion)
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
      })
    },

    archiveAutoBetRule(ruleId, payload) {
      validateAutoBetRuleCasPayload(payload)
      const expectedVersion = normalizeExpectedVersion(payload)
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'auto-bet-rule')
        assertAutoBetRuleVersion(row, expectedVersion)
        if (intToBool(row.archived)) return mapAutoBetRule(row)
        db.prepare(`
          UPDATE betting_rules SET archived = 1, monitor_enabled = 0, real_betting_enabled = 0,
            enabled = 0, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(currentIso(), ruleId, expectedVersion)
        return mapAutoBetRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
      })
    },

    listBettingRules() {
      return db.prepare('SELECT * FROM betting_rules ORDER BY updated_at DESC, name ASC').all().map(mapBettingRule)
    },

    createBettingRule(payload) {
      const normalized = normalizeBettingRule(payload)
      if (normalized.executionMode === 'real_eligible') throw new ValidationError('real-eligible-upgrade-forbidden')
      const item = validateRule({ ...normalized, executionMode: 'preview_only' })
      const time = nowIso()
      const ruleId = id('brule')
      try {
        return runImmediate(db, () => {
          if (item.enabled) assertNoBettingRuleConflict(db, item.leagueNames)
          db.prepare(`
            INSERT INTO betting_rules (
              id, name, enabled, execution_mode, currency, amount_scale, target_amount_minor,
              league_names_json, changed_odds_min, changed_odds_max, version, notes, created_at, updated_at
            ) VALUES (?, ?, ?, 'preview_only', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `).run(ruleId, item.name, boolToInt(item.enabled), item.currency, item.amountScale, item.targetAmountMinor,
            JSON.stringify(item.leagueNames), item.changedOddsMin, item.changedOddsMax, item.notes, time, time)
          if (item.enabled) {
            for (const leagueName of item.leagueNames) {
              db.prepare('INSERT INTO betting_rule_leagues (rule_id, league_name, created_at) VALUES (?, ?, ?)').run(ruleId, leagueName, time)
            }
          }
          return mapBettingRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
        })
      } catch (error) {
        if (error?.code === 'betting-rule-conflict') throw error
        if (isLeagueUniqueError(error)) throw bettingRuleConflictError(db, item.leagueNames)
        throw error
      }
    },

    updateBettingRule(ruleId, payload) {
      const item = normalizeBettingRule(payload, { partial: true })
      if (item.executionMode === 'real_eligible') throw new ValidationError('real-eligible-upgrade-forbidden')
      let attemptedLeagues = []
      try {
        return runImmediate(db, () => {
          const row = requiredRow(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId), 'betting-rule')
          const existing = mapBettingRule(row)
          const candidate = { ...existing, ...item }
          let next = validateRule(candidate)
          const executionChanged = executionRuleChanged(existing, next)
          if (executionChanged && existing.executionMode === 'real_eligible') {
            next = validateRule({ ...next, executionMode: 'preview_only' })
          }
          const version = existing.version + (executionChanged ? 1 : 0)
          attemptedLeagues = next.leagueNames
          const time = nowIso()
          if (next.enabled) assertNoBettingRuleConflict(db, next.leagueNames, ruleId)
          db.prepare(`
            UPDATE betting_rules SET
              name = ?, enabled = ?, execution_mode = ?, currency = ?, amount_scale = ?, target_amount_minor = ?,
              league_names_json = ?, changed_odds_min = ?, changed_odds_max = ?, version = ?, notes = ?, updated_at = ?
            WHERE id = ?
          `).run(next.name, boolToInt(next.enabled), next.executionMode, next.currency, next.amountScale, next.targetAmountMinor,
            JSON.stringify(next.leagueNames), next.changedOddsMin, next.changedOddsMax, version, next.notes, time, ruleId)

          db.prepare('DELETE FROM betting_rule_leagues WHERE rule_id = ?').run(ruleId)
          if (next.enabled) {
            for (const leagueName of next.leagueNames) {
              db.prepare('INSERT INTO betting_rule_leagues (rule_id, league_name, created_at) VALUES (?, ?, ?)').run(ruleId, leagueName, time)
            }
          }
          return mapBettingRule(db.prepare('SELECT * FROM betting_rules WHERE id = ?').get(ruleId))
        })
      } catch (error) {
        if (error?.code === 'betting-rule-conflict') throw error
        if (isLeagueUniqueError(error)) throw bettingRuleConflictError(db, attemptedLeagues, ruleId)
        throw error
      }
    },

    deleteBettingRule(ruleId) {
      db.prepare('DELETE FROM betting_rules WHERE id = ?').run(ruleId)
      return { ok: true }
    },

    listBettingAccounts() {
      this.recoverStaleBettingAccountChecks()
      const accounts = db.prepare(`
        SELECT betting_accounts.*, betting_account_locks.status AS lock_status
        FROM betting_accounts
        LEFT JOIN betting_account_locks ON betting_account_locks.account_id = betting_accounts.id
        ORDER BY
          CASE WHEN bet_order > 0 THEN 0 ELSE 1 END,
          bet_order ASC,
          created_at ASC,
          label ASC
      `).all().map(mapBettingAccount)
      return withAcceptedTodayStats(db, accounts, typeof now === 'function' ? now() : now)
    },

    listBetBatches({ limit = 50 } = {}) {
      return db.prepare(`
        SELECT * FROM bet_batches
        ORDER BY created_at DESC, batch_id ASC
        LIMIT ?
      `).all(boundedLimit(limit)).map(mapBetBatch)
    },

    listBetTargetHistory({ limit = 20, cursor = '', status = 'all', mode = 'all' } = {}) {
      if (!BET_TARGET_HISTORY_STATUSES.has(status)) {
        throw new ValidationError('validation-error', { status: 'unsupported status' })
      }
      if (!BET_TARGET_HISTORY_MODES.has(mode)) {
        throw new ValidationError('validation-error', { mode: 'unsupported mode' })
      }
      const pageLimit = boundedLimit(limit, { fallback: 20, max: 50 })
      const decodedCursor = parseHistoryCursor(cursor)
      const where = [`(
        batch.authorization_id IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM bet_child_orders AS acceptance_child
          INNER JOIN crown_browser_acceptance_cases AS acceptance
            ON acceptance.child_order_id = acceptance_child.child_order_id
          WHERE acceptance_child.batch_id = batch.batch_id
            AND acceptance.dispatch_count = 1
        )
      )`]
      const params = []
      if (status === 'active') where.push("batch.status IN ('queued','allocating','waiting_capacity','submitting')")
      else if (status === 'failed') where.push("batch.status IN ('failed','cancelled')")
      else if (status !== 'all') {
        where.push('batch.status = ?')
        params.push(status)
      }
      if (mode !== 'all') {
        where.push(`COALESCE(
          batch.betting_mode,
          CASE WHEN json_valid(batch.locked_selection_identity) THEN json_extract(batch.locked_selection_identity,'$.snapshot.mode') END,
          CASE WHEN json_valid(batch.rule_snapshot_json) THEN json_extract(batch.rule_snapshot_json,'$.lockedSelection.snapshot.mode') END,
          CASE WHEN json_valid(signal.payload_json) THEN json_extract(signal.payload_json,'$.evidence.mode') END
        ) = ?`)
        params.push(mode)
      }
      if (decodedCursor) {
        where.push('(batch.created_at < ? OR (batch.created_at = ? AND batch.batch_id < ?))')
        params.push(decodedCursor.createdAt, decodedCursor.createdAt, decodedCursor.batchId)
      }
      const rows = db.prepare(`
        SELECT batch.*, signal.payload_json AS signal_payload_json
        FROM bet_batches AS batch
        LEFT JOIN monitor_signals AS signal ON signal.signal_id = batch.signal_id
        WHERE ${where.join(' AND ')}
        ORDER BY batch.created_at DESC, batch.batch_id DESC
        LIMIT ?
      `).all(...params, pageLimit + 1)
      const pageRows = rows.slice(0, pageLimit)
      const childrenByBatch = new Map(pageRows.map((row) => [row.batch_id, []]))
      if (pageRows.length > 0) {
        const placeholders = pageRows.map(() => '?').join(',')
        const children = db.prepare(`
          SELECT batch_id, requested_amount_minor, preview_odds
          FROM bet_child_orders
          WHERE status = 'accepted' AND batch_id IN (${placeholders})
          ORDER BY batch_id, child_order_id
        `).all(...pageRows.map((row) => row.batch_id))
        for (const child of children) childrenByBatch.get(child.batch_id)?.push(child)
      }
      return {
        items: pageRows.map((row) => mapBetTargetHistory(row, childrenByBatch.get(row.batch_id) || [])),
        nextCursor: rows.length > pageLimit ? historyCursor(pageRows.at(-1)) : null,
      }
    },

    getOperationsSummary(monitorProcessStatus = null, browserProcessStatus = null) {
      const serverTime = currentIso()
      const nowMs = Date.parse(serverTime)
      const staleAfterMs = 60_000
      const freshnessRow = db.prepare(`
        SELECT MAX(last_odds_parsed_at) AS last_odds_at
        FROM monitor_accounts
        WHERE enabled = 1 AND last_odds_parsed_at <> ''
      `).get()
      const lastOddsAt = freshnessRow?.last_odds_at || null
      const parsedOddsAt = Date.parse(String(lastOddsAt || ''))
      const ageMs = Number.isFinite(parsedOddsAt) ? Math.max(0, nowMs - parsedOddsAt) : null

      const watcherStatus = inspectWatcherLease(db, {
        dbPath, runtimeDir, cwd, now: new Date(serverTime), freshnessMs: staleAfterMs,
      })
      const watcherLease = watcherStatus.row
      const runtime = db.prepare(`
        SELECT requested, runtime_state, reason_code, updated_at
        FROM real_betting_runtime WHERE singleton_id = 1
      `).get() || {}
      const monitorAccount = db.prepare(`
        SELECT enabled, secret_ciphertext
        FROM monitor_accounts ORDER BY updated_at DESC LIMIT 1
      `).get() || {}
      const alertRows = db.prepare(`
        SELECT mode, enabled, asian_handicap_enabled, total_enabled, migration_review_required
        FROM monitor_alert_settings
        WHERE mode IN ('prematch', 'live')
      `).all()
      const alertByMode = Object.fromEntries(alertRows.map((row) => [row.mode, row]))
      const monitorAlerts = Object.fromEntries(['prematch', 'live'].map((mode) => {
        const row = alertByMode[mode] || {}
        return [mode, {
          enabled: Number(row.enabled || 0) === 1,
          reviewRequired: Number(row.migration_review_required ?? 1) === 1,
          markets: {
            asianHandicap: Number(row.asian_handicap_enabled || 0) === 1,
            total: Number(row.total_enabled || 0) === 1,
          },
        }]
      }))
      const validAlertModes = ['prematch', 'live'].filter((mode) => {
        const setting = monitorAlerts[mode]
        return setting.enabled && !setting.reviewRequired
          && (setting.markets.asianHandicap || setting.markets.total)
      })
      const ruleCardRows = db.prepare(`SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END),0) AS enabled,
        COALESCE(SUM(CASE WHEN migration_review_required=1 THEN 1 ELSE 0 END),0) AS review_required,
        (SELECT COUNT(*) FROM auto_betting_rule_card_leagues) AS owned_leagues
        FROM auto_betting_rule_cards`).get()
      const ruleCards = {
        total: safeCount(ruleCardRows.total), enabled: safeCount(ruleCardRows.enabled),
        reviewRequired: safeCount(ruleCardRows.review_required), ownedLeagues: safeCount(ruleCardRows.owned_leagues),
      }
      const enabledCardRows = db.prepare(`SELECT
        card_id,name,enabled,target_odds_min,target_odds_max,
        CASE WHEN typeof(target_amount_minor)='integer' AND target_amount_minor BETWEEN 1 AND 9007199254740991
          THEN target_amount_minor ELSE NULL END AS target_amount_minor,
        currency,
        CASE WHEN amount_scale=0 THEN amount_scale ELSE NULL END AS amount_scale,
        remark,
        CASE WHEN real_eligible IN (0,1) THEN real_eligible ELSE NULL END AS real_eligible,
        CASE WHEN typeof(real_eligibility_version)='integer' AND real_eligibility_version BETWEEN 1 AND 9007199254740991
          THEN real_eligibility_version ELSE NULL END AS real_eligibility_version,
        real_eligibility_updated_at,
        CASE WHEN migration_review_required IN (0,1) THEN migration_review_required ELSE NULL END AS migration_review_required,
        migration_review_reason,
        CASE WHEN typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991 THEN version ELSE NULL END AS version,
        created_at,updated_at
        FROM auto_betting_rule_cards WHERE enabled=1 ORDER BY card_id`).all()
      const enabledCardsValid = enabledCardRows.length > 0 && enabledCardRows.every((row) => {
        const leagueNames = db.prepare(`SELECT league_name FROM auto_betting_rule_card_leagues
          WHERE card_id=? ORDER BY league_name`).all(row.card_id).map((item) => item.league_name)
        return completeRuleCardSnapshot(row, leagueNames) !== null
      })
      const rules = db.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN monitor_enabled = 1 THEN 1 ELSE 0 END), 0) AS monitor_enabled,
          COALESCE(SUM(CASE WHEN real_betting_enabled = 1 THEN 1 ELSE 0 END), 0) AS real_enabled,
          (SELECT COUNT(*) FROM monitor_signals) AS hit_count,
          (SELECT COUNT(*) FROM monitor_signals WHERE observed_at >= ?) AS recent_hit_count
        FROM betting_rules WHERE archived = 0
      `).get(new Date(nowMs - 86_400_000).toISOString())
      const accounts = db.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN allocation_status = 'enabled' THEN 1 ELSE 0 END), 0) AS enabled,
          COALESCE(SUM(CASE WHEN allocation_status = 'pause_pending' THEN 1 ELSE 0 END), 0) AS pause_pending,
          COALESCE(SUM(CASE WHEN allocation_status = 'paused' THEN 1 ELSE 0 END), 0) AS paused,
          COALESCE(SUM(CASE WHEN allocation_status = 'checking' THEN 1 ELSE 0 END), 0) AS checking,
          COALESCE(SUM(CASE WHEN EXISTS (
            SELECT 1 FROM betting_account_locks l WHERE l.account_id = betting_accounts.id
          ) THEN 1 ELSE 0 END), 0) AS locked,
          COALESCE(SUM(CASE WHEN execution_status = 'unknown' OR EXISTS (
            SELECT 1 FROM betting_account_locks l
            WHERE l.account_id = betting_accounts.id AND l.status = 'unknown'
          ) THEN 1 ELSE 0 END), 0) AS unknown_count
        FROM betting_accounts WHERE archived = 0
      `).get()
      const batches = db.prepare(`
        WITH recent AS (
          SELECT status, accepted_amount_minor, unknown_amount_minor
          FROM bet_batches
          ORDER BY created_at DESC, batch_id ASC
          LIMIT 20
        )
        SELECT
          COUNT(*) AS recent_count,
          COALESCE(SUM(CASE WHEN status IN ('queued','allocating','waiting_capacity','submitting','waiting_result') THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
          COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0) AS partial,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
          COALESCE(SUM(accepted_amount_minor), 0) AS accepted_amount_minor,
          COALESCE(SUM(unknown_amount_minor), 0) AS unknown_amount_minor
        FROM recent
      `).get()
      const unresolved = db.prepare(`
        SELECT COALESCE(SUM(unknown_amount_minor), 0) AS unknown_amount_minor
        FROM bet_batches
        WHERE unknown_amount_minor > 0
      `).get()
      const reconciliation = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status IN ('pending','waiting') AND (next_poll_at = '' OR next_poll_at <= ?) THEN 1 ELSE 0 END), 0) AS due,
          COALESCE(SUM(CASE WHEN status = 'manual_review' THEN 1 ELSE 0 END), 0) AS manual_review,
          COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) AS dead_letter,
          COALESCE(SUM(CASE WHEN status <> 'resolved' THEN 1 ELSE 0 END), 0) AS open_count
        FROM bet_reconciliation_state
      `).get(serverTime)
      const notifications = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN status <> 'delivered' THEN 1 ELSE 0 END), 0) AS backlog,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status = 'delivering' THEN 1 ELSE 0 END), 0) AS delivering,
          COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) AS dead_letter
        FROM bet_notification_outbox
      `).get()
      const recentBatches = db.prepare(`
        SELECT batch_id, status, accepted_amount_minor, unknown_amount_minor, created_at
        FROM bet_batches
        ORDER BY created_at DESC, batch_id ASC
        LIMIT 8
      `).all().map((row) => ({
        batchId: row.batch_id,
        status: row.status,
        acceptedAmountMinor: Number(row.accepted_amount_minor || 0),
        unknownAmountMinor: Number(row.unknown_amount_minor || 0),
        createdAt: row.created_at,
      }))

      const generation = Number.isSafeInteger(browserProcessStatus?.generation)
        && browserProcessStatus.generation >= 0
        ? browserProcessStatus.generation
        : 0
      const safeTimestamp = (value) => {
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
        return new Date(value).toISOString() === value ? value : null
      }
      const processAccounts = new Map((Array.isArray(browserProcessStatus?.accounts)
        ? browserProcessStatus.accounts
        : []).map((item) => [String(item?.accountId || ''), item]))
      const safeSessionStates = new Set(['starting', 'login_required', 'ready', 'stale', 'blocked', 'error'])
      const browserSessions = db.prepare(`SELECT id FROM betting_accounts WHERE archived = 0 ORDER BY
        CASE WHEN bet_order > 0 THEN 0 ELSE 1 END, bet_order, created_at, id`).all().map((row) => {
        const processAccount = processAccounts.get(row.id)
        const lastHeartbeatAt = safeTimestamp(processAccount?.lastHeartbeatAt)
        const state = safeSessionStates.has(processAccount?.state) ? processAccount.state : 'stopped'
        return {
          accountId: row.id,
          state,
          lastHeartbeatAt,
          sessionGeneration: generation,
          lastApiSuccessAt: safeTimestamp(processAccount?.lastApiSuccessAt),
        }
      })
      const campaignRow = db.prepare(`SELECT campaign_id,status FROM crown_browser_acceptance_campaigns
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, campaign_id DESC LIMIT 1`).get()
      const latestCampaignCases = campaignRow ? db.prepare(`SELECT current.direction_id,current.state,
          current.mode,current.period,current.market_type,current.line_variant,current.selection_side,
          current.authorized_min_minor,current.frozen_preview_json
        FROM crown_browser_acceptance_cases AS current
        WHERE current.campaign_id=? AND current.case_version=(
          SELECT MAX(versioned.case_version) FROM crown_browser_acceptance_cases AS versioned
          WHERE versioned.campaign_id=current.campaign_id AND versioned.direction_id=current.direction_id
        ) ORDER BY current.ordinal`).all(campaignRow.campaign_id) : []
      const acceptanceByDirection = new Map(latestCampaignCases.map((row) => [
        [row.mode, row.period, row.market_type, row.line_variant, row.selection_side].join('|'),
        row.state === 'pending' && row.frozen_preview_json !== '{}' ? 'previewing'
          : row.state === 'cancelled' ? 'rejected' : row.state]))
      const campaignCounts = campaignRow ? db.prepare(`SELECT
          COUNT(DISTINCT CASE WHEN state='accepted' THEN direction_id END) AS accepted_count,
          COUNT(DISTINCT CASE WHEN state='unknown' THEN direction_id END) AS unknown_count,
          COALESCE(SUM(CASE WHEN state='accepted' THEN authorized_min_minor ELSE 0 END),0) AS accepted_minor
        FROM crown_browser_acceptance_cases WHERE campaign_id=?`).get(campaignRow.campaign_id) : null
      const directions = listCrownCapabilities().map((row) => ({
        key: row.key,
        previewAllowed: row.previewAllowed === true,
        submitAllowed: row.submitAllowed === true,
        reconciliationAllowed: row.reconciliationAllowed === true,
        blockedReason: !row.previewAllowed ? row.blockedReason : '',
        acceptanceState: acceptanceByDirection.get(row.key) || null,
      }))
      const campaign = campaignRow ? {
        campaignId: campaignRow.campaign_id,
        state: campaignRow.status === 'active' ? 'active'
          : campaignRow.status === 'completed' ? 'completed' : 'failed',
        acceptedCount: Number(campaignCounts.accepted_count || 0),
        targetCount: directions.length,
        unknownCount: Number(campaignCounts.unknown_count || 0),
        totalAcceptedAmountMinor: Number(campaignCounts.accepted_minor || 0),
        queueDepth: latestCampaignCases.filter((row) => row.state === 'pending').length,
        inFlightCount: latestCampaignCases.filter((row) => row.state === 'dispatched').length,
      } : null
      const browserBetting = browserBettingDto({
        protocolLibraryVersion: CROWN_CAPABILITY_MATRIX_VERSION,
        sessions: browserSessions,
        directions,
        campaign,
      })

      const freshnessState = ageMs === null ? 'missing' : (ageMs <= staleAfterMs ? 'fresh' : 'stale')
      const runtimeDto = realBettingStatusCoreDto({
        requested: Number(runtime.requested || 0) === 1,
        state: runtime.runtime_state || 'off',
        reasonCode: runtime.reason_code || '',
        updatedAt: runtime.updated_at || '',
      })
      const monitorConfigured = Number(monitorAccount.enabled || 0) === 1 && String(monitorAccount.secret_ciphertext || '').trim() !== ''
      const monitorReadiness = !monitorConfigured
        ? { state: 'blocked', ready: false, reason: 'monitor-account-not-configured' }
        : !watcherStatus.fresh
          ? { state: 'action-required', ready: false, reason: 'watcher-stopped' }
          : freshnessState !== 'fresh'
            ? { state: 'action-required', ready: false, reason: freshnessState === 'stale' ? 'odds-stale' : 'odds-missing' }
            : validAlertModes.length < 1
              ? { state: 'action-required', ready: false, reason: 'monitor-alerts-disabled' }
              : { state: 'ready', ready: true, reason: '' }
      const rulesReadiness = enabledCardsValid
        ? { state: 'ready', ready: true, reason: '' }
        : enabledCardRows.length > 0
          ? { state: 'action-required', ready: false, reason: 'rule-cards-not-ready' }
        : ruleCards.reviewRequired > 0
          ? { state: 'action-required', ready: false, reason: 'settings-review-required' }
          : { state: 'action-required', ready: false, reason: 'auto-betting-disabled' }
      const accountsReadiness = Number(accounts.enabled || 0) > 0
        ? { state: 'ready', ready: true, reason: '' }
        : { state: 'action-required', ready: false, reason: 'betting-accounts-paused' }
      const realBettingReadiness = runtimeDto.state === 'running'
        ? { state: 'ready', ready: true, reason: '' }
        : runtimeDto.state === 'blocked'
          ? { state: 'blocked', ready: false, reason: runtimeDto.reasonCode || 'real-betting-blocked' }
          : runtimeDto.state === 'off'
            ? { state: 'off', ready: false, reason: 'global-real-betting-off' }
            : { state: 'action-required', ready: false, reason: runtimeDto.reasonCode || 'safety-preflight-pending' }

      return {
        serverTime,
        freshness: {
          lastOddsAt,
          ageMs,
          state: freshnessState,
          staleAfterMs,
        },
        watcher: {
          active: watcherStatus.fresh,
          unique: watcherStatus.exists,
          activeCount: watcherStatus.fresh ? 1 : 0,
          heartbeatAt: watcherLease?.heartbeat_at || null,
          expiresAt: watcherLease?.expires_at || null,
          fencingToken: Number(watcherLease?.fencing_token || 0),
          ...(watcherProcessDto(monitorProcessStatus) ? { process: watcherProcessDto(monitorProcessStatus) } : {}),
        },
        runtime: runtimeDto,
        browserBetting,
        monitorAlerts,
        ruleCards,
        readiness: {
          monitor: monitorReadiness,
          rules: rulesReadiness,
          accounts: accountsReadiness,
          realBetting: realBettingReadiness,
        },
        rules: {
          total: Number(rules.total || 0), monitorEnabled: Number(rules.monitor_enabled || 0),
          realEnabled: Number(rules.real_enabled || 0), hitCount: Number(rules.hit_count || 0),
          recentHitCount: Number(rules.recent_hit_count || 0),
        },
        accounts: {
          total: Number(accounts.total || 0), enabled: Number(accounts.enabled || 0),
          pausePending: Number(accounts.pause_pending || 0), paused: Number(accounts.paused || 0),
          checking: Number(accounts.checking || 0), locked: Number(accounts.locked || 0),
          unknown: Number(accounts.unknown_count || 0),
        },
        batches: {
          recentLimit: 20, recentCount: Number(batches.recent_count || 0), active: Number(batches.active || 0),
          completed: Number(batches.completed || 0), partial: Number(batches.partial || 0),
          failed: Number(batches.failed || 0), cancelled: Number(batches.cancelled || 0),
          acceptedAmountMinor: Number(batches.accepted_amount_minor || 0),
          unknownAmountMinor: Number(unresolved.unknown_amount_minor || 0),
        },
        reconciliation: {
          due: Number(reconciliation.due || 0), manualReview: Number(reconciliation.manual_review || 0),
          deadLetter: Number(reconciliation.dead_letter || 0), open: Number(reconciliation.open_count || 0),
        },
        notifications: {
          backlog: Number(notifications.backlog || 0), pending: Number(notifications.pending || 0),
          delivering: Number(notifications.delivering || 0), deadLetter: Number(notifications.dead_letter || 0),
        },
        recentBatches,
      }
    },

    listBetBatchChildren(batchId, { limit = 100 } = {}) {
      requiredRow(db.prepare('SELECT batch_id FROM bet_batches WHERE batch_id = ?').get(batchId), 'bet-batch')
      return db.prepare(`
        SELECT bet_child_orders.*, bet_batches.currency, bet_batches.amount_scale
        FROM bet_child_orders
        INNER JOIN bet_batches ON bet_batches.batch_id = bet_child_orders.batch_id
        WHERE bet_child_orders.batch_id = ?
        ORDER BY bet_child_orders.created_at ASC, bet_child_orders.child_order_id ASC
        LIMIT ?
      `).all(batchId, boundedLimit(limit, { fallback: 100, max: 200 })).map(mapBetChildOrder)
    },

    listEnabledBettingAccountsForExecution() {
      return db.prepare(`
        SELECT betting_accounts.*, betting_account_locks.status AS lock_status
        FROM betting_accounts
        LEFT JOIN betting_account_locks ON betting_account_locks.account_id = betting_accounts.id
        WHERE betting_accounts.status = 'enabled'
          AND betting_accounts.archived = 0
          AND betting_accounts.allocation_status = 'enabled'
          AND betting_accounts.bet_order > 0
          AND betting_accounts.secret_ciphertext <> ''
          AND betting_account_locks.account_id IS NULL
        ORDER BY betting_accounts.bet_order ASC, betting_accounts.created_at ASC, betting_accounts.label ASC
      `).all().map((row) => mapBettingAccountForExecution(row, secretOptions))
    },

    getBettingAccountForExecution(value) {
      const accountId = bettingExecutionAccountId(value)
      const row = requiredRow(db.prepare(`
        SELECT betting_accounts.*, betting_account_locks.status AS lock_status
        FROM betting_accounts
        LEFT JOIN betting_account_locks ON betting_account_locks.account_id = betting_accounts.id
        WHERE betting_accounts.id = ?
        LIMIT 1
      `).get(accountId), 'betting-account')
      assertBettingAccountExecutionContract(row)
      const account = mapBettingAccountForExecution(row, secretOptions)
      if (!String(account.password || '')) throw new Error('betting-account-secret')
      return account
    },

    getCurrentCrownSelectionForExecution(lockedSelection) {
      if (!lockedSelection || typeof lockedSelection !== 'object' || Array.isArray(lockedSelection)) {
        throw new TypeError('crown-current-selection-required')
      }
      const eventKey = String(lockedSelection.eventKey || '').trim()
      const selectionIdentity = String(lockedSelection.selectionIdentity || '').trim()
      if (!/^crown\|football\|gid=[^|\s]+$/.test(eventKey)
        || !selectionIdentity.startsWith(`${eventKey}|`)) {
        throw new Error('crown-current-selection-identity')
      }
      const row = db.prepare(`
        SELECT captured_at,snapshot_json
        FROM monitor_selection_state
        WHERE event_key=? AND selection_identity=?
        LIMIT 1
      `).get(eventKey, selectionIdentity)
      const latest = db.prepare(`
        SELECT MAX(captured_at) AS captured_at
        FROM monitor_selection_state
        WHERE event_key=?
      `).get(eventKey)
      if (!row) throw new Error('crown-current-selection-missing')
      if (!latest?.captured_at || row.captured_at !== latest.captured_at) {
        throw new Error('crown-current-selection-stale')
      }
      let snapshot
      try { snapshot = JSON.parse(row.snapshot_json) } catch { throw new Error('crown-current-selection-invalid') }
      if (snapshot?.provider !== 'crown'
        || snapshot?.event?.eventKey !== eventKey
        || snapshot?.selection?.selectionIdentity !== selectionIdentity
        || snapshot?.selection?.suspended !== false) {
        throw new Error('crown-current-selection-invalid')
      }
      return {
        provider: 'crown',
        eventKey,
        period: String(snapshot.market?.period || ''),
        marketType: String(snapshot.market?.marketType || ''),
        lineKey: String(snapshot.market?.lineKey || ''),
        side: String(snapshot.selection?.side || ''),
        selectionIdentity,
        snapshot,
      }
    },

    getBettingAccountForAccessCheck(value) {
      const accountId = bettingExecutionAccountId(value)
      const row = requiredRow(db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId), 'betting-account')
      if (Number(row.archived) !== 0) throw new Error('betting-account-archived')
      if (String(row.execution_status || 'idle') !== 'idle'
        || db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ? LIMIT 1').get(accountId)) {
        throw new Error('betting-account-busy')
      }
      if (!String(row.username || '').trim()) throw new Error('betting-account-username')
      if (!String(row.secret_ciphertext || '').trim()) throw new Error('betting-account-secret')
      const account = mapBettingAccountForExecution(row, secretOptions)
      if (!String(account.password || '')) throw new Error('betting-account-secret')
      return account
    },

    recordBettingAccountAccessCheck(value, result = {}) {
      const accountId = bettingExecutionAccountId(value)
      const row = requiredRow(db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId), 'betting-account')
      if (String(row.execution_status || 'idle') !== 'idle'
        || db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ? LIMIT 1').get(accountId)) {
        throw new Error('betting-account-busy')
      }
      const status = result.ok && result.status === 'available' ? 'available' : 'failed'
      const errorCode = status === 'available' ? '' : String(result.errorCode || 'access-failed').trim()
      if (errorCode && !/^[a-z0-9-]{1,80}$/.test(errorCode)) throw new TypeError('betting-account-access-error-code')
      const reportedBalance = result.reportedBalance === null || result.reportedBalance === undefined
        ? null
        : String(result.reportedBalance).trim()
      if (reportedBalance !== null && !/^\d+(?:\.\d+)?$/.test(reportedBalance)) {
        throw new TypeError('betting-account-reported-balance')
      }
      const reportedCurrency = reportedBalance === null ? '' : String(result.reportedCurrency || '').trim().toUpperCase()
      if (reportedBalance !== null && !/^[A-Z]{3}$/.test(reportedCurrency)) {
        throw new TypeError('betting-account-reported-currency')
      }
      const time = currentIso()
      db.prepare(`
        UPDATE betting_accounts SET
          access_status = ?, access_checked_at = ?, access_error_code = ?,
          reported_balance = CASE WHEN ? = 'available' THEN ? ELSE reported_balance END,
          reported_currency = CASE WHEN ? = 'available' THEN ? ELSE reported_currency END,
          reported_balance_updated_at = CASE WHEN ? = 'available' AND ? IS NOT NULL THEN ? ELSE reported_balance_updated_at END,
          updated_at = ?
        WHERE id = ?
      `).run(
        status, time, errorCode,
        status, reportedBalance,
        status, reportedCurrency,
        status, reportedBalance, time,
        time, accountId,
      )
      const updated = mapBettingAccount(db.prepare('SELECT * FROM betting_accounts WHERE id = ?').get(accountId))
      return withAcceptedTodayStats(db, [updated], typeof now === 'function' ? now() : now)[0]
    },

    pauseBettingAccount(value) {
      const accountId = bettingExecutionAccountId(value)
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId), 'betting-account')
        if (Number(row.archived) !== 0) throw new Error('betting-account-archived')
        const active = db.prepare(`
          SELECT 1 FROM bet_child_orders
          WHERE account_id = ?
            AND status IN ('reserved', 'previewing', 'submit_prepared', 'submit_dispatched')
          LIMIT 1
        `).get(accountId)
        const allocationStatus = active ? 'pause_pending' : 'paused'
        db.prepare(`
          UPDATE betting_accounts
          SET allocation_status = ?, updated_at = ?
          WHERE id = ?
        `).run(allocationStatus, currentIso(), accountId)
        const updated = mapBettingAccount(db.prepare(`
          SELECT betting_accounts.*, betting_account_locks.status AS lock_status
          FROM betting_accounts
          LEFT JOIN betting_account_locks ON betting_account_locks.account_id = betting_accounts.id
          WHERE betting_accounts.id = ?
        `).get(accountId))
        return withAcceptedTodayStats(db, [updated], typeof now === 'function' ? now() : now)[0]
      })
    },

    finalizePendingBettingAccountPauses() {
      return runImmediate(db, () => db.prepare(`
        UPDATE betting_accounts
        SET allocation_status = 'paused', updated_at = ?
        WHERE allocation_status = 'pause_pending'
          AND NOT EXISTS (
            SELECT 1 FROM bet_child_orders
            WHERE bet_child_orders.account_id = betting_accounts.id
              AND bet_child_orders.status IN ('reserved', 'previewing', 'submit_prepared', 'submit_dispatched')
          )
      `).run(currentIso()).changes)
    },

    recoverStaleBettingAccountChecks({ timeoutMs = BETTING_ACCOUNT_CHECK_TIMEOUT_MS } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('betting-account-check-timeout')
      const nowValue = new Date(currentIso())
      const cutoff = new Date(nowValue.getTime() - timeoutMs).toISOString()
      return runImmediate(db, () => db.prepare(`
        UPDATE betting_accounts
        SET allocation_status = 'paused', access_status = 'failed',
          access_error_code = 'check-interrupted', updated_at = ?
        WHERE allocation_status = 'checking' AND updated_at <= ?
      `).run(nowValue.toISOString(), cutoff).changes)
    },

    beginEnableBettingAccount(value) {
      const accountId = bettingExecutionAccountId(value)
      this.recoverStaleBettingAccountChecks()
      return runImmediate(db, () => {
        const row = requiredRow(db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId), 'betting-account')
        if (Number(row.archived) !== 0) throw new Error('betting-account-archived')
        if (!['enabled', 'disabled'].includes(row.status)) throw new Error('betting-account-disabled')
        if (!['paused', 'pause_pending'].includes(row.allocation_status)) throw new Error('betting-account-enable-busy')
        if (db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ? LIMIT 1').get(accountId)) {
          throw new Error('betting-account-busy')
        }
        const active = db.prepare(`
          SELECT 1 FROM bet_child_orders
          WHERE account_id = ?
            AND status IN ('reserved', 'previewing', 'submit_prepared', 'submit_dispatched')
          LIMIT 1
        `).get(accountId)
        if (active) throw new Error('betting-account-queue-not-drained')
        if (!String(row.username || '').trim()) throw new Error('betting-account-username')
        if (!String(row.secret_ciphertext || '').trim()) throw new Error('betting-account-secret')
        if (!Number.isSafeInteger(row.per_bet_limit_minor) || row.per_bet_limit_minor < 1) throw new Error('betting-account-per-bet-limit')
        const changed = db.prepare(`
          UPDATE betting_accounts
          SET allocation_status = 'checking', access_status = 'unchecked', access_error_code = '', updated_at = ?
          WHERE id = ? AND allocation_status IN ('paused', 'pause_pending')
        `).run(currentIso(), accountId)
        if (changed.changes !== 1) throw new Error('betting-account-enable-busy')
        const account = mapBettingAccountForExecution(row, secretOptions)
        if (!String(account.password || '')) throw new Error('betting-account-secret')
        const checkingRow = db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId)
        return {
          account,
          expected: {
            accountId,
            revision: bettingAccountEnableRevision(checkingRow),
            checkExpiresAt: new Date(new Date(checkingRow.updated_at).getTime() + BETTING_ACCOUNT_CHECK_TIMEOUT_MS).toISOString(),
          },
        }
      })
    },

    completeEnableBettingAccount(checking, result = {}) {
      const expected = checking?.expected || {}
      const accountId = bettingExecutionAccountId(expected.accountId)
      const completion = runImmediate(db, () => {
        const current = db.prepare('SELECT * FROM betting_accounts WHERE id = ? LIMIT 1').get(accountId)
        if (!current) return { enableStale: true }
        const expired = currentIso() >= String(expected.checkExpiresAt || '')
        const unchanged = current.allocation_status === 'checking'
          && Number(current.archived) === 0
          && !expired
          && bettingAccountEnableRevision(current) === expected.revision
        if (!unchanged) {
          if (current.allocation_status === 'checking') {
            db.prepare(`
              UPDATE betting_accounts SET allocation_status='paused',
                access_status=?, access_error_code=?, updated_at=?
              WHERE id=? AND allocation_status='checking'
            `).run(expired ? 'failed' : 'unchecked', expired ? 'check-interrupted' : '', currentIso(), accountId)
          }
          return { enableStale: true }
        }
        const balanceText = result.reportedBalance === null || result.reportedBalance === undefined
          ? '' : String(result.reportedBalance).trim()
        const balanceCurrency = String(result.reportedCurrency || '').trim().toUpperCase()
        const usableBalance = /^\d+(?:\.\d+)?$/.test(balanceText)
          && Number.isFinite(Number(balanceText)) && Number(balanceText) >= 0
          && balanceCurrency === 'CNY'
        const accessAvailable = result.ok === true && result.status === 'available'
        const available = accessAvailable && usableBalance
        const errorCode = available ? '' : (accessAvailable ? 'balance-unavailable' : String(result.errorCode || 'access-failed').trim())
        if (errorCode && !/^[a-z0-9-]{1,80}$/.test(errorCode)) throw new TypeError('betting-account-access-error-code')
        const reportedBalance = usableBalance ? balanceText : null
        if (reportedBalance !== null && !/^\d+(?:\.\d+)?$/.test(reportedBalance)) throw new TypeError('betting-account-reported-balance')
        const reportedCurrency = reportedBalance === null ? '' : balanceCurrency
        if (reportedBalance !== null && !/^[A-Z]{3}$/.test(reportedCurrency)) throw new TypeError('betting-account-reported-currency')
        const time = currentIso()
        db.prepare(`
          UPDATE betting_accounts SET
            status = CASE WHEN ? = 1 THEN 'enabled' ELSE status END,
            allocation_status = ?, access_status = ?, access_checked_at = ?, access_error_code = ?,
            reported_balance = CASE WHEN ? = 1 THEN ? ELSE reported_balance END,
            reported_currency = CASE WHEN ? = 1 THEN ? ELSE reported_currency END,
            reported_balance_updated_at = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE reported_balance_updated_at END,
            updated_at = ?
          WHERE id = ? AND allocation_status = 'checking' AND archived = 0
        `).run(
          boolToInt(available), available ? 'enabled' : 'paused', available ? 'available' : 'failed', time, errorCode,
          boolToInt(available), reportedBalance, boolToInt(available), reportedCurrency,
          boolToInt(available), reportedBalance, time, time,
          accountId,
        )
        const updated = mapBettingAccount(db.prepare(`
          SELECT betting_accounts.*, betting_account_locks.status AS lock_status
          FROM betting_accounts
          LEFT JOIN betting_account_locks ON betting_account_locks.account_id = betting_accounts.id
          WHERE betting_accounts.id = ?
        `).get(accountId))
        return withAcceptedTodayStats(db, [updated], typeof now === 'function' ? now() : now)[0]
      })
      if (completion?.enableStale) throw new Error('betting-account-enable-stale')
      return completion
    },

    createBettingAccount(payload) {
      const item = validateAccountAmounts(normalizeBettingAccount(payload))
      const time = nowIso()
      const accountId = id('bet')
      const ciphertext = maybeEncrypt(item.secret, secretOptions) || ''
      db.prepare(`
        INSERT INTO betting_accounts (
          id, label, username, website_url, bet_order, status, archived, per_bet_limit_minor, currency, amount_scale,
          stake_step_minor, balance_minor, execution_status, secret_ciphertext, secret_updated_at, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, 'idle', ?, ?, ?, ?, ?)
      `).run(accountId, item.label, item.username, item.websiteUrl, item.betOrder, item.status, item.perBetLimitMinor, item.currency,
        0, 1, ciphertext, ciphertext ? time : '', item.notes, time, time)
      const account = mapBettingAccount(db.prepare('SELECT * FROM betting_accounts WHERE id = ?').get(accountId))
      return withAcceptedTodayStats(db, [account], typeof now === 'function' ? now() : now)[0]
    },

    updateBettingAccount(accountId, payload) {
      const existing = requiredRow(db.prepare('SELECT * FROM betting_accounts WHERE id = ?').get(accountId), 'betting-account')
      const item = normalizeBettingAccount(payload, { partial: true })
      const locked = Boolean(db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ?').get(accountId))
      if (locked && Object.keys(payload).some((field) => !['label', 'notes'].includes(field))) throw new Error('betting-account-locked')
      if (existing.amount_scale !== 0 && item.perBetLimit === undefined) {
        throw new ValidationError('integer-cny-migration-required', {
          perBetLimit: 'legacy account requires an explicit integer CNY perBetLimit',
        })
      }
      const current = mapBettingAccount(existing)
      const amounts = validateAccountAmounts({ ...current, ...item })
      const time = nowIso()
      const encrypted = maybeEncrypt(item.secret, secretOptions)
      const resetsEnablement = (item.username !== undefined && item.username !== existing.username)
        || (item.websiteUrl !== undefined && item.websiteUrl !== existing.website_url)
        || encrypted !== null
        || (item.status !== undefined && item.status !== existing.status)
        || amounts.perBetLimitMinor !== existing.per_bet_limit_minor
      const allocationStatus = resetsEnablement ? 'paused' : existing.allocation_status
      db.prepare(`
        UPDATE betting_accounts SET
          label = ?, username = ?, website_url = ?, bet_order = ?, status = ?, per_bet_limit_minor = ?, currency = ?, amount_scale = ?,
          stake_step_minor = ?, secret_ciphertext = ?, secret_updated_at = ?, notes = ?,
          allocation_status = ?,
          access_status = CASE WHEN ? = 1 THEN 'unchecked' ELSE access_status END,
          access_error_code = CASE WHEN ? = 1 THEN '' ELSE access_error_code END,
          updated_at = ?
        WHERE id = ?
      `).run(
        item.label || existing.label,
        item.username || existing.username,
        item.websiteUrl ?? existing.website_url,
        item.betOrder ?? existing.bet_order,
        item.status || existing.status,
        amounts.perBetLimitMinor,
        amounts.currency,
        0,
        item.perBetLimit === undefined ? existing.stake_step_minor : 1,
        encrypted === null ? existing.secret_ciphertext : encrypted,
        encrypted === null ? existing.secret_updated_at : (encrypted ? time : ''),
        item.notes ?? existing.notes,
        allocationStatus,
        boolToInt(resetsEnablement),
        boolToInt(resetsEnablement),
        time,
        accountId,
      )
      const account = mapBettingAccount(db.prepare('SELECT * FROM betting_accounts WHERE id = ?').get(accountId))
      return withAcceptedTodayStats(db, [account], typeof now === 'function' ? now() : now)[0]
    },

    deleteBettingAccount(accountId) {
      requiredRow(db.prepare('SELECT id FROM betting_accounts WHERE id = ?').get(accountId), 'betting-account')
      const referenced = Boolean(
        db.prepare('SELECT 1 FROM betting_account_locks WHERE account_id = ?').get(accountId)
        || db.prepare('SELECT 1 FROM bet_child_orders WHERE account_id = ? LIMIT 1').get(accountId)
        || db.prepare('SELECT 1 FROM betting_history WHERE betting_account_id = ? LIMIT 1').get(accountId),
      )
      if (referenced) {
        db.prepare("UPDATE betting_accounts SET archived = 1, status = 'disabled', updated_at = ? WHERE id = ?").run(nowIso(), accountId)
        return { ok: true, archived: true }
      }
      db.prepare('DELETE FROM betting_accounts WHERE id = ?').run(accountId)
      return { ok: true }
    },

    listBettingHistory() {
      return db.prepare('SELECT * FROM betting_history ORDER BY created_at DESC, id ASC').all().map(mapBettingHistory)
    },

    createBettingHistory(payload) {
      const item = normalizeBettingHistoryInput(payload)
      const time = nowIso()
      const historyId = id('bhist')
      db.prepare(`
        INSERT INTO betting_history (
          id, betting_account_id, event_key, rule_id, status, amount, odds_raw, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(historyId, item.bettingAccountId, item.eventKey, item.ruleId, item.status, item.amount, item.oddsRaw, JSON.stringify(item.details), item.betTime || time)
      return mapBettingHistory(db.prepare('SELECT * FROM betting_history WHERE id = ?').get(historyId))
    },
  }
}
