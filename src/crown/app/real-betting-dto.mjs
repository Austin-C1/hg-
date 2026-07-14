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
