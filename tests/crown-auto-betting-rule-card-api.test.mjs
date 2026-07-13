import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

const NOW = new Date('2026-07-12T04:00:00.000Z')
const validBody = {
  name: 'Primary card',
  enabled: true,
  leagueNames: ['Premier League'],
  targetOddsMin: '0.8',
  targetOddsMax: '1.05',
  targetAmountMinor: 100,
  remark: '',
}

async function startServer(t, { repository } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-card-api-'))
  const staticDir = path.join(dir, 'public')
  const dbPath = path.join(dir, 'crown.sqlite')
  const defaultLeaguesPath = path.join(dir, 'default-leagues.json')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>', 'utf8')
  fs.writeFileSync(defaultLeaguesPath, JSON.stringify({
    version: 1,
    leagues: [{ name: 'Premier League', enabled: true, modes: ['prematch'] }],
  }), 'utf8')

  if (!repository) {
    const handle = openAppDatabase({ dbPath, monitorJson: null })
    handle.db.prepare(`
      INSERT INTO monitor_event_state (
        event_key, match_group_key, active, missing_count, last_seen_at,
        provider_ids_json, event_json
      ) VALUES ('event-1', 'event-1', 1, 0, ?, '{}', ?)
    `).run(NOW.toISOString(), JSON.stringify({
      eventKey: 'event-1', league: 'Premier League', mode: 'prematch', startTimeUtc: NOW.toISOString(),
    }))
    handle.close()
  }

  const server = createDashboardServer({
    staticDir,
    dataOptions: { defaultLeaguesPath },
    appOptions: {
      dbPath,
      now: () => NOW,
      repository,
      env: {
        CROWN_DASHBOARD_PASSWORD_SCRYPT: '',
        CROWN_DASHBOARD_SESSION_KEY: '',
      },
    },
  })
  t.after(() => server.close())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const context = await fetch(`${baseUrl}/api/app/security-context`).then((response) => response.json())

  async function request(method, pathname, body, { csrf = true } = {}) {
    const response = await fetch(`${baseUrl}/api/app${pathname}`, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { origin: baseUrl }),
        ...(csrf && method !== 'GET' ? { 'x-csrf-token': context.csrfToken } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, payload: await response.json() }
  }
  return { request, dbPath }
}

test('card API exposes canonical CRUD and today ownership metadata', async (t) => {
  const { request, dbPath } = await startServer(t)
  const created = await request('POST', '/auto-betting-rule-cards', validBody)
  assert.equal(created.status, 200)
  assert.deepEqual(created.payload.item.leagueNames, ['Premier League'])
  assert.equal('mode' in created.payload.item, false)

  const listed = await request('GET', '/auto-betting-rule-cards')
  assert.equal(listed.status, 200)
  assert.deepEqual(
    listed.payload.items.find((item) => item.cardId === created.payload.item.cardId),
    created.payload.item,
  )
  assert.equal(listed.payload.items.every((item) => !('mode' in item)), true)

  const leagues = await request('GET', `/today-betting-leagues?cardId=${created.payload.item.cardId}`)
  assert.deepEqual(leagues.payload.items[0], {
    leagueName: 'Premier League', source: 'default', todayMatchCount: 1,
    ownerCardId: created.payload.item.cardId, ownerCardName: created.payload.item.name,
    selectable: true, availableToday: true,
  })

  const handle = openAppDatabase({ dbPath, monitorJson: null })
  handle.db.prepare('UPDATE monitor_event_state SET active = 0').run()
  handle.close()
  const staleLeague = await request('GET', `/today-betting-leagues?cardId=${created.payload.item.cardId}`)
  assert.deepEqual(staleLeague.payload.items, [{
    leagueName: 'Premier League', source: 'stale', todayMatchCount: 0,
    ownerCardId: created.payload.item.cardId, ownerCardName: created.payload.item.name,
    selectable: true, availableToday: false,
  }])

  const updated = await request('PUT', `/auto-betting-rule-cards/${created.payload.item.cardId}`, {
    ...validBody, name: 'Updated card', expectedVersion: created.payload.item.version,
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.payload.item.name, 'Updated card')
  const stale = await request('PUT', `/auto-betting-rule-cards/${created.payload.item.cardId}`, {
    ...validBody, expectedVersion: created.payload.item.version,
  })
  assert.deepEqual(stale, { status: 409, payload: { error: 'auto-betting-card-version-conflict' } })
  assert.deepEqual(await request('DELETE', `/auto-betting-rule-cards/${created.payload.item.cardId}`, {
    expectedVersion: created.payload.item.version,
  }), { status: 409, payload: { error: 'auto-betting-card-version-conflict' } })
  assert.deepEqual(await request('DELETE', `/auto-betting-rule-cards/${created.payload.item.cardId}`, {
    expectedVersion: updated.payload.item.version,
  }), { status: 200, payload: { ok: true } })
  assert.deepEqual(await request('DELETE', `/auto-betting-rule-cards/${created.payload.item.cardId}`, {
    expectedVersion: updated.payload.item.version,
  }), { status: 404, payload: { error: 'auto-betting-card-not-found' } })
})

test('card mutations reject incomplete, unknown, foreign, and empty-league payloads', async (t) => {
  const { request } = await startServer(t)
  for (const [body, field] of [
    [{ ...validBody, mode: 'prematch' }, 'mode'],
    [{ ...validBody, cardId: 'foreign-id' }, 'cardId'],
    [{ ...validBody, ownerCardId: 'foreign-owner' }, 'ownerCardId'],
    [{ name: 'incomplete' }, 'enabled'],
  ]) {
    const result = await request('POST', '/auto-betting-rule-cards', body)
    assert.equal(result.status, 400)
    assert.ok(result.payload.fields[field])
  }
  const empty = await request('POST', '/auto-betting-rule-cards', { ...validBody, leagueNames: [] })
  assert.equal(empty.status, 400)
  assert.equal(empty.payload.error, 'league-required')
})

test('ownership conflict returns only public owner name and league names', async (t) => {
  const { request } = await startServer(t)
  const first = await request('POST', '/auto-betting-rule-cards', validBody)
  const conflict = await request('POST', '/auto-betting-rule-cards', { ...validBody, name: 'Second card' })
  assert.equal(conflict.status, 409)
  assert.deepEqual(conflict.payload, {
    error: 'league-owned-by-another-card',
    fields: { leagueNames: ['Premier League'], ownerName: 'Primary card' },
  })
  assert.doesNotMatch(JSON.stringify(conflict.payload), new RegExp(first.payload.item.cardId))
})

test('DELETE validates exact CAS body and delegates through the repository seam', async (t) => {
  const calls = []
  const repository = {
    deleteAutoBettingRuleCard(cardId, body) {
      calls.push({ cardId, body })
      return { ok: true, secret: 'must-not-leak', authorization: { token: 'hidden' } }
    },
  }
  const { request } = await startServer(t, { repository })
  const invalid = await request('DELETE', '/auto-betting-rule-cards/card-1', { expectedVersion: 2, cardId: 'foreign' })
  assert.equal(invalid.status, 400)
  assert.ok(invalid.payload.fields.cardId)
  assert.deepEqual(calls, [])

  const deleted = await request('DELETE', '/auto-betting-rule-cards/card-1', { expectedVersion: 2 })
  assert.deepEqual(deleted, { status: 200, payload: { ok: true } })
  assert.deepEqual(calls, [{ cardId: 'card-1', body: { expectedVersion: 2 } }])
})

test('card API uses fixed not-found mapping and never trusts forged not-found messages', async (t) => {
  const coded = await startServer(t, { repository: {
    updateAutoBettingRuleCard() {
      throw Object.assign(new Error('secret-internal-message'), { code: 'auto-betting-card-not-found' })
    },
  } })
  assert.deepEqual(
    await coded.request('PUT', '/auto-betting-rule-cards/missing', { ...validBody, expectedVersion: 1 }),
    { status: 404, payload: { error: 'auto-betting-card-not-found' } },
  )

  const forged = await startServer(t, { repository: {
    listAutoBettingRuleCards() { throw new Error('forged-secret-not-found') },
  } })
  assert.deepEqual(
    await forged.request('GET', '/auto-betting-rule-cards'),
    { status: 500, payload: { error: 'server-error' } },
  )
})

test('card API rejects malformed encoded paths without exposing URIError details', async (t) => {
  const { request } = await startServer(t, { repository: {} })
  assert.deepEqual(
    await request('DELETE', '/auto-betting-rule-cards/%E0%A4%A', { expectedVersion: 1 }),
    { status: 400, payload: { error: 'invalid-path', fields: { path: 'invalid path encoding' } } },
  )
})

test('conflict and today DTO projections discard nested or foreign repository fields', async (t) => {
  const conflict = await startServer(t, { repository: {
    createAutoBettingRuleCard() {
      throw Object.assign(new Error('league-owned-by-another-card'), {
        code: 'league-owned-by-another-card',
        fields: {
          leagueNames: ['Premier League', { secret: 'nested' }, 7],
          ownerName: { secret: 'nested-owner' },
          ownerCardId: 'must-not-leak',
        },
      })
    },
  } })
  assert.deepEqual(await conflict.request('POST', '/auto-betting-rule-cards', validBody), {
    status: 409,
    payload: {
      error: 'league-owned-by-another-card',
      fields: { leagueNames: ['Premier League'], ownerName: '' },
    },
  })

  const today = await startServer(t, { repository: {
    listTodayBettingLeagues() {
      return [
        { leagueName: 'Manual', source: 'manual', todayMatchCount: 1, ownerCardId: null, ownerCardName: null, selectable: true, availableToday: true, secret: 'hidden' },
        { leagueName: 'Both', source: 'both', todayMatchCount: 2, ownerCardId: null, ownerCardName: null, selectable: true, availableToday: true, authorization: 'hidden' },
      ]
    },
  } })
  const projected = await today.request('GET', '/today-betting-leagues')
  assert.deepEqual(projected.payload.items.map(({ leagueName, source }) => ({ leagueName, source })), [
    { leagueName: 'Manual', source: 'manual' },
    { leagueName: 'Both', source: 'both' },
  ])
  assert.doesNotMatch(JSON.stringify(projected.payload), /secret|authorization|hidden/)
})

test('card API explicitly projects only bounded string activity summaries', async (t) => {
  const base = {
    cardId: 'card-safe', name: 'Safe', enabled: true, leagueNames: ['Premier League'],
    targetOddsMin: '0.8', targetOddsMax: '1.05', targetAmountMinor: 100,
    currency: 'CNY', amountScale: 0, remark: '', realEligible: false,
    realEligibilityVersion: 1, migrationReviewRequired: false, migrationReviewReason: '',
    version: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  }
  const server = await startServer(t, { repository: {
    listAutoBettingRuleCards() {
      return [{ ...base, recentSignal: `Signal：${'安'.repeat(100)}`, recentBatch: { raw: 'provider-secret' },
        recentResult: '结果：已接受', providerToken: 'must-not-leak', rawPayload: 'hidden' }]
    },
  } })
  const result = await server.request('GET', '/auto-betting-rule-cards')
  assert.equal(result.payload.items[0].recentSignal.length, 64)
  assert.equal(result.payload.items[0].recentBatch, null)
  assert.equal(result.payload.items[0].recentResult, '结果：已接受')
  assert.doesNotMatch(JSON.stringify(result.payload), /provider-secret|must-not-leak|rawPayload|hidden/)
})

test('fixed auto-betting setting mutation is retired while GET remains readable', async (t) => {
  const { request } = await startServer(t)
  const retired = await request('PUT', '/auto-betting-settings/prematch', {
    expectedVersion: 1, enabled: true, targetOddsMin: '0.8', targetOddsMax: '1.05',
    targetAmountMinor: 100, currency: 'CNY', amountScale: 0, remark: '',
  })
  assert.deepEqual(retired, { status: 410, payload: { error: 'fixed-auto-betting-settings-retired' } })
  assert.equal((await request('GET', '/auto-betting-settings')).status, 200)
})
