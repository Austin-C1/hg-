# Crown Entry And README Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project entry files match the completed first-stage Crown football read-only monitor without expanding into unnecessary scan tooling.

**Architecture:** Keep this as an entry/documentation cleanup. `README.md`, `package.json`, and `.gitignore` should describe and protect the implementation that already exists. Add one small cross-platform syntax-check script only if needed for stable Windows verification.

**Tech Stack:** Node.js ESM, Playwright, Node built-in test runner, PowerShell/Windows-compatible commands.

---

## Scope Decision

| Item | Decision | Reason |
|---|---|---|
| Update README | Do | Current README is still probe-only and misleading. |
| Add npm `test` | Do | `node --test` already works and should be a stable entry. |
| Add npm `check` | Do | Use a small Node script instead of shell glob, so Windows is stable. |
| Split fixture/default commands | Do | Keep flexible commands plus fixed baseline commands. |
| Add `engines.node` | Do | Playwright requires Node `>=18`. |
| Pin Playwright exact version | Do | Browser/network behavior should be reproducible. |
| Add `.gitignore` | Do | Prevent profile/runtime/capture leakage if this becomes a repo. |
| Add complex safety/sensitive scan scripts | Do not do now | Current risk is solved by docs/tests/simple keyword verification; full scanners are not required yet. |

## File Changes

| File | Change |
|---|---|
| `README.md` | Rewrite/update to describe the first-stage read-only football monitor, current limits, commands, outputs, and safety boundary. |
| `package.json` | Add `test`, `check`, flexible `crown:analyze`, `crown:replay`, fixture-specific aliases, `engines.node`, and exact Playwright version. |
| `package-lock.json` | Update if `package.json` dependency metadata changes. |
| `scripts/check-syntax.mjs` | New small script to recursively run syntax checks for project `.mjs` files. |
| `.gitignore` | New ignore rules for `node_modules`, browser profile, runtime output, raw captures, env files, logs. |

## Task 1: Package Entry Fixes

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Add `engines.node >=18`.
- [ ] Pin Playwright to the installed lockfile version, currently `1.61.1`.
- [ ] Add stable scripts:

```json
{
  "test": "node --test",
  "check": "node scripts/check-syntax.mjs",
  "crown:probe": "node scripts/crown-probe.mjs",
  "crown:probe:once": "node scripts/crown-probe.mjs --once",
  "crown:analyze": "node scripts/crown-analyze-network.mjs",
  "crown:analyze:fixture": "node scripts/crown-analyze-network.mjs data/fixtures/crown/20260708_004011",
  "crown:replay": "node scripts/crown-replay-fixture.mjs",
  "crown:replay:fixture": "node scripts/crown-replay-fixture.mjs data/fixtures/crown/20260708_004011",
  "crown:watch": "node scripts/crown-watch.mjs"
}
```

- [ ] Run:

```powershell
npm install
npm test
```

Expected: tests pass.

## Task 2: Cross-Platform Syntax Check

**Files:**

- Create: `scripts/check-syntax.mjs`

- [ ] Implement recursive project `.mjs` discovery for `scripts/`, `src/`, and `tests/`.
- [ ] Skip `node_modules`, `data`, and `docs`.
- [ ] Run `node --check <file>` using `node:child_process`.
- [ ] Exit non-zero if any file fails syntax check.
- [ ] Run:

```powershell
npm run check
```

Expected: every checked `.mjs` file passes.

## Task 3: README Accuracy Update

**Files:**

- Modify: `README.md`

- [ ] Change title from probe-only to Crown football read-only monitor.
- [ ] Add current status:
  - first-stage monitor complete
  - fixture fixed
  - DOM fixture is current odds baseline
  - real Crown odds response/WebSocket endpoint not yet confirmed
  - SQLite deferred
  - no betting execution code
- [ ] Add common commands:
  - `npm test`
  - `npm run check`
  - `npm run crown:probe`
  - `npm run crown:analyze:fixture`
  - `npm run crown:replay:fixture`
  - `node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/20260708_004011`
  - `npm run crown:watch`
- [ ] Add output files:
  - `data/runtime/crown-odds-snapshots.jsonl`
  - `data/runtime/crown-odds-changes.jsonl`
  - `data/fixtures/crown/20260708_004011/replay-summary.json`
  - `data/fixtures/crown/20260708_004011/endpoint-candidates.*`
- [ ] Add current limits section:
  - `json-responses/` currently looks like BetRadar metadata/stats
  - normalizer preserves raw DOM values and uses inferred market/selection ids
  - watcher is page-listening only

## Task 4: Git Ignore Safety

**Files:**

- Create: `.gitignore`

- [ ] Add:

```gitignore
node_modules/
.env
.env.*
*.log
data/crown-profile/
data/crown-probe/
data/crown-probe-smoke/
data/runtime/
data/fixtures/**/network.jsonl
data/fixtures/**/network-summary.json
data/fixtures/**/json-responses/
!data/fixtures/**/README.md
!data/fixtures/**/football-today-filtered.json
!data/fixtures/**/dom-events.json
!data/fixtures/**/endpoint-candidates.json
!data/fixtures/**/endpoint-candidates.md
!data/fixtures/**/replay-summary.json
```

- [ ] Do not delete existing local fixture/runtime files. This is only for future Git safety.

## Task 5: Final Verification

**Files:**

- Read-only verification.

- [ ] Run:

```powershell
npm test
npm run check
npm run crown:analyze:fixture
npm run crown:replay:fixture
node scripts\crown-watch.mjs --from-fixture data\fixtures\crown\20260708_004011
Select-String -Path src\**\*.mjs,scripts\*.mjs -Pattern 'placeBet|submitBet|wager|stake|ticket|order' -SimpleMatch
```

Expected:

- tests pass
- syntax check passes
- analyzer outputs endpoint reports
- replay outputs 175 monitored records
- watcher fixture writes JSONL
- betting execution keyword scan has no relevant executable matches

## Not Included

- No SQLite implementation.
- No strategy engine.
- No betting adapter.
- No direct Crown API construction.
- No heavy sensitive-output scanner until there is real exported data format beyond JSONL and docs.
