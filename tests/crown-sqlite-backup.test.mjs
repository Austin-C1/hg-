import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createVerifiedSqliteBackup, verifySqliteDatabase } from '../src/crown/update/sqlite-backup.mjs'

test('SQLite backup captures committed WAL rows and publishes one verified database atomically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-sqlite-backup-'))
  const sourcePath = join(root, 'source.sqlite')
  const backupPath = join(root, 'backups', 'backup.sqlite')
  const writer = new DatabaseSync(sourcePath)
  t.after(async () => {
    writer.close()
    await rm(root, { recursive: true, force: true })
  })
  writer.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=7;
    CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    INSERT INTO parent VALUES(1, 'from-wal');
    INSERT INTO child VALUES(1, 1);
  `)
  assert.ok((await stat(`${sourcePath}-wal`)).size > 0)

  const result = await createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath, expectedUserVersion: 7 })

  assert.deepEqual(result, { path: backupPath, userVersion: 7, integrityOk: true, foreignKeyOk: true })
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  assert.equal(backup.prepare('SELECT name FROM parent WHERE id=1').get().name, 'from-wal')
  assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM child').get().count, 1)
  backup.close()
  assert.deepEqual(await readdir(join(root, 'backups')), ['backup.sqlite'])
})

test('SQLite verification runs integrity_check, foreign_key_check, and user_version checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-sqlite-verify-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const validPath = join(root, 'valid.sqlite')
  const valid = new DatabaseSync(validPath)
  valid.exec('PRAGMA user_version=3; CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1)')
  valid.close()
  assert.deepEqual(await verifySqliteDatabase({ dataRoot: root, dbPath: validPath, expectedUserVersion: 3 }), {
    userVersion: 3, integrityOk: true, foreignKeyOk: true,
  })
  await assert.rejects(verifySqliteDatabase({ dataRoot: root, dbPath: validPath, expectedUserVersion: 4 }), /sqlite-user-version-mismatch/)

  const foreignPath = join(root, 'foreign.sqlite')
  const foreign = new DatabaseSync(foreignPath)
  foreign.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE p(id INTEGER PRIMARY KEY);
    CREATE TABLE c(id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id));
    INSERT INTO c VALUES(1, 99);
  `)
  foreign.close()
  await assert.rejects(verifySqliteDatabase({ dataRoot: root, dbPath: foreignPath }), /sqlite-foreign-key-check-failed/)
})

test('backup verification failure removes temporary output and never replaces a destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-sqlite-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'invalid.sqlite')
  const source = new DatabaseSync(sourcePath)
  source.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE p(id INTEGER PRIMARY KEY);
    CREATE TABLE c(id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id));
    INSERT INTO c VALUES(1, 99);
  `)
  source.close()
  const backupPath = join(root, 'backup.sqlite')

  await assert.rejects(createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath }), /sqlite-foreign-key-check-failed/)
  assert.deepEqual((await readdir(root)).sort(), ['invalid.sqlite'])

  await writeFile(sourcePath, Buffer.from('not a sqlite database'))
  await assert.rejects(createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath }), /sqlite-backup-failed|sqlite-database-invalid/)
  assert.deepEqual((await readdir(root)).sort(), ['invalid.sqlite'])

  await writeFile(backupPath, 'existing')
  await assert.rejects(createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath }), /sqlite-backup-destination-exists/)
  assert.equal(await readFile(backupPath, 'utf8'), 'existing')
})

test('backup publish is same-volume no-clobber when two writers race for one destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-sqlite-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'source.sqlite')
  const backupPath = join(root, 'backup.sqlite')
  const source = new DatabaseSync(sourcePath)
  source.exec('PRAGMA user_version=9; CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1)')
  source.close()

  const results = await Promise.allSettled([
    createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath, expectedUserVersion: 9 }),
    createVerifiedSqliteBackup({ dataRoot: root, sourcePath, backupPath, expectedUserVersion: 9 }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected?.reason?.message, 'sqlite-backup-destination-exists')
  assert.deepEqual(await verifySqliteDatabase({ dataRoot: root, dbPath: backupPath, expectedUserVersion: 9 }), {
    userVersion: 9, integrityOk: true, foreignKeyOk: true,
  })
  assert.deepEqual((await readdir(root)).sort(), ['backup.sqlite', 'source.sqlite'])
})

test('SQLite APIs require contained data paths, reject reparse traversal, and reject source equals destination', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-sqlite-path-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outside = join(sandbox, 'outside')
  await mkdir(dataRoot)
  await mkdir(outside)
  const outsideDb = join(outside, 'outside.sqlite')
  const db = new DatabaseSync(outsideDb)
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)')
  db.close()

  await assert.rejects(verifySqliteDatabase({ dbPath: outsideDb }), /sqlite-data-root-invalid/)
  await assert.rejects(verifySqliteDatabase({ dataRoot, dbPath: outsideDb }), /sqlite-path-invalid/)
  await assert.rejects(
    createVerifiedSqliteBackup({ dataRoot, sourcePath: outsideDb, backupPath: join(dataRoot, 'backup.sqlite') }),
    /sqlite-backup-source-invalid/,
  )

  const redirect = join(dataRoot, 'redirect')
  await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(
    createVerifiedSqliteBackup({ dataRoot, sourcePath: join(redirect, 'outside.sqlite'), backupPath: join(dataRoot, 'backup.sqlite') }),
    /sqlite-backup-source-invalid/,
  )

  const insideDb = join(dataRoot, 'inside.sqlite')
  const inside = new DatabaseSync(insideDb)
  inside.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)')
  inside.close()
  await assert.rejects(
    createVerifiedSqliteBackup({ dataRoot, sourcePath: insideDb, backupPath: insideDb }),
    /sqlite-backup-path-conflict/,
  )
})
