import {
  KeyObject,
  createPublicKey,
  verify,
} from 'node:crypto'

import { compareSemver, parseSemver } from './semver.mjs'
import { parseUpdateManifest } from './update-manifest.mjs'

const PUBLIC_KEY_PEM_PATTERN = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=]{1,64}(?:\r?\n[A-Za-z0-9+/=]{1,64})*)\r?\n-----END PUBLIC KEY-----\r?\n?$/
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function asBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Buffer or Uint8Array`)
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function readTrustedKey(trustedKeys, signingKeyId) {
  if (trustedKeys instanceof Map) {
    if (!trustedKeys.has(signingKeyId)) return undefined
    return trustedKeys.get(signingKeyId)
  }
  if (trustedKeys === null || typeof trustedKeys !== 'object' || Array.isArray(trustedKeys)) {
    throw new TypeError('trustedKeys must be a read-only key map')
  }
  if (!Object.hasOwn(trustedKeys, signingKeyId)) return undefined
  return trustedKeys[signingKeyId]
}

function parseCanonicalSpkiDer(bytes) {
  const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  const canonicalDer = publicKey.export({ format: 'der', type: 'spki' })
  if (!bytes.equals(canonicalDer)) {
    throw new TypeError('SPKI DER contains non-canonical or trailing bytes')
  }
  return publicKey
}

function parseStrictPublicPem(pem) {
  const match = PUBLIC_KEY_PEM_PATTERN.exec(pem)
  if (!match) throw new TypeError('not a single public key PEM envelope')
  const lines = match[1].split(/\r?\n/)
  if (lines.slice(0, -1).some((line) => line.length !== 64)) {
    throw new TypeError('public key PEM uses non-canonical line wrapping')
  }
  const base64 = lines.join('')
  if (!CANONICAL_BASE64_PATTERN.test(base64)) {
    throw new TypeError('public key PEM base64 is invalid')
  }
  const der = Buffer.from(base64, 'base64')
  if (der.toString('base64') !== base64) {
    throw new TypeError('public key PEM base64 is not canonical')
  }
  return parseCanonicalSpkiDer(der)
}

function toEd25519PublicKey(material) {
  if (material === undefined) {
    throw new Error('unknown manifest signing key id')
  }

  let publicKey
  try {
    if (material instanceof KeyObject) {
      if (material.type !== 'public') throw new TypeError('not a public key')
      publicKey = material
    } else if (typeof material === 'string') {
      publicKey = parseStrictPublicPem(material)
    } else if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
      const bytes = Buffer.from(material.buffer, material.byteOffset, material.byteLength)
      if (bytes.subarray(0, 32).toString('ascii').startsWith('-----BEGIN')) {
        publicKey = parseStrictPublicPem(bytes.toString('utf8'))
      } else {
        publicKey = parseCanonicalSpkiDer(bytes)
      }
    } else {
      throw new TypeError('key descriptors are not accepted')
    }
  } catch {
    throw new TypeError('trusted key material must be a public Ed25519 KeyObject or SPKI PEM/DER')
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('trusted key must use Ed25519')
  }
  return publicKey
}

function requireExpectedIdentity(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
  return value
}

export function verifyUpdateManifest({
  manifestBytes,
  signatureBytes,
  trustedKeys,
  expectedAppId,
  expectedChannel,
  expectedPackageType = 'update',
  currentVersion,
  updaterVersion,
} = {}) {
  const rawManifest = asBytes(manifestBytes, 'manifestBytes')
  const rawSignature = asBytes(signatureBytes, 'signatureBytes')
  if (rawSignature.length !== 64) {
    throw new TypeError('update manifest signature must be exactly 64 raw bytes')
  }

  const manifest = parseUpdateManifest(rawManifest)
  const publicKey = toEd25519PublicKey(readTrustedKey(trustedKeys, manifest.signingKeyId))
  if (!verify(null, rawManifest, publicKey, rawSignature)) {
    throw new Error('update manifest signature is invalid')
  }

  if (manifest.appId !== requireExpectedIdentity(expectedAppId, 'expectedAppId')) {
    throw new Error('update manifest appId does not match this application')
  }
  if (manifest.channel !== requireExpectedIdentity(expectedChannel, 'expectedChannel')) {
    throw new Error('update manifest channel does not match this release channel')
  }
  if (manifest.packageType !== requireExpectedIdentity(expectedPackageType, 'expectedPackageType')) {
    throw new Error('update manifest packageType is not accepted by this updater')
  }

  parseSemver(currentVersion)
  parseSemver(updaterVersion)
  if (compareSemver(manifest.version, currentVersion) <= 0) {
    throw new Error('update manifest version must be newer than the current version')
  }
  if (compareSemver(updaterVersion, manifest.minUpdaterVersion) < 0) {
    throw new Error('updater version is below the manifest min updater version')
  }
  return manifest
}
