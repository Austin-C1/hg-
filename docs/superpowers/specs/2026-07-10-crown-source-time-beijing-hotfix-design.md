# 皇冠源时间解析与赔率变动北京时间显示热修设计

## 问题

实时 watcher 已采集大量达到 `0.01` 的赔率变化，但 `monitor_signals`、`monitor_deliveries` 和 Telegram 消息均为 0。

实测皇冠 XML 当前返回：

- `system_time=2026-07-10 05:58:18`
- 同一时刻 UTC 约为 `2026-07-10T09:58:18Z`
- 因此当前皇冠响应使用 GMT-4，而不是北京时间。

现有解析器把皇冠源时间固定按 `Asia/Shanghai` 解释；同时只支持短格式 `DATETIME=07-10 05:30a`，不支持 `get_game_more` 实际返回的完整格式 `DATETIME=2026-07-10 05:30:00`。这会把真实开赛时间提前 12 小时或解析为空，最终被策略判为 `kickoff-window-mismatch` 或 `data_incomplete:start_time_missing`。

## 目标

1. 正确解释每次皇冠 XML 响应中的源时间。
2. 内部统一保存 UTC；页面和 Telegram 的“赔率变动时间”统一显示北京时间 `Asia/Shanghai`。
3. 保持规则时间窗口以真实 UTC 时刻计算，不用字符串或本机时区比较。
4. 无法可靠确定源时间时继续 fail-closed，不生成 Signal 或候选。
5. 不改变 0.01 阈值、白名单、手动追踪、滚球开关、冷却或投注边界。
6. 恢复简洁的中文 Telegram 业务提醒，不发送抬头或 schema-v2 英文技术诊断文本。

## 方案

采用响应级动态 offset：从 XML 根级 `system_time` 和响应 `capturedAt` 推导皇冠源 UTC offset，再用该 offset 解释当前响应内的比赛时间。

不把 GMT-4 写死，也不要求用户维护额外时区设置。这样账号时区改变或平台调整时，解析仍跟随当前响应。

## 数据流

```text
XML system_time + capturedAt
  → 校验并推导 sourceUtcOffsetMinutes
  → 解析 GAME_DATE_TIME / DATETIME
  → startTimeUtc（仅用于规则时间窗口）

Change/Signal observedAt（UTC）
  → Dashboard / Telegram formatter
  → 北京时间（Asia/Shanghai）

matched Signal
  → 中文赔率变化模板
  → Telegram oddsAlert Bot / Chat ID
```

## Telegram 消息契约

监控范围内的赔率变化达到当前规则后，持久 Signal 建立 Telegram delivery，并发送以下业务消息：

```text
世界杯2026(美加墨)
法国 v 摩洛哥
大小球 / 全场
小 2.5 0.850 -> 0.840
时间：2026-07-10 18:04:00
```

- 不显示“皇冠赔率变化提醒”或其他抬头。
- 字段顺序固定为：联赛名称、比赛队伍、抓取类型、盘口与旧/新赔率、北京时间。
- 联赛、比赛队伍和抓取类型直接显示内容，不加“联赛：”“比赛：”“类型：”前缀。
- 不显示策略名称、Signal ID、direction、delta、threshold 或数据质量等内部技术字段。
- 让球显示实际选择球队、盘口、旧赔率和新赔率；大小球显示“大/小”、盘口、旧赔率和新赔率。
- 时间取 Signal 的 `observedAt`，按 `Asia/Shanghai` 格式化；不使用皇冠开赛时间。
- Signal evidence 增加安全、规范化的展示字段：`homeTeam`、`awayTeam`、`handicapRaw`、`oldOddsRaw`、`nextOddsRaw`。数值字段仍保留用于策略和一致性校验。
- 新字段不参与 `signalId`，避免展示格式改变破坏幂等键；旧 Signal 缺少新字段时仍可读取，但新 Signal 必须包含完整消息字段。

## 解析契约

- 支持 `YYYY-MM-DD HH:mm:ss` 出现在 `GAME_DATE_TIME` 或 `DATETIME`。
- 支持 `MM-DD h:mma` 的 `DATETIME`，年份从皇冠 `system_time` 的源本地年份推导。
- offset 只接受合理 UTC 范围，且 `system_time` 与 `capturedAt` 的秒级差异必须在允许的网络延迟内。
- XML 明确提供 `system_time` 但无法验证时，不回退到猜测的北京时间。
- 离线旧 fixture 没有 `system_time` 时保留现有显式测试兼容路径；实时 XML 必须使用响应级 offset。
- `startTimeUtc` 使用规范 ISO UTC，仅参与规则时间窗口计算；皇冠源时间和赔率变动显示时间不得混为一谈。
- 赔率变化的 `capturedAt` / `observedAt` 继续以规范 UTC 持久化，只有 Dashboard 和 Telegram 展示层转换成北京时间。
- schema-v2 Signal Telegram 模板不得再直接输出原始 ISO UTC；Dashboard 时间格式化不得依赖运行电脑的本地时区。
- Telegram 发送失败继续由持久 delivery 重试；发送失败不删除 Signal，也不重复生成候选。

## 测试

先写失败测试并确认失败原因正确：

1. `system_time=05:58`、`capturedAt=09:58Z` 时，将 `DATETIME=05:30` 转成 `09:30Z`。
2. 完整格式 `DATETIME=2026-07-10 05:30:00` 可以解析。
3. 短格式和完整格式对同一比赛产生相同 UTC。
4. 无效或不可信 `system_time` fail-closed。
5. XML batch normalizer 把根级 `system_time` 传入每条 event。
6. schema-v2 Signal 的 `observedAt=2026-07-10T01:00:00.000Z` 在 TG 中显示为 `2026-07-10 09:00:00`。
7. schema-v2 让球和大小球 Signal 均渲染成无抬头的五行业务消息，并保留原始三位赔率文本。
8. Dashboard 的赔率变化时间显式使用 `Asia/Shanghai`，不随操作系统时区变化。
9. 修复后的目标赛前变化可通过时间窗口并生成 Signal；非白名单、关闭的滚球模式和缺失时间仍被过滤。
10. Signal 插入后建立 Telegram delivery，成功发送记为 `sent`，网络失败进入 `retry`，永久配置错误进入 `dead-letter`。

验证范围：时间与 XML 聚焦测试、monitor v2 集成测试、完整 backend、syntax check。修复后重启 watcher，确认新的快照带正确 UTC，并观察 `monitor_signals` 与 `monitor_deliveries`；实际 TG 发送只由下一次真实命中规则的变化触发。

## 安全边界

- watcher 仍不调用真实投注 preview/submit。
- 时间不可信时不生成可下注 Signal。
- 不清空或重写现有 SQLite/JSONL 历史。
- 不发送人工伪造的 TG 命中消息；只验证真实规则命中产生的 delivery。
