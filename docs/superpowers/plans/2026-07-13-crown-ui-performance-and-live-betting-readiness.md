# Crown 页面性能、Checkbox 与真实投注完备计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务执行并在每项后独立复核。

**Goal:** 消除 Dashboard 菜单切换的长时间加载和 Checkbox 勾号偏移，并在不绕过现有 B1/B2 安全门的前提下，补齐 Crown 真实 preview、submit、reconciliation 能力以及最终受控小额验收。

**Architecture:** UI 阶段使用 SQLite `monitor_*_state` 作为当前比赛投影，JSONL 继续只承担审计历史；比赛详情仍按 `eventKey` 按需读取变化历史，不建设变化索引。真实投注阶段继承现有 card-scoped Signal/inbox/batch、ExecutionAuthorization、fenced worker、unknown 不重投和 B2 recovery，只新增 canonical 协议证据、生产 Provider/对账来源、动态卡资格与授权操作面。

**Tech Stack:** Node.js 22、`node:sqlite`、React 18、TypeScript、Ant Design 5、Node test runner、Vitest、Playwright。

## Global Constraints

- 不重建 B1/B2 账本、Worker、授权预算、recovery、通知或动态规则卡 schema。
- 不恢复旧 `crown-bet-execute*.mjs` 的 real flags；旧入口必须继续 `legacy-real-entry-disabled`。
- 不建设赔率变化历史索引，不修改 `/api/changes` 的审计语义。
- 普通开发、测试、构建和浏览器验收不得调用真实 `FT_bet`。
- Task 7、Task 8 和 Task 12 是三个独立硬停点；每次都需要用户在该次执行中重新确认对应的账号、比赛、盘口、网络或资金操作。Task 8/12 还必须确认金额和最大损失。
- capability 不得由 fixture、布尔参数或 UI 开关伪造；同一 exact row 必须分别拥有 preview、submit、reconciliation 的可核验证据。
- timeout、disconnect、pending、歧义或无匹配一律保持 `unknown` 和账号/金额锁，禁止自动重投。
- 计划实施阶段不自动修改正式数据库、不重启正式 8787、不启用投注账号、不启动 real worker、不提交 Git；这些操作均需单独授权。
- 当前权威规则入口仅为 `/betting-rules` 动态卡片；mode 只来自 Signal。

---

### Task 1: SQLite 当前赔率状态投影

**Files:**
- Create: `src/crown/dashboard/current-odds-state.mjs`
- Create: `tests/crown-current-odds-state.test.mjs`

**Interfaces:**
- Produces: `readCurrentOddsState({ dbPath }) -> { events, summary, health }`。
- Reads only: `monitor_event_state`、`monitor_selection_state`、`monitor_scope_state`。

- [ ] **Step 1: 写 RED 测试**

覆盖 active/inactive 过滤、同 selection 最新快照、没有 selection 的 active event、kickoff/timeQuality、非法 JSON warning、空库和敏感字段不外泄。

```js
const result = await readCurrentOddsState({ dbPath })
assert.deepEqual(result.events.items.map((row) => row.eventKey), ['event-active'])
assert.equal(result.summary.source, 'monitor-v2')
assert.equal(JSON.stringify(result).includes('provider_ids_json'), false)
```

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/crown-current-odds-state.test.mjs`

Expected: FAIL，原因是模块或导出尚不存在。

- [ ] **Step 3: 实现最小只读投影**

使用 read-only SQLite 连接；只 JOIN `active=1` 的 event/selection，复用 `buildEvents()` 的 canonical DTO 规则。event-only 行由 `event_json` 补齐；解析失败只形成 allowlisted warning，不返回 raw JSON/provider IDs。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test tests/crown-current-odds-state.test.mjs`

Expected: PASS。

- [ ] **Step 5: 独立复核**

确认该模块不写数据库、不读 JSONL、不改变 active 语义，并记录查询/解析基准。

### Task 2: 页面相关 API 切换为 SQLite 当前状态

**Files:**
- Modify: `src/crown/app/local-config-api.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- Consumes: `readCurrentOddsState({ dbPath })`。
- Preserves: `/api/matches/leagues`、`/api/default-leagues`、`/api/monitor-settings` 当前 DTO。

- [ ] **Step 1: 写 RED API 测试**

给临时库写入 monitor state，同时把 snapshot/change 路径指向不存在文件；断言三个页面接口仍返回 200、联赛/比赛/health 正确，track/untrack 后结果一致。

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/crown-app-api.test.mjs`

Expected: 新增断言 FAIL，因为接口仍调用 `readDashboardData()`。

- [ ] **Step 3: 切换数据源**

`leaguePayload()`、`trackLeague()`、`monitorPayload()` 和 default-leagues GET/PUT 只消费 Task 1 投影；旧 `/api/events`、`/api/changes` 保持兼容，不改历史 API。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test tests/crown-current-odds-state.test.mjs tests/crown-app-api.test.mjs`

Expected: PASS；测试过程不访问 runtime JSONL。

### Task 3: 比赛页首屏、轮询和详情去阻塞

**Files:**
- Modify: `frontend/src/pages/MatchSelection.tsx`
- Modify: `frontend/src/pages/MatchSelection.test.tsx`

**Interfaces:**
- 首屏/30 秒列表刷新只调用 `api.getLeagueSummaries()`。
- 详情只在 Drawer 打开后调用 `api.changes({ eventKey, limit: 1000 })`。

- [ ] **Step 1: 写 RED 交互测试**

覆盖首屏 changes=0、打开详情 changes=1、已有列表/详情的后台刷新不出现 `.ant-spin-blur`、同类请求 single-flight、旧 event 的迟到响应不污染当前 Drawer。

- [ ] **Step 2: 验证 RED**

Run: `npm --prefix frontend test -- --run src/pages/MatchSelection.test.tsx`

Expected: FAIL，因为当前首屏请求 global changes 且后台详情刷新显示整表 Spin。

- [ ] **Step 3: 实现最小状态机**

删除 global `changes` state/request；分别使用 list/detail in-flight ref。只有首次且没有缓存时显示 loading；后台刷新保留现有数据；切换赛事后仅当前 event 可以结束当前 loading。

- [ ] **Step 4: 验证 GREEN**

Run: `npm --prefix frontend test -- --run src/pages/MatchSelection.test.tsx`

Expected: PASS。

### Task 4: Checkbox 勾号居中

**Files:**
- Modify: `frontend/src/styles/index.css`
- Modify: `tests/crown-dashboard-css-contract.test.mjs`

- [ ] **Step 1: 写 CSS contract RED 测试**

断言存在 `.settings-form-grid > label`，禁止宽泛 `.settings-form-grid label`，并禁止用 `.ant-checkbox-inner` transform/position 魔法补丁掩盖根因。

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/crown-dashboard-css-contract.test.mjs`

Expected: FAIL，当前选择器仍命中 Ant `.ant-checkbox-wrapper`。

- [ ] **Step 3: 最小修复**

```css
.settings-form-grid > label { display: grid; gap: 6px; color: #475467; font-size: 12px; }
```

保留 `.settings-form-grid .checkbox-field`，不覆盖 Ant Checkbox 内框尺寸。

- [ ] **Step 4: 验证 GREEN**

Run: `node --test tests/crown-dashboard-css-contract.test.mjs && npm --prefix frontend test -- --run src/pages/MonitorSettings.test.tsx`

Expected: PASS。

### Task 5: UI 性能与响应式验收

**Files:**
- Modify after verification: `docs/modules/crown-dashboard.md`
- Modify after verification: `docs/module-index.md`
- Modify after verification: `docs/project-memory.md`

- [ ] **Step 1: 运行 focused 和全量测试**

```powershell
node --test tests/crown-current-odds-state.test.mjs tests/crown-app-api.test.mjs tests/crown-dashboard-css-contract.test.mjs
npm --prefix frontend test -- --run src/pages/MatchSelection.test.tsx src/pages/MonitorSettings.test.tsx
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: 全部 exit 0。

- [ ] **Step 2: 浏览器性能验收**

在 watcher 持续写入、正式库只读条件下采样 20 次：`/api/matches/leagues` cold P95 ≤ 500ms、warm P95 ≤ 250ms；菜单点击到内容可操作 P95 ≤ 800ms；进入 `/matches` 不请求 global `/api/changes`；30 秒刷新不变灰、不清空、无重叠同类请求。

- [ ] **Step 3: Checkbox 三档视觉验收**

在 1920×1080、1024×768、390×844 检查 7 个选中框：赛前/滚球让球、大小球和滚球上半场/半场/下半场。蓝框约 16×16、白勾居中、文字基线正常、无横向溢出，console error/warning=0。

- [ ] **Step 4: 更新稳定文档**

只记录最终实测数据和已验证边界；删除 project-memory 中对应“待处理”状态。

### Task 6: Canonical 协议证据与只读 preview 准备

**Files:**
- Modify: `scripts/crown-betting-protocol-analyze.mjs`
- Modify: `src/crown/betting-protocol/capture-redaction.mjs`
- Modify: `src/crown/betting-protocol/protocol-classifier.mjs`
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/betting/crown-order-field-mapper.mjs`
- Modify: `src/crown/betting/crown-bet-response-parser.mjs`
- Modify: `src/crown/betting/crown-account-provider.mjs`
- Modify: `src/crown/betting/crown-capability-matrix.mjs`
- Test: `tests/crown-betting-protocol-redaction.test.mjs`
- Test: `tests/crown-betting-protocol-classifier.test.mjs`
- Test: `tests/crown-api-login-manager.test.mjs`
- Test: `tests/crown-account-provider.test.mjs`
- Test: `tests/crown-capability-matrix.test.mjs`

**Interfaces:**
- Produces sanitized evidence containing exact field sets/fingerprints、response code 和不可逆 linkage tag。
- Must not persist: uid、cookie、password、raw ticket、raw request/response body。

- [ ] **Step 1: 写 RED 安全与关联测试**

覆盖动态 `ver` 来源、preview exact request/response fingerprint、event/line/side/stake 关联，以及所有敏感字段/绝对路径拒绝。

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/crown-betting-protocol-redaction.test.mjs tests/crown-betting-protocol-classifier.test.mjs tests/crown-api-login-manager.test.mjs tests/crown-account-provider.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: FAIL，当前 login/session 没有提供已证明的 protocolVersion，preview row 仍 blocked。

- [ ] **Step 3: 实现证据链**

只从已捕获、可验证的 production response/session 元数据提取 protocolVersion；mapper/parser 对 exact field set fail-closed。证据不完整时 `previewAllowed=false`、`realExecutionEligible=false`。

- [ ] **Step 4: 离线 GREEN**

运行同一 focused 命令；Expected: PASS，并且 capability 仍保持 `0/0/0`，直到真实只读证据经 Task 7 验证。

### Task 7: 受控只读 preview 证据硬停点

**Files:**
- Evidence only after authorization: sanitized fixture/artifact under `data/fixtures/crown/betting-protocol/`
- Modify after evidence review: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: 停止并请求当次授权**

向用户展示账号、exact event/mode/period/market/line/side、只读 endpoint、网络请求清单和输出脱敏规则。没有当次授权则记录 `NOT_EXECUTED` 并停止；不得降低 matrix gate。

- [ ] **Step 2: 只读 capture**

仅允许 login、game list/member data、`FT_order_view`；断言 `FT_bet=0`。验证 line/odds/min/max/currency/step/balance 与 locked identity exact 一致。

- [ ] **Step 3: 固化并审核证据**

产物只保存 allowlisted 字段、hash 和不可逆关联；运行 redaction/capability tests。只有同一 exact row 证据完整时才允许把该 row 的 `previewAllowed` 改为 true；submit/reconciliation 仍 false。

### Task 8: 单笔协议 submit/reconciliation 取证硬停点

**Files:**
- Existing controlled harness: `scripts/crown-betting-protocol-capture.mjs`
- Evidence only after authorization: sanitized fixture/artifact
- Modify after evidence review: `docs/crown-betting-protocol-map.md`

- [ ] **Step 1: 前置检查**

要求 Task 7 exact preview 已通过；worker/global real 均 off；使用临时/克隆 DB；无 active batch/unknown；单账号、单赛事、单盘口；备份 DB/runtime；页面无 CAPTCHA/异常。

- [ ] **Step 2: 停止并请求新的真实资金授权**

展示账号、比赛、盘口、实时赔率、金额、最大损失和异常处理。必须由用户在本次执行明确确认；不得沿用旧授权。

- [ ] **Step 3: 只执行一次受控 capture**

入口必须保留 `--allow-real-submit --max-stake <用户确认金额> --confirm REAL_BET`、可见浏览器和硬上限；只允许一次 `FT_bet`。随后只读查询 `get_dangerous`/今日注单，关联 accepted/rejected/pending/odds-changed 和 exact provider reference。

- [ ] **Step 4: 异常即停止**

timeout/disconnect/pending/无唯一匹配时不得再投；证据不足则 matrix 保持 submit/reconciliation false。

### Task 9: Production submit Provider 与 reconciliation source

**Files:**
- Modify: `src/crown/betting/crown-order-field-mapper.mjs`
- Modify: `src/crown/betting/crown-bet-response-parser.mjs`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs`
- Create: `src/crown/betting/crown-reconciliation-source-client.mjs`
- Modify: `src/crown/betting/real-worker-factory.mjs`
- Modify: `src/crown/betting/b2-reconciler.mjs`
- Modify: `src/crown/betting/crown-capability-matrix.mjs`
- Test: `tests/crown-account-provider.test.mjs`
- Test: `tests/crown-betting-b2-reconciliation.test.mjs`
- Create: `tests/crown-account-execution-provider.test.mjs`
- Create: `tests/crown-reconciliation-source-client.test.mjs`
- Modify: `tests/crown-betting-security-audit.test.mjs`

- [ ] **Step 1: 写 RED provider/reconcile 测试**

覆盖 exact field set、fence/session owner、identity/preview 二次复核、网络边界只调用一次 `onNetworkStarted()`、accepted/rejected/pending/odds_changed_unsent/disconnect、provider reference 加密，以及 reconciliation matchCount 必须等于 1。

- [ ] **Step 2: 验证 RED**

Run: `node --test tests/crown-account-execution-provider.test.mjs tests/crown-reconciliation-source-client.test.mjs tests/crown-betting-b2-reconciliation.test.mjs tests/crown-betting-security-audit.test.mjs`

Expected: FAIL，当前 production submit/source 明确 unavailable。

- [ ] **Step 3: 最小实现**

Provider 只能由 module-private trusted factory 构造，普通 caller 不得注入 transport/capability。只使用 Task 8 已证明的 exact endpoint/fields；原始 ticket/body 不离开 Provider。reconciliation 用 account session + encrypted provider ref + locked identity 唯一匹配；无唯一结果保持 unknown。

- [ ] **Step 4: GREEN 与 matrix gate**

只有 Task 8 证据和测试同时通过时，才允许同一 exact row 的 submit/reconciliation=true；其他 row 保持 false。

### Task 10: 动态卡真实资格、执行授权与账号余额操作面

**Files:**
- Modify: `src/crown/betting/execution-gate.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/AutoBetRules.tsx`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Test: `tests/crown-execution-gate.test.mjs`
- Test: `tests/crown-auto-betting-rule-card-api.test.mjs`
- Test: `tests/crown-card-scoped-betting-integration.test.mjs`
- Test: `frontend/src/pages/AutoBetRules.test.tsx`
- Test: `frontend/src/pages/OperationsConsole.test.tsx`

- [ ] **Step 1: 写 RED 资格/授权测试**

新增 audited card eligibility upgrade/revoke：必须 expectedEligibilityVersion、exact capability matrix version、卡片 enabled、migration review cleared、金额≤hard cap。授权必须绑定 cardId+eligibilityVersion+mode、预算和短有效期；普通 CRUD 仍不能升级。

- [ ] **Step 2: 写 RED 余额测试**

只有已证明的 exact integer CNY 余额和 fresh timestamp 才能写 `balance_minor`；禁止用浮点 Number，reported balance 仍与执行余额分开显示。证据/币种不完整则账号保持 paused。

- [ ] **Step 3: 实现 API/UI**

规则卡展示资格升级/撤销；Operations 创建/撤销短期授权并显示范围、预算、到期时间，不显示 confirmation digest。capability 不是 exact true 时所有按钮禁用并显示稳定阻断原因。

- [ ] **Step 4: focused GREEN**

运行上述 backend/frontend focused tests；Expected: PASS，fixture capability 不能打开 production 操作。

### Task 11: 全链离线安全验收

**Files:**
- Modify as needed: `tests/crown-real-betting-runtime.test.mjs`
- Modify as needed: `tests/crown-card-scoped-betting-integration.test.mjs`
- Modify as needed: `tests/crown-betting-b2-executor.test.mjs`
- Modify as needed: `tests/crown-betting-b2-reconciliation.test.mjs`
- Modify as needed: `tests/crown-betting-security-audit.test.mjs`

- [ ] **Step 1: sanitized fixture 端到端**

走 Card Signal→inbox→batch→preview→submit→accepted/rejected/unknown→reconcile，覆盖 prepare/dispatch/result 四个崩溃窗口。

- [ ] **Step 2: 安全不变量**

断言每个 immutable attempt 网络 submit≤1；unknown 重启后 submit=0；旧 CLI/default mode 网络/FT_bet=0；capability/authorization/card version/余额 freshness 任一缺失均 fail-closed。

- [ ] **Step 3: 全量验证**

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
docker compose -p crown-dashboard config --quiet
```

Expected: 全部 exit 0；测试不得访问真实 Crown/Telegram。

- [ ] **Step 4: 独立安全复核**

分别审查协议映射、秘密/输出、授权预算、TOCTOU、unknown/reconcile 和旧入口零网络。Critical/Important 必须全部清零。

### Task 12: 最终受控真实小额 E2E 硬停点

**Files:**
- Evidence/report only after authorization: `.superpowers/sdd/evidence/`
- Modify after verified outcome: `docs/project-memory.md`、`docs/module-index.md`、`docs/modules/crown-betting-protocol.md`

- [ ] **Step 1: 必须满足全部前置条件**

至少一个 exact row 的 preview/submit/reconciliation 均为 true；正式库备份与 integrity/FK 通过；worker=0、无 batch/unknown；单卡、单 mode、单账号；账号 fresh balance；watcher/odds fresh；15 分钟授权；金额≤用户确认值和环境 hard cap。

- [ ] **Step 2: 停止并请求最终当次授权**

向用户展示完整 preflight、账号、卡片、比赛、盘口、实时赔率、金额、最大损失、授权到期和 unknown 处理。未获得本次明确授权则记录 `NOT_EXECUTED`，系统保持 off。

- [ ] **Step 3: 只能从 Dashboard ready-ticket/GO 启动**

观察唯一 batch/child/attempt，核对 Crown 注单和本地 accepted/rejected/unknown，验证通知、授权预算和锁。禁止使用旧 CLI。

- [ ] **Step 4: 收尾**

立即 stop、revoke authorization、revoke card eligibility。若 uncertain，则保留 unknown/锁，只走 reconciliation/manual_review，禁止第二笔。记录脱敏证据、最终 capability 和余额/账本不变量。

## Dependency Order

`Task 1 → 2 → 3 → 4 → 5` 完成 UI 修复；真实投注为 `Task 6 → 7（授权）→ 8（新授权）→ 9 → 10 → 11 → 12（最终新授权）`。

UI 阶段与 Task 6 的纯离线代码可并行，但任何真实网络/资金步骤必须按上述顺序串行执行。

## Plan Self-Review

- 继承而不重复 B1/B2、C runtime、安全开工和动态卡片完成成果。
- 不恢复旧 real CLI，不新建第二套账本/Worker/adapter。
- UI 计划不包含 changes 历史索引。
- Task 7、8、12 均为显式硬停点；无当次授权即可安全结束计划。
- capability、card eligibility、authorization、account balance、runtime intent 五层不能互相替代。
- 没有占位任务；所有真实执行前置和失败状态均明确 fail-closed。

## Execution Choice

推荐使用 Subagent-Driven：Task 1–5 按任务实现与复核；Task 6–11 由协议、Provider/对账、API/UI 三个边界分开实施并逐项安全审查；Task 7、8、12 到达时必须暂停等待用户授权。
