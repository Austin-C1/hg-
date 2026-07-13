export function parseDecimalToMinor(value, { scale, allowZero = false } = {}) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new TypeError('amount-scale')
  const text = String(value ?? '').trim()
  const match = text.match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) throw new TypeError('amount-format')
  const fraction = match[2] || ''
  if (fraction.length > scale) throw new TypeError('amount-precision')
  const minor = BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0')
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount-range')
  const result = Number(minor)
  if (result === 0 && !allowZero) throw new RangeError('amount-positive')
  return result
}

export function assertMinor(value, field = 'amount') {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(field + '-minor')
  return value
}

export function formatMinor(minor, { scale } = {}) {
  assertMinor(minor)
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new TypeError('amount-scale')
  const base = 10 ** scale
  const whole = Math.floor(minor / base)
  return scale ? whole + '.' + String(minor % base).padStart(scale, '0') : String(whole)
}

export function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency')
  return currency
}
