[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$WorkBuddyExe,
    [string]$Workspace,
    [string]$AgentsAnywhereRoot,
    [string]$AgentsAnywhereData,
    [string[]]$ConnectorPath,
    [string]$NodePath,
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'AgentsAnywhereWorkBuddy'),
    [ValidateSet('prompt','off','check','repair')][string]$MonitorMode = 'prompt',
    [switch]$EnableWatchdog,
    [switch]$DisableWatchdog,
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This adapter currently supports Windows only.' }
if ($EnableWatchdog -and $DisableWatchdog) { throw 'Choose only one watchdog switch.' }
if ($EnableWatchdog) { $MonitorMode = 'repair' }
if ($DisableWatchdog) { $MonitorMode = 'off' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$major = & $NodePath -p 'process.versions.node.split(".")[0]'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'Install Node.js 24 or newer first.' }
if (-not $WorkBuddyExe) { $WorkBuddyExe = (Read-Host 'Full path to WorkBuddyAI.exe').Trim('"') }
if (-not $Workspace) { $Workspace = (Read-Host 'Existing project directory to allow').Trim('"') }
$WorkBuddyExe = (Resolve-Path -LiteralPath $WorkBuddyExe).Path
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
if (-not $ConnectorPath) {
    if (-not $AgentsAnywhereRoot) { $AgentsAnywhereRoot = (Read-Host 'Agents Anywhere installation root (contains resources or app/resources)').Trim('"') }
    $AgentsAnywhereRoot = (Resolve-Path -LiteralPath $AgentsAnywhereRoot).Path
    $candidates = @((Join-Path $AgentsAnywhereRoot 'resources\connector\connector'), (Join-Path $AgentsAnywhereRoot 'app\resources\connector\connector'))
    if (-not $AgentsAnywhereData) {
        $portable = Join-Path $AgentsAnywhereRoot 'data\connector'
        if (Test-Path -LiteralPath $portable) { $AgentsAnywhereData = $portable }
        else { $AgentsAnywhereData = Join-Path $env:APPDATA 'Agents Anywhere\connector' }
    }
    $managed = Join-Path $AgentsAnywhereData 'connector-source'
    if (Test-Path -LiteralPath $managed) {
        $candidates += @(Get-ChildItem -LiteralPath $managed -Directory | ForEach-Object { Join-Path $_.FullName 'connector' })
    }
    $ConnectorPath = @($candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'runtimes\providers.py') } | Select-Object -Unique)
}
if (-not $ConnectorPath -or $ConnectorPath.Count -eq 0) { throw 'No Python Connector found. Packaged binary-only Connectors are not supported.' }
$ConnectorPath = @($ConnectorPath | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
if ($MonitorMode -eq 'prompt') {
    Write-Host 'Optional local monitoring (default: off):'
    Write-Host '  0 = Off; 1 = Check only; 2 = Check + reattach existing desktop bridge'
    Write-Host 'No messages, server logins, app/worker restarts, or automatic WorkBuddy launches.'
    $answer = Read-Host 'Choose 0 / 1 / 2 [0]'
    switch ($answer) { '1' { $MonitorMode = 'check' } '2' { $MonitorMode = 'repair' } { $_ -in @('', '0') } { $MonitorMode = 'off' } default { throw 'Invalid monitor choice.' } }
}
$config = @{ workbuddyExe=$WorkBuddyExe; workspace=$Workspace; nodePath=$NodePath; stateDir=[IO.Path]::GetFullPath($StateDir); connectorPaths=@($ConnectorPath); monitorMode=$MonitorMode }
$temp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($temp, ($config | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    & $NodePath (Join-Path $PSScriptRoot 'scripts\install-core.cjs') install $temp --dry-run
    if ($LASTEXITCODE -ne 0) { throw 'Installation preflight failed; no application files were changed.' }
    if (-not $PSCmdlet.ShouldProcess(($ConnectorPath -join ', '), 'Install WorkBuddy adapter and optional local monitor')) { return }
    # The endpoint authentication secret must remain private to this Windows user.
    New-Item -ItemType Directory -Path $config.stateDir -Force | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $config.stateDir '/inheritance:r' '/grant:r' (('*{0}:(OI)(CI)F' -f $sid)) '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict bridge state directory permissions.' }
    & $NodePath (Join-Path $PSScriptRoot 'scripts\install-core.cjs') install $temp
    if ($LASTEXITCODE -ne 0) { throw 'Adapter installation failed. Check the error above.' }
    if (-not $NoShortcut) { & (Join-Path $PSScriptRoot 'scripts\shortcut.ps1') }
    & (Join-Path $PSScriptRoot 'set-monitor.ps1') -Mode $MonitorMode
    Write-Host 'Installed. Fully quit/reopen Agents Anywhere to reload Connector. Close plain WorkBuddy once, then use the new bridge shortcut.'
    Write-Host 'In Agents Anywhere: choose this device, add WorkBuddy, and select the same project directory.'
} finally { Remove-Item -LiteralPath $temp -Force -WhatIf:$false -ErrorAction SilentlyContinue }
