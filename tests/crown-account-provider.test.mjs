import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  CrownAccountPreviewProvider,
  createOfflineCrownAccountPreviewFixture,
} from '../src/crown/betting/crown-account-provider.mjs'
import { CrownAccountExecutionProvider } from '../src/crown/betting/crown-account-execution-provider.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  getCrownCapability,
} from '../src/crown/betting/crown-capability-matrix.mjs'

const CAPABILITY_INPUT = Object.freeze({
  mode: 'prematch', period: 'full_time', marketType: 'asian_handicap',
  lineVariant: 'main', selectionSide: 'away',
})

function capability() {
  return getCrownCapability(CAPABILITY_INPUT)
}

function lockedSelection(overrides = {}) {
  const base = {
    provider: 'crown',
    mode: 'prematch',
    event: { eventKey: 'crown|football|gid=event-safe', ids: { gid: 'event-safe' } },
    market: {
      marketType: 'asian_handicap', period: 'full_time', lineVariant: 'main',
      lineKey: 'RATIO_R', ratioField: 'RATIO_R', handicapRaw: '0.5 / 1',
    },
    selection: {
      selectionIdentity: 'crown|football|gid=event-safe|full_time|asian_handicap|RATIO_R|away',
      side: 'away', oddsField: 'IOR_RC', oddsRaw: '0.96',
    },
  }
  const snapshot = {
    ...base,
    mode: overrides.mode ?? base.mode,
    event: { ...base.event, ...(overrides.event || {}) },
    market: { ...base.market, ...(overrides.market || {}) },
    selection: { ...base.selection, ...(overrides.selection || {}) },
  }
  return {
    provider: overrides.provider || 'crown', eventKey: snapshot.event.eventKey,
    period: snapshot.market.period, marketType: snapshot.market.marketType,
    lineKey: snapshot.market.lineKey, side: snapshot.selection.side,
    selectionIdentity: snapshot.selection.selectionIdentity, snapshot,
  }
}

function previewXml({ minimum = '60', maximum = '1000', odds = '0.96', line = '0.5 / 1', extra = {} } = {}) {
  const fields = Object.fromEntries(capability().responseFieldSet.map((field) => [field, 'x']))
  Object.assign(fields, {
    code: '501', gold_gmin: minimum, gold_gmax: maximum,
    ioratio: odds, spread: line, con: '1', ratio: minimum,
  }, extra)
  return `<serverresponse>${Object.entries(fields)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
}

function account(overrides = {}) {
  return {
    id: 'bet-owner', username: 'owner', password: 'private-password',
    loginUrl: 'https://crown.example.com', currency: 'CNY', perBetLimitMinor: 200,
    ...overrides,
  }
}

function sessionFor(current, overrides = {}) {
  return Object.freeze({
    accountId: current.id, username: current.username,
    origin: current.loginUrl, baseUrl: current.loginUrl,
    uid: 'private-browser-uid', protocolVersion: 'browser-version',
    protocolVersionEvidence: {
      source: 'production-login-response', captured: true, verified: true,
    },
    contextGeneration: 'browser-generation-1',
    ...overrides,
  })
}

function trustedResolver(row = capability(), expectedInput = CAPABILITY_INPUT) {
  return {
    resolvePreview(input) {
      assert.deepEqual(input, expectedInput)
      return structuredClone(row)
    },
    assertFieldSets(value, observed) {
      assert.equal(value.evidenceId, row.evidenceId)
      if (observed.requestFieldSet) {
        assert.deepEqual([...observed.requestFieldSet].sort(), [...row.requestFieldSet].sort())
      }
      if (observed.responseFieldSet) {
        assert.deepEqual([...observed.responseFieldSet].sort(), [...row.responseFieldSet].sort())
      }
      return structuredClone(row)
    },
  }
}

test('live Preview uses the verified live response field set without changing the campaign matrix version', async () => {
  const liveInput = {
    mode: 'live', period: 'full_time', marketType: 'asian_handicap',
    lineVariant: 'main', selectionSide: 'home',
  }
  const liveRow = structuredClone(getCrownCapability(liveInput))
  liveRow.submitAllowed = true
  const liveFields = [...capability().responseFieldSet, 'score']
  const values = Object.fromEntries(liveFields.map((field) => [field, 'x']))
  Object.assign(values, {
    code: '501', gold_gmin: '50', gold_gmax: '1000', ioratio: '0.96',
    spread: '0.5', con: '0.5', ratio: '50',
  })
  const xml = `<serverresponse>${Object.entries(values)
    .map(([field, value]) => `<${field}>${value}</${field}>`).join('')}</serverresponse>`
  const current = account({ loginUrl: 'https://offline-preview.example.com' })
  const currentSession = sessionFor(current)
  const harness = runtimeHarness({ currentAccount: current, currentSession, xml })
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { return current } },
    browserRuntime: harness.browserRuntime,
    executorLease: executorLease(),
    capabilityResolver: trustedResolver(liveRow, liveInput),
  })
  const selection = lockedSelection({
    mode: 'live',
    market: { lineKey: 'RATIO_RE', ratioField: 'RATIO_RE', handicapRaw: '0.5' },
    selection: {
      side: 'home', oddsField: 'IOR_REH', oddsRaw: '0.96',
      selectionIdentity: 'crown|football|gid=event-safe|full_time|asian_handicap|RATIO_RE|home',
    },
  })

  const result = await provider.preview({
    accountId: current.id, batchId: 'live-preview-fields', lockedSelection: selection,
  })

  assert.equal(result.executionPreview.minStakeMinor, 50)
  assert.equal(result.executionPreview.line, '0.5')
  assert.match(CROWN_CAPABILITY_MATRIX_VERSION, /^crown-protocol-capabilities-v2:[a-f0-9]{16}$/)
})

function runtimeHarness({
  currentAccount = account(),
  currentSession = sessionFor(currentAccount),
  xml = previewXml(),
  balance = '300.00',
  currency = 'CNY',
  previewError = null,
} = {}) {
  const calls = []
  const browserRuntime = {
    async ensureBettingSession(input) {
      calls.push({ operation: 'session', input })
      return currentSession
    },
    async fetchFreshExecutionBalance(input) {
      calls.push({ operation: 'balance', input })
      return {
        summary: { valid: true, reportedBalance: balance, reportedCurrency: currency },
        session: currentSession,
        transport: { operation: 'get_member_data', endpointPath: '/transform.php', status: 200 },
      }
    },
    async postPreviewForm(input) {
      calls.push({ operation: 'preview', input })
      if (previewError) throw previewError
      return {
        text: xml,
        transport: { operation: 'FT_order_view', endpointPath: '/transform.php', status: 200 },
      }
    },
  }
  return { browserRuntime, calls, session: currentSession }
}

function executorLease(assertFence = () => 1) {
  return { leaseKey: 'betting-executor:provider-test', fencingToken: 1, assertFence }
}

function productionProvider({ currentAccount = account(), harness = runtimeHarness({ currentAccount }), lease } = {}) {
  return {
    provider: new CrownAccountPreviewProvider({
      repository: { getBettingAccountForExecution() { return currentAccount } },
      browserRuntime: harness.browserRuntime,
      executorLease: lease || executorLease(),
    }),
    harness,
  }
}

test('production providers require the factory-owned Browser runtime and executor lease', () => {
  assert.throws(() => new CrownAccountPreviewProvider({}), /crown-preview-browser-runtime/)
  assert.throws(() => new CrownAccountExecutionProvider({}), /crown-submit-account-repository/)
  assert.throws(() => new CrownAccountExecutionProvider({
    repository: {
      getBettingAccountForExecution() {}, getCurrentCrownSelectionForExecution() {},
      sealCrownProviderReference() {},
    },
  }), /crown-submit-browser-runtime/)
})

test('production providers reject a structurally similar acceptance authority', () => {
  const current = account()
  const harness = runtimeHarness({ currentAccount: current })
  const forged = {
    resolveCapability() { return capability() },
    claimDispatchInTransaction() {},
  }
  assert.throws(() => new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { return current } },
    browserRuntime: harness.browserRuntime,
    executorLease: executorLease(),
    acceptanceAuthority: forged,
  }), /crown-acceptance-authority/)
  assert.throws(() => new CrownAccountExecutionProvider({
    repository: {
      getBettingAccountForExecution() { return current }, getCurrentCrownSelectionForExecution() {},
      sealCrownProviderReference() {},
    },
    browserRuntime: { verifiedBettingSessionFor() {}, postSubmitForm() {} },
    executorLease: executorLease(),
    acceptanceAuthority: forged,
  }), /crown-acceptance-authority/)
})

test('an injected acceptance authority does not elevate ordinary Preview without a Worker-owned claim', async () => {
  const effects = { authority: 0, repository: 0, browser: 0 }
  const authority = Object.create(null)
  Object.defineProperty(authority, 'resolveCapability', { value() { effects.authority += 1; throw new Error('must-not-run') } })
  const provider = Object.create(CrownAccountPreviewProvider.prototype)
  provider.repository = { getBettingAccountForExecution() { effects.repository += 1 } }
  provider.browserRuntime = { ensureBettingSession() { effects.browser += 1 } }
  provider.executorLease = executorLease()
  provider.acceptanceAuthority = authority
  provider.capabilityResolver = {
    resolvePreview(input) {
      return input.selectionSide === 'away'
        ? getCrownCapability(input)
        : Promise.reject(new Error('crown-capability-submit-blocked'))
    },
    assertFieldSets() {},
  }
  await assert.rejects(() => provider.preview({
    accountId: 'bet-owner', batchId: 'ordinary-home',
    lockedSelection: lockedSelection({
      selection: {
        side: 'home', oddsField: 'IOR_RH', oddsRaw: '0.96',
        selectionIdentity: 'crown|football|gid=event-safe|full_time|asian_handicap|RATIO_R|home',
      },
    }),
  }), /submit-blocked/)
  assert.equal(effects.authority, 0)
  assert.equal(effects.repository, 0)
  assert.equal(effects.browser, 0)
})

test('canonical capability version remains an opaque matrix digest', () => {
  assert.match(CROWN_CAPABILITY_MATRIX_VERSION, /^crown-protocol-capabilities-v2:[a-f0-9]{16}$/)
})

test('production construction rejects capability injection and offline fixtures remain origin confined', async () => {
  const current = account({ loginUrl: 'https://not-offline.example.com' })
  const harness = runtimeHarness({ currentAccount: current, currentSession: sessionFor(current) })
  assert.throws(() => new CrownAccountPreviewProvider({
    browserRuntime: harness.browserRuntime,
    executorLease: executorLease(),
    capabilityResolver: trustedResolver(),
  }), /crown-capability-resolver-injection-forbidden/)
  assert.throws(() => createOfflineCrownAccountPreviewFixture({}), /offline-capability-resolver-required/)

  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { return current } },
    browserRuntime: harness.browserRuntime,
    executorLease: executorLease(),
    capabilityResolver: trustedResolver(),
  })
  await assert.rejects(() => provider.preview({
    accountId: current.id, batchId: 'offline-origin', lockedSelection: lockedSelection(),
  }), /offline-preview-fixture-origin-required/)
  assert.equal(harness.calls.length, 0)
})

test('canonical matrix resolves the five-dimensional key before account or Browser I/O', async () => {
  const effects = { repository: 0, runtime: 0, lease: 0 }
  const provider = new CrownAccountPreviewProvider({
    repository: {
      getBettingAccountForExecution() { effects.repository += 1; throw new Error('repository-stop') },
    },
    browserRuntime: {
      async ensureBettingSession() { effects.runtime += 1 },
      async fetchFreshExecutionBalance() { effects.runtime += 1 },
      async postPreviewForm() { effects.runtime += 1 },
    },
    executorLease: executorLease(() => { effects.lease += 1; return 1 }),
  })
  await assert.rejects(() => provider.preview({
    accountId: 'bet-owner', batchId: 'batch', lockedSelection: lockedSelection(),
  }), /repository-stop/)
  assert.deepEqual(effects, { repository: 1, runtime: 0, lease: 1 })
})

test('Preview uses Browser session, balance and FT_order_view without Node transport or persistence', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('node-fetch-must-not-run') }
  t.after(() => { globalThis.fetch = originalFetch })
  const current = account()
  const harness = runtimeHarness({ currentAccount: current })
  const legacy = {
    async ensureBettingSession() { throw new Error('legacy-login-must-not-run') },
    client: { async postForm() { throw new Error('legacy-post-form-must-not-run') } },
    bettingStoreFor() { throw new Error('legacy-store-must-not-run') },
  }
  const provider = new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { return current } },
    browserRuntime: harness.browserRuntime,
    loginManager: legacy,
    executorLease: executorLease(),
  })
  const result = await provider.preview({
    accountId: current.id, batchId: 'batch-browser', lockedSelection: lockedSelection(),
  })

  assert.deepEqual(harness.calls.map(({ operation }) => operation), ['session', 'balance', 'preview'])
  assert.deepEqual(harness.calls[2].input.wireFields, {
    p: 'FT_order_view', langx: 'zh-cn', odd_f_type: 'H', ver: 'browser-version',
    gid: 'event-safe', gtype: 'FT', wtype: 'R', chose_team: 'C',
  })
  assert.equal(result.transportKind, 'browser-page-fetch')
  assert.equal(result.executionPreview.minStakeMinor, 60)
  assert.equal(result.executionPreview.maxStakeMinor, 1000)
  assert.equal(result.executionPreview.stakeStepMinor, null)
  assert.equal(result.capacityMinor, 60)
  assert.equal(result.freshBalanceCny, 300)
  assert.equal(result.realExecutionEligible, true)
  assert.equal(result.browserSession, harness.session)
  assert.equal(Object.keys(result).includes('browserSession'), false)
  assert.doesNotMatch(JSON.stringify(result), /private-browser-uid|private-password|browser-generation-1/)
})

test('fresh limits are provider data, not the old 50/20000 constants', async () => {
  const current = account({ perBetLimitMinor: 777 })
  const harness = runtimeHarness({
    currentAccount: current,
    currentSession: sessionFor(current),
    xml: previewXml({ minimum: '73', maximum: '777' }),
    balance: '500',
  })
  const { provider } = productionProvider({ currentAccount: current, harness })
  const result = await provider.preview({
    accountId: current.id, batchId: 'dynamic-limits', lockedSelection: lockedSelection(),
  })
  assert.deepEqual({
    minimum: result.executionPreview.minStakeMinor,
    maximum: result.executionPreview.maxStakeMinor,
    capacity: result.capacityMinor,
  }, { minimum: 73, maximum: 777, capacity: 73 })
})

test('session ownership, protocol proof and cookie-free memory state are checked before balance or Preview', async (t) => {
  const current = account()
  const cases = [
    ['account', { accountId: 'other' }],
    ['username', { username: 'other' }],
    ['origin', { origin: 'https://other.example.com', baseUrl: 'https://other.example.com' }],
    ['base-url', { baseUrl: 'https://crown.example.com/untrusted-path' }],
    ['generation', { contextGeneration: '' }],
    ['protocol', { protocolVersion: '' }],
    ['proof', { protocolVersionEvidence: { source: 'caller-session-metadata', captured: true, verified: true } }],
    ['cookies', { cookies: { SESSION: 'forbidden' } }],
  ]
  for (const [name, mutation] of cases) {
    await t.test(name, async () => {
      const harness = runtimeHarness({
        currentAccount: current,
        currentSession: sessionFor(current, mutation),
      })
      const { provider } = productionProvider({ currentAccount: current, harness })
      await assert.rejects(() => provider.preview({
        accountId: current.id, batchId: `session-${name}`, lockedSelection: lockedSelection(),
      }), /betting-session-owner-mismatch/)
      assert.deepEqual(harness.calls.map(({ operation }) => operation), ['session'])
    })
  }
})

test('line and response field-set drift fail closed after Browser Preview', async (t) => {
  for (const [name, xml, expected] of [
    ['line', previewXml({ line: '1' }), /crown-preview-line-changed/],
    ['field-set', previewXml({ extra: { unexpected_field: 'drift' } }), /crown-preview-response-field-set-mismatch/],
  ]) {
    await t.test(name, async () => {
      const harness = runtimeHarness({ xml })
      const { provider } = productionProvider({ harness })
      await assert.rejects(() => provider.preview({
        accountId: 'bet-owner', batchId: `drift-${name}`, lockedSelection: lockedSelection(),
      }), expected)
      assert.equal(harness.calls.at(-1).operation, 'preview')
    })
  }
})

test('Browser Preview failures are sanitized and do not expose account or response secrets', async () => {
  const secret = new Error('private-browser-uid private-password secret-response')
  const harness = runtimeHarness({ previewError: secret })
  const logs = []
  const provider = new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { return account() } },
    browserRuntime: harness.browserRuntime,
    executorLease: executorLease(),
    logger: (row) => logs.push(row),
  })
  let caught
  try {
    await provider.preview({
      accountId: 'bet-owner', batchId: 'sanitized', lockedSelection: lockedSelection(),
    })
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'crown-preview-request-failed')
  assert.equal(caught?.message, 'crown-preview-request-failed')
  assert.doesNotMatch(JSON.stringify({ caught: { message: caught?.message, code: caught?.code }, logs }),
    /private-browser-uid|private-password|secret-response/)
})

test('caller wire injection and invalid locked identities fail before account or Browser access', async () => {
  const effects = { repository: 0, runtime: 0, lease: 0 }
  const provider = new CrownAccountPreviewProvider({
    repository: { getBettingAccountForExecution() { effects.repository += 1 } },
    browserRuntime: {
      async ensureBettingSession() { effects.runtime += 1 },
      async fetchFreshExecutionBalance() { effects.runtime += 1 },
      async postPreviewForm() { effects.runtime += 1 },
    },
    executorLease: executorLease(() => { effects.lease += 1; return 1 }),
  })
  const cases = [
    [{ accountId: 'bet-owner', batchId: 'batch', lockedSelection: lockedSelection(), capability: capability() }, /preview-capability-caller-forbidden/],
    [{ accountId: 'mon_primary', batchId: 'batch', lockedSelection: lockedSelection() }, /betting-account-monitor-forbidden/],
    [{ accountId: 'bet-owner', batchId: 'batch', lockedSelection: lockedSelection({ provider: 'other' }) }, /crown-preview-provider-mismatch/],
    [{ accountId: 'bet-owner', batchId: 'batch', lockedSelection: lockedSelection({ event: { ids: { gid: '' } } }) }, /missing-crown-gid/],
    [{ accountId: 'bet-owner', batchId: 'batch', lockedSelection: lockedSelection({ market: { handicapRaw: '1e-3' } }) }, /crown-preview-locked-line-invalid/],
  ]
  for (const [input, expected] of cases) await assert.rejects(() => provider.preview(input), expected)
  assert.deepEqual(effects, { repository: 0, runtime: 0, lease: 0 })
})

test('identity and side-aware mapper drift fail before account or Browser access', async (t) => {
  const cases = [
    ['mode', lockedSelection({ mode: 'live' })],
    ['period', lockedSelection({ market: { period: 'first_half' } })],
    ['market', lockedSelection({ market: { marketType: 'total' } })],
    ['variant', lockedSelection({ market: { lineVariant: 'alternate' } })],
    ['ratio', lockedSelection({ market: { ratioField: 'RATIO_UNKNOWN' } })],
    ['side', lockedSelection({ selection: { side: 'home' } })],
    ['odds-field', lockedSelection({ selection: { oddsField: 'IOR_UNKNOWN' } })],
  ]
  for (const [name, selection] of cases) {
    await t.test(name, async () => {
      let repositoryCalls = 0
      const provider = new CrownAccountPreviewProvider({
        repository: { getBettingAccountForExecution() { repositoryCalls += 1 } },
        browserRuntime: {
          async ensureBettingSession() {}, async fetchFreshExecutionBalance() {}, async postPreviewForm() {},
        },
        executorLease: executorLease(),
      })
      await assert.rejects(() => provider.preview({
        accountId: 'bet-owner', batchId: `identity-${name}`, lockedSelection: selection,
      }))
      assert.equal(repositoryCalls, 0)
    })
  }
})

test('lease loss after Browser Preview rejects the result before adoption', async () => {
  let checks = 0
  const harness = runtimeHarness()
  const { provider } = productionProvider({
    harness,
    lease: executorLease(() => {
      checks += 1
      if (checks === 3) throw new Error('lease-stale-after-preview')
      return 1
    }),
  })
  await assert.rejects(() => provider.preview({
    accountId: 'bet-owner', batchId: 'lease-loss', lockedSelection: lockedSelection(),
  }), /lease-stale-after-preview/)
  assert.equal(harness.calls.at(-1).operation, 'preview')
})

test('provider sources contain no legacy direct HTTP, session store, or fixed stake limits', () => {
  const sources = [
    'src/crown/betting/crown-account-provider.mjs',
    'src/crown/betting/crown-account-execution-provider.mjs',
  ].map((file) => fs.readFileSync(path.resolve(file), 'utf8')).join('\n')
  assert.doesNotMatch(sources, /loginManager|client\.postForm|bettingStoreFor|api-session\.json/)
  assert.doesNotMatch(sources, /amountMinor\s*!==\s*50|minStakeMinor\s*===\s*50|maxStakeMinor\s*===\s*20000/)
})
