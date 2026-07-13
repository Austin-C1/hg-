import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadProjectEnv } from '../src/crown/app/env-file.mjs'

test('loads project .env values without overriding existing environment values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-env-'))
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      '# local Crown settings',
      'CROWN_SECRET_KEY=from-dotenv',
      'CROWN_DASHBOARD_PORT=9999',
      'QUOTED_VALUE="hello world"',
      "SINGLE_QUOTED='x y'",
      'EMPTY_VALUE=',
      'INVALID_LINE',
    ].join('\n'),
    'utf8',
  )

  const env = { CROWN_DASHBOARD_PORT: '8788' }
  const result = loadProjectEnv({ cwd: dir, env })

  assert.equal(result.loaded, true)
  assert.equal(env.CROWN_SECRET_KEY, 'from-dotenv')
  assert.equal(env.CROWN_DASHBOARD_PORT, '8788')
  assert.equal(env.QUOTED_VALUE, 'hello world')
  assert.equal(env.SINGLE_QUOTED, 'x y')
  assert.equal(env.EMPTY_VALUE, '')
})

test('ignores missing project .env files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-env-missing-'))
  const env = {}

  const result = loadProjectEnv({ cwd: dir, env })

  assert.equal(result.loaded, false)
  assert.deepEqual(env, {})
})
