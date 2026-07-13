import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { openPromise as openZip } from 'yauzl'
import { normalizeFullyQualifiedWindowsPath } from '../runtime/portable-paths.mjs'

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathLength: 1024,
})

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const WINDOWS_DEVICES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

function codedError(code) {
  return new Error(code)
}

function isKnownError(error) {
  return error instanceof Error && error.message.startsWith('update-')
}

function normalizeLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw codedError('update-zip-limits-invalid')
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw codedError('update-zip-limits-invalid')
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw codedError(`update-zip-${key}-invalid`)
  }
  return limits
}

function validateArchivePath(value, { directory = false, maxPathLength }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxPathLength || value.includes('\\')) {
    throw codedError('update-zip-path-invalid')
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || isAbsolute(value)) {
    throw codedError('update-zip-path-invalid')
  }
  if (directory !== value.endsWith('/')) throw codedError('update-zip-path-invalid')
  const normalized = directory ? value.slice(0, -1) : value
  if (!normalized) throw codedError('update-zip-path-invalid')
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (
      !segment
      || segment === '.'
      || segment === '..'
      || /[ .]$/.test(segment)
      || /[\u0000-\u001f\u007f<>:"|?*]/u.test(segment)
    ) {
      throw codedError('update-zip-path-invalid')
    }
    const deviceBase = segment.split('.')[0].replace(/[ .]+$/u, '').toUpperCase()
      .replaceAll('¹', '1').replaceAll('²', '2').replaceAll('³', '3')
    if (WINDOWS_DEVICES.has(deviceBase)) throw codedError('update-zip-path-invalid')
  }
  return {
    path: normalized,
    canonical: segments.map((segment) => segment.normalize('NFC').toLowerCase()).join('/'),
  }
}

function assertWithin(root, candidate, code, { allowRoot = false } = {}) {
  const fromRoot = relative(root, candidate)
  if ((!fromRoot && !allowRoot) || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw codedError(code)
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function collectEntries(zipFile, maxEntries) {
  return new Promise((resolveEntries, reject) => {
    const entries = []
    let settled = false
    const onEntry = (entry) => {
      if (entries.length >= maxEntries) {
        settled = true
        cleanup()
        try { zipFile.close() } catch {}
        reject(codedError('update-zip-entry-limit'))
        return
      }
      entries.push(entry)
      zipFile.readEntry()
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolveEntries(entries)
    }
    const onError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (/invalid characters in fileName|absolute path|relative path/i.test(error?.message ?? '')) {
        reject(codedError('update-zip-path-invalid'))
      } else {
        reject(codedError('update-zip-invalid'))
      }
    }
    const cleanup = () => {
      zipFile.off('entry', onEntry)
      zipFile.off('end', onEnd)
      zipFile.off('error', onError)
    }
    zipFile.on('entry', onEntry)
    zipFile.once('end', onEnd)
    zipFile.once('error', onError)
    zipFile.readEntry()
  })
}

function validateEntryType(entry, directory) {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw codedError('update-zip-encryption-not-allowed')
  const attributes = entry.externalFileAttributes >>> 0
  const unixMode = attributes >>> 16
  const fileType = unixMode & 0o170000
  const dosAttributes = attributes & 0xffff
  if (fileType === 0o120000 || (dosAttributes & 0x400) !== 0 || (attributes & 0x04000000) !== 0) {
    throw codedError('update-zip-link-not-allowed')
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw codedError('update-zip-link-not-allowed')
  }
  if (directory && fileType === 0o100000) throw codedError('update-zip-entry-type-invalid')
  if (!directory && (fileType === 0o040000 || (dosAttributes & 0x10) !== 0)) {
    throw codedError('update-zip-entry-type-invalid')
  }
}

function validateZipEntries(entries, limits) {
  if (entries.length > limits.maxEntries) throw codedError('update-zip-entry-limit')
  const canonicalEntries = new Map()
  const result = []
  let totalSize = 0

  for (const entry of entries) {
    const directory = entry.fileName.endsWith('/')
    const pathInfo = validateArchivePath(entry.fileName, { directory, maxPathLength: limits.maxPathLength })
    validateEntryType(entry, directory)
    if (canonicalEntries.has(pathInfo.canonical)) throw codedError('update-zip-entry-conflict')
    canonicalEntries.set(pathInfo.canonical, { directory, path: pathInfo.path })

    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
      throw codedError('update-zip-entry-size-invalid')
    }
    if (!directory) {
      if (entry.uncompressedSize > limits.maxFileBytes) throw codedError('update-zip-file-size-limit')
      totalSize += entry.uncompressedSize
      if (!Number.isSafeInteger(totalSize) || totalSize > limits.maxTotalBytes) {
        throw codedError('update-zip-total-size-limit')
      }
      const ratio = entry.uncompressedSize === 0 ? 0 : entry.uncompressedSize / Math.max(1, entry.compressedSize)
      if (ratio > limits.maxCompressionRatio) throw codedError('update-zip-compression-ratio-limit')
    }
    result.push({ entry, directory, ...pathInfo })
  }

  for (const current of result) {
    const segments = current.canonical.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = canonicalEntries.get(segments.slice(0, index).join('/'))
      if (ancestor && !ancestor.directory) throw codedError('update-zip-entry-conflict')
    }
  }
  return { entries: result, totalSize }
}

function validateManifestFiles(files, limits) {
  if (!Array.isArray(files) || files.length === 0) throw codedError('update-zip-manifest-invalid')
  const exact = new Map()
  const canonical = new Set()
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw codedError('update-zip-manifest-invalid')
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw codedError('update-zip-manifest-invalid')
    }
    if (file.size > limits.maxFileBytes) throw codedError('update-zip-file-size-limit')
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw codedError('update-zip-manifest-invalid')
    }
    const pathInfo = validateArchivePath(file.path, { directory: false, maxPathLength: limits.maxPathLength })
    if (exact.has(pathInfo.path) || canonical.has(pathInfo.canonical)) throw codedError('update-zip-manifest-invalid')
    exact.set(pathInfo.path, { size: file.size, sha256: file.sha256.toLowerCase() })
    canonical.add(pathInfo.canonical)
  }
  return exact
}

async function writeEntry(zipFile, archiveEntry, manifest, stagingRoot) {
  const targetPath = resolve(stagingRoot, ...archiveEntry.path.split('/'))
  assertWithin(stagingRoot, targetPath, 'update-zip-staging-escape')
  await mkdir(dirname(targetPath), { recursive: true })
  const actualParent = await realpath(dirname(targetPath))
  assertWithin(stagingRoot, actualParent, 'update-zip-staging-escape', { allowRoot: true })
  const stream = await zipFile.openReadStreamPromise(archiveEntry.entry)
  const handle = await open(targetPath, 'wx')
  const hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      size += bytes.byteLength
      if (size > manifest.size) throw codedError('update-zip-file-size-mismatch')
      let offset = 0
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, size - bytes.byteLength + offset)
        if (bytesWritten <= 0) throw codedError('update-zip-write-failed')
        offset += bytesWritten
      }
      hash.update(bytes)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (size !== manifest.size) throw codedError('update-zip-file-size-mismatch')
  if (hash.digest('hex') !== manifest.sha256) throw codedError('update-zip-file-sha256-mismatch')
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

async function verifyManifestFile(filePath, manifest) {
  let handle
  try {
    const beforePath = await lstat(filePath, { bigint: true })
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw codedError('update-zip-published-mismatch')
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const beforeHandle = await handle.stat({ bigint: true })
    if (!sameFileIdentity(beforePath, beforeHandle)) throw codedError('update-zip-published-mismatch')

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size)
      if (bytesRead === 0) break
      size += bytesRead
      if (size > manifest.size) throw codedError('update-zip-published-mismatch')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const afterHandle = await handle.stat({ bigint: true })
    await handle.close()
    handle = undefined
    const afterPath = await lstat(filePath, { bigint: true })
    if (
      !sameFileIdentity(beforeHandle, afterHandle)
      || !sameFileIdentity(afterHandle, afterPath)
      || size !== manifest.size
      || hash.digest('hex') !== manifest.sha256
    ) {
      throw codedError('update-zip-published-mismatch')
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (error?.message === 'update-zip-published-mismatch') throw error
    throw codedError('update-zip-published-mismatch')
  }
}

async function verifyManifestTree(root, manifestFiles) {
  const allowedDirectories = new Set()
  for (const manifestPath of manifestFiles.keys()) {
    const segments = manifestPath.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      allowedDirectories.add(segments.slice(0, index).join('/'))
    }
  }
  const seen = new Set()
  const walk = async (directory, relativeDirectory = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name)
      assertWithin(root, child, 'update-zip-published-mismatch')
      const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const childStat = await lstat(child)
      if (childStat.isSymbolicLink()) throw codedError('update-zip-published-mismatch')
      if (childStat.isDirectory()) {
        if (!allowedDirectories.has(childRelative)) throw codedError('update-zip-published-mismatch')
        const actual = await realpath(child)
        assertWithin(root, actual, 'update-zip-published-mismatch')
        await walk(child, childRelative)
        continue
      }
      if (!childStat.isFile() || !manifestFiles.has(childRelative) || seen.has(childRelative)) {
        throw codedError('update-zip-published-mismatch')
      }
      await verifyManifestFile(child, manifestFiles.get(childRelative))
      seen.add(childRelative)
    }
  }
  try {
    const actualRoot = await realpath(root)
    if (relative(root, actualRoot) !== '') {
      throw codedError('update-zip-published-mismatch')
    }
    await walk(root)
    if (seen.size !== manifestFiles.size) throw codedError('update-zip-published-mismatch')
  } catch (error) {
    if (error?.message === 'update-zip-published-mismatch') throw error
    throw codedError('update-zip-published-mismatch')
  }
}

export async function stageVerifiedZip({ zipPath, versionsDir, version, files, limits: limitOverrides } = {}) {
  let normalizedZipPath
  let normalizedVersionsDir
  try {
    normalizedZipPath = normalizeFullyQualifiedWindowsPath(zipPath, 'update-zip-path-required')
  } catch {
    throw codedError('update-zip-path-required')
  }
  try {
    normalizedVersionsDir = normalizeFullyQualifiedWindowsPath(versionsDir, 'update-versions-path-required')
  } catch {
    throw codedError('update-versions-path-required')
  }
  if (typeof version !== 'string' || !SEMVER.test(version)) throw codedError('update-version-path-invalid')
  const limits = normalizeLimits(limitOverrides)
  const manifestFiles = validateManifestFiles(files, limits)

  await mkdir(normalizedVersionsDir, { recursive: true })
  const versionsRoot = await realpath(normalizedVersionsDir)
  const stagingPath = resolve(versionsRoot, `${version}.staging`)
  const versionPath = resolve(versionsRoot, version)
  assertWithin(versionsRoot, stagingPath, 'update-zip-staging-escape')
  assertWithin(versionsRoot, versionPath, 'update-zip-staging-escape')
  if (await pathExists(versionPath)) throw codedError('update-version-destination-exists')
  if (await pathExists(stagingPath)) throw codedError('update-version-staging-exists')

  let zipFile
  let published = false
  try {
    zipFile = await openZip(normalizedZipPath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    })
    const rawEntries = await collectEntries(zipFile, limits.maxEntries)
    const validated = validateZipEntries(rawEntries, limits)
    const archiveFiles = validated.entries.filter((entry) => !entry.directory)
    const archivePaths = new Set(archiveFiles.map((entry) => entry.path))

    for (const archiveFile of archiveFiles) {
      const manifest = manifestFiles.get(archiveFile.path)
      if (!manifest) throw codedError('update-zip-manifest-extra-file')
      if (archiveFile.entry.uncompressedSize !== manifest.size) throw codedError('update-zip-file-size-mismatch')
    }
    for (const manifestPath of manifestFiles.keys()) {
      if (!archivePaths.has(manifestPath)) throw codedError('update-zip-manifest-missing-file')
    }

    await mkdir(stagingPath)
    const actualStaging = await realpath(stagingPath)
    if (actualStaging !== stagingPath) throw codedError('update-zip-staging-escape')
    for (const directory of validated.entries.filter((entry) => entry.directory)) {
      const directoryPath = resolve(stagingPath, ...directory.path.split('/'))
      assertWithin(stagingPath, directoryPath, 'update-zip-staging-escape')
      await mkdir(directoryPath, { recursive: true })
      const actualDirectory = await realpath(directoryPath)
      assertWithin(stagingPath, actualDirectory, 'update-zip-staging-escape')
    }
    for (const archiveFile of archiveFiles) {
      await writeEntry(zipFile, archiveFile, manifestFiles.get(archiveFile.path), stagingPath)
    }
    await verifyManifestTree(stagingPath, manifestFiles)
    if (await pathExists(versionPath)) throw codedError('update-version-destination-exists')
    await rename(stagingPath, versionPath)
    published = true
    await verifyManifestTree(versionPath, manifestFiles)
    return { versionDir: versionPath, fileCount: archiveFiles.length, totalSize: validated.totalSize }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
    if (published) await rm(versionPath, { recursive: true, force: true }).catch(() => {})
    if (isKnownError(error)) throw error
    throw codedError('update-zip-extract-failed')
  } finally {
    zipFile?.close()
  }
}

export { DEFAULT_LIMITS }
