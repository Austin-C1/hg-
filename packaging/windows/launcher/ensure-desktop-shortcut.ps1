#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot,
  [string]$DesktopPath = [Environment]::GetFolderPath('Desktop')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Throw-ShortcutError {
  param([Parameter(Mandatory = $true)][string]$Code)
  throw [InvalidOperationException]::new($Code)
}

function Get-FullyQualifiedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Code
  )
  $driveQualified = $Value -match '^[A-Za-z]:[\\/]'
  $completeUnc = $Value -match '^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+(?:\\|$)'
  if (-not $driveQualified -and -not $completeUnc) { Throw-ShortcutError $Code }
  try { return [IO.Path]::GetFullPath($Value) } catch { Throw-ShortcutError $Code }
}

$temporaryPath = $null
$backupPath = $null
$shell = $null
$shortcut = $null

try {
  $root = Get-FullyQualifiedPath -Value $PackageRoot -Code 'desktop-shortcut-package-root-invalid'
  if (-not [IO.Directory]::Exists($root)) { Throw-ShortcutError 'desktop-shortcut-package-root-invalid' }

  $desktop = Get-FullyQualifiedPath -Value $DesktopPath -Code 'desktop-shortcut-desktop-invalid'
  if (-not [IO.Directory]::Exists($desktop)) { Throw-ShortcutError 'desktop-shortcut-desktop-invalid' }

  $targetPath = [IO.Path]::GetFullPath((Join-Path -Path $root -ChildPath '启动程序.cmd'))
  $iconPath = [IO.Path]::GetFullPath((Join-Path -Path $root -ChildPath '皇冠抓水投注.ico'))
  if ([IO.Path]::GetDirectoryName($targetPath) -cne $root) { Throw-ShortcutError 'desktop-shortcut-target-invalid' }
  if ([IO.Path]::GetDirectoryName($iconPath) -cne $root) { Throw-ShortcutError 'desktop-shortcut-icon-invalid' }
  if (-not [IO.File]::Exists($targetPath)) { Throw-ShortcutError 'desktop-shortcut-target-missing' }
  if (-not [IO.File]::Exists($iconPath)) { Throw-ShortcutError 'desktop-shortcut-icon-missing' }
  if (([IO.File]::GetAttributes($targetPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-ShortcutError 'desktop-shortcut-target-invalid'
  }
  if (([IO.File]::GetAttributes($iconPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Throw-ShortcutError 'desktop-shortcut-icon-invalid'
  }

  $finalPath = Join-Path -Path $desktop -ChildPath '皇冠抓水投注.lnk'
  if ([IO.Directory]::Exists($finalPath)) { Throw-ShortcutError 'desktop-shortcut-destination-invalid' }
  if ([IO.File]::Exists($finalPath) -and
    (([IO.File]::GetAttributes($finalPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Throw-ShortcutError 'desktop-shortcut-destination-invalid'
  }

  $temporaryPath = Join-Path -Path $desktop -ChildPath ('.皇冠抓水投注.' + [guid]::NewGuid().ToString('N') + '.lnk')
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($temporaryPath)
  $shortcut.TargetPath = $targetPath
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = $iconPath + ',0'
  $shortcut.WindowStyle = 1
  $shortcut.Description = '启动皇冠抓水投注'
  $shortcut.Save()
  if (-not [IO.File]::Exists($temporaryPath)) { Throw-ShortcutError 'desktop-shortcut-create-failed' }

  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  $shortcut = $null
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  $shell = $null

  if ([IO.File]::Exists($finalPath)) {
    $backupPath = Join-Path -Path $desktop -ChildPath ('.皇冠抓水投注.backup.' + [guid]::NewGuid().ToString('N') + '.lnk')
    [IO.File]::Replace($temporaryPath, $finalPath, $backupPath, $true)
    [IO.File]::Delete($backupPath)
    $backupPath = $null
  }
  else {
    [IO.File]::Move($temporaryPath, $finalPath)
  }
  $temporaryPath = $null
}
catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^desktop-shortcut-[a-z0-9-]+$') { $code = 'desktop-shortcut-create-failed' }
  throw [InvalidOperationException]::new($code)
}
finally {
  if ($null -ne $shortcut) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) } catch {} }
  if ($null -ne $shell) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) } catch {} }
  if ($null -ne $temporaryPath -and [IO.File]::Exists($temporaryPath)) { try { [IO.File]::Delete($temporaryPath) } catch {} }
  if ($null -ne $backupPath -and [IO.File]::Exists($backupPath)) { try { [IO.File]::Delete($backupPath) } catch {} }
}
