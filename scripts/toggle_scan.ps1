$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$taskNames = @('TradingViewSignalScan15m', 'TVWatchdog')

$tasks = foreach ($name in $taskNames) {
  try { Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $null }
}
$tasks = $tasks | Where-Object { $_ }

if (-not $tasks) {
  [System.Windows.Forms.MessageBox]::Show(
    "None of the expected scheduled tasks were found:`n$($taskNames -join ', ')`n`nOpen Task Scheduler and confirm the task names.",
    'TradingView Scan Toggle', 'OK', 'Error'
  ) | Out-Null
  exit 1
}

# Treat the pair as currently "active" if any of them is enabled.
$currentlyEnabled = ($tasks | Where-Object { $_.State -ne 'Disabled' }).Count -gt 0
$turningOn = -not $currentlyEnabled

foreach ($task in $tasks) {
  if ($turningOn) {
    Enable-ScheduledTask -TaskName $task.TaskName | Out-Null
  } else {
    Disable-ScheduledTask -TaskName $task.TaskName | Out-Null
  }
}

$names = ($tasks | ForEach-Object { $_.TaskName }) -join ', '
if ($turningOn) {
  $msg = "Resumed automatic scanning.`n`nRe-enabled: $names`n`nThe next run will fire on its normal schedule (every 15 min for the scan, every 5 min for the watchdog) during market hours."
} else {
  $msg = "Suspended automatic scanning.`n`nDisabled: $names`n`nThe scheduled tasks will NOT fire at all until you run this toggle again. This does not close TradingView or affect the dashboard - it only stops the background scan/watchdog tasks."
}

[System.Windows.Forms.MessageBox]::Show($msg, 'TradingView Scan Toggle', 'OK', 'Information') | Out-Null
