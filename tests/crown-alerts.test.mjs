import assert from 'node:assert/strict'
import test from 'node:test'

import { formatOddsChangeAlert } from '../src/crown/alerts/console-alert.mjs'
import {
  buildBetOutcomeTelegramMessage,
  buildSignalTelegramMessage,
  buildTelegramMessage,
  sendTelegramAlert,
  sendTelegramBetOutcomeAlert,
  sendTelegramSignalAlert,
} from '../src/crown/alerts/telegram-alert.mjs'
import { buildOddsChangeTelegramMessage } from '../src/crown/alerts/telegram-templates.mjs'

const change = {
  capturedAt: '2026-07-08T00:40:11.000+08:00',
  old: { oddsRaw: '0.94' },
  next: { oddsRaw: '0.95' },
  event: {
    league: '世界杯2026(美加墨)',
    homeTeam: '瑞士',
    awayTeam: '哥伦比亚',
  },
  market: {
    marketType: 'asian_handicap',
    handicapRaw: '+0/0.5',
  },
}

test('formats console odds change alerts with required fields', () => {
  const text = formatOddsChangeAlert(change)

  assert.match(text, /世界杯2026/)
  assert.match(text, /瑞士 vs 哥伦比亚/)
  assert.match(text, /asian_handicap/)
  assert.match(text, /\+0\/0\.5/)
  assert.match(text, /0\.94 -> 0\.95/)
  assert.match(text, /2026-07-08T00:40:11/)
})

test('telegram message does not include token or secret values', async () => {
  const config = { enabled: false, botToken: 'secret-token', chatId: '123456' }
  const text = buildTelegramMessage(change)
  const result = await sendTelegramAlert(change, config)

  assert.equal(text.includes('secret-token'), false)
  assert.equal(result.sent, false)
  assert.equal(result.reason, 'disabled')
})

test('telegram message uses crown odds change template', () => {
  const text = buildTelegramMessage(change)

  assert.match(text, /皇冠赔率变化提醒/)
  assert.match(text, /瑞士 v 哥伦比亚/)
  assert.match(text, /类型：让球/)
})

test('telegram alert sends rendered template to multiple chat ids', async () => {
  const calls = []
  const result = await sendTelegramAlert(change, {
    enabled: true,
    botToken: '123456:secret-token',
    chatIds: ['10001', '-10002:88'],
    parseMode: 'HTML',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })

  assert.equal(result.sent, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.chat_id, '10001')
  assert.equal(calls[1].body.chat_id, '-10002')
  assert.equal(calls[1].body.message_thread_id, 88)
  assert.match(calls[0].body.text, /皇冠赔率变化提醒/)
  assert.equal(JSON.stringify(calls.map((call) => call.body)).includes('secret-token'), false)
})

test('telegram alert skips unsupported market types', async () => {
  const result = await sendTelegramAlert({
    type: 'odds-change',
    event: { homeTeam: 'A', awayTeam: 'B' },
    market: { marketType: 'moneyline', side: 'home' },
  }, {
    enabled: true,
    botToken: 'token',
    chatIds: ['10001'],
  })

  assert.equal(result.sent, false)
  assert.equal(result.reason, 'unsupported-market')
})

test('builds total odds telegram message with side, handicap, and odds on one change line', () => {
  const text = buildOddsChangeTelegramMessage({
    capturedAt: '2026-07-09T06:12:30.000+08:00',
    old: { oddsRaw: '0.94' },
    next: { oddsRaw: '0.90' },
    event: {
      league: '球会友谊赛',
      homeTeam: '富明尼斯RJ',
      awayTeam: '诺瓦艾夸古RJ',
    },
    market: {
      marketType: 'total',
      period: 'full_time',
      side: 'over',
      handicapRaw: '3',
    },
  })

  assert.match(text, /富明尼斯RJ v 诺瓦艾夸古RJ/)
  assert.match(text, /联赛：球会友谊赛/)
  assert.match(text, /类型：大小球 \/ 全场/)
  assert.match(text, /变化：大 3 0\.94 -> 0\.90/)
  assert.match(text, /时间：2026-07-09 06:12:30/)
})

test('builds handicap odds telegram message with actual team name', () => {
  const text = buildOddsChangeTelegramMessage({
    capturedAt: '2026-07-09T06:12:30.000+08:00',
    old: { oddsRaw: '0.94' },
    next: { oddsRaw: '0.90' },
    event: {
      league: '智利联赛杯',
      homeTeam: '尤尼昂',
      awayTeam: '科金博',
    },
    market: {
      marketType: 'asian_handicap',
      period: 'first_half',
      side: 'home',
      handicapRaw: '-0/0.5',
    },
  })

  assert.match(text, /尤尼昂 v 科金博/)
  assert.match(text, /类型：让球 \/ 上半场/)
  assert.match(text, /变化：尤尼昂 -0\/0\.5 0\.94 -> 0\.90/)
  assert.equal(text.includes('主队 -0/0.5'), false)
})

test('Signal telegram rendering uses the approved five-line total alert with Beijing time', async () => {
  const signal = {
    signalId: 'a'.repeat(64),
    strategyId: 'legacy-monitor-handicap-odds-delta',
    strategyVersion: 2,
    observedAt: '2026-07-10T10:04:00.000Z',
    trigger: { direction: 'down', delta: 0.01, threshold: 0.01 },
    target: {
      eventIdentity: 'crown|football|gid=3001',
      marketIdentity: 'crown|football|gid=3001|full_time|total|RATIO_OUO',
      selectionIdentity: 'crown|football|gid=3001|full_time|total|RATIO_OUO|under',
      side: 'under',
    },
    evidence: {
      league: '世界杯2026(美加墨)',
      homeTeam: '法国',
      awayTeam: '摩洛哥',
      marketType: 'total',
      period: 'full_time',
      handicap: 2.5,
      handicapRaw: '2.5',
      oldOdds: 0.85,
      oldOddsRaw: '0.850',
      nextOdds: 0.84,
      nextOddsRaw: '0.840',
    },
    dataQuality: { complete: true, identityConfidence: 'high', warnings: ['clock-estimated'], missing: [] },
  }
  const text = buildSignalTelegramMessage(signal)
  assert.equal(text, [
    '世界杯2026(美加墨)',
    '法国 v 摩洛哥',
    '大小球 / 全场',
    '小 2.5 0.850 -> 0.840',
    '时间：2026-07-10 18:04:00',
  ].join('\n'))
  assert.doesNotMatch(text, /secret-token/)
  assert.doesNotMatch(text, /Crown monitor signal|Strategy|Signal:|threshold|Data quality/)

  const result = await sendTelegramSignalAlert(signal, { enabled: false, botToken: 'secret-token', chatId: '123' })
  assert.deepEqual(result, { sent: false, reason: 'disabled', permanent: true })
})

test('Signal telegram rendering uses the selected team for a handicap alert', () => {
  const text = buildSignalTelegramMessage({
    observedAt: '2026-07-10T10:04:00.000Z',
    target: { side: 'home' },
    evidence: {
      league: '美国足球乙组联赛',
      homeTeam: '主队',
      awayTeam: '客队',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '+0/0.5',
      oldOddsRaw: '0.940',
      nextOddsRaw: '0.990',
    },
  })

  assert.equal(text, [
    '美国足球乙组联赛',
    '主队 v 客队',
    '让球 / 全场',
    '主队 +0/0.5 0.940 -> 0.990',
    '时间：2026-07-10 18:04:00',
  ].join('\n'))
})

test('bet outcome templates classify every final status and reserve success wording for accepted', () => {
  const titles = {
    accepted: '皇冠投注成功通知',
    rejected: '皇冠投注被拒通知',
    unknown: '皇冠投注状态未知警告',
    cancelled: '皇冠投注已取消通知',
    partial: '皇冠投注部分完成通知',
    failed: '皇冠投注失败通知',
    circuit_open: '皇冠投注熔断通知',
  }
  for (const [finalStatus, title] of Object.entries(titles)) {
    const text = buildBetOutcomeTelegramMessage({
      batchId: '<batch-1>', childOrderId: 'child-1', finalStatus, createdAt: '2026-07-11T00:00:00.000Z',
    })
    assert.match(text, new RegExp(title))
    assert.match(text, /&lt;batch-1&gt;/)
    if (finalStatus !== 'accepted') assert.doesNotMatch(text, /成功/)
  }
  assert.throws(() => buildBetOutcomeTelegramMessage({ finalStatus: 'success' }), /bet-outcome-status-unsupported/)
})

test('bet outcome Telegram sender renders the classified template with fake transport only', async () => {
  const calls = []
  const result = await sendTelegramBetOutcomeAlert({
    notificationId: 'notification-unknown', batchId: 'batch-1', childOrderId: 'child-1',
    finalStatus: 'unknown', createdAt: '2026-07-11T00:00:00.000Z',
  }, {
    enabled: true,
    botToken: '123456:fake-token',
    chatIds: ['10001'],
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body))
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result.sent, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].text, /皇冠投注状态未知警告/)
  assert.doesNotMatch(calls[0].text, /成功|fake-token/)
})

test('bet outcome Telegram remains pending when any configured chat fails', async () => {
  let call = 0
  const result = await sendTelegramBetOutcomeAlert({
    notificationId: 'notification-accepted', batchId: 'batch-1', childOrderId: 'child-1',
    finalStatus: 'accepted', createdAt: '2026-07-11T00:00:00.000Z',
  }, {
    enabled: true,
    botToken: '123456:fake-token',
    chatIds: ['10001', '10002'],
    fetchImpl: async () => {
      call += 1
      return { ok: call === 1, status: call === 1 ? 200 : 500 }
    },
  })
  assert.equal(result.sent, false)
  assert.equal(result.reason, 'telegram-partial-failure')
  assert.equal(result.results.length, 2)
  assert.equal(call, 2)
  assert.deepEqual(result.deliveryState.deliveredChatTargets, ['10001'])

  const retryCalls = []
  const retry = await sendTelegramBetOutcomeAlert({
    notificationId: 'notification-accepted', batchId: 'batch-1', childOrderId: 'child-1',
    finalStatus: 'accepted', createdAt: '2026-07-11T00:00:00.000Z',
  }, {
    enabled: true,
    botToken: '123456:fake-token',
    chatIds: ['10001', '10002'],
    deliveryState: result.deliveryState,
    fetchImpl: async (_url, options) => {
      retryCalls.push(JSON.parse(options.body).chat_id)
      return { ok: true, status: 200 }
    },
  })
  assert.equal(retry.sent, true)
  assert.deepEqual(retryCalls, ['10002'])
  assert.deepEqual(retry.deliveryState.deliveredChatTargets, ['10001', '10002'])
})
