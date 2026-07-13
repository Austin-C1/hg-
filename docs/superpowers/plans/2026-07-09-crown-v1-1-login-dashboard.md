# Crown V1.1 自动登录基础版 + Dashboard 中文瘦身开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现皇冠 `mon_primary` 单账号自动登录基础闭环，并把 Dashboard 普通页面改成中文、简洁、面向使用的展示。

**Architecture:** 登录能力从 `scripts/crown-watch.mjs` 拆到 `src/crown/login/*`。当前主路径由 `CrownApiLoginManager` 直连 `transform_nl.php` / `transform.php` 完成 API session 登录和 XML 复验；`CrownLoginManager.ensureLogin()` 保留为 cookies/storageState、账号密码页面登录、session 复验和诊断保存的兜底路径。Dashboard 继续使用 SQLite + JSONL 数据，但比赛页和账号页通过中文标签、统一时间格式、简化数据源卡片隐藏调试字段；本地调试面板允许展示 cookie、token、密码、input value 等登录诊断内容。

**Tech Stack:** Node.js ESM, Playwright, node:sqlite, React 18, Vite, TypeScript, Ant Design 5, JSONL runtime data.

---

## 0. 完成检查（2026-07-09）

本阶段已完成。原计划的网页登录 cookies/storageState 主路径，在开发中根据 `Austin-C1/odds-monitor` 的实现方式调整为 Crown XML API 直连主路径：

- 主路径：`CrownApiLoginManager` 调用 `POST /transform_nl.php p=chk_login`，保存 `api-session.json`，再用 `POST /transform.php p=get_game_list` 验证和轮询赔率。
- 兜底路径：`CrownLoginManager`、cookies/storageState、页面登录诊断仍保留，用于无 API 凭据、页面诊断或后续验证。
- Dashboard “测试登录”验收已通过：显示 `登录结果：已登录`，登录方式为 `接口登录` 或 `接口缓存`，`storageStateStatus=不适用` 属于 API 主路径的正常结果。
- 普通 Dashboard 页面中文瘦身已完成：比赛页不再显示 `source=...`、`oddsId=null / not available`、`disabled-preview-only`、`recordCount` 等调试字段。
- 自动下注、盘口点击、金额填写、注单提交仍不属于本阶段。

最新验证结果：

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
node scripts\crown-watch.mjs --login-test --app-db storage\crown.sqlite --runtime-dir data\runtime --max-seconds 60
node scripts\crown-watch.mjs --app-db storage\crown.sqlite --runtime-dir data\runtime --max-seconds 5 --dom-poll-seconds 5
```

验收输出摘要：

| 项目 | 结果 |
|---|---|
| 后端测试 | 104 tests passed |
| 语法检查 | Syntax OK: 68 `.mjs` files |
| 前端测试 | 3 files / 16 tests passed |
| 前端构建 | build 成功 |
| 测试登录短跑 | `ok=true`、`status=已登录`、`loginMethod=接口缓存`、`xmlVerified=true`、`sessionVerified=true` |
| 正常 watcher 短跑 | `xmlResponses=1`、`getGameListCount=1`、`xmlEvents=38`、`normalizedRecords=646`、`errors=0` |
| Dashboard 浏览器验收 | “测试登录”显示已登录；`/matches` 无旧调试字段；console 无错误 |

## 1. 原始判断与当前状态

当前项目已经具备 Playwright 打开皇冠页面、SQLite 保存 `mon_primary`、Dashboard 启停 watcher、XML 监听和 JSONL 写入的基础。

计划创建时，真实自动登录还没有确认成功。当时运行日志显示：

```text
login-form-not-found
pageTitle: Welcome
xml-login-expired
page.evaluate: Target page, context or browser has been closed
```

V1.1 的核心验收不是“代码里有登录函数”，而是点击“测试登录”后前端明确显示：

```text
登录结果：已登录
登录方式：cookies 或 账号密码
XML 验证：成功 或 页面 session 已验证
```

当前状态：上述问题已通过 Crown XML API 直连登录解决。Dashboard 点击“测试登录”已显示 `登录结果：已登录`，且正常 watcher 短跑可直接拉取 `get_game_list` XML。

## 2. 用户确认的开发口径

- 前端本地调试页面可以展示 cookie、token、密码、账号、input value 等内容。
- 登录诊断文件可以保存 cookie、token、uid、authorization、set-cookie、密码、账号明文等信息。
- 这些信息用于本机开发和排错，不提交到代码仓库。
- V1.1 先做 `mon_primary` 单账号。
- 自动下注、盘口点击、金额填写、注单提交是后续模块，不在本次实现。

## 3. 文件变更清单

### 新增后端模块

| 文件 | 职责 |
|---|---|
| `src/crown/login/crown-cookie-store.mjs` | 读写 `data/runtime/crown-sessions/mon_primary/cookies.json` 和 `storage-state.json` |
| `src/crown/login/crown-session-detector.mjs` | 从页面、登录表单、Welcome、XML 登录失效响应判断 session 状态 |
| `src/crown/login/crown-login-diagnostics.mjs` | 登录失败时保存截图和 `snapshot.json` |
| `src/crown/login/crown-login-manager.mjs` | 对外提供 `ensureLogin()`，管理 cookies 优先、账号密码 fallback、登录态保存和复验 |

### 新增前端模块

| 文件 | 职责 |
|---|---|
| `frontend/src/utils/crownLabels.ts` | 盘口、模式、状态、方向中文映射 |
| `frontend/src/utils/formatDateTime.ts` | ISO 时间转 `YYYY-MM-DD HH:mm:ss` |
| `frontend/src/components/SourceStatusCard.tsx` | 比赛页顶部数据源简略状态卡片 |

### 修改后端文件

| 文件 | 修改点 |
|---|---|
| `scripts/crown-watch.mjs` | 移除内置登录堆叠逻辑，调用 `CrownLoginManager.ensureLogin()`；增加 `--login-test` 短跑模式；修 page closed 刷屏 |
| `src/crown/app/app-db.mjs` | `monitor_accounts` 增加登录测试结果字段 |
| `src/crown/app/app-repository.mjs` | 保存和读取 `lastLoginResult`、诊断路径；支持运行时更新 |
| `src/crown/app/app-validation.mjs` | 校验登录结果 payload |
| `src/crown/app/app-api.mjs` | `test-login` 改为独立短跑并返回/保存 LoginResult；新增诊断读取 API |
| `src/crown/app/monitor-process.mjs` | 支持等待式短跑 `runLoginTest()` |
| `src/crown/dashboard/dashboard-data.mjs` | 保留调试字段给 API，但普通前端不展示 |
| `.gitignore` | 忽略 `data/runtime/crown-sessions/` 和 `data/runtime/login-diagnostics/` |

### 修改前端文件

| 文件 | 修改点 |
|---|---|
| `frontend/src/types.ts` | 增加 `LoginResult`、`LoginDiagnostics`、登录测试字段 |
| `frontend/src/services/api.ts` | 增加测试登录和诊断读取返回类型 |
| `frontend/src/pages/CrownMonitorAccount.tsx` | 展示测试登录结果和诊断内容 |
| `frontend/src/pages/MatchSelection.tsx` | 使用 `SourceStatusCard`、中文标签、格式化时间 |
| `frontend/src/pages/BettingRules.tsx` | 盘口类型显示中文 |
| `frontend/src/App.contract.test.tsx` | 更新页面契约测试 |

### 新增测试

| 文件 | 覆盖点 |
|---|---|
| `tests/crown-cookie-store.test.mjs` | cookies/storageState 读写、路径固定、过期判断 |
| `tests/crown-session-detector.test.mjs` | 页面状态、登录表单、Welcome、人机验证、XML 登录失效判断 |
| `tests/crown-login-diagnostics.test.mjs` | 诊断目录、截图占位、snapshot 结构和值保存 |
| `tests/crown-login-manager.test.mjs` | cookies 成功、cookies 失效 fallback、凭据登录成功、表单未找到诊断 |
| `tests/crown-watch-login-test.test.mjs` | `--login-test` 短跑写入 LoginResult |
| `frontend/src/utils/crownLabels.test.ts` | 中文映射 |
| `frontend/src/utils/formatDateTime.test.ts` | 时间格式 |
| `frontend/src/App.contract.test.tsx` | 页面不再显示调试字段，账号页显示测试登录结果 |

## 4. 数据结构设计

### 4.1 LoginResult

后端和前端统一使用：

```js
{
  ok: true,
  accountId: 'mon_primary',
  status: '已登录',
  loginMethod: 'cookies',
  cookieStatus: '已加载',
  storageStateStatus: '已加载',
  xmlVerified: true,
  sessionVerified: true,
  diagnosticPath: '',
  debugSnapshot: null,
  startedAt: '2026-07-09T00:00:00.000Z',
  finishedAt: '2026-07-09T00:00:05.000Z',
  message: ''
}
```

失败示例：

```js
{
  ok: false,
  accountId: 'mon_primary',
  status: '表单未找到',
  loginMethod: 'credentials',
  cookieStatus: '已过期',
  storageStateStatus: '不存在',
  xmlVerified: false,
  sessionVerified: false,
  diagnosticPath: 'data/runtime/login-diagnostics/20260709-041500-mon_primary',
  debugSnapshot: {
    title: 'Welcome',
    url: 'https://example.invalid',
    classifiedState: 'Welcome 页面',
    inputs: [],
    buttons: [],
    iframes: [],
    cookies: [],
    storageState: null,
    errorMessage: '未找到账号或密码输入框'
  },
  startedAt: '2026-07-09T00:00:00.000Z',
  finishedAt: '2026-07-09T00:00:05.000Z',
  message: '未找到账号或密码输入框'
}
```

### 4.2 SQLite 字段

给 `monitor_accounts` 增加：

```sql
last_login_result_json TEXT NOT NULL DEFAULT '{}',
last_login_result_at TEXT NOT NULL DEFAULT '',
last_login_diagnostics_path TEXT NOT NULL DEFAULT ''
```

repository 映射为：

```js
lastLoginResult: object | null
lastLoginResultAt: string | null
lastLoginDiagnosticsPath: string | null
```

### 4.3 本地 session 文件

固定路径：

```text
data/runtime/crown-sessions/mon_primary/
  cookies.json
  storage-state.json
```

### 4.4 本地诊断文件

固定路径：

```text
data/runtime/login-diagnostics/YYYYMMDD-HHmmss-mon_primary/
  screenshot.png
  snapshot.json
```

`snapshot.json` 允许保存：

- title
- url
- classifiedState
- input 的 type/name/id/placeholder/visible/value
- button 的 text/type/visible
- iframe 的 src/title
- 弹窗文本
- 错误 message
- cookie/token/uid/authorization/set-cookie
- 账号和密码明文
- storageState 摘要或完整内容

## 5. 后端开发任务

### Task 1: Cookie Store

**Files:**
- Create: `src/crown/login/crown-cookie-store.mjs`
- Test: `tests/crown-cookie-store.test.mjs`

- [ ] 新增测试：不存在 session 文件时返回 `不存在`。
- [ ] 新增测试：保存 cookies 后能按原样读回。
- [ ] 新增测试：保存 storageState 后能按原样读回。
- [ ] 新增测试：过期 cookies 标记为 `已过期`。
- [ ] 实现 `CrownCookieStore`：
  - `constructor({ accountId, runtimeDir })`
  - `sessionDir()`
  - `cookiesPath()`
  - `storageStatePath()`
  - `readCookies()`
  - `writeCookies(cookies)`
  - `readStorageState()`
  - `writeStorageState(storageState)`
  - `loadIntoContext(context)`
  - `saveFromContext(context)`

### Task 2: Session Detector

**Files:**
- Create: `src/crown/login/crown-session-detector.mjs`
- Test: `tests/crown-session-detector.test.mjs`

- [ ] 新增测试：`Welcome` 标题或正文返回 `Welcome 页面`。
- [ ] 新增测试：登录表单存在返回 `登录失效`。
- [ ] 新增测试：验证码/滑块/二次验证文本返回 `需要人工验证`。
- [ ] 新增测试：足球/盘口页面且无登录表单返回 `已登录`。
- [ ] 新增测试：XML 登录失效 HTML 返回 `登录失效`。
- [ ] 实现：
  - `detectPageSession(page)`
  - `detectSessionFromSnapshot(snapshot)`
  - `detectXmlSession(text)`
  - `isLoginFormSnapshot(snapshot)`
  - `isHumanVerificationText(text)`

### Task 3: Login Diagnostics

**Files:**
- Create: `src/crown/login/crown-login-diagnostics.mjs`
- Test: `tests/crown-login-diagnostics.test.mjs`

- [ ] 新增测试：保存路径格式为 `data/runtime/login-diagnostics/YYYYMMDD-HHmmss-mon_primary`。
- [ ] 新增测试：`snapshot.json` 包含 input value。
- [ ] 新增测试：支持保存 cookies/token/password/debug 信息。
- [ ] 新增测试：截图失败时仍保存 snapshot。
- [ ] 实现：
  - `saveLoginDiagnostics({ page, account, classifiedState, error, runtimeDir, extraDebug })`
  - `collectLoginSnapshot(page, extraDebug)`
  - `readLoginDiagnostics(path)`

### Task 4: CrownLoginManager

**Files:**
- Create: `src/crown/login/crown-login-manager.mjs`
- Test: `tests/crown-login-manager.test.mjs`

- [ ] 新增测试：storageState/cookies 有效时不填写账号密码，返回 `loginMethod=cookies`。
- [ ] 新增测试：cookies 无效时回退账号密码登录。
- [ ] 新增测试：账号密码登录成功后保存 cookies/storageState。
- [ ] 新增测试：表单未找到时保存诊断并返回 `表单未找到`。
- [ ] 新增测试：人机验证时返回 `需要人工验证`。
- [ ] 实现 `ensureLogin({ page, context, account, verifyXml, logger })`。
- [ ] 选择器第一版包含：
  - `input[name="username"]`
  - `input[name="user"]`
  - `input[name="userid"]`
  - `input[name="account"]`
  - `input[name="login"]`
  - `input[name="loginId"]`
  - `input[id*="user" i]`
  - `input[id*="account" i]`
  - `input[type="text"]`
  - `input[type="password"]`
  - `input[name="password"]`
  - `input[name="passwd"]`
  - `input[name="pass"]`
  - `button[type="submit"]`
  - `input[type="submit"]`
  - `button:has-text("登录")`
  - `button:has-text("登入")`
  - `button:has-text("Login")`

### Task 5: SQLite Repository

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Test: `tests/crown-app-db.test.mjs`
- Test: `tests/crown-app-repository.test.mjs`

- [ ] 给 `monitor_accounts` schema 和 migrations 增加三个登录结果字段。
- [ ] `mapMonitorAccount()` 返回 `lastLoginResult`、`lastLoginResultAt`、`lastLoginDiagnosticsPath`。
- [ ] 新增 `repo.updateMonitorAccountLoginResult(accountId, result)`。
- [ ] 测试保存 LoginResult 后 API-facing account 能读到。

### Task 6: watcher 接入登录管理器

**Files:**
- Modify: `scripts/crown-watch.mjs`
- Test: `tests/crown-watch-fixture.test.mjs`
- Test: `tests/crown-watch-login-test.test.mjs`

- [ ] 增加参数 `--login-test`。
- [ ] `runLiveWatch()` 启动后先创建 `CrownLoginManager`。
- [ ] 正常 watcher 启动时先 `ensureLogin()`。
- [ ] 登录成功后再处理 `transform.php` XML。
- [ ] 登录失败时保存 LoginResult 到 SQLite。
- [ ] runtime log 写入：
  - `login-start`
  - `cookie-load-start`
  - `cookie-valid`
  - `cookie-expired`
  - `credential-login-start`
  - `human-verification-required`
  - `credential-login-success`
  - `login-failed`
  - `login-diagnostics-saved`
  - `storage-state-saved`
  - `session-verified`
- [ ] DOM poll 前检查 `page.isClosed()`。
- [ ] page/context/browser 已关闭时停止 poll 或重建一次 page，不持续刷 `Target page, context or browser has been closed`。

### Task 7: 测试登录短跑

**Files:**
- Modify: `src/crown/app/monitor-process.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `scripts/crown-watch.mjs`
- Test: `tests/crown-app-api.test.mjs`

- [ ] `monitorProcess.runLoginTest()` 启动 `node scripts/crown-watch.mjs --login-test --app-db ... --runtime-dir ... --max-seconds 120`。
- [ ] `runLoginTest()` 等待子进程退出，超时后 kill。
- [ ] `/api/app/monitor-account/actions` 收到 `test-login` 时等待短跑结束，再读取并返回最新账号状态。
- [ ] 返回 payload 包含：
  - `item`
  - `loginResult`
- [ ] 保证不依赖长驻 watcher。

### Task 8: 登录诊断读取 API

**Files:**
- Modify: `src/crown/app/app-api.mjs`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`
- Test: `tests/crown-app-api.test.mjs`

- [ ] 新增 `GET /api/app/monitor-account/login-diagnostics`。
- [ ] 默认读取 `lastLoginDiagnosticsPath/snapshot.json`。
- [ ] 返回 `snapshot.json` 原文内容，用于本地调试页展示 cookie/token/password/input value。
- [ ] 文件不存在时返回 `{ item: null }`。

## 6. 前端开发任务

### Task 9: 中文标签和时间格式

**Files:**
- Create: `frontend/src/utils/crownLabels.ts`
- Create: `frontend/src/utils/formatDateTime.ts`
- Test: `frontend/src/utils/crownLabels.test.ts`
- Test: `frontend/src/utils/formatDateTime.test.ts`

- [ ] `crownLabels.ts` 映射：
  - `live -> 滚球`
  - `prematch -> 赛前`
  - `not_started -> 未开赛`
  - `asian_handicap -> 让球`
  - `handicap -> 让球`
  - `moneyline -> 独赢`
  - `total -> 大小球`
  - `first_half -> 上半场`
  - `second_half -> 下半场`
  - `full_time -> 全场`
  - `full_match -> 全场`
  - `home -> 主队`
  - `away -> 客队`
  - `draw -> 和局`
  - `over -> 大`
  - `under -> 小`
- [ ] `formatDateTime()`：
  - null/空/非法值输出 `-`
  - ISO 输出 `YYYY-MM-DD HH:mm:ss`
  - 使用浏览器本机时区
  - 不显示 `T`、`Z`、毫秒

### Task 10: SourceStatusCard

**Files:**
- Create: `frontend/src/components/SourceStatusCard.tsx`
- Modify: `frontend/src/pages/MatchSelection.tsx`

- [ ] XML live 显示：
  - `实时赔率正常`
  - `最近更新：YYYY-MM-DD HH:mm:ss｜今日比赛：N 场`
- [ ] DOM fallback 显示：
  - `使用备用数据`
  - `XML 暂无稳定响应，当前使用页面 DOM 备份数据｜今日比赛：N 场`
- [ ] fixture replay 显示：
  - `离线样本`
  - `当前不是实时数据，仅用于调试展示｜今日比赛：N 场`
- [ ] 普通比赛页不显示：
  - `source=...`
  - `lastXmlAt=...`
  - `xmlResponses=...`
  - `recordCount=...`
  - `changeCount=...`
  - `oddsId=null / not available`
  - `disabled-preview-only`

### Task 11: MatchSelection 中文化

**Files:**
- Modify: `frontend/src/pages/MatchSelection.tsx`

- [ ] 模式列使用 `labelMode()`。
- [ ] 状态列使用 `labelStatus()`。
- [ ] 最近更新使用 `formatDateTime()`。
- [ ] 详情抽屉盘口使用：
  - marketType 中文
  - period 中文
  - side 中文
- [ ] 赔率展示格式为 `主队 0.92 / 客队 0.98`，不显示英文 side。

### Task 12: CrownMonitorAccount 测试登录结果

**Files:**
- Modify: `frontend/src/pages/CrownMonitorAccount.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`

- [ ] `api.monitorAccountAction('test-login')` 接收 `{ item, loginResult }`。
- [ ] 页面展示：
  - cookies：已加载 / 不存在 / 已过期 / 加载失败
  - storageState：已加载 / 不存在 / 加载失败
  - 登录方式：cookies / 账号密码
  - 登录结果：已登录 / 登录失效 / 需要人工处理 / 表单未找到
  - XML 验证：成功 / 未验证 / 失败
  - 诊断文件：路径
- [ ] 增加“查看诊断”按钮。
- [ ] 诊断弹窗展示 snapshot，包括 cookie/token/password/input value。
- [ ] 不自动请求诊断内容，只有点击“查看诊断”才加载。

### Task 13: 下注规则和其他英文瘦身

**Files:**
- Modify: `frontend/src/pages/BettingRules.tsx`
- Modify: `frontend/src/pages/BettingAccounts.tsx`

- [ ] `preview-only` 显示为 `预览模式`。
- [ ] `blocked` 显示为 `未启用`。
- [ ] `manual_review` 显示为 `人工复核`。
- [ ] `monitor_only` 显示为 `只监控`。
- [ ] `future_preview` 显示为 `未来预览`。

## 7. 验证计划

### 自动测试

必须通过：

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

### 本地功能验收

1. 启动 Dashboard：

```powershell
npm run crown:dashboard
```

2. 打开：

```text
http://127.0.0.1:8787/monitor-account
```

3. 保存 `mon_primary` 账号。
4. 点击“测试登录”。
5. 验收页面展示：
   - cookies 状态
   - storageState 状态
   - 登录方式
   - 登录结果
   - XML 验证
   - 诊断路径
6. 如果失败，点击“查看诊断”，能看到 input value、cookie/token/password 等本地调试内容。
7. 登录成功后重启浏览器，再次测试登录应优先走 cookies/storageState。
8. 打开 `/matches`，顶部只显示中文简略数据源卡片。
9. 比赛列表和详情不显示英文盘口、`oddsId=null`、`disabled-preview-only`。

## 8. 验收标准

| 项目 | 标准 |
|---|---|
| 自动登录确认 | 测试登录显示 `登录结果：已登录` |
| cookies 优先 | 第二次测试登录优先显示 `登录方式：cookies` |
| 账号密码 fallback | cookies 失效后显示 `登录方式：账号密码` |
| 登录态保存 | 生成 `cookies.json` 和 `storage-state.json` |
| 失败诊断 | 生成 `screenshot.png` 和 `snapshot.json` |
| 调试展示 | 前端诊断弹窗能展示 cookie/token/password/input value |
| watcher | 登录成功后再监听 XML |
| page closed | 不再持续刷 `Target page, context or browser has been closed` |
| Dashboard | 普通页面中文简洁，无调试字段噪音 |
| 测试 | 所有后端/前端测试和构建通过 |

## 9. 实施顺序

1. Cookie Store。
2. Session Detector。
3. Login Diagnostics。
4. CrownLoginManager。
5. SQLite 登录结果字段。
6. watcher 接入登录管理器。
7. 测试登录短跑。
8. 登录诊断读取 API。
9. 前端中文标签和时间格式。
10. SourceStatusCard。
11. MatchSelection 中文瘦身。
12. CrownMonitorAccount 测试登录结果和诊断弹窗。
13. 其他页面英文瘦身。
14. 全量测试和真实测试登录验收。
