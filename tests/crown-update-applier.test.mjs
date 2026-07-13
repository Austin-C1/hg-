import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  applyUpdate,
  readUpdateApplyRequest,
  recoverUpdate,
  restoreVerifiedSqliteBackup,
  runUpdateApplyRequest,
  UpdateCrashSignal,
  writeAtomicCurrent,
} from '../src/crown/update/update-applier.mjs'
import { writeAtomicJson } from '../src/crown/update/atomic-json-file.mjs'
import { main as runUpdateCli } from '../scripts/crown-update-apply.mjs'

async function waitForReady(child) {
  child.stdout.setEncoding('utf8')
  let output = ''
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('READY\n')) resolve()
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`child-exited:${code}`)))
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('child-ready-timeout')), 5_000)),
  ])
}

test('external applier CLI fails closed with one stable code when no request is supplied', async () => {
  const child = spawn(process.execPath, ['scripts/crown-update-apply.mjs'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 64)
  assert.equal(stdout, '')
  assert.equal(stderr.trim(), 'update-apply-request-required')
})

test('external applier CLI supplies the production Windows runtime factory by default', async () => {
  let supplied
  await runUpdateCli(['--request', 'C:\\data\\updates\\request.json'], {
    dataRoot: 'C:\\data',
    runRequest: async (value) => { supplied = value; return { ok: true } },
  })
  assert.equal(typeof supplied.createRuntime, 'function')
  assert.equal(supplied.dataRoot, 'C:\\data')
  assert.equal(supplied.requestPath, 'C:\\data\\updates\\request.json')
})

test('external request parser atomically reads one strict contained contract and runner cannot override protected fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-apply-request-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataRoot = join(root, 'data')
  const appRoot = join(root, 'app')
  await mkdir(join(dataRoot, 'updates'), { recursive: true })
  await mkdir(join(dataRoot, 'storage'), { recursive: true })
  await mkdir(join(dataRoot, 'backups'), { recursive: true })
  await mkdir(join(appRoot, 'versions', '0.2.0'), { recursive: true })
  const currentPath = join(appRoot, 'current.json')
  await writeAtomicCurrent({ appRoot, currentPath, version: '0.1.0' })
  const requestPath = join(dataRoot, 'updates', 'apply-request.json')
  const request = {
    schemaVersion: 1,
    operation: 'apply',
    installationId: 'install-A',
    updateId: 'update-1',
    previousVersion: '0.1.0',
    candidateVersion: '0.2.0',
    expectedVersion: '0.2.0',
    dataRoot,
    journalPath: join(dataRoot, 'updates', 'journal.json'),
    dbPath: join(dataRoot, 'storage', 'crown.sqlite'),
    backupPath: join(dataRoot, 'backups', 'before.sqlite'),
    appRoot,
    currentPath,
    candidateIdentity: {
      dev: String((await lstat(join(appRoot, 'versions', '0.2.0'), { bigint: true })).dev),
      ino: String((await lstat(join(appRoot, 'versions', '0.2.0'), { bigint: true })).ino),
    },
    oldProcess: processRecord(),
  }
  await writeAtomicJson({ dataRoot, filePath: requestPath, value: request })
  const parsed = await readUpdateApplyRequest({ dataRoot, requestPath })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.oldProcess), true)
  assert.equal(parsed.expectedVersion, '0.2.0')

  const result = await runUpdateApplyRequest({
    dataRoot,
    requestPath,
    createRuntime: async (value) => ({ marker: value.updateId, expectedVersion: 'attacker-override' }),
    applyImpl: async (value) => {
      assert.equal(value.marker, 'update-1')
      assert.equal(value.expectedVersion, '0.2.0')
      return { ok: true }
    },
  })
  assert.deepEqual(result, { ok: true })

  await writeAtomicJson({ dataRoot, filePath: requestPath, value: { ...request, unknown: true } })
  await assert.rejects(readUpdateApplyRequest({ dataRoot, requestPath }), /update-apply-request-invalid/)
  await assert.rejects(readUpdateApplyRequest({ dataRoot, requestPath: join(root, 'outside.json') }), /update-apply-request-path-invalid/)
})

function fakeJournal(calls) {
  let state = { phase: 'preparing', currentSwitched: false }
  return {
    get state() { return { ...state } },
    async transition(phase, patch = {}) { calls.push(['journal', phase]); state = { ...state, ...patch, phase }; return { ...state } },
    async close() { calls.push(['journal-close']) },
  }
}

function processRecord(overrides = {}) {
  return {
    pid: 4001,
    processStartTime: '2026-07-13T08:00:00.000Z',
    installationId: 'install-A',
    processInstanceId: 'process-old',
    probeToken: 'A'.repeat(43),
    ...overrides,
  }
}

function options(overrides = {}) {
  const calls = []
  const stopped = new Set()
  const oldProcess = processRecord()
  return {
    calls,
    value: {
      dataRoot: 'C:\\Users\\A\\AppData\\Local\\CrownMonitor',
      journalPath: 'C:\\Users\\A\\AppData\\Local\\CrownMonitor\\updates\\journal.json',
      dbPath: 'C:\\Users\\A\\AppData\\Local\\CrownMonitor\\storage\\crown.sqlite',
      backupPath: 'C:\\Users\\A\\AppData\\Local\\CrownMonitor\\backups\\before-0.2.0.sqlite',
      appRoot: 'D:\\CrownMonitor',
      currentPath: 'D:\\CrownMonitor\\current.json',
      installationId: 'install-A',
      updateId: 'update-1',
      previousVersion: '0.1.0',
      candidateVersion: '0.2.0',
      expectedVersion: '0.2.0',
      stopTimeoutMs: 20,
      stopPollMs: 1,
      oldProcess,
      startJournal: async () => fakeJournal(calls),
      createBackup: async () => { calls.push(['backup']); return { path: 'C:\\Users\\A\\AppData\\Local\\CrownMonitor\\backups\\before-0.2.0.sqlite' } },
      probeProcess: async (record) => { calls.push(['probe', record.processInstanceId]); return stopped.has(record.processInstanceId) ? { state: 'dead' } : { state: 'alive', ...record } },
      stopProcess: async (record) => { calls.push(['stop', record.processInstanceId]); stopped.add(record.processInstanceId); return { stopped: true } },
      migrateCandidate: async ({ env }) => { calls.push(['migrate', env.CROWN_WATCHER_AUTOSTART, env.CROWN_REAL_BETTING_REQUESTED]) },
      startCandidate: async ({ env, authorize }) => {
        calls.push(['start-candidate', env.CROWN_BETTING_WORKER_AUTOSTART, env.CROWN_REAL_BETTING_ENABLED])
        const record = processRecord({ pid: 5001, processInstanceId: 'process-new', probeToken: 'B'.repeat(43) })
        await authorize(record)
        return record
      },
      checkHealth: async ({ process: candidate }) => { calls.push(['health', candidate.processInstanceId]); return { ok: true } },
      writeCurrent: async ({ version }) => { calls.push(['current', version]) },
      restoreDatabase: async () => { calls.push(['restore-db']) },
      startPrevious: async ({ env }) => { calls.push(['start-old', env.CROWN_WATCHER_AUTOSTART]) },
      ...overrides,
    },
  }
}

test('apply backs up, verifies exact process identity, forces all runtime capabilities off, then atomically commits', async () => {
  const { calls, value } = options()
  const result = await applyUpdate(value)
  assert.deepEqual(result, { ok: true, version: '0.2.0', rolledBack: false })
  assert.deepEqual(calls, [
    ['backup'], ['journal', 'backup-complete'], ['journal', 'staged'], ['journal', 'applying'],
    ['probe', 'process-old'], ['probe', 'process-old'], ['stop', 'process-old'], ['probe', 'process-old'], ['migrate', '0', '0'],
    ['start-candidate', '0', '0'], ['journal', 'health-checking'], ['health', 'process-new'],
    ['journal', 'switch-pending'], ['current', '0.2.0'], ['journal', 'current-switched'],
    ['journal', 'committed'], ['journal-close'],
  ])
})

test('resume apply accepts an already-dead exact old process without issuing a stop', async () => {
  const { calls, value } = options({
    probeProcess: async (record) => {
      calls.push(['probe', record.processInstanceId])
      return record.processInstanceId === 'process-old' ? { state: 'dead' } : { state: 'alive', ...record }
    },
  })
  const result = await applyUpdate(value)
  assert.deepEqual(result, { ok: true, version: '0.2.0', rolledBack: false })
  assert.equal(calls.some(([name, id]) => name === 'stop' && id === 'process-old'), false)
  assert.equal(calls.some(([name]) => name === 'migrate'), true)
})

test('old Dashboard is never stopped when installation, PID, start time, instance or probe identity differs', async () => {
  const { calls, value } = options({ probeProcess: async (record) => ({ state: 'alive', ...record, processStartTime: '2026-07-13T07:00:00.000Z' }) })
  await assert.rejects(applyUpdate(value), /update-process-identity-mismatch/)
  assert.equal(calls.some(([name]) => name === 'stop'), false)
  assert.equal(calls.some(([name]) => name === 'start-candidate'), false)
  assert.equal(calls.some(([name]) => ['restore-db', 'current', 'start-old'].includes(name)), false)
})

test('failure after apply starts stops only the verified candidate, restores SQLite/current, and restarts old version safely off', async () => {
  const { calls, value } = options({ checkHealth: async () => { throw new Error('candidate leaked secret') } })
  await assert.rejects(applyUpdate(value), (error) => error.message === 'update-apply-failed')
  assert.deepEqual(calls.slice(-8), [
    ['probe', 'process-new'], ['stop', 'process-new'], ['probe', 'process-new'], ['restore-db'],
    ['current', '0.1.0'], ['journal', 'rolled-back'], ['start-old', '0'], ['journal-close'],
  ])
})

test('a stop callback cannot authorize DB mutation until the exact process is proven dead', async () => {
  const { value } = options({
    probeProcess: async (record) => ({ state: 'alive', ...record }),
    stopProcess: async () => ({ stopped: true }),
  })
  let migrated = false
  value.migrateCandidate = async () => { migrated = true }
  await assert.rejects(applyUpdate(value), /update-process-still-running/)
  assert.equal(migrated, false)
})

test('candidate must durably authorize its identity before it may start', async () => {
  const { value } = options({
    startCandidate: async () => processRecord({ pid: 5001, processInstanceId: 'process-new', probeToken: 'B'.repeat(43) }),
  })
  await assert.rejects(applyUpdate(value), /update-candidate-authorization-missing/)
})

test('authorized candidate remains the rollback target when launcher throws after releasing it', async () => {
  const { calls, value } = options({
    startCandidate: async ({ authorize }) => {
      await authorize(processRecord({ pid: 5001, processInstanceId: 'process-new', probeToken: 'B'.repeat(43) }))
      throw new Error('launcher failed after child release')
    },
  })
  await assert.rejects(applyUpdate(value), (error) => error.message === 'update-apply-failed')
  assert.equal(calls.some(([name, id]) => name === 'stop' && id === 'process-new'), true)
  assert.equal(calls.some(([name]) => name === 'restore-db'), true)
})

test('fault injection leaves the exact durable phase untouched for force-kill recovery tests', async () => {
  const cases = [
    ['after-journal-start', 'preparing'],
    ['after-backup', 'backup-complete'],
    ['after-old-stop', 'applying'],
    ['after-migration', 'applying'],
    ['after-candidate-start', 'health-checking'],
    ['after-health', 'health-checking'],
    ['after-current-switch', 'current-switched'],
  ]
  for (const [point, phase] of cases) {
    let journal
    const { calls, value } = options({
      startJournal: async () => {
        journal = fakeJournal(calls)
        return journal
      },
      faultInjector: async (current) => {
        if (current === point) throw new UpdateCrashSignal(point)
      },
    })
    await assert.rejects(applyUpdate(value), (error) => error instanceof UpdateCrashSignal && error.point === point)
    assert.equal(journal.state.phase, phase)
    assert.equal(calls.filter(([name]) => name === 'journal-close').length, 1)
    assert.equal(calls.some(([name]) => ['rolling-back', 'rolled-back', 'restore-db', 'start-old'].includes(name)), false)
  }
})

test('default current writer stays inside APP_ROOT and verified SQLite restore stays inside dataRoot', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-applier-io-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const appRoot = join(sandbox, 'app-root')
  const dataRoot = join(sandbox, 'data-root')
  await mkdir(appRoot)
  await mkdir(join(dataRoot, 'storage'), { recursive: true })
  await mkdir(join(dataRoot, 'backups'), { recursive: true })
  const currentPath = join(appRoot, 'current.json')
  await writeAtomicCurrent({ appRoot, currentPath, version: '0.2.0' })
  assert.equal(await readFile(currentPath, 'utf8'), '{"schemaVersion":1,"version":"0.2.0"}\n')
  await assert.rejects(writeAtomicCurrent({ appRoot, currentPath: join(sandbox, 'outside.json'), version: '0.2.0' }), /update-current-path-invalid/)

  const dbPath = join(dataRoot, 'storage', 'crown.sqlite')
  const backupPath = join(dataRoot, 'backups', 'before.sqlite')
  for (const [path, value] of [[dbPath, 'new'], [backupPath, 'old']]) {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE marker(value TEXT); PRAGMA user_version=7')
    db.prepare('INSERT INTO marker VALUES(?)').run(value)
    db.close()
  }
  for (const suffix of ['-wal', '-shm', '-journal']) await writeFile(`${dbPath}${suffix}`, 'stale-sidecar')
  await restoreVerifiedSqliteBackup({ dataRoot, backupPath, dbPath })
  const restored = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(restored.prepare('SELECT value FROM marker').get().value, 'old')
  restored.close()
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await assert.rejects(access(`${dbPath}${suffix}`), { code: 'ENOENT' })
  }
  await assert.rejects(restoreVerifiedSqliteBackup({ dataRoot, backupPath: join(sandbox, 'outside.sqlite'), dbPath }), /update-restore-path-invalid/)
})

test('SQLite restore refuses a backup pathname replaced after its verified handle is opened', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-applier-restore-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'storage'))
  await mkdir(join(root, 'backups'))
  const dbPath = join(root, 'storage', 'crown.sqlite')
  const backupPath = join(root, 'backups', 'before.sqlite')
  const replacementPath = join(root, 'backups', 'replacement.sqlite')
  for (const [path, value] of [[dbPath, 'live'], [backupPath, 'trusted'], [replacementPath, 'replacement']]) {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE marker(value TEXT)')
    db.prepare('INSERT INTO marker VALUES(?)').run(value)
    db.close()
  }
  await assert.rejects(restoreVerifiedSqliteBackup({
    dataRoot: root,
    backupPath,
    dbPath,
    faultInjector: async (point) => {
      if (point !== 'after-source-open') return
      await rename(backupPath, join(root, 'backups', 'displaced.sqlite'))
      await rename(replacementPath, backupPath)
    },
  }), /update-restore-source-changed/)
  const live = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(live.prepare('SELECT value FROM marker').get().value, 'live')
  live.close()
})

test('real updater child SIGKILL at destructive phase boundaries recovers to one deterministic old version', async (t) => {
  const moduleUrl = new URL('../src/crown/update/update-applier.mjs', import.meta.url).href
  for (const point of ['after-backup', 'after-old-stop', 'after-migration', 'after-candidate-authorized', 'after-health', 'after-current-switch']) {
    const root = await mkdtemp(join(tmpdir(), `crown-applier-kill-${point}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const appRoot = join(root, 'app')
    const dataRoot = join(root, 'data')
    const dbPath = join(dataRoot, 'storage', 'crown.sqlite')
    const backupPath = join(dataRoot, 'backups', 'before.sqlite')
    const journalPath = join(dataRoot, 'updates', 'journal.json')
    const currentPath = join(appRoot, 'current.json')
    await mkdir(appRoot)
    await mkdir(join(dataRoot, 'storage'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('old')")
    db.close()
    await writeAtomicCurrent({ appRoot, currentPath, version: '0.1.0' })

    const script = `
      const [moduleUrl, point, dataRoot, dbPath, backupPath, journalPath, appRoot, currentPath] = process.argv.slice(1);
      const { applyUpdate } = await import(moduleUrl);
      const stopped = new Set();
      const old = { pid: 4001, processStartTime: '2026-07-13T08:00:00.000Z', installationId: 'install-A', processInstanceId: 'process-old', probeToken: 'O'.repeat(43) };
      const candidate = { pid: 5001, processStartTime: '2026-07-13T08:01:00.000Z', installationId: 'install-A', processInstanceId: 'process-new', probeToken: 'N'.repeat(43) };
      await applyUpdate({
        dataRoot, dbPath, backupPath, journalPath, appRoot, currentPath,
        installationId: 'install-A', updateId: 'update-kill', previousVersion: '0.1.0', candidateVersion: '0.2.0', expectedVersion: '0.2.0', oldProcess: old,
        probeProcess: async (record) => stopped.has(record.processInstanceId) ? { state: 'dead' } : { state: 'alive', ...record },
        stopProcess: async (record) => { stopped.add(record.processInstanceId); return { stopped: true }; },
        migrateCandidate: async () => {},
        startCandidate: async ({ authorize }) => { await authorize(candidate); return candidate; },
        checkHealth: async () => ({ ok: true }),
        startPrevious: async () => {},
        faultInjector: async (current) => { if (current === point) { process.stdout.write('READY\\n'); await new Promise(() => {}); } },
      });
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, point, dataRoot, dbPath, backupPath, journalPath, appRoot, currentPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(child)
    child.kill('SIGKILL')
    await once(child, 'exit')

    const safePhase = point === 'after-backup'
    const recovery = await recoverUpdate({
      dataRoot, journalPath, installationId: 'install-A', updateId: 'update-kill',
      previousVersion: '0.1.0', candidateVersion: '0.2.0', dbPath, appRoot, currentPath,
      oldProcess: {
        pid: 4001, processStartTime: '2026-07-13T08:00:00.000Z', installationId: 'install-A',
        processInstanceId: 'process-old', probeToken: 'O'.repeat(43),
      },
      resolveCandidateProcess: async (journal) => journal.candidatePid === null ? null : ({
        pid: 5001, processStartTime: '2026-07-13T08:01:00.000Z', installationId: 'install-A',
        processInstanceId: 'process-new', probeToken: 'N'.repeat(43),
      }),
      probeProcess: async () => ({ state: 'dead' }),
      stopProcess: async () => assert.fail('killed fake processes are already dead'),
      startPrevious: async () => {},
    })
    assert.equal(recovery.action, safePhase ? 'marked-failed' : 'rolled-back')
    assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).version, '0.1.0')
  }
})
