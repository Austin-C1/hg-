#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import {
  parseCleanupArgs,
  runLoginDiagnosticsCleanup,
} from '../src/crown/login/login-diagnostics-cleanup.mjs'

function helpText() {
  return [
    'Usage:',
    '  npm run crown:login-diagnostics:cleanup -- [--dir <login-diagnostics>] [--apply]',
    '',
    'Default mode is dry-run and never changes files.',
    '--apply rewrites safe snapshots and removes other artifacts inside the selected login-diagnostics root.',
  ].join('\n')
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCleanupArgs(argv)
  if (options.help) {
    process.stdout.write(`${helpText()}\n`)
    return null
  }
  const result = runLoginDiagnosticsCleanup(options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: String(error?.code || 'login-diagnostics-cleanup-failed') })}\n`)
    process.exitCode = 1
  }
}
