import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { DEFAULT_ALLOWED_HOSTS, fetchHttpsWithRedirects } from './github-release-client.mjs'
import { normalizeFullyQualifiedWindowsPath } from '../runtime/portable-paths.mjs'

function codedError(code) {
  return new Error(code)
}

function isKnownError(error) {
  return error instanceof Error && /^(github-release|update-asset)-/.test(error.message)
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

async function writeChunk(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (bytesWritten <= 0) throw codedError('update-asset-write-failed')
    offset += bytesWritten
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
}

function identityOf(metadata) {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino })
}

async function verifyPublishedFile(path, expectedSize, expectedSha256) {
  let handle
  try {
    const beforePath = await lstat(path, { bigint: true })
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw codedError('update-asset-published-mismatch')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const beforeHandle = await handle.stat({ bigint: true })
    if (!sameFileIdentity(beforePath, beforeHandle)) throw codedError('update-asset-published-mismatch')

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size)
      if (bytesRead === 0) break
      size += bytesRead
      if (size > expectedSize) throw codedError('update-asset-published-mismatch')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const afterHandle = await handle.stat({ bigint: true })
    await handle.close()
    handle = undefined
    const afterPath = await lstat(path, { bigint: true })
    if (
      !sameFileIdentity(beforeHandle, afterHandle)
      || !sameFileIdentity(afterHandle, afterPath)
      || size !== expectedSize
      || hash.digest('hex') !== expectedSha256
    ) {
      throw codedError('update-asset-published-mismatch')
    }
    return identityOf(afterHandle)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (error?.message === 'update-asset-published-mismatch') throw error
    throw codedError('update-asset-published-mismatch')
  }
}

export async function downloadAsset({
  url,
  destinationPath,
  expectedSize,
  expectedSha256,
  maxBytes = expectedSize,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
  maxRedirects = 5,
} = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw codedError('update-asset-size-invalid')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < expectedSize || maxBytes < 0) throw codedError('update-asset-limit-invalid')
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw codedError('update-asset-sha256-invalid')
  }
  let finalPath
  try {
    finalPath = normalizeFullyQualifiedWindowsPath(destinationPath, 'update-asset-destination-invalid')
  } catch {
    throw codedError('update-asset-destination-invalid')
  }
  if (await pathExists(finalPath)) throw codedError('update-asset-destination-exists')
  await mkdir(dirname(finalPath), { recursive: true })
  const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.partial`)
  let handle
  let request

  try {
    request = await fetchHttpsWithRedirects({ url, allowedHosts, fetchImpl, timeoutMs, maxRedirects })
    const { response } = request
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const parsed = Number(contentLength)
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw codedError('update-asset-content-length-invalid')
      if (parsed > maxBytes || parsed > expectedSize) throw codedError('update-asset-too-large')
    }
    if (!response.body) throw codedError('update-asset-download-failed')

    handle = await open(temporaryPath, 'wx')
    const hash = createHash('sha256')
    let size = 0
    try {
      for await (const chunk of response.body) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        if (size + bytes.byteLength > maxBytes || size + bytes.byteLength > expectedSize) {
          throw codedError('update-asset-too-large')
        }
        await writeChunk(handle, bytes, size)
        hash.update(bytes)
        size += bytes.byteLength
      }
    } catch (error) {
      if (request.signal.aborted) throw codedError('update-asset-timeout')
      if (isKnownError(error)) throw error
      throw codedError('update-asset-download-failed')
    }
    await handle.sync()
    await handle.close()
    handle = undefined

    if (size !== expectedSize) throw codedError('update-asset-size-mismatch')
    const digest = hash.digest('hex')
    if (digest !== expectedSha256.toLowerCase()) throw codedError('update-asset-sha256-mismatch')
    if (await pathExists(finalPath)) throw codedError('update-asset-destination-exists')
    await rename(temporaryPath, finalPath)
    const publishedIdentity = await verifyPublishedFile(finalPath, expectedSize, expectedSha256.toLowerCase())
    return { path: finalPath, size, sha256: digest, publishedIdentity }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    if (isKnownError(error)) throw error
    throw codedError('update-asset-download-failed')
  } finally {
    await request?.dispose()
  }
}
