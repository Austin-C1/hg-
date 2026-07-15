const IDENTITY_KEYS = Object.freeze(['provider', 'gid', 'mode', 'period', 'market', 'lineVariant', 'line', 'side'])
const EXECUTION_MODES = new Set(['prematch', 'live'])
const EXECUTION_MARKET_SIDES = new Map([
  ['asian_handicap', new Set(['home', 'away'])],
  ['total', new Set(['over', 'under'])],
])

function text(value, code) {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(code)
  return result
}

function gidFromEventKey(value) {
  const match = /^crown\|football\|gid=([^|\s]+)$/.exec(String(value || ''))
  return match?.[1] || ''
}

function candidateText(value, code) {
  try {
    return text(value, code)
  } catch {
    throw new TypeError(code)
  }
}

export function executionCandidateFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('execution-candidate-snapshot-required')
  }
  const gid = candidateText(snapshot.event?.ids?.gid, 'execution-candidate-gid')
  const mode = candidateText(snapshot.mode, 'execution-candidate-mode')
  const eventMode = candidateText(snapshot.event?.mode, 'execution-candidate-event-mode')
  const period = candidateText(snapshot.market?.period, 'execution-candidate-period')
  const marketType = candidateText(snapshot.market?.marketType, 'execution-candidate-market')
  const lineVariant = candidateText(snapshot.market?.lineVariant, 'execution-candidate-line-variant')
  const selectionSide = candidateText(snapshot.selection?.side, 'execution-candidate-side')
  if (!EXECUTION_MODES.has(mode) || eventMode !== mode
    || period !== 'full_time' || lineVariant !== 'main'
    || !EXECUTION_MARKET_SIDES.get(marketType)?.has(selectionSide)) {
    throw new TypeError('execution-candidate-unsupported')
  }
  return Object.freeze({
    gid,
    mode,
    period,
    marketType,
    lineVariant,
    selectionSide,
    handicapRaw: candidateText(snapshot.market?.handicapRaw, 'execution-candidate-line'),
    oddsField: candidateText(snapshot.selection?.oddsField, 'execution-candidate-odds-field'),
    oddsRaw: candidateText(snapshot.selection?.oddsRaw, 'execution-candidate-odds'),
    observedAt: candidateText(snapshot.capturedAt, 'execution-candidate-observed-at'),
  })
}

export function assertLockedSelectionEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('locked-selection-required')
  const snapshot = value.snapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('locked-selection-snapshot-required')
  const eventKey = text(value.eventKey, 'locked-selection-event-required')
  const selectionIdentity = text(value.selectionIdentity, 'locked-selection-identity-required')
  const side = text(value.side, 'locked-selection-side-required')
  if (snapshot.event?.eventKey !== eventKey) throw new Error('locked-selection-event-mismatch')
  if (snapshot.selection?.selectionIdentity !== selectionIdentity) throw new Error('locked-selection-identity-mismatch')
  if (snapshot.selection?.side !== side) throw new Error('locked-selection-side-mismatch')
  if (String(value.period || '') !== String(snapshot.market?.period || '')) throw new Error('locked-selection-period-mismatch')
  if (String(value.marketType || '') !== String(snapshot.market?.marketType || '')) throw new Error('locked-selection-market-mismatch')
  if (String(value.lineKey || '') !== String(snapshot.market?.lineKey || '')) throw new Error('locked-selection-line-mismatch')
  return value
}

export function executionIdentityFromEnvelope(value, { provider } = {}) {
  const envelope = assertLockedSelectionEnvelope(value)
  const snapshot = envelope.snapshot
  const result = {
    provider: text(provider ?? snapshot.provider ?? envelope.provider, 'execution-identity-provider'),
    gid: text(snapshot.event?.ids?.gid || gidFromEventKey(envelope.eventKey), 'missing-crown-gid'),
    mode: text(snapshot.mode || snapshot.event?.mode || envelope.providerMode || envelope.mode, 'missing-crown-preview-mode'),
    period: text(snapshot.market?.period, 'missing-crown-preview-period'),
    market: text(snapshot.market?.marketType, 'missing-crown-preview-market'),
    lineVariant: text(snapshot.market?.lineVariant, 'missing-crown-line-variant'),
    line: text(snapshot.market?.handicapRaw, 'missing-crown-line'),
    side: text(snapshot.selection?.side, 'missing-crown-preview-side'),
  }
  return Object.freeze(result)
}

export function assertExecutionIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('execution-identity-required')
  if (Object.keys(value).sort().join('\0') !== [...IDENTITY_KEYS].sort().join('\0')) throw new Error('execution-identity-shape')
  return Object.freeze(Object.fromEntries(IDENTITY_KEYS.map((key) => [key, text(value[key], `execution-identity-${key}`)])))
}
