import { createHash, randomBytes } from 'node:crypto'
import { link, readdir, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'

import { syncDirectory } from './atomic-json-file.mjs'
import {
  openVerifiedDataFile,
  sameFileIdentity,
  syncPublishedDataFile,
  validateDataPath,
} from './safe-data-path.mjs'

const MAX_LOCK_BYTES = 16 * 1024
const LOCK_FIELDS = Object.freeze([
  'schemaVersion', 'installationId', 'updateId', 'pid', 'processStartTime', 'createdAt', 'nonce',
])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NONCE = /^[A-Za-z0-9_-]{24}$/
const SELF_PROCESS_START_TIME = new Date(Date.now() - (process.uptime() * 1000)).toISOString()

function codedError(code) {
  return new Error(code)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validIso(value) {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function parseLockRecord(text) {
  let record
  try { record = JSON.parse(text) } catch { return null }
  if (!isPlainObject(record)
    || Object.keys(record).length !== LOCK_FIELDS.length
    || LOCK_FIELDS.some((field) => !Object.hasOwn(record, field))
    || record.schemaVersion !== 1
    || !ID.test(record.installationId)
    || !ID.test(record.updateId)
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || !validIso(record.processStartTime)
    || !validIso(record.createdAt)
    || !NONCE.test(record.nonce)) return null
  return Object.freeze({ ...record })
}

function sameLockRecord(left, right) {
  return Boolean(left && right && LOCK_FIELDS.every((field) => left[field] === right[field]))
}

export async function defaultProcessIdentityProbe(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' }
  if (pid === process.pid) return { state: 'alive', processStartTime: SELF_PROCESS_START_TIME }
  try {
    process.kill(pid, 0)
    return { state: 'unknown' }
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'dead' }
    return { state: 'unknown' }
  }
}

async function probeIdentity(processIdentityProbe, pid) {
  let result
  try {
    result = await processIdentityProbe(pid)
  } catch {
    throw codedError('update-journal-lock-unverifiable')
  }
  try {
    if (!isPlainObject(result)) throw new Error('invalid')
    const fields = Object.keys(result).sort().join(',')
    if (result.state === 'alive' && fields === 'processStartTime,state' && validIso(result.processStartTime)) {
      return Object.freeze({ state: 'alive', processStartTime: result.processStartTime })
    }
    if ((result.state === 'dead' || result.state === 'unknown') && fields === 'state') {
      return Object.freeze({ state: result.state })
    }
  } catch {}
  throw codedError('update-journal-lock-unverifiable')
}

async function readLockSnapshot({ dataRoot, lockPath }) {
  let target
  try {
    target = await validateDataPath({ dataRoot, targetPath: lockPath })
  } catch {
    throw codedError('update-journal-lock-unverifiable')
  }
  if (!target.exists) return null
  let opened
  try {
    opened = await openVerifiedDataFile({ dataRoot, filePath: target.path, flags: 'r' })
    const metadata = await opened.handle.stat()
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_LOCK_BYTES) {
      throw codedError('update-journal-lock-unverifiable')
    }
    const text = await opened.handle.readFile('utf8')
    const afterRead = await validateDataPath({
      dataRoot,
      targetPath: target.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterRead.identity)) {
      throw codedError('update-journal-lock-unverifiable')
    }
    return Object.freeze({
      identity: opened.identity,
      text,
      record: parseLockRecord(text),
    })
  } catch (error) {
    if (error?.message === 'safe-data-path-not-found') return null
    if (error instanceof Error && error.message.startsWith('update-journal-')) throw error
    throw codedError('update-journal-lock-unverifiable')
  } finally {
    await opened?.handle.close().catch(() => {})
  }
}

function sameSnapshot(left, right) {
  return Boolean(left && right
    && left.text === right.text
    && sameFileIdentity(left.identity, right.identity)
    && ((left.record === null && right.record === null)
      || sameLockRecord(left.record, right.record)))
}

async function removeMatchingFile({ dataRoot, filePath, expectedIdentity }) {
  try {
    const current = await validateDataPath({
      dataRoot,
      targetPath: filePath,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(current.identity, expectedIdentity)) return false
    await rm(current.path)
    return true
  } catch {
    return false
  }
}

async function createCompleteCandidate({ dataRoot, lockPath, record }) {
  const temporaryPath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${record.pid}.${record.nonce}.tmp`,
  )
  let temporary
  try {
    temporary = await openVerifiedDataFile({
      dataRoot,
      filePath: temporaryPath,
      flags: 'wx',
      mode: 0o600,
    })
    await temporary.handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await temporary.handle.sync()
    await temporary.handle.close()
    return { path: temporaryPath, identity: temporary.identity }
  } catch (error) {
    await temporary?.handle.close().catch(() => {})
    if (temporary?.identity) {
      await removeMatchingFile({ dataRoot, filePath: temporaryPath, expectedIdentity: temporary.identity })
    }
    if (error?.message === 'safe-data-path-exists') throw codedError('update-journal-lock-unavailable')
    throw codedError('update-journal-lock-unavailable')
  }
}

async function tryPublishLock({ dataRoot, lockPath, record }) {
  const candidate = await createCompleteCandidate({ dataRoot, lockPath, record })
  let published = false
  try {
    try {
      await link(candidate.path, lockPath)
      published = true
    } catch (error) {
      if (error?.code === 'EEXIST') return { acquired: false }
      throw codedError('update-journal-lock-unavailable')
    }
    await syncPublishedDataFile({ dataRoot, filePath: lockPath, expectedIdentity: candidate.identity })
    const snapshot = await readLockSnapshot({ dataRoot, lockPath })
    if (!snapshot
      || !sameFileIdentity(snapshot.identity, candidate.identity)
      || !sameLockRecord(snapshot.record, record)) {
      throw codedError('update-journal-lock-unavailable')
    }
    await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
    return { acquired: true, identity: candidate.identity }
  } catch (error) {
    if (published) {
      await removeMatchingFile({ dataRoot, filePath: lockPath, expectedIdentity: candidate.identity })
    }
    if (error instanceof Error && error.message.startsWith('update-journal-')) throw error
    throw codedError('update-journal-lock-unavailable')
  } finally {
    await removeMatchingFile({ dataRoot, filePath: candidate.path, expectedIdentity: candidate.identity })
  }
}

async function classifyOwner(record, processIdentityProbe) {
  const identity = await probeIdentity(processIdentityProbe, record.pid)
  if (identity.state === 'unknown') throw codedError('update-journal-lock-unverifiable')
  if (identity.state === 'dead') return 'reclaimable'
  return identity.processStartTime === record.processStartTime ? 'active' : 'reclaimable'
}

async function runReclaimFaultInjector(reclaimFaultInjector, point, context = {}) {
  if (!reclaimFaultInjector) return
  try {
    await reclaimFaultInjector(point, Object.freeze({ ...context }))
  } catch {
    throw codedError('update-journal-lock-unavailable')
  }
}

async function restoreClaimedLock({
  dataRoot,
  lockPath,
  claimPath,
  snapshot,
  reclaimFaultInjector,
}) {
  const claimed = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (!sameSnapshot(claimed, snapshot)) throw codedError('update-journal-lock-unverifiable')
  let linked = false
  try {
    await link(claimPath, lockPath)
    linked = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw codedError('update-journal-lock-unavailable')
    const existing = await readLockSnapshot({ dataRoot, lockPath })
    if (!sameSnapshot(existing, snapshot)) throw codedError('update-journal-lock-unverifiable')
  }
  if (linked) {
    await runReclaimFaultInjector(reclaimFaultInjector, 'after-claim-restore-linked', { claimPath })
  }
  try {
    await syncPublishedDataFile({
      dataRoot,
      filePath: lockPath,
      expectedIdentity: snapshot.identity,
    })
    const restored = await readLockSnapshot({ dataRoot, lockPath })
    const finalClaimed = await readLockSnapshot({ dataRoot, lockPath: claimPath })
    if (!sameSnapshot(restored, snapshot) || !sameSnapshot(finalClaimed, snapshot)) {
      throw codedError('update-journal-lock-unverifiable')
    }
    await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
    if (!await removeMatchingFile({
      dataRoot,
      filePath: claimPath,
      expectedIdentity: snapshot.identity,
    })) throw codedError('update-journal-lock-unverifiable')
    await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('update-journal-')) throw error
    throw codedError('update-journal-lock-unverifiable')
  }
}

async function cleanClaimedStaleLock({ dataRoot, lockPath, claimPath, snapshot }) {
  const current = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (!sameSnapshot(current, snapshot)) throw codedError('update-journal-lock-unverifiable')
  if (!await removeMatchingFile({
    dataRoot,
    filePath: claimPath,
    expectedIdentity: snapshot.identity,
  })) throw codedError('update-journal-lock-unverifiable')
  await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
}

async function claimReclaimableLock({
  dataRoot,
  lockPath,
  snapshot,
  processIdentityProbe,
  reclaimFaultInjector,
}) {
  const current = await readLockSnapshot({ dataRoot, lockPath })
  if (!sameSnapshot(current, snapshot)) return false
  const classification = await classifyOwner(current.record, processIdentityProbe)
  if (classification === 'active') throw codedError('update-already-running')
  const final = await readLockSnapshot({ dataRoot, lockPath })
  if (!sameSnapshot(final, current)) return false
  const claimPath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${snapshot.record.pid}.${snapshot.record.nonce}.claim`,
  )
  const existingClaim = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (existingClaim) throw codedError('update-journal-lock-unverifiable')
  await runReclaimFaultInjector(reclaimFaultInjector, 'before-quarantine-claim', { claimPath })
  try {
    await rename(lockPath, claimPath)
    await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw codedError('update-journal-lock-unavailable')
  }
  await runReclaimFaultInjector(reclaimFaultInjector, 'after-quarantine-claim', { claimPath })

  const claimed = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (!sameSnapshot(claimed, final)) {
    if (!claimed) throw codedError('update-journal-lock-unverifiable')
    await restoreClaimedLock({
      dataRoot, lockPath, claimPath, snapshot: claimed, reclaimFaultInjector,
    })
    return false
  }

  let claimedClassification
  try {
    claimedClassification = await classifyOwner(claimed.record, processIdentityProbe)
  } catch (error) {
    await restoreClaimedLock({
      dataRoot, lockPath, claimPath, snapshot: claimed, reclaimFaultInjector,
    })
    throw error
  }
  if (claimedClassification === 'active') {
    await restoreClaimedLock({
      dataRoot, lockPath, claimPath, snapshot: claimed, reclaimFaultInjector,
    })
    return false
  }

  const finalClaimed = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (!sameSnapshot(finalClaimed, claimed)) {
    if (!finalClaimed) throw codedError('update-journal-lock-unverifiable')
    await restoreClaimedLock({
      dataRoot, lockPath, claimPath, snapshot: finalClaimed, reclaimFaultInjector,
    })
    throw codedError('update-journal-lock-unverifiable')
  }
  await cleanClaimedStaleLock({ dataRoot, lockPath, claimPath, snapshot: claimed })
  return true
}

async function releaseOwnedLock({ dataRoot, lockPath, record, identity }) {
  const snapshot = await readLockSnapshot({ dataRoot, lockPath })
  if (!snapshot
    || !sameFileIdentity(snapshot.identity, identity)
    || !sameLockRecord(snapshot.record, record)) {
    throw codedError('update-journal-lock-lost')
  }
  const final = await readLockSnapshot({ dataRoot, lockPath })
  if (!sameSnapshot(final, snapshot)) throw codedError('update-journal-lock-lost')
  try {
    await rm(lockPath)
    await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
  } catch {
    throw codedError('update-journal-lock-release-failed')
  }
}

function updateMutexPipeName(dataRoot, installationId) {
  if (process.platform !== 'win32') throw codedError('update-journal-os-lock-unsupported')
  const scope = `${installationId}\0${dataRoot.toLowerCase()}`
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 40)
  return `\\\\.\\pipe\\CrownMonitor-Update-${digest}`
}

async function acquireWindowsUpdateMutex({ dataRoot, installationId }) {
  const pipeName = updateMutexPipeName(dataRoot, installationId)
  const server = createServer((socket) => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(pipeName)
    })
  } catch (error) {
    if (error?.code === 'EADDRINUSE') throw codedError('update-already-running')
    throw codedError('update-journal-os-lock-unavailable')
  }
  let closed = false
  return Object.freeze({
    pipeName,
    close: async () => {
      if (closed) return
      closed = true
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
      } catch {
        throw codedError('update-journal-os-lock-release-failed')
      }
    },
  })
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readOrphanClaim({ dataRoot, lockPath }) {
  const prefix = `.${basename(lockPath)}.`
  const suffix = '.claim'
  let entries
  try {
    entries = await readdir(dirname(lockPath))
  } catch {
    throw codedError('update-journal-lock-unavailable')
  }
  const names = entries.filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
  if (names.length === 0) return null
  if (names.length !== 1) throw codedError('update-journal-lock-unverifiable')
  const pattern = new RegExp(`^\\.${escapedRegex(basename(lockPath))}\\.([1-9][0-9]*)\\.([A-Za-z0-9_-]{24})\\.claim$`)
  const match = pattern.exec(names[0])
  if (!match) throw codedError('update-journal-lock-unverifiable')
  const claimPath = join(dirname(lockPath), names[0])
  const snapshot = await readLockSnapshot({ dataRoot, lockPath: claimPath })
  if (!snapshot?.record) throw codedError('update-journal-lock-unverifiable')
  return Object.freeze({
    claimPath,
    snapshot,
    nameMatchesRecord: String(snapshot.record.pid) === match[1]
      && snapshot.record.nonce === match[2],
  })
}

async function cleanOrphanClaim({
  dataRoot,
  lockPath,
  installationId,
  processIdentityProbe,
  orphan,
}) {
  if (!orphan.nameMatchesRecord) throw codedError('update-journal-lock-unverifiable')
  if (orphan.snapshot.record.installationId !== installationId) {
    throw codedError('update-journal-lock-unverifiable')
  }
  const classification = await classifyOwner(orphan.snapshot.record, processIdentityProbe)
  if (classification === 'active') throw codedError('update-already-running')
  const final = await readLockSnapshot({ dataRoot, lockPath: orphan.claimPath })
  if (!sameSnapshot(final, orphan.snapshot)) throw codedError('update-journal-lock-unverifiable')
  await cleanClaimedStaleLock({
    dataRoot,
    lockPath,
    claimPath: orphan.claimPath,
    snapshot: orphan.snapshot,
  })
}

async function cleanRedundantLinkedClaim({ dataRoot, lockPath, shared, orphan }) {
  const beforeShared = await readLockSnapshot({ dataRoot, lockPath })
  const beforeClaim = await readLockSnapshot({ dataRoot, lockPath: orphan.claimPath })
  if (!sameSnapshot(beforeShared, shared)
    || !sameSnapshot(beforeClaim, orphan.snapshot)
    || !sameSnapshot(beforeShared, beforeClaim)) {
    throw codedError('update-journal-lock-unverifiable')
  }
  if (!await removeMatchingFile({
    dataRoot,
    filePath: orphan.claimPath,
    expectedIdentity: beforeClaim.identity,
  })) throw codedError('update-journal-lock-unverifiable')
  await syncDirectory({ dataRoot, directoryPath: dirname(lockPath) })
  const afterShared = await readLockSnapshot({ dataRoot, lockPath })
  const afterClaim = await readLockSnapshot({ dataRoot, lockPath: orphan.claimPath })
  if (!sameSnapshot(afterShared, shared) || afterClaim) {
    throw codedError('update-journal-lock-unverifiable')
  }
}

function ownedLock({ dataRoot, lockPath, record, identity, mutex }) {
  let released = false
  return Object.freeze({
    record,
    identity,
    release: async () => {
      if (released) return
      released = true
      let failure = null
      try {
        await releaseOwnedLock({ dataRoot, lockPath, record, identity })
      } catch (error) {
        failure = error
      }
      try {
        await mutex.close()
      } catch (error) {
        if (!failure) failure = error
      }
      if (failure) throw failure
    },
  })
}

export async function acquireUpdateProcessLock({
  dataRoot,
  lockPath,
  installationId,
  updateId,
  createdAt,
  processIdentityProbe = defaultProcessIdentityProbe,
  reclaimFaultInjector,
} = {}) {
  if (!ID.test(installationId || '') || !ID.test(updateId || '') || !validIso(createdAt)) {
    throw codedError('update-journal-lock-record-invalid')
  }
  if (typeof processIdentityProbe !== 'function') throw codedError('update-journal-process-probe-invalid')
  if (reclaimFaultInjector !== undefined && typeof reclaimFaultInjector !== 'function') {
    throw codedError('update-journal-lock-fault-injector-invalid')
  }
  let target
  try {
    target = await validateDataPath({ dataRoot, targetPath: lockPath })
  } catch {
    throw codedError('update-journal-lock-unavailable')
  }
  const selfIdentity = await probeIdentity(processIdentityProbe, process.pid)
  if (selfIdentity.state !== 'alive') throw codedError('update-journal-process-identity-unavailable')
  const record = Object.freeze({
    schemaVersion: 1,
    installationId,
    updateId,
    pid: process.pid,
    processStartTime: selfIdentity.processStartTime,
    createdAt,
    nonce: randomBytes(18).toString('base64url'),
  })
  if (!parseLockRecord(JSON.stringify(record))) throw codedError('update-journal-lock-record-invalid')
  const root = target.dataRoot
  const path = target.path
  const mutex = await acquireWindowsUpdateMutex({ dataRoot: root, installationId })
  let published = null
  try {
    await runReclaimFaultInjector(reclaimFaultInjector, 'after-os-lock-acquired', {
      pipeName: mutex.pipeName,
    })
    let orphan = await readOrphanClaim({ dataRoot: root, lockPath: path })
    let snapshot = await readLockSnapshot({ dataRoot: root, lockPath: path })
    if (orphan && snapshot) {
      if (!sameSnapshot(snapshot, orphan.snapshot)) {
        throw codedError('update-journal-lock-unverifiable')
      }
      await cleanRedundantLinkedClaim({
        dataRoot: root,
        lockPath: path,
        shared: snapshot,
        orphan,
      })
      orphan = null
    }
    if (orphan) {
      await cleanOrphanClaim({
        dataRoot: root,
        lockPath: path,
        installationId,
        processIdentityProbe,
        orphan,
      })
    }
    snapshot = await readLockSnapshot({ dataRoot: root, lockPath: path })
    if (snapshot) {
      if (!snapshot.record || snapshot.record.installationId !== installationId) {
        throw codedError('update-journal-lock-unverifiable')
      }
      const classification = await classifyOwner(snapshot.record, processIdentityProbe)
      if (classification === 'active') throw codedError('update-already-running')
      const claimed = await claimReclaimableLock({
        dataRoot: root,
        lockPath: path,
        snapshot,
        processIdentityProbe,
        reclaimFaultInjector,
      })
      if (!claimed) {
        const replacement = await readLockSnapshot({ dataRoot: root, lockPath: path })
        if (replacement?.record && replacement.record.installationId === installationId
          && await classifyOwner(replacement.record, processIdentityProbe) === 'active') {
          throw codedError('update-already-running')
        }
        throw codedError('update-journal-lock-unverifiable')
      }
    }
    published = await tryPublishLock({ dataRoot: root, lockPath: path, record })
    if (!published.acquired) throw codedError('update-journal-lock-unverifiable')
    await runReclaimFaultInjector(reclaimFaultInjector, 'after-new-lock-published')
    return ownedLock({
      dataRoot: root,
      lockPath: path,
      record,
      identity: published.identity,
      mutex,
    })
  } catch (error) {
    if (published?.acquired) {
      await releaseOwnedLock({
        dataRoot: root,
        lockPath: path,
        record,
        identity: published.identity,
      }).catch(() => {})
    }
    await mutex.close().catch(() => {})
    if (error instanceof Error && error.message.startsWith('update-journal-')) throw error
    if (error?.message === 'update-already-running') throw error
    throw codedError('update-journal-lock-unavailable')
  }
}

export { SELF_PROCESS_START_TIME }
