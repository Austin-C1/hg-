import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateScript = path.join(repoRoot, 'scripts', 'crown-release-candidate.ps1')
const powershell = 'powershell.exe'
const VERSION = '0.2.0'
const ARTIFACT_NAME = `CrownMonitor-v${VERSION}-windows-x64-portable.zip`

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function linkOrCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try { fs.linkSync(source, destination) } catch { fs.copyFileSync(source, destination) }
}

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true })
}

async function makeFixture(t) {
  assert.equal(fs.existsSync(candidateScript), true, 'release candidate script must exist')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crown candidate test '))
  const source = path.join(base, 'source')
  const nodeRuntime = path.join(base, 'node-runtime')
  const chromiumRuntime = path.join(base, 'chromium-runtime')
  const output = path.join(base, 'output')
  const temporaryParent = path.join(base, 'temporary')
  const fakeBin = path.join(base, 'fake-bin')
  const commandLog = path.join(base, 'commands.log')
  for (const directory of [source, nodeRuntime, chromiumRuntime, output, temporaryParent, fakeBin]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  write(path.join(source, '.gitignore'), 'node_modules/\nfrontend/node_modules/\nfrontend/dist/\noutput/\n')
  write(path.join(source, 'package.json'), `${JSON.stringify({ name: 'candidate-fixture', version: VERSION })}\n`)
  write(path.join(source, 'package-lock.json'), `${JSON.stringify({ name: 'candidate-fixture', version: VERSION, lockfileVersion: 3, packages: { '': { name: 'candidate-fixture', version: VERSION } } })}\n`)
  write(path.join(source, 'frontend', 'package.json'), `${JSON.stringify({ name: 'candidate-frontend', version: VERSION })}\n`)
  write(path.join(source, 'scripts', 'crown-release-candidate.ps1'), fs.readFileSync(candidateScript))
  write(path.join(source, 'scripts', 'crown-runtime-health-audit.mjs'), `
import fs from 'node:fs'
fs.appendFileSync(process.env.CROWN_TEST_COMMAND_LOG, 'runtime-health\\n')
process.stdout.write(JSON.stringify({
  schemaVersion: 'crown-runtime-health-v1', uniqueOwners: true, heartbeatsFresh: true,
  capabilityReadyCount: 8, unknownCount: 0, orphanChromiumCount: 0,
  orphanLeaseCount: 0, orphanAccountLockCount: 0, desktopOk: true,
  mobileOk: true, consoleErrorCount: 0,
}) + '\\n')
`)

  linkOrCopy(process.execPath, path.join(nodeRuntime, 'node.exe'))
  write(path.join(nodeRuntime, 'npm.cmd'), `@echo off
setlocal EnableExtensions
echo npm %*>>"%CROWN_TEST_COMMAND_LOG%"
if /I "%CROWN_TEST_FAIL_STAGE%"=="check" if /I "%~1"=="run" if /I "%~2"=="check" exit /b 23
if /I "%~1"=="run" if /I "%~2"=="crown:frontend:build" goto frontend_build
if /I "%~1"=="run" if /I "%~2"=="release:portable" goto portable
exit /b 0
:frontend_build
if "%CROWN_TEST_SKIP_DIST%"=="1" exit /b 0
if not exist "frontend\\dist" mkdir "frontend\\dist"
>"frontend\\dist\\index.html" echo ^<!doctype html^>fixture
exit /b 0
:portable
set "OUT="
:parse
if "%~1"=="" goto publish
if /I "%~1"=="--out" set "OUT=%~2"
shift
goto parse
:publish
if "%OUT%"=="" exit /b 41
mkdir "%OUT%\\versions\\${VERSION}\\app\\scripts" 2>nul
>"%OUT%\\current.json" echo {"schemaVersion":1,"version":"${VERSION}"}
>"%OUT%\\versions\\${VERSION}\\app\\scripts\\crown-dashboard.mjs" echo export {}
>"%OUT%\\versions\\${VERSION}\\app\\scripts\\crown-watch.mjs" echo export {}
>"%OUT%\\versions\\${VERSION}\\app\\scripts\\crown-betting-worker.mjs" echo export {}
>"%OUT%\\release-files.json" echo {"schemaVersion":1,"version":"${VERSION}","files":[]}
exit /b 0
`)
  write(path.join(chromiumRuntime, 'chrome.exe'), 'fixture chromium')
  write(path.join(fakeBin, 'docker.cmd'), `@echo off
echo docker %*>>"%CROWN_TEST_COMMAND_LOG%"
if /I "%CROWN_TEST_FAIL_STAGE%"=="docker" exit /b 29
exit /b 0
`)

  await execFileAsync('git', ['init', source], { windowsHide: true })
  await git(source, 'config', 'user.email', 'candidate@example.test')
  await git(source, 'config', 'user.name', 'Candidate Test')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'fixture')
  const { stdout } = await git(source, 'rev-parse', 'HEAD')
  const commit = stdout.trim()

  t.after(async () => {
    try { await git(source, 'worktree', 'prune') } catch {}
    fs.rmSync(base, { recursive: true, force: true })
  })
  return { base, source, nodeRuntime, chromiumRuntime, output, temporaryParent, fakeBin, commandLog, commit }
}

function powershellArgs(fixture, mode = 'BuildFinal', extra = []) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(fixture.source, 'scripts', 'crown-release-candidate.ps1'),
    '-Commit', fixture.commit,
    '-NodeRuntime', fixture.nodeRuntime,
    '-ChromiumRuntime', fixture.chromiumRuntime,
    '-Mode', mode,
    '-OutputDirectory', fixture.output,
    '-TemporaryParent', fixture.temporaryParent,
    ...extra,
  ]
}

async function runCandidate(fixture, { mode = 'BuildFinal', extra = [], env = {} } = {}) {
  const child = spawn(powershell, powershellArgs(fixture, mode, extra), {
    cwd: fixture.source,
    windowsHide: true,
    env: {
      ...process.env,
      Path: `${fixture.fakeBin};${process.env.Path}`,
      CROWN_TEST_COMMAND_LOG: fixture.commandLog,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { code, stdout, stderr }
}

function temporaryEntries(fixture) {
  return fs.existsSync(fixture.temporaryParent) ? fs.readdirSync(fixture.temporaryParent) : []
}

test('native command failure is fatal and the GUID worktree is removed in finally', async (t) => {
  const fixture = await makeFixture(t)
  const result = await runCandidate(fixture, { env: { CROWN_TEST_FAIL_STAGE: 'check' } })
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /release-candidate-native-failed:check/)
  assert.deepEqual(temporaryEntries(fixture), [])
  assert.match(fs.readFileSync(fixture.commandLog, 'utf8'), /npm run check/)
})

test('an existing final ZIP blocks the run before a worktree is created', async (t) => {
  const fixture = await makeFixture(t)
  write(path.join(fixture.output, ARTIFACT_NAME), 'existing')
  const result = await runCandidate(fixture)
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /release-candidate-artifact-exists/)
  assert.deepEqual(temporaryEntries(fixture), [])
  assert.equal(fs.existsSync(fixture.commandLog), false)
})

test('missing frontend dist fails closed and still removes the clean worktree', async (t) => {
  const fixture = await makeFixture(t)
  const result = await runCandidate(fixture, { env: { CROWN_TEST_SKIP_DIST: '1' } })
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /release-candidate-frontend-dist-missing/)
  assert.deepEqual(temporaryEntries(fixture), [])
  assert.equal(fs.existsSync(path.join(fixture.output, ARTIFACT_NAME)), false)
})

test('expected SHA-256 mismatch rejects and removes the candidate asset', async (t) => {
  const fixture = await makeFixture(t)
  const result = await runCandidate(fixture, { extra: ['-ExpectedSha256', '0'.repeat(64)] })
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /release-candidate-sha256-mismatch/)
  assert.deepEqual(temporaryEntries(fixture), [])
  assert.equal(fs.existsSync(path.join(fixture.output, ARTIFACT_NAME)), false)
})

test('expected byte size mismatch rejects and removes the candidate asset', async (t) => {
  const fixture = await makeFixture(t)
  const result = await runCandidate(fixture, { extra: ['-ExpectedSize', '1'] })
  assert.notEqual(result.code, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /release-candidate-size-mismatch/)
  assert.deepEqual(temporaryEntries(fixture), [])
  assert.equal(fs.existsSync(path.join(fixture.output, ARTIFACT_NAME)), false)
})

test('successful candidate returns one JSON result and leaves no temporary worktree', async (t) => {
  const fixture = await makeFixture(t)
  const result = await runCandidate(fixture)
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.commit, fixture.commit)
  assert.equal(report.mode, 'BuildFinal')
  assert.equal(report.artifactPath, path.join(fixture.output, ARTIFACT_NAME))
  assert.equal(report.size, fs.statSync(report.artifactPath).size)
  assert.equal(report.sha256, createHash('sha256').update(fs.readFileSync(report.artifactPath)).digest('hex'))
  assert.deepEqual(temporaryEntries(fixture), [])
  const commands = fs.readFileSync(fixture.commandLog, 'utf8')
  for (const expected of [
    'npm ci', 'npm --prefix frontend ci', 'npm test', 'npm run check',
    'npm run crown:frontend:test', 'npm run crown:frontend:build',
    'docker compose -p crown-dashboard config', 'runtime-health',
    'npm run release:portable', 'npm run release:audit',
  ]) assert.match(commands, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), expected)
})

test('VerifyOnly leaves no final ZIP so the same commit can immediately run BuildFinal', async (t) => {
  const fixture = await makeFixture(t)

  const verification = await runCandidate(fixture, { mode: 'VerifyOnly' })
  assert.equal(verification.code, 0, `${verification.stdout}\n${verification.stderr}`)
  const verificationReport = JSON.parse(verification.stdout.trim())
  assert.equal(verificationReport.mode, 'VerifyOnly')
  assert.equal(fs.existsSync(path.join(fixture.output, ARTIFACT_NAME)), false)
  assert.equal(fs.existsSync(verificationReport.artifactPath), false)
  assert.deepEqual(temporaryEntries(fixture), [])

  const publication = await runCandidate(fixture, { mode: 'BuildFinal' })
  assert.equal(publication.code, 0, `${publication.stdout}\n${publication.stderr}`)
  const publicationReport = JSON.parse(publication.stdout.trim())
  assert.equal(publicationReport.mode, 'BuildFinal')
  assert.equal(publicationReport.artifactPath, path.join(fixture.output, ARTIFACT_NAME))
  assert.equal(fs.existsSync(publicationReport.artifactPath), true)
  assert.deepEqual(temporaryEntries(fixture), [])
})
