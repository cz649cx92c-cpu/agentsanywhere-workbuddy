[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('off','check','repair')][string]$Mode)
$ErrorActionPreference = 'Stop'
$configFile = Join-Path $PSScriptRoot 'config.local.json'
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$hash = [Security.Cryptography.SHA256]::Create()
try { $id = -join ($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') }) } finally { $hash.Dispose() }
$name = 'AgentsAnywhereWorkBuddy-' + $id.Substring(0,12)
$script = Join-Path $PSScriptRoot 'scripts\monitor.cjs'
$local = Join-Path $PSScriptRoot '.local'
$wrapper = Join-Path $local 'monitor.vbs'
$executable = Join-Path $env:WINDIR 'System32\wscript.exe'
$arguments = '"' + $wrapper + '"'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    $actions = @($existing.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Execute -ne $executable -or $actions[0].Arguments -ne $arguments) { throw 'Existing task is not owned by this checkout; left unchanged.' }
}
New-Item -ItemType Directory -Force -Path $local | Out-Null
$settings = Join-Path $local 'monitor.json'
# Set off first: a concurrent scheduled run cannot attempt a repair during changes.
[IO.File]::WriteAllText($settings, '{"mode":"off"}', [Text.UTF8Encoding]::new($false))
if ($Mode -eq 'off') {
    if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
    Write-Host 'Local monitoring disabled. Runtime reconnection remains available while Connector is running.'
    return
}
$command = '"' + $config.nodePath + '" "' + $script + '" --scheduled'
$source = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"','""') + '", 0, True'
[IO.File]::WriteAllText($wrapper, $source, [Text.Encoding]::Unicode)
$action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$options = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $options -Description 'Optional local WorkBuddy bridge checks. No prompts, server credentials or app restarts.' -Force | Out-Null
[IO.File]::WriteAllText($settings, (@{mode=$Mode;taskName=$name} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Local monitor enabled: $Mode, every 2 minutes while this user is logged on."
