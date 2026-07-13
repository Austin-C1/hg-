# 模块汇总

## 2026-07-13 Windows Portable 与远程更新（设计已确认，尚未实现）

- 设计入口：`docs/superpowers/specs/2026-07-13-crown-windows-portable-and-remote-update-design.md`。
- 发行边界：Windows x64 Portable ZIP、内置 Node/Chromium、APP_ROOT 与 `%LOCALAPPDATA%\CrownMonitor` 数据根分离、可见 launcher、Watcher 手动启动、真实 capability `0/0/0`。
- 计划模块：Portable launcher/path model、118 项默认联赛 seed、allowlist release builder、发行物秘密/路径审计、Chromium 人工登录 session bridge、Dashboard update API/UI、Ed25519 manifest verifier、安全解压、外部 updater、健康检查与 journal rollback。公开源码与 Releases 使用 `Austin-C1/hg-`。
- 强绑定验证：launcher/路径模型/进程所有权/SQLite 备份必须一起验证；人工登录与 exact-origin session/API read-only 验证必须一起验证；manifest/signature/allowlist/extract/updater/rollback 必须端到端验证。
- Fresh Windows 验收必须覆盖无 Node/Chrome/Edge/Docker、非项目 cwd、中文/空格路径、端口冲突、离线、篡改包、更新阶段强制终止和数据保持。当前只有设计文档，不代表已有可发布 ZIP。

## 2026-07-13 Dashboard 当前状态与页面性能

- `/matches`、默认联赛和监控设置页面只消费 SQLite `monitor_*_state` 当前投影；legacy `/api/events`、`/api/summary`、`/api/changes` 继续保留 JSONL 审计兼容语义。
- 当前投影 read-only、按 DB+WAL 版本缓存并在 WAL-only commit 后失效；页面 GET 不执行 schema/migration。`app-db.mjs` schema connection 与 runtime/read-only connection 的边界仍是强绑定验证项。
- `/matches` 首屏/30 秒列表刷新不读取 global changes；详情按 eventKey 延迟读取，列表/详情分别 single-flight，缓存刷新不遮罩现有内容。
- `frontend/src/styles/index.css` 的 settings 字段 selector 只命中 direct-child label，不再改写 Ant Checkbox wrapper；CSS contract 禁止 checkbox inner 的定位和 physical/logical size 补丁。
- 2026-07-13 隔离克隆验收：cold P95 499.8ms、warm P95 79.2ms、菜单 P95 615.2ms；三档 viewport 无横向溢出，7 个 Checkbox 为 16×16 且勾号居中，console 0。正式 watcher/8787 当时未运行，持续写入正式环境仍需单独运行态复核。

## 2026-07-12 动态投注规则卡片（当前唯一权威入口）

- 权威设计：`docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md`；当前页面：`/betting-rules`。历史 C 统一规则、固定赛前/滚球投注设置及其 plans/reports 仅作演进证据。
- Monitor：`alert-settings.mjs`、`alert-settings-watcher.mjs`、`strategy-registry.mjs` 保持 prematch/live 独立且可同时启用；上涨和下降都生成 Signal/TG，下降在投注前终结。
- Card schema/API：`app-db.mjs`、`app-repository.mjs`、`app-api.mjs`、`today-betting-leagues.mjs`。卡片 mode-agnostic，联赛必选且 `UNIQUE(league_name)`；手动今日联赛必须显式选择；停用仍占用，物理删除释放。
- Signal/B2：`monitor-state-store.mjs`、`auto-betting-inbox-store.mjs`、`auto-betting-consumer.mjs`、`bet-batch-store.mjs`、`market-once-store.mjs`、`execution-gate.mjs`、`b2-executor.mjs` 强绑定。Signal 原子产物、card snapshot、card-scoped authorization、delete race 与 B2 recovery 必须一起验证。
- Dashboard：`frontend/src/pages/AutoBetRules.tsx` 动态卡片/create-edit modal；Operations 使用 `ruleCards` 计数；完全重置保留卡片/联赛配置并清理 card snapshot 在内的运行历史。
- Contract/capability：app/frontend/schema 均为 `dynamic-betting-cards-v1`；canonical Crown preview/submit/reconciliation 仍为 `0/0/0`。

## 2026-07-12 C 阶段完成与运行数据策略

- C Task 1–11 已完成，当前代码验证基线为 backend 874/874、syntax 180、frontend 66/66；真实投注仍被 capability `0/0/0` 阻断。
- 监控 SQLite 只保存当前运行状态、待处理事务和幂等边界；已投递 audit outbox 立即清除。
- 原始 snapshot/change JSONL 正常保留到用户在运维控制台手动执行“每日开工完全重置”；没有定时或启动自动清理。
- 完全重置会删除点击前的监控状态、候选、投注账本、market-once 幂等锁、pending/unknown、提交/对账、通知与执行审计；账号、登录会话、规则、Telegram、协议证据和运行依赖保留。重置后真实投注回到 off，旧盘口允许重新下注。
- `app-db.mjs` 的 schema/migration 连接与运行时轻量连接强绑定验证；Dashboard/API/watcher 运行路径不得每次请求重复迁移。

## 2026-07-11 Dashboard 本机免密发布模式

- 默认无密码配置时，loopback 访问自动获得进程随机 CSRF 权限，页面显示“Dashboard 本机免密”；同源、Host、remote address 和 CSRF 检查仍保留。
- 显式密码或远程 Host/Origin 配置会关闭免密模式。默认绑定仍为 `127.0.0.1:8787`，下载者只能在自己的电脑上访问。
- 手动投注账号检测使用账号自身已保存的安全 exact origin；生产投注 Provider 的环境 allowlist 和 canonical capability 不变。
- 强绑定验证：`static-server.mjs`、`app-api.mjs`、`App.tsx`、`crown-api-login-manager.mjs` 及安全/API/frontend/provider 测试必须一起验证。

## 2026-07-11 Dashboard 认证与投注账号健康检测

- Dashboard 写操作继续强制 session + CSRF；前端统一处理认证失效，规则保存不再误报字段错误，监控 Switch 在失败时保持服务端状态并阻止重复请求。
- `/betting-accounts` 新增手动只读健康检测，强绑定 `CrownApiLoginManager`、`app-api.mjs`、`app-repository.mjs`、`app-db.mjs` 与投注账号页面，修改时必须一起验证。
- 检测链为 fresh login → `get_game_list` → `get_member_data`，只保存脱敏状态和 Crown 返回的展示余额/额度；执行余额 `balance_minor` 不受影响。投注账号 busy/locked 时 fail-closed。
- 验证：backend 756/756、syntax 163、frontend 51/51、production build 通过；真实投注仍关闭。

## 2026-07-11 B 阶段完成状态

- B1 Task 1–9、B2 Task 10–12 已完成代码实现和独立复核；最终 focused 108/108、backend 749/749、syntax 162、frontend 48/48、build/Compose config 通过。
- 投注执行模块现包含 ExecutionAuthorization、durable submit attempt、fenced single-child recovery、persistent reconciliation evidence、context-bound provider reference、outcome outbox 和 Telegram consumer。
- 强绑定模块：`execution-gate.mjs`、`b2-executor.mjs`、`b2-reconciler.mjs`、`app-db.mjs` 必须一起验证；通知链 `b2-outcome-dispatcher.mjs`、`telegram-alert.mjs`、`telegram-client.mjs`、`crown-b2-notifications.mjs` 必须一起验证。
- 生产 Crown capability matrix 的 preview/submit 均为 0，真实提交和自动对账仍 fail-closed；offline fixture 不能证明 Crown batch。未执行真实 preview、`FT_bet` 或 Telegram 发送。
- B 报告入口：`.superpowers/sdd/task-12-report.md`。C 设计草案：`docs/superpowers/specs/2026-07-11-crown-c-strategy-mobile-console-design.md`，待范围确认后进入计划。

## 2026-07-11 B 阶段方案 A 当前状态

- 设计：`docs/superpowers/specs/2026-07-10-crown-b-multi-account-betting-design.md`；计划：`docs/superpowers/plans/2026-07-10-crown-b-multi-account-betting.md`；执行进度：`.superpowers/sdd/progress.md`。
- B1 Task 1–9 与 B2 Task 10–12 代码已完成并通过独立复核；当前最终 backend 749/749、syntax 162、frontend 48/48、production build 与 Compose 配置通过。
- B1 提供 exact minor-unit money、规则/账号原子 CRUD、确定性 Signal→batch、child ledger、账号锁、unknown 恢复、严格盘口锁、Simulated Provider、默认 off worker、preview/simulated 零真实网络，以及 batch/child Dashboard。
- 赛前/滚球可同时启用但由单 watcher 处理；Dashboard 显示北京时间质量/warnings 和逐赛事诊断；watcher 与 Executor 使用不同 canonical fenced lease key。
- B2 Task 11–12 已完成 sanitized fixture/offline-only 验收；canonical Crown preview/submit 能力仍为 0。历史诊断实际清理和凭据/session 轮换完成前不执行真实 preview；真实小额 `FT_bet` 仍需验收当次新授权。


## 2026-07-10 A 阶段 schema-v2 监控迁移

- 默认 watcher 已切到 `--monitor-state-version 2`：authoritative/partial SnapshotBatch、canonical identity、响应级 Crown source time、SQLite state、纯事实 Change、Strategy、持久 Signal、Dispatcher 和确定性候选已实际接线。
- schema-v1 仅保留为显式 `--monitor-state-version 1`、DOM/fixture compatibility；旧 snapshots/changes/candidates 不删除、不覆盖，也不并入 v2 健康。
- 运维入口：`docs/crown-monitor-v2-runbook.md`；监控模块入口：`docs/modules/crown-football-monitor.md`。
- 强绑定集成：XML batch normalizer、time/identity、MonitorStateStore、Strategy/Signal、Dispatcher/Candidate、Dashboard v2 projection。修改其中任何持久契约都必须跑 v2 integration + Dashboard 契约。
- 可独立开发：probe/replay、Console/Telegram sender、React 展示、candidate dry-run/betting adapter；它们分别只消费 fixture、Signal、API payload 或 Candidate，不得反向修改事实状态。

## 2026-07-10 A 阶段实施计划（历史记录，已完成）

- 实施入口：`docs/superpowers/plans/2026-07-10-crown-monitor-core-redesign.md`。
- 计划共 12 个 TDD 任务，覆盖 Crown 时间、canonical identity、SnapshotBatch、SQLite 状态、事实 Change、StrategyEngine、Signal/冷却、异步投递、确定性候选、Dashboard、迁移回滚和完整验收。
- Task 1-11 已进入代码、测试、Dashboard 和运维文档；Task 12 负责 A 阶段最终验收。

## 2026-07-10 GitHub 发布与 replay 输出隔离

- 公开仓库发布审计：`docs/repository-publication-audit.md`。
- `scripts/crown-replay-fixture.mjs` 新增独立 `outputDir`，测试不再改写项目 fixture，生成 source 使用相对路径。
- Git 和 Docker 忽略规则已覆盖本地 secret/runtime/output/reference 数据；首次 commit/push 仍需单独确认和 staged 审计。

## 2026-07-10 A 阶段监控核心重建设计

- 待确认设计：`docs/superpowers/specs/2026-07-10-crown-monitor-core-redesign.md`。
- 设计边界：SnapshotBatch 权威/增量语义、canonical event/market/selection identity、SQLite 当前状态、Crown 时间解析、纯事实 Change、StrategyEngine、确定性 Signal、异步 Dispatcher 和候选幂等。
- 强绑定模块：XML normalizer、JSONL store、watcher、monitor settings、tracked matches、betting candidate builder、Dashboard 数据读取必须一起迁移和验证；真实下注 adapter 仍保持隔离。

## 2026-07-10 PBBall 2 参考程序分析

- 新增 `docs/pbball2-reference-analysis.md`，记录 PBBall 2 的产品形态、监控/策略/下注/多账号/Dashboard 架构，以及与当前皇冠平台协议和实现边界的逐项差异。
- 该文档是只读逆向分析结果，不代表 PBBall 的接口或实现可以直接用于皇冠；后续设计必须以皇冠当前 XML、下单抓包证据和实际测试为准。
- 可以独立借鉴的方向：策略 Registry、独立账号 worker、进程发现与控制、实时状态通道。强绑定且必须一起设计和验证的方向：候选版本、预览、提交、幂等、pending/unknown 对账、聚合风控和正式账本。

## 2026-07-10 完整架构文档

- 新成员和后续开发的首要入口：`docs/crown-current-architecture.md`。
- 该文档按当前源码重建，统一说明全链路数据流、应用配置与 v2 监控状态表、全部 API、React 页面、投注执行门禁、Docker 边界、开发扩展步骤和已知 P0/P1 风险。
- 模块专题文档保留用于深入阅读；当专题文档、历史计划与主文档冲突时，以当前源码、测试和 `docs/crown-current-architecture.md` 为准。

## 2026-07-09 投注账号顺序执行更新

- Dashboard 投注账号模块新增 `betOrder` / `bet_order`，页面和 API 均按手动序号展示；未设置序号账号排最后。
- 投注执行模块新增 `scripts/crown-bet-execute-sequence.mjs` / `npm run crown:betting:execute-sequence`，只读取启用、已保存密码且序号大于 0 的投注账号；真实模式逐账号执行，上一账号必须返回 `accepted` 才继续下一账号。
- 投注成功 Telegram bot 已配置到本地 `betSuccess`，但成功消息模板仍待用户确认后接入真实发送。
- Dashboard 历史投注现在会显示 Crown 开单预览失败 code；大量 `preview-rejected code=555` 代表 `FT_order_view` 未返回赔率/限额，不是 `FT_bet` 真实提交失败。
- 候选 dry-run 现在会先用最新 runtime snapshot 刷新盘口，并默认拒绝超过 180 秒的候选，避免旧候选反复触发 `code=555`。

## 2026-07-09 阶段边界（历史快照，已被顶部当前权威入口取代）

- 2026-07-09 当时的完整交接文档入口为 `docs/crown-current-architecture.md`；当时“投注、金额填写和注单提交属于后续阶段”的判断只保留为历史，不代表当前实现。
- Crown V1.1 开发计划入口：`docs/superpowers/plans/2026-07-09-crown-v1-1-login-dashboard.md`；目标是完成 `mon_primary` 自动登录基础闭环、登录诊断、测试登录短跑和 Dashboard 中文瘦身。
- 投注协议抓取计划入口：`docs/superpowers/plans/2026-07-09-crown-betting-protocol-capture.md`；当前允许受控协议抓取和后续独立执行模块设计，但监控路径仍不允许提交订单。
- 投注协议最新状态：`docs/crown-betting-protocol-map.md` 已记录细分盘口详情页和赛事列表大盘口页的 `FT_order_view` / `FT_bet` 协议证据；`20260709-111046` 与 `20260709-112647` 验证了 `allowRealSubmit=false` 时 `FT_bet` 会被网络层拦截。两类页面目前观察到 key set 一致，差异主要在 `wtype/rtype/chose_team/f` 市场字段值。
- CrownBetAdapter 开发计划入口：`docs/superpowers/plans/2026-07-09-crown-bet-adapter-execution.md`；Task 1-7 已完成到 API-first dry-run preview、risk guard、redacted audit 和 betting history summary；当前已新增 bootstrap、dry-run CLI，并完成一次真实 Crown session live dry-run 验证。真实提交和轮询已用 fake provider 响应验证，真实 Crown 环境提交仍未验收。
- 监控报警触发投注候选已接入：当前 schema-v2 watcher 只从持久 Signal 写 `data/runtime/betting-candidates-v2.jsonl`；本段原先记录的 `betting-candidates.jsonl` 仅属于 schema-v1 历史/回滚。candidate dry-run 独立执行，真实下注仍不从 watcher 自动触发。
- 默认追踪白名单已替换为用户提供的 118 个联赛/杯赛/国际赛名称；配置入口为 `config/default-leagues.json`，代码内置兜底为 `src/crown/config/default-leagues.mjs`，匹配仍只按 `name` 精确匹配。
- 足球盘口采集范围：只保留让球和普通大小球，覆盖主盘口、上半场、A-F 分线和对应滚球字段；球队大小球不进入监控快照、变化记录、TG 报警或候选下注链路。分线盘口使用 `lineKey` 区分，避免反打时拿错同场另一条线。
- `皇冠监控账号`、`默认联赛`、`比赛选择` 页面属于 Dashboard 配置界面；单账号配置和状态持久化在 `src/crown/app/`。
- 自动登录、API session 复用、验证码人工暂停兜底、掉线检测、XML 无响应检测、赔率扫描间隔和最多 3 次自动重登属于 `scripts/crown-watch.mjs` runtime。
- 当前 schema-v2 的 StateStore 只写事实 Change，StrategyEngine 再生成持久 Signal 和候选；`jsonl-store.mjs` 在本段历史语境中仅描述 schema-v1 legacy 行为。

| 模块 | 路径 | 职责 | 可独立开发 | 验证方式 |
|---|---|---|---|---|
| 皇冠采集器 | `scripts/crown-probe.mjs`、`docs/modules/crown-probe.md` | 打开皇冠页面，记录 DOM/Network/JSON 响应，输出采集结果 | 是 | `node scripts/crown-probe.mjs --help`、`node --check scripts/crown-probe.mjs` |
| 皇冠足球监控 | `docs/modules/crown-football-monitor.md`、`scripts/crown-watch.mjs`、`src/crown/monitor/`、`src/crown/storage/`、`src/crown/crown-transform-xml.mjs`、`src/crown/login/crown-api-login-manager.mjs` | XML 主源、SnapshotBatch、canonical identity/time、SQLite state、Change→Strategy→Signal、Dispatcher、候选；prematch/live 同进程双模式、canonical watcher lease、schema-v1 回滚和 DOM/fixture compatibility | 部分；持久契约强绑定 | `node --test tests\crown-watch-state-version.test.mjs tests\crown-monitor-v2-integration.test.mjs tests\crown-monitor-state-store.test.mjs tests\crown-strategy-engine.test.mjs tests\crown-alert-dispatcher.test.mjs` |
| 皇冠 Telegram 通知 | `docs/modules/crown-telegram-notifications.md`、`src/crown/telegram/`、`src/crown/alerts/telegram-*.mjs` | schema-v2 Signal 命中后发送无抬头五行中文赔率变化 TG；显示联赛、比赛、类型、盘口与新旧赔率和北京时间；支持多个 Chat ID、群话题、Chat ID 获取、重试和测试发送 | 是 | `node --test tests\crown-telegram-client.test.mjs tests\crown-alerts.test.mjs tests\crown-alert-dispatcher.test.mjs tests\crown-telegram-settings.test.mjs` |
| 皇冠监控 Dashboard | `Dockerfile`、`docker-compose.yml`、`scripts/crown-dashboard.mjs`、`src/crown/dashboard/`、`src/crown/app/`、`src/crown/config/`、`src/crown/monitor/`、`frontend/`、`docs/modules/crown-dashboard.md` | Docker-first 本地配置与赔率监控 App；React + Ant Design UI 展示七个页面，SQLite 保存配置与 monitor 当前状态；`/matches` 当前列表读取只读 SQLite 投影并按 DB+WAL 版本缓存，30 秒静默刷新，单场详情才按 `eventKey` 读取 JSONL 变化历史；`/monitor-account` 每 5 秒轻量刷新 runtime 状态；`/betting-rules` 和 `/betting-accounts` 使用横向卡片；旧 JSONL odds API 保持兼容 | 是 | `node --test tests\crown-current-odds-state.test.mjs tests\crown-app-api.test.mjs tests\crown-dashboard-css-contract.test.mjs`、`npm --prefix frontend test -- --run src/pages/MatchSelection.test.tsx src/pages/MonitorSettings.test.tsx`、`npm test`、`npm run check`、`npm --prefix frontend run test` |
| 投注协议与执行模块 | `docs/modules/crown-betting-protocol.md`、`docs/betting-architecture.md`、`docs/betting-contract.md`、`docs/crown-betting-protocol-map.md`、`src/crown/betting-protocol/`、`src/crown/betting/`、`src/betting/`、`scripts/crown-betting-protocol-capture.mjs`、`scripts/crown-betting-protocol-analyze.mjs`、`scripts/crown-betting-worker.mjs` | B1 exact money、Signal 幂等 batch、child ledger、账号锁/unknown 恢复、严格盘口锁与 B2 durable submit/authorization/reconciliation 已完成；Task 6 新增 fresh production `protocolVersion` provenance、exact field-set fail-closed、request/response 精确配对和私有 HMAC locked-context linkage。canonical Crown capability 仍为 0，旧 adapter 不是绕过入口 | 是 | `node --test tests\crown-betting-protocol-redaction.test.mjs tests\crown-betting-protocol-classifier.test.mjs tests\crown-api-login-manager.test.mjs tests\crown-account-provider.test.mjs tests\crown-capability-matrix.test.mjs`、`npm test`、`npm run check` |

## 模块关系

- `scripts/crown-probe.mjs` 负责采集 fixture。
- `scripts/crown-analyze-network.mjs`、`src/crown/endpoint-detector.mjs`、`src/crown/normalize-football.mjs`、`src/crown/crown-transform-xml.mjs` 负责离线识别和标准化。
- `scripts/crown-replay-fixture.mjs` 用固定 DOM/XML fixture 验证标准化和联赛过滤。
- `scripts/crown-watch.mjs` 默认 direct-v2；`get_game_list` 与 `get_game_more` 分别使用 authoritative/partial 语义。显式 version 1 才走旧 browser/JSONL 生命周期。
- MonitorStateStore 只生成事实 Change；StrategyRegistry 把兼容监控配置转换为版本化规则并生成 Signal；Dispatcher 和 Candidate Builder 只消费持久 Signal。
- Dashboard 任一 v2 文件存在时选择整个 v2 generation，并用 SQLite aggregate health 展示权威批次、pending/dead-letter 和数据不完整原因；不会把 v1 生命周期计数混入。
- `src/crown/crown-text.mjs` 是 XML normalizer 与 Dashboard projection 的共享中文字段边界：前者保证新快照正确，后者兼容既有 JSONL 显示；两处修改必须一起验证。
- 默认联赛与 SQLite active tracked matches 属于 Strategy context，不得反向过滤 provider event lifecycle；手动追踪比赛仍可越过默认联赛白名单。
- `src/crown/betting-protocol/` 是投注协议抓取和分析工具层；`src/crown/betting/` 保留 canonical 字段映射、响应解析、Provider、capability 和 worker 依赖。原 `src/betting/` 旧 adapter 通用契约已随旧 CLI 删除。
- B1 多账号主链以 `monitor_signals`、`bet_batches`、`bet_child_orders`、`betting_account_locks` 和 `scripts/crown-betting-worker.mjs` 为准；2026-07-09 的 bootstrap、单笔/顺序执行和 candidate dry-run CLI 已删除，不得恢复为旁路入口。
- B1/B2 Task 1–12 已通过代码与安全闸门；在 canonical Crown submit capability、运营清理/轮换和当次新授权全部通过前，仍不得进行多账号真实 `FT_bet`。
# C stage module status（2026-07-12）

| 模块 | 状态 | 绑定关系 | 验证入口 |
|---|---|---|---|
| Canonical rule + watcher claim | 完成 | 与 monitor Signal/market-once 强绑定 | `crown-auto-bet-rule-*.test.mjs` |
| Ordered allocation + queue | 完成 | 与 batch/child/account lock 强绑定 | `crown-c-unified-auto-betting-integration.test.mjs` |
| Persistent real runtime | 完成但 fail-closed | 与 capability/authorization/leases 强绑定 | `crown-real-betting-runtime.test.mjs` |
| Account pause/enable | 完成 | pause finalizer 与 worker 强绑定 | `crown-betting-account-actions.test.mjs` |
| Unified UI + operations | 完成 | API DTO 与 responsive frontend 强绑定 | frontend tests + browser acceptance |
| Crown protocol capability | 证据阻断 | 必须同时具备 exact preview+submit+reconciliation | `crown-capability-matrix.test.mjs` |

## 2026-07-12 安全开工补充

- Dashboard 与 runtime cleanup 强绑定验证：重置后 watcher 自动启动，投注账号全部暂停，全局真实投注关闭。
- Operations UI 与 `getOperationsSummary().readiness` 强绑定；reason code 和前端中文映射必须一起修改、一起测试。
- 投注账号页可以独立开发，但不得重新依赖 odds bootstrap；轻量账号与历史接口是该页的固定读取入口。
- Dashboard Session 使用 `/api/app/security-context` 获取 CSRF，规则页使用 `/api/app/league-options` 获取联赛选项；这两个轻量接口不得重新引入赔率 JSONL 全量读取。
- 投注账号启用要求单笔上限为大于 0 的整数 CNY；0 值旧账号必须由用户编辑确定限额，程序不得猜测或自动补值。
