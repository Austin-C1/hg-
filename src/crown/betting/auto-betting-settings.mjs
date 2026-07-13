const WRITABLE_FIELDS = [
  'expectedVersion', 'enabled', 'targetOddsMin', 'targetOddsMax', 'targetAmountMinor',
  'currency', 'amountScale', 'remark',
]
const MAX_DECIMAL = { coefficient: 9007199254740991n, scale: 0 }
const MAX_DECIMAL_INPUT_LENGTH = 128
const MAX_DECIMAL_SCALE = 18

function invalid(fields) {
  const error = new Error('validation-error')
  error.code = 'validation-error'
  error.fields = fields
  throw error
}

function decimal(value, field) {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_INPUT_LENGTH || !/^\d+(?:\.\d+)?$/.test(value)) {
    invalid({ [field]: `${field} must be a non-negative decimal string` })
  }
  const [rawInteger, rawFraction = ''] = value.split('.')
  const integer = rawInteger.replace(/^0+/, '') || '0'
  const fraction = rawFraction.replace(/0+$/, '')
  if (fraction.length > MAX_DECIMAL_SCALE) {
    invalid({ [field]: `${field} supports at most ${MAX_DECIMAL_SCALE} decimal places` })
  }
  const parsed = {
    canonical: fraction ? `${integer}.${fraction}` : integer,
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  }
  if (compareDecimals(parsed, MAX_DECIMAL) > 0) {
    invalid({ [field]: `${field} must be between 0 and ${MAX_DECIMAL.coefficient}` })
  }
  return parsed
}

function compareDecimals(left, right) {
  if (left.scale === right.scale) {
    return left.coefficient < right.coefficient ? -1 : left.coefficient > right.coefficient ? 1 : 0
  }
  const scale = Math.max(left.scale, right.scale)
  const leftCoefficient = left.coefficient * (10n ** BigInt(scale - left.scale))
  const rightCoefficient = right.coefficient * (10n ** BigInt(scale - right.scale))
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0
}

export function canonicalAutoBettingDecimal(value) {
  if (value === null || value === undefined) return null
  try {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('invalid')
    const text = String(value)
    if (text.startsWith('-')) throw new Error('invalid')
    let expanded = text
    if (/[eE]/.test(text)) {
      const [coefficient, exponentText] = text.toLowerCase().split('e')
      if (!/^\d+(?:\.\d+)?$/.test(coefficient) || !/^[+-]?\d+$/.test(exponentText)) throw new Error('invalid')
      const exponent = Number(exponentText)
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_INPUT_LENGTH) throw new Error('invalid')
      const digits = coefficient.replace('.', '')
      const decimalIndex = coefficient.indexOf('.')
      const integerLength = decimalIndex === -1 ? digits.length : decimalIndex
      const target = integerLength + exponent
      if (target <= 0) expanded = `0.${'0'.repeat(-target)}${digits}`
      else if (target >= digits.length) expanded = `${digits}${'0'.repeat(target - digits.length)}`
      else expanded = `${digits.slice(0, target)}.${digits.slice(target)}`
    }
    return decimal(expanded, 'targetOdds').canonical
  } catch {
    const error = new Error('legacy-auto-betting-odds-invalid')
    error.code = 'legacy-auto-betting-odds-invalid'
    throw error
  }
}

export function normalizeAutoBettingSetting(mode, body) {
  if (!['prematch', 'live'].includes(mode)) invalid({ mode: 'mode must be prematch or live' })
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid({ body: 'body must be an object' })
  const allowed = new Set(WRITABLE_FIELDS)
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  const missing = WRITABLE_FIELDS.filter((key) => !Object.hasOwn(body, key))
  if (unknown.length || missing.length) {
    invalid(Object.fromEntries([
      ...unknown.map((key) => [key, 'field is not writable']),
      ...missing.map((key) => [key, 'field is required']),
    ]))
  }
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) invalid({ expectedVersion: 'expectedVersion must be a positive safe integer' })
  if (typeof body.enabled !== 'boolean') invalid({ enabled: 'enabled must be boolean' })
  const targetOddsMin = decimal(body.targetOddsMin, 'targetOddsMin')
  const targetOddsMax = decimal(body.targetOddsMax, 'targetOddsMax')
  if (compareDecimals(targetOddsMin, targetOddsMax) > 0) invalid({ targetOddsMax: 'targetOddsMax must be greater than or equal to targetOddsMin' })
  if (!Number.isSafeInteger(body.targetAmountMinor) || body.targetAmountMinor <= 0) {
    invalid({ targetAmountMinor: 'targetAmountMinor must be a positive safe integer' })
  }
  if (body.currency !== 'CNY') invalid({ currency: 'currency must be CNY' })
  if (body.amountScale !== 0) invalid({ amountScale: 'amountScale must be 0' })
  if (typeof body.remark !== 'string') invalid({ remark: 'remark must be a string' })
  return {
    expectedVersion: body.expectedVersion,
    item: {
      enabled: body.enabled,
      targetOddsMin: targetOddsMin.canonical,
      targetOddsMax: targetOddsMax.canonical,
      targetAmountMinor: body.targetAmountMinor,
      currency: 'CNY',
      amountScale: 0,
      remark: body.remark,
    },
  }
}

export function autoBettingSettingFromRow(row) {
  return {
    mode: row.mode,
    enabled: Boolean(row.enabled),
    targetOddsMin: canonicalAutoBettingDecimal(row.target_odds_min),
    targetOddsMax: canonicalAutoBettingDecimal(row.target_odds_max),
    targetAmountMinor: row.target_amount_minor,
    currency: row.currency,
    amountScale: row.amount_scale,
    remark: row.remark,
    realEligible: Boolean(row.real_eligible),
    realEligibilityVersion: row.real_eligibility_version,
    realEligibilityUpdatedAt: row.real_eligibility_updated_at,
    migrationReviewRequired: Boolean(row.migration_review_required),
    migrationReviewReason: row.migration_review_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function autoBettingSettingsSummary(items) {
  const values = [items.prematch, items.live]
  return {
    enabledCount: values.filter((item) => item.enabled).length,
    enabledModes: values.filter((item) => item.enabled).map((item) => item.mode),
    realEligibleCount: values.filter((item) => item.realEligible).length,
    migrationReviewRequiredCount: values.filter((item) => item.migrationReviewRequired).length,
  }
}
