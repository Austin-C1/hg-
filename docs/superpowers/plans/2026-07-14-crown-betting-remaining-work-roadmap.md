# 皇冠投注剩余工作总路线图 Implementation Plan

> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成一套可长期运行、可恢复、不会重复下注的自动投注系统：持续监控水位变化，命中动态规则后按账号顺序执行严格 Preview 和单次 Submit，正确处理 accepted/rejected/unknown，并在重启、断网或 Worker 异常后依据 SQLite 账本安全恢复。

**Architecture:** 继续以 SQLite 作为 Signal、规则快照、batch、child、attempt、账号锁、market-once、outcome 和 reconciliation 的唯一事实源。实施分为生产就绪收口、受控线上验收、Reconciliation/capability 扩展三个顺序阶段；每阶段独立 TDD、复核和验收，真实网络操作受固定 standing authorization 和自动停止条件约束。

**Tech Stack:** Node.js ESM 22.23.1、`node:test`、SQLite `node:sqlite`、React/Vite/Vitest、Crown HTTPS/XML protocol、Playwright/Browser 验收、Windows PowerShell。

## Global Constraints

- 核心原则：宁可不下注，也不能猜字段、重复下注，或在结果为 `unknown` 时自动重投、转投或解锁。
- Watcher 保持只读；真实执行只能由 Dashboard 管理的 canonical Worker 通过私有 ready-ticket/GO IPC 进入。
- 当前唯一开放 row 为 `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation 为 `1/1/0`；其他 row 在独立证据完成前保持 0。
- 每个 child 执行前必须取得 account-owned session、fresh CNY balance、fresh strict Preview、current selection relock 和新鲜 Worker/Executor fence。
- 每个 child 最多一次网络开始；调用方不能注入 capability、wire form、current identity、server limits 或 outcome。
- 用户已授予持续 Submit 授权，不再逐笔确认；该授权只在 Gate A 通过后生效，仅限现有不可充提虚拟 CNY 账号和已验证 exact row。
- 自动验收上限固定为每 child `<=50 CNY`、每 batch 最多两个 child 且 `<=100 CNY`、整个剩余开发累计最多 5 个 accepted batch、累计 accepted `<=500 CNY`；额度不得按阶段或 capability row 重置。
- 充值、提现、真实资金账号和未验证 capability row 不在 standing authorization 范围内。
- 任一 `unknown`、账本矛盾、重复 attempt、identity 漂移或页面/本地结果不一致都会停止当前线上阶段。
- 不记录或提交账号、密码、cookie、token、完整 uid、原始响应、完整注单 ID、密钥或私有绝对路径。
- 工作区已有大量用户改动；只修改任务列出的文件，不回滚、不顺手重构。用户已授权最终 GitHub 替换发布；阶段一至四只允许按任务边界创建显式本地 commit，不得提前 push/merge，远程操作统一由 Task 5 发布计划执行。
- 所有测试先观察预期 RED，再实现最小 GREEN；成功结论只使用本轮新鲜、完整的验证输出。

---

## 总体完成标准

只有以下项目全部有证据时，才能把“剩余投注开发完成”写入项目记忆：

1. Runtime 不再出现 preflight 全 ready、无 blocker 却长期停在 `armed_waiting/preflight-required` 的矛盾状态。
2. Backend 串行全量、syntax、frontend、production build、协议安全扫描全部单次绿色。
3. 当前 main row 通过 canonical Worker 共 5 个 accepted batch：Batch 1 为单 child `50 CNY`，Batches 2-5 为两账号 `[50,50]`，合计 9 个 child、`450 CNY`。
4. `unknown`、断网、超时、Worker 崩溃、Dashboard 重启和 fence 漂移路径均证明不会重复 Submit。
5. 当前 main row 的生产 Reconciliation 完成 exact 证据和 `1/1/1` 验收，形成可运行、可恢复、不会重复下注的自动闭环。
6. 计划内其他 capability family 分别完成独立的零 Submit 证据评估和安全门禁；当前授权无法取得 Submit/Reconciliation 证据的 row 必须以 `0/0/0 EVIDENCE_REQUIRED` 收口。这代表安全范围已明确，不代表该 row 已开放。
7. README、项目记忆、模块汇总、协议文档、运行页面和 capability matrix 使用同一当前口径。
8. 正式运行无 active/unknown 风险残留、无待处理 reconciliation、无通知死信；所有验收产物通过脱敏审计。
9. 完成版合并到现有 `Austin-C1/hg-` 默认分支，README 和源码直接替代当前旧实现；新的完整 Portable 成为 latest Release，旧 tag 只保留作回滚。

## 执行顺序

```text
阶段一：生产就绪收口
  -> Gate A：完整离线与运行态验证
  -> 阶段二：受控线上验收
  -> Gate B：累计 5 个 accepted batch（1 个单 child + 4 个 `[50,50]`）且 unknown=0
  -> 阶段三 A：生产 Reconciliation
  -> Gate C：main row 1/1/1
  -> 阶段三 B：其他 exact family 逐行开放
  -> Final Gate：全量回归、页面、审计、文档与运行状态一致
  -> Release Gate：合并现有默认分支并发布 latest Portable
```

任何 Gate 失败都返回对应计划修复，不跨 Gate 继续执行。

### Task 1: 执行生产就绪收口计划

**Files:**
- Read: `docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md`
- Modify: 仅该计划每项列出的 runtime、API、process、test 和当前状态文档

**Interfaces:**
- Consumes: 当前 SQLite runtime intent、六项 preflight、Dashboard managed Worker controller。
- Produces: 一致的 `off|armed_waiting|running|stopping|blocked` 状态、可验证的 ready-ticket/GO 启动结果和单次完整绿色基线。

- [ ] **Step 1: 按子计划逐任务执行 TDD**

Run: 按 `2026-07-14-crown-betting-production-readiness.md` 的 Task 顺序执行。

Expected: 每个任务独立 RED、GREEN、focused regression 和 reviewer gate 通过；不访问 Crown 网络。

- [ ] **Step 2: 运行 Gate A**

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-process.test.mjs tests/crown-operations-summary.test.mjs
```

Expected: 所有命令 exit code 0，backend/frontend 0 failed；runtime focused 0 failed；本阶段网络审计中 `FT_order_view=0`、`FT_bet=0`。

- [ ] **Step 3: 验证正式只读运行状态**

Run: 启动本地 Dashboard 后只读检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/app/real-betting-status
Invoke-RestMethod http://127.0.0.1:8787/api/app/operations-summary
```

Expected: API 与进程状态一致；全 ready 时进入受控 Worker 启动路径，全未 ready 时返回精确 blocker；不能出现全 ready、无 blocker 却无限停留的矛盾投影。

- [ ] **Step 4: 记录 Gate A 结果**

Modify: `docs/project-memory.md`、`docs/module-index.md`、`docs/modules/crown-betting-protocol.md`。

Expected: 仅记录本轮验证命令、计数、状态机结论和 capability `1/1/0`；不记录运行秘密。

- [ ] **Step 5: 创建阶段一范围明确的本地 commit**

Run: 逐项执行生产就绪子计划各 Task 给出的显式 `git add` 清单和 commit 命令；禁止把多个 Task 改成目录级 stage。

Expected: 本次用户已授权后续 scoped local commit 和最终 GitHub 替换发布；完成本阶段验证后按上述逐文件清单提交，不再重复询问，并继续禁止提前 push/merge。

### Task 2: 执行受控线上验收计划

**Files:**
- Read: `docs/superpowers/plans/2026-07-14-crown-betting-controlled-live-acceptance.md`
- Create/Modify: 仅该计划列出的验收脚本、测试、safe fixture 和报告

**Interfaces:**
- Consumes: Gate A 绿色基线、当前 exact main row `1/1/0`、两个现场可执行账号和固定 standing authorization。
- Produces: canonical Worker/B2 累计 5 个 accepted batch、9 个 child、`450 CNY` 的脱敏证据。

- [ ] **Step 1: 完成所有离线 rehearsal**

Run: 按受控线上验收计划执行 fixture、simulated/fake transport、故障注入和审计测试。

Expected: `accepted/rejected/unknown`、断网、超时、崩溃和重启路径 0 重复 Submit；Gate A 未通过时真实请求数为 0。首次 live window 前，共享 SQLite permit guard 已接入 Dashboard/API、B2、Provider transport 和 protocol capture；Fresh Portable 三种 campaign 材料全空时唯一分类为 `not_applicable` 且不产生授权，partial residue/mismatch 为 fail-closed，active 未 freeze、重复 claim、stopped 与 5/5 exhausted 的绕过测试全部 `FT_bet=0`。

- [ ] **Step 2: 在 standing authorization 内执行单 child smoke**

Expected: 自主选择新的 exact `RATIO_R` main Signal；只有一个 child、最多 `50 CNY`、一次 `FT_bet`，accepted 账本与网站直接响应一致。没有 exact Signal 时输出 `EVIDENCE_REQUIRED` 并停止。

- [ ] **Step 3: 在 standing authorization 内执行 `[50,50]`**

Expected: 两个账号各最多一个 50 CNY child，严格按 `bet_order`，总 accepted 不超过 100 CNY；任一 unknown 立即停止。

- [ ] **Step 4: 在 standing authorization 内补齐 Batches 3-5**

Expected: 连同前两步总计恰好 5 个 accepted batch：Batch 1 为单 child `50 CNY`，Batches 2-5 为 `[50,50]`；共 9 个 accepted child、累计 `450 CNY`，且无重复 attempt、账号重复使用、金额漂移、锁泄漏或 reconciliation 风险。第五批 accepted settlement 与 campaign `exhausted` 必须同一事务提交；在 `verify/close` 之前重新启动或直调任何 Submit surface 仍为 0。

- [ ] **Step 5: 运行 Gate B**

```powershell
node --test --test-concurrency=1 tests/crown-task10-auto-submit.test.mjs tests/crown-controlled-live-acceptance.test.mjs tests/crown-betting-protocol-capture.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-account-provider.test.mjs tests/crown-app-api.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-betting-worker.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-bet-batch-store.test.mjs
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: 所有命令 exit code 0；正式 operations 中 active batch、unknown account、unknown amount、open reconciliation 和 notification dead letter 全为 0。

- [ ] **Step 6: 创建阶段二范围明确的本地 commit**

Run: 逐项执行受控线上验收子计划各 Task 给出的显式 `git add` 清单和 commit 命令；禁止目录或 glob stage。

Expected: 本次授权已覆盖该 scoped commit；safe artifact 已通过敏感扫描，没有 raw/private capture 或身份材料进入 Git，且 cached path 全是子计划 allowlist 的子集。

### Task 3: 执行 Reconciliation 与 capability 扩展计划

**Files:**
- Read: `docs/superpowers/plans/2026-07-14-crown-betting-reconciliation-and-capability-expansion.md`
- Modify: 仅该计划列出的 protocol、matrix、provider、reconciliation 和 test 文件

**Interfaces:**
- Consumes: Gate B 的 canonical Worker live 证据和每个新 family 独立获取的 exact evidence。
- Produces: main row 的生产 Reconciliation，以及逐 row 审核的 capability matrix。
- Budget handoff: Gate B 成功时 standing authorization 的 5 个 accepted batch 已全部使用；Task 3 真实 Submit 固定为 0，3A 复用既有 binding，3B 只做零 Submit 证据/实现。

- [ ] **Step 1: 完成 3A main row 独立 Reconciliation**

Expected: exact query 绑定 child/attempt/account/session/event/selection 与 raw provider reference，`orderIdDigest` 只作比对；独立 read-only Reconciliation Worker 在真实投注 off 时仍能处理 due unknown，且 Preview/Submit 为 0。fixture、parser、provider、恢复和人工复核路径通过后，matrix 才从 `1/1/0` 升为 `1/1/1`。

- [ ] **Step 2: 运行 Gate C**

Run: 执行子计划中 Reconciliation focused、fault matrix、full regression 和只读 operations 验证。

Expected: 明确 accepted/rejected 可以安全关闭对应 unknown；不明确结果继续人工复核且不解锁、不重投。

- [ ] **Step 3: 按顺序逐个开发 3B exact family**

Order: 赛前全场大小球 main -> 滚球全场让球 main -> 滚球全场大小球 main -> first-half/alternate。

Expected: 每个 family 独立 RED/GREEN、evidence audit、matrix row、Provider 和 full regression；本轮不做新 Submit。fresh exact evidence 只足以证明哪个 capability bit 就只开放哪个 bit；需要真实 Submit 才能证明的位输出 `EVIDENCE_REQUIRED` 并保持 0。

- [ ] **Step 4: 每个 row 创建独立本地 commit**

Run: 每个 row 只执行 3A/3B 子计划对应 Task 的显式逐文件 `git add` 与 commit；禁止 stage 整个目录。

Expected: 本次授权已覆盖该 scoped commit；一个 commit 只处理一个 exact family，不得将多个未独立验收的 row 合并启用。

### Task 4: 执行最终系统验收

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-betting-protocol.md`
- Modify: `README.md`
- Create: `.superpowers/sdd/crown-betting-final-acceptance-report.md`

**Interfaces:**
- Consumes: Gate A、Gate B、Gate C 和每个 capability row 的完整证据。
- Produces: 单一当前能力口径、可复现命令、最终风险清单和明确的生产可用范围。

- [ ] **Step 1: 运行最终完整自动验证**

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
npm run crown:monitor:acceptance-audit
git diff --check
```

Expected: 全部 exit code 0，0 failed，0 whitespace error；acceptance audit 未发现 credential/session/raw capture 泄漏。

- [ ] **Step 2: 运行正式运行态验收**

检查：Dashboard health、Watcher active/unique/fresh、Betting Worker managed/fenced、规则卡、账号、batch、locks、reconciliation、notifications 和页面 Operations。

Expected: 页面和 API 使用相同状态；没有 unknown、open reconciliation、dead letter、重复 Submit 或未解释 blocker。

- [ ] **Step 3: 核对最终目标逐项满足**

```text
监控 -> Signal -> 规则卡 -> batch -> 顺序账号 -> fresh Preview
-> 单次 Submit -> accepted/rejected/unknown -> reconciliation/manual review
-> restart recovery -> Dashboard audit
```

Expected: 每个箭头都有实现、测试和验收证据；任何缺口留在明确的 capability 0 或 `EVIDENCE_REQUIRED`，不得用“应该可用”代替。

- [ ] **Step 4: 写最终报告与权威文档**

报告必须列出：支持的 exact rows、matrix version、测试计数、真实验收批次数、unknown 数、重复 Submit 数、Reconciliation 状态、未开放范围、运行/停止方式和回滚条件。

Expected: 当前摘要不再与 README、模块文档或源码 matrix 冲突。

- [ ] **Step 5: 创建最终验收文档本地 commit**

```powershell
git add README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md
git commit -m "docs: record completed crown betting acceptance"
```

Expected: private `.superpowers/sdd/` 最终报告继续留在 ignored 本机证据目录，不进入 Git；公开提交只包含已验证事实，超出 standing authorization 或未取得证据的能力不写成完成。

### Task 5: 执行全程序终验并替换 GitHub 当前版本

**Files:**
- Read: `docs/superpowers/plans/2026-07-14-crown-full-validation-and-github-release.md`
- Modify: 仅该计划列出的版本、发布文档、测试证据和 GitHub Release 资产

**Interfaces:**
- Consumes: Final Gate 全绿代码、最终 capability matrix、运行态验收和 safe artifacts。
- Produces: 现有 `Austin-C1/hg-` 默认分支的新源码、`v0.2.0` tag 和 latest 完整 Portable ZIP。

- [ ] **Step 1: 按发布计划完成全程序与 clean-checkout 双重验证**

Expected: backend/frontend/syntax/build、监控/投注故障矩阵、Dashboard 浏览器流程、Portable、敏感扫描、仓库外 cwd 和 Fresh Windows 10/11 全部通过。

- [ ] **Step 2: 把完成版合并到现有默认分支**

Expected: 不创建独立仓库或并行产品；当前 README、源码和发布说明由完成版直接接替，Git 历史保留。

- [ ] **Step 3: 发布并核对 latest Release**

Expected: `v0.2.0` 成为 latest；GitHub 实际下载的 ZIP hash/size 与本地最终资产完全一致；旧 tag 不再是默认下载入口，但继续可用于回滚。
