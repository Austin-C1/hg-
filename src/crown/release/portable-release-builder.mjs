import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  auditReleaseArtifacts,
  createReleaseFileManifest,
  RELEASE_FILE_MANIFEST_NAME,
} from './release-audit.mjs'

const execFileAsync = promisify(execFile)
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_RELATIVE = /^(?![./])(?:[^<>:"|?*\\/]+\/)*[^<>:"|?*\\/]+$/
const ALLOWED_SOURCE_STORAGE_MODULES = Object.freeze([
  'src/crown/storage/jsonl-store.mjs',
  'src/crown/storage/jsonl-candidate-store.mjs',
  'src/crown/storage/jsonl-v2-audit-store.mjs',
])

function codedError(code) {
  return new Error(code)
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

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

async function stableFileDigest(path) {
  const pathBefore = await lstat(path, { bigint: true })
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink > 1n) {
    throw codedError('release-source-link-forbidden')
  }
  const handle = await open(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let size = 0
  try {
    const openedBefore = await handle.stat({ bigint: true })
    if (!sameStableMetadata(pathBefore, openedBefore)) throw codedError('release-source-changed')
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      size += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    const openedAfter = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (!sameStableMetadata(openedBefore, openedAfter) || !sameStableMetadata(openedAfter, pathAfter)) {
      throw codedError('release-source-changed')
    }
    return Object.freeze({
      dev: pathAfter.dev.toString(),
      ino: pathAfter.ino.toString(),
      size,
      sha256: hash.digest('hex'),
    })
  } finally {
    await handle.close()
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function safeRelativePath(value) {
  return typeof value === 'string' && SAFE_RELATIVE.test(value)
    && value.split('/').every((part) => part !== '.' && part !== '..')
}

function resolveInside(root, relativePath) {
  if (!safeRelativePath(relativePath)) throw codedError('release-allowlist-invalid')
  const candidate = resolve(root, ...relativePath.split('/'))
  const fromRoot = relative(root, candidate)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw codedError('release-allowlist-invalid')
  }
  return candidate
}

function expectStringArray(value) {
  return Array.isArray(value) && value.every(safeRelativePath) && new Set(value).size === value.length
}

function parseAllowlist(value) {
  const keys = [
    'allowedContentLiterals', 'allowedSourceStorageModules', 'appFiles', 'appTrees', 'artifactManifest',
    'forbiddenArtifactExtensions', 'forbiddenArtifactNames', 'forbiddenArtifactSegments',
    'launcherFiles', 'productionDependencies', 'schemaVersion',
  ]
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1
    || value.artifactManifest !== RELEASE_FILE_MANIFEST_NAME
    || !expectStringArray(value.appFiles)
    || !expectStringArray(value.appTrees)
    || !expectStringArray(value.allowedSourceStorageModules)
    || value.allowedSourceStorageModules.slice().sort().join('\0') !== ALLOWED_SOURCE_STORAGE_MODULES.slice().sort().join('\0')
    || !Array.isArray(value.allowedContentLiterals)
    || !value.allowedContentLiterals.every((item) => item === '127.0.0.1' || item === 'Asia/Shanghai')
    || !Array.isArray(value.forbiddenArtifactSegments)
    || !Array.isArray(value.forbiddenArtifactExtensions)
    || !Array.isArray(value.forbiddenArtifactNames)
    || !Array.isArray(value.launcherFiles)
    || !Array.isArray(value.productionDependencies)) throw codedError('release-allowlist-invalid')
  const launcherTargets = new Set()
  for (const entry of value.launcherFiles) {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'source,target'
      || !safeRelativePath(entry.source) || !safeRelativePath(entry.target)
      || launcherTargets.has(entry.target)) throw codedError('release-allowlist-invalid')
    launcherTargets.add(entry.target)
  }
  const dependencyNames = new Set()
  for (const entry of value.productionDependencies) {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'direct,name,version'
      || typeof entry.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.name)
      || !VERSION.test(entry.version || '') || typeof entry.direct !== 'boolean'
      || dependencyNames.has(entry.name)) throw codedError('release-allowlist-invalid')
    dependencyNames.add(entry.name)
  }
  return Object.freeze(value)
}

function parseRuntimeLock(value) {
  if (!isPlainObject(value)
    || Object.keys(value).sort().join(',') !== 'arch,chromium,node,platform,schemaVersion'
    || value.schemaVersion !== 1 || value.platform !== 'win32' || value.arch !== 'x64'
    || !isPlainObject(value.node)
    || Object.keys(value.node).sort().join(',') !== 'archiveRoot,archiveSha256,archiveUrl,executable,treeDigestAlgorithm,treeEntries,treeSha256,version'
    || !VERSION.test(value.node.version || '') || !safeRelativePath(value.node.executable)
    || !safeRelativePath(value.node.archiveRoot)
    || !/^https:\/\/nodejs\.org\/dist\//.test(value.node.archiveUrl || '')
    || !/^[a-f0-9]{64}$/.test(value.node.archiveSha256 || '')
    || value.node.treeDigestAlgorithm !== 'crown-runtime-tree-sha256-v1'
    || !/^[a-f0-9]{64}$/.test(value.node.treeSha256 || '')
    || !Number.isSafeInteger(value.node.treeEntries) || value.node.treeEntries < 1
    || !isPlainObject(value.chromium)
    || Object.keys(value.chromium).sort().join(',') !== 'archiveRoot,archiveSha256,archiveUrl,browserVersion,executable,playwrightVersion,revision,treeDigestAlgorithm,treeEntries,treeSha256'
    || !VERSION.test(value.chromium.playwrightVersion || '')
    || typeof value.chromium.revision !== 'string' || !/^[0-9]+$/.test(value.chromium.revision)
    || typeof value.chromium.browserVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){3}$/.test(value.chromium.browserVersion)
    || !safeRelativePath(value.chromium.executable)
    || !safeRelativePath(value.chromium.archiveRoot)
    || !/^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//.test(value.chromium.archiveUrl || '')
    || !/^[a-f0-9]{64}$/.test(value.chromium.archiveSha256 || '')) throw codedError('release-runtime-lock-invalid')
  if (value.chromium.treeDigestAlgorithm !== 'crown-runtime-tree-sha256-v1'
    || !/^[a-f0-9]{64}$/.test(value.chromium.treeSha256 || '')
    || !Number.isSafeInteger(value.chromium.treeEntries) || value.chromium.treeEntries < 1) {
    throw codedError('release-runtime-lock-invalid')
  }
  return Object.freeze(value)
}

async function executableVersion(executable) {
  try {
    if (/\.(?:cmd|bat)$/i.test(executable)) {
      const command = `"${executable.replaceAll('"', '""')}" --version`
      return await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      })
    }
    return await execFileAsync(executable, ['--version'], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
  } catch {
    throw codedError('release-runtime-version-mismatch')
  }
}

async function windowsFileProductVersion(executable) {
  if (process.platform !== 'win32') throw codedError('release-runtime-version-mismatch')
  const escaped = executable.replaceAll("'", "''")
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::Out.Write([System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escaped}').ProductVersion)`,
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    return result.stdout.trim()
  } catch {
    throw codedError('release-runtime-version-mismatch')
  }
}

async function verifyFormalRuntime({ nodeExecutable, chromiumExecutable, runtimeLock }) {
  const nodeResult = await executableVersion(nodeExecutable)
  if (`${nodeResult.stdout}\n${nodeResult.stderr}`.trim() !== `v${runtimeLock.node.version}`) {
    throw codedError('release-runtime-version-mismatch')
  }
  let chromiumFileVersion = ''
  try {
    chromiumFileVersion = await windowsFileProductVersion(chromiumExecutable)
  } catch {
    // Non-Windows test fixtures and scripts have no Windows version resource.
  }
  if (chromiumFileVersion === runtimeLock.chromium.browserVersion) return
  let chromiumOutput = ''
  try {
    const chromiumResult = await executableVersion(chromiumExecutable)
    chromiumOutput = `${chromiumResult.stdout}\n${chromiumResult.stderr}`
  } catch {
    // GUI executables such as Chrome may return no console output or a non-zero status.
  }
  if (!chromiumOutput.includes(runtimeLock.chromium.browserVersion)) {
    throw codedError('release-runtime-version-mismatch')
  }
}

async function runtimeTreeDigest(root) {
  const records = []
  const seen = new Set()
  async function visit(directory) {
    const names = await readdir(directory)
    names.sort()
    for (const name of names) {
      const absolute = join(directory, name)
      const relativePath = relative(root, absolute).split(sep).join('/').normalize('NFC')
      if (!windowsSafeArtifactPath(relativePath)) throw codedError('release-runtime-tree-invalid')
      const key = relativePath.toLocaleLowerCase('en-US')
      if (seen.has(key)) throw codedError('release-runtime-tree-invalid')
      seen.add(key)
      const metadata = await ensureRegularSource(absolute)
      if (metadata.isDirectory()) {
        records.push(`D\0${relativePath}\n`)
        await visit(absolute)
      } else {
        const digest = await stableFileDigest(absolute)
        records.push(`F\0${relativePath}\0${digest.size}\0${digest.sha256}\n`)
      }
    }
    const finalNames = await readdir(directory)
    finalNames.sort()
    if (names.join('\0') !== finalNames.join('\0')) throw codedError('release-source-changed')
  }
  await visit(root)
  const digest = createHash('sha256').update('crown-runtime-tree-sha256-v1\0')
  for (const record of records) digest.update(record)
  return Object.freeze({ sha256: digest.digest('hex'), entries: records.length })
}

async function verifyFormalRuntimeTrees({ nodeRuntimeDir, chromiumRuntimeDir, runtimeLock }) {
  const nodeTree = await runtimeTreeDigest(resolve(nodeRuntimeDir))
  const chromiumTree = await runtimeTreeDigest(resolve(chromiumRuntimeDir))
  if (nodeTree.sha256 !== runtimeLock.node.treeSha256 || nodeTree.entries !== runtimeLock.node.treeEntries
    || chromiumTree.sha256 !== runtimeLock.chromium.treeSha256
    || chromiumTree.entries !== runtimeLock.chromium.treeEntries) {
    throw codedError('release-runtime-tree-mismatch')
  }
}

async function readJson(path, errorCode) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw codedError(errorCode)
  }
}

async function ensureRegularSource(path) {
  let metadata
  try {
    metadata = await lstat(path, { bigint: true })
  } catch {
    throw codedError('release-source-missing')
  }
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && metadata.nlink > 1n)) {
    throw codedError('release-source-link-forbidden')
  }
  if (!metadata.isDirectory() && !metadata.isFile()) throw codedError('release-source-type-forbidden')
  return metadata
}

async function copyAllowlisted(source, target) {
  const metadata = await ensureRegularSource(source)
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true })
    const entries = await readdir(source)
    entries.sort((left, right) => left.localeCompare(right, 'en'))
    for (const name of entries) await copyAllowlisted(join(source, name), join(target, name))
    const finalEntries = await readdir(source)
    finalEntries.sort((left, right) => left.localeCompare(right, 'en'))
    const finalMetadata = await lstat(source, { bigint: true })
    if (entries.join('\0') !== finalEntries.join('\0')
      || metadata.dev !== finalMetadata.dev || metadata.ino !== finalMetadata.ino) {
      throw codedError('release-source-changed')
    }
    return
  }
  const before = await stableFileDigest(source)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  const after = await stableFileDigest(source)
  const copied = await stableFileDigest(target)
  if (JSON.stringify(before) !== JSON.stringify(after)
    || copied.size !== before.size || copied.sha256 !== before.sha256) {
    throw codedError('release-source-changed')
  }
}

function windowsSafeArtifactPath(path) {
  if (!safeRelativePath(path)) return false
  return path.split('/').every((part) => {
    if (/[\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) return false
    const stem = part.split('.')[0].toUpperCase()
    return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
  })
}

function inputSpecs({ source, staging, appRoot, versionRoot, allowlist, nodeRuntimeDir, chromiumRuntimeDir }) {
  const specs = []
  for (const entry of allowlist.launcherFiles) {
    specs.push({ source: resolveInside(source, entry.source), target: entry.target })
  }
  for (const path of allowlist.appFiles) specs.push({ source: resolveInside(source, path), target: `versions/${basename(versionRoot)}/app/${path}` })
  for (const path of allowlist.appTrees) specs.push({ source: resolveInside(source, path), target: `versions/${basename(versionRoot)}/app/${path}` })
  for (const dependency of allowlist.productionDependencies) {
    const path = `node_modules/${dependency.name}`
    specs.push({ source: resolveInside(source, path), target: `versions/${basename(versionRoot)}/app/${path}` })
  }
  specs.push({ source: resolve(nodeRuntimeDir), target: `versions/${basename(versionRoot)}/runtime/node` })
  specs.push({ source: resolve(chromiumRuntimeDir), target: `versions/${basename(versionRoot)}/runtime/chromium` })
  return specs.map((entry) => ({ ...entry, absoluteTarget: resolveInside(staging, entry.target) }))
}

async function snapshotInputSpecs(specs) {
  const snapshot = new Map()
  async function visit(sourcePath, targetPath) {
    const metadata = await ensureRegularSource(sourcePath)
    const relativeTarget = targetPath.replaceAll('\\', '/')
    if (!windowsSafeArtifactPath(relativeTarget)) throw codedError('release-artifact-path-invalid')
    const key = relativeTarget.normalize('NFC').toLocaleLowerCase('en-US')
    if (snapshot.has(key)) throw codedError('release-artifact-path-conflict')
    if (metadata.isDirectory()) {
      snapshot.set(key, Object.freeze({ path: relativeTarget, kind: 'directory', dev: metadata.dev.toString(), ino: metadata.ino.toString() }))
      const names = await readdir(sourcePath)
      names.sort((left, right) => left.localeCompare(right, 'en'))
      for (const name of names) await visit(join(sourcePath, name), `${relativeTarget}/${name}`)
      const finalNames = await readdir(sourcePath)
      finalNames.sort((left, right) => left.localeCompare(right, 'en'))
      if (names.join('\0') !== finalNames.join('\0')) throw codedError('release-source-changed')
      return
    }
    snapshot.set(key, Object.freeze({ path: relativeTarget, kind: 'file', ...await stableFileDigest(sourcePath) }))
  }
  for (const spec of specs) await visit(spec.source, spec.target)
  return snapshot
}

function sameInputSnapshots(left, right) {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    const other = right.get(key)
    if (!other || JSON.stringify(value) !== JSON.stringify(other)) return false
  }
  return true
}

async function verifyStagedInputs(snapshot, staging) {
  for (const entry of snapshot.values()) {
    const target = resolveInside(staging, entry.path)
    const metadata = await lstat(target, { bigint: true }).catch(() => null)
    if (!metadata) throw codedError('release-staging-mismatch')
    if (entry.kind === 'directory') {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw codedError('release-staging-mismatch')
      continue
    }
    const digest = await stableFileDigest(target)
    if (digest.size !== entry.size || digest.sha256 !== entry.sha256) throw codedError('release-staging-mismatch')
  }
}

async function assertCleanCheckout(sourceRoot) {
  let topLevelResult
  let statusResult
  try {
    topLevelResult = await execFileAsync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', windowsHide: true,
    })
    statusResult = await execFileAsync('git', [
      '-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all',
    ], { encoding: 'utf8', windowsHide: true })
  } catch {
    throw codedError('release-source-not-clean-checkout')
  }
  const topLevel = topLevelResult.stdout
  const statusOutput = statusResult.stdout
  let requestedRoot
  let repositoryRoot
  try {
    [requestedRoot, repositoryRoot] = await Promise.all([
      stat(sourceRoot, { bigint: true }),
      stat(resolve(topLevel.trim()), { bigint: true }),
    ])
  } catch {
    throw codedError('release-source-not-clean-checkout')
  }
  if (!requestedRoot.isDirectory() || !repositoryRoot.isDirectory() || !sameIdentity(requestedRoot, repositoryRoot)) {
    throw codedError('release-source-not-clean-checkout')
  }
  if (statusOutput.trim() !== '') throw codedError('release-source-dirty')
}

async function assertEmptyOutput(outputDir) {
  try {
    const metadata = await stat(outputDir)
    if (!metadata.isDirectory()) throw codedError('release-output-not-empty')
    if ((await readdir(outputDir)).length !== 0) throw codedError('release-output-not-empty')
    await rm(outputDir, { recursive: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    if (error?.message?.startsWith('release-')) throw error
    throw codedError('release-output-unavailable')
  }
}

function validateProductionDependencies({ packageJson, packageLock, allowlist }) {
  const dependencies = packageJson.dependencies || {}
  if (!isPlainObject(dependencies) || !isPlainObject(packageLock.packages)) {
    throw codedError('release-production-dependencies-invalid')
  }
  const declaredDirect = allowlist.productionDependencies.filter((entry) => entry.direct)
  if (Object.keys(dependencies).sort().join(',') !== declaredDirect.map((entry) => entry.name).sort().join(',')) {
    throw codedError('release-production-dependencies-invalid')
  }
  for (const entry of allowlist.productionDependencies) {
    const locked = packageLock.packages[`node_modules/${entry.name}`]
    if (!isPlainObject(locked) || locked.version !== entry.version || (entry.direct && dependencies[entry.name] !== entry.version)) {
      throw codedError('release-production-dependencies-invalid')
    }
  }
  const allowedNames = new Set(allowlist.productionDependencies.map((entry) => entry.name))
  const reachable = new Set()
  const pending = Object.keys(dependencies)
  while (pending.length > 0) {
    const name = pending.pop()
    if (reachable.has(name)) continue
    if (!allowedNames.has(name)) throw codedError('release-production-dependencies-invalid')
    const locked = packageLock.packages[`node_modules/${name}`]
    if (!isPlainObject(locked)) throw codedError('release-production-dependencies-invalid')
    reachable.add(name)
    for (const child of Object.keys(locked.dependencies || {})) pending.push(child)
  }
  if (reachable.size !== allowedNames.size
    || [...allowedNames].some((name) => !reachable.has(name))) {
    throw codedError('release-production-dependencies-invalid')
  }
  const playwright = allowlist.productionDependencies.find((entry) => entry.name === 'playwright')
  if (playwright && playwright.version !== packageJson.dependencies.playwright) {
    throw codedError('release-playwright-lock-mismatch')
  }
}

export async function buildPortableRelease({
  sourceRoot,
  outputDir,
  version,
  nodeRuntimeDir,
  chromiumRuntimeDir,
  formalRelease = false,
  allowlistPath,
  runtimeLockPath,
} = {}) {
  for (const path of [sourceRoot, outputDir, nodeRuntimeDir, chromiumRuntimeDir]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw codedError('release-path-invalid')
  }
  if (!VERSION.test(version || '')) throw codedError('release-version-invalid')
  if (typeof formalRelease !== 'boolean') throw codedError('release-formal-mode-invalid')
  const source = resolve(sourceRoot)
  const output = resolve(outputDir)
  const fromSource = relative(source, output)
  if (fromSource === '' || (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`))) {
    throw codedError('release-output-inside-source')
  }
  if (formalRelease) await assertCleanCheckout(source)
  await assertEmptyOutput(output)

  const resolvedAllowlistPath = allowlistPath
    ? resolve(allowlistPath)
    : resolveInside(source, 'release/windows-production-allowlist.json')
  const resolvedRuntimeLockPath = runtimeLockPath
    ? resolve(runtimeLockPath)
    : resolveInside(source, 'release/windows-runtime-lock.json')
  const allowlist = parseAllowlist(await readJson(resolvedAllowlistPath, 'release-allowlist-invalid'))
  const runtimeLock = parseRuntimeLock(await readJson(resolvedRuntimeLockPath, 'release-runtime-lock-invalid'))
  const packageJson = await readJson(resolveInside(source, 'package.json'), 'release-package-invalid')
  const packageLock = await readJson(resolveInside(source, 'package-lock.json'), 'release-package-lock-invalid')
  if (packageJson.version !== version || packageLock.version !== version) throw codedError('release-version-mismatch')
  validateProductionDependencies({ packageJson, packageLock, allowlist })
  const nodeExecutable = resolveInside(nodeRuntimeDir, runtimeLock.node.executable)
  const chromiumExecutable = resolveInside(chromiumRuntimeDir, runtimeLock.chromium.executable)
  await ensureRegularSource(nodeExecutable)
  await ensureRegularSource(chromiumExecutable)
  if (formalRelease) await verifyFormalRuntimeTrees({
    nodeRuntimeDir, chromiumRuntimeDir, runtimeLock,
  })
  if (formalRelease) await verifyFormalRuntime({ nodeExecutable, chromiumExecutable, runtimeLock })

  const staging = join(dirname(output), `.${basename(output)}.staging-${randomBytes(8).toString('hex')}`)
  const versionRoot = join(staging, 'versions', version)
  const appRoot = join(versionRoot, 'app')
  const specs = inputSpecs({
    source, staging, appRoot, versionRoot, allowlist, nodeRuntimeDir, chromiumRuntimeDir,
  })
  const formalInputSnapshot = formalRelease ? await snapshotInputSpecs(specs) : null
  let published = false
  try {
    await mkdir(staging, { recursive: false })
    for (const entry of allowlist.launcherFiles) {
      await copyAllowlisted(resolveInside(source, entry.source), resolveInside(staging, entry.target))
    }
    for (const path of allowlist.appFiles) {
      await copyAllowlisted(resolveInside(source, path), resolveInside(appRoot, path))
    }
    for (const path of allowlist.appTrees) {
      await copyAllowlisted(resolveInside(source, path), resolveInside(appRoot, path))
    }
    for (const dependency of allowlist.productionDependencies) {
      const packagePath = `node_modules/${dependency.name}`
      await copyAllowlisted(resolveInside(source, packagePath), resolveInside(appRoot, packagePath))
    }
    await copyAllowlisted(resolve(nodeRuntimeDir), join(versionRoot, 'runtime', 'node'))
    await copyAllowlisted(resolve(chromiumRuntimeDir), join(versionRoot, 'runtime', 'chromium'))
    if (formalInputSnapshot) {
      const finalInputSnapshot = await snapshotInputSpecs(specs)
      if (!sameInputSnapshots(formalInputSnapshot, finalInputSnapshot)) {
        throw codedError('release-source-changed')
      }
      await verifyStagedInputs(formalInputSnapshot, staging)
    }
    await writeFile(join(staging, 'current.json'), `${JSON.stringify({ schemaVersion: 1, version })}\n`, {
      encoding: 'utf8', flag: 'wx',
    })
    const manifest = await createReleaseFileManifest({ root: staging, version })
    await writeFile(join(staging, RELEASE_FILE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx',
    })
    await auditReleaseArtifacts({ root: staging, sourceRoot: source, policy: allowlist })
    await rename(staging, output)
    published = true
    if (formalInputSnapshot) {
      await verifyStagedInputs(formalInputSnapshot, output)
      await auditReleaseArtifacts({ root: output, sourceRoot: source, policy: allowlist })
    }
    return Object.freeze({
      root: output,
      appRoot: join(output, 'versions', version, 'app'),
      version,
      manifestPath: join(output, RELEASE_FILE_MANIFEST_NAME),
      fileCount: manifest.files.length + 1,
    })
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (published) await rm(output, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
