import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  maskTelegramSettings,
  normalizeTelegramSettings,
  readTelegramSettings,
  sendTelegramTestMessage,
  writeTelegramSettings,
} from '../src/crown/config/telegram-settings.mjs'

test('telegram settings mask bot tokens in API-facing payloads', () => {
  const masked = maskTelegramSettings(normalizeTelegramSettings({
    oddsAlert: {
      enabled: true,
      botName: '赔率波动报警机器人',
      botToken: '123456:abcdef-secret-token',
      chatId: '10001',
      parseMode: 'HTML',
      testMessage: 'test',
    },
  }))

  assert.equal(masked.oddsAlert.hasBotToken, true)
  assert.equal(masked.oddsAlert.botToken, undefined)
  assert.equal(masked.oddsAlert.botTokenMasked, '1234******************oken')
  assert.equal(JSON.stringify(masked).includes('abcdef-secret-token'), false)
})

test('telegram settings normalize legacy chatId into chatIds', () => {
  const settings = normalizeTelegramSettings({
    oddsAlert: {
      enabled: true,
      botToken: 'token',
      chatId: '10001',
    },
  })

  assert.deepEqual(settings.oddsAlert.chatIds, ['10001'])
  assert.equal(settings.oddsAlert.chatId, '10001')
})

test('telegram settings normalize comma and newline separated chat ids', () => {
  const settings = normalizeTelegramSettings({
    oddsAlert: {
      chatIds: ['10001, 10002', '-10003:88\n10001'],
    },
  })

  assert.deepEqual(settings.oddsAlert.chatIds, ['10001', '10002', '-10003:88'])
})

test('telegram test message uses injected fetch and never sends during tests unless mocked', async () => {
  const calls = []
  const result = await sendTelegramTestMessage({
    enabled: true,
    botToken: '123456:abcdef-secret-token',
    chatId: '10001',
    parseMode: 'Markdown',
    testMessage: 'mock message',
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })

  assert.equal(result.sent, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /api\.telegram\.org\/bot123456:abcdef-secret-token\/sendMessage/)
  assert.equal(JSON.parse(calls[0].options.body).text, 'mock message')
})

test('telegram settings persist to local JSON and read back with defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-telegram-settings-'))
  const file = path.join(dir, 'telegram-settings.json')

  await writeTelegramSettings(file, {
    oddsAlert: {
      enabled: true,
      botName: '赔率波动报警机器人',
      botToken: 'token',
      chatId: 'chat',
      parseMode: 'plain',
      testMessage: 'hello',
    },
  })
  const read = await readTelegramSettings(file)

  assert.equal(read.oddsAlert.enabled, true)
  assert.equal(read.oddsAlert.botToken, 'token')
  assert.equal(read.betSuccess.botName, '投注成功通知机器人')
})
