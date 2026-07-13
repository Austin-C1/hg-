# GitHub Release Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让项目可以安全上传 GitHub，并让别人下载后能在自己的机器上安装、配置、运行，不依赖本机账号、路径、session、SQLite、浏览器 profile 或私有配置。

**Architecture:** 先建立“可分发边界”和自动扫描，再把运行态路径、Crown 域名、浏览器 profile、runtime、SQLite、secret、端口和业务默认配置集中到 env/config/example。Docker 保留为 Dashboard-only，完整 watcher/probe/capture 先走 Windows PowerShell 本机一键安装与启动。

**Tech Stack:** Node.js ESM、`node:test`、PowerShell、Docker Compose、React 18、Vite、Ant Design、SQLite `node:sqlite`。

---

## 当前结论

当前代码测试通过，但当前目录不能直接上传 GitHub。必须先清理和隔离这些本机运行态：

| 类型 | 当前路径 | GitHub 策略 |
|---|---|---|
| Telegram 私有配置 | `config/telegram-settings.json` | 不上传，只保留 `config/telegram-settings.example.json` |
| SQLite 与本地密钥 | `storage/` | 不上传，默认迁移到用户数据目录 |
| Crown session | `data/runtime/crown-sessions/` | 不上传，运行时自动生成 |
| 登录诊断 | `data/runtime/login-diagnostics/` | 不上传，默认脱敏 |
| 浏览器 profile | `data/crown-profile/` | 不上传，默认迁移到用户数据目录 |
| private 抓包 | `data/runtime/**/private/`、`data/crown-probe/` | 不上传，只允许 public redacted 或 fixture summary |
| 前端构建产物 | `frontend/dist/` | 不上传，由安装脚本构建 |

## 完成标准

- `npm run release:check` 能阻止私有文件、绝对路径、真实 token/session/private capture 混入上传包。
- 默认运行路径不再写入项目目录下的 `storage/`、`data/runtime/`、`data/crown-profile/`。
- 新用户按 README 只需执行 `powershell -ExecutionPolicy Bypass -File .\install.ps1` 和 `.\start-dashboard.ps1` 就能打开 Dashboard。
- watcher/probe/capture 运行前必须显式配置 Crown URL，不能默认打到本机历史域名。
- Docker 文档明确写为 Dashboard-only，不承诺完整 watcher/probe/capture。
- 全部验证命令通过：`npm test`、`npm run check`、`npm run release:check`、`npm --prefix frontend run test`、`npm --prefix frontend run build`。

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `.node-version` | Create | 固定推荐 Node 版本，方便新机器切换 |
| `.env.example` | Modify | 增加 Crown URL、runtime/profile/storage/env 示例 |
| `package.json` | Modify | 增加 release safety 和一键检查命令 |
| `scripts/check-release-safety.mjs` | Create | 扫描上传前禁止出现的私有文件和硬编码风险 |
| `tests/release-safety.test.mjs` | Create | 验证 release scanner 能识别风险并允许示例文件 |
| `src/crown/runtime/runtime-paths.mjs` | Create | 集中计算用户数据目录、runtime、profile、SQLite、secret 路径 |
| `tests/crown-runtime-paths.test.mjs` | Create | 验证路径不默认落在项目私有运行目录 |
| `scripts/crown-watch.mjs` | Modify | 读取 `CROWN_BASE_URL`、`CROWN_PROFILE_DIR`、`CROWN_RUNTIME_DIR`、`CROWN_DB_PATH` |
| `scripts/crown-probe.mjs` | Modify | 移除默认真实 Crown 域名，改成 env 或参数必填 |
| `scripts/crown-betting-protocol-capture.mjs` | Modify | 移除默认真实 Crown 域名，改成 env 或参数必填 |
| `src/crown/app/app-db.mjs` | Modify | 默认 SQLite 路径改为 runtime path helper |
| `src/crown/app/app-secret.mjs` | Modify | 默认 secret key 路径改为 runtime path helper |
| `src/crown/config/default-leagues.mjs` | Modify | 默认联赛配置从 example config 读取 |
| `src/crown/monitor/monitor-settings.mjs` | Modify | 默认监控阈值从 example config 读取 |
| `src/crown/filters/blacklist.mjs` | Modify | 黑名单从配置读取，代码只保留兜底 |
| `config/*.example.json` | Modify/Create | 放可复用默认配置，不放本机真实配置 |
| `install.ps1` | Create | 一键安装依赖、构建前端、检查环境 |
| `start-dashboard.ps1` | Create | 本机启动 Dashboard |
| `start-monitor.ps1` | Create | 本机启动 watcher，并检查 Crown URL |
| `docker-compose.yml` | Modify | 端口改为 env，可配置 Dashboard-only |
| `Dockerfile` | Modify | 只复制 example/public 配置，不复制私有配置 |
| `README.md` | Modify | 改成 GitHub 下载后的安装、配置、运行说明 |
| `docs/github-release-checklist.md` | Create | 上传 GitHub 前人工检查清单 |

---

### Task 1: Release Safety Scanner

**Files:**
- Create: `scripts/check-release-safety.mjs`
- Create: `tests/release-safety.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing scanner tests**

Create `tests/release-safety.test.mjs`:

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanReleaseSafety } from '../scripts/check-release-safety.mjs'

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-release-safety-'))
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
  return root
}

test('release scanner blocks private runtime and secret files', () => {
  const root = makeFixture({
    'config/telegram-settings.json': '{"oddsAlert":{"botToken":"123456:secret"}}',
    'storage/crown-local-secret.key': 'local-key',
    'data/runtime/crown-sessions/mon_primary/api-session.json': '{"uid":"secret","cookies":{"sid":"x"}}',
    'data/runtime/betting-protocol-captures/run/private/raw-network.jsonl': '{"headers":{"cookie":"sid=x"}}',
  })

  const result = scanReleaseSafety({ root })

  assert.equal(result.ok, false)
  assert.match(result.issues.map((issue) => issue.file).join('\n'), /config\/telegram-settings\.json/)
  assert.match(result.issues.map((issue) => issue.file).join('\n'), /storage\/crown-local-secret\.key/)
  assert.match(result.issues.map((issue) => issue.file).join('\n'), /api-session\.json/)
  assert.match(result.issues.map((issue) => issue.file).join('\n'), /raw-network\.jsonl/)
})

test('release scanner allows example config and source files', () => {
  const root = makeFixture({
    'config/telegram-settings.example.json': '{"oddsAlert":{"botToken":""}}',
    'src/example.mjs': "export const value = 'CROWN_BASE_URL'\n",
    'README.md': 'Use config/telegram-settings.example.json for setup.\n',
  })

  const result = scanReleaseSafety({ root })

  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
})
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
node --test tests\release-safety.test.mjs
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Create the scanner**

Create `scripts/check-release-safety.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BLOCKED_PATH_PATTERNS = [
  /^config\/telegram-settings\.json$/,
  /^storage\//,
  /^data\/crown-profile\//,
  /^data\/crown-probe\//,
  /^data\/crown-probe-smoke\//,
  /^data\/runtime\/crown-sessions\//,
  /^data\/runtime\/login-diagnostics\//,
  /^data\/runtime\/.*\/private\//,
  /^data\/runtime\/betting-protocol-captures\/.*\/private\//,
  /^frontend\/dist\//,
  /^node_modules\//,
  /^frontend\/node_modules\//,
]

const SECRET_TEXT_PATTERNS = [
  /"botToken"\s*:\s*"[0-9]{6,}:[^"]+"/i,
  /"uid"\s*:\s*"[^"]{4,}"/i,
  /"cookie"\s*:/i,
  /"set-cookie"\s*:/i,
  /"authorization"\s*:/i,
  /access_token/i,
  /C:\\\\Users\\\\/i,
]

function toPosix(file) {
  return file.split(path.sep).join('/')
}

function walk(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    const rel = toPosix(path.relative(root, full))
    if (entry.isDirectory()) {
      if (['.git'].includes(entry.name)) continue
      walk(root, full, files)
    } else {
      files.push(rel)
    }
  }
  return files
}

function shouldReadText(file) {
  return /\.(json|jsonl|mjs|js|ts|tsx|md|yml|yaml|env|example|ps1|txt)$/i.test(file)
}

export function scanReleaseSafety({ root = process.cwd() } = {}) {
  const issues = []
  const files = walk(root)

  for (const file of files) {
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(file)) {
        issues.push({ severity: 'error', file, reason: 'blocked-release-path' })
        break
      }
    }

    if (!shouldReadText(file)) continue
    const full = path.join(root, file)
    const content = fs.readFileSync(full, 'utf8')
    for (const pattern of SECRET_TEXT_PATTERNS) {
      if (pattern.test(content) && !file.endsWith('.example.json')) {
        issues.push({ severity: 'error', file, reason: `blocked-content:${pattern.source}` })
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

function main() {
  const result = scanReleaseSafety()
  if (result.ok) {
    console.log('Release safety OK')
    return
  }
  console.error('Release safety failed:')
  for (const issue of result.issues) {
    console.error(`- ${issue.severity}: ${issue.file} ${issue.reason}`)
  }
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
```

- [ ] **Step 4: Add package scripts**

Modify `package.json` scripts:

```json
{
  "release:check": "node scripts/check-release-safety.mjs",
  "verify": "npm test && npm run check && npm run release:check && npm --prefix frontend run test && npm --prefix frontend run build"
}
```

Keep existing scripts unchanged.

- [ ] **Step 5: Verify scanner**

Run:

```powershell
node --test tests\release-safety.test.mjs
npm run release:check
```

Expected before cleanup:

```text
release-safety.test.mjs passes
npm run release:check fails because current working tree contains private runtime files
```

Commit:

```powershell
git add package.json scripts/check-release-safety.mjs tests/release-safety.test.mjs
git commit -m "chore: add release safety scanner"
```

---

### Task 2: Central Runtime Paths

**Files:**
- Create: `src/crown/runtime/runtime-paths.mjs`
- Create: `tests/crown-runtime-paths.test.mjs`
- Modify: `src/crown/app/app-db.mjs`
- Modify: `src/crown/app/app-secret.mjs`

- [ ] **Step 1: Write runtime path tests**

Create `tests/crown-runtime-paths.test.mjs`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultAppDataRoot,
  defaultDbPath,
  defaultProfileDir,
  defaultRuntimeDir,
  defaultSecretKeyPath,
} from '../src/crown/runtime/runtime-paths.mjs'

test('runtime paths default outside the project data and storage directories on Windows-style env', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
    APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
  }

  assert.equal(defaultAppDataRoot({ env }), 'C:\\Users\\demo\\AppData\\Local\\crown-water-probe')
  assert.equal(defaultRuntimeDir({ env }), 'C:\\Users\\demo\\AppData\\Local\\crown-water-probe\\runtime')
  assert.equal(defaultProfileDir({ env }), 'C:\\Users\\demo\\AppData\\Local\\crown-water-probe\\browser-profile')
  assert.equal(defaultDbPath({ env }), 'C:\\Users\\demo\\AppData\\Local\\crown-water-probe\\storage\\crown.sqlite')
  assert.equal(defaultSecretKeyPath({ env }), 'C:\\Users\\demo\\AppData\\Local\\crown-water-probe\\storage\\crown-local-secret.key')
})

test('explicit env values override runtime defaults', () => {
  const env = {
    CROWN_RUNTIME_DIR: 'D:\\crown\\runtime',
    CROWN_PROFILE_DIR: 'D:\\crown\\profile',
    CROWN_DB_PATH: 'D:\\crown\\db\\crown.sqlite',
    CROWN_LOCAL_SECRET_KEY_PATH: 'D:\\crown\\keys\\secret.key',
  }

  assert.equal(defaultRuntimeDir({ env }), 'D:\\crown\\runtime')
  assert.equal(defaultProfileDir({ env }), 'D:\\crown\\profile')
  assert.equal(defaultDbPath({ env }), 'D:\\crown\\db\\crown.sqlite')
  assert.equal(defaultSecretKeyPath({ env }), 'D:\\crown\\keys\\secret.key')
})
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
node --test tests\crown-runtime-paths.test.mjs
```

Expected:

```text
ERR_MODULE_NOT_FOUND
```

- [ ] **Step 3: Create runtime path helper**

Create `src/crown/runtime/runtime-paths.mjs`:

```js
import os from 'node:os'
import path from 'node:path'

const APP_DIR = 'crown-water-probe'

function normalize(value) {
  return path.normalize(value)
}

export function defaultAppDataRoot({ env = process.env } = {}) {
  const base = env.CROWN_APP_DATA_DIR || env.LOCALAPPDATA || env.APPDATA || path.join(os.homedir(), '.local', 'share')
  return normalize(path.join(base, APP_DIR))
}

export function defaultRuntimeDir({ env = process.env } = {}) {
  return normalize(env.CROWN_RUNTIME_DIR || path.join(defaultAppDataRoot({ env }), 'runtime'))
}

export function defaultProfileDir({ env = process.env } = {}) {
  return normalize(env.CROWN_PROFILE_DIR || path.join(defaultAppDataRoot({ env }), 'browser-profile'))
}

export function defaultDbPath({ env = process.env } = {}) {
  return normalize(env.CROWN_DB_PATH || path.join(defaultAppDataRoot({ env }), 'storage', 'crown.sqlite'))
}

export function defaultSecretKeyPath({ env = process.env } = {}) {
  return normalize(
    env.CROWN_LOCAL_SECRET_KEY_PATH
      || env.CROWN_SECRET_KEY_FILE
      || path.join(defaultAppDataRoot({ env }), 'storage', 'crown-local-secret.key'),
  )
}
```

- [ ] **Step 4: Wire database and secret defaults**

Modify `src/crown/app/app-db.mjs`:

```js
import { defaultDbPath as runtimeDefaultDbPath } from '../runtime/runtime-paths.mjs'

export function defaultDbPath(env = process.env) {
  return path.resolve(runtimeDefaultDbPath({ env }))
}
```

Modify `src/crown/app/app-secret.mjs`:

```js
import { defaultSecretKeyPath } from '../runtime/runtime-paths.mjs'

function localSecretKeyPath({ env = process.env, keyPath } = {}) {
  const configured = keyPath || defaultSecretKeyPath({ env })
  return path.resolve(configured)
}
```

- [ ] **Step 5: Verify runtime path changes**

Run:

```powershell
node --test tests\crown-runtime-paths.test.mjs tests\crown-app-db.test.mjs tests\crown-app-api.test.mjs
npm test
```

Expected:

```text
all selected tests pass
npm test passes
```

Commit:

```powershell
git add src/crown/runtime/runtime-paths.mjs src/crown/app/app-db.mjs src/crown/app/app-secret.mjs tests/crown-runtime-paths.test.mjs
git commit -m "chore: centralize portable runtime paths"
```

---

### Task 3: Require Explicit Crown URL for Live Tools

**Files:**
- Modify: `scripts/crown-watch.mjs`
- Modify: `scripts/crown-probe.mjs`
- Modify: `scripts/crown-betting-protocol-capture.mjs`
- Modify: `tests/crown-watch-login-test.test.mjs`
- Modify: `tests/crown-watch-fixture.test.mjs`

- [ ] **Step 1: Add URL resolution helper in each live script**

Use this logic in the three live scripts:

```js
function resolveRequiredCrownUrl({ argsUrl, env = process.env, allowFixture = false } = {}) {
  const value = argsUrl || env.CROWN_BASE_URL || ''
  if (value) return value
  if (allowFixture) return ''
  throw new Error('crown-base-url-required: pass --url <url> or set CROWN_BASE_URL')
}
```

- [ ] **Step 2: Keep fixture mode offline**

In `scripts/crown-watch.mjs`, call the helper only when not using `--from-fixture`.

Expected behavior:

```text
node scripts/crown-watch.mjs --from-fixture data/fixtures/crown/transform-xml
```

still runs without `CROWN_BASE_URL`.

- [ ] **Step 3: Update tests**

Add or update test cases:

```js
test('watch live mode requires explicit Crown URL', () => {
  assert.throws(
    () => parseArgsForTest(['node', 'scripts/crown-watch.mjs']),
    /crown-base-url-required/,
  )
})

test('watch fixture mode does not require Crown URL', () => {
  const args = parseArgsForTest(['node', 'scripts/crown-watch.mjs', '--from-fixture', 'data/fixtures/crown/transform-xml'])
  assert.equal(args.fromFixture, 'data/fixtures/crown/transform-xml')
})
```

- [ ] **Step 4: Verify live URL behavior**

Run:

```powershell
node --test tests\crown-watch-fixture.test.mjs tests\crown-watch-login-test.test.mjs
node scripts\crown-watch.mjs --from-fixture data\fixtures\crown\transform-xml
```

Expected:

```text
tests pass
fixture mode writes offline JSONL without live Crown URL
```

Commit:

```powershell
git add scripts/crown-watch.mjs scripts/crown-probe.mjs scripts/crown-betting-protocol-capture.mjs tests/crown-watch-fixture.test.mjs tests/crown-watch-login-test.test.mjs
git commit -m "chore: require explicit crown url for live tools"
```

---

### Task 4: One-Click Windows Install and Start Scripts

**Files:**
- Create: `.node-version`
- Create: `install.ps1`
- Create: `start-dashboard.ps1`
- Create: `start-monitor.ps1`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add Node version file**

Create `.node-version`:

```text
22.13.1
```

- [ ] **Step 2: Expand `.env.example`**

Modify `.env.example`:

```dotenv
CROWN_DASHBOARD_HOST=127.0.0.1
CROWN_DASHBOARD_PORT=8787

# Required for live watcher/probe/capture.
# Example: CROWN_BASE_URL=https://example-crown-domain.invalid
CROWN_BASE_URL=

# Defaults are under the current user's local app data directory.
# Override only when you need a custom portable data location.
CROWN_APP_DATA_DIR=
CROWN_RUNTIME_DIR=
CROWN_PROFILE_DIR=
CROWN_DB_PATH=
CROWN_LOCAL_SECRET_KEY_PATH=

# Optional proxy for Telegram or blocked networks.
HTTP_PROXY=
HTTPS_PROXY=
ALL_PROXY=
NO_PROXY=localhost,127.0.0.1,::1
NODE_OPTIONS=
```

- [ ] **Step 3: Create `install.ps1`**

Create `install.ps1`:

```powershell
$ErrorActionPreference = "Stop"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Assert-Command node
Assert-Command npm

$nodeVersion = (& node -p "process.versions.node").Trim()
$major = [int]($nodeVersion.Split(".")[0])
if ($major -lt 22) {
  throw "Node.js >= 22 is required. Current: $nodeVersion"
}

& node -e "import('node:sqlite').then(()=>console.log('node:sqlite OK'))"

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}

New-Item -ItemType Directory -Force -Path "logs" | Out-Null

npm ci
npm --prefix frontend ci
npm --prefix frontend run build
npm test
npm run check
npm --prefix frontend run test

Write-Host "Install OK"
Write-Host "Next: edit .env, then run .\start-dashboard.ps1"
```

- [ ] **Step 4: Create `start-dashboard.ps1`**

Create `start-dashboard.ps1`:

```powershell
$ErrorActionPreference = "Stop"

if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*#" -or $_ -notmatch "=") { return }
    $name, $value = $_.Split("=", 2)
    if ($name) { [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process") }
  }
}

npm run crown:dashboard
```

- [ ] **Step 5: Create `start-monitor.ps1`**

Create `start-monitor.ps1`:

```powershell
$ErrorActionPreference = "Stop"

if (Test-Path ".env") {
  Get-Content ".env" | ForEach-Object {
    if ($_ -match "^\s*#" -or $_ -notmatch "=") { return }
    $name, $value = $_.Split("=", 2)
    if ($name) { [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), "Process") }
  }
}

if (-not $env:CROWN_BASE_URL) {
  throw "CROWN_BASE_URL is required before starting monitor. Edit .env first."
}

npm run crown:watch
```

- [ ] **Step 6: Verify scripts**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\start-dashboard.ps1
```

Expected:

```text
Install OK
Dashboard prints local URL and stays running
```

Stop the Dashboard process with `Ctrl+C`.

Commit:

```powershell
git add .node-version .env.example install.ps1 start-dashboard.ps1 start-monitor.ps1 README.md
git commit -m "chore: add one-click local setup scripts"
```

---

### Task 5: Docker Dashboard-Only Hardening

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `tests/crown-dashboard-docker.test.mjs`

- [ ] **Step 1: Make compose port configurable**

Modify `docker-compose.yml`:

```yaml
services:
  crown-dashboard:
    build:
      context: .
    image: crown-dashboard:local
    container_name: crown-dashboard
    environment:
      CROWN_DASHBOARD_HOST: 0.0.0.0
      CROWN_DASHBOARD_PORT: 8787
      CROWN_DB_PATH: /app/storage/crown.sqlite
      CROWN_STATIC_DIR: /app/frontend/dist
      CROWN_SECRET_KEY: ${CROWN_SECRET_KEY:-}
    ports:
      - "${CROWN_DASHBOARD_PORT:-8787}:8787"
    volumes:
      - ./data/runtime:/app/data/runtime:ro
      - ./data/fixtures/crown/20260708_004011:/app/data/fixtures/crown/20260708_004011:ro
      - ./config:/app/config
      - crown-storage:/app/storage
    restart: unless-stopped

volumes:
  crown-storage:
```

- [ ] **Step 2: Keep private files out of Docker build context**

Modify `.dockerignore`:

```text
storage/
config/telegram-settings.json
data/runtime/
data/crown-profile/
data/crown-probe/
data/crown-probe-smoke/
frontend/dist/
node_modules/
frontend/node_modules/
.env
.env.*
!.env.example
```

Keep existing ignored entries that already exclude `output/`, `.git/`, and generated docs.

- [ ] **Step 3: Update Docker tests**

Modify `tests/crown-dashboard-docker.test.mjs` to assert:

```js
assert.match(compose, /\$\{CROWN_DASHBOARD_PORT:-8787\}:8787/)
assert.match(dockerignore, /storage\//)
assert.match(dockerignore, /config\/telegram-settings\.json/)
```

- [ ] **Step 4: Verify Docker config**

Run:

```powershell
node --test tests\crown-dashboard-docker.test.mjs
docker compose -p crown-dashboard config
```

Expected:

```text
test passes
compose config renders without errors
```

Commit:

```powershell
git add Dockerfile docker-compose.yml .dockerignore tests/crown-dashboard-docker.test.mjs
git commit -m "chore: harden dashboard docker packaging"
```

---

### Task 6: Externalize Business Defaults

**Files:**
- Modify/Create: `config/default-leagues.example.json`
- Modify/Create: `config/monitor-settings.example.json`
- Modify/Create: `config/blacklist.example.json`
- Modify: `src/crown/config/default-leagues.mjs`
- Modify: `src/crown/monitor/monitor-settings.mjs`
- Modify: `src/crown/filters/blacklist.mjs`
- Modify: related tests under `tests/`

- [ ] **Step 1: Create example configs**

Create `config/monitor-settings.example.json` with the current non-secret defaults:

```json
{
  "handicap": {
    "enabled": false,
    "threshold": 0.03,
    "direction": "both",
    "cooldownSeconds": 30
  },
  "live": {
    "enabled": false,
    "threshold": 0.03,
    "direction": "both",
    "cooldownSeconds": 30,
    "minMinute": 0,
    "maxMinute": 90
  }
}
```

Create `config/blacklist.example.json`:

```json
{
  "leagueKeywords": ["电竞", "电子", "虚拟", "梦幻足球", "Esoccer", "E-Football"]
}
```

- [ ] **Step 2: Move code defaults behind config loaders**

Keep code-level fallback arrays small and generic:

```js
const FALLBACK_EXCLUDED_LEAGUE_KEYWORDS = ['电竞', '电子', '虚拟']
```

Load project config first, then fallback.

- [ ] **Step 3: Verify config behavior**

Run:

```powershell
node --test tests\crown-default-leagues.test.mjs tests\crown-monitor-settings.test.mjs
npm test
```

Expected:

```text
all selected tests pass
npm test passes
```

Commit:

```powershell
git add config/default-leagues.example.json config/monitor-settings.example.json config/blacklist.example.json src/crown/config/default-leagues.mjs src/crown/monitor/monitor-settings.mjs src/crown/filters/blacklist.mjs tests
git commit -m "chore: externalize portable business defaults"
```

---

### Task 7: GitHub Documentation and Upload Checklist

**Files:**
- Modify: `README.md`
- Create: `docs/github-release-checklist.md`
- Modify: `docs/safety-boundary.md`
- Modify: `docs/project-memory.md`

- [ ] **Step 1: Rewrite README install section**

README must show this sequence:

```powershell
git clone <repo-url>
cd <repo>
powershell -ExecutionPolicy Bypass -File .\install.ps1
notepad .env
powershell -ExecutionPolicy Bypass -File .\start-dashboard.ps1
```

Then explain:

```text
CROWN_BASE_URL is required only for live monitor/probe/capture.
Dashboard can run without a Crown account.
Docker is Dashboard-only.
```

- [ ] **Step 2: Create GitHub release checklist**

Create `docs/github-release-checklist.md`:

```markdown
# GitHub Release Checklist

## Must Pass

- `npm test`
- `npm run check`
- `npm run release:check`
- `npm --prefix frontend run test`
- `npm --prefix frontend run build`

## Must Not Exist In Upload

- `config/telegram-settings.json`
- `storage/`
- `data/runtime/`
- `data/crown-profile/`
- `data/crown-probe/`
- `data/crown-probe-smoke/`
- `frontend/dist/`
- `node_modules/`
- `frontend/node_modules/`

## Token Rotation

If any private file was ever shared outside this machine, rotate:

- Telegram bot token
- Crown password
- Crown session/login state
- Any browser profile used for capture

## Upload Command

Run:

```powershell
npm run verify
git status --short
```

Only source, tests, docs, example config, fixture summaries, and package lock files should appear.
```

- [ ] **Step 3: Verify docs do not point to private local paths**

Run:

```powershell
rg -n "C:\\Users|127\.0\.0\.1:7897|telegram-settings\.json.*token" README.md docs --glob "!docs/superpowers/**"
```

Expected:

```text
No matches outside historical project-memory notes that are explicitly marked local-only.
```

Commit:

```powershell
git add README.md docs/github-release-checklist.md docs/safety-boundary.md docs/project-memory.md
git commit -m "docs: add github release checklist"
```

---

### Task 8: Final Verification and Upload Gate

**Files:**
- No new files

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm test
npm run check
npm run release:check
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected:

```text
185+ backend tests pass
syntax check passes
release safety passes after private files are removed or kept outside the repo
frontend tests pass
frontend build passes
```

- [ ] **Step 2: Confirm no sensitive files are staged**

Run:

```powershell
git status --short
git ls-files | rg "^(storage/|data/runtime/|data/crown-profile/|data/crown-probe/|config/telegram-settings\.json|frontend/dist/|node_modules/)"
```

Expected:

```text
git status shows only intended source/docs/config example changes
git ls-files sensitive scan prints no matches
```

- [ ] **Step 3: Commit final state**

Run:

```powershell
git add .
git commit -m "chore: prepare portable github release"
```

- [ ] **Step 4: Push after manual token rotation**

Run only after the user confirms token/session rotation:

```powershell
git remote -v
git push origin main
```

Expected:

```text
Push succeeds
GitHub repository contains no private runtime files
```

---

## Recommended Execution Order

| 顺序 | 任务 | 原因 |
|---|---|---|
| 1 | Task 1 | 先让风险自动失败，避免继续扩大泄露面 |
| 2 | Task 2 | 运行态路径是复用性的基础 |
| 3 | Task 3 | 阻止新用户默认打到本机历史域名 |
| 4 | Task 4 | 形成别人下载后的安装入口 |
| 5 | Task 5 | 明确 Docker 只负责 Dashboard |
| 6 | Task 6 | 降低业务默认值硬编码 |
| 7 | Task 7 | 给 GitHub 使用者清晰入口 |
| 8 | Task 8 | 上传前最终闸门 |

## Self-Review

| 检查项 | 结果 |
|---|---|
| 覆盖 GitHub 上传安全 | 已覆盖 Task 1、Task 7、Task 8 |
| 覆盖别人下载后复用 | 已覆盖 Task 2、Task 3、Task 4、Task 5 |
| 覆盖硬编码限制 | 已覆盖 Task 3、Task 6、Task 7 |
| 覆盖一键安装 | 已覆盖 Task 4 |
| 覆盖验证命令 | 已覆盖每个 task 的测试命令和最终验证 |
| 不要求账号 | 所有任务可在无 Crown 账号下完成；真实登录和真实下注不进入本计划 |
