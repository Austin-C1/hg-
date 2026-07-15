#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { openAppDatabase } from '../src/crown/app/app-db.mjs'
import { readOrCreateLocalSecretKey } from '../src/crown/app/app-secret.mjs'
import { CROWN_CAPABILITY_MATRIX_VERSION } from '../src/crown/betting/crown-capability-matrix.mjs'
import {
  createCrownBrowserAcceptanceManifest,
  initializeCrownBrowserAcceptanceCampaign,
  inspectCrownBrowserAcceptanceCampaign,
} from '../src/crown/betting/crown-browser-acceptance.mjs'
import { writeAtomicJson } from '../src/crown/runtime/atomic-json-file.mjs'

export function safeCrownAcceptanceRuntimeProjection(summary = {}) {
  return {
    schemaVersion: 'crown-browser-api-acceptance-runtime-v1',
    campaignId: String(summary.campaignId || ''),
    status: String(summary.status || ''),
    acceptedCount: Number(summary.acceptedCount) || 0,
    uniqueDirectionCount: Number(summary.uniqueDirectionCount) || 0,
    submitDispatchCount: Number(summary.submitDispatchCount) || 0,
    rejectedCount: Number(summary.rejectedCount) || 0,
    unknownCount: Number(summary.unknownCount) || 0,
    duplicateAttemptCount: Number(summary.duplicateAttemptCount) || 0,
    authorizedMinimumTotalMinor: Number(summary.authorizedMinimumTotalMinor) || 0,
  }
}

export function argumentsFrom(argv = []) {
  const result = { command: '', dbPath: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (['--init', '--resume', '--inspect'].includes(argument)) {
      if (result.command) throw new Error('acceptance-command-xor')
      result.command = argument.slice(2)
    } else if (argument === '--db-path') result.dbPath = argv[++index] || ''
    else throw new Error(`unknown-argument:${argument}`)
  }
  if (!result.command) throw new Error('acceptance-command-required')
  if (!result.dbPath) throw new Error('acceptance-db-path-required')
  return result
}

export async function runAcceptanceCli(argv = process.argv.slice(2), { env = process.env } = {}) {
  const options = argumentsFrom(argv)
  const manifest = createCrownBrowserAcceptanceManifest({ capabilityVersion: CROWN_CAPABILITY_MATRIX_VERSION })
  const secretKey = readOrCreateLocalSecretKey({ env })
  const handle = openAppDatabase({ dbPath: options.dbPath, env })
  try {
    const summary = options.command === 'init'
      ? initializeCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey })
      : inspectCrownBrowserAcceptanceCampaign(handle.db, { manifest, secretKey })
    const safe = safeCrownAcceptanceRuntimeProjection(summary)
    const dataRoot = dirname(options.dbPath)
    const mirrorPath = join(dataRoot, 'runtime', `crown-browser-api-acceptance.${safe.campaignId}.safe.json`)
    await writeAtomicJson({ dataRoot, filePath: mirrorPath, value: safe })
    return {
      command: options.command,
      ...safe,
      providerCalls: { preview: 0, submit: 0, reconciliation: 0 },
    }
  } finally {
    handle.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcceptanceCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
