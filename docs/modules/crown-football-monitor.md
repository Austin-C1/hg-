# Crown Football Monitor

## 2026-07-14 Task 10 execution classification boundary

- Watcher 仍是只读模块；它只负责把赛前全场让球 `RATIO_R` 且有 `IOR_RH|IOR_RC` 的事实标记为 `lineVariant=main`。该分类允许下游 exact capability 判断，但 watcher 自身不会调用 Preview 或 Submit。
- `RATIO_RE`、滚球、其他 period/market 或缺少 exact home/away odds 字段的行保持 `lineVariant=unknown`，不能借助相似字段进入已开放的 production row。
- `waterMoveThreshold` 是运行配置，当前 `0.01` 不改变上述协议身份或 capability 边界。

## 目标与边界

本模块负责只读采集皇冠足球赔率，并把 provider 事实转换为可恢复、可审计的监控状态。默认运行 `schema v2`；真实投注执行不属于本模块。

- 允许：监控账号 API 登录、session 复用、`transform.php` XML 读取、DOM/fixture 兼容回放、SQLite 监控状态、JSONL 审计、Console/Telegram 告警、确定性候选输出。
- 禁止：点击赔率、填写金额、调用 `FT_order_view`/`FT_bet`、从 watcher 自动真实下注、记录或提交 credential/session/token。
- 采集盘口：仅 `asian_handicap` 和普通 `total`；moneyline、球队大小球和未知市场不进入监控链。
- 赛前和滚球策略可独立启停并可同时启用，但始终由同一个 watcher 处理；watcher 不按监控模式拆成多个进程。
- 新监控报警配置的 `waterMoveThreshold` 同时匹配上涨和下降；两种方向都产生事实 Signal 和 Telegram delivery。下降方向只报警，自动投注 inbox 会在任何盘口查询或批次创建前稳定跳过。
- 今日投注联赛目录只读当前监控事实：Asia/Shanghai 当天 active 赛事中命中启用默认联赛的名称，加上 exact event identity 命中的 active 手动追踪赛事。手动追踪只增加候选名称，必须由 `/betting-rules` 动态卡片显式选择。
- Signal 持久化事务在同一固定时间和今日目录下匹配最多一张启用、已复核卡片，并原子写 Signal、Telegram delivery、card inbox 和 cooldown；卡片不读取 mode，执行 mode 保留在 Signal evidence。

## 默认链路（schema v2）

```text
Crown XML
  → batch classification / Crown time / canonical identity
  → SnapshotBatch(authoritative | partial)
  → MonitorStateStore(SQLite)
  → factual Change
  → StrategyRegistry(odds_delta)
  → persistent Signal + cooldown
  ├─→ AlertDispatcher(Console / Telegram delivery queue)
  └─→ persistent Candidate → betting-candidates-v2.jsonl
```

关键边界：

1. `get_game_list` 只有在 XML 完整、不是登录页且 scope 可确定时才是 `authoritative`，可以维护 active event set。
2. `get_game_more` 永远是 `partial`，只能更新当前赛事和 selection baseline，不能移除其他赛事。
3. 首次 authoritative/detail 只建立赛事和盘口 baseline；没有旧赔率就不产生 `odds-change`，因此也没有 Signal。
4. StateStore 生成的 Change 只描述事实，不读取策略，不含 `candidate=true/false`。
5. StrategyEngine 只把满足规则且数据完整的 Change 转成 Signal；缺开赛时间、滚球时钟或高置信 identity 时 fail-closed。
6. Signal 写入 SQLite 成功后才进入 Dispatcher 和 Candidate Builder；消息发送失败不回滚 Signal，也不重复候选。
7. watcher 不导入或调用 `CrownBetAdapter`。
8. live schema-v1/schema-v2/`--login-test` 在登录、poll 和 runtime 输出前取得 `watcher:<canonical-db>:<canonical-runtime>` SQLite lease；active 第二实例 fail-closed，过期接管递增 fencing token。离线 fixture 不占 live lease。

## schema v1 legacy

旧文件 `crown-odds-snapshots.jsonl`、`crown-odds-changes.jsonl` 和 `betting-candidates.jsonl` 保留为历史证据，不删除、不重命名、不截断。旧 `JsonlOddsStore` 把 list/detail 都视为完整事件集合，会产生虚假 `event-added/event-removed` 并破坏 selection baseline；这些历史记录不能与 v2 健康统计合并。

显式回滚：

```powershell
npm run crown:watch -- --monitor-state-version 1
```

该模式会打印醒目的 `DEPRECATED schema-v1` 生命周期警告，只走旧 JSONL/旧候选路径，不启动 v2 state store、Dispatcher 或 v2 candidate sidecar。它只用于短期故障回滚。DOM 和 fixture 路径继续保持 schema-v1 兼容行为。

schema-v1 只读查询已存在 app DB；缺失 DB 不创建，现有 DB 不 migration、不写 runtime status。默认 v2 则要求完整启用账号，缺失时 fail-closed。

恢复默认 v2：

```powershell
npm run crown:watch -- --monitor-state-version 2
```

## 身份、批次和时间

| 对象 | v2 规则 |
|---|---|
| event | `crown|football|gid=<GID>` |
| match group | `crown|football|gidm=<GIDM>|lid=<LID>` |
| market | `eventIdentity + period + marketType + lineKey` |
| selection | `marketIdentity + side` |

`ECID/HGID/GIDM/LID` 保留在 `providerIds`，但不会因为 detail 缺少 ECID 而创建第二个 event。缺 GID 时只生成低置信 fallback identity，允许展示但不允许产生可下注 Signal。

Crown 时间解析保留 raw/source/confidence/warnings：

- 实时 XML 使用根级 `system_time` 与响应 `capturedAt` 推导该响应的源 UTC offset；同一 poll 的 game-more 缺少 `system_time` 时继承 list 的响应级时间上下文，不把皇冠源时间硬编码为北京时间。
- `GAME_DATE_TIME` 和 `DATETIME` 的完整格式与无年份 12 小时格式都解析为规范 UTC；无年份格式执行跨年最近合理日期选择。
- `1H^08:00`、`2H^52:41` 解析 period、phase 和 elapsed minute。
- 缺失或矛盾时间仍保存事实，但策略返回 `data_incomplete:*`。
- Dashboard 保留最优非空时间事实，显示 `startTimeBeijing`、`high|inferred|invalid|missing` 和 time warnings；比赛按规范 UTC 升序、空时间置后。

## 当前持久化

### JSONL 审计

- `data/runtime/crown-odds-snapshots-v2.jsonl`
- `data/runtime/crown-odds-changes-v2.jsonl`
- `data/runtime/betting-candidates-v2.jsonl`
- `data/runtime/crown-watch-runtime.jsonl`

JSONL 是 append-only 审计/导出，不承担重启恢复。SQLite outbox 确保写审计失败后可以恢复重放；v2 JSONL 以确定性 id 去重尾部重试。

### SQLite 当前状态

| 表 | 职责 |
|---|---|
| `monitor_scope_state` | scope 最后批次、最后完整时间、当前 event set |
| `monitor_event_state` | canonical event、active/missing 状态和 provider IDs |
| `monitor_selection_state` | selection 最新有效 baseline |
| `monitor_signals` | 确定性 Signal 和策略版本 |
| `monitor_cooldowns` | `strategyId + selectionIdentity` 冷却截止时间 |
| `monitor_deliveries` | 每个 Signal/渠道的 pending/retry/sent/dead-letter |
| `monitor_audit_outbox` | SQLite 事务提交后待导出的 snapshot/change 事实 |
| `monitor_candidates` | Signal 派生候选及 JSONL 导出状态 |
| `runtime_leases` | watcher 与 Betting Executor 分 key 的 owner/fence/expiry 单实例租约 |

## 主要文件

| 区域 | 路径 |
|---|---|
| watcher orchestration | `scripts/crown-watch.mjs` |
| XML normalizer | `src/crown/crown-transform-xml.mjs` |
| batch/time/strategy/signal/state | `src/crown/monitor/` |
| v2 audit/candidate JSONL | `src/crown/storage/jsonl-v2-audit-store.mjs`、`jsonl-candidate-store.mjs` |
| schema-v1 store | `src/crown/storage/jsonl-store.mjs` |
| API login | `src/crown/login/crown-api-login-manager.mjs` |
| browser fallback | `src/crown/login/crown-login-manager.mjs` |
| Dashboard projection | `src/crown/dashboard/dashboard-data.mjs` |
| alert channels | `src/crown/alerts/` |
| watcher lease | `src/crown/app/runtime-lease.mjs`、`watcher-lease-key.mjs` |
| XML fixtures | `data/fixtures/crown/transform-xml` |

## 登录与运行

配置了启用且包含 username/password 的主监控账号后，默认 v2 使用 `CrownApiLoginManager`。账号缺失或凭据不完整会返回明确错误，不会自动进入 schema-v1 browser/DOM：

1. `POST /transform_nl.php`，`p=chk_login`。
2. 保存本地 API session（该目录必须保持 Git ignored）。
3. 用 `get_game_list` 验证 session。
4. 每轮读取 list，再按目标读取多个 game-more；同一 poll 共享 poll id/scope。

验证码、滑块、MFA 等人工验证不会被绕过。`--login-test` 只验证登录并退出，不启动长期采集。

常用命令：

```powershell
node scripts\crown-watch.mjs --help
npm run crown:watch -- --monitor-state-version 2
node scripts\crown-watch.mjs --login-test --monitor-state-version 2 --max-seconds 60
node scripts\crown-watch.mjs --from-fixture data\fixtures\crown\transform-xml
```

`--from-fixture` 始终使用 schema-v1 兼容 store，即使未显式传版本；它只验证离线 normalizer/legacy 行为，不代表默认 v2 live 路由。

完整运维步骤见 `docs/crown-monitor-v2-runbook.md`。

## Dashboard 与健康口径

- `/matches` 展示北京时间、时间质量和解析 warnings；不伪造缺失开赛时间。
- `/monitor-settings` 保留 prematch/live 双 Switch，并在折叠“数据质量与诊断”中按 eventKey 列出联赛、主客队和原因，而不只显示数量。
- Dashboard child 与手动 CLI 计算相同 watcher lease key；同 key 运行中的受管 child 返回 `alreadyRunning`，不同 key 请求 fail-closed，不自动 kill 或接管未过期进程。

只要任一 v2 JSONL 文件存在，Dashboard 就使用整个 v2 generation；不会把 v1 snapshots/changes 混入，也不会在 v2 文件暂时为空时退回污染的 v1 数据。

健康区显示：

- 最后权威批次/时间；
- active events 和 selection baselines；
- Signal 总数；
- pending/retry/dispatching 投递数；
- dead-letter 数；
- 数据不完整原因（如缺开赛时间、缺滚球时钟）。

数据库缺失、旧 schema 或不可读时返回结构化 unavailable，不伪造健康值。

## 模块关系

强绑定、必须一起验证：XML normalizer → SnapshotBatch/time/identity → MonitorStateStore → Strategy/Signal → Dispatcher/Candidate → Dashboard v2 projection。

可独立开发但需契约测试：

- Console/Telegram sender：只消费 Signal。
- Dashboard React 展示：只消费 summary/events/changes/health API。
- Candidate dry-run 与 betting adapter：只消费候选/BetIntent，绝不回调 watcher。
- Probe/replay：只生成或回放输入证据。

## 验证

```powershell
node --test tests\crown-watch-state-version.test.mjs tests\crown-monitor-v2-integration.test.mjs
node --test tests\crown-time.test.mjs tests\crown-snapshot-batch.test.mjs tests\crown-monitor-state-store.test.mjs tests\crown-strategy-engine.test.mjs tests\crown-alert-dispatcher.test.mjs
node --test tests\crown-dashboard-data.test.mjs tests\crown-app-api.test.mjs
npm test
npm run check
```

验证必须使用 fixture/fake response；普通验证命令不得访问真实投注接口。

## 中文字段编码

- Crown 响应整体优先按严格 UTF-8 解码，只有非法 UTF-8 字节才回退 GB18030。
- 联赛和球队字段还需经过 `src/crown/crown-text.mjs` 的可逆乱码修复，以兼容响应内“正常中文与错解码中文混合”的情况。
- 修复只在 GB18030 编码、UTF-8 解码后无替换字符且能完整反向还原原文本时生效，避免误改正常中文。
# C canonical monitor-to-bet handoff（2026-07-12）

- Watcher 热加载 canonical rule revision；整批校验失败时保留 last-known-good。
- 每个 Change 对命中规则按 priority、createdAt、id 排序，只允许第一条取得 one-market claim，同时保留全部 match audit。
- One-market identity 包含 event、mode、period、market type、line identity、line value 与实际投注 side；赔率变化本身不创建第二次资格，changed line 可创建新资格。
- Signal 保存一次性的目标赔率判断；每个 submit 前只重新核对 event/stage/period/market/line/actual side 与 suspended 状态，不重新运行目标赔率区间。
- Watcher 不直接调用 Crown submit；真实执行必须经过 persistent intent、13 项 preflight、exact capability、authorization 与三角色 lease/fence。
