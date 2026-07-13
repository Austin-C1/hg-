import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'

const NOW = new Date('2026-07-12T04:00:00.000Z')
const defaultLeagues = {
  leagues: [
    { name: '英超', enabled: true, modes: ['prematch'] },
    { name: '西甲', enabled: true, modes: ['prematch'] },
  ],
}

const validBody = {
  name: 'A',
  enabled: true,
  leagueNames: ['英超'],
  targetOddsMin: '0.123456789012345678',
  targetOddsMax: '0.123456789012345679',
  targetAmountMinor: 100,
  remark: '',
}

function createRepository() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-repo-')), 'crown.sqlite')
  const handle = openAppDatabase({ dbPath, monitorJson: null })
  const repo = createAppRepository(handle.db, { now: () => NOW })
  return { dbPath, handle, repo }
}

function seedEvent(db, { eventKey, league, active = 1 }) {
  db.prepare(`
    INSERT INTO monitor_event_state (
      event_key, match_group_key, active, missing_count, last_seen_at,
      provider_ids_json, event_json
    ) VALUES (?, ?, ?, 0, ?, '{}', ?)
  `).run(eventKey, eventKey, active, NOW.toISOString(), JSON.stringify({
    eventKey, league, mode: 'prematch', startTimeUtc: NOW.toISOString(),
  }))
}

function seedTracked(db, { eventKey, league }) {
  db.prepare(`
    INSERT INTO tracked_matches (
      event_key, league, home_team, away_team, mode, source_status,
      tracking_status, created_at, updated_at
    ) VALUES (?, ?, 'Home', 'Away', 'prematch', '', 'active', ?, ?)
  `).run(eventKey, league, NOW.toISOString(), NOW.toISOString())
}

function code(code) {
  return (error) => error?.code === code
}

test('disabled cards continue to own leagues and preserve exact decimal TEXT', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    const first = repo.createAutoBettingRuleCard(
      { ...validBody, enabled: false }, { defaultLeagues },
    )
    assert.throws(() => repo.createAutoBettingRuleCard(
      { ...validBody, name: 'B' }, { defaultLeagues },
    ), (error) => error?.code === 'league-owned-by-another-card'
      && error?.fields?.ownerName === 'A'
      && error?.fields?.leagueNames?.[0] === '英超')

    const listed = repo.listAutoBettingRuleCards().find((card) => card.cardId === first.cardId)
    assert.equal(listed.enabled, false)
    assert.equal(listed.targetOddsMin, '0.123456789012345678')
    assert.equal(listed.targetOddsMax, '0.123456789012345679')
    assert.equal(typeof handle.db.prepare(
      'SELECT target_odds_min FROM auto_betting_rule_cards WHERE card_id=?',
    ).get(first.cardId).target_odds_min, 'string')
  } finally {
    handle.close()
  }
})

test('card list returns isolated bounded recent summaries and null when no history exists', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    seedEvent(handle.db, { eventKey: 'spanish', league: '西甲' })
    const first = repo.createAutoBettingRuleCard(validBody, { defaultLeagues })
    const second = repo.createAutoBettingRuleCard({ ...validBody, name: 'B', leagueNames: ['西甲'] }, { defaultLeagues })
    assert.deepEqual(repo.listAutoBettingRuleCards()
      .filter((card) => [first.cardId, second.cardId].includes(card.cardId))
      .map(({ recentSignal, recentBatch, recentResult }) => ({ recentSignal, recentBatch, recentResult })), [
      { recentSignal: null, recentBatch: null, recentResult: null },
      { recentSignal: null, recentBatch: null, recentResult: null },
    ])

    handle.db.prepare(`INSERT INTO betting_accounts
      (id,label,username,status,allocation_status,per_bet_limit_minor,currency,amount_scale,stake_step_minor,created_at,updated_at)
      VALUES ('summary-account','Summary','summary','enabled','enabled',100,'CNY',0,1,?,?)`).run(NOW.toISOString(), NOW.toISOString())
    const seedSignal = (signalId, card, status, observedAt) => {
      handle.db.prepare(`INSERT INTO monitor_signals
        (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json)
        VALUES (?,?,?,1,?,?,?,?)`).run(signalId, signalId, 'safe', status, observedAt, observedAt,
          JSON.stringify({ providerToken: 'must-not-leak', raw: 'secret-raw' }))
      handle.db.prepare(`INSERT INTO auto_betting_signal_inbox
        (signal_id,card_id,card_version,card_snapshot_json,mode,settings_version,settings_snapshot_json,status,
         next_attempt_at,lease_owner,lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,'prematch',?,?,'skipped','', '', '',?,?)`).run(
        signalId, card.cardId, card.version, JSON.stringify(card), card.version, JSON.stringify(card), observedAt, observedAt)
    }
    seedSignal('signal-old', first, 'ready', '2026-07-12T00:00:00.000Z')
    seedSignal('signal-new', first, 'expired', '2026-07-12T00:01:00.000Z')
    seedSignal('signal-other', second, 'ready', '2026-07-12T00:02:00.000Z')
    const seedBatch = (batchId, signalId, card, status, createdAt) => handle.db.prepare(`INSERT INTO bet_batches
      (batch_id,signal_id,card_id,card_version,card_snapshot_json,betting_mode,settings_snapshot_json,
       currency,amount_scale,target_amount_minor,status,created_at)
      VALUES (?,?,?,?,?,'prematch','{}','CNY',0,100,?,?)`).run(
      batchId, signalId, card.cardId, card.version, JSON.stringify(card), status, createdAt)
    seedBatch('batch-old', 'signal-old', first, 'queued', '2026-07-12T00:03:00.000Z')
    seedBatch('batch-new', 'signal-new', first, 'completed', '2026-07-12T00:04:00.000Z')
    seedBatch('batch-other', 'signal-other', second, 'failed', '2026-07-12T00:05:00.000Z')
    handle.db.prepare(`INSERT INTO bet_child_orders
      (child_order_id,batch_id,account_id,attempt,requested_amount_minor,status,error_message,created_at,resolved_at)
      VALUES ('child-first','batch-new','summary-account',1,100,'rejected','provider secret','2026-07-12T00:04:00.000Z','2026-07-12T00:06:00.000Z'),
             ('child-latest','batch-new','summary-account',2,100,'accepted','raw response','2026-07-12T00:04:01.000Z','2026-07-12T00:07:00.000Z')`).run()

    const listed = repo.listAutoBettingRuleCards()
    const a = listed.find((card) => card.cardId === first.cardId)
    const b = listed.find((card) => card.cardId === second.cardId)
    assert.deepEqual({ recentSignal: a.recentSignal, recentBatch: a.recentBatch, recentResult: a.recentResult }, {
      recentSignal: 'Signal：已过期', recentBatch: '批次：已完成', recentResult: '结果：已接受',
    })
    assert.deepEqual({ recentSignal: b.recentSignal, recentBatch: b.recentBatch, recentResult: b.recentResult }, {
      recentSignal: 'Signal：待处理', recentBatch: '批次：失败', recentResult: null,
    })
    assert.doesNotMatch(JSON.stringify(listed), /must-not-leak|secret-raw|provider secret|raw response/)
    assert.equal([a.recentSignal, a.recentBatch, a.recentResult].every((value) => value.length <= 32), true)

    repo.deleteAutoBettingRuleCard(first.cardId, { expectedVersion: first.version })
    assert.equal(repo.listAutoBettingRuleCards().some((card) => card.cardId === first.cardId), false)
  } finally {
    handle.close()
  }
})

test('today league list reports current ownership without releasing disabled cards', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    seedEvent(handle.db, { eventKey: 'spanish', league: '西甲' })
    const card = repo.createAutoBettingRuleCard({ ...validBody, enabled: false }, { defaultLeagues })
    const leagues = repo.listTodayBettingLeagues(card.cardId, { defaultLeagues })
    const english = leagues.find((item) => item.leagueName === '英超')
    const spanish = leagues.find((item) => item.leagueName === '西甲')
    assert.deepEqual({
      ownerCardId: english.ownerCardId,
      ownerCardName: english.ownerCardName,
      selectable: english.selectable,
      availableToday: english.availableToday,
    }, {
      ownerCardId: card.cardId, ownerCardName: 'A', selectable: true, availableToday: true,
    })
    assert.deepEqual({
      ownerCardId: spanish.ownerCardId,
      ownerCardName: spanish.ownerCardName,
      selectable: spanish.selectable,
      availableToday: spanish.availableToday,
    }, {
      ownerCardId: null, ownerCardName: null, selectable: true, availableToday: true,
    })
  } finally {
    handle.close()
  }
})

test('today league list restores only the current card own stale leagues', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    seedEvent(handle.db, { eventKey: 'spanish', league: '西甲' })
    const current = repo.createAutoBettingRuleCard(validBody, { defaultLeagues })
    repo.createAutoBettingRuleCard({ ...validBody, name: 'B', leagueNames: ['西甲'] }, { defaultLeagues })
    handle.db.prepare('UPDATE monitor_event_state SET active=0').run()

    assert.deepEqual(repo.listTodayBettingLeagues(current.cardId, { defaultLeagues }), [{
      leagueName: '英超',
      source: 'stale',
      todayMatchCount: 0,
      ownerCardId: current.cardId,
      ownerCardName: 'A',
      selectable: true,
      availableToday: false,
    }])
  } finally {
    handle.close()
  }
})

test('manual-origin league becomes an explicit stale source when no longer available today', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'manual-event', league: '友谊赛' })
    seedTracked(handle.db, { eventKey: 'manual-event', league: '友谊赛' })
    const card = repo.createAutoBettingRuleCard({
      ...validBody,
      leagueNames: ['友谊赛'],
    }, { defaultLeagues })
    handle.db.prepare("UPDATE monitor_event_state SET active=0 WHERE event_key='manual-event'").run()

    assert.deepEqual(repo.listTodayBettingLeagues(card.cardId, { defaultLeagues }), [{
      leagueName: '友谊赛',
      source: 'stale',
      todayMatchCount: 0,
      ownerCardId: card.cardId,
      ownerCardName: 'A',
      selectable: true,
      availableToday: false,
    }])
  } finally {
    handle.close()
  }
})

test('update keeps own stale leagues but cannot add another stale league', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    const card = repo.createAutoBettingRuleCard(validBody, { defaultLeagues })
    handle.db.prepare('UPDATE monitor_event_state SET active=0').run()

    const updated = repo.updateAutoBettingRuleCard(card.cardId, {
      ...validBody, name: 'A2', expectedVersion: card.version,
    }, { defaultLeagues })
    assert.deepEqual(updated.leagueNames, ['英超'])
    assert.equal(updated.version, card.version + 1)

    assert.throws(() => repo.updateAutoBettingRuleCard(card.cardId, {
      ...validBody,
      name: 'A3',
      expectedVersion: updated.version,
      leagueNames: ['英超', '昨日联赛'],
    }, { defaultLeagues }), code('league-not-available-today'))
    assert.equal(repo.listAutoBettingRuleCards().find((item) => item.cardId === card.cardId).version, updated.version)
  } finally {
    handle.close()
  }
})

test('failed update rolls back card values, version, and original league ownership', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    seedEvent(handle.db, { eventKey: 'spanish', league: '西甲' })
    const first = repo.createAutoBettingRuleCard(validBody, { defaultLeagues })
    repo.createAutoBettingRuleCard({ ...validBody, name: 'B', leagueNames: ['西甲'] }, { defaultLeagues })

    assert.throws(() => repo.updateAutoBettingRuleCard(first.cardId, {
      ...validBody, name: 'BROKEN', leagueNames: ['西甲'], expectedVersion: first.version,
    }, { defaultLeagues }), code('league-owned-by-another-card'))

    const after = repo.listAutoBettingRuleCards().find((item) => item.cardId === first.cardId)
    assert.equal(after.name, 'A')
    assert.equal(after.version, first.version)
    assert.deepEqual(after.leagueNames, ['英超'])
    assert.throws(() => repo.createAutoBettingRuleCard(
      { ...validBody, name: 'C' }, { defaultLeagues },
    ), code('league-owned-by-another-card'))
  } finally {
    handle.close()
  }
})

test('update rejects stale expectedVersion without changing the card', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    const card = repo.createAutoBettingRuleCard(validBody, { defaultLeagues })
    assert.throws(() => repo.updateAutoBettingRuleCard(card.cardId, {
      ...validBody, name: 'stale', expectedVersion: card.version + 1,
    }, { defaultLeagues }), code('auto-betting-card-version-conflict'))
    const after = repo.listAutoBettingRuleCards().find((item) => item.cardId === card.cardId)
    assert.equal(after.name, 'A')
    assert.equal(after.version, card.version)
  } finally {
    handle.close()
  }
})

test('non-UNIQUE league insert constraints are not mapped to ownership conflicts', () => {
  const { handle, repo } = createRepository()
  try {
    seedEvent(handle.db, { eventKey: 'english', league: '英超' })
    const before = handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_cards').get().count
    handle.db.exec(`
      CREATE TRIGGER reject_rule_card_league
      BEFORE INSERT ON auto_betting_rule_card_leagues
      BEGIN
        SELECT RAISE(ABORT, 'auto_betting_rule_card_leagues.league_name synthetic trigger failure');
      END
    `)

    assert.throws(() => repo.createAutoBettingRuleCard(validBody, { defaultLeagues }), (error) => (
      error?.code !== 'league-owned-by-another-card'
      && String(error?.message).includes('synthetic trigger failure')
    ))
    assert.equal(handle.db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_cards').get().count, before)
  } finally {
    handle.close()
  }
})

test('two database connections racing for one league produce exactly one owner', async () => {
  const { dbPath, handle } = createRepository()
  seedEvent(handle.db, { eventKey: 'english', league: '英超' })
  handle.close()

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const source = `
    import { workerData, parentPort } from 'node:worker_threads'
    const { openRuntimeDatabase } = await import(workerData.dbModule)
    const { createAppRepository } = await import(workerData.repoModule)
    const gate = new Int32Array(workerData.shared)
    const handle = openRuntimeDatabase({ dbPath: workerData.dbPath })
    const repo = createAppRepository(handle.db, { now: () => new Date(workerData.now) })
    Atomics.add(gate, 0, 1)
    parentPort.postMessage({ type: 'ready' })
    Atomics.wait(gate, 1, 0)
    let result
    try {
      const card = repo.createAutoBettingRuleCard(workerData.body, { defaultLeagues: workerData.defaultLeagues })
      result = { ok: true, cardId: card.cardId }
    } catch (error) {
      result = { ok: false, code: error.code || error.message }
    } finally {
      handle.close()
    }
    parentPort.postMessage({ type: 'result', result })
    parentPort.close()
  `
  const workerData = {
    dbPath,
    shared,
    now: NOW.toISOString(),
    defaultLeagues,
    dbModule: pathToFileURL(path.resolve('src/crown/app/app-db.mjs')).href,
    repoModule: pathToFileURL(path.resolve('src/crown/app/app-repository.mjs')).href,
  }
  const spawn = (name) => {
    let result
    let readyResolve
    const ready = new Promise((resolve) => { readyResolve = resolve })
    let resultResolve
    let resultReject
    const completed = new Promise((resolve, reject) => {
      resultResolve = resolve
      resultReject = reject
    })
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      type: 'module', workerData: { ...workerData, body: { ...validBody, name } },
    })
    worker.on('message', (message) => {
      if (message.type === 'ready') readyResolve()
      if (message.type === 'result') result = message.result
    })
    worker.once('error', resultReject)
    worker.once('exit', (exitCode) => {
      if (exitCode !== 0) resultReject(new Error(`worker-exit:${exitCode}`))
      else resultResolve(result)
    })
    return { ready, completed }
  }
  const first = spawn('A')
  await first.ready
  const second = spawn('B')
  await second.ready
  const gate = new Int32Array(shared)
  Atomics.store(gate, 1, 1)
  Atomics.notify(gate, 1, 2)
  const results = await Promise.all([first.completed, second.completed])

  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.code), [
    'league-owned-by-another-card',
  ])
  const verify = openAppDatabase({ dbPath, monitorJson: null })
  try {
    assert.equal(verify.db.prepare(
      "SELECT COUNT(*) count FROM auto_betting_rule_card_leagues WHERE league_name='英超'",
    ).get().count, 1)
  } finally {
    verify.close()
  }
})
