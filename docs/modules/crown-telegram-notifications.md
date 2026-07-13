# Crown Telegram Notifications

## 目标

赔率监控命中当前设置后，通过 Telegram bot 发送皇冠赔率变化通知。

## 边界

- 只通知让球和大小球。
- 支持多个 Chat ID 和 `chatId:threadId`。
- 支持通过 Telegram `getUpdates` 获取 Chat ID。
- token 只保存在本地配置，不通过 API 明文返回。
- 获取 Chat ID 时后端可使用已保存 token；如果表单临时输入新 token，只用于本次获取，不会自动保存。
- 设置页已保存 token 显示只读“已保存”和“修改”按钮；未配置的当前 token 或 Chat ID 区域显示“未设置”，避免保存后看起来像空值。
- `crown-watch` 实际报警必须同时满足当前监控设置和范围过滤；默认联赛命中可以报警，SQLite 中 active 的手动追踪比赛也可以报警。
- Windows 桌面运行 Dashboard/watcher 时，Telegram Bot API 需要 Node 继承本机代理环境：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY=http://127.0.0.1:7897`，并设置 `NODE_OPTIONS=--use-env-proxy`。
- 投注成功通知模板先预留，真实投注成功触发由后续投注模块接入。

## schema-v2 赔率变化消息

持久 Signal 命中后通过 Dispatcher 建立 Telegram delivery。消息不显示抬头或内部技术字段，固定为五行：

```text
世界杯2026(美加墨)
法国 v 摩洛哥
大小球 / 全场
小 2.5 0.850 -> 0.840
时间：2026-07-10 18:04:00
```

- 顺序为联赛、比赛、抓取类型、盘口与旧/新赔率、时间。
- 时间取 Signal `observedAt`，持久化保持 UTC，发送时显式转换为 `Asia/Shanghai`。
- 让球第四行显示实际选择球队；大小球显示“大/小”。原始三位赔率文本来自 Signal evidence。
- 发送成功记为 `sent`；网络错误按 Dispatcher 规则进入 `retry`，永久配置错误进入 `dead-letter`。消息失败不删除 Signal 或候选。

## 主要文件

- `src/crown/telegram/telegram-client.mjs`
- `src/crown/alerts/telegram-templates.mjs`
- `src/crown/alerts/telegram-alert.mjs`
- `src/crown/config/telegram-settings.mjs`
- `src/crown/app/local-config-api.mjs`
- `src/crown/monitor/monitor-settings.mjs`
- `scripts/crown-watch.mjs`
- `frontend/src/pages/Settings.tsx`

## 验证

- `node --test tests\crown-telegram-client.test.mjs`
- `node --test tests\crown-alerts.test.mjs`
- `node --test tests\crown-telegram-settings.test.mjs`
- `node --test tests\crown-app-api.test.mjs`
- `node --test tests\crown-monitor-settings.test.mjs`
- `node --test tests\crown-watch-fixture.test.mjs`
- `npm --prefix frontend run test`
