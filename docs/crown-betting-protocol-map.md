# Crown betting protocol capability map

Updated: 2026-07-15

Matrix version: `crown-protocol-capabilities-v2:c9139fcb53c51012`

## Evidence

| Safe evidence | Result | Runtime use |
|---|---|---|
| `20260714-1848-protocol-catalog.safe.json` | Eight directions observed | Endpoint and lifecycle audit |
| `20260714-1848-static-wire-evidence.safe.json` | Preview and Submit field contracts | Stable protocol digest and field sets |
| `20260714-1848-eight-direction-candidates.safe.json` | Eight successful Preview requests; eight Submit candidates blocked before dispatch | Preview enabled for all eight directions; acceptance candidate only |
| `20260714-085221-accepted.safe.json` plus watcher evidence | Direct accepted Submit bound to the away selection | Submit enabled only for prematch/full-time/asian-handicap/main/away |

Task 2 dispatched zero `FT_bet` requests. A blocked Submit candidate never enables Submit by itself. No exact status-query contract exists, so Reconciliation remains disabled for every row.

## Side-aware rows

All rows use Preview `/transform.php` + `FT_order_view` and Submit `/transform.php` + `FT_bet`. Reconciliation has no endpoint.

| Mode | Market | Side | Ratio field | Odds field | Preview `wtype/chose_team` | Submit `rtype/isRB/f` | Preview | Submit | Reconciliation |
|---|---|---|---|---|---|---|---:|---:|---:|
| prematch | asian_handicap | home | `RATIO_R` | `IOR_RH` | `R/H` | `RH/N/1R` | true | false | false |
| prematch | asian_handicap | away | `RATIO_R` | `IOR_RC` | `R/C` | `RC/N/1R` | true | true | false |
| prematch | total | over | `RATIO_OUO` | `IOR_OUC` | `OU/C` | `OUC/N/1R` | true | false | false |
| prematch | total | under | `RATIO_OUU` | `IOR_OUH` | `OU/H` | `OUH/N/1R` | true | false | false |
| live | asian_handicap | home | `RATIO_RE` | `IOR_REH` | `RE/H` | `REH/Y/1R` | true | false | false |
| live | asian_handicap | away | `RATIO_RE` | `IOR_REC` | `RE/C` | `REC/Y/1R` | true | false | false |
| live | total | over | `RATIO_ROUO` | `IOR_ROUC` | `ROU/C` | `ROUC/Y/1R` | true | false | false |
| live | total | under | `RATIO_ROUU` | `IOR_ROUH` | `ROU/H` | `ROUH/Y/1R` | true | false | false |

The opaque `f=1R` value is the captured full-time wire value; it is not interpreted as a period label.

## Field contracts

Preview request fields:

`chose_team`, `gid`, `gtype`, `langx`, `odd_f_type`, `p`, `ver`, `wtype`

Submit request fields:

`autoOdd`, `chose_team`, `con`, `f`, `gid`, `golds`, `gtype`, `imp`, `ioratio`, `isRB`, `isYesterday`, `langx`, `odd_f_type`, `p`, `ptype`, `ratio`, `rtype`, `timestamp`, `timestamp2`, `ver`, `wtype`

| Contract | Fingerprint |
|---|---|
| Preview request | `sha256:50a9c1ffe0efeeed144c2c8fb0d027e49856b73caebb89675250caf0994b661e` |
| Prematch Preview response | `sha256:efedaa6220496cc356c24dcd195c85aaf3090cfcd345ffe90da98671e337ebec` |
| Live Preview response | `sha256:efedaa6220496cc356c24dcd195c85aaf3090cfcd345ffe90da98671e337ebec` |
| Submit request | `sha256:f17f48df8bc9697c033f07450f9d363f4e0934755588854806b3303ae1ebd37a` |
| Direct-accepted Submit response | `sha256:046d372d24a12413fec6298bac72c7d036c7d28ddf0d9e84aad2f139952daf93` |

`username` is removed from the safe Preview response contract. Task 2 observed the same safe Preview response field set for all eight directions; `score` is not required without direction-specific response evidence.

## Runtime boundary

The capability library stores only endpoints, field names, proven static wire values, dynamic-value source names, and evidence digests. Current `gid`, odds, stake, balance, `con`, `ratio`, timestamp, `uid`, and `ver` are injected from the current list, Preview, account, clock, and verified session data.

The matrix version excludes capture-specific blocked-request candidate bindings. It binds stable protocol behavior and the direct-accepted Submit authority only. Each B2 attempt separately stores a runtime `executionCandidateDigest`; that digest is never reused as the protocol digest or matrix version.

`getCrownCapability()` uses the five-part key `{mode, period, marketType, lineVariant, selectionSide}` through a prebuilt read-only index. Runtime lookup does not read fixtures or access the network. Fixture verification is an explicit development audit.
