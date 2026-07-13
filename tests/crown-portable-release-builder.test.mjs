import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { buildPortableRelease } from '../src/crown/release/portable-release-builder.mjs'
import { auditReleaseArtifacts } from '../src/crown/release/release-audit.mjs'

const execFileAsync = promisify(execFile)
const VERSION = '0.1.0'

async function flatRuntimeTreeDigest(root) {
  const hash = createHash('sha256').update('crown-runtime-tree-sha256-v1\0')
  const names = (await readdir(root)).sort()
  for (const name of names) {
    const contents = await readFile(join(root, name))
    const fileHash = createHash('sha256').update(contents).digest('hex')
    hash.update(`F\0${name}\0${contents.length}\0${fileHash}\n`)
  }
  return { sha256: hash.digest('hex'), entries: names.length }
}

async function write(root, relativePath, contents = relativePath) {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

function fixtureAllowlist() {
  return {
    schemaVersion: 1,
    artifactManifest: 'release-files.json',
    launcherFiles: [
      { source: 'packaging/windows/启动程序.cmd', target: '启动程序.cmd' },
      { source: 'packaging/windows/停止程序.cmd', target: '停止程序.cmd' },
      { source: 'packaging/windows/首次使用说明.txt', target: '首次使用说明.txt' },
      { source: 'packaging/windows/launcher/start.ps1', target: 'launcher/start.ps1' },
      { source: 'packaging/windows/launcher/stop.ps1', target: 'launcher/stop.ps1' },
      { source: 'packaging/windows/launcher/update-bootstrap.ps1', target: 'launcher/update-bootstrap.ps1' },
    ],
    appFiles: [
      'package.json',
      'package-lock.json',
      'config/default-leagues.json',
      'release/windows-runtime-lock.json',
      'release/windows-production-allowlist.json',
      'scripts/crown-dashboard.mjs',
      'scripts/crown-watch.mjs',
      'scripts/crown-betting-worker.mjs',
    ],
    appTrees: ['src', 'frontend/dist'],
    allowedSourceStorageModules: [
      'src/crown/storage/jsonl-store.mjs',
      'src/crown/storage/jsonl-candidate-store.mjs',
      'src/crown/storage/jsonl-v2-audit-store.mjs',
    ],
    productionDependencies: [],
    forbiddenArtifactSegments: [
      'tests', 'fixtures', 'storage', 'data/runtime', 'session', 'profile', 'logs',
    ],
    forbiddenArtifactExtensions: ['.env', '.sqlite', '.sqlite3', '.db', '.key', '.pem', '.log'],
    forbiddenArtifactNames: [
      'crown-bet-bootstrap.mjs',
      'crown-bet-execute.mjs',
      'crown-bet-execute-sequence.mjs',
      'crown-betting-candidate-dry-run.mjs',
      'telegram-settings.json',
    ],
    allowedContentLiterals: ['127.0.0.1', 'Asia/Shanghai'],
  }
}

async function createSourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'crown-portable-source-'))
  const outputDir = join(await mkdtemp(join(tmpdir(), 'crown-portable-output-parent-')), 'CrownMonitor')
  const nodeRuntimeDir = join(await mkdtemp(join(tmpdir(), 'crown-node-runtime-')), 'node')
  const chromiumRuntimeDir = join(await mkdtemp(join(tmpdir(), 'crown-chromium-runtime-')), 'chromium')
  const allowlist = fixtureAllowlist()
  const runtimeLock = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    node: {
      version: '22.22.0',
      executable: 'node.exe',
      archiveUrl: 'https://nodejs.org/dist/v22.22.0/node-v22.22.0-win-x64.zip',
      archiveSha256: '1'.repeat(64),
      archiveRoot: 'node-v22.22.0-win-x64',
      treeDigestAlgorithm: 'crown-runtime-tree-sha256-v1',
      treeSha256: '3'.repeat(64),
      treeEntries: 2,
    },
    chromium: {
      playwrightVersion: '1.61.1',
      revision: '1228',
      browserVersion: '149.0.7827.55',
      executable: 'chrome.exe',
      archiveUrl: 'https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.55/win64/chrome-win64.zip',
      archiveSha256: '2'.repeat(64),
      archiveRoot: 'chrome-win64',
      treeDigestAlgorithm: 'crown-runtime-tree-sha256-v1',
      treeSha256: '4'.repeat(64),
      treeEntries: 2,
    },
  }

  for (const entry of allowlist.launcherFiles) await write(root, entry.source)
  await write(root, 'package.json', `${JSON.stringify({
    name: 'fixture', version: VERSION, type: 'module', dependencies: {},
  })}\n`)
  await write(root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture', version: VERSION, lockfileVersion: 3, requires: true,
    packages: { '': { name: 'fixture', version: VERSION, dependencies: {} } },
  })}\n`)
  await cp(join(process.cwd(), 'config/default-leagues.json'), join(root, 'config/default-leagues.json'))
  await write(root, 'release/windows-runtime-lock.json', `${JSON.stringify(runtimeLock)}\n`)
  await write(root, 'release/windows-production-allowlist.json', `${JSON.stringify(allowlist)}\n`)
  await write(root, 'scripts/crown-dashboard.mjs', 'export const dashboard = true\n')
  await write(root, 'scripts/crown-watch.mjs', 'export const watcher = true\n')
  await write(root, 'scripts/crown-betting-worker.mjs', 'export const worker = true\n')
  await write(root, 'src/crown/main.mjs', "export const loopback = '127.0.0.1'\n")
  await write(root, 'src/crown/storage/jsonl-store.mjs', 'export const storageModule = true\n')
  await write(root, 'src/crown/storage/jsonl-candidate-store.mjs', 'export const candidateStoreModule = true\n')
  await write(root, 'src/crown/storage/jsonl-v2-audit-store.mjs', 'export const auditStoreModule = true\n')
  await write(root, 'src/crown/telegram/index.mjs', 'export const telegramModule = true\n')
  await write(root, 'frontend/dist/index.html', '<!doctype html><title>Crown</title>')
  await write(nodeRuntimeDir, 'node.exe', 'fake bundled node')
  await write(nodeRuntimeDir, 'LICENSE', 'node license')
  await write(chromiumRuntimeDir, 'chrome.exe', 'fake bundled chromium')
  await write(chromiumRuntimeDir, 'LICENSE', 'chromium license')

  for (const forbidden of [
    'tests/should-not-ship.test.mjs',
    'data/fixtures/private.json',
    '.env',
    'storage/crown.sqlite',
    'data/runtime/event.jsonl',
    'config/telegram-settings.json',
    'config/private.key',
    'config/private.pem',
    'data/session/cookies.json',
    'data/profile/state.json',
    'logs/crown.log',
    'scripts/crown-bet-execute.mjs',
  ]) await write(root, forbidden, 'must not ship')

  return { root, outputDir, nodeRuntimeDir, chromiumRuntimeDir }
}

async function removeFixture(fixture) {
  await Promise.all([
    rm(fixture.root, { recursive: true, force: true }),
    rm(dirname(fixture.outputDir), { recursive: true, force: true }),
    rm(dirname(fixture.nodeRuntimeDir), { recursive: true, force: true }),
    rm(dirname(fixture.chromiumRuntimeDir), { recursive: true, force: true }),
  ])
}

test('portable release stages only the explicit production allowlist and the 118-league seed', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))

  const result = await buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
  })
  const appRoot = join(result.root, 'versions', VERSION, 'app')
  assert.equal(existsSync(join(appRoot, 'scripts/crown-watch.mjs')), true)
  assert.equal(existsSync(join(appRoot, 'scripts/crown-betting-worker.mjs')), true)
  assert.equal(existsSync(join(appRoot, 'frontend/dist/index.html')), true)
  assert.equal(existsSync(join(appRoot, 'src/crown/storage/jsonl-store.mjs')), true)
  assert.equal(existsSync(join(appRoot, 'src/crown/telegram/index.mjs')), true)
  assert.equal(existsSync(join(result.root, 'versions', VERSION, 'runtime/node/node.exe')), true)
  assert.equal(existsSync(join(result.root, 'versions', VERSION, 'runtime/chromium/chrome.exe')), true)
  assert.equal(JSON.parse(await readFile(join(appRoot, 'config/default-leagues.json'))).leagues.length, 118)
  assert.deepEqual(JSON.parse(await readFile(join(result.root, 'current.json'))), {
    schemaVersion: 1,
    version: VERSION,
  })

  for (const forbidden of [
    'tests', 'data', '.env', 'storage', 'config/telegram-settings.json', 'config/private.key',
    'config/private.pem', 'logs', 'scripts/crown-bet-execute.mjs',
  ]) assert.equal(existsSync(join(appRoot, forbidden)), false, forbidden)

  const report = await auditReleaseArtifacts({
    root: result.root, sourceRoot: fixture.root, policy: fixtureAllowlist(),
  })
  assert.equal(report.ok, true)
  assert.equal(report.fileCount, report.manifestFileCount + 1)
})

test('portable release rejects symlinks inside an allowlisted source tree', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  const external = await write(fixture.root, 'outside.txt', 'outside')
  try {
    await link(external, join(fixture.root, 'src', 'linked.txt'))
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('hard links are unavailable on this Windows volume')
    throw error
  }
  await assert.rejects(buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
  }), /release-source-link-forbidden/)
})

test('portable release rejects tests and fixtures nested anywhere under src', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  await write(fixture.root, 'src/crown/deep/tests/private.test.mjs', 'private test')
  await write(fixture.root, 'src/crown/deep/fixtures/session.json', '{"private":true}')
  await assert.rejects(buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
  }), /release-audit-failed/)
})

test('formal release refuses a dirty checkout and any recursive output location', async (t) => {
  const dirty = await createSourceFixture()
  const recursive = await createSourceFixture()
  t.after(async () => {
    await removeFixture(dirty)
    await removeFixture(recursive)
  })
  await execFileAsync('git', ['init', dirty.root])
  await execFileAsync('git', ['-C', dirty.root, 'config', 'user.email', 'release-test@example.test'])
  await execFileAsync('git', ['-C', dirty.root, 'config', 'user.name', 'Release Test'])
  await execFileAsync('git', ['-C', dirty.root, 'add', '.'])
  await execFileAsync('git', ['-C', dirty.root, 'commit', '-m', 'fixture'])
  await write(dirty.root, 'src/crown/main.mjs', 'dirty\n')

  await assert.rejects(buildPortableRelease({
    sourceRoot: dirty.root,
    outputDir: dirty.outputDir,
    version: VERSION,
    nodeRuntimeDir: dirty.nodeRuntimeDir,
    chromiumRuntimeDir: dirty.chromiumRuntimeDir,
    formalRelease: true,
  }), /release-source-dirty/)

  await assert.rejects(buildPortableRelease({
    sourceRoot: recursive.root,
    outputDir: join(recursive.root, 'dist', 'portable'),
    version: VERSION,
    nodeRuntimeDir: recursive.nodeRuntimeDir,
    chromiumRuntimeDir: recursive.chromiumRuntimeDir,
  }), /release-output-inside-source/)
})

test('portable release rejects an incomplete production dependency closure', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  const allowlist = fixtureAllowlist()
  allowlist.productionDependencies = [{ name: 'alpha', version: '1.0.0', direct: true }]
  await write(fixture.root, 'release/windows-production-allowlist.json', `${JSON.stringify(allowlist)}\n`)
  await write(fixture.root, 'package.json', `${JSON.stringify({
    name: 'fixture', version: VERSION, type: 'module', dependencies: { alpha: '1.0.0' },
  })}\n`)
  await write(fixture.root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture', version: VERSION, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'fixture', version: VERSION, dependencies: { alpha: '1.0.0' } },
      'node_modules/alpha': { version: '1.0.0', dependencies: { beta: '2.0.0' } },
      'node_modules/beta': { version: '2.0.0' },
    },
  })}\n`)
  await write(fixture.root, 'node_modules/alpha/package.json', '{"name":"alpha","version":"1.0.0"}\n')

  await assert.rejects(buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
  }), /release-production-dependencies-invalid/)
})

test('formal release verifies the runtime executable versions instead of trusting their names', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  const runtimeLock = JSON.parse(await readFile(join(fixture.root, 'release/windows-runtime-lock.json'), 'utf8'))
  runtimeLock.node.executable = 'node.cmd'
  runtimeLock.chromium.executable = 'chrome.cmd'
  await write(fixture.nodeRuntimeDir, 'node.cmd', '@echo v0.0.0\r\n')
  await write(fixture.chromiumRuntimeDir, 'chrome.cmd', '@echo Chromium 0.0.0.0\r\n')
  const nodeTree = await flatRuntimeTreeDigest(fixture.nodeRuntimeDir)
  const chromiumTree = await flatRuntimeTreeDigest(fixture.chromiumRuntimeDir)
  Object.assign(runtimeLock.node, { treeSha256: nodeTree.sha256, treeEntries: nodeTree.entries })
  Object.assign(runtimeLock.chromium, { treeSha256: chromiumTree.sha256, treeEntries: chromiumTree.entries })
  await write(fixture.root, 'release/windows-runtime-lock.json', `${JSON.stringify(runtimeLock)}\n`)
  await execFileAsync('git', ['init', fixture.root])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.email', 'release-test@example.test'])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.name', 'Release Test'])
  await execFileAsync('git', ['-C', fixture.root, 'add', '.'])
  await execFileAsync('git', ['-C', fixture.root, 'commit', '-m', 'fixture'])

  await assert.rejects(buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
    formalRelease: true,
  }), /release-runtime-version-mismatch/)
})

test('formal release verifies complete runtime trees before executing either runtime', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  const marker = join(dirname(fixture.outputDir), 'runtime-executed.marker')
  const runtimeLock = JSON.parse(await readFile(join(fixture.root, 'release/windows-runtime-lock.json'), 'utf8'))
  runtimeLock.node.executable = 'node.cmd'
  runtimeLock.chromium.executable = 'chrome.cmd'
  await write(fixture.root, 'release/windows-runtime-lock.json', `${JSON.stringify(runtimeLock)}\n`)
  await write(fixture.nodeRuntimeDir, 'node.cmd', `@echo executed>>"${marker}"\r\n@echo v${runtimeLock.node.version}\r\n`)
  await write(fixture.chromiumRuntimeDir, 'chrome.cmd', `@echo executed>>"${marker}"\r\n@echo Chromium ${runtimeLock.chromium.browserVersion}\r\n`)
  await execFileAsync('git', ['init', fixture.root])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.email', 'release-test@example.test'])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.name', 'Release Test'])
  await execFileAsync('git', ['-C', fixture.root, 'add', '.'])
  await execFileAsync('git', ['-C', fixture.root, 'commit', '-m', 'fixture'])

  await assert.rejects(buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
    formalRelease: true,
  }), /release-runtime-tree-mismatch/)
  assert.equal(existsSync(marker), false)
})

test('formal release falls back to Windows file metadata when a GUI runtime prints no usable version', async (t) => {
  const fixture = await createSourceFixture()
  t.after(() => removeFixture(fixture))
  const chromiumSource = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
  await copyFile(process.execPath, join(fixture.nodeRuntimeDir, 'node.exe'))
  await copyFile(chromiumSource, join(fixture.chromiumRuntimeDir, 'chrome.exe'))
  const escaped = chromiumSource.replaceAll("'", "''")
  const versionResult = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::Out.Write([System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escaped}').ProductVersion)`,
  ], { encoding: 'utf8' })
  const runtimeLock = JSON.parse(await readFile(join(fixture.root, 'release/windows-runtime-lock.json'), 'utf8'))
  runtimeLock.node.version = process.version.slice(1)
  runtimeLock.chromium.browserVersion = versionResult.stdout.trim()
  const nodeTree = await flatRuntimeTreeDigest(fixture.nodeRuntimeDir)
  const chromiumTree = await flatRuntimeTreeDigest(fixture.chromiumRuntimeDir)
  Object.assign(runtimeLock.node, { treeSha256: nodeTree.sha256, treeEntries: nodeTree.entries })
  Object.assign(runtimeLock.chromium, { treeSha256: chromiumTree.sha256, treeEntries: chromiumTree.entries })
  await write(fixture.root, 'release/windows-runtime-lock.json', `${JSON.stringify(runtimeLock)}\n`)
  await execFileAsync('git', ['init', fixture.root])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.email', 'release-test@example.test'])
  await execFileAsync('git', ['-C', fixture.root, 'config', 'user.name', 'Release Test'])
  await execFileAsync('git', ['-C', fixture.root, 'add', '.'])
  await execFileAsync('git', ['-C', fixture.root, 'commit', '-m', 'fixture'])

  const result = await buildPortableRelease({
    sourceRoot: fixture.root,
    outputDir: fixture.outputDir,
    version: VERSION,
    nodeRuntimeDir: fixture.nodeRuntimeDir,
    chromiumRuntimeDir: fixture.chromiumRuntimeDir,
    formalRelease: true,
  })
  assert.equal(result.version, VERSION)
})

test('production allowlist pins Playwright and excludes superseded and private artifacts', async () => {
  const allowlist = JSON.parse(await readFile('release/windows-production-allowlist.json', 'utf8'))
  const runtimeLock = JSON.parse(await readFile('release/windows-runtime-lock.json', 'utf8'))
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(pkg.dependencies.playwright, '1.61.1')
  assert.equal(pkg.devDependencies?.playwright, undefined)
  assert.equal(runtimeLock.chromium.playwrightVersion, pkg.dependencies.playwright)
  assert.equal(runtimeLock.node.version, '22.23.1')
  assert.equal(runtimeLock.node.archiveUrl, 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip')
  assert.equal(runtimeLock.node.archiveSha256, '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29')
  assert.equal(runtimeLock.node.archiveRoot, 'node-v22.23.1-win-x64')
  assert.equal(runtimeLock.node.treeSha256, '59b2b74a39116deb4b0baf42332c9bd0386b8ef1fb766e807d87095aae6ef8e6')
  assert.equal(runtimeLock.node.treeEntries, 2539)
  assert.equal(runtimeLock.chromium.archiveUrl, 'https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.55/win64/chrome-win64.zip')
  assert.equal(runtimeLock.chromium.archiveSha256, 'ebc0c2b75e2ea98151a7f18ff47037bfcbab44a8660e79b9ffa6520f9b7607ab')
  assert.equal(runtimeLock.chromium.archiveRoot, 'chrome-win64')
  assert.equal(runtimeLock.chromium.treeSha256, 'c6036d7646de33fe81487a369e00b3beb92dbc0333e46e4ccadf6caa7008adba')
  assert.equal(runtimeLock.chromium.treeEntries, 316)
  assert.equal(runtimeLock.platform, 'win32')
  assert.equal(runtimeLock.arch, 'x64')
  assert.deepEqual(allowlist.productionDependencies.map((entry) => entry.name).sort(), [
    'iconv-lite', 'pend', 'playwright', 'playwright-core', 'safer-buffer', 'yauzl',
  ])
  assert.deepEqual(allowlist.allowedSourceStorageModules, [
    'src/crown/storage/jsonl-store.mjs',
    'src/crown/storage/jsonl-candidate-store.mjs',
    'src/crown/storage/jsonl-v2-audit-store.mjs',
  ])
  assert.equal(allowlist.appFiles.includes('config/default-leagues.json'), true)
  for (const name of [
    'crown-bet-bootstrap.mjs', 'crown-bet-execute.mjs',
    'crown-bet-execute-sequence.mjs', 'crown-betting-candidate-dry-run.mjs',
  ]) assert.equal(allowlist.forbiddenArtifactNames.includes(name), true)
})
