import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

export function toProjectRelativePath(filePath, root = process.cwd()) {
  const resolved = path.resolve(root, filePath)
  const relative = path.relative(root, resolved)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/')
  }
  return resolved
}

function parseJsonlLines(lines) {
  const records = []
  let parseErrors = 0

  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      parseErrors += 1
    }
  }

  return { records, parseErrors }
}

async function readRecentLines(filePath, maxLines) {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const chunkSize = 64 * 1024
    const chunks = []
    let position = stat.size
    let newlineCount = 0

    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position)
      position -= readSize
      const buffer = Buffer.alloc(readSize)
      const { bytesRead } = await handle.read(buffer, 0, readSize, position)
      const chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk)
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1
      }
    }

    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return {
      lines: lines.slice(-maxLines),
      truncated: position > 0 || lines.length > maxLines,
    }
  } finally {
    await handle.close()
  }
}

export async function readJsonlFile(filePath, { root = process.cwd(), maxLines = 0 } = {}) {
  const displayPath = toProjectRelativePath(filePath, root)

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {
      path: displayPath,
      exists: false,
      lineCount: 0,
      parseErrors: 0,
      updatedAt: null,
      truncated: false,
      records: [],
    }
  }

  const limit = Number(maxLines)
  const recent = Number.isFinite(limit) && limit > 0
    ? await readRecentLines(filePath, Math.floor(limit))
    : null
  const lines = recent?.lines ?? (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const { records, parseErrors } = parseJsonlLines(lines)

  return {
    path: displayPath,
    exists: true,
    lineCount: lines.length,
    parseErrors,
    updatedAt: stat.mtime.toISOString(),
    truncated: Boolean(recent?.truncated),
    records,
  }
}

export async function readJsonlFileFiltered(filePath, {
  root = process.cwd(),
  limit = 0,
  predicate = () => true,
} = {}) {
  const displayPath = toProjectRelativePath(filePath, root)

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {
      path: displayPath,
      exists: false,
      lineCount: 0,
      parseErrors: 0,
      updatedAt: null,
      truncated: false,
      records: [],
    }
  }

  const maxRecords = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 0
  const records = []
  let lineCount = 0
  let parseErrors = 0
  let matchedCount = 0

  const reader = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const rawLine of reader) {
    const line = rawLine.trim()
    if (!line) continue
    lineCount += 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      parseErrors += 1
      continue
    }
    if (!predicate(record)) continue
    matchedCount += 1
    records.push(record)
    if (maxRecords && records.length > maxRecords) records.shift()
  }

  return {
    path: displayPath,
    exists: true,
    lineCount,
    parseErrors,
    updatedAt: stat.mtime.toISOString(),
    truncated: Boolean(maxRecords && matchedCount > maxRecords),
    records,
  }
}
