# 皇冠全程序终验与 GitHub 0.2.0 发布 Implementation Plan

> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在剩余投注开发全部通过后，对监控、投注、Dashboard、Windows Portable 和安全边界做一次完整终验，把完成版直接合并到现有 `Austin-C1/hg-` 默认分支，替代当前旧源码和 README，并使经过 clean-checkout 与 Fresh Windows 验收的 `v0.2.0` 成为该项目的 latest 下载版本；不另建独立项目或并行产品。

**Architecture:** 发布采用“混合工作区范围审计 -> 本地 final-tree commit -> 从 `origin/main` 重建单提交 clean publish branch -> Draft PR/CI -> candidate clean-checkout -> Portable 构建/审计 -> Fresh Windows -> 带 expected-base lease 的原子 fast-forward -> tree 复验 -> tag -> Draft Release -> GitHub 下载复验 -> latest”。现有开发分支的中间历史绝不推送；PR 只承载从已审核 base 到最终树的单一发布 commit。默认分支更新使用 fast-forward + `--force-with-lease=refs/heads/main:FROZEN_BASE_SHA` 作为 compare-and-swap（不是历史改写），base 或 head 任一漂移都在写入前失败。用户下载资产只接受由锁定 Node/Chromium 构建并审计的完整 Portable ZIP，不使用 Actions unsigned artifact 冒充正式版本。

**Tech Stack:** Git、GitHub CLI `gh 2.92+`、GitHub Actions、Node.js 22.23.1、npm、React/Vite/Vitest、Windows PowerShell 5.1+、Portable runtime lock、SHA-256。

## Global Constraints

- 最终系统目标仍是长期运行、可恢复、不会重复下注；宁可不下注，也不能猜字段、重复下注或对 `unknown` 自动重投。
- 本计划只有在生产就绪、受控线上验收和 capability/Reconciliation 计划的完成 Gate 全部通过后才能开始。
- 远程仓库固定为 `https://github.com/Austin-C1/hg-.git`，目标版本固定为 `0.2.0`，tag 固定为 `v0.2.0`。
- 2026-07-14 已只读核对远程默认分支为 `main`，且远程 `v0.2.0` tag/Release 均不存在；执行发布时必须重新核对，若名称已被占用则停止并提升版本，禁止覆盖。
- 新 Release 成为 latest；旧 tag、Release 和资产不删除、不覆盖，保留用于回滚。发现问题必须发布更高版本，不能替换 `v0.2.0` 的既有资产。
- GitHub 公开仓库不得包含账号、密码、cookie、token、session、SQLite、浏览器 Profile、日志、截图、私钥、完整 uid、原始下注响应、private capture 或本机绝对路径。
- 当前工作区包含大量既有改动，禁止直接 `git add -A`；只能根据 production source allowlist 和人工可读 diff 显式 stage intended files。
- 当前开发分支相对 `origin/main` 含既有 commit 历史，禁止直接 push 该分支。发布分支必须从冻结的 `origin/main` 新建，只用 `git read-tree --reset -u TESTED_SOURCE_COMMIT` 在隔离 worktree 重建最终树，再形成恰好一个审核后的 commit；这样 add-then-delete 的中间 blob、旧 commit message 和任何未审核历史都不会进入远程。
- 所有本地和 clean-checkout 自动测试必须新鲜、单次完整、exit code 0；focused 复跑不能替代最终全量。
- Portable 必须使用 `release/windows-runtime-lock.json` 锁定的 Node/Chromium，构建目录必须在仓库外且为空。
- Watcher、Betting Worker、Reconciliation Worker 和全局真实投注在没有正式 due ledger 的新安装首次启动时默认停止；capability matrix 可以包含已验证 row，但任何能力都不能因安装或登录自动运行。Fresh Portable 不携带 controlled-live DB marker、private binding state 或 completion report，首次启动的 campaign overlay 必须恰好为 `not_applicable`，它不提供授权且继续走产品标准门禁。升级复用旧数据时，partial residue 必须 fail-closed，active/exhausted/stopped marker 必须保留；独立 Reconciliation Worker 只能因 exact due unknown + 完整 binding/reference 自动启动，且不能发送 Preview/Submit。
- Fresh Windows 证据缺失时只允许推送候选分支和 Draft PR，不得合并默认分支，不得创建或宣传可下载 Release。
- 使用 `github:yeet` 流程核对 scope、显式 stage、commit、push 和 PR；发布 Release 前再次核对 `gh auth status` 与仓库目标。
- 不自动提交本计划文件以外的无关用户改动；不使用破坏性 Git 命令，不重写旧 tag 或远程历史。

---

### Task 1: 锁定版本、发布范围和当前能力口径

**Files:**
- Modify: `package.json:3`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `docs/github-release-runbook.md`
- Modify: `docs/windows-private-beta-quick-start.md`
- Modify: `docs/modules/windows-portable-release.md`
- Modify: `.github/workflows/windows-release-build.yml`
- Create: `scripts/crown-source-secret-audit.mjs`
- Create (ignored control file): `.superpowers/sdd/crown-0.2.0-source-files.safe.txt`
- Test: `tests/crown-portable-release-builder.test.mjs`
- Test: `tests/crown-release-audit.test.mjs`
- Test: `tests/crown-portable-runtime.test.mjs`
- Test: `tests/crown-release-workflow.test.mjs`
- Create: `tests/crown-source-secret-audit.test.mjs`

**Interfaces:**
- Consumes: 最终 capability matrix、最终运行默认状态和 production allowlist。
- Produces: `package.version=0.2.0`、tag contract `v0.2.0`、不含旧 `0/0/0` 当前口径的发布文档和明确 source scope。

- [ ] **Step 1: 写版本与默认停止契约 RED 测试**

在 `tests/crown-portable-runtime.test.mjs` 使用现有 `fs` 与 `APP_VERSION` 增加：

```js
test('portable app and package expose the same 0.2.0 release version', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.version, '0.2.0')
  assert.equal(APP_VERSION, '0.2.0')
})
```

现有 `Dashboard starts from a foreign cwd...leaves child processes off` 测试继续负责 Watcher/Worker 默认 off；不新增不存在的 helper。把 `tests/crown-release-workflow.test.mjs` 的 trigger 测试改为先要求 `pull_request` 指向 `main`，同时保留 `workflow_dispatch`、`push.main`、`push.tags=v*` 和 read-only permissions：

```js
assert.match(source, /^on:\r?\n  workflow_dispatch:\r?\n  pull_request:\r?\n    branches:\r?\n      - main\r?\n  push:\r?\n    branches:\r?\n      - main\r?\n    tags:\r?\n      - 'v\*'$/m)
assert.match(source, /npm run release:source-audit -- --mode worktree/)
```

`tests/crown-source-secret-audit.test.mjs` 先锁定两种读取模式：`worktree` 读取全部 tracked 文件，`index` 用 `git ls-files -s -z` + `git cat-file blob` 读取 index blob；binary 跳过，非法 UTF-8 阻断。测试必须证明真实 token/private key 会失败，并只允许 `tests/crown-release-audit.test.mjs` 中两种已审计的 synthetic fixture 各恰好 3 次。fixture 在测试中由不触发 pattern 的片段动态拼接，allowlist 只保存 expected SHA-256、path 和 count；scanner 源码、计划和错误输出都不得连续写出完整 synthetic literal。allowlisted digest 数量增减、同一行混入第二个 secret、其他路径出现相同 digest 都必须失败；错误只输出 repo-relative path/reason，不输出命中内容。

Expected: 在版本仍为 `0.1.0` 或文档/fixture 仍要求 capability `0/0/0` 时 FAIL。

- [ ] **Step 2: 运行 RED**

```powershell
node --test --test-concurrency=1 tests/crown-portable-runtime.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs tests/crown-source-secret-audit.test.mjs
```

Expected: FAIL，指出 package version 或默认运行/capability 当前口径不一致。

- [ ] **Step 3: 将 npm 版本原子更新为 0.2.0**

```powershell
npm version 0.2.0 --no-git-tag-version
if ($LASTEXITCODE -ne 0) { throw 'npm-version-update-failed' }
```

Expected: `package.json` 与 `package-lock.json` 都为 `0.2.0`，未创建 tag、未 commit。

- [ ] **Step 4: 更新发布文档的当前能力和默认停止边界**

把旧“当前 capability 必须为 `0/0/0`”改为：

```text
发行物携带当前已验证 capability matrix；未验证 row 保持 0。首次启动、人工登录和换版本身不得自动启动 Watcher、Betting Worker 或真实投注 intent；新数据目录不得启动 Reconciliation Worker。Fresh Portable 不携带本次受控验收的 marker/private state/report，campaign overlay 为 not_applicable 且不授予 Submit。复用数据时 partial residue fail-closed、exhausted/stopped 保持 terminal；仅允许 exact due unknown 触发独立只读 reconciliation，Preview/Submit 始终为 0。
```

Expected: README、runbook、用户说明和模块文档与最终 matrix 一致，同时继续要求默认运行状态 off。

同时把 `.github/workflows/windows-release-build.yml` 的 trigger 精确改为：

```yaml
on:
  workflow_dispatch:
  pull_request:
    branches:
      - main
  push:
    branches:
      - main
    tags:
      - 'v*'
```

Expected: Draft PR 可以产生同一套只读、锁定 runtime 的完整 Windows check；workflow 的 test/build step 在 clean-check 前运行 `npm run release:source-audit -- --mode worktree`。不得加入 `pull_request_target`、write permission 或 secret。

同时实现 `scripts/crown-source-secret-audit.mjs` 和 npm script：

```json
"release:source-audit": "node scripts/crown-source-secret-audit.mjs"
```

scanner 的 secret pattern 至少覆盖 GitHub/OpenAI token 与 private-key header；固定 synthetic allowlist 先用 match SHA-256 验证 exact path + exact occurrence count，再移除已知 match 后扫描剩余内容。实现与测试均通过分段构造 pattern 测试值，避免 scanner 自身成为命中源。`--mode worktree|index` 以外参数全部拒绝。

- [ ] **Step 5: 生成 intended source 清单并检查混合工作区**

```powershell
git status --short --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'git-status-failed' }
git diff --name-status
if ($LASTEXITCODE -ne 0) { throw 'git-diff-name-status-failed' }
git ls-files --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'git-untracked-list-failed' }
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'release-scope-main-fetch-failed' }
git diff --name-status origin/main...HEAD
if ($LASTEXITCODE -ne 0) { throw 'existing-branch-delta-read-failed' }
```

逐项分类为 `source/docs/tests/safe-fixture/release-source` 或 `runtime/private/unrelated`，再使用 `apply_patch` 创建 `.superpowers/sdd/crown-0.2.0-source-files.safe.txt`：每行恰好一个已人工读取并通过敏感检查的 repo-relative 路径，使用 `/`、不含 glob、空行、重复项或绝对路径。该清单必须覆盖相对 `origin/main` 已存在于当前 branch commit 历史中的全部 intended path、所有 intended tracked 修改/删除和 intended untracked 新增；不得只审计工作区增量。最终 Portable ZIP 始终位于仓库外，只上传 Release，绝不进入 source 清单或 Git。清单不得包含 `.superpowers/sdd/evidence/`、`storage/`、`data/runtime/`、日志、数据库、session、profile 或 raw/private capture。清单由 `.superpowers/sdd/.gitignore` 隔离，不进入 Git。

Expected: 只有前四类进入清单；清单之外的工作区变化保持未暂存，后续禁止 `git add -u`、`git add -A` 或目录级宽泛 stage。

- [ ] **Step 6: 运行 focused GREEN**

```powershell
node --test --test-concurrency=1 tests/crown-portable-runtime.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs tests/crown-source-secret-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'release-focused-tests-failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'release-diff-check-failed' }
```

Expected: 0 failed，0 whitespace error；只允许已知的 LF/CRLF 提示。

- [ ] **Step 7: Commit（仅在完整 scope 审核后执行）**

该步骤延后到 Task 3，与其他最终代码一起显式 stage；本任务不得单独提交部分版本文件。

### Task 2: 在当前工作区完成全程序预发布终验

**Files:**
- Create: `.superpowers/sdd/crown-0.2.0-pre-release-validation.md`
- Read: `package.json`
- Read: `release/windows-production-allowlist.json`
- Read: `release/windows-runtime-lock.json`
- Read: 全部 `tests/**/*.test.mjs` 与 `frontend/src/**/*.test.ts*` 的运行结果

**Interfaces:**
- Consumes: 三个投注计划的 Gate 证据和当前完整工作区。
- Produces: 可进入候选提交的预发布测试矩阵、风险清单和敏感扫描结论。

- [ ] **Step 1: 停止并核对测试干扰进程**

按正式停止流程关闭 Dashboard、Watcher 和 Betting Worker，确认没有测试或 launcher 残留写入正式 SQLite。Expected: 只停止 installation/PID/start-time/probe 匹配的项目进程，不按进程名批量 kill。

- [ ] **Step 2: 运行完整后端、语法、前端与构建**

```powershell
npm test
if ($LASTEXITCODE -ne 0) { throw 'pre-release-backend-tests-failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'pre-release-syntax-check-failed' }
npm --prefix frontend run test
if ($LASTEXITCODE -ne 0) { throw 'pre-release-frontend-tests-failed' }
npm --prefix frontend run build
if ($LASTEXITCODE -ne 0) { throw 'pre-release-frontend-build-failed' }
```

Expected: 四条命令 exit code 0；backend/frontend 0 failed；syntax 文件数与当前源文件数一致；production build 无 warning/error 阻断项。

- [ ] **Step 3: 运行监控、投注和故障矩阵**

```powershell
npm run crown:monitor:acceptance-audit
if ($LASTEXITCODE -ne 0) { throw 'monitor-acceptance-audit-failed' }
node --test --test-concurrency=1 tests/crown-monitor-v2-integration.test.mjs tests/crown-monitor-state-store.test.mjs tests/crown-monitor-process.test.mjs tests/crown-signal-dual-task.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'monitor-fault-matrix-failed' }
node --test --test-concurrency=1 tests/crown-task10-auto-submit.test.mjs tests/crown-betting-b1-integration.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-worker.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-bet-batch-store.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'betting-fault-matrix-failed' }
node --test --test-concurrency=1 tests/crown-betting-security-audit.test.mjs tests/crown-betting-protocol-redaction.test.mjs tests/crown-betting-protocol-execution-evidence.test.mjs tests/crown-capability-matrix.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'betting-security-matrix-failed' }
```

Expected: 全部 0 failed；重复 Submit 计数为 0；unknown 不自动重投；未验证 row 仍为 0；安全审计无 raw secret/path 命中。

- [ ] **Step 4: 运行 Dashboard API 与浏览器主要流程**

验证桌面与 390px：登录入口、Operations、监控报警、投注规则、投注账号、比赛列表；检查 console、network、页面溢出和 mutation contract。

Expected: console error/warning 0；请求只到 loopback/明确 Crown 运行边界；Operations 与 API 对 Watcher、Worker、batch、unknown、reconciliation 和 capability 的显示一致。

- [ ] **Step 5: 运行发布与 Windows launcher focused**

```powershell
node --test --test-concurrency=1 tests/crown-release-workflow.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-portable-paths.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-windows-launcher.test.mjs tests/crown-windows-desktop-shortcut.test.mjs tests/crown-origin.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-manual-login-bridge.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'release-launcher-focused-tests-failed' }
```

Expected: 0 failed；launcher 不依赖 cwd、不误杀其他 Node；快捷方式幂等；旧远程 updater 入口继续不存在。

- [ ] **Step 6: 执行候选源码敏感扫描**

```powershell
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'pre-release-diff-check-failed' }
node --test --test-concurrency=1 tests/crown-betting-security-audit.test.mjs tests/crown-release-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'pre-release-security-tests-failed' }
npm run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'source-secret-scan-failed' }
$forbiddenTracked = @(git ls-files | rg '^(storage|data/runtime|logs|browser-profiles|crown-sessions|private)(/|$)|\.(sqlite|db|log)$')
if ($LASTEXITCODE -gt 1) { throw 'tracked-path-scan-failed' }
if ($forbiddenTracked.Count -gt 0) { $forbiddenTracked; throw 'forbidden-runtime-file-is-tracked' }
```

Expected: 两个安全测试 exit code 0；`git ls-files` 的禁止路径扫描无输出。源代码字段名或安全断言中的敏感关键词由测试 allowlist 审核，不得在报告中复制任何秘密值。

- [ ] **Step 7: 写预发布验证报告**

报告记录命令、exit code、测试计数、浏览器矩阵、runtime 状态、发现/修复项和剩余风险。Expected: 不含账号、token、session、原始响应、完整 bet id 或本机私有路径。

### Task 3: 显式提交、推送并创建 GitHub PR

**Files:**
- Stage: Task 1 intended source 清单中的 source/docs/tests/safe-fixture/release-source
- Exclude: `storage/`、`data/runtime/`、logs、private/raw capture、local database/session/profile、临时 build 输出
- Create: `.superpowers/sdd/crown-0.2.0-pre-pr-tree.safe.json`
- Create: `.superpowers/sdd/crown-0.2.0-pr.md`
- Create: `.superpowers/sdd/crown-0.2.0-pr-context.safe.json`

**Interfaces:**
- Consumes: Task 2 全绿报告和审核后的 intended source 清单。
- Produces: 一个审计清楚的候选 commit、远程 branch 和 Draft PR。

- [ ] **Step 1: 再次检查 GitHub 前置条件**

```powershell
gh --version
if ($LASTEXITCODE -ne 0) { throw 'gh-version-check-failed' }
gh auth status
if ($LASTEXITCODE -ne 0) { throw 'gh-auth-check-failed' }
git remote get-url origin
if ($LASTEXITCODE -ne 0) { throw 'origin-read-failed' }
git branch --show-current
if ($LASTEXITCODE -ne 0) { throw 'branch-read-failed' }
```

Expected: `gh >= 2.92`、账号 `Austin-C1` 已登录、origin 为 `https://github.com/Austin-C1/hg-.git`、当前分支为既有本地开发分支 `codex/demo-auto-betting-manual-portable`；clean publish branch `codex/crown-0.2.0-release` 尚不存在，稍后只从 `origin/main` 创建。

同时执行并保存默认分支：

```powershell
$DefaultBranch = gh repo view Austin-C1/hg- --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0 -or $DefaultBranch -ne 'main') { throw 'unexpected-default-branch' }
```

- [ ] **Step 2: 只按审核后的逐文件清单 stage**

```powershell
$SourceListPath = '.superpowers/sdd/crown-0.2.0-source-files.safe.txt'
$SourceFiles = @(Get-Content -LiteralPath $SourceListPath -Encoding utf8 | Where-Object { $_ -ne '' })
if ($SourceFiles.Count -eq 0) { throw 'source-file-list-empty' }
if (($SourceFiles | Sort-Object -Unique).Count -ne $SourceFiles.Count) { throw 'source-file-list-duplicate' }
foreach ($file in $SourceFiles) {
  if ($file -match '(^[A-Za-z]:)|(^/)|\\|[*?]|(^|/)\.\.?(/|$)|^(\.git|\.superpowers|storage|data/runtime|logs|browser-profiles|crown-sessions|private)(/|$)|\.(sqlite|db|log)$') {
    throw "unsafe-source-list-entry:$file"
  }
}
git check-ignore -q -- $SourceListPath
if ($LASTEXITCODE -ne 0) { throw 'source-file-list-must-be-ignored' }
git add -- $SourceFiles
if ($LASTEXITCODE -ne 0) { throw 'explicit-source-stage-failed' }
```

阶段二/三实现时新增的源码、测试和 safe fixtures 必须先经人工读取、脱敏测试和 allowlist 分类，再用 `apply_patch` 加入该逐文件清单。任何清单外文件继续保持未暂存。禁止 `git add -u`、`git add -A`、目录级 `git add src` 或强制加入 `.superpowers/sdd/evidence/`。

Expected: `git diff --cached --name-status` 只包含已审核内容；`git status --short` 中 runtime/private/unrelated 项仍未暂存。

- [ ] **Step 3: 审计 staged diff**

```powershell
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'cached-diff-check-failed' }
git diff --cached --stat
if ($LASTEXITCODE -ne 0) { throw 'cached-diff-stat-failed' }
git diff --cached --name-status
if ($LASTEXITCODE -ne 0) { throw 'cached-diff-name-status-failed' }
npm run release:source-audit -- --mode index
if ($LASTEXITCODE -ne 0) { throw 'staged-source-secret-scan-failed' }
$SourceFiles = @(Get-Content -LiteralPath '.superpowers/sdd/crown-0.2.0-source-files.safe.txt' -Encoding utf8 | Where-Object { $_ -ne '' })
if ($SourceFiles.Count -eq 0) { throw 'source-file-list-empty' }
$stagedForbidden = @(git diff --cached --name-only --diff-filter=ACMR | rg '^(storage|data/runtime|logs|browser-profiles|crown-sessions|private)(/|$)|\.(sqlite|db|log)$')
if ($LASTEXITCODE -gt 1) { throw 'staged-path-scan-failed' }
if ($stagedForbidden.Count -gt 0) { $stagedForbidden; throw 'forbidden-runtime-file-staged' }
$CachedFiles = @(git diff --cached --name-only --diff-filter=ACMRD)
if ($LASTEXITCODE -ne 0) { throw 'cached-file-list-failed' }
$MissingFromReviewedList = @($CachedFiles | Where-Object { $_ -notin $SourceFiles })
if ($MissingFromReviewedList.Count -gt 0) { $MissingFromReviewedList; throw 'staged-file-not-in-reviewed-list' }
git diff --cached
if ($LASTEXITCODE -ne 0) { throw 'cached-diff-read-failed' }
```

Expected: 无无关文件、秘密、数据库、session、日志、private capture 或旧远程 updater 残留；版本和当前 capability 文档一致。

- [ ] **Step 4: 创建候选 commit**

```powershell
git commit -m "release: prepare crown monitor 0.2.0"
if ($LASTEXITCODE -ne 0) { throw 'candidate-commit-failed' }
$DefaultBranch = gh repo view Austin-C1/hg- --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0 -or $DefaultBranch -ne 'main') { throw 'unexpected-default-branch' }
git fetch origin $DefaultBranch
if ($LASTEXITCODE -ne 0) { throw 'default-branch-fetch-failed' }
$BaseCommit = git rev-parse ("origin/{0}" -f $DefaultBranch)
git merge-base --is-ancestor $BaseCommit HEAD
if ($LASTEXITCODE -ne 0) {
  git merge --no-edit ("origin/{0}" -f $DefaultBranch)
  if ($LASTEXITCODE -ne 0) { throw 'candidate-base-merge-failed' }
}
$CandidateCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'candidate-commit-read-failed' }
$SourceFiles = @(Get-Content -LiteralPath '.superpowers/sdd/crown-0.2.0-source-files.safe.txt' -Encoding utf8 | Where-Object { $_ -ne '' })
$CandidateChangedFiles = @(git diff --name-only --diff-filter=ACMRD $BaseCommit $CandidateCommit)
if ($LASTEXITCODE -ne 0) { throw 'candidate-delta-read-failed' }
$UnreviewedCandidateFiles = @($CandidateChangedFiles | Where-Object { $_ -notin $SourceFiles })
if ($UnreviewedCandidateFiles.Count -gt 0) { $UnreviewedCandidateFiles; throw 'candidate-file-not-in-reviewed-list' }
```

Expected: commit 成功且包含执行时最新 `origin/main` 作为祖先；从该 base 到 candidate 的全部新增、修改、重命名和删除 path 均属于 reviewed source list，包括候选 branch 之前已经 commit 的改动。如有 merge conflict 则停止并人工审计，不自动选择一侧；不 amend、不 rebase、不重写旧历史。

- [ ] **Step 5: 从候选 commit 建立 clean worktree 并复验**

执行时必须使用 `superpowers:using-git-worktrees`。在仓库外 clean worktree 运行：

```powershell
$ErrorActionPreference = 'Stop'
$CandidateCommit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'candidate-commit-read-failed' }
$DefaultBranch = gh repo view Austin-C1/hg- --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0 -or $DefaultBranch -ne 'main') { throw 'unexpected-default-branch' }
git fetch origin $DefaultBranch
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-base-fetch-failed' }
$BaseCommit = git rev-parse ("origin/{0}" -f $DefaultBranch)
git merge-base --is-ancestor $BaseCommit $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'tested-tree-does-not-contain-current-base' }
$CandidateTree = git rev-parse "$CandidateCommit^{tree}"
if ($LASTEXITCODE -ne 0 -or $CandidateTree -notmatch '^[0-9a-f]{40}$') { throw 'candidate-tree-read-failed' }
$PrePrWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-pre-pr'
if (Test-Path -LiteralPath $PrePrWorktree) { throw 'pre-pr-worktree-path-must-be-absent' }
git worktree add --detach $PrePrWorktree $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-worktree-create-failed' }
npm --prefix $PrePrWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-backend-install-failed' }
npm --prefix (Join-Path $PrePrWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-frontend-install-failed' }
npm --prefix $PrePrWorktree test
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-backend-tests-failed' }
npm --prefix $PrePrWorktree run check
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-syntax-check-failed' }
npm --prefix (Join-Path $PrePrWorktree 'frontend') run test
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-frontend-tests-failed' }
npm --prefix (Join-Path $PrePrWorktree 'frontend') run build
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-frontend-build-failed' }
npm --prefix $PrePrWorktree run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'pre-pr-full-tree-secret-scan-failed' }
$candidateForbidden = @(git -C $PrePrWorktree ls-files | rg '^(storage|data/runtime|logs|browser-profiles|crown-sessions|private)(/|$)|\.(sqlite|db|log)$')
if ($LASTEXITCODE -gt 1) { throw 'pre-pr-full-tree-path-scan-failed' }
if ($candidateForbidden.Count -gt 0) { $candidateForbidden; throw 'pre-pr-forbidden-runtime-file-tracked' }
$PrePrStatus = git -C $PrePrWorktree status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($PrePrStatus)) { throw 'pre-pr-worktree-not-clean' }
```

Expected: 所有命令 exit code 0；最后 `git status` 为空。随后使用 `apply_patch` 把实际 `{schemaVersion:"crown-pre-pr-tree-v1",repository:"Austin-C1/hg-",baseCommit,sourceCommit,sourceTree,fullTestPassed:true,checkedAt}` 写入 ignored 的 `.superpowers/sdd/crown-0.2.0-pre-pr-tree.safe.json`；`fullTestPassed` 必须是 JSON boolean，不是字符串。

- [ ] **Step 6: 推送 branch 并创建 Draft PR**

先从 Task 2 报告读取实际测试计数、浏览器结果、真实验收批次/金额和最终 capability matrix，再使用 `apply_patch` 创建 `.superpowers/sdd/crown-0.2.0-pr.md`。正文必须按以下固定结构写入真实值，不得留下占位符：

```markdown
## 改动
说明监控、规则卡、账户调度、Preview/Submit、unknown/reconciliation、Dashboard 与 Portable 的最终变化。

## 原因与根因
说明旧程序尚未形成生产 worker 闭环、能力范围受限及发布口径过期的根因。

## 用户影响
说明本版本直接替代原程序，但首次启动仍默认关闭 Watcher、Betting Worker 和真实投注。

## 验证
逐条写入全量 backend、syntax、frontend、build、focused、浏览器、clean-checkout 和 release audit 的实际命令、计数与结果。

## 真实验收范围
写入受控 Submit 的实际 accepted/rejected/unknown 批次、子单数、累计金额和停止原因，只允许脱敏摘要。

## Capability
逐行写入最终 exact row 的 Preview/Submit/Reconciliation 位和证据版本；未验证 row 明确为 0。

## 已知限制
列出仍需人工登录、unknown 不自动重投、未验证盘口 fail closed、首启默认停止等边界。

## 回滚
说明旧 tag/Release 保留；发生问题时停止新版本并切回上一已验证 Release，不覆盖 v0.2.0 资产。
```

然后执行：

```powershell
$ErrorActionPreference = 'Stop'
$DefaultBranch = gh repo view Austin-C1/hg- --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0 -or $DefaultBranch -ne 'main') { throw 'unexpected-default-branch' }
$PrePrEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pre-pr-tree.safe.json' | ConvertFrom-Json
if ($PrePrEvidence.schemaVersion -ne 'crown-pre-pr-tree-v1' -or $PrePrEvidence.repository -ne 'Austin-C1/hg-' -or $PrePrEvidence.fullTestPassed -isnot [bool] -or $PrePrEvidence.fullTestPassed -ne $true) { throw 'invalid-pre-pr-evidence' }
foreach ($field in 'baseCommit','sourceCommit','sourceTree') {
  if ([string]$PrePrEvidence.$field -notmatch '^[0-9a-f]{40}$') { throw "invalid-pre-pr-$field" }
}
if ((git rev-parse HEAD) -ne [string]$PrePrEvidence.sourceCommit) { throw 'head-drifted-after-pre-pr-test' }
if ((git rev-parse 'HEAD^{tree}') -ne [string]$PrePrEvidence.sourceTree) { throw 'tree-drifted-after-pre-pr-test' }
git fetch origin $DefaultBranch
if ($LASTEXITCODE -ne 0) { throw 'publish-base-fetch-failed' }
$CurrentBase = git rev-parse ("origin/{0}" -f $DefaultBranch)
if ($CurrentBase -ne [string]$PrePrEvidence.baseCommit) { throw 'default-branch-moved-rebuild-candidate' }
$CandidateBranch = 'codex/crown-0.2.0-release'
git show-ref --verify --quiet ("refs/heads/{0}" -f $CandidateBranch)
if ($LASTEXITCODE -eq 0) { throw 'clean-publish-branch-already-exists' }
if ($LASTEXITCODE -gt 1) { throw 'local-publish-branch-check-failed' }
$RemotePublishBranch = git ls-remote --heads origin ("refs/heads/{0}" -f $CandidateBranch)
if ($LASTEXITCODE -ne 0) { throw 'remote-publish-branch-check-failed' }
if (-not [string]::IsNullOrWhiteSpace($RemotePublishBranch)) { throw 'remote-publish-branch-already-exists' }
$PublishWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-publish'
if (Test-Path -LiteralPath $PublishWorktree) { throw 'publish-worktree-path-must-be-absent' }
git worktree add -b $CandidateBranch $PublishWorktree $CurrentBase
if ($LASTEXITCODE -ne 0) { throw 'publish-worktree-create-failed' }
if ((git -C $PublishWorktree rev-parse HEAD) -ne $CurrentBase -or -not [string]::IsNullOrWhiteSpace((git -C $PublishWorktree status --porcelain=v1 --untracked-files=all))) { throw 'publish-worktree-not-clean-at-base' }
git -C $PublishWorktree read-tree --reset -u ([string]$PrePrEvidence.sourceCommit)
if ($LASTEXITCODE -ne 0) { throw 'publish-final-tree-rebuild-failed' }
$SourceFiles = @(Get-Content -LiteralPath '.superpowers/sdd/crown-0.2.0-source-files.safe.txt' -Encoding utf8 | Where-Object { $_ -ne '' })
$PublishChanged = @(git -C $PublishWorktree diff --cached --name-only --diff-filter=ACMRD)
if ($LASTEXITCODE -ne 0 -or $PublishChanged.Count -eq 0) { throw 'publish-tree-delta-empty-or-unreadable' }
$UnreviewedPublishFiles = @($PublishChanged | Where-Object { $_ -notin $SourceFiles })
if ($UnreviewedPublishFiles.Count -gt 0) { $UnreviewedPublishFiles; throw 'publish-tree-file-not-reviewed' }
git -C $PublishWorktree diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'publish-tree-diff-check-failed' }
npm --prefix $PublishWorktree run release:source-audit -- --mode index
if ($LASTEXITCODE -ne 0) { throw 'publish-tree-index-source-audit-failed' }
git -C $PublishWorktree commit -m "release: prepare crown monitor 0.2.0"
if ($LASTEXITCODE -ne 0) { throw 'clean-publish-commit-failed' }
$PublishCommit = git -C $PublishWorktree rev-parse HEAD
$PublishTree = git -C $PublishWorktree rev-parse 'HEAD^{tree}'
$PublishParent = git -C $PublishWorktree rev-parse 'HEAD^'
$PublishCommitCount = [int](git -C $PublishWorktree rev-list --count "$CurrentBase..$PublishCommit")
$PublishMessage = (git -C $PublishWorktree log -1 --format=%B).Trim()
if ($PublishTree -ne [string]$PrePrEvidence.sourceTree -or $PublishParent -ne $CurrentBase -or $PublishCommitCount -ne 1 -or $PublishMessage -ne 'release: prepare crown monitor 0.2.0') { throw 'clean-publish-history-contract-failed' }
npm --prefix $PublishWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'publish-backend-install-failed' }
npm --prefix (Join-Path $PublishWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'publish-frontend-install-failed' }
npm --prefix $PublishWorktree test
if ($LASTEXITCODE -ne 0) { throw 'publish-backend-tests-failed' }
npm --prefix $PublishWorktree run check
if ($LASTEXITCODE -ne 0) { throw 'publish-syntax-check-failed' }
npm --prefix (Join-Path $PublishWorktree 'frontend') run test
if ($LASTEXITCODE -ne 0) { throw 'publish-frontend-tests-failed' }
npm --prefix (Join-Path $PublishWorktree 'frontend') run build
if ($LASTEXITCODE -ne 0) { throw 'publish-frontend-build-failed' }
npm --prefix $PublishWorktree run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'publish-worktree-source-audit-failed' }
if (-not [string]::IsNullOrWhiteSpace((git -C $PublishWorktree status --porcelain=v1 --untracked-files=all))) { throw 'publish-worktree-dirty-after-tests' }
git -C $PublishWorktree push -u origin $CandidateBranch
if ($LASTEXITCODE -ne 0) { throw 'candidate-push-failed' }
$PrUrl = gh pr create --repo Austin-C1/hg- --draft --base $DefaultBranch --head $CandidateBranch --title "release: crown monitor 0.2.0" --body-file '.superpowers/sdd/crown-0.2.0-pr.md'
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PrUrl)) { throw 'draft-pr-create-failed' }
$PrNumber = gh pr view $PrUrl --repo Austin-C1/hg- --json number --jq '.number'
if ($LASTEXITCODE -ne 0 -or [int]$PrNumber -le 0) { throw 'draft-pr-number-read-failed' }
```

使用 `apply_patch` 把实际 `{schemaVersion:"crown-release-pr-context-v1", repository:"Austin-C1/hg-", prNumber, headBranch, baseBranch:"main"}` 写入 ignored 的 `.superpowers/sdd/crown-0.2.0-pr-context.safe.json`，不得写 token、URL query 或本机路径。后续所有 `gh pr` 命令都必须从此文件取显式 PR 编号并带 `--repo Austin-C1/hg-`。

PR 正文必须说明完整改动、根因、用户影响、测试矩阵、真实验收范围、capability、已知限制和回滚方式。

Expected: 远程 branch 从冻结 `origin/main` 出发且只多一个固定 commit；其 tree 与已测试 source tree 完全一致，旧开发分支任何中间 commit/blob/message 都未 push；Draft PR 指向 `Austin-C1/hg-` 的默认分支。

### Task 4: 完成 CI 并锁定尚未合并的候选 commit

**Files:**
- Read: `.github/workflows/windows-release-build.yml`
- Read: PR checks/logs
- Create: `.superpowers/sdd/crown-0.2.0-clean-checkout-validation.md`
- Create: `.superpowers/sdd/crown-0.2.0-candidate.safe.json`

**Interfaces:**
- Consumes: Draft PR、clean worktree 结果和 GitHub Actions。
- Produces: 尚未替换默认分支的已审计候选 commit、clean checkout 报告和可构建发布源。

- [ ] **Step 1: 等待并处理 GitHub checks**

```powershell
$ErrorActionPreference = 'Stop'
$PrContext = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pr-context.safe.json' | ConvertFrom-Json
if ($PrContext.schemaVersion -ne 'crown-release-pr-context-v1' -or $PrContext.repository -ne 'Austin-C1/hg-' -or [int]$PrContext.prNumber -le 0) { throw 'invalid-pr-context' }
$PrNumber = [int]$PrContext.prNumber
gh pr checks $PrNumber --repo Austin-C1/hg- --watch
if ($LASTEXITCODE -ne 0) { throw 'pr-checks-not-green' }
```

Expected: 所有 required checks success。失败时使用 GitHub Actions 日志查根因，修复后重新执行本地完整验证，不允许跳过 required check。

- [ ] **Step 2: 锁定 PR head，不合并默认分支**

```powershell
$PrContext = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pr-context.safe.json' | ConvertFrom-Json
if ($PrContext.schemaVersion -ne 'crown-release-pr-context-v1' -or $PrContext.repository -ne 'Austin-C1/hg-' -or [int]$PrContext.prNumber -le 0) { throw 'invalid-pr-context' }
$PrNumber = [int]$PrContext.prNumber
$PrState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,headRefName,baseRefOid,baseRefName,mergeable,isDraft' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'pr-state-read-failed' }
if (-not $PrState.isDraft) { throw 'pr-must-remain-draft-before-fresh-windows-pass' }
if ($PrState.mergeable -ne 'MERGEABLE') { throw 'pr-not-mergeable-or-not-resolved' }
$CandidateCommit = [string]$PrState.headRefOid
if ($CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'invalid-candidate-commit' }
$CandidateBranch = [string]$PrState.headRefName
if ($CandidateBranch -notlike 'codex/*' -or $CandidateBranch -ne [string]$PrContext.headBranch) { throw 'unexpected-candidate-branch' }
$BaseCommit = [string]$PrState.baseRefOid
if ($PrState.baseRefName -ne 'main' -or $BaseCommit -notmatch '^[0-9a-f]{40}$') { throw 'unexpected-pr-base' }
git fetch origin $CandidateBranch $PrState.baseRefName
if ($LASTEXITCODE -ne 0) { throw 'candidate-and-base-fetch-failed' }
git merge-base --is-ancestor $BaseCommit $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'candidate-does-not-contain-current-base' }
```

Expected: 得到唯一 40 位 candidate SHA；PR 仍为 Draft，默认分支和旧 Release 均未改变。

Draft PR 的 `mergeStateStatus=BLOCKED` 是正常表现，不能据此拒绝候选；这里只使用 GraphQL `mergeable=MERGEABLE` 判断无内容冲突。若返回 `UNKNOWN`，等待 GitHub 计算完成后重跑本步骤，不得改成放宽检查。

- [ ] **Step 3: 从 candidate commit 建立新的 clean worktree**

```powershell
$ErrorActionPreference = 'Stop'
$PrContext = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pr-context.safe.json' | ConvertFrom-Json
$PrNumber = [int]$PrContext.prNumber
$CandidateCommit = gh pr view $PrNumber --repo Austin-C1/hg- --json headRefOid --jq '.headRefOid'
if ($LASTEXITCODE -ne 0 -or $CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'candidate-commit-read-failed' }
$CandidateWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-candidate'
if (Test-Path -LiteralPath $CandidateWorktree) { throw 'candidate-worktree-path-must-be-absent' }
git worktree add --detach $CandidateWorktree $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'candidate-worktree-create-failed' }
```

Expected: worktree HEAD 等于 `$CandidateCommit`，`git status --porcelain` 为空。

- [ ] **Step 4: 在 candidate commit 上重复完整验证**

```powershell
$ErrorActionPreference = 'Stop'
$PrContext = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pr-context.safe.json' | ConvertFrom-Json
$PrNumber = [int]$PrContext.prNumber
$CandidateCommit = gh pr view $PrNumber --repo Austin-C1/hg- --json headRefOid --jq '.headRefOid'
if ($LASTEXITCODE -ne 0 -or $CandidateCommit -notmatch '^[0-9a-f]{40}$') { throw 'candidate-commit-read-failed' }
$CandidateWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-candidate'
if ((git -C $CandidateWorktree rev-parse HEAD) -ne $CandidateCommit) { throw 'candidate-worktree-drift' }
npm --prefix $CandidateWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'candidate-backend-install-failed' }
npm --prefix (Join-Path $CandidateWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'candidate-frontend-install-failed' }
npm --prefix $CandidateWorktree test
if ($LASTEXITCODE -ne 0) { throw 'candidate-backend-tests-failed' }
npm --prefix $CandidateWorktree run check
if ($LASTEXITCODE -ne 0) { throw 'candidate-syntax-check-failed' }
npm --prefix (Join-Path $CandidateWorktree 'frontend') run test
if ($LASTEXITCODE -ne 0) { throw 'candidate-frontend-tests-failed' }
npm --prefix (Join-Path $CandidateWorktree 'frontend') run build
if ($LASTEXITCODE -ne 0) { throw 'candidate-frontend-build-failed' }
npm --prefix $CandidateWorktree run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'candidate-source-secret-scan-failed' }
Push-Location -LiteralPath $CandidateWorktree
try {
  node --test --test-concurrency=1 tests/crown-release-workflow.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-windows-launcher.test.mjs tests/crown-windows-desktop-shortcut.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'candidate-release-focused-tests-failed' }
} finally {
  Pop-Location
}
$CandidateStatus = git -C $CandidateWorktree status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($CandidateStatus)) { throw 'candidate-worktree-not-clean' }
```

Expected: 全部 exit code 0；clean checkout 保持干净；报告记录 candidate SHA、tree SHA、命令、测试计数和 exit code。

- [ ] **Step 5: 复核远程版本名未占用并冻结候选**

```powershell
$PrContext = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-pr-context.safe.json' | ConvertFrom-Json
$PrNumber = [int]$PrContext.prNumber
$PrState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,headRefName,baseRefOid,baseRefName,isDraft' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $PrState.isDraft) { throw 'candidate-pr-state-read-failed' }
$CandidateCommit = [string]$PrState.headRefOid
$BaseCommit = [string]$PrState.baseRefOid
$CandidateBranch = [string]$PrState.headRefName
$CandidateWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-candidate'
$TestedCommit = git -C $CandidateWorktree rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CandidateCommit -ne $TestedCommit) { throw 'candidate-head-changed-after-clean-test' }
if ($PrState.baseRefName -ne 'main' -or $CandidateBranch -ne [string]$PrContext.headBranch) { throw 'candidate-pr-branch-drift' }
git merge-base --is-ancestor $BaseCommit $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'tested-candidate-does-not-contain-current-base' }
$remoteTag = git ls-remote --tags origin refs/tags/v0.2.0
if ($LASTEXITCODE -ne 0) { throw 'remote-tag-check-failed' }
if (-not [string]::IsNullOrWhiteSpace($remoteTag)) { throw 'v0.2.0-tag-already-exists' }
$ReleaseQuery = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){tagName}}}'
$ExistingReleaseTag = gh api graphql -f owner='Austin-C1' -f name='hg-' -f tag='v0.2.0' -f query=$ReleaseQuery --jq '.data.repository.release.tagName // empty'
if ($LASTEXITCODE -ne 0) { throw 'release-name-check-failed' }
if (-not [string]::IsNullOrWhiteSpace($ExistingReleaseTag)) { throw 'v0.2.0-release-already-exists' }
$CandidateTree = git rev-parse "$CandidateCommit^{tree}"
if ($LASTEXITCODE -ne 0 -or $CandidateTree -notmatch '^[0-9a-f]{40}$') { throw 'candidate-tree-read-failed' }
```

Expected: 候选 SHA/tree 写入 `.superpowers/sdd/crown-0.2.0-clean-checkout-validation.md`，并使用 `apply_patch` 把 `{schemaVersion:"crown-release-candidate-v1", repository:"Austin-C1/hg-", prNumber, headBranch, baseBranch:"main", baseCommit, candidateCommit, candidateTree, packageVersion:"0.2.0", fullTestPassed:true, checkedAt}` 的实际值写入 `.superpowers/sdd/crown-0.2.0-candidate.safe.json`；boolean 必须为 JSON boolean。此时不更新默认分支、不创建 tag、不上传 Release。若版本名被占用则停止并提高版本，禁止覆盖。

### Task 5: 构建、审计并完成 Fresh Windows 验收

**Files:**
- Read: `release/windows-runtime-lock.json`
- Read: `release/windows-production-allowlist.json`
- Create outside repo: `CrownMonitor-0.2.0-windows-x64-portable.zip`
- Create: `.superpowers/sdd/crown-0.2.0-portable-acceptance.md`
- Create: `.superpowers/sdd/crown-0.2.0-portable.safe.json`

**Interfaces:**
- Consumes: Task 4 冻结且尚未合并的 candidate clean checkout、锁定 Node/Chromium runtime 和 production allowlist。
- Produces: 最终 ZIP、SHA-256、byte size、release audit 和 Fresh Windows 10/11 证据。

- [ ] **Step 1: 校验锁定 runtime**

```powershell
$ErrorActionPreference = 'Stop'
$RuntimeLock = Get-Content -Raw -LiteralPath 'release/windows-runtime-lock.json' -Encoding utf8 | ConvertFrom-Json
if ($RuntimeLock.platform -ne 'win32' -or $RuntimeLock.arch -ne 'x64' -or $RuntimeLock.node.version -ne '22.23.1') { throw 'runtime-lock-platform-or-version-mismatch' }
$RuntimeRoot = Join-Path $env:TEMP 'crown-monitor-v0.2.0-runtimes'
if (Test-Path -LiteralPath $RuntimeRoot) { throw 'runtime-root-path-must-be-absent' }
$NodeArchive = Join-Path $env:TEMP 'crown-node-v22.23.1-win-x64.zip'
$ChromiumArchive = Join-Path $env:TEMP 'crown-chromium-149.0.7827.55-win64.zip'
if (Test-Path -LiteralPath $NodeArchive) { throw 'node-archive-path-must-be-absent' }
if (Test-Path -LiteralPath $ChromiumArchive) { throw 'chromium-archive-path-must-be-absent' }
$NodeExtract = Join-Path $RuntimeRoot 'node'
$ChromiumExtract = Join-Path $RuntimeRoot 'chromium'
New-Item -ItemType Directory -Path $NodeExtract,$ChromiumExtract | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $RuntimeLock.node.archiveUrl -OutFile $NodeArchive -MaximumRedirection 0
$NodeHash = (Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($NodeHash -cne [string]$RuntimeLock.node.archiveSha256) { throw 'node-runtime-archive-hash-mismatch' }
Expand-Archive -LiteralPath $NodeArchive -DestinationPath $NodeExtract
Invoke-WebRequest -UseBasicParsing -Uri $RuntimeLock.chromium.archiveUrl -OutFile $ChromiumArchive -MaximumRedirection 0
$ChromiumHash = (Get-FileHash -LiteralPath $ChromiumArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ChromiumHash -cne [string]$RuntimeLock.chromium.archiveSha256) { throw 'chromium-runtime-archive-hash-mismatch' }
Expand-Archive -LiteralPath $ChromiumArchive -DestinationPath $ChromiumExtract
$env:CROWN_NODE_RUNTIME_DIR = Join-Path $NodeExtract ([string]$RuntimeLock.node.archiveRoot)
$env:CROWN_CHROMIUM_RUNTIME_DIR = Join-Path $ChromiumExtract ([string]$RuntimeLock.chromium.archiveRoot)
if (-not (Test-Path -LiteralPath (Join-Path $env:CROWN_NODE_RUNTIME_DIR $RuntimeLock.node.executable) -PathType Leaf)) { throw 'node-runtime-executable-missing' }
if (-not (Test-Path -LiteralPath (Join-Path $env:CROWN_CHROMIUM_RUNTIME_DIR $RuntimeLock.chromium.executable) -PathType Leaf)) { throw 'chromium-runtime-executable-missing' }
```

Expected: 两个 archive hash 与 lock 完全一致；实际 runtime tree digest/entry count 由下一步 `release:portable` 再次强制验证为 lock 中的 `treeSha256/treeEntries`，任一漂移即失败。

- [ ] **Step 2: 在仓库外空目录构建 Portable**

```powershell
$RuntimeLock = Get-Content -Raw -LiteralPath 'release/windows-runtime-lock.json' -Encoding utf8 | ConvertFrom-Json
$RuntimeRoot = Join-Path $env:TEMP 'crown-monitor-v0.2.0-runtimes'
$NodeExtract = Join-Path $RuntimeRoot 'node'
$ChromiumExtract = Join-Path $RuntimeRoot 'chromium'
$env:CROWN_NODE_RUNTIME_DIR = Join-Path $NodeExtract ([string]$RuntimeLock.node.archiveRoot)
$env:CROWN_CHROMIUM_RUNTIME_DIR = Join-Path $ChromiumExtract ([string]$RuntimeLock.chromium.archiveRoot)
if (-not (Test-Path -LiteralPath (Join-Path $env:CROWN_NODE_RUNTIME_DIR $RuntimeLock.node.executable) -PathType Leaf)) { throw 'node-runtime-executable-missing' }
if (-not (Test-Path -LiteralPath (Join-Path $env:CROWN_CHROMIUM_RUNTIME_DIR $RuntimeLock.chromium.executable) -PathType Leaf)) { throw 'chromium-runtime-executable-missing' }
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
$PrNumber = [int]$CandidateEvidence.prNumber
$PrState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,baseRefOid,isDraft' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $PrState.isDraft) { throw 'candidate-pr-must-still-be-draft' }
$CandidateCommit = [string]$PrState.headRefOid
if ($CandidateCommit -ne [string]$CandidateEvidence.candidateCommit -or [string]$PrState.baseRefOid -ne [string]$CandidateEvidence.baseCommit) { throw 'candidate-pr-drift-before-build' }
$CandidateWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-candidate'
if ((git -C $CandidateWorktree rev-parse HEAD) -ne $CandidateCommit) { throw 'candidate-worktree-drift' }
$CandidateStatusBeforeBuild = git -C $CandidateWorktree status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($CandidateStatusBeforeBuild)) { throw 'candidate-worktree-dirty-before-build' }
npm --prefix $CandidateWorktree run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'candidate-source-audit-failed-before-build' }
$env:CROWN_RELEASE_OUT = Join-Path $env:TEMP 'crown-monitor-0.2.0-release'
if (Test-Path -LiteralPath $env:CROWN_RELEASE_OUT) { throw 'release-output-path-must-be-absent' }
npm --prefix $CandidateWorktree run release:portable -- --version '0.2.0' --node-runtime $env:CROWN_NODE_RUNTIME_DIR --chromium-runtime $env:CROWN_CHROMIUM_RUNTIME_DIR --out $env:CROWN_RELEASE_OUT
if ($LASTEXITCODE -ne 0) { throw 'portable-build-failed' }
npm --prefix $CandidateWorktree run release:audit -- --root $env:CROWN_RELEASE_OUT
if ($LASTEXITCODE -ne 0) { throw 'portable-first-audit-failed' }
```

Expected: allowlist 完整、额外文件 0、forbidden/secret/path 命中 0、118 项默认联赛、runtime lock 完全一致、Watcher/Worker/runtime intent 默认 off；ZIP 内不存在 controlled-live DB marker、private binding state 或 completion report，空数据目录 classifier 恰好返回 `not_applicable/authorized=false`。

- [ ] **Step 3: 压缩、解压并二次审计**

```powershell
$ErrorActionPreference = 'Stop'
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
$CandidateWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-candidate'
if (-not (Test-Path -LiteralPath $CandidateWorktree -PathType Container) -or (git -C $CandidateWorktree rev-parse HEAD) -ne [string]$CandidateEvidence.candidateCommit) { throw 'candidate-worktree-invalid-before-zip-audit' }
if (-not [string]::IsNullOrWhiteSpace((git -C $CandidateWorktree status --porcelain=v1 --untracked-files=all))) { throw 'candidate-worktree-dirty-before-zip-audit' }
$env:CROWN_RELEASE_OUT = Join-Path $env:TEMP 'crown-monitor-0.2.0-release'
if (-not (Test-Path -LiteralPath $env:CROWN_RELEASE_OUT -PathType Container)) { throw 'release-output-missing-before-zip' }
$ReleaseZip = Join-Path $env:TEMP 'CrownMonitor-0.2.0-windows-x64-portable.zip'
$AuditExtract = Join-Path $env:TEMP 'crown-monitor-0.2.0-zip-audit'
if (Test-Path -LiteralPath $ReleaseZip) { throw 'release-zip-path-must-be-absent' }
if (Test-Path -LiteralPath $AuditExtract) { throw 'zip-audit-path-must-be-absent' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($env:CROWN_RELEASE_OUT, $ReleaseZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $AuditExtract
npm --prefix $CandidateWorktree run release:audit -- --root $AuditExtract
if ($LASTEXITCODE -ne 0) { throw 'portable-expanded-audit-failed' }
```

Expected: ZIP 顶层直接是 Portable 根；解压树与 `release-files.json` 完全一致；二次 audit 0 finding。

- [ ] **Step 4: 计算最终资产 SHA-256 和 byte size**

```powershell
$ReleaseZip = Join-Path $env:TEMP 'CrownMonitor-0.2.0-windows-x64-portable.zip'
$ReleaseHash = (Get-FileHash -Algorithm SHA256 $ReleaseZip).Hash.ToLowerInvariant()
$ReleaseSize = [int64](Get-Item -LiteralPath $ReleaseZip).Length
if ($ReleaseHash -notmatch '^[0-9a-f]{64}$' -or $ReleaseSize -le 0) { throw 'invalid-release-asset-digest' }
```

Expected: 使用 `apply_patch` 把实际 `{schemaVersion:"crown-release-portable-v1", repository:"Austin-C1/hg-", candidateCommit, candidateTree, packageVersion:"0.2.0", assetName:"CrownMonitor-0.2.0-windows-x64-portable.zip", sha256, byteSize, firstAuditPassed:true, expandedAuditPassed:true, outsideCwdSmokePassed:false, windows10Passed:false, windows11Passed:false, downloadedAssetSmokePassed:false, checkedAt}` 写入 `.superpowers/sdd/crown-0.2.0-portable.safe.json`。所有 boolean 必须为 JSON boolean；任何重新压缩都会使证据失效并要求重跑 Task 5。

- [ ] **Step 5: 运行仓库外 cwd smoke**

从中文、空格、非系统盘路径启动；验证 loopback Dashboard、备用端口、快捷方式、移动后修复、精确停止和用户数据隔离；首次启动读取状态，断言 campaign overlay=`not_applicable`、authorized=false、Watcher/Worker/runtime intent 全部 off。

Expected: 不依赖系统 cwd、Node、Chrome、Edge 或 Docker；不写 Startup/Service/注册表；不因 `not_applicable` 自动启动或授权 Submit；关闭可见窗口后当前 installation 精确停止。

- [ ] **Step 6: 运行 Fresh Windows 10/11 x64 矩阵**

在 Windows Sandbox/VM 中分别验证：解压、首次启动、Dashboard health、内置 Chromium、人工登录边界、Watcher/Worker 默认 off、campaign overlay 新安装四态合同、快捷方式幂等、手工换版数据复用；换版 fixture 分别覆盖 partial residue、exhausted restart 和 exhausted upgrade。

Expected: Windows 10 和 Windows 11 两组全部 PASS；Fresh install 为 `not_applicable/authorized=false`，partial residue 为 `campaign-binding-incomplete/FT_bet=0`，exhausted restart/upgrade 仍 terminal/FT_bet=0；记录系统版本、矩阵结果、ZIP hash/size 和脱敏错误码，不记录账号或用户路径。

两组都通过后使用 `apply_patch` 把 portable safe evidence 中 `windows10Passed`、`windows11Passed`、`outsideCwdSmokePassed` 更新为 `true`，同时写入两组脱敏 OS build 和完成时间；重新读取 JSON，逐项断言 candidate SHA/tree、hash、size 和三项 PASS，任何缺失都阻止 Task 6。

### Task 6: 合并替代原程序、创建 latest Release 并下载后复验

**Files:**
- Create: `.superpowers/sdd/crown-0.2.0-release-notes.md`
- Upload: `CrownMonitor-0.2.0-windows-x64-portable.zip`
- Modify after verification: `docs/project-memory.md`
- Modify after verification: `docs/module-index.md`

**Interfaces:**
- Consumes: 冻结的 candidate SHA/tree、最终 ZIP、hash/size、Fresh Windows PASS 和 release notes。
- Produces: 默认分支上的完成版、tag `v0.2.0`、GitHub latest Release、可复核下载资产和发布后项目记忆。

- [ ] **Step 1: 写 Release notes**

从 Task 5 验收报告读取最终 SHA-256、byte size、Fresh Windows 版本和最终 capability matrix。使用 `apply_patch` 在当前 workspace 内创建已忽略的 `.superpowers/sdd/crown-0.2.0-release-notes.md`；创建前要求文件不存在并用 `git check-ignore` 证明它不会进入 source commit，上传时再通过 `Resolve-Path` 取得绝对路径。正文固定为“适用系统、主要功能、已验证 Capability、安全默认值、安装与换版、验证摘要、SHA-256 与大小、已知限制、回滚”九节；每节都写实际值，不得留下占位符。必须明确 Windows 10/11 x64、真实投注默认 off、人工登录/启动边界、unknown 不自动重投、未验证 row 为 0 和旧 Release 保留。

Expected: 不包含账号、session、token、raw response、完整 bet id 或本机路径。

- [ ] **Step 2: 最后核对候选并用 expected-base lease 原子替换默认分支**

```powershell
$ErrorActionPreference = 'Stop'
function Assert-JsonTrueBoolean($Object, [string]$Name) {
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property -or $Property.Value -isnot [bool] -or $Property.Value -ne $true) {
    throw "json-boolean-not-true:$Name"
  }
}
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
$PortableEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-portable.safe.json' | ConvertFrom-Json
if ($CandidateEvidence.schemaVersion -ne 'crown-release-candidate-v1' -or $CandidateEvidence.repository -ne 'Austin-C1/hg-' -or $CandidateEvidence.packageVersion -ne '0.2.0' -or $CandidateEvidence.baseBranch -ne 'main' -or $CandidateEvidence.headBranch -ne 'codex/crown-0.2.0-release' -or $CandidateEvidence.prNumber.GetType().FullName -notin @('System.Int32','System.Int64') -or [int64]$CandidateEvidence.prNumber -le 0) { throw 'candidate-evidence-contract-invalid' }
foreach ($field in 'baseCommit','candidateCommit','candidateTree') {
  if ([string]$CandidateEvidence.$field -notmatch '^[0-9a-f]{40}$') { throw "candidate-evidence-digest-invalid:$field" }
}
Assert-JsonTrueBoolean $CandidateEvidence 'fullTestPassed'
if ($PortableEvidence.schemaVersion -ne 'crown-release-portable-v1' -or $PortableEvidence.repository -ne 'Austin-C1/hg-' -or $PortableEvidence.packageVersion -ne '0.2.0' -or $PortableEvidence.assetName -ne 'CrownMonitor-0.2.0-windows-x64-portable.zip' -or $PortableEvidence.candidateCommit -ne $CandidateEvidence.candidateCommit -or $PortableEvidence.candidateTree -ne $CandidateEvidence.candidateTree) { throw 'portable-evidence-contract-invalid' }
foreach ($field in 'firstAuditPassed','expandedAuditPassed','outsideCwdSmokePassed','windows10Passed','windows11Passed') { Assert-JsonTrueBoolean $PortableEvidence $field }
if ([string]$PortableEvidence.sha256 -notmatch '^[0-9a-f]{64}$' -or $PortableEvidence.byteSize.GetType().FullName -notin @('System.Int32','System.Int64') -or [int64]$PortableEvidence.byteSize -le 0) { throw 'portable-evidence-digest-invalid' }
$ReleaseZip = Join-Path $env:TEMP 'CrownMonitor-0.2.0-windows-x64-portable.zip'
if (-not (Test-Path -LiteralPath $ReleaseZip -PathType Leaf)) { throw 'release-zip-missing-before-merge' }
$CurrentReleaseHash = (Get-FileHash -LiteralPath $ReleaseZip -Algorithm SHA256).Hash.ToLowerInvariant()
$CurrentReleaseSize = [int64](Get-Item -LiteralPath $ReleaseZip).Length
if ($CurrentReleaseHash -cne [string]$PortableEvidence.sha256 -or $CurrentReleaseSize -ne [int64]$PortableEvidence.byteSize) { throw 'release-zip-drift-before-merge' }
$PrNumber = [int]$CandidateEvidence.prNumber
$PrState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,baseRefOid,isDraft,mergeable' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'pr-state-read-failed' }
if (-not $PrState.isDraft -or $PrState.mergeable -ne 'MERGEABLE') { throw 'pr-not-ready-for-final-gate' }
if ([string]$PrState.headRefOid -ne [string]$CandidateEvidence.candidateCommit) { throw 'pr-head-changed-after-acceptance' }
if ([string]$PrState.baseRefOid -ne [string]$CandidateEvidence.baseCommit) { throw 'pr-base-changed-after-acceptance' }
gh pr checks $PrNumber --repo Austin-C1/hg- --watch
if ($LASTEXITCODE -ne 0) { throw 'pr-checks-not-green' }
$CheckedState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,baseRefOid,isDraft,mergeable' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $CheckedState.isDraft -or $CheckedState.mergeable -ne 'MERGEABLE' -or [string]$CheckedState.headRefOid -ne [string]$CandidateEvidence.candidateCommit -or [string]$CheckedState.baseRefOid -ne [string]$CandidateEvidence.baseCommit) { throw 'pr-drift-after-checks' }
gh pr ready $PrNumber --repo Austin-C1/hg-
if ($LASTEXITCODE -ne 0) { throw 'pr-ready-failed' }
$ReadyState = gh pr view $PrNumber --repo Austin-C1/hg- --json 'headRefOid,baseRefOid,isDraft,mergeable' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $ReadyState.isDraft -or $ReadyState.mergeable -ne 'MERGEABLE' -or [string]$ReadyState.headRefOid -ne [string]$CandidateEvidence.candidateCommit -or [string]$ReadyState.baseRefOid -ne [string]$CandidateEvidence.baseCommit) { throw 'ready-pr-not-frozen-or-mergeable' }
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'final-main-fetch-failed' }
$RemoteBase = git rev-parse origin/main
if ($RemoteBase -ne [string]$CandidateEvidence.baseCommit) { throw 'default-branch-moved-before-atomic-update' }
$CandidateCommit = [string]$CandidateEvidence.candidateCommit
$BaseCommit = [string]$CandidateEvidence.baseCommit
$CandidateTreeSpec = "$CandidateCommit^{tree}"
$ActualCandidateTree = git rev-parse $CandidateTreeSpec
if ($LASTEXITCODE -ne 0 -or $ActualCandidateTree -cne [string]$CandidateEvidence.candidateTree) { throw 'candidate-tree-evidence-mismatch-before-atomic-update' }
$CandidateParentLine = [string](git rev-list --parents -n 1 $CandidateCommit)
if ($LASTEXITCODE -ne 0) { throw 'candidate-parent-read-failed-before-atomic-update' }
$CandidateParentParts = @($CandidateParentLine -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($CandidateParentParts.Count -ne 2 -or $CandidateParentParts[0] -cne $CandidateCommit -or $CandidateParentParts[1] -cne $BaseCommit) { throw 'candidate-must-have-exactly-frozen-base-parent' }
$CandidateRange = "$BaseCommit..$CandidateCommit"
$CandidateCommitCount = [int](git rev-list --count $CandidateRange)
if ($LASTEXITCODE -ne 0 -or $CandidateCommitCount -ne 1) { throw 'candidate-must-be-exactly-one-commit' }
git merge-base --is-ancestor $RemoteBase $CandidateCommit
if ($LASTEXITCODE -ne 0) { throw 'candidate-is-not-fast-forward-of-frozen-base' }
$CandidateRefspec = "{0}:refs/heads/main" -f $CandidateCommit
$BaseLease = "--force-with-lease=refs/heads/main:{0}" -f [string]$CandidateEvidence.baseCommit
git push origin $CandidateRefspec $BaseLease
if ($LASTEXITCODE -ne 0) { throw 'atomic-main-fast-forward-failed' }
```

Expected: 只有 Task 5 的 Fresh Windows 10/11 全部 PASS 后才执行；PR checks 与冻结 candidate SHA 完全一致。更新是 candidate 对 frozen base 的普通 fast-forward，`--force-with-lease` 只作为 expected-base compare-and-swap，不允许非 fast-forward，也不改写历史；main 在最后检查后哪怕移动一次，push 都在写入前失败。

- [ ] **Step 3: 验证默认分支 final tree 与已验收候选完全一致**

```powershell
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
$DefaultBranch = gh repo view Austin-C1/hg- --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0 -or $DefaultBranch -ne 'main') { throw 'unexpected-default-branch' }
git fetch origin $DefaultBranch
if ($LASTEXITCODE -ne 0) { throw 'merged-default-fetch-failed' }
$MergeCommit = git rev-parse ("origin/{0}" -f $DefaultBranch)
if ($LASTEXITCODE -ne 0 -or $MergeCommit -ne [string]$CandidateEvidence.candidateCommit) { throw 'default-branch-not-frozen-candidate' }
git diff --exit-code $CandidateEvidence.candidateCommit $MergeCommit -- .
if ($LASTEXITCODE -ne 0) { throw 'merge-tree-differs-from-accepted-candidate' }
$MergedTree = git rev-parse "$MergeCommit^{tree}"
if ($MergedTree -ne [string]$CandidateEvidence.candidateTree) { throw 'merge-tree-digest-mismatch' }
$MergedWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-merged'
if (Test-Path -LiteralPath $MergedWorktree) { throw 'merged-worktree-path-must-be-absent' }
git worktree add --detach $MergedWorktree $MergeCommit
if ($LASTEXITCODE -ne 0) { throw 'merged-worktree-create-failed' }
npm --prefix $MergedWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'merged-backend-install-failed' }
npm --prefix (Join-Path $MergedWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'merged-frontend-install-failed' }
npm --prefix $MergedWorktree test
if ($LASTEXITCODE -ne 0) { throw 'merged-backend-tests-failed' }
npm --prefix $MergedWorktree run check
if ($LASTEXITCODE -ne 0) { throw 'merged-syntax-check-failed' }
npm --prefix (Join-Path $MergedWorktree 'frontend') run test
if ($LASTEXITCODE -ne 0) { throw 'merged-frontend-tests-failed' }
npm --prefix (Join-Path $MergedWorktree 'frontend') run build
if ($LASTEXITCODE -ne 0) { throw 'merged-frontend-build-failed' }
npm --prefix $MergedWorktree run release:source-audit -- --mode worktree
if ($LASTEXITCODE -ne 0) { throw 'merged-source-secret-scan-failed' }
$MergedStatus = git -C $MergedWorktree status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($MergedStatus)) { throw 'merged-worktree-not-clean' }
```

Expected: 默认分支 tree 与 Fresh Windows 已验收候选 byte-for-byte 一致；完整测试再次 exit code 0；clean checkout 无改动。若 tree 不同，禁止 tag/Release，回到 Task 4/5 对新候选重验。

- [ ] **Step 4: 创建 tag、等待 tag workflow 并核对 Release 名称**

```powershell
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'release-tag-main-fetch-failed' }
$MergeCommit = git rev-parse origin/main
if ($LASTEXITCODE -ne 0 -or $MergeCommit -ne [string]$CandidateEvidence.candidateCommit) { throw 'release-tag-main-not-candidate' }
$remoteTag = git ls-remote --tags origin refs/tags/v0.2.0
if ($LASTEXITCODE -ne 0) { throw 'remote-tag-check-failed' }
if (-not [string]::IsNullOrWhiteSpace($remoteTag)) { throw 'v0.2.0-tag-already-exists' }
if ((git tag --list v0.2.0).Count -gt 0) { throw 'local-v0.2.0-tag-already-exists' }
$ReleaseQuery = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){tagName}}}'
$ExistingReleaseTag = gh api graphql -f owner='Austin-C1' -f name='hg-' -f tag='v0.2.0' -f query=$ReleaseQuery --jq '.data.repository.release.tagName // empty'
if ($LASTEXITCODE -ne 0) { throw 'release-name-check-failed' }
if (-not [string]::IsNullOrWhiteSpace($ExistingReleaseTag)) { throw 'v0.2.0-release-already-exists' }
git tag -a v0.2.0 -m "Crown Monitor 0.2.0" $MergeCommit
if ($LASTEXITCODE -ne 0) { throw 'local-release-tag-create-failed' }
git push origin v0.2.0
if ($LASTEXITCODE -ne 0) { throw 'release-tag-push-failed' }
$TagRuns = gh run list --workflow windows-release-build.yml --commit $MergeCommit --event push --limit 10 --json 'databaseId,headBranch' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'tag-workflow-query-failed' }
$TagRunId = $TagRuns | Where-Object { $_.headBranch -eq 'v0.2.0' } | Select-Object -ExpandProperty databaseId -First 1
if ([string]::IsNullOrWhiteSpace($TagRunId)) { throw 'tag-workflow-not-visible-yet' }
gh run watch $TagRunId --exit-status
if ($LASTEXITCODE -ne 0) { throw 'tag-workflow-failed' }
```

Expected: tag 只指向已复验的默认分支 candidate commit；tag workflow success。workflow 尚未可见时先回报状态并再次查询，不得跳过。

- [ ] **Step 5: 创建 Draft Release 并上传唯一正式 ZIP**

```powershell
$PortableEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-portable.safe.json' | ConvertFrom-Json
$ReleaseZip = Join-Path $env:TEMP 'CrownMonitor-0.2.0-windows-x64-portable.zip'
$ReleaseNotesRelativePath = '.superpowers/sdd/crown-0.2.0-release-notes.md'
git check-ignore -q -- $ReleaseNotesRelativePath
if ($LASTEXITCODE -ne 0) { throw 'release-notes-must-be-ignored' }
$ReleaseNotesPath = (Resolve-Path -LiteralPath $ReleaseNotesRelativePath).Path
if (-not (Test-Path -LiteralPath $ReleaseNotesPath -PathType Leaf)) { throw 'release-notes-file-missing' }
if (-not (Test-Path -LiteralPath $ReleaseZip -PathType Leaf)) { throw 'release-zip-missing-before-upload' }
$UploadHash = (Get-FileHash -LiteralPath $ReleaseZip -Algorithm SHA256).Hash.ToLowerInvariant()
$UploadSize = [int64](Get-Item -LiteralPath $ReleaseZip).Length
if ($UploadHash -cne [string]$PortableEvidence.sha256 -or $UploadSize -ne [int64]$PortableEvidence.byteSize) { throw 'release-zip-drift-before-upload' }
gh release create v0.2.0 $ReleaseZip --repo Austin-C1/hg- --title 'Crown Monitor 0.2.0' --notes-file $ReleaseNotesPath --draft --verify-tag --latest=false
if ($LASTEXITCODE -ne 0) { throw 'draft-release-create-failed' }
```

Expected: Release 保持 Draft，尚未替代旧 latest；资产只有正式完整 Portable ZIP，不上传 updater manifest、signature、差分包或 unsigned Actions artifact。

- [ ] **Step 6: 从 GitHub 实际下载并复核**

```powershell
$ErrorActionPreference = 'Stop'
$PortableEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-portable.safe.json' | ConvertFrom-Json
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
$MergedWorktree = Join-Path $env:TEMP 'crown-monitor-v0.2.0-merged'
if (-not (Test-Path -LiteralPath $MergedWorktree -PathType Container) -or (git -C $MergedWorktree rev-parse HEAD) -ne [string]$CandidateEvidence.candidateCommit) { throw 'merged-worktree-invalid-before-download-audit' }
if (-not [string]::IsNullOrWhiteSpace((git -C $MergedWorktree status --porcelain=v1 --untracked-files=all))) { throw 'merged-worktree-dirty-before-download-audit' }
$ReleaseDownloadDir = Join-Path $env:TEMP 'crown-monitor-v0.2.0-github-download'
$DownloadedZip = Join-Path $ReleaseDownloadDir 'CrownMonitor-0.2.0-windows-x64-portable.zip'
if (Test-Path -LiteralPath $ReleaseDownloadDir) { throw 'release-download-path-must-be-absent' }
gh release download v0.2.0 --repo Austin-C1/hg- --pattern 'CrownMonitor-0.2.0-windows-x64-portable.zip' --dir $ReleaseDownloadDir
if ($LASTEXITCODE -ne 0) { throw 'draft-release-download-failed' }
$DownloadedHash = (Get-FileHash -Algorithm SHA256 $DownloadedZip).Hash.ToLowerInvariant()
$DownloadedSize = [int64](Get-Item -LiteralPath $DownloadedZip).Length
if ($DownloadedHash -cne [string]$PortableEvidence.sha256 -or $DownloadedSize -ne [int64]$PortableEvidence.byteSize) { throw 'downloaded-release-asset-mismatch' }
$DownloadedExtract = Join-Path $env:TEMP 'crown-monitor-v0.2.0-github-download-audit'
if (Test-Path -LiteralPath $DownloadedExtract) { throw 'download-audit-path-must-be-absent' }
Expand-Archive -LiteralPath $DownloadedZip -DestinationPath $DownloadedExtract
npm --prefix $MergedWorktree run release:audit -- --root $DownloadedExtract
if ($LASTEXITCODE -ne 0) { throw 'downloaded-release-audit-failed' }
```

Expected: 下载文件 hash 和 size 与 Task 5 完全一致；解压后 `release:audit` 再次 0 finding。

- [ ] **Step 7: 运行下载路径最后 smoke**

在另一 Fresh Windows 环境从真实下载目录解压，验证启动、快捷方式、用户数据复用、Watcher/Worker 默认 off，以及 Fresh install campaign overlay=`not_applicable/authorized=false`。

Expected: PASS；否则保持 Draft、记录不可用原因且不替换旧 latest，修复后使用更高版本，禁止静默替换 `v0.2.0` 资产。

通过后使用 `apply_patch` 把 `.superpowers/sdd/crown-0.2.0-portable.safe.json` 的 `downloadedAssetSmokePassed` 更新为 `true`，同时写入本次 GitHub downloaded hash、byte size、脱敏 OS build 和完成时间；hash/size 必须等于既有 `sha256/byteSize`。这是 Step 8 的机器门禁，不能只在文字报告中写 PASS。

- [ ] **Step 8: 发布为 latest 并核对公开状态**

```powershell
$ErrorActionPreference = 'Stop'
function Assert-JsonTrueBoolean($Object, [string]$Name) {
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property -or $Property.Value -isnot [bool] -or $Property.Value -ne $true) {
    throw "json-boolean-not-true:$Name"
  }
}
$PortableEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-portable.safe.json' | ConvertFrom-Json
$CandidateEvidence = Get-Content -Raw -LiteralPath '.superpowers/sdd/crown-0.2.0-candidate.safe.json' | ConvertFrom-Json
if ($CandidateEvidence.schemaVersion -ne 'crown-release-candidate-v1' -or $CandidateEvidence.repository -ne 'Austin-C1/hg-' -or [string]$CandidateEvidence.candidateCommit -notmatch '^[0-9a-f]{40}$' -or [string]$CandidateEvidence.candidateTree -notmatch '^[0-9a-f]{40}$') { throw 'prepublish-candidate-evidence-invalid' }
if ($PortableEvidence.schemaVersion -ne 'crown-release-portable-v1' -or $PortableEvidence.repository -ne 'Austin-C1/hg-' -or $PortableEvidence.assetName -ne 'CrownMonitor-0.2.0-windows-x64-portable.zip' -or $PortableEvidence.candidateCommit -ne $CandidateEvidence.candidateCommit -or $PortableEvidence.candidateTree -ne $CandidateEvidence.candidateTree -or [string]$PortableEvidence.sha256 -notmatch '^[0-9a-f]{64}$' -or $PortableEvidence.byteSize.GetType().FullName -notin @('System.Int32','System.Int64') -or [int64]$PortableEvidence.byteSize -le 0) { throw 'prepublish-evidence-contract-invalid' }
foreach ($field in 'firstAuditPassed','expandedAuditPassed','outsideCwdSmokePassed','windows10Passed','windows11Passed','downloadedAssetSmokePassed') { Assert-JsonTrueBoolean $PortableEvidence $field }
$DownloadedSmokeAt = [DateTimeOffset]::MinValue
$DownloadedSmokeTimeValid = [DateTimeOffset]::TryParse([string]$PortableEvidence.downloadedSmokeCompletedAt, [ref]$DownloadedSmokeAt)
if ([string]$PortableEvidence.downloadedSha256 -cne [string]$PortableEvidence.sha256 -or $PortableEvidence.downloadedByteSize.GetType().FullName -notin @('System.Int32','System.Int64') -or [int64]$PortableEvidence.downloadedByteSize -ne [int64]$PortableEvidence.byteSize -or [string]::IsNullOrWhiteSpace([string]$PortableEvidence.downloadedOsBuild) -or -not $DownloadedSmokeTimeValid) { throw 'downloaded-asset-smoke-evidence-not-green' }
$DraftRelease = gh release view v0.2.0 --repo Austin-C1/hg- --json 'tagName,isDraft,isPrerelease,assets' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $DraftRelease.tagName -ne 'v0.2.0' -or $DraftRelease.isDraft -isnot [bool] -or $DraftRelease.isDraft -ne $true -or $DraftRelease.isPrerelease -isnot [bool] -or $DraftRelease.isPrerelease -ne $false) { throw 'draft-release-state-invalid-before-publish' }
if ($DraftRelease.assets.Count -ne 1 -or $DraftRelease.assets[0].name -ne $PortableEvidence.assetName -or [int64]$DraftRelease.assets[0].size -ne [int64]$PortableEvidence.byteSize) { throw 'draft-release-asset-invalid-before-publish' }
$PeeledTag = git ls-remote --tags origin 'refs/tags/v0.2.0^{}'
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($PeeledTag)) { throw 'release-tag-peel-read-failed' }
$RemoteTagCommit = ($PeeledTag -split '\s+')[0]
if ($RemoteTagCommit -ne [string]$CandidateEvidence.candidateCommit) { throw 'release-tag-target-mismatch-before-publish' }
$PrepublishDownloadDir = Join-Path $env:TEMP 'crown-monitor-v0.2.0-prepublish-download'
if (Test-Path -LiteralPath $PrepublishDownloadDir) { throw 'prepublish-download-path-must-be-absent' }
gh release download v0.2.0 --repo Austin-C1/hg- --pattern $PortableEvidence.assetName --dir $PrepublishDownloadDir
if ($LASTEXITCODE -ne 0) { throw 'prepublish-download-failed' }
$PrepublishZip = Join-Path $PrepublishDownloadDir $PortableEvidence.assetName
$PrepublishHash = (Get-FileHash -LiteralPath $PrepublishZip -Algorithm SHA256).Hash.ToLowerInvariant()
$PrepublishSize = [int64](Get-Item -LiteralPath $PrepublishZip).Length
if ($PrepublishHash -cne [string]$PortableEvidence.sha256 -or $PrepublishSize -ne [int64]$PortableEvidence.byteSize) { throw 'prepublish-asset-digest-mismatch' }
gh release edit v0.2.0 --repo Austin-C1/hg- --draft=false --latest
if ($LASTEXITCODE -ne 0) { throw 'release-publish-latest-failed' }
$PublishedRelease = gh release view v0.2.0 --repo Austin-C1/hg- --json 'tagName,isDraft,isPrerelease,url,assets' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $PublishedRelease.tagName -ne 'v0.2.0' -or $PublishedRelease.isDraft -or $PublishedRelease.isPrerelease) { throw 'published-release-state-invalid' }
if ($PublishedRelease.assets.Count -ne 1 -or $PublishedRelease.assets[0].name -ne $PortableEvidence.assetName -or [int64]$PublishedRelease.assets[0].size -ne [int64]$PortableEvidence.byteSize) { throw 'published-release-asset-invalid' }
$LatestTag = gh api repos/Austin-C1/hg-/releases/latest --jq '.tag_name'
if ($LASTEXITCODE -ne 0 -or $LatestTag -ne 'v0.2.0') { throw 'latest-release-tag-mismatch' }
```

Expected: `isDraft=false`、`isPrerelease=false`，latest 指向 `v0.2.0`，公开资产名称、byte size 和 Task 5 完全一致；只有此步成功后才算替代旧下载版本。

- [ ] **Step 9: 写发布后检查和项目记忆**

按下面顺序执行：先从 `origin/main` 在当前 workspace 内已忽略的 `.worktrees/crown-monitor-v0.2.0-closeout` 建立 worktree 和 `codex/crown-0.2.0-release-closeout` 分支；第一个命令块完成后停止，使用 `apply_patch` 只更新该 worktree 中的 `docs/project-memory.md` 与 `docs/module-index.md`，记录 Release URL、tag、commit、hash、size、测试矩阵、支持范围和回滚条件；再单独运行第二个命令块 stage/commit/PR。不得把两个命令块合并执行，不得写账号、session、原始响应或完整 bet id。

```powershell
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'closeout-main-fetch-failed' }
$RepoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw 'repo-root-read-failed' }
git check-ignore -q -- '.worktrees'
if ($LASTEXITCODE -ne 0) { throw 'worktrees-root-must-be-ignored' }
$CloseoutWorktree = Join-Path (Join-Path $RepoRoot '.worktrees') 'crown-monitor-v0.2.0-closeout'
$ExpectedPrefix = [IO.Path]::GetFullPath((Join-Path $RepoRoot '.worktrees')) + [IO.Path]::DirectorySeparatorChar
if (-not [IO.Path]::GetFullPath($CloseoutWorktree).StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'closeout-worktree-boundary-invalid' }
if (Test-Path -LiteralPath $CloseoutWorktree) { throw 'closeout-worktree-path-must-be-absent' }
git worktree add -b codex/crown-0.2.0-release-closeout $CloseoutWorktree origin/main
if ($LASTEXITCODE -ne 0) { throw 'closeout-worktree-create-failed' }
$CloseoutBase = git rev-parse origin/main
$CloseoutHead = git -C $CloseoutWorktree rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CloseoutHead -ne $CloseoutBase) { throw 'closeout-worktree-base-mismatch' }
```

此处必须使用 `apply_patch` 完成两份文档修改，人工读取 diff 后才运行：

```powershell
$RepoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw 'repo-root-read-failed' }
$CloseoutWorktree = Join-Path (Join-Path $RepoRoot '.worktrees') 'crown-monitor-v0.2.0-closeout'
$ExpectedPrefix = [IO.Path]::GetFullPath((Join-Path $RepoRoot '.worktrees')) + [IO.Path]::DirectorySeparatorChar
if (-not [IO.Path]::GetFullPath($CloseoutWorktree).StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'closeout-worktree-boundary-invalid' }
if (-not (Test-Path -LiteralPath $CloseoutWorktree -PathType Container)) { throw 'closeout-worktree-missing' }
$CloseoutBase = git rev-parse origin/main
$CloseoutHead = git -C $CloseoutWorktree rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CloseoutHead -ne $CloseoutBase) { throw 'closeout-worktree-drift-before-docs-commit' }
$CloseoutChanged = @(git -C $CloseoutWorktree diff --name-only)
$CloseoutUntracked = @(git -C $CloseoutWorktree ls-files --others --exclude-standard)
if ($CloseoutUntracked.Count -ne 0 -or $CloseoutChanged.Count -ne 2 -or 'docs/project-memory.md' -notin $CloseoutChanged -or 'docs/module-index.md' -notin $CloseoutChanged) { throw 'closeout-docs-worktree-scope-invalid' }
git -C $CloseoutWorktree add -- docs/project-memory.md docs/module-index.md
if ($LASTEXITCODE -ne 0) { throw 'closeout-docs-stage-failed' }
git -C $CloseoutWorktree diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'closeout-docs-diff-check-failed' }
$CloseoutPaths = @(git -C $CloseoutWorktree diff --cached --name-only)
if ($CloseoutPaths.Count -ne 2 -or 'docs/project-memory.md' -notin $CloseoutPaths -or 'docs/module-index.md' -notin $CloseoutPaths) { throw 'closeout-scope-invalid' }
git -C $CloseoutWorktree commit -m "docs: record crown monitor 0.2.0 release"
if ($LASTEXITCODE -ne 0) { throw 'closeout-docs-commit-failed' }
git -C $CloseoutWorktree push -u origin codex/crown-0.2.0-release-closeout
if ($LASTEXITCODE -ne 0) { throw 'closeout-docs-push-failed' }
$CloseoutPrUrl = gh pr create --repo Austin-C1/hg- --base main --head codex/crown-0.2.0-release-closeout --title "docs: record crown monitor 0.2.0 release" --body "Records the verified v0.2.0 release URL, commit, SHA-256, size, capability scope, test matrix, and rollback boundary. No program code or private betting evidence changes."
if ($LASTEXITCODE -ne 0) { throw 'closeout-pr-create-failed' }
$CloseoutPrNumber = gh pr view $CloseoutPrUrl --repo Austin-C1/hg- --json number --jq '.number'
if ($LASTEXITCODE -ne 0 -or [int]$CloseoutPrNumber -le 0) { throw 'closeout-pr-number-read-failed' }
gh pr checks $CloseoutPrNumber --repo Austin-C1/hg- --watch
if ($LASTEXITCODE -ne 0) { throw 'closeout-pr-checks-failed' }
$CloseoutHeadCommit = git -C $CloseoutWorktree rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $CloseoutHeadCommit -notmatch '^[0-9a-f]{40}$') { throw 'closeout-head-read-failed' }
gh pr merge $CloseoutPrNumber --repo Austin-C1/hg- --merge --match-head-commit $CloseoutHeadCommit --delete-branch=false
if ($LASTEXITCODE -ne 0) { throw 'closeout-pr-merge-failed' }
```

再次检查 GitHub 文件列表没有敏感数据或旧 updater 入口。最后按项目 AGENTS 规则先运行 Codex Memory `--prewrite` 对账，再运行 `--commit --commit-warnings`；只写跨项目稳定发布规则，不写账号、session 或下注证据。若 closeout 输出 `MERGE_REQUIRED`、`ASK_USER`、删除、敏感信息或冲突，停止并回报，不强行合并。

Expected: 项目文档明确 `v0.2.0` 是最新版本，旧 Release 仅用于回滚；没有把未验证能力写成可用。
