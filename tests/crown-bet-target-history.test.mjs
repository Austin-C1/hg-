import assert from 'node:assert/strict'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'

const T0 = '2026-07-15T01:00:00.000Z'

function setup() {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const repo = createAppRepository(handle.db, { secretKey: 'bet-target-history-test-key-more-than-32-characters' })
  const db = handle.db
  db.prepare(`INSERT INTO execution_authorizations (
    authorization_id,currency,amount_scale,max_total_amount_minor,hard_cap_amount_minor,
    valid_from,expires_at,status,created_at,updated_at
  ) VALUES ('auth-history','CNY',0,10000,10000,?,'2026-07-16T01:00:00.000Z','active',?,?)`).run(T0, T0, T0)
  db.prepare(`INSERT INTO betting_accounts (
    id,label,username,currency,amount_scale,per_bet_limit_minor,stake_step_minor,created_at,updated_at
  ) VALUES ('account-history','历史账号','history-user','CNY',0,10000,1,?,?)`).run(T0, T0)
  db.prepare(`INSERT INTO betting_rules (
    id,name,currency,amount_scale,target_amount_minor,created_at,updated_at
  ) VALUES ('rule-history','历史规则','CNY',0,1000,?,?)`).run(T0, T0)
  return { handle, repo, db }
}

function selection({ mode = 'prematch', leagueName = '英超', homeTeam = '阿森纳', awayTeam = '切尔西', side = 'away', handicapRaw = '-0.5' } = {}) {
  return {
    provider: 'crown', eventKey: 'crown|football|gid=history', period: 'full_time',
    marketType: 'asian_handicap', side, handicapRaw,
    snapshot: {
      provider: 'crown', mode,
      event: { eventKey: 'crown|football|gid=history', leagueName, homeTeam, awayTeam },
      market: { period: 'full_time', marketType: 'asian_handicap', handicapRaw },
      selection: { side, odds: '0.91' },
    },
  }
}

function addSignal(db, suffix, snapshot = selection()) {
  db.prepare(`INSERT INTO monitor_signals (
    signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json
  ) VALUES (?,?,'history',1,'ready',?,'2026-07-16T01:00:00.000Z',?)`)
    .run(`signal-${suffix}`, `key-${suffix}`, T0, JSON.stringify({
      evidence: {
        league: snapshot.snapshot?.event?.leagueName,
        homeTeam: snapshot.snapshot?.event?.homeTeam,
        awayTeam: snapshot.snapshot?.event?.awayTeam,
        mode: snapshot.snapshot?.mode,
        period: snapshot.period,
        marketType: snapshot.marketType,
        handicapRaw: snapshot.handicapRaw,
      },
    }))
}

function addBatch(db, {
  suffix, createdAt = T0, status = 'completed', accepted = 0, unknown = 0,
  target = 1000, mode = 'prematch', kind = 'mode', authorized = true,
  snapshot = selection({ mode }), finishReason = 'target_filled',
}) {
  addSignal(db, suffix, snapshot)
  const common = [
    `batch-${suffix}`, `signal-${suffix}`, authorized ? 'auth-history' : null,
    snapshot.eventKey || '', JSON.stringify(snapshot), snapshot.snapshot?.event?.leagueName || '',
    '0.91', T0, 'CNY', 0, target, accepted, unknown,
    Math.max(0, target - accepted - unknown), status, finishReason, createdAt,
    ['completed', 'partial', 'failed', 'cancelled'].includes(status) ? createdAt : '',
  ]
  if (kind === 'card') {
    db.prepare(`INSERT INTO bet_batches (
      batch_id,signal_id,card_id,card_version,card_snapshot_json,rule_id,betting_mode,
      settings_version,settings_snapshot_json,authorization_id,event_key,locked_selection_identity,
      source_league,source_odds,observed_at,currency,amount_scale,target_amount_minor,
      accepted_amount_minor,unknown_amount_minor,unfilled_amount_minor,status,finish_reason,created_at,finished_at
    ) VALUES (?,?,?,1,?,NULL,?,NULL,'{}',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      common[0], common[1], `card-${suffix}`, JSON.stringify({ cardId: `card-${suffix}`, version: 1 }), mode,
      ...common.slice(2),
    )
  } else if (kind === 'legacy') {
    db.prepare(`INSERT INTO bet_batches (
      batch_id,signal_id,rule_id,betting_mode,settings_version,settings_snapshot_json,
      authorization_id,event_key,locked_selection_identity,rule_snapshot_json,source_league,source_odds,
      observed_at,currency,amount_scale,target_amount_minor,accepted_amount_minor,unknown_amount_minor,
      unfilled_amount_minor,status,finish_reason,created_at,finished_at
    ) VALUES (?,?,'rule-history',NULL,NULL,'{}',?,?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      common[0], common[1], common[2], common[3], JSON.stringify({ rule: { id: 'rule-history' }, lockedSelection: snapshot }),
      ...common.slice(5),
    )
  } else {
    db.prepare(`INSERT INTO bet_batches (
      batch_id,signal_id,rule_id,betting_mode,settings_version,settings_snapshot_json,
      authorization_id,event_key,locked_selection_identity,source_league,source_odds,observed_at,
      currency,amount_scale,target_amount_minor,accepted_amount_minor,unknown_amount_minor,
      unfilled_amount_minor,status,finish_reason,created_at,finished_at
    ) VALUES (?,?,NULL,?,1,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      common[0], common[1], mode, JSON.stringify({ mode, version: 1 }), ...common.slice(2),
    )
  }
}

function addChild(db, suffix, childSuffix, status, amount, odds) {
  db.prepare(`INSERT INTO bet_child_orders (
    child_order_id,batch_id,account_id,attempt,requested_amount_minor,preview_odds,status,created_at,resolved_at
  ) VALUES (?,?,'account-history',?,?,?, ?,?,?)`).run(
    `child-${suffix}-${childSuffix}`, `batch-${suffix}`, Number(childSuffix) + 1, amount, odds, status, T0, T0,
  )
}

function markChildDispatched(db, suffix, childSuffix, { status = 'accepted' } = {}) {
  db.prepare(`UPDATE bet_child_orders
    SET submit_dispatched_at=?, status=?, submitted_at=?, resolved_at=?
    WHERE child_order_id=?`).run(T0, status, T0, T0, `child-${suffix}-${childSuffix}`)
}

function addAttempt(db, suffix, childSuffix, { status = 'accepted', amount = 50, odds = '0.80' } = {}) {
  const childOrderId = `child-${suffix}-${childSuffix}`
  const submitAttemptId = `attempt-${suffix}-${childSuffix}`
  db.prepare(`INSERT INTO bet_submit_attempts (
    submit_attempt_id,child_order_id,authorization_id,attempt_ordinal,amount_minor,
    fencing_token,capability_version,capability_evidence_id,preview_odds,
    locked_identity_json,preview_snapshot_json,prepared_at,created_at,updated_at
  ) VALUES (?,?,NULL,1,?,1,'history-capability','history-evidence',?,'{}','{}',?,?,?)`)
    .run(submitAttemptId, childOrderId, amount, odds, T0, T0, T0)
  if (status === 'submit_prepared') return
  db.prepare(`UPDATE bet_submit_attempts
    SET status='submit_dispatched',dispatched_at=?,updated_at=?
    WHERE submit_attempt_id=?`).run(T0, T0, submitAttemptId)
  if (status !== 'submit_dispatched') {
    db.prepare(`UPDATE bet_submit_attempts
      SET status=?,result_at=?,updated_at=?
      WHERE submit_attempt_id=?`).run(status, T0, T0, submitAttemptId)
  }
}

test('bet target history returns one real batch per row and computes accepted-only weighted odds', () => {
  const { handle, repo, db } = setup()
  addBatch(db, { suffix: 'weighted', accepted: 400, unknown: 200, target: 1000, kind: 'card', status: 'partial' })
  addChild(db, 'weighted', '0', 'accepted', 100, '0.90')
  addChild(db, 'weighted', '1', 'accepted', 300, '1.10')
  addChild(db, 'weighted', '2', 'rejected', 100, '9.99')
  addChild(db, 'weighted', '3', 'unknown', 200, '8.88')
  addChild(db, 'weighted', '4', 'cancelled', 200, '7.77')
  markChildDispatched(db, 'weighted', '0')
  addBatch(db, { suffix: 'preview', accepted: 100, authorized: true })
  addChild(db, 'preview', '0', 'accepted', 100, '0.80')

  const page = repo.listBetTargetHistory({ limit: 20 })
  handle.close()

  assert.equal(page.items.length, 1)
  assert.deepEqual(page.items[0], {
    historyKey: page.items[0].historyKey,
    createdAt: T0,
    finishedAt: T0,
    match: { leagueName: '英超', homeTeam: '阿森纳', awayTeam: '切尔西' },
    direction: { mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', side: 'away', handicapRaw: '-0.5' },
    status: 'partial',
    finishReason: 'target_filled',
    acceptedBetCount: 2,
    averageAcceptedOdds: '1.05',
    completedAmount: '400',
    targetAmount: '1000',
    unknownAmount: '200',
    currency: 'CNY',
  })
  assert.match(page.items[0].historyKey, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(page)
  for (const forbidden of ['batch-weighted', 'account-history', 'child-weighted', 'providerReference', 'submitAttempt', 'ticket', 'session']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
})

test('bet target history includes dispatched acceptance batches but excludes neutral preview batches', () => {
  const { handle, repo, db } = setup()
  addBatch(db, {
    suffix: 'acceptance', accepted: 50, target: 50, authorized: false, status: 'completed',
  })
  addChild(db, 'acceptance', '0', 'accepted', 50, '0.80')
  markChildDispatched(db, 'acceptance', '0')
  addBatch(db, {
    suffix: 'preview', accepted: 50, target: 50, authorized: false, status: 'completed',
  })
  addChild(db, 'preview', '0', 'accepted', 50, '0.90')

  const campaignId = 'a'.repeat(64)
  db.prepare(`INSERT INTO crown_browser_acceptance_campaigns (
    campaign_id,schema_version,capability_version,manifest_json,manifest_hmac,status,created_at,updated_at
  ) VALUES (?,'crown-browser-api-acceptance-v1','test-capability','{}',?,'completed',?,?)`)
    .run(campaignId, 'b'.repeat(64), T0, T0)
  db.prepare(`INSERT INTO crown_browser_acceptance_cases (
    campaign_id,direction_id,case_version,ordinal,mode,period,market_type,line_variant,
    selection_side,protocol_evidence_digest,capability_evidence_id,state,child_order_id,
    account_id,submit_attempt_id,authorized_min_minor,dispatch_count,outcome,created_at,updated_at
  ) VALUES (?,'prematch-full-time-asian-handicap-away',1,1,'prematch','full_time',
    'asian_handicap','main','away','test-protocol','test-evidence','accepted',
    'child-acceptance-0','account-history','attempt-acceptance',50,1,'accepted',?,?)`)
    .run(campaignId, T0, T0)

  const page = repo.listBetTargetHistory({ limit: 20 })
  handle.close()

  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].acceptedBetCount, 1)
  assert.equal(page.items[0].completedAmount, '50')
  assert.equal(page.items[0].averageAcceptedOdds, '0.8')
})

test('bet target history includes neutral card batches only after real child dispatch', () => {
  const { handle, repo, db } = setup()
  addBatch(db, {
    suffix: 'neutral-direct', accepted: 150, unknown: 50, target: 250,
    authorized: false, kind: 'card', status: 'partial', finishReason: 'partial_capacity',
  })
  addChild(db, 'neutral-direct', '0', 'accepted', 100, '0.90')
  addChild(db, 'neutral-direct', '1', 'accepted', 50, '1.10')
  markChildDispatched(db, 'neutral-direct', '0')
  markChildDispatched(db, 'neutral-direct', '1')

  addBatch(db, {
    suffix: 'neutral-attempt', accepted: 50, target: 50,
    authorized: false, kind: 'card', status: 'completed',
  })
  addChild(db, 'neutral-attempt', '0', 'accepted', 50, '0.80')
  addAttempt(db, 'neutral-attempt', '0')

  addBatch(db, {
    suffix: 'neutral-preview', accepted: 50, target: 50,
    authorized: false, kind: 'card', status: 'completed',
  })
  addChild(db, 'neutral-preview', '0', 'accepted', 50, '9.99')
  addAttempt(db, 'neutral-preview', '0', { status: 'submit_prepared', odds: '9.99' })

  const page = repo.listBetTargetHistory({ limit: 20 })
  handle.close()

  assert.equal(page.items.length, 2)
  const partial = page.items.find((item) => item.status === 'partial')
  assert.equal(partial.acceptedBetCount, 2)
  assert.equal(partial.completedAmount, '150')
  assert.equal(partial.averageAcceptedOdds, '0.97')
  const completed = page.items.find((item) => item.status === 'completed')
  assert.equal(completed.acceptedBetCount, 1)
  assert.equal(completed.averageAcceptedOdds, '0.8')
  assert.equal(page.items.some((item) => item.averageAcceptedOdds === '9.99'), false)
})

test('bet target history paginates equal timestamps without duplicates and supports status/mode filters', () => {
  const { handle, repo, db } = setup()
  addBatch(db, { suffix: 'a', kind: 'card', mode: 'prematch', status: 'completed' })
  addBatch(db, { suffix: 'b', kind: 'mode', mode: 'live', status: 'waiting_result', finishReason: '' })
  addBatch(db, { suffix: 'c', kind: 'legacy', mode: 'prematch', status: 'failed', finishReason: 'no_capacity' })
  for (const suffix of ['a', 'b', 'c']) {
    addChild(db, suffix, '0', 'rejected', 50, '0.90')
    markChildDispatched(db, suffix, '0', { status: 'rejected' })
  }

  const first = repo.listBetTargetHistory({ limit: 2 })
  const second = repo.listBetTargetHistory({ limit: 2, cursor: first.nextCursor })
  assert.equal(first.items.length, 2)
  assert.equal(second.items.length, 1)
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.historyKey)).size, 3)
  assert.equal(second.nextCursor, null)
  assert.equal(repo.listBetTargetHistory({ status: 'waiting_result' }).items[0].direction.mode, 'live')
  assert.equal(repo.listBetTargetHistory({ status: 'active' }).items.length, 0)
  assert.equal(repo.listBetTargetHistory({ status: 'failed', mode: 'prematch' }).items.length, 1)
  handle.close()
})

test('bet target history uses legacy locked snapshot and fails closed on corrupted historical snapshot', () => {
  const { handle, repo, db } = setup()
  addBatch(db, { suffix: 'legacy', kind: 'legacy', mode: 'prematch' })
  addBatch(db, { suffix: 'damaged', kind: 'mode', mode: 'live', snapshot: { eventKey: 'internal-event' } })
  for (const suffix of ['legacy', 'damaged']) {
    addChild(db, suffix, '0', 'rejected', 50, '0.90')
    markChildDispatched(db, suffix, '0', { status: 'rejected' })
  }
  db.prepare("UPDATE bet_batches SET locked_selection_identity='not-json' WHERE batch_id='batch-damaged'").run()

  const items = repo.listBetTargetHistory({ limit: 20 }).items
  const legacy = items.find((item) => item.match.homeTeam === '阿森纳')
  const damaged = items.find((item) => item.direction.mode === 'live')
  assert.equal(legacy.direction.side, 'away')
  assert.deepEqual(damaged.match, {
    leagueName: '历史信息不可用', homeTeam: '历史信息不可用', awayTeam: '历史信息不可用',
  })
  assert.equal(damaged.direction.period, '历史信息不可用')
  assert.equal(JSON.stringify(damaged).includes('internal-event'), false)
  handle.close()
})
