import test from 'node:test'
import assert from 'node:assert/strict'

import * as captureModule from '../scripts/crown-betting-protocol-capture.mjs'

import {
  CROWN_BROWSER_TARGETS,
  classifyProtocolRecord,
  shouldBlockProtocolRequest,
} from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  EIGHT_DIRECTION_CAPTURE_MANIFEST,
  assertCaptureSafety,
  captureContextOptions,
  installContextCapture,
  installRecorder,
  parseCaptureArgs,
  resolveMarketAvailability,
  runSequentialCaptureContexts,
} from '../scripts/crown-betting-protocol-capture.mjs'

function canonicalFtBetWire(golds = '1', extra = '') {
  return [
    'p=FT_bet', 'uid=uid-offline', 'ver=v1', 'langx=zh-cn', 'gid=event-offline',
    'gtype=FT', 'wtype=RE', 'rtype=REH', 'chose_team=H', `golds=${golds}`,
    'ioratio=0.96', 'con=1', 'ratio=50', 'autoOdd=Y', 'timestamp=1783987204990',
    'timestamp2=', 'isRB=Y', 'imp=N', 'ptype=', 'isYesterday=N', 'f=', 'odd_f_type=H',
  ].join('&') + extra
}

test('classifies likely bet slip preview request', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/transform.php',
    postData: 'p=order_view&gid=123&uid=secret&ior=0.95&gold=10',
  })

  assert.equal(result.stage, 'preview')
  assert.equal(result.confidence, 'medium')
  assert.ok(result.reasons.includes('order-like post parameter'))
})

test('canonical preview classification requires the exact captured request field set', () => {
  const exact = classifyProtocolRecord({
    type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=123&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret',
  })
  assert.equal(exact.stage, 'preview')
  assert.equal(exact.confidence, 'high')
  assert.deepEqual(exact.requestFieldSet, ['chose_team', 'gid', 'gtype', 'langx', 'odd_f_type', 'p', 'ver', 'wtype'])
  assert.match(exact.requestFieldSetFingerprint, /^sha256:[a-f0-9]{64}$/)

  const drift = classifyProtocolRecord({
    type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=123&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&extra=1',
  })
  assert.notEqual(drift.stage, 'preview')

  const duplicate = classifyProtocolRecord({
    type: 'request', method: 'POST', url: '/transform.php',
    postData: 'p=FT_order_view&gid=123&gid=456&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret',
  })
  assert.notEqual(duplicate.stage, 'preview')
})

test('capture recorder preserves the originating request sequence for out-of-order responses', async () => {
  const handlers = {}
  const records = []
  const page = { on(name, handler) { handlers[name] = handler } }
  const store = { append(record) { records.push(record) } }
  installRecorder(page, store)
  const request = (gid) => ({
    method: () => 'POST', url: () => '/transform.php', resourceType: () => 'xhr', headers: () => ({}),
    postData: () => `p=FT_order_view&gid=${gid}&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=secret`,
  })
  const first = request('first')
  const second = request('second')
  handlers.request(first)
  handlers.request(second)
  await handlers.response({
    request: () => first, url: () => '/transform.php', status: () => 200,
    headers: () => ({ 'content-type': 'application/xml' }),
    text: async () => '<serverresponse><code>501</code></serverresponse>',
  })
  assert.equal(records.at(-1).type, 'response')
  assert.equal(records.at(-1).seq, 1)
})

test('context capture covers new tabs and permits only one bounded real submit', async () => {
  const handlers = {}
  const records = []
  let routeHandler
  const context = {
    on(name, handler) { handlers[name] = handler },
    async routeWebSocket() {},
    async route(pattern, handler) {
      assert.equal(pattern, '**/*')
      routeHandler = handler
    },
  }
  await installContextCapture(context, { append(record) { records.push(record) } }, {
    allowRealSubmit: true,
    maxStake: 50,
  })
  assert.equal(typeof handlers.request, 'function')
  assert.equal(typeof handlers.response, 'function')
  assert.equal(typeof routeHandler, 'function')

  const routeFor = (stake, extra = '') => {
    const calls = []
    return {
      calls,
      route: {
        request: () => ({
          method: () => 'POST', url: () => '/transform.php', resourceType: () => 'xhr',
          headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
          postData: () => canonicalFtBetWire(stake, extra),
        }),
        async continue() { calls.push('continue') },
        async abort(reason) { calls.push(`abort:${reason}`) },
      },
    }
  }

  const tooLarge = routeFor(51)
  await routeHandler(tooLarge.route)
  assert.deepEqual(tooLarge.calls, ['abort:blockedbyclient'])
  assert.equal(records.at(-1).blockReason, 'real-submit-stake-invalid')

  const rounded = routeFor('50.000000000000001')
  await routeHandler(rounded.route)
  assert.deepEqual(rounded.calls, ['abort:blockedbyclient'])
  assert.equal(records.at(-1).blockReason, 'real-submit-stake-invalid')

  const first = routeFor(50)
  await routeHandler(first.route)
  assert.deepEqual(first.calls, ['continue'])

  const duplicate = routeFor(50)
  await routeHandler(duplicate.route)
  assert.deepEqual(duplicate.calls, ['abort:blockedbyclient'])
  assert.equal(records.at(-1).blockReason, 'real-submit-limit-exceeded')
})

test('bounded real submit accepts only one canonical form wire and rejects non-form or ambiguous raw transport', async () => {
  const dispatch = async ({
    url = '/transform.php',
    body,
    contentType = 'application/x-www-form-urlencoded; charset=UTF-8',
  }) => {
    const records = []
    let routeHandler
    const context = {
      on() {},
      async routeWebSocket() {},
      async route(_pattern, handler) { routeHandler = handler },
    }
    await installContextCapture(context, { append(record) { records.push(record) } }, {
      allowRealSubmit: true,
      maxStake: 50,
    })
    const calls = []
    await routeHandler({
      request: () => ({
        method: () => 'POST', url: () => url, resourceType: () => 'xhr',
        headers: () => contentType === null ? {} : { 'content-type': contentType },
        postData: () => body,
      }),
      async continue() { calls.push('continue') },
      async abort(reason) { calls.push(`abort:${reason}`) },
    })
    return { calls, decision: records.at(-1) }
  }

  for (const url of [
    'https://evil.invalid/transform.php',
    'https://m407.mos077.com/not-transform.php',
    'http://m407.mos077.com/transform.php',
    '/transform.php?golds=999999',
    '/transform.php?golds=1&golds=999999',
    '/transform.php?%67olds=999999',
    '/transform.php?%67%6f%6c%64%73=999999',
    '/transform.php?%2567olds=999999',
    '/transform.php?golds=%39%39%39%39%39%39',
    '/transform.php?golds%5B%5D=999999',
    '/transform.php?golds%2500=999999',
    '/transform.php?GOLDS=999999',
  ]) {
    const result = await dispatch({ url, body: canonicalFtBetWire() })
    assert.deepEqual(result.calls, ['abort:blockedbyclient'])
    assert.equal(result.decision.blockReason, 'real-submit-stake-invalid')
    assert.equal(result.decision.dispatchCount, 0)
  }

  for (const body of [
    'p=FT_bet&golds=1&golds=2&gid=8878933&gtype=FT',
    'p=FT_bet&p=get_game_list&golds=1&gid=8878933&gtype=FT',
    '%70=FT_bet&golds=1&gid=8878933&gtype=FT',
    'p=FT_bet&%67olds=1&gid=8878933&gtype=FT',
    'p=%46T_bet&golds=1&gid=8878933&gtype=FT',
    'p=FT_bet&golds=%31&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&golds%5B%5D=2&gid=8878933&gtype=FT',
    'p=FT_bet&golds%5B%5D=1&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&meta%5Bstake%5D=2&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&gold=999999&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&stake=999999&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&amount=999999&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&betAmount=999999&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&gid=8878933%00&gtype=FT',
    'p=FT_bet&golds=1&gid=8878933%2500&gtype=FT',
    'p=FT_bet&golds=1&GOLDS=2&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&%2567olds=2&gid=8878933&gtype=FT',
    'p=FT_bet&golds=1&golds%2500=2&gid=8878933&gtype=FT',
    'p=FT_bet&golds=01&gid=8878933&gtype=FT',
  ]) {
    const result = await dispatch({ body })
    assert.deepEqual(result.calls, ['abort:blockedbyclient'])
    assert.match(result.decision.blockReason, /^real-submit-(?:not-exact|stake-invalid)$/)
  }

  for (const field of ['unknownAmount', 'cash', 'total', 'price', 'qty']) {
    const result = await dispatch({ body: canonicalFtBetWire('1', `&${field}=999999`) })
    assert.deepEqual(result.calls, ['abort:blockedbyclient'], field)
    assert.equal(result.decision.blockReason, 'real-submit-stake-invalid', field)
    assert.equal(result.decision.dispatchCount, 0, field)
  }
  const missingField = await dispatch({
    body: canonicalFtBetWire().replace('&ratio=50', ''),
  })
  assert.deepEqual(missingField.calls, ['abort:blockedbyclient'])
  assert.equal(missingField.decision.blockReason, 'real-submit-stake-invalid')

  for (const probe of [{
    body: '{"p":"FT_bet","golds":"1","gid":"8878933","gtype":"FT"}',
    contentType: 'application/json',
  }, {
    body: '{"p":"FT_bet","golds":"999999","golds":"1","gid":"8878933","gtype":"FT"}',
    contentType: 'application/json',
  }, {
    body: '[{"p":"FT_bet","golds":"1"}]',
    contentType: 'application/json',
  }, {
    body: 'p=FT_bet&golds=1&gid=8878933&gtype=FT',
    contentType: 'application/json',
  }, {
    body: 'p=FT_bet&golds=1&gid=8878933&gtype=FT',
    contentType: null,
  }]) {
    const result = await dispatch(probe)
    assert.deepEqual(result.calls, ['abort:blockedbyclient'])
    assert.equal(result.decision.dispatchCount, 0)
  }

  const valid = await dispatch({ body: canonicalFtBetWire() })
  assert.deepEqual(valid.calls, ['continue'])
  assert.equal(valid.decision.dispatchCount, 1)

  for (const contentType of [
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=UTF-8',
    'application/x-www-form-urlencoded; charset=UTF8',
  ]) {
    const result = await dispatch({
      body: canonicalFtBetWire(), contentType,
    })
    assert.deepEqual(result.calls, ['continue'])
  }
  for (const contentType of [
    'application/x-www-form-urlencoded; charset=ISO-8859-1',
    'application/x-www-form-urlencoded; charset=UTF-8; boundary=x',
    'application/x-www-form-urlencoded; charset=UTF-8; charset=UTF8',
    'application/x-www-form-urlencoded; boundary=x',
  ]) {
    const result = await dispatch({
      body: canonicalFtBetWire(), contentType,
    })
    assert.deepEqual(result.calls, ['abort:blockedbyclient'])
    assert.equal(result.decision.blockReason, 'real-submit-stake-invalid')
  }

  const capturedWire = await dispatch({
    body: canonicalFtBetWire('50'),
  })
  assert.deepEqual(capturedWire.calls, ['continue'])
  assert.equal(capturedWire.decision.dispatchCount, 1)
})

test('default context capture blocks exact FT_bet even when monitor text conflicts with classification', async () => {
  const records = []
  let routeHandler
  const context = {
    on() {},
    async routeWebSocket() {},
    async route(_pattern, handler) { routeHandler = handler },
  }
  await installContextCapture(context, { append(record) { records.push(record) } }, {
    allowRealSubmit: false,
    maxStake: 0,
  })
  const calls = []
  await routeHandler({
    request: () => ({
      method: () => 'POST', url: () => '/transform.php', resourceType: () => 'xhr', headers: () => ({}),
      postData: () => 'p=FT_bet&golds=50&gid=8878933&gtype=FT&note=get_game_list',
    }),
    async continue() { calls.push('continue') },
    async abort(reason) { calls.push(`abort:${reason}`) },
  })
  assert.deepEqual(calls, ['abort:blockedbyclient'])
  assert.equal(records.at(-1).blockReason, 'real-submit-disabled')
})

test('capture browser context disables service workers', () => {
  assert.equal(captureContextOptions({ channel: 'msedge', headless: false }).serviceWorkers, 'block')
})

test('classifies likely submit request', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/bet.php',
    postData: 'action=submit&gid=123&stake=10&acceptBetterOdds=Y',
  })

  assert.equal(result.stage, 'submit')
  assert.ok(result.confidence === 'medium' || result.confidence === 'high')
})

test('classifies Crown FT_bet request as submit', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://64.188.47.32/transform.php',
    postData: 'p=FT_bet&golds=50&gid=8878933&gtype=FT&wtype=RE&rtype=REH&chose_team=H&ioratio=1.25',
  })

  assert.equal(result.stage, 'submit')
  assert.equal(result.confidence, 'high')
})

test('blocks submit requests when real submit is disabled', () => {
  const result = shouldBlockProtocolRequest({
    method: 'POST',
    url: 'https://64.188.47.32/transform.php',
    postData: 'p=FT_bet&golds=50&gid=8878933&gtype=FT',
  }, { allowRealSubmit: false })

  assert.equal(result.block, true)
  assert.equal(result.reason, 'real-submit-disabled')
})

test('allows submit requests only when real submit is enabled', () => {
  const result = shouldBlockProtocolRequest({
    method: 'POST',
    url: 'https://64.188.47.32/transform.php',
    postData: 'p=FT_bet&golds=50&gid=8878933&gtype=FT',
  }, { allowRealSubmit: true })

  assert.equal(result.block, false)
})

test('ignores read-only game list odds polling', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/transform.php',
    postData: 'p=get_game_list&gtype=ft&showtype=today',
  })

  assert.equal(result.stage, 'monitor')
  assert.equal(result.confidence, 'high')
})

test('monitor classification requires an exact verified read-only field allowlist', () => {
  const verifiedMore = classifyProtocolRecord({
    method: 'POST', url: '/transform.php',
    postData: 'p=get_game_more&gtype=ft&showtype=live&ltype=3&isRB=Y&lid=1&specialClick=&mode=CUP&from=game_more&filter=Main&ts=123&ecid=2&uid=u&langx=zh-cn',
  })
  assert.equal(verifiedMore.stage, 'monitor')
  assert.equal(verifiedMore.confidence, 'high')

  const drift = classifyProtocolRecord({
    method: 'POST', url: '/transform.php',
    postData: 'p=get_game_list&gtype=ft&unexpected=x',
  })
  assert.equal(drift.stage, 'candidate')
  assert.equal(drift.confidence, 'low')

  const broad = classifyProtocolRecord({
    method: 'GET', url: '/get_game_list_backup.php', postData: '',
  })
  assert.equal(broad.stage, 'candidate')
  assert.notEqual(broad.confidence, 'high')

  const wrongMethod = classifyProtocolRecord({
    method: 'GET', url: '/transform.php?p=get_game_list&gtype=ft', postData: '',
  })
  assert.equal(wrongMethod.stage, 'candidate')
  assert.notEqual(wrongMethod.confidence, 'high')
})

test('monitor operation allowlist is exact and cannot hide a Submit-like suffix', () => {
  const record = {
    method: 'POST', url: '/transform.php',
    postData: 'p=get_game_list_bet&stake=10&action=submit',
  }
  assert.equal(classifyProtocolRecord(record).stage, 'submit')
  assert.equal(shouldBlockProtocolRequest(record).block, true)
})

test('exposes one immutable eight-direction manifest in stable order', () => {
  assert.equal(CROWN_BROWSER_TARGETS.length, 8)
  assert.deepEqual(CROWN_BROWSER_TARGETS.map((target) => target.id), [
    'prematch-full-time-asian-handicap-home',
    'prematch-full-time-asian-handicap-away',
    'prematch-full-time-total-over',
    'prematch-full-time-total-under',
    'live-full-time-asian-handicap-home',
    'live-full-time-asian-handicap-away',
    'live-full-time-total-over',
    'live-full-time-total-under',
  ])
  assert.deepEqual(EIGHT_DIRECTION_CAPTURE_MANIFEST.map(({ ordinal, direction, submitPolicy }) => ({
    ordinal, direction: direction.id, submitPolicy,
  })), CROWN_BROWSER_TARGETS.map((direction, index) => ({
    ordinal: index + 1, direction: direction.id, submitPolicy: 'block-at-route',
  })))
  assert.equal(Object.isFrozen(CROWN_BROWSER_TARGETS), true)
  assert.equal(Object.isFrozen(CROWN_BROWSER_TARGETS[0]), true)
  assert.equal(Object.isFrozen(EIGHT_DIRECTION_CAPTURE_MANIFEST), true)
  assert.equal(Object.isFrozen(EIGHT_DIRECTION_CAPTURE_MANIFEST[0]), true)
})

test('capture CLI defaults to discover with blocking and rejects unsafe scenario combinations', () => {
  const defaults = parseCaptureArgs([])
  assert.equal(defaults.scenario, 'discover')
  assert.equal(defaults.blockSubmit, true)

  const eight = parseCaptureArgs(['--scenario', 'eight-direction', '--block-submit'])
  assert.equal(eight.scenario, 'eight-direction')
  assert.equal(eight.blockSubmit, true)
  assert.doesNotThrow(() => assertCaptureSafety(eight))

  assert.throws(() => parseCaptureArgs(['--scenario', 'unknown']), /invalid --scenario/)
  assert.throws(() => assertCaptureSafety(parseCaptureArgs([
    '--scenario', 'eight-direction', '--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '1',
  ])), /eight-direction.*allow-real-submit/)
})

test('market unavailable final confirmation requires an earlier unavailable claim', async () => {
  const answers = ['WAIT', 'SWITCH_MATCH', 'CONFIRM_MARKET_UNAVAILABLE', 'MARKET_UNAVAILABLE', 'CONFIRM_MARKET_UNAVAILABLE']
  const result = await resolveMarketAvailability({
    async question() { return answers.shift() },
    async waitForMarket() {},
    async switchMatch() {},
  })
  assert.deepEqual(result, {
    status: 'market-unavailable', attemptCount: 5, waited: true, switchedMatch: true,
    finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
  })
})

test('market unavailable recording preserves the explicit final confirmation evidence', () => {
  assert.equal(typeof captureModule.recordMarketAvailability, 'function')
  const markers = []
  captureModule.recordMarketAvailability({
    recordMarker(type, fields) { markers.push({ type, ...fields }) },
  }, {
    status: 'market-unavailable', attemptCount: 4, waited: true, switchedMatch: true,
    finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
  })
  assert.deepEqual(markers, [{
    type: 'market-unavailable', marketConclusion: 'operator-confirmed',
    attemptCount: 4, waited: true, switchedMatch: true,
    finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
  }])
})

test('unified context recorder shares seq and event ordinals across redirect, failure, and route decision', async () => {
  const handlers = {}
  const records = []
  const context = {
    pages: () => [],
    on(name, handler) { handlers[name] = handler },
  }
  const controller = installRecorder(context, { append(record) { records.push(record) } }, {
    captureRunId: 'run-a', direction: 'direction-a', sessionGeneration: 'generation-a',
  })
  const original = {
    method: () => 'GET', url: () => 'https://offline.invalid/old', resourceType: () => 'document',
    headers: () => ({}), postData: () => '', redirectedFrom: () => null,
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
  }
  const redirected = {
    method: () => 'GET', url: () => 'https://offline.invalid/new', resourceType: () => 'document',
    headers: () => ({}), postData: () => '', redirectedFrom: () => original,
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
  }

  handlers.request(original)
  handlers.request(redirected)
  controller.recordRouteDecision(redirected, {
    decision: 'blocked', blockReason: 'real-submit-disabled', dispatchCount: 0,
  })
  handlers.requestfailed(redirected)
  await controller.flush()

  const redirectedRows = records.filter((record) => record.seq === 2)
  assert.deepEqual(redirectedRows.map((record) => record.type), [
    'request', 'redirect', 'route-decision', 'requestfailed',
  ])
  assert.ok(redirectedRows.every((record) => record.captureRunId === 'run-a'))
  assert.ok(redirectedRows.every((record) => record.direction === 'direction-a'))
  assert.equal(new Set(records.map((record) => record.eventOrdinal)).size, records.length)
  assert.deepEqual(records.map((record) => record.eventOrdinal), [1, 2, 3, 4, 5])
  assert.equal(redirectedRows[1].redirectedFromSeq, 1)
})

test('recorder flush waits for response bodies without changing the reserved event order', async () => {
  const handlers = {}
  const records = []
  let release
  const delayed = new Promise((resolve) => { release = resolve })
  const context = {
    pages: () => [],
    on(name, handler) { handlers[name] = handler },
  }
  const controller = installRecorder(context, { append(record) { records.push(record) } })
  const request = {
    method: () => 'GET', url: () => 'https://offline.invalid/data', resourceType: () => 'fetch',
    headers: () => ({}), postData: () => '', redirectedFrom: () => null,
  }
  handlers.request(request)
  handlers.response({
    request: () => request, url: () => request.url(), status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => delayed,
  })
  controller.recordRouteDecision(request, { decision: 'continued', dispatchCount: 1 })
  assert.deepEqual(records.map((record) => record.eventOrdinal), [1, 3])
  release('{"ok":true}')
  await controller.flush()
  assert.deepEqual(records.sort((a, b) => a.eventOrdinal - b.eventOrdinal).map((record) => record.type), [
    'request', 'response', 'route-decision',
  ])
  assert.equal(records.find((record) => record.type === 'response').eventOrdinal, 2)
})

test('recorder covers WebSocket lifecycle on existing and newly-created pages', async () => {
  const contextHandlers = {}
  const records = []
  const page = () => {
    const handlers = {}
    return { handlers, on(name, handler) { handlers[name] = handler } }
  }
  const existing = page()
  const context = {
    pages: () => [existing],
    on(name, handler) { contextHandlers[name] = handler },
  }
  const controller = installRecorder(context, { append(record) { records.push(record) } })
  const newlyCreated = page()
  contextHandlers.page(newlyCreated)

  for (const currentPage of [existing, newlyCreated]) {
    const socketHandlers = {}
    currentPage.handlers.websocket({
      url: () => 'wss://offline.invalid/socket',
      on(name, handler) { socketHandlers[name] = handler },
    })
    socketHandlers.framesent({ payload: 'outbound' })
    socketHandlers.framereceived({ payload: Buffer.from('inbound') })
    socketHandlers.socketerror('private-error')
    socketHandlers.close()
  }
  await controller.flush()

  assert.deepEqual(records.map((record) => record.type), [
    'websocket-open', 'websocket-send', 'websocket-receive', 'websocket-error', 'websocket-close',
    'websocket-open', 'websocket-send', 'websocket-receive', 'websocket-error', 'websocket-close',
  ])
  assert.equal(records[0].seq, records[4].seq)
  assert.notEqual(records[0].seq, records[5].seq)
  assert.equal(records[1].payload, 'outbound')
  assert.equal(Buffer.isBuffer(records[2].payload), true)
})

test('eight-direction runner creates, flushes, and closes independent contexts sequentially', async () => {
  const events = []
  const contexts = []
  const result = await runSequentialCaptureContexts({
    manifest: EIGHT_DIRECTION_CAPTURE_MANIFEST,
    async createContext(item) {
      const context = {
        id: item.ordinal,
        async close() { events.push(`close:${item.ordinal}`) },
      }
      contexts.push(context)
      events.push(`create:${item.ordinal}`)
      return context
    },
    async captureDirection({ context, item }) {
      events.push(`capture:${item.ordinal}:${context.id}`)
      return { captureRunId: `run-${item.ordinal}` }
    },
  })

  assert.equal(result.length, 8)
  assert.equal(new Set(contexts).size, 8)
  assert.deepEqual(events, EIGHT_DIRECTION_CAPTURE_MANIFEST.flatMap((item) => [
    `create:${item.ordinal}`, `capture:${item.ordinal}:${item.ordinal}`, `close:${item.ordinal}`,
  ]))
})

test('sequential runner flushes responses that arrive while the context closes', async () => {
  const handlers = {}
  const records = []
  let request
  const context = {
    pages: () => [],
    on(name, handler) { handlers[name] = handler },
    async close() {
      handlers.response({
        request: () => request, url: () => request.url(), status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        text: () => new Promise((resolve) => setImmediate(() => resolve('{"late":true}'))),
      })
    },
  }
  await runSequentialCaptureContexts({
    manifest: [{ ordinal: 1 }],
    async createContext() { return context },
    async captureDirection() {
      const controller = installRecorder(context, { append(record) { records.push(record) } })
      request = {
        method: () => 'GET', url: () => 'https://offline.invalid/late', resourceType: () => 'fetch',
        headers: () => ({}), postData: () => '', redirectedFrom: () => null,
      }
      handlers.request(request)
      return { controller }
    },
  })

  assert.equal(records.some((record) => (
    record.type === 'response' && record.responseBody === '{"late":true}'
  )), true)
})
