import { pathToFileURL } from 'node:url'

import { updateError } from '../src/crown/update/update-error.mjs'

export function parseUpdateApplyArguments(argv = []) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--request' || typeof argv[1] !== 'string' || argv[1].length === 0) {
    throw updateError('update-apply-request-required')
  }
  return Object.freeze({ requestPath: argv[1] })
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { requestPath } = parseUpdateApplyArguments(argv)
  const dataRoot = options.dataRoot ?? process.env.CROWN_DATA_ROOT
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) throw updateError('update-apply-data-root-required')
  const createRuntime = options.createRuntime
    ?? (await import('../src/crown/update/windows-update-runtime.mjs')).createWindowsUpdateRuntime
  const runRequest = options.runRequest
    ?? (await import('../src/crown/update/update-applier.mjs')).runUpdateApplyRequest
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
