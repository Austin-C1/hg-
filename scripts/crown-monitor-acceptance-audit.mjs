#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { classifyProtocolRecord } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import { startDashboardServer } from '../src/crown/dashboard/static-server.mjs'

const RULES_VERSION = 'crown-monitor-acceptance-v1'
const INPUT_FILES = Object.freeze({
  snapshots: 'crown-odds-snapshots-v2.jsonl',
  changes: 'crown-odds-changes-v2.jsonl',
  runtime: 'crown-watch-runtime.jsonl',
})
const API_PATHS = Object.freeze({
  summary: '/api/summary',
  events: '/api/events',
  changes: '/api/changes?limit=500',
  bootstrap: '/api/app/bootstrap',
})
const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'password', 'passwd', 'pwd', 'secret', 'secret_ciphertext', 'secretCiphertext',
  'token', 'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'bot_token', 'botToken',
  'authorization', 'cookie', 'cookies', 'session', 'session_id', 'sessionId',
  'storageState', 'storage_state', 'ticket', 'ticketId', 'ticket_id',
  'rawSession', 'raw_session',
])
const FORBIDDEN_FIELD_KEYS = new Set(FORBIDDEN_FIELD_NAMES.map((name) => name.toLowerCase()))
const SECRET_PATTERNS = Object.freeze([
  {
    id: 'authorization-bearer',
    description: 'HTTP Bearer authorization credential',
    expression: /\bbearer\s+[a-z0-9._~+\/-]{12,}/i,
  },
  {
    id: 'jwt-compact',
    description: 'JWT compact serialization',
    expression: /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i,
  },
  {
    id: 'telegram-bot-token',
    description: 'Telegram bot token format',
    expression: /\b\d{6,12}:[a-z0-9_-]{20,}\b/i,
  },
  {
    id: 'session-cookie',
    description: 'Session cookie assignment',
    expression: /\b(?:php)?sess(?:ion)?id\s*[=:]\s*[a-z0-9._~-]{8,}/i,
  },
  {
    id: 'private-key',
    description: 'PEM private key material',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  },
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSha256(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

function portableJoin(...parts) {
  return parts.join('/')
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function comparablePath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function invalidArguments() {
  const error = new Error('invalid arguments')
  error.code = 'INVALID_ARGUMENTS'
  return error
}

export function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Map([
    ['--runtime-dir', 'runtimeDir'],
    ['--db-path', 'dbPath'],
    ['--output', 'output'],
  ])
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const key = allowed.get(option)
    const value = argv[index + 1]
    if (!key || Object.hasOwn(parsed, key) || !value || value.startsWith('--')) throw invalidArguments()
    parsed[key] = value
  }
  if (argv.length !== 6 || !parsed.runtimeDir || !parsed.dbPath || !parsed.output) throw invalidArguments()

  const runtimeDir = path.resolve(parsed.runtimeDir)
  const dbPath = path.resolve(parsed.dbPath)
  const output = path.resolve(parsed.output)
  let runtimeStat
  let dbStat
  try {
    runtimeStat = fs.statSync(runtimeDir)
    dbStat = fs.statSync(dbPath)
  } catch {
    throw invalidArguments()
  }
  if (!runtimeStat.isDirectory() || !dbStat.isFile()) throw invalidArguments()
  const comparableDbPath = comparablePath(dbPath)
  const comparableOutput = comparablePath(output)
  const protectedDatabasePaths = new Set([
    comparableDbPath,
    `${comparableDbPath}-wal`,
    `${comparableDbPath}-shm`,
    `${comparableDbPath}-journal`,
  ])
  if (protectedDatabasePaths.has(comparableOutput) || isWithin(comparablePath(runtimeDir), comparableOutput)) throw invalidArguments()
  if (fs.existsSync(output) && fs.statSync(output).isDirectory()) throw invalidArguments()
  return { runtimeDir, dbPath, output }
}

function inspectFile(file, label, { jsonl = false } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return {
      report: { label, exists: false, bytes: 0, lineCount: jsonl ? 0 : null, sha256: null, parseErrors: jsonl ? 0 : null },
      records: [],
      lines: [],
    }
  }
  const buffer = fs.readFileSync(file)
  const text = jsonl ? buffer.toString('utf8') : ''
  const lines = jsonl ? text.split(/\r?\n/).filter((line) => line.trim() !== '') : []
  const records = []
  let parseErrors = 0
  if (jsonl) {
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        parseErrors += 1
      }
    }
  }
  return {
    report: {
      label,
      exists: true,
      bytes: buffer.byteLength,
      lineCount: jsonl ? lines.length : null,
      sha256: sha256(buffer),
      parseErrors: jsonl ? parseErrors : null,
    },
    records,
    lines,
  }
}

function fieldHits(value, source, currentPath = '$', hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => fieldHits(item, source, `${currentPath}[${index}]`, hits))
    return hits
  }
  if (!value || typeof value !== 'object') return hits
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${currentPath}.${key}`
    if (FORBIDDEN_FIELD_KEYS.has(key.toLowerCase())) hits.push({ source, path: childPath, field: key })
    fieldHits(child, source, childPath, hits)
  }
  return hits
}

function patternHits(lines, source) {
  const hits = []
  lines.forEach((line, index) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.expression.test(line)) hits.push({ source, line: index + 1, patternId: pattern.id })
    }
  })
  return hits
}

function recordEndpointKind(record) {
  const explicit = String(record?.endpointKind || record?.source?.endpointKind || record?.request?.endpointKind || '').toLowerCase()
  if (/get[_-]?game[_-]?list/.test(explicit)) return 'list'
  if (/get[_-]?game[_-]?more/.test(explicit)) return 'detail'
  const blob = [record?.source?.endpointKey, record?.source?.urlPattern, record?.url, record?.postData]
    .filter(Boolean).join('\n')
  if (/get[_-]?game[_-]?list/i.test(blob)) return 'list'
  if (/get[_-]?game[_-]?more/i.test(blob)) return 'detail'
  return 'unknown'
}

function protocolRecord(record) {
  const request = record?.request && typeof record.request === 'object' ? record.request : {}
  const endpointKey = String(record?.source?.endpointKey || '')
  const endpointKind = String(record?.endpointKind || record?.source?.endpointKind || request.endpointKind || '')
  const methodMatch = endpointKey.match(/^([A-Z]+)\s+/)
  return {
    method: record?.method || request.method || methodMatch?.[1] || 'POST',
    url: record?.url || request.url || record?.source?.urlPattern || endpointKey,
    postData: record?.postData || request.postData || request.body || endpointKey || (endpointKind ? `p=${encodeURIComponent(endpointKind)}` : ''),
  }
}

function rate(parsed, total) {
  return { parsed, total, rate: total === 0 ? null : parsed / total }
}

function eventProviderIds(record) {
  return record?.event?.providerIds || record?.event?.ids || record?.providerIds || {}
}

function eventKey(record) {
  return String(record?.event?.eventKey || record?.eventIdentity || '').trim()
}

function statistics(inputs) {
  const factEndpointKinds = { list: 0, detail: 0, unknown: 0 }
  for (const record of [...inputs.snapshots.records, ...inputs.changes.records]) {
    factEndpointKinds[recordEndpointKind(record)] += 1
  }
  const requestEvidence = inputs.runtime.records.filter((record) => (
    record?.type === 'xml-response' && record?.source === 'direct-api'
  ))
  const requests = {
    total: requestEvidence.length,
    list: 0,
    detail: 0,
    monitor: 0,
    preview: 0,
    submit: 0,
    candidate: 0,
    unknown: 0,
  }
  for (const record of requestEvidence) {
    const endpointKind = recordEndpointKind(record)
    if (endpointKind === 'list' || endpointKind === 'detail') requests[endpointKind] += 1
    const stage = classifyProtocolRecord(protocolRecord(record)).stage
    requests[Object.hasOwn(requests, stage) ? stage : 'unknown'] += 1
  }

  const gidKeys = new Map()
  for (const record of [...inputs.snapshots.records, ...inputs.changes.records]) {
    const gid = String(eventProviderIds(record)?.gid || '').trim()
    const key = eventKey(record)
    if (!gid || !key) continue
    if (!gidKeys.has(gid)) gidKeys.set(gid, new Set())
    gidKeys.get(gid).add(key)
  }
  const conflicts = [...gidKeys.values()].filter((keys) => keys.size > 1).length

  let prematchTotal = 0
  let prematchParsed = 0
  let liveTotal = 0
  let liveParsed = 0
  for (const record of inputs.snapshots.records) {
    if (record?.mode === 'prematch') {
      prematchTotal += 1
      if (Number.isFinite(Date.parse(record?.event?.startTimeUtc || ''))) prematchParsed += 1
    }
    if (record?.mode === 'live') {
      liveTotal += 1
      const minute = Number(record?.event?.liveMinute)
      if (record?.event?.liveMinute !== null && record?.event?.liveMinute !== '' && Number.isFinite(minute) && minute >= 0) liveParsed += 1
    }
  }

  const detailEventRemoved = inputs.changes.records.filter((record) => (
    record?.type === 'event-removed' && recordEndpointKind(record) === 'detail'
  )).length
  return {
    records: {
      snapshots: inputs.snapshots.records.length,
      changes: inputs.changes.records.length,
      runtime: inputs.runtime.records.length,
    },
    requests,
    factEndpointKinds,
    identity: { gidEventKeyConflicts: conflicts },
    timeParsing: {
      prematchStartTime: rate(prematchParsed, prematchTotal),
      liveMinute: rate(liveParsed, liveTotal),
    },
    changes: { detailEventRemoved },
  }
}

function copyDatabase(source, target) {
  fs.copyFileSync(source, target)
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${target}${suffix}`)
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function auditApi({ runtimeDir, dbPath }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-acceptance-dashboard-'))
  const copiedDbPath = path.join(tempDir, 'crown.sqlite')
  copyDatabase(dbPath, copiedDbPath)
  let server
  const empty = Object.fromEntries(Object.keys(API_PATHS).map((name) => [name, {
    status: 0,
    bytes: 0,
    sha256: null,
    forbiddenFieldHits: [],
    secretPatternHits: [],
  }]))
  try {
    server = await startDashboardServer({
      host: '127.0.0.1',
      port: 0,
      dataOptions: {
        snapshotPath: path.join(runtimeDir, 'crown-odds-snapshots.jsonl'),
        changesPath: path.join(runtimeDir, 'crown-odds-changes.jsonl'),
        v2SnapshotPath: path.join(runtimeDir, INPUT_FILES.snapshots),
        v2ChangesPath: path.join(runtimeDir, INPUT_FILES.changes),
        runtimeLogPath: path.join(runtimeDir, INPUT_FILES.runtime),
        fixtureSnapshotPath: path.join(runtimeDir, '__missing_fixture__.jsonl'),
        dbPath,
      },
      appOptions: { dbPath: copiedDbPath },
    })
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const results = {}
    for (const [name, apiPath] of Object.entries(API_PATHS)) {
      try {
        const response = await fetch(`${baseUrl}${apiPath}`, { signal: AbortSignal.timeout(10_000) })
        const body = await response.text()
        let payload = null
        try { payload = JSON.parse(body) } catch {}
        results[name] = {
          status: response.status,
          bytes: Buffer.byteLength(body),
          sha256: sha256(body),
          forbiddenFieldHits: payload === null ? [] : fieldHits(payload, `api/${name}`),
          secretPatternHits: patternHits(body.split(/\r?\n/), `api/${name}`),
        }
      } catch {
        results[name] = empty[name]
      }
    }
    return results
  } catch {
    return empty
  } finally {
    if (server) await closeServer(server).catch(() => {})
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function runAcceptanceAudit({ runtimeDir, dbPath, output }) {
  const inspected = {}
  const inputPaths = {}
  for (const [name, filename] of Object.entries(INPUT_FILES)) {
    inputPaths[name] = path.join(runtimeDir, filename)
    inspected[name] = inspectFile(inputPaths[name], portableJoin('runtime', filename), { jsonl: true })
  }
  inputPaths.database = dbPath
  inspected.database = inspectFile(dbPath, portableJoin('database', path.basename(dbPath)))

  const stats = statistics(inspected)
  const security = { forbiddenFieldHits: [], secretPatternHits: [] }
  for (const name of ['snapshots', 'changes', 'runtime']) {
    const source = inspected[name].report.label
    inspected[name].records.forEach((record, index) => fieldHits(record, source, `$[${index}]`, security.forbiddenFieldHits))
    security.secretPatternHits.push(...patternHits(inspected[name].lines, source))
  }
  const api = await auditApi({ runtimeDir, dbPath })
  const reports = Object.fromEntries(Object.entries(inspected).map(([name, item]) => [name, item.report]))
  const jsonlReports = ['snapshots', 'changes', 'runtime'].map((name) => reports[name])
  const apiResults = Object.values(api)
  const checks = {
    inputsPresent: Object.values(reports).every((input) => input.exists),
    inputsUnchanged: Object.entries(inputPaths).every(([name, file]) => fileSha256(file) === reports[name].sha256),
    parseErrorsZero: jsonlReports.every((input) => input.parseErrors === 0),
    listAndDetailObserved: stats.requests.list > 0 && stats.requests.detail > 0,
    previewAndSubmitZero: stats.requests.preview === 0 && stats.requests.submit === 0,
    identityConflictsZero: stats.identity.gidEventKeyConflicts === 0,
    detailEventRemovedZero: stats.changes.detailEventRemoved === 0,
    sensitiveHitsZero: security.forbiddenFieldHits.length === 0 && security.secretPatternHits.length === 0,
    apiAll200: apiResults.every((entry) => entry.status === 200),
    apiSensitiveHitsZero: apiResults.every((entry) => entry.forbiddenFieldHits.length === 0 && entry.secretPatternHits.length === 0),
  }
  const report = {
    rulesVersion: RULES_VERSION,
    pass: Object.values(checks).every(Boolean),
    rules: {
      forbiddenFieldNames: [...FORBIDDEN_FIELD_NAMES],
      secretPatterns: SECRET_PATTERNS.map(({ id, description }) => ({ id, description })),
    },
    inputs: reports,
    statistics: stats,
    security,
    api,
    checks,
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return report
}

async function main() {
  let args
  try {
    args = parseArgs()
  } catch {
    console.error('acceptance-audit: invalid arguments')
    process.exitCode = 2
    return
  }
  try {
    const report = await runAcceptanceAudit(args)
    process.exitCode = report.pass ? 0 : 1
  } catch {
    console.error('acceptance-audit: audit failed')
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
