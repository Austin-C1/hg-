import { pathToFileURL } from 'node:url'

import { defaultDbPath, openAppDatabase } from '../src/crown/app/app-db.mjs'
import { createTelegramB2OutcomeDispatcher } from '../src/crown/betting/b2-outcome-dispatcher.mjs'
import { readTelegramSettings } from '../src/crown/config/telegram-settings.mjs'

export async function runB2NotificationsOnce({
  dbPath = defaultDbPath(process.env),
  ownerId = `b2-notifications:${process.pid}`,
  telegramSettingsPath,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const settings = await readTelegramSettings(telegramSettingsPath)
  const handle = openAppDatabase({ dbPath })
  try {
    const dispatcher = createTelegramB2OutcomeDispatcher({
      db: handle.db,
      ownerId,
      now,
      telegramConfig: { ...settings.betSuccess, fetchImpl },
    })
    return await dispatcher.runOnce()
  } finally {
    handle.close()
  }
}

async function main() {
  const summary = await runB2NotificationsOnce()
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
