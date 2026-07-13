export function parseTelegramChatTarget(value) {
  const text = String(value ?? '').trim()
  const [chatId, thread] = text.split(':')
  const messageThreadId = thread ? Number.parseInt(thread, 10) : null
  return {
    chatId: String(chatId || '').trim(),
    messageThreadId: Number.isFinite(messageThreadId) ? messageThreadId : null,
  }
}

export async function sendTelegramMessageToChats({
  botToken,
  chatIds = [],
  text,
  parseMode = 'HTML',
  disableWebPagePreview = true,
  fetchImpl = fetch,
  signal,
  onResult,
} = {}) {
  const token = String(botToken || '').trim()
  const targets = [...new Set(chatIds.map((item) => String(item || '').trim()).filter(Boolean))]
  if (!token || !targets.length) return { sent: false, reason: 'missing-config', results: [] }

  const results = []
  for (const chatId of targets) {
    const target = parseTelegramChatTarget(chatId)
    const body = {
      chat_id: target.chatId,
      text: String(text || ''),
      disable_web_page_preview: disableWebPagePreview,
    }
    if (parseMode && parseMode !== 'plain') body.parse_mode = parseMode
    if (target.messageThreadId !== null) body.message_thread_id = target.messageThreadId

    let item
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
      item = {
        chatId,
        sent: Boolean(response.ok),
        status: response.status,
        reason: response.ok ? null : 'http-error',
      }
    } catch {
      item = { chatId, sent: false, status: 0, reason: signal?.aborted ? 'aborted' : 'transport-error' }
    }
    results.push(item)
    if (typeof onResult === 'function') onResult(item)
    if (signal?.aborted) break
  }

  return {
    sent: results.some((item) => item.sent),
    reason: results.some((item) => item.sent) ? null : 'http-error',
    results,
  }
}

const UPDATE_MESSAGE_KEYS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
]

function chatIdFromUpdate(update) {
  for (const key of UPDATE_MESSAGE_KEYS) {
    const node = update?.[key]
    const chatId = node?.chat?.id
    if (chatId === undefined || chatId === null) continue
    const threadId = node?.message_thread_id
    return threadId ? `${chatId}:${threadId}` : String(chatId)
  }
  return ''
}

export async function getTelegramChatIds(botToken, { fetchImpl = fetch } = {}) {
  const token = String(botToken || '').trim()
  if (!token) return { ok: false, reason: 'missing-bot-token', message: 'missing bot token' }

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`)
    const payload = await response.json()
    if (!response.ok || payload?.ok === false) {
      return {
        ok: false,
        reason: 'telegram-error',
        message: payload?.description || `Telegram API returned ${response.status}`,
      }
    }

    const chatIds = [...new Set((payload?.result || []).map(chatIdFromUpdate).filter(Boolean))]
    return { ok: true, chatIds }
  } catch (error) {
    return {
      ok: false,
      reason: 'telegram-error',
      message: error instanceof Error ? error.message : 'Telegram API request failed',
    }
  }
}
