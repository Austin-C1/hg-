# Crown Safe Start Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现每日重置后的安全自动监控、清晰的真实投注启用链路，以及重新设计的运行控制台和投注账号操作。

**Architecture:** 后端由清理服务统一完成“关闭真实投注、暂停投注账号、清理历史、自动启动 watcher”，Operations Summary 增加监控进程与准备链路 DTO。前端把运行控制台重组为状态结论、四步准备链路、条件风险和底部维护区，账号页面按单一状态动作显示按钮。

**Tech Stack:** Node.js `node:sqlite`, React 19, TypeScript, Ant Design, Vitest, Node test runner, Playwright/browser acceptance.

## Global Constraints

- 真实 Crown preview/submit/reconciliation 能力证据不足时必须 fail-closed。
- 每日重置保留账号凭据、登录会话、规则、Telegram、协议证据与运行依赖。
- 重置后自动启动监控，但投注账号保持暂停、全局真实投注保持关闭。
- 不新增依赖，不提交 Git。
- 所有行为修改严格执行 RED-GREEN-REFACTOR。

---

### Task 1: 安全开工重置语义

**Files:**
- Modify: `src/crown/app/runtime-cache-cleanup.mjs`
- Modify: `tests/crown-runtime-cache-cleanup.test.mjs`

**Interfaces:**
- Consumes: `monitorProcess.isRunning()`, `monitorProcess.stopAndWait()`, `monitorProcess.start()` 与 SQLite `monitor_accounts` / `betting_accounts` / `real_betting_runtime`。
- Produces: `runRuntimeCleanup()` 返回 `restartedWatcher`, `monitorStartReason`, `accountsPaused`, `bettingStopped`。

- [ ] **Step 1: 写失败测试**

增加三个真实 SQLite 场景：watcher 重置前停止但监控账号 enabled+has secret 时仍调用 `start`；所有非 archived 投注账号被置为 `paused`；全局 runtime 在重置后为 `off/requested=0`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/crown-runtime-cache-cleanup.test.mjs`
Expected: watcher 原先停止的测试因 `startCalls === 0` 失败，账号状态断言失败。

- [ ] **Step 3: 最小实现**

在事务内暂停投注账号并关闭 runtime；清理完成后读取主监控账号，只有 `enabled=1` 且 `secret_ciphertext` 非空时启动 watcher。原先运行中的 watcher 仍先安全停止，避免双实例。

- [ ] **Step 4: 运行 focused tests 确认 GREEN**

Run: `node --test tests/crown-runtime-cache-cleanup.test.mjs tests/crown-app-api.test.mjs`
Expected: PASS。

### Task 2: Operations 准备链路 API 与监控动作

**Files:**
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/app/monitor-process.mjs`
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- Consumes: watcher lease、监控账号状态、规则统计、投注账号状态、real runtime。
- Produces: `OperationsSummary.readiness` 四段状态；现有 `POST /api/app/monitor-account/actions` 供工作台启动/停止监控。

- [ ] **Step 1: 写失败测试**

断言 summary 返回 `monitor`, `rules`, `accounts`, `realBetting` 四段，每段包含 `state`, `ready`, `reason`；监控账号凭据异常时为 blocked；监控动作 start/stop 返回最新账号状态。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/crown-operations-summary.test.mjs tests/crown-app-api.test.mjs`
Expected: FAIL，`readiness` 尚不存在。

- [ ] **Step 3: 最小实现**

由 repository 根据持久化真相生成稳定 DTO；API 不推测 child process，仅用 watcher lease 与账号 runtime 状态；监控动作维持现有 CSRF 和单实例控制。

- [ ] **Step 4: 运行 focused tests 确认 GREEN**

Run: `node --test tests/crown-operations-summary.test.mjs tests/crown-app-api.test.mjs tests/crown-real-betting-runtime.test.mjs`
Expected: PASS。

### Task 3: 清爽运行控制台

**Files:**
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`

**Interfaces:**
- Consumes: `OperationsSummary.readiness`、监控动作 API、real betting start/stop、cleanup preview/run。
- Produces: 单一监控动作、四步下注准备链路、状态相关的单一真实投注动作、条件风险区与维护区。

- [ ] **Step 1: 写失败组件测试**

覆盖：监控停止显示“启动监控”；运行显示“停止监控”；real off 时不显示停止按钮；runtime running 时不显示开启按钮；0 风险时不存在红色风险主面板；阻断原因以可见文字呈现；重置成功刷新四段状态。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm --prefix frontend run test -- OperationsConsole.test.tsx`
Expected: FAIL，当前页面同时显示相反按钮且渲染红色 0 风险面板。

- [ ] **Step 3: 最小实现**

按设计文档重组 JSX；复用现有 API client；监控动作使用 `api.monitorAccountAction()`；不引入新的状态管理库。

- [ ] **Step 4: 样式实现并通过 focused tests**

Run: `npm --prefix frontend run test -- OperationsConsole.test.tsx`
Expected: PASS。

### Task 4: 投注账号单一动作与语义说明

**Files:**
- Modify: `frontend/src/pages/BettingAccounts.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/pages/BettingAccounts.test.tsx`

**Interfaces:**
- Consumes: account `allocationStatus` 与现有 enable/pause/test API。
- Produces: 每个账号只显示当前可执行的“启用账号”或“暂停账号”，并明确该动作不改变全局真实投注。

- [ ] **Step 1: 写失败组件测试**

断言 paused 账号显示“启用账号”与解释文案、不显示“暂停账号”；enabled 账号反向显示；检测按钮保持独立且检测成功不触发 enable API。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm --prefix frontend run test -- BettingAccounts.test.tsx`
Expected: FAIL，当前按钮文案和说明不符合新契约。

- [ ] **Step 3: 最小实现**

按 `allocationStatus` 渲染单一动作和状态文本；保持编辑、历史、删除行为不变。

- [ ] **Step 4: 运行 focused tests 确认 GREEN**

Run: `npm --prefix frontend run test -- BettingAccounts.test.tsx`
Expected: PASS。

### Task 5: 文档同步与全量验收

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-dashboard.md`

**Interfaces:**
- Consumes: Task 1-4 的最终行为。
- Produces: 当前项目的稳定运行说明和验证证据。

- [ ] **Step 1: 更新项目文档**

记录安全开工状态机、三层真实投注开关、重置自动启动监控、阻断条件和操作入口。

- [ ] **Step 2: 后端全量验证**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 3: 语法与前端验证**

Run: `npm run check`
Expected: 全部 `.mjs` 语法检查 PASS。

Run: `npm --prefix frontend run test`
Expected: 全部 PASS。

Run: `npm --prefix frontend run build`
Expected: production build PASS。

- [ ] **Step 4: 浏览器验收**

在桌面和 390px 宽度验证 `/operations` 与 `/betting-accounts`：无横向溢出、按钮随状态唯一显示、阻断原因可见、0 风险不使用红色主面板、重置后 watcher 自动恢复且账号/全局投注保持关闭。

- [ ] **Step 5: 记录最终证据**

把测试数量、build 结果、浏览器尺寸和运行状态写入 `docs/project-memory.md`，不创建 Git commit。

