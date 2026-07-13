# Crown betting protocol capability map

Updated: 2026-07-11

Matrix version: `crown-protocol-capabilities-v2:23628f891d1edb9a`

## Evidence inventory

| Capture ID | Safe analyzer result | Capability use |
|---|---|---|
| `20260709-110033` | Preview plus one submit exchange and later status observations | Submit chain rejected: the sanitized status observations cannot be bound to the exact submitted identity |
| `20260709-111046` | Preview response, HTTP 200, stable request/response fingerprints | Verifies live/full-time/asian-handicap/main preview only |
| `20260709-112647` | Preview response, HTTP 200, stable request/response fingerprints | Verifies live/first-half/total/main preview only |

The analyzer publishes only endpoint kind, method, HTTP status, field-name sets, stable fingerprints and response codes. It omits origins, private locations and body values.

## Capability rows

| Evidence ID | Mode | Period | Market | Line | Request field fingerprint | Response field fingerprint | Preview | Submit | Reconciliation |
|---|---|---|---|---|---|---|---:|---:|---:|
| `crown-capture-20260709-111046-live-full-time-asian-handicap-main` | live | full_time | asian_handicap | main | `sha256:50a9c1ffe0efeeed144c2c8fb0d027e49856b73caebb89675250caf0994b661e` | `sha256:4682fa69edf56ee85cf7328948994e79163afce45277c413e805f01fb2c529ad` | false | false | false |
| `crown-capture-20260709-112647-live-first-half-total-main` | live | first_half | total | main | `sha256:50a9c1ffe0efeeed144c2c8fb0d027e49856b73caebb89675250caf0994b661e` | `sha256:4682fa69edf56ee85cf7328948994e79163afce45277c413e805f01fb2c529ad` | false | false | false |

The evidenced safe wire request field set is `chose_team`, `gid`, `gtype`, `langx`, `odd_f_type`, `p`, `ver`, `wtype`. The response fingerprint covers the complete safe response structure, not only the six parser values. Any missing, added or renamed field changes the fingerprint and blocks the row.

The dynamic `ver` value has no proven production source. Both rows therefore carry `blockedReason=crown-preview-field-source-unproven` and preview remains disabled. Submit separately remains blocked by `crown-submit-evidence-missing`.

Each fixture references an independent safe artifact by capture ID, request/response record evidence IDs and artifact digest. Matrix verification recomputes the artifact digest and record identities before accepting provenance.

## Live acceptance

The betting worker was stopped and no active execution lease existed. Two enabled execution accounts were present, but the exact betting-origin allowlist was not configured in the acceptance environment. Live login, game-list, member-data and order-preview calls were therefore blocked before network access. The gate was not bypassed or changed.

Network audit for this acceptance: zero preview calls and zero submit calls. No live balance, limit, step, line or odds fingerprint was adopted.

## Production gates

`assertCrownCapability(value, { operation })` is the canonical production decision point. A provider factory does not create capability. The execution provider has no injectable real transport and remains fail-closed. Production reconciliation is unavailable; fixture-only reconciliation cannot attest a Crown row.
