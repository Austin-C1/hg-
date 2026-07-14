# 皇冠投注生产就绪收口 Implementation Plan

> Superseded on 2026-07-14: 浏览器内 API 投注重构、八方向验收和最终发布统一以 docs/superpowers/plans/2026-07-14-crown-browser-api-betting-refactor.md 为准。本文件仅保留历史背景；与新计划冲突的直接 HTTP、5-batch/500-CNY 累计限制及重复 Gate 不再执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为“长期运行、可恢复、不会重复下注”的自动投注系统收口阶段一：消除六项 preflight 全 ready 却持续停在 `armed_waiting/preflight-required` 的矛盾，固定 readyTicket/GO 两阶段启动与重启恢复边界，并形成完整离线绿色证据；核心原则是宁可不下注，也不能猜字段、重复下注或对 `unknown` 自动重投。

**Architecture:** SQLite 继续只持久化用户的 `requested` intent 和运行状态；PID、readyTicket、lease owner、fencing token 与 GO generation/nonce 都是进程内派生状态，重启后必须重新取得。启动分为四项静态 preflight、Worker 获取两类 lease 并返回 readyTicket、六项 post-ready preflight、提交 `running` 后发送 GO 四步；任一步失败都停止 fake/managed child 并保持 fail-closed。本阶段仅用临时 SQLite、fake child process 和离线测试，不访问 Crown，也不启动真实 Worker。

**Tech Stack:** Node.js ESM 22.23.1（项目下限 `>=22.5`）、`node:test`、SQLite `node:sqlite`、IPC `child_process`、React/Vite/Vitest、PowerShell、现有 Crown capability matrix。

## Global Constraints

- 最终系统目标是持续监控盘口与水位变化，命中动态规则后按账号顺序执行 fresh Preview 和单次 Submit，并在断网、Worker 崩溃或程序重启后依据 SQLite 账本安全恢复。
- 安全底线：宁可不下注，也不能猜测 capability、wire 字段、盘口 identity、赔率、金额、session 或 outcome；每个 child 最多一次网络开始；`unknown` 保留金额和账号锁，不自动重试、转投、解锁或推断 accepted。
- 本阶段只处理 runtime 状态、四项静态/六项完整 preflight、readyTicket/GO、重启恢复、完整离线验证和文档口径；不修改 mapper、Provider、金额策略、账号配置、规则卡业务或 capability row。
- 本阶段真实 Crown I/O 必须为 0：不得调用 `FT_order_view`、`FT_bet`、真实登录、真实 reconciliation 或 protocol capture；不得启动 `scripts/crown-betting-worker.mjs --mode real`，不得创建真实 batch。
- 用户已授予后续持续 Submit 授权，但该 standing authorization 只在本计划 Gate A 全部通过后，按阶段二计划生效；它不能被本阶段用于访问网络、Preview、Submit 或启动 real Worker。
- 当前唯一开放 row 固定为 `prematch/full_time/asian_handicap/main`，Preview/Submit/Reconciliation 为 `1/1/0`；其他 row 全部保持 0，阶段一不得升为 `1/1/1` 或新增 row。
- 四项静态 preflight 固定为 `ruleCardsEnabled`、`bettingAccountAvailable`、`capabilityExact`、`schemaCurrent`；只有 Worker ready 后才可用 readyTicket 验证 `fenceFresh` 与 `executorLeaseFresh`，完整 preflight 固定六项。
- SQLite 只恢复 `requested` intent；旧 PID、旧 readyTicket、旧 generation/nonce、旧 owner 或旧 fencing token 一律无效。冷启动状态读不能凭历史数据直接制造 `running`。
- `running` 只能在六项 post-ready preflight 全部通过后写入；GO 发送失败、缺 readyTicket、readyTicket 不匹配、Worker 早退或 post-ready fence 失败必须停止 managed child 并保持 `armed_waiting` 或 `blocked`。
- 当前工作区已有大量用户和既有任务改动。实现时只修改各 Task 列出的文件，不回滚、不覆盖、不顺手格式化；本次用户指令已授权后续 scoped local commit 和最终 GitHub 替换发布，各 Task 仍必须逐文件 stage、排除 private/runtime evidence，且阶段一不得提前 push/merge。
- 现有工作区已包含两阶段启动候选实现和历史 RED 记录。若新增 RED 用例在当前工作区已通过，先对该 Task 的 `Files` 清单逐一执行 `git diff --`，核对它是否正是本计划要求的候选实现；不得故意破坏测试制造 RED，也不得跳过对实现的逐项审查。
- 所有测试使用临时数据库、fake process、fake IPC 或纯函数。测试和证据不得记录账号、密码、cookie、token、完整 uid、原始 Crown 响应、完整注单 ID、密钥或私有绝对路径。

---

## File Map

| 文件 | 单一职责 |
|---|---|
| `src/crown/betting/real-betting-runtime.mjs` | 定义静态/完整 preflight、持久 intent、状态转换和 exact lease/ticket 校验 |
| `src/crown/app/betting-process.mjs` | 管理唯一 Worker child、IPC readyTicket、generation/nonce、GO 和停止/早退 |
| `src/crown/betting/real-worker-factory.mjs` | 提供 GO barrier 与 Worker/Executor 双 lease heartbeat |
| `scripts/crown-betting-worker.mjs` | real Worker 启动时取得两个 lease、发送 readyTicket，并在 GO 前不进入工作循环 |
| `src/crown/app/app-api.mjs` | 编排 arm → stop old child → static gate → spawn → post-ready gate → running → GO |
| `src/crown/app/real-betting-dto.mjs`、`src/crown/app/app-repository.mjs` | 只输出 allowlisted runtime/reason/readiness，不泄漏 IPC 或本地路径 |
| `tests/crown-real-betting-runtime.test.mjs` | 锁定四项/六项 gate、重启 intent 与 ticket/fence 语义 |
| `tests/crown-betting-process.test.mjs` | 锁定 readyTicket/GO、重启、停止、早退和 fake child 行为 |
| `tests/crown-betting-worker.test.mjs` | 锁定 GO barrier 和双 lease heartbeat，无真实 Provider I/O |
| `tests/crown-app-api.test.mjs` | 锁定 API 两阶段顺序、缺 ticket、post-ready 失败、GO 失败和并发 stop |
| `tests/crown-operations-summary.test.mjs` | 锁定 runtime/Operations 安全投影与 reason allowlist |
| `scripts/crown-betting-production-readiness-audit.mjs` | 串行执行 Gate A 并原子生成机器可读 safe evidence |
| `tests/crown-betting-production-readiness-audit.test.mjs` | 用 fake command runner 验证 evidence schema、失败不落盘和脱敏边界 |
| `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json` | 阶段二唯一机器可读 Gate A 前置证据；保留在现有 ignored SDD evidence 目录，不进入 Git |
| `README.md`、`docs/project-memory.md`、`docs/module-index.md`、`docs/modules/crown-betting-protocol.md` | 各保留一处当前 `1/1/0` 权威摘要；旧 `0/0/0` 明确标记为历史 |
| 其他当前架构/发布文档与计划顶部 | 删除重复的“当前 0/0/0”判断，改为历史说明或链接到四个权威摘要 |

### Task 1: 拆分静态与 post-ready preflight，并固定重启 intent

**Files:**
- Modify: `tests/crown-real-betting-runtime.test.mjs:10-110`
- Modify: `tests/crown-real-betting-runtime.test.mjs:159-182`
- Modify: `src/crown/betting/real-betting-runtime.mjs:4-12`
- Modify: `src/crown/betting/real-betting-runtime.mjs:67-79`
- Modify: `src/crown/betting/real-betting-runtime.mjs:94-180`
- Modify: `src/crown/betting/real-betting-runtime.mjs:225-271`

**Interfaces:**
- Consumes: `RealBettingChecks = { ruleCardsEnabled, bettingAccountAvailable, capabilityExact, schemaCurrent, fenceFresh, executorLeaseFresh }`，值只能以 `=== true` 视为 ready。
- Produces: `evaluateRealBettingStaticPreflight(checks)`（四项）、`evaluateRealBettingPreflight(checks)`（六项）、`armRealBettingStart(database, options)`、`commitRealBettingRunning(database, checks, options)`。
- Produces: `collectRealBettingPreflight(database, { dbPath, now, freshnessMs, readyTicket })`；无 ticket 时只判断 canonical role key 可取得，有 ticket 时必须逐项匹配 lease key、owner、fencing token、heartbeat 和 expires_at。

- [ ] **Step 1: 写静态/完整 gate 的 RED 测试**

在测试 import 中加入 `armRealBettingStart`、`commitRealBettingRunning`、`evaluateRealBettingPreflight`、`evaluateRealBettingStaticPreflight`，并加入：

```js
test('static preflight may spawn before leases exist but running requires all six post-ready checks', () => {
  const handle = openAppDatabase({ dbPath: ':memory:' })
  try {
    const preReady = { ...READY, fenceFresh: false, executorLeaseFresh: false }
    assert.equal(evaluateRealBettingStaticPreflight(preReady).ready, true)
    assert.deepEqual(evaluateRealBettingStaticPreflight(preReady).preflight.map((item) => item.code), [
      'betting-rule-card-not-enabled',
      'betting-account-unavailable',
      'capability-evidence-not-exact',
      'schema-not-current',
    ])
    assert.equal(evaluateRealBettingPreflight(preReady).ready, false)

    const armed = armRealBettingStart(handle.db, { now: () => new Date('2026-07-14T00:00:00.000Z') })
    assert.equal(armed.requested, true)
    assert.equal(armed.state, 'armed_waiting')
    assert.equal(armed.reasonCode, 'preflight-required')

    const refused = commitRealBettingRunning(handle.db, preReady, {
      now: () => new Date('2026-07-14T00:00:01.000Z'),
    })
    assert.equal(refused.state, 'armed_waiting')
    assert.equal(refused.reasonCode, 'fence-not-fresh')

    const running = commitRealBettingRunning(handle.db, READY, {
      now: () => new Date('2026-07-14T00:00:02.000Z'),
    })
    assert.equal(running.state, 'running')
    assert.equal(running.reasonCode, '')
  } finally { handle.close() }
})
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 --test-name-pattern="static preflight may spawn" tests/crown-real-betting-runtime.test.mjs
```

Expected: pre-change 基线 FAIL，错误为缺少 `evaluateRealBettingStaticPreflight`、`armRealBettingStart` 或 `commitRealBettingRunning`；当前候选实现若已存在则 PASS，并须先核对该文件 diff 与下方实现完全一致。

- [ ] **Step 3: 实现最小静态/完整 preflight 与显式状态转换**

```js
const PREFLIGHT = Object.freeze([
  ['ruleCardsEnabled', 'betting-rule-card-not-enabled'],
  ['bettingAccountAvailable', 'betting-account-unavailable'],
  ['capabilityExact', 'capability-evidence-not-exact'],
  ['schemaCurrent', 'schema-not-current'],
  ['fenceFresh', 'fence-not-fresh'],
  ['executorLeaseFresh', 'executor-lease-not-fresh'],
])
const STATIC_PREFLIGHT = Object.freeze(PREFLIGHT.slice(0, 4))

function evaluatePreflight(checks, requirements) {
  const preflight = requirements.map(([field, code]) => ({ code, ready: checks[field] === true }))
  const blockingReasons = preflight.filter((item) => !item.ready).map((item) => item.code)
  return { ready: blockingReasons.length === 0, reasonCode: blockingReasons[0] || '', blockingReasons, preflight }
}

export function evaluateRealBettingPreflight(checks = {}) {
  return evaluatePreflight(checks, PREFLIGHT)
}

export function evaluateRealBettingStaticPreflight(checks = {}) {
  return evaluatePreflight(checks, STATIC_PREFLIGHT)
}

export function armRealBettingStart(database, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  return update(db, { requested: true, state: 'armed_waiting', reasonCode: 'preflight-required' }, at(options))
}

export function commitRealBettingRunning(database, checks = {}, options = {}) {
  const db = dbOf(database)
  ensureRow(db)
  const preflight = evaluateRealBettingPreflight(checks)
  if (!preflight.ready) {
    return statusWithPreflight(
      update(db, { requested: true, state: 'armed_waiting', reasonCode: preflight.reasonCode }, at(options)),
      checks,
    )
  }
  const current = rowStatus(db.prepare('SELECT * FROM real_betting_runtime WHERE singleton_id=1').get())
  if (!current.requested) return statusWithPreflight(current, checks)
  return statusWithPreflight(
    update(db, { requested: true, state: 'running', reasonCode: '' }, at(options)),
    checks,
  )
}
```

在 `collectRealBettingPreflight()` 中保留 exact canonical role key，但“lease 当前可取得”只供四项 static spawn gate 内部判断，绝不能投影成两项 post-ready 为 ready。没有 ticket 时 `fenceFresh=false`、`executorLeaseFresh=false`，full preflight 必须带 `ready-ticket-required`/`executor-ready-ticket-required` blocker；有 ticket 后才按 lease owner/fence/heartbeat 精确匹配：

```js
const ticket = options.readyTicket
const held = (role, row) => Boolean(active(row) && ticket?.leases?.[role]
  && ticket.leases[role].leaseKey === row.lease_key
  && ticket.leases[role].ownerId === row.owner_id
  && Number(ticket.leases[role].fencingToken) === Number(row.fencing_token)
  && Number.isFinite(Date.parse(row.heartbeat_at))
  && nowMs - Date.parse(row.heartbeat_at) >= 0
  && nowMs - Date.parse(row.heartbeat_at) <= freshnessMs)
const postReady = Boolean(ticket)
const distinctRoles = postReady
  ? Boolean(held('worker', worker) && held('executor', executor)
    && worker.lease_key !== executor.lease_key && worker.owner_id !== executor.owner_id)
  : false
const rolesReady = postReady && distinctRoles
```

增加回归断言：静态四项 ready 且两个 role lease 可取得时，`evaluateRealBettingStaticPreflight()` 为 ready；同一份无 ticket full checks 的两项 post-ready 必须为 false、`blockingReasons.length===2`，不得再次出现 `armed_waiting + blockingReasons=[]`。

- [ ] **Step 4: 增加重启与伪造 ticket 回归**

保留并扩展现有 disk-backed reopen 用例：`requested=true/running` 重开数据库后只能得到 `requested=true/armed_waiting/preflight-required`，六项 derived checks 重新计算；另用错误 executor fencing token 断言 `fenceFresh === false`。测试不得把旧 readyTicket 写入 SQLite。

- [ ] **Step 5: 运行 GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs
```

Expected: exit code 0，0 failed；四项静态 gate、六项 commit gate、重启 intent 和 forged ticket 全部 PASS。

- [ ] **Step 6: Commit 当前文档口径（本次 scoped Git 授权已覆盖）**

```powershell
git add src/crown/betting/real-betting-runtime.mjs tests/crown-real-betting-runtime.test.mjs
git commit -m "fix: split crown betting startup preflight"
```

### Task 2: 固定父进程 readyTicket/GO IPC 契约

**Files:**
- Modify: `tests/crown-betting-process.test.mjs:7-109`
- Modify: `src/crown/app/betting-process.mjs:17-23`
- Modify: `src/crown/app/betting-process.mjs:82-182`

**Interfaces:**
- Consumes: `bettingRoleLeaseKeys({ cwd, dbPath }) -> { worker, executor }`，两个 key 必须指向同一 canonical DB 且角色不同。
- Produces: 新建 child 的 `createBettingProcessController().start()` 返回 `Promise<{ running, pid, reused:false, leaseKey, readyTicket, activate }>`；`activate()` 返回 `Promise<true>`，只发送匹配 generation/nonce 的 GO。App API 每次 start 先 stop，因此不会走无 ticket 的 reused 分支。
- Produces: readyTicket 固定 `{ type:'ready', generation, nonce, leases:{ worker, executor } }`；每个 lease 固定包含 `leaseKey`、非空 `ownerId`、正 safe-integer `fencingToken`。

- [ ] **Step 1: 写“ready 前无 GO、坏 ticket 停 child、GO IPC 失败”的 RED 测试**

把 fake child 的 `send` 改为接受 callback，并让 helper 支持 `mutateReady` 与 `goError`：

```js
function fakeSpawn(calls, { ready = true, exitOnKill = true, mutateReady = (value) => value, goError = null } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter()
    child.pid = 4100 + calls.length
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.killSignals = []
    child.sent = []
    child.send = (message, callback) => {
      child.sent.push(message)
      queueMicrotask(() => callback?.(goError))
      return goError === null
    }
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true
      child.killSignals.push(signal)
      if (exitOnKill || signal === 'SIGKILL') queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
    }
    calls.push({ command, args, options, child })
    if (ready) queueMicrotask(() => {
      const workerKey = args[args.indexOf('--worker-lease-key') + 1]
      const suffix = workerKey.slice('betting-worker:'.length)
      child.emit('message', mutateReady({
        type: 'ready',
        generation: args[args.indexOf('--generation') + 1],
        nonce: args[args.indexOf('--ready-nonce') + 1],
        leases: {
          worker: { leaseKey: workerKey, ownerId: 'worker-owner', fencingToken: 1 },
          executor: { leaseKey: `betting-executor:${suffix}`, ownerId: 'executor-owner', fencingToken: 1 },
        },
      }))
    })
    return child
  }
}

test('invalid ready ticket is rejected and the child is terminated', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, {
      mutateReady(ticket) {
        ticket.leases.executor.fencingToken = 0
        return ticket
      },
    }),
  })
  await assert.rejects(controller.start(), /betting-worker-ready-invalid/)
  assert.equal(calls[0].child.killed, true)
  assert.equal(controller.isRunning(), false)
})

test('GO send failure is observable by the caller', async () => {
  const calls = []
  const controller = createBettingProcessController({
    dbPath: 'storage/test.sqlite',
    spawnCommand: fakeSpawn(calls, { goError: new Error('ipc-closed') }),
  })
  const started = await controller.start()
  assert.equal(calls[0].child.sent.length, 0)
  await assert.rejects(started.activate(), /betting-worker-go-failed/)
})
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-betting-process.test.mjs
```

Expected: pre-change 基线至少 FAIL “GO send failure is observable”，因为 `activate()` 不是可等待的 Promise 或忽略 IPC callback；坏 ticket 用例在缺严格校验时也 FAIL。

- [ ] **Step 3: 实现严格 ticket 校验与可等待 GO**

在 `awaitReady()` 中精确验证两种角色、两个不同 owner、正 fencing token；保留 timeout、early exit 和 generation cancellation。`activate()` 使用 IPC callback 报告发送失败：

```js
activate() {
  if (child !== next || readyChild !== next || token !== generation) {
    return Promise.reject(processError('betting-worker-start-aborted'))
  }
  if (typeof next.send !== 'function') {
    return Promise.reject(processError('betting-worker-go-failed'))
  }
  return new Promise((resolve, reject) => {
    next.send({ type: 'go', generation: String(token), nonce }, (error) => {
      if (error) return reject(processError('betting-worker-go-failed'))
      resolve(true)
    })
  })
}
```

`stop()` 继续先增加 generation，再 terminate 当前 child；任何 late ready 都不能恢复 controller。child exit 和 stop 必须清空 `readyChild`、`leaseKey` 与 `currentTicket`。

- [ ] **Step 4: 运行 GREEN 与 restart/stop 回归**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-betting-process.test.mjs
```

Expected: exit code 0，0 failed；ready 前 `child.sent=[]`，显式 `await activate()` 后恰好一个 GO；坏 ticket、GO callback error、early exit 和并发 stop 均 fail-closed。

- [ ] **Step 5: Commit scoped runtime change（本次授权已覆盖）**

```powershell
git add src/crown/app/betting-process.mjs tests/crown-betting-process.test.mjs
git commit -m "fix: harden crown betting ready and go handshake"
```

### Task 3: 固定 Worker 双 lease、readyTicket 与 GO barrier

**Files:**
- Modify: `tests/crown-betting-worker.test.mjs:408-443`
- Modify: `src/crown/betting/real-worker-factory.mjs:64-107`
- Modify: `scripts/crown-betting-worker.mjs:22-53`
- Modify: `scripts/crown-betting-worker.mjs:110-150`
- Modify: `scripts/crown-betting-worker.mjs:187-224`

**Interfaces:**
- Consumes: CLI-only `--generation`、`--ready-nonce`、`--worker-lease-key`，只允许 Dashboard 父进程提供；real mode 缺任一值即失败。
- Produces: `waitForRealWorkerGo({ channel, generation, nonce, signal, timeoutMs }) -> Promise<void>`；只接受 exact generation+nonce。
- Produces: `startRoleLeaseHeartbeat({ leases:[workerLease, executorLease], controller }) -> stopHeartbeat`；任一 heartbeat 失败即 abort Worker。

- [ ] **Step 1: 写 GO mismatch/abort 与 heartbeat failure RED 测试**

```js
test('real worker GO barrier ignores mismatches and aborts without running work', async () => {
  const channel = new EventEmitter()
  const controller = new AbortController()
  let work = 0
  const pending = waitForRealWorkerGo({
    channel,
    generation: '7',
    nonce: 'nonce',
    signal: controller.signal,
    timeoutMs: 1000,
  }).then(() => { work += 1 })

  channel.emit('message', { type: 'go', generation: '6', nonce: 'nonce' })
  channel.emit('message', { type: 'go', generation: '7', nonce: 'wrong' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(work, 0)
  controller.abort()
  await assert.rejects(pending, /betting-worker-start-aborted/)
  assert.equal(work, 0)
  assert.equal(channel.listenerCount('message'), 0)
})
```

保留双 lease heartbeat 测试：两个 lease 的 TTL 均为 3000ms，interval 必须 `<1000`；第二个 heartbeat 抛 `lease-lost` 后 `controller.signal.aborted === true`。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 --test-name-pattern="GO barrier|leases heartbeat" tests/crown-betting-worker.test.mjs
```

Expected: pre-change 基线在缺 GO barrier/abort cleanup 或只 heartbeat 单 lease 时 FAIL；当前候选实现存在时 PASS，并须核对 Worker 主函数的调用顺序。

- [ ] **Step 3: 实现最小 GO barrier 与双 heartbeat**

```js
export function waitForRealWorkerGo({ channel, generation, nonce, signal, timeoutMs = 10_000 } = {}) {
  if (!channel?.on || !channel?.removeListener) throw new TypeError('real-worker-go-channel')
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      channel.removeListener('message', onMessage)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => { cleanup(); reject(new Error('betting-worker-start-aborted')) }
    const onMessage = (message) => {
      if (message?.type !== 'go' || message.generation !== generation || message.nonce !== nonce) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('betting-worker-go-timeout')) }, timeoutMs)
    channel.on('message', onMessage)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export function startRoleLeaseHeartbeat({ leases, controller, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (!Array.isArray(leases) || leases.length !== 2 || !controller?.abort) {
    throw new TypeError('real-worker-role-heartbeat')
  }
  const ttlMs = Math.min(...leases.map((lease) => lease.ttlMs))
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3) throw new TypeError('real-worker-role-heartbeat-ttl')
  const timer = setIntervalFn(() => {
    try {
      for (const lease of leases) lease.heartbeat()
    } catch (error) { controller.abort(error) }
  }, Math.max(1, Math.floor(ttlMs / 3) - 1))
  timer?.unref?.()
  return () => clearIntervalFn(timer)
}
```

Worker 主函数顺序固定为：assert persisted intent → 建立 Provider（不发网络）→ acquire Worker lease → `worker.start()` acquire Executor lease → 启动双 heartbeat → 生成/发送 readyTicket → await exact GO → 才进入 `runOnce()`/`run()`。任何异常都进入 `finally`，停止 heartbeat、停止 worker、释放 Worker lease并关闭 DB。

- [ ] **Step 4: 运行 GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-betting-worker.test.mjs
node --check scripts/crown-betting-worker.mjs
node --check src/crown/betting/real-worker-factory.mjs
```

Expected: 三条命令均 exit code 0；GO 前 work 计数为 0，mismatch 不放行，abort/timeout 清 listener，任一 lease 丢失会 abort。

- [ ] **Step 5: Commit scoped Worker change（本次授权已覆盖）**

```powershell
git add scripts/crown-betting-worker.mjs src/crown/betting/real-worker-factory.mjs tests/crown-betting-worker.test.mjs
git commit -m "fix: gate crown worker execution on go"
```

### Task 4: 修正 App API 两阶段编排，消除 all-ready armed_waiting

**Files:**
- Modify: `tests/crown-app-api.test.mjs:1502-1640`
- Modify: `src/crown/app/app-api.mjs:19-28`
- Modify: `src/crown/app/app-api.mjs:35-81`

**Interfaces:**
- Consumes: Task 1 的 `armRealBettingStart()`、`evaluateRealBettingStaticPreflight()`、`commitRealBettingRunning()`；Task 2 的 `bettingProcess.start()/stop()` 和 async `started.activate()`。
- Produces: `POST /api/app/real-betting/start` 的唯一合法顺序：`arm -> stop -> pre-ready checks -> start -> readyTicket -> post-ready checks -> commit running -> await GO`。
- Produces: 静态 blocker 不 spawn；post-ready blocker 停 child 并保留精确 blocker；启动/ticket/GO 异常停 child 并 `blocked/collector-failed`；任何路径都不直接调用 Provider。

- [ ] **Step 1: 写两阶段成功、缺 ticket、post-ready 失败和 GO 失败 RED 测试**

成功测试必须让 pre-ready 的两个派生项为 false、post-ready 才为 true：

```js
test('real betting start spawns after static preflight and commits only after ready-ticket fence preflight', async (t) => {
  const events = []
  const staticReady = {
    ruleCardsEnabled: true,
    bettingAccountAvailable: true,
    capabilityExact: true,
    schemaCurrent: true,
  }
  await withAppServer(t, async (baseUrl) => {
    const result = await jsonFetch(`${baseUrl}/api/app/real-betting/start`, { method: 'POST', body: '{}' })
    assert.equal(result.payload.item.state, 'running')
    assert.deepEqual(result.payload.item.blockingReasons, [])
    assert.deepEqual(events, ['stop', 'preflight:pre-ready', 'start', 'preflight:post-ready', 'go'])
  }, {}, {
    realBettingPreflight({ readyTicket }) {
      events.push(`preflight:${readyTicket ? 'post-ready' : 'pre-ready'}`)
      return { ...staticReady, fenceFresh: Boolean(readyTicket), executorLeaseFresh: Boolean(readyTicket) }
    },
    bettingProcess: {
      async stop() { events.push('stop'); return { stopped: true } },
      async start() {
        events.push('start')
        return {
          running: true,
          readyTicket: { type: 'ready', leases: {} },
          async activate() { events.push('go'); return true },
        }
      },
    },
  })
})
```

再增加 GO 失败测试：fake `activate()` 抛 `betting-worker-go-failed`，断言 start response 不是 `running`、reason 为 `collector-failed`、`stop()` 总计调用两次；缺 readyTicket 使用相同 `blocked/collector-failed`，post-ready `fenceFresh=false` 则返回 `armed_waiting/fence-not-fresh` 且 GO 调用 0 次。

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 --test-name-pattern="real betting (restart|start|concurrent stop)" tests/crown-app-api.test.mjs
```

Expected: 原单阶段实现至少在“两阶段成功”用例 FAIL；当前候选实现对 async GO failure 仍应 RED，不能返回短暂或最终 `running`。

- [ ] **Step 3: 实现最小两阶段 orchestration**

```js
start: async () => {
  armRealBettingStart(db, { now: options.now })
  await options.bettingProcess?.stop?.()
  const checks = await readChecks()
  const staticPreflight = evaluateRealBettingStaticPreflight(checks)
  if (!staticPreflight.ready) return requestRealBettingStart(db, checks, { now: options.now })
  try {
    const started = await options.bettingProcess?.start?.({ dbPath: options.dbPath })
    if (!started?.readyTicket) throw new Error('betting-worker-ready-ticket-required')
    const freshChecks = await readChecks(started.readyTicket)
    const committed = commitRealBettingRunning(db, freshChecks, { now: options.now })
    if (committed.state !== 'running') {
      await options.bettingProcess?.stop?.()
      return committed
    }
    await started.activate()
    return committed
  } catch {
    await options.bettingProcess?.stop?.()
    return blockRealBettingRuntime(db, 'collector-failed', { now: options.now })
  }
},
```

同时从 runtime import `blockRealBettingRuntime`。`readChecks(readyTicket)` 只允许内部 ticket 覆盖 controller 的当前 ticket；API request body 不能注入 ticket、checks、PID、lease 或 capability。

- [ ] **Step 4: 保留并发 stop 与 stale running 回归**

并发 stop 用例必须证明 in-flight ready handshake 被 generation 取消，stop response 为 `off`，迟到的 start response 绝不为 `running`。`GET /real-betting-status` 若发现持久 `running` 但当前 full preflight 失败，必须转为 `blocked` 并停止 managed child。

- [ ] **Step 5: 运行 GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-app-api.test.mjs
```

Expected: exit code 0，0 failed；成功事件顺序完全一致，静态 blocker spawn=0，post-ready failure GO=0，缺 ticket/GO failure 均 stop 且不返回 running，并发 stop 不被迟到 ready 复活。

- [ ] **Step 6: Commit scoped API change（本次授权已覆盖）**

```powershell
git add src/crown/app/app-api.mjs tests/crown-app-api.test.mjs
git commit -m "fix: complete crown betting two phase startup"
```

### Task 5: 锁定 Dashboard 重启恢复与 Operations 安全投影

**Files:**
- Modify: `tests/crown-real-betting-runtime.test.mjs:30-89`
- Modify: `tests/crown-operations-summary.test.mjs:356-415`
- Modify: `tests/crown-betting-process.test.mjs:58-109`
- Modify: `tests/crown-portable-runtime.test.mjs:229-254`
- Modify: `scripts/crown-dashboard.mjs:138-255`
- Modify: `src/crown/app/app-api.mjs:35-82`
- Modify only if a test fails: `src/crown/app/real-betting-dto.mjs:1-34`
- Modify only if a test fails: `src/crown/app/app-repository.mjs:1836-1869`

**Interfaces:**
- Consumes: SQLite `real_betting_runtime.requested`，以及进程内 controller 的 child/ticket/generation。
- Produces: 重启后先把旧 derived state 安全降为 `armed_waiting/preflight-required`，随后若持久 `requested=true`，Dashboard 必须调用与 POST start 完全相同的两阶段 service 恢复；不得复用旧 PID/ticket/fence，也不得绕过 static/post-ready gate。
- Produces: 无 ticket 时 full preflight 固定有两个 blocker；恢复成功才进入 `running` 并发送一次 GO，恢复失败保留 requested intent 和精确 blocker/blocked reason，不形成 all-ready armed_waiting。
- Produces: Operations `realBetting` readiness 只使用 allowlisted `off|armed_waiting|running|blocked|stopping` 和稳定 reason；未知字符串、本机路径或 IPC 内容被清空。

- [ ] **Step 1: 写 disk reopen 与 Operations RED 测试**

在现有 disk-backed reopen 测试中保留“旧 running 不可直接复活”，并增加无 ticket 收集后的断言：

```js
assert.equal(reopened.requested, true)
assert.equal(reopened.state, 'armed_waiting')
assert.equal(reopened.reasonCode, 'preflight-required')
assert.equal(reopened.preflight.length, 6)
const withoutTicket = collectRealBettingPreflight(reopenedHandle.db, { dbPath, now })
assert.equal(evaluateRealBettingStaticPreflight(withoutTicket).ready, true)
assert.equal(withoutTicket.fenceFresh, false)
assert.equal(withoutTicket.executorLeaseFresh, false)
assert.deepEqual(evaluateRealBettingPreflight(withoutTicket).blockingReasons, [
  'ready-ticket-required',
  'executor-ready-ticket-required',
])
```

在 `tests/crown-portable-runtime.test.mjs` 增加真实 Dashboard reopen 集成测试：先在 fixture disk DB 写入 `requested=true`，再给 `startCrownDashboard()` 注入 fake `bettingProcessControllerFactory` 和只在收到 readyTicket 后返回六项 ready 的 `realBettingPreflight`。断言事件顺序为 `initialize -> stop -> static -> start -> post-ready -> go`，`GET /api/app/real-betting-status` 为 `running`、blocker 为空、start/GO 各一次；同一 fixture 的 `requested=false` 首启必须 start=0。fake controller 不启动 child、不调用 Provider、不访问 Crown。

在 Operations 测试中明确锁定：`running -> { state:'ready', ready:true }`；`blocked/collector-failed -> { state:'blocked', ready:false, reason:'collector-failed' }`；`armed_waiting/preflight-required -> action-required`；污染 reason/path 被过滤为空且不出现在 JSON。

- [ ] **Step 2: 运行 RED/现状核对**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs tests/crown-betting-process.test.mjs tests/crown-operations-summary.test.mjs
```

Expected: pre-change 基线因 Dashboard 只 initialize、不恢复 Worker 而 FAIL；无 ticket full preflight 若错误显示 all-ready 也 FAIL。任何失败只在列出的 startup/service/DTO/repository 边界做最小修复。

- [ ] **Step 3: 实现最小恢复/投影修复**

`getRealBettingStatus(database, { initialize:true })` 对 `requested=true` 先只能写：

```js
return statusWithPreflight(
  update(db, { requested: true, state: 'armed_waiting', reasonCode: 'preflight-required' }, at(options)),
  options.checks || {},
)
```

把 `realBettingService` 改为导出的 `createRealBettingService`，POST start 和 Dashboard startup recovery 必须复用同一个 `service.start()`，不得复制第二套启动代码。`startCrownDashboard()` 只新增显式 test seam `bettingProcessControllerFactory`/`realBettingPreflight`；生产默认仍使用真实 controller/collector。读取 initialize 返回值后，在 server/tick 就绪、定时器开始前：若 `requested=true`，打开当前 canonical DB 调用一次 `createRealBettingService(appOptions, db).start()`，等待恢复完成再进入 tick；若 requested=false 不调用。

`realBettingStatusCoreDto()` 继续用固定 `STATES` 与 `REAL_BETTING_REASON_CODES` allowlist；Operations 只把 `running` 映射为 ready。`armed_waiting` 必须至少有 `ready-ticket-required` 或其他精确 blocker，不能再由 `blockingReasons=[]` 伪装为 action-ready。

- [ ] **Step 4: 运行 focused 联合回归**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-process.test.mjs tests/crown-betting-worker.test.mjs tests/crown-operations-summary.test.mjs tests/crown-portable-runtime.test.mjs
```

Expected: exit code 0，0 failed；没有真实 child、正式 SQLite 或 Crown I/O。

- [ ] **Step 5: Commit scoped restart tests（本次授权已覆盖）**

```powershell
git add scripts/crown-dashboard.mjs src/crown/app/app-api.mjs src/crown/app/real-betting-dto.mjs src/crown/app/app-repository.mjs tests/crown-real-betting-runtime.test.mjs tests/crown-betting-process.test.mjs tests/crown-operations-summary.test.mjs tests/crown-portable-runtime.test.mjs
git commit -m "test: lock crown betting restart readiness"
```

### Task 6: 统一当前 capability 文档口径

**Files:**
- Modify: `README.md:3-24`
- Modify: `README.md:150-164`
- Modify: `README.md:433-451`
- Modify: `docs/project-memory.md:3-57`
- Modify: `docs/module-index.md:3-49`
- Modify: `docs/module-index.md:163-177`
- Modify: `docs/modules/crown-betting-protocol.md:3-80`
- Modify: `docs/modules/crown-betting-protocol.md:115-124`
- Modify: `docs/betting-architecture.md:1-12`
- Modify: `docs/crown-current-architecture.md:1-30`
- Modify: `docs/crown-current-architecture.md:60-70`
- Modify: `docs/modules/crown-dashboard.md:1-25`
- Modify: `docs/github-release-runbook.md:1-20`
- Modify: `docs/github-release-runbook.md:65-90`
- Modify: `docs/windows-private-beta-quick-start.md:90-102`
- Modify: `docs/superpowers/plans/2026-07-13-crown-demo-account-auto-betting.md:13-23`
- Modify: `docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md:20-30`
- Modify: `docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md:510-535`
- Modify: `docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md:645-655`
- Modify: `docs/superpowers/plans/2026-07-14-crown-runtime-account-readiness.md:188-215`

**Interfaces:**
- Consumes: source matrix `CROWN_CAPABILITY_MATRIX_VERSION` 与 exact row `prematch/full_time/asian_handicap/main = 1/1/0`。
- Produces: README、项目记忆、模块汇总、协议模块各一处当前权威摘要；其他文档只引用这些入口或明确写“历史快照”。
- Produces: “capability 1/1/0”与“canonical Worker 线上验收未完成”同时成立；不得把 capability 开放写成阶段二 accepted 验收已完成。

- [ ] **Step 1: 写入四个权威摘要的同一事实**

四个摘要必须明确包含以下完整语义，不复制旧 `0/0/0` 当前结论：

```text
当前唯一开放 exact row：prematch/full_time/asian_handicap/main。
Preview/Submit/Reconciliation：1/1/0；其他 row 全部为 0。
1/1/0 只表示 strict Provider capability 已有证据，不表示 canonical Worker 线上验收完成。
生产 Reconciliation 仍关闭；unknown 继续人工复核，不自动解锁或重投。
```

- [ ] **Step 2: 标记历史 0/0/0，不篡改历史结果**

`docs/project-memory.md`、`docs/module-index.md` 与协议文档中旧 schema、Task 9、B1/B2、C 阶段的 `0/0/0` 保留原数值，但对应 heading 或同段第一句必须出现“历史”“当时”或“已被 Task 10 取代”。删除“本节是当前权威口径”之类与顶部 Task 10 冲突的旧说明。

- [ ] **Step 3: 修正 active plan/release checks**

Demo-account 计划顶部改为 Task 10 已完成 `1/1/0`、Task 13 canonical Worker live acceptance 未完成。Portable 发布检查不再要求矩阵等于 `0/0/0`，改为“发行物矩阵必须与源码 matrix version 和 exact row `1/1/0` 完全一致，且不得通过环境变量或打包替换扩大 row”；Portable/人工登录仍不得自行开启真实投注。

- [ ] **Step 4: 扫描当前/历史口径**

Run:

```powershell
rg -n "0/0/0|1/1/0|Preview/Submit/Reconciliation|preview/submit/reconciliation" README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md docs/betting-architecture.md docs/crown-current-architecture.md docs/modules/crown-dashboard.md docs/github-release-runbook.md docs/windows-private-beta-quick-start.md docs/superpowers/plans/2026-07-13-crown-demo-account-auto-betting.md docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md docs/superpowers/plans/2026-07-14-crown-runtime-account-readiness.md
```

Expected: 四个权威摘要当前值均为 `1/1/0`；本 Task 列出的 current/active 文档中，所有 `0/0/0` 只位于明确的历史/当时/已取代语境；active release checklist 不再断言当前必须为 `0/0/0`。未列出的已完成旧计划和旧设计保持不可改写的阶段快照，不作为当前权威入口。

- [ ] **Step 5: 检查 Markdown 和 diff**

Run:

```powershell
git diff --check -- README.md docs
git diff -- README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md docs/betting-architecture.md docs/crown-current-architecture.md docs/modules/crown-dashboard.md docs/github-release-runbook.md docs/windows-private-beta-quick-start.md docs/superpowers/plans/2026-07-13-crown-demo-account-auto-betting.md docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md docs/superpowers/plans/2026-07-14-crown-runtime-account-readiness.md
```

Expected: `git diff --check` exit code 0；diff 只修正当前/历史能力口径和 Gate A 验证事实，不改变协议字段、真实授权、金额或发布范围。

- [ ] **Step 6: Commit scoped documentation change（本次授权已覆盖）**

```powershell
git add README.md docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md docs/betting-architecture.md docs/crown-current-architecture.md docs/modules/crown-dashboard.md docs/github-release-runbook.md docs/windows-private-beta-quick-start.md docs/superpowers/plans/2026-07-13-crown-demo-account-auto-betting.md docs/superpowers/plans/2026-07-13-crown-windows-portable-release-and-update.md docs/superpowers/plans/2026-07-14-crown-runtime-account-readiness.md
git commit -m "docs: align crown betting capability status"
```

### Task 7: 生成 Gate A 机器可读 safe evidence

**Files:**
- Create: `scripts/crown-betting-production-readiness-audit.mjs`
- Create: `scripts/crown-loopback-network-guard.mjs`
- Create: `tests/crown-betting-production-readiness-audit.test.mjs`
- Create: `tests/crown-loopback-network-guard.test.mjs`
- Modify: `package.json:4-22`
- Create (generated): `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json`

**Interfaces:**
- Consumes: 四条串行命令的 exit code/TAP summary、loopback-only network guard 的实际审计日志、source commit/tree、`CROWN_CAPABILITY_MATRIX_VERSION`、`listCrownCapabilities()` 与 Task 1-5 的 runtime focused tests。
- Produces: `npm run crown:betting:production-readiness-audit`；全部 gate 成功时原子写固定路径 safe JSON，任一命令失败或 capability 不是 exact `1/1/0` 时 exit 1 且不覆盖旧 evidence。
- Produces evidence fields: `tests`、`build`、`capability`、`runtime`、`source`、`network` 与派生 `offlineNetwork:true`；`network` 必须来自 guard 实际计数，固定包含 `mode:'loopback-only'`、`guardLoaded:true`、`externalRequests:0`、`previewRequests:0`、`submitRequests:0`、`reconciliationRequests:0`。禁止 stdout/stderr、环境变量、路径、账号或原始响应进入 JSON。

- [ ] **Step 1: 写 evidence builder/失败不落盘 RED 测试**

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildProductionReadinessEvidence,
  writeSafeEvidence,
} from '../scripts/crown-betting-production-readiness-audit.mjs'

test('readiness audit writes only bounded safe evidence after every gate passes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-readiness-audit-'))
  const output = path.join(root, 'readiness.safe.json')
  const commandResults = {
    backend: { passed: true, total: 1400, failed: 0 },
    syntax: { passed: true, files: 240 },
    frontend: { passed: true, total: 140, failed: 0 },
    frontendBuild: { passed: true },
  }
  const evidence = buildProductionReadinessEvidence({
    generatedAt: '2026-07-14T12:00:00.000Z',
    commandResults,
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true },
    networkAudit: {
      mode: 'loopback-only', guardLoaded: true, externalRequests: 0, previewRequests: 0,
      submitRequests: 0, reconciliationRequests: 0,
    },
    matrixVersion: 'crown-protocol-capabilities-v2:0123456789abcdef',
    capabilityRows: [{
      mode: 'prematch', period: 'full_time', marketType: 'asian_handicap', lineVariant: 'main',
      previewAllowed: true, submitAllowed: true, reconciliationAllowed: false,
    }],
  })
  writeSafeEvidence(output, evidence)
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(parsed.offlineNetwork, true)
  assert.deepEqual(parsed.network, {
    mode: 'loopback-only', guardLoaded: true, externalRequests: 0, previewRequests: 0,
    submitRequests: 0, reconciliationRequests: 0,
  })
  assert.deepEqual(parsed.source, { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true })
  assert.deepEqual(parsed.capability.counts, { preview: 1, submit: 1, reconciliation: 0 })
  assert.equal(parsed.runtime.fullPreflightCount, 6)
  assert.doesNotMatch(JSON.stringify(parsed), /password|cookie|token|authorization|stdout|stderr|[A-Z]:\\/i)
})

test('readiness audit does not overwrite evidence when a gate fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-readiness-audit-fail-'))
  const output = path.join(root, 'readiness.safe.json')
  fs.writeFileSync(output, '{"preserved":true}\n', 'utf8')
  assert.throws(() => buildProductionReadinessEvidence({
    generatedAt: '2026-07-14T12:00:00.000Z',
    commandResults: {
      backend: { passed: false, total: 1400, failed: 1 },
      syntax: { passed: true, files: 240 },
      frontend: { passed: true, total: 140, failed: 0 },
      frontendBuild: { passed: true },
    },
    matrixVersion: 'crown-protocol-capabilities-v2:0123456789abcdef',
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40), clean: true },
    networkAudit: { mode: 'loopback-only', guardLoaded: true, externalRequests: 0, previewRequests: 0, submitRequests: 0, reconciliationRequests: 0 },
    capabilityRows: [],
  }), /production-readiness-gate-failed/)
  assert.equal(fs.readFileSync(output, 'utf8'), '{"preserved":true}\n')
})
```

- [ ] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-betting-production-readiness-audit.test.mjs
```

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现并验证 loopback-only network guard**

`scripts/crown-loopback-network-guard.mjs` 只在 `CROWN_NETWORK_AUDIT_FILE` 存在时启用，通过 `NODE_OPTIONS` 的 `--import=$GUARD_IMPORT` 注入 audit 启动的所有 Node/npm child，其中 `$GUARD_IMPORT` 是脚本绝对路径转换得到的 file URL。加载时先追加 `{kind:'guard-ready'}`；它必须允许 `127.0.0.0/8`、`::1`、`localhost` 和本地文件，拦截 `fetch` 以及 `http/https/net/tls` 的非 loopback 连接；拦截前只向 private JSONL 追加 `{kind:'external'|'preview'|'submit'|'reconciliation'}`，不得记录 URL、host、header、body、账号或路径，然后抛稳定 `crown-offline-network-blocked`。

`tests/crown-loopback-network-guard.test.mjs` 用本机临时 HTTP server 证明 loopback PASS，并在隔离 child 中证明 `https://example.com`、包含 `FT_order_view` 的 Preview、包含 `FT_bet` 的 Submit 和 reconciliation probe 都在真正连接前被阻断且分别计数；guard 未启用时不改变普通测试环境。只有 audit 日志四类计数全部为 0 才能生成 Gate A evidence。

- [ ] **Step 4: 实现 bounded evidence builder 与原子写入**

脚本使用以下完整结构；`capabilityRows` 必须恰好只有 exact main row 同时开启 Preview/Submit，Reconciliation 为 false，其他 row 不得有任一开启值：

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CROWN_CAPABILITY_MATRIX_VERSION,
  listCrownCapabilities,
} from '../src/crown/betting/crown-capability-matrix.mjs'

const OUTPUT = path.resolve('.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json')
const NETWORK_AUDIT = path.resolve('.superpowers/sdd/evidence/crown-betting-production-readiness.network.jsonl')
const GUARD_IMPORT = pathToFileURL(path.resolve('scripts/crown-loopback-network-guard.mjs')).href

function gitText(args) {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
  if (result.status !== 0) throw new Error('production-readiness-git-failed')
  return String(result.stdout || '').trim()
}

function readCleanSourceIdentity() {
  if (gitText(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('production-readiness-source-dirty')
  return { commit: gitText(['rev-parse', 'HEAD']), tree: gitText(['rev-parse', 'HEAD^{tree}']), clean: true }
}

function readNetworkAudit() {
  const rows = fs.existsSync(NETWORK_AUDIT)
    ? fs.readFileSync(NETWORK_AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : []
  const count = (kind) => rows.filter((row) => row?.kind === kind).length
  return {
    mode: 'loopback-only',
    guardLoaded: count('guard-ready') >= 4,
    externalRequests: count('external'),
    previewRequests: count('preview'),
    submitRequests: count('submit'),
    reconciliationRequests: count('reconciliation'),
  }
}

function requiredCount(text, expression, label) {
  const match = text.match(expression)
  const value = Number(match?.[1])
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`production-readiness-${label}-summary`)
  return value
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('production-readiness-npm-cli')
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CROWN_BETTING_MODE: 'off',
      CROWN_NETWORK_AUDIT_FILE: NETWORK_AUDIT,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${GUARD_IMPORT}`.trim(),
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('production-readiness-command-failed')
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function collectCommandResults() {
  const backend = runNpm(['test'])
  const syntax = runNpm(['run', 'check'])
  const frontend = runNpm(['--prefix', 'frontend', 'run', 'test'])
  runNpm(['--prefix', 'frontend', 'run', 'build'])
  return {
    backend: {
      passed: true,
      total: requiredCount(backend, /# tests\s+(\d+)/, 'backend-tests'),
      failed: requiredCount(backend, /# fail\s+(\d+)/, 'backend-failures'),
    },
    syntax: {
      passed: true,
      files: requiredCount(syntax, /Syntax OK:\s+(\d+)\s+\.mjs files/, 'syntax-files'),
    },
    frontend: {
      passed: true,
      total: requiredCount(frontend, /Tests\s+(\d+)\s+passed/, 'frontend-tests'),
      failed: 0,
    },
    frontendBuild: { passed: true },
  }
}

export function buildProductionReadinessEvidence({ generatedAt, commandResults, source, networkAudit, matrixVersion, capabilityRows }) {
  const commandsReady = commandResults?.backend?.passed === true
    && commandResults.backend.failed === 0
    && commandResults?.syntax?.passed === true
    && commandResults?.frontend?.passed === true
    && commandResults.frontend.failed === 0
    && commandResults?.frontendBuild?.passed === true
  const enabled = capabilityRows.filter((row) => row.previewAllowed || row.submitAllowed || row.reconciliationAllowed)
  const exact = enabled.length === 1 && enabled[0].mode === 'prematch'
    && enabled[0].period === 'full_time'
    && enabled[0].marketType === 'asian_handicap'
    && enabled[0].lineVariant === 'main'
    && enabled[0].previewAllowed === true
    && enabled[0].submitAllowed === true
    && enabled[0].reconciliationAllowed === false
  const sourceReady = source?.clean === true && /^[a-f0-9]{40}$/.test(source?.commit || '') && /^[a-f0-9]{40}$/.test(source?.tree || '')
  const networkReady = networkAudit?.mode === 'loopback-only' && networkAudit?.guardLoaded === true
    && ['externalRequests', 'previewRequests', 'submitRequests', 'reconciliationRequests']
      .every((key) => networkAudit[key] === 0)
  if (!commandsReady || !sourceReady || !networkReady || !exact || !/^crown-protocol-capabilities-v2:[a-f0-9]+$/.test(matrixVersion)) {
    throw new Error('production-readiness-gate-failed')
  }
  return {
    schemaVersion: 1,
    kind: 'crown-betting-production-readiness',
    generatedAt: new Date(generatedAt).toISOString(),
    tests: {
      backend: commandResults.backend,
      syntax: commandResults.syntax,
      frontend: commandResults.frontend,
    },
    build: { frontend: commandResults.frontendBuild },
    capability: {
      matrixVersion,
      row: 'prematch/full_time/asian_handicap/main',
      counts: { preview: 1, submit: 1, reconciliation: 0 },
      otherEnabledRows: 0,
    },
    runtime: {
      startup: 'static-preflight-readyTicket-post-ready-GO',
      staticPreflightCount: 4,
      fullPreflightCount: 6,
      persistedRequestedRestartState: 'armed_waiting',
      startupRecovery: 'same-two-phase-service',
      noTicketBlockingReasons: 2,
      missingReadyTicket: 'blocked',
      postReadyFailure: 'armed_waiting',
      goFailure: 'blocked',
    },
    source,
    network: networkAudit,
    offlineNetwork: true,
  }
}

export function writeSafeEvidence(output, evidence) {
  const target = path.resolve(output)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, target)
}

function main() {
  fs.mkdirSync(path.dirname(NETWORK_AUDIT), { recursive: true })
  fs.rmSync(NETWORK_AUDIT, { force: true })
  const source = readCleanSourceIdentity()
  const commandResults = collectCommandResults()
  const evidence = buildProductionReadinessEvidence({
    generatedAt: new Date().toISOString(),
    commandResults,
    source,
    networkAudit: readNetworkAudit(),
    matrixVersion: CROWN_CAPABILITY_MATRIX_VERSION,
    capabilityRows: listCrownCapabilities(),
  })
  writeSafeEvidence(OUTPUT, evidence)
  process.stdout.write(`${evidence.kind} ${evidence.capability.matrixVersion}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch {
    process.stderr.write('production-readiness-gate-failed\n')
    process.exitCode = 1
  }
}
```

CLI 通过当前 npm 注入的 `npm_execpath` 串行执行四条命令；为每个 child 传入同一个 private `CROWN_NETWORK_AUDIT_FILE` 与 absolute guard `NODE_OPTIONS --import`，并在全部命令结束后从 JSONL 实际聚合四类计数。`readCleanSourceIdentity()` 用 `git status --porcelain`、`git rev-parse HEAD` 和 `git rev-parse HEAD^{tree}` 取得 clean source 身份；dirty 时失败。只解析 `# tests/# fail`、`Syntax OK: N .mjs files` 和 Vitest `Tests N passed`，不把命令输出写入 evidence。失败时只输出稳定错误码 `production-readiness-gate-failed`。

- [ ] **Step 5: 添加 npm script**

```json
"crown:betting:production-readiness-audit": "node scripts/crown-betting-production-readiness-audit.mjs"
```

- [ ] **Step 6: 运行 GREEN**

Run:

```powershell
node --test --test-concurrency=1 tests/crown-loopback-network-guard.test.mjs tests/crown-betting-production-readiness-audit.test.mjs
node --check scripts/crown-betting-production-readiness-audit.mjs
```

Expected: 两条命令 exit code 0；测试只在 temp 目录写 fake evidence，不运行嵌套全量测试。

- [ ] **Step 7: Commit（本次最终 GitHub 发布已获授权）**

```powershell
git add scripts/crown-loopback-network-guard.mjs scripts/crown-betting-production-readiness-audit.mjs tests/crown-loopback-network-guard.test.mjs tests/crown-betting-production-readiness-audit.test.mjs package.json
git commit -m "test: add crown betting readiness evidence"
```

### Task 8: 串行执行 Gate A 并记录结果

**Files:**
- Generate: `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json`
- Modify: `docs/project-memory.md:3-18`
- Modify: `docs/module-index.md:3-15`
- Modify: `docs/modules/crown-betting-protocol.md:3-8`

**Interfaces:**
- Consumes: Task 1-7 全部 GREEN 和 audit CLI。
- Produces: 阶段二可机器校验的固定 safe evidence；三份项目文档只记录本轮真实命令结果与 evidence 相对路径。

- [ ] **Step 1: 先运行 focused gate**

```powershell
node --test --test-concurrency=1 tests/crown-real-betting-runtime.test.mjs tests/crown-app-api.test.mjs tests/crown-betting-process.test.mjs tests/crown-betting-worker.test.mjs tests/crown-operations-summary.test.mjs tests/crown-portable-runtime.test.mjs tests/crown-loopback-network-guard.test.mjs tests/crown-betting-production-readiness-audit.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'gate-a-focused-tests-failed' }
```

Expected: exit code 0，0 failed；没有启动真实 Worker，没有 `FT_order_view` 或 `FT_bet`。

- [ ] **Step 2: 在 clean worktree 运行预审计**

```powershell
$ControlRoot = (Get-Location).Path
$GateAPreWorktree = Join-Path $env:TEMP 'crown-betting-gate-a-preliminary'
if (Test-Path -LiteralPath $GateAPreWorktree) { throw 'gate-a-preliminary-worktree-path-must-be-absent' }
$GateAPreCommit = git rev-parse HEAD
git worktree add --detach $GateAPreWorktree $GateAPreCommit
if ($LASTEXITCODE -ne 0) { throw 'gate-a-preliminary-worktree-create-failed' }
npm --prefix $GateAPreWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'gate-a-preliminary-backend-install-failed' }
npm --prefix (Join-Path $GateAPreWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'gate-a-preliminary-frontend-install-failed' }
Push-Location -LiteralPath $GateAPreWorktree
try {
  npm run crown:betting:production-readiness-audit
  if ($LASTEXITCODE -ne 0) { throw 'gate-a-preliminary-audit-failed' }
} finally {
  Pop-Location
}
```

Expected: audit 内部依次完成 backend、syntax、frontend test、frontend build，全部运行在 loopback-only guard 下；clean source、四类网络计数 0 后才在 preliminary worktree 生成 evidence。任一步失败则 CLI exit 1 且不生成新 evidence。

- [ ] **Step 3: 校验 safe evidence 内容**

```powershell
$GateAPreEvidence = Join-Path $GateAPreWorktree '.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json'
node -e "const fs=require('node:fs');const e=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(e.offlineNetwork!==true||e.network?.guardLoaded!==true||e.network.externalRequests!==0||e.network.previewRequests!==0||e.network.submitRequests!==0||e.network.reconciliationRequests!==0||e.source?.clean!==true||e.tests.backend.failed!==0||e.tests.frontend.failed!==0||e.build.frontend.passed!==true||e.capability.counts.preview!==1||e.capability.counts.submit!==1||e.capability.counts.reconciliation!==0||e.runtime.fullPreflightCount!==6||e.runtime.noTicketBlockingReasons!==2)process.exit(1);console.log(e.kind,e.capability.matrixVersion)" $GateAPreEvidence
if ($LASTEXITCODE -ne 0) { throw 'gate-a-preliminary-evidence-invalid' }
```

Expected: exit code 0，stdout 只含 `crown-betting-production-readiness` 和 matrix version；JSON 不含 stdout/stderr、绝对路径、账号、session 或秘密。

- [ ] **Step 4: 运行最终静态检查**

```powershell
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'gate-a-diff-check-failed' }
```

Expected: `git diff --check` exit code 0；逐项核对计划与 safe evidence，所有字段、命令、路径、状态和停止条件均已明确。

- [ ] **Step 5: 写入本轮验证事实**

在项目记忆、模块汇总和协议模块顶部写入 preliminary evidence 的 backend/frontend/syntax 计数、build 结果、matrix version、Dashboard persisted-intent 两阶段恢复结论和最终 evidence 相对路径。必须同时写明 `network.guardLoaded=true`、external/Preview/Submit/Reconciliation 请求计数均为 0、real Worker 启动=0；不得复制测试 stdout 或机器绝对路径。

- [ ] **Step 6: Gate A 预判**

先核对 focused 0 failed、preliminary audit exit 0、safe evidence schema/字段、current capability `1/1/0`、旧 `0/0/0` 历史口径和文档内容。此时只能判定“可提交文档”，不能宣布 Gate A 完成；最终结论必须等 Step 8 在最后 commit 上重新生成 evidence。

- [ ] **Step 7: Commit 阶段一最终文档（本次最终 GitHub 发布已获授权）**

```powershell
git add docs/project-memory.md docs/module-index.md docs/modules/crown-betting-protocol.md
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'gate-a-docs-diff-check-failed' }
git commit -m "docs: record crown betting production readiness"
if ($LASTEXITCODE -ne 0) { throw 'gate-a-docs-commit-failed' }
```

Expected: Git 只记录脱敏后的验证摘要和 evidence 相对路径；不使用 `git add -f` 提交 ignored evidence。

- [ ] **Step 8: 在最终 commit 上重新生成并固定 Gate A evidence**

```powershell
$ControlRoot = (Get-Location).Path
$GateAFinalCommit = git rev-parse HEAD
$GateAFinalTree = git rev-parse 'HEAD^{tree}'
$GateAFinalWorktree = Join-Path $env:TEMP 'crown-betting-gate-a-final'
if (Test-Path -LiteralPath $GateAFinalWorktree) { throw 'gate-a-final-worktree-path-must-be-absent' }
git worktree add --detach $GateAFinalWorktree $GateAFinalCommit
if ($LASTEXITCODE -ne 0) { throw 'gate-a-final-worktree-create-failed' }
npm --prefix $GateAFinalWorktree ci
if ($LASTEXITCODE -ne 0) { throw 'gate-a-final-backend-install-failed' }
npm --prefix (Join-Path $GateAFinalWorktree 'frontend') ci
if ($LASTEXITCODE -ne 0) { throw 'gate-a-final-frontend-install-failed' }
Push-Location -LiteralPath $GateAFinalWorktree
try {
  npm run crown:betting:production-readiness-audit
  if ($LASTEXITCODE -ne 0) { throw 'gate-a-final-audit-failed' }
} finally {
  Pop-Location
}
$GateAFinalEvidence = Join-Path $GateAFinalWorktree '.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json'
$FixedEvidence = Join-Path $ControlRoot '.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json'
$Evidence = Get-Content -Raw -LiteralPath $GateAFinalEvidence -Encoding utf8 | ConvertFrom-Json
if ($Evidence.source.commit -ne $GateAFinalCommit -or $Evidence.source.tree -ne $GateAFinalTree -or -not $Evidence.source.clean -or -not $Evidence.network.guardLoaded -or $Evidence.network.externalRequests -ne 0 -or $Evidence.network.previewRequests -ne 0 -or $Evidence.network.submitRequests -ne 0 -or $Evidence.network.reconciliationRequests -ne 0) { throw 'gate-a-final-evidence-invalid' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $FixedEvidence) | Out-Null
Copy-Item -LiteralPath $GateAFinalEvidence -Destination $FixedEvidence
```

Expected: fixed evidence 的 `generatedAt` 晚于最终阶段一 commit，`source.commit/tree` 精确匹配该 commit，tests/build 全绿，capability `1/1/0`，Dashboard restart recovery 使用同一两阶段 service，四类真实网络计数均为 0。只有此时 Gate A 完成，standing Submit authorization 才生效；任一条件失败都不得进入阶段二。

## Gate A Handoff

阶段二只能读取并验证 `.superpowers/sdd/evidence/crown-betting-production-readiness.safe.json`，不得用聊天结论、旧测试报告或人工口头确认替代。证据必须显示 source commit/tree 与阶段一最终 commit 一致、network guard 已加载且 external/Preview/Submit/Reconciliation 全为 0、tests/build 全绿、capability exact `1/1/0`、无 ticket 两个 blocker 和 persisted-intent 两阶段恢复 contract；此后 standing Submit authorization 才按阶段二计划的 exact row、金额、停止条件和账本审计边界生效。
