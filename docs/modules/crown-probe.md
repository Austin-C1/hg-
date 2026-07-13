# 皇冠只读采集器模块

## 目标

采集皇冠页面中用于后续适配的数据：

- 赛事、联赛、主客队文本。
- 盘口、水位、赔率候选 DOM。
- 可能的投注项 ID、odds ID、event ID、market ID。
- 页面切换产生的 Network 请求和 JSON 响应样本。

## 边界

只读采集器不执行任何下注动作：

- 不自动点击盘口。
- 不填投注金额。
- 不提交表单。
- 不调用下注接口。

## 输入

- 登录后的皇冠页面。
- 用户手动进入足球/滚球/早盘等目标页面。

## 输出

输出目录：`data/crown-probe/<时间戳>/`

- `network.jsonl`
- `network-summary.json`
- `json-responses/*.json`
- `manual_*/dom-candidates.json`
- `manual_*/dom-containers.json`
- `manual_*/dom-events.json`
- `manual_*/football-today-filtered.json`
- `manual_*/page-text.txt`
- `manual_*/page.png`

## 验证

基础静态验证：

```bash
node --check scripts/crown-probe.mjs
node scripts/crown-probe.mjs --help
node scripts/crown-probe.mjs --from-capture data/crown-probe/<时间戳>/<采集目录>
```
