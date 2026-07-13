import fs from 'node:fs'
import path from 'node:path'

function requiredPath(value, field) {
  const text = String(value || '').trim()
  if (!text) throw new TypeError(`${field}-required`)
  if (text === ':memory:') throw new TypeError(`${field}-persistent-required`)
  return text
}

function realpathIncludingMissingLeaf(value, cwd) {
  const resolved = path.resolve(cwd, value)
  let current = resolved
  const missing = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    missing.push(path.basename(current))
    current = parent
  }
  const canonicalParent = fs.realpathSync.native(current)
  return path.normalize(path.join(canonicalParent, ...missing.reverse()))
}

function comparablePath(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function watcherLeaseKey({ dbPath, runtimeDir, cwd = process.cwd() } = {}) {
  const database = comparablePath(realpathIncludingMissingLeaf(requiredPath(dbPath, 'watcher-db'), cwd))
  const runtime = comparablePath(realpathIncludingMissingLeaf(requiredPath(runtimeDir, 'watcher-runtime'), cwd))
  return `watcher:${database}:${runtime}`
}
