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
  }

  $rulesPath = Join-Path (Get-Location) 'rules.json'
  if (-not (Test-Path $rulesPath)) {
    return $default
  }

  try {
    $rules = Get-Content $rulesPath -Raw | ConvertFrom-Json
    if ($rules.market_hours) {
      return @{
        timezone = if ($rules.market_hours.timezone) { [string]$rules.market_hours.timezone } else { $default.timezone }
        open = if ($rules.market_hours.open) { [string]$rules.market_hours.open } else { $default.open }
        close = if ($rules.market_hours.close) { [string]$rules.market_hours.close } else { $default.close }
        days = if ($rules.market_hours.days) { @($rules.market_hours.days | ForEach-Object { [string]$_ }) } else { $default.days }
      }
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
  $timezoneId = Convert-IanaToWindowsTimeZoneId $gate.timezone
  $now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, $timezoneId)
  $weekday = $now.ToString('ddd', [System.Globalization.CultureInfo]::InvariantCulture)

  if ($gate.days -notcontains $weekday) {
    return $false
  }

  $currentMinutes = ($now.Hour * 60) + $now.Minute
  $openMinutes = (Convert-TimeToMinutes $gate.open) + 1
  $closeMinutes = Convert-TimeToMinutes $gate.close

  if ($currentMinutes -lt $openMinutes -or $currentMinutes -gt $closeMinutes) {
    return $false
  }

  return (($currentMinutes - $openMinutes) % 15) -eq 0
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
  # ELECTRON_EXTRA_LAUNCH_ARGS must be set in the launching process so it is inherited
  $env:ELECTRON_EXTRA_LAUNCH_ARGS = '--remote-debugging-port=9222'
  Start-Process -FilePath $Exe
}

if (-not (Test-ShouldRunNow)) {
  Write-Host 'Skipping scheduled signal scan: outside weekday market cadence.'
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

$output = & $node '.\scripts\run_signal_job.js' --notify
if ($LASTEXITCODE -ne 0) {
  throw 'Signal scan failed.'
}

if ($output) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path '.\signal-scan.log' -Value ("[$timestamp] " + ($output -join "`n"))
  $output
}
