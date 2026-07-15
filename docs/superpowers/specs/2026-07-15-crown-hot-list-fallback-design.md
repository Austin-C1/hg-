# Crown hot list fallback design

## Goal

When the normal football `today` list is a valid empty response, reuse the same authenticated Crown API session to read the `hot` list so featured prematch events remain available to the normal monitor and controlled acceptance flow.

## Scope

- Keep the existing `today` + `MIX` request as the primary list.
- Fall back once to `hot` + empty `filter` only when `today` is valid and has zero games.
- Preserve the selected list `showtype` when building `get_game_more` requests.
- Keep the existing canonical event identity, persistence, Preview, Submit, reconciliation, and safety gates unchanged.
- Do not add configuration, migrate account origins, or change any order route.

## Failure handling

- Login, HTTP, XML, or parse failures remain failures and do not trigger the fallback.
- A valid empty `hot` response follows the existing data-quality failure path.
- `unknown` Submit behavior remains terminal and is never retried.

## Verification

- Unit test the exact `today` request, the valid-empty fallback to `hot`, and no fallback on a non-empty `today` response.
- Unit test that a `hot` prematch snapshot produces a `get_game_more` target with `showtype=hot` and that the client sends it unchanged.
- Run the focused login-manager and monitor integration tests, then verify the live watcher reads the four featured prematch directions while real betting remains off.
