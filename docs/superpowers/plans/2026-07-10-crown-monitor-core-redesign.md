# Crown Monitor Core Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstable list/detail baseline logic with authoritative snapshot batches, canonical Crown identities, reliable time parsing, persistent facts, strategies, signals, cooldowns, and non-blocking alert delivery.

**Architecture:** Crown XML responses become `SnapshotBatch` objects before entering state. SQLite owns recoverable active/baseline/signal/delivery state while schema-v2 JSONL remains the append-only audit stream. `Change → StrategyEngine → Signal → Dispatcher/Candidate` replaces the current duplicated candidate and notification logic; the watcher remains unable to submit a real bet.

**Tech Stack:** Node.js ESM, `node:sqlite`, `node:test`, append-only JSONL, React/TypeScript Dashboard, existing Crown XML fixtures.

**Approval gate:** The design in `docs/superpowers/specs/2026-07-10-crown-monitor-core-redesign.md` must be explicitly approved before executing this plan.

**Repository note:** The user does not authorize automatic commits by default. Replace each commit checkpoint with a scope review unless the user explicitly asks for commits.

---

## File structure

### New files

| File | Responsibility |
|---|---|
| `src/crown/monitor/crown-time.mjs` | Parse Crown kickoff and `RETIMESET` values without locale-dependent `Date.parse` behavior |
| `src/crown/monitor/snapshot-batch.mjs` | Build and validate schema-v2 authoritative/partial batch envelopes and canonical identities |
| `src/crown/monitor/monitor-state-store.mjs` | Transactional active event, selection baseline, Change, Signal, cooldown, and delivery persistence |
| `src/crown/monitor/strategy-registry.mjs` | Register and execute pure strategy evaluators |
| `src/crown/monitor/odds-delta-strategy.mjs` | First schema-v2 strategy, migrated from current monitor settings semantics |
| `src/crown/monitor/signal.mjs` | Create deterministic signal/change/candidate IDs |
| `src/crown/monitor/alert-dispatcher.mjs` | Non-blocking persisted delivery queue with bounded retry |
| `tests/crown-time.test.mjs` | Kickoff/live clock parsing tests |
| `tests/crown-snapshot-batch.test.mjs` | Batch scope/completeness/identity tests |
| `tests/crown-monitor-state-store.test.mjs` | Authoritative/partial, restart, stale input, removal, and baseline tests |
| `tests/crown-strategy-engine.test.mjs` | Strategy scope, missing data, cooldown, and deterministic Signal tests |
| `tests/crown-alert-dispatcher.test.mjs` | Retry, restart, and non-blocking delivery tests |
| `tests/crown-monitor-v2-integration.test.mjs` | list → multiple game-more → Change → Signal → candidate end-to-end tests |

### Existing files to modify

| File | Change |
|---|---|
| `src/crown/crown-transform-xml.mjs` | Use the new time and identity outputs; expose event refs for batches |
| `src/crown/app/app-db.mjs` | Add monitor state/signal/delivery schema |
| `src/crown/storage/jsonl-store.mjs` | Keep schema-v1 compatibility but remove policy evaluation from schema-v2 path |
| `src/crown/monitor/monitor-settings.mjs` | Add a legacy-settings-to-`odds_delta` rule adapter |
| `src/crown/betting/monitor-bet-signal.mjs` | Consume a persisted Signal and derive deterministic candidate ID |
| `scripts/crown-watch.mjs` | Build batches, use state store/engine/dispatcher, and write v2 paths |
| `src/crown/dashboard/dashboard-data.mjs` | Prefer v2 audit/state and expose incomplete-data reasons |
| `src/crown/app/app-api.mjs` | Expose monitor state/signal health in existing app bootstrap/status responses |
| `README.md` and monitor docs | Describe v2 operation, rollback, files, and verification |

---

### Task 1: Crown kickoff and live clock parser

**Files:**
- Create: `src/crown/monitor/crown-time.mjs`
- Create: `tests/crown-time.test.mjs`
- Modify: `src/crown/crown-transform-xml.mjs`

- [x] **Step 1: Write failing kickoff tests**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCrownKickoff } from '../src/crown/monitor/crown-time.mjs'

test('parses GAME_DATE_TIME as Asia/Shanghai and emits UTC', () => {
  assert.deepEqual(parseCrownKickoff({
    gameDateTime: '2026-07-08 21:00:00',
    capturedAt: '2026-07-08T10:00:00.000Z',
  }), {
    raw: '2026-07-08 21:00:00',
    utc: '2026-07-08T13:00:00.000Z',
    local: '2026-07-08 21:00:00',
    timeZone: 'Asia/Shanghai',
    source: 'GAME_DATE_TIME',
    confidence: 'high',
    warnings: [],
  })
})

test('adds the nearest reasonable year to Crown DATETIME', () => {
  const result = parseCrownKickoff({
    datetime: '12-31 11:30p',
    capturedAt: '2027-01-01T00:10:00.000+08:00',
  })
  assert.equal(result.utc, '2026-12-31T15:30:00.000Z')
  assert.equal(result.source, 'DATETIME')
})
```

- [x] **Step 2: Run the kickoff tests and verify RED**

Run: `node --test tests/crown-time.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `crown-time.mjs`.

- [x] **Step 3: Implement deterministic kickoff parsing**

```js
const SHANGHAI_OFFSET = '+08:00'

function isoFromParts(year, month, day, hour, minute, second = 0) {
  const pad = (value) => String(value).padStart(2, '0')
  return new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${SHANGHAI_OFFSET}`).toISOString()
}

export function parseCrownKickoff({ gameDateTime = '', datetime = '', capturedAt = '' } = {}) {
  const full = String(gameDateTime).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/)
  if (full) {
    const [, year, month, day, hour, minute, second] = full
    return {
      raw: gameDateTime,
      utc: isoFromParts(+year, +month, +day, +hour, +minute, +second),
      local: gameDateTime,
      timeZone: 'Asia/Shanghai',
      source: 'GAME_DATE_TIME',
      confidence: 'high',
      warnings: [],
    }
  }
  // Parse MM-DD hh:mma, build candidates for captured year - 1/year/year + 1,
  // and return the valid candidate with the smallest absolute distance.
  return { raw: gameDateTime || datetime || null, utc: null, local: null, timeZone: 'Asia/Shanghai', source: null, confidence: 'none', warnings: ['kickoff-unparsed'] }
}
```

- [x] **Step 4: Add failing live clock tests**

```js
import { parseCrownLiveClock } from '../src/crown/monitor/crown-time.mjs'

test('parses Crown RETIMESET without reading the half number as minutes', () => {
  assert.deepEqual(parseCrownLiveClock('1H^08:00'), { raw: '1H^08:00', phase: 'first_half', elapsedMinute: 8, seconds: 0, warnings: [] })
  assert.deepEqual(parseCrownLiveClock('2H^52:41'), { raw: '2H^52:41', phase: 'second_half', elapsedMinute: 52, seconds: 41, warnings: [] })
})

test('fails closed for an ambiguous second-half clock', () => {
  assert.equal(parseCrownLiveClock('2H^08:00').elapsedMinute, null)
  assert.deepEqual(parseCrownLiveClock('2H^08:00').warnings, ['ambiguous-live-clock'])
})
```

- [x] **Step 5: Implement live clock parsing and wire normalizer fields**

```js
export function parseCrownLiveClock(value) {
  const raw = String(value || '').trim()
  if (/^(HT|HALF[ -]?TIME|中场)$/i.test(raw)) return { raw, phase: 'half_time', elapsedMinute: null, seconds: 0, warnings: [] }
  const match = raw.match(/^([12])H\^(\d{1,3}):(\d{2})$/i)
  if (!match) return { raw: raw || null, phase: null, elapsedMinute: null, seconds: null, warnings: ['live-clock-unparsed'] }
  const phase = match[1] === '1' ? 'first_half' : 'second_half'
  const elapsedMinute = Number(match[2])
  if (phase === 'second_half' && elapsedMinute < 45) return { raw, phase, elapsedMinute: null, seconds: Number(match[3]), warnings: ['ambiguous-live-clock'] }
  return { raw, phase, elapsedMinute, seconds: Number(match[3]), warnings: [] }
}
```

Update `baseEvent()` to store `startTimeUtc`, `timeSource`, `timeConfidence`, `timeWarnings`, `clock`, `livePhase`, and `liveMinute` from these parsers.

- [x] **Step 6: Verify Task 1 GREEN**

Run: `node --test tests/crown-time.test.mjs tests/crown-transform-xml.test.mjs tests/crown-monitor-settings.test.mjs`  
Expected: all tests PASS; fixture assertions explicitly verify `startTimeUtc`, `livePhase`, and `liveMinute`.

- [x] **Step 7: Scope review checkpoint**

Review only Task 1 files. Do not commit unless the user explicitly requests it.

---

### Task 2: Canonical identities and SnapshotBatch envelope

**Files:**
- Create: `src/crown/monitor/snapshot-batch.mjs`
- Create: `tests/crown-snapshot-batch.test.mjs`
- Modify: `src/crown/crown-transform-xml.mjs`

- [x] **Step 1: Write failing list/detail identity tests**

```js
test('list and game-more with the same GID share one canonical event key', () => {
  const list = crownIdentity({ gid: '3001', gidm: '9101', hgid: '3002', ecid: '8101', lid: '7101' })
  const more = crownIdentity({ gid: '3001', gidm: '9101', hgid: '3002', ecid: '', lid: '7101' })
  assert.equal(list.eventKey, 'crown|football|gid=3001')
  assert.equal(more.eventKey, list.eventKey)
  assert.equal(list.matchGroupKey, 'crown|football|gidm=9101|lid=7101')
})

test('different GIDs under one GIDM remain distinct events', () => {
  assert.notEqual(crownIdentity({ gid: '10', gidm: '90', lid: '7' }).eventKey, crownIdentity({ gid: '11', gidm: '90', lid: '7' }).eventKey)
})
```

- [x] **Step 2: Run identity tests and verify RED**

Run: `node --test tests/crown-snapshot-batch.test.mjs`  
Expected: FAIL because `snapshot-batch.mjs` does not exist.

- [x] **Step 3: Implement identity helpers**

```js
export function crownIdentity(ids = {}) {
  const gid = String(ids.gid || '').trim()
  const gidm = String(ids.gidm || '').trim()
  const lid = String(ids.lid || '').trim()
  return {
    eventKey: gid ? `crown|football|gid=${gid}` : null,
    matchGroupKey: gidm ? `crown|football|gidm=${gidm}|lid=${lid || 'missing'}` : null,
    confidence: gid ? 'high' : 'low',
    providerIds: { gid: gid || null, gidm: gidm || null, hgid: ids.hgid || null, ecid: ids.ecid || null, lid: lid || null, eventId: ids.eventId || null },
  }
}

export function selectionIdentity(record) {
  return [record.event.eventKey, record.market.period, record.market.marketType, record.market.lineKey, record.selection.side].join('|')
}
```

- [x] **Step 4: Write failing batch completeness tests**

```js
test('get_game_list is authoritative only when classification is complete', () => {
  const batch = buildSnapshotBatch({ endpointKind: 'get_game_list', classification: { hasServerResponse: true, parseError: false, loginExpired: false }, records: [], eventRefs: [], capturedAt: '2026-07-10T00:00:00.000Z', request: { showtype: 'today' } })
  assert.equal(batch.completeness, 'authoritative')
  assert.equal(batch.complete, true)
})

test('get_game_more is always partial', () => {
  const batch = buildSnapshotBatch({ endpointKind: 'get_game_more', classification: { hasServerResponse: true }, records: [], eventRefs: [], capturedAt: '2026-07-10T00:00:00.000Z', request: { gid: '3001' } })
  assert.equal(batch.completeness, 'partial')
  assert.equal(batch.complete, true)
})
```

- [x] **Step 5: Implement deterministic batch IDs and scope keys**

Use `crypto.createHash('sha256')` over provider, endpoint kind, normalized request scope, capturedAt, and sorted event keys. `scopeKey` must include list type, showtype, date, rtype, and filter values; it must not include an individual detail GID for authoritative list state.

- [x] **Step 6: Expose event refs from XML normalization**

Add `normalizeCrownTransformBatch()` that parses every `<game>` into an `eventRef` before target-market filtering and returns `{ eventRefs, records }`. Keep `normalizeCrownTransformXml()` as a compatibility wrapper returning only `.records`.

- [x] **Step 7: Verify Task 2 GREEN**

Run: `node --test tests/crown-snapshot-batch.test.mjs tests/crown-transform-xml.test.mjs`  
Expected: all tests PASS, including list ECID/detail missing ECID equality.

- [x] **Step 8: Scope review checkpoint**

Confirm no betting request mapper uses the old composite event key as provider truth; preserve all provider IDs on records.

---

### Task 3: SQLite monitor state schema

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Create: `src/crown/monitor/monitor-state-store.mjs`
- Create: `tests/crown-monitor-state-store.test.mjs`
- Modify: `tests/crown-app-db.test.mjs`

- [x] **Step 1: Write failing schema tests**

```js
test('app database creates monitor v2 state tables', () => {
  const app = openAppDatabase({ dbPath: ':memory:' })
  const names = new Set(app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
  for (const name of ['monitor_scope_state', 'monitor_event_state', 'monitor_selection_state', 'monitor_signals', 'monitor_cooldowns', 'monitor_deliveries']) assert.equal(names.has(name), true)
  app.close()
})
```

- [x] **Step 2: Run schema tests and verify RED**

Run: `node --test tests/crown-app-db.test.mjs`  
Expected: FAIL because the six tables are absent.

- [x] **Step 3: Add concrete schema**

```sql
CREATE TABLE IF NOT EXISTS monitor_scope_state (
  scope_key TEXT PRIMARY KEY,
  last_batch_id TEXT NOT NULL,
  last_captured_at TEXT NOT NULL,
  last_complete_at TEXT NOT NULL,
  event_keys_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS monitor_event_state (
  event_key TEXT PRIMARY KEY,
  match_group_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  missing_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  provider_ids_json TEXT NOT NULL DEFAULT '{}',
  event_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS monitor_selection_state (
  selection_identity TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_signals (
  signal_id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_cooldowns (
  signal_key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_deliveries (
  signal_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, channel)
);
```

- [x] **Step 4: Write failing transaction and restart tests**

Create a temporary SQLite file, ingest one scope state and one selection baseline, close it, reopen it, and assert exact recovery. Add a transaction rollback test where a deliberately invalid selection row causes neither scope nor event state to persist.

- [x] **Step 5: Implement `MonitorStateStore` primitives**

Expose only focused methods:

```js
getScope(scopeKey)
getEvent(eventKey)
getSelection(selectionIdentity)
applyBatch(batch)
insertSignal(signal)
claimPendingDeliveries({ now, limit })
completeDelivery({ signalId, channel, status, errorCode, nextAttemptAt })
close()
```

Use `db.exec('BEGIN IMMEDIATE')`, `COMMIT`, and `ROLLBACK` inside `applyBatch()`.

- [x] **Step 6: Verify Task 3 GREEN**

Run: `node --test tests/crown-app-db.test.mjs tests/crown-monitor-state-store.test.mjs`  
Expected: schema, transaction, rollback, close/reopen tests PASS.

- [x] **Step 7: Scope review checkpoint**

Verify stored JSON contains normalized business data only and no cookie, password, Authorization, ticket ID, or raw HTTP headers.

---

### Task 4: Authoritative/partial state transitions and factual Change

**Files:**
- Modify: `src/crown/monitor/monitor-state-store.mjs`
- Modify: `tests/crown-monitor-state-store.test.mjs`
- Modify: `src/crown/storage/jsonl-store.mjs`

- [x] **Step 1: Write the real poll-order regression test**

```js
test('authoritative list followed by multiple details preserves every event baseline', () => {
  const first = store.applyBatch(listBatch(['A', 'B']))
  assert.deepEqual(first.changes.map((item) => item.type), ['event-added', 'event-added'])
  assert.deepEqual(store.applyBatch(detailBatch('A', 0.92)).changes, [])
  assert.deepEqual(store.applyBatch(detailBatch('B', 0.88)).changes, [])
  assert.equal(store.getEvent('A').active, true)
  assert.equal(store.getEvent('B').active, true)
  const changed = store.applyBatch(detailBatch('A', 0.96))
  assert.deepEqual(changed.changes.map((item) => item.type), ['odds-change'])
})
```

- [x] **Step 2: Run the regression and verify RED**

Run: `node --test tests/crown-monitor-state-store.test.mjs`  
Expected: FAIL because `applyBatch()` does not yet implement transitions.

- [x] **Step 3: Implement partial upsert**

For every selection in a partial batch: reject stale capturedAt, compare against the stored identity baseline, append factual odds/handicap/suspended/reopened Change, and upsert only that selection/event. Never inspect unrelated active events.

- [x] **Step 4: Add failing two-miss removal tests**

```js
test('an event is removed only after two complete authoritative misses in the same scope', () => {
  store.applyBatch(listBatch(['A', 'B']))
  assert.equal(store.applyBatch(listBatch(['A'])).changes.some((item) => item.type === 'event-removed'), false)
  const secondMiss = store.applyBatch(listBatch(['A']))
  assert.equal(secondMiss.changes.filter((item) => item.type === 'event-removed').length, 1)
  assert.equal(secondMiss.changes[0].observedAt, secondMiss.batch.capturedAt)
  assert.equal(secondMiss.changes[0].batchId, secondMiss.batch.batchId)
})
```

- [x] **Step 5: Implement authoritative scope transitions**

Update missing counts only for the same scope. Reset missing count on observation. Incomplete, login-expired, parse-error, partial, other-date, or other-showtype batches cannot increment missing counts.

- [x] **Step 6: Make schema-v2 JSONL a pure audit sink**

Add `appendSnapshots(records)` and `appendChanges(changes)` methods or an `ingestV2({ snapshots, changes })` path that never imports monitor settings and never calls `attachCandidate()`.

- [x] **Step 7: Verify Task 4 GREEN**

Run: `node --test tests/crown-monitor-state-store.test.mjs tests/crown-jsonl-store.test.mjs`  
Expected: list/detail, two-miss, scope isolation, stale input, event-without-target-market, and restart tests PASS.

- [x] **Step 8: Scope review checkpoint**

Confirm schema-v1 behavior remains available only for rollback/fixture compatibility and is not used by the default live watcher after Task 5.

---

### Task 5: Watcher schema-v2 batch integration

**Files:**
- Modify: `scripts/crown-watch.mjs`
- Create: `tests/crown-monitor-v2-integration.test.mjs`
- Modify: `tests/crown-watch-fixture.test.mjs`

- [x] **Step 1: Write failing watcher integration assertions**

Run a fixture sequence containing list A+B, detail A, detail B, and a later changed detail A. Assert v2 changes contain one A odds-change and no detail-driven event removals.

- [x] **Step 2: Run integration tests and verify RED**

Run: `node --test tests/crown-monitor-v2-integration.test.mjs`  
Expected: FAIL because watcher still calls `store.ingest()` per response.

- [x] **Step 3: Add v2 runtime paths**

```js
const V2_SNAPSHOT_FILE = 'crown-odds-snapshots-v2.jsonl'
const V2_CHANGE_FILE = 'crown-odds-changes-v2.jsonl'
```

Leave existing v1 files untouched. `makeStore()` must construct a v2 audit sink plus `MonitorStateStore` using `args.appDbPath`.

- [x] **Step 4: Build one pollId and batch per response**

At the start of `pollOnce()`, create one UUID pollId. Pass it to list and every detail `normalizeDirectXml()` call. Convert classification + normalized event refs/records + normalized request scope into a `SnapshotBatch` and apply it transactionally.

- [x] **Step 5: Stop using filtered markets as provider lifecycle input**

Feed every XML `<game>` eventRef to state before default-league or tracked-match policy. Continue filtering Strategy scope later.

- [x] **Step 6: Verify Task 5 GREEN**

Run: `node --test tests/crown-monitor-v2-integration.test.mjs tests/crown-watch-fixture.test.mjs tests/crown-transform-xml.test.mjs`  
Expected: all tests PASS; `get_game_more` produces real baseline changes and zero unrelated removals.

- [x] **Step 7: Scope review checkpoint**

Search: `rg -n "store\.ingest\(|notifyChanges\.cooldownState" scripts/crown-watch.mjs`  
Expected after later strategy migration: no live-v2 use of schema-v1 ingest; temporary compatibility call sites must be explicitly marked fixture/rollback only.

---

### Task 6: Pure Strategy Registry and migrated odds-delta rule

**Files:**
- Create: `src/crown/monitor/strategy-registry.mjs`
- Create: `src/crown/monitor/odds-delta-strategy.mjs`
- Create: `tests/crown-strategy-engine.test.mjs`
- Modify: `src/crown/monitor/monitor-settings.mjs`

- [x] **Step 1: Write failing strategy type/scope tests**

```js
test('odds_delta accepts only odds-change and fails closed without kickoff time', () => {
  const rule = legacyMonitorRule(settings)
  assert.equal(evaluateOddsDelta(handicapChange(), { rule }).skipReason, 'unsupported-change-type')
  assert.equal(evaluateOddsDelta(prematchOddsChange({ startTimeUtc: null }), { rule }).skipReason, 'data_incomplete:start_time_missing')
})

test('registered strategies evaluate independently', () => {
  const engine = new StrategyRegistry().register('odds_delta', evaluateOddsDelta)
  const result = engine.evaluate(oddsChange(), { rules: [ruleA, ruleB] })
  assert.equal(result.length, 2)
})
```

- [x] **Step 2: Run strategy tests and verify RED**

Run: `node --test tests/crown-strategy-engine.test.mjs`  
Expected: FAIL because registry/evaluator files are absent.

- [x] **Step 3: Implement the registry**

```js
export class StrategyRegistry {
  #evaluators = new Map()
  register(type, evaluator) {
    if (this.#evaluators.has(type)) throw new Error(`strategy-already-registered:${type}`)
    this.#evaluators.set(type, evaluator)
    return this
  }
  evaluate(change, context) {
    return context.rules.flatMap((rule) => {
      const evaluator = this.#evaluators.get(rule.type)
      if (!evaluator || !rule.enabled) return []
      const decision = evaluator(change, { ...context, rule })
      return decision.matched ? [decision] : []
    })
  }
}
```

- [x] **Step 4: Implement the legacy settings adapter**

Convert the active handicap/live card to an `odds_delta` rule with explicit mode, market `[asian_handicap,total]`, periods, direction, odds range, kickoff/live windows, cooldown seconds, version, and bettingRuleId. Preserve manual tracked-match whitelist bypass.

- [x] **Step 5: Implement `evaluateOddsDelta()` as a pure function**

It must return `{ matched:false, skipReason, dataQuality }` or `{ matched:true, trigger, target, evidence }`. It must not mutate cooldown, write files, call Telegram, or build a betting candidate.

- [x] **Step 6: Verify Task 6 GREEN**

Run: `node --test tests/crown-strategy-engine.test.mjs tests/crown-monitor-settings.test.mjs`  
Expected: all rule scope, time fail-closed, market type, direction, odds range, league, tracked-match, and multi-rule tests PASS.

- [x] **Step 7: Scope review checkpoint**

Confirm the storage layer no longer imports `monitor-settings.mjs` in the v2 path.

---

### Task 7: Deterministic Signal, persistent dedupe, and cooldown

**Files:**
- Create: `src/crown/monitor/signal.mjs`
- Modify: `src/crown/monitor/monitor-state-store.mjs`
- Modify: `tests/crown-strategy-engine.test.mjs`
- Modify: `tests/crown-monitor-state-store.test.mjs`

- [x] **Step 1: Write failing deterministic ID tests**

```js
test('the same rule and Change always produce one Signal ID', () => {
  const first = createSignal({ rule, change, decision })
  const second = createSignal({ rule, change, decision })
  assert.equal(first.signalId, second.signalId)
  assert.equal(first.signalKey, `${rule.id}|${change.selectionIdentity}`)
})
```

- [x] **Step 2: Run Signal tests and verify RED**

Run: `node --test tests/crown-strategy-engine.test.mjs`  
Expected: FAIL because `createSignal()` is absent.

- [x] **Step 3: Implement stable hashes**

Use canonical JSON field order and SHA-256. `changeId` includes batchId, selection identity, change type, old capturedAt/value, and next capturedAt/value. `signalId` includes strategy id/version, changeId, direction, and threshold.

- [x] **Step 4: Write failing replay/cooldown restart tests**

Insert the same Signal twice and assert one row. Close/reopen SQLite and assert cooldown still suppresses the same signalKey until expiry but not another strategy ID.

- [x] **Step 5: Implement atomic Signal insertion**

Within one transaction: `INSERT OR IGNORE monitor_signals`, add required channel delivery rows, and upsert cooldown only when a new Signal row is inserted. Expired cooldown rows are deleted in bounded batches.

- [x] **Step 6: Verify Task 7 GREEN**

Run: `node --test tests/crown-strategy-engine.test.mjs tests/crown-monitor-state-store.test.mjs`  
Expected: deterministic, replay, cross-strategy isolation, expiry, and restart tests PASS.

- [x] **Step 7: Scope review checkpoint**

Verify Signal evidence contains only normalized snapshots, not session headers or raw provider responses.

---

### Task 8: Persisted non-blocking AlertDispatcher

**Files:**
- Create: `src/crown/monitor/alert-dispatcher.mjs`
- Create: `tests/crown-alert-dispatcher.test.mjs`
- Modify: `src/crown/alerts/telegram-alert.mjs`
- Modify: `scripts/crown-watch.mjs`

- [x] **Step 1: Write failing retry and non-blocking tests**

Use an injected sender that fails once and then succeeds. Assert the first dispatch records `retry`, the second records `sent`, attempts become 2, and watcher batch processing returns before a deliberately unresolved sender promise.

- [x] **Step 2: Run dispatcher tests and verify RED**

Run: `node --test tests/crown-alert-dispatcher.test.mjs`  
Expected: FAIL because dispatcher is absent.

- [x] **Step 3: Implement a bounded worker**

```js
export class AlertDispatcher {
  constructor({ store, senders, pollMs = 250, batchSize = 20, maxAttempts = 4 }) {
    this.store = store
    this.senders = senders
    this.pollMs = pollMs
    this.batchSize = batchSize
    this.maxAttempts = maxAttempts
    this.stopped = true
    this.timer = null
    this.running = null
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }
  schedule(delay) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = null
        this.schedule(this.pollMs)
      })
    }, delay)
    this.timer.unref?.()
  }
  async tick(now = new Date().toISOString()) {
    const deliveries = this.store.claimPendingDeliveries({ now, limit: this.batchSize })
    await Promise.allSettled(deliveries.map(async (delivery) => {
      const sender = this.senders[delivery.channel]
      if (!sender) {
        this.store.completeDelivery({ ...delivery, status: 'dead-letter', errorCode: 'channel-not-configured', nextAttemptAt: now })
        return
      }
      try {
        await sender(delivery.signal)
        this.store.completeDelivery({ ...delivery, status: 'sent', errorCode: '', nextAttemptAt: now })
      } catch (error) {
        const attempts = delivery.attempts + 1
        const delays = [5, 15, 45]
        const exhausted = attempts >= this.maxAttempts
        const nextAttemptAt = exhausted ? now : new Date(Date.parse(now) + delays[Math.min(attempts - 1, delays.length - 1)] * 1000).toISOString()
        this.store.completeDelivery({ ...delivery, attempts, status: exhausted ? 'dead-letter' : 'retry', errorCode: error.code || 'delivery-failed', nextAttemptAt })
      }
    }))
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.running) await this.running
  }
}
```

Retry delays are 5s, 15s, 45s; attempt 4 becomes `dead-letter`. Configuration errors use a stable error code and do not expose Token values.

- [x] **Step 4: Render Telegram from Signal**

Keep current change templates compatible, but include strategy name/version, signal ID prefix, trigger threshold, and data-quality warnings. The sender receives a Signal payload and masked config.

- [x] **Step 5: Remove synchronous Telegram from ingestion**

Watcher persists Signal and returns to polling. Dispatcher owns Telegram network waits. Console delivery can be synchronous but records a delivery result.

- [x] **Step 6: Verify Task 8 GREEN**

Run: `node --test tests/crown-alert-dispatcher.test.mjs tests/crown-alerts.test.mjs tests/crown-monitor-v2-integration.test.mjs`  
Expected: retries, dead-letter, restart recovery, redaction, and non-blocking ingestion PASS.

- [x] **Step 7: Scope review checkpoint**

Confirm no unbounded in-memory queue exists; SQLite is the durable queue and each tick is bounded.

---

### Task 9: Signal-driven deterministic betting candidates

**Files:**
- Modify: `src/crown/betting/monitor-bet-signal.mjs`
- Modify: `tests/crown-monitor-bet-signal.test.mjs`
- Modify: `scripts/crown-watch.mjs`

- [x] **Step 1: Write failing candidate idempotency tests**

```js
test('one Signal and betting rule produce one deterministic candidate ID', () => {
  const a = buildMonitorBetCandidateFromSignal(signal, { bettingRule, findLatestSelection })
  const b = buildMonitorBetCandidateFromSignal(signal, { bettingRule, findLatestSelection })
  assert.equal(a.candidateId, b.candidateId)
  assert.equal(a.signalId, signal.signalId)
})
```

- [x] **Step 2: Run candidate tests and verify RED**

Run: `node --test tests/crown-monitor-bet-signal.test.mjs`  
Expected: FAIL because Signal-based builder is absent.

- [x] **Step 3: Implement the Signal-based builder**

Candidate ID is SHA-256 of `signalId|bettingRuleId`. Preserve follow/reverse, same lineKey lookup, suspended check, target odds check, and minOdds. Add `expiresAt`, strategy metadata, dataQuality, and canonical identities.

- [x] **Step 4: Remove implicit first-enabled rule selection**

Watcher must use `signal.bettingRuleId`. If absent or not found, persist a skipped candidate with `betting-rule-unbound`; never call `listBettingRules().find(rule => rule.enabled)` for v2 signals.

- [x] **Step 5: Make JSONL candidate append idempotent**

Before append, keep a bounded SQLite candidate index or store candidates in a new `monitor_candidates` table keyed by candidateId, then export to JSONL only on first insert. Do not scan the whole candidate JSONL.

- [x] **Step 6: Verify Task 9 GREEN**

Run: `node --test tests/crown-monitor-bet-signal.test.mjs tests/crown-monitor-v2-integration.test.mjs tests/crown-betting-candidate-dry-run.test.mjs`  
Expected: deterministic candidate, rule binding, replay, reverse-line, stale/expiry, and dry-run compatibility tests PASS.

- [x] **Step 7: Safety search**

Run: `rg -n "CrownBetAdapter|FT_bet|submitBet" scripts/crown-watch.mjs src/crown/monitor`  
Expected: zero real execution imports/calls.

---

### Task 10: Dashboard v2 state and data-quality visibility

**Files:**
- Modify: `src/crown/dashboard/dashboard-data.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `tests/crown-dashboard-data.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/MonitorSettings.tsx`
- Modify: `frontend/src/pages/MatchSelection.tsx`
- Modify: relevant frontend tests

- [x] **Step 1: Write failing backend v2 preference tests**

Provide both contaminated v1 and clean v2 files. Assert Dashboard summary/events/changes prefer v2, expose `schemaVersion:2`, and return monitor state counts, pending/dead-letter delivery counts, last authoritative batch, and incomplete-data skip totals.

- [x] **Step 2: Run backend tests and verify RED**

Run: `node --test tests/crown-dashboard-data.test.mjs tests/crown-app-api.test.mjs`  
Expected: FAIL because v2 data/state fields are absent.

- [x] **Step 3: Implement backend v2 reads**

Keep v1 fallback only when v2 files do not exist. Never merge v1 event-added/removed counts into v2 health. Query SQLite state with bounded aggregate statements.

- [x] **Step 4: Write failing frontend visibility tests**

Assert the monitor page renders “数据不完整：缺少开赛时间”, “待发送告警”, “投递失败”, and “最后权威批次”, and does not label raw Change as a betting candidate.

- [x] **Step 5: Run frontend tests and verify RED**

Run: `npm --prefix frontend run test -- MonitorSettings MatchSelection`  
Expected: failing text/field assertions.

- [x] **Step 6: Implement minimal UI additions**

Add one monitor-health section and data-quality tags to existing pages. Do not redesign navigation or add the C-stage mobile console here.

- [x] **Step 7: Verify Task 10 GREEN**

Run: `node --test tests/crown-dashboard-data.test.mjs tests/crown-app-api.test.mjs && npm --prefix frontend run test && npm --prefix frontend run build`  
Expected: backend and frontend tests PASS; production build succeeds.

- [x] **Step 8: Browser verification**

Start the local Dashboard against a temporary v2 fixture and use Playwright/Browser to inspect desktop and narrow viewport. Verify no console errors and capture evidence under ignored `output/playwright/`.

---

### Task 11: Migration, rollback, and operational safety

**Files:**
- Modify: `scripts/crown-watch.mjs`
- Modify: `README.md`
- Modify: `docs/modules/crown-football-monitor.md`
- Modify: `docs/crown-current-architecture.md`
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Create: `docs/crown-monitor-v2-runbook.md`

- [x] **Step 1: Add a dry initialization test**

Start watcher v2 from a temporary runtime and database. Assert first authoritative/detail observations create baselines but zero odds signals; second changed observation creates exactly one Signal.

- [x] **Step 2: Add rollback flag behavior**

Support `--monitor-state-version 2` as default and explicit `--monitor-state-version 1` rollback. The v1 flag writes only old paths and prints a high-visibility warning that its event lifecycle is deprecated.

- [x] **Step 3: Preserve old files**

Do not rename, delete, truncate, or rewrite existing v1 runtime files. Document them as contaminated historical evidence. V2 filenames and SQLite tables are additive.

- [x] **Step 4: Write the runbook**

Include startup, first-baseline warmup, v2 file/table locations, health interpretation, dead-letter handling, rollback, backup, and verification commands. Do not include usernames, passwords, cookies, actual Telegram tokens, or local absolute paths.

- [x] **Step 5: Update architecture and memory docs**

Mark schema-v1 behavior as legacy, describe the exact Change/Signal boundary, record validation results, and update independent/strongly-bound module relationships.

- [x] **Step 6: Verify docs and safety boundaries**

Run secret-format and local-path scans over all Git candidates. Expected: zero actual secret-format hits and zero local user directory paths.

---

### Task 12: Full A-stage verification and acceptance audit

**Files:**
- Modify only files required by failures found during verification
- Update: `docs/project-memory.md`
- Update: `docs/repository-publication-audit.md`

- [x] **Step 1: Run focused monitor tests**

```powershell
node --test tests\crown-time.test.mjs tests\crown-snapshot-batch.test.mjs tests\crown-monitor-state-store.test.mjs tests\crown-strategy-engine.test.mjs tests\crown-alert-dispatcher.test.mjs tests\crown-monitor-v2-integration.test.mjs
```

Expected: zero failures.

- [x] **Step 2: Run the complete backend suite and syntax check**

```powershell
npm test
npm run check
```

Expected: zero test failures and syntax check exit 0.

- [x] **Step 3: Run the complete frontend suite and build**

```powershell
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: zero test failures and production build exit 0.

- [x] **Step 4: Run deterministic fixture replay twice**

Run the same list/detail sequence twice against a fresh DB and compare Change IDs, Signal IDs, and candidate IDs. Expected: exact equality and no duplicate persisted rows.

- [x] **Step 5: Run restart and failure injection**

Stop after pending Telegram delivery, reopen the state DB, run dispatcher, and verify delivery resumes without a second Signal/candidate. Inject incomplete list, login-expired HTML, stale detail, and Telegram timeout; none may corrupt active/baseline state.

- [x] **Step 6: Run a controlled real-data monitor short run**

Use the configured monitor account for read-only list/detail polling only. Real bet submission remains disabled. Verify:

- detail batches produce no unrelated event removal;
- list/detail with same GID share eventKey;
- time and live minute parse rates are reported;
- no Cookie, password, token, storageState, Authorization, ticket, or raw session appears in logs/API/v2 JSONL;
- no request is classified as bet preview or submit.

- [x] **Step 7: Audit every design acceptance item**

Re-read `docs/superpowers/specs/2026-07-10-crown-monitor-core-redesign.md` section 15. For each bullet, record the exact test, query, log, or browser evidence proving it. Any missing evidence keeps A incomplete.

- [x] **Step 8: Request code review**

Use `requesting-code-review` Skill for correctness and scope review. Resolve every verified P0/P1 finding and rerun affected tests.

- [x] **Step 9: Update phase status**

Only after all evidence passes, mark A complete in `docs/project-memory.md` and move the active plan to B design. Do not mark the overall project goal complete.

Execution note: the user explicitly requested a pause once A12 is usable, so A is marked complete but B/C are not activated in this session.

---

## Plan self-review

### Spec coverage

- SnapshotBatch, authoritative/partial, scope isolation: Tasks 2, 4, 5.
- Canonical identities and ECID mismatch: Task 2.
- SQLite restart/checkpoint and stale input: Tasks 3, 4.
- Kickoff/live clock and fail-closed rules: Tasks 1, 6.
- Pure Change and single strategy semantics: Tasks 4, 6.
- Deterministic Signal, cooldown, dedupe: Task 7.
- Non-blocking persisted delivery: Task 8.
- Explicit betting-rule binding and deterministic candidate: Task 9.
- Dashboard observability: Task 10.
- Additive migration, rollback, docs: Task 11.
- Full acceptance and controlled real-data verification: Task 12.

### Type consistency

- Canonical keys: `matchGroupKey`, `eventKey`, `marketIdentity`, `selectionIdentity`.
- Batch keys: `schemaVersion`, `batchId`, `pollId`, `scopeKey`, `completeness`, `complete`, `eventRefs`, `oddsRecords`.
- Signal keys: `signalId`, `signalKey`, `strategyId`, `strategyVersion`, `observedAt`, `expiresAt`, `trigger`, `target`, `evidence`, `bettingRuleId`, `dataQuality`.
- Persistent delivery states: `pending`, `retry`, `sent`, `dead-letter`.

### Execution handoff

After explicit design approval, execute in the current task using `superpowers:subagent-driven-development` with review between tasks. A dedicated worktree can be created only after the user authorizes the initial Git commit; until then, preserve the current workspace and do not commit automatically.
