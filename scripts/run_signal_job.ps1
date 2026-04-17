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

$output = & $node '.\scripts\run_signal_job.js' --notify
if ($LASTEXITCODE -ne 0) {
  throw 'Signal scan failed.'
}

if ($output) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path '.\signal-scan.log' -Value ("[$timestamp] " + ($output -join "`n"))
  $output
}
