# Crown Football Field Map

Primary fixture: `data/fixtures/crown/transform-xml`

Legacy DOM fixture: `data/fixtures/crown/20260708_004011`

## Evidence Summary

`POST /transform.php` `text/xml` is the current confirmed Crown football odds source. DOM-derived `football-today-filtered.json` is fallback / cross-check only.

The captured `/gismo/*` Network JSON is mostly BetRadar-style match information, timelines, details, translations, and team/season statistics. It should not be treated as Crown odds.

## Endpoint Evidence

| Endpoint Pattern | Evidence | Use |
|---|---|---|
| `POST /transform.php p=get_game_list` | XML `<game>` nodes with `GID/GIDM/HGID/ECID/LID`, `RATIO_*`, `IOR_*` | Primary odds source |
| `POST /transform.php p=get_game_more` | XML `<game>` nodes with more `RATIO_*` / `IOR_*` markets | More-market odds source |
| `football-today-filtered.json` | DOM event cards with visible league, teams, text, and odds-like tokens | Fallback / cross-check |
| `/gismo/*` JSON | Match metadata, stats, timeline, translations | Metadata only |

## Target Field Map

| Target Field | XML Raw Path | Evidence | Confidence | Current rule |
|---|---|---|---|---|
| `eventId` | `game.GID` | Real Crown XML id | high | Use `GID` |
| `eventKey` | `GID/GIDM/HGID/ECID/LID` | Real Crown runtime ids | high | Local stable key from all five ids |
| `league` | `LEAGUE` | Crown XML league text | high | Preserve raw text |
| `homeTeam` | `TEAM_H` | Crown XML home team | high | Preserve raw text |
| `awayTeam` | `TEAM_C` | Crown XML away team | high | Preserve raw text |
| `startTimeRaw` | `GAME_DATE_TIME` / `DATETIME` | Crown XML kickoff text | medium | Preserve raw text; UTC not asserted |
| `status` | `SHOWTYPE`, `IS_RB` | `rb` / `Y` indicates live | high | `live` or `not_started` |
| `score` | `SCORE_H/SCORE_C` | Structured live score | high when present | `H-C` or `null` |
| `clock` | `RETIMESET` | Structured live clock | high when present | Preserve raw clock |
| `marketId` | none | Provider id not present | low | Local key only, `idScope=local` |
| `marketKey` | local composite | Stable monitor key | high | `eventKey + period + marketType + lineKey + handicap` |
| `marketType` | `RATIO_*` / `IOR_*` family | Field-family mapping | medium/high | Map known families; unknown decimal `IOR_*` -> `other` |
| `period` | field prefix | `H*` first half, `R*` live full time | medium/high | `full_time` / `first_half` |
| `handicapRaw` | `RATIO_*` | Crown line field | high | Preserve exact raw string |
| `handicap` | parsed `RATIO_*` | Numeric line | medium | Split line average, e.g. `2.5 / 3` -> `2.75` |
| `ratioField` | `RATIO_*` name | Exact source field | high | Preserve uppercase field name |
| `selectionId` | none | Provider id not present | low | Local key only, `idScope=local` |
| `selectionKey` | local composite | Stable monitor key | high | `marketKey + side` |
| `side` | mapped from `IOR_*` suffix | Home/away/over/under/etc. | medium/high | Preserve mapped side |
| `oddsId` | none | Not found in XML | high | Always `null`; do not fabricate |
| `oddsRaw` | `IOR_*` | Crown odds field | high | Preserve exact raw string |
| `odds` | parsed `IOR_*` | Numeric odds | high when finite | Number or `null` |
| `oddsField` | `IOR_*` name | Exact source field | high | Preserve uppercase field name |
| `suspended` | empty odds or closed market flags | `GOPEN/HGOPEN=N` or blank odds | medium | `true` when market closed or odds not finite |

## Market Mapping

| XML fields | marketType | period | side |
|---|---|---|---|
| `RATIO_R`, `IOR_RH/IOR_RC` | `asian_handicap` | `full_time` | `home` / `away` |
| `RATIO_RE`, `IOR_REH/IOR_REC` | `asian_handicap` | live `full_time` | `home` / `away` |
| `RATIO_HR`, `IOR_HRH/IOR_HRC` | `asian_handicap` | `first_half` | `home` / `away` |
| `RATIO_HRE`, `IOR_HREH/IOR_HREC` | `asian_handicap` | live `first_half` | `home` / `away` |
| `RATIO_OUO/OUU`, `IOR_OUC/IOR_OUH` | `total` | `full_time` | `over` / `under` |
| `RATIO_ROUO/ROUU`, `IOR_ROUC/IOR_ROUH` | `total` | live `full_time` | `over` / `under` |
| `RATIO_HOUO/HOUU`, `IOR_HOUC/IOR_HOUH` | `total` | `first_half` | `over` / `under` |
| `RATIO_HROUO/HROUU`, `IOR_HROUC/IOR_HROUH` | `total` | live `first_half` | `over` / `under` |
| `RATIO_AR/BR/CR/DR/ER/FR`, `IOR_*RH/IOR_*RC` | `asian_handicap` | `full_time` | `home` / `away` |
| `RATIO_ARE/BRE/CRE/DRE/ERE/FRE`, `IOR_*REH/IOR_*REC` | `asian_handicap` | live `full_time` | `home` / `away` |
| `RATIO_AOUO/BOUO/COUO/DOUO/EOUO/FOUO`, `IOR_*OUO/IOR_*OUU` | `total` | `full_time` | `over` / `under` |
| `RATIO_AROUO/BROUO/CROUO/DROUO/EROUO/FROUO`, `IOR_*ROUO/IOR_*ROUU` | `total` | live `full_time` | `over` / `under` |
| `IOR_MH/MC/MN`, `IOR_RMH/RMC/RMN` | `moneyline` | `full_time` | `home` / `away` / `draw` |
| `IOR_HMH/HMC/HMN`, `IOR_HRMH/HRMC/HRMN` | `moneyline` | `first_half` | `home` / `away` / `draw` |

## Mapping Rules

- Prefer XML fields for all live monitoring records.
- 当前只采集让球和普通大小球；球队大小球、独赢、单双、Yes/No 和其他盘口不写入监控快照。
- Use DOM only when XML is unavailable or for cross-checking visible page state.
- Treat `/gismo/*` responses as metadata candidates, not odds.
- Keep provider `marketId`, `selectionId`, and `oddsId` unresolved until explicitly found in XML or another verified Crown response.
- Mark `isMainMarket=unknown` until a provider main-market flag is confirmed.
- League filtering runs after normalization.
