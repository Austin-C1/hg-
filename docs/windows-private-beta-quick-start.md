# Windows Portable Private Beta 快速开始

## 下载前确认

本版本只面向少量 Windows 10/11 x64 用户。请从 [Austin-C1/hg- Releases](https://github.com/Austin-C1/hg-/releases) 下载明确标记为“已完成 Fresh Windows 验收”、并带有匹配签名 manifest 的 ZIP。

不要使用以下文件：

- GitHub Actions 页面中的 `unsigned` artifact；它只用于维护者审计。
- 来源不明、被重新打包或没有对应签名 manifest 的 ZIP。
- 仅有源码、但 Release 说明没有声明 Fresh Windows 验收通过的版本。

程序内置 Node.js 与 Chromium，不需要安装系统 Node、Chrome、Edge、Docker，也不需要管理员权限。

## 启动

1. 将 ZIP 完整解压到普通文件夹。路径可以包含中文或空格，但不要直接在压缩软件窗口里运行。
2. 双击 `启动程序.cmd`。
3. 保留弹出的运行窗口。关闭窗口或按 `Ctrl+C` 会停止 Dashboard；也可以双击 `停止程序.cmd`。
4. 浏览器通常会自动打开本机 Dashboard。若没有自动打开，请使用运行窗口显示的 `127.0.0.1` 地址。

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

账号验证成功后，在 Dashboard 中手动启动 Watcher。每次启动程序、完成更新或发生回滚后，都需要用户再次手动启动。

以下行为不会自动发生：

- 开机启动；
- Windows Service 后台运行；
- 启动程序后自动监控；
- 更新后自动恢复 Watcher；
- 监控信号触发真实投注。

## 默认白名单与用户数据

下载包内含 118 项默认联赛白名单。它只在本机目标文件不存在的首次运行时 seed 到用户数据目录；以后更新不会覆盖用户增删的白名单。

所有用户数据统一保存在：

```text
%LOCALAPPDATA%\CrownMonitor
```

其中可能包括 SQLite、账号密文、session、浏览器 Profile、日志、运行状态和更新 journal。不要把该目录上传到 GitHub、网盘公共链接或发送给其他用户。解压目录可以替换为新版本，但不能用其他人的用户数据目录覆盖本机目录。

## 手动更新与回滚

1. 在 Dashboard 打开“系统更新”。
2. 手动点击“检查更新”。程序不会在启动时自动检查。
3. 核对目标版本和 Release 说明后，手动确认安装。
4. 更新会停止 Dashboard；可见更新窗口会完成签名、SHA-256、文件清单、磁盘空间、SQLite 备份和安全状态检查。
5. 候选版本健康检查通过后才会切换。失败时会停止候选版本、恢复 SQLite 备份并回滚到旧版本。

更新或回滚完成后 Watcher 和投注 worker 都保持停止。不要在更新窗口运行时强制删除解压目录或 `%LOCALAPPDATA%\CrownMonitor`。若电脑意外断电，下次双击启动时会先按持久 journal 完成恢复，再正常启动当前有效版本。

## 停止与故障排查

- 正常停止：在运行窗口按 `Ctrl+C`，或双击 `停止程序.cmd`。
- 启动失败：确认 ZIP 已完整解压，文件未被安全软件隔离，且没有另一个相同安装实例正在启动。
- 页面没有打开：查看运行窗口显示的本机地址；默认端口冲突时程序会选择受控备用端口。
- 登录失败：确认网址为 exact public HTTPS origin，并重新由本人完成 Crown 验证。
- 更新失败：保留运行窗口显示的错误，重新启动程序让 journal 自动恢复；不要手工替换 `current.json`、版本目录或 SQLite 文件。

Launcher 日志位于：

```text
%LOCALAPPDATA%\CrownMonitor\logs\launcher.log
```

日志可能包含本机运行诊断，发送给维护者前应检查并脱敏。

## 安全边界

当前真实投注 capability 固定为 preview/submit/reconciliation `0/0/0`。该版本可以配置监控和人工登录，但不能进行真实投注、真实预览或自动对账，不会发送 `FT_bet`。

任何要求关闭签名校验、复制他人 session、上传用户数据目录、绕过验证码或手工开启真实投注 capability 的说明，都不属于本项目的受支持使用方式。
