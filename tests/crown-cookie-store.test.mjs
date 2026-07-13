import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CrownCookieStore } from '../src/crown/login/crown-cookie-store.mjs'

function tempRuntimeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-cookie-store-'))
}

test('cookie store reports missing session files as 不存在', () => {
  const store = new CrownCookieStore({ accountId: 'mon_primary', runtimeDir: tempRuntimeDir() })

  assert.equal(store.readCookies().status, '不存在')
  assert.equal(store.readStorageState().status, '不存在')
  assert.match(store.cookiesPath(), /crown-sessions[\\/]mon_primary[\\/]cookies\.json$/)
  assert.match(store.storageStatePath(), /crown-sessions[\\/]mon_primary[\\/]storage-state\.json$/)
})

test('cookie store writes and reads cookies and storageState without changing values', () => {
  const store = new CrownCookieStore({ accountId: 'mon_primary', runtimeDir: tempRuntimeDir() })
  const cookies = [{ name: 'uid', value: 'abc', domain: '.example.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]
  const storageState = { cookies, origins: [{ origin: 'https://example.test', localStorage: [{ name: 'token', value: 'secret-token' }] }] }

  store.writeCookies(cookies)
  store.writeStorageState(storageState)

  assert.deepEqual(store.readCookies().cookies, cookies)
  assert.equal(store.readCookies().status, '已加载')
  assert.deepEqual(store.readStorageState().storageState, storageState)
  assert.equal(store.readStorageState().status, '已加载')
})

test('cookie store marks expired cookies as 已过期', () => {
  const store = new CrownCookieStore({ accountId: 'mon_primary', runtimeDir: tempRuntimeDir() })

  store.writeCookies([{ name: 'old', value: '1', domain: '.example.test', path: '/', expires: 1 }])

  assert.equal(store.readCookies().status, '已过期')
})

test('cookie store can load cookies into context and save cookies/storageState from context', async () => {
  const store = new CrownCookieStore({ accountId: 'mon_primary', runtimeDir: tempRuntimeDir() })
  const cookies = [{ name: 'uid', value: 'abc', domain: '.example.test', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }]
  const storageState = { cookies, origins: [] }
  const added = []
  const context = {
    async addCookies(nextCookies) {
      added.push(...nextCookies)
    },
    async cookies() {
      return cookies
    },
    async storageState() {
      return storageState
    },
  }

  store.writeCookies(cookies)
  const loadResult = await store.loadIntoContext(context)
  const saveResult = await store.saveFromContext(context)

  assert.deepEqual(added, cookies)
  assert.equal(loadResult.cookieStatus, '已加载')
  assert.equal(saveResult.cookieStatus, '已保存')
  assert.deepEqual(store.readStorageState().storageState, storageState)
})
