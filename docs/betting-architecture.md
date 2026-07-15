# Betting Architecture

## 2026-07-15 Current Capability

- Preview/Submit/Reconciliation is `8/4/0`: all eight full-time main directions support strict Preview; prematch full-time main handicap home/away and total over/under support Submit. Live Submit and production Reconciliation remain closed.
- Accepted promotions are audited from the public-safe 2026-07-15 artifact. The real runtime stays off by default, and all rule-card, account, fresh-Preview, lease/fence, durable-attempt, and at-most-once Submit gates still apply.

## Historical: 2026-07-11 B2 Safety Baseline

- B1/B2 Task 1–12 are complete in code and independent safety review.
- The production path is `ExecutionAuthorization -> deterministic batch/child -> durable submit attempt -> definite outcome or unknown -> reconciliation -> notification outbox`.
- Prepared, dispatched, and unknown attempts are never automatically resubmitted after recovery. A submission-time recovery is scoped to one child; explicit startup recovery is authorization-wide.
- Provider references use v2 context-bound encryption. Reconciliation evidence is append-only and notifications persist retry/lease state.
- At that historical stage, the canonical Crown capability matrix allowed neither preview nor submit. Production submit, automatic reconciliation, and manual Crown resolution therefore failed closed, and no real `FT_bet` acceptance had been run. The current capability is `8/4/0` as stated above.
- Historical adapter/CLI real entrypoints are disabled and are not a fallback execution route.

Betting execution is split into staged modules. The monitor remains read-only; betting code must live outside the monitor path.

## Modules

| Module | Responsibility | Current Status |
|---|---|---|
| `bet-intent` | Create a structured intent from a strategy or manual decision. | Contract |
| `risk-guard` | Validate limits, account exposure, market status, account status, and operator policy. | Required before execution |
| `crown-betting-protocol` | Capture and analyze Crown preview/submit protocol. | In progress |
| `bet-adapter` | Translate an approved intent into a Crown provider operation. | After protocol map |
| `order-confirmation` | Reconcile accepted, rejected, pending, odds-changed, or insufficient-balance order state. | After adapter |
| `audit-log` | Persist all decisions, confirmations, request summaries, responses, and outcomes. | Required |

## Required Separation

- `scripts/crown-watch.mjs` remains read-only and must not submit bets.
- Betting rules in Dashboard are local configuration; they do not execute by themselves.
- Protocol capture and execution scripts must be separate entrypoints.
- Protocol capture tooling writes raw authenticated material only to ignored local capture directories.
- Provider-specific execution must live outside the monitor and pass through `risk-guard`.
- Real order submission requires explicit CLI flags or UI action, configured stake limits, confirmation text, and audit logging.

## Current State

- Dashboard stores betting rules and betting accounts.
- `previewOnly` is a configurable rule field instead of being forcibly rewritten to `true`.
- `src/crown/betting-protocol/` contains capture redaction, local capture storage, and protocol request classification utilities.
- `scripts/crown-betting-protocol-capture.mjs` opens a controlled visible browser capture flow.
- `scripts/crown-betting-protocol-analyze.mjs` summarizes redacted capture output.
- `docs/crown-betting-protocol-map.md` is the protocol evidence map and must not contain secrets.
- `CrownBetAdapter`、单账号/顺序执行 CLI、dry-run preview 和 gated real submit 已存在；它们仍未接入 Dashboard，监控告警也不会自动调用执行器。
