# 监控报警触发投注 Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有监控报警命中后，按投注赔率下限和升水/掉水方向生成投注候选，并通过独立执行入口进行 dry-run 复核，不直接真实下注。

**Architecture:** `scripts/crown-watch.mjs` 继续保持监控边界：只解析赔率、判断报警、写本地 JSONL 候选，不导入 `CrownBetAdapter`，不发送 `FT_order_view` 或 `FT_bet`。投注执行放在独立 CLI 中消费候选，复用 `BetIntent`、`RiskGuard`、`CrownBetAdapter` dry-run、审计和投注历史。投注候选的前置标准完全复用 `evaluateMonitorChange()`，不新增独立的“30 秒 / 0.03”快速判断。

**Tech Stack:** Node.js ESM, Node built-in test runner, React 18 + Vite + Ant Design 5, SQLite `node:sqlite`, JSONL runtime files.

---

## 对话确认后的规则

| 项目 | 决策 |
|---|---|
| 报警标准 | 以现有 `evaluateMonitorChange()` 为准：运行模式、默认联赛/手动追踪、赛前/滚球范围、赔率范围、水位阈值、方向、冷却时间都在这里判断。 |
| 投注入口 | 只有 `evaluateMonitorChange()` 返回 `triggered=true` 的变化才进入投注候选。 |
| 不新增标准 | 不再单独定义 `30 秒内变化 >= 0.03` 这种快速升/降水规则。 |
| 投注赔率下限 | 使用下注规则里的 `minOdds`，中文显示为“投注赔率下限”。低于下限不投注。 |
| 投注方向模式 | 写入下注规则，字段为 `betDirectionMode`：`auto` 自动、`follow` 顺打、`reverse` 反打。 |
| 自动模式 | `auto` 下当前盘口升水时下反向盘口，当前盘口掉水时下当前盘口。 |
| 顺打模式 | `follow` 下当前盘口，不管升水或掉水。 |
| 反打模式 | `reverse` 下反向盘口，不管升水或掉水。 |
| 反向关系 | 让球：主队 ↔ 客队；大小球：大 ↔ 小。 |
| 第一阶段执行 | 只做 dry-run 复核，真实 `FT_bet` 不进入本计划。 |

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/crown/app/app-db.mjs` | Modify | `betting_rules` 增加 `bet_direction_mode`，默认 `auto`。 |
| `src/crown/app/app-validation.mjs` | Modify | 校验 `betDirectionMode` 只能是 `auto/follow/reverse`。 |
| `src/crown/app/app-repository.mjs` | Modify | 保存、更新、读取下注规则方向模式。 |
| `tests/crown-app-db.test.mjs` | Modify | 覆盖新数据库字段。 |
| `tests/crown-app-repository.test.mjs` | Modify | 覆盖下注规则方向模式保存。 |
| `frontend/src/pages/BettingRules.tsx` | Modify | 在下注规则卡片和弹窗中显示/编辑“投注赔率下限”和“投注方向”。 |
| `frontend/src/App.contract.test.tsx` | Modify | 覆盖规则页显示赔率下限和方向模式。 |
| `frontend/src/types.ts` | Modify | `BettingRule` 增加 `betDirectionMode`。 |
| `scripts/crown-bet-bootstrap.mjs` | Modify | 把默认 dry-run 规则名和账号名改成中文，减少界面残留英文测试数据。 |
| `tests/crown-bet-bootstrap.test.mjs` | Modify | 覆盖中文默认数据。 |
| `src/crown/storage/jsonl-store.mjs` | Modify | 暴露按 event/market/period/side 查找最新盘口快照的方法，用于升水反打查反向盘口。 |
| `tests/crown-jsonl-store.test.mjs` | Modify | 覆盖反向盘口快照查找。 |
| `src/crown/betting/monitor-bet-signal.mjs` | Create | 把已报警变化转换为投注候选，检查投注赔率下限，并按规则方向模式决定顺打/反打。 |
| `tests/crown-monitor-bet-signal.test.mjs` | Create | 覆盖自动升水反打、自动掉水顺打、强制顺打、强制反打、赔率低于下限、未报警不生成候选。 |
| `scripts/crown-watch.mjs` | Modify | 报警命中后写 `data/runtime/betting-candidates.jsonl`，不执行下注。 |
| `tests/crown-watch-fixture.test.mjs` | Modify | 覆盖 watcher 只写候选、不调用投注执行。 |
| `scripts/crown-betting-candidate-dry-run.mjs` | Create | 独立消费投注候选并调用 `CrownBetAdapter` dry-run。 |
| `tests/crown-betting-candidate-dry-run.test.mjs` | Create | 覆盖候选 dry-run 只发送 `FT_order_view`、写审计和历史。 |
| `package.json` | Modify | 增加 `crown:betting:candidate-dry-run` 命令。 |
| `docs/project-memory.md` | Modify | 记录新投注候选链路和验证结果。 |
| `docs/modules/crown-betting-protocol.md` | Modify | 更新投注执行模块状态。 |

---

### Task 1: 下注规则增加“投注赔率下限”和“投注方向”

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `tests/crown-app-db.test.mjs`
- Modify: `tests/crown-app-repository.test.mjs`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/BettingRules.tsx`
- Modify: `frontend/src/App.contract.test.tsx`

- [ ] **Step 1: 修改前端契约测试**

先在 `tests/crown-app-db.test.mjs` 增加 `bet_direction_mode` 字段断言；在 `tests/crown-app-repository.test.mjs` 的下注规则测试中增加：

```js
betDirectionMode: 'reverse',
```

并断言：

```js
assert.equal(created.betDirectionMode, 'reverse')
```

在 `frontend/src/App.contract.test.tsx` 的 `betting rules page renders simplified horizontal rule cards` 测试里，把 mock 规则加上 `minOdds: 0.72` 和 `betDirectionMode: 'reverse'`，并把旧的“不显示最低赔率”断言改成显示“投注赔率下限”和“投注方向”：

```ts
bettingRules: [{
  id: 'brule_1',
  name: '单账号额度规则',
  perAccountBetAmount: 50,
  perAccountDailyLimit: 500,
  minOdds: 0.72,
  betDirectionMode: 'reverse',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
}],
```

```ts
expect(screen.getByText('投注赔率下限')).toBeInTheDocument()
expect(screen.getByText('0.72')).toBeInTheDocument()
expect(screen.getByText('投注方向')).toBeInTheDocument()
expect(screen.getByText('反打')).toBeInTheDocument()
expect(screen.queryByText('盘口')).not.toBeInTheDocument()
expect(screen.queryByText('预览模式')).not.toBeInTheDocument()
```

- [ ] **Step 2: 跑前端测试确认失败**

Run:

```powershell
node --test tests\crown-app-db.test.mjs tests\crown-app-repository.test.mjs
npm --prefix frontend run test -- App.contract
```

Expected: fails because DB/repository/UI 还没有方向模式字段。

- [ ] **Step 3: 修改 `BettingRules.tsx` 表单和卡片**

把 `RuleFormValues` 改成：

```ts
interface RuleFormValues {
  name: string
  perAccountBetAmount: number
  perAccountDailyLimit: number
  minOdds: number
  betDirectionMode: 'auto' | 'follow' | 'reverse'
}
```

增加 helper：

```ts
function ruleMinOdds(rule: BettingRule) {
  return Number(rule.minOdds ?? 0)
}

const directionLabels = {
  auto: '自动',
  follow: '顺打',
  reverse: '反打',
} as const
```

编辑时带入：

```ts
form.setFieldsValue({
  name: rule.name,
  perAccountBetAmount: ruleBetAmount(rule),
  perAccountDailyLimit: ruleDailyLimit(rule),
  minOdds: ruleMinOdds(rule),
  betDirectionMode: rule.betDirectionMode || 'auto',
})
```

保存时提交：

```ts
const payload = {
  name: values.name.trim(),
  perAccountBetAmount: Number(values.perAccountBetAmount),
  perAccountDailyLimit: Number(values.perAccountDailyLimit),
  minOdds: Number(values.minOdds),
  betDirectionMode: values.betDirectionMode || 'auto',
}
```

卡片展示新增一项：

```tsx
<div className="config-metric">
  <span>投注赔率下限</span>
  <strong>{ruleMinOdds(rule).toFixed(2)}</strong>
</div>
<div className="config-metric">
  <span>投注方向</span>
  <strong>{directionLabels[rule.betDirectionMode || 'auto']}</strong>
</div>
```

弹窗新增表单项：

```tsx
<Form.Item
  name="minOdds"
  label="投注赔率下限"
  rules={[
    { required: true, message: '请输入投注赔率下限' },
    { type: 'number', min: 0, message: '投注赔率下限不能小于 0' },
  ]}
>
  <InputNumber min={0} precision={2} step={0.01} style={{ width: '100%' }} />
</Form.Item>
<Form.Item name="betDirectionMode" label="投注方向" initialValue="auto">
  <Select
    options={[
      { value: 'auto', label: '自动：升水反打，掉水顺打' },
      { value: 'follow', label: '顺打：下当前盘口' },
      { value: 'reverse', label: '反打：下反向盘口' },
    ]}
  />
</Form.Item>
```

后端同步：

- `app-db.mjs` 给 `betting_rules` 增加 `bet_direction_mode TEXT NOT NULL DEFAULT 'auto'` 和 migration。
- `app-validation.mjs` 在 `normalizeBettingRule()` 中加入 `betDirectionMode = enumField(body, 'betDirectionMode', ['auto', 'follow', 'reverse'], 'auto')`。
- `app-repository.mjs` 在 map/create/update 中读写 `bet_direction_mode`。
- `frontend/src/types.ts` 给 `BettingRule` 增加 `betDirectionMode?: 'auto' | 'follow' | 'reverse'`。

- [ ] **Step 4: 验证前端测试通过**

Run:

```powershell
node --test tests\crown-app-db.test.mjs tests\crown-app-repository.test.mjs
npm --prefix frontend run test -- App.contract
```

Expected: DB、repository、`App.contract` 通过。

---

### Task 2: 中文化 bootstrap 默认规则和账号名

**Files:**
- Modify: `scripts/crown-bet-bootstrap.mjs`
- Modify: `tests/crown-bet-bootstrap.test.mjs`

- [ ] **Step 1: 修改测试断言**

在 `tests/crown-bet-bootstrap.test.mjs` 的第一个测试里，读取 `accounts[0]` 和 `rules[0]` 后新增：

```js
assert.equal(accounts[0].username, '手动预览账号')
assert.equal(rules[0].name, '手动预览规则')
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```powershell
node --test tests\crown-bet-bootstrap.test.mjs
```

Expected: fails because bootstrap 仍使用英文默认值。

- [ ] **Step 3: 修改 bootstrap 默认值**

在 `scripts/crown-bet-bootstrap.mjs` 中把默认账号和规则改为中文：

```js
const DEFAULT_ACCOUNT_USERNAME = '手动预览账号'
const DEFAULT_RULE_NAME = '手动预览规则'
```

如果文件当前没有常量，就在创建账号和规则的位置直接使用以上中文值；保留 id 由数据库生成，不要硬编码。

- [ ] **Step 4: 验证测试通过**

Run:

```powershell
node --test tests\crown-bet-bootstrap.test.mjs
```

Expected: all tests pass。

---

### Task 3: 给 JSONL Store 增加最新盘口查找能力

**Files:**
- Modify: `src/crown/storage/jsonl-store.mjs`
- Modify: `tests/crown-jsonl-store.test.mjs`

- [ ] **Step 1: 写反向盘口查找测试**

在 `tests/crown-jsonl-store.test.mjs` 末尾新增：

```js
test('finds latest selection snapshot by event, market, period, and side', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-jsonl-store-latest-selection-'))
  const store = new JsonlOddsStore({
    snapshotsPath: path.join(dir, 'snapshots.jsonl'),
    changesPath: path.join(dir, 'changes.jsonl'),
  })

  store.ingest([
    record('0.94', { selection: { side: 'home', selectionId: 'home-1', selectionKey: 'home-1' } }),
    record('0.88', { selection: { side: 'away', selectionId: 'away-1', selectionKey: 'away-1' } }),
  ])

  const away = store.findLatestSelection({
    provider: 'crown',
    eventKey: 'crown|gid=event-1|gidm=gm-1|hgid=hg-1|ecid=ec-1|lid=lid-1',
    period: 'full_time',
    marketType: 'asian_handicap',
    side: 'away',
  })

  assert.equal(away.selection.side, 'away')
  assert.equal(away.selection.oddsRaw, '0.88')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```powershell
node --test tests\crown-jsonl-store.test.mjs
```

Expected: fails because `findLatestSelection` is missing。

- [ ] **Step 3: 实现 `findLatestSelection()`**

在 `src/crown/storage/jsonl-store.mjs` 中导出 identity key helper：

```js
export function stableSelectionIdentityKeyFromParts({ provider = 'unknown', eventKey = 'unknown-event', period = 'unknown-period', marketType = 'unknown-market-type', side = 'unknown-side' } = {}) {
  return [
    provider || 'unknown',
    eventKey || 'unknown-event',
    period || 'unknown-period',
    marketType || 'unknown-market-type',
    side || 'unknown-side',
  ].join('|')
}
```

把内部 `stableSelectionIdentityKey(record)` 改为复用它：

```js
function stableSelectionIdentityKey(record) {
  return stableSelectionIdentityKeyFromParts({
    provider: record?.provider || 'unknown',
    eventKey: stableEventKey(record),
    period: clean(record?.market?.period, 'unknown-period'),
    marketType: clean(record?.market?.marketType, 'unknown-market-type'),
    side: clean(record?.selection?.side, 'unknown-side'),
  })
}
```

在 `JsonlOddsStore` class 内增加：

```js
findLatestSelection({ provider = 'crown', eventKey, period, marketType, side } = {}) {
  const key = stableSelectionIdentityKeyFromParts({ provider, eventKey, period, marketType, side })
  return this.latestByIdentity.get(key) || null
}
```

- [ ] **Step 4: 验证 store 测试通过**

Run:

```powershell
node --test tests\crown-jsonl-store.test.mjs
```

Expected: all tests pass。

---

### Task 4: 新增监控投注候选生成器

**Files:**
- Create: `src/crown/betting/monitor-bet-signal.mjs`
- Create: `tests/crown-monitor-bet-signal.test.mjs`

- [ ] **Step 1: 写候选生成测试**

Create `tests/crown-monitor-bet-signal.test.mjs`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMonitorBetCandidate, oppositeSide } from '../src/crown/betting/monitor-bet-signal.mjs'

function snapshot(side, oddsRaw = '0.80') {
  return {
    odds: { raw: oddsRaw, value: Number(oddsRaw), field: side === 'home' ? 'IOR_REH' : 'IOR_REC' },
    handicap: { raw: '0', value: 0, field: 'RATIO_RE' },
    event: {
      eventId: '8878931',
      eventKey: 'crown|gid=8878931',
      league: '美国足球冠军联赛',
      homeTeam: '主队',
      awayTeam: '客队',
      ids: { gid: '8878931' },
    },
    market: {
      marketId: 'm1',
      marketKey: 'm1',
      marketType: 'asian_handicap',
      period: 'full_time',
      handicapRaw: '0',
      ratioField: 'RATIO_RE',
    },
    selection: {
      selectionId: `${side}-1`,
      selectionKey: `${side}-1`,
      side,
      oddsRaw,
      odds: Number(oddsRaw),
      oddsField: side === 'home' ? 'IOR_REH' : 'IOR_REC',
      suspended: false,
    },
    mode: 'prematch',
    capturedAt: '2026-07-09T06:00:00.000Z',
  }
}

function change(direction = 'up') {
  return {
    type: 'odds-change',
    key: 'change-1',
    capturedAt: '2026-07-09T06:00:00.000Z',
    old: snapshot('home', direction === 'up' ? '0.80' : '0.90'),
    next: snapshot('home', direction === 'up' ? '0.90' : '0.80'),
    event: snapshot('home').event,
    market: snapshot('home').market,
    selection: snapshot('home').selection,
  }
}

test('opposite side is deterministic for supported markets', () => {
  assert.equal(oppositeSide('home'), 'away')
  assert.equal(oppositeSide('away'), 'home')
  assert.equal(oppositeSide('over'), 'under')
  assert.equal(oppositeSide('under'), 'over')
  assert.equal(oppositeSide('draw'), null)
})

test('odds up creates reverse-side candidate', () => {
  const candidate = buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up', monitorMode: 'handicap', delta: 0.1 },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.82') : null,
  })
  assert.equal(candidate.status, 'eligible')
  assert.equal(candidate.action, 'reverse')
  assert.equal(candidate.target.selection.side, 'away')
  assert.equal(candidate.reason, 'monitor-up-reverse')
})

test('odds down creates same-side candidate', () => {
  const candidate = buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down', monitorMode: 'handicap', delta: 0.1 },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
  })
  assert.equal(candidate.status, 'eligible')
  assert.equal(candidate.action, 'follow')
  assert.equal(candidate.target.selection.side, 'home')
  assert.equal(candidate.reason, 'monitor-down-follow')
})

test('candidate is skipped when monitor did not trigger or odds is below betting lower limit', () => {
  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: false },
    bettingRule: { id: 'brule_1', minOdds: 0.75 },
  }).skipReason, 'monitor-not-triggered')

  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down' },
    bettingRule: { id: 'brule_1', minOdds: 0.85 },
  }).skipReason, 'betting-odds-below-min')
})

test('betting rule can force follow or reverse direction', () => {
  assert.equal(buildMonitorBetCandidate(change('up'), {
    monitorDecision: { triggered: true, direction: 'up' },
    bettingRule: { id: 'brule_1', minOdds: 0.75, betDirectionMode: 'follow' },
  }).action, 'follow')

  assert.equal(buildMonitorBetCandidate(change('down'), {
    monitorDecision: { triggered: true, direction: 'down' },
    bettingRule: { id: 'brule_1', minOdds: 0.75, betDirectionMode: 'reverse' },
    findLatestSelection: ({ side }) => side === 'away' ? snapshot('away', '0.82') : null,
  }).action, 'reverse')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:

```powershell
node --test tests\crown-monitor-bet-signal.test.mjs
```

Expected: fails because module is missing。

- [ ] **Step 3: 实现候选生成器**

Create `src/crown/betting/monitor-bet-signal.mjs`:

```js
import crypto from 'node:crypto'

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function targetOdds(snapshot) {
  return numberOrNull(snapshot?.selection?.odds ?? snapshot?.odds?.value ?? snapshot?.selection?.oddsRaw ?? snapshot?.odds?.raw)
}

function eventKeyOf(change) {
  return change?.event?.eventKey || change?.next?.event?.eventKey || change?.old?.event?.eventKey || change?.event?.eventId || ''
}

function marketOf(change) {
  return change?.market || change?.next?.market || {}
}

export function oppositeSide(side) {
  if (side === 'home') return 'away'
  if (side === 'away') return 'home'
  if (side === 'over') return 'under'
  if (side === 'under') return 'over'
  return null
}

function skipped(change, reason, extra = {}) {
  return {
    candidateId: `bcand_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    status: 'skipped',
    skipReason: reason,
    source: 'monitor-alert',
    changeKey: change?.key || '',
    ...extra,
  }
}

export function buildMonitorBetCandidate(change, { monitorDecision = {}, bettingRule = null, findLatestSelection = null } = {}) {
  if (!monitorDecision.triggered) return skipped(change, 'monitor-not-triggered')
  if (!bettingRule?.id) return skipped(change, 'betting-rule-missing')

  const sourceSnapshot = change?.next
  const sourceSide = sourceSnapshot?.selection?.side || change?.selection?.side || ''
  const market = marketOf(change)
  const mode = ['auto', 'follow', 'reverse'].includes(bettingRule.betDirectionMode) ? bettingRule.betDirectionMode : 'auto'
  const shouldReverse = mode === 'reverse' || (mode === 'auto' && monitorDecision.direction === 'up')
  const shouldFollow = mode === 'follow' || (mode === 'auto' && monitorDecision.direction === 'down')
  let action = shouldReverse ? 'reverse' : 'follow'
  let reason = shouldReverse ? 'rule-reverse' : 'rule-follow'
  let target = sourceSnapshot

  if (mode === 'auto' && monitorDecision.direction === 'up') reason = 'monitor-up-reverse'
  if (mode === 'auto' && monitorDecision.direction === 'down') reason = 'monitor-down-follow'
  if (!shouldReverse && !shouldFollow) return skipped(change, 'unsupported-direction', { direction: monitorDecision.direction })

  if (shouldReverse) {
    const targetSide = oppositeSide(sourceSide)
    if (!targetSide) return skipped(change, 'opposite-side-unsupported', { sourceSide })
    action = 'reverse'
    reason = 'monitor-up-reverse'
    target = typeof findLatestSelection === 'function'
      ? findLatestSelection({
        provider: 'crown',
        eventKey: eventKeyOf(change),
        period: market.period,
        marketType: market.marketType,
        side: targetSide,
      })
      : null
    if (!target) return skipped(change, 'opposite-selection-not-found', { sourceSide, targetSide })
  }

  const odds = targetOdds(target)
  const minOdds = numberOrNull(bettingRule.minOdds) ?? 0
  if (odds === null) return skipped(change, 'target-odds-missing', { action, reason })
  if (minOdds > 0 && odds < minOdds) return skipped(change, 'betting-odds-below-min', { action, reason, odds, minOdds })

  return {
    candidateId: `bcand_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    status: 'eligible',
    source: 'monitor-alert',
    action,
    reason,
    betDirectionMode: mode,
    changeKey: change?.key || '',
    monitor: {
      mode: monitorDecision.monitorMode || '',
      direction: monitorDecision.direction || '',
      delta: monitorDecision.delta ?? null,
    },
    bettingRuleId: bettingRule.id,
    minOdds,
    odds,
    event: target.event || change?.event || null,
    market: target.market || market,
    sourceSelection: sourceSnapshot?.selection || change?.selection || null,
    target,
  }
}
```

- [ ] **Step 4: 验证候选生成测试通过**

Run:

```powershell
node --test tests\crown-monitor-bet-signal.test.mjs
```

Expected: all tests pass。

---

### Task 5: 监控命中后写投注候选 JSONL

**Files:**
- Modify: `scripts/crown-watch.mjs`
- Modify: `tests/crown-watch-fixture.test.mjs`

- [ ] **Step 1: 增加 watcher 测试断言**

在 `tests/crown-watch-fixture.test.mjs` 使用已有 fixture watcher 测试模式，增加一个临时 `betting-candidates.jsonl` 路径，并断言：

```js
assert.equal(fs.existsSync(bettingCandidatesPath), true)
const candidateLines = fs.readFileSync(bettingCandidatesPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
assert.equal(candidateLines.every((line) => {
  const item = JSON.parse(line)
  return item.source === 'monitor-alert' && !JSON.stringify(item).includes('FT_bet')
}), true)
```

如果该 fixture 没有报警命中，则新增一个专门测试，构造 `notifyChanges` 可触发的变化并检查候选文件。不要让测试调用 `CrownBetAdapter`。

- [ ] **Step 2: 跑 watcher 测试确认失败**

Run:

```powershell
node --test tests\crown-watch-fixture.test.mjs
```

Expected: fails because watcher 还没有候选输出。

- [ ] **Step 3: 增加候选输出参数**

在 `parseArgs()` 默认值里增加：

```js
bettingCandidatesPath: path.join('data/runtime', 'betting-candidates.jsonl'),
```

在 help text 里增加：

```text
  --betting-candidates <file>
                            Monitor-triggered betting candidates JSONL
```

在参数解析里增加：

```js
else if (current === '--betting-candidates') args.bettingCandidatesPath = next()
```

- [ ] **Step 4: 加载启用中的投注规则**

复用已有 `withAppRepository()`，新增：

```js
function loadRuntimeBettingRule(args) {
  if (!args?.appDbPath) return null
  try {
    return withAppRepository(args.appDbPath, (repo) => repo.listBettingRules().find((rule) => rule.enabled) || null)
  } catch (error) {
    console.warn(`betting rule unavailable: ${errorMessage(error)}`)
    return null
  }
}
```

- [ ] **Step 5: 在 `notifyChanges()` 中生成候选**

导入：

```js
import { buildMonitorBetCandidate } from '../src/crown/betting/monitor-bet-signal.mjs'
```

给 `notifyChanges()` 参数增加 `store`、`bettingRule`、`bettingCandidatesPath`。

在 `decision.triggered` 后、发送 TG 前写候选：

```js
if (bettingCandidatesPath) {
  const candidate = buildMonitorBetCandidate(change, {
    monitorDecision: decision,
    bettingRule,
    findLatestSelection: (query) => store?.findLatestSelection(query),
  })
  appendJsonl(bettingCandidatesPath, [candidate])
}
```

这里的 `appendJsonl` 可以复用 watcher 文件里的本地 JSONL append helper；如果没有可复用 helper，就新增一个只写本地 runtime JSONL 的小函数。不要在 watcher 中导入 `CrownBetAdapter`。

- [ ] **Step 6: 从 `normalizeAndStore()` 传入 store 和规则**

调用 `notifyChanges()` 时传入：

```js
await notifyChanges(result.changes, {
  alertsConfig,
  monitorSettings,
  defaultLeagues,
  trackedMatches,
  telegramSettings,
  onAlert,
  store,
  bettingRule,
  bettingCandidatesPath,
}, stats)
```

在实时循环加载配置时，给 `normalizeAndStore()` 补：

```js
bettingRule: loadRuntimeBettingRule(configState.args),
bettingCandidatesPath: configState.args.bettingCandidatesPath,
```

- [ ] **Step 7: 验证 watcher 测试通过**

Run:

```powershell
node --test tests\crown-watch-fixture.test.mjs
```

Expected: all tests pass，候选 JSONL 不包含 `FT_bet`。

---

### Task 6: 独立 CLI 消费投注候选并执行 dry-run

**Files:**
- Create: `scripts/crown-betting-candidate-dry-run.mjs`
- Create: `tests/crown-betting-candidate-dry-run.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写 CLI 测试**

Create `tests/crown-betting-candidate-dry-run.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { executeCandidateDryRun, parseArgs } from '../scripts/crown-betting-candidate-dry-run.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crown-candidate-dry-run-'))
}

test('candidate dry-run sends preview only and writes history', async () => {
  const dir = tempDir()
  const dbPath = path.join(dir, 'crown.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  const sessionDir = path.join(runtimeDir, 'crown-sessions', 'mon_primary')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'api-session.json'), JSON.stringify({
    uid: 'session-uid',
    baseUrl: 'https://example.test',
    cookies: {},
  }), 'utf8')

  const handle = openAppDatabase({ dbPath })
  const repo = createAppRepository(handle.db, { secretKey: 'test-secret-key-with-more-than-32-characters' })
  const account = repo.createBettingAccount({ username: '候选预览账号', status: 'enabled' })
  const rule = repo.createBettingRule({
    name: '候选预览规则',
    enabled: true,
    previewOnly: true,
    perAccountBetAmount: 50,
    perAccountDailyLimit: 500,
    minOdds: 0.5,
    maxOdds: 2,
  })
  handle.close()

  const candidatesFile = path.join(runtimeDir, 'betting-candidates.jsonl')
  fs.writeFileSync(candidatesFile, `${JSON.stringify({
    candidateId: 'bcand_1',
    status: 'eligible',
    action: 'follow',
    reason: 'monitor-down-follow',
    bettingRuleId: rule.id,
    target: {
      event: { eventId: '8878931', eventKey: 'crown|gid=8878931', league: 'Fixture', homeTeam: 'A', awayTeam: 'B' },
      market: { marketType: 'asian_handicap', period: 'full_time', handicapRaw: '0', ratioField: 'RATIO_RE' },
      selection: { side: 'home', oddsRaw: '0.75', odds: 0.75, oddsField: 'IOR_REH' },
    },
  })}\n`, 'utf8')

  const calls = []
  const result = await executeCandidateDryRun(parseArgs([
    '--candidates-file', candidatesFile,
    '--candidate-id', 'bcand_1',
    '--db-path', dbPath,
    '--runtime-dir', runtimeDir,
    '--account-id', account.id,
    '--stake', '50',
  ]), {
    fetchImpl: async (url, options) => {
      const body = Object.fromEntries(new URLSearchParams(options.body))
      calls.push(body)
      return new Response('<serverresponse><code>560</code><gold_gmin>10</gold_gmin><gold_gmax>500</gold_gmax><ioratio>0.75</ioratio><spread>0</spread><strong>H</strong></serverresponse>')
    },
  })

  assert.equal(result.status, 'previewed')
  assert.deepEqual(calls.map((call) => call.p), ['FT_order_view'])

  const verify = openAppDatabase({ dbPath })
  const rows = createAppRepository(verify.db, { secretKey: 'test-secret-key-with-more-than-32-characters' }).listBettingHistory()
  verify.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'previewed')
})
```

- [ ] **Step 2: 跑 CLI 测试确认失败**

Run:

```powershell
node --test tests\crown-betting-candidate-dry-run.test.mjs
```

Expected: fails because script is missing。

- [ ] **Step 3: 实现 CLI**

Create `scripts/crown-betting-candidate-dry-run.mjs`，复用 `scripts/crown-bet-execute.mjs` 的安全思路，但输入是 candidate：

```js
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { appendBetAudit } from '../src/betting/audit-log.mjs'
import { normalizeBetIntent } from '../src/betting/bet-intent.mjs'
import { openAppDatabase, defaultDbPath } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'
import { redactBody } from '../src/crown/betting-protocol/capture-redaction.mjs'
import { CrownBetAdapter } from '../src/crown/betting/crown-bet-adapter.mjs'
import { buildCrownOrderFields } from '../src/crown/betting/crown-order-field-mapper.mjs'

const DEFAULT_RUNTIME_DIR = 'data/runtime'
const DEFAULT_AUDIT_FILE = 'data/runtime/betting-execution-audit.jsonl'

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

function readSession(runtimeDir) {
  const file = path.resolve(runtimeDir, 'crown-sessions', 'mon_primary', 'api-session.json')
  const session = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!session?.uid || !session?.baseUrl) throw new Error('crown-session-invalid')
  return session
}

function optionValue(argv, index, name) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name.replace(/^--/, '')}-value-required`)
  return value
}

export function parseArgs(argv = []) {
  const args = { runtimeDir: DEFAULT_RUNTIME_DIR, auditFile: DEFAULT_AUDIT_FILE }
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]
    if (current === '--candidates-file') args.candidatesFile = optionValue(argv, i++, current)
    else if (current === '--candidate-id') args.candidateId = optionValue(argv, i++, current)
    else if (current === '--db-path' || current === '--app-db') args.dbPath = optionValue(argv, i++, current)
    else if (current === '--runtime-dir') args.runtimeDir = optionValue(argv, i++, current)
    else if (current === '--account-id') args.accountId = optionValue(argv, i++, current)
    else if (current === '--stake') args.stake = Number(optionValue(argv, i++, current))
    else if (current === '--audit-file') args.auditFile = optionValue(argv, i++, current)
    else throw new Error(`unknown-argument:${current}`)
  }
  return args
}

export async function executeCandidateDryRun(args = {}, deps = {}) {
  if (!args.candidatesFile) throw new Error('candidates-file-required')
  if (!args.candidateId) throw new Error('candidate-id-required')
  if (!args.accountId) throw new Error('account-id-required')
  const candidate = readJsonl(path.resolve(args.candidatesFile)).find((item) => item.candidateId === args.candidateId)
  if (!candidate) throw new Error('candidate-not-found')
  if (candidate.status !== 'eligible') throw new Error(`candidate-not-eligible:${candidate.skipReason || candidate.status}`)

  const stake = Number(args.stake || candidate.target?.decision?.maxStakeHint || 0)
  if (!Number.isFinite(stake) || stake <= 0) throw new Error('invalid-stake')

  const dbPath = path.resolve(args.dbPath || defaultDbPath(deps.env || process.env))
  const handle = openAppDatabase({ dbPath })
  try {
    const repo = createAppRepository(handle.db, { env: deps.env || process.env })
    const account = repo.listBettingAccounts().find((item) => item.id === args.accountId)
    if (!account) throw new Error('betting-account-not-found')
    const rule = repo.listBettingRules().find((item) => item.id === candidate.bettingRuleId)
    if (!rule) throw new Error('betting-rule-not-found')
    const target = candidate.target
    const intent = normalizeBetIntent({
      provider: 'crown',
      sport: 'football',
      event: target.event,
      market: target.market,
      selection: target.selection,
      decision: { reason: candidate.reason, confidence: 'medium', maxStakeHint: stake },
      source: { snapshotFile: '', changeFile: args.candidatesFile, endpointKey: 'monitor-alert' },
    })
    const orderFields = buildCrownOrderFields({
      event: { ...intent.event, ids: { gid: intent.event.eventId } },
      market: intent.market,
      selection: intent.selection,
      stake,
    })
    const adapter = new CrownBetAdapter({
      session: readSession(path.resolve(args.runtimeDir || DEFAULT_RUNTIME_DIR)),
      fetchImpl: deps.fetchImpl || globalThis.fetch,
      audit: (row) => appendBetAudit(path.resolve(args.auditFile || DEFAULT_AUDIT_FILE), row),
      history: repo,
    })
    return redactBody(await adapter.execute({ mode: 'dry-run', orderFields, intent, account, rule, stake }))
  } finally {
    handle.close()
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const result = await executeCandidateDryRun(parseArgs(argv), deps)
  console.log(JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: String(error?.message || error) }))
    process.exitCode = 1
  })
}
```

- [ ] **Step 4: 增加 package 命令**

In `package.json` scripts:

```json
"crown:betting:candidate-dry-run": "node scripts/crown-betting-candidate-dry-run.mjs"
```

- [ ] **Step 5: 验证 CLI 测试通过**

Run:

```powershell
node --test tests\crown-betting-candidate-dry-run.test.mjs
```

Expected: all tests pass。

---

### Task 7: 文档和项目记忆同步

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/modules/crown-betting-protocol.md`

- [ ] **Step 1: 更新项目记忆**

在 `docs/project-memory.md` 顶部新增条目：

```markdown
## 2026-07-09 监控报警触发投注候选 dry-run 计划

- 投注候选只来自现有监控报警标准：`evaluateMonitorChange()` 返回 `triggered=true` 后才进入候选生成，不新增单独的快速升水/掉水时间窗口。
- 候选生成先检查下注规则里的 `minOdds`，中文 UI 显示为“投注赔率下限”；低于下限写 skipped 候选，不执行 dry-run。
- 投注方向规则：当前盘口升水下反向盘口；当前盘口掉水下当前盘口。让球反向为主队/客队互换，大小球反向为大/小互换。
- watcher 只写 `data/runtime/betting-candidates.jsonl`，不导入 `CrownBetAdapter`，不发送 `FT_order_view` 或 `FT_bet`。
- dry-run 由独立 `npm run crown:betting:candidate-dry-run` 消费候选并写入脱敏 audit 和 SQLite `betting_history`。
```

- [ ] **Step 2: 更新模块文档**

在 `docs/modules/crown-betting-protocol.md` 当前状态中补充：

```markdown
- 监控报警触发投注的第一阶段只生成投注候选并由独立 CLI dry-run；真实下注仍必须用户在场并另走受控真实提交验收。
```

- [ ] **Step 3: 检查文档没有敏感信息**

Run:

```powershell
rg -n "uid|cookie|token|password|ticket_id|authorization|set-cookie" docs\project-memory.md docs\modules\crown-betting-protocol.md
```

Expected: no sensitive runtime values；只允许出现通用字段名说明。

---

## Verification Commands

Run after implementation:

```powershell
node --test tests\crown-monitor-bet-signal.test.mjs
node --test tests\crown-jsonl-store.test.mjs
node --test tests\crown-watch-fixture.test.mjs
node --test tests\crown-betting-candidate-dry-run.test.mjs
node --test tests\crown-bet-bootstrap.test.mjs tests\crown-bet-adapter.test.mjs tests\crown-bet-execute-cli.test.mjs tests\betting-risk-guard.test.mjs
npm --prefix frontend run test
npm run check
npm test
```

Expected:

- 候选生成测试通过。
- Watcher 只写候选，不发下注请求。
- Candidate dry-run 只发送 `FT_order_view`。
- 风控继续拦截低于 `minOdds` 的投注。
- 前端显示“投注赔率下限”。
- 全量测试和语法检查通过。

## Completion Criteria

| 项目 | 标准 |
|---|---|
| 报警入口 | 只有 `evaluateMonitorChange()` 命中的变化会写投注候选。 |
| 赔率下限 | 候选用下注规则 `minOdds` 检查目标投注盘口赔率，低于下限不执行 dry-run。 |
| 方向转换 | 升水写反向候选，掉水写当前盘口候选。 |
| 监控边界 | `scripts/crown-watch.mjs` 不导入 `CrownBetAdapter`，不发送 `FT_order_view` / `FT_bet`。 |
| Dry-run | 独立 CLI 消费候选，只发 `FT_order_view`，写审计和投注历史。 |
| 中文化 | 规则页展示“投注赔率下限”，bootstrap 默认账号/规则名为中文。 |
| 验证 | 相关目标测试、前端测试、`npm run check`、`npm test` 全部通过。 |

## Self-Review

- Spec coverage: 覆盖了本次对话确认的监控报警入口、投注赔率下限、升水反打、掉水顺打、中文化和 dry-run 复核。
- Scope control: 未把真实下注放进本计划，未在 watcher 中引入投注执行适配器。
- Placeholder scan: 本计划没有占位内容、空泛“补测试”步骤。
- Type consistency: 候选字段统一使用 `candidateId`、`status`、`action`、`reason`、`target`、`bettingRuleId`；dry-run CLI 只消费 `status='eligible'` 的候选。
