$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

# Keeps scripts\serve_signal_status.js alive. Nothing else does: unlike the scan job (a fresh
# process per scheduled run) the dashboard is a long-lived server, so a crash leaves it dead until
# somebody notices by hand. Found 2026-08-05 after it had been down since a SyntaxError crash on
# 08-04 16:28 — the syntax error was already fixed in the file by then, so a 5-minute relaunch loop
# would have brought it straight back on its own.
#
# Deliberately NOT gated on market hours (unlike tv_watchdog.ps1): the dashboard is a read-only
# local UI over already-collected data and is just as useful at night and on weekends.

$root      = (Get-Location).Path
$port      = if ($env:SIGNAL_DASHBOARD_PORT) { [int]$env:SIGNAL_DASHBOARD_PORT } else { 3030 }
$serverRel = 'scripts\serve_signal_status.js'
$probeUrl  = "http://127.0.0.1:$port/api/scan-state"
$stateFile = Join-Path $root 'status\dashboard-watchdog-state.json'
$logFile   = Join-Path $root 'dashboard-watchdog.log'
$serverLog = Join-Path $root 'dashboard-server.log'

$maxHang      = 3   # consecutive bound-but-unresponsive checks (~15 min) before kill + relaunch
$startupWait  = 24  # seconds to wait for a freshly launched server to answer
$checkAfter   = 3   # consecutive failed launches before running node --check to explain why

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch {}
}

function Read-State {
  if (Test-Path $stateFile) {
    try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch {}
  }
  return [PSCustomObject]@{ hangCount = 0; launchFailures = 0; lastCheck = $null; lastLaunch = $null }
}

function Save-State($s) {
  try { $s | ConvertTo-Json | Set-Content $stateFile -Encoding utf8 } catch {}
}

function Set-Field($obj, [string]$name, $value) {
  $obj | Add-Member NoteProperty $name $value -Force
}

# Cheapest route on the server: pure in-memory state, no file reads and no console.log, so a probe
# costs nothing and cannot itself be the thing that stalls.
function Test-Dashboard {
  try {
    $r = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# Processes actually listening on the port, with their command lines — used to tell "our server is
# hung" from "something else owns this port", which must never be killed.
function Get-PortListeners {
  $out = @()
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  } catch { return $out }
  # NOT $pid — that is a read-only automatic variable and assigning to it throws.
  foreach ($procId in ($conns | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)) {
    if (-not $procId -or $procId -eq 0) { continue }
    $cmd = ''
    try { $cmd = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch {}
    $out += [PSCustomObject]@{ Pid = [int]$procId; CommandLine = $cmd }
  }
  return $out
}

function Test-IsDashboardProcess($listener) {
  return ($listener.CommandLine -like '*serve_signal_status*')
}

function Get-NodeExe {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe',
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) { return $candidates[0] }
  try { return (Get-Command node -ErrorAction Stop).Source } catch { return $null }
}

# Delegates to scripts\start_dashboard_detached.cmd, which owns the redirect. Building the redirect
# here and passing it through `Start-Process cmd.exe -ArgumentList '/c "..."'` was tried first and
# is not reliable — cmd's rules for stripping the outer quote pair made it fail with '"C"' is not
# recognized even with /s, while a byte-identical standalone reproduction worked. The batch file has
# no quoting layer, and can be double-clicked to reproduce a startup failure by hand.
function Start-Dashboard {
  $launcher = Join-Path $root 'scripts\start_dashboard_detached.cmd'
  if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
  Start-Process -FilePath $launcher -WindowStyle Hidden -WorkingDirectory $root
}

function Wait-ForDashboard([int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Dashboard) { return $true }
  }
  return $false
}

# ── Main ──────────────────────────────────────────────────────────────────────

$state = Read-State
Set-Field $state 'lastCheck' ([datetime]::UtcNow.ToString('o'))

if (Test-Dashboard) {
  if ([int]$state.hangCount -gt 0 -or [int]$state.launchFailures -gt 0) {
    Write-Log "Dashboard healthy on port $port (recovered)."
  }
  Set-Field $state 'hangCount' 0
  Set-Field $state 'launchFailures' 0
  Save-State $state
  exit 0
}

$listeners = @(Get-PortListeners)
$ours      = @($listeners | Where-Object { Test-IsDashboardProcess $_ })
$foreign   = @($listeners | Where-Object { -not (Test-IsDashboardProcess $_) })

if ($foreign.Count -gt 0 -and $ours.Count -eq 0) {
  $desc = ($foreign | ForEach-Object { "pid $($_.Pid): $($_.CommandLine)" }) -join ' | '
  Write-Log "Port $port is held by a process that is not the dashboard - refusing to touch it. $desc"
  Save-State $state
  exit 1
}

if ($ours.Count -gt 0) {
  # Bound but not answering. Give it a few cycles before killing: a slow request is far more likely
  # than a wedged event loop, and killing mid-write is worse than waiting another 5 minutes.
  $hang = [int]$state.hangCount + 1
  Set-Field $state 'hangCount' $hang
  $pids = ($ours | ForEach-Object { $_.Pid }) -join ', '
  if ($hang -lt $maxHang) {
    Write-Log "Dashboard bound on port $port (pids: $pids) but not responding (strike $hang / $maxHang). Waiting."
    Save-State $state
    exit 1
  }
  Write-Log "Dashboard unresponsive for $hang consecutive checks (pids: $pids). Killing and relaunching."
  foreach ($p in $ours) {
    try { Stop-Process -Id $p.Pid -Force -ErrorAction Stop } catch { Write-Log "  Failed to stop pid $($p.Pid): $_" }
  }
  Start-Sleep -Seconds 2
  Set-Field $state 'hangCount' 0
} else {
  Write-Log "Dashboard not running on port $port - starting it."
}

Set-Field $state 'lastLaunch' ([datetime]::UtcNow.ToString('o'))
try {
  Start-Dashboard
} catch {
  Write-Log "Launch failed: $_"
  Set-Field $state 'launchFailures' ([int]$state.launchFailures + 1)
  Save-State $state
  exit 1
}

if (Wait-ForDashboard -seconds $startupWait) {
  Write-Log "Dashboard started and answering on http://127.0.0.1:$port/"
  Set-Field $state 'launchFailures' 0
  Save-State $state
  exit 0
}

# Retrying every 5 minutes forever is the right behaviour here, not a crash-loop to back off from:
# the real 08-04 outage was a syntax error that had already been fixed in the file, so the next
# attempt would have succeeded on its own. Surface WHY it keeps failing instead of giving up.
$fails = [int]$state.launchFailures + 1
Set-Field $state 'launchFailures' $fails
Write-Log "Dashboard did not come up within ${startupWait}s (consecutive failed launches: $fails). See $serverLog."

# The 08-04 outage was a SyntaxError, so name the cause in this log rather than making the next
# reader correlate two files by hand.
if ($fails -ge $checkAfter) {
  $node = Get-NodeExe
  if (-not $node) {
    Write-Log 'Cannot run node --check: Node.js executable not found.'
  } else {
    # node --check reports syntax errors on stderr, captured via a temp file rather than 2>&1: this
    # script runs under $ErrorActionPreference='Stop', where redirecting a native exe's stderr
    # inline turns each line into a NativeCommandError that can abort the run. Same reason
    # run_signal_job.ps1 uses a temp file for the scan job's stderr.
    $errFile = Join-Path $env:TEMP ("dashboard-watchdog-check-{0}.txt" -f $PID)
    try {
      & $node '--check' (Join-Path $root $serverRel) 2>$errFile | Out-Null
      $code = $LASTEXITCODE
      $detail = ''
      if (Test-Path $errFile) { $detail = (Get-Content $errFile -Raw).Trim() }
      if ($code -ne 0) {
        Write-Log "node --check on $serverRel FAILED: $detail"
      } else {
        Write-Log "node --check on $serverRel passes - the failure is at runtime, not a syntax error."
      }
    } catch {
      Write-Log "node --check could not be run: $_"
    } finally {
      Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    }
  }
}

Save-State $state
exit 1
