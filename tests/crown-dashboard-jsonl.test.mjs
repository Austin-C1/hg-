import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readJsonlFile, readJsonlFileFiltered } from '../src/crown/dashboard/jsonl-reader.mjs'

test('missing JSONL file returns unavailable metadata without records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-jsonl-'))
  const result = await readJsonlFile(path.join(dir, 'missing.jsonl'))

  assert.equal(result.exists, false)
  assert.equal(result.lineCount, 0)
  assert.equal(result.parseErrors, 0)
  assert.equal(result.updatedAt, null)
  assert.deepEqual(result.records, [])
})

test('reads valid lines while ignoring blanks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-jsonl-'))
  const file = path.join(dir, 'records.jsonl')
  fs.writeFileSync(file, '\n{"id":1}\r\n  \n{"id":2}\n', 'utf8')

  const result = await readJsonlFile(file)

  assert.equal(result.exists, true)
  assert.equal(result.lineCount, 2)
  assert.equal(result.parseErrors, 0)
  assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(result.records, [{ id: 1 }, { id: 2 }])
})

test('counts malformed lines and continues parsing valid records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-jsonl-'))
  const file = path.join(dir, 'mixed.jsonl')
  fs.writeFileSync(file, '{"ok":true}\nnot-json\n{"ok":false}\n', 'utf8')

  const result = await readJsonlFile(file)

  assert.equal(result.lineCount, 3)
  assert.equal(result.parseErrors, 1)
  assert.deepEqual(result.records, [{ ok: true }, { ok: false }])
})

test('can read only recent JSONL lines for large runtime files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-jsonl-'))
  const file = path.join(dir, 'large.jsonl')
  fs.writeFileSync(file, Array.from({ length: 6 }, (_, index) => JSON.stringify({ id: index + 1 })).join('\n') + '\n', 'utf8')

  const result = await readJsonlFile(file, { maxLines: 2 })

  assert.equal(result.exists, true)
  assert.equal(result.truncated, true)
  assert.equal(result.lineCount, 2)
  assert.deepEqual(result.records, [{ id: 5 }, { id: 6 }])
})

test('can stream-filter JSONL while keeping the latest matching records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-dashboard-jsonl-'))
  const file = path.join(dir, 'changes.jsonl')
  fs.writeFileSync(file, [
    JSON.stringify({ id: 1, event: { eventKey: 'target' } }),
    JSON.stringify({ id: 2, event: { eventKey: 'other' } }),
    JSON.stringify({ id: 3, event: { eventKey: 'target' } }),
    'not-json',
    JSON.stringify({ id: 4, event: { eventKey: 'target' } }),
  ].join('\n') + '\n', 'utf8')

  const result = await readJsonlFileFiltered(file, {
    limit: 2,
    predicate: (record) => record?.event?.eventKey === 'target',
  })

  assert.equal(result.exists, true)
  assert.equal(result.lineCount, 5)
  assert.equal(result.parseErrors, 1)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.records, [
    { id: 3, event: { eventKey: 'target' } },
    { id: 4, event: { eventKey: 'target' } },
  ])
})
