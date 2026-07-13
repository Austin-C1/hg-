import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { open, lstat, rename, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { RELEASE_CONFIG } from '../src/crown/update/release-config.mjs'
import { createUpdateFileListFromZip } from '../src/crown/update/safe-extract.mjs'
import { canonicalizeUpdateManifest, parseUpdateManifest } from '../src/crown/update/update-manifest.mjs'

function codedError(code) {
  return new Error(code)
}

function sameStableFile(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink)
}

async function digestStableFile(path) {
  let handle
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw codedError('update-manifest-asset-invalid')
    handle = await open(path, 'r')
    const opened = await handle.stat({ bigint: true })
    if (!sameStableFile(before, opened)) throw codedError('update-manifest-asset-changed')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size)
      if (bytesRead === 0) break
      size += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    const afterHandle = await handle.stat({ bigint: true })
    const afterPath = await lstat(path, { bigint: true })
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(afterHandle, afterPath)
      || BigInt(size) !== afterPath.size) throw codedError('update-manifest-asset-changed')
    return Object.freeze({ metadata: afterPath, size, sha256: hash.digest('hex') })
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeExclusiveAtomic(path, bytes) {
  const output = resolve(path)
  const temporary = resolve(dirname(output), `.${basename(output)}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`)
  let handle
  try {
    try { await lstat(output); throw codedError('update-manifest-output-exists') } catch (error) {
      if (error?.message === 'update-manifest-output-exists') throw error
      if (error?.code !== 'ENOENT') throw codedError('update-manifest-output-invalid')
    }
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    try { await lstat(output); throw codedError('update-manifest-output-exists') } catch (error) {
      if (error?.message === 'update-manifest-output-exists') throw error
      if (error?.code !== 'ENOENT') throw codedError('update-manifest-output-invalid')
    }
    await rename(temporary, output)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function createUpdateManifest({
  assetPath,
  manifestPath,
  version,
  signingKeyId,
  createdAt,
  minUpdaterVersion = RELEASE_CONFIG.updaterVersion,
  createFiles = createUpdateFileListFromZip,
} = {}) {
  if (![assetPath, manifestPath, version, signingKeyId, createdAt, minUpdaterVersion]
    .every((value) => typeof value === 'string' && value.length > 0)) throw codedError('update-manifest-arguments-invalid')
  const asset = resolve(assetPath)
  const output = resolve(manifestPath)
  if (asset === output) throw codedError('update-manifest-output-invalid')
  const before = await digestStableFile(asset)
  const files = await createFiles({ zipPath: asset })
  const after = await lstat(asset, { bigint: true }).catch(() => null)
  if (!sameStableFile(before.metadata, after)) throw codedError('update-manifest-asset-changed')
  const bytes = canonicalizeUpdateManifest({
    schemaVersion: 1,
    appId: RELEASE_CONFIG.appId,
    channel: RELEASE_CONFIG.channel,
    packageType: RELEASE_CONFIG.packageType,
    version,
    minUpdaterVersion,
    releaseTag: `v${version}`,
    signingKeyId,
    assetName: basename(asset),
    assetSize: before.size,
    assetSha256: before.sha256,
    createdAt,
    files,
  })
  parseUpdateManifest(bytes)
  await writeExclusiveAtomic(output, bytes)
  return Object.freeze({ manifestPath: output, bytes, assetSize: before.size, assetSha256: before.sha256, fileCount: files.length })
}

function parseArguments(argv) {
  const accepted = new Set(['--asset', '--manifest', '--version', '--signing-key-id', '--created-at', '--min-updater-version'])
  const values = Object.create(null)
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!accepted.has(flag) || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(values, flag)) {
      throw codedError('update-manifest-arguments-invalid')
    }
    values[flag] = value
  }
  return {
    assetPath: values['--asset'],
    manifestPath: values['--manifest'],
    version: values['--version'],
    signingKeyId: values['--signing-key-id'],
    createdAt: values['--created-at'],
    minUpdaterVersion: values['--min-updater-version'] ?? RELEASE_CONFIG.updaterVersion,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  try {
    const result = await createUpdateManifest(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, bytes: undefined })}\n`)
  } catch (error) {
    process.stderr.write(`${error?.message ?? 'update-manifest-failed'}\n`)
    process.exitCode = 1
  }
}
