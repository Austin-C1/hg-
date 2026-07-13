import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPortableRelease } from '../src/crown/release/portable-release-builder.mjs'

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--version', '--node-runtime', '--chromium-runtime', '--out'].includes(name) || !value) {
      throw new Error('release-cli-arguments-invalid')
    }
    if (values.has(name)) throw new Error('release-cli-arguments-invalid')
    values.set(name, value)
  }
  if (values.size !== 4) throw new Error('release-cli-arguments-invalid')
  return values
}

const args = parseArgs(process.argv.slice(2))
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const result = await buildPortableRelease({
  sourceRoot,
  outputDir: resolve(args.get('--out')),
  version: args.get('--version'),
  nodeRuntimeDir: resolve(args.get('--node-runtime')),
  chromiumRuntimeDir: resolve(args.get('--chromium-runtime')),
  formalRelease: true,
})
process.stdout.write(`${JSON.stringify({
  ok: true,
  version: result.version,
  root: result.root,
  fileCount: result.fileCount,
})}\n`)
