import { pathToFileURL } from 'node:url'

import { runUpdateApplyRequest } from '../src/crown/update/update-applier.mjs'
import { updateError } from '../src/crown/update/update-error.mjs'
import { createWindowsUpdateRuntime } from '../src/crown/update/windows-update-runtime.mjs'

export function parseUpdateApplyArguments(argv = []) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--request' || typeof argv[1] !== 'string' || argv[1].length === 0) {
    throw updateError('update-apply-request-required')
  }
  return Object.freeze({ requestPath: argv[1] })
}

export async function main(argv = process.argv.slice(2), {
  createRuntime = createWindowsUpdateRuntime,
  dataRoot = process.env.CROWN_DATA_ROOT,
  runRequest = runUpdateApplyRequest,
} = {}) {
  const { requestPath } = parseUpdateApplyArguments(argv)
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw updateError('update-apply-data-root-required')
  if (typeof runRequest !== 'function') throw updateError('update-apply-runner-invalid')
  return runRequest({ dataRoot, requestPath, createRuntime })
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  main().catch((error) => {
    const code = error?.code || error?.message
    process.stderr.write(`${/^update-[a-z0-9-]+$/.test(code || '') ? code : 'update-apply-failed'}\n`)
    process.exitCode = code === 'update-apply-request-required' ? 64 : 70
  })
}
