import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { assertPathWithin } from '../runtime/portable-paths.mjs'

const VERSION_V1 = 'v1'
const VERSION_V2 = 'v2'
const ALGORITHM = 'aes-256-gcm'
const DEFAULT_LOCAL_SECRET_KEY_PATH = 'storage/crown-local-secret.key'
const KEY_PUBLICATION_WAIT_MS = 1_000
const KEY_PUBLICATION_POLL_MS = 5

export class SecretKeyRequiredError extends Error {
  constructor() {
    super('secret-key-required')
    this.name = 'SecretKeyRequiredError'
    this.code = 'secret-key-required'
  }
}

function localSecretKeyPath({ env = process.env, cwd = process.cwd(), keyPath } = {}) {
  const configuredPath = keyPath || env.CROWN_LOCAL_SECRET_KEY_PATH || env.CROWN_SECRET_KEY_FILE
  if (env.CROWN_PORTABLE === '1') {
    if (!env.CROWN_DATA_ROOT) throw new Error('portable-data-root-required')
    let dataRoot
    try {
      dataRoot = assertPathWithin(env.CROWN_DATA_ROOT, env.CROWN_DATA_ROOT, 'dataRoot')
    } catch {
      throw new Error('portable-data-root-invalid')
    }
    if (!configuredPath) throw new Error('portable-secret-key-path-required')
    try {
      return assertPathWithin(dataRoot, configuredPath, 'secretKeyPath')
    } catch (error) {
      if (error?.code === 'portable-path-invalid') {
        throw new Error('portable-secret-key-path-absolute-required')
      }
      throw error
    }
  }
  const configured = configuredPath || DEFAULT_LOCAL_SECRET_KEY_PATH
  return path.resolve(cwd, configured)
}

function waitForPublishedLocalSecretKey(file) {
  const deadline = Date.now() + KEY_PUBLICATION_WAIT_MS
  while (true) {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
    if (Date.now() >= deadline) throw new Error('local-secret-key-empty')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KEY_PUBLICATION_POLL_MS)
  }
}

export function readOrCreateLocalSecretKey(options = {}) {
  const file = localSecretKeyPath(options)
  try {
    if (fs.existsSync(file)) return waitForPublishedLocalSecretKey(file)

    fs.mkdirSync(path.dirname(file), { recursive: true })
    const generated = crypto.randomBytes(32).toString('base64url')
    try {
      fs.writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return generated
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      return waitForPublishedLocalSecretKey(file)
    }
  } catch (error) {
    const wrapped = new Error('local-secret-key-unavailable')
    wrapped.cause = error
    throw wrapped
  }
}

function configuredSecretKey({ secretKey, env = process.env, cwd = process.cwd(), keyPath } = {}) {
  if (secretKey) return secretKey
  if (env.CROWN_SECRET_KEY) return env.CROWN_SECRET_KEY
  return readOrCreateLocalSecretKey({ env, cwd, keyPath })
}

function keyBytes(options = {}) {
  const value = configuredSecretKey(options)
  if (!value) throw new SecretKeyRequiredError()
  return crypto.createHash('sha256').update(value).digest()
}

function invalidContext(code = 'invalid-secret-context') {
  const error = new Error(code)
  error.code = code
  return error
}

function stableContextValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidContext()
    return value
  }
  if (Array.isArray(value)) return value.map(stableContextValue)
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw invalidContext()
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const item = value[key]
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw invalidContext()
      }
      return [key, stableContextValue(item)]
    }))
  }
  throw invalidContext()
}

function contextBytes(context) {
  if (context === undefined || context === null) throw invalidContext('secret-context-required')
  if (typeof context === 'string') {
    if (!context) throw invalidContext('secret-context-required')
    return Buffer.from(`string:${context}`, 'utf8')
  }
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).length === 0) {
    throw invalidContext()
  }
  let serialized
  try {
    serialized = JSON.stringify(stableContextValue(context))
  } catch (error) {
    if (error?.code === 'invalid-secret-context') throw error
    throw invalidContext()
  }
  return Buffer.from(`object:${serialized}`, 'utf8')
}

export function canStoreSecrets(env = process.env) {
  try {
    return Boolean(configuredSecretKey({ env }))
  } catch {
    return false
  }
}

export function encryptSecret(value, options = {}) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!text) return ''

  const contextBound = Object.hasOwn(options, 'context')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, keyBytes(options), iv)
  if (contextBound) cipher.setAAD(contextBytes(options.context))
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    contextBound ? VERSION_V2 : VERSION_V1,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':')
}

export function decryptSecret(ciphertext, options = {}) {
  if (!ciphertext) return ''
  const [version, ivRaw, tagRaw, encryptedRaw] = String(ciphertext).split(':')
  if (![VERSION_V1, VERSION_V2].includes(version) || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error('invalid-secret-ciphertext')
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBytes(options), Buffer.from(ivRaw, 'base64url'))
  if (version === VERSION_V2) decipher.setAAD(contextBytes(options.context))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    if (version === VERSION_V2) throw invalidContext()
    throw error
  }
}

export function redactSecretFields(row = {}) {
  const redacted = {}
  const ciphertext = row.secret_ciphertext ?? row.secretCiphertext ?? ''

  for (const [key, value] of Object.entries(row)) {
    if (['secret', 'password', 'secret_ciphertext', 'secretCiphertext'].includes(key)) continue
    redacted[key] = value
  }

  redacted.hasSecret = Boolean(ciphertext)
  return redacted
}
