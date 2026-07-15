# Crown Dashboard

## 2026-07-12 动态投注规则卡片当前契约

- `/monitor-alerts`：赛前、滚球两张独立报警卡片，可同时启用；“动水阈值”同时监控上涨和下降。
- `/betting-rules`：唯一当前投注规则入口，显示任意数量的动态卡片；卡片不含 mode，真实执行 mode 只来自 Signal。历史 `/auto-bet-rules` 重定向到此页。
- 卡片普通保存要求至少一个今日联赛；联赛选项由默认联赛命中与 exact 手动追踪赛事合并产生。手动联赛必须显式选择；其他现存卡片占用的联赛禁用并显示 owner name，当前卡片的 stale 联赛允许保留。
- 同一联赛只能被一张现存卡片占用，停用不释放。删除使用 expectedVersion CAS 和物理删除，成功后立即释放联赛；未绑定 batch 的 inbox 终结，已创建历史保留。
- Operations 只读取 `ruleCards:{total,enabled,reviewRequired,ownedLeagues}`，不再投影固定 prematch/live 投注设置。“每日开工完全重置”保留卡片和联赛占用，清理 card snapshot 在内的运行历史。
- frontend mutation 在发送前核对 app/frontend/schema `dynamic-betting-cards-v1`；缺失或不一致时 fail-closed 并提示重启。当前只开放 exact row `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation capability 为 `1/1/0`；其他 row 与 Reconciliation 继续关闭，真实 runtime 默认 off。
- canonical 字段为 API `waterMoveThreshold`、SQLite `water_move_threshold`；旧 `water_rise_threshold` 只作为数据库迁移输入。
- 未配置的赔率和目标金额在输入框显示为空，不显示字符串 `null`。

## 历史快照：2026-07-12 C 阶段契约（当前以上方动态卡片为准）

- 本节只记录动态卡片之前的 C 阶段历史，不是当前有效契约；当前页面、schema、API 与执行身份只以上方动态卡片 section 为准。
- 当时 `/auto-bet-rules` 是统一规则入口；该路由后来只保留重定向，不再是 mutation 或执行入口。
- 当时迁移规则需在统一编辑表单中完整检查所有字段并显式确认复核；普通局部编辑不能解除 `migration_review_required`。
- 当时 `/betting-accounts` 已只接受整数 CNY 单笔上限，UI 不再配置 amount precision 或 stake step；启用账号需完成 fresh login、足球数据、member data 与可用 CNY 余额检查，否则保持暂停并返回 `balance-unavailable`。
- 当时 Dashboard 已具有持久化全局真实投注意图、规则独立 monitor/real 开关、账号暂停/启用和运维控制台，但这不代表 Crown 真实提交能力开放。
- 该历史快照的 canonical Crown capability matrix 为 preview/submit/reconciliation `0/0/0`，因此 production 真实投注被阻断，不发送 `FT_bet`，也不猜测协议字段。
- 当时 `/operations` 提供手动“每日开工完全重置”且不自动执行；它清空点击前的监控与投注运行数据，保留账号凭据、登录会话、规则、Telegram、协议证据和运行依赖，重置后 runtime 为 off。

## 2026-07-11 默认本机免密

- 发布默认无需 `.env` 或 Dashboard 密码：来自真实 loopback 且使用 loopback Host 的页面会获得进程随机 CSRF token，顶部显示“Dashboard 本机免密”，可直接保存规则、启停监控和检测账号。
- 免密模式仍要求写请求携带同源 Origin 和正确 CSRF token；其他设备、跨站页面、伪造 localhost Host 和错误 token 都不能写入。
- 默认 server 仍只绑定 `127.0.0.1:8787`。显式配置密码或远程 Host/Origin 时关闭免密模式，恢复原密码 Session 安全流程。
- 该变化不增加 Dashboard 真实投注入口，不改变 watcher/executor lease，也不启动 betting worker。

## 2026-07-11 写操作认证与账号检测

- 所有配置写操作仍要求 CSRF；显式密码模式还要求 Dashboard session。本机默认无密码时使用上一节的 loopback local-trust，不再要求登录。
- `/betting-rules` 对认证失败不再显示“请检查规则字段”；`/monitor-settings` 的 Switch 在请求失败时保持真实服务端状态，并在请求进行中锁定以避免连续点击产生多条错误。
- `/betting-accounts` 新增“检测账号”：手动触发 fresh Crown 登录、只读赔率访问验证和账号摘要读取。卡片分别显示“登录访问”“Crown 返回余额/额度（仅展示）”和“执行余额”，避免混淆展示值与执行风控余额。
- 新增 `POST /api/app/betting-accounts/:id/actions`，当前只接受 `check-access`。接口仅返回脱敏状态、错误码、展示余额/币种和检测时间；账号 busy/locked 时返回冲突，不会读取或返回 secret。
- 手动联机检测只使用账号自身已保存且验证通过的 public HTTPS exact origin；不存在额外静态 membership whitelist。该动作不会调用投注预览或提交接口，真实投注开关保持不存在。
- 编辑旧账号时允许保留 `0` 限额/步进；切换金额精度会移除超出精度的尾随零，真正有值的小数超限显示中文字段错误。零步进账号仍不能进入执行账本。
- 新建投注账号默认金额精度为 `0 位`，单笔上限和投注步进默认按整数填写；现有账号保持原精度，避免静默改写。
- 2026-07-11 实机页面验收通过免密规则保存、监控 Switch 关闭/恢复、第一个账号登录和余额/币种展示；第二个账号返回稳定的登录失败状态，未伪造余额。
- 验证：backend 756/756、syntax 163、frontend 51/51、production build 通过。

## 历史：2026-07-11 B 阶段完成边界

- B1/B2 Task 1–12 的后台账本、安全门禁、对账和通知基础设施已完成并通过复核。
- Dashboard 仍没有真实投注开关、人工对账入口或自动提交入口；普通 CRUD 不能把规则升级为 `real_eligible`。
- 当时 canonical Crown preview/submit capability 为 0，production Provider fail-closed，因此该历史 B 阶段完成不等于已开放真实投注；当前 capability 以上方动态卡片契约中的 exact row `1/1/0` 为准。
- Dashboard 继续只展示脱敏 batch/child/accepted 统计；provider reference、session、ticket、token 和密码不进入 API 投影。

## 历史：2026-07-11 B1 Dashboard 当时状态

- `/betting-rules` 使用 B1 规则契约：联赛精确多选、Signal 源赔率上下界、目标金额/币种/scale 和固定反打方向；规则金额与账号单笔限额分离。普通 CRUD 只能保持 `preview_only`，不能打开真实执行。
- `/betting-accounts` 显示账号顺序、币种/scale、单笔上限、step、余额状态和 child 明细；今日真实统计按 `Asia/Shanghai` 只汇总 `accepted` child，不把 preview/rejected/unknown 算作成功。
- Dashboard 可查看近期 batch/child 的 target/reserved/accepted/unknown/unfilled、finish reason 和模拟标记；provider reference 仅返回 null/掩码。
- `/matches` 显示北京时间、时间质量和 warning，按 UTC 升序且空值置后；`/monitor-settings` 保留赛前/滚球两个独立 Switch，并提供默认折叠的逐赛事“数据质量与诊断”。
- Dashboard child 和手动 watcher CLI 使用同一 canonical SQLite lease。`restart:true` 遇到相同 key 的未退出受管 child 时返回 `alreadyRunning` 并复用，不 kill；不同 key 明确冲突。
- 当时 Dashboard 没有真实投注开关或自动提交入口。B2 后台基础设施已完成，但该历史阶段 canonical Crown capability 为 0；旧 `crown-bet-execute*` CLI 不属于现行多账号 Executor。当前 capability 以上方动态卡片契约中的 exact row `1/1/0` 为准。

## 2026-07-09 投注账号顺序与预览失败显示

- `/betting-accounts` 依赖当前 Dashboard API 返回 `betOrder`；如果页面一直显示“未设置”，优先检查 8787 是否仍是旧 Node 进程，重启 Dashboard 后再通过编辑弹窗或 API 保存顺序。
- 投注历史的 `preview-rejected` 会显示 Crown 预览失败 code，例如 `预览失败 code=555 / 1X001`；旧历史如果没有保存 `errormsg`，至少会显示 `code=555`。

## 2026-07-09 下注配置页面卡片化

- `/betting-rules` 不再使用表格，改为横向配置卡片；页面只显示规则名称、单账号每次投注额度、单账号日投注上限额度，新增/编辑弹窗也只保留这三个字段。
- `/betting-accounts` 不再使用账号表格和独立历史表格，改为横向账号卡片；卡片默认展示账号、网址、今日总投注次数、今日总投注金额，点击卡片展开该账号历史投注。
- 投注账号今日统计来自 `betting_history` 中本地日期为今天的记录数和金额总和，不允许手工填写。
- 投注历史展示字段收窄为联赛名字、比赛队伍、投注盘口、投注金额、投注时间；后端会从新旧历史结构中归一出 `leagueName`、`teams`、`market`、`betTime`。
- 投注账号密码仍按 secret 加密保存，列表、卡片、历史和 API 响应不返回明文密码；删除账号时保留历史投注记录。
- `/betting-accounts` 新增“投注顺序”字段，保存为 `betOrder` / SQLite `bet_order`；页面卡片显示该顺序，未设置显示“未设置”，账号列表按手动顺序升序显示，未设置顺序的账号排最后。
- 投注成功通知机器人配置继续在 `/settings` 的 `betSuccess` 下维护；本地配置已启用并复用当前接收 Chat ID，API/UI 仍只返回 token 掩码。

## 2026-07-08 阶段更新

- 新增 `/monitor-account` 皇冠监控账号页面，第一版只支持一个启用中的监控账号位置。
- 新增 `/default-leagues` 默认联赛页面；默认联赛从 `/matches` 拆出，只按皇冠内部联赛名精确匹配。
- `/matches` 重构为上方“今日追踪比赛”、下方“今日全部比赛”；今日全部比赛优先使用 XML live 数据，没有 XML live 时才使用 DOM fallback。
- `/matches` 比赛详情抽屉只展示已记录的赔率/盘值变化，列为变化时间、类型、变化项目、变化前、变化后；不再展示当前全量盘口列表，并且只显示让球与大小球变化。
- `/matches` 每 30 秒静默刷新赔率 summary、联赛列表和变化记录；后台抓取有新 XML 时，页面“最近更新”会自动变化，不需要手动刷新。
- `/matches` 详情抽屉打开后按当前比赛 `eventKey` 单独读取变化历史并缓存；自动刷新不会再因为全局最近变化列表滚动而清空当前比赛记录。
- 监控设置删除最大追踪联赛数和最大追踪比赛数；用户配置多少默认联赛/追踪联赛就追踪多少。
- `/api/app/monitor-account` 和 `/api/app/monitor-account/actions` 提供单账号配置、状态展示和测试登录/开始/停止/手动重登/清除状态动作。
- Dashboard 仍不直接打开皇冠页面；实际登录、掉线检测、XML 响应时间、赔率解析时间和自动重登状态由 `scripts/crown-watch.mjs` 写回 SQLite。
- `/api/app/monitor-account/actions` 的 `start` 不会强杀同一 lease key 下仍运行的受管 watcher；进程控制返回 `alreadyRunning/reused`。请求另一 DB/runtime key 时 fail-closed，避免错误复用或杀死现有 child。
- 赔率报警过滤同时看默认联赛和手动追踪比赛；`/matches` 写入 SQLite 的 active tracked matches 会传给 `crown-watch`，避免非默认联赛的手动追踪比赛被 `league_not_allowed` 全部挡掉。
- watcher 触发报警后会写回 `config/monitor-settings.json` 的 `lastAlertAt`，`/monitor-settings` 的“最近触发报警”可显示真实触发时间。
- 数据源卡片对 XML live 增加 2 分钟过期判断；最近更新时间从 `lastXmlAt`、`lastSnapshotAt`、`lastCapturedAt` 和 runtime 文件更新时间里取最新值，超过 2 分钟未更新才显示“赔率更新异常”，避免 runtime log 时间滞后但快照仍更新时误报。
- 安全字段保存后不回显明文；监控账号密码在已保存时显示只读“已保存”和“修改”按钮，未点击修改前不显示空密码框。

## 目标

提供 Docker-first 的本地 Crown 配置与赔率监控界面。当前版本用 React + Ant Design 展示赔率监控数据；比赛追踪仍复用 SQLite，本地默认联赛、监控模式和 Telegram 配置保存到 `config/*.json`。Dashboard 管理规则/账号并读取 batch/child 账本，不因页面加载、登录或普通配置自动提交。B2 后台基础设施已完成；当前仅开放 exact row `prematch/full_time/asian_handicap/main` 的 capability `1/1/0`，其他 row 与 Reconciliation 关闭，真实 runtime 默认 off。历史独立 CLI 不是当前多账号真实执行入口。

## 文件

| 类型 | 路径 | 职责 |
|---|---|---|
| JSONL reader | `src/crown/dashboard/jsonl-reader.mjs` | 尾部读取或流式过滤 watcher 写出的 JSONL，避免整读大 runtime 文件 |
| Data module | `src/crown/dashboard/dashboard-data.mjs` | 聚合 summary、events、changes、config，并按 API 分路径读取 |
| HTTP server | `src/crown/dashboard/static-server.mjs` | 提供旧只读 API、新 `/api/app/*` API 和 React 静态文件 |
| App DB | `src/crown/app/app-db.mjs` | 使用 `node:sqlite` 建表、开启 WAL、管理 SQLite 路径 |
| App repository | `src/crown/app/app-repository.mjs` | 持久化追踪比赛、账号、规则和投注历史 |
| App API | `src/crown/app/app-api.mjs` | `/api/app/*` 路由、JSON 请求、错误响应 |
| Local JSON API | `src/crown/app/local-config-api.mjs` | `/api/matches/leagues`、默认联赛、监控设置、Telegram 设置 |
| Secret helper | `src/crown/app/app-secret.mjs` | 自动生成本地密钥并用 AES-256-GCM 加密账号 secret |
| League aggregation | `src/crown/dashboard/league-aggregation.mjs` | 将当前事件聚合成联赛行 |
| Monitor settings | `src/crown/monitor/monitor-settings.mjs` | 赛前/滚球独立启停、时间过滤、动水阈值、skip reason |
| JSON config | `src/crown/config/*.mjs`、`config/*.json` | 默认联赛、监控设置、Telegram 配置读写、掩码 |
| CLI | `scripts/crown-dashboard.mjs` | 读取 host、port、DB path、static dir 并启动 server |
| Frontend | `frontend/` | React 18 + Vite 8 + Ant Design 5 七页管理 UI |
| Tests | `tests/crown-*.test.mjs`、`frontend/src/App.contract.test.tsx` | 后端、Docker、SPA fallback、前端 contract 测试 |

## 页面

| 页面 | 路由 | 内容 |
|---|---|---|
| 比赛选择 | `/matches` | 今日追踪比赛、今日全部比赛、联赛追踪/取消追踪 |
| 默认联赛 | `/default-leagues` | 皇冠内部联赛名精确白名单、启用状态、监控模式 |
| 皇冠监控账号 | `/monitor-account` | 单个监控账号配置、登录状态、在线检测、XML/赔率解析状态、监控动作 |
| 赔率监控设置 | `/monitor-settings` | 赛前/滚球独立配置和 Switch、运行统计、数据质量与诊断 |
| 下注规则设置 | `/betting-rules` | B1 规则 CRUD、联赛占用冲突、源赔率区间、目标金额和近期 batch；无真实开关 |
| 投注账号配置 | `/betting-accounts` | 账号 CRUD、投注顺序、只读登录/访问检测、Crown 展示余额/额度、单笔上限/step/独立执行余额、accepted-only 今日统计和 child 账本 |
| 设置 | `/settings` | Telegram 赔率报警机器人、投注成功通知机器人 |

## API

旧只读 API 保持兼容：

| Endpoint | 内容 |
|---|---|
| `GET /api/health` | server 状态和 `readonly: true` |
| `GET /api/config` | `config/monitored-leagues.json` 读取结果 |
| `GET /api/summary` | 文件状态、snapshot/change/event/league 统计和最新时间 |
| `GET /api/events` | 按 `provider|league|homeTeam|awayTeam|mode` 聚合后的事件 |
| `GET /api/changes` | 最近赔率变化，默认最多 100 条；支持 `eventKey` 和 `limit` 查询单场历史 |

新增配置 API：

| Endpoint | 内容 |
|---|---|
| `GET /api/app/bootstrap` | 返回配置、历史、赔率 summary/events/changes |
| `POST /api/app/tracked-matches` | 追踪或取消追踪比赛 |
| `GET /api/app/monitor-account` / `PUT /api/app/monitor-account` | 单个皇冠监控账号位置 |
| `POST /api/app/monitor-account/actions` | 测试登录、开始、停止、手动重登、清除状态 |
| `/api/app/monitor-accounts` | 监控账号 CRUD |
| `/api/app/monitor-rules` | 监控规则 CRUD |
| `/api/app/betting-rules` | 历史规则只读证据；mutation retired/410 |
| `/api/app/auto-betting-rule-cards` | 当前动态卡片 list/create |
| `/api/app/auto-betting-rule-cards/:cardId` | 当前动态卡片 CAS update/delete |
| `/api/app/today-betting-leagues` | 当前今日联赛、owner 与 stale projection |
| `/api/app/betting-accounts` | 投注账号 CRUD；`/:id/actions` 提供手动只读 `check-access` |
| `GET /api/app/bet-batches` | 有界读取近期 B1 batch；金额使用十进制字符串，引用保持掩码 |
| `GET /api/app/bet-batches/:id/children` | 有界读取 batch child ledger 与 preview/submit 状态 |
| `GET /api/app/betting-history` | 投注历史列表，当前阶段默认空 |
| `GET /api/matches/leagues` | 当前事件按联赛聚合，包含默认白名单命中和追踪状态 |
| `POST /api/matches/leagues/track` | 追踪当前联赛下已出现事件 |
| `POST /api/matches/leagues/untrack` | 取消追踪当前联赛已有事件 |
| `GET /api/default-leagues` / `PUT /api/default-leagues` | 默认联赛 JSON 配置和命中状态 |
| `GET /api/monitor-settings` / `PUT /api/monitor-settings` | 监控设置 JSON 配置 |
| `POST /api/monitor/start` / `POST /api/monitor/stop` | 独立启动或关闭 `prematch` / `live`；两种模式由同一 watcher 处理 |
| `GET /api/settings/telegram` / `PUT /api/settings/telegram` | Telegram 配置，API 只返回 token 掩码 |
| `POST /api/settings/telegram/test` | 发送 Telegram 测试消息 |

## 数据源

页面当前状态与历史审计已分离：

- `/api/matches/leagues`、联赛 track/untrack 回读、`/api/default-leagues` 和 `/api/monitor-settings` 只读取 SQLite `monitor_event_state`、`monitor_selection_state`、`monitor_scope_state` 的 active 当前投影，不读取 snapshot/change JSONL 或 fixture。
- 当前投影复用 canonical `buildEvents()` DTO；读取使用只读 SQLite transaction，tracked-match GET 也使用 read-only connection，不在页面请求中执行 schema/migration。
- 投影缓存按 resolved DB 路径保存一份，并由主 DB 与 WAL 文件版本共同失效；WAL-only commit 已有回归覆盖，数据库变化后不会返回旧对象。
- 当前三表投影不提供 Signal、Candidate、Delivery 运行计数，`monitorHealth.available=false` 并返回稳定 reason，禁止把未知计数伪装为健康的 0。

历史审计接口仍读取 JSONL：

- `data/runtime/crown-odds-snapshots.jsonl`
- `data/runtime/crown-odds-changes.jsonl`
- `data/runtime/crown-watch-runtime.jsonl`
- `config/monitored-leagues.json`

Dashboard API 不再默认整读大 JSONL 文件：

- 页面进入 `/matches` 和 30 秒列表刷新只调用 `/api/matches/leagues`，不请求 global `/api/changes`。
- `/api/summary` 和 `/api/events` 只读取最近 snapshot/runtime log 行。
- `/api/changes` 直接读取变化文件，不再先构建完整 Dashboard 数据。
- 指定 `eventKey` 的变化历史使用流式过滤并只保留最新匹配记录。
- 详情 Drawer 打开后才请求 `/api/changes?eventKey=...&limit=1000`；列表与详情各自 single-flight，已有数据的后台刷新不显示整表 Spin，旧赛事迟到响应不能污染当前 Drawer。

数据源显示规则：

- runtime snapshots 来自 `crown-transform-xml` 时显示 `XML live`。
- runtime snapshots 来自 DOM normalizer 时显示 `DOM fallback`。
- runtime snapshot 缺失或为空时显示 `fixture replay`。
- `/matches` 普通页面显示中文数据源摘要、今日比赛数和最近更新时间。
- `/matches` 的 XML live 最近更新时间超过 2 分钟时显示异常状态；最近更新时间按实时 XML、快照、汇总捕获时间和 runtime 文件更新时间里的最新值判断。
- `/matches` 不再显示 `lastXmlAt`、`xmlResponses`、`recordCount`、`oddsId=null / not available`、`disabled-preview-only` 等调试字段。
- 新采集和新写入的赔率数据只保留 `asian_handicap` 让球与 `total` 大小球；历史 JSONL 中已有的独赢、单双、yes/no 等变化记录在详情页过滤不展示。
- 详情抽屉的变化记录按比赛 `eventKey` 从 JSONL 查询，不依赖全局最近 100 条列表。

当 runtime snapshot 缺失或为空时，事件视图回退到固定 fixture：

- `data/fixtures/crown/20260708_004011/replay-normalized.jsonl`

该 fixture fallback 只属于 legacy `/api/events`、`/api/summary` 历史兼容路径，不进入上述页面当前状态 API。

### 2026-07-13 页面性能与 Checkbox 验收

- 隔离端口 8799 使用正式库克隆、当前 production build 和系统 Chrome 验收；正式 8787 与 watcher 当时均未运行，因此没有重启服务，也没有把隔离结果写成正式持续写入验收。
- 模拟每次 watcher commit 的 20 次 cold `/api/matches/leagues` P95 为 499.8ms；数据库版本不变的 20 次 warm P95 为 79.2ms；页面内部时钟采样 20 次菜单点击到内容可操作 P95 为 615.2ms。
- 进入 `/matches` 没有 global `/api/changes`；30 秒窗口只有一次列表请求，最大并发 1，现有内容保持且 `.ant-spin-blur=0`。
- 1920×1080、1024×768、390×844 三档均检查 7 个选中 Checkbox：内框 16×16、蓝框白勾居中、文字基线正常、页面横向 overflow=0、console error/warning=0。

本地配置数据：

- 默认容器路径：`/app/storage/crown.sqlite`
- 默认本机调试路径：`storage/crown.sqlite`
- Docker volume：`crown-storage:/app/storage`
- JSON 配置：
  - `config/default-leagues.json`
  - `config/monitor-settings.json`
  - `config/telegram-settings.json`

账号 secret 字段自动用本地密钥加密保存，默认密钥文件为 `storage/crown-local-secret.key`。Telegram token 保存到本地 JSON，但 API/UI 只显示掩码，不返回明文。

## 安全边界

- Dashboard 可以写本地 SQLite 配置。
- Dashboard 可以写 `config/*.json` 本地配置。
- Dashboard 通过 `/api/app/monitor-account/actions` 启动、停止或重启 watcher 子进程。
- Dashboard 不打开皇冠页面。
- Dashboard 不构造皇冠下注请求。
- Dashboard 不写 runtime JSONL 数据。
- Dashboard 不显示 cookie、token、authorization、set-cookie 或浏览器 profile 信息。
- 下注规则保存为本地配置；普通 CRUD 不能升级为 B2 `real_eligible`。
- 当前 Dashboard 没有点击盘口、填写金额、打开投注单或提交订单的执行代码。
- 后续真实投注执行必须进入独立投注模块，并经过确认、限额和审计。
- 历史登录诊断清理见 `docs/login-diagnostics-security-runbook.md`；默认命令只审计，实际 `--apply` 必须获得目标目录授权，清理后还要轮换密码并失效 session/cookie。

## 运行

本机 Node.js 调试：

```powershell
npm run crown:dashboard
```

Docker 默认方式：

```powershell
copy .env.example .env
docker compose -p crown-dashboard up --build
```

打开：

```text
http://127.0.0.1:8787
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CROWN_DASHBOARD_HOST` | `127.0.0.1` 本机 / `0.0.0.0` Docker | Server 绑定地址 |
| `CROWN_DASHBOARD_PORT` | `8787` | Server 端口 |
| `CROWN_DB_PATH` | `storage/crown.sqlite` 本机 / `/app/storage/crown.sqlite` Docker | SQLite 路径 |
| `CROWN_STATIC_DIR` | `frontend/dist` 本机 / `/app/frontend/dist` Docker | 静态页面目录 |

## 验证

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
node --test tests\crown-dashboard-spa.test.mjs
node --test tests\crown-dashboard-docker.test.mjs
```

浏览器验收重点：

- 左侧导航有七个页面。
- `/matches` 上方显示今日追踪比赛，下方显示今日全部比赛。
- `/default-leagues` 只编辑皇冠内部联赛名精确白名单。
- `/monitor-account` 单账号配置和状态字段不显示密码明文。
- `/monitor-settings` 保留赛前和滚球两个独立 Switch，可同时启用，并由同一个 watcher 处理。
- `/monitor-settings` 的“数据质量与诊断”默认折叠，展开后显示 eventKey、联赛、主客队和具体原因。
- `/matches` 的北京时间、时间质量和 warning 与 API 一致；按 `startTimeUtc` 升序，空时间置后。
- `/settings` Telegram token 不明文显示。
- 比赛追踪、默认联赛、监控设置、Telegram、下注规则、投注账号刷新后仍保留。
- secret 保存后只显示 `hasSecret`，不显示明文。
- 窄屏下页面无明显文字重叠。
- `/matches` 打开后不手动刷新，等待一个抓取周期，状态卡“最近更新”应自动变为新的时间。
- `/matches` 打开有变化记录的比赛详情，等待一个抓取周期后，抽屉内变化记录不应变成空状态。
- `/matches` 的联赛、主队、客队通过共享 Crown 文本修复器投影，历史 JSONL 中可逆的 GB18030/UTF-8 乱码无需迁移即可正常显示。
# C4 unified operations console（2026-07-12）

- 历史 C 契约曾以 `/auto-bet-rules` 作为统一规则入口；当前该路由只重定向，动态卡片入口和 Operations 全局控制以上方当前契约为准。
- `/betting-accounts` 显示整数 CNY 单笔上限、访问/余额、allocation 状态和 execution lock；暂停会先阻止新分配并排空已有队列，启用必须 fresh check。
- `/operations` 使用 bounded aggregate 展示 watcher freshness、runtime、规则、账号、最近批次、全局 unknown、reconciliation 与通知积压。页面可见时 5 秒轮询，隐藏时 30 秒；stale/offline 保留最后数据但禁止 start，stop 保持可用。
- 默认 Node Dashboard 监听 `127.0.0.1:8787`；本机免密仍要求 same-origin CSRF，远程访问必须显式配置安全边界。
- 2026-07-12 browser acceptance 使用临时 SQLite 与 fake account checker 完成 desktop/390px、刷新持久化和 console/network 检查；未读取 live DB，未调用 Crown。

# 安全开工控制台（2026-07-12）

- 每日完全重置统一执行安全开工：停止真实投注、暂停全部非归档投注账号、清理点击前运行数据，再为 enabled 且有密文的主监控账号自动启动 watcher。
- Operations Summary 增加 `readiness.monitor/rules/accounts/realBetting`，每段返回 `state/ready/reason`；前端只使用稳定 reason code 显示中文阻断原因，不暴露凭据、lease owner 或 provider reference。
- `/operations` 的日常主流程是监控启停和四段下注准备链路；全局真实投注关闭时只显示开启按钮，requested/running 时只显示停止按钮。存在 unknown、未关闭对账或通知积压时才显示风险面板。
- `/betting-accounts` 的 allocation 开关只控制账号是否可分配。启用会执行 fresh Crown access/balance check，但不会修改规则真实权限或全局真实投注意图。
- 投注账号页通过 `api.getBettingAccountOverview()` 并行读取 `/api/app/betting-accounts` 与 `/api/app/betting-history`，不再读取大型赔率 bootstrap；加载期间不显示假空列表。
- 当前 exact row `prematch/full_time/asian_handicap/main` 已具备 Preview/Submit capability，Reconciliation 与其他 row 的证据仍不足。Operations 必须显示剩余阻断条件，不能把账号启用或 UI 开关本身当作真实执行授权。

## 轻量安全上下文与配置页读取（2026-07-12）
- `/api/app/security-context` 只返回当前请求可用的 `csrfToken` 和 `dashboardAccessMode`，不打开 SQLite、不读取赔率 JSONL。前端 Session 初始化固定使用该接口。
- mutation 遇到 `403 csrf-invalid` 时，前端只允许刷新安全上下文并重试一次；服务端 CSRF 校验发生在业务路由前，因此该重试不会重复已执行的写操作。
- `/api/app/league-options` 从 SQLite active event、tracked match、rule league 与启用的默认联赛生成轻量字符串列表；规则页不再依赖大型赛事聚合响应。
- 旧账号若整数 CNY 单笔上限为 0，启用会 fail-closed。页面显示明确配置提示，服务端返回稳定错误 `betting-account-limit-required`。
## 2026-07-15 每日重置与 Watcher 恢复

- 完全重置包含 Browser acceptance campaign/case 运行记录；这是可重复验收状态，不属于需要保留的用户配置。
- Watcher 自动恢复必须同时满足：托管子进程仍存活、lease key 一致、数据库中有效 lease 的 PID 等于该子进程 PID。否则返回 `watcher-restart-unhealthy`，不显示成功。
