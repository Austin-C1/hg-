import { TextDecoder } from 'node:util'

import { parseSemver } from './semver.mjs'

const TOP_LEVEL_FIELDS = Object.freeze([
  'schemaVersion',
  'appId',
  'channel',
  'packageType',
  'version',
  'minUpdaterVersion',
  'releaseTag',
  'signingKeyId',
  'assetName',
  'assetSize',
  'assetSha256',
  'createdAt',
  'files',
])
const FILE_FIELDS = Object.freeze(['path', 'size', 'sha256'])
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const KEY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
const SHA_256_PATTERN = /^[0-9a-f]{64}$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireExactFields(value, expectedFields, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actualFields = Object.keys(value)
  if (
    actualFields.length !== expectedFields.length
    || expectedFields.some((field) => !Object.hasOwn(value, field))
    || actualFields.some((field) => !expectedFields.includes(field))
  ) {
    throw new TypeError(`${label} fields do not match the strict schema`)
  }
}

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function requireSafeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`)
  }
  return value
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function requireSafeAssetName(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || /[\x00-\x1f\x7f\\/:]/.test(value)
    || /[. ]$/.test(value)
    || value === '.'
    || value === '..'
  ) {
    throw new TypeError('manifest assetName is invalid')
  }
  return value
}

function requireSafeFilePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new TypeError('manifest file path is unsafe')
  }
  const segments = value.split('/')
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment))
  ) {
    throw new TypeError('manifest file path is unsafe')
  }
  return value
}

function normalizeFile(value) {
  requireExactFields(value, FILE_FIELDS, 'manifest file')
  return {
    path: requireSafeFilePath(value.path),
    size: requireSafeInteger(value.size, 'manifest file size'),
    sha256: requireSha256(value.sha256, 'manifest file sha256'),
  }
}

function normalizeFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('manifest files must be a non-empty array')
  }
  const files = value.map(normalizeFile)
  const caseFoldedPaths = new Set()
  let previousPath = null
  for (const file of files) {
    const caseFolded = file.path.toLowerCase()
    if (caseFoldedPaths.has(caseFolded)) {
      throw new TypeError('manifest files contain a duplicate Windows path')
    }
    caseFoldedPaths.add(caseFolded)
    if (previousPath !== null && previousPath >= file.path) {
      throw new TypeError('manifest files must be sorted by path')
    }
    previousPath = file.path
  }
  return files
}

function normalizeManifest(value) {
  requireExactFields(value, TOP_LEVEL_FIELDS, 'manifest')
  if (value.schemaVersion !== 1) {
    throw new TypeError('manifest schemaVersion is unsupported')
  }
  const appId = requireIdentity(value.appId, 'manifest appId')
  const channel = requireIdentity(value.channel, 'manifest channel')
  if (value.packageType !== 'full' && value.packageType !== 'update') {
    throw new TypeError('manifest packageType is unsupported')
  }
  parseSemver(value.version)
  parseSemver(value.minUpdaterVersion)
  if (value.releaseTag !== `v${value.version}`) {
    throw new TypeError('manifest releaseTag must match version')
  }
  if (typeof value.signingKeyId !== 'string' || !KEY_ID_PATTERN.test(value.signingKeyId)) {
    throw new TypeError('manifest signingKeyId is invalid')
  }
  if (
    typeof value.createdAt !== 'string'
    || !ISO_TIMESTAMP_PATTERN.test(value.createdAt)
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new TypeError('manifest createdAt must be a canonical UTC timestamp')
  }

  return {
    schemaVersion: 1,
    appId,
    channel,
    packageType: value.packageType,
    version: value.version,
    minUpdaterVersion: value.minUpdaterVersion,
    releaseTag: value.releaseTag,
    signingKeyId: value.signingKeyId,
    assetName: requireSafeAssetName(value.assetName),
    assetSize: requireSafeInteger(value.assetSize, 'manifest assetSize', { positive: true }),
    assetSha256: requireSha256(value.assetSha256, 'manifest assetSha256'),
    createdAt: value.createdAt,
    files: normalizeFiles(value.files),
  }
}

function freezeManifest(manifest) {
  for (const file of manifest.files) Object.freeze(file)
  Object.freeze(manifest.files)
  return Object.freeze(manifest)
}

export function canonicalizeUpdateManifest(value) {
  const manifest = normalizeManifest(value)
  return Buffer.from(JSON.stringify(manifest), 'utf8')
}

export function parseUpdateManifest(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('manifest bytes must be a Buffer or Uint8Array')
  }
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let text
  try {
    text = UTF8_DECODER.decode(input)
  } catch {
    throw new TypeError('manifest must be valid UTF-8')
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TypeError('manifest JSON is invalid')
  }
  const canonicalBytes = canonicalizeUpdateManifest(parsed)
  if (!input.equals(canonicalBytes)) {
    throw new TypeError('manifest JSON bytes are not canonical')
  }
  return freezeManifest(normalizeManifest(parsed))
}
