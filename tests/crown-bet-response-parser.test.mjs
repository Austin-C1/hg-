import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fingerprintCrownResponseFieldSet,
  parseCrownPreviewResponse,
  parseCrownPreviewResponseStrict,
  parseCrownSubmitResponse,
  parseCrownSubmitResponseStrict,
  parseCrownDangerousStatus,
} from '../src/crown/betting/crown-bet-response-parser.mjs'
import { fingerprintCrownFieldSet } from '../src/crown/betting/crown-capability-matrix.mjs'

function strictError(xml) {
  try {
    parseCrownPreviewResponseStrict(xml)
  } catch (error) {
    return error
  }
  assert.fail('expected strict preview parse to fail')
}

test('parses preview limits and current line', () => {
  const xml = '<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>4 / 4.5</spread><strong>C</strong></serverresponse>'
  assert.deepEqual(parseCrownPreviewResponse(xml), {
    ok: true,
    code: '560',
    minStake: 10,
    maxStake: 500,
    oddsRaw: '0.75',
    spread: '4 / 4.5',
    strong: 'C',
    message: '',
  })
})

test('marks preview without odds and limits as not ok', () => {
  const xml = '<serverresponse><code>error</code></serverresponse>'
  assert.deepEqual(parseCrownPreviewResponse(xml), {
    ok: false,
    code: 'error',
    minStake: null,
    maxStake: null,
    oddsRaw: '',
    spread: '',
    strong: '',
    message: '',
  })
})

test('keeps Crown preview rejection details for diagnostics', () => {
  const xml = '<serverresponse><code>555</code><errormsg>1X001</errormsg><systime>2026-07-08</systime><fast_check>ROUC</fast_check></serverresponse>'
  assert.deepEqual(parseCrownPreviewResponse(xml), {
    ok: false,
    code: '555',
    minStake: null,
    maxStake: null,
    oddsRaw: '',
    spread: '',
    strong: '',
    message: '1X001',
    errorMessage: '1X001',
    systemTime: '2026-07-08',
    fastCheck: 'ROUC',
  })
})

test('strict preview preserves exact evidenced fields without treating maxcredit as capacity', () => {
  const xml = '<serverresponse><code>501</code><gold_gmin>10.00</gold_gmin><gold_gmax>500.25</gold_gmax><ioratio>0.750</ioratio><spread>-0 / 0.5</spread><strong>C</strong><maxcredit>1234.50</maxcredit></serverresponse>'
  const result = parseCrownPreviewResponseStrict(xml)

  assert.equal(result.ok, true)
  assert.deepEqual(result.minStake, { raw: '10.00', exact: '10', source: 'gold_gmin', verified: true })
  assert.deepEqual(result.maxStake, { raw: '500.25', exact: '500.25', source: 'gold_gmax', verified: true })
  assert.deepEqual(result.odds, { raw: '0.750', exact: '0.75', source: 'ioratio', verified: true })
  assert.deepEqual(result.line, { raw: '-0 / 0.5', exact: '0 / 0.5', source: 'spread', verified: true })
  assert.equal(result.maxCreditRaw, '1234.50')
  assert.equal(result.maxCreditSemantics, 'unverified')
  assert.deepEqual(result.currency, { value: null, source: 'not-evidenced-in-preview-response', verified: false })
  assert.deepEqual(result.stakeStep, { value: null, source: 'not-evidenced-in-preview-response', verified: false })
  assert.equal('balance' in result, false)
  assert.equal('capacity' in result, false)
  assert.equal('maxCredit' in result, false)
  assert.match(result.responseFieldSetFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(result.diagnostics, {
    code: '501',
    responseFieldSet: result.responseFieldSet,
    responseFieldSetFingerprint: result.responseFieldSetFingerprint,
  })
})

test('response field-set fingerprint is order-independent and changes on provider drift', () => {
  const original = fingerprintCrownResponseFieldSet(['code', 'gold_gmin', 'gold_gmax', 'ioratio', 'spread'])
  const reordered = fingerprintCrownResponseFieldSet(['spread', 'ioratio', 'gold_gmax', 'code', 'gold_gmin'])
  const drifted = fingerprintCrownResponseFieldSet(['code', 'gold_gmin', 'gold_gmax', 'ioratio', 'spread', 'currency'])
  const caseDrifted = fingerprintCrownResponseFieldSet(['Code', 'gold_gmin', 'gold_gmax', 'ioratio', 'spread'])

  assert.equal(original, reordered)
  assert.equal(original, fingerprintCrownFieldSet(['spread', 'ioratio', 'gold_gmax', 'code', 'gold_gmin']))
  assert.notEqual(original, drifted)
  assert.notEqual(original, caseDrifted)
})

test('strict preview rejects duplicate, malformed, missing, unsafe, and inverted evidenced values', () => {
  const valid = {
    code: '<code>501</code>',
    min: '<gold_gmin>10</gold_gmin>',
    max: '<gold_gmax>500</gold_gmax>',
    odds: '<ioratio>0.75</ioratio>',
    line: '<spread>4 / 4.5</spread>',
  }
  const response = (...fields) => `<serverresponse>${fields.join('')}</serverresponse>`
  const cases = [
    [response(valid.code, valid.min, '<gold_gmin>20</gold_gmin>', valid.max, valid.odds, valid.line), 'duplicate-preview-field:gold_gmin'],
    [response(valid.code, '<gold_gmin>10oops</gold_gmin>', valid.max, valid.odds, valid.line), 'malformed-preview-field:gold_gmin'],
    [response(valid.code, valid.min, valid.max, valid.line), 'missing-preview-field:ioratio'],
    [response(valid.code, '<gold_gmin>0.0000001</gold_gmin>', valid.max, valid.odds, valid.line), 'unsafe-preview-precision:gold_gmin'],
    [response(valid.code, '<gold_gmin>9007199254740992</gold_gmin>', valid.max, valid.odds, valid.line), 'unsafe-preview-precision:gold_gmin'],
    [response(valid.code, '<gold_gmin>501</gold_gmin>', '<gold_gmax>500</gold_gmax>', valid.odds, valid.line), 'preview-min-exceeds-max'],
    ['<serverresponse><code>501</code><gold_gmin>10</gold_gmin>', 'malformed-preview-response'],
  ]

  for (const [xml, code] of cases) assert.equal(strictError(xml).code, code)
})

test('strict preview parse failures expose only sanitized diagnostics', () => {
  const error = strictError('<serverresponse><code>error</code><errormsg>password=do-not-leak</errormsg></serverresponse>')
  const serialized = JSON.stringify(error.diagnostics)

  assert.equal(error.code, 'unknown-preview-code')
  assert.equal(serialized.includes('do-not-leak'), false)
  assert.equal(serialized.includes('password'), false)
  assert.match(error.diagnostics.responseFieldSetFingerprint, /^sha256:[a-f0-9]{64}$/)
})

test('strict preview fails closed for a syntactically valid but unevidenced response code', () => {
  const xml = '<serverresponse><code>999</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>0 / 0.5</spread><strong>H</strong></serverresponse>'
  const error = strictError(xml)
  assert.equal(error.code, 'unknown-preview-code')
})

test('strict preview excludes username from the safe contract and preserves live score', () => {
  const fields = [
    '<code>501</code>', '<gold_gmin>50</gold_gmin>', '<gold_gmax>20000</gold_gmax>',
    '<ioratio>0.96</ioratio>', '<spread>0.5 / 1</spread>', '<username>private-user</username>',
  ]
  const expectedPrematch = ['code', 'gold_gmin', 'gold_gmax', 'ioratio', 'spread'].sort()
  const prematch = parseCrownPreviewResponseStrict(
    `<serverresponse>${fields.join('')}</serverresponse>`,
    { expectedFieldSet: expectedPrematch },
  )
  assert.deepEqual(prematch.responseFieldSet, expectedPrematch)
  assert.equal(JSON.stringify(prematch).includes('username'), false)
  assert.equal(JSON.stringify(prematch).includes('private-user'), false)

  const emptyUsername = parseCrownPreviewResponseStrict(
    `<serverresponse>${fields.filter((field) => !field.startsWith('<username>')).join('')}<username/></serverresponse>`,
    { expectedFieldSet: expectedPrematch },
  )
  assert.deepEqual(emptyUsername.responseFieldSet, expectedPrematch)

  const expectedLive = [...expectedPrematch, 'score'].sort()
  const live = parseCrownPreviewResponseStrict(
    `<serverresponse>${fields.join('')}<score>1:0</score></serverresponse>`,
    { expectedFieldSet: expectedLive },
  )
  assert.deepEqual(live.responseFieldSet, expectedLive)
})

test('strict preview rejects unclosed observed fields even when their values are ignored', () => {
  const required = [
    '<code>501</code>', '<gold_gmin>50</gold_gmin>', '<gold_gmax>20000</gold_gmax>',
    '<ioratio>0.96</ioratio>', '<spread>0.5 / 1</spread>',
  ].join('')

  for (const ignoredField of ['<username>private-user', '<username broken', '<score>1:0', '< broken']) {
    const error = strictError(`<serverresponse>${required}${ignoredField}</serverresponse>`)
    assert.equal(error.code, 'malformed-preview-response')
    assert.equal(JSON.stringify(error.diagnostics).includes('private-user'), false)
  }
})

test('strict preview rejects root or field attributes outside the evidenced XML shape', () => {
  const required = [
    '<code>501</code>', '<gold_gmin>50</gold_gmin>', '<gold_gmax>20000</gold_gmax>',
    '<ioratio>0.96</ioratio>', '<spread>0.5 / 1</spread>',
  ].join('')
  for (const xml of [
    `<serverresponse attr="broken>${required}</serverresponse>`,
    `<serverresponse>${required.replace('<code>', '<code attr="broken>')}</serverresponse>`,
  ]) {
    assert.equal(strictError(xml).code, 'malformed-preview-response')
  }
})

test('strict submit rejects unclosed observed fields even when excluded from its safe contract', () => {
  const expected = {
    gid: 'event-safe', gtype: 'FT', wtype: 'R', rtype: 'RH', amount: '50', odds: '0.96',
  }
  const required = [
    '<code>560</code>', '<w_id>order-safe</w_id>', '<gid>event-safe</gid>',
    '<gtype>FT</gtype>', '<wtype>R</wtype>', '<rtype>RH</rtype>',
    '<gold>50</gold>', '<ioratio>0.96</ioratio>',
  ].join('')
  const expectedFieldSet = ['code', 'gid', 'gtype', 'wtype', 'rtype', 'gold', 'ioratio']

  for (const [ignoredField, fieldSet] of [
    ['<username>private-user', expectedFieldSet],
    ['<mid>member-private', expectedFieldSet],
    ['<mid broken', expectedFieldSet],
    ['<score>1:0', undefined],
    ['< broken', expectedFieldSet],
  ]) {
    const result = parseCrownSubmitResponseStrict(
      `<serverresponse>${required}${ignoredField}</serverresponse>`,
      { expected, expectedFieldSet: fieldSet, sealReference: () => 'v2:safe:cipher:text' },
    )
    assert.deepEqual(result, { kind: 'unknown' })
    assert.equal(JSON.stringify(result).includes('private'), false)
  }
})

test('parses submit response without exposing ticket id', () => {
  const xml = '<serverresponse><code>560</code><ticket_id>123456789</ticket_id><gid>8878931</gid><gtype>FT</gtype><wtype>ROU</wtype><rtype>ROUC</rtype><ioratio>0.75</ioratio><gold>50</gold><spread>4 / 4.5</spread></serverresponse>'
  const result = parseCrownSubmitResponse(xml)
  assert.equal(result.ok, true)
  assert.equal(result.ticketRef, '[ticket:9]')
  assert.equal(JSON.stringify(result).includes('123456789'), false)
  assert.equal(result.market.wtype, 'ROU')
})

test('parses pending and accepted polling status', () => {
  const pending = '<serverrequest><status><status_N><ticket id="123">N</ticket></status_N><status_A></status_A></status></serverrequest>'
  const accepted = '<serverrequest><status><status_N></status_N><status_A><ticket id="123">A</ticket></status_A></status></serverrequest>'
  assert.equal(parseCrownDangerousStatus(pending).status, 'pending')
  assert.equal(parseCrownDangerousStatus(accepted).status, 'accepted')
})
