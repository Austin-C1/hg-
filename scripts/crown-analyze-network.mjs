#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DYNAMIC_QUERY_KEYS = new Set([
  '_',
  'ts',
  'timestamp',
  't',
  'r',
  'nonce',
  'random',
  'v',
  'ver',
])

const SECRET_QUERY_KEYS = /(token|cookie|password|passwd|authorization|auth|session|secret|csrf|xsrf|jwt|signature|sign|hmac|passcode|T)$/i
const EVENT_FIELD_RE = /(event|match|game|league|team|home|away|赛事|比赛|联赛|球队|主队|客队)/i
const ODDS_FIELD_RE = /(odds|odd|price|water|ior|handicap|hdp|line|spread|total|over|under|让球|大\/小|盘口|赔率)/i
const LIVE_RE = /(live|inplay|running|score|clock|period|timeline|滚球|上半场|下半场|比分)/i
const PREMATCH_RE = /(prematch|today|early|fixture|schedule|今日|早盘|赛前)/i
const ESPORTS_RE = /(电竞|电子|虚拟|梦幻足球|e\s*[-_ ]?\s*football|efootball|esport|virtual|fantasy|gt体育|GT体育|cyber|鐢电珵|鐢靛瓙|铏氭嫙|姊﹀够)/i

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function posixRelative(from, to) {
  return path.relative(from, to).replace(/\\/g, '/')
}

function isDynamicQueryKey(key) {
  return DYNAMIC_QUERY_KEYS.has(String(key).toLowerCase()) || SECRET_QUERY_KEYS.test(String(key))
}

function normalizePathname(pathname) {
  return pathname
    .split('/')
    .map((part) => (/^\d{5,}$/.test(part) ? ':id' : part))
    .join('/')
}

export function normalizeUrlPattern(rawUrl) {
  const parsed = new URL(rawUrl)
  const kept = []
  for (const [key, value] of parsed.searchParams.entries()) {
    if (isDynamicQueryKey(key)) continue
    kept.push([key, value])
  }
  kept.sort(([a], [b]) => a.localeCompare(b))

  const query = kept
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const base = `${parsed.host}${normalizePathname(parsed.pathname)}`
  return query ? `${base}?${query}` : base
}

function parseNetworkLog(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name))
}

function collectFixtureTerms(fixtureDir) {
  const filteredPath = path.join(fixtureDir, 'football-today-filtered.json')
  if (!fs.existsSync(filteredPath)) return []

  const data = readJson(filteredPath)
  const values = new Set()
  for (const item of [...(data.prematch || []), ...(data.live || [])]) {
    if (item.league) values.add(item.league)
    for (const team of item.teams || []) values.add(team)
  }
  return [...values].filter((value) => String(value).length >= 2)
}

function makeGroupKey(method, url) {
  return `${String(method || 'GET').toUpperCase()} ${normalizeUrlPattern(url)}`
}

function addPath(set, prefix) {
  if (prefix) set.add(prefix)
}

function collectShape(value, prefix, shape, depth = 0) {
  if (depth > 8 || value == null) {
    addPath(shape.keyPaths, prefix)
    return
  }

  if (Array.isArray(value)) {
    addPath(shape.keyPaths, `${prefix}[]`)
    shape.arrayLengths.add(value.length)
    for (const item of value.slice(0, 8)) {
      collectShape(item, `${prefix}[]`, shape, depth + 1)
    }
    return
  }

  if (typeof value === 'object') {
    addPath(shape.keyPaths, prefix)
    for (const [key, child] of Object.entries(value)) {
      collectShape(child, prefix ? `${prefix}.${key}` : key, shape, depth + 1)
    }
    return
  }

  addPath(shape.keyPaths, prefix)
  if (typeof value === 'string') {
    const text = value.trim()
    if (text) shape.textValues.push(text)
  }
}

function scoreGroup(group, fixtureTerms) {
  const pathBlob = group.keyPaths.join('\n')
  const textBlob = [...group.textValues.slice(0, 200), group.endpointKey].join('\n')
  const allBlob = `${pathBlob}\n${textBlob}`

  let score = 0
  const reasons = []
  const textHits = []

  if (EVENT_FIELD_RE.test(allBlob)) {
    score += 20
    reasons.push('event/match/league/team fields')
  }
  if (ODDS_FIELD_RE.test(allBlob)) {
    score += 20
    reasons.push('odds/price/handicap fields')
  }
  if (group.arrayLengths.some((length) => Math.abs(length - 20) <= 2 || Math.abs(length - 18) <= 2)) {
    score += 15
    reasons.push('array length close to 20 or 18')
  }

  for (const term of fixtureTerms) {
    if (term && allBlob.includes(term)) {
      textHits.push(term)
      if (textHits.length >= 8) break
    }
  }
  if (textHits.length) {
    score += 30
    reasons.push('matches fixture league or team text')
  }

  if (ESPORTS_RE.test(allBlob)) {
    score -= 50
    reasons.push('esports/virtual/fantasy keyword')
  }

  return { score, reasons, textHits }
}

function classifyGroup(group) {
  const blob = `${group.endpointKey}\n${group.keyPaths.join('\n')}\n${group.textValues.slice(0, 200).join('\n')}`
  const hasEvent = EVENT_FIELD_RE.test(blob)
  const hasOdds = ODDS_FIELD_RE.test(blob)
  const hasLive = LIVE_RE.test(blob)
  const hasPrematch = PREMATCH_RE.test(blob) || group.arrayLengths.some((length) => Math.abs(length - 20) <= 2)
  const isExcluded = ESPORTS_RE.test(blob)

  if (isExcluded) return 'irrelevant'
  if (hasEvent && hasOdds && hasLive) return 'football-live'
  if (hasEvent && hasOdds && hasPrematch) return 'football-prematch'
  if (hasOdds && !hasEvent) return 'odds-refresh'
  if (/league|联赛/i.test(blob) && !hasOdds) return 'league-dict'
  if (/team|球队|home|away/i.test(blob) && !hasOdds) return 'team-dict'
  if (group.score <= 0) return 'irrelevant'
  return 'unknown'
}

function buildMarkdown(report) {
  const lines = [
    '# Crown Endpoint Candidates',
    '',
    `Generated at: ${report.generatedAt}`,
    `Fixture: ${report.fixtureDir}`,
    '',
    '| Rank | Score | Type | Endpoint | Responses | Samples | Reasons |',
    '|---:|---:|---|---|---:|---|---|',
  ]

  report.candidates.slice(0, 50).forEach((candidate, index) => {
    const samples = candidate.sampleFiles.slice(0, 3).join('<br>')
    lines.push(
      `| ${index + 1} | ${candidate.score} | ${candidate.classification} | \`${candidate.endpointKey}\` | ${candidate.responseCount} | ${samples} | ${candidate.reasons.join('; ')} |`,
    )
  })

  lines.push('')
  lines.push('## Top Candidate Details')
  for (const candidate of report.candidates.slice(0, 8)) {
    lines.push('')
    lines.push(`### ${candidate.endpointKey}`)
    lines.push('')
    lines.push(`- Score: ${candidate.score}`)
    lines.push(`- Type: ${candidate.classification}`)
    lines.push(`- Array lengths: ${candidate.arrayLengths.join(', ') || 'none'}`)
    lines.push(`- Text hits: ${candidate.textHits.join(', ') || 'none'}`)
    lines.push(`- Sample files: ${candidate.sampleFiles.slice(0, 5).join(', ') || 'none'}`)
    lines.push(`- Key paths: ${candidate.keyPaths.slice(0, 40).join(', ') || 'none'}`)
  }

  return `${lines.join('\n')}\n`
}

export async function analyzeFixture(fixtureDir, options = {}) {
  const absoluteFixtureDir = path.resolve(fixtureDir)
  const networkEntries = parseNetworkLog(path.join(absoluteFixtureDir, 'network.jsonl'))
  const responseBySavedBody = new Map()
  const responseByUrl = new Map()

  for (const entry of networkEntries) {
    if (entry.type !== 'response') continue
    if (entry.savedBody) responseBySavedBody.set(String(entry.savedBody).replace(/\\/g, '/'), entry)
    if (entry.url) responseByUrl.set(`${entry.method || 'GET'} ${entry.url}`, entry)
  }

  const fixtureTerms = collectFixtureTerms(absoluteFixtureDir)
  const groups = new Map()
  const jsonDir = path.join(absoluteFixtureDir, 'json-responses')

  for (const file of listJsonFiles(jsonDir)) {
    let sample
    try {
      sample = readJson(file)
    } catch {
      continue
    }

    const rel = posixRelative(absoluteFixtureDir, file)
    const networkEntry = responseBySavedBody.get(rel) || responseByUrl.get(`${sample.method || 'GET'} ${sample.url}`)
    const method = sample.method || networkEntry?.method || 'GET'
    const url = sample.url || networkEntry?.url
    if (!url) continue

    const endpointKey = makeGroupKey(method, url)
    if (!groups.has(endpointKey)) {
      groups.set(endpointKey, {
        endpointKey,
        method: String(method).toUpperCase(),
        urlPattern: normalizeUrlPattern(url),
        responseCount: 0,
        statuses: new Set(),
        resourceTypes: new Set(),
        contentTypes: new Set(),
        sampleFiles: [],
        keyPaths: new Set(),
        arrayLengths: new Set(),
        textValues: [],
      })
    }

    const group = groups.get(endpointKey)
    group.responseCount += 1
    if (sample.status || networkEntry?.status) group.statuses.add(sample.status || networkEntry.status)
    if (networkEntry?.resourceType) group.resourceTypes.add(networkEntry.resourceType)
    if (networkEntry?.contentType) group.contentTypes.add(networkEntry.contentType)
    if (group.sampleFiles.length < 20) group.sampleFiles.push(rel)
    collectShape(sample, '', group)
  }

  const candidates = [...groups.values()].map((group) => {
    const normalized = {
      ...group,
      statuses: [...group.statuses].sort(),
      resourceTypes: [...group.resourceTypes].sort(),
      contentTypes: [...group.contentTypes].sort(),
      keyPaths: [...group.keyPaths].filter(Boolean).sort(),
      arrayLengths: [...group.arrayLengths].sort((a, b) => a - b),
      textValues: group.textValues,
    }
    const scored = scoreGroup(normalized, fixtureTerms)
    normalized.score = scored.score
    normalized.reasons = scored.reasons
    normalized.textHits = scored.textHits
    normalized.classification = classifyGroup(normalized)
    delete normalized.textValues
    return normalized
  }).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.responseCount - a.responseCount
  })

  const report = {
    generatedAt: new Date().toISOString(),
    fixtureDir: posixRelative(process.cwd(), absoluteFixtureDir) || absoluteFixtureDir,
    dynamicQueryKeys: [...DYNAMIC_QUERY_KEYS],
    candidates,
  }

  if (options.writeReports !== false) {
    writeJson(path.join(absoluteFixtureDir, 'endpoint-candidates.json'), report)
    fs.writeFileSync(path.join(absoluteFixtureDir, 'endpoint-candidates.md'), buildMarkdown(report), 'utf8')
  }

  return report
}

function printHelp() {
  console.log(`Usage:
  node scripts/crown-analyze-network.mjs <fixture-dir>

Reads network.jsonl and json-responses from a local fixture, then writes:
  endpoint-candidates.json
  endpoint-candidates.md`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  const fixtureDir = args[0]
  if (!fixtureDir) {
    printHelp()
    process.exitCode = 1
    return
  }

  const report = await analyzeFixture(fixtureDir)
  const likely = report.candidates.filter((candidate) => candidate.classification !== 'irrelevant').slice(0, 8)
  console.log(`Analyzed ${report.candidates.length} endpoint groups`)
  for (const [index, candidate] of likely.entries()) {
    console.log(`${index + 1}. [${candidate.score}] ${candidate.classification} ${candidate.endpointKey}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
