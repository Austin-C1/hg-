import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { downloadAsset } from '../src/crown/update/download-asset.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function chunkedResponse(chunks, { interruptAfter } = {}) {
  let index = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (interruptAfter === index) {
        controller.error(new Error('socket interrupted with Authorization secret'))
        return
      }
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index++])
    },
  }))
}

test('download streams through allowed redirects, verifies size and sha256, then atomically publishes the file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('verified update bytes')
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options })
    if (new URL(url).host === 'github.test') return new Response(null, { status: 307, headers: { location: 'https://assets.test/update.zip' } })
    return chunkedResponse([bytes.subarray(0, 5), bytes.subarray(5)])
  }

  const destinationPath = join(root, 'update.zip')
  const result = await downloadAsset({
    url: 'https://github.test/update.zip',
    destinationPath,
    expectedSize: bytes.length,
    expectedSha256: sha256(bytes),
    maxBytes: bytes.length,
    allowedHosts: ['github.test', 'assets.test'],
    fetchImpl,
  })

  assert.deepEqual(await readFile(destinationPath), Buffer.from(bytes))
  const published = await lstat(destinationPath, { bigint: true })
  assert.deepEqual(result, {
    path: destinationPath,
    size: bytes.length,
    sha256: sha256(bytes),
    publishedIdentity: { dev: published.dev, ino: published.ino },
  })
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.options.redirect, 'manual')
    assert.equal(new Headers(request.options.headers).has('authorization'), false)
  }
  assert.deepEqual(await readdir(root), ['update.zip'])
})

test('download rejects streamed bytes over the signed size limit and removes partial files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destinationPath = join(root, 'update.zip')
  const bytes = new TextEncoder().encode('123456')

  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip',
    destinationPath,
    expectedSize: 5,
    expectedSha256: sha256(bytes.subarray(0, 5)),
    maxBytes: 5,
    allowedHosts: ['assets.test'],
    fetchImpl: async () => chunkedResponse([bytes.subarray(0, 3), bytes.subarray(3)]),
  }), /update-asset-too-large/)

  assert.deepEqual(await readdir(root), [])
})

test('download rejects signed size and hash mismatches without replacing an existing destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('payload')

  const sizePath = join(root, 'size.zip')
  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip', destinationPath: sizePath,
    expectedSize: bytes.length + 1, expectedSha256: sha256(bytes), maxBytes: 100,
    allowedHosts: ['assets.test'], fetchImpl: async () => chunkedResponse([bytes]),
  }), /update-asset-size-mismatch/)

  const hashPath = join(root, 'hash.zip')
  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip', destinationPath: hashPath,
    expectedSize: bytes.length, expectedSha256: '0'.repeat(64), maxBytes: 100,
    allowedHosts: ['assets.test'], fetchImpl: async () => chunkedResponse([bytes]),
  }), /update-asset-sha256-mismatch/)

  const existingPath = join(root, 'existing.zip')
  await writeFile(existingPath, 'old')
  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip', destinationPath: existingPath,
    expectedSize: bytes.length, expectedSha256: sha256(bytes), maxBytes: 100,
    allowedHosts: ['assets.test'], fetchImpl: async () => chunkedResponse([bytes]),
  }), /update-asset-destination-exists/)
  assert.equal(await readFile(existingPath, 'utf8'), 'old')
})

test('download sanitizes interrupted streams and blocks unsafe redirect hops', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('payload')
  const interruptedPath = join(root, 'interrupted.zip')

  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip', destinationPath: interruptedPath,
    expectedSize: bytes.length, expectedSha256: sha256(bytes), maxBytes: 100,
    allowedHosts: ['assets.test'], fetchImpl: async () => chunkedResponse([bytes], { interruptAfter: 0 }),
  }), (error) => error.message === 'update-asset-download-failed')

  const redirectedPath = join(root, 'redirected.zip')
  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip', destinationPath: redirectedPath,
    expectedSize: bytes.length, expectedSha256: sha256(bytes), maxBytes: 100,
    allowedHosts: ['assets.test'], fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://assets.test.evil.invalid/update.zip' } }),
  }), /github-release-redirect-not-allowed/)

  assert.deepEqual(await readdir(root), [])
})

test('download timeout covers a stalled response body and destination paths must be absolute', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const expectedSha256 = sha256(new Uint8Array())

  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip',
    destinationPath: 'relative-update.zip',
    expectedSize: 0,
    expectedSha256,
    maxBytes: 0,
    allowedHosts: ['assets.test'],
    fetchImpl: async () => assert.fail('relative path must fail before network access'),
  }), /update-asset-destination-invalid/)

  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      const deadline = setTimeout(() => controller.error(new Error('test-deadline')), 40)
      signal.addEventListener('abort', () => {
        clearTimeout(deadline)
        controller.error(signal.reason)
      }, { once: true })
    },
  }))
  await assert.rejects(downloadAsset({
    url: 'https://assets.test/update.zip',
    destinationPath: join(root, 'stalled.zip'),
    expectedSize: 1,
    expectedSha256: '0'.repeat(64),
    maxBytes: 1,
    allowedHosts: ['assets.test'],
    fetchImpl,
    timeoutMs: 10,
  }), /update-asset-timeout/)
  assert.deepEqual(await readdir(root), [])
})

test('download rejects Windows root-relative and device namespace destinations before network access', async () => {
  for (const destinationPath of ['\\root-relative.zip', '/root-relative.zip', 'C:drive-relative.zip', '\\\\?\\C:\\device.zip', '\\\\.\\C:\\device.zip']) {
    await assert.rejects(downloadAsset({
      url: 'https://assets.test/update.zip',
      destinationPath,
      expectedSize: 0,
      expectedSha256: sha256(new Uint8Array()),
      maxBytes: 0,
      allowedHosts: ['assets.test'],
      fetchImpl: async () => assert.fail('invalid path must fail before network access'),
    }), /update-asset-destination-invalid/)
  }
})

test('download reopens the published path and rejects a replaced partial pathname', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'crown-update-download-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode('verified update bytes that must survive publication')
  let releaseTail
  const tailGate = new Promise((resolve) => { releaseTail = resolve })
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(bytes.subarray(0, 8))
      await tailGate
      controller.enqueue(bytes.subarray(8))
      controller.close()
    },
  }))
  const destinationPath = join(root, 'update.zip')
  const downloading = downloadAsset({
    url: 'https://assets.test/update.zip',
    destinationPath,
    expectedSize: bytes.length,
    expectedSha256: sha256(bytes),
    maxBytes: bytes.length,
    allowedHosts: ['assets.test'],
    fetchImpl: async () => response,
  })

  let partialPath
  for (let attempt = 0; attempt < 200 && !partialPath; attempt += 1) {
    partialPath = (await readdir(root)).map((name) => join(root, name)).find((name) => name.endsWith('.partial'))
    if (!partialPath) await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.ok(partialPath, 'partial path should become visible while the verified handle is open')
  await rm(partialPath, { force: true })
  await writeFile(partialPath, 'ATTACKER')
  releaseTail()

  await assert.rejects(downloading, /update-asset-published-mismatch/)
  assert.deepEqual(await readdir(root), ['update.zip'])
  assert.equal(await readFile(destinationPath, 'utf8'), 'ATTACKER')
})
