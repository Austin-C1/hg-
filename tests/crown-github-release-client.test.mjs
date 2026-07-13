import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchHttpsWithRedirects, fetchReleaseManifestPair } from '../src/crown/update/github-release-client.mjs'

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { location } })
}

test('release client locates only the exact manifest pair and follows each redirect manually without authorization', async () => {
  const requests = []
  const previousToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'must-not-be-sent'

  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options })
    const pathname = new URL(url).pathname
    if (pathname === '/repos/Austin-C1/hg-/releases/latest') {
      return jsonResponse({
        tag_name: 'v0.1.1',
        assets: [
          { name: 'CrownMonitor-v0.1.1-update.zip', size: 999, browser_download_url: 'https://github.test/download/update.zip' },
          { name: 'update-manifest.json', size: 123, browser_download_url: 'https://github.test/download/manifest' },
          { name: 'update-manifest.sig', size: 64, browser_download_url: 'https://github.test/download/signature' },
        ],
      })
    }
    if (pathname === '/download/manifest') return redirectResponse('https://assets.test/manifest')
    if (pathname === '/download/signature') return redirectResponse('https://assets.test/signature')
    if (pathname === '/manifest') return new Response('{"signed":true}')
    if (pathname === '/signature') return new Response(new Uint8Array([1, 2, 3]))
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    const result = await fetchReleaseManifestPair({
      releaseApiUrl: 'https://api.test/repos/Austin-C1/hg-/releases/latest',
      manifestAssetName: 'update-manifest.json',
      signatureAssetName: 'update-manifest.sig',
      allowedHosts: ['api.test', 'github.test', 'assets.test'],
      fetchImpl,
    })

    assert.equal(result.releaseTag, 'v0.1.1')
    assert.equal(new TextDecoder().decode(result.manifestBytes), '{"signed":true}')
    assert.deepEqual(result.signatureBytes, new Uint8Array([1, 2, 3]))
    assert.deepEqual(result.manifestAsset, { name: 'update-manifest.json', size: 123 })
    assert.deepEqual(result.signatureAsset, { name: 'update-manifest.sig', size: 64 })
    assert.equal(requests.length, 5)
    for (const request of requests) {
      assert.equal(request.options.redirect, 'manual')
      assert.equal(request.options.credentials, 'omit')
      assert.equal(new Headers(request.options.headers).has('authorization'), false)
    }
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousToken
  }
})

test('release client rejects non-HTTPS and non-allowlisted initial or redirect hosts', async () => {
  const base = {
    manifestAssetName: 'manifest.json',
    signatureAssetName: 'manifest.sig',
    allowedHosts: ['api.test', 'github.test', 'assets.test'],
  }

  await assert.rejects(
    fetchReleaseManifestPair({ ...base, releaseApiUrl: 'http://api.test/release', fetchImpl: async () => assert.fail('network must not run') }),
    /github-release-url-not-allowed/,
  )
  await assert.rejects(
    fetchReleaseManifestPair({ ...base, releaseApiUrl: 'https://api.test.evil.invalid/release', fetchImpl: async () => assert.fail('network must not run') }),
    /github-release-url-not-allowed/,
  )

  const release = jsonResponse({
    tag_name: 'v1.0.0',
    assets: [
      { name: 'manifest.json', size: 2, browser_download_url: 'https://github.test/manifest' },
      { name: 'manifest.sig', size: 2, browser_download_url: 'https://github.test/signature' },
    ],
  })
  const fetchImpl = async (url) => new URL(url).host === 'api.test' ? release.clone() : redirectResponse('http://assets.test/file')
  await assert.rejects(
    fetchReleaseManifestPair({ ...base, releaseApiUrl: 'https://api.test/release', fetchImpl }),
    /github-release-redirect-not-allowed/,
  )
})

test('release client rejects missing, duplicate, and unbounded manifest metadata', async () => {
  const invoke = (assets) => fetchReleaseManifestPair({
    releaseApiUrl: 'https://api.test/release',
    manifestAssetName: 'manifest.json',
    signatureAssetName: 'manifest.sig',
    allowedHosts: ['api.test'],
    fetchImpl: async () => jsonResponse({ tag_name: 'v1.0.0', assets }),
  })

  await assert.rejects(invoke([]), /github-release-assets-invalid/)
  await assert.rejects(invoke([
    { name: 'manifest.json', size: 1, browser_download_url: 'https://api.test/a' },
    { name: 'manifest.json', size: 1, browser_download_url: 'https://api.test/b' },
    { name: 'manifest.sig', size: 1, browser_download_url: 'https://api.test/c' },
  ]), /github-release-assets-invalid/)
  await assert.rejects(invoke([
    { name: 'manifest.json', size: 2_000_000, browser_download_url: 'https://api.test/a' },
    { name: 'manifest.sig', size: 1, browser_download_url: 'https://api.test/b' },
  ]), /github-release-asset-too-large/)
})

test('release client aborts on timeout and sanitizes interrupted network failures', async () => {
  const options = {
    releaseApiUrl: 'https://api.test/release',
    manifestAssetName: 'manifest.json',
    signatureAssetName: 'manifest.sig',
    allowedHosts: ['api.test'],
    timeoutMs: 10,
  }
  const never = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  await assert.rejects(fetchReleaseManifestPair({ ...options, fetchImpl: never }), /github-release-timeout/)

  await assert.rejects(
    fetchReleaseManifestPair({ ...options, fetchImpl: async () => { throw new Error('socket failed with token=secret') } }),
    (error) => error.message === 'github-release-network-error',
  )
})

test('release client timeout remains active while a response body is stalled', async () => {
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      const deadline = setTimeout(() => controller.error(new Error('test-deadline')), 40)
      signal.addEventListener('abort', () => {
        clearTimeout(deadline)
        controller.error(signal.reason)
      }, { once: true })
    },
  }))

  await assert.rejects(fetchReleaseManifestPair({
    releaseApiUrl: 'https://api.test/release',
    manifestAssetName: 'manifest.json',
    signatureAssetName: 'manifest.sig',
    allowedHosts: ['api.test'],
    fetchImpl,
    timeoutMs: 10,
  }), /github-release-timeout/)
})

test('release client cancels redirect and error bodies and dispose aborts an unused success response', async () => {
  let redirectCancelled = false
  let errorCancelled = false
  let successCancelled = false
  const body = (markCancelled) => new ReadableStream({
    pull() {},
    cancel() { markCancelled() },
  })
  const responses = [
    new Response(body(() => { redirectCancelled = true }), { status: 302, headers: { location: 'https://assets.test/final' } }),
    new Response(body(() => { errorCancelled = true }), { status: 503 }),
  ]
  await assert.rejects(fetchHttpsWithRedirects({
    url: 'https://api.test/start',
    allowedHosts: ['api.test', 'assets.test'],
    fetchImpl: async () => responses.shift(),
  }), /github-release-http-503/)
  assert.equal(redirectCancelled, true)
  assert.equal(errorCancelled, true)

  const request = await fetchHttpsWithRedirects({
    url: 'https://api.test/success',
    allowedHosts: ['api.test'],
    fetchImpl: async () => new Response(body(() => { successCancelled = true })),
  })
  await request.dispose()
  assert.equal(request.signal.aborted, true)
  assert.equal(successCancelled, true)
})
