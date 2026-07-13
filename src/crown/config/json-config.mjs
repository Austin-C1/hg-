import fs from 'node:fs/promises'
import path from 'node:path'

export async function readJsonConfig(file, defaults, normalize = (value) => value) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return normalize(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return normalize(defaults)
  }
}

export async function writeJsonConfig(file, value, normalize = (item) => item) {
  const normalized = normalize(value)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}
