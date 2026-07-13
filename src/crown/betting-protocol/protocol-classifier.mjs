import { createHash } from 'node:crypto'

import { parseBody } from './capture-redaction.mjs'

const MONITOR_RE = /(get_game_list|get_game_more|chk_login|get_member_data)/i
const ORDER_RE = /(bet|betslip|bet_slip|wager|order|ticket|coupon|gold|stake|ior|ratio|selection|odd)/i
const SUBMIT_RE = /(submit|confirm|buy|place|order_add|bet_add|wager_add|ticket_add|\b[a-z]{2,5}_bet\b|(?:^|[=&\s])bet(?:$|[=&\s]))/i
const PREVIEW_RE = /(preview|view|open|prepare|check|verify|order_view|bet_view|bet_slip)/i
const EXACT_PREVIEW_REQUEST_FIELDS = ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype']

function exactFieldSet(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.values(value).some(Array.isArray)) return false
  const keys = Object.keys(value)
  if (keys.some((field) => field !== 'uid' && !expected.includes(field))) return false
  const fields = keys.filter((field) => field !== 'uid').sort()
  return fields.length === expected.length && fields.every((field, index) => field === expected[index])
}

function fieldSetFingerprint(fields) {
  return `sha256:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
}

function flatten(value, prefix = '', output = []) {
  if (value == null) return output
  if (Array.isArray(value)) {
    output.push(`${prefix}[]`)
    value.slice(0, 10).forEach((item) => flatten(item, `${prefix}[]`, output))
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output)
    }
    return output
  }
  output.push(`${prefix}=${String(value).slice(0, 80)}`)
  return output
}

export function classifyProtocolRecord(record) {
  const method = String(record.method || '').toUpperCase()
  const url = String(record.url || '')
  const body = parseBody(record.postData || '')
  const bodyText = flatten(body).join('\n')
  const blob = `${method}\n${url}\n${bodyText}`
  const reasons = []

  if (MONITOR_RE.test(blob)) {
    return { stage: 'monitor', confidence: 'high', reasons: ['known read-only monitor endpoint'] }
  }

  if (method === 'POST' && String(body?.p || '') === 'FT_order_view') {
    if (!exactFieldSet(body, EXACT_PREVIEW_REQUEST_FIELDS)) {
      return { stage: 'candidate', confidence: 'low', reasons: ['preview request field-set drift'] }
    }
    return {
      stage: 'preview',
      confidence: 'high',
      reasons: ['exact captured preview request field set'],
      requestFieldSet: [...EXACT_PREVIEW_REQUEST_FIELDS],
      requestFieldSetFingerprint: fieldSetFingerprint(EXACT_PREVIEW_REQUEST_FIELDS),
    }
  }

  if (method === 'POST' && SUBMIT_RE.test(blob) && ORDER_RE.test(blob)) {
    reasons.push('submit-like keyword')
    reasons.push('order-like post parameter')
    return { stage: 'submit', confidence: 'high', reasons }
  }

  if (method === 'POST' && PREVIEW_RE.test(blob) && ORDER_RE.test(blob)) {
    reasons.push('preview-like keyword')
    reasons.push('order-like post parameter')
    return { stage: 'preview', confidence: 'medium', reasons }
  }

  if (method === 'POST' && ORDER_RE.test(blob)) {
    reasons.push('order-like post parameter')
    return { stage: 'candidate', confidence: 'low', reasons }
  }

  return { stage: 'unknown', confidence: 'low', reasons: [] }
}

export function shouldBlockProtocolRequest(record, { allowRealSubmit = false } = {}) {
  const classification = classifyProtocolRecord(record)
  if (classification.stage !== 'submit') return { block: false, classification }
  if (allowRealSubmit) return { block: false, classification }
  return {
    block: true,
    reason: 'real-submit-disabled',
    classification,
  }
}
