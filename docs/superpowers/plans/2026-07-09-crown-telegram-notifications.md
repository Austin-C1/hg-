# Crown Telegram Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把黑猫成熟的 Telegram 通知能力改造成皇冠版本：赔率监控命中规则后，立刻通过 TG 机器人发送清晰的赔率变化通知。

**Architecture:** 皇冠保留现有 `crown-watch` 监控链路和 `evaluateMonitorChange()` 触发闸门，只升级 Telegram 配置、发送客户端、模板渲染和设置页。后端新增独立 Telegram client，配置层支持多个 `chatIds` 并兼容旧 `chatId`；通知层使用皇冠专用模板生成消息，watcher 命中当前赔率监控设置后调用发送层。前端设置页借鉴黑猫，支持获取 Chat ID、多个接收目标、测试发送和 token 掩码。

**Tech Stack:** Node.js ESM, native `node:test`, JSON config, React 18, TypeScript, Vite, Ant Design 5, Telegram Bot API.

---

## 1. 范围和边界

本次只做 TG 通知机器人，不做投注执行。

必须实现：

- 赔率变化命中监控设置后发送 TG。
- 只发送让球和大小球，不发送独赢、单双、yes/no。
- 支持多个 `chatIds`。
- 支持 Telegram 群话题格式 `chatId:threadId`。
- 支持通过 `getUpdates` 获取 Chat ID。
- token 不在 API、前端、日志和测试输出中明文泄露。
- 新模板使用实际队伍名，不写“主队/客队”占位标签。

暂不实现：

- Telegram 指令监听。
- 日报。
- 多机器人复杂路由。
- 黑猫完整模板 CRUD。
- 投注成功真实触发，先只预留模板和测试发送能力。

---

## 2. 文件结构

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/crown/telegram/telegram-client.mjs` | 新增 | Telegram Bot API client：发送消息、批量发送、解析 `chatId:threadId`、获取 Chat ID |
| `src/crown/alerts/telegram-templates.mjs` | 新增 | 皇冠 TG 消息模板和变量渲染 |
| `src/crown/alerts/telegram-alert.mjs` | 修改 | 使用模板和 Telegram client 发送赔率变化通知 |
| `src/crown/config/telegram-settings.mjs` | 修改 | 支持 `chatIds`，兼容旧 `chatId`，保留 token 掩码 |
| `src/crown/app/local-config-api.mjs` | 修改 | 新增获取 Chat ID API，测试发送改用新 client |
| `frontend/src/pages/Settings.tsx` | 修改 | 设置页支持多个 Chat ID、获取 Chat ID、测试发送 |
| `frontend/src/services/api.ts` | 修改 | 新增 `getTelegramChatIds()` API |
| `frontend/src/types.ts` | 修改 | Telegram settings 类型增加 `chatIds` |
| `tests/crown-telegram-client.test.mjs` | 新增 | Telegram client 单元测试 |
| `tests/crown-alerts.test.mjs` | 修改 | 模板和发送行为测试 |
| `tests/crown-telegram-settings.test.mjs` | 修改 | 多 `chatIds`、旧 `chatId` 兼容、token 掩码测试 |
| `tests/crown-app-api.test.mjs` | 修改 | 设置 API、获取 Chat ID API 测试 |
| `frontend/src/pages/Settings.test.tsx` | 修改或新增 | 设置页多个 Chat ID 和获取 Chat ID 测试 |
| `docs/modules/crown-telegram-notifications.md` | 新增 | 模块文档 |
| `docs/module-index.md` | 修改 | 增加 TG 通知模块入口 |
| `docs/project-memory.md` | 修改 | 记录本次稳定决策和验证结果 |

---

## 3. 模板规则

### 3.1 赔率变化模板

大小球：

```text
皇冠赔率变化提醒

富明尼斯RJ v 诺瓦艾夸古RJ
联赛：球会友谊赛
类型：大小球 / 全场
变化：大 3 0.94 -> 0.90
时间：2026-07-09 06:12:30
```

让球：

```text
皇冠赔率变化提醒

尤尼昂 v 科金博
联赛：智利联赛杯
类型：让球 / 上半场
变化：尤尼昂 -0/0.5 0.94 -> 0.90
时间：2026-07-09 06:12:30
```

### 3.2 字段映射

| 数据 | 显示规则 |
|---|---|
| 比赛标题 | `${event.homeTeam} v ${event.awayTeam}` |
| 让球主队侧 | `${event.homeTeam} ${handicap} ${oldOdds} -> ${newOdds}` |
| 让球客队侧 | `${event.awayTeam} ${handicap} ${oldOdds} -> ${newOdds}` |
| 大小球大 | `大 ${handicap} ${oldOdds} -> ${newOdds}` |
| 大小球小 | `小 ${handicap} ${oldOdds} -> ${newOdds}` |
| 类型 | `让球 / 赛前`、`让球 / 上半场`、`大小球 / 全场` |
| 时间 | `YYYY-MM-DD HH:mm:ss` |

---

## 4. Task 1: Telegram Client

**Files:**
- Create: `src/crown/telegram/telegram-client.mjs`
- Create: `tests/crown-telegram-client.test.mjs`

- [ ] **Step 1: 写失败测试：解析普通 Chat ID 和群话题 Chat ID**

```js
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTelegramChatTarget } from '../src/crown/telegram/telegram-client.mjs'

test('parseTelegramChatTarget supports plain chat id and forum topic thread id', () => {
  assert.deepEqual(parseTelegramChatTarget('-100123'), {
    chatId: '-100123',
    messageThreadId: null,
  })
  assert.deepEqual(parseTelegramChatTarget('-100123:456'), {
    chatId: '-100123',
    messageThreadId: 456,
  })
})
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test tests\crown-telegram-client.test.mjs
```

Expected: FAIL，提示 `src/crown/telegram/telegram-client.mjs` 不存在或 `parseTelegramChatTarget` 未导出。

- [ ] **Step 3: 实现最小 client 解析函数**

在 `src/crown/telegram/telegram-client.mjs` 中实现：

```js
export function parseTelegramChatTarget(value) {
  const text = String(value ?? '').trim()
  const [chatId, thread] = text.split(':')
  const messageThreadId = thread ? Number.parseInt(thread, 10) : null
  return {
    chatId: String(chatId || '').trim(),
    messageThreadId: Number.isFinite(messageThreadId) ? messageThreadId : null,
  }
}
```

- [ ] **Step 4: 写失败测试：批量发送到多个 Chat ID**

追加测试：

```js
import { sendTelegramMessageToChats } from '../src/crown/telegram/telegram-client.mjs'

test('sendTelegramMessageToChats sends one request per chat target', async () => {
  const calls = []
  const result = await sendTelegramMessageToChats({
    botToken: '123456:secret-token',
    chatIds: ['10001', '-10002:88'],
    text: '<b>hello</b>',
    parseMode: 'HTML',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })

  assert.equal(result.sent, true)
  assert.equal(result.results.length, 2)
  assert.equal(calls[0].body.chat_id, '10001')
  assert.equal(calls[1].body.chat_id, '-10002')
  assert.equal(calls[1].body.message_thread_id, 88)
  assert.equal(calls[0].body.parse_mode, 'HTML')
  assert.equal(calls[0].body.disable_web_page_preview, true)
})
```

- [ ] **Step 5: 运行失败测试**

Run:

```powershell
node --test tests\crown-telegram-client.test.mjs
```

Expected: FAIL，提示 `sendTelegramMessageToChats` 未导出。

- [ ] **Step 6: 实现发送函数**

在 `src/crown/telegram/telegram-client.mjs` 中增加：

```js
export async function sendTelegramMessageToChats({
  botToken,
  chatIds = [],
  text,
  parseMode = 'HTML',
  disableWebPagePreview = true,
  fetchImpl = fetch,
} = {}) {
  const token = String(botToken || '').trim()
  const targets = [...new Set(chatIds.map((item) => String(item || '').trim()).filter(Boolean))]
  if (!token || !targets.length) return { sent: false, reason: 'missing-config', results: [] }

  const results = []
  for (const chatId of targets) {
    const target = parseTelegramChatTarget(chatId)
    const body = {
      chat_id: target.chatId,
      text: String(text || ''),
      disable_web_page_preview: disableWebPagePreview,
    }
    if (parseMode && parseMode !== 'plain') body.parse_mode = parseMode
    if (target.messageThreadId !== null) body.message_thread_id = target.messageThreadId

    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    results.push({
      chatId,
      sent: Boolean(response.ok),
      status: response.status,
      reason: response.ok ? null : 'http-error',
    })
  }

  return {
    sent: results.some((item) => item.sent),
    reason: results.some((item) => item.sent) ? null : 'http-error',
    results,
  }
}
```

- [ ] **Step 7: 写失败测试：getUpdates 提取 Chat ID**

追加测试：

```js
import { getTelegramChatIds } from '../src/crown/telegram/telegram-client.mjs'

test('getTelegramChatIds extracts message chats and topic ids from getUpdates', async () => {
  const result = await getTelegramChatIds('123456:secret-token', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: [
          { message: { chat: { id: 10001 } } },
          { message: { chat: { id: -10002 }, message_thread_id: 88 } },
          { edited_message: { chat: { id: 10001 } } },
        ],
      }),
    }),
  })

  assert.deepEqual(result.chatIds, ['10001', '-10002:88'])
})
```

- [ ] **Step 8: 实现 `getTelegramChatIds()`**

实现时必须覆盖黑猫已支持的 update 类型：

```js
const UPDATE_MESSAGE_KEYS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
]
```

提取规则：

```js
function chatIdFromUpdate(update) {
  for (const key of UPDATE_MESSAGE_KEYS) {
    const node = update?.[key]
    const chatId = node?.chat?.id
    if (chatId === undefined || chatId === null) continue
    const threadId = node?.message_thread_id
    return threadId ? `${chatId}:${threadId}` : String(chatId)
  }
  return ''
}
```

`getTelegramChatIds()` 返回：

```js
{ ok: true, chatIds: ['10001'] }
```

失败时返回：

```js
{ ok: false, reason: 'telegram-error', message: '...' }
```

- [ ] **Step 9: 运行 client 测试**

Run:

```powershell
node --test tests\crown-telegram-client.test.mjs
```

Expected: PASS。

---

## 5. Task 2: Telegram Settings 支持多个 Chat ID

**Files:**
- Modify: `src/crown/config/telegram-settings.mjs`
- Modify: `tests/crown-telegram-settings.test.mjs`

- [ ] **Step 1: 写失败测试：旧 `chatId` 自动归一成 `chatIds`**

在 `tests/crown-telegram-settings.test.mjs` 增加：

```js
test('telegram settings normalize legacy chatId into chatIds', () => {
  const settings = normalizeTelegramSettings({
    oddsAlert: {
      enabled: true,
      botToken: 'token',
      chatId: '10001',
    },
  })

  assert.deepEqual(settings.oddsAlert.chatIds, ['10001'])
  assert.equal(settings.oddsAlert.chatId, '10001')
})
```

- [ ] **Step 2: 写失败测试：逗号和换行分隔多个 Chat ID**

```js
test('telegram settings normalize comma and newline separated chat ids', () => {
  const settings = normalizeTelegramSettings({
    oddsAlert: {
      chatIds: ['10001, 10002', '-10003:88\n10001'],
    },
  })

  assert.deepEqual(settings.oddsAlert.chatIds, ['10001', '10002', '-10003:88'])
})
```

- [ ] **Step 3: 运行失败测试**

Run:

```powershell
node --test tests\crown-telegram-settings.test.mjs
```

Expected: FAIL，`chatIds` 当前不存在。

- [ ] **Step 4: 修改配置归一化**

在 `src/crown/config/telegram-settings.mjs` 增加：

```js
function normalizeChatIds(value, legacyChatId = '') {
  const raw = Array.isArray(value) ? value : [value]
  if (legacyChatId) raw.push(legacyChatId)
  return [...new Set(raw
    .flatMap((item) => String(item ?? '').split(/[\n,]/))
    .map((item) => item.trim())
    .filter(Boolean))]
}
```

`normalizeBot()` 输出增加：

```js
const chatIds = normalizeChatIds(input.chatIds, input.chatId)
return {
  enabled,
  botName,
  botToken,
  chatId: chatIds[0] || '',
  chatIds,
  parseMode,
  testMessage,
}
```

`maskBot()` 输出增加：

```js
chatId: bot.chatIds[0] || '',
chatIds: bot.chatIds,
```

- [ ] **Step 5: 测试发送改用多 Chat ID**

把 `sendTelegramTestMessage()` 的缺失配置判断改成：

```js
if (!config.botToken || !config.chatIds.length) {
  return { sent: false, reason: 'missing-config' }
}
```

发送逻辑改为调用 `sendTelegramMessageToChats()`，避免两套 Telegram POST 代码。

- [ ] **Step 6: 运行设置测试**

Run:

```powershell
node --test tests\crown-telegram-settings.test.mjs
```

Expected: PASS。

---

## 6. Task 3: 皇冠赔率通知模板

**Files:**
- Create: `src/crown/alerts/telegram-templates.mjs`
- Modify: `src/crown/alerts/telegram-alert.mjs`
- Modify: `tests/crown-alerts.test.mjs`

- [ ] **Step 1: 写失败测试：大小球模板**

在 `tests/crown-alerts.test.mjs` 增加：

```js
import { buildOddsChangeTelegramMessage } from '../src/crown/alerts/telegram-templates.mjs'

test('builds total odds telegram message with side, handicap, and odds on one change line', () => {
  const text = buildOddsChangeTelegramMessage({
    capturedAt: '2026-07-09T06:12:30.000+08:00',
    old: { oddsRaw: '0.94' },
    next: { oddsRaw: '0.90' },
    event: {
      league: '球会友谊赛',
      homeTeam: '富明尼斯RJ',
      awayTeam: '诺瓦艾夸古RJ',
    },
    market: {
      marketType: 'total',
      period: 'full',
      side: 'over',
      handicapRaw: '3',
    },
  })

  assert.match(text, /富明尼斯RJ v 诺瓦艾夸古RJ/)
  assert.match(text, /联赛：球会友谊赛/)
  assert.match(text, /类型：大小球 \/ 全场/)
  assert.match(text, /变化：大 3 0\.94 -> 0\.90/)
  assert.match(text, /时间：2026-07-09 06:12:30/)
})
```

- [ ] **Step 2: 写失败测试：让球模板使用实际队伍名**

```js
test('builds handicap odds telegram message with actual team name', () => {
  const text = buildOddsChangeTelegramMessage({
    capturedAt: '2026-07-09T06:12:30.000+08:00',
    old: { oddsRaw: '0.94' },
    next: { oddsRaw: '0.90' },
    event: {
      league: '智利联赛杯',
      homeTeam: '尤尼昂',
      awayTeam: '科金博',
    },
    market: {
      marketType: 'asian_handicap',
      period: 'first_half',
      side: 'home',
      handicapRaw: '-0/0.5',
    },
  })

  assert.match(text, /尤尼昂 v 科金博/)
  assert.match(text, /类型：让球 \/ 上半场/)
  assert.match(text, /变化：尤尼昂 -0\/0\.5 0\.94 -> 0\.90/)
  assert.equal(text.includes('主队 -0/0.5'), false)
})
```

- [ ] **Step 3: 运行失败测试**

Run:

```powershell
node --test tests\crown-alerts.test.mjs
```

Expected: FAIL，模板文件或函数不存在。

- [ ] **Step 4: 实现模板模块**

`src/crown/alerts/telegram-templates.mjs` 必须导出：

```js
export function buildOddsChangeTelegramMessage(change) {}
export function buildTelegramTestMessage(botName, testMessage) {}
export function buildBetSuccessTelegramMessage(input) {}
```

赔率通知只允许 `asian_handicap` 和 `total`：

```js
const MARKET_LABELS = {
  asian_handicap: '让球',
  total: '大小球',
}
```

方向映射：

```js
function changeLine(change) {
  const event = change?.event || {}
  const market = change?.market || {}
  const handicap = market.handicapRaw || change?.next?.handicapRaw || change?.old?.handicapRaw || '-'
  const oldOdds = change?.old?.oddsRaw ?? '-'
  const nextOdds = change?.next?.oddsRaw ?? '-'

  if (market.marketType === 'total') {
    const side = market.side === 'under' ? '小' : '大'
    return `${side} ${handicap} ${oldOdds} -> ${nextOdds}`
  }

  const team = market.side === 'away' ? event.awayTeam : event.homeTeam
  return `${team || '-'} ${handicap} ${oldOdds} -> ${nextOdds}`
}
```

- [ ] **Step 5: `telegram-alert.mjs` 改用新模板和新 client**

`buildTelegramMessage(change)` 改为：

```js
export function buildTelegramMessage(change) {
  return buildOddsChangeTelegramMessage(change)
}
```

`sendTelegramAlert(change, config)` 改为调用：

```js
sendTelegramMessageToChats({
  botToken: resolved.botToken,
  chatIds: resolved.chatIds,
  text,
  parseMode: resolved.parseMode,
})
```

- [ ] **Step 6: 运行告警测试**

Run:

```powershell
node --test tests\crown-alerts.test.mjs
```

Expected: PASS。

---

## 7. Task 4: 设置 API 增加获取 Chat ID

**Files:**
- Modify: `src/crown/app/local-config-api.mjs`
- Modify: `tests/crown-app-api.test.mjs`

- [ ] **Step 1: 写失败测试：`/api/settings/telegram/chat-ids`**

在 `tests/crown-app-api.test.mjs` 增加：

```js
test('app API fetches Telegram chat ids without persisting bot token', async (t) => {
  const telegramCalls = []
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/settings/telegram/chat-ids`, {
      method: 'POST',
      body: JSON.stringify({ botToken: '123456:secret-token' }),
    })

    assert.equal(result.response.status, 200)
    assert.deepEqual(result.payload.chatIds, ['10001'])
  }, {}, {
    telegramFetch: async (url) => {
      telegramCalls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: [{ message: { chat: { id: 10001 } } }],
        }),
      }
    },
  })

  assert.equal(telegramCalls.length, 1)
  assert.match(telegramCalls[0], /getUpdates/)
})
```

- [ ] **Step 2: 运行失败测试**

Run:

```powershell
node --test tests\crown-app-api.test.mjs --test-name-pattern "telegram chat ids"
```

Expected: FAIL，endpoint 返回 404 或未处理。

- [ ] **Step 3: 实现 API endpoint**

在 `local-config-api.mjs` 中增加：

```js
if (pathname === '/api/settings/telegram/chat-ids' && method === 'POST') {
  const body = await readBody(req)
  const botToken = String(body.botToken || '').trim()
  if (!botToken) return { statusCode: 400, payload: { error: 'missing-bot-token' } }
  const result = await getTelegramChatIds(botToken, { fetchImpl: appOptions.telegramFetch || fetch })
  if (!result.ok) return { statusCode: 400, payload: { error: result.reason, message: result.message } }
  return { statusCode: 200, payload: { chatIds: result.chatIds } }
}
```

- [ ] **Step 4: 测试发送 endpoint 使用新 client**

确认 `/api/settings/telegram/test` 调用 `sendTelegramTestMessage(settings[type], { fetchImpl: appOptions.telegramFetch || fetch })`，测试环境不会真实请求 Telegram。

- [ ] **Step 5: 运行 API 测试**

Run:

```powershell
node --test tests\crown-app-api.test.mjs
```

Expected: PASS。

---

## 8. Task 5: 设置页 UI 改造

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/pages/Settings.tsx`
- Modify or Create: `frontend/src/pages/Settings.test.tsx`

- [ ] **Step 1: 更新类型测试或组件测试**

测试目标：

```tsx
expect(screen.getByLabelText('接收消息 Chat IDs')).toBeInTheDocument()
expect(screen.getByRole('button', { name: '获取 Chat ID' })).toBeInTheDocument()
```

- [ ] **Step 2: `types.ts` 增加 `chatIds`**

`TelegramBotSettings` 增加：

```ts
chatIds: string[]
```

保留：

```ts
chatId?: string
```

用于兼容旧数据。

- [ ] **Step 3: `api.ts` 增加获取 Chat ID 方法**

新增：

```ts
async getTelegramChatIds(botToken: string): Promise<{ chatIds: string[] }> {
  return request('/api/settings/telegram/chat-ids', {
    method: 'POST',
    body: JSON.stringify({ botToken }),
  })
}
```

- [ ] **Step 4: 设置页 Chat ID 输入改为多行**

`Settings.tsx` 中将单行 `chatId` 改为：

```tsx
<Form.Item
  name="chatIdsText"
  label="接收消息 Chat IDs"
  extra="多个 Chat ID 用换行或逗号分隔；群话题可写成 chatId:threadId。"
>
  <Input.TextArea rows={3} />
</Form.Item>
```

加载时：

```ts
form.setFieldsValue({
  ...data,
  botToken: '',
  chatIdsText: (data.chatIds || [data.chatId].filter(Boolean)).join('\n'),
})
```

保存时：

```ts
const botPayload = {
  ...values,
  chatIds: String(values.chatIdsText || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean),
}
delete botPayload.chatIdsText
```

- [ ] **Step 5: 增加获取 Chat ID 按钮**

按钮行为：

```tsx
async function fetchChatIds() {
  const botToken = form.getFieldValue('botToken')
  if (!botToken && !data?.hasBotToken) {
    message.warning('请先填写机器人 token，或保存已有 token 后再获取')
    return
  }
  const tokenToUse = botToken
  const result = await api.getTelegramChatIds(tokenToUse)
  const current = String(form.getFieldValue('chatIdsText') || '')
  const merged = Array.from(new Set([
    ...current.split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
    ...result.chatIds,
  ]))
  form.setFieldValue('chatIdsText', merged.join('\n'))
}
```

如果 token 已保存但当前表单为空，第一版要求用户重新输入 token 再获取，避免后端暴露已保存 token。

- [ ] **Step 6: 运行前端测试**

Run:

```powershell
npm --prefix frontend run test
```

Expected: PASS。

---

## 9. Task 6: watcher 通知链路确认

**Files:**
- Modify only if needed: `scripts/crown-watch.mjs`
- Modify: `tests/crown-watch-fixture.test.mjs` or `tests/crown-alerts.test.mjs`

- [ ] **Step 1: 确认触发条件**

保持现有逻辑：

```js
const decision = evaluateMonitorChange(change, { settings: monitorSettings, defaultLeagues, cooldownState })
if (!decision.triggered) {
  addSkip(stats, decision.skipReason)
  continue
}
```

这就是“符合赔率监控设置的变化才发送”的闸门。

- [ ] **Step 2: 写测试确认 TG 只处理受支持盘口**

在告警测试中增加：

```js
test('telegram alert skips unsupported market types', async () => {
  const result = await sendTelegramAlert({
    type: 'odds-change',
    event: { homeTeam: 'A', awayTeam: 'B' },
    market: { marketType: 'moneyline', side: 'home' },
  }, {
    enabled: true,
    botToken: 'token',
    chatIds: ['10001'],
  })

  assert.equal(result.sent, false)
  assert.equal(result.reason, 'unsupported-market')
})
```

- [ ] **Step 3: 实现跳过 unsupported market**

`buildOddsChangeTelegramMessage()` 对 unsupported market 返回 `null`，`sendTelegramAlert()` 收到空消息时返回：

```js
{ sent: false, reason: 'unsupported-market' }
```

- [ ] **Step 4: 运行 watcher 相关测试**

Run:

```powershell
node --test tests\crown-alerts.test.mjs tests\crown-watch-fixture.test.mjs
```

Expected: PASS。

---

## 10. Task 7: 文档和项目记忆

**Files:**
- Create: `docs/modules/crown-telegram-notifications.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`

- [ ] **Step 1: 新增模块文档**

`docs/modules/crown-telegram-notifications.md` 写入：

```markdown
# Crown Telegram Notifications

## 目标

赔率监控命中当前设置后，通过 Telegram bot 发送皇冠赔率变化通知。

## 边界

- 只通知让球和大小球。
- 支持多个 Chat ID 和 `chatId:threadId`。
- token 只保存在本地配置，不通过 API 明文返回。
- 投注成功通知模板先预留，真实投注成功触发由后续投注模块接入。

## 主要文件

- `src/crown/telegram/telegram-client.mjs`
- `src/crown/alerts/telegram-templates.mjs`
- `src/crown/alerts/telegram-alert.mjs`
- `src/crown/config/telegram-settings.mjs`
- `frontend/src/pages/Settings.tsx`

## 验证

- `node --test tests\crown-telegram-client.test.mjs`
- `node --test tests\crown-alerts.test.mjs`
- `node --test tests\crown-telegram-settings.test.mjs`
- `node --test tests\crown-app-api.test.mjs`
- `npm --prefix frontend run test`
```

- [ ] **Step 2: 更新模块汇总**

`docs/module-index.md` 增加一行：

```markdown
| 皇冠 Telegram 通知 | `docs/modules/crown-telegram-notifications.md`、`src/crown/telegram/`、`src/crown/alerts/telegram-*.mjs` | 赔率变化命中监控规则后发送 TG；支持多个 Chat ID、群话题、Chat ID 获取和测试发送 | 是 | `node --test tests\crown-telegram-client.test.mjs tests\crown-alerts.test.mjs tests\crown-telegram-settings.test.mjs` |
```

- [ ] **Step 3: 更新项目记忆**

`docs/project-memory.md` 增加稳定事实：

```markdown
## 2026-07-09 Crown Telegram 通知机器人

- TG 通知借鉴黑猫成熟实现，但皇冠第一版只保留多 Chat ID、群话题、Chat ID 获取、测试发送和固定模板。
- 赔率变化通知由 `crown-watch` 的 `evaluateMonitorChange()` 触发闸门控制，只有命中当前赔率监控设置的变化才发送。
- 通知范围只包括让球和大小球。
- 模板使用实际队伍名，比赛标题格式为 `主队 v 客队`；大小球变化格式为 `大/小 盘口 旧赔率 -> 新赔率`；让球变化格式为 `实际队伍名 盘口 旧赔率 -> 新赔率`。
```

---

## 11. Final Verification

按顺序执行：

```powershell
node --test tests\crown-telegram-client.test.mjs
node --test tests\crown-alerts.test.mjs
node --test tests\crown-telegram-settings.test.mjs
node --test tests\crown-app-api.test.mjs
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

如果本机已有真实 TG bot token，可以手动验收：

1. 打开 `http://127.0.0.1:8788/settings`。
2. 填写 TG bot token。
3. 给机器人发送 `/start`。
4. 点击“获取 Chat ID”。
5. 保存配置。
6. 点击“发送测试消息”。
7. 启动 watcher，等待符合赔率监控设置的变化。
8. 确认 TG 收到类似：

```text
皇冠赔率变化提醒

富明尼斯RJ v 诺瓦艾夸古RJ
联赛：球会友谊赛
类型：大小球 / 全场
变化：大 3 0.94 -> 0.90
时间：2026-07-09 06:12:30
```

---

## 12. 执行建议

推荐按任务顺序做，不并行修改同一批文件。

优先顺序：

1. `telegram-client`。
2. settings 多 Chat ID。
3. 模板。
4. API。
5. 前端。
6. watcher 触发确认。
7. 文档和最终验证。

提交只在用户要求时执行；如果用户要求提交，每个 Task 完成并通过对应测试后单独提交。
