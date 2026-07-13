# Crown Runtime Source Audit

## Conclusion

`POST /transform.php` 的 `text/xml` 响应是当前已确认的 Crown 真实足球赔率主源。DOM 赛事卡片只作为 fallback / cross-check；JSON `/gismo/*`、WebSocket 和 DOM 都不是当前主源。

本阶段仍是只读监控，不做下注执行、不点击盘口、不填写金额、不构造投注请求。

## Confirmed Sources

| Candidate | Status | Use |
|---|---|---|
| `POST /transform.php p=get_game_list` `text/xml` | Confirmed primary | 赛前、今日、滚球列表赔率 |
| `POST /transform.php p=get_game_more` `text/xml` | Confirmed fixture path | 更多盘口和补充市场 |
| DOM event cards | Fallback / cross-check | 页面可见结果校验、XML 不可用时兜底展示 |
| `/gismo/*` JSON | Not odds source | 比赛资料、统计、时间线、翻译 |
| WebSocket frames | Not confirmed | 暂无稳定赔率流样本 |
| `POST /transform_nl.php p=chk_login` | Login/session only | 返回登录状态和 `uid`，不得原样记录 |

## Current Implementation

| Area | Current behavior |
|---|---|
| XML detector | `src/crown/endpoint-detector.mjs` 识别 Crown transform XML |
| XML parser | `src/crown/crown-transform-xml.mjs` 解析 `<game>`、`RATIO_*`、`IOR_*` |
| Watcher | `scripts/crown-watch.mjs` 监听页面 runtime XML，不主动构造 Crown odds 请求 |
| Store | `src/crown/storage/jsonl-store.mjs` 写 snapshots/changes JSONL |
| Dashboard | `/matches` 显示 `XML live` / `DOM fallback` / `fixture replay` 和 XML counters |
| Fixture | `data/fixtures/crown/transform-xml/` 固定 XML fixture 回放 |

## Field Authenticity

| Field | Source | Current truth |
|---|---|---|
| `event.eventId` | XML `GID` | Real Crown event id |
| `event.ids.gid/gidm/hgid/ecid/lid` | XML `GID/GIDM/HGID/ECID/LID` | Real Crown runtime ids |
| `event.eventKey` | Local composite from ids | Stable local event key based on `GID/GIDM/HGID/ECID/LID` |
| `market.marketId` | Local composite | Local key, not provider market id |
| `market.marketKey` | Local composite | `eventKey + period + marketType + handicap` |
| `selection.selectionId` | Local composite | Local key, not provider selection id |
| `selection.selectionKey` | Local composite | `marketKey + side` |
| `selection.oddsId` | Not present | Always `null`; do not fabricate |
| `market.handicapRaw` | XML `RATIO_*` | Raw Crown line |
| `market.handicap` | Parsed from `RATIO_*` | Numeric value; split line uses average, e.g. `0 / 0.5` -> `0.25` |
| `selection.oddsRaw` | XML `IOR_*` | Raw Crown IOR value |
| `selection.odds` | Parsed from `IOR_*` | Number or `null` when suspended/empty |
| `selection.oddsField` | XML field name | Exact `IOR_*` field |
| `market.ratioField` | XML field name | Exact `RATIO_*` field or `null` |

## Field Mapping

| XML fields | marketType | period | side |
|---|---|---|---|
| `RATIO_R`, `IOR_RH/IOR_RC` | `asian_handicap` | `full_time` | `home` / `away` |
| `RATIO_RE`, `IOR_REH/IOR_REC` | `asian_handicap` | `full_time` live | `home` / `away` |
| `RATIO_HR`, `IOR_HRH/IOR_HRC` | `asian_handicap` | `first_half` | `home` / `away` |
| `RATIO_HRE`, `IOR_HREH/IOR_HREC` | `asian_handicap` | `first_half` live | `home` / `away` |
| `RATIO_OUO/OUU`, `IOR_OUC/IOR_OUH` | `total` | `full_time` | `over` / `under` |
| `RATIO_ROUO/ROUU`, `IOR_ROUC/IOR_ROUH` | `total` | `full_time` live | `over` / `under` |
| `RATIO_HOUO/HOUU`, `IOR_HOUC/IOR_HOUH` | `total` | `first_half` | `over` / `under` |
| `RATIO_HROUO/HROUU`, `IOR_HROUC/IOR_HROUH` | `total` | `first_half` live | `over` / `under` |
| `RATIO_AR/BR/CR/DR/ER/FR`, `IOR_*RH/IOR_*RC` | `asian_handicap` | `full_time` | `home` / `away` |
| `RATIO_ARE/BRE/CRE/DRE/ERE/FRE`, `IOR_*REH/IOR_*REC` | `asian_handicap` | `full_time` live | `home` / `away` |
| `RATIO_AOUO/BOUO/COUO/DOUO/EOUO/FOUO`, `IOR_*OUO/IOR_*OUU` | `total` | `full_time` | `over` / `under` |
| `RATIO_AROUO/BROUO/CROUO/DROUO/EROUO/FROUO`, `IOR_*ROUO/IOR_*ROUU` | `total` | `full_time` live | `over` / `under` |
| `IOR_MH/MC/MN` | `moneyline` | `full_time` | `home` / `away` / `draw` |
| `IOR_RMH/RMC/RMN` | `moneyline` | `full_time` live | `home` / `away` / `draw` |
| `IOR_HMH/HMC/HMN` | `moneyline` | `first_half` | `home` / `away` / `draw` |
| `IOR_HRMH/HRMC/HRMN` | `moneyline` | `first_half` live | `home` / `away` / `draw` |
| `IOR_EOO/EOE`, `IOR_REOO/REOE` | `odd_even` | `full_time` | `odd` / `even` |
| `IOR_TSY/TSN`, `IOR_RTSY/RTSN` | `yes_no` | `full_time` | `yes` / `no` |
| Other decimal `IOR_*` | `other` | inferred | field suffix |

当前监控只写入 `asian_handicap` 和 `total`。球队大小球、独赢、单双、Yes/No 和其他盘口保留为协议识别信息，不进入监控快照和候选下注链路。

## Main Market Rules

`get_game_list` 是列表主响应，`get_game_more` 是更多盘口响应。当前已能区分 endpoint kind、全场/半场、赛前/滚球字段。

让球主盘口和大小球主盘口仍未从 XML 中找到可证明的 provider flag。当前 `isMainMarket=unknown`，不猜。

## Change Detection

已支持：

- `odds-change`
- `handicap-change`
- `market-suspended`
- `market-reopened`
- `event-added`
- `event-removed`

每条 change 保留 `old` / `next` 的 odds、handicap、market、selection、mode、source、warnings。

## Runtime Counters

`crown-watch` 每 30 秒输出并写入 `crown-watch-runtime.jsonl`：

- `xmlResponses`
- `getGameListCount`
- `getGameMoreCount`
- `xmlEvents`
- `normalizedRecords`
- `snapshotWrites`
- `changeWrites`
- `parseErrors`
- `emptyXmlResponses`
- `loginExpiredResponses`
- `lastXmlAt`
- `lastSnapshotAt`

## Fixtures And Tests

Fixed XML fixtures:

- `data/fixtures/crown/transform-xml/get-game-list-today.xml`
- `data/fixtures/crown/transform-xml/get-game-more.xml`
- `data/fixtures/crown/transform-xml/get-game-list-live.xml`
- `data/fixtures/crown/transform-xml/empty-odds.xml`
- `data/fixtures/crown/transform-xml/suspended.xml`
- `data/fixtures/crown/transform-xml/login-expired.html`
- `data/fixtures/crown/transform-xml/invalid.xml`

Primary tests:

- `tests/crown-transform-xml.test.mjs`
- `tests/crown-jsonl-store.test.mjs`
- `tests/crown-replay-fixture.test.mjs`
- `tests/crown-watch-fixture.test.mjs`
- `tests/crown-dashboard-data.test.mjs`

## Missing Fields

| Missing | Impact |
|---|---|
| Provider `marketId` | Local `marketId` cannot be used as betting id |
| Provider `selectionId` | Local `selectionId` cannot be used as betting id |
| Provider `oddsId` | Always `null`; Dashboard displays not available |
| Verified main-market flag | `isMainMarket=unknown` |
| Guaranteed UTC kickoff | `startTimeRaw` retained; UTC parsing not asserted |
| Betting execution identifiers | Not implemented by design |
