# Windows Portable Release 与手动更新

## 目标与边界

该模块为少量 Windows 10/11 x64 用户提供可直接解压运行的 Portable ZIP。程序内置 Node.js 和 Chromium，双击手动启动并保留可见窗口；不安装 Service、不设开机启动、不依赖系统 Node/Chrome/Edge/Docker。

用户数据固定在 `%LOCALAPPDATA%\CrownMonitor`，与只读版本目录分离。Watcher 只能由 Dashboard 手动启动，启动、更新和回滚都不会自动恢复 Watcher 或投注 worker。真实投注 capability 始终为 preview/submit/reconciliation `0/0/0`。

## 组成

| 组成 | 主要路径 | 职责 |
|---|---|---|
| Portable path contract | `src/crown/runtime/portable-paths.mjs`、`portable-instance.mjs` | 计算 package root、current version、APP_ROOT、data root 和运行时路径，拒绝工作目录依赖与路径逃逸 |
| Windows launcher | `packaging/windows/启动程序.cmd`、`packaging/windows/停止程序.cmd`、`packaging/windows/launcher/` | 可见启动/停止、单实例、精确进程身份、端口选择、恢复优先和退出清理 |
| First-run seed | `src/crown/runtime/portable-instance.mjs`、`config/default-leagues.json` | 首次创建用户目录和空数据库，只在白名单目标不存在时复制 118 项 seed |
| Release builder/audit | `src/crown/release/`、`scripts/build-windows-portable.mjs`、`scripts/verify-release-artifacts.mjs`、`release/` | 干净 checkout、runtime lock、allowlist staging、文件 manifest 和秘密/路径审计 |
| 人工登录 | `src/crown/login/`、`src/crown/app/crown-human-login-controller.mjs` | 只启动包内 Chromium；用户人工处理验证码/滑块/OTP；exact-origin session bridge 和只读复核 |
| Update trust/download | `src/crown/update/update-manifest.mjs`、`update-signature.mjs`、`github-release-client.mjs`、`download-asset.mjs`、`safe-extract.mjs`、`scripts/create-update-manifest.mjs` | GitHub HTTPS Release、Ed25519、SHA-256、严格 schema、最终 ZIP manifest 生成、受限下载和安全 ZIP staging |
| Update transaction | `src/crown/update/update-service.mjs`、`update-applier.mjs`、`windows-update-*.mjs`、`scripts/crown-update-apply.mjs` | 手动 check/install/cancel、preflight、SQLite 备份、候选健康检查、原子切换、journal rollback/recovery |
| Dashboard UI/API | `frontend/src/pages/SystemUpdate.tsx`、`src/crown/app/app-api.mjs` | 显示当前/可用版本、进度、错误与回滚原因；只允许用户手动确认安装 |
| CI contract | `.github/workflows/windows-release-build.yml` | pinned Actions、最小权限、全量验证、unsigned allowlist build；不读取私钥、不自动发布 Release |

## 启动契约

1. `启动程序.cmd` 把自身目录作为 package root，不使用调用者 cwd。
2. Launcher 先验证 package/current/version/runtime 身份，再取得单实例所有权。
3. 若存在未完成 update journal，先执行确定性恢复；恢复完成后才启动 current version。
4. Dashboard 只绑定 loopback，端口占用时选择受控备用端口。
5. 运行窗口是用户可见的生命周期边界；关闭窗口或 `Ctrl+C` 停止本安装实例。
6. 停止操作只接受 installation id、PID、process start time、instance nonce 和 probe 全部匹配的进程，不按进程名 kill。

Launcher 不自动启动 Watcher、betting worker 或更新检查。

## 数据和首次运行

程序目录保存不可变版本、包内 Node/Chromium、launcher 和 release file manifest。用户目录保存数据库、secret key、session、Profile、日志、运行身份、update journal、备份和 staging。

首次运行使用原子创建：

- 空数据库和本机 installation id；
- 必要的 runtime/log/update 目录；
- 118 项默认联赛 seed。

白名单只在目标文件不存在时 seed，更新、重启和回滚都不能覆盖用户修改。账号、密码、session、SQLite、Profile、日志和 Telegram 配置永远不进入发行物。

## 人工登录契约

- 账号网址必须经过统一 exact public HTTPS origin 校验：无 path/query/hash/URL credentials，不接受 HTTP、localhost、单标签主机、private hostname 或 IP literal。
- 只执行包内 Chromium executable，不回退到系统浏览器。
- 每个账号使用用户 data root 下独立 Profile；版本更新不覆盖。
- 验证码、滑块和 OTP 全部由用户本人完成，不自动识别或绕过。
- session bridge 不导出完整 storage state，不读取 localStorage/sessionStorage；只接受 exact-origin 必要 cookie/ticket，并在只读 `get_game_list` 成功后原子保存 owner-bound API session。
- 人工登录成功与 Watcher start 是两个独立动作。

## 更新信任链与事务

```text
用户手动检查
  → GitHub Release HTTPS metadata
  → canonical manifest + 64-byte Ed25519 signature
  → ZIP size/SHA-256
  → Windows-safe file manifest 与安全解压
  → preflight + SQLite 一致性备份
  → 停止精确匹配的旧进程
  → 启动候选并完成授权健康检查
  → 原子切换 current.json
  → commit；失败则恢复 DB 并 rollback
```

manifest 严格绑定 app/channel/package/version/min updater/release tag/signing key/asset/files，额外字段、未知 key、降级、同版本重装、非规范 JSON、篡改 bytes 或不匹配的 Release tag 全部 fail-closed。

更新只允许 Dashboard 手动触发。下载阶段可以取消；进入 apply/rollback 后不能取消。持久 journal 在每个破坏性步骤前写入并 flush，强制终止后由下次 launcher 启动恢复到唯一确定的 committed candidate 或 rolled-back previous version。成功和失败都保持 Watcher/worker off。

## 强绑定关系

- `portable-paths`、launcher、`current.json`、installation identity 和 runtime lock 必须一起验证。
- 人工登录 controller、origin validator、Chromium launcher、session bridge、API login manager 和账号 API/UI 必须一起验证。
- manifest/signature、GitHub client、download、safe extract、preflight、backup、journal、health、applier、Windows handoff 和 launcher recovery 必须端到端验证。
- Update health 与真实投注 runtime/capability 强绑定；candidate 只有在 requested=false、runtime off、Watcher/worker stopped、capability `0/0/0` 时才健康。
- Release allowlist、runtime lock、builder、audit、workflow 和发布手册必须保持一致；增加生产文件必须显式更新 allowlist 与测试。

## 验证入口

```powershell
node --test tests/crown-portable-paths.test.mjs tests/crown-portable-instance.test.mjs tests/crown-portable-runtime.test.mjs
node --test tests/crown-windows-launcher.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs
node --test tests/crown-origin.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-manual-login-bridge.test.mjs tests/crown-api-login-manager.test.mjs
node --test tests/crown-update-manifest.test.mjs tests/crown-update-manifest-builder.test.mjs tests/crown-update-signature.test.mjs tests/crown-github-release-client.test.mjs tests/crown-update-download.test.mjs tests/crown-safe-extract.test.mjs
node --test tests/crown-sqlite-backup.test.mjs tests/crown-update-journal.test.mjs tests/crown-update-preflight.test.mjs tests/crown-update-health.test.mjs
node --test tests/crown-update-service.test.mjs tests/crown-update-api.test.mjs tests/crown-update-applier.test.mjs tests/crown-update-recovery.test.mjs tests/crown-windows-update-handoff.test.mjs tests/crown-windows-update-runtime.test.mjs
npm --prefix frontend test -- --run src/pages/SystemUpdate.test.tsx src/App.contract.test.tsx src/components/AppLayout.mobile.test.tsx src/services/api.security.test.ts
node --test tests/crown-release-workflow.test.mjs
```

正式发布还必须执行全量 backend/frontend 测试、syntax/build、实际发行物审计、仓库外 cwd smoke 和 Fresh Windows 矩阵。单元测试通过不等于 ZIP 可供下载。

全量 backend 测试必须串行执行。Launcher fault-injection 用例会启动真实 PowerShell/Node 子进程；提高 Node test 文件级并发会使端口、子进程退出和恢复状态相互干扰，形成非确定性失败。项目根目录的 `npm test` 已固定为 `--test-concurrency=1`。

Windows runner 可能通过 8.3 短路径表示 `%TEMP%` 或 `%LOCALAPPDATA%`。安全路径校验以 `dev/ino` 文件 identity 确认 canonical path 与输入路径指向同一对象，不按路径字符串相等判断；symlink/junction 仍在逐段 `lstat` 阶段拒绝。正在被业务 Promise 等待的 timeout 保持 ref，只有后台轮询 timer 可以 `unref`，否则 Node 22 会在 timeout 完成前结束事件循环。

Watcher 的运行时配置热重载使用文件内容 SHA-256 作为 revision，不依赖 Windows 文件时间戳。即使 runner 或目标机器在同一 `mtime` 粒度内覆盖配置，也会重新读取；无效 JSON 仍保留 last-known-good 并持续重试。

## 发布状态

公开仓库可以保存受审源码和开发分支。Actions workflow 只产生 unsigned 审计 artifact。只有离线私钥签名、最终资产复验和 Fresh Windows 证据全部完成后，才能创建面向用户的 Private Beta Release。

用户说明见 `docs/windows-private-beta-quick-start.md`；维护者流程见 `docs/github-release-runbook.md`。
