import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePublicHttpsExactOrigin } from '../src/crown/login/crown-origin.mjs'

test('normalizes a canonical public HTTPS exact origin', () => {
  assert.equal(
    normalizePublicHttpsExactOrigin('  https://crown.example.com:8443  '),
    'https://crown.example.com:8443',
  )
})
test('rejects credentials, paths, query strings, fragments, HTTP, and non-canonical origins', () => {
  const invalid = [
    'https://user@crown.example.com',
    'https://user:password@crown.example.com',
    'https://crown.example.com/login',
    'https://crown.example.com?next=login',
    'https://crown.example.com#login',
    'http://crown.example.com',
    'https://crown.example.com/',
    'https://CROWN.example.com',
    'https://crown.example.com:443',
  ]

  for (const value of invalid) {
    assert.throws(() => normalizePublicHttpsExactOrigin(value), /crown-origin-/, value)
  }
})

test('rejects localhost, single-label and private or special-use hostnames', () => {
  const invalid = [
    'https://localhost',
    'https://crown',
    'https://crown.localhost',
    'https://crown.local',
    'https://crown.internal',
    'https://crown.lan',
    'https://crown.home',
    'https://crown.corp',
    'https://crown.localdomain',
    'https://crown.home.arpa',
    'https://crown.test',
    'https://crown.example',
    'https://crown.invalid',
    'https://crown.onion',
  ]

  for (const value of invalid) {
    assert.throws(() => normalizePublicHttpsExactOrigin(value), /crown-origin-public-host-required/, value)
  }
})

test('rejects every IP literal form including URL-normalized and bracketed forms', () => {
  const invalid = [
    'https://127.0.0.1',
    'https://192.168.1.9',
    'https://8.8.8.8',
    'https://2130706433',
    'https://0x7f000001',
    'https://[::1]',
    'https://[2001:4860:4860::8888]',
  ]

  for (const value of invalid) {
    assert.throws(() => normalizePublicHttpsExactOrigin(value), /crown-origin-ip-forbidden/, value)
  }
})
