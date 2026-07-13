# Betting Contract

This contract defines the data boundary between monitor signals, manual review, risk checks, protocol mapping, and a future Crown-specific execution adapter.

## BetIntent

```ts
type BetIntent = {
  intentId: string;
  createdAt: string;
  provider: 'crown';
  sport: 'football';
  event: {
    eventId: string;
    eventKey: string;
    league: string;
    homeTeam: string;
    awayTeam: string;
  };
  market: {
    marketId: string;
    marketType: 'asian_handicap' | 'total' | 'moneyline' | 'unknown';
    period: 'full_time' | 'first_half' | 'unknown';
    handicapRaw: string | null;
    ratioField: string;
  };
  selection: {
    selectionId: string;
    side: 'home' | 'away' | 'over' | 'under' | 'draw' | 'unknown';
    oddsRaw: string;
    odds: number | null;
    oddsField: string;
  };
  decision: {
    reason: string;
    confidence: 'low' | 'medium' | 'high';
    maxStakeHint: number | null;
  };
  source: {
    snapshotFile: string;
    changeFile: string | null;
    endpointKey: string;
  };
  execution?: CrownExecutionPayload;
};
```

## CrownExecutionPayload

```ts
type CrownExecutionPayload = {
  mode: 'dry-run' | 'real';
  confirmedBy: 'manual';
  accountId: string;
  stake: number;
  currency: string | null;
  provider: 'crown';
  protocolVersion: string;
  sourceIds: {
    gid: string | null;
    gidm: string | null;
    hgid: string | null;
    ecid: string | null;
    lid: string | null;
  };
  marketFields: {
    ratioField: string | null;
    oddsField: string | null;
    handicapRaw: string | null;
    oddsRaw: string | null;
  };
  providerOrderFields: Record<string, string | number | boolean | null>;
  requestPlan: Array<{
    step: string;
    method: 'GET' | 'POST';
    endpointKey: string;
    purpose: string;
  }>;
};
```

`providerOrderFields` must stay empty until `docs/crown-betting-protocol-map.md` identifies the exact Crown fields needed for preview and submit.

`sourceIds` and `marketFields` may contain values derived from monitor XML, but those values must not be treated as provider submit fields until the protocol map proves the relationship.

## Non-Goals For The Monitor

- No betting execution inside `scripts/crown-watch.mjs`.
- No automatic order submission from alerts.
- No storage or reporting of raw cookies, tokens, authorization headers, set-cookie values, passwords, or local keys.
- No bypass of CAPTCHA, manual verification, signatures, risk controls, or account protections.

## Execution Gate

A future real execution path must define risk limits, manual confirmation rules, provider response handling, retry behavior, odds-changed handling, and audit requirements before it can be wired to a UI action or CLI command.
