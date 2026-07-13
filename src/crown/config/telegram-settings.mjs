import { sendTelegramMessageToChats } from '../telegram/telegram-client.mjs'
import { readJsonConfig, writeJsonConfig } from './json-config.mjs'

export const TELEGRAM_SETTINGS_PATH = 'config/telegram-settings.json'

export const DEFAULT_TELEGRAM_SETTINGS = {
  version: 1,
  oddsAlert: {
    enabled: false,
    botName: '赔率波动报警机器人',
    botToken: '',
    chatId: '',
    chatIds: [],
    parseMode: 'HTML',
    testMessage: '皇冠赔率波动报警测试',
  },
  betSuccess: {
    enabled: false,
    botName: '投注成功通知机器人',
    botToken: '',
    chatId: '',
    chatIds: [],
    parseMode: 'HTML',
    testMessage: '皇冠投注成功通知测试',
  },
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseMode(value) {
  if (value === 'Markdown' || value === 'HTML' || value === 'plain') return value
  return 'HTML'
}

function normalizeChatIds(value, legacyChatId = '') {
  const raw = Array.isArray(value) ? [...value] : [value]
  if (legacyChatId) raw.push(legacyChatId)
  return [...new Set(raw
    .flatMap((item) => String(item ?? '').split(/[\n,]/))
    .map((item) => item.trim())
    .filter(Boolean))]
}

function normalizeBot(input = {}, fallback) {
  const chatIds = normalizeChatIds(input.chatIds, input.chatId)
  return {
    enabled: input.enabled === undefined ? fallback.enabled : Boolean(input.enabled),
    botName: cleanString(input.botName) || fallback.botName,
    botToken: input.botToken === undefined ? fallback.botToken : String(input.botToken || ''),
    chatId: chatIds[0] || '',
    chatIds,
    parseMode: parseMode(input.parseMode || fallback.parseMode),
    testMessage: cleanString(input.testMessage) || fallback.testMessage,
  }
}

export function normalizeTelegramSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    version: 1,
    oddsAlert: normalizeBot(source.oddsAlert, DEFAULT_TELEGRAM_SETTINGS.oddsAlert),
    betSuccess: normalizeBot(source.betSuccess, DEFAULT_TELEGRAM_SETTINGS.betSuccess),
  }
}

function maskToken(token) {
  const text = String(token || '')
  if (!text) return ''
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}${'*'.repeat(Math.max(4, text.length - 8))}${text.slice(-4)}`
}

function maskBot(bot) {
  return {
    enabled: bot.enabled,
    botName: bot.botName,
    botTokenMasked: maskToken(bot.botToken),
    hasBotToken: Boolean(bot.botToken),
    chatId: bot.chatIds[0] || '',
    chatIds: bot.chatIds,
    parseMode: bot.parseMode,
    testMessage: bot.testMessage,
  }
}

export function maskTelegramSettings(settings = DEFAULT_TELEGRAM_SETTINGS) {
  const normalized = normalizeTelegramSettings(settings)
  return {
    version: 1,
    oddsAlert: maskBot(normalized.oddsAlert),
    betSuccess: maskBot(normalized.betSuccess),
  }
}

export async function readTelegramSettings(file = TELEGRAM_SETTINGS_PATH) {
  return readJsonConfig(file, DEFAULT_TELEGRAM_SETTINGS, normalizeTelegramSettings)
}

export async function writeTelegramSettings(file = TELEGRAM_SETTINGS_PATH, settings) {
  return writeJsonConfig(file, settings, normalizeTelegramSettings)
}

export async function sendTelegramTestMessage(bot, { fetchImpl = fetch } = {}) {
  const config = normalizeBot(bot, DEFAULT_TELEGRAM_SETTINGS.oddsAlert)
  if (!config.enabled) return { sent: false, reason: 'disabled' }
  if (!config.botToken || !config.chatIds.length) return { sent: false, reason: 'missing-config' }

  const result = await sendTelegramMessageToChats({
    botToken: config.botToken,
    chatIds: config.chatIds,
    text: config.testMessage,
    parseMode: config.parseMode,
    fetchImpl,
  })

  if (!result.sent) return { sent: false, reason: result.reason, results: result.results }
  return { sent: true, channel: 'telegram', results: result.results }
}
