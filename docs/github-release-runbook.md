# GitHub Windows Private Beta 发布手册

## 发布边界

公开源码仓库固定为 [Austin-C1/hg-](https://github.com/Austin-C1/hg-)。公开仓库可以接收经过审计的源码；用户可下载的 Portable ZIP 只能来自 GitHub Release，并且必须同时满足：

- 干净 checkout 构建；
- 全量 backend/frontend 测试和 syntax/build 通过；
- allowlist staging 与发行物审计通过；
- Windows 10/11 x64 干净环境验收通过；
- update manifest 使用离线 Ed25519 私钥签名；
- ZIP、manifest、signature 三个 Release asset 完整且互相匹配。

GitHub Actions 只构建并短期保存 `unsigned` artifact。它不读取签名私钥、不自动创建 Release，也不能直接发给用户。

当前生产真实投注 capability 必须保持 preview/submit/reconciliation `0/0/0`。发布流程不得通过环境变量、配置或替换文件改变该矩阵。

## 私钥与信任根

- Ed25519 私钥只能保存在发布者控制的离线位置，绝不进入 Git 仓库、GitHub Secret、Actions artifact、ZIP、日志、截图或聊天记录。
- 发布命令必须显式接收私钥路径，不提供仓库内默认私钥。
- 仓库和下载包只包含受信公钥及 `signingKeyId`。新增或轮换公钥必须先代码审查、测试和发布旧钥签名的过渡版本。
- 若私钥丢失、疑似泄露或无法确认来源，立即停止发版；不要临时关闭签名校验。
- 签名是 64-byte raw Ed25519 signature，覆盖 `update-manifest.json` 的原始 canonical UTF-8 bytes。签名后不能格式化或重写 manifest。

## 1. 准备发布分支

1. 从预定发布 commit 建立干净 checkout，确认 origin 为 `https://github.com/Austin-C1/hg-.git`，仓库可见性为 public。
2. 版本号在 `package.json`、`package-lock.json` 和 tag 中完全一致；tag 必须为 `v<version>`。
3. `git status --porcelain=v1 --untracked-files=all` 必须为空。
4. 确认不存在真实账号、密码、cookie、token、session、SQLite、浏览器 Profile、Telegram 配置、日志、截图、私钥或旧废弃程序。
5. 确认 `src/crown/update/release-config.mjs` 中已经包含本次 `signingKeyId` 对应的受信 Ed25519 公钥；没有公钥时更新服务必须保持不可用，不能发布更新资产。

发现任何秘密或用户数据时应先轮换相关凭据，再从候选提交和 Git 历史中清除；不能仅靠 `.gitignore` 掩盖已跟踪文件。

## 2. 全量验证

在干净 checkout 中执行：

```powershell
npm ci
npm --prefix frontend ci
npm test
npm run check
npm --prefix frontend test
npm --prefix frontend run build
node --test tests/crown-release-workflow.test.mjs
```

所有命令必须成功，且构建后 `git status` 仍为空。任何失败都阻断发布，不能用跳过测试、修改 lockfile 或手工复制旧 `dist` 的方式继续。

## 3. 构建和审计 unsigned Portable

Node 与 Chromium 必须使用 `release/windows-runtime-lock.json` 记录的版本、archive SHA-256 和完整 runtime tree digest。将已校验的 runtime 目录通过环境变量传入，不依赖发布电脑已安装的软件：

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
- Watcher/worker 默认停止，真实 capability 为 `0/0/0`。

把 staging 目录压缩为候选 ZIP 后，再解压到另一个空目录并重新执行 `release:audit`。最终 ZIP 的 SHA-256 和 byte size 必须以实际 Release asset 为准，不能沿用旧文件数值。

## 4. 外部目录与 Fresh Windows 验收

先在发布电脑的仓库外目录执行 smoke，再在没有系统 Node/Chrome/Edge/Docker 的 Windows 10 或 Windows 11 x64 Sandbox/VM 中重复。至少验证：

| 项目 | 合格结果 |
|---|---|
| ZIP 解压 | 中文和空格路径可运行；不能从压缩软件预览窗口运行 |
| 启动 | 双击 `启动程序.cmd`；窗口可见并保持；关闭窗口后程序停止 |
| 依赖 | 只使用包内 Node 和 Chromium；无需管理员、Service、注册表或系统浏览器 |
| Dashboard | 仅 loopback；首页和 `/api/health` 正常；端口冲突可安全选择备用端口 |
| 首次运行 | 创建空数据库；Watcher/worker off；真实 capability `0/0/0` |
| 登录 | exact public HTTPS；内置 Chromium；验证码/滑块/OTP 全部人工处理；成功后 Watcher 仍 off |
| 白名单 | 首次 seed 恰好 118 项；用户修改后重启/更新不覆盖 |
| 数据隔离 | 数据只在 `%LOCALAPPDATA%\CrownMonitor`；包内无账号、session、DB、Profile 或日志 |
| 更新成功 | 手动触发；签名/hash/files/preflight/backup/health 全部通过；Watcher/worker 不恢复 |
| 更新失败 | 篡改 manifest/signature/ZIP 均拒绝；候选失败恢复 SQLite 并回滚旧版本 |
| 崩溃恢复 | 在 backup、停止旧版、启动候选、健康检查、切换和回滚阶段强制终止后，下一次启动得到唯一确定版本且不重复改写数据 |
| 停止边界 | 只停止 installation id、PID、start time 和 probe 全部匹配的进程，不按进程名结束其他 Node |

验收记录只能保存版本、Windows 版本、测试矩阵结果和脱敏错误码，不保存账号、cookie、token、session、用户路径、SQLite 或截图中的敏感信息。

没有 Fresh Windows 证据时，只能推送源码和开发分支；不得创建“可用”“推荐下载”或同等含义的 Release，也不得把 Actions unsigned artifact 发给用户。

## 5. 生成 canonical update manifest

更新 Release 固定包含：

- Portable/update ZIP；
- `update-manifest.json`；
- `update-manifest.sig`。

`update-manifest.json` 必须由受审工具生成 canonical UTF-8 JSON，严格包含以下字段且不能有额外字段：

```text
schemaVersion, appId, channel, packageType, version, minUpdaterVersion,
releaseTag, signingKeyId, assetName, assetSize, assetSha256, createdAt, files
```

固定约束：`appId=crown-monitor`、`channel=private-beta`、`releaseTag=v<version>`；`assetSize` 和 `assetSha256` 来自最终 ZIP；`files` 按 case-sensitive path 严格升序，每项只含 `path/size/sha256`，并与安全解压后的更新文件完全一致。不要手工编辑已生成的 manifest。

用受审脚本直接读取最终 ZIP、计算每个文件与 ZIP 本体的 size/SHA-256，并原子写入 canonical manifest：

```powershell
node scripts/create-update-manifest.mjs --asset '<最终 ZIP>' --manifest '<update-manifest.json>' --version '<version>' --signing-key-id '<key id>' --created-at '<UTC ISO timestamp>'
```

输出文件必须事先不存在；脚本会拒绝不安全路径、重复 Windows 路径、ZIP bomb 约束超限、生成期间 ZIP 被替换及非 canonical manifest。不要临时手写或复用旧 manifest。

## 6. 离线签名和复验

在断网或隔离的签名环境中，把最终 ZIP 的 SHA-256/size、canonical manifest 和签名私钥路径分别核对。私钥路径必须指向仓库外文件：

```powershell
node scripts/sign-release-manifest.mjs --manifest '<update-manifest.json>' --private-key '<离线 Ed25519 私钥>' --signature '<update-manifest.sig>'
```

签名后执行：

1. 确认 signature 恰好 64 bytes。
2. 使用与发行包相同的受信公钥重新验证 manifest 原始 bytes。
3. 重新计算 ZIP size/SHA-256，并逐项验证解压文件清单。
4. 重跑发行物秘密/路径审计。
5. 用最终三个 asset 在 Fresh Windows 环境走一次 Dashboard 手动更新成功和篡改拒绝测试。

任何一步重新生成 ZIP 或 manifest 后，旧 signature 都作废，必须从签名前重新开始。

## 7. 创建 GitHub Release

1. 推送已审计 commit 和 `v<version>` tag。
2. 等待 pinned GitHub Actions workflow 全部通过；workflow 只提供二次 unsigned 构建证据。
3. 手动创建 Private Beta Release，Release notes 只写已验证功能、已知限制和升级注意事项，不嵌入 HTML 脚本或敏感诊断。
4. 上传最终 ZIP、`update-manifest.json`、`update-manifest.sig`，逐个核对文件名、byte size 和 SHA-256。
5. 从 GitHub Release 实际下载三个 asset，再离线复验签名、hash、清单和 `releaseTag`。
6. 在另一台 Fresh Windows 环境按用户下载路径完成最后一次启动和手动更新 smoke。

只有以上步骤全部通过，才能把该 Release 标记为可供少量用户下载。发布后不得替换同一 tag 下的 asset；需要修复时增加版本并重新走完整流程。

## 8. 发布后检查与撤回

- 通过 GitHub 文件列表再次确认公开仓库禁止内容命中为 0。
- 确认 Dashboard 更新源只读取 `Austin-C1/hg-` 的 HTTPS Release，并且没有 GitHub token。
- 确认用户启动、更新、回滚后 Watcher/worker 均为 off。
- 若发现 ZIP、manifest、signature、公钥、回滚或数据隔离问题，立即把 Release 标记为不可用并移除用户下载指引；不要静默替换 asset。
- 若仅 GitHub 或网络不可用，现有安装应继续运行当前版本，更新检查失败不得影响 Dashboard 启动。
