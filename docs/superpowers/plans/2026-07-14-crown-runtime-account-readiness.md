# 皇冠投注账号现场可执行性与运行状态重算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除投注账号时间“新鲜度”作为全局真实投注门槛，并确保旧 `armed_waiting` 原因会被当前 preflight 结果替换；每笔下注继续依靠现场登录/账号信息/严格 Preview 证明可执行性。

**Architecture:** 保留当前 SQLite runtime 状态机和六项 preflight，不增加新服务、定时任务或配置。启动时把所有持久化 requested 状态重新置为 `armed_waiting/preflight-required`；运行 tick 对 `armed_waiting` 重新计算当前阻断原因。账号执行链继续使用 `ensureBettingSession()`、`fetchFreshExecutionBalance()` 和严格 `FT_order_view`，exact capability 仍是 Submit 前置条件。

**Tech Stack:** Node.js ESM、`node:test`、SQLite、React/Vitest（只做现有页面回归，不新增 UI）。

## Global Constraints

- 不读取 `access_checked_at`、`reported_balance_updated_at` 或账号检查年龄作为全局真实投注条件。
- 保留每账号可手工修改的 `perBetLimit`；`50 CNY` 只属于测试配置。
- 保留 exact Preview/Submit capability、目标盘口和赔率复核、CNY 整数金额、lease/fence、单次 Submit、`unknown` 不重投。
- 不新增账号投注总上限、定时账号检测、额外锁、配置项、页面或后台进程。
- 当前工作区包含用户和既有任务的未提交改动；本计划不自动提交 Git，只修改列出的文件。

---

### Task 1：用当前 preflight 替换旧账号新鲜度状态

**Files:**
- Modify: `tests/crown-real-betting-runtime.test.mjs`
- Modify: `src/crown/betting/real-betting-runtime.mjs`

**Interfaces:**
- Consumes: `getRealBettingStatus(database, { initialize, now })`、`refreshRealBettingRuntime(database, { checks, now })`、现有六字段 `READY` preflight。
- Produces: requested runtime 启动时总会回到 `armed_waiting/preflight-required`；tick 会把 `armed_waiting` 的旧 reason 更新为当前第一项阻断原因，但不会自行启动 worker。

- [ ] **Step 1: 写启动重置 RED 测试**

```js
test('startup clears a persisted legacy account freshness reason even when already armed', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    handle.db.prepare(`UPDATE real_betting_runtime
      SET requested=1,runtime_state='armed_waiting',reason_code='betting-account-login-not-fresh',updated_at='2026-07-13T00:00:00.000Z'
      WHERE singleton_id=1`).run()
    const status = getRealBettingStatus(handle.db, {
      initialize: true,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })
    assert.equal(status.state, 'armed_waiting')
    assert.equal(status.reasonCode, 'preflight-required')
    assert.equal(status.updatedAt, '2026-07-14T00:00:00.000Z')
  } finally { handle.close() }
})
```

- [ ] **Step 2: 写 tick 重算 RED 测试**

```js
test('armed tick replaces a legacy account freshness reason with the current preflight blocker', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    handle.db.prepare(`UPDATE real_betting_runtime
      SET requested=1,runtime_state='armed_waiting',reason_code='betting-account-balance-not-fresh',updated_at='2026-07-13T00:00:00.000Z'
      WHERE singleton_id=1`).run()
    const status = refreshRealBettingRuntime(handle.db, {
      checks: { ...READY, capabilityExact: false },
      now: () => new Date('2026-07-14T00:00:01.000Z'),
    })
    assert.equal(status.state, 'armed_waiting')
    assert.equal(status.reasonCode, 'capability-evidence-not-exact')
    assert.deepEqual(status.blockingReasons, ['capability-evidence-not-exact'])
  } finally { handle.close() }
})
```

- [ ] **Step 3: 运行测试并确认按预期失败**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs
```

Expected: 两个新增用例分别得到旧 `betting-account-*-not-fresh`，证明启动与 tick 都没有清除旧原因。

- [ ] **Step 4: 写最小 runtime 修复**

将 initialize 条件改为所有 requested 状态都重置：

```js
if (options.initialize === true && current.requested) {
```

在 running 失效处理后增加 `armed_waiting` 当前原因重算，仅当 reason 变化时写库：

```js
if (current.requested && current.state === 'armed_waiting') {
  const reasonCode = preflight.ready ? 'preflight-required' : preflight.reasonCode
  if (current.reasonCode !== reasonCode) {
    return statusWithPreflight(
      update(db, { requested: true, state: 'armed_waiting', reasonCode }, at(options)),
      evidence,
    )
  }
}
```

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs
```

Expected: 全部 PASS；running 失效仍进入 `blocked`，armed ready 不自行进入 running。

### Task 2：停止输出废弃账号时间 reason，并保留当前配置原因

**Files:**
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `src/crown/app/real-betting-dto.mjs`

**Interfaces:**
- Consumes: `realBettingStatusCoreDto(value)` 的 reason allowlist。
- Produces: 旧账号时间 reason 被规范化为空；当前 `betting-rule-card-not-enabled`、`betting-account-unavailable`、`capability-evidence-not-exact` 等仍可安全显示。

- [ ] **Step 1: 写 DTO RED 测试**

```js
for (const reasonCode of [
  'betting-account-login-not-fresh',
  'betting-account-balance-not-fresh',
]) {
  assert.equal(realBettingStatusCoreDto({ requested: true, state: 'armed_waiting', reasonCode }).reasonCode, '')
}
for (const reasonCode of [
  'betting-rule-card-not-enabled',
  'betting-account-unavailable',
]) {
  assert.equal(realBettingStatusCoreDto({ requested: true, state: 'armed_waiting', reasonCode }).reasonCode, reasonCode)
}
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-operations-summary.test.mjs
```

Expected: DTO 仍返回旧 reason，且会丢弃两个当前配置 reason，新增断言 FAIL。

- [ ] **Step 3: 从 allowlist 删除两个旧 reason**

删除：

```js
'betting-account-login-not-fresh', 'betting-account-balance-not-fresh',
```

加入当前六项 preflight 已使用但 DTO 尚未允许的配置原因：

```js
'betting-rule-card-not-enabled', 'betting-account-unavailable',
```

不修改 Watcher/赔率/lease/fence 的 freshness 语义。

- [ ] **Step 4: 运行两个聚焦测试**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs tests/crown-operations-summary.test.mjs
```

Expected: 全部 PASS。

### Task 3：同步权威文档并完成回归验证

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-crown-demo-account-auto-betting-design.md`
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-betting-protocol.md`

**Interfaces:**
- Consumes: Task 1–2 的实际测试结果。
- Produces: 后续开发只把“现场读取”视为账号执行证明，不再恢复时间新鲜度门禁。

- [ ] **Step 1: 更新当前权威口径**

四份文档必须同时写明：

```text
账号历史登录/余额检查时间不参与全局启动；每个 child 在执行当刻登录或复用有效 session、读取皇冠账号信息并完成 strict Preview。旧 betting-account-*-not-fresh 原因会按当前 preflight 重算。exact capability、perBetLimit、盘口/赔率/金额和单次 Submit 约束不变。
```

- [ ] **Step 2: 运行完整后端、语法、前端测试和构建**

Run:

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: 四条命令 exit code 0，零失败。

- [ ] **Step 3: 验证实际 runtime 状态和页面**

在当前开发库中只读取 `/api/app/real-betting-status` 与 `/api/app/operations-summary`，确认页面不再显示 `betting-account-login-not-fresh` 或 `betting-account-balance-not-fresh`；当前 capability 仍为 `0/0` 时应显示 `capability-evidence-not-exact`。不得为了验收发送 `FT_bet`。

- [ ] **Step 4: 检查改动范围**

Run:

```powershell
git diff --check
git status --short
```

Expected: 无空白错误；本任务只增加计划并修改本计划列出的 runtime、DTO、测试和权威文档，不提交 Git。
