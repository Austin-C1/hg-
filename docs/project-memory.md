# 项目记忆

## 2026-07-15 正常足球全场盘口过滤

- 用户确认只保留正常球队比赛的全场让球和全场大小球。Crown XML/DOM 标准化入口现在排除角球、罚牌、特定球员、加时赛、点球、球队/球员进球、波胆和晋级等衍生赛事，并停止生成半场盘口。
- 根因是旧 `EXCLUDED_FOOTBALL_RE` 只过滤电竞/虚拟赛事，皇冠把“英格兰 -罚牌数”等衍生盘作为独立 game 返回后被误当成普通足球 event。
- 修复后 Watcher 已重启且租约唯一、赔率 fresh；重启后 SQLite 新增/更新的 836 条 selection 全为 `full_time`，半场 0、衍生赛事 0，active 衍生 event 0，`PRAGMA integrity_check=ok`。真实投注仍 off，campaign/batch/unknown/reconciliation 均为 0。

## 2026-07-15 投注账号静态网站白名单移除

- 账号保存的 public HTTPS exact origin 现在是登录、只读检测、game-more、Preview 与 Submit 的唯一授权地址，不再依赖静态 membership whitelist 或环境变量成员列表。
- URL 安全边界未放宽：拒绝 HTTP、credentials、path/query/hash、localhost、private hostname 和 IP literal；请求采用 manual redirect，跨 origin redirect 在使用响应或 cookie 前 fail-closed。
- fence、capability、authorization、账号 owner 与 execution identity 门禁保持不变；移除静态成员列表不会扩大协议或真实投注能力。

## 2026-07-15 Dashboard 用户配置路径统一

- 非 Portable Dashboard 现在先解析 `CROWN_DATA_ROOT`，未单独设置路径时，Telegram 等配置、SQLite、local secret、runtime 与日志都从该 data root 派生；`frontend/dist` 和源码仍从 `CROWN_APP_DIR` 读取。
- 程序换目录时继续读取原 data root 中的 `config/telegram-settings.json`，不复制、不迁移、不改写 token；显式 `CROWN_CONFIG_DIR`、`CROWN_DB_PATH` 等单项覆盖仍优先。
- Portable 的 canonical path graph 未修改，账号、投注账本、delivery 与 Telegram 配置仍只保存在用户 data root。

## 2026-07-15 Task 6 Browser Preview/Submit/B2/Reconciliation

- 生产 Preview、单次 Submit 与只读 Reconciliation 已统一使用同一账号的 BrowserRuntime/page `fetch`；生产投注路径不再使用 Node `postForm`，也不持久化 Cookie、UID 或 session。
- Submit 前重新取得 fresh session、余额与 Preview；没有可验证 stake step 时只允许当次 `gold_gmin` 的 exact minimum。CNY 使用 `amountScale=0`，截图所示盘口会使用当次返回的 50，而不是固定常量。
- B2 在 browser dispatch 前只执行一次 durable `beforeDispatch`；dispatch 前失败不创建 attempt，dispatch 后不能明确 accepted/rejected 的结果统一记为 `unknown`，不自动重投。
- prepared/dispatched crash work 会先 recovery-only，再由独立 fenced reconciliation process 接管；worker crash、强制退出、ownership TTL、并发 start/stop 与 Dashboard final shutdown 均有 generation/singleflight 边界。
- Browser shutdown 固定 20 秒、父进程停止宽限 25 秒；所有内部与 OS stop source 都会立即关闭 active context 以中断在途页面请求。最终应用退出会禁止重新启动 standalone reconciler。
- 最终离线验证：全项目 `1644/1644`；最终变更对应 `37/37`、`22/22`、`19/19`；两次独立复审 Critical/Important/Minor 均为 `0/0/0`。未访问 Crown，未执行 Preview、Submit 或下注，未提交 Git。
- 用户要求 Task 6 完成后暂停，Task 7 尚未开始。

## 2026-07-15 Task 5 浏览器账号会话与 transport

- 每个投注账号使用独立 persistent Chromium context、独立 profile lease 和进程内 session generation；Cookie、UID、`storageState` 与 Profile 路径不写入投注 DTO 或磁盘 session 文件。
- Crown API client 只在当前 exact HTTPS origin 的页面上下文调用固定 login、game list、余额、Preview 与 Submit operation；禁用下载和 Service Worker，redirect、popup、跨 origin navigation、crash 与未确认 context close 均 fail-closed。
- Submit 的 `beforeDispatch` 前后同时校验 executor fence、profile fence 与 context generation；context 未确认关闭时保留 lease，并阻止 replacement context、Betting Worker 与 runtime cleanup。
- 人工登录和 Betting Worker 共享 profile ownership 门禁；cleanup 在停止进程后重新检查 watcher/worker/profile lease，并在数据库事务内完成最后检查和清理。
- Task 5 生产 Browser kernel 已完成，但现有 Preview/Submit Provider 的正式切换属于 Task 6；Task 6 完成前不能宣称 production transport 已改为 browser-page-fetch。
- 相关回归 `201/201`、Windows launcher `18/18`、独立复审 Critical/Important/Minor `0/0/0`。验证均离线，未访问 Crown、未执行 Preview、Submit 或下注。

## 2026-07-15 Task 3 程序内八方向协议库

- 当前权威 capability 为 Preview/Submit/Reconciliation `8/1/0`。八个方向均可 strict Preview；唯一 Submit-enabled 行是 `prematch/full_time/asian_handicap/main/away`；所有 Reconciliation 仍关闭。
- capability key 已升级为 `mode|period|marketType|lineVariant|selectionSide`，运行查找使用进程启动时构建的深冻结 Map。fixture 只用于显式审计，不参与生产查找。
- 当前 matrix version 为 `crown-protocol-capabilities-v2:c9139fcb53c51012`，稳定协议 digest 为 `sha256:94ef6d685b2efe80b831b9e98969e50bcfd8f3504b524d31123c7b78c592b6a5`。Task 2 的 capture-specific candidate digest 不进入 matrix version。
- B2 新 attempt 必须保存独立 runtime `executionCandidateDigest`，绑定账号、executor fence context、capability、locked/current identity、完整 fresh Preview 与金额；该摘要不能替代协议 digest。
- strict parser 对所有 observed XML tag 校验开闭和嵌套；敏感字段不输出，但 malformed `username`、`mid`、`score` 等同样 fail-closed。
- 本阶段开发、复审和测试均离线完成，没有访问 Crown、没有 Preview、Submit 或下注。

## 2026-07-15 Task 4 八方向监控候选

- XML normalizer 复用 Task 3 的 exact mapper evidence，将八个 full-time 方向标为 `lineVariant=main`，并在 event 中保存 mode；cross-mode、first-half、alternate 均保持 `unknown`。
- 标准执行候选固定为十字段：`gid/mode/period/marketType/lineVariant/selectionSide/handicapRaw/oddsField/oddsRaw/observedAt`。
- 反向 selection 锁定会核对 mode、side、同一盘口和新鲜时间；盘口 raw 与 numeric 必须各自一致，`-0.5` 与 `-0.50` 仍视为等价。
- Watcher、Strategy、Signal、Telegram 与 monitor state schema 未重构；本阶段验证离线完成，未访问 Crown 或发送投注请求。

## 2026-07-14 浏览器内 API 投注重构计划已确认

- 浏览器内 API 是新的唯一正式下注方向：单个 canonical betting worker 按投注账号维护独立 persistent Chromium context，Preview、Submit 和结果查询在页面上下文调用真实接口；现有 Node 直接 HTTP 只继续服务监控或只读检测，不再承担生产下注。
- 稳定协议保存在程序内现有 capability matrix 和脱敏 fixtures，按赛前/滚球 × 全场让球/大小球 × home/away/over/under 八个方向分别留证；gid、盘口、赔率、限额、余额、Cookie、动态 ver 和 Token 每次现场刷新，不能从静态库复用旧值。
- 监控主链、Signal、规则卡、Telegram、SQLite 账本、账号锁、B2 exactly-once 和 unknown 不重投继续保留；监控只补四类目标盘口的 canonical candidate 字段，不做整体重构。
- 最终能力验收固定为八个方向各一笔当次平台最小金额 direct accepted，并取得 exact result-query evidence；不再使用旧 5-batch/500-CNY 累计 Gate。完成后执行全程序、前端、Portable 和敏感信息检测，并替换现有 GitHub 仓库的旧版本。
- 当前权威实施计划：docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md。计划完成前当前实际 production capability 和传输方式仍以代码与下方最新已验证状态为准。

## 2026-07-15 Task 2 八方向零 Submit 协议证据完成

- 同一 scenario root 内完成赛前/滚球 × 全场让球/大小球 × 两侧共 8 个独立 capture；每个方向恰好一次成功 Preview 和一次被本地拦截的 `FT_bet`，实际 Submit dispatch 为 0。
- analyzer 从 8 组 private raw/redacted 一一配对重算出 8 个 candidate、8 个 direction template；三份 public safe artifact 与项目 fixture 逐字节一致，未包含凭据、session、原始 body 或绝对路径。
- capture context 初始 offline，安装 HTTP/WebSocket blocker 并确认仅有 `about:blank` 后才联网；快照删除 Sessions 与 Service Worker。multipart 和 loose JSON fragment 只接受可完整检查的结构，异常结构统一 fail-closed。
- Task 2 聚焦测试 `211/211`、syntax `235`、最终独立复审 Critical/Important/Minor `0/0/0`。本次重放与修复均离线，未再次访问 Crown、未发送 Submit、未执行 Git 提交。

## 2026-07-14 真实投注 runtime 两阶段启动

- `POST /real-betting/start` 先 arm 并停止旧 worker；规则卡、可用账号、exact capability 与 schema 四项静态前置条件通过后即可 spawn worker，不再要求尚不存在的 readyTicket/fence。
- worker 必须返回 readyTicket；随后重新采集完整 preflight，严格验证 worker/executor lease、owner、fencing token 与 heartbeat。只有完整检查通过才提交 `running` 并发送 GO。
- 缺 readyTicket、worker 启动异常、post-ready fence/executor 检查失败或 GO 失败都会停止 worker，并保持 `armed_waiting`/`blocked`；Submit gate、单次请求和执行 fence 没有放宽。
- TDD RED 为两阶段启动 `0/2`、缺 readyTicket `0/1`；修复后启动相关聚焦 `4/4`、runtime/API/process/operations 回归 `71/71`、syntax `232/232` 通过。验证未访问真实网络、Submit 或正式数据库。

## 历史：2026-07-14 Task 10 accepted-only 自动 Submit（已被顶部 Task 3 取代）

- canonical capability 仅开放 `prematch/full_time/asian_handicap/main`：Preview/Submit/Reconciliation 为 `1/1/0`。该行由同一 capture 的 watcher 证据独立绑定 `RATIO_R + gid/side/line/odds`，analyzer 不读取 asserted capability；证据缺失或任一字段漂移时保持关闭。滚球 `RATIO_RE` 等其他行保持关闭。
- Preview 固定为 `FT_order_view`、`FT/R/H|C`；Submit 固定为 `FT_bet`、`FT/R/RH|RC/H|C/isRB=N/f=1R`。这里 `f=1R` 是该已验证请求的 opaque wire 值，不代表上半场。
- outcome 采用 accepted-only：只有 direct `code=560`、唯一结果标识、精确 `gid/gtype/wtype/rtype` 和金额/赔率回显一致才记为 `accepted`；其他 dispatch 后结果全部记为 `unknown`，不自动重试、转投或轮询对账。
- Preview 返回的 `gold_gmin/gold_gmax` 是服务端事实；50 CNY 倍数是 `local-conservative-policy`。当前生产 Submit provider 每个 child 只允许 50 CNY，仍受 fresh Preview、规则赔率区间、账户余额和 `perBetLimit` 约束；目标 100 CNY 可由两个各允许 50 CNY 的账号顺序形成 `[50,50]`。
- production Preview/Submit 共用 repository、login manager、executor lease、Preview provider 和 logger。`protocolVersion` provenance 不写入 session 文件；Submit 先从 latest same-event Crown response 独立重读未 suspended selection 的 8 个 identity 字段和赔率，再立即 fresh `FT_order_view` 核对 line/odds/min/max/balance 与 prepared amount；通过后最多发送一次 `FT_bet`。调用方自报的 current identity 不参与判定。
- schema-v3 candidate digest 为 `sha256:a6ffb715ba6b6af393ec45992adc95d9e2c4a2d173cde124114790ca3bb53bb0`，watcher evidence digest 为 `sha256:25f70de00c9d9cfbc57aa28edc14ab7d1e67953e20e59f3f3697eb12f212ac68`；matrix version 为 `crown-protocol-capabilities-v2:827f728d4638bb8d`。
- 本次实现与验证全程离线：未访问 Crown/network、未启动 worker、未发送 Submit、未执行 Git。线上验收必须等待新的 exact 赛前 `RATIO_R` main 行并重新做 fresh preflight；现有滚球或 `RATIO_RE` 行不能借此扩大 capability。

## 2026-07-14 controlled stake probe（已取消，未使用）

- 用户明确取消 49 CNY rejected probe 与 51 CNY adjacent-step probe；Task 9B capture-only 代码和合成测试已完整撤销，不会执行该路径。brief 只保留为历史，不代表当前产品能力或待执行计划。
- 当前金额口径：已明确最小金额为 50 CNY；生产金额策略保守采用 50 的正整数倍，并继续受账户 `perBetLimit`、fresh Preview 直接上下限与现有单次 Submit 安全约束限制。该口径不提升 capability。
- 后续 outcome 只接受直接证据明确证明的 `accepted`；任何非明确 accepted、缺结果标识、响应矛盾、超时、断线或未分类结果一律记为 `unknown`，不按 rejected 自动转投或重试。
- 普通 capture 已恢复 Task 9A 后状态：无 probe arguments、`request-intent`、body rewrite 或 probe session gate；仍保留 visible browser、`serviceWorkers: 'block'`、显式 `--allow-real-submit --confirm REAL_BET`、`maxStake <= 50` 和每个 BrowserContext 最多一次 exact `FT_bet`。
- Task 9B 从未访问 Crown/network、从未发送 Submit、从未启用 capability 或接入 Provider，也没有执行 Git 操作。

## 2026-07-14 exact execution evidence candidate（历史 schema-v1，已被上方 Task 10 schema-v3 取代）

- 已在离线 capture/analyzer 边界实现 exact Preview/Submit 证据候选构建；private/raw 只在内存中参与校验，public candidate 只保留摘要、HMAC 绑定、字段集合指纹和稳定原因码。
- 该历史 capture 的生成结果：candidate digest `sha256:93a640b1d3d7660553cd053e73cd73b4de2a14266e0321d0a298f1370e1afe1`；candidate raw-capture digest `sha256:6bc473a26020015ae3376168005197465d559079f6f2f3f1fa3841b51059827a` 是对 `private/raw-network.jsonl` 原始字节直接计算的 SHA-256。候选包含 4 条有序 evidence record、6 个排除字段、8 个 HMAC binding。
- independent review 后补齐 direct Submit response identity：response `gid/gtype/wtype/rtype` 必须与 Submit request 逐一 canonical exact 相等，缺失或不等统一 fail-closed 为 `submit-response-identity-drift`。
- 该历史 schema-v1 candidate 保留生成时的 incomplete reasons：`rejected-attempt-required`、`integer-cny-step-unproven`、`exact-capability-unproven`。用户现已取消 rejected/step probe，这些原因不再表示待执行计划；它生成时的 canonical Preview/Submit/Reconciliation capability 为 `0/0/0`，现已被顶部 Task 3 的 `8/1/0` 取代。
- 验证：相关测试 `82/82` 通过，analyzer/capture 两个入口 syntax check 通过；本任务没有访问 Crown/network、没有发送 Submit、没有执行 Git 操作。

## 2026-07-14 受控真实 Submit 验证（历史采集结论；当前 capability 以上方 Task 3 为准）

- 用户在提交当刻确认后，使用当前皇冠虚拟余额账号手工完成 1 笔受控投注：加拿大锦标赛“骑兵 vs 温哥华白帽”，温哥华白帽 `-0.5/1 @ 0.96`，金额 `50 CNY`。页面显示“已确认 / 您已成功投注”，投注记录由 0 变 1，展示余额由 1000 变 950。
- 抓包 `20260714-085221` 只放行 1 次 exact `FT_bet`。脱敏证据记录 Submit request `seq=838`、`golds=50`、未被阻断；直接响应 HTTP 200、`code=560`、`gold=50`、`ioratio=0.96`、`nowcredit=950`，并包含已脱敏的持久注单标识字段。历史 public artifact 的 `captureId` 为 `sha256:75ec1ecb80c832ebd65f29196fac8f3409bc1a4ee9c99d747d2943968eb47f32`；它是对 JSON 序列化后的 capture 目录 basename 计算的 SHA-256，不是 raw capture 内容摘要，也不等同于上方 candidate raw-capture digest。
- 该历史 public artifact 当时尚未携带安全 binding；后续 exact evidence candidate 补齐了 account/session/execution/result HMAC bindings，但当时仍未证明 exact capability/`lineVariant`、服务端 integer CNY stake step，也没有明确“未创建注单”的 rejected 直接响应。因此该历史阶段的 canonical Preview/Submit/Reconciliation capability 为 `0/0/0`；当前 capability 以上方 Task 3 的 `8/1/0` 为准。
- 抓包器已改为 BrowserContext 级记录与拦截，覆盖列表页和比赛详情页；真实模式只允许一笔 exact `FT_bet`、正整数金额且不超过当次 `--max-stake`，第二笔和非 exact Submit 均在网络层阻断。聚焦测试 18/18、独立安全复核无 finding。

## 2026-07-14 账号现场可执行性

- 账号历史登录/余额检查时间只作展示，不参与全局真实投注启动；每个 child 执行当刻必须登录或复用有效 session、读取皇冠账号信息并完成 strict `FT_order_view` Preview。
- 持久化的旧 `betting-account-login-not-fresh`、`betting-account-balance-not-fresh` 会按当前 preflight 重算，不能继续阻断或停留在运行状态。
- exact Preview/Submit capability、`perBetLimit`、精确盘口/赔率/金额和每 child 单次 Submit 约束不变。

## 历史：2026-07-13 自动投注实现与真实提交边界（已被 Task 10 取代）

- 最终本机验证：backend `1286/1286`、frontend `137/137`、syntax check 与 production build 通过；含锁定 Node 22.23.1/Chromium 149 的临时 Portable 共 2688 files，release audit 为 0 forbidden hits。正式 clean-checkout ZIP 与 Fresh Windows 10/11 仍待发布验收。
- 自动投注账号按 `bet_order` 顺序分配。账号的 `perBetLimit` 投注上限保留且可由用户手工修改；`50 CNY` 仅为测试配置，不是固定上限、统一默认值或自动填充值。
- 同一 batch 内每个账号最多使用一次。明确 `rejected` 后解除锁并把剩余金额交给下一个未使用账号；`unknown` 保留金额和账号锁，不自动重试。
- Submit 网络请求开始后，一个 child 最多发送一次；所有无法明确证明未发送或未创建注单的异常与恢复结果统一为 `unknown`。
- 执行前必须取得 fresh Preview，且 Preview 赔率仍在规则卡冻结快照的区间内；盘口执行身份使用真实 `handicapRaw`，不能用 `lineKey` 代替。
- 该历史阶段的生产 Preview/Submit capability 为 `0/0`。随后在 2026-07-14 完成一笔受控 accepted `FT_bet`，并生成带 account/session/execution/result HMAC bindings 的 exact evidence candidate；本段只记录当时的 fail-closed 边界。
- 本节仅保留历史口径，不再是当前权威；当前 capability 统一以顶部 Task 3 的 side-aware `8/1/0` 为准。

## 2026-07-13 投注规则今日联赛口径修复

- “今日比赛”统一解释为皇冠当前仍在开盘并存在于 `monitor_event_state.active=1` 的赛事集合，不再按北京时间自然日或未来 24 小时过滤。
- 投注规则联赛目录继续只接受启用默认白名单命中或 active 手动追踪的 exact event；inactive 赛事、停用白名单和 mode 不匹配仍排除。
- 根因是 Crown `UTC-04:00` 的 7 月 13 日赛事换算成北京时间已到 7 月 14 日，旧 Asia/Shanghai 日期边界导致比赛页可见但规则目录为空。修复后正式 API 返回瑞典超级联赛、冰岛超级联赛、巴西乙组联赛共 3 个联赛/4 场，浏览器弹窗可见且 console 0。

## 2026-07-13 Windows 手工 Portable 与桌面快捷启动

- Windows 10/11 x64 继续采用完整 Portable ZIP：内置受 runtime lock 约束的 Node.js 与 Chromium，双击 `启动程序.cmd` 并保留可见窗口；不设开机启动，不创建 Startup 项或 Windows Service，不写注册表启动项，也不依赖系统 Chrome/Edge/Node/Docker。
- 远程 updater 运行链已完整删除。维护者使用 production allowlist、锁定 runtime、`release-files.json` 和发行物审计手工构建完整 ZIP；用户换版时解压到新目录并手工启动，不存在 Dashboard 检查/下载/安装、candidate、handoff 或自动回滚。
- 保留 `current.json` 与 `versions/<version>` 作为单个完整 Portable 包内的稳定 launcher 定位结构，不把它们作为在线更新接口。
- APP_ROOT 与用户 data root 分离；账号密文、SQLite、session、浏览器 Profile、日志、运行身份和业务备份位于 `%LOCALAPPDATA%\CrownMonitor`，不进入发行包。手工换版继续复用该目录，不覆盖用户数据。
- launcher 不依赖调用者 cwd，并以 installation id/PID/start time/nonce/probe 精确管理进程，禁止按进程名 kill。新启动或复用进程通过完整 health identity 后，幂等维护当前用户桌面的 `皇冠抓水投注.lnk`。
- 快捷方式 Target 固定为当前包根目录 `启动程序.cmd`，WorkingDirectory 为当前包根目录，Icon 为 `皇冠抓水投注.ico`；程序移动或换版后从新目录成功启动一次即可校正。创建失败只记录稳定脱敏错误码，不能阻止 Dashboard 启动。
- 启动只打开 loopback Dashboard；Watcher 必须由用户在 Dashboard 手工启动，程序重启和手工换版后都保持停止。当前 side-aware Preview/Submit/Reconciliation capability 为 `8/1/0`，只有赛前全场让球 away 行允许 Submit；Portable 与登录本身不得打开真实投注。
- 下载包包含 118 项默认联赛 seed，只在用户目标文件不存在时首次复制；重启和手工换版不得覆盖用户修改。
- 人工登录只启动包内 Chromium；账号网址复用 exact public HTTPS origin 校验，验证码、滑块和 OTP 只由用户本人处理。session bridge 不导出完整 storage state，只在 exact-origin session 通过只读 `get_game_list` 后原子保存；成功不自动启动 Watcher。
- 每个投注账号的 `perBetLimit` 由用户手工设置和修改，启用要求大于 0 的整数 CNY；fixture、测试或示例中的 `50 CNY` 只是测试配置，不是生产默认值、统一硬上限或自动填充值。
- 发布状态仍有硬门槛：必须先完成全量验证、实际发行物审计、仓库外 cwd smoke 和 Fresh Windows 10/11 x64 矩阵。没有 Fresh Windows 证据时只发布源码/开发分支，不能把 ZIP 标记为可用下载版。
- 用户入口：`docs/windows-private-beta-quick-start.md`；维护者入口：`docs/github-release-runbook.md`；模块入口：`docs/modules/windows-portable-release.md`；当前设计与实施计划分别位于 `docs/superpowers/specs/2026-07-13-crown-manual-portable-and-desktop-shortcut-design.md` 和 `docs/superpowers/plans/2026-07-13-crown-manual-portable-and-desktop-shortcut.md`。旧远程 updater 设计/计划已标记 Superseded，只作历史证据。
- 公开仓库清理已删除 2026-07-09 的 bootstrap、单笔执行、顺序执行、candidate dry-run、旧 `CrownBetAdapter`、只被这些入口使用的 `src/betting` 通用契约及其专属测试。canonical Dashboard worker、Provider、mapper/parser、迁移兼容与 capability/authorization/lease 门禁保留；历史文档只作时间线证据，不是可运行入口。

## 2026-07-12 动态卡片正式迁移与 8787 重启

- 用户明确授权后，已对 `storage/crown.sqlite` 创建 SQLite 在线一致预备份和停写后的最终一致备份；最终回滚源为 `storage/backups/crown-dynamic-cards-final-20260712-234229.sqlite`，SHA-256 `055C3557589D97488005F087632849247D513D7D273DCEBDA6B70110BA5DCF41`，integrity `ok`、FK `0`。
- 当前代码已对正式库执行幂等 migration；app/schema contract 均为 `dynamic-betting-cards-v1`。新 Dashboard 正监听 `127.0.0.1:8787`，watcher 已恢复且 lease active/unique。
- 该次历史迁移完成时，真实投注为 `requested=0/runtime_state=off`、betting worker 为 0，canonical capability 当时为 `0/0/0`；当前 capability 以顶部 Task 3 的 `8/1/0` 为准。
- loopback browser smoke 已完成动态卡片创建/删除/联赛释放，console 0 error/warning。验收临时卡已删除，当前卡片和联赛占用均为 0。
- 旧监控报警配置缺少明确盘口证据；滚球还缺少完整数值/阶段证据。因此赛前和滚球均保持 disabled、migration review required，必须由用户补全并保存，程序不猜值。
- 操作证据：`.superpowers/sdd/evidence/live-rollout-20260712.md`。

## 2026-07-12 动态投注规则卡片

- 当前权威设计为 `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md`，唯一当前页面入口为 `/betting-rules`。历史 C 统一规则与固定 prematch/live 投注设置已被取代，但原报告保留。
- monitor prematch/live 配置继续彼此独立并可同时启用；投注卡片不含 mode，执行 mode 只来自 Signal evidence。上涨可进入卡片执行，下降固定 `water-down-alert-only`。
- 卡片普通保存必须包含至少一个今日联赛；今日目录合并启用默认联赛命中与 exact 手动追踪事件。手动联赛只进入目录，必须显式选择。同一联赛由数据库 UNIQUE 保证只能属于一张现存卡片，停用仍占用，物理删除后释放。
- Signal、Telegram delivery、card inbox 与 cooldown 原子写入；inbox/batch 保存不可变 card snapshot。market-once、ExecutionAuthorization 和 B2 prepare/recovery 均绑定 card identity 与 Signal mode。
- 删除事务先终结未绑定 batch 的活跃 inbox，再物理删除卡片；已创建 batch/child 与历史快照保留。“每日开工完全重置”保留现存卡片/联赛配置，清理运行历史与 card snapshot，并保持真实投注 off。
- Operations 使用 `ruleCards:{total,enabled,reviewRequired,ownedLeagues}`。app/frontend/schema contract 统一为 `dynamic-betting-cards-v1`；该历史动态卡片阶段的 canonical Crown Preview/Submit/Reconciliation capability 当时为 `0/0/0`，当前值以顶部 Task 3 的 `8/1/0` 为准。
- 代码阶段最终验证为 backend 1066/1066、syntax 215、frontend 115/115、production build/Compose green；最终独立审查 Critical/Important/Minor 均为 0。该离线阶段当时未执行正式库迁移或 8787 重启；后续正式运行状态以上方“动态卡片正式迁移与 8787 重启”为准。

## 历史：2026-07-12 监控报警 / 固定投注配置分离（已被顶部动态卡片取代）

- 当时的正式设计是 `docs/superpowers/specs/2026-07-12-crown-alert-betting-separation-design.md`，实施计划是 `docs/superpowers/plans/2026-07-12-crown-alert-betting-separation.md`；两者现均为历史入口。
- 当时 `/monitor-alerts` 与 `/betting-rules` 分别保存赛前、滚球两套固定配置，两种模式可同时启用；这两张固定投注配置后来被顶部动态卡片契约取代。
- 当时监控字段已改为 `waterMoveThreshold` / `water_move_threshold`，含义是“动水阈值”；上涨和下降达到阈值都会生成 Signal 与赔率 TG 任务。这一 monitor 字段契约仍被后续动态卡片实现沿用。
- 当时自动投注只接受上涨 Signal，并按同赛事、同模式、同时段、同盘口类型、同盘口线锁定对面 selection；下降 inbox 会终结为 `skipped/water-down-alert-only`，不查询 selection、不领取 market、不创建 batch。
- 当时每个 Signal 会在同一事务创建独立 Telegram delivery 和不可变投注 inbox；投注配置、授权、账号、锁、队列及 accepted/rejected/unknown 复用 B2 安全账本。
- 当时旧 `water_rise_threshold` 数据库列会原子重建为 `water_move_threshold`，保留阈值、版本、迁移复核、备注和时间；迁移不猜测盘口，也不自动启用监控、投注或真实资格。
- 该历史阶段最终离线验收为 backend 984/984、syntax 200、frontend 89/89、production build、Compose config 与 1440/390 浏览器检查通过；当时真实 capability 为 0/0/0，未执行 Crown/TG 网络 I/O 或 Git 提交。

## 历史：2026-07-11 C 阶段统一自动投注设计

- 用户确认 C 阶段采用顺序实施：C1 统一监控投注规则，C2 真实 Crown 协议与自动执行，C3 投注账号启停，C4 运维控制台。正式设计入口：`docs/superpowers/specs/2026-07-11-crown-c-strategy-mobile-console-design.md`；实施计划入口：`docs/superpowers/plans/2026-07-11-crown-c-unified-auto-betting.md`。
- 该历史 C 阶段页面曾使用一条统一规则配置监控范围、动水阈值、反打后的实际投注水位和整数目标金额；现已由上方 2026-07-12 分离设计取代，后台仍复用 B2 安全账本。
- 反打后的实际 selection 只在生成投注预备时检查一次水位范围；每个账号提交前仍核对 event/mode/period/market/line/actual side，盘口线变化停止尚未提交部分。
- 同一 `event + mode + period + marketType + line + actualSide` 最多投注一次；新盘口线可以再投注。多规则重叠时优先级最高者取得执行资格。
- 账号按 betOrder 依次填满并允许 partial；rejected 不转投；unknown 不重投、冻结金额和账号锁。不设置每日限额，也不设置首次真实订单后自动停止。
- 账号 UI 删除金额精度和投注步进，只保留整数 CNY 单笔上限；provider preview 的 min/max/step 仍由执行器自动校验。账号增加暂停/启用按钮：暂停立即阻止新分配，但已排队任务继续完成。
- 全局真实投注意图持久化；重启进入 `armed_waiting`，只有 watcher/账号/余额/capability/authorization/lease 全部通过才恢复。该历史设计形成时 canonical Crown preview/submit capability 为 0；当前 capability 以上方 Task 3 的 side-aware `8/1/0` 为准。

## 2026-07-11 Dashboard 默认本机免密

- 用户确认发布给任何下载者后都应打开即用、无需 Dashboard 密码；默认访问范围仍仅为运行程序的当前电脑，不开放局域网或公网。
- 未配置 Dashboard 密码且未配置远程 Host/Origin 时，loopback bootstrap 获得进程随机 CSRF token，写请求仍要求同源 Origin 和正确 token；远程客户端、伪造 Host、跨站 Origin 和错误 token 继续拒绝。
- 如果显式配置 Dashboard 密码或远程 Host/Origin，免密捷径关闭，现有密码 Session/CSRF 机制优先。
- 手动“检测账号”和生产 preview/submit Provider 都只使用该账号已保存且通过验证的 public HTTPS exact origin；生产执行仍要求 capability 与全部运行门禁。
- 页面在免密模式显示“Dashboard 本机免密”。真实投注 worker 保持关闭，Crown 展示余额仍不写入执行余额。
- 旧账号可保存 `0` 单笔限额/投注步进并继续编辑其他资料；金额精度变化时无意义的尾随零会规范化。零限额或零步进账号仍由 execution account validator 拒绝，不能参与投注。
- 新建投注账号的金额精度默认 `0 位`，即整数金额；现有账号精度不自动迁移。
- 实机验收：Dashboard 返回 `local-trust` 和随机 CSRF；规则通过页面新增、刷新持久化并删除临时数据；赛前 Switch 可关闭再恢复运行；第一个投注账号登录与 `get_member_data` 余额/币种读取成功，第二个账号明确返回登录失败，需用户在编辑页更新凭据。
- 最终验证：backend 760/760、syntax 163、frontend 53/53、production build 通过。运行中仅有 schema-v2 watcher 和 Dashboard，betting worker 为 0；检查时实时事件 223、快照持续更新。

## 2026-07-11 Dashboard 写操作与投注账号检测修复

- 投注规则保存和监控开关失败的根因不是字段值，而是本机未配置 Dashboard 登录密码；后端按设计拒绝无 session/CSRF 的写请求。前端现会打开登录弹窗并显示明确中文提示，不再把 `authentication-required` 误报为规则字段错误，也不会重复发送监控开关请求。
- 新增投注账号“检测账号”只读动作：每次使用该账号做 fresh Crown 登录，验证 `get_game_list` 可访问，再读取 `get_member_data` 的账号摘要。检测过程不调用 `FT_order_view` 或 `FT_bet`，账号处于 busy/locked 时拒绝执行。
- Crown 返回的 `maxcredit` 单独保存为 `reported_balance`，页面标为“Crown 返回余额/额度（仅展示）”；B1 执行账本的 `balance_minor` 仍保持独立，未确认时显示“执行余额：未确认”，防止展示值绕过资金门禁。
- 登录检测只允许账号配置的 public HTTPS exact origin；不存在额外静态 membership whitelist。API 不返回密码、cookie、session、ticket 或原始响应。
- 当时自动验证为 backend 756/756、syntax 163、frontend 51/51、production build 通过；其后用户确认改为默认本机免密，当前状态以上一节和最新验证为准。真实投注保持关闭。

## 2026-07-11 Crown 中文字段乱码修复

- 根因是 Crown 个别联赛/球队字段已成为“UTF-8 字节被按 GB18030 解码后的文本”；响应整体仍是有效 UTF-8，不能整包强制转码。
- `src/crown/crown-text.mjs` 只修复可通过 GB18030→UTF-8 严格逆变换并完整回环的字段；正常中文、英文和不可逆文本保持原样。
- XML normalizer 在生成 event 前修复新数据；Dashboard events/changes projection 同时修复历史 JSONL，因此无需删除或改写运行数据。
- watcher 与 Dashboard 已重启，投注 worker 保持关闭。验证：后端全量 753/753、语法检查 163 个 `.mjs`、实时 `/api/events` 225 场且可逆乱码残留 0。

## 历史：2026-07-11 B 阶段完成状态

- 方案 A 的 B1 Task 1–9、B2 Task 10–12 已完成代码实现并通过独立复核；Task 12 报告：`.superpowers/sdd/task-12-report.md`。
- Task 12 已实现不可变 submit attempt、原子授权预算/child/batch/lock 转移、单 child 恢复、unknown 不重投、一次同盘口赔率变化重预览、持久对账证据与 5/15/45 退避、v2 AAD provider reference、持久 Telegram outcome outbox 和显式通知 consumer。
- 已发送订单在授权过期、撤销或环境改变后仍可记录明确结果；新 attempt 继续要求完整 authorization/hard-cap/rule/account/capability/preview/fence gate。
- 生产模块不再暴露可伪造的 test authority。离线 ledger fixture 只能作用于 `provider=fixture`，不能证明 Crown batch；离线 preview fixture 只允许 RFC 保留的 `example.test` 域并固定 `realExecutionEligible:false`。
- Telegram 多群部分成功会持久化已成功目标，HTTP 失败、throw 或 Abort 后只重试失败目标；每条通知发送前单独领取新 lease，避免批尾 lease 到期重复。
- 最终验证：Task 12 focused 108/108、backend 749/749、syntax 162、frontend 48/48、production build 与 Compose config 通过；三路最终独立复核均为 0 Critical/Important。
- 当时真实验收未执行：canonical Crown preview/submit 能力为 0，production submit/reconciliation/manual resolution 保持 fail-closed，没有调用 `FT_bet`、真实 Crown preview 或真实 Telegram；当前 capability 以上方 Task 3 的 side-aware `8/1/0` 为准。
- 历史 login-diagnostics cleanup、受影响密码轮换和 session/cookie 失效仍需用户明确授权。没有 Git commit。C 设计草案已写入 `docs/superpowers/specs/2026-07-11-crown-c-strategy-mobile-console-design.md`，推荐“多实例 odds_delta + 统一响应式移动运维控制台”，待用户确认后编写实施计划。

## 历史：2026-07-11 B 阶段方案 A 当时状态

- 用户确认方案 A：完成 B1 安全核心后继续 B2 Provider/Executor，并要求边开发边验收。设计入口：`docs/superpowers/specs/2026-07-10-crown-b-multi-account-betting-design.md`；12 Task 计划入口：`docs/superpowers/plans/2026-07-10-crown-b-multi-account-betting.md`。
- B1 Task 1–9 已完成并通过独立复核。Task 7 最终证据为 backend 125/125、frontend focused 18/18；Task 8 的开赛时间投影、逐赛事诊断、prematch/live 双 Switch 和 watcher canonical lease 已完成。
- Task 9 最终证据：双 fresh SQLite 集成 4/4、B1 focused 310/310、backend 597/597、syntax 142、frontend 43/43、production build 通过。终审发现的 intent 派生金额绕过 `--max-stake` 已修复并复核：effective stake 在 session/DB/login/Provider 前受 `0 < stake <= maxStake <= 50` 约束。
- B1 金额只使用 JavaScript safe INTEGER minor units。规则目标金额与账号单笔上限分离；provider min/max/step、余额、币种和 scale 在分配/预留时核验。
- 持久 Signal 以 `signalId + ruleId` 创建确定性 batch；child order 是账本真相，batch 聚合可重算。多账号并发、单账号 lock 串行；rejected 可重新分配，unknown 保留金额和锁、进入 `waiting_result` 且不自动重投。
- 严格锁定 event/period/market/lineKey/handicap/opposite side；赔率变化继续，盘口线、阶段、side 或 suspended 变化停止未发送部分。恢复覆盖四个崩溃窗口，无法证明未发送的 attempt 统一 unknown。
- B1 worker 默认 `off`，`preview`/`simulated` 都要求显式非空脚本并保持真实网络与 `FT_bet` 为零；Simulated Provider 不导入 Crown adapter。Executor 和 watcher 使用不同 canonical fenced lease key。
- watcher 同进程处理可独立启停的赛前/滚球；Dashboard 展示北京时间、时间质量/warnings 和折叠逐赛事诊断。相同 DB/runtime 的 Dashboard child 与手动 watcher CLI 共享单实例 lease。
- B2 Task 10 代码已完成并通过两组独立复核：ExecutionAuthorization/child budget 原子账本、规则独立升权与审计、Dashboard session/Host/Origin/CSRF、登录诊断脱敏、Docker context/runtime 隔离均已实现。最终证据 backend 630/630、syntax 148、frontend 48/48、build 和 Compose 配置通过；Docker daemon 未运行，未做容器启动验收。历史 `data/runtime/login-diagnostics` 尚未自动改写或删除，只有用户明确授权后才能运行 cleanup `--apply`。
- Dashboard 前端收到任一 API 401 时会同步清除内存 CSRF、发出 `crown:dashboard-auth-expired` 内存事件并立即显示未登录；服务端 8 小时过期 session 会返回 401、从内存 purge，旧 cookie 不会因测试时钟回退而复活。
- 本轮复审按 TDD 先得到前端 2 个预期失败，再以最小实现转绿；最终 Dashboard security 10/10、frontend 48/48、production build 成功，文档 6 个旧风险短语/5 个当前安全事实断言通过。build 仅保留既有的单 chunk 超过 500 kB 警告，不影响产物生成。
- Task 11–12 已完成 sanitized fixture/offline-only 开发和安全复核。实际旧诊断清理、受影响密码轮换和旧 session/cookie 失效完成前不得执行受控真实 preview。2026-07-09 的旧 adapter 不属于 B1/B2 多账号 Executor；任何真实小额 `FT_bet` 仍需验收当次新授权。
- Task 11 betting session 安全复审已关闭首轮三项 Important及终审登录层问题：strict owner 保存时缺失/错配 `accountId` 都拒绝；betting 方法只向上抛稳定脱敏错误；账号 URL 必须是 public HTTPS exact origin，拒绝 credentials/path/query/hash、HTTP、localhost/private hostname 和 IP literal；所有 Crown API POST 使用 manual redirect，3xx 在采用 cookie 前 fail-closed；betting session/detail 提供可选 fence hook，在开始、每次网络后及任何 save/invalidate 前复核，lease 错误原样传播且 stale owner 不改旧 session。Monitor `ensureSession` 保持兼容，全部验证只使用 fake/temp 数据，未访问 live/runtime。
- 当前没有 Git commit；整个仓库仍无首次提交。B 阶段自动开发/测试使用临时数据库和模拟 Provider，没有发送真实投注请求。


## 2026-07-10 赔率阈值 TG 提醒与时间口径热修

- 实际故障不是 Telegram 配置：最近 5000 条赔率变化都达到 `0.01`，但 schema-v2 策略因皇冠源时间被错误按 `Asia/Shanghai` 解析，全部在 Signal 前被 `start_time_missing`、`kickoff-window-mismatch`、模式或联赛范围过滤；当时 Signal/Delivery 均为 0。
- 皇冠 XML 实测根级 `system_time` 比 UTC 慢 4 小时。时间解析器现在按每次 list 响应的 `system_time + capturedAt` 推导源 UTC offset；同一 poll 中缺少 `system_time` 的 game-more detail 继承 list 时间上下文。实际 `2026-07-10 05:30:00` 已正确保存为 `2026-07-10T09:30:00.000Z`、`UTC-04:00`，不再错误保存为前一天 `21:30Z`。
- Signal evidence 新增球队、原始盘口和三位原始新旧赔率；这些展示字段不参与 `signalId`，事实幂等键不变。schema-v2 TG 改为用户确认的无抬头五行格式：联赛、比赛、抓取类型、盘口与旧/新赔率、北京时间；不显示策略、Signal ID、threshold 或数据质量技术字段。
- Dashboard 的赔率变动时间显式按 `Asia/Shanghai` 格式化，不再依赖运行电脑时区；数据库中的 `observedAt/capturedAt` 继续保存规范 UTC。
- 最终自动验证：backend 420/420；syntax 119/119；frontend 34/34（显式 `TZ=UTC`）；production build 成功。真实 watcher 重启后产生新 Signal，Telegram delivery 一次发送成功；检查时 console/telegram 各 16 条均为 `sent`，无 pending/dead-letter。watcher 仍不调用真实投注。

## 2026-07-10 A 阶段完成：监控核心 v2 已验收可用

- A1–A12 已完成；默认 watcher 已使用 SnapshotBatch、canonical event/market/selection identity、Crown time、SQLite state、纯事实 Change、StrategyRegistry、持久 Signal/冷却、异步 Dispatcher 和确定性 Candidate。真实自动下注仍未接入 watcher。
- A12 修复了空 `get_game_list` 被错误视为 authoritative 的缺陷：零赛事响应现在 fail-closed 为 partial/incomplete，连续两次也不会年龄化或移除现有 scope/event/selection。新增同一 GIDM、不同 GID 的 SQLite 隔离证据。
- 新增磁盘脱敏 sequence fixture，固定 list→两个 game-more→变化 detail；两套 fresh DB 得到完全一致的 3 个 Change ID、1 个 Signal ID、1 个 candidate ID，同库重放计数不增长。
- 故障验收覆盖 incomplete list、login-expired、stale detail、Telegram timeout/restart；这些故障不污染 active/baseline，Signal/Candidate/JSONL 保持 exactly-once。105 条 delivery 以 batchSize=20 全部排空，无 stranded pending/retry/dispatching。
- 缺开赛时间或滚球分钟仍保存 event/selection 事实和 baseline，但 Signal=0；Dashboard 显示数据不完整原因。
- 受控真实只读短跑使用 SQLite Online Backup 克隆账号库，禁用策略、Console 和 Telegram，只请求登录校验、`get_game_list`、`get_game_more`。结果：2 次 list、16 次 detail、2960 条 v2 snapshot、240 条 Change、解析错误 0；148 个 GID 的 eventKey 冲突 0，detail 导致的 event-removed 0，preview/submit 请求 0。
- 真实数据解析率：赛前 `startTimeUtc` 1928/2720（70.88%），滚球 `liveMinute` 224/240（93.33%）；缺失值作为 dataQuality 保存并由策略 fail-closed，不伪造时间。
- live Dashboard `/api/summary`、`/api/events`、`/api/changes`、`/api/app/bootstrap` 均返回 200；Cookie/password/token/storageState/Authorization/ticket/raw session 等禁止字段 0 命中。短跑 v2 JSONL/runtime log 的敏感格式命中同样为 0。
- 新增可复现只读验收入口 `npm run crown:monitor:acceptance-audit -- --runtime-dir <runtime> --db-path <db> --output <report>`：报告记录规则版本、26 个禁止字段、5 类 secret pattern、输入/API SHA-256、审计前后哈希一致性和全部统计；真实短跑统一报告 `pass=true`，18 个请求全部为 monitor。
- 最终验证：monitor 聚焦 157/157；完整 backend 416/416；syntax 119 个 `.mjs`；frontend 35/35；production build 成功。Docker CLI 存在但本机 Docker Desktop daemon 未运行，因此未做容器启动验证；compose 契约测试已在 backend 全量中通过。
- 本机实际联机运行 Dashboard + schema-v2 watcher 后，`/matches` 能持续显示 137 场实时比赛、23 场追踪比赛；修复了 `monitor-v2` 数据源被前端状态卡误判成“离线样本”的显示问题，页面现按最后快照时间显示“实时赔率正常”。
- A 阶段状态为完成，当前按用户要求暂停，不自动进入 B/C。完整验收矩阵见 `docs/repository-publication-audit.md`。

## 2026-07-10 A 阶段 Task 11：schema-v2 默认、回滚与运维手册

- `scripts/crown-watch.mjs` 新增 `--monitor-state-version 1|2`，默认 2。正常带完整监控账号凭据的 direct XML 运行使用 v2 SQLite state、v2 audit、Dispatcher 和 `betting-candidates-v2.jsonl`；账号缺失/不完整和非法版本都 fail-closed，不会静默进入 schema-v1。
- 显式 version 1 会打印高可见度 `DEPRECATED schema-v1` event lifecycle 警告，跳过 direct-v2 state/dispatcher/candidate store，继续写旧 snapshots/changes/candidates。旧 v1/v2 文件均不删除、不重命名、不截断；DOM/fixture 保持 schema-v1 compatibility。
- 审查修复后，schema-v1 对不存在 app DB 不创建文件；对现有 DB 仅只读查询，不执行 migration、runtime status 写入或 v2 建表。schema-v2 缺账号/凭据时明确失败，不再静默进入 legacy DOM。
- CLI 所有取值参数现在拒绝缺值/后续 flag，数值参数拒绝非有限数和负数；v1/v2 保留候选文件名不能跨 generation 覆盖。legacy DOM 和 fixture orchestration 均传递明确 candidate path，DOM 同时传递 betting rule。
- 新增 dry initialization 集成测试：临时 SQLite/runtime 第一轮 authoritative list + detail 只建 baseline、Signal=0；第二轮有效 odds change 后 Signal=1。
- 运维入口新增 `docs/crown-monitor-v2-runbook.md`，覆盖启动、baseline warmup、v2 文件/表、健康、dead-letter、回滚、备份和验证；README、主架构、监控模块和模块索引已同步 Change→Strategy→Signal→Dispatcher/Candidate 边界。
- 验证：修复聚焦 35/35，其中 state-version/side-effect 10/10；完整后端 404/404；syntax check 117 个 `.mjs`。临时目录实际 schema-v1 fixture 短跑只生成三个旧 JSONL，v2 文件 0、SQLite 0，并出现 DEPRECATED 警告；默认 v2 缺 DB 退出码 1 且不创建 DB。
- 安全扫描：Git 候选中的 GitHub/OpenAI/AWS/Telegram secret 格式 0 命中，本机用户目录绝对路径 0 命中；watcher/monitor 对真实投注 adapter/`FT_bet` 引用 0 命中。
- 未执行真实 Crown 登录、Telegram 发送或投注请求；schema-v1 只作为短期回滚，不能与 v2 健康或恢复状态混用。

## 2026-07-10 A 阶段设计与实施计划（历史记录，已被上方完成状态取代）

- A 阶段设计：`docs/superpowers/specs/2026-07-10-crown-monitor-core-redesign.md`；推荐并拟采用方案 2（SnapshotBatch + canonical identity + SQLite state + Change→Strategy→Signal）。
- A 阶段实施计划草案：`docs/superpowers/plans/2026-07-10-crown-monitor-core-redesign.md`，共 12 个 Task、88 个 checkbox 步骤；已完成 spec coverage、type consistency 和占位符扫描。
- 本段记录设计获批前状态；后续用户已确认并完成 A1–A12，不再作为当前待办。

## 2026-07-10 GitHub 公开仓库安全基线与 replay 隔离

- 项目已在本地初始化为 Git `main`，origin 为 `https://github.com/Austin-C1/hg-.git`；远端为空，当前尚无 commit/push。发布审计入口：`docs/repository-publication-audit.md`。
- `.gitignore` / `.dockerignore` 已排除 storage、SQLite、加密密钥、Telegram 实际配置、runtime、Cookie/session、登录诊断、浏览器 profile、输出、日志、PBBall 二进制和本地参考目录；`.env.example` 明确保留。
- `replayFixture()` 支持 `outputDir`；replay 测试改用系统临时目录，不再重写项目 fixture；生成记录中的本地输入来源使用项目相对路径，不再泄露用户目录绝对路径。
- 本次 TDD 验证：新增 2 项测试先按预期失败，最小实现后 2/2 通过。全量验证为 `npm test` 193/193、`npm run check` 100 个 `.mjs`、前端 32/32、production build 通过。
- 首次公开 push 前仍需对 staged 清单做最终秘密扫描，并确认 fixture 业务样本允许公开；没有用户明确要求时不自动 commit/push。

## 2026-07-10 全项目架构审查与主文档重写（历史审查快照）

- 当前完整交接入口已重写为 `docs/crown-current-architecture.md`，覆盖采集、登录、XML/DOM 标准化、JSONL、监控规则、Telegram、候选、投注协议/执行、SQLite/API、React、Docker、开发扩展和测试方法。
- 当前状态应区分：监控与 Dashboard 已实现；`CrownBetAdapter`、dry-run、受控 real CLI 和多账号顺序执行已有代码与 fake-response 测试；Dashboard 自动执行和监控告警自动真实下注均未接入。
- 本条记录的是 2026-07-10 当时的 P0：登录诊断明文/API 回传、单账号 execute session 归属、derived stake 绕过 `--max-stake`、Docker build 带入私有配置。到 2026-07-11，除单账号旧 execute session 归属外其余三项已修复；历史诊断 cleanup 仍待用户授权，不能把本条当成当前实现状态。
- 监控链存在批次语义缺陷：list 和每个 game-more 分别 ingest，但 store 把每次 ingest 视作完整赛事集合，会制造 event 增删抖动并删除其他赛事 odds baseline；赛前时间窗口也因 normalizer 常无 `startTimeUtc` 而可能不生效。
- 测试通过只证明已覆盖行为稳定，不证明真实资金安全语义；完整限制和扩展顺序以主文档第 13、14、16 节为准。
- 本次完整验证：`npm test` 193/193、`npm run check` 100 个 `.mjs`、前端 32/32、production build 均通过。
- `tests/crown-replay-fixture.test.mjs` 会直接把 replay 结果写回项目 fixture 目录并刷新 `generatedAt`，不是严格只读测试；本次验证已触发四个 replay 生成文件重写。后续应把 replay output 指向临时目录或让测试复制 fixture 后再运行。

## 2026-07-09 投注顺序显示与预览失败原因修正

- 本机 `/betting-accounts` 显示“投注顺序：未设置”的根因是 8787 Dashboard 仍运行 15:33 启动的旧 Node 进程，旧接口返回的投注账号 payload 没有 `betOrder` 字段；重启新服务后接口正常返回 `betOrder`。
- 当前两个投注账号已按页面列表顺序通过 API 补成 `betOrder=1`、`betOrder=2`，用户仍可在编辑弹窗里手动调整。
- 最近投注历史里“预览失败”不是实际提交失败；SQLite 统计为 `preview-rejected=31`、`previewed=4`，其中 30 条预览失败为 Crown `FT_order_view` 返回 `code=555` 且无赔率/限额，集中在“世界杯2026(美加墨) 法国 vs 摩洛哥”的赛前候选盘口。
- `parseCrownPreviewResponse()` 现在会保留 Crown 预览失败的 `errormsg`、`systime`、`fast_check`；Dashboard 投注历史会把 `preview-rejected` 显示为 `预览失败 code=... / ...`，避免只看到一排没有原因的失败。
- `scripts/crown-betting-candidate-dry-run.mjs` 现在执行前会优先用最新 `crown-odds-snapshots.jsonl` 刷新候选目标盘口，并默认拒绝超过 180 秒的候选；这可以避免把旧 `betting-candidates.jsonl` 里的过期盘口反复拿去开单，导致连续 `code=555`。
- 8787 Dashboard 已用新构建重启；浏览器验收 `/betting-accounts` 显示顺序 1/2、展开历史显示失败 code，控制台无错误。

## 2026-07-09 投注账号顺序执行与投注成功机器人配置

- 投注账号新增手动投注顺序字段 `betOrder` / SQLite `bet_order`；`/betting-accounts` 新增和编辑弹窗可维护“投注顺序”，账号卡片显示顺序，未设置显示“未设置”。
- 后端 `listBettingAccounts()` 现在按 `bet_order` 升序返回，未设置顺序的账号排最后；新增 `listEnabledBettingAccountsForExecution()` 只返回 `status=enabled`、`bet_order>0` 且已保存密码的账号，并解密密码供独立执行脚本使用。
- 新增顺序执行入口 `npm run crown:betting:execute-sequence`；真实模式仍必须显式 `--real --confirm REAL_BET --max-stake 50`，并按账号顺序逐个验证 Crown API session、执行预览、提交和 `get_dangerous` 二次确认。任一账号结果不是 `accepted` 时立即停止，不继续后续账号。
- 投注成功通知机器人 `betSuccess` 已在本地 `config/telegram-settings.json` 启用，并复用当前 Telegram 接收 Chat ID；token 只保存在本地配置，不写入文档、日志或 API 明文响应。投注成功消息模板尚未最终接入，下一步由用户确认模板字段。
- 发现并修复 watcher 读取 JSON 配置时不兼容 UTF-8 BOM 的问题：`scripts/crown-watch.mjs` 的 `readJson()` 现在会剥离 BOM，避免 Windows PowerShell 写入配置后 fixture/watch 测试失败。
- 验证：`npm test` 190/190 通过；`npm run check` 100 个 `.mjs` 通过；`npm --prefix frontend run test` 31/31 通过；`npm --prefix frontend run build` 通过；Edge/Playwright 页面验收 `/betting-accounts` 无控制台错误，截图在 `output/playwright/betting-accounts-order.png`。

## 2026-07-09 新监控账号启动状态排查

- 新皇冠监控账号替换后，旧 `crown-watch` 和旧 session 被停止/清理；“测试登录”只会验证并保存 API session，不会启动长驻赔率轮询。因此换号后必须执行“开始监控”，否则 `/matches` 会因没有新快照写入而显示赔率更新异常。
- 本次排查确认新监控账号本身可用：`crown-watch` 进程存在，`/api/app/monitor-account` 返回 `currentMonitorStatus=正在监控赔率`，`lastXmlResponseAt` 与 `lastOddsParsedAt` 持续更新，`consecutiveFailures=0`。
- 根因之一是 `/monitor-account` 页面此前只在进入页面和按钮操作后读取一次状态；“开始监控”接口立即返回 `打开网站中`，后台几秒后写入 `正在监控赔率` 和 XML 时间，但页面不自动刷新，容易误判为监控不可用。页面已改为每 5 秒轻量刷新监控账号状态，且轮询不会覆盖正在编辑的表单字段。

## 2026-07-09 投注账号历史显示口径修正

- 投注账号页历史记录来自 SQLite `betting_history.betting_account_id`，账号替换如果复用旧账号行 `id`，旧历史会继续挂到新用户名下；新投注账号应创建新账号行或在数据层解绑旧 history，避免把旧记录算到新账号。
- 当前本机显示在新投注账号下的 30 条记录状态为 `preview-rejected`，时间为 2026-07-09 15:48-15:53 Asia/Shanghai，早于 16:51 的账号替换；它们不是新账号真实投注。
- `/betting-accounts` 已把卡片统计改为“今日真实投注次数/金额”，只统计 `status=accepted` 的真实确认投注；历史明细新增“状态”列，`preview-rejected` 显示为“预览失败”，避免 dry-run 失败记录误导为真实投注。

## 2026-07-09 默认追踪白名单替换

- 用户确认“之前的白名单情况只用这些”，默认追踪白名单已替换为用户提供的 118 个欧洲、美洲、亚洲、杯赛和国际赛事名称。
- `config/default-leagues.json` 和 `src/crown/config/default-leagues.mjs` 的内置默认名单保持一致；旧的 `欧洲冠军联赛外围赛` 等不在本次名单内的默认项不再保留。
- 默认联赛匹配规则继续按皇冠内部联赛名 `name` 精确匹配，不使用 aliases、包含匹配或模糊匹配；全部新默认项为 `enabled=true`、`autoTrack=true`、`modes=["prematch","live"]`。
- 新增 `tests/crown-default-leagues.test.mjs` 覆盖“项目默认白名单只包含用户提供名单”，防止后续误追加或恢复旧白名单。

## 2026-07-09 监控报警触发投注候选 dry-run

- 历史说明（当时 schema-v1）：投注候选来自 `evaluateMonitorChange()` 命中；当前 schema-v2 已迁移为 Change→Strategy→Signal→Candidate，不再从 raw Change 直接生成候选。
- 下注规则新增 `betDirectionMode`：`auto` 自动、`follow` 顺打、`reverse` 反打。`auto` 下当前盘口升水写反向盘口候选，当前盘口掉水写当前盘口候选；让球反向为主队/客队互换，大小球反向为大/小互换。
- 下注规则页已显示并可编辑“投注赔率下限”和“投注方向”；候选生成会用下注规则 `minOdds` 检查目标投注盘口赔率，低于下限写 `skipped`，不会执行 dry-run。
- 历史说明（当时 schema-v1）写入 `betting-candidates.jsonl`；当前 schema-v2 写 `betting-candidates-v2.jsonl`。两代 watcher 都不导入 `CrownBetAdapter`，不会发送 `FT_order_view` 或 `FT_bet`。
- 独立命令 `npm run crown:betting:candidate-dry-run` 消费 `eligible` 候选并执行 dry-run 预览；该命令只走 `FT_order_view`，审计写入脱敏 JSONL，结果写入 SQLite `betting_history`。
- 盘口采集范围按用户确认固定为让球和普通大小球：主盘口、上半场、A-F 分线和对应滚球字段会进入监控；球队大小球不进入快照、变化、TG 报警或候选下注链路。多分线通过 `lineKey` 区分，反打时只在同一条盘口线内找反向选择。
- bootstrap 默认 dry-run 账号和规则名已改为中文：`手动预览账号`、`手动预览规则`；SQLite 打开时也会把已知旧占位值 `Manual dry-run rule` / `manual-dry-run` / `portable-dry-run` 精确迁移成中文，避免 Dashboard 继续出现英文测试数据。
- 2026-07-09 实测完整链路时，Dashboard 进程必须带 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY=http://127.0.0.1:7897` 和 `NODE_OPTIONS=--use-env-proxy` 才能让 Telegram 发送成功；未带代理时 `/api/settings/telegram/test` 会因 Node 直连 Telegram 超时返回 500。
- 同次实测中，监控能写出 `eligible` 候选并触发 TG，但当前实时盘口全是赛前 `RATIO_R`、`RATIO_OUO`、`RATIO_HR`、`RATIO_HOUO`；现有投注 mapper 只支持已验证的 live `RE` 全场让球和 live `ROU/f=1R` 上半场大小球，因此这些赛前候选不能执行 dry-run 投注预览。

## 2026-07-09 Dashboard 下注规则与投注账号卡片化（历史实现，已被动态卡片取代）

- 2026-07-09 当时 `/betting-rules` 使用横向旧卡片，UI 只编辑 `name`、`perAccountBetAmount`、`perAccountDailyLimit`；该 UI 和字段契约现已 retired，不是当前页面。
- 2026-07-09 当时 SQLite `betting_rules` 新增 `per_account_bet_amount` 和 `per_account_daily_limit` 并同步旧字段；该表当前仅保留历史 B/C 证据，动态卡片使用 `auto_betting_rule_cards` 与独占联赛表。
- `/betting-accounts` 已改为横向账号卡片；卡片展示账号、网址、今日总投注次数和今日总投注金额，今日统计从该账号 `betting_history` 按本地日期动态计算。
- 投注账号弹窗只要求账号、密码、网址；密码继续写入加密 secret，API/UI 只返回 `hasSecret`，卡片和历史记录不展示密码明文。
- 账号卡片点击可展开/收起历史投注；历史只展示联赛名字、比赛队伍、投注盘口、投注金额、投注时间，按投注时间倒序。删除账号只删除账号配置，历史记录保留。
- `betting_history` API 映射新增 `accountId`、`leagueName`、`teams`、`market`、`betTime` 展示字段；旧历史可从 `details`、`eventKey` 和 `created_at` fallback。`CrownBetAdapter` 写历史时会同步写入联赛、队伍和盘口摘要。

## 2026-07-09 投注执行可复现启动与模拟提交

- 本轮复查发现 live dry-run 返回 `code=555` / 无赔率和限额时，旧 parser 会把 preview 误标为成功；已修复为 `preview-rejected`，并保证 real 模式下 preview 失败不会继续发送 `FT_bet`。
- 新增 `scripts/crown-bet-bootstrap.mjs` / `npm run crown:betting:bootstrap`，用于干净电脑初始化 preview-only 投注账号、投注规则和 dry-run intent，不再依赖本机 `bet_manual` / `brule_manual`。
- bootstrap 从 `data/runtime/crown-odds-snapshots.jsonl` 自动挑选已支持的 XML runtime 盘口生成 `data/runtime/betting-intents/manual-dry-run.json`；如果没有支持盘口，只创建账号和规则，不写可执行 intent。
- 自动选择范围只包含已验证的 live `RE` 全场让球和 live `ROU/f=1R` 上半场大小球；显式赛前 `RATIO_R` / `IOR_R*` 会被 mapper 拒绝，避免把未验证盘口当作可执行链路。
- `BetIntent` 现在保留 `eventKey`、`ratioField`、`oddsField`，方便不同机器从自己的 runtime 快照生成等价 intent。
- `CrownBetAdapter` 和 CLI 已用 fake provider 响应验证真实模式链路：`FT_order_view -> FT_bet -> get_dangerous`；真实模式仍必须显式 `--real --confirm REAL_BET --max-stake 50`，且 rule 必须 `previewOnly=false`。
- 当前只完成模拟提交/轮询验证，没有执行真实 Crown 提交；下一次真实提交验收必须用户在场，并继续写入脱敏 audit 和 SQLite `betting_history`。
- 当前本机 `data/runtime/betting-intents/manual-dry-run.json` dry-run 返回 `preview-rejected` / `code=555`，说明该手工 intent 当前不是可用投注预览；它没有发送真实提交。
- 验证结果：投注相关目标测试 25 项通过，`npm test` 164 项通过，`npm run check` 94 个 `.mjs` 通过；运行代码硬编码扫描、watcher 下注边界扫描和 betting audit 敏感字段扫描均 0 命中。

## 2026-07-09 投注协议非提交拦截验证

- 新验证 run：`data/runtime/betting-protocol-captures/20260709-111046/public/`。该 run 使用 `allowRealSubmit=false`，在细分盘口详情页点击赔率、输入金额并点击下注后，`FT_bet` 被本地 Playwright route 拦截，记录为 `request-blocked` / `blockReason=real-submit-disabled`。
- 该 run 没有新的 submit response，也没有 `get_dangerous` 状态轮询；页面出现网络/交易状况提示是拦截后的预期表现。`get_today_wagers` 仍可能返回上一轮历史注单，不能当作本轮提交成功依据。
- `capture-redaction.mjs` 已补强字符串级脱敏：ticket/order id 在对象字段、XML tag、`ticket id='...'` 属性和文本参数中都会被 mask；两轮 public redacted 抓包已用新规则重写并重新分析。
- 用户确认盘口页面至少有两种布局：赛事列表大盘口页、进入比赛后的细分盘口页。后续 adapter 前应分别抓包比较 `FT_order_view` 开单字段来源和 `FT_bet` 提交字段差异。

## 2026-07-09 投注协议列表页大盘口抓包

- 列表页 run：`data/runtime/betting-protocol-captures/20260709-112647/public/`。该 run 使用 `allowRealSubmit=false`，在赛事列表大盘口页点击大小球赔率、输入金额并点击下注后，`FT_bet` 同样被拦截为 `request-blocked` / `blockReason=real-submit-disabled`。
- 列表页样本和细分页样本使用同一组开单/提交 key：preview 为 `p=FT_order_view`，submit 为 `p=FT_bet`；区别主要在市场字段值。本次列表页大小球样本观察到 `wtype=ROU`、`rtype=ROUC`、`chose_team=C`、`f=1R`。
- 该 run 没有新的 submit response，也没有 `get_dangerous` 状态轮询；public 输出经扫描未发现明文 ticket/order id。

## 历史：2026-07-09 CrownBetAdapter 开发计划

- 当时的 adapter 开发计划入口为 `docs/superpowers/plans/2026-07-09-crown-bet-adapter-execution.md`；该计划仅保留为历史实现依据，不得替代文首唯一权威实施计划 `docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md`。
- 当时推荐的执行顺序是先做 API-first dry-run preview、Crown order field mapper、risk guard、redacted audit、betting history summary，再做 `--real --confirm REAL_BET --max-stake 50` 的受控真实提交验收。
- 当时计划保持 watcher 只读；真实下注不得从 `scripts/crown-watch.mjs` 或告警自动触发。

## 2026-07-09 CrownBetAdapter Dry-Run Preview

- 已完成 adapter 计划 Task 1-7：`BetIntent` 校验、Crown preview/submit/status 响应解析、已抓包盘口字段映射、`RiskGuard`、脱敏审计日志、Dashboard betting history 写入，以及 `CrownBetAdapter` dry-run preview。
- 新增代码入口：`src/betting/bet-intent.mjs`、`src/betting/risk-guard.mjs`、`src/betting/audit-log.mjs`、`src/crown/betting/crown-bet-response-parser.mjs`、`src/crown/betting/crown-order-field-mapper.mjs`、`src/crown/betting/crown-bet-adapter.mjs`。
- `CrownBetAdapter` dry-run 只发送 `FT_order_view`；真实 `FT_bet` 和 `get_dangerous` 轮询已在后续模拟响应测试中实现，真实 Crown 环境提交仍未验收。
- 支持盘口仍限于已捕获样本：滚球全场让球和滚球上半场大小球。其他 market 必须先抓包并补 fixture 测试。
- 验证结果：新增投注执行测试 13 项通过，`tests/crown-app-repository.test.mjs` 6 项通过，`npm test` 152 项通过，`npm run check` 90 个 `.mjs` 通过。

## 2026-07-09 Dry-Run CLI 与审计历史接入

- 已新增受控 dry-run CLI：`scripts/crown-bet-execute.mjs`，package 命令为 `npm run crown:betting:execute`。
- CLI 默认 dry-run，必须提供 `--intent-file`、`--account-id`、`--rule-id`；默认读取 `data/runtime/crown-sessions/mon_primary/api-session.json`，默认审计文件为 `data/runtime/betting-execution-audit.jsonl`。
- CLI 默认 dry-run 只发送 `FT_order_view`；真实模式已实现 gated submit/poll，但必须显式 `--real --confirm REAL_BET --max-stake 50`，且 rule 必须 `previewOnly=false`。
- `CrownBetAdapter` 已接入审计和 history 回调；dry-run 结果写入脱敏审计 JSONL 和 SQLite `betting_history` 摘要。
- 验证结果：`node --test tests\crown-bet-adapter.test.mjs tests\crown-bet-execute-cli.test.mjs` 6 项通过；`node --check scripts\crown-bet-execute.mjs` 通过。

## 2026-07-09 Live Dry-Run 验证

- 使用真实 Crown API session 跑通 dry-run：`npm run crown:betting:execute -- --intent-file data\runtime\betting-intents\manual-dry-run.json --account-id bet_manual --rule-id brule_manual --stake 50`。
- fetch 包装器确认实际请求序列只有 `FT_order_view`，没有 `FT_bet`。
- 验收样本：live football asian handicap，`gid=8878931`，`wtype=RE`，`chose_team=H`，spread `0`。
- 响应结果：`previewed`，`code=501`，`gold_gmin=50`，`gold_gmax=30000`，`ioratio=0.83`，`strong=H`。
- 审计文件 `data/runtime/betting-execution-audit.jsonl` 最近行扫描未命中 uid/cookie/token/password/ticket 明文字段；SQLite `betting_history` 已写入 `bet_manual` / `brule_manual` 摘要。
- 一次赛前 `RATIO_R` 样本返回 `code=555` 且无限额字段，说明当前 mapper 不能把 prematch `RATIO_R` 当成已验证盘口；继续只认已抓包 live `RE` / `ROU` 变体。

## 2026-07-09 投注协议抓取基础模块

- 已完成投注协议抓取基础 Tasks 1-5：安全边界改为 `monitor` / `protocol-capture` / `execution` 三模式；`docs/betting-architecture.md`、`docs/betting-contract.md`、`src/betting/README.md`、`README.md` 已同步。
- 新增 `src/crown/betting-protocol/`：`capture-redaction.mjs` 负责 header/body/url 脱敏，`protocol-store.mjs` 负责同时写入 private raw JSONL 和 public redacted JSONL，`protocol-classifier.mjs` 负责把请求粗分为 monitor / preview / submit / candidate / unknown。
- 新增 CLI：`npm run crown:betting:capture` 打开可见浏览器做受控抓包；`npm run crown:betting:analyze -- data/runtime/betting-protocol-captures/<run>` 汇总 public redacted 抓包并生成 `protocol-summary.json` 和 `protocol-map.md`。
- 新增协议字段地图入口：`docs/crown-betting-protocol-map.md`；正式字段结论只能写 endpoint pattern、字段名、响应语义和 public evidence path，不写 cookie/token/auth/password/raw uid。
- 真实提交抓包仍未执行。后续 Task 6 是非提交抓包，Task 7 是小金额真实提交抓包；Task 7 必须用户在场，并带 `--allow-real-submit --max-stake 50 --confirm REAL_BET`。
- 验证：`node --check scripts\crown-betting-protocol-capture.mjs` 通过；`node --check scripts\crown-betting-protocol-analyze.mjs` 通过；`node --test tests\crown-betting-protocol-redaction.test.mjs tests\crown-betting-protocol-classifier.test.mjs` 6/6 通过；`npm test` 133/133 通过；`npm run check` 78 个 `.mjs` 文件通过。

## 2026-07-09 投注协议首次真实提交证据与安全修正

- 抓包 run：`data/runtime/betting-protocol-captures/20260709-110033/public/`。该 run 原本按非提交模式启动，manifest 为 `allowRealSubmit=false`，但页面侧实际完成一笔真实提交；因此它只能作为协议证据，不能作为“受控真实提交”验收。
- 根因：`scripts/crown-betting-protocol-capture.mjs` 之前只做文字提醒，没有在 Playwright 网络层拦截 submit 请求；同时 `p=FT_bet` 在旧 classifier 中只被归类为 candidate，不会被识别成 submit。
- 修复：`src/crown/betting-protocol/protocol-classifier.mjs` 现在把 `FT_bet` 分类为 `submit`，并新增 `shouldBlockProtocolRequest()`；抓包脚本在 `allowRealSubmit=false` 时通过 `page.route('**/*')` abort submit 请求并写入 `request-blocked` 记录。
- 协议字段初步结论：预览/open slip 为 `POST /transform.php p=FT_order_view`；真实提交为 `POST /transform.php p=FT_bet`；状态轮询为 `p=get_dangerous from=bet`；今日注单刷新为 `p=get_today_wagers`。字段映射写入 `docs/crown-betting-protocol-map.md`。
- 响应语义初步结论：submit response 返回 ticket/order id 后，`get_dangerous` 的 `status_N` 表示待确认，`status_A` 表示确认；`get_today_wagers` 中 `ball_act_ret=确认` 可作为历史确认依据。不要在文档或回复里输出原始 ticket id。
- 后续必须用修复后的非提交抓包重新验证：未带 `--allow-real-submit` 时，点击下注按钮应被网络层拦截，不再产生真实下注。

## 2026-07-09 架构体检与投注边界同步

- Dashboard 大 JSONL 性能根因：`/api/summary`、`/api/events`、`/api/changes` 之前都会整读 `data/runtime/crown-odds-snapshots.jsonl` 和 `data/runtime/crown-odds-changes.jsonl`，当前 runtime 文件已超过 100MB，导致接口 4-6 秒级。
- 修复：`src/crown/dashboard/jsonl-reader.mjs` 增加尾部读取和流式过滤；`readDashboardData()` 对 snapshot/change/runtime log 使用有界读取；`/api/changes` 改为直接读取变化文件，不再构建完整 Dashboard 数据。
- 真实性能验证：临时 8799 端口使用当前大 runtime 数据，`/api/summary` 约 721ms、`/api/events` 约 772ms、`/api/changes?limit=100` 约 242ms。
- 投注边界已从“任何执行代码都禁止”调整为“监控路径仍只读，投注协议抓取和未来真实执行必须在独立投注模块内完成”；真实执行需要显式执行模式、确认词、金额限制和审计日志，不能由监控告警自动触发。
- Dashboard 下注规则的 `previewOnly` 改为可配置字段，不再由后端强制写成 `true`；但当前 Dashboard 仍没有下单请求提交器、盘口点击、金额填写或订单确认执行代码。
- 本地敏感文件边界：`storage/*.sqlite`、`config/telegram-settings.json`、`frontend/dist/`、`output/playwright/` 和投注协议 capture 目录加入 ignore；Telegram 配置使用 `config/telegram-settings.example.json` 作为脱敏模板。
- 架构结论：监控、登录、Dashboard、Telegram、配置模块基本分离合理；后续不应继续把协议抓取或投注执行塞进 `scripts/crown-watch.mjs`。

## 2026-07-09 赔率波动报警修复

- 根因：`crown-watch` 报警判断只使用 `config/default-leagues.json` 默认联赛白名单，未把 SQLite 中 active 的手动追踪比赛传给 `evaluateMonitorChange()`；当前比赛多为美国/友谊赛等非默认联赛，所以 0.01 动水也被 `league_not_allowed` 全部挡掉。
- 修复：`evaluateMonitorChange()` 新增 `trackedMatches` 准入，active 手动追踪比赛可绕过默认联赛缺失；`scripts/crown-watch.mjs` 在 XML、WebSocket、DOM 和 direct API 路径读取 `storage/crown.sqlite` 的 tracked matches 并传入报警判断。
- watcher 触发报警后会回写当前模式的 `lastAlertAt` 到 `config/monitor-settings.json`，Dashboard 的“最近触发报警”不再一直显示“无”。
- Telegram 赔率报警配置已启用，Chat ID 为本地配置中的 `6369496282`，token 只保留在 `config/telegram-settings.json`，不在日志或文档记录明文。
- 本机 Node 访问 Telegram Bot API 必须带代理环境：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY=http://127.0.0.1:7897`，`NO_PROXY=localhost,127.0.0.1,::1`，`NODE_OPTIONS=--use-env-proxy`；Dashboard 和 watcher 已按该环境重启。
- 验证：最近 500 条变化回放中 10 条可触发报警；真实 Telegram 赔率变化消息发送返回 HTTP 200；`npm test` 125/125 通过，`npm run check` 通过。

## 2026-07-09 Crown Telegram 通知机器人

- TG 通知借鉴黑猫成熟实现，但皇冠第一版只保留多 Chat ID、群话题、Chat ID 获取、测试发送和固定模板。
- 赔率变化通知由 `crown-watch` 的 `evaluateMonitorChange()` 触发闸门控制，只有命中当前赔率监控设置的变化才发送。
- 通知范围只包括让球和大小球；独赢、单双、yes/no 等 unsupported market 会跳过。
- 模板使用实际队伍名，比赛标题格式为 `主队 v 客队`；大小球变化格式为 `大/小 盘口 旧赔率 -> 新赔率`；让球变化格式为 `实际队伍名 盘口 旧赔率 -> 新赔率`。
- Telegram 配置兼容旧 `chatId`，新配置统一归一成 `chatIds`；群话题格式为 `chatId:threadId`。
- API/UI 不返回明文 token；获取 Chat ID 支持直接使用已保存 token，也支持用户在当前表单临时输入 token，临时 token 不会因获取 Chat ID 被持久化。
- 安全字段保存后不显示空白输入：监控账号密码和 Telegram token 用只读“已保存 + 修改按钮”表达已保存状态，未配置的 token/Chat ID 显示“未设置”。
- Windows 桌面环境访问 Telegram Bot API 时，Node 需要继承本机代理；本机已写入用户环境变量 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 指向 `http://127.0.0.1:7897`，并设置 `NODE_OPTIONS=--use-env-proxy`。

## 2026-07-09 赔率变化记录保留修正

- `/matches` 详情抽屉不能只依赖全局 `/api/changes` 最近 100 条；自动刷新后，其他比赛的新变化会把当前比赛的旧变化挤出全局列表，导致抽屉显示“暂无记录到的赔率变化”。
- 现在 `/api/changes` 支持 `eventKey` 和 `limit` 查询；详情抽屉打开后按当前比赛 `eventKey` 单独读取最多 1000 条历史变化，来源仍是持久化 JSONL，不是前端临时数据。
- 前端按比赛缓存已读取的变化记录；后续 30 秒刷新会合并新记录，不会因为某次全局刷新没有这场比赛就清空抽屉。
- 2026-07-09 06:26 Asia/Shanghai 验证：`/api/changes?eventKey=...&limit=1000` 对“皇家奥鲁罗 vs 宾托”返回 133 条变化；Edge headless 打开详情并等待一次自动刷新后，抽屉仍保留变化记录。

## 2026-07-09 赔率更新异常修正

- `/matches` 之前只在进入页面时读取一次 `/api/matches/leagues` 和 `/api/changes`，所以后台 `crown-watch` 即使按 30 秒继续写 XML，页面上的“最近更新”也不会自动变。
- 数据源卡片之前只看来源是不是 `xml-live`，不判断最后更新时间；这会导致 XML 已经停了十几分钟时仍显示“实时赔率正常”。
- 现在 `/matches` 每 30 秒静默刷新一次赔率 summary、联赛列表和变化记录；刷新时不切换整表 loading，避免页面抖动。
- `SourceStatusCard` 对 XML live 增加 2 分钟过期判断；超过 2 分钟未更新会显示“赔率更新异常”，不再误报正常。
- 2026-07-09 再次修正：健康卡不再只优先使用 `lastXmlAt`，而是从 `lastXmlAt`、`lastSnapshotAt`、`lastCapturedAt` 和 runtime 文件更新时间里取最新值；避免 runtime log 时间偶尔滞后、但快照仍持续更新时误报“赔率更新异常”。
- 2026-07-09 06:15-06:18 Asia/Shanghai 验证：后台 `crown-watch` 按 30 秒写入 XML；Edge headless 打开 `http://127.0.0.1:8788/matches` 后，状态卡从 `06:18:00` 自动刷新到 `06:18:30`。

## 2026-07-09 Crown V1.1 自动登录基础版 + Dashboard 中文瘦身计划（历史快照，诊断许可已失效）

- 开发计划入口：`docs/superpowers/plans/2026-07-09-crown-v1-1-login-dashboard.md`。
- V1.1 目标是确认 `mon_primary` 单账号可以真实自动登录；最新实现优先走 Crown XML 直连接口登录，不再依赖网页登录页点击“否”。
- 直连登录流程：`POST /transform_nl.php p=chk_login` 获取 `uid` 和 response cookies，保存到 `data/runtime/crown-sessions/mon_primary/api-session.json`，再用 `POST /transform.php p=get_game_list` 验证 XML session。
- `scripts/crown-watch.mjs --login-test` 现在走 `CrownApiLoginManager`，成功结果显示 `登录方式：接口登录` 或 `接口缓存`，`storageStateStatus=不适用`，`xmlVerified=true`。
- 正常 watcher 在 `mon_primary` 有账号密码时优先走直连 XML API 轮询；浏览器/Playwright 登录路径保留为无账号凭据或后续诊断兜底。
- 自动登录成功的验收标准不是“有登录代码”，而是 Dashboard 点击“测试登录”后显示 `登录结果：已登录`，并且能看到登录方式、cookies 状态、storageState 状态、XML/页面 session 验证结果。
- 本阶段新增独立登录模块：`src/crown/login/crown-api-login-manager.mjs`、`src/crown/login/crown-cookie-store.mjs`、`src/crown/login/crown-session-detector.mjs`、`src/crown/login/crown-login-diagnostics.mjs`、`src/crown/login/crown-login-manager.mjs`。
- `scripts/crown-watch.mjs` 后续不继续堆登录逻辑；直连接口路径调用 `CrownApiLoginManager`，浏览器兜底路径调用 `CrownLoginManager.ensureLogin()`。
- 测试登录改为独立短跑流程，不依赖长驻 watcher：读取 `mon_primary`、复用或刷新 API session、验证 `get_game_list` XML、保存 LoginResult 后退出。
- 历史许可：用户当时允许本地调试页面/文件展示或保存 cookie、token、密码、账号和 input value。该许可已被 2026-07-11 安全基线取代，当前代码和 API 禁止这些字段，不得按本条恢复明文诊断。
- 历史诊断路径为 `data/runtime/login-diagnostics/YYYYMMDD-HHmmss-mon_primary/`；当前新目录只含安全 `snapshot.json`，不保存 `screenshot.png`。旧目录可能仍含敏感文件，cleanup `--apply` 必须另获用户授权。
- 登录态路径约定：直连 API session 为 `data/runtime/crown-sessions/mon_primary/api-session.json`；浏览器兜底仍可使用 `cookies.json` 和 `storage-state.json`。
- 2026-07-09 真实验收：Dashboard `/monitor-account` 点击“测试登录”后显示 `登录结果：已登录`，登录方式为接口；短跑 `node scripts/crown-watch.mjs --login-test --app-db storage/crown.sqlite --runtime-dir data/runtime --max-seconds 60` 通过。
- 2026-07-09 短时间正常 watcher 验证：直连 API 获取 `get_game_list` XML 成功，`xmlResponses=1`、`getGameListCount=1`、`xmlEvents=39`、`normalizedRecords=695`、`errors=0`。
- 2026-07-09 修正 Dashboard 不显示最新 XML 的根因：`crown-watch` 以前在写 JSONL 快照前先套 `config/monitored-leagues.json` 白名单，导致当前 XML 联赛未命中白名单时 `snapshotWrites=0`，页面回退到旧 DOM 备份数据。现在快照写入最新 XML 的全部非显式排除足球联赛，白名单只影响追踪/提醒状态；显式排除词仍会过滤电竞、虚拟等联赛。
- 2026-07-09 修正“赔率扫描间隔不会自动更新”的根因：Dashboard 进程控制以前在已有 watcher 子进程时直接复用，旧 watcher 可能还停留在浏览器 DOM fallback，持续写 `Target page, context or browser has been closed`，不会重新进入直连 XML API 轮询。现在 `/api/app/monitor-account/actions` 的 `start` 会显式重启 watcher，确保重新读取 SQLite 账号、密码和扫描间隔。
- 2026-07-09 盘口采集边界收窄：XML 主源、DOM fallback 和 JSONL 存储层只保留 `asian_handicap` 让球与 `total` 大小球；独赢、单双、yes/no、球队大小和 unknown/other 不再写入新快照或新变化记录。`/matches` 详情抽屉也按同一口径过滤旧变化记录，只显示变化时间、类型、变化项目、变化前和变化后。
- Dashboard 中文瘦身目标：普通比赛页不再展示 `source=...`、`oddsId=null / not available`、`disabled-preview-only`、`recordCount` 等调试字段；数据源卡片改为“实时赔率正常 / 使用备用数据 / 离线样本”。
- 前端新增 `frontend/src/utils/crownLabels.ts` 和 `frontend/src/utils/formatDateTime.ts`，统一把 `live/prematch/asian_handicap/moneyline/total/home/away/over/under` 等英文值转成中文，并把 ISO 时间显示为 `YYYY-MM-DD HH:mm:ss`。

## 2026-07-08 Crown Monitor Account and Tracking Split

- 新增单一“皇冠监控账号”配置位，入口为 Dashboard `/monitor-account`；第一版只允许一个启用中的监控账号。
- 密码字段保存后不会回显明文；UI 通过 `密码状态=已保存` 和 `hasSecret=true` 表示已保存。
- 监控账号网站地址允许填写裸域名，例如 `m407.mos077.com`；保存和读取时会自动补成 `https://m407.mos077.com`。
- Dashboard `/monitor-account` 的 `开始监控`、`测试登录`、`手动重新登录`、`停止监控` 已接入本地 `crown-watch` 进程控制，不再只是改数据库状态。
- 监控账号保存网站地址、账号、密码、备注、启用状态、登录/在线/XML/赔率解析时间、连续失败次数、当前监控状态、赔率扫描间隔、自动重登次数和最大自动重登次数。
- 账号密码使用本地自动生成的 AES-256-GCM 密钥加密保存；默认密钥文件为 `storage/crown-local-secret.key`，用户不需要手动配置 `CROWN_SECRET_KEY`。API/UI 只返回 `hasSecret`，运行时 watcher 才通过本地 repository 解密读取。
- `scripts/crown-watch.mjs` 当前优先使用启用中的监控账号走 `CrownApiLoginManager` 直连 XML API 登录和轮询；旧的打开网站、填写账号密码、提交登录路径保留为浏览器兜底和页面诊断。遇验证码、滑块或二次验证仍标记 `等待人工验证码` / `需要人工处理`，不绕过人机验证。
- watcher 可检测 `Welcome 页面`、登录失效、网络异常、XML 无响应和赔率解析无数据；掉线后最多自动重登 3 次，次数可配置。
- 赔率扫描间隔由监控账号 `oddsScanIntervalSeconds` 控制；命令行 `--dom-poll-seconds` 显式传入时优先生效。
- 每次赔率写入 JSONL 时会与上次结果比较；达到监控设置里的水位/赔率变化阈值时，`odds-change` 会标记为 `candidate=true` 并写入原因、方向、阈值和变化值。
- 比赛选择页 `/matches` 只保留“今日追踪比赛”和“今日全部比赛”；默认联赛白名单拆到独立 `/default-leagues` 页面。
- 默认联赛只按皇冠内部联赛名字 `name` 精确匹配；`aliases` 不再参与默认联赛匹配，包含匹配和模糊匹配都不使用。
- `maxTrackedLeagues` 和 `maxTrackedEvents` 已从监控设置默认值、归一化结果、默认配置和前端表单中移除。
- 今日全部比赛优先使用 XML live runtime snapshots；只有没有 XML live 数据时才使用 DOM fallback / fixture fallback。

## 2026-07-08 Crown Transform XML Source Confirmed

- Authenticated read-only POST validation against `m407.mos077.com` confirmed the correct odds source is Crown XML, not gismo JSON and not DOM-only.
- Login endpoint: `POST /transform_nl.php p=chk_login` returns a session `uid`; this is secret material and must not be logged raw.
- Odds endpoint: `POST /transform.php p=get_game_list gtype=ft showtype=today rtype=r ltype=3 filter=MIX` returns football `<game>` XML with real Crown ids and odds fields.
- Real ids found: `GID`, `GIDM`, `HGID`, `ECID`, `LID`.
- Odds fields found: `RATIO_R/RATIO_RE`, `IOR_RH/IOR_RC/IOR_REH/IOR_REC`, `RATIO_OUO/RATIO_ROUO`, `IOR_OUH/IOR_OUC/IOR_ROUH/IOR_ROUC`, `IOR_MH/IOR_MC/IOR_MN`, `IOR_RMH/IOR_RMC/IOR_RMN`.
- Explicit provider `marketId`, `selectionId`, and `oddsId` are still not present in the sampled XML; normalized ids remain local composite ids and `oddsId=null`.
- `src/crown/crown-transform-xml.mjs` normalizes transform XML; `scripts/crown-watch.mjs` can ingest page runtime XML responses; `scripts/crown-probe.mjs` saves redacted XML/text samples under `text-responses/`.
- Real sample verification: `output/verification/crown-transform-live-2026-07-07_230927/get-game-list-today.xml` normalized to 161 records across 12 non-esports football events and wrote `normalized-snapshots.jsonl`.

## 2026-07-08 Crown XML Monitor Stabilized

- Source priority is now: `transform.php text/xml` primary, DOM fallback / cross-check, fixture replay for tests.
- XML parser outputs `eventKey`, `marketKey`, `selectionKey`, `oddsField`, `ratioField`, parsed `handicap`, `odds`, and `isMainMarket=unknown` when no provider main-market flag is proven.
- `marketId` and `selectionId` are local keys, not provider betting ids; `oddsId` remains `null`.
- XML fixture directory: `data/fixtures/crown/transform-xml`.
- Change detection supports `odds-change`, `handicap-change`, `market-suspended`, `market-reopened`, `event-added`, and `event-removed`.
- `crown-watch` runtime log writes XML counters: `xmlResponses`, `getGameListCount`, `getGameMoreCount`, `xmlEvents`, `normalizedRecords`, `snapshotWrites`, `changeWrites`, `parseErrors`, `emptyXmlResponses`, `loginExpiredResponses`, `lastXmlAt`, `lastSnapshotAt`.
- Dashboard `/matches` 普通页面只显示中文数据源摘要，不再展示 `oddsId=null / not available`、`disabled-preview-only`、`recordCount` 等调试字段。

## 历史：2026-07-08 当时目标

该历史阶段用于研究并实现“皇冠抓水投注”的本地完整流程，当时优先完成皇冠页面采集、足球赔率监控、筛选和变动识别；自动下注、盘口点击、金额填写、注单提交当时属于后续投注执行模块。该阶段目标已经完成并被后续实现取代，不得替代文首唯一权威实施计划 `docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md`。

## 该历史阶段已确认决策

- 皇冠登录优先使用 `transform_nl.php` / `transform.php` XML 直连接口和 `api-session.json`；Playwright 页面登录只保留为采集、兜底诊断和未来页面级验证路径。
- 第一阶段工具只采集 DOM、Network、JSON 响应和截图。
- 点击盘口、金额填写、提交投注请求当时属于后续投注执行模块；该阶段先完成数据源、字段、登录和监控闭环。
- 采集结果保存到 `data/crown-probe/`。
- 当时固定 fixture：`data/fixtures/crown/20260708_004011`。
- 监控目标不是全部足球比赛，而是通过 `config/monitored-leagues.json` 只监控指定联赛；未配置联赛默认忽略。
- 投注部分当时先完成架构、数据契约和安全边界预留，点击盘口、填写金额和提交订单计划在后续执行模块中继续开发。
- 当时的开发计划入口为 `docs/superpowers/plans/2026-07-08-crown-football-monitor.md`。
- 当时的 Dashboard 开发计划入口为 `docs/superpowers/plans/2026-07-08-crown-dashboard.md`。
- 当时的产品化改造计划入口为 `docs/superpowers/plans/2026-07-08-crown-product-redesign-react.md`；后续已按黑猫监控风格使用 React 18 + Vite + Ant Design 5 改造皇冠 UI，并使用 SQLite 保存本地配置。以上三份 2026-07-08 计划均为历史入口，不得替代文首唯一权威实施计划。

## 2026-07-08 皇冠足球监控阶段状态

- 当前真实赔率主源来自 `POST /transform.php` `text/xml`；`football-today-filtered.json` DOM 结果用作 fallback / cross-check。
- `json-responses/` 暂未发现明确 bookmaker odds market/price 结构，主要是 BetRadar 风格比赛资料、时间线、统计和翻译。
- 原始 fixture 包含赛前足球 20 场、滚球足球 18 场；其中 1 场滚球 DOM 文本没有赔率数字。
- 白名单回放结果为赛前 10 场、滚球 5 场，标准赔率记录 175 条。
- Runtime JSONL 输出：
  - `data/runtime/crown-odds-snapshots.jsonl`
  - `data/runtime/crown-odds-changes.jsonl`
- 赔率 audit source 仍是 JSONL；产品化 Dashboard 的比赛追踪、账号和规则配置已使用 SQLite。

## 2026-07-08 皇冠监控 Dashboard 状态（历史部署快照）

- 本地 Dashboard 默认 Docker 命令：`npm run crown:dashboard:docker`。
- 本机 Node.js 调试命令：`npm run crown:dashboard`。
- 默认地址：`http://127.0.0.1:8787`。
- 当时 Docker 容器内绑定 `0.0.0.0:8787` 并挂载宿主 `data/runtime`、fixture 和 `config`。当前 Compose 已改为宿主 `127.0.0.1:8787` 与 runtime/config/storage named volume，Dockerfile 只 COPY 明确公开 config/fixture 文件；不要按本条恢复旧 bind mount。
- Docker Compose project name 固定为 `crown-dashboard`，避免中文目录名导致 Compose project name 为空。
- Dockerfile 默认基础镜像使用 `m.daocloud.io/docker.io/library/node:22-alpine`。
- Dashboard 读取 monitor JSONL、fixture fallback 和 `config/monitored-leagues.json`；数据源显示区分 `XML live`、`DOM fallback`、`fixture replay`。
- Dashboard 使用 React 18 + Vite 8 + Ant Design 5，左侧七个页面：`比赛选择`、`默认联赛`、`皇冠监控账号`、`赔率监控设置`、`下注规则设置`、`投注账号配置`、`设置`。
- Dashboard 新增 `src/crown/app/`，用 `node:sqlite` 保存 tracked matches、monitor accounts、monitor rules、betting rules、betting accounts 和 betting history。
- Dashboard 新增本地 JSON 配置：`config/default-leagues.json`、`config/monitor-settings.json`、`config/telegram-settings.json`。默认联赛、监控模式互斥状态、Telegram 机器人配置保存到这些 JSON 文件。
- `/matches` 默认按联赛聚合，不逐场展开；详情抽屉展示联赛下比赛明细。
- `/monitor-settings` 改为让球监控和滚球监控两张卡片，`handicap` 与 `live` 同时只能运行一个。
- `/settings` 独立配置 Telegram 赔率报警机器人和投注成功通知机器人，API/UI 不返回明文 token。
- SQLite 默认 Docker 路径为 `/app/storage/crown.sqlite`，Compose volume 为 `crown-storage:/app/storage`；本机调试默认路径为 `storage/crown.sqlite`。
- 账号 secret 会自动用本地密钥 AES-256-GCM 加密保存；API 只返回 `hasSecret`，不返回明文或密文。
- 2026-07-08 阶段下注规则以 `previewOnly = true` 保存为预览/配置数据；2026-07-09 起 `previewOnly` 已改为可配置字段。
- Dashboard 监控账号页已接入 watcher 启停控制；真实下注执行、自动金额输入和提交交互属于独立投注执行模块，不能放进 watcher。
- 当前旧 API：`/api/health`、`/api/summary`、`/api/events`、`/api/changes`、`/api/config`。
- 2026-07-08 当时的新 API 包含 `/api/app/betting-rules` 等端点；这是历史清单。当前规则 mutation 使用 `/api/app/auto-betting-rule-cards` 与 `/:cardId`，今日选项使用 `/api/app/today-betting-leagues`；旧 betting-rules mutation 已 retired/410。
- 2026-07-08 验证结果：`npm test` 24 项通过，`npm run check` 通过；API 检查 5 个 endpoint 均返回 200；浏览器验收显示 15 个事件、live 筛选 5 个事件、搜索命中 1 个事件、窄屏无页面级横向溢出、控制台无错误。
- 2026-07-08 产品化改造验证结果：`npm test` 38 项通过，`npm run check` 通过，`npm --prefix frontend run test` 5 项通过，`npm --prefix frontend run build` 通过，`npm --prefix frontend audit --audit-level=moderate` 0 vulnerabilities；Docker build/start 通过；`/api/health`、`/api/app/bootstrap`、`/api/events` 均返回 200；浏览器验收通过四页导航、比赛追踪持久化、监控配置持久化、下注规则 preview-only、投注账号 secret 不外露、桌面和窄屏截图检查；安全扫描未命中真实下注执行关键词。
- 2026-07-08 本次 Dashboard 配置改造验证结果：`npm test` 50 项通过，`npm run check` 通过，`npm --prefix frontend run test` 8 项通过，`npm --prefix frontend run build` 通过；Playwright/Edge 验收通过 `/matches` 联赛聚合和详情抽屉、`/monitor-settings` 互斥启动、`/settings` Telegram token 掩码，控制台无错误。

## 运行方式

- 安装依赖：`npm install`
- 安装前端依赖：`npm --prefix frontend install`
- 运行测试：`npm test`
- 语法检查：`npm run check`
- 运行采集器：`npm run crown:probe`
- 分析 fixture：`node scripts\crown-analyze-network.mjs data\fixtures\crown\20260708_004011`
- 回放 fixture：`node scripts\crown-replay-fixture.mjs data\fixtures\crown\20260708_004011`
- 离线验证 watcher：`node scripts\crown-watch.mjs --from-fixture data\fixtures\crown\20260708_004011`
- 运行 watcher：`npm run crown:watch`
- 测试登录短跑：`node scripts\crown-watch.mjs --login-test --app-db storage\crown.sqlite --runtime-dir data\runtime --max-seconds 60`
- Docker 运行本地 Dashboard：`npm run crown:dashboard:docker`
- Node.js 调试运行 Dashboard：`npm run crown:dashboard`
- 非提交投注协议抓包：`npm run crown:betting:capture -- --url https://m407.mos077.com --profile data/crown-profile`
- 脱敏抓包分析：`npm run crown:betting:analyze -- data\runtime\betting-protocol-captures\<run>`
- 前端测试：`npm --prefix frontend run test`
- 前端构建：`npm --prefix frontend run build`

## 风险边界（历史记录；当前边界见文首与主架构）

- 输出数据可能包含页面业务数据，不能公开分享。
- V1.1 曾允许本地登录诊断保存和展示 cookie、token、authorization、set-cookie、账号、密码和 input value；该历史许可已失效。当前诊断写入与 API 输出必须使用安全摘要，旧文件只可通过先 dry-run、再经用户授权的 cleanup `--apply` 处理。
- 投注协议 private 抓包可能包含本机认证请求材料，只能保存在 ignored runtime 路径；公开文档只能引用脱敏 public 输出。
- 自动下注会在采集字段、接口、登录态和风控边界稳定后单独设计；当前仓库尚未接入 Dashboard 下单提交器或 `CrownBetAdapter`，后续继续开发。

## 2026-07-08 实时数据源审计

- 数据源审计入口：`docs/crown-runtime-source-audit.md`。
- 历史真实采集样本仍未确认稳定 Crown 赔率 JSON endpoint；`gismo/*` 是比赛资料、统计、翻译或时间线，不是盘口赔率源。
- 当前没有持久化 WebSocket frame 样本可证明存在可用赔率流。
- `scripts/crown-watch.mjs` 优先接入 `transform.php` XML；DOM watcher 保留为 fallback / cross-check。
- `src/crown/dom-football-extractor.mjs` 是 `crown-probe` 和 `crown-watch` 共用的 DOM 赛事识别入口，但不是当前主赔率源。
- 字段真实性结论：XML `GID/GIDM/HGID/ECID/LID` 是真实 Crown runtime ids；`marketId`、`selectionId` 是 local key；`oddsId=null`；`handicap` 由 `RATIO_*` 解析；`odds` 来自 `IOR_*`，仍不能当真实下单字段。
- 2026-07-08 05:39 Asia/Shanghai 使用当前 `data/crown-profile` 验证真实页面：页面停在 `Welcome`/加载页，DOM 赛事数为 0，无法从当前页面验证实时赔率写出；fixture 路径可写出 175 条 snapshots；最终实时短跑 `errors=0`。
# 历史：2026-07-12 C stage completion and stable boundary

- C Tasks 1-11 已完成代码与离线验收。最终 integration 使用 fresh temp SQLite 和 fake provider 验证 monitor change、priority winner、one-market claim、60+40、changed line、accepted/rejected/unknown、pause queue drain 和 restart。
- 所有 C 阶段规则（包括迁移后的 legacy template）都按 canonical columns 判断，不再通过 ID 前缀推断语义；真实资格统一要求 monitor/real 开启、未归档且迁移审核完成。Canonical direction 固定 reverse，执行赔率边界取 `target_odds_min/max`，rule version 原样进入 batch snapshot，并在 B2 prepare/dispatch 前持续复核。
- `rejected` 永不转投；`unknown` 永不自动重投并持续占用锁。暂停只阻止新分配，已有队列排空后转 `paused`。
- Persistent intent 重启后总是回到 `armed_waiting/preflight-required`，不从旧 PID 或旧 running 状态推断可运行。
- 该历史 C stage 当时的 verified matrix 为 `crown-protocol-capabilities-v2:23628f891d1edb9a`，Preview/Submit/Reconciliation `0/0/0`；当前 matrix 与 capability 以顶部 Task 3 的 `8/1/0` 为准。
- 2026-07-12 最终 gates：backend `874/874`；syntax `180`；frontend `66/66`；build/Compose 通过；最终独立审查 0 Critical/Important/Minor、代码 Ready。Browser 只用临时 DB/fake checker，1036/390 无溢出、console 0 error/warning、请求仅 localhost。
- 未迁移或写入 live DB，未调用 Crown preview/submit/reconciliation，未 Git commit/stage。

# 2026-07-12 全量体检、历史清理与每日完全重置

- 18.46GB 主库的根因是 `monitor_audit_outbox` 保留 3,991,817 条已投递事实副本，占库 99.77%；v2 snapshot/change JSONL 另占 13.34GB，旧 v1 历史约 1.93GB。
- 用户确认日常模式为：每天上班前手动执行一次完全重置；不允许自动、定时或启动清理。重置删除点击前所有赔率、监控、候选、投注账本、market-once 幂等锁、pending/unknown、提交/对账、通知、执行审计、追踪比赛、日志、索引、浏览器普通缓存和验收产物。
- 重置永久保留监控账号、投注账号、加密凭据、登录会话、规则、Telegram 配置、协议抓包、fixture、程序代码、`node_modules`、`frontend/dist` 和其他运行依赖。真实投注 runtime 重置为 off；旧盘口在新一天允许重新建立一次投注锁。
- `/operations` 新增“每日开工完全重置”预览与二次确认。受管 betting worker 先停止且不自动恢复；受管 watcher 安全停止并在清理后恢复。活跃的手动 watcher 会使清理 fail-closed。
- `monitor_audit_outbox` 现在只承担 pending outbox；JSONL sink 确认后同一事务删除已投递行，不再积累 delivered 副本。Dashboard 每秒 runtime tick 与 watcher 高频状态更新使用不执行 schema/migration 的轻量 SQLite 连接。
- 本次已清除约 35.11GB；live SQLite 从 18,455,048,192 bytes 缩至 380,928 bytes。保留 2 个投注账号、3 条数据库规则、1 个监控账号和协议证据；全部运行/历史表、幂等锁、pending/unknown/对账和 tracked matches 均为 0，integrity_check=ok、foreign_key_check 无违规。
- 最终新鲜验证：backend 882/882、syntax 182 `.mjs`、frontend 66/66、production build、Compose `-p crown-dashboard config` 全部通过；1036/390 运维控制台显示完整重置按钮和风险提示。Dashboard 已运行在 `http://127.0.0.1:8787`，持续 tick 后页面/API 仍返回 200。

# 2026-07-12 安全开工与运行控制台重构

- 用户确认“安全开工”：每日完全重置后，只要监控账号已启用且存在加密凭据，就自动启动 watcher；所有投注账号转为 `paused`，全局真实投注强制为 `off/requested=0`，规则配置保持不变。
- 监控账号曾发生整行列错位：有效 v1 密文落入 `enabled`，扫描间隔和重登次数被时间字符串占用。已用本机密钥只读确认密文可解，生成 `storage/backups/crown-before-monitor-repair-20260712-122522.sqlite` 后无损修复。修复后登录成功、watcher 单实例在线、赔率 freshness 为 fresh。
- `/operations` 改为浅色清爽操作台，按“赔率监控 → 策略规则 → 投注账号 → 全局真实投注”展示四段 readiness 与稳定阻断原因。监控和真实投注都只显示当前可执行的一个按钮；0 风险不再渲染红色主面板；每日重置移至底部维护工具。
- `/betting-accounts` 明确“启用账号只加入订单分配，不会开启全局真实投注”，卡片只显示“启用账号”或“暂停账号”。检测账号保持独立，检测成功不自动启用。
- 投注账号页不再调用包含全部赔率历史的 `/api/app/bootstrap`，改为并行读取轻量 `/api/app/betting-accounts` 与 `/api/app/betting-history`。在当前约 444MB runtime 历史下，浏览器从超过 10 秒超时并误报空列表恢复为约 1.5 秒显示两个账号；加载中显示明确读取状态。
- 该历史验收结果为 backend 883/883、syntax 182、frontend 68/68、production build 通过；Chrome/Edge 实机验收桌面与手机宽度无页面横向溢出，工作台四段链路、0 风险中性状态、账号说明和两个暂停账号均显示正确。当时真实投注保持关闭，Crown canonical capability 为 `0/0/0`；当前值以顶部 Task 3 的 `8/1/0` 为准。

## 2026-07-12 Dashboard 超时与账号启用错误修复
- `csrf-invalid` 的根因是 Dashboard Session 依赖大型 `/api/app/bootstrap` 取得 CSRF；赔率历史增长后该请求可能超过前端 10 秒超时，导致写操作没有新 token。新增轻量 `/api/app/security-context`，并且 mutation 收到一次 `csrf-invalid` 时只刷新安全上下文并安全重试一次。
- `/auto-bet-rules` 不再为联赛下拉读取带完整赛事的 `/api/matches/leagues`；新增 `/api/app/league-options`，直接合并 SQLite 当前联赛、已配置规则联赛和启用的默认联赛。实机规则页约 1.1 秒完成显示。
- 两个现有投注账号不能启用的实际业务阻断是 `perBetLimit=0`，不是登录失败。账号启用要求整数 CNY 单笔上限大于 0；页面现在直接显示“单笔上限必须大于 0，编辑后才能启用”，不再允许点击后得到模糊 `server-error`。具体金额必须由用户决定，程序不代填；测试中的 `50 CNY` 仅为测试配置，不是生产默认值或统一硬上限。
- 实机重新启动 watcher 后，监控账号已登录、Watcher 单实例在线、赔率 freshness 为 fresh；投注账号仍暂停，全局真实投注保持关闭。

# 2026-07-13 页面性能与 Checkbox 修复

- `/matches`、默认联赛和监控设置页面已切换为 SQLite `monitor_event_state`、`monitor_selection_state`、`monitor_scope_state` 当前投影；legacy `/api/events`、`/api/summary`、`/api/changes` 的 JSONL 审计语义未改。
- 当前投影使用只读 transaction，按主 DB+WAL 文件版本缓存；WAL-only scope/selection/event commit 会立即失效。页面 GET 不再调用 `openAppDatabase()` 重复执行 schema/migration，tracked matches 使用同一 effective DB 的 read-only repository。
- `/matches` 首屏和 30 秒刷新只调用 league summaries；详情 Drawer 打开后才按 eventKey 请求变化历史。列表/详情分别 single-flight，后台刷新保留缓存且无 Spin blur，关闭/切换赛事后的迟到响应不会污染当前 Drawer。
- Checkbox 根因已通过 `.settings-form-grid > label` 修复，保留 `.checkbox-field`；contract 禁止对 `.ant-checkbox-inner` 增加定位或 physical/logical size 补丁。
- 隔离 8799 + 正式库克隆 + 当前 build 验收：cold P95 499.8ms、warm P95 79.2ms、菜单 20 次 P95 615.2ms；30 秒列表请求并发最大 1、global changes=0、blur=0；1920/1024/390 三档 7 个 Checkbox 均 16×16、无横向溢出、console 0。
- 当次正式 8787 与 watcher 均未运行，遵守“不重启正式服务”约束；上述数据不能替代持续写入正式环境复核。正式库、账号、worker 和真实网络均未修改。

# 历史：2026-07-13 页面体验与真实投注完备计划（已被 Task 10 与新计划取代）

- 当时开发计划入口为 `docs/superpowers/plans/2026-07-13-crown-ui-performance-and-live-betting-readiness.md`。计划同时覆盖页面切换性能、Checkbox 对齐，以及真实投注剩余的 canonical preview/submit/reconciliation 证据、生产 Provider/对账、动态卡资格/授权和最终受控小额验收。
- B1/B2 账本、账号锁、ExecutionAuthorization、fenced Worker、unknown 不重投、reconciliation/outcome outbox、C runtime、安全开工与动态卡片当时均视为已完成前置，不重复实施。该历史计划形成时的真实投注 capability 为 `0/0/0`、runtime off；当前值以顶部 Task 3 的 `8/1/0` 为准。
- 真实投注 Task 7、8、12 是三个独立硬停点；每次必须由用户在执行当次重新确认。无授权时系统保持 fail-closed，旧 real CLI 永久不恢复。

# 历史：2026-07-13 Canonical 协议证据准备（已被 Task 10 evidence 取代）

- Task 6 已离线完成：`protocolVersion` 只信任当次成功 production login response，strict betting session 磁盘缓存不能持久化或恢复其 verified provenance；Preview 会要求 fresh version refresh。
- Canonical preview 证据使用 exact non-sensitive field set，transport `uid` 仅计数后排除；extra、任意重复 XML tag、未知敏感字段均使证据 invalid。Response field set 漂移同样 fail-closed。
- request/response 通过原 Request sequence 精确配对；event/line/side/stake 使用私有 32-byte 以上 key 的 HMAC linkage，公开产物不含原值、key、raw body、ticket、origin 或绝对路径。
- 当时 focused `86/86`、相关 `96/96`、backend `1092/1092`、security `5/5`、syntax `217` 已通过；最终独立复审 0/0/0。该历史阶段的 canonical matrix Preview/Submit/Reconciliation 为 `0/0/0`；当前值以顶部 Task 3 的 `8/1/0` 为准。当时未访问真实网络、正式 DB/服务、账号或 Git。

# 2026-07-13 Windows Portable 与 GitHub 源码发布（发布方式已更新）

- Windows 10/11 x64 的交付形态确定为 Portable ZIP：内置 Node.js 与 Chromium，用户双击手动启动，保留可见运行窗口；不安装 Service、不设开机启动，Watcher 只能从 Dashboard 手动启动。
- 首次运行把 118 项默认联赛白名单复制到用户数据目录，后续启动和手工换版不覆盖用户修改。账号、密码、session、SQLite、浏览器 Profile 和日志永不进入发行物或 Git 仓库。
- 当前发布方式以上方 2026-07-14 记录为准：CI 只构建 unsigned 审计产物，维护者手工发布完整 Portable ZIP，用户在新目录手工换版；旧远程 updater 方案已废弃。
- Windows launcher 与 fault-injection 测试会启动真实 PowerShell/Node 子进程。文件级并发会造成端口、进程回收和恢复用例之间的非确定性干扰，因此全量 backend 测试固定使用 `--test-concurrency=1`；相关用例单独运行和串行全量运行都必须通过。
- 正式 backend 验证必须使用发行物锁定的 Node `22.23.1` 再跑一遍。被当前业务 `await` 的发送/对账 timeout 不能 `unref`；Windows 受控路径按文件系统 identity 判定同一对象，允许合法 8.3 短路径别名，但仍拒绝 symlink/junction。该约束用于消除开发机 Node 25 与 GitHub Windows runner 的行为差异。
- Watcher 运行时配置热重载按文件内容 SHA-256 判定变化，不依赖 Windows `mtime`；同一时间戳内的覆盖写入也必须被发现，解析失败继续保留 last-known-good 并在后续轮询重试。
- 源码公开前已按 allowlist 清理：不包含截图、平博程序、运行数据库、凭据、浏览器资料或旧投注 CLI。最终可下载 Release 仍要求实际发行物审计和 Fresh Windows 10/11 x64 验收证据，不能把 GitHub 源码 ZIP 或 Actions artifact 当作用户可运行包。
## 2026-07-15 非投注收尾修复

- 每日完全重置会同时清除 `crown_browser_acceptance_cases` 和 `crown_browser_acceptance_campaigns`，避免旧验收 campaign 阻塞下一轮验收；账号、规则、凭据和登录资料仍保留。
- 清理后恢复 Watcher 时，只有同一 lease key 的有效 lease PID 与刚启动的托管子进程 PID 完全一致，才报告健康；外部进程抢占不会被误认成恢复成功。
