# 皇冠 Windows Portable 与远程更新设计

## 目标

为少量 Windows 用户提供可直接下载、解压、双击运行的 Private Beta（监控预览版），并支持从公开 GitHub Releases 手动检查和安装更新。

发行版必须满足：

- 不要求用户安装 Node.js、Chrome、Edge、Docker 或数据库。
- 不依赖当前开发电脑的用户名、绝对路径、工作目录、代理、端口占用、浏览器 Profile 或环境变量。
- 用户账号、密码、SQLite、密钥、session、日志和浏览器 Profile 永不进入 GitHub 发行包。
- 默认只监听本机 loopback，不开放局域网或公网访问。
- 启动程序只打开 Dashboard，Watcher 必须由用户在页面中手动启动。
- 当前真实投注能力继续保持 preview/submit/reconciliation `0/0/0`，不得因打包或更新而放宽。
- 更新失败可以自动恢复旧程序和更新前数据，不能留下半更新状态。

## 非目标

首版不提供：

- Windows 安装器、Windows Service、开机启动、托盘图标或静默后台运行。
- 自动下载、自动安装、强制升级或自动启动 Watcher。
- Dashboard 公网访问、集中账号托管、云端同步或遥测。
- 私有 GitHub token 分发、用户授权系统或商业许可证系统。
- 代码签名证书和自动更新服务端。发行包完整性由应用级 Ed25519 签名保证；Windows 代码签名可在公开发行前另行加入。
- 真实 Crown Preview、Submit 或 Reconciliation 能力开放。

## 已确认决策

- 用户范围：少量 Windows 用户。
- 主发行形态：Windows x64 Portable ZIP。
- 启动方式：用户手动双击，保留可见运行窗口；关闭窗口即停止程序。
- Watcher：只能在 Dashboard 中手动启动，程序启动、重启和更新完成后都保持停止。
- 浏览器：发行包内置与应用版本匹配的 Chromium，不依赖系统 Chrome/Edge。
- 公开仓库：`https://github.com/Austin-C1/hg-` 同时保存受审源码和 GitHub Releases；下载用户只需要 Release ZIP。
- 更新行为：用户手动检查、手动确认、可见更新过程、失败自动回滚。
- 用户数据根目录：`%LOCALAPPDATA%\CrownMonitor`。
- Dashboard 默认地址：loopback，默认端口 8787；端口冲突时由启动器选择并持久化可用端口。
- 当前发布状态：`0.1.x-private-beta` / 监控预览版，真实投注 capability 保持 `0/0/0`。

## 当前实现与发行缺口

现有代码没有发现 `%USERPROFILE%`、Desktop、当前项目绝对路径或用户盘符写入生产源代码，但仍有以下不可移植点：

- 多处通过 `process.cwd()` 和相对路径寻找脚本、数据库、配置、静态文件与 runtime。
- 默认浏览器 channel 为系统 `msedge`。
- Compose 端口固定，`.env.example` 同时使用容器路径，不适合作为 Windows 本地配置。
- 无 runtime 时 Dashboard 会回退显示开发 fixture。
- Crown 默认站点地址仍存在脚本 fallback；正式发行必须要求用户配置自己的 exact HTTPS origin。
- Docker 镜像只复制 Dashboard 入口，缺少 Dashboard 会启动的 Watcher 与 betting worker 脚本。
- 当前工作目录存在被 Git/Docker ignore 的真实本机数据；不能直接使用资源管理器压缩发布。

因此当前状态只能称为私有 Alpha。完成本设计的实现和干净 Windows 验收后，才可标记为 Private Beta。

## 发行包结构

完整下载包使用单一顶层目录，避免用户解压后散落文件：

```text
CrownMonitor-v0.1.0-win-x64/
├─ 启动程序.cmd
├─ 停止程序.cmd
├─ 首次使用说明.txt
├─ current.json
├─ launcher/
│  ├─ start.ps1
│  ├─ stop.ps1
│  └─ update-bootstrap.ps1
├─ versions/
│  └─ 0.1.0/
│     ├─ app/
│     │  ├─ package.json
│     │  ├─ node_modules/
│     │  ├─ src/
│     │  ├─ scripts/
│     │  └─ frontend/dist/
│     └─ runtime/
│        ├─ node/
│        │  └─ node.exe
│        └─ chromium/
│           └─ ...
└─ licenses/
```

设计要点：

- `current.json` 只记录当前激活版本，不包含本机路径或秘密。
- `versions/<version>` 是不可变程序目录。更新先完整写入新版本目录，再切换当前版本。
- 顶层 launcher 尽量稳定，只负责定位自身目录、用户数据目录和激活版本。
- 用户无需安装 npm；发行包包含运行所需的 production dependencies。
- 完整发行包必须包含 Dashboard 实际会调用的 Watcher、betting worker 和相关 production 模块，即使真实能力仍由 capability `0/0/0` 阻断。
- 开发 fixture、测试、源码参考项目、协议抓包、数据库、日志和本机配置不进入 production ZIP。
- 如果以后需要更新 launcher，必须通过兼容旧 launcher 的单独 bootstrap 步骤完成，不能让正在运行的 updater 覆盖自身。

## 路径与数据隔离

运行时明确分为两个根目录：

| 根目录 | 用途 | 可写性 |
|---|---|---|
| `APP_ROOT` | launcher、版本化程序、内置 Node、内置 Chromium | 正常运行只读；更新器写入 |
| `CROWN_DATA_ROOT` | 数据库、配置、密钥、session、Profile、日志、更新暂存与备份 | 当前 Windows 用户可写 |

默认 `CROWN_DATA_ROOT` 为 `%LOCALAPPDATA%\CrownMonitor`：

```text
%LOCALAPPDATA%\CrownMonitor\
├─ storage/
│  ├─ crown.sqlite
│  └─ crown-local-secret.key
├─ config/
├─ runtime/
│  ├─ crown-sessions/
│  ├─ browser-profiles/
│  └─ betting-protocol-captures/
├─ logs/
├─ updates/
└─ backups/
```

所有入口都由 launcher 传入规范化绝对路径。应用不得从 shell 当前目录推断资源或数据位置。快捷方式、中文路径、带空格路径和任意解压目录必须等价运行。

## 启动与停止

### 启动

`启动程序.cmd` 调用 launcher，并保留当前命令窗口：

1. 从脚本自身位置解析 `APP_ROOT`，不使用调用者的 `cwd`。
2. 读取 `current.json` 并验证激活版本目录存在。
3. 创建或检查 `CROWN_DATA_ROOT` 的目录和当前用户写权限。
4. 检查数据库、密钥和配置路径均位于 `CROWN_DATA_ROOT` 内。
5. 读取持久化端口；默认尝试 8787。
6. 如果端口属于已运行的同一实例，直接打开现有 Dashboard；如果被其他程序占用，选择可用 loopback 端口并保存。
7. 使用内置 `node.exe` 启动 Dashboard，显式传入 APP、data、DB、static、runtime、Chromium 和端口路径。
8. 等待健康检查通过后打开默认浏览器访问 Dashboard。
9. 不启动 Watcher，不启动真实 betting worker。

启动失败时在窗口显示中文原因、日志位置和可执行处理，不自动关闭窗口。

### 停止

- 用户可关闭运行窗口或双击 `停止程序.cmd`。
- launcher 只停止具有本安装实例标识和匹配数据根目录的进程，不按进程名批量结束其他 Node 进程。
- 停止顺序为：停止真实投注意图/worker、停止 Watcher、等待 SQLite 写入收敛、关闭 Dashboard。
- 当前 capability 为 `0/0/0` 仍必须保留这一顺序，以便未来版本不会改变停止安全边界。

## 首次启动与皇冠登录

### 初始状态

首次启动必须得到：

- 新建空 SQLite，不导入开发 fixture 或历史比赛。
- 新生成本安装独立的本地加密密钥和 Dashboard session 材料。
- 为数据根目录生成独立 installation id，并限制同一数据根目录只运行一个 Dashboard 实例。
- 无监控账号、无投注账号、无 Telegram token、Watcher 停止、真实投注关闭。
- Dashboard 仅允许真实 loopback local-trust 访问。

`CROWN_DATA_ROOT`、本地密钥、session、Profile 和本地备份使用当前 Windows 用户的目录 ACL；不得为了简化启动而给 `Users`、`Everyone` 或其他本机账号增加写权限。

### 普通登录

用户在“监控账号”页面填写自己的：

- 皇冠网站 exact HTTPS 地址；
- 用户名；
- 密码；
- 扫描间隔。

密码使用本安装的本地密钥加密后保存到用户 SQLite。点击“保存并测试登录”后：

1. 使用账号配置的 exact origin，不使用代码内置 Crown 域名 fallback。
2. 走现有 Crown API 登录。
3. 通过只读 `get_game_list` 验证足球数据访问。
4. 将 session 保存到该账号自己的本地 session 目录。
5. 返回脱敏结果，不向前端返回密码、cookie、ticket 或原始响应。

登录成功不自动启动 Watcher。用户仍需进入运维控制台手动启动。

### 验证码、滑块或二次验证

当前默认 schema-v2 只会报告需要人工处理，尚不会自动打开浏览器。Portable 版新增显式“打开皇冠人工登录”：

1. 使用发行包内置 Chromium 和账号独立 Profile 打开用户配置的 exact HTTPS origin。
2. 自动填写账号密码仅限已识别的普通登录字段。
3. 验证码、滑块、OTP 或二次验证必须由用户本人完成，程序不得尝试绕过。
4. 用户确认完成后，只读取该 exact origin 所需 cookie/session。
5. 将浏览器 session 转换为 API session，并通过只读 `get_game_list` 复核。
6. 验证成功后保存 session、关闭 Chromium；失败则保留明确诊断，不启动 Watcher。

浏览器 Profile 位于 `CROWN_DATA_ROOT`，更新不会删除。任何跨 origin cookie、下载文件或页面存储都不得被导入 API session。

## GitHub Releases 发行方式

公开仓库固定为 `https://github.com/Austin-C1/hg-`，保存经过公开审计的源码、Release 说明与编译产物。仓库不得提交账号、用户配置、密钥、本机日志或其他 runtime 数据。

首次安装 Release assets：

```text
CrownMonitor-v0.1.0-win-x64.zip
CrownMonitor-v0.1.0-full-manifest.json
CrownMonitor-v0.1.0-full-manifest.sig
```

远程更新 Release assets：

```text
CrownMonitor-v0.1.1-update.zip
CrownMonitor-v0.1.1-update-manifest.json
CrownMonitor-v0.1.1-update-manifest.sig
```

用户首次安装时可以接收 Release 页面链接或 ZIP 直链。后续更新由 Dashboard 使用发行配置中的 GitHub Release API 地址检查。

更新源地址属于发行配置，不属于本机硬编码。下载版不包含 GitHub token；公开 Release 无需鉴权。GitHub 不可用时只影响检查更新，不影响本地 Dashboard 和 Watcher。

更新检查默认直连。用户确有网络代理时只能使用显式保存的可选代理配置或标准代理环境，不得内置开发机的 `127.0.0.1:7897` 等地址；代理失败与直连失败都只返回脱敏网络错误。

## 更新清单与签名

签名清单至少包含：

```json
{
  "schemaVersion": 1,
  "appId": "crown-monitor",
  "channel": "private-beta",
  "version": "0.1.1",
  "minUpdaterVersion": "0.1.0",
  "releaseTag": "v0.1.1",
  "assetName": "CrownMonitor-v0.1.1-update.zip",
  "assetSize": 0,
  "assetSha256": "...",
  "createdAt": "...",
  "files": [
    { "path": "app/...", "size": 0, "sha256": "..." }
  ]
}
```

规则：

- 发布电脑离线保存 Ed25519 私钥；私钥不得进入源码、环境模板或 GitHub。
- 下载版只携带一个或多个受信公钥和 key id。公钥是产品信任根，不是本机硬编码。
- 签名覆盖规范化 manifest 原始字节。
- 必须先验证 manifest 签名，再按签名内容下载指定 asset，最后验证 ZIP 大小、SHA-256 与内部每个文件 hash。
- GitHub Release 页面上的文本和未签名 checksum 只能作为展示，不能作为安装授权。
- 签名失败、hash 不一致、版本降级、appId/channel 不匹配或 updater 版本不足时必须拒绝安装。
- 密钥轮换需要由旧受信密钥签发包含新公钥的过渡版本，不能远程无条件替换信任根。

## 更新安全状态机

```text
idle
  -> checking
  -> available
  -> downloading
  -> verified
  -> preflight
  -> staged
  -> applying
  -> health_check
  -> succeeded

任一步失败 -> failed（旧程序继续运行）
apply 后失败 -> rolling_back -> rolled_back
```

### 更新前预检

更新只允许来自本机 Dashboard 的显式用户操作，并要求：

- 没有正在进行的另一更新。
- 下载空间、暂存空间和回滚空间充足。
- manifest、签名、asset 和文件清单全部验证通过。
- 真实投注意图为 off，betting worker 已停止。
- 没有 unknown submit、未关闭 reconciliation 或其他禁止停机的真实投注状态。
- Watcher 可以安全停止；更新器停止后不自动恢复。
- SQLite 一致性备份、本地密钥和必要配置备份成功。

任何预检失败都必须在关闭主程序前终止。

### 应用与健康检查

1. 将新版本完整解压到 `versions/<new-version>.staging`。
2. 拒绝绝对路径、`..`、符号链接、Windows 设备名、ADS、大小写冲突、重复文件、超额文件数和超额解压大小。
3. 验证每个文件的 allowlist、size 与 SHA-256 后原子重命名为正式版本目录。
4. 启动独立可见 PowerShell updater，停止旧 Dashboard。
5. 使用更新前数据启动候选版本，强制 Watcher/real betting 保持 off。
6. 在限定时间内检查进程、Dashboard health、static contract、SQLite schema/integrity 和 capability `0/0/0`。
7. 成功后原子切换 `current.json`，保留上一版本和更新前数据备份。
8. 失败则停止候选版本，恢复更新前数据备份，重新启动旧版本，并写明回滚原因。

更新状态写入 `CROWN_DATA_ROOT\updates`。页面刷新或主进程重启后仍能读取最终成功、失败或回滚结果。

### 断电与进程崩溃恢复

版本目录切换和数据库 migration 之间必须有持久更新 journal。journal 至少记录 previous version、candidate version、备份位置、当前 phase、是否已切换 `current.json` 和候选进程标识。

- 每个破坏性步骤之前先原子写入并 flush journal。
- launcher 启动时先检查未完成 journal，不能直接启动 `current.json` 指向的程序。
- 如果新版本尚未 commit，launcher 恢复更新前数据库和旧版本。
- 如果 commit 已完成但清理未完成，launcher继续使用已验证的新版本并补做安全清理。
- `current.json`、journal 和状态文件都使用临时文件 + 原子 rename，禁止原地截断写入。
- 验收必须在 download、backup、旧进程停止、候选启动、migration、health check 和 current switch 等阶段强制终止进程，验证下一次启动能确定恢复。

## 更新包覆盖边界

允许更新：

- `versions/<new-version>/app/**`
- `versions/<new-version>/runtime/node/**`
- `versions/<new-version>/runtime/chromium/**`
- 经兼容性检查批准的 launcher 新版本
- licenses 与版本元数据

禁止更新包写入或删除：

- `%LOCALAPPDATA%\CrownMonitor\storage/**`
- `%LOCALAPPDATA%\CrownMonitor\config/**`
- `%LOCALAPPDATA%\CrownMonitor\runtime/**`
- `%LOCALAPPDATA%\CrownMonitor\logs/**`
- 用户账号、Telegram、session、浏览器 Profile、协议证据和备份
- APP_ROOT 之外的任意路径

更新包中的“preserves”文字声明不能替代代码级 allowlist。实际 ZIP 文件和 manifest 都必须满足同一边界。

## 版本、备份与清理

- 使用 SemVer；Private Beta 使用 `0.1.x`，pre-release 可使用 `0.1.1-beta.1`。
- 默认只检查当前 `private-beta` channel，不把 prerelease 和 stable 混用。
- 保留当前版本、上一成功版本和最近两份更新前数据备份。
- 清理只删除已确认不再激活的旧版本和过期更新暂存，绝不删除当前/上一版本或用户数据。
- 数据库 migration 必须向前兼容更新流程；若旧程序无法读取新 schema，则健康检查失败回滚时必须恢复更新前 SQLite 备份。
- 手动删除、恢复或迁移用户数据不属于自动更新操作。

## 无本机硬编码门禁

每次生成完整包和更新包必须自动检查：

- `C:\Users\`、开发用户名、Desktop、当前仓库路径和盘符绝对路径命中为 0。
- 本机代理地址、现有端口状态、系统 Edge/Chrome 路径和浏览器 Profile 路径命中为 0。
- `.env`、SQLite、key、pem、token、cookie、session、storage state、Telegram 配置和运行日志命中为 0。
- production 行为不依赖 `process.cwd()`；测试必须从非项目目录启动。
- Crown 网址只来自用户账号配置；生产动作不使用脚本默认域名 fallback。
- 空安装不显示开发 fixture；demo 数据只有显式 demo build/mode 才允许。
- `127.0.0.1` 与 `Asia/Shanghai` 分别是安全网络默认和明确业务时区，不视为本机依赖，但必须集中配置和文档化。

## 发布构建

发行构建必须从干净 checkout 或明确 allowlist staging 目录生成，禁止递归压缩开发工作区。

构建流程：

1. 检查源码版本、前后端 contract 和 lockfile 一致。
2. 在干净环境执行 backend tests、syntax check、frontend tests 和 production build。
3. 安装 production dependencies。
4. 下载并验证固定版本的官方 Node Windows x64 runtime。
5. 安装并固定 Playwright/Chromium runtime，记录浏览器版本与许可证。
6. 按 allowlist 复制 production 文件到 staging。
7. 执行秘密、本机路径、禁止文件和包结构扫描。
8. 对文件生成 hash manifest，构建完整 ZIP/更新 ZIP。
9. 使用离线私钥签名 manifest。
10. 在全新目录解压并执行 smoke test。
11. 只将最终 ZIP、manifest、signature 和 release notes 上传 GitHub Releases。

当前仓库尚无 Git commit，所有文件仍为 untracked；在建立可信 clean checkout 和首个受审 commit 前不得发布。

## 错误处理

| 场景 | 行为 |
|---|---|
| GitHub 无法访问 | 显示检查失败，本地服务继续运行 |
| 下载中断 | 保留旧版本，删除或隔离未完成文件 |
| 签名/hash 失败 | 拒绝安装并记录安全错误 |
| 磁盘空间不足 | 在停服务前终止 |
| 数据备份失败 | 在停服务前终止 |
| Watcher 无法停止 | 不进入 apply |
| 候选版本无法启动 | 恢复数据并启动旧版本 |
| 健康检查失败 | 自动回滚并显示原因 |
| 回滚也失败 | 保留两个版本与备份，窗口显示人工恢复命令和日志位置 |
| Chromium 无法启动 | 普通 API 登录仍可用；人工验证明确失败且不启动 Watcher |
| Windows Defender/SmartScreen 提示 | 文档说明发行来源与 hash/signature；不得要求用户全局关闭 Defender、SmartScreen 或执行策略 |

任何错误信息都不得包含密码、cookie、token、完整 session、Authorization、原始 Crown 响应或本机敏感路径。

## 验收矩阵

### 干净 Windows

- Windows 10/11 x64，无 Node、npm、Chrome、Edge、Docker 和项目源码。
- 解压到中文、空格、长路径和非系统盘目录均可启动。
- 从桌面快捷方式、CMD 非项目 cwd 和双击运行结果一致。
- 不要求管理员权限，不写注册表，不建立 Service 或开机启动项。

### 首次运行与登录

- 空库、空账号、空历史、Watcher off、真实投注 off。
- 普通账号通过 API 登录与只读足球访问验证。
- 验证码场景打开内置 Chromium，用户手工处理后转换并验证 session。
- 关闭并重启程序后 session 保留；升级后仍保留。
- 登录或人工验证失败时 Watcher 不启动。

### 更新

- 无更新、发现更新、取消更新、离线、下载中断均不影响旧版本。
- 篡改 manifest、signature、ZIP、单文件 hash 均被拒绝。
- ZIP Slip、绝对路径、大小写冲突、重复 entry、超大解压包均被拒绝。
- 更新时 Watcher 自动停止，更新完成后保持停止。
- 更新成功保留账号、配置、SQLite、Telegram、session 和 Profile。
- 人为制造候选版本启动失败与 migration 失败，均能恢复旧版本和更新前数据库。
- 更新器从不同解压目录、不同 Windows 用户和端口冲突环境正常工作。
- 在更新各关键 phase 强制结束进程或模拟断电，下一次启动均能依据 journal 恢复到唯一确定状态。

### 发行物审计

- 发行 ZIP 内本机绝对路径、用户名、秘密和用户数据扫描为 0。
- 发布清单与 ZIP 内容完全一致，无额外未声明文件。
- capability matrix 在发行包和更新后仍为 `0/0/0`。
- GitHub 仓库只包含受审源码、公开产物与说明，不包含真实账号配置或 runtime 数据。

## 文档与用户说明

发行包内的首次使用说明只保留用户需要的内容：

1. 下载、解压和启动。
2. Dashboard 地址和运行窗口含义。
3. 配置自己的皇冠网址与账号。
4. 普通登录与人工 Chromium 验证。
5. 手动启动/停止 Watcher。
6. 手动检查更新与回滚提示。
7. 数据、日志和备份位置。
8. 如何完整卸载：先停止程序，再由用户自行删除 APP_ROOT 和 `CROWN_DATA_ROOT`。

开发、协议取证、旧 CLI 和真实投注安全架构继续留在项目开发文档，不放进普通用户 Quick Start。

## 后续实施边界

实现应拆为相互可验证的模块：

- Portable 路径模型与 launcher。
- Allowlist 发行构建与发行物审计。
- 内置 Node/Chromium 与人工登录 session bridge。
- Dashboard 系统更新 API/UI。
- Manifest 签名验证与安全解压。
- 外部 updater、版本切换、健康检查和回滚。
- Fresh Windows 验收与发布手册。

这些模块不得改动 Task 7、8、12 的真实投注硬停点。远程更新也不能成为绕过 capability、ExecutionAuthorization、unknown/reconciliation 或用户明确授权的入口。
