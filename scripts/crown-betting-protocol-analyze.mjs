#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import {
  CROWN_BROWSER_TARGETS,
  classifyProtocolRecord,
  classifyProtocolWebSocketFrame,
} from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  assertSafeCrownProtocolEvidence,
  isCrownPublicEndpointPath,
  parseBody,
  parseJsonRejectDuplicateKeys,
  projectCrownProtocolShape,
  redactCapturedBody,
  redactHeaders,
  redactUrl,
} from '../src/crown/betting-protocol/capture-redaction.mjs'

const SENSITIVE_FIELD = /(?:secret|user(?:name)?|pass(?:word)?|pwd|token|cookie|session|uid|ticket|auth(?:orization)?|provider|reference)/i
const ALLOWED_TRANSPORT_FIELDS = new Set(['uid'])
const RECORD_TYPES = new Set(['request', 'response', 'request-blocked'])
const STAGES = new Set(['preview', 'submit', 'monitor', 'candidate', 'unknown'])
const METHODS = new Set(['GET', 'POST'])
const EXECUTION_CAPABILITY_FIELDS = Object.freeze(['mode', 'period', 'marketType', 'lineVariant'])
const WATCHER_EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion', 'captureId', 'capturedAt', 'auditId', 'batchId', 'gid', 'mode',
  'eventStatus', 'period', 'marketType', 'ratioField', 'line', 'side', 'oddsField',
  'odds', 'suspended',
])
const EXECUTION_WIRE_IDENTITY_FIELDS = Object.freeze(['gid', 'gtype', 'wtype', 'chose_team'])
const PREVIEW_REQUEST_FIELDS = Object.freeze([
  'chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'uid', 'ver', 'wtype',
])
const PREVIEW_RESPONSE_FIELDS = Object.freeze([
  'aid', 'code', 'con', 'currency', 'currency_value', 'dates', 'dg', 'fast_check',
  'game_sc', 'game_so', 'gold_gmax', 'gold_gmin', 'important', 'ioratio', 'league_id',
  'league_name', 'ltype', 'max_gold', 'maxcredit', 'mem_sc', 'mem_so', 'ms', 'num_c',
  'num_h', 'pay_type', 'ptype', 'ratio', 'restsinglecredit', 'spread', 'strong', 'systime',
  'team_id_c', 'team_id_h', 'team_name_c', 'team_name_h', 'times', 'ts', 'username',
])
const SUBMIT_REQUEST_FIELDS = Object.freeze([
  'autoOdd', 'chose_team', 'con', 'f', 'gid', 'golds', 'gtype', 'imp', 'ioratio',
  'isRB', 'isYesterday', 'langx', 'odd_f_type', 'p', 'ptype', 'ratio', 'rtype',
  'timestamp', 'timestamp2', 'uid', 'ver', 'wtype',
])
const SUBMIT_RESPONSE_FIELDS = Object.freeze([
  'ball_act', 'code', 'concede', 'date', 'dg_mode', 'gid', 'gold', 'gtype', 'imp',
  'ioratio', 'isyesterday', 'league', 'league_id', 'maxcredit', 'mid', 'ms', 'mtype',
  'nowcredit', 'ptype', 'ratio', 'rtype', 'spread', 'strong', 'systime', 'team_c',
  'team_h', 'team_id_c', 'team_id_h', 'time', 'timestamp', 'type', 'username', 'wtype',
])
const RESULT_REFERENCE_FIELDS = Object.freeze(['order_id', 'ticket', 'ticket_id', 'tid', 'w_id'])
const EXECUTION_SENSITIVE_FIELD = /(?:secret|user(?:name)?|pass(?:word)?|pwd|token|cookie|session|uid|ticket|auth(?:orization)?|csrf|xsrf|jwt|signature|sign|order[_-]?id|account|member|reference)/i
const HMAC_DOMAINS = Object.freeze({
  account: 'crown-execution-evidence/account/v1',
  session: 'crown-execution-evidence/session/v1',
  execution: 'crown-execution-evidence/execution/v1',
  result: 'crown-execution-evidence/result/v1',
  record: 'crown-execution-evidence/record/v1',
  watcher: 'crown-execution-evidence/watcher/v1',
})
const CATALOG_RECORD_TYPES = new Set([
  'request', 'response', 'requestfailed', 'redirect', 'route-decision', 'request-blocked',
  'websocket-open', 'websocket-send', 'websocket-receive', 'websocket-error', 'websocket-close',
  'websocket-route-decision',
  'market-unavailable',
])
const CATALOG_SENSITIVE_FIELD = /(?:secret|user(?:name)?|pass(?:word)?|pwd|token|cookie|session|uid|ticket|auth(?:orization)?|csrf|xsrf|jwt|signature|sign|order[_-]?id|account|member|provider|reference|\bmid\b|\btid\b|w_id)/i
const CATALOG_KNOWN_SENSITIVE_FIELDS = new Set([
  'secret', 'username', 'user', 'password', 'passwd', 'pwd', 'token', 'cookie',
  'session', 'uid', 'ticket', 'ticket_id', 'authorization', 'auth', 'csrf', 'xsrf',
  'jwt', 'signature', 'sign', 'order_id', 'account', 'member', 'provider', 'reference',
  'mid', 'tid', 'w_id', 'set-cookie',
])
const STATIC_WIRE_VALUE_ALLOWLIST = Object.freeze({
  FT_order_view: Object.freeze([{ field: 'p', value: 'FT_order_view' }]),
  FT_bet: Object.freeze([{ field: 'p', value: 'FT_bet' }]),
})
const CATALOG_PUBLIC_OUTPUTS = Object.freeze([
  'protocol-catalog.safe.json',
  'eight-direction-candidates.safe.json',
  'static-wire-evidence.safe.json',
])
const ANALYZER_PUBLIC_OUTPUTS = Object.freeze([
  'protocol-evidence.json',
  'protocol-summary.json',
  'protocol-map.md',
  ...CATALOG_PUBLIC_OUTPUTS,
])

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => (
    parseJsonRejectDuplicateKeys(line)
  ))
}

function executionFail(reason) {
  throw new Error(`crown-execution-evidence:${reason}`)
}

function stableJson(value) {
  return JSON.stringify(stable(value))
}

function canonicalText(value) {
  return String(value ?? '').normalize('NFC').trim()
}

function canonicalTuple(values) {
  const chunks = []
  for (const value of values) {
    const bytes = Buffer.from(String(value), 'utf8')
    if (bytes.length > 0xffffffff) executionFail('canonical-value-too-large')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    chunks.push(length, bytes)
  }
  return Buffer.concat(chunks)
}

function privateHmacKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8'))
  if (key.length < 32) executionFail('hmac-key-too-short')
  return key
}

function hmacBinding(key, domain, values) {
  const input = canonicalTuple([domain, ...values])
  return `hmac-sha256:${createHmac('sha256', key).update(input).digest('hex')}`
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDirectXml(value) {
  const text = String(value || '')
  if (!text || /\.\.\.\[truncated(?:\s+\d+\s+chars)?\]/i.test(text)) executionFail('body-truncated')
  const fields = xmlOpeningFields(text).filter((field) => field !== 'serverresponse')
  if (fields.length === 0) executionFail('response-body-unavailable')
  const duplicates = fields.filter((field, index) => fields.indexOf(field) !== index)
  if (duplicates.length) executionFail('duplicate-field')
  const values = {}
  for (const field of fields) {
    const pattern = new RegExp(`<${escapeRegExp(field)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(field)}>`, 'gi')
    const matches = [...text.matchAll(pattern)]
    if (matches.length !== 1 || /<[^>]+>/.test(matches[0][1])) executionFail('response-body-invalid')
    try {
      values[field] = decodeXml(matches[0][1]).trim()
    } catch {
      executionFail('response-body-invalid')
    }
  }
  return { fields, values }
}

function exactFieldSet(actual, expected) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  return left.length === right.length && left.every((field, index) => field === right[index])
}

function formEvidence(body, expectedFields, excludedFields, label = 'request') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) executionFail('request-body-unavailable')
  if (Object.values(body).some(Array.isArray)) executionFail('duplicate-field')
  const fields = Object.keys(body)
  const excluded = new Set(excludedFields)
  if (fields.some((field) => EXECUTION_SENSITIVE_FIELD.test(field) && !excluded.has(field))) {
    executionFail(`unknown-sensitive-field-${label}`)
  }
  if (!exactFieldSet(fields, expectedFields)) executionFail('critical-field-set')
  const fieldSet = fields.filter((field) => !excluded.has(field)).sort()
  return {
    fieldSet,
    fieldSetFingerprint: fingerprint(fieldSet),
    excludedSensitiveFieldCount: fields.length - fieldSet.length,
  }
}

function xmlEvidence(parsed, expectedFields, {
  excludedFields = [], optionalResult = false, label = 'response',
} = {}) {
  const resultFields = parsed.fields.filter((field) => RESULT_REFERENCE_FIELDS.includes(field))
  if (resultFields.length > 1) executionFail('critical-field-set')
  const excluded = new Set([...excludedFields, ...resultFields])
  const unknownSensitiveIndex = parsed.fields.findIndex((field) => (
    EXECUTION_SENSITIVE_FIELD.test(field) && !excluded.has(field)
  ))
  if (unknownSensitiveIndex >= 0) executionFail(`unknown-sensitive-field-${label}`)
  const expected = optionalResult ? [...expectedFields, ...resultFields] : [...expectedFields]
  if (!exactFieldSet(parsed.fields, expected)) executionFail('critical-field-set')
  const fieldSet = parsed.fields.filter((field) => !excluded.has(field)).sort()
  return {
    fieldSet,
    fieldSetFingerprint: fingerprint(fieldSet),
    excludedSensitiveFieldCount: parsed.fields.length - fieldSet.length,
    resultField: resultFields[0] || null,
  }
}

function parseJsonlBytes(bytes, reason) {
  try {
    return bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => (
      parseJsonRejectDuplicateKeys(line)
    ))
  } catch {
    executionFail(reason)
  }
}

function redactedProtocolRecord(record) {
  return {
    ...record,
    url: record.url ? redactUrl(record.url) : record.url,
    headers: redactHeaders(record.headers || {}),
    postData: record.postData ? redactCapturedBody(record.postData, record.headers) : undefined,
    responseBody: record.responseBody ? redactCapturedBody(record.responseBody, record.headers) : undefined,
  }
}

function readCapturePair(captureDir, { layout = 'modern', requireModernMetadata = false } = {}) {
  let rawBytes
  let redactedBytes
  try {
    rawBytes = fs.readFileSync(path.join(captureDir, 'private', 'raw-network.jsonl'))
    const privateRedacted = path.join(captureDir, 'private', 'redacted-network.jsonl')
    const legacyPublicRedacted = path.join(captureDir, 'public', 'redacted-network.jsonl')
    const redactedFile = layout === 'legacy' ? legacyPublicRedacted : privateRedacted
    redactedBytes = fs.readFileSync(redactedFile)
  } catch {
    if (layout === 'modern') catalogFail('modern-layout-incomplete')
    executionFail('capture-files-unavailable')
  }
  const rawRecords = parseJsonlBytes(rawBytes, 'raw-capture-invalid')
  const redactedRecords = parseJsonlBytes(redactedBytes, 'redacted-capture-invalid')
  if (layout === 'modern' && requireModernMetadata && (
    rawRecords.length === 0
    || redactedRecords.length === 0
    || !rawRecords.every(completeModernRecorderRecord)
    || !redactedRecords.every(completeModernRecorderRecord)
  )) catalogFail('modern-layout-incomplete')
  if (rawRecords.length === 0 || rawRecords.length !== redactedRecords.length) executionFail('redaction-pair-missing')
  for (let index = 0; index < rawRecords.length; index += 1) {
    const raw = rawRecords[index]
    const redacted = redactedRecords[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || stableJson(redactedProtocolRecord(raw)) !== stableJson(redacted)) {
      executionFail('redaction-pair-mismatch')
    }
  }
  return {
    rawBytes,
    rawRecords,
    redactedRecords,
    records: rawRecords.map((record, index) => ({ record, index })),
  }
}

function requestBody(entry) {
  return bodyObject(entry.record.postData)
}

function operationEntries(records, operation) {
  const output = []
  for (const entry of records) {
    if (!['request', 'request-blocked'].includes(entry.record.type)) continue
    const body = requestBody(entry)
    if (Array.isArray(body.p) && body.p.map(String).includes(operation)) executionFail('duplicate-field')
    if (body.p === operation) output.push({ ...entry, body })
  }
  return output
}

function pairedResponse(records, request, { mustFinishBefore = Number.POSITIVE_INFINITY, optional = false } = {}) {
  if (!Number.isSafeInteger(request.record.seq) || request.record.seq < 1) executionFail('record-sequence')
  const matches = records.filter((entry) => (
    entry.record.type === 'response' && entry.record.seq === request.record.seq
  ))
  if (matches.length !== 1) {
    if (optional && matches.length === 0) return null
    executionFail('record-sequence')
  }
  const [response] = matches
  if (response.index <= request.index || response.index >= mustFinishBefore) executionFail('record-sequence')
  return response
}

function cookieHeader(headers) {
  const matches = Object.entries(headers || {}).filter(([name]) => String(name).toLowerCase() === 'cookie')
  if (matches.length !== 1 || typeof matches[0][1] !== 'string' || !matches[0][1]) {
    executionFail('session-binding-unavailable')
  }
  return matches[0][1]
}

function canonicalCookies(value) {
  const pairs = []
  const names = new Set()
  for (const segment of String(value).split(';')) {
    const separator = segment.indexOf('=')
    if (separator < 1) executionFail('session-binding-unavailable')
    const name = segment.slice(0, separator).trim()
    const child = segment.slice(separator + 1)
    if (!name || names.has(name)) executionFail('session-binding-unavailable')
    names.add(name)
    pairs.push([name, child])
  }
  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => (
    leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
  ))
  return pairs
}

function normalizedCurrency(value) {
  const raw = String(value || '').trim()
  if (raw === 'RMB') return 'CNY'
  return /^[A-Z]{3}$/.test(raw) ? raw : ''
}

function readWatcherEvidence(captureDir) {
  const file = path.join(captureDir, 'public', 'watcher-execution-evidence.json')
  if (!fs.existsSync(file)) executionFail('watcher-evidence-unavailable')
  let evidence
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { executionFail('watcher-evidence-unavailable') }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || !exactFieldSet(Object.keys(evidence), WATCHER_EVIDENCE_FIELDS)
    || evidence.schemaVersion !== 'crown-watcher-execution-evidence-v1'
    || evidence.captureId !== path.basename(path.resolve(captureDir))
    || new Date(evidence.capturedAt).toISOString() !== evidence.capturedAt
    || !/^snapshot:[a-f0-9]{64}$/.test(evidence.auditId)
    || !/^[a-f0-9]{64}$/.test(evidence.batchId)
    || typeof evidence.suspended !== 'boolean') executionFail('watcher-evidence-unavailable')
  return evidence
}

function canonicalDecimal(value) {
  const text = canonicalText(value)
  if (!/^\d+(?:\.\d+)?$/.test(text)) executionFail('watcher-evidence-execution-drift')
  const [whole, fraction = ''] = text.split('.')
  const normalizedFraction = fraction.replace(/0+$/, '')
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole
}

function derivedCapability(submit, watcher) {
  const sideCode = watcher.side === 'home' ? 'H' : watcher.side === 'away' ? 'C' : ''
  const exactPrematch = watcher.mode === 'prematch'
    && watcher.eventStatus === 'not_started'
    && watcher.period === 'full_time'
    && watcher.marketType === 'asian_handicap'
    && watcher.ratioField === 'RATIO_R'
    && watcher.oddsField === (watcher.side === 'home' ? 'IOR_RH' : 'IOR_RC')
    && submit.isRB === 'N' && submit.gtype === 'FT' && submit.wtype === 'R'
    && submit.rtype === `R${sideCode}` && submit.chose_team === sideCode && submit.f === '1R'
  const exactLive = watcher.mode === 'live'
    && watcher.eventStatus === 'live'
    && watcher.period === 'full_time'
    && watcher.marketType === 'asian_handicap'
    && watcher.ratioField === 'RATIO_RE'
    && watcher.oddsField === (watcher.side === 'home' ? 'IOR_REH' : 'IOR_REC')
    && submit.isRB === 'Y' && submit.gtype === 'FT' && submit.wtype === 'RE'
    && submit.rtype === `RE${sideCode}` && submit.chose_team === sideCode && submit.f === ''
  if ((!exactPrematch && !exactLive) || watcher.suspended) executionFail('watcher-evidence-mapping-drift')
  return {
    mode: watcher.mode,
    period: watcher.period,
    marketType: watcher.marketType,
    lineVariant: 'main',
  }
}

function endpointKind(record) {
  try {
    const pathname = new URL(record.url, 'https://relative.invalid').pathname
    if (pathname === '/transform.php') return 'transform'
    if (pathname === '/transform_nl.php') return 'transform_nl'
    return 'other'
  } catch {
    return 'other'
  }
}

function bodyObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const output = {}
    for (const [key, child] of new URLSearchParams(String(value || '')).entries()) {
      if (!Object.hasOwn(output, key)) output[key] = child
      else if (Array.isArray(output[key])) output[key].push(child)
      else output[key] = [output[key], child]
    }
    return output
  } catch { return {} }
}

function safeStructureBodyObject(value) {
  const strictJson = catalogJsonPayload(value)
  if (strictJson.isJson) {
    return strictJson.value && typeof strictJson.value === 'object' && !Array.isArray(strictJson.value)
      ? strictJson.value
      : {}
  }
  const parsed = parseBody(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  return {}
}

function safeFieldName(field) {
  const text = String(field)
  return !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(text)
    || /^\d+$/.test(text)
    || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(text)
    || /\d{4,}/.test(text)
    ? '[*]'
    : text
}

function safeFieldSet(fields, { envelope = '' } = {}) {
  return [...new Set(fields.map(String).filter((field) => (
    field && field !== envelope && !SENSITIVE_FIELD.test(field)
  )).map(safeFieldName))].sort()
}

function xmlOpeningFields(value) {
  return [...String(value || '').matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>/g)].map((match) => match[1])
}

function responseFieldSafety(value) {
  catalogJsonPayload(value)
  const fields = xmlOpeningFields(value).filter((field) => field !== 'serverresponse')
  return {
    fields,
    valid: !fields.some((field) => SENSITIVE_FIELD.test(field))
      && new Set(fields).size === fields.length,
  }
}

function safeResponseCode(value) {
  const code = String(value || '').match(/<code\b[^>]*>([^<]*)<\/code>/i)?.[1]?.trim() || ''
  return code === '501' ? code : null
}

function normalizedLine(value) {
  return String(value || '').trim().replace(/\s*\/\s*/g, ' / ')
}

function linkageTagFor(records, context, key) {
  if (!context || !key || Buffer.byteLength(key) < 32) return null
  const expected = {
    event: String(context.event || '').trim(),
    line: normalizedLine(context.line),
    side: String(context.side || '').trim().toLowerCase(),
    stake: String(context.stake || '').trim(),
  }
  if (
    !expected.event
    || !expected.line
    || !['home', 'away', 'over', 'under'].includes(expected.side)
    || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(expected.stake)
    || Number(expected.stake) <= 0
  ) return null
  const requests = records.filter((record) => record.type === 'request')
  const responses = records.filter((record) => record.type === 'response')
  if (records.length !== 2 || requests.length !== 1 || responses.length !== 1) return null
  const [request] = requests
  const [response] = responses
  const classification = classifyProtocolRecord(request)
  if (classification.stage !== 'preview' || classification.confidence !== 'high') return null
  const body = bodyObject(request.postData)
  if (Object.values(body).some(Array.isArray)) return null
  if (String(body.p || '') !== 'FT_order_view' || String(body.gid || '').trim() !== expected.event) return null
  const sideCode = { home: 'H', away: 'C', over: 'H', under: 'C' }[expected.side]
  if (String(body.chose_team || '').trim() !== sideCode) return null
  const responseSafety = responseFieldSafety(response.responseBody)
  if (!responseSafety.valid) return null
  const spreads = [...String(response.responseBody || '').matchAll(/<spread\b[^>]*>([^<]*)<\/spread>/gi)]
  if (spreads.length !== 1 || normalizedLine(spreads[0][1]) !== expected.line) return null
  if (safeResponseCode(response.responseBody) !== '501') return null
  const payload = JSON.stringify(expected)
  return `hmac-sha256:${createHmac('sha256', key).update(payload).digest('hex')}`
}

function catalogFail(reason) {
  throw new Error(`crown-protocol-catalog:${reason}`)
}

function catalogHmacKey(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value ?? ''), 'utf8'))
  if (key.length < 32) catalogFail('hmac-key-too-short')
  return key
}

function catalogBinding(key, domain, value) {
  const hmac = createHmac('sha256', key)
  hmac.update(String(domain), 'utf8')
  hmac.update(Buffer.from([0]))
  hmac.update(stableJson(value), 'utf8')
  return `hmac-sha256:${hmac.digest('hex')}`
}

function catalogEndpointDescriptor(rawUrl, key) {
  let pathname
  try {
    pathname = new URL(String(rawUrl || ''), 'https://relative.invalid').pathname
    if (!/^\/(?:[^?#\s]*)$/.test(pathname) || pathname.includes('..')) catalogFail('unsafe-endpoint-path')
  } catch (error) {
    if (String(error?.message || '').startsWith('crown-protocol-catalog:')) throw error
    catalogFail('unsafe-endpoint-path')
  }
  const normalized = pathname || '/'
  const segments = normalized.split('/').filter(Boolean)
  const extension = path.posix.extname(normalized).slice(1).toLowerCase()
  const extensionClass = ['php', 'json', 'xml', 'html'].includes(extension)
    ? extension
    : (extension ? 'other' : 'none')
  return {
    endpointPath: isCrownPublicEndpointPath(normalized) ? normalized : '/[redacted]',
    endpointPathAllowlisted: isCrownPublicEndpointPath(normalized),
    endpointShape: { segmentCount: segments.length, extensionClass },
    endpointPathBinding: catalogBinding(key, 'crown-protocol-catalog/endpoint-path/v1', [normalized]),
  }
}

function catalogParams(value) {
  const output = {}
  for (const [field, child] of new URLSearchParams(String(value || '')).entries()) {
    if (Object.hasOwn(output, field)) catalogFail('duplicate-field')
    output[field] = child
  }
  return output
}

function catalogCheckFields(value) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const child of value) catalogCheckFields(child)
    return
  }
  for (const [field, child] of Object.entries(value)) {
    if (CATALOG_SENSITIVE_FIELD.test(field) && !CATALOG_KNOWN_SENSITIVE_FIELDS.has(field.toLowerCase())) {
      catalogFail('unknown-sensitive-field')
    }
    catalogCheckFields(child)
  }
}

function catalogXmlValues(value) {
  const text = String(value || '')
  const matches = [...text.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1>/g)]
  if (!matches.length) return null
  const output = {}
  for (const match of matches) {
    const field = match[1]
    if (field === 'serverresponse') continue
    const child = decodeXml(match[2]).trim()
    if (!Object.hasOwn(output, field)) output[field] = child
    else if (Array.isArray(output[field])) output[field].push(child)
    else output[field] = [output[field], child]
  }
  catalogCheckFields(output)
  return output
}

function catalogJsonPayload(value) {
  if (typeof value !== 'string') return { isJson: false, value: null }
  const text = String(value)
  try {
    return { isJson: true, value: parseJsonRejectDuplicateKeys(text) }
  } catch (error) {
    if (error?.code === 'DUPLICATE_JSON_KEY') catalogFail('duplicate-field')
    if (/^\s*[\[{]/.test(text)) catalogFail('json-invalid')
    return { isJson: false, value: null }
  }
}

function catalogPayload(value) {
  if (value === undefined || value === null || value === '') return {}
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value)
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value
    catalogCheckFields(value)
    return value
  }
  const text = String(value)
  if (/^\s*</.test(text)) return catalogXmlValues(text) || text
  const strictJson = catalogJsonPayload(text)
  if (strictJson.isJson) {
    catalogCheckFields(strictJson.value)
    return strictJson.value
  }
  if (/[=&]/.test(text)) {
    const parsed = catalogParams(text)
    catalogCheckFields(parsed)
    return parsed
  }
  return text
}

function catalogRequestPayload(record) {
  let requestUrl
  try {
    requestUrl = new URL(String(record.url || ''), 'https://relative.invalid')
  } catch {
    catalogFail('unsafe-request-url')
  }
  const query = catalogParams(requestUrl.search)
  const body = catalogPayload(record.postData)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
    return Object.keys(query).length ? query : body
  }
  for (const field of Object.keys(body)) {
    if (Object.hasOwn(query, field)) catalogFail('duplicate-field')
  }
  const merged = { ...query, ...body }
  catalogCheckFields(merged)
  return merged
}

function catalogFunctionName(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload.p
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    catalogFail('unsafe-function-name')
  }
  return value
}

function catalogTransport(record) {
  const raw = String(record.resourceType || '').toLowerCase()
  if (String(record.method || '').toUpperCase() === 'POST' && raw === 'document') return 'form'
  if (['xhr', 'fetch', 'document'].includes(raw)) return raw
  return raw && /^[a-z-]{1,32}$/.test(raw) ? raw : 'other'
}

function catalogStatusClass(status) {
  if (!Number.isInteger(status)) return 'none'
  if (status >= 200 && status < 300) return 'success'
  if (status >= 300 && status < 400) return 'redirect'
  if (status >= 400 && status < 500) return 'client-error'
  if (status >= 500 && status < 600) return 'server-error'
  return 'other'
}

function catalogRecordRun(record, captureId) {
  const run = String(record.captureRunId || captureId || '').trim()
  if (!run) catalogFail('run-id-unavailable')
  return run
}

function rawWebSocketRouteClassification(decision) {
  if (decision.source === 'url') {
    return classifyProtocolRecord({
      type: 'request', method: 'GET', url: decision.url, postData: '',
    })
  }
  if (decision.source !== 'frame') return null
  if (decision.payloadKind === 'binary') {
    if (decision.postData !== undefined) return null
    return classifyProtocolWebSocketFrame({ url: decision.url, payload: null })
  }
  if (decision.payloadKind !== 'text' || typeof decision.postData !== 'string') return null
  return classifyProtocolWebSocketFrame({
    url: decision.url, payload: decision.postData,
  })
}

function validatedWebSocketRouteClassification(decision) {
  const continued = decision.decision === 'continued'
  const blocked = decision.decision === 'blocked'
  if ((!continued && !blocked)
    || decision.dispatchCount !== (continued ? 1 : 0)
    || !['url', 'frame'].includes(decision.source)
    || typeof decision.url !== 'string'
    || !decision.url) return null

  const classification = rawWebSocketRouteClassification(decision)
  if (!classification) return null
  if (decision.source === 'url') {
    return classification.stage === 'submit' && blocked && decision.dispatchCount === 0
      ? classification
      : null
  }

  if (decision.classification?.stage !== classification.stage) return null
  const stage = classification?.stage
  if (!STAGES.has(stage)) return null
  if (decision.payloadKind === 'binary') {
    return blocked && stage === 'unknown' && decision.dispatchCount === 0
      ? classification
      : null
  }
  if (['monitor', 'preview'].includes(stage)) {
    return continued && decision.dispatchCount === 1 ? classification : null
  }
  return blocked && decision.dispatchCount === 0 ? classification : null
}

function catalogValidatedGroups(records, captureId) {
  if (!Array.isArray(records)) catalogFail('records-invalid')
  const ordinalsByRun = new Map()
  const recordsByRun = new Map()
  const groups = new Map()
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) catalogFail('record-invalid')
    if (!CATALOG_RECORD_TYPES.has(String(record.type || ''))) catalogFail('record-type-unsupported')
    const run = catalogRecordRun(record, captureId)
    if (!Number.isSafeInteger(record.eventOrdinal) || record.eventOrdinal < 1) catalogFail('event-ordinal-invalid')
    const ordinals = ordinalsByRun.get(run) || new Set()
    if (ordinals.has(record.eventOrdinal)) catalogFail('duplicate-event-ordinal')
    ordinals.add(record.eventOrdinal)
    ordinalsByRun.set(run, ordinals)
    const runRecords = recordsByRun.get(run) || []
    runRecords.push(record)
    recordsByRun.set(run, runRecords)
    if (!Number.isSafeInteger(record.seq) || record.seq < 1) catalogFail('sequence-invalid')
    const key = `${run}\u0000${record.seq}`
    const group = groups.get(key) || { run, seq: record.seq, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.records.sort((left, right) => left.eventOrdinal - right.eventOrdinal)
    const count = (type) => group.records.filter((record) => record.type === type).length
    if (count('request') > 1) catalogFail('duplicate-request')
    if (count('response') > 1) catalogFail('duplicate-response')
    if (count('route-decision') + count('request-blocked') > 1) catalogFail('duplicate-route-decision')
    if (count('websocket-open') > 1) catalogFail('duplicate-websocket-open')
    const httpLifecycle = group.records.some((record) => [
      'request', 'response', 'requestfailed', 'redirect', 'route-decision', 'request-blocked',
    ].includes(record.type))
    const socketLifecycle = group.records.some((record) => [
      'websocket-open', 'websocket-send', 'websocket-receive', 'websocket-error', 'websocket-close',
    ].includes(record.type))
    const websocketRouteDecision = group.records.some((record) => record.type === 'websocket-route-decision')
    if (httpLifecycle && socketLifecycle) catalogFail('transport-sequence-conflict')
    if (websocketRouteDecision && (httpLifecycle || socketLifecycle || group.records.length !== 1)) {
      catalogFail('transport-sequence-conflict')
    }
    if (websocketRouteDecision) {
      const [decision] = group.records
      const classification = validatedWebSocketRouteClassification(decision)
      if (!classification) catalogFail('websocket-route-decision-invalid')
      group.websocketRouteClassification = classification
    }
    if (httpLifecycle && count('request') !== 1) catalogFail('orphan-http-lifecycle')
    if (socketLifecycle && count('websocket-open') !== 1) catalogFail('orphan-websocket-lifecycle')
    if (httpLifecycle) {
      const request = group.records.find((record) => record.type === 'request')
      const routeDecision = group.records.find((record) => (
        ['route-decision', 'request-blocked'].includes(record.type)
      ))
      if (routeDecision?.type === 'route-decision') {
        const continued = routeDecision.decision === 'continued'
        const blocked = routeDecision.decision === 'blocked'
        if ((!continued && !blocked)
          || routeDecision.dispatchCount !== (continued ? 1 : 0)) {
          catalogFail('route-decision-invalid')
        }
      }
      if (routeDecision?.type === 'request-blocked'
        && ((routeDecision.decision && routeDecision.decision !== 'blocked')
          || (routeDecision.dispatchCount !== undefined && routeDecision.dispatchCount !== 0))) {
        catalogFail('route-decision-invalid')
      }
      for (const record of group.records) {
        if (record === request) continue
        if (record.eventOrdinal <= request.eventOrdinal) catalogFail('lifecycle-order')
        if (record.method && String(record.method).toUpperCase() !== String(request.method).toUpperCase()) {
          catalogFail('lifecycle-correlation')
        }
        if (record.url && String(record.url) !== String(request.url)) catalogFail('lifecycle-correlation')
        if (record.postData) {
          const requestPayload = catalogRequestPayload(request)
          const lifecyclePayload = catalogRequestPayload(record)
          if (catalogFunctionName(requestPayload) !== catalogFunctionName(lifecyclePayload)
            || stableJson(Object.keys(requestPayload || {}).sort()) !== stableJson(Object.keys(lifecyclePayload || {}).sort())) {
            catalogFail('lifecycle-correlation')
          }
        }
      }
    }
  }
  for (const runRecords of recordsByRun.values()) {
    const frameEvidence = websocketFrameEvidence(runRecords)
    if (frameEvidence.decisionInvalid || frameEvidence.correlationInvalid) {
      catalogFail('websocket-frame-evidence-invalid')
    }
  }
  return [...groups.values()].sort((left, right) => (
    left.records[0].eventOrdinal - right.records[0].eventOrdinal
  ))
}

function withoutBindings(value) {
  if (Array.isArray(value)) return value.map(withoutBindings)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !String(key).toLowerCase().endsWith('binding'))
      .map(([key, child]) => [key, withoutBindings(child)]))
  }
  return value
}

function catalogGroupEntry(group, key) {
  const lifecycle = group.records.map((record) => (
    record.type === 'request-blocked' ? 'route-decision' : record.type
  ))
  const open = group.records.find((record) => record.type === 'websocket-open')
  const websocketRouteDecision = group.records.find((record) => record.type === 'websocket-route-decision')
  if (websocketRouteDecision) {
    const classification = group.websocketRouteClassification
    return {
      ...catalogEndpointDescriptor(websocketRouteDecision.url, key),
      functionName: null,
      method: 'WEBSOCKET',
      transport: 'websocket',
      stage: STAGES.has(classification.stage) ? classification.stage : 'candidate',
      lifecycle: ['websocket-route-decision'],
      sequenceRelation: 'independent-route-decision',
      routeOutcome: websocketRouteDecision.decision === 'continued' ? 'continued' : 'blocked',
      dispatchCount: websocketRouteDecision.dispatchCount === 1 ? 1 : 0,
    }
  }
  if (open) {
    const frames = group.records
      .filter((record) => ['websocket-send', 'websocket-receive'].includes(record.type))
      .map((record) => {
        const rawFrame = record.payload?.type === 'Buffer'
          && Array.isArray(record.payload.data)
          && record.payload.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
          ? Buffer.from(record.payload.data)
          : record.payload
        const shape = projectCrownProtocolShape(rawFrame, {
          hmacKey: key, domain: `crown-protocol-catalog/websocket/${record.type}/v1`,
        })
        return {
          direction: record.type === 'websocket-send' ? 'send' : 'receive',
          valueType: shape.valueType,
          lengthBucket: shape.lengthBucket,
          frameBinding: shape.fullFieldSetBinding,
        }
      })
    return {
      ...catalogEndpointDescriptor(open.url, key),
      functionName: null,
      method: 'WEBSOCKET',
      transport: 'websocket',
      stage: 'candidate',
      lifecycle,
      sequenceRelation: 'same-run-seq',
      frames,
      terminalState: lifecycle.includes('websocket-error') ? 'error' : (lifecycle.includes('websocket-close') ? 'closed' : 'open'),
    }
  }

  const request = group.records.find((record) => record.type === 'request')
  const response = group.records.find((record) => record.type === 'response')
  const requestPayload = catalogRequestPayload(request)
  const responsePayload = catalogPayload(response?.responseBody)
  const classification = classifyProtocolRecord(request)
  const routeDecision = group.records.find((record) => (
    ['route-decision', 'request-blocked'].includes(record.type)
  ))
  return {
    ...catalogEndpointDescriptor(request.url, key),
    functionName: catalogFunctionName(requestPayload),
    method: /^[A-Z]{1,16}$/.test(String(request.method || '').toUpperCase())
      ? String(request.method).toUpperCase() : 'OTHER',
    transport: catalogTransport(request),
    stage: STAGES.has(classification.stage) ? classification.stage : 'unknown',
    lifecycle,
    sequenceRelation: 'same-run-seq',
    routeOutcome: routeDecision
      ? (routeDecision.type === 'request-blocked' || routeDecision.decision === 'blocked'
          ? 'blocked' : 'continued')
      : 'not-observed',
    ...(routeDecision ? {
      dispatchCount: routeDecision.type === 'request-blocked' ? 0 : routeDecision.dispatchCount,
    } : {}),
    statusClass: catalogStatusClass(response?.status),
    request: projectCrownProtocolShape(requestPayload, {
      hmacKey: key, domain: 'crown-protocol-catalog/request-field-set/v1',
    }),
    response: projectCrownProtocolShape(responsePayload, {
      hmacKey: key, domain: 'crown-protocol-catalog/response-field-set/v1',
    }),
  }
}

export function buildCrownProtocolCatalogCandidate(records, {
  expectedDirections = CROWN_BROWSER_TARGETS,
  captureId = 'capture',
  hmacKey,
} = {}) {
  const key = catalogHmacKey(hmacKey)
  const groups = catalogValidatedGroups(records, captureId)
  const aggregated = new Map()
  for (const group of groups) {
    if (group.records[0].type === 'market-unavailable') continue
    const entry = catalogGroupEntry(group, key)
    const aggregationKey = stableJson({
      ...withoutBindings(entry),
      ...(!entry.endpointPathAllowlisted ? { endpointPathBinding: entry.endpointPathBinding } : {}),
    })
    const current = aggregated.get(aggregationKey) || { entry, groups: [] }
    current.groups.push(group)
    aggregated.set(aggregationKey, current)
  }
  const entries = [...aggregated.values()].map(({ entry, groups: occurrences }) => ({
    ...entry,
    occurrenceCount: occurrences.length,
    evidenceBinding: catalogBinding(key, 'crown-protocol-catalog/entry/v1', occurrences.map((group) => group.records)),
  })).sort((left, right) => stableJson(withoutBindings(left)).localeCompare(stableJson(withoutBindings(right))))
  const expectedIds = new Set((expectedDirections || []).map((direction) => (
    typeof direction === 'string' ? direction : direction.id
  )))
  const observedIds = new Set(records.map((record) => record.direction).filter((id) => expectedIds.has(id)))
  const content = {
    schemaVersion: 'crown-protocol-catalog-candidate-v1',
    sourceBinding: catalogBinding(key, 'crown-protocol-catalog/source/v1', [captureId, records]),
    expectedDirectionCount: expectedIds.size,
    observedDirectionCount: observedIds.size,
    entries,
  }
  assertSafeCrownProtocolEvidence(content)
  const artifact = { ...content, catalogDigest: fingerprint(content) }
  assertSafeCrownProtocolEvidence(artifact)
  return artifact
}

export function buildCrownStaticWireEvidence(records, options = {}) {
  const catalog = buildCrownProtocolCatalogCandidate(records, options)
  const entries = catalog.entries.filter((entry) => (
    entry.endpointPathAllowlisted && entry.transport !== 'websocket'
  )).map((entry) => ({
    endpointPath: entry.endpointPath,
    functionName: entry.functionName,
    method: entry.method,
    transport: entry.transport,
    request: entry.request,
    response: entry.response,
    staticValues: STATIC_WIRE_VALUE_ALLOWLIST[entry.functionName] || [],
    sourceBinding: entry.evidenceBinding,
  }))
  const content = {
    schemaVersion: 'crown-static-wire-evidence-v1',
    sourceBinding: catalog.sourceBinding,
    entries,
  }
  assertSafeCrownProtocolEvidence(content)
  const artifact = { ...content, evidenceDigest: fingerprint(content) }
  assertSafeCrownProtocolEvidence(artifact)
  return artifact
}

function eightDirectionFail(reason) {
  throw new Error(`crown-eight-direction:${reason}`)
}

function directionId(direction) {
  return typeof direction === 'string' ? direction : direction?.id
}

function exactOperationRequests(records, operation) {
  return records.filter((record) => record.type === 'request').map((record) => ({
    record,
    body: catalogRequestPayload(record),
  })).filter(({ body }) => body && typeof body === 'object' && body.p === operation)
}

function exactResponseFor(records, request) {
  const matches = records.filter((record) => record.type === 'response' && record.seq === request.seq)
  if (matches.length !== 1) eightDirectionFail('response-count')
  if (String(matches[0].method || '').toUpperCase() !== String(request.method || '').toUpperCase()
    || String(matches[0].url || '') !== String(request.url || '')) {
    eightDirectionFail('response-correlation')
  }
  return matches[0]
}

function expectedDirectionTarget(direction) {
  const id = directionId(direction)
  const target = CROWN_BROWSER_TARGETS.find((candidate) => candidate.id === id)
  if (!target) eightDirectionFail('direction-unsupported')
  return target
}

function verifiedAsianHandicapDirection(previewBody, submitBody) {
  const sideCode = String(submitBody.chose_team || '')
  if (!['H', 'C'].includes(sideCode)
    || previewBody.gtype !== 'FT'
    || submitBody.gtype !== 'FT'
    || previewBody.chose_team !== sideCode
    || previewBody.wtype !== submitBody.wtype) return null
  const side = sideCode === 'H' ? 'home' : 'away'
  if (submitBody.wtype === 'R'
    && submitBody.rtype === `R${sideCode}`
    && submitBody.isRB === 'N'
    && submitBody.f === '1R') {
    return `prematch-full-time-asian-handicap-${side}`
  }
  if (submitBody.wtype === 'RE'
    && submitBody.rtype === `RE${sideCode}`
    && submitBody.isRB === 'Y'
    && submitBody.f === '') {
    return `live-full-time-asian-handicap-${side}`
  }
  return null
}

function directionWireAssessment(direction, previewBody, submitBody) {
  const target = expectedDirectionTarget(direction)
  const sideCode = ['home', 'over'].includes(target.side) ? 'H' : 'C'
  const verifiedDirection = verifiedAsianHandicapDirection(previewBody, submitBody)
  const looksAsianHandicap = ['R', 'RE'].includes(String(previewBody.wtype || ''))
    || ['R', 'RE'].includes(String(submitBody.wtype || ''))
    || /^(?:R|RE)[HC]$/.test(String(submitBody.rtype || ''))
  if (verifiedDirection) {
    if (verifiedDirection !== target.id) eightDirectionFail('direction-wire-mismatch')
    return { verified: true, target }
  }
  if (target.marketType === 'asian_handicap' || looksAsianHandicap) {
    eightDirectionFail('direction-wire-mismatch')
  }
  if (target.marketType !== 'total'
    || previewBody.gtype !== 'FT'
    || submitBody.gtype !== 'FT'
    || previewBody.chose_team !== sideCode
    || submitBody.chose_team !== sideCode
    || !String(submitBody.rtype || '').endsWith(sideCode)) {
    eightDirectionFail('direction-wire-mismatch')
  }
  return { verified: false, target }
}

function websocketSubmitDecisions(records) {
  return records.filter((record) => (
    record.type === 'websocket-route-decision'
    && rawWebSocketRouteClassification(record)?.stage === 'submit'
  ))
}

function websocketSubmitFrames(records) {
  return records.filter((record) => {
    if (record.type !== 'websocket-send' || typeof record.payload !== 'string') return false
    return classifyProtocolRecord({
      type: 'request', method: 'POST', url: record.url || '', postData: record.payload,
    }).stage === 'submit'
  })
}

function websocketFrameEvidence(records) {
  const opens = records.filter((record) => record.type === 'websocket-open')
  const sends = records
    .filter((record) => record.type === 'websocket-send')
    .sort((left, right) => left.eventOrdinal - right.eventOrdinal)
  const frameDecisions = records
    .filter((record) => record.type === 'websocket-route-decision' && record.source === 'frame')
    .sort((left, right) => left.eventOrdinal - right.eventOrdinal)
  const continuedDecisions = frameDecisions.filter((decision) => decision.decision === 'continued')
  let decisionInvalid = frameDecisions.some((decision) => (
    !validatedWebSocketRouteClassification(decision)
  ))
  let correlationInvalid = false
  for (const decision of frameDecisions.filter((record) => record.decision === 'blocked')) {
    if (!opens.some((open) => (
      String(open.url || '') === String(decision.url || '')
      && open.eventOrdinal < decision.eventOrdinal
    ))) correlationInvalid = true
  }
  if (sends.length !== continuedDecisions.length) correlationInvalid = true
  const pairCount = Math.min(sends.length, continuedDecisions.length)
  for (let index = 0; index < pairCount; index += 1) {
    const send = sends[index]
    const decision = continuedDecisions[index]
    const matchingOpens = opens.filter((open) => open.seq === send.seq)
    const open = matchingOpens[0]
    if (matchingOpens.length !== 1
      || !open
      || open.eventOrdinal >= decision.eventOrdinal
      || decision.eventOrdinal >= send.eventOrdinal
      || String(open.url || '') !== String(decision.url || '')
      || (send.url && String(send.url) !== String(open.url || ''))) {
      correlationInvalid = true
      continue
    }
    const payloadKind = typeof send.payload === 'string' ? 'text' : 'binary'
    if (decision.payloadKind !== payloadKind
      || !validatedWebSocketRouteClassification(decision)) {
      decisionInvalid = true
      continue
    }
    if (payloadKind !== 'text' || decision.postData !== send.payload) {
      decisionInvalid = true
      continue
    }
    const classification = rawWebSocketRouteClassification(decision)
    if (!classification) {
      decisionInvalid = true
      continue
    }
    if (decision.classification?.stage !== classification.stage) {
      decisionInvalid = true
      continue
    }
    const mayContinue = ['monitor', 'preview'].includes(classification.stage)
    if (decision.decision === 'continued' ? !mayContinue : decision.dispatchCount !== 0) {
      decisionInvalid = true
    }
  }
  return { decisionInvalid, correlationInvalid }
}

function classifiedHttpBettingTraffic(records) {
  const traffic = { requests: [], routes: [] }
  for (const record of records) {
    const bucket = record.type === 'request'
      ? traffic.requests
      : (['route-decision', 'request-blocked'].includes(record.type) ? traffic.routes : null)
    if (!bucket) continue
    const classification = classifyProtocolRecord({
      type: 'request', method: record.method, url: record.url, postData: record.postData,
    })
    if (['preview', 'submit'].includes(classification.stage)) {
      bucket.push({ record, stage: classification.stage })
    } else if (classification.stage === 'candidate' && classification.routeRisk === 'order-like-post') {
      bucket.push({ record, stage: 'order-risk' })
    }
  }
  return traffic
}

export function buildCrownEightDirectionCandidates(records, {
  expectedDirections = CROWN_BROWSER_TARGETS,
  captureId = 'capture',
  hmacKey,
} = {}) {
  const key = catalogHmacKey(hmacKey)
  if (!Array.isArray(records)) eightDirectionFail('records-invalid')
  const byRun = new Map()
  for (const record of records) {
    const run = String(record.captureRunId || '')
    if (!run) eightDirectionFail('run-integrity')
    const rows = byRun.get(run) || []
    rows.push(record)
    byRun.set(run, rows)
  }
  const runsByDirection = new Map()
  for (const [run, runRecords] of byRun) {
    const directions = new Set(runRecords.map((record) => record.direction))
    const generations = new Set(runRecords.map((record) => record.sessionGeneration))
    if (directions.size !== 1 || generations.size !== 1 || directions.has(undefined) || generations.has(undefined)) {
      eightDirectionFail('run-integrity')
    }
    const [direction] = directions
    const runs = runsByDirection.get(direction) || []
    runs.push({ run, generation: [...generations][0], records: runRecords })
    runsByDirection.set(direction, runs)
  }

  const candidates = (expectedDirections || []).map((direction, index) => {
    const canonicalDirection = expectedDirectionTarget(direction)
    const id = canonicalDirection.id
    const runs = runsByDirection.get(id) || []
    if (runs.length === 0) eightDirectionFail('missing-run')
    if (runs.length !== 1) eightDirectionFail('duplicate-run')
    const selected = runs[0]
    const ordinals = new Set()
    for (const record of selected.records) {
      if (!Number.isSafeInteger(record.eventOrdinal) || record.eventOrdinal < 1) eightDirectionFail('run-integrity')
      if (ordinals.has(record.eventOrdinal)) eightDirectionFail('run-integrity')
      ordinals.add(record.eventOrdinal)
    }
    const websocketSubmits = websocketSubmitDecisions(selected.records)
    const websocketSubmitAttempts = websocketSubmitFrames(selected.records)
    if (websocketSubmits.some((record) => (
      record.decision !== 'blocked' || record.dispatchCount !== 0
    ))) eightDirectionFail('websocket-submit-dispatched')
    const {
      decisionInvalid: websocketFrameDecisionInvalid,
      correlationInvalid: websocketFrameCorrelationInvalid,
    } = websocketFrameEvidence(selected.records)
    const httpBettingTraffic = classifiedHttpBettingTraffic(selected.records)
    const unavailable = selected.records.filter((record) => record.type === 'market-unavailable')
    if (unavailable.length) {
      const partialBettingTraffic = httpBettingTraffic.requests.length > 0
        || httpBettingTraffic.routes.length > 0
      if (unavailable.length !== 1 || unavailable[0].marketConclusion !== 'operator-confirmed'
        || unavailable[0].finalConfirmation !== 'CONFIRM_MARKET_UNAVAILABLE'
        || !Number.isSafeInteger(unavailable[0].attemptCount)
        || unavailable[0].attemptCount < 4
        || unavailable[0].waited !== true
        || unavailable[0].switchedMatch !== true
        || websocketSubmits.length > 0
        || websocketSubmitAttempts.length > 0
        || websocketFrameDecisionInvalid
        || websocketFrameCorrelationInvalid
        || partialBettingTraffic) {
        eightDirectionFail('market-unavailable-partial')
      }
      return {
        ordinal: index + 1,
        direction: canonicalDirection,
        status: 'market-unavailable',
        reason: 'operator-confirmed',
        dispatchCount: 0,
        submitAllowed: false,
        capabilityPromoted: false,
        runBinding: catalogBinding(key, 'crown-eight-direction/run/v1', selected.records),
      }
    }
    if (websocketSubmits.length > 0 || websocketSubmitAttempts.length > 0) {
      eightDirectionFail('websocket-submit-attempt')
    }
    if (websocketFrameDecisionInvalid) eightDirectionFail('websocket-route-decision-invalid')
    if (websocketFrameCorrelationInvalid) eightDirectionFail('websocket-frame-correlation')

    const previewLikeRequests = httpBettingTraffic.requests.filter(({ stage }) => stage === 'preview')
    const submitLikeRequests = httpBettingTraffic.requests.filter(({ stage }) => stage === 'submit')
    const submitLikeRoutes = httpBettingTraffic.routes.filter(({ stage }) => stage === 'submit')
    const orderRiskRequests = httpBettingTraffic.requests.filter(({ stage }) => stage === 'order-risk')
    const orderRiskRoutes = httpBettingTraffic.routes.filter(({ stage }) => stage === 'order-risk')

    const preview = exactOperationRequests(selected.records, 'FT_order_view')
    const submit = exactOperationRequests(selected.records, 'FT_bet')
    if (preview.length !== 1) eightDirectionFail('preview-count')
    if (submit.length !== 1) eightDirectionFail('submit-count')
    const previewResponse = exactResponseFor(selected.records, preview[0].record)
    if (!Number.isInteger(previewResponse.status) || previewResponse.status < 200 || previewResponse.status >= 300) {
      eightDirectionFail('preview-response-unsuccessful')
    }
    if (selected.records.some((record) => record.type === 'response' && record.seq === submit[0].record.seq)) {
      eightDirectionFail('submit-response-present')
    }
    const routeDecisions = selected.records.filter((record) => (
      record.seq === submit[0].record.seq
      && ['route-decision', 'request-blocked'].includes(record.type)
    ))
    if (routeDecisions.length !== 1
      || (routeDecisions[0].decision !== 'blocked' && routeDecisions[0].type !== 'request-blocked')) {
      eightDirectionFail('submit-not-blocked')
    }
    if (routeDecisions[0].dispatchCount !== 0) eightDirectionFail('submit-dispatched')
    const routeBody = catalogRequestPayload(routeDecisions[0])
    if (String(routeDecisions[0].method || '').toUpperCase() !== String(submit[0].record.method || '').toUpperCase()
      || String(routeDecisions[0].url || '') !== String(submit[0].record.url || '')
      || stableJson(routeBody) !== stableJson(submit[0].body)) {
      eightDirectionFail('route-correlation')
    }
    if (!(preview[0].record.eventOrdinal < previewResponse.eventOrdinal
      && previewResponse.eventOrdinal < submit[0].record.eventOrdinal
      && submit[0].record.eventOrdinal < routeDecisions[0].eventOrdinal)) {
      eightDirectionFail('chronology')
    }
    if (previewLikeRequests.length !== 1
      || submitLikeRequests.length !== 1
      || submitLikeRoutes.length !== 1
      || orderRiskRequests.length !== 0
      || orderRiskRoutes.length !== 0) {
      eightDirectionFail('betting-traffic-count')
    }

    const previewValues = catalogXmlValues(previewResponse.responseBody) || {}
    if (previewValues.code !== '501') eightDirectionFail('preview-code-unverified')
    const previewBody = preview[0].body
    const submitBody = submit[0].body
    const expectedRatio = previewValues.ratio ?? previewValues.spread
    if (!previewBody.gid || previewBody.gid !== submitBody.gid
      || !previewBody.uid || previewBody.uid !== submitBody.uid
      || !previewBody.gtype || previewBody.gtype !== submitBody.gtype
      || !previewBody.wtype || previewBody.wtype !== submitBody.wtype
      || !previewBody.chose_team || previewBody.chose_team !== submitBody.chose_team
      || !previewValues.spread || !previewValues.ioratio
      || previewValues.ioratio !== submitBody.ioratio
      || !expectedRatio || expectedRatio !== submitBody.ratio) {
      eightDirectionFail('identity-drift')
    }
    const wireAssessment = directionWireAssessment(canonicalDirection, previewBody, submitBody)
    const wireIdentity = [
      previewBody.gtype, previewBody.wtype, previewBody.chose_team,
      submitBody.gtype, submitBody.wtype, submitBody.rtype,
      submitBody.isRB, submitBody.chose_team, submitBody.f,
    ]
    const directionWireBinding = catalogBinding(
      key, 'crown-eight-direction/direction-wire/v1', wireIdentity,
    )
    const identity = [
      selected.generation, previewBody.uid, previewBody.gid, previewBody.chose_team,
      previewBody.gtype, previewBody.wtype, submitBody.rtype, submitBody.isRB, submitBody.f,
      previewValues.spread, previewValues.ioratio,
    ]
    if (!wireAssessment.verified) {
      return {
        ordinal: index + 1,
        direction: canonicalDirection,
        status: 'incomplete',
        reason: 'EVIDENCE_REQUIRED',
        evidenceRequired: ['verified-total-wire-family'],
        dispatchCount: 0,
        submitAllowed: false,
        capabilityPromoted: false,
        runBinding: catalogBinding(key, 'crown-eight-direction/run/v1', selected.records),
        directionWireBinding,
        lifecycle: ['preview-request', 'preview-response', 'submit-request', 'submit-route-blocked'],
      }
    }
    return {
      ordinal: index + 1,
      direction: canonicalDirection,
      status: 'candidate',
      reason: 'preview-success-submit-route-blocked',
      dispatchCount: 0,
      submitAllowed: false,
      capabilityPromoted: false,
      runBinding: catalogBinding(key, 'crown-eight-direction/run/v1', selected.records),
      identityBinding: catalogBinding(key, 'crown-eight-direction/identity/v1', identity),
      directionWireBinding,
      lifecycle: ['preview-request', 'preview-response', 'submit-request', 'submit-route-blocked'],
    }
  })
  const directionWireBindings = candidates
    .map((candidate) => candidate.directionWireBinding)
    .filter(Boolean)
  if (new Set(directionWireBindings).size !== directionWireBindings.length) {
    eightDirectionFail('duplicate-direction-wire')
  }
  const unexpected = [...runsByDirection.keys()].filter((id) => !(expectedDirections || []).some((direction) => directionId(direction) === id))
  if (unexpected.length) eightDirectionFail('unexpected-direction')
  const content = {
    schemaVersion: 'crown-eight-direction-candidates-v1',
    sourceBinding: catalogBinding(key, 'crown-eight-direction/source/v1', [captureId, records]),
    candidates,
  }
  assertSafeCrownProtocolEvidence(content)
  const artifact = { ...content, candidateDigest: fingerprint(content) }
  assertSafeCrownProtocolEvidence(artifact)
  return artifact
}

function safeStructure(record) {
  const request = safeStructureBodyObject(record.postData)
  const requestKeys = Object.keys(request)
  const requestFieldSetValid = !requestKeys.some((field) => (
    SENSITIVE_FIELD.test(field) && !ALLOWED_TRANSPORT_FIELDS.has(field)
  )) && !Object.values(request).some(Array.isArray)
  const requestFieldSet = safeFieldSet(requestKeys)
  const responseSafety = responseFieldSafety(record.responseBody)
  const responseFields = responseSafety.fields
  const responseFieldSetValid = responseSafety.valid
  const responseFieldSet = safeFieldSet(responseFields, { envelope: 'serverresponse' })
  const classification = classifyProtocolRecord(record)
  const method = String(record.method || '').toUpperCase()
  const recordType = String(record.type || 'unknown')
  const stage = String(classification.stage || 'unknown')
  return {
    endpointKind: endpointKind(record),
    method: METHODS.has(method) ? method : 'OTHER',
    status: Number.isInteger(record.status) ? record.status : null,
    recordType: RECORD_TYPES.has(recordType) ? recordType : 'unknown',
    stage: STAGES.has(stage) ? stage : 'unknown',
    blocked: record.type === 'request-blocked',
    responseCode: safeResponseCode(record.responseBody),
    request: {
      fieldSet: requestFieldSet,
      fieldSetFingerprint: requestFieldSetValid && requestFieldSet.length ? fingerprint(requestFieldSet) : null,
      fieldSetValid: requestFieldSetValid,
      excludedTransportFieldCount: requestKeys.filter((field) => ALLOWED_TRANSPORT_FIELDS.has(field)).length,
    },
    response: {
      fieldSet: responseFieldSet,
      fieldSetFingerprint: responseFieldSetValid && responseFieldSet.length ? fingerprint(responseFieldSet) : null,
      fieldSetValid: responseFieldSetValid,
    },
  }
}

export function buildCrownProtocolArtifact(
  records,
  { captureId = 'capture', linkageContext = null, linkageKey = null } = {},
) {
  const occurrences = new Map()
  const linkageBySequence = new Map()
  const recordsBySequence = new Map()
  for (const record of records) {
    if (record.seq === undefined || record.seq === null) continue
    const sequence = String(record.seq)
    const group = recordsBySequence.get(sequence) || []
    group.push(record)
    recordsBySequence.set(sequence, group)
  }
  for (const [sequence, group] of recordsBySequence) {
    const tag = linkageTagFor(group, linkageContext, linkageKey)
    if (tag) linkageBySequence.set(sequence, tag)
  }
  const safeRecords = records.map((record) => {
    const structure = safeStructure(record)
    const structuralFingerprint = fingerprint(structure)
    const occurrence = (occurrences.get(structuralFingerprint) || 0) + 1
    occurrences.set(structuralFingerprint, occurrence)
    const recordEvidenceId = fingerprint({
      endpointKind: structure.endpointKind,
      method: structure.method,
      status: structure.status,
      structuralFingerprint,
      occurrence,
    })
    const linkageTag = record.seq === undefined || record.seq === null
      ? null
      : linkageBySequence.get(String(record.seq)) || null
    return { recordEvidenceId, occurrence, structuralFingerprint, linkageTag, ...structure }
  })
  const content = { schemaVersion: 1, captureId: fingerprint(String(captureId || 'capture')), records: safeRecords }
  assertSafeCrownProtocolEvidence(content)
  return { ...content, artifactSafeDigest: fingerprint(content) }
}

export function summarizeCrownProtocol(records, options = {}) {
  return buildCrownProtocolArtifact(records, options).records.map((record) => ({
    ...record,
    requestFieldSet: record.request.fieldSet,
    requestFieldSetFingerprint: record.request.fieldSetFingerprint,
    responseFieldSet: record.response.fieldSet,
    responseFieldSetFingerprint: record.response.fieldSetFingerprint,
    responseCode: record.responseCode,
    contentFingerprint: record.structuralFingerprint,
  }))
}

function selectedLoginEvidence(records, previewRequest, submitResponse) {
  const candidates = []
  for (const loginRequest of operationEntries(records, 'chk_login')) {
    if (loginRequest.index >= previewRequest.index || loginRequest.record.type !== 'request') continue
    const response = pairedResponse(records, loginRequest, { mustFinishBefore: previewRequest.index, optional: true })
    if (!response) continue
    let parsed
    try {
      parsed = parseDirectXml(response.record.responseBody)
    } catch (error) {
      if (String(error?.message || '').endsWith(':response-body-unavailable')) continue
      throw error
    }
    if (parsed.values.status === '200') candidates.push({ request: loginRequest, response, parsed })
  }
  candidates.sort((left, right) => right.response.index - left.response.index)
  const selected = candidates[0]
  if (!selected) executionFail('account-binding-unavailable')

  const username = canonicalText(selected.parsed.values.username)
  const mid = canonicalText(selected.parsed.values.mid)
  if (!username || !mid) executionFail('account-binding-unavailable')
  let currency = normalizedCurrency(selected.parsed.values.currency)
  if (!currency || currency !== 'CNY') executionFail('currency-unverified')

  for (const entry of records) {
    if (entry.record.type !== 'response'
      || entry.index < selected.response.index
      || entry.index > submitResponse.index
      || !/<serverresponse\b/i.test(String(entry.record.responseBody || ''))) continue
    const fields = xmlOpeningFields(entry.record.responseBody)
    if (!fields.some((field) => ['username', 'mid', 'currency'].includes(field))) continue
    const parsed = parseDirectXml(entry.record.responseBody)
    const observedUsername = canonicalText(parsed.values.username)
    const observedMid = canonicalText(parsed.values.mid)
    if ((observedUsername && observedUsername !== username) || (observedMid && observedMid !== mid)) {
      executionFail('account-binding-drift')
    }
    if (parsed.values.currency !== undefined && String(parsed.values.currency).trim()) {
      const observedCurrency = normalizedCurrency(parsed.values.currency)
      if (!observedCurrency || observedCurrency !== currency) executionFail('currency-unverified')
      currency = observedCurrency
    }
  }
  return { username, mid, currency }
}

function selectedExecutionAttempt(records) {
  const submits = operationEntries(records, 'FT_bet')
  if (submits.length !== 1 || submits[0].record.type !== 'request') executionFail('submit-attempt-ambiguous')
  const submitRequest = submits[0]
  const submitResponse = pairedResponse(records, submitRequest)
  const submitForm = submitRequest.body
  if (Object.values(submitForm).some(Array.isArray)) executionFail('duplicate-field')
  const previewMatches = []

  for (const previewRequest of operationEntries(records, 'FT_order_view')) {
    if (previewRequest.index >= submitRequest.index || previewRequest.record.type !== 'request') continue
    if (Object.values(previewRequest.body).some(Array.isArray)) executionFail('duplicate-field')
    const identityMatches = EXECUTION_WIRE_IDENTITY_FIELDS.every((field) => (
      String(previewRequest.body[field] ?? '')
      && String(previewRequest.body[field]) === String(submitForm[field] ?? '')
    ))
    if (!identityMatches) continue
    const matchingResponses = records.filter((entry) => (
      entry.record.type === 'response' && entry.record.seq === previewRequest.record.seq
    ))
    if (matchingResponses.length > 1) executionFail('record-sequence')
    const response = matchingResponses[0]
    if (!response || response.index <= previewRequest.index || response.index >= submitRequest.index) continue
    const parsed = parseDirectXml(response.record.responseBody)
    if (parsed.values.code === '501') previewMatches.push({ request: previewRequest, response, parsed })
  }
  previewMatches.sort((left, right) => right.request.index - left.request.index)
  const preview = previewMatches[0]
  if (!preview) executionFail('preview-attempt-unavailable')
  return { preview, submit: { request: submitRequest, response: submitResponse, form: submitForm } }
}

function directPositiveInteger(value, reason) {
  const text = String(value ?? '').trim()
  if (!/^[1-9]\d*$/.test(text)) executionFail(reason)
  return text
}

function directDecimal(value, reason) {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) executionFail(reason)
  return text
}

function exactTime(value, reason) {
  const text = String(value || '').trim()
  const milliseconds = Date.parse(text)
  if (!text || !Number.isFinite(milliseconds)) executionFail(reason)
  return { text, milliseconds }
}

export function buildCrownExecutionEvidenceCandidate(
  captureDir,
  { hmacKey, legacyLayout = false } = {},
) {
  const key = privateHmacKey(hmacKey)
  const watcher = readWatcherEvidence(captureDir)
  const watcherEvidenceDigest = fingerprint(watcher)
  const layout = crownProtocolCaptureLayout(captureDir, { legacyLayout })
  const { rawBytes, records } = readCapturePair(captureDir, { layout })
  const selected = selectedExecutionAttempt(records)

  const previewForm = selected.preview.request.body
  const submitForm = selected.submit.form
  const previewRequestFields = formEvidence(previewForm, PREVIEW_REQUEST_FIELDS, ['uid'], 'preview-request')
  const submitRequestFields = formEvidence(submitForm, SUBMIT_REQUEST_FIELDS, ['uid'], 'submit-request')
  const previewResponseFields = xmlEvidence(selected.preview.parsed, PREVIEW_RESPONSE_FIELDS, {
    excludedFields: ['username'],
    label: 'preview-response',
  })
  const submitParsed = parseDirectXml(selected.submit.response.record.responseBody)
  for (const field of ['gid', 'gtype', 'wtype', 'rtype']) {
    const requestValue = canonicalText(submitForm[field])
    const responseValue = canonicalText(submitParsed.values[field])
    if (!requestValue || !responseValue || requestValue !== responseValue) {
      executionFail('submit-response-identity-drift')
    }
  }
  const submitResponseFields = xmlEvidence(submitParsed, SUBMIT_RESPONSE_FIELDS, {
    excludedFields: ['mid', 'username'],
    optionalResult: true,
    label: 'submit-response',
  })

  const capability = derivedCapability(submitForm, watcher)

  const previewCon = canonicalText(selected.preview.parsed.values.con)
  const previewRatio = canonicalText(selected.preview.parsed.values.ratio)
  const submitCon = canonicalText(submitForm.con)
  const submitRatio = canonicalText(submitForm.ratio)
  if (!previewCon || !previewRatio || submitCon !== previewCon || submitRatio !== previewRatio) {
    executionFail('submit-wire-derivation-drift')
  }
  const submitTimestamp = canonicalText(submitForm.timestamp)
  if (!/^\d{13}$/.test(submitTimestamp) || !Number.isSafeInteger(Number(submitTimestamp))) {
    executionFail('submit-timestamp-unverified')
  }
  const maxWatcherToSubmitMs = 60_000
  const watcherTime = exactTime(watcher.capturedAt, 'watcher-evidence-chronology')
  const previewRequestTime = exactTime(selected.preview.request.record.at, 'execution-chronology-drift')
  const previewResponseTime = exactTime(selected.preview.response.record.at, 'execution-chronology-drift')
  const submitRequestTime = exactTime(selected.submit.request.record.at, 'execution-chronology-drift')
  const submitResponseTime = exactTime(selected.submit.response.record.at, 'execution-chronology-drift')
  const submitTimestampMs = Number(submitTimestamp)
  if (watcherTime.milliseconds > previewRequestTime.milliseconds
    || previewRequestTime.milliseconds > previewResponseTime.milliseconds
    || previewResponseTime.milliseconds > submitTimestampMs
    || submitTimestampMs > submitRequestTime.milliseconds
    || submitRequestTime.milliseconds > submitResponseTime.milliseconds
    || submitTimestampMs - watcherTime.milliseconds > maxWatcherToSubmitMs
    || submitRequestTime.milliseconds - submitTimestampMs > 1_000) {
    executionFail(watcherTime.milliseconds > previewRequestTime.milliseconds
      || submitTimestampMs - watcherTime.milliseconds > maxWatcherToSubmitMs
      ? 'watcher-evidence-chronology'
      : 'execution-chronology-drift')
  }

  for (const field of EXECUTION_WIRE_IDENTITY_FIELDS) {
    if (!canonicalText(previewForm[field])
      || String(previewForm[field]) !== String(submitForm[field])) executionFail('execution-identity-drift')
  }
  const previewSpread = canonicalText(selected.preview.parsed.values.spread)
  const previewStrong = canonicalText(selected.preview.parsed.values.strong).toUpperCase()
  const submitSpread = canonicalText(submitParsed.values.spread)
  const submitStrong = canonicalText(submitParsed.values.strong).toUpperCase()
  if (!previewSpread || !submitSpread || submitSpread !== previewSpread) executionFail('execution-identity-drift')
  if (watcher.gid !== canonicalText(submitForm.gid)
    || watcher.line !== previewSpread
    || canonicalDecimal(watcher.odds) !== canonicalDecimal(selected.preview.parsed.values.ioratio)
    || canonicalDecimal(watcher.odds) !== canonicalDecimal(submitForm.ioratio)) {
    executionFail('watcher-evidence-execution-drift')
  }
  if (!['H', 'C'].includes(previewStrong) || !['Y', 'N'].includes(submitStrong)) {
    executionFail('execution-strong-unverified')
  }
  const chosenSide = canonicalText(submitForm.chose_team).toUpperCase()
  if (!['H', 'C'].includes(chosenSide)
    || (submitStrong === 'Y') !== (chosenSide === previewStrong)) executionFail('execution-strong-drift')

  const previewUid = canonicalText(previewForm.uid)
  const submitUid = canonicalText(submitForm.uid)
  if (!previewUid || !submitUid) executionFail('session-binding-unavailable')
  const previewCookies = canonicalCookies(cookieHeader(selected.preview.request.record.headers))
  const submitCookies = canonicalCookies(cookieHeader(selected.submit.request.record.headers))
  if (previewUid !== submitUid || stableJson(previewCookies) !== stableJson(submitCookies)) {
    executionFail('session-binding-drift')
  }

  const account = selectedLoginEvidence(records, selected.preview.request, selected.submit.response)
  const accountBinding = hmacBinding(key, HMAC_DOMAINS.account, [account.username, account.mid])
  const sessionBinding = hmacBinding(key, HMAC_DOMAINS.session, [
    previewUid, ...previewCookies.flatMap(([name, value]) => [name, value]),
  ])
  const executionIdentityBinding = hmacBinding(key, HMAC_DOMAINS.execution, [
    ...EXECUTION_CAPABILITY_FIELDS.map((field) => capability[field]),
    ...EXECUTION_WIRE_IDENTITY_FIELDS.map((field) => canonicalText(previewForm[field])),
    previewSpread,
    'preview-strong',
    previewStrong,
    'submit-strong',
    submitStrong,
  ])
  const watcherEvidenceBinding = hmacBinding(key, HMAC_DOMAINS.watcher, [
    watcherEvidenceDigest, watcher.auditId, watcher.batchId, watcher.gid, watcher.mode,
    watcher.period, watcher.marketType, watcher.ratioField, watcher.line, watcher.side,
    watcher.oddsField, watcher.odds,
  ])

  const previewCode = String(selected.preview.parsed.values.code || '').trim()
  if (previewCode !== '501') executionFail('preview-code-unverified')
  const minimum = directPositiveInteger(selected.preview.parsed.values.gold_gmin, 'preview-limits-unverified')
  const maximum = directPositiveInteger(selected.preview.parsed.values.gold_gmax, 'preview-limits-unverified')
  const previewOdds = directDecimal(selected.preview.parsed.values.ioratio, 'preview-odds-unverified')
  const amount = directPositiveInteger(submitForm.golds, 'submit-amount-unverified')
  const submitOdds = directDecimal(submitForm.ioratio, 'submit-odds-unverified')
  const responseAmount = directPositiveInteger(submitParsed.values.gold, 'submit-amount-unverified')
  const responseOdds = directDecimal(submitParsed.values.ioratio, 'submit-odds-unverified')
  if (amount !== responseAmount || submitOdds !== responseOdds
    || BigInt(minimum) > BigInt(maximum)
    || BigInt(amount) < BigInt(minimum)
    || BigInt(amount) > BigInt(maximum)) executionFail('direct-value-drift')

  const submitCode = String(submitParsed.values.code || '').trim()
  if (!/^\d+$/.test(submitCode)) executionFail('submit-code-unverified')
  const resultValue = submitResponseFields.resultField
    ? canonicalText(submitParsed.values[submitResponseFields.resultField])
    : ''
  const responseMid = canonicalText(submitParsed.values.mid)
  if (!responseMid || responseMid !== account.mid) executionFail('account-binding-drift')
  const resultReferenceBinding = resultValue
    ? hmacBinding(key, HMAC_DOMAINS.result, [resultValue, responseMid])
    : undefined
  const outcome = submitCode === '560' && resultReferenceBinding ? 'accepted' : 'unknown'

  const recordInputs = [
    { entry: selected.preview.request, stage: 'preview', recordType: 'request', evidence: previewRequestFields },
    { entry: selected.preview.response, stage: 'preview', recordType: 'response', evidence: previewResponseFields },
    { entry: selected.submit.request, stage: 'submit', recordType: 'request', evidence: submitRequestFields },
    { entry: selected.submit.response, stage: 'submit', recordType: 'response', evidence: submitResponseFields },
  ]
  const publicRecords = recordInputs.map(({ entry, stage, recordType, evidence }, index) => ({
    ordinal: index + 1,
    recordEvidenceId: hmacBinding(key, HMAC_DOMAINS.record, [String(index + 1), stableJson(entry.record)]),
    stage,
    recordType,
    fieldSet: evidence.fieldSet,
    fieldSetFingerprint: evidence.fieldSetFingerprint,
    excludedSensitiveFieldCount: evidence.excludedSensitiveFieldCount,
  }))

  const incompleteReasons = outcome === 'unknown'
    ? ['accepted-attempt-required', 'direct-submit-outcome-unproven']
    : []
  const content = {
    schemaVersion: 'crown-execution-evidence-candidate-v3',
    captureDigest: `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`,
    capability,
    watcherEvidenceDigest,
    watcherEvidenceBinding,
    watcherEvidence: {
      capturedAt: watcher.capturedAt,
      auditId: watcher.auditId,
      batchId: watcher.batchId,
      ratioField: watcher.ratioField,
      oddsField: watcher.oddsField,
    },
    accountBinding,
    sessionBinding,
    executionIdentityBinding,
    ...(resultReferenceBinding ? { resultReferenceBinding } : {}),
    currency: account.currency,
    records: publicRecords,
    direct: {
      preview: { code: previewCode, minimum, maximum, odds: previewOdds, line: previewSpread },
      submit: { code: submitCode, amount, odds: submitOdds },
    },
    submitWireEvidence: {
      con: submitCon,
      conSource: 'preview-response:con',
      ratio: submitRatio,
      ratioSource: 'preview-response:ratio',
      f: String(submitForm.f ?? ''),
      timestamp2: String(submitForm.timestamp2 ?? ''),
      timestampSource: 'submit-request:epoch-ms',
    },
    chronology: {
      maxWatcherToSubmitMs,
      watcherCapturedAt: watcherTime.text,
      previewRequestAt: previewRequestTime.text,
      previewResponseAt: previewResponseTime.text,
      submitTimestampAt: new Date(submitTimestampMs).toISOString(),
      submitRequestAt: submitRequestTime.text,
      submitResponseAt: submitResponseTime.text,
    },
    stakeQuantum: { amountMinor: 50, provenance: 'local-conservative-policy' },
    outcome,
    outcomeEvidence: 'direct-response',
    evidenceIncomplete: incompleteReasons.length > 0,
    incompleteReasons,
  }
  assertSafeCrownProtocolEvidence(content)
  const candidate = { ...content, candidateDigest: fingerprint(content) }
  assertSafeCrownProtocolEvidence(candidate)
  return candidate
}

export function writeCrownExecutionEvidenceCandidate(captureDir, options = {}) {
  const candidate = buildCrownExecutionEvidenceCandidate(captureDir, options)
  const target = path.join(captureDir, 'public', 'execution-evidence-candidate.json')
  fs.writeFileSync(target, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
  return { candidate, candidateDigest: candidate.candidateDigest }
}

function writeSafeJson(publicDir, name, artifact) {
  assertSafeCrownProtocolEvidence(artifact)
  publishPublicFiles(publicDir, { [name]: `${JSON.stringify(artifact, null, 2)}\n` }, [name])
  return artifact
}

function removePublicOutputs(publicDir, names) {
  for (const name of names) fs.rmSync(path.join(publicDir, name), { force: true })
}

function publishPublicFiles(publicDir, files, outputNames = Object.keys(files)) {
  fs.mkdirSync(publicDir, { recursive: true })
  const tempDir = path.join(publicDir, `.tmp-crown-protocol-${randomUUID()}`)
  fs.mkdirSync(tempDir)
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), content, 'utf8')
    }
    removePublicOutputs(publicDir, outputNames)
    for (const name of Object.keys(files)) {
      fs.renameSync(path.join(tempDir, name), path.join(publicDir, name))
    }
  } catch (error) {
    removePublicOutputs(publicDir, outputNames)
    throw error
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function incompleteEightDirectionArtifact(expectedDirections, key, captureId) {
  const content = {
    schemaVersion: 'crown-eight-direction-candidates-v1',
    sourceBinding: catalogBinding(key, 'crown-eight-direction/source/v1', [captureId, 'not-captured']),
    candidates: expectedDirections.map((direction, index) => ({
      ordinal: index + 1,
      direction,
      status: 'incomplete',
      reason: 'capture-not-provided',
      dispatchCount: 0,
      submitAllowed: false,
      capabilityPromoted: false,
    })),
  }
  assertSafeCrownProtocolEvidence(content)
  return { ...content, candidateDigest: fingerprint(content) }
}

export function writeCrownProtocolCatalogCandidate(captureDir, records, options = {}) {
  const artifact = buildCrownProtocolCatalogCandidate(records, options)
  return writeSafeJson(path.join(captureDir, 'public'), 'protocol-catalog.safe.json', artifact)
}

export function writeCrownEightDirectionCandidates(captureDir, records, options = {}) {
  const artifact = buildCrownEightDirectionCandidates(records, options)
  return writeSafeJson(path.join(captureDir, 'public'), 'eight-direction-candidates.safe.json', artifact)
}

export function writeCrownStaticWireEvidence(captureDir, records, options = {}) {
  const artifact = buildCrownStaticWireEvidence(records, options)
  return writeSafeJson(path.join(captureDir, 'public'), 'static-wire-evidence.safe.json', artifact)
}

function buildCrownProtocolArtifactSet(sourceRecords, {
  expectedDirections,
  captureId,
  hmacKey,
  allowIncompleteEightDirection,
}) {
  const key = catalogHmacKey(hmacKey || readOrCreateLocalSecretKey())
  const options = { expectedDirections, captureId, hmacKey: key }
  const protocolCatalog = buildCrownProtocolCatalogCandidate(sourceRecords, options)
  const staticWireEvidence = buildCrownStaticWireEvidence(sourceRecords, options)
  const hasExpectedDirection = sourceRecords.some((record) => (
    expectedDirections.some((direction) => directionId(direction) === record.direction)
  ))
  const eightDirectionCandidates = allowIncompleteEightDirection && !hasExpectedDirection
    ? incompleteEightDirectionArtifact(expectedDirections, key, captureId)
    : buildCrownEightDirectionCandidates(sourceRecords, options)
  return { protocolCatalog, eightDirectionCandidates, staticWireEvidence }
}

function writeCrownProtocolArtifactSet(captureDir, artifacts) {
  const publicDir = path.join(captureDir, 'public')
  publishPublicFiles(publicDir, {
    'protocol-catalog.safe.json': `${JSON.stringify(artifacts.protocolCatalog, null, 2)}\n`,
    'eight-direction-candidates.safe.json': `${JSON.stringify(artifacts.eightDirectionCandidates, null, 2)}\n`,
    'static-wire-evidence.safe.json': `${JSON.stringify(artifacts.staticWireEvidence, null, 2)}\n`,
  }, CATALOG_PUBLIC_OUTPUTS)
  return {
    protocolCatalog: artifacts.protocolCatalog,
    eightDirectionCandidates: artifacts.eightDirectionCandidates,
    staticWireEvidence: artifacts.staticWireEvidence,
  }
}

export function writeCrownProtocolCatalogArtifacts(captureDir, {
  records,
  expectedDirections = CROWN_BROWSER_TARGETS,
  captureId = path.basename(path.resolve(captureDir)),
  hmacKey,
  allowIncompleteEightDirection = false,
} = {}) {
  const publicDir = path.join(captureDir, 'public')
  removePublicOutputs(publicDir, CATALOG_PUBLIC_OUTPUTS)
  try {
    let sourceRecords = records
    if (!sourceRecords) {
      sourceRecords = readCapturePair(captureDir, {
        layout: 'modern', requireModernMetadata: true,
      }).rawRecords
    }
    const artifacts = buildCrownProtocolArtifactSet(sourceRecords, {
      expectedDirections, captureId, hmacKey, allowIncompleteEightDirection,
    })
    return writeCrownProtocolArtifactSet(captureDir, artifacts)
  } catch (error) {
    removePublicOutputs(publicDir, CATALOG_PUBLIC_OUTPUTS)
    throw error
  }
}

function markdown(artifact) {
  const lines = [
    '# Crown Betting Protocol Safe Summary', '',
    `Capture ID: \`${artifact.captureId}\``, '',
    `Artifact digest: \`${artifact.artifactSafeDigest}\``, '',
    '| Evidence ID | Endpoint kind | Method | Stage | Type | Status | Structure fingerprint |',
    '|---|---|---|---|---|---:|---|',
  ]
  for (const item of artifact.records) {
    lines.push(`| ${item.recordEvidenceId} | ${item.endpointKind} | ${item.method} | ${item.stage} | ${item.recordType} | ${item.status ?? ''} | ${item.structuralFingerprint} |`)
  }
  lines.push('', 'Only sanitized structural evidence is present. Unknown values are omitted.', '')
  return lines.join('\n')
}

function legacyRedactedCaptureFile(captureDir) {
  return path.join(captureDir, 'public', 'redacted-network.jsonl')
}

function capturePublicManifestLayout(captureDir) {
  const manifestFile = path.join(captureDir, 'public', 'manifest.json')
  if (!fs.existsSync(manifestFile)) return 'none'
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    catalogFail('manifest-invalid')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) catalogFail('manifest-invalid')
  const legacyFields = [
    'allowOddsClick', 'allowRealSubmit', 'allowStakeFill', 'generatedAt',
    'maxStake', 'profile', 'url',
  ]
  const keys = Object.keys(manifest).sort()
  const historicalLegacyShape = stableJson(keys) === stableJson(legacyFields)
    && typeof manifest.generatedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.generatedAt)
    && typeof manifest.url === 'string'
    && /^https?:\/\//i.test(manifest.url)
    && typeof manifest.profile === 'string'
    && manifest.profile.length > 0
    && typeof manifest.allowOddsClick === 'boolean'
    && typeof manifest.allowStakeFill === 'boolean'
    && typeof manifest.allowRealSubmit === 'boolean'
    && Number.isSafeInteger(manifest.maxStake)
    && manifest.maxStake >= 0
  return historicalLegacyShape ? 'legacy' : 'modern'
}

function completeModernRecorderRecord(record) {
  return Boolean(record)
    && typeof record === 'object'
    && !Array.isArray(record)
    && Number.isSafeInteger(record.eventOrdinal)
    && record.eventOrdinal > 0
    && typeof record.captureRunId === 'string'
    && Boolean(record.captureRunId)
    && typeof record.sessionGeneration === 'string'
    && Boolean(record.sessionGeneration)
}

function hasModernRecorderMarker(record) {
  return Boolean(record)
    && typeof record === 'object'
    && !Array.isArray(record)
    && (
      Object.hasOwn(record, 'eventOrdinal')
      || Object.hasOwn(record, 'captureRunId')
      || Object.hasOwn(record, 'sessionGeneration')
    )
}

function readLayoutProbe(file, reason) {
  if (!fs.existsSync(file)) return []
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch {
    executionFail('capture-files-unavailable')
  }
  return parseJsonlBytes(bytes, reason)
}

function crownProtocolCaptureLayout(captureDir, { legacyLayout = false } = {}) {
  const privateRedacted = path.join(captureDir, 'private', 'redacted-network.jsonl')
  const privateManifest = path.join(captureDir, 'private', 'manifest.json')
  const rawRecords = readLayoutProbe(
    path.join(captureDir, 'private', 'raw-network.jsonl'), 'raw-capture-invalid',
  )
  const publicRecords = readLayoutProbe(
    path.join(captureDir, 'public', 'redacted-network.jsonl'), 'redacted-capture-invalid',
  )
  const publicManifestLayout = capturePublicManifestLayout(captureDir)
  const hasModernMarker = publicManifestLayout === 'modern'
    || fs.existsSync(privateManifest)
    || fs.existsSync(privateRedacted)
    || [...rawRecords, ...publicRecords].some(hasModernRecorderMarker)
  if (legacyLayout) {
    if (hasModernMarker) catalogFail('modern-layout-cannot-use-legacy')
    if (publicManifestLayout !== 'legacy') catalogFail('legacy-layout-manifest-required')
    return 'legacy'
  }
  if (hasModernMarker) return 'modern'
  catalogFail('legacy-layout-explicit-opt-in-required')
}

export function analyzeCrownProtocolCapture(captureDir, options = {}) {
  const publicDir = path.join(captureDir, 'public')
  const captureId = path.basename(path.resolve(captureDir))
  removePublicOutputs(publicDir, ANALYZER_PUBLIC_OUTPUTS)
  try {
    const layout = crownProtocolCaptureLayout(captureDir, {
      legacyLayout: options.legacyLayout === true,
    })
    let records
    let pendingSafeArtifacts = null
    if (layout === 'modern') {
      const pair = readCapturePair(captureDir, {
        layout: 'modern', requireModernMetadata: true,
      })
      records = pair.redactedRecords
      pendingSafeArtifacts = buildCrownProtocolArtifactSet(pair.rawRecords, {
        expectedDirections: CROWN_BROWSER_TARGETS,
        captureId,
        hmacKey: options.hmacKey,
        allowIncompleteEightDirection: true,
      })
    } else {
      records = readJsonl(legacyRedactedCaptureFile(captureDir))
    }
    const artifact = buildCrownProtocolArtifact(records, { captureId })
    const summary = summarizeCrownProtocol(records)
    const protocolMap = markdown(artifact)
    const files = {
      'protocol-evidence.json': `${JSON.stringify(artifact, null, 2)}\n`,
      'protocol-summary.json': `${JSON.stringify(summary, null, 2)}\n`,
      'protocol-map.md': protocolMap,
    }
    if (pendingSafeArtifacts) {
      files['protocol-catalog.safe.json'] = `${JSON.stringify(pendingSafeArtifacts.protocolCatalog, null, 2)}\n`
      files['eight-direction-candidates.safe.json'] = `${JSON.stringify(pendingSafeArtifacts.eightDirectionCandidates, null, 2)}\n`
      files['static-wire-evidence.safe.json'] = `${JSON.stringify(pendingSafeArtifacts.staticWireEvidence, null, 2)}\n`
    }
    publishPublicFiles(publicDir, files, ANALYZER_PUBLIC_OUTPUTS)
    return {
      captureId: artifact.captureId,
      recordCount: records.length,
      evidenceCount: artifact.records.length,
      artifactSafeDigest: artifact.artifactSafeDigest,
      safeArtifacts: Boolean(pendingSafeArtifacts),
    }
  } catch (error) {
    removePublicOutputs(publicDir, ANALYZER_PUBLIC_OUTPUTS)
    throw error
  }
}

export function analyzeCrownProtocolCaptureSet(captureDir, runDirs, options = {}) {
  const publicDir = path.join(captureDir, 'public')
  removePublicOutputs(publicDir, CATALOG_PUBLIC_OUTPUTS)
  try {
    if (!Array.isArray(runDirs) || runDirs.length === 0) catalogFail('capture-set-empty')
    const records = runDirs.flatMap((runDir) => (
      readCapturePair(runDir, { layout: 'modern', requireModernMetadata: true }).rawRecords
    ))
    return writeCrownProtocolCatalogArtifacts(captureDir, {
      ...options,
      records,
      captureId: path.basename(path.resolve(captureDir)),
    })
  } catch (error) {
    removePublicOutputs(publicDir, CATALOG_PUBLIC_OUTPUTS)
    throw error
  }
}

export function parseAnalyzeArgs(argv) {
  const args = { captureDir: '', legacyLayout: false }
  for (const arg of argv) {
    if (arg === '--legacy-layout') args.legacyLayout = true
    else if (!arg.startsWith('-') && !args.captureDir) args.captureDir = arg
    else throw new Error('crown-protocol-analyze:invalid-arguments')
  }
  if (!args.captureDir) throw new Error('Usage: node scripts/crown-betting-protocol-analyze.mjs <capture-dir> [--legacy-layout]')
  return args
}

function main() {
  const args = parseAnalyzeArgs(process.argv.slice(2))
  console.log(JSON.stringify(analyzeCrownProtocolCapture(args.captureDir, {
    legacyLayout: args.legacyLayout,
  })))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
