import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import {
  prepareAuthorizedSubmit,
  prepareSubmitAttempt,
  recordAuthorizedDispatch,
  recordAuthorizedOutcome,
  recordSubmitDispatch,
  recordSubmitOutcome,
} from '../src/crown/betting/b2-executor.mjs'
import { encryptSecret } from '../src/crown/app/app-secret.mjs'
import { lockReverseSelection } from '../src/crown/betting/locked-selection.mjs'
import { CROWN_CAPABILITY_MATRIX_VERSION } from '../src/crown/betting/crown-capability-matrix.mjs'
import { collectRealBettingPreflight, evaluatePureModePreflight, evaluateRealBettingPreflight } from '../src/crown/betting/real-betting-runtime.mjs'
import {
  assertExecutionGate,
  authorizeExecution,
  revokeAutoBettingModeEligibility,
  upgradeAutoBettingModeEligibility,
} from '../src/crown/betting/execution-gate.mjs'

const NOW = '2026-07-12T00:00:00.000Z'
const ENV = {
  CROWN_REAL_CURRENCY: 'CNY',
  CROWN_REAL_AMOUNT_SCALE: '0',
  CROWN_REAL_MAX_TOTAL_MINOR: '1000',
}
const eligibilityConfirmation = (mode = 'prematch', version = 1) =>
  `UPGRADE AUTO BETTING ${mode} ELIGIBILITY ${version} CNY/0/1000 ${CROWN_CAPABILITY_MATRIX_VERSION}`

function setting(db, mode = 'prematch') {
  return db.prepare('SELECT * FROM auto_betting_settings WHERE mode=?').get(mode)
}

function enableSetting(db, mode = 'prematch') {
  db.prepare(`
    UPDATE auto_betting_settings
    SET enabled=1, target_odds_min='0.8', target_odds_max='1.2',
        target_amount_minor=100, migration_review_required=0, version=3,
        updated_at=?
    WHERE mode=?
  `).run(NOW, mode)
}

function insertSignal(db, signalId, payload = {}) {
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES (?, ?, 'mode-test', 1, 'ready', ?, '2026-07-12T00:05:00.000Z', ?)
  `).run(signalId, signalId, NOW, JSON.stringify(payload))
}

function insertAccount(db, accountId = 'account-a') {
  db.prepare(`
    INSERT INTO betting_accounts (
      id,label,username,status,archived,allocation_status,secret_ciphertext,
      currency,amount_scale,per_bet_limit_minor,stake_step_minor,balance_minor,
      bet_order,created_at,updated_at
    ) VALUES (?, ?, ?, 'enabled', 0, 'enabled', 'fixture', 'CNY', 0, 1000, 10, 1000, 1, ?, ?)
  `).run(accountId, accountId, accountId, NOW, NOW)
}

function executionSignal(signalId = 'signal-execution') {
  const eventIdentity = 'crown|football|gid=mode-1'
  const marketIdentity = `${eventIdentity}|full_time|asian_handicap|RATIO_RE`
  return {
    signalId, observedAt: NOW, expiresAt: '2026-07-12T00:05:00.000Z',
    target: { eventIdentity, marketIdentity, selectionIdentity: `${marketIdentity}|home`, side: 'home' },
    evidence: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', handicap: -0.5,
      handicapRaw: '-0.5', minutesBeforeKickoff: 60, leagueName: 'Mode League' },
  }
}

function executionSelection(signal = executionSignal()) {
  return {
    provider: 'crown', mode: 'prematch', capturedAt: '2026-07-12T00:00:01.000Z',
    event: { eventKey: signal.target.eventIdentity, mode: 'prematch', livePhase: null },
    market: { marketIdentity: signal.target.marketIdentity, period: 'full_time', marketType: 'asian_handicap',
      lineVariant: 'main', lineKey: 'RATIO_RE', handicap: -0.5, handicapRaw: '-0.5' },
    selection: { selectionIdentity: `${signal.target.marketIdentity}|away`, side: 'away', odds: '0.96', suspended: false },
  }
}

function processingInbox(db, signalId, settingsSnapshot, ownerId = 'inbox-owner') {
  const expiresAt = '2026-07-12T00:01:00.000Z'
  const cardId = `legacy-mode:${signalId}`
  const cardVersion = settingsSnapshot.version
  const { mode: _mode, ...modeFree } = settingsSnapshot
  const cardSnapshot = { cardId, name: cardId, leagueNames: ['Mode League'], ...modeFree }
  db.prepare(`
    INSERT INTO auto_betting_signal_inbox (
      signal_id, card_id, card_version, card_snapshot_json,
      mode, settings_version, settings_snapshot_json, status,
      next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', '', ?, ?, ?, ?)
  `).run(signalId, cardId, cardVersion, JSON.stringify(cardSnapshot), settingsSnapshot.mode,
    settingsSnapshot.version, JSON.stringify(settingsSnapshot), ownerId, expiresAt, NOW, NOW)
  return { ownerId, expiresAt }
}

function persistSelection(db, selection) {
  db.prepare(`
    INSERT OR REPLACE INTO monitor_selection_state (selection_identity, event_key, captured_at, snapshot_json)
    VALUES (?, ?, ?, ?)
  `).run(selection.selection.selectionIdentity, selection.event.eventKey, selection.capturedAt, JSON.stringify(selection))
}

test('mode eligibility has a dedicated versioned audited lifecycle and ordinary settings version is independent', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const before = setting(handle.db)
  const confirmation = eligibilityConfirmation()

  assert.throws(() => upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', confirmation: 'wrong', expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) }), /mode-eligibility-confirmation/)

  const upgraded = upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', confirmation, expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) })
  assert.equal(upgraded.realEligible, true)
  assert.equal(upgraded.realEligibilityVersion, 2)
  assert.equal(setting(handle.db).version, before.version)
  assert.equal(setting(handle.db).real_eligible, 1)

  const audit = handle.db.prepare(`
    SELECT * FROM execution_security_audit
    WHERE subject_type='auto_betting_mode' AND subject_id='prematch'
  `).get()
  assert.equal(audit.action, 'auto_betting_mode_eligibility_upgraded')
  assert.match(audit.confirmation_digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(audit), /UPGRADE AUTO BETTING/)
  assert.equal(JSON.parse(audit.details_json).capabilityMatrixVersion, CROWN_CAPABILITY_MATRIX_VERSION)

  const revoked = revokeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', expectedEligibilityVersion: 2,
  }, { now: () => new Date(NOW) })
  assert.equal(revoked.realEligible, false)
  assert.equal(revoked.realEligibilityVersion, 3)
  handle.close()
})

test('database execution scope is strict XOR for legacy rule and mode settings identities', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const insert = (ruleId, bettingMode, settingsVersion, key) => handle.db.prepare(`
    INSERT INTO bet_market_once_claims (
      market_once_key, rule_id, betting_mode, settings_version, signal_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'signal', ?, ?)
  `).run(key, ruleId, bettingMode, settingsVersion, NOW, NOW)
  assert.throws(() => insert('legacy-rule', 'prematch', 1, 'mixed'), /settings-scope-constraint|CHECK constraint/)
  assert.throws(() => insert(null, null, null, 'empty'), /settings-scope-constraint|CHECK constraint/)
  assert.doesNotThrow(() => insert('legacy-rule', null, null, 'legacy'))
  assert.doesNotThrow(() => insert(null, 'prematch', 1, 'mode'))
  handle.close()
})

test('mode authorization is isolated from legacy rule scope and requires current eligibility version', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch',
    confirmation: eligibilityConfirmation(),
    expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) })
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:mode-test', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  assert.throws(() => authorizeExecution(handle.db, {
    authorizationId: 'auth-mode-stale', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], eligibilityVersions: { prematch: 1 },
    maxTotalAmountMinor: 200, confirmation: 'AUTHORIZE STALE MODE',
  }, { env: ENV, now: () => new Date(NOW) }), /mode-eligibility-version/)
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'auth-mode', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], eligibilityVersions: { prematch: 2 },
    maxTotalAmountMinor: 200, confirmation: 'AUTHORIZE MODE',
  }, { env: ENV, now: () => new Date(NOW) })

  assert.deepEqual(authorization.ruleIds, [])
  assert.deepEqual(authorization.bettingModes, ['prematch'])
  assert.deepEqual(authorization.eligibilityVersions, { prematch: 2 })
  assert.doesNotThrow(() => assertExecutionGate(handle.db, {
    authorizationId: authorization.authorizationId, bettingMode: 'prematch',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: ENV, now: () => new Date(NOW) }))
  assert.throws(() => assertExecutionGate(handle.db, {
    authorizationId: authorization.authorizationId, ruleId: 'legacy-rule',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: ENV, now: () => new Date(NOW) }), /authorization-rule-scope/)

  revokeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', expectedEligibilityVersion: 2,
  }, { now: () => new Date(NOW) })
  assert.throws(() => assertExecutionGate(handle.db, {
    authorizationId: authorization.authorizationId, bettingMode: 'prematch',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
  }, { env: ENV, now: () => new Date(NOW) }), /mode-eligibility-version/)
  handle.close()
})

test('real preflight ignores legacy mode authorization and hard-cap settings', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  enableSetting(handle.db, 'live')
  upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', confirmation: eligibilityConfirmation(), expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) })
  upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'live', confirmation: eligibilityConfirmation('live'), expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) })
  authorizeExecution(handle.db, {
    authorizationId: 'auth-mode-preflight', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], eligibilityVersions: { prematch: 2 },
    maxTotalAmountMinor: 100, confirmation: 'AUTHORIZE MODE PREFLIGHT',
  }, { env: ENV, now: () => new Date(NOW) })
  const checks = collectRealBettingPreflight(handle.db, {
    env: ENV, dbPath: ':memory:', now: () => new Date(NOW), runtimeDir: 'missing-runtime-dir',
  })
  assert.equal(Object.hasOwn(checks, 'authorizationActive'), false)
  assert.equal(Object.hasOwn(checks, 'environmentExact'), false)
  assert.equal(checks.ruleCardsEnabled, false)
  assert.equal(checks.capabilityExact, false)
  handle.db.prepare("UPDATE auto_betting_settings SET target_amount_minor=1000 WHERE mode='prematch'").run()
  assert.equal(collectRealBettingPreflight(handle.db, {
    env: ENV, dbPath: ':memory:', now: () => new Date(NOW), runtimeDir: 'missing-runtime-dir',
  }).ruleCardsEnabled, false)
  handle.db.prepare("UPDATE auto_betting_settings SET target_amount_minor=1001 WHERE mode='prematch'").run()
  const legacyOverCap = collectRealBettingPreflight(handle.db, {
    env: ENV, dbPath: ':memory:', now: () => new Date(NOW), runtimeDir: 'missing-runtime-dir',
  })
  assert.equal(Object.hasOwn(legacyOverCap, 'authorizationActive'), false)
  assert.equal(evaluateRealBettingPreflight(legacyOverCap).blockingReasons.includes('authorization-not-active'), false)
  handle.close()
})

test('pure capability evaluator ignores eligibility, hard cap, and reconciliation while remaining mode-exact', () => {
  const settings = [{ mode: 'prematch', enabled: true }]
  const verified = [{ mode: 'prematch', evidenceStatus: 'verified', previewAllowed: true, submitAllowed: true, reconciliationAllowed: false }]
  assert.deepEqual(evaluatePureModePreflight({
    authorizedModes: ['live'], eligibilityVersions: { live: 999 }, settings, capabilities: verified, hardCapAmountMinor: 0,
  }),
    { scopeExact: true, capabilityExact: true })
  assert.equal(evaluatePureModePreflight({ settings: [{ ...settings[0], enabled: false }], capabilities: verified }).scopeExact, false)
  assert.equal(evaluatePureModePreflight({ settings: [...settings, { mode: 'live', enabled: true }], capabilities: verified }).capabilityExact, false)
})

test('mode batch identity and reservations are atomic without a synthetic rule', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  insertSignal(handle.db, 'signal-mode')
  insertAccount(handle.db)
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:mode-batch', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  const store = new BetBatchStore(handle.db, {
    leaseKey: lease.leaseKey, fencingToken: lease.fencingToken, now: () => NOW,
  })
  const input = {
    signalId: 'signal-mode', bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot: { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 },
    eventKey: 'event', lockedSelectionIdentity: 'selection', sourceLeague: 'League',
    sourceOdds: '0.95', observedAt: NOW, currency: 'CNY', amountScale: 0,
    targetAmountMinor: 100, createdAt: NOW,
  }
  const allocations = [{
    accountId: 'account-a', amountMinor: 100, previewMinStakeMinor: 10,
    previewMaxStakeMinor: 1000, previewBalanceMinor: 1000,
    previewStakeStepMinor: 10, previewOdds: '0.96',
  }]
  const created = store.createModeScopedBatchWithReservations(input, allocations, {
    fencingToken: lease.fencingToken,
  })
  const row = handle.db.prepare('SELECT * FROM bet_batches WHERE batch_id=?').get(created.batch.batchId)
  assert.equal(row.rule_id, null)
  assert.equal(row.betting_mode, 'prematch')
  assert.equal(row.settings_version, 3)
  assert.equal(row.settings_snapshot_json, JSON.stringify(input.settingsSnapshot))

  const duplicate = store.createModeScopedBatchWithReservations(input, allocations, {
    fencingToken: lease.fencingToken,
  })
  assert.equal(duplicate.batch.batchId, created.batch.batchId)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_batches').get().count, 1)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_child_orders').get().count, 1)
  handle.close()
})

test('authorized mode reservations bind budget atomically without legacy rule scope', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  upgradeAutoBettingModeEligibility(handle.db, {
    mode: 'prematch', confirmation: eligibilityConfirmation(),
    expectedEligibilityVersion: 1,
  }, { env: ENV, now: () => new Date(NOW) })
  insertSignal(handle.db, 'signal-auth-mode')
  insertAccount(handle.db)
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:authorized-mode', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'auth-mode-budget', currency: 'CNY', amountScale: 0,
    bettingModes: ['prematch'], eligibilityVersions: { prematch: 2 },
    maxTotalAmountMinor: 100, confirmation: 'AUTHORIZE MODE BUDGET',
  }, { env: ENV, now: () => new Date(NOW) })
  const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
  const persistedEnvelope = {
    provider: 'crown', eventKey: 'crown|football|gid=1', period: 'full_time',
    marketType: 'asian_handicap', lineKey: 'line', side: 'away',
    selectionIdentity: 'crown|football|gid=1|full_time|asian_handicap|line|away',
    snapshot: { provider: 'crown', mode: 'prematch', event: { eventKey: 'crown|football|gid=1', ids: { gid: '1' } },
      market: { period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main', lineKey: 'line', handicap: -0.5, handicapRaw: '-0.5' },
      selection: { side: 'away', selectionIdentity: 'crown|football|gid=1|full_time|asian_handicap|line|away' } },
  }
  const created = store.createAuthorizedModeScopedBatchWithReservations({
    signalId: 'signal-auth-mode', bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot: { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 },
    authorizationId: authorization.authorizationId, eventKey: 'event', lockedSelectionIdentity: JSON.stringify(persistedEnvelope),
    currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW,
  }, [{ accountId: 'account-a', amountMinor: 100, previewMinStakeMinor: 10,
    previewMaxStakeMinor: 1000, previewBalanceMinor: 1000, previewStakeStepMinor: 10, previewOdds: '0.96' }], {
    fencingToken: lease.fencingToken, authorizationId: authorization.authorizationId,
    executorOwnerId: lease.ownerId, authorizationOptions: { env: ENV, now: () => new Date(NOW) },
  })
  assert.equal(created.children.length, 1)
  assert.equal(handle.db.prepare('SELECT reserved_amount_minor FROM execution_authorizations').get().reserved_amount_minor, 100)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count, 1)
  const identity = { provider: 'fixture', gid: '1', mode: 'prematch', period: 'full_time', market: 'asian_handicap', lineVariant: 'main', line: '-0.5', side: 'away' }
  const prepareInput = {
    authorizationId: authorization.authorizationId, bettingMode: 'prematch',
    leaseKey: lease.leaseKey, executorOwnerId: lease.ownerId, fencingToken: lease.fencingToken,
    childOrderId: created.children[0].childOrderId, batchId: created.batch.batchId, accountId: 'account-a',
    submitAttemptId: 'mode-submit-attempt-1', attemptOrdinal: 1,
    capabilityEvidenceId: 'fixture:b2-ledger:offline:v1', capabilityVersion: 'b2-ledger-fixture-v1',
    lockedIdentity: identity, currentIdentity: identity,
    preview: { minStakeMinor: 10, maxStakeMinor: 1000, balanceMinor: 1000, stakeStepMinor: 10, odds: '0.96', line: '-0.5' },
  }
  assert.throws(() => prepareAuthorizedSubmit(handle.db, prepareInput, { env: ENV, now: () => new Date(NOW) }), /settings-version/)
  const prepared = prepareAuthorizedSubmit(handle.db, { ...prepareInput, settingsVersion: 3 }, { env: ENV, now: () => new Date(NOW) })
  assert.equal(prepared.child.status, 'submit_prepared')
  handle.close()
})

test('coordinator refuses mode creation when latest DB selection cannot be revalidated', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const adapterSignal = { signalId: 'signal-adapter', evidence: { mode: 'prematch' } }
  insertSignal(handle.db, 'signal-adapter', adapterSignal)
  insertAccount(handle.db)
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:mode-adapter', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
  const provider = {
    async preview() { return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' } },
    async submit() { return { status: 'accepted' } },
  }
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db, store, provider, lease, findLatestSelection: () => null, now: () => NOW,
  })
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const payload = {
    signalId: 'signal-adapter', bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot, marketOnceKey: 'mode-once-key', executionMode: 'simulated',
    lockedSelection: { eventKey: 'event', selectionIdentity: 'selection' },
    signal: adapterSignal,
  }
  payload.inboxLease = processingInbox(handle.db, payload.signalId, settingsSnapshot)
  assert.equal(coordinator.claimAndCreateModeScopedBatch.ready, true)
  await assert.rejects(() => coordinator.claimAndCreateModeScopedBatch(payload), /latest-selection-required/)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  handle.close()
})

test('every mode atomic crash point rolls back claim, batch, children, and locks', () => {
  for (const phase of ['mode:after-claim-insert', 'mode:after-batch-insert', 'mode:after-reservations', 'mode:after-claim-transition']) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    enableSetting(handle.db)
    const signal = executionSignal(`signal-${phase}`)
    const selection = executionSelection(signal)
    insertSignal(handle.db, signal.signalId, signal)
    persistSelection(handle.db, selection)
    insertAccount(handle.db)
    const lease = new RuntimeLease({
      db: handle.db, leaseKey: `betting-executor:${phase}`, ownerId: 'owner',
      pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
    })
    lease.acquire()
    const store = new BetBatchStore(handle.db, {
      leaseKey: lease.leaseKey, now: () => NOW,
      faultInjector(current) { if (current === phase) throw new Error(`crash:${phase}`) },
    })
    const settingsSnapshot = { mode: 'prematch', version: 3, targetOddsMin: '0.8', targetOddsMax: '1.2' }
    const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
    const lockedSelection = lockReverseSelection(signal, () => selection)
    assert.throws(() => store.claimAndCreateModeScopedBatch({
      signalId: signal.signalId, signalSnapshot: signal, bettingMode: 'prematch', settingsVersion: 3,
      settingsSnapshot, inboxLease, lockedSelection, currency: 'CNY', amountScale: 0,
      targetAmountMinor: 100, createdAt: NOW,
    }, [{ accountId: 'account-a', amountMinor: 100, previewMinStakeMinor: 10,
      previewMaxStakeMinor: 1000, previewBalanceMinor: 1000, previewStakeStepMinor: 10 }], {
      marketOnceKey: `market-${phase}`, fencingToken: lease.fencingToken,
    }), new RegExp(`crash:${phase}`))
    for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
      assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${phase}:${table}`)
    }
    handle.close()
  }
})

test('no account capacity returns before ownership and leaves no orphan claim', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  insertSignal(handle.db, 'signal-no-capacity')
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:no-capacity', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db, store, lease, now: () => NOW, findLatestSelection: () => null,
    provider: { async preview() { throw new Error('must-not-preview') }, async submit() {} },
  })
  const result = await coordinator.claimAndCreateModeScopedBatch({
    signalId: 'signal-no-capacity', bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot: { mode: 'prematch', version: 3, enabled: true, targetAmountMinor: 100, currency: 'CNY', amountScale: 0 },
    marketOnceKey: 'no-capacity-key', executionMode: 'simulated',
    lockedSelection: { eventKey: 'event', selectionIdentity: 'selection' },
    signal: { signalId: 'signal-no-capacity', evidence: { mode: 'prematch' } },
  })
  assert.deepEqual(result, { status: 'skipped', reason: 'no-account-capacity' })
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  handle.close()
})

test('atomic mode batch persists locked evidence and completes through coordinator runBatch', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const signal = executionSignal()
  insertSignal(handle.db, signal.signalId, signal)
  insertAccount(handle.db)
  const selection = executionSelection(signal)
  persistSelection(handle.db, selection)
  const lease = new RuntimeLease({
    db: handle.db, leaseKey: 'betting-executor:mode-e2e', ownerId: 'owner',
    pid: 1, ttlMs: 60_000, now: () => new Date(NOW),
  })
  lease.acquire()
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }),
    lease, now: () => NOW, findLatestSelection: () => selection,
    provider: {
      async preview() { return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' } },
      async submit() { return { status: 'accepted', providerReference: 'fixture-accepted' } },
    },
  })
  const lockedSelection = lockReverseSelection(signal, () => selection)
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
  const created = await coordinator.claimAndCreateModeScopedBatch({
    signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot, inboxLease, lockedSelection, marketOnceKey: 'mode-e2e-once', executionMode: 'simulated',
  })
  assert.equal(created.status, 'batch_created')
  const result = await coordinator.runBatch(created.batchId, { mode: 'simulated' })
  assert.equal(result.status, 'completed')
  assert.equal(result.finishReason, 'all_accepted')
  assert.equal(handle.db.prepare('SELECT status FROM bet_child_orders').get().status, 'accepted')
  handle.close()
})

test('real mode batch reaches neutral B2 prepare, dispatch, and accepted result without live I/O', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const signal = executionSignal('signal-real-e2e')
  const selection = executionSelection(signal)
  insertSignal(handle.db, signal.signalId, signal)
  persistSelection(handle.db, selection)
  insertAccount(handle.db)
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, migrationReviewRequired: false, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
  const executorLease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:mode-real-e2e', ownerId: 'executor', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  const workerLease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-worker:mode-real-e2e', ownerId: 'worker', pid: 2, ttlMs: 60_000, now: () => new Date(NOW) })
  executorLease.acquire(); workerLease.acquire()
  handle.db.prepare("UPDATE runtime_leases SET expires_at='2099-01-01T00:00:00.000Z'").run()
  handle.db.prepare("UPDATE real_betting_runtime SET requested=1,runtime_state='running',reason_code='' WHERE singleton_id=1").run()
  const secretKey = 'mode-real-e2e-provider-reference-key'
  let b2Calls = 0
  const b2Executor = { async submit(input) {
    b2Calls += 1
    assert.equal(Object.hasOwn(input, 'ruleId'), false)
    assert.equal(input.bettingMode, 'prematch')
    assert.equal(input.settingsVersion, 3)
    assert.equal(Object.hasOwn(input, 'authorizationId'), false)
    const scope = { bettingMode: input.bettingMode, settingsVersion: input.settingsVersion,
      leaseKey: executorLease.leaseKey, executorOwnerId: executorLease.ownerId, fencingToken: executorLease.fencingToken,
      batchId: input.batchId, childOrderId: input.childOrderId, accountId: input.accountId }
    const identity = { provider: 'fixture', gid: 'mode-1', mode: 'prematch', period: 'full_time', market: 'asian_handicap', lineVariant: 'main', line: '-0.5', side: 'away' }
    const options = { env: ENV, now: () => new Date(NOW), secretKey }
    prepareSubmitAttempt(handle.db, { ...scope, submitAttemptId: input.submitAttemptId, attemptOrdinal: input.attemptOrdinal,
      capabilityEvidenceId: 'fixture:b2-ledger:offline:v1', capabilityVersion: 'b2-ledger-fixture-v1',
      lockedIdentity: identity, currentIdentity: identity,
      preview: { minStakeMinor: 10, maxStakeMinor: 1000, balanceMinor: 1000, stakeStepMinor: 10, odds: '0.96', line: '-0.5' } }, options)
    recordSubmitDispatch(handle.db, { ...scope, submitAttemptId: input.submitAttemptId }, options)
    const providerReferenceCiphertext = encryptSecret('fixture-reference', { secretKey, context: { purpose: 'crown-provider-reference', childOrderId: input.childOrderId, submitAttemptId: input.submitAttemptId } })
    return recordSubmitOutcome(handle.db, { ...scope, submitAttemptId: input.submitAttemptId,
      outcome: { kind: 'accepted', providerReferenceCiphertext }, hasFutureCapacity: false }, options)
  } }
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db, store: new BetBatchStore(handle.db, { leaseKey: executorLease.leaseKey, now: () => NOW }),
    lease: executorLease, processLease: workerLease, b2Executor, executionEnvironment: ENV,
    realExecutionGate: () => true, now: () => NOW, findLatestSelection: () => selection,
    provider: { async preview() { return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' } }, async submit() { throw new Error('legacy-submit-forbidden') } },
  })
  const created = await coordinator.claimAndCreateModeScopedBatch({ signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot, inboxLease, lockedSelection: lockReverseSelection(signal, () => selection), marketOnceKey: 'mode-real-e2e-once',
    executionMode: 'real' })
  const result = await coordinator.runBatch(created.batchId, { mode: 'real' })
  assert.equal(result.status, 'completed')
  assert.equal(result.finishReason, 'all_accepted')
  assert.equal(b2Calls, 1)
  assert.equal(handle.db.prepare('SELECT authorization_id FROM bet_submit_attempts').get().authorization_id, null)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorizations').get().count, 0)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM execution_authorization_child_budgets').get().count, 0)
  assert.equal(handle.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE final_status='accepted'").get().count, 1)
  handle.close()
})

test('preview-time odds drift is rejected by transaction revalidation before market ownership', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const signal = executionSignal('signal-odds-drift')
  const selection = executionSelection(signal)
  insertSignal(handle.db, signal.signalId, signal)
  persistSelection(handle.db, selection)
  insertAccount(handle.db)
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:odds-drift', ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db, store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }), lease,
    now: () => NOW, findLatestSelection: () => selection,
    provider: {
      async preview() {
        persistSelection(handle.db, { ...selection, capturedAt: '2026-07-12T00:00:02.000Z', selection: { ...selection.selection, odds: '9.9' } })
        return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' }
      },
      async submit() { throw new Error('must-not-submit') },
    },
  })
  const lockedSelection = lockReverseSelection(signal, () => selection)
  await assert.rejects(() => coordinator.claimAndCreateModeScopedBatch({
    signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3, settingsSnapshot,
    inboxLease, lockedSelection, marketOnceKey: 'odds-drift-once', executionMode: 'simulated',
  }), /latest-odds-out-of-range/)
  for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
    assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }
  handle.close()
})

test('preview-time line, stage, inbox snapshot, takeover, and expiry drift all roll back before claim', async () => {
  for (const kind of ['line', 'stage', 'snapshot', 'takeover', 'expiry']) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    enableSetting(handle.db)
    const signal = executionSignal(`signal-drift-${kind}`)
    const selection = executionSelection(signal)
    insertSignal(handle.db, signal.signalId, signal)
    persistSelection(handle.db, selection)
    insertAccount(handle.db)
    const persistedSettings = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
    const inboxLease = processingInbox(handle.db, signal.signalId, persistedSettings)
    const suppliedSettings = kind === 'snapshot' ? { ...persistedSettings, remark: 'drift' } : persistedSettings
    const lease = new RuntimeLease({ db: handle.db, leaseKey: `betting-executor:drift-${kind}`, ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
    lease.acquire()
    const coordinator = new MultiAccountBetCoordinator({
      db: handle.db, store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }), lease,
      now: () => NOW, findLatestSelection: () => selection,
      provider: {
        async preview() {
          if (kind === 'line') persistSelection(handle.db, { ...selection, capturedAt: '2026-07-12T00:00:02.000Z', market: { ...selection.market, lineKey: 'ADJACENT' } })
          if (kind === 'stage') persistSelection(handle.db, { ...selection, capturedAt: '2026-07-12T00:00:02.000Z', mode: 'live', event: { ...selection.event, mode: 'live' } })
          if (kind === 'takeover') handle.db.prepare("UPDATE auto_betting_signal_inbox SET lease_owner='other-owner' WHERE signal_id=?").run(signal.signalId)
          if (kind === 'expiry') handle.db.prepare('UPDATE auto_betting_signal_inbox SET lease_expires_at=? WHERE signal_id=?').run(NOW, signal.signalId)
          return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' }
        },
        async submit() { throw new Error('must-not-submit') },
      },
    })
    await assert.rejects(() => coordinator.claimAndCreateModeScopedBatch({
      signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3,
      settingsSnapshot: suppliedSettings, inboxLease, lockedSelection: lockReverseSelection(signal, () => selection),
      marketOnceKey: `drift-${kind}-once`, executionMode: 'simulated',
    }), /latest-selection|required|drift|snapshot-mismatch|lease-stale/)
    for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks']) {
      assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${kind}:${table}`)
    }
    handle.close()
  }
})

test('atomic lookup rejects a locked line missing from the newest market generation', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const signal = executionSignal('signal-new-generation')
  const oldSelection = executionSelection(signal)
  insertSignal(handle.db, signal.signalId, signal); persistSelection(handle.db, oldSelection); insertAccount(handle.db)
  const adjacentMarketIdentity = `${signal.target.eventIdentity}|full_time|asian_handicap|ADJACENT`
  persistSelection(handle.db, { ...oldSelection, capturedAt: '2026-07-12T00:00:02.000Z',
    market: { ...oldSelection.market, marketIdentity: adjacentMarketIdentity, lineKey: 'ADJACENT', handicap: -0.75 },
    selection: { ...oldSelection.selection, selectionIdentity: `${adjacentMarketIdentity}|away` } })
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:new-generation', ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  const coordinator = new MultiAccountBetCoordinator({ db: handle.db, store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }),
    lease, now: () => NOW, findLatestSelection: () => oldSelection,
    provider: { async preview() { return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' } }, async submit() {} } })
  await assert.rejects(() => coordinator.claimAndCreateModeScopedBatch({ signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot, inboxLease, lockedSelection: lockReverseSelection(signal, () => oldSelection), marketOnceKey: 'new-generation-once', executionMode: 'simulated' }),
  /latest-selection-required|market-changed/)
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM bet_market_once_claims').get().count, 0)
  handle.close()
})

test('atomic lookup accepts multiple active lines from the same newest generation', async () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  enableSetting(handle.db)
  const signal = executionSignal('signal-multiline-generation')
  const lockedLine = executionSelection(signal)
  insertSignal(handle.db, signal.signalId, signal); persistSelection(handle.db, lockedLine); insertAccount(handle.db)
  const adjacentMarketIdentity = `${signal.target.eventIdentity}|full_time|asian_handicap|ADJACENT`
  persistSelection(handle.db, { ...lockedLine,
    market: { ...lockedLine.market, marketIdentity: adjacentMarketIdentity, lineKey: 'ADJACENT', handicap: -0.75 },
    selection: { ...lockedLine.selection, selectionIdentity: `${adjacentMarketIdentity}|away` } })
  const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
  const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
  const lease = new RuntimeLease({ db: handle.db, leaseKey: 'betting-executor:multiline-generation', ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
  lease.acquire()
  const coordinator = new MultiAccountBetCoordinator({ db: handle.db, store: new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW }),
    lease, now: () => NOW, findLatestSelection: () => lockedLine,
    provider: { async preview() { return { ok: true, minStakeMinor: 10, maxStakeMinor: 1000, stakeStepMinor: 10, balanceMinor: 1000, currency: 'CNY', amountScale: 0, odds: '0.96' } }, async submit() {} } })
  const result = await coordinator.claimAndCreateModeScopedBatch({ signalId: signal.signalId, signal, bettingMode: 'prematch', settingsVersion: 3,
    settingsSnapshot, inboxLease, lockedSelection: lockReverseSelection(signal, () => lockedLine), marketOnceKey: 'multiline-generation-once', executionMode: 'simulated' })
  assert.equal(result.status, 'batch_created')
  handle.close()
})

test('mode batch terminal state matrix has stable finish reasons', () => {
  for (const scenario of ['rejected', 'unknown', 'partial', 'no_capacity', 'cancelled']) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    insertSignal(handle.db, `signal-state-${scenario}`)
    insertAccount(handle.db, 'account-a')
    if (scenario === 'partial') insertAccount(handle.db, 'account-b')
    const lease = new RuntimeLease({ db: handle.db, leaseKey: `betting-executor:state-${scenario}`, ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
    lease.acquire()
    const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW })
    const batch = store.createModeScopedBatch({ signalId: `signal-state-${scenario}`, bettingMode: 'prematch', settingsVersion: 3,
      settingsSnapshot: { mode: 'prematch', version: 3 }, currency: 'CNY', amountScale: 0,
      targetAmountMinor: 100, createdAt: NOW })
    if (scenario === 'no_capacity') {
      const result = store.reconcileAggregates(batch.batchId, { hasFutureCapacity: false, fencingToken: lease.fencingToken, at: NOW })
      assert.deepEqual([result.status, result.finishReason], ['failed', 'no_capacity'])
      handle.close(); continue
    }
    const accounts = scenario === 'partial' ? ['account-a', 'account-b'] : ['account-a']
    const children = store.reserveRound(batch.batchId, accounts.map((accountId) => ({ accountId,
      amountMinor: scenario === 'partial' ? 50 : 100, previewMinStakeMinor: 10, previewMaxStakeMinor: 1000,
      previewBalanceMinor: 1000, previewStakeStepMinor: 10 })), { fencingToken: lease.fencingToken })
    if (scenario === 'cancelled') {
      const result = store.cancelUnsubmitted(batch.batchId, { finishReason: 'manual_cancel', fencingToken: lease.fencingToken, at: NOW })
      assert.deepEqual([result.status, result.finishReason], ['cancelled', 'manual_cancel'])
      handle.close(); continue
    }
    children.forEach((child, index) => {
      store.prepareSubmit(child.childOrderId, { submitAttemptId: `attempt-${scenario}-${index}`, fencingToken: lease.fencingToken, at: NOW })
      store.markDispatched(child.childOrderId, { fencingToken: lease.fencingToken, at: NOW })
      const status = scenario === 'partial' ? (index === 0 ? 'accepted' : 'rejected') : scenario
      store.resolveChildOrder(child.childOrderId, { status, hasFutureCapacity: false, fencingToken: lease.fencingToken, at: NOW })
    })
    const result = store.getBatch(batch.batchId)
    const expected = scenario === 'partial' ? ['partial', 'partial_fulfillment']
      : scenario === 'unknown' ? ['waiting_result', 'unknown_result'] : ['failed', 'provider_rejected']
    assert.deepEqual([result.status, result.finishReason], expected)
    handle.close()
  }
})

test('authorized mode atomic faults roll back claim, ledger, locks, bindings, and budget', () => {
  const phases = ['mode:after-claim-insert', 'mode:after-batch-insert', 'mode:after-reservations',
    'reserve:after-authorization-update', 'reserve:after-binding-insert', 'reserve:after-batch-recompute',
    'mode:after-claim-transition']
  for (const phase of phases) {
    const handle = openAppDatabase({ dbPath: ':memory:' })
    enableSetting(handle.db)
    upgradeAutoBettingModeEligibility(handle.db, { mode: 'prematch', confirmation: eligibilityConfirmation(), expectedEligibilityVersion: 1 }, { env: ENV, now: () => new Date(NOW) })
    const signal = executionSignal(`signal-auth-fault-${phase}`)
    const selection = executionSelection(signal)
    insertSignal(handle.db, signal.signalId, signal); persistSelection(handle.db, selection); insertAccount(handle.db)
    const settingsSnapshot = { mode: 'prematch', version: 3, enabled: true, realEligible: true, realEligibilityVersion: 2,
      migrationReviewRequired: false, targetOddsMin: '0.8', targetOddsMax: '1.2', targetAmountMinor: 100, currency: 'CNY', amountScale: 0 }
    const inboxLease = processingInbox(handle.db, signal.signalId, settingsSnapshot)
    const lease = new RuntimeLease({ db: handle.db, leaseKey: `betting-executor:auth-fault-${phase}`, ownerId: 'owner', pid: 1, ttlMs: 60_000, now: () => new Date(NOW) })
    lease.acquire()
    const authorization = authorizeExecution(handle.db, { authorizationId: `auth-fault-${phase}`, currency: 'CNY', amountScale: 0,
      bettingModes: ['prematch'], eligibilityVersions: { prematch: 2 }, maxTotalAmountMinor: 100, confirmation: 'AUTH FAULT' },
    { env: ENV, now: () => new Date(NOW) })
    const store = new BetBatchStore(handle.db, { leaseKey: lease.leaseKey, now: () => NOW,
      faultInjector(current) { if (current === phase) throw new Error(`fault:${phase}`) } })
    assert.throws(() => store.createAuthorizedModeScopedBatchWithReservations({ signalId: signal.signalId, signalSnapshot: signal,
      bettingMode: 'prematch', settingsVersion: 3, settingsSnapshot, inboxLease, lockedSelection: lockReverseSelection(signal, () => selection),
      authorizationId: authorization.authorizationId, lockedSelectionIdentity: JSON.stringify(lockReverseSelection(signal, () => selection)),
      currency: 'CNY', amountScale: 0, targetAmountMinor: 100, createdAt: NOW },
    [{ accountId: 'account-a', amountMinor: 100, previewMinStakeMinor: 10, previewMaxStakeMinor: 1000,
      previewBalanceMinor: 1000, previewStakeStepMinor: 10 }], { marketOnceKey: `auth-fault-once-${phase}`,
      fencingToken: lease.fencingToken, authorizationId: authorization.authorizationId, executorOwnerId: lease.ownerId,
      authorizationOptions: { env: ENV, now: () => new Date(NOW), faultInjector(current) { if (current === phase) throw new Error(`fault:${phase}`) } } }), new RegExp(`fault:${phase}`))
    for (const table of ['bet_market_once_claims', 'bet_batches', 'bet_child_orders', 'betting_account_locks', 'execution_authorization_child_budgets']) {
      assert.equal(handle.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${phase}:${table}`)
    }
    assert.equal(handle.db.prepare('SELECT reserved_amount_minor FROM execution_authorizations').get().reserved_amount_minor, 0)
    handle.close()
  }
})
