# Crown Football Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Crown football odds monitor that identifies reliable data endpoints, normalizes odds data, monitors only configured leagues, records odds changes, and reserves a non-executable betting architecture for later.

**Architecture:** Keep collection, endpoint detection, normalization, filtering, monitoring, storage, alerts, and future betting boundaries separate. The first monitoring version listens to Playwright page responses and WebSocket frames; it does not construct Crown API requests, click odds, fill stakes, or submit orders.

**Tech Stack:** Node.js ESM, Playwright, JSON/JSONL fixtures, Node built-in test runner, optional SQLite in a later storage task.

---

## Safety Boundary

This project currently allows:

- Reading local capture files.
- Opening a logged-in Crown page through Playwright.
- Listening to page responses and WebSocket frames.
- Parsing football odds data.
- Filtering leagues by local config.
- Writing local JSON/JSONL monitor outputs.
- Sending local or Telegram alerts after monitor validation.

This project currently forbids:

- Clicking odds or bet-slip controls.
- Filling stake amounts.
- Calling submit/place/order/wager/ticket endpoints.
- Emitting cookie, token, authorization, or set-cookie values in reports.
- Bypassing CAPTCHA, risk controls, signatures, or account protections.
- Implementing automatic betting execution.

## Target Outputs

| Output | Purpose |
|---|---|
| `data/fixtures/crown/20260708_004011/` | Fixed baseline from the current successful capture |
| `endpoint-candidates.json` / `endpoint-candidates.md` | Ranked candidate data endpoints from local Network logs |
| `docs/crown-football-field-map.md` | Evidence-backed mapping from Crown raw fields to normalized fields |
| `config/monitored-leagues.json` | League allowlist and exclusion rules |
| `src/crown/normalize-football.mjs` | Pure local normalizer from raw response JSON to standard odds records |
| `scripts/crown-watch.mjs` | Read-only page listener for odds snapshots and changes |
| `data/runtime/crown-odds-snapshots.jsonl` | Append-only normalized odds snapshots |
| `data/runtime/crown-odds-changes.jsonl` | Append-only detected odds changes |
| `docs/betting-architecture.md` / `docs/betting-contract.md` | Future betting module boundary without executable betting code |

## Standard Record Shape

Every normalized selection odds record should follow this shape:

```js
{
  provider: 'crown',
  sport: 'football',
  mode: 'prematch', // prematch | live | odds-refresh | unknown
  capturedAt: '2026-07-08T00:40:11.000+08:00',
  source: {
    endpointKey: 'GET /path',
    urlPattern: '/path?stable=params',
    mapperVersion: 'crown-football-v1',
    sampleFile: 'json-responses/0001_sample.json'
  },
  event: {
    eventId: 'raw-event-id',
    league: 'raw league name',
    homeTeam: 'raw home team',
    awayTeam: 'raw away team',
    startTimeRaw: 'raw time',
    startTimeUtc: null,
    status: 'not_started', // not_started | live | suspended | unknown
    score: null,
    clock: null
  },
  market: {
    marketId: 'raw-market-id',
    marketType: 'asian_handicap', // asian_handicap | total | moneyline | unknown
    period: 'full_time',
    handicapRaw: '0/0.5',
    handicap: null
  },
  selection: {
    selectionId: 'raw-selection-id',
    side: 'home',
    oddsRaw: '0.86',
    odds: 0.86,
    oddsFormat: 'unknown',
    suspended: false
  },
  warnings: []
}
```

## Task 1: Freeze Current Fixture

**Files:**

- Create: `data/fixtures/crown/20260708_004011/README.md`
- Copy into fixture: `network.jsonl`, `network-summary.json`, `json-responses/`, `manual_01_20260708_004425/football-today-filtered.json`, `manual_01_20260708_004425/dom-events.json`

- [ ] Copy the current capture into `data/fixtures/crown/20260708_004011/`.
- [ ] Write fixture README with these known counts:
  - prematch football: `20`
  - live football: `18`
  - filtered result keyword hits for esports/virtual/fantasy: `0`
- [ ] Verify files exist:

```powershell
Test-Path data\fixtures\crown\20260708_004011\network.jsonl
Test-Path data\fixtures\crown\20260708_004011\json-responses
Test-Path data\fixtures\crown\20260708_004011\football-today-filtered.json
```

Expected: all three commands return `True`.

## Task 2: Add Safety And Betting Boundary Docs

**Files:**

- Create: `docs/safety-boundary.md`
- Create: `docs/betting-architecture.md`
- Create: `docs/betting-contract.md`
- Create: `src/betting/README.md`

- [ ] Document the current read-only boundary.
- [ ] Document future betting modules as architecture only:
  - `bet-intent`
  - `risk-guard`
  - `bet-adapter`
  - `order-confirmation`
  - `audit-log`
- [ ] Define future `BetIntent` input shape without any submit/place/order logic.
- [ ] Verify no executable betting code exists:

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs -Pattern 'placeBet|submitBet|wager|stake|ticket|order' -SimpleMatch
```

Expected: no betting execution function is present.

## Task 3: Build Offline Endpoint Analyzer

**Files:**

- Create: `scripts/crown-analyze-network.mjs`
- Output: `data/fixtures/crown/20260708_004011/endpoint-candidates.json`
- Output: `data/fixtures/crown/20260708_004011/endpoint-candidates.md`
- Modify: `package.json`

**Script command:**

```powershell
node scripts\crown-analyze-network.mjs data\fixtures\crown\20260708_004011
```

- [ ] Read `network.jsonl` and all files in `json-responses/`.
- [ ] Group JSON/XHR/fetch responses by method and normalized URL pattern.
- [ ] Strip dynamic query keys: `_`, `ts`, `timestamp`, `t`, `r`, `nonce`, `random`, `v`.
- [ ] Extract JSON key paths, array lengths, sample files, and text hits.
- [ ] Score each group using:
  - `+20` for event/match/game/league/team fields.
  - `+20` for odds/price/water/ior/handicap/line fields.
  - `+15` for array lengths close to `20` or `18`.
  - `+30` for matching fixture team or league names.
  - `-50` for esports/virtual/fantasy/GT keywords.
- [ ] Classify candidate type as:
  - `football-prematch`
  - `football-live`
  - `odds-refresh`
  - `league-dict`
  - `team-dict`
  - `irrelevant`
  - `unknown`
- [ ] Verify candidate outputs exist and top candidates are readable:

```powershell
node scripts\crown-analyze-network.mjs data\fixtures\crown\20260708_004011
Test-Path data\fixtures\crown\20260708_004011\endpoint-candidates.json
Test-Path data\fixtures\crown\20260708_004011\endpoint-candidates.md
```

Expected: JSON and Markdown reports are generated.

## Task 4: Create Field Mapping Document

**Files:**

- Create: `docs/crown-football-field-map.md`

- [ ] Use `endpoint-candidates.json`, sample JSON responses, and `football-today-filtered.json`.
- [ ] Map these target fields with evidence:
  - `eventId`
  - `league`
  - `homeTeam`
  - `awayTeam`
  - `startTimeRaw`
  - `startTimeUtc`
  - `status`
  - `score`
  - `clock`
  - `marketId`
  - `marketType`
  - `period`
  - `handicapRaw`
  - `handicap`
  - `oddsRaw`
  - `odds`
  - `oddsFormat`
  - `selectionId`
  - `suspended`
- [ ] For each field record:
  - raw JSON path
  - sample value
  - evidence
  - confidence: `high`, `medium`, or `low`
  - risk
  - fallback
- [ ] Keep raw values first; normalize only when evidence is strong.

## Task 5: Add League Monitoring Config

**Files:**

- Create: `config/monitored-leagues.json`
- Create: `src/crown/filters/blacklist.mjs`
- Create: `src/crown/filters/league-filter.mjs`
- Test: `tests/crown-league-filter.test.mjs`

**Initial config:**

```json
{
  "enabled": true,
  "defaultAction": "ignore",
  "include": [
    {
      "name": "世界杯2026(美加墨)",
      "aliases": ["世界杯2026", "2026世界杯"],
      "match": "contains"
    },
    {
      "name": "欧洲冠军联赛外围赛",
      "aliases": ["欧冠外围赛"],
      "match": "contains"
    }
  ],
  "exclude": [
    "电竞",
    "电子",
    "虚拟",
    "GT体育",
    "梦幻足球",
    "efootball",
    "esport",
    "virtual",
    "fantasy"
  ]
}
```

- [ ] Implement league filter as a pure function.
- [ ] Default behavior must ignore leagues not in `include`.
- [ ] Exclude keywords must override include matches.
- [ ] Verify:

```powershell
node --test tests\crown-league-filter.test.mjs
```

Expected: included leagues pass, unknown leagues fail, esports/virtual leagues fail.

## Task 6: Build Endpoint Detector And Normalizer

**Files:**

- Create: `src/crown/endpoint-detector.mjs`
- Create: `src/crown/normalize-football.mjs`
- Create: `src/crown/schema/normalized-odds.schema.mjs`
- Test: `tests/crown-normalize.fixture.test.mjs`

- [ ] `endpoint-detector.mjs` must classify local response metadata and JSON body without network access.
- [ ] `normalize-football.mjs` must be a pure function:

```js
normalizeFootballResponse({ body, metadata, fieldMap, leagueConfig })
```

- [ ] Normalizer output must preserve raw field values.
- [ ] Missing optional fields must produce `warnings`, not crashes.
- [ ] Unknown markets must output `marketType: 'unknown'`.
- [ ] Apply blacklist and monitored-league filters after normalization.
- [ ] Verify with fixture:

```powershell
node --test tests\crown-normalize.fixture.test.mjs
```

Expected:

- prematch event count close to or equal to `20`
- live event count close to or equal to `18`
- esports/virtual filtered hits: `0`
- records contain `league`, `homeTeam`, `awayTeam`, `status`, `oddsRaw`

## Task 7: Add Fixture Replay Command

**Files:**

- Create: `scripts/crown-replay-fixture.mjs`
- Output: `data/fixtures/crown/20260708_004011/replay-normalized.jsonl`
- Output: `data/fixtures/crown/20260708_004011/replay-summary.json`
- Modify: `package.json`

**Script command:**

```powershell
node scripts\crown-replay-fixture.mjs data\fixtures\crown\20260708_004011
```

- [ ] Replay all candidate JSON samples through detector and normalizer.
- [ ] Write normalized selection records to JSONL.
- [ ] Write summary with counts by mode, league, endpoint, market type, warnings.
- [ ] Verify summary contains monitored leagues only.

## Task 8: Build Read-Only Watcher

**Files:**

- Create: `scripts/crown-watch.mjs`
- Create: `src/crown/storage/jsonl-store.mjs`
- Output: `data/runtime/crown-odds-snapshots.jsonl`
- Output: `data/runtime/crown-odds-changes.jsonl`
- Modify: `package.json`

**Script command:**

```powershell
npm run crown:watch
```

- [ ] Reuse `data/crown-profile`.
- [ ] Open Crown through Playwright.
- [ ] Let the page make its own requests.
- [ ] Listen to `page.on('response')`.
- [ ] Listen to `page.on('websocket')` and `framereceived`.
- [ ] Parse only responses detected by `endpoint-detector`.
- [ ] Apply normalizer and league filter.
- [ ] Append snapshots to JSONL.
- [ ] Compare latest selection odds by stable key:

```text
provider|eventId|marketId|selectionId
```

- [ ] Append changed odds to `crown-odds-changes.jsonl`.
- [ ] Log stats every 30 seconds:
  - responses seen
  - candidate responses
  - normalized records
  - filtered records
  - odds changes
  - errors
- [ ] Verify watcher produces JSONL while staying read-only.

## Task 9: Add Alerts After Watcher Is Stable

**Files:**

- Create: `src/crown/alerts/console-alert.mjs`
- Create: `src/crown/alerts/telegram-alert.mjs`
- Create: `config/alerts.json`

- [ ] Console alerts first.
- [ ] Telegram alerts only after console alert format is verified.
- [ ] Alert payload must include:
  - league
  - homeTeam
  - awayTeam
  - marketType
  - handicapRaw
  - old oddsRaw
  - new oddsRaw
  - capturedAt
- [ ] Do not include token/cookie/header values in alert payloads.

## Task 10: Optional SQLite Storage

**Files:**

- Create: `migrations/001_init.sql`
- Create: `src/crown/storage/sqlite-store.mjs`

- [ ] Keep JSONL as the audit source.
- [ ] Use SQLite for querying latest events, markets, selections, odds ticks, and alerts.
- [ ] Enable WAL mode.
- [ ] Use prepared statements.
- [ ] Store normalized odds and raw odds values.
- [ ] Do not store cookies, tokens, authorization, or set-cookie headers.

## Task 11: Future Automatic Login

**Status:** planned only. Do not implement during watcher stability validation.

**Files:**

- Create: `docs/crown-auto-login-plan.md`
- Future create: `src/crown/auth/auto-login.mjs`
- Future test: `tests/crown-auto-login.test.mjs`

- [ ] Define login state detection using page health signals:
  - `welcome`
  - `loading`
  - `login`
  - `football`
  - `unknown`
- [ ] Implement only ordinary login form automation after explicit user configuration:
  - open login URL
  - fill username
  - fill password from local encrypted config or environment variable
  - click login
  - wait for manual CAPTCHA / 2FA / risk checks when present
  - verify landing page is a Crown football page
- [ ] Do not bypass CAPTCHA, 2FA, device verification, risk controls, signatures, or account protections.
- [ ] Do not store plaintext password, cookie, token, authorization, or set-cookie values.
- [ ] Reuse existing `CROWN_SECRET_KEY`-style encryption boundary before saving any secret.
- [ ] Add dry-run and masked diagnostics:
  - current health state
  - login form found or not found
  - manual verification required or not required
  - final health state
- [ ] Keep automatic login separate from betting execution. It may only prepare a readable page for watcher/probe.
- [ ] Verify with a non-production or explicitly approved account profile before enabling for normal watcher runs.

## Acceptance Criteria

| Metric | Required Result |
|---|---|
| Endpoint candidates | narrowed to 3-8 likely core endpoints |
| Fixture replay | restores prematch/live football close to current baseline |
| League filtering | unknown football leagues ignored by default |
| Esports/virtual leakage | 0 records after filters |
| Watcher mode | page-listening only, no direct Crown API construction initially |
| Automatic login | planned only until watcher stability is proven; no CAPTCHA/2FA/risk bypass |
| Betting code | no executable betting submit/place/order logic |
| Output | append-only JSONL snapshots and odds changes |
| Verification | tests run through Node test runner and fixture replay |

## Recommended Execution Order

1. Task 1 fixture freeze.
2. Task 2 safety and future betting boundary docs.
3. Task 3 offline endpoint analyzer.
4. Manual review of top endpoint candidates.
5. Task 4 field mapping.
6. Task 5 league filter.
7. Task 6 endpoint detector and normalizer.
8. Task 7 fixture replay.
9. Task 8 read-only watcher.
10. Task 9 alerts.
11. Task 10 SQLite only when JSONL monitor is stable.
12. Task 11 automatic login only after watcher long-run stability is proven.
