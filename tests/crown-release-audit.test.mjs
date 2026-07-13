import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  auditReleaseArtifacts,
  createReleaseFileManifest,
  scanReleaseArtifacts,
} from '../src/crown/release/release-audit.mjs'

async function write(root, relativePath, contents) {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

async function createArtifact(files = { 'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'crown-release-audit-'))
  for (const [path, contents] of Object.entries(files)) await write(root, path, contents)
  const manifest = await createReleaseFileManifest({ root, version: '0.1.0' })
  await write(root, 'release-files.json', `${JSON.stringify(manifest, null, 2)}\n`)
  return root
}

test('release audit accepts a complete manifest and centralized safe literals', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/app/main.mjs': [
      "export const host = '127.0.0.1'",
      "export const zone = 'Asia/Shanghai'",
      'export const result = { cookie: `${token}.${signature}` }',
      String.raw`export const lease = /^betting-executor:\S+$/`,
      '',
    ].join('\n'),
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await auditReleaseArtifacts({ root })
  assert.equal(report.ok, true)
  assert.equal(report.findings.length, 0)
  assert.equal(report.fileCount, 3)
})

test('release audit scans binary artifacts for embedded local machine paths', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/runtime/node/node.exe': Buffer.concat([
      Buffer.from([0, 1, 2, 3]),
      Buffer.from('C:\\Users\\localdev\\Desktop\\private-build'),
      Buffer.from('-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----'),
      Buffer.from('github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      Buffer.from([0, 4, 5]),
    ]),
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await scanReleaseArtifacts({ root, developerUsernames: ['localdev'] })
  assert.equal(report.ok, false)
  assert.equal(report.findings.some((finding) => finding.code === 'local-user-path'), true)
  assert.equal(report.findings.some((finding) => finding.code === 'desktop-path'), true)
  assert.equal(report.findings.some((finding) => finding.code === 'developer-username'), true)
  assert.equal(report.findings.some((finding) => finding.code === 'secret-material'), true)
})

test('release audit does not mistake vendor binary test literals for local data or Telegram credentials', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/runtime/chromium/chrome.dll': Buffer.concat([
      Buffer.from([0, 1, 2, 3]),
      Buffer.from('/Desktop/feature/456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz'),
      Buffer.from([0, 4, 5]),
    ]),
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await scanReleaseArtifacts({ root })
  assert.equal(report.ok, true, JSON.stringify(report.findings))
})

test('release audit permits local-path examples in dependency docs but still detects secrets there', async (t) => {
  const path = 'versions/0.1.0/runtime/node/node_modules/npm/docs/package-json.md'
  const safeRoot = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    [path]: 'Example install path: C:\\Users\\example\\project\\node_modules\nkey="-----BEGIN PRIVATE KEY-----\\nXXXX\\nXXXX\\n-----END PRIVATE KEY-----"\n',
  })
  const secretRoot = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    [path]: 'github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ\n',
  })
  t.after(() => Promise.all([
    rm(safeRoot, { recursive: true, force: true }),
    rm(secretRoot, { recursive: true, force: true }),
  ]))
  assert.equal((await scanReleaseArtifacts({ root: safeRoot })).ok, true)
  const secretReport = await scanReleaseArtifacts({ root: secretRoot })
  assert.equal(secretReport.findings.some((finding) => finding.code === 'secret-material'), true)
})

test('release audit allows only the three explicitly named source storage modules', async (t) => {
  const allowedSourceStorageModules = [
    'src/crown/storage/jsonl-store.mjs',
    'src/crown/storage/jsonl-candidate-store.mjs',
    'src/crown/storage/jsonl-v2-audit-store.mjs',
  ]
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    ...Object.fromEntries(allowedSourceStorageModules.map((path) => [`versions/0.1.0/app/${path}`, 'export {}\n'])),
    'versions/0.1.0/app/src/x/storage/private.mjs': 'export {}\n',
    'versions/0.1.0/app/src/crown/storage/private.json': '{}\n',
    'versions/0.1.0/app/src/crown/storage/nested/db.mjs': 'export {}\n',
  })
  const caseRoot = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/app/src/crown/StOrAgE/jsonl-store.mjs': 'export {}\n',
  })
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(caseRoot, { recursive: true, force: true }),
  ]))
  const report = await scanReleaseArtifacts({ root, policy: { allowedSourceStorageModules } })
  const rejected = report.findings
    .filter((finding) => finding.code === 'forbidden-artifact-path')
    .map((finding) => finding.path)
  assert.deepEqual(rejected, [
    'versions/0.1.0/app/src/crown/storage/nested/db.mjs',
    'versions/0.1.0/app/src/crown/storage/private.json',
    'versions/0.1.0/app/src/x/storage/private.mjs',
  ])
  const caseReport = await scanReleaseArtifacts({ root: caseRoot, policy: { allowedSourceStorageModules } })
  assert.equal(caseReport.findings.some((finding) => finding.code === 'forbidden-artifact-path'), true)
})

test('release audit rejects every planned runtime-data segment anywhere under src', async (t) => {
  const cases = [
    ['session aliases', ['src/session/file.mjs', 'src/deep/SeSsIoNs/file.mjs']],
    ['profile aliases', ['src/profile/file.mjs', 'src/deep/PrOfIlEs/file.mjs']],
    ['log aliases', ['src/log/file.mjs', 'src/deep/LoGs/file.mjs']],
    ['data runtime pair', ['src/data/runtime/file.mjs', 'src/deep/DaTa/RuNtImE/file.mjs']],
  ]
  for (const [name, paths] of cases) {
    await t.test(name, async (t) => {
      const root = await createArtifact({
        'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
        ...Object.fromEntries(paths.map((path) => [`versions/0.1.0/app/${path}`, 'export {}\n'])),
      })
      t.after(() => rm(root, { recursive: true, force: true }))
      const report = await scanReleaseArtifacts({ root })
      assert.deepEqual(
        report.findings.filter((finding) => finding.code === 'forbidden-artifact-path').map((finding) => finding.path),
        paths.map((path) => `versions/0.1.0/app/${path}`).sort(),
      )
    })
  }
})

test('release audit segment exceptions are limited to vendor runtime and node_modules trees', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/runtime/node/storage/vendor.txt': 'vendor data\n',
    'versions/0.1.0/app/node_modules/vendor/profile/readme.txt': 'vendor example\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal((await scanReleaseArtifacts({ root })).ok, true)
})

test('release audit detects local paths, proxies, system browsers, and secret material', async (t) => {
  const repositoryPath = join('D:\\work', 'private-crown')
  const cases = [
    ['windows-user-root', 'C:\\Users\\Somebody\\AppData\\Local\\secret.txt', 'local-user-path'],
    ['developer-name', 'owner=localdev', 'developer-username'],
    ['desktop', 'D:\\build\\Desktop\\capture.json', 'desktop-path'],
    ['repository', `${repositoryPath}\\src\\main.mjs`, 'repository-path'],
    ['drive-path', 'Q:\\private\\fixture.json', 'undeclared-drive-path'],
    ['escaped-user-path', String.raw`const p = "C:\\Users\\localdev\\Desktop\\private.json"`, 'local-user-path'],
    ['escaped-drive-path', String.raw`{"path":"Q:\\private\\fixture.json"}`, 'undeclared-drive-path'],
    ['proxy', 'HTTPS_PROXY=http://127.0.0.1:7890', 'local-proxy'],
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'system-browser'],
    ['browser-channel', "const browser = { channel: 'msedge' }", 'system-browser'],
    ['escaped-system-browser', String.raw`{"path":"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"}`, 'system-browser'],
    ['private-key', '-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----', 'secret-material'],
    ['github-token', 'github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'secret-material'],
    ['telegram-token', '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', 'secret-material'],
    ['cookie', 'Cookie: uid=real-user; session=real-session-value', 'secret-material'],
  ]
  for (const [name, contents, expectedCode] of cases) {
    await t.test(name, async (t) => {
      const root = await createArtifact({
        'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
        'versions/0.1.0/app/leak.txt': contents,
      })
      t.after(() => rm(root, { recursive: true, force: true }))
      const report = await scanReleaseArtifacts({
        root,
        sourceRoot: repositoryPath,
        developerUsernames: ['localdev'],
      })
      assert.equal(report.ok, false)
      assert.equal(report.findings.some((finding) => finding.code === expectedCode), true, JSON.stringify(report.findings))
      await assert.rejects(auditReleaseArtifacts({
        root,
        sourceRoot: repositoryPath,
        developerUsernames: ['localdev'],
      }), /release-audit-failed/)
    })
  }
})

test('release audit rejects forbidden user-data paths and files outside the manifest', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/app/storage/crown.sqlite': 'SQLite format 3',
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(root, 'versions/0.1.0/app/unlisted.txt', 'not in manifest')
  const report = await scanReleaseArtifacts({ root })
  assert.equal(report.ok, false)
  assert.equal(report.findings.some((finding) => finding.code === 'forbidden-artifact-path'), true)
  assert.equal(report.findings.some((finding) => finding.code === 'manifest-extra-file'), true)
})

test('release audit validates every manifested size and sha256', async (t) => {
  const root = await createArtifact({
    'current.json': '{"schemaVersion":1,"version":"0.1.0"}\n',
    'versions/0.1.0/app/main.mjs': 'export const ok = true\n',
  })
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = join(root, 'release-files.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const target = manifest.files.find((entry) => entry.path.endsWith('/main.mjs'))
  target.size += 1
  target.sha256 = createHash('sha256').update('wrong').digest('hex')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const report = await scanReleaseArtifacts({ root })
  assert.equal(report.findings.some((finding) => finding.code === 'manifest-size-mismatch'), true)
  assert.equal(report.findings.some((finding) => finding.code === 'manifest-hash-mismatch'), true)
})

test('release manifest rejects Windows-unsafe paths and case-fold collisions', async (t) => {
  const invalidSets = [
    ['versions/0.1.0/app/CON.txt'],
    ['versions/0.1.0/app/name.'],
    ['versions/0.1.0/app/name '],
    ['versions/0.1.0/app/file.txt:stream'],
    ['versions/0.1.0/app/bad\u0001name'],
    ['versions/0.1.0/app/A.txt', 'versions/0.1.0/app/a.TXT'],
  ]
  for (const paths of invalidSets) {
    const root = await mkdtemp(join(tmpdir(), 'crown-release-unsafe-manifest-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const files = paths.map((path) => ({ path, size: 0, sha256: '0'.repeat(64) }))
    await write(root, 'release-files.json', `${JSON.stringify({ schemaVersion: 1, version: '0.1.0', files })}\n`)
    await assert.rejects(scanReleaseArtifacts({ root }), /release-manifest-invalid/)
  }
})

test('release manifest and audit reject hard-linked artifact files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-release-hardlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await write(root, 'versions/0.1.0/app/first.txt', 'same inode')
  const second = join(root, 'versions/0.1.0/app/second.txt')
  await link(first, second)
  await assert.rejects(
    createReleaseFileManifest({ root, version: '0.1.0' }),
    /release-artifact-link-forbidden/,
  )
})
