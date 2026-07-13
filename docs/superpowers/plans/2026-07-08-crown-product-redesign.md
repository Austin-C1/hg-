# Crown Product Redesign Implementation Plan

> Superseded by `docs/superpowers/plans/2026-07-08-crown-product-redesign-react.md`. The newer plan reflects the user's request to inspect Blackcat's frontend implementation and rebuild Crown with a React + Ant Design + Vite UI instead of the earlier vanilla static dashboard approach.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current read-only Crown dashboard into a Docker-first local Crown odds monitoring and rule-configuration app with Blackcat-style navigation, SQLite persistence, configurable monitored matches, monitoring accounts, rule settings, betting-account records, and history scaffolding.

**Architecture:** Keep the current Node.js HTTP server and static frontend, but split backend responsibilities into focused SQLite storage, validation, API routing, and existing odds data aggregation modules. The first version is configuration and monitoring only: it stores settings and displays rule previews, but does not click odds, enter stake amounts, or submit real betting orders.

**Tech Stack:** Node.js ESM, built-in `node:http`, built-in `node:sqlite`, vanilla HTML/CSS/JS, Docker Compose, local SQLite database stored in a Docker volume.

---

## Scope Boundary

This plan implements configuration, monitoring setup, local persistence, UI navigation, and Docker/GitHub installability.

This plan does not implement real betting execution:

- No Crown odds clicking.
- No stake input automation.
- No bet slip opening.
- No order submission.
- No external credential upload.
- No hardcoded accounts, matches, leagues, rules, or deployment paths.

## Requirement Coverage

| User requirement | Plan coverage |
|---|---|
| UI similar to Blackcat | Task 4 creates a left-nav app shell and matching operational workspace layout. |
| Left nav page: 比赛选择 | Task 5 migrates current events dashboard into Match Selection with tracking toggles. |
| Left nav page: 赔率监控设置 | Task 6 creates monitor settings UI/API for monitor accounts and odds rules. |
| Left nav page: 下注规则设置 | Task 7 creates rule UI/API for non-executing betting-rule configuration. |
| Left nav page: 投注账号配置 | Task 8 creates betting-account UI/API and history scaffolding. |
| GitHub download + Docker local run | Task 9 updates Docker, env example, README, and local volume setup. |
| No hardcoding | Task 2 stores all user-controlled config in SQLite and Task 9 ignores private data. |
| First phase only config/monitoring | Every rule endpoint is CRUD/preview only; Task 10 scans for execution keywords. |

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/crown/app/app-db.mjs` | Create | Open SQLite database, create schema, seed defaults, run small transactional helpers. |
| `src/crown/app/app-repository.mjs` | Create | CRUD repository for tracked matches, monitor accounts, monitor rules, betting rules, betting accounts, and history records. |
| `src/crown/app/app-validation.mjs` | Create | Validate request payloads and normalize defaults before database writes. |
| `src/crown/app/app-api.mjs` | Create | Route app configuration APIs and return safe JSON responses. |
| `src/crown/dashboard/static-server.mjs` | Modify | Delegate `/api/app/*` routes to app API and keep existing odds APIs. |
| `scripts/crown-dashboard.mjs` | Modify | Pass storage path into server from `CROWN_DB_PATH`. |
| `public/dashboard/index.html` | Modify | Replace current single dashboard shell with Blackcat-style app shell and four pages. |
| `public/dashboard/dashboard.css` | Modify | Implement Blackcat-like sidebar/workspace styling, dense tables, forms, and responsive states. |
| `public/dashboard/dashboard.js` | Modify | Add navigation, API client, page renderers, forms, and tracking/rule/account actions. |
| `Dockerfile` | Modify | Create `/app/storage`, set `CROWN_DB_PATH=/app/storage/crown.sqlite`, keep app on `0.0.0.0:8787`. |
| `docker-compose.yml` | Modify | Mount `crown-storage` volume to `/app/storage`. |
| `.env.example` | Create | Document configurable port, DB path, and encryption placeholder names without secrets. |
| `README.md` | Modify | Document GitHub clone, `.env`, Docker run, first-time setup, and safety boundary. |
| `docs/modules/crown-dashboard.md` | Modify | Update module doc from read-only dashboard to configuration app shell. |
| `docs/project-memory.md` | Modify after verification | Record stable Docker/SQLite/UI facts only after tests pass. |
| `tests/crown-app-db.test.mjs` | Create | Database schema, defaults, and persistence tests. |
| `tests/crown-app-repository.test.mjs` | Create | CRUD and history tests. |
| `tests/crown-app-api.test.mjs` | Create | `/api/app/*` route tests. |
| `tests/crown-app-ui-smoke.test.mjs` | Create | Static UI contract tests for required nav/pages/forms. |
| `tests/crown-dashboard-docker.test.mjs` | Modify | Verify storage volume and `CROWN_DB_PATH`. |

## API Contract

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/app/bootstrap` | `GET` | Return all page data: app status, tracked matches, monitor accounts, monitor rules, betting rules, betting accounts, histories. |
| `/api/app/tracked-matches` | `POST` | Track or untrack a match by stable event key. |
| `/api/app/monitor-accounts` | `GET/POST` | List and add monitor login accounts. |
| `/api/app/monitor-accounts/:id` | `PUT/DELETE` | Update or remove monitor accounts. |
| `/api/app/monitor-rules` | `GET/POST` | List and add odds-monitoring rules. |
| `/api/app/monitor-rules/:id` | `PUT/DELETE` | Update or remove odds-monitoring rules. |
| `/api/app/betting-rules` | `GET/POST` | List and add non-executing betting rules. |
| `/api/app/betting-rules/:id` | `PUT/DELETE` | Update or remove betting rules. |
| `/api/app/betting-accounts` | `GET/POST` | List and add betting account records. |
| `/api/app/betting-accounts/:id` | `PUT/DELETE` | Update or remove betting account records. |
| `/api/app/betting-history` | `GET` | Return history rows; first phase can be empty/manual/system-generated only. |

## SQLite Schema

Use `node:sqlite` and store the database at `CROWN_DB_PATH`, defaulting to `storage/crown.sqlite`.

```sql
CREATE TABLE IF NOT EXISTS tracked_matches (
  event_key TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  login_role TEXT NOT NULL DEFAULT 'monitor',
  status TEXT NOT NULL DEFAULT 'disabled',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  league_filter TEXT NOT NULL DEFAULT '',
  mode_filter TEXT NOT NULL DEFAULT '',
  min_odds_change REAL NOT NULL DEFAULT 0.03,
  poll_seconds INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  market_type TEXT NOT NULL DEFAULT 'asian_handicap',
  min_odds REAL,
  max_odds REAL,
  max_single_amount REAL NOT NULL DEFAULT 0,
  max_event_amount REAL NOT NULL DEFAULT 0,
  stop_loss_amount REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'manual_review',
  status TEXT NOT NULL DEFAULT 'disabled',
  daily_limit REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_history (
  id TEXT PRIMARY KEY,
  betting_account_id TEXT,
  event_key TEXT,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  amount REAL NOT NULL DEFAULT 0,
  odds_raw TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
```

## Task 1: Runtime And SQLite Baseline

**Files:**

- Modify: `package.json`
- Create: `tests/crown-app-db.test.mjs`
- Create: `src/crown/app/app-db.mjs`

- [ ] **Step 1: Write failing database tests**

Create `tests/crown-app-db.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'

test('opens SQLite database and creates required app tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-db-'))
  const dbPath = path.join(dir, 'crown.sqlite')
  const db = openAppDatabase({ dbPath })

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
  assert.ok(tables.includes('tracked_matches'))
  assert.ok(tables.includes('monitor_accounts'))
  assert.ok(tables.includes('monitor_rules'))
  assert.ok(tables.includes('betting_rules'))
  assert.ok(tables.includes('betting_accounts'))
  assert.ok(tables.includes('betting_history'))
  db.close()
})

test('database persists data across open calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-db-'))
  const dbPath = path.join(dir, 'crown.sqlite')
  const first = openAppDatabase({ dbPath })
  first.prepare("INSERT INTO monitor_rules (id, name, created_at, updated_at) VALUES ('rule-1', '水位变化', '2026-07-08T00:00:00.000Z', '2026-07-08T00:00:00.000Z')").run()
  first.close()

  const second = openAppDatabase({ dbPath })
  assert.equal(second.prepare('SELECT COUNT(*) AS count FROM monitor_rules').get().count, 1)
  second.close()
})
```

- [ ] **Step 2: Run test and verify RED**

```powershell
node --test tests\crown-app-db.test.mjs
```

Expected: fails because `src/crown/app/app-db.mjs` does not exist.

- [ ] **Step 3: Implement database module**

Create `src/crown/app/app-db.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracked_matches (
  event_key TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  login_role TEXT NOT NULL DEFAULT 'monitor',
  status TEXT NOT NULL DEFAULT 'disabled',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  league_filter TEXT NOT NULL DEFAULT '',
  mode_filter TEXT NOT NULL DEFAULT '',
  min_odds_change REAL NOT NULL DEFAULT 0.03,
  poll_seconds INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS betting_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  market_type TEXT NOT NULL DEFAULT 'asian_handicap',
  min_odds REAL,
  max_odds REAL,
  max_single_amount REAL NOT NULL DEFAULT 0,
  max_event_amount REAL NOT NULL DEFAULT 0,
  stop_loss_amount REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS betting_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'manual_review',
  status TEXT NOT NULL DEFAULT 'disabled',
  daily_limit REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS betting_history (
  id TEXT PRIMARY KEY,
  betting_account_id TEXT,
  event_key TEXT,
  rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  amount REAL NOT NULL DEFAULT 0,
  odds_raw TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
`

export function defaultDbPath() {
  return process.env.CROWN_DB_PATH || 'storage/crown.sqlite'
}

export function openAppDatabase({ dbPath = defaultDbPath() } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}
```

- [ ] **Step 4: Update Node engine**

Modify `package.json`:

```json
"engines": {
  "node": ">=22.5"
}
```

This is required because the app uses built-in `node:sqlite`.

- [ ] **Step 5: Verify GREEN**

```powershell
node --test tests\crown-app-db.test.mjs
npm run check
```

Expected: database tests pass and syntax check passes.

## Task 2: SQLite Repository And Validation

**Files:**

- Create: `tests/crown-app-repository.test.mjs`
- Create: `src/crown/app/app-validation.mjs`
- Create: `src/crown/app/app-repository.mjs`

- [ ] **Step 1: Write failing repository tests**

Create `tests/crown-app-repository.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-repo-'))
  const db = openAppDatabase({ dbPath: path.join(dir, 'crown.sqlite') })
  return { db, repository: createAppRepository(db) }
}

test('tracks and untracks matches by stable event key', () => {
  const { db, repository } = repo()
  repository.trackMatch({
    eventKey: 'crown|世界杯2026(美加墨)|瑞士|哥伦比亚|prematch',
    league: '世界杯2026(美加墨)',
    homeTeam: '瑞士',
    awayTeam: '哥伦比亚',
    mode: 'prematch',
  })

  assert.equal(repository.listTrackedMatches().length, 1)
  repository.untrackMatch('crown|世界杯2026(美加墨)|瑞士|哥伦比亚|prematch')
  assert.equal(repository.listTrackedMatches()[0].status, 'inactive')
  db.close()
})

test('creates monitor account, monitor rule, betting rule, and betting account records', () => {
  const { db, repository } = repo()
  const monitorAccount = repository.createMonitorAccount({ label: '监控号 A', username: 'monitor-a' })
  const monitorRule = repository.createMonitorRule({ name: '水位变化 0.03', minOddsChange: 0.03, pollSeconds: 5 })
  const bettingRule = repository.createBettingRule({ name: '只预览规则', marketType: 'asian_handicap', maxSingleAmount: 100 })
  const bettingAccount = repository.createBettingAccount({ label: '投注号 A', username: 'bet-a', dailyLimit: 500 })

  assert.equal(monitorAccount.status, 'disabled')
  assert.equal(monitorRule.enabled, true)
  assert.equal(bettingRule.enabled, false)
  assert.equal(bettingAccount.status, 'disabled')
  assert.equal(repository.bootstrap().monitorAccounts.length, 1)
  assert.equal(repository.bootstrap().bettingRules.length, 1)
  db.close()
})
```

- [ ] **Step 2: Run test and verify RED**

```powershell
node --test tests\crown-app-repository.test.mjs
```

Expected: fails because repository module does not exist.

- [ ] **Step 3: Implement validation helpers**

Create `src/crown/app/app-validation.mjs`:

```js
import crypto from 'node:crypto'

export function nowIso() {
  return new Date().toISOString()
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

export function stringField(value, fallback = '') {
  if (value === null || value === undefined) return fallback
  return String(value).trim()
}

export function numberField(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function booleanToInt(value) {
  return value ? 1 : 0
}

export function intToBoolean(value) {
  return Number(value) === 1
}
```

- [ ] **Step 4: Implement repository**

Create `src/crown/app/app-repository.mjs` with CRUD functions:

```js
import { booleanToInt, intToBoolean, newId, nowIso, numberField, stringField } from './app-validation.mjs'

function rowToMonitorRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: intToBoolean(row.enabled),
    leagueFilter: row.league_filter,
    modeFilter: row.mode_filter,
    minOddsChange: row.min_odds_change,
    pollSeconds: row.poll_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToBettingRule(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: intToBoolean(row.enabled),
    marketType: row.market_type,
    minOdds: row.min_odds,
    maxOdds: row.max_odds,
    maxSingleAmount: row.max_single_amount,
    maxEventAmount: row.max_event_amount,
    stopLossAmount: row.stop_loss_amount,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMonitorAccount(row) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    loginRole: row.login_role,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToBettingAccount(row) {
  return {
    id: row.id,
    label: row.label,
    username: row.username,
    purpose: row.purpose,
    status: row.status,
    dailyLimit: row.daily_limit,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTrackedMatch(row) {
  return {
    eventKey: row.event_key,
    league: row.league,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    mode: row.mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAppRepository(db) {
  return {
    bootstrap() {
      return {
        trackedMatches: this.listTrackedMatches(),
        monitorAccounts: this.listMonitorAccounts(),
        monitorRules: this.listMonitorRules(),
        bettingRules: this.listBettingRules(),
        bettingAccounts: this.listBettingAccounts(),
        bettingHistory: this.listBettingHistory(),
      }
    },
    listTrackedMatches() {
      return db.prepare('SELECT * FROM tracked_matches ORDER BY updated_at DESC').all().map(rowToTrackedMatch)
    },
    trackMatch(input) {
      const time = nowIso()
      const record = {
        eventKey: stringField(input.eventKey),
        league: stringField(input.league),
        homeTeam: stringField(input.homeTeam),
        awayTeam: stringField(input.awayTeam),
        mode: stringField(input.mode, 'unknown'),
      }
      db.prepare(`
        INSERT INTO tracked_matches (event_key, league, home_team, away_team, mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
      `).run(record.eventKey, record.league, record.homeTeam, record.awayTeam, record.mode, time, time)
      return this.listTrackedMatches().find((item) => item.eventKey === record.eventKey)
    },
    untrackMatch(eventKey) {
      db.prepare('UPDATE tracked_matches SET status = ?, updated_at = ? WHERE event_key = ?').run('inactive', nowIso(), eventKey)
    },
    listMonitorAccounts() {
      return db.prepare('SELECT * FROM monitor_accounts ORDER BY created_at DESC').all().map(rowToMonitorAccount)
    },
    createMonitorAccount(input) {
      const time = nowIso()
      const id = newId('monitor')
      db.prepare('INSERT INTO monitor_accounts (id, label, username, login_role, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, stringField(input.label), stringField(input.username), 'monitor', 'disabled', stringField(input.notes), time, time)
      return this.listMonitorAccounts().find((item) => item.id === id)
    },
    listMonitorRules() {
      return db.prepare('SELECT * FROM monitor_rules ORDER BY created_at DESC').all().map(rowToMonitorRule)
    },
    createMonitorRule(input) {
      const time = nowIso()
      const id = newId('monitor_rule')
      db.prepare('INSERT INTO monitor_rules (id, name, enabled, league_filter, mode_filter, min_odds_change, poll_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, stringField(input.name), booleanToInt(input.enabled !== false), stringField(input.leagueFilter), stringField(input.modeFilter), numberField(input.minOddsChange, 0.03), numberField(input.pollSeconds, 5), time, time)
      return this.listMonitorRules().find((item) => item.id === id)
    },
    listBettingRules() {
      return db.prepare('SELECT * FROM betting_rules ORDER BY created_at DESC').all().map(rowToBettingRule)
    },
    createBettingRule(input) {
      const time = nowIso()
      const id = newId('betting_rule')
      db.prepare('INSERT INTO betting_rules (id, name, enabled, market_type, min_odds, max_odds, max_single_amount, max_event_amount, stop_loss_amount, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, stringField(input.name), booleanToInt(false), stringField(input.marketType, 'asian_handicap'), input.minOdds ?? null, input.maxOdds ?? null, numberField(input.maxSingleAmount), numberField(input.maxEventAmount), numberField(input.stopLossAmount), stringField(input.notes), time, time)
      return this.listBettingRules().find((item) => item.id === id)
    },
    listBettingAccounts() {
      return db.prepare('SELECT * FROM betting_accounts ORDER BY created_at DESC').all().map(rowToBettingAccount)
    },
    createBettingAccount(input) {
      const time = nowIso()
      const id = newId('betting_account')
      db.prepare('INSERT INTO betting_accounts (id, label, username, purpose, status, daily_limit, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, stringField(input.label), stringField(input.username), stringField(input.purpose, 'manual_review'), 'disabled', numberField(input.dailyLimit), stringField(input.notes), time, time)
      return this.listBettingAccounts().find((item) => item.id === id)
    },
    listBettingHistory() {
      return db.prepare('SELECT * FROM betting_history ORDER BY created_at DESC LIMIT 100').all()
    },
  }
}
```

- [ ] **Step 5: Verify GREEN**

```powershell
node --test tests\crown-app-repository.test.mjs
npm run check
```

Expected: repository tests pass.

## Task 3: App API Routes

**Files:**

- Create: `tests/crown-app-api.test.mjs`
- Create: `src/crown/app/app-api.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `scripts/crown-dashboard.mjs`

- [ ] **Step 1: Write failing API tests**

Create `tests/crown-app-api.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'

async function withServer(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-app-api-'))
  const staticDir = path.join(dir, 'public')
  fs.mkdirSync(staticDir, { recursive: true })
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Crown</title>', 'utf8')
  const server = createDashboardServer({ staticDir, appOptions: { dbPath: path.join(dir, 'crown.sqlite') } })
  t.after(() => server.close())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  await handler(`http://127.0.0.1:${server.address().port}`)
}

test('app bootstrap and create endpoints persist configuration', async (t) => {
  await withServer(t, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/app/monitor-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '水位变化', minOddsChange: 0.05, pollSeconds: 8 }),
    })
    assert.equal(created.status, 200)
    assert.equal((await created.json()).item.name, '水位变化')

    const bootstrap = await fetch(`${baseUrl}/api/app/bootstrap`)
    const payload = await bootstrap.json()
    assert.equal(bootstrap.status, 200)
    assert.equal(payload.monitorRules.length, 1)
  })
})
```

- [ ] **Step 2: Run test and verify RED**

```powershell
node --test tests\crown-app-api.test.mjs
```

Expected: 404 or module missing because `/api/app/*` routes do not exist.

- [ ] **Step 3: Implement app API router**

Create `src/crown/app/app-api.mjs` with `handleAppApi(request, response, options)`. It should:

- Open SQLite via `openAppDatabase(options)`.
- Create repository via `createAppRepository(db)`.
- Parse JSON body for POST/PUT.
- Return `400` with `{ error: "invalid-json" }` for malformed JSON.
- Return `404` with `{ error: "not-found" }` for unknown app routes.
- Close the database after each request.

Minimum route behavior:

```js
if (method === 'GET' && pathname === '/api/app/bootstrap') {
  return sendJson(res, 200, repository.bootstrap())
}
if (method === 'POST' && pathname === '/api/app/monitor-rules') {
  return sendJson(res, 200, { item: repository.createMonitorRule(body) })
}
if (method === 'POST' && pathname === '/api/app/tracked-matches') {
  return sendJson(res, 200, { item: repository.trackMatch(body) })
}
```

Add equivalent POST handlers for monitor accounts, betting rules, and betting accounts.

- [ ] **Step 4: Wire static server**

Modify `src/crown/dashboard/static-server.mjs`:

```js
import { handleAppApi } from '../app/app-api.mjs'

export function createDashboardServer({ staticDir = DEFAULT_STATIC_DIR, dataOptions = {}, appOptions = {} } = {}) {
  return http.createServer((req, res) => {
    ;(async () => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
      if (requestUrl.pathname.startsWith('/api/app/')) {
        await handleAppApi(req, res, { ...appOptions, pathname: requestUrl.pathname })
        return
      }
      // existing behavior stays unchanged
    })().catch(() => sendJson(res, 500, { error: 'server-error' }))
  })
}
```

- [ ] **Step 5: Pass DB path from CLI**

Modify `scripts/crown-dashboard.mjs`:

```js
const dbPath = process.env.CROWN_DB_PATH || 'storage/crown.sqlite'
const server = await startDashboardServer({ host, port, appOptions: { dbPath } })
```

- [ ] **Step 6: Verify GREEN**

```powershell
node --test tests\crown-app-api.test.mjs
npm test
npm run check
```

Expected: all tests pass.

## Task 4: Blackcat-Style App Shell

**Files:**

- Create: `tests/crown-app-ui-smoke.test.mjs`
- Modify: `public/dashboard/index.html`
- Modify: `public/dashboard/dashboard.css`
- Modify: `public/dashboard/dashboard.js`

- [ ] **Step 1: Write failing UI contract test**

Create `tests/crown-app-ui-smoke.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('dashboard HTML contains required Crown app navigation pages', () => {
  const html = fs.readFileSync('public/dashboard/index.html', 'utf8')
  for (const label of ['比赛选择', '赔率监控设置', '下注规则设置', '投注账号配置']) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, /data-page="match-selection"/)
  assert.match(html, /data-page="monitor-settings"/)
  assert.match(html, /data-page="betting-rules"/)
  assert.match(html, /data-page="betting-accounts"/)
})
```

- [ ] **Step 2: Run test and verify RED**

```powershell
node --test tests\crown-app-ui-smoke.test.mjs
```

Expected: fails because current UI does not contain these pages.

- [ ] **Step 3: Replace page shell**

Modify `public/dashboard/index.html` so the body has:

```html
<aside class="app-sidebar">
  <div class="brand">皇冠抓水投注 <span>local</span></div>
  <button class="nav-item active" data-page="match-selection">比赛选择</button>
  <button class="nav-item" data-page="monitor-settings">赔率监控设置</button>
  <button class="nav-item" data-page="betting-rules">下注规则设置</button>
  <button class="nav-item" data-page="betting-accounts">投注账号配置</button>
</aside>
<main class="app-main">
  <header class="app-topbar">
    <h1 id="pageTitle">比赛选择</h1>
    <span id="appStatus">Docker local</span>
  </header>
  <section class="page active" data-page-panel="match-selection"></section>
  <section class="page" data-page-panel="monitor-settings"></section>
  <section class="page" data-page-panel="betting-rules"></section>
  <section class="page" data-page-panel="betting-accounts"></section>
</main>
```

- [ ] **Step 4: Implement navigation JS**

In `public/dashboard/dashboard.js`, add page switching:

```js
const pageTitles = {
  'match-selection': '比赛选择',
  'monitor-settings': '赔率监控设置',
  'betting-rules': '下注规则设置',
  'betting-accounts': '投注账号配置',
}

function showPage(page) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page))
  document.querySelectorAll('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page))
  document.querySelector('#pageTitle').textContent = pageTitles[page]
}
```

- [ ] **Step 5: Update CSS**

Make layout match Blackcat-style structure:

- Dark left sidebar.
- Light gray workspace.
- White table/form panels.
- 8px or less radius.
- Dense operational spacing.
- No landing hero.

- [ ] **Step 6: Verify GREEN**

```powershell
node --test tests\crown-app-ui-smoke.test.mjs
node --check public\dashboard\dashboard.js
```

Expected: UI contract and JS syntax pass.

## Task 5: 比赛选择 Page

**Files:**

- Modify: `public/dashboard/dashboard.js`
- Modify: `public/dashboard/dashboard.css`
- Modify: `tests/crown-app-api.test.mjs`

- [ ] **Step 1: Add API test for tracked match**

Extend `tests/crown-app-api.test.mjs`:

```js
const tracked = await fetch(`${baseUrl}/api/app/tracked-matches`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    eventKey: 'crown|世界杯2026(美加墨)|瑞士|哥伦比亚|prematch',
    league: '世界杯2026(美加墨)',
    homeTeam: '瑞士',
    awayTeam: '哥伦比亚',
    mode: 'prematch',
  }),
})
assert.equal(tracked.status, 200)
assert.equal((await tracked.json()).item.status, 'active')
```

- [ ] **Step 2: Run test and verify current API behavior**

```powershell
node --test tests\crown-app-api.test.mjs
```

Expected: passes if Task 3 implemented tracked match API; fails otherwise.

- [ ] **Step 3: Render Match Selection**

Move existing event table, filters, detail panel, and recent changes into `renderMatchSelectionPage()`.

Add a track button column:

```js
const trackedKeys = new Set(state.app.trackedMatches.filter((item) => item.status === 'active').map((item) => item.eventKey))
const isTracked = trackedKeys.has(event.eventKey)
const button = el('button', isTracked ? 'small-button active' : 'small-button', isTracked ? '已追踪' : '追踪')
button.addEventListener('click', () => toggleTrackedMatch(event))
```

- [ ] **Step 4: Implement toggle API call**

```js
async function toggleTrackedMatch(event) {
  await postJson('/api/app/tracked-matches', {
    eventKey: event.eventKey,
    league: event.league,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    mode: event.mode,
  })
  await refreshDashboard()
}
```

- [ ] **Step 5: Verify**

```powershell
npm test
```

Manual browser check:

- Open `http://127.0.0.1:8787`.
- Click “比赛选择”.
- Click “追踪”.
- Refresh page.
- Expected: row still shows “已追踪”.

## Task 6: 赔率监控设置 Page

**Files:**

- Modify: `public/dashboard/dashboard.js`
- Modify: `public/dashboard/dashboard.css`
- Modify: `tests/crown-app-api.test.mjs`

- [ ] **Step 1: Extend API test**

Add:

```js
const account = await fetch(`${baseUrl}/api/app/monitor-accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: '监控号 A', username: 'monitor-a' }),
})
assert.equal(account.status, 200)
assert.equal((await account.json()).item.status, 'disabled')
```

- [ ] **Step 2: Render monitor settings form**

Render these fields:

- `label` for monitor account display name.
- `username` for Crown login username.
- `monitor rule name`.
- `league filter`.
- `mode filter`.
- `min odds change`.
- `poll seconds`.

All saved through `/api/app/monitor-accounts` and `/api/app/monitor-rules`.

- [ ] **Step 3: Render monitor tables**

Show:

- Monitor account list.
- Monitor rule list.
- Status badges: `disabled`, `enabled`, `needs-login`.

- [ ] **Step 4: Verify**

Manual browser check:

- Add monitor account.
- Add monitor rule.
- Refresh page.
- Expected: both records remain.

## Task 7: 下注规则设置 Page

**Files:**

- Modify: `public/dashboard/dashboard.js`
- Modify: `public/dashboard/dashboard.css`
- Modify: `tests/crown-app-api.test.mjs`

- [ ] **Step 1: Extend API test**

Add:

```js
const rule = await fetch(`${baseUrl}/api/app/betting-rules`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: '只预览规则',
    marketType: 'asian_handicap',
    maxSingleAmount: 100,
    maxEventAmount: 300,
    stopLossAmount: 500,
  }),
})
assert.equal(rule.status, 200)
assert.equal((await rule.json()).item.enabled, false)
```

- [ ] **Step 2: Render betting rules form**

Fields:

- Rule name.
- Market type.
- Min odds.
- Max odds.
- Max single amount.
- Max event amount.
- Stop loss amount.
- Notes.

Default `enabled` must be false.

- [ ] **Step 3: Show non-execution warning**

UI text:

```text
当前阶段只保存和预览规则，不会执行真实下注。
```

- [ ] **Step 4: Verify safety**

Run:

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs,public\dashboard\*.js,public\dashboard\*.html -Pattern 'placeBet|submitBet|wager|stake|ticket|order|bet-slip|betslip' -SimpleMatch
```

Expected: no execution code is introduced. If text labels trigger matches, reword UI labels to `投注历史` / `规则预览` and keep no execution functions.

## Task 8: 投注账号配置 Page

**Files:**

- Modify: `public/dashboard/dashboard.js`
- Modify: `public/dashboard/dashboard.css`
- Modify: `tests/crown-app-api.test.mjs`

- [ ] **Step 1: Extend API test**

Add:

```js
const bettingAccount = await fetch(`${baseUrl}/api/app/betting-accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: '投注号 A', username: 'bet-a', dailyLimit: 500 }),
})
assert.equal(bettingAccount.status, 200)
assert.equal((await bettingAccount.json()).item.status, 'disabled')
```

- [ ] **Step 2: Render betting account form**

Fields:

- Account label.
- Username.
- Purpose.
- Status.
- Daily limit.
- Notes.

- [ ] **Step 3: Render history scaffold**

Show history table columns:

- Time.
- Account.
- Match.
- Rule.
- Status.
- Amount.
- Odds.

Empty state:

```text
暂无投注历史。当前阶段不会自动提交真实投注。
```

- [ ] **Step 4: Verify**

Manual browser check:

- Add betting account.
- Refresh page.
- Expected: account remains and history table renders empty state.

## Task 9: Docker And GitHub Install Flow

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Create: `.env.example`
- Modify: `tests/crown-dashboard-docker.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Update Docker test**

Extend `tests/crown-dashboard-docker.test.mjs`:

```js
assert.match(dockerfile, /CROWN_DB_PATH=\/app\/storage\/crown\.sqlite/)
assert.match(compose, /crown-storage:\/app\/storage/)
assert.match(compose, /crown-storage:/)
```

- [ ] **Step 2: Run Docker test and verify RED**

```powershell
node --test tests\crown-dashboard-docker.test.mjs
```

Expected: fails until Docker config includes SQLite volume.

- [ ] **Step 3: Update Dockerfile**

Add:

```dockerfile
ENV CROWN_DB_PATH=/app/storage/crown.sqlite
RUN mkdir -p /app/storage
```

- [ ] **Step 4: Update docker-compose.yml**

Add:

```yaml
volumes:
  - crown-storage:/app/storage

volumes:
  crown-storage:
```

- [ ] **Step 5: Add env example**

Create `.env.example`:

```dotenv
CROWN_DASHBOARD_PORT=8787
CROWN_DB_PATH=/app/storage/crown.sqlite
```

- [ ] **Step 6: Update README**

Document:

```powershell
git clone <repo-url>
cd <repo>
copy .env.example .env
docker compose -p crown-dashboard up --build
```

Also document:

- Local URL.
- Local storage volume.
- No credentials committed.
- First-run setup order.

- [ ] **Step 7: Verify Docker**

```powershell
docker compose -p crown-dashboard up --build -d
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/app/bootstrap
```

Expected: container starts and bootstrap returns JSON.

## Task 10: Documentation, Memory, And Final Verification

**Files:**

- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`
- Read-only verification across project.

- [ ] **Step 1: Update module docs**

Update `docs/modules/crown-dashboard.md` to cover:

- Blackcat-style app shell.
- SQLite database.
- Four pages.
- Docker install.
- Safety boundary.
- Verification commands.

- [ ] **Step 2: Update module index**

Update Dashboard row:

```text
皇冠抓水投注应用壳：Docker 本地运行，SQLite 持久化，四个配置/监控页面，不执行真实下注。
```

- [ ] **Step 3: Update project memory after verification**

Record only stable facts:

- SQLite path.
- Docker volume.
- Four page names.
- No real betting execution.
- Test results.

- [ ] **Step 4: Full automated verification**

Run:

```powershell
npm test
npm run check
node --check public\dashboard\dashboard.js
```

Expected:

- All tests pass.
- Syntax OK.
- Static JS syntax OK.

- [ ] **Step 5: Docker API verification**

Run:

```powershell
docker compose -p crown-dashboard up --build -d
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/app/bootstrap
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/events
```

Expected:

- Both return 200.
- Bootstrap includes arrays for all configuration entities.
- Events still return current odds events.

- [ ] **Step 6: Browser verification**

Open:

```text
http://127.0.0.1:8787
```

Check:

- Left nav has four pages.
- Each page switches correctly.
- Match tracking persists after refresh.
- Monitor account persists after refresh.
- Monitor rule persists after refresh.
- Betting rule persists after refresh and is disabled by default.
- Betting account persists after refresh.
- No visible text overlap on desktop and narrow viewport.

- [ ] **Step 7: Safety scan**

Run:

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs,public\dashboard\*.js,public\dashboard\*.html -Pattern 'placeBet|submitBet|wager|stake|ticket|order|bet-slip|betslip' -SimpleMatch
```

Expected: no betting execution code or UI is introduced. If there are documentation-only matches, review and keep only if clearly non-executing.

## Acceptance Criteria

| Item | Required result |
|---|---|
| Docker install | `docker compose -p crown-dashboard up --build` starts the app. |
| SQLite | App creates and persists `crown.sqlite` in Docker storage volume. |
| UI shell | Left sidebar has exactly four functional pages. |
| 比赛选择 | Current event data renders and track/untrack persists. |
| 赔率监控设置 | Monitor accounts and monitor rules can be created and persist. |
| 下注规则设置 | Betting rules can be created, persist, and are disabled by default. |
| 投注账号配置 | Betting accounts and history scaffold render and persist. |
| No hardcoding | No user account, match, rule, league, or secret is hardcoded for runtime behavior. |
| Safety | No real betting execution code is introduced. |
| Verification | Tests, syntax check, Docker API checks, browser checks, and safety scan pass. |

## Execution Notes

- Implement with TDD: write each failing test before production code.
- Keep the first version simple; do not introduce React in this phase.
- Do not add real Crown login automation in this plan; store monitor account records only.
- Do not encrypt credentials in this phase unless password fields are added. Prefer storing account labels/usernames first and defer secrets to a separate security design.
- If password/secret storage becomes required, add a separate design for encryption key management before implementing it.
