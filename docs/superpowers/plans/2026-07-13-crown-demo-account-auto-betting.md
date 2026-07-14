# 皇冠虚拟账号自动投注 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Watcher 的有效抓水 Signal 按规则卡转为可恢复、幂等的自动投注批次，严格按账号顺序使用不可充提的虚拟 CNY 余额账号执行 `FT_order_view`/单次 `FT_bet`，并实现 accepted/rejected/unknown 的正确锁与账本语义以及 Watcher 异常恢复。

**Architecture:** Signal、规则卡 inbox、batch、child order、B2 dispatch/outcome 和账号锁继续使用 SQLite 作为唯一事实源。每个账号在一个 batch 中最多使用一次，执行链严格串行：重锁当前盘口 → fresh login/balance → strict Preview → reserve → single Submit → 按明确结果决定是否继续下一个账号。真实协议按 exact market family fail-closed；只有脱敏 fixture 同时证明 Preview 金额语义、Submit 字段和 accepted/rejected/unknown 分类后，才能把对应 capability 从 0 打开。unknown 永久保留额度/账号锁，不自动 reconciliation、不重投。

**Tech Stack:** Node.js ESM 22.23.1、`node:test`、SQLite `node:sqlite`、React/Vite/Vitest、Crown HTTPS/XML protocol、现有 Watcher/B2 ledger/lease/fence 基础设施。

**Design source:** `docs/superpowers/specs/2026-07-13-crown-demo-account-auto-betting-design.md`

## 2026-07-13 实施状态

| 状态 | 内容 |
|---|---|
| 已完成 | Task 1–8 的当前开放盘口口径、Watcher 登录证明/有界恢复、canonical identity、fresh balance、持久账号使用约束、顺序分配与简化启动门；账号 `perBetLimit` 上限可手工修改，`50 CNY` 仅为测试值 |
| 已完成 | evidence gate 的 fail-closed 校验、单次 Submit attempt 与 unknown 恢复、fresh Preview 赔率冻结区间校验、`handicapRaw` 盘口身份，以及离线账本/故障路径实现 |
| 已完成 | Task 11–12 的完整回归、文档一致性和整体验收：backend `1286/1286`、frontend `137/137`、syntax check 与 production build 均通过 |
| Task 10 capability 已完成；Task 13 live 验收未完成 | Task 9 历史阶段取得一笔真实 accepted Preview/Submit；Task 10 已完成安全 account/session/execution binding 与 accepted-only 生产启用。当前只开放 exact row `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation 为 `1/1/0`；其他 row 与 Reconciliation 关闭，Task 13 canonical worker live 验收仍未完成，真实 runtime 默认 off |
| 真实网络结果 | 2026-07-14 在用户提交当刻确认下只发送 1 次 `FT_bet`：50 CNY、赔率 0.96，直接响应 HTTP 200 / code 560，页面与余额变化确认 accepted。该浏览器抓包不等同于 canonical worker/B2 验收 |

当前执行契约：账号按 `bet_order` 顺序使用；明确 `rejected` 后把 remaining 转给下一个未使用账号；`unknown` 保留金额与账号锁且不重试；Submit 网络请求开始后每个 child 最多一次提交。下方 checkbox 保留原始 TDD 分步记录，完成/阻塞判断以上表为准。

## Global Constraints

- 投注账号全部视为不可充提的虚拟余额账号；不实现充值、提现、真实资金结算或自动对账。
- 保留全局手工启动/停止；程序启动、更新/移动、每日 reset 和异常恢复都不得自行开启已手工关闭的自动投注。
- 不增加规则卡动态资格、独立预算面板或短期执行授权；旧表可保留历史兼容，但不得继续作为新链路的启动/Submit 门槛。
- 每个 child 的单笔上限来自该账号可手工修改的 `perBetLimit`，50 CNY 只是当前测试配置，不是代码硬上限；金额只使用整数 CNY；一个账号在一个 batch 中最多一个 child、一次 Submit。
- accepted：保存脱敏持久注单 ID，释放账号与金额锁，扣减 remaining；rejected：证明未创建注单后释放锁，同一 remaining 可交给下一个未用账号；unknown：保留锁并禁止重投。
- Preview 失败、余额失败、币种非 CNY、账号登录失败、盘口漂移、赔率越界或 exact capability 不足时跳过/阻断，绝不猜测字段或金额。
- 历史 Task 9 阶段的 fixture 当时只证明有限 Preview contract，尚未证明 `FT_bet` exact identity 和 accepted/rejected 语义，也未证明 `FT_order_view` 的 server stake step，因此当时 `submitAllowed` 保持 false。Task 10 已按 accepted-only 证据开放上述 exact row 的 `1/1/0`；未验证 row 继续保持 false。
- 当前工作区已有“`monitor_event_state.active=1` 即今日开放盘口”的用户改动，必须基于它继续，不得恢复北京时间日期过滤。
- 每项实现先写失败测试并观察预期 RED，再写最小实现；协议 fixture 不能由 synthetic 成功样例替代真实脱敏 evidence。
- 实施期间不自动提交；由用户决定最终提交边界。

---

## Task 1：接纳并锁定“今日比赛 = 当前开放盘口”前置语义

**Files:**

- Preserve/Review: `src/crown/betting/today-betting-leagues.mjs`
- Preserve/Review: `src/crown/app/app-repository.mjs`
- Preserve/Review: `tests/crown-today-betting-leagues.test.mjs`
- Preserve/Review: `docs/modules/crown-betting-protocol.md`
- Preserve/Review: `docs/module-index.md`
- Preserve/Review: `docs/project-memory.md`

- [ ] **Step 1: 检查现有用户 diff，不重写**

确认列表来自 `monitor_event_state.active=1`，排序和去重稳定，不依赖抓取日期或北京时间日期；规则卡和 Operations 使用同一开放盘口事实。

- [ ] **Step 2: 运行前置验证**

```powershell
node --test --test-concurrency=1 tests/crown-today-betting-leagues.test.mjs tests/crown-auto-betting-rule-card-repository.test.mjs tests/crown-app-repository.test.mjs
```

Expected: PASS。若失败，只修当前语义相关问题，不覆盖现有改动。

---

## Task 2：把受信 API 成功更新为 Watcher 登录证明

**Files:**

- Modify: `scripts/crown-watch.mjs`
- Modify: `src/crown/monitor/monitor-state-store.mjs`
- Modify: `tests/crown-monitor-state-store.test.mjs`
- Modify: `tests/crown-monitor-v2-integration.test.mjs`
- Modify: `tests/crown-watch-direct-api.test.mjs`（若仓库使用其他 direct API 测试名，则沿用现有文件）

- [ ] **Step 1: 写 RED 契约**

新增 repository 方法：

```js
recordTrustedLoginProof({ source, accountId, observedAt })
```

覆盖初次 login、成功 `chk_login`、通过 schema/身份校验的 `get_game_list` 都刷新 `last_login_result_at`；HTTP/XML/身份校验失败不刷新；新证明不得覆盖最近失败的详细诊断内容。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-monitor-state-store.test.mjs tests/crown-monitor-v2-integration.test.mjs
```

Expected: FAIL，因为成功拉盘尚不写登录证明。

- [ ] **Step 3: 最小实现并接入三条受信路径**

只在响应已通过 origin、session/account identity 和 XML schema 校验后记录证明；source 只允许 `login`、`chk_login`、`get_game_list`。

- [ ] **Step 4: 验证失败不刷新**

```powershell
node --test --test-concurrency=1 tests/crown-monitor-state-store.test.mjs tests/crown-monitor-v2-integration.test.mjs tests/crown-operations-summary.test.mjs
```

Expected: PASS。

---

## Task 3：实现 Watcher 退出诊断与 2/5/15 秒有界恢复

**Files:**

- Modify: `src/crown/app/monitor-process.mjs`
- Modify: `tests/crown-monitor-process.test.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`

- [ ] **Step 1: 写进程状态机 RED 测试**

用 fake clock/spawn 覆盖：

- 保存 `exitCode`、`signal`、`exitedAt`、有界脱敏 stderr 摘要；
- 第 1/2/3 次异常分别在 2/5/15 秒调度；
- 第 3 次恢复后的再次失败不再调度；
- 人工 stop、Dashboard shutdown、每日 reset、旧 generation exit 都不重启；
- 每次重启前重新验证 lease 和手工 desired state；
- 启动成功稳定运行后按规格定义的窗口清零连续失败次数。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-monitor-process.test.mjs tests/crown-operations-summary.test.mjs
```

Expected: FAIL，现有 controller 忽略 stderr 且没有 recovery scheduler。

- [ ] **Step 3: 实现 generation-aware controller**

controller 注入 `setTimeoutFn`/`clearTimeoutFn`/`now`，stderr 只保留固定字节上限并删除 cookie/token/password/path。状态输出固定包含 `desiredRunning`、`processState`、`lastExit`、`restartAttempt`、`nextRestartAt`。取消计时器必须幂等。

- [ ] **Step 4: 投影到 Operations 并验证**

```powershell
node --test --test-concurrency=1 tests/crown-monitor-process.test.mjs tests/crown-operations-summary.test.mjs tests/crown-app-api.test.mjs
npm --prefix frontend test -- --run src/pages/OperationsConsole.test.tsx
```

Expected: PASS；UI 明确区分 running、waiting-restart、stopped-after-retries、manually-stopped。

---

## Task 4：统一 canonical execution identity

**Files:**

- Modify: `src/crown/betting/execution-identity.mjs`
- Modify: `src/crown/betting/locked-selection.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: `src/crown/betting/crown-account-provider.mjs`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs`
- Modify: `src/crown/betting/crown-capability-matrix.mjs`
- Modify: 相关 identity/re-lock/provider/capability 测试

- [ ] **Step 1: 写 canonical identity RED 测试**

固定结构为：

```js
{
  eventId,
  sourceEventId,
  phase,        // prematch | live
  period,       // full_time | first_half
  market,       // asian_handicap | total
  lineVariant,  // main | a | b | c | d | e | f
  line,
  side,
  odds,
  snapshotVersion,
}
```

断言 capability key、re-lock、Preview 和 Submit 读取同一字段；缺 `lineVariant` 或任何 identity 漂移都 fail-closed；不得再读不存在的 `marketType`。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-execution-identity.test.mjs tests/crown-locked-selection.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-capability-matrix.test.mjs
```

Expected: FAIL，暴露 `market`/`marketType` 和 alternate line 不一致。

- [ ] **Step 3: 单点生成、全链透传**

只允许 normalized snapshot 明确生成 `lineVariant`，Provider 不从 ID 前缀或请求字段猜测。旧记录缺字段时只允许诊断，不允许 Submit。

- [ ] **Step 4: 验证**

该原始 TDD 步骤在当时运行上一步命令，Expected: PASS，所有 production capability 当时仍为 false；当前 capability 以上方实施状态表的 exact row `1/1/0` 为准。

---

## Task 5：实现 fresh CNY 整数余额执行接口

**Files:**

- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/betting/crown-account-provider.mjs`
- Modify: `tests/crown-api-login-manager.test.mjs`
- Modify: `tests/crown-app-repository.test.mjs`
- Modify: `tests/crown-account-provider.test.mjs`

- [ ] **Step 1: 写 fresh balance RED 测试**

新增执行接口：

```js
fetchFreshExecutionBalance({ accountId, expectedFence, signal })
// => { balanceCny, currency: 'CNY', observedAt, sessionProof }
```

约束：在当前账号 session 下重新获取 account summary；只接受币种严格 CNY、非负、无小数的整数余额；返回采集时间和不可复用的 session proof；缓存 `balance_minor`/`reportedBalance` 不得单独授权 Submit。登录失败、超时、币种未知、小数余额、负值、fence 变化均返回结构化 skip/error。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-api-login-manager.test.mjs tests/crown-app-repository.test.mjs tests/crown-account-provider.test.mjs
```

Expected: FAIL，因为执行链仍使用旧 `balanceMinor`。

- [ ] **Step 3: 实现并保持展示 DTO 向后兼容**

执行 DTO 不再把旧余额当可下注余额；fresh 结果只在当前 child 流程内使用，不写日志中的账号/session 明文。

- [ ] **Step 4: 验证边界**

运行上一步命令，Expected: PASS；网络/解析失败用例没有 reserve/Submit 调用。

---

## Task 6：把 batch/账号使用约束变为持久事实

**Files:**

- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/betting/bet-batch-store.mjs`
- Modify: `tests/crown-bet-batch-store.test.mjs`
- Modify: `tests/crown-app-db.test.mjs`

- [ ] **Step 1: 写账号一次性约束 RED 测试**

覆盖同一 `(batch_id, account_id)` 在不同 attempt/round 中第二次 reserve 也被拒绝；并发 claim 只能一个成功；事务回滚后不得留下幽灵锁；重启后仍能列出已用账号；旧数据库迁移幂等。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-app-db.test.mjs tests/crown-bet-batch-store.test.mjs
```

Expected: FAIL，当前唯一约束仍允许不同 attempt 重复账号。

- [ ] **Step 3: 增加 schema 迁移与 store API**

新增唯一持久约束或独立 `bet_batch_account_usage` 表；公开接口固定为：

```js
listUsedAccountIds(batchId)
reserveSingleAccountChild({ batchId, accountId, amountCny, executionIdentity, fence })
```

reserve、账号使用标记、额度锁、child 和 dispatch preparation 必须处于可证明的一致事务边界。

- [ ] **Step 4: 验证迁移与崩溃恢复**

运行上一步命令，Expected: PASS。

---

## Task 7：重写为严格串行账号分配状态机

**Files:**

- Modify: `src/crown/betting/stake-allocator.mjs`
- Modify: `src/crown/betting/multi-account-bet-coordinator.mjs`
- Modify: `tests/crown-stake-allocator.test.mjs`
- Modify: `tests/crown-multi-account-bet-coordinator.test.mjs`
- Modify: `tests/crown-card-scoped-betting-integration.test.mjs`

- [ ] **Step 1: 将冲突旧测试改为新规格 RED**

删除“并发 preview/submit”“rejected 不换账号”“账号跨 round 可重复”的旧期望，改为：

- 账号严格按 `bet_order`；任何时刻最多一个账号处于 login/Preview/Submit；
- fresh balance 失败或 Preview 失败跳过且不 reserve；
- `amount = min(remaining, account.perBetLimit, freshBalance, strictPreviewMax)`，并同时满足 strict server min/step；当前测试把 `perBetLimit` 设为 50 CNY，但实现必须支持用户手工修改后的值；
- 每账号每 batch 最多一次；
- accepted 后从 remaining 扣 child amount；
- rejected 解锁后 remaining 不变并继续下一个账号；
- unknown 保留 child/账号锁，该 child 金额不再分配，其他未锁 remaining 是否继续严格按设计规格的终止规则执行；
- 无可用账号时 batch 保存明确 `unfilledCny`；
- 重启、重复 Signal 和 lease 接管不产生第二次 Submit。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-stake-allocator.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-card-scoped-betting-integration.test.mjs
```

Expected: FAIL，因为当前实现批量 Preview、一次 reserve、并发 Submit。

- [ ] **Step 3: 实现单账号循环**

coordinator 每轮重新从 store 读取 batch/remaining/used accounts；依次执行 fresh balance、strict Preview、单 child reserve、B2 Submit、resolve，然后再决定是否读取下一个账号。不得用内存集合代替数据库事实。

- [ ] **Step 4: 验证结果矩阵和 exactly-once**

运行上一步命令，Expected: PASS；测试使用 fake Provider，不依赖真实网络。

---

## Task 8：简化虚拟账号启动门并解除 reconciliation 强绑定

**Files:**

- Modify: `src/crown/betting/auto-betting-consumer.mjs`
- Modify: `src/crown/betting/execution-gate.mjs`
- Modify: `src/crown/betting/real-betting-runtime.mjs`
- Modify: `src/crown/betting/real-worker-factory.mjs`
- Modify: `src/crown/betting/betting-worker.mjs`
- Modify: `src/crown/app/betting-process.mjs`
- Modify: `scripts/crown-betting-worker.mjs`
- Modify: 对应 consumer/runtime/worker/process tests

- [ ] **Step 1: 写新门槛 RED 测试**

启动和执行只要求：规则卡 enabled、全局 desired state 手工为 on、exact Preview/Submit capability、账号可用、lease/fence/账本/锁正常。断言以下内容不再是门槛：`realEligible`、active execution authorization、authorization child budget、`CROWN_REAL_MAX_TOTAL_MINOR`、reconciliation capability、reconciler lease。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-auto-betting-consumer.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-betting-process.test.mjs tests/crown-betting-worker.test.mjs
```

Expected: FAIL，因为旧 preflight 和三角色 lease 仍存在。

- [ ] **Step 3: 最小删除旧门槛**

ready ticket 只包含 worker + executor lease；worker 启动不自动调用 reconciler `runDue()`；unknown 继续由持久锁和 B2 outcome 防重。旧 authorization 数据只保留只读历史兼容，不能暗中影响新链路。

- [ ] **Step 4: 验证手工 off 与 unknown 安全边界**

运行上一步命令，Expected: PASS；全局 off、capability false 或 fence 变化仍 fail-closed。

---

## Task 9：建立真实协议 evidence gate 与 strict fixture contract

**Files:**

- Modify: `scripts/crown-betting-protocol-capture.mjs` 或仓库现有同职责 capture/analyzer
- Modify: 对应 capture/analyzer tests
- Modify: `src/crown/betting/crown-order-field-mapper.mjs`
- Modify: `src/crown/betting/crown-bet-response-parser.mjs`
- Modify: `tests/crown-order-field-mapper.test.mjs`
- Modify: `tests/crown-bet-response-parser.test.mjs`
- Modify: `tests/crown-capability-matrix.test.mjs`
- Create only from real sanitized capture: `data/fixtures/crown/betting-protocol/<exact-family>-preview-submit-verified.json`
- Modify only after fixture verification: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: 写“证据不足必须保持 0”测试**

fixture schema 必须绑定同一次 account/session、exact execution identity、Preview request/response、Submit request、accepted/rejected response、持久注单 ID，以及金额币种/min/max/step 的字段来源。缺一项、时间线不能绑定、只有后续状态观察、响应截断或 synthetic 样例都必须返回 `evidenceIncomplete`，capability 保持 false。

- [ ] **Step 2: 运行证据 gate 测试**

```powershell
node --test --test-concurrency=1 tests/crown-betting-protocol-capture.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-capability-matrix.test.mjs
```

该原始 TDD 步骤在新 capture 前的 Expected 为 PASS，并明确证明所有 production Submit capability 当时仍为 false。此处不是用失败测试强行打开 capability；当前 capability 以上方实施状态表的 exact row `1/1/0` 为准。

- [ ] **Step 3: 完成脱敏 capture 工具**

只输出 allowlist 字段；账号、cookie、token、session、完整 URL query 和原始 HTML/XML 不进入 public fixture。工具必须把 accepted response 与 exact submitted identity/amount 绑定；不能把 `20260709-110033` 的 candidate 状态观察升级为 verified。

- [ ] **Step 4: 获取最小 exact family 的真实证据**

先选择当前虚拟账号和 Watcher 实际可产生、风险最小的一种 exact family。执行前确认全局 worker 不会并发消费，使用单一幂等 key 和 ≤1 CNY（若服务端 minimum 更高则使用其明确 minimum，且不得超过当前账号 `perBetLimit`）完成一次受控 accepted capture，再通过明确无注单的业务条件取得 rejected 分类证据。若无法取得 server stake step 语义，该 family 不得启用。

- [ ] **Step 5: 复核 fixture 并更新协议文档**

由独立 reviewer 检查 public fixture 无 secret、时间线可绑定、金额字段含义明确。只有复核通过才进入 Task 10。

---

## Task 10：实现 strict `FT_order_view`/`FT_bet` Provider 并按 family 启用

**Files:**

- Modify: `src/crown/betting/crown-account-provider.mjs`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs`
- Modify: `src/crown/betting/crown-order-field-mapper.mjs`
- Modify: `src/crown/betting/crown-bet-response-parser.mjs`
- Modify: `src/crown/betting/crown-capability-matrix.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: 对应 provider/mapper/parser/capability/B2 tests

- [ ] **Step 1: 由 verified fixture 写 strict RED 测试**

Preview 必须回显并校验 exact identity、赔率、line、min/max/step；fresh account summary 提供 balance/currency，不把未证实的 `maxcredit` 当余额。Submit request field set 必须与 fixture 完全一致。parser 只允许：明确成功 + 持久注单 ID → accepted；明确证明未创建注单 → rejected；其他全部 unknown。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-account-provider.test.mjs tests/crown-account-execution-provider.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-capability-matrix.test.mjs
```

Expected: FAIL，当前 Submit transport 固定阻断且 legacy parser 过宽。

- [ ] **Step 3: 实现严格 transport/fence/outcome**

复用当前 login manager session；只允许 exact HTTPS origin，禁止跨 origin redirect；在首个网络字节前持久化 dispatch；所有异常、超时、截断、意外 code 均写 unknown；日志和 API 只保存脱敏 bet reference 摘要。

- [ ] **Step 4: 仅打开已验证 exact row**

把该 family 的 Preview/Submit 改为 true，reconciliation 保持 false；其他 prematch/live、period、market、alternate line 全部保持 false。

- [ ] **Step 5: 验证漂移 fail-closed**

运行上一步命令，Expected: PASS；逐字段 mutation tests 均阻止 Submit。

**Hard stop:** 没有 Task 9 的真实 verified fixture 时，本任务不得修改 `submitAllowed`，也不得把 legacy `buildCrownOrderFields()` 或 fabricated XML 当作生产合同。

---

## Task 11：补全 batch 历史和 Operations 投影

**Files:**

- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/pages/BettingAccounts.tsx`
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`
- Modify: `frontend/src/pages/BettingAccounts.test.tsx`

- [ ] **Step 1: 写投影 RED 测试**

历史记录包含 batch target/accepted/unknown/unfilled、每账号 child amount/outcome、脱敏 bet reference、最后更新时间；Operations 包含 Watcher login/odds/process/lease、最近退出、恢复次数。账号页明确 fresh 网站余额才用于即将发生的执行，不再把旧余额描述成执行事实。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-operations-summary.test.mjs tests/crown-app-api.test.mjs
npm --prefix frontend test -- --run src/pages/OperationsConsole.test.tsx src/pages/BettingAccounts.test.tsx
```

- [ ] **Step 3: 实现只读投影并验证**

API 不返回 cookie/session/raw response/完整账号或完整 bet ID。运行上一步命令，Expected: PASS。

---

## Task 12：端到端离线回归与恢复测试

- [ ] **Step 1: 协议与账号 focused**

```powershell
node --test --test-concurrency=1 tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-account-provider.test.mjs tests/crown-account-execution-provider.test.mjs tests/crown-api-login-manager.test.mjs
```

- [ ] **Step 2: 分配/账本/B2 focused**

```powershell
node --test --test-concurrency=1 tests/crown-stake-allocator.test.mjs tests/crown-bet-batch-store.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-card-scoped-betting-integration.test.mjs tests/crown-real-betting-runtime.test.mjs
```

- [ ] **Step 3: Watcher/worker focused**

```powershell
node --test --test-concurrency=1 tests/crown-monitor-process.test.mjs tests/crown-betting-process.test.mjs tests/crown-betting-worker.test.mjs tests/crown-monitor-v2-integration.test.mjs
```

- [ ] **Step 4: 故障矩阵**

在 fake Provider 下逐一注入 login timeout、balance parse error、Preview drift、Submit rejected、socket reset、response truncation、process crash、lease takeover 和重复 Signal；验证没有重复 Submit，unknown 锁在重启后仍存在，rejected 只转给未使用账号，accepted 总额不超过 target。

- [ ] **Step 5: 完整验证**

```powershell
npm test
npm run check
npm --prefix frontend test
npm --prefix frontend run build
```

正式发行前再用锁定 Node `22.23.1` 复跑 backend、launcher 和 release audit。

---

## Task 13：受控虚拟账号 live 验收

- [ ] **Step 1: live 前置检查**

只有以下全部为真才允许继续：exact family Preview/Submit capability 已由 verified fixture 开启；全量测试通过；所有账号确认不可充提且 CNY；全局 worker 当前 off；没有 active batch/unknown lock；Operations 可观察；stop 可立即生效。

- [ ] **Step 2: 单笔 smoke**

手工开启后只允许一个 exact family、一个 Signal、一个 child。验证网站返回的持久注单 ID 摘要与本地 B2 outcome/batch/锁一致；任何不一致立即手工停止，结果按 unknown 保锁。

- [ ] **Step 3: 连续 5 笔 accepted 验收**

在不扩大 capability family 的条件下等待真实 Signal，确认 5 个 accepted batch 都满足：当前盘口重锁、fresh CNY 余额、单账号金额不超过该账号当时的 `perBetLimit`（当前测试配置为 50 CNY）、账号顺序、每账号/batch 一次、accepted 总额不超过 target、没有重复 Submit。

- [ ] **Step 4: 记录可复用结论**

只把已验证的 exact family、fixture hash、运行/停止方式、失败恢复结论和测试结果写入项目文档；不记录账号、cookie、token、原始响应或完整 bet ID。

**Completion rule:** 若 Task 9 的真实 evidence 或 live 账号状态不满足条件，交付状态必须写为“离线实现完成、真实提交保持 fail-closed”，不能宣称自动投注已完整上线。
