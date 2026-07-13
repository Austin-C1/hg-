# Crown Betting Protocol Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抓取并还原皇冠真实下注协议，产出可用于后续 `CrownBetAdapter` 的字段映射、请求顺序、状态码语义和最小可验证执行路径。

**Architecture:** 先把项目边界从 read-only monitor 更新为受控 betting protocol lab，再新增独立抓包/分析工具。抓包工具允许在本机复用登录态、密钥和认证请求，但所有原始敏感材料只写入 gitignored runtime 目录；公开文档只保存字段名、请求形状、状态码和验证结论。真实提交必须由显式命令参数、金额上限和确认词共同解锁。

**Tech Stack:** Node.js ESM, Playwright persistent context, existing Crown login/session modules, JSONL capture files, local SQLite config, Node built-in test runner.

---

## Current Decision

用户在 2026-07-09 明确放宽边界：

- 允许写真实下单执行代码和对应功能。
- 允许脱敏采集边界放宽。
- 允许本机复用密钥、登录态和认证请求。

当前仓库文档已同步为受控投注协议实验室边界：监控路径仍只读，协议抓取和后续执行必须在独立模块中完成。

## Non-Negotiable Safety Rules

新版边界不是无限制执行。以下规则仍保留：

| 项目 | 规则 |
|---|---|
| CAPTCHA / 风控 | 不绕过 CAPTCHA、滑块、风控签名、设备校验、限速或账号保护 |
| 敏感信息 | 可本机保存和复用，但不得提交仓库、不得写入公开文档、不得在终端/最终回复明文展示 |
| 真实下注 | 只能通过显式 flag、金额上限、确认词和可见审计日志执行 |
| 自动触发 | 协议未稳定前，不能从监控信号自动触发真实下注 |
| 资金风险 | 第一轮真实提交只允许最小金额、单账号、单盘口、手动确认 |

## Target Flow

```text
选择目标比赛/盘口
-> 启动 protocol capture
-> 复用 Crown 登录态
-> 记录 baseline 网络请求
-> 点击赔率或手动点击赔率
-> 记录开单/预览请求
-> 填写小金额或手动填写小金额
-> 记录金额校验请求
-> 手动或受控提交真实订单
-> 记录提交请求和返回状态
-> 离线分析字段映射
-> 生成 Crown betting protocol map
```

## Output Files

| Path | Purpose |
|---|---|
| `docs/safety-boundary.md` | 更新新版受控下注边界 |
| `docs/betting-architecture.md` | 更新投注执行架构状态 |
| `docs/betting-contract.md` | 扩展 `BetIntent`，加入 execution payload 占位 |
| `src/betting/README.md` | 改为允许受控实现，不再写 documentation-only |
| `scripts/crown-betting-protocol-capture.mjs` | 新增真实页面协议抓取入口 |
| `scripts/crown-betting-protocol-analyze.mjs` | 新增离线协议分析入口 |
| `src/crown/betting-protocol/capture-redaction.mjs` | 生成公开摘要时做脱敏 |
| `src/crown/betting-protocol/protocol-classifier.mjs` | 按阶段和字段识别开单/预览/提交请求 |
| `src/crown/betting-protocol/protocol-store.mjs` | 保存 raw/private 和 redacted/public capture |
| `tests/crown-betting-protocol-redaction.test.mjs` | 验证公开输出不泄漏 secret |
| `tests/crown-betting-protocol-classifier.test.mjs` | 验证协议请求分类 |
| `data/runtime/betting-protocol-captures/<run>/private/` | 本机原始抓包，允许含 cookie/token/auth |
| `data/runtime/betting-protocol-captures/<run>/public/` | 可审查摘要，默认脱敏 |
| `docs/crown-betting-protocol-map.md` | 最终字段映射和执行结论，不含 secret |

---

### Task 1: Update Project Boundary Documents

**Files:**
- Modify: `docs/safety-boundary.md`
- Modify: `docs/betting-architecture.md`
- Modify: `docs/betting-contract.md`
- Modify: `src/betting/README.md`
- Modify: `README.md`

- [x] **Step 1: Replace read-only-only boundary with controlled betting lab boundary**

Update `docs/safety-boundary.md` to define three modes:

```markdown
# Safety Boundary

This project now supports a controlled Crown betting protocol lab.

## Modes

| Mode | Purpose | Real betting risk |
|---|---|---|
| `monitor` | Read odds, write snapshots, send alerts | none |
| `protocol-capture` | Reuse local login/session, click/open slip, capture order protocol | possible only when user manually opens or confirms betting UI |
| `execution` | Submit real Crown betting orders through a verified adapter | real funds at risk |

## Allowed

- Read local capture files.
- Open a logged-in Crown page with Playwright.
- Reuse locally stored Crown session, cookies, uid, authorization headers, and encrypted account secrets.
- Listen to page requests, responses, WebSocket frames, DOM, and browser storage.
- Save raw authenticated requests under `data/runtime/**/private/`.
- Generate redacted public summaries under `data/runtime/**/public/`.
- Click odds, open bet slips, fill stake amounts, and submit orders only in `protocol-capture` or `execution` mode with explicit command flags.
- Replay authenticated Crown requests only from dedicated betting protocol or adapter scripts.

## Forbidden

- Bypass CAPTCHA, slider checks, device checks, signatures, rate limits, or account protection.
- Print cookies, tokens, authorization headers, set-cookie values, passwords, or raw private capture bodies in reports.
- Commit private runtime capture directories, browser profiles, encrypted secrets, or session files.
- Run real betting execution from monitor alerts before the betting adapter has passed protocol verification.
- Submit a real order without an explicit stake cap and confirmation phrase.

## Runtime Storage

Raw protocol material may contain secrets and must stay under ignored local runtime paths:

- `data/runtime/betting-protocol-captures/**/private/`
- `data/runtime/crown-sessions/`
- `data/runtime/login-diagnostics/`

Public documentation may contain only endpoint patterns, field names, request shapes, response status meanings, and redacted examples.
```

- [x] **Step 2: Update betting architecture status**

Update `docs/betting-architecture.md` so it no longer says execution is not implemented forever. It should say:

```markdown
# Betting Architecture

Betting execution is now split into staged modules. The monitor remains read-only; betting code must live outside the monitor path.

| Module | Responsibility | Current Status |
|---|---|---|
| `bet-intent` | Create a structured intent from a strategy decision. | Contract |
| `risk-guard` | Validate limits, account exposure, market status, account status, and operator policy. | Required before execution |
| `crown-betting-protocol` | Capture and analyze Crown preview/submit protocol. | In progress |
| `bet-adapter` | Translate approved intent to a Crown provider operation. | After protocol map |
| `order-confirmation` | Reconcile accepted, rejected, pending, odds-changed, or insufficient-balance order state. | After adapter |
| `audit-log` | Persist all decisions, requests, responses, and outcomes. | Required |

## Required Separation

- `scripts/crown-watch.mjs` remains read-only and must not submit bets.
- Protocol capture and execution scripts must be separate entrypoints.
- Real order submission requires explicit CLI flags, configured stake limits, and audit logging.
```

- [x] **Step 3: Extend BetIntent contract**

Add this execution payload to `docs/betting-contract.md`:

```ts
type CrownExecutionPayload = {
  provider: 'crown';
  protocolVersion: string;
  sourceIds: {
    gid: string | null;
    gidm: string | null;
    hgid: string | null;
    ecid: string | null;
    lid: string | null;
  };
  marketFields: {
    ratioField: string | null;
    oddsField: string | null;
    handicapRaw: string | null;
    oddsRaw: string | null;
  };
  providerOrderFields: Record<string, string | number | boolean | null>;
};
```

Add this rule:

```markdown
`providerOrderFields` must stay empty until `docs/crown-betting-protocol-map.md` identifies the exact Crown fields needed for preview and submit.
```

- [x] **Step 4: Update `src/betting/README.md`**

Replace the old documentation-only language with:

```markdown
# Betting Module

This directory is reserved for controlled betting implementation.

Rules:

- Monitor code must not import betting execution modules.
- Betting execution must pass through `BetIntent`, `RiskGuard`, provider adapter, order confirmation, and audit log.
- Real Crown submission must require explicit runtime enablement and stake limits.
- Secrets may be read from local encrypted/runtime stores but must not be logged or committed.
```

- [x] **Step 5: Verify no docs still claim absolute prohibition**

Run:

```powershell
rg -n "forbids executable betting|No executable code may click|真实下注执行暂缓|preview-only|禁止.*下注|禁止.*订单|documentation-only" docs README.md src/betting
```

Expected:

- Any remaining matches are historical context or explicitly scoped to monitor mode.
- No current document claims all real betting code is forbidden.

---

### Task 2: Add Capture Storage and Redaction Utilities

**Files:**
- Create: `src/crown/betting-protocol/protocol-store.mjs`
- Create: `src/crown/betting-protocol/capture-redaction.mjs`
- Test: `tests/crown-betting-protocol-redaction.test.mjs`
- Modify: `.gitignore`

- [x] **Step 1: Update `.gitignore`**

Add:

```gitignore
data/runtime/betting-protocol-captures/
data/betting-protocol-captures/
```

- [x] **Step 2: Write redaction tests**

Create `tests/crown-betting-protocol-redaction.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  redactHeaders,
  redactBody,
  redactUrl,
} from '../src/crown/betting-protocol/capture-redaction.mjs'

test('redactHeaders masks auth material', () => {
  const result = redactHeaders({
    cookie: 'a=1; b=2',
    authorization: 'Bearer abc',
    'set-cookie': 'sid=secret',
    'content-type': 'application/json',
  })

  assert.equal(result.cookie, '[masked:8]')
  assert.equal(result.authorization, '[masked:10]')
  assert.equal(result['set-cookie'], '[masked:10]')
  assert.equal(result['content-type'], 'application/json')
})

test('redactBody masks nested secret keys but preserves request shape', () => {
  const result = redactBody({
    uid: 'real-uid',
    stake: 10,
    selection: { odds: '0.95', token: 'secret-token' },
  })

  assert.deepEqual(result, {
    uid: '[masked:8]',
    stake: 10,
    selection: { odds: '0.95', token: '[masked:12]' },
  })
})

test('redactUrl masks secret query values', () => {
  const result = redactUrl('https://example.test/order?uid=abc&gid=123&token=secret')
  assert.equal(result, 'https://example.test/order?uid=%5Bmasked%3A3%5D&gid=123&token=%5Bmasked%3A6%5D')
})
```

- [x] **Step 3: Implement redaction utility**

Create `src/crown/betting-protocol/capture-redaction.mjs`:

```js
const SECRET_KEY_RE = /(cookie|authorization|auth|token|session|secret|password|passwd|uid|csrf|xsrf|jwt|signature|sign|set-cookie)/i

function mask(value) {
  const text = String(value ?? '')
  return `[masked:${text.length}]`
}

export function redactScalar(key, value) {
  if (value == null) return value
  if (SECRET_KEY_RE.test(String(key))) return mask(value)
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...[truncated ${value.length - 500} chars]`
  return value
}

export function redactHeaders(headers = {}) {
  const output = {}
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = redactScalar(key, value)
  }
  return output
}

export function redactBody(value, parentKey = '') {
  if (value == null) return value
  if (Array.isArray(value)) return value.map((item) => redactBody(item, parentKey))
  if (typeof value === 'object') {
    const output = {}
    for (const [key, child] of Object.entries(value)) {
      output[key] = redactBody(child, key)
    }
    return output
  }
  return redactScalar(parentKey, value)
}

export function parseBody(postData) {
  if (!postData) return null
  const text = String(postData)
  try {
    return JSON.parse(text)
  } catch {
    try {
      const params = new URLSearchParams(text)
      const output = {}
      for (const [key, value] of params.entries()) output[key] = value
      return output
    } catch {
      return text
    }
  }
}

export function redactUrl(rawUrl) {
  const url = new URL(rawUrl)
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (SECRET_KEY_RE.test(key)) url.searchParams.set(key, mask(value))
  }
  return url.toString()
}
```

- [x] **Step 4: Implement protocol store**

Create `src/crown/betting-protocol/protocol-store.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'

import { parseBody, redactBody, redactHeaders, redactUrl } from './capture-redaction.mjs'

function pad(number) {
  return String(number).padStart(2, '0')
}

export function timestampForRun(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function createProtocolStore({ rootDir = 'data/runtime/betting-protocol-captures', runId = timestampForRun() } = {}) {
  const runDir = path.resolve(rootDir, runId)
  const privateDir = path.join(runDir, 'private')
  const publicDir = path.join(runDir, 'public')
  fs.mkdirSync(privateDir, { recursive: true })
  fs.mkdirSync(publicDir, { recursive: true })

  const privateNetwork = path.join(privateDir, 'raw-network.jsonl')
  const publicNetwork = path.join(publicDir, 'redacted-network.jsonl')

  function append(record) {
    fs.appendFileSync(privateNetwork, `${JSON.stringify(record)}\n`, 'utf8')
    const redacted = {
      ...record,
      url: record.url ? redactUrl(record.url) : record.url,
      headers: redactHeaders(record.headers || {}),
      postData: record.postData ? redactBody(parseBody(record.postData)) : undefined,
      responseBody: record.responseBody ? redactBody(parseBody(record.responseBody)) : undefined,
    }
    fs.appendFileSync(publicNetwork, `${JSON.stringify(redacted)}\n`, 'utf8')
  }

  function writeManifest(manifest) {
    fs.writeFileSync(path.join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  return {
    runDir,
    privateDir,
    publicDir,
    append,
    writeManifest,
  }
}
```

- [x] **Step 5: Verify redaction tests**

Run:

```powershell
node --test tests\crown-betting-protocol-redaction.test.mjs
```

Expected:

```text
# pass 3
# fail 0
```

---

### Task 3: Add Betting Protocol Classifier

**Files:**
- Create: `src/crown/betting-protocol/protocol-classifier.mjs`
- Test: `tests/crown-betting-protocol-classifier.test.mjs`

- [x] **Step 1: Write classifier tests**

Create `tests/crown-betting-protocol-classifier.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyProtocolRecord } from '../src/crown/betting-protocol/protocol-classifier.mjs'

test('classifies likely bet slip preview request', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/transform.php',
    postData: 'p=order_view&gid=123&uid=secret&ior=0.95&gold=10',
  })

  assert.equal(result.stage, 'preview')
  assert.equal(result.confidence, 'medium')
  assert.ok(result.reasons.includes('order-like post parameter'))
})

test('classifies likely submit request', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/bet.php',
    postData: 'action=submit&gid=123&stake=10&acceptBetterOdds=Y',
  })

  assert.equal(result.stage, 'submit')
  assert.ok(result.confidence === 'medium' || result.confidence === 'high')
})

test('ignores read-only game list odds polling', () => {
  const result = classifyProtocolRecord({
    type: 'request',
    method: 'POST',
    url: 'https://m407.mos077.com/transform.php',
    postData: 'p=get_game_list&gtype=ft&showtype=today',
  })

  assert.equal(result.stage, 'monitor')
  assert.equal(result.confidence, 'high')
})
```

- [x] **Step 2: Implement classifier**

Create `src/crown/betting-protocol/protocol-classifier.mjs`:

```js
import { parseBody } from './capture-redaction.mjs'

const MONITOR_RE = /(get_game_list|get_game_more|chk_login|get_member_data)/i
const ORDER_RE = /(bet|betslip|bet_slip|wager|order|ticket|coupon|gold|stake|ior|ratio|selection|odd)/i
const SUBMIT_RE = /(submit|confirm|buy|place|order_add|bet_add|wager_add|ticket_add)/i
const PREVIEW_RE = /(preview|view|open|prepare|check|verify|order_view|bet_view|bet_slip)/i

function flatten(value, prefix = '', output = []) {
  if (value == null) return output
  if (Array.isArray(value)) {
    output.push(`${prefix}[]`)
    value.slice(0, 10).forEach((item) => flatten(item, `${prefix}[]`, output))
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output)
    }
    return output
  }
  output.push(`${prefix}=${String(value).slice(0, 80)}`)
  return output
}

export function classifyProtocolRecord(record) {
  const method = String(record.method || '').toUpperCase()
  const url = String(record.url || '')
  const body = parseBody(record.postData || '')
  const bodyText = flatten(body).join('\n')
  const blob = `${method}\n${url}\n${bodyText}`
  const reasons = []

  if (MONITOR_RE.test(blob)) {
    return { stage: 'monitor', confidence: 'high', reasons: ['known read-only monitor endpoint'] }
  }

  if (method === 'POST' && SUBMIT_RE.test(blob) && ORDER_RE.test(blob)) {
    reasons.push('submit-like keyword')
    reasons.push('order-like post parameter')
    return { stage: 'submit', confidence: 'high', reasons }
  }

  if (method === 'POST' && PREVIEW_RE.test(blob) && ORDER_RE.test(blob)) {
    reasons.push('preview-like keyword')
    reasons.push('order-like post parameter')
    return { stage: 'preview', confidence: 'medium', reasons }
  }

  if (method === 'POST' && ORDER_RE.test(blob)) {
    reasons.push('order-like post parameter')
    return { stage: 'candidate', confidence: 'low', reasons }
  }

  return { stage: 'unknown', confidence: 'low', reasons: [] }
}
```

- [x] **Step 3: Verify classifier tests**

Run:

```powershell
node --test tests\crown-betting-protocol-classifier.test.mjs
```

Expected:

```text
# pass 3
# fail 0
```

---

### Task 4: Add Interactive Protocol Capture Script

**Files:**
- Create: `scripts/crown-betting-protocol-capture.mjs`
- Modify: `package.json`

- [x] **Step 1: Add package script**

Add to `package.json` scripts:

```json
"crown:betting:capture": "node scripts/crown-betting-protocol-capture.mjs"
```

- [x] **Step 2: Implement capture script**

Create `scripts/crown-betting-protocol-capture.mjs`:

```js
#!/usr/bin/env node
import { chromium } from 'playwright'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import { createProtocolStore } from '../src/crown/betting-protocol/protocol-store.mjs'
import { classifyProtocolRecord } from '../src/crown/betting-protocol/protocol-classifier.mjs'

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
    if (!Number.isFinite(args.maxStake) || args.maxStake <= 0) throw new Error('--allow-real-submit requires --max-stake > 0')
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

function installRecorder(page, store) {
  let sequence = 0

  page.on('request', (request) => {
    sequence += 1
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
      seq: sequence,
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertSafety(args)

  const store = createProtocolStore({ rootDir: args.out })
  const context = await chromium.launchPersistentContext(args.profile, {
    channel: args.channel,
    headless: args.headless,
    viewport: { width: 1440, height: 950 },
  })
  const page = context.pages()[0] || await context.newPage()
  installRecorder(page, store)

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

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
```

- [x] **Step 3: Verify script syntax**

Run:

```powershell
node --check scripts\crown-betting-protocol-capture.mjs
node --test tests\crown-betting-protocol-redaction.test.mjs tests\crown-betting-protocol-classifier.test.mjs
```

Expected:

- `node --check` exits 0.
- tests pass.

---

### Task 5: Add Protocol Analyzer

**Files:**
- Create: `scripts/crown-betting-protocol-analyze.mjs`
- Modify: `package.json`
- Create: `docs/crown-betting-protocol-map.md`

- [x] **Step 1: Add package script**

Add to `package.json` scripts:

```json
"crown:betting:analyze": "node scripts/crown-betting-protocol-analyze.mjs"
```

- [x] **Step 2: Implement analyzer**

Create `scripts/crown-betting-protocol-analyze.mjs`:

```js
#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function summarize(records) {
  const groups = new Map()
  for (const record of records) {
    const key = `${record.method || ''} ${new URL(record.url).origin}${new URL(record.url).pathname}`
    const group = groups.get(key) || {
      endpoint: key,
      count: 0,
      stages: new Map(),
      statuses: new Map(),
      samplePostData: null,
      sampleResponse: null,
    }
    group.count += 1
    const stage = record.classification?.stage || 'unknown'
    group.stages.set(stage, (group.stages.get(stage) || 0) + 1)
    if (record.status) group.statuses.set(record.status, (group.statuses.get(record.status) || 0) + 1)
    if (!group.samplePostData && record.postData) group.samplePostData = record.postData
    if (!group.sampleResponse && record.responseBody) group.sampleResponse = record.responseBody
    groups.set(key, group)
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      stages: Object.fromEntries(group.stages),
      statuses: Object.fromEntries(group.statuses),
    }))
    .sort((a, b) => b.count - a.count)
}

function markdown(summary, captureDir) {
  const lines = [
    '# Crown Betting Protocol Map',
    '',
    `Capture: \`${captureDir}\``,
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Endpoint Summary',
    '',
    '| Endpoint | Count | Stages | Statuses |',
    '|---|---:|---|---|',
  ]

  for (const item of summary) {
    lines.push(`| \`${item.endpoint}\` | ${item.count} | \`${JSON.stringify(item.stages)}\` | \`${JSON.stringify(item.statuses)}\` |`)
  }

  lines.push('')
  lines.push('## Field Mapping Checklist')
  lines.push('')
  lines.push('| Required Field | Evidence | Status |')
  lines.push('|---|---|---|')
  lines.push('| Event id used by submit | Capture request body / response body | unresolved |')
  lines.push('| Market type | Request field mapping to asian handicap / total | unresolved |')
  lines.push('| Selection side | Request field mapping to home/away/over/under | unresolved |')
  lines.push('| Odds field | Request field carrying current odds | unresolved |')
  lines.push('| Handicap field | Request field carrying line | unresolved |')
  lines.push('| Stake field | Request field carrying amount | unresolved |')
  lines.push('| Preview endpoint | Classified preview request | unresolved |')
  lines.push('| Submit endpoint | Classified submit request | unresolved |')
  lines.push('| Accepted status | Submit response evidence | unresolved |')
  lines.push('| Rejected status | Submit response evidence | unresolved |')
  lines.push('| Odds changed status | Submit/preview response evidence | unresolved |')
  lines.push('| Insufficient balance status | Submit response evidence | unresolved |')

  return `${lines.join('\n')}\n`
}

function main() {
  const captureDir = process.argv[2]
  if (!captureDir) throw new Error('Usage: node scripts/crown-betting-protocol-analyze.mjs <capture-dir>')

  const redactedNetwork = path.join(captureDir, 'public', 'redacted-network.jsonl')
  const records = readJsonl(redactedNetwork)
  const summary = summarize(records)

  const publicDir = path.join(captureDir, 'public')
  fs.writeFileSync(path.join(publicDir, 'protocol-summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  fs.writeFileSync(path.join(publicDir, 'protocol-map.md'), markdown(summary, captureDir), 'utf8')
  console.log(`Wrote ${path.join(publicDir, 'protocol-summary.json')}`)
  console.log(`Wrote ${path.join(publicDir, 'protocol-map.md')}`)
}

main()
```

- [x] **Step 3: Create initial protocol map document**

Create `docs/crown-betting-protocol-map.md`:

```markdown
# Crown Betting Protocol Map

Status: not captured yet.

This document records verified Crown betting protocol fields after `scripts/crown-betting-protocol-capture.mjs` and `scripts/crown-betting-protocol-analyze.mjs` produce evidence.

Rules:

- Do not paste cookies, tokens, authorization headers, uid values, passwords, or raw private request bodies here.
- Record endpoint patterns, field names, response status meanings, and evidence file paths only.
- Keep monitor XML ids separate from provider submit fields until proven equivalent.
```

- [x] **Step 4: Verify analyzer syntax**

Run:

```powershell
node --check scripts\crown-betting-protocol-analyze.mjs
```

Expected: exit 0.

---

### Task 6: Run First Non-Submit Capture

Current note: run `20260709-110033` was started as non-submit capture, but a real submit happened from the page. The run is useful protocol evidence, but Task 6 should be repeated after the network-level submit blocker fix to verify non-submit mode actually blocks `FT_bet`.

Completion note: repeated as run `20260709-111046`. The page-side submit attempt was blocked by the local network route in `allowRealSubmit=false` mode; no submit response and no status polling were captured for that run.

Additional layout note: run `20260709-112647` captured the event list / broad market page. It used the same `FT_order_view` and `FT_bet` key set as the detail-page sample, with market values for a live first-half total selection; the submit attempt was blocked in non-submit mode.

**Files:**
- Output: `data/runtime/betting-protocol-captures/<run>/private/raw-network.jsonl`
- Output: `data/runtime/betting-protocol-captures/<run>/public/redacted-network.jsonl`
- Output: `data/runtime/betting-protocol-captures/<run>/public/protocol-map.md`

- [x] **Step 1: Start capture without real submit**

Run:

```powershell
npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile
```

Manual actions:

1. Confirm Crown login is active.
2. Navigate to football target page.
3. Pick one low-risk match.
4. Click one Asian handicap odds.
5. Let the bet slip open.
6. Enter a small stake only if the page needs stake to trigger preview validation.
7. Do not submit.
8. Cancel/close the bet slip.

- [x] **Step 2: Analyze capture**

Run:

```powershell
npm run crown:betting:analyze -- data\runtime\betting-protocol-captures\<run>
```

Expected:

- `public/protocol-summary.json` exists.
- `public/protocol-map.md` exists.
- At least one candidate or preview-stage endpoint is identified.

- [x] **Step 3: Update protocol map**

Copy only non-secret conclusions from `public/protocol-map.md` into `docs/crown-betting-protocol-map.md`:

```markdown
## Capture 1: Non-submit preview

| Item | Result |
|---|---|
| Capture dir | `data/runtime/betting-protocol-captures/<run>/public/` |
| Market | asian handicap |
| Submit performed | no |
| Preview endpoint | ... |
| Required fields observed | ... |
| Missing fields | ... |
```

---

### Task 7: Run Controlled Real Submit Capture

Current note: run `20260709-110033` contains one real submit, but it was not started with `--allow-real-submit --max-stake 50 --confirm REAL_BET`. Do not mark controlled real-submit capture complete from that run.

**Files:**
- Output: same capture directory shape as Task 6.
- Modify: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: Confirm prerequisites**

Do not run this task until Task 6 has identified the preview/open-slip sequence.

Checklist:

```text
[ ] Account is intended for testing.
[ ] Stake amount is acceptable.
[ ] Market is known and visible.
[ ] User is present.
[ ] Browser is visible.
[ ] Capturer is running.
[ ] max stake <= 50.
```

- [ ] **Step 2: Start real-submit capture**

Run:

```powershell
npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile --allow-real-submit --max-stake 50 --confirm REAL_BET
```

Manual actions:

1. Navigate to the chosen match.
2. Click the chosen odds.
3. Enter stake at or below the configured max stake.
4. Submit exactly once.
5. Wait for accepted/rejected/pending result.
6. Press Enter in the terminal so the capture closes.

- [ ] **Step 3: Analyze submit capture**

Run:

```powershell
npm run crown:betting:analyze -- data\runtime\betting-protocol-captures\<run>
```

Expected:

- A submit-stage endpoint is identified.
- Response body shows one of: accepted, rejected, pending, odds changed, insufficient balance, max stake, suspended market.
- `docs/crown-betting-protocol-map.md` can be updated without secret values.

---

### Task 8: Decide Adapter Direction

**Files:**
- Modify: `docs/crown-betting-protocol-map.md`
- Future modify: `src/betting/`

- [ ] **Step 1: Choose one implementation direction**

| 方案 | 内容 | 优点 | 缺点 | 推荐 |
|---|---|---|---|---|
| API-first | 用已确认 preview/submit endpoint 直接提交 | 速度快、状态清楚、接近 PBBall 成熟方案 | 要求字段和签名完全确认 | 推荐 |
| UI-first | 只用 Playwright 点击和读结果 | 实现快、依赖接口少 | 慢、脆弱、状态难判断 | 不推荐作为主路径 |
| Hybrid | API-first，UI 只用于捕获和 fallback | 稳定性和可诊断性平衡 | 初期代码更多 | 推荐当前采用 |

推荐：Hybrid。原因是 PBBall 的验证结果说明 API-first 更稳定，但皇冠协议还没完全确认，UI 保留为抓取和异常诊断更稳。

- [ ] **Step 2: Define adapter readiness**

Only start `CrownBetAdapter` after these fields are resolved:

```text
[ ] Preview endpoint
[ ] Submit endpoint
[ ] Required session/auth fields
[ ] Event id field
[ ] Market/period field
[ ] Selection side field
[ ] Handicap/line field
[ ] Odds field
[ ] Stake field
[ ] Odds-changed response
[ ] Accepted response
[ ] Pending response
[ ] Rejected response
[ ] Insufficient-balance response
```

---

## Verification Commands

Run after implementing Tasks 1-5:

```powershell
node --check scripts\crown-betting-protocol-capture.mjs
node --check scripts\crown-betting-protocol-analyze.mjs
node --test tests\crown-betting-protocol-redaction.test.mjs tests\crown-betting-protocol-classifier.test.mjs
npm run check
```

Expected:

- Syntax checks pass.
- Protocol utility tests pass.
- Existing project check passes.

## Completion Criteria

The protocol capture phase is complete when:

| 项目 | 标准 |
|---|---|
| 非提交抓包 | 至少抓到一次开单/预览请求 |
| 真实提交抓包 | 至少一次小金额真实提交，拿到明确返回状态 |
| 字段映射 | `docs/crown-betting-protocol-map.md` 写清 preview/submit 必需字段 |
| 敏感信息 | 公开文档和 final response 不含 cookie/token/auth/password/raw uid |
| 后续入口 | 可以开始设计 `CrownBetAdapter`，且不再混入 read-only watcher |
