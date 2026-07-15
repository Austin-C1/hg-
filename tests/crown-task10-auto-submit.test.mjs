import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCrownCapability,
  listCrownCapabilities,
  verifyCrownCapabilityMatrix,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  buildStrictCrownPreviewFields,
  buildStrictCrownSubmitWireFields,
} from '../src/crown/betting/crown-order-field-mapper.mjs'
import { parseCrownSubmitResponseStrict } from '../src/crown/betting/crown-bet-response-parser.mjs'
import { CrownAccountExecutionProvider } from '../src/crown/betting/crown-account-execution-provider.mjs'
import { CrownAccountPreviewProvider } from '../src/crown/betting/crown-account-provider.mjs'
import { normalizeCrownTransformXml } from '../src/crown/crown-transform-xml.mjs'

const CAPABILITY_KEY = 'prematch|full_time|asian_handicap|main|away'

function record(side = 'away') {
  return {
    provider: 'crown',
    mode: 'prematch',
    event: { ids: { gid: 'event-safe' } },
    market: {
      marketType: 'asian_handicap',
      period: 'full_time',
      lineVariant: 'main',
      isMainMarket: true,
      ratioField: 'RATIO_R',
      handicapRaw: '0.5 / 1',
    },
    selection: {
      side,
      oddsField: side === 'home' ? 'IOR_RH' : 'IOR_RC',
      oddsRaw: '0.96',
    },
  }
}

function lockedIdentity(side = 'away') {
  return {
    provider: 'crown',
    gid: 'event-safe',
    mode: 'prematch',
    period: 'full_time',
    market: 'asian_handicap',
    lineVariant: 'main',
    line: '0.5 / 1',
    side,
  }
}

function preview(side = 'away') {
  return {
    minStakeMinor: 50,
    maxStakeMinor: 20000,
    balanceMinor: 500,
    stakeStepMinor: 50,
    stakeStepProvenance: 'local-conservative-policy',
    amountScale: 0,
    currency: 'CNY',
    odds: '0.96',
    line: '0.5 / 1',
    submitCon: '1',
    submitRatio: '50',
    lockedIdentity: lockedIdentity(side),
  }
}

function lockedEnvelope(side = 'away') {
  const snapshot = {
    ...record(side),
    event: { eventKey: 'crown|football|gid=event-safe', ids: { gid: 'event-safe' } },
    market: { ...record(side).market, lineKey: 'RATIO_R' },
    selection: {
      ...record(side).selection,
      selectionIdentity: `crown|football|gid=event-safe|full_time|asian_handicap|RATIO_R|${side}`,
      suspended: false,
    },
  }
  return {
    provider: 'crown', eventKey: snapshot.event.eventKey, period: 'full_time',
    marketType: 'asian_handicap', lineKey: 'RATIO_R', side,
    selectionIdentity: snapshot.selection.selectionIdentity, snapshot,
  }
}

function currentEnvelopeWithIdentityDrift(field) {
  const envelope = structuredClone(lockedEnvelope())
  if (field === 'gid') envelope.snapshot.event.ids.gid = 'event-drift'
  if (field === 'mode') envelope.snapshot.mode = 'live'
  if (field === 'period') envelope.period = envelope.snapshot.market.period = 'first_half'
  if (field === 'market') envelope.marketType = envelope.snapshot.market.marketType = 'total'
  if (field === 'lineVariant') envelope.snapshot.market.lineVariant = 'alternate_a'
  if (field === 'line') envelope.snapshot.market.handicapRaw = '1'
  if (field === 'side') envelope.side = envelope.snapshot.selection.side = 'home'
  return envelope
}

test('canonical matrix enables the four accepted prematch rows and keeps reconciliation closed', () => {
  const rows = listCrownCapabilities()
  const enabled = rows.filter((row) => row.submitAllowed)
  assert.equal(rows.filter((row) => row.previewAllowed).length, 8)
  assert.deepEqual(enabled.map((row) => row.key), [
    'prematch|full_time|asian_handicap|main|home',
    CAPABILITY_KEY,
    'prematch|full_time|total|main|over',
    'prematch|full_time|total|main|under',
  ])
  assert.ok(enabled.every((row) => row.reconciliationAllowed === false))
  assert.equal(assertCrownCapability(enabled[1], { operation: 'preview' }).key, CAPABILITY_KEY)
  assert.equal(assertCrownCapability(enabled[1], { operation: 'submit' }).key, CAPABILITY_KEY)
  assert.throws(() => assertCrownCapability(enabled[0], { operation: 'reconciliation' }), /reconciliation-blocked/)

  const verified = verifyCrownCapabilityMatrix()
  assert.equal(verified.ok, true, verified.errors.join(', '))
  assert.deepEqual([
    verified.allowedPreviewCount,
    verified.allowedSubmitCount,
    verified.allowedReconciliationCount,
  ], [8, 4, 0])
})

test('watcher marks exactly the eight verified full-time directions as main', () => {
  const xml = `<serverresponse><code>617</code><game>
    <GID>1001</GID><LID>1</LID><ECID>2</ECID><LEAGUE>Safe</LEAGUE><TEAM_H>H</TEAM_H><TEAM_C>C</TEAM_C>
    <RATIO_R>0.5 / 1</RATIO_R><IOR_RH>0.96</IOR_RH><IOR_RC>0.94</IOR_RC>
    <RATIO_OUO>2.5</RATIO_OUO><RATIO_OUU>2.5</RATIO_OUU><IOR_OUC>0.93</IOR_OUC><IOR_OUH>0.97</IOR_OUH>
    <RATIO_RE>0.5 / 1</RATIO_RE><IOR_REH>0.92</IOR_REH><IOR_REC>0.98</IOR_REC>
    <RATIO_ROUO>2.5</RATIO_ROUO><RATIO_ROUU>2.5</RATIO_ROUU><IOR_ROUC>0.91</IOR_ROUC><IOR_ROUH>0.99</IOR_ROUH>
    <RATIO_AR>1</RATIO_AR><IOR_ARH>0.90</IOR_ARH><IOR_ARC>1.00</IOR_ARC>
  </game></serverresponse>`
  const prematch = normalizeCrownTransformXml({ body: xml, metadata: { mode: 'prematch' } })
  assert.deepEqual(prematch.filter((item) => item.market.lineVariant === 'main').map((item) => [
    item.market.ratioField,
    item.selection.oddsField,
  ]), [
    ['RATIO_R', 'IOR_RH'],
    ['RATIO_R', 'IOR_RC'],
    ['RATIO_OUO', 'IOR_OUC'],
    ['RATIO_OUU', 'IOR_OUH'],
  ])

  const live = normalizeCrownTransformXml({
    body: xml.replace('<GID>1001</GID>', '<SHOWTYPE>RB</SHOWTYPE><GID>1001</GID>'),
  })
  assert.deepEqual(live.filter((item) => item.market.lineVariant === 'main').map((item) => [
    item.market.ratioField,
    item.selection.oddsField,
  ]), [
    ['RATIO_RE', 'IOR_REH'],
    ['RATIO_RE', 'IOR_REC'],
    ['RATIO_ROUO', 'IOR_ROUC'],
    ['RATIO_ROUU', 'IOR_ROUH'],
  ])
  assert.ok([...prematch, ...live]
    .filter((item) => item.market.ratioField === 'RATIO_AR')
    .every((item) => item.market.lineVariant === 'unknown' && item.market.isMainMarket === 'unknown'))
})

test('strict Preview and Submit map exact home and away fields; opaque f=1R stays full-time', () => {
  const awayCapability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const homeCapability = listCrownCapabilities().find((row) => row.key === 'prematch|full_time|asian_handicap|main|home')
  for (const [side, choseTeam, row] of [['home', 'H', homeCapability], ['away', 'C', awayCapability]]) {
    const mapped = buildStrictCrownPreviewFields(record(side), { capability: row })
    assert.deepEqual(mapped.preview, {
      gid: 'event-safe', gtype: 'FT', wtype: 'R', chose_team: choseTeam,
    })
    assert.equal(mapped.identity.period, 'full_time')
  }

  const homeSubmit = buildStrictCrownSubmitWireFields({
    lockedIdentity: lockedIdentity('home'), currentIdentity: lockedIdentity('home'),
    preview: preview('home'), amountMinor: 50,
  }, {
    capability: homeCapability,
    protocolVersion: 'verified-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  })
  assert.equal(homeSubmit.chose_team, 'H')
  assert.equal(homeSubmit.rtype, 'RH')

  const before = Date.now()
  const submit = buildStrictCrownSubmitWireFields({
    lockedIdentity: lockedIdentity(), currentIdentity: lockedIdentity(),
    preview: preview(), amountMinor: 50,
  }, {
    capability: awayCapability,
    protocolVersion: 'verified-version',
    protocolVersionEvidence: {
      source: 'production-session-metadata', captured: true, verified: true,
    },
  })
  const after = Date.now()
  assert.deepEqual({
    p: submit.p, gtype: submit.gtype, wtype: submit.wtype, rtype: submit.rtype,
    chose_team: submit.chose_team, isRB: submit.isRB, f: submit.f, golds: submit.golds,
    con: submit.con, ratio: submit.ratio, timestamp2: submit.timestamp2,
  }, {
    p: 'FT_bet', gtype: 'FT', wtype: 'R', rtype: 'RC', chose_team: 'C',
    isRB: 'N', f: '1R', golds: '50', con: '1', ratio: '50', timestamp2: '',
  })
  assert.match(submit.timestamp, /^\d{13}$/)
  assert.ok(Number(submit.timestamp) >= before && Number(submit.timestamp) <= after)

  assert.throws(() => buildStrictCrownSubmitWireFields({
    lockedIdentity: lockedIdentity(), currentIdentity: lockedIdentity(),
    preview: preview(), amountMinor: 100,
  }, {
    capability: awayCapability,
    protocolVersion: 'verified-version',
    protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
  }), /crown-submit-stake-step-unverified/)
  for (const amountMinor of [49, 51, 80]) {
    assert.throws(() => buildStrictCrownSubmitWireFields({
      lockedIdentity: lockedIdentity(), currentIdentity: lockedIdentity(),
      preview: preview(), amountMinor,
    }, {
      capability: awayCapability,
      protocolVersion: 'verified-version',
      protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
    }), /crown-submit-(?:money-contract|stake-step-unverified|stake-step-mismatch)/)
  }
})

test('production Preview returns the evidence-complete B2 execution contract for the exact row', async () => {
  const account = {
    id: 'account-preview', username: 'owner-preview', loginUrl: 'https://crown.example.com',
    currency: 'CNY', amountScale: 0, stakeStepMinor: 1, perBetLimitMinor: 50,
  }
  const session = {
    accountId: account.id, username: account.username, baseUrl: account.loginUrl,
    origin: account.loginUrl, uid: 'private-uid', protocolVersion: 'verified-version',
    contextGeneration: 'preview-generation',
    protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
  }
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const fields = Object.fromEntries(capability.responseFieldSet.map((field) => [field, 'x']))
  Object.assign(fields, {
    code: '501', gold_gmin: '50', gold_gmax: '20000', ioratio: '0.96', spread: '0.5 / 1',
    con: '1', ratio: '50',
  })
  const xml = `<serverresponse>${Object.entries(fields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  const browserRuntime = {
    async ensureBettingSession() { return session },
    async fetchFreshExecutionBalance() {
      return {
        summary: { valid: true, reportedBalance: '500.00', reportedCurrency: 'CNY' },
        session,
        transport: { operation: 'get_member_data', endpointPath: '/transform.php', status: 200 },
      }
    },
    async postPreviewForm() {
      return {
        text: xml,
        transport: { operation: 'FT_order_view', endpointPath: '/transform.php', status: 200 },
      }
    },
  }
  const provider = new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { return account } },
    browserRuntime,
    executorLease: {
      leaseKey: 'betting-executor:preview-task10', fencingToken: 1,
      assertFence(token) { assert.equal(token, 1); return 1 },
    },
  })
  const snapshot = {
    ...record(),
    event: { eventKey: 'crown|football|gid=event-safe', ids: { gid: 'event-safe' } },
    market: { ...record().market, lineKey: 'RATIO_R' },
    selection: {
      ...record().selection,
      selectionIdentity: 'crown|football|gid=event-safe|full_time|asian_handicap|RATIO_R|away',
    },
  }
  const envelope = {
    provider: 'crown', eventKey: snapshot.event.eventKey, period: 'full_time',
    marketType: 'asian_handicap', lineKey: 'RATIO_R', side: 'away',
    selectionIdentity: snapshot.selection.selectionIdentity, snapshot,
  }
  const result = await provider.preview({
    accountId: account.id, batchId: 'batch-preview', lockedSelection: envelope,
  })
  assert.equal(result.realExecutionEligible, true)
  assert.deepEqual(result.realExecutionBlockers, [])
  assert.deepEqual(result.executionPreview, {
    minStakeMinor: 50, maxStakeMinor: 20000, stakeStepMinor: 1,
    stakeStepProvenance: 'verified-account-policy', odds: '0.96', line: '0.5 / 1',
    submitCon: '1', submitRatio: '50',
    currency: 'CNY', amountScale: 0, lockedIdentity: lockedIdentity(),
  })
  assert.equal(result.freshBalanceCny, 500)
  assert.equal(result.browserSession, session)
  assert.equal(Object.keys(result).includes('browserSession'), false)
})

test('strict Submit response accepts only the direct 560 identity and amount/odds echo contract', () => {
  const expected = {
    gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RH', amount: '50', odds: '0.96',
  }
  const response = (values = {}) => `<serverresponse>
    <code>${values.code ?? '560'}</code><w_id>${values.result ?? 'order-safe'}</w_id>
    <gid>${values.gid ?? expected.gid}</gid><gtype>${values.gtype ?? expected.gtype}</gtype>
    <wtype>${values.wtype ?? expected.wtype}</wtype><rtype>${values.rtype ?? expected.rtype}</rtype>
    <gold>${values.amount ?? expected.amount}</gold><ioratio>${values.odds ?? expected.odds}</ioratio>
  </serverresponse>`

  const accepted = parseCrownSubmitResponseStrict(response(), {
    expected, sealReference: () => 'v2:safe:cipher:text',
  })
  assert.equal(accepted.kind, 'accepted')
  assert.equal(accepted.providerReferenceCiphertext, 'v2:safe:cipher:text')
  assert.equal(JSON.stringify(accepted).includes('order-safe'), false)
  assert.equal(parseCrownSubmitResponseStrict(response({ odds: '0.960' }), {
    expected, sealReference: () => 'v2:safe:cipher:text',
  }).kind, 'accepted')

  for (const values of [
    { code: '561' }, { result: '' }, { gid: 'drift' }, { gtype: 'HT' },
    { wtype: 'RE' }, { rtype: 'RC' }, { amount: '100' }, { odds: '0.95' },
  ]) {
    assert.deepEqual(parseCrownSubmitResponseStrict(response(values), {
      expected, sealReference: () => 'v2:safe:cipher:text',
    }), { kind: 'unknown' })
  }
})

test('execution provider starts one network call, builds FT_bet internally, and returns only ciphertext', async () => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const calls = []
  const logs = []
  const account = {
    id: 'account-safe', username: 'owner-safe', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 50, currency: 'CNY',
  }
  const session = {
    accountId: account.id, username: account.username, baseUrl: account.loginUrl,
    origin: account.loginUrl, uid: 'uid-private', protocolVersion: 'verified-version',
    contextGeneration: 'submit-generation',
    protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
  }
  const submitResponseFields = Object.fromEntries(capability.submitResponseFieldSet.map((field) => [field, 'x']))
  Object.assign(submitResponseFields, {
    code: '560', gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RC',
    gold: '50', ioratio: '0.96', mid: 'member-private', username: account.username,
    w_id: 'reference-private',
  })
  const xml = `<serverresponse>${Object.entries(submitResponseFields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  const repository = {
    getBettingAccountForExecution(id) { return id === account.id ? account : null },
    getCurrentCrownSelectionForExecution(value) {
      assert.deepEqual(value, lockedEnvelope())
      return structuredClone(lockedEnvelope())
    },
    sealCrownProviderReference(value, context) {
      assert.equal(value, 'reference-private')
      assert.deepEqual(context, { childOrderId: 'child-safe', submitAttemptId: 'attempt-safe' })
      return 'v2:safe:cipher:text'
    },
  }
  const browserRuntime = {
    verifiedBettingSessionFor({ session: currentSession }) {
      assert.equal(currentSession, session)
      return session
    },
    async postSubmitForm(input) {
      calls.push(input)
      await input.beforeDispatch()
      return {
        text: xml,
        transport: { operation: 'FT_bet', endpointPath: '/transform.php', status: 200 },
      }
    },
  }
  const lease = {
    leaseKey: 'betting-executor:task10-test', fencingToken: 1,
    assertFence(token) { assert.equal(token, 1); return 1 },
  }
  const provider = new CrownAccountExecutionProvider({
    repository, browserRuntime, executorLease: lease, logger: (row) => logs.push(row),
  })
  let networkStarted = 0
  const result = await provider.submit({
    accountId: account.id,
    batchId: 'batch-safe',
    childOrderId: 'child-safe',
    submitAttemptId: 'attempt-safe',
    capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId,
    lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(),
    preview: preview(),
    browserSession: session,
    amountMinor: 50,
    remainingChildAmountMinor: 50,
    onNetworkStarted() { networkStarted += 1 },
  })
  assert.deepEqual(result, {
    kind: 'accepted', providerReferenceCiphertext: 'v2:safe:cipher:text',
    transportKind: 'browser-page-fetch',
  })
  assert.equal(networkStarted, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].wireFields.p, 'FT_bet')
  assert.equal(Object.hasOwn(calls[0].wireFields, 'uid'), false)
  assert.equal(calls[0].wireFields.golds, '50')
  assert.equal(calls[0].wireFields.f, '1R')
  assert.doesNotMatch(JSON.stringify({ result, logs }), /uid-private|reference-private|member-private/)
})

test('execution provider validates every final Preview identity and money field before Browser Submit', async (t) => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const account = {
    id: 'account-safe', username: 'owner-safe', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 50, currency: 'CNY',
  }
  const session = {
    accountId: account.id, username: account.username, origin: account.loginUrl,
    baseUrl: account.loginUrl, uid: 'uid-private', protocolVersion: 'verified-version',
    contextGeneration: 'validation-generation',
    protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
  }
  const baseInput = {
    accountId: account.id, batchId: 'batch-safe', childOrderId: 'child-safe',
    submitAttemptId: 'attempt-safe', capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId, lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(), preview: preview(),
    browserSession: session,
    amountMinor: 50, remainingChildAmountMinor: 50, onNetworkStarted() {},
  }
  const cases = [
    ...Object.keys(lockedIdentity()).map((field) => [field, {
      ...preview(), lockedIdentity: { ...lockedIdentity(), [field]: `${lockedIdentity()[field]}-drift` },
    }]),
    ['odds', { ...preview(), odds: '0.95' }],
    ['minimum', { ...preview(), minStakeMinor: 100 }],
    ['balance', { ...preview(), balanceMinor: 49 }],
  ]
  for (const [name, finalPreview] of cases) {
    await t.test(name, async () => {
      let submitCalls = 0
      let currentReads = 0
      const repository = {
        getBettingAccountForExecution() { return account },
        getCurrentCrownSelectionForExecution(value) {
          currentReads += 1
          assert.deepEqual(value, lockedEnvelope())
          return structuredClone(lockedEnvelope())
        },
        sealCrownProviderReference() { throw new Error('seal-must-not-run') },
      }
      const provider = new CrownAccountExecutionProvider({
        repository,
        browserRuntime: {
          verifiedBettingSessionFor() { return session },
          async postSubmitForm() { submitCalls += 1; throw new Error('submit-must-not-run') },
        },
        executorLease: {
          leaseKey: 'betting-executor:task10-recheck', fencingToken: 1,
          assertFence() { return 1 },
        },
      })
      await assert.rejects(() => provider.submit({ ...baseInput, preview: finalPreview }),
        /crown-submit-(?:current-identity-drift|fresh-preview-drift)/)
      assert.equal(currentReads, 1)
      assert.equal(submitCalls, 0)
    })
  }
})

test('execution provider rejects latest Crown selection identity and odds drift before account or Browser Submit', async (t) => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const baseInput = {
    accountId: 'account-safe', batchId: 'batch-safe', childOrderId: 'child-safe',
    submitAttemptId: 'attempt-safe', capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId, lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(), preview: preview(), amountMinor: 50,
    remainingChildAmountMinor: 50, onNetworkStarted() {},
  }
  for (const field of ['gid', 'mode', 'period', 'market', 'lineVariant', 'line', 'side', 'odds']) {
    await t.test(field, async () => {
      let submitCalls = 0
      const current = field === 'odds' ? structuredClone(lockedEnvelope()) : currentEnvelopeWithIdentityDrift(field)
      if (field === 'odds') current.snapshot.selection.oddsRaw = '0.95'
      const provider = new CrownAccountExecutionProvider({
        repository: {
          getBettingAccountForExecution() { throw new Error('account-must-not-read') },
          getCurrentCrownSelectionForExecution() { return current },
          sealCrownProviderReference() { throw new Error('seal-must-not-run') },
        },
        browserRuntime: {
          verifiedBettingSessionFor() { throw new Error('session-must-not-read') },
          async postSubmitForm() { submitCalls += 1 },
        },
        executorLease: {
          leaseKey: 'betting-executor:task10-current-selection', fencingToken: 1,
          assertFence() { return 1 },
        },
      })
      await assert.rejects(() => provider.submit(baseInput),
        /crown-submit-(?:current-identity-drift|fresh-preview-drift)/)
      assert.equal(submitCalls, 0)
    })
  }
})

function browserSession(account) {
  return Object.freeze({
    accountId: account.id,
    username: account.username,
    origin: account.loginUrl,
    baseUrl: account.loginUrl,
    uid: 'browser-private-uid',
    protocolVersion: 'browser-version',
    protocolVersionEvidence: {
      source: 'production-login-response', captured: true, verified: true,
    },
    contextGeneration: 'browser-generation-1',
  })
}

test('production Submit forwards B2 beforeDispatch unchanged to BrowserAccountRuntime and accepts the fresh minimum', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('node-fetch-must-not-run') }
  t.after(() => { globalThis.fetch = originalFetch })
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const account = {
    id: 'browser-submit', username: 'browser-owner', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 200, currency: 'CNY',
  }
  const session = browserSession(account)
  const submitFields = Object.fromEntries(capability.submitResponseFieldSet.map((field) => [field, 'x']))
  Object.assign(submitFields, {
    code: '560', gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RC',
    gold: '60', ioratio: '0.96', w_id: 'browser-reference-private',
  })
  const submitXml = `<serverresponse>${Object.entries(submitFields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  let submitted = null
  const browserRuntime = {
    verifiedBettingSessionFor({ account: checkedAccount, session: checkedSession }) {
      assert.equal(checkedAccount, account)
      assert.equal(checkedSession, session)
      return session
    },
    async postSubmitForm(input) {
      submitted = input
      await input.beforeDispatch()
      return {
        text: submitXml,
        transport: { operation: 'FT_bet', endpointPath: '/transform.php', status: 200 },
      }
    },
  }
  const finalExecutionPreview = {
    ...preview(), minStakeMinor: 60, maxStakeMinor: 1000,
    balanceMinor: 300, stakeStepMinor: null,
    stakeStepProvenance: 'not-evidenced-in-preview-response',
  }
  const repository = {
    getBettingAccountForExecution() { return account },
    getCurrentCrownSelectionForExecution() { return structuredClone(lockedEnvelope()) },
    sealCrownProviderReference(reference) {
      assert.equal(reference, 'browser-reference-private')
      return 'v2:safe:cipher:text'
    },
  }
  const provider = new CrownAccountExecutionProvider({
    repository,
    browserRuntime,
    loginManager: {
      client: { async postForm() { throw new Error('legacy-post-form-must-not-run') } },
      bettingStoreFor() { throw new Error('legacy-session-store-must-not-run') },
    },
    executorLease: {
      leaseKey: 'betting-executor:browser-submit', fencingToken: 1,
      assertFence() { return 1 },
    },
  })
  let networkStarted = 0
  const beforeDispatch = () => { networkStarted += 1 }
  const result = await provider.submit({
    accountId: account.id,
    batchId: 'browser-submit-batch',
    childOrderId: 'browser-child',
    submitAttemptId: 'browser-attempt',
    capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId,
    lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(),
    preview: finalExecutionPreview,
    browserSession: session,
    amountMinor: 60,
    remainingChildAmountMinor: 60,
    onNetworkStarted: beforeDispatch,
  })

  assert.equal(networkStarted, 1)
  assert.equal(submitted.beforeDispatch, beforeDispatch)
  assert.equal(submitted.session, session)
  assert.equal(submitted.wireFields.golds, '60')
  assert.deepEqual(result, {
    kind: 'accepted', providerReferenceCiphertext: 'v2:safe:cipher:text',
    transportKind: 'browser-page-fetch',
  })
})

test('production Submit blocks above-minimum stakes when fresh Preview has no verified step', async () => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const account = {
    id: 'browser-submit', username: 'browser-owner', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 500, currency: 'CNY',
  }
  const session = browserSession(account)
  const executionPreview = {
    ...preview(), minStakeMinor: 60, maxStakeMinor: 1000, balanceMinor: 500,
    stakeStepMinor: null, stakeStepProvenance: 'not-evidenced-in-preview-response',
  }
  let submitCalls = 0
  const provider = new CrownAccountExecutionProvider({
    repository: {
      getBettingAccountForExecution() { return account },
      getCurrentCrownSelectionForExecution() { return lockedEnvelope() },
      sealCrownProviderReference() { throw new Error('seal-must-not-run') },
    },
    browserRuntime: {
      verifiedBettingSessionFor() { return session },
      async postSubmitForm() { submitCalls += 1 },
    },
    executorLease: {
      leaseKey: 'betting-executor:browser-submit-step', fencingToken: 1,
      assertFence() { return 1 },
    },
  })
  await assert.rejects(() => provider.submit({
    accountId: account.id, batchId: 'batch', childOrderId: 'child', submitAttemptId: 'attempt',
    capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId, lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(), preview: executionPreview, browserSession: session,
    amountMinor: 120, remainingChildAmountMinor: 120, onNetworkStarted() {},
  }), /crown-submit-fresh-preview-drift/)
  assert.equal(submitCalls, 0)
})

test('production Submit allows an above-minimum stake only with a provider-evidenced step', async () => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const account = {
    id: 'browser-stepped-submit', username: 'browser-owner', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 500, currency: 'CNY',
  }
  const session = browserSession(account)
  const finalPreview = {
    ...preview(), minStakeMinor: 60, maxStakeMinor: 1000, balanceMinor: 500,
    stakeStepMinor: 30, stakeStepProvenance: 'provider-preview-response',
  }
  const fields = Object.fromEntries(capability.submitResponseFieldSet.map((field) => [field, 'x']))
  Object.assign(fields, {
    code: '560', gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RC',
    gold: '120', ioratio: '0.96', w_id: 'stepped-reference',
  })
  const xml = `<serverresponse>${Object.entries(fields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  let submitted = null
  const provider = new CrownAccountExecutionProvider({
    repository: {
      getBettingAccountForExecution() { return account },
      getCurrentCrownSelectionForExecution() { return lockedEnvelope() },
      sealCrownProviderReference() { return 'v2:safe:stepped' },
    },
    browserRuntime: {
      verifiedBettingSessionFor() { return session },
      async postSubmitForm(input) {
        submitted = input
        await input.beforeDispatch()
        return {
          text: xml,
          transport: { operation: 'FT_bet', endpointPath: '/transform.php', status: 200 },
        }
      },
    },
    executorLease: {
      leaseKey: 'betting-executor:browser-submit-step-evidence', fencingToken: 1,
      assertFence() { return 1 },
    },
  })
  let networkStarted = 0
  const result = await provider.submit({
    accountId: account.id, batchId: 'batch', childOrderId: 'child', submitAttemptId: 'attempt',
    capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId, lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(), preview: finalPreview, browserSession: session,
    amountMinor: 120, remainingChildAmountMinor: 120,
    onNetworkStarted() { networkStarted += 1 },
  })
  assert.equal(networkStarted, 1)
  assert.equal(submitted.wireFields.golds, '120')
  assert.deepEqual(result, {
    kind: 'accepted', providerReferenceCiphertext: 'v2:safe:stepped',
    transportKind: 'browser-page-fetch',
  })
})
