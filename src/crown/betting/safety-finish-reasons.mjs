export const SAFETY_FINISH_REASONS = new Set([
  'manual_cancel',
  'global_stop',
  'real_betting_stopped',
  'authorization_revoked',
  'authorization_expired',
  'market_changed',
  'identity_changed',
  'stage_changed',
  'signal_expired',
  'expired',
  'signal_invalid',
])

export function isSafetyFinishReason(value) {
  return SAFETY_FINISH_REASONS.has(String(value || ''))
}
