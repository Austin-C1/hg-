import assert from 'node:assert/strict'
import test from 'node:test'

import { AutoBettingConsumer } from '../src/crown/betting/auto-betting-consumer.mjs'

function signal({ marketType = 'asian_handicap', sourceSide = 'home', mode = 'prematch' } = {}) {
  const period = 'full_time'
  const lineKey = marketType === 'total' ? 'RATIO_OU' : 'RATIO_RE'
  const marketIdentity = `crown|football|gid=1|${period}|${marketType}|${lineKey}`
  return {
    signalId: 'a'.repeat(64), observedAt: '2026-07-12T00:00:00.000Z',
    target: { eventIdentity: 'crown|football|gid=1', marketIdentity, selectionIdentity: `${marketIdentity}|${sourceSide}`, side: sourceSide },
    trigger: { type: 'odds-change', direction: 'up', delta: 0.05, threshold: 0.03, observedAt: '2026-07-12T00:00:00.000Z' },
    evidence: { mode, period, marketType, handicap: marketType === 'total' ? 2.5 : -0.5, handicapRaw: marketType === 'total' ? '2.5' : '-0.5' },
  }
}

const opposite = { home: 'away', away: 'home', over: 'under', under: 'over' }
function selection(input, overrides = {}) {
  const side = opposite[input.target.side]
  return {
    provider: 'crown', mode: input.evidence.mode, capturedAt: '2026-07-12T00:00:01.000Z', event: { eventKey: input.target.eventIdentity, mode: input.evidence.mode },
    market: { marketIdentity: input.target.marketIdentity, period: input.evidence.period, marketType: input.evidence.marketType, lineKey: input.target.marketIdentity.split('|').at(-1), handicap: input.evidence.handicap },
    selection: { selectionIdentity: `${input.target.marketIdentity}|${side}`, side, odds: '0.9', suspended: false },
    ...overrides,
  }
}

function item(input = signal(), settings = {}) {
  const snapshot = { mode: input.evidence.mode, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 20, currency: 'CNY', amountScale: 0, realEligible: true, realEligibilityVersion: 2, migrationReviewRequired: false, version: 7, ...settings }
  return { signalId: input.signalId, bettingMode: snapshot.mode, settingsVersion: snapshot.version, settingsSnapshot: snapshot, signal: input }
}

function cardItem(input = signal()) {
  const legacy = item(input)
  const { mode, ...cardSnapshot } = legacy.settingsSnapshot
  return {
    ...legacy,
    cardId: 'card-a',
    cardVersion: 7,
    cardSnapshot: { ...cardSnapshot, cardId: 'card-a', name: 'card', leagueNames: ['英超'] },
  }
}

function harness({ input = signal(), settings = {}, global = true, atomicResult = { status: 'batch_created', batchId: 'batch-1' }, atomicError = null, latest = null, ready = true } = {}) {
  const calls = []
  const atomicAdapter = async (payload) => {
    calls.push(['atomic', payload])
    if (atomicError) throw atomicError
    return atomicResult
  }
  atomicAdapter.ready = ready
  const consumer = new AutoBettingConsumer({
    findLatestSelection(query) { calls.push(['latest', query]); return latest || selection(input) },
    isGlobalRealBettingRequested() { calls.push(['global']); return global },
    claimAndCreateModeScopedBatch: atomicAdapter,
  })
  return { consumer, calls, inboxItem: item(input, settings) }
}

test('consumer exposes explicit atomic adapter readiness', () => {
  assert.equal(harness({ ready: false }).consumer.canProcess(), false)
  assert.equal(harness({ ready: true }).consumer.canProcess(), true)
})

test('downward water move is alert-only and skips before selection lookup or atomic market claim', async () => {
  const input = signal()
  input.trigger.direction = 'down'
  const { consumer, calls, inboxItem } = harness({ input })
  assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated' }), {
    status: 'skipped', reason: 'water-down-alert-only',
  })
  assert.deepEqual(calls, [])
})

for (const direction of [undefined, 'flat', 'unknown']) {
  test(`non-up direction ${String(direction)} fails closed before selection lookup or atomic market claim`, async () => {
    const input = signal()
    if (direction === undefined) delete input.trigger.direction
    else input.trigger.direction = direction
    const { consumer, calls, inboxItem } = harness({ input })
    assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated' }), {
      status: 'skipped', reason: 'signal-invalid',
    })
    assert.deepEqual(calls, [])
  })
}

for (const [marketType, sourceSide, targetSide] of [
  ['asian_handicap', 'home', 'away'], ['asian_handicap', 'away', 'home'], ['total', 'over', 'under'], ['total', 'under', 'over'],
]) {
  test(`locks reverse ${sourceSide} to ${targetSide} and creates a mode-scoped batch`, async () => {
    const input = signal({ marketType, sourceSide })
    const { consumer, calls, inboxItem } = harness({ input })
    assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated', authorizationId: null }), { status: 'batch_created', batchId: 'batch-1' })
    assert.equal(calls.find(([name]) => name === 'atomic')[1].lockedSelection.side, targetSide)
  })
}

test('exact-line and target-odds failures happen before market claim or batch work', async () => {
  const input = signal()
  for (const latest of [
    selection(input, { market: { ...selection(input).market, lineKey: 'ADJACENT' } }),
    selection(input, { selection: { ...selection(input).selection, odds: '1.050000000000000001' } }),
  ]) {
    const { consumer, calls, inboxItem } = harness({ input, latest })
    const result = await consumer.process(inboxItem, { executionMode: 'simulated' })
    assert.equal(result.reason, latest.market.lineKey === 'ADJACENT' ? 'market-changed' : 'target-odds-out-of-range')
    assert.equal(calls.some(([name]) => name === 'atomic'), false)
  }
})

test('a snapshot from the other prematch/live mode is rejected before market claim', async () => {
  const input = signal()
  const latest = selection(input, { mode: 'live', event: { eventKey: input.target.eventIdentity, mode: 'live' } })
  const { consumer, calls, inboxItem } = harness({ input, latest })
  assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated' }), { status: 'skipped', reason: 'market-changed' })
  assert.equal(calls.some(([name]) => name === 'atomic'), false)
})

for (const [name, settings, executionMode, global, reason] of [
  ['disabled', { enabled: false }, 'simulated', true, 'betting-mode-disabled'],
  ['review', { migrationReviewRequired: true }, 'simulated', true, 'migration-review-required'],
  ['real eligibility', { realEligible: false }, 'real', true, 'real-eligibility-required'],
  ['global intent', {}, 'real', false, 'global-real-betting-off'],
]) {
  test(`${name} skips before selection and market ownership`, async () => {
    const { consumer, calls, inboxItem } = harness({ settings, global })
    assert.deepEqual(await consumer.process(inboxItem, { executionMode }), { status: 'skipped', reason })
    assert.equal(calls.some(([call]) => call === 'latest' || call === 'atomic'), false)
  })
}

test('preview and simulated do not require global real intent or real eligibility', async () => {
  for (const executionMode of ['preview', 'simulated']) {
    const { consumer, calls, inboxItem } = harness({ settings: { realEligible: false }, global: false })
    assert.equal((await consumer.process(inboxItem, { executionMode })).status, 'batch_created')
    assert.equal(calls.some(([name]) => name === 'global'), false)
  }
})

test('duplicate atomic adapter result is stable and creates no second batch', async () => {
  const { consumer, calls, inboxItem } = harness({ atomicResult: { status: 'already-claimed' } })
  assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated' }), { status: 'skipped', reason: 'market-already-claimed' })
  assert.equal(calls.filter(([name]) => name === 'atomic').length, 1)
})

test('atomic adapter throw propagates without an independent market claim', async () => {
  const error = Object.assign(new Error('mode-scoped-batch-adapter-unavailable'), { code: 'mode-scoped-batch-adapter-unavailable' })
  const { consumer, calls, inboxItem } = harness({ atomicError: error })
  await assert.rejects(() => consumer.process(inboxItem, { executionMode: 'simulated' }), /mode-scoped-batch-adapter-unavailable/)
  assert.deepEqual(calls.map(([name]) => name), ['latest', 'atomic'])
})

test('historical disabled snapshot remains disabled regardless of later database state', async () => {
  const { consumer, calls, inboxItem } = harness({ settings: { enabled: false } })
  const laterDatabaseSetting = { enabled: true }
  assert.equal(laterDatabaseSetting.enabled, true)
  assert.deepEqual(await consumer.process(inboxItem, { executionMode: 'simulated' }), { status: 'skipped', reason: 'betting-mode-disabled' })
  assert.equal(calls.length, 0)
})

test('card has no mode filter but batch input keeps signal mode and immutable card identity', async () => {
  const input = signal({ mode: 'live' })
  const inbox = cardItem(input)
  delete inbox.bettingMode
  delete inbox.settingsVersion
  delete inbox.settingsSnapshot
  const calls = []
  const adapter = async (payload) => { calls.push(payload); return { status: 'batch_created', batchId: 'card-batch' } }
  adapter.ready = true
  const consumer = new AutoBettingConsumer({
    findLatestSelection: () => selection(input),
    isGlobalRealBettingRequested: () => true,
    claimAndCreateCardScopedBatch: adapter,
  })
  assert.deepEqual(await consumer.process(inbox, { executionMode: 'simulated' }), {
    status: 'batch_created', batchId: 'card-batch',
  })
  assert.deepEqual({
    cardId: calls[0].cardId, cardVersion: calls[0].cardVersion,
    bettingMode: calls[0].bettingMode, cardSnapshot: calls[0].cardSnapshot,
  }, { cardId: 'card-a', cardVersion: 7, bettingMode: 'live', cardSnapshot: inbox.cardSnapshot })
})

test('deleted card is finalized by the atomic adapter while non-up signals stop before selection', async () => {
  for (const [direction, reason] of [
    ['up', 'rule-deleted'], ['down', 'water-down-alert-only'], ['flat', 'signal-invalid'],
  ]) {
    const input = signal(); input.trigger.direction = direction
    const inbox = cardItem(input)
    delete inbox.bettingMode; delete inbox.settingsVersion; delete inbox.settingsSnapshot
    const calls = []
    const adapter = async () => { calls.push('atomic'); return {
      status: 'skipped', reason: 'rule-deleted', inboxFinalized: true,
    } }
    adapter.ready = true
    const consumer = new AutoBettingConsumer({
      findLatestSelection() { calls.push('selection'); return selection(input) },
      isGlobalRealBettingRequested: () => true,
      claimAndCreateCardScopedBatch: adapter,
    })
    assert.deepEqual(await consumer.process(inbox, { executionMode: 'simulated' }), {
      status: 'skipped', reason, ...(direction === 'up' ? { inboxFinalized: true } : {}),
    })
    assert.equal(calls.includes('selection'), direction === 'up')
    assert.equal(calls.includes('atomic'), direction === 'up')
  }
})

test('card-scoped market-once key changes for card identity and exact line only', async () => {
  const keys = []
  async function run(cardId, lineKey) {
    const input = signal()
    input.target.marketIdentity = input.target.marketIdentity.replace(/RATIO_RE$/, lineKey)
    input.target.selectionIdentity = `${input.target.marketIdentity}|home`
    const inbox = cardItem(input)
    inbox.cardId = cardId; inbox.cardSnapshot.cardId = cardId
    delete inbox.bettingMode; delete inbox.settingsVersion; delete inbox.settingsSnapshot
    const adapter = async (payload) => { keys.push(payload.marketOnceKey); return { status: 'batch_created', batchId: `${cardId}-${lineKey}` } }
    adapter.ready = true
    return new AutoBettingConsumer({ findLatestSelection: () => selection(input),
      isGlobalRealBettingRequested: () => true, claimAndCreateCardScopedBatch: adapter })
      .process(inbox, { executionMode: 'simulated' })
  }
  await run('card-a', 'RATIO_RE')
  await run('card-b', 'RATIO_RE')
  await run('card-a', 'RATIO_RE_A')
  assert.equal(new Set(keys).size, 3)
})
