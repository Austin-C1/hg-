import {
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseUpdateManifest } from '../src/crown/update/update-manifest.mjs'

function requirePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be explicitly provided`)
  }
  return value
}

function readFile(filePath, label) {
  try {
    return fs.readFileSync(filePath)
  } catch {
    throw new Error(`unable to read ${label}`)
  }
}

function normalizeIdentityPath(filePath) {
  const normalized = path.normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function readExistingIdentity(filePath, label) {
  const absolutePath = path.resolve(filePath)
  try {
    return {
      absolutePath,
      realPath: fs.realpathSync.native(absolutePath),
      stat: fs.statSync(absolutePath),
    }
  } catch {
    throw new Error(`unable to inspect ${label}`)
  }
}

function readOutputIdentity(filePath) {
  const absolutePath = path.resolve(filePath)
  try {
    return {
      absolutePath,
      realPath: fs.realpathSync.native(absolutePath),
      stat: fs.statSync(absolutePath),
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error('unable to inspect signature output')
    }
    try {
      const realParent = fs.realpathSync.native(path.dirname(absolutePath))
      return {
        absolutePath,
        realPath: path.join(realParent, path.basename(absolutePath)),
        stat: null,
      }
    } catch {
      throw new Error('unable to inspect signature output')
    }
  }
}

function identitiesMatch(left, right) {
  if (normalizeIdentityPath(left.absolutePath) === normalizeIdentityPath(right.absolutePath)) {
    return true
  }
  if (normalizeIdentityPath(left.realPath) === normalizeIdentityPath(right.realPath)) {
    return true
  }
  return Boolean(
    left.stat
    && right.stat
    && left.stat.ino !== 0
    && right.stat.ino !== 0
    && left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino,
  )
}

function assertDistinctSignatureOutput(signaturePath, inputIdentities) {
  const outputIdentity = readOutputIdentity(signaturePath)
  if (inputIdentities.some((identity) => identitiesMatch(outputIdentity, identity))) {
    throw new Error('signature output must not alias an input file')
  }
  return outputIdentity.absolutePath
}

function flushDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some Windows filesystems do not permit opening directories for fsync.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function writeSignatureAtomically(signaturePath, signatureBytes, inputIdentities) {
  const absoluteSignaturePath = assertDistinctSignatureOutput(signaturePath, inputIdentities)
  const directory = path.dirname(absoluteSignaturePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absoluteSignaturePath)}.signature-tmp-${process.pid}-${randomBytes(12).toString('hex')}`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, signatureBytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    assertDistinctSignatureOutput(signaturePath, inputIdentities)
    fs.renameSync(temporaryPath, absoluteSignaturePath)
    flushDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the primary signing error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    if (error?.message === 'signature output must not alias an input file') throw error
    throw new Error('unable to write release signature atomically')
  }
}

export function signReleaseManifest({ manifestPath, privateKeyPath, signaturePath } = {}) {
  const resolvedManifestPath = requirePath(manifestPath, 'manifest path')
  const resolvedPrivateKeyPath = requirePath(privateKeyPath, 'private key path')
  const resolvedSignaturePath = requirePath(signaturePath, 'signature path')
  const inputIdentities = [
    readExistingIdentity(resolvedManifestPath, 'release manifest'),
    readExistingIdentity(resolvedPrivateKeyPath, 'private key'),
  ]
  assertDistinctSignatureOutput(resolvedSignaturePath, inputIdentities)
  const manifestBytes = readFile(resolvedManifestPath, 'release manifest')
  parseUpdateManifest(manifestBytes)

  let privateKey
  try {
    privateKey = createPrivateKey(readFile(resolvedPrivateKeyPath, 'private key'))
  } catch (error) {
    if (error?.message === 'unable to read private key') throw error
    throw new Error('private key is not a valid Ed25519 private key')
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('private key must use Ed25519')
  }

  const signatureBytes = sign(null, manifestBytes, privateKey)
  if (signatureBytes.length !== 64) {
    throw new Error('Ed25519 signing returned an invalid signature')
  }
  writeSignatureAtomically(resolvedSignaturePath, signatureBytes, inputIdentities)
  return signatureBytes
}

function parseArguments(argv) {
  const values = Object.create(null)
  const accepted = new Set(['--manifest', '--private-key', '--signature'])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!accepted.has(flag) || typeof value !== 'string' || value.startsWith('--')) {
      throw new TypeError('usage: sign-release-manifest --manifest <path> --private-key <path> --signature <path>')
    }
    if (Object.hasOwn(values, flag)) {
      throw new TypeError(`duplicate signing argument: ${flag}`)
    }
    values[flag] = value
  }
  return {
    manifestPath: values['--manifest'],
    privateKeyPath: values['--private-key'],
    signaturePath: values['--signature'],
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  try {
    signReleaseManifest(parseArguments(process.argv.slice(2)))
    process.stdout.write('release manifest signature written\n')
  } catch (error) {
    process.stderr.write(`release signing failed: ${error?.message ?? 'unknown error'}\n`)
    process.exitCode = 1
  }
}
