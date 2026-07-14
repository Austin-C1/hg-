# 皇冠手工 Portable 与桌面快捷方式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整删除远程更新链，保留可审计的手工 Windows x64 Portable 发布、`current.json`/`versions/<version>` 结构和用户数据，并在每次成功启动后幂等校正当前用户桌面快捷方式。

**Architecture:** Portable 包继续由根目录 launcher 读取 `current.json` 并启动版本目录中的 Dashboard。所有远程下载、manifest、签名校验、candidate、handoff、回滚和更新健康检查都从运行时移除。通用原子 JSON 与安全路径工具迁入 `src/crown/runtime/`。快捷方式由独立 PowerShell 5.1 脚本创建，launcher 只在已复用健康进程或新进程通过完整 health identity 校验后调用；失败仅记日志，不改变启动结果。

**Tech Stack:** Node.js ESM 22.23.1、`node:test`、React/Vite/Vitest、PowerShell 5.1、Windows Script Host `WScript.Shell`、Windows x64 Portable ZIP。

**Design source:** `docs/superpowers/specs/2026-07-13-crown-manual-portable-and-desktop-shortcut-design.md`

## 2026-07-13 实施状态

| 状态 | 内容 |
|---|---|
| 已完成 | Task 1–6：通用工具迁移、更新入口 404、远程 updater/依赖删除、launcher 简化、幂等桌面快捷方式、Portable allowlist/audit 调整 |
| 已完成 | Task 7：手工升级文档、模块索引与项目记忆已按最终实现对齐 |
| 已完成 | Task 8 的本机验证：backend `1286/1286`、frontend `137/137`、syntax check、production build、外部 cwd/中文路径 launcher 回归，以及含锁定 Node/Chromium 的临时 Portable 审计（2688 files、0 forbidden hits） |
| 待发布验证 | 正式 clean-checkout 发行包与 Fresh Windows 10/11 x64 矩阵；本次临时验收包不作为正式下载版 |
| 投注边界 | 发布改造不移除或固定 `perBetLimit`；该上限仍可手工修改，`50 CNY` 仅为测试值。账号继续顺序分配，`rejected` 转下一个未使用账号，`unknown` 锁定且不重试，Submit 网络开始后每 child 最多一次提交 |
| 协议边界 | fresh Preview 赔率必须在冻结规则区间，盘口身份使用 `handicapRaw`。当前只开放 exact row `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation capability 为 `1/1/0`；其他 row 与 Reconciliation 关闭，真实 runtime 默认 off，Portable 启动或人工登录不会自行发送 `FT_bet`。本 Portable 改造的历史验收轮次本身未发送 `FT_bet` |

下方 checkbox 保留原始 TDD 分步记录；完成与待办状态以上表为准，不把缺少 Fresh Windows 证据的产物标为最终可发布版。

## Global Constraints

- 保留 `scripts/build-windows-portable.mjs`、`release/windows-runtime-lock.json`、`release/windows-production-allowlist.json`、`release-files.json`、`current.json` 和 `versions/<version>`。
- `%LOCALAPPDATA%\CrownMonitor` 内的 SQLite、配置、session、profile、日志和用户修改不得被删除或覆盖。
- 删除 `/system-update`、`/api/app/system-update*`、`/api/health/update`；普通 `/api/health` 必须继续工作。
- 不保留兼容代理、隐藏更新开关、GitHub Releases 下载、manifest/signature、candidate、handoff 或自动回滚代码。
- 不写注册表启动项，不创建 Startup 项，不创建 Windows Service，不要求管理员权限。
- 快捷方式固定为当前用户 Desktop 下 `皇冠抓水投注.lnk`，Target 为当前包根目录 `启动程序.cmd`，WorkingDirectory 为当前包根目录，Icon 为当前包根目录 `皇冠抓水投注.ico`，窗口可见。
- 每个实现任务先写或改失败测试，确认 RED 原因，再做最小实现并运行定向回归；不把旧更新测试直接删除后当作通过。
- 当前工作区已有与“今日开放盘口”相关的用户改动；本计划不得改写或格式化这些文件。
- 实施期间不自动提交；由用户决定最终提交边界。

---

## Task 1：迁移仍被运行时使用的通用文件工具

**Files:**

- Create: `src/crown/runtime/atomic-json-file.mjs`
- Create: `src/crown/runtime/safe-data-path.mjs`
- Modify: `src/crown/login/crown-human-login-controller.mjs`
- Modify: `tests/crown-safe-data-path.test.mjs`
- Modify: 所有仍引用 `src/crown/update/atomic-json-file.mjs` 或 `src/crown/update/safe-data-path.mjs` 的非 updater 文件及对应测试
- Delete after imports pass: `src/crown/update/atomic-json-file.mjs`
- Delete after imports pass: `src/crown/update/safe-data-path.mjs`

- [ ] **Step 1: 改测试 import，形成 RED**

将保留测试改为从 `src/crown/runtime/` 导入，并增加人工登录控制器在中文、空格、非系统盘路径下仍只写 data root 的断言。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-safe-data-path.test.mjs tests/crown-human-login-controller.test.mjs
```

Expected: FAIL，原因只能是 runtime 模块尚不存在或 import 尚未迁移。

- [ ] **Step 3: 原样迁移实现并收敛 import**

保持既有导出名称、原子 replace 语义、reparse/outside-root 防护及错误码不变。用 `rg` 确认 updater 目录外没有旧 import。

- [ ] **Step 4: 删除旧副本并验证**

Run:

```powershell
rg -n "crown/update/(atomic-json-file|safe-data-path)" src scripts tests
node --test --test-concurrency=1 tests/crown-safe-data-path.test.mjs tests/crown-human-login-controller.test.mjs tests/crown-human-login-controller-security.test.mjs
```

Expected: `rg` 无结果；测试 PASS。

---

## Task 2：建立远程更新入口的 404 tombstone 契约

**Files:**

- Modify: `tests/crown-app-api.test.mjs`
- Modify: `tests/crown-dashboard-server.test.mjs`
- Modify: `frontend/src/App.contract.test.tsx`
- Modify: `frontend/src/components/AppLayout.mobile.test.tsx`
- Modify: `frontend/src/services/api.security.test.ts`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppLayout.tsx`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`
- Delete: `frontend/src/pages/SystemUpdate.tsx`
- Delete: `frontend/src/pages/SystemUpdate.test.tsx`

- [ ] **Step 1: 先把测试改成删除后的公开契约**

必须覆盖：

```js
for (const path of [
  '/api/app/system-update',
  '/api/app/system-update/check',
  '/api/app/system-update/download',
  '/api/app/system-update/apply',
  '/api/health/update',
]) {
  assert.equal((await request(path)).status, 404)
}
```

前端断言 `/system-update` 不再 lazy import、不在导航中，API client 不再暴露 check/download/apply/cancel/update-state 方法。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-app-api.test.mjs tests/crown-dashboard-server.test.mjs
npm --prefix frontend test -- --run src/App.contract.test.tsx src/components/AppLayout.mobile.test.tsx src/services/api.security.test.ts
```

Expected: FAIL，因为旧路由、页面和 client 方法仍存在。

- [ ] **Step 3: 删除前后端公开入口**

从 `app-api.mjs` 删除更新 DTO、输入校验、错误映射和 dispatch branch；从 `static-server.mjs` 删除 `/api/health/update` 和 `/system-update` SPA fallback；删除页面、菜单、route、类型和 API 方法。普通 `/api/health` 与其他 SPA 路由保持不变。

- [ ] **Step 4: 验证 404 与普通应用契约**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-app-api.test.mjs tests/crown-dashboard-server.test.mjs tests/crown-health.test.mjs
npm --prefix frontend test -- --run src/App.contract.test.tsx src/components/AppLayout.mobile.test.tsx src/services/api.security.test.ts
```

Expected: PASS；更新入口 404，普通 health 200。

---

## Task 3：从 Dashboard 运行时删除 update service 与 handoff

**Files:**

- Modify: `scripts/crown-dashboard.mjs`
- Modify: `src/crown/runtime/portable-paths.mjs`
- Modify: `tests/crown-portable-paths.test.mjs`
- Modify: `tests/crown-portable-runtime.test.mjs`
- Modify: `tests/crown-dashboard-shutdown.test.mjs`
- Delete: `src/crown/update/` 中除 Task 1 已迁移文件外的全部文件
- Delete: `scripts/crown-update-apply.mjs`
- Delete: `scripts/create-update-manifest.mjs`
- Delete: `scripts/sign-release-manifest.mjs`
- Delete: 仅验证下载、manifest、signature、extract、backup、candidate、handoff、update service 的测试文件

- [ ] **Step 1: 改运行时测试，明确只保留手工 Portable 路径**

断言 `resolvePortablePaths()` 不再返回 updater 专用 `updateDir`，Dashboard 构造 API/server 时不需要 update service/health provider/handoff，shutdown 不调用 download cancel。用户 data root、storage、runtime、session、profile、logs 仍存在。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-portable-paths.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-dashboard-shutdown.test.mjs
```

Expected: FAIL，显示旧路径或旧依赖仍存在。

- [ ] **Step 3: 删除运行时组装和 updater 专用模块**

删除配置读取、service 构造、pending handoff、update health provider、shutdown cancel。`backupDir` 仅在存在非更新用途时保留；若 `rg` 证明只为 updater 服务，则一并从 path contract 删除。不要修改用户 data 迁移或初始化逻辑。

- [ ] **Step 4: 做无残留扫描与定向回归**

Run:

```powershell
rg -n -i "system-update|update service|candidate update|pending-update|CROWN_UPDATE|github releases|release manifest|ed25519|yauzl" src scripts tests package.json
node --test --test-concurrency=1 tests/crown-portable-paths.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-dashboard-shutdown.test.mjs tests/crown-portable-instance.test.mjs
```

Expected: 扫描只允许出现在明确的 404/无残留契约测试中；测试 PASS。

---

## Task 4：简化 Windows launcher，删除 candidate/recovery 状态机

**Files:**

- Modify: `packaging/windows/launcher/start.ps1`
- Modify: `tests/crown-windows-launcher.test.mjs`
- Delete: `packaging/windows/launcher/update-bootstrap.ps1`

- [ ] **Step 1: 将 launcher 测试改为普通启动唯一状态机**

删除只验证 candidate/recovery 的用例，新增源码契约断言：参数列表不得出现 `CandidateVersion`、`CandidateUpdateId`、`CandidateProbeToken`、`CandidateAuthorizationNonce`、`CandidateOperationDir`；不得读取 recovery request/journal/update bootstrap；仍覆盖中文空格路径、单实例复用、健康 identity、端口竞争、精确停止和可见窗口。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-windows-launcher.test.mjs
```

Expected: FAIL，因为旧参数和恢复代码仍在脚本中。

- [ ] **Step 3: 删除 updater 分支，保留普通启动安全边界**

移除 candidate 参数、pending recovery、update request/journal、candidate health 特例和 bootstrap 调用。保留 `current.json` 严格 SemVer、installation identity、路径边界、single-instance、startup claim、exact process identity、health nonce/probe 和普通 shutdown。

- [ ] **Step 4: 运行 launcher 回归**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-windows-launcher.test.mjs
```

Expected: PASS；测试必须串行执行，不能与全量 backend 测试并发。

---

## Task 5：TDD 实现幂等桌面快捷方式

**Files:**

- Create: `packaging/windows/launcher/ensure-desktop-shortcut.ps1`
- Create: `tests/crown-windows-desktop-shortcut.test.mjs`
- Modify: `packaging/windows/launcher/start.ps1`
- Create: `packaging/windows/皇冠抓水投注.ico`

- [ ] **Step 1: 写独立脚本的失败测试**

在临时 HOME/Desktop 和包含中文、空格的包路径中运行脚本。用 PowerShell/COM 回读 `.lnk`，断言：

- 名称严格为 `皇冠抓水投注.lnk`；
- `TargetPath` 严格等于当前包根 `启动程序.cmd`；
- `WorkingDirectory` 严格等于当前包根；
- `IconLocation` 指向当前包根 `皇冠抓水投注.ico`；
- 重跑只留下一个快捷方式；
- 将包复制到新路径后重跑，旧 `.lnk` 被原子替换并指向新路径；
- 目标或 icon 缺失时返回非零且不留下半成品。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-windows-desktop-shortcut.test.mjs
```

Expected: FAIL，因为脚本和 icon 尚不存在。

- [ ] **Step 3: 实现独立 shortcut 脚本**

脚本接口固定为：

```powershell
param([Parameter(Mandatory=$true)][string]$PackageRoot)
```

内部用 `[Environment]::GetFolderPath('Desktop')` 获取当前用户桌面，使用 `WScript.Shell.CreateShortcut()` 写同目录临时 `.lnk`，保存后用 `Move-Item -Force` 替换正式快捷方式。所有路径规范化为绝对路径；不使用注册表、Startup 或 Service。

- [ ] **Step 4: 接入成功启动边界并做非致命处理**

在 launcher 的两条成功路径调用同一个 `Ensure-DesktopShortcutNonFatal`：

1. 已有 Dashboard 通过 exact health 校验并返回 `launcher-reused` 前；
2. 新 Dashboard 通过 exact health 和 parent acknowledgement、写出 `launcher-started` 前。

快捷方式失败时写 `launcher-shortcut-failed:<sanitized-code>` 到 `launcher.log`，仍以成功启动返回 0；不得记录用户完整路径或异常堆栈。

- [ ] **Step 5: 验证独立脚本和 launcher 接入**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-windows-desktop-shortcut.test.mjs tests/crown-windows-launcher.test.mjs
```

Expected: PASS；失败注入证明 shortcut 错误不影响 Dashboard 成功启动。

---

## Task 6：清理依赖并更新 Portable allowlist/audit

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `release/windows-production-allowlist.json`
- Modify: `tests/crown-portable-release-builder.test.mjs`
- Modify: `tests/crown-release-audit.test.mjs`
- Modify: `tests/crown-release-workflow.test.mjs`

- [ ] **Step 1: 把发布测试改成新资产清单**

断言根目录包含 `启动程序.cmd`、`皇冠抓水投注.ico` 和 `launcher/ensure-desktop-shortcut.ps1`；不包含 `launcher/update-bootstrap.ps1`、`scripts/crown-update-apply.mjs`、任何 update tree、`yauzl` 或 `pend`。仍断言 `release-files.json` 覆盖所有发布文件且用户数据/secret 扫描通过。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs
```

Expected: FAIL，因为 allowlist 和依赖仍描述 updater。

- [ ] **Step 3: 更新包清单与 lockfile**

从 npm scripts 删除 manifest/signature 命令，从 dependencies 删除直接依赖 `yauzl`，用 npm 更新 lockfile；同步删除传递依赖 `pend`。allowlist 加入 shortcut 脚本与 `.ico`，删除 updater 文件和依赖。

- [ ] **Step 4: 验证依赖与发布审计**

Run:

```powershell
npm ls yauzl pend --all
node --test --test-concurrency=1 tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs
```

Expected: `npm ls` 不再列出两项依赖；测试 PASS。

---

## Task 7：更新手工升级文档和项目记忆

**Files:**

- Modify: `README.md`
- Modify: `packaging/windows/首次使用说明.txt`
- Modify: `docs/modules/windows-portable-release.md`
- Modify: 现有 Windows 发布/操作文档中仍描述远程更新的文件
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`
- Create or Modify: 发布者手工升级说明文档（沿用仓库现有命名）

- [ ] **Step 1: 写文档契约测试或扩展现有 publication/release 测试**

文档必须明确：重新构建 ZIP、解压到新目录、首次成功启动自动校正桌面快捷方式、用户数据继续位于 `%LOCALAPPDATA%\CrownMonitor`、旧包确认无误后再人工删除。文档不得指导用户点击在线更新、配置 release feed、签名 key 或 candidate rollback。

- [ ] **Step 2: 更新文档并扫描旧术语**

Run:

```powershell
rg -n -i "system update|系统更新|在线更新|远程更新|update feed|manifest signature|candidate|update-bootstrap|crown-update-apply|yauzl" README.md packaging docs release package.json
```

Expected: 只允许历史规格/计划与“已删除”说明命中；当前使用说明无旧操作入口。

- [ ] **Step 3: 验证模块索引和记忆一致**

运行现有文档/发布契约测试，确认模块索引把 Portable 标为可独立开发，并记录远程更新链已删除、快捷方式为非致命启动后动作。

---

## Task 8：完整验证与真实 Portable 产物验收

- [ ] **Step 1: 运行 Portable 定向回归**

```powershell
node --test --test-concurrency=1 tests/crown-portable-paths.test.mjs tests/crown-portable-instance.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs tests/crown-windows-desktop-shortcut.test.mjs
node --test --test-concurrency=1 tests/crown-windows-launcher.test.mjs
```

- [ ] **Step 2: 运行完整 backend/frontend 验证**

```powershell
npm test
npm run check
npm --prefix frontend test
npm --prefix frontend run build
```

- [ ] **Step 3: 构建真实 Windows Portable 并审计**

按仓库现有 unsigned Portable workflow 使用锁定 Node `22.23.1` 和 Chromium 构建产物，运行 release audit、`release-files.json` 完整性校验和 secret scan。解压到含中文、空格、非系统盘的临时目录，从非项目 cwd 双击等价启动。

- [ ] **Step 4: 验收成功启动和移动校正**

确认：

- `/api/health` 正常，三组 update URL 均 404；
- 第一次成功启动后桌面只有一个正确 `.lnk`；
- 包移动到新目录并再次成功启动后 `.lnk` Target/WorkingDirectory/Icon 全部更新；
- shortcut 写入失败时 Dashboard 仍启动，日志仅含脱敏错误码；
- Watcher 和投注 worker 不因启动、移动或手工升级自动开启；
- 原 `%LOCALAPPDATA%\CrownMonitor` 用户数据保持可用。

- [ ] **Step 5: 最终无残留扫描**

```powershell
rg -n -i "system-update|CROWN_UPDATE|update-bootstrap|crown-update-apply|create-update-manifest|sign-release-manifest|yauzl|github releases" --glob '!docs/superpowers/specs/**' --glob '!docs/superpowers/plans/**' .
git status --short
```

Expected: 代码、包清单和当前用户文档无远程更新实现残留；`git status` 只包含用户原有改动和本计划直接相关改动。
