# 皇冠动态投注规则卡片设计

日期：2026-07-12  
状态：当前权威设计，已离线实现并进入最终验收；正式库迁移与 8787 重启未执行

本设计取代 `2026-07-12-crown-alert-betting-separation-design.md` 中“按 prematch/live 固定两行投注配置”的页面、数据模型和执行身份设计。监控报警仍按赛前/滚球分开配置；投注规则不再区分模式，只消费报警产生的 Signal。

## 1. 已确认业务规则

- 投注规则由用户手动新增，可存在多张卡片并同时启用。
- 卡片不保存或选择赛前/滚球；Signal 的真实模式继续进入 inbox、批次和执行安全范围。
- 每张卡片必须填写名称、至少一个联赛、目标水位上下限和正整数 CNY 金额，备注可选。
- 联赛支持多选。选中联赛后，该联赛今天全部报警比赛都可匹配。
- 联赛选择禁止空白，停用卡片也不能保存残缺配置。
- 今日可选联赛只包含：今天实际有比赛且命中启用默认白名单的联赛，以及今天手动追踪比赛所属联赛。
- 手动追踪联赛自动进入今日可选联赛，但必须被卡片显式选择才可投注。
- 一个联赛只能属于一张现存卡片；停用卡片仍占用联赛，物理删除卡片后释放。
- 一个 Signal 最多匹配一张卡片。
- 同一卡片对同一赛事、Signal 模式、时段、盘口类型、盘口线和对面盘最多投注一次。
- 上涨 Signal 才能创建投注批次；下降只报警；其他异常方向 fail-closed。
- 删除卡片会跳过尚未创建批次的任务；已创建批次继续按不可变快照完成。
- 普通删除不删除历史订单；“每日开工完全重置”清理运行历史和规则快照，但保留现存卡片配置。

## 2. 页面与交互

`/betting-rules` 页面标题仍为“投注规则”，顶部说明改为“报警命中后，按所选联赛独立创建同盘口线对面盘投注任务”。页面右上角提供“新增投注规则”。

新增和编辑均使用弹窗，卡片本身只展示摘要：

- 规则名称；
- 启用/停用状态；
- 已选联赛标签；
- 目标水位区间；
- 目标投注金额；
- 真实执行资格与迁移复核状态；
- 最近 Signal、最近批次和最近结果摘要；
- 编辑、删除操作。

表单字段固定为：

```text
name
enabled
leagueNames[]
targetOddsMin
targetOddsMax
targetAmountMinor
remark
expectedVersion（编辑时）
```

不提供 mode、period、marketType、monitoredSide、动水阈值、监控时间窗或投注方向。

联赛下拉从新的“今日可用联赛”API 读取。被其他现存卡片占用的联赛仍显示，但禁用并标注占用卡片名称；编辑当前卡片时，其自有联赛正常可见、可保留或取消。若自有联赛当天已无比赛，显示“今日不可用”，但允许原样保留；不能把其他今日不可用名称新增到卡片。表单保存前后端都要求至少一个联赛。

删除使用二次确认。删除成功后卡片消失，原联赛立即可被其他卡片选择。

## 3. 今日可用联赛

今日可用联赛是当前监控事实与配置的交集，不等于静态默认联赛全集：

1. 从 `monitor_event_state` 读取 kickoff 落在 Asia/Shanghai 今天且仍 active 的事件联赛；
2. 只保留命中已启用默认白名单且 mode 允许的联赛；
3. 将 `tracked_matches` 中 active 手动追踪项与今天 active event 按 event identity 连接，合并这些比赛的联赛；
4. 输出联赛名称、来源（`default`/`manual`/`both`）、今日比赛数、占用卡片 ID 与名称。

“今天”统一使用 Asia/Shanghai 日期边界。保存卡片时服务器重新计算当前今日可用联赛：POST 的全部联赛必须当前可用；PUT 可以保留该卡片原有但今日不可用的联赛，但新增值必须当前可用。已经保存在卡片中、但第二天不再属于今日可用范围的联赛名称继续保留并继续占用；当天不匹配，未来再次出现时自动恢复。

## 4. 数据模型

### 4.1 动态卡片

新增 `auto_betting_rule_cards`：

```text
card_id TEXT PRIMARY KEY
name TEXT NOT NULL
enabled INTEGER NOT NULL
target_odds_min TEXT
target_odds_max TEXT
target_amount_minor INTEGER
currency TEXT NOT NULL CHECK currency='CNY'
amount_scale INTEGER NOT NULL CHECK amount_scale=0
remark TEXT NOT NULL
real_eligible INTEGER NOT NULL DEFAULT 0
real_eligibility_version INTEGER NOT NULL DEFAULT 1
real_eligibility_updated_at TEXT NOT NULL
migration_review_required INTEGER NOT NULL DEFAULT 0
migration_review_reason TEXT NOT NULL
version INTEGER NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

目标赔率继续使用 canonical decimal TEXT；金额使用 positive JavaScript safe integer。

### 4.2 联赛独占

新增 `auto_betting_rule_card_leagues`：

```text
card_id TEXT NOT NULL REFERENCES auto_betting_rule_cards(card_id) ON DELETE CASCADE
league_name TEXT NOT NULL UNIQUE
created_at TEXT NOT NULL
PRIMARY KEY(card_id, league_name)
```

`UNIQUE(league_name)` 是联赛独占的最终约束。新增、编辑、删除必须使用 `BEGIN IMMEDIATE`，并发抢占同一联赛时只能一方成功。API 把冲突转换为稳定错误 `league-owned-by-another-card`，返回安全的占用卡片名称。

### 4.3 inbox 与批次身份

`auto_betting_signal_inbox` 增加 `card_id`、`card_version`、`card_snapshot_json`，唯一身份改为 `(signal_id, card_id)`。批次、market-once claim、ExecutionAuthorization scope 和审计增加 card identity；历史 mode/settings 字段保留只读兼容，不作为新任务的规则身份。

新 market-once key：

```text
cardId + event + signalMode + period + marketType + line + targetSide
```

卡片被删除后，历史 inbox、批次和 child 不依赖外键回读配置；它们只使用不可变快照。历史表中的 `card_id` 是审计文本身份，不对卡片配置表建立阻止物理删除的外键。

## 5. API

新增正式接口：

```text
GET    /api/app/auto-betting-rule-cards
POST   /api/app/auto-betting-rule-cards
PUT    /api/app/auto-betting-rule-cards/:cardId
DELETE /api/app/auto-betting-rule-cards/:cardId
GET    /api/app/today-betting-leagues?cardId=<editing-card>
```

GET 返回卡片摘要与运行摘要；POST/PUT 返回完整 canonical DTO。PUT 必须带 `expectedVersion`，CAS 冲突返回 `auto-betting-card-version-conflict`。普通 PUT 不能修改 `realEligible` 或 eligibility version。

DELETE body 固定为 `{ expectedVersion }`，并在一个事务内：

1. 校验卡片存在和 `expectedVersion`；
2. 将该卡片尚未绑定 batch 的 pending/retry/processing inbox 终结为 `skipped/rule-deleted`；
3. 删除卡片，级联删除联赛占用；
4. 保留所有已创建批次和不可变历史快照。

旧固定 `auto-betting-settings` API 改为只读迁移证据后退役写接口；旧 `betting-rules`/`auto-bet-rules` mutation 继续保持退役，不能重新成为新页面后端。

## 6. Signal 与执行链路

Signal 持久化事务读取当前启用卡片及联赛独占表。只有 Signal 联赛同时满足以下条件时才创建 card inbox：

- 当前属于今日可用联赛；
- 被一张启用卡片明确选择；
- 卡片已完成迁移复核且快照完整。

唯一联赛约束保证最多命中一张卡片。Signal 事务继续独立创建 Telegram delivery；没有匹配卡片时仍保留 Signal 和报警任务，不创建投注 inbox。

消费者顺序：

1. 验证 Signal、card identity 和不可变快照；
2. 重新确认 card 仍存在；删除则 `skipped/rule-deleted`；
3. `down` 写 `skipped/water-down-alert-only`，其他非 `up` 写 `skipped/signal-invalid`；
4. 检查卡片启用、复核、真实资格和全局真实投注意图；
5. 锁定同赛事、真实 Signal mode、时段、盘口类型、盘口线的对面 selection；
6. 检查目标水位；
7. 以 card-scoped market-once key 原子创建批次；
8. 继续现有账号顺序分配、授权、lease/fence、B2 submit/recovery/reconciliation。

`rejected` 不转投，`unknown` 不重投并保留金额与账号锁。已创建批次不因卡片编辑、停用或删除而改变。

## 7. 旧配置迁移

现有 `auto_betting_settings` 两行自动生成两张卡片：

- `prematch` → “原赛前投注”；
- `live` → “原滚球投注”。

迁移复制有证据的赔率、金额和备注，但不复制 mode 限制，也不把旧 `real_eligible=true` 扩大到新卡片。旧 eligibility 元数据继续保留在旧表作为证据；两张新卡固定 `enabled=false`、`real_eligible=false`、`migration_review_required=true`。联赛为空只允许作为迁移中间状态存在，不能通过普通 POST/PUT 创建或保存为空。用户编辑时必须选择今日可用联赛并补齐所有字段；完整保存后原子完成迁移复核，真实资格仍需独立升级。

迁移幂等，不覆盖 version>1 的人工卡片，不自动升级真实资格，不删除旧表。

## 8. 保存失败修复与版本一致性

已确认当前 8787 进程启动早于 `waterRiseThreshold` → `waterMoveThreshold` 改名，运行旧后端但从磁盘提供新前端，导致 PUT `validation-error`，数据库列迁移后 GET 进一步返回 500。

修复包含：

- 重启 Dashboard，使运行后端、前端构建和数据库 schema 同版本；
- 暴露安全的 `appContractVersion`、`frontendContractVersion`、`schemaVersion`；
- 页面发现版本不一致时禁止编辑并提示“Dashboard 已升级，请重启”；
- API 将字段级 validation details 返回前端，页面显示具体中文错误；
- 监控报警完整保存时提供显式迁移复核完成路径，不能永久停留在 review-required。

## 9. 运行控制台与清理

运行控制台的投注规则摘要改为：卡片总数、启用数、待复核数、已占用联赛数和最近任务。删除固定 prematch/live 投注 readiness 交集；每个任务按自身 Signal mode 和 card snapshot 进入现有安全门禁。

“每日开工完全重置”继续保留卡片和联赛占用配置，清理 Signal、Telegram/inbox 运行状态、批次、child、market-once、账号锁、pending/unknown、提交/对账和规则快照历史。清理前停止投注执行并保持现有二次确认。

## 10. 文档整理

更新当前权威文档：

- `README.md`
- `docs/project-memory.md`
- `docs/module-index.md`
- `docs/crown-current-architecture.md`
- `docs/modules/crown-dashboard.md`
- `docs/modules/crown-football-monitor.md`
- `docs/modules/crown-betting-protocol.md`

删除当前文档中失效的固定赛前/滚球投注卡片、统一监控投注规则和尚未接入执行器等描述。历史 specs/plans/reports 不删除、不改写历史结论，在文件头标注“已被动态投注规则卡片设计取代”并链接本设计。`docs/module-index.md` 明确当前权威入口，最新验证基线只在项目记忆和进度文件维护。

## 11. 错误处理与验收

稳定错误至少包括：

```text
league-required
league-not-available-today
league-owned-by-another-card
auto-betting-card-version-conflict
rule-deleted
migration-review-required
contract-version-mismatch
```

必须覆盖：schema/迁移幂等、赔率 TEXT 精度、联赛必选、今日选项、手动联赛、停用卡片占用、并发唯一抢占、删除释放、Signal 单卡匹配、mode 透传、上涨/下降门禁、card-scoped market-once、删除竞态、不可变快照、清理边界、Operations 投影、API 安全与字段脱敏、桌面/移动端弹窗和卡片浏览器验收。

本设计的历史验收轮次最终运行完整 backend、syntax、frontend、production build、Compose config；真实 Crown capability 当时为 `0/0/0`，该轮未自动开启真实投注，也未执行 Crown/TG 网络或真实订单。当前 capability 以 Task 10 的 exact row `prematch/full_time/asian_handicap/main` Preview/Submit/Reconciliation `1/1/0` 为准；其他 row 与 Reconciliation 关闭，真实 runtime 默认 off。
