import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'

function codedError(code) {
  return new Error(code)
}

function isFullyQualified(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return false
  if (process.platform !== 'win32') return true
  if (/^\\\\[?.][\\/]/.test(value)) return false
  const root = win32.parse(value).root
  return /^[A-Za-z]:[\\/]$/.test(root) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]$/.test(root)
}

function normalizedIdentityPath(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

function identityOf(metadata) {
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino })
}

async function inspectSegments(path) {
  const parsed = parse(path)
  const parts = relative(parsed.root, path).split(sep).filter(Boolean)
  let current = parsed.root
  let previousWasDirectory = true
  let finalMetadata = null
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    if (!previousWasDirectory) throw codedError('safe-data-path-parent-invalid')
    let metadata
    try {
      metadata = await lstat(current, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, metadata: null }
      throw codedError('safe-data-path-inspection-failed')
    }
    if (metadata.isSymbolicLink()) throw codedError('safe-data-path-reparse-point')
    let canonical
    try {
      canonical = await realpath(current)
    } catch {
      throw codedError('safe-data-path-inspection-failed')
    }
    if (normalizedIdentityPath(canonical) !== normalizedIdentityPath(current)) {
      throw codedError('safe-data-path-reparse-point')
    }
    previousWasDirectory = metadata.isDirectory()
    finalMetadata = metadata
    if (index < parts.length - 1 && !previousWasDirectory) {
      throw codedError('safe-data-path-parent-invalid')
    }
  }
  return { exists: true, metadata: finalMetadata }
}

export async function validateDataPath({
  dataRoot,
  targetPath,
  requireExists = false,
  allowRoot = false,
  expectDirectory,
} = {}) {
  if (!isFullyQualified(dataRoot)) throw codedError('safe-data-path-root-invalid')
  if (!isFullyQualified(targetPath)) throw codedError('safe-data-path-target-invalid')
  if (typeof requireExists !== 'boolean' || typeof allowRoot !== 'boolean') {
    throw codedError('safe-data-path-options-invalid')
  }
  if (expectDirectory !== undefined && typeof expectDirectory !== 'boolean') {
    throw codedError('safe-data-path-options-invalid')
  }

  const root = resolve(dataRoot)
  const path = resolve(targetPath)
  const fromRoot = relative(root, path)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw codedError('safe-data-path-outside-root')
  }
  if (!allowRoot && fromRoot === '') throw codedError('safe-data-path-target-is-root')

  const rootState = await inspectSegments(root)
  if (!rootState.exists || !rootState.metadata?.isDirectory()) throw codedError('safe-data-path-root-invalid')
  const targetState = fromRoot === '' ? rootState : await inspectSegments(path)
  if (requireExists && !targetState.exists) throw codedError('safe-data-path-not-found')
  if (targetState.exists && expectDirectory === true && !targetState.metadata?.isDirectory()) {
    throw codedError('safe-data-path-not-directory')
  }
  if (targetState.exists && expectDirectory === false && !targetState.metadata?.isFile()) {
    throw codedError('safe-data-path-not-file')
  }
  return Object.freeze({
    dataRoot: root,
    path,
    exists: targetState.exists,
    identity: targetState.metadata ? identityOf(targetState.metadata) : null,
  })
}

export async function openVerifiedDataFile({
  dataRoot,
  filePath,
  flags = 'r',
  mode,
  expectedIdentity,
} = {}) {
  if (!['r', 'r+', 'wx', 'wx+'].includes(flags)) throw codedError('safe-data-path-flags-invalid')
  const requireExists = flags === 'r' || flags === 'r+'
  const validated = await validateDataPath({
    dataRoot,
    targetPath: filePath,
    requireExists,
    expectDirectory: requireExists ? false : undefined,
  })
  let handle
  try {
    handle = await open(validated.path, flags, mode)
    const handleMetadata = await handle.stat({ bigint: true })
    const afterOpen = await validateDataPath({
      dataRoot,
      targetPath: validated.path,
      requireExists: true,
      expectDirectory: false,
    })
    const identity = identityOf(handleMetadata)
    if (!sameFileIdentity(identity, afterOpen.identity)
      || (validated.identity && !sameFileIdentity(identity, validated.identity))
      || (expectedIdentity && !sameFileIdentity(identity, expectedIdentity))) {
      throw codedError('safe-data-path-identity-mismatch')
    }
    return { handle, path: validated.path, identity }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error instanceof Error && error.message.startsWith('safe-data-path-')) throw error
    if (error?.code === 'ENOENT') throw codedError('safe-data-path-not-found')
    if (error?.code === 'EEXIST') throw codedError('safe-data-path-exists')
    throw codedError('safe-data-path-open-failed')
  }
}

export async function ensureDataDirectory({ dataRoot, directoryPath } = {}) {
  const target = await validateDataPath({
    dataRoot,
    targetPath: directoryPath,
    allowRoot: true,
  })
  if (target.path === target.dataRoot) return target.path
  const parts = relative(target.dataRoot, target.path).split(sep).filter(Boolean)
  let current = target.dataRoot
  for (const part of parts) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw codedError('safe-data-path-directory-create-failed')
    }
    await validateDataPath({
      dataRoot: target.dataRoot,
      targetPath: current,
      requireExists: true,
      allowRoot: true,
      expectDirectory: true,
    })
  }
  return target.path
}

export async function syncDataDirectory({ dataRoot, directoryPath } = {}) {
  const validated = await validateDataPath({
    dataRoot,
    targetPath: directoryPath,
    requireExists: true,
    allowRoot: true,
    expectDirectory: true,
  })
  let handle
  try {
    handle = await open(validated.path, 'r')
    const handleMetadata = await handle.stat({ bigint: true })
    if (!sameFileIdentity(identityOf(handleMetadata), validated.identity)) {
      throw codedError('safe-data-path-identity-mismatch')
    }
    await handle.sync()
    return true
  } catch (error) {
    if (['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(error?.code)) return false
    if (error instanceof Error && error.message.startsWith('safe-data-path-')) throw error
    throw codedError('safe-data-path-directory-sync-failed')
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function syncPublishedDataFile({ dataRoot, filePath, expectedIdentity } = {}) {
  const opened = await openVerifiedDataFile({ dataRoot, filePath, flags: 'r+', expectedIdentity })
  try {
    await opened.handle.sync()
  } catch {
    throw codedError('safe-data-path-sync-failed')
  } finally {
    await opened.handle.close().catch(() => {})
  }
  return opened.identity
}
