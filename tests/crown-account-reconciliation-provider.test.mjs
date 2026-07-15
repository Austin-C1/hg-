import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { encryptSecret } from '../src/crown/app/app-secret.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  listCrownCapabilities,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  createCrownAcceptanceCapabilityAuthority,
  createCrownBrowserAcceptanceManifest,
  initializeCrownBrowserAcceptanceCampaign,
} from '../src/crown/betting/crown-browser-acceptance.mjs'

const modulePromise = import('../src/crown/betting/crown-account-reconciliation-provider.mjs').catch(() => ({}))

const REQUEST_FIELDS = Object.freeze([
  'LS', 'chk_cw', 'db_slow', 'format', 'langx', 'p', 'selGtype', 'ts', 'uid',
])
const WAGER_FIELDS = Object.freeze([
  'adddate', 'addtime', 'ball_act_class', 'ball_act_ret', 'ball_map', 'ballact',
  'bet_gtype', 'bet_showtype', 'bet_wtype', 'cancel_apn', 'cancel_line', 'code_value',
  'concede', 'delaysec', 'fore_result', 'gid', 'gidfl', 'gold', 'gtype', 'ioratio',
  'league', 'mainGid', 'odd_f', 'oddf_type', 'org_score', 'pname', 'ptype', 'ratio',
  'result', 'rtype', 'score', 'showtype', 'stop_time', 'strong', 'team_c_ratio',
  'team_c_show', 'team_h_ratio', 'team_h_show', 'team_id_c', 'team_id_h', 'type',
  'w_id', 'w_ms', 'win_gold', 'wtype',
])

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function exactTransport(timestamp = '1783833619939', overrides = {}) {
  return {
    operation: 'get_today_wagers',
    endpointPath: '/transform.php',
    method: 'POST',
    status: 200,
    requestFieldSet: [...REQUEST_FIELDS],
    requestFieldSetFingerprint: sha256(JSON.stringify(REQUEST_FIELDS)),
    requestTimestampDigest: sha256(timestamp),
    ...overrides,
  }
}

function wager(identity, reference = '12345678901', overrides = {}) {
  const record = Object.fromEntries(WAGER_FIELDS.map((field) => [field, '']))
  return {
    ...record,
    gidfl: 0,
    gtype: '足球',
    mainGid: identity.gid,
    w_id: `OU${reference}`,
    ...identity,
    ...overrides,
  }
}

function todayWagers(identity, reference, { records, timestamp = '1783833619939' } = {}) {
  const wagers = records || [wager(identity, reference)]
  return JSON.stringify({
    amout_gold: '0',
    code: '0',
    count: wagers.length,
    pay_type: 0,
    ts: timestamp,
    wagers,
    ...(wagers.length ? { allGidAry: { FT: [...new Set(wagers.map((item) => item.gid))] } } : {}),
  })
}

function acceptanceFixture(reference = '12345678901') {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: 'reconciliation-acceptance-secret' })
  const direction = manifest.directions[0]
  const sealedReference = encryptSecret(reference, {
    secretKey: 'reconciliation-acceptance-secret',
    context: {
      purpose: 'crown-provider-reference',
      childOrderId: 'bound-child',
      submitAttemptId: 'bound-attempt',
    },
  })
  const frozenPreview = {
    accountId: 'bound-account',
    contextGeneration: 'context-a',
    capabilityEvidenceId: direction.capabilityEvidenceId,
    capabilityVersion: manifest.capabilityVersion,
    lockedIdentity: {
      provider: 'crown', gid: '8878931', mode: direction.mode, period: direction.period,
      market: direction.marketType, lineVariant: direction.lineVariant,
      line: '0 / 0.5', side: direction.selectionSide,
    },
    preview: {
      minStakeMinor: 50, maxStakeMinor: 500, stakeStepMinor: null,
      odds: '0.96', line: '0 / 0.5', submitCon: '0 / 0.5', submitRatio: '1',
      currency: 'CNY', amountScale: 0,
    },
  }
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases SET
    state='unknown',dispatch_count=1,authorized_min_minor=50,
    child_order_id='bound-child',account_id='bound-account',submit_attempt_id='bound-attempt',
    execution_candidate_digest=?,frozen_preview_json=?,sealed_provider_reference=?
    WHERE campaign_id=? AND direction_id=?`).run(
    'a'.repeat(64), JSON.stringify(frozenPreview), sealedReference, manifest.campaignId, direction.id,
  )
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db,
    manifest,
    secretKey: 'reconciliation-acceptance-secret',
    candidateCatalog: listCrownCapabilities(),
  })
  return { authority, direction, handle, manifest, reference, sealedReference }
}

function createProvider(CrownAccountReconciliationProvider, fixture, response) {
  const calls = []
  const account = { id: 'bound-account', username: 'bound-user', loginUrl: 'https://crown.example.com' }
  const session = { accountId: account.id, username: account.username, baseUrl: account.loginUrl }
  const provider = new CrownAccountReconciliationProvider({
    repository: {
      getBettingAccountForExecution() { return account },
      sealCrownProviderReference() { return fixture.sealedReference },
    },
    browserRuntime: {
      async ensureBettingSession(input) { calls.push(['session', input]); return session },
      async queryResultForm(input) { calls.push(['query', input]); return response() },
    },
    reconcilerLease: {
      leaseKey: 'betting-reconciler:acceptance', fencingToken: 1, assertFence() { return 1 },
    },
    acceptanceAuthority: fixture.authority,
  })
  return { calls, provider }
}

test('production reconciliation fails closed before any browser result query while capability is unverified', async () => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  assert.equal(typeof CrownAccountReconciliationProvider, 'function')

  let browserCalls = 0
  const browserRuntime = {
    async ensureBettingSession() { browserCalls += 1; throw new Error('browser-network-called') },
    async queryResultForm() { browserCalls += 1; throw new Error('browser-network-called') },
  }
  const provider = new CrownAccountReconciliationProvider({
    repository: {},
    browserRuntime,
    reconcilerLease: { assertFence() { return true } },
  })

  await assert.rejects(
    () => provider.queryResult({ submitAttemptId: 'attempt-a' }),
    /crown-reconciliation-capability-unverified/,
  )
  await assert.rejects(() => provider.getDangerous({ submitAttemptId: 'attempt-a' }), /capability-unverified/)
  await assert.rejects(() => provider.getTodayWagers({ submitAttemptId: 'attempt-a' }), /capability-unverified/)
  assert.equal(browserCalls, 0)
})

test('acceptance reconciliation rejects the old records fixture contract without exposing the reference', async () => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  const fixture = acceptanceFixture()
  const { calls, provider } = createProvider(CrownAccountReconciliationProvider, fixture, () => ({
    text: JSON.stringify({ records: [{ decision: 'accepted', reference: fixture.reference }] }),
    transport: exactTransport(),
  }))

  await assert.rejects(() => provider.queryResult({ submitAttemptId: 'wrong-attempt' }), /acceptance-reconciliation-binding/)
  assert.equal(calls.length, 0)
  const result = await provider.queryResult({ submitAttemptId: 'bound-attempt' })
  assert.equal(result.decision, 'unknown')
  assert.equal(result.matchStrength, 'none')
  assert.equal(result.matchCount, 0)
  assert.equal(result.providerReferenceCiphertext, '')
  assert.equal(result.payload.reasonCode, 'result-schema-drift')
  assert.equal(Object.hasOwn(calls.at(-1)[1], 'wireFields'), false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.reference))
  assert.deepEqual(calls.map(([operation]) => operation), ['session', 'query'])
  const dangerous = await provider.getDangerous({ submitAttemptId: 'bound-attempt' })
  assert.equal(dangerous.decision, 'no_match')
  assert.deepEqual(calls.map(([operation]) => operation), ['session', 'query'])
  assert.equal(fixture.handle.db.prepare('SELECT COUNT(*) count FROM bet_child_orders').get().count, 0)
  assert.equal(fixture.handle.db.prepare('SELECT COUNT(*) count FROM bet_submit_attempts').get().count, 0)
  fixture.handle.close()
})

test('exact today-wagers suffix and expected identity produce one strong accepted result', async () => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  const fixture = acceptanceFixture()
  const binding = fixture.authority.resolveReconciliation({ submitAttemptId: 'bound-attempt' })
  assert.deepEqual(Object.keys(binding.expectedResultIdentity || {}).sort(), [
    'bet_gtype', 'bet_wtype', 'concede', 'gid', 'gold', 'ioratio', 'type',
  ])
  const body = todayWagers(binding.expectedResultIdentity, fixture.reference)
  assert.match(body, /"gtype":"足球"/)
  const { calls, provider } = createProvider(CrownAccountReconciliationProvider, fixture, () => ({
    text: body,
    transport: exactTransport(),
  }))

  const result = await provider.queryResult({ submitAttemptId: 'bound-attempt' })
  assert.equal(result.decision, 'accepted')
  assert.equal(result.matchStrength, 'strong')
  assert.equal(result.matchCount, 1)
  assert.equal(result.providerReferenceCiphertext, fixture.sealedReference)
  assert.equal(result.payload.reasonCode, 'result-accepted')
  assert.match(result.payload.responseDigest, /^sha256:[a-f0-9]{64}$/)
  assert.match(result.payload.responseFieldSetFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.match(result.payload.wagerFieldSetFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(calls.at(-1)[1], 'wireFields'), false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${fixture.reference}|OU${fixture.reference}`))
  fixture.handle.close()
})

test('one unique identity match recovers an accepted submit when its response omitted the reference', async () => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  const fixture = acceptanceFixture()
  fixture.handle.db.prepare(`UPDATE crown_browser_acceptance_cases
    SET sealed_provider_reference='' WHERE submit_attempt_id='bound-attempt'`).run()
  const identity = fixture.authority.resolveReconciliation({
    submitAttemptId: 'bound-attempt',
  }).expectedResultIdentity
  const body = todayWagers(identity, '10987654321', {
    records: [wager(identity, '10987654321', { ioratio: '0.960', strong: 'N' })],
  })
  const { provider } = createProvider(CrownAccountReconciliationProvider, fixture, () => ({
    text: body,
    transport: exactTransport(),
  }))

  const result = await provider.queryResult({ submitAttemptId: 'bound-attempt' })
  assert.equal(result.decision, 'accepted')
  assert.equal(result.matchStrength, 'strong')
  assert.equal(result.matchCount, 1)
  assert.equal(result.providerReferenceCiphertext, fixture.sealedReference)
  fixture.handle.close()
})

test('today-wagers zero suffix match stays pending while multiple and identity drift are unknown', async () => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  const fixture = acceptanceFixture()
  const identity = fixture.authority.resolveReconciliation({
    submitAttemptId: 'bound-attempt',
  }).expectedResultIdentity
  const cases = [
    {
      name: 'zero suffix',
      body: todayWagers(identity, '10987654321'),
      decision: 'pending',
      strength: 'none',
      count: 0,
      reason: 'result-pending',
    },
    {
      name: 'multiple suffix',
      body: todayWagers(identity, fixture.reference, {
        records: [wager(identity, fixture.reference), wager(identity, fixture.reference)],
      }),
      decision: 'unknown',
      strength: 'multiple',
      count: 2,
      reason: 'result-reference-multiple',
    },
    {
      name: 'identity drift',
      body: todayWagers(identity, fixture.reference, {
        records: [wager(identity, fixture.reference, { gold: `${identity.gold}0` })],
      }),
      decision: 'unknown',
      strength: 'none',
      count: 1,
      reason: 'result-identity-drift',
    },
  ]

  for (const item of cases) {
    const { provider } = createProvider(CrownAccountReconciliationProvider, fixture, () => ({
      text: item.body,
      transport: exactTransport(),
    }))
    const result = await provider.queryResult({ submitAttemptId: 'bound-attempt' })
    assert.equal(result.decision, item.decision, item.name)
    assert.equal(result.matchStrength, item.strength, item.name)
    assert.equal(result.matchCount, item.count, item.name)
    assert.equal(result.payload.reasonCode, item.reason, item.name)
  }
  fixture.handle.close()
})

test('today-wagers transport, JSON, field, and type drift fail closed without raw payloads', async (t) => {
  const { CrownAccountReconciliationProvider } = await modulePromise
  const fixture = acceptanceFixture()
  const identity = fixture.authority.resolveReconciliation({
    submitAttemptId: 'bound-attempt',
  }).expectedResultIdentity
  const valid = todayWagers(identity, fixture.reference)
  const parsed = JSON.parse(valid)
  const variants = [
    ['transport field', valid, exactTransport(undefined, { requestFieldSet: [...REQUEST_FIELDS, 'ver'] }), 'result-transport-drift'],
    ['transport status', valid, exactTransport(undefined, { status: 201 }), 'result-transport-drift'],
    ['duplicate key', valid.replace('"code":"0"', '"code":"0","code":"0"'), exactTransport(), 'result-schema-drift'],
    ['trailing data', `${valid} true`, exactTransport(), 'result-schema-drift'],
    ['non-finite number', valid.replace('"pay_type":0', '"pay_type":1e999'), exactTransport(), 'result-schema-drift'],
    ['extra top field', JSON.stringify({ ...parsed, extra: '' }), exactTransport(), 'result-schema-drift'],
    ['missing wager field', JSON.stringify({ ...parsed, wagers: [{ ...parsed.wagers[0], wtype: undefined }] }), exactTransport(), 'result-schema-drift'],
    ['wager type', JSON.stringify({ ...parsed, wagers: [{ ...parsed.wagers[0], gidfl: '0' }] }), exactTransport(), 'result-schema-drift'],
    ['count mismatch', JSON.stringify({ ...parsed, count: 0 }), exactTransport(), 'result-schema-drift'],
  ]

  for (const [name, text, transport, reason] of variants) {
    await t.test(name, async () => {
      const { provider } = createProvider(CrownAccountReconciliationProvider, fixture, () => ({ text, transport }))
      const result = await provider.queryResult({ submitAttemptId: 'bound-attempt' })
      assert.equal(result.decision, 'unknown')
      assert.equal(result.payload.reasonCode, reason)
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`${fixture.reference}|OU${fixture.reference}`))
    })
  }
  fixture.handle.close()
})
