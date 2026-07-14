# Crown Betting Protocol Module

## 2026-07-14 Task 10 accepted-only production row

- 唯一 enabled row 是 `prematch/full_time/asian_handicap/main`，canonical matrix 为 Preview/Submit/Reconciliation `1/1/0`。`RATIO_R + IOR_RH|IOR_RC` 才能形成该 row；滚球 `RATIO_RE`、alternate、first-half、total 和未知变体继续 fail-closed。
- Preview wire：`FT_order_view`、`gtype=FT`、`wtype=R`、`chose_team=H|C`。Submit wire：`FT_bet`、`gtype=FT`、`wtype=R`、`rtype=RH|RC`、`chose_team=H|C`、`isRB=N`、`f=1R`；`f=1R` 仅作为已验证 opaque wire 值，不改 period 身份。
- direct accepted 必须同时满足 `code=560`、恰好一个结果标识、request/response 的 `gid/gtype/wtype/rtype` 精确一致，以及 CNY 金额与赔率回显一致。任何缺失、额外结果标识、矛盾响应、超时或断线都在 dispatch 后记为 `unknown`。
- public evidence 使用 schema v3 accepted-only candidate。analyzer 不接受 asserted capability；同一 capture 的 watcher artifact 必须以 digest 绑定 exact `RATIO_R + gid/side/line/odds`，并与 Preview/Submit 一致，否则该行不开放。Preview 的 50/20000 等上下限保持 response 事实，50 倍数明确标记为本地保守策略而非服务端 step 证明。
- session 文件仍不持久化 `protocolVersion` provenance。共享 login manager 只在当前进程内保留与 exact account/uid/origin 绑定的 production login response 证明，Submit 重新读取 account-owned session 后必须与该证明匹配。
- production provider 不接受 caller capability/form/wire/current identity 注入；B2 只传持久化 child amount 与 locked selection。provider 从 latest same-event Crown response 独立重读未 suspended selection 的 8 字段 identity 与赔率，再立即 fresh Preview 核对 current line/odds/min/max/balance 和 amount，全部通过后内部构造唯一 `FT_bet`，并在网络前后及 session 保存前检查 executor fence。每个 child 仅一次请求，当前 production rollout 每 child 固定 50 CNY。

## 历史：2026-07-14 controlled stake probe（已取消，未使用；当前 capability 以上方 Task 10 为准）

- 用户决定不执行 49 CNY rejected probe 或 51 CNY adjacent-step probe；Task 9B 曾准备的 CLI gate、request-intent/effective rewrite、probe pairing/session state 与合成测试均已从当前代码撤销。brief/report 只作为 superseded 历史记录。
- 普通 capture 恢复 Task 9A 后契约：默认阻断 Submit；真实 capture 必须显式 `--allow-real-submit --confirm REAL_BET`、可见浏览器、正整数 `maxStake <= 50`；service workers 为 `block`，每个 BrowserContext 最多放行一次 exact `FT_bet`，route 不改写页面 body。
- 金额策略当时改为已确认的最小 50 CNY，并保守采用 50 的正整数倍；仍必须同时满足账户 `perBetLimit` 与 fresh Preview 的直接上下限。该历史业务口径当时未改变 Preview/Submit/Reconciliation capability `0/0/0`；当前值以上方 Task 10 的 exact row `1/1/0` 为准。
- outcome 采用 accepted-only：只有 direct response 明确证明 accepted 才可分类 accepted；所有非明确 accepted 的响应与恢复场景统一为 `unknown`，不自动重试或按 rejected 转投。
- Task 9B 未运行浏览器、未访问 Crown/network、未发送 Submit、未改 capability/Provider/worker，也未执行 Git 操作。

## 2026-07-14 exact execution evidence candidate（历史 schema-v1，已被上方 Task 10 schema-v3 取代）

- analyzer 现在可从 matching private/raw 与 public/redacted capture 离线构建 `crown-execution-evidence-candidate-v1`。account/session/execution/result identity 均按已确认的 length-prefixed UTF-8 tuple 做 HMAC-SHA256，key 不进入 public artifact。
- 选取规则限定为唯一 direct `FT_bet`，并绑定最近的、wire identity 一致的成功 `FT_order_view`；Preview strong 只允许 `H/C`，Submit strong 只允许 `Y/N`，且必须满足已确认的 chose-team 关系。spread、currency、account、session、context 或字段集合漂移均 fail-closed。
- capture `20260714-085221` 的 safe candidate digest 为 `sha256:93a640b1d3d7660553cd053e73cd73b4de2a14266e0321d0a298f1370e1afe1`；candidate raw-capture digest `sha256:6bc473a26020015ae3376168005197465d559079f6f2f3f1fa3841b51059827a` 是对 `private/raw-network.jsonl` 原始字节直接计算的 SHA-256。候选包含 4 条有序记录、6 个排除字段、8 个 HMAC binding。
- independent review 修复后，direct Submit response 的 `gid/gtype/wtype/rtype` 必须在 field-set、outcome 和 result binding 处理前与 Submit request 逐一 canonical exact 对照；任一缺失或不等统一报 `submit-response-identity-drift`。
- 该历史 candidate 当时仍保留 direct rejected attempt、integer CNY stake-step 与 exact capability proof 三项缺口，因此当时 Preview/Submit/Reconciliation capability 保持 `0/0/0`。用户随后取消 rejected/step probe，不再计划第二条 rejected capture 或跨 capture combiner；后续按 accepted-only 与 50 CNY 正整数倍口径处理，当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。
- 验证：证据、redaction、classifier、capability matrix 测试共 `82/82` 通过；analyzer 与 capture syntax check 通过。capture 的 service-worker block、单次 exact `FT_bet`、正整数 stake、`--max-stake` 上限和第二次 Submit 阻断均未改。

## 2026-07-14 受控真实 accepted 证据（历史采集结论；当前 capability 以上方 Task 10 为准）

- 在用户提交当刻确认下，抓包 `20260714-085221` 完成一笔 `50 CNY` 的真实 Preview→单次 `FT_bet`。直接 Submit 响应为 HTTP 200、`code=560`，回显金额 50、赔率 0.96、余额 950；Crown 页面同步显示已确认和一笔投注记录。
- 抓包器在整个 BrowserContext 上记录和拦截，因此列表页与比赛详情页产生的新 tab 都受同一安全边界约束；本次 exact `FT_bet` 只出现一次且未被阻断。
- 该 accepted 响应尚不能单独打开 canonical capability：本节描述的是 Task 9A 之前的历史 public artifact，其 `captureId` `sha256:75ec1ecb80c832ebd65f29196fac8f3409bc1a4ee9c99d747d2943968eb47f32` 是对 JSON 序列化后的 capture 目录 basename 计算的 SHA-256，不是 raw capture 内容摘要。随后形成的历史 exact evidence candidate 补齐了 account/session/execution/result HMAC bindings，但当时仍缺 exact capability/`lineVariant`、服务端 integer CNY stake step 来源和 rejected 直接响应，因此该历史阶段的 Preview/Submit/Reconciliation 为 `0/0/0`，自动 worker 保持 fail-closed；当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。

## 2026-07-14 账号现场可执行性契约

- 账号历史登录/余额检查时间不参与全局真实投注启动；每个 child 仅凭执行当刻登录或复用的有效 session、现场读取的皇冠账号信息和 strict `FT_order_view` Preview 取得执行证明。
- 持久化的旧 `betting-account-login-not-fresh`、`betting-account-balance-not-fresh` 在启动和运行 tick 中按当前 preflight 重算。
- exact Preview/Submit capability、`perBetLimit`、精确盘口/赔率/金额和每 child 单次 Submit 约束不变。

## 历史：2026-07-13 自动投注执行契约（当时口径；当前 capability 以上方 Task 10 为准）

- 投注账号按 `bet_order` 严格顺序分配；每个账号的 `perBetLimit` 投注上限保留并可由用户手工修改，`50 CNY` 只是当时测试值，不是固定上限或生产默认值。
- 每个账号在同一 batch 最多使用一次。明确 `rejected` 证明没有创建注单后释放锁，剩余金额转给下一个未使用账号；`unknown` 保留金额与账号锁，禁止自动重试。
- 一个 child 的 Submit 网络请求一旦开始，最多只允许一次提交；超时、断线、截断、未分类响应或无法证明请求未发送的恢复场景全部按 `unknown` 处理，不得再次发送。
- B2 只接受 fresh Preview，并要求其赔率仍处于规则卡冻结快照的赔率区间；canonical 盘口身份使用实际 `handicapRaw`，不再用 `lineKey` 代替 handicap。
- 生产 Preview/Submit capability 当时为 `0/0`。随后在 2026-07-14 取得一笔真实 accepted `FT_bet`，并生成带 account/session/execution/result HMAC bindings 的 exact evidence candidate；该段记录的历史阶段仍因 exact capability/`lineVariant`、服务端 integer CNY stake step 来源及 rejected 响应证据不完整而 fail-closed。当前 capability 只以上方 Task 10 的 exact row Preview/Submit/Reconciliation `1/1/0` 为准。

本节及以下各节均保留为历史演进记录；任何 capability 表述与文件顶部 Task 10 冲突时，均以顶部 exact row `1/1/0` 为准。

## 历史：2026-07-12 动态卡片执行契约

- `/betting-rules` 动态卡片是当前规则入口；卡片不保存 prematch/live，mode 只来自持久 Signal evidence。
- 规则卡的“今日联赛”来自皇冠当前仍开盘的 `monitor_event_state.active=1` 赛事，不按北京时间自然日或未来 24 小时过滤；默认白名单/mode 命中和 active exact 手动追踪仍是准入条件。
- inbox、market-once、batch、ExecutionAuthorization 和 B2 prepare/recovery 均绑定 `cardId + cardVersion + immutable card snapshot`。market-once identity 还包含事件、Signal mode、时段、market、exact line 和对面盘。
- B2 在任何 provider I/O 前校验 card scope 与 allowed Signal mode；`rejected` 不转投，`unknown` 不重投并保留金额和账号锁。卡片删除后已创建 batch 继续按不可变快照处理。
- 普通卡片删除不删除订单历史；完全重置才清理 card inbox/snapshot、batch/child、claim、锁、授权预算、submit/reconciliation/notification 等运行证据，同时保留现存卡片配置。
- app/frontend/schema contract 当时为 `dynamic-betting-cards-v1`。canonical Crown preview/submit/reconciliation capability 当时为 `0/0/0`；旧 adapter/CLI 已删除，不能作为替代执行入口。当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。

## 2026-07-11 本机免密下的手动账号检测边界

- Dashboard 本机免密只改变本地配置 API 的访问方式，不签发任何 Crown preview/submit capability。
- `testBettingAccountAccess()` 在环境 allowlist 为空时可使用账号已保存的 public HTTPS exact origin；这仅覆盖手动 fresh login、`get_game_list` 和 `get_member_data`。
- `ensureBettingSession()`、game-more、生产 Provider、preview/submit 和 worker 仍要求原环境 allowlist、fence、capability 和授权门禁；空 allowlist 继续零网络拒绝。
- 展示余额与执行余额继续分离，账号检测不能增加 batch 可分配资金。
- 实机检测确认 `get_member_data` 在不提供动态 `ver` 时仍返回有效 `get_all_data`、币种和 `maxcredit`；整个动作未调用 `FT_order_view` 或 `FT_bet`。一个账号成功，另一个账号因现有凭据登录失败而保持无余额状态。

## 2026-07-11 投注账号登录与展示余额检测

- `CrownApiLoginManager.testBettingAccountAccess()` 为 Dashboard 提供手动只读检测：强制 fresh login，验证 `get_game_list`，再用抓包确认的只读 `get_member_data` 读取账号摘要。
- 检测不会调用 `FT_order_view`、`FT_bet` 或 `get_dangerous`，也不会签发任何 preview/submit capability；账号 busy/locked 时 fail-closed。
- Crown 摘要中的 `maxcredit` 仅映射为 `reported_balance`/`reported_currency` 供页面展示。它不会写入 B1 `balance_minor`，因此不能增加可分配金额、授权预算或执行能力。
- 访问地址仍采用 public HTTPS exact-origin allowlist，redirect fail-closed；API 只输出稳定错误码和脱敏结果，不输出账号密码、session、cookie 或原始 Crown 响应。
- 验证：相关 focused backend 57/57、完整 backend 756/756、syntax 163；真实账号联机检测未自动执行，真实投注保持关闭。

## 历史：2026-07-11 B1/B2 完成状态

- B1 Task 1–9、B2 Task 10–12 已完成代码实现和安全复核。Task 12 focused 108/108、backend 749/749、syntax 162；三路最终复核均为 0 Critical/Important。
- B2 提供 durable submit attempt、原子授权预算、同账号 fenced lock、unknown 不重投、单 child 恢复、持久对账证据/退避/截止时间、v2 AAD provider reference 和 outcome notification outbox。
- 旧 adapter/CLI 已删除；生产 `CrownAccountExecutionProvider` 在当时 canonical submit capability 为 0 时零网络拒绝。当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。
- 离线 fixtures 不能签发 Crown 能力；生产 reconciliation/manual resolution 未获验证能力时 fail-closed。
- 真实小额验收记录为未执行：没有真实 Crown preview、`FT_bet` 或 Telegram 发送。详见 `.superpowers/sdd/task-12-report.md`。

## 历史：2026-07-11 B1 当前状态

- 历史里程碑：B1 Task 1–9 当时以 backend 597/597、syntax 142、frontend 43/43 和 production build 通过完成；当前 B2 完成状态以上方新节为准。
- 金额统一为 safe INTEGER minor units；规则目标金额、账号单笔上限、provider min/max/step、余额、币种和 amount scale 分开建模并在分配/预留时核验。
- 持久 Signal 以 `signalId + ruleId` 幂等创建确定性 batch。child order 是账本真相，batch 的 reserved/accepted/unknown/unfilled 聚合可事务重算。
- 多账号之间并发，同一账号由持久 lock 串行；`rejected` 释放自身锁但金额终止且不转投，`unknown` 保留金额和锁、进入 `waiting_result`，不自动重投。
- 批次严格锁定 event、period、market、lineKey/handicap 和反向 side；赔率变化继续，盘口线、赛事阶段、side 或 suspended 变化停止尚未发送部分。
- B1 Provider 仅为注入式 `SimulatedBetProvider`。worker 默认 `off`，`preview` 与 `simulated` 都要求显式非空脚本；两者均不导入 Crown adapter、不调用网络、不发送 `FT_bet`。
- Executor 使用 `betting-executor:<canonical-db>` fenced lease，恢复覆盖预留后、prepare 后、发送开始后和 provider result 后四个崩溃窗口；无法证明未发送的 attempt 一律 unknown。
- watcher 仍保持只读并使用独立 `watcher:<canonical-db>:<canonical-runtime>` lease。B2 安全门禁和真实 Provider 尚未完成，任何真实小额 `FT_bet` 仍需用户在验收当次新授权。


## 目标

独立承载皇冠投注协议抓取、脱敏、分类和后续字段映射工作。该模块不属于 watcher，不能由赔率监控告警自动触发真实下注。

## 历史抓包与已删除旧 adapter（独立链路）

2026-07-09 曾使用 bootstrap、单账号 dry-run、旧顺序执行和 `CrownBetAdapter` 做协议实验。这些入口及其专属通用契约/测试已于 2026-07-13 删除；以下只保留仍在使用的抓包、脱敏、mapper 和 parser 边界。

- 已新增抓包脱敏工具：`src/crown/betting-protocol/capture-redaction.mjs`。
- 已新增协议抓包存储：`src/crown/betting-protocol/protocol-store.mjs`。
- 已新增请求分类器：`src/crown/betting-protocol/protocol-classifier.mjs`。
- 已新增可见浏览器抓包入口：`scripts/crown-betting-protocol-capture.mjs`。
- 已新增脱敏抓包分析入口：`scripts/crown-betting-protocol-analyze.mjs`。
- 协议字段地图入口：`docs/crown-betting-protocol-map.md`。
- 非真实提交抓包现在会在网络层拦截 submit 请求；`FT_bet` 会被分类为 submit，`allowRealSubmit=false` 时会被 abort 并写入 `request-blocked` 记录。
- Dashboard repository 已新增 `createBettingHistory()`，用于写入 dry-run 或后续执行摘要，不保存原始 ticket、uid、cookie、token。
- 当前 schema-v2 候选链路由持久 Signal 驱动，默认写 `data/runtime/betting-candidates-v2.jsonl`；`src/crown/betting/monitor-bet-signal.mjs` 负责方向和赔率门禁。`evaluateMonitorChange()`→`betting-candidates.jsonl` 只属于显式 schema-v1 legacy/history。
- 已知旧 dry-run 占位规则/账号名会被 SQLite 打开流程精确迁移成中文，不影响用户自定义名称。

## 边界

- `monitor` 模式只读：写赔率快照、变化和提醒，不提交订单。
- `protocol-capture` 模式可复用本机登录态，允许人工打开注单、点击盘口、填写金额，并记录网络请求；真实提交必须显式开启。
- `execution` 模式必须经过 canonical Provider、capability、ExecutionAuthorization、订单账本、lease/fence 和审计边界。
- 不绕过 CAPTCHA、滑块、设备校验、签名、限速或账号保护。
- `private/` 抓包目录可能包含本机认证材料，只能保存在 ignored runtime 路径。
- 只靠人工提示不够安全；非提交抓包必须启用网络层提交拦截。
- worker 的 `off|preview|simulated` 只用于离线调试；real worker 只能由 Dashboard 父进程通过私有 ready-ticket/GO IPC 启动。canonical Crown preview/submit/reconciliation 仅 exact 赛前全场让球 main 行为 `1/1/0`，其他行仍为 0；运行仍需当次授权、fresh identity/Preview 和所有 preflight 通过。
- 已删除的旧 adapter CLI 不得从历史计划恢复或用来绕过 B2 闸门。

## 运行命令

独立 worker 调试（默认 off；以下 simulated/preview 必须提供确定脚本，不能独立进入 real）：

```powershell
npm run crown:betting:worker -- --once
npm run crown:betting:worker -- --mode preview --once --db-path <temporary.sqlite> --simulated-script-json '<non-empty-json-array>'
npm run crown:betting:worker -- --mode simulated --once --db-path <temporary.sqlite> --simulated-script-json '<non-empty-json-array>'
```

不带 `--mode` 时不会打开数据库、取得 lease 或做投注工作。B1 测试只使用临时 SQLite 和模拟 Provider。

以下命令只属于抓包与脱敏分析，不属于 B1/B2 多账号 worker：

非提交抓包：

```powershell
npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile
```

分析脱敏抓包：

```powershell
npm run crown:betting:analyze -- data\runtime\betting-protocol-captures\<run>
```

真实提交抓包必须显式确认：

```powershell
npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile --allow-real-submit --max-stake 50 --confirm REAL_BET
```

旧 bootstrap、单笔/顺序执行和 candidate dry-run 命令已删除；当前只通过 Dashboard 管理 canonical worker。

已抓取证据：

- `data/runtime/betting-protocol-captures/20260709-110033/public/`
- 该 run 包含一次真实提交，但不是按 `--allow-real-submit` 控制流程触发；只能作为协议证据，不能作为受控执行验收。

## 验证方式

B1 核心：

```powershell
node --test tests\crown-betting-b1-integration.test.mjs tests\crown-bet-batch-store.test.mjs tests\crown-multi-account-bet-coordinator.test.mjs tests\crown-betting-worker.test.mjs
```

协议抓包、canonical Provider 与 capability：

```powershell
node --check scripts\crown-betting-protocol-capture.mjs
node --check scripts\crown-betting-protocol-analyze.mjs
node --test tests\crown-betting-protocol-redaction.test.mjs tests\crown-betting-protocol-classifier.test.mjs
node --test tests\crown-account-provider.test.mjs tests\crown-capability-matrix.test.mjs tests\crown-order-field-mapper.test.mjs tests\crown-bet-response-parser.test.mjs tests\crown-betting-worker.test.mjs
npm test
npm run check
```

## 协议扩展条件

新增市场、扩大真实提交范围或改变 canonical Provider 前，必须在 `docs/crown-betting-protocol-map.md` 确认以下字段，并同步更新 mapper/parser、exact capability evidence、worker 安全门禁与对账契约：

- preview endpoint
- submit endpoint
- session/auth 依赖
- event id 字段
- market/period 字段
- selection side 字段
- handicap/line 字段
- odds 字段
- stake 字段
- accepted/rejected/pending/odds changed/insufficient balance 响应语义

## 2026-07-09 Non-Submit Blocker Verification

- Verified capture: `data/runtime/betting-protocol-captures/20260709-111046/public/`.
- Flow: detail-page football live asian handicap; user clicked odds, entered stake, and clicked submit while `allowRealSubmit=false`.
- Result: `FT_bet` submit attempts were recorded as `request-blocked` with `blockReason=real-submit-disabled`; no submit response and no `get_dangerous` status polling were captured for this run.
- Browser symptom after the blocked submit: network/transaction-status warning. This is expected when the local blocker aborts the provider request.
- Public redaction now masks ticket/order ids inside object fields and XML/text response bodies.
- User observed two market page layouts: event list / broad market page and event detail / split market page. Capture and compare them separately before building `CrownBetAdapter`.
- Event-list capture `data/runtime/betting-protocol-captures/20260709-112647/public/` verified the broad market page uses the same `FT_order_view` preview and `FT_bet` submit key set as the detail page for the captured sample.
- Captured event-list market variant: live total first half with `wtype=ROU`, `rtype=ROUC`, `chose_team=C`, and `f=1R`; submit remained blocked in non-submit mode and produced no submit response/status polling.

## 2026-07-09 CrownBetAdapter Plan

- Development plan entry: `docs/superpowers/plans/2026-07-09-crown-bet-adapter-execution.md`.
- Recommended next milestone: API-first dry-run preview, risk guard, redacted audit, and dashboard history summary before any controlled real submit.
- Real submit remains gated by explicit CLI flags, confirmation text, max stake, user presence, and audit logging.

## 2026-07-09 CrownBetAdapter Dry-Run Milestone

- 已完成计划 Task 1-7：响应解析、`BetIntent` 校验、已捕获盘口字段映射、`RiskGuard`、脱敏审计日志、投注历史写入、`CrownBetAdapter` dry-run preview。
- dry-run 只验证 `FT_order_view` 预览请求；live dry-run 已完成一次验收，真实提交和轮询已用 fake provider 响应验证，真实 Crown 环境提交仍未验收。
- 支持的映射范围仍限于已抓包样本：滚球全场让球 `wtype=RE` 与滚球上半场大小球 `wtype=ROU/f=1R`。
- 2026-07-09 验证：新增投注执行测试 13 项通过，repository 测试 6 项通过，`npm test` 152 项通过，`npm run check` 90 个 `.mjs` 通过。

## 2026-07-09 Dry-Run CLI and Audit/History

- `CrownBetAdapter` 构造函数现在支持 `audit` 和 `history` 回调；每次 dry-run 结果会写入脱敏审计行和 `betting_history` 摘要。
- `scripts/crown-bet-execute.mjs` 导出 `parseArgs()`、`assertExecutionSafety()`、`assertCliReady()` 和 `executeFromArgs()`，便于测试和后续 CLI 扩展。
- **Superseded historical contract：** CLI 默认 dry-run；旧 real 参数现统一返回 `legacy-real-entry-disabled`。真实意图只能从 Dashboard 全局开关进入，且仍受 exact capability/authorization/preflight 阻断。
- 2026-07-09 验证：`node --test tests\crown-bet-adapter.test.mjs tests\crown-bet-execute-cli.test.mjs` 6 项通过；`node --check scripts\crown-bet-execute.mjs` 通过。

## 2026-07-09 Portable Betting Reproduction and Simulated Submit

- 新增 `scripts/crown-bet-bootstrap.mjs` / `npm run crown:betting:bootstrap`，用于干净电脑初始化 preview-only 投注账号、规则和 dry-run intent。
- bootstrap 不复制本机 `storage/crown.sqlite`、`storage/crown-local-secret.key`、`data/runtime/crown-sessions/` 或 Telegram 配置；每台机器必须自己生成本地 DB、密钥、session 和 runtime 快照。
- bootstrap 自动选择范围只包含已验证的 XML runtime 盘口：live `RE` 全场让球和 live `ROU/f=1R` 上半场大小球。显式赛前 `RATIO_R` / `IOR_R*` 会被 mapper 拒绝。
- `CrownBetAdapter` 已在 fake provider 响应下验证 `FT_order_view -> FT_bet -> get_dangerous`，结果和 audit/history 都不输出原始 uid、cookie、token、password 或 ticket id。
- 真实 Crown 环境提交仍未做受控验收；未来只有同一 exact capability row 同时具备 preview+submit+reconciliation 证据并获得用户当次授权后，才可通过 Dashboard 全局开关进入受控验收，旧 CLI flags 不可用。
- 2026-07-09 验证：投注相关目标测试 16 项通过，`npm test` 162 项通过，`npm run check` 94 个 `.mjs` 通过。

## 2026-07-09 Live Dry-Run Verification

- 使用 `data/runtime/betting-intents/manual-dry-run.json` 和 `bet_manual` / `brule_manual` 跑通真实 Crown session dry-run。
- 实际请求序列经 fetch 包装器确认只有 `FT_order_view`，没有 `FT_bet`。
- 正式命令 `npm run crown:betting:execute -- --intent-file data\runtime\betting-intents\manual-dry-run.json --account-id bet_manual --rule-id brule_manual --stake 50` 返回 `previewed`。
- 验收样本为 live football asian handicap：`gid=8878931`、`wtype=RE`、`chose_team=H`、spread `0`。
- 预览响应：`code=501`、`gold_gmin=50`、`gold_gmax=30000`、`ioratio=0.83`、`strong=H`。
- 审计文件 `data/runtime/betting-execution-audit.jsonl` 最近行扫描未命中 uid/cookie/token/password/ticket 明文字段；SQLite `betting_history` 已写入摘要。
- 注意：一次赛前 `RATIO_R` 样本返回 `code=555` 且没有限额字段；当前 mapper 仍只视为已支持已抓包的 live `RE` 和 `ROU` 变体。
# 历史：C4 readiness gate（2026-07-12；当前 capability 以上方 Task 10 为准）

- Canonical capability matrix：`crown-protocol-capabilities-v2:23628f891d1edb9a`。
- 当时 Exact coverage：preview `0`、submit `0`、reconciliation `0`；当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。
- 动态 `ver` 的精确来源及 preview/submit/reconciliation 三段证据仍不完整；任何字段指纹、mode、period、marketType、lineVariant 不精确时均 fail-closed。
- `rejected` 不进入 allocator；`unknown` 保留 authorization budget、child ledger 与账号锁，重启后只允许对账，不允许重投。
- 当时 live readiness：`blocked`。当时没有任何 capability row 同时具备 verified preview+submit+reconciliation，因此不得启用真实 Crown 网络提交。

## 历史：2026-07-13 Task 6 canonical evidence preparation

- 动态 `protocolVersion` 只接受当次成功 production login response 的 `<ver>`；strict betting session 文件不持久化、也不恢复该 provenance。Preview 要求 fresh verified-version refresh，伪造缓存文件不能自证。
- `FT_order_view` request 与 response 使用原始 Playwright Request 的 sequence 关联；公开 linkage tag 使用私有 32-byte 以上 key 对已授权 event/line/side/stake context 做 HMAC-SHA256，原值和 key 均不进入证据。
- request/response exact field set 对 extra、任意重复 XML tag、未知敏感字段 fail-closed；只允许把 transport `uid` 从公开 field set 中排除。raw body、ticket、origin、绝对路径和任意敏感值写出前会被拒绝。
- 当时离线 focused `86/86`、相关 parser/mapper/evidence `96/96`、backend `1092/1092`、security `5/5`、syntax `217` 通过；最终独立复审 Critical/Important/Minor `0/0/0`。该历史阶段的 canonical matrix 为 preview/submit/reconciliation `0/0/0`，Task 7 未获当次授权前不得访问真实 Preview；当前 capability 以上方 Task 10 的 exact row `1/1/0` 为准。
