# 皇冠手工 Portable 发布与桌面快捷启动设计

**日期：** 2026-07-13
**状态：** 待用户书面审阅

## 1. 目标

从程序中完整删除 GitHub 远程自更新能力，不再提供 Dashboard 检查、下载或安装更新，也不再维护签名、公钥、候选版本切换和更新恢复链。程序继续以 Windows 10/11 x64 Portable ZIP 交付，用户需要升级时手工取得新 ZIP。

同时增加桌面快捷启动：用户第一次从 Portable 目录成功启动程序后，系统自动在当前 Windows 用户桌面创建“皇冠抓水投注”快捷方式；以后双击桌面图标即可启动同一份程序。

## 2. 已选方案

| 项目 | 决定 |
|---|---|
| 远程更新 | 完整删除前端、API、GitHub 下载、签名、安装、候选切换和恢复链，不只隐藏页面 |
| 手工发布 | 保留 Portable builder、runtime lock、发行 allowlist、`release-files.json` 和 release audit |
| 包布局 | 保留只读 `current.json` 与 `versions/<version>`，供 launcher 定位内置 Node、Chromium 和 Dashboard |
| 用户数据 | 继续保存于 `%LOCALAPPDATA%\CrownMonitor`，与程序目录分离 |
| 快捷方式 | 第一次成功启动后自动创建；以后每次成功启动幂等校正 |
| 图标 | Portable 包内附带稳定 `.ico` 文件，快捷方式使用该图标 |
| 启动行为 | 快捷方式启动现有 `启动程序.cmd`，继续显示运行窗口；关闭窗口仍会停止程序 |
| 失败策略 | 快捷方式创建失败不能阻止 Dashboard 启动，只记录脱敏错误并允许用户从目录启动 |
| 开机行为 | 不设置开机启动，不安装 Windows Service，不写注册表启动项 |

## 3. 删除边界

### 3.1 前端和 HTTP API

删除：

- 左侧导航“系统更新”；
- `/system-update` 页面和 SPA route；
- `SystemUpdate` 页面、状态类型及 API client 方法；
- `/api/app/system-update`、`/check`、`/install`、`/cancel`；
- 仅供候选更新版本使用的 `/api/health/update`。

普通 `/api/health` 必须保留。现有 launcher 用它绑定 installation id、PID、process start time 和 nonce，确保启停的是当前安装实例，而不是任意 Node 进程。

删除后直接访问 `/system-update` 或 `/api/app/system-update*` 必须返回 404，防止以后无意恢复入口。

### 3.2 远程更新运行链

删除以下能力及其专用文件、脚本和测试：

- GitHub Release 查询和资产下载；
- update manifest 生成与 Ed25519 签名；
- ZIP staging 和 updater 专用安全解压；
- 更新 preflight、SQLite 更新备份和候选健康检查；
- update service、journal、process lock、applier；
- Windows update handoff、candidate runtime 和 rollback/recovery；
- `update-bootstrap.ps1`、`crown-update-apply.mjs`；
- `release:manifest` 命令；
- updater 独占的 `yauzl` 及传递依赖。

`atomic-json-file.mjs` 与 `safe-data-path.mjs` 不能随目录直接删除。人工登录 session 仍依赖原子 JSON 写入。实现时将继续使用的通用文件迁到 `src/crown/runtime/`，先修改引用并通过测试，再删除剩余 `src/crown/update/`。

### 3.3 Dashboard 和 launcher

Dashboard 删除：

- update service 创建和注入；
- 关闭流程中的 update cancel；
- update health provider；
- update handoff 和 candidate 环境处理。

Launcher 删除：

- pending update recovery；
- candidate 启动参数、授权文件、abort 文件和环境变量；
- update journal、backup/update 目录绑定；
- update bootstrap 调用。

Launcher 保留：

- `启动程序.cmd`、`停止程序.cmd`；
- `start.ps1` 的普通启动主流程和 `stop.ps1`；
- installation identity、mutex、startup claim、parent lease；
- launcher state、stop request、普通 health probe；
- 端口冲突处理、中文/空格路径、精确进程停止；
- `current.json` 和版本目录解析。

### 3.4 Portable 构建和手工发布

保留：

- `scripts/build-windows-portable.mjs`；
- `scripts/verify-release-artifacts.mjs`；
- `src/crown/release/portable-release-builder.mjs`；
- `src/crown/release/release-audit.mjs`；
- `release/windows-runtime-lock.json`；
- 调整后的 `release/windows-production-allowlist.json`；
- 包内 `release-files.json`。

`release-files.json` 是 Portable 包自身逐文件 size/SHA-256 审计清单，不是远程更新 manifest，必须保留。

GitHub Actions 可以继续生成 unsigned Portable 构建产物，因为它只负责构建和审计，不会被用户程序自动下载或安装。手工分发可以使用 GitHub Release、网盘或其他渠道，但程序内部不再连接这些更新源。

## 4. 手工升级流程

用户升级时执行：

1. 停止旧版程序。
2. 手工取得新版 Portable ZIP。
3. 解压到新的独立目录，不覆盖正在使用的旧目录。
4. 双击新版目录中的 `启动程序.cmd`。
5. 新版继续使用 `%LOCALAPPDATA%\CrownMonitor` 中的账号、规则、SQLite、session 和配置。
6. 验证新版正常后，旧程序目录由用户自行保留或删除。

程序不自动检查版本，也不弹出更新提示。手工升级失败时，用户可以重新运行旧目录；由于用户数据独立，回退程序目录不应删除数据。

如果未来数据库 schema 出现不可逆迁移，发布说明必须明确最低可回退版本；本次删除远程更新不改变数据库迁移规则。

## 5. 桌面快捷方式

### 5.1 创建时机

只在普通 launcher 完成以下步骤后创建或校正快捷方式：

- Portable 路径和 installation identity 已通过校验；
- Dashboard 子进程已启动；
- 普通 `/api/health` 已确认当前实例可用。

候选更新模式被删除后，不存在 updater 或 candidate 启动创建快捷方式的情况。

### 5.2 快捷方式内容

新增独立脚本 `packaging/windows/launcher/create-desktop-shortcut.ps1`，由 `start.ps1` 在健康检查通过后调用。脚本使用 Windows Shell shortcut API 创建 `.lnk`：

| 字段 | 值 |
|---|---|
| 名称 | `皇冠抓水投注.lnk` |
| 目标 | 当前 Portable 根目录中的 `启动程序.cmd` |
| 工作目录 | 当前 Portable 根目录 |
| 图标 | 当前 Portable 根目录中的 `皇冠抓水投注.ico` |
| 窗口 | 普通可见窗口 |
| 描述 | `启动皇冠抓水投注` |

桌面目录必须通过 `[Environment]::GetFolderPath('Desktop')` 获取，兼容 OneDrive 或组策略重定向，不能拼接 `%USERPROFILE%\Desktop`。

### 5.3 幂等和移动目录

每次普通启动成功后都重建同名临时快捷方式并替换最终 `.lnk`：

- 已存在且目标一致时，最终结果不变；
- Portable 目录变化后，从新目录运行一次 `启动程序.cmd` 即更新快捷方式目标；
- 不创建带数字后缀的重复图标；
- 不扫描或删除用户其他快捷方式；
- 不自动删除旧程序目录。

快捷方式脚本只接受 launcher 传入的绝对 package root，并验证目标 `启动程序.cmd` 和 `.ico` 位于该 root 内且真实存在。失败只写入 launcher 日志，不把绝对用户路径或异常堆栈显示到 Dashboard。

### 5.4 图标资产

Portable 源目录新增 `packaging/windows/皇冠抓水投注.ico`。发行 allowlist 和 builder 必须明确包含该文件，release audit 校验其存在、非空且没有仓库外路径引用。

图标只用于 Windows 快捷方式，不改变 Dashboard 页面设计。

## 6. 测试与验收

### 6.1 远程更新删除验证

- 前端导航不存在“系统更新”；
- `/system-update` 不再由 SPA fallback 接管；
- `/api/app/system-update*` 和 `/api/health/update` 返回 404；
- 生产源码和构建产物不包含 GitHub updater、update manifest、签名或安装入口；
- `package.json`、lockfile 和发行 allowlist 不再包含 updater 专用依赖和文件；
- 普通 `/api/health`、启动、停止、单实例和进程身份测试继续通过；
- Portable builder 和 release audit 继续通过。

### 6.2 快捷方式自动化测试

- 中文、空格和任意盘符目录能生成正确 `.lnk`；
- 重复执行只存在一个 `皇冠抓水投注.lnk`；
- 更换 package root 后目标被更新；
- 目标、工作目录和图标全部指向同一 Portable root；
- Desktop 重定向路径正确；
- 目标文件或图标不存在时拒绝创建；
- 快捷方式创建权限不足时 launcher 仍正常完成启动；
- 快捷方式启动后仍能通过普通 health、单实例复用和精确停止测试。

### 6.3 最终 Windows 验收

在 Windows 10/11 x64 新目录进行：

1. 解压 Portable ZIP。
2. 第一次双击 `启动程序.cmd`，确认 Dashboard 启动并出现桌面图标。
3. 关闭运行窗口，确认程序停止。
4. 双击桌面图标，确认程序重新启动且不产生第二个图标。
5. 将完整 Portable 目录移动到另一位置，从新目录启动一次，确认快捷方式目标更新。
6. 验证账号、规则和 SQLite 数据仍位于 `%LOCALAPPDATA%\CrownMonitor`。
7. 验证页面没有系统更新入口，相关 API 均不可用。

## 7. 与自动投注计划的关系

本设计是独立的 Windows 交付子项目，不修改投注规则、Watcher 业务判断、账号分配或 `FT_bet` 协议。实施顺序建议先删除无效的远程更新链并稳定 launcher/快捷方式，再执行自动投注 Provider 开发，最后一起做完整构建与 Windows 验收。
