import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import * as analyzeModule from '../scripts/crown-betting-protocol-analyze.mjs'
import * as captureModule from '../scripts/crown-betting-protocol-capture.mjs'
import { createProtocolStore } from '../src/crown/betting-protocol/protocol-store.mjs'
import {
  CROWN_BROWSER_TARGETS,
  classifyProtocolRecord,
  shouldBlockProtocolRequest,
} from '../src/crown/betting-protocol/protocol-classifier.mjs'
import { assertSafeCrownProtocolEvidence } from '../src/crown/betting-protocol/capture-redaction.mjs'

const HMAC_KEY = Buffer.alloc(32, 41)
const ANALYZER_OUTPUTS = Object.freeze([
  'protocol-evidence.json',
  'protocol-summary.json',
  'protocol-map.md',
  'protocol-catalog.safe.json',
  'static-wire-evidence.safe.json',
  'eight-direction-candidates.safe.json',
])

function request(method, url, postData = '', headers = {}) {
  return {
    method: () => method,
    url: () => url,
    resourceType: () => 'xhr',
    headers: () => headers,
    postData: () => postData,
  }
}

async function captureHarness(args = {}) {
  const records = []
  const handlers = {}
  let httpHandler
  let websocketHandler
  const context = {
    pages: () => [],
    on(name, handler) { handlers[name] = handler },
    async route(pattern, handler) {
      assert.equal(pattern, '**/*')
      httpHandler = handler
    },
    async routeWebSocket(pattern, handler) {
      assert.equal(pattern, '**/*')
      websocketHandler = handler
    },
  }
  const controller = await captureModule.installContextCapture(context, {
    append(record) { records.push(record) },
  }, {
    allowRealSubmit: false,
    blockSubmit: true,
    maxStake: 0,
    ...args,
  })
  return { records, handlers, httpHandler, websocketHandler, controller }
}

async function dispatchHttp(handler, rawRequest) {
  const calls = []
  await handler({
    request: () => rawRequest,
    async continue() { calls.push('continue') },
    async abort(reason) { calls.push(`abort:${reason}`) },
  })
  return calls
}

function routedSocket(url) {
  const callbacks = {}
  const sent = []
  const closed = []
  let connectCount = 0
  const server = {
    send(message) { sent.push(message) },
    close(...args) { closed.push(args) },
  }
  const route = {
    url: () => url,
    onMessage(handler) { callbacks.message = handler },
    onClose(handler) { callbacks.close = handler },
    connectToServer() {
      connectCount += 1
      return server
    },
    close(...args) { closed.push(args) },
  }
  return { route, callbacks, sent, closed, get connectCount() { return connectCount } }
}

function modernCapture(runId = 'modern-adversarial', root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-modern-adversarial-'))) {
  const store = createProtocolStore({ rootDir: root, runId })
  store.append({
    captureRunId: runId,
    direction: 'discover',
    sessionGeneration: 'generation-adversarial',
    seq: 1,
    eventOrdinal: 1,
    type: 'request',
    method: 'GET',
    resourceType: 'fetch',
    url: 'https://offline.invalid/transform.php?p=get_game_list',
    headers: {},
    postData: '',
  })
  store.writePrivateManifest({ scenario: 'discover', captureRunId: runId })
  store.writeManifest({
    schemaVersion: 'crown-protocol-capture-manifest-v2',
    scenario: 'discover',
    submitPolicy: 'block-at-route',
  })
  return store
}

test('protocol store never copies duplicate or invalid JSON secrets into the redacted capture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-redaction-json-failclosed-'))
  const store = createProtocolStore({ rootDir: root, runId: 'redaction-json-failclosed' })
  store.append({
    seq: 1,
    type: 'request',
    method: 'POST',
    url: 'https://offline.invalid/transform.php',
    headers: { 'content-type': 'application/json' },
    postData: '{"password":"private-first","password":"private-second"}',
    responseBody: '{"token":"private-token"',
  })
  store.append({
    seq: 2,
    type: 'request',
    method: 'POST',
    url: 'https://offline.invalid/transform.php',
    headers: { 'content-type': 'application/json' },
    postData: '"password":"private-fragment"',
  })
  store.append({
    seq: 3,
    type: 'request',
    method: 'POST',
    url: 'https://offline.invalid/transform.php',
    headers: {},
    postData: '"token":"private-headerless-fragment"',
  })
  store.append({
    seq: 4,
    type: 'request',
    method: 'POST',
    url: 'https://offline.invalid/transform.php',
    headers: {},
    postData: 'prefix "password":"private-prefixed-fragment"',
  })
  store.append({
    seq: 5,
    type: 'request',
    method: 'POST',
    url: 'https://offline.invalid/transform.php',
    headers: {},
    postData: 'password:"private-unquoted-fragment"',
  })

  const redactedRows = fs.readFileSync(
    path.join(store.privateDir, 'redacted-network.jsonl'), 'utf8',
  ).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const [redacted] = redactedRows
  assert.equal(redacted.postData, '[unparseable-json]')
  assert.equal(redacted.responseBody, '[unparseable-json]')
  assert.equal(redactedRows[1].postData, '[unparseable-json]')
  assert.equal(redactedRows[2].postData, '[unparseable-json]')
  assert.equal(redactedRows[3].postData, '[unparseable-json]')
  assert.equal(redactedRows[4].postData, '[unparseable-json]')
  assert.doesNotMatch(
    JSON.stringify(redactedRows),
    /private-first|private-second|private-token|private-fragment|private-headerless-fragment|private-prefixed-fragment|private-unquoted-fragment/,
  )
})

test('protocol store rolls both JSONL files back when either append fails', () => {
  for (const failAt of [3, 4]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-store-atomic-'))
    let appendCalls = 0
    const fileSystem = {
      ...fs,
      appendFileSync(file, content, encoding) {
        appendCalls += 1
        if (appendCalls === failAt) {
          fs.appendFileSync(file, content.slice(0, 11), encoding)
          throw new Error(`forced-append-failure-${failAt}`)
        }
        fs.appendFileSync(file, content, encoding)
      },
    }
    const store = createProtocolStore({ rootDir: root, runId: 'atomic', fileSystem })
    const row = (seq) => ({
      seq, type: 'request', method: 'GET', url: 'https://offline.invalid/transform.php',
      headers: {}, postData: '',
    })
    store.append(row(1))
    const rawFile = path.join(store.privateDir, 'raw-network.jsonl')
    const redactedFile = path.join(store.privateDir, 'redacted-network.jsonl')
    const beforeRaw = fs.readFileSync(rawFile)
    const beforeRedacted = fs.readFileSync(redactedFile)

    assert.throws(() => store.append(row(2)), new RegExp(`forced-append-failure-${failAt}`))
    assert.deepEqual(fs.readFileSync(rawFile), beforeRaw)
    assert.deepEqual(fs.readFileSync(redactedFile), beforeRedacted)
  }
})

function rewriteJsonl(file, transform) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => transform(JSON.parse(line)))
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function xml(fields) {
  return `<serverresponse>${Object.entries(fields).map(([key, value]) => `<${key}>${value}</${key}>`).join('')}</serverresponse>`
}

function directionAttempt(target, wire) {
  const common = {
    captureRunId: `run-${target.id}`,
    direction: target.id,
    sessionGeneration: `generation-${target.id}`,
  }
  const previewBody = `p=FT_order_view&gid=gid-1&gtype=${wire.gtype}&wtype=${wire.wtype}&chose_team=${wire.sideCode}&langx=zh-cn&odd_f_type=H&ver=v1&uid=uid-1`
  const submitBody = `p=FT_bet&gid=gid-1&gtype=${wire.gtype}&wtype=${wire.wtype}&rtype=${wire.rtype}&isRB=${wire.isRB}&chose_team=${wire.sideCode}&f=${wire.f}&golds=50&ioratio=0.96&ratio=-0.5&uid=uid-1`
  return [{
    ...common, seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php', postData: previewBody,
  }, {
    ...common, seq: 1, eventOrdinal: 2, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php', responseBody: xml({ code: '501', spread: '-0.5', ioratio: '0.96' }),
  }, {
    ...common, seq: 2, eventOrdinal: 3, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php', postData: submitBody,
  }, {
    ...common, seq: 2, eventOrdinal: 4, type: 'route-decision', method: 'POST',
    url: 'https://offline.invalid/transform.php', postData: submitBody,
    decision: 'blocked', blockReason: 'real-submit-disabled', dispatchCount: 0,
  }, {
    ...common, seq: 2, eventOrdinal: 5, type: 'requestfailed', method: 'POST',
    url: 'https://offline.invalid/transform.php', failure: 'net::ERR_BLOCKED_BY_CLIENT',
  }]
}

const PREMATCH_AH_HOME = Object.freeze({
  gtype: 'FT', wtype: 'R', rtype: 'RH', isRB: 'N', sideCode: 'H', f: '1R',
})

test('HTTP submit heuristics run before method and monitor allowlists and continued dispatches are truthful', async () => {
  const { records, httpHandler } = await captureHarness()

  assert.deepEqual(await dispatchHttp(httpHandler, request(
    'GET', 'https://offline.invalid/transform.php?p=FT_bet&golds=50',
  )), ['abort:blockedbyclient'])
  assert.deepEqual(await dispatchHttp(httpHandler, request(
    'POST', 'https://offline.invalid/transform.php', 'p=get_game_list&action=submit&stake=50',
  )), ['abort:blockedbyclient'])
  assert.deepEqual(await dispatchHttp(httpHandler, request(
    'POST', 'https://offline.invalid/transform.php', 'p=get_game_list&gtype=FT',
  )), ['continue'])

  assert.deepEqual(records.filter((row) => row.type === 'route-decision').map((row) => ({
    decision: row.decision, dispatchCount: row.dispatchCount, stage: row.classification.stage,
  })), [
    { decision: 'blocked', dispatchCount: 0, stage: 'submit' },
    { decision: 'blocked', dispatchCount: 0, stage: 'submit' },
    { decision: 'continued', dispatchCount: 1, stage: 'monitor' },
  ])
})

test('HTTP blocker records zero dispatch only after abort succeeds', async () => {
  const { records, httpHandler } = await captureHarness()
  const rawRequest = request(
    'POST', 'https://offline.invalid/transform.php', 'p=FT_bet&golds=50',
  )

  await assert.rejects(() => httpHandler({
    request: () => rawRequest,
    async abort() { throw new Error('synthetic-abort-failure') },
  }), /synthetic-abort-failure/)
  assert.equal(records.some((record) => record.type === 'route-decision'), false)
})

test('HTTP route uses decoded field boundaries and blocks explicit money/order combinations only', async () => {
  const { records, httpHandler } = await captureHarness()
  const blocked = [
    ['https://offline.invalid/checkout.php', 'action=submit&amount=50'],
    ['https://offline.invalid/checkout.php', 'action=place&amount=50'],
    ['https://offline.invalid/checkout.php', 'action=confirm&money=50'],
    ['https://offline.invalid/checkout.php', 'operation=buy&quantity=1'],
    ['https://offline.invalid/transform.php', 'p=BK_bet&amount=50'],
    ['https://offline.invalid/bet.php', 'stake=10&selection=home'],
    ['https://offline.invalid/checkout.php', '%61ction=%73ubmit&%61mount=50'],
    ['https://offline.invalid/%62et.php', 'st%61ke=10&select%69on=home'],
    ['https://offline.invalid/checkout.php', '[{"action":"submit","amount":50}]'],
    ['https://offline.invalid/checkout.php', '{"wrapper":[[{"operation":"buy","quantity":1}]]}'],
  ]
  for (const [url, body] of blocked) {
    assert.deepEqual(await dispatchHttp(httpHandler, request('POST', url, body)), ['abort:blockedbyclient'])
  }
  for (const body of [
    'event=alphabet',
    'event=priority',
    'event=oddity',
    'event=ordinary',
    'p=alphabet_bet_suffix&amount=50',
    'event=action%3Dsubmit%26amount%3D50&message=stake%2Bselection',
  ]) {
    assert.deepEqual(await dispatchHttp(
      httpHandler,
      request('POST', 'https://offline.invalid/telemetry.php', body),
    ), ['continue'])
  }

  assert.deepEqual(records.filter((row) => row.type === 'route-decision').map((row) => (
    [row.decision, row.dispatchCount]
  )), [
    ['blocked', 0], ['blocked', 0], ['blocked', 0], ['blocked', 0], ['blocked', 0],
    ['blocked', 0], ['blocked', 0], ['blocked', 0], ['blocked', 0], ['blocked', 0],
    ['continued', 1], ['continued', 1], ['continued', 1], ['continued', 1], ['continued', 1],
    ['continued', 1],
  ])
})

test('duplicate and conflicting p fields fail closed in the protocol classifier', () => {
  for (const record of [{
    method: 'GET', url: 'https://offline.invalid/transform.php?p=FT_bet&p=get_game_list', postData: '',
  }, {
    method: 'POST', url: 'https://offline.invalid/transform.php?p=get_game_list', postData: 'p=FT_bet&golds=50',
  }]) {
    assert.equal(classifyProtocolRecord(record).stage, 'submit')
    assert.equal(shouldBlockProtocolRequest(record).block, true)
  }
})

test('default HTTP route blocks order-like candidates and duplicate JSON operations without dispatch', async () => {
  const { records, httpHandler } = await captureHarness()
  const probes = [{
    request: request(
      'POST',
      'https://offline.invalid/bet.php',
      'gid=123&stake=10&selection=home',
      { 'content-type': 'application/x-www-form-urlencoded' },
    ),
    stage: 'candidate',
  }, {
    request: request(
      'POST',
      'https://offline.invalid/transform.php',
      '{"p":"FT_bet","p":"get_game_list","gid":"123","golds":"10","selection":"home"}',
      { 'content-type': 'application/json' },
    ),
    stage: 'submit',
  }]

  for (const probe of probes) {
    assert.deepEqual(await dispatchHttp(httpHandler, probe.request), ['abort:blockedbyclient'])
    const decision = records.at(-1)
    assert.equal(decision.type, 'route-decision')
    assert.equal(decision.decision, 'blocked')
    assert.equal(decision.dispatchCount, 0)
    assert.equal(decision.classification.stage, probe.stage)
  }

  assert.deepEqual(await dispatchHttp(httpHandler, request(
    'POST',
    'https://offline.invalid/transform.php',
    'p=get_game_list&extra=ordinary-probe',
    { 'content-type': 'application/x-www-form-urlencoded' },
  )), ['continue'])
  const ordinary = records.at(-1)
  assert.equal(ordinary.classification.stage, 'candidate')
  assert.equal(ordinary.decision, 'continued')
  assert.equal(ordinary.dispatchCount, 1)
})

test('block mode refuses startup when outbound WebSocket interception is unavailable', async () => {
  const context = { pages: () => [], on() {}, async route() {} }
  await assert.rejects(() => captureModule.installContextCapture(context, { append() {} }, {
    blockSubmit: true, allowRealSubmit: false, maxStake: 0,
  }), /websocket-route-unavailable/)
})

test('WebSocket URL is checked before connect and outbound frames are explicitly forwarded or blocked', async () => {
  const { records, websocketHandler } = await captureHarness()

  const submitUrl = routedSocket('wss://offline.invalid/socket?p=FT_bet&golds=50')
  await websocketHandler(submitUrl.route)
  assert.equal(submitUrl.connectCount, 0)
  assert.ok(submitUrl.closed.length > 0)

  const socket = routedSocket('wss://offline.invalid/socket?token=private-session')
  await websocketHandler(socket.route)
  assert.equal(socket.connectCount, 1)
  assert.equal(typeof socket.callbacks.message, 'function')

  await socket.callbacks.message('p=get_game_list&gtype=FT')
  await socket.callbacks.message('p=FT_bet&golds=50')
  await socket.callbacks.message(Buffer.from('opaque-binary-submit'))
  await socket.callbacks.message('opaque-text')
  await socket.callbacks.message('foo=bar')

  assert.deepEqual(socket.sent, ['p=get_game_list&gtype=FT'])
  const decisions = records.filter((row) => row.type === 'websocket-route-decision')
  assert.deepEqual(decisions.map((row) => [row.decision, row.dispatchCount]), [
    ['blocked', 0], ['continued', 1], ['blocked', 0], ['blocked', 0], ['blocked', 0],
    ['blocked', 0],
  ])
  assert.equal(decisions.some((row) => Object.hasOwn(row, 'payload')), false)
  assert.equal(decisions[1].postData, 'p=get_game_list&gtype=FT')
  assert.equal(decisions[2].postData, 'p=FT_bet&golds=50')
  assert.equal(Object.hasOwn(decisions[3], 'postData'), false)
  assert.equal(new Set(records.map((row) => row.eventOrdinal)).size, records.length)
  assert.deepEqual(records.map((row) => row.eventOrdinal), records.map((_row, index) => index + 1))
})

test('legacy analysis is explicit-only and a stripped modern capture cannot downgrade', () => {
  assert.equal(typeof analyzeModule.parseAnalyzeArgs, 'function')
  assert.deepEqual(analyzeModule.parseAnalyzeArgs(['capture-dir', '--legacy-layout']), {
    captureDir: 'capture-dir', legacyLayout: true,
  })

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-genuine-legacy-'))
  const legacy = createProtocolStore({ rootDir: legacyRoot, runId: 'legacy' })
  legacy.append({
    seq: 1, type: 'request', method: 'GET', resourceType: 'fetch',
    url: 'https://offline.invalid/transform.php?p=get_game_list', headers: {}, postData: '',
  })
  fs.renameSync(
    path.join(legacy.privateDir, 'redacted-network.jsonl'),
    path.join(legacy.publicDir, 'redacted-network.jsonl'),
  )
  fs.writeFileSync(
    path.join(legacy.publicDir, 'manifest.json'),
    `${JSON.stringify({
      generatedAt: '2026-07-14T00:00:00.000Z',
      url: 'https://offline.invalid',
      profile: 'data/crown-profile',
      allowOddsClick: false,
      allowStakeFill: false,
      allowRealSubmit: false,
      maxStake: 0,
    })}\n`,
    'utf8',
  )
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(legacy.runDir, {
    hmacKey: HMAC_KEY,
  }), /legacy-layout-explicit-opt-in-required/)
  assert.equal(analyzeModule.analyzeCrownProtocolCapture(legacy.runDir, {
    hmacKey: HMAC_KEY, legacyLayout: true,
  }).safeArtifacts, false)

  fs.rmSync(path.join(legacy.publicDir, 'manifest.json'))
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(legacy.runDir, {
    hmacKey: HMAC_KEY, legacyLayout: true,
  }), /legacy-layout-manifest-required/)

  fs.writeFileSync(
    path.join(legacy.publicDir, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 'crown-protocol-capture-manifest-v1-forged' })}\n`,
    'utf8',
  )
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(legacy.runDir, {
    hmacKey: HMAC_KEY, legacyLayout: true,
  }), /modern-layout-cannot-use-legacy/)

  const modern = modernCapture('stripped-modern')
  fs.rmSync(path.join(modern.publicDir, 'manifest.json'))
  for (const name of ['raw-network.jsonl', 'redacted-network.jsonl']) {
    rewriteJsonl(path.join(modern.privateDir, name), (row) => {
      delete row.eventOrdinal
      delete row.captureRunId
      delete row.sessionGeneration
      return row
    })
  }
  fs.renameSync(
    path.join(modern.privateDir, 'redacted-network.jsonl'),
    path.join(modern.publicDir, 'redacted-network.jsonl'),
  )
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(modern.runDir, {
    hmacKey: HMAC_KEY,
  }), /modern-layout-incomplete/)
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(modern.runDir, {
    hmacKey: HMAC_KEY, legacyLayout: true,
  }), /modern-layout-cannot-use-legacy/)
})

test('failed reanalysis removes every prior analyzer output and leaves no temporary publication', () => {
  const store = modernCapture('atomic-reanalysis')
  analyzeModule.analyzeCrownProtocolCapture(store.runDir, { hmacKey: HMAC_KEY })
  for (const name of ANALYZER_OUTPUTS) {
    assert.equal(fs.existsSync(path.join(store.publicDir, name)), true, name)
  }

  rewriteJsonl(path.join(store.privateDir, 'redacted-network.jsonl'), (row) => ({ ...row, method: 'POST' }))
  assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(store.runDir, {
    hmacKey: HMAC_KEY,
  }), /redaction-pair-mismatch/)
  for (const name of ANALYZER_OUTPUTS) {
    assert.equal(fs.existsSync(path.join(store.publicDir, name)), false, name)
  }
  assert.deepEqual(fs.readdirSync(store.publicDir).filter((name) => /(?:^|\.)tmp(?:-|$)/i.test(name)), [])
})

test('capture-set analysis removes stale safe outputs on validation, read, pair, and JSONL failures', async (t) => {
  const safeOutputs = [
    'protocol-catalog.safe.json',
    'eight-direction-candidates.safe.json',
    'static-wire-evidence.safe.json',
  ]
  const targetWithStaleOutputs = () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-capture-set-target-'))
    const publicDir = path.join(target, 'public')
    fs.mkdirSync(publicDir, { recursive: true })
    for (const name of safeOutputs) fs.writeFileSync(path.join(publicDir, name), 'stale\n', 'utf8')
    return { target, publicDir }
  }
  const assertCleared = (publicDir) => {
    for (const name of safeOutputs) assert.equal(fs.existsSync(path.join(publicDir, name)), false, name)
    assert.deepEqual(fs.readdirSync(publicDir).filter((name) => /(?:^|\.)tmp(?:-|$)/i.test(name)), [])
  }

  await t.test('empty run list', () => {
    const { target, publicDir } = targetWithStaleOutputs()
    assert.throws(() => analyzeModule.analyzeCrownProtocolCaptureSet(target, [], {
      hmacKey: HMAC_KEY,
    }), /capture-set-empty/)
    assertCleared(publicDir)
  })

  await t.test('missing run', () => {
    const { target, publicDir } = targetWithStaleOutputs()
    assert.throws(() => analyzeModule.analyzeCrownProtocolCaptureSet(target, [path.join(target, 'missing')], {
      hmacKey: HMAC_KEY,
    }), /modern-layout-incomplete/)
    assertCleared(publicDir)
  })

  await t.test('raw and redacted pair mismatch', () => {
    const { target, publicDir } = targetWithStaleOutputs()
    const store = modernCapture('capture-set-pair-mismatch', target)
    rewriteJsonl(path.join(store.privateDir, 'redacted-network.jsonl'), (row) => ({ ...row, method: 'POST' }))
    assert.throws(() => analyzeModule.analyzeCrownProtocolCaptureSet(target, [store.runDir], {
      hmacKey: HMAC_KEY,
    }), /redaction-pair-mismatch/)
    assertCleared(publicDir)
  })

  await t.test('raw JSONL parse failure', () => {
    const { target, publicDir } = targetWithStaleOutputs()
    const store = modernCapture('capture-set-json-invalid', target)
    fs.writeFileSync(path.join(store.privateDir, 'raw-network.jsonl'), '{invalid-json\n', 'utf8')
    assert.throws(() => analyzeModule.analyzeCrownProtocolCaptureSet(target, [store.runDir], {
      hmacKey: HMAC_KEY,
    }), /raw-capture-invalid/)
    assertCleared(publicDir)
  })

  await t.test('run outside scenario root', () => {
    const store = modernCapture('capture-set-cross-root')
    const { target, publicDir } = targetWithStaleOutputs()
    assert.throws(() => analyzeModule.analyzeCrownProtocolCaptureSet(target, [store.runDir], {
      hmacKey: HMAC_KEY,
    }), /capture-set-run-outside-root/)
    assertCleared(publicDir)
  })
})

test('analyzer rejects duplicate keys in the JSONL record wrapper before constructing records', () => {
  for (const duplicateField of ['postData', 'classification']) {
    const store = modernCapture(`duplicate-wrapper-${duplicateField}`)
    const rawFile = path.join(store.privateDir, 'raw-network.jsonl')
    const original = JSON.parse(fs.readFileSync(rawFile, 'utf8').trim())
    const entries = Object.entries(original)
      .filter(([field]) => field !== duplicateField)
      .map(([field, value]) => `${JSON.stringify(field)}:${JSON.stringify(value)}`)
    if (duplicateField === 'postData') {
      entries.push('"postData":"p=FT_bet&golds=999999"')
      entries.push('"postData":"p=get_game_list&gtype=FT"')
    } else {
      entries.push('"classification":{"stage":"submit"}')
      entries.push('"classification":{"stage":"monitor"}')
    }
    fs.writeFileSync(rawFile, `{${entries.join(',')}}\n`, 'utf8')

    assert.throws(() => analyzeModule.analyzeCrownProtocolCapture(store.runDir, {
      hmacKey: HMAC_KEY,
    }), /raw-capture-invalid/)
  }
})

test('unknown endpoint paths publish only a safe shape and per-path HMAC across all artifacts', () => {
  const paths = [
    '/api/private-user-alpha/secret-token-value',
    '/api/private-user-beta/secret-token-value',
  ]
  const records = paths.map((endpointPath, index) => ({
    seq: index + 1,
    eventOrdinal: index + 1,
    type: 'request',
    method: 'POST',
    resourceType: 'xhr',
    url: `https://offline.invalid${endpointPath}`,
    postData: 'p=get_game_list&gtype=FT',
  }))
  const catalog = analyzeModule.buildCrownProtocolCatalogCandidate(records, {
    captureId: 'capture', hmacKey: HMAC_KEY,
  })
  const staticWire = analyzeModule.buildCrownStaticWireEvidence(records, {
    captureId: 'capture', hmacKey: HMAC_KEY,
  })
  const legacy = analyzeModule.buildCrownProtocolArtifact(records, { captureId: 'capture' })

  assert.equal(catalog.entries.length, 2)
  assert.ok(catalog.entries.every((entry) => entry.endpointPath === '/[redacted]'))
  assert.ok(catalog.entries.every((entry) => entry.endpointShape.segmentCount === 3))
  assert.equal(new Set(catalog.entries.map((entry) => entry.endpointPathBinding)).size, 2)
  assert.deepEqual(staticWire.entries, [])
  assert.ok(legacy.records.every((entry) => entry.endpointKind === 'other'))

  const serialized = JSON.stringify([catalog, staticWire, legacy])
  for (const forbidden of ['private-user-alpha', 'private-user-beta', 'secret-token-value']) {
    assert.equal(serialized.includes(forbidden), false)
  }
  assert.throws(() => assertSafeCrownProtocolEvidence({
    endpointPath: '/api/private-user-alpha/secret-token-value',
  }), /unsafe-crown-protocol-evidence/)
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence({ endpointPath: '/transform.php' }))
})

test('catalog treats verified static resource bodies as opaque', () => {
  const records = [{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'script',
    url: 'https://offline.invalid/assets/app.js',
  }, {
    seq: 1, eventOrdinal: 2, type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/assets/app.js',
    responseBody: '{"account_token":"PrivateStaticToken","items":[{"gid":"private"}]}',
  }]

  const catalog = analyzeModule.buildCrownProtocolCatalogCandidate(records, {
    captureId: 'capture', hmacKey: HMAC_KEY,
  })
  assert.ok(catalog.entries.every((entry) => entry.request.fields.length === 0))
  assert.ok(catalog.entries.every((entry) => entry.response.fields.length === 0))
  for (const forbidden of ['PrivateStaticToken', 'account_token']) {
    assert.equal(JSON.stringify(catalog).includes(forbidden), false)
  }
})

test('catalog accepts known Crown login metadata names but never publishes their values', () => {
  const records = [{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php?ver=v1',
    postData: 'p=chk_login&ver=v1&userAgent=PrivateUserAgent',
  }, {
    seq: 1, eventOrdinal: 2, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php?ver=v1',
    responseBody: '<serverresponse><passwd_safe>PrivateLoginAlias</passwd_safe><passcode>PrivatePasscode</passcode></serverresponse>',
  }]

  const catalog = analyzeModule.buildCrownProtocolCatalogCandidate(records, {
    captureId: 'capture', hmacKey: HMAC_KEY,
  })
  const serialized = JSON.stringify(catalog)
  for (const forbidden of [
    'PrivateUserAgent', 'PrivateLoginAlias', 'PrivatePasscode',
    'userAgent', 'passwd_safe', 'passcode',
  ]) assert.equal(serialized.includes(forbidden), false)
})

test('catalog duplicate query and query/body p conflicts propagate as fail-closed errors', () => {
  const build = (url, postData = '') => analyzeModule.buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr', url, postData,
  }], { captureId: 'capture', hmacKey: HMAC_KEY })

  assert.throws(() => build(
    'https://offline.invalid/transform.php?p=FT_bet&p=get_game_list&uid=private',
  ), /crown-protocol-catalog:duplicate-field/)
  assert.throws(() => build(
    'https://offline.invalid/transform.php?p=get_game_list', 'p=FT_bet&golds=50',
  ), /crown-protocol-catalog:duplicate-field/)

  assert.doesNotThrow(() => build(
    'https://offline.invalid/transform.php?ver=v1', 'p=get_game_list&ver=v1',
  ))
  assert.throws(() => build(
    'https://offline.invalid/transform.php?ver=v1', 'p=get_game_list&ver=v2',
  ), /crown-protocol-catalog:duplicate-field/)
  assert.throws(() => build(
    'https://offline.invalid/transform.php?p=get_game_list', 'p=get_game_list',
  ), /crown-protocol-catalog:duplicate-field/)
})

test('direction candidates validate the observed Preview and Submit wire for all eight directions', () => {
  const prematchHome = CROWN_BROWSER_TARGETS.find((target) => target.id === 'prematch-full-time-asian-handicap-home')
  const prematchAway = CROWN_BROWSER_TARGETS.find((target) => target.id === 'prematch-full-time-asian-handicap-away')
  const prematchOver = CROWN_BROWSER_TARGETS.find((target) => target.id === 'prematch-full-time-total-over')
  const actualWires = [
    [prematchHome, PREMATCH_AH_HOME],
    [prematchAway, { gtype: 'FT', wtype: 'R', rtype: 'RC', isRB: 'N', sideCode: 'C', f: '1R' }],
    [prematchOver, { gtype: 'FT', wtype: 'OU', rtype: 'OUC', isRB: 'N', sideCode: 'C', f: '1R' }],
    [CROWN_BROWSER_TARGETS.find((target) => target.id === 'prematch-full-time-total-under'),
      { gtype: 'FT', wtype: 'OU', rtype: 'OUH', isRB: 'N', sideCode: 'H', f: '1R' }],
    [CROWN_BROWSER_TARGETS.find((target) => target.id === 'live-full-time-asian-handicap-home'),
      { gtype: 'FT', wtype: 'RE', rtype: 'REH', isRB: 'Y', sideCode: 'H', f: '1R' }],
    [CROWN_BROWSER_TARGETS.find((target) => target.id === 'live-full-time-asian-handicap-away'),
      { gtype: 'FT', wtype: 'RE', rtype: 'REC', isRB: 'Y', sideCode: 'C', f: '1R' }],
    [CROWN_BROWSER_TARGETS.find((target) => target.id === 'live-full-time-total-over'),
      { gtype: 'FT', wtype: 'ROU', rtype: 'ROUC', isRB: 'Y', sideCode: 'C', f: '1R' }],
    [CROWN_BROWSER_TARGETS.find((target) => target.id === 'live-full-time-total-under'),
      { gtype: 'FT', wtype: 'ROU', rtype: 'ROUH', isRB: 'Y', sideCode: 'H', f: '1R' }],
  ]
  const observed = actualWires.map(([target, wire]) => (
    analyzeModule.buildCrownEightDirectionCandidates(directionAttempt(target, wire), {
      expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
    }).candidates[0]
  ))
  assert.ok(observed.every((candidate) => candidate.status === 'candidate'))
  assert.ok(observed.every((candidate) => /^hmac-sha256:[a-f0-9]{64}$/.test(candidate.directionWireBinding)))
  assert.equal(new Set(observed.map((candidate) => candidate.directionWireBinding)).size, 8)

  const staticWire = analyzeModule.buildCrownStaticWireEvidence(
    actualWires.flatMap(([target, wire]) => directionAttempt(target, wire)),
    { expectedDirections: actualWires.map(([target]) => target), captureId: 'capture', hmacKey: HMAC_KEY },
  )
  assert.equal(staticWire.directionTemplates.length, 8)
  for (const [index, [target, wire]] of actualWires.entries()) {
    const template = staticWire.directionTemplates[index]
    assert.equal(template.direction.id, target.id)
    assert.deepEqual(Object.fromEntries(template.previewStaticValues.map(({ field, value }) => [field, value])), {
      p: 'FT_order_view', gtype: wire.gtype, wtype: wire.wtype, chose_team: wire.sideCode,
    })
    assert.deepEqual(Object.fromEntries(template.submitStaticValues.map(({ field, value }) => [field, value])), {
      p: 'FT_bet', gtype: wire.gtype, wtype: wire.wtype, rtype: wire.rtype,
      isRB: wire.isRB, chose_team: wire.sideCode, f: wire.f,
    })
    assert.match(template.sourceBinding, /^hmac-sha256:[a-f0-9]{64}$/)
  }
  const publishedValues = staticWire.directionTemplates.flatMap((template) => [
    ...template.previewStaticValues, ...template.submitStaticValues,
  ]).map(({ value }) => value)
  for (const dynamicValue of ['gid-1', 'uid-1', '0.96', '-0.5', '50']) {
    assert.equal(publishedValues.includes(dynamicValue), false)
  }

  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    directionAttempt(prematchAway, PREMATCH_AH_HOME),
    { expectedDirections: [prematchAway], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:direction-wire-mismatch/)
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    directionAttempt(prematchOver, PREMATCH_AH_HOME),
    { expectedDirections: [prematchOver], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:direction-wire-mismatch/)

  const spoofed = {
    ...prematchHome, mode: 'live', marketType: 'total', side: 'under',
  }
  const canonicalized = analyzeModule.buildCrownEightDirectionCandidates(
    directionAttempt(prematchHome, PREMATCH_AH_HOME),
    { expectedDirections: [spoofed], captureId: 'capture', hmacKey: HMAC_KEY },
  ).candidates[0]
  assert.deepEqual(canonicalized.direction, prematchHome)

  const withIrrelevantNavigation = directionAttempt(prematchHome, PREMATCH_AH_HOME)
  withIrrelevantNavigation.push({
    captureRunId: withIrrelevantNavigation[0].captureRunId,
    direction: prematchHome.id,
    sessionGeneration: withIrrelevantNavigation[0].sessionGeneration,
    seq: 3, eventOrdinal: 6, type: 'request', method: 'GET', resourceType: 'document',
    url: 'https://offline.invalid/?four_pwd=PrivateDocumentSecret',
  }, {
    captureRunId: withIrrelevantNavigation[0].captureRunId,
    direction: prematchHome.id,
    sessionGeneration: withIrrelevantNavigation[0].sessionGeneration,
    seq: 4, eventOrdinal: 7, type: 'request', method: 'GET', resourceType: 'stylesheet',
    url: 'https://offline.invalid/style/order.css?ver=1',
  }, {
    captureRunId: withIrrelevantNavigation[0].captureRunId,
    direction: prematchHome.id,
    sessionGeneration: withIrrelevantNavigation[0].sessionGeneration,
    seq: 4, eventOrdinal: 8, type: 'route-decision', method: 'GET', resourceType: 'stylesheet',
    url: 'https://offline.invalid/style/order.css?ver=1',
    decision: 'continued', dispatchCount: 1,
  })
  assert.equal(analyzeModule.buildCrownEightDirectionCandidates(withIrrelevantNavigation, {
    expectedDirections: [prematchHome], captureId: 'capture', hmacKey: HMAC_KEY,
  }).candidates[0].status, 'candidate')
})

test('eight-direction candidate fails closed when any WebSocket Submit decision was dispatched', () => {
  const target = CROWN_BROWSER_TARGETS.find((item) => item.id === 'prematch-full-time-asian-handicap-home')
  const records = directionAttempt(target, PREMATCH_AH_HOME)
  records.push({
    captureRunId: records[0].captureRunId,
    direction: target.id,
    sessionGeneration: records[0].sessionGeneration,
    seq: 3,
    eventOrdinal: 6,
    type: 'websocket-route-decision',
    method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket',
    source: 'frame',
    payloadKind: 'text',
    postData: 'p=FT_bet&golds=50',
    decision: 'continued',
    dispatchCount: 1,
    classification: { stage: 'submit', confidence: 'high', reasons: ['exact p=FT_bet'] },
  })

  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(records, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-submit-dispatched/)

  const blockedSubmitUrl = directionAttempt(target, PREMATCH_AH_HOME)
  blockedSubmitUrl.push({
    captureRunId: blockedSubmitUrl[0].captureRunId,
    direction: target.id,
    sessionGeneration: blockedSubmitUrl[0].sessionGeneration,
    seq: 3,
    eventOrdinal: 6,
    type: 'websocket-route-decision',
    method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket?p=FT_bet&golds=50',
    source: 'url',
    decision: 'blocked',
    dispatchCount: 0,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged metadata'] },
  })
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(blockedSubmitUrl, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-submit-attempt/)

  const rawFrameRecords = directionAttempt(target, PREMATCH_AH_HOME)
  rawFrameRecords.push({
    captureRunId: rawFrameRecords[0].captureRunId,
    direction: target.id,
    sessionGeneration: rawFrameRecords[0].sessionGeneration,
    seq: 3,
    eventOrdinal: 6,
    type: 'websocket-send',
    url: 'wss://offline.invalid/socket',
    payload: 'p=FT_bet&golds=50',
    classification: { stage: 'candidate', confidence: 'low', reasons: ['forged metadata'] },
  })
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(rawFrameRecords, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-submit-attempt/)

  const uncorrelatedOpaqueFrame = directionAttempt(target, PREMATCH_AH_HOME)
  uncorrelatedOpaqueFrame.push({
    captureRunId: uncorrelatedOpaqueFrame[0].captureRunId,
    direction: target.id,
    sessionGeneration: uncorrelatedOpaqueFrame[0].sessionGeneration,
    seq: 3,
    eventOrdinal: 6,
    type: 'websocket-send',
    url: 'wss://offline.invalid/socket',
    payload: Buffer.from('opaque-binary-frame'),
  })
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(uncorrelatedOpaqueFrame, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-frame-correlation/)

  const correlatedMonitorFrame = directionAttempt(target, PREMATCH_AH_HOME)
  correlatedMonitorFrame.push({
    captureRunId: correlatedMonitorFrame[0].captureRunId,
    direction: target.id,
    sessionGeneration: correlatedMonitorFrame[0].sessionGeneration,
    seq: 3, eventOrdinal: 6, type: 'websocket-open',
    url: 'wss://offline.invalid/socket',
  }, {
    captureRunId: correlatedMonitorFrame[0].captureRunId,
    direction: target.id,
    sessionGeneration: correlatedMonitorFrame[0].sessionGeneration,
    seq: 3, eventOrdinal: 8, type: 'websocket-send',
    url: 'wss://offline.invalid/socket', payload: 'p=get_game_list&gtype=FT',
  }, {
    captureRunId: correlatedMonitorFrame[0].captureRunId,
    direction: target.id,
    sessionGeneration: correlatedMonitorFrame[0].sessionGeneration,
    seq: 4, eventOrdinal: 7, type: 'websocket-route-decision', method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket', source: 'frame', payloadKind: 'text',
    postData: 'p=get_game_list&gtype=FT',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['verified operation contract'] },
  })
  assert.equal(analyzeModule.buildCrownEightDirectionCandidates(correlatedMonitorFrame, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }).candidates[0].status, 'candidate')

  const forgedBinaryCorrelation = directionAttempt(target, PREMATCH_AH_HOME)
  forgedBinaryCorrelation.push({
    captureRunId: forgedBinaryCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedBinaryCorrelation[0].sessionGeneration,
    seq: 3, eventOrdinal: 6, type: 'websocket-open',
    url: 'wss://offline.invalid/socket',
  }, {
    captureRunId: forgedBinaryCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedBinaryCorrelation[0].sessionGeneration,
    seq: 3, eventOrdinal: 8, type: 'websocket-send',
    url: 'wss://offline.invalid/socket', payload: Buffer.from('opaque-binary-frame'),
  }, {
    captureRunId: forgedBinaryCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedBinaryCorrelation[0].sessionGeneration,
    seq: 4, eventOrdinal: 7, type: 'websocket-route-decision', method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket', source: 'frame', payloadKind: 'text',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  })
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(forgedBinaryCorrelation, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-route-decision-invalid/)

  const forgedTextCorrelation = directionAttempt(target, PREMATCH_AH_HOME)
  forgedTextCorrelation.push({
    captureRunId: forgedTextCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedTextCorrelation[0].sessionGeneration,
    seq: 3, eventOrdinal: 6, type: 'websocket-open',
    url: 'wss://offline.invalid/socket',
  }, {
    captureRunId: forgedTextCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedTextCorrelation[0].sessionGeneration,
    seq: 3, eventOrdinal: 8, type: 'websocket-send',
    url: 'wss://offline.invalid/socket', payload: 'foo=bar',
  }, {
    captureRunId: forgedTextCorrelation[0].captureRunId,
    direction: target.id,
    sessionGeneration: forgedTextCorrelation[0].sessionGeneration,
    seq: 4, eventOrdinal: 7, type: 'websocket-route-decision', method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket', source: 'frame', payloadKind: 'text',
    postData: 'foo=bar',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  })
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(forgedTextCorrelation, {
    expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /crown-eight-direction:websocket-route-decision-invalid/)
})

test('eight-direction counts all raw classifier Preview and Submit HTTP traffic', () => {
  const target = CROWN_BROWSER_TARGETS.find((item) => item.id === 'prematch-full-time-asian-handicap-home')
  const extraTraffic = (postData, {
    method = 'POST', resourceType = 'xhr', url = 'https://offline.invalid/transform.php',
    decision = 'blocked', dispatchCount = 0,
  } = {}) => {
    const records = directionAttempt(target, PREMATCH_AH_HOME)
    records.push({
      captureRunId: records[0].captureRunId,
      direction: target.id,
      sessionGeneration: records[0].sessionGeneration,
      seq: 3, eventOrdinal: 6, type: 'request', method, resourceType,
      url, postData,
    }, {
      captureRunId: records[0].captureRunId,
      direction: target.id,
      sessionGeneration: records[0].sessionGeneration,
      seq: 3, eventOrdinal: 7, type: 'route-decision', method, resourceType,
      url, postData, decision, dispatchCount,
    })
    return records
  }

  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    extraTraffic('p=get_game_list&action=submit&stake=50'),
    { expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:betting-traffic-count/)
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    extraTraffic('action=order_view&selection=home'),
    { expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:betting-traffic-count/)
  const orderRisk = extraTraffic('stake=10&selection=home')
  orderRisk.at(-2).url = 'https://offline.invalid/bet.php'
  orderRisk.at(-1).url = 'https://offline.invalid/bet.php'
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    orderRisk,
    { expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:betting-traffic-count/)

  for (const url of [
    'https://offline.invalid/checkout?action=submit&stake=50&selection=home',
    'https://offline.invalid/188bet/checkout?action=submit&stake=50&selection=home',
  ]) {
    assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
      extraTraffic('', {
        method: 'GET', resourceType: url.includes('/188bet/') ? 'fetch' : 'document',
        url, decision: 'continued', dispatchCount: 1,
      }),
      { expectedDirections: [target], captureId: 'capture', hmacKey: HMAC_KEY },
    ), /crown-eight-direction:betting-traffic-count/)
  }
})

test('eight-direction requires a confirmed failed request and a unique session generation per context', () => {
  const home = CROWN_BROWSER_TARGETS.find((item) => item.id === 'prematch-full-time-asian-handicap-home')
  const away = CROWN_BROWSER_TARGETS.find((item) => item.id === 'prematch-full-time-asian-handicap-away')
  const awayWire = { gtype: 'FT', wtype: 'R', rtype: 'RC', isRB: 'N', sideCode: 'C', f: '1R' }

  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    directionAttempt(home, PREMATCH_AH_HOME).filter((record) => record.type !== 'requestfailed'),
    { expectedDirections: [home], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:submit-block-unconfirmed/)

  const sharedGeneration = [
    ...directionAttempt(home, PREMATCH_AH_HOME),
    ...directionAttempt(away, awayWire),
  ].map((record) => ({ ...record, sessionGeneration: 'shared-generation' }))
  assert.throws(() => analyzeModule.buildCrownEightDirectionCandidates(
    sharedGeneration,
    { expectedDirections: [home, away], captureId: 'capture', hmacKey: HMAC_KEY },
  ), /crown-eight-direction:session-generation-reused/)
})

test('MARKET_UNAVAILABLE needs wait, match switch, multiple attempts, and final confirmation', async () => {
  assert.equal(typeof captureModule.resolveMarketAvailability, 'function')
  const answers = ['MARKET_UNAVAILABLE', 'WAIT', 'SWITCH_MATCH', 'CONFIRM_MARKET_UNAVAILABLE']
  let questions = 0
  let waits = 0
  let switches = 0
  const prompts = []
  const result = await captureModule.resolveMarketAvailability({
    async question(prompt) { prompts.push(prompt); questions += 1; return answers.shift() },
    async waitForMarket() { waits += 1 },
    async switchMatch() { switches += 1 },
  })
  assert.deepEqual(result, {
    status: 'market-unavailable', attemptCount: 4, waited: true, switchedMatch: true,
    finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
  })
  assert.deepEqual([questions, waits, switches], [4, 1, 1])
  assert.ok(prompts.every((prompt) => prompt.includes(
    'MARKET_UNAVAILABLE, WAIT, SWITCH_MATCH, then CONFIRM_MARKET_UNAVAILABLE',
  )))
})

test('explicit --block-submit and --allow-real-submit conflict in either flag order', () => {
  for (const argv of [
    ['--block-submit', '--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '1'],
    ['--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '1', '--block-submit'],
  ]) {
    assert.throws(() => captureModule.assertCaptureSafety(captureModule.parseCaptureArgs(argv)), /block-submit.*allow-real-submit.*conflict/i)
  }
  assert.doesNotThrow(() => captureModule.assertCaptureSafety(captureModule.parseCaptureArgs([
    '--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '1',
  ])))
})

test('invalid capture scenario CLI prints one stable sanitized error without stack or absolute path', () => {
  const script = path.resolve('scripts/crown-betting-protocol-capture.mjs')
  const result = spawnSync(process.execPath, [script, '--scenario', 'invalid'], {
    cwd: path.resolve('.'), encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr.trim(), /^crown-betting-protocol-capture:invalid-scenario$/)
  assert.doesNotMatch(result.stderr, /(?:[A-Za-z]:\\|file:\/\/|\bat\s+.*:\d+:\d+)/)
  assert.equal(result.stdout.includes('Saved capture:'), false)
})
