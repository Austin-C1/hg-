import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  assertCrownCapability,
  assertCrownCapabilityFieldSets,
  capabilityKey,
  computeCrownCapabilityMatrixVersion,
  createCrownProtocolTemplateIndex,
  fingerprintCrownFieldSet,
  getCrownCapability,
  listCrownCapabilities,
  validateCrownExecutionEvidence,
  verifyCrownCapabilityMatrix,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  buildStrictCrownPreviewFields,
  buildStrictCrownPreviewWireFields,
  buildStrictCrownSubmitWireFields,
} from '../src/crown/betting/crown-order-field-mapper.mjs'

const FIXTURES_ROOT = path.resolve('data/fixtures/crown/betting-protocol')
const DIRECTIONS = Object.freeze([
  ['prematch', 'asian_handicap', 'home', 'RATIO_R', 'IOR_RH', 'R', 'H', 'RH', 'N'],
  ['prematch', 'asian_handicap', 'away', 'RATIO_R', 'IOR_RC', 'R', 'C', 'RC', 'N'],
  ['prematch', 'total', 'over', 'RATIO_OUO', 'IOR_OUC', 'OU', 'C', 'OUC', 'N'],
  ['prematch', 'total', 'under', 'RATIO_OUU', 'IOR_OUH', 'OU', 'H', 'OUH', 'N'],
  ['live', 'asian_handicap', 'home', 'RATIO_RE', 'IOR_REH', 'RE', 'H', 'REH', 'Y'],
  ['live', 'asian_handicap', 'away', 'RATIO_RE', 'IOR_REC', 'RE', 'C', 'REC', 'Y'],
  ['live', 'total', 'over', 'RATIO_ROUO', 'IOR_ROUC', 'ROU', 'C', 'ROUC', 'Y'],
  ['live', 'total', 'under', 'RATIO_ROUU', 'IOR_ROUH', 'ROU', 'H', 'ROUH', 'Y'],
])

function inputFor([mode, marketType, selectionSide]) {
  return { mode, period: 'full_time', marketType, lineVariant: 'main', selectionSide }
}

function recordFor(direction) {
  const [mode, marketType, selectionSide, ratioField, oddsField] = direction
  return {
    mode,
    event: { ids: { gid: `gid-${mode}-${marketType}-${selectionSide}` } },
    market: {
      period: 'full_time', marketType, lineVariant: 'main', ratioField,
      handicapRaw: marketType === 'total' ? '2.5' : '0.5 / 1',
    },
    selection: { side: selectionSide, oddsField },
  }
}

test('side-aware runtime library exposes exactly eight proven templates', () => {
  assert.notEqual(
    capabilityKey(inputFor(DIRECTIONS[0])),
    capabilityKey(inputFor(DIRECTIONS[1])),
  )
  const rows = listCrownCapabilities()
  assert.equal(Object.isFrozen(rows), true)
  assert.deepEqual([
    rows.length,
    rows.filter((row) => row.previewAllowed).length,
    rows.filter((row) => row.submitAllowed).length,
    rows.filter((row) => row.reconciliationAllowed).length,
  ], [8, 8, 4, 0])

  for (const direction of DIRECTIONS) {
    const [mode, marketType, selectionSide, ratioField, oddsField, wtype, choseTeam, rtype, isRB] = direction
    const row = getCrownCapability(inputFor(direction))
    assert.ok(row)
    assert.equal(Object.isFrozen(row), true)
    assert.equal(Object.isFrozen(row.mapperEvidence), true)
    assert.equal(row.key, `${mode}|full_time|${marketType}|main|${selectionSide}`)
    assert.deepEqual(row.endpoints, {
      preview: { path: '/transform.php', functionName: 'FT_order_view' },
      submit: { path: '/transform.php', functionName: 'FT_bet' },
      reconciliation: { path: null, functionName: null },
    })
    assert.deepEqual(row.mapperEvidence.ratioFields, [ratioField])
    assert.deepEqual(row.mapperEvidence.oddsFieldsBySide, { [selectionSide]: oddsField })
    assert.deepEqual(row.mapperEvidence.previewWireBySide, {
      [selectionSide]: { p: 'FT_order_view', gtype: 'FT', wtype, chose_team: choseTeam },
    })
    assert.deepEqual(row.mapperEvidence.submitWireBySide, {
      [selectionSide]: {
        p: 'FT_bet', gtype: 'FT', wtype, rtype, isRB, chose_team: choseTeam, f: '1R',
      },
    })
    assert.equal(row.acceptanceCandidate.allowed, true)
    assert.match(row.acceptanceCandidate.evidenceId, /^hmac-sha256:[a-f0-9]{64}$/)
    assert.match(row.protocolEvidenceDigest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(row.acceptanceCandidate.protocolEvidenceDigest, row.protocolEvidenceDigest)
    assert.equal(row.submitAllowed, mode === 'prematch')
    for (const dynamic of ['gid', 'odds', 'stake', 'balance', 'con', 'ratio', 'timestamp', 'uid', 'ver']) {
      assert.equal(Object.hasOwn(row.mapperEvidence.wireDefaults, dynamic), false)
      assert.equal(Object.hasOwn(row.mapperEvidence.previewWireBySide[selectionSide], dynamic), false)
      assert.equal(Object.hasOwn(row.mapperEvidence.submitWireBySide[selectionSide], dynamic), false)
      assert.equal(typeof row.mapperEvidence.dynamicFieldSources[dynamic], 'string')
    }
  }
  assert.equal(getCrownCapability({ mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main' }), null)
})

test('template index is O(1)-addressable, duplicate-safe, and deeply frozen', () => {
  const rows = listCrownCapabilities()
  const index = createCrownProtocolTemplateIndex(rows)
  assert.equal(index.size, 8)
  const away = index.get(inputFor(DIRECTIONS[1]))
  assert.equal(away.selectionSide, 'away')
  assert.equal(Object.isFrozen(away.mapperEvidence.previewWireBySide.away), true)
  assert.equal(index.get({ ...inputFor(DIRECTIONS[1]), selectionSide: '' }), null)
  assert.throws(() => createCrownProtocolTemplateIndex([rows[0], rows[0]]), /template-key/)
})

test('all eight Preview mappings come only from their side-specific template', () => {
  for (const direction of DIRECTIONS) {
    const [, , selectionSide, , , wtype, choseTeam] = direction
    const capability = getCrownCapability(inputFor(direction))
    const mapped = buildStrictCrownPreviewFields(recordFor(direction), { capability })
    assert.deepEqual(mapped.preview, {
      gid: recordFor(direction).event.ids.gid,
      gtype: 'FT',
      wtype,
      chose_team: choseTeam,
    })
    assert.equal(mapped.identity.side, selectionSide)
    const wire = buildStrictCrownPreviewWireFields(mapped.preview, {
      capability,
      protocolVersion: 'runtime-version',
      protocolVersionEvidence: {
        source: 'production-session-metadata', captured: true, verified: true,
      },
    })
    assert.deepEqual(Object.keys(wire).sort(), capability.requestFieldSet)
    assert.equal(wire.p, 'FT_order_view')
    assert.equal(wire.ver, 'runtime-version')
  }

  const homeCapability = getCrownCapability(inputFor(DIRECTIONS[0]))
  assert.throws(
    () => buildStrictCrownPreviewFields(recordFor(DIRECTIONS[1]), { capability: homeCapability }),
    /selectionSide/,
  )
})

test('all accepted prematch handicap and total capabilities can build Submit wire fields', () => {
  const home = getCrownCapability(inputFor(DIRECTIONS[0]))
  const away = getCrownCapability(inputFor(DIRECTIONS[1]))
  assert.equal(assertCrownCapability(home, { operation: 'submit' }).selectionSide, 'home')
  assert.equal(assertCrownCapability(away, { operation: 'submit' }).selectionSide, 'away')
  assert.equal(assertCrownCapability(getCrownCapability(inputFor(DIRECTIONS[2])), { operation: 'submit' }).selectionSide, 'over')
  assert.equal(assertCrownCapability(getCrownCapability(inputFor(DIRECTIONS[3])), { operation: 'submit' }).selectionSide, 'under')

  const lockedIdentity = {
    provider: 'crown', gid: 'gid-away', mode: 'prematch', period: 'full_time',
    market: 'asian_handicap', lineVariant: 'main', line: '0.5 / 1', side: 'away',
  }
  const wire = buildStrictCrownSubmitWireFields({
    lockedIdentity,
    currentIdentity: { ...lockedIdentity },
    preview: {
      lockedIdentity: { ...lockedIdentity }, line: '0.5 / 1', currency: 'CNY', amountScale: 0,
      minStakeMinor: 50, maxStakeMinor: 20000, balanceMinor: 20000,
      stakeStepMinor: 50, stakeStepProvenance: 'local-conservative-policy',
      odds: '0.96', submitCon: '1', submitRatio: '50',
    },
    amountMinor: 50,
  }, {
    capability: away,
    protocolVersion: 'runtime-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  })
  assert.deepEqual({
    chose_team: wire.chose_team, wtype: wire.wtype, rtype: wire.rtype,
    isRB: wire.isRB, f: wire.f, golds: wire.golds,
  }, { chose_team: 'C', wtype: 'R', rtype: 'RC', isRB: 'N', f: '1R', golds: '50' })
  assert.match(wire.timestamp, /^\d{13}$/)
  assert.deepEqual(Object.keys(wire).sort(), away.submitRequestFieldSet)
})

test('public assertions reject forged metadata and preserve exact field sets', () => {
  const row = getCrownCapability(inputFor(DIRECTIONS[4]))
  const forged = { ...row, submitAllowed: true }
  assert.throws(() => assertCrownCapability(forged), /metadata-mismatch/)
  assert.doesNotThrow(() => assertCrownCapabilityFieldSets(row, {
    requestFieldSet: [...row.requestFieldSet].reverse(),
    responseFieldSet: [...row.responseFieldSet].reverse(),
  }))
  assert.throws(() => assertCrownCapabilityFieldSets(row, {
    responseFieldSet: [...row.responseFieldSet, 'drift'],
  }), /response-field-set/)
  assert.equal(row.responseFieldSetFingerprint, fingerprintCrownFieldSet(row.responseFieldSet))
})

test('runtime matrix is self-contained while fixture audit remains explicit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-runtime-no-fixtures-'))
  const sourceFile = path.resolve('src/crown/betting/crown-capability-matrix.mjs')
  const missingFixtures = path.join(root, 'missing-fixtures')
  const source = fs.readFileSync(sourceFile, 'utf8').replace(
    /const DEFAULT_FIXTURES_ROOT = .*\r?\n/,
    `const DEFAULT_FIXTURES_ROOT = ${JSON.stringify(missingFixtures)}\n`,
  )
  const moduleFile = path.join(root, 'crown-capability-matrix.mjs')
  fs.writeFileSync(moduleFile, source)
  const runtime = await import(`${pathToFileURL(moduleFile).href}?noFixtures=1`)
  assert.equal(runtime.listCrownCapabilities().length, 8)
  assert.equal(runtime.getCrownCapability(inputFor(DIRECTIONS[1])).submitAllowed, true)
  const audit = runtime.verifyCrownCapabilityMatrix()
  assert.equal(audit.ok, false)
  assert.match(audit.errors.join('\n'), /missing/)
})

test('explicit protocol audit verifies Task2 artifacts and accepted evidence', () => {
  const result = verifyCrownCapabilityMatrix()
  assert.deepEqual(result, {
    ok: true,
    matrixVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    rowCount: 8,
    provisionalCount: 0,
    allowedPreviewCount: 8,
    allowedSubmitCount: 4,
    allowedReconciliationCount: 0,
    errors: [],
  })
  assert.equal(computeCrownCapabilityMatrixVersion(listCrownCapabilities()), CROWN_CAPABILITY_MATRIX_VERSION)
})

test('all eight Preview response contracts are exactly the Task2 observed safe field set', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(
    FIXTURES_ROOT,
    'artifacts/20260714-1848-static-wire-evidence.safe.json',
  ), 'utf8'))
  const observed = artifact.entries.find((entry) => entry.functionName === 'FT_order_view'
    && !entry.response.fields.some(({ name }) => name === '[*]'))
    .response.fields.map(({ name }) => name).sort()

  for (const row of listCrownCapabilities()) {
    assert.deepEqual(row.responseFieldSets.preview, observed)
    assert.equal(row.responseFieldSets.preview.includes('score'), false)
  }
})

test('explicit verifier rejects self-consistent row forgery and cannot skip evidence audit', () => {
  const rows = structuredClone(listCrownCapabilities())
  rows[4].mapperEvidence.ratioFields = ['RATIO_FORGED']
  rows[4].responseFieldSet.push('forged_response')
  rows[4].responseFieldSets.preview.push('forged_response')
  rows[4].responseFieldSetFingerprint = fingerprintCrownFieldSet(rows[4].responseFieldSet)

  const result = verifyCrownCapabilityMatrix({ rows, auditFixtures: false })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /canonical|field-sets|task2/)
})

test('matrix version excludes capture-specific acceptance candidates but binds Submit authority', () => {
  const rows = structuredClone(listCrownCapabilities())
  const baseline = computeCrownCapabilityMatrixVersion(rows)
  rows[4].acceptanceCandidate = {
    allowed: true,
    evidenceId: `hmac-sha256:${'1'.repeat(64)}`,
    protocolEvidenceDigest: `sha256:${'2'.repeat(64)}`,
  }
  rows[4].evidenceId = 'replacement-preview-capture'
  assert.equal(computeCrownCapabilityMatrixVersion(rows), baseline)

  rows[0].evidenceId = 'replacement-promoted-evidence'
  assert.notEqual(computeCrownCapabilityMatrixVersion(rows), baseline)
})

test('Task2 artifact drift invalidates explicit audit without affecting runtime lookup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capability-audit-drift-'))
  fs.cpSync(FIXTURES_ROOT, root, { recursive: true })
  const file = path.join(root, 'artifacts', '20260714-1848-eight-direction-candidates.safe.json')
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
  artifact.candidates[0].dispatchCount = 1
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`)
  const result = verifyCrownCapabilityMatrix({ fixturesRoot: root })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /task2:(?:candidates|prematch-full-time-asian-handicap-home)/)
  assert.equal(getCrownCapability(inputFor(DIRECTIONS[0])).previewAllowed, true)
})

test('accepted prematch promotion drift invalidates explicit audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-prematch-promotion-drift-'))
  fs.cpSync(FIXTURES_ROOT, root, { recursive: true })
  const file = path.join(root, 'artifacts', '20260715-prematch-submit-accepted.safe.json')
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
  artifact.directions[0].dispatchCount = 2
  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`)
  const result = verifyCrownCapabilityMatrix({ fixturesRoot: root })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /accepted-prematch/)
})

test('legacy execution evidence validator remains fail-closed', () => {
  const result = validateCrownExecutionEvidence({})
  assert.equal(result.evidenceIncomplete, true)
  assert.equal(result.previewEvidenceComplete, false)
  assert.equal(result.submitEvidenceComplete, false)
  assert.ok(result.errors.includes('capability-required'))
  assert.ok(result.errors.includes('accepted-evidence-required'))
})

test('all committed evidence files remain sanitized', () => {
  const files = [
    'artifacts/20260714-1848-eight-direction-candidates.safe.json',
    'artifacts/20260714-1848-static-wire-evidence.safe.json',
    'artifacts/20260714-1848-protocol-catalog.safe.json',
    'prematch-full-time-asian-handicap-main.accepted.json',
    'artifacts/20260714-085221-accepted.safe.json',
    'artifacts/20260714-085221-watcher.safe.json',
    'artifacts/20260715-prematch-submit-accepted.safe.json',
  ]
  for (const relative of files) {
    const text = fs.readFileSync(path.join(FIXTURES_ROOT, relative), 'utf8')
    assert.doesNotMatch(text, /\b(?:cookie|uid|token|ticket|password|authorization)\b/i)
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/(?:Users|home|tmp)\//i)
    assert.doesNotMatch(text, /data[\\/]runtime/i)
    assert.doesNotThrow(() => JSON.parse(text))
  }
})
