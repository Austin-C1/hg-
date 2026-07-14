#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import { createProtocolStore } from '../src/crown/betting-protocol/protocol-store.mjs'
import {
  CROWN_BROWSER_TARGETS,
  classifyProtocolRecord,
  classifyProtocolWebSocketFrame,
  shouldBlockProtocolRequest,
} from '../src/crown/betting-protocol/protocol-classifier.mjs'
import {
  analyzeCrownProtocolCapture,
  analyzeCrownProtocolCaptureSet,
} from './crown-betting-protocol-analyze.mjs'

const DEFAULT_URL = 'https://m407.mos077.com'
const CAPTURE_SCENARIOS = new Set(['discover', 'eight-direction'])

function captureError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export const EIGHT_DIRECTION_CAPTURE_MANIFEST = Object.freeze(
  CROWN_BROWSER_TARGETS.map((direction, ordinal) => Object.freeze({
    ordinal: ordinal + 1,
    direction,
    submitPolicy: 'block-at-route',
  })),
)

export function parseCaptureArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    profile: 'data/crown-profile',
    out: 'data/runtime/betting-protocol-captures',
    channel: process.env.CROWN_BROWSER_CHANNEL || 'msedge',
    headless: false,
    allowOddsClick: false,
    allowStakeFill: false,
    allowRealSubmit: false,
    blockSubmit: true,
    blockSubmitExplicit: false,
    scenario: 'discover',
    maxStake: 0,
    confirm: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--url') args.url = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--out') args.out = next()
    else if (arg === '--channel') args.channel = next()
    else if (arg === '--scenario') args.scenario = next()
    else if (arg === '--headless') args.headless = true
    else if (arg === '--allow-odds-click') args.allowOddsClick = true
    else if (arg === '--allow-stake-fill') args.allowStakeFill = true
    else if (arg === '--allow-real-submit') args.allowRealSubmit = true
    else if (arg === '--block-submit') {
      args.blockSubmit = true
      args.blockSubmitExplicit = true
    }
    else if (arg === '--max-stake') args.maxStake = Number(next() || 0)
    else if (arg === '--confirm') args.confirm = next()
    else throw captureError('unknown-argument', `Unknown argument: ${arg}`)
  }
  if (!CAPTURE_SCENARIOS.has(args.scenario)) {
    throw captureError('invalid-scenario', `invalid --scenario: ${args.scenario}`)
  }
  return args
}

export function assertCaptureSafety(args) {
  if (args.blockSubmitExplicit && args.allowRealSubmit) {
    throw new Error('--block-submit and --allow-real-submit conflict')
  }
  if (args.scenario === 'eight-direction' && args.allowRealSubmit) {
    throw new Error('eight-direction cannot be combined with --allow-real-submit')
  }
  if (args.scenario === 'eight-direction' && args.blockSubmit !== true) {
    throw new Error('eight-direction requires --block-submit')
  }
  if (args.allowRealSubmit) {
    if (args.confirm !== 'REAL_BET') throw new Error('--allow-real-submit requires --confirm REAL_BET')
    if (!Number.isSafeInteger(args.maxStake) || args.maxStake <= 0) throw new Error('--allow-real-submit requires an integer --max-stake > 0')
    if (args.maxStake > 50) throw new Error('First protocol submit max stake must be <= 50')
    if (args.headless) throw new Error('Real submit capture must run with visible browser')
  }
}

async function responseBody(response) {
  const headers = response.headers()
  const contentType = headers['content-type'] || ''
  if (!/json|text|xml|html|javascript|form/i.test(contentType)) return ''
  try {
    const text = await response.text()
    return text.length > 500_000 ? `${text.slice(0, 500_000)}...[truncated]` : text
  } catch {
    return ''
  }
}

function requestRecord(request) {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    headers: request.headers(),
    postData: request.postData() || '',
  }
}

function requestContentType(headers) {
  for (const [field, value] of Object.entries(headers || {})) {
    if (String(field).toLowerCase() === 'content-type') return String(value || '')
  }
  return ''
}

function canonicalFormBody(rawBody, headers) {
  const contentType = requestContentType(headers)
  // Deliberate allowlist: the base media type, or exactly one UTF-8/UTF8
  // charset parameter. Every other parameter or repeated charset is rejected.
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|utf8))?$/i.test(contentType.trim())) {
    return null
  }
  if (typeof rawBody !== 'string' || !rawBody || rawBody.trim() !== rawBody) return null
  const output = {}
  const fields = new Set()
  for (const segment of rawBody.split('&')) {
    if (!segment || segment.indexOf('=') <= 0 || segment.indexOf('=') !== segment.lastIndexOf('=')) return null
    const separator = segment.indexOf('=')
    const rawField = segment.slice(0, separator)
    const rawValue = segment.slice(separator + 1)
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawField)) return null
    if (rawField !== 'golds' && /gold|stake|amount|wager/i.test(rawField)) return null
    const normalizedField = rawField.toLowerCase()
    if (fields.has(normalizedField)) return null
    fields.add(normalizedField)
    if ((rawField === 'p' && rawValue !== 'FT_bet')
      || (rawField === 'golds' && !/^[1-9]\d*$/.test(rawValue))) return null
    if (/%(?![a-f0-9]{2})/i.test(rawValue) || /[\u0000-\u001f\u007f]/.test(rawValue)) return null
    let decodedValue
    try {
      decodedValue = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      return null
    }
    if (/[\u0000-\u001f\u007f]/.test(decodedValue)
      || /%(?:25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(decodedValue)) return null
    if (/^\s*[\[{]/.test(decodedValue)) return null
    output[rawField] = decodedValue
  }
  if (output.p !== 'FT_bet' || typeof output.golds !== 'string' || !/^[1-9]\d*$/.test(output.golds)) {
    return null
  }
  return output
}

function boundedRealSubmitStake(rawUrl, headers, rawBody) {
  let url
  try {
    url = new URL(String(rawUrl || ''), DEFAULT_URL)
  } catch {
    return null
  }
  if (url.search) return null
  const body = canonicalFormBody(rawBody, headers)
  return body ? BigInt(body.golds) : null
}

export function installRecorder(target, store, metadata = {}) {
  let sequence = 0
  let eventOrdinal = 0
  const requestSequences = new WeakMap()
  const socketSequences = new WeakMap()
  const attachedPages = new WeakSet()
  const pending = new Set()

  const nextEventOrdinal = () => ++eventOrdinal
  const sequenceForRequest = (request) => {
    if (!requestSequences.has(request)) requestSequences.set(request, ++sequence)
    return requestSequences.get(request)
  }
  const append = (record, reservedOrdinal = nextEventOrdinal()) => {
    const content = {
      ...metadata,
      ...record,
      eventOrdinal: reservedOrdinal,
    }
    store.append(content)
    return content
  }
  const track = (promise) => {
    pending.add(promise)
    promise.finally(() => pending.delete(promise))
    return promise
  }

  target.on('request', (request) => {
    const seq = sequenceForRequest(request)
    append({
      seq,
      type: 'request',
      at: new Date().toISOString(),
      ...requestRecord(request),
      classification: classifyProtocolRecord(requestRecord(request)),
    })
    const redirectedFrom = request.redirectedFrom?.()
    if (redirectedFrom) {
      append({
        seq,
        type: 'redirect',
        at: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        redirectedFromSeq: sequenceForRequest(redirectedFrom),
      })
    }
  })

  target.on('response', (response) => {
    const ordinal = nextEventOrdinal()
    const request = response.request()
    const promise = (async () => {
      const record = {
        seq: sequenceForRequest(request),
        type: 'response',
        at: new Date().toISOString(),
        method: request.method(),
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        responseBody: await responseBody(response),
      }
      append({
        ...record,
        classification: classifyProtocolRecord({ ...record, postData: request.postData() || '' }),
      }, ordinal)
    })()
    return track(promise)
  })

  target.on('requestfailed', (request) => {
    const record = {
      seq: sequenceForRequest(request),
      type: 'requestfailed',
      at: new Date().toISOString(),
      ...requestRecord(request),
      failure: request.failure?.()?.errorText || '',
    }
    append({ ...record, classification: classifyProtocolRecord(record) })
  })

  const attachPage = (page) => {
    if (!page || attachedPages.has(page)) return
    attachedPages.add(page)
    page.on('websocket', (socket) => {
      const seq = ++sequence
      socketSequences.set(socket, seq)
      append({
        seq,
        type: 'websocket-open',
        at: new Date().toISOString(),
        url: socket.url(),
        classification: classifyProtocolRecord({ type: 'websocket-open' }),
      })
      socket.on('framesent', (event) => append({
        seq: socketSequences.get(socket), type: 'websocket-send', at: new Date().toISOString(), payload: event.payload,
        classification: classifyProtocolRecord({ type: 'websocket-send' }),
      }))
      socket.on('framereceived', (event) => append({
        seq: socketSequences.get(socket), type: 'websocket-receive', at: new Date().toISOString(), payload: event.payload,
        classification: classifyProtocolRecord({ type: 'websocket-receive' }),
      }))
      socket.on('socketerror', (error) => append({
        seq: socketSequences.get(socket), type: 'websocket-error', at: new Date().toISOString(),
        error: String(error?.message || error || ''),
        classification: classifyProtocolRecord({ type: 'websocket-error' }),
      }))
      socket.on('close', () => append({
        seq: socketSequences.get(socket), type: 'websocket-close', at: new Date().toISOString(),
        classification: classifyProtocolRecord({ type: 'websocket-close' }),
      }))
    })
  }

  if (typeof target.pages === 'function') {
    for (const page of target.pages()) attachPage(page)
    target.on('page', attachPage)
  } else {
    attachPage(target)
  }

  return {
    sequenceForRequest,
    recordRouteDecision(request, decision) {
      const raw = requestRecord(request)
      const record = {
        seq: sequenceForRequest(request),
        type: 'route-decision',
        at: new Date().toISOString(),
        ...raw,
        ...decision,
      }
      append({ ...record, classification: decision.classification || classifyProtocolRecord(record) })
    },
    recordWebSocketRouteDecision(_socketRoute, decision) {
      const record = {
        seq: ++sequence,
        type: 'websocket-route-decision',
        at: new Date().toISOString(),
        method: 'WEBSOCKET',
        ...decision,
      }
      append({ ...record, classification: decision.classification || classifyProtocolRecord(record) })
    },
    recordMarker(type, fields = {}) {
      append({ seq: ++sequence, type, at: new Date().toISOString(), ...fields })
    },
    async flush() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}

async function installSubmitBlocker(target, controller, args) {
  let realSubmitCount = 0
  await target.route('**/*', async (route) => {
    const request = route.request()
    const raw = requestRecord(request)
    const decision = shouldBlockProtocolRequest(raw, { allowRealSubmit: args.allowRealSubmit })
    const classification = decision.classification
    const exactFtBet = raw.method === 'POST'
      && classification.reasons?.includes('exact p=FT_bet')
    let blockReason = exactFtBet && !args.allowRealSubmit
      ? 'real-submit-disabled'
      : (decision.block ? decision.reason : '')
    if (!blockReason && classification.stage === 'submit' && args.allowRealSubmit && !exactFtBet) {
      blockReason = 'real-submit-not-exact'
    }
    if (!blockReason && exactFtBet && args.allowRealSubmit) {
      const stake = boundedRealSubmitStake(raw.url, raw.headers, raw.postData)
      if (stake === null || stake > BigInt(args.maxStake)) blockReason = 'real-submit-stake-invalid'
      else if (realSubmitCount >= 1) blockReason = 'real-submit-limit-exceeded'
      else realSubmitCount += 1
    }

    const blocked = Boolean(blockReason) || (args.blockSubmit !== false && classification.stage === 'submit' && !args.allowRealSubmit)
    if (!blockReason && blocked) blockReason = 'real-submit-disabled'
    controller.recordRouteDecision(request, {
      decision: blocked ? 'blocked' : 'continued',
      ...(blockReason ? { blockReason } : {}),
      dispatchCount: blocked ? 0 : 1,
      classification,
    })
    if (blocked) await route.abort('blockedbyclient')
    else await route.continue()
  })
}

export async function installWebSocketSubmitBlocker(target, controller, args) {
  const blockMode = args.blockSubmit !== false
  if (typeof target.routeWebSocket !== 'function') {
    if (blockMode) throw new Error('websocket-route-unavailable')
    return
  }
  if (!blockMode) return

  await target.routeWebSocket('**/*', async (socketRoute) => {
    const url = socketRoute.url()
    const urlRecord = { method: 'GET', url, postData: '' }
    const urlClassification = classifyProtocolRecord(urlRecord)
    if (urlClassification.stage === 'submit') {
      controller.recordWebSocketRouteDecision(socketRoute, {
        url,
        source: 'url',
        decision: 'blocked',
        blockReason: 'real-submit-disabled',
        dispatchCount: 0,
        classification: urlClassification,
      })
      await socketRoute.close({ code: 1008, reason: 'blocked-submit' })
      return
    }

    const server = socketRoute.connectToServer()
    socketRoute.onMessage(async (message) => {
      const classification = classifyProtocolWebSocketFrame({ url, payload: message })
      const trusted = ['monitor', 'preview'].includes(classification.stage)
      const blocked = !trusted
      controller.recordWebSocketRouteDecision(socketRoute, {
        url,
        source: 'frame',
        payloadKind: typeof message === 'string' ? 'text' : 'binary',
        ...(typeof message === 'string' ? { postData: message } : {}),
        decision: blocked ? 'blocked' : 'continued',
        ...(blocked ? {
          blockReason: classification.stage === 'submit'
            ? 'real-submit-disabled'
            : 'websocket-frame-uninspectable',
        } : {}),
        dispatchCount: blocked ? 0 : 1,
        classification,
      })
      if (!blocked) server.send(message)
    })
  })
}

export async function installContextCapture(context, store, args, metadata = {}) {
  const controller = installRecorder(context, store, metadata)
  await installWebSocketSubmitBlocker(context, controller, args)
  await installSubmitBlocker(context, controller, args)
  return controller
}

export function captureContextOptions(args) {
  return {
    channel: args.channel,
    headless: args.headless,
    viewport: { width: 1440, height: 950 },
    serviceWorkers: 'block',
  }
}

export async function runSequentialCaptureContexts({
  manifest = EIGHT_DIRECTION_CAPTURE_MANIFEST,
  createContext,
  captureDirection,
} = {}) {
  if (typeof createContext !== 'function' || typeof captureDirection !== 'function') {
    throw new Error('capture-runner-callback-required')
  }
  const contexts = new Set()
  const outputRows = []
  for (const item of manifest) {
    const context = await createContext(item)
    if (!context || contexts.has(context)) throw new Error('capture-context-reused')
    contexts.add(context)
    let result
    try {
      result = await captureDirection({ context, item })
      if (result?.controller?.flush) await result.controller.flush()
      outputRows.push(result)
    } finally {
      await context.close()
      if (result?.controller?.flush) await result.controller.flush()
    }
  }
  return outputRows
}

function uniqueRunId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${stamp}-${prefix}-${randomUUID()}`
}

async function manualDiscoverFlow(page, rl, args) {
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  console.log('Manual flow: confirm login, navigate to a football event, then press Enter.')
  await rl.question('')
  console.log('Click the target odds and press Enter after the bet slip opens.')
  await rl.question('')
  console.log('Enter a bounded stake manually and press Enter after validation.')
  await rl.question('')
  if (args.allowRealSubmit) {
    console.log(`Real Submit is enabled for one exact FT_bet, maximum stake ${args.maxStake}. Press Enter afterward.`)
  } else {
    console.log('Submit remains route-blocked. Click Submit once so the route blocker records FT_bet, then close the slip and press Enter.')
  }
  await rl.question('')
}

async function runDiscover(args, rl, hmacKey) {
  const captureRunId = uniqueRunId('discover')
  const store = createProtocolStore({ rootDir: args.out, runId: captureRunId })
  const context = await chromium.launchPersistentContext(args.profile, captureContextOptions(args))
  const sessionGeneration = randomUUID()
  const controller = await installContextCapture(context, store, args, {
    captureRunId, direction: 'discover', sessionGeneration,
  })
  try {
    const page = context.pages()[0] || await context.newPage()
    await manualDiscoverFlow(page, rl, args)
    await controller.flush()
    store.writePrivateManifest({
      scenario: 'discover', captureRunId, sessionGeneration, url: args.url, profile: args.profile,
    })
    store.writeManifest({
      schemaVersion: 'crown-protocol-capture-manifest-v2',
      scenario: 'discover', submitPolicy: args.allowRealSubmit ? 'bounded-explicit' : 'block-at-route',
    })
  } finally {
    await controller.flush()
    await context.close()
    await controller.flush()
  }
  analyzeCrownProtocolCapture(store.runDir, { hmacKey })
  return store.runDir
}

export async function resolveMarketAvailability({ question, waitForMarket, switchMatch } = {}) {
  if (typeof question !== 'function') throw new Error('market-question-required')
  let attemptCount = 0
  let waited = false
  let switchedMatch = false
  let unavailableClaimed = false
  for (;;) {
    attemptCount += 1
    const answer = String((await question(
      'Press Enter if available; otherwise use MARKET_UNAVAILABLE, WAIT, SWITCH_MATCH, then CONFIRM_MARKET_UNAVAILABLE: ',
    )) ?? '').trim()
    if (!answer) return { status: 'available', attemptCount, waited, switchedMatch }
    if (answer === 'WAIT') {
      waited = true
      if (typeof waitForMarket === 'function') await waitForMarket()
      continue
    }
    if (answer === 'SWITCH_MATCH') {
      switchedMatch = true
      if (typeof switchMatch === 'function') await switchMatch()
      continue
    }
    if (answer === 'MARKET_UNAVAILABLE') {
      unavailableClaimed = true
      continue
    }
    if (answer === 'CONFIRM_MARKET_UNAVAILABLE') {
      if (unavailableClaimed && waited && switchedMatch && attemptCount >= 4) {
        return {
          status: 'market-unavailable', attemptCount, waited, switchedMatch,
          finalConfirmation: 'CONFIRM_MARKET_UNAVAILABLE',
        }
      }
      continue
    }
    throw new Error('market availability response is invalid')
  }
}

export function recordMarketAvailability(controller, availability) {
  if (availability.status !== 'market-unavailable') return false
  if (availability.finalConfirmation !== 'CONFIRM_MARKET_UNAVAILABLE') {
    throw new Error('market-unavailable-final-confirmation-required')
  }
  controller.recordMarker('market-unavailable', {
    marketConclusion: 'operator-confirmed',
    attemptCount: availability.attemptCount,
    waited: availability.waited,
    switchedMatch: availability.switchedMatch,
    finalConfirmation: availability.finalConfirmation,
  })
  return true
}

async function runEightDirection(args, rl, hmacKey) {
  const scenarioId = uniqueRunId('eight-direction')
  const scenarioDir = path.resolve(args.out, scenarioId)
  fs.mkdirSync(path.join(scenarioDir, 'public'), { recursive: true })
  const runs = await runSequentialCaptureContexts({
    manifest: EIGHT_DIRECTION_CAPTURE_MANIFEST,
    createContext: async () => chromium.launchPersistentContext(args.profile, captureContextOptions(args)),
    captureDirection: async ({ context, item }) => {
      const captureRunId = uniqueRunId(`${String(item.ordinal).padStart(2, '0')}-${item.direction.id}`)
      const sessionGeneration = randomUUID()
      const store = createProtocolStore({ rootDir: scenarioDir, runId: captureRunId })
      const controller = await installContextCapture(context, store, args, {
        captureRunId, direction: item.direction.id, sessionGeneration,
      })
      const page = context.pages()[0] || await context.newPage()
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      console.log(`[${item.ordinal}/8] ${item.direction.id}`)
      console.log('Select this exact open market, complete Preview, then attempt Submit so the route blocker records it.')
      console.log('If unavailable, recheck with WAIT, switch event with SWITCH_MATCH, then explicitly confirm.')
      const availability = await resolveMarketAvailability({
        question: (prompt) => rl.question(prompt),
        async waitForMarket() {
          console.log('Recheck current events; this tool does not infer availability from elapsed time or silence.')
        },
        async switchMatch() {
          console.log('Switch to a different matching event, then recheck this direction.')
        },
      })
      recordMarketAvailability(controller, availability)
      await controller.flush()
      store.writePrivateManifest({
        scenario: 'eight-direction', captureRunId, sessionGeneration,
        direction: item.direction.id, url: args.url, profile: args.profile,
      })
      store.writeManifest({
        schemaVersion: 'crown-protocol-capture-manifest-v2',
        scenario: 'eight-direction', ordinal: item.ordinal,
        direction: item.direction, submitPolicy: item.submitPolicy,
      })
      return { captureRunId, runDir: store.runDir, controller }
    },
  })
  analyzeCrownProtocolCaptureSet(scenarioDir, runs.map(({ runDir }) => runDir), { hmacKey })
  return scenarioDir
}

async function main() {
  const args = parseCaptureArgs(process.argv.slice(2))
  assertCaptureSafety(args)
  const hmacKey = readOrCreateLocalSecretKey()
  const rl = readline.createInterface({ input, output })
  try {
    const saved = args.scenario === 'eight-direction'
      ? await runEightDirection(args, rl, hmacKey)
      : await runDiscover(args, rl, hmacKey)
    console.log(`Saved capture: ${saved}`)
  } finally {
    rl.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const code = /^[a-z0-9-]+$/.test(String(error?.code || '')) ? error.code : 'failed'
    console.error(`crown-betting-protocol-capture:${code}`)
    process.exitCode = 1
  })
}
