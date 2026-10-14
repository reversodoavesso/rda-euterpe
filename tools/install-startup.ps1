<#
    tools/install-startup.ps1 — autostart do daemon Euterpe (PLAN-REFACTOR.md, D2).

    Plano A (decidido pela Fase 0): se o renderer do Spotify tiver acesso a Node,
    a extensão dá spawn no `euterpe.exe` (com guarda de porta). Este script é o
    **plano B** — e também o caminho recomendado para quem não quer depender do
    renderer: um atalho na pasta `Startup` do usuário.

    O daemon é idempotente: `euterpe serve` checa a porta e, se já existir um
    Euterpe respondendo `/health` com `app:"euterpe"`, sai com 0 sem brigar pela
    porta. Não há risco de dois daemons.

    Uso:
      powershell -ExecutionPolicy Bypass -File tools/install-startup.ps1
      powershell -ExecutionPolicy Bypass -File tools/install-startup.ps1 -Remove
      powershell -ExecutionPolicy Bypass -File tools/install-startup.ps1 -ExePath C:\caminho\euterpe.exe
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$ExePath,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcut = Join-Path $startupDir 'Euterpe.lnk'

function Resolve-Exe {
    if ($ExePath) {
        if (-not (Test-Path $ExePath)) { throw "Não encontrei o executável: $ExePath" }
        return (Resolve-Path $ExePath).Path
    }
    $installed = Join-Path $env:APPDATA 'euterpe\euterpe.exe'
    if (Test-Path $installed) { return $installed }
    $release = Join-Path $PSScriptRoot '..\core\target\x86_64-pc-windows-gnu\release\euterpe.exe'
    if (Test-Path $release) { return (Resolve-Path $release).Path }
    throw "Não encontrei o euterpe.exe. Rode 'cargo build --release' em core/ ou passe -ExePath."
}

if ($Remove) {
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Force
        Write-Host "atalho removido: $shortcut"
    } else {
        Write-Host "nenhum atalho encontrado em $shortcut"
    }
    exit 0
}

if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Force -Path $startupDir | Out-Null }

$exe = Resolve-Exe
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.Arguments = 'serve'
$link.WorkingDirectory = Split-Path $exe -Parent
$link.Description = 'Euterpe — bridge WS do Spotify + servidor MCP + chat agentic'
$link.Save()

if (-not $Quiet) {
    Write-Host "atalho criado: $shortcut"
    Write-Host "  alvo: $exe serve"
    Write-Host ""
    Write-Host "O daemon sobe no próximo logon. Para subir agora:"
    Write-Host "  & '$exe' serve"
}

exit 0
