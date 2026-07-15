import { createHash } from 'node:crypto'

import { parseBody, parseJsonRejectDuplicateKeys } from './capture-redaction.mjs'

const MONITOR_RE = /(get_game_list|get_game_more|chk_login|get_member_data)/i
const EXACT_MONITOR_OPERATIONS = new Set(['get_game_list', 'get_game_more', 'chk_login', 'get_member_data'])
const EXACT_MONITOR_REQUEST_FIELDS = Object.freeze({
  get_game_list: new Set([
    'p', 'uid', 'langx', 'p3type', 'date', 'gtype', 'showtype', 'rtype', 'ltype', 'filter',
    'cupFantasy', 'sorttype', 'specialClick', 'isFantasy',
  ]),
  get_game_more: new Set([
    'p', 'uid', 'langx', 'gtype', 'showtype', 'ltype', 'isRB', 'lid', 'specialClick',
    'mode', 'from', 'filter', 'ts', 'ecid',
  ]),
  chk_login: new Set(['p', 'langx', 'username', 'password', 'app', 'auto', 'blackbox']),
  get_member_data: new Set(['p', 'uid', 'langx', 'change']),
})
const ROUTE_OPERATION_FIELDS = new Set(['p', 'action', 'operation', 'op', 'command', 'cmd'])
const SUBMIT_OPERATION_VALUES = new Set([
  'submit', 'confirm', 'buy', 'place', 'order_add', 'bet_add', 'wager_add', 'ticket_add', 'bet',
  'checkout', 'ft_bet',
])
const PREVIEW_OPERATION_VALUES = new Set([
  'preview', 'open', 'prepare', 'check', 'verify', 'order_view', 'bet_view', 'bet_slip',
  'ft_order_view',
])
const MONEY_FIELD_NAMES = new Set([
  'gold', 'golds', 'stake', 'stakes', 'amount', 'money', 'wager', 'betamount', 'bet_amount',
  'quantity',
])
const ORDER_FIELD_NAMES = new Set([
  'gid', 'selection', 'chose_team', 'side', 'ior', 'ioratio', 'odd', 'odds', 'ratio', 'rtype',
  'wtype', 'ticket', 'coupon', 'line',
])
const ORDER_ENDPOINT_TOKENS = new Set(['bet', 'betslip', 'wager', 'order', 'ticket', 'coupon'])
const SUBMIT_ENDPOINT_TOKENS = new Set(['submit', 'confirm', 'checkout'])
const UNINSPECTABLE_MULTIPART_FIELD = '__crown_uninspectable_multipart__'
export const UNINSPECTABLE_JSON_FRAGMENT_FIELD = '__crown_uninspectable_json_fragment__'
const PREVIEW_ENDPOINT_TOKENS = new Set(['preview', 'order_view', 'bet_view', 'betslip'])
const STATIC_ASSET_RESOURCE_TYPES = new Map([
  ['css', new Set(['stylesheet'])],
  ['js', new Set(['script'])],
  ['mjs', new Set(['script'])],
  ['png', new Set(['image'])],
  ['jpg', new Set(['image'])],
  ['jpeg', new Set(['image'])],
  ['gif', new Set(['image'])],
  ['webp', new Set(['image'])],
  ['svg', new Set(['image'])],
  ['ico', new Set(['image'])],
  ['woff', new Set(['font'])],
  ['woff2', new Set(['font'])],
  ['ttf', new Set(['font'])],
  ['otf', new Set(['font'])],
])
const ROUTE_CRITICAL_FIELD_NAMES = new Set([
  ...ROUTE_OPERATION_FIELDS, ...MONEY_FIELD_NAMES, ...ORDER_FIELD_NAMES,
])
const EXACT_PREVIEW_REQUEST_FIELDS = ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype']

const target = (mode, marketType, side) => Object.freeze({
  id: `${mode}-full-time-${marketType === 'asian_handicap' ? 'asian-handicap' : marketType}-${side}`,
  mode,
  period: 'full_time',
  marketType,
  lineVariant: 'main',
  side,
})

export const CROWN_BROWSER_TARGETS = Object.freeze([
  target('prematch', 'asian_handicap', 'home'),
  target('prematch', 'asian_handicap', 'away'),
  target('prematch', 'total', 'over'),
  target('prematch', 'total', 'under'),
  target('live', 'asian_handicap', 'home'),
  target('live', 'asian_handicap', 'away'),
  target('live', 'total', 'over'),
  target('live', 'total', 'under'),
])

function exactFieldSet(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.values(value).some(Array.isArray)) return false
  const keys = Object.keys(value)
  if (keys.some((field) => field !== 'uid' && !expected.includes(field))) return false
  const fields = keys.filter((field) => field !== 'uid').sort()
  return fields.length === expected.length && fields.every((field, index) => field === expected[index])
}

function fieldSetFingerprint(fields) {
  return `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
}

function boundedPath(prefix, suffix) {
  const path = prefix ? `${prefix}${suffix.startsWith('[') ? '' : '.'}${suffix}` : suffix
  return path.length <= 256 ? path : `...${path.slice(-253)}`
}

function flatten(value, prefix = '', output = []) {
  const stack = [{ value, prefix }]
  const seen = new WeakSet()
  while (stack.length) {
    const current = stack.pop()
    if (current.value == null) continue
    if (typeof current.value !== 'object') {
      output.push(`${current.prefix}=${String(current.value).slice(0, 80)}`)
      continue
    }
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      const arrayPrefix = boundedPath(current.prefix, '[]')
      output.push(arrayPrefix)
      const items = current.value.slice(0, 10)
      for (let index = items.length - 1; index >= 0; index -= 1) {
        stack.push({ value: items[index], prefix: arrayPrefix })
      }
      continue
    }
    const entries = Object.entries(current.value)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]
      stack.push({ value: child, prefix: boundedPath(current.prefix, key) })
    }
  }
  return output
}

function queryFields(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), 'https://capture.invalid')
    const output = {}
    for (const [key, value] of url.searchParams.entries()) {
      if (!Object.hasOwn(output, key)) output[key] = value
      else if (Array.isArray(output[key])) output[key].push(value)
      else output[key] = [output[key], value]
    }
    return output
  } catch {
    return {}
  }
}

function fieldValues(source, field) {
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, field)) return []
  const value = source[field]
  return (Array.isArray(value) ? value : [value]).map((item) => String(item))
}

function routeFieldEntries(source, origin, output = [], inheritedName = '') {
  const stack = [{ value: source, inheritedName }]
  const seen = new WeakSet()
  while (stack.length) {
    const current = stack.pop()
    if (current.value === null || typeof current.value !== 'object') {
      if (current.inheritedName) {
        output.push({
          name: current.inheritedName,
          value: String(current.value ?? '').normalize('NFC').trim(),
          origin,
        })
      }
      continue
    }
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], inheritedName: current.inheritedName })
      }
      continue
    }
    const entries = Object.entries(current.value)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [rawName, rawValue] = entries[index]
      const name = String(rawName).normalize('NFC').toLowerCase()
      stack.push({ value: rawValue, inheritedName: name })
    }
  }
  return output
}

function invalidMultipart() {
  return Object.freeze({ detected: true, valid: false, entries: Object.freeze([]) })
}

function multipartBoundary(headers, bodyLooksMultipart) {
  const values = Object.entries(headers || {})
    .filter(([field]) => String(field).toLowerCase() === 'content-type')
    .map(([, value]) => String(value || ''))
  if (values.length !== 1) return values.length || bodyLooksMultipart ? invalidMultipart() : null
  const segments = values[0].split(';')
  if (segments.shift()?.trim().toLowerCase() !== 'multipart/form-data') {
    return bodyLooksMultipart ? invalidMultipart() : null
  }
  const boundaries = []
  for (const segment of segments) {
    const parameter = segment.match(/^\s*([A-Za-z0-9!#$&^_.+-]+)\s*=\s*(.*?)\s*$/)
    if (!parameter) return invalidMultipart()
    if (parameter[1].toLowerCase() !== 'boundary') continue
    let value = parameter[2]
    if (value.startsWith('"') || value.endsWith('"')) {
      if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return invalidMultipart()
      value = value.slice(1, -1)
    }
    boundaries.push(value)
  }
  if (boundaries.length !== 1 || !/^[0-9A-Za-z'()+_,./:=?-]{1,70}$/.test(boundaries[0])) {
    return invalidMultipart()
  }
  return boundaries[0]
}

function multipartDelimiter(text, delimiter, from = 0) {
  for (let index = text.indexOf(delimiter, from); index >= 0; index = text.indexOf(delimiter, index + 1)) {
    if (index !== 0 && text[index - 1] !== '\n') continue
    const after = index + delimiter.length
    if (text.startsWith('--', after)) return { index, after, closing: true, newlineLength: 0 }
    if (text.startsWith('\r\n', after)) return { index, after, closing: false, newlineLength: 2 }
    if (text.startsWith('\n', after)) return { index, after, closing: false, newlineLength: 1 }
  }
  return null
}

function multipartParameterValue(rawValue) {
  const value = String(rawValue || '').trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null
  if (['"', "'"].includes(value[0]) || ['"', "'"].includes(value.at(-1))) {
    if (value.length < 2 || value[0] !== value.at(-1)) return null
    const inner = value.slice(1, -1)
    if (inner.includes(value[0]) || inner.includes('\\')) return null
    return inner
  }
  return /^[^\s;"\\]+$/.test(value) ? value : null
}

function multipartPart(part) {
  const separator = part.match(/\r?\n\r?\n/)
  if (!separator) return null
  const rawHeaderBlock = part.slice(0, separator.index)
  if (/\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawHeaderBlock)) return null
  const headerBlock = rawHeaderBlock.replace(/\r?\n[ \t]+/g, ' ')
  const headers = headerBlock.split(/\r?\n/)
  const dispositions = []
  for (const header of headers) {
    const colon = header.indexOf(':')
    if (colon < 1 || !/^[A-Za-z0-9-]+$/.test(header.slice(0, colon).trim())) return null
    if (header.slice(0, colon).trim().toLowerCase() === 'content-disposition') {
      dispositions.push(header.slice(colon + 1).trim())
    }
  }
  if (dispositions.length !== 1) return null
  const parameters = dispositions[0].split(';')
  if (parameters.shift()?.trim().toLowerCase() !== 'form-data') return null
  const names = []
  for (const rawParameter of parameters) {
    const parameter = rawParameter.match(/^\s*([A-Za-z0-9_*.-]+)\s*=\s*(.+?)\s*$/)
    if (!parameter) return null
    const key = parameter[1].toLowerCase()
    if (/^name\*\d+\*?$/.test(key)) return null
    if (key !== 'name' && key !== 'name*') continue
    const parameterValue = multipartParameterValue(parameter[2])
    if (parameterValue == null) return null
    if (key === 'name*') {
      const encoded = parameterValue.match(/^utf-8'[^']*'(.*)$/i)?.[1]
      if (encoded == null) return null
      try {
        names.push(decodeURIComponent(encoded))
      } catch {
        return null
      }
    } else {
      names.push(parameterValue)
    }
  }
  if (names.length !== 1) return null
  const name = String(names[0]).normalize('NFC')
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) return null
  return { name, value: part.slice(separator.index + separator[0].length) }
}

export function parseStrictMultipartFormData(rawText, headers) {
  const text = String(rawText || '')
  const bodyLooksMultipart = /content-disposition\s*:\s*form-data\b/i.test(text)
  const boundary = multipartBoundary(headers, bodyLooksMultipart)
  if (boundary == null) return null
  if (typeof boundary !== 'string') return boundary
  const delimiter = `--${boundary}`
  let current = multipartDelimiter(text, delimiter)
  if (!current || current.index !== 0 || current.closing) return invalidMultipart()
  const entries = []
  while (current && !current.closing) {
    const partStart = current.after + current.newlineLength
    const next = multipartDelimiter(text, delimiter, partStart)
    if (!next) return invalidMultipart()
    let partEnd = next.index
    if (text.slice(Math.max(partStart, partEnd - 2), partEnd) === '\r\n') partEnd -= 2
    else if (text[partEnd - 1] === '\n') partEnd -= 1
    else return invalidMultipart()
    const entry = multipartPart(text.slice(partStart, partEnd))
    if (!entry) return invalidMultipart()
    entries.push(entry)
    current = next
  }
  if (!current?.closing || entries.length === 0) return invalidMultipart()
  const epilogue = text.slice(current.after + 2)
  if (!/^\s*$/.test(epilogue)) return invalidMultipart()
  return Object.freeze({ detected: true, valid: true, entries: Object.freeze(entries) })
}

function multipartRouteEntries(rawText, headers) {
  const uninspectable = () => ({
    name: UNINSPECTABLE_MULTIPART_FIELD,
    value: '',
    origin: 'multipart-body',
  })
  const parsed = parseStrictMultipartFormData(rawText, headers)
  if (!parsed) return []
  if (!parsed.valid) return [uninspectable()]
  return parsed.entries.map(({ name, value }) => ({
      name: String(name).normalize('NFC').toLowerCase(),
      value: String(value).normalize('NFC').trim(),
      origin: 'multipart-body',
  }))
}

function readQuotedStringToken(text, start) {
  const quote = text[start]
  if (quote !== '"' && quote !== "'") return null
  let decoded = ''
  let index = start + 1
  while (index < text.length) {
    if (text[index] === '\\') {
      const escaped = text[index + 1]
      if (escaped == null) return null
      if (escaped === 'u' && /^[a-f0-9]{4}$/i.test(text.slice(index + 2, index + 6))) {
        decoded += String.fromCharCode(Number.parseInt(text.slice(index + 2, index + 6), 16))
        index += 6
        continue
      }
      const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      decoded += escapes[escaped] ?? escaped
      index += 2
      continue
    }
    if (text[index] === quote) {
      const end = index + 1
      return { value: decoded, end }
    }
    if (/[\r\n]/.test(text[index])) return null
    decoded += text[index]
    index += 1
  }
  return null
}

function isEscapedCharacter(text, index) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

export function parseLooseJsonFragmentEntries(rawText) {
  const text = String(rawText || '')
  const entries = []
  const invalid = () => [{
    name: UNINSPECTABLE_JSON_FRAGMENT_FIELD,
    value: '',
    origin: 'json-fragment',
  }]
  for (let index = 0; index < text.length;) {
    let key
    if (['"', "'"].includes(text[index]) && !isEscapedCharacter(text, index)) {
      key = readQuotedStringToken(text, index)
    } else if (/[A-Za-z_]/.test(text[index] || '')
      && (index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1]))) {
      const token = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
      key = token ? { value: token, end: index + token.length } : null
    }
    if (!key) { index += 1; continue }
    const normalizedKey = String(key.value).normalize('NFC').toLowerCase()
    let cursor = key.end
    while (/\s/.test(text[cursor] || '')) cursor += 1
    if (text[cursor] !== ':') {
      const beforeSeparator = text.slice(cursor).split(/[,\r\n]/, 1)[0]
      if (ROUTE_CRITICAL_FIELD_NAMES.has(normalizedKey) && beforeSeparator.includes(':')) return invalid()
      index = key.end
      continue
    }
    cursor += 1
    while (/\s/.test(text[cursor] || '')) cursor += 1
    if (cursor >= text.length || /[,\r\n]/.test(text[cursor])) {
      if (ROUTE_CRITICAL_FIELD_NAMES.has(normalizedKey)) return invalid()
      index = Math.max(cursor + 1, key.end)
      continue
    }
    let value = ''
    let end = cursor
    if (['"', "'"].includes(text[cursor]) && !isEscapedCharacter(text, cursor)) {
      const token = readQuotedStringToken(text, cursor)
      if (!token) {
        if (ROUTE_CRITICAL_FIELD_NAMES.has(normalizedKey)) return invalid()
        index = key.end
        continue
      }
      value = token.value
      end = token.end
    } else {
      while (end < text.length && !/[,\r\n]/.test(text[end])) end += 1
      value = text.slice(cursor, end).trim()
    }
    entries.push({
      name: normalizedKey,
      value: String(value).normalize('NFC').trim(),
      origin: 'json-fragment',
    })
    index = Math.max(end, key.end)
  }
  return entries
}

function looseJsonFragmentEntries(rawText) {
  const text = String(rawText || '').trim()
  if (!text || /^\s*[\[{]/.test(text) || !text.includes(':')) return []
  try {
    const wrapped = parseJsonRejectDuplicateKeys(`{${text}}`)
    return routeFieldEntries(wrapped, 'json-fragment')
  } catch {
    // Continue with a field-boundary scan for a prefixed or tailed fragment.
  }
  return parseLooseJsonFragmentEntries(text)
}

function endpointTokens(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''), 'https://capture.invalid')
    const pathname = decodeURIComponent(url.pathname).normalize('NFC').toLowerCase()
    return new Set(pathname.split(/[\/._-]+/).filter(Boolean))
  } catch {
    return new Set()
  }
}

function verifiedStaticAssetRequest(record) {
  const method = String(record.method || '').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  try {
    const url = new URL(String(record.url || ''), 'https://capture.invalid')
    const pathname = decodeURIComponent(url.pathname).normalize('NFC').toLowerCase()
    const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1] || ''
    return STATIC_ASSET_RESOURCE_TYPES.get(extension)?.has(
      String(record.resourceType || '').toLowerCase(),
    ) === true
  } catch {
    return false
  }
}

function routeSignals(rawUrl, query, body, extraEntries = []) {
  const entries = [
    ...routeFieldEntries(query, 'query'),
    ...routeFieldEntries(body, 'body'),
    ...extraEntries,
  ]
  const criticalCounts = new Map()
  for (const entry of entries) {
    if (!ROUTE_CRITICAL_FIELD_NAMES.has(entry.name)) continue
    criticalCounts.set(entry.name, (criticalCounts.get(entry.name) || 0) + 1)
  }
  const ambiguous = [...criticalCounts.values()].some((count) => count > 1)
  const operations = entries.filter((entry) => ROUTE_OPERATION_FIELDS.has(entry.name))
  const operationValues = operations.map(({ value }) => value.toLowerCase())
  const hasSubmitOperationField = entries.some(({ name }) => SUBMIT_OPERATION_VALUES.has(name))
  const tokens = endpointTokens(rawUrl)
  const hasMoney = entries.some(({ name }) => MONEY_FIELD_NAMES.has(name))
  const hasOrderField = entries.some(({ name }) => ORDER_FIELD_NAMES.has(name))
  const hasOrderEndpoint = [...tokens].some((token) => ORDER_ENDPOINT_TOKENS.has(token))
  const hasSubmitEndpoint = [...tokens].some((token) => SUBMIT_ENDPOINT_TOKENS.has(token))
  const hasPreviewEndpoint = [...tokens].some((token) => PREVIEW_ENDPOINT_TOKENS.has(token))
  const explicitSubmit = operationValues.some((value) => (
    SUBMIT_OPERATION_VALUES.has(value) || /^[a-z]{2,5}_bet$/.test(value)
  )) || hasSubmitOperationField
  const explicitPreview = operationValues.some((value) => PREVIEW_OPERATION_VALUES.has(value))
  return {
    uninspectableMultipart: entries.some(({ name }) => name === UNINSPECTABLE_MULTIPART_FIELD),
    uninspectableJsonFragment: entries.some(({ name }) => name === UNINSPECTABLE_JSON_FRAGMENT_FIELD),
    ambiguous,
    hasRouteFields: entries.some(({ name }) => ROUTE_CRITICAL_FIELD_NAMES.has(name)),
    exactFtBet: operations.some(({ name, value }) => name === 'p' && value === 'FT_bet'),
    explicitSubmit,
    explicitPreview,
    submitLike: (explicitSubmit || hasSubmitEndpoint) && (hasMoney || hasOrderField || hasOrderEndpoint),
    previewLike: (explicitPreview || hasPreviewEndpoint) && (hasMoney || hasOrderField || hasOrderEndpoint),
    orderLike: hasOrderEndpoint || hasSubmitEndpoint
      || (hasMoney && hasOrderField)
      || (hasOrderEndpoint && (hasMoney || hasOrderField))
      || (explicitSubmit && (hasMoney || hasOrderField)),
  }
}

function verifiedMonitorFields(operation, query, body) {
  const allowlist = EXACT_MONITOR_REQUEST_FIELDS[operation]
  if (!allowlist) return false
  const seen = new Set()
  for (const source of [query, body]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [field, value] of Object.entries(source)) {
      if (!allowlist.has(field) || seen.has(field)) return false
      if (Array.isArray(value) || (value && typeof value === 'object')) return false
      seen.add(field)
    }
  }
  return seen.has('p')
}

export function classifyProtocolRecord(record) {
  const method = String(record.method || '').toUpperCase()
  const url = String(record.url || '')
  const rawPostData = record.postData || ''
  const rawPostText = typeof rawPostData === 'string' ? rawPostData : ''
  if (/^\s*[\[{]/.test(rawPostText)) {
    try {
      parseJsonRejectDuplicateKeys(rawPostText)
    } catch (error) {
      return error?.code === 'DUPLICATE_JSON_KEY'
        ? { stage: 'submit', confidence: 'high', reasons: ['ambiguous raw JSON fields'] }
        : {
            stage: 'candidate',
            confidence: 'low',
            reasons: ['uninspectable JSON body'],
            ...(method === 'POST' ? { routeRisk: 'order-like-post' } : {}),
          }
    }
  }
  const body = parseBody(rawPostData)
  const query = queryFields(url)
  const operations = [...fieldValues(query, 'p'), ...fieldValues(body, 'p')]
  const rawRouteEntries = [
    ...multipartRouteEntries(rawPostText, record.headers),
    ...looseJsonFragmentEntries(rawPostText),
  ]
  const signals = routeSignals(url, query, body, rawRouteEntries)
  const staticAsset = verifiedStaticAssetRequest(record)
  const bodyText = flatten(body).join('\n')
  const queryText = flatten(query).join('\n')
  const blob = `${method}\n${url}\n${queryText}\n${bodyText}`
  const reasons = []
  const candidate = (reason) => ({
    stage: 'candidate',
    confidence: 'low',
    reasons: [reason],
    ...(signals.orderLike ? {
      routeRisk: method === 'POST' ? 'order-like-post' : 'order-like-route',
    } : {}),
  })

  if (signals.uninspectableMultipart || signals.uninspectableJsonFragment) {
    return {
      stage: 'candidate',
      confidence: 'low',
      reasons: [signals.uninspectableMultipart
        ? 'uninspectable multipart body'
        : 'uninspectable JSON fragment'],
      routeRisk: method === 'POST' ? 'order-like-post' : 'order-like-route',
    }
  }

  if (/^websocket-(?:open|send|receive|error|close)$/.test(String(record.type || ''))) {
    return { stage: 'candidate', confidence: 'low', reasons: ['websocket lifecycle'] }
  }

  // Ambiguous operations are never eligible for a read-only allowlist. Treating
  // them as Submit is the only fail-closed result when one value may be FT_bet.
  if (signals.ambiguous) {
    return {
      stage: 'submit',
      confidence: 'high',
      reasons: [
        'ambiguous route-critical field',
        ...(signals.exactFtBet ? ['exact p=FT_bet'] : []),
      ],
    }
  }

  if (signals.exactFtBet) {
    return { stage: 'submit', confidence: 'high', reasons: ['exact p=FT_bet'] }
  }

  // Submit heuristics must precede every method and monitor allowlist. Crown can
  // transport a Submit in a query string or alongside a misleading monitor p.
  if (signals.submitLike) {
    reasons.push('exact submit operation or endpoint token')
    reasons.push('exact money or order field')
    return { stage: 'submit', confidence: 'high', reasons }
  }

  if (method === 'POST' && operations[0] === 'FT_order_view') {
    if (!exactFieldSet(body, EXACT_PREVIEW_REQUEST_FIELDS)) {
      return candidate('preview request field-set drift')
    }
    return {
      stage: 'preview',
      confidence: 'high',
      reasons: ['exact captured preview request field set'],
      requestFieldSet: [...EXACT_PREVIEW_REQUEST_FIELDS],
      requestFieldSetFingerprint: fieldSetFingerprint(EXACT_PREVIEW_REQUEST_FIELDS),
    }
  }

  if (EXACT_MONITOR_OPERATIONS.has(operations[0])) {
    if (method !== 'POST') {
      return candidate('monitor request method drift')
    }
    if (!verifiedMonitorFields(operations[0], query, body)) {
      return candidate('monitor request field-set drift')
    }
    return { stage: 'monitor', confidence: 'high', reasons: ['known read-only monitor endpoint'] }
  }

  if (MONITOR_RE.test(blob)) {
    return candidate('monitor-like keyword without verified field set')
  }

  if (method === 'POST' && signals.previewLike) {
    reasons.push('exact preview operation or endpoint token')
    reasons.push('order-like post parameter')
    return { stage: 'preview', confidence: 'medium', reasons }
  }

  if (signals.orderLike && staticAsset && !signals.hasRouteFields) {
    return { stage: 'unknown', confidence: 'low', reasons: [] }
  }

  if (signals.orderLike) {
    return candidate(method === 'POST' ? 'order-like post parameter' : 'order-like route parameter')
  }

  return { stage: 'unknown', confidence: 'low', reasons: [] }
}

export function classifyProtocolWebSocketFrame({ url, payload } = {}) {
  if (typeof payload !== 'string' || payload.length === 0) {
    return { stage: 'unknown', confidence: 'low', reasons: ['uninspectable websocket frame'] }
  }
  const parsed = parseBody(payload)
  if (!parsed || typeof parsed !== 'object') {
    return { stage: 'unknown', confidence: 'low', reasons: ['uninspectable websocket frame'] }
  }
  let frameUrl
  try {
    const parsedUrl = new URL(String(url || ''))
    parsedUrl.search = ''
    parsedUrl.hash = ''
    frameUrl = parsedUrl.toString()
  } catch {
    return { stage: 'unknown', confidence: 'low', reasons: ['websocket URL unavailable'] }
  }
  return classifyProtocolRecord({
    type: 'request', method: 'POST', url: frameUrl, postData: payload,
  })
}

export function shouldBlockProtocolRequest(record, { allowRealSubmit = false } = {}) {
  const classification = classifyProtocolRecord(record)
  if (classification.stage === 'submit') {
    if (allowRealSubmit) return { block: false, classification }
    return {
      block: true,
      reason: 'real-submit-disabled',
      classification,
    }
  }
  if (classification.stage === 'candidate' && classification.routeRisk === 'order-like-post') {
    return {
      block: true,
      reason: 'unverified-post-candidate',
      classification,
    }
  }
  if (classification.stage === 'candidate' && classification.routeRisk === 'order-like-route') {
    return {
      block: true,
      reason: 'unverified-order-route',
      classification,
    }
  }
  return { block: false, classification }
}
