import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  assertSafeCrownProtocolEvidence,
  redactCapturedBody,
  redactHeaders,
  redactUrl,
} from './capture-redaction.mjs'

function pad(number) {
  return String(number).padStart(2, '0')
}

export function timestampForRun(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function createProtocolStore({
  rootDir = 'data/runtime/betting-protocol-captures',
  runId = `${timestampForRun()}-${randomUUID()}`,
  fileSystem = fs,
} = {}) {
  const runDir = path.resolve(rootDir, runId)
  const privateDir = path.join(runDir, 'private')
  const publicDir = path.join(runDir, 'public')
  fileSystem.mkdirSync(privateDir, { recursive: true })
  fileSystem.mkdirSync(publicDir, { recursive: true })

  const privateNetwork = path.join(privateDir, 'raw-network.jsonl')
  const privateRedactedNetwork = path.join(privateDir, 'redacted-network.jsonl')

  function append(record) {
    const redacted = {
      ...record,
      url: record.url ? redactUrl(record.url) : record.url,
      headers: redactHeaders(record.headers || {}),
      postData: record.postData ? redactCapturedBody(record.postData, record.headers) : undefined,
      responseBody: record.responseBody ? redactCapturedBody(record.responseBody, record.headers) : undefined,
    }
    const rawRow = `${JSON.stringify(record)}\n`
    const redactedRow = `${JSON.stringify(redacted)}\n`
    const files = [privateNetwork, privateRedactedNetwork]
    const lengths = files.map((file) => (
      fileSystem.existsSync(file) ? fileSystem.statSync(file).size : 0
    ))
    try {
      fileSystem.appendFileSync(privateNetwork, rawRow, 'utf8')
      fileSystem.appendFileSync(privateRedactedNetwork, redactedRow, 'utf8')
    } catch (error) {
      for (let index = 0; index < files.length; index += 1) {
        try {
          if (fileSystem.existsSync(files[index])) fileSystem.truncateSync(files[index], lengths[index])
        } catch {
          // Preserve the original append error. Pair validation still fails closed
          // if the underlying filesystem itself refuses the rollback operation.
        }
      }
      throw error
    }
  }

  function writeManifest(manifest) {
    assertSafeCrownProtocolEvidence(manifest)
    fileSystem.writeFileSync(path.join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  function writePrivateManifest(manifest) {
    fileSystem.writeFileSync(path.join(privateDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  return {
    runDir,
    privateDir,
    publicDir,
    append,
    writeManifest,
    writePrivateManifest,
  }
}
