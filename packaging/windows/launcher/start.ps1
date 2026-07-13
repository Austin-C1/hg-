#requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [ValidateRange(1, 120)]
  [int]$HealthTimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StrictSemVer = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
$InstallationIdPattern = '^[A-Za-z0-9_-]{8,128}$'
$TokenPattern = '^[A-Za-z0-9_-]{43}$'
$AppRoot = [IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))
$CurrentFile = Join-Path -Path $AppRoot -ChildPath 'current.json'

function Throw-LauncherError {
  param([Parameter(Mandatory = $true)][string]$Code)
  throw [InvalidOperationException]::new($Code)
}

function Assert-FullyQualifiedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Code
  )
  $driveQualified = $Value -match '^[A-Za-z]:[\\/]'
  $completeUnc = $Value -match '^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+(?:\\|$)'
  if (-not $driveQualified -and -not $completeUnc) {
    Throw-LauncherError $Code
  }
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
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-LauncherError 'launcher-reparse-forbidden' }
  }
  return $full
}

function New-CryptoToken {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-InstanceMutexName {
  param([string]$InstallationId)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($InstallationId)) } finally { $sha.Dispose() }
  $hex = -join ($digest | ForEach-Object { $_.ToString('x2') })
  return "Local\CrownMonitor-$hex"
}

function Clear-UntrustedChildEnvironment {
  $names = @([Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys)
  foreach ($nameValue in $names) {
    $name = [string]$nameValue
    if ($name -match '^(?:CROWN_|NODE_|OPENSSL_)' -or $name -match '^(?:SSLKEYLOGFILE|SSL_CERT_FILE|SSL_CERT_DIR)$') {
      [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
    }
  }
}

function Read-CanonicalCurrent {
  if (-not [IO.File]::Exists($CurrentFile)) { Throw-LauncherError 'launcher-current-missing' }
  $raw = [IO.File]::ReadAllText($CurrentFile, [Text.Encoding]::UTF8)
  $match = [regex]::Match($raw, '^\s*\{"schemaVersion":1,"version":"([0-9A-Za-z.+-]+)"\}\s*$', [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if (-not $match.Success -or $match.Groups[1].Value -notmatch $StrictSemVer) {
    Throw-LauncherError 'launcher-current-invalid'
  }
  return $match.Groups[1].Value
}

function Read-InstallationId {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  $identityFile = Join-Path -Path $DataRoot -ChildPath 'installation.json'
  if (-not [IO.File]::Exists($identityFile)) { Throw-LauncherError 'launcher-installation-identity-missing' }
  try {
    $identity = [IO.File]::ReadAllText($identityFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
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

function Write-AtomicUtf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $directory = [IO.Path]::GetDirectoryName($Path)
  Assert-NoReparsePath -Path $directory -RequireLeaf $false | Out-Null
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  Assert-NoReparsePath -Path $directory -RequireLeaf $true | Out-Null
  $temporary = Join-Path -Path $directory -ChildPath ('.launcher-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $backup = $null
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Compress -Depth 8) + "`n")
  $stream = $null
  try {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if ([IO.File]::Exists($Path)) {
      $backup = Join-Path -Path $directory -ChildPath ('.launcher-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
      [IO.File]::Replace($temporary, $Path, $backup, $true)
      [IO.File]::Delete($backup)
      $backup = $null
    }
    else {
      [IO.File]::Move($temporary, $Path)
    }
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    if ($null -ne $backup -and [IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
  }
}

function Read-LauncherState {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not [IO.File]::Exists($Path)) { return $null }
  try {
    $state = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $keys = @($state.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'installationId,launchNonce,pid,port,processStartTime,schemaVersion,stopToken,version' -or
      $state.schemaVersion -ne 1 -or [string]$state.installationId -notmatch $InstallationIdPattern -or
      [string]$state.launchNonce -notmatch $TokenPattern -or [string]$state.stopToken -notmatch $TokenPattern -or
      [string]$state.launchNonce -eq [string]$state.stopToken -or
      [string]$state.version -notmatch $StrictSemVer -or
      [int64]$state.port -lt 1 -or [int64]$state.port -gt 65535 -or
      [int64]$state.pid -lt 1 -or [int64]$state.pid -gt [int]::MaxValue) {
      Throw-LauncherError 'launcher-state-invalid'
    }
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

function Verify-PublishedState {
  param([string]$Path, $Expected)
  Assert-NoReparsePath -Path $Path -RequireLeaf $true | Out-Null
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  $published = Read-LauncherState $Path
  foreach ($field in @('schemaVersion', 'installationId', 'version', 'port', 'pid', 'processStartTime', 'launchNonce', 'stopToken')) {
    if ([string]$published.$field -cne [string]$Expected.$field) { Throw-LauncherError 'launcher-state-publish-mismatch' }
  }
  return $published
}

function Get-ProcessStartTime {
  param([Parameter(Mandatory = $true)]$Process)
  return $Process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function Test-ExactProcessIdentity {
  param([Parameter(Mandatory = $true)]$State)
  try {
    $candidate = Get-Process -Id ([int]$State.pid) -ErrorAction Stop
    return (Get-ProcessStartTime $candidate) -eq [string]$State.processStartTime
  }
  catch { return $false }
}

function Get-Health {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Probe,
    [int]$TimeoutMilliseconds = 800
  )
  $response = $null
  $reader = $null
  try {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/health")
    $request.Method = 'GET'
    $request.Headers.Add('x-crown-launcher-probe', $Probe)
    $request.Proxy = $null
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
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

function Test-MatchingHealth {
  param(
    [Parameter(Mandatory = $true)][AllowNull()]$Health,
    [Parameter(Mandatory = $true)][string]$InstallationId,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$LaunchNonce,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ProcessStartTime,
    [Parameter(Mandatory = $true)][string]$Probe
  )
  return $null -ne $Health -and $Health.ok -eq $true -and [string]$Health.app -eq 'crown-dashboard' -and
    [string]$Health.installationId -eq $InstallationId -and [string]$Health.version -eq $Version -and
    [string]$Health.launchNonce -ceq $LaunchNonce -and [int]$Health.launcherPid -eq $ProcessId -and
    [string]$Health.launcherProcessStartTime -ceq $ProcessStartTime -and [string]$Health.launcherProbe -ceq $Probe -and
    -not [string]::IsNullOrWhiteSpace([string]$Health.appContractVersion)
}

function Test-LoopbackPortFree {
  param([Parameter(Mandatory = $true)][int]$Port)
  $listener = $null
  try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Server.ExclusiveAddressUse = $true
    $listener.Start()
    return $true
  }
  catch { return $false }
  finally { if ($null -ne $listener) { $listener.Stop() } }
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Server.ExclusiveAddressUse = $true
  try {
    $listener.Start()
    return [int]([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally { $listener.Stop() }
}

function Quote-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * ($slashes * 2 + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Start-BundledDashboard {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$HostScript,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $NodeExe
  $info.Arguments = Quote-NativeArgument $HostScript
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $false
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { Throw-LauncherError 'launcher-dashboard-start-failed' }
  return $process
}

function Close-ParentLease {
  if ($null -ne $script:parentLeaseStream) {
    try { $script:parentLeaseStream.Dispose() } catch {}
    $script:parentLeaseStream = $null
  }
  if ($null -ne $script:parentLeaseFile -and [IO.File]::Exists($script:parentLeaseFile)) {
    try { [IO.File]::Delete($script:parentLeaseFile) } catch {}
  }
  $script:parentLeaseFile = $null
  if ($null -ne $script:parentAckFile -and [IO.File]::Exists($script:parentAckFile)) {
    try { [IO.File]::Delete($script:parentAckFile) } catch {}
  }
  $script:parentAckFile = $null
}

function Read-StartupClaim {
  $claims = @([IO.Directory]::GetFiles($RuntimeDir, 'launcher-startup-claim*.json', [IO.SearchOption]::TopDirectoryOnly))
  if ($claims.Count -eq 0) { return $null }
  if ($claims.Count -ne 1 -or [IO.Path]::GetFullPath($claims[0]) -cne [IO.Path]::GetFullPath($StartupClaimFile)) {
    Throw-LauncherError 'launcher-startup-claim-multiple'
  }
  Assert-NoReparsePath -Path $StartupClaimFile -RequireLeaf $true | Out-Null
  try {
    $raw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
    $claim = $raw | ConvertFrom-Json
    $keys = @($claim.PSObject.Properties.Name | Sort-Object)
    $kind = [string]$claim.status
    $commonInvalid = $claim.schemaVersion -ne 1 -or [string]$claim.installationId -notmatch $InstallationIdPattern -or
      [string]$claim.version -notmatch $StrictSemVer -or [string]$claim.launchNonce -notmatch $TokenPattern -or
      [string]$claim.parentLeaseToken -notmatch $TokenPattern -or [int64]$claim.parentPid -lt 1 -or [int64]$claim.parentPid -gt [int]::MaxValue
    if ($kind -eq 'reserved') {
      if (($keys -join ',') -ne 'abortPath,childLaunchAuthorized,childProcessStartReturned,installationId,launchNonce,parentLeasePath,parentLeaseToken,parentPid,parentProcessStartTime,schemaVersion,status,version' -or
        $commonInvalid -or $claim.childLaunchAuthorized -isnot [bool] -or $claim.childProcessStartReturned -isnot [bool] -or
        ($claim.childProcessStartReturned -and -not $claim.childLaunchAuthorized)) {
        Throw-LauncherError 'launcher-startup-claim-invalid'
      }
      $timeValues = @([string]$claim.parentProcessStartTime)
    }
    elseif ($kind -eq 'active') {
      if (($keys -join ',') -ne 'abortPath,installationId,launchNonce,parentLeasePath,parentLeaseToken,parentPid,parentProcessStartTime,pid,processStartTime,schemaVersion,status,stopToken,version' -or
        $commonInvalid -or [string]$claim.stopToken -notmatch $TokenPattern -or
        [int64]$claim.pid -lt 1 -or [int64]$claim.pid -gt [int]::MaxValue) {
        Throw-LauncherError 'launcher-startup-claim-invalid'
      }
      $timeValues = @([string]$claim.processStartTime, [string]$claim.parentProcessStartTime)
    }
    else {
      Throw-LauncherError 'launcher-startup-claim-invalid'
    }
    foreach ($timeValue in $timeValues) {
      $parsed = [DateTime]::MinValue
      if (-not [DateTime]::TryParseExact($timeValue, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$parsed)) {
        Throw-LauncherError 'launcher-startup-claim-invalid'
      }
    }
    foreach ($claimPath in @([string]$claim.abortPath, [string]$claim.parentLeasePath)) {
      $fullClaimPath = Assert-FullyQualifiedPath -Value $claimPath -Code 'launcher-startup-claim-invalid'
      Assert-PathWithin -Root $RuntimeDir -Candidate $fullClaimPath -Code 'launcher-startup-claim-path-outside-runtime' | Out-Null
      Assert-NoReparsePath -Path $fullClaimPath -RequireLeaf $false | Out-Null
    }
    return [pscustomobject]@{ Kind = $kind; Value = $claim; Raw = $raw }
  }
  catch {
    if ($_.Exception.Message -like 'launcher-*') { throw }
    Throw-LauncherError 'launcher-startup-claim-invalid'
  }
}

function Write-BoundAbortRequest {
  param($Claim)
  $request = [ordered]@{
    schemaVersion = 1
    installationId = [string]$Claim.installationId
    version = [string]$Claim.version
    pid = [int]$Claim.pid
    processStartTime = [string]$Claim.processStartTime
    launchNonce = [string]$Claim.launchNonce
    stopToken = [string]$Claim.stopToken
    parentLeaseToken = [string]$Claim.parentLeaseToken
  }
  Write-AtomicUtf8Json -Path ([string]$Claim.abortPath) -Value $request
}

function Get-ReservedLeaseStatus {
  param($Claim)
  $leasePath = [string]$Claim.parentLeasePath
  if (-not [IO.File]::Exists($leasePath)) { return [pscustomobject]@{ Held = $false; Valid = $false } }
  Assert-NoReparsePath -Path $leasePath -RequireLeaf $true | Out-Null
  $stream = $null
  try {
    $stream = [IO.FileStream]::new($leasePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
    try { $record = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $keys = @($record.PSObject.Properties.Name | Sort-Object)
    $valid = ($keys -join ',') -eq 'launchNonce,leaseToken,parentPid,parentProcessStartTime,schemaVersion' -and
      $record.schemaVersion -eq 1 -and [int]$record.parentPid -eq [int]$Claim.parentPid -and
      [string]$record.parentProcessStartTime -ceq [string]$Claim.parentProcessStartTime -and
      [string]$record.launchNonce -ceq [string]$Claim.launchNonce -and [string]$record.leaseToken -ceq [string]$Claim.parentLeaseToken
    return [pscustomobject]@{ Held = $false; Valid = $valid }
  }
  catch [IO.IOException] { return [pscustomobject]@{ Held = $true; Valid = $true } }
  catch [UnauthorizedAccessException] { return [pscustomobject]@{ Held = $true; Valid = $true } }
  catch { return [pscustomobject]@{ Held = $false; Valid = $false } }
  finally { if ($null -ne $stream) { $stream.Dispose() } }
}

function Resolve-StartupClaim {
  param([string]$InstallationId, [string]$Version)
  $snapshot = Read-StartupClaim
  if ($null -eq $snapshot) { return }
  $claim = $snapshot.Value
  if ([string]$claim.installationId -cne $InstallationId -or [string]$claim.version -cne $Version) {
    Throw-LauncherError 'launcher-startup-claim-identity-mismatch'
  }
  if ($snapshot.Kind -eq 'reserved') {
    try { $parent = Get-Process -Id ([int]$claim.parentPid) -ErrorAction Stop } catch { $parent = $null }
    $parentExact = $null -ne $parent -and (Get-ProcessStartTime $parent) -ceq [string]$claim.parentProcessStartTime
    $lease = Get-ReservedLeaseStatus -Claim $claim
    if ($parentExact -and $lease.Held) {
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      do {
        Start-Sleep -Milliseconds 100
        if (-not [IO.File]::Exists($StartupClaimFile)) { return }
        $currentRaw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
        if ($currentRaw -cne $snapshot.Raw) {
          Resolve-StartupClaim -InstallationId $InstallationId -Version $Version
          return
        }
      } while ([DateTime]::UtcNow -lt $deadline)
      Throw-LauncherError 'launcher-startup-claim-parent-still-live'
    }
    if ($parentExact -or $lease.Held -or -not $lease.Valid) { Throw-LauncherError 'launcher-startup-claim-reserved-uncertain' }
    if ($claim.childLaunchAuthorized) {
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      do {
        Start-Sleep -Milliseconds 100
        if (-not [IO.File]::Exists($StartupClaimFile)) { return }
        $currentRaw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
        if ($currentRaw -cne $snapshot.Raw) {
          Resolve-StartupClaim -InstallationId $InstallationId -Version $Version
          return
        }
      } while ([DateTime]::UtcNow -lt $deadline)
      Throw-LauncherError 'launcher-startup-claim-reserved-timeout'
    }
    if ([IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8) -cne $snapshot.Raw) { Throw-LauncherError 'launcher-startup-claim-changed' }
    [IO.File]::Delete($StartupClaimFile)
    if ([IO.File]::Exists([string]$claim.abortPath)) { [IO.File]::Delete([string]$claim.abortPath) }
    if ([IO.File]::Exists([string]$claim.parentLeasePath)) { [IO.File]::Delete([string]$claim.parentLeasePath) }
    return
  }
  try { $candidate = Get-Process -Id ([int]$claim.pid) -ErrorAction Stop } catch { $candidate = $null }
  $exactAlive = $null -ne $candidate -and (Get-ProcessStartTime $candidate) -ceq [string]$claim.processStartTime
  if ($exactAlive) {
    Write-BoundAbortRequest -Claim $claim
    $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 100
      try { $candidate = Get-Process -Id ([int]$claim.pid) -ErrorAction Stop } catch { $candidate = $null }
      $exactAlive = $null -ne $candidate -and (Get-ProcessStartTime $candidate) -ceq [string]$claim.processStartTime
    } while ($exactAlive -and [DateTime]::UtcNow -lt $deadline)
    if ($exactAlive) { Throw-LauncherError 'launcher-startup-claim-stop-timeout' }
  }
  if ([IO.File]::Exists($StartupClaimFile)) {
    Assert-NoReparsePath -Path $StartupClaimFile -RequireLeaf $true | Out-Null
    if ([IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8) -cne $snapshot.Raw) {
      Throw-LauncherError 'launcher-startup-claim-changed'
    }
    [IO.File]::Delete($StartupClaimFile)
  }
  if ([IO.File]::Exists([string]$claim.abortPath)) { [IO.File]::Delete([string]$claim.abortPath) }
}

function Remove-OwnStartupClaim {
  param($Expected, [bool]$Require = $true)
  $snapshot = Read-StartupClaim
  if ($null -eq $snapshot) {
    if ($Require) { Throw-LauncherError 'launcher-startup-claim-missing' }
    return
  }
  $claim = $snapshot.Value
  foreach ($field in @('status', 'installationId', 'version', 'pid', 'processStartTime', 'launchNonce', 'stopToken', 'parentPid', 'parentProcessStartTime', 'parentLeasePath', 'parentLeaseToken', 'abortPath')) {
    if ([string]$claim.$field -cne [string]$Expected.$field) { Throw-LauncherError 'launcher-startup-claim-changed' }
  }
  Assert-NoReparsePath -Path $StartupClaimFile -RequireLeaf $true | Out-Null
  if ([IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8) -cne $snapshot.Raw) { Throw-LauncherError 'launcher-startup-claim-changed' }
  [IO.File]::Delete($StartupClaimFile)
}

function Remove-StateIfExact {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ProcessStartTime
  )
  try {
    $current = Read-LauncherState $Path
    if ($null -ne $current -and [int]$current.pid -eq $ProcessId -and [string]$current.processStartTime -eq $ProcessStartTime) {
      [IO.File]::Delete($Path)
    }
  }
  catch {}
}

function Write-LauncherLog {
  param([Parameter(Mandatory = $true)][string]$Code)
  try {
    [IO.Directory]::CreateDirectory($LogDir) | Out-Null
    $line = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture) + ' ' + $Code + [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $line, [Text.UTF8Encoding]::new($false))
  }
  catch {}
}

function Try-ReuseLauncherState {
  param($State, [string]$InstallationId, [string]$Version)
  if ($null -eq $State -or -not (Test-ExactProcessIdentity $State)) { return $false }
  if ([string]$State.installationId -ne $InstallationId -or [string]$State.version -ne $Version) {
    Throw-LauncherError 'launcher-version-conflict'
  }
  $probe = New-CryptoToken
  $health = Get-Health -Port ([int]$State.port) -Probe $probe
  if (-not (Test-MatchingHealth -Health $health -InstallationId $InstallationId -Version $Version -LaunchNonce ([string]$State.launchNonce) -ProcessId ([int]$State.pid) -ProcessStartTime ([string]$State.processStartTime) -Probe $probe)) {
    Throw-LauncherError 'launcher-existing-unhealthy'
  }
  $url = "http://127.0.0.1:$([int]$State.port)/"
  if (-not $NoBrowser) { Start-Process $url | Out-Null }
  $script:ReusedUrl = $url
  Write-LauncherLog 'launcher-reused'
  return $true
}

$DataRoot = $null
$LogDir = $null
$LogFile = $null
$dashboardProcess = $null
$dashboardStartTime = $null
$hostScript = $null
$stateFile = $null
$abortFile = $null
$identityFile = $null
$startupErrorFile = $null
$startupClaim = $null
$startupClaimReservationRaw = $null
$startupClaimReservationOwned = $false
$parentLeaseFile = $null
$parentLeaseStream = $null
$parentAckFile = $null
$singleMutex = $null
$mutexOwned = $false
$ReusedUrl = $null

try {
  Assert-NoReparsePath -Path $AppRoot -RequireLeaf $true | Out-Null
  Assert-PathWithin -Root $AppRoot -Candidate $CurrentFile -Code 'launcher-current-outside-app-root' | Out-Null
  Assert-NoReparsePath -Path $CurrentFile -RequireLeaf $true | Out-Null
  $Version = Read-CanonicalCurrent
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Throw-LauncherError 'launcher-localappdata-required' }
  $LocalAppData = Assert-FullyQualifiedPath -Value $env:LOCALAPPDATA -Code 'launcher-localappdata-invalid'
  Assert-NoReparsePath -Path $LocalAppData -RequireLeaf $true | Out-Null
  $DataRoot = [IO.Path]::GetFullPath((Join-Path -Path $LocalAppData -ChildPath 'CrownMonitor'))
  $LogDir = Join-Path -Path $DataRoot -ChildPath 'logs'
  $LogFile = Join-Path -Path $LogDir -ChildPath 'launcher.log'

  $VersionRoot = Join-Path -Path (Join-Path -Path $AppRoot -ChildPath 'versions') -ChildPath $Version
  $AppDir = Join-Path -Path $VersionRoot -ChildPath 'app'
  $NodeExe = Join-Path -Path $VersionRoot -ChildPath 'runtime\node\node.exe'
  $ChromiumExe = Join-Path -Path $VersionRoot -ChildPath 'runtime\chromium\chrome.exe'
  $DashboardScript = Join-Path -Path $AppDir -ChildPath 'scripts\crown-dashboard.mjs'
  $PortableInstanceModule = Join-Path -Path $AppDir -ChildPath 'src\crown\runtime\portable-instance.mjs'
  $AppConfigDir = Join-Path -Path $AppDir -ChildPath 'config'
  $RuntimeDir = Join-Path -Path $DataRoot -ChildPath 'runtime'
  $StateFile = Join-Path -Path $RuntimeDir -ChildPath 'launcher-state.json'
  $StopRequestFile = Join-Path -Path $RuntimeDir -ChildPath 'launcher-stop-request.json'
  $StartupClaimFile = Join-Path -Path $RuntimeDir -ChildPath 'launcher-startup-claim.json'

  foreach ($candidate in @($VersionRoot, $AppDir, $NodeExe, $ChromiumExe, $DashboardScript, $PortableInstanceModule, $AppConfigDir)) {
    Assert-PathWithin -Root $AppRoot -Candidate $candidate -Code 'launcher-version-path-outside-app-root' | Out-Null
  }
  foreach ($candidate in @($DataRoot, $RuntimeDir, $StateFile, $StopRequestFile, $StartupClaimFile, $LogDir)) {
    Assert-PathWithin -Root $DataRoot -Candidate $candidate -Code 'launcher-data-path-outside-data-root' | Out-Null
  }
  Assert-NoReparsePath -Path $DataRoot -RequireLeaf $false | Out-Null

  foreach ($required in @($AppDir, $NodeExe, $ChromiumExe, $DashboardScript, $PortableInstanceModule, $AppConfigDir)) {
    if (-not (Test-Path -LiteralPath $required)) { Throw-LauncherError 'launcher-package-incomplete' }
    Assert-NoReparsePath -Path $required -RequireLeaf $true | Out-Null
  }

  Clear-UntrustedChildEnvironment
  $env:CROWN_PORTABLE = '1'
  $env:CROWN_APP_VERSION = $Version
  $env:CROWN_APP_ROOT = $AppRoot
  $env:CROWN_VERSION_ROOT = $VersionRoot
  $env:CROWN_APP_DIR = $AppDir
  $env:CROWN_NODE_EXECUTABLE_PATH = $NodeExe
  $env:CROWN_CHROMIUM_EXECUTABLE_PATH = $ChromiumExe
  $env:CROWN_DATA_ROOT = $DataRoot
  $env:CROWN_DB_PATH = Join-Path -Path $DataRoot -ChildPath 'storage\crown.sqlite'
  $env:CROWN_LOCAL_SECRET_KEY_PATH = Join-Path -Path $DataRoot -ChildPath 'storage\crown-local-secret.key'
  $env:CROWN_CONFIG_DIR = Join-Path -Path $DataRoot -ChildPath 'config'
  $env:CROWN_RUNTIME_DIR = $RuntimeDir
  $env:CROWN_SESSION_DIR = Join-Path -Path $RuntimeDir -ChildPath 'crown-sessions'
  $env:CROWN_BROWSER_PROFILE_DIR = Join-Path -Path $RuntimeDir -ChildPath 'browser-profiles'
  $env:CROWN_LOG_DIR = $LogDir
  $env:CROWN_UPDATE_DIR = Join-Path -Path $DataRoot -ChildPath 'updates'
  $env:CROWN_BACKUP_DIR = Join-Path -Path $DataRoot -ChildPath 'backups'
  $env:CROWN_STATIC_DIR = Join-Path -Path $AppDir -ChildPath 'frontend\dist'
  $env:CROWN_WATCHER_AUTOSTART = '0'
  $env:CROWN_BETTING_WORKER_AUTOSTART = '0'
  $env:CROWN_BETTING_MODE = 'off'
  $env:CROWN_PORTABLE_INSTANCE_MODULE = $PortableInstanceModule
  $env:CROWN_APP_CONFIG_DIR = $AppConfigDir

  $initializer = @'
import { pathToFileURL } from 'node:url'
const module = await import(pathToFileURL(process.env.CROWN_PORTABLE_INSTANCE_MODULE).href)
const result = module.initializePortableData({ appConfigDir: process.env.CROWN_APP_CONFIG_DIR, dataRoot: process.env.CROWN_DATA_ROOT })
process.stdout.write(result.installationId)
'@
  Assert-NoReparsePath -Path $AppRoot -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $VersionRoot -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $NodeExe -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $DataRoot -RequireLeaf $false | Out-Null
  $initializerOutput = & $NodeExe '--input-type=module' '--eval' $initializer
  if ($LASTEXITCODE -ne 0) { Throw-LauncherError 'launcher-portable-initialize-failed' }
  $InstallationId = ($initializerOutput | Out-String).Trim()
  if ($InstallationId -notmatch $InstallationIdPattern -or $InstallationId -ne (Read-InstallationId $DataRoot)) {
    Throw-LauncherError 'launcher-portable-initialize-invalid'
  }
  $env:CROWN_INSTALLATION_ID = $InstallationId
  [IO.Directory]::CreateDirectory($RuntimeDir) | Out-Null
  [IO.Directory]::CreateDirectory($LogDir) | Out-Null
  Assert-NoReparsePath -Path $DataRoot -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $RuntimeDir -RequireLeaf $true | Out-Null
  Assert-NoReparsePath -Path $StateFile -RequireLeaf $false | Out-Null

  $singleMutex = [Threading.Mutex]::new($false, (Get-InstanceMutexName $InstallationId))
  try { $mutexOwned = $singleMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $mutexOwned = $true }
  $mutexDeadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
  while (-not $mutexOwned -and [DateTime]::UtcNow -lt $mutexDeadline) {
    $waitingState = Read-LauncherState $StateFile
    if (Try-ReuseLauncherState -State $waitingState -InstallationId $InstallationId -Version $Version) {
      Write-Output "launcher-reused $ReusedUrl"
      exit 0
    }
    try { $mutexOwned = $singleMutex.WaitOne(100) } catch [Threading.AbandonedMutexException] { $mutexOwned = $true }
  }
  if (-not $mutexOwned) { Throw-LauncherError 'launcher-instance-lock-timeout' }

  Assert-NoReparsePath -Path $StateFile -RequireLeaf $false | Out-Null
  $existingState = Read-LauncherState $StateFile
  if (Try-ReuseLauncherState -State $existingState -InstallationId $InstallationId -Version $Version) {
    Write-Output "launcher-reused $ReusedUrl"
    exit 0
  }
  Resolve-StartupClaim -InstallationId $InstallationId -Version $Version
  $PreferredPort = if ($null -ne $existingState) { [int]$existingState.port } else { 8787 }

  $env:CROWN_DASHBOARD_HOST = '127.0.0.1'
  $env:CROWN_LAUNCHER_STATE_PATH = $StateFile
  $env:CROWN_LAUNCHER_STOP_REQUEST_PATH = $StopRequestFile
  $env:CROWN_LAUNCHER_STARTUP_CLAIM_PATH = $StartupClaimFile
  $env:CROWN_DASHBOARD_MODULE = $DashboardScript
  $LauncherParentPid = [int]$PID
  $LauncherParentProcessStartTime = Get-ProcessStartTime (Get-Process -Id $LauncherParentPid -ErrorAction Stop)
  $env:CROWN_LAUNCHER_PARENT_PID = [string]$LauncherParentPid
  $env:CROWN_LAUNCHER_PARENT_PROCESS_START_TIME = $LauncherParentProcessStartTime
  if ([IO.File]::Exists($StopRequestFile)) { [IO.File]::Delete($StopRequestFile) }
  $startupDeadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
  $started = $false

  for ($attempt = 1; $attempt -le 3 -and -not $started; $attempt += 1) {
    $Port = if ($attempt -eq 1 -and (Test-LoopbackPortFree $PreferredPort)) { $PreferredPort } else { Get-FreeLoopbackPort }
    $launchNonce = New-CryptoToken
    $stopToken = New-CryptoToken
    $healthProbe = New-CryptoToken
    $env:CROWN_DASHBOARD_PORT = [string]$Port
    $env:CROWN_LAUNCHER_NONCE = $launchNonce
    $abortFile = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-abort-' + [guid]::NewGuid().ToString('N') + '.json')
    $identityFile = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-identity-' + [guid]::NewGuid().ToString('N') + '.json')
    $startupErrorFile = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-start-error-' + [guid]::NewGuid().ToString('N') + '.json')
    $hostScript = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-host-' + [guid]::NewGuid().ToString('N') + '.mjs')
    $parentLeaseFile = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-parent-' + [guid]::NewGuid().ToString('N') + '.json')
    $parentAckFile = Join-Path -Path $RuntimeDir -ChildPath ('.launcher-parent-ack-' + [guid]::NewGuid().ToString('N') + '.json')
    $parentLeaseToken = New-CryptoToken
    $env:CROWN_LAUNCHER_ABORT_PATH = $abortFile
    $env:CROWN_LAUNCHER_IDENTITY_PATH = $identityFile
    $env:CROWN_LAUNCHER_STARTUP_ERROR_PATH = $startupErrorFile
    $env:CROWN_LAUNCHER_PARENT_LEASE_PATH = $parentLeaseFile
    $env:CROWN_LAUNCHER_PARENT_LEASE_TOKEN = $parentLeaseToken
    $env:CROWN_LAUNCHER_PARENT_ACK_PATH = $parentAckFile
    foreach ($ephemeral in @($abortFile, $identityFile, $startupErrorFile, $parentLeaseFile, $parentAckFile)) {
      Assert-PathWithin -Root $DataRoot -Candidate $ephemeral -Code 'launcher-ephemeral-path-outside-data-root' | Out-Null
      if ([IO.File]::Exists($ephemeral)) { [IO.File]::Delete($ephemeral) }
    }
    $parentLease = [ordered]@{
      schemaVersion = 1
      parentPid = $LauncherParentPid
      parentProcessStartTime = $LauncherParentProcessStartTime
      launchNonce = $launchNonce
      leaseToken = $parentLeaseToken
    }
    $parentLeaseBytes = [Text.UTF8Encoding]::new($false).GetBytes(($parentLease | ConvertTo-Json -Compress) + "`n")
    $parentLeaseStream = [IO.FileStream]::new($parentLeaseFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $parentLeaseStream.Write($parentLeaseBytes, 0, $parentLeaseBytes.Length)
    $parentLeaseStream.Flush($true)
    $startupClaimReservation = [ordered]@{
      schemaVersion = 1
      status = 'reserved'
      installationId = $InstallationId
      version = $Version
      parentPid = $LauncherParentPid
      parentProcessStartTime = $LauncherParentProcessStartTime
      launchNonce = $launchNonce
      parentLeasePath = $parentLeaseFile
      parentLeaseToken = $parentLeaseToken
      abortPath = $abortFile
      childLaunchAuthorized = $false
      childProcessStartReturned = $false
    }
    Write-AtomicUtf8Json -Path $StartupClaimFile -Value $startupClaimReservation
    $startupClaimReservationRaw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
    $startupClaimReservationOwned = $true

    $hostSource = @'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const statePath = process.env.CROWN_LAUNCHER_STATE_PATH
const stopPath = process.env.CROWN_LAUNCHER_STOP_REQUEST_PATH
const abortPath = process.env.CROWN_LAUNCHER_ABORT_PATH
const claimPath = process.env.CROWN_LAUNCHER_STARTUP_CLAIM_PATH
const identityPath = process.env.CROWN_LAUNCHER_IDENTITY_PATH
const startupErrorPath = process.env.CROWN_LAUNCHER_STARTUP_ERROR_PATH
const installationId = process.env.CROWN_INSTALLATION_ID
const version = process.env.CROWN_APP_VERSION
const launchNonce = process.env.CROWN_LAUNCHER_NONCE
const parentPid = Number(process.env.CROWN_LAUNCHER_PARENT_PID)
const parentProcessStartTime = process.env.CROWN_LAUNCHER_PARENT_PROCESS_START_TIME
const parentLeasePath = process.env.CROWN_LAUNCHER_PARENT_LEASE_PATH
const parentLeaseToken = process.env.CROWN_LAUNCHER_PARENT_LEASE_TOKEN
const parentAckPath = process.env.CROWN_LAUNCHER_PARENT_ACK_PATH
const token = /^[A-Za-z0-9_-]{43}$/
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

async function startupError(code) {
  await fs.writeFile(startupErrorPath, JSON.stringify({ schemaVersion: 1, code }) + '\n', { encoding: 'utf8', flag: 'wx' }).catch(() => {})
}

let identity
let runtime
let stopping = false
let timer
let parentTimer
let checkingParent = false
let statePublished = false

function validParentBinding() {
  return Number.isSafeInteger(parentPid) && parentPid > 0 && parentPid !== process.pid &&
    token.test(parentLeaseToken || '') && token.test(launchNonce || '') && iso.test(parentProcessStartTime || '') &&
    new Date(parentProcessStartTime).toISOString() === parentProcessStartTime && path.isAbsolute(parentLeasePath || '') &&
    path.dirname(parentLeasePath) === path.dirname(statePath) && path.basename(parentLeasePath).startsWith('.launcher-parent-') &&
    path.isAbsolute(parentAckPath || '') && path.dirname(parentAckPath) === path.dirname(statePath) &&
    path.basename(parentAckPath).startsWith('.launcher-parent-ack-') && path.isAbsolute(claimPath || '') &&
    path.dirname(claimPath) === path.dirname(statePath) && path.basename(claimPath) === 'launcher-startup-claim.json'
}

async function inspectParentLease() {
  let handle
  try {
    handle = await fs.open(parentLeasePath, 'r+')
    const record = JSON.parse(await handle.readFile('utf8'))
    const keys = Object.keys(record).sort().join(',')
    const valid = keys === 'launchNonce,leaseToken,parentPid,parentProcessStartTime,schemaVersion' &&
      record.schemaVersion === 1 && record.parentPid === parentPid &&
      record.parentProcessStartTime === parentProcessStartTime && record.launchNonce === launchNonce &&
      record.leaseToken === parentLeaseToken
    return { held: false, valid }
  } catch (error) {
    if (['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) return { held: true, valid: true }
    return { held: false, valid: false }
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function hasExactPublishedState() {
  if (!identity) return false
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    return Object.keys(state).sort().join(',') === 'installationId,launchNonce,pid,port,processStartTime,schemaVersion,stopToken,version' &&
      state.schemaVersion === 1 && state.installationId === identity.installationId && state.version === identity.version &&
      state.pid === process.pid && state.processStartTime === identity.processStartTime &&
      state.launchNonce === identity.launchNonce && state.stopToken === identity.stopToken &&
      Number.isSafeInteger(state.port) && state.port >= 1 && state.port <= 65535
  } catch { return false }
}

async function acknowledgePublishedState() {
  const acknowledgement = {
    schemaVersion: 1,
    parentPid,
    parentProcessStartTime,
    pid: process.pid,
    processStartTime: identity.processStartTime,
    launchNonce: identity.launchNonce,
    stopToken: identity.stopToken,
  }
  await fs.writeFile(parentAckPath, JSON.stringify(acknowledgement) + '\n', { encoding: 'utf8', flag: 'wx' })
  setTimeout(() => { fs.unlink(parentAckPath).catch(() => {}) }, 15_000).unref()
}

async function removeOwnStartupClaim() {
  try {
    const claim = JSON.parse(await fs.readFile(claimPath, 'utf8'))
    const keys = Object.keys(claim).sort().join(',')
    const common = claim.schemaVersion === 1 && claim.installationId === installationId && claim.version === version &&
      claim.launchNonce === launchNonce && claim.parentPid === parentPid && claim.parentProcessStartTime === parentProcessStartTime &&
      claim.parentLeasePath === parentLeasePath && claim.parentLeaseToken === parentLeaseToken && claim.abortPath === abortPath
    const active = claim.status === 'active' &&
      keys === 'abortPath,installationId,launchNonce,parentLeasePath,parentLeaseToken,parentPid,parentProcessStartTime,pid,processStartTime,schemaVersion,status,stopToken,version' &&
      common && claim.pid === process.pid && token.test(claim.stopToken) && iso.test(claim.processStartTime || '') &&
      (!identity || (claim.processStartTime === identity.processStartTime && claim.stopToken === identity.stopToken))
    const reserved = claim.status === 'reserved' &&
      keys === 'abortPath,childLaunchAuthorized,childProcessStartReturned,installationId,launchNonce,parentLeasePath,parentLeaseToken,parentPid,parentProcessStartTime,schemaVersion,status,version' &&
      common && claim.childLaunchAuthorized === true && typeof claim.childProcessStartReturned === 'boolean'
    const matches = active || reserved
    if (matches) await fs.unlink(claimPath).catch(() => {})
  } catch (error) { if (error?.code !== 'ENOENT') return }
}

async function exactAbortRequested() {
  if (!identity) return false
  try {
    const request = JSON.parse(await fs.readFile(abortPath, 'utf8'))
    const keys = Object.keys(request).sort().join(',')
    const matches = keys === 'installationId,launchNonce,parentLeaseToken,pid,processStartTime,schemaVersion,stopToken,version' &&
      request.schemaVersion === 1 && request.installationId === identity.installationId && request.version === identity.version &&
      request.pid === process.pid && request.processStartTime === identity.processStartTime &&
      request.launchNonce === identity.launchNonce && request.stopToken === identity.stopToken &&
      request.parentLeaseToken === parentLeaseToken
    if (matches) await fs.unlink(abortPath).catch(() => {})
    return matches
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
}

async function checkParentBoundary() {
  if (checkingParent || stopping || statePublished) return
  checkingParent = true
  try {
    if (await hasExactPublishedState()) {
      await acknowledgePublishedState()
      statePublished = true
      clearInterval(parentTimer)
      return
    }
    const lease = await inspectParentLease()
    if (lease.held) return
    if (await hasExactPublishedState()) {
      await acknowledgePublishedState()
      statePublished = true
      clearInterval(parentTimer)
      return
    }
    clearInterval(parentTimer)
    await fs.unlink(parentLeasePath).catch(() => {})
    await startupError(lease.valid ? 'PARENT_EXITED' : 'PARENT_IDENTITY_INVALID')
    if (!runtime) {
      await removeOwnStartupClaim()
      process.exit(75)
    }
    await shutdown('launcher-parent-exited')
    process.exit(process.exitCode || 75)
  } finally {
    checkingParent = false
  }
}

if (!validParentBinding()) {
  await startupError('PARENT_IDENTITY_INVALID')
  process.exit(75)
}
const initialLease = await inspectParentLease()
if (!initialLease.held) {
  await startupError(initialLease.valid ? 'PARENT_EXITED' : 'PARENT_IDENTITY_INVALID')
  await removeOwnStartupClaim()
  await fs.unlink(parentLeasePath).catch(() => {})
  await fs.unlink(abortPath).catch(() => {})
  process.exit(75)
}
parentTimer = setInterval(() => { checkParentBoundary().catch(() => { process.exit(75) }) }, 100)

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { identity = JSON.parse(await fs.readFile(identityPath, 'utf8')); break }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  if (!identity) throw new Error('launcher-host-identity-missing')
  const keys = Object.keys(identity).sort().join(',')
  const estimatedStart = Date.now() - process.uptime() * 1000
  if (keys !== 'installationId,launchNonce,pid,processStartTime,schemaVersion,stopToken,version' || identity.schemaVersion !== 1 ||
    identity.installationId !== installationId || identity.version !== version || identity.pid !== process.pid ||
    identity.launchNonce !== launchNonce || !token.test(identity.launchNonce) || !token.test(identity.stopToken) ||
    identity.launchNonce === identity.stopToken || !iso.test(identity.processStartTime) ||
    Math.abs(Date.parse(identity.processStartTime) - estimatedStart) > 5000) throw new Error('launcher-host-identity-invalid')
  await fs.unlink(identityPath)
} catch {
  await startupError('IDENTITY_INVALID')
  process.exit(72)
}

process.env.CROWN_LAUNCHER_PROCESS_START_TIME = identity.processStartTime
try {
  const dashboard = await import(pathToFileURL(process.env.CROWN_DASHBOARD_MODULE).href)
  runtime = await dashboard.startCrownDashboard({ env: process.env, registerSignals: false })
} catch (error) {
  await startupError(error?.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'START_FAILED')
  process.exit(error?.code === 'EADDRINUSE' ? 73 : 74)
}

async function shutdown(reason) {
  if (stopping) return
  stopping = true
  if (timer) clearInterval(timer)
  if (parentTimer) clearInterval(parentTimer)
  const forceExit = setTimeout(() => { process.exit(76) }, 5000)
  for (const file of [stopPath, abortPath]) {
    try { await fs.unlink(file) } catch (error) { if (error?.code !== 'ENOENT') console.error('launcher stop request cleanup failed') }
  }
  try {
    const result = await runtime.shutdown()
    if (!result?.ok) process.exitCode = 1
  } finally {
    await removeOwnStartupClaim()
    clearTimeout(forceExit)
  }
}

async function requested() {
  if (await exactAbortRequested()) return true
  let state
  let request
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    request = JSON.parse(await fs.readFile(stopPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false
    throw error
  }
  const stateKeys = Object.keys(state).sort().join(',')
  const requestKeys = Object.keys(request).sort().join(',')
  const matches = stateKeys === 'installationId,launchNonce,pid,port,processStartTime,schemaVersion,stopToken,version' &&
    requestKeys === 'installationId,launchNonce,pid,processStartTime,schemaVersion,stopToken' &&
    state.schemaVersion === 1 && request.schemaVersion === 1 && state.installationId === identity.installationId &&
    request.installationId === identity.installationId && state.version === identity.version &&
    state.pid === process.pid && request.pid === process.pid && state.processStartTime === identity.processStartTime &&
    request.processStartTime === identity.processStartTime && state.launchNonce === identity.launchNonce &&
    request.launchNonce === identity.launchNonce && state.stopToken === identity.stopToken && request.stopToken === identity.stopToken
  if (matches) await fs.unlink(stopPath).catch(() => {})
  return matches
}

timer = setInterval(() => { requested().then((value) => { if (value) shutdown('request') }).catch(() => {}) }, 200)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { shutdown(signal).catch(() => { process.exitCode = 1 }) })
'@
    Assert-NoReparsePath -Path $AppRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $VersionRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $NodeExe -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $DataRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $RuntimeDir -RequireLeaf $true | Out-Null
    [IO.File]::WriteAllText($hostScript, $hostSource, [Text.UTF8Encoding]::new($false))
    Assert-NoReparsePath -Path $hostScript -RequireLeaf $true | Out-Null
    $startupClaimReservation.childLaunchAuthorized = $true
    Write-AtomicUtf8Json -Path $StartupClaimFile -Value $startupClaimReservation
    $startupClaimReservationRaw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
    $dashboardProcess = Start-BundledDashboard -NodeExe $NodeExe -HostScript $hostScript -WorkingDirectory $AppDir
    $startupClaimReservation.childProcessStartReturned = $true
    Write-AtomicUtf8Json -Path $StartupClaimFile -Value $startupClaimReservation
    $startupClaimReservationRaw = [IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8)
    $dashboardStartTime = Get-ProcessStartTime $dashboardProcess
    $identity = [ordered]@{
      schemaVersion = 1
      installationId = $InstallationId
      version = $Version
      pid = $dashboardProcess.Id
      processStartTime = $dashboardStartTime
      launchNonce = $launchNonce
      stopToken = $stopToken
    }
    $startupClaim = [ordered]@{
      schemaVersion = 1
      status = 'active'
      installationId = $InstallationId
      version = $Version
      pid = $dashboardProcess.Id
      processStartTime = $dashboardStartTime
      launchNonce = $launchNonce
      stopToken = $stopToken
      parentPid = $LauncherParentPid
      parentProcessStartTime = $LauncherParentProcessStartTime
      parentLeasePath = $parentLeaseFile
      parentLeaseToken = $parentLeaseToken
      abortPath = $abortFile
    }
    Assert-NoReparsePath -Path $StartupClaimFile -RequireLeaf $false | Out-Null
    Write-AtomicUtf8Json -Path $StartupClaimFile -Value $startupClaim
    $startupClaimReservationOwned = $false
    Write-AtomicUtf8Json -Path $identityFile -Value $identity

    $health = $null
    while ([DateTime]::UtcNow -lt $startupDeadline) {
      if ($dashboardProcess.HasExited) { break }
      $health = Get-Health -Port $Port -Probe $healthProbe
      if (Test-MatchingHealth -Health $health -InstallationId $InstallationId -Version $Version -LaunchNonce $launchNonce -ProcessId $dashboardProcess.Id -ProcessStartTime $dashboardStartTime -Probe $healthProbe) {
        $started = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }

    if (-not $started) {
      $startupCode = ''
      if ($dashboardProcess.HasExited -and [IO.File]::Exists($startupErrorFile)) {
        try { $startupCode = [string](([IO.File]::ReadAllText($startupErrorFile, [Text.Encoding]::UTF8) | ConvertFrom-Json).code) } catch {}
      }
      if (-not $dashboardProcess.HasExited) {
        Write-BoundAbortRequest -Claim $startupClaim
        if (-not $dashboardProcess.WaitForExit(5000)) { $dashboardProcess.Kill(); $dashboardProcess.WaitForExit(5000) | Out-Null }
      }
      try { Remove-OwnStartupClaim -Expected $startupClaim -Require $false } catch {}
      Close-ParentLease
      $dashboardProcess.Dispose()
      $dashboardProcess = $null
      foreach ($ephemeral in @($hostScript, $identityFile, $startupErrorFile, $abortFile)) {
        if ($null -ne $ephemeral -and [IO.File]::Exists($ephemeral)) { [IO.File]::Delete($ephemeral) }
      }
      $hostScript = $null
      $identityFile = $null
      $startupErrorFile = $null
      $abortFile = $null
      if ($startupCode -eq 'EADDRINUSE' -and $attempt -lt 3 -and [DateTime]::UtcNow -lt $startupDeadline) { continue }
      if ($startupCode -eq 'EADDRINUSE') { Throw-LauncherError 'launcher-port-race-exhausted' }
      if ($startupCode) { Throw-LauncherError "launcher-dashboard-start-failed:$startupCode" }
      Throw-LauncherError 'launcher-health-timeout'
    }

    Assert-NoReparsePath -Path $AppRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $VersionRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $DataRoot -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $RuntimeDir -RequireLeaf $true | Out-Null
    Assert-NoReparsePath -Path $StateFile -RequireLeaf $false | Out-Null
    $state = [ordered]@{
      schemaVersion = 1
      installationId = $InstallationId
      version = $Version
      port = $Port
      pid = $dashboardProcess.Id
      processStartTime = $dashboardStartTime
      launchNonce = $launchNonce
      stopToken = $stopToken
    }
    Write-AtomicUtf8Json -Path $StateFile -Value $state
    Verify-PublishedState -Path $StateFile -Expected $state | Out-Null
    $parentAcknowledged = $false
    $parentAckDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not $parentAcknowledged -and -not $dashboardProcess.HasExited -and [DateTime]::UtcNow -lt $parentAckDeadline) {
      if ([IO.File]::Exists($parentAckFile)) {
        try {
          $ack = [IO.File]::ReadAllText($parentAckFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
          $ackKeys = @($ack.PSObject.Properties.Name | Sort-Object)
          $parentAcknowledged = ($ackKeys -join ',') -eq 'launchNonce,parentPid,parentProcessStartTime,pid,processStartTime,schemaVersion,stopToken' -and
            $ack.schemaVersion -eq 1 -and [int]$ack.parentPid -eq $LauncherParentPid -and
            [string]$ack.parentProcessStartTime -ceq $LauncherParentProcessStartTime -and
            [int]$ack.pid -eq $dashboardProcess.Id -and [string]$ack.processStartTime -ceq $dashboardStartTime -and
            [string]$ack.launchNonce -ceq $launchNonce -and [string]$ack.stopToken -ceq $stopToken
        }
        catch { $parentAcknowledged = $false }
      }
      if (-not $parentAcknowledged) { Start-Sleep -Milliseconds 50 }
    }
    if (-not $parentAcknowledged) { Throw-LauncherError 'launcher-parent-state-ack-timeout' }
    Remove-OwnStartupClaim -Expected $startupClaim -Require $false
    Close-ParentLease
    foreach ($ephemeral in @($hostScript, $startupErrorFile)) {
      if ($null -ne $ephemeral -and [IO.File]::Exists($ephemeral)) { [IO.File]::Delete($ephemeral) }
    }
    $hostScript = $null
    $startupErrorFile = $null
  }

  if (-not $started) { Throw-LauncherError 'launcher-port-race-exhausted' }
  $url = "http://127.0.0.1:$Port/"
  Write-Output "launcher-started $url pid=$($dashboardProcess.Id)"
  Write-LauncherLog 'launcher-started'
  if (-not $NoBrowser) { Start-Process $url | Out-Null }

  $dashboardProcess.WaitForExit()
  $exitCode = $dashboardProcess.ExitCode
  Remove-StateIfExact -Path $StateFile -ProcessId $dashboardProcess.Id -ProcessStartTime $dashboardStartTime
  if ($exitCode -ne 0) { Throw-LauncherError 'launcher-dashboard-exited-with-error' }
  Write-LauncherLog 'launcher-stopped'
  exit 0
}
catch {
  $code = if ([string]::IsNullOrWhiteSpace($_.Exception.Message)) { 'launcher-failed' } else { $_.Exception.Message }
  Write-LauncherLog $code
  Write-Error $code -ErrorAction Continue
  if ($null -ne $dashboardProcess -and -not $dashboardProcess.HasExited) {
    try {
      if ($null -ne $abortFile -and $null -ne $startupClaim) { Write-BoundAbortRequest -Claim $startupClaim }
      if (-not $dashboardProcess.WaitForExit(5000)) { $dashboardProcess.Kill(); $dashboardProcess.WaitForExit(5000) | Out-Null }
    }
    catch {}
  }
  if ($null -ne $stateFile -and $null -ne $dashboardProcess -and $null -ne $dashboardStartTime) {
    Remove-StateIfExact -Path $stateFile -ProcessId $dashboardProcess.Id -ProcessStartTime $dashboardStartTime
  }
  if ($null -ne $startupClaim) { try { Remove-OwnStartupClaim -Expected $startupClaim -Require $false } catch {} }
  if ($startupClaimReservationOwned -and [IO.File]::Exists($StartupClaimFile)) {
    try {
      Assert-NoReparsePath -Path $StartupClaimFile -RequireLeaf $true | Out-Null
      if ([IO.File]::ReadAllText($StartupClaimFile, [Text.Encoding]::UTF8) -ceq $startupClaimReservationRaw) { [IO.File]::Delete($StartupClaimFile) }
    }
    catch {}
  }
  exit 1
}
finally {
  Close-ParentLease
  if ($null -ne $hostScript -and [IO.File]::Exists($hostScript)) {
    try { [IO.File]::Delete($hostScript) } catch {}
  }
  if ($null -ne $abortFile -and [IO.File]::Exists($abortFile)) {
    try { [IO.File]::Delete($abortFile) } catch {}
  }
  foreach ($ephemeral in @($identityFile, $startupErrorFile)) {
    if ($null -ne $ephemeral -and [IO.File]::Exists($ephemeral)) {
      try { [IO.File]::Delete($ephemeral) } catch {}
    }
  }
  if ($null -ne $dashboardProcess) { $dashboardProcess.Dispose() }
  if ($null -ne $singleMutex) {
    if ($mutexOwned) { try { $singleMutex.ReleaseMutex() } catch {} }
    $singleMutex.Dispose()
  }
}
