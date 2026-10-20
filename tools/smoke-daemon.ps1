<#
    tools/smoke-daemon.ps1 — smoke test end-to-end do daemon (sem Spotify).

    Sobe o `euterpe.exe` num diretório de dados temporário e numa porta alta,
    exercita os contratos congelados por HTTP e derruba o processo no fim.
    Sai 1 se qualquer checagem falhar.

    Uso:
      powershell -ExecutionPolicy Bypass -File tools/smoke-daemon.ps1
      powershell -ExecutionPolicy Bypass -File tools/smoke-daemon.ps1 -Port 8399
#>
[CmdletBinding()]
param(
    [int]$Port = 8399,
    [string]$ExePath
)

$ErrorActionPreference = 'Stop'
$failures = New-Object System.Collections.Generic.List[string]
$checks = 0

function Check([string]$name, [bool]$condition, [string]$detail = '') {
    $script:checks++
    if ($condition) {
        Write-Host ("  [ok]   " + $name)
    } else {
        Write-Host ("  [FAIL] " + $name + $(if ($detail) { " -> $detail" } else { '' }))
        $script:failures.Add($name)
    }
}

function Json([string]$url, [string]$method = 'GET', $body = $null, [hashtable]$headers = @{}) {
    $params = @{ Uri = $url; Method = $method; TimeoutSec = 20 }
    if ($body -ne $null) {
        $params.Body = ($body | ConvertTo-Json -Depth 12 -Compress)
        $params.ContentType = 'application/json'
    }
    if ($headers.Count -gt 0) { $params.Headers = $headers }
    return Invoke-RestMethod @params
}

if (-not $ExePath) {
    $candidates = @(
        (Join-Path $PSScriptRoot '..\core\target\release\euterpe.exe'),
        (Join-Path $PSScriptRoot '..\core\target\x86_64-pc-windows-gnu\release\euterpe.exe'),
        (Join-Path $env:APPDATA 'euterpe\euterpe.exe')
    )
    $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
    throw "euterpe.exe não encontrado. Rode 'cargo build --release' em core/ ou passe -ExePath."
}

$dataDir = Join-Path $env:TEMP ("euterpe-smoke-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$base = "http://127.0.0.1:$Port"

Write-Host "euterpe: $ExePath"
Write-Host "dados:   $dataDir"
Write-Host "base:    $base"
Write-Host ''

$env:EUTERPE_DATA_DIR = $dataDir
$env:PORT = "$Port"
$env:HOST = '127.0.0.1'
$env:EUTERPE_WEB_SEARCH = 'off'   # nenhuma checagem depende de rede

$proc = Start-Process -FilePath $ExePath -ArgumentList 'serve' -PassThru -WindowStyle Hidden

try {
    # 1) sobe e responde /health com app:"euterpe"
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Json "$base/health"
            $ready = $true
            break
        } catch { }
    }
    Check 'daemon sobe e responde /health' $ready
    if (-not $ready) { throw 'daemon não subiu' }

    Write-Host ''
    Check '/health.app == "euterpe"' ($health.app -eq 'euterpe') ($health | ConvertTo-Json -Compress)
    Check '/health.ok == true' ($health.ok -eq $true)
    Check '/health.version preenchido' ($null -ne $health.version)

    # 2) C5: /config, /sessions, /probe
    $config = Json "$base/config"
    Check '/config.secret presente' ($config.secret.Length -ge 32) ("len=" + $config.secret.Length)
    Check '/config.version == /health.version' ($config.version -eq $health.version)

    $sessions = Json "$base/sessions"
    Check '/sessions responde array' ($sessions -is [array] -or $sessions -eq $null)

    $probeStatus = 0
    try { Json "$base/probe" | Out-Null } catch { $probeStatus = [int]$_.Exception.Response.StatusCode }
    Check '/probe sem cliente == 503' ($probeStatus -eq 503) "status=$probeStatus"

    # 3) settings e providers
    $settings = Json "$base/settings"
    Check 'settings.mutationPolicy default == allow' ($settings.settings.mutationPolicy -eq 'allow')
    Check 'settings.runtime.dataDir preenchido' ($null -ne $settings.runtime.dataDir)

    $patched = Json "$base/settings" 'PUT' @{ mutationPolicy = 'confirm'; suggestions = $false; maxToolSteps = 4 }
    Check 'PUT /settings aplica mutationPolicy' ($patched.settings.mutationPolicy -eq 'confirm')
    Check 'PUT /settings aplica maxToolSteps' ($patched.settings.maxToolSteps -eq 4)

    $providers = Json "$base/providers"
    $ids = @($providers.providers | ForEach-Object { $_.id })
    Check '/providers lista deepseek/openai/anthropic/gemini/ollama' (
        ($ids -contains 'deepseek') -and ($ids -contains 'anthropic') -and ($ids -contains 'gemini') -and ($ids -contains 'ollama'))
    Check '/providers não vaza apiKey' (-not ($providers.providers | Where-Object { $_.PSObject.Properties.Name -contains 'apiKey' }))

    # 4) MCP (Streamable HTTP)
    $init = Json "$base/mcp" 'POST' @{
        jsonrpc = '2.0'; id = 1; method = 'initialize'
        params  = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'smoke'; version = '0' } }
    }
    Check 'MCP initialize devolve serverInfo.name == euterpe' ($init.result.serverInfo.name -eq 'euterpe')
    Check 'MCP initialize negocia a versão' ($init.result.protocolVersion -eq '2025-06-18')

    $list = Json "$base/mcp" 'POST' @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }
    Check 'MCP tools/list devolve 45 tools' (@($list.result.tools).Count -eq 45) ("count=" + @($list.result.tools).Count)
    Check 'MCP tools/list usa nomes spotify_*' (@($list.result.tools | Where-Object { $_.name -notlike 'spotify_*' }).Count -eq 0)

    $undo = Json "$base/mcp" 'POST' @{ jsonrpc = '2.0'; id = 3; method = 'tools/call'; params = @{ name = 'spotify_undo_last_mutation'; arguments = @{ playlist_id = 'x' } } }
    Check 'MCP expõe spotify_undo_last_mutation (D3)' ($null -ne $undo.result)

    $unknown = Json "$base/mcp" 'POST' @{ jsonrpc = '2.0'; id = 4; method = 'nao/existe'; params = @{} }
    Check 'MCP método desconhecido == -32601' ($unknown.error.code -eq -32601)

    # 5) chat via SSE (sem provider ⇒ fallback + chat.done, contrato de degradação)
    # O corpo vai por arquivo: PowerShell mangla as aspas de um `-d '{"json"}'`.
    $bodyFile = Join-Path $env:TEMP ("euterpe-chat-" + [Guid]::NewGuid().ToString('N') + ".json")
    '{"text":"oi","sessionId":"smoke"}' | Set-Content -NoNewline -Path $bodyFile -Encoding ascii
    $sse = & curl.exe -s -N -X POST "$base/chat" `
        -H 'content-type: application/json' `
        --data-binary "@$bodyFile" `
        --max-time 30 2>$null | Out-String
    Remove-Item -Force $bodyFile -ErrorAction SilentlyContinue
    Check 'SSE /chat emite event: done' ($sse -match 'event:\s*done') ($sse.Substring(0, [Math]::Min(200, $sse.Length)))
    Check 'SSE /chat devolve a sessão pedida' ($sse -match 'smoke')
    Check 'SSE /chat emite o status inicial' ($sse -match 'event:\s*(status|stream)')

    # 6) segunda instância é idempotente (guarda de porta)
    $second = Start-Process -FilePath $ExePath -ArgumentList 'serve' -PassThru -WindowStyle Hidden -Wait
    Check 'segunda instância sai com 0 (idempotente)' ($second.ExitCode -eq 0) ("exit=" + $second.ExitCode)
} finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("FALHOU: " + $failures.Count + " de " + $checks + " checagens")
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host ("OK: $checks checagens passaram")
exit 0
