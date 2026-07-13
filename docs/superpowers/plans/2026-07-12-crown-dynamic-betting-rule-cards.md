# 皇冠动态投注规则卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把固定赛前/滚球投注配置替换为联赛独占的动态投注规则卡片，并修复 Dashboard 新旧契约混跑和监控配置无法完成迁移复核的问题。

**Architecture:** 监控报警继续按 prematch/live 产生事实 Signal；新的 card + league ownership 表只负责投注范围、赔率和金额。Signal 按今日联赛与唯一 ownership 最多匹配一张卡片，生成不可变 card snapshot，执行链继续复用现有 B2 账号、授权、锁、恢复和对账模块。

**Tech Stack:** Node.js 22、`node:sqlite`、ES modules、React 18、TypeScript、Vite、Ant Design 5、Node test runner、Vitest、Playwright CLI。

## Global Constraints

- 投注卡片不保存或选择 `prematch/live`；实际 mode 只来自 Signal，并继续进入批次和安全 scope。
- 名称、至少一个联赛、目标赔率上下限、positive safe-integer CNY 金额在每次 POST/PUT 时全部必填，停用卡片也不允许残缺。
- 今日联赛使用 Asia/Shanghai 日期；默认白名单今日命中与今日手动追踪联赛可选，手动联赛仍必须显式勾选。
- `auto_betting_rule_card_leagues.league_name` 全局唯一；停用卡片占用，物理删除释放。
- 一个 Signal 最多匹配一张卡片；同一卡片同 exact market line/target side 最多投注一次。
- `down` 只报警，其他非 `up` fail-closed；不得放宽账号、授权、lease、fence、capability 或 `rejected/unknown` 边界。
- 旧固定两行只迁移为停用、真实资格关闭、待复核卡片；不猜联赛，不自动开启真实投注。
- 真实 Crown capability 保持 preview/submit/reconciliation `0/0/0`；测试只用 temp SQLite、fake provider 和本地 Dashboard。
- 不访问或改写正式 `storage/crown.sqlite`，不发送 Crown/TG 网络请求，不 stage/commit Git；正式库迁移与进程重启放在代码验收完成后的单独运维步骤。

---

### Task 1: 动态卡片 schema、历史身份和幂等迁移

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Create: `src/crown/betting/dynamic-card-migration.mjs`
- Create: `tests/crown-dynamic-betting-card-schema.test.mjs`
- Create: `tests/crown-dynamic-betting-card-migration.test.mjs`
- Modify: `tests/crown-alert-betting-settings-migration.test.mjs`

**Interfaces:**
- Produces: `migrateFixedSettingsToRuleCards(db, { now }) -> { insertedCardIds: string[] }`。
- Produces tables `auto_betting_rule_cards`, `auto_betting_rule_card_leagues`, `app_schema_meta` and card identity columns on inbox/batch/claim/authorization evidence.
- Preserves old `auto_betting_settings` as read-only migration source.

- [ ] **Step 1: Write failing schema tests**

```js
test('dynamic cards enforce card shape and globally unique league ownership', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  const cardColumns = handle.db.prepare('PRAGMA table_info(auto_betting_rule_cards)').all().map((row) => row.name)
  assert.deepEqual(cardColumns, [
    'card_id', 'name', 'enabled', 'target_odds_min', 'target_odds_max',
    'target_amount_minor', 'currency', 'amount_scale', 'remark', 'real_eligible',
    'real_eligibility_version', 'real_eligibility_updated_at',
    'migration_review_required', 'migration_review_reason', 'version', 'created_at', 'updated_at',
  ])
  insertCard(handle.db, 'card-a')
  insertCard(handle.db, 'card-b')
  handle.db.prepare("INSERT INTO auto_betting_rule_card_leagues VALUES ('card-a','英超',?)").run(NOW)
  assert.throws(() => handle.db.prepare(
    "INSERT INTO auto_betting_rule_card_leagues VALUES ('card-b','英超',?)",
  ).run(NOW), /UNIQUE constraint failed/)
  handle.close()
})
```

同时断言迁移专用 review row 可暂存 nullable odds/amount，但 `review_required=0` 的 row 必须具有完整 canonical 值；历史表中的 `card_id` 不建立阻止物理删除的外键。

- [ ] **Step 2: Run schema RED**

Run: `node --test tests/crown-dynamic-betting-card-schema.test.mjs`

Expected: FAIL with `no such table: auto_betting_rule_cards`。

- [ ] **Step 3: Add canonical schema and rebuild helpers**

```sql
CREATE TABLE IF NOT EXISTS auto_betting_rule_cards (
  card_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (trim(name) <> ''),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  target_odds_min TEXT,
  target_odds_max TEXT,
  target_amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  amount_scale INTEGER NOT NULL DEFAULT 0 CHECK (amount_scale=0),
  remark TEXT NOT NULL DEFAULT '',
  real_eligible INTEGER NOT NULL DEFAULT 0 CHECK (real_eligible IN (0,1)),
  real_eligibility_version INTEGER NOT NULL DEFAULT 1 CHECK (real_eligibility_version >= 1),
  real_eligibility_updated_at TEXT NOT NULL,
  migration_review_required INTEGER NOT NULL DEFAULT 0 CHECK (migration_review_required IN (0,1)),
  migration_review_reason TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (migration_review_required = 1 OR
    (target_odds_min IS NOT NULL AND target_odds_max IS NOT NULL AND
     typeof(target_amount_minor)='integer' AND target_amount_minor BETWEEN 1 AND 9007199254740991))
);
CREATE TABLE IF NOT EXISTS auto_betting_rule_card_leagues (
  card_id TEXT NOT NULL REFERENCES auto_betting_rule_cards(card_id) ON DELETE CASCADE,
  league_name TEXT NOT NULL UNIQUE CHECK (trim(league_name) <> ''),
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, league_name)
);
CREATE TABLE IF NOT EXISTS app_schema_meta (
  meta_key TEXT PRIMARY KEY,
  meta_value TEXT NOT NULL
);
INSERT INTO app_schema_meta(meta_key,meta_value) VALUES ('schema_contract','dynamic-betting-cards-v1')
ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value;
```

在 inbox 增加 `card_id/card_version/card_snapshot_json`；在 batch/market claim/authorization scope evidence 增加 nullable card identity，旧字段不删除。

- [ ] **Step 4: Write failing migration tests**

```js
test('fixed prematch and live rows migrate once into disabled review cards', () => {
  seedFixedSettings(db, {
    prematch: { target_odds_min: '0.80', target_odds_max: '1.05', target_amount_minor: 100 },
    live: { target_odds_min: null, target_odds_max: null, target_amount_minor: null },
  })
  migrateFixedSettingsToRuleCards(db, { now: () => NOW })
  assert.deepEqual(db.prepare(`SELECT name,enabled,real_eligible,migration_review_required
    FROM auto_betting_rule_cards ORDER BY name`).all(), [
    { name: '原滚球投注', enabled: 0, real_eligible: 0, migration_review_required: 1 },
    { name: '原赛前投注', enabled: 0, real_eligible: 0, migration_review_required: 1 },
  ])
  assert.equal(db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_card_leagues').get().count, 0)
  migrateFixedSettingsToRuleCards(db, { now: () => LATER })
  assert.equal(db.prepare('SELECT COUNT(*) count FROM auto_betting_rule_cards').get().count, 2)
})
```

- [ ] **Step 5: Implement pure idempotent migration**

```js
export function migrateFixedSettingsToRuleCards(db, { now = () => new Date().toISOString() } = {}) {
  const source = db.prepare("SELECT * FROM auto_betting_settings WHERE mode IN ('prematch','live')").all()
  const insert = db.prepare(`INSERT OR IGNORE INTO auto_betting_rule_cards (
    card_id,name,enabled,target_odds_min,target_odds_max,target_amount_minor,currency,amount_scale,
    remark,real_eligible,real_eligibility_version,real_eligibility_updated_at,
    migration_review_required,migration_review_reason,version,created_at,updated_at
  ) VALUES (?,?,0,?,?,?,'CNY',0,?,0,1,?,1,'fixed-mode-card-requires-league-review',1,?,?)`)
  const insertedCardIds = []
  for (const row of source) {
    const cardId = `migrated-fixed-${row.mode}`
    const time = now()
    const result = insert.run(cardId, row.mode === 'prematch' ? '原赛前投注' : '原滚球投注',
      row.target_odds_min, row.target_odds_max, row.target_amount_minor, row.remark || '', time, time, time)
    if (result.changes === 1) insertedCardIds.push(cardId)
  }
  return { insertedCardIds }
}
```

由 `openAppDatabase()` 现有 `BEGIN IMMEDIATE` 初始化事务调用，不能自行嵌套事务。

- [ ] **Step 6: Run Task 1 GREEN and regressions**

Run: `node --test tests/crown-dynamic-betting-card-schema.test.mjs tests/crown-dynamic-betting-card-migration.test.mjs tests/crown-alert-betting-settings-migration.test.mjs tests/crown-app-db.test.mjs`

Expected: PASS；重复打开不覆盖人工 version，不自动插入联赛，不复制 `real_eligible=true`。

- [ ] **Step 7: Review checkpoint**

检查 schema 只添加 card identity，不删除旧历史字段；记录测试数量到 `.superpowers/sdd/progress.md`，不执行 Git 操作。

### Task 2: 今日联赛目录、卡片校验和联赛独占事务

**Files:**
- Create: `src/crown/betting/today-betting-leagues.mjs`
- Create: `src/crown/betting/auto-betting-rule-card.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Create: `tests/crown-today-betting-leagues.test.mjs`
- Create: `tests/crown-auto-betting-rule-card.test.mjs`
- Create: `tests/crown-auto-betting-rule-card-repository.test.mjs`

**Interfaces:**
- Produces: `buildTodayBettingLeagues({ db, defaultLeagues, now }) -> TodayBettingLeague[]`。
- Produces: `normalizeRuleCardCreate(body, context)` and `normalizeRuleCardUpdate(body, context)`。
- Produces repository methods `listAutoBettingRuleCards`, `listTodayBettingLeagues(cardId, { defaultLeagues })`, `createAutoBettingRuleCard(payload, { defaultLeagues })`, `updateAutoBettingRuleCard(cardId, payload, { defaultLeagues })`.

- [ ] **Step 1: Write today-catalog RED tests**

```js
test('catalog contains today default hits and today manual tracking only', () => {
  seedEvent(db, { eventKey: 'today-default', league: '英超', startTimeUtc: todayUtc, mode: 'prematch' })
  seedEvent(db, { eventKey: 'today-manual', league: '友谊赛', startTimeUtc: todayUtc, mode: 'live' })
  seedEvent(db, { eventKey: 'tomorrow', league: '西甲', startTimeUtc: tomorrowUtc, mode: 'prematch' })
  seedTracked(db, { eventKey: 'today-manual', league: '友谊赛' })
  assert.deepEqual(buildTodayBettingLeagues({ db, defaultLeagues, now: () => SHANGHAI_NOON }), [
    { leagueName: '英超', source: 'default', todayMatchCount: 1 },
    { leagueName: '友谊赛', source: 'manual', todayMatchCount: 1 },
  ])
})
```

覆盖 default disabled、mode disabled、过期 tracked row、同联赛 default+manual 去重为 `both`、上海午夜边界。

- [ ] **Step 2: Run catalog RED**

Run: `node --test tests/crown-today-betting-leagues.test.mjs`

Expected: FAIL with module not found。

- [ ] **Step 3: Implement deterministic catalog**

```js
export function buildTodayBettingLeagues({ db, defaultLeagues, now = () => new Date() }) {
  const day = shanghaiDayBounds(now())
  const events = db.prepare(`SELECT event_key,event_json FROM monitor_event_state WHERE active=1`).all()
    .map(readEvent)
    .filter((event) => event.startTimeUtc >= day.startUtc && event.startTimeUtc < day.endUtc)
  const manualKeys = new Set(db.prepare(
    "SELECT event_key FROM tracked_matches WHERE tracking_status='active'",
  ).all().map((row) => row.event_key))
  return aggregateTodayLeagues(events, { defaultLeagues, manualKeys })
}
```

复用 `isDefaultLeagueMatched(event.league, event.mode, defaultLeagues)`；手动来源只通过 exact `event_key` join，不按模糊球队名猜测。

- [ ] **Step 4: Write card validation and repository RED tests**

```js
test('create requires complete values and one currently available league', () => {
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, leagueNames: [] }, context),
    (error) => error.code === 'league-required')
  assert.throws(() => normalizeRuleCardCreate({ ...validBody, leagueNames: ['昨日联赛'] }, context),
    (error) => error.code === 'league-not-available-today')
})

test('disabled cards continue to own their leagues', () => {
  const first = repo.createAutoBettingRuleCard(
    { ...validBody, enabled: false, leagueNames: ['英超'] }, { defaultLeagues })
  assert.throws(() => repo.createAutoBettingRuleCard(
    { ...validBody, name: 'B', leagueNames: ['英超'] }, { defaultLeagues }),
    (error) => error.code === 'league-owned-by-another-card')
  assert.equal(repo.listAutoBettingRuleCards().find((card) => card.cardId === first.cardId).enabled, false)
})
```

另测两个数据库连接并发抢同一联赛只有一方成功；PUT 可保留 own stale league，但不能新增 stale league；赔率使用 18 位精确 decimal TEXT。

- [ ] **Step 5: Implement canonical normalizers**

```js
export function normalizeRuleCardCreate(body, { availableLeagueNames }) {
  assertExactFields(body, ['name','enabled','leagueNames','targetOddsMin','targetOddsMax',
    'targetAmountMinor','remark'])
  return normalizeCompleteCard(body, {
    allowedNewLeagues: new Set(availableLeagueNames),
    existingLeagueNames: new Set(),
  })
}

export function normalizeRuleCardUpdate(body, { availableLeagueNames, existingLeagueNames }) {
  assertExpectedVersion(body.expectedVersion)
  return normalizeCompleteCard(body, {
    allowedNewLeagues: new Set(availableLeagueNames),
    existingLeagueNames: new Set(existingLeagueNames),
  })
}
```

`normalizeCompleteCard` 要求 trimmed name、boolean enabled、去重非空 `leagueNames`、ordered canonical decimal bounds、positive safe integer amount、string remark。

- [ ] **Step 6: Implement atomic repository CRUD**

```js
createAutoBettingRuleCard(payload, { defaultLeagues }) {
  return runImmediate(db, () => {
    const catalog = buildTodayBettingLeagues({ db, defaultLeagues, now: () => new Date(currentIso()) })
    const item = normalizeRuleCardCreate(payload, { availableLeagueNames: catalog.map((x) => x.leagueName) })
    const cardId = id('betcard')
    insertCard.run(toCardRow(cardId, item, currentIso()))
    insertCardLeagues(db, cardId, item.leagueNames, currentIso())
    return readRuleCard(db, cardId)
  })
}
```

UPDATE 在同一 `BEGIN IMMEDIATE` 内校验 CAS、删除原关联、插入新关联；捕获 SQLite UNIQUE 后读取 owner 并抛出 `{ code:'league-owned-by-another-card', fields:{ leagueNames, ownerName } }`。不得临时释放后提交失败而丢失旧 ownership，整个事务必须回滚。

- [ ] **Step 7: Run Task 2 GREEN**

Run: `node --test tests/crown-today-betting-leagues.test.mjs tests/crown-auto-betting-rule-card.test.mjs tests/crown-auto-betting-rule-card-repository.test.mjs tests/crown-app-repository.test.mjs`

Expected: PASS；两个连接并发测试稳定只有一个 owner。

- [ ] **Step 8: Review checkpoint**

审查所有联赛匹配均 exact name + exact event identity，无 alias 扩权、无空联赛保存、无停用卡片释放，记录结果但不提交 Git。

### Task 3: Card API、今日联赛 API 与安全 DTO

**Files:**
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`
- Create: `tests/crown-auto-betting-rule-card-api.test.mjs`
- Modify: `tests/crown-dashboard-security.test.mjs`
- Modify: `frontend/src/services/api.security.test.ts`

**Interfaces:**
- Produces REST endpoints from design §5.
- Produces DTO types `AutoBettingRuleCard`, `TodayBettingLeague`, `RuleCardMutation`.
- Consumes Task 2 repository methods and validation codes.

- [ ] **Step 1: Write API RED tests**

```js
test('card API exposes canonical CRUD and today ownership metadata', async () => {
  const created = await request('POST', '/api/app/auto-betting-rule-cards', validBody)
  assert.equal(created.status, 200)
  assert.deepEqual(created.payload.item.leagueNames, ['英超'])
  assert.equal('mode' in created.payload.item, false)
  const leagues = await request('GET', `/api/app/today-betting-leagues?cardId=${created.payload.item.cardId}`)
  assert.deepEqual(leagues.payload.items[0], {
    leagueName: '英超', source: 'default', todayMatchCount: 1,
    ownerCardId: created.payload.item.cardId, ownerCardName: created.payload.item.name,
    selectable: true, availableToday: true,
  })
})
```

覆盖 authentication/CSRF、unknown fields、empty leagues、foreign read-only fields、stale CAS、DELETE `{expectedVersion}`、owner conflict 不泄露 ID 之外的敏感信息。

- [ ] **Step 2: Run API RED**

Run: `node --test tests/crown-auto-betting-rule-card-api.test.mjs tests/crown-dashboard-security.test.mjs`

Expected: FAIL with 404 for the new routes。

- [ ] **Step 3: Implement routes and status mapping**

```js
if (parts.length === 1 && parts[0] === 'auto-betting-rule-cards') {
  if (method === 'GET') return ok({ items: repo.listAutoBettingRuleCards() })
  if (method === 'POST') return ok({ item: repo.createAutoBettingRuleCard(
    await readBody(req), { defaultLeagues: await loadDefaultLeagues(options) }) })
  return methodNotAllowed()
}
if (parts.length === 2 && parts[0] === 'auto-betting-rule-cards') {
  if (method === 'PUT') return ok({ item: repo.updateAutoBettingRuleCard(
    parts[1], await readBody(req), { defaultLeagues: await loadDefaultLeagues(options) }) })
  if (method === 'DELETE') return ok(repo.deleteAutoBettingRuleCard(parts[1], await readBody(req)))
  return methodNotAllowed()
}
if (parts.length === 1 && parts[0] === 'today-betting-leagues' && method === 'GET') {
  return ok({ items: repo.listTodayBettingLeagues(
    url.searchParams.get('cardId'), { defaultLeagues: await loadDefaultLeagues(options) }) })
}
```

`loadDefaultLeagues(options)` 固定实现为：

```js
function loadDefaultLeagues(options) {
  return readDefaultLeagues(options.dataOptions?.defaultLeaguesPath || 'config/default-leagues.json')
}
```

ValidationError HTTP 400 payload 固定 `{ error, fields }`；CAS HTTP 409；not found 404。`fields.ownerName` 只返回卡片显示名称。

- [ ] **Step 4: Add frontend service/type contracts**

```ts
export type AutoBettingRuleCard = {
  cardId: string; name: string; enabled: boolean; leagueNames: string[]
  targetOddsMin: string | null; targetOddsMax: string | null; targetAmountMinor: number | null
  currency: 'CNY'; amountScale: 0; remark: string; realEligible: boolean
  realEligibilityVersion: number; migrationReviewRequired: boolean
  migrationReviewReason: string; version: number; createdAt: string; updatedAt: string
}

export type TodayBettingLeague = {
  leagueName: string; source: 'default' | 'manual' | 'both'; todayMatchCount: number
  ownerCardId: string | null; ownerCardName: string | null
  selectable: boolean; availableToday: boolean
}

export type RuleCardMutation = {
  name: string; enabled: boolean; leagueNames: string[]
  targetOddsMin: string; targetOddsMax: string; targetAmountMinor: number; remark: string
}
export type RuleCardUpdate = RuleCardMutation & { expectedVersion: number }
```

API methods固定 `getAutoBettingRuleCards/createAutoBettingRuleCard/updateAutoBettingRuleCard/deleteAutoBettingRuleCard/getTodayBettingLeagues`。

- [ ] **Step 5: Retire fixed setting mutation**

`PUT /api/app/auto-betting-settings/:mode` 返回 410 `{error:'fixed-auto-betting-settings-retired'}`；GET 保留只读迁移证据且不被新页面调用。

- [ ] **Step 6: Run Task 3 GREEN**

Run: `node --test tests/crown-auto-betting-rule-card-api.test.mjs tests/crown-dashboard-security.test.mjs tests/crown-app-api.test.mjs && npm --prefix frontend test -- --run src/services/api.security.test.ts`

Expected: PASS；旧 GET 不变，新 mutation 安全退役。

- [ ] **Step 7: Review checkpoint**

审查 API 无 mode/monitor fields、无 secret/authorization material，前后端 DTO 命名一致，记录审查结果但不提交。

### Task 4: Signal 单卡匹配、card inbox 与删除前终结

**Files:**
- Create: `src/crown/betting/auto-betting-rule-card-matcher.mjs`
- Modify: `src/crown/monitor/alert-settings-watcher.mjs`
- Modify: `src/crown/monitor/signal.mjs`
- Modify: `src/crown/betting/auto-betting-inbox.mjs`
- Modify: `src/crown/app/app-db.mjs`
- Create: `tests/crown-auto-betting-rule-card-matcher.test.mjs`
- Modify: `tests/crown-signal-dual-task.test.mjs`
- Modify: `tests/crown-auto-betting-inbox.test.mjs`
- Modify: `tests/crown-betting-worker.test.mjs`

**Interfaces:**
- Produces: `matchEnabledRuleCardForSignal(db, signal, context) -> CardSnapshot | null`。
- Changes inbox identity to `{ signalId, cardId }` and lease mutation methods to require both.
- Preserves one Telegram delivery per Signal independently of card match.

- [ ] **Step 1: Write matcher RED tests**

```js
test('one league owner yields at most one immutable card snapshot for either signal mode', () => {
  seedCard(db, { cardId: 'card-a', enabled: true, leagues: ['英超'] })
  const prematch = matchEnabledRuleCardForSignal(db, signal({ league: '英超', mode: 'prematch' }), context)
  const live = matchEnabledRuleCardForSignal(db, signal({ league: '英超', mode: 'live' }), context)
  assert.equal(prematch.cardId, 'card-a')
  assert.equal(live.cardId, 'card-a')
  assert.equal('mode' in prematch, false)
  assert.equal(matchEnabledRuleCardForSignal(db, signal({ league: '西甲' }), context), null)
})
```

覆盖停用、review-required、今日不可用、手动今日联赛、卡片字段损坏全部返回 null/fail-closed。

- [ ] **Step 2: Run matcher RED**

Run: `node --test tests/crown-auto-betting-rule-card-matcher.test.mjs`

Expected: FAIL with module not found。

- [ ] **Step 3: Implement exact matcher**

```js
export function matchEnabledRuleCardForSignal(db, signal, { availableLeagueNames }) {
  const league = String(signal?.evidence?.league || '').trim()
  if (!league || !availableLeagueNames.has(league)) return null
  const row = db.prepare(`SELECT c.* FROM auto_betting_rule_card_leagues l
    JOIN auto_betting_rule_cards c ON c.card_id=l.card_id
    WHERE l.league_name=? AND c.enabled=1 AND c.migration_review_required=0`).get(league)
  return row ? immutableCardSnapshot(row, [league]) : null
}
```

Matcher 只按 exact Signal league 查唯一 owner，不读取 Signal mode 作卡片过滤。

- [ ] **Step 4: Write atomic artifact RED tests**

```js
test('signal creates telegram delivery and at most one card inbox atomically', () => {
  const result = persistSignalArtifacts(db, matchedDecision, context)
  assert.equal(count(db, 'monitor_signals'), 1)
  assert.equal(count(db, 'monitor_deliveries'), 1)
  assert.equal(count(db, 'auto_betting_signal_inbox'), 1)
  const inbox = db.prepare('SELECT signal_id,card_id,card_version,card_snapshot_json FROM auto_betting_signal_inbox').get()
  assert.equal(inbox.card_id, 'card-a')
  assert.equal(JSON.parse(inbox.card_snapshot_json).targetAmountMinor, 100)
})
```

无卡片匹配时 Signal+TG 为 1、inbox 为 0；强制 inbox insert 失败回滚 Signal/TG/cooldown；重复 Signal 不重写 snapshot。

- [ ] **Step 5: Change inbox store to composite identity**

```js
claimDue(limit) // returns { signalId, cardId, cardVersion, cardSnapshot, signal, inboxLease }
complete({ signalId, cardId, leaseOwner, batchId })
skip({ signalId, cardId, leaseOwner, reason })
retry({ signalId, cardId, leaseOwner, reason })
```

SQL WHERE 必须同时绑定 `signal_id/card_id/lease_owner/lease_expires_at`；terminal skip allowlist 加 `rule-deleted`。

- [ ] **Step 6: Run Task 4 GREEN**

Run: `node --test tests/crown-auto-betting-rule-card-matcher.test.mjs tests/crown-signal-dual-task.test.mjs tests/crown-auto-betting-inbox.test.mjs tests/crown-betting-worker.test.mjs tests/crown-alert-settings-watcher.test.mjs`

Expected: PASS；worker 只消费 card inbox，不恢复 monitor_signals scan。

- [ ] **Step 7: Review checkpoint**

审查 Signal/TG 不因无卡片而丢失，card snapshot 深拷贝且不可变，数据库唯一约束保证不可能 fan-out 多卡，记录结果不提交。

### Task 5: Card-scoped 批次、market-once、授权和 B2 安全链

**Files:**
- Modify: `src/crown/betting/auto-betting-consumer.mjs`
- Modify: `src/crown/betting/multi-account-bet-coordinator.mjs`
- Modify: `src/crown/betting/bet-batch-store.mjs`
- Modify: `src/crown/betting/market-once-store.mjs`
- Modify: `src/crown/betting/execution-gate.mjs`
- Modify: `src/crown/betting/execution-authorization.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: `src/crown/betting/real-betting-runtime.mjs`
- Create: `tests/crown-card-scoped-betting-integration.test.mjs`
- Modify: `tests/crown-auto-betting-consumer.test.mjs`
- Modify: `tests/crown-multi-account-bet-coordinator.test.mjs`
- Modify: `tests/crown-betting-b2-executor.test.mjs`
- Modify: `tests/crown-real-betting-runtime.test.mjs`

**Interfaces:**
- Consumer input uses `cardId/cardVersion/cardSnapshot`; constructor adds required `cardExists(cardId) -> boolean`; output remains `{status:'batch_created', batchId}` or stable skip.
- `claimAndCreateCardScopedBatch(input)` replaces mode-setting batch creation while retaining `input.signal.evidence.mode`.
- Authorization scope adds exact `{ cardId, eligibilityVersion }` plus existing allowed Signal modes.

- [ ] **Step 1: Write consumer/execution RED tests**

```js
test('card has no mode filter but batch keeps the signal mode and card identity', async () => {
  const result = await consumer.process(inbox({ cardId: 'card-a', signal: signal({ mode: 'live' }) }),
    { executionMode: 'simulated' })
  assert.equal(result.status, 'batch_created')
  const batch = db.prepare('SELECT card_id,card_version,betting_mode FROM bet_batches').get()
  assert.deepEqual(batch, { card_id: 'card-a', card_version: 3, betting_mode: 'live' })
})

test('same card and exact line claims once while another line remains eligible', async () => {
  assert.equal((await process(signal({ lineKey: 'RATIO_RE' }))).status, 'batch_created')
  assert.equal((await process(signal({ lineKey: 'RATIO_RE', odds: '0.91' }))).reason, 'market-already-claimed')
  assert.equal((await process(signal({ lineKey: 'RATIO_RE_A' }))).status, 'batch_created')
})
```

覆盖 card deleted before claim、version snapshot 不受 edit 影响、down/non-up before selection、target odds exact decimal、real eligibility/global intent before atomic claim。

- [ ] **Step 2: Run execution RED**

Run: `node --test tests/crown-card-scoped-betting-integration.test.mjs tests/crown-auto-betting-consumer.test.mjs`

Expected: FAIL because current consumer expects fixed settings identity。

- [ ] **Step 3: Implement card-scoped consumer**

```js
const direction = item.signal.trigger?.direction
if (direction === 'down') return skip('water-down-alert-only')
if (direction !== 'up') return skip('signal-invalid')
if (!this.cardExists(item.cardId)) return skip('rule-deleted')
const lockedSelection = lockReverseSelection(item.signal, findLatestSelection)
const key = marketOnceKey(changeFor(item.signal, lockedSelection), lockedSelection.side, {
  cardId: item.cardId,
})
return claimAndCreateCardScopedBatch({
  signalId: item.signalId, signal: item.signal, cardId: item.cardId,
  cardVersion: item.cardVersion, cardSnapshot: item.cardSnapshot,
  bettingMode: item.signal.evidence.mode, marketOnceKey: key, lockedSelection,
  executionMode, authorizationId, inboxLease: item.inboxLease,
})
```

存在性检查必须在 atomic transaction 内再次执行，避免 delete TOCTOU；外层检查只提供早停。

- [ ] **Step 4: Extend authorization and batch snapshots**

```js
authorizationScope.cardScopes = [{ cardId, eligibilityVersion }]
assertScopeContainsCard(authorizationScope, {
  cardId: batch.card_id,
  eligibilityVersion: batch.real_eligibility_version,
})
assertScopeContainsMode(authorizationScope, batch.betting_mode)
```

旧 authorization 没有 card scope 时不能授权新任务；普通 card PUT 降级 `real_eligible=false` 并递增 eligibility version，规则真实升权继续独立确认和审计。

- [ ] **Step 5: Keep B2 invariants**

Batch/child 仍使用 immutable selection envelope、account budget、submit attempt、provider reference、accepted/rejected/unknown 状态机。`rejected` 不分配剩余金额，`unknown` 不重新 submit；任何 card identity drift 在 provider I/O 前失败。

```js
assert.equal(provider.previewCalls, 0)
assert.equal(provider.submitCalls, 0)
assert.equal(batch.card_id, authorization.cardScopes[0].cardId)
```

- [ ] **Step 6: Run Task 5 GREEN and safety regressions**

Run: `node --test tests/crown-card-scoped-betting-integration.test.mjs tests/crown-auto-betting-consumer.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-execution-gate.test.mjs`

Expected: PASS；canonical capability 仍为 0/0/0，production provider network calls 为 0。

- [ ] **Step 7: Review checkpoint**

独立审查 card delete/edit/authorization/market-once 的 TOCTOU 和 identity binding；Critical/Important 必须修复后才能进入 Task 6，不提交 Git。

### Task 6: 删除事务、每日清理与 Operations 投影

**Files:**
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/runtime-cleanup.mjs`
- Modify: `src/crown/app/operations-summary.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/types.ts`
- Create: `tests/crown-auto-betting-rule-card-delete.test.mjs`
- Modify: `tests/crown-runtime-cleanup.test.mjs`
- Modify: `tests/crown-operations-summary.test.mjs`
- Modify: `frontend/src/pages/OperationsConsole.test.tsx`

**Interfaces:**
- Produces `deleteAutoBettingRuleCard(cardId, { expectedVersion }) -> { ok:true }`.
- Operations DTO produces `ruleCards: { total, enabled, reviewRequired, ownedLeagues }`.
- Cleanup preserves both card tables and clears all card snapshot runtime evidence.

- [ ] **Step 1: Write delete race RED tests**

```js
test('delete skips unbound inbox, preserves bound batch, and releases league atomically', () => {
  seedPendingInbox(db, { signalId: 's1', cardId: 'card-a' })
  seedBoundInboxAndBatch(db, { signalId: 's2', cardId: 'card-a', batchId: 'b2' })
  repo.deleteAutoBettingRuleCard('card-a', { expectedVersion: 1 })
  assert.deepEqual(db.prepare("SELECT status,skip_reason FROM auto_betting_signal_inbox WHERE signal_id='s1'").get(),
    { status: 'skipped', skip_reason: 'rule-deleted' })
  assert.equal(db.prepare("SELECT status FROM bet_batches WHERE batch_id='b2'").get().status, 'queued')
  assert.equal(db.prepare("SELECT COUNT(*) count FROM auto_betting_rule_card_leagues WHERE league_name='英超'").get().count, 0)
})
```

并发 consumer/delete 测试只能出现 `rule-deleted` 或已原子创建 batch 两种结果，不能出现 orphan claim/batch。

- [ ] **Step 2: Implement atomic delete**

```js
return runImmediate(db, () => {
  const card = requireCardVersion(db, cardId, expectedVersion)
  db.prepare(`UPDATE auto_betting_signal_inbox SET
    status='skipped',skip_reason='rule-deleted',lease_owner='',lease_expires_at='',updated_at=?
    WHERE card_id=? AND batch_id IS NULL AND status IN ('pending','retry','processing')`).run(now, card.card_id)
  db.prepare('DELETE FROM auto_betting_rule_cards WHERE card_id=? AND version=?').run(cardId, expectedVersion)
  return { ok: true }
})
```

处理 processing row 时必须通过同一数据库事务与 lease/CAS 约束，过期 worker 不能随后写 batch_created。

- [ ] **Step 3: Write cleanup/Operations RED tests**

```js
test('daily reset clears card history but preserves current cards and ownership', async () => {
  const before = snapshotCards(db)
  await cleanup.run()
  assert.deepEqual(snapshotCards(db), before)
  assert.equal(count(db, 'auto_betting_signal_inbox'), 0)
  assert.equal(count(db, 'bet_batches'), 0)
  assert.equal(count(db, 'bet_market_once_claims'), 0)
})

test('operations reports card totals instead of fixed modes', () => {
  assert.deepEqual(summary.ruleCards, { total: 3, enabled: 2, reviewRequired: 1, ownedLeagues: 5 })
  assert.equal('prematch' in summary.autoBetting, false)
})
```

- [ ] **Step 4: Update cleanup allowlists and Operations projection**

Cards/leagues 加入 preserve set；card inbox、card snapshots、batch/child/claims/locks/auth runtime evidence 保持清理顺序满足 foreign keys。Operations 只返回 bounded counts 和 allowlisted reasons。

- [ ] **Step 5: Run Task 6 GREEN**

Run: `node --test tests/crown-auto-betting-rule-card-delete.test.mjs tests/crown-runtime-cleanup.test.mjs tests/crown-operations-summary.test.mjs tests/crown-app-api-operations.test.mjs && npm --prefix frontend test -- --run src/pages/OperationsConsole.test.tsx`

Expected: PASS；清理 preview/apply 数量一致，卡片配置 byte-equivalent。

- [ ] **Step 6: Review checkpoint**

审查 delete/cleanup 不删除账号、凭据、Telegram、协议证据或当前卡片，不留下 pending/unknown/lock；记录结果，不提交。

### Task 7: 修复监控保存、字段级错误和契约版本混跑

**Files:**
- Create: `src/crown/app/app-contract-version.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/monitor/alert-settings.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/pages/MonitorSettings.tsx`
- Modify: `frontend/src/types.ts`
- Create: `tests/crown-app-contract-version.test.mjs`
- Modify: `tests/crown-alert-settings-api.test.mjs`
- Modify: `frontend/src/pages/MonitorSettings.test.tsx`
- Modify: `frontend/src/services/api.security.test.ts`

**Interfaces:**
- Constant `APP_CONTRACT_VERSION = 'dynamic-betting-cards-v1'` in backend and frontend build.
- Security context returns `{ appContractVersion, schemaVersion }`.
- Monitor PUT accepts explicit `acknowledgeMigrationReview: boolean` and returns field details.

- [ ] **Step 1: Write version-skew RED tests**

```js
test('security context exposes matching app and schema contracts', async () => {
  const response = await request('GET', '/api/app/security-context')
  assert.equal(response.payload.appContractVersion, 'dynamic-betting-cards-v1')
  assert.equal(response.payload.schemaVersion, 'dynamic-betting-cards-v1')
})

test('frontend blocks mutations when the running backend contract differs', async () => {
  mockSecurityContext({ appContractVersion: 'fixed-settings-v1' })
  render(<MonitorSettings />)
  expect(await screen.findByText('Dashboard 已升级，请重启')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存赛前报警' })).toBeDisabled()
})
```

- [ ] **Step 2: Write monitor migration-review RED test**

```js
test('complete explicit save can acknowledge monitor migration review', async () => {
  seedReviewRow(db, 'prematch')
  const response = await put('/api/app/monitor-alert-settings/prematch', {
    ...completePrematchBody, acknowledgeMigrationReview: true,
  })
  assert.equal(response.payload.item.migrationReviewRequired, false)
  assert.equal(response.payload.item.version, 2)
})
```

缺市场、空 threshold 或不完整 branch 时 review 不清除并返回具体 `fields`。

- [ ] **Step 3: Implement contract and explicit acknowledgement**

```js
export const APP_CONTRACT_VERSION = 'dynamic-betting-cards-v1'

if (body.acknowledgeMigrationReview === true) {
  if (!current.migration_review_required) invalid({ acknowledgeMigrationReview: 'review is not required' })
  normalized.item.migrationReviewRequired = false
}
```

Repository 同一 CAS UPDATE 写 `migration_review_required=0,migration_review_reason=''` 并追加安全审计。前端仅当 server row review-required 且完整表单保存时发送 true。

- [ ] **Step 4: Return and render field errors**

```ts
function errorText(error: ApiError) {
  if (error.fields?.leagueNames) return error.fields.leagueNames
  if (error.fields?.waterMoveThreshold) return '动水阈值不能为空且必须大于等于 0。'
  return error.message || '保存失败，请稍后重试。'
}
```

API error payload 仅包含 allowlisted field names/messages，不能回传 SQL、stack、request body 或 secrets。

- [ ] **Step 5: Run Task 7 GREEN**

Run: `node --test tests/crown-app-contract-version.test.mjs tests/crown-alert-settings-api.test.mjs tests/crown-dashboard-security.test.mjs && npm --prefix frontend test -- --run src/pages/MonitorSettings.test.tsx src/services/api.security.test.ts`

Expected: PASS；用旧 contract mock 时所有 mutation disabled；完整 save 清除 review。

- [ ] **Step 6: Review checkpoint**

确认当前保存失败根因有自动测试：旧 backend contract + 新 frontend 时不再发送 PUT；一致版本下字段保存成功。不得在此任务重启正式 8787 进程。

### Task 8: 动态卡片 React 页面与响应式弹窗

**Files:**
- Rewrite: `frontend/src/pages/AutoBetRules.tsx`
- Rewrite: `frontend/src/pages/AutoBetRules.test.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/src/App.contract.test.tsx`
- Modify: `frontend/src/pages/OperationsConsole.tsx`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`

**Interfaces:**
- Consumes Task 3 card/today-league APIs and Task 7 contract guard.
- Produces summary cards plus shared create/edit `RuleCardModal`.

- [ ] **Step 1: Write page RED tests**

```tsx
test('renders dynamic summary cards without prematch/live titles', async () => {
  render(<AutoBetRules />)
  expect(await screen.findByRole('heading', { name: '英超主规则' })).toBeInTheDocument()
  expect(screen.queryByText('赛前投注')).not.toBeInTheDocument()
  expect(screen.queryByText('滚球投注')).not.toBeInTheDocument()
  expect(screen.getByText('英超')).toBeInTheDocument()
})

test('create modal requires a league and disables leagues owned by another card', async () => {
  await user.click(screen.getByRole('button', { name: '新增投注规则' }))
  expect(screen.getByRole('dialog', { name: '新增投注规则' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /西甲.*已被西甲规则使用/ })).toHaveAttribute('aria-disabled', 'true')
  await user.click(screen.getByRole('button', { name: '保存规则' }))
  expect(screen.getByText('请至少选择一个联赛')).toBeInTheDocument()
})
```

覆盖 create/edit API payload、CAS rollback、physical delete confirm、delete releases option、manual source badge、stale own league、auth/contract mismatch、decimal/amount exact validation。

- [ ] **Step 2: Run frontend RED**

Run: `npm --prefix frontend test -- --run src/pages/AutoBetRules.test.tsx`

Expected: FAIL because the page still renders two fixed mode cards。

- [ ] **Step 3: Implement summary card**

```tsx
function RuleSummaryCard({ card, onEdit, onDelete }: Props) {
  return <Card title={<h2>{card.name}</h2>} extra={<Tag>{card.enabled ? '已启用' : '已停用'}</Tag>}>
    <div className="rule-league-tags">{card.leagueNames.map((name) => <Tag key={name}>{name}</Tag>)}</div>
    <Descriptions column={1} items={[
      { key: 'odds', label: '目标水位', children: `${card.targetOddsMin} – ${card.targetOddsMax}` },
      { key: 'amount', label: '目标金额', children: `${card.targetAmountMinor} CNY` },
    ]} />
    <Space><Button onClick={() => onEdit(card)}>编辑</Button>
      <Popconfirm title="确定删除该规则？" onConfirm={() => onDelete(card)}><Button danger>删除</Button></Popconfirm>
    </Space>
  </Card>
}
```

- [ ] **Step 4: Implement shared modal and exact validation**

```tsx
<Form.Item name="leagueNames" label="联赛" rules={[{ required: true, type: 'array', min: 1,
  message: '请至少选择一个联赛' }]}>
  <Select mode="multiple" options={leagueOptions} optionFilterProp="label" />
</Form.Item>
```

赔率复用现有 BigInt decimal canonicalizer；金额先做 16 字符快拒再 BigInt；保存 payload 不包含 mode/market/monitor/real eligibility 字段。

- [ ] **Step 5: Implement responsive layout**

```css
.rule-card-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
@media (max-width: 900px) { .rule-card-grid { grid-template-columns:1fr; } }
.rule-card-modal .ant-select { width:100%; }
.rule-league-tags { display:flex; flex-wrap:wrap; gap:6px; min-width:0; }
```

390px 下 modal 使用 `width: calc(100vw - 24px)`，按钮不横向溢出；长联赛名称允许换行。

- [ ] **Step 6: Run Task 8 GREEN and build**

Run: `npm --prefix frontend test -- --run src/pages/AutoBetRules.test.tsx src/App.contract.test.tsx src/pages/OperationsConsole.test.tsx && npm --prefix frontend run build`

Expected: PASS；production build exit 0；页面无固定 mode 文案。

- [ ] **Step 7: Review checkpoint**

独立审查 modal 键盘/label、错误恢复、请求重复提交、移动端 overflow 和删除确认；修复所有 Important 后记录结果，不提交。

### Task 9: 权威文档整理、全链路验收与本机重启方案

**Files:**
- Modify: `README.md`
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/crown-current-architecture.md`
- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/modules/crown-football-monitor.md`
- Modify: `docs/modules/crown-betting-protocol.md`
- Modify: `docs/superpowers/specs/2026-07-11-crown-c-strategy-mobile-console-design.md`
- Modify: `docs/superpowers/specs/2026-07-12-crown-alert-betting-separation-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-crown-c-unified-auto-betting.md`
- Modify: `docs/superpowers/plans/2026-07-12-crown-alert-betting-separation.md`
- Modify: `.superpowers/sdd/progress.md`
- Create: `.superpowers/sdd/crown-dynamic-betting-rule-cards-final-report.md`

**Interfaces:**
- Produces one current documentation entry in `docs/module-index.md`.
- Produces final offline evidence and a separate, non-automatic live migration/restart checklist.

- [ ] **Step 1: Update current authority documents**

文档必须写明：monitor prematch/live 独立、bet cards mode-agnostic、league required/unique、manual today league explicit selection、card snapshot、physical delete/history cleanup、capability 0/0/0。

```markdown
> 当前投注规则入口：`/betting-rules` 动态卡片。一个今日联赛只能属于一张现存卡片；卡片不区分赛前/滚球，执行 mode 来自 Signal。
```

- [ ] **Step 2: Mark historical designs as superseded**

在四个历史 spec/plan 文件标题后加入：

```markdown
> 历史状态：本文件中的固定赛前/滚球投注设置或统一监控投注规则已被
> `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` 取代。
> 其余历史验收证据保留，不作为当前实现入口。
```

不删除历史报告，不批量改写原始任务结论。

- [ ] **Step 3: Run placeholder and stale-contract scans**

Run:

```powershell
$placeholderPattern = [string]::Concat([char]0x5F85,[char]0x5B9A,'|',[char]0x7A0D,[char]0x540E,[char]0x8865,[char]0x5145,'|',[char]0x5360,[char]0x4F4D,[char]0x5185,[char]0x5BB9)
rg -n $placeholderPattern docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md docs/superpowers/plans/2026-07-12-crown-dynamic-betting-rule-cards.md
rg -n "固定赛前|固定滚球|auto_betting_settings.*当前|赛前投注.*滚球投注" README.md docs/crown-current-architecture.md docs/module-index.md docs/modules
```

Expected: 第一条无输出；第二条只允许带“历史/已取代”上下文的行。

- [ ] **Step 4: Run fresh full verification**

Run:

```powershell
npm test
npm run check
npm --prefix frontend test -- --run
npm --prefix frontend run build
docker compose -p crown-dashboard config --quiet
```

Expected: 全部 exit 0；报告记录精确测试数量；capability 测试仍为 0/0/0。

- [ ] **Step 5: Run local temp-DB API/browser acceptance**

使用 `output/playwright/crown-dynamic-cards.sqlite`，不得使用 `storage/crown.sqlite`。验证：

```text
1440x900: cards=2, fixedModeTitles=0, horizontalOverflow=false
390x844: create/edit modal fully visible, horizontalOverflow=false
manual today league visible; owned league disabled with owner name
empty league save blocked; duplicate concurrent API save returns 409/400 stable code
delete releases option; old route redirects; console errors=0 warnings=0
```

浏览器只访问 `127.0.0.1`，不调用 Crown/TG。

- [ ] **Step 6: Independent whole-change review**

Reviewer 逐项检查 design §1–11、schema/migration、unique league transaction、Signal atomic artifacts、delete race、card authorization、cleanup、contract version和 docs。Critical/Important 必须修复并重跑受影响测试；最终报告必须明确剩余 finding 数量。

- [ ] **Step 7: Write separate live restart checklist without executing it**

```markdown
1. 停止 8787 Dashboard 和 betting worker。
2. 备份 `storage/crown.sqlite` 并记录 SHA-256、integrity_check、foreign_key_check。
3. 用新代码在备份副本执行迁移，核对两张迁移卡、0 联赛、enabled=0、real_eligible=0。
4. 用户确认后才对正式库启动新 Dashboard；启动即执行同一迁移。
5. 验证 app/frontend/schema contract 均为 `dynamic-betting-cards-v1`。
6. 浏览器保存监控报警和一张临时停用卡片，验证后删除临时卡片。
7. 保持全局真实投注 off，确认 Crown/TG/submit 网络调用均为 0。
```

本计划阶段不执行这七步。

- [ ] **Step 8: Final report and memory**

更新 `.superpowers/sdd/progress.md`、`docs/project-memory.md` 和模块索引，记录实现、根因、验证、未执行 live migration/real I/O/Git。按 Codex Memory prewrite/closeout 规则只写稳定事实。

## Execution Notes

- 每个 Task 先 RED、再最小 GREEN、再相关回归和独立审查。
- Task 1–3 建立 schema/API 契约；Task 4–6 才允许修改运行链；Task 7 独立修复当前保存/版本问题；Task 8 依赖 Task 3/7；Task 9 只能在前八项全部通过后执行。
- 多 agent 实施时，schema/API、运行链、frontend 不得同时修改相同文件；主流程负责顺序合并和全量验证。
- 当前仓库无 commit，所有步骤保持 unstaged/uncommitted，除非用户以后明确授权建立 Git 历史。
