import assert from 'node:assert/strict'
import test from 'node:test'

import { extractFootballDomSnapshot } from '../src/crown/dom-football-extractor.mjs'

test('DOM snapshot extraction retries when navigation destroys the evaluate context', async () => {
  let calls = 0
  const page = {
    async evaluate(extractor) {
      assert.equal(typeof extractor, 'function')
      calls += 1
      if (calls === 1) {
        throw new Error('Execution context was destroyed, most likely because of a navigation')
      }
      return {
        capturedAt: '2026-07-08T00:00:00.000Z',
        url: 'https://m321.mos077.com/',
        title: 'Welcome',
        eventCards: [],
      }
    },
  }

  const dom = await extractFootballDomSnapshot(page, { retries: 1, retryDelayMs: 0 })

  assert.equal(calls, 2)
  assert.equal(dom.url, 'https://m321.mos077.com/')
})
