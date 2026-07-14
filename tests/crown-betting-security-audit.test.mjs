import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { decryptSecret, encryptSecret } from '../src/crown/app/app-secret.mjs'
import {
  prepareAuthorizedSubmit,
  recordAuthorizedDispatch,
  recordAuthorizedOutcome,
} from '../src/crown/betting/b2-executor.mjs'
import {
  authorizeExecution,
  reserveAuthorizationBudget,
} from '../src/crown/betting/execution-gate.mjs'

const AT = '2026-07-11T00:00:00.000Z'
const KEY = 'b2-security-test-key-with-more-than-32-characters'
const RAW_REFERENCE = 'raw-ticket-provider-reference-938475'
const RAW_UID = 'raw-uid-284756'
const RAW_COOKIE = 'raw-cookie-192837'
const RAW_PASSWORD = 'raw-password-564738'
const RAW_SESSION = 'raw-session-102938'
const CHILD_ID = 'child-security'
const ATTEMPT_ID = 'submit-security-1'

const LOCKED_IDENTITY = Object.freeze({
  provider: 'fixture',
  gid: '8878933',
  mode: 'live',
  period: 'full_time',
  market: 'asian_handicap',
  lineVariant: 'main',
  line: '-0 / 0.5',
  side: 'home',
})
const LOCKED_ENVELOPE = Object.freeze({
  provider: 'crown', eventKey: 'crown|football|gid=8878933', period: 'full_time',
  marketType: 'asian_handicap', lineKey: '-0 / 0.5', side: 'home',
  selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|-0 / 0.5|home',
  snapshot: {
    provider: 'crown', mode: 'live',
    event: { eventKey: 'crown|football|gid=8878933', ids: { gid: '8878933' } },
    market: {
      period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
      lineKey: '-0 / 0.5', handicapRaw: '-0 / 0.5',
    },
    selection: { side: 'home', selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|-0 / 0.5|home' },
  },
})

function realEnv() {
  return {
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '2',
    CROWN_REAL_MAX_TOTAL_MINOR: '100',
  }
}

function options(overrides = {}) {
  return { env: realEnv(), now: () => new Date(AT), secretKey: KEY, ...overrides }
}

function insertFixtureRows(db, fencingToken) {
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, monitor_enabled, real_betting_enabled,
      migration_review_required, archived, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES ('rule-security', 'rule-security', 1, 'real_eligible', 1, 1, 0, 0, 'CNY', 2, 20, ?, ?)
  `).run(AT, AT)
  db.prepare(`
    INSERT INTO betting_accounts (
      id, label, username, status, archived, currency, amount_scale,
      per_bet_limit_minor, stake_step_minor, created_at, updated_at
    ) VALUES ('account-security', 'account-security', 'account-security',
      'enabled', 0, 'CNY', 2, 50, 1, ?, ?)
  `).run(AT, AT)
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES ('signal-security', 'signal-security', 'security-test', 1, 'ready', ?, ?, '{}')
  `).run(AT, '2026-07-11T01:00:00.000Z')
  db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, locked_selection_identity, rule_snapshot_json,
      currency, amount_scale, target_amount_minor, unfilled_amount_minor,
      status, created_at
    ) VALUES ('batch-security', 'signal-security', 'rule-security', ?, ?,
      'CNY', 2, 20, 20, 'queued', ?)
  `).run(LOCKED_ENVELOPE.selectionIdentity, JSON.stringify({
    rule: { changedOddsMin: '0.75', changedOddsMax: '1.18' },
    lockedSelection: LOCKED_ENVELOPE,
  }), AT)
  db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor, preview_balance_minor,
      preview_stake_step_minor, preview_odds, status, created_at
    ) VALUES (?, 'batch-security', 'account-security', 20, 10, 50, 100, 1, '0.83', 'reserved', ?)
  `).run(CHILD_ID, AT)
  db.prepare(`
    INSERT INTO betting_account_locks (
      account_id, child_order_id, batch_id, status, fencing_token,
      acquired_at, updated_at
    ) VALUES ('account-security', ?, 'batch-security', 'reserved', ?, ?, ?)
  `).run(CHILD_ID, fencingToken, AT, AT)
}

function setupB2() {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:security-test',
    ownerId: 'security-owner',
    pid: 1,
    ttlMs: 60_000,
    now: () => new Date(AT),
  })
  lease.acquire()
  insertFixtureRows(handle.db, lease.fencingToken)
  const authorization = authorizeExecution(handle.db, {
    authorizationId: 'auth-security',
    currency: 'CNY',
    amountScale: 2,
    ruleIds: ['rule-security'],
    maxTotalAmountMinor: 100,
    confirmation: 'AUTHORIZE REAL EXECUTION',
  }, options())
  const gate = {
    authorizationId: authorization.authorizationId,
    ruleId: 'rule-security',
    leaseKey: lease.leaseKey,
    executorOwnerId: lease.ownerId,
    fencingToken: lease.fencingToken,
    childOrderId: CHILD_ID,
    batchId: 'batch-security',
    accountId: 'account-security',
  }
  reserveAuthorizationBudget(handle.db, { ...gate, amountMinor: 20 }, options())
  const capabilityVersion = 'b2-ledger-fixture-v1'
  const capabilityEvidenceId = 'fixture:b2-ledger:offline:v1'
  const prepare = {
    ...gate,
    submitAttemptId: ATTEMPT_ID,
    attemptOrdinal: 1,
    capabilityVersion,
    capabilityEvidenceId,
    lockedIdentity: structuredClone(LOCKED_IDENTITY),
    currentIdentity: structuredClone(LOCKED_IDENTITY),
    preview: {
      minStakeMinor: 10,
      maxStakeMinor: 50,
      balanceMinor: 100,
      stakeStepMinor: 1,
      odds: '0.83',
      line: '-0 / 0.5',
    },
  }
  return { handle, db: handle.db, lease, gate, prepare }
}

function containsAnySecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return [RAW_REFERENCE, RAW_UID, RAW_COOKIE, RAW_PASSWORD, RAW_SESSION].some((secret) => text.includes(secret))
}

test('Task12 tables expose only ciphertext, hashes, ids, and sanitized JSON for sensitive provider material', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const tables = [
    'bet_child_orders',
    'bet_submit_attempts',
    'bet_reconciliation_state',
    'bet_reconciliation_evidence',
    'bet_notification_outbox',
    'execution_security_audit',
  ]
  const forbiddenPlaintextColumn = /(?:^|_)(?:provider_reference|ticket|uid|cookie|password|session)(?:$|_)/i

  for (const table of tables) {
    const columns = handle.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    assert.ok(columns.length > 0, `missing Task12 table: ${table}`)
    for (const column of columns) {
      if (!forbiddenPlaintextColumn.test(column)) continue
      assert.match(column, /(?:ciphertext|hash|digest)$/i, `${table}.${column} can persist plaintext`)
    }
  }
  handle.close()
})

test('provider reference must be v2 context-bound before B2 persistence', () => {
  const context = setupB2()
  prepareAuthorizedSubmit(context.db, context.prepare, options())
  recordAuthorizedDispatch(context.db, { ...context.gate, submitAttemptId: ATTEMPT_ID }, options())

  for (const unsafeReference of [
    RAW_REFERENCE,
    encryptSecret(RAW_REFERENCE, { secretKey: KEY }),
    'v2:a:b:c',
    encryptSecret(RAW_REFERENCE, {
      secretKey: KEY,
      context: {
        purpose: 'crown-provider-reference',
        childOrderId: 'wrong-child',
        submitAttemptId: ATTEMPT_ID,
      },
    }),
  ]) {
    assert.throws(() => recordAuthorizedOutcome(context.db, {
      ...context.gate,
      submitAttemptId: ATTEMPT_ID,
      outcome: { kind: 'accepted', providerReferenceCiphertext: unsafeReference },
      hasFutureCapacity: false,
    }, options()), /provider-reference-ciphertext/)
  }
  assert.equal(context.db.prepare('SELECT status FROM bet_submit_attempts WHERE submit_attempt_id = ?').get(ATTEMPT_ID).status, 'submit_dispatched')
  context.handle.close()
})

test('Task12 result, API projection, audit, notification, and errors never expose provider or session plaintext', () => {
  const context = setupB2()
  prepareAuthorizedSubmit(context.db, context.prepare, options())
  recordAuthorizedDispatch(context.db, { ...context.gate, submitAttemptId: ATTEMPT_ID }, options())
  const encryptionContext = {
    purpose: 'crown-provider-reference',
    childOrderId: CHILD_ID,
    submitAttemptId: ATTEMPT_ID,
  }
  const ciphertext = encryptSecret(RAW_REFERENCE, { secretKey: KEY, context: encryptionContext })
  const result = recordAuthorizedOutcome(context.db, {
    ...context.gate,
    submitAttemptId: ATTEMPT_ID,
    outcome: {
      kind: 'accepted',
      providerReferenceCiphertext: ciphertext,
      ticket: RAW_REFERENCE,
      uid: RAW_UID,
      cookie: RAW_COOKIE,
      password: RAW_PASSWORD,
      session: RAW_SESSION,
    },
    hasFutureCapacity: false,
  }, options())
  const repository = createAppRepository(context.db, { secretKey: KEY })
  const apiProjection = repository.listBetBatchChildren('batch-security')
  const audit = context.db.prepare('SELECT action, subject_type, subject_id, details_json FROM execution_security_audit ORDER BY created_at, audit_id').all()
  const notifications = context.db.prepare('SELECT notification_id, batch_id, child_order_id, final_status, payload_json FROM bet_notification_outbox').all()
  let contextError
  try {
    decryptSecret(ciphertext, {
      secretKey: KEY,
      context: { ...encryptionContext, childOrderId: 'wrong-child' },
    })
  } catch (error) {
    contextError = { name: error.name, code: error.code, message: error.message }
  }
  const publicSurface = { result, apiProjection, audit, notifications, contextError }

  assert.equal(containsAnySecret(publicSurface), false)
  assert.equal(JSON.stringify(publicSurface).includes(ciphertext), false)
  assert.equal(apiProjection[0].providerReference, '[masked]')
  assert.equal(contextError.code, 'invalid-secret-context')
  const childStored = context.db.prepare('SELECT provider_reference_ciphertext FROM bet_child_orders WHERE child_order_id = ?').get(CHILD_ID)
  const attemptStored = context.db.prepare('SELECT provider_reference_ciphertext FROM bet_submit_attempts WHERE submit_attempt_id = ?').get(ATTEMPT_ID)
  assert.equal(childStored.provider_reference_ciphertext, ciphertext)
  assert.equal(attemptStored.provider_reference_ciphertext, ciphertext)
  assert.match(ciphertext, /^v2:/)
  assert.equal(ciphertext.includes(RAW_REFERENCE), false)
  context.handle.close()
})

test('production B2 modules expose no mintable test authority and fixture capability cannot attest Crown', async () => {
  const [executorModule, reconcilerModule] = await Promise.all([
    import('../src/crown/betting/b2-executor.mjs'),
    import('../src/crown/betting/b2-reconciler.mjs'),
  ])
  assert.equal('createTestB2CapabilityAuthority' in executorModule, false)
  assert.equal('createTestB2ReconciliationAuthority' in reconcilerModule, false)
  const context = setupB2()
  assert.throws(() => prepareAuthorizedSubmit(context.db, {
    ...context.prepare,
    lockedIdentity: { ...context.prepare.lockedIdentity, provider: 'crown' },
    currentIdentity: { ...context.prepare.currentIdentity, provider: 'crown' },
  }, options()), /crown-capability/)
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM bet_submit_attempts').get().count, 0)
  context.handle.close()

  const references = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.endsWith('.mjs')
        && /createTestB2(?:Capability|Reconciliation)Authority/.test(fs.readFileSync(target, 'utf8'))) references.push(target)
    }
  }
  visit(path.resolve('src'))
  visit(path.resolve('scripts'))
  assert.deepEqual(references, [])
})

test('superseded betting entrypoints are absent and the canonical worker keeps the capability gate', () => {
  const supersededEntryPoints = [
    'src/crown/betting/crown-bet-adapter.mjs',
    'scripts/crown-bet-bootstrap.mjs',
    'scripts/crown-bet-execute.mjs',
    'scripts/crown-bet-execute-sequence.mjs',
    'scripts/crown-betting-candidate-dry-run.mjs',
  ]
  for (const file of supersededEntryPoints) {
    assert.equal(fs.existsSync(path.resolve(file)), false, `${file} must not be published`)
  }

  const worker = fs.readFileSync(path.resolve('scripts/crown-betting-worker.mjs'), 'utf8')
  assert.match(worker, /listCrownCapabilities\(\).*submitAllowed === true/s)
  assert.match(worker, /crown-real-capability-unavailable/)
})
