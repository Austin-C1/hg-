import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RELEASE_CONFIG } from '../src/crown/update/release-config.mjs'
import { canonicalizeUpdateManifest } from '../src/crown/update/update-manifest.mjs'
import { verifyUpdateManifest } from '../src/crown/update/update-signature.mjs'
import { signReleaseManifest } from '../scripts/sign-release-manifest.mjs'

const SHA_256_A = 'a'.repeat(64)
const SHA_256_B = 'b'.repeat(64)

function makeManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    appId: 'crown-monitor',
    channel: 'private-beta',
    packageType: 'update',
    version: '0.1.1',
    minUpdaterVersion: '0.1.0',
    releaseTag: 'v0.1.1',
    signingKeyId: 'test-key-1',
    assetName: 'CrownMonitor-v0.1.1-update.zip',
    assetSize: 4096,
    assetSha256: SHA_256_A,
    createdAt: '2026-07-13T00:00:00.000Z',
    files: [
      { path: 'app/package.json', size: 512, sha256: SHA_256_B },
    ],
    ...overrides,
  }
}

function withTemporarySigningKey(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-update-signing-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyPath = path.join(directory, 'private-key.pem')
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
    fs.writeFileSync(privateKeyPath, privateKeyPem, {
      encoding: 'utf8',
      mode: 0o600,
    })
    return run({
      directory,
      privateKey,
      privateKeyPem,
      privateKeyDer: privateKey.export({ type: 'pkcs8', format: 'der' }),
      privateKeyPath,
      publicKey,
      publicKeyPem,
      publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }),
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function verifyOptions(manifestBytes, signatureBytes, publicKeyPem, overrides = {}) {
  return {
    manifestBytes,
    signatureBytes,
    trustedKeys: Object.freeze({ 'test-key-1': publicKeyPem }),
    expectedAppId: 'crown-monitor',
    expectedChannel: 'private-beta',
    expectedPackageType: 'update',
    currentVersion: '0.1.0',
    updaterVersion: '0.1.0',
    ...overrides,
  }
}

test('valid Ed25519 signature verifies canonical bytes and returns the trusted manifest', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    const manifest = verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem))

    assert.equal(manifest.version, '0.1.1')
    assert.equal(manifest.signingKeyId, 'test-key-1')
    assert.equal(Object.isFrozen(manifest), true)
  })
})

test('trusted Ed25519 material accepts only public KeyObject or raw SPKI public PEM and DER', () => {
  withTemporarySigningKey(({
    privateKeyPath,
    publicKey,
    publicKeyPem,
    publicKeyDer,
  }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))

    for (const trustedKey of [publicKey, publicKeyPem, publicKeyDer]) {
      assert.equal(
        verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, trustedKey)).version,
        '0.1.1',
      )
    }
    assert.throws(
      () => verifyUpdateManifest(verifyOptions(
        manifestBytes,
        signatureBytes,
        { key: publicKeyPem, format: 'pem' },
      )),
      /public.*key|trusted.*key|Ed25519/i,
    )
  })
})

test('trusted key parser rejects direct and nested private key descriptors', () => {
  withTemporarySigningKey(({
    privateKey,
    privateKeyPem,
    privateKeyDer,
    privateKeyPath,
  }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    const privateDescriptors = [
      privateKey,
      privateKeyPem,
      privateKeyDer,
      { key: privateKeyPem, format: 'pem' },
      { key: privateKeyDer, format: 'der', type: 'pkcs8' },
      { key: { key: privateKeyPem, format: 'pem' } },
    ]

    for (const trustedKey of privateDescriptors) {
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, trustedKey)),
        /public.*key|trusted.*key|Ed25519/i,
      )
    }
  })
})

test('trusted key parser rejects SPKI DER with appended private DER or garbage bytes', () => {
  withTemporarySigningKey(({
    privateKeyDer,
    privateKeyPath,
    publicKeyDer,
  }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))

    for (const trustedKey of [
      Buffer.concat([publicKeyDer, privateKeyDer]),
      Buffer.concat([publicKeyDer, Buffer.from('trailing-garbage', 'utf8')]),
    ]) {
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, trustedKey)),
        /SPKI|public.*key|trusted.*key|Ed25519/i,
      )
    }
  })
})

test('trusted key parser accepts one public PEM envelope only and rejects mixed or trailing PEM content', () => {
  withTemporarySigningKey(({
    privateKeyPath,
    privateKeyPem,
    publicKeyDer,
    publicKeyPem,
  }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    const publicEnvelope = publicKeyPem.trimEnd()
    const privateEnvelope = privateKeyPem.trimEnd()
    const derWithGarbage = Buffer.concat([publicKeyDer, Buffer.from('garbage', 'utf8')])
    const encoded = derWithGarbage.toString('base64')
    const nonCanonicalDerPem = [
      '-----BEGIN PUBLIC KEY-----',
      ...encoded.match(/.{1,64}/g),
      '-----END PUBLIC KEY-----',
      '',
    ].join('\n')
    const invalidPemValues = [
      `${publicEnvelope}\n${privateEnvelope}\n-----END PUBLIC KEY-----\n`,
      `${publicEnvelope}\n-----END PUBLIC KEY-----\n`,
      `\n${publicKeyPem}`,
      `${publicKeyPem}\n`,
      nonCanonicalDerPem,
    ]

    assert.equal(
      verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)).version,
      '0.1.1',
    )
    for (const trustedKey of invalidPemValues) {
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, trustedKey)),
        /SPKI|public.*key|trusted.*key|Ed25519/i,
      )
    }
  })
})

test('unknown signing key id fails closed before an otherwise valid signature can authorize an update', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest({ signingKeyId: 'unknown-key' }))
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))

    assert.throws(
      () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)),
      /unknown.*key|trusted.*key/i,
    )
  })
})

test('one changed manifest byte and one changed signature byte both fail closed', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    const tamperedManifest = Buffer.from(manifestBytes)
    const assetOffset = tamperedManifest.indexOf(Buffer.from('CrownMonitor'))
    tamperedManifest[assetOffset] = 'D'.charCodeAt(0)
    const tamperedSignature = Buffer.from(signatureBytes)
    tamperedSignature[0] ^= 0x01

    assert.throws(
      () => verifyUpdateManifest(verifyOptions(tamperedManifest, signatureBytes, publicKeyPem)),
      /signature/i,
    )
    assert.throws(
      () => verifyUpdateManifest(verifyOptions(manifestBytes, tamperedSignature, publicKeyPem)),
      /signature/i,
    )
  })
})

test('a signature never authorizes non-canonical JSON or an unknown manifest field', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const nonCanonicalBytes = Buffer.from(JSON.stringify(makeManifest(), null, 2), 'utf8')
    const unknownFieldBytes = Buffer.from(JSON.stringify({
      ...makeManifest(),
      downloadUrl: 'https://example.test/update.zip',
    }), 'utf8')

    for (const manifestBytes of [nonCanonicalBytes, unknownFieldBytes]) {
      const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)),
        /canonical|field/i,
      )
    }
  })
})

test('downgrade and same-version reinstall are rejected after signature verification', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    for (const version of ['0.0.9', '0.1.0']) {
      const manifestBytes = canonicalizeUpdateManifest(makeManifest({
        version,
        releaseTag: `v${version}`,
      }))
      const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)),
        /newer|version/i,
      )
    }
  })
})

test('wrong app, channel, and package type are individually rejected', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    for (const override of [
      { appId: 'another-app' },
      { channel: 'stable' },
      { packageType: 'full' },
    ]) {
      const manifestBytes = canonicalizeUpdateManifest(makeManifest(override))
      const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
      assert.throws(
        () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)),
        /app|channel|package/i,
      )
    }
  })
})

test('manifest requiring a newer updater is rejected', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest({ minUpdaterVersion: '0.2.0' }))
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    assert.throws(
      () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)),
      /updater.*version|min.*updater/i,
    )
  })
})

test('non-Ed25519 trust material and malformed raw signatures are rejected', () => {
  withTemporarySigningKey(({ privateKeyPath, publicKeyPem }) => {
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const signatureBytes = sign(null, manifestBytes, fs.readFileSync(privateKeyPath))
    const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
      .export({ type: 'spki', format: 'pem' })

    assert.throws(
      () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, rsaPublicKey)),
      /ed25519/i,
    )
    assert.throws(
      () => verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes.subarray(0, 63), publicKeyPem)),
      /signature/i,
    )
  })
})

test('release config is immutable, contains no private key, and defaults to no trusted production key', () => {
  assert.equal(RELEASE_CONFIG.appId, 'crown-monitor')
  assert.equal(RELEASE_CONFIG.channel, 'private-beta')
  assert.equal(RELEASE_CONFIG.packageType, 'update')
  assert.equal(RELEASE_CONFIG.github.owner, 'Austin-C1')
  assert.equal(RELEASE_CONFIG.github.repository, 'hg-')
  assert.equal(Object.isFrozen(RELEASE_CONFIG), true)
  assert.equal(Object.isFrozen(RELEASE_CONFIG.github), true)
  assert.equal(Object.isFrozen(RELEASE_CONFIG.trustedKeys), true)
  assert.deepEqual(Object.keys(RELEASE_CONFIG.trustedKeys), [])
  assert.doesNotMatch(JSON.stringify(RELEASE_CONFIG), /BEGIN PRIVATE KEY|secret|pkcs8/i)
})

test('offline signing command requires an explicit private key path and writes a raw verifiable signature', () => {
  withTemporarySigningKey(({ directory, privateKeyPath, publicKeyPem }) => {
    const manifestPath = path.join(directory, 'update-manifest.json')
    const signaturePath = path.join(directory, 'update-manifest.sig')
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    fs.writeFileSync(manifestPath, manifestBytes)

    assert.throws(() => execFileSync(process.execPath, [
      'scripts/sign-release-manifest.mjs',
      '--manifest', manifestPath,
      '--signature', signaturePath,
    ], { cwd: process.cwd(), stdio: 'pipe' }))

    execFileSync(process.execPath, [
      'scripts/sign-release-manifest.mjs',
      '--manifest', manifestPath,
      '--private-key', privateKeyPath,
      '--signature', signaturePath,
    ], { cwd: process.cwd(), stdio: 'pipe' })

    const signatureBytes = fs.readFileSync(signaturePath)
    assert.equal(signatureBytes.length, 64)
    assert.equal(
      fs.readdirSync(directory).some((name) => name.includes('.signature-tmp-')),
      false,
    )
    assert.equal(
      verifyUpdateManifest(verifyOptions(manifestBytes, signatureBytes, publicKeyPem)).version,
      '0.1.1',
    )
  })
})

test('offline signer rejects lexical input/output path reuse without changing manifest or private key bytes', () => {
  withTemporarySigningKey(({ directory, privateKeyPath }) => {
    const manifestPath = path.join(directory, 'update-manifest.json')
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    fs.writeFileSync(manifestPath, manifestBytes)
    const privateKeyBytes = fs.readFileSync(privateKeyPath)

    for (const signaturePath of [manifestPath, privateKeyPath]) {
      assert.throws(
        () => signReleaseManifest({ manifestPath, privateKeyPath, signaturePath }),
        /alias|same|input/i,
      )
      assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes)
      assert.deepEqual(fs.readFileSync(privateKeyPath), privateKeyBytes)
    }
  })
})

test('offline signer rejects a hardlink alias to an input without changing either input', () => {
  withTemporarySigningKey(({ directory, privateKeyPath }) => {
    const manifestPath = path.join(directory, 'update-manifest.json')
    const signaturePath = path.join(directory, 'update-manifest.sig')
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    fs.writeFileSync(manifestPath, manifestBytes)
    const privateKeyBytes = fs.readFileSync(privateKeyPath)
    fs.linkSync(privateKeyPath, signaturePath)

    assert.throws(
      () => signReleaseManifest({ manifestPath, privateKeyPath, signaturePath }),
      /alias|same|input/i,
    )
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes)
    assert.deepEqual(fs.readFileSync(privateKeyPath), privateKeyBytes)
  })
})

test('offline signer resolves a symlinked directory and rejects an output alias to the manifest', () => {
  withTemporarySigningKey(({ directory, privateKeyPath }) => {
    const manifestPath = path.join(directory, 'update-manifest.json')
    const manifestBytes = canonicalizeUpdateManifest(makeManifest())
    const privateKeyBytes = fs.readFileSync(privateKeyPath)
    fs.writeFileSync(manifestPath, manifestBytes)
    const aliasDirectory = path.join(directory, 'directory-alias')
    fs.symlinkSync(directory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    assert.throws(
      () => signReleaseManifest({
        manifestPath,
        privateKeyPath,
        signaturePath: path.join(aliasDirectory, path.basename(manifestPath)),
      }),
      /alias|same|input/i,
    )
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes)
    assert.deepEqual(fs.readFileSync(privateKeyPath), privateKeyBytes)
  })
})
