[CmdletBinding()]
param([switch]$Remove, [string]$ShortcutDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $root 'config.local.json') -Raw | ConvertFrom-Json
$local = Join-Path $root '.local'
$vbs = Join-Path $local 'launch.vbs'
# ASCII shortcut name works in both Windows PowerShell 5.1 and PowerShell 7.
$file = Join-Path $ShortcutDirectory 'WorkBuddy - Agents Anywhere.lnk'
$shell = New-Object -ComObject WScript.Shell
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (Test-Path -LiteralPath $file) {
    $old = $shell.CreateShortcut($file)
    if ($old.TargetPath -ne $wscript -or $old.Arguments -ne ('"' + $vbs + '"')) { throw 'Shortcut already exists and belongs to another installation; left unchanged.' }
}
if ($Remove) {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    return
}
New-Item -ItemType Directory -Path $local -Force | Out-Null
$command = '"' + $config.nodePath + '" "' + (Join-Path $root 'bridge\launch.cjs') + '"'
$source = 'CreateObject("WScript.Shell").Run "' + $command.Replace('"','""') + '", 0, False'
# UTF-16 is understood by WScript and preserves non-ASCII install paths.
[IO.File]::WriteAllText($vbs, $source, [Text.Encoding]::Unicode)
$link = $shell.CreateShortcut($file)
$link.TargetPath = $wscript; $link.Arguments = '"' + $vbs + '"'; $link.WorkingDirectory = $root
$link.IconLocation = $config.workbuddyExe + ',0'
$link.Description = 'WorkBuddy with the local Agents Anywhere bridge'
$link.Save()
