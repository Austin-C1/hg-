import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildDefaultLeagueOverview,
  DEFAULT_LEAGUES_CONFIG,
  isDefaultLeagueMatched,
  normalizeDefaultLeaguesConfig,
  validateDefaultLeagueSeed,
} from '../src/crown/config/default-leagues.mjs'

const userDefaultLeagueNames = [
  '英格兰超级联赛',
  '英格兰冠军联赛',
  '英格兰甲组联赛',
  '英格兰乙组联赛',
  '德国甲组联赛',
  '德国乙组联赛',
  '西班牙甲组联赛',
  '西班牙乙组联赛',
  '意大利甲组联赛',
  '意大利乙组联赛',
  '法国甲组联赛',
  '法国乙组联赛',
  '荷兰甲组联赛',
  '荷兰乙组联赛',
  '葡萄牙超级联赛',
  '葡萄牙甲组联赛',
  '俄罗斯超级联赛',
  '挪威超级联赛',
  '芬兰超级联赛',
  '芬兰甲组联赛',
  '瑞典超级联赛',
  '瑞典超级甲组联赛',
  '丹麦超级联赛',
  '丹麦甲组联赛',
  '奥地利甲组联赛',
  '奥地利乙组联赛',
  '瑞士超级联赛',
  '瑞士甲组联赛',
  '爱尔兰超级联赛',
  '爱尔兰甲组联赛',
  '比利时甲组联赛A',
  '土耳其超级联赛',
  '希腊超级联赛甲组',
  '苏格兰超级联赛',
  '波兰超级联赛',
  '罗马尼亚甲组联赛',
  '捷克甲组联赛',
  '乌克兰超级联赛',
  '冰岛超级联赛',
  '阿根廷职业联赛',
  '巴西甲组联赛',
  '巴西乙组联赛',
  '智利甲组联赛',
  '哥伦比亚甲组联赛',
  '厄瓜多尔甲组联赛',
  '巴拉圭甲组联赛',
  '秘鲁甲组联赛',
  '美国职业大联盟',
  '美国足球冠军联赛',
  '墨西哥超级联赛',
  '墨西哥甲组联赛',
  '日本J1百年构想联赛',
  '日本J2 J3百年构想联赛',
  '澳大利亚甲组联赛',
  '澳大利亚维多利亚国家超级联赛',
  '澳大利亚女子甲组联赛',
  '韩国K甲组联赛',
  '沙特超级联赛',
  '卡塔尔甲组联赛',
  '阿联酋超级联赛',
  '巴林超级联赛',
  '印度超级联赛',
  '印尼超级联赛',
  '中国超级联赛',
  '埃及超级联赛',
  '欧洲冠军联赛',
  '欧洲联赛',
  '欧洲协会联赛',
  '英格兰足总杯',
  '英格兰联赛杯',
  '英格兰联赛锦标赛',
  '德国杯',
  '西班牙杯',
  '意大利杯',
  '法国杯',
  '荷兰KNVB杯',
  '葡萄牙杯',
  '俄罗斯杯',
  '丹麦杯',
  '挪威杯',
  '瑞典杯',
  '比利时杯',
  '奥地利杯',
  '土耳其杯',
  '波兰杯',
  '希腊杯',
  '苏格兰足总杯',
  '罗马尼亚杯',
  '捷克杯',
  '乌克兰杯',
  '冰岛超级杯',
  '冰岛联赛杯',
  '南美自由杯',
  '南美洲球会杯',
  '阿根廷杯',
  '巴西杯',
  '智利联赛杯',
  '中北美洲及加勒比海冠军杯',
  '美国公开赛冠军杯',
  '亚足联冠军精英联赛',
  '亚足联冠军联赛二',
  '澳大利亚杯',
  '澳大利亚杯外围赛',
  '沙特国王杯',
  '卡塔尔联赛杯',
  '阿联酋总统杯',
  '阿联酋足总杯',
  '巴林超级杯',
  '埃及联赛杯',
  '埃及杯',
  '世界杯2026(美加墨)',
  '世界杯2026洲际(在墨西哥)',
  '欧美杯2026(在卡塔尔)',
  '世界杯2026欧洲外围赛',
  '欧洲国家联赛',
  '非洲国家杯2027外围赛',
  '国际友谊赛',
  '国际系列',
]

const config = {
  leagues: [
    {
      name: 'Crown Internal League A',
      aliases: ['League A', 'A League'],
      enabled: true,
      autoTrack: true,
      modes: ['prematch', 'live'],
    },
    {
      name: 'Crown Internal League B',
      aliases: ['League B'],
      enabled: true,
      autoTrack: false,
      modes: ['prematch'],
    },
    {
      name: 'Disabled League',
      aliases: ['Disabled Alias'],
      enabled: false,
      autoTrack: true,
      modes: ['live'],
    },
  ],
}

test('default league matcher uses exact configured Crown league names only', () => {
  const normalized = normalizeDefaultLeaguesConfig(config)

  assert.deepEqual(
    isDefaultLeagueMatched('Crown Internal League A', 'live', normalized),
    {
      matched: true,
      status: 'hit',
      leagueName: 'Crown Internal League A',
      matchedBy: 'Crown Internal League A',
      enabled: true,
      autoTrack: true,
      modeAllowed: true,
    },
  )
  assert.equal(isDefaultLeagueMatched('Crown Internal League B', 'live', normalized).status, 'mode_disabled')
  assert.equal(isDefaultLeagueMatched('Disabled League', 'live', normalized).status, 'disabled')
  assert.equal(isDefaultLeagueMatched('League A', 'prematch', normalized).status, 'missing')
  assert.equal(isDefaultLeagueMatched('Crown Internal League A - Specials', 'prematch', normalized).status, 'missing')
  assert.equal(isDefaultLeagueMatched('Unknown League', 'prematch', normalized).status, 'missing')
})

test('default league overview reports configured, hit, missing, and disabled counts', () => {
  const events = [
    { league: 'Crown Internal League A', mode: 'prematch' },
    { league: 'Crown Internal League A', mode: 'live' },
    { league: 'Disabled League', mode: 'live' },
  ]

  const overview = buildDefaultLeagueOverview(config, events)

  assert.equal(overview.stats.configuredCount, 3)
  assert.equal(overview.stats.hitCount, 1)
  assert.equal(overview.stats.missingCount, 1)
  assert.equal(overview.stats.disabledCount, 1)
  assert.equal(overview.items.find((item) => item.name === 'Crown Internal League A').status, 'hit')
  assert.equal(overview.items.find((item) => item.name === 'Crown Internal League B').status, 'missing')
  assert.equal(overview.items.find((item) => item.name === 'Disabled League').status, 'disabled')
})

test('project default whitelist contains only the user supplied leagues', () => {
  const configPath = path.resolve('config/default-leagues.json')
  const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const fileNames = normalizeDefaultLeaguesConfig(fileConfig).leagues.map((league) => league.name)
  const builtInNames = normalizeDefaultLeaguesConfig(DEFAULT_LEAGUES_CONFIG).leagues.map((league) => league.name)

  assert.deepEqual(fileNames, userDefaultLeagueNames)
  assert.deepEqual(builtInNames, userDefaultLeagueNames)

  for (const league of normalizeDefaultLeaguesConfig(fileConfig).leagues) {
    assert.equal(league.enabled, true, `${league.name} should be enabled`)
    assert.equal(league.autoTrack, true, `${league.name} should auto track`)
    assert.deepEqual(league.modes, ['prematch', 'live'], `${league.name} should support prematch/live`)
  }
})

test('bundled whitelist is a canonical 118-item seed without credentials, URLs, sessions, profiles, or database data', () => {
  const configPath = path.resolve('config/default-leagues.json')
  const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const validated = validateDefaultLeagueSeed(fileConfig)
  const serialized = JSON.stringify(validated)

  assert.equal(validated.leagues.length, 118)
  assert.deepEqual(validated, DEFAULT_LEAGUES_CONFIG)
  assert.doesNotMatch(serialized, /https?:\/\//i)
  assert.doesNotMatch(serialized, /(?:account|username|password|token|cookie|session|profile|sqlite)/i)
})
