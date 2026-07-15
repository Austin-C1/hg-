import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  classifyCrownTransformText,
  normalizeCrownTransformBatch,
  normalizeCrownTransformXml,
} from '../src/crown/crown-transform-xml.mjs'
import { buildSnapshotBatch } from '../src/crown/monitor/snapshot-batch.mjs'
import { detectEndpoint } from '../src/crown/endpoint-detector.mjs'
import { normalizeFootballResponse } from '../src/crown/normalize-football.mjs'
import { validateNormalizedOddsRecord } from '../src/crown/schema/normalized-odds.schema.mjs'

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<serverresponse>
  <ec id="ec-1" hasEC="Y" myGame="ft">
    <game id="1001">
      <SHOWTYPE>ft</SHOWTYPE>
      <GID>1001</GID>
      <GIDM>9001</GIDM>
      <HGID>1002</HGID>
      <ECID>8001</ECID>
      <LID>7001</LID>
      <DATETIME>07-07 09:00p</DATETIME>
      <LEAGUE>England Premier League</LEAGUE>
      <TEAM_H>Arsenal</TEAM_H>
      <TEAM_C>Chelsea</TEAM_C>
      <STRONG>H</STRONG>
      <RATIO_R>0 / 0.5</RATIO_R>
      <IOR_RH>0.790</IOR_RH>
      <IOR_RC>1.050</IOR_RC>
      <RATIO_OUO>2.5</RATIO_OUO>
      <RATIO_OUU>2.5</RATIO_OUU>
      <IOR_OUH>1.020</IOR_OUH>
      <IOR_OUC>0.800</IOR_OUC>
      <IOR_MH>1.99</IOR_MH>
      <IOR_MC>2.85</IOR_MC>
      <IOR_MN>4.05</IOR_MN>
      <RATIO_HR>0</RATIO_HR>
      <IOR_HRH>1.060</IOR_HRH>
      <IOR_HRC>0.780</IOR_HRC>
      <RATIO_HOUO>1.5</RATIO_HOUO>
      <RATIO_HOUU>1.5</RATIO_HOUU>
      <IOR_HOUH>0.850</IOR_HOUH>
      <IOR_HOUC>0.970</IOR_HOUC>
      <IOR_HMH>2.38</IOR_HMH>
      <IOR_HMC>3.20</IOR_HMC>
      <IOR_HMN>2.58</IOR_HMN>
      <IS_RB>N</IS_RB>
    </game>
  </ec>
  <ec id="ec-2" hasEC="Y" myGame="rb">
    <game id="2001">
      <SHOWTYPE>rb</SHOWTYPE>
      <GID>2001</GID>
      <GIDM>9002</GIDM>
      <HGID>2002</HGID>
      <ECID>8002</ECID>
      <LID>7002</LID>
      <DATETIME>07-07 07:00p</DATETIME>
      <LEAGUE>Brazil Serie B</LEAGUE>
      <TEAM_H>Home FC</TEAM_H>
      <TEAM_C>Away FC</TEAM_C>
      <STRONG>C</STRONG>
      <RETIMESET>1H^08:00</RETIMESET>
      <SCORE_H>0</SCORE_H>
      <SCORE_C>0</SCORE_C>
      <RATIO_RE>1</RATIO_RE>
      <IOR_REH>0.770</IOR_REH>
      <IOR_REC>0.930</IOR_REC>
      <RATIO_ROUO>3.5</RATIO_ROUO>
      <RATIO_ROUU>3.5</RATIO_ROUU>
      <IOR_ROUH>0.820</IOR_ROUH>
      <IOR_ROUC>0.880</IOR_ROUC>
      <IOR_RMH>3.85</IOR_RMH>
      <IOR_RMC>1.54</IOR_RMC>
      <IOR_RMN>4.15</IOR_RMN>
      <IS_RB>Y</IS_RB>
    </game>
  </ec>
  <ec id="ec-3" hasEC="Y" myGame="rb">
    <game id="3001">
      <SHOWTYPE>rb</SHOWTYPE>
      <GID>3001</GID>
      <LEAGUE>EFootball - GT Sports League (2 X 6mins)</LEAGUE>
      <TEAM_H>Norway Esports</TEAM_H>
      <TEAM_C>France Esports</TEAM_C>
      <RATIO_RE>0</RATIO_RE>
      <IOR_REH>0.800</IOR_REH>
      <IOR_REC>0.900</IOR_REC>
      <IS_RB>Y</IS_RB>
    </game>
  </ec>
</serverresponse>`

const metadata = {
  method: 'POST',
  url: 'https://m407.mos077.com/transform.php',
  endpointKind: 'get_game_list',
  capturedAt: '2026-07-08T00:00:00.000+08:00',
}

test('normalization repairs reversible Crown mojibake in league and team names', () => {
  const [record] = normalizeCrownTransformXml({
    body: `<?xml version="1.0"?><serverresponse><game>
      <SHOWTYPE>ft</SHOWTYPE><GID>encoding-1</GID><GIDM>encoding-group</GIDM><LID>encoding-league</LID>
      <LEAGUE>婢冲ぇ鍒╀簹鏄嗗＋鍏板窞瓒呯骇鑱旇禌1U23</LEAGUE>
      <TEAM_H>甯冪綏寰疯仈U23</TEAM_H><TEAM_C>鍗″竷灏斿交U23</TEAM_C>
      <RATIO_R>0</RATIO_R><IOR_RH>0.94</IOR_RH><IOR_RC>0.96</IOR_RC>
    </game></serverresponse>`,
    metadata,
  })

  assert.equal(record.event.league, '澳大利亚昆士兰州超级联赛1U23')
  assert.equal(record.event.homeTeam, '布罗德联U23')
  assert.equal(record.event.awayTeam, '卡布尔彻U23')
})

test('normalization leaves already-correct Chinese names unchanged', () => {
  const [record] = normalizeCrownTransformXml({
    body: `<?xml version="1.0"?><serverresponse><game>
      <SHOWTYPE>ft</SHOWTYPE><GID>encoding-2</GID><GIDM>encoding-group-2</GIDM><LID>encoding-league-2</LID>
      <LEAGUE>南非女子超级联赛</LEAGUE><TEAM_H>华沙莱吉亚</TEAM_H><TEAM_C>特伦辛</TEAM_C>
      <RATIO_R>0</RATIO_R><IOR_RH>0.94</IOR_RH><IOR_RC>0.96</IOR_RC>
    </game></serverresponse>`,
    metadata,
  })

  assert.equal(record.event.league, '南非女子超级联赛')
  assert.equal(record.event.homeTeam, '华沙莱吉亚')
  assert.equal(record.event.awayTeam, '特伦辛')
})

test('batch normalization exposes valid football event refs before target-market filtering', () => {
  const batch = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse>
      <game><GID>no-market-1</GID><GIDM>group-1</GIDM><LID>league-1</LID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C></game>
      <game><GID>esport-1</GID><GIDM>group-2</GIDM><LID>league-2</LID><LEAGUE>EFootball GT Sports League</LEAGUE><TEAM_H>Virtual Home</TEAM_H><TEAM_C>Virtual Away</TEAM_C></game>
      <game><GID>virtual-2</GID><GIDM>group-3</GIDM><LID>league-3</LID><LEAGUE>电子足球联赛</LEAGUE><TEAM_H>虚拟主队</TEAM_H><TEAM_C>虚拟客队</TEAM_C></game>
    </serverresponse>`,
    metadata,
  })

  assert.equal(batch.records.length, 0)
  assert.equal(batch.eventRefs.length, 1)
  assert.equal(batch.eventRefs[0].eventKey, 'crown|football|gid=no-market-1')
  assert.equal(batch.eventRefs[0].matchGroupKey, 'crown|football|gidm=group-1|lid=league-1')
  assert.equal(batch.eventRefs[0].identityConfidence, 'high')
  assert.deepEqual(batch.eventRefs[0].providerIds, batch.eventRefs[0].ids)
})

test('mixed football and excluded virtual games remain an authoritative list batch', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse>
      <game><GID>football-1</GID><GIDM>group-1</GIDM><LID>league-1</LID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C></game>
      <game><GID>esport-1</GID><GIDM>group-2</GIDM><LID>league-2</LID><LEAGUE>EFootball GT Sports League</LEAGUE><TEAM_H>Virtual Home</TEAM_H><TEAM_C>Virtual Away</TEAM_C></game>
    </serverresponse>`,
    metadata,
  })

  assert.equal(normalized.classification.gameCount, 2)
  assert.equal(normalized.classification.eligibleGameCount, 1)
  assert.equal(normalized.classification.excludedGameCount, 1)
  assert.equal(normalized.eventRefs.length, 1)

  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: normalized.classification,
    records: normalized.records,
    eventRefs: normalized.eventRefs,
    capturedAt: metadata.capturedAt,
    request: { listType: 'today', showtype: 'FT', date: '2026-07-08', rtype: 'r', filter: {} },
    pollId: 'poll-mixed',
  })

  assert.equal(batch.complete, true)
  assert.equal(batch.completeness, 'authoritative')
})

test('normalization keeps only normal-team full-time handicap and total markets', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse>
      <game><GID>normal-1</GID><GIDM>match-1</GIDM><LID>league-1</LID><LEAGUE>World Cup</LEAGUE><TEAM_H>England</TEAM_H><TEAM_C>Argentina</TEAM_C>
        <RATIO_R>0</RATIO_R><IOR_RH>0.81</IOR_RH><IOR_RC>1.08</IOR_RC><RATIO_OUO>2</RATIO_OUO><RATIO_OUU>2</RATIO_OUU><IOR_OUC>0.76</IOR_OUC><IOR_OUH>1.13</IOR_OUH>
        <RATIO_HR>0</RATIO_HR><IOR_HRH>0.82</IOR_HRH><IOR_HRC>1.06</IOR_HRC><RATIO_HOUO>0.5</RATIO_HOUO><RATIO_HOUU>0.5</RATIO_HOUU><IOR_HOUC>0.85</IOR_HOUC><IOR_HOUH>1.03</IOR_HOUH>
      </game>
      <game><GID>cards-1</GID><LEAGUE>World Cup</LEAGUE><TEAM_H>England -罚牌数</TEAM_H><TEAM_C>Argentina -罚牌数</TEAM_C><RATIO_R>0</RATIO_R><IOR_RH>0.98</IOR_RH><IOR_RC>0.98</IOR_RC></game>
      <game><GID>corners-1</GID><LEAGUE>World Cup</LEAGUE><TEAM_H>England -角球数</TEAM_H><TEAM_C>Argentina -角球数</TEAM_C><RATIO_OUO>10</RATIO_OUO><RATIO_OUU>10</RATIO_OUU><IOR_OUC>0.70</IOR_OUC><IOR_OUH>1.00</IOR_OUH></game>
      <game><GID>player-1</GID><LEAGUE>World Cup-特定球员(进球数)</LEAGUE><TEAM_H>Player A</TEAM_H><TEAM_C>Player B</TEAM_C><RATIO_R>0</RATIO_R><IOR_RH>0.90</IOR_RH><IOR_RC>0.90</IOR_RC></game>
      <game><GID>extra-1</GID><LEAGUE>World Cup</LEAGUE><TEAM_H>England -加时赛</TEAM_H><TEAM_C>Argentina -加时赛</TEAM_C><RATIO_R>0</RATIO_R><IOR_RH>0.90</IOR_RH><IOR_RC>0.90</IOR_RC></game>
    </serverresponse>`,
    metadata,
  })

  assert.equal(normalized.classification.gameCount, 5)
  assert.equal(normalized.classification.eligibleGameCount, 1)
  assert.equal(normalized.classification.excludedGameCount, 4)
  assert.deepEqual(normalized.eventRefs.map((event) => event.eventKey), ['crown|football|gid=normal-1'])
  assert.equal(normalized.records.length, 4)
  assert.deepEqual([...new Set(normalized.records.map((record) => record.market.period))], ['full_time'])
  assert.deepEqual([...new Set(normalized.records.map((record) => record.market.marketType))].sort(), ['asian_handicap', 'total'])
})

test('DOM compatibility normalization ignores half-time sections', () => {
  const records = normalizeFootballResponse({
    body: {
      capturedAt: metadata.capturedAt,
      prematch: [
        {
          id: 'dom-normal-1', league: 'World Cup', teams: ['England', 'Argentina'],
          text: '让球 0 0.81 0 1.08 大/小 大 2 0.76 小 2 1.13 上半场 让球 0 0.82 0 1.06 大/小 大 0.5 0.85 小 0.5 1.03',
        },
        {
          id: 'dom-cards-1', league: 'World Cup', teams: ['England -罚牌数', 'Argentina -罚牌数'],
          text: '让球 0 0.90 0 0.90 大/小 大 4 0.80 小 4 1.00',
        },
      ],
      live: [],
    },
    metadata,
  })

  assert.equal(records.length, 4)
  assert.ok(records.every((record) => record.market.period === 'full_time'))
})

test('ordinary football with incomplete identity is invalid, not domain-excluded', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse><game>
      <GIDM>group-incomplete</GIDM><LID>league-1</LID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
    </game></serverresponse>`,
    metadata,
  })

  assert.equal(normalized.classification.gameCount, 1)
  assert.equal(normalized.classification.excludedGameCount, 0)
  assert.equal(normalized.classification.eligibleGameCount, 1)
  assert.equal(normalized.classification.invalidEventRefCount, 1)
  assert.deepEqual(normalized.eventRefs, [])
  assert.deepEqual(normalized.records, [])

  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_list',
    classification: normalized.classification,
    records: normalized.records,
    eventRefs: normalized.eventRefs,
    capturedAt: metadata.capturedAt,
    request: { listType: 'today' },
    pollId: 'poll-incomplete-identity',
  })

  assert.equal(batch.complete, false)
  assert.equal(batch.completeness, 'partial')
})

test('detail batch with an identity-incomplete football game fails closed', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse><game>
      <GIDM>group-incomplete-detail</GIDM><LID>league-1</LID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
    </game></serverresponse>`,
    metadata: { ...metadata, endpointKind: 'get_game_more' },
  })

  assert.equal(normalized.classification.eligibleGameCount, 1)
  assert.equal(normalized.classification.invalidEventRefCount, 1)
  assert.deepEqual(normalized.eventRefs, [])

  const batch = buildSnapshotBatch({
    endpointKind: 'get_game_more',
    classification: normalized.classification,
    records: normalized.records,
    eventRefs: normalized.eventRefs,
    capturedAt: metadata.capturedAt,
    request: { gid: 'missing-detail-gid' },
    pollId: 'poll-incomplete-detail',
  })

  assert.equal(batch.complete, false)
  assert.equal(batch.completeness, 'partial')
})

test('truncated game or ec blocks make an otherwise closed serverresponse incomplete', () => {
  for (const body of [
    `<?xml version="1.0"?><serverresponse>
      <game><GID>valid-1</GID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C></game>
      <game><GID>truncated-2</GID><LEAGUE>Plain Football</LEAGUE>
    </serverresponse>`,
    `<?xml version="1.0"?><serverresponse>
      <ec><game><GID>valid-1</GID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C></game>
    </serverresponse>`,
  ]) {
    const normalized = normalizeCrownTransformBatch({ body, metadata })
    assert.equal(normalized.classification.parseError, true)

    const batch = buildSnapshotBatch({
      endpointKind: 'get_game_list',
      classification: normalized.classification,
      records: normalized.records,
      eventRefs: normalized.eventRefs,
      capturedAt: metadata.capturedAt,
      request: { listType: 'today' },
      pollId: 'poll-truncated',
    })
    assert.equal(batch.complete, false)
    assert.equal(batch.completeness, 'partial')
  }
})

test('cross-closed XML tags are classified as a parse error', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse><game>
      <GID>crossed-1</GID><LEAGUE>Plain Football</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
    </serverresponse></game>`,
    metadata,
  })

  assert.equal(normalized.classification.parseError, true)
  assert.deepEqual(normalized.eventRefs, [])
  assert.deepEqual(normalized.records, [])
})

test('list and game-more records share canonical identity when detail ECID is missing', () => {
  const game = ({ ecid = '', ratio = '0 / 0.5' } = {}) => `<?xml version="1.0"?><serverresponse><game>
    <SHOWTYPE>ft</SHOWTYPE><GID>same-3001</GID><GIDM>same-9001</GIDM><HGID>same-3002</HGID>${ecid ? `<ECID>${ecid}</ECID>` : ''}<LID>same-7001</LID>
    <LEAGUE>Identity League</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
    <RATIO_R>${ratio}</RATIO_R><IOR_RH>0.790</IOR_RH><IOR_RC>1.050</IOR_RC>
  </game></serverresponse>`
  const list = normalizeCrownTransformXml({ body: game({ ecid: 'same-8001' }), metadata: { ...metadata, endpointKind: 'get_game_list' } })[0]
  const more = normalizeCrownTransformXml({ body: game(), metadata: { ...metadata, endpointKind: 'get_game_more' } })[0]

  assert.equal(list.event.eventKey, 'crown|football|gid=same-3001')
  assert.equal(more.event.eventKey, list.event.eventKey)
  assert.equal(list.event.matchGroupKey, 'crown|football|gidm=same-9001|lid=same-7001')
  assert.equal(list.event.identityConfidence, 'high')
  assert.equal(list.event.providerIds.ecid, 'same-8001')
  assert.equal(more.event.providerIds.ecid, null)
  assert.deepEqual(list.event.providerIds, list.event.ids)
  assert.equal(list.event.legacyEventKey, 'crown|gid=same-3001|gidm=same-9001|hgid=same-3002|ecid=same-8001|lid=same-7001')
  assert.equal(more.event.legacyEventKey, 'crown|gid=same-3001|gidm=same-9001|hgid=same-3002|ecid=missing|lid=same-7001')
  assert.equal(list.market.marketIdentity, more.market.marketIdentity)
  assert.equal(list.selection.selectionIdentity, more.selection.selectionIdentity)
  assert.equal(list.market.marketId, list.market.marketIdentity)
  assert.equal(list.selection.selectionId, list.selection.selectionIdentity)

  const moved = normalizeCrownTransformXml({ body: game({ ratio: '0.5' }), metadata: { ...metadata, endpointKind: 'get_game_more' } })[0]
  assert.notEqual(moved.market.handicap, more.market.handicap)
  assert.equal(moved.market.marketIdentity, more.market.marketIdentity)
  assert.equal(moved.selection.selectionIdentity, more.selection.selectionIdentity)
})

test('detects Crown transform XML odds responses', () => {
  const detected = detectEndpoint({ body: sampleXml, metadata })

  assert.equal(detected.detected, true)
  assert.equal(detected.kind, 'crown-transform-xml')
  assert.equal(detected.confidence, 'high')
})

test('normalizes Crown transform XML with real Crown ids and IOR odds', () => {
  const records = normalizeFootballResponse({ body: sampleXml, metadata })

  assert.equal(records.length, 8)
  assert.equal(new Set(records.map((record) => record.event.eventId)).size, 2)
  assert.deepEqual([...new Set(records.map((record) => record.market.marketType))].sort(), ['asian_handicap', 'total'])
  assert.ok(records.every((record) => record.market.period === 'full_time'))
  assert.equal(records.some((record) => /EFootball/i.test(record.event.league)), false)
  assert.deepEqual(records.flatMap(validateNormalizedOddsRecord), [])

  const first = records[0]
  assert.equal(first.event.eventId, '1001')
  assert.equal(first.event.ids.gidm, '9001')
  assert.equal(first.event.ids.hgid, '1002')
  assert.equal(first.event.ids.ecid, '8001')
  assert.equal(first.event.ids.lid, '7001')
  assert.equal(first.source.endpointKind, 'get_game_list')
  assert.equal(first.source.confidence, 'high')
  assert.ok(first.warnings.includes('missing-explicit-odds-id'))

  const fullTimeTotalOver = records.find((record) => (
    record.event.eventId === '1001' &&
    record.market.marketType === 'total' &&
    record.market.period === 'full_time' &&
    record.selection.side === 'over'
  ))
  assert.equal(fullTimeTotalOver.selection.oddsRaw, '0.800')
  assert.equal(fullTimeTotalOver.market.handicapRaw, '2.5')

  const liveHandicapAway = records.find((record) => (
    record.event.eventId === '2001' &&
    record.market.marketType === 'asian_handicap' &&
    record.selection.side === 'away'
  ))
  assert.equal(liveHandicapAway.mode, 'live')
  assert.equal(liveHandicapAway.selection.oddsRaw, '0.930')
  assert.equal(liveHandicapAway.event.score, '0-0')
  assert.equal(liveHandicapAway.event.clock, '1H^08:00')
})

function readFixture(name) {
  return fs.readFileSync(path.join('data/fixtures/crown/transform-xml', name), 'utf8')
}

test('Task 2 full-time evidence normalizes all eight betting directions as main lines', () => {
  const records = normalizeFootballResponse({
    body: readFixture('get-game-list-today.xml'),
    metadata: {
      method: 'POST',
      url: 'https://fixture.invalid/transform.php',
      endpointKind: 'get_game_list',
      capturedAt: '2026-07-08T10:00:00.000+08:00',
      sampleFile: 'get-game-list-today.xml',
    },
  }).filter((record) => record.market.period === 'full_time')

  const evidence = JSON.parse(fs.readFileSync(
    path.join('data/fixtures/crown/betting-protocol/artifacts', '20260714-1848-eight-direction-candidates.safe.json'),
    'utf8',
  ))
  const evidenceDirections = evidence.candidates.map(({ direction }) => [
    direction.mode,
    direction.period,
    direction.marketType,
    direction.side,
    direction.lineVariant,
  ].join('|')).sort()
  const normalizedDirections = records.map((record) => [
    record.mode,
    record.market.period,
    record.market.marketType,
    record.selection.side,
    record.market.lineVariant,
  ].join('|')).sort()

  assert.equal(records.length, 8)
  assert.deepEqual(normalizedDirections, evidenceDirections)

  const expectedFields = [
    ['prematch', 'asian_handicap', 'home', 'RATIO_R', '0 / 0.5', 'IOR_RH', '0.790'],
    ['prematch', 'asian_handicap', 'away', 'RATIO_R', '0 / 0.5', 'IOR_RC', '1.050'],
    ['prematch', 'total', 'over', 'RATIO_OUO', '2.5', 'IOR_OUC', '0.800'],
    ['prematch', 'total', 'under', 'RATIO_OUU', '2.5', 'IOR_OUH', '1.020'],
    ['live', 'asian_handicap', 'home', 'RATIO_RE', '1', 'IOR_REH', '0.770'],
    ['live', 'asian_handicap', 'away', 'RATIO_RE', '1', 'IOR_REC', '0.930'],
    ['live', 'total', 'over', 'RATIO_ROUO', '3.5', 'IOR_ROUC', '0.880'],
    ['live', 'total', 'under', 'RATIO_ROUU', '3.5', 'IOR_ROUH', '0.820'],
  ]
  for (const [mode, marketType, side, ratioField, handicapRaw, oddsField, oddsRaw] of expectedFields) {
    const record = records.find((item) => (
      item.mode === mode
      && item.market.marketType === marketType
      && item.selection.side === side
    ))
    assert.ok(record, `${mode}/${marketType}/${side}`)
    assert.equal(record.event.mode, mode)
    assert.equal(record.market.lineVariant, 'main')
    assert.equal(record.market.isMainMarket, true)
    assert.equal(record.market.ratioField, ratioField)
    assert.equal(record.market.handicapRaw, handicapRaw)
    assert.equal(record.selection.oddsField, oddsField)
    assert.equal(record.selection.oddsRaw, oddsRaw)
  }
})

test('unverified alternate Crown lines stay unknown instead of being promoted to main', () => {
  const records = normalizeCrownTransformXml({
    body: `<?xml version="1.0"?><serverresponse><game>
      <SHOWTYPE>ft</SHOWTYPE><GID>alternate-line</GID><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
      <RATIO_AR>0.5</RATIO_AR><IOR_ARH>0.91</IOR_ARH><IOR_ARC>0.99</IOR_ARC>
    </game></serverresponse>`,
    metadata,
  })

  assert.equal(records.length, 2)
  assert.deepEqual([...new Set(records.map((record) => record.market.lineVariant))], ['unknown'])
  assert.deepEqual([...new Set(records.map((record) => record.market.isMainMarket))], ['unknown'])
})

test('cross-mode full-time fields stay unknown and first-half fields are ignored', () => {
  const records = normalizeCrownTransformXml({
    body: `<serverresponse>
      <game><GID>prematch-cross</GID><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
        <RATIO_RE>0.5</RATIO_RE><IOR_REH>0.91</IOR_REH><IOR_REC>0.99</IOR_REC>
        <RATIO_HR>0.25</RATIO_HR><IOR_HRH>0.92</IOR_HRH><IOR_HRC>0.98</IOR_HRC>
      </game>
      <game><SHOWTYPE>RB</SHOWTYPE><GID>live-cross</GID><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
        <RATIO_R>0.5</RATIO_R><IOR_RH>0.91</IOR_RH><IOR_RC>0.99</IOR_RC>
        <RATIO_HRE>0.25</RATIO_HRE><IOR_HREH>0.92</IOR_HREH><IOR_HREC>0.98</IOR_HREC>
      </game>
    </serverresponse>`,
    metadata,
  })

  assert.equal(records.length, 4)
  assert.ok(records.every((record) => record.market.period === 'full_time'))
  assert.ok(records.every((record) => (
    record.market.lineVariant === 'unknown' && record.market.isMainMarket === 'unknown'
  )))
})

test('normalizes fixed get_game_list XML fixture with local keys and field mapping', () => {
  const records = normalizeFootballResponse({
    body: readFixture('get-game-list-today.xml'),
    metadata: {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: 'get_game_list',
      capturedAt: '2026-07-08T10:00:00.000+08:00',
      sampleFile: 'get-game-list-today.xml',
    },
  })

  assert.equal(new Set(records.map((record) => record.event.eventKey)).size, 2)
  assert.deepEqual(records.flatMap(validateNormalizedOddsRecord), [])

  const handicapHome = records.find((record) => (
    record.event.ids.gid === '1001' &&
    record.market.marketType === 'asian_handicap' &&
    record.market.period === 'full_time' &&
    record.selection.side === 'home'
  ))

  assert.equal(handicapHome.event.eventKey, 'crown|football|gid=1001')
  assert.equal(handicapHome.event.legacyEventKey, 'crown|gid=1001|gidm=9001|hgid=1002|ecid=8001|lid=7001')
  assert.equal(handicapHome.event.startTimeRaw, '2026-07-08 21:00:00')
  assert.equal(handicapHome.event.startTimeUtc, '2026-07-08T13:00:00.000Z')
  assert.equal(handicapHome.event.startTimeLocal, '2026-07-08 21:00:00')
  assert.equal(handicapHome.event.timeZone, 'Asia/Shanghai')
  assert.equal(handicapHome.event.timeSource, 'GAME_DATE_TIME')
  assert.equal(handicapHome.event.timeConfidence, 'high')
  assert.deepEqual(handicapHome.event.timeWarnings, [])
  assert.equal(handicapHome.market.marketIdentity, `${handicapHome.event.eventKey}|full_time|asian_handicap|RATIO_R`)
  assert.equal(handicapHome.selection.selectionIdentity, `${handicapHome.market.marketIdentity}|home`)
  assert.equal(handicapHome.market.marketKey, handicapHome.market.marketIdentity)
  assert.equal(handicapHome.selection.selectionKey, handicapHome.selection.selectionIdentity)
  assert.equal(handicapHome.market.marketId, handicapHome.market.marketKey)
  assert.equal(handicapHome.selection.selectionId, handicapHome.selection.selectionKey)
  assert.equal(handicapHome.market.idScope, 'local')
  assert.equal(handicapHome.selection.idScope, 'local')
  assert.equal(handicapHome.selection.oddsId, null)
  assert.equal(handicapHome.market.ratioField, 'RATIO_R')
  assert.equal(handicapHome.market.lineKey, 'RATIO_R')
  assert.equal(handicapHome.selection.oddsField, 'IOR_RH')
  assert.equal(handicapHome.market.handicapRaw, '0 / 0.5')
  assert.equal(handicapHome.market.handicap, 0.25)
  assert.equal(handicapHome.market.isMainMarket, true)
  assert.equal(handicapHome.market.lineVariant, 'main')
  assert.ok(handicapHome.warnings.includes('local-market-id'))
  assert.ok(handicapHome.warnings.includes('local-selection-id'))
})

test('normalizes get_game_more XML fixture to handicap and total markets only', () => {
  const records = normalizeFootballResponse({
    body: readFixture('get-game-more.xml'),
    metadata: {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T10:01:00.000+08:00',
      sampleFile: 'get-game-more.xml',
    },
  })

  assert.equal(records.some((record) => record.source.endpointKind === 'get_game_more'), true)
  assert.deepEqual([...new Set(records.map((record) => record.market.marketType))].sort(), ['asian_handicap', 'total'])
  assert.equal(records.some((record) => record.market.marketType === 'team_total'), false)
  assert.equal(records.some((record) => record.market.marketType === 'moneyline'), false)
  assert.equal(records.some((record) => record.market.marketType === 'odd_even'), false)
  assert.equal(records.some((record) => record.market.marketType === 'yes_no'), false)
  assert.equal(records.some((record) => record.market.marketType === 'other'), false)

  const total = records.find((record) => record.market.marketType === 'total')
  assert.ok(total)
  assert.equal(total.event.startTimeUtc, '2026-07-08T12:00:00.000Z')
  assert.equal(total.event.livePhase, 'second_half')
  assert.equal(total.event.liveMinute, 52)
  assert.deepEqual(total.event.liveClockWarnings, [])
})

test('normalizes alternate handicap and total lines from get_game_more XML', () => {
  const records = normalizeFootballResponse({
    body: `<?xml version="1.0" encoding="UTF-8"?>
<serverresponse>
  <game>
    <SHOWTYPE>ft</SHOWTYPE>
    <GID>4001</GID>
    <GIDM>9401</GIDM>
    <HGID>4002</HGID>
    <ECID>8401</ECID>
    <LID>7401</LID>
    <LEAGUE>Alternate Lines League</LEAGUE>
    <TEAM_H>Alt Home</TEAM_H>
    <TEAM_C>Alt Away</TEAM_C>
    <RATIO_AR>0 / 0.5</RATIO_AR>
    <IOR_ARH>0.910</IOR_ARH>
    <IOR_ARC>0.930</IOR_ARC>
    <RATIO_FR>-1</RATIO_FR>
    <IOR_FRH>1.010</IOR_FRH>
    <IOR_FRC>0.790</IOR_FRC>
    <RATIO_AOUO>2.5</RATIO_AOUO>
    <RATIO_AOUU>2.5</RATIO_AOUU>
    <IOR_AOUO>0.880</IOR_AOUO>
    <IOR_AOUU>1.020</IOR_AOUU>
    <RATIO_FOUO>4.5</RATIO_FOUO>
    <RATIO_FOUU>4.5</RATIO_FOUU>
    <IOR_FOUO>0.760</IOR_FOUO>
    <IOR_FOUU>1.140</IOR_FOUU>
    <RATIO_OUCO>1.5</RATIO_OUCO>
    <RATIO_OUCU>1.5</RATIO_OUCU>
    <IOR_OUCO>0.970</IOR_OUCO>
    <IOR_OUCU>0.850</IOR_OUCU>
    <IS_RB>N</IS_RB>
  </game>
</serverresponse>`,
    metadata: {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-08T10:02:00.000+08:00',
    },
  })

  assert.deepEqual(records.flatMap(validateNormalizedOddsRecord), [])
  assert.ok(records.find((record) => record.market.lineKey === 'RATIO_AR' && record.selection.side === 'home'))
  assert.ok(records.find((record) => record.market.lineKey === 'RATIO_FR' && record.selection.side === 'away'))
  assert.ok(records.find((record) => record.market.lineKey === 'RATIO_AOUO' && record.selection.side === 'over'))
  assert.ok(records.find((record) => record.market.lineKey === 'RATIO_FOUO' && record.selection.side === 'under'))
  assert.equal(records.some((record) => record.market.marketType === 'team_total'), false)
})

test('uses one generated capturedAt as the DATETIME year-inference baseline', () => {
  const records = normalizeFootballResponse({
    body: `<?xml version="1.0"?><serverresponse><game>
      <SHOWTYPE>ft</SHOWTYPE><GID>captured-at-1</GID>
      <DATETIME>07-10 12:00p</DATETIME>
      <LEAGUE>Captured At League</LEAGUE><TEAM_H>Home</TEAM_H><TEAM_C>Away</TEAM_C>
      <RATIO_R>0</RATIO_R><IOR_RH>0.90</IOR_RH><IOR_RC>0.90</IOR_RC>
    </game></serverresponse>`,
    metadata: {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: 'get_game_list',
    },
  })

  assert.equal(records.length, 2)
  assert.equal(new Set(records.map((record) => record.capturedAt)).size, 1)
  assert.equal(records[0].event.timeSource, 'DATETIME')
  assert.notEqual(records[0].event.startTimeUtc, null)
})

test('uses root system_time to parse full get_game_more DATETIME in Crown source time', () => {
  const normalized = normalizeCrownTransformBatch({
    body: `<?xml version="1.0"?><serverresponse>
      <system_time>2026-07-10 05:58:18</system_time>
      <game>
        <SHOWTYPE>ft</SHOWTYPE><GID>3001</GID><GIDM>9001</GIDM><ECID>8001</ECID><LID>7001</LID>
        <DATETIME>2026-07-10 05:30:00</DATETIME>
        <LEAGUE>世界杯2026(美加墨)</LEAGUE><TEAM_H>法国</TEAM_H><TEAM_C>摩洛哥</TEAM_C>
        <RATIO_OUO>2.5</RATIO_OUO><RATIO_OUU>2.5</RATIO_OUU>
        <IOR_OUC>1.050</IOR_OUC><IOR_OUH>0.840</IOR_OUH>
      </game>
    </serverresponse>`,
    metadata: {
      method: 'POST',
      url: 'https://m407.mos077.com/transform.php',
      endpointKind: 'get_game_more',
      capturedAt: '2026-07-10T09:58:19.000Z',
    },
  })

  assert.ok(normalized.records.length > 0)
  assert.equal(normalized.records[0].event.startTimeUtc, '2026-07-10T09:30:00.000Z')
  assert.notEqual(normalized.records[0].event.timeConfidence, 'none')
})

test('marks empty odds and closed markets as suspended without inventing odds ids', () => {
  const emptyRecords = normalizeFootballResponse({
    body: readFixture('empty-odds.xml'),
    metadata: { method: 'POST', url: 'https://m407.mos077.com/transform.php', endpointKind: 'get_game_list' },
  })
  const suspendedRecords = normalizeFootballResponse({
    body: readFixture('suspended.xml'),
    metadata: { method: 'POST', url: 'https://m407.mos077.com/transform.php', endpointKind: 'get_game_list' },
  })

  assert.equal(emptyRecords.length, 2)
  assert.equal(emptyRecords.every((record) => record.selection.suspended), true)
  assert.equal(emptyRecords.every((record) => record.selection.oddsId === null), true)
  assert.equal(suspendedRecords.every((record) => record.selection.suspended), true)
  assert.ok(suspendedRecords[0].warnings.includes('market-closed'))
})

test('classifies login-expired HTML and malformed XML for watcher counters', () => {
  const login = classifyCrownTransformText(readFixture('login-expired.html'))
  const invalid = classifyCrownTransformText(readFixture('invalid.xml'))
  const empty = classifyCrownTransformText('<?xml version="1.0"?><serverresponse><dataCount>0</dataCount></serverresponse>')

  assert.equal(login.loginExpired, true)
  assert.equal(invalid.parseError, true)
  assert.equal(empty.empty, true)
})
