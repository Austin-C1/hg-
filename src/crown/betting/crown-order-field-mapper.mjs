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
  if (mode !== 'live') throw new Error('unsupported-crown-preview-mode')
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
  const expectedWtype = marketType === 'asian_handicap' ? 'RE' : marketType === 'total' ? 'ROU' : ''
  if (!expectedWtype || mapperEvidence.wtype !== expectedWtype) {
    throw new Error('crown-preview-capability-mismatch:wtype')
  }
  const choseTeamValue = selectionCode(record).choseTeam

  const gid = required(record.event?.ids?.gid || record.event?.eventId, 'missing-crown-gid')
  const line = required(record.market?.lineKey || record.market?.handicapRaw, 'missing-crown-line')
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
    identity: { gid, mode, period, market: marketType, line, side },
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
