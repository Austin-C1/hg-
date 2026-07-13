import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseArgs, runDomPollOnce } from '../scripts/crown-watch.mjs'

test('watcher parses --login-test short-run mode', () => {
  const args = parseArgs(['--login-test', '--max-seconds', '3'])

  assert.equal(args.loginTest, true)
  assert.equal(args.maxSeconds, 3)
})

test('DOM poll skips a closed page without writing repeated page-closed errors', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watch-closed-page-'))
  const stats = await runDomPollOnce({
    page: {
      isClosed() {
        return true
      },
      url() {
        return 'https://example.test'
      },
    },
    runtimeDir,
  })

  const log = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'crown-watch-runtime.jsonl'), 'utf8').trim())
  assert.equal(stats.errors, 0)
  assert.equal(log.type, 'dom-poll-skipped')
  assert.equal(log.reason, 'page-closed')
})
