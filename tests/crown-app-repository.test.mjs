import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'

function createRepository(options = {}) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-repo-')), 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  return { handle, repo: createAppRepository(handle.db, { secretKey: 'repo-secret-key-with-more-than-32-characters', ...options }) }
}

function seedAcceptedTodayLedger(db) {
  const createdAt = '2026-07-11T00:00:00.000Z'
  db.prepare("INSERT INTO betting_rules (id, name, currency, amount_scale, target_amount_minor, created_at, updated_at) VALUES ('rule-stats', 'Stats rule', 'CNY', 2, 100, ?, ?)").run(createdAt, createdAt)
  db.prepare("INSERT INTO betting_accounts (id, label, username, currency, amount_scale, per_bet_limit_minor, stake_step_minor, created_at, updated_at) VALUES ('account-stats', 'Stats account', 'stats-user', 'CNY', 2, 100, 1, ?, ?)").run(createdAt, createdAt)

  const addChild = (suffix, { status = 'accepted', resolvedAt, minor = 100 }) => {
    db.prepare('INSERT INTO monitor_signals (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
      .run(`signal-stats-${suffix}`, `key-stats-${suffix}`, 'strategy', 'ready', createdAt, '2026-07-20T00:00:00.000Z', '{}')
    db.prepare(`
      INSERT INTO bet_batches (
        batch_id, signal_id, rule_id, currency, amount_scale, target_amount_minor,
        accepted_amount_minor, status, finish_reason, created_at, finished_at
      ) VALUES (?, ?, 'rule-stats', 'CNY', 2, ?, ?, 'completed', 'target_filled', ?, ?)
    `).run(`batch-stats-${suffix}`, `signal-stats-${suffix}`, minor, status === 'accepted' ? minor : 0, createdAt, resolvedAt)
    db.prepare(`
      INSERT INTO bet_child_orders (
        child_order_id, batch_id, account_id, requested_amount_minor, status, created_at, resolved_at
      ) VALUES (?, ?, 'account-stats', ?, ?, ?, ?)
    `).run(`child-stats-${suffix}`, `batch-stats-${suffix}`, minor, status, createdAt, resolvedAt)
  }

  for (let index = 0; index < 55; index += 1) {
    addChild(`inside-${index}`, { resolvedAt: '2026-07-11T16:05:00.000Z' })
  }
  addChild('start-inclusive', { resolvedAt: '2026-07-11T16:00:00.000Z', minor: 200 })
  addChild('end-inclusive', { resolvedAt: '2026-07-12T15:59:59.999Z', minor: 300 })
  addChild('before-day', { resolvedAt: '2026-07-11T15:59:59.999Z', minor: 400 })
  addChild('after-day', { resolvedAt: '2026-07-12T16:00:00.000Z', minor: 500 })
  addChild('rejected', { status: 'rejected', resolvedAt: '2026-07-11T16:10:00.000Z', minor: 99900 })
  addChild('big-a', { resolvedAt: '2026-07-11T17:00:00.000Z', minor: 9007199254740000 })
  addChild('big-b', { resolvedAt: '2026-07-11T18:00:00.000Z', minor: 9007199254740000 })
}

function seedBatchProjection(db) {
  const now = '2026-07-11T02:00:00.000Z'
  db.prepare(`
    INSERT INTO betting_rules (
      id, name, currency, amount_scale, target_amount_minor, created_at, updated_at
    ) VALUES ('rule-projection', 'Projection rule', 'CNY', 2, 12345, ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO monitor_signals (
      signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json
    ) VALUES ('signal-projection', 'key-projection', 'strategy', 1, 'ready', ?, ?, '{}')
  `).run(now, '2026-07-11T02:05:00.000Z')
  db.prepare(`
    INSERT INTO betting_accounts (
      id, label, username, currency, amount_scale, per_bet_limit_minor, stake_step_minor, created_at, updated_at
    ) VALUES ('account-projection', 'Projection account', 'projection-user', 'CNY', 2, 10000, 50, ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO bet_batches (
      batch_id, signal_id, rule_id, event_key, locked_selection_identity, rule_version,
      source_league, source_odds, observed_at, currency, amount_scale,
      target_amount_minor, reserved_amount_minor, accepted_amount_minor,
      unknown_amount_minor, unfilled_amount_minor, status, finish_reason, created_at, finished_at
    ) VALUES (
      'batch-projection', 'signal-projection', 'rule-projection', 'event-1', 'selection-1', 3,
      '英超', '0.91', ?, 'CNY', 2,
      12345, 0, 10000, 0, 2345, 'partial', 'manual_cancel', ?, ?
    )
  `).run(now, now, '2026-07-11T02:02:00.000Z')
  db.prepare(`
    INSERT INTO bet_child_orders (
      child_order_id, batch_id, account_id, attempt, requested_amount_minor,
      preview_min_stake_minor, preview_max_stake_minor, preview_balance_minor,
      preview_stake_step_minor, preview_odds, provider_reference_ciphertext,
      submit_attempt_id, status, created_at, submitted_at, resolved_at
    ) VALUES (
      'child-projection', 'batch-projection', 'account-projection', 1, 10000,
      100, 10000, 20000, 50, '0.88', 'secret-provider-reference',
      'attempt-1', 'accepted', ?, ?, ?
    )
  `).run(now, '2026-07-11T02:01:00.000Z', '2026-07-11T02:02:00.000Z')
}

test('repository tracks and untracks matches with persisted status', () => {
  const { handle, repo } = createRepository()

  const item = repo.trackMatch({
    eventKey: 'crown|英超|主队|客队|prematch',
    league: '英超',
    homeTeam: '主队',
    awayTeam: '客队',
    mode: 'prematch',
    sourceStatus: 'open',
  })
  assert.equal(item.trackingStatus, 'active')

  const inactive = repo.untrackMatch('crown|英超|主队|客队|prematch')
  assert.equal(inactive.trackingStatus, 'inactive')

  const bootstrap = repo.bootstrap()
  handle.close()

  assert.equal(bootstrap.trackedMatches.length, 1)
  assert.equal(bootstrap.trackedMatches[0].trackingStatus, 'inactive')
})

test('repository stores monitor accounts encrypted and returns only hasSecret', () => {
  const { handle, repo } = createRepository()

  const created = repo.createMonitorAccount({
    label: '主监控账号',
    username: 'monitor-user',
    loginUrl: 'https://monitor.example.com',
    status: 'enabled',
    secret: 'monitor-password',
    notes: '本地测试',
  })
  assert.equal(created.hasSecret, true)
  assert.equal(Object.hasOwn(created, 'secret'), false)
  assert.equal(Object.hasOwn(created, 'secret_ciphertext'), false)

  const rows = repo.listMonitorAccounts()
  handle.close()

  assert.equal(rows.length, 1)
  assert.equal(rows[0].hasSecret, true)
  assert.equal(rows[0].username, 'monitor-user')
})

test('repository requires an exact public HTTPS monitor origin and exposes a password-free manual-login owner', () => {
  const { handle, repo } = createRepository()
  assert.throws(() => repo.createMonitorAccount({
    label: 'invalid', username: 'monitor-user', loginUrl: 'https://monitor.example.com/login', secret: 'password',
  }), /validation-error/)
  const created = repo.createMonitorAccount({
    label: 'valid', username: 'monitor-user', loginUrl: 'https://monitor.example.com', secret: 'password',
  })

  const owner = repo.getMonitorAccountForManualLogin(created.id)
  handle.close()
  assert.deepEqual(owner, {
    id: created.id,
    accountId: created.id,
    username: 'monitor-user',
    loginUrl: 'https://monitor.example.com',
  })
  assert.doesNotMatch(JSON.stringify(owner), /password|secret|cipher/i)
})

test('repository stores and exposes monitor account LoginResult', () => {
  const { handle, repo } = createRepository()

  repo.savePrimaryMonitorAccount({
    label: '主监控账号',
    username: 'monitor-user',
    loginUrl: 'https://monitor.example.com',
    enabled: true,
    secret: 'monitor-password',
  })

  const result = repo.updateMonitorAccountLoginResult('mon_primary', {
    ok: true,
    accountId: 'mon_primary',
    status: '已登录',
    loginMethod: 'cookies',
    cookieStatus: '已加载',
    storageStateStatus: '已加载',
    xmlVerified: true,
    sessionVerified: true,
    diagnosticPath: '',
    startedAt: '2026-07-09T00:00:00.000Z',
    finishedAt: '2026-07-09T00:00:02.000Z',
    message: '',
  })
  const account = repo.getPrimaryMonitorAccount()
  handle.close()

  assert.equal(result.lastLoginResult.status, '已登录')
  assert.equal(account.lastLoginResult.loginMethod, 'cookies')
  assert.equal(account.lastLoginResultAt, '2026-07-09T00:00:02.000Z')
  assert.equal(account.loginStatus, '已登录')
  assert.equal(account.consecutiveFailures, 0)
})

test('repository clears stale diagnostics after a successful monitor account login', () => {
  const { handle, repo } = createRepository()

  repo.savePrimaryMonitorAccount({
    label: '主监控账号',
    username: 'monitor-user',
    loginUrl: 'https://monitor.example.com',
    enabled: true,
    secret: 'monitor-password',
  })
  repo.updateMonitorAccountLoginResult('mon_primary', {
    ok: false,
    accountId: 'mon_primary',
    status: '登录失效',
    loginMethod: '接口登录',
    cookieStatus: '不存在',
    storageStateStatus: '不适用',
    xmlVerified: false,
    sessionVerified: false,
    diagnosticPath: 'data/runtime/login-diagnostics/old-failure',
    startedAt: '2026-07-09T00:00:00.000Z',
    finishedAt: '2026-07-09T00:00:02.000Z',
    message: 'failed',
  })

  const account = repo.updateMonitorAccountLoginResult('mon_primary', {
    ok: true,
    accountId: 'mon_primary',
    status: '已登录',
    loginMethod: '接口登录',
    cookieStatus: '已保存',
    storageStateStatus: '不适用',
    xmlVerified: true,
    sessionVerified: true,
    diagnosticPath: '',
    startedAt: '2026-07-09T00:00:03.000Z',
    finishedAt: '2026-07-09T00:00:04.000Z',
    message: '',
  })
  handle.close()

  assert.equal(account.lastLoginDiagnosticsPath, null)
  assert.equal(account.lastLoginResult.diagnosticPath, '')
})

test('repository atomically owns exact leagues and keeps aliases independent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-rule-conflict-'))
  const dbPath = path.join(dir, 'crown.sqlite')
  const first = openAppDatabase({ dbPath })
  const second = openAppDatabase({ dbPath })
  const firstRepo = createAppRepository(first.db)
  const secondRepo = createAppRepository(second.db)
  const base = { targetAmount: '100.00', currency: 'CNY', amountScale: 2, direction: 'up_reverse' }

  const owner = firstRepo.createBettingRule({ ...base, name: '英超 A', enabled: true, leagueNames: [' 英超 '] })
  assert.throws(
    () => secondRepo.createBettingRule({ ...base, name: '英超 B', enabled: true, leagueNames: ['英超'] }),
    (error) => {
      assert.equal(error.code, 'betting-rule-conflict')
      assert.deepEqual(error.conflict, { leagueName: '英超', ruleId: owner.id, ruleName: '英超 A' })
      return true
    },
  )
  const alias = secondRepo.createBettingRule({ ...base, name: '英超别名', enabled: true, leagueNames: ['英格兰超级联赛'] })

  first.close()
  second.close()
  assert.deepEqual(alias.leagueNames, ['英格兰超级联赛'])
})

test('canonical auto-bet repository uses CAS and keeps monitor and real switches separate', () => {
  const { handle, repo } = createRepository()
  const created = repo.createAutoBetRule({
    name: 'canonical', mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home',
    minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100,
    leagueNames: ['英超'], startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5,
  })
  assert.equal(created.version, 1)
  assert.throws(
    () => repo.updateAutoBetRule(created.id, { expectedVersion: 2, name: 'stale' }),
    (error) => error.code === 'auto-bet-rule-version-conflict',
  )
  const monitor = repo.setAutoBetRuleMonitorEnabled(created.id, true, { expectedVersion: 1 })
  assert.equal(monitor.monitorEnabled, true)
  assert.equal(monitor.realBettingEnabled, false)
  const real = repo.setAutoBetRuleRealEnabled(created.id, true, { expectedVersion: 2 })
  assert.equal(real.monitorEnabled, true)
  assert.equal(real.realBettingEnabled, true)
  handle.close()
})

test('canonical create persists requested monitor and real switches and rejects an impossible real-only rule', () => {
  const { handle, repo } = createRepository()
  const base = {
    name: 'create switches', mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home',
    minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100,
    leagueNames: ['英超'], startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5,
  }
  const created = repo.createAutoBetRule({ ...base, monitorEnabled: true, realBettingEnabled: true })
  assert.equal(created.monitorEnabled, true)
  assert.equal(created.realBettingEnabled, true)
  assert.equal(created.version, 1)
  assert.deepEqual(repo.listAutoBetRules().find((item) => item.id === created.id), created)
  assert.throws(
    () => repo.createAutoBetRule({ ...base, name: 'invalid real only', monitorEnabled: false, realBettingEnabled: true }),
    (error) => error.code === 'validation-error' && error.fields?.monitorEnabled === 'real betting requires monitor enabled',
  )
  handle.close()
})

test('canonical repository rejects unknown fields and clone requires CAS', () => {
  const { handle, repo } = createRepository()
  const base = { name: 'strict', mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home', minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100, leagueNames: ['A'], startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5 }
  assert.throws(() => repo.createAutoBetRule({ ...base, typoField: true }), /validation-error/)
  const created = repo.createAutoBetRule(base)
  assert.throws(() => repo.updateAutoBetRule(created.id, { expectedVersion: 1, typoField: true }), /validation-error/)
  assert.throws(() => repo.cloneAutoBetRule(created.id, { expectedVersion: 1, secret: 'x' }), /validation-error/)
  assert.throws(() => repo.cloneAutoBetRule(created.id, {}), /validation-error/)
  assert.throws(() => repo.cloneAutoBetRule(created.id, { expectedVersion: 9 }), (error) => error.code === 'auto-bet-rule-version-conflict')
  assert.throws(() => repo.setAutoBetRuleMonitorEnabled(created.id, true, { expectedVersion: 1, extra: true }), /validation-error/)
  assert.throws(() => repo.archiveAutoBetRule(created.id, { expectedVersion: 1, authorization: 'x' }), /validation-error/)
  assert.throws(() => repo.reorderAutoBetRules({ items: [], extra: true }), /validation-error/)
  assert.throws(() => repo.reorderAutoBetRules({ items: [{ id: created.id, expectedVersion: 1, bettingRuleId: 'x' }] }), /validation-error/)
  handle.close()
})

test('canonical create and clone append after max priority despite archived gaps', () => {
  const { handle, repo } = createRepository()
  const initial = repo.listAutoBetRules().filter((item) => !item.archived)
  repo.reorderAutoBetRules({ items: initial.map((item) => ({ id: item.id, expectedVersion: item.version })) })
  const base = { mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home', minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100, startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5 }
  const a = repo.createAutoBetRule({ ...base, name: 'A', leagueNames: ['A'] })
  const b = repo.createAutoBetRule({ ...base, name: 'B', leagueNames: ['B'] })
  const c = repo.createAutoBetRule({ ...base, name: 'C', leagueNames: ['C'] })
  repo.archiveAutoBetRule(b.id, { expectedVersion: b.version })
  const created = repo.createAutoBetRule({ ...base, name: 'D', leagueNames: ['D'] })
  assert.equal(created.priority, c.priority + 1)
  repo.archiveAutoBetRule(c.id, { expectedVersion: c.version })
  const cloned = repo.cloneAutoBetRule(a.id, { expectedVersion: a.version })
  assert.equal(cloned.priority, created.priority + 1)
  const priorities = repo.listAutoBetRules().filter((item) => !item.archived).map((item) => item.priority)
  assert.equal(new Set(priorities).size, priorities.length)
  handle.close()
})

test('canonical archive is idempotent at current version but stale replay conflicts', () => {
  const { handle, repo } = createRepository()
  const created = repo.createAutoBetRule({ name: 'archive', mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home', minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100, leagueNames: ['A'], startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5 })
  const archived = repo.archiveAutoBetRule(created.id, { expectedVersion: created.version })
  const replay = repo.archiveAutoBetRule(created.id, { expectedVersion: archived.version })
  assert.deepEqual(replay, archived)
  assert.throws(() => repo.archiveAutoBetRule(created.id, { expectedVersion: created.version }), (error) => error.code === 'auto-bet-rule-version-conflict')
  const active = repo.listAutoBetRules().filter((item) => !item.archived).map((item) => ({ id: item.id, expectedVersion: item.version }))
  active[0] = { id: archived.id, expectedVersion: archived.version }
  assert.throws(() => repo.reorderAutoBetRules({ items: active }), /validation-error/)
  handle.close()
})

test('canonical auto-bet reorder is all-or-nothing and normalizes active priorities', () => {
  const { handle, repo } = createRepository()
  const templates = repo.listAutoBetRules().filter((item) => !item.archived)
  const base = { mode: 'prematch', period: 'full', marketType: 'asian_handicap', monitoredSide: 'home', minWaterRise: '0.03', targetOddsMin: '0.80', targetOddsMax: '1.10', targetAmountMinor: 100, startMinutesBeforeKickoff: 60, stopMinutesBeforeKickoff: 5 }
  const a = repo.createAutoBetRule({ ...base, name: 'A', leagueNames: ['A'] })
  const b = repo.createAutoBetRule({ ...base, name: 'B', leagueNames: ['B'] })
  const c = repo.createAutoBetRule({ ...base, name: 'C', leagueNames: ['C'] })
  const ordered = [
    { id: c.id, expectedVersion: c.version },
    { id: a.id, expectedVersion: a.version },
    { id: b.id, expectedVersion: b.version },
    ...templates.map((item) => ({ id: item.id, expectedVersion: item.version })),
  ]
  const result = repo.reorderAutoBetRules({ items: ordered })
  assert.deepEqual(result.map((item) => item.priority), [1, 2, 3, 4, 5])
  const originalById = new Map([c, a, b, ...templates].map((item) => [item.id, item]))
  assert.ok(result.every((item, index) => item.version === ordered[index].expectedVersion + (originalById.get(item.id).priority === index + 1 ? 0 : 1)))
  const noOp = repo.reorderAutoBetRules({ items: result.map((item) => ({ id: item.id, expectedVersion: item.version })) })
  assert.deepEqual(noOp.map((item) => item.version), result.map((item) => item.version))
  const partialOrder = [noOp[1], noOp[0], ...noOp.slice(2)].map((item) => ({ id: item.id, expectedVersion: item.version }))
  const partial = repo.reorderAutoBetRules({ items: partialOrder })
  assert.equal(partial[0].version, noOp[1].version + 1)
  assert.equal(partial[1].version, noOp[0].version + 1)
  assert.deepEqual(partial.slice(2).map((item) => item.version), noOp.slice(2).map((item) => item.version))
  const duplicate = partial.map((item) => ({ id: item.id, expectedVersion: item.version }))
  duplicate[1] = { ...duplicate[0] }
  assert.throws(() => repo.reorderAutoBetRules({ items: duplicate }), /validation-error/)
  assert.throws(() => repo.reorderAutoBetRules({ items: duplicate.slice(1) }), /validation-error/)
  const unknown = partial.map((item) => ({ id: item.id, expectedVersion: item.version }))
  unknown[0] = { id: 'unknown-rule', expectedVersion: 1 }
  assert.throws(() => repo.reorderAutoBetRules({ items: unknown }), /validation-error/)
  assert.deepEqual(repo.listAutoBetRules().filter((item) => !item.archived).map((item) => item.priority), [1, 2, 3, 4, 5])
  handle.close()
})

test('two repository handles allow only one reorder commit from the same version snapshot', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-auto-reorder-race-')), 'crown.sqlite')
  const first = openAppDatabase({ dbPath })
  const second = openAppDatabase({ dbPath })
  const firstRepo = createAppRepository(first.db)
  const secondRepo = createAppRepository(second.db)
  const snapshot = firstRepo.listAutoBetRules().filter((item) => !item.archived)
  const firstOrder = [...snapshot].reverse().map((item) => ({ id: item.id, expectedVersion: item.version }))
  const secondOrder = [...snapshot.slice(1), snapshot[0]].map((item) => ({ id: item.id, expectedVersion: item.version }))
  firstRepo.reorderAutoBetRules({ items: firstOrder })
  assert.throws(() => secondRepo.reorderAutoBetRules({ items: secondOrder }), (error) => error.code === 'auto-bet-rule-version-conflict')
  const final = secondRepo.listAutoBetRules().filter((item) => !item.archived)
  assert.deepEqual(final.map((item) => item.priority), [1, 2])
  assert.equal(new Set(final.map((item) => item.priority)).size, final.length)
  first.close()
  second.close()
})

test('disabled betting rules persist configured leagues without retaining active ownership', () => {
  const { handle, repo } = createRepository()
  const base = { targetAmount: '100.00', currency: 'CNY', amountScale: 2, direction: 'up_reverse' }

  const disabled = repo.createBettingRule({ ...base, name: '停用规则', enabled: false, leagueNames: ['A'] })
  assert.deepEqual(disabled.leagueNames, ['A'])
  assert.equal(handle.db.prepare('SELECT COUNT(*) AS count FROM betting_rule_leagues WHERE rule_id = ?').get(disabled.id).count, 0)

  const updated = repo.updateBettingRule(disabled.id, { leagueNames: ['B'] })
  assert.deepEqual(updated.leagueNames, ['B'])
  assert.equal(updated.version, 2)

  const active = repo.createBettingRule({ ...base, name: '启用规则', enabled: true, leagueNames: ['A'] })
  assert.deepEqual(active.leagueNames, ['A'])
  assert.deepEqual(repo.listBettingRules().find((rule) => rule.id === disabled.id).leagueNames, ['B'])
  handle.close()
})

test('re-enabling a betting rule uses its latest configured leagues and rejects conflicts atomically', () => {
  const { handle, repo } = createRepository()
  const base = { targetAmount: '100.00', currency: 'CNY', amountScale: 2, direction: 'up_reverse' }
  const disabled = repo.createBettingRule({ ...base, name: '停用规则', enabled: false, leagueNames: ['A'] })
  repo.updateBettingRule(disabled.id, { leagueNames: ['B'] })
  const owner = repo.createBettingRule({ ...base, name: 'B 所有者', enabled: true, leagueNames: ['B'] })

  assert.throws(() => repo.updateBettingRule(disabled.id, { enabled: true }), /betting-rule-conflict/)
  const afterConflict = repo.listBettingRules().find((rule) => rule.id === disabled.id)
  assert.equal(afterConflict.enabled, false)
  assert.deepEqual(afterConflict.leagueNames, ['B'])
  assert.equal(afterConflict.version, 2)
  assert.equal(handle.db.prepare('SELECT rule_id FROM betting_rule_leagues WHERE league_name = ?').get('B').rule_id, owner.id)

  repo.updateBettingRule(owner.id, { enabled: false })
  const reopened = repo.updateBettingRule(disabled.id, { enabled: true })
  assert.equal(reopened.enabled, true)
  assert.deepEqual(reopened.leagueNames, ['B'])
  assert.equal(reopened.version, 3)
  assert.equal(handle.db.prepare('SELECT rule_id FROM betting_rule_leagues WHERE league_name = ?').get('B').rule_id, disabled.id)
  handle.close()
})

test('repository versions execution changes and downgrades every changed real-eligible contract', () => {
  const { handle, repo } = createRepository()
  const created = repo.createBettingRule({
    name: '安全规则', enabled: true, leagueNames: ['英超'], targetAmount: '100.00',
    currency: 'CNY', amountScale: 2, changedOddsMin: 0.8, changedOddsMax: 1.1,
  })
  assert.equal(created.executionMode, 'preview_only')
  assert.throws(() => repo.updateBettingRule(created.id, { executionMode: 'real_eligible' }), /real-eligible-upgrade-forbidden/)

  handle.db.prepare("UPDATE betting_rules SET execution_mode = 'real_eligible' WHERE id = ?").run(created.id)
  const renamed = repo.updateBettingRule(created.id, { name: '仅改名称' })
  assert.equal(renamed.version, 1)
  assert.equal(renamed.executionMode, 'real_eligible')

  const executionChanges = [
    { targetAmount: '120.00' },
    { currency: 'HKD' },
    { amountScale: 3 },
    { leagueNames: ['西甲'] },
    { changedOddsMin: 0.85 },
    { changedOddsMax: 1.2 },
    { enabled: false },
  ]
  let previous = renamed
  for (const change of executionChanges) {
    handle.db.prepare("UPDATE betting_rules SET execution_mode = 'real_eligible' WHERE id = ?").run(created.id)
    const changed = repo.updateBettingRule(created.id, change)
    assert.equal(changed.version, previous.version + 1)
    assert.equal(changed.executionMode, 'preview_only')
    previous = changed
  }
  handle.close()
})

test('repository stores betting account website URL and redacts password alias', () => {
  const { handle, repo } = createRepository()

  const account = repo.createBettingAccount({
    username: 'bet-user',
    password: 'bet-password',
    websiteUrl: 'bet.example.test',
    perBetLimit: '100',
    currency: 'CNY',
  })
  handle.close()

  assert.equal(account.username, 'bet-user')
  assert.equal(account.label, 'bet-user')
  assert.equal(account.websiteUrl, 'https://bet.example.test')
  assert.equal(account.hasSecret, true)
  assert.equal(account.perBetLimit, '100')
  assert.equal(Object.hasOwn(account, 'stakeStep'), false)
  assert.equal(account.balance, null)
  assert.equal(account.acceptedTodayCount, 0)
  assert.equal(account.acceptedTodayAmount, '0')
  assert.equal(Object.hasOwn(account, 'dailyLimit'), false)
  assert.equal(Object.hasOwn(account, 'password'), false)
  assert.equal(JSON.stringify(account).includes('bet-password'), false)
})

test('betting account API accepts only integer CNY limit and omits precision and step fields', () => {
  const { handle, repo } = createRepository()
  const account = repo.createBettingAccount({
    username: 'integer-contract', password: 'secret', websiteUrl: 'https://integer.example.test',
    status: 'enabled', betOrder: 1, perBetLimit: '100', currency: 'CNY',
  })
  assert.equal(account.perBetLimit, '100')
  assert.equal(Object.hasOwn(account, 'amountScale'), false)
  assert.equal(Object.hasOwn(account, 'stakeStep'), false)
  assert.throws(() => repo.createBettingAccount({
    username: 'decimal-contract', perBetLimit: '100.50', currency: 'CNY',
  }), (error) => error.code === 'integer-cny-required')
  assert.throws(() => repo.createBettingAccount({
    username: 'forbidden-contract', perBetLimit: '100', currency: 'CNY', amountScale: 0,
  }), (error) => error.code === 'validation-error' && Boolean(error.fields.amountScale))
  assert.throws(() => repo.createBettingAccount({
    username: 'forbidden-step', perBetLimit: '100', currency: 'CNY', stakeStep: '1',
  }), (error) => error.code === 'validation-error' && Boolean(error.fields.stakeStep))

  handle.db.prepare('UPDATE betting_accounts SET stake_step_minor = 0 WHERE id = ?').run(account.id)
  assert.doesNotThrow(() => repo.getBettingAccountForExecution(account.id))
  handle.close()
})

test('repository lets a legacy zero-step account be edited and remain execution eligible', () => {
  const { handle, repo } = createRepository()
  const account = repo.createBettingAccount({
    username: 'legacy-user', password: 'legacy-password', websiteUrl: 'https://legacy.example.test',
    status: 'enabled', betOrder: 1, perBetLimit: '100', currency: 'CNY',
  })
  handle.db.prepare('UPDATE betting_accounts SET stake_step_minor = 0 WHERE id = ?').run(account.id)

  const updated = repo.updateBettingAccount(account.id, {
    username: 'edited-user', label: 'edited-user', perBetLimit: '50', currency: 'CNY',
  })

  assert.equal(updated.username, 'edited-user')
  assert.equal(updated.perBetLimit, '50')
  assert.equal(Object.hasOwn(updated, 'stakeStep'), false)
  assert.doesNotThrow(() => repo.getBettingAccountForExecution(account.id))
  handle.close()
})

test('legacy nonzero scale account requires an explicit integer CNY limit migration on update', () => {
  const { handle, repo } = createRepository()
  const account = repo.createBettingAccount({
    username: 'legacy-scale', password: 'legacy-password', websiteUrl: 'https://legacy-scale.example.test',
    status: 'enabled', perBetLimit: '100', currency: 'CNY',
  })
  handle.db.prepare(`
    UPDATE betting_accounts
    SET amount_scale = 2, per_bet_limit_minor = 10000, stake_step_minor = 100
    WHERE id = ?
  `).run(account.id)

  assert.throws(() => repo.updateBettingAccount(account.id, { notes: 'notes-only' }), (error) => (
    error.code === 'integer-cny-migration-required'
  ))
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT amount_scale, per_bet_limit_minor, stake_step_minor, notes
    FROM betting_accounts WHERE id = ?
  `).get(account.id) }, {
    amount_scale: 2,
    per_bet_limit_minor: 10000,
    stake_step_minor: 100,
    notes: '',
  })

  const migrated = repo.updateBettingAccount(account.id, { notes: 'migrated', perBetLimit: '250' })
  assert.equal(migrated.perBetLimit, '250')
  assert.deepEqual({ ...handle.db.prepare(`
    SELECT amount_scale, per_bet_limit_minor, stake_step_minor, notes
    FROM betting_accounts WHERE id = ?
  `).get(account.id) }, {
    amount_scale: 0,
    per_bet_limit_minor: 250,
    stake_step_minor: 1,
    notes: 'migrated',
  })
  handle.close()
})

test('new betting accounts default to integer amount precision', () => {
  const { handle, repo } = createRepository()
  const account = repo.createBettingAccount({
    username: 'integer-user', password: 'integer-password', websiteUrl: 'https://integer.example.test',
    status: 'disabled', perBetLimit: '100', currency: 'CNY',
  })

  assert.equal(account.perBetLimit, '100')
  assert.equal(Object.hasOwn(account, 'amountScale'), false)
  assert.equal(Object.hasOwn(account, 'stakeStep'), false)
  handle.close()
})

test('repository persists display-only betting account access health without changing execution balance', () => {
  const { handle, repo } = createRepository({ now: () => new Date('2026-07-11T08:00:00.000Z') })
  const account = repo.createBettingAccount({
    username: 'access-user', password: 'access-password', websiteUrl: 'https://access.example.test',
    status: 'disabled', betOrder: 0, perBetLimit: '100', currency: 'CNY',
  })

  assert.equal(typeof repo.getBettingAccountForAccessCheck, 'function')
  assert.equal(typeof repo.recordBettingAccountAccessCheck, 'function')
  if (typeof repo.getBettingAccountForAccessCheck !== 'function' || typeof repo.recordBettingAccountAccessCheck !== 'function') {
    handle.close()
    return
  }
  const exact = repo.getBettingAccountForAccessCheck(account.id)
  assert.equal(exact.password, 'access-password')
  const updated = repo.recordBettingAccountAccessCheck(account.id, {
    ok: true, status: 'available', errorCode: '', reportedBalance: '1950', reportedCurrency: 'CNY',
  })
  handle.close()

  assert.equal(updated.accessStatus, 'available')
  assert.equal(updated.accessCheckedAt, '2026-07-11T08:00:00.000Z')
  assert.equal(updated.accessErrorCode, '')
  assert.equal(updated.reportedBalance, '1950')
  assert.equal(updated.reportedCurrency, 'CNY')
  assert.equal(updated.reportedBalanceUpdatedAt, '2026-07-11T08:00:00.000Z')
  assert.equal(updated.balance, null)
  assert.equal(JSON.stringify(updated).includes('access-password'), false)
})

test('repository stores betting account order and exposes enabled execution accounts in order', () => {
  const { handle, repo } = createRepository()

  const money = { perBetLimit: '100', currency: 'CNY' }
  const third = repo.createBettingAccount({
    ...money,
    username: 'third-user',
    password: 'third-password',
    websiteUrl: 'https://example.test',
    status: 'enabled',
    betOrder: 3,
  })
  const first = repo.createBettingAccount({
    ...money,
    username: 'first-user',
    password: 'first-password',
    websiteUrl: 'https://example.test',
    status: 'enabled',
    betOrder: 1,
  })
  const second = repo.createBettingAccount({
    ...money,
    username: 'second-user',
    password: 'second-password',
    websiteUrl: 'https://example.test',
    status: 'enabled',
    betOrder: 2,
  })
  repo.createBettingAccount({
    ...money,
    username: 'disabled-user',
    password: 'disabled-password',
    websiteUrl: 'https://example.test',
    status: 'disabled',
    betOrder: 0,
  })
  handle.db.prepare("UPDATE betting_accounts SET allocation_status='enabled' WHERE id IN (?,?,?)").run(first.id, second.id, third.id)

  const listed = repo.listBettingAccounts()
  const executionAccounts = repo.listEnabledBettingAccountsForExecution()
  handle.close()

  assert.deepEqual(listed.map((item) => item.id), [first.id, second.id, third.id, listed[3].id])
  assert.deepEqual(executionAccounts.map((item) => item.username), ['first-user', 'second-user', 'third-user'])
  assert.deepEqual(executionAccounts.map((item) => item.betOrder), [1, 2, 3])
  assert.equal(executionAccounts[0].password, 'first-password')
  assert.equal(Object.hasOwn(executionAccounts[0], 'dailyLimit'), false)
  assert.equal(JSON.stringify(listed).includes('first-password'), false)
})

test('repository loads exactly one betting account for execution without decrypting unrelated rows', () => {
  const { handle, repo } = createRepository()
  const money = { perBetLimit: '100', currency: 'CNY' }
  const target = repo.createBettingAccount({
    ...money,
    username: 'target-user',
    password: 'target-password',
    websiteUrl: 'https://target.example.test',
    status: 'enabled',
    betOrder: 1,
  })
  const unrelated = repo.createBettingAccount({
    ...money,
    username: 'unrelated-user',
    password: 'unrelated-password',
    websiteUrl: 'https://unrelated.example.test',
    status: 'enabled',
    betOrder: 2,
  })
  handle.db.prepare("UPDATE betting_accounts SET allocation_status='enabled' WHERE id IN (?,?)").run(target.id, unrelated.id)
  handle.db.prepare("UPDATE betting_accounts SET secret_ciphertext = 'corrupt-ciphertext' WHERE id = ?").run(unrelated.id)

  const account = repo.getBettingAccountForExecution(target.id)
  assert.deepEqual({
    id: account.id,
    username: account.username,
    password: account.password,
    loginUrl: account.loginUrl,
    currency: account.currency,
    perBetLimitMinor: account.perBetLimitMinor,
  }, {
    id: target.id,
    username: 'target-user',
    password: 'target-password',
    loginUrl: 'https://target.example.test',
    currency: 'CNY',
    perBetLimitMinor: 100,
  })
  assert.throws(() => repo.listEnabledBettingAccountsForExecution(), /secret|cipher|auth/i)
  handle.close()
})

test('exact betting execution account rejects missing identity and every invalid execution contract', () => {
  const { handle, repo } = createRepository()
  const money = { perBetLimit: '100', currency: 'CNY' }
  const create = (username) => repo.createBettingAccount({
    ...money,
    username,
    password: `${username}-password`,
    websiteUrl: `https://${username}.example.test`,
    status: 'enabled',
    betOrder: 1,
  })

  assert.throws(() => repo.getBettingAccountForExecution(), /betting-account-id-required/)
  assert.throws(() => repo.getBettingAccountForExecution('mon_primary'), /betting-account-monitor-forbidden/)
  assert.throws(() => repo.getBettingAccountForExecution('missing-account'), /betting-account-not-found/)

  const cases = [
    ['disabled', "status = 'disabled'", /betting-account-disabled/],
    ['archived', 'archived = 1', /betting-account-archived/],
    ['username', "username = ''", /betting-account-username/],
    ['secret', "secret_ciphertext = ''", /betting-account-secret/],
    ['url-empty', "website_url = ''", /betting-account-url/],
    ['url-scheme', "website_url = 'file:///tmp/session'", /betting-account-url/],
    ['currency', "currency = 'cny'", /betting-account-currency/],
    ['scale', 'amount_scale = 2', /betting-account-scale/],
    ['limit', 'per_bet_limit_minor = 0', /betting-account-per-bet-limit/],
  ]
  for (const [name, mutation, expected] of cases) {
    const account = create(`invalid-${name}`)
    handle.db.exec('PRAGMA ignore_check_constraints = ON')
    handle.db.prepare(`UPDATE betting_accounts SET ${mutation} WHERE id = ?`).run(account.id)
    handle.db.exec('PRAGMA ignore_check_constraints = OFF')
    assert.throws(() => repo.getBettingAccountForExecution(account.id), expected)
  }
  handle.close()
})

test('repository aggregates all accepted child orders for the injected Asia Shanghai day without safe-integer loss', () => {
  const { handle, repo } = createRepository({ now: () => new Date('2026-07-11T16:30:00.000Z') })
  seedAcceptedTodayLedger(handle.db)

  const recent = repo.listBetBatches()
  const account = repo.listBettingAccounts().find((item) => item.id === 'account-stats')
  handle.close()

  assert.equal(recent.length, 50)
  assert.equal(account.acceptedTodayCount, 59)
  assert.equal(account.acceptedTodayAmount, '180143985094860.00')
})

test('locked accounts allow only label and notes changes, and referenced deletion archives', () => {
  const { handle, repo } = createRepository()
  const account = repo.createBettingAccount({
    label: '锁定账号', username: 'locked', websiteUrl: 'https://example.test', status: 'enabled', betOrder: 1,
    perBetLimit: '100', currency: 'CNY', secret: 'locked-secret',
  })
  const rule = repo.createBettingRule({
    name: '锁测试规则', enabled: true, leagueNames: ['英超'], targetAmount: '100.00', currency: 'CNY', amountScale: 2,
  })
  handle.db.prepare("INSERT INTO monitor_signals (signal_id, signal_key, strategy_id, strategy_version, status, observed_at, expires_at, payload_json) VALUES ('sig_lock', 'k', 's', 1, 'ready', '', '', '{}')").run()
  handle.db.prepare("INSERT INTO bet_batches (batch_id, signal_id, rule_id, target_amount_minor) VALUES ('batch_lock', 'sig_lock', ?, 10000)").run(rule.id)
  handle.db.prepare("INSERT INTO bet_child_orders (child_order_id, batch_id, account_id, requested_amount_minor, status) VALUES ('child_lock', 'batch_lock', ?, 10000, 'reserved')").run(account.id)
  handle.db.prepare("INSERT INTO betting_account_locks (account_id, child_order_id, batch_id) VALUES (?, 'child_lock', 'batch_lock')").run(account.id)

  const cosmetic = repo.updateBettingAccount(account.id, { label: '新标签', notes: '可改' })
  assert.equal(cosmetic.label, '新标签')
  assert.throws(() => repo.updateBettingAccount(account.id, { username: 'changed' }), /betting-account-locked/)
  assert.throws(() => repo.updateBettingAccount(account.id, { status: 'disabled' }), /betting-account-locked/)
  handle.db.prepare('DELETE FROM betting_account_locks WHERE account_id = ?').run(account.id)
  handle.db.prepare('DELETE FROM bet_child_orders WHERE account_id = ?').run(account.id)
  handle.db.prepare('DELETE FROM bet_batches WHERE batch_id = ?').run('batch_lock')
  repo.createBettingHistory({ bettingAccountId: account.id, amount: 1 })
  const deleted = repo.deleteBettingAccount(account.id)
  const archived = repo.listBettingAccounts().find((item) => item.id === account.id)
  handle.close()

  assert.deepEqual(deleted, { ok: true, archived: true })
  assert.equal(archived.archived, true)
  assert.equal(archived.status, 'disabled')
})

test('repository creates betting history rows for adapter results', () => {
  const { handle, repo } = createRepository()
  const row = repo.createBettingHistory({
    bettingAccountId: 'bet_1',
    eventKey: 'crown|gid=8878931',
    ruleId: 'brule_1',
    status: 'dry-run-previewed',
    amount: 50,
    oddsRaw: '0.75',
    details: { provider: 'crown', market: { wtype: 'ROU' }, ticketRef: '[ticket:9]' },
  })
  const rows = repo.listBettingHistory()
  handle.close()

  assert.equal(row.status, 'dry-run-previewed')
  assert.equal(row.details.ticketRef, '[ticket:9]')
  assert.equal(rows.length, 1)
})

test('repository maps betting history display fields for account cards', () => {
  const { handle, repo } = createRepository()

  const row = repo.createBettingHistory({
    accountId: 'bet_1',
    leagueName: '英超',
    teams: '主队 vs 客队',
    market: '让球 0',
    amount: 75,
    betTime: '2026-07-09T05:10:00.000Z',
  })
  handle.close()

  assert.equal(row.accountId, 'bet_1')
  assert.equal(row.leagueName, '英超')
  assert.equal(row.teams, '主队 vs 客队')
  assert.equal(row.market, '让球 0')
  assert.equal(row.amount, 75)
  assert.equal(row.betTime, '2026-07-09T05:10:00.000Z')
})

test('repository projects recent batches and children as decimal strings without provider secrets', () => {
  const { handle, repo } = createRepository()
  seedBatchProjection(handle.db)

  const batches = repo.listBetBatches({ limit: 10 })
  const children = repo.listBetBatchChildren('batch-projection', { limit: 10 })
  handle.close()

  assert.deepEqual(batches, [{
    batchId: 'batch-projection',
    signalId: 'signal-projection',
    ruleId: 'rule-projection',
    eventKey: 'event-1',
    lockedSelectionIdentity: 'selection-1',
    ruleVersion: 3,
    sourceLeague: '英超',
    sourceOdds: '0.91',
    currency: 'CNY',
    amountScale: 2,
    targetAmount: '123.45',
    reservedAmount: '0.00',
    acceptedAmount: '100.00',
    unknownAmount: '0.00',
    unfilledAmount: '23.45',
    status: 'partial',
    finishReason: 'manual_cancel',
    createdAt: '2026-07-11T02:00:00.000Z',
    finishedAt: '2026-07-11T02:02:00.000Z',
  }])
  assert.equal(children[0].requestedAmount, '100.00')
  assert.equal(children[0].previewMinStake, '1.00')
  assert.equal(children[0].previewMaxStake, '100.00')
  assert.equal(children[0].previewBalance, '200.00')
  assert.equal(children[0].previewStakeStep, '0.50')
  assert.equal(children[0].providerReference, '[masked]')
  assert.equal(children[0].status, 'accepted')
  assert.equal(JSON.stringify(children).includes('secret-provider-reference'), false)
  assert.equal(Object.hasOwn(children[0], 'providerReferenceCiphertext'), false)
})

test('repository returns only an unsuspended selection from the latest Crown response for its event', () => {
  const { handle, repo } = createRepository()
  const eventKey = 'crown|football|gid=event-safe'
  const selectionIdentity = `${eventKey}|full_time|asian_handicap|RATIO_R|home`
  const snapshot = {
    provider: 'crown', mode: 'prematch',
    event: { eventKey, ids: { gid: 'event-safe' } },
    market: {
      period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
      lineKey: 'RATIO_R', ratioField: 'RATIO_R', handicapRaw: '0.5 / 1',
    },
    selection: {
      selectionIdentity, side: 'home', oddsField: 'IOR_RH', oddsRaw: '0.96', suspended: false,
    },
  }
  const envelope = {
    provider: 'crown', eventKey, period: 'full_time', marketType: 'asian_handicap',
    lineKey: 'RATIO_R', side: 'home', selectionIdentity, snapshot,
  }
  handle.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity,event_key,captured_at,snapshot_json)
    VALUES (?,?,?,?)
  `).run(selectionIdentity, eventKey, '2026-07-14T00:00:00.000Z', JSON.stringify(snapshot))

  assert.deepEqual(repo.getCurrentCrownSelectionForExecution(envelope), envelope)

  handle.db.prepare(`
    UPDATE monitor_selection_state SET snapshot_json=? WHERE selection_identity=?
  `).run(JSON.stringify({
    ...snapshot,
    selection: { ...snapshot.selection, suspended: true },
  }), selectionIdentity)
  assert.throws(() => repo.getCurrentCrownSelectionForExecution(envelope), /crown-current-selection-invalid/)
  handle.db.prepare(`
    UPDATE monitor_selection_state SET snapshot_json=? WHERE selection_identity=?
  `).run(JSON.stringify(snapshot), selectionIdentity)

  handle.db.prepare(`
    INSERT INTO monitor_selection_state (selection_identity,event_key,captured_at,snapshot_json)
    VALUES (?,?,?,?)
  `).run(`${eventKey}|newer`, eventKey, '2026-07-14T00:00:01.000Z', JSON.stringify(snapshot))
  assert.throws(() => repo.getCurrentCrownSelectionForExecution(envelope), /crown-current-selection-stale/)
  handle.close()
})
