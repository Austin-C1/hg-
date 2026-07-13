import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { claimMarketOnce } from '../src/crown/betting/market-once-store.mjs'

test('mode-scoped claim does not require a legacy rule and duplicate is stable', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const claim = {
      marketOnceKey: 'market_once_mode_scoped', signalId: 'signal-a',
      marketType: 'asian_handicap', actualSide: 'away',
      bettingMode: 'prematch', settingsVersion: 7, createdAt: '2026-07-12T00:00:00.000Z',
    }
    assert.deepEqual(claimMarketOnce(handle.db, claim), {
      claimed: true, marketOnceKey: claim.marketOnceKey, ruleId: null, bettingMode: 'prematch', settingsVersion: 7,
    })
    assert.deepEqual(claimMarketOnce(handle.db, claim), {
      claimed: false, marketOnceKey: claim.marketOnceKey, ruleId: null, bettingMode: 'prematch', settingsVersion: 7,
    })
    assert.deepEqual({ ...handle.db.prepare('SELECT rule_id,betting_mode,settings_version,signal_id FROM bet_market_once_claims').get() }, {
      rule_id: null, betting_mode: 'prematch', settings_version: 7, signal_id: 'signal-a',
    })
  } finally { handle.close() }
})
