# 皇冠投注受控线上验收 Implementation Plan

> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在唯一已验证的赛前全场让球 main capability 上完成 canonical Worker/B2 的真实线上验收，并为长期运行、可恢复、绝不重复下注的最终系统留下可复用证据；宁可不下注，也不猜字段、重复下注或在 `unknown` 后自动重投。

**Architecture:** 阶段二先补一份与 accepted Submit 同事务落库的 immutable `executionBinding`，再增加验收审计器和 SQLite 原子 Submit permit。普通审计路径只读 SQLite/loopback GET；只有 `init/freeze/verify/stop` 能通过窄接口写 campaign/permit 状态，不能写下注 outcome 或旁路启动 Worker。真实 Preview/Submit 仍只允许由 Dashboard 管理的 canonical Worker/B2 执行；每个验收窗口先把唯一 pending Signal 冻结成 HMAC-bound permit，B2 在正式事务中按 child 原子 claim，Provider 在 `FT_bet` transport 前再次验证 claim。第 5 个 accepted batch 或任一 stop condition 会立即把本机 campaign 置为 exhausted/stopped，不等待阶段三代码或人工命令才生效。

**Tech Stack:** Node.js 22.23.1、ES modules、`node:test`、`node:sqlite`、SQLite、React 18 + Ant Design Dashboard、PowerShell、canonical Crown `FT_order_view` / `FT_bet` Provider。

**Design source:** `docs/superpowers/specs/2026-07-14-crown-betting-remaining-work-design.md`

**Required predecessor:** `docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md` 必须先完成，并生成绿色证据 `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json`。

## Global Constraints

- 最终产品目标固定为：长期运行、可恢复、不重复下注；任何安全结论不完整时保持 fail-closed。
- 用户已授予本阶段 standing authorization，不再逐笔重复询问；授权只覆盖本计划定义的一次受控验收 campaign，campaign 结束即耗尽。
- 授权账号只限 campaign 初始化时绑定的现有不可充提、仅含虚拟余额的 CNY 账号；账号集合、顺序或性质发生变化时立即阻断。
- 充值、提现、真实资金账号、账号转移、付款、账单和余额补充不在授权范围内。
- capability 只允许 `prematch/full_time/asian_handicap/main`；Watcher 必须来自新的 `RATIO_R` main 行。`RATIO_RE`、滚球、大小球、first-half、alternate 和未知 `lineVariant` 全部禁止。
- 每个 child accepted 金额最多 `50 CNY`；每个 batch 最多 `2` 个 child、最多 `100 CNY`；campaign 最多 `5` 个 completed accepted batch，累计 accepted 最多 `500 CNY`。
- 预定验收序列固定为第 1 个 batch `[50]`、第 2–5 个 batch 各 `[50,50]`，预计累计 `450 CNY`；不得用更大金额“加快”验收。
- autonomous selection 只允许在当前 Watcher 已产生、且审计器判定为 exact 的候选中选择；不得手工拼造 event、selection、line、赔率或 wire fields。
- 每个真实窗口开始前，runtime 必须为 `off/requested=false`、Watcher 已停止、只有一个 exact pending inbox、无 active batch、无 unknown、无活动 submit attempt、无账号锁。
- Dashboard 的“开启真实投注”及其既有确认框是唯一启动入口；验收脚本不得 POST `/real-betting/start`、不得 spawn Worker、不得调用 Crown。
- Task 3 的共享 guard 必须在 Task 5 初始化和任何 live window 之前提交并全绿；`init` 在正式 SQLite 建立本机 active campaign marker。marker 存在后，Dashboard/API、B2、Provider 和 protocol capture 都不能绕过 permit；marker exhausted/stopped 的当前开发数据永久拒绝新增 Submit，除非用户以后明确建立新的授权流程。
- campaign overlay 使用唯一四态：DB marker、private binding state、private completion report 全部不存在时为 `not_applicable`，只代表普通新安装，不能提供授权，产品原有门禁与默认 `off` 仍全部生效；DB marker/private state 只存在一方、report 在无有效 pair 时单独残留、active 时提前出现 report、或任一 HMAC/事实不匹配时为 `campaign-binding-incomplete`，所有 Submit 入口 fail-closed；有效 pair 且 state=`active` 时必须有唯一 exact frozen permit；有效 pair 且 state=`exhausted|stopped` 时为不可逆 terminal，永久拒绝本次授权下的新 Submit。active 期间 completion report 尚未生成是正常状态；普通 Worker/Provider 只检查固定 report path 的存在性作为单向 tamper sentinel，绝不读取其内容来授权，report 内容只供 terminal 后只读审计。
- Portable 不打包 DB marker、private binding state 或 private completion report，因此全新安装恰好是 `not_applicable`；当前开发安装的 marker 由升级、重启、清锁和普通 cleanup 保留。DB marker/private state 任一缺失或漂移只会变成 `campaign-binding-incomplete`；terminal report 缺失只会让阶段三只读审计不完整，Submit 仍由 exhausted/stopped pair 阻断。上述正常产品入口都不能把当前安装退回 `not_applicable`。
- 一个窗口只处理一个 batch。batch 终态出现后立即通过 Dashboard 停止真实投注，确认 Worker/Executor lease 释放后才能进入下一窗口。
- 每个 child 只允许一次网络开始和一个 `attempt_ordinal=1`；检测到第二个 attempt、第二次 network-start、重复 request digest 或重复 order digest 时立即停止。
- accepted 仍只允许 direct `code=560`、唯一持久结果标识、identity/金额/赔率精确回显；不可用页面文案、余额变化或相似时间推断。
- 网络开始后，只要不能证明 accepted 或未创建注单，就写 `unknown`，保留账号和金额锁，不重试、不转投、不自动对账、不自动解锁。
- 任一 `unknown`、identity/fence/session 漂移、账本矛盾、重复请求迹象、页面与本地结果不一致，立即停止整个 campaign，不继续凑满 5 个 batch。
- 网络开始前且能证明未发送的取消不计入 5 个 accepted batch；但如果原因是 identity/fence/session 漂移，仍终止 campaign。
- `executionBinding` 只为后续 3A Reconciliation 提供不可变关联，不提升 capability；本计划完成后 Preview/Submit/Reconciliation 仍为 `1/1/0`。
- Reconciliation 为 0 时，任何 unknown 只进入人工复核；3A 只能只读消费 binding，不能用 binding 自动宣布 accepted/rejected。
- 开发、单元测试、fixture rehearsal 和安全扫描全部离线；只有 Tasks 6–8 的明确 live 窗口允许 canonical Worker 访问 Crown。
- public/safe 报告不得包含账号、用户名、密码、cookie、token、完整 uid、origin、原始请求/响应、完整 child/attempt/order ID 或私有绝对路径。
- 当前任务只编写计划；不得因阅读本计划自动启动 Worker、访问 Crown、发送 Preview/Submit、修改正式数据库、启动/停止进程或执行 Git commit。
- 当前编写计划时不执行 Git；未来实现的 scoped local commit 和最终 GitHub 替换发布已由本次用户指令授权，不再重复询问，但仍必须逐文件 stage 并排除 private/runtime evidence。

---

## Completion Standard

| 项目 | 必须满足 |
|---|---|
| accepted 序列 | 5 个连续 completed batch：`[50]`、`[50,50]`、`[50,50]`、`[50,50]`、`[50,50]` |
| 金额 | 累计 `450 CNY`；每 child `50`；每 batch 不超过 `100` |
| capability | 全部为 `prematch/full_time/asian_handicap/main`，matrix 仍为 `1/1/0` |
| 请求唯一性 | 每 child 恰好一个 attempt、一次 dispatch、一个 request digest、一个 order digest |
| 许可唯一性 | 5 个 HMAC-bound permit、9 个 immutable child claim；B2 原子 claim，Provider transport 前复核 |
| 账本 | accepted/target 精确一致；unknown、active、open attempt、残留锁均为 0 |
| 恢复 | 5 个独立 Worker 启停窗口均取得新鲜 worker/executor fence；旧 ticket/lease 不复用 |
| 审计 | 5 个 batch 均有 immutable `executionBinding` 和脱敏 safe report |
| 运行收尾 | 真实投注 `off/requested=false`；Watcher 恢复 active/unique/fresh；campaign 已在第五批 settlement 同事务置为 `exhausted`，没有第 6 个 accepted batch |

## File Map

| 文件 | 责任 |
|---|---|
| `src/crown/app/app-secret.mjs` | 提供带 domain separation 的本机 keyed digest，不输出密钥 |
| `src/crown/app/app-db.mjs` | 新增 immutable `bet_submit_execution_bindings` 以及 controlled-live campaign/permit/claim 表、约束和防改触发器 |
| `src/crown/app/app-repository.mjs` | 生成 session/event/selection/order/request/response digest；为 3A 提供 context-bound provider reference 解密接口 |
| `src/crown/app/runtime-cache-cleanup.mjs` | 完全重置时按 FK 顺序清除 binding，不留下孤儿行 |
| `src/crown/betting/real-betting-runtime.mjs` | 把 binding 表和 immutability triggers 纳入正式 schema preflight |
| `src/crown/betting/submit-execution-binding.mjs` | 定义、校验、插入和读取 binding 的唯一接口 |
| `src/crown/betting/crown-account-execution-provider.mjs` | transport 前复核 immutable permit claim；在 direct accepted response 内构建 binding；不保存 raw material |
| `src/crown/betting/b2-executor.mjs` | 网络前原子 claim permit；accepted outcome 与 binding 同事务落库；binding 缺失时转 unknown |
| `src/crown/betting/controlled-live-acceptance.mjs` | 纯函数实现 standing limits、baseline、batch 和 campaign 审计 |
| `src/crown/betting/capability-acceptance-gate.mjs` | 所有 canonical Submit 入口共用的本机 campaign/permit 门禁；不存在调用方可覆盖的预算窗口 |
| `scripts/crown-controlled-live-acceptance.mjs` | query-only audit handle + 窄 campaign permit store + loopback GET CLI；写 private campaign state 和 safe artifact |
| `tests/crown-submit-execution-binding.test.mjs` | binding schema、immutability、mismatch 和 unknown fallback |
| `tests/crown-controlled-live-acceptance.test.mjs` | 授权上限、序列、重复、unknown、漂移与脱敏测试 |
| `docs/crown-controlled-live-acceptance-runbook.md` | 固定操作顺序、停止条件和收尾方式 |
| `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.safe.json` | 成功后生成的机器可读脱敏证据 |
| `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.md` | 成功后生成的人类可读摘要 |

mapper、capability row 和业务字段原则上不改；Task 3 只在生产 transport/Worker claim 前增加本次受控 campaign 的 fail-closed permit guard。如果 live 验收暴露其他模块 bug，停止 campaign，单独建立 RED→GREEN 修复任务并完整回归后再继续；不得在现场放宽门禁。

## Shared Interfaces

### Standing authorization

```js
export const CONTROLLED_LIVE_AUTHORIZATION = Object.freeze({
  schemaVersion: 'crown-controlled-live-authorization-v1',
  authorizationKind: 'standing',
  accountScope: 'existing-non-deposit-withdrawal-virtual-cny',
  capabilityKey: 'prematch|full_time|asian_handicap|main',
  ratioField: 'RATIO_R',
  maxChildAmountMinor: 50,
  maxChildrenPerBatch: 2,
  maxBatchAmountMinor: 100,
  maxAcceptedBatches: 5,
  maxAcceptedAmountMinor: 500,
})
```

### Immutable execution binding

```ts
type CrownSubmitExecutionBinding = {
  schemaVersion: 'crown-submit-execution-binding-v1'
  childId: string
  attemptId: string
  accountId: string
  sessionBindingDigest: `hmac-sha256:${string}`
  eventIdentityDigest: `hmac-sha256:${string}`
  selectionIdentityDigest: `hmac-sha256:${string}`
  orderIdDigest: `hmac-sha256:${string}`
  submittedAt: string
  requestDigest: `hmac-sha256:${string}`
  responseDigest: `hmac-sha256:${string}`
}
```

数据库列使用 `child_order_id`、`submit_attempt_id`、`account_id`；JS 接口映射为上面的 `childId`、`attemptId`、`accountId`。safe 报告再次把三个本地 ID 映射为 campaign HMAC binding，不直接输出原值。

### Immutable standing-authorization binding

账号表当前没有“虚拟余额/不可充提”的可验证字段，因此不得从余额或账号状态猜测资金性质。`init` 必须把用户本次明确授权声明与当时恰好两个现有账号绑定成 private、不可扩大、可重复校验的 scope document：

```ts
type ControlledLiveAuthorizationBinding = {
  schemaVersion: 'crown-controlled-live-authorization-binding-v1'
  source: 'user-standing-authorization-2026-07-14'
  fundingKind: 'virtual-balance-only'
  depositsAllowed: false
  withdrawalsAllowed: false
  accountBindingsInOrder: [`hmac-sha256:${string}`, `hmac-sha256:${string}`]
  limits: typeof CONTROLLED_LIVE_AUTHORIZATION
  binding: `hmac-sha256:${string}`
}
```

该 document 与 32-byte private campaign key 一起只保存在 `data/runtime/controlled-live-acceptance/current/`，不得进入 safe/public artifact。CLI 不提供任何可覆盖 `source`、资金性质、账号集合、顺序或 limit 的参数；`peek/freeze/observe/verify/close` 每次都从正式 DB 重读账号，按 canonical JSON 重算 document 和 HMAC。任一字段未知、缺失、被篡改或与 `init` 不同，必须在 Worker/Preview/Submit 之前停止整个 campaign。

---

### Task 1: Persist immutable accepted Submit bindings

**Files:**
- Create: `src/crown/betting/submit-execution-binding.mjs`
- Modify: `src/crown/app/app-secret.mjs:77-87,143-180`
- Modify: `src/crown/app/app-db.mjs:565-653`
- Modify: `src/crown/app/app-repository.mjs:764-790`
- Modify: `src/crown/app/runtime-cache-cleanup.mjs:45-65,250-290`
- Modify: `src/crown/betting/real-betting-runtime.mjs:134-160`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs:200-275`
- Modify: `src/crown/betting/b2-executor.mjs:701-841,1041-1121`
- Test: `tests/crown-app-secret.test.mjs`
- Test: `tests/crown-app-db.test.mjs`
- Test: `tests/crown-runtime-cache-cleanup.test.mjs`
- Test: `tests/crown-real-betting-runtime.test.mjs`
- Test: `tests/crown-account-provider.test.mjs`
- Test: `tests/crown-betting-b2-executor.test.mjs`
- Create: `tests/crown-submit-execution-binding.test.mjs`

**Interfaces:**
- Consumes: direct accepted parser result、B2 `childOrderId/submitAttemptId/accountId`、ledger `dispatched_at`、本机 secret key。
- Produces: `normalizeCrownSubmitExecutionBinding(value, expected)`、`insertCrownSubmitExecutionBinding(db, binding)`、`getCrownSubmitExecutionBinding(db, attemptId)`。
- Produces for 3A: 上述 immutable binding，以及 `openCrownProviderReference(ciphertext, { childOrderId, submitAttemptId })`；3A 不读取 raw provider response，也不从余额或页面推断。

- [ ] **Step 1: Write keyed-digest and schema RED tests**

```js
test('secret digest is deterministic and domain separated', () => {
  const options = { secretKey: 'test-only-32-byte-secret-material' }
  const a = digestSecret('same', { ...options, context: { purpose: 'submit-binding', field: 'session' } })
  const b = digestSecret('same', { ...options, context: { purpose: 'submit-binding', field: 'session' } })
  const c = digestSecret('same', { ...options, context: { purpose: 'submit-binding', field: 'order' } })
  assert.match(a, /^hmac-sha256:[a-f0-9]{64}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('submit execution binding rows cannot be updated or deleted', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  seedAcceptedAttempt(handle.db)
  insertCrownSubmitExecutionBinding(handle.db, acceptedBinding())
  assert.throws(
    () => handle.db.prepare("UPDATE bet_submit_execution_bindings SET order_id_digest='hmac-sha256:"
      + '0'.repeat(64) + "'").run(),
    /bet-submit-execution-binding-immutable/,
  )
  assert.throws(
    () => handle.db.prepare('DELETE FROM bet_submit_execution_bindings').run(),
    /bet-submit-execution-binding-immutable/,
  )
})
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-app-secret.test.mjs tests/crown-app-db.test.mjs tests/crown-submit-execution-binding.test.mjs
```

Expected: FAIL because `digestSecret`、binding table 和 binding module 尚不存在。

- [ ] **Step 3: Add the keyed digest**

在 `app-secret.mjs` 使用现有 local key derivation，并加入 context domain separation：

```js
export function digestSecret(value, options = {}) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!text) throw invalidContext('secret-digest-value-required')
  const domain = contextBytes(options.context)
  const digest = crypto.createHmac('sha256', keyBytes(options))
    .update(domain)
    .update(Buffer.from([0]))
    .update(text, 'utf8')
    .digest('hex')
  return `hmac-sha256:${digest}`
}
```

- [ ] **Step 4: Add the immutable table**

紧跟 `bet_submit_attempts` 创建：

```sql
CREATE TABLE IF NOT EXISTS bet_submit_execution_bindings (
  submit_attempt_id TEXT PRIMARY KEY,
  child_order_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'crown-submit-execution-binding-v1'),
  session_binding_digest TEXT NOT NULL,
  event_identity_digest TEXT NOT NULL,
  selection_identity_digest TEXT NOT NULL,
  order_id_digest TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submit_attempt_id) REFERENCES bet_submit_attempts(submit_attempt_id),
  FOREIGN KEY (child_order_id) REFERENCES bet_child_orders(child_order_id),
  FOREIGN KEY (account_id) REFERENCES betting_accounts(id),
  CHECK (length(submitted_at) > 0),
  CHECK (session_binding_digest GLOB 'hmac-sha256:*' AND length(session_binding_digest) = 76),
  CHECK (event_identity_digest GLOB 'hmac-sha256:*' AND length(event_identity_digest) = 76),
  CHECK (selection_identity_digest GLOB 'hmac-sha256:*' AND length(selection_identity_digest) = 76),
  CHECK (order_id_digest GLOB 'hmac-sha256:*' AND length(order_id_digest) = 76),
  CHECK (request_digest GLOB 'hmac-sha256:*' AND length(request_digest) = 76),
  CHECK (response_digest GLOB 'hmac-sha256:*' AND length(response_digest) = 76),
  CHECK (substr(session_binding_digest,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (substr(event_identity_digest,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (substr(selection_identity_digest,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (substr(order_id_digest,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (substr(request_digest,13) NOT GLOB '*[^0-9a-f]*'),
  CHECK (substr(response_digest,13) NOT GLOB '*[^0-9a-f]*')
);

CREATE UNIQUE INDEX IF NOT EXISTS bet_submit_execution_bindings_order_digest_uq
ON bet_submit_execution_bindings(order_id_digest);

CREATE UNIQUE INDEX IF NOT EXISTS bet_submit_execution_bindings_request_digest_uq
ON bet_submit_execution_bindings(request_digest);

CREATE TRIGGER IF NOT EXISTS bet_submit_execution_bindings_immutable_update
BEFORE UPDATE ON bet_submit_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-execution-binding-immutable');
END;

CREATE TRIGGER IF NOT EXISTS bet_submit_execution_bindings_immutable_delete
BEFORE DELETE ON bet_submit_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'bet-submit-execution-binding-immutable');
END;
```

同时把该表和两个 trigger 加入 schema contract/safety reset 的显式清单。`runtime-cache-cleanup.mjs` 必须把 binding 表放在 `RESET_TABLES` 的 `bet_submit_attempts` 之前，并在 reset transaction 内先执行 `DROP TRIGGER IF EXISTS bet_submit_execution_bindings_immutable_delete`，再按 FK 顺序删除 binding 和 attempt；随后既有 `openAppDatabase()` 必须重建 delete trigger。测试必须证明普通 DELETE 仍被拒绝、受控 cleanup 成功且 reopen 后 DELETE 再次被拒绝，不能留下一个永久关闭 immutability 的数据库。

- [ ] **Step 5: Implement the exact binding module**

```js
const SCHEMA = 'crown-submit-execution-binding-v1'
const DIGEST = /^hmac-sha256:[a-f0-9]{64}$/
const KEYS = [
  'schemaVersion', 'childId', 'attemptId', 'accountId',
  'sessionBindingDigest', 'eventIdentityDigest', 'selectionIdentityDigest',
  'orderIdDigest', 'submittedAt', 'requestDigest', 'responseDigest',
]

export function normalizeCrownSubmitExecutionBinding(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('submit-execution-binding-required')
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...KEYS].sort())) {
    throw new Error('submit-execution-binding-field-set')
  }
  const result = Object.fromEntries(KEYS.map((key) => [key, String(value[key] || '').trim()]))
  if (result.schemaVersion !== SCHEMA) throw new Error('submit-execution-binding-schema')
  for (const key of ['childId', 'attemptId', 'accountId']) {
    if (!result[key] || (expected[key] && result[key] !== expected[key])) {
      throw new Error('submit-execution-binding-identity')
    }
  }
  for (const key of KEYS.filter((key) => key.endsWith('Digest'))) {
    if (!DIGEST.test(result[key])) throw new Error('submit-execution-binding-digest')
  }
  if (!Number.isFinite(Date.parse(result.submittedAt))
    || (expected.submittedAt && result.submittedAt !== expected.submittedAt)) {
    throw new Error('submit-execution-binding-time')
  }
  return Object.freeze(result)
}

export function insertCrownSubmitExecutionBinding(db, value, expected = {}) {
  const binding = normalizeCrownSubmitExecutionBinding(value, expected)
  const context = db.prepare(`
    SELECT attempt.submit_attempt_id, attempt.child_order_id, child.account_id,
           attempt.dispatched_at
    FROM bet_submit_attempts AS attempt
    JOIN bet_child_orders AS child ON child.child_order_id=attempt.child_order_id
    WHERE attempt.submit_attempt_id=?
  `).get(binding.attemptId)
  if (!context
    || context.child_order_id !== binding.childId
    || context.account_id !== binding.accountId
    || context.dispatched_at !== binding.submittedAt) {
    throw new Error('submit-execution-binding-ledger-drift')
  }
  db.prepare(`
    INSERT INTO bet_submit_execution_bindings (
      submit_attempt_id,child_order_id,account_id,schema_version,
      session_binding_digest,event_identity_digest,selection_identity_digest,
      order_id_digest,submitted_at,request_digest,response_digest,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    binding.attemptId, binding.childId, binding.accountId, binding.schemaVersion,
    binding.sessionBindingDigest, binding.eventIdentityDigest, binding.selectionIdentityDigest,
    binding.orderIdDigest, binding.submittedAt, binding.requestDigest, binding.responseDigest,
    binding.submittedAt,
  )
  return binding
}

export function getCrownSubmitExecutionBinding(db, attemptId) {
  const row = db.prepare('SELECT * FROM bet_submit_execution_bindings WHERE submit_attempt_id=?').get(attemptId)
  if (!row) return null
  return normalizeCrownSubmitExecutionBinding({
    schemaVersion: row.schema_version,
    childId: row.child_order_id,
    attemptId: row.submit_attempt_id,
    accountId: row.account_id,
    sessionBindingDigest: row.session_binding_digest,
    eventIdentityDigest: row.event_identity_digest,
    selectionIdentityDigest: row.selection_identity_digest,
    orderIdDigest: row.order_id_digest,
    submittedAt: row.submitted_at,
    requestDigest: row.request_digest,
    responseDigest: row.response_digest,
  })
}
```

- [ ] **Step 6: Build binding material in the Provider without persisting raw data**

新增 repository 方法 `digestCrownExecutionValue(value, { field, scope, childOrderId, submitAttemptId })`。`scope='binding'` 用于 session/event/selection/response，context 包含 child+attempt；`scope='global'` 只允许 `order-id` 和 `request`，context 不能包含 child/attempt，确保跨 attempt 的同一 provider order 或同一 canonical request 得到相同 digest。两种 scope 都调用本机 keyed `digestSecret`，不保存 raw material。Provider 在 `onNetworkStarted()` 返回的 ledger `dispatchedAt` 基础上构建：

```js
digestCrownExecutionValue(value, { field, scope = 'binding', childOrderId, submitAttemptId } = {}) {
  const text = String(value || '')
  const bindingField = String(field || '').trim()
  const child = String(childOrderId || '').trim()
  const attempt = String(submitAttemptId || '').trim()
  if (!text || !bindingField) throw new Error('crown-execution-digest-context')
  if (scope === 'global' && !['order-id', 'request'].includes(bindingField)) throw new Error('crown-execution-global-digest-field')
  if (scope === 'binding' && (!child || !attempt)) throw new Error('crown-execution-digest-context')
  return digestSecret(text, {
    ...secretOptions,
    context: {
      purpose: scope === 'global' ? 'crown-submit-global-dedup-v1' : 'crown-submit-execution-binding-v1',
      field: bindingField,
      ...(scope === 'binding' ? { childOrderId: child, submitAttemptId: attempt } : {}),
    },
  })
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}
const stableJson = (value) => JSON.stringify(stable(value))
const digest = (field, value, scope = 'binding') => this.repository.digestCrownExecutionValue(value, {
  field, scope, childOrderId, submitAttemptId,
})

const submittedAt = input.onNetworkStarted()
let orderIdDigest = ''
const outcome = parseCrownSubmitResponseStrict(response?.text, {
  expected,
  expectedFieldSet: capability.submitResponseFieldSet,
  sealReference: (reference) => {
    orderIdDigest = this.repository.digestCrownExecutionValue(reference, {
      field: 'order-id', scope: 'global',
    })
    return this.repository.sealCrownProviderReference(reference, { childOrderId, submitAttemptId })
  },
})
if (outcome.kind !== 'accepted') return { kind: 'unknown' }
return {
  ...outcome,
  executionBinding: {
    schemaVersion: 'crown-submit-execution-binding-v1',
    childId: childOrderId,
    attemptId: submitAttemptId,
    accountId: ownerId,
    sessionBindingDigest: digest('session', stableJson({
      accountId: session.accountId, username: session.username, baseUrl: session.baseUrl,
      uid: session.uid, protocolVersion: session.protocolVersion,
      protocolVersionEvidence: session.protocolVersionEvidence,
    })),
    eventIdentityDigest: digest('event', stableJson({
      provider: currentIdentity.provider,
      gid: currentIdentity.gid,
      mode: currentIdentity.mode,
    })),
    selectionIdentityDigest: digest('selection', stableJson(currentIdentity)),
    orderIdDigest,
    submittedAt,
    requestDigest: digest('request', stableJson({
      session: { accountId: session.accountId, uid: session.uid, protocolVersion: session.protocolVersion },
      wireFields,
    }), 'global'),
    responseDigest: digest('response', String(response?.text || '')),
  },
}
```

binding-scoped digest 必须闭包到当前 `childOrderId/submitAttemptId`；global order/request digest 明确不得包含这两个局部 ID。增加负例：两个不同 attempt 使用同一 raw provider order reference 或同一 account/session+canonical wire 时，global digest 必须相等，campaign 以 duplicate 停止；不同 canonical request 必须不同。日志不输出 digest material 或 raw values。

同时给现有 `sealCrownProviderReference()` 增加唯一对称接口；必须复用完全相同的 AAD，context 不匹配时解密失败：

```js
openCrownProviderReference(ciphertext, { childOrderId, submitAttemptId } = {}) {
  const child = String(childOrderId || '').trim()
  const attempt = String(submitAttemptId || '').trim()
  if (!ciphertext || !child || !attempt) throw new Error('provider-reference-context')
  return decryptSecret(ciphertext, {
    ...secretOptions,
    context: {
      purpose: 'crown-provider-reference',
      childOrderId: child,
      submitAttemptId: attempt,
    },
  })
}
```

该方法只供阶段 3A 在内存中取得 exact provider reference；不得把明文返回给 Dashboard、CLI、safe artifact 或日志。测试必须证明正确 child/attempt 可解密，任一 context 漂移均失败，错误对象和日志不包含 ciphertext 或明文。

- [ ] **Step 7: Make accepted + binding one transaction**

`recordSubmitDispatch()` 返回 ledger `dispatchedAt`，`onNetworkStarted()` 把这个值返回给 Provider。B2 仅对 canonical Crown capability 强制 binding；fake/simulated tests 保持原合同。canonical accepted 缺 binding、字段漂移、submittedAt 不等于 ledger、attempt/child/global order/global request collision 或 insert 冲突时，将 outcome 改为 `unknown`，随后沿既有 unknown 路径保锁。binding collision 查询、insert 和 attempt/child/batch settlement 必须位于同一个 `BEGIN IMMEDIATE` 事务内；取得 write lock 后先查 unique/collision，再 insert，避免 check/insert race。

```js
const onNetworkStarted = () => {
  if (dispatched) throw new Error('provider-network-started-twice')
  const dispatchResult = dispatch(this.database, {
    ...gate,
    submitAttemptId: input.submitAttemptId,
  }, this.options)
  dispatched = true
  return dispatchResult.attempt.dispatchedAt
}
```

```js
const canonical = String(attempt.capability_version).startsWith('crown-protocol-capabilities-v2:')
let effectiveKind = kind
let binding = null
if (canonical && kind === 'accepted') {
  try {
    binding = normalizeCrownSubmitExecutionBinding(input.outcome.executionBinding, {
      childId: row.child_order_id,
      attemptId: submitAttemptId,
      accountId: row.account_id,
      submittedAt: attempt.dispatched_at,
    })
    const collision = findCrownSubmitExecutionBindingCollision(db, binding)
    if (collision) throw new Error('submit-execution-binding-collision')
    try {
      insertCrownSubmitExecutionBinding(db, binding)
    } catch {
      throw new Error('submit-execution-binding-insert')
    }
  } catch {
    effectiveKind = 'submit-execution-binding-invalid'
  }
}
const standard = ledgerOutcome(effectiveKind)
```

`findCrownSubmitExecutionBindingCollision()` 必须检查 attempt、child、global `orderIdDigest` 和 global `requestDigest`；任何既有行都视为 collision，当前 settlement 不能复用它。SQLite `INSERT` 的 ABORT 只回滚该 statement；catch 后 transaction 必须继续执行 unknown settlement 并保锁。`ledgerOutcome(effectiveKind)` 已把 accepted/rejected 之外的结果映射为 unknown，因此 `submit-execution-binding-invalid` 不引入新恢复分支。只有 insert 已成功时才能执行 accepted updates；若后续 accepted update 失败，整个 transaction 回滚，binding 也随之回滚。

- [ ] **Step 8: Prove binding failures never create accepted ledger rows**

新增测试覆盖：缺 binding、session digest 改变、event/selection digest 对调、order digest 缺失、submittedAt 漂移、不同 attempt 的相同 global request/order、pre-query collision、强制 SQLite insert constraint error。每个 case 必须得到 `unknown`、账号锁状态 `unknown`、accepted amount 不增加、当前 attempt 无 binding、没有第二次 provider call；尤其要证明 insert error 被 catch 后 transaction 确实提交 unknown，而不是遗留 `submit_dispatched`。

Run:

```powershell
node --test --test-concurrency=1 tests/crown-app-secret.test.mjs tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-submit-execution-binding.test.mjs
```

Expected: PASS; 0 failed. 另断言 `verifyCrownCapabilityMatrix()` 仍为 Preview/Submit/Reconciliation `1/1/0`。

- [ ] **Step 9: Commit implementation**

```powershell
git add src/crown/app/app-secret.mjs src/crown/app/app-db.mjs src/crown/app/app-repository.mjs src/crown/app/runtime-cache-cleanup.mjs src/crown/betting/real-betting-runtime.mjs src/crown/betting/submit-execution-binding.mjs src/crown/betting/crown-account-execution-provider.mjs src/crown/betting/b2-executor.mjs tests/crown-app-secret.test.mjs tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-submit-execution-binding.test.mjs
git diff --cached --check
git commit -m "feat: persist immutable crown submit bindings"
```

**3A handoff contract:** Reconciliation 启用前必须按以下固定顺序消费本阶段产物：

1. 以 `attemptId` 同时读取 attempt/child 与 `getCrownSubmitExecutionBinding(db, attemptId)`，校验 binding 的 child、attempt、account、`submittedAt` 与账本逐项相等。
2. 只从同一 attempt 的 `provider_reference_ciphertext` 调用 `openCrownProviderReference(ciphertext, { childOrderId, submitAttemptId })`；明文 reference 仅存在于单次调用内存。
3. 查询前用 global `order-id` domain 对明文重算 digest，必须等于 immutable `orderIdDigest`；只有通过后，才把**明文 reference**作为 Provider reconciliation 查询参数。digest 只用于比较，严禁当查询参数。
4. 查询结果返回的 exact reference 再按同一 global domain 比对 `orderIdDigest`，随后才允许进入阶段 3A 的 accepted/rejected/unknown 状态机。
5. binding/ciphertext 缺失、context 解密失败、任一字段或 digest 不匹配时，reconciliation 网络请求数必须为 `0`，原 unknown/锁保持不变；不得 Submit、猜测 reference、改用余额或页面结果。

---

### Task 2: Define the controlled-live acceptance contract

**Files:**
- Create: `src/crown/betting/controlled-live-acceptance.mjs`
- Create: `tests/crown-controlled-live-acceptance.test.mjs`

**Interfaces:**
- Consumes: safe snapshot shaped by Task 3 and `getCrownSubmitExecutionBinding()`。
- Produces: `acceptanceStage(ordinal)`、`createControlledLiveAuthorizationBinding(rows, key)`、`assertControlledLiveAuthorizationBinding(saved, rows, key)`、`evaluateAcceptanceBaseline(snapshot, options)`、`evaluateAcceptedBatch(before, after, options)`、`summarizeAcceptanceCampaign(reports)`。

- [ ] **Step 1: Write authorization and sequence RED tests**

```js
test('standing authorization cannot be widened', () => {
  assert.deepEqual(CONTROLLED_LIVE_AUTHORIZATION, {
    schemaVersion: 'crown-controlled-live-authorization-v1',
    authorizationKind: 'standing',
    accountScope: 'existing-non-deposit-withdrawal-virtual-cny',
    capabilityKey: 'prematch|full_time|asian_handicap|main',
    ratioField: 'RATIO_R',
    maxChildAmountMinor: 50,
    maxChildrenPerBatch: 2,
    maxBatchAmountMinor: 100,
    maxAcceptedBatches: 5,
    maxAcceptedAmountMinor: 500,
  })
  assert.deepEqual([1, 2, 3, 4, 5].map(acceptanceStage).map((item) => item.childAmountsMinor), [
    [50], [50, 50], [50, 50], [50, 50], [50, 50],
  ])
})

test('unknown duplicate or drift stops the campaign', () => {
  for (const patch of [
    { ledger: { unknownCount: 1 } },
    { batch: { duplicateAttemptCount: 1 } },
    { batch: { driftCodes: ['crown-submit-session-owner'] } },
  ]) {
    const result = evaluateAcceptedBatch(before(1), after(1, patch), { ordinal: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.stopCampaign, true)
  }
})

test('private authorization binding rejects account nature and cap drift', () => {
  const saved = createControlledLiveAuthorizationBinding(accounts(), campaignKey)
  assert.doesNotThrow(() => assertControlledLiveAuthorizationBinding(saved, accounts(), campaignKey))
  for (const changed of [
    { ...saved, fundingKind: 'real-money' },
    { ...saved, depositsAllowed: true },
    { ...saved, withdrawalsAllowed: true },
    { ...saved, limits: { ...saved.limits, maxAcceptedAmountMinor: 501 } },
  ]) assert.throws(
    () => assertControlledLiveAuthorizationBinding(changed, accounts(), campaignKey),
    /controlled-live-authorization-binding/,
  )
  assert.throws(
    () => assertControlledLiveAuthorizationBinding(saved, accounts({ secondId: 'replacement' }), campaignKey),
    /controlled-live-authorization-binding/,
  )
})
```

- [ ] **Step 2: Run RED**

```powershell
node --test --test-concurrency=1 tests/crown-controlled-live-acceptance.test.mjs
```

Expected: FAIL because acceptance contract module 尚不存在。

- [ ] **Step 3: Implement the fixed sequence and baseline**

```js
export const CONTROLLED_LIVE_AUTHORIZATION = Object.freeze({
  schemaVersion: 'crown-controlled-live-authorization-v1',
  authorizationKind: 'standing',
  accountScope: 'existing-non-deposit-withdrawal-virtual-cny',
  capabilityKey: 'prematch|full_time|asian_handicap|main',
  ratioField: 'RATIO_R',
  maxChildAmountMinor: 50,
  maxChildrenPerBatch: 2,
  maxBatchAmountMinor: 100,
  maxAcceptedBatches: 5,
  maxAcceptedAmountMinor: 500,
})

const SEQUENCE = Object.freeze([
  { ordinal: 1, name: 'single-child-smoke', targetAmountMinor: 50, childAmountsMinor: [50] },
  ...[2, 3, 4, 5].map((ordinal) => ({
    ordinal, name: ordinal === 2 ? 'two-account-allocation' : 'stability',
    targetAmountMinor: 100, childAmountsMinor: [50, 50],
  })),
].map(Object.freeze))

export function acceptanceStage(ordinal) {
  const stage = SEQUENCE.find((item) => item.ordinal === Number(ordinal))
  if (!stage) throw new Error('controlled-live-ordinal')
  return structuredClone(stage)
}

// create/assertControlledLiveAuthorizationBinding are implemented in this module too.
// source, funding kind, deposit/withdrawal flags and limits are constants, not arguments.

export function evaluateAcceptanceBaseline(snapshot, { ordinal, authorizedAccountBindings }) {
  const stage = acceptanceStage(ordinal)
  const reasons = []
  const expect = (condition, code) => { if (!condition) reasons.push(code) }
  expect(snapshot.runtime?.requested === false && snapshot.runtime?.state === 'off', 'runtime-not-off')
  expect(snapshot.watcher?.active === false, 'watcher-not-frozen')
  expect(snapshot.capability?.key === CONTROLLED_LIVE_AUTHORIZATION.capabilityKey, 'capability-key')
  expect(snapshot.capability?.previewAllowed === true && snapshot.capability?.submitAllowed === true, 'capability-closed')
  expect(snapshot.capability?.reconciliationAllowed === false, 'reconciliation-unexpectedly-open')
  expect(snapshot.capability?.matrixVerified === true, 'capability-matrix-unverified')
  expect(snapshot.preflight?.length === 6 && snapshot.preflight.every((item) => item.ready === true), 'preflight-not-ready')
  expect(snapshot.authorization?.bindingValid === true
    && snapshot.authorization?.source === 'user-standing-authorization-2026-07-14'
    && snapshot.authorization?.fundingKind === 'virtual-balance-only'
    && snapshot.authorization?.depositsAllowed === false
    && snapshot.authorization?.withdrawalsAllowed === false, 'authorization-binding')
  expect(snapshot.queue?.eligiblePendingCount === 1, 'eligible-pending-count')
  expect(snapshot.queue?.otherOpenCount === 0, 'other-open-inbox')
  expect(snapshot.queue?.ratioField === 'RATIO_R' && snapshot.queue?.lineVariant === 'main', 'candidate-not-exact')
  expect(snapshot.card?.enabledCount === 1, 'enabled-card-count')
  expect(snapshot.card?.enabled === true && snapshot.card?.targetAmountMinor === stage.targetAmountMinor, 'card-target')
  expect(snapshot.card?.currency === 'CNY' && snapshot.card?.amountScale === 0, 'card-money')
  expect(authorizedAccountBindings?.length === 2, 'authorized-account-count')
  expect(JSON.stringify(snapshot.accounts?.map((item) => item.binding))
    === JSON.stringify(authorizedAccountBindings), 'account-set-drift')
  expect(snapshot.accounts?.every((item) => item.currency === 'CNY' && item.amountScale === 0
    && item.perBetLimitMinor === 50 && item.enabled === true), 'account-contract')
  expect(snapshot.ledger?.activeBatchCount === 0, 'active-batch')
  expect(snapshot.ledger?.unknownCount === 0, 'unknown-present')
  expect(snapshot.ledger?.openAttemptCount === 0, 'open-attempt')
  expect(snapshot.ledger?.accountLockCount === 0, 'account-lock')
  const expectedAcceptedBefore = [0, 0, 50, 150, 250, 350][stage.ordinal]
  expect(snapshot.campaign?.acceptedBatchCount === stage.ordinal - 1, 'accepted-sequence-position')
  expect(snapshot.campaign?.acceptedAmountMinor === expectedAcceptedBefore, 'accepted-sequence-amount')
  return { ok: reasons.length === 0, stopCampaign: reasons.length > 0, stage, reasons }
}
```

`createControlledLiveAuthorizationBinding()` 只接受恰好两个已启用、未归档、allocation enabled、`currency=CNY`、`amountScale=0`、`bet_order=1,2`、`perBetLimitMinor=50` 的现有账号；`source/fundingKind/depositsAllowed/withdrawalsAllowed/limits` 全部由模块常量写入，不接受调用方覆盖。对 canonical document（不含末尾 `binding`）做 campaign-key HMAC。`assertControlledLiveAuthorizationBinding()` 使用 constant-time comparison，并以当前 DB rows 重建完整 document；账号替换、调序、状态、币种、scale、limit、授权性质或 limit 任何漂移都抛 `controlled-live-authorization-binding`。

- [ ] **Step 4: Implement batch and campaign audit**

`evaluateAcceptedBatch` 必须逐项检查：一个新 batch、completed、target/accepted 相等、unknown/unfilled 为 0、child 金额数组精确、账号顺序精确、每 child accepted、`attemptOrdinal=1`、`dispatchCount=1`、binding 存在且 IDs/`submittedAt` 与 ledger 一致、六个 digest 唯一、无 drift code。`summarizeAcceptanceCampaign` 只接受 ordinals 1–5 各一次并计算 `450 CNY`。

```js
export function summarizeAcceptanceCampaign(reports) {
  const ordered = [...reports].sort((a, b) => a.ordinal - b.ordinal)
  const reasons = []
  if (ordered.length !== 5 || ordered.some((item, index) => item.ordinal !== index + 1 || item.ok !== true)) {
    reasons.push('accepted-sequence-incomplete')
  }
  const acceptedMinor = ordered.reduce((sum, item) => sum + Number(item.acceptedAmountMinor || 0), 0)
  if (acceptedMinor !== 450 || acceptedMinor > CONTROLLED_LIVE_AUTHORIZATION.maxAcceptedAmountMinor) {
    reasons.push('accepted-total')
  }
  const requestDigests = ordered.flatMap((item) => item.requestDigests || [])
  const orderDigests = ordered.flatMap((item) => item.orderDigests || [])
  if (new Set(requestDigests).size !== requestDigests.length) reasons.push('duplicate-request-digest')
  if (new Set(orderDigests).size !== orderDigests.length) reasons.push('duplicate-order-digest')
  return {
    ok: reasons.length === 0,
    acceptedBatches: ordered.length,
    acceptedAmountMinor: acceptedMinor,
    reconciliationCapability: 0,
    reasons,
  }
}
```

- [ ] **Step 5: Run focused tests**

```powershell
node --test --test-concurrency=1 tests/crown-submit-execution-binding.test.mjs tests/crown-controlled-live-acceptance.test.mjs
```

Expected: PASS; 0 failed。

- [ ] **Step 6: Commit contract**

```powershell
git add src/crown/betting/controlled-live-acceptance.mjs tests/crown-controlled-live-acceptance.test.mjs
git diff --cached --check
git commit -m "test: define controlled live acceptance limits"
```

---

### Task 3: Build the atomic acceptance permit guard and audit CLI

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/runtime-cache-cleanup.mjs`
- Create: `src/crown/betting/capability-acceptance-gate.mjs`
- Modify: `src/crown/betting/real-betting-runtime.mjs`
- Modify: `src/crown/betting/real-worker-factory.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `scripts/crown-betting-protocol-capture.mjs`
- Create: `scripts/crown-controlled-live-acceptance.mjs`
- Modify: `package.json:9-30`
- Modify: `tests/crown-app-db.test.mjs`
- Modify: `tests/crown-runtime-cache-cleanup.test.mjs`
- Modify: `tests/crown-real-betting-runtime.test.mjs`
- Modify: `tests/crown-betting-b2-executor.test.mjs`
- Modify: `tests/crown-account-provider.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Create: `tests/crown-betting-protocol-capture.test.mjs`
- Modify: `tests/crown-controlled-live-acceptance.test.mjs`

**Interfaces:**
- Consumes: `CONTROLLED_LIVE_AUTHORIZATION`、`collectRealBettingPreflight()`、`verifyCrownCapabilityMatrix()`、query-only audit SQLite、narrow permit-store SQLite、loopback GET `/api/app/operations-summary` 和 `/api/app/real-betting-status`。
- Produces commands: `init`、`peek --ordinal 1..5`、`freeze --ordinal 1..5`、`observe --ordinal 1..5`、`verify --ordinal 1..5`、`close`。
- Writes only: `data/runtime/controlled-live-acceptance/current/`、`controlled_live_acceptance_campaigns/permits/claims` 三张窄表和成功后的两份 `.superpowers/sdd/evidence/` safe artifact；不能直接写 batch/child/attempt/outcome/lock。

- [ ] **Step 1: Write CLI safety RED tests**

```js
test('audit database handle is query-only', () => {
  const db = openAcceptanceDatabase(fixturePath)
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1)
  assert.throws(() => db.exec('CREATE TABLE forbidden_write(id TEXT)'), /readonly|read-only/i)
  db.close()
})

test('operations client only performs loopback GET', async () => {
  const calls = []
  await readLoopbackState({
    fetchImpl: async (url, options) => {
      calls.push([url, options])
      return { ok: true, json: async () => ({ item: {} }) }
    },
  })
  assert.deepEqual(calls.map(([url, options]) => [new URL(url).pathname, options.method]), [
    ['/api/app/operations-summary', 'GET'],
    ['/api/app/real-betting-status', 'GET'],
  ])
})

test('safe artifact rejects raw identifiers and paths', () => {
  assert.throws(() => assertSafeAcceptanceArtifact({ accountId: 'account-a' }), /unsafe-acceptance-artifact/)
  assert.throws(() => assertSafeAcceptanceArtifact({ file: 'C:\\private\\crown.sqlite' }), /unsafe-acceptance-artifact/)
})

test('dashboard api b2 provider and capture cannot bypass a missing or exhausted permit', async () => {
  const calls = { preview: 0, provider: 0, networkStarted: 0, ftBet: 0 }
  await assertSubmitSurfacesBlocked({ state: 'required-but-not-frozen', calls })
  await assertSubmitSurfacesBlocked({ state: 'exhausted-5-of-5', calls })
  await assertSubmitSurfacesBlocked({ state: 'report-only-residue', calls })
  assert.deepEqual(calls, { preview: 0, provider: 0, networkStarted: 0, ftBet: 0 })
})

test('campaign overlay has one four-state classifier', async () => {
  assert.equal(classifyCampaignOverlay({ dbMarker: null, privateState: null, reportPresent: false }).state, 'not_applicable')
  assert.equal(classifyCampaignOverlay({ dbMarker: activeMarker, privateState: null, reportPresent: false }).state, 'campaign-binding-incomplete')
  assert.equal(classifyCampaignOverlay({ dbMarker: null, privateState: null, reportPresent: true }).state, 'campaign-binding-incomplete')
  assert.equal(classifyCampaignOverlay({ dbMarker: activeMarker, privateState: matchingState, reportPresent: false }).state, 'active')
  assert.equal(classifyCampaignOverlay({ dbMarker: activeMarker, privateState: matchingState, reportPresent: true }).state, 'campaign-binding-incomplete')
  assert.equal(classifyCampaignOverlay({ dbMarker: exhaustedMarker, privateState: matchingState, reportPresent: false }).state, 'exhausted')
})

test('fresh Portable install delegates to standard gates but grants no campaign authorization', async () => {
  const state = classifyCampaignOverlay({ dbMarker: null, privateState: null, reportPresent: false })
  assert.equal(state.state, 'not_applicable')
  assert.equal(state.authorized, false)
  assert.equal(await collectStandardRealBettingPreflight({ runtimeRequested: false }), 'off')
})

test('partial residue and exhausted state stay blocked across restart upgrade and cleanup', async () => {
  for (const fixture of [partialMarkerOnly, partialStateOnly, reportOnlyResidue, mismatchedPair, exhaustedAfterRestart, exhaustedAfterUpgrade]) {
    const calls = { preview: 0, provider: 0, networkStarted: 0, ftBet: 0 }
    await assertSubmitSurfacesBlocked({ state: fixture, calls })
    assert.deepEqual(calls, { preview: 0, provider: 0, networkStarted: 0, ftBet: 0 })
  }
})

test('each frozen child permit is atomically claimed once', async () => {
  const permit = freezePermit({ ordinal: 2, childAmountsMinor: [50, 50] })
  await Promise.allSettled([claimSameChild(permit), claimSameChild(permit)])
  assert.equal(readClaims(permit).length, 1)
  assert.equal(readClaims(permit)[0].amountMinor, 50)
})

test('protocol capture cannot spend controlled-live authorization', async () => {
  const result = await runCaptureWithFakeRoute([
    '--allow-real-submit', '--confirm', 'REAL_BET', '--max-stake', '50',
  ])
  assert.equal(result.error.code, 'controlled-live-canonical-worker-only')
  assert.equal(result.network.ftBet, 0)
})
```

- [ ] **Step 2: Run RED**

```powershell
node --test --test-concurrency=1 tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-protocol-capture.test.mjs
```

Expected: FAIL because CLI/permit tables/shared guard 尚不存在；所有 fake Crown/`FT_bet` 计数仍为 0。

- [ ] **Step 3: Implement strict argument parsing, query-only audit I/O and narrow permit schema**

CLI 固定默认值：

```js
const DEFAULTS = Object.freeze({
  dbPath: 'storage/crown.sqlite',
  runtimeRoot: 'data/runtime/controlled-live-acceptance/current',
  dashboardUrl: 'http://127.0.0.1:8787',
  readinessEvidence: '.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json',
})
```

`openAcceptanceDatabase()` 使用 `new DatabaseSync(path, { readOnly: true })`，立即执行 `PRAGMA query_only=ON`。`readLoopbackState()` 拒绝非 `http://127.0.0.1:8787` origin，固定 GET 两个 endpoint，不接受 method/body 覆盖。另建不导出 raw `db.exec` 的 `ControlledLivePermitStore`，只允许参数化执行下列固定操作：`initCampaign`、`freezePermit`、`claimChild`、`assertClaim`、`settlePermit`、`stopCampaign`；其他表名、SQL 或 caller-supplied field 一律拒绝。

`app-db.mjs` 新增三张正式私有表：

```sql
CREATE TABLE controlled_live_acceptance_campaigns (
  campaign_digest TEXT PRIMARY KEY,
  authorization_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('active','exhausted','stopped')),
  max_accepted_batches INTEGER NOT NULL CHECK (max_accepted_batches = 5),
  max_accepted_amount_minor INTEGER NOT NULL CHECK (max_accepted_amount_minor = 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE controlled_live_acceptance_permits (
  campaign_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 5),
  state TEXT NOT NULL CHECK (state IN ('frozen','claimed','settled','cancelled','stopped')),
  signal_digest TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  selection_digest TEXT NOT NULL,
  card_digest TEXT NOT NULL,
  max_children INTEGER NOT NULL CHECK (max_children IN (1,2)),
  max_amount_minor INTEGER NOT NULL CHECK (max_amount_minor IN (50,100)),
  claimed_children INTEGER NOT NULL DEFAULT 0,
  claimed_amount_minor INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  PRIMARY KEY (campaign_digest, ordinal),
  FOREIGN KEY (campaign_digest) REFERENCES controlled_live_acceptance_campaigns(campaign_digest)
);

CREATE TABLE controlled_live_acceptance_claims (
  submit_attempt_id TEXT PRIMARY KEY,
  campaign_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  child_order_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor = 50),
  claimed_at TEXT NOT NULL,
  FOREIGN KEY (campaign_digest, ordinal)
    REFERENCES controlled_live_acceptance_permits(campaign_digest, ordinal)
);
```

claims 必须 immutable；permit/campaign 只允许模块内带 fencing/expected-state 的 compare-and-swap UPDATE。三张表加入 schema preflight 和受控 cleanup FK 顺序，但 active/exhausted/stopped campaign 不能被普通“重试”、Dashboard reset、运行缓存清理或版本升级清除。测试证明 schema drift 阻断真实启动、普通 UPDATE/DELETE claim 失败、当前开发安装在 restart/upgrade/cleanup 后仍保持 active 或 terminal；只有无任何 campaign 材料的新 Portable 才分类为 `not_applicable`。

- [ ] **Step 4: Implement campaign state without raw IDs**

`init` 生成 32-byte random binding key 到 private runtime；state 只保存 `ControlledLiveAuthorizationBinding`、开始时间、baseline counts 和 standing limits，不保存 raw account ID、username/password/session/order。正式账号集合必须恰好等于初始化时的两个现有账号，并按 `bet_order=1,2` 固定。通过窄 store 在同一事务插入唯一 active campaign row，`campaign_digest/authorization_digest` 都来自 HMAC-bound document；已有 active/exhausted/stopped row 时拒绝新建，不能重置 5-batch 预算。所有后续命令在任何 loopback/Crown 动作前先调用 `assertControlledLiveAuthorizationBinding()`；CLI parser 对 `--account`、`--funding-kind`、`--allow-deposit`、`--allow-withdrawal`、`--max-*` 一律报 unknown option，不能通过命令行扩大授权。

```js
function campaignBinding(key, kind, value) {
  return `hmac-sha256:${createHmac('sha256', key).update(kind).update('\0').update(String(value)).digest('hex')}`
}

function accountSnapshot(rows, key) {
  return rows.map((row) => ({
    binding: campaignBinding(key, 'account', row.id),
    order: Number(row.bet_order),
    enabled: row.status === 'enabled' && row.archived === 0 && row.allocation_status === 'enabled',
    currency: row.currency,
    amountScale: Number(row.amount_scale),
    perBetLimitMinor: Number(row.per_bet_limit_minor),
  }))
}
```

随后用 `accountSnapshot(rows, key)` 的有序 binding 创建 private authorization document；state 落盘使用临时文件 + rename，文件权限仅当前用户。DB row 与 private document 的 HMAC 必须双向一致；只存在一方或任一漂移都分类为 `campaign-binding-incomplete` 并 fail closed。active 期间 completion report 不存在是预期状态；若 report 已存在则必须与 pair 匹配。`close` 只允许从 `exhausted` 生成 completion report，不改变 DB state；`stopped` 不能 close，且不存在独立 `closed` 状态。测试分别篡改 key、账号 binding/顺序、`fundingKind`、deposit/withdrawal flag 与任一上限，断言 `peek/freeze/observe/verify/close` 全部在读取网络前失败，fake fetch/Provider call count 均为 `0`。

- [ ] **Step 5: Implement exact candidate freeze**

`freeze` 必须读取 `auto_betting_signal_inbox + monitor_signals + monitor_selection_state`，只接受：

- inbox `pending|retry`，且只有 1 条；
- Signal `trigger.direction=up`；
- `mode=prematch`、`period=full_time`、`marketType=asian_handicap`；
- source/target market lineKey 为 `RATIO_R`；
- current selection `lineVariant=main`、`suspended=false`；
- Signal 未过期，odds 在不可变 card snapshot 区间；
- Watcher lease 已停止，runtime off；
- 无其他 open inbox、active batch、unknown、open attempt 或 lock。

`freeze` 把 signal/event/selection/card/version 写成 HMAC binding 和 safe facts；不更改 inbox 状态，但通过窄 store 在一个 `BEGIN IMMEDIATE` 事务中创建该 ordinal 唯一 `frozen` permit。permit 的 `max_children/max_amount_minor` 只能来自固定序列 `[1,50]`、`[2,100]`；同一 ordinal、另一个 open permit、已存在 active batch、已 accepted 5 个 batch或累计金额越界全部拒绝。

`peek` 复用同一 candidate 解析，但允许 Watcher 仍 active；它只回答当前是否恰好有一个 exact pending Signal。`peek` 通过后必须先从 Dashboard 停止 Watcher，再由 `freeze` 重新读取和完整核对，不能把 `peek` 结果当成启动许可。

- [ ] **Step 6: Wire the shared guard into every Submit-capable surface**

`capability-acceptance-gate.mjs` 提供 `classifyCampaignOverlay()`、`inspectAcceptanceState()`、`assertControlledLiveSubmitAllowed()`、`claimControlledLiveChildPermit()` 与 `assertControlledLiveAttemptClaim()`。普通 Worker/Provider 的 Submit guard 读取正式 DB marker、private HMAC binding state，并对模块内固定且不可覆盖的 completion report path 只做 `exists` sentinel 检查，绝不解析 report 内容或用其授权：三者全空返回 `not_applicable` 并继续产品原有标准门禁；report-only、其他 partial/mismatch、active 提前出现 report、active 无 exact permit、exhausted 或 stopped 均在 attempt/transport 前拒绝。terminal report 缺失不改变 exhausted/stopped 的拒绝结论，只会让阶段三只读审计证据不完整。当正式 DB 存在本次 campaign marker 时，调用方不能用参数、环境变量、HTTP body 或 CLI 新建 budget window；guard 每次重读 HMAC-bound private state、campaign/permit/claim、accepted batch/amount、unknown/lock/attempt 和 exact Signal/locked selection。

接线顺序固定为：

1. `collectRealBettingPreflight()` 与 `/real-betting/start` 在 campaign active 时要求恰好一个 `frozen` permit，且其 ordinal/Signal/card/capability/budget 与 DB 当前事实一致；不存在 permit、exhausted/stopped、unknown 或 drift 时不 spawn Worker，Preview/Submit 都为 0。
2. `real-worker-factory` 注入 guard；B2 在写 `submit_prepared` 的同一个 `BEGIN IMMEDIATE` 事务内原子 claim 当前 child。claim 校验 child `50`、batch 总额/child 数、account order、locked selection、attempt ordinal 1 和 permit digest；同 child/attempt 并发只允许一个成功，第二个在 Provider 前失败。
3. `CrownAccountExecutionProvider.submit()` 在 fresh Preview 后、`onNetworkStarted()` 与 `fetch(FT_bet)` 前重新读取 immutable claim，逐项核对 campaign/ordinal/child/attempt/account/amount；缺失或 drift 时 callback/transport 都为 0。Provider 只验证已 claim permit，不能自行 claim 或扩大金额。
4. `scripts/crown-betting-protocol-capture.mjs` 不得消费本次 standing authorization；即使传入 `--allow-real-submit --confirm REAL_BET --max-stake 50`，也必须在安装放行 route 前返回 `controlled-live-canonical-worker-only`，`FT_bet=0`。
5. accepted settlement 后 guard 直接按正式 ledger 计算 completed accepted batch count/amount。第五个 accepted batch 的 child/batch updates、execution binding 与 campaign `exhausted` 更新必须处于同一个 `BEGIN IMMEDIATE` settlement transaction；任一步失败整体回滚，不允许“accepted 已提交、exhausted 尚未提交”的崩溃窗口。即使 `verify/close` 尚未运行，再次 Dashboard/API、B2、Provider 或 capture 都为 0。

网络开始前取消的 claim 不能由 Worker 自动回收；只有 `verify` 能在证明 `onNetworkStarted/dispatchCount=0`、attempt 未 dispatched、Provider call 0 后把当前 permit 标为 `cancelled`。unknown、identity/session/fence drift、ledger conflict 和重复 digest 直接 `stopCampaign` 并保留 claim/锁，不能新 freeze。

- [ ] **Step 7: Implement running observation and post-batch verification**

`observe` 只在 runtime `running` 时成功，验证 worker/executor lease key/owner 不同、heartbeat fresh、fencing token 与 API preflight 匹配；记录 binding 和 token number，不记录 PID/owner raw value。后一个 ordinal 的 fence 必须不同于前一个窗口。

`verify` 只在 runtime 回到 `off`、Worker/Executor lease 已释放后运行。它把 freeze 后产生的唯一 batch 与 Signal binding/permit/claims 对上，读取 child、attempt 和 `bet_submit_execution_bindings`，交给 Task 2 的 pure evaluator；结果不通过时通过 compare-and-swap 把 campaign 标成 `stopped`，后续 `freeze` 必须拒绝。`verify` 不是预算门禁的唯一生效点：第五个 accepted batch 在正式 settlement 后已经由 guard 立即 exhausted。

- [ ] **Step 8: Add npm entry and safe close**

`package.json` 增加：

```json
"crown:betting:controlled-acceptance": "node scripts/crown-controlled-live-acceptance.mjs"
```

`close` 只在 5 份 verify 全绿、总额 `450`、runtime off、Watcher active/unique/fresh 时生成：

- `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.safe.json`
- `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.md`

safe artifact 只输出 campaign/batch/child/account/event/selection 的 HMAC binding；`providerReference` 只输出 `present: true`；`executionBinding` 的六个 digest 可原样输出。

- [ ] **Step 9: Run focused and safety tests**

```powershell
node --test --test-concurrency=1 tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-submit-execution-binding.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-protocol-capture.test.mjs tests/crown-betting-security-audit.test.mjs
node --check scripts/crown-controlled-live-acceptance.mjs
npm run check
```

Expected: all PASS；syntax exit 0；query-only audit fetch 只有两个 loopback GET；只有 init/freeze/claim/verify/stop 的窄表发生预期变化，下注业务表不能由 CLI 直接修改。fresh install/Portable 无三种材料时只返回 `not_applicable` 且标准 runtime 仍默认 off；DB-only、private-only、report-only、active+premature-report、其他 HMAC mismatch、campaign active 但未 freeze、并发重复 claim、restart/upgrade 后 5/5 exhausted 和 stopped 的 Dashboard/API/B2/Provider/capture 绕过测试全部 `FT_bet=0`；第五批 settlement fault injection 证明 accepted 与 exhausted 同进同退。

- [ ] **Step 10: Commit guard and CLI before any live window**

```powershell
git add src/crown/app/app-db.mjs src/crown/app/runtime-cache-cleanup.mjs src/crown/app/app-api.mjs src/crown/betting/capability-acceptance-gate.mjs src/crown/betting/controlled-live-acceptance.mjs src/crown/betting/real-betting-runtime.mjs src/crown/betting/real-worker-factory.mjs src/crown/betting/b2-executor.mjs src/crown/betting/crown-account-execution-provider.mjs scripts/crown-controlled-live-acceptance.mjs scripts/crown-betting-protocol-capture.mjs tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-protocol-capture.test.mjs package.json
git diff --cached --check
git commit -m "feat: enforce atomic controlled live submit permits"
```

---

### Task 4: Write and rehearse the fail-closed runbook

**Files:**
- Create: `docs/crown-controlled-live-acceptance-runbook.md`
- Modify: `tests/crown-controlled-live-acceptance.test.mjs`

**Interfaces:**
- Consumes: CLI commands from Task 3。
- Produces: one exact operational sequence; no alternative real-submit path。

- [ ] **Step 1: Write the runbook with fixed state transitions**

Runbook 必须包含以下状态机：

```text
real off + watcher running
  -> wait for one exact pending Signal
  -> stop watcher
  -> freeze audit passes
  -> Dashboard start + existing confirmation
  -> observe running leases/fences
  -> exactly one batch reaches terminal state
  -> Dashboard stop
  -> verify audit passes
  -> start watcher for the next ordinal
```

同时列出 standing authorization 数值、Tasks 6–8 的五个 exact ordinals、所有 hard stop、unknown 保锁、Dashboard stop 失败时停止整个 Dashboard managed process 且不得按进程名 kill。

- [ ] **Step 2: Add a documentation contract test**

测试扫描 runbook，要求包含：

```js
for (const required of [
  'standing authorization',
  'prematch/full_time/asian_handicap/main',
  'RATIO_R',
  '每个 child：50 CNY',
  '每个 batch：最多 100 CNY',
  '最多 5 个 accepted batch',
  '累计最多 500 CNY',
  'unknown 不重试、不转投、不自动解锁',
  'Dashboard',
  '不得调用 /real-betting/start',
]) assert.match(text, new RegExp(escapeRegExp(required)))
```

- [ ] **Step 3: Rehearse entirely offline**

用 temp SQLite、fake Provider 和 synthetic exact Signal 依次跑 `[50]`、四次 `[50,50]`；在 ordinal 3 注入 duplicate attempt，在 ordinal 4 注入 unknown，确认 CLI 将 campaign 标成 stopped。rehearsal 不读取正式 DB，不访问 loopback 以外网络。

Run:

```powershell
node --test --test-concurrency=1 tests/crown-controlled-live-acceptance.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-card-scoped-betting-integration.test.mjs
```

Expected: PASS；fake accepted 正常完成 5 个 batch；duplicate/unknown 两个负例均 fail-closed。

- [ ] **Step 4: Commit runbook**

```powershell
git add docs/crown-controlled-live-acceptance-runbook.md tests/crown-controlled-live-acceptance.test.mjs
git diff --cached --check
git commit -m "docs: add controlled live acceptance runbook"
```

---

### Task 5: Pass the offline production gate and initialize the campaign

**Files:**
- Read: `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json`
- Runtime create: `data/runtime/controlled-live-acceptance/current/`
- No source modification expected.

**Interfaces:**
- Consumes: phase-one green evidence and current formal DB read-only snapshot。
- Produces: active private campaign state with two authorized account bindings。

- [ ] **Step 1: Verify phase-one evidence**

固定检查：backend/frontend/syntax/build 全绿；runtime persisted-intent two-phase recovery tests 通过；production runtime off；`source.commit/tree` 存在且该 commit 是当前 HEAD 祖先；`generatedAt` 晚于该 source commit；`network.guardLoaded=true` 且 external/Preview/Submit/Reconciliation 四类请求计数全为 0；capability `1/1/0`。任一字段缺失或 source 不可追溯时停止。

- [ ] **Step 2: Run one fresh full offline verification**

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw 'controlled-acceptance-backend-tests-failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'controlled-acceptance-syntax-check-failed' }
npm --prefix frontend run test
if ($LASTEXITCODE -ne 0) { throw 'controlled-acceptance-frontend-tests-failed' }
npm --prefix frontend run build
if ($LASTEXITCODE -ne 0) { throw 'controlled-acceptance-frontend-build-failed' }
```

Expected: four commands exit 0。backend 必须保持 `--test-concurrency=1`。

- [ ] **Step 3: Verify exact capability authority**

```powershell
node --input-type=module -e "import {verifyCrownCapabilityMatrix} from './src/crown/betting/crown-capability-matrix.mjs'; const r=verifyCrownCapabilityMatrix(); console.log(JSON.stringify(r)); if(!r.ok||r.allowedPreviewCount!==1||r.allowedSubmitCount!==1||r.allowedReconciliationCount!==0) process.exit(1)"
```

Expected: `ok=true`、`rowCount=3`、Preview/Submit/Reconciliation `1/1/0`、`errors=[]`。当前基线 matrix version 为 `crown-protocol-capabilities-v2:4a0446002dbee242`；若实现期间 version 改变，先审计差异，不能直接继续 live。

- [ ] **Step 4: Initialize under standing authorization**

确保 Dashboard 显示真实投注 off，且没有 active batch/unknown/lock；然后运行：

```powershell
npm run crown:betting:controlled-acceptance -- init
```

Expected: `status=initialized`、正式 SQLite 中恰好一个 HMAC-bound active campaign marker、`authorizedAccounts=2`、`authorizationSource=user-standing-authorization-2026-07-14`、`fundingKind=virtual-balance-only`、`depositsAllowed=false`、`withdrawalsAllowed=false`、`maxAcceptedBatches=5`、`maxAcceptedAmountMinor=500`，并回显 phase-one evidence 的 source commit binding 与四类 network count 0。此刻尚无 frozen permit，Dashboard/API 启动必须返回 `controlled-live-permit-required` 且不 spawn Worker。输出不得包含 raw account IDs 或 private binding key。若账号不再是初始化绑定的当前两项、`bet_order` 不是 `1,2`、currency/scale/perBetLimit 不是 `CNY/0/50`，或 authorization document 不能重算一致，立即阻断且不得启动 Worker/Preview/Submit。

- [ ] **Step 5: Confirm no live action occurred**

重读 Operations 和 DB：runtime 仍 off、Betting Worker 0、batch/attempt 数量未增加、Crown 请求日志无新增。该任务不得启动 Watcher/Worker 或发送 Preview。

---

### Task 6: Execute ordinal 1 single-child smoke

**Files:**
- Runtime modify through Dashboard: one rule card target only。
- Runtime evidence: `data/runtime/controlled-live-acceptance/current/`
- No source modification expected.

**Interfaces:**
- Consumes: standing authorization and initialized campaign。
- Produces: completed batch ordinal 1 with exactly `[50]` and immutable binding。

- [ ] **Step 1: Prepare a 50 CNY card snapshot while real betting is off**

在 Dashboard 停止 Watcher，保持真实投注 off。只把唯一 enabled card 的 target amount 改为 `50 CNY`；不改赔率区间、联赛、方向或 capability。保存后确认 card version 增加，open inbox 为 0。

- [ ] **Step 2: Acquire one exact Signal and freeze it**

启动 Watcher，等待新的 exact prematch `RATIO_R` main Signal，并轮询：

```powershell
npm run crown:betting:controlled-acceptance -- peek --ordinal 1
```

`peek` 返回 `eligiblePendingCount=1` 后立即在 Dashboard 停止 Watcher，再运行：

```powershell
npm run crown:betting:controlled-acceptance -- freeze --ordinal 1
```

Expected: `ok=true`、target `50`、child plan `[50]`、runtime off、watcher frozen、other open 0；DB 中只有 ordinal 1 的唯一 `frozen` permit，绑定当前 Signal/card/selection，max child/amount 为 `1/50`。任何一项不符都不启动真实投注。

- [ ] **Step 3: Start only the canonical Worker**

在 Dashboard 点击“开启真实投注”并使用既有确认框；standing authorization 已覆盖本次操作，不再次询问用户。不得调用脚本或 HTTP POST 旁路。

- [ ] **Step 4: Observe running fence**

```powershell
npm run crown:betting:controlled-acceptance -- observe --ordinal 1
```

Expected: runtime running；worker/executor lease fresh、owner different、fence valid；candidate/batch binding 与 freeze 一致。

- [ ] **Step 5: Stop after the first terminal batch**

batch 达到 terminal 后立即在 Dashboard 停止真实投注。若 outcome 为 unknown、dispatch 后非 accepted、identity/session/fence drift 或页面与本地不一致，停止 campaign，不执行下面 verify 的成功路径。

- [ ] **Step 6: Verify smoke**

```powershell
npm run crown:betting:controlled-acceptance -- verify --ordinal 1
```

Expected: one completed batch、target/accepted `50/50`、一个 child、一个 attempt、一次 dispatch、一个 immutable binding、unknown 0、lock 0、runtime off。

---

### Task 7: Execute ordinal 2 two-account `[50,50]`

**Files:**
- Runtime modify through Dashboard: one rule card target only。
- Runtime evidence: `data/runtime/controlled-live-acceptance/current/`
- No source modification expected.

**Interfaces:**
- Consumes: ordinal 1 green report and two bound accounts。
- Produces: completed batch ordinal 2 with ordered child amounts `[50,50]`。

- [ ] **Step 1: Restore target to 100 CNY**

Watcher 和 real 都保持 off；只把同一 card target 改为 `100 CNY`。确认两个 authorized account 仍按 bet order `1,2` enabled，`perBetLimit=50`。

- [ ] **Step 2: Freeze exactly one new candidate**

启动 Watcher 等待新 exact Signal，先运行：

```powershell
npm run crown:betting:controlled-acceptance -- peek --ordinal 2
```

只有它返回唯一 exact candidate 才停止 Watcher并运行：

```powershell
npm run crown:betting:controlled-acceptance -- freeze --ordinal 2
```

Expected: `ok=true`、target `100`、计划 `[50,50]`、ordinal 1 accepted total `50`。

- [ ] **Step 3: Run one canonical window**

从 Dashboard 开启；随后：

```powershell
npm run crown:betting:controlled-acceptance -- observe --ordinal 2
```

batch terminal 后立即从 Dashboard 停止。

- [ ] **Step 4: Verify account order and binding**

```powershell
npm run crown:betting:controlled-acceptance -- verify --ordinal 2
```

Expected: completed、accepted `100`、两个不同 account binding 按 `1,2`、child `[50,50]`、每 child 一个 attempt/binding、campaign accepted total `150`。第二窗口的 worker/executor fence binding 必须与 ordinal 1 不同。

---

### Task 8: Complete ordinals 3–5 one isolated batch at a time

**Files:**
- Runtime evidence: `data/runtime/controlled-live-acceptance/current/`
- No source modification expected.

**Interfaces:**
- Consumes: first two green reports。
- Produces: three additional completed `[50,50]` batches；campaign total five batches / 450 CNY。

- [ ] **Step 1: Execute ordinal 3**

重复“real off → Watcher running 等 exact Signal → peek → Watcher stop → freeze → Dashboard start → observe → terminal → Dashboard stop → verify”，使用：

```powershell
npm run crown:betting:controlled-acceptance -- peek --ordinal 3
npm run crown:betting:controlled-acceptance -- freeze --ordinal 3
npm run crown:betting:controlled-acceptance -- observe --ordinal 3
npm run crown:betting:controlled-acceptance -- verify --ordinal 3
```

Expected after verify: accepted batches 3、accepted amount `250`、unknown/duplicate/lock 0。

- [ ] **Step 2: Execute ordinal 4**

```powershell
npm run crown:betting:controlled-acceptance -- peek --ordinal 4
npm run crown:betting:controlled-acceptance -- freeze --ordinal 4
npm run crown:betting:controlled-acceptance -- observe --ordinal 4
npm run crown:betting:controlled-acceptance -- verify --ordinal 4
```

Expected after verify: accepted batches 4、accepted amount `350`、new worker/executor fence、unknown/duplicate/lock 0。

- [ ] **Step 3: Execute ordinal 5**

```powershell
npm run crown:betting:controlled-acceptance -- peek --ordinal 5
npm run crown:betting:controlled-acceptance -- freeze --ordinal 5
npm run crown:betting:controlled-acceptance -- observe --ordinal 5
npm run crown:betting:controlled-acceptance -- verify --ordinal 5
```

Expected after verify: accepted batches 5、accepted amount `450`、child 总数 `9`（1 + 2×4）、attempt 总数 `9`、每个 child exactly once、unknown/duplicate/lock 0。

第五批 accepted settlement 提交时必须已经在同一事务把 campaign 置为 `exhausted`。`verify --ordinal 5` 只复核并记录，不负责事后补写 exhausted；在 verify 前后，Dashboard/API、直接 B2/Provider 与 capture 的 guard 状态都必须为 denied，且不会新建 batch/attempt 或 `FT_bet`。

- [ ] **Step 4: Prove the cap blocks ordinal 6**

```powershell
npm run crown:betting:controlled-acceptance -- freeze --ordinal 6
```

Expected: non-zero exit with `controlled-live-ordinal` or `standing-authorization-exhausted`；read-only guard 同时报告 `accepted=450/500 batches=5/5`。不得启动 Worker，不得产生第 6 个 batch；不得通过删除 permit/claim、清锁或重建 campaign 重置额度。

---

### Task 9: Close, redact, and publish the acceptance result

**Files:**
- Create from verified runtime facts: `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.safe.json`
- Create from verified runtime facts: `.superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.md`
- Modify after success: `docs/project-memory.md:1-40`
- Modify after success: `docs/module-index.md:1-25`
- Modify after success: `docs/modules/crown-betting-protocol.md:1-35`
- Modify after success: `README.md` current capability summary

**Interfaces:**
- Consumes: five green per-ordinal reports and immutable binding rows。
- Produces: safe phase-two completion evidence；does not change capability。

- [ ] **Step 1: Restore safe runtime state**

确认 real off/requested=false、Worker 0、Executor/Worker lease released。恢复 card 原本 `100 CNY` target；启动 Watcher 并确认 active/unique/fresh、consecutive failures 0。

- [ ] **Step 2: Close the campaign**

```powershell
npm run crown:betting:controlled-acceptance -- close
```

Expected summary:

```json
{
  "status": "passed",
  "acceptedBatches": 5,
  "acceptedChildren": 9,
  "acceptedAmountMinor": 450,
  "unknownCount": 0,
  "duplicateAttemptCount": 0,
  "capability": {
    "key": "prematch|full_time|asian_handicap|main",
    "preview": 1,
    "submit": 1,
    "reconciliation": 0
  },
  "runtime": {
    "realBetting": "off",
    "watcher": "active-unique-fresh"
  }
}
```

- [ ] **Step 3: Run secret/path safety scans**

```powershell
rg -n -i "password|cookie|authorization:|bearer|set-cookie|username|provider_reference_ciphertext|[A-Za-z]:\\\\|/Users/|/home/" .superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.safe.json .superpowers/sdd/evidence/crown-betting-controlled-live-acceptance.md
```

Expected: 0 matches。另由测试解析 JSON，确认没有 `accountId`、`childId`、`attemptId`、`orderId`、`uid`、`origin` 或 raw request/response key。

- [ ] **Step 4: Run final regression**

```powershell
node --test --test-concurrency=1 tests/crown-app-db.test.mjs tests/crown-runtime-cache-cleanup.test.mjs tests/crown-app-api.test.mjs tests/crown-submit-execution-binding.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-protocol-capture.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-real-betting-runtime.test.mjs
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: all commands exit 0。full backend 仍串行；matrix 仍 `1/1/0`。

- [ ] **Step 5: Update current-status documents**

只在 Task 9.4 全绿后写入：

- canonical Worker/B2 live acceptance `5/5` completed；
- child `9/9` direct accepted、累计 `450 CNY`；
- 5 份 frozen/settled permit、9 份 immutable child claim 与 9 份 execution binding 精确对应；
- 第五批 accepted 与 campaign `exhausted` 在同一 settlement transaction 提交；
- 5/5 后 Dashboard/API/B2/Provider/capture 所有旁路验证均为 `FT_bet=0`；
- duplicate/unknown/lock leak `0`；
- five fresh Worker/Executor start windows；
- immutable `crown-submit-execution-binding-v1` 已可供 3A 只读消费；
- Reconciliation 仍为 0，unknown 仍人工复核；
- 不写账号、比赛名称、完整注单 ID 或原始响应。

- [ ] **Step 6: Commit the accepted campaign evidence for the authorized final GitHub replacement**

```powershell
git add docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md README.md
git diff --cached --check
git commit -m "docs: record controlled crown live acceptance"
```

Expected: `.superpowers/sdd/evidence/` 下的 machine evidence 与详细报告继续由该目录现有 `.gitignore` 隔离，不用 `-f` 推送 GitHub；公开文档只记录脱敏计数、matrix 和本机 evidence 相对路径。

## Stop Report Contract

如果 campaign 被停止，`close` 必须拒绝生成 passed report，并生成 private stopped state；对用户只回报稳定原因：

| 原因 | 处理 |
|---|---|
| `unknown` | real off；保留账号/金额锁；禁止下一 ordinal；人工复核 |
| identity/session/fence drift | 不再发送；real off；保存脱敏 drift code |
| duplicate attempt/request/order digest | real off；按严重账本异常处理；不执行修复性 Submit |
| binding missing/mismatch | accepted 不成立，写 unknown 并保锁；3A 不可消费 |
| page/local mismatch | 以 SQLite + direct response contract 为准，停止并人工核对 |
| start/stop/API 失效 | 停止 Dashboard managed process；不得按进程名 kill；重启后不得自动恢复 campaign |
| account/capability scope change | standing authorization 立即失效；必须重新取得用户明确授权 |

达到停止条件后，不得通过每日完全重置、删除 attempt/binding、清锁、修改状态或扩大 capability 来“继续验收”。任何修复必须是独立 TDD 任务，完成完整离线回归后再由用户决定是否恢复 campaign。
