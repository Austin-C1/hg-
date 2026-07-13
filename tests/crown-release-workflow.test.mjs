import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = '.github/workflows/windows-release-build.yml'

async function workflowSource() {
  return readFile(workflowPath, 'utf8')
}

function stepBlock(source, name) {
  const marker = `      - name: ${name}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  const next = source.indexOf('\n      - name:', start + marker.length)
  return source.slice(start, next === -1 ? source.length : next)
}

test('Windows release workflow has narrow manual, main, and version-tag triggers', async () => {
  const source = await workflowSource()
  assert.match(source, /^name: Windows unsigned portable build$/m)
  assert.match(source, /^on:\r?\n  workflow_dispatch:\r?\n  push:\r?\n    branches:\r?\n      - main\r?\n    tags:\r?\n      - 'v\*'$/m)
  assert.doesNotMatch(source, /pull_request_target|schedule:|repository_dispatch:/)
  assert.match(source, /^permissions:\r?\n  contents: read$/m)
  assert.doesNotMatch(source, /^\s+(?:actions|checks|contents|deployments|id-token|packages|pull-requests|security-events|statuses): write$/m)
  assert.match(source, /^    runs-on: windows-2022$/m)
})

test('all GitHub actions are immutable commit pins and checkout drops credentials', async () => {
  const source = await workflowSource()
  const uses = [...source.matchAll(/^\s+uses:\s*([^\s#]+).*$/gm)].map((match) => match[1])
  assert.deepEqual(uses.map((value) => value.split('@')[0]), [
    'actions/checkout',
    'actions/setup-node',
    'actions/upload-artifact',
  ])
  for (const value of uses) assert.match(value, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/i)
  const checkout = source.match(/uses: actions\/checkout@[a-f0-9]{40}(?<body>[\s\S]*?)(?=\n      - name:)/i)
  assert.match(checkout?.groups?.body || '', /persist-credentials: false/)
})

test('clean checkout installs and verifies the complete backend and frontend build', async () => {
  const source = await workflowSource()
  assert.match(source, /node-version: '22\.23\.1'/)
  for (const command of [
    'npm ci',
    'npm --prefix frontend ci',
    'npm test',
    'npm run check',
    'npm --prefix frontend test',
    'npm --prefix frontend run build',
  ]) assert.match(source, new RegExp(`^          ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), command)
  assert.match(source, /git diff --exit-code -- \./)
  assert.match(source, /git status --porcelain=v1 --untracked-files=all/)
})

test('portable Node and Chromium are fixed, checksum-verified before extraction, and lock-matched', async () => {
  const source = await workflowSource()
  const runtimeLock = JSON.parse(await readFile('release/windows-runtime-lock.json', 'utf8'))
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'))

  assert.match(source, /NODE_VERSION: '22\.23\.1'/)
  assert.match(source, /NODE_SHA256: '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29'/)
  assert.match(source, /NODE_URL: 'https:\/\/nodejs\.org\/dist\/v22\.23\.1\/node-v22\.23\.1-win-x64\.zip'/)
  assert.match(source, /CHROMIUM_BROWSER_VERSION: '149\.0\.7827\.55'/)
  assert.match(source, /CHROMIUM_REVISION: '1228'/)
  assert.match(source, /CHROMIUM_SHA256: 'ebc0c2b75e2ea98151a7f18ff47037bfcbab44a8660e79b9ffa6520f9b7607ab'/)
  assert.match(source, /CHROMIUM_URL: 'https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/149\.0\.7827\.55\/win64\/chrome-win64\.zip'/)
  assert.doesNotMatch(source, /cdn\.playwright\.dev/)
  assert.equal(runtimeLock.node.version, '22.23.1')
  assert.equal(runtimeLock.chromium.playwrightVersion, packageJson.dependencies.playwright)
  assert.equal(runtimeLock.chromium.browserVersion, '149.0.7827.55')
  assert.equal(runtimeLock.chromium.revision, '1228')

  const prepare = stepBlock(source, 'Prepare checksum-verified portable runtimes')
  for (const variable of ['NODE', 'CHROMIUM']) {
    const hash = prepare.indexOf(`Get-FileHash -LiteralPath $${variable.toLowerCase()}Archive -Algorithm SHA256`)
    const expand = prepare.indexOf(`Expand-Archive -LiteralPath $${variable.toLowerCase()}Archive`)
    assert.ok(hash >= 0 && expand > hash, `${variable} must be hash-checked before extraction`)
  }
  assert.match(prepare, /runtime lock does not match pinned workflow inputs/)
  assert.match(prepare, /Playwright package does not match runtime lock/)
})

test('workflow stages and audits only an unsigned artifact without signing or publishing', async () => {
  const source = await workflowSource()
  assert.match(source, /npm run release:portable -- --version \$releaseVersion --node-runtime "\$nodeRuntime" --chromium-runtime "\$chromiumRuntime" --out "\$releaseRoot"/)
  assert.match(source, /npm run release:audit -- --root "\$releaseRoot"/)
  assert.match(source, /Compress-Archive -Path "\$releaseRoot\\\*" -DestinationPath "\$artifactPath"/)
  assert.match(source, /name: crown-windows-portable-unsigned-/)
  assert.match(source, /path: output\/crown-windows-portable-unsigned-\$\{\{ steps\.release\.outputs\.version \}\}\.zip/)
  assert.match(source, /if-no-files-found: error/)
  assert.match(source, /include-hidden-files: false/)
  assert.doesNotMatch(source, /secrets\.|GITHUB_TOKEN|github\.token|PRIVATE KEY|private[-_ ]?key|signtool|manifest-sign|gh release|create-release|softprops|release-action/i)
})

test('tag builds must exactly match the package version and the workflow never auto-releases', async () => {
  const source = await workflowSource()
  const validate = stepBlock(source, 'Validate source ref and release version')
  assert.match(validate, /if \("\$env:GITHUB_REF_TYPE" -eq 'tag' -and "\$env:GITHUB_REF_NAME" -cne "v\$releaseVersion"\)/)
  assert.match(validate, /tag must exactly match package version/)
  assert.doesNotMatch(source, /^\s*release:/m)
  assert.doesNotMatch(source, /permissions:[\s\S]*contents: write/)
})
