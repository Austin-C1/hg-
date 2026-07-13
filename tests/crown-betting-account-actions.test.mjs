import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createAppRepository } from '../src/crown/app/app-repository.mjs'

const SECRET_KEY = 'task-eight-secret-key-with-more-than-32-characters'
const NOW = '2026-07-11T08:00:00.000Z'

function fixture() {
  return fixtureWithNow(() => new Date(NOW))
}

function fixtureWithNow(now) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-account-actions-')), 'crown.sqlite')
  const handle = openAppDatabase({ dbPath })
  const repo = createAppRepository(handle.db, { secretKey: SECRET_KEY, now })
  const account = repo.createBettingAccount({
    label: 'A', username: 'account-a', websiteUrl: 'https://example.test', secret: 'secret-a',
    status: 'enabled', betOrder: 1, perBetLimit: '100', currency: 'CNY',
  })
  handle.db.prepare("UPDATE betting_accounts SET allocation_status='enabled' WHERE id=?").run(account.id)
  return { ...handle, repo, accountId: account.id }
}

function addChild(db, accountId, suffix, status) {
  db.prepare("INSERT OR IGNORE INTO betting_rules (id,name,currency,amount_scale,target_amount_minor,created_at,updated_at) VALUES ('rule-pause','pause','CNY',0,100,?,?)").run(NOW, NOW)
  db.prepare('INSERT INTO monitor_signals (signal_id,signal_key,strategy_id,strategy_version,status,observed_at,expires_at,payload_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(`signal-${suffix}`, `key-${suffix}`, 'strategy', 1, 'ready', NOW, '2026-07-12T08:00:00.000Z', '{}')
  db.prepare("INSERT INTO bet_batches (batch_id,signal_id,rule_id,currency,amount_scale,target_amount_minor,status,created_at) VALUES (?,?,'rule-pause','CNY',0,100,'submitting',?)")
    .run(`batch-${suffix}`, `signal-${suffix}`, NOW)
  db.prepare('INSERT INTO bet_child_orders (child_order_id,batch_id,account_id,requested_amount_minor,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(`child-${suffix}`, `batch-${suffix}`, accountId, 50, status, NOW)
}

test('pause atomically blocks new allocation, lets queued work drain, then becomes paused', () => {
  const { db, close, repo, accountId } = fixture()
  try {
    addChild(db, accountId, 'queued', 'reserved')
    const pending = repo.pauseBettingAccount(accountId)
    assert.equal(pending.allocationStatus, 'pause_pending')
    assert.equal(repo.listEnabledBettingAccountsForExecution().some((item) => item.id === accountId), false)
    assert.equal(db.prepare("SELECT status FROM bet_child_orders WHERE child_order_id='child-queued'").get().status, 'reserved')

    db.prepare("UPDATE bet_child_orders SET status='accepted', resolved_at=? WHERE child_order_id='child-queued'").run(NOW)
    assert.equal(repo.finalizePendingBettingAccountPauses(), 1)
    assert.equal(repo.listBettingAccounts().find((item) => item.id === accountId).allocationStatus, 'paused')
  } finally { close() }
})

test('pause finalizer ignores terminal unknown and preserves its account lock', () => {
  const { db, close, repo, accountId } = fixture()
  try {
    addChild(db, accountId, 'unknown', 'unknown')
    db.prepare("INSERT INTO betting_account_locks (account_id,batch_id,child_order_id,status,fencing_token,acquired_at,updated_at) VALUES (?, 'batch-unknown','child-unknown','unknown',1,?,?)")
      .run(accountId, NOW, NOW)
    const paused = repo.pauseBettingAccount(accountId)
    assert.equal(paused.allocationStatus, 'paused')
    assert.equal(db.prepare('SELECT status FROM betting_account_locks WHERE account_id=?').get(accountId).status, 'unknown')
    assert.throws(() => repo.beginEnableBettingAccount(accountId), /betting-account-busy/)
  } finally { close() }
})

test('enable uses checking CAS and refuses stale credentials changed during the fresh check', () => {
  const { db, close, repo, accountId } = fixture()
  try {
    repo.pauseBettingAccount(accountId)
    const checking = repo.beginEnableBettingAccount(accountId)
    assert.equal(repo.listBettingAccounts().find((item) => item.id === accountId).allocationStatus, 'checking')
    assert.equal(checking.account.password, 'secret-a')

    repo.updateBettingAccount(accountId, { username: 'account-b', secret: 'secret-b' })
    assert.throws(() => repo.completeEnableBettingAccount(checking, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '900', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    }), /betting-account-enable-stale/)
    const stale = db.prepare('SELECT allocation_status, access_status FROM betting_accounts WHERE id=?').get(accountId)
    assert.equal(stale.allocation_status, 'paused')
    assert.equal(stale.access_status, 'unchecked')
  } finally { close() }
})

test('enable only changes checking to enabled after a successful fresh access result', () => {
  const { close, repo, accountId } = fixture()
  try {
    repo.pauseBettingAccount(accountId)
    const checking = repo.beginEnableBettingAccount(accountId)
    const enabled = repo.completeEnableBettingAccount(checking, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '900', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    })
    assert.equal(enabled.allocationStatus, 'enabled')
    assert.equal(enabled.accessStatus, 'available')
    assert.equal(enabled.reportedBalance, '900')
  } finally { close() }
})

test('legacy disabled account is enabled only by a successful fresh checking CAS', () => {
  const { close, repo, accountId } = fixture()
  try {
    repo.pauseBettingAccount(accountId)
    repo.updateBettingAccount(accountId, { status: 'disabled' })
    const checking = repo.beginEnableBettingAccount(accountId)
    assert.equal(repo.listBettingAccounts().find((item) => item.id === accountId).status, 'disabled')
    const enabled = repo.completeEnableBettingAccount(checking, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '500', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    })
    assert.equal(enabled.status, 'enabled')
    assert.equal(enabled.allocationStatus, 'enabled')
  } finally { close() }
})

test('enable CAS rejects archive, status, metadata and delete races while checking', () => {
  for (const mutation of ['archive', 'status', 'metadata', 'delete']) {
    const { db, close, repo, accountId } = fixture()
    try {
      repo.pauseBettingAccount(accountId)
      const checking = repo.beginEnableBettingAccount(accountId)
      if (mutation === 'archive') db.prepare("UPDATE betting_accounts SET archived=1, updated_at='2026-07-11T08:00:01.000Z' WHERE id=?").run(accountId)
      if (mutation === 'status') db.prepare("UPDATE betting_accounts SET status='disabled', updated_at='2026-07-11T08:00:01.000Z' WHERE id=?").run(accountId)
      if (mutation === 'metadata') db.prepare("UPDATE betting_accounts SET notes='changed', updated_at='2026-07-11T08:00:01.000Z' WHERE id=?").run(accountId)
      if (mutation === 'delete') db.prepare('DELETE FROM betting_accounts WHERE id=?').run(accountId)
      assert.throws(() => repo.completeEnableBettingAccount(checking, {
        ok: true, status: 'available', errorCode: '', reportedBalance: '500', reportedCurrency: 'CNY', balanceSource: 'account-summary',
      }), /betting-account-enable-stale/, mutation)
      const row = db.prepare('SELECT allocation_status FROM betting_accounts WHERE id=?').get(accountId)
      if (row) assert.equal(row.allocation_status, 'paused', mutation)
    } finally { close() }
  }
})

test('a stale checking state recovers to paused on the next safe read and never enables itself', () => {
  let current = new Date(NOW)
  const { close, repo, accountId } = fixtureWithNow(() => current)
  try {
    repo.pauseBettingAccount(accountId)
    repo.beginEnableBettingAccount(accountId)
    current = new Date('2026-07-11T08:03:00.000Z')
    const recovered = repo.listBettingAccounts().find((item) => item.id === accountId)
    assert.equal(recovered.allocationStatus, 'paused')
    assert.equal(recovered.accessStatus, 'failed')
    assert.equal(recovered.accessErrorCode, 'check-interrupted')
  } finally { close() }
})

test('a fresh result arriving after the checking deadline cannot enable the account', () => {
  let current = new Date(NOW)
  const { close, repo, accountId } = fixtureWithNow(() => current)
  try {
    repo.pauseBettingAccount(accountId)
    const checking = repo.beginEnableBettingAccount(accountId)
    current = new Date('2026-07-11T08:03:00.000Z')
    assert.throws(() => repo.completeEnableBettingAccount(checking, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '500', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    }), /betting-account-enable-stale/)
    assert.equal(repo.listBettingAccounts().find((item) => item.id === accountId).allocationStatus, 'paused')
  } finally { close() }
})

test('a fresh result arriving exactly at the checking deadline fails closed', () => {
  let current = new Date(NOW)
  const { close, repo, accountId } = fixtureWithNow(() => current)
  try {
    repo.pauseBettingAccount(accountId)
    const checking = repo.beginEnableBettingAccount(accountId)
    current = new Date('2026-07-11T08:02:00.000Z')
    assert.throws(() => repo.completeEnableBettingAccount(checking, {
      ok: true, status: 'available', errorCode: '', reportedBalance: '500', reportedCurrency: 'CNY', balanceSource: 'account-summary',
    }), /betting-account-enable-stale/)
    const recovered = repo.listBettingAccounts().find((item) => item.id === accountId)
    assert.equal(recovered.allocationStatus, 'paused')
    assert.equal(recovered.accessErrorCode, 'check-interrupted')
  } finally { close() }
})

test('enable keeps the account paused when fresh access has no usable CNY balance', () => {
  for (const result of [
    { ok: true, status: 'available', reportedBalance: null, reportedCurrency: 'CNY' },
    { ok: true, status: 'available', reportedBalance: 'NaN', reportedCurrency: 'CNY' },
    { ok: true, status: 'available', reportedBalance: '-1', reportedCurrency: 'CNY' },
    { ok: true, status: 'available', reportedBalance: '100', reportedCurrency: 'USD' },
  ]) {
    const { close, repo, accountId } = fixture()
    try {
      repo.pauseBettingAccount(accountId)
      const checking = repo.beginEnableBettingAccount(accountId)
      const paused = repo.completeEnableBettingAccount(checking, result)
      assert.equal(paused.allocationStatus, 'paused')
      assert.equal(paused.accessStatus, 'failed')
      assert.equal(paused.accessErrorCode, 'balance-unavailable')
    } finally { close() }
  }
})
