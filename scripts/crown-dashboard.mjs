#!/usr/bin/env node
import { loadProjectEnv } from '../src/crown/app/env-file.mjs'
import { openAppDatabase, openRuntimeDatabase } from '../src/crown/app/app-db.mjs'
import { createBettingProcessController } from '../src/crown/app/betting-process.mjs'
import { createMonitorProcessController } from '../src/crown/app/monitor-process.mjs'
import { collectRealBettingPreflight, getRealBettingStatus, recordRealBettingWorkerExit, refreshRealBettingRuntime } from '../src/crown/betting/real-betting-runtime.mjs'
import { startDashboardServer } from '../src/crown/dashboard/static-server.mjs'

loadProjectEnv()

const host = process.env.CROWN_DASHBOARD_HOST || '127.0.0.1'
const port = Number(process.env.CROWN_DASHBOARD_PORT || 8787)
const staticDir = process.env.CROWN_STATIC_DIR || 'frontend/dist'
const dbPath = process.env.CROWN_DB_PATH
const monitorProcess = createMonitorProcessController({ dbPath, env: process.env })
const bettingProcess = createBettingProcessController({
  dbPath, env: process.env,
  onExit(event) {
    const exitDatabase = openRuntimeDatabase({ dbPath })
    try { recordRealBettingWorkerExit(exitDatabase.db, event) } finally { exitDatabase.close() }
  },
})
const startupDatabase = openAppDatabase({ dbPath })
try {
  getRealBettingStatus(startupDatabase.db, { initialize: true })
} finally {
  startupDatabase.close()
}

const server = await startDashboardServer({
  host,
  port,
  staticDir,
  appOptions: { dbPath, monitorProcess, bettingProcess, env: process.env },
})
const address = server.address()

let realBettingTickBusy = false
setInterval(async () => {
  if (realBettingTickBusy) return
  realBettingTickBusy = true
  const tickDatabase = openRuntimeDatabase({ dbPath })
  try {
    const checks = collectRealBettingPreflight(tickDatabase.db, {
      env: process.env, dbPath: tickDatabase.dbPath, runtimeDir: 'data/runtime', readyTicket: bettingProcess.getReadyTicket(),
    })
    const status = refreshRealBettingRuntime(tickDatabase.db, { checks })
    if (status.state === 'blocked') await bettingProcess.stop()
  } finally {
    tickDatabase.close()
    realBettingTickBusy = false
  }
}, 1000).unref()

console.log(`Crown dashboard listening on http://${address.address}:${address.port}`)
