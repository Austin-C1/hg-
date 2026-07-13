import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { replayFixture } from '../scripts/crown-replay-fixture.mjs'

const fixtureDir = 'data/fixtures/crown/20260708_004011'

test('replays fixture into an isolated output directory without rewriting source fixtures', async (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-replay-output-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const sourceNormalized = `${fixtureDir}/replay-normalized.jsonl`
  const sourceSummary = `${fixtureDir}/replay-summary.json`
  const beforeNormalized = fs.readFileSync(sourceNormalized, 'utf8')
  const beforeSummary = fs.readFileSync(sourceSummary, 'utf8')

  const summary = await replayFixture(fixtureDir, {
    leagueConfigPath: 'config/monitored-leagues.json',
    outputDir,
  })

  assert.ok(fs.existsSync(path.join(outputDir, 'replay-normalized.jsonl')))
  assert.ok(fs.existsSync(path.join(outputDir, 'replay-summary.json')))
  assert.equal(fs.readFileSync(sourceNormalized, 'utf8'), beforeNormalized)
  assert.equal(fs.readFileSync(sourceSummary, 'utf8'), beforeSummary)
  assert.equal(summary.source.fixtureCounts.prematch, 20)
  assert.equal(summary.source.fixtureCounts.live, 18)
  assert.equal(summary.eventsByMode.prematch, 10)
  assert.equal(summary.eventsByMode.live, 5)
  assert.deepEqual(Object.keys(summary.byLeague).sort(), ['世界杯2026(美加墨)', '欧洲冠军联赛外围赛'])
  assert.ok(summary.totalRecords > 0)
  assert.ok(summary.byMarketType.asian_handicap > 0)
})

test('replay output uses portable source paths instead of local absolute paths', async (t) => {
  const fixtureDir = 'data/fixtures/crown/transform-xml'
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-replay-xml-output-'))
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }))
  const summary = await replayFixture(fixtureDir, {
    leagueConfigPath: '',
    outputDir,
  })

  const normalizedPath = path.join(outputDir, 'replay-normalized.jsonl')
  assert.ok(fs.existsSync(normalizedPath))
  assert.ok(fs.existsSync(path.join(outputDir, 'replay-summary.json')))
  const normalized = fs.readFileSync(normalizedPath, 'utf8')
  assert.equal(normalized.includes(path.resolve(fixtureDir)), false)
  assert.equal(normalized.includes('C:\\Users\\'), false)
  assert.equal(summary.source.xmlFiles, 5)
  assert.equal(summary.source.htmlFiles, 1)
  assert.equal(summary.source.invalidXmlFiles, 1)
  assert.equal(summary.source.detections['crown-transform-xml'] > 0, true)
  assert.equal(summary.eventsByMode.prematch >= 1, true)
  assert.equal(summary.eventsByMode.live >= 1, true)
  assert.deepEqual(Object.keys(summary.byMarketType).sort(), ['asian_handicap', 'total'])
  assert.equal(summary.byMarketType.total > 0, true)
  assert.equal(summary.warnings['missing-explicit-odds-id'] > 0, true)
})
