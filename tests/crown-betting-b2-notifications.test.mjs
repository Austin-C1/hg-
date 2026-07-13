import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import {
  B2OutcomeDispatcher,
  createTelegramB2OutcomeDispatcher,
} from '../src/crown/betting/b2-outcome-dispatcher.mjs'

const START = Date.parse('2026-07-11T00:00:00.000Z')

function seedLedger(db) {
  db.exec(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status,
      observed_at, expires_at, payload_json
    ) VALUES ('signal-1', 'signal-key-1', 'strategy-1', 1, 'ready',
      '2026-07-11T00:00:00.000Z', '2026-07-11T01:00:00.000Z', '{}');
    INSERT INTO betting_rules (
      id, name, enabled, execution_mode, currency, amount_scale,
      target_amount_minor, created_at, updated_at
    ) VALUES ('rule-1', 'rule', 1, 'real_eligible', 'CNY', 2, 100,
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    INSERT INTO betting_accounts (
      id, label, username, status, per_bet_limit_minor, currency,
      amount_scale, stake_step_minor, created_at, updated_at
    ) VALUES ('account-1', 'account', 'account', 'enabled', 100, 'CNY', 2, 1,
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, target_amount_minor,
      unfilled_amount_minor, currency, amount_scale, created_at
    ) VALUES ('batch-1', 'signal-1', 'rule-1', 100, 100, 'CNY', 2,
      '2026-07-11T00:00:00.000Z');
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor,
      preview_balance_minor, preview_stake_step_minor, preview_odds,
      status, created_at
    ) VALUES ('child-1', 'batch-1', 'account-1', 100, 1, 100, 100, 1,
      '0.95', 'reserved', '2026-07-11T00:00:00.000Z');
  `)
}

function setup() {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seedLedger(handle.db)
  let nowMs = START
  return {
    ...handle,
    now: () => new Date(nowMs),
    advance(ms) { nowMs += ms },
  }
}

function enqueue(db, finalStatus, payload = {}) {
  db.prepare(`
    INSERT INTO bet_notification_outbox (
      notification_id, batch_id, child_order_id, final_status,
      next_attempt_at, payload_json, created_at, updated_at
    ) VALUES (?, 'batch-1', 'child-1', ?, ?, ?, ?, ?)
  `).run(
    `notification-${finalStatus}`,
    finalStatus,
    new Date(START).toISOString(),
    JSON.stringify({ batchId: 'forged-batch', finalStatus: 'accepted', ...payload }),
    new Date(START).toISOString(),
    new Date(START).toISOString(),
  )
}

function row(db, finalStatus) {
  return db.prepare('SELECT * FROM bet_notification_outbox WHERE notification_id=?')
    .get(`notification-${finalStatus}`)
}

test('success dispatcher claims accepted only and leaves rejected or unknown outside the success channel', async () => {
  const context = setup()
  enqueue(context.db, 'accepted', {
    providerReference: 'provider-secret', ticket: 'ticket-secret', uid: 'uid-secret',
    cookie: 'cookie-secret', password: 'password-secret', extra: 'must-not-pass',
  })
  enqueue(context.db, 'rejected')
  enqueue(context.db, 'unknown')
  const sent = []
  const sender = async (payload) => { sent.push(payload); return { sent: true } }
  const first = new B2OutcomeDispatcher({
    db: context.db, ownerId: 'worker-a', sender, now: context.now, batchSize: 2, leaseMs: 1_000,
  })
  const second = new B2OutcomeDispatcher({
    db: context.db, ownerId: 'worker-b', sender, now: context.now, batchSize: 2, leaseMs: 1_000,
  })

  const results = await Promise.all([first.runOnce(), second.runOnce()])
  assert.equal(results.reduce((sum, item) => sum + item.claimed, 0), 1)
  assert.equal(results.every((item) => item.claimed <= 2), true)
  assert.equal(sent.length, 1)
  assert.equal(new Set(sent.map((item) => item.notificationId)).size, 1)
  assert.deepEqual(Object.keys(sent.find((item) => item.finalStatus === 'accepted')).sort(), [
    'batchId', 'childOrderId', 'createdAt', 'finalStatus', 'notificationId',
  ])
  assert.equal(JSON.stringify(sent).includes('secret'), false)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE status='delivered'").get().count, 1)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE final_status IN ('rejected','unknown') AND status='pending'").get().count, 2)
  assert.equal((await first.runOnce()).claimed, 0)
  assert.equal(sent.length, 1)
  context.close()
})

test('each sequential delivery receives a fresh lease so a second worker cannot resend the batch tail', async () => {
  const context = setup()
  const statuses = ['accepted']
  for (const status of statuses) enqueue(context.db, status)
  const calls = new Map()
  const count = (id) => calls.set(id, (calls.get(id) || 0) + 1)
  const second = new B2OutcomeDispatcher({
    db: context.db,
    ownerId: 'worker-lease-b',
    now: context.now,
    batchSize: 7,
    leaseMs: 100,
    sendTimeoutMs: 90,
    sender: async (payload) => { count(payload.notificationId); return { sent: true } },
  })
  let firstCalls = 0
  const first = new B2OutcomeDispatcher({
    db: context.db,
    ownerId: 'worker-lease-a',
    now: context.now,
    batchSize: 7,
    leaseMs: 100,
    sendTimeoutMs: 90,
    sender: async (payload) => {
      count(payload.notificationId)
      firstCalls += 1
      context.advance(20)
      if (firstCalls === 1) await second.runOnce()
      return { sent: true }
    },
  })

  await first.runOnce()

  assert.equal(calls.size, statuses.length)
  assert.equal([...calls.values()].every((value) => value === 1), true)
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM bet_notification_outbox WHERE status='delivered'").get().count, statuses.length)
  context.close()
})

test('sender failures retry after 5, 15, and 45 seconds then dead-letter on attempt four', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  let sends = 0
  const dispatcher = new B2OutcomeDispatcher({
    db: context.db,
    ownerId: 'worker-retry',
    now: context.now,
    leaseMs: 1_000,
    sender: async () => { sends += 1; throw new Error('password-secret-must-not-persist') },
  })

  for (const delaySeconds of [5, 15, 45]) {
    const result = await dispatcher.runOnce()
    assert.equal(result.retried, 1)
    const pending = row(context.db, 'accepted')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.next_attempt_at, new Date(context.now().getTime() + delaySeconds * 1_000).toISOString())
    assert.equal((await dispatcher.runOnce()).claimed, 0)
    context.advance(delaySeconds * 1_000)
  }
  const fourth = await dispatcher.runOnce()
  const dead = row(context.db, 'accepted')
  assert.equal(fourth.deadLetter, 1)
  assert.equal(dead.status, 'dead_letter')
  assert.equal(dead.attempt_count, 4)
  assert.equal(dead.last_error_code, 'notification-send-failed')
  assert.equal(JSON.stringify(dead).includes('secret'), false)
  assert.equal(sends, 4)
  context.close()
})

test('expired claims recover after restart with a higher fence and stale workers cannot complete', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  context.db.prepare(`
    UPDATE bet_notification_outbox
    SET status='delivering', attempt_count=1, lease_owner='crashed-worker',
        lease_fencing_token=7, lease_expires_at='2026-07-10T23:59:59.000Z'
    WHERE notification_id='notification-accepted'
  `).run()
  const recovered = new B2OutcomeDispatcher({
    db: context.db, ownerId: 'restart-worker', now: context.now, leaseMs: 1_000,
    sender: async () => ({ sent: true }),
  })
  assert.equal((await recovered.runOnce()).delivered, 1)
  assert.equal(row(context.db, 'accepted').lease_fencing_token, 8)
  context.close()
})

test('sender is aborted before its delivery lease expires and becomes a retry', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  let aborted = false
  const dispatcher = new B2OutcomeDispatcher({
    db: context.db,
    ownerId: 'timeout-worker',
    now: context.now,
    leaseMs: 1_000,
    sendTimeoutMs: 10,
    sender: async (_payload, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true
        resolve({ sent: false })
      }, { once: true })
    }),
  })
  const result = await dispatcher.runOnce()
  assert.equal(aborted, true)
  assert.equal(result.retried, 1)
  assert.equal(row(context.db, 'accepted').status, 'pending')
  context.close()
})

test('accepted outbox rows flow through the production Telegram composition with fake transport', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  const calls = []
  const dispatcher = createTelegramB2OutcomeDispatcher({
    db: context.db,
    ownerId: 'telegram-worker',
    now: context.now,
    telegramConfig: {
      enabled: true,
      botToken: '123456:fake-token',
      chatIds: ['10001'],
      fetchImpl: async (_url, options) => {
        calls.push({ body: JSON.parse(options.body), signal: options.signal })
        return { ok: true, status: 200 }
      },
    },
  })
  const result = await dispatcher.runOnce()
  assert.equal(result.delivered, 1)
  assert.equal(row(context.db, 'accepted').status, 'delivered')
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.text, /皇冠投注成功通知/)
  assert.ok(calls[0].signal instanceof AbortSignal)
  context.close()
})

test('multi-chat partial delivery persists successful targets and retries only failed targets', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  const calls = []
  let failSecond = true
  const dispatcher = createTelegramB2OutcomeDispatcher({
    db: context.db,
    ownerId: 'telegram-multi-worker',
    now: context.now,
    telegramConfig: {
      enabled: true,
      botToken: '123456:fake-token',
      chatIds: ['10001', '10002'],
      fetchImpl: async (_url, options) => {
        const chatId = JSON.parse(options.body).chat_id
        calls.push(chatId)
        if (chatId === '10002' && failSecond) return { ok: false, status: 500 }
        return { ok: true, status: 200 }
      },
    },
  })

  assert.equal((await dispatcher.runOnce()).retried, 1)
  assert.deepEqual(calls, ['10001', '10002'])
  assert.deepEqual(JSON.parse(row(context.db, 'accepted').payload_json).deliveryState.deliveredChatTargets, ['10001'])
  context.advance(5_000)
  failSecond = false
  assert.equal((await dispatcher.runOnce()).delivered, 1)
  assert.deepEqual(calls, ['10001', '10002', '10002'])
  assert.deepEqual(JSON.parse(row(context.db, 'accepted').payload_json).deliveryState.deliveredChatTargets, ['10001', '10002'])
  context.close()
})

test('multi-chat timeout preserves earlier successful targets before retry', async () => {
  const context = setup()
  enqueue(context.db, 'accepted')
  const calls = []
  let blockSecond = true
  const dispatcher = createTelegramB2OutcomeDispatcher({
    db: context.db,
    ownerId: 'telegram-timeout-worker',
    now: context.now,
    leaseMs: 1_000,
    sendTimeoutMs: 10,
    telegramConfig: {
      enabled: true,
      botToken: '123456:fake-token',
      chatIds: ['10001', '10002'],
      fetchImpl: async (_url, options) => {
        const chatId = JSON.parse(options.body).chat_id
        calls.push(chatId)
        if (chatId !== '10002' || !blockSecond) return { ok: true, status: 200 }
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    },
  })

  assert.equal((await dispatcher.runOnce()).retried, 1)
  assert.deepEqual(calls, ['10001', '10002'])
  assert.deepEqual(JSON.parse(row(context.db, 'accepted').payload_json).deliveryState.deliveredChatTargets, ['10001'])
  context.advance(5_000)
  blockSecond = false
  assert.equal((await dispatcher.runOnce()).delivered, 1)
  assert.deepEqual(calls, ['10001', '10002', '10002'])
  context.close()
})
