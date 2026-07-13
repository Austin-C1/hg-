# Crown Bet Adapter Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a controlled `CrownBetAdapter` path that can map supported Crown football markets, run preview requests, apply betting rules, audit every decision, and submit a real order only through explicit operator-controlled execution.

**Architecture:** Keep `scripts/crown-watch.mjs` read-only. Put generic betting contracts and risk checks in `src/betting/`, and Crown-specific protocol code in `src/crown/betting/`. The first usable milestone is dry-run preview plus audit; real submit is gated behind CLI flags, stake caps, confirmation text, and response reconciliation.

**Tech Stack:** Node.js ESM, Node built-in test runner, existing Crown API session classes, `fetch`, `URLSearchParams`, XML text parsing helpers, local JSONL audit, existing SQLite app repository for dashboard history summaries.

---

## Approach Decision

| 项目 | 内容 |
|---|---|
| 方案 A | API-first, dry-run preview first, then gated real submit |
| 优点 | Uses verified `FT_order_view` / `FT_bet`; easiest to test with fake fetch; keeps real money risk controlled |
| 缺点 | Requires careful mapping from normalized odds fields to Crown order fields |
| 推荐 | Yes |
| 原因 | Current captures already prove the endpoint shape and blocker behavior. The missing work is deterministic mapping, risk control, and reconciliation. |
| 方案 B | Build full real submit immediately |
| 优点 | Fastest route to an end-to-end real ticket |
| 缺点 | Higher money risk; weaker test surface before response handling is complete |
| 推荐 | No |
| 原因 | Rejected/odds-changed/insufficient-balance responses are still not captured, so this is too risky as the next step. |
| 方案 C | UI-first Playwright execution |
| 优点 | Uses the visible page and avoids some direct request-field assumptions |
| 缺点 | Slower, brittle, harder to reconcile exact order state, still needs request/response parsing |
| 推荐 | No |
| 原因 | UI remains useful for capture and diagnostics, but the execution path should be API-first for auditability. |

## Current Evidence

- Detail page live asian handicap:
  - `data/runtime/betting-protocol-captures/20260709-111046/public/`
  - preview: `POST /transform.php`, `p=FT_order_view`
  - blocked submit: `POST /transform.php`, `p=FT_bet`
  - observed market values: `wtype=RE`, `rtype=REH`, `chose_team=H`
- Event-list page live total first half:
  - `data/runtime/betting-protocol-captures/20260709-112647/public/`
  - same preview and submit key set
  - observed market values: `wtype=ROU`, `rtype=ROUC`, `chose_team=C`, `f=1R`
- One historical accidental submit:
  - `data/runtime/betting-protocol-captures/20260709-110033/public/`
  - proves `status_N` pending and `status_A` accepted polling semantics
  - must not be treated as controlled real-submit verification

## Scope

Included:

- Manual and rule-approved `BetIntent` validation.
- Mapping for captured Crown football market variants only.
- Preview/open-slip request using `FT_order_view`.
- Dry-run execution result with limits, current line, current odds, and audit log.
- Risk guard for stake, odds range, event limit, daily limit, account status, and `previewOnly`.
- Gated real submit path with `FT_bet`, `get_dangerous` polling, and `get_today_wagers` verification.
- CLI entrypoint for local controlled execution.
- Dashboard betting history summary writes after dry-run and real execution attempts.

Excluded:

- No automatic real submit from watcher alerts.
- No CAPTCHA, slider, device-check, signature, rate-limit, or account-protection bypass.
- No unsupported markets such as moneyline, corners, cards, team totals, or next-goal until separately captured.
- No raw cookie, token, uid value, ticket id, or password in source files, docs, final reports, or public audit files.

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/betting/bet-intent.mjs` | Create | Validate and normalize `BetIntent` and `CrownExecutionPayload` input. |
| `src/betting/risk-guard.mjs` | Create | Reject unsafe bets before any provider submit request is built. |
| `src/betting/audit-log.mjs` | Create | Append redacted local execution audit JSONL rows. |
| `src/crown/betting/crown-order-field-mapper.mjs` | Create | Convert supported normalized Crown odds records into `FT_order_view` and `FT_bet` provider fields. |
| `src/crown/betting/crown-bet-response-parser.mjs` | Create | Parse preview XML, submit XML, status XML, and today-wagers JSON into typed outcomes. |
| `src/crown/betting/crown-bet-adapter.mjs` | Create | Orchestrate session, preview, risk, optional submit, polling, audit, and final result. |
| `scripts/crown-bet-execute.mjs` | Create | Controlled CLI entrypoint for dry-run preview and explicit real submit. |
| `src/crown/app/app-repository.mjs` | Modify | Add `createBettingHistory()` for dry-run and execution summary rows. |
| `src/crown/app/app-validation.mjs` | Modify | Add betting-history payload normalization. |
| `tests/crown-bet-response-parser.test.mjs` | Create | Unit-test Crown XML/JSON response semantics. |
| `tests/crown-order-field-mapper.test.mjs` | Create | Unit-test captured market mappings and unsupported-market rejection. |
| `tests/betting-risk-guard.test.mjs` | Create | Unit-test rule/account/stake/odds guard behavior. |
| `tests/crown-bet-adapter.test.mjs` | Create | Unit-test preview, blocked real submit, accepted submit, and audit redaction with fake fetch. |
| `tests/crown-app-repository.test.mjs` | Modify | Cover `createBettingHistory()`. |
| `docs/crown-betting-protocol-map.md` | Modify | Record adapter readiness and new controlled-submit evidence after live verification. |
| `docs/modules/crown-betting-protocol.md` | Modify | Link this plan and record adapter status. |

Commit checkpoints are intentionally omitted from this plan because this workspace is currently not a git repository. If a git repository is initialized later, commit after each task passes its verification command.

---

### Task 1: Parse Crown Betting Responses

**Files:**
- Create: `src/crown/betting/crown-bet-response-parser.mjs`
- Test: `tests/crown-bet-response-parser.test.mjs`

- [ ] **Step 1: Write parser tests**

Create `tests/crown-bet-response-parser.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCrownPreviewResponse,
  parseCrownSubmitResponse,
  parseCrownDangerousStatus,
} from '../src/crown/betting/crown-bet-response-parser.mjs'

test('parses preview limits and current line', () => {
  const xml = '<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>4 / 4.5</spread><strong>C</strong></serverresponse>'
  assert.deepEqual(parseCrownPreviewResponse(xml), {
    ok: true,
    code: '560',
    minStake: 10,
    maxStake: 500,
    oddsRaw: '0.75',
    spread: '4 / 4.5',
    strong: 'C',
    message: '',
  })
})

test('parses submit response without exposing ticket id', () => {
  const xml = '<serverresponse><code>560</code><ticket_id>123456789</ticket_id><gid>8878931</gid><gtype>FT</gtype><wtype>ROU</wtype><rtype>ROUC</rtype><ioratio>0.75</ioratio><gold>50</gold><spread>4 / 4.5</spread></serverresponse>'
  const result = parseCrownSubmitResponse(xml)
  assert.equal(result.ok, true)
  assert.equal(result.ticketRef, '[ticket:9]')
  assert.equal(JSON.stringify(result).includes('123456789'), false)
  assert.equal(result.market.wtype, 'ROU')
})

test('parses pending and accepted polling status', () => {
  const pending = '<serverrequest><status><status_N><ticket id=\"123\">N</ticket></status_N><status_A></status_A></status></serverrequest>'
  const accepted = '<serverrequest><status><status_N></status_N><status_A><ticket id=\"123\">A</ticket></status_A></status></serverrequest>'
  assert.equal(parseCrownDangerousStatus(pending).status, 'pending')
  assert.equal(parseCrownDangerousStatus(accepted).status, 'accepted')
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
node --test tests\crown-bet-response-parser.test.mjs
```

Expected: fails with module-not-found or missing export errors.

- [ ] **Step 3: Implement minimal parser**

Create `src/crown/betting/crown-bet-response-parser.mjs` with:

```js
function tag(text, name) {
  const match = String(text || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

function numberOrNull(value) {
  const number = Number(String(value || '').trim())
  return Number.isFinite(number) ? number : null
}

function ticketRef(value) {
  const text = String(value || '')
  return text ? `[ticket:${text.length}]` : ''
}

export function parseCrownPreviewResponse(xml) {
  const code = tag(xml, 'code')
  return {
    ok: Boolean(code),
    code,
    minStake: numberOrNull(tag(xml, 'gold_gmin')),
    maxStake: numberOrNull(tag(xml, 'gold_gmax')),
    oddsRaw: tag(xml, 'ioratio'),
    spread: tag(xml, 'spread'),
    strong: tag(xml, 'strong'),
    message: tag(xml, 'message') || tag(xml, 'code_message'),
  }
}

export function parseCrownSubmitResponse(xml) {
  const rawTicket = tag(xml, 'ticket_id')
  return {
    ok: Boolean(tag(xml, 'code') && rawTicket),
    code: tag(xml, 'code'),
    ticketRef: ticketRef(rawTicket),
    ticketSecret: rawTicket,
    market: {
      gid: tag(xml, 'gid'),
      gtype: tag(xml, 'gtype'),
      wtype: tag(xml, 'wtype'),
      rtype: tag(xml, 'rtype'),
    },
    oddsRaw: tag(xml, 'ioratio'),
    stake: numberOrNull(tag(xml, 'gold')),
    spread: tag(xml, 'spread'),
    message: tag(xml, 'message') || tag(xml, 'code_message'),
  }
}

export function parseCrownDangerousStatus(xml) {
  const text = String(xml || '')
  if (/<status_A>[\s\S]*?<ticket\b/i.test(text)) return { status: 'accepted', ticketRef: ticketRef(text.match(/<ticket\b[^>]*\bid=['"]?([^'">]+)/i)?.[1] || '') }
  if (/<status_N>[\s\S]*?<ticket\b/i.test(text)) return { status: 'pending', ticketRef: ticketRef(text.match(/<ticket\b[^>]*\bid=['"]?([^'">]+)/i)?.[1] || '') }
  if (/<status_R>[\s\S]*?<ticket\b/i.test(text)) return { status: 'rejected', ticketRef: ticketRef(text.match(/<ticket\b[^>]*\bid=['"]?([^'">]+)/i)?.[1] || '') }
  return { status: 'unknown', ticketRef: '' }
}
```

- [ ] **Step 4: Verify parser tests pass**

Run:

```powershell
node --test tests\crown-bet-response-parser.test.mjs
```

Expected: all tests pass.

### Task 2: Build Generic BetIntent Validation

**Files:**
- Create: `src/betting/bet-intent.mjs`
- Test: `tests/betting-bet-intent.test.mjs`

- [ ] **Step 1: Write intent validation tests**

Create `tests/betting-bet-intent.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeBetIntent } from '../src/betting/bet-intent.mjs'

test('normalizes a supported Crown football intent', () => {
  const intent = normalizeBetIntent({
    provider: 'crown',
    sport: 'football',
    event: { eventId: '8878931', league: 'US league', homeTeam: 'A', awayTeam: 'B' },
    market: { marketType: 'total', period: 'first_half', handicapRaw: '4 / 4.5' },
    selection: { side: 'under', oddsRaw: '0.75', odds: 0.75 },
    decision: { reason: 'manual-test', confidence: 'high', maxStakeHint: 50 },
    source: { endpointKey: 'POST /transform.php p=get_game_list', snapshotFile: 'data/runtime/crown-odds-snapshots.jsonl', changeFile: null },
  })
  assert.equal(intent.provider, 'crown')
  assert.equal(intent.intentId.startsWith('intent_'), true)
  assert.equal(intent.execution, undefined)
})

test('rejects unsupported provider and missing stake hint', () => {
  assert.throws(() => normalizeBetIntent({ provider: 'other' }), /unsupported-provider/)
  assert.throws(() => normalizeBetIntent({ provider: 'crown', sport: 'football', decision: {} }), /missing-max-stake-hint/)
})
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
node --test tests\betting-bet-intent.test.mjs
```

Expected: fails with missing module/export.

- [ ] **Step 3: Implement minimal intent normalizer**

Create `src/betting/bet-intent.mjs` with:

```js
import crypto from 'node:crypto'

function required(value, code) {
  if (value === undefined || value === null || value === '') throw new Error(code)
  return value
}

export function normalizeBetIntent(input = {}) {
  if (input.provider !== 'crown') throw new Error('unsupported-provider')
  if (input.sport !== 'football') throw new Error('unsupported-sport')
  required(input.decision?.maxStakeHint, 'missing-max-stake-hint')
  return {
    intentId: input.intentId || `intent_${crypto.randomUUID()}`,
    createdAt: input.createdAt || new Date().toISOString(),
    provider: 'crown',
    sport: 'football',
    event: {
      eventId: String(required(input.event?.eventId, 'missing-event-id')),
      league: String(input.event?.league || ''),
      homeTeam: String(input.event?.homeTeam || ''),
      awayTeam: String(input.event?.awayTeam || ''),
    },
    market: {
      marketId: String(input.market?.marketId || ''),
      marketType: input.market?.marketType || 'unknown',
      period: input.market?.period || 'unknown',
      handicapRaw: input.market?.handicapRaw ?? null,
    },
    selection: {
      selectionId: String(input.selection?.selectionId || ''),
      side: input.selection?.side || 'unknown',
      oddsRaw: String(required(input.selection?.oddsRaw, 'missing-odds')),
      odds: Number.isFinite(Number(input.selection?.odds)) ? Number(input.selection.odds) : null,
    },
    decision: {
      reason: String(input.decision?.reason || ''),
      confidence: input.decision?.confidence || 'low',
      maxStakeHint: Number(input.decision.maxStakeHint),
    },
    source: {
      snapshotFile: String(input.source?.snapshotFile || ''),
      changeFile: input.source?.changeFile || null,
      endpointKey: String(input.source?.endpointKey || ''),
    },
    execution: input.execution,
  }
}
```

- [ ] **Step 4: Verify intent tests pass**

Run:

```powershell
node --test tests\betting-bet-intent.test.mjs
```

Expected: all tests pass.

### Task 3: Map Supported Crown Order Fields

**Files:**
- Create: `src/crown/betting/crown-order-field-mapper.mjs`
- Test: `tests/crown-order-field-mapper.test.mjs`

- [ ] **Step 1: Write mapper tests for captured variants**

Create `tests/crown-order-field-mapper.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCrownOrderFields } from '../src/crown/betting/crown-order-field-mapper.mjs'

test('maps live asian handicap home selection to Crown fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8878933' } },
    market: { marketType: 'asian_handicap', period: 'full_time', ratioField: 'RATIO_RE', handicapRaw: '-0 / 0.5' },
    selection: { side: 'home', oddsField: 'IOR_REH', oddsRaw: '1.09' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'RE')
  assert.equal(fields.preview.chose_team, 'H')
  assert.equal(fields.submit.rtype, 'REH')
  assert.equal(fields.submit.golds, '50')
})

test('maps live first-half total under selection to Crown fields', () => {
  const fields = buildCrownOrderFields({
    event: { ids: { gid: '8878931' } },
    market: { marketType: 'total', period: 'first_half', ratioField: 'RATIO_HROUO', handicapRaw: '4 / 4.5' },
    selection: { side: 'under', oddsField: 'IOR_HROUH', oddsRaw: '0.75' },
    stake: 50,
  })
  assert.equal(fields.preview.wtype, 'ROU')
  assert.equal(fields.preview.chose_team, 'C')
  assert.equal(fields.submit.rtype, 'ROUC')
  assert.equal(fields.submit.f, '1R')
})

test('rejects unsupported markets before request construction', () => {
  assert.throws(() => buildCrownOrderFields({
    event: { ids: { gid: '1' } },
    market: { marketType: 'moneyline', period: 'full_time' },
    selection: { side: 'home', oddsRaw: '1.2' },
    stake: 10,
  }), /unsupported-crown-market/)
})
```

- [ ] **Step 2: Run mapper tests and confirm failure**

Run:

```powershell
node --test tests\crown-order-field-mapper.test.mjs
```

Expected: fails with missing module/export.

- [ ] **Step 3: Implement captured-market mapper**

Create `src/crown/betting/crown-order-field-mapper.mjs`:

```js
function required(value, code) {
  if (value === undefined || value === null || value === '') throw new Error(code)
  return String(value)
}

function selectionCode(record) {
  const marketType = record.market?.marketType
  const side = record.selection?.side
  if (marketType === 'asian_handicap' && side === 'home') return { choseTeam: 'H', rtypeSuffix: 'H' }
  if (marketType === 'asian_handicap' && side === 'away') return { choseTeam: 'C', rtypeSuffix: 'C' }
  if (marketType === 'total' && side === 'over') return { choseTeam: 'H', rtypeSuffix: 'H' }
  if (marketType === 'total' && side === 'under') return { choseTeam: 'C', rtypeSuffix: 'C' }
  throw new Error('unsupported-crown-selection')
}

function marketCode(record) {
  if (record.market?.marketType === 'asian_handicap' && record.market?.period === 'full_time') return { wtype: 'RE', rtypePrefix: 'RE', f: '' }
  if (record.market?.marketType === 'total' && record.market?.period === 'first_half') return { wtype: 'ROU', rtypePrefix: 'ROU', f: '1R' }
  throw new Error('unsupported-crown-market')
}

export function buildCrownOrderFields(record = {}) {
  const market = marketCode(record)
  const selection = selectionCode(record)
  const gid = required(record.event?.ids?.gid || record.event?.eventId, 'missing-crown-gid')
  const stake = Number(record.stake)
  if (!Number.isFinite(stake) || stake <= 0) throw new Error('invalid-stake')
  const base = {
    gid,
    gtype: 'FT',
    wtype: market.wtype,
    chose_team: selection.choseTeam,
  }
  return {
    preview: base,
    submit: {
      ...base,
      golds: String(stake),
      rtype: `${market.rtypePrefix}${selection.rtypeSuffix}`,
      ioratio: required(record.selection?.oddsRaw, 'missing-odds'),
      con: required(record.market?.handicapRaw, 'missing-handicap'),
      ratio: '-50',
      autoOdd: 'Y',
      timestamp: '',
      timestamp2: '',
      isRB: 'Y',
      imp: 'N',
      ptype: '',
      isYesterday: 'N',
      f: market.f,
    },
  }
}
```

- [ ] **Step 4: Verify mapper tests pass**

Run:

```powershell
node --test tests\crown-order-field-mapper.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Review mapper before real submit**

Check `ratio` and `con` behavior against a new non-submit capture before enabling real execution. If the current captured submit uses a different `ratio` rule for another market, update the mapper and add a fixture test before any live submit.

### Task 4: Add Risk Guard

**Files:**
- Create: `src/betting/risk-guard.mjs`
- Test: `tests/betting-risk-guard.test.mjs`

- [ ] **Step 1: Write risk guard tests**

Create `tests/betting-risk-guard.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateRisk } from '../src/betting/risk-guard.mjs'

const intent = { event: { eventId: '8878931' }, selection: { odds: 0.75 }, decision: { maxStakeHint: 50 } }
const account = { id: 'bet_1', status: 'enabled', dailyLimit: 500 }
const rule = { enabled: true, previewOnly: true, minOdds: 0.5, maxOdds: 2, maxSingleAmount: 50, maxEventAmount: 100, stopLossAmount: 200 }

test('allows dry-run preview inside limits', () => {
  assert.equal(evaluateRisk({ intent, account, rule, stake: 50, mode: 'dry-run' }).ok, true)
})

test('blocks real submit when rule is preview only', () => {
  const result = evaluateRisk({ intent, account, rule, stake: 50, mode: 'real' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'rule-preview-only')
})

test('blocks stake above single limit and odds outside range', () => {
  assert.equal(evaluateRisk({ intent, account, rule: { ...rule, previewOnly: false }, stake: 51, mode: 'real' }).reason, 'stake-over-single-limit')
  assert.equal(evaluateRisk({ intent: { ...intent, selection: { odds: 2.5 } }, account, rule, stake: 10, mode: 'dry-run' }).reason, 'odds-out-of-range')
})
```

- [ ] **Step 2: Run guard tests and confirm failure**

Run:

```powershell
node --test tests\betting-risk-guard.test.mjs
```

Expected: fails with missing module/export.

- [ ] **Step 3: Implement guard**

Create `src/betting/risk-guard.mjs`:

```js
export function evaluateRisk({ intent = {}, account = {}, rule = {}, stake, mode = 'dry-run' } = {}) {
  const amount = Number(stake)
  const odds = Number(intent.selection?.odds)
  if (account.status !== 'enabled') return { ok: false, reason: 'account-disabled' }
  if (!rule.enabled) return { ok: false, reason: 'rule-disabled' }
  if (mode === 'real' && rule.previewOnly) return { ok: false, reason: 'rule-preview-only' }
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid-stake' }
  if (Number(rule.maxSingleAmount) > 0 && amount > Number(rule.maxSingleAmount)) return { ok: false, reason: 'stake-over-single-limit' }
  if (Number(intent.decision?.maxStakeHint) > 0 && amount > Number(intent.decision.maxStakeHint)) return { ok: false, reason: 'stake-over-intent-limit' }
  if (Number(account.dailyLimit) > 0 && amount > Number(account.dailyLimit)) return { ok: false, reason: 'stake-over-account-daily-limit' }
  if (Number.isFinite(odds) && Number(rule.minOdds) > 0 && odds < Number(rule.minOdds)) return { ok: false, reason: 'odds-out-of-range' }
  if (Number.isFinite(odds) && Number(rule.maxOdds) > 0 && odds > Number(rule.maxOdds)) return { ok: false, reason: 'odds-out-of-range' }
  return { ok: true, reason: 'accepted' }
}
```

- [ ] **Step 4: Verify guard tests pass**

Run:

```powershell
node --test tests\betting-risk-guard.test.mjs
```

Expected: all tests pass.

### Task 5: Add Redacted Audit Log

**Files:**
- Create: `src/betting/audit-log.mjs`
- Test: `tests/betting-audit-log.test.mjs`

- [ ] **Step 1: Write audit tests**

Create `tests/betting-audit-log.test.mjs`:

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { appendBetAudit } from '../src/betting/audit-log.mjs'

test('writes redacted audit row without raw ticket or uid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-audit-'))
  const file = path.join(dir, 'audit.jsonl')
  appendBetAudit(file, {
    action: 'submit',
    uid: 'secret-uid',
    ticket_id: '123456789',
    result: { status: 'accepted', ticketSecret: '123456789', ticketRef: '[ticket:9]' },
  })
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.includes('secret-uid'), false)
  assert.equal(text.includes('123456789'), false)
  assert.equal(text.includes('[ticket:9]'), true)
})
```

- [ ] **Step 2: Run audit tests and confirm failure**

Run:

```powershell
node --test tests\betting-audit-log.test.mjs
```

Expected: fails with missing module/export.

- [ ] **Step 3: Implement audit writer**

Create `src/betting/audit-log.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'

import { redactBody } from '../crown/betting-protocol/capture-redaction.mjs'

function omitPrivate(value) {
  if (Array.isArray(value)) return value.map(omitPrivate)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ticketSecret') continue
      out[key] = omitPrivate(child)
    }
    return out
  }
  return value
}

export function appendBetAudit(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const safe = redactBody(omitPrivate({
    at: new Date().toISOString(),
    ...row,
  }))
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8')
  return safe
}
```

- [ ] **Step 4: Verify audit tests pass**

Run:

```powershell
node --test tests\betting-audit-log.test.mjs
```

Expected: all tests pass.

### Task 6: Add Dashboard History Insert

**Files:**
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Test: `tests/crown-app-repository.test.mjs`

- [ ] **Step 1: Add repository test**

Append to `tests/crown-app-repository.test.mjs`:

```js
test('repository creates betting history rows for adapter results', () => {
  const { repo } = setup()
  const row = repo.createBettingHistory({
    bettingAccountId: 'bet_1',
    eventKey: 'crown|gid=8878931',
    ruleId: 'brule_1',
    status: 'dry-run-previewed',
    amount: 50,
    oddsRaw: '0.75',
    details: { provider: 'crown', market: { wtype: 'ROU' }, ticketRef: '[ticket:9]' },
  })
  assert.equal(row.status, 'dry-run-previewed')
  assert.equal(row.details.ticketRef, '[ticket:9]')
  assert.equal(repo.listBettingHistory().length, 1)
})
```

- [ ] **Step 2: Run repository test and confirm failure**

Run:

```powershell
node --test tests\crown-app-repository.test.mjs
```

Expected: fails because `createBettingHistory` is missing.

- [ ] **Step 3: Add validation and repository insert**

In `src/crown/app/app-validation.mjs`, export `normalizeBettingHistoryInput(payload)`.

Required normalized fields:

```js
{
  bettingAccountId: String(payload.bettingAccountId || ''),
  eventKey: String(payload.eventKey || ''),
  ruleId: String(payload.ruleId || ''),
  status: String(payload.status || 'unknown'),
  amount: Number(payload.amount || 0),
  oddsRaw: String(payload.oddsRaw || ''),
  details: payload.details && typeof payload.details === 'object' ? payload.details : {},
}
```

In `src/crown/app/app-repository.mjs`, import the normalizer and add:

```js
createBettingHistory(payload) {
  const item = normalizeBettingHistoryInput(payload)
  const time = nowIso()
  const historyId = id('bhist')
  db.prepare(`
    INSERT INTO betting_history (
      id, betting_account_id, event_key, rule_id, status, amount, odds_raw, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(historyId, item.bettingAccountId, item.eventKey, item.ruleId, item.status, item.amount, item.oddsRaw, JSON.stringify(item.details), time)
  return mapBettingHistory(db.prepare('SELECT * FROM betting_history WHERE id = ?').get(historyId))
}
```

- [ ] **Step 4: Verify repository tests pass**

Run:

```powershell
node --test tests\crown-app-repository.test.mjs
```

Expected: all tests pass.

### Task 7: Implement CrownBetAdapter Dry-Run Preview

**Files:**
- Create: `src/crown/betting/crown-bet-adapter.mjs`
- Test: `tests/crown-bet-adapter.test.mjs`

- [ ] **Step 1: Write dry-run adapter test**

Create `tests/crown-bet-adapter.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { CrownBetAdapter } from '../src/crown/betting/crown-bet-adapter.mjs'

test('dry-run preview posts FT_order_view and never posts FT_bet', async () => {
  const calls = []
  const adapter = new CrownBetAdapter({
    session: { uid: 'session-uid', baseUrl: 'https://example.test', cookies: {} },
    fetchImpl: async (url, options) => {
      const body = Object.fromEntries(new URLSearchParams(options.body))
      calls.push({ url, body })
      return new Response('<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>4 / 4.5</spread><strong>C</strong></serverresponse>', { status: 200, headers: { 'content-type': 'text/xml' } })
    },
  })

  const result = await adapter.execute({
    mode: 'dry-run',
    orderFields: { preview: { gid: '8878931', gtype: 'FT', wtype: 'ROU', chose_team: 'C' } },
    intent: { selection: { odds: 0.75 }, decision: { maxStakeHint: 50 }, event: { eventId: '8878931' } },
    account: { status: 'enabled', dailyLimit: 500 },
    rule: { enabled: true, previewOnly: true, minOdds: 0.5, maxOdds: 2, maxSingleAmount: 50 },
    stake: 50,
  })

  assert.equal(result.status, 'previewed')
  assert.deepEqual(calls.map((call) => call.body.p), ['FT_order_view'])
  assert.equal(calls[0].body.uid, 'session-uid')
})
```

- [ ] **Step 2: Run adapter test and confirm failure**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: fails with missing module/export.

- [ ] **Step 3: Implement dry-run adapter**

Create `src/crown/betting/crown-bet-adapter.mjs`:

```js
import { evaluateRisk } from '../../betting/risk-guard.mjs'
import { parseCrownPreviewResponse } from './crown-bet-response-parser.mjs'

async function readText(response) {
  return new TextDecoder('utf-8').decode(Buffer.from(await response.arrayBuffer()))
}

export class CrownBetAdapter {
  constructor({ session, fetchImpl = globalThis.fetch } = {}) {
    this.session = session
    this.fetchImpl = fetchImpl
  }

  async postTransform(form) {
    const body = new URLSearchParams({
      uid: this.session.uid,
      ver: this.session.ver || '',
      langx: 'zh-cn',
      odd_f_type: 'H',
      ...form,
    })
    const response = await this.fetchImpl(`${this.session.baseUrl.replace(/\/$/, '')}/transform.php`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    })
    return readText(response)
  }

  async preview(orderFields) {
    const text = await this.postTransform({ p: 'FT_order_view', ...orderFields.preview })
    return parseCrownPreviewResponse(text)
  }

  async execute({ mode = 'dry-run', orderFields, intent, account, rule, stake }) {
    const risk = evaluateRisk({ intent, account, rule, stake, mode })
    if (!risk.ok) return { status: 'blocked', reason: risk.reason }
    const preview = await this.preview(orderFields)
    if (mode !== 'dry-run') return { status: 'blocked', reason: 'real-submit-not-enabled-in-task-7', preview }
    return { status: 'previewed', preview }
  }
}
```

- [ ] **Step 4: Verify adapter dry-run test passes**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: all tests pass.

### Task 8: Add Gated Real Submit and Polling

**Files:**
- Modify: `src/crown/betting/crown-bet-adapter.mjs`
- Test: `tests/crown-bet-adapter.test.mjs`

- [ ] **Step 1: Add real-submit test with fake fetch**

Append to `tests/crown-bet-adapter.test.mjs`:

```js
test('real submit requires explicit enablement and polls accepted status', async () => {
  const calls = []
  const adapter = new CrownBetAdapter({
    session: { uid: 'session-uid', baseUrl: 'https://example.test', cookies: {} },
    fetchImpl: async (url, options) => {
      const body = Object.fromEntries(new URLSearchParams(options.body))
      calls.push(body)
      if (body.p === 'FT_order_view') return new Response('<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>4 / 4.5</spread><strong>C</strong></serverresponse>', { status: 200 })
      if (body.p === 'FT_bet') return new Response('<serverresponse><code>560</code><ticket_id>123456789</ticket_id><gid>8878931</gid><gtype>FT</gtype><wtype>ROU</wtype><rtype>ROUC</rtype><ioratio>0.75</ioratio><gold>50</gold><spread>4 / 4.5</spread></serverresponse>', { status: 200 })
      if (body.p === 'get_dangerous') return new Response('<serverrequest><status><status_A><ticket id=\"123456789\">A</ticket></status_A></status></serverrequest>', { status: 200 })
      throw new Error(`unexpected request ${body.p}`)
    },
  })
  const result = await adapter.execute({
    mode: 'real',
    allowRealSubmit: true,
    confirm: 'REAL_BET',
    orderFields: {
      preview: { gid: '8878931', gtype: 'FT', wtype: 'ROU', chose_team: 'C' },
      submit: { gid: '8878931', gtype: 'FT', wtype: 'ROU', rtype: 'ROUC', chose_team: 'C', golds: '50', ioratio: '0.75', con: '4', ratio: '-50', autoOdd: 'Y', timestamp: '1', timestamp2: '', isRB: 'Y', imp: 'N', ptype: '', isYesterday: 'N', f: '1R' },
    },
    intent: { selection: { odds: 0.75 }, decision: { maxStakeHint: 50 }, event: { eventId: '8878931' } },
    account: { status: 'enabled', dailyLimit: 500 },
    rule: { enabled: true, previewOnly: false, minOdds: 0.5, maxOdds: 2, maxSingleAmount: 50 },
    stake: 50,
  })
  assert.equal(result.status, 'accepted')
  assert.deepEqual(calls.map((call) => call.p), ['FT_order_view', 'FT_bet', 'get_dangerous'])
  assert.equal(JSON.stringify(result).includes('123456789'), false)
})
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: the new real-submit test fails.

- [ ] **Step 3: Implement gated submit**

Modify `src/crown/betting/crown-bet-adapter.mjs`:

```js
import { parseCrownDangerousStatus, parseCrownSubmitResponse } from './crown-bet-response-parser.mjs'

async submit(orderFields) {
  const text = await this.postTransform({ p: 'FT_bet', ...orderFields.submit })
  return parseCrownSubmitResponse(text)
}

async poll(ticketSecret) {
  const text = await this.postTransform({ p: 'get_dangerous', type: 'xml', from: 'bet', tid: ticketSecret, uni_key: '' })
  return parseCrownDangerousStatus(text)
}
```

Then update `execute()` real mode:

```js
if (mode === 'real') {
  if (!arguments[0].allowRealSubmit || arguments[0].confirm !== 'REAL_BET') return { status: 'blocked', reason: 'real-submit-disabled', preview }
  const submit = await this.submit(orderFields)
  if (!submit.ok) return { status: 'submit-rejected', submit: { ...submit, ticketSecret: undefined } }
  const status = await this.poll(submit.ticketSecret)
  return { status: status.status, submit: { ...submit, ticketSecret: undefined }, poll: status }
}
```

- [ ] **Step 4: Verify adapter tests pass**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: all adapter tests pass and no raw ticket id appears in result JSON.

### Task 9: Add Controlled CLI Entrypoint

**Files:**
- Create: `scripts/crown-bet-execute.mjs`
- Modify: `package.json`
- Test: `tests/crown-bet-execute-cli.test.mjs`

- [ ] **Step 1: Write CLI argument safety tests**

Create `tests/crown-bet-execute-cli.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, assertExecutionSafety } from '../scripts/crown-bet-execute.mjs'

test('defaults to dry-run', () => {
  assert.equal(parseArgs([]).mode, 'dry-run')
})

test('real submit requires confirmation and max stake cap', () => {
  assert.throws(() => assertExecutionSafety(parseArgs(['--real'])), /confirm-required/)
  assert.throws(() => assertExecutionSafety(parseArgs(['--real', '--confirm', 'REAL_BET', '--max-stake', '100'])), /max-stake-too-high/)
  assert.doesNotThrow(() => assertExecutionSafety(parseArgs(['--real', '--confirm', 'REAL_BET', '--max-stake', '50'])))
})
```

- [ ] **Step 2: Run CLI tests and confirm failure**

Run:

```powershell
node --test tests\crown-bet-execute-cli.test.mjs
```

Expected: fails with missing script exports.

- [ ] **Step 3: Implement CLI parser and dry-run shell**

Create `scripts/crown-bet-execute.mjs` with exported `parseArgs()` and `assertExecutionSafety()`. The CLI must:

- Default to `mode='dry-run'`.
- Require `--intent-file <path>`.
- Require `--account-id <id>` and `--rule-id <id>` for repository-backed execution.
- Require `--real --confirm REAL_BET --max-stake 50` for real submit.
- Refuse real submit if `--max-stake` is missing or greater than `50`.
- Print only redacted result JSON.

Add to `package.json`:

```json
"crown:betting:execute": "node scripts/crown-bet-execute.mjs"
```

- [ ] **Step 4: Verify CLI tests pass**

Run:

```powershell
node --test tests\crown-bet-execute-cli.test.mjs
```

Expected: all CLI safety tests pass.

### Task 10: Integrate Audit and History Into Adapter

**Files:**
- Modify: `src/crown/betting/crown-bet-adapter.mjs`
- Test: `tests/crown-bet-adapter.test.mjs`

- [ ] **Step 1: Add audit/history test**

Append to `tests/crown-bet-adapter.test.mjs`:

```js
test('adapter writes redacted audit and history summary', async () => {
  const auditRows = []
  const historyRows = []
  const adapter = new CrownBetAdapter({
    session: { uid: 'session-uid', baseUrl: 'https://example.test', cookies: {} },
    fetchImpl: async () => new Response('<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>4 / 4.5</spread><strong>C</strong></serverresponse>', { status: 200 }),
    audit: (row) => auditRows.push(row),
    history: { createBettingHistory: (row) => historyRows.push(row) || row },
  })
  await adapter.execute({
    mode: 'dry-run',
    orderFields: { preview: { gid: '8878931', gtype: 'FT', wtype: 'ROU', chose_team: 'C' } },
    intent: { selection: { odds: 0.75, oddsRaw: '0.75' }, decision: { maxStakeHint: 50 }, event: { eventId: '8878931', eventKey: 'crown|gid=8878931' } },
    account: { id: 'bet_1', status: 'enabled', dailyLimit: 500 },
    rule: { id: 'brule_1', enabled: true, previewOnly: true, minOdds: 0.5, maxOdds: 2, maxSingleAmount: 50 },
    stake: 50,
  })
  assert.equal(auditRows.length, 1)
  assert.equal(historyRows[0].status, 'previewed')
  assert.equal(JSON.stringify(auditRows).includes('session-uid'), false)
})
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: the new audit/history test fails.

- [ ] **Step 3: Implement audit/history callbacks**

Update the adapter constructor to accept:

```js
constructor({ session, fetchImpl = globalThis.fetch, audit = null, history = null } = {}) {
  this.session = session
  this.fetchImpl = fetchImpl
  this.audit = audit
  this.history = history
}
```

After every `execute()` outcome:

```js
const auditRow = { action: 'crown-bet-execute', mode, status: result.status, intent, orderFields, result }
if (this.audit) this.audit(auditRow)
if (this.history?.createBettingHistory) {
  this.history.createBettingHistory({
    bettingAccountId: account.id || '',
    eventKey: intent.event?.eventKey || intent.event?.eventId || '',
    ruleId: rule.id || '',
    status: result.status,
    amount: Number(stake),
    oddsRaw: intent.selection?.oddsRaw || '',
    details: { provider: 'crown', mode, result },
  })
}
```

Before storing or returning, ensure `ticketSecret` and uid-like values are removed or masked using `redactBody()`.

- [ ] **Step 4: Verify adapter tests pass**

Run:

```powershell
node --test tests\crown-bet-adapter.test.mjs
```

Expected: all adapter tests pass.

### Task 11: Controlled Live Dry-Run Verification

**Files:**
- Output: `data/runtime/betting-execution-audit.jsonl`
- Modify: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: Prepare one dry-run intent file**

Create a local ignored file under `data/runtime/betting-intents/manual-dry-run.json` with a single supported captured market. Do not commit this file.

Required fields:

```json
{
  "provider": "crown",
  "sport": "football",
  "event": {
    "eventId": "use-current-visible-crown-gid",
    "league": "manual",
    "homeTeam": "manual-home",
    "awayTeam": "manual-away"
  },
  "market": {
    "marketType": "total",
    "period": "first_half",
    "handicapRaw": "4 / 4.5"
  },
  "selection": {
    "side": "under",
    "oddsRaw": "0.75",
    "odds": 0.75
  },
  "decision": {
    "reason": "manual dry-run verification",
    "confidence": "high",
    "maxStakeHint": 50
  },
  "source": {
    "snapshotFile": "data/runtime/crown-odds-snapshots.jsonl",
    "changeFile": null,
    "endpointKey": "manual"
  }
}
```

- [ ] **Step 2: Run dry-run CLI**

Run:

```powershell
npm run crown:betting:execute -- --intent-file data\runtime\betting-intents\manual-dry-run.json --account-id bet_manual --rule-id brule_manual --stake 50
```

Expected:

- Request sequence contains `FT_order_view` only.
- No `FT_bet` request is sent.
- CLI output status is `previewed`.
- Audit row is written without uid, cookie, token, password, or raw ticket id.

- [ ] **Step 3: Update protocol map**

Add a section to `docs/crown-betting-protocol-map.md`:

```markdown
## Adapter Dry-Run Verification

| Item | Result |
|---|---|
| Command | `npm run crown:betting:execute -- ...` |
| Mode | `dry-run` |
| Provider request | `FT_order_view` only |
| Submit request | none |
| Result | previewed |
```

### Task 12: Controlled Real Submit Verification

**Files:**
- Output: `data/runtime/betting-execution-audit.jsonl`
- Modify: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: Stop before live submit unless user is present**

Required checklist:

```text
[ ] User explicitly says to run real submit.
[ ] Stake is 50 RMB or less.
[ ] Rule `previewOnly` is false for this one run.
[ ] CLI uses `--real --confirm REAL_BET --max-stake 50`.
[ ] Browser/account page is available for manual cross-check.
```

- [ ] **Step 2: Run one controlled real submit**

Run only after checklist is true:

```powershell
npm run crown:betting:execute -- --intent-file data\runtime\betting-intents\manual-dry-run.json --account-id bet_manual --rule-id brule_manual --stake 50 --real --confirm REAL_BET --max-stake 50
```

Expected:

- Request sequence is `FT_order_view`, `FT_bet`, then `get_dangerous`.
- Result is one of `accepted`, `pending`, `rejected`, `submit-rejected`, or `unknown`.
- If accepted/pending, no raw ticket id is printed or written to public docs.

- [ ] **Step 3: Reconcile with today wagers**

If status is `accepted` or `pending`, call `get_today_wagers` through adapter code and compare against redacted order fields without publishing ticket id.

- [ ] **Step 4: Update protocol map and module docs**

Record:

- Command shape.
- Stake.
- Status.
- Response semantics.
- Evidence path.
- Whether the response added new semantics such as rejected, odds changed, or insufficient balance.

## Verification Commands

Run after Tasks 1-10:

```powershell
node --test tests\crown-bet-response-parser.test.mjs tests\crown-order-field-mapper.test.mjs tests\betting-bet-intent.test.mjs tests\betting-risk-guard.test.mjs tests\betting-audit-log.test.mjs tests\crown-bet-adapter.test.mjs tests\crown-bet-execute-cli.test.mjs
node --test tests\crown-app-repository.test.mjs
node --check scripts\crown-bet-execute.mjs
npm test
npm run check
```

Expected:

- All new protocol/adapter tests pass.
- Existing app repository tests pass.
- Full test suite passes.
- Syntax check passes for all `.mjs` files.

## Completion Criteria

| 项目 | 标准 |
|---|---|
| Dry-run preview | `CrownBetAdapter` can execute `FT_order_view` and return limits/current line without sending `FT_bet`. |
| Rule guard | Real submit is blocked unless account, rule, stake, odds, and confirmation gates pass. |
| Audit | Every adapter decision writes a redacted audit row. |
| History | Dashboard history can show preview/submit summaries without secrets. |
| Real submit | A live submit can only run with `--real --confirm REAL_BET --max-stake 50` and user presence. |
| Monitor boundary | `scripts/crown-watch.mjs` does not import betting execution modules and cannot submit orders. |
| Sensitive output | Tests and scans show no raw uid, cookie, token, password, or ticket id in public docs/audit output. |

## Self-Review

- Spec coverage: The plan covers mapping, preview, risk, audit, history, CLI, dry-run verification, and controlled real submit.
- Scope control: Automatic betting from monitor alerts is excluded.
- Completeness scan: No unresolved markers or unspecified implementation slots are required for the next developer to start.
- Type consistency: `BetIntent`, `orderFields.preview`, `orderFields.submit`, adapter result statuses, and repository history fields use the same names across tasks.
