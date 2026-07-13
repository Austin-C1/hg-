#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Task 12 replaces this fail-closed bridge with the signed external updater handoff.
# It intentionally performs no network request, update, restart, or Watcher action.
Write-Error 'manual-update-bootstrap-not-configured' -ErrorAction Continue
exit 64
