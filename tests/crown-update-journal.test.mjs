import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readAtomicJson, writeAtomicJson } from '../src/crown/update/atomic-json-file.mjs'
import { readUpdateJournal, startUpdateJournal } from '../src/crown/update/update-journal.mjs'
import { acquireUpdateProcessLock } from '../src/crown/update/update-process-lock.mjs'

const NOW = '2026-07-13T08:00:00.000Z'
const CURRENT_PROCESS_START = '2026-07-13T07:59:00.000Z'
const OLD_PROCESS_START = '2026-07-13T07:00:00.000Z'
const REUSED_PROCESS_START = '2026-07-13T07:30:00.000Z'

function initial(root, updateId = 'update-1') {
  return {
    dataRoot: root,
    journalPath: join(root, 'updates', 'journal.json'),
    installationId: 'install-A',
    updateId,
    previousVersion: '0.1.0',
    candidateVersion: '0.1.1',
    now: () => NOW,
  }
}

function lockPath(root) {
  return `${initial(root).journalPath}.lock`
}

function lockRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    installationId: 'install-A',
    updateId: 'update-old',
    pid: 900001,
    processStartTime: OLD_PROCESS_START,
    createdAt: NOW,
    nonce: 'A'.repeat(24),
    ...overrides,
  }
}

function claimArtifactPath(root, record = lockRecord()) {
  return join(root, 'updates', `.journal.json.lock.${record.pid}.${record.nonce}.claim`)
}

function directLockOptions(root, updateId = 'update-direct') {
  return {
    dataRoot: root,
    lockPath: lockPath(root),
    installationId: 'install-A',
    updateId,
    createdAt: NOW,
    processIdentityProbe: identityProbe({ state: 'dead' }),
  }
}

async function writeLock(root, record) {
  await mkdir(join(root, 'updates'), { recursive: true })
  await writeFile(lockPath(root), `${JSON.stringify(record)}\n`)
}

function identityProbe(owner) {
  return async (pid) => {
    if (pid === process.pid) return { state: 'alive', processStartTime: CURRENT_PROCESS_START }
    return owner
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function waitForBarrier(promise, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}-timeout`)), 2_000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

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
      child.once('exit', (code) => reject(new Error(`child-exited-before-ready:${code}`)))
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('child-ready-timeout')), 5_000)),
  ])
}

function spawnLockPhaseChild(root, phase) {
  const moduleUrl = new URL('../src/crown/update/update-process-lock.mjs', import.meta.url).href
  const script = `
    const [moduleUrl, dataRoot, lockPath, phase] = process.argv.slice(1);
    const { acquireUpdateProcessLock, SELF_PROCESS_START_TIME } = await import(moduleUrl);
    await acquireUpdateProcessLock({
      dataRoot,
      lockPath,
      installationId: 'install-A',
      updateId: 'update-child',
      createdAt: '${NOW}',
      processIdentityProbe: async (pid) => pid === process.pid
        ? { state: 'alive', processStartTime: SELF_PROCESS_START_TIME }
        : { state: 'dead' },
      reclaimFaultInjector: async (point) => {
        if (point !== phase) return;
        process.stdout.write('READY\\n');
        await new Promise(() => {});
      },
    });
    process.stdout.write('ACQUIRED\\n');
    setInterval(() => {}, 1000);
  `
  return spawn(process.execPath, [
    '--input-type=module', '--eval', script, moduleUrl, root, lockPath(root), phase,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function spawnRestoreLinkedChild(root) {
  const moduleUrl = new URL('../src/crown/update/update-process-lock.mjs', import.meta.url).href
  const script = `
    const [moduleUrl, dataRoot, lockPath] = process.argv.slice(1);
    const { acquireUpdateProcessLock, SELF_PROCESS_START_TIME } = await import(moduleUrl);
    let oldOwnerProbes = 0;
    await acquireUpdateProcessLock({
      dataRoot,
      lockPath,
      installationId: 'install-A',
      updateId: 'update-child-restore',
      createdAt: '${NOW}',
      processIdentityProbe: async (pid) => {
        if (pid === process.pid) return { state: 'alive', processStartTime: SELF_PROCESS_START_TIME };
        oldOwnerProbes += 1;
        return oldOwnerProbes < 3
          ? { state: 'dead' }
          : { state: 'alive', processStartTime: '${OLD_PROCESS_START}' };
      },
      reclaimFaultInjector: async (point) => {
        if (point !== 'after-claim-restore-linked') return;
        process.stdout.write('READY\\n');
        await new Promise(() => {});
      },
    });
    process.stdout.write('ACQUIRED\\n');
    setInterval(() => {}, 1000);
  `
  return spawn(process.execPath, [
    '--input-type=module', '--eval', script, moduleUrl, root, lockPath(root),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function forceKill(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
}

function readJournal(root) {
  return readUpdateJournal({ dataRoot: root, journalPath: initial(root).journalPath })
}

async function createBackup(root, name = 'before.sqlite') {
  const directory = join(root, 'backups')
  await mkdir(directory, { recursive: true })
  const backupPath = join(directory, name)
  await writeFile(backupPath, 'verified-backup')
  return backupPath
}

test('atomic JSON writes canonical data without partial files and strict journal schema rejects unknown fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'atomic', 'value.json')
  await writeAtomicJson({ dataRoot: root, filePath, value: { b: 2, a: 1 } })
  assert.equal(await readFile(filePath, 'utf8'), '{"b":2,"a":1}\n')
  assert.deepEqual(await readAtomicJson({ dataRoot: root, filePath }), { b: 2, a: 1 })
  assert.deepEqual(await readdir(join(root, 'atomic')), ['value.json'])

  const session = await startUpdateJournal(initial(root))
  await session.close()
  const state = await readJournal(root)
  await writeFile(initial(root).journalPath, `${JSON.stringify({ ...state, unknown: true })}\n`)
  await assert.rejects(readJournal(root), /update-journal-schema-invalid/)
  await writeFile(initial(root).journalPath, `${JSON.stringify({ ...state, updatedAt: 'not-a-time' })}\n`)
  await assert.rejects(readJournal(root), /update-journal-schema-invalid/)
})

test('atomic JSON requires a contained dataRoot and sanitizes validation callback failures', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outside = join(sandbox, 'outside.json')
  const filePath = join(dataRoot, 'updates', 'state.json')
  await mkdir(dataRoot)
  await writeFile(outside, '{}')

  await writeAtomicJson({ dataRoot, filePath, value: { ok: true } })
  assert.deepEqual(await readAtomicJson({ dataRoot, filePath }), { ok: true })
  await assert.rejects(writeAtomicJson({ dataRoot, filePath: outside, value: {} }), /atomic-json-path-invalid/)
  await assert.rejects(writeAtomicJson({ filePath, value: {} }), /atomic-json-data-root-invalid/)
  await assert.rejects(
    readAtomicJson({ dataRoot, filePath, validate: () => { throw new Error('secret callback details') } }),
    (error) => error?.message === 'atomic-json-validation-failed',
  )
  await assert.rejects(
    readAtomicJson({ dataRoot, filePath, validate: 'not-a-function' }),
    /atomic-json-validation-invalid/,
  )
})

test('journal serializes concurrent updates and allows a new update only after a terminal phase', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await startUpdateJournal(initial(root))
  await assert.rejects(startUpdateJournal(initial(root, 'update-2')), /update-already-running/)

  const backupPath = await createBackup(root)
  await first.transition('backup-complete', { backupPath })
  await first.transition('staged')
  await first.transition('applying')
  await first.transition('health-checking', {
    candidatePid: 4321,
    candidateInstanceId: 'install-A',
  })
  await first.transition('switch-pending')
  await first.transition('current-switched', { currentSwitched: true })
  await first.transition('committed')
  await first.close()

  const committed = await readJournal(root)
  assert.equal(committed.phase, 'committed')
  assert.equal(committed.currentSwitched, true)
  assert.equal(committed.backupPath, backupPath)
  assert.equal(committed.candidatePid, 4321)
  assert.equal(committed.candidateInstanceId, 'install-A')

  const second = await startUpdateJournal(initial(root, 'update-2'))
  assert.equal(second.state.updateId, 'update-2')
  await second.transition('failed')
  await second.close()
})

test('unfinished journals survive close and block a fresh update until recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await startUpdateJournal(initial(root))
  const backupPath = await createBackup(root)
  await first.transition('backup-complete', { backupPath })
  await first.close()

  await assert.rejects(startUpdateJournal(initial(root, 'update-2')), /update-journal-incomplete/)
  const recovered = await readJournal(root)
  assert.equal(recovered.phase, 'backup-complete')
  assert.equal(recovered.backupPath, backupPath)
  assert.deepEqual((await readdir(join(root, 'updates'))).sort(), ['journal.json'])
})

test('journal rejects invalid transitions and incomplete candidate identity before health check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = await startUpdateJournal(initial(root))
  await assert.rejects(session.transition('committed'), /update-journal-transition-invalid/)
  await session.transition('backup-complete', { backupPath: await createBackup(root) })
  await session.transition('staged')
  await session.transition('applying')
  await assert.rejects(session.transition('health-checking'), /update-journal-candidate-invalid/)
  await assert.rejects(session.transition('failed'), /update-journal-transition-invalid/)
  await session.transition('rolling-back')
  await session.transition('rolled-back')
  await session.close()
})

test('journal records candidate health before current switch and flushes explicit switch phases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = await startUpdateJournal(initial(root))
  await session.transition('backup-complete', { backupPath: await createBackup(root) })
  await session.transition('staged')
  await session.transition('applying')

  const health = await session.transition('health-checking', {
    candidatePid: 4321,
    candidateInstanceId: 'install-A',
  })
  assert.equal(health.currentSwitched, false)
  assert.equal((await readJournal(root)).phase, 'health-checking')

  const pending = await session.transition('switch-pending')
  assert.equal(pending.currentSwitched, false)
  assert.equal((await readJournal(root)).phase, 'switch-pending')

  await session.transition('current-switched', { currentSwitched: true })
  await session.transition('committed')
  await session.close()
})

test('journal schema rejects phase and recovery fields that cannot describe a safe recovery action', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const journalPath = initial(root).journalPath
  const session = await startUpdateJournal(initial(root))
  await session.close()
  const base = await readJournal(root)
  const backupPath = await createBackup(root)
  const invalid = [
    { ...base, phase: 'backup-complete', backupPath: '' },
    { ...base, phase: 'health-checking', backupPath, candidatePid: null, candidateInstanceId: '' },
    { ...base, phase: 'health-checking', backupPath, currentSwitched: true, candidatePid: 4321, candidateInstanceId: 'install-A' },
    { ...base, phase: 'committed', backupPath, currentSwitched: false, candidatePid: 4321, candidateInstanceId: 'install-A' },
    { ...base, phase: 'preparing', backupPath },
    { ...base, phase: 'preparing', candidatePid: 4321, candidateInstanceId: 'unexpected' },
  ]
  for (const state of invalid) {
    await writeFile(journalPath, `${JSON.stringify(state)}\n`)
    await assert.rejects(readUpdateJournal({ dataRoot: root, journalPath }), /update-journal-schema-invalid/)
  }
})

test('journal rejects invalid or throwing time callbacks with stable sanitized codes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(
    startUpdateJournal({ ...initial(root), now: 'not-a-function' }),
    /update-journal-time-source-invalid/,
  )
  await assert.rejects(
    startUpdateJournal({ ...initial(root), now: () => { throw new Error('secret clock failure') } }),
    (error) => error?.message === 'update-journal-time-failed',
  )
})

test('journal keeps backup and candidate recovery identity immutable after first durable write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstBackup = await createBackup(root, 'first.sqlite')
  const otherBackup = await createBackup(root, 'other.sqlite')
  const session = await startUpdateJournal(initial(root))
  await session.transition('backup-complete', { backupPath: firstBackup })
  await assert.rejects(
    session.transition('staged', { backupPath: otherBackup }),
    /update-journal-patch-invalid/,
  )
  await session.transition('staged')
  await assert.rejects(
    session.transition('applying', { currentSwitched: false }),
    /update-journal-patch-invalid/,
  )
  await session.transition('applying')
  await session.transition('health-checking', { candidatePid: 4321, candidateInstanceId: 'install-A' })
  await assert.rejects(
    session.transition('switch-pending', { candidatePid: 9999, candidateInstanceId: 'install-B' }),
    /update-journal-patch-invalid/,
  )
  await session.transition('switch-pending')
  await session.transition('current-switched', { currentSwitched: true })
  await session.transition('committed')
  await session.close()
})

test('journal lock is a complete atomically published owner identity record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = await startUpdateJournal({
    ...initial(root),
    processIdentityProbe: identityProbe({ state: 'dead' }),
  })
  const text = await readFile(lockPath(root), 'utf8')
  assert.equal(text.endsWith('\n'), true)
  const record = JSON.parse(text)
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'installationId', 'nonce', 'pid', 'processStartTime', 'schemaVersion', 'updateId',
  ])
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.installationId, 'install-A')
  assert.equal(record.updateId, 'update-1')
  assert.equal(record.pid, process.pid)
  assert.equal(record.processStartTime, CURRENT_PROCESS_START)
  assert.equal(record.createdAt, NOW)
  assert.match(record.nonce, /^[A-Za-z0-9_-]{24}$/)
  assert.deepEqual((await readdir(join(root, 'updates'))).sort(), ['journal.json', 'journal.json.lock'])
  await session.close()
})

test('journal lock reclaims only a dead owner whose complete snapshot is unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeLock(root, lockRecord())

  const session = await startUpdateJournal({
    ...initial(root),
    processIdentityProbe: identityProbe({ state: 'dead' }),
  })
  assert.equal(session.state.updateId, 'update-1')
  assert.equal(JSON.parse(await readFile(lockPath(root), 'utf8')).pid, process.pid)
  await session.close()
})

test('journal OS mutex prevents another contender from publishing through the quarantine gap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-lock-race-'))
  const afterClaim = deferred()
  const continueClaim = deferred()
  let firstLock
  let secondLock
  t.after(async () => {
    continueClaim.resolve()
    await firstLock?.release().catch(() => {})
    await secondLock?.release().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await writeLock(root, lockRecord())
  const common = {
    dataRoot: root,
    lockPath: lockPath(root),
    installationId: 'install-A',
    createdAt: NOW,
    processIdentityProbe: identityProbe({ state: 'dead' }),
  }

  const firstResult = acquireUpdateProcessLock({
    ...common,
    updateId: 'contender-A',
    reclaimFaultInjector: async (point) => {
      if (point !== 'after-quarantine-claim') return
      afterClaim.resolve()
      await continueClaim.promise
    },
  }).then(
    (lock) => {
      firstLock = lock
      return { status: 'fulfilled', lock }
    },
    (error) => ({ status: 'rejected', error }),
  )

  await waitForBarrier(afterClaim.promise, 'after-quarantine-claim')
  const secondResult = acquireUpdateProcessLock({ ...common, updateId: 'contender-B' }).then(
    (lock) => {
      secondLock = lock
      return { status: 'fulfilled', lock }
    },
    (error) => ({ status: 'rejected', error }),
  )

  continueClaim.resolve()
  const first = await firstResult
  const second = await secondResult
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(second.error?.message, 'update-already-running')
  assert.deepEqual(JSON.parse(await readFile(lockPath(root), 'utf8')), first.lock.record)
  assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])

  await firstLock.release()
  firstLock = null
  assert.deepEqual(await readdir(join(root, 'updates')), [])
})

test('journal quarantine restores a replaced live record without deleting the shared lock path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-lock-claim-replaced-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeLock(root, lockRecord())
  const replacement = lockRecord({
    pid: 900002,
    processStartTime: REUSED_PROCESS_START,
    nonce: 'B'.repeat(24),
  })

  await assert.rejects(acquireUpdateProcessLock({
    dataRoot: root,
    lockPath: lockPath(root),
    installationId: 'install-A',
    updateId: 'contender-A',
    createdAt: NOW,
    processIdentityProbe: identityProbe({
      state: 'alive',
      processStartTime: REUSED_PROCESS_START,
    }),
    reclaimFaultInjector: async (point, context) => {
      if (point !== 'after-quarantine-claim') return
      await rm(context.claimPath)
      await writeFile(context.claimPath, `${JSON.stringify(replacement)}\n`)
    },
  }), /update-already-running/)

  assert.deepEqual(JSON.parse(await readFile(lockPath(root), 'utf8')), replacement)
  assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])
})

test('journal live named pipe mutex cannot be stolen by another contender', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-live-os-lock-'))
  const acquiredOsLock = deferred()
  const continueAcquisition = deferred()
  let ownerLock
  t.after(async () => {
    continueAcquisition.resolve()
    await ownerLock?.release().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'updates'), { recursive: true })

  const ownerResult = acquireUpdateProcessLock({
    ...directLockOptions(root, 'contender-A'),
    reclaimFaultInjector: async (point) => {
      if (point !== 'after-os-lock-acquired') return
      acquiredOsLock.resolve()
      await continueAcquisition.promise
    },
  }).then(
    (lock) => {
      ownerLock = lock
      return { status: 'fulfilled', lock }
    },
    (error) => ({ status: 'rejected', error }),
  )

  await waitForBarrier(acquiredOsLock.promise, 'after-os-lock-acquired')
  await assert.rejects(
    acquireUpdateProcessLock(directLockOptions(root, 'contender-B')),
    /update-already-running/,
  )
  continueAcquisition.resolve()
  const owner = await ownerResult
  assert.equal(owner.status, 'fulfilled')
  assert.deepEqual(JSON.parse(await readFile(lockPath(root), 'utf8')), owner.lock.record)
  assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])

  await ownerLock.release()
  ownerLock = null
  assert.deepEqual(await readdir(join(root, 'updates')), [])
})

test('journal lock fails closed on corrupt or unknown orphan claim artifacts', async (t) => {
  const corruptRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-corrupt-claim-'))
  const unknownRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-unknown-claim-'))
  t.after(async () => {
    await rm(corruptRoot, { recursive: true, force: true })
    await rm(unknownRoot, { recursive: true, force: true })
  })
  await mkdir(join(corruptRoot, 'updates'), { recursive: true })
  await mkdir(join(unknownRoot, 'updates'), { recursive: true })
  const corruptPath = claimArtifactPath(corruptRoot)
  const unknownPath = claimArtifactPath(unknownRoot)
  await writeFile(corruptPath, '{broken-claim', 'utf8')
  await writeFile(unknownPath, `${JSON.stringify(lockRecord())}\n`, 'utf8')

  await assert.rejects(
    acquireUpdateProcessLock(directLockOptions(corruptRoot, 'contender-corrupt')),
    /update-journal-lock-unverifiable/,
  )
  await assert.rejects(acquireUpdateProcessLock({
    ...directLockOptions(unknownRoot, 'contender-unknown'),
    processIdentityProbe: identityProbe({ state: 'unknown' }),
  }), /update-journal-lock-unverifiable/)
  assert.equal(await readFile(corruptPath, 'utf8'), '{broken-claim')
  assert.deepEqual(JSON.parse(await readFile(unknownPath, 'utf8')), lockRecord())
  await assert.rejects(readFile(lockPath(corruptRoot), 'utf8'), /ENOENT/)
  await assert.rejects(readFile(lockPath(unknownRoot), 'utf8'), /ENOENT/)
})

test('journal never deletes mismatched or multiple shared claim artifacts', async (t) => {
  const mismatchedRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-mismatched-claim-'))
  const multipleRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-multiple-claim-'))
  t.after(async () => {
    await rm(mismatchedRoot, { recursive: true, force: true })
    await rm(multipleRoot, { recursive: true, force: true })
  })
  const stale = lockRecord()
  await writeLock(mismatchedRoot, stale)
  const mismatchedClaim = claimArtifactPath(mismatchedRoot, stale)
  await writeFile(mismatchedClaim, `${JSON.stringify(stale)}\n`)
  const [sharedMetadata, claimMetadata] = await Promise.all([
    stat(lockPath(mismatchedRoot), { bigint: true }),
    stat(mismatchedClaim, { bigint: true }),
  ])
  assert.notEqual(sharedMetadata.ino, claimMetadata.ino)
  await assert.rejects(
    acquireUpdateProcessLock(directLockOptions(mismatchedRoot, 'update-mismatched')),
    /update-journal-lock-unverifiable/,
  )
  assert.equal(await readFile(lockPath(mismatchedRoot), 'utf8'), `${JSON.stringify(stale)}\n`)
  assert.equal(await readFile(mismatchedClaim, 'utf8'), `${JSON.stringify(stale)}\n`)

  await writeLock(multipleRoot, stale)
  const firstClaim = claimArtifactPath(multipleRoot, stale)
  const other = lockRecord({ pid: 900002, nonce: 'B'.repeat(24) })
  const secondClaim = claimArtifactPath(multipleRoot, other)
  await link(lockPath(multipleRoot), firstClaim)
  await writeFile(secondClaim, `${JSON.stringify(other)}\n`)
  await assert.rejects(
    acquireUpdateProcessLock(directLockOptions(multipleRoot, 'update-multiple')),
    /update-journal-lock-unverifiable/,
  )
  assert.deepEqual((await readdir(join(multipleRoot, 'updates'))).sort(), [
    '.journal.json.lock.900001.AAAAAAAAAAAAAAAAAAAAAAAA.claim',
    '.journal.json.lock.900002.BBBBBBBBBBBBBBBBBBBBBBBB.claim',
    'journal.json.lock',
  ])
})

test('journal lock never steals a live owner and uses processStartTime to detect PID reuse', async (t) => {
  const liveRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-live-lock-'))
  const reusedRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-reused-lock-'))
  t.after(async () => {
    await rm(liveRoot, { recursive: true, force: true })
    await rm(reusedRoot, { recursive: true, force: true })
  })
  const record = lockRecord()
  await writeLock(liveRoot, record)
  const liveText = await readFile(lockPath(liveRoot), 'utf8')
  await assert.rejects(startUpdateJournal({
    ...initial(liveRoot),
    processIdentityProbe: identityProbe({ state: 'alive', processStartTime: OLD_PROCESS_START }),
  }), /update-already-running/)
  assert.equal(await readFile(lockPath(liveRoot), 'utf8'), liveText)

  await writeLock(reusedRoot, record)
  const reused = await startUpdateJournal({
    ...initial(reusedRoot),
    processIdentityProbe: identityProbe({ state: 'alive', processStartTime: REUSED_PROCESS_START }),
  })
  assert.equal(reused.state.updateId, 'update-1')
  await reused.close()
})

test('journal lock fails closed without deleting unknown, changed, or corrupted owners', async (t) => {
  const unknownRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-unknown-lock-'))
  const changedRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-changed-lock-'))
  const corruptRoot = await mkdtemp(join(tmpdir(), 'crown-update-journal-corrupt-lock-'))
  t.after(async () => {
    await rm(unknownRoot, { recursive: true, force: true })
    await rm(changedRoot, { recursive: true, force: true })
    await rm(corruptRoot, { recursive: true, force: true })
  })

  await writeLock(unknownRoot, lockRecord())
  const unknownText = await readFile(lockPath(unknownRoot), 'utf8')
  await assert.rejects(startUpdateJournal({
    ...initial(unknownRoot),
    processIdentityProbe: identityProbe({ state: 'unknown' }),
  }), /update-journal-lock-unverifiable/)
  assert.equal(await readFile(lockPath(unknownRoot), 'utf8'), unknownText)

  await writeLock(changedRoot, lockRecord())
  const replacement = lockRecord({
    pid: 900002,
    processStartTime: REUSED_PROCESS_START,
    nonce: 'B'.repeat(24),
  })
  let changed = false
  await assert.rejects(startUpdateJournal({
    ...initial(changedRoot),
    processIdentityProbe: async (pid) => {
      if (pid === process.pid) return { state: 'alive', processStartTime: CURRENT_PROCESS_START }
      if (!changed) {
        changed = true
        await writeFile(lockPath(changedRoot), `${JSON.stringify(replacement)}\n`)
        return { state: 'dead' }
      }
      return { state: 'alive', processStartTime: REUSED_PROCESS_START }
    },
  }), /update-already-running/)
  assert.deepEqual(JSON.parse(await readFile(lockPath(changedRoot), 'utf8')), replacement)

  await mkdir(join(corruptRoot, 'updates'), { recursive: true })
  await writeFile(lockPath(corruptRoot), '{broken-json', 'utf8')
  await assert.rejects(startUpdateJournal({
    ...initial(corruptRoot),
    processIdentityProbe: identityProbe({ state: 'dead' }),
  }), /update-journal-lock-unverifiable/)
  assert.equal(await readFile(lockPath(corruptRoot), 'utf8'), '{broken-json')
})

for (const phase of [
  'after-os-lock-acquired',
  'after-quarantine-claim',
  'after-new-lock-published',
]) {
  test(`journal OS mutex auto-releases after a child is force-killed at ${phase}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `crown-update-journal-os-kill-${phase}-`))
    let child
    t.after(async () => {
      if (child) await forceKill(child).catch(() => {})
      await rm(root, { recursive: true, force: true })
    })
    await mkdir(join(root, 'updates'), { recursive: true })
    if (phase !== 'after-new-lock-published') await writeLock(root, lockRecord())
    child = spawnLockPhaseChild(root, phase)
    await waitForReady(child)

    await assert.rejects(
      acquireUpdateProcessLock(directLockOptions(root, 'update-live-contender')),
      /update-already-running/,
    )
    await forceKill(child)

    const recovered = await acquireUpdateProcessLock(directLockOptions(root, 'update-after-kill'))
    assert.equal(recovered.record.updateId, 'update-after-kill')
    assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])
    await recovered.release()
    assert.deepEqual(await readdir(join(root, 'updates')), [])
  })
}

test('journal recovers when a child is force-killed after linking a claim back to the shared lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-os-kill-restore-linked-'))
  let child
  t.after(async () => {
    if (child) await forceKill(child).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const stale = lockRecord()
  await writeLock(root, stale)
  child = spawnRestoreLinkedChild(root)
  await waitForReady(child)

  await assert.rejects(
    acquireUpdateProcessLock(directLockOptions(root, 'update-live-contender')),
    /update-already-running/,
  )
  await forceKill(child)
  const claimPath = claimArtifactPath(root, stale)
  const [sharedMetadata, claimMetadata] = await Promise.all([
    stat(lockPath(root), { bigint: true }),
    stat(claimPath, { bigint: true }),
  ])
  assert.equal(sharedMetadata.dev, claimMetadata.dev)
  assert.equal(sharedMetadata.ino, claimMetadata.ino)
  assert.equal(await readFile(lockPath(root), 'utf8'), await readFile(claimPath, 'utf8'))

  const recovered = await acquireUpdateProcessLock(directLockOptions(root, 'update-after-kill'))
  assert.equal(recovered.record.updateId, 'update-after-kill')
  assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])
  await recovered.release()
  assert.deepEqual(await readdir(join(root, 'updates')), [])
})

test('journal recovers identical linked snapshots even when the claim name describes the prior owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-linked-prior-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prior = lockRecord()
  const restored = lockRecord({
    pid: 900002,
    processStartTime: REUSED_PROCESS_START,
    nonce: 'B'.repeat(24),
  })
  await writeLock(root, restored)
  await link(lockPath(root), claimArtifactPath(root, prior))

  const recovered = await acquireUpdateProcessLock(directLockOptions(root, 'update-after-prior-owner'))
  assert.equal(recovered.record.updateId, 'update-after-prior-owner')
  assert.deepEqual(await readdir(join(root, 'updates')), ['journal.json.lock'])
  await recovered.release()
  assert.deepEqual(await readdir(join(root, 'updates')), [])
})

test('journal lock left by a force-killed child is reclaimed while its incomplete journal remains for recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-journal-killed-lock-'))
  const moduleUrl = new URL('../src/crown/update/update-journal.mjs', import.meta.url).href
  const script = `
    const [moduleUrl, dataRoot, journalPath] = process.argv.slice(1);
    const { startUpdateJournal } = await import(moduleUrl);
    await startUpdateJournal({
      dataRoot, journalPath, installationId: 'install-A', updateId: 'update-child',
      previousVersion: '0.1.0', candidateVersion: '0.1.1',
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', script, moduleUrl, root, initial(root).journalPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit').catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await waitForReady(child)
  const childLock = JSON.parse(await readFile(lockPath(root), 'utf8'))
  assert.equal(childLock.pid, child.pid)

  await assert.rejects(startUpdateJournal(initial(root, 'update-live-contender')), /update-already-running/)
  assert.equal(JSON.parse(await readFile(lockPath(root), 'utf8')).nonce, childLock.nonce)

  child.kill('SIGKILL')
  await once(child, 'exit')
  await assert.rejects(startUpdateJournal(initial(root, 'update-after-kill')), /update-journal-incomplete/)
  await assert.rejects(readFile(lockPath(root), 'utf8'), /ENOENT/)
  assert.equal((await readJournal(root)).updateId, 'update-child')
})
