import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
  ensureDataDirectory,
  openVerifiedDataFile,
  sameFileIdentity,
  syncDataDirectory,
  syncPublishedDataFile,
  validateDataPath,
} from './safe-data-path.mjs'

const MAX_JSON_BYTES = 1024 * 1024

function codedError(code) {
  return new Error(code)
}

function known(error) {
  return error instanceof Error && error.message.startsWith('atomic-json-')
}

async function atomicPath({ dataRoot, filePath, requireExists = false } = {}) {
  if (typeof dataRoot !== 'string') throw codedError('atomic-json-data-root-invalid')
  try {
    return await validateDataPath({
      dataRoot,
      targetPath: filePath,
      requireExists,
      expectDirectory: requireExists ? false : undefined,
    })
  } catch {
    throw codedError('atomic-json-path-invalid')
  }
}

export async function syncDirectory({ dataRoot, directoryPath } = {}) {
  if (typeof dataRoot !== 'string') throw codedError('atomic-json-data-root-invalid')
  try {
    return await syncDataDirectory({ dataRoot, directoryPath })
  } catch {
    throw codedError('atomic-json-directory-sync-failed')
  }
}

export async function writeAtomicJson({ dataRoot, filePath, value } = {}) {
  const target = await atomicPath({ dataRoot, filePath })
  let encoded
  try {
    encoded = `${JSON.stringify(value)}\n`
  } catch {
    throw codedError('atomic-json-value-invalid')
  }
  if (encoded === 'undefined\n' || Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
    throw codedError('atomic-json-value-invalid')
  }

  const parent = dirname(target.path)
  try {
    await ensureDataDirectory({ dataRoot: target.dataRoot, directoryPath: parent })
  } catch {
    throw codedError('atomic-json-path-invalid')
  }
  const temporaryPath = join(parent, `.${basename(target.path)}.${randomUUID()}.tmp`)
  let temporary
  let temporaryIdentity
  try {
    temporary = await openVerifiedDataFile({
      dataRoot: target.dataRoot,
      filePath: temporaryPath,
      flags: 'wx',
      mode: 0o600,
    })
    temporaryIdentity = temporary.identity
    await temporary.handle.writeFile(encoded, 'utf8')
    await temporary.handle.sync()
    await temporary.handle.close()
    temporary = undefined

    await validateDataPath({ dataRoot: target.dataRoot, targetPath: target.path })
    await rename(temporaryPath, target.path)
    const publishedIdentity = await syncPublishedDataFile({
      dataRoot: target.dataRoot,
      filePath: target.path,
      expectedIdentity: temporaryIdentity,
    })
    if (!sameFileIdentity(publishedIdentity, temporaryIdentity)) throw codedError('atomic-json-publish-failed')
    await syncDataDirectory({ dataRoot: target.dataRoot, directoryPath: parent })
  } catch (error) {
    await temporary?.handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    if (known(error)) throw error
    throw codedError('atomic-json-write-failed')
  }
}

export async function readAtomicJson({ dataRoot, filePath, validate } = {}) {
  const target = await atomicPath({ dataRoot, filePath, requireExists: true })
  if (validate !== undefined && typeof validate !== 'function') {
    throw codedError('atomic-json-validation-invalid')
  }
  let opened
  try {
    opened = await openVerifiedDataFile({ dataRoot: target.dataRoot, filePath: target.path, flags: 'r' })
    const metadata = await opened.handle.stat()
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_JSON_BYTES) {
      throw codedError('atomic-json-file-invalid')
    }
    const text = await opened.handle.readFile('utf8')
    const afterRead = await validateDataPath({
      dataRoot: target.dataRoot,
      targetPath: target.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterRead.identity)) throw codedError('atomic-json-identity-changed')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw codedError('atomic-json-parse-failed')
    }
    if (!validate) return parsed
    try {
      return validate(parsed)
    } catch {
      throw codedError('atomic-json-validation-failed')
    }
  } catch (error) {
    if (known(error)) throw error
    throw codedError('atomic-json-read-failed')
  } finally {
    await opened?.handle.close().catch(() => {})
  }
}

export { MAX_JSON_BYTES }
