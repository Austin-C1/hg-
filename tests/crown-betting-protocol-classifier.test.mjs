import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyProtocolRecord, shouldBlockProtocolRequest } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import { installRecorder } from '../scripts/crown-betting-protocol-capture.mjs'

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
