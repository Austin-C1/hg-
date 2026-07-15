# 正常足球全场盘口过滤设计

## 目标

监控链只接收正常球队比赛的全场让球和全场大小球。角球、罚牌、特定球员、加时赛等衍生赛事，以及半场盘口，不得生成 event、selection、Signal、Telegram 告警或投注候选。

## 设计

- 在现有 Crown XML 标准化入口按 league/home/away 文本排除衍生赛事，沿用现有电竞/虚拟赛事过滤方式。
- XML 与 DOM 兼容标准化器只生成 `period=full_time` 的 `asian_handicap` 和 `total`。
- 不新增配置、依赖、页面、数据库字段或新的过滤层。
- authoritative batch 的 `eligibleGameCount`、`excludedGameCount` 和 event refs 继续以过滤后的正常比赛为准。

## 验证

- 回归样本同时包含正常比赛、罚牌、角球、特定球员和加时赛，只有正常比赛产生全场记录。
- 现有 transformer、monitor-v2、Telegram 和全项目测试通过。
- 重启 watcher 后，现场 active state 不再出现衍生赛事；后续新告警只包含正常球队名称与全场盘口。
