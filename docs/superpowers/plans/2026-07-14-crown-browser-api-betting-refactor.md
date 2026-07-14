# 皇冠浏览器内 API 投注重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 把现有正式下注从 Node 直接 HTTP 改为 Playwright 持久浏览器会话内 API，建立程序内版本化盘口字段库，完成赛前/滚球全场让球与大小球八个方向各一笔平台最小金额 accepted 验收，并让前端、监控、恢复、测试和 GitHub 正式版本全部匹配新架构。

**Architecture:** 保留 Watcher、Signal、规则卡、SQLite 账本、账号锁、B2 exactly-once、unknown 不重投和通知链；只替换投注账号会话及 Preview/Submit/Reconciliation 传输层。单个 canonical betting worker 按账号懒加载独立 persistent Chromium context，在页面内通过 page.evaluate(fetch) 调用已验证接口。静态接口与字段写入现有 capability matrix 和脱敏 fixtures；动态赛事、盘口、赔率、限额、余额、Cookie、Token 与 protocol version 每次现场刷新。

**Tech Stack:** Node.js 22、ESM、Playwright 1.61.1、SQLite、node:test、React、TypeScript、Ant Design、Vite、PowerShell、GitHub CLI。

## Global Constraints

- 最终正式 Preview、Submit 和 Reconciliation 只能使用 browser-page-fetch；禁止 Node global fetch、Playwright request context 和 UI click 作为生产 Submit。
- 每个投注账号使用独立 hashed persistent profile 和独立 profile lease；监控账号与投注账号不得共享 Cookie、LocalStorage、UID 或 Profile。
- 继续保留现有 B2 durable attempt、SQLite child ledger、账号锁、executor lease、fencing token、一次 Submit 和 unknown 不重投。
- 三个未验证 family 不得为了验收提前设置 submitAllowed=true；不进入正式 Portable 的 acceptance initializer CLI 只能创建 HMAC-bound SQLite campaign，随后由正式 canonical betting worker 通过同一 Browser+B2 链消费 blocked-request candidate。Dashboard API、环境变量和普通运行模式都不能创建或激活验收 campaign。
- Submit 网络开始前可以重新定位新鲜候选；Submit 网络可能开始后，超时、断线、浏览器崩溃或响应不完整全部进入 unknown，禁止换盘或重复该方向。
- 八个最终能力固定为：赛前/滚球 × 全场让球 home/away × 全场大小球 over/under；不在本计划中扩展半场或 alternate line。
- 最终真实验收每个方向使用当次 Preview 返回的平台最小金额，串行执行；删除旧计划中的 5 batch、500 CNY 等累计测试上限，但保留账号 perBetLimit、平台 min/max、币种和余额校验。
- 原始抓包、账号、密码、Cookie、UID、Token、完整注单号、浏览器 Profile、数据库和绝对用户路径不得进入 Git。
- 工作区已有大量用户改动；禁止 reset、checkout 丢弃、批量格式化或 git add -A。每次只 stage 本阶段明确文件。
- 监控主链不重构：scripts/crown-watch.mjs、src/crown/monitor/ 的生命周期、赔率变化、Signal、Telegram 与 SQLite 语义保持不变；只补共享标准化字段和投注候选边界。
- 前端复用现有 /operations、/betting-accounts、/betting-rules，不新增重复的验收产品页面。
- 发布到现有 Austin-C1/hg- 仓库并更新其默认分支和 latest Release；不得新建独立仓库，也不得用 force push 作为默认替换方式。

---

## 完成定义

只有同时满足以下条件才算完成：

1. 正式 Worker 的 Preview、Submit、结果查询全部显示 transportKind=browser-page-fetch。
2. 程序内字段库包含八个 side-aware capability，能直接把 canonical selection 映射为已验证的实际 Crown wire，不再每次重新猜字段。
3. 每次下注仍从监控索引和浏览器现场数据取得当前 gid、盘口、赔率、上下限、余额和会话字段，不使用过期动态数据。
4. 八个方向分别取得一笔 direct accepted，并有唯一 B2 child/attempt、一次 dispatch、平台返回标识摘要和只读结果查询证据。
5. 最终成功 campaign 为 acceptedCount=8、uniqueDirectionCount=8、unknownCount=0、duplicateAttemptCount=0、uiSubmitCount=0、nodeFetchSubmitCount=0；任何先前失败 campaign 与额外 dispatch 仍完整保留并已对账。
6. Dashboard 能显示浏览器执行模式、账号会话、八方向能力、阻断原因和 unknown 风险；人工登录可用，浏览器会话的停止与重启统一由 Operations 全局 Worker 控制。
7. 后端、前端、浏览器 E2E、完整构建、Portable、release audit、敏感信息扫描和启动/停止/重启体检全部通过。
8. 完成代码替换现有 GitHub 默认分支，v0.2.0 Release 成为 latest；旧 Release 仅保留回滚用途。

## 字段库的保存方式

现有 src/crown/betting/crown-capability-matrix.mjs 直接升级为程序内权威协议库，不再建立第二套重复配置。

Worker 启动时一次性校验 capability version 与 safe evidence digest，并把八个方向预编译成只读 Map；运行中通过 mode|period|marketType|lineVariant|selectionSide 五维 key 直接 O(1) 取 endpoint 和 wire 模板。每个账号第一次成功登录后持续复用同一个 context/page/session，不为下一笔下注重新开浏览器、重新抓包或重新走 DOM 按钮。

| 数据 | 保存位置 | 运行策略 |
|---|---|---|
| Preview/Submit/Result endpoint 与函数名 | capability matrix | 版本化固化，field-set 漂移时阻断 |
| gtype、wtype、rtype、chose_team、f、isRB 等映射 | capability matrix 的 mapperEvidence | 按八个方向读取，不在运行时猜测 |
| request/response exact field set 与 parser 语义 | capability matrix + strict parser | 固化并用 fixture 回归 |
| 每方向 evidence digest、capture schema、支持状态 | capability matrix（运行时）+ data/fixtures/crown/betting-protocol/（仅测试证据） | 运行时自包含；fixture 只做脱敏回归 |
| gid、赛事、当前盘口线、odds、min/max、余额、con、ratio、timestamp | 不进入静态库 | 每次 Preview/Submit 前现场读取 |
| Cookie、LocalStorage、设备可信状态 | Chromium profile 自行持久化 | 不导出 storageState，不写日志/Git |
| UID、动态 ver、protocol evidence、context generation | 当前 Worker 进程内存 | 新 context 必须重新登录验证，绝不写 Profile/JSON/SQLite |

因此运行时可以跳过“从零寻找接口和字段”，但不能跳过“找到今天这场比赛的当前盘口”和“下注前重新 Preview”。快速路径固定为：

~~~text
Monitor active market index
  -> exact gid/mode/market/side/line candidate
  -> browser fresh game/list lookup
  -> versioned protocol library maps wire fields
  -> fresh FT_order_view
  -> B2 durable attempt
  -> one browser-page FT_bet
  -> direct result + exact reconciliation
~~~

## 八方向键

~~~javascript
export const CROWN_BROWSER_TARGETS = Object.freeze([
  'prematch|full_time|asian_handicap|main|home',
  'prematch|full_time|asian_handicap|main|away',
  'prematch|full_time|total|main|over',
  'prematch|full_time|total|main|under',
  'live|full_time|asian_handicap|main|home',
  'live|full_time|asian_handicap|main|away',
  'live|full_time|total|main|over',
  'live|full_time|total|main|under',
])
~~~

每个 capability 必须单独携带 selectionSide、mapperEvidence、Preview/Submit/Reconciliation 三段证据。任何一侧证据不得开启另一侧。

---

### Task 1: 固定新计划为唯一执行入口并建立基线

**Files:**

- Create: docs/release-source-scope-v0.2.0.md
- Create: release/source-include-v0.2.0.txt
- Modify: docs/superpowers/plans/2026-07-14-crown-betting-remaining-work-roadmap.md
- Modify: docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md
- Modify: docs/superpowers/plans/2026-07-14-crown-betting-controlled-live-acceptance.md
- Modify: docs/superpowers/plans/2026-07-14-crown-betting-reconciliation-and-capability-expansion.md
- Modify: docs/superpowers/plans/2026-07-14-crown-full-validation-and-github-release.md
- Verify: docs/project-memory.md
- Verify: docs/module-index.md

**Interfaces:**

- Consumes: 当前脏工作区、现有 1/1/0 capability、B1/B2 已通过测试。
- Produces: include/exclude/superseded 源码清单、一份基线测试结果、旧计划顶部的 Superseded 引用，以及隔离实施 worktree。

- [ ] **Step 1: 记录工作区而不改动现有文件**

Run:

~~~powershell
git status --short
git diff --name-status
git ls-files --others --exclude-standard
~~~

Expected: 输出作为本轮 source allowlist 的输入；不得执行 reset、clean 或 checkout。

- [ ] **Step 2: 冻结 v0.2.0 发布源范围**

docs/release-source-scope-v0.2.0.md 必须逐项覆盖当前 tracked diff、deleted 和 untracked 文件，并为每项记录 include、exclude 或 superseded 及理由。release/source-include-v0.2.0.txt 每行只放一个 include Git path，作为唯一 staging pathspec。所有会被 Tasks 2–10 修改的共享文件必须先确定其现有改动是否进入新版；不能靠后续整文件 git add 隐式夹带。

Run:

~~~powershell
git status --porcelain=v1 --untracked-files=all
git diff --name-status
git diff --stat
~~~

Expected: scope 文档条目数与 status 项完全对账；include 是现有新版基线，exclude 留在原工作区不触碰，superseded 只保留历史记录。

- [ ] **Step 3: 运行当前投注基线**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs
~~~

Expected: 当前测试全绿；若失败，先按现有契约修复基线，不能用新 capability 掩盖旧失败。

- [ ] **Step 4: 给五份旧计划增加统一替代声明**

声明正文固定为：

~~~markdown
> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。
~~~

- [ ] **Step 5: 审查并提交 include 基线**

Run:

~~~powershell
git diff --check
git diff -- docs/superpowers/plans docs/release-source-scope-v0.2.0.md
git add --pathspec-from-file=release/source-include-v0.2.0.txt
git add release/source-include-v0.2.0.txt docs/release-source-scope-v0.2.0.md docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md docs/superpowers/plans/2026-07-14-crown-betting-remaining-work-roadmap.md docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md docs/superpowers/plans/2026-07-14-crown-betting-controlled-live-acceptance.md docs/superpowers/plans/2026-07-14-crown-betting-reconciliation-and-capability-expansion.md docs/superpowers/plans/2026-07-14-crown-full-validation-and-github-release.md
git diff --cached --name-status
~~~

Expected: 无空白错误，历史正文未删除，cached 文件与 scope 中 include 完全一致。每个共享文件必须审查完整 diff；禁止 git add -A。

- [ ] **Step 6: 作用域提交**

~~~powershell
git commit -m "chore: freeze Crown browser betting baseline"
~~~

Expected: 提交包含 scope 中全部 include 基线和上述计划文件；若 include 基线还有源码，使用 scope 的显式路径逐项添加后再提交。exclude 文件仍未 stage。

- [ ] **Step 7: 创建隔离实施 worktree**

执行时使用 superpowers:using-git-worktrees：

~~~powershell
git worktree add -b codex/crown-browser-api-betting-v020 ..\crown-browser-api-betting-v020 HEAD
~~~

Expected: Tasks 2–10 全部在新 worktree 执行；原脏工作区的 exclude 改动保持原样。新 worktree 的 git status 为空并重新运行 Step 3 基线后才进入 Task 2。

---

### Task 2: 扩展现有抓包器，生成全接口目录和八方向零 Submit 候选

**Files:**

- Modify: scripts/crown-betting-protocol-capture.mjs
- Modify: scripts/crown-betting-protocol-analyze.mjs
- Modify: src/crown/betting-protocol/protocol-classifier.mjs
- Modify: src/crown/betting-protocol/protocol-store.mjs
- Modify: src/crown/betting-protocol/capture-redaction.mjs
- Modify: tests/crown-betting-protocol-classifier.test.mjs
- Modify: tests/crown-betting-protocol-redaction.test.mjs
- Modify: tests/crown-betting-protocol-execution-evidence.test.mjs
- Create: tests/crown-betting-protocol-catalog.test.mjs

**Interfaces:**

- Consumes: Playwright BrowserContext 的 request、response、requestfailed、websocket frame；八方向键。
- Produces:
  - buildCrownProtocolCatalogCandidate(records, options)
  - public/protocol-catalog.safe.json
  - public/eight-direction-candidates.safe.json
  - public/static-wire-evidence.safe.json
  - private/raw-network.jsonl（ignored，仅本机）

本任务中的“所有接口”精确定义为：登录后依次访问足球列表、赛前详情、滚球详情、注单预览、提交表单和投注记录期间，浏览器实际发出的全部 HTTP/Fetch/XHR/Form/WebSocket 请求与反馈。服务端从未被页面调用的隐藏接口不作虚假“已发现”声明。

~~~javascript
export function buildCrownProtocolCatalogCandidate(records, {
  expectedDirections = CROWN_BROWSER_TARGETS,
  captureId,
  hmacKey,
} = {})
~~~

- [ ] **Step 1: 写失败测试，证明所有接口会按 endpoint、p、method 和 field set 聚合**

测试至少包含普通列表、FT_order_view、被阻断 FT_bet、结果查询、非投注 XHR、失败请求和 WebSocket frame。断言 protocol catalog 只有字段名、类型、序号关系和 HMAC binding；另一个 allowlist 型 static-wire-evidence 只允许 endpoint、function name、静态 enum/default 值、field-set 和 source HMAC。gid、ioratio、golds、con、ratio、uid、ver、timestamp 等动态值不得进入 public 产物。

- [ ] **Step 2: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-betting-protocol-catalog.test.mjs tests/crown-betting-protocol-classifier.test.mjs tests/crown-betting-protocol-redaction.test.mjs
~~~

Expected: FAIL，原因是 catalog builder 与新记录类型尚不存在。

- [ ] **Step 3: 实现统一流量记录**

要求：

- BrowserContext 级监听，不只监听当前 page。
- XHR、fetch、document、form POST、redirect、requestfailed、WebSocket 收发都记录。
- 请求与响应通过 seq、URL、method 和 p 关联。
- 默认在 route 层阻断所有 Submit-like 请求。
- eight-direction 场景按方向创建八个独立 captureRunId，并顺序使用独立 BrowserContext；每个 run 只允许一个方向、同一 session generation、同一 gid/side/line/odds、恰好一个成功 Preview response 和一个被阻断 Submit。禁止跨 run 合并动态记录。
- private 记录原始数据；public 只输出脱敏字段集合、值类型、摘要和稳定分类。
- analyzer 结束时自动输出 endpoint/function/field catalog，不要求人工逐行查 JSONL。

- [ ] **Step 4: 增加八方向场景清单**

~~~javascript
export const EIGHT_DIRECTION_CAPTURE_MANIFEST = Object.freeze(
  CROWN_BROWSER_TARGETS.map((direction, ordinal) => ({
    ordinal: ordinal + 1,
    direction,
    submitPolicy: 'block-at-route',
  })),
)
~~~

抓包 CLI 支持 --scenario discover 和 --scenario eight-direction；默认仍为 discover + block submit。

- [ ] **Step 5: 运行 GREEN 与语法检查**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-betting-protocol-catalog.test.mjs tests/crown-betting-protocol-classifier.test.mjs tests/crown-betting-protocol-redaction.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs
node --check scripts/crown-betting-protocol-capture.mjs
node --check scripts/crown-betting-protocol-analyze.mjs
~~~

Expected: 全绿。

- [ ] **Step 6: 使用现有虚拟账号执行零 Submit 现场采集**

Run:

~~~powershell
npm run crown:betting:capture -- --scenario eight-direction --block-submit
~~~

Expected: 八方向均有 Preview/Submit candidate 或明确 market-unavailable；实际 FT_bet dispatchCount=0。market-unavailable 方向继续等待并换取当前开放比赛，不猜字段。

- [ ] **Step 7: 审计产物并提交代码与 safe fixtures**

Run:

~~~powershell
rg -n -i "password|cookie|authorization|token|uid|ticket|C:\\\\Users\\\\" data/fixtures/crown/betting-protocol
git diff --check
~~~

Expected: safe fixtures 零敏感命中；private/raw 仍为 ignored。

Commit:

~~~powershell
git add scripts/crown-betting-protocol-capture.mjs scripts/crown-betting-protocol-analyze.mjs src/crown/betting-protocol tests/crown-betting-protocol-catalog.test.mjs tests/crown-betting-protocol-classifier.test.mjs tests/crown-betting-protocol-redaction.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs data/fixtures/crown/betting-protocol
git commit -m "feat: catalog Crown browser betting protocol"
~~~

---

### Task 3: 把八方向协议保存为程序内 side-aware 字段库

**Files:**

- Modify: src/crown/betting/crown-capability-matrix.mjs
- Modify: src/crown/betting/crown-order-field-mapper.mjs
- Modify: src/crown/betting/crown-bet-response-parser.mjs
- Modify: docs/crown-betting-protocol-map.md
- Modify: data/fixtures/crown/betting-protocol/
- Modify: tests/crown-capability-matrix.test.mjs
- Modify: tests/crown-order-field-mapper.test.mjs
- Modify: tests/crown-bet-response-parser.test.mjs
- Modify: tests/crown-betting-protocol-execution-evidence.test.mjs
- Modify: tests/crown-portable-runtime.test.mjs

**Interfaces:**

- Consumes: Task 2 safe catalog 与八方向 candidate。
- Produces:
  - capabilityKey({ mode, period, marketType, lineVariant, selectionSide })
  - getCrownCapability(input)
  - createCrownProtocolTemplateIndex(capabilities)
  - buildStrictCrownPreviewFields(record, { capability })
  - buildStrictCrownSubmitWireFields(input, options)
  - side-specific Preview/Submit/Reconciliation evidence。

- [ ] **Step 1: 写失败测试，要求 capability key 包含 side**

~~~javascript
assert.notEqual(
  capabilityKey({ mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main', selectionSide: 'home' }),
  capabilityKey({ mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main', selectionSide: 'away' }),
)
~~~

同时断言 home evidence 不能开启 away，over evidence 不能开启 under。template index 只在 Worker 启动时构建一次，运行查找不读取 fixture、不访问网络、不扫描数组，返回对象为 deep-frozen。

- [ ] **Step 2: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs
~~~

Expected: FAIL，当前 key 只有四维且 Submit mapper 硬编码赛前全场让球。

- [ ] **Step 3: 升级 capability schema**

每个方向必须保存：

~~~javascript
{
  mode,
  period: 'full_time',
  marketType,
  lineVariant: 'main',
  selectionSide,
  endpoints: {
    preview: { path, functionName },
    submit: { path, functionName },
    reconciliation: { path, functionName },
  },
  mapperEvidence: {
    ratioFields,
    oddsFieldsBySide,
    previewWireBySide,
    submitWireBySide,
    wireDefaults,
    dynamicFieldSources,
  },
  requestFieldSets,
  responseFieldSets,
  acceptanceCandidate: {
    allowed: false,
    evidenceId,
    protocolEvidenceDigest,
  },
  previewAllowed,
  submitAllowed,
  reconciliationAllowed,
  evidenceId,
  protocolEvidenceDigest,
}
~~~

path、functionName 和静态 wire 值必须来自 Task 2 的 static-wire-evidence.safe.json。blocked request 只能把 acceptanceCandidate.allowed 置为 true；未取得 direct accepted 前，canonical submitAllowed 保持 false。未取得 exact status-query evidence前，reconciliationAllowed 保持 false。protocolEvidenceDigest 只绑定稳定协议；具体 account/context/gid/side/line/odds/min/max/con/ratio/Preview 另生成 runtime-only executionCandidateDigest 并写入 B2 attempt，二者不得混用。

- [ ] **Step 4: 删除 speculative mapper**

删除或禁止生产导出未被使用、基于推测 H/C 映射的 buildCrownOrderFields()。所有正式映射只读取当前 capability 的 side-specific mapperEvidence；缺字段立即抛出稳定原因码。

- [ ] **Step 5: 固化静态/动态字段边界**

测试要求 gid、odds、stake、余额、con、ratio、timestamp、uid、ver 不得被 capability 当作固定值；字段名和来源可以固定，字段值必须由当前 list/Preview/login response 提供。

实现只读 template index：模板预存 endpoint path、function name、静态字段、动态字段来源和 strict field-set fingerprint；运行时只克隆模板并注入当前值，不能修改全局模板。

生产 capability matrix 必须自包含运行所需的 endpoint、静态 wire mapping、field-set fingerprint 和 evidence digest；data/fixtures/** 只供测试与开发审计读取。正式 Worker 启动和 getCrownCapability() 不得访问 fixture 路径。

- [ ] **Step 6: 运行 GREEN**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-portable-runtime.test.mjs
~~~

Expected: 八个 capability 都可查询；未验收方向保持 fail-closed；一侧证据不能授权另一侧；删除测试目录中的 data/fixtures 后，模拟 Portable 仍能加载八方向模板并启动 Worker。

- [ ] **Step 7: 更新协议地图并提交**

docs/crown-betting-protocol-map.md 必须为每个方向列出实际 endpoint、function、字段集合、动态来源和证据状态，但不记录任何真实值。

~~~powershell
git add src/crown/betting/crown-capability-matrix.mjs src/crown/betting/crown-order-field-mapper.mjs src/crown/betting/crown-bet-response-parser.mjs tests/crown-capability-matrix.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-portable-runtime.test.mjs docs/crown-betting-protocol-map.md data/fixtures/crown/betting-protocol
git commit -m "feat: add side-aware Crown protocol library"
~~~

---

### Task 4: 让监控快速提供四类盘口候选，但不重构监控核心

**Files:**

- Modify: src/crown/crown-transform-xml.mjs
- Modify: src/crown/betting/execution-identity.mjs
- Modify: src/crown/betting/locked-selection.mjs
- Modify: tests/crown-transform-xml.test.mjs
- Modify: tests/crown-execution-identity.test.mjs
- Modify: tests/crown-locked-selection.test.mjs
- Modify: tests/crown-monitor-v2-integration.test.mjs
- Modify: docs/modules/crown-football-monitor.md

**Interfaces:**

- Consumes: 赛前/滚球 get_game_list/get_game_more 的实际字段和 Task 3 capability library。
- Produces: 统一候选 identity：

~~~javascript
{
  gid,
  mode,
  period: 'full_time',
  marketType,
  lineVariant: 'main',
  selectionSide,
  handicapRaw,
  oddsField,
  oddsRaw,
  observedAt,
}
~~~

- [ ] **Step 1: 写四行八侧标准化失败测试**

fixture 必须来自 Task 2 的脱敏实际字段。测试证明赛前让球、赛前大小球、滚球让球、滚球大小球均生成正确 mode/marketType/side/line，未知字段保持 unknown。

- [ ] **Step 2: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-transform-xml.test.mjs tests/crown-execution-identity.test.mjs tests/crown-locked-selection.test.mjs tests/crown-monitor-v2-integration.test.mjs
~~~

Expected: 大小球或滚球目标映射失败，当前仅有的硬编码行为不能覆盖八方向。

- [ ] **Step 3: 最小修改标准化边界**

只补 crown-transform-xml 与 execution identity 所需的实际字段映射；不修改 Watcher lease、SnapshotBatch、StrategyRegistry、Signal、Telegram、monitor state 生命周期和赔率变化算法。

- [ ] **Step 4: 加入快速定位约束**

投注候选使用 monitor active index 的 gid + mode + marketType + selectionSide + handicapRaw 定位；浏览器现场列表必须再次找到同一 identity。仅 gid 相同、盘口线不同或 side 不同不得匹配。

- [ ] **Step 5: 运行 GREEN 与监控回归**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-transform-xml.test.mjs tests/crown-execution-identity.test.mjs tests/crown-locked-selection.test.mjs tests/crown-monitor-v2-integration.test.mjs tests/crown-monitor-state-store.test.mjs tests/crown-strategy-engine.test.mjs tests/crown-alert-dispatcher.test.mjs
~~~

Expected: 新目标行正确，原监控与 Telegram 行为不变。

- [ ] **Step 6: 提交**

~~~powershell
git add src/crown/crown-transform-xml.mjs src/crown/betting/execution-identity.mjs src/crown/betting/locked-selection.mjs tests/crown-transform-xml.test.mjs tests/crown-execution-identity.test.mjs tests/crown-locked-selection.test.mjs tests/crown-monitor-v2-integration.test.mjs docs/modules/crown-football-monitor.md
git commit -m "feat: normalize Crown full-time betting targets"
~~~

---

### Task 5: 建立每账号 persistent browser 会话与页面内 API transport

**Files:**

- Create: src/crown/login/crown-browser-api-client.mjs
- Create: src/crown/betting/crown-browser-account-runtime.mjs
- Create: src/crown/runtime/browser-profile-lease.mjs
- Modify: src/crown/login/portable-chromium.mjs
- Modify: src/crown/login/crown-api-login-manager.mjs
- Modify: src/crown/login/manual-login-bridge.mjs
- Modify: src/crown/app/crown-human-login-controller.mjs
- Modify: src/crown/app/runtime-cache-cleanup.mjs
- Create: tests/crown-browser-api-client.test.mjs
- Create: tests/crown-browser-account-runtime.test.mjs
- Create: tests/crown-browser-profile-lease.test.mjs
- Modify: tests/crown-portable-chromium.test.mjs
- Modify: tests/crown-api-login-manager.test.mjs
- Modify: tests/crown-manual-login-bridge.test.mjs
- Modify: tests/crown-human-login-controller.test.mjs
- Modify: tests/crown-runtime-cache-cleanup.test.mjs

**Interfaces:**

~~~javascript
export class CrownBrowserApiClient {
  constructor({ page, origin, requestTimeoutMs = 30000 } = {})
  login({ account, signal })
  fetchGameList(session, { signal })
  fetchAccountSummary(session, { signal })
  postPreview({ session, wireFields, signal })
  postSubmit({ session, wireFields, signal, beforeDispatch })
  queryResult({ session, wireFields, signal })
}

export class CrownBrowserAccountRuntime {
  ensureBettingSession({ account, assertFence, signal })
  fetchFreshExecutionBalance({ account, session, assertFence, signal })
  postPreviewForm({ account, session, wireFields, assertFence, signal })
  postSubmitForm({ account, session, wireFields, assertFence, signal, beforeDispatch })
  queryResultForm({ account, session, wireFields, assertFence, signal })
  verifiedBettingSessionFor({ account, session })
  closeAccount({ accountId, reason = 'closed' })
  shutdown()
}
~~~

- [ ] **Step 1: 写 transport RED 测试**

必须覆盖：

- 相对路径与 exact HTTPS origin。
- credentials=include、redirect=error、serviceWorkers=block。
- Preview/Submit 不调用 globalThis.fetch 或 context.request。
- beforeDispatch 紧邻 page.evaluate(fetch) 且恰好一次。
- Submit 无内部 retry。
- 跨 origin redirect、新 page、download 和未知 endpoint 拒绝。

- [ ] **Step 2: 写账号 runtime 与 profile lease RED 测试**

必须覆盖：

- 同账号并发只创建一个 context 且请求串行。
- 同账号连续两笔 Preview/Submit 复用同一个 context/page；第二笔不得重新启动浏览器、重新抓协议或使用 DOM locator。
- 不同账号 profile 目录、Cookie jar、context generation 和 lease 不同。
- Worker 与人工登录不能同时占用同一账号 profile。
- 重启只复用 Chromium profile，必须重新取得本进程 login response 的 uid/ver proof。
- lease 丢失、账号 origin/username 变化、context crash 会废弃 session 并关闭 context。
- 不调用 context.storageState()，不导出 Cookie。
- 获取 profile lease 必须早于 profile 目录创建和 Chromium 启动；每次 page.evaluate 前后同时检查 executor fence、profile fence 和 context generation。
- ManualLoginBridge 的成功、失败、取消、过期、goto/验证错误、context disconnected 和 Dashboard shutdown 全部进入同一个幂等 finally；只有确认 context 已关闭才释放 lease，关闭失败则等待 lease 自然过期且不删除 SingletonLock。
- runtime cleanup 必须先停止 Betting Worker，再重新检查所有 browser-profile lease；存在活跃或关闭未完成的 context 时拒绝删除 Profile、重置 lease 或清理 browser cache。

- [ ] **Step 3: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-browser-api-client.test.mjs tests/crown-browser-account-runtime.test.mjs tests/crown-browser-profile-lease.test.mjs
~~~

Expected: FAIL，三个新模块尚不存在。

- [ ] **Step 4: 实现 browser profile lease 与固定浏览器启动边界**

复用现有 RuntimeLease 和 profileDirectoryForAccount()；lease key 绑定 canonical absolute db path + account id。先获取并启动 heartbeat，再调用 launchPortableChromium() 创建 profile/context。portable-chromium 增加用途固定的 betting 启动路径并强制 serviceWorkers: block、acceptDownloads: false、headless: false，不开放任意 launch options。关闭顺序固定为：停止接单、等待当前只读动作、并行关闭 contexts、确认关闭、停止 heartbeat、释放 profile lease。

- [ ] **Step 5: 实现页面内 API client**

只允许抓包证明确认的 transform_nl.php、transform.php 和结果查询路径。page.evaluate 内使用 URLSearchParams 与 fetch。内部敏感 payload（raw response text、login parser 得到的 uid/ver）只能返回给同进程 strict parser/runtime；logger、DTO、IPC、异常和 safe fixture 只能得到 field-set、digest 与安全 transport metadata，绝不暴露 Cookie、UID、raw body 或完整 provider reference。

- [ ] **Step 6: 实现 account runtime**

单 worker 内按账号懒加载 launchPortableChromium() persistent context。每个新 context generation 执行浏览器内 chk_login 和只读 game list 验证；uid/ver 只保存在内存 session。当前 CrownApiLoginManager 与 CrownApiClient 保留给 v2 监控和只读账号检测，不再给生产下注使用。

Worker 启动即加载并校验 template index；收到 GO 后后台准备 enabled betting accounts。ready session 保持常驻并定时只读验证，后续订单直接复用页面；login_required 账号不参与分配并在 UI 显示，不拖慢其他 ready 账号。

- [ ] **Step 7: 接入人工登录恢复**

ManualLoginBridge 在 context 关闭前通过浏览器 API 验证 game list；CrownHumanLoginController 获取同一 profile lease。人工登录只允许在整个 Betting Worker 已停止且 profile lease 已释放后开始。为兼容现有只读检测，exact-origin cookies 可在 controller 内部私下交给 legacy session 保存逻辑，但不得进入 browser client 返回值、DTO、日志或 IPC；保存的 legacy session、UID/ver 都不能授权新 Worker Submit。deprecated monitor-state-version=1 保持禁用且不迁移到新 profile root。

- [ ] **Step 8: 保护 runtime cleanup**

清理流程必须先请求停止 Betting Worker，等待 browser shutdown，再检查 watcher 与 browser-profile leases。任何活跃人工登录、关闭失败或 lease 未到期都返回稳定 busy reason；不得删除 Chromium SingletonLock 或直接重置 runtime_leases。

- [ ] **Step 9: 运行 GREEN**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-browser-api-client.test.mjs tests/crown-browser-account-runtime.test.mjs tests/crown-browser-profile-lease.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-api-login-manager.test.mjs tests/crown-manual-login-bridge.test.mjs tests/crown-human-login-controller.test.mjs tests/crown-runtime-cache-cleanup.test.mjs
~~~

Expected: 全绿，且测试能证明 Node fetch Submit 为 0。

- [ ] **Step 10: 提交**

~~~powershell
git add src/crown/login/crown-browser-api-client.mjs src/crown/betting/crown-browser-account-runtime.mjs src/crown/runtime/browser-profile-lease.mjs src/crown/login/portable-chromium.mjs src/crown/login/crown-api-login-manager.mjs src/crown/login/manual-login-bridge.mjs src/crown/app/crown-human-login-controller.mjs src/crown/app/runtime-cache-cleanup.mjs tests/crown-browser-api-client.test.mjs tests/crown-browser-account-runtime.test.mjs tests/crown-browser-profile-lease.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-api-login-manager.test.mjs tests/crown-manual-login-bridge.test.mjs tests/crown-human-login-controller.test.mjs tests/crown-runtime-cache-cleanup.test.mjs
git commit -m "feat: add Crown browser account runtime"
~~~

---

### Task 6: 将 Preview、Submit、Reconciliation 和 B2 接到唯一 Browser transport

**Files:**

- Modify: src/crown/betting/crown-account-provider.mjs
- Modify: src/crown/betting/crown-account-execution-provider.mjs
- Create: src/crown/betting/crown-account-reconciliation-provider.mjs
- Create: src/crown/betting/reconciliation-worker.mjs
- Create: src/crown/app/reconciliation-process.mjs
- Create: scripts/crown-reconciliation-worker.mjs
- Modify: src/crown/betting/b2-executor.mjs
- Modify: src/crown/betting/b2-reconciler.mjs
- Modify: src/crown/betting/real-worker-factory.mjs
- Modify: src/crown/betting/real-betting-runtime.mjs
- Modify: src/crown/app/betting-process.mjs
- Modify: scripts/crown-betting-worker.mjs
- Modify: tests/crown-account-provider.test.mjs
- Create: tests/crown-account-reconciliation-provider.test.mjs
- Create: tests/crown-reconciliation-worker.test.mjs
- Create: tests/crown-reconciliation-process.test.mjs
- Modify: tests/crown-betting-b2-executor.test.mjs
- Modify: tests/crown-betting-b2-reconciliation.test.mjs
- Modify: tests/crown-betting-worker.test.mjs
- Modify: tests/crown-real-betting-runtime.test.mjs
- Modify: tests/crown-betting-process.test.mjs

**Interfaces:**

- Consumes: CrownBrowserAccountRuntime、side-aware capability、现有 B2 child/attempt/lock。
- Produces: 唯一生产链：

~~~text
Browser fresh login/list/balance
  -> O(1) protocol template lookup
  -> initial strict Preview
  -> final identity/session/balance/Preview verification
  -> one SQLite transaction: B2 prepare + optional acceptance permit + dispatch
  -> one browser Submit
  -> accepted or unknown
  -> browser read-only reconciliation loop
~~~

- [ ] **Step 1: 写失败测试，禁止生产 Provider 调 loginManager.client.postForm**

测试注入一个会在 global fetch/postForm 时抛错的 sentinel，同时让 browserRuntime 返回 fixture。Preview、Submit 与 result query 必须仍通过。

- [ ] **Step 2: 写 B2 dispatch 顺序和崩溃窗口测试**

断言：

1. 候选、浏览器、session、余额和最终 fresh Preview 全部在 B2 attempt transaction 之前完成。
2. beforeDispatch 恰好一次，并在同一个 BEGIN IMMEDIATE 中完成 attempt prepare、可选 acceptance permit claim 和 dispatch。
3. callback 前失败不创建 attempt/permit，状态为 pre-dispatch-cancelled，可以重新寻找新鲜候选。
4. transaction commit 后的 timeout、page crash、parser error 均为 unknown。
5. unknown outcome transaction 同步 upsert bet_reconciliation_state。
6. 进程重启不创建第二个 Submit。
7. reconciliation 只查询原 attempt/provider reference，不生成新 child 或 Submit。

- [ ] **Step 3: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-worker.test.mjs
~~~

Expected: FAIL，现有 Provider 仍走 loginManager.client.postForm，production reconciliation 尚未实现。

- [ ] **Step 4: 替换 Preview Provider**

CrownAccountPreviewProvider 使用 browserRuntime.ensureBettingSession、fetchFreshExecutionBalance 和 postPreviewForm。它用 locked selection 的五维 key 直接从内存 template index 取实际 endpoint/wire schema，不做 DOM 搜索。仍从 fresh provider response 返回 min/max/odds/line/balance；调用方不能注入 limits、wire 或 capability。

- [ ] **Step 5: 替换 Submit Provider**

CrownAccountExecutionProvider 使用相同 account context 和 current session generation。Provider 不 import 或调用 dispatch store；它只把 B2 传入的 input.onNetworkStarted 原样作为 beforeDispatch 交给 postSubmitForm。B2 继续是 attempt prepare、permit claim 和 recordSubmitDispatch 的唯一事务所有者。删除生产 Submit 对 api-session.json、CrownApiClient.postForm 和 UI fallback 的依赖；删除 amountMinor===50 的硬编码，改为使用 B2 金额并严格验证 fresh Preview min/max、账号 perBetLimit、余额和 CNY。验收金额严格等于 fresh minStakeMinor，因此不推测 stake step；普通生产金额大于 minimum 时，只有平台字段或已验证 account policy 明确给出 step 才允许。

- [ ] **Step 6: 实现 exact result query**

结果 provider 只使用 Task 2/3 已验证的实际接口和字段。唯一 strong match 才能确认 accepted/rejected；无匹配、弱匹配、多匹配、session 漂移或响应字段漂移均保持 unknown。direct accepted 后的只读验证查询与 unknown 账本结算是两个不同 operation；前者只留协议证据，不重复结算 child。

- [ ] **Step 7: 实现持续 Reconciliation 生命周期**

增加 betting-reconciler:<canonical-db> lease、due-row loop、指数退避、deadline 和 manual-review terminal state。Betting Worker 运行时使用自己的 BrowserAccountRuntime 处理 due rows；全局 Submit 停止且仍有 due unknown 时，父进程启动独立 read-only Reconciliation Worker。两个进程通过 browser-profile lease 互斥：启动 Betting Worker 前先停止 reconciler 并等待 profile release；Betting Worker 停止后 reconciler 才能接管。启动恢复必须扫描 due rows，任何 crash 都不能生成第二次 Submit。

- [ ] **Step 8: 修正 Worker 生命周期、状态 IPC 和停止宽限**

scripts/crown-betting-worker.mjs 必须把 appRoot、dataRoot、runtimeDir、profileRoot、chromiumExecutable 和 dbPath 传入 factory。Worker 只向父进程发送带 generation+nonce 的安全 browser-status snapshot，包含账号 ID、状态和 heartbeat，不含 UID/Cookie/Profile 路径。betting-process.mjs 缓存当前 generation 的 snapshot 并拒绝旧消息，不增加 per-account command IPC。

Browser runtime shutdown 预算固定 20 秒，父进程 stopTimeoutMs 调整为 25 秒；contexts 可并行关闭。finally 使用嵌套结构：即使 realWorker.shutdown() 抛错，仍必须停止 heartbeat、释放 executor/worker lease 并关闭 DB；角色 heartbeat 保持到 browser shutdown 完成。context 未确认关闭时不主动释放 profile lease，让其 TTL 过期。

- [ ] **Step 9: 运行 GREEN**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-reconciliation-worker.test.mjs tests/crown-reconciliation-process.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-betting-process.test.mjs tests/crown-execution-gate.test.mjs tests/crown-bet-batch-store.test.mjs
~~~

Expected: 全绿；production transport 只剩 browser-page-fetch。

- [ ] **Step 10: 提交**

~~~powershell
git add src/crown/betting/crown-account-provider.mjs src/crown/betting/crown-account-execution-provider.mjs src/crown/betting/crown-account-reconciliation-provider.mjs src/crown/betting/reconciliation-worker.mjs src/crown/app/reconciliation-process.mjs scripts/crown-reconciliation-worker.mjs src/crown/betting/b2-executor.mjs src/crown/betting/b2-reconciler.mjs src/crown/betting/real-worker-factory.mjs src/crown/betting/real-betting-runtime.mjs src/crown/app/betting-process.mjs scripts/crown-betting-worker.mjs tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-reconciliation-worker.test.mjs tests/crown-reconciliation-process.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-worker.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-betting-process.test.mjs
git commit -m "feat: route Crown betting through browser API"
~~~

---

### Task 7: 让 Dashboard 和前端符合浏览器下注模式

**Files:**

- Modify: src/crown/app/app-repository.mjs
- Modify: src/crown/app/app-api.mjs
- Modify: src/crown/app/real-betting-dto.mjs
- Modify: scripts/crown-dashboard.mjs
- Modify: frontend/src/types.ts
- Modify: frontend/src/services/api.ts
- Create: frontend/src/components/BrowserBettingPanel.tsx
- Create: frontend/src/components/BrowserBettingPanel.test.tsx
- Modify: frontend/src/pages/OperationsConsole.tsx
- Modify: frontend/src/pages/OperationsConsole.test.tsx
- Modify: frontend/src/pages/BettingAccounts.tsx
- Modify: frontend/src/pages/BettingAccounts.test.tsx
- Modify: frontend/src/pages/AutoBetRules.tsx
- Modify: frontend/src/pages/AutoBetRules.test.tsx
- Modify: frontend/src/services/api.security.test.ts
- Modify: frontend/src/App.contract.test.tsx
- Modify: frontend/src/components/AppLayout.mobile.test.tsx
- Modify: tests/crown-app-api.test.mjs
- Modify: tests/crown-operations-summary.test.mjs
- Modify: tests/crown-dashboard-css-contract.test.mjs
- Create: tests/crown-browser-betting-dashboard-e2e.test.mjs

**Interfaces:**

~~~typescript
type BrowserBettingSummary = {
  transportKind: 'browser-page-fetch'
  protocolLibraryVersion: string
  sessions: Array<{
    accountId: string
    state: 'stopped' | 'starting' | 'login_required' | 'ready' | 'stale' | 'blocked' | 'error'
    lastHeartbeatAt: string | null
    sessionGeneration: number
    lastApiSuccessAt: string | null
  }>
  directions: Array<{
    key: string
    previewAllowed: boolean
    submitAllowed: boolean
    reconciliationAllowed: boolean
    blockedReason: string | null
    acceptanceState: 'pending' | 'previewing' | 'dispatched' | 'accepted' | 'rejected' | 'unknown' | null
  }>
  campaign: {
    campaignId: string
    state: 'inactive' | 'active' | 'completed' | 'failed'
    acceptedCount: number
    targetCount: 8
    unknownCount: number
    totalAcceptedAmountMinor: number
    queueDepth: number
    inFlightCount: number
  } | null
}
~~~

- [ ] **Step 1: 写 API/DTO RED 测试**

operations-summary 必须从父进程缓存的当前 generation IPC snapshot 和 SQLite campaign read model 返回安全 browserBetting；不返回密码、Cookie、UID、Token、完整 Profile 路径、原始响应或完整 provider reference。人工登录路由固定为 /api/app/betting-accounts/:id/manual-login/open、/:challengeId、/:challengeId/confirm、/:challengeId/cancel，并沿用 CSRF/contract guard；仅在整个 Betting Worker 已停止且对应 profile lease 已释放时允许。

- [ ] **Step 2: 写前端 RED 测试**

断言：

- Operations 显示“浏览器内 API”、协议库版本、八方向矩阵和阻断原因。
- Betting Accounts 显示每账号浏览器状态，并提供打开登录窗口；会话停止/重启统一使用 Operations 的全局 Betting Worker 停止/启动，避免增加重复的 per-account IPC 控制面。
- Rules 只显示后端计算的方向支持徽标，不能编辑 wire 字段。
- unknown 风险仍位于最高优先级；停止按钮始终可见。
- campaign、8 项方向状态、accepted 进度、queue/in-flight 和 unknown terminal state 刷新或 Worker 重启后仍可恢复。
- 390×844 下八方向矩阵可读，触控尺寸满足现有 44px 契约。

- [ ] **Step 3: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs
npm --prefix frontend run test -- --run src/components/BrowserBettingPanel.test.tsx src/pages/OperationsConsole.test.tsx src/pages/BettingAccounts.test.tsx src/pages/AutoBetRules.test.tsx src/services/api.security.test.ts src/App.contract.test.tsx
node --test --test-concurrency=1 tests/crown-browser-betting-dashboard-e2e.test.mjs tests/crown-dashboard-css-contract.test.mjs
~~~

Expected: FAIL，新 DTO、动作与组件尚不存在。

- [ ] **Step 4: 扩展现有 API 和页面**

复用现有 operations/account routes、polling、CSRF 和错误映射；不新增 /betting-acceptance 页面。账号人工登录路由复用 monitor manual-login 的认证模式，但绑定 betting account repository 与 profile lease。安全顺序固定为：用户停止整个 Betting Worker → 等待 browser shutdown/lease release → 打开人工登录 → 浏览器内验证 → 关闭 context/释放 lease → 用户从 Operations 重启 Worker → 新 Worker 重新 chk_login/game list。人工登录路由不得静默停止或重启 Worker。

- [ ] **Step 5: 实现 BrowserBettingPanel**

组件同时展示：

- transport 与 protocol library version。
- 八个方向 Preview/Submit/Reconciliation 状态。
- 活跃账号 context、登录状态、heartbeat。
- unknown、session stale、capability drift 的明确中文阻断原因。
- 当前 acceptance campaign 的 8 项进度、队列、在途数量、accepted 金额和 terminal failed 原因。

- [ ] **Step 6: 运行 GREEN 与 build**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs tests/crown-app-repository.test.mjs
npm --prefix frontend run test -- --run src/components/BrowserBettingPanel.test.tsx src/pages/OperationsConsole.test.tsx src/pages/BettingAccounts.test.tsx src/pages/AutoBetRules.test.tsx src/services/api.security.test.ts src/App.contract.test.tsx
npm run crown:frontend:build
node --test --test-concurrency=1 tests/crown-browser-betting-dashboard-e2e.test.mjs tests/crown-dashboard-css-contract.test.mjs
~~~

Expected: 全绿且 production build 成功。Dashboard E2E 实际启动本地 Dashboard，用 Playwright 检查 /operations、/betting-accounts、/betting-rules、刷新/Worker 重启、stale/offline/unknown 阻断、1440×900、390×844、console error=0 和敏感字段零泄漏。

- [ ] **Step 7: 提交**

~~~powershell
git add src/crown/app/app-repository.mjs src/crown/app/app-api.mjs src/crown/app/real-betting-dto.mjs scripts/crown-dashboard.mjs frontend/src/types.ts frontend/src/services/api.ts frontend/src/components/BrowserBettingPanel.tsx frontend/src/components/BrowserBettingPanel.test.tsx frontend/src/pages/OperationsConsole.tsx frontend/src/pages/OperationsConsole.test.tsx frontend/src/pages/BettingAccounts.tsx frontend/src/pages/BettingAccounts.test.tsx frontend/src/pages/AutoBetRules.tsx frontend/src/pages/AutoBetRules.test.tsx frontend/src/services/api.security.test.ts frontend/src/App.contract.test.tsx frontend/src/components/AppLayout.mobile.test.tsx tests/crown-app-api.test.mjs tests/crown-operations-summary.test.mjs tests/crown-dashboard-css-contract.test.mjs tests/crown-browser-betting-dashboard-e2e.test.mjs
git commit -m "feat: show browser betting readiness in dashboard"
~~~

---

### Task 8: 建立固定八方向验收 runner 并完成本地全链路演练

**Files:**

- Create: scripts/crown-browser-api-acceptance.mjs
- Create: src/crown/betting/crown-browser-acceptance.mjs
- Modify: src/crown/app/app-db.mjs
- Modify: src/crown/betting/crown-account-provider.mjs
- Modify: src/crown/betting/crown-account-execution-provider.mjs
- Modify: src/crown/betting/crown-account-reconciliation-provider.mjs
- Modify: src/crown/betting/b2-executor.mjs
- Modify: src/crown/betting/b2-reconciler.mjs
- Modify: src/crown/betting/real-worker-factory.mjs
- Modify: scripts/crown-betting-worker.mjs
- Create: tests/crown-browser-acceptance.test.mjs
- Create: tests/crown-browser-betting-e2e.test.mjs
- Modify: tests/crown-app-db.test.mjs
- Modify: tests/crown-account-provider.test.mjs
- Modify: tests/crown-account-reconciliation-provider.test.mjs
- Modify: tests/crown-betting-b2-executor.test.mjs
- Modify: tests/crown-betting-b2-reconciliation.test.mjs
- Modify: tests/crown-betting-worker.test.mjs
- Modify: package.json
- Modify: .gitignore

**Interfaces:**

~~~javascript
export function createCrownBrowserAcceptanceManifest({
  capabilityVersion,
  directions = CROWN_BROWSER_TARGETS,
} = {})

export function claimAcceptanceDirection(state, direction)
export function settleAcceptanceDirection(state, result)
export function inspectAcceptanceState(state)

export function createCrownAcceptanceCapabilityAuthority({
  database,
  manifest,
  secretKey,
  candidateCatalog,
} = {})

export function claimAcceptanceDispatchInTransaction(db, {
  direction,
  childOrderId,
  submitAttemptId,
  capabilityVersion,
  capabilityEvidenceId,
  amountMinor,
} = {})

export function resolveAcceptanceReconciliation({
  campaignId,
  direction,
  submitAttemptId,
  sealedProviderReference,
} = {})
~~~

- [ ] **Step 1: 写 runner RED 测试**

固定断言：

- 恰好八个唯一方向。
- 每方向最终只计一笔 accepted。
- 金额等于该次 Preview minStakeMinor。
- pre-dispatch 失败可重新选新鲜候选，不消费 Submit。
- post-dispatch unknown 立即停止整个 runner。
- rejected/unknown 不计入 8/8。
- 重启读取 ignored runtime state 与 SQLite child/attempt 对账，不产生第二次 Submit。
- runner 不能接收任意 wire form，所有 wire 来自 capability library。
- canonical submitAllowed=false 时普通 Worker 必须继续拒绝；只有 HMAC manifest、exact candidate、方向 permit、child/attempt binding 全部匹配时，acceptance authority 才能解析该方向。
- permit claim 与 B2 recordSubmitDispatch 位于同一 SQLite IMMEDIATE transaction；任一步 fault 都同时回滚。
- Dashboard、real-worker-factory、API、环境变量和普通 CLI 都不能构造 acceptance authority。
- acceptance CLI 自身 Preview/Submit/Reconciliation provider 调用数全部为 0；它只初始化/查询 HMAC campaign，真实执行始终由持有 canonical executor/profile lease 的现有 Betting Worker 完成。
- acceptance_reconciliation 只能针对 campaign 已绑定的原 attempt 和 sealed provider reference 做可重复只读查询，不能创建 child、attempt 或 Submit。

- [ ] **Step 2: 运行 RED**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-browser-acceptance.test.mjs tests/crown-browser-betting-e2e.test.mjs
~~~

Expected: FAIL，新 runner 尚不存在。

- [ ] **Step 3: 实现固定验收状态机与 SQLite permit**

在 app-db 增加 crown_browser_acceptance_campaigns 和 crown_browser_acceptance_cases；每个 direction 保存 immutable ordinal、protocolEvidenceDigest、runtime executionCandidateDigest、状态、child/attempt binding、authorizedMinMinor、dispatch count 与 outcome。executionCandidateDigest 从 Worker 当前 account/context/gid/side/line/odds/min/max/con/ratio/Preview 事实派生，不信任 CLI 传值。每个 case 在真正 dispatch 前冻结 authorizedMinMinor；第二次 Preview 不完全一致时取消且不创建 attempt，重新冻结新的 case version。八个 minimum 的合计只是派生审计值，不设置旧式任意累计上限。manifest 使用现有 app secret 做 HMAC，ignored runtime JSON 只作为安全展示镜像，不是事实源。

- [ ] **Step 4: 建立 acceptance-only capability authority**

acceptance CLI 只向 SQLite 初始化固定八方向 campaign 并观察状态，不能加载 Browser runtime、Provider 或 B2。现有 canonical Betting Worker 从同一 DB 读取 HMAC-valid active campaign，在内部构造 acceptance authority；Preview/Execution Provider 和 B2 只接受 Worker 构造阶段注入的内部 authority，submit() 调用方仍不能传 capability、resolver、wire 或 permit。B2 的 onNetworkStarted 在同一 dispatch transaction 内完成 attempt prepare、exact permit claim 和 dispatch，然后才允许 browser fetch。

- [ ] **Step 5: 接入 acceptance-only Reconciliation**

增加 acceptance_reconciliation operation：普通 canonical reconciliationAllowed=false 时仍拒绝；只有 HMAC campaign、direction、原 attempt、sealed provider reference 和当前 account/session 全部匹配时才允许只读查询。direct accepted 后的验证查询只写 safe evidence；post-dispatch unknown 的查询可以结算原 child，但永远不能把该次结果升级成 direct accepted protocol evidence。

- [ ] **Step 6: 通过本地假 Crown 页面跑完整浏览器链**

本地 E2E 必须模拟登录、game list、余额、四类 Preview、八侧 Submit、结果查询、session expiry、context crash 和赔率漂移。测试通过真实 Playwright page.evaluate(fetch)，不能把 browser client 替换成普通函数 mock。

- [ ] **Step 7: 运行 GREEN 和相关回归**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-browser-acceptance.test.mjs tests/crown-browser-betting-e2e.test.mjs tests/crown-browser-api-client.test.mjs tests/crown-browser-account-runtime.test.mjs tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-worker.test.mjs
~~~

Expected: 八方向模拟 accepted，canonical Worker dispatchCount=8，acceptance CLI dispatchCount=0，unknown=0，duplicateAttempt=0。

- [ ] **Step 8: 确认验收初始化 CLI 不进入生产 Portable**

release allowlist 和审计测试必须证明 scripts/crown-browser-api-acceptance.mjs 不进入用户正式包。src/crown/betting/crown-browser-acceptance.mjs 是 canonical Worker 的持久 campaign consumer，会进入 Portable，但无 Dashboard/API/env 创建入口；没有本机 HMAC campaign 时始终 inactive。正式能力仍只来自已经验收并固化的 capability。

- [ ] **Step 9: 提交**

~~~powershell
git add scripts/crown-browser-api-acceptance.mjs src/crown/betting/crown-browser-acceptance.mjs src/crown/app/app-db.mjs src/crown/betting/crown-account-provider.mjs src/crown/betting/crown-account-execution-provider.mjs src/crown/betting/crown-account-reconciliation-provider.mjs src/crown/betting/b2-executor.mjs src/crown/betting/b2-reconciler.mjs src/crown/betting/real-worker-factory.mjs scripts/crown-betting-worker.mjs tests/crown-browser-acceptance.test.mjs tests/crown-browser-betting-e2e.test.mjs tests/crown-app-db.test.mjs tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-worker.test.mjs package.json .gitignore
git commit -m "test: add Crown eight-direction acceptance runner"
~~~

---

### Task 9: 执行八方向真实最小金额验收并提升字段库

**Files:**

- Modify: data/fixtures/crown/betting-protocol/
- Modify: src/crown/betting/crown-capability-matrix.mjs
- Modify: docs/crown-betting-protocol-map.md
- Modify: tests/crown-capability-matrix.test.mjs
- Modify: tests/crown-betting-protocol-execution-evidence.test.mjs
- Create: data/fixtures/crown/betting-protocol/acceptance-summary.safe.json
- Runtime evidence (ignored): .superpowers/sdd/evidence/crown-browser-api-betting.safe.json

**Interfaces:**

- Consumes: Task 2 的 blocked Submit candidates、Task 5/6 的正式 Browser+B2 链、Task 8 runner。
- Produces: 八个 direct accepted safe evidence、八个 exact result-query evidence、最终 capability library version。

- [ ] **Step 1: 执行真实窗口前全门检查**

Run:

~~~powershell
npm test
npm run check
npm run crown:frontend:test
npm run crown:frontend:build
~~~

Expected: 全绿；operations summary 中 unknown、manual review、dead-letter 为 0，Worker/Executor/Profile lease 唯一且新鲜。

- [ ] **Step 2: 冻结八方向 manifest**

manifest 固定 capability version、八个 ordinal 和 provider-minimum 金额策略。旧 5-batch/500-CNY campaign 不参与本次验收。每个方向只允许一个在途 dispatch；该方向执行前由 canonical Worker 的只读 Preview 冻结 authorizedMinMinor 与 executionCandidateDigest，最终 Preview 不一致时在创建 B2 attempt 前取消并重新冻结，不自动提高已冻结金额。

- [ ] **Step 3: 按 ordinal 串行执行**

Run:

~~~powershell
npm run crown:betting:acceptance -- --resume --allow-real-submit --confirm REAL_BET
~~~

CLI 只初始化或观察 campaign，进程内 Submit 调用数必须为 0；Dashboard 启动的 canonical Betting Worker 才执行以下步骤：

1. 从 monitor active index 选择当前开放 exact main line。
2. 浏览器 fresh login/list/balance。
3. strict Preview 核对 identity、odds、min/max、CNY 和 perBetLimit。
4. amountMinor 精确等于 Preview minStakeMinor。
5. 单个 SQLite transaction 完成 B2 prepare + permit claim + durable dispatch。
6. 一次 browser-page FT_bet。
7. direct accepted 严格解析。
8. 只读 exact result query；pending 可以退避轮询，绝不再次 Submit。
9. 写 safe digest 后才进入下一方向。

没有可用比赛时继续扫描，不用近似盘口替代。callback/transaction 前失败没有 attempt，可以重新选择；transaction commit 后任何异常都进入 unknown。出现 unknown 时当前 campaign 立即 terminal failed，permit 已消费，--resume 不得重投该方向。Reconciliation 只处理资金与锁，不把 reconciled accepted 伪装成 direct accepted；若仍需取得 direct protocol evidence，保留旧 campaign 全部统计后创建新的 HMAC campaign。

- [ ] **Step 4: 核对八方向最终证据**

safe report 必须满足：

~~~javascript
{
  schemaVersion: 'crown-browser-api-acceptance-v1',
  transportKind: 'browser-page-fetch',
  acceptedCount: 8,
  uniqueDirectionCount: 8,
  submitDispatchCount: 8,
  unknownCount: 0,
  duplicateAttemptCount: 0,
  uiSubmitCount: 0,
  nodeFetchSubmitCount: 0,
}
~~~

上述计数属于最终成功 campaign；此前 terminal failed campaign 必须在 historicalCampaigns 中完整列出，不能删除或并入成功统计。金额汇总为各 campaign 实际冻结的 Preview 最小金额之和，不硬编码 400 CNY。

- [ ] **Step 5: 生成 side-specific accepted fixtures**

每个方向一份 safe fixture；保存 endpoint、field-set fingerprint、capability identity、金额/赔率一致性、result binding 和 evidence digest。原始账号、Cookie、UID、完整订单号与响应正文只留在 ignored private runtime。

- [ ] **Step 6: 提升八个 capability**

只有对应方向 direct accepted + exact result-query evidence 都通过时，才将该方向 Preview/Submit/Reconciliation 设为 true。八个方向均通过后，UI 显示 8/8 ready。

- [ ] **Step 7: 运行提升后的回归**

Run:

~~~powershell
node --test --test-concurrency=1 tests/crown-capability-matrix.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-account-provider.test.mjs tests/crown-account-reconciliation-provider.test.mjs tests/crown-browser-acceptance.test.mjs
~~~

Expected: 全绿；一侧 fixture 删除或篡改会只关闭该侧。

- [ ] **Step 8: 脱敏审计并提交 safe 证据**

~~~powershell
rg -n -i "password|cookie|authorization|token|uid|ticket|C:\\\\Users\\\\" data/fixtures/crown/betting-protocol .superpowers/sdd/evidence/crown-browser-api-betting.safe.json
git add src/crown/betting/crown-capability-matrix.mjs tests/crown-capability-matrix.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs data/fixtures/crown/betting-protocol docs/crown-betting-protocol-map.md
git commit -m "feat: verify Crown browser betting directions"
~~~

Expected: 敏感扫描零命中；ignored runtime report 不强制加入 Git，仓库只提交 acceptance-summary.safe.json 与八份脱敏 fixtures，不包含 private/raw。

---

### Task 10: 全程序体检、文档收口、Portable 和 GitHub 原仓库替换

**Files:**

- Modify: README.md
- Modify: docs/project-memory.md
- Modify: docs/module-index.md
- Modify: docs/modules/crown-betting-protocol.md
- Modify: docs/modules/crown-football-monitor.md
- Modify: docs/modules/crown-dashboard.md
- Modify: docs/betting-architecture.md
- Modify: docs/betting-contract.md
- Modify: docs/github-release-runbook.md
- Create: scripts/crown-runtime-health-audit.mjs
- Create: scripts/crown-release-candidate.ps1
- Create: tests/crown-runtime-health-audit.test.mjs
- Create: tests/crown-release-candidate.test.mjs
- Modify: .github/workflows/windows-release-build.yml
- Modify: tests/crown-release-workflow.test.mjs
- Modify: tests/crown-portable-release-builder.test.mjs
- Modify: tests/crown-release-audit.test.mjs
- Modify: package.json
- Modify: package-lock.json
- Modify: release/windows-production-allowlist.json
- Scope audit: all changed source, tests, frontend, packaging and safe fixture files

**Interfaces:**

- Consumes: 8/8 capability、完整代码、safe acceptance evidence。
- Produces: v0.2.0 source、Portable ZIP、release audit、现有仓库默认分支与 latest Release。

- [ ] **Step 1: 统一当前文档**

当前口径固定为：

- Production betting transport: browser-page-fetch。
- Capability: 八方向 Preview/Submit/Reconciliation 全部 verified。
- Monitor: read-only v2 主链保持不变，只输出完整 canonical candidates。
- 字段库: capability matrix + safe fixtures。
- Submit: B2 exactly-once；unknown 不重投。

历史 0/0/0、1/1/0、直接 HTTP 和旧累计 Gate 段落明确标记 Historical/Superseded，不删除真实历史。

- [ ] **Step 2: 写可重复的运行体检与 release candidate 工具**

scripts/crown-runtime-health-audit.mjs 必须实际启动本地 Dashboard/Watcher/Worker fixture，使用 Playwright 检查页面并输出脱敏 JSON：

~~~javascript
{
  schemaVersion: 'crown-runtime-health-v1',
  uniqueOwners: true,
  heartbeatsFresh: true,
  capabilityReadyCount: 8,
  unknownCount: 0,
  orphanChromiumCount: 0,
  orphanLeaseCount: 0,
  orphanAccountLockCount: 0,
  desktopOk: true,
  mobileOk: true,
  consoleErrorCount: 0,
}
~~~

scripts/crown-release-candidate.ps1 使用 try/finally 和每条 native command 的 LASTEXITCODE 检查，从指定 commit 创建 GUID clean worktree，安装依赖、运行完整测试、构建 frontend/dist、构建/双重审计 ZIP、执行仓库外 smoke，并返回 artifact path/hash/size/commit。失败时也要安全移除临时 worktree。新增测试必须覆盖 native failure、旧 ZIP 冲突、缺 frontend/dist、hash/size mismatch 和 finally cleanup。

Windows workflow 必须先准备并校验锁定 Chromium，再执行 browser E2E；通过明确环境变量传 executable，禁止系统 Chrome 或临时 Playwright 下载。

- [ ] **Step 3: 运行当前 candidate 的完整自动化验证**

Run:

~~~powershell
npm test
npm run check
npm run crown:frontend:test
npm run crown:frontend:build
docker compose -p crown-dashboard config
git diff --check
~~~

Expected: 所有命令 exit 0。

- [ ] **Step 4: 启动全部功能并做浏览器验收**

Run:

~~~powershell
node scripts/crown-runtime-health-audit.mjs --fixture --desktop 1440x900 --mobile 390x844
~~~

实际启动 Dashboard、Watcher 和 Betting Worker fixture，验证：

- Watcher prematch/live 都有唯一 owner 和新鲜 heartbeat。
- Operations 显示 browser-page-fetch 和 8/8 ready。
- Betting Accounts 的人工登录入口可用；停止/重启使用 Operations 全局 Worker 控制。
- 规则卡、比赛、账号、历史、unknown/对账区域正常。
- real betting start/stop、紧急停止、程序重启后恢复正确。
- 浏览器桌面 1440×900、移动端 390×844 无溢出、空白或控制台错误。
- 停止后无孤儿 Chromium、Profile lease、account lock 或 Worker。

- [ ] **Step 5: 执行运行数据与敏感信息审计**

Run:

~~~powershell
git status --short
git ls-files | rg -i "sqlite|cookie|session|profile|raw-network|\\.env$|secret|token"
rg -n -i "BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|password\\s*[:=]|authorization\\s*[:=]|cookie\\s*[:=]|C:(?:\\)+Users(?:\\)+[^\\\s]+" --glob "!data/runtime/**" --glob "!node_modules/**"
~~~

Expected: Git 仅包含允许的源码、脱敏 fixture 和文档；无真实凭据、runtime、Profile、数据库或私有抓包。

- [ ] **Step 6: 写入 v0.2.0 元数据并提交 release candidate**

Run:

~~~powershell
npm pkg set version=0.2.0
npm install --package-lock-only --ignore-scripts
git add package.json package-lock.json README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md docs/modules/crown-football-monitor.md docs/modules/crown-dashboard.md docs/betting-architecture.md docs/betting-contract.md docs/github-release-runbook.md scripts/crown-runtime-health-audit.mjs scripts/crown-release-candidate.ps1 tests/crown-runtime-health-audit.test.mjs tests/crown-release-candidate.test.mjs .github/workflows/windows-release-build.yml tests/crown-release-workflow.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs release/windows-production-allowlist.json
git diff --cached --name-status
git commit -m "release: prepare Crown browser API betting v0.2.0"
~~~

Expected: release candidate commit 只包含已验证的程序、文档和版本元数据；工作区中其他用户文件不进入 commit。

- [ ] **Step 7: 从 HEAD clean worktree 做推送前 candidate 验证**

执行时使用 superpowers:using-git-worktrees；锁定 Node/Chromium runtime 目录必须已经按 release/windows-runtime-lock.json 校验。

Run:

~~~powershell
if (-not $env:CROWN_NODE_RUNTIME_DIR) { throw "CROWN_NODE_RUNTIME_DIR is required" }
if (-not $env:CROWN_CHROMIUM_RUNTIME_DIR) { throw "CROWN_CHROMIUM_RUNTIME_DIR is required" }
powershell -ExecutionPolicy Bypass -File scripts/crown-release-candidate.ps1 -Commit (git rev-parse HEAD) -NodeRuntime $env:CROWN_NODE_RUNTIME_DIR -ChromiumRuntime $env:CROWN_CHROMIUM_RUNTIME_DIR -Mode VerifyOnly
~~~

Expected: 脚本创建的 clean worktree 中 backend、syntax、frontend tests、frontend build、browser E2E、runtime health、Portable build 和双重 audit 全绿；frontend/dist/index.html 存在；git status --porcelain 与 git diff --exit-code 都为空。该结果只证明当前 HEAD 可发布，最终资产仍必须从远端默认分支的精确 ReleaseCommit 重新生成。

- [ ] **Step 8: 核对远端、默认分支与发布冲突**

Run:

~~~powershell
$originUrl = git remote get-url origin
if ($originUrl -notmatch "github\\.com[:/]Austin-C1/hg-\\.git$") { throw "unexpected-origin" }
gh repo view Austin-C1/hg- --json 'nameWithOwner,defaultBranchRef'
if ($LASTEXITCODE -ne 0) { throw "repo-view-failed" }
git fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw "git-fetch-failed" }
$defaultBranch = gh repo view Austin-C1/hg- --json 'defaultBranchRef' --jq '.defaultBranchRef.name'
git rev-parse --verify "origin/$defaultBranch"
if ($LASTEXITCODE -ne 0) { throw "remote-default-missing" }
git ls-remote --exit-code --tags origin refs/tags/v0.2.0
if ($LASTEXITCODE -eq 0) { throw "release-tag-already-exists" }
gh release view v0.2.0 --repo Austin-C1/hg- *> $null
if ($LASTEXITCODE -eq 0) { throw "release-already-exists" }
~~~

Expected: origin 精确指向同一仓库，使用远端实际默认分支，不凭本地假定 main，v0.2.0 Tag/Release 均不存在。

- [ ] **Step 9: Fast-forward 或 PR 更新同一仓库默认分支**

Run:

~~~powershell
git merge-base --is-ancestor "origin/$defaultBranch" HEAD
$needsPr = $LASTEXITCODE -ne 0
if (-not $needsPr) {
  git push origin "HEAD:$defaultBranch"
  $needsPr = $LASTEXITCODE -ne 0
}
if ($needsPr) {
  git push -u origin HEAD:codex/crown-browser-api-betting-v020
  if ($LASTEXITCODE -ne 0) { throw "feature-push-failed" }
  $prUrl = gh pr create --repo Austin-C1/hg- --base $defaultBranch --head codex/crown-browser-api-betting-v020 --title "Crown browser API betting v0.2.0" --body "Replace the existing Crown betting transport with the verified browser-page API runtime."
  if ($LASTEXITCODE -ne 0) { throw "pr-create-failed" }
  gh pr checks $prUrl --watch
  if ($LASTEXITCODE -ne 0) { throw "pr-checks-failed" }
  gh pr merge $prUrl --merge --delete-branch
  if ($LASTEXITCODE -ne 0) { throw "pr-merge-failed" }
}
~~~

若默认分支保护拒绝 direct push，或 HEAD 不是 origin/default 的 fast-forward 后代，则在同一仓库创建 PR，等待 checks 全绿后 merge；禁止 force push。merge 产生新 commit 时不能复用推送前构建物。

完成后执行：

~~~powershell
git fetch origin --prune
$ReleaseCommit = git rev-parse "origin/$defaultBranch"
if (-not $ReleaseCommit) { throw "release-commit-missing" }
~~~

Expected: 现有仓库默认分支已经包含完成版源码；$ReleaseCommit 是唯一后续测试、Tag 和 Portable 构建来源。

- [ ] **Step 10: 从精确 ReleaseCommit 重跑全测并生成最终资产**

Run:

~~~powershell
$releaseJson = powershell -ExecutionPolicy Bypass -File scripts/crown-release-candidate.ps1 -Commit $ReleaseCommit -NodeRuntime $env:CROWN_NODE_RUNTIME_DIR -ChromiumRuntime $env:CROWN_CHROMIUM_RUNTIME_DIR -Mode BuildFinal
if ($LASTEXITCODE -ne 0) { throw "final-release-candidate-failed" }
$release = $releaseJson | ConvertFrom-Json
if ($release.commit -ne $ReleaseCommit) { throw "release-commit-mismatch" }
$ArtifactPath = $release.artifactPath
$zipSha = $release.sha256
$zipSize = [int64]$release.size
~~~

Expected: helper 的 GUID clean worktree 在 frontend build 后存在 frontend/dist/index.html；backend、frontend、syntax、Dashboard/Crown browser E2E、runtime health、Portable build、解压后二次 audit 和仓库外 smoke 全绿；worktree 的 git status 与 diff 为空；最终 ZIP 只来自 $ReleaseCommit。

- [ ] **Step 11: Tag、等待 pinned Actions 与 Fresh Windows smoke**

Run:

~~~powershell
git tag -a v0.2.0 $ReleaseCommit -m "Crown browser API betting v0.2.0"
if ($LASTEXITCODE -ne 0) { throw "tag-create-failed" }
git push origin v0.2.0
if ($LASTEXITCODE -ne 0) { throw "tag-push-failed" }
~~~

等待该 Tag/commit 的 pinned windows-release-build workflow 完成；workflow 必须使用锁定 runtime 跑相同 browser E2E、构建和 Portable smoke。随后在 Windows 10/11 x64 Sandbox/VM 中运行 scripts/crown-release-candidate.ps1 生成的 smoke 入口，确认只使用包内 Node/Chromium、Dashboard 可打开、快捷方式正确、无系统 Chrome/Node 依赖。Fresh Windows 证据只保存版本、commit、系统版本、测试矩阵和 ZIP hash/size。

- [ ] **Step 12: 创建 latest Release 并下载复核**

Run:

~~~powershell
$releaseNotes = "Windows x64 Portable；浏览器内 API 投注；八方向验证通过；Commit: $ReleaseCommit；SHA256: $zipSha；Size: $zipSize bytes。"
gh release create v0.2.0 $ArtifactPath --repo Austin-C1/hg- --verify-tag --title "v0.2.0 Crown Browser API Betting" --notes $releaseNotes --latest
if ($LASTEXITCODE -ne 0) { throw "release-create-failed" }
$latestTag = gh release view --repo Austin-C1/hg- --json 'tagName' --jq '.tagName'
if ($latestTag -ne "v0.2.0") { throw "release-is-not-latest" }
gh release view v0.2.0 --repo Austin-C1/hg- --json 'tagName,targetCommitish,assets'
if ($LASTEXITCODE -ne 0) { throw "release-view-failed" }
$DownloadDir = Join-Path $env:TEMP ("crown-release-download-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $DownloadDir | Out-Null
gh release download v0.2.0 --repo Austin-C1/hg- --pattern "CrownMonitor-v0.2.0-windows-x64-portable.zip" --dir $DownloadDir
if ($LASTEXITCODE -ne 0) { throw "release-download-failed" }
$downloadedZip = Join-Path $DownloadDir "CrownMonitor-v0.2.0-windows-x64-portable.zip"
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $downloadedZip).Hash.ToLowerInvariant() -ne $zipSha) { throw "release-asset-sha256-mismatch" }
if ((Get-Item -LiteralPath $downloadedZip).Length -ne $zipSize) { throw "release-asset-size-mismatch" }
git fetch origin --prune
if ((git rev-parse "origin/$defaultBranch") -cne $ReleaseCommit) { throw "remote-default-does-not-match-release-commit" }
~~~

Expected: v0.2.0 是 latest；默认分支、Tag、Actions、Fresh Windows 通过的 Portable 和下载资产全部精确绑定同一个 $ReleaseCommit；原仓库旧程序已被新版本直接替代，没有创建第二仓库。

---

## 阶段依赖与并行边界

| 阶段 | 内容 | 依赖 | 是否可并行 |
|---|---|---|---|
| 1 | 基线与旧计划替代 | 无 | 否 |
| 2 | 全接口抓包与八方向零 Submit 候选 | 1 | 可与阶段 5 的纯 transport 单测并行 |
| 3 | side-aware 字段库 | 2 | 否 |
| 4 | 监控候选兼容 | 3 | 可与阶段 5 并行，文件不重叠 |
| 5 | Browser 会话与 transport | 1；实际 endpoint 来自 2 | 可与 4 并行 |
| 6 | Provider/B2/Reconciliation 接线 | 3、5 | 否 |
| 7 | API 与前端 | 3、5、6 的 DTO | 后端 DTO 完成后可拆前端 |
| 8 | 验收 runner 与本地 E2E | 3、5、6 | 可与 7 后半段并行 |
| 9 | 八方向真实最小金额验收 | 2–8 全绿 | 否，必须串行 |
| 10 | 全程序体检与 GitHub 替换 | 9 完成 | 否 |

## 不再执行的旧内容

- 不再把 Node 直接 HTTP Submit 当作目标架构。
- 不再按旧 5 batch、累计 500 CNY 限额拆分 Gate。
- 不再为每个阶段重复执行完整发布、完整 GitHub 或重复人工批准。
- 不删除 SQLite 账本、账号锁、B2、unknown、不重投、脱敏与 release audit。
- 不恢复已删除的 legacy adapter、单笔 CLI、bootstrap 或 UI Submit fallback。
- 不要求每次下注重新抓全部字段；只有 protocol library fingerprint 漂移时才重新进入 Task 2/3 的采集与升级流程。

## 预计最终运行方式

正常运行不再执行 protocol capture。抓包器仅在 Crown 协议发生字段漂移时作为维护工具使用。日常链路为：

~~~text
监控持续更新 active markets
  -> 规则命中
  -> 内存字段索引按八方向 O(1) 选择已验证 wire schema
  -> 复用账号独立常驻浏览器会话
  -> fresh Preview
  -> B2 单次 Submit
  -> accepted / unknown
  -> exact result query
  -> 前端展示与持久化
~~~
