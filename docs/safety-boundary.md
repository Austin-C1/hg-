# Safety Boundary

This project supports a controlled Crown betting protocol lab.

## Modes

| Mode | Purpose | Real betting risk |
|---|---|---|
| `monitor` | Read odds, write snapshots, send alerts | none |
| `protocol-capture` | Reuse local login/session, click/open slip, capture order protocol | possible only when the user manually opens or confirms betting UI |
| `execution` | Submit real Crown betting orders through a verified adapter | real funds at risk |

## Allowed

- Read local capture files, fixtures, JSONL runtime files, and SQLite configuration.
- Open a logged-in Crown page with Playwright for monitoring, diagnostics, or protocol capture.
- Reuse locally stored Crown session, cookies, uid, authorization headers, and encrypted account secrets inside local tools.
- Listen to page requests, responses, WebSocket frames, DOM, browser storage, and form/navigation events.
- Parse football odds data and betting protocol fields.
- Save raw authenticated requests under `data/runtime/**/private/`.
- Generate redacted public summaries under `data/runtime/**/public/`.
- Store betting rules and betting accounts as local configuration with encrypted secrets.
- Click odds, open bet slips, fill stake amounts, and submit orders only in `protocol-capture` or `execution` mode with explicit command flags.
- Replay authenticated Crown requests only from dedicated betting protocol or adapter scripts.

## Forbidden

- Bypass CAPTCHA, slider checks, device checks, signatures, rate limits, or account protection.
- Print cookies, tokens, authorization headers, set-cookie values, passwords, or raw private capture bodies in reports.
- Commit private runtime capture directories, browser profiles, encrypted secrets, SQLite databases, Telegram tokens, session files, or diagnostic files.
- Add betting logic inside the read-only monitor path or `scripts/crown-watch.mjs`.
- Run real betting execution from monitor alerts before the betting adapter has passed protocol verification.
- Submit a real order without an explicit execution mode, stake cap, confirmation phrase, and audit log.

## Runtime Storage

Raw protocol material may contain secrets and must stay under ignored local runtime paths:

- `data/runtime/betting-protocol-captures/**/private/`
- `data/runtime/crown-sessions/`
- `data/runtime/login-diagnostics/`
- `data/crown-profile/`

Public documentation may contain only endpoint patterns, field names, request shapes, response status meanings, and redacted examples.

## Output Boundary

Allowed runtime outputs are local files under ignored runtime/capture paths, especially:

- `data/runtime/crown-odds-snapshots.jsonl`
- `data/runtime/crown-odds-changes.jsonl`
- `data/runtime/crown-watch-runtime.jsonl`
- `data/runtime/betting-protocol-captures/`
- `data/betting-protocol-captures/`

Runtime monitor output should contain normalized sports data only. Protocol output may contain request/response structure and field names, but public output must not contain raw credentials, cookies, raw request headers, browser profile files, or local encryption keys.
