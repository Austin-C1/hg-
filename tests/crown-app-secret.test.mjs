import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  canStoreSecrets,
  decryptSecret,
  encryptSecret,
  readOrCreateLocalSecretKey,
  redactSecretFields,
} from '../src/crown/app/app-secret.mjs'

const execFileAsync = promisify(execFile)
const key = 'local-test-secret-key-with-more-than-32-characters'
const legacyV1Ciphertext = 'v1:t0KQOFEk-1HqeMTX:tMZ3caqlOiiyq4--wTXySA:7Ak01v3-j5VWIw4IsrBWQ1yrxD-gnkoyZA'

test('secret encryption does not expose plaintext and decrypts with the same key', () => {
  const encrypted = encryptSecret('皇冠账号密码', { secretKey: key })

  assert.equal(encrypted.includes('皇冠账号密码'), false)
  assert.equal(decryptSecret(encrypted, { secretKey: key }), '皇冠账号密码')
})

test('legacy v1 ciphertext remains readable and context-free writes remain v1', () => {
  assert.equal(decryptSecret(legacyV1Ciphertext, { secretKey: key }), 'legacy-provider-reference')

  const encrypted = encryptSecret('new-context-free-secret', { secretKey: key })
  assert.match(encrypted, /^v1:/)
  assert.equal(decryptSecret(encrypted, { secretKey: key }), 'new-context-free-secret')
})

test('context-bound secrets use v2 and require the same child and submit attempt context', () => {
  const context = {
    purpose: 'crown-provider-reference',
    childOrderId: 'child-1',
    submitAttemptId: 'submit-1',
  }
  const encrypted = encryptSecret('provider-reference-raw', { secretKey: key, context })

  assert.match(encrypted, /^v2:/)
  assert.equal(encrypted.includes('provider-reference-raw'), false)
  assert.equal(decryptSecret(encrypted, {
    secretKey: key,
    context: { submitAttemptId: 'submit-1', purpose: 'crown-provider-reference', childOrderId: 'child-1' },
  }), 'provider-reference-raw')
  assert.throws(() => decryptSecret(encrypted, {
    secretKey: key,
    context: { ...context, childOrderId: 'child-2' },
  }), /invalid-secret-context/)
  assert.throws(() => decryptSecret(encrypted, {
    secretKey: key,
    context: { ...context, submitAttemptId: 'submit-2' },
  }), /invalid-secret-context/)
  assert.throws(() => decryptSecret(encrypted, { secretKey: key }), /secret-context-required/)
})

test('empty secret behavior remains compatible even when context is absent or malformed', () => {
  assert.equal(encryptSecret('', { secretKey: key, context: null }), '')
  assert.equal(encryptSecret(null, { secretKey: key, context: { childOrderId: 'child-1' } }), '')
  assert.equal(decryptSecret('', { secretKey: key }), '')
  assert.equal(decryptSecret(null, { secretKey: key, context: null }), '')
})

test('non-empty secrets use an auto-generated local key when CROWN_SECRET_KEY is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-secret-'))
  const keyPath = path.join(dir, 'local-secret.key')
  const env = { CROWN_SECRET_KEY: '', CROWN_LOCAL_SECRET_KEY_PATH: keyPath }

  assert.equal(canStoreSecrets(env), true)
  const encrypted = encryptSecret('secret-value', { env })

  assert.equal(fs.existsSync(keyPath), true)
  assert.equal(encrypted.includes('secret-value'), false)
  assert.equal(decryptSecret(encrypted, { env }), 'secret-value')
})

test('portable local key uses an explicit absolute path and rejects repository-relative fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-secret-'))
  const dataRoot = path.join(dir, 'data')
  const keyPath = path.join(dataRoot, 'storage', 'crown-local-secret.key')
  const env = { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot, CROWN_LOCAL_SECRET_KEY_PATH: keyPath }

  const generated = readOrCreateLocalSecretKey({ env })
  assert.equal(typeof generated, 'string')
  assert.equal(fs.readFileSync(keyPath, 'utf8').trim(), generated)
  assert.equal(readOrCreateLocalSecretKey({ env }), generated)
  assert.throws(
    () => readOrCreateLocalSecretKey({ env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot } }),
    /portable-secret-key-path-required/,
  )
  assert.throws(
    () => readOrCreateLocalSecretKey({ keyPath: 'storage/local.key', env }),
    /portable-secret-key-path-absolute-required/,
  )
})

test('portable local key requires a fully-qualified data root and stays contained within it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-secret-root-'))
  const dataRoot = path.join(dir, 'data')
  const keyPath = path.join(dataRoot, 'storage', 'crown-local-secret.key')
  const outsidePath = path.join(dir, 'data-sibling', 'crown-local-secret.key')

  assert.throws(
    () => readOrCreateLocalSecretKey({ keyPath, env: { CROWN_PORTABLE: '1' } }),
    /portable-data-root-required/,
  )
  assert.throws(
    () => readOrCreateLocalSecretKey({
      keyPath,
      env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: '\\data' },
    }),
    /portable-data-root-invalid/,
  )
  assert.throws(
    () => readOrCreateLocalSecretKey({
      keyPath: outsidePath,
      env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot },
    }),
    /portable-path-outside-data-root:secretKeyPath/,
  )
})

test('portable local key rejects drive-root-relative paths before filesystem access', () => {
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-secret-qualified-')), 'data')

  assert.throws(
    () => readOrCreateLocalSecretKey({
      keyPath: '\\',
      env: { CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot },
    }),
    /portable-secret-key-path-absolute-required/,
  )
})

test('six independent creators atomically read the same winning local key', async () => {
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-secret-concurrent-')), 'data')
  const keyPath = path.join(dataRoot, 'storage', 'crown-local-secret.key')
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  const moduleUrl = new URL('../src/crown/app/app-secret.mjs', import.meta.url).href
  const startAt = Date.now() + 1_000
  const script = `
    const [moduleUrl, dataRoot, keyPath, startAt] = process.argv.slice(1);
    const wait = Math.max(0, Number(startAt) - Date.now());
    if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    const { readOrCreateLocalSecretKey } = await import(moduleUrl);
    const key = readOrCreateLocalSecretKey({ env: {
      CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot, CROWN_LOCAL_SECRET_KEY_PATH: keyPath,
    }});
    process.stdout.write(key);
  `
  const results = await Promise.all(Array.from({ length: 6 }, () => execFileAsync(process.execPath, [
    '--input-type=module', '--eval', script,
    moduleUrl, dataRoot, keyPath, String(startAt),
  ], { timeout: 10_000 })))
  const keys = results.map(({ stdout }) => stdout.trim())

  assert.equal(new Set(keys).size, 1)
  assert.equal(fs.readFileSync(keyPath, 'utf8').trim(), keys[0])
})

test('secret redaction returns hasSecret without ciphertext or plaintext', () => {
  const row = {
    id: 'account-1',
    label: '监控账号',
    username: 'user-a',
    secret_ciphertext: encryptSecret('hidden-password', { secretKey: key }),
  }

  assert.deepEqual(redactSecretFields(row), {
    id: 'account-1',
    label: '监控账号',
    username: 'user-a',
    hasSecret: true,
  })
})
