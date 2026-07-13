import { createHash } from 'node:crypto'

function providerId(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

export function crownIdentity(ids = {}) {
  const providerIds = {
    gid: providerId(ids.gid),
    gidm: providerId(ids.gidm),
    hgid: providerId(ids.hgid),
    ecid: providerId(ids.ecid),
    lid: providerId(ids.lid),
    eventId: providerId(ids.eventId),
  }

  return {
    eventKey: providerIds.gid ? `crown|football|gid=${providerIds.gid}` : null,
    matchGroupKey: providerIds.gidm
      ? `crown|football|gidm=${providerIds.gidm}|lid=${providerIds.lid || 'missing'}`
      : null,
    confidence: providerIds.gid ? 'high' : 'low',
    providerIds,
  }
}

export function marketIdentity(record = {}) {
  const parts = [
    record.event?.eventKey,
    record.market?.period,
    record.market?.marketType,
    record.market?.lineKey,
  ].map((value) => String(value ?? '').trim())
  return parts.every(Boolean) ? parts.join('|') : null
}

export function selectionIdentity(record = {}) {
  const market = marketIdentity(record)
  const side = String(record.selection?.side ?? '').trim()
  return market && side ? `${market}|${side}` : null
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    )
  }
  if (typeof value === 'string') return value.trim()
  return value ?? null
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

function requestObject(request) {
  if (request instanceof URLSearchParams) return Object.fromEntries(request)
  return request && typeof request === 'object' ? request : {}
}

function requestValue(request, ...keys) {
  for (const key of keys) {
    if (request[key] !== undefined && request[key] !== null) return request[key]
  }
  return ''
}

function normalizedText(value, { lower = false } = {}) {
  const text = String(value ?? '').trim()
  return lower ? text.toLowerCase() : text
}

export function snapshotScopeKey({ endpointKind, request = {} } = {}) {
  const input = requestObject(request)
  const scope = {
    provider: 'crown',
    sport: 'football',
    endpointKind: normalizedText(endpointKind, { lower: true }),
    listType: normalizedText(requestValue(input, 'listType', 'list_type', 'listtype'), { lower: true }),
    showtype: normalizedText(requestValue(input, 'showtype', 'showType'), { lower: true }),
    date: normalizedText(requestValue(input, 'date', 'gameDate', 'game_date')),
    rtype: normalizedText(requestValue(input, 'rtype', 'rType'), { lower: true }),
    gtype: normalizedText(requestValue(input, 'gtype', 'gType', 'GTYPE'), { lower: true }),
    ltype: normalizedText(requestValue(input, 'ltype', 'lType', 'LTYPE'), { lower: true }),
    isRB: normalizedText(requestValue(input, 'isRB', 'is_rb', 'isrb', 'IS_RB'), { lower: true }),
    filter: stableValue(requestValue(input, 'filter', 'filters')),
  }

  if (scope.endpointKind !== 'get_game_list') {
    scope.gid = normalizedText(requestValue(input, 'gid', 'GID'))
  }

  return stableStringify(scope)
}

function validResponse(classification = {}) {
  return classification.hasServerResponse === true &&
    classification.parseError !== true &&
    classification.loginExpired !== true
}

function hasExplicitValue(input, ...keys) {
  return keys.some((key) => Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined)
}

function listScopeKnown(request) {
  const input = requestObject(request)
  const showtype = normalizedText(requestValue(input, 'showtype', 'showType'))
  const rtype = normalizedText(requestValue(input, 'rtype', 'rType'))
  return Boolean(showtype && rtype && hasExplicitValue(input, 'filter', 'filters'))
}

function validListResponse(classification, eventRefs) {
  if (!validResponse(classification)) return false
  const expectedEventRefCount = Number.isInteger(classification.eligibleGameCount)
    ? classification.eligibleGameCount
    : classification.gameCount
  if (!Number.isInteger(expectedEventRefCount) || expectedEventRefCount <= 0) return false
  if (expectedEventRefCount !== eventRefs.length) return false
  return eventRefs.every((ref) => typeof ref?.eventKey === 'string' && ref.eventKey.length > 0)
}

function validDetailResponse(classification) {
  if (!validResponse(classification)) return false
  const invalidEventRefCount = classification.invalidEventRefCount ?? 0
  return Number.isInteger(invalidEventRefCount) && invalidEventRefCount === 0
}

function sortedIdentities(records, eventRefs) {
  const eventKeys = new Set()
  for (const ref of eventRefs) {
    if (ref?.eventKey) eventKeys.add(ref.eventKey)
  }
  for (const record of records) {
    if (record?.event?.eventKey) eventKeys.add(record.event.eventKey)
  }

  return {
    eventKeys: [...eventKeys].sort(),
    selectionIdentities: records.map(selectionIdentity).sort(),
    recordFacts: records.map((record) => stableStringify(record)).sort(),
  }
}

export function buildSnapshotBatch({
  endpointKind = '',
  classification = {},
  records = [],
  eventRefs = [],
  capturedAt = '',
  request = {},
  pollId = null,
} = {}) {
  const normalizedEndpointKind = normalizedText(endpointKind, { lower: true })
  const normalizedPollId = normalizedText(pollId)
  const supportedEndpoint = normalizedEndpointKind === 'get_game_list' || normalizedEndpointKind === 'get_game_more'
  const validRecordIdentities = Array.isArray(records) && records.every((record) => selectionIdentity(record) !== null)
  const scopeKnown = normalizedEndpointKind !== 'get_game_list' || listScopeKnown(request)
  const complete = Boolean(normalizedPollId) && supportedEndpoint && validRecordIdentities && scopeKnown && (
    normalizedEndpointKind === 'get_game_list'
      ? validListResponse(classification, eventRefs)
      : validDetailResponse(classification)
  )
  const completeness = normalizedEndpointKind === 'get_game_list' && complete ? 'authoritative' : 'partial'
  const scopeKey = snapshotScopeKey({ endpointKind: normalizedEndpointKind, request })
  const identities = sortedIdentities(records, eventRefs)
  const batchId = createHash('sha256').update(stableStringify({
    provider: 'crown',
    endpointKind: normalizedEndpointKind,
    scopeKey,
    capturedAt,
    ...identities,
  })).digest('hex')

  return {
    schemaVersion: 2,
    batchId,
    pollId: normalizedPollId,
    capturedAt,
    provider: 'crown',
    sport: 'football',
    endpointKind: normalizedEndpointKind,
    scopeKey,
    completeness,
    complete,
    classification,
    eventRefs,
    oddsRecords: records,
  }
}
