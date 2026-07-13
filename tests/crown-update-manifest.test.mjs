import assert from 'node:assert/strict'
import test from 'node:test'

import { compareSemver, parseSemver } from '../src/crown/update/semver.mjs'
import {
  canonicalizeUpdateManifest,
  parseUpdateManifest,
} from '../src/crown/update/update-manifest.mjs'

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
      { path: 'app/src/index.mjs', size: 1024, sha256: SHA_256_A },
    ],
    ...overrides,
  }
}

test('strict SemVer parsing and precedence cover prerelease versions without build influence', () => {
  assert.deepEqual(parseSemver('0.1.1-beta.2+build.7'), {
    raw: '0.1.1-beta.2+build.7',
    major: '0',
    minor: '1',
    patch: '1',
    prerelease: ['beta', '2'],
    build: ['build', '7'],
  })
  assert.equal(compareSemver('0.1.1-beta.2', '0.1.1-beta.10'), -1)
  assert.equal(compareSemver('0.1.1-beta.10', '0.1.1'), -1)
  assert.equal(compareSemver('0.1.1+one', '0.1.1+two'), 0)
  assert.equal(compareSemver('1.0.0', '0.999.999'), 1)
})

test('SemVer parser rejects whitespace, leading zeros, and incomplete versions', () => {
  for (const value of [
    ' 0.1.1',
    '0.1.1 ',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2',
    'v1.2.3',
    '1.2.3-01',
  ]) {
    assert.throws(() => parseSemver(value), /semver/i, value)
  }
})

test('SemVer accepts arbitrary-length canonical decimals and compares them without precision loss', () => {
  const twoHundredNines = '9'.repeat(200)
  const oneFollowedByTwoHundredZeros = `1${'0'.repeat(200)}`
  const parsed = parseSemver(`${oneFollowedByTwoHundredZeros}.0.0-alpha.${twoHundredNines}`)

  assert.equal(parsed.major, oneFollowedByTwoHundredZeros)
  assert.deepEqual(parsed.prerelease, ['alpha', twoHundredNines])
  assert.equal(
    compareSemver(`${oneFollowedByTwoHundredZeros}.0.0`, `${twoHundredNines}.999.999`),
    1,
  )
  assert.equal(
    compareSemver(`1.0.0-alpha.${twoHundredNines}`, `1.0.0-alpha.${oneFollowedByTwoHundredZeros}`),
    -1,
  )
  assert.equal(compareSemver('9007199254740993.0.0', '9007199254740992.999.999'), 1)
})

test('manifest canonical bytes round-trip with exact top-level and file schemas', () => {
  const manifest = makeManifest()
  const bytes = canonicalizeUpdateManifest(manifest)
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(manifest), 'utf8'))
  assert.deepEqual(parseUpdateManifest(bytes), manifest)
  assert.equal(Object.isFrozen(parseUpdateManifest(bytes)), true)
  assert.equal(Object.isFrozen(parseUpdateManifest(bytes).files), true)
})

test('manifest rejects non-canonical JSON bytes even when the JSON value is equivalent', () => {
  const manifest = makeManifest()
  const pretty = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  const reordered = Buffer.from(JSON.stringify({
    appId: manifest.appId,
    schemaVersion: manifest.schemaVersion,
    ...Object.fromEntries(Object.entries(manifest).slice(2)),
  }), 'utf8')

  assert.throws(() => parseUpdateManifest(pretty), /canonical/i)
  assert.throws(() => parseUpdateManifest(reordered), /canonical/i)
  assert.throws(() => parseUpdateManifest(Buffer.concat([
    canonicalizeUpdateManifest(manifest),
    Buffer.from('\n'),
  ])), /canonical/i)
})

test('manifest rejects missing, unknown, and nested unknown fields', () => {
  const { channel: _channel, ...missing } = makeManifest()
  const withUnknown = makeManifest({ downloadUrl: 'https://example.test/update.zip' })
  const withNestedUnknown = makeManifest({
    files: [{
      ...makeManifest().files[0],
      mode: '0755',
    }],
  })

  assert.throws(() => canonicalizeUpdateManifest(missing), /field/i)
  assert.throws(() => canonicalizeUpdateManifest(withUnknown), /field/i)
  assert.throws(() => canonicalizeUpdateManifest(withNestedUnknown), /field/i)
})

test('manifest rejects malformed identity, version, tag, key id, timestamp, asset size, and asset hash', () => {
  const invalidManifests = [
    makeManifest({ schemaVersion: 2 }),
    makeManifest({ appId: '' }),
    makeManifest({ channel: 'Private Beta' }),
    makeManifest({ packageType: 'installer' }),
    makeManifest({ version: '0.1' }),
    makeManifest({ minUpdaterVersion: '0.01.0' }),
    makeManifest({ releaseTag: '0.1.1' }),
    makeManifest({ signingKeyId: '../private-key' }),
    makeManifest({ createdAt: '2026-07-13' }),
    makeManifest({ assetSize: 0 }),
    makeManifest({ assetSize: '4096' }),
    makeManifest({ assetSha256: 'a'.repeat(63) }),
    makeManifest({ assetSha256: 'A'.repeat(64) }),
  ]

  for (const manifest of invalidManifests) {
    assert.throws(() => canonicalizeUpdateManifest(manifest))
  }
})

test('manifest file list rejects unsafe paths, invalid sizes and hashes, duplicates, and unsorted entries', () => {
  const baseFile = makeManifest().files[0]
  const invalidFiles = [
    [{ ...baseFile, path: '../app/package.json' }],
    [{ ...baseFile, path: 'C:/app/package.json' }],
    [{ ...baseFile, path: 'app\\package.json' }],
    [{ ...baseFile, size: -1 }],
    [{ ...baseFile, size: 1.5 }],
    [{ ...baseFile, sha256: 'not-a-sha256' }],
    [baseFile, { ...baseFile, path: 'APP/package.json' }],
    [
      { ...baseFile, path: 'app/z.mjs' },
      { ...baseFile, path: 'app/a.mjs' },
    ],
  ]

  for (const files of invalidFiles) {
    assert.throws(() => canonicalizeUpdateManifest(makeManifest({ files })))
  }
})
