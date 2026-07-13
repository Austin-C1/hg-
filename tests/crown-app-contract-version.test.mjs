import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { handleAppApi } from '../src/crown/app/app-api.mjs'
import { openAppDatabase } from '../src/crown/app/app-db.mjs'

const EXPECTED_CONTRACT = 'dynamic-betting-cards-v1'

async function securityContext(dbPath) {
  const req = Readable.from([])
  req.method = 'GET'
  const res = {
    statusCode: 0,
    text: '',
    writeHead(statusCode) { this.statusCode = statusCode },
    end(text) { this.text = text },
  }
  await handleAppApi(req, res, new URL('/api/app/security-context', 'http://127.0.0.1'), {
    dbPath,
    csrfToken: 'test-csrf',
    dashboardAccessMode: 'local-trust',
  })
  return { statusCode: res.statusCode, payload: JSON.parse(res.text) }
}

test('security context exposes matching app and schema contracts', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-contract-')), 'app.sqlite')
  openAppDatabase({ dbPath }).close()
  const response = await securityContext(dbPath)

  assert.equal(response.statusCode, 200)
  assert.equal(response.payload.appContractVersion, EXPECTED_CONTRACT)
  assert.equal(response.payload.schemaVersion, EXPECTED_CONTRACT)
})

test('production code has one app contract version literal source', () => {
  const roots = ['src', 'frontend/src']
  const hits = []
  const visit = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (!entry.name.includes('.test.') && /\.(?:mjs|ts|tsx)$/.test(entry.name) && fs.readFileSync(child, 'utf8').includes(EXPECTED_CONTRACT)) hits.push(child.replaceAll('\\', '/'))
    }
  }
  roots.forEach(visit)
  assert.deepEqual(hits, ['src/crown/app/app-contract-version.mjs'])
})

test('Docker frontend-build copies the single contract source before Vite build', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
  const copyAt = dockerfile.indexOf('COPY src/crown/app/app-contract-version.mjs /app/src/crown/app/app-contract-version.mjs')
  const buildAt = dockerfile.indexOf('RUN npm run build')
  assert.ok(copyAt >= 0, 'Docker frontend-build must copy the shared app contract source')
  assert.ok(copyAt < buildAt, 'shared contract source must exist before Vite loads its config')
})

test('security context read is non-mutating and works while a writer lock exists', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-contract-readonly-')), 'app.sqlite')
  openAppDatabase({ dbPath }).close()
  const before = fs.statSync(dbPath)
  const inspect = new DatabaseSync(dbPath, { readOnly: true })
  const tablesBefore = inspect.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all()
  inspect.close()

  const writer = new DatabaseSync(dbPath)
  writer.exec('BEGIN IMMEDIATE')
  try {
    const response = await securityContext(dbPath)
    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.schemaVersion, EXPECTED_CONTRACT)
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }

  const after = fs.statSync(dbPath)
  const verify = new DatabaseSync(dbPath, { readOnly: true })
  const tablesAfter = verify.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all()
  verify.close()
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.size, before.size)
  assert.deepEqual(tablesAfter, tablesBefore)
})

test('missing, incomplete, and corrupt databases return null schema without mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-contract-missing-'))
  const missingPath = path.join(dir, 'missing.sqlite')
  const missing = await securityContext(missingPath)
  assert.equal(missing.statusCode, 200)
  assert.equal(missing.payload.schemaVersion, null)
  assert.equal(fs.existsSync(missingPath), false)

  const incompletePath = path.join(dir, 'incomplete.sqlite')
  const incompleteDb = new DatabaseSync(incompletePath)
  incompleteDb.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
  incompleteDb.close()
  const incompleteBefore = fs.statSync(incompletePath)
  const incomplete = await securityContext(incompletePath)
  assert.equal(incomplete.payload.schemaVersion, null)
  assert.equal(fs.statSync(incompletePath).mtimeMs, incompleteBefore.mtimeMs)
  const verify = new DatabaseSync(incompletePath, { readOnly: true })
  assert.deepEqual(verify.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((row) => ({ ...row })), [{ name: 'unrelated' }])
  verify.close()

  const corruptPath = path.join(dir, 'corrupt.sqlite')
  fs.writeFileSync(corruptPath, 'not a sqlite database', 'utf8')
  const corruptBefore = fs.readFileSync(corruptPath)
  const corrupt = await securityContext(corruptPath)
  assert.equal(corrupt.payload.schemaVersion, null)
  assert.deepEqual(fs.readFileSync(corruptPath), corruptBefore)
})
