const MARKET_LABELS = {
  asian_handicap: '让球',
  total: '大小球',
}

const PERIOD_LABELS = {
  full: '全场',
  full_time: '全场',
  full_match: '全场',
  first_half: '上半场',
  prematch: '赛前',
  live: '滚球',
}

const BET_OUTCOME_TEMPLATES = Object.freeze({
  accepted: Object.freeze({ title: '皇冠投注成功通知', label: '已接受' }),
  rejected: Object.freeze({ title: '皇冠投注被拒通知', label: '已拒绝' }),
  unknown: Object.freeze({ title: '皇冠投注状态未知警告', label: '状态未知' }),
  cancelled: Object.freeze({ title: '皇冠投注已取消通知', label: '已取消' }),
  partial: Object.freeze({ title: '皇冠投注部分完成通知', label: '部分完成' }),
  failed: Object.freeze({ title: '皇冠投注失败通知', label: '失败' }),
  circuit_open: Object.freeze({ title: '皇冠投注熔断通知', label: '熔断开启' }),
})

function clean(value, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

function html(value, fallback = '-') {
  return clean(value, fallback).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function oddsRawOf(snapshot) {
  return clean(snapshot?.oddsRaw ?? snapshot?.odds?.raw ?? snapshot?.selection?.oddsRaw)
}

function handicapRawOf(change) {
  return clean(change?.market?.handicapRaw ?? change?.next?.handicapRaw ?? change?.next?.handicap?.raw ?? change?.old?.handicapRaw ?? change?.old?.handicap?.raw)
}

function sideOf(change) {
  return change?.market?.side || change?.selection?.side || change?.next?.selection?.side || change?.old?.selection?.side || ''
}

function formatTimestamp(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return '-'
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function marketLabel(marketType) {
  return MARKET_LABELS[marketType] || ''
}

function periodLabel(period) {
  return PERIOD_LABELS[period] || clean(period)
}

function changeLine(change) {
  const event = change?.event || {}
  const market = change?.market || {}
  const handicap = handicapRawOf(change)
  const oldOdds = oddsRawOf(change?.old)
  const nextOdds = oddsRawOf(change?.next)
  const side = sideOf(change)

  if (market.marketType === 'total') {
    return `${side === 'under' ? '小' : '大'} ${handicap} ${oldOdds} -> ${nextOdds}`
  }

  const team = side === 'away' ? event.awayTeam : event.homeTeam
  return `${clean(team)} ${handicap} ${oldOdds} -> ${nextOdds}`
}

export function buildOddsChangeTelegramMessage(change) {
  const event = change?.event || {}
  const market = change?.market || {}
  const label = marketLabel(market.marketType)
  if (!label) return null

  return [
    '皇冠赔率变化提醒',
    '',
    `${clean(event.homeTeam)} v ${clean(event.awayTeam)}`,
    `联赛：${clean(event.league)}`,
    `类型：${label} / ${periodLabel(market.period)}`,
    `变化：${changeLine(change)}`,
    `时间：${formatTimestamp(change?.capturedAt)}`,
  ].join('\n')
}

export function buildSignalOddsChangeTelegramMessage(signal = {}) {
  const evidence = signal.evidence || {}
  const target = signal.target || {}
  const line = evidence.marketType === 'total'
    ? `${target.side === 'under' ? '小' : '大'} ${html(evidence.handicapRaw)} ${html(evidence.oldOddsRaw)} -> ${html(evidence.nextOddsRaw)}`
    : `${target.side === 'away' ? html(evidence.awayTeam) : html(evidence.homeTeam)} ${html(evidence.handicapRaw)} ${html(evidence.oldOddsRaw)} -> ${html(evidence.nextOddsRaw)}`
  return [
    html(evidence.league),
    `${html(evidence.homeTeam)} v ${html(evidence.awayTeam)}`,
    `${marketLabel(evidence.marketType)} / ${periodLabel(evidence.period)}`,
    line,
    `时间：${formatTimestamp(signal.observedAt)}`,
  ].join('\n')
}

export function buildTelegramTestMessage(botName, testMessage) {
  return [
    clean(botName, 'Telegram 机器人'),
    '',
    clean(testMessage, '测试消息'),
  ].join('\n')
}

export function buildBetSuccessTelegramMessage(input = {}) {
  return buildBetOutcomeTelegramMessage({ ...input, finalStatus: 'accepted' })
}

export function buildBetOutcomeTelegramMessage(input = {}) {
  const finalStatus = String(input.finalStatus || '')
  const template = BET_OUTCOME_TEMPLATES[finalStatus]
  if (!template) throw new Error('bet-outcome-status-unsupported')
  return [
    template.title,
    '',
    `批次：${html(input.batchId)}`,
    `子订单：${html(input.childOrderId)}`,
    `状态：${template.label}`,
    `时间：${formatTimestamp(input.capturedAt || input.createdAt)}`,
  ].join('\n')
}
