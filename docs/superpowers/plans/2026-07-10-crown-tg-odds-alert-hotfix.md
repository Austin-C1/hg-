# Crown TG Odds Alert Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让达到监控规则的赔率变化恢复产生 Signal 和 Telegram delivery，并按用户确认的无抬头五行格式显示北京时间。

**Architecture:** 每个皇冠 XML 响应使用根级 `system_time` 与 `capturedAt` 推导响应级 UTC offset，比赛开赛时间统一转换为 UTC 后再进入策略窗口。Signal evidence 保存渲染业务消息所需的安全字段，Telegram 只消费持久 Signal；Dashboard 和 TG 展示层把赔率变动 `observedAt` 显式转换为 `Asia/Shanghai`。

**Tech Stack:** Node.js 25、ES modules、`node:test`、SQLite、React 19、TypeScript、Vitest、Telegram Bot API。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/crown/monitor/crown-time.mjs` | 从响应 `system_time` 推导源 offset，解析两种 Crown 开赛时间为 UTC |
| `src/crown/crown-transform-xml.mjs` | 从 XML 根级提取 `system_time` 并传入每条 event 标准化 |
| `src/crown/monitor/odds-delta-strategy.mjs` | 在 matched decision evidence 中加入 TG 展示字段 |
| `src/crown/monitor/signal.mjs` | 校验并持久化新增的安全 evidence 字段，保持 signalId 规则不变 |
| `src/crown/alerts/telegram-templates.mjs` | 渲染无抬头五行中文赔率变化消息和北京时间 |
| `src/crown/alerts/telegram-alert.mjs` | schema-v2 Signal 改用业务模板，保留发送与重试边界 |
| `frontend/src/utils/formatDateTime.ts` | Dashboard 时间显式按 `Asia/Shanghai` 展示 |
| `tests/crown-time.test.mjs` | 源 offset、完整/短 DATETIME、fail-closed 回归测试 |
| `tests/crown-transform-xml.test.mjs` | XML 根级 `system_time` 到 event UTC 的集成测试 |
| `tests/crown-strategy-engine.test.mjs` | Signal 展示 evidence 与幂等契约测试 |
| `tests/crown-alerts.test.mjs` | TG 五行格式、让球/大小球、北京时间测试 |
| `frontend/src/utils/formatDateTime.test.ts` | Dashboard 北京时间格式测试 |

### Task 1: Crown 响应级源时间解析

**Files:**
- Modify: `tests/crown-time.test.mjs`
- Modify: `src/crown/monitor/crown-time.mjs`

- [ ] **Step 1: 写入响应级 GMT-4 失败测试**

在 `tests/crown-time.test.mjs` 增加：

```js
test('derives the Crown source offset from system_time and parses both DATETIME shapes', () => {
  const context = {
    systemTime: '2026-07-10 05:58:18',
    capturedAt: '2026-07-10T09:58:19.000Z',
  }
  assert.equal(parseCrownKickoff({
    ...context,
    datetime: '07-10 05:30a',
  }).utc, '2026-07-10T09:30:00.000Z')
  assert.equal(parseCrownKickoff({
    ...context,
    datetime: '2026-07-10 05:30:00',
  }).utc, '2026-07-10T09:30:00.000Z')
})

test('fails closed when a provided Crown system_time cannot establish a trustworthy offset', () => {
  assert.equal(parseCrownKickoff({
    systemTime: '2026-07-10 05:58:18',
    capturedAt: '2026-07-12T09:58:19.000Z',
    datetime: '2026-07-10 05:30:00',
  }).utc, null)
})
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `node --test tests/crown-time.test.mjs`

Expected: 第一项把完整 `DATETIME` 解析为 `null` 或错误 UTC，证明测试覆盖当前缺陷。

- [ ] **Step 3: 实现最小响应级 offset 解析**

在 `src/crown/monitor/crown-time.mjs` 增加内部 helper：

```js
const MAX_SOURCE_OFFSET_MINUTES = 14 * 60
const MAX_SYSTEM_TIME_SKEW_MS = 2 * 60 * 1000

function fullDateTimeParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
  return match ? match.slice(1).map(Number) : null
}

function crownSourceContext(systemTime, capturedAt) {
  const parts = fullDateTimeParts(systemTime)
  const captured = Date.parse(String(capturedAt || ''))
  if (!parts || !Number.isFinite(captured)) return null
  const wallAsUtc = Date.UTC(...[parts[0], parts[1] - 1, ...parts.slice(2)])
  const offset = Math.round((wallAsUtc - captured) / (15 * 60 * 1000)) * 15
  if (Math.abs(offset) > MAX_SOURCE_OFFSET_MINUTES) return null
  if (Math.abs(wallAsUtc - (captured + offset * 60_000)) > MAX_SYSTEM_TIME_SKEW_MS) return null
  return { offsetMinutes: offset, localYear: parts[0] }
}

function dateFromOffsetParts(year, month, day, hour, minute, second, offsetMinutes) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const milliseconds = wallAsUtc - offsetMinutes * 60_000
  return {
    milliseconds,
    utc: new Date(milliseconds).toISOString(),
    local: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
  }
}
```

扩展 `parseCrownKickoff({ gameDateTime, datetime, capturedAt, systemTime })`：提供 `systemTime` 时必须成功建立 source context；完整格式允许来自 `GAME_DATE_TIME` 或 `DATETIME`；短格式年份取 `context.localYear`。没有 `systemTime` 时保留现有离线 fixture 的 `Asia/Shanghai` 兼容路径。

- [ ] **Step 4: 运行时间测试并确认 GREEN**

Run: `node --test tests/crown-time.test.mjs`

Expected: 全部通过，旧 Asia/Shanghai fixture 测试保持不变。

### Task 2: XML 根级 system_time 传播

**Files:**
- Modify: `tests/crown-transform-xml.test.mjs`
- Modify: `src/crown/crown-transform-xml.mjs`

- [ ] **Step 1: 写入 get_game_more 完整 DATETIME 失败测试**

构造包含下列字段的最小 XML，并使用 `capturedAt=2026-07-10T09:58:19.000Z`：

```xml
<serverresponse>
  <system_time>2026-07-10 05:58:18</system_time>
  <game>
    <SHOWTYPE>ft</SHOWTYPE><GID>3001</GID><GIDM>9001</GIDM><LID>7001</LID>
    <DATETIME>2026-07-10 05:30:00</DATETIME>
    <LEAGUE>世界杯2026(美加墨)</LEAGUE><TEAM_H>法国</TEAM_H><TEAM_C>摩洛哥</TEAM_C>
    <RATIO_OUO>2.5</RATIO_OUO><RATIO_OUU>2.5</RATIO_OUU>
    <IOR_OUC>1.050</IOR_OUC><IOR_OUH>0.840</IOR_OUH>
  </game>
</serverresponse>
```

断言：

```js
assert.equal(normalized.records[0].event.startTimeUtc, '2026-07-10T09:30:00.000Z')
assert.notEqual(normalized.records[0].event.timeConfidence, 'none')
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test tests/crown-transform-xml.test.mjs`

Expected: `startTimeUtc` 当前为 `null`。

- [ ] **Step 3: 提取并传播 system_time**

在 `src/crown/crown-transform-xml.mjs` 增加只读 tag helper：

```js
function firstTagText(text, tagName) {
  const match = String(text || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'))
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '')).trim() : ''
}
```

`normalizeCrownTransformBatch()` 的 `normalizedMetadata` 增加：

```js
systemTime: firstTagText(xmlText, 'system_time'),
```

`baseEvent()` 调用 `parseCrownKickoff()` 时增加：

```js
systemTime: metadata.systemTime,
```

- [ ] **Step 4: 运行 XML 与时间测试并确认 GREEN**

Run: `node --test tests/crown-time.test.mjs tests/crown-transform-xml.test.mjs`

Expected: 全部通过。

### Task 3: Signal 保存中文业务消息证据

**Files:**
- Modify: `tests/crown-strategy-engine.test.mjs`
- Modify: `src/crown/monitor/odds-delta-strategy.mjs`
- Modify: `src/crown/monitor/signal.mjs`

- [ ] **Step 1: 写入 evidence 失败测试**

扩展 `prematchChange()` 的 market/old/next fixture，加入：

```js
market: { ...base.market, handicapRaw: '+0/0.5' }
old: { ...base.old, selection: { ...base.old.selection, oddsRaw: '0.940' } }
next: { ...base.next, selection: { ...base.next.selection, oddsRaw: '0.990' } }
```

在 matched decision 和 Signal 测试中断言：

```js
assert.equal(decision.evidence.homeTeam, '主队')
assert.equal(decision.evidence.awayTeam, '客队')
assert.equal(decision.evidence.handicapRaw, '+0/0.5')
assert.equal(decision.evidence.oldOddsRaw, '0.940')
assert.equal(decision.evidence.nextOddsRaw, '0.990')
assert.equal(createSignal({ rule, change, decision }).evidence.homeTeam, '主队')
```

- [ ] **Step 2: 运行策略测试并确认 RED**

Run: `node --test tests/crown-strategy-engine.test.mjs`

Expected: 新 evidence 字段为 `undefined`。

- [ ] **Step 3: 扩展 decision evidence**

在 `evaluateOddsDelta()` 的 matched `evidence` 中加入：

```js
homeTeam: text(change?.event?.homeTeam),
awayTeam: text(change?.event?.awayTeam),
handicapRaw: text(change?.market?.handicapRaw ?? change?.next?.market?.handicapRaw ?? change?.market?.handicap),
oldOddsRaw: text(change?.old?.selection?.oddsRaw ?? oldOdds.toFixed(3)),
nextOddsRaw: text(change?.next?.selection?.oddsRaw ?? nextOdds.toFixed(3)),
```

- [ ] **Step 4: 扩展 Signal normalization，保持 ID 不变**

在 `EVIDENCE_FIELDS` 加入 `homeTeam`、`awayTeam`、`handicapRaw`、`oldOddsRaw`、`nextOddsRaw`。`normalizedEvidence()` 使用 `safeString()` 校验球队和 raw 字段，并验证 `Number(oldOddsRaw) === oldOdds`、`Number(nextOddsRaw) === nextOdds`。返回对象包含新字段，但 `normalizeSignalForPersistence()` 的 `expectedSignalId` 输入保持原样，不加入展示字段。

为了兼容已持久化的旧 Signal，读取旧 JSON payload 不执行补写；只有新 `createSignal()` 必须包含完整展示字段。

- [ ] **Step 5: 运行策略与 Signal 测试并确认 GREEN**

Run: `node --test tests/crown-strategy-engine.test.mjs tests/crown-monitor-v2-integration.test.mjs`

Expected: 全部通过，确定性 Signal ID 测试不变。

### Task 4: 无抬头五行 TG 模板与北京时间

**Files:**
- Modify: `tests/crown-alerts.test.mjs`
- Modify: `src/crown/alerts/telegram-templates.mjs`
- Modify: `src/crown/alerts/telegram-alert.mjs`

- [ ] **Step 1: 写入精确消息失败测试**

在 `tests/crown-alerts.test.mjs` 构造大小球 Signal，并断言完整字符串：

```js
assert.equal(buildSignalTelegramMessage(signal), [
  '世界杯2026(美加墨)',
  '法国 v 摩洛哥',
  '大小球 / 全场',
  '小 2.5 0.850 -> 0.840',
  '时间：2026-07-10 18:04:00',
].join('\n'))
```

另加让球断言：选择 `home` 时第四行为 `法国 +0/0.5 0.940 -> 0.990`。测试数据的 `observedAt` 使用对应 UTC `2026-07-10T10:04:00.000Z`。

- [ ] **Step 2: 运行告警测试并确认 RED**

Run: `node --test tests/crown-alerts.test.mjs`

Expected: 当前输出含 `Crown monitor signal`、英文技术字段和原始 ISO UTC，与五行字符串不相等。

- [ ] **Step 3: 实现 Signal 业务模板**

在 `src/crown/alerts/telegram-templates.mjs` 导出 `buildSignalOddsChangeTelegramMessage(signal)`，复用北京时间 formatter 和市场/时段标签：

```js
export function buildSignalOddsChangeTelegramMessage(signal = {}) {
  const evidence = signal.evidence || {}
  const target = signal.target || {}
  const line = evidence.marketType === 'total'
    ? `${target.side === 'under' ? '小' : '大'} ${clean(evidence.handicapRaw)} ${clean(evidence.oldOddsRaw)} -> ${clean(evidence.nextOddsRaw)}`
    : `${target.side === 'away' ? clean(evidence.awayTeam) : clean(evidence.homeTeam)} ${clean(evidence.handicapRaw)} ${clean(evidence.oldOddsRaw)} -> ${clean(evidence.nextOddsRaw)}`
  return [
    clean(evidence.league),
    `${clean(evidence.homeTeam)} v ${clean(evidence.awayTeam)}`,
    `${marketLabel(evidence.marketType)} / ${periodLabel(evidence.period)}`,
    line,
    `时间：${formatTimestamp(signal.observedAt)}`,
  ].join('\n')
}
```

`src/crown/alerts/telegram-alert.mjs` 的 `buildSignalTelegramMessage()` 直接返回该业务模板；保留 `sendTelegramSignalAlert()`、Bot Token/Chat ID 解析和 Dispatcher 重试行为不变。

- [ ] **Step 4: 运行 TG 测试并确认 GREEN**

Run: `node --test tests/crown-alerts.test.mjs tests/crown-telegram-client.test.mjs tests/crown-alert-dispatcher.test.mjs`

Expected: 全部通过；测试使用注入 fetch，不发送真实 TG。

### Task 5: Dashboard 赔率变动时间固定为北京时间

**Files:**
- Create: `frontend/src/utils/formatDateTime.test.ts`
- Modify: `frontend/src/utils/formatDateTime.ts`

- [ ] **Step 1: 写入北京时间失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { formatDateTime } from './formatDateTime'

describe('formatDateTime', () => {
  test('formats stored UTC timestamps as Asia/Shanghai time', () => {
    expect(formatDateTime('2026-07-10T10:04:00.000Z')).toBe('2026-07-10 18:04:00')
  })
})
```

- [ ] **Step 2: 在非北京时间进程中确认 RED**

Run: `$env:TZ='UTC'; npm --prefix frontend run test -- formatDateTime`

Expected: 当前实现返回 `2026-07-10 10:04:00`。

- [ ] **Step 3: 改为显式 Asia/Shanghai formatter**

将 `formatDateTime()` 改为使用：

```ts
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
```

通过 `formatToParts()` 输出 `YYYY-MM-DD HH:mm:ss`，无效输入仍返回 `-`。

- [ ] **Step 4: 运行前端测试与构建并确认 GREEN**

Run: `$env:TZ='UTC'; npm --prefix frontend run test`

Run: `npm --prefix frontend run build`

Expected: 全部测试通过，production build 成功。

### Task 6: 全量验证、运行迁移和真实 delivery 观察

**Files:**
- Modify: `docs/modules/crown-football-monitor.md`
- Modify: `docs/modules/crown-telegram-notifications.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`

- [ ] **Step 1: 运行后端聚焦与全量测试**

Run: `node --test tests/crown-time.test.mjs tests/crown-transform-xml.test.mjs tests/crown-strategy-engine.test.mjs tests/crown-alerts.test.mjs tests/crown-alert-dispatcher.test.mjs tests/crown-monitor-v2-integration.test.mjs`

Run: `npm test`

Run: `npm run check`

Expected: 所有测试和 `.mjs` syntax check 通过。

- [ ] **Step 2: 重启本机 watcher**

只停止当前 `scripts/crown-watch.mjs --monitor-state-version 2` 的 PID，保留 Dashboard。使用原参数和现有代理环境重新启动：

```powershell
node scripts/crown-watch.mjs --monitor-state-version 2 --app-db storage/crown.sqlite --runtime-dir data/runtime --dom-poll-seconds 5 --max-game-more 8 --config-reload-seconds 30
```

不清空 SQLite、JSONL、Signal、delivery 或 session。

- [ ] **Step 3: 验证新快照时间与 Signal 链路**

等待至少两个 30 秒采集周期，检查：

```text
startTimeRaw=2026-07-10 05:30:00
startTimeUtc=2026-07-10T09:30:00.000Z
timeConfidence != none
```

然后统计最近变化的策略结果；目标赛前变化不再集中于 `start_time_missing` 或错误的 `kickoff-window-mismatch`。

- [ ] **Step 4: 验证真实 Telegram delivery**

不人工伪造命中消息。等待下一条真实达到规则且通过白名单、模式、时间窗口、赔率区间与冷却的 Signal，确认：

```text
monitor_signals 增加
monitor_deliveries.telegram: pending → sent
TG 收到无抬头五行中文消息
时间为北京时间
```

若 Telegram 网络失败，确认状态进入 `retry` 且错误码不含 token/secret；若持续没有真实合格变化，报告已验证到 Signal 前的实际链路和剩余等待条件，不伪称发送成功。

- [ ] **Step 5: 同步长期项目文档**

记录以下稳定事实：皇冠源时间由 `system_time` 动态推导；开赛时间只参与规则；赔率变动时间在 Dashboard/TG 展示为北京时间；TG schema-v2 使用无抬头五行模板；真实投注仍未接入 watcher。

- [ ] **Step 6: 检查改动范围，不提交 Git**

Run: `git status --short`

Run: `git diff -- src/crown/monitor/crown-time.mjs src/crown/crown-transform-xml.mjs src/crown/monitor/odds-delta-strategy.mjs src/crown/monitor/signal.mjs src/crown/alerts/telegram-templates.mjs src/crown/alerts/telegram-alert.mjs frontend/src/utils/formatDateTime.ts tests/crown-time.test.mjs tests/crown-transform-xml.test.mjs tests/crown-strategy-engine.test.mjs tests/crown-alerts.test.mjs`

Expected: 只包含本热修和此前用户已有未提交内容；不 commit、不 push。
