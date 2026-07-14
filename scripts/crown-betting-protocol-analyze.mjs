#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyProtocolRecord } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  assertSafeCrownProtocolEvidence,
  parseBody,
  redactBody,
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
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
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
    return bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    executionFail(reason)
  }
}

function redactedProtocolRecord(record) {
  return {
    ...record,
    url: record.url ? redactUrl(record.url) : record.url,
    headers: redactHeaders(record.headers || {}),
    postData: record.postData ? redactBody(parseBody(record.postData)) : undefined,
    responseBody: record.responseBody ? redactBody(parseBody(record.responseBody)) : undefined,
  }
}

function readCapturePair(captureDir) {
  let rawBytes
  let publicBytes
  try {
    rawBytes = fs.readFileSync(path.join(captureDir, 'private', 'raw-network.jsonl'))
    publicBytes = fs.readFileSync(path.join(captureDir, 'public', 'redacted-network.jsonl'))
  } catch {
    executionFail('capture-files-unavailable')
  }
  const rawRecords = parseJsonlBytes(rawBytes, 'raw-capture-invalid')
  const publicRecords = parseJsonlBytes(publicBytes, 'redacted-capture-invalid')
  if (rawRecords.length === 0 || rawRecords.length !== publicRecords.length) executionFail('redaction-pair-missing')
  for (let index = 0; index < rawRecords.length; index += 1) {
    const raw = rawRecords[index]
    const redacted = publicRecords[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || stableJson(redactedProtocolRecord(raw)) !== stableJson(redacted)) {
      executionFail('redaction-pair-mismatch')
    }
  }
  return { rawBytes, records: rawRecords.map((record, index) => ({ record, index })) }
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
    const name = path.posix.basename(new URL(record.url).pathname).replace(/\.[^.]+$/, '')
    return /^[a-z0-9_-]{1,64}$/i.test(name) ? name : 'other'
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

function safeFieldSet(fields, { envelope = '' } = {}) {
  return [...new Set(fields.map(String).filter((field) => (
    field && field !== envelope && !SENSITIVE_FIELD.test(field)
  )))].sort()
}

function xmlOpeningFields(value) {
  return [...String(value || '').matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>/g)].map((match) => match[1])
}

function responseFieldSafety(value) {
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

function safeStructure(record) {
  const request = bodyObject(record.postData)
  const requestKeys = Object.keys(request)
  const requestFieldSetValid = !requestKeys.some((field) => (
    SENSITIVE_FIELD.test(field) && !ALLOWED_TRANSPORT_FIELDS.has(field)
  )) && !Object.values(request).some(Array.isArray)
  const requestFieldSet = safeFieldSet(requestKeys)
  const responseSafety = responseFieldSafety(record.responseBody)
  const responseFields = responseSafety.fields
  const responseFieldSetValid = responseSafety.valid
  const responseFieldSet = safeFieldSet(responseFields, { envelope: 'serverresponse' })
  const classification = record.classification?.stage ? record.classification : classifyProtocolRecord(record)
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
  { hmacKey } = {},
) {
  const key = privateHmacKey(hmacKey)
  const watcher = readWatcherEvidence(captureDir)
  const watcherEvidenceDigest = fingerprint(watcher)
  const { rawBytes, records } = readCapturePair(captureDir)
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

export function analyzeCrownProtocolCapture(captureDir) {
  const publicDir = path.join(captureDir, 'public')
  const records = readJsonl(path.join(publicDir, 'redacted-network.jsonl'))
  const captureId = path.basename(path.resolve(captureDir))
  const artifact = buildCrownProtocolArtifact(records, { captureId })
  fs.writeFileSync(path.join(publicDir, 'protocol-evidence.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(publicDir, 'protocol-summary.json'), `${JSON.stringify(summarizeCrownProtocol(records), null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(publicDir, 'protocol-map.md'), markdown(artifact), 'utf8')
  return { captureId: artifact.captureId, recordCount: records.length, evidenceCount: artifact.records.length, artifactSafeDigest: artifact.artifactSafeDigest }
}

function main() {
  const captureDir = process.argv[2]
  if (!captureDir) throw new Error('Usage: node scripts/crown-betting-protocol-analyze.mjs <capture-dir>')
  console.log(JSON.stringify(analyzeCrownProtocolCapture(captureDir)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
