function required(value, code) {
  if (value === undefined || value === null || value === '') throw new Error(code)
  return String(value)
}

function selectionCode(record) {
  const marketType = record.market?.marketType
  const side = record.selection?.side
  if (marketType === 'asian_handicap' && side === 'home') return { choseTeam: 'H', rtypeSuffix: 'H' }
  if (marketType === 'asian_handicap' && side === 'away') return { choseTeam: 'C', rtypeSuffix: 'C' }
  if (marketType === 'total' && side === 'over') return { choseTeam: 'H', rtypeSuffix: 'H' }
  if (marketType === 'total' && side === 'under') return { choseTeam: 'C', rtypeSuffix: 'C' }
  throw new Error('unsupported-crown-selection')
}

function allowedField(value, values) {
  return !value || values.includes(value)
}

function marketVariant(record, { ratioFields, oddsFields, wtype, rtypePrefix, f, isRB }) {
  const ratioField = record.market?.ratioField || ''
  const oddsField = record.selection?.oddsField || ''
  if (!allowedField(ratioField, ratioFields) || !allowedField(oddsField, oddsFields)) return null
  return { wtype, rtypePrefix, f, isRB }
}

function marketCode(record) {
  const marketType = record.market?.marketType
  const period = record.market?.period
  if (marketType === 'asian_handicap' && period === 'full_time') {
    const live = marketVariant(record, {
      ratioFields: ['RATIO_RE'],
      oddsFields: ['IOR_REH', 'IOR_REC'],
      wtype: 'RE',
      rtypePrefix: 'RE',
      f: '',
      isRB: 'Y',
    })
    if (live) return live
    const prematch = marketVariant(record, {
      ratioFields: ['RATIO_R'],
      oddsFields: ['IOR_RH', 'IOR_RC'],
      wtype: 'R',
      rtypePrefix: 'R',
      f: '',
      isRB: 'N',
    })
    if (prematch) return prematch
  }
  if (marketType === 'asian_handicap' && period === 'first_half') {
    const live = marketVariant(record, {
      ratioFields: ['RATIO_HRE'],
      oddsFields: ['IOR_HREH', 'IOR_HREC'],
      wtype: 'RE',
      rtypePrefix: 'RE',
      f: '1R',
      isRB: 'Y',
    })
    if (live) return live
    const prematch = marketVariant(record, {
      ratioFields: ['RATIO_HR'],
      oddsFields: ['IOR_HRH', 'IOR_HRC'],
      wtype: 'R',
      rtypePrefix: 'R',
      f: '1R',
      isRB: 'N',
    })
    if (prematch) return prematch
  }
  if (marketType === 'total' && period === 'full_time') {
    const live = marketVariant(record, {
      ratioFields: ['RATIO_ROUO', 'RATIO_ROUU'],
      oddsFields: ['IOR_ROUC', 'IOR_ROUH'],
      wtype: 'ROU',
      rtypePrefix: 'ROU',
      f: '',
      isRB: 'Y',
    })
    if (live) return live
    const prematch = marketVariant(record, {
      ratioFields: ['RATIO_OUO', 'RATIO_OUU'],
      oddsFields: ['IOR_OUC', 'IOR_OUH'],
      wtype: 'OU',
      rtypePrefix: 'OU',
      f: '',
      isRB: 'N',
    })
    if (prematch) return prematch
  }
  if (marketType === 'total' && period === 'first_half') {
    const live = marketVariant(record, {
      ratioFields: ['RATIO_HROUO', 'RATIO_HROUU'],
      oddsFields: ['IOR_HROUC', 'IOR_HROUH'],
      wtype: 'ROU',
      rtypePrefix: 'ROU',
      f: '1R',
      isRB: 'Y',
    })
    if (live) return live
    const prematch = marketVariant(record, {
      ratioFields: ['RATIO_HOUO', 'RATIO_HOUU'],
      oddsFields: ['IOR_HOUC', 'IOR_HOUH'],
      wtype: 'OU',
      rtypePrefix: 'OU',
      f: '1R',
      isRB: 'N',
    })
    if (prematch) return prematch
  }
  throw new Error('unsupported-crown-market')
}

const STRICT_PREVIEW_MAPPER_KEYS = ['chose_team', 'gid', 'gtype', 'wtype']
const STRICT_PREVIEW_WIRE_KEYS = ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype']
const STRICT_SUBMIT_WIRE_KEYS = [
  'autoOdd', 'chose_team', 'con', 'f', 'gid', 'golds', 'gtype', 'imp', 'ioratio',
  'isRB', 'isYesterday', 'langx', 'odd_f_type', 'p', 'ptype', 'ratio', 'rtype',
  'timestamp', 'timestamp2', 'ver', 'wtype',
]

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function exactList(value, expected) {
  if (!Array.isArray(value)) return false
  const actual = [...new Set(value.map(String))].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function capabilityMatch(capability, name, actual) {
  if (capability[name] !== actual) throw new Error(`crown-preview-capability-mismatch:${name}`)
}

export function buildStrictCrownPreviewFields(record = {}, { capability } = {}) {
  if (!capability || typeof capability !== 'object') throw new Error('missing-crown-preview-capability')
  if (capability.evidenceStatus !== 'verified' || capability.previewAllowed !== true) {
    throw new Error('unverified-crown-preview-capability')
  }
  const evidenceId = required(capability.evidenceId, 'missing-crown-preview-evidence')
  const mode = required(record.mode || record.event?.mode, 'missing-crown-preview-mode')
  if (!['live', 'prematch'].includes(mode)) throw new Error('unsupported-crown-preview-mode')
  const period = required(record.market?.period, 'missing-crown-preview-period')
  const marketType = required(record.market?.marketType, 'missing-crown-preview-market')
  const lineVariant = required(record.market?.lineVariant, 'missing-crown-preview-line-variant')
  if (lineVariant !== 'main') throw new Error('unsupported-crown-preview-line-variant')
  const ratioField = required(record.market?.ratioField, 'missing-crown-preview-ratio-field')
  const side = required(record.selection?.side, 'missing-crown-preview-side')
  const oddsField = required(record.selection?.oddsField, 'missing-crown-preview-odds-field')

  capabilityMatch(capability, 'mode', mode)
  capabilityMatch(capability, 'period', period)
  capabilityMatch(capability, 'marketType', marketType)
  capabilityMatch(capability, 'lineVariant', lineVariant)
  const mapperEvidence = capability.mapperEvidence
  if (!mapperEvidence || typeof mapperEvidence !== 'object' || Array.isArray(mapperEvidence)) {
    throw new Error('missing-crown-preview-mapper-evidence')
  }
  if (!Array.isArray(mapperEvidence.ratioFields) || !mapperEvidence.ratioFields.includes(ratioField)) {
    throw new Error('crown-preview-capability-mismatch:ratioField')
  }
  if (!Array.isArray(mapperEvidence.oddsFields)
    || !mapperEvidence.oddsFields.includes(oddsField)
    || mapperEvidence.oddsFieldsBySide?.[side] !== oddsField) {
    throw new Error('crown-preview-capability-mismatch:oddsField')
  }
  if (!exactList(capability.requestFieldSet, STRICT_PREVIEW_WIRE_KEYS)) {
    throw new Error('invalid-crown-preview-request-keys')
  }
  const expectedWtype = marketType === 'asian_handicap'
    ? (mode === 'prematch' ? 'R' : 'RE')
    : marketType === 'total'
      ? (mode === 'prematch' ? 'OU' : 'ROU')
      : ''
  if (!expectedWtype || mapperEvidence.wtype !== expectedWtype) {
    throw new Error('crown-preview-capability-mismatch:wtype')
  }
  const choseTeamValue = selectionCode(record).choseTeam

  const gid = required(record.event?.ids?.gid || record.event?.eventId, 'missing-crown-gid')
  const line = required(record.market?.handicapRaw, 'missing-crown-line')
  const preview = {
    gid,
    gtype: 'FT',
    wtype: mapperEvidence.wtype,
    chose_team: choseTeamValue,
  }
  if (!exactKeys(preview, STRICT_PREVIEW_MAPPER_KEYS)) throw new Error('invalid-crown-preview-request-fields')
  return {
    operation: 'FT_order_view',
    preview,
    identity: { gid, mode, period, market: marketType, lineVariant, line, side },
    capabilityEvidenceId: evidenceId,
  }
}

export function buildStrictCrownPreviewWireFields(
  preview = {},
  { capability, protocolVersion, protocolVersionEvidence } = {},
) {
  if (!capability || capability.evidenceStatus !== 'verified') throw new Error('missing-crown-preview-capability')
  if (!exactKeys(preview, STRICT_PREVIEW_MAPPER_KEYS)) throw new Error('invalid-crown-preview-request-fields')
  if (!exactList(capability.requestFieldSet, STRICT_PREVIEW_WIRE_KEYS)) throw new Error('invalid-crown-preview-request-keys')
  const defaults = capability.mapperEvidence?.wireDefaults
  if (!defaults || defaults.p !== 'FT_order_view' || defaults.langx !== 'zh-cn' || defaults.odd_f_type !== 'H') {
    throw new Error('crown-preview-wire-defaults-unproven')
  }
  const source = String(protocolVersionEvidence?.source || '')
  const provedVersion = protocolVersionEvidence?.captured === true
    && protocolVersionEvidence?.verified === true
    && ['production-login-response', 'production-session-metadata'].includes(source)
  if (!provedVersion) throw new Error('crown-preview-field-source-unproven:ver')
  const ver = required(protocolVersion, 'crown-preview-field-source-unproven:ver')
  const wire = { ...preview, langx: defaults.langx, odd_f_type: defaults.odd_f_type, p: defaults.p, ver }
  if (!exactKeys(wire, STRICT_PREVIEW_WIRE_KEYS)) throw new Error('invalid-crown-preview-wire-fields')
  return wire
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))))
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stableJson(value[key]))])))
  }
  return JSON.stringify(value)
}

function assertSameIdentity(actual, expected, code) {
  if (!actual || !expected || stableJson(actual) !== stableJson(expected)) throw new Error(code)
}

function safeInteger(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error(code)
  return value
}

function exactPositiveDecimal(value, code) {
  const text = String(value || '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || Number(text) <= 0) throw new Error(code)
  return text
}

function exactSignedDecimal(value, code) {
  const input = String(value ?? '').trim()
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input)
  if (!match || (match[3] || '').length > 6) throw new Error(code)
  const digits = `${match[2]}${match[3] || ''}`.replace(/^0+(?=\d)/, '') || '0'
  if (BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code)
  const fraction = (match[3] || '').replace(/0+$/, '')
  const zero = /^0+$/.test(digits)
  return `${match[1] && !zero ? '-' : ''}${match[2]}${fraction ? `.${fraction}` : ''}`
}

export function buildStrictCrownSubmitWireFields(input = {}, {
  capability,
  protocolVersion,
  protocolVersionEvidence,
} = {}) {
  if (!capability || capability.evidenceStatus !== 'verified' || capability.submitAllowed !== true) {
    throw new Error('unverified-crown-submit-capability')
  }
  if (capability.mode !== 'prematch'
    || capability.period !== 'full_time'
    || capability.marketType !== 'asian_handicap'
    || capability.lineVariant !== 'main'
    || capability.mapperEvidence?.wtype !== 'R') {
    throw new Error('unsupported-crown-submit-capability')
  }
  const lockedIdentity = input.lockedIdentity
  assertSameIdentity(input.currentIdentity, lockedIdentity, 'crown-submit-identity-drift')
  if (!lockedIdentity || lockedIdentity.provider !== 'crown'
    || lockedIdentity.mode !== capability.mode
    || lockedIdentity.period !== capability.period
    || lockedIdentity.market !== capability.marketType
    || lockedIdentity.lineVariant !== capability.lineVariant
    || !['home', 'away'].includes(lockedIdentity.side)) {
    throw new Error('crown-submit-identity-drift')
  }

  const preview = input.preview
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) throw new Error('crown-submit-preview-required')
  if (preview.lockedIdentity !== undefined) {
    assertSameIdentity(preview.lockedIdentity, lockedIdentity, 'crown-submit-preview-identity-drift')
  }
  if (String(preview.line || '') !== String(lockedIdentity.line || '')) throw new Error('crown-submit-line-drift')
  if (preview.currency !== 'CNY' || preview.amountScale !== 0) throw new Error('crown-submit-money-contract')
  const minimum = safeInteger(preview.minStakeMinor, 'crown-submit-money-contract', { positive: true })
  const maximum = safeInteger(preview.maxStakeMinor, 'crown-submit-money-contract', { positive: true })
  const balance = safeInteger(preview.balanceMinor, 'crown-submit-money-contract')
  const step = safeInteger(preview.stakeStepMinor, 'crown-submit-money-contract', { positive: true })
  const amount = safeInteger(input.amountMinor, 'crown-submit-money-contract', { positive: true })
  if (minimum > maximum || amount < minimum || amount > maximum || amount > balance) {
    throw new Error('crown-submit-money-contract')
  }
  if (step !== 50 || preview.stakeStepProvenance !== 'local-conservative-policy'
    || amount < 50 || (amount - 50) % 50 !== 0) {
    throw new Error('crown-submit-local-quantum')
  }
  const odds = exactPositiveDecimal(preview.odds, 'crown-submit-odds')
  const submitCon = exactSignedDecimal(preview.submitCon, 'crown-submit-field-source-unproven:con')
  const submitRatio = exactSignedDecimal(preview.submitRatio, 'crown-submit-field-source-unproven:ratio')

  const source = String(protocolVersionEvidence?.source || '')
  if (protocolVersionEvidence?.captured !== true
    || protocolVersionEvidence?.verified !== true
    || !['production-login-response', 'production-session-metadata'].includes(source)) {
    throw new Error('crown-submit-field-source-unproven:ver')
  }
  const ver = required(protocolVersion, 'crown-submit-field-source-unproven:ver')
  const defaults = capability.mapperEvidence?.submitWireDefaults
  if (!defaults || defaults.p !== 'FT_bet' || defaults.langx !== 'zh-cn'
    || defaults.odd_f_type !== 'H' || defaults.isRB !== 'N' || defaults.f !== '1R'
    || defaults.timestamp2 !== ''
    || Object.hasOwn(defaults, 'con') || Object.hasOwn(defaults, 'ratio')
    || Object.hasOwn(defaults, 'timestamp')) {
    throw new Error('crown-submit-wire-defaults-unproven')
  }
  if (stableJson(capability.mapperEvidence?.submitWireSources) !== stableJson({
    con: 'preview-response:con',
    ratio: 'preview-response:ratio',
    timestamp: 'request-epoch-ms',
  })) throw new Error('crown-submit-wire-sources-unproven')
  const home = lockedIdentity.side === 'home'
  const timestamp = String(Date.now())
  if (!/^\d{13}$/.test(timestamp)) throw new Error('crown-submit-timestamp-unavailable')
  const wire = {
    autoOdd: defaults.autoOdd,
    chose_team: home ? 'H' : 'C',
    con: submitCon,
    f: defaults.f,
    gid: required(lockedIdentity.gid, 'missing-crown-gid'),
    golds: String(amount),
    gtype: 'FT',
    imp: defaults.imp,
    ioratio: odds,
    isRB: defaults.isRB,
    isYesterday: defaults.isYesterday,
    langx: defaults.langx,
    odd_f_type: defaults.odd_f_type,
    p: defaults.p,
    ptype: defaults.ptype,
    ratio: submitRatio,
    rtype: home ? 'RH' : 'RC',
    timestamp,
    timestamp2: defaults.timestamp2,
    ver,
    wtype: 'R',
  }
  if (!exactKeys(wire, STRICT_SUBMIT_WIRE_KEYS)) throw new Error('invalid-crown-submit-wire-fields')
  return wire
}

export function buildCrownOrderFields(record = {}) {
  const market = marketCode(record)
  const selection = selectionCode(record)
  const gid = required(record.event?.ids?.gid || record.event?.eventId, 'missing-crown-gid')
  const stake = Number(record.stake)
  if (!Number.isFinite(stake) || stake <= 0) throw new Error('invalid-stake')
  const base = {
    gid,
    gtype: 'FT',
    wtype: market.wtype,
    chose_team: selection.choseTeam,
  }
  return {
    preview: base,
    submit: {
      ...base,
      golds: String(stake),
      rtype: `${market.rtypePrefix}${selection.rtypeSuffix}`,
      ioratio: required(record.selection?.oddsRaw, 'missing-odds'),
      con: required(record.market?.handicapRaw, 'missing-handicap'),
      ratio: '-50',
      autoOdd: 'Y',
      timestamp: '',
      timestamp2: '',
      isRB: market.isRB,
      imp: 'N',
      ptype: '',
      isYesterday: 'N',
      f: market.f,
    },
  }
}
