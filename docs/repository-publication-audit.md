# GitHub 公开仓库发布审计

> 日期：2026-07-10  
> 仓库：`https://github.com/Austin-C1/hg-.git`  
> 可见性：Public  
> 当前状态：本地 `feature/a-monitor-core` 已完成 A1–A12，尚无 commit，尚未 push

## 已完成

- 本地开发分支为 `feature/a-monitor-core`；
- 远端仓库可访问且为空；
- GitHub CLI 已登录；
- `.gitignore` 已排除 SQLite、加密密钥、Telegram 实际配置、Cookie/session、登录诊断、浏览器 profile、runtime、截图、日志、PBBall 二进制和本地参考程序；
- `.dockerignore` 已排除 storage、Telegram 实际配置、runtime、输出目录和本地参考程序；
- `.env.example` 明确保留，真实 `.env` 继续忽略；
- 候选 JSON 已按 password/cookie/token/authorization/secret/uid/username 等键名扫描；唯一非空命中是环境变量名称，不包含 Token 值；
- 候选文件未命中 GitHub token、OpenAI key、Telegram bot token、Authorization bearer/basic 或 private key 格式；
- 文档中的本机用户名绝对路径已移除；
- replay 输出不再记录本机绝对路径；
- replay 测试改为临时输出目录，不再重写项目 fixture。

## Replay 修正

`replayFixture(fixtureDir, { outputDir })` 现在可以把 `replay-normalized.jsonl` 和 `replay-summary.json` 写入独立目录。测试使用系统临时目录，源 fixture 内容保持不变。

本地 fixture 的 `LOCAL` source 使用项目相对路径，例如：

```text
data/fixtures/crown/20260708_004011/football-today-filtered.json
```

不再写入 `%USERPROFILE%\...` 形式所代表的本机绝对路径。

## 验证证据

- `npm test`：416/416；
- `npm run check`：119 个 `.mjs` 语法通过；
- `npm --prefix frontend run test`：34/34；
- `npm --prefix frontend run build`：通过；
- 定向 replay TDD：先确认 2 项测试因缺少 `outputDir` 支持而失败，再实现并确认 2/2 通过。

## A 阶段验收审计

### 批次和身份

| 验收项 | 证据 | 结果 |
|---|---|---|
| list A+B 后处理 detail A/B，active 仍为 A+B | `crown-monitor-v2-integration`: `direct Crown XML v2 chain preserves list lifecycle...`；`crown-monitor-state-store`: `authoritative list followed by details...` | 通过 |
| partial 不生成其他赛事 removed | `partial details persist baselines...`、`partial unknown events...` | 通过 |
| list 有 ECID、detail 无 ECID仍为同一 eventKey | `crown-snapshot-batch`: `list and game-more with the same GID...`；v2 integration 同链断言 | 通过 |
| 同 GIDM 多 GID 不冲突 | `two GIDs under one GIDM persist as two canonical events and selections...` | 通过，2 event/2 selection |
| detail 连续变化产生 odds-change | v2 integration 主链与 fresh DB sequence | 通过 |
| 不同 scope 不互相删除 | `reappearance resets...`、`one authoritative scope can remove...`、`global missingCount...` | 通过 |
| 空响应、登录失效、解析错误、不完整 XML 不批量删除 | `server-confirmed empty get_game_list fails closed...`、`two empty list responses cannot age...`、v2 failure matrix | 通过；A12 修复零赛事 authoritative 缺陷 |
| 连续两次完整 authoritative 缺失才 removed | `same-scope authoritative removal requires two misses...` | 通过 |
| 重启恢复 active/checkpoint | `monitor state survives close and reopen...`、两次缺失跨重启测试 | 通过 |
| event-removed 使用确认批次时间/来源 | 两次缺失测试断言 confirming batch 的 observedAt/batchId/pollId/source | 通过 |

### 时间

| 验收项 | 证据 | 结果 |
|---|---|---|
| 完整 GAME_DATE_TIME 转 UTC | `parses GAME_DATE_TIME as Asia/Shanghai and emits UTC` | 通过 |
| 无年份 12 小时 DATETIME 补年 | `adds the nearest reasonable year...`、`handles Crown DATETIME 12-hour boundaries` | 通过 |
| 跨年选择最近合理日期 | `adds...across New Year`、`can select the next year`、超窗口拒绝测试 | 通过 |
| `1H^08:00` → 8 | `parses Crown RETIMESET without reading the half number...` | 通过 |
| `2H^52:41` → 52 | 同组 RETIMESET 测试与 transform 接线测试 | 通过 |
| 缺赛前时间/滚球分钟保存事实但 Signal=0 | v2 integration: `missing kickoff time or live minute still persists factual baselines...` | 通过 |

### 策略、Signal 和投递

| 验收项 | 证据 | 结果 |
|---|---|---|
| store 不读取策略配置 | `monitor-state-store.mjs` 静态依赖审查，无 settings/rule loader | 通过 |
| unsupported Change 不触发 odds_delta | strategy engine unsupported-change-type 表驱动测试 | 通过 |
| 多策略冷却互不干扰 | `persistent cooldown survives restart, isolates strategies...` | 通过 |
| 冷却跨重启恢复并清理过期 | 同测试及 `expired cooldown cleanup is bounded...` | 通过 |
| 同一变化重放不重复 Signal | `drained Change is evaluated into one persistent Signal...` | 通过 |
| Telegram 失败可重试，不重复候选 | `Telegram timeout recovery keeps one Signal, one candidate row, and one JSONL line...` | 通过 |
| 慢 Telegram 不阻塞采集 | sender timeout 有界测试；Dispatcher 与 polling 独立接线 | 通过 |
| strategyId 明确绑定 bettingRuleId | strategy/candidate binding 与 unbound fail-closed 测试 | 通过 |
| watcher 无真实提交调用 | watcher/monitor 对 `CrownBetAdapter`、`FT_bet`、`FT_order_view`、`submitBet` 扫描 0 | 通过 |

### 回归、重放和真实短跑

| 验收项 | 证据 | 结果 |
|---|---|---|
| fixture、Dashboard、candidate dry-run、betting adapter 回归 | backend 416/416、frontend 34/34、production build | 通过 |
| list → 多个 game-more 顺序 fixture | `data/fixtures/crown/monitor-v2-sequence/manifest.json` 与 `disk sequence is sanitized, ordered list-to-details...` | 通过 |
| 重启、乱序、高告警量、渠道失败 | restart/stale/failure matrix；105 Signal bounded batch exactly-once 测试 | 通过 |
| 两套 fresh DB 确定性 | sequence 测试比较 3 Change ID、1 Signal ID、1 candidate ID，并验证同库重放不增长 | 通过 |
| 受控真实只读短跑 | 克隆 DB、禁用策略/Console/Telegram；2 list、16 detail、2960 snapshots、240 changes、0 parse error | 通过 |
| 真实短跑身份和生命周期 | 148 GID eventKey 冲突 0；detail event-removed 0 | 通过 |
| 时间解析率 | prematch 1928/2720（70.88%）；live 224/240（93.33%） | 已报告，缺失数据 fail-closed |
| 真实短跑请求边界 | 18 个 XML 请求全部为 monitor；preview=0、submit=0 | 通过 |
| 日志/API/v2 JSONL 脱敏 | 4 个 Dashboard API 均 200；禁止字段/secret 格式 0 命中 | 通过 |

真实短跑报告由仓库内 `scripts/crown-monitor-acceptance-audit.mjs` 生成，不依赖手工计数：

```powershell
npm run crown:monitor:acceptance-audit -- --runtime-dir <runtime> --db-path <db> --output <report>
```

报告规则版本为 `crown-monitor-acceptance-v1`，列出 26 个禁止字段和 5 类 secret pattern；记录 snapshot、Change、runtime log、SQLite 和 4 个 API 响应的 SHA-256/字节数/行数，并验证审计前后输入哈希不变。当前 ignored 验收报告为 `pass=true`：输入 SHA-256 均为 64 位十六进制，18 个 runtime 请求为 2 list + 16 detail，全部分类为 monitor，unknown/preview/submit/candidate 均为 0；API 全部 200，敏感命中为 0。

### A12 最终命令

- monitor 聚焦测试：157/157；
- 完整 backend：416/416；
- syntax：119 个 `.mjs`；
- frontend：34/34；
- production build：成功；
- Git 候选：215 个；TypeScript 构建缓存已排除；本机用户绝对路径 0，GitHub/OpenAI/AWS/Telegram/private-key 格式 0；
- Docker CLI 可用，但 Docker Desktop daemon 未运行，未执行容器启动；`docker-compose` 契约测试已包含在 backend 全量测试中。

A 阶段完成只表示只读监控、策略、Signal、Dispatcher、Candidate 和 Dashboard v2 可用；不表示 watcher 已允许真实自动下注。B/C 仍未开始。

## 首次推送前仍需执行

1. 复查 `git status` 和实际 staged 清单；
2. 对 staged 文件重新运行秘密扫描；
3. 确认 fixture 仅包含允许公开的业务样本；
4. 创建初始 commit；
5. push 前再次确认远端仍为空且目标为 `Austin-C1/hg-`；
6. push 后从 GitHub 页面复查没有 runtime、storage、Telegram 配置或诊断数据。

提交和推送属于外部写操作，未得到明确要求前不自动执行。
