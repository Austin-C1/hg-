import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'

import { createUpdateManifest } from '../scripts/create-update-manifest.mjs'
import { createUpdateFileListFromZip } from '../src/crown/update/safe-extract.mjs'
import { parseUpdateManifest } from '../src/crown/update/update-manifest.mjs'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]
  return (value ^ 0xffffffff) >>> 0
}

function zipBuffer(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const source of entries) {
    const name = Buffer.from(source.name)
    const data = Buffer.from(source.data ?? '')
    const method = source.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(source.versionMadeBy ?? 0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((source.externalAttributes ?? (0o100644 << 16)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

test('release manifest is derived from the exact final ZIP with canonical sorted file hashes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-manifest-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assetPath = join(root, 'CrownMonitor-v0.2.0-update.zip')
  const manifestPath = join(root, 'update-manifest.json')
  const zip = zipBuffer([
    { name: 'versions/0.2.0/app/z.txt', data: 'last', method: 8 },
    { name: 'versions/0.2.0/app/a.txt', data: 'first' },
  ])
  await writeFile(assetPath, zip)

  const result = await createUpdateManifest({
    assetPath,
    manifestPath,
    version: '0.2.0',
    signingKeyId: 'release-2026-01',
    createdAt: '2026-07-13T12:00:00.000Z',
  })
  const bytes = await readFile(manifestPath)
  const manifest = parseUpdateManifest(bytes)
  assert.equal(result.assetSize, zip.length)
  assert.equal(result.assetSha256, createHash('sha256').update(zip).digest('hex'))
  assert.equal(manifest.assetName, 'CrownMonitor-v0.2.0-update.zip')
  assert.deepEqual(manifest.files.map((file) => file.path), [
    'versions/0.2.0/app/a.txt',
    'versions/0.2.0/app/z.txt',
  ])
  assert.equal(manifest.files[0].sha256, createHash('sha256').update('first').digest('hex'))
  assert.equal(bytes.equals(Buffer.from(JSON.stringify(manifest), 'utf8')), true)
  await assert.rejects(createUpdateManifest({
    assetPath, manifestPath, version: '0.2.0', signingKeyId: 'release-2026-01', createdAt: '2026-07-13T12:00:00.000Z',
  }), /update-manifest-output-exists/)
})

test('ZIP inspection rejects unsafe archive paths and asset replacement during manifest generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-manifest-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const unsafePath = join(root, 'unsafe.zip')
  await writeFile(unsafePath, zipBuffer([{ name: '../escape.txt', data: 'bad' }]))
  await assert.rejects(createUpdateFileListFromZip({ zipPath: unsafePath }), /update-zip-path-invalid/)

  const assetPath = join(root, 'CrownMonitor-v0.2.0-update.zip')
  const originalAway = join(root, 'original.zip')
  await writeFile(assetPath, zipBuffer([{ name: 'app/main.mjs', data: 'owned' }]))
  await assert.rejects(createUpdateManifest({
    assetPath,
    manifestPath: join(root, 'update-manifest.json'),
    version: '0.2.0',
    signingKeyId: 'release-2026-01',
    createdAt: '2026-07-13T12:00:00.000Z',
    createFiles: async () => {
      await rename(assetPath, originalAway)
      await writeFile(assetPath, zipBuffer([{ name: 'app/main.mjs', data: 'replacement' }]))
      return [{ path: 'app/main.mjs', size: 5, sha256: createHash('sha256').update('owned').digest('hex') }]
    },
  }), /update-manifest-asset-changed/)
})
