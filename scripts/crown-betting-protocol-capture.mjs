#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'

import { createProtocolStore } from '../src/crown/betting-protocol/protocol-store.mjs'
import { parseBody } from '../src/crown/betting-protocol/capture-redaction.mjs'
import { classifyProtocolRecord, shouldBlockProtocolRequest } from '../src/crown/betting-protocol/protocol-classifier.mjs'

const DEFAULT_URL = 'https://m407.mos077.com'

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    profile: 'data/crown-profile',
    out: 'data/runtime/betting-protocol-captures',
    channel: process.env.CROWN_BROWSER_CHANNEL || 'msedge',
    headless: false,
    allowOddsClick: false,
    allowStakeFill: false,
    allowRealSubmit: false,
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
    else if (arg === '--headless') args.headless = true
    else if (arg === '--allow-odds-click') args.allowOddsClick = true
    else if (arg === '--allow-stake-fill') args.allowStakeFill = true
    else if (arg === '--allow-real-submit') args.allowRealSubmit = true
    else if (arg === '--max-stake') args.maxStake = Number(next() || 0)
    else if (arg === '--confirm') args.confirm = next()
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function assertSafety(args) {
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

export function installRecorder(page, store) {
  let sequence = 0
  const requestSequences = new WeakMap()

  page.on('request', (request) => {
    sequence += 1
    requestSequences.set(request, sequence)
    const record = {
      seq: sequence,
      type: 'request',
      at: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData() || '',
    }
    store.append({ ...record, classification: classifyProtocolRecord(record) })
  })

  page.on('response', async (response) => {
    const request = response.request()
    const record = {
      seq: requestSequences.get(request) ?? null,
      type: 'response',
      at: new Date().toISOString(),
      method: request.method(),
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
      responseBody: await responseBody(response),
    }
    store.append({ ...record, classification: classifyProtocolRecord({ ...record, postData: request.postData() || '' }) })
  })
}

async function installSubmitBlocker(target, store, args) {
  let realSubmitCount = 0
  await target.route('**/*', async (route) => {
    const request = route.request()
    const record = {
      type: 'request-blocked',
      at: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData() || '',
    }
    const body = parseBody(record.postData)
    const exactFtBet = record.method === 'POST' && typeof body?.p === 'string' && body.p === 'FT_bet'
    const decision = shouldBlockProtocolRequest(record, { allowRealSubmit: args.allowRealSubmit })
    const classification = exactFtBet
      ? { stage: 'submit', confidence: 'high', reasons: ['exact p=FT_bet'] }
      : decision.classification
    let blockReason = exactFtBet && !args.allowRealSubmit
      ? 'real-submit-disabled'
      : (decision.block ? decision.reason : '')
    if (!blockReason && classification.stage === 'submit' && args.allowRealSubmit && !exactFtBet) {
      blockReason = 'real-submit-not-exact'
    }
    if (!blockReason && exactFtBet && args.allowRealSubmit) {
      const rawStake = body.golds
      const stakeValid = typeof rawStake === 'string' && /^[1-9]\d*$/.test(rawStake)
      const stake = stakeValid ? BigInt(rawStake) : 0n
      if (!stakeValid || stake > BigInt(args.maxStake)) {
        blockReason = 'real-submit-stake-invalid'
      } else if (realSubmitCount >= 1) {
        blockReason = 'real-submit-limit-exceeded'
      } else {
        realSubmitCount += 1
      }
    }
    if (!blockReason) {
      await route.continue()
      return
    }

    store.append({
      ...record,
      blockReason,
      classification,
    })
    await route.abort('blockedbyclient')
  })
}

export async function installContextCapture(context, store, args) {
  await installSubmitBlocker(context, store, args)
  installRecorder(context, store)
}

export function captureContextOptions(args) {
  return {
    channel: args.channel,
    headless: args.headless,
    viewport: { width: 1440, height: 950 },
    serviceWorkers: 'block',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertSafety(args)

  const store = createProtocolStore({ rootDir: args.out })
  const context = await chromium.launchPersistentContext(args.profile, captureContextOptions(args))
  await installContextCapture(context, store, args)
  const page = context.pages()[0] || await context.newPage()

  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  const rl = readline.createInterface({ input, output })
  console.log(`Capture run: ${store.runDir}`)
  console.log('Manual flow:')
  console.log('1. Confirm login.')
  console.log('2. Navigate to the target football event.')
  console.log('3. Press Enter before odds click.')
  await rl.question('')
  console.log('4. Click the target odds in the visible browser.')
  console.log('5. Press Enter after bet slip opens.')
  await rl.question('')
  console.log('6. Enter a small stake manually. Do not submit unless --allow-real-submit is active.')
  console.log('7. Press Enter after stake validation finishes.')
  await rl.question('')
  if (args.allowRealSubmit) {
    console.log(`8. Real submit is enabled. Max stake configured: ${args.maxStake}. Submit once manually, then press Enter.`)
    await rl.question('')
  } else {
    console.log('8. Real submit is disabled. Close/cancel the bet slip, then press Enter.')
    await rl.question('')
  }

  store.writeManifest({
    generatedAt: new Date().toISOString(),
    url: args.url,
    profile: args.profile,
    allowOddsClick: args.allowOddsClick,
    allowStakeFill: args.allowStakeFill,
    allowRealSubmit: args.allowRealSubmit,
    maxStake: args.maxStake,
  })

  await context.close()
  rl.close()
  console.log(`Saved capture: ${store.runDir}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}
