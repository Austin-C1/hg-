# Remove Betting Origin Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use each saved betting account's validated public HTTPS exact origin without a separate static allowlist.

**Architecture:** Delete only the allowlist parser/membership branch from `CrownApiLoginManager`; keep the existing origin validator and redirect policy. Remove obsolete API wiring and update the focused contract tests and current docs.

**Tech Stack:** Node.js ESM, `node:test`.

## Global Constraints

- No new setting, dependency, migration, UI, account-origin change, or order-route change.
- Keep public HTTPS exact-origin validation and manual redirect rejection unchanged.
- Do not commit automatically; the current worktree contains user-owned changes.

---

### Task 1: Delete the static betting-origin allowlist gate

**Files:**
- Modify: `src/crown/login/crown-api-login-manager.mjs`
- Modify: `src/crown/app/app-api.mjs`
- Modify: `tests/crown-api-login-manager.test.mjs`
- Modify: `tests/crown-app-api.test.mjs` only if its existing contract requires an assertion update
- Modify: `docs/project-memory.md`
- Modify: `docs/modules/crown-betting-protocol.md`

**Interfaces:**
- Consumes: `normalizePublicHttpsExactOrigin(account.loginUrl || account.websiteUrl)`.
- Produces: `bettingAccount(account)` with no environment allowlist input.

- [ ] **Step 1: Write the failing test**

Change the old empty-allowlist rejection test to assert that both an empty value and an unrelated legacy value accept the account's saved valid public HTTPS exact origin. Use fake Crown responses and assert the expected login/list sequence; keep unsafe URL assertions network-free.

- [ ] **Step 2: Run RED**

Run: `node --test --test-concurrency=1 --test-name-pattern="origin allowlist|public HTTPS exact" tests/crown-api-login-manager.test.mjs`

Expected: the saved-origin case fails with `betting-origin-not-allowed` before the implementation.

- [ ] **Step 3: Implement the minimum deletion**

Delete `bettingOriginAllowlist`, remove `allowedOriginValue` and `allowConfiguredOrigin` from `bettingAccount`, and remove the membership rejection. Remove the manager constructor property/default and the two obsolete `app-api` option assignments. Do not change `parseBettingOrigin`, `normalizePublicHttpsExactOrigin`, request bodies, redirect mode, Preview, Submit, or Reconciliation.

- [ ] **Step 4: Run GREEN**

Run: `node --test --test-concurrency=1 tests/crown-api-login-manager.test.mjs tests/crown-app-api.test.mjs tests/crown-account-execution-provider.test.mjs tests/crown-browser-account-runtime.test.mjs`

Expected: all focused tests pass with no network beyond fake test doubles.

- [ ] **Step 5: Update current docs and self-review**

Record that the saved public HTTPS exact origin is authoritative and no static membership list is required. Run `git diff --check`. Do not commit.
