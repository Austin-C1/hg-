# Crown Fixture 20260708_004011

This fixture freezes the successful Crown capture from `data/crown-probe/20260708_004011`.

## Scope

- Source capture: `data/crown-probe/20260708_004011`
- Fixture purpose: offline endpoint analysis, field mapping, normalization, and replay tests.
- Runtime boundary: read local files only.

## Included Files

- `network.jsonl`
- `network-summary.json`
- `json-responses/`
- `football-today-filtered.json`
- `dom-events.json`

## Known Counts

| Item | Count |
|---|---:|
| Prematch football events | 20 |
| Live football events | 18 |
| Filtered result keyword hits for esports/virtual/fantasy | 0 |

## Notes

- This fixture is the baseline for the first read-only football monitor.
- Do not add cookies, tokens, authorization headers, or executable betting data to reports derived from this fixture.
- Future monitor work should replay this fixture before using a live logged-in browser session.
