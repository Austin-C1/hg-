# 皇冠投注 Reconciliation 与 Capability 扩展 Implementation Plan

> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把系统继续建设成可长期运行、可恢复、不会重复下注的自动投注系统；先把当前 `prematch/full_time/asian_handicap/main` 从 `1/1/0` 安全提升到 `1/1/1`，再为其他 exact family 完成独立的证据管线和 fail-closed 开放门禁。

**Architecture:** SQLite 继续作为 child、attempt、账号锁、outcome 和 reconciliation 的唯一事实源。Reconciliation 只消费阶段二写入的不可变 `executionBinding`，由 exact evidence 驱动 strict mapper/parser/provider；任何缺失、漂移或多匹配都保留 `unknown`。其他 family 共用证据验证基础设施，但每个 row 独立抓取、独立审计、独立测试、独立开放，绝不复制当前 main row 的 wire 结论。

**Tech Stack:** Node.js 22.23.1（项目下限 `>=22.5`）、ESM、`node:test`、SQLite、Playwright、React/Vitest、现有 Crown login manager 与 canonical Worker/B2。

## Global Constraints

- 长期目标：持续监控 → exact Signal → 冻结规则 → 顺序账号分配 → account-owned session → fresh Preview → 单次 Submit → accepted/rejected/unknown → reconciliation/manual review；进程重启后从 SQLite 安全恢复。
- 安全底线：宁可不下注，也不猜字段、不重复下注、不在 `unknown` 后自动重投；余额变化、页面提示、相似时间和模糊字符串都不能证明 outcome。
- 阶段一生产就绪收口和阶段二 canonical Worker 验收必须先完成；本计划不得用历史手工抓包替代阶段二的线上链路证据。
- 用户给出的 standing authorization 不要求逐笔再确认，但它不是无限授权：每 child `<= 50 CNY`、每 batch `<= 100 CNY`、整个剩余开发累计 accepted `<= 500 CNY`，且任何 `unknown`、identity/赔率/金额/session/fence 漂移或账本矛盾立即停止新的 Preview/Submit campaign；只读 exact reconciliation 与人工复核仍可继续，用于安全清理 `unknown`，但不得解锁或重投。
- 阶段二计划已占用 accepted `450/500 CNY`，并已用满允许的 5 个 accepted batch；本计划不得重置、另建或绕过该计数。虽然金额余量名义上为 50 CNY，accepted batch 数已耗尽，因此 3A/3B 当前都不得再发 Submit。
- 3A 必须复用阶段二的不可变 `executionBinding`，只允许只读 reconciliation 查询；3B 当前只允许零金额证据、Preview-only capture 和离线开发。任何需要新 Submit 才能证明的 row 必须保持 `0/0/0` 与 `EVIDENCE_REQUIRED`，除非用户以后明确扩大授权。
- standing authorization 不包含充值、提现、付款、真实资金账号、修改账号密钥、扩大 `perBetLimit`、未验证 row、生产部署或绕过 Dashboard ready-ticket/GO。
- `executionBinding` 必须沿用阶段二的 JS contract，并逐项验证：`schemaVersion`、`childId`、`attemptId`、`accountId`、`sessionBindingDigest`、`eventIdentityDigest`、`selectionIdentityDigest`、`orderIdDigest`、`submittedAt`、`requestDigest`、`responseDigest`。数据库列仍为 `child_order_id/submit_attempt_id/account_id`；任一字段缺失或不一致时零 reconciliation 网络、零新 Submit、零自动解锁。
- Reconciliation 的 raw provider reference 只能从当前 attempt 的 `provider_reference_ciphertext` 用原 `purpose: 'crown-provider-reference'` 和同一 `childOrderId/submitAttemptId` context 解密；只在内存中作为 exact 查询参数。`orderIdDigest` 只用于查询前后稳定比对，严禁作为 Provider 查询参数、日志或替代 raw reference。reference 缺失、解密失败或 digest mismatch 时网络请求为 0，attempt/child/锁保持 `unknown`。
- Reconciliation 自动接受只允许 direct exact 单匹配；明确 rejected 只有在 exact endpoint 直接证明未创建注单时才可返回。无匹配、弱匹配、多匹配、截断、超时和未知字段一律保持 `unknown`。
- 当前唯一 enabled row 在 3A 完成前保持 `1/1/0`；只有 reconciliation fixture、字段集合、provider、恢复和安全回归全部通过后才能提升为 `1/1/1`。
- 3B 开放顺序固定为：赛前全场大小球 main → 滚球全场让球 main → 滚球全场大小球 main → first-half → alternate。前一个 row 未满足门槛时，不处理后一个 row 的生产开放。
- 每个 3B row 必须拥有自己的 watcher evidence、Preview request/response、Submit request/response、accepted/rejected/unknown 分类和 reconciliation 状态；不得引用 `prematch/full_time/asian_handicap/main` 的字段作为证明。
- public fixture、日志、API、页面和计划不得包含账号、密码、cookie、token、完整 uid、完整注单 ID、原始响应或私有绝对路径；private/raw 只能留在 ignored runtime 路径。
- 实施时先检查 dirty worktree，保留用户已有改动；只修改任务列出的文件，不做无关重构。
- 每个实现任务执行 RED → GREEN → focused regression；每个 row 再执行 full regression 和安全扫描。没有实际命令输出不得宣称完成。
- 本次用户指令已授权按任务执行 scoped local commits，并在全部验收通过后用于最终同仓库替换发布，不再重复询问。每次必须逐文件 `git add`，随后检查 staged name 与 `git diff --cached --check`；`data/runtime`、`.superpowers/sdd/evidence`、`private`、raw network、SQLite、profile/session 文件一律不得 stage，不得用 `git add .` 或 `git add -f`。

---

## 文件与接口边界

| 单元 | 文件 | 责任 |
|---|---|---|
| Reconciliation evidence | `src/crown/betting/crown-reconciliation-evidence.mjs`、`scripts/crown-betting-reconciliation-analyze.mjs` | 校验 binding、生成脱敏 fixture 与字段指纹 |
| Reconciliation protocol | `src/crown/betting/crown-reconciliation-field-mapper.mjs`、`src/crown/betting/crown-reconciliation-response-parser.mjs` | 只按 verified row 构造查询并分类结果 |
| Production provider | `src/crown/betting/crown-reconciliation-provider.mjs` | account-owned session、origin、lease/fence、单次只读查询 |
| Store/worker | `src/crown/betting/b2-reconciler.mjs`、`src/crown/betting/reconciliation-worker.mjs` | due 调度、原子 resolution、重启恢复、manual review |
| Capability authority | `src/crown/betting/crown-capability-matrix.mjs` | 固定 fixture/hash/field set，独立控制 Preview/Submit/Reconciliation |
| Family mapper | `src/crown/betting/crown-order-field-mapper.mjs`、`src/crown/crown-transform-xml.mjs` | exact family identity 与 evidence-driven wire，不扩大未知 row |
| Runtime wiring | `scripts/crown-reconciliation-worker.mjs`、`src/crown/app/reconciliation-process.mjs`、`scripts/crown-dashboard.mjs` | 独立 reconciler lease/process、due supervisor；不改变真实投注 ready-ticket/GO |
| Acceptance submit guard | `src/crown/betting/capability-acceptance-gate.mjs`、canonical B2/Provider、protocol capture | 对所有可发送 `FT_bet` 的入口共用同一持久化 campaign 门禁，并在 transport 前 fail closed |

### 固定接口

```js
// 阶段二交付；本计划只消费，不重建、不回填猜测值。
 /** @typedef {{
 * schemaVersion: 'crown-submit-execution-binding-v1',
 * childId: string, attemptId: string, accountId: string,
 * sessionBindingDigest: `hmac-sha256:${string}`,
 * eventIdentityDigest: `hmac-sha256:${string}`,
 * selectionIdentityDigest: `hmac-sha256:${string}`,
 * orderIdDigest: `hmac-sha256:${string}`,
 * submittedAt: string,
 * requestDigest: `hmac-sha256:${string}`,
 * responseDigest: `hmac-sha256:${string}`
 * }} CrownSubmitExecutionBinding */

// 本计划新增。
validateCrownReconciliationEvidence(evidence, { expectedCapability, executionBinding })
// -> { evidenceIncomplete: boolean, errors: string[], requestFieldSet: string[], responseFieldSet: string[] }

buildStrictCrownReconciliationRequest(context)
// -> { endpointPath: string, method: 'POST'|'GET', form: Record<string,string> }

parseCrownReconciliationResponseStrict(text, { capability, expected, sealReference })
// -> { decision: 'accepted'|'rejected'|'unknown', matchStrength: 'strong'|'none', matchCount: number, providerReferenceCiphertext?: string, payload: object }

openCrownProviderReference(ciphertext, { childOrderId, submitAttemptId })
// -> raw provider reference；只允许 Provider 内存使用，禁止输出或持久化明文。
```

---

### Task 1: 复核已持久化的 exhausted 门禁并开放阶段三只读动作

**Files:**
- Modify: `src/crown/betting/capability-acceptance-gate.mjs`（阶段二已创建并接入全部 Submit surfaces）
- Create: `scripts/crown-capability-acceptance-gate.mjs`
- Test: `tests/crown-capability-acceptance-gate.test.mjs`
- Test: `tests/crown-controlled-live-acceptance.test.mjs`
- Test: `tests/crown-betting-protocol-capture.test.mjs`
- Test: `tests/crown-betting-b2-executor.test.mjs`
- Test: `tests/crown-account-provider.test.mjs`

**Interfaces:**
- Consumes: 阶段二同事务落库的 `controlled_live_acceptance_campaigns.state=exhausted`、5 份 permit、9 份 immutable claim、`.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.safe.json`、private campaign binding state、`CONTROLLED_LIVE_AUTHORIZATION`、`bet_batches`、`bet_child_orders`、`bet_submit_attempts`、`bet_submit_execution_bindings` 和 `execution_security_audit`；只读交叉核对，不能自行建立新 budget window。
- Produces: 仅供阶段三审计 CLI 使用的 `inspectAcceptanceAuditState(db, { reportPath })` 与 `assertPhase3ReadOnlyActionAllowed(db, { reportPath, action })`；3A 只允许 `reconciliation_read`，3B 只允许 `preview_capture`，`submit` 必须返回 `acceptance-batch-budget-exhausted`。普通 `real-worker-factory`、B2 和 Provider 继续调用阶段二已经接好的 `classifyCampaignOverlay()` / `assertControlledLiveSubmitAllowed()`：读取正式 DB marker 与固定 private HMAC binding state，并对固定 completion report path 只做存在性 sentinel 检查；不解析 report 内容、不用 report 授权，也不接受 CLI、HTTP、环境变量或调用方传入新的 budget window。

- [ ] **Step 1: 写 RED 测试**

```js
const status = inspectAcceptanceAuditState(db, { reportPath: passedCampaignReport })
assert.equal(status.campaignState, 'exhausted')
assert.equal(status.acceptedAmountMinor, 450)
assert.equal(status.acceptedBatchCount, 5)
assert.equal(status.permitCount, 5)
assert.equal(status.permitClaimCount, 9)
assert.equal(status.executionBindingCount, 9)
assert.doesNotThrow(() => assertPhase3ReadOnlyActionAllowed(db, { reportPath: passedCampaignReport, action: 'reconciliation_read' }))
assert.doesNotThrow(() => assertPhase3ReadOnlyActionAllowed(db, { reportPath: passedCampaignReport, action: 'preview_capture' }))
assert.throws(() => assertPhase3ReadOnlyActionAllowed(db, { reportPath: passedCampaignReport, action: 'submit' }), /acceptance-batch-budget-exhausted/)
seedExactDueUnknown(db, { executionBinding: validBinding, providerReferenceCiphertext: validCiphertext })
assert.doesNotThrow(() => assertPhase3ReadOnlyActionAllowed(db, { reportPath: passedCampaignReport, action: 'reconciliation_read' }))
assert.throws(() => assertPhase3ReadOnlyActionAllowed(db, { reportPath: passedCampaignReport, action: 'preview_capture' }), /acceptance-stop-condition/)

assert.equal(classifyCampaignOverlay({ dbMarker: null, privateState: null, reportPresent: false }).state, 'not_applicable')
assert.equal(classifyCampaignOverlay({ dbMarker: null, privateState: null, reportPresent: true }).state, 'campaign-binding-incomplete')
assert.equal(classifyCampaignOverlay({ dbMarker: exhaustedMarker, privateState: null, reportPresent: true }).state, 'campaign-binding-incomplete')
assert.throws(
  () => assertPhase3ReadOnlyActionAllowed(db, { reportPath: missingReport, action: 'reconciliation_read' }),
  /acceptance-campaign-proof-incomplete/,
)
assert.throws(
  () => assertControlledLiveSubmitAllowed(exhaustedDb, { privateStatePath: fixedPrivateStatePath }),
  /acceptance-batch-budget-exhausted/,
)

const calls = { provider: 0, transport: 0, ftBet: 0 }
await assert.rejects(
  () => exhaustedB2.submit(validCanonicalChild, {
    executionProvider: { submit: async () => { calls.provider += 1 } },
  }),
  /acceptance-batch-budget-exhausted/,
)
assert.deepEqual(calls, { provider: 0, transport: 0, ftBet: 0 })

const capture = await runCaptureWithFakeRoute([
  '--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '50',
], { db })
assert.equal(capture.error.code, 'controlled-live-canonical-worker-only')
assert.equal(capture.network.ftBet, 0)
```

再增加 Provider transport spy：即使 B2 被测试替身或未来重构绕过，`CrownAccountExecutionProvider.submit()` 在 fresh Preview 之后、`onNetworkStarted()` 与 `fetch()` 之前仍必须再次调用阶段二 Submit guard；5/5 状态下 callback、transport 和 `FT_bet` 都为 0。phase-3 只读审计缺 report、5 permit/9 claim/9 binding 不齐、accepted 金额/批次数不一致、ledger conflict 或 authorization HMAC 漂移时按 `acceptance-campaign-proof-incomplete`/`acceptance-stop-condition` fail closed；普通 Submit guard 只把固定 report path 的存在性当 tamper sentinel，不读取内容。DB marker/private state/report 全空的 Fresh Portable 为 `not_applicable` 并继续产品原有默认 off 门禁；report-only 和任一其他 partial residue/mismatch 都 fail closed；exhausted/stopped 即使 report 缺失也永久拒绝本次授权下的 Submit。unknown 只允许 exact `reconciliation_read`，仍阻断 Preview/Submit。任何状态都不能因为传入 `--allow-real-submit`、`REAL_BET` 或合法 stake 而放行。

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-concurrency=1 tests/crown-capability-acceptance-gate.test.mjs`

Expected: FAIL，原因是阶段二模块尚未支持 phase-3 `reconciliation_read/preview_capture` 或专用 CLI 不存在；数据库和进程状态不被修改。

- [ ] **Step 3: 扩展阶段二共享门禁的只读 phase-3 action 与 CLI**

```js
export function assertPhase3ReadOnlyActionAllowed(db, { reportPath, action }) {
  const state = inspectAcceptanceAuditState(db, { reportPath })
  if (state.ledgerConflictCount > 0) throw new Error('acceptance-stop-condition')
  if (state.reportStatus !== 'passed' || state.campaignState !== 'exhausted'
    || state.acceptedBatchCount !== 5 || state.acceptedAmountMinor !== 450
    || state.permitCount !== 5 || state.permitClaimCount !== 9
    || state.executionBindingCount !== 9) {
    throw new Error('acceptance-campaign-proof-incomplete')
  }
  if (action === 'submit') throw new Error('acceptance-batch-budget-exhausted')
  if (!['reconciliation_read', 'preview_capture'].includes(action)) throw new Error('acceptance-action-forbidden')
  if (state.unknownCount > 0 && action !== 'reconciliation_read') throw new Error('acceptance-stop-condition')
  return state
}
```

阶段二已经在首次 live window 前完成以下接线，本步骤只做回归断言，不能删掉后重建：

1. canonical Worker 由 `real-worker-factory` 注入阶段二的 DB + fixed private HMAC state Submit guard，并使用模块内固定 report path 做 existence-only tamper sentinel；它不解析或信任 report 内容。B2 在创建/dispatch attempt 前读取已 exhausted campaign，失败时不写 `submit_prepared`、不调用 Provider。Fresh Portable 三种材料全空时该 overlay 只返回 `not_applicable`，产品原有标准门禁和默认 off 仍负责启停；report-only 或其他 partial residue 永远不是 fresh install。
2. `CrownAccountExecutionProvider` 在最终 `FT_bet` transport 前再次验证阶段二 immutable claim；检查失败时不得调用 `onNetworkStarted()`，因此不会制造“已发网络”的假账本，也不会产生请求。
3. `crown-betting-protocol-capture.mjs` 在阶段二已固定为 canonical-worker-only，`--confirm REAL_BET` 与 `--max-stake` 不能消费本次 standing authorization；5/5 后仍必须 `FT_bet=0`。
4. 用静态合同测试扫描仓库内全部 `FT_bet` transport/capture 入口，允许的发送点只能是已接 guard 的 Provider 与 capture blocker；新增第三个入口时测试先失败，禁止仅靠独立 CLI 检查。

- [ ] **Step 4: GREEN 与安全回归**

Run: `node --test --test-concurrency=1 tests/crown-controlled-live-acceptance.test.mjs tests/crown-capability-acceptance-gate.test.mjs tests/crown-betting-protocol-capture.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-security-audit.test.mjs`

Expected: PASS；四态 classifier 对 Fresh Portable、partial residue、active 和 exhausted/stopped 的结果唯一；restart/upgrade 后 terminal 不退回 `not_applicable`。5/5 后 canonical B2/Provider 返回 `acceptance-batch-budget-exhausted`；即使 completion report 缺失或 capture 显式传入 `--allow-real-submit --confirm REAL_BET --max-stake 50`，仍不得放行 Submit。Provider、transport、`onNetworkStarted` 和 `FT_bet` 调用均为 0，结果中无账号、session、注单 ID。

- [ ] **Step 5: Scoped commit**

```powershell
git add src/crown/betting/capability-acceptance-gate.mjs scripts/crown-capability-acceptance-gate.mjs tests/crown-capability-acceptance-gate.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-betting-protocol-capture.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "feat: enforce remaining betting acceptance budget"
```

---

### Task 2: 建立 Reconciliation evidence schema 与 binding handoff

**Files:**
- Create: `src/crown/betting/crown-reconciliation-evidence.mjs`
- Create: `scripts/crown-betting-reconciliation-analyze.mjs`
- Test: `tests/crown-reconciliation-evidence.test.mjs`
- Test: `tests/crown-betting-reconciliation-analyze.test.mjs`
- Test: `tests/crown-submit-execution-binding.test.mjs`（阶段二创建；复用其完整 contract tests）
- Modify: `package.json:13-31`

**Interfaces:**
- Consumes: 阶段二 `getCrownSubmitExecutionBinding(db, attemptId)` 返回的 `CrownSubmitExecutionBinding`、accepted main attempts 和 reconciliation raw capture；CLI 只读 SQLite，不接受调用方提供的 binding JSON。
- Produces: `crown-reconciliation-evidence-v1` safe fixture；private analyzer 先用完整 canonical binding 验证原 child、attempt、account、session、event、selection、order、request、response，再把 `childId/attemptId/accountId` 转成 campaign HMAC binding。public fixture 只保留三个 HMAC binding、六个既有 digest、字段指纹和 safe facts，不保留完整 execution binding。

- [ ] **Step 1: 写 binding 缺失/漂移 RED**

```js
for (const field of [
  'schemaVersion', 'childId', 'attemptId', 'accountId', 'sessionBindingDigest',
  'eventIdentityDigest', 'selectionIdentityDigest', 'orderIdDigest', 'submittedAt',
  'requestDigest', 'responseDigest',
]) {
  const changed = structuredClone(completeEvidence)
  delete changed.executionBinding[field]
  assert.equal(validateCrownReconciliationEvidence(changed, {
    expectedCapability: MAIN_CAPABILITY,
    executionBinding: completeBinding,
  }).evidenceIncomplete, true, field)
}
const safe = sanitizeCrownReconciliationEvidence(completeEvidence, { campaignBinding })
assert.equal('childId' in safe.executionBinding, false)
assert.equal('attemptId' in safe.executionBinding, false)
assert.equal('accountId' in safe.executionBinding, false)
assert.match(safe.executionBinding.childBinding, /^hmac-sha256:[a-f0-9]{64}$/)
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-concurrency=1 tests/crown-reconciliation-evidence.test.mjs tests/crown-betting-reconciliation-analyze.test.mjs`

Expected: FAIL，原因是 validator/analyzer 尚不存在。

- [ ] **Step 3: 实现 exact validator**

```js
const BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'childId', 'attemptId', 'accountId', 'sessionBindingDigest',
  'eventIdentityDigest', 'selectionIdentityDigest', 'orderIdDigest', 'submittedAt',
  'requestDigest', 'responseDigest',
])

export function validateCrownReconciliationEvidence(evidence = {}, { expectedCapability, executionBinding } = {}) {
  const errors = []
  if (executionBinding?.schemaVersion !== 'crown-submit-execution-binding-v1') errors.push('execution-binding-schema')
  for (const field of BINDING_FIELDS) {
    if (!executionBinding?.[field]) errors.push(`execution-binding-${field}`)
    else if (evidence?.executionBinding?.[field] !== executionBinding[field]) errors.push(`execution-binding-drift-${field}`)
  }
  if (!sameExactCapability(evidence?.capability, expectedCapability)) errors.push('capability-mismatch')
  if (evidence?.capture?.synthetic !== false || evidence?.capture?.truncated !== false) errors.push('direct-capture-required')
  const requestFieldSet = exactFieldSet(evidence?.request?.fields)
  const responseFieldSet = exactFieldSet(evidence?.response?.fields)
  return Object.freeze({ evidenceIncomplete: errors.length > 0, errors: Object.freeze([...new Set(errors)]), requestFieldSet, responseFieldSet })
}
```

- [ ] **Step 4: 实现 analyzer 的只读 binding 解析与 public allowlist**

CLI 只接受 `--capture-dir`、`--db-path`、`--out` 和可选 `--artifact-out`。它用只读连接枚举 accepted main attempts，再通过 `getCrownSubmitExecutionBinding()` 读取 canonical binding；对 capture 中的 raw order ID 调用阶段二 `digestCrownExecutionValue(rawReference, { field: 'order-id', scope: 'global' })`，必须恰好匹配其中一份 `orderIdDigest`，0 或多匹配都以 `reconciliation-binding-match-count` 退出。global digest 明确不带 child/attempt context；局部 ID 只用于 binding/ledger 对账。两个输出都必须先在内存中通过 public schema 和敏感字段扫描，再原子写入；内容只含字段集合、HMAC/SHA-256 binding、响应格式和 stable reason code，不输出 raw body、URL query、uid、cookie、账号、本地 child/attempt ID 或完整 order ID。

Run:

```powershell
npm run crown:betting:reconciliation:analyze -- --capture-dir data/runtime/betting-protocol-captures --db-path storage/crown.sqlite --out data/runtime/reconciliation-candidate.safe.json
```

Expected: 测试 fixture 下 exit `0`；缺任一 binding 时 exit 非零并输出 `execution-binding-*`，不回显原值。

- [ ] **Step 5: GREEN**

Run: `node --test --test-concurrency=1 tests/crown-submit-execution-binding.test.mjs tests/crown-reconciliation-evidence.test.mjs tests/crown-betting-reconciliation-analyze.test.mjs tests/crown-betting-protocol-redaction.test.mjs`

Expected: PASS；safe candidate 无敏感词和绝对路径。

- [ ] **Step 6: Scoped commit**

```powershell
git add package.json src/crown/betting/crown-reconciliation-evidence.mjs scripts/crown-betting-reconciliation-analyze.mjs tests/crown-reconciliation-evidence.test.mjs tests/crown-betting-reconciliation-analyze.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "feat: validate exact reconciliation evidence"
```

---

### Task 3: 为当前 main row 取得零 Submit 的 exact reconciliation fixture

**Files:**
- Create: `data/fixtures/crown/betting-protocol/reconciliation/prematch-full-time-asian-handicap-main.accepted.json`
- Create: `data/fixtures/crown/betting-protocol/reconciliation/artifacts/prematch-full-time-asian-handicap-main.safe.json`
- Modify: `tests/crown-capability-matrix.test.mjs:262-310,455-490,845-860`
- Modify: `src/crown/betting/crown-capability-matrix.mjs:349-429,464-474,705-830`

**Interfaces:**
- Consumes: 阶段二一笔 accepted main attempt 的完整 `executionBinding`；只读历史/结果查询。
- Produces: main row 的 reconciliation fixture/hash/field-set metadata；此任务结束时 row 仍为 `1/1/0`。

- [ ] **Step 1: 写 matrix RED**

```js
const main = getCrownCapability({ mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main' })
assert.equal(main.reconciliationAllowed, false)
assert.equal(main.reconciliationBlockedReason, 'crown-reconciliation-evidence-missing')
assert.throws(() => assertCrownCapability(main, { operation: 'reconciliation' }), /reconciliation-blocked/)
```

- [ ] **Step 2: 执行现场硬门**

Run: `node scripts/crown-capability-acceptance-gate.mjs check --action reconciliation_read`

Expected: `ALLOWED reconciliation_read accepted=450/500 batches=5/5`。若 binding 不完整，输出 `EXECUTION_BINDING_REQUIRED` 并停止；不得补发 Submit。

- [ ] **Step 3: 只读 capture 与分析**

使用可见 Browser/Playwright 登录原 account-owned session，打开该 accepted 注单的历史/结果查询；capture 保持默认 Submit blocker，不传 `--allow-real-submit`。

```powershell
npm run crown:betting:capture -- --out data/runtime/betting-reconciliation-captures --allow-odds-click
npm run crown:betting:reconciliation:analyze -- --capture-dir data/runtime/betting-reconciliation-captures --db-path storage/crown.sqlite --out data/runtime/reconciliation-candidate.safe.json
```

Expected: capture 中 `FT_bet` 网络开始数为 `0`；candidate 为 direct、non-truncated、single exact match，并逐项等于 binding。

- [ ] **Step 4: 脱敏审计后固定 fixture**

Run:

```powershell
npm run crown:betting:reconciliation:analyze -- --capture-dir data/runtime/betting-reconciliation-captures --db-path storage/crown.sqlite --out data/fixtures/crown/betting-protocol/reconciliation/prematch-full-time-asian-handicap-main.accepted.json --artifact-out data/fixtures/crown/betting-protocol/reconciliation/artifacts/prematch-full-time-asian-handicap-main.safe.json
rg -n -i "cookie|token|password|authorization|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/reconciliation
node --test --test-concurrency=1 tests/crown-reconciliation-evidence.test.mjs tests/crown-capability-matrix.test.mjs
```

Expected: `rg` 零匹配；测试 PASS；matrix 为 Preview/Submit/Reconciliation `1/1/0`。

- [ ] **Step 5: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/reconciliation/prematch-full-time-asian-handicap-main.accepted.json data/fixtures/crown/betting-protocol/reconciliation/artifacts/prematch-full-time-asian-handicap-main.safe.json src/crown/betting/crown-capability-matrix.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: pin main reconciliation evidence"
```

---

### Task 4: 实现 strict Reconciliation mapper/parser/provider

**Files:**
- Modify: `src/crown/app/app-repository.mjs:764-790`
- Create: `src/crown/betting/crown-reconciliation-field-mapper.mjs`
- Create: `src/crown/betting/crown-reconciliation-response-parser.mjs`
- Create: `src/crown/betting/crown-reconciliation-provider.mjs`
- Test: `tests/crown-reconciliation-field-mapper.test.mjs`
- Test: `tests/crown-reconciliation-response-parser.test.mjs`
- Test: `tests/crown-reconciliation-provider.test.mjs`
- Modify: `tests/crown-app-repository.test.mjs:680-758`

**Interfaces:**
- Consumes: `getCrownSubmitExecutionBinding(db, attemptId)`、attempt/child ledger、`openCrownProviderReference()`、main row `reconciliationEvidence` metadata、account-owned session、executor/reconciler fence。
- Produces: `CrownReconciliationProvider.reconcile({ submitAttemptId, signal })`，返回 strict parser 结果；调用方不能注入 endpoint/form/capability/result。

- [ ] **Step 1: 写 RED**

```js
assert.throws(() => buildStrictCrownReconciliationRequest(context), /crown-capability-reconciliation-blocked/)
assert.throws(
  () => mapVerifiedCrownReconciliationFields({ ...context, amountMinor: 51 }, safeFixture.reconciliationEvidence),
  /reconciliation-context-drift/,
)
const ciphertext = repository.sealCrownProviderReference('raw-order-reference', {
  childOrderId: 'child-1', submitAttemptId: 'attempt-1',
})
assert.equal(repository.openCrownProviderReference(ciphertext, {
  childOrderId: 'child-1', submitAttemptId: 'attempt-1',
}), 'raw-order-reference')
assert.throws(() => repository.openCrownProviderReference(ciphertext, {
  childOrderId: 'child-1', submitAttemptId: 'attempt-2',
}), /secret-context/)
assert.deepEqual(parseCrownReconciliationResponseStrict(exactBody, { capability, expected, sealReference }), {
  decision: 'accepted', matchStrength: 'strong', matchCount: 1,
  providerReferenceCiphertext: 'sealed-reference', payload: exactSafePayload,
})
for (const body of [missingOrderId, duplicateMatch, amountDrift, selectionDrift, truncatedBody]) {
  assert.equal(parseCrownReconciliationResponseStrict(body, { capability, expected, sealReference }).decision, 'unknown')
}
for (const state of [missingReference, decryptFailure, bindingLedgerDrift, orderDigestMismatch]) {
  const result = await reconcileWith(state)
  assert.equal(result.decision, 'unknown')
  assert.equal(networkCalls, 0)
  assertUnknownAndLocked(db)
}
assert.deepEqual(digestCalls, [{ field: 'order-id', scope: 'global' }])
assert.equal(exactRequest.form[verifiedReferenceField], 'raw-order-reference')
assert.equal(JSON.stringify(exactRequest).includes(completeBinding.orderIdDigest), false)
```

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-concurrency=1 tests/crown-reconciliation-field-mapper.test.mjs tests/crown-reconciliation-response-parser.test.mjs tests/crown-reconciliation-provider.test.mjs`

Expected: FAIL，三个模块不存在。

- [ ] **Step 3: 实现 strict contract**

```js
export function buildStrictCrownReconciliationRequest(context) {
  const row = assertCrownCapability(getCrownCapability(context.identity), { operation: 'reconciliation' })
  assertCompleteExecutionBinding(context.executionBinding)
  const wire = Object.fromEntries(row.reconciliationEvidence.requestSources.map(({ field, source }) => [
    field, readBoundSource(context, source),
  ]))
  if (fingerprintCrownFieldSet(Object.keys(wire)) !== row.reconciliationRequestFieldSetFingerprint) {
    throw new Error('crown-reconciliation-request-field-set')
  }
  return { endpointPath: row.reconciliationEvidence.endpointPath, method: row.reconciliationEvidence.method, form: wire }
}
```

`createAppRepository()` 增加 `openCrownProviderReference(ciphertext, { childOrderId, submitAttemptId })`，其 `decryptSecret()` context 必须与现有 `sealCrownProviderReference()` 完全相同。Provider 先用 `getCrownSubmitExecutionBinding()` 校验 `childId/attemptId/accountId/submittedAt` 与 ledger，再解密 attempt 自己的 ciphertext，并调用 `digestCrownExecutionValue(rawReference, { field: 'order-id', scope: 'global' })` 验证 `orderIdDigest`；禁止把 child/attempt 加入该 digest。只有全部通过后，`readBoundSource(context, 'providerReference')` 才可把 raw reference 放入 Task 3 证明的 exact wire。request/form/telemetry/error 不得含 `orderIdDigest` 或 raw reference。

纯 mapper 测试直接用 Task 3 的 safe fixture 验证 field-set/mutation；production request builder 只能从 canonical matrix 取 row，因此 Task 5 promotion 前的 provider happy path 必须保持 blocked。Provider 必须在 I/O 前后检查 lease/fence；只允许 exact HTTPS origin、禁止跨 origin redirect；session/account 不一致时零网络；响应异常不泄露 body，只返回 `unknown`。

- [ ] **Step 4: GREEN 与 mutation regression**

Run: `node --test --test-concurrency=1 tests/crown-app-repository.test.mjs tests/crown-reconciliation-field-mapper.test.mjs tests/crown-reconciliation-response-parser.test.mjs tests/crown-reconciliation-provider.test.mjs tests/crown-account-provider.test.mjs`

Expected: PASS；逐字段删除、添加、重复、改值都 fail-closed；网络调用计数在前置失败时为 0。

- [ ] **Step 5: Scoped commit**

```powershell
git add src/crown/app/app-repository.mjs src/crown/betting/crown-reconciliation-field-mapper.mjs src/crown/betting/crown-reconciliation-response-parser.mjs src/crown/betting/crown-reconciliation-provider.mjs tests/crown-app-repository.test.mjs tests/crown-reconciliation-field-mapper.test.mjs tests/crown-reconciliation-response-parser.test.mjs tests/crown-reconciliation-provider.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "feat: add strict crown reconciliation provider"
```

---

### Task 5: 接入独立 Reconciliation Worker，并把 main row 提升到 `1/1/1`

**Files:**
- Modify: `src/crown/betting/b2-reconciler.mjs:107-140,230-325,346-614`
- Modify: `src/crown/betting/b2-executor.mjs:701-900`
- Create: `src/crown/betting/reconciliation-worker.mjs`
- Create: `scripts/crown-reconciliation-worker.mjs`
- Create: `src/crown/app/reconciliation-process.mjs`
- Modify: `scripts/crown-dashboard.mjs:150-230`
- Modify: `src/crown/app/app-api.mjs:180-310`
- Modify: `src/crown/app/app-repository.mjs:1800-1910`
- Modify: `src/crown/betting/crown-capability-matrix.mjs:349-429,705-830`
- Test: `tests/crown-betting-b2-reconciliation.test.mjs:248-711`
- Modify: `tests/crown-betting-b2-executor.test.mjs`
- Create: `tests/crown-reconciliation-worker.test.mjs`
- Create: `tests/crown-reconciliation-process.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Modify: `tests/crown-operations-summary.test.mjs`
- Test: `tests/crown-betting-worker.test.mjs`（继续证明 Submit Worker 不调度 reconciliation）
- Test: `tests/crown-real-betting-runtime.test.mjs`（继续证明 real readyTicket 只含 worker/executor 两个 role）
- Test: `tests/crown-capability-matrix.test.mjs:262-310,455-490,845-860`
- Test: `tests/crown-reconciliation-provider.test.mjs`（Task 4 创建；本任务补 canonical happy path）

**Interfaces:**
- Consumes: `CrownReconciliationProvider.reconcile()`、`getCrownSubmitExecutionBinding()`、`bet_reconciliation_state`、独立 `betting-reconciler:{db-identity}` lease。
- Produces: 与真实投注 intent 解耦的 read-only due polling；exact accepted/rejected 原子更新 attempt/child/batch/auth/lock/outbox；非决定结果保留 unknown；main row 最终 `1/1/1`。

- [ ] **Step 1: 写 production RED**

```js
assert.equal((await reconciliationWorker.runOnce({ submitAttemptId })).finalStatus, 'accepted')
assert.equal(ledger.child.status, 'accepted')
assert.equal(ledger.lock, undefined)

for (const result of [missingReference, noMatch, weakMatch, duplicateMatch, bindingDrift, sourceTimeout]) {
  await runWith(result)
  assertStillUnknownOrManualReview(db)
  assert.equal(submitCalls, 0)
}
assert.equal(await submitWorkerQueriesReconciliation(), false)
assert.equal(twoRoleRealBettingTicket.leases.reconciler, undefined)
assert.equal(await supervisorStartsWhenRealBettingOffAndExactDueExists(), true)
assert.equal(await supervisorStartsWhenNoDueRowsExist(), false)
```

同时增加 Dashboard restart、reconciler lease takeover、deadline equality、process ownership、事务 fault 注入；任一失败后 evidence 不落半条、锁不释放、Preview/Submit call count 都为 0。

- [ ] **Step 2: 运行 RED**

Run: `node --test --test-concurrency=1 tests/crown-betting-b2-schema.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-reconciliation-worker.test.mjs tests/crown-reconciliation-process.test.mjs tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-reconciliation-provider.test.mjs`

Expected: FAIL；独立 worker/process 尚不存在，production 仍返回 `reconciliation-capability-unverified`，matrix 仍是 `1/1/0`。

- [ ] **Step 3: 实现与 Submit Worker 解耦的只读 Worker**

`reconciliationWorker.runOnce({ limit: 10 })` 每轮只按 `next_poll_at, submit_attempt_id` 取 due unknown；先读 immutable binding、attempt 自己的 ciphertext 和 ledger，全部匹配才调用 Task 4 Provider。reference/binding 不完整的行不访问网络，稳定转 `manual_review` 并继续保锁。production source 必须是 Task 3 fixture 直接证明且已在 schema allowlist 中的 `get_dangerous` 或 `today_wagers`；若证据不能精确落到其中一个 source，就保持 `1/1/0`，不得新增模糊别名或猜 endpoint。

`scripts/crown-reconciliation-worker.mjs` 只装配 reconciliation Provider，不导入 Preview/Submit transport；取得唯一 `betting-reconciler:{db-identity}` lease，每次查询前后 assert fence。`createReconciliationProcessController()` 使用与现有 process controller 相同的 installation/PID/start-time/probe 精确归属校验，但不读写 `real_betting_runtime.requested`。

B2 把 child/attempt 结算为 `unknown` 时，必须在同一事务里幂等 upsert 对应 `bet_reconciliation_state`；事务失败则 unknown settlement 与 schedule 一起回滚。独立 Worker 启动时再以 `submit_attempt_id` 幂等补齐“账本已是 unknown、但因旧版本或崩溃缺 schedule”的行，绝不为 accepted/rejected 创建 due 项，也不把缺 binding/reference 当成 accepted。这样 Dashboard supervisor 不会因缺 state 永久看不到真实 unknown。

Dashboard supervisor 的 `inspectReconciliationWork()` 同时统计已到期的 `bet_reconciliation_state` 和“账本为 unknown 但尚无 state”的 exact-capability attempt；任一数量大于 0 且 reconciliation=1 才启动 managed process。因此即使真实投注为 `off/requested=false`、旧 unknown 尚未 schedule，也能进入 Worker 的幂等 backfill。两类数量都为 0 时不启动，队列清空后安全退出；Dashboard 重启按 SQLite 事实恢复。它不得启动 Betting Worker、改变规则卡、清锁或发送 Preview/Submit。Operations 单独显示 `reconciliationWorker`，不能把它投影成真实投注 running。

保留现有两 role real readyTicket/GO contract：`BettingWorker` 不读取 `bet_reconciliation_state`，worker/executor lease 数仍为 2；这样 unknown 触发真实投注停止后，read-only reconciliation 仍能独立运行，不形成必须重新开启 Submit 才能对账的循环依赖。

- [ ] **Step 4: 最后才开放 matrix**

仅在 Task 3 fixture hash、Task 4 strict tests、Task 5 独立恢复测试全绿后修改 main row：

```js
reconciliationAllowed: true,
reconciliationBlockedReason: '',
```

Run: `node --test --test-concurrency=1 tests/crown-capability-matrix.test.mjs`

Expected: `allowedPreviewCount=1`、`allowedSubmitCount=1`、`allowedReconciliationCount=1`，matrix 无 errors。

- [ ] **Step 5: focused GREEN**

Run: `node --test --test-concurrency=1 tests/crown-betting-b2-schema.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-reconciliation-worker.test.mjs tests/crown-reconciliation-process.test.mjs tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-reconciliation-provider.test.mjs`

Expected: PASS；real intent off 时 exact due reconciliation 仍可完成；无 exact reference 的 unknown 转 manual review 并保锁；`FT_order_view=0`、`FT_bet=0`，fixture source 与 production source 都不能绕过 capability/binding/fence。

- [ ] **Step 6: Scoped commit**

```powershell
git add src/crown/betting/b2-reconciler.mjs src/crown/betting/b2-executor.mjs src/crown/betting/reconciliation-worker.mjs scripts/crown-reconciliation-worker.mjs src/crown/app/reconciliation-process.mjs scripts/crown-dashboard.mjs src/crown/app/app-api.mjs src/crown/app/app-repository.mjs src/crown/betting/crown-capability-matrix.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-reconciliation-worker.test.mjs tests/crown-reconciliation-process.test.mjs tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-reconciliation-provider.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "feat: enable independent exact reconciliation"
```

---

### Task 6: 建立 3B 独立 row evidence/open gate

**Files:**
- Modify: `scripts/crown-betting-protocol-analyze.mjs:21-49,319-345,619-805`
- Modify: `src/crown/betting/crown-order-field-mapper.mjs:6-119,137-219,255-351`
- Modify: `src/crown/betting/crown-capability-matrix.mjs:256-429,705-830`
- Test: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Test: `tests/crown-order-field-mapper.test.mjs:134-244`
- Test: `tests/crown-transform-xml.test.mjs:408-486`
- Test: `tests/crown-capability-matrix.test.mjs:264-490,700-844`

**Interfaces:**
- Consumes: 每个 family 自己的 watcher/Preview/Submit/Reconciliation fixture。
- Produces: `buildCrownPreviewEvidenceCandidate(captureDir, { expectedCapabilityKey })`、evidence-driven `selectionWireBySide`、`submitWireDefaults`、`submitWireSources`；`canOpenCrownCapabilityRow(evidence)` 只有 watcher、Preview、Submit、Reconciliation 四段证据全部完整才允许改变布尔位。
- CLI: `npm run crown:betting:analyze -- $CaptureDir --expected-capability-key $ExactKey --preview-candidate-out $SafeJson`；三个 PowerShell 变量都必须在当前 Task 用固定 row 路径/值显式赋值。`expected-capability-key` 只是断言，实际 key 必须从同一 capture 的 watcher/Preview 内容推导，不能由参数注入。

- [ ] **Step 1: 写“不能复制 main row”RED**

```js
const forged = structuredClone(mainEvidence)
forged.capability = { mode: 'live', period: 'full_time', marketType: 'total', lineVariant: 'main' }
assert.equal(canOpenCrownCapabilityRow(forged).allowed, false)
assert.match(canOpenCrownCapabilityRow(forged).reason, /family-evidence-mismatch/)
assert.throws(
  () => buildCrownPreviewEvidenceCandidate(mainCapture, { expectedCapabilityKey: 'live|full_time|total|main' }),
  /expected-capability-mismatch/,
)
```

- [ ] **Step 2: 写 unknown family RED**

所有非 matrix exact ratio field 的 `lineVariant` 必须继续为 `unknown`；caller 自报 `main`/`alternate` 不改变结果。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-transform-xml.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: 新断言先 FAIL。

- [ ] **Step 3: 实现 evidence-driven mapper**

```js
const selectionWire = capability.mapperEvidence?.selectionWireBySide?.[lockedIdentity.side]
if (!selectionWire || !selectionWire.chose_team || !selectionWire.rtype) {
  throw new Error('crown-submit-selection-wire-unproven')
}
```

Preview-only candidate 固定输出 `missingEvidence: ['submitRequest','submitResponse','reconciliation']`，并在写盘前拒绝 raw body、URL、账号/session 原值和绝对路径。删除 strict Submit 对 `prematch/full_time/asian_handicap/main` 的硬编码判断，但不新增默认 wire；所有 mode/period/market/lineVariant/wtype/isRB/f/rtype/chose_team 都必须来自当前 verified row metadata。

- [ ] **Step 4: GREEN 与 gate 自检**

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-transform-xml.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；当前 count 仍为 `1/1/1`，没有新 row 被打开。

- [ ] **Step 5: Scoped commit**

```powershell
git add scripts/crown-betting-protocol-analyze.mjs src/crown/betting/crown-order-field-mapper.mjs src/crown/betting/crown-capability-matrix.mjs tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-transform-xml.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "refactor: gate crown families by exact evidence"
```

---

### Task 7: 赛前全场大小球 main 独立证据

**Files:**
- Create: `data/fixtures/crown/betting-protocol/candidates/prematch-full-time-total-main.preview.json`
- Modify: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Modify: `tests/crown-capability-matrix.test.mjs:264-490`
- Modify only after full exact evidence: `src/crown/betting/crown-capability-matrix.mjs`

**Interfaces:** exact key `prematch|full_time|total|main`；不继承 AH 的 `wtype/rtype/chose_team/f`。

- [ ] **Step 1: RED**：新增测试读取待创建 fixture，并调用 `assertPreviewEvidenceGap(candidate, 'prematch|full_time|total|main', ['submitRequest','submitResponse','reconciliation'])`；先因文件不存在而 FAIL，同时断言 matrix row 为 `0/0/0`、Submit 被拒绝。
- [ ] **Step 2: Preview-only capture**：运行以下命令；在可见浏览器选择赛前全场大小球 main，取得 watcher + `FT_order_view`，不传 `--allow-real-submit`。

```powershell
node scripts/crown-capability-acceptance-gate.mjs check --action preview_capture
npm run crown:betting:capture -- --out data/runtime/capability-candidates/prematch-full-time-total-main --allow-odds-click
```

- [ ] **Step 3: fixture audit**：验证 mode/period/market/lineVariant、over/under、ratio/odds field、request/response field set 均来自同一 capture；生成 safe candidate 后运行 mutation tests。

```powershell
$capture=(Get-ChildItem -LiteralPath data/runtime/capability-candidates/prematch-full-time-total-main -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
if (-not $capture) { throw 'candidate-capture-missing' }
npm run crown:betting:analyze -- "$capture" --expected-capability-key 'prematch|full_time|total|main' --preview-candidate-out data/fixtures/crown/betting-protocol/candidates/prematch-full-time-total-main.preview.json
if (rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/candidates/prematch-full-time-total-main.preview.json) { throw 'unsafe-candidate-fixture' }
```

- [ ] **Step 4: 当前授权下的 GREEN**：candidate 固定为 `EVIDENCE_REQUIRED: submitRequest,submitResponse,reconciliation`，matrix count 保持 `1/1/1`。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；该 row 为 `0/0/0`，无 `FT_bet`。

- [ ] **Step 5: 未来开放门**：只有用户明确扩大授权并取得该 family 自己的 direct Submit + reconciliation fixture 后，才按 RED → capture audit → provider focused → full regression → 单 row mutation 的顺序改为 `1/1/1`；缺任一项保持 `EVIDENCE_REQUIRED`。
- [ ] **Step 6: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/candidates/prematch-full-time-total-main.preview.json tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: record prematch total evidence gap"
```

---

### Task 8: 滚球全场让球 main 独立证据

**Files:**
- Create: `data/fixtures/crown/betting-protocol/candidates/live-full-time-asian-handicap-main.preview.json`
- Modify: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Modify: `tests/crown-capability-matrix.test.mjs:264-490`
- Modify only after full exact evidence: `src/crown/betting/crown-capability-matrix.mjs`

**Interfaces:** exact key `live|full_time|asian_handicap|main`；`RATIO_RE` 历史 preview fixture 不能证明 Submit/Reconciliation。

- [ ] **Step 1: RED**：新增测试读取待创建 fixture，并调用 `assertPreviewEvidenceGap(candidate, 'live|full_time|asian_handicap|main', ['submitRequest','submitResponse','reconciliation'])`；先因文件不存在而 FAIL，同时拒绝复制 prematch row metadata。
- [ ] **Step 2: Preview-only capture**：现场必须是 live、full_time、非 suspended；运行以下命令并在可见浏览器取得 fresh Preview，不传 `--allow-real-submit`。

```powershell
node scripts/crown-capability-acceptance-gate.mjs check --action preview_capture
npm run crown:betting:capture -- --out data/runtime/capability-candidates/live-full-time-asian-handicap-main --allow-odds-click
```

- [ ] **Step 3: fixture audit**：单独核对 `isRB`、period marker、selection wire、赔率与 line；相似 prematch response 不参与结论。

```powershell
$capture=(Get-ChildItem -LiteralPath data/runtime/capability-candidates/live-full-time-asian-handicap-main -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
if (-not $capture) { throw 'candidate-capture-missing' }
npm run crown:betting:analyze -- "$capture" --expected-capability-key 'live|full_time|asian_handicap|main' --preview-candidate-out data/fixtures/crown/betting-protocol/candidates/live-full-time-asian-handicap-main.preview.json
if (rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/candidates/live-full-time-asian-handicap-main.preview.json) { throw 'unsafe-candidate-fixture' }
```

- [ ] **Step 4: 当前授权下的 GREEN**：记录 `EVIDENCE_REQUIRED: submitRequest,submitResponse,reconciliation`，row 保持 `0/0/0`。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；matrix 总 count 仍为 `1/1/1`。

- [ ] **Step 5: 未来开放门**：新授权后只接受该 live family 的 direct accepted/explicit rejected/unknown 与 reconciliation fixtures；任何 `RATIO_R` 证据视为 family mismatch。
- [ ] **Step 6: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/candidates/live-full-time-asian-handicap-main.preview.json tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: record live handicap evidence gap"
```

---

### Task 9: 滚球全场大小球 main 独立证据

**Files:**
- Create: `data/fixtures/crown/betting-protocol/candidates/live-full-time-total-main.preview.json`
- Modify: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Modify: `tests/crown-capability-matrix.test.mjs:264-490`
- Modify only after full exact evidence: `src/crown/betting/crown-capability-matrix.mjs`

**Interfaces:** exact key `live|full_time|total|main`；over/under 两侧必须各自绑定 ratio/odds field。

- [ ] **Step 1: RED**：新增测试读取待创建 fixture，并调用 `assertPreviewEvidenceGap(candidate, 'live|full_time|total|main', ['submitRequest','submitResponse','reconciliation'])`；先因文件不存在而 FAIL，且 AH wire 不能通过 total mapper。
- [ ] **Step 2: Preview-only capture**：在 live full-time total main 取得 watcher/Preview，同一行两侧字段完整；运行以下命令且不传 `--allow-real-submit`。

```powershell
node scripts/crown-capability-acceptance-gate.mjs check --action preview_capture
npm run crown:betting:capture -- --out data/runtime/capability-candidates/live-full-time-total-main --allow-odds-click
```

- [ ] **Step 3: fixture audit**：逐字段 mutation `wtype/isRB/f/chose_team/rtype/ratio/odds`，任一变化返回 evidence incomplete。

```powershell
$capture=(Get-ChildItem -LiteralPath data/runtime/capability-candidates/live-full-time-total-main -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
if (-not $capture) { throw 'candidate-capture-missing' }
npm run crown:betting:analyze -- "$capture" --expected-capability-key 'live|full_time|total|main' --preview-candidate-out data/fixtures/crown/betting-protocol/candidates/live-full-time-total-main.preview.json
if (rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/candidates/live-full-time-total-main.preview.json) { throw 'unsafe-candidate-fixture' }
```

- [ ] **Step 4: 当前授权下的 GREEN**：写入 `EVIDENCE_REQUIRED: submitRequest,submitResponse,reconciliation`，row 保持 `0/0/0`。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；无 Submit。

- [ ] **Step 5: 未来开放门**：新授权后必须用该 row 自己的 accepted capture 和 canonical Worker 验收；其他 total period/mode 不共享。
- [ ] **Step 6: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/candidates/live-full-time-total-main.preview.json tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: record live total evidence gap"
```

---

### Task 10: First-half exact family 独立证据

**Files:**
- Create: `data/fixtures/crown/betting-protocol/candidates/live-first-half-total-main.preview.json`
- Modify: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Modify: `tests/crown-capability-matrix.test.mjs:264-490`
- Modify only after full exact evidence: `src/crown/betting/crown-capability-matrix.mjs`

**Interfaces:** 优先 key `live|first_half|total|main`，因为已有 preview-only 历史材料；历史 `20260709-112647` 只能作为候选，不可直接升级。

- [ ] **Step 1: RED**：新增测试读取待创建 fixture，并调用 `assertPreviewEvidenceGap(candidate, 'live|first_half|total|main', ['submitRequest','submitResponse','reconciliation'])`；先因文件不存在而 FAIL，同时证明历史 `20260709-112647` 不能替代 fresh fixture。
- [ ] **Step 2: Preview-only recapture**：重新取得 current login/version、watcher identity 与 fresh Preview；运行以下命令且不传 `--allow-real-submit`。

```powershell
node scripts/crown-capability-acceptance-gate.mjs check --action preview_capture
npm run crown:betting:capture -- --out data/runtime/capability-candidates/live-first-half-total-main --allow-odds-click
```

- [ ] **Step 3: fixture audit**：独立核对 first-half period、live mode、total side、period marker 与响应字段集合；full-time fixture mutation 必须失败。

```powershell
$capture=(Get-ChildItem -LiteralPath data/runtime/capability-candidates/live-first-half-total-main -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
if (-not $capture) { throw 'candidate-capture-missing' }
npm run crown:betting:analyze -- "$capture" --expected-capability-key 'live|first_half|total|main' --preview-candidate-out data/fixtures/crown/betting-protocol/candidates/live-first-half-total-main.preview.json
if (rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/candidates/live-first-half-total-main.preview.json) { throw 'unsafe-candidate-fixture' }
```

- [ ] **Step 4: 当前授权下的 GREEN**：记录 `EVIDENCE_REQUIRED: submitRequest,submitResponse,reconciliation`，保持 `0/0/0`。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；旧 fixture 没有被伪装成完整证据。

- [ ] **Step 5: 未来开放门**：新授权后只开放该 exact key；prematch first-half、first-half AH 与其他 alternate 仍各自保持 0。
- [ ] **Step 6: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/candidates/live-first-half-total-main.preview.json tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: refresh first-half total evidence gap"
```

---

### Task 11: Alternate line exact family 独立证据

**Files:**
- Create: `data/fixtures/crown/betting-protocol/candidates/prematch-full-time-asian-handicap-alternate.preview.json`
- Modify: `tests/crown-betting-protocol-execution-evidence.test.mjs:159-493`
- Modify: `tests/crown-transform-xml.test.mjs:408-486`
- Modify: `tests/crown-capability-matrix.test.mjs:264-490`
- Modify only after full exact evidence: `src/crown/crown-transform-xml.mjs:15-57,320-367`
- Modify only after full exact evidence: `src/crown/betting/crown-capability-matrix.mjs`

**Interfaces:** candidate exact key `prematch|full_time|asian_handicap|alternate`；evidence 只记录 A→F 排序中第一个 fresh、非 suspended、能由同一 capture 完整绑定的 ratio field。当前 runtime classifier 不采信 Preview-only candidate，所有 alternate 继续 `lineVariant='unknown'`。

- [ ] **Step 1: RED**：新增测试读取待创建 fixture，并调用 `assertPreviewEvidenceGap(candidate, 'prematch|full_time|asian_handicap|alternate', ['submitRequest','submitResponse','reconciliation'])`；先因文件不存在而 FAIL。candidate schema 拒绝 caller 自报 lineVariant，runtime classifier 仍输出 `unknown`。
- [ ] **Step 2: Preview-only capture**：按 A→F 顺序选择第一个可用赛前全场 AH alternate，运行以下命令取得 watcher/Preview，不传 `--allow-real-submit`。

```powershell
node scripts/crown-capability-acceptance-gate.mjs check --action preview_capture
npm run crown:betting:capture -- --out data/runtime/capability-candidates/prematch-full-time-asian-handicap-alternate --allow-odds-click
```

- [ ] **Step 3: fixture audit**：candidate 只允许一个 ratio field 和对应两侧 odds field；main/其他字母/first-half/live 变体 mutation 全部失败。

```powershell
$capture=(Get-ChildItem -LiteralPath data/runtime/capability-candidates/prematch-full-time-asian-handicap-alternate -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).FullName
if (-not $capture) { throw 'candidate-capture-missing' }
npm run crown:betting:analyze -- "$capture" --expected-capability-key 'prematch|full_time|asian_handicap|alternate' --preview-candidate-out data/fixtures/crown/betting-protocol/candidates/prematch-full-time-asian-handicap-alternate.preview.json
if (rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/candidates/prematch-full-time-asian-handicap-alternate.preview.json) { throw 'unsafe-candidate-fixture' }
```

- [ ] **Step 4: 当前授权下的 GREEN**：即使 Preview candidate 完整，也因缺 Submit/Reconciliation 保持 `0/0/0`；已选和未选 alternate 都继续 unknown，不修改 runtime classifier。

Run: `node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-transform-xml.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS；没有把 A-F 整组批量开放。

- [ ] **Step 5: 未来开放门**：新授权后且 direct Submit/Reconciliation evidence 完整时，才修改 `crown-transform-xml.mjs` 并只提升已选 exact alternate；每增加另一条 alternate 都必须新建独立 fixture、row gate、focused/full regression 和线上验收。
- [ ] **Step 6: Scoped commit**

```powershell
git add data/fixtures/crown/betting-protocol/candidates/prematch-full-time-asian-handicap-alternate.preview.json tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-transform-xml.test.mjs tests/crown-capability-matrix.test.mjs
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "test: isolate alternate line evidence gap"
```

---

### Task 12: 完整 regression、安全扫描、runtime/page 验收与文档收口

**Files:**
- Modify: `README.md:1-24`
- Modify: `docs/project-memory.md:1-49`
- Modify: `docs/module-index.md:1-33,163-177`
- Modify: `docs/modules/crown-betting-protocol.md:1-18,119-186`
- Modify: `docs/crown-betting-protocol-map.md:1-38`
- Modify: `.gitignore:20-38`（仅当新 private/raw 路径尚未覆盖）

**Interfaces:**
- Consumes: Task 1-11 的实际命令输出和 matrix version。
- Produces: 当前权威状态：main `1/1/1`；五个 3B candidate `0/0/0 EVIDENCE_REQUIRED`；standing authorization `450/500 CNY、5/5 accepted batch、Submit exhausted`。

- [ ] **Step 1: focused protocol/reconciliation regression**

```powershell
node --test --test-concurrency=1 tests/crown-reconciliation-evidence.test.mjs tests/crown-betting-reconciliation-analyze.test.mjs tests/crown-reconciliation-field-mapper.test.mjs tests/crown-reconciliation-response-parser.test.mjs tests/crown-reconciliation-provider.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs
```

Expected: exit `0`；main reconciliation 1，其他 row 0；unknown/fence/binding mutation 全绿。

- [ ] **Step 2: focused Worker/runtime regression**

```powershell
node --test --test-concurrency=1 tests/crown-betting-process.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-operations-summary.test.mjs tests/crown-task10-auto-submit.test.mjs tests/crown-card-scoped-betting-integration.test.mjs
```

Expected: exit `0`；真实投注仍保持 worker/executor 两 role ready-ticket/GO；独立 reconciler lease/process 的 restart recovery 通过；测试 transport 不访问 Crown。

- [ ] **Step 3: 完整 backend、syntax、frontend、build**

```powershell
npm test
npm run check
npm --prefix frontend test
npm --prefix frontend run build
```

Expected: 四条命令 exit `0`、零失败。

- [ ] **Step 4: 安全扫描**

```powershell
node --test --test-concurrency=1 tests/crown-betting-security-audit.test.mjs tests/crown-dashboard-security.test.mjs tests/crown-betting-protocol-redaction.test.mjs tests/crown-capability-matrix.test.mjs
rg -n -i "password|authorization|cookie|token|(?:^|[^A-Za-z])uid(?:[^A-Za-z]|$)|[A-Za-z]:\\|/Users/|/home/|/tmp/" data/fixtures/crown/betting-protocol/reconciliation data/fixtures/crown/betting-protocol/candidates
git diff --check
```

Expected: security tests exit `0`；fixture `rg` 零匹配；`git diff --check` 零输出。

- [ ] **Step 5: runtime/API/page 验收（只读）**

重启正常 monitor/dashboard 后，只读检查：

```powershell
$ops = Invoke-RestMethod 'http://127.0.0.1:8787/api/app/operations-summary'
$status = Invoke-RestMethod 'http://127.0.0.1:8787/api/app/real-betting-status'
$ops.reconciliation
$status
```

用 Browser/Playwright 打开 `http://127.0.0.1:8787/operations`，确认页面与 API 一致显示 due/manual/open 数量；不得点击真实投注启动按钮。人工复核 case 仍显示并保持锁，已 exact reconciled case 显示 resolved。

Expected: HTTP 200；Watcher 正常；页面无 console error；本步骤 `FT_bet` 网络开始数为 0。

- [ ] **Step 6: 账本与授权终检**

Run: `node scripts/crown-capability-acceptance-gate.mjs check --action submit`

Expected: `DENIED acceptance-batch-budget-exhausted accepted=450/500 batches=5/5`；unknown 为 0 才能宣告本计划可交付，若 unknown > 0 则状态必须写“人工复核中”，不能自动解锁。

- [ ] **Step 7: 更新权威文档**

文档只记录稳定事实、matrix version、测试命令/结果、main `1/1/1` 和各 candidate 的 `EVIDENCE_REQUIRED`；历史 `0/0/0` 明确标为历史。不得把当前 standing authorization 写成永久产品默认值。

- [ ] **Step 8: 检查改动范围**

Run: `git status --short`

Expected: 只包含本计划列出的源码、测试、safe fixtures 和文档；无 raw capture、数据库、profile、session 或 secret 文件。

- [ ] **Step 9: Final scoped commit for the authorized same-repository replacement**

```powershell
git add README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md docs/crown-betting-protocol-map.md
$staged=@(git diff --cached --name-only); if ($staged | Where-Object { $_ -match '(^|/)(data/runtime|\.superpowers/sdd/evidence|private)(/|$)|raw-network|\.sqlite$|crown-profile|crown-sessions' }) { throw 'private-evidence-staged' }
git diff --cached --check
git commit -m "docs: record reconciliation and capability evidence status"
```

---

## 完成标准

- 当前 main row 的 exact reconciliation fixture、mapper、parser、provider、store、worker、lease/fence、restart recovery 和页面投影全部验证，matrix 为 `1/1/1`。
- `unknown` 在任何 binding 缺失、弱/多匹配、超时、截断、lease takeover 或事务失败后仍保持账号/金额锁，且不存在第二次 Submit。
- 五个 3B family 各自拥有独立的 Preview-only evidence candidate 和明确缺口，不复制 main row 结论；当前授权下全部保持 `0/0/0 EVIDENCE_REQUIRED`。
- backend、syntax、frontend、production build、安全扫描、runtime/API/page 验收全部通过并留下实际输出。
- accepted 总额仍为 `450/500 CNY`、accepted batch 仍为 `5/5`；本计划新增 Submit 为 0。
- 只有用户以后明确扩大 standing authorization，并且某个 exact family 获得自己的 direct Submit/Reconciliation 证据后，才为该 row 编写独立 promotion execution；这不是当前授权下可自动完成的动作。
