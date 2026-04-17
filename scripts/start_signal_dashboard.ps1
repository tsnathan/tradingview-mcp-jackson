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

& $node '.\scripts\serve_signal_status.js'
