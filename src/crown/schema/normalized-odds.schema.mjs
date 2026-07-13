const REQUIRED_STRING_PATHS = [
  ['provider'],
  ['sport'],
  ['mode'],
  ['capturedAt'],
  ['source', 'endpointKey'],
  ['source', 'mapperVersion'],
  ['event', 'eventId'],
  ['event', 'eventKey'],
  ['event', 'league'],
  ['event', 'homeTeam'],
  ['event', 'status'],
  ['market', 'marketId'],
  ['market', 'marketKey'],
  ['market', 'marketType'],
  ['market', 'period'],
  ['market', 'idScope'],
  ['selection', 'selectionId'],
  ['selection', 'selectionKey'],
  ['selection', 'idScope'],
  ['selection', 'side'],
  ['selection', 'oddsRaw'],
  ['selection', 'oddsFormat'],
]

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value)
}

export function validateNormalizedOddsRecord(record) {
  const errors = []

  for (const path of REQUIRED_STRING_PATHS) {
    const value = getPath(record, path)
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`missing-string:${path.join('.')}`)
    }
  }

  if (record?.provider !== 'crown') errors.push('provider-must-be-crown')
  if (record?.sport !== 'football') errors.push('sport-must-be-football')
  if (!['prematch', 'live', 'odds-refresh', 'unknown'].includes(record?.mode)) errors.push('invalid-mode')
  if (!['not_started', 'live', 'suspended', 'unknown'].includes(record?.event?.status)) errors.push('invalid-status')
  if (!['asian_handicap', 'total', 'moneyline', 'odd_even', 'yes_no', 'other', 'unknown'].includes(record?.market?.marketType)) errors.push('invalid-market-type')
  if (!['home', 'away', 'over', 'under', 'draw', 'odd', 'even', 'yes', 'no', 'other', 'unknown'].includes(record?.selection?.side)) errors.push('invalid-side')
  if (!['local', 'provider', 'unknown'].includes(record?.market?.idScope)) errors.push('invalid-market-id-scope')
  if (!['local', 'provider', 'unknown'].includes(record?.selection?.idScope)) errors.push('invalid-selection-id-scope')
  if (typeof record?.selection?.odds !== 'number' && record?.selection?.odds !== null) errors.push('invalid-odds')
  if (typeof record?.selection?.suspended !== 'boolean') errors.push('invalid-suspended')
  if (!Array.isArray(record?.warnings)) errors.push('warnings-must-be-array')

  return errors
}
