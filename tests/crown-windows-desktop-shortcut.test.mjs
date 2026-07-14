import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const shortcutScript = path.join(repoRoot, 'packaging', 'windows', 'launcher', 'ensure-desktop-shortcut.ps1')
const powershell = 'powershell.exe'

function psArgs(script, extra = []) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra]
}

async function runPowerShell(script, extra = []) {
  const child = spawn(powershell, psArgs(script, extra), {
    cwd: os.tmpdir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { code, stdout, stderr }
}

function packageRoot(base, name) {
  const root = path.join(base, name)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '启动程序.cmd'), '@echo off\r\n')
  fs.writeFileSync(path.join(root, '皇冠抓水投注.ico'), Buffer.from([0, 0, 1, 0]))
  return root
}

function compact(result) {
  return `${result.stdout}\n${result.stderr}`.replace(/\s/g, '')
}

async function inspectShortcut(t, shortcutPath) {
  const probe = path.join(path.dirname(shortcutPath), `inspect-${process.pid}-${Date.now()}.ps1`)
  const output = `${probe}.json`
  fs.writeFileSync(probe, `
param(
  [Parameter(Mandatory = $true)][string]$ShortcutPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
try {
  $result = [ordered]@{
    targetPath = $shortcut.TargetPath
    workingDirectory = $shortcut.WorkingDirectory
    iconLocation = $shortcut.IconLocation
    description = $shortcut.Description
    windowStyle = $shortcut.WindowStyle
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($OutputPath, $result, [Text.UTF8Encoding]::new($false))
}
finally {
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
`)
  t.after(() => {
    fs.rmSync(probe, { force: true })
    fs.rmSync(output, { force: true })
  })
  const result = await runPowerShell(probe, ['-ShortcutPath', shortcutPath, '-OutputPath', output])
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  return JSON.parse(fs.readFileSync(output, 'utf8'))
}

test('shortcut script defaults to the redirected Windows Desktop API without a user-profile path', () => {
  const source = fs.readFileSync(shortcutScript, 'utf8')
  assert.match(source, /\[Environment\]::GetFolderPath\(['"]Desktop['"]\)/)
  assert.doesNotMatch(source, /USERPROFILE|\\Desktop(?:\\|['"])/i)
})

test('shortcut creation is idempotent and corrects every field after the Portable root moves', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '皇冠 快捷方式测试 '))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const desktop = path.join(base, '重定向 桌面')
  fs.mkdirSync(desktop)
  const firstRoot = packageRoot(base, '第一份 Portable')
  const secondRoot = packageRoot(base, '移动后的 Portable')
  const shortcutPath = path.join(desktop, '皇冠抓水投注.lnk')

  for (const root of [firstRoot, firstRoot, secondRoot]) {
    const result = await runPowerShell(shortcutScript, ['-PackageRoot', root, '-DesktopPath', desktop])
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(fs.readdirSync(desktop).filter((name) => name.endsWith('.lnk')), ['皇冠抓水投注.lnk'])
  }

  const shortcut = await inspectShortcut(t, shortcutPath)
  assert.equal(path.normalize(shortcut.targetPath), path.join(secondRoot, '启动程序.cmd'))
  assert.equal(path.normalize(shortcut.workingDirectory), secondRoot)
  assert.equal(path.normalize(shortcut.iconLocation.replace(/,\s*0$/, '')), path.join(secondRoot, '皇冠抓水投注.ico'))
  assert.equal(shortcut.description, '启动皇冠抓水投注')
  assert.equal(shortcut.windowStyle, 1)
})

test('shortcut script rejects missing target or icon without touching the redirected Desktop', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '皇冠 快捷方式缺失测试 '))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const desktop = path.join(base, 'Desktop')
  fs.mkdirSync(desktop)
  const root = packageRoot(base, 'Portable')

  fs.rmSync(path.join(root, '启动程序.cmd'))
  const missingTarget = await runPowerShell(shortcutScript, ['-PackageRoot', root, '-DesktopPath', desktop])
  assert.notEqual(missingTarget.code, 0)
  assert.match(compact(missingTarget), /desktop-shortcut-target-missing/)
  assert.deepEqual(fs.readdirSync(desktop), [])

  fs.writeFileSync(path.join(root, '启动程序.cmd'), '@echo off\r\n')
  fs.rmSync(path.join(root, '皇冠抓水投注.ico'))
  const missingIcon = await runPowerShell(shortcutScript, ['-PackageRoot', root, '-DesktopPath', desktop])
  assert.notEqual(missingIcon.code, 0)
  assert.match(compact(missingIcon), /desktop-shortcut-icon-missing/)
  assert.deepEqual(fs.readdirSync(desktop), [])
})
