# 用户可见五项问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Each implementation task starts with a focused failing test and ends with its focused regression. Do not auto-commit.

**Goal:** 恢复现有 Telegram 机器人配置，新增以真实投注目标为单位的投注历史，修复每日重置失败，交付桌面双击启动方式，并删除静态网站白名单。

**Architecture:** 继续使用现有 SQLite 事实账本、Windows Portable launcher 和 Telegram JSON 配置，不新建重复历史表、不新做 launcher EXE、不增加网站白名单设置。Dashboard 的代码目录与用户数据目录分离，但所有用户可变配置必须从同一 data root 解析。

**Tech Stack:** Node.js ESM、SQLite、React/Vite/TypeScript、Ant Design、PowerShell 5.1、`node:test`、Vitest。

## 方案选择

| 问题 | 可选方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|---|
| 机器人显示未设置 | 把私密 JSON 复制到新代码目录 | 立即可见 | 重复保存 token，换目录后还会再次失联 | 否 |
| 机器人显示未设置 | 统一 data root，Dashboard/Watcher 都读同一个 `config` | 不复制密钥，根治路径分裂 | 需要修一处运行时路径契约并重启 | **是** |
| 投注历史 | 前端逐批请求 children 后汇总 | 后端改动少 | N+1，请求多，分页与金额口径不稳定 | 否 |
| 投注历史 | 新建历史表并双写 | 查询简单 | 需要迁移、双写和对账 | 否 |
| 投注历史 | 从 `bet_batches` + `bet_child_orders` 建只读投影 | 使用现有事实账本，无迁移，口径可审计 | 需要一个聚合 API | **是** |
| 清理失败 | 强杀所有疑似 Watcher | 一次点击可能成功 | 可能杀错进程或在写入中删数据 | 否 |
| 清理失败 | Dashboard 管理 Watcher 生命周期，无法接管时说明原因 | 不破坏账本，清理后可恢复监控 | 当前非托管 Watcher 需做一次受控重启 | **是** |
| 桌面启动 | 新写一个 Windows EXE | 外观可定制 | 重复 launcher、签名和更新成本高 | 否 |
| 桌面启动 | 复用现有 `.lnk` + Portable launcher + `.ico` | 已有实现和测试，双击即可 | 必须先产出完整 Portable 包 | **是** |
| 网站限制 | 允许包括私网、带凭据、非 HTTPS 的任意 URL | 字面上无限制 | 可访问本机/内网并泄露凭据 | 否 |
| 网站限制 | 删除静态成员白名单，账号保存的公网 HTTPS exact origin 即权威地址 | 用户输入哪个正常公网 HTTPS 地址就访问哪个，无需维护列表 | 仍拒绝畸形 URL、私网和跨 origin 重定向 | **是** |

## 固定数据口径

- “一个投注目标”定义为一个 `bet_batches.batch_id`，不是一个账号子订单，也不把同场比赛的多个报警错误合并。
- 默认投注历史只展示真实执行批次：`authorization_id IS NOT NULL`。Preview/dry-run 不伪装成真实投注。
- 已完成投注金额只统计 `bet_child_orders.status='accepted'` 的金额；`unknown` 单独显示为“待确认”，不算成功。
- 成功平均赔率使用 accepted 子订单提交时锁定的 `preview_odds`，按成功金额加权：`SUM(amount × odds) / SUM(amount)`。
- 比赛、方向和盘口从 batch 的不可变 selection snapshot 读取，不用当前比赛状态回填历史。
- “每日开工完全重置”维持现有明确语义：它会删除点击前的投注账本和投注历史。历史页展示自上次完全重置后的记录；本轮不新增归档系统。
- API 和页面不返回账号 ID、signal ID、child order ID、submit attempt、provider reference、session、ticket、cookie 或明文 Telegram token。

## 全局约束

- 实施期间真实投注保持关闭；只有原 Stage 9 的受控验收任务可以在用户已授权范围内开启。
- 不复制 Telegram token，不把敏感配置写进代码仓库。
- 不修改 Preview/Submit/Reconciliation 的既有金额与 `unknown` 安全规则。
- 不改变 Portable 模式现有 canonical path 校验。
- 只运行每个任务的 focused tests；最终整合时运行一次完整门禁。
- 保留工作区现有未提交改动，不自动 commit。

---

## Task 1：恢复机器人并统一用户数据路径

**Files:**

- Modify: `scripts/crown-dashboard.mjs`
- Create: `tests/crown-dashboard-runtime.test.mjs`
- Verify only: `src/crown/app/local-config-api.mjs`
- Verify only: `src/crown/config/telegram-settings.mjs`
- Modify: `docs/project-memory.md`
- Modify: `docs/modules/windows-portable-release.md`

- [ ] **Step 1: 写跨代码目录/数据目录的失败测试**

  覆盖 `CROWN_APP_DIR=<new-code-root>` 与 `CROWN_DATA_ROOT=<existing-data-root>` 同时存在、但没有单独设置 `CROWN_CONFIG_DIR` 的场景。断言 `configDir` 解析为 `<existing-data-root>/config`，而不是 `<new-code-root>/config`。同时覆盖 DB、secret、runtime、log 的默认路径都跟随 data root；显式单项路径仍按现有接口优先。

- [ ] **Step 2: 运行 RED**

  ```powershell
  node --test --test-concurrency=1 tests/crown-dashboard-runtime.test.mjs
  ```

  Expected: 当前 `configDir` 仍指向代码根，测试失败。

- [ ] **Step 3: 做最小路径修正**

  在非 Portable 分支先计算 `dataRoot`，再从它派生用户可变目录默认值。`staticDir` 和源码位置继续来自 `appDir`。不复制、不迁移、不改写现有 Telegram JSON。Portable 分支不变。

- [ ] **Step 4: focused regression**

  ```powershell
  node --test --test-concurrency=1 tests/crown-dashboard-runtime.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-telegram-settings.test.mjs tests/crown-app-api.test.mjs
  npm --prefix frontend test -- --run src/pages/Settings.test.tsx
  ```

- [ ] **Step 5: 本机只读验收**

  受控重启 Dashboard 后检查：两个机器人均显示启用、token 只显示掩码、接收目标数量正确；监控账号、投注账号和 delivery 记录不变；不发送 Telegram 测试消息。

---

## Task 2：新增投注目标历史只读 API

**Files:**

- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Create: `tests/crown-bet-target-history.test.mjs`
- Modify: `docs/modules/crown-betting-protocol.md`

**Endpoint:**

`GET /api/app/bet-target-history?limit=20&cursor=...&status=...&mode=...`

- `limit`: default 20, max 50.
- `cursor`: opaque base64url cursor over `created_at + batch_id`.
- `status`: `all | active | completed | partial | failed | waiting_result`.
- `mode`: `all | prematch | live`.
- Stable order: `created_at DESC, batch_id DESC`.

- [ ] **Step 1: 写账本聚合失败测试**

  覆盖：同一 batch 多个 accepted child 的金额加权赔率；rejected/unknown/cancelled 不参与成功金额和平均赔率；unknown 单列；真实与模拟批次隔离；相同时间戳 cursor 无重复无漏项；card snapshot、mode snapshot、legacy rule snapshot；损坏旧 snapshot 返回“历史信息不可用”而不是内部 ID。

- [ ] **Step 2: 运行 RED**

  ```powershell
  node --test --test-concurrency=1 tests/crown-bet-target-history.test.mjs tests/crown-app-api.test.mjs
  ```

- [ ] **Step 3: 实现两段只读查询**

  先分页查询 batch，再只查询本页 batch 的 accepted children，避免 child join 破坏分页。DTO 只包含：

  ```ts
  {
    historyKey, createdAt, finishedAt,
    match: { leagueName, homeTeam, awayTeam },
    direction: { mode, period, marketType, side, handicapRaw },
    status, finishReason,
    acceptedBetCount, averageAcceptedOdds,
    completedAmount, targetAmount, unknownAmount, currency
  }
  ```

  金额由 minor unit 转为 decimal string。不要修改 `app-db.mjs`，不要创建新表。

- [ ] **Step 4: 安全与回归验证**

  ```powershell
  node --test --test-concurrency=1 tests/crown-bet-target-history.test.mjs tests/crown-app-api.test.mjs tests/crown-bet-batch-store.test.mjs
  ```

  额外断言响应 JSON 不含 provider reference、账号、session、ticket、submit attempt 或内部订单标识。

---

## Task 3：新增“投注历史”页面

**Files:**

- Create: `frontend/src/pages/BettingHistory.tsx`
- Create: `frontend/src/pages/BettingHistory.test.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/App.contract.test.tsx`
- Modify only if needed: `frontend/src/styles/index.css`

- [ ] **Step 1: 写页面失败测试**

  覆盖导航 `/betting-history`、比赛、方向、成功平均赔率、完成金额/目标金额、unknown、状态、时间、空态、API 失败、mode/status 筛选和“加载更多”。筛选变化必须清空旧 cursor 和旧 rows。

- [ ] **Step 2: 运行 RED**

  ```powershell
  npm --prefix frontend test -- --run src/pages/BettingHistory.test.tsx src/App.contract.test.tsx
  ```

- [ ] **Step 3: 实现最小页面**

  使用现有 Ant Design `Table`、`Select`、`Tag`、`Button`。列固定为：比赛、投注方向、成功平均赔率、已完成投注金额、状态/时间。只用 cursor “加载更多”，本轮不加日期选择器、账号筛选、导出、图表或新 CSS 系统。

- [ ] **Step 4: 接入现有控制台**

  保留 Operations 的最近批次摘要，只增加“查看全部投注历史”入口；不再在控制台暴露 batch ID。

- [ ] **Step 5: focused regression + 本地 UI**

  ```powershell
  npm --prefix frontend test -- --run src/pages/BettingHistory.test.tsx src/App.contract.test.tsx src/components/AppLayout.mobile.test.tsx src/pages/OperationsConsole.test.tsx
  npm --prefix frontend run build
  ```

  用本地 fixture 打开 Desktop 与移动宽度，检查表格横向滚动、筛选、加载更多和空态。不执行真实投注。

---

## Task 4：修复每日重置失败并保留安全边界

**Files:**

- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`
- Modify only if a defect is reproduced: `src/crown/app/runtime-cache-cleanup.mjs`
- Modify only if a defect is reproduced: `src/crown/app/monitor-process.mjs`
- Modify: `tests/crown-runtime-cache-cleanup.test.mjs`

- [ ] **Step 1: 固化当前失败场景**

  测试两条路径：

  1. Dashboard 自己管理的 Watcher：停止 → 清理 → 重开，最终成功。
  2. 存在非托管 Watcher lease：不删除任何文件/账本，返回 `watcher-active-unmanaged`。

- [ ] **Step 2: 运行 RED/确认现有后端边界**

  ```powershell
  node --test --test-concurrency=1 tests/crown-runtime-cache-cleanup.test.mjs
  npm --prefix frontend test -- --run src/pages/OperationsConsole.test.tsx
  ```

  后端若已满足两条安全契约，则 RED 只应来自前端仍显示通用错误；不要为制造 RED 改写已经正确的后端。

- [ ] **Step 3: 修最小问题**

  - 前端读取 API 的稳定错误码并显示可操作信息，例如“监控由其他进程启动，请先停止后从运行控制台重新启动”。
  - Dashboard 管理的 Watcher 继续自动停止和恢复。
  - 不新增“强制杀进程”，不绕过 browser/worker/watcher lease。
  - 实施后做一次受控进程切换，让当前 Watcher 由 Dashboard 管理。

- [ ] **Step 4: focused regression**

  ```powershell
  node --test --test-concurrency=1 tests/crown-runtime-cache-cleanup.test.mjs tests/crown-monitor-process.test.mjs tests/crown-app-api.test.mjs
  npm --prefix frontend test -- --run src/pages/OperationsConsole.test.tsx
  ```

- [ ] **Step 5: 本机验收**

  在真实投注关闭、worker 停止、无人工登录浏览器的前提下执行一次“每日开工完全重置”。确认 6GB 文件目标与历史记录按预览清除、Watcher 自动恢复、账号凭据/Telegram 配置/规则保留、投注账号保持暂停。

---

## Task 5：交付桌面双击启动

**Reuse, do not replace:**

- `packaging/windows/启动程序.cmd`
- `packaging/windows/停止程序.cmd`
- `packaging/windows/皇冠抓水投注.ico`
- `packaging/windows/launcher/start.ps1`
- `packaging/windows/launcher/ensure-desktop-shortcut.ps1`
- `tests/crown-windows-launcher.test.mjs`
- `tests/crown-windows-desktop-shortcut.test.mjs`

- [ ] **Step 1: 先验证现有 launcher 契约**

  ```powershell
  node --test --test-concurrency=1 tests/crown-windows-desktop-shortcut.test.mjs tests/crown-windows-launcher.test.mjs
  ```

- [ ] **Step 2: 只修实际缺口**

  如果 focused tests 通过，不重写 launcher。只在最终 Portable 构建/安装流程中确保成功启动后调用现有 shortcut helper。快捷方式名称为 `皇冠抓水投注.lnk`，Target 为 Portable 根目录 `启动程序.cmd`，WorkingDirectory 与 Icon 都指向同一个 Portable 根。

- [ ] **Step 3: 构建候选 Portable**

  使用项目现有 release candidate/portable build 脚本产出并审计 ZIP；不要手工拼接运行目录。

- [ ] **Step 4: 本机桌面验收**

  - 双击一个桌面图标即可启动 Dashboard 并打开 `127.0.0.1`。
  - 第二次双击复用同一实例，不启动第二个 Dashboard。
  - 程序目录移动后首次启动会校正同一个快捷方式。
  - “停止程序”只停止与 launcher identity 匹配的实例。
  - 启动器不自动开启真实投注。

---

## Task 6：删除静态网站白名单

**Detailed source plan:** `docs/superpowers/plans/2026-07-15-remove-betting-origin-allowlist.md`

**Files:**

- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `tests/crown-api-login-manager.test.mjs`
- Modify only if required: `tests/crown-app-api.test.mjs`
- Modify: `docs/project-memory.md`
- Modify: `docs/modules/crown-betting-protocol.md`

- [ ] **Step 1: 把旧白名单拒绝测试改为保存地址可用测试**

  空白名单或包含无关旧值时，账号保存的有效公网 HTTPS exact origin 都必须可用。unsafe URL 测试不得发起网络请求。

- [ ] **Step 2: 运行 RED**

  ```powershell
  node --test --test-concurrency=1 --test-name-pattern="origin allowlist|public HTTPS exact" tests/crown-api-login-manager.test.mjs
  ```

- [ ] **Step 3: 删除而不是替换**

  删除 allowlist parser、constructor property、membership branch 和 `app-api` 的旧 wiring。保留账号 URL 的公网 HTTPS exact-origin 规范化、URL credentials 拒绝、localhost/private/IP 拒绝和跨 origin redirect 拒绝。不增加新设置和迁移。

- [ ] **Step 4: focused regression**

  ```powershell
  node --test --test-concurrency=1 tests/crown-api-login-manager.test.mjs tests/crown-app-api.test.mjs tests/crown-account-execution-provider.test.mjs tests/crown-browser-account-runtime.test.mjs
  ```

---

## Task 7：整合、阶段门禁和发布验收

**Files:**

- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify relevant: `docs/modules/*.md`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: 解决现有 Stage 10 worker restart RED**

  保留 health audit 的真实 RED，不伪造 GREEN。Dashboard 重启后，旧 worker/fence 收敛必须能在同一次显式 start 流程内重新评估并启动唯一的新 worker，或返回明确可重试状态；不能无限停在 `armed_waiting/fence-not-fresh`。

- [ ] **Step 2: 运行每项 focused tests**

  只运行上述任务列出的测试，修完一项验一项，不重复跑全量。

- [ ] **Step 3: 运行一次最终门禁**

  顺序：backend 全量一次、frontend 全量一次、production build、release audit、runtime health audit。任何门禁失败先定位根因，不重复无意义重跑。

- [ ] **Step 4: 受控真实验收**

  复用 Stage 9 既有受控方案：只用用户已授权账户和金额，逐方向 Preview → 单次 Submit → 独立 Reconciliation；`unknown` 不重投。验收前再次确认真实投注开关、账号上限、比赛与方向。

- [ ] **Step 5: 最终复审与文档**

  分别复审 correctness、安全边界和过度开发，目标 Critical 0 / Important 0 / Minor 0。记录实际验证数字、未执行的外部验收和工作区状态；不自动 commit。

## 实施顺序

| 批次 | 可并行内容 | 依赖 |
|---|---|---|
| A | Task 1 机器人路径、Task 2 历史 API、Task 4 清理、Task 6 删除白名单 | 无共享文件的部分可并行 |
| B | Task 3 历史页面 | 依赖 Task 2 DTO |
| C | Task 5 Portable/桌面启动、Task 7 worker restart | 依赖功能代码稳定 |
| D | 最终门禁、受控真实验收、复审 | 依赖全部实现完成 |

## 完成标准

| 项目 | 必须达到 |
|---|---|
| 机器人 | 两个已有机器人恢复启用，token 仅掩码显示，无配置复制 |
| 投注历史 | 一行一个真实投注目标，比赛/方向/成功加权平均赔率/完成金额准确，unknown 单列 |
| 清理 | Dashboard 管理的 Watcher 场景一次成功；非托管场景不删数据且给出明确操作提示 |
| 启动 | 桌面单图标双击启动、复用单实例、可停止、不会开启真实投注 |
| 网站 | 无静态成员白名单；保存的正常公网 HTTPS 地址可直接使用；必要 URL 安全边界保留 |
| 阶段 10 | runtime health audit GREEN，最终复审三类问题均为 0 |
