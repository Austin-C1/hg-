import type { BrowserBettingSummary } from '../types'

export const browserBettingSummary: BrowserBettingSummary = {
  transportKind: 'browser-page-fetch',
  protocolLibraryVersion: 'crown-protocol-capabilities-v2:test-safe',
  sessions: [{
    accountId: 'bet_1', state: 'stale', lastHeartbeatAt: '2026-07-15T01:00:00.000Z',
    sessionGeneration: 12, lastApiSuccessAt: '2026-07-15T00:59:58.000Z',
  }],
  directions: [
    ['prematch|full_time|asian_handicap|main|home', false, 'pending'],
    ['prematch|full_time|asian_handicap|main|away', true, 'accepted'],
    ['prematch|full_time|total|main|over', false, 'previewing'],
    ['prematch|full_time|total|main|under', false, 'dispatched'],
    ['live|full_time|asian_handicap|main|home', false, 'rejected'],
    ['live|full_time|asian_handicap|main|away', false, 'unknown'],
    ['live|full_time|total|main|over', false, null],
    ['live|full_time|total|main|under', false, null],
  ].map(([key, submitAllowed, acceptanceState]) => ({
    key: String(key), previewAllowed: true, submitAllowed: Boolean(submitAllowed), reconciliationAllowed: false,
    blockedReason: submitAllowed ? 'crown-reconciliation-evidence-missing' : 'crown-submit-direct-acceptance-missing',
    acceptanceState: acceptanceState as BrowserBettingSummary['directions'][number]['acceptanceState'],
  })),
  campaign: {
    campaignId: 'a'.repeat(64), state: 'failed', acceptedCount: 1, targetCount: 8, unknownCount: 1,
    totalAcceptedAmountMinor: 50, queueDepth: 2, inFlightCount: 1,
  },
}
