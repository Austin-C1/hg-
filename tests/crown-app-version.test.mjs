import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { APP_VERSION } from '../src/crown/app/app-version.mjs'

test('application version is the strict SemVer declared by package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  assert.equal(APP_VERSION, packageJson.version)
  assert.match(APP_VERSION, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
})

test('application version is loaded from root package.json through a module-relative URL', async () => {
  const source = fs.readFileSync(new URL('../src/crown/app/app-version.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /export\s+const\s+APP_VERSION\s*=\s*['"]/)
  assert.match(source, /new URL\(['"]\.\.\/\.\.\/\.\.\/package\.json['"],\s*import\.meta\.url\)/)

  const originalCwd = process.cwd()
  try {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'crown-version-cwd-')))
    const moduleUrl = new URL(`../src/crown/app/app-version.mjs?cwd=${Date.now()}`, import.meta.url)
    const imported = await import(moduleUrl)
    assert.equal(imported.APP_VERSION, APP_VERSION)
  } finally {
    process.chdir(originalCwd)
  }
})

test('application version loader rejects a non-strict package SemVer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-version-invalid-'))
  const moduleDir = path.join(root, 'src', 'crown', 'app')
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '01.2.3' }), 'utf8')
  fs.copyFileSync(
    new URL('../src/crown/app/app-version.mjs', import.meta.url),
    path.join(moduleDir, 'app-version.mjs'),
  )

  await assert.rejects(
    import(`${pathToFileURL(path.join(moduleDir, 'app-version.mjs')).href}?invalid=${Date.now()}`),
    /app-version-invalid/,
  )
})
