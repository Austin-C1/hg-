const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function codedError(code) {
  return new Error(code)
}

function hostAllowlist(values) {
  if (!Array.isArray(values) || values.length === 0) throw codedError('github-release-host-allowlist-invalid')
  const hosts = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value !== value.toLowerCase()) {
      throw codedError('github-release-host-allowlist-invalid')
    }
    let parsed
    try {
      parsed = new URL(`https://${value}`)
    } catch {
      throw codedError('github-release-host-allowlist-invalid')
    }
    if (parsed.hostname !== value || parsed.port || parsed.pathname !== '/') {
      throw codedError('github-release-host-allowlist-invalid')
    }
    hosts.add(value)
  }
  return hosts
}

function allowedHttpsUrl(value, hosts, errorCode) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw codedError(errorCode)
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || !hosts.has(parsed.hostname.toLowerCase())
  ) {
    throw codedError(errorCode)
  }
  return parsed
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw codedError(code)
  return value
}

function isCodedError(error) {
  return error instanceof Error && /^(github-release|update-asset)-/.test(error.message)
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel()
  } catch {
    // A fully consumed or actively locked body needs no additional cleanup here.
  }
}

export async function fetchHttpsWithRedirects({
  url,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxRedirects = 5,
  accept = 'application/octet-stream',
} = {}) {
  if (typeof fetchImpl !== 'function') throw codedError('github-release-fetch-invalid')
  positiveInteger(timeoutMs, 'github-release-timeout-invalid')
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw codedError('github-release-redirect-limit-invalid')
  }
  const hosts = hostAllowlist(allowedHosts)
  let currentUrl = allowedHttpsUrl(url, hosts, 'github-release-url-not-allowed')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(codedError('github-release-timeout')), timeoutMs)
  let activeResponse

  try {
    for (let redirects = 0; ; redirects += 1) {
      let response
      try {
        response = await fetchImpl(currentUrl.href, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
          headers: {
            accept,
            'user-agent': 'CrownMonitor-Updater',
          },
        })
      } catch (error) {
        if (controller.signal.aborted) throw codedError('github-release-timeout')
        if (isCodedError(error)) throw error
        throw codedError('github-release-network-error')
      }

      if (!response || typeof response.status !== 'number' || !response.headers) {
        throw codedError('github-release-response-invalid')
      }
      activeResponse = response
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.status < 200 || response.status >= 300) {
          await cancelResponseBody(response)
          activeResponse = undefined
          throw codedError(`github-release-http-${response.status}`)
        }
        return {
          response,
          finalUrl: currentUrl.href,
          signal: controller.signal,
          dispose: async () => {
            clearTimeout(timer)
            if (!controller.signal.aborted) controller.abort(codedError('github-release-disposed'))
            await cancelResponseBody(response)
            activeResponse = undefined
          },
        }
      }
      await cancelResponseBody(response)
      activeResponse = undefined
      if (redirects >= maxRedirects) throw codedError('github-release-too-many-redirects')
      const location = response.headers.get('location')
      if (!location) throw codedError('github-release-redirect-invalid')
      let next
      try {
        next = new URL(location, currentUrl)
      } catch {
        throw codedError('github-release-redirect-not-allowed')
      }
      currentUrl = allowedHttpsUrl(next, hosts, 'github-release-redirect-not-allowed')
    }
  } catch (error) {
    clearTimeout(timer)
    await cancelResponseBody(activeResponse)
    if (!controller.signal.aborted) controller.abort(codedError('github-release-disposed'))
    throw error
  }
}

async function readBoundedBytes(response, maxBytes, signal) {
  positiveInteger(maxBytes, 'github-release-byte-limit-invalid')
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw codedError('github-release-content-length-invalid')
    if (parsed > maxBytes) throw codedError('github-release-response-too-large')
  }

  if (!response.body) return new Uint8Array()
  const chunks = []
  let total = 0
  try {
    for await (const chunk of response.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      total += bytes.byteLength
      if (total > maxBytes) throw codedError('github-release-response-too-large')
      chunks.push(bytes)
    }
  } catch (error) {
    if (signal?.aborted) throw codedError('github-release-timeout')
    if (isCodedError(error)) throw error
    throw codedError('github-release-network-error')
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function fetchBoundedBytes(options, maxBytes) {
  const request = await fetchHttpsWithRedirects(options)
  try {
    return await readBoundedBytes(request.response, maxBytes, request.signal)
  } finally {
    await request.dispose()
  }
}

function exactAsset(assets, name, maxBytes) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) {
    throw codedError('github-release-asset-name-invalid')
  }
  const matches = assets.filter((asset) => asset?.name === name)
  if (matches.length !== 1) throw codedError('github-release-assets-invalid')
  const asset = matches[0]
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw codedError('github-release-assets-invalid')
  if (asset.size > maxBytes) throw codedError('github-release-asset-too-large')
  if (typeof asset.browser_download_url !== 'string') throw codedError('github-release-assets-invalid')
  return asset
}

export async function fetchReleaseManifestPair({
  releaseApiUrl,
  manifestAssetName,
  signatureAssetName,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  maxRedirects = 5,
  maxReleaseBytes = 1_048_576,
  maxManifestBytes = 1_048_576,
  maxSignatureBytes = 16_384,
} = {}) {
  if (manifestAssetName === signatureAssetName) throw codedError('github-release-asset-name-invalid')
  const releaseBytes = await fetchBoundedBytes({
    url: releaseApiUrl,
    allowedHosts,
    fetchImpl,
    timeoutMs,
    maxRedirects,
    accept: 'application/vnd.github+json',
  }, maxReleaseBytes)
  let release
  try {
    release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes))
  } catch {
    throw codedError('github-release-json-invalid')
  }
  if (!release || typeof release !== 'object' || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
    throw codedError('github-release-json-invalid')
  }

  const manifest = exactAsset(release.assets, manifestAssetName, maxManifestBytes)
  const signature = exactAsset(release.assets, signatureAssetName, maxSignatureBytes)
  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchBoundedBytes({
      url: manifest.browser_download_url,
      allowedHosts,
      fetchImpl,
      timeoutMs,
      maxRedirects,
      accept: 'application/json',
    }, maxManifestBytes),
    fetchBoundedBytes({
      url: signature.browser_download_url,
      allowedHosts,
      fetchImpl,
      timeoutMs,
      maxRedirects,
      accept: 'application/octet-stream',
    }, maxSignatureBytes),
  ])
  return {
    releaseTag: release.tag_name,
    manifestAsset: { name: manifest.name, size: manifest.size },
    signatureAsset: { name: signature.name, size: signature.size },
    manifestBytes,
    signatureBytes,
  }
}

export { DEFAULT_ALLOWED_HOSTS }
