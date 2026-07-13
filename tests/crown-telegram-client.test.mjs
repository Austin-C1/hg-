import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getTelegramChatIds,
  parseTelegramChatTarget,
  sendTelegramMessageToChats,
} from '../src/crown/telegram/telegram-client.mjs'

test('parseTelegramChatTarget supports plain chat id and forum topic thread id', () => {
  assert.deepEqual(parseTelegramChatTarget('-100123'), {
    chatId: '-100123',
    messageThreadId: null,
  })
  assert.deepEqual(parseTelegramChatTarget('-100123:456'), {
    chatId: '-100123',
    messageThreadId: 456,
  })
})

test('sendTelegramMessageToChats sends one request per chat target', async () => {
  const calls = []
  const result = await sendTelegramMessageToChats({
    botToken: '123456:secret-token',
    chatIds: ['10001', '-10002:88'],
    text: '<b>hello</b>',
    parseMode: 'HTML',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })

  assert.equal(result.sent, true)
  assert.equal(result.results.length, 2)
  assert.equal(calls[0].body.chat_id, '10001')
  assert.equal(calls[1].body.chat_id, '-10002')
  assert.equal(calls[1].body.message_thread_id, 88)
  assert.equal(calls[0].body.parse_mode, 'HTML')
  assert.equal(calls[0].body.disable_web_page_preview, true)
})

test('getTelegramChatIds extracts message chats and topic ids from getUpdates', async () => {
  const result = await getTelegramChatIds('123456:secret-token', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: [
          { message: { chat: { id: 10001 } } },
          { message: { chat: { id: -10002 }, message_thread_id: 88 } },
          { edited_message: { chat: { id: 10001 } } },
        ],
      }),
    }),
  })

  assert.deepEqual(result.chatIds, ['10001', '-10002:88'])
})
