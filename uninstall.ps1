[CmdletBinding(SupportsShouldProcess=$true)]
param([switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $file)) { throw 'No installation config found in this checkout.' }
$config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
& $config.nodePath (Join-Path $PSScriptRoot 'scripts\install-core.cjs') uninstall --dry-run
if ($LASTEXITCODE -ne 0) { throw 'Uninstall preflight failed; changed files were left untouched.' }
if (-not $PSCmdlet.ShouldProcess($PSScriptRoot, 'Disable optional monitor and restore tracked Connector files')) { return }
& (Join-Path $PSScriptRoot 'set-monitor.ps1') -Mode off
if (-not $NoShortcut) { & (Join-Path $PSScriptRoot 'scripts\shortcut.ps1') -Remove }
& $config.nodePath (Join-Path $PSScriptRoot 'scripts\install-core.cjs') uninstall
if ($LASTEXITCODE -ne 0) { throw 'Uninstall could not restore changed files; see the error above.' }
Write-Host 'Connector files restored. Quit WorkBuddy to stop its bridge, then reopen Agents Anywhere.'
Write-Host 'Native conversations, model settings and bridge deduplication state have been preserved.'
