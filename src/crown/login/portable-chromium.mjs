import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const failedLaunchOwnership = new WeakMap()

function fail(code) {
  throw new Error(code)
}

function fullyQualifiedWindowsPath(value) {
  const normalized = String(value || '').replaceAll('/', '\\')
  return /^[a-z]:\\/i.test(normalized) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized)
}

function absolutePath(value, code) {
  const raw = String(value || '').trim()
  if (!fullyQualifiedWindowsPath(raw)) fail(code)
  return path.resolve(raw)
}

function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function requireWithin(root, candidate, code) {
  if (!within(root, candidate)) fail(code)
}

function accountKey(accountId) {
  const value = String(accountId || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('portable-chromium-account-id-invalid')
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

export function profileDirectoryForAccount({ dataRoot, profileRoot, accountId } = {}) {
  const normalizedDataRoot = absolutePath(dataRoot, 'portable-chromium-data-root-invalid')
  const normalizedProfileRoot = absolutePath(profileRoot, 'portable-chromium-profile-root-invalid')
  requireWithin(normalizedDataRoot, normalizedProfileRoot, 'portable-chromium-profile-outside-data-root')

  fs.mkdirSync(normalizedDataRoot, { recursive: true })
  fs.mkdirSync(normalizedProfileRoot, { recursive: true })
  const realDataRoot = fs.realpathSync(normalizedDataRoot)
  const realProfileRoot = fs.realpathSync(normalizedProfileRoot)
  requireWithin(realDataRoot, realProfileRoot, 'portable-chromium-profile-outside-data-root')

  const profileDir = path.join(realProfileRoot, `account-${accountKey(accountId)}`)
  fs.mkdirSync(profileDir, { recursive: true })
  const realProfileDir = fs.realpathSync(profileDir)
  requireWithin(realProfileRoot, realProfileDir, 'portable-chromium-profile-outside-data-root')
  return realProfileDir
}

async function chromiumType(value) {
  if (value) return value
  const playwright = await import('playwright')
  return playwright.chromium
}

function contextOwnership(context) {
  let closed = false
  let closePromise = null
  context?.on?.('close', () => { closed = true })
  return {
    context,
    finalize() {
      if (closed) return Promise.resolve(true)
      if (closePromise) return closePromise
      closePromise = (async () => {
        try {
          await context?.close?.()
          closed = true
          return true
        } catch {
          return false
        } finally {
          closePromise = null
        }
      })()
      return closePromise
    },
  }
}

export function takePortableChromiumFailureOwnership(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  const ownership = failedLaunchOwnership.get(error) || null
  failedLaunchOwnership.delete(error)
  return ownership
}

function throwable(error) {
  return error && (typeof error === 'object' || typeof error === 'function')
    ? error
    : new Error('portable-chromium-launch-failed')
}

export async function launchPortableChromium({
  chromium,
  appRoot,
  dataRoot,
  executablePath,
  profileRoot,
  accountId,
} = {}) {
  const normalizedAppRoot = absolutePath(appRoot, 'portable-chromium-app-root-invalid')
  const normalizedExecutable = absolutePath(
    executablePath,
    'portable-chromium-executable-invalid',
  )

  let realAppRoot
  let realExecutable
  try {
    realAppRoot = fs.realpathSync(normalizedAppRoot)
    realExecutable = fs.realpathSync(normalizedExecutable)
  } catch {
    fail('portable-chromium-executable-missing')
  }
  requireWithin(realAppRoot, realExecutable, 'portable-chromium-executable-outside-app-root')
  if (!fs.statSync(realExecutable).isFile()) fail('portable-chromium-executable-invalid')

  const profileDir = profileDirectoryForAccount({ dataRoot, profileRoot, accountId })
  const browserType = await chromiumType(chromium)
  if (typeof browserType?.launchPersistentContext !== 'function') {
    fail('portable-chromium-launcher-invalid')
  }

  let context
  try {
    context = await browserType.launchPersistentContext(profileDir, {
      executablePath: realExecutable,
      headless: false,
      acceptDownloads: false,
      serviceWorkers: 'block',
    })
  } catch (error) {
    const failure = throwable(error)
    failedLaunchOwnership.set(failure, { context: null, finalize: null })
    throw failure
  }

  try {
    const existingPages = typeof context?.pages === 'function' ? context.pages() : []
    if (existingPages.length > 1) fail('portable-chromium-unexpected-pages')
    const page = existingPages[0] || await context.newPage()
    return { context, page, profileDir, executablePath: realExecutable }
  } catch (error) {
    const failure = throwable(error)
    const ownership = contextOwnership(context)
    if (!await ownership.finalize()) failedLaunchOwnership.set(failure, ownership)
    throw failure
  }
}

export default launchPortableChromium
