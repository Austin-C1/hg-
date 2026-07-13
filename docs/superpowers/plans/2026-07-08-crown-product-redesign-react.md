# Crown Product Redesign React Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current read-only Crown dashboard into a Docker-first local Crown odds monitoring and configuration app with a Blackcat-style React + Ant Design UI, SQLite persistence, configurable monitor accounts, tracked matches, monitor rules, betting rules, betting-account records, and history scaffolding.

**Architecture:** Keep the existing Node.js ESM HTTP server as the local API/static server, add a focused SQLite application layer under `src/crown/app/`, and add a new `frontend/` React app built with Vite. Docker builds the React frontend into static files, then the Node server serves the built UI and `/api/*` endpoints from one local container.

**Tech Stack:** Node.js ESM, built-in `node:http`, built-in `node:sqlite`, React 18, TypeScript, Vite 5, Ant Design 5, Axios, Vitest, Docker Compose, local SQLite database stored in a Docker volume.

---

## Blackcat UI Findings

| Source | What to reuse for Crown |
|---|---|
| `参考项目/frontend/src/components/Layout.tsx` | Fixed dark left `Sider`, mobile `Drawer`, Ant Design `Menu`, right-side gray workspace, 220px desktop sidebar, responsive menu behavior. |
| `参考项目/frontend/src/App.tsx` | `BrowserRouter`, route-per-page structure, lazy page loading, `ConfigProvider` with Chinese Ant Design locale. |
| `参考项目/frontend/src/pages/PersonalDashboard.tsx` | Dense operational dashboard: KPI cards, quick actions, tabbed tables, status tags, empty states. |
| `参考项目/frontend/src/pages/WatchAddressList.tsx` | List page pattern: toolbar, primary add button, filter panel, table, add modal, detail drawer, delete confirmation. |
| `参考项目/frontend/src/pages/FollowTradingPage.tsx` | Rule/config page pattern: grouped account panels, metrics, edit modal, `Form + Select + InputNumber`, enabled/disabled status tags. |
| `参考项目/frontend/src/services/api.ts` | Central Axios API client using relative `/api` base URL, typed service methods, request timeout and response error handling. |

This plan reuses implementation patterns, layout behavior, and component choices. It does not copy Blackcat business logic or Polymarket-specific code.

## Scope Boundary

This plan implements local configuration, monitoring setup, UI navigation, persistence, Docker installability, and read-only odds display.

This plan does not implement real betting execution:

- No Crown odds clicking.
- No bet slip opening.
- No stake automation.
- No order submission.
- No browser control from the dashboard.
- No hardcoded accounts, passwords, matches, leagues, rules, or deployment paths.

Sensitive account fields are local-only. Passwords or session secrets are encrypted with an auto-generated local key; API responses return `hasSecret: true/false`, never the secret value.

## Requirement Coverage

| User requirement | Plan coverage |
|---|---|
| UI like Blackcat | Task 4 creates a React + Ant Design app shell using the same Sider/Menu/Content pattern as Blackcat. |
| Left nav: 比赛选择 | Task 5 builds a match table, filters, detail drawer, and track/untrack actions. |
| Left nav: 赔率监控设置 | Task 6 builds monitor account configuration and odds-monitor rule CRUD. |
| Left nav: 下注规则设置 | Task 7 builds betting rule configuration and preview-only safety states. |
| Left nav: 投注账号配置 | Task 8 builds betting account configuration and betting history scaffold. |
| GitHub download + Docker local run | Task 9 makes Docker build backend + frontend, stores SQLite in a volume, and documents clone/run flow. |
| Use SQLite | Tasks 1-3 add `node:sqlite` database, repositories, validation, and API routes. |
| No hardcoding | Runtime configuration lives in SQLite, `.env`, Docker volume, or JSONL/fixture inputs; no private values are committed. |
| First phase config/monitoring | The UI and API save settings and show read-only odds/history only; Task 10 runs a safety scan for execution code. |

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Require Node `>=22.5`, add root scripts for backend server, frontend build/test, and Docker run. |
| `src/crown/app/app-db.mjs` | Create | Open SQLite database, create schema, enable WAL, and expose database lifecycle helpers. |
| `src/crown/app/app-secret.mjs` | Create | Encrypt/decrypt local account secrets with an auto-generated local key using AES-256-GCM; never log secrets. |
| `src/crown/app/app-validation.mjs` | Create | Normalize request payloads, validate enum/numeric fields, and return stable 400 errors. |
| `src/crown/app/app-repository.mjs` | Create | CRUD repository for tracked matches, monitor accounts, monitor rules, betting rules, betting accounts, and history. |
| `src/crown/app/app-api.mjs` | Create | Route `/api/app/*` endpoints and return safe JSON responses. |
| `src/crown/dashboard/static-server.mjs` | Modify | Delegate `/api/app/*` to app API, keep existing odds APIs, and serve `frontend/dist` with SPA fallback. |
| `scripts/crown-dashboard.mjs` | Modify | Read `CROWN_DB_PATH`, `CROWN_STATIC_DIR`, host, and port from environment. |
| `frontend/package.json` | Create | React/Vite/AntD frontend package and scripts. |
| `frontend/vite.config.ts` | Create | Build React frontend and proxy `/api` to `127.0.0.1:8787` in development. |
| `frontend/tsconfig.json` | Create | TypeScript config for React app. |
| `frontend/index.html` | Create | Root HTML entry for Vite. |
| `frontend/src/main.tsx` | Create | React entrypoint and global stylesheet import. |
| `frontend/src/App.tsx` | Create | Router, lazy pages, Ant Design `ConfigProvider`, default redirect to `/matches`. |
| `frontend/src/components/AppLayout.tsx` | Create | Blackcat-style sidebar, mobile drawer, brand, menu items, and workspace shell. |
| `frontend/src/services/api.ts` | Create | Typed Axios client for existing odds APIs and new `/api/app/*` APIs. |
| `frontend/src/types.ts` | Create | Shared frontend DTO types. |
| `frontend/src/pages/MatchSelection.tsx` | Create | 比赛选择 page. |
| `frontend/src/pages/MonitorSettings.tsx` | Create | 赔率监控设置 page. |
| `frontend/src/pages/BettingRules.tsx` | Create | 下注规则设置 page. |
| `frontend/src/pages/BettingAccounts.tsx` | Create | 投注账号配置 page. |
| `frontend/src/styles/index.css` | Create | App-specific layout and dense operational page styling based on Blackcat patterns. |
| `Dockerfile` | Modify | Multi-stage build: build frontend, install backend runtime deps, copy `frontend/dist`, set DB/static env vars. |
| `docker-compose.yml` | Modify | Mount `crown-storage:/app/storage`, pass env vars, expose `8787`. |
| `.dockerignore` | Modify | Exclude local SQLite, frontend build cache, node_modules, runtime private data. |
| `.env.example` | Create | Document local port, DB path, and static file path. |
| `README.md` | Modify | Document GitHub clone, Docker run, first-run setup, account safety, and no-execution boundary. |
| `docs/modules/crown-dashboard.md` | Modify | Update module documentation for React UI, SQLite, Docker, and APIs. |
| `docs/module-index.md` | Modify | Update module summary and verification commands. |
| `docs/project-memory.md` | Modify after verification | Record only stable decisions and verified run commands. |
| `tests/crown-app-db.test.mjs` | Create | SQLite schema and persistence tests. |
| `tests/crown-app-secret.test.mjs` | Create | Encryption, redaction, and missing-key behavior tests. |
| `tests/crown-app-repository.test.mjs` | Create | CRUD and bootstrap repository tests. |
| `tests/crown-app-api.test.mjs` | Create | `/api/app/*` endpoint tests. |
| `tests/crown-dashboard-spa.test.mjs` | Create | Static server serves React app and falls back to `index.html` for routes. |
| `tests/crown-dashboard-docker.test.mjs` | Modify | Verify frontend build copy, SQLite volume, env vars, and static dir. |
| `frontend/src/App.contract.test.tsx` | Create | Frontend contract test for four required nav pages. |

## API Contract

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/app/bootstrap` | `GET` | Return app status, tracked matches, monitor accounts, monitor rules, betting rules, betting accounts, betting history, and odds summary. |
| `/api/app/tracked-matches` | `POST` | Track or untrack a match by stable event key. |
| `/api/app/monitor-accounts` | `GET/POST` | List and add Crown monitor login account records. |
| `/api/app/monitor-accounts/:id` | `PUT/DELETE` | Update or remove monitor account records. |
| `/api/app/monitor-rules` | `GET/POST` | List and add odds-monitoring rules. |
| `/api/app/monitor-rules/:id` | `PUT/DELETE` | Update or remove odds-monitoring rules. |
| `/api/app/betting-rules` | `GET/POST` | List and add preview-only betting rules. |
| `/api/app/betting-rules/:id` | `PUT/DELETE` | Update or remove betting rules. |
| `/api/app/betting-accounts` | `GET/POST` | List and add betting account records. |
| `/api/app/betting-accounts/:id` | `PUT/DELETE` | Update or remove betting account records. |
| `/api/app/betting-history` | `GET` | Return history rows; first version is empty/manual/system-generated preview history only. |

All write endpoints return `{ item }` or `{ ok: true }`. Validation failures return `400` with `{ error, fields }`. Secrets are accepted only in request bodies and are never returned.

## SQLite Schema

Use `node:sqlite` and store the database at `CROWN_DB_PATH`, defaulting to `storage/crown.sqlite`.

```sql
CREATE TABLE IF NOT EXISTS tracked_matches (
  event_key TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  mode TEXT NOT NULL,
  source_status TEXT NOT NULL DEFAULT '',
  tracking_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  login_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disabled',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  secret_updated_at TEXT NOT NULL DEFAULT '',
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
  market_filter TEXT NOT NULL DEFAULT '',
  min_odds_change REAL NOT NULL DEFAULT 0.03,
  poll_seconds INTEGER NOT NULL DEFAULT 5,
  alert_enabled INTEGER NOT NULL DEFAULT 0,
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
  preview_only INTEGER NOT NULL DEFAULT 1,
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
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  secret_updated_at TEXT NOT NULL DEFAULT '',
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
- Create: `src/crown/app/app-db.mjs`
- Create: `tests/crown-app-db.test.mjs`

- [ ] Add Node engine `>=22.5` because the app uses built-in `node:sqlite`.
- [ ] Add `openAppDatabase({ dbPath })`, schema creation, WAL mode, foreign key mode, and `defaultDbPath()`.
- [ ] Test that all six tables are created.
- [ ] Test that a row persists after closing and reopening the database.
- [ ] Run `node --test tests\crown-app-db.test.mjs`.
- [ ] Run `npm run check`.

## Task 2: Local Secret Encryption

**Files:**

- Create: `src/crown/app/app-secret.mjs`
- Create: `tests/crown-app-secret.test.mjs`
- Modify: `.env.example`

- [ ] Implement `encryptSecret(value)` and `decryptSecret(ciphertext)` using AES-256-GCM with an auto-generated local key.
- [ ] Implement `canStoreSecrets()` without requiring user-managed key configuration.
- [ ] Test that encrypted output does not contain the plaintext.
- [ ] Test that decrypt returns the original value with the same key.
- [ ] Test that API/repository redaction returns `hasSecret` and never returns the secret.
- [ ] Add `.env.example` keys:

```dotenv
CROWN_DASHBOARD_PORT=8787
CROWN_DB_PATH=/app/storage/crown.sqlite
CROWN_STATIC_DIR=/app/frontend/dist
```

- [ ] Run `node --test tests\crown-app-secret.test.mjs`.

## Task 3: Repository, Validation, And App API

**Files:**

- Create: `src/crown/app/app-validation.mjs`
- Create: `src/crown/app/app-repository.mjs`
- Create: `src/crown/app/app-api.mjs`
- Create: `tests/crown-app-repository.test.mjs`
- Create: `tests/crown-app-api.test.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `scripts/crown-dashboard.mjs`

- [ ] Implement payload validators for tracked matches, monitor accounts, monitor rules, betting rules, and betting accounts.
- [ ] Implement repository methods: `bootstrap`, `trackMatch`, `untrackMatch`, `create/update/delete/listMonitorAccount`, `create/update/delete/listMonitorRule`, `create/update/delete/listBettingRule`, `create/update/delete/listBettingAccount`, `listBettingHistory`.
- [ ] Ensure monitor and betting account list responses include `hasSecret` and omit `secret_ciphertext`.
- [ ] Implement `/api/app/*` routes listed in the API contract.
- [ ] Wire `/api/app/*` before existing `/api/summary`, `/api/events`, `/api/changes`, and `/api/config`.
- [ ] Pass `CROWN_DB_PATH` from `scripts/crown-dashboard.mjs`.
- [ ] Run `node --test tests\crown-app-repository.test.mjs`.
- [ ] Run `node --test tests\crown-app-api.test.mjs`.
- [ ] Run `npm test`.

## Task 4: React Frontend Scaffold And Blackcat-Style App Shell

**Files:**

- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/components/AppLayout.tsx`
- Create: `frontend/src/services/api.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/styles/index.css`
- Create: `frontend/src/App.contract.test.tsx`
- Modify: `package.json`

- [ ] Create a Vite React app with dependencies: `@vitejs/plugin-react`, `vite`, `typescript`, `react`, `react-dom`, `antd`, `@ant-design/icons`, `axios`, `react-router-dom`, `react-responsive`, `vitest`, `jsdom`, `@testing-library/react`.
- [ ] Implement `AppLayout` with a fixed dark left sidebar on desktop, mobile drawer below 768px, brand text `皇冠抓水投注`, version tag `local`, and menu items in this order:
  - `比赛选择` -> `/matches`
  - `赔率监控设置` -> `/monitor-settings`
  - `下注规则设置` -> `/betting-rules`
  - `投注账号配置` -> `/betting-accounts`
- [ ] Implement router redirects `/` and unknown routes to `/matches`.
- [ ] Implement `api.ts` with relative `/api` base URL and service methods for old odds APIs plus new app APIs.
- [ ] Implement global CSS with Blackcat-like operational styling: dark sidebar, `#f0f2f5` workspace, white panels, 8px radius max, dense table/forms, no landing page.
- [ ] Add root scripts:

```json
"crown:frontend:build": "npm --prefix frontend run build",
"crown:frontend:test": "npm --prefix frontend run test"
```

- [ ] Test that all four nav labels render.
- [ ] Run `npm --prefix frontend install`.
- [ ] Run `npm --prefix frontend run test`.
- [ ] Run `npm --prefix frontend run build`.

## Task 5: 比赛选择 Page

**Files:**

- Create: `frontend/src/pages/MatchSelection.tsx`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/types.ts`
- Extend: `frontend/src/App.contract.test.tsx`
- Extend: `tests/crown-app-api.test.mjs`

- [ ] Load current `summary`, `events`, `changes`, and app `bootstrap`.
- [ ] Show top summary cards: snapshots, changes, events, leagues, last captured.
- [ ] Show filters: league, mode, search.
- [ ] Show event table with columns: league, matchup, mode, status, odds count, updated, tracking action.
- [ ] Use `Drawer` for event detail and odds markets.
- [ ] Add `追踪/已追踪` action that calls `/api/app/tracked-matches`.
- [ ] Persist tracking state after refresh.
- [ ] Run `npm --prefix frontend run test`.
- [ ] Browser check `/matches` at desktop and narrow viewport.

## Task 6: 赔率监控设置 Page

**Files:**

- Create: `frontend/src/pages/MonitorSettings.tsx`
- Modify: `frontend/src/services/api.ts`
- Extend: `frontend/src/types.ts`
- Extend: `tests/crown-app-api.test.mjs`

- [ ] Build monitor account panel with table columns: label, username, login URL, status, has secret, updated, actions.
- [ ] Build add/edit monitor account modal with fields: label, username, login URL, password/secret, status, notes.
- [ ] Show backend save errors with AntD `message.error`.
- [ ] Build monitor rule panel with table columns: name, enabled, league filter, mode filter, market filter, min odds change, poll seconds, alert enabled, actions.
- [ ] Build add/edit monitor rule modal with `Form`, `Select`, `InputNumber`, and `Switch`.
- [ ] Use `Tag` colors for enabled, disabled, needs-login, and missing-secret.
- [ ] Run API tests for create/update/delete account and rule.
- [ ] Browser check that records persist after refresh.

## Task 7: 下注规则设置 Page

**Files:**

- Create: `frontend/src/pages/BettingRules.tsx`
- Modify: `frontend/src/services/api.ts`
- Extend: `frontend/src/types.ts`
- Extend: `tests/crown-app-api.test.mjs`

- [ ] Build betting rule table with columns: name, enabled, market type, min odds, max odds, max single amount, max event amount, stop loss, preview-only, updated, actions.
- [ ] Build add/edit modal with fields: name, enabled, market type, min odds, max odds, max single amount, max event amount, stop loss, notes.
- [ ] Default new rules to disabled and preview-only.
- [ ] Show an `Alert` that current phase only saves and previews rules; it does not submit real bets.
- [ ] Ensure API persists rule records and keeps `preview_only = 1`.
- [ ] Run frontend tests and API tests.
- [ ] Run safety scan in Task 10.

## Task 8: 投注账号配置 Page

**Files:**

- Create: `frontend/src/pages/BettingAccounts.tsx`
- Modify: `frontend/src/services/api.ts`
- Extend: `frontend/src/types.ts`
- Extend: `tests/crown-app-api.test.mjs`

- [ ] Build betting account table with columns: label, username, purpose, status, daily limit, has secret, updated, actions.
- [ ] Build add/edit modal with fields: label, username, purpose, password/secret, status, daily limit, notes.
- [ ] Build history table with columns: time, account, match, rule, status, amount, odds.
- [ ] Show empty state text: `暂无投注历史。当前阶段只保存配置，不会自动提交真实投注。`
- [ ] Persist account records and show `hasSecret` without exposing secret values.
- [ ] Browser check that records and empty history state render correctly after refresh.

## Task 9: Docker And GitHub Install Flow

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Create: `.env.example`
- Modify: `tests/crown-dashboard-docker.test.mjs`
- Create: `tests/crown-dashboard-spa.test.mjs`
- Modify: `README.md`

- [ ] Change Dockerfile to a multi-stage build:
  - `frontend-build` stage installs `frontend` deps and runs `npm run build`.
  - runtime stage installs root production deps, copies backend files, copies `frontend/dist` to `/app/frontend/dist`, creates `/app/storage`, and sets `CROWN_STATIC_DIR=/app/frontend/dist`.
- [ ] Keep base image default `m.daocloud.io/docker.io/library/node:22-alpine`.
- [ ] Add Docker volume `crown-storage:/app/storage`.
- [ ] Keep JSONL/runtime data read-only where possible, but keep SQLite volume writable.
- [ ] Make static server return React `index.html` for `/matches`, `/monitor-settings`, `/betting-rules`, and `/betting-accounts`.
- [ ] Document install:

```powershell
git clone <repo-url>
cd <repo>
copy .env.example .env
docker compose -p crown-dashboard up --build
```

- [ ] Run `node --test tests\crown-dashboard-docker.test.mjs`.
- [ ] Run `node --test tests\crown-dashboard-spa.test.mjs`.
- [ ] Run Docker API checks:

```powershell
docker compose -p crown-dashboard up --build -d
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/app/bootstrap
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/events
```

## Task 10: Documentation, Project Memory, And Final Verification

**Files:**

- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/module-index.md`
- Modify: `docs/project-memory.md`

- [ ] Update dashboard module docs with React UI, SQLite, encrypted local secrets, Docker run, and safety boundary.
- [ ] Update module index to show the Crown Dashboard is now a Docker-first local configuration app.
- [ ] Update project memory only after verification with stable facts: SQLite path, Docker volume, React/AntD UI, four page names, and no real betting execution.
- [ ] Run full automated verification:

```powershell
npm test
npm run check
npm --prefix frontend run test
npm --prefix frontend run build
```

- [ ] Run Docker verification:

```powershell
docker compose -p crown-dashboard up --build -d
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/app/bootstrap
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/events
```

- [ ] Run browser verification:
  - Open `http://127.0.0.1:8787`.
  - Confirm left nav has the four required pages.
  - Confirm each page switches without reload errors.
  - Confirm match tracking persists after refresh.
  - Confirm monitor account and rule persist after refresh.
  - Confirm betting rule persists and is preview-only.
  - Confirm betting account persists and secret is not displayed.
  - Confirm desktop and narrow viewport have no text overlap.

- [ ] Run safety scan:

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs,frontend\src\**\*.ts,frontend\src\**\*.tsx -Pattern 'placeBet|submitBet|betSlip|betslip|openTicket|confirmOrder|submitOrder|stakeAutomation' -SimpleMatch
```

Expected result: no real betting execution functions are introduced. Text that only states "not submitted" or "preview-only" is allowed after manual review.

## Acceptance Criteria

| Item | Required result |
|---|---|
| Docker install | `docker compose -p crown-dashboard up --build` starts one local container. |
| SQLite | App creates and persists `crown.sqlite` in Docker `crown-storage` volume. |
| React UI | App uses `frontend/` React + Ant Design, not the old vanilla dashboard UI. |
| Blackcat-style shell | Left sidebar and right workspace visually follow Blackcat's management UI pattern. |
| 比赛选择 | Current Crown odds events render, filter, show details, and track/untrack state persists. |
| 赔率监控设置 | Monitor accounts and monitor rules can be created, edited, deleted, and persisted. |
| 下注规则设置 | Betting rules can be created, edited, deleted, persisted, and remain preview-only by default. |
| 投注账号配置 | Betting accounts can be created, edited, deleted, persisted, and history scaffold renders. |
| Secrets | Secrets are local-only, encrypted when stored, and never returned by APIs or rendered after save. |
| No hardcoding | No runtime account, password, match, league, or rule is hardcoded. |
| Safety | No real betting execution code is introduced. |
| Verification | Backend tests, frontend tests, build, Docker API checks, browser checks, and safety scan pass. |

## Execution Notes

- Implement backend storage/API before frontend pages so UI work has stable contracts.
- Keep the first UI version close to Blackcat's proven structure: Ant Design `Layout`, `Menu`, `Card`, `Table`, `Form`, `Modal`, `Drawer`, `Tag`, `Alert`, and `Empty`.
- Do not copy Blackcat business modules, websocket code, Polymarket services, or order execution flows.
- Do not add real Crown login automation in this plan; account records are configuration only.
- Do not add real betting execution in this plan; betting rules are saved for preview and future design only.
- If browser-controlled login or true order submission becomes required, write a separate design and threat model before implementation.
