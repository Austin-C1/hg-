const ESPORTS_FOOTBALL_RE = /(电竞|电子|虚拟|梦幻赛|梦幻足球|e\s*[-_ ]?\s*football|efootball|cyber|gt\s*体育|GT体育|2\s*[xX]\s*6\s*分钟|模拟足球)/i
const FOOTBALL_MARKET_RE = /(让球|大\/小|独赢|角球|罚牌|波胆|进球|双方球队进球|开球|上半场)/
const PREMATCH_TIME_RE = /(?:今日|今天)\s*\d{1,2}:\d{2}/
const LIVE_STATUS_RE = /(上半场|下半场|中场|半场休息|加时|点球|第\s*\d+\s*分钟)\s*\d{0,2}:?\d{0,2}/

export function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function detectEventMode(text) {
  const normalized = normalizeText(text)
  if (PREMATCH_TIME_RE.test(normalized)) return 'prematch'
  if (LIVE_STATUS_RE.test(normalized)) return 'live'
  return 'unknown'
}

export function classifyPageHealth({ title = '', url = '', bodyText = '', eventCards = 0 } = {}) {
  const text = normalizeText(`${title} ${url} ${bodyText}`)
  const hasEvents = Number(eventCards || 0) > 0
  const isWelcome = /welcome/i.test(String(title || '')) || /\bwelcome\b/i.test(text)
  const isLoading = /(loading|加载|载入|请稍候|spinner|读取中|初始化)/i.test(text)
  const isLogin = /(login|登录|登入|用户名|账号|密码|login_index)/i.test(text)
  const isFootballPage = hasEvents || (FOOTBALL_MARKET_RE.test(text) && /足球|football|soccer/i.test(text))
  let state = 'unknown'
  if (isFootballPage) state = 'football'
  else if (isLoading) state = 'loading'
  else if (isLogin) state = 'login'
  else if (isWelcome) state = 'welcome'
  else if (!normalizeText(bodyText) && !hasEvents) state = 'empty'

  return {
    state,
    isWelcome,
    isLoading,
    isLogin,
    isFootballPage,
  }
}

function isExcludedFootballText(text) {
  return ESPORTS_FOOTBALL_RE.test(normalizeText(text))
}

function isLeagueCandidate(text) {
  const normalized = normalizeText(text)
  if (!normalized || normalized.length > 120) return false
  if (PREMATCH_TIME_RE.test(normalized) || LIVE_STATUS_RE.test(normalized)) return false
  if (FOOTBALL_MARKET_RE.test(normalized)) return false
  if (/^(足球|今日赛事|全部|赛前|滚球|主要玩法|让球&大小)$/.test(normalized)) return false
  return /(赛|杯|联赛|冠军|外围|锦标|U\d+|世界杯|球员)/.test(normalized)
}

function extractOdds(text) {
  const odds = []
  const re = /(?<![\d.])[+-]?\d+(?:\.\d{1,3})(?![\d.])/g
  for (const match of normalizeText(text).matchAll(re)) {
    odds.push(match[0])
    if (odds.length >= 80) break
  }
  return odds
}

function parseTeamsFromSummary(summaryText) {
  let text = normalizeText(summaryText)
  text = text.replace(PREMATCH_TIME_RE, '')
  text = text.replace(LIVE_STATUS_RE, '')
  text = text.replace(/^(?:\d+\s+){1,6}/, '')
  const tokens = text.split(/\s+/).filter(Boolean)
  const names = []
  for (const token of tokens) {
    if (/^\d+$/.test(token)) continue
    names.push(token)
    if (names.length >= 2) break
  }
  return names
}

export function extractEventCardsFromContainers(containers = []) {
  const events = []
  let currentLeague = ''

  for (let i = 0; i < containers.length; i += 1) {
    const item = containers[i]
    const pathText = String(item.path || '')
    const idMatch = pathText.match(/^div#game_(\d+)$/)
    if (!idMatch) continue

    const text = normalizeText(item.text)
    if (!text || !FOOTBALL_MARKET_RE.test(text)) continue

    for (let j = i - 1; j >= 0 && j >= i - 8; j -= 1) {
      const previousText = normalizeText(containers[j]?.text)
      const needle = text.slice(0, 80)
      const pos = previousText.indexOf(needle)
      if (pos <= 0) continue
      const prefix = normalizeText(previousText.slice(0, pos))
      if (isLeagueCandidate(prefix)) {
        currentLeague = prefix
        break
      }
    }

    const id = idMatch[1]
    const summary = containers.find((candidate) => String(candidate.path || '') === `div#mainShow_${id}`)
    const summaryText = normalizeText(summary?.text || '')
    const mode = detectEventMode(`${summaryText} ${text}`)
    const combined = normalizeText(`${currentLeague} ${summaryText} ${text}`)

    events.push({
      id,
      mode,
      league: currentLeague,
      teams: parseTeamsFromSummary(summaryText || text),
      summaryText,
      text: text.slice(0, 2500),
      odds: extractOdds(text),
      excludedByDefault: isExcludedFootballText(combined),
      path: item.path,
      rect: item.rect,
    })
  }

  return events
}

export function buildFootballTodayFiltered(dom) {
  const eventCards = Array.isArray(dom.eventCards) && dom.eventCards.length
    ? dom.eventCards
    : extractEventCardsFromContainers(dom.containers || [])

  const included = []
  const excluded = []

  for (const card of eventCards) {
    const combined = normalizeText(`${card.league || ''} ${card.summaryText || ''} ${card.text || ''}`)
    const mode = card.mode || detectEventMode(combined)
    const normalizedCard = {
      ...card,
      mode,
      odds: Array.isArray(card.odds) ? card.odds : extractOdds(card.text || ''),
      excludedByDefault: isExcludedFootballText(combined),
    }

    if (normalizedCard.excludedByDefault) {
      excluded.push(normalizedCard)
      continue
    }
    if ((mode === 'prematch' || mode === 'live') && FOOTBALL_MARKET_RE.test(combined)) {
      included.push(normalizedCard)
    }
  }

  const prematch = included.filter((item) => item.mode === 'prematch')
  const live = included.filter((item) => item.mode === 'live')

  return {
    capturedAt: dom.capturedAt,
    url: dom.url,
    title: dom.title,
    filters: {
      sport: 'football',
      page: 'today',
      includeModes: ['prematch', 'live'],
      excludePattern: ESPORTS_FOOTBALL_RE.source,
    },
    counts: {
      sourceEventCards: eventCards.length,
      included: included.length,
      prematch: prematch.length,
      live: live.length,
      excluded: excluded.length,
    },
    prematch,
    live,
    pageHealth: classifyPageHealth({
      title: dom.title,
      url: dom.url,
      bodyText: dom.bodyText,
      eventCards: included.length,
    }),
    excludedSamples: excluded.slice(0, 20).map((item) => ({
      id: item.id,
      mode: item.mode,
      league: item.league,
      teams: item.teams,
      summaryText: item.summaryText,
      path: item.path,
    })),
  }
}

function browserDomExtractor() {
  const now = new Date().toISOString()
  const oddsTextRe = /^[+-]?\d+(?:\.\d{1,3})?$/
  const oddsInTextRe = /(^|\s)[+-]?\d+\.\d{2,3}(\s|$)/
  const attrRe = /(odds|odd|bet|wager|event|match|league|market|line|handicap|hdp|selection|sel|team|game|gid|mid|sid|type|name|price|rate)/i
  const esportsFootballRe = /(电竞|电子|虚拟|梦幻赛|梦幻足球|e\s*[-_ ]?\s*football|efootball|cyber|gt\s*体育|GT体育|2\s*[xX]\s*6\s*分钟|模拟足球)/i
  const footballMarketRe = /(让球|大\/小|独赢|角球|罚牌|波胆|进球|双方球队进球|开球|上半场)/
  const prematchTimeRe = /(?:今日|今天)\s*\d{1,2}:\d{2}/
  const liveStatusRe = /(上半场|下半场|中场|半场休息|加时|点球|第\s*\d+\s*分钟)\s*\d{0,2}:?\d{0,2}/

  function attrsOf(el) {
    const attrs = {}
    for (const attr of Array.from(el.attributes || [])) {
      if (
        attr.name === 'id' ||
        attr.name === 'class' ||
        attr.name === 'href' ||
        attr.name === 'role' ||
        attr.name.startsWith('data-') ||
        attrRe.test(attr.name)
      ) {
        attrs[attr.name] = String(attr.value || '').slice(0, 500)
      }
    }
    return attrs
  }

  function cssPath(el) {
    const parts = []
    let cur = el
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth += 1) {
      let part = cur.tagName.toLowerCase()
      if (cur.id) {
        part += `#${CSS.escape(cur.id)}`
        parts.unshift(part)
        break
      }
      const cls = Array.from(cur.classList || []).slice(0, 2)
      if (cls.length) part += `.${cls.map((x) => CSS.escape(x)).join('.')}`
      const parent = cur.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter((x) => x.tagName === cur.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
      }
      parts.unshift(part)
      cur = parent
    }
    return parts.join(' > ')
  }

  function nearbyText(el) {
    const container = el.closest(
      'tr,li,[class*="event" i],[class*="match" i],[class*="league" i],[class*="market" i],[class*="coupon" i],[class*="game" i],[class*="row" i]'
    ) || el.parentElement
    return {
      containerTag: container?.tagName?.toLowerCase() || '',
      containerAttrs: container ? attrsOf(container) : {},
      containerText: (container?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      containerPath: container ? cssPath(container) : '',
    }
  }

  function storagePreview(storage) {
    const items = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      const value = storage.getItem(key)
      items.push({
        key,
        length: value ? value.length : 0,
        preview: /(token|auth|session|password|secret|csrf|jwt|sign)/i.test(key || '')
          ? `[masked:${value ? value.length : 0}]`
          : String(value || '').slice(0, 160),
      })
    }
    return items
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function detectMode(text) {
    const normalized = normalize(text)
    if (prematchTimeRe.test(normalized)) return 'prematch'
    if (liveStatusRe.test(normalized)) return 'live'
    return 'unknown'
  }

  function isLeagueCandidateText(text) {
    const normalized = normalize(text)
    if (!normalized || normalized.length > 120) return false
    if (prematchTimeRe.test(normalized) || liveStatusRe.test(normalized)) return false
    if (footballMarketRe.test(normalized)) return false
    if (/^(足球|今日赛事|全部|赛前|滚球|主要玩法|让球&大小)$/.test(normalized)) return false
    return /(赛|杯|联赛|冠军|外围|锦标|U\d+|世界杯|球员)/.test(normalized)
  }

  function parseTeams(summaryText) {
    let text = normalize(summaryText)
    text = text.replace(prematchTimeRe, '')
    text = text.replace(liveStatusRe, '')
    text = text.replace(/^(?:\d+\s+){1,6}/, '')
    const teams = []
    for (const token of text.split(/\s+/).filter(Boolean)) {
      if (/^\d+$/.test(token)) continue
      teams.push(token)
      if (teams.length >= 2) break
    }
    return teams
  }

  function oddsFromText(text) {
    const odds = []
    const re = /(?<![\d.])[+-]?\d+(?:\.\d{1,3})(?![\d.])/g
    for (const match of normalize(text).matchAll(re)) {
      odds.push(match[0])
      if (odds.length >= 80) break
    }
    return odds
  }

  const candidates = []
  for (const el of Array.from(document.querySelectorAll('a,button,input,select,td,th,span,div'))) {
    const text = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim()
    const attrs = attrsOf(el)
    const attrBlob = JSON.stringify(attrs)
    const looksRelevant =
      oddsTextRe.test(text) ||
      oddsInTextRe.test(text) ||
      attrRe.test(attrBlob) ||
      attrRe.test(text)
    if (!looksRelevant) continue
    const r = el.getBoundingClientRect()
    candidates.push({
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 300),
      attrs,
      path: cssPath(el),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      },
      context: nearbyText(el),
    })
    if (candidates.length >= 3000) break
  }

  const containers = []
  for (const el of Array.from(document.querySelectorAll('tr,li,section,article,div'))) {
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
    if (text.length < 10) continue
    const attrs = attrsOf(el)
    const attrBlob = JSON.stringify(attrs)
    if (!oddsInTextRe.test(text) && !attrRe.test(attrBlob)) continue
    const r = el.getBoundingClientRect()
    containers.push({
      tag: el.tagName.toLowerCase(),
      attrs,
      path: cssPath(el),
      text: text.slice(0, 1500),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      },
    })
    if (containers.length >= 800) break
  }

  const eventCards = []
  let currentLeague = ''
  for (const el of Array.from(document.querySelectorAll('div[id^="game_"]'))) {
    const text = normalize(el.innerText)
    if (!text || !footballMarketRe.test(text)) continue

    const wrapperText = normalize(el.parentElement?.innerText || '')
    const eventPos = wrapperText.indexOf(text)
    const prefix = eventPos > 0 ? normalize(wrapperText.slice(0, eventPos)) : ''
    if (isLeagueCandidateText(prefix)) currentLeague = prefix

    const eventNo = String(el.id || '').replace(/^game_/, '')
    const summaryEl = document.querySelector(`#mainShow_${CSS.escape(eventNo)}`) || el.querySelector('[id^="mainShow_"]')
    const summaryText = normalize(summaryEl?.innerText || '')
    let teams = Array.from(el.querySelectorAll('[class*="text_team" i]'))
      .map((teamEl) => normalize(teamEl.innerText || teamEl.textContent || ''))
      .filter(Boolean)
    teams = Array.from(new Set(teams)).slice(0, 2)
    if (teams.length < 2) teams = parseTeams(summaryText || text)

    const combined = normalize(`${currentLeague} ${summaryText} ${text}`)
    const r = el.getBoundingClientRect()
    eventCards.push({
      id: eventNo,
      mode: detectMode(combined),
      league: currentLeague,
      teams,
      summaryText,
      text: text.slice(0, 2500),
      odds: oddsFromText(text),
      excludedByDefault: esportsFootballRe.test(combined),
      attrs: attrsOf(el),
      path: cssPath(el),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0,
      },
    })
  }

  return {
    capturedAt: now,
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    localStorage: storagePreview(window.localStorage),
    sessionStorage: storagePreview(window.sessionStorage),
    bodyText: (document.body?.innerText || '').replace(/\s+\n/g, '\n').trim(),
    candidates,
    containers,
    eventCards,
  }
}

function isRetryableDomExtractionError(error) {
  return /execution context was destroyed|most likely because of a navigation|Cannot find context with specified id/i.test(String(error?.message || error))
}

async function wait(ms) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function extractFootballDomSnapshot(page, { retries = 2, retryDelayMs = 500 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await page.evaluate(browserDomExtractor)
    } catch (error) {
      lastError = error
      if (!isRetryableDomExtractionError(error) || attempt >= retries) throw error
      await wait(retryDelayMs)
    }
  }
  throw lastError
}

export async function extractFootballTodayFromPage(page) {
  const dom = await extractFootballDomSnapshot(page)
  return buildFootballTodayFiltered(dom)
}
