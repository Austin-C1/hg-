import { randomUUID } from 'node:crypto'
import { link, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, relative } from 'node:path'

import { syncDirectory } from './atomic-json-file.mjs'
import {
  ensureDataDirectory,
  openVerifiedDataFile,
  sameFileIdentity,
  syncPublishedDataFile,
  validateDataPath,
} from './safe-data-path.mjs'

function codedError(code) {
  return new Error(code)
}

function known(error) {
  return error instanceof Error && error.message.startsWith('sqlite-')
}

async function sqlitePath({ dataRoot, filePath, code, requireExists }) {
  if (typeof dataRoot !== 'string') throw codedError('sqlite-data-root-invalid')
  try {
    return await validateDataPath({
      dataRoot,
      targetPath: filePath,
      requireExists,
      expectDirectory: requireExists ? false : undefined,
    })
  } catch {
    throw codedError(code)
  }
}

async function verifySqlitePath({ target, expectedUserVersion, expectedIdentity }) {
  let opened
  let db
  try {
    opened = await openVerifiedDataFile({
      dataRoot: target.dataRoot,
      filePath: target.path,
      flags: 'r',
      expectedIdentity,
    })
    db = new DatabaseSync(target.path, { readOnly: true })
    const afterOpen = await validateDataPath({
      dataRoot: target.dataRoot,
      targetPath: target.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterOpen.identity)) throw codedError('sqlite-file-identity-changed')

    db.exec('PRAGMA foreign_keys=ON')
    const integrityRows = db.prepare('PRAGMA integrity_check').all()
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      throw codedError('sqlite-integrity-check-failed')
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw codedError('sqlite-foreign-key-check-failed')
    }
    const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (!Number.isSafeInteger(userVersion) || userVersion < 0) throw codedError('sqlite-user-version-invalid')
    if (expectedUserVersion !== undefined && userVersion !== expectedUserVersion) {
      throw codedError('sqlite-user-version-mismatch')
    }

    const afterVerify = await validateDataPath({
      dataRoot: target.dataRoot,
      targetPath: target.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(opened.identity, afterVerify.identity)) throw codedError('sqlite-file-identity-changed')
    return { userVersion, integrityOk: true, foreignKeyOk: true }
  } catch (error) {
    if (known(error)) throw error
    throw codedError('sqlite-database-invalid')
  } finally {
    try { db?.close() } catch {}
    await opened?.handle.close().catch(() => {})
  }
}

export async function verifySqliteDatabase({ dataRoot, dbPath, expectedUserVersion } = {}) {
  if (expectedUserVersion !== undefined && (!Number.isSafeInteger(expectedUserVersion) || expectedUserVersion < 0)) {
    throw codedError('sqlite-user-version-invalid')
  }
  const target = await sqlitePath({ dataRoot, filePath: dbPath, code: 'sqlite-path-invalid', requireExists: true })
  return verifySqlitePath({ target, expectedUserVersion })
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

export async function createVerifiedSqliteBackup({
  dataRoot,
  sourcePath,
  backupPath,
  expectedUserVersion,
} = {}) {
  if (expectedUserVersion !== undefined && (!Number.isSafeInteger(expectedUserVersion) || expectedUserVersion < 0)) {
    throw codedError('sqlite-user-version-invalid')
  }
  const source = await sqlitePath({
    dataRoot,
    filePath: sourcePath,
    code: 'sqlite-backup-source-invalid',
    requireExists: true,
  })
  const destination = await sqlitePath({
    dataRoot,
    filePath: backupPath,
    code: 'sqlite-backup-destination-invalid',
    requireExists: false,
  })
  if (relative(source.path, destination.path) === '') throw codedError('sqlite-backup-path-conflict')
  if (destination.exists) throw codedError('sqlite-backup-destination-exists')

  const parent = dirname(destination.path)
  try {
    await ensureDataDirectory({ dataRoot: source.dataRoot, directoryPath: parent })
  } catch {
    throw codedError('sqlite-backup-destination-invalid')
  }
  const temporaryPath = join(parent, `.${basename(destination.path)}.${randomUUID()}.tmp`)
  let sourceFile
  let sourceDb
  let temporaryFile
  let temporaryIdentity
  let destinationPublished = false
  try {
    sourceFile = await openVerifiedDataFile({
      dataRoot: source.dataRoot,
      filePath: source.path,
      flags: 'r',
      expectedIdentity: source.identity,
    })
    sourceDb = new DatabaseSync(source.path, { readOnly: true })
    const sourceAfterOpen = await validateDataPath({
      dataRoot: source.dataRoot,
      targetPath: source.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(sourceFile.identity, sourceAfterOpen.identity)) {
      throw codedError('sqlite-backup-source-identity-changed')
    }

    sourceDb.prepare('VACUUM INTO ?').run(temporaryPath)
    sourceDb.close()
    sourceDb = undefined
    const sourceAfterVacuum = await validateDataPath({
      dataRoot: source.dataRoot,
      targetPath: source.path,
      requireExists: true,
      expectDirectory: false,
    })
    if (!sameFileIdentity(sourceFile.identity, sourceAfterVacuum.identity)) {
      throw codedError('sqlite-backup-source-identity-changed')
    }
    await sourceFile.handle.close()
    sourceFile = undefined

    temporaryFile = await openVerifiedDataFile({
      dataRoot: source.dataRoot,
      filePath: temporaryPath,
      flags: 'r+',
    })
    temporaryIdentity = temporaryFile.identity
    const temporaryTarget = await sqlitePath({
      dataRoot: source.dataRoot,
      filePath: temporaryPath,
      code: 'sqlite-backup-temporary-invalid',
      requireExists: true,
    })
    const verified = await verifySqlitePath({
      target: temporaryTarget,
      expectedUserVersion,
      expectedIdentity: temporaryIdentity,
    })
    await temporaryFile.handle.sync()
    await temporaryFile.handle.close()
    temporaryFile = undefined

    const beforePublish = await sqlitePath({
      dataRoot: source.dataRoot,
      filePath: destination.path,
      code: 'sqlite-backup-destination-invalid',
      requireExists: false,
    })
    if (beforePublish.exists) throw codedError('sqlite-backup-destination-exists')
    try {
      await link(temporaryPath, destination.path)
    } catch (error) {
      if (error?.code === 'EEXIST') throw codedError('sqlite-backup-destination-exists')
      throw codedError('sqlite-backup-publish-failed')
    }
    destinationPublished = true
    await syncPublishedDataFile({
      dataRoot: source.dataRoot,
      filePath: destination.path,
      expectedIdentity: temporaryIdentity,
    })
    const published = await sqlitePath({
      dataRoot: source.dataRoot,
      filePath: destination.path,
      code: 'sqlite-backup-published-invalid',
      requireExists: true,
    })
    if (!sameFileIdentity(published.identity, temporaryIdentity)) {
      throw codedError('sqlite-backup-published-identity-changed')
    }
    await removeMatchingFile({
      dataRoot: source.dataRoot,
      filePath: temporaryPath,
      expectedIdentity: temporaryIdentity,
    })
    await syncDirectory({ dataRoot: source.dataRoot, directoryPath: parent })
    return { path: destination.path, ...verified }
  } catch (error) {
    try { sourceDb?.close() } catch {}
    await sourceFile?.handle.close().catch(() => {})
    await temporaryFile?.handle.close().catch(() => {})
    if (destinationPublished && temporaryIdentity) {
      await removeMatchingFile({
        dataRoot: source.dataRoot,
        filePath: destination.path,
        expectedIdentity: temporaryIdentity,
      })
    }
    if (temporaryIdentity) {
      await removeMatchingFile({
        dataRoot: source.dataRoot,
        filePath: temporaryPath,
        expectedIdentity: temporaryIdentity,
      })
    } else {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
    if (known(error)) throw error
    throw codedError('sqlite-backup-failed')
  }
}
