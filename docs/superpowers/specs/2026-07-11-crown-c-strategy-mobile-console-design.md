# Crown C 阶段：统一监控投注规则、真实自动下注与运维控制台设计

> 历史状态：本文件中的固定赛前/滚球投注设置或统一监控投注规则已被
> `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` 取代。
> 其余历史验收证据保留，不作为当前实现入口。

日期：2026-07-11  
状态：用户已确认，进入实施计划  
范围顺序：C1 统一规则 → C2 真实协议与自动执行 → C3 账号操作 → C4 运维控制台

## 1. 目标

C 阶段把监控、升水反打、金额分配、账号队列和真实 Crown 提交串成一条可操作、可审计的自动投注流程。

用户只维护两类配置：

1. 统一监控投注规则：配置监控条件、反打水位和目标总金额；
2. 投注账号：配置登录信息、投注顺序、单笔上限和启用/暂停状态。

后台继续保留 Signal、Candidate、Batch、Child Order、Submit Attempt 和 Reconciliation 等安全账本，但页面不要求用户理解或手工绑定这些内部对象。

## 2. 已确认业务决策

- 采用一个 canonical 统一规则，不再要求“监控策略绑定下注规则”。
- C 首版只支持 `odds_delta` 的升水反打，不增加趋势、脚本或表达式策略。
- 一条规则可选择多个联赛；联赛只按 Crown 精确名称匹配。
- 同一变化命中多条规则时，只有优先级最高的规则取得投注资格。
- 监控方升水后，实际投注相反方向；投注水位范围检查实际反打方向。
- 实际投注水位只在生成投注预备时验证一次；进入队列后水位变化不停止订单。
- 每个账号真正提交前重新核对比赛、阶段、玩法、盘口线和实际方向；盘口线变化停止尚未提交的任务。
- 同一“比赛 + 阶段 + 玩法 + 盘口线 + 实际投注方向”最多产生一个投注批次。
- 盘口线变化后视为新盘口，可以再次投注一次。
- 账号按投注顺序依次填满；允许组合金额低于规则目标金额。
- 明确 `rejected` 后不把该金额重新分配给其他账号。
- `unknown` 不重投，继续冻结金额和账号锁，等待对账。
- 不设置全局、规则或账号每日投注上限；当日累计只展示、不拦截。
- 全局真实投注开关持久保存；重启后先完成安全预检，通过后自动恢复。
- 首次真实运行不限制为单笔验证模式；通过全部门禁的规则可以持续产生真实订单。
- 投注账号不再配置金额精度或投注步进；用户金额统一为 CNY 整数。
- Crown 预览返回的 provider 最低金额、最高金额和步进仍由程序自动校验，但不作为账号配置展示。
- 每个账号卡片提供“暂停/启用”按钮。暂停后不接收新任务，已有队列继续执行；队列清空后成为已暂停。
- 默认 Dashboard 继续本机免密、仅监听 `127.0.0.1`；C 阶段不自动开放 LAN 或公网。

## 3. 统一规则

继续使用现有 `betting_rules` 作为唯一事实源，扩展为统一监控投注规则，避免新建一套隐藏绑定。

canonical DTO：

```text
id
name
version
priority
monitorEnabled
realBettingEnabled
archived
leagueNames[]
mode = prematch | live
period = full | first_half | second_half
marketType = asian_handicap | total
monitoredSide = home | away | over | under
minWaterRise
targetOddsMin
targetOddsMax
startMinutesBeforeKickoff | null
stopMinutesBeforeKickoff | null
liveMinuteFrom | null
liveMinuteTo | null
targetAmountMinor
currency = CNY
amountScale = 0
createdAt
updatedAt
```

约束：

- `monitoredSide` 必须与 `marketType` 相容；让球只允许 home/away，大小球只允许 over/under。
- 实际投注方向由固定反向函数得到：home↔away、over↔under。
- `targetOddsMin/Max` 检查反打后的实际 selection。
- `targetAmountMinor` 为正整数；CNY scale 固定为 0。
- 赛前规则必须配置开赛前起止窗口；滚球规则必须配置比赛分钟范围。
- 改变匹配或金额语义时要求 `expectedVersion`，事务内 CAS 成功后 version + 1。
- 优先级为正整数，数字越小越优先；页面支持上移、下移和拖拽排序。
- 已被 Signal/Batch 引用的规则只归档，不硬删除。

## 4. 规则迁移

一次性迁移使用确定性 migration key，重复启动不得重复导入：

1. 归档 `brule_manual`、`manual-dry-run` 等占位规则；
2. 旧赛前卡生成 `legacy-prematch` 统一规则，旧滚球卡生成 `legacy-live` 统一规则；
3. 原监控条件、启停状态、时间窗口和水位范围原样复制；
4. 如果旧卡绑定存在的有效 BettingRule，则复制其联赛和目标金额；
5. 如果未绑定有效规则，则目标金额为 0、两个启用开关均关闭，并标记 `migrationReviewRequired=true`；用户填写金额后才能启用；
6. 迁移完成后 watcher 只读取 SQLite 统一规则；旧 JSON 卡只保留只读迁移证据，旧写 API 返回稳定的 retired 错误。

当前实际数据库只有停用的 `brule_manual` 占位规则，因此本机迁移会生成两条停用模板，不会意外开启投注。

## 5. 触发与一次性语义

每个 authoritative odds change 按以下顺序处理：

1. 读取同一 revision 的全部启用规则；
2. 按 priority、createdAt、id 稳定排序；
3. 判断精确联赛、mode、period、marketType、monitoredSide 和升水阈值；
4. 派生相反投注方向并检查该 selection 当前水位是否在规则范围；
5. 生成 `marketOnceKey = event + mode + period + marketType + line + actualSide`；
6. 用数据库唯一约束原子认领该 key；已有记录时只写 skip audit；
7. 多规则同时命中时，第一条成功认领者胜出，其余规则只记录命中和优先级落选原因。

同一盘口的第一次批次无论 accepted、rejected、unknown、部分成功或未完成，都永久占用该 `marketOnceKey`。盘口线变化产生新的 key。

## 6. 账号容量与组合

账号用户配置只保留：

```text
betOrder
status
allocationStatus = enabled | pause_pending | paused
perBetLimitMinor
currency = CNY
username / encrypted password / website
reportedBalance
accessStatus
```

`amountScale` 和 `stakeStep` 从 API/UI 退休；数据库旧列保留兼容并在迁移后固定为 scale=0、step=1。真实 preview 的 provider step 独立保存到 child/attempt 快照。

分配算法：

```text
accountAmount = min(remainingTarget, perBetLimit, spendableBalance)
```

- 只选择 allocationStatus=enabled、登录可用、余额新鲜、无活动锁的账号；
- 按 betOrder、createdAt、id 稳定排序；
- 对每个账号依次填满，再进入下一个账号；
- 只要总可分配金额大于 0 就创建批次，差额记为 unfilled；
- 组合计算、余额预留、账号锁、Batch 和 Child 创建必须在一个 `BEGIN IMMEDIATE` 事务内完成；
- rejected 只释放自身预留并结束，不重新分配；
- unknown 继续占用自身预留和账号锁。

## 7. 账号暂停与启用

### 暂停

- 点击“暂停”后立即把 allocationStatus 改为 `pause_pending`，allocator 不再选择该账号；
- 已经进入队列的 Child 继续执行；
- 已经提交的 Attempt 继续确认和对账；
- 无非终态 Child 时自动转为 `paused`；
- unknown 可以保留账号锁，但账号对新任务仍显示已暂停。

### 启用

- 点击“启用”先执行 fresh Crown 登录、只读赛事访问和余额读取；
- 检测成功且单笔上限为正整数后转为 `enabled`；
- 检测失败保持 `paused`，页面显示脱敏错误原因；
- 启用动作不改变全局真实投注开关。

## 8. 队列与提交

每个账号拥有独立串行队列，不同账号可以并发。

Child 执行步骤：

1. 获取账号 fenced lease；
2. 检查全局开关、规则开关、账号 allocationStatus（`pause_pending` 允许执行既有 Child）、authorization 和 capability；
3. 使用账号自身会话发起只读 order preview；
4. 核对 event、mode、period、marketType、line 和 actualSide；
5. 不再使用 preview odds 对规则水位范围二次判断；
6. 自动校验 provider min/max/step、账号单笔上限和已预留余额；
7. 持久化不可变 `submit_prepared` attempt 后调用 Crown submit；
8. 记录 accepted/rejected/unknown，绝不对 prepared/dispatched/unknown 自动重复提交。

盘口线或 identity 变化时取消该 Child 以及同批尚未提交的剩余 Child，并释放其预留。水位变化但 identity 不变时继续。

## 9. 真实投注开关与重启

三层条件必须同时满足：

```text
globalRealBettingRequested = true
rule.realBettingEnabled = true
account.allocationStatus = enabled（新分配）
```

全局开关持久化为“用户意图”，运行状态单独投影：

```text
off
armed_waiting
running
blocked
stopping
```

重启后如果用户意图仍为开启，先进入 `armed_waiting`。只有以下条件全部通过才进入 running：

- watcher lease 唯一且赔率数据 fresh；
- monitor account 登录正常；
- 至少一个投注账号 fresh login 和余额读取成功；
- capability matrix 对目标 preview/submit 组合有已验证证据；
- B2 executor/reconciler lease 正常；
- 数据库 schema、authorization、环境和 fence 一致。

紧急停止立即禁止新 Batch 和未准备的 Submit；已经 dispatched 的 Attempt 继续等待和对账。

## 10. Crown 真实协议能力门

当前 canonical capability matrix 的 preview/submit 可用行数为 0，因此实现代码完成不等于可以安全开启真实投注。

C2 必须逐个证明：

- prematch/live；
- full/first_half/second_half；
- asian_handicap/total；
- main/alternate line（只有实际取得证据的 line variant 才开放）；
- preview request、response fields、min/max/step、line、odds、balance；
- submit request、accepted/rejected/pending response；
- dangerous/today wagers reconciliation evidence。

每一项使用脱敏 fixture、字段 fingerprint 和 capability version。没有证据的组合 fail-closed，禁止用相似字段猜测。

用户选择首次真实自动运行不设单笔验证上限。因此计划不增加“第一笔后自动停止”，但仍必须先通过上述 capability/preflight；运行后所有合格信号可以持续提交。

## 11. 页面

### 统一监控投注设置

现有“赔率监控设置”和“下注规则设置”合并为一个入口：

- 规则列表、搜索、筛选、优先级排序；
- 新增、编辑、克隆、启停、归档；
- 同一表单配置监控范围、水位条件、目标整数金额和真实投注开关；
- 显示最近命中、marketOnce 状态、最近 Batch 和失败原因；
- 不显示 StrategyRule/BettingRule 绑定概念。

### 投注账号配置

- 卡片显示账号名、顺序、网址、单笔上限、登录访问、Crown 返回余额、执行状态；
- 移除金额精度和投注步进；
- 增加“暂停/启用”按钮和 `暂停中` 状态；
- 保留检测、编辑、删除和订单展开；
- unknown/locked 必须显眼显示。

### 运维控制台

C4 在 C1-C3 验收后实施，展示 watcher、数据新鲜度、全局真实投注状态、规则命中、账号、Batch、unknown、reconciliation 和通知积压。控制台不提供修改密码、人工伪造订单结果或查看 provider secret。

## 12. API

统一规则：

```text
GET    /api/app/auto-bet-rules
POST   /api/app/auto-bet-rules
PUT    /api/app/auto-bet-rules/:id
POST   /api/app/auto-bet-rules/:id/clone
POST   /api/app/auto-bet-rules/reorder
POST   /api/app/auto-bet-rules/:id/enable-monitor
POST   /api/app/auto-bet-rules/:id/disable-monitor
POST   /api/app/auto-bet-rules/:id/enable-real
POST   /api/app/auto-bet-rules/:id/disable-real
DELETE /api/app/auto-bet-rules/:id
```

账号与运行：

```text
POST /api/app/betting-accounts/:id/pause
POST /api/app/betting-accounts/:id/enable
GET  /api/app/real-betting-status
POST /api/app/real-betting/start
POST /api/app/real-betting/stop
GET  /api/app/operations-summary
```

所有 mutation 继续要求本机同源 Host/Origin 和 CSRF；API 不返回密码、cookie、uid、ticket、authorization 或明文 provider reference。

## 13. 验收标准

### C1

- 统一规则 CRUD、CAS、排序、迁移和 watcher 热加载通过；
- 实际投注水位检查反打后的 selection；
- 同一盘口只认领一次，新盘口线可再认领；
- 多规则重叠时只有最高优先级产生 Batch；
- 页面不再出现绑定规则、金额精度或投注步进。

### C2/C3

- 账号按顺序填满并允许 partial；
- rejected 不重新分配；unknown 不重投并冻结；
- 水位只在候选阶段检查一次，line/identity 在每次提交前复核；
- pause_pending 不接新任务但完成原队列；enable 必须 fresh 检测；
- 全局开关持久化，重启进入 armed_waiting，通过预检后恢复；
- 无 capability evidence 的组合无法 preview/submit；
- submit attempt 在任何 crash point 都不会重复发送；
- 真实运行不含第一笔自动停止限制。

### C4/UI

- desktop 与 390px 宽度均可管理规则、账号和总开关，无页面级横向溢出；
- 控制台状态来自持久层和 lease，不根据前端本地状态猜测；
- unknown、stale、blocked、pause_pending 均有中文说明；
- backend、syntax、frontend、build 和浏览器主流程回归通过；
- 页面、API、日志和公开 fixture 敏感字段扫描为 0。

## 14. 明确排除

- 新策略算法、AI 预测、表达式编辑器；
- 每日投注金额上限；
- rejected 自动转投其他账号；
- 同一盘口冷却后重复投注；
- 用户配置金额精度或投注步进；
- 第一笔真实订单自动停止模式；
- 自动开放 LAN/公网、原生 App、PWA、WebSocket；
- 绕过验证码、滑块、二次验证或 Crown 风控。
