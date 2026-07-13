import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertMinor,
  formatMinor,
  normalizeCurrency,
  parseDecimalToMinor,
} from '../src/crown/betting/money.mjs'

test('converts decimal strings exactly', () => {
  assert.equal(parseDecimalToMinor('12.34', { scale: 2 }), 1234)
  assert.equal(parseDecimalToMinor('12.3', { scale: 2 }), 1230)
  assert.equal(parseDecimalToMinor('7', { scale: 0 }), 7)
  assert.equal(parseDecimalToMinor('0', { scale: 2, allowZero: true }), 0)
  assert.equal(formatMinor(1234, { scale: 2 }), '12.34')
  assert.equal(formatMinor(7, { scale: 0 }), '7')
})

test('rejects invalid decimal amount inputs', () => {
  assert.throws(() => parseDecimalToMinor('1.234', { scale: 2 }), /amount-precision/)
  assert.throws(() => parseDecimalToMinor('NaN', { scale: 2 }), /amount-format/)
  assert.throws(() => parseDecimalToMinor('Infinity', { scale: 2 }), /amount-format/)
  assert.throws(() => parseDecimalToMinor('-1', { scale: 2 }), /amount-format/)
  assert.throws(() => parseDecimalToMinor('0', { scale: 2 }), /amount-positive/)
  assert.throws(() => parseDecimalToMinor('9007199254740992', { scale: 0 }), /amount-range/)
  assert.throws(() => parseDecimalToMinor('1', { scale: 7 }), /amount-scale/)
})

test('validates minor units and currency codes', () => {
  assert.equal(assertMinor(0), 0)
  assert.equal(assertMinor(1234, 'stake'), 1234)
  assert.throws(() => assertMinor(-1, 'stake'), /stake-minor/)
  assert.throws(() => assertMinor(1.5), /amount-minor/)
  assert.throws(() => formatMinor(Number.MAX_SAFE_INTEGER + 1, { scale: 2 }), /amount-minor/)
  assert.equal(normalizeCurrency(' cny '), 'CNY')
  assert.throws(() => normalizeCurrency('CN'), /currency/)
  assert.throws(() => normalizeCurrency('C1Y'), /currency/)
})
