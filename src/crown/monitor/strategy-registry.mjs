import crypto from 'node:crypto'
import { normalizeAutoBetRule } from '../betting/auto-bet-rule.mjs'
import { validateOddsDeltaRule } from './odds-delta-strategy.mjs'

function cloneData(value, errorCode) {
  if (value === undefined || value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch (error) {
    throw new TypeError(errorCode, { cause: error })
  }
}

function text(value) {
  return String(value ?? '').trim()
}

function rowToAutoBetRule(row) {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    monitorEnabled: row.monitor_enabled === 1,
    realBettingEnabled: row.real_betting_enabled === 1,
    archived: row.archived === 1,
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
    migrationReviewRequired: row.migration_review_required === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PERIODS = { full: 'full_time', first_half: 'first_half', second_half: 'second_half' }

export function alertSettingToStrategy(setting) {
  const mode = text(setting?.mode)
  if (!['prematch', 'live'].includes(mode)) throw new TypeError('monitor alert setting mode must be prematch or live')
  if (!Number.isSafeInteger(setting?.version) || setting.version <= 0) {
    throw new TypeError('monitor alert setting version must be a positive safe integer')
  }
  const markets = [
    ...(setting.asianHandicapEnabled === true ? ['asian_handicap'] : []),
    ...(setting.totalEnabled === true ? ['total'] : []),
  ]
  const phases = mode === 'live' ? [
    ...(setting.includeFirstHalf === true ? ['first_half'] : []),
    ...(setting.includeHalfTime === true ? ['half_time'] : []),
    ...(setting.includeSecondHalf === true ? ['second_half'] : []),
  ] : []
  const enabled = setting.enabled === true
    && setting.migrationReviewRequired !== true
    && markets.length > 0
    && (mode !== 'live' || phases.length > 0)
  const rule = {
    id: `monitor-alert:${mode}`,
    type: 'odds_delta',
    version: setting.version,
    enabled,
    scope: {
      modes: [mode],
      markets,
      periods: mode === 'live' ? ['full_time', 'first_half', 'second_half'] : ['full_time'],
      leagues: [],
    },
    conditions: {
      minDelta: setting.waterMoveThreshold,
      direction: 'both',
      oddsRange: { min: setting.monitorOddsMin, max: setting.monitorOddsMax },
      kickoffWindow: mode === 'prematch' ? {
        startMinutesBeforeKickoff: setting.startMinutesBeforeKickoff,
        stopMinutesBeforeKickoff: setting.stopMinutesBeforeKickoff,
      } : null,
      liveWindow: mode === 'live' ? {
        phases,
        minuteFrom: setting.liveMinuteFrom,
        minuteTo: setting.liveMinuteTo,
      } : null,
    },
    cooldownSeconds: setting.cooldownSeconds,
  }
  validateOddsDeltaRule(rule)
  return rule
}

export function autoBetRuleToStrategyRule(input) {
  if (!text(input?.id)) throw new TypeError('auto-bet rule id is required')
  if (!Number.isSafeInteger(input?.version) || input.version <= 0) throw new TypeError('auto-bet rule version must be a positive safe integer')
  const createdAt = text(input?.createdAt)
  const createdMilliseconds = Date.parse(createdAt)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(createdMilliseconds)
    || new Date(createdMilliseconds).toISOString() !== createdAt) {
    throw new TypeError('auto-bet rule createdAt must be a canonical ISO timestamp')
  }
  const normalizerInput = { ...input }
  if (normalizerInput.mode === 'prematch') {
    delete normalizerInput.liveMinuteFrom
    delete normalizerInput.liveMinuteTo
  } else if (normalizerInput.mode === 'live') {
    delete normalizerInput.startMinutesBeforeKickoff
    delete normalizerInput.stopMinutesBeforeKickoff
  }
  const normalized = normalizeAutoBetRule(normalizerInput)
  const rule = { ...input, ...normalized }
  const strategyRule = {
    id: text(rule.id),
    type: 'odds_delta',
    version: rule.version,
    enabled: rule.monitorEnabled === true && rule.archived !== true,
    priority: rule.priority,
    createdAt: rule.createdAt,
    monitoredSide: rule.monitoredSide,
    betDirectionMode: 'reverse',
    targetOddsMin: rule.targetOddsMin,
    targetOddsMax: rule.targetOddsMax,
    targetAmountMinor: rule.targetAmountMinor,
    scope: {
      modes: [rule.mode],
      markets: [rule.marketType],
      periods: [PERIODS[rule.period]],
      leagues: [...rule.leagueNames],
    },
    conditions: {
      minDelta: Number(rule.minWaterRise),
      direction: 'up',
      oddsRange: { min: null, max: null },
      kickoffWindow: rule.mode === 'prematch' ? {
        startMinutesBeforeKickoff: rule.startMinutesBeforeKickoff,
        stopMinutesBeforeKickoff: rule.stopMinutesBeforeKickoff,
      } : null,
      liveWindow: rule.mode === 'live' ? {
        phases: ['first_half', 'second_half', 'half_time'],
        minuteFrom: rule.liveMinuteFrom,
        minuteTo: rule.liveMinuteTo,
      } : null,
    },
    cooldownSeconds: 0,
    signalTtlSeconds: 60,
    bettingRuleId: text(rule.id),
  }
  validateOddsDeltaRule(strategyRule)
  return strategyRule
}

export class AutoBetRuleWatcher {
  #database
  #revision = null
  #rules = []

  constructor(database) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required')
    this.#database = database
  }

  reload() {
    try {
      const rows = this.#database.prepare(`
        SELECT * FROM betting_rules
        WHERE monitor_enabled = 1 AND archived = 0
        ORDER BY priority ASC, created_at ASC, id ASC
      `).all()
      const candidateRevision = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
      if (candidateRevision === this.#revision) {
        return { updated: false, reason: 'revision-unchanged', revision: this.#revision, rules: cloneData(this.#rules, 'rule-snapshot-not-cloneable') }
      }
      const rules = rows.map(rowToAutoBetRule)
      for (const rule of rules) autoBetRuleToStrategyRule(rule)
      this.#rules = cloneData(rules, 'rule-snapshot-not-cloneable')
      this.#revision = candidateRevision
      return { updated: true, revision: this.#revision, rules: cloneData(this.#rules, 'rule-snapshot-not-cloneable') }
    } catch (error) {
      return {
        updated: false,
        reason: 'rule-revision-invalid',
        revision: this.#revision,
        rules: cloneData(this.#rules, 'rule-snapshot-not-cloneable'),
        error,
      }
    }
  }
}

export class StrategyRegistry {
  #evaluators = new Map()

  register(type, evaluator) {
    const strategyType = String(type || '').trim()
    if (!strategyType) throw new TypeError('strategy type is required')
    if (typeof evaluator !== 'function') throw new TypeError(`strategy evaluator must be a function:${strategyType}`)
    if (evaluator.constructor?.name === 'AsyncFunction') throw new TypeError(`strategy-evaluator-must-be-synchronous:${strategyType}`)
    if (this.#evaluators.has(strategyType)) throw new Error(`strategy-already-registered:${strategyType}`)
    this.#evaluators.set(strategyType, evaluator)
    return this
  }

  evaluate(change, context = {}) {
    const rules = Array.isArray(context.rules) ? context.rules.map((rule, index) => ({ rule, index })) : []
    rules.sort((a, b) => {
      const priority = (Number.isInteger(a.rule?.priority) ? a.rule.priority : Number.MAX_SAFE_INTEGER)
        - (Number.isInteger(b.rule?.priority) ? b.rule.priority : Number.MAX_SAFE_INTEGER)
      return priority
        || text(a.rule?.createdAt).localeCompare(text(b.rule?.createdAt))
        || text(a.rule?.id).localeCompare(text(b.rule?.id))
        || a.index - b.index
    })
    const decisions = []
    for (const { rule: inputRule } of rules) {
      if (!inputRule?.enabled) continue
      const evaluator = this.#evaluators.get(inputRule.type)
      if (!evaluator) continue
      const rule = cloneData(inputRule, 'strategy-rule-not-cloneable')
      const evaluationContext = cloneData({ ...context, rules: undefined }, 'strategy-context-not-cloneable')
      evaluationContext.rule = rule
      const decision = evaluator(cloneData(change, 'strategy-change-not-cloneable'), evaluationContext)
      if (decision && typeof decision.then === 'function') {
        throw new TypeError(`strategy-evaluator-returned-thenable:${inputRule.type}`)
      }
      if (decision?.matched) decisions.push(cloneData(decision, 'strategy-decision-not-cloneable'))
    }
    return decisions
  }
}
