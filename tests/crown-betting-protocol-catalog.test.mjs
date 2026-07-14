import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildCrownEightDirectionCandidates,
  buildCrownProtocolArtifact,
  buildCrownProtocolCatalogCandidate,
  buildCrownStaticWireEvidence,
  writeCrownProtocolCatalogArtifacts,
} from '../scripts/crown-betting-protocol-analyze.mjs'
import { CROWN_BROWSER_TARGETS } from '../src/crown/betting-protocol/protocol-classifier.mjs'
import { assertSafeCrownProtocolEvidence } from '../src/crown/betting-protocol/capture-redaction.mjs'

const HMAC_KEY = Buffer.alloc(32, 23)

function xml(fields) {
  return `<serverresponse>${Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`).join('')}</serverresponse>`
}

function ordinaryRecords() {
  return [{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php?uid=never-public',
    postData: 'p=get_game_list&gtype=ft&showtype=today&gid=dynamic-list-a',
  }, {
    seq: 1, eventOrdinal: 2, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php?uid=never-public',
    responseBody: xml({ code: '0', gid: 'dynamic-list-a', timestamp: 'dynamic-time-a' }),
  }, {
    seq: 2, eventOrdinal: 3, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php',
    postData: 'p=FT_order_view&gid=dynamic-preview-a&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1&uid=private-session-a',
  }, {
    seq: 2, eventOrdinal: 4, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php',
    responseBody: xml({ code: '501', spread: '-0.5', ioratio: '0.97', username: 'private-user-a' }),
  }, {
    seq: 3, eventOrdinal: 5, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php',
    postData: 'p=FT_bet&gid=dynamic-submit-a&gtype=FT&wtype=RE&chose_team=H&golds=50&ioratio=0.97&ratio=50&uid=private-session-a',
  }, {
    seq: 3, eventOrdinal: 6, type: 'route-decision', method: 'POST',
    url: 'https://offline.invalid/transform.php', decision: 'blocked',
    blockReason: 'real-submit-disabled', dispatchCount: 0,
    postData: 'p=FT_bet&gid=dynamic-submit-a&gtype=FT&wtype=RE&chose_team=H&golds=50&ioratio=0.97&ratio=50&uid=private-session-a',
  }, {
    seq: 3, eventOrdinal: 7, type: 'requestfailed', method: 'POST',
    url: 'https://offline.invalid/transform.php', failure: 'net::ERR_BLOCKED_BY_CLIENT',
  }, {
    seq: 4, eventOrdinal: 8, type: 'request', method: 'GET', resourceType: 'xhr',
    url: 'https://offline.invalid/results.php?day=dynamic-day-a', postData: '',
  }, {
    seq: 4, eventOrdinal: 9, type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/results.php?day=dynamic-day-a',
    responseBody: JSON.stringify({ result: 'dynamic-result-a', count: 1 }),
  }, {
    seq: 5, eventOrdinal: 10, type: 'request', method: 'POST', resourceType: 'fetch',
    url: 'https://offline.invalid/telemetry.php', postData: JSON.stringify({ event: 'dynamic-event-a' }),
  }, {
    seq: 5, eventOrdinal: 11, type: 'requestfailed', method: 'POST',
    url: 'https://offline.invalid/telemetry.php', failure: 'net::ERR_FAILED',
  }, {
    seq: 6, eventOrdinal: 12, type: 'request', method: 'GET', resourceType: 'document',
    url: 'https://offline.invalid/old.php', postData: '',
  }, {
    seq: 7, eventOrdinal: 13, type: 'request', method: 'GET', resourceType: 'document',
    url: 'https://offline.invalid/new.php', redirectedFromSeq: 6, postData: '',
  }, {
    seq: 7, eventOrdinal: 14, type: 'redirect', method: 'GET',
    url: 'https://offline.invalid/new.php', redirectedFromSeq: 6,
  }, {
    seq: 8, eventOrdinal: 15, type: 'websocket-open',
    url: 'wss://offline.invalid/socket?token=never-public',
  }, {
    seq: 9, eventOrdinal: 16, type: 'websocket-route-decision', method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket?token=never-public', source: 'frame', payloadKind: 'text',
    postData: 'p=get_game_list&gtype=FT', decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['verified operation contract'] },
  }, {
    seq: 8, eventOrdinal: 17, type: 'websocket-send', payload: 'p=get_game_list&gtype=FT',
  }, {
    seq: 8, eventOrdinal: 18, type: 'websocket-receive', payload: Buffer.from('dynamic-ws-receive-a'),
  }, {
    seq: 8, eventOrdinal: 19, type: 'websocket-error', error: 'private socket error a',
  }, {
    seq: 8, eventOrdinal: 20, type: 'websocket-close',
  }]
}

function directionRecords(target, ordinal, overrides = {}) {
  const captureRunId = overrides.captureRunId || `private-run-${ordinal}`
  const sessionGeneration = overrides.sessionGeneration || `private-generation-${ordinal}`
  const gid = overrides.gid || `private-gid-${ordinal}`
  const uid = overrides.uid || `private-uid-${ordinal}`
  const sideCode = overrides.sideCode || (['home', 'over'].includes(target.side) ? 'H' : 'C')
  const wtype = overrides.wtype || (target.marketType === 'asian_handicap'
    ? (target.mode === 'live' ? 'RE' : 'R')
    : (target.mode === 'live' ? 'ROU' : 'OU'))
  const rtype = overrides.rtype || `${wtype}${sideCode}`
  const isRB = overrides.isRB || (target.mode === 'live' ? 'Y' : 'N')
  const f = overrides.f ?? (target.mode === 'live' ? '' : '1R')
  const line = overrides.line || (target.marketType === 'total' ? '2.5' : '-0.5')
  const odds = overrides.odds || '0.96'
  const common = { captureRunId, direction: target.id, sessionGeneration }
  return [{
    ...common, seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php',
    postData: `p=FT_order_view&gid=${gid}&gtype=FT&wtype=${wtype}&chose_team=${sideCode}&langx=zh-cn&odd_f_type=H&ver=v1&uid=${uid}`,
  }, {
    ...common, seq: 1, eventOrdinal: 2, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php',
    responseBody: xml({ code: '501', spread: line, ioratio: odds }),
  }, {
    ...common, seq: 2, eventOrdinal: 3, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php',
    postData: `p=FT_bet&gid=${overrides.submitGid || gid}&gtype=FT&wtype=${wtype}&rtype=${rtype}&isRB=${isRB}&chose_team=${sideCode}&f=${f}&golds=50&ioratio=${overrides.submitOdds || odds}&ratio=${line}&uid=${overrides.submitUid || uid}`,
  }, {
    ...common, seq: 2, eventOrdinal: 4, type: 'route-decision', method: 'POST',
    url: 'https://offline.invalid/transform.php', decision: 'blocked',
    blockReason: 'real-submit-disabled', dispatchCount: overrides.dispatchCount ?? 0,
    postData: `p=FT_bet&gid=${overrides.submitGid || gid}&gtype=FT&wtype=${wtype}&rtype=${rtype}&isRB=${isRB}&chose_team=${sideCode}&f=${f}&golds=50&ioratio=${overrides.submitOdds || odds}&ratio=${line}&uid=${overrides.submitUid || uid}`,
  }, {
    ...common, seq: 2, eventOrdinal: 5, type: 'requestfailed', method: 'POST',
    url: 'https://offline.invalid/transform.php', failure: 'net::ERR_BLOCKED_BY_CLIENT',
  }]
}

function allDirectionRecords() {
  return CROWN_BROWSER_TARGETS.flatMap((target, index) => directionRecords(target, index + 1))
}

test('catalog aggregates endpoint, function, method, and exact field set without dynamic values', () => {
  const records = ordinaryRecords()
  records.push({
    ...records[0], seq: 10, eventOrdinal: 21,
    postData: 'p=get_game_list&gtype=ft&showtype=tomorrow&gid=dynamic-list-b',
  }, {
    ...records[1], seq: 10, eventOrdinal: 22,
    responseBody: xml({ code: '0', gid: 'dynamic-list-b', timestamp: 'dynamic-time-b' }),
  }, {
    ...records[0], seq: 11, eventOrdinal: 23,
    postData: 'p=get_game_list&gtype=ft&showtype=today&gid=dynamic-list-c&league=dynamic-league',
  })

  const catalog = buildCrownProtocolCatalogCandidate(records, {
    captureId: 'private-capture-id', hmacKey: HMAC_KEY,
  })
  const listEntries = catalog.entries.filter((entry) => entry.functionName === 'get_game_list')

  assert.equal(catalog.schemaVersion, 'crown-protocol-catalog-candidate-v1')
  assert.equal(listEntries.length, 2)
  assert.equal(listEntries.find((entry) => entry.request.fields.length === 4).occurrenceCount, 2)
  assert.ok(catalog.entries.some((entry) => entry.functionName === 'FT_order_view'))
  assert.ok(catalog.entries.some((entry) => entry.functionName === 'FT_bet'))
  assert.ok(catalog.entries.some((entry) => entry.endpointPath === '/[redacted]'))
  assert.ok(catalog.entries.filter((entry) => entry.endpointPath === '/[redacted]')
    .every((entry) => /^hmac-sha256:[a-f0-9]{64}$/.test(entry.endpointPathBinding)))
  assert.ok(catalog.entries.some((entry) => entry.transport === 'websocket'))
  assert.ok(catalog.entries.some((entry) => entry.lifecycle.includes('requestfailed')))
  assert.ok(catalog.entries.some((entry) => entry.lifecycle.includes('redirect')))
  assert.ok(catalog.entries.every((entry) => /^hmac-sha256:[a-f0-9]{64}$/.test(entry.evidenceBinding)))
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence(catalog))

  const serialized = JSON.stringify(catalog)
  for (const forbidden of [
    'offline.invalid', 'private-capture-id', 'dynamic-list-a', 'dynamic-list-b',
    'private-session-a', 'dynamic-result-a', 'dynamic-ws-send-a', 'private socket error a',
  ]) assert.equal(serialized.includes(forbidden), false)
  assert.doesNotMatch(serialized, /https?:|wss?:|\?uid=|postData|responseBody|payload/i)
  assert.equal(serialized.includes('"type":"Buffer"'), false)
})

test('catalog identifies a document POST as form transport', () => {
  const catalog = buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'document',
    url: 'https://offline.invalid/form.php', postData: 'action=preview&selection=home',
  }], { captureId: 'capture', hmacKey: HMAC_KEY })

  assert.equal(catalog.entries[0].transport, 'form')
})

test('catalog fails closed on ambiguous sequence, duplicate fields, short keys, and unknown sensitive fields', async (t) => {
  await t.test('duplicate response for one seq', () => {
    const records = ordinaryRecords()
    records.push({ ...records[1], eventOrdinal: 21 })
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:duplicate-response/)
  })
  await t.test('duplicate event ordinal in one run', () => {
    const records = ordinaryRecords()
    records[1].eventOrdinal = records[0].eventOrdinal
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:duplicate-event-ordinal/)
  })
  await t.test('response URL and method do not match request', () => {
    const records = ordinaryRecords()
    records[1].url = 'https://offline.invalid/other.php'
    records[1].method = 'GET'
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:lifecycle-correlation/)
  })
  await t.test('route decision precedes request', () => {
    const records = ordinaryRecords()
    records[4].eventOrdinal = 6
    records[5].eventOrdinal = 5
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:lifecycle-order/)
  })
  await t.test('duplicate form field', () => {
    const records = ordinaryRecords()
    records[0].postData += '&gid=duplicate'
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:duplicate-field/)
  })
  await t.test('nested duplicate JSON request field', () => {
    const records = ordinaryRecords()
    records[9].postData = '{"event":"safe","meta":{"value":1,"value":2}}'
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:duplicate-field/)
  })
  await t.test('nested duplicate JSON response field', () => {
    const records = ordinaryRecords()
    records[8].responseBody = '{"result":"safe","items":[{"value":1,"value":2}]}'
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:duplicate-field/)
  })
  await t.test('unknown sensitive field', () => {
    const records = ordinaryRecords()
    records[0].postData += '&account_token=private'
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:unknown-sensitive-field/)
  })
  await t.test('nested unknown sensitive field', () => {
    const records = ordinaryRecords()
    records[8].responseBody = JSON.stringify({ metadata: { account_token: 'private' } })
    assert.throws(() => buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    }), /catalog:unknown-sensitive-field/)
  })
  await t.test('short HMAC key', () => {
    assert.throws(() => buildCrownProtocolCatalogCandidate(ordinaryRecords(), {
      captureId: 'capture', hmacKey: Buffer.alloc(31),
    }), /catalog:hmac-key-too-short/)
  })
})

test('catalog preserves JSON array type without publishing array values', () => {
  const catalog = buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'fetch',
    url: 'https://offline.invalid/list.json', postData: '',
  }, {
    seq: 1, eventOrdinal: 2, type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/list.json',
    responseBody: JSON.stringify({ items: [{ gid: 'private-gid' }] }),
  }], { captureId: 'capture', hmacKey: HMAC_KEY })

  assert.deepEqual(catalog.entries[0].response.fields, [{ name: 'items', type: 'array' }])
  assert.equal(JSON.stringify(catalog).includes('private-gid'), false)
})

test('catalog keeps different nested field sets as separate entries', () => {
  const request = (seq, eventOrdinal) => ({
    seq, eventOrdinal, type: 'request', method: 'GET', resourceType: 'fetch',
    url: 'https://offline.invalid/nested.json', postData: '',
  })
  const response = (seq, eventOrdinal, data) => ({
    seq, eventOrdinal, type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/nested.json', responseBody: JSON.stringify({ data }),
  })
  const catalog = buildCrownProtocolCatalogCandidate([
    request(1, 1), response(1, 2, { left: 'private-a' }),
    request(2, 3), response(2, 4, { right: 'private-b' }),
  ], { captureId: 'capture', hmacKey: HMAC_KEY })

  assert.equal(catalog.entries.length, 2)
  assert.deepEqual(catalog.entries.map((entry) => entry.response.fields.at(-1).name).sort(), [
    'data.left', 'data.right',
  ])
})

test('catalog preserves repeated XML fields as array structure', () => {
  const catalog = buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'GET', resourceType: 'xhr',
    url: 'https://offline.invalid/list.xml', postData: '',
  }, {
    seq: 1, eventOrdinal: 2, type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/list.xml',
    responseBody: '<serverresponse><gid>private-a</gid><gid>private-b</gid></serverresponse>',
  }], { captureId: 'capture', hmacKey: HMAC_KEY })

  assert.deepEqual(catalog.entries[0].response.fields, [{ name: 'gid', type: 'array' }])
  assert.doesNotMatch(JSON.stringify(catalog), /private-[ab]/)
})

test('catalog restores Buffer shape after the private JSONL round trip', () => {
  const records = ordinaryRecords().map((record) => JSON.parse(JSON.stringify(record)))
  const catalog = buildCrownProtocolCatalogCandidate(records, {
    captureId: 'capture', hmacKey: HMAC_KEY,
  })
  const websocket = catalog.entries.find((entry) => Array.isArray(entry.frames))
  assert.equal(websocket.frames[1].valueType, 'buffer')
  assert.equal(websocket.frames[1].lengthBucket, '1-32')
})

test('legacy structural artifact also folds dynamic field names for modern captures', () => {
  const artifact = buildCrownProtocolArtifact([{
    type: 'request', method: 'POST', url: 'https://offline.invalid/transform.php',
    postData: JSON.stringify({ 8878933: { odds: 'private' } }),
  }], { captureId: 'capture' })
  const serialized = JSON.stringify(artifact)

  assert.deepEqual(artifact.records[0].request.fieldSet, ['[*]'])
  assert.equal(serialized.includes('8878933'), false)

  for (const postData of [
    'opaque-private-request-sentinel',
    '<private-request><odds>sentinel</odds></private-request>',
  ]) {
    const opaqueArtifact = buildCrownProtocolArtifact([{
      type: 'request', method: 'POST', url: 'https://offline.invalid/transform.php', postData,
    }], { captureId: 'capture' })
    assert.deepEqual(opaqueArtifact.records[0].request.fieldSet, [])
    assert.doesNotMatch(JSON.stringify(opaqueArtifact), /opaque-private|private-request|sentinel/)
  }
})

test('all analyzer layers fail closed on duplicate JSON keys at arbitrary depth while legal arrays remain valid', () => {
  const duplicateRequest = {
    type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php',
    postData: '{"p":"get_game_list","meta":{"items":[{"value":1,"value":2}]}}',
  }
  assert.throws(() => buildCrownProtocolArtifact([duplicateRequest], {
    captureId: 'capture',
  }), /catalog:duplicate-field/)

  const duplicateResponse = {
    type: 'response', method: 'GET', status: 200,
    url: 'https://offline.invalid/results.php',
    responseBody: '{"items":[{"value":1,"value":2}]}',
  }
  assert.throws(() => buildCrownProtocolArtifact([duplicateResponse], {
    captureId: 'capture',
  }), /catalog:duplicate-field/)

  const records = directionRecords(CROWN_BROWSER_TARGETS[0], 1)
  records[0].postData = '{"p":"FT_order_view","meta":{"gid":"one","gid":"two"}}'
  assert.throws(() => buildCrownEightDirectionCandidates(records, {
    expectedDirections: [CROWN_BROWSER_TARGETS[0]], captureId: 'capture', hmacKey: HMAC_KEY,
  }), /catalog:duplicate-field/)

  assert.doesNotThrow(() => buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'fetch',
    url: 'https://offline.invalid/telemetry.php',
    postData: '{"items":[{"value":1},{"value":2}],"escaped\\u006bey":"ok"}',
  }], { captureId: 'capture', hmacKey: HMAC_KEY }))

  assert.throws(() => buildCrownProtocolCatalogCandidate([{
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'fetch',
    url: 'https://offline.invalid/telemetry.php',
    postData: `{\u00a0"event":"safe"}`,
  }], { captureId: 'capture', hmacKey: HMAC_KEY }), /catalog:json-invalid/)
})

test('legacy structural stages are always recomputed from raw transport fields and ignore forged metadata', () => {
  const records = [{
    type: 'request', method: 'POST', url: 'https://offline.invalid/transform.php',
    postData: 'p=FT_bet&golds=1&gid=8878933&gtype=FT',
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  }, {
    type: 'request', method: 'POST', url: 'https://offline.invalid/transform.php',
    postData: 'p=get_game_list&gtype=FT',
    classification: { stage: 'submit', confidence: 'high', reasons: ['forged'] },
  }, {
    type: 'request', method: 'POST', url: 'https://offline.invalid/transform.php',
    postData: 'p=FT_order_view&gid=123&gtype=FT&wtype=RE&chose_team=H&langx=zh-cn&odd_f_type=H&ver=v1',
    classification: { stage: 'unknown', confidence: 'low', reasons: ['forged'] },
  }, {
    type: 'request', method: 'GET', url: 'https://offline.invalid/unclassified', postData: '',
    classification: { stage: 'preview', confidence: 'high', reasons: ['forged'] },
  }]

  const artifact = buildCrownProtocolArtifact(records, { captureId: 'capture' })
  assert.deepEqual(artifact.records.map((record) => record.stage), [
    'submit', 'monitor', 'preview', 'unknown',
  ])
})

test('static wire evidence uses an explicit allowlist and never promotes repeated dynamic values', () => {
  const records = ordinaryRecords()
  records.push({ ...records[0], seq: 10, eventOrdinal: 21 })
  const artifact = buildCrownStaticWireEvidence(records, {
    captureId: 'private-capture-id', hmacKey: HMAC_KEY,
  })
  const serialized = JSON.stringify(artifact)

  assert.equal(artifact.schemaVersion, 'crown-static-wire-evidence-v1')
  assert.ok(artifact.entries.some((entry) => entry.functionName === 'FT_order_view'))
  assert.equal(serialized.includes('dynamic-list-a'), false)
  assert.equal(serialized.includes('private-capture-id'), false)
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence(artifact))
})

test('WebSocket route-decision catalog recomputes URL stage and enforces frame fail-closed invariants', () => {
  const buildUrlDecision = (overrides) => buildCrownProtocolCatalogCandidate([{
    seq: 1,
    eventOrdinal: 1,
    type: 'websocket-route-decision',
    method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket?p=FT_bet&golds=50',
    source: 'url',
    decision: 'blocked',
    dispatchCount: 0,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
    ...overrides,
  }], { captureId: 'capture', hmacKey: HMAC_KEY })
  const buildFrameDecision = ({ payload = 'foo=bar', includeSend, ...overrides } = {}) => {
    const decision = {
      seq: 2, eventOrdinal: 2, type: 'websocket-route-decision', method: 'WEBSOCKET',
      url: 'wss://offline.invalid/socket', source: 'frame',
      payloadKind: typeof payload === 'string' ? 'text' : 'binary',
      ...(typeof payload === 'string' ? { postData: payload } : {}),
      decision: 'blocked', dispatchCount: 0,
      classification: { stage: 'unknown', confidence: 'low', reasons: ['test'] },
      ...overrides,
    }
    const shouldSend = includeSend ?? decision.decision === 'continued'
    const records = [{
      seq: 1, eventOrdinal: 1, type: 'websocket-open',
      url: 'wss://offline.invalid/socket',
    }, decision]
    if (shouldSend) records.push({
      seq: 1, eventOrdinal: 3, type: 'websocket-send', payload,
    })
    return buildCrownProtocolCatalogCandidate(records, {
      captureId: 'capture', hmacKey: HMAC_KEY,
    })
  }

  assert.throws(() => buildUrlDecision({
    decision: 'continued',
    dispatchCount: 1,
  }), /crown-protocol-catalog:websocket-route-decision-invalid/)

  const blockedUrlSubmit = buildUrlDecision()
  assert.equal(blockedUrlSubmit.entries[0].stage, 'submit')

  for (const invalidFrame of [{
    payload: Buffer.from('opaque-binary'),
    payloadKind: 'binary',
    decision: 'continued',
    dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  }, {
    payload: Buffer.from('opaque-binary'),
    payloadKind: 'binary',
    decision: 'blocked',
    dispatchCount: 0,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  }, {
    payload: 'action=order_view&selection=home',
    payloadKind: 'text',
    decision: 'blocked',
    dispatchCount: 0,
    classification: { stage: 'preview', confidence: 'high', reasons: ['forged'] },
  }, {
    payload: 'stake=50',
    payloadKind: 'text',
    decision: 'continued',
    dispatchCount: 1,
    classification: { stage: 'candidate', confidence: 'low', reasons: ['forged'] },
  }, {
    payload: 'p=FT_bet&golds=50',
    payloadKind: 'text',
    decision: 'continued',
    dispatchCount: 1,
    classification: { stage: 'submit', confidence: 'high', reasons: ['forged'] },
  }]) {
    assert.throws(() => buildFrameDecision(invalidFrame), /crown-protocol-catalog:websocket-route-decision-invalid/)
  }

  assert.equal(buildFrameDecision({
    payload: 'stake',
    classification: { stage: 'unknown', confidence: 'low', reasons: ['uninspectable websocket frame'] },
  }).entries.find((entry) => entry.lifecycle.includes('websocket-route-decision')).routeOutcome, 'blocked')

  assert.throws(() => buildFrameDecision({
    payload: 'p=FT_bet&golds=50',
    decision: 'continued',
    dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  }), /crown-protocol-catalog:websocket-route-decision-invalid/)

  assert.throws(() => buildFrameDecision({
    payload: 'p=get_game_list&gtype=FT',
    postData: 'p=get_member_data&change=1',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged payload match'] },
  }), /crown-protocol-catalog:websocket-frame-evidence-invalid/)

  assert.throws(() => buildFrameDecision({
    payload: 'p=get_game_list&gtype=FT',
    url: 'wss://offline.invalid/other-socket',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged URL'] },
  }), /crown-protocol-catalog:websocket-frame-evidence-invalid/)

  assert.equal(buildFrameDecision({
    payload: 'p=get_game_list&gtype=FT',
    decision: 'continued', dispatchCount: 1,
    classification: { stage: 'monitor', confidence: 'high', reasons: ['verified operation contract'] },
  }).entries.find((entry) => entry.lifecycle.includes('websocket-route-decision')).routeOutcome, 'continued')
})

test('HTTP catalog recomputes classification and enforces route dispatch transitions', () => {
  const request = {
    seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php', postData: 'p=FT_bet&golds=50',
    classification: { stage: 'monitor', confidence: 'high', reasons: ['forged'] },
  }
  const route = {
    seq: 1, eventOrdinal: 2, type: 'route-decision', method: 'POST',
    url: request.url, postData: request.postData, decision: 'blocked', dispatchCount: 0,
  }
  const build = (routeOverrides = {}) => buildCrownProtocolCatalogCandidate([
    request, { ...route, ...routeOverrides },
  ], { captureId: 'capture', hmacKey: HMAC_KEY })

  const entry = build().entries[0]
  assert.equal(entry.stage, 'submit')
  assert.equal(entry.routeOutcome, 'blocked')
  assert.equal(entry.dispatchCount, 0)
  assert.throws(() => build({ dispatchCount: 1 }), /crown-protocol-catalog:route-decision-invalid/)
  assert.throws(() => build({ decision: 'continued' }), /crown-protocol-catalog:route-decision-invalid/)
})

test('builds eight isolated zero-Submit candidates without enabling production Submit', () => {
  const artifact = buildCrownEightDirectionCandidates(allDirectionRecords(), {
    expectedDirections: CROWN_BROWSER_TARGETS,
    captureId: 'private-scenario-id',
    hmacKey: HMAC_KEY,
  })

  assert.equal(artifact.schemaVersion, 'crown-eight-direction-candidates-v1')
  assert.equal(artifact.candidates.length, 8)
  assert.deepEqual(artifact.candidates.map((candidate) => candidate.ordinal), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(artifact.candidates.map((candidate) => candidate.status), [
    'candidate', 'candidate', 'incomplete', 'incomplete',
    'candidate', 'candidate', 'incomplete', 'incomplete',
  ])
  assert.ok(artifact.candidates.filter((candidate) => candidate.status === 'incomplete')
    .every((candidate) => candidate.reason === 'EVIDENCE_REQUIRED'))
  assert.ok(artifact.candidates.every((candidate) => candidate.dispatchCount === 0))
  assert.ok(artifact.candidates.every((candidate) => candidate.submitAllowed === false))
  assert.ok(artifact.candidates.every((candidate) => candidate.capabilityPromoted === false))
  assert.ok(artifact.candidates.every((candidate) => /^hmac-sha256:[a-f0-9]{64}$/.test(candidate.runBinding)))
  assert.ok(artifact.candidates.filter((candidate) => candidate.status === 'candidate')
    .every((candidate) => /^hmac-sha256:[a-f0-9]{64}$/.test(candidate.identityBinding)))
  assert.ok(artifact.candidates.every((candidate) => /^hmac-sha256:[a-f0-9]{64}$/.test(candidate.directionWireBinding)))
  assert.doesNotThrow(() => assertSafeCrownProtocolEvidence(artifact))

  const serialized = JSON.stringify(artifact)
  assert.doesNotMatch(serialized, /private-(?:run|generation|gid|uid|scenario)/)
})

test('eight-direction candidates fail closed on cross-run splice, identity drift, duplicate attempts, and dispatch', async (t) => {
  await t.test('cross-run splice', () => {
    const records = allDirectionRecords()
    records[2].captureRunId = records[5].captureRunId
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:(?:cross-run|run-integrity)/)
  })
  await t.test('identity drift', () => {
    const records = CROWN_BROWSER_TARGETS.flatMap((target, index) => directionRecords(
      target, index + 1, index === 0 ? { submitGid: 'other-gid' } : {},
    ))
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:identity-drift/)
  })
  await t.test('Preview and Submit wire identity drift', () => {
    const records = allDirectionRecords()
    records[2].postData = records[2].postData.replace('wtype=R', 'wtype=DRIFT')
    records[3].postData = records[3].postData.replace('wtype=R', 'wtype=DRIFT')
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:identity-drift/)
  })
  await t.test('Preview response is after Submit request', () => {
    const records = allDirectionRecords()
    records[1].eventOrdinal = 4
    records[3].eventOrdinal = 2
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:chronology/)
  })
  await t.test('duplicate Preview', () => {
    const records = allDirectionRecords()
    records.splice(2, 0, { ...records[0], seq: 3, eventOrdinal: 6 })
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:preview-count/)
  })
  await t.test('dispatch count is non-zero', () => {
    const records = CROWN_BROWSER_TARGETS.flatMap((target, index) => directionRecords(
      target, index + 1, index === 0 ? { dispatchCount: 1 } : {},
    ))
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:submit-dispatched/)
  })
  await t.test('Submit response exists', () => {
    const records = allDirectionRecords()
    records.splice(5, 0, {
      ...records[2], type: 'response', eventOrdinal: 6, status: 200, responseBody: xml({ code: '560' }),
    })
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:submit-response-present/)
  })
  await t.test('route decision p does not match Submit request', () => {
    const records = allDirectionRecords()
    records[3].postData = records[3].postData.replace('p=FT_bet', 'p=get_game_list')
    assert.throws(() => buildCrownEightDirectionCandidates(records, {
      expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:route-correlation/)
  })
  for (const scenario of [
    {
      name: 'Preview code is not the verified success code',
      responseBody: xml({ code: '999', spread: '-0.5', ioratio: '0.96' }),
      expected: /eight-direction:preview-code-unverified/,
    },
    {
      name: 'Preview success code is missing',
      responseBody: xml({ spread: '-0.5', ioratio: '0.96' }),
      expected: /eight-direction:preview-code-unverified/,
    },
    {
      name: 'Preview success code is duplicated',
      responseBody: '<serverresponse><code>501</code><code>501</code><spread>-0.5</spread><ioratio>0.96</ioratio></serverresponse>',
      expected: /eight-direction:preview-code-unverified/,
    },
    {
      name: 'Preview HTTP response is not successful',
      status: 500,
      responseBody: xml({ code: '501', spread: '-0.5', ioratio: '0.96' }),
      expected: /eight-direction:preview-response-unsuccessful/,
    },
  ]) {
    await t.test(scenario.name, () => {
      const records = allDirectionRecords()
      records[1] = {
        ...records[1],
        status: scenario.status ?? records[1].status,
        responseBody: scenario.responseBody,
      }
      assert.throws(() => buildCrownEightDirectionCandidates(records, {
        expectedDirections: CROWN_BROWSER_TARGETS, captureId: 'scenario', hmacKey: HMAC_KEY,
      }), scenario.expected)
    })
  }
})

test('market-unavailable requires an explicit operator conclusion and cannot hide partial traffic', () => {
  const [target] = CROWN_BROWSER_TARGETS
  const common = {
    captureRunId: 'private-run-unavailable', direction: target.id,
    sessionGeneration: 'private-generation-unavailable',
  }
  const explicit = [{
    ...common, seq: 1, eventOrdinal: 1, type: 'request', method: 'POST', resourceType: 'xhr',
    url: 'https://offline.invalid/transform.php', postData: 'p=get_game_list&gtype=ft',
  }, {
    ...common, seq: 1, eventOrdinal: 2, type: 'response', method: 'POST', status: 200,
    url: 'https://offline.invalid/transform.php', responseBody: xml({ code: '0' }),
  }, {
    ...common, seq: 2, eventOrdinal: 3,
    type: 'market-unavailable', marketConclusion: 'operator-confirmed',
    finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
    attemptCount: 4, waited: true, switchedMatch: true,
  }]
  const artifact = buildCrownEightDirectionCandidates(explicit, {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  })
  assert.equal(artifact.candidates[0].status, 'market-unavailable')
  assert.equal(artifact.candidates[0].submitAllowed, false)

  const firstOccurrenceOnly = explicit.map((record) => (record.type === 'market-unavailable'
    ? {
        ...record,
        attemptCount: 1,
        waited: false,
        switchedMatch: false,
        finalConfirmation: undefined,
      }
    : record))
  assert.throws(() => buildCrownEightDirectionCandidates(firstOccurrenceOnly, {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  }), /eight-direction:market-unavailable-partial/)
  assert.throws(() => buildCrownEightDirectionCandidates([...explicit, {
    ...common,
    seq: 3,
    eventOrdinal: 4,
    type: 'websocket-route-decision',
    method: 'WEBSOCKET',
    url: 'wss://offline.invalid/socket',
    source: 'frame',
    payloadKind: 'text',
    postData: 'p=FT_bet&golds=50',
    decision: 'blocked',
    dispatchCount: 0,
    classification: { stage: 'submit', confidence: 'high', reasons: ['exact p=FT_bet'] },
  }], {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  }), /eight-direction:market-unavailable-partial/)
  assert.throws(() => buildCrownEightDirectionCandidates([...explicit, {
    ...common,
    seq: 3,
    eventOrdinal: 4,
    type: 'websocket-send',
    url: 'wss://offline.invalid/socket',
    payload: 'p=FT_bet&golds=50',
    classification: { stage: 'candidate', confidence: 'low', reasons: ['forged metadata'] },
  }], {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  }), /eight-direction:market-unavailable-partial/)

  for (const postData of [
    'p=get_game_list&action=submit&stake=50',
    'action=order_view&selection=home',
  ]) {
    assert.throws(() => buildCrownEightDirectionCandidates([...explicit, {
      ...common,
      seq: 3,
      eventOrdinal: 4,
      type: 'request',
      method: 'POST',
      resourceType: 'xhr',
      url: 'https://offline.invalid/transform.php',
      postData,
    }, {
      ...common,
      seq: 3,
      eventOrdinal: 5,
      type: 'route-decision',
      method: 'POST',
      url: 'https://offline.invalid/transform.php',
      postData,
      decision: 'blocked',
      dispatchCount: 0,
    }], {
      expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
    }), /eight-direction:market-unavailable-partial/)
  }

  assert.throws(() => buildCrownEightDirectionCandidates([], {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  }), /eight-direction:missing-run/)
  assert.throws(() => buildCrownEightDirectionCandidates([
    ...explicit,
    ...directionRecords(target, 1).map((record) => ({
      ...record,
      captureRunId: common.captureRunId,
      sessionGeneration: common.sessionGeneration,
      seq: record.seq + 2,
      eventOrdinal: record.eventOrdinal + 3,
    })),
  ], {
    expectedDirections: [target], captureId: 'scenario', hmacKey: HMAC_KEY,
  }), /eight-direction:market-unavailable-partial/)
})

test('writer creates the three public safe artifacts and no dynamic public fixture', () => {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-protocol-catalog-'))
  fs.mkdirSync(path.join(captureDir, 'public'), { recursive: true })
  const records = allDirectionRecords()
  const result = writeCrownProtocolCatalogArtifacts(captureDir, {
    records,
    expectedDirections: CROWN_BROWSER_TARGETS,
    captureId: 'private-scenario-id',
    hmacKey: HMAC_KEY,
  })

  assert.deepEqual(Object.keys(result).sort(), [
    'eightDirectionCandidates', 'protocolCatalog', 'staticWireEvidence',
  ])
  for (const name of [
    'protocol-catalog.safe.json',
    'eight-direction-candidates.safe.json',
    'static-wire-evidence.safe.json',
  ]) {
    const output = fs.readFileSync(path.join(captureDir, 'public', name), 'utf8')
    assert.equal(output.includes('private-'), false)
    assert.doesNotMatch(output, /https?:|wss?:|postData|responseBody|raw-network/i)
    assert.equal(output.includes('"type": "Buffer"'), false)
    assert.doesNotThrow(() => assertSafeCrownProtocolEvidence(JSON.parse(output)))
  }
})
