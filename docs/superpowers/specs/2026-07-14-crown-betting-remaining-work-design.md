# 皇冠投注剩余工作设计

## 目标

把当前未完成的投注工作拆成三个顺序 Gate 明确的开发、验证和验收阶段：先收口生产运行状态，再进行受控线上验收，最后扩展 Reconciliation 和其他 exact capability family；全部完成后执行全程序终验并发布 GitHub 最新版本。任何阶段都不能用历史手工抓包、相似盘口或调用方自报字段替代当前 exact 证据。

最终产品目标是形成一套可长期运行、可恢复、不会重复下注的自动投注系统：持续监控盘口和水位变化，命中动态规则后按账号顺序执行 fresh strict Preview 与 exactly-once Submit，把结果可靠归类为 accepted/rejected/unknown，并在断网、Worker 崩溃或程序重启后依据 SQLite 账本进入 exact Reconciliation 或人工复核。核心原则是宁可不下注，也不能猜字段、重复下注或在 `unknown` 后自动重投。

## 当前基线

- B1/B2 账本、账号锁、单 child 恢复、`unknown` 不重投、通知 outbox、动态规则卡和 card-scoped batch 已完成。
- canonical Worker、strict Preview/Submit Provider、两阶段 ready-ticket/GO 启动和单次 Submit 门禁已实现。
- 当前唯一开放行为 `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation 为 `1/1/0`。
- 当前正式 runtime 为 `requested=true`、`armed_waiting/preflight-required`；六项 preflight 均返回 ready、`blockingReasons` 为空，但没有 Betting Worker 进程。
- 最新 Task 10 focused、frontend、syntax 和 build 已通过；缺少当前代码的一次完整 backend 全量绿色结果。
- 已有一笔人工受控 `50 CNY` accepted 证据，但不是 canonical Worker/B2 自动链路验收。

## 方案与边界

采用“总路线图 + 三份分阶段实施计划”。三个计划按顺序执行，前一阶段的完成证据是后一阶段的硬前置条件；它们共同修改并最终替代同一个现有程序，不代表三个产品或独立仓库。

### 阶段一：生产就绪收口

目标是让 runtime 状态、代码门禁、测试证据和文档口径一致，不发送真实 Preview 或 Submit。

工作范围：

1. 用自动测试复现“六项 preflight ready、无 blocker，但 runtime 保持 `armed_waiting/preflight-required`”的状态。
2. 沿 `app-api -> real-betting-runtime -> betting-process -> ready-ticket/GO` 查清状态没有进入 `running` 的根因。
3. 修复后验证静态门通过才 spawn；post-ready fence、executor lease、ticket 或 GO 任一失败时必须停止 Worker 并保持 fail-closed。
4. 确认程序重启只恢复用户已持久化的 requested intent，不绕过当前 preflight，也不把旧 PID、旧 fence 或旧 readyTicket 当作有效状态。
5. 串行运行完整 backend、syntax、frontend 和 production build，留下单次完整绿色证据。
6. 统一 README、项目记忆、模块汇总、协议文档和现有计划顶部的当前 capability 为 `1/1/0`；历史 `0/0/0` 段落必须明确标记历史状态，不能继续充当当前结论。

本阶段禁止：访问 Crown Preview/Submit、启动 real Worker、创建真实 batch、修改账号金额或扩大 capability。

### 阶段二：受控线上验收

目标是在新的 exact 赛前全场让球 main 行上证明 canonical Worker/B2 自动链路，而不是再次证明人工浏览器提交。

用户已授予本项目持续 Submit 授权，不再逐笔确认。该 standing authorization 只在阶段一 Gate 全部通过后生效，并固定限制为：仅使用现有不可充提虚拟 CNY 账号；仅选择已通过 exact evidence、脱敏审计和完整回归的 capability row；每个 child 不超过 `50 CNY`；每个 batch 最多两个 child、总额不超过 `100 CNY`；整个剩余开发累计最多完成 5 个 accepted batch，累计 accepted 不超过 `500 CNY`，不能按阶段或 row 重置额度。充值、提现、真实资金账号和未验证 row 不在授权范围内。

阶段二首次 live window 前必须先启用本机 HMAC-bound SQLite campaign/permit guard。`init` 建立 active marker，`freeze` 为唯一 exact Signal 建立固定 ordinal permit，B2 在正式事务原子 claim child，Provider 在 `FT_bet` transport 前复核 immutable claim；Dashboard/API 和 protocol capture 不能旁路。第五个 accepted batch 与 campaign `exhausted` 在同一 settlement transaction 提交，因此阶段二结束到阶段三代码之间不存在第六批窗口。guard 明确区分四态：DB marker/private state/report 全空的新安装为 `not_applicable`，只继续产品原有且默认 off 的标准门禁；report-only、其他 partial residue 或 HMAC/事实不匹配为 `campaign-binding-incomplete` 并阻断 Submit；active 必须有唯一 frozen permit；exhausted/stopped 永久阻断本次授权。普通 Worker/Provider 只检查固定 completion report path 是否存在作为 tamper sentinel，不读取内容或用它授权；report 内容仅供 terminal 后只读审计。Portable 不打包这三种 private 材料，但当前开发数据的 exhausted/stopped marker 不能通过重启、升级、清锁或新建 window 重置。

验收分三级，系统可在上述 standing authorization 内自主选择符合条件的比赛和盘口：

1. Batch 1 单 child smoke：一个 exact Signal、一个账号、`50 CNY`、最多一次 `FT_bet`。
2. Batch 2 两账号金额分配：目标 `100 CNY`，使用 campaign 初始化时不可变绑定、且配置为 `perBetLimit=50 CNY` 的两个账号，严格按 `bet_order=1,2` 形成 `[50,50]`。
3. Batches 3-5 连续稳定性：再完成三个 `[50,50]` accepted batch，使本阶段总计恰好 5 个 accepted batch、9 个 accepted child、累计 `450 CNY`；检查没有重复 Submit、金额漂移、账号重复使用、锁泄漏或错误恢复。

每次执行必须重新满足：

- Watcher 来源为新的 `RATIO_R` main 行，不接受 `RATIO_RE`、滚球、alternate、first-half、total 或未知 lineVariant。
- account-owned session 在当前进程内完成 production login protocol proof，account、uid、origin 和 session provenance 一致。
- fresh `FT_order_view` 返回同一 line，赔率仍在规则卡冻结区间，币种为 CNY，余额和服务端 min/max 足够。
- capability version、Worker lease、Executor lease、fencing token、readyTicket 和 GO 全部新鲜且匹配。
- 每个 child 只允许一次网络开始；只有 direct `code=560`、唯一结果标识和 identity/金额/赔率精确回显才记为 accepted。

失败处理：

- 网络开始前可证明未发送：安全取消并记录稳定原因。
- 网络开始后无法证明 accepted 或未创建注单：记为 `unknown`，保留账号和金额锁，不重试、不转投。
- 任一 identity、赔率、金额、session 或 fence 漂移：不发送请求。
- 出现 unknown、重复尝试、账本矛盾或页面/本地结果不一致：立即停止后续验收，进入人工复核。

### 阶段三：Reconciliation 与 capability 扩展

该阶段只在阶段二完成后开始，并拆成两个相互独立的子方向。

#### 3A：生产 Reconciliation

目标是为当前唯一 `1/1/0` row 建立可验证的生产结果查询和人工处理边界。

- 阶段二成功时已经耗尽 standing authorization 的 5 个 accepted batch；3A 必须复用阶段二的 immutable execution binding，真实 Submit 数为 0。
- 先取得脱敏、直接、可重复关联的 reconciliation 证据，再设计 mapper/provider。
- 查询必须先校验原始 child、attempt、account、session、event、selection 与 immutable binding，再从同一 attempt 的 context-bound ciphertext 解密 exact provider reference；明文只作内存查询参数，`orderIdDigest` 只作查询前后比对，不能替代 reference。
- Reconciliation 使用独立 read-only Worker/lease，由 SQLite due unknown 驱动；真实投注 `off` 时仍可查询，但不能启动 Betting Worker、Preview 或 Submit，避免“必须重新开启下注才能对账”的循环依赖。
- 不得通过余额变化、页面提示、相似时间或模糊字符串推断 accepted/rejected。
- 只有 exact reconciliation fixture、字段集合、响应分类和恢复路径全部验证后，当前 row 才能从 `1/1/0` 升为 `1/1/1`。
- 在能力仍为 0 时，现有 `unknown` 保持人工复核，不自动解锁或重投。

#### 3B：其他 exact capability family

每个 family 独立执行“零 Submit 证据采集 -> 脱敏审计 -> strict mapper/parser -> matrix row -> Provider 接线 -> focused/full regression”。禁止把当前 main row 的字段或结论复制到其他 family。阶段二成功后 5 个 accepted batch 上限已经耗尽，因此本轮 3B 不得新发 Submit；需要真实 Submit 才能证明的能力保持 0/`EVIDENCE_REQUIRED`，除非用户以后明确扩大授权。

建议顺序：

1. 赛前全场大小球 main。
2. 滚球全场让球 main。
3. 滚球全场大小球 main。
4. first-half 和 alternate line。

每个 family 必须独立定义 period、market、lineVariant、Preview wire、Submit wire、accepted/rejected/unknown 分类和 reconciliation 状态。只有 fresh exact Preview 证据时最多开放 Preview 位；Submit/Reconciliation 继续为 0。没有对应 exact 证据的位保持 0。

## 组件与数据流

```text
Watcher exact Change
  -> Signal + rule-card snapshot
  -> card inbox / market-once claim
  -> batch + child ledger
  -> current selection relock
  -> account-owned session + fresh balance
  -> strict Preview
  -> reserve + durable submit attempt
  -> single Submit
  -> accepted / rejected / unknown
  -> reconciliation or manual review
```

SQLite 继续作为 intent、batch、child、attempt、account lock、market-once、outcome 和 reconciliation 的唯一事实源。调用方不能注入 capability、wire form、current identity、server limits 或 accepted 结论。

## 文件边界

阶段一主要涉及：

- `src/crown/betting/real-betting-runtime.mjs`
- `src/crown/app/app-api.mjs`
- `src/crown/app/betting-process.mjs`
- `src/crown/betting/real-worker-factory.mjs`
- `tests/crown-real-betting-runtime.test.mjs`
- `tests/crown-app-api.test.mjs`
- `tests/crown-betting-process.test.mjs`
- `tests/crown-operations-summary.test.mjs`
- 当前状态文档

阶段二原则上只新增验收脚本、fixture、审计报告和必要的可观察性测试；如果验收暴露生产 bug，必须回到独立 TDD 修复任务，不能现场放宽门禁。

阶段三只修改对应协议 mapper/parser/provider、capability matrix、reconciliation store/worker 及其测试；不同 capability family 不在同一任务内同时开放。

## 验证策略

每个实现任务遵循 RED -> GREEN -> focused regression -> 独立复核。阶段完成门槛：

- 阶段一：完整 backend 串行全绿、syntax 全绿、frontend 全绿、production build 通过；正式 runtime 状态与 API/页面一致；未发送真实请求。
- 阶段二：每级验收都必须位于 standing authorization 的账号、capability 和金额上限内，并具备脱敏证据、账本一致性检查和停止条件；任何 unknown 都阻止进入下一级。
- 阶段三：每个 row 的 fixture、matrix、mapper/parser、Provider、恢复和安全扫描通过；未取得证据的 row 仍为 0。

## 文档与发布

- 当前状态只在项目记忆、模块汇总、协议模块和 README 各保留一个权威摘要，历史阶段明确标记为历史。
- 计划和验收报告不得记录账号、密码、cookie、token、完整 uid、原始响应、完整注单 ID 或私有绝对路径。
- 用户已明确要求全部开发和检测通过后发布 GitHub；因此最终阶段可以按发布计划显式 stage、commit、PR、merge 和 Release。各开发阶段不得提前 push/merge，且只能提交审计后的本任务文件，不能夹带 runtime、凭据或无关用户改动。
- Portable 与 GitHub 发布是本路线图的最终阶段，不另建独立项目或并行产品；完成版必须合并到现有仓库默认分支，并直接接替当前 README、源码和 latest 下载版本。
- 所有投注阶段完成后执行独立 Release Gate：完整 backend/frontend/syntax/build、Watcher/Worker 运行态、浏览器主要流程、敏感扫描、release allowlist、锁定 Node/Chromium、clean-checkout、仓库外 cwd smoke 和 Fresh Windows 证据必须全部通过。
- GitHub 远程为 `Austin-C1/hg-`。发布不是建立独立程序：候选通过全部 Gate 后直接 fast-forward 替代现有默认分支 `main` 的程序，并使用 `0.2.0`、tag `v0.2.0` 和新的完整 Portable ZIP；新 Release 设为 latest，旧 tag/Release 只保留用于回滚，不覆盖或删除历史资产。
- 当前工作区是混合脏工作区；发布前必须建立显式 source allowlist，逐项确认 intended diff，禁止直接 `git add -A` 把 runtime、凭据、数据库、session、日志或 private capture 推上 GitHub。

## 交付物

设计批准后生成：

1. `docs/superpowers/plans/2026-07-14-crown-betting-remaining-work-roadmap.md`
2. `docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md`
3. `docs/superpowers/plans/2026-07-14-crown-betting-controlled-live-acceptance.md`
4. `docs/superpowers/plans/2026-07-14-crown-betting-reconciliation-and-capability-expansion.md`
5. `docs/superpowers/plans/2026-07-14-crown-full-validation-and-github-release.md`
