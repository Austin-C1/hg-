# Crown Hot List Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Crown's verified `hot` football list when the normal `today` list is valid but empty, while preserving the list scope for detail requests.

**Architecture:** `CrownApiClient.fetchGameList` accepts only the internally selected `showtype` and `filter`. `CrownApiLoginManager.fetchFootballToday` keeps `today/MIX` primary and performs one `hot/empty` fallback only for an exact valid-empty response. The watcher passes the winning list `showtype` into `buildGameMoreTargets`, and `fetchGameMore` sends it unchanged for prematch events.

**Tech Stack:** Node.js ESM, `node:test`, SQLite-backed monitor integration.

## Global Constraints

- No new dependency, configuration option, account-origin change, or order-route change.
- `FT_order_view`, `FT_bet`, reconciliation, and `unknown` behavior remain unchanged.
- Do not commit automatically; the current worktree contains user-owned changes.

---

### Task 1: Add the exact valid-empty `hot` fallback

**Files:**
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `scripts/crown-watch.mjs`
- Test: `tests/crown-api-login-manager.test.mjs`
- Test: `tests/crown-watch-fixture.test.mjs`

**Interfaces:**
- Consumes: `CrownApiClient.fetchGameList(session, options)` and `buildGameMoreTargets(snapshots, options)`.
- Produces: optional `showtype`/`filter` request options; prematch detail targets inherit `options.prematchShowtype`.

- [ ] **Step 1: Write failing client and manager tests**

Add tests proving the default request remains `today/MIX`, a valid empty response causes exactly one `hot/empty` request, a non-empty response does not fall back, and malformed/login responses do not fall back.

```js
assert.deepEqual(calls.map(({ body }) => [body.showtype, body.filter]), [
  ['today', 'MIX'],
  ['hot', ''],
])
assert.equal(result.requestScope.showtype, 'hot')
```

- [ ] **Step 2: Write failing detail-scope tests**

Add a `buildGameMoreTargets` assertion for a prematch snapshot with `prematchShowtype: 'hot'`, and a client assertion that `fetchFootballGameMore` sends `showtype=hot`, `isRB=N`.

```js
const [target] = buildGameMoreTargets([prematch], {
  maxTargets: 1,
  prematchShowtype: 'hot',
})
assert.equal(target.showtype, 'hot')
```

- [ ] **Step 3: Run RED tests**

Run:

```powershell
npm test -- --test-name-pattern="hot|game_more targets" tests/crown-api-login-manager.test.mjs tests/crown-watch-fixture.test.mjs
```

Expected: FAIL because request options and `prematchShowtype` are not implemented.

- [ ] **Step 4: Implement the minimum fallback**

Change `fetchGameList` to accept `{ signal, showtype = 'today', filter = 'MIX' }`; use those two values in the existing form. In `fetchFootballToday`, return the primary result unless all of these are exact: `hasServerResponse === true`, `loginExpired !== true`, `parseError !== true`, and `gameCount === 0`. For that one case, fetch `hot/empty`, save its rotated session, and return it.

Change prematch detail selection to use a passed `prematchShowtype` and pass `fetchResult.requestScope.showtype` from `runDirectApiPollOnce`:

```js
const targets = buildGameMoreTargets(list.result.snapshots, {
  trackedMatches,
  maxTargets: args.maxGameMore,
  prematchShowtype: fetchResult.requestScope?.showtype,
})
```

In `fetchGameMore`, use `target.showtype` for non-live requests, restricted to `hot` or the existing `today` default.

- [ ] **Step 5: Run GREEN focused tests**

Run:

```powershell
npm test -- tests/crown-api-login-manager.test.mjs tests/crown-watch-fixture.test.mjs tests/crown-monitor-v2-integration.test.mjs
```

Expected: all focused tests PASS with no residual processes.

- [ ] **Step 6: Run live read-only verification**

Restart only the watcher while real betting remains off. Verify Operations reports fresh odds and the database exposes all four featured prematch directions. Do not initialize or submit an acceptance case until this read-only gate passes.

- [ ] **Step 7: Update project memory**

Record the stable `today -> hot` fallback behavior, the verified request scope, and the focused/live verification result in `docs/project-memory.md` and the relevant Crown monitor module document. Do not commit.
