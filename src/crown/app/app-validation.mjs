export class ValidationError extends Error {
  constructor(error, fields = {}) {
    super(error)
    this.name = 'ValidationError'
    this.code = error
    this.fields = fields
  }
}

export function normalizeExpectedVersion(payload) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  const value = payload.expectedVersion
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('validation-error', { expectedVersion: 'expectedVersion must be a positive safe integer' })
  }
  return value
}

const RULE_CARD_MUTATION_FIELDS = [
  'name', 'enabled', 'leagueNames', 'targetOddsMin', 'targetOddsMax',
  'targetAmountMinor', 'remark',
]

function validateExactPayload(payload, fields) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  const allowed = new Set(fields)
  const errors = {}
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) errors[field] = `${field} is not allowed`
  }
  for (const field of fields) {
    if (!Object.hasOwn(payload, field)) errors[field] = `${field} is required`
  }
  if (Object.keys(errors).length) throw new ValidationError('validation-error', errors)
  return payload
}

export function validateRuleCardCreatePayload(payload) {
  return validateExactPayload(payload, RULE_CARD_MUTATION_FIELDS)
}

export function validateRuleCardUpdatePayload(payload) {
  validateExactPayload(payload, ['expectedVersion', ...RULE_CARD_MUTATION_FIELDS])
  normalizeExpectedVersion(payload)
  return payload
}

export function validateRuleCardDeletePayload(payload) {
  validateExactPayload(payload, ['expectedVersion'])
  normalizeExpectedVersion(payload)
  return payload
}

export function normalizeAutoBetRuleReorder(payload) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  assertNoForbiddenAutoBetRuleFields(payload)
  assertOnlyFields(payload, ['items'])
  if (!Array.isArray(payload.items)) throw new ValidationError('validation-error', { items: 'items must be an array' })
  const seen = new Set()
  const items = payload.items.map((item, index) => {
    if (!isPlainObject(item)) throw new ValidationError('validation-error', { items: `item ${index} must be an object` })
    assertOnlyFields(item, ['id', 'expectedVersion'])
    const id = optionalString(item.id)
    if (!id || seen.has(id)) throw new ValidationError('validation-error', { items: 'ids must be non-empty and unique' })
    seen.add(id)
    return { id, expectedVersion: normalizeExpectedVersion(item) }
  })
  return { items }
}

export function assertNoForbiddenAutoBetRuleFields(payload) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    for (const [field, child] of Object.entries(value)) {
      if (['amountScale', 'stakeStep', 'bettingRuleId'].includes(field)
        || /secret|authorization|provider.*reference/i.test(field)) {
        throw new ValidationError('validation-error', { [field]: `${field} is forbidden` })
      }
      visit(child)
    }
  }
  visit(payload)
}

const AUTO_BET_RULE_CREATE_FIELDS = [
  'name', 'monitorEnabled', 'realBettingEnabled', 'mode', 'period', 'marketType',
  'monitoredSide', 'minWaterRise', 'targetOddsMin', 'targetOddsMax',
  'targetAmountMinor', 'leagueNames', 'startMinutesBeforeKickoff',
  'stopMinutesBeforeKickoff', 'liveMinuteFrom', 'liveMinuteTo',
  'migrationReviewRequired',
]

const AUTO_BET_RULE_UPDATE_FIELDS = [
  'expectedVersion', 'name', 'mode', 'period', 'marketType', 'monitoredSide',
  'minWaterRise', 'targetOddsMin', 'targetOddsMax', 'targetAmountMinor',
  'leagueNames', 'startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff',
  'liveMinuteFrom', 'liveMinuteTo', 'migrationReviewRequired', 'acknowledgeMigrationReview',
]

function assertOnlyFields(payload, allowed) {
  const allowedSet = new Set(allowed)
  for (const field of Object.keys(payload)) {
    if (!allowedSet.has(field)) throw new ValidationError('validation-error', { [field]: `${field} is not allowed` })
  }
}

function validateAutoBetRuleFields(payload, allowed) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  assertNoForbiddenAutoBetRuleFields(payload)
  assertOnlyFields(payload, allowed)
  return payload
}

export function validateAutoBetRuleCreatePayload(payload) {
  return validateAutoBetRuleFields(payload, AUTO_BET_RULE_CREATE_FIELDS)
}

export function validateAutoBetRuleUpdatePayload(payload) {
  return validateAutoBetRuleFields(payload, AUTO_BET_RULE_UPDATE_FIELDS)
}

export function validateAutoBetRuleCasPayload(payload) {
  validateAutoBetRuleFields(payload, ['expectedVersion'])
  normalizeExpectedVersion(payload)
  return payload
}

function decimalStringField(payload, field, { required = false } = {}) {
  const value = payload[field]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError('validation-error', { [field]: `${field} is required` })
    return undefined
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  }
  return value.trim()
}

function positiveIntegerCnyField(payload, field, { required = false } = {}) {
  const value = payload[field]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError('integer-cny-required', { [field]: `${field} must be a positive integer CNY string` })
    return undefined
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim())) {
    throw new ValidationError('integer-cny-required', { [field]: `${field} must be a positive integer CNY string` })
  }
  const normalized = BigInt(value.trim())
  if (normalized < 1n || normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError('integer-cny-required', { [field]: `${field} must be a positive safe integer CNY string` })
  }
  return normalized.toString()
}

function currencyField(payload, field, { required = false } = {}) {
  const value = optionalString(payload[field]).toUpperCase()
  if (!value && !required) return undefined
  if (!/^[A-Z]{3}$/.test(value)) throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  return value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function optionalUrl(value) {
  const text = optionalString(value)
  if (!text) return ''
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(normalized)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('invalid-url')
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new ValidationError('validation-error', { url: 'invalid URL' })
  }
}

function requiredString(payload, field, label = field) {
  const value = optionalString(payload[field])
  if (!value) throw new ValidationError('validation-error', { [field]: `${label} is required` })
  return value
}

function optionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return Number.NaN
  return number
}

function numberField(payload, field, fallback, { min = null } = {}) {
  const number = optionalNumber(payload[field], fallback)
  if (!Number.isFinite(number) || (min !== null && number < min)) {
    throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  }
  return number
}

function firstDefined(payload, fields) {
  for (const field of fields) {
    if (payload[field] !== undefined) return { field, value: payload[field] }
  }
  return { field: fields[0], value: undefined }
}

function aliasedNumberField(payload, fields, fallback, options = {}) {
  const { field, value } = firstDefined(payload, fields)
  return numberField({ [field]: value }, field, fallback, options)
}

function aliasedStringField(payload, fields) {
  const { value } = firstDefined(payload, fields)
  return optionalString(value)
}

function nullableNumberField(payload, field) {
  const number = optionalNumber(payload[field], null)
  if (number === null) return null
  if (!Number.isFinite(number)) throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  return number
}

function booleanField(payload, field, fallback) {
  if (payload[field] === undefined || payload[field] === null) return Boolean(fallback)
  return Boolean(payload[field])
}

function optionalPlainObject(value, fallback = null) {
  if (value === undefined || value === null) return fallback
  if (!isPlainObject(value)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  return value
}

function optionalIntegerField(payload, field, fallback, { min = null, max = null } = {}) {
  if (payload[field] === undefined || payload[field] === null || payload[field] === '') return fallback
  const number = Number(payload[field])
  if (!Number.isInteger(number) || (min !== null && number < min) || (max !== null && number > max)) {
    throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  }
  return number
}

function enumField(payload, field, allowed, fallback) {
  const value = optionalString(payload[field] ?? fallback)
  if (!allowed.includes(value)) {
    throw new ValidationError('validation-error', { [field]: `invalid ${field}` })
  }
  return value
}

function assertObject(payload) {
  if (!isPlainObject(payload)) throw new ValidationError('validation-error', { body: 'JSON object is required' })
  return payload
}

export function normalizeTrackedMatch(payload) {
  const body = assertObject(payload)
  return {
    eventKey: requiredString(body, 'eventKey'),
    league: requiredString(body, 'league'),
    homeTeam: requiredString(body, 'homeTeam'),
    awayTeam: requiredString(body, 'awayTeam'),
    mode: enumField(body, 'mode', ['prematch', 'live', 'unknown'], 'unknown'),
    sourceStatus: optionalString(body.sourceStatus),
    tracked: body.tracked === undefined ? true : Boolean(body.tracked),
  }
}

export function normalizeMonitorAccount(payload, { partial = false } = {}) {
  const body = assertObject(payload)
  const result = {}
  if (!partial || body.label !== undefined) result.label = partial ? optionalString(body.label) : requiredString(body, 'label')
  if (!partial || body.username !== undefined) result.username = partial ? optionalString(body.username) : requiredString(body, 'username')
  if (!partial || body.loginUrl !== undefined) result.loginUrl = optionalUrl(body.loginUrl)
  if (!partial || body.enabled !== undefined) result.enabled = booleanField(body, 'enabled', false)
  if (!partial || body.status !== undefined) result.status = enumField(body, 'status', ['enabled', 'disabled', 'needs-login', 'missing-secret'], 'disabled')
  if (!partial || body.notes !== undefined) result.notes = optionalString(body.notes)
  if (!partial || body.loginStatus !== undefined) result.loginStatus = optionalString(body.loginStatus || '未启动')
  if (!partial || body.currentMonitorStatus !== undefined) result.currentMonitorStatus = optionalString(body.currentMonitorStatus || '未启动')
  if (!partial || body.lastLoginAt !== undefined) result.lastLoginAt = optionalString(body.lastLoginAt)
  if (!partial || body.lastOnlineCheckAt !== undefined) result.lastOnlineCheckAt = optionalString(body.lastOnlineCheckAt)
  if (!partial || body.lastXmlResponseAt !== undefined) result.lastXmlResponseAt = optionalString(body.lastXmlResponseAt)
  if (!partial || body.lastOddsParsedAt !== undefined) result.lastOddsParsedAt = optionalString(body.lastOddsParsedAt)
  if (!partial || body.consecutiveFailures !== undefined) result.consecutiveFailures = optionalIntegerField(body, 'consecutiveFailures', 0, { min: 0 })
  if (!partial || body.oddsScanIntervalSeconds !== undefined) result.oddsScanIntervalSeconds = optionalIntegerField(body, 'oddsScanIntervalSeconds', 10, { min: 1 })
  if (!partial || body.autoReloginCount !== undefined) result.autoReloginCount = optionalIntegerField(body, 'autoReloginCount', 0, { min: 0 })
  if (!partial || body.maxAutoReloginCount !== undefined) result.maxAutoReloginCount = optionalIntegerField(body, 'maxAutoReloginCount', 3, { min: 0 })
  if (!partial || body.lastLoginResult !== undefined) result.lastLoginResult = optionalPlainObject(body.lastLoginResult, null)
  if (!partial || body.lastLoginResultAt !== undefined) result.lastLoginResultAt = optionalString(body.lastLoginResultAt)
  if (!partial || body.lastLoginDiagnosticsPath !== undefined) result.lastLoginDiagnosticsPath = optionalString(body.lastLoginDiagnosticsPath)
  if (body.secret !== undefined) result.secret = String(body.secret || '')
  return result
}

export function normalizeLoginResult(payload) {
  const body = assertObject(payload)
  return {
    ok: Boolean(body.ok),
    accountId: optionalString(body.accountId),
    status: optionalString(body.status || '未启动'),
    loginMethod: optionalString(body.loginMethod),
    cookieStatus: optionalString(body.cookieStatus),
    storageStateStatus: optionalString(body.storageStateStatus),
    xmlVerified: Boolean(body.xmlVerified),
    sessionVerified: Boolean(body.sessionVerified),
    diagnosticPath: optionalString(body.diagnosticPath),
    debugSnapshot: optionalPlainObject(body.debugSnapshot, null),
    startedAt: optionalString(body.startedAt),
    finishedAt: optionalString(body.finishedAt),
    message: optionalString(body.message),
  }
}

export function normalizeMonitorRule(payload, { partial = false } = {}) {
  const body = assertObject(payload)
  const result = {}
  if (!partial || body.name !== undefined) result.name = partial ? optionalString(body.name) : requiredString(body, 'name')
  if (!partial || body.enabled !== undefined) result.enabled = booleanField(body, 'enabled', true)
  if (!partial || body.leagueFilter !== undefined) result.leagueFilter = optionalString(body.leagueFilter)
  if (!partial || body.modeFilter !== undefined) result.modeFilter = optionalString(body.modeFilter)
  if (!partial || body.marketFilter !== undefined) result.marketFilter = optionalString(body.marketFilter)
  if (!partial || body.minOddsChange !== undefined) result.minOddsChange = numberField(body, 'minOddsChange', 0.03, { min: 0 })
  if (!partial || body.pollSeconds !== undefined) result.pollSeconds = numberField(body, 'pollSeconds', 5, { min: 1 })
  if (!partial || body.alertEnabled !== undefined) result.alertEnabled = booleanField(body, 'alertEnabled', false)
  return result
}

export function normalizeBettingRule(payload, { partial = false } = {}) {
  const body = assertObject(payload)
  const result = {}
  if (!partial || body.name !== undefined) result.name = partial ? optionalString(body.name) : requiredString(body, 'name')
  if (!partial || body.enabled !== undefined) result.enabled = booleanField(body, 'enabled', false)
  if (!partial || body.leagueNames !== undefined) {
    if (!Array.isArray(body.leagueNames)) throw new ValidationError('validation-error', { leagueNames: 'invalid leagueNames' })
    result.leagueNames = body.leagueNames
  }
  if (!partial || body.targetAmount !== undefined) result.targetAmount = decimalStringField(body, 'targetAmount', { required: !partial })
  if (!partial || body.currency !== undefined) result.currency = currencyField(body, 'currency', { required: !partial })
  if (!partial || body.amountScale !== undefined) result.amountScale = optionalIntegerField(body, 'amountScale', 2, { min: 0, max: 6 })
  if (!partial || body.changedOddsMin !== undefined) result.changedOddsMin = nullableNumberField(body, 'changedOddsMin')
  if (!partial || body.changedOddsMax !== undefined) result.changedOddsMax = nullableNumberField(body, 'changedOddsMax')
  if (!partial || body.direction !== undefined) result.direction = enumField(body, 'direction', ['up_reverse'], 'up_reverse')
  if (body.executionMode !== undefined) result.executionMode = enumField(body, 'executionMode', ['preview_only', 'real_eligible'], 'preview_only')
  if (!partial || body.notes !== undefined) result.notes = optionalString(body.notes)
  return result
}

export function normalizeBettingAccount(payload, { partial = false } = {}) {
  const body = assertObject(payload)
  for (const field of ['amountScale', 'stakeStep']) {
    if (Object.hasOwn(body, field)) throw new ValidationError('validation-error', { [field]: `${field} is not allowed` })
  }
  const result = {}
  if (!partial || body.label !== undefined || body.name !== undefined) result.label = partial ? optionalString(body.label ?? body.name) : optionalString(body.label ?? body.name)
  if (!partial || body.username !== undefined) result.username = partial ? optionalString(body.username) : requiredString(body, 'username')
  if (!partial || body.websiteUrl !== undefined || body.url !== undefined || body.loginUrl !== undefined) {
    const rawUrl = aliasedStringField(body, ['websiteUrl', 'url', 'loginUrl'])
    result.websiteUrl = rawUrl ? optionalUrl(rawUrl) : ''
  }
  if (!partial || body.betOrder !== undefined || body.order !== undefined || body.sequence !== undefined) {
    const { field, value } = firstDefined(body, ['betOrder', 'order', 'sequence'])
    result.betOrder = optionalIntegerField({ [field]: value }, field, 0, { min: 0 })
  }
  if (!partial || body.status !== undefined) result.status = enumField(body, 'status', ['enabled', 'disabled', 'needs-login', 'missing-secret'], 'disabled')
  if (!partial || body.perBetLimit !== undefined) result.perBetLimit = positiveIntegerCnyField(body, 'perBetLimit', { required: !partial })
  if (!partial || body.currency !== undefined) result.currency = currencyField(body, 'currency', { required: !partial })
  if (!partial || body.notes !== undefined) result.notes = optionalString(body.notes)
  if (body.secret !== undefined || body.password !== undefined) result.secret = String(body.secret ?? body.password ?? '')
  if (!partial && !result.label) result.label = result.username || ''
  return result
}

export function normalizeBettingHistoryInput(payload) {
  const body = assertObject(payload)
  const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details) ? { ...body.details } : {}
  for (const field of ['leagueName', 'teams', 'market', 'handicap', 'betTime']) {
    if (body[field] !== undefined) details[field] = body[field]
  }
  return {
    bettingAccountId: String(body.bettingAccountId || body.accountId || ''),
    eventKey: String(body.eventKey || ''),
    ruleId: String(body.ruleId || ''),
    status: String(body.status || 'unknown'),
    amount: Number(body.amount || 0),
    oddsRaw: String(body.oddsRaw || ''),
    betTime: optionalString(body.betTime),
    details,
  }
}
