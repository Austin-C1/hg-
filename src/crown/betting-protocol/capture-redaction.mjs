const SECRET_KEY_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const SECRET_TEXT_TAG_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const EVIDENCE_FORBIDDEN_KEY_RE = /(?:^|_)(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|tid|w_id|order_id)(?:$|_)/i
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|private)\/)/
const ORIGIN_RE = /https?:\/\//i
const EVIDENCE_SENSITIVE_KEY_PARTS = [
  'cookie', 'authorization', 'auth', 'token', 'session', 'secret', 'password', 'passwd',
  'uid', 'csrf', 'xsrf', 'jwt', 'signature', 'setcookie', 'ticket', 'ticketid', 'orderid',
]

function mask(value) {
  const text = String(value ?? '')
  return `[masked:${text.length}]`
}

export function redactText(text) {
  return String(text)
    .replace(new RegExp(`(<\\s*(${SECRET_TEXT_TAG_SOURCE})\\b[^>]*>)([\\s\\S]*?)(<\\/\\s*\\2\\s*>)`, 'gi'), (_match, open, _name, value, close) => `${open}${mask(value)}${close}`)
    .replace(new RegExp(`(<\\s*ticket\\b[^>]*\\bid\\s*=\\s*['"])([^'"]+)(['"][^>]*>)`, 'gi'), (_match, open, value, close) => `${open}${mask(value)}${close}`)
    .replace(new RegExp(`(\\b${SECRET_TEXT_FIELD_SOURCE}\\s*=\\s*['"])([^'"]+)(['"])`, 'gi'), (_match, open, value, close) => `${open}${mask(value)}${close}`)
    .replace(new RegExp(`(\\b${SECRET_TEXT_FIELD_SOURCE}\\s*=)([^&\\s<>"']+)`, 'gi'), (_match, open, value) => `${open}${mask(value)}`)
}

export function redactScalar(key, value) {
  if (value == null) return value
  if (SECRET_KEY_RE.test(String(key))) return mask(value)
  if (typeof value !== 'string') return value
  const text = SECRET_TEXT_FIELD_RE.test(value) ? redactText(value) : value
  if (text.length > 500) return `${text.slice(0, 500)}...[truncated ${text.length - 500} chars]`
  return text
}

export function redactHeaders(headers = {}) {
  const output = {}
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = redactScalar(key, value)
  }
  return output
}

export function redactBody(value, parentKey = '') {
  if (value == null) return value
  if (Array.isArray(value)) return value.map((item) => redactBody(item, parentKey))
  if (typeof value === 'object') {
    const output = {}
    for (const [key, child] of Object.entries(value)) {
      output[key] = redactBody(child, key)
    }
    return output
  }
  return redactScalar(parentKey, value)
}

export function parseBody(postData) {
  if (!postData) return null
  if (typeof postData === 'object') return postData
  const text = String(postData)
  if (/^\s*</.test(text)) return text
  try {
    return JSON.parse(text)
  } catch {
    if (!/[=&]/.test(text)) return text
    const params = new URLSearchParams(text)
    const output = {}
    for (const [key, value] of params.entries()) {
      if (!Object.hasOwn(output, key)) output[key] = value
      else if (Array.isArray(output[key])) output[key].push(value)
      else output[key] = [output[key], value]
    }
    return Object.keys(output).length ? output : text
  }
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (SECRET_KEY_RE.test(key)) url.searchParams.set(key, mask(value))
    }
    return url.toString()
  } catch {
    return '[invalid-url]'
  }
}

export function assertSafeCrownProtocolEvidence(value) {
  const visit = (current, key = '') => {
    const normalizedKey = String(key).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
    if (
      EVIDENCE_FORBIDDEN_KEY_RE.test(String(key))
      || ['rawbody', 'requestbody', 'responsebody', 'postdata', 'payload', 'artifactpath'].includes(normalizedKey)
      || EVIDENCE_SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))
    ) {
      throw new Error(`unsafe-crown-protocol-evidence:${key}`)
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, key))
      return
    }
    if (current && typeof current === 'object') {
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey)
      return
    }
    if (typeof current === 'string' && (ABSOLUTE_PATH_RE.test(current) || ORIGIN_RE.test(current))) {
      throw new Error(`unsafe-crown-protocol-evidence:${key || 'value'}`)
    }
  }
  visit(value)
  return value
}
