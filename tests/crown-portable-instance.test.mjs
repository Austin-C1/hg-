import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  initializePortableData,
  readInstallationId,
} from '../src/crown/runtime/portable-instance.mjs'

const execFileAsync = promisify(execFile)
const bundledConfigDir = path.resolve('config')

function tempDataRoot(prefix = 'crown-portable-instance-') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'data')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function makeJunction(target, junction) {
  fs.symlinkSync(target, junction, 'junction')
}

function writeInitializationLock(dataRoot, value) {
  fs.writeFileSync(path.join(dataRoot, '.portable-initialize.lock'), `${JSON.stringify(value)}\n`, 'utf8')
}

test('first run seeds 118 leagues and initializes an opaque identity, key, and empty database', () => {
  const dataRoot = tempDataRoot()
  const result = initializePortableData({
    appConfigDir: bundledConfigDir,
    dataRoot,
    randomId: () => 'install-A',
  })

  assert.equal(result.created, true)
  assert.equal(result.installationId, 'install-A')
  assert.equal(result.leagueCount, 118)
  assert.deepEqual(result.resources, {
    defaultLeagues: 'created',
    installationIdentity: 'created',
    localSecretKey: 'created',
    database: 'created',
  })
  assert.equal(JSON.stringify(result).includes(dataRoot), false)

  const userConfig = readJson(path.join(dataRoot, 'config', 'default-leagues.json'))
  assert.equal(userConfig.leagues.length, 118)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'storage', 'crown-local-secret.key'), 'utf8').trim().length > 20, true)
  assert.equal(readInstallationId(dataRoot), 'install-A')

  const db = new DatabaseSync(path.join(dataRoot, 'storage', 'crown.sqlite'), { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM monitor_accounts').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM betting_accounts').get().count, 0)
  assert.equal(db.prepare('SELECT requested FROM real_betting_runtime WHERE singleton_id = 1').get().requested, 0)
  db.close()
})

test('later runs never overwrite user whitelist, installation identity, key, or database', () => {
  const dataRoot = tempDataRoot()
  initializePortableData({ appConfigDir: bundledConfigDir, dataRoot, randomId: () => 'install-A' })
  const userLeaguesPath = path.join(dataRoot, 'config', 'default-leagues.json')
  const keyPath = path.join(dataRoot, 'storage', 'crown-local-secret.key')
  const dbPath = path.join(dataRoot, 'storage', 'crown.sqlite')
  const custom = { version: 1, leagues: [] }
  fs.writeFileSync(userLeaguesPath, `${JSON.stringify(custom)}\n`, 'utf8')
  const originalKey = fs.readFileSync(keyPath, 'utf8')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE user_marker (value TEXT NOT NULL)')
  db.prepare('INSERT INTO user_marker(value) VALUES (?)').run('keep-me')
  db.close()

  const result = initializePortableData({
    appConfigDir: bundledConfigDir,
    dataRoot,
    randomId: () => 'install-B',
  })

  assert.equal(result.created, false)
  assert.equal(result.installationId, 'install-A')
  assert.equal(readInstallationId(dataRoot), 'install-A')
  assert.deepEqual(readJson(userLeaguesPath), custom)
  assert.equal(fs.readFileSync(keyPath, 'utf8'), originalKey)
  const reopened = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(reopened.prepare('SELECT value FROM user_marker').get().value, 'keep-me')
  reopened.close()
})

test('first run copies only the league seed and never imports bundled accounts, sessions, profiles, or SQLite', () => {
  const appConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-seed-source-'))
  fs.copyFileSync(path.join(bundledConfigDir, 'default-leagues.json'), path.join(appConfigDir, 'default-leagues.json'))
  fs.writeFileSync(path.join(appConfigDir, 'monitor-accounts.json'), '{"username":"dev-user","password":"dev-password"}')
  fs.writeFileSync(path.join(appConfigDir, 'telegram-settings.json'), '{"token":"dev-token"}')
  fs.mkdirSync(path.join(appConfigDir, 'sessions'))
  fs.writeFileSync(path.join(appConfigDir, 'sessions', 'state.json'), '{"cookie":"dev-cookie"}')
  fs.writeFileSync(path.join(appConfigDir, 'developer.sqlite'), 'not-a-database')
  const dataRoot = tempDataRoot()

  initializePortableData({ appConfigDir, dataRoot, randomId: () => 'install-safe' })

  const files = fs.readdirSync(dataRoot, { recursive: true }).map(String).map((file) => file.replaceAll('\\', '/'))
  assert.equal(files.some((file) => /monitor-accounts|telegram-settings|sessions|developer\.sqlite/i.test(file)), false)
})

test('unsafe or non-canonical bundled league seed fails before local data is created', () => {
  const appConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-unsafe-seed-'))
  const unsafeSeed = JSON.parse(fs.readFileSync(path.join(bundledConfigDir, 'default-leagues.json'), 'utf8'))
  unsafeSeed.account = { username: 'dev-user', password: 'dev-password' }
  fs.writeFileSync(path.join(appConfigDir, 'default-leagues.json'), JSON.stringify(unsafeSeed), 'utf8')
  const dataRoot = tempDataRoot()

  assert.throws(
    () => initializePortableData({ appConfigDir, dataRoot, randomId: () => 'install-safe' }),
    /default-league-seed-unsafe/,
  )
  assert.equal(fs.existsSync(dataRoot), false)
})

test('invalid existing installation identity fails closed and is not replaced', () => {
  const dataRoot = tempDataRoot()
  fs.mkdirSync(dataRoot, { recursive: true })
  const identityPath = path.join(dataRoot, 'installation.json')
  fs.writeFileSync(identityPath, '{"schemaVersion":1,"installationId":""}\n', 'utf8')

  assert.throws(
    () => initializePortableData({ appConfigDir: bundledConfigDir, dataRoot, randomId: () => 'install-new' }),
    /portable-installation-identity-invalid/,
  )
  assert.equal(fs.readFileSync(identityPath, 'utf8'), '{"schemaVersion":1,"installationId":""}\n')
})

test('explicit app config directory must be absolute instead of depending on process cwd', () => {
  const dataRoot = tempDataRoot()

  assert.throws(
    () => initializePortableData({ appConfigDir: 'config', dataRoot, randomId: () => 'install-safe' }),
    /portable-app-config-dir-invalid/,
  )
  assert.equal(fs.existsSync(dataRoot), false)
})

test('data root and writable descendants reject junctions before writing outside the data root', () => {
  for (const segment of ['.', 'config', 'storage']) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), `crown-portable-reparse-${segment.replace('.', 'root')}-`))
    const outside = path.join(parent, 'outside')
    const requestedRoot = path.join(parent, 'data')
    fs.mkdirSync(outside)
    if (segment === '.') {
      makeJunction(outside, requestedRoot)
    } else {
      fs.mkdirSync(requestedRoot)
      makeJunction(outside, path.join(requestedRoot, segment))
    }

    assert.throws(
      () => initializePortableData({ appConfigDir: bundledConfigDir, dataRoot: requestedRoot }),
      /portable-data-reparse-forbidden/,
      segment,
    )
    assert.deepEqual(fs.readdirSync(outside), [], `${segment} must not receive files`)
  }
})

test('bundled app config directory must be a normal directory rather than a junction', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-app-config-reparse-'))
  const appConfigDir = path.join(parent, 'config-link')
  makeJunction(bundledConfigDir, appConfigDir)
  const dataRoot = path.join(parent, 'data')

  assert.throws(
    () => initializePortableData({ appConfigDir, dataRoot }),
    /portable-app-config-reparse-forbidden/,
  )
  assert.equal(fs.existsSync(dataRoot), false)
})

test('six independent initializers serialize and all observe the same identity and key', async () => {
  const dataRoot = tempDataRoot('crown-portable-concurrent-')
  const moduleUrl = new URL('../src/crown/runtime/portable-instance.mjs', import.meta.url).href
  const secretModuleUrl = new URL('../src/crown/app/app-secret.mjs', import.meta.url).href
  const startAt = Date.now() + 1_000
  const script = `
    import fs from 'node:fs';
    const [moduleUrl, secretModuleUrl, dataRoot, appConfigDir, startAt] = process.argv.slice(1);
    const wait = Math.max(0, Number(startAt) - Date.now());
    if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    const { initializePortableData } = await import(moduleUrl);
    const { readOrCreateLocalSecretKey } = await import(secretModuleUrl);
    const result = initializePortableData({ appConfigDir, dataRoot, randomId: () => 'install-' + process.pid });
    const key = readOrCreateLocalSecretKey({ env: {
      CROWN_PORTABLE: '1', CROWN_DATA_ROOT: dataRoot,
      CROWN_LOCAL_SECRET_KEY_PATH: dataRoot + '\\\\storage\\\\crown-local-secret.key',
    }});
    process.stdout.write(JSON.stringify({ installationId: result.installationId, key }));
  `
  const runs = Array.from({ length: 6 }, () => execFileAsync(process.execPath, [
    '--input-type=module', '--eval', script,
    moduleUrl, secretModuleUrl, dataRoot, bundledConfigDir, String(startAt),
  ], { timeout: 20_000 }))
  const results = (await Promise.all(runs)).map(({ stdout }) => JSON.parse(stdout))

  assert.equal(new Set(results.map((result) => result.installationId)).size, 1)
  assert.equal(new Set(results.map((result) => result.key)).size, 1)
  assert.equal(readJson(path.join(dataRoot, 'config', 'default-leagues.json')).leagues.length, 118)
  const db = new DatabaseSync(path.join(dataRoot, 'storage', 'crown.sqlite'), { readOnly: true })
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  db.close()
})

test('live initialization lock is never stolen even when its timestamp is old', () => {
  const dataRoot = tempDataRoot('crown-portable-live-lock-')
  fs.mkdirSync(dataRoot)
  writeInitializationLock(dataRoot, {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: '2000-01-01T00:00:00.000Z',
    nonce: 'live-owner-nonce',
  })

  assert.throws(
    () => initializePortableData({
      appConfigDir: bundledConfigDir,
      dataRoot,
      lockOptions: { waitTimeoutMs: 40, pollIntervalMs: 5, staleAfterMs: 1 },
    }),
    /portable-initialization-lock-timeout/,
  )
  assert.equal(readJson(path.join(dataRoot, '.portable-initialize.lock')).nonce, 'live-owner-nonce')
  assert.deepEqual(fs.readdirSync(dataRoot), ['.portable-initialize.lock'])
})

test('old dead initialization lock is recovered without overwriting half-initialized data', () => {
  const dataRoot = tempDataRoot('crown-portable-stale-lock-')
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true })
  fs.copyFileSync(path.join(bundledConfigDir, 'default-leagues.json'), path.join(dataRoot, 'config', 'default-leagues.json'))
  fs.writeFileSync(path.join(dataRoot, 'installation.json'), '{"schemaVersion":1,"installationId":"install-half"}\n')
  writeInitializationLock(dataRoot, {
    schemaVersion: 1,
    pid: 999999,
    createdAt: '2000-01-01T00:00:00.000Z',
    nonce: 'stale-owner-nonce',
  })

  const result = initializePortableData({
    appConfigDir: bundledConfigDir,
    dataRoot,
    randomId: () => 'install-new',
    lockOptions: { waitTimeoutMs: 500, pollIntervalMs: 5, staleAfterMs: 1 },
  })

  assert.equal(result.installationId, 'install-half')
  assert.equal(fs.existsSync(path.join(dataRoot, '.portable-initialize.lock')), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'storage', 'crown-local-secret.key')), true)
  assert.equal(fs.existsSync(path.join(dataRoot, 'storage', 'crown.sqlite')), true)
})

test('unverifiable stale lock fails closed and remains untouched', () => {
  const dataRoot = tempDataRoot('crown-portable-bad-lock-')
  fs.mkdirSync(dataRoot)
  const lockPath = path.join(dataRoot, '.portable-initialize.lock')
  fs.writeFileSync(lockPath, '{broken-json', 'utf8')
  fs.utimesSync(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'))

  assert.throws(
    () => initializePortableData({
      appConfigDir: bundledConfigDir,
      dataRoot,
      lockOptions: { waitTimeoutMs: 40, pollIntervalMs: 5, staleAfterMs: 1 },
    }),
    /portable-initialization-lock-unverifiable/,
  )
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{broken-json')
})
