# v0.2.0 发布源范围

本清单冻结 `codex/demo-auto-betting-manual-portable` 工作区在 Task 1 编辑前的 Git 状态。采集命令为 `git status --porcelain=v1 --untracked-files=all`；初始 166 个路径逐项分类，禁止使用整仓暂存。

## 对账摘要

| 分类 | 初始路径数 | 暂存规则 |
|---|---:|---|
| include | 157 | 仅由 `release/source-include-v0.2.0.txt` 作为 `--pathspec-from-file` 输入 |
| exclude | 1 | `config/monitor-settings.json` 留在原工作区，禁止暂存 |
| superseded | 8 | 保留历史正文；按 Task 1 显式 pathspec 暂存，不写入 include 文件 |
| 合计 | 166 | 与 Task 1 编辑前 status 完全一致 |

Task 1 新建的 `docs/release-source-scope-v0.2.0.md` 与 `release/source-include-v0.2.0.txt` 不属于上述初始 166 项，提交时另行显式暂存。初始基线覆盖 157 个 include、8 个 superseded，并另加 2 个 Task 1 新建文件，共 167 个 source path references；exclude 始终保持 unstaged。下方“Task 1 复审修正”另列 4 个在 Task 1 开始时未修改、但因复审发现现行 capability 口径冲突而加入 amended commit 的 tracked 文档。最终 amended commit 共 171 个 no-renames source path references；Git 默认 rename detection 将两组 `src/crown/update/` 删除与对应 `src/crown/runtime/` 新增合并为两条 `R100`，因此显示 169 条 rename-aware records。

## Task 1 复审修正

以下 4 个 tracked 文档在 Task 1 编辑前不属于初始 166 个 status 路径，也不加入原始 157 项 include 清单。复审确认它们仍把历史全零 capability 写成现行事实，因此仅以精确 pathspec 显式暂存对应文档修正；没有扩大到其他干净文件，也没有改变初始分类或 `release/source-include-v0.2.0.txt`。

| Git path | 复审修正原因 | 暂存边界 |
|---|---|---|
| `docs/betting-architecture.md` | 英文当前架构仍声称 Preview/Submit 均未开放；改为 Task 10 exact row `1/1/0`，旧 B2 全零状态标为历史 | 仅该文件，显式 pathspec |
| `docs/crown-current-architecture.md` | 当前架构、能力表和 Dashboard 说明仍使用现行 `0/0/0`；统一为 exact row `1/1/0`、其他 row 与 Reconciliation 关闭、runtime 默认 off | 仅该文件，显式 pathspec |
| `docs/modules/crown-dashboard.md` | Dashboard 模块仍称 capability 全未开放；改为 exact row `1/1/0`，并把 B/B1 旧零能力段落标为历史 | 仅该文件，显式 pathspec |
| `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` | `docs/project-memory.md` 与 `docs/module-index.md` 仍将其列为当前权威设计，但历史验收段仍把 `0/0/0` 写成现行事实；标明该值仅属于历史验收轮次，并补充当前 exact row `1/1/0` 边界 | 仅该文件，显式 pathspec |

最终提交对账：初始 166 项分类仍为 157 include / 1 exclude / 8 superseded；Task 1 初始新建文件仍为 2；复审新增修正文档为 4；提交共有 171 个 no-renames source path references、169 条 rename-aware records和 2 条 `R100`。`config/monitor-settings.json` 始终未暂存。

五份 2026-07-14 旧计划需要加入 Task 1 固定的 Superseded 声明；其余三份 superseded 文档保持现有正文，不扩写声明。

## 初始 166 个路径逐项分类

| # | Git status | 分类 | Git path | 理由 |
|---:|:---:|---|---|---|
| 1 | `M` | include | `README.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 2 | `M` | exclude | `config/monitor-settings.json` | 本机监控设置属于用户运行配置，保留在原工作区，不进入发布源或暂存区。 |
| 3 | `M` | include | `docs/github-release-runbook.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 4 | `M` | include | `docs/module-index.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 5 | `M` | include | `docs/modules/crown-betting-protocol.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 6 | `M` | include | `docs/modules/crown-football-monitor.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 7 | `M` | include | `docs/modules/windows-portable-release.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 8 | `M` | include | `docs/project-memory.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 9 | `M` | superseded | `docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md` | 远程 updater 方案已被手工 Portable 与桌面快捷方式方案取代；保留历史正文并显式提交。 |
| 10 | `M` | include | `docs/superpowers/specs/2026-07-13-crown-demo-account-auto-betting-design.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 11 | `M` | include | `docs/superpowers/specs/2026-07-13-crown-manual-portable-and-desktop-shortcut-design.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 12 | `M` | superseded | `docs/superpowers/specs/2026-07-13-crown-windows-portable-and-remote-update-design.md` | 远程 updater 方案已被手工 Portable 与桌面快捷方式方案取代；保留历史正文并显式提交。 |
| 13 | `M` | include | `docs/windows-private-beta-quick-start.md` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 14 | `M` | include | `frontend/src/App.contract.test.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 15 | `M` | include | `frontend/src/App.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 16 | `M` | include | `frontend/src/components/AppLayout.mobile.test.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 17 | `M` | include | `frontend/src/components/AppLayout.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 18 | `M` | include | `frontend/src/pages/OperationsConsole.test.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 19 | `M` | include | `frontend/src/pages/OperationsConsole.tsx` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 20 | `D` | include | `frontend/src/pages/SystemUpdate.test.tsx` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 21 | `D` | include | `frontend/src/pages/SystemUpdate.tsx` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 22 | `M` | include | `frontend/src/services/api.security.test.ts` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 23 | `M` | include | `frontend/src/services/api.ts` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 24 | `M` | include | `frontend/src/types.ts` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 25 | `M` | include | `package-lock.json` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 26 | `M` | include | `package.json` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 27 | `M` | include | `packaging/windows/launcher/start.ps1` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 28 | `D` | include | `packaging/windows/launcher/update-bootstrap.ps1` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 29 | `M` | include | `packaging/windows/首次使用说明.txt` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 30 | `M` | include | `release/windows-production-allowlist.json` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 31 | `D` | include | `scripts/create-update-manifest.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 32 | `M` | include | `scripts/crown-betting-protocol-analyze.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 33 | `M` | include | `scripts/crown-betting-protocol-capture.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 34 | `M` | include | `scripts/crown-betting-worker.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 35 | `M` | include | `scripts/crown-dashboard.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 36 | `D` | include | `scripts/crown-update-apply.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 37 | `M` | include | `scripts/crown-watch.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 38 | `D` | include | `scripts/sign-release-manifest.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 39 | `M` | include | `scripts/verify-release-artifacts.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 40 | `M` | include | `src/crown/app/app-api.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 41 | `M` | include | `src/crown/app/app-db.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 42 | `M` | include | `src/crown/app/app-repository.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 43 | `M` | include | `src/crown/app/betting-process.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 44 | `M` | include | `src/crown/app/crown-human-login-controller.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 45 | `M` | include | `src/crown/app/monitor-process.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 46 | `M` | include | `src/crown/app/real-betting-dto.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 47 | `M` | include | `src/crown/betting-protocol/capture-redaction.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 48 | `M` | include | `src/crown/betting/auto-betting-consumer.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 49 | `M` | include | `src/crown/betting/auto-betting-rule-card-matcher.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 50 | `M` | include | `src/crown/betting/b2-executor.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 51 | `M` | include | `src/crown/betting/bet-batch-store.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 52 | `M` | include | `src/crown/betting/betting-worker.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 53 | `M` | include | `src/crown/betting/crown-account-execution-provider.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 54 | `M` | include | `src/crown/betting/crown-account-provider.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 55 | `M` | include | `src/crown/betting/crown-bet-response-parser.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 56 | `M` | include | `src/crown/betting/crown-capability-matrix.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 57 | `M` | include | `src/crown/betting/crown-order-field-mapper.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 58 | `M` | include | `src/crown/betting/execution-gate.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 59 | `M` | include | `src/crown/betting/execution-identity.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 60 | `M` | include | `src/crown/betting/multi-account-bet-coordinator.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 61 | `M` | include | `src/crown/betting/real-betting-runtime.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 62 | `M` | include | `src/crown/betting/real-worker-factory.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 63 | `M` | include | `src/crown/betting/today-betting-leagues.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 64 | `M` | include | `src/crown/crown-transform-xml.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 65 | `M` | include | `src/crown/dashboard/static-server.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 66 | `M` | include | `src/crown/login/crown-api-login-manager.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 67 | `M` | include | `src/crown/monitor/monitor-state-store.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 68 | `M` | include | `src/crown/monitor/odds-delta-strategy.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 69 | `M` | include | `src/crown/release/release-audit.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 70 | `M` | include | `src/crown/runtime/portable-paths.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 71 | `D` | include | `src/crown/update/atomic-json-file.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 72 | `D` | include | `src/crown/update/download-asset.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 73 | `D` | include | `src/crown/update/github-release-client.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 74 | `D` | include | `src/crown/update/release-config.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 75 | `D` | include | `src/crown/update/safe-data-path.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 76 | `D` | include | `src/crown/update/safe-extract.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 77 | `D` | include | `src/crown/update/semver.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 78 | `D` | include | `src/crown/update/sqlite-backup.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 79 | `D` | include | `src/crown/update/update-applier.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 80 | `D` | include | `src/crown/update/update-error.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 81 | `D` | include | `src/crown/update/update-health.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 82 | `D` | include | `src/crown/update/update-journal.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 83 | `D` | include | `src/crown/update/update-manifest.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 84 | `D` | include | `src/crown/update/update-preflight.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 85 | `D` | include | `src/crown/update/update-process-lock.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 86 | `D` | include | `src/crown/update/update-service.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 87 | `D` | include | `src/crown/update/update-signature.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 88 | `D` | include | `src/crown/update/windows-update-handoff.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 89 | `D` | include | `src/crown/update/windows-update-runtime.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 90 | `M` | include | `tests/crown-account-provider.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 91 | `M` | include | `tests/crown-api-login-manager.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 92 | `M` | include | `tests/crown-app-api.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 93 | `M` | include | `tests/crown-app-db.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 94 | `M` | include | `tests/crown-app-repository.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 95 | `M` | include | `tests/crown-auto-bet-rule-watcher.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 96 | `M` | include | `tests/crown-auto-betting-consumer.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 97 | `M` | include | `tests/crown-auto-betting-rule-card-delete.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 98 | `M` | include | `tests/crown-auto-betting-rule-card-matcher.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 99 | `M` | include | `tests/crown-bet-batch-store.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 100 | `M` | include | `tests/crown-betting-b1-integration.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 101 | `M` | include | `tests/crown-betting-b2-executor.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 102 | `M` | include | `tests/crown-betting-process.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 103 | `M` | include | `tests/crown-betting-protocol-classifier.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 104 | `M` | include | `tests/crown-betting-protocol-redaction.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 105 | `M` | include | `tests/crown-betting-security-audit.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 106 | `M` | include | `tests/crown-betting-worker.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 107 | `M` | include | `tests/crown-capability-matrix.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 108 | `M` | include | `tests/crown-card-scoped-betting-integration.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 109 | `M` | include | `tests/crown-dashboard-server.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 110 | `M` | include | `tests/crown-execution-gate.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 111 | `D` | include | `tests/crown-github-release-client.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 112 | `M` | include | `tests/crown-mode-scoped-betting-integration.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 113 | `M` | include | `tests/crown-monitor-process.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 114 | `M` | include | `tests/crown-monitor-state-store.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 115 | `M` | include | `tests/crown-monitor-v2-integration.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 116 | `M` | include | `tests/crown-multi-account-bet-coordinator.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 117 | `M` | include | `tests/crown-operations-summary.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 118 | `M` | include | `tests/crown-order-field-mapper.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 119 | `M` | include | `tests/crown-portable-paths.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 120 | `M` | include | `tests/crown-portable-release-builder.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 121 | `M` | include | `tests/crown-portable-runtime.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 122 | `M` | include | `tests/crown-real-betting-runtime.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 123 | `M` | include | `tests/crown-release-audit.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 124 | `M` | include | `tests/crown-safe-data-path.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 125 | `D` | include | `tests/crown-safe-extract.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 126 | `M` | include | `tests/crown-signal-dual-task.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 127 | `D` | include | `tests/crown-sqlite-backup.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 128 | `M` | include | `tests/crown-strategy-engine.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 129 | `M` | include | `tests/crown-today-betting-leagues.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 130 | `M` | include | `tests/crown-transform-xml.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 131 | `D` | include | `tests/crown-update-api.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 132 | `D` | include | `tests/crown-update-applier.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 133 | `D` | include | `tests/crown-update-download.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 134 | `D` | include | `tests/crown-update-health-endpoint.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 135 | `D` | include | `tests/crown-update-health.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 136 | `D` | include | `tests/crown-update-journal.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 137 | `D` | include | `tests/crown-update-manifest-builder.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 138 | `D` | include | `tests/crown-update-manifest.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 139 | `D` | include | `tests/crown-update-preflight.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 140 | `D` | include | `tests/crown-update-recovery.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 141 | `D` | include | `tests/crown-update-service.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 142 | `D` | include | `tests/crown-update-signature.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 143 | `M` | include | `tests/crown-windows-launcher.test.mjs` | 现有 v0.2.0 source/docs/tests/release 修改，纳入发布源基线。 |
| 144 | `D` | include | `tests/crown-windows-update-handoff.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 145 | `D` | include | `tests/crown-windows-update-runtime.test.mjs` | 现有 v0.2.0 基线中的已审删除，提交删除状态。 |
| 146 | `??` | include | `data/fixtures/crown/betting-protocol/artifacts/20260714-085221-accepted.safe.json` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 147 | `??` | include | `data/fixtures/crown/betting-protocol/artifacts/20260714-085221-watcher.safe.json` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 148 | `??` | include | `data/fixtures/crown/betting-protocol/prematch-full-time-asian-handicap-main.accepted.json` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 149 | `??` | include | `docs/superpowers/plans/2026-07-13-crown-demo-account-auto-betting.md` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 150 | `??` | include | `docs/superpowers/plans/2026-07-13-crown-manual-portable-and-desktop-shortcut.md` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 151 | `??` | superseded | `docs/superpowers/plans/2026-07-14-crown-betting-controlled-live-acceptance.md` | 由浏览器内 API 投注重构计划取代；添加统一 Superseded 声明后保留历史正文并显式提交。 |
| 152 | `??` | superseded | `docs/superpowers/plans/2026-07-14-crown-betting-production-readiness.md` | 由浏览器内 API 投注重构计划取代；添加统一 Superseded 声明后保留历史正文并显式提交。 |
| 153 | `??` | superseded | `docs/superpowers/plans/2026-07-14-crown-betting-reconciliation-and-capability-expansion.md` | 由浏览器内 API 投注重构计划取代；添加统一 Superseded 声明后保留历史正文并显式提交。 |
| 154 | `??` | superseded | `docs/superpowers/plans/2026-07-14-crown-betting-remaining-work-roadmap.md` | 由浏览器内 API 投注重构计划取代；添加统一 Superseded 声明后保留历史正文并显式提交。 |
| 155 | `??` | include | `docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 156 | `??` | superseded | `docs/superpowers/plans/2026-07-14-crown-full-validation-and-github-release.md` | 由浏览器内 API 投注重构计划取代；添加统一 Superseded 声明后保留历史正文并显式提交。 |
| 157 | `??` | include | `docs/superpowers/plans/2026-07-14-crown-runtime-account-readiness.md` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 158 | `??` | superseded | `docs/superpowers/specs/2026-07-14-crown-betting-remaining-work-design.md` | 旧三阶段投注设计已由浏览器内 API 投注重构计划取代；正文保持原样，作为历史文档显式提交。 |
| 159 | `??` | include | `packaging/windows/launcher/ensure-desktop-shortcut.ps1` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 160 | `??` | include | `packaging/windows/皇冠抓水投注.ico` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 161 | `??` | include | `src/crown/runtime/atomic-json-file.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 162 | `??` | include | `src/crown/runtime/safe-data-path.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 163 | `??` | include | `tests/crown-betting-protocol-execution-evidence.test.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 164 | `??` | include | `tests/crown-execution-identity.test.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 165 | `??` | include | `tests/crown-task10-auto-submit.test.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
| 166 | `??` | include | `tests/crown-windows-desktop-shortcut.test.mjs` | 现有 v0.2.0 新增 source/docs/tests/safe fixture，纳入发布源基线。 |
