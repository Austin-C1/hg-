import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { handleAppApi } from '../src/crown/app/app-api.mjs'
import { openAppDatabase } from '../src/crown/app/app-db.mjs'

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-alert-settings-api-')), 'crown.sqlite')
}

async function request(dbPath, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  const response = { statusCode: 0, text: '', writeHead(statusCode) { this.statusCode = statusCode }, end(text) { this.text = text } }
  await handleAppApi(req, response, new URL(pathname, 'http://127.0.0.1'), { dbPath })
  return { statusCode: response.statusCode, payload: JSON.parse(response.text) }
}

function prematch(expectedVersion, overrides = {}) {
  return {
    expectedVersion,
    acknowledgeMigrationReview: false,
    enabled: true,
    asianHandicapEnabled: true,
    totalEnabled: false,
    monitorOddsMin: 0.72,
    monitorOddsMax: 1.18,
    waterMoveThreshold: 0.04,
    cooldownSeconds: 60,
    startMinutesBeforeKickoff: 180,
    stopMinutesBeforeKickoff: 5,
    remark: '赛前报警',
    ...overrides,
  }
}

function live(expectedVersion, overrides = {}) {
  return {
    expectedVersion,
    acknowledgeMigrationReview: false,
    enabled: true,
    asianHandicapEnabled: false,
    totalEnabled: true,
    monitorOddsMin: null,
    monitorOddsMax: null,
    waterMoveThreshold: 0.03,
    cooldownSeconds: 30,
    liveMinuteFrom: 1,
    liveMinuteTo: 90,
    includeFirstHalf: true,
    includeHalfTime: false,
    includeSecondHalf: true,
    remark: '滚球报警',
    ...overrides,
  }
}

function allowReviewCompleted(dbPath) {
  const handle = openAppDatabase({ dbPath, monitorJson: null })
  handle.db.exec("UPDATE monitor_alert_settings SET migration_review_required=0, migration_review_reason='reviewed'")
  handle.close()
}

test('monitor alert GET returns two isolated canonical DTOs and a summary', async () => {
  const response = await request(tempDbPath(), 'GET', '/api/app/monitor-alert-settings')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(Object.keys(response.payload.items), ['prematch', 'live'])
  assert.equal(typeof response.payload.summary, 'object')
  assert.equal('targetAmountMinor' in response.payload.items.prematch, false)
  assert.equal('targetOddsMin' in response.payload.items.live, false)
  assert.equal('realEligible' in response.payload.items.live, false)
  assert.equal('startMinutesBeforeKickoff' in response.payload.items.live, false)
  assert.equal('liveMinuteFrom' in response.payload.items.prematch, false)
  assert.deepEqual(Object.keys(response.payload.items.prematch), [
    'mode', 'enabled', 'asianHandicapEnabled', 'totalEnabled', 'monitorOddsMin', 'monitorOddsMax',
    'waterMoveThreshold', 'cooldownSeconds', 'startMinutesBeforeKickoff', 'stopMinutesBeforeKickoff',
    'remark', 'migrationReviewRequired', 'migrationReviewReason', 'version', 'createdAt', 'updatedAt',
  ])
})

test('monitor alert PUT updates one complete branch with exact CAS and preserves review state', async () => {
  const dbPath = tempDbPath()
  allowReviewCompleted(dbPath)
  const before = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  assert.equal(before.statusCode, 200)
  const input = prematch(before.payload.items.prematch.version)
  const { expectedVersion: _expectedVersion, acknowledgeMigrationReview: _acknowledgeMigrationReview, ...writable } = input
  const updated = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', input)
  assert.equal(updated.statusCode, 200)
  assert.deepEqual(updated.payload.item, {
    ...before.payload.items.prematch,
    ...writable,
    mode: 'prematch',
    migrationReviewRequired: false,
    migrationReviewReason: 'reviewed',
    version: before.payload.items.prematch.version + 1,
    createdAt: before.payload.items.prematch.createdAt,
    updatedAt: updated.payload.item.updatedAt,
  })
  assert.equal('expectedVersion' in updated.payload.item, false)

  const stale = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', prematch(before.payload.items.prematch.version))
  assert.equal(stale.statusCode, 409)
  assert.deepEqual(stale.payload, { error: 'monitor-alert-settings-version-conflict' })
})

test('complete explicit save can acknowledge monitor migration review', async () => {
  const dbPath = tempDbPath()
  const before = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  const current = before.payload.items.prematch

  const updated = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(current.version, { enabled: false }),
    acknowledgeMigrationReview: true,
  })

  assert.equal(updated.statusCode, 200)
  assert.equal(updated.payload.item.migrationReviewRequired, false)
  assert.equal(updated.payload.item.migrationReviewReason, '')
  assert.equal(updated.payload.item.version, current.version + 1)
})

test('monitor migration review is never cleared without explicit true acknowledgement', async () => {
  const dbPath = tempDbPath()
  const before = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  const current = before.payload.items.prematch

  const implicit = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(current.version, { enabled: false }),
    acknowledgeMigrationReview: false,
  })
  assert.equal(implicit.statusCode, 200)
  assert.equal(implicit.payload.item.migrationReviewRequired, true)

  const incomplete = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    expectedVersion: implicit.payload.item.version,
    enabled: false,
    acknowledgeMigrationReview: true,
  })
  assert.equal(incomplete.statusCode, 400)
  assert.equal(incomplete.payload.error, 'validation-error')
  assert.equal(typeof incomplete.payload.fields.waterMoveThreshold, 'string')

  const after = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  assert.equal(after.payload.items.prematch.migrationReviewRequired, true)
})

test('migration acknowledgement audit is exactly-once and CAS-safe', async () => {
  const dbPath = tempDbPath()
  const before = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  const current = before.payload.items.prematch

  const falseSave = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(current.version, { enabled: false }), acknowledgeMigrationReview: false,
  })
  assert.equal(falseSave.statusCode, 200)

  const stale = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(current.version, { enabled: false }), acknowledgeMigrationReview: true,
  })
  assert.equal(stale.statusCode, 409)

  const acknowledged = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(falseSave.payload.item.version, { enabled: false }), acknowledgeMigrationReview: true,
  })
  assert.equal(acknowledged.statusCode, 200)

  const handle = openAppDatabase({ dbPath, monitorJson: null })
  const audits = handle.db.prepare("SELECT action, subject_type, subject_id FROM execution_security_audit WHERE action='monitor_alert_migration_review_completed'").all().map((row) => ({ ...row }))
  handle.close()
  assert.deepEqual(audits, [{ action: 'monitor_alert_migration_review_completed', subject_type: 'monitor_alert_setting', subject_id: 'prematch' }])
})

test('audit insert failure rolls back monitor setting, review, and version atomically', async () => {
  const dbPath = tempDbPath()
  const before = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  const current = before.payload.items.prematch
  const setup = openAppDatabase({ dbPath, monitorJson: null })
  setup.db.exec(`
    CREATE TRIGGER reject_monitor_review_audit
    BEFORE INSERT ON execution_security_audit
    WHEN NEW.action = 'monitor_alert_migration_review_completed'
    BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END
  `)
  setup.close()

  const failed = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/prematch', {
    ...prematch(current.version, { enabled: false, remark: 'must rollback' }), acknowledgeMigrationReview: true,
  })
  assert.equal(failed.statusCode, 500)

  const after = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  assert.deepEqual(after.payload.items.prematch, current)
  const verify = openAppDatabase({ dbPath, monitorJson: null })
  assert.equal(verify.db.prepare("SELECT count(*) AS count FROM execution_security_audit WHERE action='monitor_alert_migration_review_completed'").get().count, 0)
  verify.close()
})

test('monitor alert validation rejects cross-branch, unknown, unsafe, and invalid enable payloads', async () => {
  const dbPath = tempDbPath()
  allowReviewCompleted(dbPath)
  const current = await request(dbPath, 'GET', '/api/app/monitor-alert-settings')
  assert.equal(current.statusCode, 200)
  const version = current.payload.items.live.version
  const invalidBodies = [
    live(version, { startMinutesBeforeKickoff: 10 }),
    live(version, { targetAmountMinor: 100 }),
    live(version, { migrationReviewRequired: false }),
    live(version, { expectedVersion: undefined }),
    live(version, { monitorOddsMin: 'not-a-number' }),
    live(version, { monitorOddsMax: Number.MAX_SAFE_INTEGER + 1 }),
    live(version, { cooldownSeconds: 1.5 }),
    live(version, { waterMoveThreshold: -0.01 }),
    live(version, { liveMinuteFrom: 91, liveMinuteTo: 90 }),
    live(version, { includeFirstHalf: false, includeHalfTime: false, includeSecondHalf: false }),
    live(version, { asianHandicapEnabled: false, totalEnabled: false }),
  ]
  for (const body of invalidBodies) {
    const response = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/live', body)
    assert.equal(response.statusCode, 400, JSON.stringify(body))
    assert.equal(response.payload.error, 'validation-error')
    assert.equal(Object.hasOwn(response.payload.fields, 'targetAmountMinor'), false)
  }

  const wrongMode = await request(dbPath, 'PUT', '/api/app/monitor-alert-settings/halftime', live(version))
  assert.equal(wrongMode.statusCode, 404)
})
