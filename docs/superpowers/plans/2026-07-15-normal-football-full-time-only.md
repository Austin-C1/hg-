# Normal Football Full-Time Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只保留正常球队比赛的全场让球和全场大小球。

**Architecture:** 在现有标准化信任边界过滤衍生赛事，并停止生成半场记录。下游状态、告警和投注候选无需增加第二层规则。

**Tech Stack:** Node.js ESM、`node:test`、现有 Crown XML/DOM 标准化器。

## Global Constraints

- 不新增依赖、配置、数据库结构或 UI。
- 不修改投注 Submit/Reconciliation 协议。
- 先复现失败，再做最小实现。

---

### Task 1: 过滤衍生赛事并只输出全场盘口

**Files:**
- Modify: `tests/crown-transform-xml.test.mjs`
- Modify: `src/crown/crown-transform-xml.mjs`
- Modify: `src/crown/normalize-football.mjs`
- Modify: `docs/modules/crown-football-monitor.md`

**Interfaces:**
- Consumes: `normalizeCrownTransformBatch()`、`normalizeFootballResponse()`。
- Produces: 仅正常球队比赛、`period=full_time`、`marketType=asian_handicap|total` 的标准化事实。

- [x] **Step 1: 写入同时包含正常与衍生赛事的失败测试，并断言所有结果都是 full_time。**
- [x] **Step 2: 运行 `node --test tests/crown-transform-xml.test.mjs`，确认因衍生赛事和 first_half 记录仍存在而失败。**
- [x] **Step 3: 扩展现有排除表达式，并删除 XML/DOM 半场记录生成。**
- [x] **Step 4: 运行 transformer、monitor-v2 和 Telegram 聚焦测试。**
- [x] **Step 5: 重启 watcher，核对现场 active state 与新告警事实。**
- [ ] **Step 6: 运行全项目验证；不自动提交 Git。**
