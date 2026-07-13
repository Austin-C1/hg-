import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import {
  CrownAccountPreviewProvider,
  createOfflineCrownAccountPreviewFixture,
} from '../src/crown/betting/crown-account-provider.mjs'
import { CrownAccountExecutionProvider } from '../src/crown/betting/crown-account-execution-provider.mjs'
import { CROWN_CAPABILITY_MATRIX_VERSION } from '../src/crown/betting/crown-capability-matrix.mjs'
import { CrownApiLoginManager } from '../src/crown/login/crown-api-login-manager.mjs'

function tempRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-account-provider-'))
}

function response(body, { status = 200, cookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'set-cookie' ? cookies.join(', ') : null
      },
      getSetCookie() { return cookies },
    },
    async arrayBuffer() { return Buffer.from(body, 'utf8') },
  }
}

function fakeFetch(responses, calls) {
  return async (url, options = {}) => {
    const body = Object.fromEntries(new URLSearchParams(String(options.body || '')))
    calls.push({ url: String(url), body, headers: options.headers || {} })
    const next = responses.shift()
    if (!next) throw new Error('unexpected-network')
    return next
  }
}

function verifiedCapability(overrides = {}) {
  return {
    key: 'live|full_time|asian_handicap|main',
    evidenceStatus: 'verified',
    previewAllowed: true,
    submitAllowed: false,
    evidenceId: 'fixture:verified-live-full-time-asian-handicap-main:v1',
    mode: 'live',
    period: 'full_time',
    marketType: 'asian_handicap',
    lineVariant: 'main',
    mapperEvidence: {
      ratioFields: ['RATIO_RE'],
      oddsFields: ['IOR_REC', 'IOR_REH'],
      oddsFieldsBySide: { home: 'IOR_REH', away: 'IOR_REC' },
      wtype: 'RE',
      wireDefaults: { langx: 'zh-cn', odd_f_type: 'H', p: 'FT_order_view', ver: 'fixture-version' },
    },
    requestFieldSet: ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'],
    responseFieldSet: ['code', 'con', 'dates', 'game_sc', 'game_so', 'gold_gmax', 'gold_gmin', 'ioratio', 'league_id', 'maxcredit', 'mem_sc', 'mem_so', 'num_c', 'num_h', 'ratio', 'restsinglecredit', 'spread', 'strong', 'times'],
    ...overrides,
  }
}

function sorted(values) {
  return [...new Set(values.map(String))].sort()
}

function trustedResolver(capability = verifiedCapability()) {
  return {
    resolvePreview(input) {
      const key = [input.mode, input.period, input.marketType, input.lineVariant].join('|')
      if (key !== capability.key) throw new Error('trusted-capability-blocked')
      return structuredClone(capability)
    },
    assertFieldSets(value, observed) {
      assert.equal(value.evidenceId, capability.evidenceId)
      if (observed.requestFieldSet) assert.deepEqual(sorted(observed.requestFieldSet), sorted(capability.requestFieldSet))
      if (observed.responseFieldSet) assert.deepEqual(sorted(observed.responseFieldSet), sorted(capability.responseFieldSet))
      return structuredClone(capability)
    },
  }
}

function lockedSelection(overrides = {}) {
  const base = {
    provider: 'crown',
    mode: 'live',
    event: { eventKey: 'crown|football|gid=8878933', ids: { gid: '8878933' } },
    market: {
      marketType: 'asian_handicap',
      period: 'full_time',
      lineVariant: 'main',
      lineKey: 'ah:ft:-0.25',
      ratioField: 'RATIO_RE',
      handicapRaw: '-0 / 0.5',
    },
    selection: {
      selectionIdentity: 'crown|football|gid=8878933|full_time|asian_handicap|ah:ft:-0.25|home',
      side: 'home', oddsField: 'IOR_REH', oddsRaw: '1.09',
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

function loginXml(uid = 'owner-uid') {
  return `<serverresponse><status>200</status><uid>${uid}</uid><ver>fixture-version</ver></serverresponse>`
}

function previewXml({ odds = '0.83', spread = '-0 / 0.5' } = {}) {
  return `<serverresponse><code>501</code><con>x</con><dates>x</dates><game_sc>x</game_sc><game_so>x</game_so><gold_gmin>10.00</gold_gmin><gold_gmax>500.00</gold_gmax><ioratio>${odds}</ioratio><league_id>x</league_id><maxcredit>999.00</maxcredit><mem_sc>x</mem_sc><mem_so>x</mem_so><num_c>x</num_c><num_h>x</num_h><ratio>x</ratio><restsinglecredit>x</restsinglecredit><spread>${spread}</spread><strong>H</strong><times>x</times></serverresponse>`
}

function setup({
  preview = previewXml(),
  previewCookies = ['SESSION=preview-rotated; Path=/'],
  previewStatus = 200,
  bettingAllowedOrigins = 'https://offline-preview.example.com',
} = {}) {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const repository = createAppRepository(handle.db, { secretKey: 'provider-test-secret-key-with-more-than-32-characters' })
  const account = repository.createBettingAccount({
    username: 'bet-owner',
    password: 'bet-password',
    websiteUrl: 'https://offline-preview.example.com',
    status: 'enabled',
    betOrder: 1,
    perBetLimit: '100',
    currency: 'CNY',
  })
  const calls = []
  const loginManager = new CrownApiLoginManager({
    runtimeDir: tempRuntimeDir(),
    bettingAllowedOrigins,
    fetchImpl: fakeFetch([
      response(loginXml(), { cookies: ['SESSION=fresh; Path=/'] }),
      response('<serverresponse></serverresponse>', { cookies: ['SESSION=verified; Path=/'] }),
      response(preview, { status: previewStatus, cookies: previewCookies }),
    ], calls),
  })
  const lease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:provider-test',
    ownerId: 'provider-test-owner',
    pid: 1,
    ttlMs: 60_000,
  })
  lease.acquire()
  const fenceChecks = []
  const executorLease = {
    leaseKey: lease.leaseKey,
    get fencingToken() { return lease.fencingToken },
    assertFence() {
      fenceChecks.push('assert')
      return lease.assertFence()
    },
  }
  return { handle, repository, account, calls, loginManager, executorLease, fenceChecks }
}

test('default canonical matrix blocks preview with unproven wire value source before account I/O', async () => {
  const effects = { repository: 0, login: 0, lease: 0, network: 0 }
  const provider = new CrownAccountPreviewProvider({
    repository: {
      getBettingAccountForExecution() { effects.repository += 1; throw new Error('repository-must-not-run') },
    },
    loginManager: {
      async ensureBettingSession() { effects.login += 1; throw new Error('login-must-not-run') },
    },
    executorLease: {
      leaseKey: 'betting-executor:test',
      fencingToken: 1,
      assertFence() { effects.lease += 1; return 1 },
    },
    fetchImpl: async () => { effects.network += 1; throw new Error('network-must-not-run') },
  })

  await assert.rejects(() => provider.preview({
    accountId: 'bet_account', batchId: 'batch-1', lockedSelection: lockedSelection(),
  }), /crown-preview-field-source-unproven/)
  assert.deepEqual(effects, { repository: 0, login: 0, lease: 0, network: 0 })
  assert.equal(provider.submit, undefined)
  assert.equal(provider.poll, undefined)
})

test('preview rejects an unproved session protocolVersion before FT_order_view', async () => {
  const context = setup()
  context.loginManager.ensureBettingSession = async () => ({ session: {
    accountId: context.account.id,
    username: context.account.username,
    baseUrl: context.account.loginUrl || context.account.websiteUrl,
    uid: 'owner-uid', cookies: {}, protocolVersion: 'forged-version',
  } })
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
  })
  await assert.rejects(() => provider.preview({
    accountId: context.account.id, batchId: 'batch-unproved-ver', lockedSelection: lockedSelection(),
  }), /crown-preview-field-source-unproven:ver/)
  assert.equal(context.calls.length, 0)
  context.handle.close()
})

test('production submit provider has no injectable transport and canonical submit remains zero-network blocked', async () => {
  assert.throws(() => new CrownAccountExecutionProvider({ fetchImpl: async () => {} }), /provider-injection-forbidden/)
  const provider = new CrownAccountExecutionProvider()
  await assert.rejects(() => provider.submit({
    capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    lockedIdentity: {
      provider: 'crown', mode: 'live', period: 'full_time',
      marketType: 'asian_handicap', lineVariant: 'main',
    },
  }), /crown-capability-submit-blocked/)
})

test('provider factory existence never grants submit without exact canonical evidence', async () => {
  const provider = new CrownAccountExecutionProvider()
  await assert.rejects(() => provider.submit({
    capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    currentIdentity: {
      mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
    },
  }), /crown-capability-submit-blocked/)
})

test('production construction rejects resolver injection and exposes only an origin-confined offline fixture', () => {
  assert.throws(() => new CrownAccountPreviewProvider({
    capabilityResolver: trustedResolver(),
  }), /crown-capability-resolver-injection-forbidden/)

  assert.throws(() => createOfflineCrownAccountPreviewFixture({}), /offline-capability-resolver-required/)

  const references = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.endsWith('.mjs')
        && fs.readFileSync(target, 'utf8').includes('createTestCrownAccountPreviewProvider')) references.push(target)
    }
  }
  visit(path.resolve('src'))
  visit(path.resolve('scripts'))
  assert.deepEqual(references, [])
})

test('offline preview fixture rejects non-reserved origins before login or network access', async () => {
  let loginCalls = 0
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: {
      getBettingAccountForExecution(id) {
        return { id, username: 'owner', loginUrl: 'https://crown.invalid-real-origin.com' }
      },
    },
    loginManager: {
      async ensureBettingSession() { loginCalls += 1; throw new Error('login-must-not-run') },
    },
    executorLease: {
      leaseKey: 'betting-executor:offline-origin-test',
      fencingToken: 1,
      assertFence() { return 1 },
    },
    capabilityResolver: trustedResolver(),
  })
  await assert.rejects(() => provider.preview({
    accountId: 'bet-owner', batchId: 'batch-offline-origin', lockedSelection: lockedSelection(),
  }), /offline-preview-fixture-origin-required/)
  assert.equal(loginCalls, 0)
})

test('provider cannot bypass the betting HTTPS origin allowlist before login or preview network', async () => {
  const context = setup({ bettingAllowedOrigins: '' })
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
  })

  await assert.rejects(() => provider.preview({
    accountId: context.account.id,
    batchId: 'batch-origin-blocked',
    lockedSelection: lockedSelection(),
  }), /betting-origin-not-allowed/)
  assert.equal(context.calls.length, 0)
  assert.equal(fs.existsSync(path.join(context.loginManager.runtimeDir, 'crown-sessions')), false)
  context.handle.close()
})

test('verified preview uses the exact betting account and only FT_order_view while keeping real execution blocked', async () => {
  const context = setup()
  const logs = []
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
    logger: (entry) => logs.push(entry),
  })

  const result = await provider.preview({
    accountId: context.account.id,
    batchId: 'batch-preview-1',
    lockedSelection: lockedSelection(),
  })
  assert.deepEqual(context.calls.map((call) => call.body.p), ['chk_login', 'get_game_list', 'FT_order_view'])
  assert.equal(context.calls.some((call) => ['FT_bet', 'get_dangerous'].includes(call.body.p)), false)
  assert.deepEqual(context.calls[2].body, {
    uid: 'owner-uid',
    langx: 'zh-cn',
    p: 'FT_order_view',
    odd_f_type: 'H',
    ver: 'fixture-version',
    gid: '8878933',
    gtype: 'FT',
    wtype: 'RE',
    chose_team: 'H',
  })
  assert.equal(context.fenceChecks.length, 7)
  assert.equal(result.status, 'previewed')
  assert.equal(result.preview.odds.exact, '0.83')
  assert.equal(result.preview.line.exact, '0 / 0.5')
  assert.equal(result.preview.maxCreditRaw, '999.00')
  assert.equal(result.capacityMinor, null)
  assert.equal(result.currency.verified, false)
  assert.equal(result.stakeStep.verified, false)
  assert.equal(result.realExecutionEligible, false)
  assert.deepEqual(result.realExecutionBlockers, [
    'preview-capacity-unverified',
    'preview-currency-unverified',
    'preview-stake-step-unverified',
  ])
  assert.deepEqual(result.lockedIdentity, {
    provider: 'crown', gid: '8878933', mode: 'live', period: 'full_time',
    market: 'asian_handicap', line: 'ah:ft:-0.25', side: 'home',
  })
  const saved = JSON.parse(fs.readFileSync(path.join(
    context.loginManager.runtimeDir, 'crown-sessions', context.account.id, 'api-session.json',
  ), 'utf8'))
  assert.equal(saved.accountId, context.account.id)
  assert.equal(saved.cookies.SESSION, 'preview-rotated')
  assert.doesNotMatch(JSON.stringify({ result, logs }), /bet-password|owner-uid|preview-rotated|SESSION/)
  context.handle.close()
})

test('preview reads gid and market fields from the locked envelope snapshot before any network boundary', async () => {
  let networkCalls = 0
  let capabilityInput = null
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { throw new Error('stop-after-preview-fields') } },
    loginManager: {
      async ensureBettingSession() { networkCalls += 1; throw new Error('network-must-not-run') },
      client: { async postForm() { networkCalls += 1; throw new Error('network-must-not-run') } },
    },
    executorLease: { leaseKey: 'betting-executor:envelope-boundary', fencingToken: 1, assertFence: () => 1 },
    capabilityResolver: {
      resolvePreview(input) { capabilityInput = structuredClone(input); return verifiedCapability() },
      assertFieldSets() { return verifiedCapability() },
    },
  })
  await assert.rejects(() => provider.preview({
    accountId: 'bet-envelope', batchId: 'batch-envelope', lockedSelection: lockedSelection(),
  }), /stop-after-preview-fields/)
  assert.deepEqual(capabilityInput, {
    mode: 'live', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
  })
  assert.equal(networkCalls, 0)
})

test('preview allows odds movement but fails closed when the provider line differs from the locked line', async () => {
  const context = setup({ preview: previewXml({ odds: '0.71', spread: '0.5 / 1' }) })
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
  })

  await assert.rejects(() => provider.preview({
    accountId: context.account.id,
    batchId: 'batch-line-change',
    lockedSelection: lockedSelection(),
  }), /crown-preview-line-changed/)
  assert.deepEqual(context.calls.map((call) => call.body.p), ['chk_login', 'get_game_list', 'FT_order_view'])
  assert.equal(context.calls.some((call) => ['FT_bet', 'get_dangerous'].includes(call.body.p)), false)
  context.handle.close()
})

test('caller capability injection, monitor account, and locked identity drift fail before account or network access', async () => {
  const effects = { resolver: 0, repository: 0, login: 0 }
  const resolver = trustedResolver()
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { effects.repository += 1 } },
    loginManager: { async ensureBettingSession() { effects.login += 1 } },
    executorLease: { leaseKey: 'betting-executor:test', fencingToken: 1, assertFence() { return 1 } },
    capabilityResolver: {
      resolvePreview(input) { effects.resolver += 1; return resolver.resolvePreview(input) },
      assertFieldSets: resolver.assertFieldSets,
    },
  })
  await assert.rejects(() => provider.preview({
    accountId: 'bet-a', batchId: 'batch-a', lockedSelection: lockedSelection(), capability: verifiedCapability(),
  }), /preview-capability-caller-forbidden/)
  await assert.rejects(() => provider.preview({
    accountId: '', batchId: 'batch-a', lockedSelection: lockedSelection(),
  }), /betting-account-id-required/)
  await assert.rejects(() => provider.preview({
    accountId: 'bet-a', batchId: '', lockedSelection: lockedSelection(),
  }), /bet-batch-id-required/)
  await assert.rejects(() => provider.preview({
    accountId: 'mon_primary', batchId: 'batch-a', lockedSelection: lockedSelection(),
  }), /betting-account-monitor-forbidden/)
  await assert.rejects(() => provider.preview({
    accountId: 'bet-a', batchId: 'batch-a', lockedSelection: lockedSelection({ provider: 'other' }),
  }), /crown-preview-provider-mismatch/)
  await assert.rejects(() => provider.preview({
    accountId: 'bet-a', batchId: 'batch-a', lockedSelection: lockedSelection({ event: { ids: { gid: '' } } }),
  }), /missing-crown-gid/)
  assert.deepEqual(effects, { resolver: 0, repository: 0, login: 0 })
})

test('every locked identity component fails closed against trusted capability and mapper evidence drift before I/O', async () => {
  const effects = { repository: 0, login: 0, lease: 0 }
  const capability = verifiedCapability()
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { effects.repository += 1 } },
    loginManager: { async ensureBettingSession() { effects.login += 1 } },
    executorLease: {
      leaseKey: 'betting-executor:test', fencingToken: 1,
      assertFence() { effects.lease += 1; return 1 },
    },
    capabilityResolver: {
      resolvePreview() { return structuredClone(capability) },
      assertFieldSets: trustedResolver(capability).assertFieldSets,
    },
  })
  const cases = [
    ['mode', lockedSelection({ mode: 'prematch' }), /unsupported-crown-preview-mode/],
    ['period', lockedSelection({ market: { period: 'first_half' } }), /crown-preview-capability-mismatch:period/],
    ['marketType', lockedSelection({ market: { marketType: 'total' } }), /crown-preview-capability-mismatch:marketType/],
    ['lineVariant', lockedSelection({ market: { lineVariant: 'alternate' } }), /unsupported-crown-preview-line-variant/],
    ['ratioField', lockedSelection({ market: { ratioField: 'RATIO_UNKNOWN' } }), /crown-preview-capability-mismatch:ratioField/],
    ['side', lockedSelection({ selection: { side: 'away', oddsField: 'IOR_REH' } }), /crown-preview-capability-mismatch:oddsField/],
    ['oddsField', lockedSelection({ selection: { oddsField: 'IOR_UNKNOWN' } }), /crown-preview-capability-mismatch:oddsField/],
  ]
  for (const [name, selection, expected] of cases) {
    await assert.rejects(() => provider.preview({
      accountId: 'bet-a', batchId: `batch-${name}`, lockedSelection: selection,
    }), expected, name)
  }
  assert.deepEqual(effects, { repository: 0, login: 0, lease: 0 })
})

test('response field-set drift is rejected before result adoption or rotated session persistence', async () => {
  const drifted = previewXml().replace('</serverresponse>', '<currency>CNY</currency></serverresponse>')
  const context = setup({ preview: drifted, previewCookies: ['SESSION=field-drift-must-not-save; Path=/'] })
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
  })

  await assert.rejects(() => provider.preview({
    accountId: context.account.id,
    batchId: 'batch-response-field-drift',
    lockedSelection: lockedSelection(),
  }))
  assert.equal(context.calls.at(-1).body.p, 'FT_order_view')
  const saved = JSON.parse(fs.readFileSync(path.join(
    context.loginManager.runtimeDir, 'crown-sessions', context.account.id, 'api-session.json',
  ), 'utf8'))
  assert.equal(saved.cookies.SESSION, 'verified')
  context.handle.close()
})

test('provider sanitizes HTTP failures and never exposes response, uid, cookie, or account secret', async () => {
  const secretBody = '<serverresponse><uid>fake-secret-uid</uid><cookie>fake-secret-cookie</cookie><password>fake-secret-password</password></serverresponse>'
  const context = setup({
    preview: secretBody,
    previewStatus: 500,
    previewCookies: ['SESSION=fake-secret-rotated; Path=/'],
  })
  const logs = []
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease: context.executorLease,
    capabilityResolver: trustedResolver(),
    logger: (entry) => logs.push(entry),
  })

  let caught
  try {
    await provider.preview({
      accountId: context.account.id,
      batchId: 'batch-sanitized-http-error',
      lockedSelection: lockedSelection(),
    })
  } catch (error) {
    caught = error
  }
  assert.equal(caught?.code, 'crown-preview-request-failed')
  assert.equal(caught?.message, 'crown-preview-request-failed')
  const serialized = JSON.stringify({
    name: caught?.name,
    message: caught?.message,
    code: caught?.code,
    details: caught?.details,
    logs,
  })
  assert.doesNotMatch(serialized, /fake-secret|bet-password|owner-uid|SESSION/)
  const saved = JSON.parse(fs.readFileSync(path.join(
    context.loginManager.runtimeDir, 'crown-sessions', context.account.id, 'api-session.json',
  ), 'utf8'))
  assert.equal(saved.cookies.SESSION, 'verified')
  context.handle.close()
})

test('invalid or unsafe locked handicap decimals fail before lease, account, session, or network access', async () => {
  const effects = { repository: 0, login: 0, lease: 0 }
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: { getBettingAccountForExecution() { effects.repository += 1 } },
    loginManager: { async ensureBettingSession() { effects.login += 1 } },
    executorLease: {
      leaseKey: 'betting-executor:test', fencingToken: 1,
      assertFence() { effects.lease += 1; return 1 },
    },
    capabilityResolver: trustedResolver(),
  })
  for (const handicapRaw of ['0.0000001', '9007199254740992', '1e-3', '0 / NaN']) {
    await assert.rejects(() => provider.preview({
      accountId: 'bet-a',
      batchId: `batch-invalid-line-${handicapRaw}`,
      lockedSelection: lockedSelection({ market: { handicapRaw } }),
    }), /crown-preview-locked-line-invalid/)
  }
  assert.deepEqual(effects, { repository: 0, login: 0, lease: 0 })
})

test('lease loss immediately after FT_order_view rejects the result and does not persist rotated cookies', async () => {
  const context = setup({ previewCookies: ['SESSION=must-not-save; Path=/'] })
  let assertions = 0
  const executorLease = {
    leaseKey: context.executorLease.leaseKey,
    fencingToken: context.executorLease.fencingToken,
    assertFence() {
      assertions += 1
      if (assertions === 7) throw new Error('lease-stale-after-preview')
      return context.executorLease.assertFence()
    },
  }
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease,
    capabilityResolver: trustedResolver(),
  })

  await assert.rejects(() => provider.preview({
    accountId: context.account.id,
    batchId: 'batch-stale-after',
    lockedSelection: lockedSelection(),
  }), /lease-stale-after-preview/)
  assert.equal(assertions, 7)
  assert.equal(context.calls.at(-1).body.p, 'FT_order_view')
  const saved = JSON.parse(fs.readFileSync(path.join(
    context.loginManager.runtimeDir, 'crown-sessions', context.account.id, 'api-session.json',
  ), 'utf8'))
  assert.equal(saved.cookies.SESSION, 'verified')
  context.handle.close()
})

test('lease takeover during login response stops verification and preview without persisting a session', async () => {
  const context = setup()
  let leaseLost = false
  const fetchImpl = context.loginManager.client.fetchImpl
  context.loginManager.client.fetchImpl = async (url, options) => {
    const result = await fetchImpl(url, options)
    const form = new URLSearchParams(String(options?.body || ''))
    if (form.get('p') === 'chk_login') leaseLost = true
    return result
  }
  const executorLease = {
    leaseKey: context.executorLease.leaseKey,
    fencingToken: context.executorLease.fencingToken,
    assertFence() {
      if (leaseLost) throw new Error('lease-stale-during-login')
      return context.executorLease.assertFence()
    },
  }
  const provider = createOfflineCrownAccountPreviewFixture({
    repository: context.repository,
    loginManager: context.loginManager,
    executorLease,
    capabilityResolver: trustedResolver(),
  })

  await assert.rejects(() => provider.preview({
    accountId: context.account.id,
    batchId: 'batch-stale-during-login',
    lockedSelection: lockedSelection(),
  }), /lease-stale-during-login/)
  assert.deepEqual(context.calls.map((call) => call.body.p), ['chk_login'])
  assert.equal(fs.existsSync(path.join(
    context.loginManager.runtimeDir, 'crown-sessions', context.account.id, 'api-session.json',
  )), false)
  context.handle.close()
})
