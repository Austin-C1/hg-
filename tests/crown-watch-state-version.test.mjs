import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { RuntimeLease } from '../src/crown/app/runtime-lease.mjs'
import { watcherLeaseKey } from '../src/crown/app/watcher-lease-key.mjs'
import {
  createMonitorAuditStore,
  emitLegacyMonitorWarning,
  executeFromArgs,
  parseArgs,
  resolveMonitorStateRouting,
  runLiveWatch,
} from '../scripts/crown-watch.mjs'

test('monitor history writes JSONL until manual cleanup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-monitor-history-'))
  const retained = createMonitorAuditStore({ runtimeDir: dir })
  retained.close()
  assert.equal(fs.existsSync(path.join(dir, 'crown-odds-snapshots-v2.jsonl')), true)
})

test('monitor history is retained until the user runs manual cleanup', () => {
  assert.equal(parseArgs([]).retainMonitorHistory, true)
})

test('watcher lease key canonicalizes resolved DB/runtime paths and Windows path casing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-key-'))
  const runtimeDir = path.join(dir, 'Runtime')
  fs.mkdirSync(runtimeDir)
  const dbPath = path.join(dir, 'Watcher.sqlite')
  fs.writeFileSync(dbPath, '')

  const first = watcherLeaseKey({ dbPath, runtimeDir })
  const second = watcherLeaseKey({ dbPath: path.join(dir, '.', 'Watcher.sqlite'), runtimeDir: path.join(dir, 'Runtime', '.') })
  assert.equal(first, second)
  assert.match(first, /^watcher:/)
  if (process.platform === 'win32') assert.equal(first, first.toLowerCase())
})

test('fixture execution remains offline and does not acquire a live watcher lease', async () => {
  const args = parseArgs(['--from-fixture', 'fixture-dir', '--runtime-dir', 'fixture-runtime'])
  let leases = 0
  let fixtures = 0
  await executeFromArgs(args, {
    warn() {},
    logStats: false,
    createWatcherLease() { leases += 1; throw new Error('fixture-lease') },
    async runFixtureWatch() { fixtures += 1; return { ok: true } },
  })
  assert.equal(fixtures, 1)
  assert.equal(leases, 0)
})

test('live watcher fails closed on a missing app DB without creating it for the lease', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-missing-db-'))
  const dbPath = path.join(dir, 'missing.sqlite')
  let liveCalls = 0
  await assert.rejects(executeFromArgs(parseArgs([
    '--app-db', dbPath, '--runtime-dir', path.join(dir, 'runtime'),
  ]), {
    async runLiveWatch() { liveCalls += 1 },
  }), /watcher-db-missing/)
  assert.equal(liveCalls, 0)
  assert.equal(fs.existsSync(dbPath), false)
})

test('an active watcher lease fails closed before live login, polling, or output work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-active-'))
  const dbPath = path.join(dir, 'watcher.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  const handle = openAppDatabase({ dbPath })
  const now = () => new Date('2026-07-11T03:00:00.000Z')
  const active = new RuntimeLease({
    db: handle.db,
    leaseKey: watcherLeaseKey({ dbPath: handle.dbPath, runtimeDir }),
    ownerId: 'active-watcher',
    ttlMs: 30_000,
    now,
  })
  active.acquire()
  let liveCalls = 0
  try {
    await assert.rejects(executeFromArgs(parseArgs(['--app-db', dbPath, '--runtime-dir', runtimeDir]), {
      watcherLeaseNow: now,
      async runLiveWatch() { liveCalls += 1 },
    }), /lease-active/)
    assert.equal(liveCalls, 0)
  } finally {
    handle.close()
  }
})

test('a second manual watcher process exits nonzero on the shared active lease before network work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-second-cli-'))
  const dbPath = path.join(dir, 'watcher.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  const handle = openAppDatabase({ dbPath })
  const active = new RuntimeLease({
    db: handle.db,
    leaseKey: watcherLeaseKey({ dbPath: handle.dbPath, runtimeDir }),
    ownerId: 'active-cli-watcher',
    ttlMs: 30_000,
  })
  active.acquire()
  try {
    const result = spawnSync(process.execPath, [
      'scripts/crown-watch.mjs', '--app-db', dbPath, '--runtime-dir', runtimeDir, '--login-test',
    ], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 5_000 })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stderr, /lease-active/)
  } finally {
    handle.close()
  }
})

test('an expired watcher lease is atomically taken over with a higher fence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-takeover-'))
  const dbPath = path.join(dir, 'watcher.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  const handle = openAppDatabase({ dbPath })
  let milliseconds = Date.parse('2026-07-11T03:00:00.000Z')
  const now = () => new Date(milliseconds)
  const key = watcherLeaseKey({ dbPath: handle.dbPath, runtimeDir })
  new RuntimeLease({ db: handle.db, leaseKey: key, ownerId: 'expired-watcher', ttlMs: 1_000, now }).acquire()
  milliseconds += 1_001
  let liveCalls = 0
  try {
    await executeFromArgs(parseArgs(['--app-db', dbPath, '--runtime-dir', runtimeDir]), {
      watcherLeaseNow: now,
      watcherLeaseTtlMs: 1_000,
      async runLiveWatch() { liveCalls += 1; return { ok: true } },
    })
    assert.equal(liveCalls, 1)
    const row = handle.db.prepare('SELECT fencing_token FROM runtime_leases WHERE lease_key = ?').get(key)
    assert.equal(row.fencing_token, 2)
  } finally {
    handle.close()
  }
})

for (const [name, extra] of [
  ['schema-v1', ['--monitor-state-version', '1']],
  ['schema-v2', []],
  ['login-test', ['--login-test']],
]) {
  test(`${name} live path acquires the watcher lease before watch work`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crown-watcher-${name}-`))
    const dbPath = path.join(dir, 'watcher.sqlite')
    const runtimeDir = path.join(dir, 'runtime')
    const initialized = openAppDatabase({ dbPath })
    initialized.close()
    const events = []
    await executeFromArgs(parseArgs(['--app-db', dbPath, '--runtime-dir', runtimeDir, ...extra]), {
      createWatcherLease(options) {
        return {
          fencingToken: null,
          acquire() { this.fencingToken = 1; events.push(`acquire:${options.leaseKey}`); return { fencingToken: 1 } },
          heartbeat() { events.push('heartbeat') },
          release() { events.push('release'); return true },
        }
      },
      async runLiveWatch() { events.push('watch'); return { ok: true } },
    })
    assert.match(events[0], /^acquire:watcher:/)
    assert.deepEqual(events.slice(1), ['watch', 'release'])
  })
}

test('watcher heartbeat runs below TTL and lease loss aborts work, exits nonzero, and releases by the held fence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-heartbeat-'))
  const dbPath = path.join(dir, 'watcher.sqlite')
  const runtimeDir = path.join(dir, 'runtime')
  const initialized = openAppDatabase({ dbPath })
  initialized.close()
  let heartbeatMs = null
  let releasedFence = null
  let cleared = false
  let aborted = false
  let workCleaned = false
  let releasedAfterCleanup = false
  const stale = Object.assign(new Error('lease-stale'), { code: 'lease-stale' })

  await assert.rejects(executeFromArgs(parseArgs(['--app-db', dbPath, '--runtime-dir', runtimeDir]), {
    watcherLeaseTtlMs: 90,
    createWatcherLease() {
      return {
        fencingToken: null,
        acquire() { this.fencingToken = 4; return { fencingToken: 4 } },
        heartbeat() { throw stale },
        release() { releasedFence = this.fencingToken; releasedAfterCleanup = workCleaned; return true },
      }
    },
    setWatcherHeartbeatInterval(callback, milliseconds) {
      heartbeatMs = milliseconds
      queueMicrotask(callback)
      return { timer: true }
    },
    clearWatcherHeartbeatInterval() { cleared = true },
    async runLiveWatch(_args, dependencies) {
      await new Promise((resolve) => {
        dependencies.signal.addEventListener('abort', () => { aborted = true; resolve({ stopped: true }) }, { once: true })
      })
      workCleaned = true
      return { stopped: true }
    },
  }), /lease-stale/)

  assert.equal(heartbeatMs > 0 && heartbeatMs < 90, true)
  assert.equal(aborted, true)
  assert.equal(releasedFence, 4)
  assert.equal(releasedAfterCleanup, true)
  assert.equal(cleared, true)
})

test('legacy live watcher stops on lease abort without leaking process signal listeners', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-watcher-v1-abort-'))
  const controller = new AbortController()
  const before = {
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  }
  const browser = fakeLegacyBrowser()
  let closed = 0
  browser.context.close = async () => { closed += 1 }
  const running = runLiveWatch(parseArgs([
    '--monitor-state-version', '1', '--runtime-dir', path.join(dir, 'runtime'),
    '--dom-poll-seconds', '0', '--config-reload-seconds', '0',
  ]), {
    signal: controller.signal,
    launchContext: async () => browser.context,
    loadMonitorAccount: () => null,
    loadLegacyBettingRule: () => null,
  })
  setImmediate(() => controller.abort(new Error('lease-stale')))
  await running

  assert.equal(closed, 1)
  assert.equal(process.listenerCount('SIGINT'), before.sigint)
  assert.equal(process.listenerCount('SIGTERM'), before.sigterm)
})

test('monitor state routing defaults to schema v2 direct state and additive v2 paths', () => {
  const args = parseArgs(['--runtime-dir', 'runtime-test'])
  const routing = resolveMonitorStateRouting(args)

  assert.equal(args.monitorStateVersion, 2)
  assert.equal(routing.version, 2)
  assert.equal(routing.useDirectApiV2, true)
  assert.equal(routing.snapshotsPath, path.join('runtime-test', 'crown-odds-snapshots-v2.jsonl'))
  assert.equal(routing.changesPath, path.join('runtime-test', 'crown-odds-changes-v2.jsonl'))
  assert.equal(routing.candidatesPath, path.join('runtime-test', 'betting-candidates-v2.jsonl'))
  assert.equal(routing.warning, '')
})

test('explicit schema v1 rollback routes only to legacy files and emits a prominent lifecycle warning', () => {
  const args = parseArgs(['--runtime-dir', 'runtime-test', '--monitor-state-version', '1'])
  const routing = resolveMonitorStateRouting(args)
  const warnings = []

  emitLegacyMonitorWarning(args, { warn: (message) => warnings.push(String(message)) })

  assert.equal(routing.version, 1)
  assert.equal(routing.useDirectApiV2, false)
  assert.equal(routing.snapshotsPath, path.join('runtime-test', 'crown-odds-snapshots.jsonl'))
  assert.equal(routing.changesPath, path.join('runtime-test', 'crown-odds-changes.jsonl'))
  assert.equal(routing.candidatesPath, path.join('runtime-test', 'betting-candidates.jsonl'))
  assert.match(warnings.join('\n'), /DEPRECATED/i)
  assert.match(warnings.join('\n'), /schema-v1/i)
  assert.match(warnings.join('\n'), /event lifecycle/i)
})

test('monitor state version accepts only 1 or 2', () => {
  for (const value of ['0', '3', 'v2', '']) {
    const argv = value ? ['--monitor-state-version', value] : ['--monitor-state-version']
    assert.throws(() => parseArgs(argv), /monitor-state-version.*(?:1.*2|requires a value)/i)
  }
})

test('all value options reject a missing value or a following flag', () => {
  const options = [
    '--url', '--profile', '--runtime-dir', '--monitor-state-version', '--league-config',
    '--default-leagues-config', '--monitor-settings', '--telegram-settings', '--alerts-config',
    '--app-db', '--betting-candidates', '--channel', '--from-fixture', '--max-seconds',
    '--dom-poll-seconds', '--max-game-more', '--runtime-log', '--config-reload-seconds',
    '--zero-dom-warn-after',
  ]
  for (const option of options) {
    assert.throws(() => parseArgs([option]), new RegExp(`${option}.*value`, 'i'), `${option} at argv end`)
    assert.throws(() => parseArgs([option, '--headless']), new RegExp(`${option}.*value`, 'i'), `${option} before flag`)
  }
})

test('numeric options reject non-finite and negative values while documented zero values remain valid', () => {
  const options = ['--max-seconds', '--dom-poll-seconds', '--max-game-more', '--config-reload-seconds', '--zero-dom-warn-after']
  for (const option of options) {
    for (const value of ['NaN', 'Infinity', '-1']) {
      assert.throws(() => parseArgs([option, value]), new RegExp(`${option}.*non-negative`, 'i'))
    }
    assert.doesNotThrow(() => parseArgs([option, '0']))
  }
})

test('candidate file overrides cannot cross reserved schema generations', () => {
  assert.throws(() => parseArgs([
    '--monitor-state-version', '1',
    '--runtime-dir', 'runtime-test',
    '--betting-candidates', path.join('runtime-test', 'betting-candidates-v2.jsonl'),
  ]), /schema-v2 candidate path.*reserved/i)
  assert.throws(() => parseArgs([
    '--monitor-state-version', '2',
    '--runtime-dir', 'runtime-test',
    '--betting-candidates', path.join('runtime-test', 'betting-candidates.jsonl'),
  ]), /schema-v1 candidate path.*reserved/i)
})

function fakeLegacyBrowser() {
  const page = {
    on() {},
    async goto() {},
    url() { return 'https://fixture.invalid/' },
  }
  return {
    page,
    context: {
      pages() { return [page] },
      async newPage() { return page },
      async close() {},
    },
  }
}

test('default v2 live mode fails closed without complete account credentials and does not launch legacy browser or create DB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v2-account-required-'))
  const dbPath = path.join(dir, 'missing.sqlite')
  let launches = 0
  const base = parseArgs(['--app-db', dbPath, '--runtime-dir', path.join(dir, 'runtime'), '--config-reload-seconds', '0'])

  await assert.rejects(runLiveWatch(base, {
    launchContext: async () => { launches += 1; return fakeLegacyBrowser().context },
  }), /schema-v2.*enabled monitor account.*username.*password/i)
  await assert.rejects(runLiveWatch({ ...base }, {
    loadMonitorAccount: () => ({ id: 'mon_primary', username: 'configured', password: '' }),
    launchContext: async () => { launches += 1; return fakeLegacyBrowser().context },
  }), /schema-v2.*enabled monitor account.*username.*password/i)

  assert.equal(launches, 0)
  assert.equal(fs.existsSync(dbPath), false)
})

test('explicit v1 live and fixture short runs do not create a missing DB or any v2 sidecar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v1-side-effects-'))
  const liveRuntime = path.join(dir, 'live-runtime')
  const fixtureRuntime = path.join(dir, 'fixture-runtime')
  const dbPath = path.join(dir, 'missing.sqlite')
  const { context } = fakeLegacyBrowser()
  const liveArgs = parseArgs([
    '--monitor-state-version', '1', '--app-db', dbPath, '--runtime-dir', liveRuntime,
    '--max-seconds', '0.001', '--dom-poll-seconds', '0', '--config-reload-seconds', '0',
  ])

  await runLiveWatch(liveArgs, { launchContext: async () => context })
  await executeFromArgs(parseArgs([
    '--monitor-state-version', '1', '--app-db', dbPath, '--runtime-dir', fixtureRuntime,
    '--from-fixture', 'data/fixtures/crown/transform-xml',
  ]), { warn() {} })

  assert.equal(fs.existsSync(dbPath), false)
  for (const runtimeDir of [liveRuntime, fixtureRuntime]) {
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-snapshots-v2.jsonl')), false)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'crown-odds-changes-v2.jsonl')), false)
    assert.equal(fs.existsSync(path.join(runtimeDir, 'betting-candidates-v2.jsonl')), false)
  }
})

test('explicit v1 opens an existing app DB read-only without adding v2 tables', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v1-readonly-db-'))
  const dbPath = path.join(dir, 'legacy.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE monitor_accounts (
      id TEXT PRIMARY KEY, label TEXT, username TEXT, login_url TEXT, status TEXT,
      enabled INTEGER, updated_at TEXT, secret_ciphertext TEXT
    );
  `)
  db.close()
  const before = fs.statSync(dbPath)
  const { context } = fakeLegacyBrowser()

  await runLiveWatch(parseArgs([
    '--monitor-state-version', '1', '--app-db', dbPath, '--runtime-dir', path.join(dir, 'runtime'),
    '--max-seconds', '0.001', '--dom-poll-seconds', '0', '--config-reload-seconds', '0',
  ]), { launchContext: async () => context })

  const check = new DatabaseSync(dbPath, { readOnly: true })
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
  check.close()
  const after = fs.statSync(dbPath)
  assert.deepEqual(tables, ['monitor_accounts'])
  assert.equal(after.size, before.size)
})

test('legacy DOM and fixture orchestration carry the selected betting rule and candidate path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-v1-wiring-'))
  const candidatePath = path.join(dir, 'legacy-custom-candidates.jsonl')
  const legacyRule = { id: 'legacy-rule' }
  const { context } = fakeLegacyBrowser()
  let domOptions = null
  await runLiveWatch(parseArgs([
    '--monitor-state-version', '1', '--runtime-dir', path.join(dir, 'runtime'),
    '--betting-candidates', candidatePath, '--max-seconds', '0.001',
    '--dom-poll-seconds', '0.001', '--config-reload-seconds', '0',
  ]), {
    launchContext: async () => context,
    loadMonitorAccount: () => null,
    loadLegacyBettingRule: () => legacyRule,
    loadTrackedMatches: () => [],
    pollDomAndStore: async (options) => { domOptions = options },
  })
  assert.equal(domOptions.bettingRule, legacyRule)
  assert.equal(domOptions.bettingCandidatesPath, candidatePath)

  let fixtureOptions = null
  await executeFromArgs(parseArgs([
    '--monitor-state-version', '1', '--from-fixture', 'fixture-dir',
    '--runtime-dir', path.join(dir, 'fixture-runtime'), '--betting-candidates', candidatePath,
  ]), {
    warn() {},
    logStats: false,
    runFixtureWatch: async (options) => { fixtureOptions = options; return { ok: true } },
  })
  assert.equal(fixtureOptions.bettingCandidatesPath, candidatePath)
})
