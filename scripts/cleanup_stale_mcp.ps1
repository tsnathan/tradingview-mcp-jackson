<#
.SYNOPSIS
  Find (and optionally kill) orphaned tradingview-mcp `server.js` processes.

.DESCRIPTION
  The MCP server is a stdio server: it runs until its stdin closes. Launched properly by an MCP
  client that is exactly right -- when the client exits, the pipe closes and the server exits.
  Measured 2026-08-06: `node src/server.js < /dev/null` exits in ~1 s, so the SDK's EOF handling
  is NOT the problem and does not need fixing.

  The leak comes from running `node src/server.js` in a SHELL (e.g. a Claude Code Bash tool call).
  The server inherits the shell's still-open stdin, so it waits on stdin forever while the shell
  waits on it -- a mutual deadlock nothing breaks from the inside. Ten such pairs accumulated from
  a single session on 2026-08-02 and were still resident four days later holding 52 MB.

  PREVENTION BEATS THIS SCRIPT: never launch the MCP server from a shell. If you need to smoke-test
  that it boots, redirect stdin -- `node src/server.js < /dev/null` -- and it exits by itself.

.PARAMETER MinAgeHours
  Only consider processes older than this. Default 4.

.PARAMETER Apply
  Actually kill. WITHOUT THIS THE SCRIPT ONLY REPORTS -- dry run is the default on purpose, in
  keeping with this project's detect-and-surface convention for anything that mutates live state.

.EXAMPLE
  powershell -File scripts\cleanup_stale_mcp.ps1              # report only
  powershell -File scripts\cleanup_stale_mcp.ps1 -Apply       # kill what it reports
#>
[CmdletBinding()]
param(
  [int]$MinAgeHours = 4,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogFile     = Join-Path $ProjectRoot 'cleanup-stale-mcp.log'
$Now         = Get-Date

# An MCP client owns its server's lifetime; killing one of those would break a live session.
# Parentage is the strong discriminator -- a properly-launched server is a child of the client,
# a leaked one is a child of a shell. Age alone is NOT safe: a real session can run all day.
$ClientParents = @('claude', 'claude-code', 'code', 'devenv', 'idea64', 'node')

function Write-Log([string]$Message) {
  $line = "[{0}] {1}" -f $Now.ToString('yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

$candidates = @()

foreach ($p in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
  $cmd = $p.CommandLine
  if (-not $cmd) { continue }

  # Must be THIS project's MCP server. Match the repo path when it is spelled out, and also the
  # bare `server.js` form a shell produces when it was launched from the project directory.
  $isThisServer =
    ($cmd -match [regex]::Escape($ProjectRoot) -and $cmd -match 'server\.js') -or
    ($cmd -match '(^|[\\/"\s])server\.js(\s|"|$)')
  if (-not $isThisServer) { continue }

  # Never touch the dashboard or a scan -- different long-lived processes with their own supervision.
  if ($cmd -match 'serve_signal_status|run_signal_job') { continue }

  $ageHours = ($Now - $p.CreationDate).TotalHours
  if ($ageHours -lt $MinAgeHours) { continue }

  $parentName = '<gone>'
  try {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction Stop
    if ($parent) { $parentName = [System.IO.Path]::GetFileNameWithoutExtension($parent.Name) }
  } catch { }

  # A live MCP client owns this process. Leave it alone regardless of age.
  if ($ClientParents -contains $parentName.ToLower()) { continue }

  $candidates += [PSCustomObject]@{
    PID        = $p.ProcessId
    AgeHours   = [math]::Round($ageHours, 1)
    Parent     = $parentName
    ParentPID  = $p.ParentProcessId
    MB         = [math]::Round($p.WorkingSetSize / 1MB, 1)
    Started    = $p.CreationDate
  }
}

if ($candidates.Count -eq 0) {
  Write-Output "No orphaned MCP server processes (older than ${MinAgeHours}h with a non-client parent)."
  exit 0
}

$totalMB = [math]::Round((($candidates | Measure-Object -Property MB -Sum).Sum), 1)
Write-Output "Found $($candidates.Count) orphaned MCP server process(es), $totalMB MB:"
$candidates | Sort-Object Started | Format-Table -AutoSize | Out-String | Write-Output

if (-not $Apply) {
  Write-Output "Dry run. Re-run with -Apply to kill these."
  exit 0
}

$killed = 0
$parents = @()
foreach ($c in $candidates) {
  try {
    Stop-Process -Id $c.PID -Force -ErrorAction Stop
    $killed++
    $parents += $c.ParentPID
    Write-Output "  killed $($c.PID) (age $($c.AgeHours)h, parent $($c.Parent))"
  } catch {
    Write-Output "  FAILED $($c.PID): $($_.Exception.Message)"
  }
}

# The shell parent is usually blocked waiting on the child and exits by itself once it dies --
# observed for all 10 on 2026-08-06. Sweep only the ones that did not, and only if they are old
# enough to be from a dead session. Never kill a recent shell: it may be the CURRENT one running
# this very script.
Start-Sleep -Seconds 2
foreach ($pp in ($parents | Sort-Object -Unique)) {
  try {
    $b = Get-CimInstance Win32_Process -Filter "ProcessId=$pp" -ErrorAction Stop
    if (-not $b) { continue }
    if ($b.Name -notmatch '^(bash|sh|cmd|powershell|pwsh)\.exe$') { continue }
    if (($Now - $b.CreationDate).TotalHours -lt $MinAgeHours) { continue }
    Stop-Process -Id $pp -Force -ErrorAction Stop
    Write-Output "  killed orphaned shell $pp ($($b.Name))"
  } catch { }
}

Write-Log "reaped $killed orphaned MCP server process(es), ${totalMB} MB"
Write-Output "Done. Reaped $killed process(es), ${totalMB} MB. Logged to $LogFile"
