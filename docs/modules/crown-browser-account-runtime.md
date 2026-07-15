# Crown 浏览器账号 Runtime

## 目标

生产投注账号使用各自独立的 persistent Chromium profile，在页面上下文内调用 Crown API。该模块只负责浏览器会话、传输和所有权；盘口选择、金额授权、B2 账本与 exactly-once 仍由现有投注链负责。

## 入口

- `src/crown/login/crown-browser-api-client.mjs`：在当前页面内执行固定的 login、game list、余额、Preview 和 Submit 请求。
- `src/crown/betting/crown-browser-account-runtime.mjs`：按账号串行化请求，绑定账号、origin、context generation 与 executor/profile fences。
- `src/crown/runtime/browser-profile-lease.mjs`：用 canonical database path 与 account ID 唯一标识 profile lease。
- `src/crown/login/portable-chromium.mjs`：固定可见窗口、禁用下载和 Service Worker，不接受任意 launch options。

## 固定边界

- 一个投注账号同时只允许一个 context；不同账号的 profile、Cookie jar、generation 和 lease 相互隔离。
- 每次新 context 都重新取得本进程 login response 的 UID/version 证明并验证 game list；不会从文件导入 Cookie 或 `storageState`。
- Preview/Submit 只允许 capability library 给出的相对 endpoint 与字段；页面 origin、`document.baseURI`、redirect、popup、download、crash 和跨 origin navigation 均 fail-closed。
- Submit 在浏览器 fetch 前调用一次 B2 `beforeDispatch`；回调前后都重新检查 executor fence、profile fence 和 context generation。
- context 未确认关闭时不释放 profile lease，也不允许创建 replacement context、执行 runtime cleanup 或启动 Betting Worker。
- 人工登录与 Betting Worker 使用同一 profile ownership 门禁；两者不能并行占用浏览器 profile。

## 当前阶段状态

Task 5 已建立 Browser client、账号 runtime、profile lease、人工登录互斥和 cleanup 关闭边界。Task 6 已把生产 Preview、单次 Submit 与只读 Reconciliation 切换到该 Browser transport，并补齐 worker crash、ownership TTL、standalone reconciliation 与 final shutdown 生命周期。Task 7 尚未开始。

## 验证

主要测试：

- `tests/crown-browser-api-client.test.mjs`
- `tests/crown-browser-account-runtime.test.mjs`
- `tests/crown-browser-profile-lease.test.mjs`
- `tests/crown-portable-chromium.test.mjs`
- `tests/crown-manual-login-bridge.test.mjs`
- `tests/crown-human-login-controller.test.mjs`
- `tests/crown-runtime-cache-cleanup.test.mjs`

所有测试默认离线，不访问 Crown，也不会发送 Preview 或 Submit。
