# Crown B1/B2 Multi-Account Betting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox syntax.

**Goal:** Build a recoverable multi-account betting core from persistent Signal through exact allocation and simulated execution, then add a gated Crown Provider/Executor that remains unable to send a real FT_bet without separate user authorization.

**Architecture:** B1 introduces integer-minor-unit money, versioned rules/accounts, deterministic batches, a transactional child-order ledger, strict selection locking, a simulated Provider, independent prematch/live settings, and persistent runtime leases. B2 adds security gates, a versioned Crown capability matrix, account-owned sessions, durable submit attempts, reconciliation, and idempotent notifications. The watcher stays read-only.

**Tech Stack:** Node.js ESM, node:sqlite, node:test, React 18, TypeScript, Vitest, Ant Design, existing Crown XML/protocol fixtures.

## Global Constraints

- Source design: docs/superpowers/specs/2026-07-10-crown-b-multi-account-betting-design.md.
- B1 must perform zero real Crown network requests and zero FT_bet calls.
- B2 automated tests use fake/sanitized Provider responses; a real small-stake FT_bet always needs separate user approval at the time of acceptance.
- SQLite amounts are INTEGER minor units; API amounts are decimal strings. No binary floating-point arithmetic may participate in the new ledger.
- Persistent Signal is the sole new-batch trigger. Candidate remains compatibility/diagnostic output only.
- One account may have one non-terminal child order. unknown retains the amount and account lock and is never automatically retried.
- Odds changes may continue on the locked line. Event, period, market, line, or side changes fail closed.
- watcher and Betting Executor use fenced SQLite leases and never share execution responsibilities.
- New, copied, migrated, closed, or re-enabled rules are preview_only. real_eligible requires a separate audited upgrade and an active persisted authorization.
- No automatic Git commit. Every task ends with tests and a scope review.
- Tests and migrations use temporary SQLite databases, never storage/crown.sqlite.

---

## File Structure

### New B1 files

| File | Responsibility |
|---|---|
| src/crown/betting/money.mjs | Exact decimal string and minor-unit conversion |
| src/crown/betting/betting-rule-policy.mjs | New rule normalization and overlap policy |
| src/crown/betting/betting-rule-matcher.mjs | Signal-to-rule matching and deterministic batch IDs |
| src/crown/betting/locked-selection.mjs | Strict reverse selection identity checks |
| src/crown/betting/stake-allocator.mjs | Deterministic min/max/step allocation |
| src/crown/betting/bet-batch-store.mjs | Transactional batch, child-order, lock, and aggregate ledger |
| src/crown/betting/simulated-bet-provider.mjs | Scriptable no-network Provider |
| src/crown/betting/multi-account-bet-coordinator.mjs | Preview, allocation, submission, recovery orchestration |
| src/crown/betting/betting-worker.mjs | Persistent Signal polling and lease-controlled work loop |
| src/crown/app/runtime-lease.mjs | Fenced watcher/Executor SQLite leases |
| scripts/crown-betting-worker.mjs | off/simulated/preview worker CLI |

### New B2 files

| File | Responsibility |
|---|---|
| src/crown/betting/execution-gate.mjs | Rule, authorization, hard cap, capability, audit, and lease gate |
| src/crown/betting/crown-capability-matrix.mjs | Versioned supported Crown market combinations |
| src/crown/betting/crown-account-provider.mjs | Account-owned Crown session, preview, submit, and reconcile adapter |
| tests/crown-betting-b1-integration.test.mjs | B1 end-to-end recovery evidence |
| tests/crown-betting-b2-executor.test.mjs | B2 durable submit and reconciliation evidence |
| tests/crown-betting-security-audit.test.mjs | Secret/output and no-ungated-submit evidence |

---

### Task 1: Exact money and SQLite foundation

**Files:**
- Create: src/crown/betting/money.mjs
- Modify: src/crown/app/app-db.mjs
- Create: tests/crown-betting-money.test.mjs
- Modify: tests/crown-app-db.test.mjs

**Interfaces:**
- Produces: parseDecimalToMinor(value, { scale, allowZero }), formatMinor(minor, { scale }), assertMinor(value, field), normalizeCurrency(value).
- Produces SQLite tables: betting_rule_leagues, bet_batches, bet_child_orders, betting_account_locks, runtime_leases, execution_authorizations.

- [x] **Step 1: Write failing money tests**

    test('converts decimal strings exactly', () => {
      assert.equal(parseDecimalToMinor('12.34', { scale: 2 }), 1234)
      assert.equal(formatMinor(1234, { scale: 2 }), '12.34')
      assert.throws(() => parseDecimalToMinor('1.234', { scale: 2 }), /amount-precision/)
      assert.throws(() => parseDecimalToMinor('NaN', { scale: 2 }), /amount-format/)
      assert.throws(() => parseDecimalToMinor('0', { scale: 2 }), /amount-positive/)
    })

- [x] **Step 2: Verify RED**

Run: node --test tests/crown-betting-money.test.mjs
Expected: FAIL with ERR_MODULE_NOT_FOUND for money.mjs.

- [x] **Step 3: Implement exact conversion**

    export function parseDecimalToMinor(value, { scale, allowZero = false } = {}) {
      if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new TypeError('amount-scale')
      const text = String(value ?? '').trim()
      const match = text.match(/^(\d+)(?:\.(\d+))?$/)
      if (!match) throw new TypeError('amount-format')
      const fraction = match[2] || ''
      if (fraction.length > scale) throw new TypeError('amount-precision')
      const minor = BigInt(match[1]) * (10n ** BigInt(scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0')
      if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount-range')
      const result = Number(minor)
      if (result === 0 && !allowZero) throw new RangeError('amount-positive')
      return result
    }

    export function assertMinor(value, field = 'amount') {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(field + '-minor')
      return value
    }

    export function formatMinor(minor, { scale } = {}) {
      assertMinor(minor)
      if (!Number.isInteger(scale) || scale < 0 || scale > 6) throw new TypeError('amount-scale')
      const base = 10 ** scale
      const whole = Math.floor(minor / base)
      return scale ? whole + '.' + String(minor % base).padStart(scale, '0') : String(whole)
    }

    export function normalizeCurrency(value) {
      const currency = String(value || '').trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency')
      return currency
    }

- [x] **Step 4: Write failing schema and migration tests**

Assert all new tables, INTEGER amount columns, UNIQUE(signal_id, rule_id), UNIQUE active rule league ownership, account_id primary lock, foreign keys, and legacy betting history preservation. Insert a legacy rule, reopen the database, and assert enabled=0 and execution_mode='preview_only'.

- [x] **Step 5: Add schema and additive migrations**

Add rule columns execution_mode, currency, amount_scale, target_amount_minor, changed_odds_min/max, version; account columns archived, per_bet_limit_minor, currency, amount_scale, stake_step_minor, balance_minor, balance_updated_at, execution_status. Create the six tables listed in Interfaces with CHECK constraints for non-negative integer amounts and stable status defaults.

- [x] **Step 6: Verify GREEN**

Run: node --test tests/crown-betting-money.test.mjs tests/crown-app-db.test.mjs
Expected: all tests PASS and use only :memory: or temporary databases.

- [x] **Step 7: Scope review**

Review only money.mjs, app-db.mjs, and their tests. Confirm storage/crown.sqlite timestamps and hashes were not read or changed by the tests.

---

### Task 2: Rule/account contracts and atomic CRUD policy

**Files:**
- Create: src/crown/betting/betting-rule-policy.mjs
- Modify: src/crown/app/app-validation.mjs
- Modify: src/crown/app/app-repository.mjs
- Modify: src/crown/app/app-api.mjs
- Modify: frontend/src/types.ts
- Create: tests/crown-betting-rule-policy.test.mjs
- Modify: tests/crown-app-repository.test.mjs
- Modify: tests/crown-app-api.test.mjs

**Interfaces:**
- Produces: normalizeLeagueNames, validateBettingRulePolicy, findEnabledLeagueConflicts.
- Rule API: leagueNames, targetAmount decimal string, currency, amountScale, changedOddsMin/Max, direction='up_reverse', executionMode, enabled, version.
- Account API: archived, status, betOrder, perBetLimit decimal string, currency, amountScale, stakeStep decimal string, balance decimal string|null, executionStatus.

- [x] **Step 1: Write failing policy tests**

Cover trim/deduplicate/stable league order, empty enabled rule rejection, min greater than max, immutable direction, currency/scale/positive target, and disabling/re-enabling a real_eligible rule returning preview_only.

- [x] **Step 2: Verify RED**

Run: node --test tests/crown-betting-rule-policy.test.mjs
Expected: FAIL because betting-rule-policy.mjs does not exist.

- [x] **Step 3: Implement pure policy**

    export function normalizeLeagueNames(value) {
      return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].sort()
    }

    export function validateBettingRulePolicy(rule) {
      const leagueNames = normalizeLeagueNames(rule.leagueNames)
      if (rule.enabled && leagueNames.length === 0) throw new TypeError('league-required')
      if (rule.changedOddsMin !== null && rule.changedOddsMax !== null && rule.changedOddsMin > rule.changedOddsMax) throw new TypeError('odds-range')
      if ((rule.direction || 'up_reverse') !== 'up_reverse') throw new TypeError('direction')
      return { ...rule, leagueNames, direction: 'up_reverse' }
    }

- [x] **Step 4: Write failing repository/API tests**

Create two enabled rules concurrently for the same exact Crown league and assert one receives betting-rule-conflict. Assert aliases/fuzzy names do not conflict. Assert locked account execution fields cannot change, disabling blocks new locks, referenced accounts are archived rather than deleted, dailyLimit is absent, and all amount payloads are decimal strings.

- [x] **Step 5: Implement transactional CRUD**

Use BEGIN IMMEDIATE around enabled-rule save and betting_rule_leagues replacement. Rely on league_name unique ownership for atomic conflict rejection. Increment rule version on execution-relevant changes and snapshot that version later. Block account credential/currency/limit/order edits when betting_account_locks contains the account. Closing a rule writes execution_mode='preview_only'.

- [x] **Step 6: Verify GREEN**

Run: node --test tests/crown-betting-rule-policy.test.mjs tests/crown-app-repository.test.mjs tests/crown-app-api.test.mjs
Expected: all tests PASS.

- [x] **Step 7: Scope review**

Confirm legacy fields remain readable only for compatibility and no new execution path reads daily_limit, per_account_daily_limit, max_event_amount, or old bet_direction_mode.

---

### Task 3: Signal matching and strict reverse selection lock

**Files:**
- Create: src/crown/betting/betting-rule-matcher.mjs
- Create: src/crown/betting/locked-selection.mjs
- Modify: src/crown/betting/monitor-bet-signal.mjs
- Create: tests/crown-betting-rule-matcher.test.mjs
- Create: tests/crown-locked-selection.test.mjs

**Interfaces:**
- Produces: deterministicBatchId(signalId, ruleId), matchRuleForSignal(signal, context), lockReverseSelection(signal, findLatestSelection).

- [ ] **Step 1: Write failing matcher tests**

Cover up-only creation, down returning no-batch, exact league and current-whitelist requirements, source signal.evidence.nextOdds inclusive nullable bounds, deterministic signalId+ruleId ID, freshness, prematch kickoff, live clock, suspended, and missing time fail-closed.

- [ ] **Step 2: Verify RED**

Run: node --test tests/crown-betting-rule-matcher.test.mjs tests/crown-locked-selection.test.mjs
Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement deterministic matching**

Use SHA-256 over UTF-8 signalId + newline + ruleId. Only enabled preview_only or real_eligible rules may match; execution mode does not grant real submission. Match exact evidence.league and apply odds bounds to evidence.nextOdds.

- [ ] **Step 4: Implement selection locking**

Parse the canonical market identity from Signal target/evidence, reverse side with the existing oppositeSide helper, and call findLatestSelection using the same provider, eventKey, period, marketType, and lineKey. Return a lock snapshot only when event/period/market/line/side all match and selection is not suspended.

- [ ] **Step 5: Verify GREEN**

Run: node --test tests/crown-betting-rule-matcher.test.mjs tests/crown-locked-selection.test.mjs tests/crown-monitor-bet-signal.test.mjs
Expected: all tests PASS; adjacent line fixtures are rejected.

- [ ] **Step 6: Scope review**

Confirm scripts/crown-watch.mjs still has no CrownBetAdapter or FT_bet import/call and monitor_candidates is not read by the new matcher.

---

### Task 4: Deterministic allocator and transactional batch ledger

**Files:**
- Create: src/crown/betting/stake-allocator.mjs
- Create: src/crown/betting/bet-batch-store.mjs
- Create: tests/crown-stake-allocator.test.mjs
- Create: tests/crown-bet-batch-store.test.mjs

**Interfaces:**
- Produces: allocateStake(targetMinor, capabilities), BetBatchStore.createBatch, reserveRound, prepareSubmit, markDispatched, resolveChildOrder, cancelUnsubmitted, recover, reconcileAggregates.

- [ ] **Step 1: Write failing allocation tests**

Include target 120 with two accounts min=60 max=70 step=10 and assert 60+60, not 70+unfillable 50. Cover different steps, capacity below min, currency/scale mismatch, target below every minimum, deterministic tie ordering, and maximum fill not exceeding target.

- [ ] **Step 2: Verify RED**

Run: node --test tests/crown-stake-allocator.test.mjs
Expected: FAIL because stake-allocator.mjs is missing.

- [ ] **Step 3: Implement bounded deterministic search**

Sort accounts by betOrder, createdAt, accountId. Generate each account's legal zero-or-min-through-max step values, search combinations with pruning, maximize total <= target, and select the lexicographically preferred allocation vector on ties. Reject unsafe integers and mixed currency/scale before search.

- [ ] **Step 4: Write failing store tests**

Cover idempotent createBatch(signalId, ruleId), concurrent account lock contention, atomic reservations, accepted/rejected/unknown transfers, unknown retaining lock, rejected releasing lock, cached aggregate recomputation, rollback after injected failure, waiting_capacity/waiting_result/partial/failed terminal priority, and reopen recovery.

- [ ] **Step 5: Implement BetBatchStore**

All state transitions use BEGIN IMMEDIATE. Child rows are the ledger source; batch cached totals are recalculated in the transaction. prepareSubmit changes reserved to submit_prepared without network. markDispatched records submit_dispatched. Recovery changes unresolved submit_prepared/submit_dispatched to unknown, but leaves provably unsent reserved cancellable.

- [ ] **Step 6: Verify GREEN**

Run: node --test tests/crown-stake-allocator.test.mjs tests/crown-bet-batch-store.test.mjs
Expected: all tests PASS, including injected crash/reopen cases.

- [ ] **Step 7: Scope review**

Inspect every amount expression and confirm it operates on safe integers. Confirm no REAL legacy amount is read by BetBatchStore.

---

### Task 5: Simulated Provider, coordinator, worker, and Executor lease

**Files:**
- Create: src/crown/app/runtime-lease.mjs
- Create: src/crown/betting/simulated-bet-provider.mjs
- Create: src/crown/betting/multi-account-bet-coordinator.mjs
- Create: src/crown/betting/betting-worker.mjs
- Create: scripts/crown-betting-worker.mjs
- Modify: package.json
- Create: tests/crown-runtime-lease.test.mjs
- Create: tests/crown-simulated-bet-provider.test.mjs
- Create: tests/crown-multi-account-bet-coordinator.test.mjs
- Create: tests/crown-betting-worker.test.mjs

**Interfaces:**
- Produces RuntimeLease.acquire/heartbeat/release/assertFence with ownerId and fencingToken.
- Coordinator processSignal(signal), runBatch(batchId), recover().
- CLI modes off, simulated, preview; default off. --once is testable without network.

- [ ] **Step 1: Write failing lease and Provider tests**

Cover first acquire, active-owner rejection, heartbeat CAS, expired takeover incrementing fencingToken, stale owner write rejection, scripted preview/accepted/rejected/unknown/timeout, and provider networkCallCount always zero.

- [ ] **Step 2: Verify RED**

Run: node --test tests/crown-runtime-lease.test.mjs tests/crown-simulated-bet-provider.test.mjs
Expected: FAIL because modules are missing.

- [ ] **Step 3: Implement lease and simulated Provider**

Use BEGIN IMMEDIATE for acquire/takeover, randomUUID owner IDs, exact ISO times, and fencing token checks in every store mutation. Simulated Provider takes an ordered result script and records preview/submit timing without using fetch, Playwright, or Crown adapter.

- [ ] **Step 4: Write failing coordinator/worker tests**

Prove parallel preview and submission across accounts, serial use of one account, failure redistribution, unknown retention, repeated Signal idempotency, four crash windows, restart no duplicate simulated submit, second worker fail-closed, and default CLI mode performing no work.

- [ ] **Step 5: Implement coordinator and worker**

The worker reads unbatched persisted Signals directly from SQLite. The coordinator matches, locks, previews with Promise.allSettled, allocates, reserves, prepares, calls the injected Provider, and resolves results. It never imports crown-bet-adapter.mjs in B1.

- [ ] **Step 6: Verify GREEN**

Run: node --test tests/crown-runtime-lease.test.mjs tests/crown-simulated-bet-provider.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-betting-worker.test.mjs
Expected: all tests PASS and assert zero real network calls.

- [ ] **Step 7: Scope review**

Run: rg -n "CrownBetAdapter|FT_bet|fetch\\(|playwright" src/crown/betting/betting-worker.mjs src/crown/betting/multi-account-bet-coordinator.mjs scripts/crown-betting-worker.mjs
Expected: no real Provider import/call.

---

### Task 6: B1 API and betting Dashboard

**Files:**
- Modify: src/crown/app/app-repository.mjs
- Modify: src/crown/app/app-api.mjs
- Modify: frontend/src/services/api.ts
- Modify: frontend/src/types.ts
- Modify: frontend/src/pages/BettingRules.tsx
- Modify: frontend/src/pages/BettingAccounts.tsx
- Create: frontend/src/pages/BettingRules.test.tsx
- Modify: frontend/src/pages/BettingAccounts.test.tsx
- Modify: frontend/src/App.contract.test.tsx
- Modify: tests/crown-app-api.test.mjs

**Interfaces:**
- Adds GET /api/app/bet-batches and GET /api/app/bet-batches/:id/children.
- All provider references are null or masked; executionMode cannot be upgraded by ordinary CRUD.

- [ ] **Step 1: Write failing API and UI tests**

Assert rule league multi-select, source-odds bounds, target/currency/scale, fixed reverse direction, conflict reason, recent batches, account per-bet/step/balance status, child expansion, simulated badge, and accepted-only Asia/Shanghai daily statistics.

- [ ] **Step 2: Verify RED**

Run: node --test tests/crown-app-api.test.mjs
Run: npm --prefix frontend run test -- BettingRules.test.tsx BettingAccounts.test.tsx
Expected: new assertions FAIL because payload/UI fields are absent.

- [ ] **Step 3: Implement backend projection**

Add recent batch and child queries with bounded limits. Derive display decimal strings from minor/scale. Return finishReason and masked references. Reject attempts to set executionMode=real_eligible through normal create/update endpoints.

- [ ] **Step 4: Implement pages**

Reuse getLeagueSummaries filtered by inDefaultWhitelist. Keep existing routes and card layout. Put recent batches below rule cards and child details inside account cards. Remove daily limit and direction selectors. Do not expose a real switch.

- [ ] **Step 5: Verify GREEN**

Run: node --test tests/crown-app-api.test.mjs tests/crown-app-repository.test.mjs
Run: npm --prefix frontend run test
Run: npm --prefix frontend run build
Expected: all PASS.

- [ ] **Step 6: Browser acceptance**

Start only the temporary/test Dashboard database. Verify /betting-rules and /betting-accounts at desktop and narrow width, conflict feedback, batch status amounts, child expansion, and no console errors. Do not restart the live Dashboard.

---

### Task 7: Independent prematch/live monitoring configuration

**Files:**
- Modify: src/crown/monitor/monitor-settings.mjs
- Modify: src/crown/app/local-config-api.mjs
- Modify: config/monitor-settings.json
- Modify: frontend/src/types.ts
- Modify: frontend/src/services/api.ts
- Modify: frontend/src/pages/MonitorSettings.tsx
- Modify: tests/crown-monitor-settings.test.mjs
- Modify: tests/crown-app-api.test.mjs
- Modify: frontend/src/pages/MonitorSettings.test.tsx

- [ ] **Step 1: Write failing migration and dual-mode tests**

Cover every migration row from design section 14, conflict-closes-for-review, version 2 idempotence, both enabled simultaneously, two strategy rules, fixed asian_handicap+total markets, handicap write alias, and responses containing only prematch/live.

- [ ] **Step 2: Verify RED**

Run: node --test tests/crown-monitor-settings.test.mjs tests/crown-app-api.test.mjs
Expected: tests FAIL on current runningMode/互斥 behavior.

- [ ] **Step 3: Implement version 2 settings**

Replace handicap card with prematch, remove runningMode and activePeriods from normalized output, keep a one-way legacy input migration, and return both enabled rule projections. Preserve existing thresholds, odds ranges, cooldowns, kickoff/live windows by the exact migration table.

- [ ] **Step 4: Update UI**

Render two independent sections/tabs with one enabled switch each and fixed “让球 + 大小球” text. Remove period/market checkboxes and mutual-stop copy.

- [ ] **Step 5: Verify GREEN**

Run: node --test tests/crown-monitor-settings.test.mjs tests/crown-app-api.test.mjs tests/crown-strategy-engine.test.mjs
Run: npm --prefix frontend run test -- MonitorSettings.test.tsx
Expected: all PASS.

- [ ] **Step 6: Scope review**

Search new API/output code for runningMode and activePeriods. Remaining matches must be limited to legacy migration fixtures and compatibility tests.

---

### Task 8: Kickoff projection and watcher single-instance lease

**Files:**
- Modify: src/crown/dashboard/dashboard-data.mjs
- Modify: src/crown/app/monitor-process.mjs
- Modify: scripts/crown-watch.mjs
- Modify: frontend/src/types.ts
- Modify: frontend/src/pages/MatchSelection.tsx
- Modify: frontend/src/pages/MonitorSettings.tsx
- Modify: tests/crown-dashboard-data.test.mjs
- Modify: tests/crown-monitor-process.test.mjs
- Modify: tests/crown-watch-state-version.test.mjs
- Modify: frontend/src/pages/MatchSelection.test.tsx

- [ ] **Step 1: Write failing time merge tests**

Assert valid startTimeRaw/startTimeUtc are not overwritten by empty or invalid detail values; API returns startTimeBeijing and timeQuality/timeWarnings; sorting is UTC ascending with null last; missing prematch kickoff appears by event identity in diagnostics.

- [ ] **Step 2: Write failing watcher lease tests**

Assert Dashboard child and manual CLI share watcher:resolved-db:resolved-runtime lease, active second watcher exits nonzero before polling, expired lease takeover increments fence, and one watcher handles prematch and live together.

- [ ] **Step 3: Verify RED**

Run: node --test tests/crown-dashboard-data.test.mjs tests/crown-monitor-process.test.mjs tests/crown-watch-state-version.test.mjs
Expected: new assertions FAIL.

- [ ] **Step 4: Implement projection and lease wiring**

Use existing Crown time parser output. Keep the best non-null time by quality and capturedAt rules. Acquire watcher lease before opening poll outputs; heartbeat during the loop; release only when owner/fence match. Never kill or auto-takeover an unexpired process.

- [ ] **Step 5: Verify GREEN**

Run: node --test tests/crown-dashboard-data.test.mjs tests/crown-monitor-process.test.mjs tests/crown-watch-state-version.test.mjs tests/crown-monitor-v2-integration.test.mjs
Run: npm --prefix frontend run test -- MatchSelection.test.tsx
Expected: all PASS.

- [ ] **Step 6: Operational acceptance**

Inspect the two currently running live watcher PIDs without stopping them. Confirm the new build would reject the second process; schedule actual consolidation only with explicit operational approval.

---

### Task 9: B1 integration gate and documentation

**Files:**
- Create: tests/crown-betting-b1-integration.test.mjs
- Modify: README.md
- Modify: docs/modules/crown-betting-protocol.md
- Modify: docs/modules/crown-dashboard.md
- Modify: docs/modules/crown-football-monitor.md
- Modify: docs/module-index.md
- Modify: docs/project-memory.md

- [ ] **Step 1: Write B1 end-to-end test**

Use two fresh temporary databases and identical Signal/provider scripts. Assert identical batch/child IDs and totals, replay count stability, deterministic account contention, partial/unknown/restart behavior, fenced takeover, and network/FT_bet count zero.

- [ ] **Step 2: Run focused B1 suite**

Run: node --test tests/crown-betting-money.test.mjs tests/crown-betting-rule-policy.test.mjs tests/crown-betting-rule-matcher.test.mjs tests/crown-locked-selection.test.mjs tests/crown-stake-allocator.test.mjs tests/crown-bet-batch-store.test.mjs tests/crown-multi-account-bet-coordinator.test.mjs tests/crown-betting-worker.test.mjs tests/crown-betting-b1-integration.test.mjs
Expected: all PASS.

- [ ] **Step 3: Update B1 docs**

Document schema, states, recovery, CLI default-off behavior, temporary DB acceptance, dual monitoring modes, lease operation, and that B2 real remains unavailable.

- [ ] **Step 4: Run B1 full gate**

Run: npm test
Run: npm run check
Run: npm --prefix frontend run test
Run: npm --prefix frontend run build
Expected: all PASS with zero real Crown requests.

- [ ] **Step 5: B1 independent review**

Review exact-money invariants, Signal idempotency, account serialization, unknown retention, crash recovery, UI/API masking, and watcher isolation. Resolve every Critical/Important finding before Task 10.

---

### Task 10: B2 security gates and execution authorization

**Files:**
- Create: src/crown/betting/execution-gate.mjs
- Modify: src/crown/login/crown-login-diagnostics.mjs
- Modify: src/crown/app/app-api.mjs
- Modify: src/crown/app/local-config-api.mjs
- Modify: src/crown/dashboard/static-server.mjs
- Modify: scripts/crown-dashboard.mjs
- Modify: .dockerignore
- Modify: Dockerfile
- Modify: docker-compose.yml
- Modify: .env.example
- Create: tests/crown-execution-gate.test.mjs
- Create: tests/crown-dashboard-security.test.mjs
- Modify: tests/crown-login-diagnostics.test.mjs
- Modify: tests/crown-dashboard-docker.test.mjs

**Interfaces:**
- Produces authorizeExecution, revokeAuthorization, reserveAuthorizationBudget, release/resolveAuthorizationBudget, assertExecutionGate.
- At most one active authorization globally; it must match CROWN_REAL_CURRENCY, CROWN_REAL_AMOUNT_SCALE, CROWN_REAL_MAX_TOTAL_MINOR.

- [ ] **Step 1: Write failing authorization/gate tests**

Cover default no authorization, one active slot, max 24-hour expiry, default 15 minutes, environment currency/scale/cap match, ruleIds scope, preview_only rejection, revoked/expired/exhausted, concurrent cross-batch reservation, hard-cap invariant, confirmation digest without raw phrase, and stale Executor fence.

- [ ] **Step 2: Write failing Dashboard/Docker security tests**

Assert diagnostics/API contain no cookie/storageState/password/input snapshot; mutating APIs require authenticated same-origin requests and CSRF protection; Docker context excludes config/telegram-settings.json, storage, runtime, sessions, key files, and databases.

- [ ] **Step 3: Verify RED**

Run: node --test tests/crown-execution-gate.test.mjs tests/crown-dashboard-security.test.mjs tests/crown-login-diagnostics.test.mjs tests/crown-dashboard-docker.test.mjs
Expected: new tests FAIL.

- [ ] **Step 4: Implement authorization and gate**

Use one active-slot unique row, BEGIN IMMEDIATE budget transitions, environment triple matching, audited rule upgrade endpoint/CLI distinct from ordinary CRUD, and all-gates-required evaluation. Authorization expiry/revoke cancels provably unsent reservations but preserves sent/unknown reconciliation.

- [ ] **Step 5: Implement Dashboard and build-context protections**

Add POST /api/app/session. Verify the supplied password with node:crypto scrypt against CROWN_DASHBOARD_PASSWORD_SCRYPT, then issue an HMAC-signed opaque session cookie using CROWN_DASHBOARD_SESSION_KEY with HttpOnly, SameSite=Strict, Path=/, and Secure when HTTPS. Store a random CSRF value server-side with the session, return only that CSRF value from the authenticated bootstrap response, and require X-CSRF-Token on every mutating request. Validate Host against CROWN_DASHBOARD_ALLOWED_HOSTS and Origin against CROWN_DASHBOARD_ALLOWED_ORIGINS before routing. Keep both allowlists empty-deny except loopback defaults. Do not put passwords, signing keys, or session cookies in frontend storage or API payloads.

- [ ] **Step 6: Verify GREEN**

Run: node --test tests/crown-execution-gate.test.mjs tests/crown-dashboard-security.test.mjs tests/crown-login-diagnostics.test.mjs tests/crown-dashboard-docker.test.mjs
Expected: all PASS.

---

### Task 11: Capability matrix and account-owned real read-only preview

**Files:**
- Create: src/crown/betting/crown-capability-matrix.mjs
- Create: src/crown/betting/crown-account-provider.mjs
- Modify: src/crown/betting/crown-bet-response-parser.mjs
- Modify: src/crown/betting/crown-order-field-mapper.mjs
- Modify: src/crown/betting/crown-bet-adapter.mjs
- Modify: src/crown/login/crown-api-login-manager.mjs
- Modify: docs/crown-betting-protocol-map.md
- Add: data/fixtures/crown/betting-protocol sanitized preview fixtures only
- Create: tests/crown-capability-matrix.test.mjs
- Create: tests/crown-account-provider.test.mjs
- Modify: tests/crown-bet-response-parser.test.mjs
- Modify: tests/crown-order-field-mapper.test.mjs

- [x] **Step 1: Write failing capability tests**

Assert every allowed mode/period/marketType/lineVariant references a sanitized fixture and mapper evidence; unverified prematch/alternate lines are blocked; changed provider field sets invalidate capability version.

- [x] **Step 2: Write failing account preview tests**

Assert each Worker logs in only with its betting account credentials/session, never mon_primary; preview calls FT_order_view only; response exposes raw maxcredit plus verified min/max/step/currency/odds/line; unproven maxcredit semantics do not increase capacity; event/period/market/line/side mismatch fails closed.

- [x] **Step 3: Verify RED**

Run: node --test tests/crown-capability-matrix.test.mjs tests/crown-account-provider.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-order-field-mapper.test.mjs
Expected: new tests FAIL.

- [x] **Step 4: Implement matrix and preview Provider**

Store explicit evidence IDs and a stable matrix version. Build sessions from each account's encrypted credential and website URL. Parse only evidenced fields, return normalized preview plus redacted raw diagnostics, and compare the full lock identity before capacity is accepted.

- [x] **Step 5: Verify GREEN with fake/sanitized fixtures**

Run: node --test tests/crown-capability-matrix.test.mjs tests/crown-account-provider.test.mjs tests/crown-bet-response-parser.test.mjs tests/crown-order-field-mapper.test.mjs tests/crown-bet-adapter.test.mjs
Expected: all PASS and submit count zero.

- [x] **Step 6: Controlled real read-only acceptance (recorded as not executed; canonical matrix remains fail-closed)**

Using a cloned/temporary account database and explicit preview-only command, request FT_order_view per enabled account and record sanitized min/max/step/currency/raw maxcredit evidence. Verify request audit contains monitor/login/preview only and FT_bet count zero. If account access is unavailable, record this acceptance as not executed; do not weaken the matrix.

---

### Task 12: Durable submit, reconciliation, notification, and B2 gate

**Files:**
- Modify: src/crown/app/app-db.mjs
- Modify: src/crown/betting/execution-gate.mjs
- Modify: src/crown/betting/multi-account-bet-coordinator.mjs
- Modify: src/crown/betting/bet-batch-store.mjs
- Modify: src/crown/betting/crown-account-provider.mjs
- Create: src/crown/betting/crown-account-execution-provider.mjs
- Create: src/crown/betting/b2-executor.mjs
- Create: src/crown/betting/b2-reconciler.mjs
- Create: src/crown/betting/b2-outcome-dispatcher.mjs
- Modify: src/crown/betting/crown-bet-adapter.mjs
- Modify: src/crown/betting/crown-bet-response-parser.mjs
- Modify: src/betting/audit-log.mjs
- Modify: src/crown/app/app-secret.mjs
- Modify: scripts/crown-bet-execute.mjs
- Modify: scripts/crown-bet-execute-sequence.mjs
- Create: scripts/crown-b2-notifications.mjs
- Modify: src/crown/alerts/telegram-templates.mjs
- Modify: src/crown/alerts/telegram-alert.mjs
- Modify: src/crown/app/app-repository.mjs
- Create: tests/crown-betting-b2-executor.test.mjs
- Create: tests/crown-betting-b2-reconciliation.test.mjs
- Create: tests/crown-betting-b2-notifications.test.mjs
- Create: tests/crown-betting-security-audit.test.mjs
- Create: tests/crown-betting-b2-schema.test.mjs
- Modify: tests/crown-bet-adapter.test.mjs
- Modify: tests/crown-alerts.test.mjs

- [x] **Step 1: Write failing durable-submit tests**

Cover submit_prepared persisted before Provider call, submit_dispatched after call begins, accepted/rejected transitions, timeout/disconnect/pending to unknown, odds-changed explicitly-not-accepted allowing one re-preview only, second change to unknown, every crash point restart with no duplicate submit, authorization budget transfer, and stale fence rejection.

Persist immutable submit-attempt history instead of overwriting the child row's single attempt field. Gate validation, authorization budget binding, account lock, capability/preview snapshot, lease fence, and `submit_prepared` must commit atomically before any Provider call.

- [x] **Step 2: Write failing reconciliation and notification tests**

Cover get_dangerous plus evidenced today-wagers polling with bounded exponential backoff/deadline, idempotent accepted/rejected updates, evidence-bearing manual resolution, encrypted provider reference, masked API/audit, accepted-only success notification, separate unknown/partial/failed/circuit-open alerts, and notification key batchId+childOrderId+finalStatus.

Persist reconciliation schedule/evidence and notification outbox rows so restart cannot reset backoff, lose a final transition, or duplicate a delivered status.

- [x] **Step 3: Verify RED**

Run: node --test tests/crown-betting-b2-executor.test.mjs tests/crown-betting-security-audit.test.mjs tests/crown-bet-adapter.test.mjs tests/crown-alerts.test.mjs
Expected: new tests FAIL.

- [x] **Step 4: Implement durable Provider path**

Re-check authorization, hard cap, rule/account state, capability, lock identity, preview limits, balance, and fence immediately before prepareSubmit. Persist submitAttemptId and prepared state, call Provider once, mark dispatched/result, and never auto-submit any prepared/dispatched/unknown attempt after recovery.

Disable the legacy adapter/CLI real-submit routes before wiring the B2 Provider. Production capability authority remains canonical. Offline ledger fixtures require `provider=fixture`, cannot attest a persisted Crown batch, and are never selected by scripts or production constructors.

- [x] **Step 5: Implement reconciliation and notifications**

Poll only evidenced endpoints, sanitize stable error codes, encrypt sensitive references with app-secret, append redacted audits, and deliver idempotent final-status notifications. Asia/Shanghai accepted rows alone contribute to today's success totals.

- [x] **Step 6: Run B2 focused gate**

Run: node --test tests/crown-execution-gate.test.mjs tests/crown-capability-matrix.test.mjs tests/crown-account-provider.test.mjs tests/crown-betting-b2-executor.test.mjs tests/crown-betting-security-audit.test.mjs tests/crown-bet-adapter.test.mjs tests/crown-alerts.test.mjs
Expected: all PASS using fake/sanitized Provider data.

- [x] **Step 7: Run complete verification**

Run: npm test
Run: npm run check
Run: npm --prefix frontend run test
Run: npm --prefix frontend run build
Expected: all PASS. Docker build/start is additionally required when the Docker daemon is available; otherwise record daemon unavailable and retain the contract-test evidence.

- [x] **Step 8: Final security and requirements review**

Verify all design sections, scan source/docs/fixtures/output payloads for cookie, uid, token, password, storageState, Authorization, ticket, providerReference, user absolute paths, and secret patterns. Confirm ordinary tests and default commands cannot issue FT_bet. Resolve every Critical/Important finding.

- [x] **Step 9: Real small-stake acceptance gate (recorded as not executed)**

Stop. Present the verified capability, account, rule, amount, currency, authorization scope, hard cap, exact locked market, and rollback/unknown procedure to the user. Execute one real small-stake FT_bet only after a new explicit confirmation in that acceptance turn.

Recorded result: not executed. The canonical Crown matrix still has zero verified preview and submit rows, the production submit and reconciliation providers therefore remain fail-closed, the legacy diagnostics/credential-rotation operational gate remains open, and no fresh real-bet authorization was requested or granted.

---

## Plan Self-Review Checklist

- [x] Every design requirement in sections 1–22 maps to at least one Task.
- [x] No unresolved marker, omitted implementation branch, copied-by-reference step, or unbounded error-handling instruction remains.
- [x] targetAmountMinor, reservedAmountMinor, acceptedAmountMinor, unknownAmountMinor, perBetLimitMinor, and authorization totals use safe INTEGER minor units consistently.
- [x] executionMode values are preview_only and real_eligible everywhere.
- [x] Child submit states are reserved, submit_prepared, submit_dispatched, accepted, rejected, unknown, cancelled.
- [x] Batch waiting/terminal priority matches the design exactly.
- [x] watcher remains read-only and Candidate is not a trigger.
- [x] B1 gate precedes B2, and Task 12 real small-stake action remains separately authorized.
