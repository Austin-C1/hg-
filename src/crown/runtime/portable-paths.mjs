import path from 'node:path'

const { win32 } = path
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const DRIVE_QUALIFIED = /^[A-Za-z]:[\\/]/
const COMPLETE_UNC_SHARE = /^(?:\\\\|\/\/)(?![?.](?:[\\/]|$))[^\\/:*?"<>|]+[\\/][^\\/:*?"<>|]+(?:[\\/]|$)/
const PATH_GRAPH_FIELDS = [
  'appRoot',
  'versionRoot',
  'appDir',
  'nodeExe',
  'chromiumExe',
  'dataRoot',
  'dbPath',
  'secretKeyPath',
  'configDir',
  'runtimeDir',
  'sessionDir',
  'profileDir',
  'logDir',
  'updateDir',
  'backupDir',
  'staticDir',
]

function portableError(code, field) {
  const message = field ? `${code}:${field}` : code
  const error = new Error(message)
  error.code = code
  return error
}

function normalizedAbsolute(value, code) {
  if (typeof value !== 'string' || !value || (!DRIVE_QUALIFIED.test(value) && !COMPLETE_UNC_SHARE.test(value))) {
    throw portableError(code)
  }
  return win32.normalize(value)
}

function strictVersion(version) {
  if (typeof version !== 'string' || !STRICT_SEMVER.test(version)) {
    throw portableError('portable-version-invalid')
  }
  return version
}

export function assertPathWithin(root, candidate, field = 'path') {
  let normalizedRoot
  let normalizedCandidate
  try {
    normalizedRoot = normalizedAbsolute(root, 'portable-path-invalid')
    normalizedCandidate = normalizedAbsolute(candidate, 'portable-path-invalid')
  } catch {
    throw portableError('portable-path-invalid', field)
  }

  const relative = win32.relative(normalizedRoot, normalizedCandidate)
  if (win32.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${win32.sep}`)) {
    throw portableError('portable-path-outside-data-root', field)
  }
  return normalizedCandidate
}

export function resolvePortablePaths({ appRoot, dataRoot, env = process.env, version } = {}) {
  const normalizedAppRoot = normalizedAbsolute(appRoot, 'portable-app-root-invalid')
  const normalizedVersion = strictVersion(version)
  const configuredDataRoot = dataRoot || env.CROWN_DATA_ROOT
  const defaultDataRoot = env.LOCALAPPDATA
    ? win32.join(env.LOCALAPPDATA, 'CrownMonitor')
    : null
  if (!configuredDataRoot && !defaultDataRoot) {
    throw portableError('portable-localappdata-required')
  }
  const normalizedDataRoot = normalizedAbsolute(
    configuredDataRoot || defaultDataRoot,
    'portable-data-root-invalid',
  )

  const versionRoot = win32.join(normalizedAppRoot, 'versions', normalizedVersion)
  const appDir = win32.join(versionRoot, 'app')
  const runtimeDir = win32.join(normalizedDataRoot, 'runtime')
  const paths = {
    appRoot: normalizedAppRoot,
    versionRoot,
    appDir,
    nodeExe: win32.join(versionRoot, 'runtime', 'node', 'node.exe'),
    chromiumExe: win32.join(versionRoot, 'runtime', 'chromium', 'chrome.exe'),
    dataRoot: normalizedDataRoot,
    dbPath: win32.join(normalizedDataRoot, 'storage', 'crown.sqlite'),
    secretKeyPath: win32.join(normalizedDataRoot, 'storage', 'crown-local-secret.key'),
    configDir: win32.join(normalizedDataRoot, 'config'),
    runtimeDir,
    sessionDir: win32.join(runtimeDir, 'crown-sessions'),
    profileDir: win32.join(runtimeDir, 'browser-profiles'),
    logDir: win32.join(normalizedDataRoot, 'logs'),
    updateDir: win32.join(normalizedDataRoot, 'updates'),
    backupDir: win32.join(normalizedDataRoot, 'backups'),
    staticDir: win32.join(appDir, 'frontend', 'dist'),
  }

  for (const field of ['dbPath', 'secretKeyPath', 'configDir', 'runtimeDir', 'sessionDir', 'profileDir', 'logDir', 'updateDir', 'backupDir']) {
    assertPathWithin(paths.dataRoot, paths[field], field)
  }
  return paths
}

export function portableEnvironment(paths) {
  let version
  try {
    version = strictVersion(win32.basename(paths?.versionRoot))
  } catch {
    throw portableError('portable-path-graph-invalid', 'versionRoot')
  }
  let expected
  try {
    expected = resolvePortablePaths({
      appRoot: paths?.appRoot,
      dataRoot: paths?.dataRoot,
      env: {},
      version,
    })
  } catch (error) {
    const field = error?.code === 'portable-data-root-invalid' ? 'dataRoot' : 'appRoot'
    throw portableError('portable-path-graph-invalid', field)
  }
  for (const field of PATH_GRAPH_FIELDS) {
    if (paths?.[field] !== expected[field]) {
      throw portableError('portable-path-graph-invalid', field)
    }
  }

  return {
    CROWN_PORTABLE: '1',
    CROWN_APP_VERSION: version,
    CROWN_APP_ROOT: expected.appRoot,
    CROWN_VERSION_ROOT: expected.versionRoot,
    CROWN_APP_DIR: expected.appDir,
    CROWN_NODE_EXECUTABLE_PATH: expected.nodeExe,
    CROWN_CHROMIUM_EXECUTABLE_PATH: expected.chromiumExe,
    CROWN_DATA_ROOT: expected.dataRoot,
    CROWN_DB_PATH: expected.dbPath,
    CROWN_LOCAL_SECRET_KEY_PATH: expected.secretKeyPath,
    CROWN_CONFIG_DIR: expected.configDir,
    CROWN_RUNTIME_DIR: expected.runtimeDir,
    CROWN_SESSION_DIR: expected.sessionDir,
    CROWN_BROWSER_PROFILE_DIR: expected.profileDir,
    CROWN_LOG_DIR: expected.logDir,
    CROWN_UPDATE_DIR: expected.updateDir,
    CROWN_BACKUP_DIR: expected.backupDir,
    CROWN_STATIC_DIR: expected.staticDir,
  }
}
