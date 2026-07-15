import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSafeCrownProtocolEvidence,
  redactCapturedBody,
  redactHeaders,
  redactBody,
  redactUrl,
  parseBody,
  parseJsonRejectDuplicateKeys,
  projectCrownProtocolShape,
} from '../src/crown/betting-protocol/capture-redaction.mjs'

test('protocol evidence rejects credentials, raw bodies, tickets, and absolute paths', () => {
  const forbidden = [
    { uid: 'secret' }, { cookie: 'secret' }, { password: 'secret' },
    { username: 'private-user' }, { user: 'private-user' },
    { account: 'private-account' }, { member: 'private-member' }, { mid: 'private-member-id' },
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
    accountBinding: `hmac-sha256:${'c'.repeat(64)}`,
    sessionBinding: `hmac-sha256:${'d'.repeat(64)}`,
    executionIdentityBinding: `hmac-sha256:${'e'.repeat(64)}`,
    resultReferenceBinding: `hmac-sha256:${'f'.repeat(64)}`,
  }))
  assert.throws(() => assertSafeCrownProtocolEvidence({
    sessionBinding: 'not-an-irreversible-binding',
  }), /unsafe-crown-protocol-evidence/)
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

test('captured login identity, passcode, and browser fingerprint fields are always masked', () => {
  const form = redactCapturedBody(
    'username=PrivateUsername&user=PrivateUser&account=PrivateAccount&member=PrivateMember&mid=PrivateMid&passcode=PrivatePasscode&userAgent=PrivateUserAgent&p=chk_login',
    { 'content-type': 'application/x-www-form-urlencoded' },
  )
  const xml = redactCapturedBody(
    '<serverresponse><username>PrivateXmlUsername</username><user>PrivateXmlUser</user><account>PrivateXmlAccount</account><member>PrivateXmlMember</member><mid>PrivateXmlMid</mid><passcode>PrivateXmlPasscode</passcode></serverresponse>',
    { 'content-type': 'application/xml' },
  )

  for (const secret of [
    'PrivateUsername', 'PrivateUser', 'PrivateAccount', 'PrivateMember', 'PrivateMid',
    'PrivatePasscode', 'PrivateUserAgent',
  ]) assert.equal(JSON.stringify(form).includes(secret), false)
  for (const secret of [
    'PrivateXmlUsername', 'PrivateXmlUser', 'PrivateXmlAccount', 'PrivateXmlMember',
    'PrivateXmlMid', 'PrivateXmlPasscode',
  ]) assert.equal(String(xml).includes(secret), false)
})

test('redactUrl masks secret query values', () => {
  const result = redactUrl('https://example.test/order?uid=abc&gid=123&token=secret&username=PrivateUsername&account=PrivateAccount&member=PrivateMember&mid=PrivateMid')
  const parsed = new URL(result)
  assert.equal(parsed.searchParams.get('gid'), '123')
  for (const key of ['uid', 'token', 'username', 'account', 'member', 'mid']) {
    assert.match(parsed.searchParams.get(key), /^\[masked:\d+\]$/)
  }
  for (const secret of ['abc', 'secret', 'PrivateUsername', 'PrivateAccount', 'PrivateMember', 'PrivateMid']) {
    assert.equal(result.includes(secret), false)
  }
  assert.equal(redactUrl('not a url?uid=secret'), '[invalid-url]')
})

test('parseBody preserves existing objects and XML response text', () => {
  assert.deepEqual(parseBody({ p: 'FT_bet', gid: '123' }), { p: 'FT_bet', gid: '123' })
  assert.equal(parseBody('<serverresponse><code>560</code></serverresponse>'), '<serverresponse><code>560</code></serverresponse>')
})

test('captured CSS and JavaScript stay opaque instead of being parsed as form fields', () => {
  const css = 'body{background:url("/asset?uid=PrivateAssetUser&theme=dark")}'
  const redacted = redactCapturedBody(css, { 'content-type': 'text/css; charset=utf-8' })

  assert.equal(typeof redacted, 'string')
  assert.equal(redacted.includes('PrivateAssetUser'), false)
  assert.match(redacted, /masked/i)
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

test('strict JSON duplicate-key scan preserves native semantics without recursive depth limits', () => {
  const depth = 10_000
  const source = `${'['.repeat(depth)}0${']'.repeat(depth)}`
  const parsed = parseJsonRejectDuplicateKeys(source)
  let cursor = parsed
  for (let index = 0; index < depth; index += 1) cursor = cursor[0]
  assert.equal(cursor, 0)

  assert.throws(
    () => parseJsonRejectDuplicateKeys('{"a":1,"\\u0061":2}'),
    (error) => error?.code === 'DUPLICATE_JSON_KEY' && error.duplicateKey === 'a',
  )
})

test('structural projection removes dynamic and sensitive values while binding the full shape', () => {
  const projected = projectCrownProtocolShape({
    p: 'FT_order_view', gid: 'dynamic-gid', odds: 0.96, suspended: false,
    uid: 'private-uid', nested: { line: '-0.5' },
  }, {
    hmacKey: Buffer.alloc(32, 9), domain: 'test/request/v1',
  })

  assert.deepEqual(projected.fields, [
    { name: 'gid', type: 'string' },
    { name: 'nested', type: 'object' },
    { name: 'nested.line', type: 'string' },
    { name: 'odds', type: 'number' },
    { name: 'p', type: 'string' },
    { name: 'suspended', type: 'boolean' },
  ])
  assert.equal(projected.excludedSensitiveFieldCount, 1)
  assert.match(projected.fullFieldSetBinding, /^hmac-sha256:[a-f0-9]{64}$/)
  const serialized = JSON.stringify(projected)
  for (const forbidden of ['dynamic-gid', 'private-uid', 'FT_order_view', '-0.5', '0.96']) {
    assert.equal(serialized.includes(forbidden), false)
  }
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence(projected))
})

test('WebSocket string and Buffer projections retain only shape, bucket, and HMAC', () => {
  const text = projectCrownProtocolShape('private-websocket-text', {
    hmacKey: Buffer.alloc(32, 9), domain: 'test/websocket/v1',
  })
  const binary = projectCrownProtocolShape(Buffer.from('private-websocket-buffer'), {
    hmacKey: Buffer.alloc(32, 9), domain: 'test/websocket/v1',
  })

  assert.deepEqual(Object.keys(text).sort(), ['fullFieldSetBinding', 'lengthBucket', 'valueType'])
  assert.equal(text.valueType, 'string')
  assert.equal(binary.valueType, 'buffer')
  assert.match(binary.fullFieldSetBinding, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify([text, binary]).includes('private-websocket'), false)
})

test('structural projection folds dynamic object keys without publishing IDs', () => {
  const projected = projectCrownProtocolShape({
    8878933: { odds: '0.97' },
    'event-123456': { line: '-0.5' },
    '123e4567-e89b-12d3-a456-426614174000': { side: 'home' },
  }, { hmacKey: Buffer.alloc(32, 9), domain: 'test/dynamic-map/v1' })
  const serialized = JSON.stringify(projected)

  assert.equal(projected.dynamicFieldNameCount, 3)
  assert.ok(projected.fields.some((field) => field.name === '[*]'))
  assert.ok(projected.fields.some((field) => field.name === '[*].odds'))
  for (const forbidden of ['8878933', 'event-123456', '123e4567-e89b-12d3-a456-426614174000']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('safe evidence rejects raw URL, origin, body, Buffer, and false HMAC bindings', () => {
  for (const value of [
    { url: '/transform.php' },
    { origin: 'offline.invalid' },
    { body: 'private' },
    { path: '/transform.php' },
    { frame: Buffer.from('private') },
    { endpointPath: 'https://offline.invalid/transform.php' },
    { endpointPath: '/transform.php?uid=private' },
    { endpointPath: '/api/private-user-alpha/secret-token-value' },
    { sourceBinding: `sha256:${'a'.repeat(64)}` },
    { runBinding: `hmac-sha256:${'a'.repeat(63)}` },
    { identityBinding: 'plaintext' },
  ]) {
    assert.throws(() => assertSafeCrownProtocolEvidence(value), /unsafe-crown-protocol-evidence/)
  }
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence({
    endpointPath: '/transform.php',
    sourceBinding: `hmac-sha256:${'a'.repeat(64)}`,
    runBinding: `hmac-sha256:${'b'.repeat(64)}`,
    identityBinding: `hmac-sha256:${'c'.repeat(64)}`,
  }))
})

test('redaction removes URL userinfo, API keys, and malformed JSON-like secret fragments', () => {
  const headers = redactHeaders({
    'x-api-key': 'PrivateApiKeyAlpha',
    apiKey: 'PrivateApiKeyBeta',
    accept: 'application/json',
  })
  const url = redactUrl('https://PrivateUser:PrivatePassword@offline.invalid/transform.php?gid=1')

  assert.equal(headers['x-api-key'].includes('PrivateApiKeyAlpha'), false)
  assert.equal(headers.apiKey.includes('PrivateApiKeyBeta'), false)
  assert.equal(headers.accept, 'application/json')
  assert.equal(url.includes('PrivateUser'), false)
  assert.equal(url.includes('PrivatePassword'), false)
  assert.equal(new URL(url).username.startsWith('%5Bmasked%3A'), true)
  assert.equal(new URL(url).password.startsWith('%5Bmasked%3A'), true)
  assert.equal(
    redactCapturedBody('prefix"token":"PrivateTokenAlpha"', { 'content-type': 'text/plain' }),
    '[unparseable-json]',
  )
  assert.equal(
    redactCapturedBody('prefix"\\u0074oken":"PrivateTokenBeta"', { 'content-type': 'text/plain' }),
    '[unparseable-json]',
  )
  assert.deepEqual(
    redactCapturedBody('{"\\u0061pi_key":"PrivateApiKeyGamma"}', 'application/json'),
    { api_key: '[masked:18]' },
  )

  for (const fragmentUrl of [
    'https://offline.invalid/transform.php#token=PrivateFragmentAlpha&gid=1',
    'https://offline.invalid/transform.php#%74%6f%6b%65%6e=Private%46ragmentBeta',
    'https://offline.invalid/transform.php#/route?api_key=PrivateFragmentGamma&gid=1',
  ]) {
    const redacted = redactUrl(fragmentUrl)
    assert.equal(/Private(?:Fragment|%46ragment)/.test(redacted), false)
    assert.match(redacted, /masked/i)
  }

  for (const nestedUrl of [
    'https://offline.invalid/transform.php?payload=%7B%22api_key%22%3A%22PrivateNestedQuery%22%7D&gid=1',
    'https://offline.invalid/transform.php#token=PrivateFragment&payload=%7B%22uid%22%3A%22PrivateNestedFragment%22%7D',
  ]) {
    const redacted = redactUrl(nestedUrl)
    assert.equal(redacted.includes('PrivateNested'), false)
  }
})

test('structural projection folds pure-alphabetic private aliases while retaining stable wire fields', () => {
  const projected = projectCrownProtocolShape({
    code: '0',
    roster: {
      CafeOwnerPrivateAlias: { odds: '0.96', suspended: false },
      BobOwnerPrivateAlias: { odds: '0.97', suspended: true },
      alice: { odds: '0.98', suspended: false },
      bob: { odds: '0.99', suspended: true },
      home: { odds: '1.00', suspended: false },
      code: { odds: '1.01', suspended: true },
      id: { odds: '1.02', suspended: false },
      name: { odds: '1.03', suspended: true },
    },
  }, { hmacKey: Buffer.alloc(32, 9), domain: 'test/private-alias-map/v1' })
  const serialized = JSON.stringify(projected)

  assert.equal(serialized.includes('CafeOwnerPrivateAlias'), false)
  assert.equal(serialized.includes('BobOwnerPrivateAlias'), false)
  assert.equal(serialized.includes('alice'), false)
  assert.equal(serialized.includes('bob'), false)
  assert.equal(projected.fields.some((field) => /^roster\.(?:home|code|id|name)(?:\.|$)/.test(field.name)), false)
  assert.ok(projected.fields.some((field) => field.name === 'code'))
  assert.ok(projected.fields.some((field) => field.name === 'roster.[*].odds'))
  assert.ok(projected.fields.some((field) => field.name === 'roster.[*].suspended'))
  assert.equal(projected.dynamicFieldNameCount, 8)
})

test('homogeneous map folding preserves reviewed fixed-shape structural paths', () => {
  const projected = projectCrownProtocolShape({
    data: {
      home: { odds: '0.96', suspended: false },
      away: { odds: '0.97', suspended: true },
    },
    meta: { code: '0', id: 'schema-id', name: 'stable-name' },
  }, { hmacKey: Buffer.alloc(32, 9), domain: 'test/fixed-structure/v1' })

  assert.ok(projected.fields.some((field) => field.name === 'data.home.odds'))
  assert.ok(projected.fields.some((field) => field.name === 'data.away.suspended'))
  assert.ok(projected.fields.some((field) => field.name === 'meta.code'))
  assert.ok(projected.fields.some((field) => field.name === 'meta.id'))
  assert.ok(projected.fields.some((field) => field.name === 'meta.name'))
})

test('dynamic roster keys fold even for one member or heterogeneous child shapes', () => {
  for (const roster of [
    { home: { odds: '0.96' } },
    { home: { odds: '0.96' }, id: { status: 'active', nested: true } },
  ]) {
    const projected = projectCrownProtocolShape(
      { code: '0', roster },
      { hmacKey: Buffer.alloc(32, 9), domain: 'test/path-aware-roster/v1' },
    )
    assert.equal(projected.fields.some((field) => /^roster\.(?:home|id)(?:\.|$)/.test(field.name)), false)
    assert.ok(projected.fields.some((field) => field.name.startsWith('roster.[*].')))
  }
})
