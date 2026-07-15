function required(value, code) {
  if (value === undefined || value === null || value === '') throw new Error(code)
  return String(value)
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
  capabilityMatch(capability, 'selectionSide', side)
  const mapperEvidence = capability.mapperEvidence
  if (!mapperEvidence || typeof mapperEvidence !== 'object' || Array.isArray(mapperEvidence)) {
    throw new Error('missing-crown-preview-mapper-evidence')
  }
  if (!Array.isArray(mapperEvidence.ratioFields) || !mapperEvidence.ratioFields.includes(ratioField)) {
    throw new Error('crown-preview-capability-mismatch:ratioField')
  }
  if (!Array.isArray(mapperEvidence.oddsFields)
    || mapperEvidence.oddsFields.length !== 1
    || mapperEvidence.oddsFields[0] !== oddsField
    || mapperEvidence.oddsFieldsBySide?.[side] !== oddsField) {
    throw new Error('crown-preview-capability-mismatch:oddsField')
  }
  if (!exactList(capability.requestFieldSets?.preview || capability.requestFieldSet, STRICT_PREVIEW_WIRE_KEYS)) {
    throw new Error('invalid-crown-preview-request-keys')
  }
  const sideWire = mapperEvidence.previewWireBySide?.[side]
  if (!exactKeys(sideWire, ['chose_team', 'gtype', 'p', 'wtype'])
    || sideWire.p !== capability.endpoints?.preview?.functionName
    || sideWire.gtype !== 'FT') throw new Error('crown-preview-side-wire-unproven')

  const gid = required(record.event?.ids?.gid || record.event?.eventId, 'missing-crown-gid')
  const line = required(record.market?.handicapRaw, 'missing-crown-line')
  const preview = {
    gid,
    gtype: sideWire.gtype,
    wtype: sideWire.wtype,
    chose_team: sideWire.chose_team,
  }
  if (!exactKeys(preview, STRICT_PREVIEW_MAPPER_KEYS)) throw new Error('invalid-crown-preview-request-fields')
  return {
    operation: sideWire.p,
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
  if (!exactList(capability.requestFieldSets?.preview || capability.requestFieldSet, STRICT_PREVIEW_WIRE_KEYS)) {
    throw new Error('invalid-crown-preview-request-keys')
  }
  const side = capability.selectionSide
  const sideWire = capability.mapperEvidence?.previewWireBySide?.[side]
  if (!exactKeys(sideWire, ['chose_team', 'gtype', 'p', 'wtype'])
    || sideWire.p !== capability.endpoints?.preview?.functionName
    || sideWire.gtype !== preview.gtype
    || sideWire.wtype !== preview.wtype
    || sideWire.chose_team !== preview.chose_team) throw new Error('crown-preview-side-wire-unproven')
  const defaults = capability.mapperEvidence?.wireDefaults?.preview
  if (!defaults || defaults.langx !== 'zh-cn' || defaults.odd_f_type !== 'H') {
    throw new Error('crown-preview-wire-defaults-unproven')
  }
  const source = String(protocolVersionEvidence?.source || '')
  const provedVersion = protocolVersionEvidence?.captured === true
    && protocolVersionEvidence?.verified === true
    && ['production-login-response', 'production-session-metadata'].includes(source)
  if (!provedVersion) throw new Error('crown-preview-field-source-unproven:ver')
  const ver = required(protocolVersion, 'crown-preview-field-source-unproven:ver')
  const wire = { ...preview, langx: defaults.langx, odd_f_type: defaults.odd_f_type, p: sideWire.p, ver }
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
  const lockedIdentity = input.lockedIdentity
  assertSameIdentity(input.currentIdentity, lockedIdentity, 'crown-submit-identity-drift')
  if (!lockedIdentity || lockedIdentity.provider !== 'crown'
    || lockedIdentity.mode !== capability.mode
    || lockedIdentity.period !== capability.period
    || lockedIdentity.market !== capability.marketType
    || lockedIdentity.lineVariant !== capability.lineVariant
    || lockedIdentity.side !== capability.selectionSide) {
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
  const amount = safeInteger(input.amountMinor, 'crown-submit-money-contract', { positive: true })
  if (minimum > maximum || amount < minimum || amount > maximum || amount > balance) {
    throw new Error('crown-submit-money-contract')
  }
  const stepProvenance = String(preview.stakeStepProvenance || '')
  if (preview.stakeStepMinor === null) {
    if (stepProvenance !== 'not-evidenced-in-preview-response' || amount !== minimum) {
      throw new Error('crown-submit-stake-step-unverified')
    }
  } else {
    const step = safeInteger(preview.stakeStepMinor, 'crown-submit-money-contract', { positive: true })
    if (amount !== minimum) {
      if (!['provider-preview-response', 'verified-account-policy'].includes(stepProvenance)) {
        throw new Error('crown-submit-stake-step-unverified')
      }
      if ((amount - minimum) % step !== 0) throw new Error('crown-submit-stake-step-mismatch')
    }
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
  const sideWire = capability.mapperEvidence?.submitWireBySide?.[lockedIdentity.side]
  if (!exactKeys(sideWire, ['chose_team', 'f', 'gtype', 'isRB', 'p', 'rtype', 'wtype'])
    || sideWire.p !== capability.endpoints?.submit?.functionName
    || sideWire.gtype !== 'FT') throw new Error('crown-submit-side-wire-unproven')
  const defaults = capability.mapperEvidence?.wireDefaults?.submit
  if (!defaults || defaults.langx !== 'zh-cn'
    || defaults.odd_f_type !== 'H' || defaults.timestamp2 !== ''
    || Object.hasOwn(defaults, 'con') || Object.hasOwn(defaults, 'ratio')
    || Object.hasOwn(defaults, 'timestamp') || Object.hasOwn(defaults, 'gid')
    || Object.hasOwn(defaults, 'golds') || Object.hasOwn(defaults, 'ioratio')
    || Object.hasOwn(defaults, 'ver')) {
    throw new Error('crown-submit-wire-defaults-unproven')
  }
  const sources = capability.mapperEvidence?.dynamicFieldSources
  if (sources?.con !== 'preview-response:con'
    || sources?.ratio !== 'preview-response:ratio'
    || sources?.timestamp !== 'request-clock:epoch-ms'
    || sources?.gid !== 'current-selection:event.ids.gid'
    || sources?.odds !== 'preview-response:ioratio'
    || sources?.stake !== 'execution-request:amount-minor'
    || sources?.ver !== 'verified-session:protocol-version') {
    throw new Error('crown-submit-wire-sources-unproven')
  }
  const timestamp = String(Date.now())
  if (!/^\d{13}$/.test(timestamp)) throw new Error('crown-submit-timestamp-unavailable')
  const wire = {
    autoOdd: defaults.autoOdd,
    chose_team: sideWire.chose_team,
    con: submitCon,
    f: sideWire.f,
    gid: required(lockedIdentity.gid, 'missing-crown-gid'),
    golds: String(amount),
    gtype: sideWire.gtype,
    imp: defaults.imp,
    ioratio: odds,
    isRB: sideWire.isRB,
    isYesterday: defaults.isYesterday,
    langx: defaults.langx,
    odd_f_type: defaults.odd_f_type,
    p: sideWire.p,
    ptype: defaults.ptype,
    ratio: submitRatio,
    rtype: sideWire.rtype,
    timestamp,
    timestamp2: defaults.timestamp2,
    ver,
    wtype: sideWire.wtype,
  }
  if (!exactKeys(wire, STRICT_SUBMIT_WIRE_KEYS)) throw new Error('invalid-crown-submit-wire-fields')
  return wire
}
