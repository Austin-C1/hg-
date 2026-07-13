import {
  buildBetOutcomeTelegramMessage as renderBetOutcomeTelegramMessage,
  buildOddsChangeTelegramMessage,
  buildSignalOddsChangeTelegramMessage,
} from './telegram-templates.mjs'
import { sendTelegramMessageToChats } from '../telegram/telegram-client.mjs'

function resolveConfig(config = {}) {
  const botToken = config.botToken || (config.botTokenEnv ? process.env[config.botTokenEnv] : '')
  const envChatId = config.chatIdEnv ? process.env[config.chatIdEnv] : ''
  const chatIds = Array.isArray(config.chatIds) && config.chatIds.length
    ? config.chatIds
    : [config.chatId || envChatId].filter(Boolean)
  return { ...config, botToken, chatIds, chatId: chatIds[0] || '' }
}

export function buildTelegramMessage(change) {
  if (change?.signalId) return buildSignalTelegramMessage(change)
  return buildOddsChangeTelegramMessage(change)
}

export function buildSignalTelegramMessage(signal = {}) {
  return buildSignalOddsChangeTelegramMessage(signal)
}

export function buildBetOutcomeTelegramMessage(outcome = {}) {
  return renderBetOutcomeTelegramMessage(outcome)
}

export async function sendTelegramAlert(change, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return { sent: false, reason: 'disabled' }
  if (!resolved.botToken || !resolved.chatIds.length) return { sent: false, reason: 'missing-config' }

  const text = buildTelegramMessage(change)
  if (!text) return { sent: false, reason: 'unsupported-market' }

  const result = await sendTelegramMessageToChats({
    botToken: resolved.botToken,
    chatIds: resolved.chatIds,
    text,
    parseMode: resolved.parseMode,
    fetchImpl: resolved.fetchImpl || fetch,
    signal: resolved.signal,
  })

  if (!result.sent) return { sent: false, reason: result.reason, results: result.results }
  return { sent: true, channel: 'telegram', results: result.results }
}

export async function sendTelegramSignalAlert(signal, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return { sent: false, reason: 'disabled', permanent: true }
  if (!resolved.botToken || !resolved.chatIds.length) return { sent: false, reason: 'missing-config', permanent: true }

  const text = buildSignalTelegramMessage(signal)
  const result = await sendTelegramMessageToChats({
    botToken: resolved.botToken,
    chatIds: resolved.chatIds,
    text,
    parseMode: resolved.parseMode,
    fetchImpl: resolved.fetchImpl || fetch,
    signal: resolved.signal,
  })
  const allSent = result.results.length > 0 && result.results.every((item) => item.sent)
  if (!allSent) return { sent: false, reason: result.reason || 'telegram-partial-failure', results: result.results }
  return { sent: true, channel: 'telegram', results: result.results }
}

export async function sendTelegramBetOutcomeAlert(outcome, config = {}) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return { sent: false, reason: 'disabled', permanent: true }
  if (!resolved.botToken || !resolved.chatIds.length) return { sent: false, reason: 'missing-config', permanent: true }
  const targets = [...new Set(resolved.chatIds.map((item) => String(item || '').trim()).filter(Boolean))]
  const delivered = new Set(
    Array.isArray(resolved.deliveryState?.deliveredChatTargets)
      ? resolved.deliveryState.deliveredChatTargets.map((item) => String(item || '').trim()).filter((item) => targets.includes(item))
      : [],
  )
  const remaining = targets.filter((item) => !delivered.has(item))
  if (!remaining.length) {
    return { sent: true, channel: 'telegram', results: [], deliveryState: { deliveredChatTargets: [...delivered] } }
  }

  const text = buildBetOutcomeTelegramMessage(outcome)
  const result = await sendTelegramMessageToChats({
    botToken: resolved.botToken,
    chatIds: remaining,
    text,
    parseMode: resolved.parseMode,
    fetchImpl: resolved.fetchImpl || fetch,
    signal: resolved.signal,
    onResult(item) {
      if (!item.sent) return
      delivered.add(item.chatId)
      if (resolved.deliveryState && typeof resolved.deliveryState === 'object') {
        resolved.deliveryState.deliveredChatTargets = targets.filter((target) => delivered.has(target))
      }
    },
  })
  for (const item of result.results) if (item.sent) delivered.add(item.chatId)
  const deliveryState = { deliveredChatTargets: targets.filter((item) => delivered.has(item)) }
  const allSent = delivered.size === targets.length
  if (!allSent) return { sent: false, reason: 'telegram-partial-failure', results: result.results, deliveryState }
  return { sent: true, channel: 'telegram', results: result.results, deliveryState }
}
