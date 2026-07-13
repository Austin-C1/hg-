# Dashboard 默认本机免密设计

日期：2026-07-11

## 目标

程序交付给任何用户后，默认不需要创建或输入 Dashboard 密码。用户启动程序并打开 `http://127.0.0.1:8787` 后即可保存配置、启停 watcher、检测投注账号。

默认免密不等于开放局域网访问。Dashboard 继续只绑定 `127.0.0.1`，其他电脑或手机不能通过局域网 IP 访问。

## 采用方案

使用“本机可信 + CSRF”模式，而不是删除全部安全检查：

- 未配置 Dashboard 密码时，只接受来自 loopback 地址且 Host 为 `127.0.0.1`、`localhost` 或 `::1` 的访问。
- 页面首次读取 bootstrap 时获得进程内随机 CSRF token；所有写请求仍必须携带相同 token 和同源 Origin。
- 跨站 Origin、伪造 Host、非 loopback 客户端、缺失或错误 CSRF token 都拒绝。
- Dashboard 仍默认监听 `127.0.0.1`，不修改 Windows 防火墙，不自动开放局域网端口。
- 如果高级用户显式配置 Dashboard 密码，则现有密码、Session cookie、过期和限速机制优先，关闭本机免密捷径。
- 如果显式配置非本机 Host/Origin，则必须同时配置密码安全参数；不能以免密模式开放远程访问。

## 前端行为

- 默认启动后 bootstrap 直接返回 CSRF token，页面立即具有写权限。
- 顶部状态显示 `Dashboard 本机免密`，不显示登录按钮。
- 密码模式继续显示 `Dashboard 未登录/已登录` 和登录弹窗。
- 规则保存、监控 Switch、投注账号检测沿用现有 API，不增加前端绕过逻辑。

## 投注账号检测

- 手动检测仍只执行 fresh login、`get_game_list` 和 `get_member_data`，禁止调用 `FT_order_view`、`FT_bet`。
- 用户在账号配置中保存的 public HTTPS exact origin，可作为该账号“手动只读检测”的唯一目标；仍拒绝 localhost、私网、IP literal、带 credentials/path/query/hash 的地址和 redirect。
- `CROWN_BETTING_ALLOWED_ORIGINS` 非空时继续作为更严格覆盖；生产 preview/submit Provider 的 allowlist/capability 门禁不变，不能因本机免密而获得真实执行能力。
- Crown 返回余额/额度仍只写 `reported_balance`，不会写 B1 执行余额 `balance_minor`。

## 后端改动边界

- `static-server.mjs` 增加进程内本机可信 CSRF 上下文，并把 access mode 投影给 bootstrap。
- `app-api.mjs` 和登录管理器仅为手动只读账号检测增加“账号已保存 exact origin”规则；真实投注执行路径保持原安全门禁。
- 不修改 watcher 单实例 lease，不启动 betting worker，不修改真实投注授权和 capability matrix。

## 错误处理

- 本机可信条件不满足：返回 `authentication-required` 或现有 Host/Origin 拒绝错误。
- CSRF 缺失或错误：返回 `csrf-invalid`。
- 用户尝试远程免密访问：在路由前返回 `remote-not-allowed`。
- 账号检测地址不安全或访问失败：记录稳定脱敏错误码，不返回密码、cookie、session 或 Crown 原始响应。

## 验收标准

1. 无 `.env`、无 Dashboard 密码时，本机打开页面直接显示可操作状态。
2. 投注规则能够保存并刷新后保留。
3. 赛前监控 Switch 能关闭并保持关闭，再开启后保持开启；单 watcher 约束不变。
4. 投注账号检测可使用账号已保存的 public HTTPS exact origin，页面显示登录访问状态和 Crown 返回余额/额度。
5. 跨站 Origin、错误 CSRF、远程客户端伪造 localhost Host 全部拒绝。
6. 配置密码后，未登录写请求仍拒绝，现有 Session/CSRF 测试保持通过。
7. watcher 保持运行，betting worker 保持关闭；账号检测请求中不存在 preview/submit。
8. 后端、前端、语法检查和生产构建全部通过。

## 非目标

- 不开放局域网或公网访问。
- 不移除真实投注的授权、预算、capability、allowlist 或 fail-closed 门禁。
- 不自动检测全部投注账号；检测只由用户手动触发。
- 不把 Crown 展示余额自动转成执行余额。
