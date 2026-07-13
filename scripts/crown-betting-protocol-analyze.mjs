#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyProtocolRecord } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import { assertSafeCrownProtocolEvidence } from '../src/crown/betting-protocol/capture-redaction.mjs'

const SENSITIVE_FIELD = /(?:secret|user(?:name)?|pass(?:word)?|pwd|token|cookie|session|uid|ticket|auth(?:orization)?|provider|reference)/i
const ALLOWED_TRANSPORT_FIELDS = new Set(['uid'])
const RECORD_TYPES = new Set(['request', 'response', 'request-blocked'])
const STAGES = new Set(['preview', 'submit', 'monitor', 'candidate', 'unknown'])
const METHODS = new Set(['GET', 'POST'])

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
