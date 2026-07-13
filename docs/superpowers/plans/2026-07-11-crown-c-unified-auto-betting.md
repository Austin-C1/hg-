# Crown C Unified Auto Betting Implementation Plan

> 历史状态：本文件中的固定赛前/滚球投注设置或统一监控投注规则已被
> `docs/superpowers/specs/2026-07-12-crown-dynamic-betting-rule-cards-design.md` 取代。
> 其余历史验收证据保留，不作为当前实现入口。

> 状态：C Task 1–11 已完成。本计划中的逐步 checkbox 是历史执行模板；当前完成证据以 `.superpowers/sdd/progress.md`、`docs/project-memory.md` 和最终测试结果为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one configurable monitor-to-bet rule flow, activate evidence-gated Crown automatic betting, add account pause/enable controls, and finish with a responsive operations console.

**Architecture:** Extend the existing `betting_rules` table into the canonical auto-bet rule instead of introducing a hidden StrategyRule↔BettingRule binding. The watcher evaluates those rules and atomically claims a one-bet-per-market key; the existing B2 batch, child, immutable submit-attempt and reconciliation ledger remains the execution authority. User-configured amounts are integer CNY, while provider preview min/max/step remain automatic execution constraints.

**Tech Stack:** Node.js 22 ESM, `node:sqlite`, React 18, TypeScript, Ant Design 5, Vitest, Node test runner, Playwright.

## Global Constraints

- Implementation order is C1 unified rules, C2 real protocol/runtime, C3 account controls, then C4 operations console.
- Betting direction is fixed reverse: home↔away and over↔under.
- Target odds range is checked against the actual reverse selection exactly once when the betting candidate is created.
- Event/mode/period/market/line/actual-side identity is rechecked before every account submit; a line change cancels all provably unsent remainder.
- One `event + mode + period + marketType + line + actualSide` may create at most one batch for its lifetime.
- Accounts are filled in bet order; partial target completion is allowed; rejected money is not reallocated.
- `unknown` is never retried, keeps its reserved amount and account lock, and enters reconciliation.
- No daily stake cap and no first-order auto-stop are introduced.
- User account configuration has no amount precision or betting step. Currency is CNY and user amounts are integer scale 0.
- Provider preview min/max/step are still mandatory automatic gates and remain stored in attempt evidence.
- Account pause stops new allocation but lets its existing queue finish.
- Global real-betting intent persists across restart; runtime resumes only after fresh preflight.
- Dashboard remains loopback-only and passwordless by default; same-origin Host/Origin/CSRF protections remain.
- No password, cookie, uid, ticket, token, authorization phrase, or plain provider reference may enter API responses, UI state, logs, or public fixtures.
- No Git commit is created unless the user explicitly requests it. Each task ends with tests and a diff checkpoint.

---

## C1 — Unified Monitor-to-Bet Rules

### Task 1: Canonical schema and deterministic migration

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Create: `src/crown/betting/auto-bet-rule.mjs`
- Create: `tests/crown-auto-bet-rule-schema.test.mjs`
- Modify: `tests/crown-app-db.test.mjs`

**Interfaces:**
- Produces `normalizeAutoBetRule(input, options)` and `reverseSelectionSide(side)`.
- Extends `betting_rules` with canonical monitor fields and migration review state.
- Adds `bet_market_once_claims` with a unique `market_once_key`.
- Adds `real_betting_runtime` singleton storage and account `allocation_status`.

- [ ] **Step 1: Write failing migration tests**

Test a fresh database and a copied legacy database. Assert:

```js
assert.equal(rule.currency, 'CNY')
assert.equal(rule.amount_scale, 0)
assert.equal(rule.priority, 1)
assert.equal(rule.real_betting_enabled, 0)
assert.equal(rule.migration_review_required, 1)
assert.equal(db.prepare('SELECT archived FROM betting_rules WHERE id=?').get('brule_manual').archived, 1)
```

Also assert repeated `openAppDatabase()` does not duplicate `legacy-prematch`, `legacy-live`, runtime singleton, or market-once rows.

- [ ] **Step 2: Run the RED test**

Run:

```powershell
node --test tests/crown-auto-bet-rule-schema.test.mjs tests/crown-app-db.test.mjs
```

Expected: FAIL because the canonical columns/tables and normalizer do not exist.

- [ ] **Step 3: Add schema columns and guards**

Add columns equivalent to:

```sql
priority INTEGER NOT NULL DEFAULT 1,
monitor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitor_enabled IN (0,1)),
real_betting_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_betting_enabled IN (0,1)),
archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
mode TEXT NOT NULL DEFAULT 'prematch' CHECK (mode IN ('prematch','live')),
period TEXT NOT NULL DEFAULT 'full' CHECK (period IN ('full','first_half','second_half')),
market_type TEXT NOT NULL DEFAULT 'asian_handicap' CHECK (market_type IN ('asian_handicap','total')),
monitored_side TEXT NOT NULL DEFAULT 'home' CHECK (monitored_side IN ('home','away','over','under')),
min_water_rise TEXT NOT NULL DEFAULT '0.01',
target_odds_min TEXT NOT NULL DEFAULT '0',
target_odds_max TEXT NOT NULL DEFAULT '2',
migration_review_required INTEGER NOT NULL DEFAULT 0 CHECK (migration_review_required IN (0,1))
```

Keep legacy amount/step columns for backward database compatibility; migrate rule/account user amounts to scale 0 and account step 1 without using those account fields as provider authority.

- [ ] **Step 4: Implement exact normalization**

`normalizeAutoBetRule` must reject incompatible side/market pairs, non-integer CNY target amounts, invalid time windows, empty league lists on enable, and `realBettingEnabled=true` while `monitorEnabled=false`.

- [ ] **Step 5: Run GREEN and inspect migration**

Run the focused tests again. Then open `storage/crown.sqlite` read-only and assert it contains two disabled migration templates and no enabled real rule.

- [ ] **Step 6: Diff checkpoint**

Run `git diff -- src/crown/app/app-db.mjs src/crown/betting/auto-bet-rule.mjs tests/crown-auto-bet-rule-schema.test.mjs tests/crown-app-db.test.mjs`. Do not commit.

---

### Task 2: Repository, API, versioning and priority reorder

**Files:**
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Create: `tests/crown-auto-bet-rule-api.test.mjs`
- Modify: `tests/crown-app-repository.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- Produces repository methods `listAutoBetRules`, `createAutoBetRule`, `updateAutoBetRule`, `cloneAutoBetRule`, `reorderAutoBetRules`, `setAutoBetRuleMonitorEnabled`, `setAutoBetRuleRealEnabled`, and `archiveAutoBetRule`.
- Produces the `/api/app/auto-bet-rules` endpoints from design section 12.

- [ ] **Step 1: Write failing CRUD/CAS tests**

Cover create, integer target validation, exact league names, clone, archive, enable gates, monitor/real switch separation, and stale `expectedVersion` returning stable `auto-bet-rule-version-conflict`.

- [ ] **Step 2: Write failing reorder tests**

Submit ordered ids and assert a single transaction rewrites priorities to `1..N`, increments versions of changed rules, rejects duplicate/missing ids, and never leaves duplicate priorities after concurrent calls.

- [ ] **Step 3: Verify RED**

Run:

```powershell
node --test tests/crown-auto-bet-rule-api.test.mjs tests/crown-app-repository.test.mjs tests/crown-app-api.test.mjs
```

- [ ] **Step 4: Implement repository transactions and API routes**

Use `BEGIN IMMEDIATE` for CAS and reorder. API DTOs expose decimal odds strings and integer target amounts, but no legacy `amountScale`, `stakeStep`, `bettingRuleId`, secret, or execution authorization material.

- [ ] **Step 5: Verify GREEN and security projection**

Run the focused tests and `node --test tests/crown-dashboard-security.test.mjs`. Search JSON fixtures/expected payloads for forbidden fields.

- [ ] **Step 6: Diff checkpoint**

Review the exact files above; do not commit.

---

### Task 3: Watcher hot-load, priority winner and one-market claim

**Files:**
- Modify: `src/crown/monitor/odds-delta-strategy.mjs`
- Modify: `src/crown/monitor/strategy-registry.mjs`
- Modify: `src/crown/betting/monitor-bet-signal.mjs`
- Create: `src/crown/betting/market-once-store.mjs`
- Modify: `scripts/crown-watch.mjs`
- Create: `tests/crown-auto-bet-rule-watcher.test.mjs`
- Modify: `tests/crown-strategy-engine.test.mjs`
- Modify: `tests/crown-monitor-bet-signal.test.mjs`

**Interfaces:**
- Produces `marketOnceKey(change, actualSide)` and `claimMarketOnce(database, claim)`.
- Watcher reads one atomic revision snapshot from SQLite and emits ranked rule matches.

- [ ] **Step 1: Write failing reverse-odds tests**

Assert a home-water rise derives away, an over-water rise derives under, and `targetOddsMin/Max` are tested against the reverse selection price rather than the monitored selection price.

- [ ] **Step 2: Write failing priority and idempotency tests**

For two matching rules, assert both match audits exist but only priority 1 owns the market key and produces a Candidate/Batch trigger. Replay, restart, rejected, partial, and unknown must not create a second claim. A changed line must produce a distinct key.

- [ ] **Step 3: Verify RED**

Run:

```powershell
node --test tests/crown-auto-bet-rule-watcher.test.mjs tests/crown-strategy-engine.test.mjs tests/crown-monitor-bet-signal.test.mjs
```

- [ ] **Step 4: Implement atomic rule reload and claim**

Load all enabled rules, validate the full set, and atomically replace last-known-good only when every row is valid. Sort by `priority, createdAt, id`; use the unique `market_once_key` insert as the winner decision.

- [ ] **Step 5: Retire old writable monitor strategy cards**

Keep watcher scan interval/global health in `monitor-settings.json`, but stop consuming prematch/live rule conditions from it. Old write routes return `monitor-rule-config-retired` without modifying JSON.

- [ ] **Step 6: Verify GREEN and watcher fixture regression**

Run focused tests plus:

```powershell
node --test tests/crown-monitor-settings.test.mjs tests/crown-watch-fixture.test.mjs tests/crown-monitor-v2-integration.test.mjs
```

- [ ] **Step 7: Diff checkpoint**

Review only watcher/rule/claim changes; do not commit.

---

## C2 — Allocation and Real Execution Runtime

### Task 4: Integer account contract and ordered partial allocator

**Files:**
- Modify: `src/crown/betting/stake-allocator.mjs`
- Modify: `src/crown/betting/multi-account-bet-coordinator.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `tests/crown-stake-allocator.test.mjs`
- Modify: `tests/crown-multi-account-bet-coordinator.test.mjs`
- Modify: `tests/crown-app-repository.test.mjs`

**Interfaces:**
- `allocateStake(targetMinor, accounts)` returns `{ allocations, allocatedMinor, unfilledMinor }` in stable account order.
- Account CRUD accepts `perBetLimit` as a positive integer CNY string and no longer accepts user `amountScale` or `stakeStep`.

- [ ] **Step 1: Write failing allocation examples**

Use exact cases:

```js
// target 100, limits 60 and 50 => 60 + 40
// target 100, total spendable 80 => allocate 80, unfilled 20
// remaining 37, limit 50 => allocate 37
// account order 2 never allocates before eligible order 1
```

- [ ] **Step 2: Write failing account API compatibility tests**

Assert legacy 0 step no longer blocks allocation, API output omits step/precision, and non-integer user amount is rejected with `integer-cny-required`.

- [ ] **Step 3: Verify RED**

Run the three focused test files.

- [ ] **Step 4: Implement integer allocation**

Remove account-step rounding from allocator. Compute spendable as confirmed balance minus reserved/unknown amount; provider preview step remains a later executor constraint.

- [ ] **Step 5: Preserve atomic reservation**

Within one `BEGIN IMMEDIATE`, create Batch/Children, reserve all chosen amounts, and lock all chosen accounts. If any insert/reservation fails, roll back the whole combination and leave the market-once audit with an explicit allocation failure.

- [ ] **Step 6: Verify GREEN and B1 regressions**

Run focused tests plus `tests/crown-betting-b1-integration.test.mjs` and `tests/crown-bet-batch-store.test.mjs`.

- [ ] **Step 7: Diff checkpoint**

Review allocation/account contract changes; do not commit.

---

### Task 5: Persistent real-betting intent and startup preflight

**Files:**
- Create: `src/crown/betting/real-betting-runtime.mjs`
- Create: `src/crown/app/betting-process.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `scripts/crown-dashboard.mjs`
- Modify: `scripts/crown-betting-worker.mjs`
- Create: `tests/crown-real-betting-runtime.test.mjs`
- Create: `tests/crown-betting-process.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- Produces `getRealBettingStatus`, `requestRealBettingStart`, `requestRealBettingStop`, and `evaluateRealBettingPreflight`.
- Runtime states: `off`, `armed_waiting`, `running`, `blocked`, `stopping`.

- [ ] **Step 1: Write failing persistence tests**

Assert start intent survives close/reopen, restarts into `armed_waiting`, and does not enter running until watcher freshness, monitor login, account freshness, capability, authorization, schema and lease checks all pass.

- [ ] **Step 2: Write failing stop tests**

Assert stop prevents new market claims/Batches and cancels provably unsent work, while dispatched/unknown attempts remain scheduled for reconciliation.

- [ ] **Step 3: Verify RED**

Run the three focused test files.

- [ ] **Step 4: Implement singleton runtime and fenced worker management**

Persist requested intent separately from derived runtime state. Use the existing runtime-lease pattern with a distinct canonical betting-worker lease key. Never infer running from PID alone.

- [ ] **Step 5: Add Dashboard endpoints**

Implement status/start/stop endpoints with local-trust CSRF and same-origin validation. Start returns `armed_waiting` when any preflight item is not ready and exposes only stable Chinese-safe reason codes.

- [ ] **Step 6: Verify GREEN and process isolation**

Run focused tests plus `tests/crown-runtime-lease.test.mjs`, `tests/crown-dashboard-security.test.mjs`, and `tests/crown-monitor-process.test.mjs`.

- [ ] **Step 7: Diff checkpoint**

Review runtime/process changes; do not commit or start the live betting worker.

---

### Task 6: Evidence-gated Crown preview, submit and reconciliation capability

**Files:**
- Modify: `src/crown/betting/crown-capability-matrix.mjs`
- Modify: `src/crown/betting/crown-order-field-mapper.mjs`
- Modify: `src/crown/betting/crown-bet-response-parser.mjs`
- Modify: `src/crown/betting/crown-account-provider.mjs`
- Modify: `src/crown/betting/crown-account-execution-provider.mjs`
- Modify: `src/crown/betting/b2-reconciler.mjs`
- Modify: `scripts/crown-betting-protocol-analyze.mjs`
- Add: `data/fixtures/crown/betting-protocol/` sanitized evidence files
- Modify: `docs/crown-betting-protocol-map.md`
- Modify: `tests/crown-capability-matrix.test.mjs`
- Modify: `tests/crown-order-field-mapper.test.mjs`
- Modify: `tests/crown-bet-response-parser.test.mjs`
- Modify: `tests/crown-account-provider.test.mjs`
- Modify: `tests/crown-betting-b2-reconciliation.test.mjs`

**Interfaces:**
- Every capability row carries `evidenceId`, request/response field fingerprints, mode, period, marketType, lineVariant, previewAllowed, submitAllowed and reconciliationAllowed.
- `assertCrownCapability(value, { operation })` remains the sole production authority.

- [ ] **Step 1: Audit current private captures without exposing them**

Run the analyzer against each existing betting protocol capture. Produce only sanitized field names, stable hashes, response codes and redacted fixture bodies. Do not copy usernames, passwords, uid, cookies, ticket or provider reference into source/docs.

- [ ] **Step 2: Write failing capability tests per evidenced combination**

For each fixture, assert exact request mapper fields and response parser output. Assert any changed/missing field fingerprint blocks that row. Keep all unevidenced combinations false.

- [ ] **Step 3: Verify RED**

Run the five focused capability/provider test files.

- [ ] **Step 4: Implement only proven mapper/parser rows**

Map locked event/mode/period/market/line/actualSide to preview and submit payloads using exact evidence. Parse accepted/rejected/pending and reconciliation evidence with fail-closed unknown handling.

- [ ] **Step 5: Perform read-only live preview acceptance**

With the betting worker still stopped, use enabled account credentials to call login, game list, member data and evidenced order preview only. Verify the audit contains zero submit calls. Record sanitized provider min/max/step/line/odds/balance fingerprints.

- [ ] **Step 6: Capability gate decision**

If exact submit evidence is absent or preview identity does not match, keep `submitAllowed=false` and record `crown-submit-evidence-missing`; do not weaken the gate. If exact evidence is present, enable only the matching rows and bump the matrix version.

- [ ] **Step 7: Verify GREEN and secret scan**

Run focused tests, `tests/crown-betting-security-audit.test.mjs`, and search public fixtures/docs for forbidden secret fields.

- [ ] **Step 8: Diff checkpoint**

Review capability evidence and code; do not start real betting.

---

### Task 7: Queue execution semantics, line recheck and no rejected redistribution

**Files:**
- Modify: `src/crown/betting/betting-worker.mjs`
- Modify: `src/crown/betting/b2-executor.mjs`
- Modify: `src/crown/betting/bet-batch-store.mjs`
- Modify: `src/crown/betting/multi-account-bet-coordinator.mjs`
- Modify: `src/crown/betting/b2-reconciler.mjs`
- Modify: `tests/crown-betting-worker.test.mjs`
- Modify: `tests/crown-betting-b2-executor.test.mjs`
- Modify: `tests/crown-bet-batch-store.test.mjs`
- Modify: `tests/crown-betting-b2-reconciliation.test.mjs`

**Interfaces:**
- Candidate snapshot stores the one-time reverse-selection odds decision.
- Preview/submit recheck identity but does not re-run rule target odds range.
- Rejected child becomes terminal/unfilled without allocator re-entry.

- [ ] **Step 1: Write failing one-time-odds tests**

Assert candidate creation fails outside target odds range. After creation, change only odds and assert submit proceeds; change line, period, market, event or actualSide and assert all unsent remainder is cancelled.

- [ ] **Step 2: Write failing outcome tests**

Assert rejected releases its amount/lock and is never reassigned; accepted releases lock and counts amount; unknown keeps amount/lock and is never submitted again across restart.

- [ ] **Step 3: Verify RED**

Run the four focused test files.

- [ ] **Step 4: Implement queue behavior**

Keep single-account serialization and cross-account concurrency. Permit existing queued work for `pause_pending`; reject all new allocation to it. Persist outcome before releasing accepted/rejected locks.

- [ ] **Step 5: Verify every crash boundary**

Re-run B2 executor/reconciliation/security tests, including crash after prepare, after dispatch and before result persistence. Network submit count must remain one per immutable attempt.

- [ ] **Step 6: Diff checkpoint**

Review execution state transitions; do not start real betting.

---

## C3 — Account Controls and Unified UI

### Task 8: Account pause/enable actions

**Files:**
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `frontend/src/pages/BettingAccounts.tsx`
- Modify: `frontend/src/pages/BettingAccounts.test.tsx`
- Create: `tests/crown-betting-account-actions.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`

**Interfaces:**
- Produces `pauseBettingAccount(id)` and async `enableBettingAccount(id)` actions.
- Status transitions: `enabled → pause_pending → paused → checking → enabled`.

- [ ] **Step 1: Write failing backend transition tests**

Assert pause blocks new allocation immediately, keeps queued children executable, moves to paused when the queue drains, and preserves an unknown lock. Assert enable performs fresh login/game-list/member-data/balance before changing status.

- [ ] **Step 2: Write failing UI tests**

Assert each account card shows one context action, Chinese transition state, disabled repeated clicks, and no amount precision/step field or metric.

- [ ] **Step 3: Verify RED**

Run backend action/API tests and the focused frontend test.

- [ ] **Step 4: Implement backend actions and transition finalizer**

Use a transaction for pause and a compare-and-set around async enable checking so concurrent edits cannot enable stale credentials. Never return Crown raw login text.

- [ ] **Step 5: Implement account cards**

Show bet order, site, integer per-bet limit, access, Crown reported balance, allocation status and execution lock. Add “暂停”/“启用” buttons next to existing detect/edit actions.

- [ ] **Step 6: Verify GREEN and browser behavior**

Run focused tests and production build. On a temporary database, verify enable success/failure and pause transition at desktop and 390px without touching live account state.

- [ ] **Step 7: Diff checkpoint**

Review account backend/UI changes; do not commit.

---

### Task 9: Unified monitor-bet rule page and global switch

**Files:**
- Create: `frontend/src/pages/AutoBetRules.tsx`
- Create: `frontend/src/pages/AutoBetRules.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/pages/MonitorSettings.tsx`
- Modify: `frontend/src/pages/BettingRules.tsx`
- Modify: `tests/crown-dashboard-spa.test.mjs`

**Interfaces:**
- Route `/auto-bet-rules` is the single user-facing rule editor.
- Old `/monitor-settings` retains watcher health/global scan settings only.
- Old `/betting-rules` redirects to `/auto-bet-rules`.

- [ ] **Step 1: Write failing rule-page tests**

Cover one-form create/edit, exact league multiselect, mode/period/market compatible sides, rise threshold, reverse target odds, integer target amount, monitor/real switches, CAS conflict, clone, archive and priority reorder.

- [ ] **Step 2: Write failing master-switch tests**

Assert off/armed_waiting/running/blocked/stopping labels, persistent requested intent, preflight reasons, confirmation on start/stop, and no automatic single-order stop setting.

- [ ] **Step 3: Verify RED**

Run the new frontend test and SPA route test.

- [ ] **Step 4: Implement the unified page**

Use cards on narrow screens and a compact sortable list on desktop. User copy must say “监控方向”, “反打方向”, “实际投注水位” and “目标投注总金额”; do not expose internal binding terms.

- [ ] **Step 5: Remove retired UI fields**

Remove editable prematch/live condition cards from MonitorSettings and retire the old BettingRules form. Preserve history/batch links from the unified page.

- [ ] **Step 6: Verify GREEN and responsive build**

Run all frontend tests and `npm --prefix frontend run build`. Use browser acceptance at 390×844 and desktop; assert no horizontal page overflow and zero console errors.

- [ ] **Step 7: Diff checkpoint**

Review unified UI/navigation changes; do not commit.

---

## C4 — Operations Console and Final Acceptance

### Task 10: Operations summary and responsive console

**Files:**
- Modify: `src/crown/app/app-repository.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Create: `frontend/src/pages/OperationsConsole.tsx`
- Create: `frontend/src/pages/OperationsConsole.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/api.ts`
- Create: `tests/crown-operations-summary.test.mjs`

**Interfaces:**
- `GET /api/app/operations-summary` returns bounded watcher, freshness, runtime, rule, account, batch, unknown, reconciliation and notification aggregates.
- Console polls every 5 seconds while visible and 30 seconds while hidden.

- [ ] **Step 1: Write failing summary tests**

Assert serverTime, freshness age, watcher lease, global requested/runtime state, rule hit counts, enabled/pause/locked/unknown accounts, recent batch totals, reconciliation due/dead-letter and notification backlog.

- [ ] **Step 2: Write failing console tests**

Assert stale/offline retains last data but disables start, stop remains available, unknown is prominent, and no secret/provider reference is rendered.

- [ ] **Step 3: Verify RED**

Run summary and console tests.

- [ ] **Step 4: Implement bounded aggregation and polling**

Use aggregate SQL and fixed recent limits; do not load all child orders. Cancel/reuse overlapping requests and refresh immediately on visibility restore.

- [ ] **Step 5: Verify GREEN and mobile acceptance**

Run focused/full frontend tests and production build. Verify desktop and 390px console, switch confirmations, stale transition, and zero console errors.

- [ ] **Step 6: Diff checkpoint**

Review summary/console changes; do not commit.

---

### Task 11: Full regression, documentation and live readiness gate

**Files:**
- Create: `tests/crown-c-unified-auto-betting-integration.test.mjs`
- Modify: `README.md`
- Modify: `docs/modules/crown-betting-protocol.md`
- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/modules/crown-football-monitor.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`

**Interfaces:**
- Integration test proves monitor change → priority winner → market claim → ordered partial allocation → per-account queue → accepted/rejected/unknown → restart recovery.

- [ ] **Step 1: Write end-to-end integration test with fake providers**

Use a fresh temporary SQLite database, two accounts with limits 60/50 and target 100. Assert 60+40, exact one-market behavior, changed line new eligibility, rejected no redistribution, unknown retained, account pause queue drain and persistent armed restart.

- [ ] **Step 2: Run focused C gate**

Run all new C test files plus B1/B2 executor, reconciliation, security and watcher integration tests.

- [ ] **Step 3: Run complete automated verification**

Run:

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
docker compose -p crown-dashboard config
```

Expected: all commands exit 0. Existing Vite chunk-size warning is informational; new errors are not accepted.

- [ ] **Step 4: Run browser acceptance on a temporary database**

Verify unified rule CRUD/reorder, account pause/enable, global switch armed/blocked states, operations console, desktop/390px layout, persistence after refresh, and zero console/network errors. Do not mutate live account/rule state in this step.

- [ ] **Step 5: Run security and network audit**

Assert tests/default commands issue zero Crown submit calls. Scan API/log/public fixture output for password, uid, cookie, token, ticket, authorization and provider reference. Confirm Dashboard still listens on loopback by default.

- [ ] **Step 6: Update project documentation**

Record canonical rule fields, one-market identity, allocation/outcome semantics, account pause transitions, persistent runtime states, capability coverage matrix, exact run/stop commands and current verified limitations.

- [ ] **Step 7: Live readiness decision**

If and only if at least one exact capability row has verified preview+submit+reconciliation evidence, report it as available for the user to enable through the global switch. Do not add a first-order stop or daily cap. If zero rows remain, report the evidence blocker and keep real runtime blocked; do not claim automatic betting complete.

- [ ] **Step 8: Final diff checkpoint**

Show `git status --short` and grouped diff statistics. Do not commit.

---

## Plan Self-Review

- [x] Every confirmed user decision is assigned to an implementation task.
- [x] The user-visible rule is canonical; no hidden StrategyRule↔BettingRule binding remains.
- [x] User step/precision is removed while provider preview min/max/step remains enforced automatically.
- [x] Account pause uses pause-pending and completes existing queued work.
- [x] Target odds is checked once; line identity is rechecked before every submit.
- [x] One-market lifetime idempotency, priority winner, partial fill, no rejected redistribution and unknown retention are covered.
- [x] Persistent unrestricted real intent is implemented without weakening evidence/capability gates.
- [x] C1, C2/C3 and C4 each have independent test gates.
- [x] The plan contains no automatic Git commit.
