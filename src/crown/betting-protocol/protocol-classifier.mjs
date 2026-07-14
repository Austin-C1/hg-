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
  'ft_bet',
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
const PREVIEW_ENDPOINT_TOKENS = new Set(['preview', 'order_view', 'bet_view', 'betslip'])
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

function flatten(value, prefix = '', output = []) {
  if (value == null) return output
  if (Array.isArray(value)) {
    output.push(`${prefix}[]`)
    value.slice(0, 10).forEach((item) => flatten(item, `${prefix}[]`, output))
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output)
    }
    return output
  }
  output.push(`${prefix}=${String(value).slice(0, 80)}`)
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
  if (!source || typeof source !== 'object') return output
  if (Array.isArray(source)) {
    for (const value of source) {
      if (value && typeof value === 'object') routeFieldEntries(value, origin, output, inheritedName)
      else if (inheritedName) {
        output.push({
          name: inheritedName,
          value: String(value ?? '').normalize('NFC').trim(),
          origin,
        })
      }
    }
    return output
  }
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName).normalize('NFC').toLowerCase()
    if (rawValue && typeof rawValue === 'object') routeFieldEntries(rawValue, origin, output, name)
    else output.push({ name, value: String(rawValue ?? '').normalize('NFC').trim(), origin })
  }
  return output
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

function routeSignals(rawUrl, query, body) {
  const entries = [
    ...routeFieldEntries(query, 'query'),
    ...routeFieldEntries(body, 'body'),
  ]
  const criticalCounts = new Map()
  for (const entry of entries) {
    if (!ROUTE_CRITICAL_FIELD_NAMES.has(entry.name)) continue
    criticalCounts.set(entry.name, (criticalCounts.get(entry.name) || 0) + 1)
  }
  const ambiguous = [...criticalCounts.values()].some((count) => count > 1)
  const operations = entries.filter((entry) => ROUTE_OPERATION_FIELDS.has(entry.name))
  const operationValues = operations.map(({ value }) => value.toLowerCase())
  const tokens = endpointTokens(rawUrl)
  const hasMoney = entries.some(({ name }) => MONEY_FIELD_NAMES.has(name))
  const hasOrderField = entries.some(({ name }) => ORDER_FIELD_NAMES.has(name))
  const hasOrderEndpoint = [...tokens].some((token) => ORDER_ENDPOINT_TOKENS.has(token))
  const hasSubmitEndpoint = [...tokens].some((token) => SUBMIT_ENDPOINT_TOKENS.has(token))
  const hasPreviewEndpoint = [...tokens].some((token) => PREVIEW_ENDPOINT_TOKENS.has(token))
  const explicitSubmit = operationValues.some((value) => (
    SUBMIT_OPERATION_VALUES.has(value) || /^[a-z]{2,5}_bet$/.test(value)
  ))
  const explicitPreview = operationValues.some((value) => PREVIEW_OPERATION_VALUES.has(value))
  return {
    ambiguous,
    exactFtBet: operations.some(({ name, value }) => name === 'p' && value === 'FT_bet'),
    explicitSubmit,
    explicitPreview,
    submitLike: (explicitSubmit || hasSubmitEndpoint) && (hasMoney || hasOrderField || hasOrderEndpoint),
    previewLike: (explicitPreview || hasPreviewEndpoint) && (hasMoney || hasOrderField || hasOrderEndpoint),
    orderLike: (hasMoney && hasOrderField)
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
  const signals = routeSignals(url, query, body)
  const bodyText = flatten(body).join('\n')
  const queryText = flatten(query).join('\n')
  const blob = `${method}\n${url}\n${queryText}\n${bodyText}`
  const reasons = []
  const candidate = (reason) => ({
    stage: 'candidate',
    confidence: 'low',
    reasons: [reason],
    ...(method === 'POST' && signals.orderLike ? { routeRisk: 'order-like-post' } : {}),
  })

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

  if (method === 'POST' && signals.orderLike) {
    return candidate('order-like post parameter')
  }

  return { stage: 'unknown', confidence: 'low', reasons: [] }
}

export function classifyProtocolWebSocketFrame({ url, payload } = {}) {
  if (typeof payload !== 'string' || payload.length === 0) {
    return { stage: 'unknown', confidence: 'low', reasons: ['uninspectable websocket frame'] }
  }
  const parsed = parseBody(payload)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
  return { block: false, classification }
}
