[CmdletBinding()]
param([switch]$TestScheduledTask)
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$dir = Join-Path $tempRoot ('aa-workbuddy-smoke-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $dir 'checkout with spaces'
$configFile = Join-Path $repo 'config.local.json'
function Write-Text($File, $Text) {
    New-Item -ItemType Directory -Force -Path (Split-Path $File -Parent) | Out-Null
    [IO.File]::WriteAllText($File, $Text, [Text.UTF8Encoding]::new($false))
}
try {
    New-Item -ItemType Directory -Path $repo -Force | Out-Null
    foreach ($name in @('bridge','connector','scripts')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $repo $name) -Recurse }
    foreach ($name in @('install.ps1','uninstall.ps1','set-monitor.ps1')) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $repo $name) }
    $package = Join-Path $dir 'python package\connector'
    $provider = Join-Path $package 'runtimes\providers.py'
    $original = "from connector.runtimes.dsh.provider import DshProvider`n`ndef default_runtime_providers():`n    return (CodexProvider(), ClaudeProvider(), DshProvider())`n"
    Write-Text $provider $original
    Write-Text (Join-Path $package 'server\protocol.py') 'RuntimeName = Literal["codex", "claude", "dsh"]'
    Write-Text (Join-Path $package 'runtime_protocol\supervisor.py') '# fixture'
    $app = Join-Path $dir 'fake WorkBuddy\WorkBuddyAI.exe'
    Write-Text $app 'fixture only - never executed'
    Write-Text (Join-Path $dir 'fake WorkBuddy\resources\app.asar') 'fixture only'
    $project = Join-Path $dir 'test project'; New-Item -ItemType Directory -Path $project | Out-Null
    $state = Join-Path $dir 'private state'
    $parameters = @{WorkBuddyExe=$app;Workspace=$project;ConnectorPath=@($package);NodePath=(Get-Command node.exe).Source;StateDir=$state;MonitorMode='off';NoShortcut=$true}
    & (Join-Path $repo 'install.ps1') @parameters -WhatIf
    if (Test-Path -LiteralPath $configFile) { throw 'WhatIf unexpectedly installed config.' }
    & (Join-Path $repo 'install.ps1') @parameters
    if (-not (Test-Path -LiteralPath $configFile)) { throw 'Install did not create configuration.' }
    if ((Get-Content -LiteralPath $provider -Raw) -notmatch 'WorkBuddyProvider') { throw 'Provider was not installed.' }
    $desktop = Join-Path $dir 'isolated desktop'
    New-Item -ItemType Directory -Path $desktop | Out-Null
    & (Join-Path $repo 'scripts\shortcut.ps1') -ShortcutDirectory $desktop
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop 'WorkBuddy - Agents Anywhere.lnk'))
    if ($shortcut.TargetPath -notlike '*\wscript.exe' -or $shortcut.Arguments -notlike '*launch.vbs*') { throw 'Incorrect bridge shortcut.' }
    & (Join-Path $repo 'scripts\shortcut.ps1') -ShortcutDirectory $desktop -Remove
    if (Get-ChildItem -LiteralPath $desktop -Filter '*.lnk') { throw 'Shortcut was not removed.' }
    if ($TestScheduledTask) {
        & (Join-Path $repo 'set-monitor.ps1') -Mode check
        $settings = Get-Content (Join-Path $repo '.local\monitor.json') -Raw | ConvertFrom-Json
        $task = Get-ScheduledTask -TaskName $settings.taskName
        if ($task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited') { throw 'Task unexpectedly elevated or not interactive.' }
        & (Join-Path $repo 'set-monitor.ps1') -Mode repair
        & (Join-Path $repo 'set-monitor.ps1') -Mode off
        if (Get-ScheduledTask -TaskName $settings.taskName -ErrorAction SilentlyContinue) { throw 'Monitor task was not removed.' }
    }
    Write-Text (Join-Path $state 'keep-deduplication-state') 'preserve'
    & (Join-Path $repo 'uninstall.ps1') -NoShortcut -WhatIf
    if (-not (Test-Path -LiteralPath $configFile)) { throw 'Uninstall WhatIf changed files.' }
    & (Join-Path $repo 'uninstall.ps1') -NoShortcut
    if ([IO.File]::ReadAllText($provider) -ne $original) { throw 'Original provider not restored byte-for-byte.' }
    if (-not (Test-Path -LiteralPath (Join-Path $state 'keep-deduplication-state'))) { throw 'Uninstall removed state.' }
    Write-Host 'PASS: isolated PowerShell install/WhatIf/uninstall; optional task mode switches verified when requested.'
} finally {
    if (Test-Path -LiteralPath $configFile) {
        try { & (Join-Path $repo 'set-monitor.ps1') -Mode off } catch { Write-Warning 'Could not disable the temporary monitor; retain fixture for manual cleanup.'; $dir = $null }
    }
    if ($dir) {
        $resolved = [IO.Path]::GetFullPath($dir)
        if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'aa-workbuddy-smoke-*') { throw 'Refused unsafe temporary cleanup path.' }
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
