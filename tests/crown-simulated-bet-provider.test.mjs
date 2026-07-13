import assert from 'node:assert/strict'
import test from 'node:test'

import { SimulatedBetProvider } from '../src/crown/betting/simulated-bet-provider.mjs'

test('plays a deterministic preview and submit result script without network access', async () => {
  const provider = new SimulatedBetProvider({
    script: [
      { operation: 'preview', result: { ok: true, minStakeMinor: 100, maxStakeMinor: 500, stakeStepMinor: 50 } },
      { operation: 'submit', result: { status: 'accepted', providerReference: 'sim-1' } },
    ],
    now: () => '2026-07-11T02:00:00.000Z',
  })

  assert.deepEqual(await provider.preview({ accountId: 'account-a' }), {
    ok: true,
    minStakeMinor: 100,
    maxStakeMinor: 500,
    stakeStepMinor: 50,
  })
  assert.deepEqual(await provider.submit({ accountId: 'account-a', amountMinor: 200 }), {
    status: 'accepted',
    providerReference: 'sim-1',
  })
  assert.equal(provider.networkCallCount, 0)
  assert.deepEqual(provider.calls.map(({ operation, input, startedAt, finishedAt }) => ({ operation, input, startedAt, finishedAt })), [
    {
      operation: 'preview',
      input: { accountId: 'account-a' },
      startedAt: '2026-07-11T02:00:00.000Z',
      finishedAt: '2026-07-11T02:00:00.000Z',
    },
    {
      operation: 'submit',
      input: { accountId: 'account-a', amountMinor: 200 },
      startedAt: '2026-07-11T02:00:00.000Z',
      finishedAt: '2026-07-11T02:00:00.000Z',
    },
  ])
})

test('scripts rejected, unknown, and timeout outcomes explicitly', async () => {
  const provider = new SimulatedBetProvider({ script: [
    { operation: 'submit', result: { status: 'rejected', errorCode: 'sim-rejected' } },
    { operation: 'submit', result: { status: 'unknown', errorCode: 'sim-unknown' } },
    { operation: 'submit', error: 'provider-timeout' },
  ] })

  assert.equal((await provider.submit({ attempt: 1 })).status, 'rejected')
  assert.equal((await provider.submit({ attempt: 2 })).status, 'unknown')
  await assert.rejects(provider.submit({ attempt: 3 }), (error) => error.code === 'provider-timeout')
  assert.equal(provider.calls.length, 3)
  assert.equal(provider.networkCallCount, 0)
})

test('fails closed when the script operation does not match or is exhausted', async () => {
  const provider = new SimulatedBetProvider({ script: [{ operation: 'preview', result: { ok: true } }] })
  await assert.rejects(provider.submit({}), /simulated-script-operation/)
  assert.equal(provider.calls.length, 0)
  assert.equal((await provider.preview({})).ok, true)
  await assert.rejects(provider.preview({}), /simulated-script-exhausted/)
})

test('preflights an exact operation sequence without consuming calls or script entries', async () => {
  const provider = new SimulatedBetProvider({ script: [
    { operation: 'preview', result: { ok: true } },
    { operation: 'submit', result: { status: 'accepted' } },
  ] })
  assert.doesNotThrow(() => provider.assertNextOperations(['preview', 'submit']))
  assert.equal(provider.calls.length, 0)
  assert.equal((await provider.preview({})).ok, true)
  assert.throws(() => provider.assertNextOperations(['preview']), /simulated-script-operation/)
  assert.equal((await provider.submit({})).status, 'accepted')
  assert.throws(() => provider.assertNextOperations(['submit']), /simulated-script-exhausted/)
})
