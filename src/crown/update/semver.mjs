const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseSemver(value) {
  if (typeof value !== 'string') {
    throw new TypeError('semver must be a string')
  }
  const match = SEMVER_PATTERN.exec(value)
  if (!match) {
    throw new TypeError('semver is invalid')
  }

  const parsed = {
    raw: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  }
  Object.freeze(parsed.prerelease)
  Object.freeze(parsed.build)
  return Object.freeze(parsed)
}

function compareIdentifier(left, right) {
  if (left === right) return 0
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && !rightNumeric) return -1
  if (!leftNumeric && rightNumeric) return 1
  if (leftNumeric) {
    return BigInt(left) < BigInt(right) ? -1 : 1
  }
  return left < right ? -1 : 1
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left)
  const parsedRight = parseSemver(right)

  for (const field of ['major', 'minor', 'patch']) {
    const leftValue = BigInt(parsedLeft[field])
    const rightValue = BigInt(parsedRight[field])
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0
  if (parsedLeft.prerelease.length === 0) return 1
  if (parsedRight.prerelease.length === 0) return -1

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= parsedLeft.prerelease.length) return -1
    if (index >= parsedRight.prerelease.length) return 1
    const result = compareIdentifier(parsedLeft.prerelease[index], parsedRight.prerelease[index])
    if (result !== 0) return result
  }
  return 0
}
