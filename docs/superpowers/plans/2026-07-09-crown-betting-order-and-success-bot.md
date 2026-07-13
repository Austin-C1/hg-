# Crown Betting Order And Success Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual betting account order, execute real betting accounts in that order, and configure the bet-success Telegram bot.

**Architecture:** Store manual order on `betting_accounts` as `bet_order`, expose it as `betOrder`, and add a separate sequential execution CLI so watcher remains read-only. Telegram success bot configuration stays in local JSON and is masked in API responses.

**Tech Stack:** Node.js ESM, SQLite `node:sqlite`, React + Ant Design, Telegram Bot API configuration.

---

### Task 1: Betting Account Order Persistence

**Files:**
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/app-validation.mjs`
- Modify: `src/crown/app/app-repository.mjs`
- Test: `tests/crown-app-db.test.mjs`
- Test: `tests/crown-app-repository.test.mjs`

- [ ] Write failing tests proving `bet_order` exists, `betOrder` is saved, and enabled execution accounts are sorted by `betOrder`.
- [ ] Run `node --test tests\crown-app-db.test.mjs tests\crown-app-repository.test.mjs` and confirm the new tests fail.
- [ ] Add `bet_order` schema, migration, normalization, mapping, create/update persistence, and execution-account repository method.
- [ ] Re-run the same tests and confirm they pass.

### Task 2: Sequential Betting Execution CLI

**Files:**
- Create: `scripts/crown-bet-execute-sequence.mjs`
- Modify: `package.json`
- Test: `tests/crown-bet-execute-sequence.test.mjs`

- [ ] Write failing tests proving accounts run in `betOrder` order and execution stops after the first non-success result.
- [ ] Run `node --test tests\crown-bet-execute-sequence.test.mjs` and confirm failure because the CLI does not exist.
- [ ] Implement `parseArgs`, safety gates, account loading, per-account Crown API session verification, adapter execution, and stop rules.
- [ ] Re-run the sequence tests and confirm they pass.

### Task 3: Betting Accounts UI

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/pages/BettingAccounts.tsx`
- Test: `frontend/src/pages/BettingAccounts.test.tsx`

- [ ] Write failing UI tests for showing account order and saving a changed order.
- [ ] Run `npm --prefix frontend run test -- BettingAccounts` and confirm failure.
- [ ] Add `betOrder` type, card display, sorted account list, and numeric form field.
- [ ] Re-run the focused frontend test.

### Task 4: Bet Success Bot Configuration

**Files:**
- Modify: `config/telegram-settings.json`
- Test: `tests/crown-telegram-settings.test.mjs`

- [ ] Add a test proving bet-success token masking works and Chat ID normalization remains intact.
- [ ] Update local `betSuccess` config with the provided token, enable it, and reuse the current receiver Chat ID.
- [ ] Run `node --test tests\crown-telegram-settings.test.mjs`.

### Task 5: Verification And Documentation

**Files:**
- Modify: `docs/project-memory.md`
- Modify: `docs/module-index.md`
- Modify: `docs/modules/crown-betting-protocol.md`
- Modify: `docs/modules/crown-dashboard.md`

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npm --prefix frontend run test`.
- [ ] Run `npm --prefix frontend run build`.
- [ ] Update project docs with stable facts only.
