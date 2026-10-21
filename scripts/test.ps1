[CmdletBinding()]
param([string]$PythonPath, [string]$ConnectorPackageParent)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    & node --require ./tests/bootstrap.cjs --test 'tests/*.test.cjs'
    if ($LASTEXITCODE -ne 0) { throw 'Node tests failed.' }
    $parseErrors = @()
    Get-ChildItem -LiteralPath $root -Filter '*.ps1' -Recurse | Where-Object { $_.FullName -notmatch '\\.local\\' } | ForEach-Object {
        $tokens = $null; $errors = $null
        [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
        $parseErrors += @($errors)
    }
    if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
    if ($PythonPath -and $ConnectorPackageParent) {
        $old = $env:AA_CONNECTOR_PACKAGE_PARENT
        try {
            $env:AA_CONNECTOR_PACKAGE_PARENT = $ConnectorPackageParent
            & $PythonPath -B ./connector/workbuddy/test_adapter.py -q
            if ($LASTEXITCODE -ne 0) { throw 'Python adapter tests failed.' }
        } finally { $env:AA_CONNECTOR_PACKAGE_PARENT = $old }
    } else { Write-Host 'Python adapter tests skipped: supply -PythonPath and -ConnectorPackageParent for Connector 2.0.3.' }
} finally { Pop-Location }
