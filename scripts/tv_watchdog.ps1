$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

# ── Shared helpers ────────────────────────────────────────────────────────────

function Convert-IanaToWindowsTimeZoneId([string]$id) {
  switch ($id.Trim()) {
    'America/New_York'    { return 'Eastern Standard Time' }
    'America/Chicago'     { return 'Central Standard Time' }
    'America/Denver'      { return 'Mountain Standard Time' }
    'America/Los_Angeles' { return 'Pacific Standard Time' }
    default               { if ($id) { return $id } else { return 'Eastern Standard Time' } }
  }
}

function Get-ScheduleGate {
  $d = @{ timezone='America/New_York'; open='09:30'; close='16:00'; days=@('Mon','Tue','Wed','Thu','Fri'); holidays=@(); disabled=$false }
  $p = Join-Path (Get-Location) 'rules.json'
  if (-not (Test-Path $p)) { return $d }
  try {
    $r = Get-Content $p -Raw | ConvertFrom-Json
    if ($r.market_hours) {
      $d.timezone = if ($r.market_hours.timezone) { [string]$r.market_hours.timezone } else { $d.timezone }
      $d.open     = if ($r.market_hours.open)     { [string]$r.market_hours.open     } else { $d.open  }
      $d.close    = if ($r.market_hours.close)    { [string]$r.market_hours.close    } else { $d.close }
      $d.days     = if ($r.market_hours.days)     { @($r.market_hours.days | ForEach-Object { [string]$_ }) } else { $d.days }
      $d.holidays = if ($r.market_hours.holidays) { @($r.market_hours.holidays | ForEach-Object { [string]$_ }) } else { @() }
    }
    if ($r.schedule) {
      $d.disabled = if ($r.schedule.disabled) { [bool]$r.schedule.disabled } else { $d.disabled }
    }
  } catch {}
  return $d
}

function Convert-TimeToMinutes([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { $v = '00:00' }
  $p = $v.Split(':')
  return ([int]$p[0] * 60) + [int]$p[1]
}

function Test-MarketHours {
  $g  = Get-ScheduleGate
  if ($g.disabled) { return $false }
  $tz = Convert-IanaToWindowsTimeZoneId $g.timezone
  $now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, $tz)
  if ($g.days -notcontains $now.ToString('ddd', [System.Globalization.CultureInfo]::InvariantCulture)) { return $false }
  $marketDate = $now.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
  if ($g.holidays -contains $marketDate) { return $false }
  $cur   = $now.Hour * 60 + $now.Minute
  $open  = (Convert-TimeToMinutes $g.open) + 1
  $close = (Convert-TimeToMinutes $g.close) + 15
  return ($cur -ge $open -and $cur -le $close)
}

function Test-CdpReady {
  try {
    $null = Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3
    return $true
  } catch { return $false }
}

function Get-TradingViewExe {
  $candidates = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:PROGRAMFILES\TradingView\TradingView.exe",
    "${env:PROGRAMFILES(X86)}\TradingView\TradingView.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates) { return $candidates[0] }
  try {
    $loc = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction Stop | Select-Object -ExpandProperty InstallLocation
    if ($loc) { $e = Join-Path $loc 'TradingView.exe'; if (Test-Path $e) { return $e } }
  } catch {}
  try {
    $f = Get-ChildItem 'C:\Program Files\WindowsApps\TradingView.Desktop*\TradingView.exe' -ErrorAction Stop | Select-Object -First 1
    if ($f) { return $f.FullName }
  } catch {}
  return $null
}

function Start-TradingViewWithDebug([string]$Exe) {
  if ($Exe -match 'WindowsApps') {
    try {
      $pkg   = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction Stop
      $aumid = $pkg.PackageFamilyName + '!App'
      $src = @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string aumid,
                            [MarshalAs(UnmanagedType.LPWStr)] string args,
                            int options, out uint pid);
    int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string aumid, IntPtr items,
                        [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint pid);
    int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string aumid, IntPtr items, out uint pid);
}
[ComImport, Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c"), ClassInterface(ClassInterfaceType.None)]
public class ApplicationActivationManager {}
'@
      Add-Type -TypeDefinition $src -ErrorAction Stop
      $mgr   = [ApplicationActivationManager]::new() -as [IApplicationActivationManager]
      $tvPid = [uint32]0
      $mgr.ActivateApplication($aumid, '--remote-debugging-port=9222', 0, [ref]$tvPid) | Out-Null
      Write-Host "  Launched TradingView via IApplicationActivationManager (pid $tvPid)"
      return
    } catch { Write-Host "  IApplicationActivationManager failed: $_. Falling back to direct launch." }
  }
  $env:ELECTRON_EXTRA_LAUNCH_ARGS = '--remote-debugging-port=9222'
  Start-Process -FilePath $Exe
  Write-Host "  Launched TradingView (direct): $Exe"
}

# ── State ─────────────────────────────────────────────────────────────────────
# Persisted across 5-min task runs in status\watchdog-state.json

$stateFile      = Join-Path (Get-Location) 'status\watchdog-state.json'
$statusFile     = Join-Path (Get-Location) 'status\latest-signal-status.json'
$maxRetries     = 3   # consecutive failures before writing dashboard error
$cooldownSecs   = 240 # don't kill+relaunch if we already tried within 4 min

function Read-State {
  if (Test-Path $stateFile) {
    try { return Get-Content $stateFile -Raw | ConvertFrom-Json } catch {}
  }
  return [PSCustomObject]@{ failureCount = 0; lastAttempt = $null; lastLaunchAttempt = $null }
}

function Save-State($s) {
  $s | ConvertTo-Json | Set-Content $stateFile -Encoding utf8
}

function Write-DashboardError([int]$attempts) {
  $now = [datetime]::UtcNow
  $tz  = 'Eastern Standard Time'
  $et  = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($now, $tz)
  $msg = "Watchdog: TradingView failed to reconnect after $attempts retries (~$([int]($attempts * 5)) min). Last check: $($et.ToString('hh:mm tt')) ET"

  $status = $null
  if (Test-Path $statusFile) {
    try { $status = Get-Content $statusFile -Raw | ConvertFrom-Json } catch {}
  }
  if (-not $status) { $status = [PSCustomObject]@{} }

  $status | Add-Member NoteProperty updatedAt            ($now.ToString('o'))                       -Force
  $status | Add-Member NoteProperty formattedTimestampEt ($et.ToString('MM/dd/yyyy, hh:mm:ss tt')) -Force
  $status | Add-Member NoteProperty connectionError      $true                                      -Force
  $status | Add-Member NoteProperty watchdogError        $true                                      -Force
  $status | Add-Member NoteProperty watchdogAttempts     $attempts                                  -Force
  $status | Add-Member NoteProperty watchdogMessage      $msg                                       -Force
  $status | Add-Member NoteProperty errorMessage         $msg                                       -Force
  $status | Add-Member NoteProperty skipped              $true                                      -Force

  $status | ConvertTo-Json -Depth 10 | Set-Content $statusFile -Encoding utf8
  Write-Host "Dashboard updated: $msg"
}

# ── Main ──────────────────────────────────────────────────────────────────────

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "[$ts] TV Watchdog running"

if (-not (Test-MarketHours)) {
  Write-Host 'Outside market hours — exiting.'
  exit 0
}

$state = Read-State

# CDP accessible = TV connected with debug flag
if (Test-CdpReady) {
  Write-Host 'CDP ready - TradingView connected.'
  $state | Add-Member NoteProperty failureCount     0                               -Force
  $state | Add-Member NoteProperty lastAttempt      ([datetime]::UtcNow.ToString('o')) -Force
  Save-State $state
  exit 0
}

# CDP unavailable — increment failure counter
$fc = [int]($state.failureCount) + 1
$state | Add-Member NoteProperty failureCount $fc                               -Force
$state | Add-Member NoteProperty lastAttempt  ([datetime]::UtcNow.ToString('o')) -Force
Write-Host "CDP unavailable (consecutive failure $fc / $maxRetries)."

# Determine whether to kill + relaunch or just launch
$tvProcs = @(Get-Process -Name 'TradingView' -ErrorAction SilentlyContinue)
$lastLaunch = if ($state.lastLaunchAttempt) {
  try { [datetime]::Parse($state.lastLaunchAttempt) } catch { [datetime]::MinValue }
} else { [datetime]::MinValue }
$secsSinceLaunch = ([datetime]::UtcNow - $lastLaunch).TotalSeconds

if ($tvProcs.Count -gt 0 -and $secsSinceLaunch -gt $cooldownSecs) {
  $pids = ($tvProcs | ForEach-Object { $_.Id }) -join ', '
  Write-Host "TradingView running (pids: $pids) without debug flag - killing and relaunching."
  Stop-Process -Name 'TradingView' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
} elseif ($tvProcs.Count -gt 0) {
  $secs = [int]$secsSinceLaunch
  Write-Host "TradingView running but launch cooldown active (${secs}s since last launch). Waiting for CDP..."
} else {
  Write-Host 'TradingView not running - launching with debug flag.'
}

# Launch if process is now absent (killed above, or was never running)
$stillRunning = @(Get-Process -Name 'TradingView' -ErrorAction SilentlyContinue)
if ($stillRunning.Count -eq 0) {
  $tvExe = Get-TradingViewExe
  if ($tvExe) {
    $state | Add-Member NoteProperty lastLaunchAttempt ([datetime]::UtcNow.ToString('o')) -Force
    try {
      Start-TradingViewWithDebug -Exe $tvExe
    } catch {
      Write-Host "Launch failed: $_"
    }
  } else {
    Write-Host 'TradingView executable not found - cannot relaunch.'
  }
}

# Wait up to 30 s for CDP to come up
Write-Host 'Waiting for CDP...'
$cdpUp = $false
for ($i = 0; $i -lt 15 -and -not $cdpUp; $i++) {
  Start-Sleep -Seconds 2
  $cdpUp = Test-CdpReady
}

if ($cdpUp) {
  Write-Host 'CDP came up - TradingView reconnected.'
  $state | Add-Member NoteProperty failureCount 0 -Force
  Save-State $state
  exit 0
}

Write-Host "CDP still unavailable after waiting (total failures: $fc)."
Save-State $state

if ($fc -ge $maxRetries) {
  Write-DashboardError $fc
}

exit 1
