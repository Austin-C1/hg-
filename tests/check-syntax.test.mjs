import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findMjsFiles } from '../scripts/check-syntax.mjs'

test('finds project mjs files while skipping generated and dependency directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-syntax-'))
  for (const dir of ['scripts', 'src/crown', 'tests', 'data', 'docs', 'node_modules/pkg']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }

  fs.writeFileSync(path.join(root, 'scripts', 'ok.mjs'), 'export const ok = true\n')
  fs.writeFileSync(path.join(root, 'src', 'crown', 'ok.mjs'), 'export const ok = true\n')
  fs.writeFileSync(path.join(root, 'tests', 'ok.test.mjs'), 'export const ok = true\n')
  fs.writeFileSync(path.join(root, 'data', 'skip.mjs'), 'bad')
  fs.writeFileSync(path.join(root, 'docs', 'skip.mjs'), 'bad')
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'skip.mjs'), 'bad')

  const found = findMjsFiles(root).map((file) => path.relative(root, file).replace(/\\/g, '/')).sort()

  assert.deepEqual(found, [
    'scripts/ok.mjs',
    'src/crown/ok.mjs',
    'tests/ok.test.mjs',
  ])
})
