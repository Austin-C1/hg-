#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$Commit,

  [Parameter(Mandatory = $true)]
  [string]$NodeRuntime,

  [Parameter(Mandatory = $true)]
  [string]$ChromiumRuntime,

  [ValidateSet('VerifyOnly', 'BuildFinal')]
  [string]$Mode = 'VerifyOnly',

  [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'crown-release-assets'),

  [string]$TemporaryParent = ([IO.Path]::GetTempPath()),

  [ValidatePattern('^(?:|[0-9a-fA-F]{64})$')]
  [string]$ExpectedSha256 = '',

  [ValidateRange(0, [long]::MaxValue)]
  [long]$ExpectedSize = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Full-Path([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'release-candidate-path-required' }
  return [IO.Path]::GetFullPath($Path)
}

function Test-PathInside([string]$Parent, [string]$Child) {
  $parentPath = (Full-Path $Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $childPath = Full-Path $Child
  $prefix = $parentPath + [IO.Path]::DirectorySeparatorChar
  return $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][object[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Push-Location -LiteralPath $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    & $FilePath @Arguments *> $null
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  if ($exitCode -ne 0) { throw "release-candidate-native-failed:${Label}:$exitCode" }
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][object[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Push-Location -LiteralPath $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = @(& $FilePath @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  if ($exitCode -ne 0) { throw "release-candidate-native-failed:${Label}:$exitCode" }
  return ($output -join [Environment]::NewLine).Trim()
}

function File-Digest([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  if (-not $item.PSIsContainer -and $item.Length -ge 0) {
    return [ordered]@{
      sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
      size = [long]$item.Length
    }
  }
  throw 'release-candidate-artifact-invalid'
}

$sourceRoot = Full-Path (Join-Path $PSScriptRoot '..')
$nodeRuntimePath = Full-Path $NodeRuntime
$chromiumRuntimePath = Full-Path $ChromiumRuntime
$outputPath = Full-Path $OutputDirectory
$temporaryParentPath = Full-Path $TemporaryParent

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw 'release-candidate-source-missing' }
if (-not (Test-Path -LiteralPath $nodeRuntimePath -PathType Container)) { throw 'release-candidate-node-runtime-missing' }
if (-not (Test-Path -LiteralPath $chromiumRuntimePath -PathType Container)) { throw 'release-candidate-chromium-runtime-missing' }
if (Test-PathInside $sourceRoot $outputPath) { throw 'release-candidate-output-inside-source' }

$nodeExe = Join-Path $nodeRuntimePath 'node.exe'
$npmCmd = Join-Path $nodeRuntimePath 'npm.cmd'
$chromiumExe = Join-Path $chromiumRuntimePath 'chrome.exe'
foreach ($required in @($nodeExe, $npmCmd, $chromiumExe)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'release-candidate-runtime-incomplete' }
}

[IO.Directory]::CreateDirectory($temporaryParentPath) | Out-Null
$artifactName = 'CrownMonitor-v{0}-windows-x64-portable.zip'

$resolvedCommit = Invoke-NativeCapture -Label 'commit' -FilePath 'git' -Arguments @(
  '-C', $sourceRoot, 'rev-parse', '--verify', "$Commit`^{commit}"
) -WorkingDirectory $sourceRoot
if ($resolvedCommit -cne $Commit.ToLowerInvariant()) { throw 'release-candidate-commit-mismatch' }

$packageAtCommit = Invoke-NativeCapture -Label 'package-version' -FilePath 'git' -Arguments @(
  '-C', $sourceRoot, 'show', "$Commit`:package.json"
) -WorkingDirectory $sourceRoot
try { $package = $packageAtCommit | ConvertFrom-Json } catch { throw 'release-candidate-package-invalid' }
$version = [string]$package.version
if ($version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$') {
  throw 'release-candidate-version-invalid'
}
$artifactName = $artifactName -f $version
$artifactPath = Join-Path $outputPath $artifactName
if ($Mode -eq 'BuildFinal') {
  [IO.Directory]::CreateDirectory($outputPath) | Out-Null
  if (Test-Path -LiteralPath $artifactPath) { throw 'release-candidate-artifact-exists' }
}

$runRoot = Join-Path $temporaryParentPath ('crown-release-candidate-' + [Guid]::NewGuid().ToString('N'))
if (-not (Test-PathInside $temporaryParentPath $runRoot)) { throw 'release-candidate-temporary-path-invalid' }
$worktree = Join-Path $runRoot 'worktree'
$releaseRoot = Join-Path $runRoot 'portable'
$extractRoot = Join-Path $runRoot 'extracted'
$smokeCwd = Join-Path $runRoot 'outside-cwd'
$temporaryZip = Join-Path $runRoot $artifactName
$publishTemporaryPath = Join-Path $outputPath ('.' + $artifactName + '.' + [Guid]::NewGuid().ToString('N') + '.partial')

$worktreeAdded = $false
$artifactCreated = $false
$publishTemporaryCreated = $false
$result = $null
$failure = $null
$cleanupFailure = $null
$previousChromium = $env:CROWN_CHROMIUM_EXECUTABLE_PATH
$previousSkipDownload = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD

try {
  [IO.Directory]::CreateDirectory($runRoot) | Out-Null
  Invoke-Native -Label 'worktree-add' -FilePath 'git' -Arguments @(
    '-C', $sourceRoot, 'worktree', 'add', '--detach', $worktree, $Commit
  ) -WorkingDirectory $sourceRoot
  $worktreeAdded = $true

  $env:CROWN_CHROMIUM_EXECUTABLE_PATH = $chromiumExe
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'

  Invoke-Native -Label 'backend-ci' -FilePath $npmCmd -Arguments @('ci') -WorkingDirectory $worktree
  Invoke-Native -Label 'frontend-ci' -FilePath $npmCmd -Arguments @('--prefix', 'frontend', 'ci') -WorkingDirectory $worktree
  Invoke-Native -Label 'backend-test' -FilePath $npmCmd -Arguments @('test') -WorkingDirectory $worktree
  Invoke-Native -Label 'check' -FilePath $npmCmd -Arguments @('run', 'check') -WorkingDirectory $worktree
  Invoke-Native -Label 'frontend-test' -FilePath $npmCmd -Arguments @('run', 'crown:frontend:test') -WorkingDirectory $worktree
  Invoke-Native -Label 'frontend-build' -FilePath $npmCmd -Arguments @('run', 'crown:frontend:build') -WorkingDirectory $worktree
  Invoke-Native -Label 'compose-config' -FilePath 'docker' -Arguments @('compose', '-p', 'crown-dashboard', 'config') -WorkingDirectory $worktree

  $frontendIndex = Join-Path $worktree 'frontend\dist\index.html'
  if (-not (Test-Path -LiteralPath $frontendIndex -PathType Leaf)) {
    throw 'release-candidate-frontend-dist-missing'
  }

  Invoke-Native -Label 'runtime-health' -FilePath $nodeExe -Arguments @(
    'scripts/crown-runtime-health-audit.mjs', '--fixture', '--desktop', '1440x900', '--mobile', '390x844'
  ) -WorkingDirectory $worktree

  Invoke-Native -Label 'source-diff' -FilePath 'git' -Arguments @(
    '-C', $worktree, 'diff', '--exit-code', '--', '.'
  ) -WorkingDirectory $worktree
  $sourceStatus = Invoke-NativeCapture -Label 'source-status' -FilePath 'git' -Arguments @(
    '-C', $worktree, 'status', '--porcelain=v1', '--untracked-files=all'
  ) -WorkingDirectory $worktree
  if ($sourceStatus) { throw 'release-candidate-worktree-dirty' }

  Invoke-Native -Label 'portable-build' -FilePath $npmCmd -Arguments @(
    'run', 'release:portable', '--', '--version', $version,
    '--node-runtime', $nodeRuntimePath, '--chromium-runtime', $chromiumRuntimePath,
    '--out', $releaseRoot
  ) -WorkingDirectory $worktree
  Invoke-Native -Label 'portable-audit' -FilePath $npmCmd -Arguments @(
    'run', 'release:audit', '--', '--root', $releaseRoot
  ) -WorkingDirectory $worktree

  Compress-Archive -Path (Join-Path $releaseRoot '*') -DestinationPath $temporaryZip
  if (-not (Test-Path -LiteralPath $temporaryZip -PathType Leaf)) { throw 'release-candidate-zip-missing' }
  [IO.Directory]::CreateDirectory($extractRoot) | Out-Null
  Expand-Archive -LiteralPath $temporaryZip -DestinationPath $extractRoot
  Invoke-Native -Label 'portable-second-audit' -FilePath $npmCmd -Arguments @(
    'run', 'release:audit', '--', '--root', $extractRoot
  ) -WorkingDirectory $worktree

  $currentPath = Join-Path $extractRoot 'current.json'
  if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) { throw 'release-candidate-current-missing' }
  try { $current = Get-Content -Raw -LiteralPath $currentPath | ConvertFrom-Json } catch { throw 'release-candidate-current-invalid' }
  if ([string]$current.version -cne $version) { throw 'release-candidate-current-version-mismatch' }
  $appRoot = Join-Path $extractRoot (Join-Path 'versions' (Join-Path $version 'app'))
  foreach ($entrypoint in @('crown-dashboard.mjs', 'crown-watch.mjs', 'crown-betting-worker.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot (Join-Path 'scripts' $entrypoint)) -PathType Leaf)) {
      throw 'release-candidate-portable-entrypoint-missing'
    }
  }
  [IO.Directory]::CreateDirectory($smokeCwd) | Out-Null
  $smokeCode = @'
const { pathToFileURL } = await import('node:url');
const path = await import('node:path');
const root = process.argv[1];
for (const name of ['crown-dashboard.mjs','crown-watch.mjs','crown-betting-worker.mjs']) {
  await import(pathToFileURL(path.join(root, 'scripts', name)).href);
}
'@
  Invoke-Native -Label 'outside-cwd-smoke' -FilePath $nodeExe -Arguments @(
    '--input-type=module', '--eval', $smokeCode, $appRoot
  ) -WorkingDirectory $smokeCwd

  Invoke-Native -Label 'final-source-diff' -FilePath 'git' -Arguments @(
    '-C', $worktree, 'diff', '--exit-code', '--', '.'
  ) -WorkingDirectory $worktree
  $finalStatus = Invoke-NativeCapture -Label 'final-source-status' -FilePath 'git' -Arguments @(
    '-C', $worktree, 'status', '--porcelain=v1', '--untracked-files=all'
  ) -WorkingDirectory $worktree
  if ($finalStatus) { throw 'release-candidate-worktree-dirty' }

  $temporaryDigest = File-Digest $temporaryZip
  if ($ExpectedSha256 -and $temporaryDigest.sha256 -cne $ExpectedSha256.ToLowerInvariant()) {
    throw 'release-candidate-sha256-mismatch'
  }
  if ($ExpectedSize -gt 0 -and $temporaryDigest.size -ne $ExpectedSize) {
    throw 'release-candidate-size-mismatch'
  }

  $resultArtifactPath = $temporaryZip
  $resultDigest = $temporaryDigest
  if ($Mode -eq 'BuildFinal') {
    [IO.File]::Copy($temporaryZip, $publishTemporaryPath, $false)
    $publishTemporaryCreated = $true
    $publishedDigest = File-Digest $publishTemporaryPath
    if ($publishedDigest.sha256 -cne $temporaryDigest.sha256 -or $publishedDigest.size -ne $temporaryDigest.size) {
      throw 'release-candidate-artifact-copy-mismatch'
    }
    [IO.File]::Move($publishTemporaryPath, $artifactPath)
    $publishTemporaryCreated = $false
    $artifactCreated = $true
    $resultArtifactPath = $artifactPath
    $resultDigest = File-Digest $artifactPath
  }

  $result = [ordered]@{
    commit = $resolvedCommit
    mode = $Mode
    artifactPath = $resultArtifactPath
    sha256 = $resultDigest.sha256
    size = $resultDigest.size
  }
}
catch {
  $failure = $_
}
finally {
  $env:CROWN_CHROMIUM_EXECUTABLE_PATH = $previousChromium
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $previousSkipDownload

  if ($publishTemporaryCreated -and (Test-Path -LiteralPath $publishTemporaryPath -PathType Leaf)) {
    try { Remove-Item -LiteralPath $publishTemporaryPath -Force } catch { $cleanupFailure = $_ }
  }
  if ($failure -and $artifactCreated -and (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    try { Remove-Item -LiteralPath $artifactPath -Force } catch { $cleanupFailure = $_ }
  }
  if ($worktreeAdded) {
    try {
      Invoke-Native -Label 'worktree-remove' -FilePath 'git' -Arguments @(
        '-C', $sourceRoot, 'worktree', 'remove', '--force', $worktree
      ) -WorkingDirectory $sourceRoot
    }
    catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
  }
  try {
    Invoke-Native -Label 'worktree-prune' -FilePath 'git' -Arguments @(
      '-C', $sourceRoot, 'worktree', 'prune'
    ) -WorkingDirectory $sourceRoot
  }
  catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }

  if (Test-Path -LiteralPath $runRoot) {
    try {
      if (-not (Test-PathInside $temporaryParentPath $runRoot)) { throw 'release-candidate-cleanup-path-invalid' }
      Remove-Item -LiteralPath $runRoot -Recurse -Force
    }
    catch { if (-not $cleanupFailure) { $cleanupFailure = $_ } }
  }
}

if ($cleanupFailure) { throw "release-candidate-cleanup-failed:$($cleanupFailure.Exception.Message)" }
if ($failure) { throw $failure }
if (-not $result) { throw 'release-candidate-result-missing' }
$result | ConvertTo-Json -Compress
