import fs from 'node:fs'
import path from 'node:path'

import { collectPageSessionSnapshot } from './crown-session-detector.mjs'

const SAFE_STATES = new Set([
  '',
  '配置错误',
  '网络异常',
  'XML 无响应',
  '登录失效',
  '需要人工验证',
  '表单未找到',
  'Welcome 页面',
  '未知',
  '已登录',
])
const SAFE_ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError'])

function pad(value) {
  return String(value).padStart(2, '0')
}

function timestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function accountId(account = {}) {
  return account.accountId || account.id || 'mon_primary'
}

function safeAccountId(value) {
  const normalized = String(value || 'mon_primary').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  return normalized || 'mon_primary'
}

function safeState(value) {
  const normalized = String(value || '')
  return SAFE_STATES.has(normalized) ? normalized : '诊断失败'
}

function safeOrigin(value) {
  try {
    return new URL(String(value || '')).origin
  } catch {
    return ''
  }
}

function nonNegativeCount(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function isSecretField(field) {
  const descriptor = `${field?.type || ''} ${field?.name || ''} ${field?.id || ''} ${field?.placeholder || ''}`
  return /password|passwd|secret|token|密码|口令/i.test(descriptor)
}

function summarizePage(snapshot = {}) {
  const current = snapshot?.page && typeof snapshot.page === 'object' && !Array.isArray(snapshot.page)
    ? snapshot.page
    : null
  if (current) {
    return {
      available: current.available === true,
      origin: safeOrigin(current.origin),
      titlePresent: current.titlePresent === true,
      formControlCount: nonNegativeCount(current.formControlCount),
      visibleFormControlCount: nonNegativeCount(current.visibleFormControlCount),
      secretFieldPresent: current.secretFieldPresent === true,
      actionCount: nonNegativeCount(current.actionCount),
      frameCount: nonNegativeCount(current.frameCount),
      browserDataEntryCount: nonNegativeCount(current.browserDataEntryCount),
    }
  }

  const inputs = Array.isArray(snapshot?.inputs) ? snapshot.inputs : []
  const buttons = Array.isArray(snapshot?.buttons) ? snapshot.buttons : []
  const iframes = Array.isArray(snapshot?.iframes) ? snapshot.iframes : []
  const localEntries = Array.isArray(snapshot?.localStorage) ? snapshot.localStorage.length : 0
  const sessionEntries = Array.isArray(snapshot?.sessionStorage) ? snapshot.sessionStorage.length : 0
  return {
    available: Boolean(snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length),
    origin: safeOrigin(snapshot?.url),
    titlePresent: Boolean(String(snapshot?.title || '').trim()),
    formControlCount: inputs.length,
    visibleFormControlCount: inputs.filter((input) => input?.visible !== false).length,
    secretFieldPresent: inputs.some(isSecretField),
    actionCount: buttons.length,
    frameCount: iframes.length,
    browserDataEntryCount: localEntries + sessionEntries,
  }
}

function debugCounts(value) {
  const counts = {
    booleanTrueCount: 0,
    booleanFalseCount: 0,
    numberCount: 0,
    textCount: 0,
    objectCount: 0,
    arrayCount: 0,
  }
  const visit = (item) => {
    if (Array.isArray(item)) {
      counts.arrayCount += 1
      item.forEach(visit)
      return
    }
    if (item && typeof item === 'object') {
      counts.objectCount += 1
      Object.values(item).forEach(visit)
      return
    }
    if (typeof item === 'boolean') counts[item ? 'booleanTrueCount' : 'booleanFalseCount'] += 1
    else if (typeof item === 'number' && Number.isFinite(item)) counts.numberCount += 1
    else if (typeof item === 'string' && item.length) counts.textCount += 1
  }
  visit(value)
  return counts
}

function summarizeDebug(snapshot = {}, fallback = {}) {
  const current = snapshot?.debugSummary && typeof snapshot.debugSummary === 'object' && !Array.isArray(snapshot.debugSummary)
    ? snapshot.debugSummary
    : null
  if (current) {
    return {
      provided: current.provided === true,
      booleanTrueCount: nonNegativeCount(current.booleanTrueCount),
      booleanFalseCount: nonNegativeCount(current.booleanFalseCount),
      numberCount: nonNegativeCount(current.numberCount),
      textCount: nonNegativeCount(current.textCount),
      objectCount: nonNegativeCount(current.objectCount),
      arrayCount: nonNegativeCount(current.arrayCount),
    }
  }
  const source = snapshot?.extraDebug ?? fallback
  return {
    provided: Boolean(source && typeof source === 'object' && Object.keys(source).length),
    ...debugCounts(source),
  }
}

function safeErrorType(value) {
  const normalized = String(value || '')
  return SAFE_ERROR_TYPES.has(normalized) ? normalized : 'Error'
}

export function sanitizeLoginDiagnosticSnapshot(snapshot = {}, {
  account = null,
  classifiedState = undefined,
  error = undefined,
  extraDebug = undefined,
} = {}) {
  const hasError = error !== undefined
    ? Boolean(error)
    : snapshot?.hasError === true || Boolean(snapshot?.errorMessage || snapshot?.screenshotError)
  const rawAccountId = account ? accountId(account) : (snapshot?.accountId || snapshot?.account?.id)
  const errorType = error instanceof Error ? error.name : snapshot?.errorType
  return {
    schemaVersion: 2,
    accountId: safeAccountId(rawAccountId),
    classifiedState: safeState(classifiedState === undefined ? snapshot?.classifiedState : classifiedState),
    hasError,
    errorType: hasError ? safeErrorType(errorType) : '',
    page: summarizePage(snapshot),
    debugSummary: summarizeDebug(snapshot, extraDebug),
    screenshotCaptured: false,
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function collectLoginSnapshot(page, extraDebug = {}) {
  const pageSnapshot = await collectPageSessionSnapshot(page)
  return sanitizeLoginDiagnosticSnapshot(pageSnapshot, { extraDebug })
}

export async function saveLoginDiagnostics({
  page,
  account = {},
  classifiedState = '',
  error = null,
  runtimeDir = 'data/runtime',
  extraDebug = {},
} = {}) {
  const dir = path.join(runtimeDir, 'login-diagnostics', `${timestamp()}-${safeAccountId(accountId(account))}`)
  fs.mkdirSync(dir, { recursive: true })

  const collected = await collectLoginSnapshot(page, extraDebug)
  const snapshot = sanitizeLoginDiagnosticSnapshot(collected, { account, classifiedState, error, extraDebug })
  writeJson(path.join(dir, 'snapshot.json'), snapshot)
  return { diagnosticPath: dir, screenshotPath: '', snapshot }
}

export function readLoginDiagnostics(diagnosticPath) {
  if (!diagnosticPath) return { item: null }
  const snapshotPath = path.join(diagnosticPath, 'snapshot.json')
  if (!fs.existsSync(snapshotPath)) return { item: null }
  try {
    return { item: sanitizeLoginDiagnosticSnapshot(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))) }
  } catch {
    return { item: null }
  }
}
