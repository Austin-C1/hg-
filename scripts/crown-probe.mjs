#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import {
  buildFootballTodayFiltered as buildSharedFootballTodayFiltered,
  extractEventCardsFromContainers as extractSharedEventCardsFromContainers,
  extractFootballDomSnapshot,
} from '../src/crown/dom-football-extractor.mjs'

const DEFAULT_URL = 'https://m321.mos077.com'
const INTERESTING_URL_RE = /(api|ajax|sport|event|match|league|market|odds|handicap|wager|bet|order|coupon|game|race|live|today|early)/i
const SECRET_KEY_RE = /(token|cookie|password|passwd|authorization|auth|session|secret|csrf|xsrf|jwt|signature|sign)/i
const ESPORTS_FOOTBALL_RE = /(电竞|电子|虚拟|梦幻赛|梦幻足球|e\s*[-_ ]?\s*football|efootball|cyber|gt\s*体育|GT体育|2\s*[xX]\s*6\s*分钟|模拟足球)/i
const FOOTBALL_MARKET_RE = /(让球|大\/小|独赢|角球|罚牌|波胆|进球|双方球队进球|开球|上半场)/
const PREMATCH_TIME_RE = /(?:今日|今天)\s*\d{1,2}:\d{2}/
const LIVE_STATUS_RE = /(上半场|下半场|中场|半场休息|加时|点球|第\s*\d+\s*分钟)\s*\d{0,2}:?\d{0,2}/

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    out: 'data/crown-probe',
    profile: 'data/crown-profile',
    channel: process.env.CROWN_BROWSER_CHANNEL || 'msedge',
    headless: false,
    once: false,
    captureSeconds: 0,
    maxBodyBytes: 300_000,
    saveHtml: false,
    allJson: true,
    fromCapture: '',
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--url') args.url = next()
    else if (a === '--out') args.out = next()
    else if (a === '--profile') args.profile = next()
    else if (a === '--channel') args.channel = next()
    else if (a === '--headless') args.headless = true
    else if (a === '--once') args.once = true
    else if (a === '--capture-seconds') args.captureSeconds = Number(next() || 0)
    else if (a === '--max-body-bytes') args.maxBodyBytes = Number(next() || args.maxBodyBytes)
    else if (a === '--save-html') args.saveHtml = true
    else if (a === '--interesting-json-only') args.allJson = false
    else if (a === '--from-capture') args.fromCapture = next()
    else if (a === '--help' || a === '-h') args.help = true
    else throw new Error(`Unknown argument: ${a}`)
  }

  return args
}

function printHelp() {
  console.log(`皇冠只读采集器

Usage:
  npm run crown:probe -- [options]
  node scripts/crown-probe.mjs [options]

Options:
  --url <url>                 默认 ${DEFAULT_URL}
  --out <dir>                 输出目录，默认 data/crown-probe
  --profile <dir>             浏览器登录态目录，默认 data/crown-profile
  --channel <name>            浏览器渠道，默认 msedge，可用 chrome/chromium/msedge
  --once                      打开后立即采集一次并退出
  --capture-seconds <n>       等待 n 秒记录 Network 后采集并退出
  --save-html                 额外保存当前 HTML，可能包含敏感页面数据
  --interesting-json-only     只保存 URL 看起来相关的 JSON 响应
  --from-capture <dir>        从已有采集目录生成今日足球过滤结果
  --headless                  无头模式，不适合首次登录
  --help                      显示帮助

安全边界:
  只读取 DOM、截图、Network 元数据和 JSON 响应样本。
  脚本不会点击盘口、不会填金额、不会提交下注。`)
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function timestampForPath(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function truncate(value, max = 1000) {
  if (typeof value !== 'string') return value
  if (value.length <= max) return value
  return `${value.slice(0, max)}...[truncated ${value.length - max} chars]`
}

function maskScalar(key, value) {
  if (value == null) return value
  const str = String(value)
  if (SECRET_KEY_RE.test(String(key))) {
    return `[masked:${str.length}]`
  }
  return truncate(str, 500)
}

function sanitizeObject(value, parentKey = '') {
  if (value == null) return value
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeObject(item, parentKey))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) out[k] = maskScalar(k, v)
      else out[k] = sanitizeObject(v, k)
    }
    return out
  }
  return maskScalar(parentKey, value)
}

function sanitizeHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = maskScalar(k, v)
  }
  return out
}

function sanitizePostData(postData) {
  if (!postData) return ''
  const trimmed = postData.trim()
  try {
    return sanitizeObject(JSON.parse(trimmed))
  } catch {
    try {
      const params = new URLSearchParams(trimmed)
      const out = {}
      for (const [k, v] of params.entries()) out[k] = maskScalar(k, v)
      return out
    } catch {
      return truncate(trimmed, 2000)
    }
  }
}

function sanitizeTextBody(text) {
  return String(text || '')
    .replace(/<uid>[\s\S]*?<\/uid>/gi, '<uid>[masked]</uid>')
    .replace(/uid=([^&<"']+)/gi, 'uid=[masked]')
    .replace(/<(password|passwd|token|authorization|session|secret|csrf|xsrf|jwt|signature|sign)>[\s\S]*?<\/\1>/gi, '<$1>[masked]</$1>')
}

function safeFileName(input, suffix) {
  const cleaned = input
    .replace(/^https?:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120)
  return `${cleaned || 'response'}${suffix}`
}

async function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

async function saveText(file, data) {
  fs.writeFileSync(file, data, 'utf8')
}

function shouldCaptureJson(url, allJson) {
  return allJson || INTERESTING_URL_RE.test(url)
}

function shouldCaptureTextResponse(url, contentType, request) {
  if (!/\/transform(?:_nl)?\.php/i.test(url)) return false
  if (!/xml|text\/html|text\/plain/i.test(contentType)) return false
  const postData = request.postData() || ''
  return /(get_game_list|get_game_more|chk_login|memSet|get_member_data)/i.test(postData)
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function detectEventMode(text) {
  const normalized = normalizeText(text)
  if (PREMATCH_TIME_RE.test(normalized)) return 'prematch'
  if (LIVE_STATUS_RE.test(normalized)) return 'live'
  return 'unknown'
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

function extractEventCardsFromContainers(containers = []) {
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

function buildFootballTodayFiltered(dom) {
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

function installNetworkRecorder(page, runDir, args) {
  const jsonDir = path.join(runDir, 'json-responses')
  const textDir = path.join(runDir, 'text-responses')
  mkdirp(jsonDir)
  mkdirp(textDir)
  const networkLog = path.join(runDir, 'network.jsonl')
  const summary = []
  let responseSeq = 0
  let textResponseSeq = 0

  function append(record) {
    summary.push(record)
    fs.appendFileSync(networkLog, `${JSON.stringify(record)}\n`, 'utf8')
  }

  page.on('request', (request) => {
    const url = request.url()
    const record = {
      type: 'request',
      ts: Date.now(),
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
    }
    const postData = request.postData()
    if (postData) record.postData = sanitizePostData(postData)
    append(record)
  })

  page.on('response', async (response) => {
    const request = response.request()
    const url = response.url()
    const headers = response.headers()
    const contentType = headers['content-type'] || headers['Content-Type'] || ''
    const record = {
      type: 'response',
      ts: Date.now(),
      method: request.method(),
      url,
      status: response.status(),
      resourceType: request.resourceType(),
      contentType,
    }

    const isJson = /json/i.test(contentType)
    if (isJson && shouldCaptureJson(url, args.allJson)) {
      try {
        const body = await response.text()
        record.bodyBytes = Buffer.byteLength(body, 'utf8')
        if (record.bodyBytes <= args.maxBodyBytes) {
          let parsed
          try {
            parsed = sanitizeObject(JSON.parse(body))
          } catch {
            parsed = truncate(body, args.maxBodyBytes)
          }
          responseSeq += 1
          const file = path.join(jsonDir, `${String(responseSeq).padStart(4, '0')}_${safeFileName(url, '.json')}`)
          saveJson(file, {
            url,
            status: response.status(),
            method: request.method(),
            capturedAt: new Date().toISOString(),
            body: parsed,
          })
          record.savedBody = path.relative(runDir, file)
        } else {
          record.savedBody = `skipped: body ${record.bodyBytes} bytes > ${args.maxBodyBytes}`
        }
      } catch (error) {
        record.bodyError = error.message
      }
    }

    if (!isJson && shouldCaptureTextResponse(url, contentType, request)) {
      try {
        const body = await response.text()
        record.bodyBytes = Buffer.byteLength(body, 'utf8')
        if (record.bodyBytes <= args.maxBodyBytes) {
          textResponseSeq += 1
          const suffix = /xml/i.test(contentType) || /<\?xml|<serverresponse/i.test(body) ? '.xml' : '.txt'
          const file = path.join(textDir, `${String(textResponseSeq).padStart(4, '0')}_${safeFileName(url, suffix)}`)
          saveText(file, sanitizeTextBody(body))
          record.savedBody = path.relative(runDir, file)
        } else {
          record.savedBody = `skipped: body ${record.bodyBytes} bytes > ${args.maxBodyBytes}`
        }
      } catch (error) {
        record.bodyError = error.message
      }
    }

    append(record)
  })

  return {
    saveSummary() {
      saveJson(path.join(runDir, 'network-summary.json'), summary)
    },
  }
}

async function extractDom(page) {
  return page.evaluate(() => {
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

    function normalizeText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }

    function detectMode(text) {
      const normalized = normalizeText(text)
      if (prematchTimeRe.test(normalized)) return 'prematch'
      if (liveStatusRe.test(normalized)) return 'live'
      return 'unknown'
    }

    function isLeagueCandidate(text) {
      const normalized = normalizeText(text)
      if (!normalized || normalized.length > 120) return false
      if (prematchTimeRe.test(normalized) || liveStatusRe.test(normalized)) return false
      if (footballMarketRe.test(normalized)) return false
      if (/^(足球|今日赛事|全部|赛前|滚球|主要玩法|让球&大小)$/.test(normalized)) return false
      return /(赛|杯|联赛|冠军|外围|锦标|U\d+|世界杯|球员)/.test(normalized)
    }

    function parseTeamsFromSummary(summaryText) {
      let text = normalizeText(summaryText)
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
      for (const match of normalizeText(text).matchAll(re)) {
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
      candidates.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 300),
        attrs,
        path: cssPath(el),
        rect: (() => {
          const r = el.getBoundingClientRect()
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            visible: r.width > 0 && r.height > 0,
          }
        })(),
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
      const text = normalizeText(el.innerText)
      if (!text || !footballMarketRe.test(text)) continue

      const wrapperText = normalizeText(el.parentElement?.innerText || '')
      const eventPos = wrapperText.indexOf(text)
      const prefix = eventPos > 0 ? normalizeText(wrapperText.slice(0, eventPos)) : ''
      if (isLeagueCandidate(prefix)) currentLeague = prefix

      const eventNo = String(el.id || '').replace(/^game_/, '')
      const summaryEl = document.querySelector(`#mainShow_${CSS.escape(eventNo)}`) || el.querySelector('[id^="mainShow_"]')
      const summaryText = normalizeText(summaryEl?.innerText || '')
      let teams = Array.from(el.querySelectorAll('[class*="text_team" i]'))
        .map((teamEl) => normalizeText(teamEl.innerText || teamEl.textContent || ''))
        .filter(Boolean)
      teams = Array.from(new Set(teams)).slice(0, 2)
      if (teams.length < 2) teams = parseTeamsFromSummary(summaryText || text)

      const combined = normalizeText(`${currentLeague} ${summaryText} ${text}`)
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
  })
}

async function capturePage(page, runDir, args, label = 'capture') {
  const captureDir = path.join(runDir, `${label}_${timestampForPath()}`)
  mkdirp(captureDir)

  const dom = await extractFootballDomSnapshot(page)
  await saveJson(path.join(captureDir, 'dom-snapshot.json'), {
    capturedAt: dom.capturedAt,
    url: dom.url,
    title: dom.title,
    viewport: dom.viewport,
    localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage,
  })
  await saveJson(path.join(captureDir, 'dom-candidates.json'), dom.candidates)
  await saveJson(path.join(captureDir, 'dom-containers.json'), dom.containers)
  await saveJson(path.join(captureDir, 'dom-events.json'), dom.eventCards || [])
  const footballToday = buildSharedFootballTodayFiltered(dom)
  await saveJson(path.join(captureDir, 'football-today-filtered.json'), footballToday)
  await saveText(path.join(captureDir, 'page-text.txt'), dom.bodyText)

  if (args.saveHtml) {
    await saveText(path.join(captureDir, 'page.html'), await page.content())
  }

  await page.screenshot({ path: path.join(captureDir, 'page.png'), fullPage: true })

  console.log(`采集完成: ${captureDir}`)
  console.log(`候选元素: ${dom.candidates.length}，候选容器: ${dom.containers.length}`)
  console.log(`今日足球过滤: 赛前 ${footballToday.counts.prematch}，滚球 ${footballToday.counts.live}，已排除 ${footballToday.counts.excluded}`)
  return captureDir
}

async function postprocessCapture(captureDir) {
  const snapshotPath = path.join(captureDir, 'dom-snapshot.json')
  const containersPath = path.join(captureDir, 'dom-containers.json')
  const eventsPath = path.join(captureDir, 'dom-events.json')
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(containersPath)) {
    throw new Error(`Capture directory is missing dom-snapshot.json or dom-containers.json: ${captureDir}`)
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const containers = JSON.parse(fs.readFileSync(containersPath, 'utf8'))
  const eventCards = fs.existsSync(eventsPath)
    ? JSON.parse(fs.readFileSync(eventsPath, 'utf8'))
    : []
  const sourceEventCards = eventCards.length ? eventCards : extractSharedEventCardsFromContainers(containers)
  await saveJson(eventsPath, sourceEventCards)
  const filtered = buildSharedFootballTodayFiltered({
    ...snapshot,
    containers,
    eventCards: sourceEventCards,
  })

  await saveJson(path.join(captureDir, 'football-today-filtered.json'), filtered)
  console.log(`已生成: ${path.join(captureDir, 'football-today-filtered.json')}`)
  console.log(`今日足球过滤: 赛前 ${filtered.counts.prematch}，滚球 ${filtered.counts.live}，已排除 ${filtered.counts.excluded}`)
}

async function launchContext(args) {
  const { chromium } = await import('playwright')
  mkdirp(args.profile)

  const launchOptions = {
    headless: args.headless,
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
    ],
  }
  if (args.channel && args.channel !== 'chromium') {
    launchOptions.channel = args.channel
  }

  return chromium.launchPersistentContext(args.profile, launchOptions)
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.fromCapture) {
    await postprocessCapture(args.fromCapture)
    return
  }

  const runDir = path.join(args.out, timestampForPath())
  mkdirp(runDir)
  mkdirp(args.profile)

  console.log(`输出目录: ${runDir}`)
  console.log(`登录态目录: ${args.profile}`)
  console.log('只读模式：脚本不会点击盘口、不会填金额、不会提交下注。')

  const context = await launchContext(args)
  const page = context.pages()[0] || await context.newPage()
  const recorder = installNetworkRecorder(page, runDir, args)

  page.on('console', (msg) => {
    const record = {
      type: 'browser-console',
      ts: Date.now(),
      level: msg.type(),
      text: truncate(msg.text(), 1000),
    }
    fs.appendFileSync(path.join(runDir, 'browser-console.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  })

  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
    console.warn(`打开页面失败，可在浏览器手动输入地址: ${error.message}`)
  })

  if (args.captureSeconds > 0) {
    console.log(`等待 ${args.captureSeconds}s 记录 Network，请在浏览器里进入目标赛事页...`)
    await wait(args.captureSeconds * 1000)
    await capturePage(page, runDir, args, 'timed')
    recorder.saveSummary()
    await context.close()
    return
  }

  if (args.once) {
    await capturePage(page, runDir, args, 'once')
    recorder.saveSummary()
    await context.close()
    return
  }

  const rl = readline.createInterface({ input, output })
  console.log('')
  console.log('操作方式：')
  console.log('1. 在打开的浏览器里登录皇冠。')
  console.log('2. 手动进入要分析的页面，例如 足球 → 今日/早盘/滚球。')
  console.log('3. 回到终端按 Enter 采集当前页；输入 q 退出；输入 r 继续记录 Network 30 秒再采集。')

  let captureCount = 1
  while (true) {
    const answer = (await rl.question('按 Enter 采集 / r 记录30秒后采集 / q 退出: ')).trim().toLowerCase()
    if (answer === 'q' || answer === 'quit' || answer === 'exit') break
    if (answer === 'r') {
      console.log('继续记录 Network 30 秒，请在页面中切换联赛/盘口以触发请求...')
      await wait(30_000)
    }
    await capturePage(page, runDir, args, `manual_${String(captureCount).padStart(2, '0')}`)
    captureCount += 1
  }

  recorder.saveSummary()
  await rl.close()
  await context.close()
  console.log(`已退出。总输出目录: ${runDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
