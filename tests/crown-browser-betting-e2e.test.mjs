import assert from 'node:assert/strict'
import test from 'node:test'

import { chromium } from 'playwright'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { BetBatchStore } from '../src/crown/betting/bet-batch-store.mjs'
import { BettingWorker } from '../src/crown/betting/betting-worker.mjs'
import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  getCrownCapability,
  listCrownCapabilities,
} from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  createCrownAcceptanceCapabilityAuthority,
  createCrownAcceptanceWorkerConsumer,
  createCrownBrowserAcceptanceManifest,
  initializeCrownBrowserAcceptanceCampaign,
} from '../src/crown/betting/crown-browser-acceptance.mjs'
import { MultiAccountBetCoordinator } from '../src/crown/betting/multi-account-bet-coordinator.mjs'
import { createRealWorkerProvider, realCoordinatorDependencies } from '../src/crown/betting/real-worker-factory.mjs'
import { CrownBrowserApiClient } from '../src/crown/login/crown-browser-api-client.mjs'
import { acceptanceCandidateFinder } from '../scripts/crown-betting-worker.mjs'

const ORIGIN = 'https://crown.example.com'
const SECRET_KEY = 'local-e2e-acceptance-secret'

function xml(fields) {
  const escape = (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<serverresponse>${Object.entries(fields)
    .map(([name, value]) => `<${name}>${escape(value)}</${name}>`).join('')}</serverresponse>`
}

function responseFields(fieldSet, overrides) {
  return Object.assign(Object.fromEntries(fieldSet.map((field) => [field, 'x'])), overrides)
}

const WAGER_FIELDS = Object.freeze([
  'adddate', 'addtime', 'ball_act_class', 'ball_act_ret', 'ball_map', 'ballact',
  'bet_gtype', 'bet_showtype', 'bet_wtype', 'cancel_apn', 'cancel_line', 'code_value',
  'concede', 'delaysec', 'fore_result', 'gid', 'gidfl', 'gold', 'gtype', 'ioratio',
  'league', 'mainGid', 'odd_f', 'oddf_type', 'org_score', 'pname', 'ptype', 'ratio',
  'result', 'rtype', 'score', 'showtype', 'stop_time', 'strong', 'team_c_ratio',
  'team_c_show', 'team_h_ratio', 'team_h_show', 'team_id_c', 'team_id_h', 'type',
  'w_id', 'w_ms', 'win_gold', 'wtype',
])

function wagerFor(fields, ticket) {
  return {
    ...Object.fromEntries(WAGER_FIELDS.map((field) => [field, ''])),
    gidfl: 0,
    gid: fields.gid,
    mainGid: fields.gid,
    gtype: 'FT',
    bet_gtype: fields.gtype,
    bet_wtype: fields.wtype,
    type: fields.chose_team,
    ioratio: fields.ioratio,
    gold: fields.golds,
    concede: fields.con,
    strong: fields.autoOdd,
    w_id: `OU${ticket}`,
  }
}

function profileLease() {
  let held = false
  return {
    acquire() { held = true; return { fencingToken: 1 } },
    assertFence() { if (!held) throw new Error('profile-lease-stale'); return 1 },
    startHeartbeat() {},
    stopHeartbeat() {},
    release() { held = false; return true },
  }
}

function snapshotFor(direction) {
  const capability = getCrownCapability(direction)
  const eventKey = `crown|football|gid=${direction.ordinal}`
  const lineKey = capability.mapperEvidence.ratioFields[0]
  const line = direction.marketType === 'total' ? '2.5' : '0.5 / 1'
  const handicap = direction.marketType === 'total' ? 2.5 : 0.75
  const marketIdentity = `${eventKey}|full_time|${direction.marketType}|${lineKey}`
  const selectionIdentity = `${marketIdentity}|${direction.selectionSide}`
  return {
    provider: 'crown',
    mode: direction.mode,
    capturedAt: new Date().toISOString(),
    event: {
      eventKey,
      mode: direction.mode,
      ids: { gid: String(direction.ordinal) },
    },
    market: {
      period: 'full_time',
      marketType: direction.marketType,
      lineVariant: 'main',
      lineKey,
      marketIdentity,
      ratioField: lineKey,
      handicap,
      handicapRaw: line,
    },
    selection: {
      selectionIdentity,
      side: direction.selectionSide,
      oddsField: capability.mapperEvidence.oddsFieldsBySide[direction.selectionSide],
      oddsRaw: '0.96',
      suspended: false,
    },
  }
}

test('production Browser runtime and providers complete the ordered eight-direction campaign after context loss and drift retries', async (t) => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  t.after(() => handle.close())
  const env = {
    CROWN_SECRET_KEY: SECRET_KEY,
    CROWN_REAL_CURRENCY: 'CNY',
    CROWN_REAL_AMOUNT_SCALE: '0',
    CROWN_REAL_MAX_TOTAL_MINOR: '10000',
  }
  const repository = createAppRepository(handle.db, { env })
  const account = repository.createBettingAccount({
    label: 'loopback-account',
    username: 'loopback-user',
    password: 'loopback-password',
    websiteUrl: ORIGIN,
    betOrder: 1,
    status: 'enabled',
    perBetLimit: '1000',
    currency: 'CNY',
  })
  handle.db.prepare(`UPDATE betting_accounts SET
    allocation_status='enabled',balance_minor=10000,balance_updated_at=? WHERE id=?`)
    .run(new Date().toISOString(), account.id)

  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: SECRET_KEY })
  const authority = createCrownAcceptanceCapabilityAuthority({
    database: handle.db,
    manifest,
    secretKey: SECRET_KEY,
    candidateCatalog: listCrownCapabilities(),
  })
  const insertSnapshot = handle.db.prepare(`INSERT INTO monitor_selection_state
    (selection_identity,event_key,captured_at,snapshot_json) VALUES (?,?,?,?)`)
  const insertEvent = handle.db.prepare(`INSERT INTO monitor_event_state (
    event_key,match_group_key,active,missing_count,last_seen_at,provider_ids_json,event_json
  ) VALUES (?,?,1,0,?,'{}','{}')`)
  for (const direction of manifest.directions) {
    const snapshot = snapshotFor(direction)
    insertEvent.run(snapshot.event.eventKey, snapshot.event.eventKey, snapshot.capturedAt)
    insertSnapshot.run(
      snapshot.selection.selectionIdentity,
      snapshot.event.eventKey,
      snapshot.capturedAt,
      JSON.stringify(snapshot),
    )
  }

  const executorLease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-executor:acceptance-e2e',
    ownerId: 'acceptance-e2e-executor',
    pid: 11,
    ttlMs: 600_000,
  })
  const reconcilerLease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-reconciler:acceptance-e2e',
    ownerId: 'acceptance-e2e-reconciler',
    pid: 12,
    ttlMs: 600_000,
  })
  const workerLease = new RuntimeLease({
    db: handle.db,
    leaseKey: 'betting-worker:acceptance-e2e',
    ownerId: 'acceptance-e2e-worker',
    pid: 13,
    ttlMs: 600_000,
  })
  executorLease.acquire()
  reconcilerLease.acquire()
  handle.db.prepare(`UPDATE real_betting_runtime SET
    requested=1,runtime_state='running',reason_code='',updated_at=? WHERE singleton_id=1`)
    .run(new Date().toISOString())

  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const contexts = []
  const calls = []
  const previewCounts = new Map()
  const submitOrdinals = []
  const tickets = []
  let contextFailureInjected = false
  let driftInjected = false
  const acceptedEvidence = listCrownCapabilities().find((row) => row.submitAllowed === true)

  async function routeCrown(route) {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Loopback Crown</title>' })
      return
    }
    const fields = Object.fromEntries(new URLSearchParams(request.postData() || ''))
    calls.push(fields)
    const operation = fields.p
    const ordinal = Number(fields.gid || 0)
    if (operation === 'FT_order_view') {
      const count = (previewCounts.get(ordinal) || 0) + 1
      previewCounts.set(ordinal, count)
      if (ordinal === 1 && count === 2 && !contextFailureInjected) {
        contextFailureInjected = true
        const context = request.frame().page().context()
        await route.abort('failed')
        await context.close()
        return
      }
      const direction = manifest.directions[ordinal - 1]
      const capability = getCrownCapability(direction)
      const odds = ordinal === 2 && count === 2 && !driftInjected ? '0.97' : '0.96'
      if (ordinal === 2 && count === 2) driftInjected = true
      const previewFieldSet = direction.mode === 'live'
        ? [...capability.responseFieldSet, 'score']
        : capability.responseFieldSet
      await route.fulfill({
        status: 200,
        contentType: 'application/xml',
        body: xml(responseFields(previewFieldSet, {
          code: '501',
          gold_gmin: String(49 + ordinal),
          gold_gmax: '1000',
          ioratio: odds,
          spread: direction.marketType === 'total' ? '2.5' : '0.5 / 1',
          con: '1',
          ratio: '1',
        })),
      })
      return
    }
    if (operation === 'FT_bet') {
      const submitOrdinal = Number(fields.gid)
      submitOrdinals.push(submitOrdinal)
      const ticket = String(10_000_000_000 + submitOrdinal)
      tickets.push(wagerFor(fields, ticket))
      await route.fulfill({
        status: 200,
        contentType: 'application/xml',
        body: xml({
          ...responseFields(acceptedEvidence.submitResponseFieldSet, {
            code: '560',
            gid: fields.gid,
            gtype: fields.gtype,
            wtype: fields.wtype,
            rtype: fields.rtype,
            gold: fields.golds,
            ioratio: fields.ioratio,
            spread: manifest.directions[submitOrdinal - 1].marketType === 'total' ? '2.5' : '0.5 / 1',
          }),
          ticket_id: ticket,
        }),
      })
      return
    }
    let body
    if (operation === 'chk_login') {
      body = '<serverresponse><status>200</status><uid>loopback-uid</uid><ver>loopback-v1</ver></serverresponse>'
    } else if (operation === 'get_game_list') {
      body = '<serverresponse><system_time>2026-07-15 00:00:00</system_time></serverresponse>'
    } else if (operation === 'get_member_data') {
      body = '<serverresponse><code>get_all_data</code><enable>Y</enable><maxcredit>10000</maxcredit><currency>RMB</currency></serverresponse>'
    } else if (operation === 'get_today_wagers') {
      body = JSON.stringify({
        amout_gold: '', code: '', count: tickets.length, pay_type: 0, ts: fields.ts,
        wagers: tickets,
        ...(tickets.length ? { allGidAry: { FT: [...new Set(tickets.map((item) => item.gid))] } } : {}),
      })
    } else {
      await route.fulfill({ status: 404, body: 'not found' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/xml', body })
  }

  const realWorker = createRealWorkerProvider({
    database: handle.db,
    executorLease,
    reconcilerLease,
    env,
    acceptanceAuthority: authority,
    factories: {
      repository: () => repository,
      profileLease,
      async launchBrowser() {
        const context = await browser.newContext({ serviceWorkers: 'block' })
        contexts.push(context)
        await context.route(`${ORIGIN}/**`, routeCrown)
        return { context, page: await context.newPage() }
      },
      apiClient: ({ page, origin }) => new CrownBrowserApiClient({ page, origin }),
    },
  })
  t.after(() => realWorker.shutdown())
  const store = new BetBatchStore(handle.db, {
    fencingToken: executorLease.fencingToken,
    leaseKey: executorLease.leaseKey,
  })
  const coordinator = new MultiAccountBetCoordinator({
    db: handle.db,
    store,
    ...realCoordinatorDependencies(realWorker),
    lease: executorLease,
    processLease: workerLease,
    findLatestSelection: () => null,
  })
  const acceptanceConsumer = createCrownAcceptanceWorkerConsumer({
    authority,
    findCandidate: acceptanceCandidateFinder(handle.db),
    executeDirection: (input) => coordinator.executeAcceptanceCandidate(input),
    validateDirection: (input) => realWorker.b2Reconciler.validateAccepted(input),
  })
  let ordinaryInboxCalls = 0
  const worker = new BettingWorker({
    mode: 'real',
    db: handle.db,
    lease: workerLease,
    coordinator,
    inboxStore: { claimDue() { ordinaryInboxCalls += 1; return [] } },
    consumer: { async process() { throw new Error('ordinary-consumer-bypass') } },
    acceptanceConsumer,
  })

  const observedOrdinals = []
  for (let iteration = 0; iteration < 12 && authority.inspect().status !== 'completed'; iteration += 1) {
    const result = await worker.runOnce()
    assert.equal(result.acceptance, true)
    observedOrdinals.push(result.results[0].ordinal)
  }

  const summary = authority.inspect()
  assert.equal(summary.status, 'completed')
  assert.equal(summary.acceptedCount, 8)
  assert.equal(summary.uniqueDirectionCount, 8)
  assert.equal(summary.submitDispatchCount, 8)
  assert.equal(summary.unknownCount, 0)
  assert.equal(summary.duplicateAttemptCount, 0)
  assert.deepEqual(observedOrdinals, [1, 1, 2, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(submitOrdinals, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(new Set(submitOrdinals).size, 8)
  assert.equal(contextFailureInjected, true)
  assert.equal(driftInjected, true)
  assert.ok(contexts.length >= 2)
  assert.equal(ordinaryInboxCalls, 0)

  const cases = handle.db.prepare(`SELECT ordinal,case_version,state,child_order_id,submit_attempt_id
    FROM crown_browser_acceptance_cases ORDER BY ordinal,case_version`).all()
  assert.deepEqual(cases.filter((row) => row.state === 'accepted').map((row) => row.ordinal), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(cases.filter((row) => row.state === 'cancelled').length, 2)
  const cancelledChildren = handle.db.prepare(`SELECT child.status,batch.status AS batch_status
    FROM bet_child_orders child JOIN bet_batches batch ON batch.batch_id=child.batch_id
    WHERE child.status='cancelled'`).all()
  assert.equal(cancelledChildren.length, 2)
  assert.ok(cancelledChildren.every((row) => row.batch_status === 'cancelled'))
  const attempts = handle.db.prepare('SELECT status FROM bet_submit_attempts ORDER BY created_at,submit_attempt_id').all()
  assert.equal(attempts.length, 8)
  assert.ok(attempts.every((row) => row.status === 'accepted'))
  const evidence = handle.db.prepare('SELECT * FROM bet_reconciliation_evidence ORDER BY created_at,evidence_id').all()
  assert.equal(evidence.length, 8)
  assert.ok(evidence.every((row) => row.source === 'today_wagers' && row.decision === 'accepted'
    && /^[a-f0-9]{64}$/.test(row.payload_hash)))
  const serializedEvidence = JSON.stringify(evidence)
  assert.equal(serializedEvidence.includes('loopback-ticket'), false)
  assert.equal(serializedEvidence.includes(account.id), false)
  assert.equal(serializedEvidence.includes('/transform.php'), false)
  assert.equal(serializedEvidence.includes('<serverresponse>'), false)
  assert.equal(calls.filter((call) => call.p === 'FT_bet').length, 8)
  assert.equal(calls.filter((call) => call.p === 'get_today_wagers').length, 8)

  worker.stop()
  reconcilerLease.release()
  executorLease.release()
})
