const SECRET_KEY_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|user(?:name)?|mid|account|member|api[-_]?key|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|\btid\b|w_id|order_id)/i
const PROJECTION_SENSITIVE_FIELD_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|api[-_]?key|user(?:name)?|uid|mid|account|member|provider|reference|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|user(?:name)?|mid|account|member|api[-_]?key|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|\btid\b|w_id|order_id)/i
const SECRET_TEXT_FIELD_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|user(?:name)?|mid|account|member|api[-_]?key|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const SECRET_TEXT_TAG_SOURCE = '(?:cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|user(?:name)?|mid|account|member|api[-_]?key|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket_id|ticket|tid|w_id|order_id)'
const JSON_LIKE_SECRET_FIELD_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_])["']?${SECRET_TEXT_FIELD_SOURCE}["']?\\s*:`, 'i',
)
const EVIDENCE_FORBIDDEN_KEY_RE = /(?:^|_)(?:cookie|authorization|auth|token|session|secret|password|passwd|passcode|user[-_]?agent|user(?:name)?|mid|account|member|api[-_]?key|uid|csrf|xsrf|jwt|signature|sign|set-cookie|ticket|ticket_id|tid|w_id|order_id)(?:$|_)/i
const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|private)\/)/
const ORIGIN_RE = /https?:\/\//i
const EVIDENCE_SENSITIVE_KEY_PARTS = [
  'cookie', 'authorization', 'auth', 'token', 'session', 'secret', 'password', 'passwd', 'passcode',
  'useragent', 'user', 'username', 'mid', 'account', 'member', 'apikey',
  'uid', 'csrf', 'xsrf', 'jwt', 'signature', 'setcookie', 'ticket', 'ticketid', 'orderid',
]
const EVIDENCE_HMAC_BINDING_KEYS = new Set([
  'accountbinding', 'sessionbinding', 'executionidentitybinding', 'resultreferencebinding',
  'sourcebinding', 'runbinding', 'identitybinding', 'evidencebinding', 'fullfieldsetbinding',
])
const EVIDENCE_HMAC_BINDING = /^hmac-sha256:[a-f0-9]{64}$/
// Public artifacts expose only reviewed protocol/schema names. Unknown object
// keys remain HMAC-bound in the full shape but are rendered as [*], because a
// short map key such as roster.alice can itself identify an account or person.
const PROJECTION_PUBLIC_FIELD_NAMES = new Set([
  'action', 'aid', 'amount', 'app', 'attemptCount', 'auditId', 'auto', 'autoOdd',
  'away', 'ball_act', 'batchId', 'bet_amount', 'betamount', 'blackbox', 'captureId',
  'capturedAt', 'change', 'chose_team', 'cmd', 'code', 'command', 'con', 'concede',
  'count', 'coupon', 'cupFantasy', 'currency', 'currency_value', 'data', 'date',
  'dates', 'day', 'dg', 'dg_mode', 'ecid', 'entries', 'entry', 'event', 'eventStatus',
  'f', 'fast_check', 'fields', 'filter', 'finalConfirmation', 'from', 'game_sc',
  'game_so', 'gid', 'gold', 'gold_gmax', 'gold_gmin', 'golds', 'gtype', 'home',
  'id', 'imp', 'important', 'ior', 'ioratio', 'isFantasy', 'isRB', 'isYesterday',
  'isyesterday', 'items', 'langx', 'league', 'league_id', 'league_name', 'left',
  'lid', 'line', 'list', 'ltype', 'map', 'market', 'marketConclusion', 'marketType',
  'max_gold', 'maxcredit', 'mem_sc', 'mem_so', 'meta', 'mode', 'money', 'ms',
  'mtype', 'name', 'nested', 'nowcredit', 'num_c', 'num_h', 'odd', 'odd_f_type',
  'odds', 'oddsField', 'op', 'operation', 'over', 'p', 'p3type', 'pay_type',
  'period', 'ptype', 'quantity', 'ratio', 'ratioField', 'records', 'restsinglecredit',
  'result', 'right', 'roster', 'rows', 'rtype', 'schemaVersion', 'selection',
  'showtype', 'side', 'sorttype', 'specialClick', 'spread', 'stake', 'status',
  'strong', 'suspended', 'switchedMatch', 'systime', 'team', 'team_c', 'team_h',
  'team_id_c', 'team_id_h', 'team_name_c', 'team_name_h', 'time', 'times',
  'timestamp', 'timestamp2', 'ts', 'type', 'under', 'value', 'ver', 'wager',
  'waited', 'wtype',
])
const PROJECTION_FIXED_OBJECT_PATH_NAMES = new Set([
  'chronology', 'config', 'data', 'direct', 'limits', 'market', 'meta', 'nested',
  'preview', 'request', 'response', 'score', 'settings', 'stakeQuantum', 'submit', 'teams',
])
const PROJECTION_DYNAMIC_MAP_PATH_NAMES = new Set(['roster'])
const PROJECTION_FIXED_SIBLING_LAYOUTS = Object.freeze([
  Object.freeze(['away', 'home']),
  Object.freeze(['left', 'right']),
  Object.freeze(['over', 'under']),
  Object.freeze(['preview', 'submit']),
  Object.freeze(['request', 'response']),
])

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
    || !PROJECTION_PUBLIC_FIELD_NAMES.has(text)
}

function projectionFieldShape(value) {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, projectionType(value[key])]))
}

function homogeneousDynamicMap(value, rawPrefix) {
  const entries = Object.entries(value)
  const parentName = String(rawPrefix || '').split('.').at(-1)
  if (entries.length > 0 && PROJECTION_DYNAMIC_MAP_PATH_NAMES.has(parentName)) return true
  if (entries.length < 2 || !entries.every(([, child]) => (
    child && typeof child === 'object' && !Array.isArray(child)
      && !Buffer.isBuffer(child) && !(child instanceof Uint8Array)
  ))) return false
  if (PROJECTION_FIXED_OBJECT_PATH_NAMES.has(parentName)) return false
  const names = entries.map(([name]) => name).sort()
  if (PROJECTION_FIXED_SIBLING_LAYOUTS.some((layout) => (
    layout.length === names.length && layout.every((name, index) => name === names[index])
  ))) return false
  return new Set(entries.map(([, child]) => projectionFieldShape(child))).size === 1
}

function projectionFields(
  value,
  safePrefix = '',
  rawPrefix = '',
  state = { all: [], safe: [], excluded: 0, dynamic: 0 },
) {
  const dynamicMap = homogeneousDynamicMap(value, rawPrefix)
  for (const name of Object.keys(value).sort()) {
    const child = value[name]
    const rawField = rawPrefix ? `${rawPrefix}.${name}` : name
    const dynamic = dynamicMap || dynamicProjectionFieldName(name)
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
    || containsJsonLikeSecretField(text)
}

function containsJsonLikeSecretField(text) {
  if (JSON_LIKE_SECRET_FIELD_RE.test(text)) return true
  for (const match of String(text).matchAll(/("(?:\\.|[^"\\])*")\s*:/g)) {
    try {
      const field = parseJsonRejectDuplicateKeys(match[1])
      if (typeof field === 'string' && SECRET_KEY_RE.test(field)) return true
    } catch {
      // Invalid quoted fragments are handled by the strict-JSON boundary only
      // when another recognizable secret key is present.
    }
  }
  return false
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
  const contentType = capturedContentType(headersOrContentType).trim()
  if (/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) return '[redacted-multipart]'
  if (contentType && !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    return redactScalar('', text)
  }
  return redactBody(parseBody(text))
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.username) url.username = mask(url.username)
    if (url.password) url.password = mask(url.password)
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (SECRET_KEY_RE.test(key) || containsJsonLikeSecretField(value)) {
        url.searchParams.set(key, mask(value))
      }
    }
    const rawFragment = url.hash.slice(1)
    if (rawFragment) {
      let fragment
      try { fragment = decodeURIComponent(rawFragment) } catch { fragment = rawFragment }
      const queryIndex = fragment.indexOf('?')
      const prefix = queryIndex >= 0 ? fragment.slice(0, queryIndex + 1) : ''
      const parameterText = queryIndex >= 0 ? fragment.slice(queryIndex + 1) : fragment
      const params = new URLSearchParams(parameterText)
      let changed = false
      for (const [key, value] of [...params.entries()]) {
        if (!SECRET_KEY_RE.test(key) && !containsJsonLikeSecretField(value)) continue
        params.set(key, mask(value))
        changed = true
      }
      if (changed) url.hash = `${prefix}${params.toString()}`
      else if (containsJsonLikeSecretField(fragment)) url.hash = '[redacted-fragment]'
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
