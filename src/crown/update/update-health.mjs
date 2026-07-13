import { randomBytes } from 'node:crypto'

import { validateDataPath } from './safe-data-path.mjs'
import { verifySqliteDatabase } from './sqlite-backup.mjs'

const MAX_HEALTH_BYTES = 64 * 1024
const TOP_FIELDS = Object.freeze([
  'appId', 'version', 'appContractVersion', 'installationId', 'probeToken',
  'watcher', 'realBetting', 'capability',
])

function codedError(code) {
  return new Error(code)
}

function exactObject(value, fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)))
}

function healthUrl(value) {
  if (typeof value !== 'string') throw codedError('update-health-url-not-loopback')
  let parsed
  try { parsed = new URL(value) } catch { throw codedError('update-health-url-not-loopback') }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) throw codedError('update-health-url-not-loopback')
  return parsed.href
}

async function readResponse(response, signal) {
  let body
  try { body = response?.body } catch { throw codedError('update-health-response-invalid') }
  if (!body) throw codedError('update-health-response-invalid')
  const chunks = []
  let total = 0
  try {
    for await (const chunk of body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      total += bytes.byteLength
      if (total > MAX_HEALTH_BYTES) throw codedError('update-health-response-too-large')
      chunks.push(bytes)
    }
  } catch (error) {
    if (signal.aborted) throw codedError('update-health-timeout')
    if (error?.message === 'update-health-response-too-large') throw error
    throw codedError('update-health-network-error')
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
    throw codedError('update-health-response-invalid')
  }
}

export function createHealthProbeToken() {
  return randomBytes(32).toString('base64url')
}

export async function checkCandidateHealth({
  dataRoot,
  healthUrl: url,
  probeToken,
  expectedAppId,
  expectedVersion,
  expectedAppContractVersion,
  expectedInstallationId,
  expectedSchemaVersion,
  dbPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const targetUrl = healthUrl(url)
  if (typeof probeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(probeToken)) throw codedError('update-health-probe-invalid')
  for (const value of [expectedAppId, expectedVersion, expectedAppContractVersion, expectedInstallationId]) {
    if (typeof value !== 'string' || value.length === 0) throw codedError('update-health-expectation-invalid')
  }
  if (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 0) {
    throw codedError('update-health-schema-expectation-invalid')
  }
  if (typeof dataRoot !== 'string') throw codedError('update-health-data-root-invalid')
  let databasePath
  try {
    databasePath = await validateDataPath({
      dataRoot,
      targetPath: dbPath,
      requireExists: true,
      expectDirectory: false,
    })
  } catch {
    throw codedError('update-health-database-path-invalid')
  }
  if (typeof fetchImpl !== 'function') throw codedError('update-health-fetch-invalid')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw codedError('update-health-timeout-invalid')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(codedError('update-health-timeout')), timeoutMs)
  let response
  try {
    try {
      response = await fetchImpl(targetUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
        headers: { accept: 'application/json', 'x-crown-update-probe': probeToken },
      })
    } catch {
      if (controller.signal.aborted) throw codedError('update-health-timeout')
      throw codedError('update-health-network-error')
    }
    let responseStatus
    try { responseStatus = response?.status } catch { throw codedError('update-health-response-invalid') }
    if ([301, 302, 303, 307, 308].includes(responseStatus)) throw codedError('update-health-redirect-not-allowed')
    if (!response || !Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus >= 300) {
      throw codedError('update-health-http-error')
    }
    const payload = await readResponse(response, controller.signal)
    if (!exactObject(payload, TOP_FIELDS)
      || !exactObject(payload.watcher, ['state'])
      || !exactObject(payload.realBetting, ['requested', 'state'])
      || !exactObject(payload.capability, ['preview', 'submit', 'reconciliation'])) {
      throw codedError('update-health-response-invalid')
    }
    if (payload.probeToken !== probeToken) throw codedError('update-health-probe-mismatch')
    if (payload.appId !== expectedAppId) throw codedError('update-health-app-mismatch')
    if (payload.installationId !== expectedInstallationId) throw codedError('update-health-installation-mismatch')
    if (payload.version !== expectedVersion) throw codedError('update-health-version-mismatch')
    if (payload.appContractVersion !== expectedAppContractVersion) throw codedError('update-health-contract-mismatch')
    if (payload.watcher.state !== 'stopped') throw codedError('update-health-watcher-not-stopped')
    if (payload.realBetting.requested !== false || payload.realBetting.state !== 'off') {
      throw codedError('update-health-real-betting-not-off')
    }
    if (payload.capability.preview !== 0 || payload.capability.submit !== 0 || payload.capability.reconciliation !== 0) {
      throw codedError('update-health-capability-not-zero')
    }
    let database
    try {
      database = await verifySqliteDatabase({
        dataRoot: databasePath.dataRoot,
        dbPath: databasePath.path,
        expectedUserVersion: expectedSchemaVersion,
      })
    } catch {
      throw codedError('update-health-database-invalid')
    }
    return {
      ok: true,
      appId: payload.appId,
      version: payload.version,
      appContractVersion: payload.appContractVersion,
      installationId: payload.installationId,
      schemaVersion: database.userVersion,
      watcherStopped: true,
      realBettingOff: true,
      capability: { preview: 0, submit: 0, reconciliation: 0 },
    }
  } finally {
    clearTimeout(timer)
  }
}

export { MAX_HEALTH_BYTES }
