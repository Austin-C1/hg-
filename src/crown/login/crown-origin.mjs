import { isIP } from 'node:net'

const NON_PUBLIC_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'corp',
  'localdomain',
  'home.arpa',
  'test',
  'example',
  'invalid',
  'onion',
]

function fail(code) {
  throw new Error(code)
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
}

function publicHostname(hostname) {
  if (!hostname || hostname.endsWith('.') || hostname.length > 253) return false
  const labels = hostname.split('.')
  if (labels.length < 2) return false
  if (labels.some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ))) return false
  return !NON_PUBLIC_SUFFIXES.some((suffix) => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ))
}

export function normalizePublicHttpsExactOrigin(value) {
  const raw = String(value ?? '').trim()
  if (!raw) fail('crown-origin-required')

  let url
  try {
    url = new URL(raw)
  } catch {
    fail('crown-origin-invalid')
  }

  if (url.username || url.password) fail('crown-origin-credentials-forbidden')
  if (url.protocol !== 'https:') fail('crown-origin-https-required')

  const hostname = unbracket(url.hostname).toLowerCase()
  if (isIP(hostname) !== 0) fail('crown-origin-ip-forbidden')
  if (!publicHostname(hostname)) fail('crown-origin-public-host-required')

  if (url.pathname !== '/' || url.search || url.hash || raw !== url.origin) {
    fail('crown-origin-exact-required')
  }
  return url.origin
}

export default normalizePublicHttpsExactOrigin
