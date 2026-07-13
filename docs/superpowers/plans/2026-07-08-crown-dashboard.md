# Crown Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local read-only Web Dashboard that visualizes Crown football monitor snapshots, odds changes, monitored leagues, and event details from existing local files.

**Architecture:** Add a small Node.js HTTP server that serves static dashboard files and read-only JSON APIs. Keep file parsing, data aggregation, server routing, and frontend rendering separate so each part can be tested independently.

**Tech Stack:** Node.js ESM, Node built-in `http` server, Node built-in test runner, vanilla HTML/CSS/JS, existing JSONL monitor output.

---

## Scope Boundary

This plan does not implement betting execution, watcher process control, config editing, Telegram UI, SQLite, or Electron/Tauri packaging.

The dashboard reads these files only:

- `data/runtime/crown-odds-snapshots.jsonl`
- `data/runtime/crown-odds-changes.jsonl`
- `data/fixtures/crown/20260708_004011/replay-normalized.jsonl`
- `data/fixtures/crown/20260708_004011/replay-summary.json`
- `config/monitored-leagues.json`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/crown/dashboard/jsonl-reader.mjs` | Create | Read JSONL files safely and return records, metadata, and parse errors. |
| `src/crown/dashboard/dashboard-data.mjs` | Create | Build summary, event groups, recent changes, and config payloads. |
| `src/crown/dashboard/static-server.mjs` | Create | Serve static files and route API requests. |
| `scripts/crown-dashboard.mjs` | Create | CLI entry that starts the local server. |
| `public/dashboard/index.html` | Create | Dashboard page shell. |
| `public/dashboard/dashboard.css` | Create | Operational dashboard styling. |
| `public/dashboard/dashboard.js` | Create | Poll APIs, render UI, handle filters and selected event. |
| `tests/crown-dashboard-jsonl.test.mjs` | Create | JSONL reader unit tests. |
| `tests/crown-dashboard-data.test.mjs` | Create | Summary/event/change aggregation tests. |
| `tests/crown-dashboard-server.test.mjs` | Create | API route tests. |
| `package.json` | Modify | Add `crown:dashboard` script. |
| `README.md` | Modify | Add local dashboard run command and scope. |
| `docs/modules/crown-dashboard.md` | Create | Module documentation. |
| `docs/module-index.md` | Modify | Add dashboard module entry. |
| `docs/project-memory.md` | Modify | Record confirmed dashboard direction after implementation is complete. |

Because the current folder is not a Git repository, commit steps are not required. If the project is later initialized as Git, commit after each completed task.

## API Contract

| Endpoint | Response |
|---|---|
| `GET /api/health` | `{ ok, app, readonly, time }` |
| `GET /api/config` | `{ exists, path, updatedAt, config, error }` |
| `GET /api/summary` | `{ readonly, source, files, totals, lastCapturedAt }` |
| `GET /api/events` | `{ items, warnings }` |
| `GET /api/changes` | `{ items, warnings }` |

## Task 1: JSONL Reader

**Files:**

- Create: `tests/crown-dashboard-jsonl.test.mjs`
- Create: `src/crown/dashboard/jsonl-reader.mjs`

- [ ] **Step 1: Write failing tests**

Test behaviors:

- Missing file returns `exists: false`, empty records, zero line count.
- Blank lines are ignored.
- Valid JSON lines are parsed.
- Bad JSON lines increment `parseErrors` and do not stop parsing valid lines.

Expected test command:

```powershell
node --test tests\crown-dashboard-jsonl.test.mjs
```

Expected before implementation: fails because `src/crown/dashboard/jsonl-reader.mjs` does not exist.

- [ ] **Step 2: Implement reader**

Export:

```js
readJsonlFile(filePath)
```

Return shape:

```js
{
  path: "data/runtime/crown-odds-snapshots.jsonl",
  exists: true,
  lineCount: 175,
  parseErrors: 0,
  updatedAt: "2026-07-08T00:00:00.000Z",
  records: []
}
```

Implementation rules:

- Use `node:fs/promises`.
- Return relative path from project root when possible.
- Skip empty lines.
- Parse each line independently.
- Store parse error count, not raw bad content.
- Do not log sensitive data.

- [ ] **Step 3: Verify**

```powershell
node --test tests\crown-dashboard-jsonl.test.mjs
```

Expected: all JSONL reader tests pass.

## Task 2: Dashboard Data Aggregation

**Files:**

- Create: `tests/crown-dashboard-data.test.mjs`
- Create: `src/crown/dashboard/dashboard-data.mjs`

- [ ] **Step 1: Write failing tests**

Test behaviors:

- `buildSummary()` returns snapshot/change counts, event count, league count, and latest captured time.
- `buildEvents()` groups records by `provider|league|homeTeam|awayTeam|mode`.
- `buildEvents()` keeps only latest odds per stable market/selection key inside each event.
- `buildChanges()` returns newest changes first and limits to a sensible default such as `100`.
- `readDashboardConfig()` returns missing config as a structured unavailable state.

Expected command:

```powershell
node --test tests\crown-dashboard-data.test.mjs
```

Expected before implementation: fails because data aggregation exports do not exist.

- [ ] **Step 2: Implement aggregation exports**

Export these functions:

```js
buildSummary({ snapshots, changes })
buildEvents(snapshotRecords)
buildChanges(changeRecords, options)
readDashboardData(options)
readDashboardConfig(configPath)
```

Stable event key:

```text
provider|league|homeTeam|awayTeam|mode
```

Stable odds key:

```text
marketId|marketType|handicapRaw|selectionId|side
```

Implementation rules:

- Preserve raw odds values.
- Do not invent betting fields.
- Sort events by latest captured time descending.
- Sort changes by captured time descending.
- Include warnings for parse errors and missing files.
- Prefer runtime JSONL; fall back to fixture replay only when runtime snapshots are missing or empty.

- [ ] **Step 3: Verify**

```powershell
node --test tests\crown-dashboard-data.test.mjs
```

Expected: all aggregation tests pass.

## Task 3: Read-Only HTTP Server

**Files:**

- Create: `tests/crown-dashboard-server.test.mjs`
- Create: `src/crown/dashboard/static-server.mjs`
- Create: `scripts/crown-dashboard.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing server tests**

Test behaviors:

- `/api/health` returns HTTP 200 and `readonly: true`.
- `/api/summary` returns JSON.
- `/api/events` returns JSON with `items`.
- `/api/changes` returns JSON with `items`.
- `/api/config` returns JSON.
- Static `/` returns dashboard HTML.
- Unknown paths return HTTP 404.

Expected command:

```powershell
node --test tests\crown-dashboard-server.test.mjs
```

Expected before implementation: fails because server module does not exist.

- [ ] **Step 2: Implement server module**

Export:

```js
createDashboardServer(options)
startDashboardServer(options)
```

Implementation rules:

- Use Node built-in `http`, not Express.
- Bind default host `127.0.0.1`.
- Use default port `8787`.
- Serve files only from `public/dashboard`.
- Prevent path traversal by resolving paths and checking they remain inside the static directory.
- Set JSON content type for APIs.
- Set HTML/CSS/JS content types for static files.
- Do not expose raw local absolute paths in API responses unless needed for debugging; prefer project-relative paths.

- [ ] **Step 3: Add npm script**

Add to `package.json`:

```json
"crown:dashboard": "node scripts/crown-dashboard.mjs"
```

- [ ] **Step 4: Verify**

```powershell
node --test tests\crown-dashboard-server.test.mjs
npm run check
```

Expected: server tests pass and syntax check passes.

## Task 4: Static Dashboard UI

**Files:**

- Create: `public/dashboard/index.html`
- Create: `public/dashboard/dashboard.css`
- Create: `public/dashboard/dashboard.js`

- [ ] **Step 1: Build HTML shell**

Required visible areas:

- Header with "Crown Football Monitor" and "Read-only".
- Summary status row.
- League/mode/search filters.
- Event list.
- Selected event detail.
- Recent odds changes.
- Error/empty state container.

- [ ] **Step 2: Build CSS**

Design rules:

- Operational dashboard, not landing page.
- Dense tables and split panes.
- No gambling action buttons.
- No decorative hero, gradient background, or marketing copy.
- Text must fit on desktop and narrow viewport.
- Use stable layout dimensions for table rows, filter controls, and detail pane.

- [ ] **Step 3: Build frontend JS**

Required behavior:

- Fetch `/api/summary`, `/api/config`, `/api/events`, `/api/changes`.
- Poll every 5 seconds.
- Keep previous successful data visible when a refresh fails.
- Filter events by league, mode, and search text.
- Click an event row to show market/selection detail.
- Display changes newest first.
- Show missing/empty/malformed file states.

- [ ] **Step 4: Manual browser verification**

Run:

```powershell
npm run crown:dashboard
```

Open:

```text
http://127.0.0.1:8787
```

Expected:

- Page renders without console errors.
- Summary values are visible.
- Event rows render.
- Selecting an event updates detail panel.
- Filters change visible rows.
- Changes panel handles zero changes.

## Task 5: Documentation And Module Index

**Files:**

- Modify: `README.md`
- Create: `docs/modules/crown-dashboard.md`
- Modify: `docs/module-index.md`
- Modify after verification: `docs/project-memory.md`

- [ ] **Step 1: Update README**

Add:

```powershell
npm run crown:dashboard
```

Document:

- URL: `http://127.0.0.1:8787`
- Read-only local dashboard.
- Reads JSONL/config only.
- Does not start watcher.
- Does not include betting execution.

- [ ] **Step 2: Add module doc**

Document:

- Goal.
- Files.
- API endpoints.
- Data sources.
- Safety boundary.
- Verification commands.

- [ ] **Step 3: Update module index**

Add dashboard as an independently developable module that depends on monitor JSONL outputs but does not control the watcher.

- [ ] **Step 4: Update project memory after successful implementation**

Record only stable facts:

- Dashboard command.
- Dashboard URL.
- Read-only scope.
- Verification result.

## Task 6: Final Verification

**Files:**

- Read-only verification across project.

- [ ] **Step 1: Run tests**

```powershell
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run syntax check**

```powershell
npm run check
```

Expected: all project `.mjs` files pass syntax check.

- [ ] **Step 3: Verify dashboard API against existing files**

```powershell
npm run crown:dashboard
```

Open:

```text
http://127.0.0.1:8787/api/summary
http://127.0.0.1:8787/api/events
http://127.0.0.1:8787/api/changes
http://127.0.0.1:8787/api/config
```

Expected: all return JSON without leaking cookie/token/header values.

- [ ] **Step 4: Run betting boundary scan**

```powershell
Select-String -Path src\**\*.mjs,scripts\*.mjs,public\dashboard\*.js,public\dashboard\*.html -Pattern 'placeBet|submitBet|wager|stake|ticket|order|bet-slip|betslip' -SimpleMatch
```

Expected: no betting execution UI or code is introduced. Any match must be documentation-only or removed.

- [ ] **Step 5: Browser layout verification**

Check:

- Desktop viewport renders full working surface.
- Narrow viewport does not overlap text.
- Event table, detail panel, and changes panel remain readable.
- Auto-refresh does not reset selected event unless the event disappears.

## Acceptance Criteria

| Item | Required Result |
|---|---|
| Local server | `npm run crown:dashboard` opens `http://127.0.0.1:8787`. |
| API | Health, summary, events, changes, and config endpoints return JSON. |
| Data | Summary counts match local JSONL inputs. |
| UI | Event list, event detail, filters, and changes panel work. |
| Empty/error states | Missing, empty, and malformed data are visible and non-crashing. |
| Safety | No betting execution code or UI is added. |
| Verification | `npm test`, `npm run check`, API checks, and browser verification pass. |

## Execution Notes

- Implement with TDD: write failing tests before production modules.
- Keep the first version simple and local.
- Do not add frontend frameworks unless the vanilla UI becomes unmaintainable.
- Do not package Electron/Tauri until the dashboard contract has stabilized.
- Do not add watcher start/stop buttons in this phase.
