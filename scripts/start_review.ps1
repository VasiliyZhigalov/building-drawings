param([int]$Port = 8765, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $workspaceRoot 'review-app\server.py'
$runtimePython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    $runtimePython = (Get-Command python -ErrorAction Stop).Source
}
$url = "http://127.0.0.1:$Port"
$running = $false
try {
    $response = Invoke-WebRequest -Uri "$url/api/projects" -TimeoutSec 2
    $running = $response.StatusCode -eq 200
} catch {}
if (-not $running) {
    $logDir = Join-Path $workspaceRoot 'review-app\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $arguments = @('-u',('"'+$serverPath+'"'),'--port',"$Port")
    Start-Process -FilePath $runtimePython -ArgumentList $arguments -WindowStyle Hidden -WorkingDirectory $workspaceRoot -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $response = Invoke-WebRequest -Uri "$url/api/projects" -TimeoutSec 1; if ($response.StatusCode -eq 200) { $running = $true; break } } catch {}
    }
}
if (-not $running) { throw 'Не удалось запустить интерфейс. Проверьте review-app/logs/server-error.log.' }
Write-Output $url
if (-not $NoBrowser) { Start-Process $url }
