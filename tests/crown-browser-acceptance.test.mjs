import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createRealWorkerProvider } from '../src/crown/betting/real-worker-factory.mjs'
import { CROWN_BROWSER_TARGETS } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  listCrownCapabilities,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  claimAcceptanceDirection,
  claimAcceptanceDispatchInTransaction,
  createCrownAcceptanceCapabilityAuthority,
  createCrownAcceptanceWorkerConsumer,
  createCrownBrowserAcceptanceManifest,
  initializeCrownBrowserAcceptanceCampaign,
  inspectAcceptanceState,
  inspectCrownBrowserAcceptanceCampaign,
  loadActiveCrownAcceptanceCapabilityAuthority,
  settleAcceptanceDirection,
} from '../src/crown/betting/crown-browser-acceptance.mjs'
import { acceptanceCandidateFinder } from '../scripts/crown-betting-worker.mjs'

const SECRET = 'task-8-local-hmac-secret'

function frozenAcceptancePreview(manifest, direction, { gid = '1001', accountId = 'acceptance-account' } = {}) {
  return JSON.stringify({
    accountId,
    contextGeneration: 'acceptance-context-1',
    capabilityEvidenceId: direction.capabilityEvidenceId,
    capabilityVersion: manifest.capabilityVersion,
    lockedIdentity: {
      provider: 'crown', gid, mode: direction.mode, period: direction.period,
      market: direction.marketType, lineVariant: direction.lineVariant,
      line: '0.5', side: direction.selectionSide,
    },
    preview: {
      minStakeMinor: 50, maxStakeMinor: 500, stakeStepMinor: null,
      odds: '0.96', line: '0.5', submitCon: '1', submitRatio: '1',
      currency: 'CNY', amountScale: 0,
    },
  })
}

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-acceptance-')), name)
}

test('manifest fixes exactly eight unique canonical directions without promoting production capability', () => {
  const before = listCrownCapabilities().map((row) => ({
    key: row.key,
    previewAllowed: row.previewAllowed,
    submitAllowed: row.submitAllowed,
    reconciliationAllowed: row.reconciliationAllowed,
  }))
  const manifest = createCrownBrowserAcceptanceManifest({
    capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
  })

  assert.equal(manifest.schemaVersion, 'crown-browser-api-acceptance-v1')
  assert.equal(manifest.directions.length, 8)
  assert.equal(new Set(manifest.directions.map((direction) => direction.id)).size, 8)
  assert.deepEqual(manifest.directions.map((direction) => direction.ordinal), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(manifest.directions.map(({ id }) => id), CROWN_BROWSER_TARGETS.map(({ id }) => id))
  assert.deepEqual(listCrownCapabilities().map((row) => ({
    key: row.key,
    previewAllowed: row.previewAllowed,
    submitAllowed: row.submitAllowed,
    reconciliationAllowed: row.reconciliationAllowed,
  })), before)
  assert.deepEqual([
    before.filter((row) => row.previewAllowed).length,
    before.filter((row) => row.submitAllowed).length,
    before.filter((row) => row.reconciliationAllowed).length,
  ], [8, 1, 0])
})

test('runner counts only one direct accepted result per direction and terminal unknown stops all later claims', () => {
  const acceptedState = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  for (const direction of CROWN_BROWSER_TARGETS) {
    const claim = claimAcceptanceDirection(acceptedState, direction)
    settleAcceptanceDirection(acceptedState, {
      claimId: claim.claimId,
      direction,
      kind: 'accepted',
      amountMinor: 50,
    })
    assert.throws(() => settleAcceptanceDirection(acceptedState, {
      claimId: claim.claimId,
      direction,
      kind: 'accepted',
      amountMinor: 50,
    }), /acceptance-claim-settled/)
  }
  assert.deepEqual(inspectAcceptanceState(acceptedState), {
    status: 'completed', acceptedCount: 8, uniqueDirectionCount: 8,
    submitDispatchCount: 8, rejectedCount: 0, unknownCount: 0,
    duplicateAttemptCount: 0, authorizedMinimumTotalMinor: 400,
  })

  const stopped = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  const first = claimAcceptanceDirection(stopped, CROWN_BROWSER_TARGETS[0])
  settleAcceptanceDirection(stopped, {
    claimId: first.claimId, direction: CROWN_BROWSER_TARGETS[0], kind: 'unknown', amountMinor: 50,
  })
  assert.throws(() => claimAcceptanceDirection(stopped, CROWN_BROWSER_TARGETS[1]), /acceptance-terminal-unknown/)
  assert.equal(inspectAcceptanceState(stopped).acceptedCount, 0)
  assert.equal(inspectAcceptanceState(stopped).unknownCount, 1)
})

test('pre-dispatch cancellation consumes no Submit while rejected never counts as accepted', () => {
  const state = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  const first = claimAcceptanceDirection(state, CROWN_BROWSER_TARGETS[0])
  settleAcceptanceDirection(state, {
    claimId: first.claimId, direction: CROWN_BROWSER_TARGETS[0], kind: 'pre-dispatch-cancelled', amountMinor: 0,
  })
  const second = claimAcceptanceDirection(state, CROWN_BROWSER_TARGETS[0])
  settleAcceptanceDirection(state, {
    claimId: second.claimId, direction: CROWN_BROWSER_TARGETS[0], kind: 'rejected', amountMinor: 61,
  })
  const summary = inspectAcceptanceState(state)
  assert.equal(summary.submitDispatchCount, 1)
  assert.equal(summary.acceptedCount, 0)
  assert.equal(summary.rejectedCount, 1)
})

test('SQLite campaign is HMAC bound and only a branded Worker authority can elevate an exact direction', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db,
    manifest,
    secretKey: SECRET,
    candidateCatalog: listCrownCapabilities(),
  })
  const blockedDirection = manifest.directions.find((direction) => direction.selectionSide === 'home')
  assert.throws(() => authority.resolveCapability({ operation: 'preview', direction: blockedDirection }), /acceptance-candidate-claim/)
  assert.throws(() => authority.claimCandidate(manifest.directions[1]), /acceptance-ordinal/)
  const candidateClaim = authority.claimCandidate(manifest.directions[0])
  const previewElevated = authority.resolveCapability({
    operation: 'preview', direction: manifest.directions[0], candidateClaim,
  })
  assert.equal(previewElevated.submitAllowed, true)
  assert.equal(previewElevated.acceptanceOnly, true)
  const elevated = authority.resolveCapability({
    operation: 'submit', direction: manifest.directions[0], candidateClaim,
  })
  assert.equal(elevated.submitAllowed, true)
  assert.equal(elevated.acceptanceOnly, true)
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases SET state='accepted'
    WHERE campaign_id=? AND direction_id=?`).run(manifest.campaignId, manifest.directions[0].id)
  assert.throws(() => authority.resolveCapability({
    operation: 'preview', direction: manifest.directions[0], candidateClaim,
  }), /acceptance-direction-permit-unavailable/)
  assert.throws(() => claimAcceptanceDispatchInTransaction(handle.db, {
    direction: blockedDirection,
    childOrderId: 'forged-child',
    submitAttemptId: 'forged-attempt',
    capabilityVersion: manifest.capabilityVersion,
    capabilityEvidenceId: blockedDirection.capabilityEvidenceId,
    executionCandidateDigest: 'a'.repeat(64),
    amountMinor: 50,
  }), /acceptance-worker-authority-required/)

  handle.db.prepare("UPDATE crown_browser_acceptance_campaigns SET manifest_json=json_set(manifest_json,'$.capabilityVersion','tampered')").run()
  assert.throws(() => createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  }), /acceptance-manifest-hmac/)
  handle.close()
})

test('campaign state is sourced from SQLite and restart inspection cannot create a second dispatch', () => {
  const dbPath = tempPath('acceptance.sqlite')
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  const first = openAppDatabase({ dbPath })
  initializeCrownBrowserAcceptanceCampaign(first.db, { manifest, secretKey: SECRET })
  const before = inspectCrownBrowserAcceptanceCampaign(first.db, { manifest, secretKey: SECRET })
  first.close()
  const restarted = openAppDatabase({ dbPath })
  const after = inspectCrownBrowserAcceptanceCampaign(restarted.db, { manifest, secretKey: SECRET })
  assert.deepEqual(after, before)
  assert.equal(after.submitDispatchCount, 0)
  assert.equal(after.acceptedCount, 0)
  restarted.close()
})

test('acceptance Worker consumer claims only the next immutable ordinal', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  })
  const observed = []
  const consumer = createCrownAcceptanceWorkerConsumer({
    authority,
    findCandidate(direction) { observed.push(direction.ordinal); return { lockedSelection: { id: direction.id } } },
    async executeDirection({ direction, candidateClaim }) {
      assert.ok(candidateClaim)
      handle.db.prepare(`UPDATE crown_browser_acceptance_cases SET state='accepted',outcome='accepted'
        WHERE campaign_id=? AND direction_id=? AND state='pending'`).run(manifest.campaignId, direction.id)
      return { status: 'accepted' }
    },
  })
  assert.equal((await consumer.runOnce()).status, 'accepted')
  assert.equal((await consumer.runOnce()).status, 'accepted')
  assert.deepEqual(observed, [1, 2])
  handle.close()
})

test('direct accepted waits on durable validation and never looks up the next ordinal', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const direction = manifest.directions[0]
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases SET
    state='dispatched',dispatch_count=1,authorized_min_minor=50,
    child_order_id='acceptance-child',account_id='acceptance-account',submit_attempt_id='acceptance-attempt',
    execution_candidate_digest=?,frozen_preview_json=?
    WHERE campaign_id=? AND direction_id=?`).run(
    'a'.repeat(64), frozenAcceptancePreview(manifest, direction), manifest.campaignId, direction.id,
  )
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  })
  handle.db.exec('BEGIN IMMEDIATE')
  authority.settleDispatchInTransaction(handle.db, {
    childOrderId: 'acceptance-child', submitAttemptId: 'acceptance-attempt', kind: 'accepted',
    sealedProviderReference: 'sealed-reference', observedAt: '2026-07-15T00:00:00.000Z',
  })
  handle.db.exec('COMMIT')

  const summary = authority.inspect()
  assert.equal(summary.status, 'active')
  assert.equal(summary.acceptedCount, 0)
  assert.equal(summary.cases[0].state, 'validating')
  assert.equal(summary.cases[0].validation_poll_count, 0)
  assert.equal(summary.cases[0].validation_deadline_at, '2026-07-15T00:02:00.000Z')
  assert.deepEqual(authority.resolveReconciliation({ submitAttemptId: 'acceptance-attempt' }).expectedResultIdentity, {
    gid: '1001', bet_gtype: 'FT', bet_wtype: 'R', type: 'H',
    ioratio: '0.96', gold: '50', concede: '1',
  })

  let candidateCalls = 0
  let validationCalls = 0
  const consumer = createCrownAcceptanceWorkerConsumer({
    authority,
    findCandidate() { candidateCalls += 1; throw new Error('next-candidate-must-not-run') },
    async executeDirection() { throw new Error('next-submit-must-not-run') },
    async validateDirection({ submitAttemptId }) {
      validationCalls += 1
      assert.equal(submitAttemptId, 'acceptance-attempt')
      return { status: 'waiting_validation' }
    },
  })
  assert.deepEqual(await consumer.runOnce(), {
    status: 'waiting_validation', processed: 1, ordinal: 1, stop: false,
  })
  assert.equal(candidateCalls, 0)
  assert.equal(validationCalls, 1)
  assert.throws(() => authority.claimCandidate(manifest.directions[1]), /acceptance-direction-permit-unavailable|acceptance-ordinal/)
  handle.close()
})

test('recovery terminalizes a dispatched campaign and restart retains reconciliation-only authority', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const direction = manifest.directions[0]
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases SET state='dispatched',dispatch_count=1,
    child_order_id='recovery-child',account_id='recovery-account',submit_attempt_id='recovery-attempt',
    authorized_min_minor=20,execution_candidate_digest=? WHERE campaign_id=? AND direction_id=?`).run(
    'b'.repeat(64), manifest.campaignId, direction.id,
  )
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  })
  handle.db.exec('BEGIN IMMEDIATE')
  assert.equal(authority.recoverUnknownInTransaction(handle.db, {
    submitAttemptId: 'recovery-attempt', childOrderId: 'recovery-child',
  }), true)
  handle.db.exec('COMMIT')
  assert.equal(authority.inspect().status, 'terminal_unknown')
  const restarted = loadActiveCrownAcceptanceCapabilityAuthority({ database: handle.db, secretKey: SECRET })
  assert.ok(restarted)
  assert.throws(() => restarted.claimCandidate(direction), /permit-unavailable/)
  handle.close()
})

test('second Preview drift cancels the old case and persists a fresh case version before dispatch', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  })
  const claim = authority.claimCandidate(manifest.directions[0])
  const base = {
    accountId: 'account-a',
    browserSession: { contextGeneration: 'context-1' },
    capabilityEvidenceId: manifest.directions[0].capabilityEvidenceId,
    capabilityVersion: manifest.capabilityVersion,
    lockedIdentity: {
      provider: 'crown', gid: '1', mode: 'prematch', period: 'full_time',
      market: 'asian_handicap', lineVariant: 'main', line: '0', side: 'home',
    },
    executionPreview: {
      minStakeMinor: 20, maxStakeMinor: 100, stakeStepMinor: null,
      odds: '0.83', line: '0', submitCon: '0', submitRatio: '1', currency: 'CNY', amountScale: 0,
    },
  }
  authority.freezePreview(claim, base)
  assert.throws(() => authority.confirmPreview(claim, {
    ...base, executionPreview: { ...base.executionPreview, odds: '0.84' },
  }), /acceptance-preview-drift/)
  const rows = authority.inspect().cases.filter((item) => item.direction_id === manifest.directions[0].id)
  assert.deepEqual(rows.map((item) => [item.case_version, item.state, item.dispatch_count]), [
    [1, 'cancelled', 0], [2, 'pending', 0],
  ])
  const retryClaim = authority.claimCandidate(manifest.directions[0])
  assert.doesNotThrow(() => authority.freezePreview(retryClaim, base))
  assert.doesNotThrow(() => authority.confirmPreview(retryClaim, base))
  handle.close()
})

test('a frozen Preview whose context fails rotates to an empty retryable case version', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET })
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db, manifest, secretKey: SECRET, candidateCatalog: listCrownCapabilities(),
  })
  const direction = manifest.directions[0]
  const claim = authority.claimCandidate(direction)
  const preview = {
    accountId: 'account-a', browserSession: { contextGeneration: 'context-failed' },
    capabilityEvidenceId: direction.capabilityEvidenceId, capabilityVersion: manifest.capabilityVersion,
    lockedIdentity: { provider: 'crown', gid: '1', mode: direction.mode, period: direction.period,
      market: direction.marketType, lineVariant: direction.lineVariant, line: '0', side: direction.selectionSide },
    executionPreview: { minStakeMinor: 20, maxStakeMinor: 100, stakeStepMinor: null,
      odds: '0.83', line: '0', submitCon: '0', submitRatio: '1', currency: 'CNY', amountScale: 0 },
  }
  authority.freezePreview(claim, preview)
  authority.cancelPreviewCycle(claim, { reason: 'context-failed' })
  const retry = authority.claimCandidate(direction)
  const fresh = { ...preview, browserSession: { contextGeneration: 'context-fresh' } }
  assert.doesNotThrow(() => authority.freezePreview(retry, fresh))
  assert.doesNotThrow(() => authority.confirmPreview(retry, fresh))
  handle.close()
})

test('acceptance candidate finder requires a fresh selection from an active event', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const direction = createCrownBrowserAcceptanceManifest({
    capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
  }).directions[0]
  const eventKey = 'crown|football|gid=freshness'
  const selectionIdentity = `${eventKey}|full_time|asian_handicap|main|home`
  const snapshot = (capturedAt) => ({
    provider: 'crown',
    mode: direction.mode,
    capturedAt,
    event: { eventKey, mode: direction.mode, ids: { gid: 'freshness' } },
    market: {
      period: direction.period,
      marketType: direction.marketType,
      lineVariant: direction.lineVariant,
      lineKey: 'IOR_RH',
      marketIdentity: `${eventKey}|full_time|asian_handicap|main`,
      handicap: 0.5,
      handicapRaw: '0.5',
    },
    selection: {
      selectionIdentity,
      side: direction.selectionSide,
      oddsField: 'IOR_RH',
      oddsRaw: '0.96',
      suspended: false,
    },
  })
  const staleAt = new Date(Date.now() - 60_001).toISOString()
  handle.db.prepare(`INSERT INTO monitor_selection_state
    (selection_identity,event_key,captured_at,snapshot_json) VALUES (?,?,?,?)`).run(
    selectionIdentity, eventKey, staleAt, JSON.stringify(snapshot(staleAt)),
  )

  const findCandidate = acceptanceCandidateFinder(handle.db)
  assert.equal(findCandidate(direction), null)

  const freshAt = new Date(Date.now() - 10).toISOString()
  handle.db.prepare(`UPDATE monitor_selection_state SET captured_at=?,snapshot_json=?
    WHERE selection_identity=?`).run(freshAt, JSON.stringify(snapshot(freshAt)), selectionIdentity)
  assert.equal(findCandidate(direction), null)

  handle.db.prepare(`INSERT INTO monitor_event_state (
    event_key,match_group_key,active,missing_count,last_seen_at,provider_ids_json,event_json
  ) VALUES (?,?,0,0,?,'{}','{}')`).run(eventKey, eventKey, freshAt)
  assert.equal(findCandidate(direction), null)

  handle.db.prepare('UPDATE monitor_event_state SET active=1 WHERE event_key=?').run(eventKey)
  assert.equal(findCandidate(direction)?.selectionIdentity, selectionIdentity)

  const incompleteEventKey = 'crown|football|gid=incomplete-newer'
  const incompleteIdentity = `${incompleteEventKey}|full_time|asian_handicap|main|home`
  const incompleteAt = new Date().toISOString()
  const incomplete = snapshot(incompleteAt)
  incomplete.event = { eventKey: incompleteEventKey, mode: direction.mode, ids: { gid: 'incomplete-newer' } }
  incomplete.market = { ...incomplete.market, handicap: null, handicapRaw: null }
  incomplete.selection = { ...incomplete.selection, selectionIdentity: incompleteIdentity }
  handle.db.prepare(`INSERT INTO monitor_event_state (
    event_key,match_group_key,active,missing_count,last_seen_at,provider_ids_json,event_json
  ) VALUES (?,?,1,0,?,'{}','{}')`).run(incompleteEventKey, incompleteEventKey, incompleteAt)
  handle.db.prepare(`INSERT INTO monitor_selection_state
    (selection_identity,event_key,captured_at,snapshot_json) VALUES (?,?,?,?)`).run(
    incompleteIdentity, incompleteEventKey, incompleteAt, JSON.stringify(incomplete),
  )
  assert.equal(findCandidate(direction)?.selectionIdentity, selectionIdentity)
  handle.close()
})

test('acceptance CLI only initializes and inspects a campaign without loading Provider, B2 or Browser runtime', () => {
  const dbPath = tempPath('cli.sqlite')
  const keyPath = tempPath('cli-secret.key')
  fs.writeFileSync(keyPath, `${SECRET}\n`)
  const env = { ...process.env, CROWN_LOCAL_SECRET_KEY_PATH: keyPath }
  const init = spawnSync(process.execPath, [
    'scripts/crown-browser-api-acceptance.mjs', '--init', '--db-path', dbPath,
  ], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const initialized = JSON.parse(init.stdout)
  assert.equal(initialized.providerCalls.preview, 0)
  assert.equal(initialized.providerCalls.submit, 0)
  assert.equal(initialized.providerCalls.reconciliation, 0)
  const mirrorPath = path.join(path.dirname(dbPath), 'runtime', `crown-browser-api-acceptance.${initialized.campaignId}.safe.json`)
  assert.equal(fs.existsSync(mirrorPath), true)
  const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'))
  assert.equal(mirror.acceptedCount, 0)
  assert.equal(Object.hasOwn(mirror, 'cases'), false)
  fs.writeFileSync(mirrorPath, JSON.stringify({ acceptedCount: 8, providerReference: 'forged-secret' }))
  const inspect = spawnSync(process.execPath, [
    'scripts/crown-browser-api-acceptance.mjs', '--inspect', '--db-path', dbPath,
  ], { cwd: process.cwd(), env, encoding: 'utf8' })
  assert.equal(inspect.status, 0, inspect.stderr)
  assert.equal(JSON.parse(inspect.stdout).submitDispatchCount, 0)
  const rebuilt = JSON.parse(fs.readFileSync(mirrorPath, 'utf8'))
  assert.equal(rebuilt.acceptedCount, 0)
  assert.equal(Object.hasOwn(rebuilt, 'providerReference'), false)

  const source = fs.readFileSync('scripts/crown-browser-api-acceptance.mjs', 'utf8')
  assert.doesNotMatch(source, /crown-account-provider|b2-executor|real-worker-factory|playwright|browser-runtime/)
})

test('acceptance initializer CLI is excluded from Portable while the inactive Worker consumer stays included', () => {
  const allowlist = JSON.parse(fs.readFileSync('release/windows-production-allowlist.json', 'utf8'))
  assert.equal(allowlist.appFiles.includes('scripts/crown-browser-api-acceptance.mjs'), false)
  assert.equal(allowlist.appTrees.includes('src'), true)
  assert.equal(fs.existsSync('src/crown/betting/crown-browser-acceptance.mjs'), true)
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /crown-browser-api-acceptance.*\.json/)
})

test('Dashboard, API, env and real-worker factory cannot forge or initialize acceptance authority', () => {
  const sources = [
    'src/crown/app/app-api.mjs',
    'scripts/crown-dashboard.mjs',
    'src/crown/betting/real-worker-factory.mjs',
  ].map((file) => fs.readFileSync(file, 'utf8'))
  assert.doesNotMatch(sources[0], /createCrownAcceptanceCapabilityAuthority|initializeCrownBrowserAcceptanceCampaign/)
  assert.doesNotMatch(sources[1], /createCrownAcceptanceCapabilityAuthority|initializeCrownBrowserAcceptanceCampaign/)
  assert.doesNotMatch(sources[2], /createCrownAcceptanceCapabilityAuthority|initializeCrownBrowserAcceptanceCampaign/)
  assert.throws(() => createRealWorkerProvider({
    database: { prepare() {}, exec() {} },
    executorLease: {},
    reconcilerLease: {},
    env: { CROWN_ACCEPTANCE_AUTHORITY: 'forged' },
    acceptanceAuthority: { resolveCapability() {}, claimDispatchInTransaction() {} },
    factories: {},
  }), /real-worker-acceptance-authority/)
})
