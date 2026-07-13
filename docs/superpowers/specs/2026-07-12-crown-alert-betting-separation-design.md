# Crown 监控报警与投注规则分离设计

> 历史状态：本文件中的固定赛前/滚球投注设置或统一监控投注规则已被
> `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` 取代。
> 其余历史验收证据保留，不作为当前实现入口。

日期：2026-07-12

## 1. 目标

把当前“监控运行状态”和“监控投注规则”重新拆成两个职责明确、数据独立的功能：

1. **监控报警**：判断赛前或滚球赔率变化是否命中报警条件，命中后生成标准 Signal，并投递赔率变化 Telegram 通知。
2. **投注规则**：消费监控 Signal，检查反方向盘口的实际投注赔率、账号容量与 Crown 限额，创建并执行自动投注任务。

两者在页面、配置、数据库表、API、运行模块和任务上独立，只共享 Watcher 产生的权威赔率事实、标准 Signal 契约和必要的基础设施。

## 2. 已确认的产品规则

- 系统只有一份监控报警配置和一份投注配置，不提供规则列表、优先级、克隆、归档或多规则竞争。
- 两份配置都包含 `prematch` 和 `live` 两个固定分支，页面表现为左右两张大卡片。
- 赛前与滚球可以同时开启，不再互斥。
- 监控报警卡片允许独立勾选让球、大小球或两者；至少选择一种盘口类型才能启用。
- 投注规则不重复选择盘口类型，直接继承 Signal 命中的盘口类型、盘口线和选项。
- 监控使用“动水阈值”，赔率上涨和下降达到阈值都生成报警 Signal；自动投注资格固定为“仅升水打对面盘”：
  - 主队升水 → 投客队；
  - 客队升水 → 投主队；
  - 大球升水 → 投小球；
  - 小球升水 → 投大球。
- 反打必须保持同一赛事、模式、时段、盘口类型和盘口线，不跨线、不猜测相邻盘口。
- 监控命中后同时创建两个互不阻塞的任务：赔率报警 TG 任务和自动投注 inbox。下降 Signal 的 inbox 仅保留审计证据，消费者在查询 selection、领取盘口或创建批次前稳定写为 `skipped/water-down-alert-only`。
- 对应投注卡关闭时仍发送赔率报警，但不创建真实投注批次。
- 全局真实投注开关继续保留在运行控制台；模式投注开关与全局开关必须同时开启才允许真实下注。
- `rejected` 不转投，`unknown` 不重投并保留账号锁。
- 只有 Crown 返回 `accepted` 才通过投注机器人发送投注成功 TG。

## 3. 信息架构与页面

### 3.1 导航

| 当前名称 | 新名称 | 主路由 |
|---|---|---|
| 监控运行状态 | 监控报警 | `/monitor-alerts` |
| 监控投注规则 | 投注规则 | `/betting-rules` |

兼容路由：

- `/monitor-settings` 重定向到 `/monitor-alerts`；
- `/auto-bet-rules` 重定向到 `/betting-rules`。

### 3.2 监控报警页面

页面标题为“监控报警”，主体是赛前报警和滚球报警两张等宽大卡片。两张卡片可同时启用。

每张卡片拥有独立配置：

- 启用开关；
- 盘口类型多选：让球、大小球；
- 监控赔率下限、上限；
- 动水阈值（上涨、下降均监控）；
- 报警冷却时间；
- 备注；
- 最近报警时间；
- 当前命中与投递摘要。

赛前卡片额外配置：

- 开赛前开始监控分钟数；
- 开赛前停止监控分钟数。

滚球卡片额外配置：

- 开始分钟、结束分钟；
- 上半场、半场、下半场阶段选择。

页面底部保留折叠的监控健康、待发送通知、死信和数据质量诊断。这些是报警链路诊断，不承担 Watcher 进程启停；Watcher 启停继续由运行控制台和监控账号页管理。

### 3.3 投注规则页面

页面标题为“投注规则”，主体是赛前投注和滚球投注两张等宽大卡片。两张卡片可同时启用。

每张卡片拥有独立配置：

- 自动投注启用开关；
- 反方向实际投注赔率下限、上限；
- 一条 Signal 的目标投注总金额（整数 CNY）；
- 备注；
- 最近收到 Signal、最近创建批次、最近完成结果摘要。

页面不再出现：

- 规则列表；
- 新增、克隆、归档、拖拽排序；
- 监控方向或投注方向选择；
- 盘口类型选择；
- 联赛选择；
- 全局真实投注开关。

联赛范围继续由默认联赛和手动追踪比赛决定；报警方向固定为上涨、下降都监控，投注方向仅对上涨 Signal 按“升水打对面盘”派生；全局真实投注由运行控制台管理。

## 4. 数据模型

### 4.1 监控报警配置

新增独立表 `monitor_alert_settings`，以 `mode` 为主键，只允许 `prematch`、`live` 两行。

关键字段：

```text
mode
enabled
asian_handicap_enabled
total_enabled
monitor_odds_min
monitor_odds_max
water_move_threshold
cooldown_seconds
start_minutes_before_kickoff
stop_minutes_before_kickoff
live_minute_from
live_minute_to
include_first_half
include_half_time
include_second_half
remark
migration_review_required
migration_review_reason
version
created_at
updated_at
```

约束：

- 至少一个盘口类型启用后，模式才可启用；
- 赔率、阈值和分钟范围必须使用规范有限数值；
- 赛前分支禁止保存滚球字段，滚球分支禁止保存赛前字段；
- 更新使用版本 CAS，防止两个页面状态覆盖。

### 4.2 投注配置

新增独立表 `auto_betting_settings`，同样以 `mode` 为主键，只允许 `prematch`、`live` 两行。

关键字段：

```text
mode
enabled
target_odds_min
target_odds_max
target_amount_minor
currency = CNY
amount_scale = 0
remark
real_eligible
real_eligibility_version
real_eligibility_updated_at
migration_review_required
migration_review_reason
version
created_at
updated_at
```

约束：

- 目标金额必须为大于 0 的 JavaScript safe integer；
- 目标赔率区间检查 Signal 命中选项的反方向 selection；
- 启用投注分支不自动打开全局真实投注；
- 更新使用版本 CAS。
- `real_eligible` 不由投注规则页面或普通 PUT 修改；它继续使用独立确认、环境绑定和审计流程升级。模式 `enabled`、`real_eligible`、全局真实投注意图、ExecutionAuthorization 与 capability/lease/fence 必须全部通过，才允许真实提交。

### 4.3 数据所有权

- `monitor_alert_settings` 不保存投注赔率、金额、账号或真实投注权限。
- `auto_betting_settings` 不保存动水阈值、盘口类型、监控时间窗或报警冷却。
- 两张表不通过规则 ID 互相绑定，也不在运行时拼接成一条可编辑规则。
- `monitor_signals` 只保存事实、触发依据和监控配置版本快照。
- 自动投注任务创建时保存投注配置版本与不可变快照，已入队任务不受后续页面修改影响。

### 4.4 自动投注 inbox 与执行身份

新增 `auto_betting_signal_inbox`。每个 Signal 固定一行，以 `signal_id` 唯一；包含 `mode`、`settings_version`、`settings_snapshot_json`、`status`、`skip_reason`、`attempts`、`next_attempt_at`、`lease_owner`、`lease_expires_at`、`batch_id`、`created_at`、`updated_at`。状态只允许 `pending`、`processing`、`retry`、`skipped`、`batch_created`、`dead_letter`。

- Signal 事务创建 inbox 时读取对应模式的投注配置并固化快照。消费者只使用该快照判断模式是否启用、目标赔率区间和目标金额；页面后续修改不追溯影响已入队任务。
- 命中时投注模式关闭、迁移待复核、配置不合法或 Signal 为下降方向时，inbox 仍作为审计证据持久化，但消费者稳定写为 `skipped`，不得等以后开启后补投旧 Signal；下降方向理由固定为 `water-down-alert-only`，且必须早于 selection 查询、盘口领取和批次创建。
- 全局紧急停止、ExecutionAuthorization、capability、lease 与 fence 属于执行时安全门禁，不被快照绕过；门禁不通过时不得创建可提交批次。
- 新链路使用 `betting_mode + settings_version` 作为执行配置身份，不再以可编辑 `rule_id` 绑定监控与投注。`bet_batches`、market-once claim 和授权 scope 增加 mode/settings 身份；旧 `rule_id` 与旧授权字段只读保留历史证据，不用于新任务。
- ExecutionAuthorization 的新 scope 是明确的 `prematch`/`live` 模式集合与对应 eligibility version；授权不能覆盖未升级 `real_eligible` 的模式，也不能因普通配置保存而自动扩大。

## 5. 运行链路

### 5.1 监控与 Signal

1. Watcher 写入权威 SnapshotBatch 和 Change。
2. 监控报警引擎只读取对应模式的 `monitor_alert_settings`。
3. 检查默认联赛/手动追踪范围、盘口类型、监控赔率、动水阈值、时间窗和冷却；上涨或下降达到阈值均命中。
4. 命中后持久化唯一 Signal，包含赛事、模式、时段、盘口类型、盘口线、变化方向、命中选项、新旧赔率和事实时间。
5. Signal 事务内创建赔率报警 outbox 和自动投注 inbox 两项任务；两项任务分别领取、分别重试。

赔率报警发送失败不能回滚 Signal，也不能阻塞投注 inbox。

### 5.2 自动投注检查

自动投注消费者领取 Signal 后按顺序执行：

1. 检查 inbox 固化的对应模式投注配置是否启用、是否已完成迁移复核且快照合法；
2. 检查 Signal 方向；下降方向稳定 `skipped/water-down-alert-only`，不进入任何盘口或批次工作；
3. 检查全局真实投注意图和安全预检；
4. 对上涨 Signal 从 Signal 固定派生命中选项的反方向 selection；
5. 使用最新权威盘口核对同一赛事、模式、时段、盘口类型、盘口线和反方向；
6. 检查该 selection 当前赔率是否位于 `target_odds_min/max`；
7. 原子认领 `marketOnceKey = event + mode + period + marketType + line + targetSide`；
8. 读取已启用账号、Fresh Crown 登录、CNY 余额、账号单笔上限和现有锁；
9. 逐账号调用只读 Crown preview，读取该盘口真实 min/max/step、当前盘口线与赔率；
10. 按账号顺序计算目标金额分配；
11. 在一个 `BEGIN IMMEDIATE` 事务内创建 Batch、Child、金额预留和账号锁；
12. 各账号串行队列执行，不同账号允许并行；
13. 记录 `accepted/rejected/unknown` 并更新批次。

金额分配：

```text
accountAmount = min(
  remainingTarget,
  accountPerBetLimit,
  providerMaxStake,
  spendableBalance
)
```

金额还必须满足 provider min/step。总容量不足允许部分分配，未分配金额记录为 `unfilled`。

### 5.3 结果与 Telegram

- 赔率报警由赔率报警机器人发送，内容来自 Signal。
- 每个 accepted Child 持久化投注成功通知 outbox，由投注机器人发送；发送失败按现有通知重试机制处理，不改变投注结果。
- rejected Child 终止自身，不把金额转给其他账号。
- unknown Child 保留金额暴露与账号锁，等待人工处理或对账，绝不自动重投。
- 批次可以是 `completed`、`partial`、`failed`、`cancelled` 或 `waiting_result`；TG 文案不得把 partial/rejected/unknown 写成成功。
- 尚无 accepted/unknown 且因人工取消、Signal 过期、全局停止、盘口线变化、盘口身份变化或阶段变化终止时，批次为 `cancelled` 并保存稳定 `finish_reason`；已有 accepted 且剩余部分停止时为 `partial`；存在 unknown 时为 `waiting_result`。

## 6. API 边界

监控报警 API：

```text
GET /api/app/monitor-alert-settings
PUT /api/app/monitor-alert-settings/prematch
PUT /api/app/monitor-alert-settings/live
```

投注配置 API：

```text
GET /api/app/auto-betting-settings
PUT /api/app/auto-betting-settings/prematch
PUT /api/app/auto-betting-settings/live
```

要求：

- 两组 DTO 不包含对方字段；
- mutation 使用 same-origin CSRF；
- API 返回稳定中文可映射错误码；
- 旧规则 CRUD API 在迁移完成后只保留兼容读取或返回明确 retired 错误，不再接受新增多规则。

## 7. 运行控制台

运行控制台继续负责：

- Watcher 启动、停止与新鲜度；
- 监控报警赛前/滚球开启摘要；
- 投注规则赛前/滚球开启摘要；
- 可用账号、余额新鲜度和锁；
- 全局真实投注开启与紧急停止；
- unknown、对账、通知积压和每日完全重置。

全局真实投注开启条件至少包括：

- Watcher 单实例且赔率 fresh；
- 至少一个监控报警模式启用；
- 同一模式的投注配置启用且合法；
- 至少一个可用投注账号；
- capability、authorization、executor/reconciler lease 和 fence 全部通过。

## 8. 迁移

1. 创建两张新配置表并插入赛前、滚球默认关闭行。
2. 从现有 `config/monitor-settings.json` 迁移能够明确映射的报警字段。
3. 从现有 canonical 赛前/滚球模板迁移能够明确映射的投注赔率区间、目标金额和开关。
4. 字段证据不足时保持关闭并标记迁移复核，不猜测金额、赔率、盘口或权限。
5. 迁移前后保留旧表与 JSON 作为只读证据；新链路验证完成前不删除。
6. 新运行路径只读新配置；旧多规则写 API retired。
7. 迁移不得开启任何监控、投注模式或全局真实投注，也不得调用 Crown submit。

迁移细则：

- 两张新设置表的 `enabled`、投注表的 `real_eligible` 一律初始化为 false；旧开关只写入迁移证据和复核原因，绝不直接变成新开关。
- `config/monitor-settings.json` 只迁移可逐字段证明的赔率、阈值、冷却和时间窗；旧配置没有让球/大小球勾选证据时，两种盘口均保持 false，模式保持关闭并标记复核。
- 旧 canonical 规则只迁移 mode 一致、数值类型明确且无歧义的目标赔率和整数 CNY 金额；多条规则冲突、金额为 0、字段缺失或 legacy review 未完成时不选赢家，模式保持关闭并标记复核。
- 迁移可重复运行；已有人工保存的新设置不得被后续启动覆盖。

## 9. 故障处理

- 报警 TG 失败：进入 retry/dead-letter，不影响自动投注任务。
- 投注配置关闭或不合法：记录稳定 skip reason，不影响报警。
- 目标赔率不命中：记录 `target-odds-out-of-range`，不锁账号。
- 盘口线或身份变化：取消尚未提交部分并释放可证明未提交的预留。
- 账号容量不足：允许部分投注；完全无容量时记录 `no-account-capacity`。
- Provider preview 不完整：fail-closed，不猜 min/max/step。
- Submit 超时或断线：进入 unknown，保留锁且不自动重投。
- 投注成功 TG 失败：只重试通知，不重复下注。

## 10. 验证与验收

### 10.1 数据与 API

- 两张配置表只有 prematch/live 两行并满足字段约束。
- 报警 API 不返回投注字段，投注 API 不返回报警字段。
- CAS 冲突不会覆盖较新配置。
- 迁移重复运行幂等，证据不足保持关闭。

### 10.2 监控与任务

- 赛前、滚球报警可同时启用。
- 让球、大小球可单独或同时勾选，未勾选不能启用。
- 一次监控命中只生成一个 Signal，但同时产生两个独立任务。
- TG 失败不影响投注；投注 skip/failure 不影响赔率报警。

### 10.3 投注

- 赛前、滚球投注可同时启用。
- 目标赔率检查反方向 selection，并保持原盘口线。
- 多账号按顺序填充，允许部分分配。
- provider min/max/step、账号限额、余额和锁共同约束分配。
- 同一盘口只投注一次；rejected 不转投；unknown 不重投。
- accepted 才创建投注成功 TG outbox。

### 10.4 页面

- 导航只显示“监控报警”和“投注规则”。
- 两个页面均为赛前/滚球左右双卡片，桌面与窄屏无横向溢出。
- 不出现规则列表、新增、克隆、归档、排序或方向选择。
- 运行控制台显示两个模式的报警与投注状态，并保留全局真实投注总开关。

## 11. 非目标

- 不增加多监控规则或多投注规则。
- 不增加规则绑定、优先级、别名匹配或动态组合。
- 不自动填入投注金额、赔率范围或盘口类型。
- 不放宽 Crown capability 证据门禁。
- 不改变每日完全重置的手动触发原则。
- 不在本次设计中删除历史协议证据或运行依赖。
