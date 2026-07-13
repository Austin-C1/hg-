# Crown 监控报警与投注规则分离 Implementation Plan

> 历史状态：本文件中的固定赛前/滚球投注设置或统一监控投注规则已被
> `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` 取代。
> 其余历史验收证据保留，不作为当前实现入口。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有统一多规则改造成两套按 `prematch/live` 固定分支的监控报警与自动投注配置，并保持既有多账号账本、unknown 恢复和真实投注安全门禁。

**Architecture:** Watcher 只读取 `monitor_alert_settings` 生成 Signal；Signal 事务同时写赔率 TG delivery 与 `auto_betting_signal_inbox`。投注 worker 只领取 inbox，按不可变 `auto_betting_settings` 快照做同线反打、赔率核对、mode-scoped 授权和多账号执行；旧规则表与旧字段只读留作迁移证据。

**Tech Stack:** Node.js 22 ESM、`node:sqlite`、React 18、TypeScript、Ant Design、Vitest、Node test runner、Playwright/Browser 验收。

## Global Constraints

- `prematch` 与 `live` 可同时启用；监控报警至少勾选让球或大小球，滚球启用时至少勾选一个阶段。
- 监控用动水阈值，上涨和下降都报警；自动投注只处理上涨 Signal，固定投注同赛事、同 mode、同 period、同 market type、同盘口线的对面 selection；下降 inbox 在任何 selection/claim/batch 工作前稳定 skipped。
- Signal 原子创建赔率 TG delivery 和自动投注 inbox；二者独立领取、独立重试，任何一方失败不回滚另一方已经成功的后续处理。
- inbox 使用创建时的投注设置快照；命中时关闭或待迁移复核的模式稳定 `skipped`，以后开启不补投旧 Signal。
- 新执行身份为 `betting_mode + settings_version`；旧 `rule_id` 只读留证，不参与新任务。
- `real_eligible` 必须走独立审计升级；模式 enabled、eligibility、全局意图、ExecutionAuthorization、capability、lease、fence 全部通过才允许真实提交。
- 真实 Crown preview/submit/reconciliation capability 当前仍为 0；本次实施不得伪造能力、不得调用 `FT_bet`、不得自动开启任何真实投注。
- `rejected` 不转投；`unknown` 不重投并保留金额与账号锁；只有 `accepted` 创建成功 TG outbox。
- 旧 JSON/旧规则迁移幂等、默认关闭、不猜字段、不覆盖已人工保存的新设置。
- 当前仓库无 commit 基线且全部文件未跟踪；实施不自动 commit、不删除用户文件。

---

### Task 1: 新设置表、inbox 与安全迁移

**Files:**
- Create: `src/crown/app/alert-betting-settings-migration.mjs`
- Modify: `src/crown/app/app-db.mjs`
- Create: `tests/crown-alert-betting-settings-schema.test.mjs`
- Create: `tests/crown-alert-betting-settings-migration.test.mjs`

**Interfaces:**
- Produces: `decideAlertBettingMigration({ monitorJson, legacyRules, existingRows })`，返回 `{ monitorAlerts, autoBetting }`，每个 mode 都含 `values`, `reviewRequired`, `reviewReason`。
- Produces tables: `monitor_alert_settings`, `auto_betting_settings`, `auto_betting_signal_inbox`；向新批次、market-once 与 authorization 增加 mode/settings scope 列，旧列保留。

- [ ] **Step 1: 写 fresh schema 失败测试**

```js
test('fresh schema creates exactly two disabled rows per settings table', () => {
  const { db } = openAppDatabase(tempDb())
  assert.deepEqual(db.prepare('SELECT mode,enabled FROM monitor_alert_settings ORDER BY mode').all(), [
    { mode: 'live', enabled: 0 }, { mode: 'prematch', enabled: 0 },
  ])
  assert.deepEqual(db.prepare('SELECT mode,enabled,real_eligible FROM auto_betting_settings ORDER BY mode').all(), [
    { mode: 'live', enabled: 0, real_eligible: 0 }, { mode: 'prematch', enabled: 0, real_eligible: 0 },
  ])
})
```

- [ ] **Step 2: 运行 RED**

Run: `node --test tests/crown-alert-betting-settings-schema.test.mjs`
Expected: FAIL，`no such table: monitor_alert_settings`。

- [ ] **Step 3: 在 canonical SCHEMA 增加三张表和约束**

```sql
CREATE TABLE IF NOT EXISTS monitor_alert_settings (
  mode TEXT PRIMARY KEY CHECK (mode IN ('prematch','live')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  asian_handicap_enabled INTEGER NOT NULL DEFAULT 0 CHECK (asian_handicap_enabled IN (0,1)),
  total_enabled INTEGER NOT NULL DEFAULT 0 CHECK (total_enabled IN (0,1)),
  monitor_odds_min REAL, monitor_odds_max REAL,
  water_move_threshold REAL NOT NULL CHECK (water_move_threshold >= 0),
  cooldown_seconds INTEGER NOT NULL CHECK (cooldown_seconds >= 0),
  start_minutes_before_kickoff INTEGER, stop_minutes_before_kickoff INTEGER,
  live_minute_from INTEGER, live_minute_to INTEGER,
  include_first_half INTEGER NOT NULL DEFAULT 0,
  include_half_time INTEGER NOT NULL DEFAULT 0,
  include_second_half INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '', migration_review_required INTEGER NOT NULL DEFAULT 0,
  migration_review_reason TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

`auto_betting_settings` 固定 `mode/enabled/target_odds_min/target_odds_max/target_amount_minor/currency='CNY'/amount_scale=0/remark/real_eligible/real_eligibility_version/real_eligibility_updated_at/migration_review_* /version/timestamps`；`auto_betting_signal_inbox` 固定设计中的 13 个状态与 lease/snapshot 字段，并以 `signal_id` 唯一。

- [ ] **Step 4: 写迁移 RED 测试**

覆盖：旧 JSON 显式数值可迁；没有盘口勾选证据时两盘口 false、enabled false、review true；多个旧 canonical rule 冲突时不选赢家；0 金额不迁；第二次启动不覆盖 version>1 的人工设置。

- [ ] **Step 5: 实现纯函数迁移并在 `openAppDatabase()` 的 `BEGIN IMMEDIATE` 数据迁移阶段调用**

迁移结果只能把证据写入值与 `migration_review_reason`，所有新 `enabled`、`real_eligible` 固定 false。旧 `betting_rules`、JSON 和历史 batch 不删除、不改写。

- [ ] **Step 6: 运行 GREEN 与 schema 回归**

Run: `node --test tests/crown-alert-betting-settings-schema.test.mjs tests/crown-alert-betting-settings-migration.test.mjs tests/crown-app-db.test.mjs tests/crown-auto-bet-rule-schema.test.mjs`
Expected: PASS；重复打开同一 DB 不新增行、不改变人工版本。

### Task 2: 两套校验、Repository 与 API

**Files:**
- Create: `src/crown/monitor/alert-settings.mjs`
- Create: `src/crown/betting/auto-betting-settings.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Create: `tests/crown-alert-settings-api.test.mjs`
- Create: `tests/crown-auto-betting-settings-api.test.mjs`

**Interfaces:**
- Produces `repo.getMonitorAlertSettings()`, `repo.updateMonitorAlertSetting(mode, body)`。
- Produces `repo.getAutoBettingSettings()`, `repo.updateAutoBettingSetting(mode, body)`。
- GET envelope 固定 `{ items: { prematch, live }, summary }`；PUT envelope 固定 `{ item }`。
- 每个 PUT body 必须包含 `expectedVersion`，CAS 冲突分别返回 `monitor-alert-settings-version-conflict`、`auto-betting-settings-version-conflict`。

- [ ] **Step 1: 写 API 隔离 RED 测试**

```js
assert.deepEqual(Object.keys(alertGet.payload.items), ['prematch', 'live'])
assert.equal('targetAmountMinor' in alertGet.payload.items.prematch, false)
assert.equal('waterMoveThreshold' in bettingGet.payload.items.live, false)
```

同时断言赛前 PUT 拒绝 live 字段、滚球 PUT 拒绝 prematch 字段、报警启用时至少一个 market、滚球启用时至少一个 phase、投注金额为 positive safe integer CNY、赔率区间有序。

- [ ] **Step 2: 运行 RED**

Run: `node --test tests/crown-alert-settings-api.test.mjs tests/crown-auto-betting-settings-api.test.mjs`
Expected: FAIL，路由不存在。

- [ ] **Step 3: 实现白名单 normalizer 与 CAS repository**

```js
const changed = db.prepare(`UPDATE monitor_alert_settings SET enabled=?, version=version+1,
 updated_at=? WHERE mode=? AND version=?`).run(bool(item.enabled), now(), mode, body.expectedVersion)
if (changed.changes !== 1) throw new Error('monitor-alert-settings-version-conflict')
```

更新必须写入该 mode 的完整 canonical 值；普通投注 PUT 不接受 `realEligible` 或 eligibility version。

- [ ] **Step 4: 接入四个正式 API 并 retire 旧 mutation**

实现设计中的四个路径。旧 `auto-bet-rules`/多规则写 API 返回 HTTP 410 `{ error:'rule-api-retired' }`，旧 GET 只读兼容；不影响历史审计读取。

- [ ] **Step 5: 运行 GREEN 与安全回归**

Run: `node --test tests/crown-alert-settings-api.test.mjs tests/crown-auto-betting-settings-api.test.mjs tests/crown-app-api.test.mjs tests/crown-dashboard-security.test.mjs`
Expected: PASS；mutation 仍受 same-origin CSRF 保护。

### Task 3: Alert setting watcher、Signal 去耦与双任务原子写入

**Files:**
- Create: `src/crown/monitor/alert-settings-watcher.mjs`
- Modify: `src/crown/monitor/strategy-registry.mjs`
- Modify: `src/crown/monitor/signal.mjs`
- Modify: `src/crown/monitor/monitor-state-store.mjs`
- Modify: `scripts/crown-watch.mjs`
- Create: `tests/crown-alert-settings-watcher.test.mjs`
- Create: `tests/crown-signal-dual-task.test.mjs`

**Interfaces:**
- Produces `alertSettingToStrategy(setting)`，ID 固定 `monitor-alert:${mode}`，version 等于 setting version，markets/phases 来自勾选，direction 固定 `up`。
- `createSignal()` 不再产生 `bettingRuleId`；payload 保留 setting version 的 strategy snapshot identity。
- `MonitorStateStore.insertSignal(signal, { bettingSettings })` 同事务写 Signal、`monitor_deliveries(channel='telegram')`、inbox 与 cooldown。

- [ ] **Step 1: 写 watcher RED 测试**

断言 prematch/live 两条 setting 同时返回两条策略；未勾选 market 的 setting disabled；上涨、下降达到动水阈值都匹配；AH/total 可单选或双选；live phase 过滤准确。

- [ ] **Step 2: 写双任务事务 RED 测试**

```js
store.insertSignal(signal, { bettingSettings: disabledSnapshot })
assert.equal(db.prepare('SELECT count(*) n FROM monitor_deliveries WHERE signal_id=?').get(signal.signalId).n, 1)
assert.equal(db.prepare('SELECT count(*) n FROM auto_betting_signal_inbox WHERE signal_id=?').get(signal.signalId).n, 1)
```

故障注入让 inbox insert 抛错，断言 Signal/delivery/cooldown 全部回滚；处理阶段 TG dead-letter 不改变 inbox，inbox skipped 不改变 TG。

- [ ] **Step 3: 实现并替换 watcher 的 `AutoBetRuleWatcher`**

移除 watcher 阶段 `claimMarketOnce()` 与新链路 candidate export；market-once 只在投注消费者完成反向盘口核对后认领。schema-v1 显式回滚路径保持不变。

- [ ] **Step 4: 运行 GREEN 与 v2 集成回归**

Run: `node --test tests/crown-alert-settings-watcher.test.mjs tests/crown-signal-dual-task.test.mjs tests/crown-strategy-engine.test.mjs tests/crown-monitor-v2-integration.test.mjs tests/crown-alert-dispatcher.test.mjs`
Expected: PASS；一次命中只有一个 Signal、一个 TG task、一个 inbox task。

### Task 4: Inbox Store 与自动投注消费者

**Files:**
- Create: `src/crown/betting/auto-betting-inbox-store.mjs`
- Create: `src/crown/betting/auto-betting-consumer.mjs`
- Modify: `src/crown/betting/betting-worker.mjs`
- Modify: `scripts/crown-betting-worker.mjs`
- Modify: `src/crown/betting/market-once-store.mjs`
- Create: `tests/crown-auto-betting-inbox.test.mjs`
- Create: `tests/crown-auto-betting-consumer.test.mjs`

**Interfaces:**
- Produces `AutoBettingInboxStore.claimDue({ owner, leaseSeconds, limit })`, `complete`, `retry`, `skip`, `deadLetter`；过期 processing lease 可恢复，旧 owner 不可完成新 lease。
- Produces `AutoBettingConsumer.process(item, { executionMode, authorizationId })`。
- Worker 不再扫描 `monitor_signals`；只恢复未完成 batch，再 claim inbox。下降 Signal 保留 TG 与 inbox 双写，但 consumer 在 selection 查询、market claim、batch 创建前固定 `skipped/water-down-alert-only`。

- [ ] **Step 1: 写 lease/state machine RED 测试**

覆盖双 worker 只领一次、5/15/45 秒 retry、第四次 dead-letter、过期 lease takeover、stale owner fenced、disabled/review/invalid snapshot 稳定 skipped。

- [ ] **Step 2: 写反向 selection RED 测试**

使用真实 `lockReverseSelection()` fixture，断言 home→away、away→home、over→under、under→over；目标 odds 只检查对面 selection；相邻 line、line value 变化、stage 变化全部 skip 且不锁账号。

- [ ] **Step 3: 实现消费者顺序**

顺序固定：验证 snapshot → 执行时全局门禁 → `lockReverseSelection()` → target odds → mode-scoped market-once → preview/capacity → coordinator。稳定 skip code 使用设计第 9 节值；瞬时 DB/lease 错误进入 retry。

- [ ] **Step 4: 改 Worker 只消费 inbox**

删除 `SELECT ... FROM monitor_signals WHERE NOT EXISTS batch`；preview 也用持久 inbox 状态，不用进程内 `seenSignalIds` 作为唯一幂等。

- [ ] **Step 5: 运行 GREEN**

Run: `node --test tests/crown-auto-betting-inbox.test.mjs tests/crown-auto-betting-consumer.test.mjs tests/crown-betting-worker.test.mjs tests/crown-locked-selection.test.mjs`
Expected: PASS；关闭后开启不会补投旧 Signal。

### Task 5: Mode-scoped batch、授权与 B2 结果

**Files:**
- Modify: `src/crown/betting/bet-batch-store.mjs`
- Modify: `src/crown/betting/multi-account-bet-coordinator.mjs`
- Modify: `src/crown/betting/execution-gate.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: `src/crown/betting/b2-reconciler.mjs`
- Modify: `src/crown/betting/real-betting-runtime.mjs`
- Modify: `src/crown/betting/market-once-store.mjs`
- Modify: `tests/crown-c-unified-auto-betting-integration.test.mjs`
- Modify: `tests/crown-betting-b2-executor.test.mjs`
- Modify: `tests/crown-betting-b2-reconciliation.test.mjs`
- Modify: `tests/crown-real-betting-runtime.test.mjs`

**Interfaces:**
- 新 batch identity: `{ signalId, bettingMode, settingsVersion }`，保存 immutable settings snapshot；legacy `ruleId` 可为空且只用于旧记录。
- 新 authorization scope: `bettingModes` + 每 mode 的 `eligibilityVersion`；普通 settings version 变化不得授予 eligibility。
- Batch 状态映射遵循 amended design：0 accepted/unknown 的安全停止为 cancelled；已有 accepted 为 partial；有 unknown 为 waiting_result。

- [ ] **Step 1: 写 mode identity 与 authorization RED 测试**

断言同 Signal+mode 只建一次；另一个 mode 不冲突；authorization 缺 mode、eligibility version 不匹配、普通配置更新后扩大 scope 全部 fail-closed；旧历史 batch 仍可读取。

- [ ] **Step 2: 写 accepted-only 成功 TG RED 测试**

```js
assert.equal(outboxCount('accepted'), 1)
assert.equal(outboxCount('rejected'), 0)
assert.equal(outboxCount('unknown'), 0)
```

reconciliation 后 accepted 只写一次；unknown/rejected 可保留非成功审计事件，但不能进入成功机器人 outbox。

- [ ] **Step 3: 迁移 coordinator/gate/B2 到 mode scope**

保留 provider min/max/step、顺序分配、partial capacity、每账号串行/多账号并行、rejected 不转投、unknown 保留 reservation/lock 的现有实现。所有 SQL 同时兼容 legacy rule-scoped 历史读取。

- [ ] **Step 4: 运行 GREEN 与 B1/B2 回归**

Run: `node --test tests/crown-c-unified-auto-betting-integration.test.mjs tests/crown-bet-batch-store.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-b2-notifications.test.mjs tests/crown-real-betting-runtime.test.mjs`
Expected: PASS；canonical capability 仍报告 0，真实提交仍 blocked。

### Task 6: Operations readiness 与 API 摘要

**Files:**
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/real-betting-dto.mjs`
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- `OperationsSummary.monitorAlerts` 和 `.autoBetting` 都固定 `{ prematch:{enabled,reviewRequired}, live:{enabled,reviewRequired} }`。
- readiness 要求至少一个 alert mode enabled，且同 mode betting enabled/eligible/valid；再叠加 accounts、capability、authorization、leases/fence。

- [ ] **Step 1: 写 summary/readiness RED 测试**

覆盖两个 mode 同时 enabled、alert-only、betting enabled 但 alert off、review pending、无账号、capability 0、unknown/notification backlog。

- [ ] **Step 2: 实现新聚合并保留全局 runtime 控制**

旧 `rules.total/priority` 不再决定新 readiness；历史规则计数可留在 compatibility/history 子对象，但不供新 UI 使用。

- [ ] **Step 3: 运行 GREEN**

Run: `node --test tests/crown-operations-summary.test.mjs tests/crown-app-api.test.mjs tests/crown-real-betting-runtime.test.mjs`
Expected: PASS。

### Task 7: 两个双卡页面、正式路由与移动端布局

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/services/api.security.test.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.contract.test.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `frontend/src/pages/MonitorSettings.tsx`
- Modify: `frontend/src/pages/MonitorSettings.test.tsx`
- Modify: `frontend/src/pages/AutoBetRules.tsx`
- Modify: `frontend/src/pages/AutoBetRules.test.tsx`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`
- Modify: `frontend/src/styles/index.css`

**Interfaces:**
- API methods: `getMonitorAlertSettings`, `updateMonitorAlertSetting`, `getAutoBettingSettings`, `updateAutoBettingSetting`。
- 正式路由 `/monitor-alerts`、`/betting-rules`；旧 `/monitor-settings`、`/auto-bet-rules` 使用 `<Navigate replace>`。

- [ ] **Step 1: 写 frontend RED 测试**

监控页断言两卡、市场 checkbox、phase、独立 CAS、同时 enabled、零市场不能启用、赛前/滚球 DTO 不串字段、健康诊断仍可见。投注页断言两卡、目标赔率与 positive integer CNY、同时 enabled、摘要可见，并断言页面不存在规则列表/新增/克隆/归档/排序/方向/盘口/联赛/全局真实开关。

- [ ] **Step 2: 运行 RED**

Run: `npm --prefix frontend run test -- --run frontend/src/pages/MonitorSettings.test.tsx frontend/src/pages/AutoBetRules.test.tsx frontend/src/App.contract.test.tsx`
Expected: FAIL，找不到新标题、控件或路由。

- [ ] **Step 3: 实现类型/API 与双卡组件**

每卡保存完整 canonical mode DTO + `expectedVersion`；保存中禁用本卡，另一卡仍可操作；409 显示“配置已被其他页面更新，请刷新后重试”，不得覆盖服务端新版本。

- [ ] **Step 4: 更新 Operations Console**

显示赛前/滚球报警和投注状态，Watcher 启停与全局真实投注只保留在此页；链接分别指向两个正式路由。

- [ ] **Step 5: 实现响应式布局与兼容路由**

`.mode-settings-grid` 在宽屏为 `repeat(2,minmax(0,1fr))`，`max-width:767px` 变单列；表单子项 `min-width:0`，长 remark/error 可换行，不出现 body 横向滚动。

- [ ] **Step 6: 运行 GREEN 与 build**

Run: `npm --prefix frontend run test`
Expected: 11+ test files 全通过。

Run: `npm --prefix frontend run build`
Expected: TypeScript 与 Vite production build exit 0。

### Task 8: 文档、兼容收口与完整验收

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-football-monitor.md`
- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/betting-architecture.md`
- Modify: `README.md`

**Interfaces:**
- 文档明确正式页面/API、旧读兼容/写 retired、新执行身份、迁移 review、inbox 状态和 capability 0 安全状态。

- [ ] **Step 1: 跑 focused 后端回归**

Run: `node --test tests/crown-alert-betting-settings-schema.test.mjs tests/crown-alert-betting-settings-migration.test.mjs tests/crown-alert-settings-api.test.mjs tests/crown-auto-betting-settings-api.test.mjs tests/crown-alert-settings-watcher.test.mjs tests/crown-signal-dual-task.test.mjs tests/crown-auto-betting-inbox.test.mjs tests/crown-auto-betting-consumer.test.mjs tests/crown-c-unified-auto-betting-integration.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-operations-summary.test.mjs`
Expected: 0 fail。

- [ ] **Step 2: 跑全量自动验证**

Run: `npm test`
Expected: 0 fail。

Run: `npm run check`
Expected: 全部 `.mjs` 语法通过。

Run: `npm --prefix frontend run test && npm --prefix frontend run build`
Expected: frontend tests 与 production build 全通过。

- [ ] **Step 3: 浏览器验收**

在 1440×900、768×1024、390×844 打开两个新页面和 Operations Console：验证两卡并列/单列、同时开启保存、checkbox/phase、CAS 错误、Drawer 新导航、旧 URL replace、无横向溢出；不启动真实 worker、不调用 Crown 网络或 Telegram 真发送。

- [ ] **Step 4: 安全断言与文档更新**

确认 capability matrix 仍为 preview/submit/reconciliation 0；数据库中新 settings 与 `real_eligible` 默认 off；没有敏感字段进入 API、Signal、inbox snapshot、日志或 TG payload。把最终测试数量与未执行的真实验收写入项目记忆和模块索引。

## Self-review Result

- Spec coverage: 两表/API/页面/运行模块、双 mode、市场勾选、同线反打、双任务、账号队列、rejected/unknown/accepted TG、迁移和运维摘要均有对应 Task。
- Placeholder scan: 无 TBD/TODO/“类似 Task N”；所有新接口、状态和值均已定义。
- Type consistency: `mode` 均为 `prematch|live`；settings version、eligibility version、batch identity 与 authorization scope 名称前后一致。
- Safety: 计划不提升 canonical Crown capability，不自动开启真实投注，不删除旧证据，不自动 commit。
