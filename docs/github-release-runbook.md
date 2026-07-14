# GitHub Windows Private Beta 手工发布手册

## 发布边界

公开源码仓库固定为 [Austin-C1/hg-](https://github.com/Austin-C1/hg-)。Windows 10/11 x64 用户拿到的是维护者手工构建、审计、验收和上传的 Portable ZIP。

当前发布方式不包含程序内检查、下载或安装更新，也不生成 updater manifest、signature、candidate 或自动回滚资产。用户换版时下载新的完整 ZIP、解压到新目录并手工启动；`%LOCALAPPDATA%\CrownMonitor` 中的用户数据继续复用。

GitHub Actions 只构建并短期保存 `unsigned` 审计 artifact。它不自动创建 Release，也不能直接当作用户下载包。用户可用 Release 必须同时满足：

- 从干净 checkout 构建；
- backend/frontend 测试、syntax 和 production build 通过；
- production allowlist staging、`release-files.json` 和发行物审计通过；
- Windows 10/11 x64 Fresh Windows 验收通过；
- 最终 ZIP 的 byte size 和 SHA-256 已记录并复核；
- 包内不含账号、session、SQLite、日志、私钥或其他本机数据。

当前生产 capability 必须保持 exact row `prematch/full_time/asian_handicap/main` 的 Preview/Submit/Reconciliation `1/1/0`；其他 row 与 Reconciliation 保持关闭。发布流程不得通过环境变量、配置或替换文件改变该矩阵，真实 runtime 默认 off。

## 1. 准备发布分支

1. 从预定发布 commit 建立干净 checkout，确认 origin 为 `https://github.com/Austin-C1/hg-.git`，仓库可见性为 public。
2. 版本号在 `package.json`、`package-lock.json` 和 tag 中完全一致；tag 必须为 `v<version>`。
3. `git status --porcelain=v1 --untracked-files=all` 必须为空。
4. 确认不存在真实账号、密码、cookie、token、session、SQLite、浏览器 Profile、Telegram 配置、日志、截图、私钥或旧废弃程序。
5. 确认发行 allowlist 包含桌面快捷方式脚本与 `皇冠抓水投注.ico`，且不包含任何远程 updater 入口或依赖。

发现任何秘密或用户数据时，应先轮换相关凭据，再从候选提交和 Git 历史中清除；不能仅靠 `.gitignore` 掩盖已跟踪文件。

## 2. 全量验证

在干净 checkout 中执行：

```powershell
npm ci
npm --prefix frontend ci
npm test
npm run check
npm --prefix frontend test
npm --prefix frontend run build
node --test --test-concurrency=1 tests/crown-release-workflow.test.mjs tests/crown-portable-release-builder.test.mjs tests/crown-release-audit.test.mjs tests/crown-windows-launcher.test.mjs tests/crown-windows-desktop-shortcut.test.mjs
```

所有命令必须成功，且构建后 `git status` 仍为空。任何失败都阻断发布，不能用跳过测试、修改 lockfile 或手工复制旧 `dist` 的方式继续。

文档、fixture 或测试中出现的账号 `perBetLimit=50 CNY` 只代表测试配置。发布验收必须确认每个账户的 `perBetLimit` 可由用户手工修改，且程序没有把 50 写成生产默认值或统一硬上限。

## 3. 构建和审计 Portable

Node 与 Chromium 必须使用 `release/windows-runtime-lock.json` 记录的版本、archive SHA-256 和完整 runtime tree digest。将已校验的 runtime 目录显式传入，不依赖发布电脑已安装的软件：

```powershell
$env:CROWN_NODE_RUNTIME_DIR = '<已校验的 Node Windows x64 runtime 目录>'
$env:CROWN_CHROMIUM_RUNTIME_DIR = '<已校验的 Chromium Windows x64 runtime 目录>'
$env:CROWN_RELEASE_OUT = Join-Path $env:TEMP 'crown-release-audit'

npm run release:portable -- --version '<version>' --node-runtime $env:CROWN_NODE_RUNTIME_DIR --chromium-runtime $env:CROWN_CHROMIUM_RUNTIME_DIR --out $env:CROWN_RELEASE_OUT
npm run release:audit -- --root $env:CROWN_RELEASE_OUT
```

构建器要求输出目录在仓库外、目标为空，并且正式模式下 checkout 干净。审计结果必须同时满足：

- allowlist 文件完整，额外文件为 0；
- forbidden path/content、秘密、用户数据和本机绝对路径命中为 0；
- `release-files.json` 与实际文件大小、SHA-256 完全一致；
- 默认联赛 seed 为 118 项；
- bundled Node、Chromium 与 runtime lock 一致；
- 根目录包含 `启动程序.cmd`、`停止程序.cmd`、`皇冠抓水投注.ico` 和 `launcher/ensure-desktop-shortcut.ps1`；
- `current.json`、`versions/<version>` 与 launcher 的自相对路径契约一致；
- Watcher/worker 默认停止；exact row capability 为 `1/1/0`，其他 row 与 Reconciliation 关闭；
- 远程更新页面、API、下载器、签名、候选切换和恢复入口均不存在。

把输出目录内容压缩为最终 ZIP 后，再解压到另一个空目录并重新执行 `release:audit`。ZIP 顶层必须直接是 Portable 根文件，不能多包一层临时父目录。最终 ZIP 的 SHA-256 和 byte size 以实际上传文件为准。

## 4. 仓库外与 Fresh Windows 验收

先在发布电脑的仓库外目录执行 smoke，再在没有系统 Node/Chrome/Edge/Docker 的 Windows 10 或 Windows 11 x64 Sandbox/VM 中重复。

| 项目 | 合格结果 |
|---|---|
| ZIP 解压 | 中文、空格和非系统盘路径可运行；不能从压缩软件预览窗口运行 |
| 启动 | 双击 `启动程序.cmd`；窗口可见并保持；关闭窗口后程序停止 |
| 依赖 | 只使用包内 Node 和 Chromium；无需管理员权限、系统浏览器或系统 Node |
| 开机边界 | 不写注册表启动项，不创建 Startup 项，不安装或启动 Windows Service |
| Dashboard | 仅 loopback；首页和 `/api/health` 正常；端口冲突可安全选择备用端口 |
| 首次运行 | 创建空数据库；Watcher/worker off；exact row capability `1/1/0`，其他 row 与 Reconciliation 关闭 |
| 桌面快捷方式 | 首次成功启动后仅有一个 `皇冠抓水投注.lnk`；Target、WorkingDirectory、Icon 指向当前 Portable 根目录 |
| 快捷方式修复 | 重复启动不产生副本；把包移动到新目录并成功启动后，原快捷方式被原子校正到新目录 |
| 快捷方式失败 | 创建或替换失败只写稳定脱敏错误码，不影响 Dashboard 成功启动 |
| 登录 | exact public HTTPS；内置 Chromium；验证码/滑块/OTP 全部人工处理；成功后 Watcher 仍 off |
| 白名单 | 首次 seed 恰好 118 项；用户修改后重启或手工换版不覆盖 |
| 用户数据 | SQLite、账号、session、Profile、日志只在 `%LOCALAPPDATA%\CrownMonitor`；包内没有用户数据 |
| 手工换版 | 新 ZIP 解压到新目录后复用原用户数据；新目录成功启动会校正快捷方式；旧目录由用户确认后人工删除 |
| 停止边界 | 只停止 installation id、PID、start time 和 probe 全部匹配的进程，不按进程名结束其他 Node |

验收记录只能保存版本、Windows 版本、测试矩阵结果、最终 ZIP SHA-256/size 和脱敏错误码，不保存账号、cookie、token、session、用户路径、SQLite 或截图中的敏感信息。

没有 Fresh Windows 证据时，只能推送源码和开发分支；不得创建“可用”“推荐下载”或同等含义的 Release，也不得把 Actions artifact 发给用户。

## 5. 生成最终 ZIP

1. 确认 Portable 输出目录已经通过 `release:audit`，且没有运行中的 Dashboard/Watcher/worker 从该目录写文件。
2. 将输出目录内容压缩为一个新的 `CrownMonitor-<version>-windows-x64-portable.zip`。
3. 把 ZIP 解压到新空目录，重新运行 `release:audit` 和 Fresh Windows smoke。
4. 计算并保存最终资产的 SHA-256 和 byte size：

```powershell
Get-FileHash -Algorithm SHA256 '<最终 ZIP>'
(Get-Item -LiteralPath '<最终 ZIP>').Length
```

重新压缩或替换 ZIP 后，旧 hash、size 和验收记录立即失效，必须重新审计和验证。不要把源码 ZIP、Actions artifact 或开发目录压缩包改名冒充 Portable。

## 6. 创建 GitHub Release

1. 推送已审计 commit 和 `v<version>` tag。
2. 等待 pinned GitHub Actions workflow 全部通过；workflow 只提供二次构建证据。
3. 手工创建 Private Beta Release。Release notes 写明 Windows x64、Fresh Windows 验收结果、已知限制、手工换版步骤和最终 ZIP SHA-256。
4. 只上传最终 Portable ZIP；不要上传 updater manifest、signature、差分包或候选包。
5. 从 GitHub Release 实际下载 ZIP，重新核对 byte size/SHA-256，解压后重跑 `release:audit`。
6. 在另一台 Fresh Windows 环境按用户真实下载路径完成最后一次启动、快捷方式和用户数据复用 smoke。

只有以上步骤全部通过，才能把 Release 标记为可供少量用户下载。发布后不得替换同一 tag 下的资产；需要修复时增加版本并重新走完整流程。

## 7. 发布后检查与撤回

- 通过 GitHub 文件列表再次确认公开仓库禁止内容命中为 0。
- 确认下载说明只引导用户手工取得完整 Portable ZIP，不出现程序内更新入口。
- 确认首次成功启动会创建或修复桌面快捷方式，且 Watcher/worker 仍为 off。
- 若发现 ZIP、runtime lock、allowlist、数据隔离或快捷方式问题，立即把 Release 标记为不可用并移除用户下载指引；不要静默替换资产。
- 用户现有安装与 `%LOCALAPPDATA%\CrownMonitor` 数据不依赖 GitHub 在线状态；GitHub 不可用不应影响已经解压的版本继续启动。
