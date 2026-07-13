# 皇冠 Windows Portable、人工登录与签名更新实施计划

> **Required sub-skill:** Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 把当前项目整理为可公开审计的源码仓库，并生成少量 Windows x64 用户可下载、解压、双击运行的 Private Beta；内置 Node.js、Chromium、用户确认的 118 项默认联赛白名单，以及手动检查、显式确认、失败自动回滚的 GitHub Releases 更新能力。

**Architecture:** 程序只读根 `APP_ROOT` 与用户可写根 `%LOCALAPPDATA%\CrownMonitor` 完全分离。稳定 launcher 读取 `current.json`，用版本目录内的 Node 启动 Dashboard；Dashboard 显式接收全部路径，并只在页面操作后启动 Watcher。内置 Chromium 使用账号隔离 Profile 完成人工验证，session 只回收 exact origin。更新由签名 manifest、受限下载、安全解压、SQLite 一致性备份、持久 journal、候选健康检查和外部 updater 组成。

**Tech Stack:** Node.js ESM 22+、`node:test`、React/Vite/Vitest、SQLite `node:sqlite`、Playwright Chromium、PowerShell 5.1+、Windows CMD、GitHub Releases、Ed25519、SHA-256。

**Design source:** `docs/superpowers/specs/2026-07-13-crown-windows-portable-and-remote-update-design.md`。

## Global Constraints

- 公开仓库固定为 `https://github.com/Austin-C1/hg-`，同时保存公开源码和 GitHub Releases；下载包仍只从 Release assets 获取。
- Windows x64 Portable ZIP，手动双击启动并保留运行窗口；不安装 Service，不写注册表，不要求管理员权限。
- Watcher 只能由用户在 Dashboard 手动启动；首次启动、程序重启、更新成功和回滚后都保持停止。
- 下载包内置 Node.js 与 Chromium；不得依赖系统 Node、Chrome、Edge、Docker、调用者 `cwd` 或开发电脑路径。
- 当前 118 项默认联赛白名单作为只读 seed 进入源码和下载包。首次运行复制到用户数据目录；以后升级不得覆盖用户修改。
- Crown exact HTTPS origin、用户名和密码由每个用户自己配置；禁止发布 `.env`、真实账号、Cookie、Token、session、Profile、SQLite、密钥、Telegram 配置、日志和协议抓包。
- `CROWN_BETTING_ALLOWED_ORIGINS` 属于每台电脑的安全配置，不作为公共默认白名单发布。
- 真实投注 capability 必须持续为 Preview/Submit/Reconciliation `0/0/0`；不得实施或越过统一计划 Task 7、8、12 的硬停点。
- 每个实现任务先写失败测试，再写最小实现，再跑定向回归；提交前跑全量测试、发行物审计和 staged secret scan。
- 正式 Release 只能来自 clean checkout 或显式 allowlist staging，不能递归压缩开发工作区。
- Ed25519 私钥只离线保存，不进入仓库、GitHub Secrets、CI、环境模板或 ZIP。

---

## Task 1：清理公开仓库并锁定废弃入口边界

**Files:**

- Create: `tests/crown-publication-contract.test.mjs`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/modules/crown-betting-protocol.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`
- Delete: `scripts/crown-bet-bootstrap.mjs`
- Delete: `scripts/crown-bet-execute.mjs`
- Delete: `scripts/crown-bet-execute-sequence.mjs`
- Delete: `scripts/crown-betting-candidate-dry-run.mjs`
- Delete: `src/crown/betting/crown-bet-adapter.mjs`
- Delete: `src/betting/audit-log.mjs`
- Delete: `src/betting/bet-intent.mjs`
- Delete: `src/betting/risk-guard.mjs`
- Delete: `src/betting/README.md`
- Delete: 对应且只覆盖上述废弃入口的测试文件
- Delete before first commit: `参考平博例子/`、`平博升级版/`、`output/`、`.playwright-cli/`

**Step 1: Write the failing publication contract**

```js
test('public source has no superseded betting CLI entrypoints', () => {
  for (const file of supersededFiles) assert.equal(existsSync(file), false, file)
})

test('local runtime and reference programs stay ignored', () => {
  for (const name of forbiddenRoots) assert.match(gitignore, new RegExp(escape(name)))
})
```

同时断言 canonical `scripts/crown-betting-worker.mjs`、capability matrix 和安全审计测试仍存在。

**Step 2: Run test to verify it fails**

Run: `node --test tests/crown-publication-contract.test.mjs`

Expected: FAIL because superseded scripts still exist.

**Step 3: Remove only confirmed superseded code**

删除只被旧 CLI/旧 adapter 使用的模块和测试，移除四个 npm scripts。保留 `crown-order-field-mapper.mjs`、`crown-bet-response-parser.mjs`、生产 Provider、worker、迁移兼容层和 capability 安全门禁。把安全审计从“旧 real flags 必须拒绝”改为“旧入口必须不存在，canonical worker 仍受门禁”。

**Step 4: Verify cleanup**

Run: `node --test tests/crown-publication-contract.test.mjs tests/crown-betting-security-audit.test.mjs tests/crown-capability-matrix.test.mjs`

Expected: PASS; canonical capability counts remain `0/0/0`.

**Step 5: Record the change**

更新当前架构文档，明确旧单笔/顺序/candidate CLI 已删除，真实执行唯一入口仍是 Dashboard 管理的 worker，且当前 capability 继续为零。

---

## Task 2：建立 Portable 路径与版本契约

**Files:**

- Create: `src/crown/runtime/portable-paths.mjs`
- Create: `src/crown/app/app-version.mjs`
- Create: `tests/crown-portable-paths.test.mjs`
- Create: `tests/crown-app-version.test.mjs`
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/app-secret.mjs`

**Step 1: Write failing path tests**

```js
const paths = resolvePortablePaths({
  appRoot: 'D:\\带 空格\\CrownMonitor',
  dataRoot: 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor',
  version: '0.1.0',
})
assert.equal(paths.dbPath, 'C:\\Users\\UserA\\AppData\\Local\\CrownMonitor\\storage\\crown.sqlite')
assertPathWithin(paths.dataRoot, paths.runtimeDir, 'runtimeDir')
assert.throws(() => resolvePortablePaths({ appRoot, dataRoot, version: '..\\outside' }), /portable-version-invalid/)
```

另测缺少 `LOCALAPPDATA` 必须失败；切换到临时非项目 `cwd` 后结果不变；中文、空格、非系统盘路径等价。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-portable-paths.test.mjs tests/crown-app-version.test.mjs`

Expected: FAIL because modules do not exist.

**Step 3: Implement the path contract**

```js
export function resolvePortablePaths({ appRoot, dataRoot, env = process.env, version })
export function assertPathWithin(root, candidate, field)
export function portableEnvironment(paths)
export const APP_VERSION
```

返回规范化绝对 `appRoot/versionRoot/appDir/nodeExe/chromiumExe/dataRoot/dbPath/secretKeyPath/configDir/runtimeDir/sessionDir/profileDir/logDir/updateDir/backupDir/staticDir`。版本只接受严格 SemVer；所有用户可写路径必须在 data root 内。

**Step 4: Refactor DB/key defaults through the contract**

`openAppDatabase()` 与 `readOrCreateLocalSecretKey()` 接收显式绝对路径；Portable 模式禁止回退到仓库相对路径。开发模式保留显式传入的现有测试路径。

**Step 5: Verify**

Run: `node --test tests/crown-portable-paths.test.mjs tests/crown-app-version.test.mjs tests/crown-app-db.test.mjs tests/crown-app-secret.test.mjs`

Expected: PASS from repository and a temporary non-project cwd.

---

## Task 3：Dashboard、Watcher 和 worker 去 `cwd` 化

**Files:**

- Create: `tests/crown-portable-runtime.test.mjs`
- Modify: `scripts/crown-dashboard.mjs`
- Modify: `scripts/crown-watch.mjs`
- Modify: `scripts/crown-betting-worker.mjs`
- Modify: `src/crown/app/monitor-process.mjs`
- Modify: `src/crown/app/betting-process.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/app/local-config-api.mjs`
- Modify: `src/crown/app/runtime-cache-cleanup.mjs`
- Modify: `src/crown/dashboard/dashboard-data.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`

**Step 1: Write failing runtime tests**

```js
const controller = createMonitorProcessController({
  watchScriptPath: 'D:\\App\\versions\\0.1.0\\app\\scripts\\crown-watch.mjs',
  dbPath: 'C:\\Data\\storage\\crown.sqlite',
  runtimeDir: 'C:\\Data\\runtime',
  spawnCommand,
})
controller.start()
assert.deepEqual(spawned.args.slice(0, 5), [watchScriptPath, '--app-db', dbPath, '--runtime-dir', runtimeDir])
```

断言 Dashboard 从非项目 cwd 启动；生产空 runtime 不回退 fixture；健康响应含 opaque `installationId`、`version`、`appContractVersion`，不泄漏 data path；启动后 Watcher/worker 都是 off。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-portable-runtime.test.mjs tests/crown-monitor-process.test.mjs tests/crown-betting-process.test.mjs tests/crown-dashboard-data.test.mjs`

Expected: FAIL on relative script/runtime/static paths and fixture fallback.

**Step 3: Pass every runtime path explicitly**

- controller 接受绝对 `watchScriptPath`、`workerScriptPath`、DB/config/runtime 路径。
- `scripts/crown-dashboard.mjs` 在 Portable 模式不读取调用者 cwd 的 `.env`。
- `CROWN_CHROMIUM_EXECUTABLE_PATH` 取代系统 `msedge` 默认；开发模式仍可显式传 browser channel。
- runtime cleanup 仅删除 data root 内 allowlist 目标。
- production `readDashboardData()` 默认 `allowFixtureFallback=false`。

**Step 4: Add ordered shutdown**

SIGINT/SIGTERM 顺序固定为：关闭真实投注意图/worker → `monitorProcess.stopAndWait()` → SQLite 收敛 → HTTP server close。错误写日志但不得跳过后续安全停止步骤。

**Step 5: Verify**

Run: `node --test tests/crown-portable-runtime.test.mjs tests/crown-monitor-process.test.mjs tests/crown-betting-process.test.mjs tests/crown-dashboard-server.test.mjs tests/crown-dashboard-data.test.mjs tests/crown-runtime-cache-cleanup.test.mjs`

Expected: PASS and no production `process.cwd()` dependency remains in these entrypoints.

---

## Task 4：首次运行 seed、默认白名单和本地安装身份

**Files:**

- Create: `src/crown/runtime/portable-instance.mjs`
- Create: `tests/crown-portable-instance.test.mjs`
- Modify: `config/default-leagues.json`
- Modify: `src/crown/config/default-leagues.mjs`
- Modify: `tests/crown-default-leagues.test.mjs`

**Step 1: Write failing first-run tests**

```js
const result = initializePortableData({ appConfigDir, dataRoot, randomId: () => 'install-A' })
assert.equal(result.created, true)
assert.equal(readJson(userLeagues).leagues.length, 118)
writeFileSync(userLeagues, JSON.stringify({ version: 1, leagues: [] }))
initializePortableData({ appConfigDir, dataRoot, randomId: () => 'install-B' })
assert.equal(readJson(userLeagues).leagues.length, 0)
assert.equal(readInstallationId(dataRoot), 'install-A')
```

断言 seed 无账号、密码、URL、Token；账号/session/Profile/SQLite 均不从项目复制。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-portable-instance.test.mjs tests/crown-default-leagues.test.mjs`

Expected: FAIL because portable initialization does not exist.

**Step 3: Implement first-run initialization**

只在目标文件不存在时复制 `config/default-leagues.json`；生成 installation id、本地密钥和空 DB；创建 ACL 继承的当前用户目录，不调用 `icacls` 放宽权限。返回脱敏状态，不返回本机完整路径给前端。

**Step 4: Verify seed integrity**

Run: `node --test tests/crown-portable-instance.test.mjs tests/crown-default-leagues.test.mjs`

Expected: PASS; bundled and code fallback league names match exactly and total 118.

---

## Task 5：Windows 手动 launcher、端口选择和精确停止

**Files:**

- Create: `packaging/windows/启动程序.cmd`
- Create: `packaging/windows/停止程序.cmd`
- Create: `packaging/windows/首次使用说明.txt`
- Create: `packaging/windows/launcher/start.ps1`
- Create: `packaging/windows/launcher/stop.ps1`
- Create: `packaging/windows/launcher/update-bootstrap.ps1`
- Create: `tests/crown-windows-launcher.test.mjs`

**Step 1: Write failing launcher contract tests**

测试脚本自身目录定位、`current.json` schema、中文/空格路径、8787 冲突、相同 installation id 复用、PID 复用防护、坏状态文件、健康超时、只停止匹配实例，以及启动后 Watcher/worker off。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-windows-launcher.test.mjs tests/crown-portable-instance.test.mjs`

Expected: FAIL because launcher files do not exist.

**Step 3: Implement launcher state**

状态文件为 `%LOCALAPPDATA%\CrownMonitor\runtime\launcher-state.json`，原子记录 `installationId/version/port/pid/processStartTime`。端口被相同安装的健康响应占用时只打开页面；被其他程序占用时选择 loopback 空闲端口并持久化。停止脚本必须同时匹配 installation id、PID、processStartTime 和健康响应，不按 `node.exe` 名称批量结束。

**Step 4: Keep the visible window**

`启动程序.cmd` 用脚本目录调用 PowerShell；启动失败显示中文错误、日志位置和处理建议并 `pause`。成功后当前窗口持续等待 Dashboard；关闭窗口触发有序停止。

**Step 5: Verify**

Run: `node --test tests/crown-windows-launcher.test.mjs tests/crown-portable-runtime.test.mjs`

Expected: PASS from a temporary cwd and Chinese path.

---

## Task 6：Allowlist 发行构建与本机硬编码审计

**Files:**

- Create: `release/windows-runtime-lock.json`
- Create: `release/windows-production-allowlist.json`
- Create: `src/crown/release/portable-release-builder.mjs`
- Create: `src/crown/release/release-audit.mjs`
- Create: `scripts/build-windows-portable.mjs`
- Create: `scripts/verify-release-artifacts.mjs`
- Create: `tests/crown-portable-release-builder.test.mjs`
- Create: `tests/crown-release-audit.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile`
- Modify: `tests/crown-dashboard-docker.test.mjs`

**Step 1: Write failing builder tests**

```js
const result = await buildPortableRelease({ sourceRoot, outputDir, version: '0.1.0', nodeRuntimeDir, chromiumRuntimeDir })
assert.ok(existsSync(join(result.root, 'versions/0.1.0/app/scripts/crown-watch.mjs')))
assert.ok(existsSync(join(result.root, 'versions/0.1.0/app/scripts/crown-betting-worker.mjs')))
assert.equal(readJson(join(result.root, 'versions/0.1.0/app/config/default-leagues.json')).leagues.length, 118)
```

断言 tests、fixtures、`.env`、storage、data/runtime、Telegram 配置、SQLite、key/pem、session、日志、symlink 和旧 CLI 全部缺席。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs`

Expected: FAIL because builder/audit do not exist.

**Step 3: Implement explicit staging allowlist**

生产包只含 launcher、说明、current metadata、production package/lock、production dependencies、`src/**`、canonical Dashboard/Watcher/worker/update scripts、`frontend/dist/**`、118 项 seed config、内置 Node、内置 Chromium、licenses。Playwright 移入 production dependency 并固定浏览器版本。

**Step 4: Implement artifact audit**

扫描并拒绝：`C:\Users\`、开发用户名、Desktop、当前仓库绝对路径、未声明盘符路径、本机代理、系统浏览器路径、`.env`、数据库、密钥、Token、Cookie、session、Profile、日志及未列入 manifest 的文件。安全默认 `127.0.0.1` 和业务时区 `Asia/Shanghai` 允许，但必须来自集中配置。

**Step 5: Verify**

Run: `node --test tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-dashboard-docker.test.mjs`

Expected: PASS; builder refuses a dirty recursive workspace input for formal release mode.

---

## Task 7：内置 Chromium 解析与人工登录 session bridge

**Files:**

- Create: `src/crown/login/crown-origin.mjs`
- Create: `src/crown/login/portable-chromium.mjs`
- Create: `src/crown/login/manual-login-bridge.mjs`
- Create: `src/crown/app/crown-human-login-controller.mjs`
- Create: `tests/crown-origin.test.mjs`
- Create: `tests/crown-portable-chromium.test.mjs`
- Create: `tests/crown-manual-login-bridge.test.mjs`
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/login/crown-login-manager.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `scripts/crown-dashboard.mjs`

**Step 1: Write failing bridge tests**

使用 fake browser/context/page，覆盖：只启动 bundle 内 executable；账号独立 Profile；只允许账号 exact public HTTPS origin；验证码/滑块/OTP 不自动处理；只导入 exact-origin cookie；拒绝跨 origin、download、URL redirect 和不完整人工确认；成功后只读 `get_game_list` 复核；失败时 Watcher 不启动。

`normalizePublicHttpsExactOrigin()` 还必须拒绝 URL credentials、path/query/hash、HTTP、localhost、单标签 hostname、private hostname 和所有 IP literal。监控账号保存、API 登录和人工 Chromium 共用同一实现；生产入口不再截断 path 或使用默认 Crown URL。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-portable-chromium.test.mjs tests/crown-manual-login-bridge.test.mjs`

Expected: FAIL because modules do not exist.

**Step 3: Implement explicit manual flow**

```js
openManualLogin({ accountId })
getManualLoginStatus({ accountId, challengeId })
confirmManualLogin({ accountId, challengeId })
cancelManualLogin({ accountId, challengeId })
```

challenge 绑定账号、installation id、exact origin 和短期随机 nonce。人工 controller 状态只允许 `idle/opening/awaiting-user/verifying/verified/failed`。普通字段可按已识别 selector 填写；验证码、滑块、OTP 均留给用户本人。Profile 位于 data root，更新不覆盖。

session bridge 不调用 `context.storageState()`，不读取 localStorage/sessionStorage。UID 只能来自 exact-origin `transform_nl.php` 响应或同源 `transform.php` 请求证据；只读取该 origin 的 cookie。只有只读 `get_game_list` 成功后才原子保存 owner-bound API session，失败不得覆盖旧 session。

**Step 4: Add API routes**

- `POST /api/app/monitor-accounts/:id/manual-login/open`
- `GET /api/app/monitor-accounts/:id/manual-login/:challengeId`
- `POST /api/app/monitor-accounts/:id/manual-login/:challengeId/confirm`
- `POST /api/app/monitor-accounts/:id/manual-login/:challengeId/cancel`

所有 mutation 复用 loopback、Origin、session、CSRF 和 contract guard；响应只含状态与稳定错误码，不含密码、Cookie、ticket、session 或原始 Crown 响应。

**Step 5: Verify**

Run: `node --test tests/crown-origin.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-manual-login-bridge.test.mjs tests/crown-api-login-manager.test.mjs tests/crown-app-api.test.mjs`

Expected: PASS with fake network/browser only; no live Crown access.

---

## Task 8：人工登录 Dashboard UI

**Files:**

- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/pages/CrownMonitorAccount.tsx`
- Modify: `frontend/src/pages/CrownMonitorAccount.test.tsx`

**Step 1: Write failing UI tests**

覆盖“打开皇冠人工登录”、等待用户确认、取消、完成验证、错误提示；确认文案明确由用户处理验证码/滑块/OTP；点击成功不调用 Watcher start；轮询在页面卸载时 abort。

**Step 2: Run tests to verify they fail**

Run: `npm --prefix frontend test -- --run src/pages/CrownMonitorAccount.test.tsx`

Expected: FAIL because controls/API are absent.

**Step 3: Implement minimal UI**

在现有监控账号详情内增加人工登录区，不新增自动绕过逻辑。密码、Cookie、challenge 内部 nonce 不进入 localStorage 或错误提示。

**Step 4: Verify**

Run: `npm --prefix frontend test -- --run src/pages/CrownMonitorAccount.test.tsx src/services/api.security.test.ts`

Expected: PASS.

---

## Task 9：更新版本、manifest 与 Ed25519 信任根

**Files:**

- Create: `src/crown/update/semver.mjs`
- Create: `src/crown/update/update-manifest.mjs`
- Create: `src/crown/update/update-signature.mjs`
- Create: `src/crown/update/release-config.mjs`
- Create: `tests/crown-update-manifest.test.mjs`
- Create: `tests/crown-update-signature.test.mjs`
- Create: `scripts/sign-release-manifest.mjs`

**Step 1: Write failing crypto tests**

临时生成 Ed25519 keypair，覆盖有效签名、未知 key id、改一字节、非规范 JSON、未知字段、降级、同版本重装、错误 app/channel/packageType、过高 min updater、错误 asset size/hash。测试私钥只存在系统临时目录。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-update-manifest.test.mjs tests/crown-update-signature.test.mjs`

Expected: FAIL because update modules do not exist.

**Step 3: Implement strict contracts**

```js
parseSemver(value)
compareSemver(left, right)
parseUpdateManifest(bytes)
verifyUpdateManifest({ manifestBytes, signatureBytes, trustedKeys, expectedAppId: 'crown-monitor', expectedChannel: 'private-beta', currentVersion, updaterVersion })
```

Manifest 包含 `schemaVersion/appId/channel/packageType/version/minUpdaterVersion/releaseTag/signingKeyId/assetName/assetSize/assetSha256/createdAt/files`，拒绝任何额外字段。公钥属于只读发行资源；私钥路径必须由离线签名命令显式传入。

**Step 4: Verify**

Run: `node --test tests/crown-update-manifest.test.mjs tests/crown-update-signature.test.mjs`

Expected: PASS.

---

## Task 10：受限 GitHub 下载与安全 ZIP staging

**Files:**

- Create: `src/crown/update/github-release-client.mjs`
- Create: `src/crown/update/download-asset.mjs`
- Create: `src/crown/update/safe-extract.mjs`
- Create: `tests/crown-github-release-client.test.mjs`
- Create: `tests/crown-update-download.test.mjs`
- Create: `tests/crown-safe-extract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write failing network/extract tests**

fake fetch 覆盖超时、中断、redirect 每跳 HTTPS/host allowlist、无 GitHub token、大小/hash 不符。恶意 ZIP 覆盖 `../`、绝对路径、盘符、ADS、Windows 设备名、symlink/reparse、重复 entry、大小写冲突、尾随点/空格、ZIP bomb、额外/缺失文件和 staging 越界。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-github-release-client.test.mjs tests/crown-update-download.test.mjs tests/crown-safe-extract.test.mjs`

Expected: FAIL because modules do not exist.

**Step 3: Implement verify-before-trust order**

GitHub API 仅定位 manifest/signature；先验 manifest 签名，再相信 asset name/size/hash 并下载 ZIP。每次 redirect 重新验证 exact HTTPS host，禁止发送 Authorization。ZIP reader 固定版本；解压前完整验证 entry 元数据，解压后逐文件 size/hash 与 manifest 完全一致，再把 `.staging` 原子改名为版本目录。

**Step 4: Verify**

Run: `node --test tests/crown-github-release-client.test.mjs tests/crown-update-download.test.mjs tests/crown-safe-extract.test.mjs`

Expected: PASS with local fake server/files only.

---

## Task 11：SQLite 一致性备份、journal、预检与候选健康

**Files:**

- Create: `src/crown/update/atomic-json-file.mjs`
- Create: `src/crown/update/sqlite-backup.mjs`
- Create: `src/crown/update/update-journal.mjs`
- Create: `src/crown/update/update-preflight.mjs`
- Create: `src/crown/update/update-health.mjs`
- Create: `tests/crown-sqlite-backup.test.mjs`
- Create: `tests/crown-update-journal.test.mjs`
- Create: `tests/crown-update-preflight.test.mjs`
- Create: `tests/crown-update-health.test.mjs`

**Step 1: Write failing safety tests**

覆盖 WAL 数据一致备份、`integrity_check`、`foreign_key_check`、备份失败、更新并发、未完成 journal、磁盘空间不足、Watcher 停止超时、worker 未停、real intent 非 off、unknown submit、未关闭 reconciliation、capability 非 `0/0/0`、健康 probe token/installation id/version 不匹配。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-sqlite-backup.test.mjs tests/crown-update-journal.test.mjs tests/crown-update-preflight.test.mjs tests/crown-update-health.test.mjs`

Expected: FAIL because modules do not exist.

**Step 3: Implement persistence and preflight**

备份使用 SQLite 一致性机制生成临时文件，校验后原子 rename，禁止直接复制主 `.sqlite` 遗漏 WAL。journal 严格记录 previous/candidate version、backup、phase、current switch、candidate PID/instance id；每个破坏性步骤前原子写、flush。预检只在所有安全条件满足时交接 updater。

**Step 4: Implement candidate health**

健康检查验证 app/version/contract、SQLite schema/integrity/FK、Watcher stopped、real betting requested=false/state=off、capability `0/0/0`、随机 probe token；不返回用户数据路径。

**Step 5: Verify**

Run: `node --test tests/crown-sqlite-backup.test.mjs tests/crown-update-journal.test.mjs tests/crown-update-preflight.test.mjs tests/crown-update-health.test.mjs`

Expected: PASS.

---

## Task 12：Update Service、外部 updater、恢复与 Dashboard UI

**Files:**

- Create: `src/crown/update/update-error.mjs`
- Create: `src/crown/update/update-service.mjs`
- Create: `src/crown/update/update-applier.mjs`
- Create: `scripts/crown-update-apply.mjs`
- Create: `tests/crown-update-service.test.mjs`
- Create: `tests/crown-update-api.test.mjs`
- Create: `tests/crown-update-applier.test.mjs`
- Create: `tests/crown-update-recovery.test.mjs`
- Create: `frontend/src/pages/SystemUpdate.tsx`
- Create: `frontend/src/pages/SystemUpdate.test.tsx`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `scripts/crown-dashboard.mjs`
- Modify: `packaging/windows/launcher/update-bootstrap.ps1`
- Modify: `packaging/windows/launcher/start.ps1`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `src/crown/dashboard/static-server.mjs`

**Step 1: Write failing API/applier tests**

API 覆盖手动 check/install/cancel、CSRF/Origin、并发、stable error codes。applier/recovery 覆盖在 backup、旧进程停止、candidate 启动、migration、health 和 `current.json` switch 阶段强制终止；下次启动必须唯一确定为回滚旧版或继续已 commit 新版。

**Step 2: Run tests to verify they fail**

Run: `node --test tests/crown-update-service.test.mjs tests/crown-update-api.test.mjs tests/crown-update-applier.test.mjs tests/crown-update-recovery.test.mjs`

Expected: FAIL because service/applier are absent.

**Step 3: Implement Dashboard update API**

- `GET /api/app/system-update`
- `POST /api/app/system-update/check`
- `POST /api/app/system-update/install` with exact `expectedVersion`
- `POST /api/app/system-update/cancel`

`app-api.mjs` 只调用注入的 `updateService`。Mutation 沿用 loopback、Host/Origin、session、CSRF 与 contract guard；apply/rollback 阶段不可取消。

**Step 4: Implement external apply and recovery**

外部可见 PowerShell updater 停止旧 Dashboard，启动 candidate，验证健康后原子切换 `current.json`。失败停止 candidate、恢复 SQLite 备份、启动旧版并写 journal。launcher 每次启动先调用 recovery；停止进程只凭 installation id/PID/start time/probe，不按进程名。

**Step 5: Write failing UI tests**

Run: `npm --prefix frontend test -- --run src/pages/SystemUpdate.test.tsx src/App.contract.test.tsx`

Expected: FAIL because page and route are absent.

**Step 6: Implement update page**

页面显示当前/可用版本、状态、进度、失败/回滚原因；安装前明确提示 Watcher 将停止且更新后不会自动恢复。Release notes 只按 React text 渲染，不使用 `dangerouslySetInnerHTML`。

**Step 7: Verify**

Run: `node --test tests/crown-update-service.test.mjs tests/crown-update-api.test.mjs tests/crown-update-applier.test.mjs tests/crown-update-recovery.test.mjs`

Run: `npm --prefix frontend test -- --run src/pages/SystemUpdate.test.tsx src/App.contract.test.tsx src/components/AppLayout.mobile.test.tsx src/services/api.security.test.ts`

Expected: PASS; update success and rollback both leave Watcher/worker off.

---

## Task 13：构建、公开仓库审计、Fresh Windows 验收与 GitHub 发布

**Files:**

- Create: `.github/workflows/windows-release-build.yml`
- Create: `docs/github-release-runbook.md`
- Create: `docs/windows-private-beta-quick-start.md`
- Create: `tests/crown-release-workflow.test.mjs`
- Modify: `README.md`
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`

**Step 1: Add clean-build workflow contract**

GitHub Actions 只执行 clean checkout、依赖安装、backend/frontend tests、build、allowlist staging 与审计，并上传 unsigned artifact。工作流不得读取签名私钥或发布 GitHub token 到下载包。

Run: `node --test tests/crown-release-workflow.test.mjs`

Expected: PASS only when workflow uses pinned actions, minimal permissions and unsigned artifact output.

**Step 2: Run full repository verification**

Run: `npm ci`

Run: `npm --prefix frontend ci`

Run: `npm test`

Run: `npm run check`

Run: `npm --prefix frontend test`

Run: `npm --prefix frontend run build`

Expected: all PASS.

**Step 3: Build and audit a local unsigned release**

Run: `npm run release:portable -- --version 0.1.0 --node-runtime "$env:CROWN_NODE_RUNTIME_DIR" --chromium-runtime "$env:CROWN_CHROMIUM_RUNTIME_DIR" --out "$env:TEMP\crown-release-audit"`

Run: `npm run release:audit -- --root "$env:TEMP\crown-release-audit"`

Expected: allowlist complete; forbidden path/secret/user-data hits `0`; bundled league count `118`; capability `0/0/0`.

**Step 4: Smoke from outside the repository**

用包内 Node 从 `$env:TEMP` 启动解压产物，验证 `/api/health`、`/`、空 DB、无 fixture、Watcher/worker off、非 8787 端口回退、中文和空格路径。若当前机器无法模拟“完全没有系统 Node/Chrome”，在 Windows Sandbox 或干净 Windows 10/11 x64 VM 执行相同矩阵并保存不含用户数据的结果摘要。

**Step 5: Audit staged public source**

对 `git diff --cached --name-only` 的真实候选重新扫描本机绝对路径、用户名、Token、Cookie、session、SQLite、key、Telegram 配置、日志、截图和两个平博程序。任何命中先修正，不用 `.gitignore` 掩盖已经 staged 的文件。

**Step 6: Establish Git history and publish**

首次受审提交建立 `main`；功能开发使用 `codex/windows-portable-release`，通过完整验证和独立 review 后合并。推送前再次确认 origin 为 `https://github.com/Austin-C1/hg-.git` 且仓库公开。推送源码后从 GitHub 文件列表复查禁止内容为零。

**Step 7: Sign and publish Release only after clean Windows evidence**

离线签名 manifest，重新运行 artifact verify，再手动创建 `v0.1.0` Private Beta Release。未完成干净 Windows 验收时只上传源码和开发分支，不把 ZIP 标记为可用下载版。

---

## Final Review Gates

- Specification coverage review：逐项对照设计文档的路径、登录、更新、回滚、硬编码和验收矩阵。
- Placeholder scan：生产代码、说明和 workflow 不得出现未完成标记、示例密钥、示例账号或开发电脑路径。
- Type/contract consistency：backend DTO、frontend types、release manifest、PowerShell JSON schema 和测试使用同一字段名。
- Security review：exact-origin、CSRF、签名、ZIP、路径 containment、SQLite backup、进程身份和错误脱敏全部独立复核。
- Completion evidence：没有刚运行的全量测试、发行物审计、外部 cwd smoke 和 staged scan 输出，不宣称完成或可发布。
