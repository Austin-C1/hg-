import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parseCleanupArgs,
  runLoginDiagnosticsCleanup,
} from '../src/crown/login/login-diagnostics-cleanup.mjs'

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-diagnostics-cleanup-'))
  const rootDir = path.join(parent, 'login-diagnostics')
  const runDir = path.join(rootDir, '20260711-120000-mon_primary')
  fs.mkdirSync(path.join(runDir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(runDir, 'snapshot.json'), JSON.stringify({
    title: 'Welcome monitor-user',
    url: 'https://example.test/login?token=url-token',
    bodyText: 'password=body-secret',
    inputs: [{ name: 'username', value: 'monitor-user' }, { type: 'password', value: 'monitor-password' }],
    cookies: [{ name: 'uid', value: 'cookie-secret' }],
    storageState: { cookies: [{ value: 'cookie-secret' }] },
    extraDebug: { authorization: 'Bearer auth-secret' },
    account: { id: 'mon_primary', username: 'monitor-user', password: 'monitor-password' },
    classifiedState: '登录失效',
  }), 'utf8')
  fs.writeFileSync(path.join(runDir, 'screenshot.png'), 'screenshot-secret', 'utf8')
  fs.writeFileSync(path.join(runDir, 'network.txt'), 'session-secret', 'utf8')
  fs.writeFileSync(path.join(runDir, 'nested', 'raw.json'), 'token=nested-secret', 'utf8')
  return { parent, rootDir, runDir }
}

function fileState(runDir) {
  return {
    snapshot: fs.readFileSync(path.join(runDir, 'snapshot.json')),
    screenshot: fs.readFileSync(path.join(runDir, 'screenshot.png')),
    network: fs.readFileSync(path.join(runDir, 'network.txt')),
    nested: fs.readFileSync(path.join(runDir, 'nested', 'raw.json')),
  }
}

test('cleanup defaults to dry-run and reports only safe relative summaries without modifying files', () => {
  const { rootDir, runDir } = fixture()
  const before = fileState(runDir)
  const result = runLoginDiagnosticsCleanup({ rootDir })

  assert.equal(result.mode, 'dry-run')
  assert.equal(result.snapshotsFound, 1)
  assert.equal(result.snapshotsNeedingRewrite, 1)
  assert.equal(result.sensitiveArtifactsFound, 3)
  assert.equal(result.items.length, 1)
  assert.match(result.items[0].relativePath, /^20260711-120000-\[id:[a-f0-9]{12}\]$/)
  assert.doesNotMatch(JSON.stringify(result), /monitor-user|monitor-password|body-secret|url-token|cookie-secret|auth-secret|session-secret|nested-secret/)
  assert.deepEqual(fileState(runDir), before)
})

test('explicit apply atomically rewrites a safe schema and removes every other artifact', () => {
  const { rootDir, runDir } = fixture()
  const result = runLoginDiagnosticsCleanup({ rootDir, apply: true })

  assert.equal(result.mode, 'apply')
  assert.equal(result.snapshotsRewritten, 1)
  assert.equal(result.sensitiveArtifactsRemoved, 3)
  assert.equal(fs.existsSync(path.join(runDir, 'screenshot.png')), false)
  assert.equal(fs.existsSync(path.join(runDir, 'network.txt')), false)
  assert.equal(fs.existsSync(path.join(runDir, 'nested')), false)
  const snapshotText = fs.readFileSync(path.join(runDir, 'snapshot.json'), 'utf8')
  const snapshot = JSON.parse(snapshotText)
  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.accountId, 'mon_primary')
  assert.equal(snapshot.screenshotCaptured, false)
  assert.doesNotMatch(snapshotText, /monitor-user|monitor-password|body-secret|url-token|cookie-secret|auth-secret/)
  assert.equal(fs.readdirSync(runDir).some((name) => name.includes('.tmp')), false)
})

test('a second apply is idempotent', () => {
  const { rootDir, runDir } = fixture()
  runLoginDiagnosticsCleanup({ rootDir, apply: true })
  const before = fs.readFileSync(path.join(runDir, 'snapshot.json'))
  const second = runLoginDiagnosticsCleanup({ rootDir, apply: true })

  assert.equal(second.snapshotsNeedingRewrite, 0)
  assert.equal(second.snapshotsRewritten, 0)
  assert.equal(second.sensitiveArtifactsFound, 0)
  assert.equal(second.sensitiveArtifactsRemoved, 0)
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'snapshot.json')), before)
})

test('cleanup enforces the login-diagnostics root boundary and never follows directory symlinks', (t) => {
  const { parent, rootDir } = fixture()
  assert.throws(() => runLoginDiagnosticsCleanup({ rootDir: parent }), /login-diagnostics-root/)
  assert.throws(() => runLoginDiagnosticsCleanup({ rootDir: path.join(rootDir, '..', 'outside'), apply: true }), /login-diagnostics-root/)

  const outside = path.join(parent, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside-secret')
  const link = path.join(rootDir, 'linked-run')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.diagnostic('symlink creation unavailable on this Windows host')
      return
    }
    throw error
  }
  const result = runLoginDiagnosticsCleanup({ rootDir, apply: true })
  assert.equal(result.skippedLinks, 1)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside-secret')
})

test('cleanup CLI parsing is dry-run by default and requires an explicit apply flag', () => {
  assert.deepEqual(parseCleanupArgs(['--dir', 'data/runtime/login-diagnostics']), {
    rootDir: 'data/runtime/login-diagnostics',
    apply: false,
    help: false,
  })
  assert.deepEqual(parseCleanupArgs(['--apply', '--dir=data/runtime/login-diagnostics']), {
    rootDir: 'data/runtime/login-diagnostics',
    apply: true,
    help: false,
  })
  assert.throws(() => parseCleanupArgs(['--apply=false']), /apply-value-not-allowed/)
  assert.throws(() => parseCleanupArgs(['--dir', '--apply']), /dir-value-required/)
  assert.throws(() => parseCleanupArgs(['--unknown']), /unknown-argument/)
  assert.throws(() => runLoginDiagnosticsCleanup({ rootDir: 'data/runtime/login-diagnostics', apply: 'false' }), /cleanup-apply-boolean/)
})
