#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const INCLUDED_DIRS = ['scripts', 'src', 'tests']
const SKIPPED_DIRS = new Set(['node_modules', 'data', 'docs'])

function walk(dir, files) {
  if (!fs.existsSync(dir)) return

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), files)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(path.join(dir, entry.name))
    }
  }
}

export function findMjsFiles(root = process.cwd()) {
  const files = []
  for (const dir of INCLUDED_DIRS) {
    walk(path.join(root, dir), files)
  }
  return files.sort()
}

export function checkSyntax(files = findMjsFiles()) {
  const failures = []
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) {
      failures.push({
        file,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    }
  }
  return failures
}

function main() {
  const files = findMjsFiles()
  const failures = checkSyntax(files)

  if (failures.length) {
    for (const failure of failures) {
      console.error(`Syntax check failed: ${failure.file}`)
      if (failure.stdout) console.error(failure.stdout.trim())
      if (failure.stderr) console.error(failure.stderr.trim())
    }
    process.exitCode = 1
    return
  }

  console.log(`Syntax OK: ${files.length} .mjs files`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
