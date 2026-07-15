import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createDashboardServer } from '../src/crown/dashboard/static-server.mjs'
import {
  createCrownBrowserAcceptanceManifest,
  initializeCrownBrowserAcceptanceCampaign,
} from '../src/crown/betting/crown-browser-acceptance.mjs'

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

test('local Dashboard restores browser sessions and SQLite campaign across refresh at desktop and 390px', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-task7-dashboard-'))
  const dbPath = path.join(root, 'crown.sqlite')
  const runtimeDir = path.join(root, 'runtime')
  const configDir = path.join(root, 'config')
  const handle = openAppDatabase({ dbPath })
  const now = '2026-07-15T01:00:00.000Z'
  handle.db.prepare(`INSERT INTO betting_accounts
    (id,label,username,website_url,status,archived,allocation_status,bet_order,per_bet_limit_minor,
     currency,amount_scale,execution_status,secret_ciphertext,created_at,updated_at)
    VALUES ('bet_e2e','E2E account','browser-user','https://crown.example.test','enabled',0,'enabled',1,100,
      'CNY',0,'idle','private-password-ciphertext',?,?)`).run(now, now)
  const manifest = createCrownBrowserAcceptanceManifest()
  initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey: 'task-7-e2e-secret' })
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases
    SET state='accepted',authorized_min_minor=50,dispatch_count=1,outcome='accepted',
      account_id='bet_e2e',context_generation='private-context-uuid',
      sealed_provider_reference='private-provider-reference',updated_at=?
    WHERE campaign_id=? AND ordinal=1`).run(now, manifest.campaignId)
  handle.db.prepare(`UPDATE crown_browser_acceptance_cases
    SET state='unknown',authorized_min_minor=50,dispatch_count=1,outcome='unknown',
      account_id='bet_e2e',context_generation='private-context-uuid',
      sealed_provider_reference='private-provider-reference',updated_at=?
    WHERE campaign_id=? AND ordinal=2`).run(now, manifest.campaignId)
  handle.db.prepare("UPDATE crown_browser_acceptance_campaigns SET status='terminal_unknown',updated_at=? WHERE campaign_id=?")
    .run(now, manifest.campaignId)
  handle.close()

  const defaultLeaguesPath = path.join(configDir, 'default-leagues.json')
  const monitorSettingsPath = path.join(configDir, 'monitor-settings.json')
  const telegramSettingsPath = path.join(configDir, 'telegram-settings.json')
  writeJson(defaultLeaguesPath, { version: 1, leagues: [] })
  writeJson(monitorSettingsPath, { version: 1, runningMode: null, handicap: { enabled: false }, live: { enabled: false } })
  writeJson(telegramSettingsPath, {
    version: 1,
    oddsAlert: { enabled: false, botName: '', botToken: '', chatId: '', parseMode: 'HTML', testMessage: '' },
    betSuccess: { enabled: false, botName: '', botToken: '', chatId: '', parseMode: 'HTML', testMessage: '' },
  })

  let generation = 3
  let state = 'stale'
  const bettingProcess = {
    getBrowserStatus() {
      return { generation, accounts: [{
        accountId: 'bet_e2e', state, lastHeartbeatAt: now,
        lastApiSuccessAt: '2026-07-15T00:59:58.000Z',
        profilePath: 'C:\\private-profile', contextGeneration: 'private-context-uuid', uid: 'private-uid',
      }] }
    },
  }
  const server = createDashboardServer({
    staticDir: path.resolve('frontend/dist'),
    appOptions: {
      dbPath, runtimeDir, bettingProcess,
      runtimeCleanup: {
        preview: async () => ({ bytes: 0, files: 0, records: 0, categories: {} }),
        run: async () => ({ bytes: 0, files: 0, records: 0, categories: {} }),
      },
      env: { CROWN_DB_PATH: dbPath, CROWN_RUNTIME_DIR: runtimeDir, CROWN_LOCAL_SECRET_KEY_PATH: path.join(root, 'secret.key') },
    },
    dataOptions: {
      dbPath,
      runtimeDir,
      snapshotPath: path.join(runtimeDir, 'snapshots.jsonl'),
      changesPath: path.join(runtimeDir, 'changes.jsonl'),
      runtimeLogPath: path.join(runtimeDir, 'runtime.jsonl'),
      configPath: path.join(configDir, 'monitored-leagues.json'),
      defaultLeaguesPath,
      monitorSettingsPath,
      telegramSettingsPath,
      allowFixtureFallback: false,
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  const httpFailures = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 500) httpFailures.push(`${response.status()} ${response.url()}`) })

  await page.goto(`${baseUrl}/operations`, { waitUntil: 'networkidle' })
  await assert.doesNotReject(() => page.getByRole('heading', { name: '浏览器内 API' }).waitFor())
  const directionMatrix = page.getByRole('list', { name: '八方向能力矩阵' })
  assert.equal(await directionMatrix.getByRole('listitem').count(), 8)
  const blockedHome = directionMatrix.getByRole('listitem').filter({ hasText: '赛前 · 让球 · 主' })
  assert.equal(await blockedHome.getByText('阻断原因：Submit 缺少直接 accepted 证据').count(), 0)
  assert.equal(await page.getByText('terminal unknown，验收已停止').count(), 1)
  assert.equal(await page.getByText('会话已过期，已阻断').count(), 1)
  const campaignRisk = page.getByTestId('unknown-risk')
  assert.equal(await campaignRisk.count(), 1)
  assert.match(await campaignRisk.innerText(), /验收 unknown 1/)
  assert.equal(await page.getByText('当前无待处理风险').count(), 0)
  assert.equal(await page.getByRole('button', { name: '开启真实投注' }).isDisabled(), true)

  generation = 4
  state = 'ready'
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.getByText('Generation 4').count(), 1)
  assert.equal(await page.getByText('已接受 1 / 8').count(), 1)

  await page.goto(`${baseUrl}/betting-accounts`, { waitUntil: 'networkidle' })
  assert.equal(await page.getByText('浏览器会话：就绪').count(), 1)
  assert.equal(await page.getByRole('button', { name: /停止会话|重启会话/ }).count(), 0)

  await page.goto(`${baseUrl}/betting-rules`, { waitUntil: 'networkidle' })
  assert.equal(await page.getByRole('region', { name: '浏览器方向支持' }).count(), 1)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/operations`, { waitUntil: 'networkidle' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  assert.equal(await page.getByRole('list', { name: '八方向能力矩阵' }).getByRole('listitem').count(), 8)
  const stopBox = await page.getByRole('button', { name: '停止真实投注' }).boundingBox()
  assert.ok(stopBox && stopBox.height >= 44)

  const visibleText = await page.locator('body').innerText()
  assert.doesNotMatch(visibleText, /private-password|private-profile|private-context|private-provider|private-uid/i)
  const summaryBody = await (await page.request.get(`${baseUrl}/api/app/operations-summary`)).text()
  assert.doesNotMatch(summaryBody, /private-password|private-profile|private-context|private-provider|private-uid/i)
  assert.deepEqual({ consoleErrors, httpFailures }, { consoleErrors: [], httpFailures: [] })
})
