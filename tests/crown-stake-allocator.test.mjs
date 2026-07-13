import assert from 'node:assert/strict'
import test from 'node:test'

import { allocateStake } from '../src/crown/betting/stake-allocator.mjs'

function account(accountId, overrides = {}) {
  return {
    accountId,
    betOrder: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    perBetLimitMinor: 100,
    confirmedBalanceMinor: 100,
    reservedUnknownMinor: 0,
    ...overrides,
  }
}

test('target 100 with limits 60 and 50 fills 60 then 40', () => {
  assert.deepEqual(allocateStake(100, [
    account('account-a', { perBetLimitMinor: 60 }),
    account('account-b', { betOrder: 2, perBetLimitMinor: 50 }),
  ]), {
    allocations: [
      { accountId: 'account-a', amountMinor: 60 },
      { accountId: 'account-b', amountMinor: 40 },
    ],
    allocatedMinor: 100,
    unfilledMinor: 0,
  })
})

test('target 100 with total spendable 80 returns partial allocation and unfilled 20', () => {
  assert.deepEqual(allocateStake(100, [
    account('account-a', { perBetLimitMinor: 60, confirmedBalanceMinor: 50 }),
    account('account-b', { betOrder: 2, perBetLimitMinor: 50, confirmedBalanceMinor: 30 }),
  ]), {
    allocations: [
      { accountId: 'account-a', amountMinor: 50 },
      { accountId: 'account-b', amountMinor: 30 },
    ],
    allocatedMinor: 80,
    unfilledMinor: 20,
  })
})

test('remaining 37 with limit 50 allocates exactly 37 without step rounding', () => {
  assert.deepEqual(allocateStake(37, [account('legacy-step-zero', {
    perBetLimitMinor: 50,
    confirmedBalanceMinor: 100,
    stakeStepMinor: 0,
  })]), {
    allocations: [{ accountId: 'legacy-step-zero', amountMinor: 37 }],
    allocatedMinor: 37,
    unfilledMinor: 0,
  })
})

test('later account never allocates before the first eligible ordered account', () => {
  const result = allocateStake(40, [
    account('order-2', { betOrder: 2 }),
    account('order-1', { betOrder: 1 }),
  ])
  assert.deepEqual(result.allocations, [{ accountId: 'order-1', amountMinor: 40 }])
})

test('uses bet order, creation time, and id as stable account ordering', () => {
  const result = allocateStake(250, [
    account('z-order-2', { betOrder: 2 }),
    account('z-later', { createdAt: '2026-07-11T00:00:00.000Z' }),
    account('b-same'),
    account('a-same'),
  ])
  assert.deepEqual(result.allocations.map((item) => item.accountId), ['a-same', 'b-same', 'z-later'])
  assert.deepEqual(result.allocations.map((item) => item.amountMinor), [100, 100, 50])
})

test('subtracts reserved and unknown exposure from confirmed balance', () => {
  assert.deepEqual(allocateStake(100, [account('account-a', {
    confirmedBalanceMinor: 90,
    reservedUnknownMinor: 35,
  })]), {
    allocations: [{ accountId: 'account-a', amountMinor: 55 }],
    allocatedMinor: 55,
    unfilledMinor: 45,
  })
})

test('rejects unsafe integer money inputs', () => {
  assert.throws(() => allocateStake(0, [account('a')]), /targetMinor-positive/)
  assert.throws(() => allocateStake(Number.MAX_SAFE_INTEGER + 1, [account('a')]), /targetMinor-minor/)
  assert.throws(() => allocateStake(100, [account('a', { perBetLimitMinor: 1.5 })]), /perBetLimitMinor-minor/)
  assert.throws(() => allocateStake(100, [account('a', { confirmedBalanceMinor: null })]), /confirmedBalanceMinor-minor/)
  assert.throws(() => allocateStake(100, [account('a', { reservedUnknownMinor: -1 })]), /reservedUnknownMinor-minor/)
})
