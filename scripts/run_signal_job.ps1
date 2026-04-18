$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

$nodeCandidates = @(
  'C:\Program Files\nodejs\node.exe',
  'C:\Program Files (x86)\nodejs\node.exe',
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)

$node = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) {
  throw 'Node.js executable not found.'
}

function Test-CdpReady {
  try {
    $null = Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-CdpReady)) {
  Write-Host 'TradingView debug endpoint unavailable. Attempting automatic launch...'

  if (Test-Path '.\scripts\launch_tv_debug.vbs') {
    Start-Process 'wscript.exe' -ArgumentList (Resolve-Path '.\scripts\launch_tv_debug.vbs') | Out-Null
  } elseif (Test-Path '.\scripts\launch_tv_debug.bat') {
    Start-Process -FilePath (Resolve-Path '.\scripts\launch_tv_debug.bat') | Out-Null
  }

  for ($i = 0; $i -lt 15 -and -not (Test-CdpReady); $i++) {
    Start-Sleep -Seconds 2
  }
}

$output = & $node '.\scripts\run_signal_job.js' --notify
if ($LASTEXITCODE -ne 0) {
  throw 'Signal scan failed.'
}

if ($output) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path '.\signal-scan.log' -Value ("[$timestamp] " + ($output -join "`n"))
  $output
}
