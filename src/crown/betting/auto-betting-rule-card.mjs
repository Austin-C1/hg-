const CARD_FIELDS = [
  'name', 'enabled', 'leagueNames', 'targetOddsMin', 'targetOddsMax',
  'targetAmountMinor', 'remark',
]
const MAX_SAFE_DECIMAL = 9007199254740991n

function invalid(fields, code = 'validation-error') {
  const error = new Error(code)
  error.code = code
  error.fields = fields
  throw error
}

function assertExactFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalid({ body: 'body must be an object' })
  }
  const allowed = new Set(fields)
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  const missing = fields.filter((key) => !Object.hasOwn(body, key))
  if (unknown.length || missing.length) {
    invalid(Object.fromEntries([
      ...unknown.map((key) => [key, 'field is not writable']),
      ...missing.map((key) => [key, 'field is required']),
    ]))
  }
}

function decimal(value, field) {
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:\.\d+)?$/.test(value)) {
    invalid({ [field]: `${field} must be a non-negative decimal string` })
  }
  const [rawInteger, rawFraction = ''] = value.split('.')
  const integer = rawInteger.replace(/^0+/, '') || '0'
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > 18) invalid({ [field]: `${field} supports at most 18 decimal places` })
  const parsed = {
    canonical: fraction ? `${integer}.${fraction}` : integer,
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  }
  if (compareDecimals(parsed, { coefficient: MAX_SAFE_DECIMAL, scale: 0 }) > 0) {
    invalid({ [field]: `${field} must not exceed ${MAX_SAFE_DECIMAL}` })
  }
  return parsed
}

function compareDecimals(left, right) {
  const scale = Math.max(left.scale, right.scale)
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale))
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale))
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function cleanLeagues(value) {
  if (!Array.isArray(value)) invalid({ leagueNames: 'leagueNames must be an array' })
  return [...new Set(value.map((leagueName) => {
    if (typeof leagueName !== 'string') invalid({ leagueNames: 'league names must be strings' })
    return leagueName.trim()
  }).filter(Boolean))]
}

function normalizeCompleteCard(body, { allowedNewLeagues, existingLeagueNames }) {
  if (typeof body.name !== 'string' || !body.name.trim()) invalid({ name: 'name is required' })
  if (typeof body.enabled !== 'boolean') invalid({ enabled: 'enabled must be boolean' })
  const leagueNames = cleanLeagues(body.leagueNames)
  if (!leagueNames.length) invalid({ leagueNames: 'at least one league is required' }, 'league-required')
  const unavailable = leagueNames.filter((leagueName) => (
    !allowedNewLeagues.has(leagueName) && !existingLeagueNames.has(leagueName)
  ))
  if (unavailable.length) {
    invalid({ leagueNames: unavailable }, 'league-not-available-today')
  }
  const targetOddsMin = decimal(body.targetOddsMin, 'targetOddsMin')
  const targetOddsMax = decimal(body.targetOddsMax, 'targetOddsMax')
  if (compareDecimals(targetOddsMin, targetOddsMax) > 0) {
    invalid({ targetOddsMax: 'targetOddsMax must be greater than or equal to targetOddsMin' })
  }
  if (!Number.isSafeInteger(body.targetAmountMinor) || body.targetAmountMinor <= 0) {
    invalid({ targetAmountMinor: 'targetAmountMinor must be a positive safe integer' })
  }
  if (typeof body.remark !== 'string') invalid({ remark: 'remark must be a string' })
  return {
    name: body.name.trim(),
    enabled: body.enabled,
    leagueNames,
    targetOddsMin: targetOddsMin.canonical,
    targetOddsMax: targetOddsMax.canonical,
    targetAmountMinor: body.targetAmountMinor,
    currency: 'CNY',
    amountScale: 0,
    remark: body.remark,
  }
}

export function normalizeRuleCardCreate(body, { availableLeagueNames }) {
  assertExactFields(body, CARD_FIELDS)
  return normalizeCompleteCard(body, {
    allowedNewLeagues: new Set(availableLeagueNames),
    existingLeagueNames: new Set(),
  })
}

export function normalizeRuleCardUpdate(body, { availableLeagueNames, existingLeagueNames }) {
  assertExactFields(body, ['expectedVersion', ...CARD_FIELDS])
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    invalid({ expectedVersion: 'expectedVersion must be a positive safe integer' })
  }
  return normalizeCompleteCard(body, {
    allowedNewLeagues: new Set(availableLeagueNames),
    existingLeagueNames: new Set(existingLeagueNames),
  })
}
