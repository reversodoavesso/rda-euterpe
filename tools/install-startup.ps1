# Compatibilidade: delega ao mesmo instalador nativo usado nas outras plataformas.
[CmdletBinding()]
param([switch]$Remove, [string]$ExePath, [switch]$Quiet)
$ErrorActionPreference = 'Stop'
if (-not $ExePath) {
    $candidates = @(
        (Join-Path $env:APPDATA 'euterpe/euterpe.exe'),
        (Join-Path $PSScriptRoot '../core/target/release/euterpe.exe'),
        (Join-Path $PSScriptRoot '../core/target/x86_64-pc-windows-gnu/release/euterpe.exe')
    )
    $ExePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $ExePath) { throw 'Compile o daemon ou informe -ExePath.' }
$exe = (Resolve-Path -LiteralPath $ExePath).Path
$arguments = @('install-startup')
if ($Remove) { $arguments += '--remove' }
if ($Quiet) { & $exe @arguments | Out-Null } else { & $exe @arguments }
if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar autostart.' }
if (-not $Remove) {
    if ($Quiet) { & $exe --ensure | Out-Null } else { & $exe --ensure }
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar daemon.' }
}
