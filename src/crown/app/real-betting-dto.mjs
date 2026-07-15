export const REAL_BETTING_REASON_CODES = new Set([
  'watcher-not-fresh', 'watcher-lease-not-unique', 'monitor-login-not-fresh',
  'betting-rule-card-not-enabled', 'betting-account-unavailable',
  'capability-evidence-not-exact', 'authorization-not-active', 'schema-not-current',
  'environment-not-exact', 'fence-not-fresh', 'executor-lease-not-fresh',
  'reconciler-lease-not-fresh', 'executor-reconciler-lease-not-distinct',
  'preflight-required', 'stop-requested', 'worker-exited', 'collector-failed',
])

const STATES = new Set(['off', 'armed_waiting', 'running', 'blocked', 'stopping'])

function safeTimestamp(value) {
  if (typeof value !== 'string' || !value) return ''
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

export function realBettingStatusCoreDto(value = {}) {
  return {
    requested: value.requested === true,
    state: STATES.has(value.state) ? value.state : 'blocked',
    reasonCode: REAL_BETTING_REASON_CODES.has(value.reasonCode) ? value.reasonCode : '',
    updatedAt: safeTimestamp(value.updatedAt),
  }
}

export function realBettingDto(value = {}) {
  const preflight = Array.isArray(value.preflight) ? value.preflight
    .filter((item) => REAL_BETTING_REASON_CODES.has(item?.code))
    .slice(0, 13)
    .map((item) => ({ code: item.code, ready: item.ready === true })) : []
  const blockingReasons = Array.isArray(value.blockingReasons) ? value.blockingReasons
    .filter((code) => REAL_BETTING_REASON_CODES.has(code)).slice(0, 13) : []
  return { ...realBettingStatusCoreDto(value), preflight, blockingReasons }
}

const BROWSER_SESSION_STATES = new Set([
  'stopped', 'starting', 'login_required', 'ready', 'stale', 'blocked', 'error',
])
const ACCEPTANCE_STATES = new Set(['pending', 'previewing', 'dispatched', 'accepted', 'rejected', 'unknown'])
const CAMPAIGN_STATES = new Set(['active', 'completed', 'failed'])

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  const canonical = new Date(value).toISOString()
  return canonical === value ? canonical : null
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function browserBettingDto(value = {}) {
  const sessions = Array.isArray(value.sessions) ? value.sessions.slice(0, 100).map((item) => ({
    accountId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(item?.accountId || ''))
      ? String(item.accountId)
      : '',
    state: BROWSER_SESSION_STATES.has(item?.state) ? item.state : 'stopped',
    lastHeartbeatAt: nullableTimestamp(item?.lastHeartbeatAt),
    sessionGeneration: safeCount(item?.sessionGeneration),
    lastApiSuccessAt: nullableTimestamp(item?.lastApiSuccessAt),
  })).filter((item) => item.accountId) : []

  const directions = Array.isArray(value.directions) ? value.directions.slice(0, 8).map((item) => ({
    key: typeof item?.key === 'string' && item.key.length <= 128 ? item.key : '',
    previewAllowed: item?.previewAllowed === true,
    submitAllowed: item?.submitAllowed === true,
    reconciliationAllowed: item?.reconciliationAllowed === true,
    blockedReason: typeof item?.blockedReason === 'string' && /^[a-z0-9-]*$/.test(item.blockedReason)
      ? item.blockedReason
      : '',
    acceptanceState: ACCEPTANCE_STATES.has(item?.acceptanceState) ? item.acceptanceState : null,
  })).filter((item) => item.key) : []

  const sourceCampaign = value.campaign
  const campaign = sourceCampaign && typeof sourceCampaign === 'object' && !Array.isArray(sourceCampaign)
    && /^[a-f0-9]{64}$/.test(String(sourceCampaign.campaignId || ''))
    ? {
        campaignId: String(sourceCampaign.campaignId),
        state: CAMPAIGN_STATES.has(sourceCampaign.state) ? sourceCampaign.state : 'failed',
        acceptedCount: safeCount(sourceCampaign.acceptedCount),
        targetCount: safeCount(sourceCampaign.targetCount),
        unknownCount: safeCount(sourceCampaign.unknownCount),
        totalAcceptedAmountMinor: safeCount(sourceCampaign.totalAcceptedAmountMinor),
        queueDepth: safeCount(sourceCampaign.queueDepth),
        inFlightCount: safeCount(sourceCampaign.inFlightCount),
      }
    : null

  return {
    transportKind: 'browser-page-fetch',
    protocolLibraryVersion: typeof value.protocolLibraryVersion === 'string'
      && /^crown-protocol-capabilities-v2:[a-f0-9]{16}$/.test(value.protocolLibraryVersion)
      ? value.protocolLibraryVersion
      : '',
    sessions,
    directions,
    campaign,
  }
}
