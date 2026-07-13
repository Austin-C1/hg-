# Crown Monitor v2 运维手册

## 1. 适用范围

本手册用于运行和排查默认 `schema v2` 足球赔率监控。它只覆盖采集、事实状态、策略 Signal、告警投递和候选生成，不覆盖真实投注执行。

安全边界：

- 不在命令、截图、日志或文档中粘贴账号、密码、cookie、uid、session、bot token 或 ticket。
- 不把 `storage/`、`data/runtime/`、本地 Telegram 配置或浏览器 profile 提交到 Git。
- 不用真实下单命令验证 watcher。watcher 不应出现 `FT_order_view` 或 `FT_bet` 调用。

## 2. 启动前检查

1. 安装依赖：

   ```powershell
   npm install
   npm --prefix frontend install
   ```

2. 在本地 Dashboard 配置并启用一个包含 username/password 的皇冠监控账号。缺少账号或凭据不完整时默认 v2 会 fail-closed，不会启动 legacy browser/DOM。不要把账号写入仓库配置。
3. 确认数据库和 runtime 目录可写，且位于 `.gitignore` 覆盖范围内。
4. 查看 CLI：

   ```powershell
   node scripts\crown-watch.mjs --help
   ```

5. 可先执行短登录测试；它验证 session 后退出，不开始长期轮询：

   ```powershell
   node scripts\crown-watch.mjs --login-test --monitor-state-version 2 --max-seconds 60
   ```

遇到 CAPTCHA、滑块、MFA 或其他人工验证时停止自动处理，按页面提示由人工完成；不要尝试绕过。

## 3. 启动 v2

默认就是 v2，建议仍显式写出版本以便日志和交接清晰：

```powershell
npm run crown:watch -- --monitor-state-version 2
```

需要指定相对路径时：

```powershell
node scripts\crown-watch.mjs --monitor-state-version 2 --app-db storage\crown.sqlite --runtime-dir data\runtime
```

同一个 runtime/SQLite 只能由一个 watcher 写入。Dashboard 重启后不能自动接管旧的孤儿 watcher；再次启动前先确认没有旧进程仍在运行。

`--from-fixture` 是 schema-v1 store 的离线兼容路径，即使 CLI 默认版本为 2 也不会创建 v2 state。它用于验证 normalizer/legacy fixture，不等价于 v2 live warmup。

## 4. 首次 baseline warmup

新的 SQLite 或新的 scope 第一次运行时：

1. 第一份完整 `get_game_list` 建立 authoritative event set。
2. 第一份 `get_game_more`/selection 只建立盘口 baseline。
3. 此时 `odds-change Signal` 应为 0；这是正常行为，不是漏报。
4. 同一 selection 的第二次有效观测发生真实赔率变化后，才会产生 Change；满足策略且数据完整时才产生 Signal。

不要为了“让告警出现”删除 baseline、复制旧 v1 JSONL 或手工修改赔率状态。v2 从 SQLite 恢复，不从旧 JSONL 尾部恢复 active events。

warmup 后检查 Dashboard：

- “最后权威批次”有值；
- active event/selection 数量不再为 0；
- pending/dead-letter 没有异常增长；
- 比赛缺时间时会显示“数据不完整”，该比赛不会绕过策略时间门禁。

## 5. v2 文件和 SQLite 表

### 5.1 可选历史文件

| 路径 | 内容 |
|---|---|
| `data/runtime/crown-odds-snapshots-v2.jsonl` | 清理按钮点击前累计的 schema-v2 snapshot 历史 |
| `data/runtime/crown-odds-changes-v2.jsonl` | 清理按钮点击前累计的纯事实 Change 历史 |
| `data/runtime/betting-candidates-v2.jsonl` | 从持久 Signal 确定性派生的候选 |
| `data/runtime/crown-watch-runtime.jsonl` | poll、错误和运行计数 |

程序不会自动清理 snapshot/change。每天开工前可在运维控制台查看预估大小并手动执行“每日开工完全重置”；真实投注先关闭，受管 watcher 安全停启，全部点击前运行状态清空。手动 CLI watcher 活跃时重置会拒绝执行，避免边写边删。账号凭据、登录会话、规则、协议证据和运行依赖不在清理白名单内。

### 5.2 SQLite 表

| 表 | 运维含义 |
|---|---|
| `monitor_scope_state` | 每个 scope 的最后批次、最后完整时间和 event set |
| `monitor_event_state` | event active/missing 状态 |
| `monitor_selection_state` | 当前 selection baseline |
| `monitor_signals` | 已接受的确定性 Signal |
| `monitor_cooldowns` | 跨重启冷却状态 |
| `monitor_deliveries` | Console/Telegram 投递队列及结果 |
| `monitor_audit_outbox` | 尚未被当前 audit sink 确认的事实；确认后立即删除 |
| `monitor_candidates` | 候选和 JSONL 导出状态 |

日常运行不要手工删除 SQLite 状态；需要完整重置监控基线时必须先停止 watcher，并保留投注账本和执行审计表。

## 6. 健康指标解释

| 指标 | 正常含义 | 异常处理 |
|---|---|---|
| 最后权威批次 | 最近完整 list 已提交 | 长时间不更新时查登录、XML 完整性和 runtime error |
| active events | 当前 scope 中仍存在的 event | 突然归零时先确认 list 是否完整；不手工清库 |
| selection baselines | 可比较的最新盘口 | list 有赛事但为 0 时查 detail 请求/解析 |
| Signal | 满足策略并持久化的信号 | baseline warmup 为 0 正常；持续为 0 时查 data quality 和策略门禁 |
| 待发送告警 | `pending/retry/dispatching` | 持续增长时查 sender 网络、配置和 dispatcher 是否运行 |
| 投递失败 | `dead-letter` | 修正永久配置错误后再决定是否人工重排队 |
| 数据不完整 | 缺 start time/live clock 等 | 保存事实但 fail-closed；修复采集/解析，不放宽门禁 |

数据库缺失、不可读或没有 v2 表时，Dashboard 返回 `unavailable`，不会把 0 当作真实健康值。

## 7. dead-letter 处理

1. 记录 Signal ID、channel、`last_error_code` 和发生时间；不要复制 payload 中可能存在的本地配置。
2. 如果是 Telegram，检查 bot 是否启用、Chat ID/话题格式和网络代理；不要输出 token。
3. 先修正根因并重启/确认 Dispatcher 正常。
4. `dead-letter` 是永久终态，当前没有 Dashboard 一键重试。确需重排队时：

   - 先备份 SQLite；
   - 停止 watcher；
   - 使用受控 SQLite 工具把指定 `signal_id + channel` 的状态改为 `retry`，同时设置新的 `next_attempt_at`；
   - 只改目标行，不批量重置所有历史；
   - 重启 v2 并观察该行进入 `sent` 或再次失败。

不要删除 `monitor_signals` 来触发重发；Signal/候选幂等依赖该记录。

## 8. schema-v1 回滚

只有 v2 本身阻断监控且短时间无法修复时才使用：

1. 停止当前 watcher，确认没有写进程残留。
2. 备份 SQLite 和 v2 JSONL。
3. 启动：

   ```powershell
   npm run crown:watch -- --monitor-state-version 1
   ```

4. 启动时必须看到 `DEPRECATED schema-v1 ... event lifecycle` 高可见度警告。
5. v1 只写：

   - `crown-odds-snapshots.jsonl`
   - `crown-odds-changes.jsonl`
   - `betting-candidates.jsonl`

6. v1 不启动 v2 state store、Dispatcher 或 v2 candidate sidecar，也不会删除、重命名或截断任何 v1/v2 文件。
7. v1 对现有 app DB 只读查询配置，不执行 migration 或 runtime status 写入；数据库不存在时不会创建。Dashboard 的账号运行状态可能因此不反映 legacy watcher 的即时状态，应以 watcher console/runtime log 为准。

限制：schema-v1 的 list/detail 全集语义已知会制造 event 增删抖动和 baseline 丢失，输出只可视为临时 legacy 数据，不能合并进 v2 健康或作为 v2 恢复源。

恢复 v2：停止 v1 后运行 `--monitor-state-version 2`。v2 从原 SQLite checkpoint 继续；回滚期间的 v1 JSONL 不导入 v2。

## 9. 备份与恢复

文件级备份前必须同时停止 watcher、Dashboard 和其他可能写同一数据库的执行进程，避免 SQLite/WAL 与 JSONL 时间点不一致。若不能停止全部 writer，必须使用 SQLite Online Backup API 或等价的一致性备份工具，不能直接复制正在写入的数据库文件。至少保存：

- SQLite 数据库及其 WAL/SHM（如果存在）；
- `crown-odds-snapshots-v2.jsonl`；
- `crown-odds-changes-v2.jsonl`；
- `betting-candidates-v2.jsonl`；
- 必需的非敏感配置副本。

示例（目标目录使用项目相对路径）：

```powershell
New-Item -ItemType Directory -Force storage\backups\monitor-v2 | Out-Null
Copy-Item storage\crown.sqlite* storage\backups\monitor-v2\
Copy-Item data\runtime\crown-odds-*-v2.jsonl storage\backups\monitor-v2\ -ErrorAction SilentlyContinue
Copy-Item data\runtime\betting-candidates-v2.jsonl storage\backups\monitor-v2\ -ErrorAction SilentlyContinue
git check-ignore storage\backups\monitor-v2
```

`git check-ignore` 必须返回该目录；若没有输出，先修正 `.gitignore`，不要继续备份。备份目录按包含本地账号状态的敏感数据保护。恢复时停止所有 Dashboard/watcher/执行写进程，成套恢复 SQLite/WAL/SHM 和同一时间点 JSONL，随后先短跑验证。

## 10. 离线与自动化验证

聚焦验证：

```powershell
node --test tests\crown-watch-state-version.test.mjs tests\crown-monitor-v2-integration.test.mjs
node --test tests\crown-time.test.mjs tests\crown-snapshot-batch.test.mjs tests\crown-monitor-state-store.test.mjs tests\crown-strategy-engine.test.mjs tests\crown-alert-dispatcher.test.mjs
node --test tests\crown-dashboard-data.test.mjs tests\crown-app-api.test.mjs
```

完整验证：

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

CLI/回滚验证：

```powershell
node scripts\crown-watch.mjs --help
node --test tests\crown-watch-state-version.test.mjs
```

安全扫描至少检查：

- watcher/monitor 是否导入或调用真实下注 adapter、`FT_bet`；
- Git 候选是否出现 credential/token/cookie 私密值格式；
- Git 候选文档是否出现本机用户目录绝对路径。

所有自动化验证使用 fixture、临时目录和 fake response，不访问真实投注服务。
