# Dashboard Passwordless Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every downloaded copy immediately writable without a Dashboard password while keeping access loopback-only, same-origin, and CSRF-protected.

**Architecture:** `static-server.mjs` creates one process-local CSRF context only when password security and remote allowlists are absent and the request is truly loopback. The existing password session mode remains authoritative when configured. Manual account health checks may trust only their saved validated public HTTPS exact origin; execution methods keep the environment allowlist requirement.

**Tech Stack:** Node.js ESM, native `http`, React 18, TypeScript, Axios, Vitest, Node test runner, Playwright CLI.

## Global Constraints

- Default server binding remains exactly `127.0.0.1:8787`.
- Do not open Windows Firewall, LAN access, or public access.
- Every mutation still requires same-origin `Origin` and a process-random CSRF token.
- Password mode takes precedence whenever Dashboard password security is configured.
- Real preview/submit capability and betting worker remain unchanged and off.
- Do not commit Git; the project explicitly requires manual commit approval.

---

### Task 1: Loopback passwordless security context

**Files:**
- Modify: `tests/crown-dashboard-security.test.mjs`
- Modify: `src/crown/dashboard/static-server.mjs`
- Modify: `src/crown/app/app-api.mjs`

**Interfaces:**
- Produces: bootstrap fields `csrfToken?: string` and `dashboardAccessMode: 'local-trust' | 'password-session' | 'readonly'`.
- Preserves: existing `POST /api/app/session`, signed cookies, password rate limit, Host and Origin checks.

- [ ] **Step 1: Write failing security tests**

Add tests proving an environment without password/session secrets returns `dashboardAccessMode='local-trust'`, returns a random CSRF token, accepts a same-origin mutation with that token, rejects a missing/wrong token, and rejects a forged remote peer. Keep the existing configured-password test expecting an anonymous bootstrap until login.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `node --test tests/crown-dashboard-security.test.mjs`

Expected: the new local-trust bootstrap assertion fails because no CSRF token/access mode exists and mutation returns `authentication-required`.

- [ ] **Step 3: Implement minimal local-trust context**

Add one process-random CSRF value inside `createDashboardSecurity()`. Expose a method equivalent to:

```js
function localTrustFor(req, { remoteConfigurationPresent }) {
  if (passwordHash || signingKey || remoteConfigurationPresent) return null
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null
  if (!isLoopback(parsedHost(req.headers.host)?.hostname)) return null
  return { csrfToken: localCsrfToken, accessMode: 'local-trust' }
}
```

Use the password session first, then local trust. Mutation validation remains `Origin` required followed by exact CSRF comparison. Pass `dashboardAccessMode` through `serveApi()` and project it only on `/api/app/bootstrap`.

- [ ] **Step 4: Run focused security tests and observe GREEN**

Run: `node --test tests/crown-dashboard-security.test.mjs tests/crown-app-api.test.mjs`

Expected: exit 0; configured password tests and remote-forgery tests remain green.

---

### Task 2: Passwordless frontend state

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.contract.test.tsx`

**Interfaces:**
- Consumes: `BootstrapPayload.dashboardAccessMode` from Task 1.
- Produces: top status `Dashboard 本机免密`; no login button in local-trust mode.

- [ ] **Step 1: Write failing UI test**

Mock bootstrap as `{ csrfToken: 'local-csrf', dashboardAccessMode: 'local-trust' }`, render `App`, and assert `Dashboard 本机免密` exists while the `Dashboard 登录` button does not.

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm --prefix frontend run test -- --run src/App.contract.test.tsx`

Expected: FAIL because the UI currently renders `Dashboard 已登录`.

- [ ] **Step 3: Implement minimal UI state**

Extend `BootstrapPayload`:

```ts
dashboardAccessMode?: 'local-trust' | 'password-session' | 'readonly'
```

Store this mode during `refresh()`. Render `Dashboard 本机免密` when the mode is `local-trust`; preserve all password-session login behavior.

- [ ] **Step 4: Run focused frontend tests and observe GREEN**

Run: `npm --prefix frontend run test -- --run src/App.contract.test.tsx`

Expected: exit 0 and all App contract tests pass.

---

### Task 3: Direct-use manual account health origin

**Files:**
- Modify: `tests/crown-api-login-manager.test.mjs`
- Modify: `tests/crown-app-api.test.mjs`
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/app/app-api.mjs`

**Interfaces:**
- Produces: `testBettingAccountAccess({ account, logger, allowConfiguredOrigin: true })`.
- Preserves: `ensureBettingSession()` and every preview/submit method still require `CROWN_BETTING_ALLOWED_ORIGINS`.

- [ ] **Step 1: Write failing isolation tests**

Add a manual-access test with an empty environment allowlist and a saved exact public HTTPS account URL; expect login → `get_game_list` → `get_member_data` success. Add a companion assertion that `ensureBettingSession()` for the same account still fails `betting-origin-not-allowed` before network work.

- [ ] **Step 2: Run tests and observe RED**

Run: `node --test tests/crown-api-login-manager.test.mjs tests/crown-app-api.test.mjs`

Expected: the manual access test returns `configuration-failed` while the execution isolation assertion already remains closed.

- [ ] **Step 3: Implement the narrow manual-only fallback**

Allow `bettingAccount()` to accept an explicit `allowConfiguredOrigin` option. When true and the environment allowlist is empty, use only the already validated `account.websiteUrl` exact origin for this call. Call it only from `testBettingAccountAccess`; do not change `ensureBettingSession`, game-more, preview, submit, capability, or worker code.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run: `node --test tests/crown-api-login-manager.test.mjs tests/crown-app-api.test.mjs tests/crown-account-execution-provider.test.mjs`

Expected: exit 0; manual check works and execution provider remains fail-closed.

---

### Task 4: Documentation, complete verification, and live acceptance

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-dashboard.md`
- Modify: `docs/modules/crown-betting-protocol.md`

**Interfaces:**
- Consumes: Tasks 1–3 complete behavior.
- Produces: current operating and security contract for future development.

- [ ] **Step 1: Update project documentation**

Record passwordless loopback default, password-mode precedence, manual-check origin scope, display/execution balance separation, and that real betting remains closed.

- [ ] **Step 2: Run all automated verification**

Run:

```powershell
npm test
npm run check
npm --prefix frontend run test -- --run
npm --prefix frontend run build
```

Expected: every command exits 0 with zero failed tests.

- [ ] **Step 3: Restart Dashboard only**

Stop the existing `scripts/crown-dashboard.mjs` process and run `npm run crown:dashboard`. Do not stop `scripts/crown-watch.mjs` and do not start `crown-betting-worker`.

- [ ] **Step 4: Browser acceptance**

Using Playwright against `http://127.0.0.1:8787`, verify:

1. top status is `Dashboard 本机免密` with no login button;
2. edit and save an existing betting rule without authentication error and confirm refresh persistence;
3. toggle prematch monitor off and on, confirming each server state, leaving it in its original state;
4. click one betting account health check and confirm access status plus Crown reported balance/credit appear;
5. verify watcher remains live and no betting worker process exists.

- [ ] **Step 5: Final safety inspection**

Check captured requests and process list: account health uses only login, `get_game_list`, and `get_member_data`; no `FT_order_view`, `FT_bet`, preview/submit capability, or betting worker appears.
