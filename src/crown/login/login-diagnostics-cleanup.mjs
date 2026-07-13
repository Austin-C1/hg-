import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { sanitizeLoginDiagnosticSnapshot } from './crown-login-diagnostics.mjs'

const DEFAULT_ROOT = 'data/runtime/login-diagnostics'

function cleanupError(code) {
  return Object.assign(new Error(code), { code })
}

function ensureRootBoundary(rootDir) {
  const resolved = path.resolve(String(rootDir || DEFAULT_ROOT))
  if (path.basename(resolved).toLowerCase() !== 'login-diagnostics') throw cleanupError('login-diagnostics-root')
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw cleanupError('login-diagnostics-root')
  }
  return resolved
}

function assertInside(rootDir, target) {
  const relative = path.relative(rootDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw cleanupError('login-diagnostics-boundary')
  return target
}

function pathDigest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
}

function safeRelativePath(name) {
  const match = String(name).match(/^(\d{8}-\d{6})-(.+)$/)
  if (match) return `${match[1]}-[id:${pathDigest(match[2])}]`
  return `[path:${pathDigest(name)}]`
}

function safeJson(snapshot) {
  return `${JSON.stringify(sanitizeLoginDiagnosticSnapshot(snapshot), null, 2)}\n`
}

function atomicWrite(file, contents) {
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.snapshot-${process.pid}-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true })
  }
}

function readSnapshot(file) {
  if (!fs.existsSync(file)) return { raw: '', parsed: {}, found: false, malformed: false, linked: false }
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { raw: '', parsed: {}, found: true, malformed: true, linked: stat.isSymbolicLink() }
  }
  const raw = fs.readFileSync(file, 'utf8')
  try {
    return { raw, parsed: JSON.parse(raw), found: true, malformed: false, linked: false }
  } catch {
    return { raw, parsed: {}, found: true, malformed: true, linked: false }
  }
}

function removeEntry(rootDir, target) {
  assertInside(rootDir, target)
  fs.rmSync(target, { recursive: true, force: true })
}

function processRunDirectory(rootDir, entry, apply) {
  const runDir = assertInside(rootDir, path.join(rootDir, entry.name))
  const snapshotPath = assertInside(rootDir, path.join(runDir, 'snapshot.json'))
  const snapshot = readSnapshot(snapshotPath)
  const sanitized = safeJson(snapshot.parsed)
  const needsRewrite = snapshot.raw !== sanitized || snapshot.linked
  const artifacts = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((child) => child.name !== 'snapshot.json')

  let rewritten = 0
  let removed = 0
  if (apply) {
    if (needsRewrite) {
      if (snapshot.linked && fs.existsSync(snapshotPath)) removeEntry(rootDir, snapshotPath)
      atomicWrite(snapshotPath, sanitized)
      rewritten = 1
    }
    for (const artifact of artifacts) {
      removeEntry(rootDir, path.join(runDir, artifact.name))
      removed += 1
    }
  }

  return {
    item: {
      relativePath: safeRelativePath(entry.name),
      snapshotStatus: snapshot.malformed ? 'malformed' : (needsRewrite ? 'rewrite_required' : 'safe'),
      artifactCount: artifacts.length,
    },
    found: snapshot.found ? 1 : 0,
    malformed: snapshot.malformed ? 1 : 0,
    needsRewrite: needsRewrite ? 1 : 0,
    rewritten,
    artifactsFound: artifacts.length,
    artifactsRemoved: removed,
  }
}

export function runLoginDiagnosticsCleanup({ rootDir = DEFAULT_ROOT, apply = false } = {}) {
  if (typeof apply !== 'boolean') throw cleanupError('cleanup-apply-boolean')
  const root = ensureRootBoundary(rootDir)
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    root: 'login-diagnostics',
    exists: fs.existsSync(root),
    directoriesScanned: 0,
    snapshotsFound: 0,
    snapshotsMalformed: 0,
    snapshotsNeedingRewrite: 0,
    snapshotsRewritten: 0,
    sensitiveArtifactsFound: 0,
    sensitiveArtifactsRemoved: 0,
    skippedLinks: 0,
    items: [],
  }
  if (!report.exists) return report

  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const target = assertInside(root, path.join(root, entry.name))
    if (entry.isSymbolicLink()) {
      report.skippedLinks += 1
      continue
    }
    if (!entry.isDirectory()) {
      report.sensitiveArtifactsFound += 1
      if (apply) {
        removeEntry(root, target)
        report.sensitiveArtifactsRemoved += 1
      }
      continue
    }
    const result = processRunDirectory(root, entry, apply)
    report.directoriesScanned += 1
    report.snapshotsFound += result.found
    report.snapshotsMalformed += result.malformed
    report.snapshotsNeedingRewrite += result.needsRewrite
    report.snapshotsRewritten += result.rewritten
    report.sensitiveArtifactsFound += result.artifactsFound
    report.sensitiveArtifactsRemoved += result.artifactsRemoved
    report.items.push(result.item)
  }
  report.items.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return report
}

function optionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw cleanupError(`${name.replace(/^--/, '')}-value-required`)
    return inlineValue
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw cleanupError(`${name.replace(/^--/, '')}-value-required`)
  return value
}

export function parseCleanupArgs(argv = []) {
  const result = { rootDir: DEFAULT_ROOT, apply: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    const equalIndex = raw.indexOf('=')
    const name = equalIndex >= 0 ? raw.slice(0, equalIndex) : raw
    const inlineValue = equalIndex >= 0 ? raw.slice(equalIndex + 1) : undefined
    if (name === '--apply') {
      if (inlineValue !== undefined) throw cleanupError('apply-value-not-allowed')
      result.apply = true
    }
    else if (name === '--dir') {
      result.rootDir = optionValue(argv, index, name, inlineValue)
      if (inlineValue === undefined) index += 1
    } else if (name === '--help' || name === '-h') result.help = true
    else throw cleanupError('unknown-argument')
  }
  return result
}

export const LOGIN_DIAGNOSTICS_CLEANUP_DEFAULT_ROOT = DEFAULT_ROOT
