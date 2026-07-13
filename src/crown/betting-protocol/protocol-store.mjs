import fs from 'node:fs'
import path from 'node:path'

import { parseBody, redactBody, redactHeaders, redactUrl } from './capture-redaction.mjs'

function pad(number) {
  return String(number).padStart(2, '0')
}

export function timestampForRun(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function createProtocolStore({ rootDir = 'data/runtime/betting-protocol-captures', runId = timestampForRun() } = {}) {
  const runDir = path.resolve(rootDir, runId)
  const privateDir = path.join(runDir, 'private')
  const publicDir = path.join(runDir, 'public')
  fs.mkdirSync(privateDir, { recursive: true })
  fs.mkdirSync(publicDir, { recursive: true })

  const privateNetwork = path.join(privateDir, 'raw-network.jsonl')
  const publicNetwork = path.join(publicDir, 'redacted-network.jsonl')

  function append(record) {
    fs.appendFileSync(privateNetwork, `${JSON.stringify(record)}\n`, 'utf8')
    const redacted = {
      ...record,
      url: record.url ? redactUrl(record.url) : record.url,
      headers: redactHeaders(record.headers || {}),
      postData: record.postData ? redactBody(parseBody(record.postData)) : undefined,
      responseBody: record.responseBody ? redactBody(parseBody(record.responseBody)) : undefined,
    }
    fs.appendFileSync(publicNetwork, `${JSON.stringify(redacted)}\n`, 'utf8')
  }

  function writeManifest(manifest) {
    fs.writeFileSync(path.join(publicDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  return {
    runDir,
    privateDir,
    publicDir,
    append,
    writeManifest,
  }
}
