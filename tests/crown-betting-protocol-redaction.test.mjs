import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSafeCrownProtocolEvidence,
  redactHeaders,
  redactBody,
  redactUrl,
  parseBody,
} from '../src/crown/betting-protocol/capture-redaction.mjs'

test('protocol evidence rejects credentials, raw bodies, tickets, and absolute paths', () => {
  const forbidden = [
    { uid: 'secret' }, { cookie: 'secret' }, { password: 'secret' },
    { ticket: 'raw-ticket' }, { rawBody: '<secret />' },
    { requestBody: 'uid=secret' }, { responseBody: '<ticket>raw</ticket>' },
    { sessionToken: 'secret' }, { cookieHeader: 'secret' }, { userUid: 'secret' },
    { artifactPath: 'C:\\Users\\owner\\capture.json' },
  ]
  for (const value of forbidden) {
    assert.throws(() => assertSafeCrownProtocolEvidence(value), /unsafe-crown-protocol-evidence/)
  }
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence({
    requestFieldSet: ['gid', 'p'],
    requestFieldSetFingerprint: `sha256:${'a'.repeat(64)}`,
    responseCode: '501',
    linkageTag: `hmac-sha256:${'b'.repeat(64)}`,
  }))
})

test('redactHeaders masks auth material', () => {
  const result = redactHeaders({
    cookie: 'a=1; b=2',
    authorization: 'Bearer abc',
    'set-cookie': 'sid=secret',
    'content-type': 'application/json',
  })

  assert.equal(result.cookie, '[masked:8]')
  assert.equal(result.authorization, '[masked:10]')
  assert.equal(result['set-cookie'], '[masked:10]')
  assert.equal(result['content-type'], 'application/json')
})

test('redactBody masks nested secret keys but preserves request shape', () => {
  const ticketId = ['24683', '749047'].join('')
  const result = redactBody({
    uid: 'real-uid',
    ticket_id: ticketId,
    w_id: `OU${ticketId}`,
    stake: 10,
    selection: { odds: '0.95', token: 'secret-token' },
  })

  assert.deepEqual(result, {
    uid: '[masked:8]',
    ticket_id: '[masked:11]',
    w_id: '[masked:13]',
    stake: 10,
    selection: { odds: '0.95', token: '[masked:12]' },
  })
})

test('redactUrl masks secret query values', () => {
  const result = redactUrl('https://example.test/order?uid=abc&gid=123&token=secret')
  assert.equal(result, 'https://example.test/order?uid=%5Bmasked%3A3%5D&gid=123&token=%5Bmasked%3A6%5D')
  assert.equal(redactUrl('not a url?uid=secret'), '[invalid-url]')
})

test('parseBody preserves existing objects and XML response text', () => {
  assert.deepEqual(parseBody({ p: 'FT_bet', gid: '123' }), { p: 'FT_bet', gid: '123' })
  assert.equal(parseBody('<serverresponse><code>560</code></serverresponse>'), '<serverresponse><code>560</code></serverresponse>')
})

test('redactBody masks ticket ids inside XML response text', () => {
  const ticketId = ['24683', '749047'].join('')
  const result = redactBody(`<?xml version="1.0"?><serverresponse><ticket_id>${ticketId}</ticket_id><status_N><ticket id='${ticketId}'>N</ticket></status_N></serverresponse>`)

  assert.equal(result.includes(ticketId), false)
  assert.match(result, /<ticket_id>\[masked:11\]<\/ticket_id>/)
  assert.match(result, /<ticket id='\[masked:11\]'>\[masked:1\]<\/ticket>/)
  assert.equal(redactBody('<serverresponse><ticket>raw-ticket</ticket></serverresponse>'),
    '<serverresponse><ticket>[masked:10]</ticket></serverresponse>')
})

test('parseBody preserves duplicate form fields so exact classifiers can reject them', () => {
  assert.deepEqual(parseBody('p=FT_order_view&gid=1&gid=2'), {
    p: 'FT_order_view', gid: ['1', '2'],
  })
})
