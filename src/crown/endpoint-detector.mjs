const FOOTBALL_TEXT_RE = /(football|soccer|足球|世界杯|冠军联赛|让球|独赢|大\/小)/i
const ODDS_TEXT_RE = /(odds|price|ior|handicap|让球|独赢|大\/小|赔率)/i
import { isCrownTransformXml } from './crown-transform-xml.mjs'

const GISM0_RE = /\/gismo\/(match_info|match_details|match_detailsextended|match_timeline|match_timelinedelta|stats_)/i
const EXCLUDED_RE = /(电竞|电子|虚拟|梦幻足球|efootball|esport|virtual|fantasy|GT体育|鐢电珵|鐢靛瓙|铏氭嫙)/i

function textOf(value, max = 80_000) {
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value || '').slice(0, max)
  }
}

function metadataUrl(metadata = {}) {
  return String(metadata.url || metadata.requestUrl || '')
}

export function detectEndpoint({ body, metadata = {} } = {}) {
  const url = metadataUrl(metadata)
  const blob = `${url}\n${textOf(body)}`

  if (isCrownTransformXml({ body, metadata })) {
    return {
      detected: true,
      kind: 'crown-transform-xml',
      sport: 'football',
      mode: /<SHOWTYPE>\s*rb\s*<\/SHOWTYPE>|<IS_RB>\s*Y\s*<\/IS_RB>/i.test(blob) ? 'live' : 'mixed',
      confidence: 'high',
      reason: 'Crown transform XML contains game and IOR odds fields',
    }
  }

  if (body && Array.isArray(body.prematch) && Array.isArray(body.live)) {
    return {
      detected: true,
      kind: 'dom-football-fixture',
      sport: 'football',
      mode: 'mixed',
      confidence: 'high',
      reason: 'body contains prematch/live DOM football arrays',
    }
  }

  if (EXCLUDED_RE.test(blob)) {
    return {
      detected: false,
      kind: 'irrelevant',
      sport: 'unknown',
      mode: 'unknown',
      confidence: 'high',
      reason: 'excluded esports/virtual keyword',
    }
  }

  const isGismo = GISM0_RE.test(url) || /gismo\/match_|gismo\/stats_/i.test(String(body?.queryUrl || ''))
  const isSoccerDoc = /"_doctype"\s*:\s*"soccer"/i.test(blob) || /"_sid"\s*:\s*"1"/i.test(blob)
  if (isGismo && isSoccerDoc) {
    return {
      detected: true,
      kind: 'football-metadata',
      sport: 'football',
      mode: /timeline|score|matchstatus|periodscore/i.test(blob) ? 'live' : 'unknown',
      confidence: 'medium',
      reason: 'gismo soccer metadata response',
    }
  }

  if (FOOTBALL_TEXT_RE.test(blob) && ODDS_TEXT_RE.test(blob)) {
    return {
      detected: true,
      kind: 'football-odds-candidate',
      sport: 'football',
      mode: /live|滚球|上半场|下半场/i.test(blob) ? 'live' : 'unknown',
      confidence: 'low',
      reason: 'football and odds keywords present',
    }
  }

  return {
    detected: false,
    kind: 'unknown',
    sport: 'unknown',
    mode: 'unknown',
    confidence: 'low',
    reason: 'no football odds signal',
  }
}
