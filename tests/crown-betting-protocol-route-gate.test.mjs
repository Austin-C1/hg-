import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyProtocolRecord,
  classifyProtocolWebSocketFrame,
  shouldBlockProtocolRequest,
} from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  installContextCapture,
  installWebSocketSubmitBlocker,
} from '../scripts/crown-betting-protocol-capture.mjs'

async function dispatchHttp({
  method = 'POST',
  url = '/transform.php',
  body = '',
  headers = { 'content-type': 'application/x-www-form-urlencoded' },
  allowRealSubmit = false,
  maxStake = 50,
} = {}) {
  const records = []
  let routeHandler
  const context = {
    on() {},
    async routeWebSocket() {},
    async route(_pattern, handler) { routeHandler = handler },
  }
  await installContextCapture(context, { append(record) { records.push(record) } }, {
    allowRealSubmit,
    blockSubmit: true,
    maxStake,
  })
  const calls = []
  await routeHandler({
    request: () => ({
      method: () => method,
      url: () => url,
      resourceType: () => 'xhr',
      headers: () => headers,
      postData: () => body,
    }),
    async continue() { calls.push('continue') },
    async abort(reason) { calls.push(`abort:${reason}`) },
  })
  return { calls, decision: records.at(-1) }
}

test('bounded real submit rejects every non-golds money field name case-insensitively', async () => {
  const moneyFields = [
    'gold', 'stake', 'stakes', 'amount', 'money', 'wager', 'betamount', 'bet_amount',
    'quantity',
  ]
  for (const field of moneyFields.flatMap((name) => [name, name.toUpperCase()])) {
    const result = await dispatchHttp({
      body: `p=FT_bet&golds=1&gid=8878933&gtype=FT&${field}=999999`,
      allowRealSubmit: true,
    })
    assert.deepEqual(result.calls, ['abort:blockedbyclient'], field)
    assert.equal(result.decision.blockReason, 'real-submit-stake-invalid', field)
    assert.equal(result.decision.dispatchCount, 0, field)
  }
})

test('multipart and JSON-like FT_bet fragments without outer braces fail closed', () => {
  const multipart = [
    '------offline',
    'Content-Disposition: form-data; name="p"',
    '',
    'FT_bet',
    '------offline',
    'Content-Disposition: form-data; name="golds"',
    '',
    '1',
    '------offline--',
  ].join('\r\n')
  const extendedMultipart = [
    '--offline',
    "Content-Disposition: form-data; name*=UTF-8''%70",
    '',
    'FT_bet',
    '--offline',
    "Content-Disposition: form-data; name*=UTF-8''%67olds",
    '',
    '1',
    '--offline--',
  ].join('\r\n')
  const foldedMultipart = [
    '--offline',
    'Content-Disposition: form-data;',
    ' name="p"',
    '',
    'FT_bet',
    '--offline',
    'Content-Disposition: form-data;',
    ' name="golds"',
    '',
    '1',
    '--offline--',
  ].join('\r\n')
  const records = [{
    method: 'POST', url: '/transform.php',
    headers: { 'content-type': 'multipart/form-data; boundary=----offline' },
    postData: multipart,
  }, {
    method: 'POST', url: '/transform.php', postData: multipart,
  }, {
    method: 'POST', url: '/transform.php',
    headers: { 'content-type': 'multipart/form-data; boundary=offline' },
    postData: extendedMultipart,
  }, {
    method: 'POST', url: '/transform.php',
    headers: { 'content-type': 'multipart/form-data; boundary=offline' },
    postData: foldedMultipart,
  }, {
    method: 'POST', url: '/transform.php',
    postData: '"p":"FT_bet","golds":"1"',
  }, {
    method: 'POST', url: '/transform.php',
    postData: 'p:"FT_bet",golds:"1"',
  }, {
    method: 'POST', url: '/transform.php',
    postData: 'prefix"p":"FT_bet","golds":"1"',
  }, {
    method: 'POST', url: '/transform.php',
    postData: '"p":"FT_bet","golds":"1",',
  }, {
    method: 'POST', url: '/transform.php',
    postData: 'prefix"p":"FT_bet","golds":"1" trailing',
  }, {
    method: 'POST', url: '/transform.php',
    postData: '"\\u0070":"FT_bet","golds":"1"',
  }, {
    method: 'POST', url: '/transform.php',
    postData: "prefix'p':'FT_bet','golds':'1' trailing",
  }, {
    method: 'POST', url: '/transform.php',
    postData: 'prefix p:FT_bet,golds:1 trailing',
  }]

  for (const record of records) {
    const decision = shouldBlockProtocolRequest(record)
    assert.equal(decision.classification.stage, 'submit')
    assert.equal(decision.block, true)
    assert.equal(decision.reason, 'real-submit-disabled')
  }

  assert.equal(shouldBlockProtocolRequest({
    method: 'POST', url: '/telemetry',
    postData: '"alphabet":"FT_bet","priority":"1","ordinary":"home"',
  }).block, false)
  assert.equal(shouldBlockProtocolRequest({
    method: 'POST', url: '/telemetry',
    postData: 'prefix"alphabet":"checkout","priority":"amount","ordinary":"selection" trailing',
  }).block, false)
})

test('exact submit operation tokens used as field names are blocked across structured transports', () => {
  const records = [{
    method: 'GET', url: '/transform.php?submit=1&money=1', postData: '',
  }, {
    method: 'POST', url: '/transform.php', postData: 'place=1&gid=event-offline',
  }, {
    method: 'POST', url: '/transform.php', postData: '{"confirm":true,"amount":1}',
  }, {
    method: 'POST', url: '/transform.php', postData: '[{"buy":true},{"quantity":1}]',
  }, {
    method: 'POST', url: '/transform.php',
    postData: '{"items":[{"ticket_add":true},{"selection":"home"}]}',
  }, {
    method: 'POST', url: '/transform.php', postData: 'checkout=1&amount=1',
  }, {
    method: 'POST', url: '/transform.php', postData: 'action=checkout&amount=1',
  }]

  for (const record of records) {
    const decision = shouldBlockProtocolRequest(record)
    assert.equal(decision.classification.stage, 'submit', JSON.stringify(record))
    assert.equal(decision.block, true, JSON.stringify(record))
  }

  assert.equal(shouldBlockProtocolRequest({
    method: 'POST', url: '/telemetry', postData: 'event=checkout&amount=1',
  }).block, false)
})

test('order-like GET and WebSocket handshake routes are blocked with truthful decisions', async () => {
  const record = {
    method: 'GET', url: '/bet.php?stake=1&selection=home', postData: '',
  }
  const direct = shouldBlockProtocolRequest(record)
  assert.equal(direct.block, true)
  assert.equal(direct.reason, 'unverified-order-route')
  assert.equal(direct.classification.stage, 'candidate')
  assert.equal(direct.classification.routeRisk, 'order-like-route')

  const http = await dispatchHttp(record)
  assert.deepEqual(http.calls, ['abort:blockedbyclient'])
  assert.equal(http.decision.blockReason, 'unverified-order-route')
  assert.equal(http.decision.classification.routeRisk, 'order-like-route')

  let webSocketHandler
  const target = {
    async routeWebSocket(_pattern, handler) { webSocketHandler = handler },
  }
  const decisions = []
  await installWebSocketSubmitBlocker(target, {
    recordWebSocketRouteDecision(_route, decision) { decisions.push(decision) },
  }, { blockSubmit: true })
  const calls = []
  await webSocketHandler({
    url: () => 'wss://offline.invalid/bet.php?stake=1&selection=home',
    connectToServer() { calls.push('connect'); return { send() {} } },
    onMessage() {},
    async close(options) { calls.push({ close: options }) },
  })
  assert.deepEqual(calls, [{ close: { code: 1008, reason: 'blocked-submit' } }])
  assert.equal(decisions.at(-1).decision, 'blocked')
  assert.equal(decisions.at(-1).blockReason, 'unverified-order-route')
  assert.equal(decisions.at(-1).classification.stage, 'candidate')
  assert.equal(decisions.at(-1).classification.routeRisk, 'order-like-route')
})

test('empty or opaque POSTs to order endpoints fail closed before dispatch', async () => {
  for (const record of [{
    method: 'POST', url: '/bet.php', body: '', headers: {},
  }, {
    method: 'POST', url: '/checkout', body: 'opaque', headers: { 'content-type': 'application/octet-stream' },
  }, {
    method: 'POST', url: '/order', body: Buffer.from([0, 1, 2]), headers: { 'content-type': 'application/octet-stream' },
  }]) {
    const direct = shouldBlockProtocolRequest({
      method: record.method,
      url: record.url,
      postData: record.body,
      headers: record.headers,
    })
    assert.equal(direct.block, true, record.url)
    assert.match(direct.reason, /^unverified-(?:post-candidate|order-route)$/, record.url)

    const http = await dispatchHttp(record)
    assert.deepEqual(http.calls, ['abort:blockedbyclient'], record.url)
    assert.equal(http.decision.dispatchCount, 0, record.url)
  }
})

test('WebSocket top-level JSON array Submit is classified and blocked as Submit', async () => {
  const payload = '[{"p":"FT_bet","golds":"1","gid":"event-offline"}]'
  const classification = classifyProtocolWebSocketFrame({
    url: 'wss://offline.invalid/socket', payload,
  })
  assert.equal(classification.stage, 'submit')

  let webSocketHandler
  const target = {
    async routeWebSocket(_pattern, handler) { webSocketHandler = handler },
  }
  const decisions = []
  await installWebSocketSubmitBlocker(target, {
    recordWebSocketRouteDecision(_route, decision) { decisions.push(decision) },
  }, { blockSubmit: true })
  let clientMessageHandler
  const sent = []
  await webSocketHandler({
    url: () => 'wss://offline.invalid/socket',
    connectToServer() { return { send(message) { sent.push(message) } } },
    onMessage(handler) { clientMessageHandler = handler },
    async close() {},
  })
  await clientMessageHandler(payload)
  assert.deepEqual(sent, [])
  assert.equal(decisions.at(-1).decision, 'blocked')
  assert.equal(decisions.at(-1).blockReason, 'real-submit-disabled')
  assert.equal(decisions.at(-1).classification.stage, 'submit')
})

test('10,000-level legal JSON produces stable route decisions without stack overflow', () => {
  const depth = 10_000
  const wrap = (leaf) => `${'{"nested":'.repeat(depth)}${leaf}${'}'.repeat(depth)}`
  const hazardous = {
    method: 'POST', url: '/transform.php',
    postData: wrap('{"submit":true,"money":1}'),
  }
  let hazardousDecision
  assert.doesNotThrow(() => { hazardousDecision = shouldBlockProtocolRequest(hazardous) })
  assert.equal(hazardousDecision.block, true)
  assert.equal(hazardousDecision.classification.stage, 'submit')

  const telemetry = {
    method: 'POST', url: '/telemetry',
    postData: wrap('{"alphabet":"ok","priority":"normal","ordinary":true}'),
  }
  let telemetryDecision
  assert.doesNotThrow(() => { telemetryDecision = shouldBlockProtocolRequest(telemetry) })
  assert.equal(telemetryDecision.block, false)
  assert.equal(telemetryDecision.classification.stage, 'unknown')
})
