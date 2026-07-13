const HUMAN_VERIFICATION_RE = /(captcha|recaptcha|verify|verification|slider|slide|otp|2fa|two[-\s]?factor|验证码|滑块|二次验证|安全验证|人机验证|动态码|短信验证|谷歌验证)/i
const WELCOME_RE = /\bwelcome\b|欢迎/i
const LOGIN_TEXT_RE = /(login|sign\s*in|登录|登入|账号|帐号|用户名|用户名称|密码|login_index|chk_login)/i
const FOOTBALL_RE = /(football|soccer|足球|今日赛事|滚球|让球|大小|盘口|赔率)/i

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function joinSnapshotText(snapshot = {}) {
  const inputText = Array.isArray(snapshot.inputs)
    ? snapshot.inputs.map((input) => `${input.type || ''} ${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.value || ''}`).join(' ')
    : ''
  const buttonText = Array.isArray(snapshot.buttons)
    ? snapshot.buttons.map((button) => `${button.text || ''} ${button.type || ''}`).join(' ')
    : ''
  return cleanText(`${snapshot.title || ''} ${snapshot.url || ''} ${snapshot.bodyText || ''} ${inputText} ${buttonText}`)
}

function result(status, extra = {}) {
  return {
    status,
    loggedIn: status === '已登录',
    humanRequired: status === '需要人工验证',
    ...extra,
  }
}

export function isHumanVerificationText(text) {
  return HUMAN_VERIFICATION_RE.test(cleanText(text))
}

export function isLoginFormSnapshot(snapshot = {}) {
  const inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : []
  const visibleInputs = inputs.filter((input) => input.visible !== false)
  const hasPassword = visibleInputs.some((input) => String(input.type || '').toLowerCase() === 'password' || /pass|密码/i.test(`${input.name || ''} ${input.id || ''} ${input.placeholder || ''}`))
  const hasUser = visibleInputs.some((input) => {
    const text = `${input.type || ''} ${input.name || ''} ${input.id || ''} ${input.placeholder || ''}`
    return /text|user|account|login|userid|账号|帐号|用户名/i.test(text)
  })
  return hasPassword || (hasUser && LOGIN_TEXT_RE.test(joinSnapshotText(snapshot)))
}

export function detectSessionFromSnapshot(snapshot = {}) {
  const text = joinSnapshotText(snapshot)
  if (isHumanVerificationText(text)) return result('需要人工验证')
  if (isLoginFormSnapshot(snapshot)) return result('登录失效')
  if (WELCOME_RE.test(String(snapshot.title || '')) || WELCOME_RE.test(String(snapshot.url || '')) || WELCOME_RE.test(text)) {
    return result('Welcome 页面')
  }
  if (snapshot.pageHealth?.isFootballPage || FOOTBALL_RE.test(text)) return result('已登录')
  if (snapshot.pageHealth?.isLogin || LOGIN_TEXT_RE.test(text)) return result('登录失效')
  return result('未知')
}

export function detectXmlSession(text) {
  const body = cleanText(text)
  if (!body) return result('未知', { xmlVerified: false })
  if (isHumanVerificationText(body)) return result('需要人工验证', { xmlVerified: false })
  if (LOGIN_TEXT_RE.test(body) || WELCOME_RE.test(body)) return result('登录失效', { xmlVerified: false })
  if (/<serverresponse\b/i.test(body) || /<game\b/i.test(body)) return result('已登录', { xmlVerified: true })
  return result('未知', { xmlVerified: false })
}

export async function collectPageSessionSnapshot(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || '',
      url: location.href,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
      inputs: Array.from(document.querySelectorAll('input')).slice(0, 80).map((input) => ({
        type: input.getAttribute('type') || '',
        name: input.getAttribute('name') || '',
        id: input.id || '',
        placeholder: input.getAttribute('placeholder') || '',
        visible: Boolean(input.offsetParent || input.getClientRects().length),
        value: input.value || '',
      })),
      buttons: Array.from(document.querySelectorAll('button,input[type="submit"],a')).slice(0, 80).map((button) => ({
        text: (button.innerText || button.value || '').replace(/\s+/g, ' ').trim(),
        type: button.getAttribute('type') || '',
        visible: Boolean(button.offsetParent || button.getClientRects().length),
      })),
      iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 30).map((iframe) => ({
        src: iframe.src || '',
        title: iframe.title || '',
      })),
    }))
  } catch {
    return {
      title: typeof page?.title === 'function' ? await page.title().catch(() => '') : '',
      url: typeof page?.url === 'function' ? page.url() : '',
      bodyText: '',
      inputs: [],
      buttons: [],
      iframes: [],
    }
  }
}

export async function detectPageSession(page) {
  return detectSessionFromSnapshot(await collectPageSessionSnapshot(page))
}
