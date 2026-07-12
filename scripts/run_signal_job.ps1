$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

function Convert-IanaToWindowsTimeZoneId {
  param([string]$TimeZoneId)

  $normalized = if ([string]::IsNullOrWhiteSpace($TimeZoneId)) { '' } else { $TimeZoneId.Trim() }

  switch ($normalized) {
    'America/New_York' { return 'Eastern Standard Time' }
    'America/Chicago' { return 'Central Standard Time' }
    'America/Denver' { return 'Mountain Standard Time' }
    'America/Los_Angeles' { return 'Pacific Standard Time' }
    default {
      if ($normalized) {
        return $normalized
      }
      return 'Eastern Standard Time'
    }
  }
}

function Get-ScheduleGate {
  $default = @{
    timezone = 'America/New_York'
    open = '09:30'
    close = '16:00'
    days = @('Mon', 'Tue', 'Wed', 'Thu', 'Fri')
    holidays = @()
    disabled = $false
  }

  $rulesPath = Join-Path (Get-Location) 'rules.json'
  if (-not (Test-Path $rulesPath)) {
    return $default
  }

  try {
    $rules = Get-Content $rulesPath -Raw | ConvertFrom-Json
    if ($rules.market_hours) {
      $default.timezone = if ($rules.market_hours.timezone) { [string]$rules.market_hours.timezone } else { $default.timezone }
      $default.open = if ($rules.market_hours.open) { [string]$rules.market_hours.open } else { $default.open }
      $default.close = if ($rules.market_hours.close) { [string]$rules.market_hours.close } else { $default.close }
      $default.days = if ($rules.market_hours.days) { @($rules.market_hours.days | ForEach-Object { [string]$_ }) } else { $default.days }
      $default.holidays = if ($rules.market_hours.holidays) { @($rules.market_hours.holidays | ForEach-Object { [string]$_ }) } else { @() }
    }
    if ($rules.schedule) {
      $default.disabled = if ($rules.schedule.disabled) { [bool]$rules.schedule.disabled } else { $default.disabled }
    }
  } catch {}

  return $default
}

function Convert-TimeToMinutes {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    $Value = '00:00'
  }
  $parts = $Value.Split(':')
  $hours = [int]$parts[0]
  $minutes = [int]$parts[1]
  return ($hours * 60) + $minutes
}

function Test-ShouldRunNow {
  $gate = Get-ScheduleGate
  if ($gate.disabled) { return $false }

  $timezoneId = Convert-IanaToWindowsTimeZoneId $gate.timezone
  $now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, $timezoneId)
  $weekday = $now.ToString('ddd', [System.Globalization.CultureInfo]::InvariantCulture)

  if ($gate.days -notcontains $weekday) {
    return $false
  }

  $marketDate = $now.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
  if ($gate.holidays -contains $marketDate) {
    return $false
  }

  $currentMinutes = ($now.Hour * 60) + $now.Minute
  $openMinutes = (Convert-TimeToMinutes $gate.open) + 1
  $closeMinutes = Convert-TimeToMinutes $gate.close + 15

  return ($currentMinutes -ge $openMinutes -and $currentMinutes -le $closeMinutes)
}

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

function Get-TradingViewExe {
  $candidates = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:PROGRAMFILES\TradingView\TradingView.exe",
    "${env:PROGRAMFILES(X86)}\TradingView\TradingView.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }

  if ($candidates) {
    return $candidates[0]
  }

  # Check MSIX WindowsApps install
  try {
    $installLocation = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction Stop | Select-Object -ExpandProperty InstallLocation
    if ($installLocation) {
      $exe = Join-Path $installLocation 'TradingView.exe'
      if (Test-Path $exe) {
        return $exe
      }
    }
  } catch {}

  # Fallback: glob WindowsApps directly
  try {
    $found = Get-ChildItem 'C:\Program Files\WindowsApps\TradingView.Desktop*\TradingView.exe' -ErrorAction Stop | Select-Object -First 1
    if ($found) { return $found.FullName }
  } catch {}

  return $null
}

function Start-TradingViewWithDebug {
  param([string]$Exe)

  # MSIX (Microsoft Store) installs live under WindowsApps; the package activation broker
  # does not inherit environment variables, so ELECTRON_EXTRA_LAUNCH_ARGS has no effect.
  # Use IApplicationActivationManager COM interface to pass launch args directly.
  if ($Exe -match 'WindowsApps') {
    try {
      $pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction Stop
      $aumid = $pkg.PackageFamilyName + '!App'

      $src = @'
using System;
using System.Runtime.InteropServices;
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
      $mgr = [ApplicationActivationManager]::new() -as [IApplicationActivationManager]
      $tvPid = [uint32]0
      $mgr.ActivateApplication($aumid, '--remote-debugging-port=9222', 0, [ref]$tvPid) | Out-Null
      Write-Host "Launched TradingView via IApplicationActivationManager (pid $tvPid)"
      return
    } catch {
      Write-Host "IApplicationActivationManager failed: $_. Falling back to direct launch."
    }
  }

  # Classic (non-MSIX) install: env var is inherited by child process.
  $env:ELECTRON_EXTRA_LAUNCH_ARGS = '--remote-debugging-port=9222'
  Start-Process -FilePath $Exe
}

if (-not (Test-ShouldRunNow)) {
  Write-Host 'Skipping: outside weekday market hours.'
  exit 0
}

if (-not (Test-CdpReady)) {
  Write-Host 'TradingView debug endpoint unavailable. Attempting automatic launch...'

  $tvExe = Get-TradingViewExe
  if ($tvExe) {
    Start-TradingViewWithDebug -Exe $tvExe
  } elseif (Test-Path '.\scripts\launch_tv_debug.vbs') {
    Start-Process 'wscript.exe' -ArgumentList (Resolve-Path '.\scripts\launch_tv_debug.vbs') | Out-Null
  } elseif (Test-Path '.\scripts\launch_tv_debug.bat') {
    Start-Process -FilePath (Resolve-Path '.\scripts\launch_tv_debug.bat') | Out-Null
  }

  for ($i = 0; $i -lt 15 -and -not (Test-CdpReady); $i++) {
    Start-Sleep -Seconds 2
  }
}

$stderrFile = [System.IO.Path]::GetTempFileName()
try {
  $output = & $node '.\scripts\run_signal_job.js' --notify 2>$stderrFile
  $stderrOutput = Get-Content $stderrFile -ErrorAction SilentlyContinue
} finally {
  Remove-Item $stderrFile -ErrorAction SilentlyContinue
}

if ($LASTEXITCODE -ne 0) {
  throw 'Signal scan failed.'
}

if ($output -or $stderrOutput) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $combined = @($output) + @($stderrOutput) | Where-Object { $_ }
  Add-Content -Path '.\signal-scan.log' -Value ("[$timestamp] " + ($combined -join "`n"))
  $output
}
