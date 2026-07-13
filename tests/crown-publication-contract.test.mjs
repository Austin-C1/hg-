import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const supersededFiles = [
  'scripts/crown-bet-bootstrap.mjs',
  'scripts/crown-bet-execute.mjs',
  'scripts/crown-bet-execute-sequence.mjs',
  'scripts/crown-betting-candidate-dry-run.mjs',
  'src/crown/betting/crown-bet-adapter.mjs',
  'src/betting/audit-log.mjs',
  'src/betting/bet-intent.mjs',
  'src/betting/risk-guard.mjs',
  'src/betting/README.md',
  'tests/betting-audit-log.test.mjs',
  'tests/betting-bet-intent.test.mjs',
  'tests/betting-risk-guard.test.mjs',
  'tests/crown-bet-adapter.test.mjs',
  'tests/crown-bet-bootstrap.test.mjs',
  'tests/crown-bet-execute-cli.test.mjs',
  'tests/crown-bet-execute-sequence.test.mjs',
  'tests/crown-betting-candidate-dry-run.test.mjs',
]

const canonicalFiles = [
  'scripts/crown-betting-worker.mjs',
  'src/crown/betting/crown-account-execution-provider.mjs',
  'src/crown/betting/crown-bet-response-parser.mjs',
  'src/crown/betting/crown-capability-matrix.mjs',
  'src/crown/betting/crown-order-field-mapper.mjs',
  'src/crown/betting/dynamic-card-migration.mjs',
  'tests/crown-betting-security-audit.test.mjs',
  'tests/crown-capability-matrix.test.mjs',
]

const forbiddenRoots = [
  '.playwright-cli/',
  'output/',
  '参考平博例子/',
  '平博升级版/',
]

const supersededPackageScripts = [
  'crown:betting:bootstrap',
  'crown:betting:execute',
  'crown:betting:execute-sequence',
  'crown:betting:candidate-dry-run',
]

function repositoryPath(relativePath) {
  return path.join(repositoryRoot, relativePath)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('public source has no superseded betting CLI entrypoints', () => {
  for (const file of supersededFiles) {
    assert.equal(existsSync(repositoryPath(file)), false, file)
  }
})

test('canonical betting worker, capability gate, and migration compatibility stay published', () => {
  for (const file of canonicalFiles) {
    assert.equal(existsSync(repositoryPath(file)), true, file)
  }
})

test('package scripts do not restore superseded betting entrypoints', () => {
  const packageJson = JSON.parse(readFileSync(repositoryPath('package.json'), 'utf8'))
  for (const name of supersededPackageScripts) {
    assert.equal(Object.hasOwn(packageJson.scripts || {}, name), false, name)
  }
})

test('local runtime and reference programs stay ignored', () => {
  for (const ignoreFile of ['.gitignore', '.dockerignore']) {
    const ignored = readFileSync(repositoryPath(ignoreFile), 'utf8')
    for (const name of forbiddenRoots) {
      assert.match(ignored, new RegExp(`(?:^|\\n)${escapeRegExp(name)}(?:\\r?\\n|$)`), `${ignoreFile}: ${name}`)
    }
  }
})
