const SECRET_KEY_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|\btid\b|w_id|order_id)/i
const PROJECTION_SENSITIVE_FIELD_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|user(?:name)?|uid|mid|account|member|provider|reference|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const SECRET_TEXT_TAG_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const JSON_LIKE_SECRET_FIELD_RE = new RegExp(
  `(?:^|[,{\\s])["']?${SECRET_TEXT_FIELD_SOURCE}["']?\\s*:`, 'i',
)
const EVIDENCE_FORBIDDEN_KEY_RE = /(?:^|_)(?:cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|tid|w_id|order_id)(?:$|_)/i
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|private)\/)/
const ORIGIN_RE = /https?:\/\//i
const EVIDENCE_SENSITIVE_KEY_PARTS = [
  'cookie', 'authorization', 'auth', 'token', 'session', 'secret', 'password', 'passwd',
  'uid', 'csrf', 'xsrf', 'jwt', 'signature', 'setcookie', 'ticket', 'ticketid', 'orderid',
]
const EVIDENCE_HMAC_BINDING_KEYS = new Set([
  'accountbinding', 'sessionbinding', 'executionidentitybinding', 'resultreferencebinding',
  'sourcebinding', 'runbinding', 'identitybinding', 'evidencebinding', 'fullfieldsetbinding',
])
const EVIDENCE_HMAC_BINDING = /^hmac-sha256:[a-f0-9]{64}$/

export const CROWN_PUBLIC_ENDPOINT_PATHS = Object.freeze([
  '/transform.php',
  '/transform_nl.php',
])

export function isCrownPublicEndpointPath(value) {
  return CROWN_PUBLIC_ENDPOINT_PATHS.includes(String(value || ''))
}

function projectionKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8'))
  if (key.length < 32) throw new Error('crown-protocol-projection:hmac-key-too-short')
  return key
}

function projectionType(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'buffer'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function lengthBucket(length) {
  if (length === 0) return 'empty'
  if (length <= 32) return '1-32'
  if (length <= 256) return '33-256'
  if (length <= 4096) return '257-4096'
  return '4097+'
}

function projectionBinding(key, domain, value) {
  const hmac = createHmac('sha256', key)
  hmac.update(String(domain || 'crown-protocol-shape/v1'), 'utf8')
  hmac.update(Buffer.from([0]))
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) hmac.update(Buffer.from(value))
  else hmac.update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return `hmac-sha256:${hmac.digest('hex')}`
}

function dynamicProjectionFieldName(name) {
  const text = String(name)
  return !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(text)
    || /^\d+$/.test(text)
    || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(text)
    || /\d{4,}/.test(text)
}

function projectionFields(
  value,
  safePrefix = '',
  rawPrefix = '',
  state = { all: [], safe: [], excluded: 0, dynamic: 0 },
) {
  for (const name of Object.keys(value).sort()) {
    const child = value[name]
    const rawField = rawPrefix ? `${rawPrefix}.${name}` : name
    const dynamic = dynamicProjectionFieldName(name)
    const safeName = dynamic ? '[*]' : name
    const safeField = safePrefix ? `${safePrefix}.${safeName}` : safeName
    state.all.push({ name: rawField, type: projectionType(child) })
    if (PROJECTION_SENSITIVE_FIELD_RE.test(name)) {
      state.excluded += 1
      continue
    }
    if (dynamic) state.dynamic += 1
    state.safe.push({ name: safeField, type: projectionType(child) })
    if (child && typeof child === 'object' && !Array.isArray(child)
      && !Buffer.isBuffer(child) && !(child instanceof Uint8Array)) {
      projectionFields(child, safeField, rawField, state)
    }
  }
  return state
}

export function projectCrownProtocolShape(value, {
  hmacKey,
  domain = 'crown-protocol-shape/v1',
} = {}) {
  const key = projectionKey(hmacKey)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string') {
    const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(value, 'utf8')
    return {
      valueType: projectionType(value),
      lengthBucket: lengthBucket(bytes.length),
      fullFieldSetBinding: projectionBinding(key, domain, bytes),
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valueType: projectionType(value),
      fullFieldSetBinding: projectionBinding(key, domain, value),
    }
  }

  const projected = projectionFields(value)
  const fields = [...new Map(projected.safe.map((field) => (
    [`${field.name}\u0000${field.type}`, field]
  ))).values()].sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type))
  return {
    fields,
    excludedSensitiveFieldCount: projected.excluded,
    dynamicFieldNameCount: projected.dynamic,
    fullFieldSetBinding: projectionBinding(key, domain, projected.all),
  }
}

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

function jsonParseError(code, index, duplicateKey = '') {
  const error = new SyntaxError(`${code}:${index}`)
  error.code = code
  if (duplicateKey) error.duplicateKey = duplicateKey
  return error
}

// JSON.parse provides the platform's exact JSON value semantics and handles very
// deep valid inputs without our code recursing. A separate iterative lexical pass
// tracks decoded object keys before the parsed value is returned.
export function parseJsonRejectDuplicateKeys(value) {
  const source = String(value)
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    throw jsonParseError('INVALID_JSON', 0)
  }

  const stack = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    if (character === '"') {
      const start = index
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      let lookahead = index
      while (/[ \t\r\n]/.test(source[lookahead] || '')) lookahead += 1
      const frame = stack.at(-1)
      if (source[lookahead] === ':' && frame?.type === 'object') {
        const key = JSON.parse(source.slice(start, index))
        if (frame.keys.has(key)) throw jsonParseError('DUPLICATE_JSON_KEY', start, key)
        frame.keys.add(key)
      }
      continue
    }
    if (character === '{') stack.push({ type: 'object', keys: new Set() })
    else if (character === '[') stack.push({ type: 'array' })
    else if (character === '}' || character === ']') stack.pop()
    index += 1
  }
  return parsed
}

export function parseBody(postData) {
  if (!postData) return null
  if (typeof postData === 'object') return postData
  const text = String(postData)
  if (/^\s*</.test(text)) return text
  try {
    return parseJsonRejectDuplicateKeys(text)
  } catch {
    if (/^\s*[\[{]/.test(text)) return '[unparseable-json]'
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

function capturedContentType(headersOrContentType) {
  if (typeof headersOrContentType === 'string') return headersOrContentType
  for (const [field, value] of Object.entries(headersOrContentType || {})) {
    if (String(field).toLowerCase() === 'content-type') return String(value || '')
  }
  return ''
}

function requiresStrictJsonRedaction(text, headersOrContentType) {
  const contentType = capturedContentType(headersOrContentType).trim()
  if (/^(?:application|text)\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) return true
  return /^\s*[\[{]/.test(text)
    || /^\s*"(?:[^"\\]|\\.)*"\s*:/.test(text)
    || JSON_LIKE_SECRET_FIELD_RE.test(text)
}

// Store and analyzer use this same transport-aware boundary. JSON transports and
// JSON-like fragments are never allowed to fall back to unstructured plaintext
// after a strict parse failure because that could copy a secret into redacted data.
export function redactCapturedBody(rawBody, headersOrContentType = {}) {
  if (rawBody == null) return rawBody
  if (typeof rawBody === 'object') return redactBody(rawBody)
  const text = String(rawBody)
  if (requiresStrictJsonRedaction(text, headersOrContentType)) {
    try {
      return redactBody(parseJsonRejectDuplicateKeys(text))
    } catch {
      return '[unparseable-json]'
    }
  }
  return redactBody(parseBody(text))
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
    if (EVIDENCE_HMAC_BINDING_KEYS.has(normalizedKey) || normalizedKey.endsWith('binding')) {
      if (typeof current !== 'string' || !EVIDENCE_HMAC_BINDING.test(current)) {
        throw new Error(`unsafe-crown-protocol-evidence:${key}`)
      }
      return
    }
    if (
      EVIDENCE_FORBIDDEN_KEY_RE.test(String(key))
      || [
        'url', 'rawurl', 'origin', 'path', 'rawpath', 'body', 'rawbody', 'requestbody', 'responsebody',
        'postdata', 'payload', 'artifactpath',
      ].includes(normalizedKey)
      || EVIDENCE_SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))
    ) {
      throw new Error(`unsafe-crown-protocol-evidence:${key}`)
    }
    if (Buffer.isBuffer(current) || current instanceof Uint8Array) {
      throw new Error(`unsafe-crown-protocol-evidence:${key || 'buffer'}`)
    }
    if (normalizedKey === 'endpointpath' && (
      typeof current !== 'string'
      || (current !== '/[redacted]' && !isCrownPublicEndpointPath(current))
    )) throw new Error(`unsafe-crown-protocol-evidence:${key}`)
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
import { createHmac } from 'node:crypto'
