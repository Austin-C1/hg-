import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

const MANIFEST_NAME = 'release-files.json'
const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const DEFAULT_FORBIDDEN_NAMES = Object.freeze([
  'crown-bet-bootstrap.mjs',
  'crown-bet-execute.mjs',
  'crown-bet-execute-sequence.mjs',
  'crown-betting-candidate-dry-run.mjs',
  'telegram-settings.json',
])
const DEFAULT_FORBIDDEN_SEGMENTS = Object.freeze([
  'tests', 'fixtures', 'storage', 'data/runtime', 'session', 'profile', 'logs', 'src/crown/update',
])
const DEFAULT_FORBIDDEN_EXTENSIONS = Object.freeze([
  '.env', '.sqlite', '.sqlite3', '.db', '.key', '.pem', '.log',
])
const DEFAULT_ALLOWED_LITERALS = Object.freeze(['127.0.0.1', 'Asia/Shanghai'])
const ALLOWED_SOURCE_STORAGE_MODULES = Object.freeze([
  'src/crown/storage/jsonl-store.mjs',
  'src/crown/storage/jsonl-candidate-store.mjs',
  'src/crown/storage/jsonl-v2-audit-store.mjs',
])
const SOURCE_FORBIDDEN_SEGMENTS = Object.freeze([
  ['tests'], ['fixtures'], ['session'], ['sessions'], ['profile'], ['profiles'],
  ['log'], ['logs'], ['storage'], ['data', 'runtime'],
])
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{32,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/,
  /\b[0-9]{6,}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bCookie\s*:\s*[A-Za-z0-9_.-]+=[^\r\n]{8,}/i,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{12,}/i,
]

function codedError(code, details) {
  const error = new Error(code)
  if (details !== undefined) error.details = details
  return error
}

function posixPath(value) {
  return value.split(sep).join('/')
}

function contained(root, candidate) {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function strictManifestPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.startsWith('/')) return false
  const parts = value.split('/')
  return parts.every((part) => {
    if (part === '' || part === '.' || part === '..' || part.includes(':')
      || /[\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) return false
    const stem = part.split('.')[0].toUpperCase()
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
  })
}

function windowsPathKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US')
}

async function collectFiles(root, { excludeManifest = false } = {}) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      const path = posixPath(relative(root, absolute))
      if (!contained(root, absolute)) throw codedError('release-audit-path-escape')
      if (entry.isSymbolicLink()) {
        files.push({ path, absolute, kind: 'link' })
      } else if (entry.isDirectory()) {
        await visit(absolute)
      } else if (entry.isFile()) {
        const metadata = await lstat(absolute, { bigint: true })
        const kind = metadata.nlink > 1n ? 'link' : 'file'
        if (!excludeManifest || path !== MANIFEST_NAME) files.push({ path, absolute, kind })
      } else {
        files.push({ path, absolute, kind: 'special' })
      }
    }
  }
  await visit(root)
  return files
}

async function hashFile(path) {
  const pathBefore = await lstat(path, { bigint: true })
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink > 1n) {
    throw codedError('release-artifact-link-forbidden')
  }
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let size = 0
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!sameStableMetadata(pathBefore, openedBefore)) throw codedError('release-artifact-changed')
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      size += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (!sameStableMetadata(openedBefore, openedAfter) || !sameStableMetadata(openedAfter, pathAfter)) {
      throw codedError('release-artifact-changed')
    }
  } finally {
    await handle.close()
  }
  return { size, sha256: hash.digest('hex') }
}

function sameStableMetadata(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink)
}

export async function createReleaseFileManifest({ root, version, manifestName = MANIFEST_NAME } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw codedError('release-root-invalid')
  if (!VERSION.test(version || '')) throw codedError('release-version-invalid')
  if (manifestName !== MANIFEST_NAME) throw codedError('release-manifest-name-invalid')
  const resolvedRoot = resolve(root)
  const entries = await collectFiles(resolvedRoot, { excludeManifest: true })
  const files = []
  for (const entry of entries) {
    if (entry.kind !== 'file') throw codedError('release-artifact-link-forbidden')
    const digest = await hashFile(entry.absolute)
    files.push(Object.freeze({ path: entry.path, ...digest }))
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return Object.freeze({ schemaVersion: 1, version, files: Object.freeze(files) })
}

function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'files,schemaVersion,version'
    || value.schemaVersion !== 1
    || !VERSION.test(value.version || '')
    || !Array.isArray(value.files)) throw codedError('release-manifest-invalid')
  const seen = new Set()
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'path,sha256,size'
      || !strictManifestPath(entry.path)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !SHA256.test(entry.sha256 || '')
      || seen.has(windowsPathKey(entry.path))) throw codedError('release-manifest-invalid')
    seen.add(windowsPathKey(entry.path))
    return Object.freeze({ path: entry.path, size: entry.size, sha256: entry.sha256 })
  })
  return Object.freeze({ schemaVersion: 1, version: value.version, files: Object.freeze(files) })
}

function auditPolicy(value) {
  const source = value && typeof value === 'object' ? value : {}
  const list = (field, fallback) => {
    const candidate = source[field]
    if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === 'string' && item !== '')) {
      return fallback
    }
    return candidate
  }
  const allowedSourceStorageModules = source.allowedSourceStorageModules === undefined
    ? ALLOWED_SOURCE_STORAGE_MODULES
    : list('allowedSourceStorageModules', [])
  const exactStorageAllowlist = allowedSourceStorageModules.slice().sort().join('\0')
    === ALLOWED_SOURCE_STORAGE_MODULES.slice().sort().join('\0')
    ? allowedSourceStorageModules
    : []
  const requiredArtifactFiles = Array.isArray(source.launcherFiles)
    ? source.launcherFiles
      .map((entry) => entry?.target)
      .filter((target) => typeof target === 'string' && strictManifestPath(target))
    : []
  return Object.freeze({
    forbiddenArtifactNames: new Set(list('forbiddenArtifactNames', DEFAULT_FORBIDDEN_NAMES).map((item) => item.toLowerCase())),
    forbiddenArtifactSegments: list('forbiddenArtifactSegments', DEFAULT_FORBIDDEN_SEGMENTS)
      .map((item) => item.toLowerCase().split('/')),
    forbiddenArtifactExtensions: list('forbiddenArtifactExtensions', DEFAULT_FORBIDDEN_EXTENSIONS)
      .map((item) => item.toLowerCase()),
    allowedContentLiterals: Object.freeze([...list('allowedContentLiterals', DEFAULT_ALLOWED_LITERALS)]),
    allowedSourceStorageModules: new Set(exactStorageAllowlist),
    requiredArtifactFiles: new Set(requiredArtifactFiles),
  })
}

function pathFinding(path, policy) {
  const originalSegments = path.split('/')
  const lower = path.toLowerCase()
  const segments = lower.split('/')
  const file = segments.at(-1)
  const extension = extname(file)
  const appIndex = segments.indexOf('app')
  const appSegments = appIndex >= 0 ? segments.slice(appIndex + 1) : []
  const appRelative = appIndex >= 0 ? originalSegments.slice(appIndex + 1).join('/') : ''
  const inDependency = appSegments[0] === 'node_modules'
  const inSource = appSegments[0] === 'src'
  if (file === '.env' || file.startsWith('.env.') || policy.forbiddenArtifactNames.has(file)
    || policy.forbiddenArtifactExtensions.some((item) => extension === item || file.includes(`${item}-`) || file.includes(`${item}.`))) {
    return 'forbidden-artifact-path'
  }
  if (inSource) {
    for (const forbidden of SOURCE_FORBIDDEN_SEGMENTS) {
      const found = appSegments.some((part, index) => forbidden.every(
        (expected, offset) => appSegments[index + offset] === expected,
      ))
      if (!found) continue
      if (forbidden.length === 1 && forbidden[0] === 'storage'
        && policy.allowedSourceStorageModules.has(appRelative)) continue
      return 'forbidden-artifact-path'
    }
  }
  if (!inDependency) {
    for (const forbidden of policy.forbiddenArtifactSegments) {
      if (appSegments.some((part, index) => forbidden.every((expected, offset) => appSegments[index + offset] === expected))) {
        if (inSource && forbidden.length === 1 && forbidden[0] === 'storage'
          && policy.allowedSourceStorageModules.has(appRelative)) continue
        return 'forbidden-artifact-path'
      }
    }
  }
  return null
}

async function readLikelyText(path) {
  const metadata = await lstat(path)
  if (metadata.size === 0) return ''
  const handle = await open(path, 'r')
  const sample = Buffer.alloc(Math.min(metadata.size, 8192))
  try {
    await handle.read(sample, 0, sample.length, 0)
  } finally {
    await handle.close()
  }
  if (sample.includes(0)) return null
  if (metadata.size > 16 * 1024 * 1024) return null
  return readFile(path, 'utf8')
}

async function scanOpaqueFile({ path, sourceRoot, developerUsernames }) {
  const forwardSlash = '/'
  const backwardSlash = String.fromCharCode(92)
  const literalChecks = [
    { code: 'local-user-path', value: ['c:', 'users', ''].join(backwardSlash) },
    { code: 'local-user-path', value: ['c:', 'users', ''].join(forwardSlash) },
  ]
  const desktopChecks = [
    ['', 'desktop', ''].join(backwardSlash),
    ['', 'desktop', ''].join(forwardSlash),
  ]
  for (const username of developerUsernames) {
    const value = String(username || '').trim()
    if (value.length >= 3) literalChecks.push({ code: 'developer-username', value: value.toLowerCase() })
  }
  const rawChecks = normalizedVariants(sourceRoot).map((value) => ({
    code: 'repository-path',
    value: Buffer.from(value, 'utf8'),
  }))
  const maxLength = Math.max(
    4096,
    1,
    ...literalChecks.map((entry) => entry.value.length),
    ...rawChecks.map((entry) => entry.value.length),
  )
  const findings = new Set()
  let sawDesktop = false
  const handle = await open(path, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let carry = Buffer.alloc(0)
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const combined = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
      const lower = combined.toString('latin1').toLowerCase()
      for (const entry of literalChecks) {
        if (lower.includes(entry.value)) findings.add(entry.code)
      }
      if (desktopChecks.some((value) => lower.includes(value))) sawDesktop = true
      for (const entry of rawChecks) {
        if (combined.indexOf(entry.value) >= 0) findings.add(entry.code)
      }
      if (SECRET_PATTERNS.some((pattern) => pattern.test(combined.toString('latin1')))) {
        findings.add('secret-material')
      }
      carry = combined.subarray(Math.max(0, combined.length - maxLength + 1))
    }
  } finally {
    await handle.close()
  }
  if (findings.has('local-user-path') && sawDesktop) findings.add('desktop-path')
  return findings
}

function normalizedVariants(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const normalized = resolve(value)
  return [...new Set([normalized, normalized.replaceAll('\\', '/'), normalized.replaceAll('/', '\\')])]
}

function addFinding(findings, code, path) {
  if (!findings.some((item) => item.code === code && item.path === path)) findings.push({ code, path })
}

function scanText({ text, path, findings, sourceRoot, developerUsernames, skipDependencyRules }) {
  const decoded = text.replaceAll('\\\\', '\\')
  const views = decoded === text ? [text] : [text, decoded]
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) addFinding(findings, 'secret-material', path)
  if (skipDependencyRules) return
  if (views.some((value) => /\b[A-Za-z]:[\\/](?![\\/])Users[\\/](?![\\/])/i.test(value))) {
    addFinding(findings, 'local-user-path', path)
  }
  if (views.some((value) => /(?<![\\/])[\\/](?![\\/])Desktop[\\/](?![\\/])/i.test(value))) {
    addFinding(findings, 'desktop-path', path)
  }
  for (const variant of normalizedVariants(sourceRoot)) {
    if (text.toLowerCase().includes(variant.toLowerCase())) addFinding(findings, 'repository-path', path)
  }
  for (const username of developerUsernames) {
    const value = String(username || '').trim()
    if (value.length >= 3 && new RegExp(`(^|[^A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(text)) {
      addFinding(findings, 'developer-username', path)
    }
  }
  if (views.some((value) => /(?:^|[\s"'])(?:HTTP|HTTPS|ALL)_PROXY\s*=/im.test(value)
    || /https?:\/\/(?:127\.0\.0\.1|localhost):(?:7890|8080|1080)\b/i.test(value))) {
    addFinding(findings, 'local-proxy', path)
  }
  if (views.some((value) => /(?:^|[^A-Za-z0-9_\\])[A-Z]:[\\/](?![\\/])[^\r\n"'`]{2,}/.test(value))) {
    addFinding(findings, 'undeclared-drive-path', path)
  }
  if (views.some((value) => /\bmsedge\.exe\b/i.test(value)
    || /[\\/]Microsoft[\\/]Edge[\\/]Application[\\/]/i.test(value)
    || /[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe\b/i.test(value)
    || /\b(?:channel|CROWN_BROWSER_CHANNEL)\s*[:=]\s*['"]?(?:msedge|chrome)['"]?/i.test(value))) {
    addFinding(findings, 'system-browser', path)
  }
}

export async function scanReleaseArtifacts({
  root,
  sourceRoot,
  developerUsernames = [process.env.USERNAME, process.env.USER],
  manifestName = MANIFEST_NAME,
  policy,
} = {}) {
  const findings = []
  if (typeof root !== 'string' || !isAbsolute(root)) throw codedError('release-root-invalid')
  if (manifestName !== MANIFEST_NAME) throw codedError('release-manifest-name-invalid')
  const resolvedRoot = resolve(root)
  const resolvedPolicy = auditPolicy(policy)
  let manifest
  try {
    manifest = parseManifest(JSON.parse(await readFile(resolve(resolvedRoot, manifestName), 'utf8')))
  } catch (error) {
    if (error?.message === 'release-manifest-invalid') throw error
    throw codedError('release-manifest-invalid')
  }
  const actual = await collectFiles(resolvedRoot)
  const actualFiles = new Map()
  for (const entry of actual) {
    if (entry.kind !== 'file') {
      addFinding(findings, 'artifact-link-forbidden', entry.path)
      continue
    }
    actualFiles.set(entry.path, entry)
  }
  for (const path of resolvedPolicy.requiredArtifactFiles) {
    const entry = actualFiles.get(path)
    if (!entry) {
      addFinding(findings, 'required-artifact-missing', path)
      continue
    }
    const metadata = await lstat(entry.absolute)
    if (metadata.size === 0) addFinding(findings, 'required-artifact-empty', path)
  }
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]))
  for (const path of actualFiles.keys()) {
    if (path !== manifestName && !expected.has(path)) addFinding(findings, 'manifest-extra-file', path)
  }
  for (const entry of manifest.files) {
    const actualEntry = actualFiles.get(entry.path)
    if (!actualEntry) {
      addFinding(findings, 'manifest-missing-file', entry.path)
      continue
    }
    const digest = await hashFile(actualEntry.absolute)
    if (digest.size !== entry.size) addFinding(findings, 'manifest-size-mismatch', entry.path)
    if (digest.sha256 !== entry.sha256) addFinding(findings, 'manifest-hash-mismatch', entry.path)
  }
  for (const entry of actualFiles.values()) {
    if (entry.path === manifestName) continue
    const forbidden = pathFinding(entry.path, resolvedPolicy)
    if (forbidden) addFinding(findings, forbidden, entry.path)
    const text = await readLikelyText(entry.absolute)
    if (text === null) {
      const opaqueFindings = await scanOpaqueFile({
        path: entry.absolute,
        sourceRoot,
        developerUsernames,
      })
      for (const code of opaqueFindings) addFinding(findings, code, entry.path)
      continue
    }
    const lowerPath = entry.path.toLowerCase()
    const skipDependencyRules = lowerPath.includes('/node_modules/')
    scanText({ text, path: entry.path, findings, sourceRoot, developerUsernames, skipDependencyRules })
  }
  findings.sort((left, right) => `${left.path}\0${left.code}`.localeCompare(`${right.path}\0${right.code}`, 'en'))
  return Object.freeze({
    ok: findings.length === 0,
    version: manifest.version,
    fileCount: actualFiles.size,
    manifestFileCount: manifest.files.length,
    allowedContentLiterals: resolvedPolicy.allowedContentLiterals,
    findings: Object.freeze(findings.map((item) => Object.freeze(item))),
  })
}

export async function auditReleaseArtifacts(options = {}) {
  const report = await scanReleaseArtifacts(options)
  if (!report.ok) throw codedError('release-audit-failed', report)
  return report
}

export const RELEASE_FILE_MANIFEST_NAME = MANIFEST_NAME
