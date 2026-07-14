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

const CAPABILITY_KEY = 'prematch|full_time|asian_handicap|main'

function record(side = 'home') {
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

function lockedIdentity(side = 'home') {
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

function preview(side = 'home') {
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

function lockedEnvelope(side = 'home') {
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
  if (field === 'side') envelope.side = envelope.snapshot.selection.side = 'away'
  return envelope
}

test('canonical matrix enables exactly one accepted-only row and keeps reconciliation closed', () => {
  const rows = listCrownCapabilities()
  const enabled = rows.filter((row) => row.previewAllowed || row.submitAllowed || row.reconciliationAllowed)
  assert.deepEqual(enabled.map((row) => row.key), [CAPABILITY_KEY])
  assert.equal(enabled[0].previewAllowed, true)
  assert.equal(enabled[0].submitAllowed, true)
  assert.equal(enabled[0].reconciliationAllowed, false)
  assert.equal(assertCrownCapability(enabled[0], { operation: 'preview' }).key, CAPABILITY_KEY)
  assert.equal(assertCrownCapability(enabled[0], { operation: 'submit' }).key, CAPABILITY_KEY)
  assert.throws(() => assertCrownCapability(enabled[0], { operation: 'reconciliation' }), /reconciliation-blocked/)

  const verified = verifyCrownCapabilityMatrix()
  assert.equal(verified.ok, true, verified.errors.join(', '))
  assert.deepEqual([
    verified.allowedPreviewCount,
    verified.allowedSubmitCount,
    verified.allowedReconciliationCount,
  ], [1, 1, 0])
})

test('watcher marks only prematch RATIO_R full-time asian handicap as main', () => {
  const xml = `<serverresponse><code>617</code><game>
    <GID>1001</GID><LID>1</LID><ECID>2</ECID><LEAGUE>Safe</LEAGUE><TEAM_H>H</TEAM_H><TEAM_C>C</TEAM_C>
    <RATIO_R>0.5 / 1</RATIO_R><IOR_RH>0.96</IOR_RH><IOR_RC>0.94</IOR_RC>
    <RATIO_RE>0.5 / 1</RATIO_RE><IOR_REH>0.92</IOR_REH><IOR_REC>0.98</IOR_REC>
    <RATIO_AR>1</RATIO_AR><IOR_ARH>0.90</IOR_ARH><IOR_ARC>1.00</IOR_ARC>
  </game></serverresponse>`
  const prematch = normalizeCrownTransformXml({ body: xml, metadata: { mode: 'prematch' } })
  const r = prematch.filter((item) => item.market.ratioField === 'RATIO_R')
  assert.equal(r.length, 2)
  assert.ok(r.every((item) => item.market.lineVariant === 'main' && item.market.isMainMarket === true))
  assert.ok(prematch.filter((item) => item.market.ratioField !== 'RATIO_R')
    .every((item) => item.market.lineVariant !== 'main' && item.market.isMainMarket !== true))

  const live = normalizeCrownTransformXml({
    body: xml.replace('<GID>1001</GID>', '<SHOWTYPE>RB</SHOWTYPE><GID>1001</GID>'),
  })
  assert.ok(live.every((item) => item.market.lineVariant !== 'main' && item.market.isMainMarket !== true))
})

test('strict Preview and Submit map exact home and away fields; opaque f=1R stays full-time', () => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  for (const [side, choseTeam, rtype] of [['home', 'H', 'RH'], ['away', 'C', 'RC']]) {
    const mapped = buildStrictCrownPreviewFields(record(side), { capability })
    assert.deepEqual(mapped.preview, {
      gid: 'event-safe', gtype: 'FT', wtype: 'R', chose_team: choseTeam,
    })
    assert.equal(mapped.identity.period, 'full_time')

    const before = Date.now()
    const submit = buildStrictCrownSubmitWireFields({
      lockedIdentity: lockedIdentity(side),
      currentIdentity: lockedIdentity(side),
      preview: preview(side),
      amountMinor: 50,
    }, {
      capability,
      protocolVersion: 'verified-version',
      protocolVersionEvidence: {
        source: 'production-session-metadata', captured: true, verified: true,
      },
    })
    const after = Date.now()
    assert.equal(submit.p, 'FT_bet')
    assert.equal(submit.gtype, 'FT')
    assert.equal(submit.wtype, 'R')
    assert.equal(submit.rtype, rtype)
    assert.equal(submit.chose_team, choseTeam)
    assert.equal(submit.isRB, 'N')
    assert.equal(submit.f, '1R')
    assert.equal(submit.golds, '50')
    assert.equal(submit.con, '1')
    assert.equal(submit.ratio, '50')
    assert.equal(submit.timestamp2, '')
    assert.match(submit.timestamp, /^\d{13}$/)
    assert.ok(Number(submit.timestamp) >= before && Number(submit.timestamp) <= after)
  }

  assert.doesNotThrow(() => buildStrictCrownSubmitWireFields({
    lockedIdentity: lockedIdentity(), currentIdentity: lockedIdentity(),
    preview: preview(), amountMinor: 100,
  }, {
    capability,
    protocolVersion: 'verified-version',
    protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
  }))
  for (const amountMinor of [49, 51, 80]) {
    assert.throws(() => buildStrictCrownSubmitWireFields({
      lockedIdentity: lockedIdentity(), currentIdentity: lockedIdentity(),
      preview: preview(), amountMinor,
    }, {
      capability,
      protocolVersion: 'verified-version',
      protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
    }), /crown-submit-(?:money-contract|local-quantum)/)
  }
})

test('production Preview returns the evidence-complete B2 execution contract for the exact row', async () => {
  const account = {
    id: 'account-preview', username: 'owner-preview', loginUrl: 'https://crown.example.com',
    currency: 'CNY', perBetLimitMinor: 50,
  }
  const session = {
    accountId: account.id, username: account.username, baseUrl: account.loginUrl,
    uid: 'private-uid', cookies: { SESSION: 'private-cookie' }, protocolVersion: 'verified-version',
    protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
  }
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const fields = Object.fromEntries(capability.responseFieldSet.map((field) => [field, 'x']))
  Object.assign(fields, {
    code: '501', gold_gmin: '50', gold_gmax: '20000', ioratio: '0.96', spread: '0.5 / 1',
    con: '1', ratio: '50',
  })
  const xml = `<serverresponse>${Object.entries(fields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  let saved = null
  const loginManager = {
    async ensureBettingSession() { return { session } },
    async fetchFreshExecutionBalance() {
      const result = { currency: 'CNY', balanceCny: 500, observedAt: '2026-07-14T00:00:00.000Z' }
      Object.defineProperty(result, 'session', { value: session })
      return result
    },
    client: { async postForm() { return { text: xml, cookies: { SESSION: 'rotated-private' } } } },
    bettingStoreFor() { return { saveSession(_account, value) { saved = value } } },
  }
  const provider = new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { return account } },
    loginManager,
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
      selectionIdentity: 'crown|football|gid=event-safe|full_time|asian_handicap|RATIO_R|home',
    },
  }
  const envelope = {
    provider: 'crown', eventKey: snapshot.event.eventKey, period: 'full_time',
    marketType: 'asian_handicap', lineKey: 'RATIO_R', side: 'home',
    selectionIdentity: snapshot.selection.selectionIdentity, snapshot,
  }
  const result = await provider.preview({
    accountId: account.id, batchId: 'batch-preview', lockedSelection: envelope,
  })
  assert.equal(result.realExecutionEligible, true)
  assert.deepEqual(result.realExecutionBlockers, [])
  assert.deepEqual(result.executionPreview, {
    minStakeMinor: 50, maxStakeMinor: 20000, stakeStepMinor: 50,
    stakeStepProvenance: 'local-conservative-policy', odds: '0.96', line: '0.5 / 1',
    submitCon: '1', submitRatio: '50',
    currency: 'CNY', amountScale: 0, lockedIdentity: lockedIdentity(),
  })
  assert.equal(result.freshBalanceCny, 500)
  assert.equal(Object.hasOwn(saved, 'protocolVersion'), true)
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
  let saved = null
  const session = {
    accountId: account.id, username: account.username, baseUrl: account.loginUrl,
    uid: 'uid-private', cookies: { SESSION: 'private' }, protocolVersion: 'verified-version',
    protocolVersionEvidence: { source: 'production-session-metadata', captured: true, verified: true },
  }
  const submitResponseFields = Object.fromEntries(capability.submitResponseFieldSet.map((field) => [field, 'x']))
  Object.assign(submitResponseFields, {
    code: '560', gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RH',
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
  const loginManager = {
    verifiedBettingSessionFor({ session: storedSession }) {
      assert.equal(storedSession, session)
      return session
    },
    bettingStoreFor() {
      return {
        readSession() { return { session } },
        saveSession(_account, value) { saved = value },
      }
    },
    client: {
      async postForm(input) {
        calls.push(input)
        return { text: xml, cookies: { SESSION: 'rotated-private' } }
      },
    },
  }
  const lease = {
    leaseKey: 'betting-executor:task10-test', fencingToken: 1,
    assertFence(token) { assert.equal(token, 1); return 1 },
  }
  let freshPreviewCalls = 0
  const previewProvider = {
    async preview({ accountId, batchId, lockedSelection }) {
      freshPreviewCalls += 1
      assert.equal(accountId, account.id)
      assert.equal(batchId, 'batch-safe')
      assert.deepEqual(lockedSelection, lockedEnvelope())
      return {
        lockedIdentity: structuredClone(lockedIdentity()),
        executionPreview: structuredClone(preview()),
        freshBalanceCny: 500,
        capabilityEvidenceId: capability.evidenceId,
        capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
      }
    },
  }
  const provider = new CrownAccountExecutionProvider({
    repository, loginManager, previewProvider, executorLease: lease, logger: (row) => logs.push(row),
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
    amountMinor: 50,
    remainingChildAmountMinor: 50,
    onNetworkStarted() { networkStarted += 1 },
  })
  assert.deepEqual(result, { kind: 'accepted', providerReferenceCiphertext: 'v2:safe:cipher:text' })
  assert.equal(networkStarted, 1)
  assert.equal(freshPreviewCalls, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].form.p, 'FT_bet')
  assert.equal(calls[0].form.uid, 'uid-private')
  assert.equal(calls[0].form.golds, '50')
  assert.equal(calls[0].form.f, '1R')
  assert.equal(saved.cookies.SESSION, 'rotated-private')
  assert.doesNotMatch(JSON.stringify({ result, logs }), /uid-private|reference-private|member-private|rotated-private/)
})

test('execution provider independently re-reads and re-Previews all identity fields and prepared money before Submit', async (t) => {
  const capability = listCrownCapabilities().find((row) => row.key === CAPABILITY_KEY)
  const account = {
    id: 'account-safe', username: 'owner-safe', loginUrl: 'https://crown.example.com',
    perBetLimitMinor: 50, currency: 'CNY',
  }
  const session = {
    accountId: account.id, username: account.username, baseUrl: account.loginUrl,
    uid: 'uid-private', cookies: {}, protocolVersion: 'verified-version',
    protocolVersionEvidence: { source: 'production-login-response', captured: true, verified: true },
  }
  const baseInput = {
    accountId: account.id, batchId: 'batch-safe', childOrderId: 'child-safe',
    submitAttemptId: 'attempt-safe', capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
    capabilityEvidenceId: capability.evidenceId, lockedIdentity: lockedIdentity(),
    lockedSelection: lockedEnvelope(), preview: preview(),
    amountMinor: 50, remainingChildAmountMinor: 50, onNetworkStarted() {},
  }
  const cases = [
    ...Object.keys(lockedIdentity()).map((field) => [field, {
      identity: { ...lockedIdentity(), [field]: `${lockedIdentity()[field]}-drift` },
    }]),
    ['odds', { executionPreview: { ...preview(), odds: '0.95' } }],
    ['minimum', { executionPreview: { ...preview(), minStakeMinor: 100 } }],
    ['balance', { balance: 499 }],
  ]
  for (const [name, mutation] of cases) {
    await t.test(name, async () => {
      let submitCalls = 0
      let currentReads = 0
      let previewCalls = 0
      const repository = {
        getBettingAccountForExecution() { return account },
        getCurrentCrownSelectionForExecution(value) {
          currentReads += 1
          assert.deepEqual(value, lockedEnvelope())
          return structuredClone(lockedEnvelope())
        },
        sealCrownProviderReference() { throw new Error('seal-must-not-run') },
      }
      const loginManager = {
        verifiedBettingSessionFor() { return session },
        bettingStoreFor() { return { readSession() { return { session } }, saveSession() {} } },
        client: { async postForm() { submitCalls += 1; throw new Error('submit-must-not-run') } },
      }
      const previewProvider = {
        async preview() {
          previewCalls += 1
          return {
            lockedIdentity: mutation.identity || structuredClone(lockedIdentity()),
            executionPreview: mutation.executionPreview || structuredClone(preview()),
            freshBalanceCny: mutation.balance ?? 500,
            capabilityEvidenceId: capability.evidenceId,
            capabilityVersion: verifyCrownCapabilityMatrix().matrixVersion,
          }
        },
      }
      const provider = new CrownAccountExecutionProvider({
        repository, loginManager, previewProvider,
        executorLease: {
          leaseKey: 'betting-executor:task10-recheck', fencingToken: 1,
          assertFence() { return 1 },
        },
      })
      await assert.rejects(() => provider.submit(baseInput),
        /crown-submit-(?:current-identity-drift|fresh-preview-drift)/)
      assert.equal(currentReads, 1)
      assert.equal(previewCalls, 1)
      assert.equal(submitCalls, 0)
    })
  }
})

test('execution provider rejects latest Crown selection identity and odds drift before fresh Preview or Submit', async (t) => {
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
      let previewCalls = 0
      let submitCalls = 0
      const current = field === 'odds' ? structuredClone(lockedEnvelope()) : currentEnvelopeWithIdentityDrift(field)
      if (field === 'odds') current.snapshot.selection.oddsRaw = '0.95'
      const provider = new CrownAccountExecutionProvider({
        repository: {
          getBettingAccountForExecution() { throw new Error('account-must-not-read') },
          getCurrentCrownSelectionForExecution() { return current },
          sealCrownProviderReference() { throw new Error('seal-must-not-run') },
        },
        loginManager: {
          bettingStoreFor() { throw new Error('session-must-not-read') },
          client: { async postForm() { submitCalls += 1 } },
        },
        previewProvider: { async preview() { previewCalls += 1 } },
        executorLease: {
          leaseKey: 'betting-executor:task10-current-selection', fencingToken: 1,
          assertFence() { return 1 },
        },
      })
      await assert.rejects(() => provider.submit(baseInput),
        /crown-submit-(?:current-identity-drift|fresh-preview-drift)/)
      assert.equal(previewCalls, 0)
      assert.equal(submitCalls, 0)
    })
  }
})
