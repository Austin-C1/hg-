import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertPathWithin,
  portableEnvironment,
  resolvePortablePaths,
} from '../src/crown/runtime/portable-paths.mjs'

const APP_ROOT = 'D:\\带 空格\\CrownMonitor'
const DATA_ROOT = 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor'

test('portable paths separate immutable version files from user-writable data', () => {
  const paths = resolvePortablePaths({
    appRoot: APP_ROOT,
    dataRoot: DATA_ROOT,
    version: '0.1.0',
  })

  assert.deepEqual(paths, {
    appRoot: APP_ROOT,
    versionRoot: 'D:\\带 空格\\CrownMonitor\\versions\\0.1.0',
    appDir: 'D:\\带 空格\\CrownMonitor\\versions\\0.1.0\\app',
    nodeExe: 'D:\\带 空格\\CrownMonitor\\versions\\0.1.0\\runtime\\node\\node.exe',
    chromiumExe: 'D:\\带 空格\\CrownMonitor\\versions\\0.1.0\\runtime\\chromium\\chrome.exe',
    dataRoot: DATA_ROOT,
    dbPath: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\storage\\crown.sqlite',
    secretKeyPath: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\storage\\crown-local-secret.key',
    configDir: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\config',
    runtimeDir: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\runtime',
    sessionDir: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\runtime\\crown-sessions',
    profileDir: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\runtime\\browser-profiles',
    logDir: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\logs',
    staticDir: 'D:\\带 空格\\CrownMonitor\\versions\\0.1.0\\app\\frontend\\dist',
  })

  for (const field of ['dbPath', 'secretKeyPath', 'configDir', 'runtimeDir', 'sessionDir', 'profileDir', 'logDir']) {
    assert.equal(assertPathWithin(paths.dataRoot, paths[field], field), paths[field])
  }
})

test('portable data defaults to LOCALAPPDATA and never falls back to cwd', () => {
  const env = { LOCALAPPDATA: 'E:\\用户资料\\Local AppData' }
  const before = resolvePortablePaths({ appRoot: APP_ROOT, env, version: '0.1.0' })
  const originalCwd = process.cwd()
  const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-cwd-'))

  try {
    process.chdir(foreignCwd)
    const after = resolvePortablePaths({ appRoot: APP_ROOT, env, version: '0.1.0' })
    assert.deepEqual(after, before)
  } finally {
    process.chdir(originalCwd)
  }

  assert.equal(before.dataRoot, 'E:\\用户资料\\Local AppData\\CrownMonitor')
  assert.equal(before.appRoot.startsWith('D:\\'), true)
  assert.equal(before.dataRoot.startsWith('E:\\'), true)
})

test('portable data root accepts an explicit environment override', () => {
  const paths = resolvePortablePaths({
    appRoot: APP_ROOT,
    env: { CROWN_DATA_ROOT: 'F:\\皇冠 数据' },
    version: '0.1.0',
  })

  assert.equal(paths.dataRoot, 'F:\\皇冠 数据')
  assert.equal(paths.dbPath, 'F:\\皇冠 数据\\storage\\crown.sqlite')
})

test('portable paths require absolute roots and LOCALAPPDATA when no data root is supplied', () => {
  assert.throws(
    () => resolvePortablePaths({ appRoot: APP_ROOT, env: {}, version: '0.1.0' }),
    /portable-localappdata-required/,
  )
  assert.throws(
    () => resolvePortablePaths({ appRoot: 'relative-app', dataRoot: DATA_ROOT, version: '0.1.0' }),
    /portable-app-root-invalid/,
  )
  assert.throws(
    () => resolvePortablePaths({ appRoot: APP_ROOT, dataRoot: 'relative-data', version: '0.1.0' }),
    /portable-data-root-invalid/,
  )
})

test('portable roots require a drive-qualified path or a complete UNC share', () => {
  for (const invalidRoot of ['\\foo', '/foo', 'C:foo', '\\\\server']) {
    assert.throws(
      () => resolvePortablePaths({ appRoot: invalidRoot, dataRoot: DATA_ROOT, version: '0.1.0' }),
      /portable-app-root-invalid/,
      `appRoot=${invalidRoot}`,
    )
    assert.throws(
      () => resolvePortablePaths({ appRoot: APP_ROOT, dataRoot: invalidRoot, version: '0.1.0' }),
      /portable-data-root-invalid/,
      `dataRoot=${invalidRoot}`,
    )
  }

  const unc = resolvePortablePaths({
    appRoot: '\\\\server-a\\app-share\\Crown Monitor',
    dataRoot: '\\\\server-b\\data-share\\Crown Monitor',
    version: '0.1.0',
  })
  assert.equal(unc.appRoot, '\\\\server-a\\app-share\\Crown Monitor')
  assert.equal(unc.dataRoot, '\\\\server-b\\data-share\\Crown Monitor')
})

test('portable versions accept strict SemVer only', () => {
  const prerelease = resolvePortablePaths({
    appRoot: APP_ROOT,
    dataRoot: DATA_ROOT,
    version: '0.1.1-beta.1+build.5',
  })
  assert.equal(prerelease.versionRoot, 'D:\\带 空格\\CrownMonitor\\versions\\0.1.1-beta.1+build.5')

  for (const version of [
    '',
    '1.2',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3 ',
    '..\\outside',
    '1.2.3/../../outside',
  ]) {
    assert.throws(
      () => resolvePortablePaths({ appRoot: APP_ROOT, dataRoot: DATA_ROOT, version }),
      /portable-version-invalid/,
      version,
    )
  }
})

test('path containment is case-insensitive and rejects siblings, prefixes, and relative candidates', () => {
  assert.equal(
    assertPathWithin('C:\\Crown\\Data', 'c:\\crown\\data\\runtime', 'runtimeDir'),
    'c:\\crown\\data\\runtime',
  )
  assert.throws(
    () => assertPathWithin('C:\\Crown\\Data', 'C:\\Crown\\Data-Other\\runtime', 'runtimeDir'),
    /portable-path-outside-data-root:runtimeDir/,
  )
  assert.throws(
    () => assertPathWithin('C:\\Crown\\Data', 'D:\\Crown\\Data\\runtime', 'runtimeDir'),
    /portable-path-outside-data-root:runtimeDir/,
  )
  assert.throws(
    () => assertPathWithin('C:\\Crown\\Data', 'runtime', 'runtimeDir'),
    /portable-path-invalid:runtimeDir/,
  )
  assert.throws(
    () => assertPathWithin('C:\\Crown\\Data', '\\Crown\\Data\\runtime', 'runtimeDir'),
    /portable-path-invalid:runtimeDir/,
  )
  assert.throws(
    () => assertPathWithin('C:\\Crown\\Data', '/Crown/Data/runtime', 'runtimeDir'),
    /portable-path-invalid:runtimeDir/,
  )
})

test('portable environment exposes normalized explicit paths for child processes', () => {
  const paths = resolvePortablePaths({ appRoot: APP_ROOT, dataRoot: DATA_ROOT, version: '0.1.0' })
  const env = portableEnvironment(paths)

  assert.deepEqual(env, {
    CROWN_PORTABLE: '1',
    CROWN_APP_VERSION: '0.1.0',
    CROWN_APP_ROOT: paths.appRoot,
    CROWN_VERSION_ROOT: paths.versionRoot,
    CROWN_APP_DIR: paths.appDir,
    CROWN_NODE_EXECUTABLE_PATH: paths.nodeExe,
    CROWN_CHROMIUM_EXECUTABLE_PATH: paths.chromiumExe,
    CROWN_DATA_ROOT: paths.dataRoot,
    CROWN_DB_PATH: paths.dbPath,
    CROWN_LOCAL_SECRET_KEY_PATH: paths.secretKeyPath,
    CROWN_CONFIG_DIR: paths.configDir,
    CROWN_RUNTIME_DIR: paths.runtimeDir,
    CROWN_SESSION_DIR: paths.sessionDir,
    CROWN_BROWSER_PROFILE_DIR: paths.profileDir,
    CROWN_LOG_DIR: paths.logDir,
    CROWN_STATIC_DIR: paths.staticDir,
  })
})

const graphPaths = resolvePortablePaths({ appRoot: APP_ROOT, dataRoot: DATA_ROOT, version: '0.1.0' })
const graphTampering = {
  appRoot: 'D:\\带 空格',
  versionRoot: `${graphPaths.appRoot}\\other\\0.1.0`,
  appDir: `${graphPaths.versionRoot}\\wrong-app`,
  nodeExe: `${graphPaths.versionRoot}\\runtime\\node\\wrong.exe`,
  chromiumExe: `${graphPaths.versionRoot}\\runtime\\chromium\\wrong.exe`,
  staticDir: `${graphPaths.appDir}\\frontend\\other`,
  dataRoot: 'C:\\Users\\UserA\\AppData\\Local',
  dbPath: `${graphPaths.dataRoot}\\storage\\other.sqlite`,
  secretKeyPath: `${graphPaths.dataRoot}\\storage\\other.key`,
  configDir: `${graphPaths.dataRoot}\\other-config`,
  runtimeDir: `${graphPaths.dataRoot}\\other-runtime`,
  sessionDir: `${graphPaths.runtimeDir}\\other-sessions`,
  profileDir: `${graphPaths.runtimeDir}\\other-profiles`,
  logDir: `${graphPaths.dataRoot}\\other-logs`,
}

for (const [field, tampered] of Object.entries(graphTampering)) {
  test(`portable environment rejects a tampered ${field} graph node`, () => {
    assert.throws(
      () => portableEnvironment({ ...graphPaths, [field]: tampered }),
      /portable-path-graph-invalid:/,
    )
  })
}
