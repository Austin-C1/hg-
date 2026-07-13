import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  launchPortableChromium,
  profileDirectoryForAccount,
} from '../src/crown/login/portable-chromium.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-portable-chromium-'))
  const appRoot = path.join(root, 'app-root')
  const dataRoot = path.join(root, 'data-root')
  const executablePath = path.join(appRoot, 'versions', '0.1.0', 'runtime', 'chromium', 'chrome.exe')
  const profileRoot = path.join(dataRoot, 'runtime', 'browser-profiles')
  fs.mkdirSync(path.dirname(executablePath), { recursive: true })
  fs.mkdirSync(profileRoot, { recursive: true })
  fs.writeFileSync(executablePath, 'fake chromium executable')
  return { root, appRoot, dataRoot, executablePath, profileRoot }
}

function fakeChromium() {
  const page = { kind: 'page' }
  const context = {
    pages: () => [],
    async newPage() { return page },
  }
  const calls = []
  return {
    calls,
    context,
    page,
    async launchPersistentContext(profileDir, options) {
      calls.push({ profileDir, options })
      return context
    },
  }
}

test('launches only the bundled executable with a visible persistent account profile', async (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))
  const chromium = fakeChromium()

  const result = await launchPortableChromium({
    chromium,
    appRoot: paths.appRoot,
    dataRoot: paths.dataRoot,
    executablePath: paths.executablePath,
    profileRoot: paths.profileRoot,
    accountId: 'monitor-A',
  })

  assert.equal(result.context, chromium.context)
  assert.equal(result.page, chromium.page)
  assert.equal(chromium.calls.length, 1)
  assert.equal(chromium.calls[0].options.executablePath, fs.realpathSync(paths.executablePath))
  assert.equal(chromium.calls[0].options.headless, false)
  assert.equal(chromium.calls[0].options.acceptDownloads, false)
  assert.equal(Object.hasOwn(chromium.calls[0].options, 'channel'), false)
  assert.equal(fs.realpathSync(chromium.calls[0].profileDir).startsWith(fs.realpathSync(paths.profileRoot)), true)
})
test('uses stable isolated profile directories without putting raw account ids in paths', (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))

  const first = profileDirectoryForAccount({
    dataRoot: paths.dataRoot,
    profileRoot: paths.profileRoot,
    accountId: 'monitor-A',
  })
  const again = profileDirectoryForAccount({
    dataRoot: paths.dataRoot,
    profileRoot: paths.profileRoot,
    accountId: 'monitor-A',
  })
  const other = profileDirectoryForAccount({
    dataRoot: paths.dataRoot,
    profileRoot: paths.profileRoot,
    accountId: 'monitor-B',
  })

  assert.equal(first, again)
  assert.notEqual(first, other)
  assert.doesNotMatch(first, /monitor-A/i)
})

test('rejects system or escaped executables and profiles outside their declared roots', async (t) => {
  const paths = fixture()
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }))
  const outsideExecutable = path.join(paths.root, 'system-chrome.exe')
  const outsideProfiles = path.join(paths.root, 'outside-profiles')
  fs.writeFileSync(outsideExecutable, 'system browser')
  fs.mkdirSync(outsideProfiles)

  await assert.rejects(() => launchPortableChromium({
    chromium: fakeChromium(),
    appRoot: paths.appRoot,
    dataRoot: paths.dataRoot,
    executablePath: outsideExecutable,
    profileRoot: paths.profileRoot,
    accountId: 'monitor-A',
  }), /portable-chromium-executable-outside-app-root/)

  await assert.rejects(() => launchPortableChromium({
    chromium: fakeChromium(),
    appRoot: paths.appRoot,
    dataRoot: paths.dataRoot,
    executablePath: paths.executablePath,
    profileRoot: outsideProfiles,
    accountId: 'monitor-A',
  }), /portable-chromium-profile-outside-data-root/)
})
