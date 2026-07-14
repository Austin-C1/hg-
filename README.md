# 皇冠足球监控与投注协议实验室

当前状态：足球赔率监控默认使用 schema v2（SnapshotBatch + canonical identity + SQLite state + Change→Strategy→Signal）；监控报警的 prematch/live 配置彼此独立。当前投注规则唯一入口是 `/betting-rules` 动态卡片：卡片不保存赛前/滚球模式，执行 mode 来自 Signal；每张卡至少选择一个今日联赛，同一联赛只能属于一张现存卡片。app/frontend/schema contract 均为 `dynamic-betting-cards-v1`。当前 capability 仅开放 exact row `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation 为 `1/1/0`；其他 period/market/mode/lineVariant 仍关闭。真实 runtime 默认 off，继续受规则卡、账号、fresh Preview、lease/fence 和单次 Submit 门禁约束，Reconciliation 尚未开放。

这个项目用于采集和监控皇冠足球赔率，并逐步还原投注协议。当前默认监控以 `POST /transform.php` `text/xml` 响应为真实赔率主源；默认 v2 缺少完整账号凭据时会 fail-closed，不会静默降级。DOM 只属于显式 schema-v1 回滚/cross-check，fixture 用于离线兼容验证。

## Windows Portable Private Beta

少量 Windows 用户使用时，请只从 [GitHub Releases](https://github.com/Austin-C1/hg-/releases) 下载明确标记为“已完成 Fresh Windows 验收”的手工 Portable ZIP。GitHub Actions 生成的 `unsigned` artifact 仅供维护者审计，不是交付给用户的安装包。

Portable ZIP 面向 Windows 10/11 x64，内置 Node.js 和 Chromium，不依赖系统 Node、Chrome、Edge 或 Docker，也不安装 Windows Service。使用方式：

1. 把 ZIP 完整解压到普通文件夹，不要在压缩软件预览窗口里运行。
2. 双击 `启动程序.cmd`，并保留打开的运行窗口；关闭窗口或按 `Ctrl+C` 会停止程序。
3. 首次成功启动后，程序会在当前用户桌面创建 `皇冠抓水投注.lnk`；以后每次成功启动都会幂等校正 Target、WorkingDirectory 和图标。把程序移动到新目录或手工换用新版本后，从新目录运行一次 `启动程序.cmd` 即可修复快捷方式。快捷方式创建失败不会阻止 Dashboard 启动。
4. 首次打开 Dashboard 后，在“皇冠监控账号”中填写自己的 exact public HTTPS 皇冠网址、账号和密码。网址只能是完整 HTTPS origin，不能带路径、参数或账号信息。
5. 点击人工登录后，由本人在包内 Chromium 中处理验证码、滑块或 OTP，再回到 Dashboard 确认。程序不会绕过人机验证，登录成功也不会自动启动 Watcher。
6. 需要监控时，只能在 Dashboard 中手动启动 Watcher。程序重启或手工更换 Portable 目录后，Watcher 都保持停止。

用户数据库、账号密文、session、浏览器 Profile、日志和本地配置位于 `%LOCALAPPDATA%\CrownMonitor`，不会写回解压目录。下载包内含 118 项默认联赛白名单，但只在目标文件不存在的首次运行时 seed；手工换用新版 ZIP 不会覆盖用户修改。

程序不包含远程检查、下载或安装更新的功能。需要升级时，由维护者重新构建并发布 Portable ZIP；用户把新 ZIP 解压到新目录，从新目录成功启动一次，桌面快捷方式就会自动指向新目录。确认新版本和用户数据正常后，再人工删除旧程序目录；不要删除 `%LOCALAPPDATA%\CrownMonitor`。

程序不设置开机启动，不创建 Startup 项或 Windows Service，也不要求管理员权限。当前 exact row `prematch/full_time/asian_handicap/main` 的 Preview/Submit/Reconciliation capability 为 `1/1/0`；Portable 与人工登录本身不会开启真实投注，也不会自行发送 `FT_bet`。

- 用户说明：[`docs/windows-private-beta-quick-start.md`](docs/windows-private-beta-quick-start.md)
- 维护者发布手册：[`docs/github-release-runbook.md`](docs/github-release-runbook.md)

## 已完成

- Playwright 只读 probe。
- 固定 fixture：`data/fixtures/crown/20260708_004011`。
- 离线 endpoint analyzer。
- 皇冠足球字段映射文档。
- DOM fixture normalizer。
- transform.php XML normalizer。
- fixture replay。
- 联赛白名单过滤。
- 只读 watcher 框架。
- JSONL append-only 存储。
- SQLite 可恢复监控状态、确定性 Signal/冷却、异步投递和候选 outbox。
- Dashboard v2 健康区、数据不完整原因和 dead-letter 统计。
- Console / Telegram alert 模块。
- React + Ant Design 本地 Dashboard。
- SQLite 保存比赛追踪、监控账号、监控规则、下注规则和投注账号配置。
- B1 exact-money 多账号模拟执行：整数 minor units、确定性 batch、child ledger、账号锁、unknown 恢复、严格盘口线锁定、Simulated Provider 和 fenced Executor lease。
- 赛前/滚球可独立启停；比赛页显示北京时间、时间质量和 warning，监控设置可展开逐赛事数据质量诊断。
- watcher 使用 `watcher:<canonical-db>:<canonical-runtime>` SQLite lease，Dashboard child 与手动 CLI 共享同一单实例边界。
- Docker 多阶段构建前端，并用 Node server 托管静态页面和 `/api/*`。
- 投注协议抓取计划：`docs/superpowers/plans/2026-07-09-crown-betting-protocol-capture.md`。
- 受控投注协议抓包 CLI：`npm run crown:betting:capture`。
- 脱敏抓包分析 CLI：`npm run crown:betting:analyze`。

## 当前限制

- Crown 真实赔率主源已确认为 `POST /transform.php` `text/xml`，不是 JSON / WebSocket / DOM 主源。
- DOM fixture `football-today-filtered.json` 只用于 schema-v1 兼容回放/cross-check，不是默认 v2 live fallback。
- `json-responses/` 当前主要识别到 BetRadar metadata/stats、timeline、translation 等数据，不应当作 Crown odds endpoint。
- Normalizer 会保留 raw 值，并标记 `marketId` / `selectionId` 为 local key。
- `oddsId` 当前不可用，标准化结果保持 `null`，不伪造。
- `crown:watch` 在已配置监控账号时直接读取 Crown XML；DOM/page listening 只保留为 fallback/legacy 兼容。它不构造投注接口请求。
- schema v2 使用 SQLite 恢复当前状态，JSONL 只作为 append-only 审计/候选导出；schema-v1 文件保留为污染历史证据。
- Dashboard `/betting-rules` 是动态投注规则卡片的唯一当前用户入口；历史 `/auto-bet-rules` 只重定向。普通卡片 CRUD 或启用状态不能绕过全局预检、card-scoped authorization、capability 与 lease/fence。
- 真实投注协议抓取与后续执行必须放在独立投注模块，不接入 `scripts/crown-watch.mjs`。
- B1 worker 默认 `off`；`preview` 和 `simulated` 都必须显式提供非空 simulation script，且均不导入 `CrownBetAdapter`、不发送 `FT_bet`。
- 2026-07-09 的 bootstrap、单笔/顺序执行和 candidate dry-run CLI 以及旧 `CrownBetAdapter` 已删除；当前执行代码只保留 Dashboard 管理的 canonical worker 与其 capability/authorization/lease 门禁。

## 安全边界

允许：

- 读取本地 capture / fixture。
- 打开已登录的皇冠页面。
- 在本机工具内复用已配置的 auth/session/key。
- 监听页面 response 和 WebSocket frame。
- 解析足球赔率数据。
- 采集并分析投注协议字段、请求顺序和响应状态。
- 按 `config/monitored-leagues.json` 过滤联赛。
- 写本地 JSONL 和提醒。
- 写本地 SQLite 配置。
- 写本地投注协议 capture，输出路径必须被 ignore。
- 真实提交只允许在显式执行模式、确认词、金额限制和可审计输出下运行。

禁止：

- 绕过 CAPTCHA、风控、签名或账号保护。
- 输出 cookie、token、authorization、set-cookie 等敏感信息。
- 把真实账号、token、cookie、SQLite、session、诊断和协议 capture 提交到仓库。
- 从监控告警自动触发真实下注。
- 把投注执行逻辑写进 `scripts/crown-watch.mjs`。
- 未经过显式执行模式、确认词、金额限制和审计日志就提交真实订单。

## 安装

```bash
npm install
```

要求 Node.js `>=22.5`，因为本地配置使用内置 `node:sqlite`。

Docker 本地运行：

```powershell
git clone <repo-url>
cd <repo>
copy .env.example .env
docker compose -p crown-dashboard up --build
```

`.env.example` 包含：

```dotenv
CROWN_DASHBOARD_PORT=8787
CROWN_DB_PATH=/app/storage/crown.sqlite
CROWN_STATIC_DIR=/app/frontend/dist
```

## 常用命令

```bash
npm test
npm run check

npm run crown:probe
npm run crown:probe:once

npm run crown:analyze -- data/fixtures/crown/20260708_004011
npm run crown:analyze:fixture

npm run crown:replay -- data/fixtures/crown/20260708_004011
npm run crown:replay:fixture
node scripts/crown-replay-fixture.mjs data/fixtures/crown/transform-xml

node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/20260708_004011
node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/transform-xml
npm run crown:watch
npm run crown:watch -- --monitor-state-version 2

npm run crown:dashboard:docker
npm run crown:dashboard
npm run crown:frontend:test
npm run crown:frontend:build

npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile
npm run crown:betting:analyze -- data/runtime/betting-protocol-captures/<run>
```

## B1 多账号模拟执行

B1 以持久 Signal 为唯一触发事实，并使用以下安全核心：

- 金额只用 safe INTEGER minor units；规则目标金额与账号单笔限额分离，分配同时遵守 provider min/max/step、余额、币种和 amount scale。
- 每个投注账号的 `perBetLimit` 都由用户在账号配置中手工设置和修改；账号启用要求它是大于 0 的整数 CNY。文档、fixture 或测试里出现的 `50 CNY` 只是测试配置，不是生产默认值、统一硬上限或自动填充值。
- `signalId + ruleId` 生成确定性 batch；child order 是金额账本真相，batch 聚合金额可从 child 重算。
- 不同账号可并发 preview/submit；同一账号由 SQLite lock 串行。`rejected` 释放自身锁但金额终止且绝不转投；`unknown` 保留金额和账号锁且绝不自动重投。
- 批次锁定 event、period、market、lineKey/handicap 和反向 side；同盘口赔率变化继续，盘口线、阶段、方向或 suspended 变化停止未发送部分。
- worker 每轮从 SQLite 回读持久 Signal，恢复 `submit_prepared/submit_dispatched` 时按 unknown 处理；四个崩溃窗口不会产生重复模拟 submit。
- Executor 使用 `betting-executor:<canonical-db>` fenced lease。CLI 默认 `off`；`preview` 只做只读能力分配，`simulated` 只消费确定脚本，两者网络/`FT_bet` 计数均为零。

历史 B1/B2 与 C 阶段快照：离线实现、安全整改、授权预算、逐账号 session、提交恢复和对账状态机当时已完成回归；真实 Provider 当时由 exact capability `0/0/0` 阻断。该历史数值已被本文顶部现行 `1/1/0` 取代，真实小额提交仍不属于自动测试权限。

## 已删除的旧投注 CLI

旧 bootstrap、单笔执行、顺序执行和 candidate dry-run 入口已被 Dashboard 统一 worker 取代并从仓库删除。历史删除阶段的 capability 当时为 `0/0/0`；不要从历史文档恢复这些脚本，当前 capability 统一以本文顶部 exact row `1/1/0` 为准。

## Probe

```bash
npm run crown:probe
```

默认打开 `https://m321.mos077.com`，并使用 `data/crown-profile` 保存登录态。

流程：

1. 在打开的浏览器里手动登录皇冠。
2. 手动进入目标页面，例如足球今日、早盘或滚球。
3. 回到终端按 Enter 采集当前页面。
4. 如需记录切换页面时的请求，输入 `r` 后在浏览器里切换联赛或盘口。

Probe 输出目录：

```text
data/crown-probe/<timestamp>/
```

常见文件：

| 文件 | 内容 |
|---|---|
| `network.jsonl` | 请求/响应流水，header 和提交参数已脱敏 |
| `network-summary.json` | Network 汇总 |
| `json-responses/` | JSON 响应样本 |
| `*/dom-events.json` | 从 `game_<id>` 结构识别出的原始赛事卡 |
| `*/football-today-filtered.json` | 今日足球赛前/滚球过滤结果 |
| `*/page-text.txt` | 当前页面可见文本 |
| `*/page.png` | 当前页面截图 |

## Fixture 回放

固定 baseline：

```text
data/fixtures/crown/20260708_004011
```

XML fixture：

```text
data/fixtures/crown/transform-xml
```

包含 `get-game-list-today.xml`、`get-game-more.xml`、`get-game-list-live.xml`、空赔率、封盘、登录失效 HTML、非法 XML 样本。

已知原始数量：

| 项目 | 数量 |
|---|---:|
| 赛前足球 | 20 |
| 滚球足球 | 18 |
| 电竞/虚拟泄漏 | 0 |

当前白名单回放结果：

| 项目 | 数量 |
|---|---:|
| 赛前赛事 | 10 |
| 滚球赛事 | 5 |
| 标准赔率记录 | 175 |

运行：

```bash
npm run crown:replay:fixture
```

输出：

- `data/fixtures/crown/20260708_004011/replay-normalized.jsonl`
- `data/fixtures/crown/20260708_004011/replay-summary.json`

## Endpoint 分析

```bash
npm run crown:analyze:fixture
```

输出：

- `data/fixtures/crown/20260708_004011/endpoint-candidates.json`
- `data/fixtures/crown/20260708_004011/endpoint-candidates.md`

当前结论：Network JSON 更像比赛资料、统计和时间线，不应直接当作已确认赔率源。

当前真实赔率结论：`transform.php text/xml` 是主源，DOM 是 fallback / cross-check。

## Watcher

离线验证：

```bash
node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/20260708_004011
```

真实监听：

```bash
npm run crown:watch -- --monitor-state-version 2
```

Watcher 行为：

- 默认 `--monitor-state-version 2`；有启用监控账号时使用 API session 读取 `get_game_list` 和多个 `get_game_more`。
- 赛前和滚球配置可独立启停，但由同一个 watcher 同时处理，不为监控模式拆分进程。
- live watcher、schema-v1 回滚和 `--login-test` 在任何登录/poll/runtime 输出前取得 SQLite lease；相同 DB/runtime 的第二实例 fail-closed，过期后 fencing token 原子递增接管。离线 `--from-fixture` 不占 live lease。
- 完整 list 建立 authoritative event set；detail 只增量更新当前赛事，不移除其他赛事。
- 第一次 list/detail 只建 baseline；第二次有效变化才生成事实 Change。
- Change 经 StrategyEngine 产生持久 Signal；Dispatcher 和 Candidate Builder 只消费 Signal。
- 写 `*-v2.jsonl` 审计和 SQLite 当前状态；重启不从旧 JSONL 尾部恢复 active set。
- DOM/page response/WebSocket 与 fixture 保持 schema-v1 兼容，只做 fallback/cross-check。
- 不导入或调用真实投注 adapter。
- Dashboard 比赛表按 UTC 开赛时间升序、空值置后，显示北京时间、`high|inferred|invalid|missing` 质量和解析 warning；监控设置的“数据质量与诊断”逐赛事显示 eventKey、联赛、主客队和原因。
- 每 30 秒输出 XML 统计：`xmlResponses`、`getGameListCount`、`getGameMoreCount`、`xmlEvents`、`normalizedRecords`、`snapshotWrites`、`changeWrites`、`parseErrors`、`emptyXmlResponses`、`loginExpiredResponses`、`lastXmlAt`、`lastSnapshotAt`。

临时回滚：

```bash
npm run crown:watch -- --monitor-state-version 1
```

schema-v1 会打印 `DEPRECATED` 生命周期警告，只写旧路径。它的 list/detail 全集语义会制造事件增删抖动，只能短期使用。完整操作见 `docs/crown-monitor-v2-runbook.md`。

## Runtime 输出

- 正常保存点击清理前的赔率历史：
  - `data/runtime/crown-odds-snapshots-v2.jsonl`
  - `data/runtime/crown-odds-changes-v2.jsonl`
- `data/runtime/betting-candidates-v2.jsonl`
- `data/runtime/crown-watch-runtime.jsonl`

schema-v1 回滚代码仍保留，但历史 v1 JSONL 不再永久保存；需要临时回滚时会重新生成独立旧路径。

运维控制台提供手动“每日开工完全重置”。它不会自动执行；点击确认后清除此前生成的赔率、监控、候选、Signal/TG/inbox、投注账本、card snapshot、幂等锁、pending/unknown、提交/对账、runtime 日志和普通浏览器缓存。现存动态卡片及其联赛占用、账号凭据、登录会话、Telegram、协议抓包与运行依赖保留；真实投注恢复 off，旧盘口可在新一天重新下注。卡片普通删除是物理删除：先终结尚未绑定 batch 的 inbox，再释放联赛；已创建 batch 和历史快照保留到完全重置。

投注协议抓包输出：

- `data/runtime/betting-protocol-captures/<run>/private/raw-network.jsonl`
- `data/runtime/betting-protocol-captures/<run>/public/redacted-network.jsonl`
- `data/runtime/betting-protocol-captures/<run>/public/protocol-summary.json`
- `data/runtime/betting-protocol-captures/<run>/public/protocol-map.md`

`private/` 目录可能包含本机认证请求材料，只能留在本机；公开文档只能引用 `public/` 下脱敏结果。

JSONL 是 append-only。多次运行 fixture watch 会继续追加 snapshot。

## Dashboard

默认用 Docker 启动本地 Dashboard。脚本显式使用 `crown-dashboard` 作为 Compose project name，避免中文目录名影响 Docker Compose：

```bash
npm run crown:dashboard:docker
```

打开：

```text
http://127.0.0.1:8787
```

Dashboard 页面：

- `比赛选择`：比赛列表、北京时间/质量诊断、筛选、详情抽屉、追踪/取消追踪。
- `赔率监控设置`：赛前/滚球独立 Switch、参数配置、运行健康和逐赛事诊断。
- `投注规则`：动态卡片 CRUD/CAS；卡片名称、至少一个今日联赛、目标赔率区间、正整数 CNY 金额和备注。今日手动追踪联赛只进入选项目录，仍需显式选择；被其他现存卡片占用的联赛不可选。
- `投注账号配置`：每账户可手工修改整数 CNY `perBetLimit`、顺序、暂停/启用 fresh check、accepted-only 今日统计和 child 账本；用户不再配置精度或 step。测试中的 `50 CNY` 不是生产默认值或统一上限。
- `运行控制台`：watcher freshness、全局 runtime、unknown/reconciliation、账号和最近 batch 的 bounded 汇总。

Dashboard 行为：

- 读取本地 JSONL 和 `config/monitored-leagues.json`。
- 任一 v2 文件存在时使用整个 v2 generation，不和 v1 snapshots/changes 混合。
- 显示最后权威批次、active events、selection baselines、Signal、待投递和 dead-letter。
- 显示缺开赛时间/滚球时钟等数据不完整原因；诊断可展开到 eventKey、联赛和主客队，缺数据的策略 fail-closed。
- 使用 SQLite 保存本地配置，Docker 默认写入 `crown-storage:/app/storage`。
- Docker 容器内绑定 `0.0.0.0:8787`，宿主机访问 `http://127.0.0.1:8787`。
- Docker 以只读挂载读取 `data/runtime`、固定 fixture 和 `config`，以可写 volume 保存 SQLite。
- 保留 `/api/health`、`/api/summary`、`/api/events`、`/api/changes`、`/api/config`。
- 新增 `/api/app/*` 保存追踪比赛、账号和规则配置。
- 可通过受管 child 启停 watcher，但 Dashboard 自身不打开皇冠页面、不执行 poll、不写 runtime 数据；手动 CLI 和 child 共享单实例 lease。
- 不包含 Dashboard 发起的真实下注执行、自动金额输入或提交交互。
- 账号 secret 会自动使用本地密钥加密保存，API 只返回 `hasSecret`。

本机 Node.js 方式仍保留用于调试：

```bash
npm run crown:dashboard
```

## 联赛白名单

配置文件：

```text
config/monitored-leagues.json
```

当前规则：

- 默认忽略未配置联赛。
- include 命中才保留。
- exclude 关键词优先级高于 include。
- 电竞、电子、虚拟、梦幻足球等默认排除。

## 提醒

配置文件：

```text
config/alerts.json
config/telegram-settings.json
```

`config/telegram-settings.json` 是本机私有配置，已加入 ignore；脱敏模板是 `config/telegram-settings.example.json`。

Console alert 默认开启。Telegram 可通过设置页保存到本机配置，也兼容环境变量：

- `CROWN_TELEGRAM_BOT_TOKEN`
- `CROWN_TELEGRAM_CHAT_ID`

提醒内容只包含比赛、盘口、旧赔率、新赔率和时间，不包含 token、cookie 或 header。

## 文档入口

- `docs/safety-boundary.md`
- `docs/crown-football-field-map.md`
- `docs/modules/crown-football-monitor.md`
- `docs/crown-monitor-v2-runbook.md`
- `docs/modules/crown-dashboard.md`
- `docs/betting-architecture.md`
- `docs/betting-contract.md`
- `docs/crown-betting-protocol-map.md`
- `docs/superpowers/plans/2026-07-09-crown-betting-protocol-capture.md`
- `docs/project-memory.md`

## 验证

```bash
npm test
npm run check
node --test tests/crown-watch-state-version.test.mjs tests/crown-monitor-v2-integration.test.mjs
npm run crown:analyze:fixture
npm run crown:replay:fixture
node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/20260708_004011
node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/transform-xml
node --test tests/crown-transform-xml.test.mjs
node --test tests/crown-jsonl-store.test.mjs
node --test tests/crown-dashboard-jsonl.test.mjs
node --test tests/crown-dashboard-data.test.mjs
node --test tests/crown-dashboard-server.test.mjs
node --test tests/crown-dashboard-docker.test.mjs
node --test tests/crown-dashboard-spa.test.mjs
npm --prefix frontend run test
npm --prefix frontend run build
```

投注执行边界检查：

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs,frontend\src\**\*.ts,frontend\src\**\*.tsx -Pattern 'placeBet|submitBet|betSlip|betslip|openTicket|confirmOrder|submitOrder|stakeAutomation' -SimpleMatch
```

预期不会在监控路径命中下注执行函数；后续真实执行只能位于独立投注模块，并通过确认、限额和审计。
# 历史：C 阶段统一自动投注状态（2026-07-12）

统一监控投注链路已经完成离线实现与回归：`Change -> priority winner -> one-market claim -> 60+40 ordered allocation -> per-account queue -> outcome/restart recovery`。用户规则的 canonical 字段是 `mode/period/marketType/monitoredSide/minWaterRise/targetOddsMin/targetOddsMax/targetAmountMinor/leagueNames`，监控与真实投注开关独立；真实开关必须依赖监控开关。

运行语义：同一 event/mode/period/market/line identity/line value/actual side 生命周期只取得一次资格；新 line identity 或 line value 可取得新资格。`accepted` 计入金额并释放账号锁，`rejected` 终止且不转投，`unknown` 保留金额与账号锁并只进入对账，不自动重投。账号暂停为 `enabled -> pause_pending -> paused`，已有队列完成后暂停；重新启用为 `paused -> checking -> enabled`，必须重新登录、读取比赛/会员/余额。

该历史阶段的真实投注意图已持久化。启动后先进入 `armed_waiting` 并重新执行 13 项预检，只有全部通过才可进入 `running`。当时能力矩阵 `crown-protocol-capabilities-v2:23628f891d1edb9a` 的 preview/submit/reconciliation 覆盖为 `0/0/0`，因此真实 Crown worker 与 submit 网络调用保持阻断；该数值不是当前 capability。

该历史阶段的真实运行意图唯一入口是 Dashboard `/operations` 的全局开关；具体规则来自 `/betting-rules` 动态卡片。不要独立启动 real worker；Dashboard 只有在全局意图已开启且全部预检通过后，才会通过受控 IPC/ready-ticket 启动并激活 worker。当时 capability 为 `0/0/0`，当前 capability 以本文顶部 `1/1/0` 为准。

本机运行：

```powershell
npm run crown:dashboard
# 打开 http://127.0.0.1:8787/betting-rules 配置动态卡片
# 历史 C 阶段当时：打开 http://127.0.0.1:8787/operations 启动 Watcher；真实投注总开关受 capability 0/0/0 阻断
```

停止顺序：先在 Dashboard 确认“停止真实投注”，关闭新 claim 并取消可证明未发送的 child；再在 `/operations` 确认 unknown/reconciliation 状态；然后停止 Watcher，最后 `Ctrl+C` 关闭 Dashboard。

`crown:betting:worker` 仅用于默认 `off`、fake-script `simulated` 或只读 `preview` 调试。real 模式需要 Dashboard 父进程提供的私有 ready-ticket/GO IPC，不能独立运行：

```powershell
npm run crown:betting:worker -- --mode simulated --once --db-path <temporary.sqlite> --simulated-script-json '<non-empty-json-array>'
```

完整验证：`npm test`、`npm run check`、`npm --prefix frontend run test`、`npm --prefix frontend run build`、`docker compose -p crown-dashboard config`。
