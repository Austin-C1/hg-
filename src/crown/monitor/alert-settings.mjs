const COMMON_FIELDS = [
  'expectedVersion', 'acknowledgeMigrationReview', 'enabled', 'asianHandicapEnabled', 'totalEnabled',
  'monitorOddsMin', 'monitorOddsMax', 'waterMoveThreshold', 'cooldownSeconds', 'remark',
]
const BRANCH_FIELDS = {
  prematch: ['startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff'],
  live: ['liveMinuteFrom', 'liveMinuteTo', 'includeFirstHalf', 'includeHalfTime', 'includeSecondHalf'],
}

function invalid(fields) {
  const error = new Error('validation-error')
  error.code = 'validation-error'
  error.fields = fields
  throw error
}

function assertMode(mode) {
  if (!Object.hasOwn(BRANCH_FIELDS, mode)) invalid({ mode: 'mode must be prematch or live' })
}

function assertExactFields(mode, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid({ body: 'body must be an object' })
  const allowed = new Set([...COMMON_FIELDS, ...BRANCH_FIELDS[mode]])
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  const missing = [...allowed].filter((key) => !Object.hasOwn(body, key))
  if (unknown.length || missing.length) {
    invalid(Object.fromEntries([
      ...unknown.map((key) => [key, 'field is not writable']),
      ...missing.map((key) => [key, 'field is required']),
    ]))
  }
}

function boolean(value, field) {
  if (typeof value !== 'boolean') invalid({ [field]: `${field} must be boolean` })
  return value
}

function nullableFinite(value, field) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    invalid({ [field]: `${field} must be null or a finite safe-range number` })
  }
  return value
}

function nonNegativeFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    invalid({ [field]: `${field} must be finite, non-negative, and within the safe range` })
  }
  return value
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid({ [field]: `${field} must be a non-negative safe integer` })
  return value
}

export function normalizeMonitorAlertSetting(mode, body) {
  assertMode(mode)
  assertExactFields(mode, body)
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    invalid({ expectedVersion: 'expectedVersion must be a positive safe integer' })
  }
  const acknowledgeMigrationReview = boolean(body.acknowledgeMigrationReview, 'acknowledgeMigrationReview')
  const item = {
    enabled: boolean(body.enabled, 'enabled'),
    asianHandicapEnabled: boolean(body.asianHandicapEnabled, 'asianHandicapEnabled'),
    totalEnabled: boolean(body.totalEnabled, 'totalEnabled'),
    monitorOddsMin: nullableFinite(body.monitorOddsMin, 'monitorOddsMin'),
    monitorOddsMax: nullableFinite(body.monitorOddsMax, 'monitorOddsMax'),
    waterMoveThreshold: nonNegativeFinite(body.waterMoveThreshold, 'waterMoveThreshold'),
    cooldownSeconds: nonNegativeSafeInteger(body.cooldownSeconds, 'cooldownSeconds'),
    remark: typeof body.remark === 'string' ? body.remark : invalid({ remark: 'remark must be a string' }),
  }
  if (item.monitorOddsMin !== null && item.monitorOddsMax !== null && item.monitorOddsMin > item.monitorOddsMax) {
    invalid({ monitorOddsMax: 'monitorOddsMax must be greater than or equal to monitorOddsMin' })
  }
  if (item.enabled && !item.asianHandicapEnabled && !item.totalEnabled) {
    invalid({ enabled: 'enabled alert settings require at least one market' })
  }
  if (mode === 'prematch') {
    item.startMinutesBeforeKickoff = nonNegativeSafeInteger(body.startMinutesBeforeKickoff, 'startMinutesBeforeKickoff')
    item.stopMinutesBeforeKickoff = nonNegativeSafeInteger(body.stopMinutesBeforeKickoff, 'stopMinutesBeforeKickoff')
    if (item.startMinutesBeforeKickoff < item.stopMinutesBeforeKickoff) {
      invalid({ startMinutesBeforeKickoff: 'startMinutesBeforeKickoff must be greater than or equal to stopMinutesBeforeKickoff' })
    }
  } else {
    item.liveMinuteFrom = nonNegativeSafeInteger(body.liveMinuteFrom, 'liveMinuteFrom')
    item.liveMinuteTo = nonNegativeSafeInteger(body.liveMinuteTo, 'liveMinuteTo')
    item.includeFirstHalf = boolean(body.includeFirstHalf, 'includeFirstHalf')
    item.includeHalfTime = boolean(body.includeHalfTime, 'includeHalfTime')
    item.includeSecondHalf = boolean(body.includeSecondHalf, 'includeSecondHalf')
    if (item.liveMinuteFrom > item.liveMinuteTo) invalid({ liveMinuteTo: 'liveMinuteTo must be greater than or equal to liveMinuteFrom' })
    if (item.enabled && !item.includeFirstHalf && !item.includeHalfTime && !item.includeSecondHalf) {
      invalid({ enabled: 'enabled live alert settings require at least one phase' })
    }
  }
  return { expectedVersion: body.expectedVersion, acknowledgeMigrationReview, item }
}

export function monitorAlertSettingFromRow(row) {
  const common = {
    mode: row.mode,
    enabled: Boolean(row.enabled),
    asianHandicapEnabled: Boolean(row.asian_handicap_enabled),
    totalEnabled: Boolean(row.total_enabled),
    monitorOddsMin: row.monitor_odds_min,
    monitorOddsMax: row.monitor_odds_max,
    waterMoveThreshold: row.water_move_threshold,
    cooldownSeconds: row.cooldown_seconds,
  }
  const branch = row.mode === 'prematch'
    ? { startMinutesBeforeKickoff: row.start_minutes_before_kickoff, stopMinutesBeforeKickoff: row.stop_minutes_before_kickoff }
    : {
        liveMinuteFrom: row.live_minute_from,
        liveMinuteTo: row.live_minute_to,
        includeFirstHalf: Boolean(row.include_first_half),
        includeHalfTime: Boolean(row.include_half_time),
        includeSecondHalf: Boolean(row.include_second_half),
      }
  return {
    ...common,
    ...branch,
    remark: row.remark,
    migrationReviewRequired: Boolean(row.migration_review_required),
    migrationReviewReason: row.migration_review_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function monitorAlertSettingsSummary(items) {
  const values = [items.prematch, items.live]
  return {
    enabledCount: values.filter((item) => item.enabled).length,
    enabledModes: values.filter((item) => item.enabled).map((item) => item.mode),
    migrationReviewRequiredCount: values.filter((item) => item.migrationReviewRequired).length,
  }
}
