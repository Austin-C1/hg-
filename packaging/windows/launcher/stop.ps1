#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateRange(1, 120)]
  [int]$StopTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StrictSemVer = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
$InstallationIdPattern = '^[A-Za-z0-9_-]{8,128}$'
$TokenPattern = '^[A-Za-z0-9_-]{43}$'
$AppRoot = [IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))

function Throw-LauncherError {
  param([Parameter(Mandatory = $true)][string]$Code)
  throw [InvalidOperationException]::new($Code)
}

function Assert-FullyQualifiedPath {
  param([string]$Value, [string]$Code)
  $driveQualified = $Value -match '^[A-Za-z]:[\\/]'
  $completeUnc = $Value -match '^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+(?:\\|$)'
  if (-not $driveQualified -and -not $completeUnc) { Throw-LauncherError $Code }
  return [IO.Path]::GetFullPath($Value)
}

function Assert-PathWithin {
  param([string]$Root, [string]$Candidate, [string]$Code)
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $normalizedCandidate = [IO.Path]::GetFullPath($Candidate)
  if ($normalizedCandidate -ne $normalizedRoot -and -not $normalizedCandidate.StartsWith($normalizedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Throw-LauncherError $Code
  }
  return $normalizedCandidate
}

function Assert-NoReparsePath {
  param([string]$Path, [bool]$RequireLeaf = $false)
  $full = Assert-FullyQualifiedPath -Value $Path -Code 'launcher-path-invalid'
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  $segments = $full.Substring($root.Length).Split(@('\'), [StringSplitOptions]::RemoveEmptyEntries)
  for ($index = 0; $index -lt $segments.Length; $index += 1) {
    $current = Join-Path -Path $current -ChildPath $segments[$index]
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) {
      if ($RequireLeaf -and $index -eq $segments.Length - 1) { Throw-LauncherError 'launcher-path-missing' }
      continue
    }
    if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Throw-LauncherError 'launcher-reparse-forbidden'
    }
  }
  return $full
}

function New-CryptoToken {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Write-AtomicUtf8Json {
  param([string]$Path, $Value)
  $directory = [IO.Path]::GetDirectoryName($Path)
  Assert-NoReparsePath -Path $directory -RequireLeaf $true | Out-Null
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = Join-Path -Path $directory -ChildPath ('.launcher-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Compress -Depth 8) + "`n")
  $stream = $null
  try {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $null, $true) }
    else { [IO.File]::Move($temporary, $Path) }
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Read-LauncherState {
  param([string]$Path)
  if (-not [IO.File]::Exists($Path)) { return $null }
  try {
    $state = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $keys = @($state.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'installationId,launchNonce,pid,port,processStartTime,schemaVersion,stopToken,version' -or
      $state.schemaVersion -ne 1 -or [string]$state.installationId -notmatch $InstallationIdPattern -or
      [string]$state.launchNonce -notmatch $TokenPattern -or [string]$state.stopToken -notmatch $TokenPattern -or
      [string]$state.launchNonce -eq [string]$state.stopToken -or
      [string]$state.version -notmatch $StrictSemVer -or [int64]$state.port -lt 1 -or [int64]$state.port -gt 65535 -or
      [int64]$state.pid -lt 1 -or [int64]$state.pid -gt [int]::MaxValue) { Throw-LauncherError 'launcher-state-invalid' }
    $parsedStart = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact([string]$state.processStartTime, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$parsedStart)) {
      Throw-LauncherError 'launcher-state-invalid'
    }
    return $state
  }
  catch {
    if ($_.Exception.Message -eq 'launcher-state-invalid') { throw }
    Throw-LauncherError 'launcher-state-invalid'
  }
}

function Read-InstallationId {
  param([string]$Path)
  if (-not [IO.File]::Exists($Path)) { Throw-LauncherError 'launcher-installation-identity-missing' }
  try {
    $identity = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $keys = @($identity.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'installationId,schemaVersion' -or $identity.schemaVersion -ne 1 -or [string]$identity.installationId -notmatch $InstallationIdPattern) {
      Throw-LauncherError 'launcher-installation-identity-invalid'
    }
    return [string]$identity.installationId
  }
  catch {
    if ($_.Exception.Message -eq 'launcher-installation-identity-invalid') { throw }
    Throw-LauncherError 'launcher-installation-identity-invalid'
  }
}

function Get-ProcessStartTime {
  param($Process)
  return $Process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function Get-Health {
  param([int]$Port, [string]$Probe)
  $response = $null
  $reader = $null
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/health")
    $request.Method = 'GET'
    $request.Headers.Add('x-crown-launcher-probe', $Probe)
    $request.Proxy = $null
    $request.Timeout = 1000
    $request.ReadWriteTimeout = 1000
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 16384) { return $null }
    $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8, $true, 1024, $false)
    $body = $reader.ReadToEnd()
    if ($body.Length -gt 16384) { return $null }
    return $body | ConvertFrom-Json
  }
  catch { return $null }
  finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Write-LauncherLog {
  param([string]$Code)
  try {
    [IO.Directory]::CreateDirectory($LogDir) | Out-Null
    $line = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + ' ' + $Code + [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $line, [Text.UTF8Encoding]::new($false))
  }
  catch {}
}

$LogDir = $null
$LogFile = $null

try {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Throw-LauncherError 'launcher-localappdata-invalid' }
  $LocalAppData = Assert-FullyQualifiedPath -Value $env:LOCALAPPDATA -Code 'launcher-localappdata-invalid'
  Assert-NoReparsePath -Path $LocalAppData -RequireLeaf $true | Out-Null
  $DataRoot = Join-Path -Path $LocalAppData -ChildPath 'CrownMonitor'
  $RuntimeDir = Join-Path -Path $DataRoot -ChildPath 'runtime'
  $StateFile = Join-Path -Path $RuntimeDir -ChildPath 'launcher-state.json'
  $StopRequestFile = Join-Path -Path $RuntimeDir -ChildPath 'launcher-stop-request.json'
  $LogDir = Join-Path -Path $DataRoot -ChildPath 'logs'
  $LogFile = Join-Path -Path $LogDir -ChildPath 'launcher.log'
  foreach ($candidate in @($RuntimeDir, $StateFile, $StopRequestFile, $LogDir)) {
    Assert-PathWithin -Root $DataRoot -Candidate $candidate -Code 'launcher-data-path-outside-data-root' | Out-Null
  }
  Assert-NoReparsePath -Path $DataRoot -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $RuntimeDir -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $StateFile -RequireLeaf $false | Out-Null
  $State = Read-LauncherState $StateFile
  if ($null -eq $State) {
    Write-Output 'launcher-not-running'
    exit 0
  }

  $InstallationId = Read-InstallationId (Join-Path -Path $DataRoot -ChildPath 'installation.json')
  if ([string]$State.installationId -ne $InstallationId) { Throw-LauncherError 'launcher-installation-mismatch' }

  try { $Process = Get-Process -Id ([int]$State.pid) -ErrorAction Stop }
  catch { Throw-LauncherError 'launcher-process-not-running' }
  if ((Get-ProcessStartTime $Process) -ne [string]$State.processStartTime) {
    Throw-LauncherError 'launcher-process-identity-mismatch'
  }

  Assert-NoReparsePath -Path $StateFile -RequireLeaf $true | Out-Null
  $Probe = New-CryptoToken
  $Health = Get-Health -Port ([int]$State.port) -Probe $Probe
  if ($null -eq $Health -or $Health.ok -ne $true -or [string]$Health.app -ne 'crown-dashboard' -or
    [string]$Health.installationId -ne $InstallationId -or [string]$Health.version -ne [string]$State.version -or
    [string]$Health.launchNonce -cne [string]$State.launchNonce -or [int]$Health.launcherPid -ne [int]$State.pid -or
    [string]$Health.launcherProcessStartTime -cne [string]$State.processStartTime -or [string]$Health.launcherProbe -cne $Probe -or
    [string]::IsNullOrWhiteSpace([string]$Health.appContractVersion)) {
    Throw-LauncherError 'launcher-health-mismatch'
  }

  $request = [ordered]@{
    schemaVersion = 1
    installationId = $InstallationId
    pid = [int]$State.pid
    processStartTime = [string]$State.processStartTime
    launchNonce = [string]$State.launchNonce
    stopToken = [string]$State.stopToken
  }
  Assert-NoReparsePath -Path $DataRoot -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $RuntimeDir -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $StateFile -RequireLeaf $true | Out-Null
  Write-AtomicUtf8Json -Path $StopRequestFile -Value $request

  $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try { $candidate = Get-Process -Id ([int]$State.pid) -ErrorAction Stop }
    catch { $candidate = $null }
    if ($null -eq $candidate -or (Get-ProcessStartTime $candidate) -ne [string]$State.processStartTime) { break }
    Start-Sleep -Milliseconds 100
  }
  try { $remaining = Get-Process -Id ([int]$State.pid) -ErrorAction Stop }
  catch { $remaining = $null }
  if ($null -ne $remaining -and (Get-ProcessStartTime $remaining) -eq [string]$State.processStartTime) {
    Throw-LauncherError 'launcher-stop-timeout'
  }

  $current = Read-LauncherState $StateFile
  if ($null -ne $current -and [int]$current.pid -eq [int]$State.pid -and [string]$current.processStartTime -eq [string]$State.processStartTime) {
    [IO.File]::Delete($StateFile)
  }
  if ([IO.File]::Exists($StopRequestFile)) { [IO.File]::Delete($StopRequestFile) }
  Write-LauncherLog 'launcher-stopped'
  Write-Output 'launcher-stopped'
  exit 0
}
catch {
  $code = if ([string]::IsNullOrWhiteSpace($_.Exception.Message)) { 'launcher-stop-failed' } else { $_.Exception.Message }
  Write-LauncherLog $code
  Write-Error $code -ErrorAction Continue
  exit 1
}
