import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJsonFile(file, value) {
  ensureParent(file)
  const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  let descriptor = null
  let published = false
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(descriptor, payload)
    fs.fsyncSync(descriptor)
    const opened = fs.fstatSync(descriptor)
    const linked = fs.lstatSync(temporary)
    if (!opened.isFile() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw new Error('crown-cookie-temp-identity-mismatch')
    }
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
    published = true
    descriptor = fs.openSync(file, fs.constants.O_RDWR)
    const targetOpened = fs.fstatSync(descriptor)
    const targetLinked = fs.lstatSync(file)
    if (!targetOpened.isFile() || !targetLinked.isFile()
      || targetOpened.dev !== targetLinked.dev || targetOpened.ino !== targetLinked.ino) {
      throw new Error('crown-cookie-publish-identity-mismatch')
    }
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    if (!published) {
      try { fs.rmSync(temporary, { force: true }) } catch {}
    }
  }
}

function cookieExpiresAt(cookie) {
  const expires = Number(cookie?.expires)
  if (!Number.isFinite(expires) || expires <= 0) return Number.POSITIVE_INFINITY
  return expires
}

function cookiesExpired(cookies, nowSeconds = Date.now() / 1000) {
  if (!Array.isArray(cookies) || cookies.length === 0) return false
  return cookies.every((cookie) => cookieExpiresAt(cookie) <= nowSeconds)
}

function cookiesFromStorageState(storageState) {
  return Array.isArray(storageState?.cookies) ? storageState.cookies : []
}

export class CrownCookieStore {
  constructor({ accountId, runtimeDir = 'data/runtime' } = {}) {
    this.accountId = accountId || 'mon_primary'
    this.runtimeDir = runtimeDir
  }

  sessionDir() {
    return path.join(this.runtimeDir, 'crown-sessions', this.accountId)
  }

  cookiesPath() {
    return path.join(this.sessionDir(), 'cookies.json')
  }

  storageStatePath() {
    return path.join(this.sessionDir(), 'storage-state.json')
  }

  readCookies() {
    const file = this.cookiesPath()
    if (!fs.existsSync(file)) return { status: '不存在', cookies: [], path: file }
    try {
      const payload = readJsonFile(file)
      const cookies = Array.isArray(payload) ? payload : cookiesFromStorageState(payload)
      return {
        status: cookiesExpired(cookies) ? '已过期' : '已加载',
        cookies,
        path: file,
      }
    } catch (error) {
      return { status: '加载失败', cookies: [], path: file, message: String(error?.message || error) }
    }
  }

  writeCookies(cookies) {
    writeJsonFile(this.cookiesPath(), Array.isArray(cookies) ? cookies : [])
    return { status: '已保存', path: this.cookiesPath() }
  }

  readStorageState() {
    const file = this.storageStatePath()
    if (!fs.existsSync(file)) return { status: '不存在', storageState: null, path: file }
    try {
      return { status: '已加载', storageState: readJsonFile(file), path: file }
    } catch (error) {
      return { status: '加载失败', storageState: null, path: file, message: String(error?.message || error) }
    }
  }

  writeStorageState(storageState) {
    writeJsonFile(this.storageStatePath(), storageState || { cookies: [], origins: [] })
    return { status: '已保存', path: this.storageStatePath() }
  }

  async loadIntoContext(context) {
    const cookieResult = this.readCookies()
    const storageResult = this.readStorageState()
    let cookies = cookieResult.status === '已加载' ? cookieResult.cookies : []
    if (!cookies.length && storageResult.status === '已加载') {
      cookies = cookiesFromStorageState(storageResult.storageState)
    }
    if (cookies.length && typeof context?.addCookies === 'function') {
      await context.addCookies(cookies)
    }
    return {
      cookieStatus: cookieResult.status,
      storageStateStatus: storageResult.status,
      cookiesLoaded: cookies.length,
    }
  }

  async saveFromContext(context) {
    const cookies = typeof context?.cookies === 'function' ? await context.cookies() : []
    const storageState = typeof context?.storageState === 'function'
      ? await context.storageState()
      : { cookies, origins: [] }
    this.writeCookies(cookies)
    this.writeStorageState(storageState)
    return {
      cookieStatus: '已保存',
      storageStateStatus: '已保存',
      cookiesSaved: Array.isArray(cookies) ? cookies.length : 0,
    }
  }
}

export default CrownCookieStore
