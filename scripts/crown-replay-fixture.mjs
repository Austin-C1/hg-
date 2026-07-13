#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { classifyCrownTransformText } from '../src/crown/crown-transform-xml.mjs'
import { detectEndpoint } from '../src/crown/endpoint-detector.mjs'
import { normalizeFootballResponse } from '../src/crown/normalize-football.mjs'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function appendCount(target, key, amount = 1) {
  const normalizedKey = key || 'unknown'
  target[normalizedKey] = (target[normalizedKey] || 0) + amount
}

function eventCountsByMode(records) {
  const sets = {}
  for (const record of records) {
    sets[record.mode] ??= new Set()
    sets[record.mode].add(record.event.eventId)
  }
  return Object.fromEntries(Object.entries(sets).map(([key, value]) => [key, value.size]))
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name))
}

function listFilesByExtension(dir, extensions) {
  if (!fs.existsSync(dir)) return []
  const allowed = new Set(extensions.map((extension) => extension.toLowerCase()))
  return fs.readdirSync(dir)
    .filter((name) => allowed.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(dir, name))
}

function endpointKindForXmlFile(file) {
  const name = path.basename(file).toLowerCase()
  if (name.includes('more')) return 'get_game_more'
  return 'get_game_list'
}

function loadLeagueConfig(configPath) {
  if (!configPath) return null
  return readJson(configPath)
}

export async function replayFixture(fixtureDir, options = {}) {
  const absoluteFixtureDir = path.resolve(fixtureDir)
  const absoluteOutputDir = path.resolve(options.outputDir || absoluteFixtureDir)
  const leagueConfigPath = options.leagueConfigPath ?? 'config/monitored-leagues.json'
  const leagueConfig = loadLeagueConfig(leagueConfigPath)
  fs.mkdirSync(absoluteOutputDir, { recursive: true })
  const normalizedPath = path.join(absoluteOutputDir, 'replay-normalized.jsonl')
  const summaryPath = path.join(absoluteOutputDir, 'replay-summary.json')
  const records = []
  const detections = {}
  const xmlSummary = {
    xmlFiles: 0,
    htmlFiles: 0,
    invalidXmlFiles: 0,
    emptyXmlFiles: 0,
    loginExpiredFiles: 0,
  }

  const fixturePath = path.join(absoluteFixtureDir, 'football-today-filtered.json')
  if (fs.existsSync(fixturePath)) {
    const body = readJson(fixturePath)
    const portableFixturePath = path.relative(process.cwd(), fixturePath).replace(/\\/g, '/')
    const metadata = {
      method: 'LOCAL',
      url: portableFixturePath,
      capturedAt: body.capturedAt,
      sampleFile: path.relative(absoluteFixtureDir, fixturePath).replace(/\\/g, '/'),
    }
    const detected = detectEndpoint({ body, metadata })
    appendCount(detections, detected.kind)
    records.push(...normalizeFootballResponse({ body, metadata, leagueConfig }))
  }

  const jsonFiles = listJsonFiles(path.join(absoluteFixtureDir, 'json-responses'))
  for (const file of jsonFiles) {
    const sample = readJson(file)
    const portableFilePath = path.relative(process.cwd(), file).replace(/\\/g, '/')
    const metadata = {
      method: sample.method || 'GET',
      url: sample.url || portableFilePath,
      capturedAt: sample.capturedAt,
      sampleFile: path.relative(absoluteFixtureDir, file).replace(/\\/g, '/'),
    }
    const detected = detectEndpoint({ body: sample.body, metadata })
    appendCount(detections, detected.kind)
    records.push(...normalizeFootballResponse({ body: sample.body, metadata, leagueConfig }))
  }

  const textFiles = listFilesByExtension(absoluteFixtureDir, ['.xml', '.html'])
  for (const file of textFiles) {
    const body = fs.readFileSync(file, 'utf8')
    const classification = classifyCrownTransformText(body)
    const extension = path.extname(file).toLowerCase()
    if (extension === '.html') xmlSummary.htmlFiles += 1
    if (classification.loginExpired) {
      xmlSummary.loginExpiredFiles += 1
      continue
    }
    if (classification.parseError) {
      xmlSummary.invalidXmlFiles += 1
      continue
    }
    if (classification.empty) xmlSummary.emptyXmlFiles += 1
    if (extension === '.xml') xmlSummary.xmlFiles += 1

    const metadata = {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: endpointKindForXmlFile(file),
      capturedAt: new Date(0).toISOString(),
      sampleFile: path.relative(absoluteFixtureDir, file).replace(/\\/g, '/'),
    }
    const detected = detectEndpoint({ body, metadata })
    appendCount(detections, detected.kind)
    records.push(...normalizeFootballResponse({ body, metadata, leagueConfig }))
  }

  fs.writeFileSync(normalizedPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8')

  const byMode = {}
  const byLeague = {}
  const byEndpoint = {}
  const byMarketType = {}
  const warnings = {}
  for (const record of records) {
    appendCount(byMode, record.mode)
    appendCount(byLeague, record.event.league)
    appendCount(byEndpoint, record.source.endpointKey)
    appendCount(byMarketType, record.market.marketType)
    for (const warning of record.warnings || []) appendCount(warnings, warning)
  }

  const fixture = fs.existsSync(fixturePath) ? readJson(fixturePath) : { counts: {} }
  const summary = {
    generatedAt: new Date().toISOString(),
    fixtureDir: path.relative(process.cwd(), absoluteFixtureDir).replace(/\\/g, '/'),
    source: {
      fixtureCounts: fixture.counts || {},
      jsonResponseFiles: jsonFiles.length,
      ...xmlSummary,
      detections,
    },
    totalRecords: records.length,
    eventsByMode: eventCountsByMode(records),
    byMode,
    byLeague,
    byEndpoint,
    byMarketType,
    warnings,
  }
  writeJson(summaryPath, summary)
  return summary
}

function printHelp() {
  console.log(`Usage:
  node scripts/crown-replay-fixture.mjs <fixture-dir>

Outputs:
  replay-normalized.jsonl
  replay-summary.json`)
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

  const summary = await replayFixture(fixtureDir)
  console.log(`Replay records: ${summary.totalRecords}`)
  console.log(`Events by mode: ${JSON.stringify(summary.eventsByMode)}`)
  console.log(`Leagues: ${Object.keys(summary.byLeague).join(', ') || 'none'}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
