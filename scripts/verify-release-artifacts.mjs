import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditReleaseArtifacts } from '../src/crown/release/release-audit.mjs'

function parseRoot(argv) {
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    throw new Error('release-audit-cli-arguments-invalid')
  }
  return resolve(argv[1])
}

const root = parseRoot(process.argv.slice(2))
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const report = await auditReleaseArtifacts({ root, sourceRoot })
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  version: report.version,
  fileCount: report.fileCount,
  manifestFileCount: report.manifestFileCount,
  forbiddenHits: report.findings.length,
})}\n`)
