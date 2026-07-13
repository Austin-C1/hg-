import { normalizeText } from '../filters/blacklist.mjs'
import { readJsonConfig, writeJsonConfig } from './json-config.mjs'

export const DEFAULT_LEAGUES_PATH = 'config/default-leagues.json'

export const DEFAULT_LEAGUE_NAMES = [
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

function defaultLeagueRule(name) {
  return {
    name,
    aliases: [],
    enabled: true,
    autoTrack: true,
    modes: ['prematch', 'live'],
  }
}

export const DEFAULT_LEAGUES_CONFIG = {
  version: 1,
  leagues: DEFAULT_LEAGUE_NAMES.map(defaultLeagueRule),
}

const VALID_MODES = new Set(['prematch', 'live'])

function cleanString(value) {
  return String(value ?? '').trim()
}

function cleanAliases(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(cleanString).filter(Boolean))]
}

function cleanModes(value) {
  const modes = Array.isArray(value) ? value : ['prematch', 'live']
  const cleaned = modes.map(cleanString).filter((mode) => VALID_MODES.has(mode))
  return cleaned.length ? [...new Set(cleaned)] : ['prematch', 'live']
}

export function normalizeDefaultLeaguesConfig(config = {}) {
  const leagues = Array.isArray(config?.leagues) ? config.leagues : DEFAULT_LEAGUES_CONFIG.leagues
  return {
    version: 1,
    leagues: leagues
      .map((league) => ({
        name: cleanString(league?.name),
        aliases: cleanAliases(league?.aliases),
        enabled: league?.enabled === undefined ? true : Boolean(league.enabled),
        autoTrack: league?.autoTrack === undefined ? true : Boolean(league.autoTrack),
        modes: cleanModes(league?.modes),
      }))
      .filter((league) => league.name),
  }
}

function leagueValues(rule) {
  return [rule.name].filter(Boolean)
}

function matchesName(leagueName, value) {
  const league = normalizeText(leagueName)
  const candidate = normalizeText(value)
  if (!league || !candidate) return false
  return league === candidate
}

export function isDefaultLeagueMatched(leagueName, mode, config = DEFAULT_LEAGUES_CONFIG) {
  const normalized = normalizeDefaultLeaguesConfig(config)
  for (const rule of normalized.leagues) {
    const matchedBy = leagueValues(rule).find((value) => matchesName(leagueName, value))
    if (!matchedBy) continue
    if (!rule.enabled) {
      return {
        matched: true,
        status: 'disabled',
        leagueName: rule.name,
        matchedBy,
        enabled: false,
        autoTrack: rule.autoTrack,
        modeAllowed: false,
      }
    }
    const modeAllowed = !mode || rule.modes.includes(mode)
    return {
      matched: true,
      status: modeAllowed ? 'hit' : 'mode_disabled',
      leagueName: rule.name,
      matchedBy,
      enabled: true,
      autoTrack: rule.autoTrack,
      modeAllowed,
    }
  }

  return {
    matched: false,
    status: 'missing',
    leagueName: null,
    matchedBy: null,
    enabled: false,
    autoTrack: false,
    modeAllowed: false,
  }
}

export function buildDefaultLeagueOverview(config = DEFAULT_LEAGUES_CONFIG, events = []) {
  const normalized = normalizeDefaultLeaguesConfig(config)
  const items = normalized.leagues.map((rule) => {
    const matches = events.filter((event) => leagueValues(rule).some((value) => matchesName(event?.league, value)))
    const modeHits = [...new Set(matches.map((event) => event?.mode).filter(Boolean))]
    let status = 'missing'
    if (!rule.enabled) status = 'disabled'
    else if (matches.some((event) => rule.modes.includes(event?.mode))) status = 'hit'
    else if (matches.length) status = 'mode_disabled'

    return {
      ...rule,
      status,
      hitCount: status === 'hit' ? matches.length : 0,
      currentModes: modeHits,
      matchedLeagues: [...new Set(matches.map((event) => event?.league).filter(Boolean))].sort(),
    }
  })

  return {
    config: normalized,
    stats: {
      configuredCount: items.length,
      hitCount: items.filter((item) => item.status === 'hit').length,
      missingCount: items.filter((item) => item.status === 'missing').length,
      disabledCount: items.filter((item) => item.status === 'disabled').length,
    },
    items,
  }
}

export async function readDefaultLeagues(file = DEFAULT_LEAGUES_PATH) {
  return readJsonConfig(file, DEFAULT_LEAGUES_CONFIG, normalizeDefaultLeaguesConfig)
}

export async function writeDefaultLeagues(file = DEFAULT_LEAGUES_PATH, config) {
  return writeJsonConfig(file, config, normalizeDefaultLeaguesConfig)
}
