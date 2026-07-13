#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StrictSemVer = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
$IdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
$TokenPattern = '^[A-Za-z0-9_-]{43}$'

function Throw-UpdateBootstrapError {
  param([Parameter(Mandatory = $true)][string]$Code)
  throw [InvalidOperationException]::new($Code)
}

function Assert-FullyQualifiedPath {
  param([string]$Value, [string]$Code)
  $driveQualified = $Value -match '^[A-Za-z]:[\\/]'
  $completeUnc = $Value -match '^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+(?:\\|$)'
  if (-not $driveQualified -and -not $completeUnc) { Throw-UpdateBootstrapError $Code }
  return [IO.Path]::GetFullPath($Value)
}

function Assert-PathWithin {
  param([string]$Root, [string]$Candidate, [string]$Code)
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $normalizedCandidate = [IO.Path]::GetFullPath($Candidate)
  if ($normalizedCandidate -ne $normalizedRoot -and -not $normalizedCandidate.StartsWith($normalizedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Throw-UpdateBootstrapError $Code
  }
  return $normalizedCandidate
}

function Assert-NoReparsePath {
  param([string]$Path, [bool]$RequireLeaf = $false)
  $full = Assert-FullyQualifiedPath -Value $Path -Code 'update-bootstrap-path-invalid'
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  $segments = $full.Substring($root.Length).Split(@('\'), [StringSplitOptions]::RemoveEmptyEntries)
  for ($index = 0; $index -lt $segments.Length; $index += 1) {
    $current = Join-Path -Path $current -ChildPath $segments[$index]
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) {
      if ($RequireLeaf -and $index -eq $segments.Length - 1) { Throw-UpdateBootstrapError 'update-bootstrap-path-missing' }
      continue
    }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-UpdateBootstrapError 'update-bootstrap-reparse-forbidden' }
  }
  return $full
}

function Clear-UntrustedUpdaterEnvironment {
  $names = @([Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys)
  foreach ($nameValue in $names) {
    $name = [string]$nameValue
    if ($name -match '^(?:CROWN_|NODE_|OPENSSL_)' -or $name -match '^(?:SSLKEYLOGFILE|SSL_CERT_FILE|SSL_CERT_DIR)$') {
      [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
    }
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($RequestPath)) { Throw-UpdateBootstrapError 'update-bootstrap-request-required' }
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Throw-UpdateBootstrapError 'update-bootstrap-localappdata-required' }
  $AppRoot = [IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))
  $LocalAppData = Assert-FullyQualifiedPath -Value $env:LOCALAPPDATA -Code 'update-bootstrap-localappdata-invalid'
  $DataRoot = [IO.Path]::GetFullPath((Join-Path -Path $LocalAppData -ChildPath 'CrownMonitor'))
  $UpdateRoot = Join-Path -Path $DataRoot -ChildPath 'updates'
  $ExactRequestPath = Assert-FullyQualifiedPath -Value $RequestPath -Code 'update-bootstrap-request-path-invalid'
  Assert-PathWithin -Root $UpdateRoot -Candidate $ExactRequestPath -Code 'update-bootstrap-request-outside-data-root' | Out-Null
  foreach ($pathValue in @($AppRoot, $LocalAppData, $DataRoot, $UpdateRoot, $ExactRequestPath)) {
    Assert-NoReparsePath -Path $pathValue -RequireLeaf ($pathValue -eq $ExactRequestPath) | Out-Null
  }

  try { $Request = [IO.File]::ReadAllText($ExactRequestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch {
    Throw-UpdateBootstrapError 'update-bootstrap-request-invalid'
  }
  $keys = @($Request.PSObject.Properties.Name | Sort-Object)
  if (($keys -join ',') -ne 'appRoot,backupPath,candidateIdentity,candidateVersion,currentPath,dataRoot,dbPath,expectedVersion,installationId,journalPath,oldProcess,operation,previousVersion,schemaVersion,updateId' -or
    $Request.schemaVersion -ne 1 -or [string]$Request.operation -ne 'apply' -or
    [string]$Request.installationId -notmatch $IdPattern -or [string]$Request.updateId -notmatch $IdPattern -or
    [string]$Request.previousVersion -notmatch $StrictSemVer -or [string]$Request.candidateVersion -notmatch $StrictSemVer -or
    [string]$Request.expectedVersion -cne [string]$Request.candidateVersion) {
    Throw-UpdateBootstrapError 'update-bootstrap-request-invalid'
  }
  $identityKeys = @($Request.candidateIdentity.PSObject.Properties.Name | Sort-Object)
  if (($identityKeys -join ',') -ne 'dev,ino' -or
    [string]$Request.candidateIdentity.dev -notmatch '^(0|[1-9][0-9]*)$' -or
    [string]$Request.candidateIdentity.ino -notmatch '^(0|[1-9][0-9]*)$') {
    Throw-UpdateBootstrapError 'update-bootstrap-request-invalid'
  }
  if ([IO.Path]::GetFullPath([string]$Request.appRoot) -cne $AppRoot -or
    [IO.Path]::GetFullPath([string]$Request.dataRoot) -cne $DataRoot -or
    [IO.Path]::GetFullPath([string]$Request.currentPath) -cne (Join-Path -Path $AppRoot -ChildPath 'current.json')) {
    Throw-UpdateBootstrapError 'update-bootstrap-request-binding-invalid'
  }
  foreach ($dataPath in @([string]$Request.journalPath, [string]$Request.dbPath, [string]$Request.backupPath)) {
    Assert-PathWithin -Root $DataRoot -Candidate $dataPath -Code 'update-bootstrap-request-binding-invalid' | Out-Null
    Assert-NoReparsePath -Path $dataPath -RequireLeaf $false | Out-Null
  }
  $old = $Request.oldProcess
  $oldKeys = @($old.PSObject.Properties.Name | Sort-Object)
  $parsedStart = [DateTime]::MinValue
  if (($oldKeys -join ',') -ne 'installationId,pid,probeToken,processInstanceId,processStartTime' -or
    [int64]$old.pid -lt 1 -or [int64]$old.pid -gt [int]::MaxValue -or
    [string]$old.installationId -cne [string]$Request.installationId -or
    [string]$old.processInstanceId -notmatch $IdPattern -or [string]$old.probeToken -notmatch $TokenPattern -or
    -not [DateTime]::TryParseExact([string]$old.processStartTime, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$parsedStart)) {
    Throw-UpdateBootstrapError 'update-bootstrap-request-invalid'
  }

  $PreviousRoot = Join-Path -Path (Join-Path -Path $AppRoot -ChildPath 'versions') -ChildPath ([string]$Request.previousVersion)
  $NodeExe = Join-Path -Path $PreviousRoot -ChildPath 'runtime\node\node.exe'
  $UpdaterScript = Join-Path -Path $PreviousRoot -ChildPath 'app\scripts\crown-update-apply.mjs'
  foreach ($packagePath in @($PreviousRoot, $NodeExe, $UpdaterScript)) {
    Assert-PathWithin -Root $AppRoot -Candidate $packagePath -Code 'update-bootstrap-package-path-invalid' | Out-Null
    Assert-NoReparsePath -Path $packagePath -RequireLeaf $true | Out-Null
  }

  Clear-UntrustedUpdaterEnvironment
  $env:CROWN_PORTABLE = '1'
  $env:CROWN_APP_ROOT = $AppRoot
  $env:CROWN_DATA_ROOT = $DataRoot
  $env:CROWN_WATCHER_AUTOSTART = '0'
  $env:CROWN_BETTING_WORKER_AUTOSTART = '0'
  $env:CROWN_REAL_BETTING_REQUESTED = '0'
  $env:CROWN_REAL_BETTING_ENABLED = '0'
  $env:CROWN_BETTING_MODE = 'off'
  & $NodeExe $UpdaterScript '--request' $ExactRequestPath
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}
catch {
  $code = if ([string]::IsNullOrWhiteSpace($_.Exception.Message)) { 'update-bootstrap-failed' } else { $_.Exception.Message }
  Write-Error $code -ErrorAction Continue
  exit 1
}
