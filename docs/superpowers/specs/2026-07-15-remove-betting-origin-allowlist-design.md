# Remove Betting Origin Allowlist Design

The saved betting-account URL is the source of truth. Every betting-account login/check path accepts that URL after the existing `normalizePublicHttpsExactOrigin` validation.

The static `CROWN_BETTING_ALLOWED_ORIGINS` membership check is removed. No replacement setting or UI is added. Public HTTPS exact-origin validation, credential/path/query/hash rejection, private/local/IP rejection, and manual redirect handling remain unchanged.

Tests prove an empty or unrelated legacy environment value no longer blocks a valid saved public HTTPS origin, while unsafe URLs still fail before network access.
