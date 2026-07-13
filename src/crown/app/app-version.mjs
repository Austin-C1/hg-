import fs from 'node:fs'

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const packageJsonUrl = new URL('../../../package.json', import.meta.url)

function readAppVersion() {
  let packageJson
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8'))
  } catch (error) {
    const wrapped = new Error('app-version-unavailable')
    wrapped.cause = error
    throw wrapped
  }
  if (typeof packageJson?.version !== 'string' || !STRICT_SEMVER.test(packageJson.version)) {
    throw new Error('app-version-invalid')
  }
  return packageJson.version
}

export const APP_VERSION = readAppVersion()
