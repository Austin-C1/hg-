import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveDashboardRuntime } from '../scripts/crown-dashboard.mjs'

function runtimeEnv(appDir, dataRoot, overrides = {}) {
  return {
    CROWN_PORTABLE: '0',
    CROWN_APP_DIR: appDir,
    CROWN_DATA_ROOT: dataRoot,
    CROWN_DB_PATH: '',
    CROWN_LOCAL_SECRET_KEY_PATH: '',
    CROWN_CONFIG_DIR: '',
    CROWN_RUNTIME_DIR: '',
    CROWN_SESSION_DIR: '',
    CROWN_BROWSER_PROFILE_DIR: '',
    CROWN_LOG_DIR: '',
    CROWN_STATIC_DIR: '',
    ...overrides,
  }
}

test('development dashboard derives user-writable defaults from data root, not code root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appDir = path.join(root, 'new-code-root')
  const dataRoot = path.join(root, 'existing-data-root')

  const { portable, paths } = resolveDashboardRuntime({ env: runtimeEnv(appDir, dataRoot) })

  assert.equal(portable, false)
  assert.equal(paths.appDir, appDir)
  assert.equal(paths.dataRoot, dataRoot)
  assert.equal(paths.configDir, path.join(dataRoot, 'config'))
  assert.equal(paths.dbPath, path.join(dataRoot, 'storage', 'crown.sqlite'))
  assert.equal(paths.secretKeyPath, path.join(dataRoot, 'storage', 'crown-local-secret.key'))
  assert.equal(paths.runtimeDir, path.join(dataRoot, 'data', 'runtime'))
  assert.equal(paths.sessionDir, path.join(dataRoot, 'data', 'runtime', 'crown-sessions'))
  assert.equal(paths.profileDir, path.join(dataRoot, 'data', 'runtime', 'browser-profiles'))
  assert.equal(paths.logDir, path.join(dataRoot, 'logs'))
  assert.equal(paths.staticDir, path.join(appDir, 'frontend', 'dist'))
})

test('development dashboard keeps explicit user-writable path overrides', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-runtime-explicit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const appDir = path.join(root, 'code')
  const dataRoot = path.join(root, 'data')
  const explicitRoot = path.join(root, 'explicit')
  const explicit = {
    CROWN_CONFIG_DIR: path.join(explicitRoot, 'config'),
    CROWN_DB_PATH: path.join(explicitRoot, 'db.sqlite'),
    CROWN_LOCAL_SECRET_KEY_PATH: path.join(explicitRoot, 'secret.key'),
    CROWN_RUNTIME_DIR: path.join(explicitRoot, 'runtime'),
    CROWN_SESSION_DIR: path.join(explicitRoot, 'sessions'),
    CROWN_BROWSER_PROFILE_DIR: path.join(explicitRoot, 'profiles'),
    CROWN_LOG_DIR: path.join(explicitRoot, 'logs'),
  }

  const { paths } = resolveDashboardRuntime({ env: runtimeEnv(appDir, dataRoot, explicit) })

  assert.equal(paths.configDir, explicit.CROWN_CONFIG_DIR)
  assert.equal(paths.dbPath, explicit.CROWN_DB_PATH)
  assert.equal(paths.secretKeyPath, explicit.CROWN_LOCAL_SECRET_KEY_PATH)
  assert.equal(paths.runtimeDir, explicit.CROWN_RUNTIME_DIR)
  assert.equal(paths.sessionDir, explicit.CROWN_SESSION_DIR)
  assert.equal(paths.profileDir, explicit.CROWN_BROWSER_PROFILE_DIR)
  assert.equal(paths.logDir, explicit.CROWN_LOG_DIR)
})
