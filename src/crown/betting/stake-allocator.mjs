import { assertMinor } from './money.mjs'

function nonNegativeMinor(value, field) {
  return assertMinor(value, field)
}

function positiveMinor(value, field) {
  const result = assertMinor(value, field)
  if (result === 0) throw new RangeError(`${field}-positive`)
  return result
}

function normalizeAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('account')
  const accountId = String(value.accountId || '').trim()
  if (!accountId) throw new TypeError('accountId')
  const betOrder = value.betOrder ?? 0
  if (!Number.isSafeInteger(betOrder) || betOrder < 0) throw new TypeError('betOrder')
  return {
    accountId,
    betOrder,
    createdAt: String(value.createdAt || ''),
    perBetLimitMinor: positiveMinor(value.perBetLimitMinor, 'perBetLimitMinor'),
    confirmedBalanceMinor: nonNegativeMinor(value.confirmedBalanceMinor, 'confirmedBalanceMinor'),
    reservedUnknownMinor: nonNegativeMinor(value.reservedUnknownMinor ?? 0, 'reservedUnknownMinor'),
  }
}

function ordered(accounts) {
  return [...accounts].sort((left, right) => (
    left.betOrder - right.betOrder
    || left.createdAt.localeCompare(right.createdAt)
    || left.accountId.localeCompare(right.accountId)
  ))
}

export function allocateStake(targetMinor, accounts = []) {
  const target = positiveMinor(targetMinor, 'targetMinor')
  if (!Array.isArray(accounts)) throw new TypeError('accounts')
  const normalized = ordered(accounts.map(normalizeAccount))
  if (new Set(normalized.map((item) => item.accountId)).size !== normalized.length) {
    throw new TypeError('accountId-duplicate')
  }

  const allocations = []
  let remaining = target
  for (const account of normalized) {
    if (remaining === 0) break
    const spendable = Math.max(0, account.confirmedBalanceMinor - account.reservedUnknownMinor)
    const amountMinor = Math.min(remaining, account.perBetLimitMinor, spendable)
    if (amountMinor === 0) continue
    allocations.push({ accountId: account.accountId, amountMinor })
    remaining -= amountMinor
  }
  return {
    allocations,
    allocatedMinor: target - remaining,
    unfilledMinor: remaining,
  }
}
