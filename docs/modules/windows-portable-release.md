# Windows Portable Release 与桌面快捷启动

## 目标与边界

该模块为少量 Windows 10/11 x64 用户提供可直接解压运行的 Portable ZIP。程序内置 Node.js 和 Chromium，用户双击手工启动并保留可见窗口；不设置开机启动，不创建 Startup 项或 Windows Service，不写注册表启动项，也不依赖系统 Node/Chrome/Edge/Docker。

程序没有远程检查、下载或安装更新的运行链。维护者手工构建和发布完整 ZIP；用户换版时解压到新目录并手工启动。用户数据固定在 `%LOCALAPPDATA%\CrownMonitor`，与程序目录分离。Watcher 只能由 Dashboard 手工启动，启动和手工换版都不会自动恢复 Watcher 或投注 worker。

## 组成

| 组成 | 主要路径 | 职责 |
|---|---|---|
| Portable path contract | `src/crown/runtime/portable-paths.mjs`、`portable-instance.mjs` | 计算 package root、current version、APP_ROOT、data root 和运行时路径，拒绝工作目录依赖与路径逃逸 |
| Windows launcher | `packaging/windows/启动程序.cmd`、`packaging/windows/停止程序.cmd`、`packaging/windows/launcher/start.ps1`、`stop.ps1` | 可见启动/停止、单实例、精确进程身份、端口选择和退出清理 |
| 桌面快捷方式 | `packaging/windows/launcher/ensure-desktop-shortcut.ps1`、`packaging/windows/皇冠抓水投注.ico` | 成功启动后幂等创建或替换当前用户桌面的 `皇冠抓水投注.lnk`，校正 Target、WorkingDirectory、Icon 和可见窗口属性 |
| First-run seed | `src/crown/runtime/portable-instance.mjs`、`config/default-leagues.json` | 首次创建用户目录和空数据库，只在白名单目标不存在时复制 118 项 seed |
| Release builder/audit | `src/crown/release/`、`scripts/build-windows-portable.mjs`、`scripts/verify-release-artifacts.mjs`、`release/` | 干净 checkout、runtime lock、allowlist staging、`release-files.json` 和秘密/路径审计 |
| 人工登录 | `src/crown/login/`、`src/crown/app/crown-human-login-controller.mjs` | 只启动包内 Chromium；用户人工处理验证码/滑块/OTP；exact-origin session bridge 和只读复核 |
| CI contract | `.github/workflows/windows-release-build.yml` | pinned Actions、最小权限、全量验证和 unsigned allowlist build；不自动发布用户 Release |

## 启动与快捷方式契约

1. `启动程序.cmd` 把自身目录作为 package root，不使用调用者 cwd。
2. Launcher 验证 package/current/version/runtime 身份，再取得单实例所有权。
3. Dashboard 只绑定 loopback，端口占用时选择受控备用端口。
4. 新 Dashboard 必须通过完整 health identity 校验后才算成功启动；复用既有健康进程也必须通过同一身份边界。
5. 每次成功启动后调用快捷方式维护脚本。脚本只维护当前用户 Desktop 下一个固定名称 `皇冠抓水投注.lnk`：Target 为当前 package root 的 `启动程序.cmd`，WorkingDirectory 为当前 package root，Icon 为当前 package root 的 `皇冠抓水投注.ico`，窗口保持可见。
6. 快捷方式使用同目录临时文件后原子替换。重复启动不产生副本；包移动或手工换版后，从新目录成功启动一次即可校正旧指向。
7. 快捷方式失败只写稳定脱敏错误码，不记录完整用户路径或堆栈，也不能改变已成功的 Dashboard 启动结果。
8. 运行窗口是用户可见的生命周期边界；关闭窗口或 `Ctrl+C` 停止本安装实例。
9. 停止操作只接受 installation id、PID、process start time、instance nonce 和 probe 全部匹配的进程，不按进程名 kill。

Launcher 不自动启动 Watcher、betting worker，不写注册表启动项，不创建 Startup 项或 Windows Service。

## 数据和首次运行

程序目录保存 `current.json`、`versions/<version>`、包内 Node/Chromium、launcher、图标和 `release-files.json`。用户目录保存数据库、secret key、配置、session、Profile、日志、运行身份和业务备份。

首次运行使用原子创建：

- 空数据库和本机 installation id；
- 必要的 runtime/log 目录；
- 118 项默认联赛 seed。

白名单只在目标文件不存在时 seed，重启和手工换版都不能覆盖用户修改。账号、密码、session、SQLite、Profile、日志和 Telegram 配置永远不进入发行物。

非 Portable 开发运行也遵循相同的代码/数据分离原则：设置 `CROWN_APP_DIR` 与 `CROWN_DATA_ROOT` 后，未单独覆盖的 `config`、SQLite、local secret、runtime 和日志路径均从 data root 派生，`frontend/dist` 与源码仍从 APP_DIR 读取。这样换代码目录不会让现有 `config/telegram-settings.json` 消失，也不会复制或改写 Telegram token。显式单项路径继续优先；Portable canonical path graph 不受影响。

## 手工换版契约

维护者使用锁定 runtime、production allowlist 和 release audit 重新构建完整 ZIP。用户升级时：

1. 把新 ZIP 解压到一个新的普通目录，不覆盖正在运行的旧目录。
2. 停止旧程序，从新目录运行 `启动程序.cmd`。
3. 新版本继续读取 `%LOCALAPPDATA%\CrownMonitor` 中的现有数据；成功启动后桌面快捷方式自动指向新目录。
4. 确认 Dashboard、账号、白名单和 session 正常后，再人工删除旧程序目录。
5. 新版本不能使用时，停止它并从保留的旧目录重新启动；不要删除、替换或复制他人的用户数据目录。

该流程没有在线 updater、差分包、candidate、handoff 或自动回滚。`current.json` 与 `versions/<version>` 仅用于当前完整 Portable 包内的稳定 launcher 定位，用户不应手工改写。

## 人工登录契约

- 账号网址必须经过统一 exact public HTTPS origin 校验：无 path/query/hash/URL credentials，不接受 HTTP、localhost、单标签主机、private hostname 或 IP literal。
- 只执行包内 Chromium executable，不回退到系统浏览器。
- 每个账号使用用户 data root 下独立 Profile；手工换版不覆盖。
- 验证码、滑块和 OTP 全部由用户本人完成，不自动识别或绕过。
- session bridge 不导出完整 storage state，不读取 localStorage/sessionStorage；只接受 exact-origin 必要 cookie/ticket，并在只读 `get_game_list` 成功后原子保存 owner-bound API session。
- 人工登录成功与 Watcher start 是两个独立动作。

## 与自动投注的边界

- 每个投注账号的 `perBetLimit` 由用户在账号配置中手工设置和修改，启用时必须是大于 0 的整数 CNY。
- fixture、测试或示例中的 `50 CNY` 只是测试配置，不是生产默认值、统一硬上限或自动填充值。
- 账号分配仍同时受 provider min/max/step、余额、币种、amount scale 和全局执行门禁限制；启用账号不会自动开启全局真实投注。

## 强绑定关系

- `portable-paths`、launcher、`current.json`、installation identity 和 runtime lock 必须一起验证。
- launcher 成功健康检查、快捷方式脚本、根目录 `启动程序.cmd` 和 `.ico` 必须一起验证；快捷方式错误必须保持非致命。
- 人工登录 controller、origin validator、Chromium launcher、session bridge、API login manager 和账号 API/UI 必须一起验证。
- Release allowlist、runtime lock、builder、`release-files.json`、audit、workflow 和发布手册必须保持一致；增加生产文件必须显式更新 allowlist 与测试。
- 用户 data root 与 APP_ROOT 的分离必须覆盖首次运行、重复启动、程序移动和手工换版。

Portable 发布模块可独立开发和验证，但不能绕过 Dashboard、账号或投注模块本身的安全门禁。

## 验证入口

```powershell
node --test --test-concurrency=1 tests/crown-portable-paths.test.mjs tests/crown-portable-instance.test.mjs tests/crown-portable-runtime.test.mjs
node --test --test-concurrency=1 tests/crown-windows-launcher.test.mjs tests/crown-windows-desktop-shortcut.test.mjs
node --test --test-concurrency=1 tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-release-workflow.test.mjs
node --test --test-concurrency=1 tests/crown-origin.test.mjs tests/crown-portable-chromium.test.mjs tests/crown-manual-login-bridge.test.mjs tests/crown-api-login-manager.test.mjs
```

正式发布还必须执行全量 backend/frontend 测试、syntax/build、实际发行物审计、仓库外 cwd smoke 和 Fresh Windows 矩阵。单元测试通过不等于 ZIP 可供下载。

全量 backend 测试必须串行执行。Launcher fault-injection 用例会启动真实 PowerShell/Node 子进程；提高 Node test 文件级并发会使端口、子进程退出和恢复状态相互干扰，形成非确定性失败。项目根目录的 `npm test` 已固定为 `--test-concurrency=1`。

Windows runner 可能通过 8.3 短路径表示 `%TEMP%` 或 `%LOCALAPPDATA%`。安全路径校验以 `dev/ino` 文件 identity 确认 canonical path 与输入路径指向同一对象，不按路径字符串相等判断；symlink/junction 仍在逐段 `lstat` 阶段拒绝。正在被业务 Promise 等待的 timeout 保持 ref，只有后台轮询 timer 可以 `unref`，否则 Node 22 会在 timeout 完成前结束事件循环。

Watcher 的运行时配置热重载使用文件内容 SHA-256 作为 revision，不依赖 Windows 文件时间戳。即使 runner 或目标机器在同一 `mtime` 粒度内覆盖配置，也会重新读取；无效 JSON 仍保留 last-known-good 并持续重试。

## 发布状态

公开仓库可以保存受审源码和开发分支。Actions workflow 只产生 unsigned 审计 artifact。只有最终 Portable ZIP 审计、仓库外启动和 Fresh Windows 10/11 x64 证据全部完成后，才能创建面向用户的 Private Beta Release。

用户说明见 `docs/windows-private-beta-quick-start.md`；维护者流程见 `docs/github-release-runbook.md`；当前设计与计划见 `docs/superpowers/specs/2026-07-13-crown-manual-portable-and-desktop-shortcut-design.md` 和 `docs/superpowers/plans/2026-07-13-crown-manual-portable-and-desktop-shortcut.md`。
