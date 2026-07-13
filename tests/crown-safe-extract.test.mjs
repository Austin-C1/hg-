import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'

import { stageVerifiedZip } from '../src/crown/update/safe-extract.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

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

function manifestFile(path, data) {
  const bytes = Buffer.from(data)
  return { path, size: bytes.length, sha256: sha256(bytes) }
}

async function writeZip(root, entries, name = 'update.zip') {
  const path = join(root, name)
  await writeFile(path, zipBuffer(entries))
  return path
}

test('safe extraction validates all metadata and hashes before atomically publishing a version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const versionsDir = join(root, 'versions')
  const zipPath = await writeZip(root, [
    { name: 'app/', data: '', externalAttributes: (0o040755 << 16) | 0x10 },
    { name: 'app/main.mjs', data: 'export const ok = true\n', method: 8 },
    { name: 'app/empty.txt', data: '' },
    { name: 'version.txt', data: '0.1.1\n' },
  ])
  const files = [
    manifestFile('app/main.mjs', 'export const ok = true\n'),
    manifestFile('app/empty.txt', ''),
    manifestFile('version.txt', '0.1.1\n'),
  ]

  const result = await stageVerifiedZip({ zipPath, versionsDir, version: '0.1.1', files })

  assert.equal(await readFile(join(versionsDir, '0.1.1', 'app', 'main.mjs'), 'utf8'), 'export const ok = true\n')
  assert.equal(await readFile(join(versionsDir, '0.1.1', 'version.txt'), 'utf8'), '0.1.1\n')
  const published = await lstat(join(versionsDir, '0.1.1'), { bigint: true })
  assert.deepEqual(result, {
    versionDir: join(versionsDir, '0.1.1'),
    fileCount: 3,
    totalSize: files[0].size + files[2].size,
    publishedIdentity: { dev: published.dev, ino: published.ino },
  })
  assert.deepEqual(await readdir(versionsDir), ['0.1.1'])
})

test('safe extraction rejects traversal, absolute, drive, ADS, device, trailing, and control paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const attacks = [
    '../escape.txt',
    'app/../../escape.txt',
    '/absolute.txt',
    '\\absolute.txt',
    'C:/drive.txt',
    'app/file.txt:stream',
    'app/CON',
    'app/aux.txt',
    'app/COM1.txt',
    'app/LPT9',
    'app/COM¹.log',
    'app/LPT³.txt',
    'app/CON .txt',
    'app/COM1 .log',
    'app/name.',
    'app/name ',
    'app/control\u0001.txt',
  ]

  for (const [index, name] of attacks.entries()) {
    const zipPath = await writeZip(root, [{ name, data: 'x' }], `attack-${index}.zip`)
    await assert.rejects(stageVerifiedZip({
      zipPath,
      versionsDir: join(root, `versions-${index}`),
      version: '0.1.1',
      files: [manifestFile(name, 'x')],
    }), /update-zip-path-invalid|invalid relative path/)
  }
})

test('safe extraction rejects symlink, reparse, duplicate, case, and directory-file conflicts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cases = [
    { entries: [{ name: 'app/link', data: '../outside', externalAttributes: 0o120777 << 16 }], error: /update-zip-link-not-allowed/ },
    { entries: [{ name: 'app/reparse', data: 'x', externalAttributes: (0o100644 << 16) | 0x400 }], error: /update-zip-link-not-allowed/ },
    { entries: [{ name: 'app/reparse-shifted', data: 'x', externalAttributes: (0o100644 << 16) | 0x04000000 }], error: /update-zip-link-not-allowed/ },
    { entries: [{ name: 'app/a.txt', data: 'x' }, { name: 'app/a.txt', data: 'x' }], error: /update-zip-entry-conflict/ },
    { entries: [{ name: 'app/A.txt', data: 'x' }, { name: 'app/a.txt', data: 'x' }], error: /update-zip-entry-conflict/ },
    { entries: [{ name: 'app/item/', data: '', externalAttributes: (0o040755 << 16) | 0x10 }, { name: 'app/item', data: 'x' }], error: /update-zip-entry-conflict/ },
  ]

  for (const [index, current] of cases.entries()) {
    const zipPath = await writeZip(root, current.entries, `metadata-${index}.zip`)
    const manifestEntry = current.entries.find((entry) => !entry.name.endsWith('/'))
    await assert.rejects(stageVerifiedZip({
      zipPath,
      versionsDir: join(root, `versions-${index}`),
      version: '0.1.1',
      files: [manifestFile(manifestEntry.name, manifestEntry.data)],
    }), current.error)
  }
})

test('safe extraction enforces entry, per-file, total-size, and compression-ratio limits before writing staging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const smallEntries = [{ name: 'app/a', data: '12' }, { name: 'app/b', data: '34' }]
  const smallZip = await writeZip(root, smallEntries, 'small.zip')
  const smallFiles = smallEntries.map((entry) => manifestFile(entry.name, entry.data))

  await assert.rejects(stageVerifiedZip({ zipPath: smallZip, versionsDir: join(root, 'count'), version: '1.0.0', files: smallFiles, limits: { maxEntries: 1 } }), /update-zip-entry-limit/)
  await assert.rejects(stageVerifiedZip({ zipPath: smallZip, versionsDir: join(root, 'file'), version: '1.0.0', files: smallFiles, limits: { maxFileBytes: 1 } }), /update-zip-file-size-limit/)
  await assert.rejects(stageVerifiedZip({ zipPath: smallZip, versionsDir: join(root, 'total'), version: '1.0.0', files: smallFiles, limits: { maxTotalBytes: 3 } }), /update-zip-total-size-limit/)

  const bombData = '0'.repeat(10_000)
  const bombZip = await writeZip(root, [{ name: 'app/bomb', data: bombData, method: 8 }], 'bomb.zip')
  await assert.rejects(stageVerifiedZip({
    zipPath: bombZip,
    versionsDir: join(root, 'ratio'),
    version: '1.0.0',
    files: [manifestFile('app/bomb', bombData)],
    limits: { maxCompressionRatio: 2 },
  }), /update-zip-compression-ratio-limit/)
  assert.equal(await readdir(root).then((names) => names.some((name) => name.endsWith('.staging'))), false)
})

test('safe extraction requires an exact manifest with matching size and sha256', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entries = [{ name: 'app/a.txt', data: 'A' }, { name: 'app/b.txt', data: 'B' }]
  const zipPath = await writeZip(root, entries)

  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir: join(root, 'extra'), version: '1.0.0', files: [manifestFile('app/a.txt', 'A')] }), /update-zip-manifest-extra-file/)
  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir: join(root, 'missing'), version: '1.0.0', files: [...entries.map((entry) => manifestFile(entry.name, entry.data)), manifestFile('app/c.txt', 'C')] }), /update-zip-manifest-missing-file/)
  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir: join(root, 'size'), version: '1.0.0', files: [{ ...manifestFile('app/a.txt', 'A'), size: 2 }, manifestFile('app/b.txt', 'B')] }), /update-zip-file-size-mismatch/)
  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir: join(root, 'hash'), version: '1.0.0', files: [{ ...manifestFile('app/a.txt', 'A'), sha256: '0'.repeat(64) }, manifestFile('app/b.txt', 'B')] }), /update-zip-file-sha256-mismatch/)
})

test('safe extraction rejects staging escapes and refuses existing staging or final directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const zipPath = await writeZip(root, [{ name: 'app/a.txt', data: 'A' }])
  const files = [manifestFile('app/a.txt', 'A')]

  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir: join(root, 'versions'), version: '../escape', files }), /update-version-path-invalid/)

  const versionsDir = join(root, 'occupied')
  await writeFile(join(root, 'placeholder'), '')
  await stageVerifiedZip({ zipPath, versionsDir, version: '1.0.0', files })
  await assert.rejects(stageVerifiedZip({ zipPath, versionsDir, version: '1.0.0', files }), /update-version-destination-exists/)
})

test('safe extraction rejects Windows root-relative, drive-relative, and device namespace roots', async () => {
  const files = [manifestFile('app/a.txt', 'A')]
  for (const value of ['\\root-relative', '/root-relative', 'C:drive-relative', '\\\\?\\C:\\device', '\\\\.\\C:\\device']) {
    await assert.rejects(stageVerifiedZip({
      zipPath: value,
      versionsDir: 'C:\\fully-qualified\\versions',
      version: '1.0.0',
      files,
    }), /update-zip-path-required/)
    await assert.rejects(stageVerifiedZip({
      zipPath: 'C:\\fully-qualified\\update.zip',
      versionsDir: value,
      version: '1.0.0',
      files,
    }), /update-versions-path-required/)
  }
})

test('safe extraction revalidates staging content and rejects a replaced extracted pathname', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-safe-extract-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = Buffer.alloc(8 * 1024 * 1024, 0x61)
  const zipPath = await writeZip(root, [{ name: 'app/payload.bin', data }])
  const versionsDir = join(root, 'versions')
  const target = join(versionsDir, '1.0.0.staging', 'app', 'payload.bin')
  const staging = stageVerifiedZip({
    zipPath,
    versionsDir,
    version: '1.0.0',
    files: [manifestFile('app/payload.bin', data)],
  })

  let replaced = false
  for (let attempt = 0; attempt < 5_000 && !replaced; attempt += 1) {
    try {
      await lstat(target)
      await rm(target, { force: true })
      await writeFile(target, 'ATTACKER')
      replaced = true
    } catch (error) {
      if (!['ENOENT', 'EPERM'].includes(error?.code)) throw error
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  assert.equal(replaced, true, 'staging file should become visible before publication')
  await assert.rejects(staging, /update-zip-published-mismatch/)
  assert.deepEqual(await readdir(versionsDir), [])
})
