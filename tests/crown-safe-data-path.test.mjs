import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openVerifiedDataFile,
  validateDataPath,
} from '../src/crown/runtime/safe-data-path.mjs'

test('safe data paths require explicit fully-qualified containment', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-safe-data-path-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outside = join(sandbox, 'outside')
  await mkdir(dataRoot)
  await mkdir(outside)

  assert.equal(
    (await validateDataPath({ dataRoot, targetPath: join(dataRoot, 'updates', 'journal.json') })).path,
    join(dataRoot, 'updates', 'journal.json'),
  )
  await assert.rejects(validateDataPath({ targetPath: join(dataRoot, 'value.json') }), /safe-data-path-root-invalid/)
  await assert.rejects(validateDataPath({ dataRoot: '.', targetPath: join(dataRoot, 'value.json') }), /safe-data-path-root-invalid/)
  await assert.rejects(validateDataPath({ dataRoot, targetPath: 'value.json' }), /safe-data-path-target-invalid/)
  await assert.rejects(validateDataPath({ dataRoot, targetPath: join(outside, 'value.json') }), /safe-data-path-outside-root/)
  if (process.platform === 'win32') {
    await assert.rejects(validateDataPath({ dataRoot, targetPath: '\\updates\\journal.json' }), /safe-data-path-target-invalid/)
  }
})

test('safe data paths reject each symlink or junction segment and bind reads to lstat identity', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'crown-safe-data-path-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const dataRoot = join(sandbox, 'data')
  const outside = join(sandbox, 'outside')
  await mkdir(dataRoot)
  await mkdir(outside)
  await writeFile(join(outside, 'outside.json'), '{}')
  const redirect = join(dataRoot, 'redirect')
  await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(
    validateDataPath({ dataRoot, targetPath: join(redirect, 'outside.json'), requireExists: true }),
    /safe-data-path-reparse-point/,
  )

  const firstPath = join(dataRoot, 'first.json')
  const secondPath = join(dataRoot, 'second.json')
  await writeFile(firstPath, '{}')
  await writeFile(secondPath, '{}')
  const first = await openVerifiedDataFile({ dataRoot, filePath: firstPath, flags: 'r' })
  try {
    await assert.rejects(
      openVerifiedDataFile({ dataRoot, filePath: secondPath, flags: 'r', expectedIdentity: first.identity }),
      /safe-data-path-identity-mismatch/,
    )
  } finally {
    await first.handle.close()
  }
})
