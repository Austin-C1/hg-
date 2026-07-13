import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recoverUpdate } from '../src/crown/update/update-applier.mjs'

const NOW = '2026-07-13T08:00:00.000Z'
const UPDATE = Object.freeze({
  installationId: 'install-A',
  updateId: 'update-1',
  previousVersion: '0.1.0',
  candidateVersion: '0.2.0',
})

async function waitForReady(child) {
  child.stdout.setEncoding('utf8')
  let output = ''
  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('READY\n')) resolve() })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`child-exited:${code}`)))
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('child-ready-timeout')), 5_000)),
  ])
}

async function writeJournal(root, phase, overrides = {}) {
  const backupPath = join(root, 'backups', 'before.sqlite')
  await mkdir(join(root, 'updates'), { recursive: true })
  await mkdir(join(root, 'backups'), { recursive: true })
  await writeFile(backupPath, 'backup')
  const candidate = ['health-checking', 'switch-pending', 'current-switched'].includes(phase)
  const switched = phase === 'current-switched'
  const journal = {
    schemaVersion: 1,
    updateId: 'update-1',
    previousVersion: '0.1.0',
    candidateVersion: '0.2.0',
    backupPath: phase === 'preparing' ? '' : backupPath,
    phase,
    currentSwitched: switched,
    candidatePid: candidate ? 5001 : null,
    candidateInstanceId: candidate ? 'process-new' : '',
    updatedAt: NOW,
    ...overrides,
  }
  await writeFile(join(root, 'updates', 'journal.json'), `${JSON.stringify(journal)}\n`)
  return journal
}

test('recovery deterministically rolls every incomplete destructive phase back to the previous version', async (t) => {
  for (const phase of ['applying', 'health-checking', 'switch-pending', 'current-switched']) {
    const root = await mkdtemp(join(tmpdir(), `crown-recovery-${phase}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const journal = await writeJournal(root, phase)
    const calls = []
    const stopped = new Set()
    const candidate = {
      pid: 5001, processStartTime: NOW, installationId: 'install-A',
      processInstanceId: 'process-new', probeToken: 'C'.repeat(43),
    }
    const result = await recoverUpdate({
      dataRoot: root,
      journalPath: join(root, 'updates', 'journal.json'),
      ...UPDATE,
      oldProcess: {
        pid: 4001, processStartTime: NOW, installationId: 'install-A',
        processInstanceId: 'process-old', probeToken: 'O'.repeat(43),
      },
      resolveCandidateProcess: async () => phase === 'applying'
        ? { ...candidate, processInstanceId: 'process-orphan' }
        : candidate,
      probeProcess: async (record) => record.processInstanceId === 'process-old'
        ? { state: 'dead' }
        : stopped.has(record.processInstanceId) ? { state: 'dead' } : { state: 'alive', ...record },
      stopProcess: async (record) => { calls.push(`stop-${record.processInstanceId}`); stopped.add(record.processInstanceId); return { stopped: true } },
      restoreDatabase: async ({ backupPath }) => { assert.equal(backupPath, journal.backupPath); calls.push('restore-db') },
      writeCurrent: async ({ version }) => { assert.equal(version, '0.1.0'); calls.push('current-old') },
      startPrevious: async ({ env }) => { assert.equal(env.CROWN_WATCHER_AUTOSTART, '0'); calls.push('start-old') },
      now: () => NOW,
    })
    assert.deepEqual(result, { recovered: true, action: 'rolled-back', version: '0.1.0' })
    assert.deepEqual(calls, phase === 'applying'
      ? ['stop-process-orphan', 'restore-db', 'current-old', 'start-old']
      : ['stop-process-new', 'restore-db', 'current-old', 'start-old'])
    const persisted = JSON.parse(await readFile(join(root, 'updates', 'journal.json'), 'utf8'))
    assert.equal(persisted.phase, 'rolled-back')
    assert.equal(persisted.currentSwitched, false)
  }
})

test('recovery treats an identity-bound already-dead candidate as stopped and continues idempotently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-dead-candidate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeJournal(root, 'health-checking')
  const candidate = {
    pid: 5001, processStartTime: NOW, installationId: 'install-A',
    processInstanceId: 'process-new', probeToken: 'D'.repeat(43),
  }
  let stopCalled = false
  const result = await recoverUpdate({
    dataRoot: root, journalPath: join(root, 'updates', 'journal.json'), ...UPDATE,
    oldProcess: {
      pid: 4001, processStartTime: NOW, installationId: 'install-A',
      processInstanceId: 'process-old', probeToken: 'O'.repeat(43),
    },
    resolveCandidateProcess: async () => candidate,
    probeProcess: async () => ({ state: 'dead' }),
    stopProcess: async () => { stopCalled = true; return { stopped: true } },
    restoreDatabase: async () => {}, writeCurrent: async () => {}, startPrevious: async () => {},
    now: () => NOW,
  })
  assert.equal(result.action, 'rolled-back')
  assert.equal(stopCalled, false)
})

test('a durable rolled-back terminal tells launcher to start current without touching DB again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-terminal-start-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeJournal(root, 'health-checking')
  const journalPath = join(root, 'updates', 'journal.json')
  const value = JSON.parse(await readFile(journalPath, 'utf8'))
  await writeFile(journalPath, `${JSON.stringify({ ...value, phase: 'rolled-back', currentSwitched: false })}\n`)
  const unexpected = async () => assert.fail('terminal recovery must not mutate storage or processes')
  const result = await recoverUpdate({
    dataRoot: root, journalPath, ...UPDATE,
    resolveCandidateProcess: unexpected, probeProcess: unexpected, stopProcess: unexpected,
    restoreDatabase: unexpected, writeCurrent: unexpected, startPrevious: unexpected,
  })
  assert.deepEqual(result, { recovered: false, action: 'start-current', phase: 'rolled-back', version: '0.1.0' })
})

test('recovery rejects a terminal journal owned by another update before any action', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-journal-mismatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeJournal(root, 'committed', {
    updateId: 'update-old',
    currentSwitched: true,
    candidatePid: 5001,
    candidateInstanceId: 'process-old-update',
  })
  const unexpected = async () => assert.fail('mismatched terminal journal must not touch runtime')
  await assert.rejects(recoverUpdate({
    dataRoot: root,
    journalPath: join(root, 'updates', 'journal.json'),
    ...UPDATE,
    resolveCandidateProcess: unexpected,
    probeProcess: unexpected,
    stopProcess: unexpected,
    restoreDatabase: unexpected,
    writeCurrent: unexpected,
    startPrevious: unexpected,
  }), /update-recovery-journal-mismatch/)
})

test('real recovery child SIGKILL around terminal rollback never repeats DB restoration', async (t) => {
  const moduleUrl = new URL('../src/crown/update/update-applier.mjs', import.meta.url).href
  for (const point of ['after-rollback-terminal-before-old-start', 'after-old-start']) {
    const root = await mkdtemp(join(tmpdir(), `crown-recovery-terminal-kill-${point}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    await writeJournal(root, 'current-switched')
    const journalPath = join(root, 'updates', 'journal.json')
    const markerPath = join(root, 'old-started.txt')
    const script = `
      const [moduleUrl, dataRoot, journalPath, markerPath, point] = process.argv.slice(1);
      const { recoverUpdate } = await import(moduleUrl);
      const fs = await import('node:fs/promises');
      const oldProcess = { pid: 4001, processStartTime: '${NOW}', installationId: 'install-A', processInstanceId: 'process-old', probeToken: 'O'.repeat(43) };
      const candidate = { pid: 5001, processStartTime: '${NOW}', installationId: 'install-A', processInstanceId: 'process-new', probeToken: 'N'.repeat(43) };
      await recoverUpdate({
        dataRoot, journalPath, ...${JSON.stringify({ installationId: 'install-A', updateId: 'update-1', previousVersion: '0.1.0', candidateVersion: '0.2.0' })}, oldProcess,
        resolveCandidateProcess: async () => candidate,
        probeProcess: async () => ({ state: 'dead' }), stopProcess: async () => { throw new Error('must-not-stop-dead'); },
        restoreDatabase: async () => {}, writeCurrent: async () => {},
        startPrevious: async () => { await fs.writeFile(markerPath, 'started', { flag: 'wx' }); },
        faultInjector: async (current) => { if (current === point) { process.stdout.write('READY\\n'); await new Promise(() => {}); } },
      });
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, moduleUrl, root, journalPath, markerPath, point], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(child)
    child.kill('SIGKILL')
    await once(child, 'exit')
    let mutated = false
    const result = await recoverUpdate({
      dataRoot: root, journalPath, ...UPDATE,
      restoreDatabase: async () => { mutated = true }, writeCurrent: async () => { mutated = true },
      startPrevious: async () => { mutated = true },
    })
    assert.deepEqual(result, { recovered: false, action: 'start-current', phase: 'rolled-back', version: '0.1.0' })
    assert.equal(mutated, false)
    assert.equal(await readFile(markerPath, 'utf8').then(() => true, () => false), point === 'after-old-start')
  }
})

test('recovery marks pre-apply crashes failed without touching DB/current/processes and terminal journals are idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-safe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeJournal(root, 'staged')
  const unexpected = async () => assert.fail('safe pre-apply recovery must not mutate runtime')
  const first = await recoverUpdate({
    dataRoot: root, journalPath: join(root, 'updates', 'journal.json'), ...UPDATE,
    resolveCandidateProcess: unexpected, probeProcess: unexpected, stopProcess: unexpected,
    restoreDatabase: unexpected, writeCurrent: unexpected, startPrevious: unexpected, now: () => NOW,
  })
  assert.deepEqual(first, { recovered: true, action: 'marked-failed', version: '0.1.0' })
  const second = await recoverUpdate({
    dataRoot: root, journalPath: join(root, 'updates', 'journal.json'), ...UPDATE,
  })
  assert.deepEqual(second, { recovered: false, action: 'none', phase: 'failed' })
})

test('recovery fails closed before stopping a candidate whose PID/start/installation/instance/probe cannot all be proven', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeJournal(root, 'health-checking')
  let stopped = false
  await assert.rejects(recoverUpdate({
    dataRoot: root,
    journalPath: join(root, 'updates', 'journal.json'),
    ...UPDATE,
    oldProcess: {
      pid: 4001, processStartTime: NOW, installationId: 'install-A',
      processInstanceId: 'process-old', probeToken: 'O'.repeat(43),
    },
    resolveCandidateProcess: async () => ({
      pid: 5001, processStartTime: NOW, installationId: 'install-A',
      processInstanceId: 'process-new', probeToken: 'D'.repeat(43),
    }),
    probeProcess: async (record) => ({ state: 'alive', ...record, probeToken: 'wrong' }),
    stopProcess: async () => { stopped = true },
    restoreDatabase: async () => {}, writeCurrent: async () => {}, startPrevious: async () => {},
  }), /update-process-identity-mismatch/)
  assert.equal(stopped, false)
  const persisted = JSON.parse(await readFile(join(root, 'updates', 'journal.json'), 'utf8'))
  assert.equal(persisted.phase, 'health-checking')
})

test('an existing corrupt journal is never treated as if no recovery were needed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-recovery-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'updates'), { recursive: true })
  await writeFile(join(root, 'updates', 'journal.json'), '{not-json')
  await assert.rejects(recoverUpdate({
    dataRoot: root,
    journalPath: join(root, 'updates', 'journal.json'),
    ...UPDATE,
  }), /update-recovery-journal-invalid/)
})
