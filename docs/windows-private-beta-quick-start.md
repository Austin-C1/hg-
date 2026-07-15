# Windows Portable Private Beta 快速开始

## 下载前确认

本版本只面向少量 Windows 10/11 x64 用户。请从 [Austin-C1/hg- Releases](https://github.com/Austin-C1/hg-/releases) 下载明确标记为“已完成 Fresh Windows 验收”的手工 Portable ZIP。

不要使用以下文件：

- GitHub Actions 页面中的 `unsigned` artifact；它只用于维护者审计。
- 来源不明或被重新打包的 ZIP。
- 仅有源码、但 Release 说明没有声明 Fresh Windows 验收通过的版本。

程序内置 Node.js 与 Chromium，不需要安装系统 Node、Chrome、Edge、Docker，也不需要管理员权限。

## 启动

1. 将 ZIP 完整解压到普通文件夹。路径可以包含中文或空格，但不要直接在压缩软件窗口里运行。
2. 双击 `启动程序.cmd`。
3. 保留弹出的运行窗口。关闭窗口或按 `Ctrl+C` 会停止 Dashboard；也可以双击 `停止程序.cmd`。
4. 浏览器通常会自动打开本机 Dashboard。若没有自动打开，请使用运行窗口显示的 `127.0.0.1` 地址。
5. 首次成功启动后，当前用户桌面会出现 `皇冠抓水投注.lnk`。以后每次成功启动都会幂等校正快捷方式的目标、工作目录和图标；程序移动或换到新目录后，从新目录运行一次 `启动程序.cmd` 即可修复指向。快捷方式创建失败不会阻止 Dashboard 启动。

程序只监听本机 loopback，不会把 Dashboard 开放到局域网或公网。启动时不会自动运行 Watcher，也不会自动运行投注 worker。

## 首次配置皇冠账号

1. 打开 Dashboard 的“皇冠监控账号”。
2. 填写自己当前可访问的皇冠网址、账号和密码。
3. 网址必须是 exact public HTTPS origin，例如 `https://example.com` 这种结构；不能使用 HTTP、IP 地址、localhost，也不能带路径、查询参数、锚点或 URL 内账号密码。
4. 保存后点击人工登录，程序会打开下载包内置的 Chromium。
5. 在 Chromium 中由本人完成验证码、滑块、OTP 或其他 Crown 验证。
6. 完成后回到 Dashboard 确认。程序只接收该 exact origin 的必要 session，并以只读 `get_game_list` 复核登录结果。

人工登录不会绕过验证码或风控，不会导入其他网站的 cookie，也不会在成功后自动启动 Watcher。登录失败时，原有已验证 session 不会被不完整结果覆盖。

## 启动 Watcher

账号验证成功后，在 Dashboard 中手动启动 Watcher。每次启动程序或手工换用另一个 Portable 目录后，都需要用户再次手动启动。

以下行为不会自动发生：

- 开机启动；
- Windows Service 后台运行；
- 启动程序后自动监控；
- 手工换版后自动恢复 Watcher；
- 监控信号触发真实投注。

## 默认白名单与用户数据

下载包内含 118 项默认联赛白名单。它只在本机目标文件不存在的首次运行时 seed 到用户数据目录；以后手工换用新版 ZIP 不会覆盖用户增删的白名单。

所有用户数据统一保存在：

```text
%LOCALAPPDATA%\CrownMonitor
```

其中可能包括 SQLite、账号密文、session、浏览器 Profile、日志和运行状态。不要把该目录上传到 GitHub、网盘公共链接或发送给其他用户。解压目录可以替换为新版本，但不能用其他人的用户数据目录覆盖本机目录。

## 自动投注账号的单笔上限

- 每个投注账号都有独立的 `perBetLimit`，可在“投注账号配置”中手工设置和修改。
- 账号启用要求 `perBetLimit` 是大于 0 的整数 CNY；程序不会替用户猜测或自动补值。
- 测试、fixture 或示例中出现的 `50 CNY` 只是测试配置，不是生产默认值、统一硬上限或自动填充值。实际提交还必须同时满足 Crown 返回的 min/max/step、余额和其他安全门禁。
- 启用某个投注账号只表示它可以加入订单分配，不会自动打开全局真实投注。

## 手工更换 Portable 版本

程序不包含远程检查、下载、安装或自动回滚功能。需要升级时：

1. 从维护者提供的受审 Release 下载新的 Portable ZIP。
2. 把新 ZIP 完整解压到一个新目录，不要覆盖正在运行的旧目录。
3. 停止旧程序，再从新目录双击 `启动程序.cmd`。
4. 新版本成功启动后会继续使用 `%LOCALAPPDATA%\CrownMonitor` 中的现有用户数据，并把桌面快捷方式校正到新目录。
5. 确认 Dashboard、账号、白名单和 session 正常后，再人工删除旧程序目录。若新版本不能使用，停止它并从旧目录重新启动；不要删除或替换用户数据目录。

手工换版后 Watcher 和投注 worker 都保持停止，需要用户重新确认并手动启动。

## 停止与故障排查

- 正常停止：在运行窗口按 `Ctrl+C`，或双击 `停止程序.cmd`。
- 启动失败：确认 ZIP 已完整解压，文件未被安全软件隔离，且没有另一个相同安装实例正在启动。
- 页面没有打开：查看运行窗口显示的本机地址；默认端口冲突时程序会选择受控备用端口。
- 登录失败：确认网址为 exact public HTTPS origin，并重新由本人完成 Crown 验证。
- 桌面快捷方式没有创建或指向旧目录：从当前正确的 Portable 目录重新运行一次 `启动程序.cmd`；启动成功后会再次校正。仍失败时可继续直接使用目录内启动脚本，并把 `launcher.log` 的脱敏错误码交给维护者。
- 新版本启动失败：停止新版本并从保留的旧目录重新启动；不要手工替换 `current.json`、版本目录或 SQLite 文件。

Launcher 日志位于：

```text
%LOCALAPPDATA%\CrownMonitor\logs\launcher.log
```

日志可能包含本机运行诊断，发送给维护者前应检查并脱敏。

## 安全边界

当前 Preview/Submit/Reconciliation capability 固定为 `8/4/0`：八个全场 main 方向可 Preview，赛前全场 main 的让球 home/away、大小球 over/under 可 Submit；滚球 Submit 与 Reconciliation 关闭。该版本可以配置监控和人工登录，但真实 runtime 默认 off，登录或启动本身不会发送 `FT_bet`；只有规则卡、账号、fresh Preview、lease/fence 和单次 Submit 等全部门禁通过后，已开放方向才可执行。

任何要求复制他人 session、上传用户数据目录、绕过验证码或手工开启真实投注 capability 的说明，都不属于本项目的受支持使用方式。
