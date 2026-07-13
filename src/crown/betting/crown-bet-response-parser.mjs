import { createHash } from 'node:crypto'

function tag(text, name) {
  const match = String(text || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

function numberOrNull(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function ticketRef(value) {
  const text = String(value || '')
  return text ? `[ticket:${text.length}]` : ''
}

function ticketIdFromStatus(text) {
  return String(text || '').match(/<ticket\b[^>]*\bid=['"]?([^'">]+)/i)?.[1] || ''
}

function normalizedFieldSet(fields = []) {
  return [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))].sort()
}

export function fingerprintCrownResponseFieldSet(fields = []) {
  return `sha256:${createHash('sha256').update(JSON.stringify(normalizedFieldSet(fields))).digest('hex')}`
}

function strictEnvelope(xml) {
  const text = String(xml || '').trim().replace(/^<\?xml\b[^>]*>\s*/i, '')
  const match = /^<serverresponse\b[^>]*>([\s\S]*)<\/serverresponse>$/.exec(text)
  if (!match) return null
  const body = match[1]
  const openingFields = [...body.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>/g)].map((item) => item[1])
  const fields = normalizedFieldSet(openingFields)
  return { body, fields, duplicateField: openingFields.length !== fields.length }
}

function strictError(code, fields = []) {
  const responseFieldSet = normalizedFieldSet(fields)
  const error = new Error(code)
  error.code = code
  error.diagnostics = {
    errorCode: code,
    responseFieldSet,
    responseFieldSetFingerprint: fingerprintCrownResponseFieldSet(responseFieldSet),
  }
  return error
}

function strictTag(body, fields, name, { required = true } = {}) {
  const openings = body.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || []
  const closings = body.match(new RegExp(`</${name}>`, 'gi')) || []
  const values = [...body.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))]
  if (openings.length !== closings.length || values.length !== openings.length) {
    throw strictError(`malformed-preview-field:${name}`, fields)
  }
  if (values.length > 1) throw strictError(`duplicate-preview-field:${name}`, fields)
  if (!values.length) {
    if (required) throw strictError(`missing-preview-field:${name}`, fields)
    return ''
  }
  const value = values[0][1].trim()
  if (!value || /[<>]/.test(value)) throw strictError(`malformed-preview-field:${name}`, fields)
  return value
}

function strictDecimal(raw, name, fields, { allowNegative = false, maxScale = 6 } = {}) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw)
  if (!match || (!allowNegative && match[1])) throw strictError(`malformed-preview-field:${name}`, fields)
  const fraction = match[3] || ''
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, '')
  if (fraction.length > maxScale || BigInt(digits || '0') > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw strictError(`unsafe-preview-precision:${name}`, fields)
  }
  const canonicalFraction = fraction.replace(/0+$/, '')
  const zero = /^0+$/.test(digits || '0')
  const exact = `${match[1] && !zero ? '-' : ''}${match[2]}${canonicalFraction ? `.${canonicalFraction}` : ''}`
  return {
    raw,
    exact,
    coefficient: BigInt(digits || '0') * (match[1] && !zero ? -1n : 1n),
    scale: fraction.length,
  }
}

function compareExact(left, right) {
  const scale = Math.max(left.scale, right.scale)
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale))
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale))
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

function strictPositiveDecimal(raw, name, fields) {
  const value = strictDecimal(raw, name, fields)
  if (value.coefficient <= 0n) throw strictError(`malformed-preview-field:${name}`, fields)
  return value
}

function strictLine(raw, fields) {
  const parts = raw.split('/').map((part) => part.trim())
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part)) {
    throw strictError('malformed-preview-field:spread', fields)
  }
  const parsed = parts.map((part) => strictDecimal(part, 'spread', fields, { allowNegative: true }))
  return { raw, exact: parsed.map((part) => part.exact).join(' / ') }
}

export function parseCrownPreviewResponseStrict(xml, { expectedFieldSet } = {}) {
  const envelope = strictEnvelope(xml)
  if (!envelope) throw strictError('malformed-preview-response')
  const { body, fields: responseFieldSet } = envelope
  if (expectedFieldSet) {
    const expected = normalizedFieldSet(expectedFieldSet)
    if (
      expected.length !== responseFieldSet.length
      || expected.some((field, index) => field !== responseFieldSet[index])
    ) {
      throw strictError('crown-preview-response-field-set-mismatch', responseFieldSet)
    }
  }
  const code = strictTag(body, responseFieldSet, 'code')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) throw strictError('malformed-preview-field:code', responseFieldSet)
  if (code !== '501') throw strictError('unknown-preview-code', responseFieldSet)
  const minStake = strictPositiveDecimal(strictTag(body, responseFieldSet, 'gold_gmin'), 'gold_gmin', responseFieldSet)
  const maxStake = strictPositiveDecimal(strictTag(body, responseFieldSet, 'gold_gmax'), 'gold_gmax', responseFieldSet)
  const odds = strictPositiveDecimal(strictTag(body, responseFieldSet, 'ioratio'), 'ioratio', responseFieldSet)
  const line = strictLine(strictTag(body, responseFieldSet, 'spread'), responseFieldSet)
  const maxCreditRaw = strictTag(body, responseFieldSet, 'maxcredit', { required: false })
  if (envelope.duplicateField) throw strictError('duplicate-preview-response-field', responseFieldSet)
  if (compareExact(minStake, maxStake) > 0) throw strictError('preview-min-exceeds-max', responseFieldSet)
  const responseFieldSetFingerprint = fingerprintCrownResponseFieldSet(responseFieldSet)
  const evidenced = (value, source) => ({ raw: value.raw, exact: value.exact, source, verified: true })
  return {
    ok: true,
    code,
    minStake: evidenced(minStake, 'gold_gmin'),
    maxStake: evidenced(maxStake, 'gold_gmax'),
    odds: evidenced(odds, 'ioratio'),
    line: evidenced(line, 'spread'),
    maxCreditRaw,
    maxCreditSemantics: 'unverified',
    currency: { value: null, source: 'not-evidenced-in-preview-response', verified: false },
    stakeStep: { value: null, source: 'not-evidenced-in-preview-response', verified: false },
    responseFieldSet,
    responseFieldSetFingerprint,
    diagnostics: { code, responseFieldSet, responseFieldSetFingerprint },
  }
}

export function parseCrownPreviewResponse(xml) {
  const code = tag(xml, 'code')
  const minStake = numberOrNull(tag(xml, 'gold_gmin'))
  const maxStake = numberOrNull(tag(xml, 'gold_gmax'))
  const oddsRaw = tag(xml, 'ioratio')
  const errorMessage = tag(xml, 'errormsg')
  const systemTime = tag(xml, 'systime')
  const fastCheck = tag(xml, 'fast_check')
  const result = {
    ok: Boolean(code && code.toLowerCase() !== 'error' && oddsRaw && minStake !== null && maxStake !== null),
    code,
    minStake,
    maxStake,
    oddsRaw,
    spread: tag(xml, 'spread'),
    strong: tag(xml, 'strong'),
    message: tag(xml, 'message') || tag(xml, 'code_message') || errorMessage,
  }
  if (errorMessage) result.errorMessage = errorMessage
  if (systemTime) result.systemTime = systemTime
  if (fastCheck) result.fastCheck = fastCheck
  return result
}

export function parseCrownSubmitResponse(xml) {
  const rawTicket = tag(xml, 'ticket_id')
  const result = {
    ok: Boolean(tag(xml, 'code') && rawTicket),
    code: tag(xml, 'code'),
    ticketRef: ticketRef(rawTicket),
    market: {
      gid: tag(xml, 'gid'),
      gtype: tag(xml, 'gtype'),
      wtype: tag(xml, 'wtype'),
      rtype: tag(xml, 'rtype'),
    },
    oddsRaw: tag(xml, 'ioratio'),
    stake: numberOrNull(tag(xml, 'gold')),
    spread: tag(xml, 'spread'),
    message: tag(xml, 'message') || tag(xml, 'code_message'),
  }
  Object.defineProperty(result, 'ticketSecret', {
    value: rawTicket,
    enumerable: false,
  })
  return result
}

export function parseCrownDangerousStatus(xml) {
  const text = String(xml || '')
  if (/<status_A>[\s\S]*?<ticket\b/i.test(text)) return { status: 'accepted', ticketRef: ticketRef(ticketIdFromStatus(text)) }
  if (/<status_N>[\s\S]*?<ticket\b/i.test(text)) return { status: 'pending', ticketRef: ticketRef(ticketIdFromStatus(text)) }
  if (/<status_R>[\s\S]*?<ticket\b/i.test(text)) return { status: 'rejected', ticketRef: ticketRef(ticketIdFromStatus(text)) }
  return { status: 'unknown', ticketRef: '' }
}
