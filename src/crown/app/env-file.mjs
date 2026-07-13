import fs from 'node:fs'
import path from 'node:path'

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1)
    }
  }
  return text
}

function parseEnvLine(line) {
  const text = String(line || '').trim()
  if (!text || text.startsWith('#')) return null
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) return null
  return [match[1], unquote(match[2])]
}

export function loadProjectEnv({ cwd = process.cwd(), env = process.env, file = '.env' } = {}) {
  const envPath = path.resolve(cwd, file)
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath }

  const text = fs.readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    const [key, value] = parsed
    if (env[key] === undefined) env[key] = value
  }

  return { loaded: true, path: envPath }
}
