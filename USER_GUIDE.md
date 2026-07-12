# User Guide

## Overview

This project watches your TradingView Desktop setup and updates a local dashboard with:

- current signal summary by watchlist
- open trades
- previous signals and trade history
- TradingView connection status

Main dashboard:
- http://127.0.0.1:3030

By default the dashboard listens on port `3030`. You can change that by setting `SIGNAL_DASHBOARD_PORT` before starting the server.

---

## What it does each day

During normal U.S. market hours, the Windows scheduled job is designed to run every 15 minutes:

- Monday through Friday
- from 9:31 AM ET until about 4:15 PM ET

It reads the watchlists configured in `rules.json`, checks the TradingView chart state, and writes the latest dashboard data to the local status file.

Important detail: the PowerShell scheduler only gates by market-hours window. The Node.js scan logic still decides which watchlists are actually due based on each watchlist timeframe. Even when no watchlist is due yet, the status file is still refreshed so the dashboard timestamp and next-run information stay current.

Two separate Windows Scheduled Tasks drive this automation:

| Task name | Interval | What it does |
|---|---|---|
| `TradingViewSignalScan15m` | every 15 min | runs `scripts/run_signal_job.ps1` — the signal scan |
| `TVWatchdog` | every 5 min | runs `scripts/tv_watchdog.ps1` — keeps the CDP debug connection alive |

Both already skip themselves outside market hours, on weekends, and (as of this update) on configured holidays — see below. Watchlist symbol sync (re-reading the TradingView watchlist panel) is intentionally **not** part of every 15-minute cycle; it only runs once near market open, once near market close, or when you trigger it manually. See "Watchlist sync timing" further down.

---

## How to suspend or resume the automated scan

### Finding the scheduled tasks

Both tasks live directly in the root of the Task Scheduler Library — not inside a subfolder — which is easy to miss if you're browsing folders instead of using the search/filter box:

1. Open **Task Scheduler** (Start Menu → type "Task Scheduler")
2. Click **Task Scheduler Library** in the left pane (the top-level node, not a subfolder underneath it)
3. Look for `TradingViewSignalScan15m` and `TVWatchdog` in the main list — sort by "Name" if the list is long

Or confirm from PowerShell without hunting through the GUI at all:

```powershell
Get-ScheduledTask -TaskName TradingViewSignalScan15m, TVWatchdog | Select-Object TaskName, State
```

### Option 1 — Desktop shortcut (recommended)

A **"Toggle TradingView Scan"** shortcut is on your Desktop. Double-click it to flip both scheduled tasks between Enabled and Disabled in one step — a confirmation popup shows the new state. This is the real fix for "the task keeps running every 15 minutes": a **disabled** task does not fire at all, so nothing spins up in the background until you toggle it back on.

If the shortcut ever goes missing, recreate it with:

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$desktop\Toggle TradingView Scan.lnk")
$shortcut.TargetPath = "C:\Users\tsnat\tradingview-mcp-jackson\scripts\toggle_scan.bat"
$shortcut.WorkingDirectory = "C:\Users\tsnat\tradingview-mcp-jackson\scripts"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,43"
$shortcut.WindowStyle = 7
$shortcut.Save()
```

### Option 2 — Manual PowerShell (no shortcut)

```powershell
# Suspend both tasks
Disable-ScheduledTask -TaskName TradingViewSignalScan15m
Disable-ScheduledTask -TaskName TVWatchdog

# Resume both tasks
Enable-ScheduledTask -TaskName TradingViewSignalScan15m
Enable-ScheduledTask -TaskName TVWatchdog
```

No admin elevation is required — both tasks run under your own user account at "Limited" run level.

### Option 3 — Config-level pause (task still fires, but does no work)

Setting `rules.json` → `schedule.disabled: true` makes the Node scan logic itself refuse to do a live scan (it exits immediately with "Scheduled scanning disabled" every time the task fires). This is useful when you don't want to touch Task Scheduler, but note it does **not** stop the task from spawning a PowerShell process every 15 (or 5) minutes — for that, use Option 1 or 2. Set it back to `false` to resume.

### Holidays

`rules.json` → `market_hours.holidays` is a list of `YYYY-MM-DD` dates the scheduled tasks should skip even though it's a weekday during normal hours. The current year's list is already filled in with standard NYSE holidays. Add or remove dates as needed — no code changes required.

Separately, the Node.js scan logic (`isMarketHoliday` in `src/core/morning.js`) already computes standard U.S. market holidays algorithmically for every year (New Year's, MLK Day, Presidents Day, Good Friday, Memorial Day, Juneteenth, July 4th, Labor Day, Thanksgiving, Christmas — all with their observed-date rules), so it self-skips holidays even without the `rules.json` list. The list in `rules.json` exists so the **PowerShell-level** gate (which decides whether to launch TradingView at all) can also skip those dates, and so you can add one-off closures the algorithm wouldn't know about.

### Watchlist sync timing

`syncWatchlistSymbolsFromTradingView` (re-reading the TradingView watchlist panel) only runs automatically:

- once per day, on the first scheduled scan that fires at or after **9:15 AM ET** (a "preflight" cutoff — if your computer wasn't on before then, the first run after it wakes up still gets the sync)
- once per day, on the first scheduled scan that fires at or after the configured market **close** time — if no run happens at/after close that day (e.g. the computer was off), it's simply skipped, not caught up later

State is tracked in `status/watchlist-sync-state.json` (auto-created, one date per trigger). Every other scheduled run in between skips the sync and only does the signal scan.

For an on-demand sync at any other time, run:

```powershell
node src/cli/index.js watchlist sync
```

or click **▶ Run Scan Now** in the dashboard, which always skips auto-sync (`syncWatchlists: false`) regardless of time of day.

---

## First-time setup

If this is your first run:

1. install Node.js
2. run `npm install` from the project folder
3. copy `rules.example.json` to `rules.json`
4. fill in your watchlists, timeframes, and notification settings
5. start TradingView Desktop and sign in

On Windows PowerShell:

```powershell
Copy-Item .\rules.example.json .\rules.json
```

---

## What you need

1. TradingView Desktop installed
2. Node.js installed
3. This repository on your machine
4. Your rules filled in inside `rules.json` (copy from `rules.example.json` first if needed)
5. TradingView signed in and able to open a chart

---

## How to use the dashboard

### Current Signal

This area shows the latest scan summary for each configured watchlist and timeframe.

Common values:
- SIGNAL = an actionable current setup was found
- NO SIGNAL = nothing fresh at the moment
- Outside market hours = the scheduled scan did not run live logic
- No watchlists due right now = the scheduler ran, but none of the configured timeframes were due yet

You will also see:

- `Updated` = when the status file was last written
- `Next run` = the next expected scheduled scan time shown by the dashboard
- `Signals` and `Changed` = totals for the current saved result

A `▶ Run Scan Now` button appears directly in this card. Click it to trigger a fresh scan immediately without waiting for the next scheduled run.

If a configured watchlist name such as `Swing 15m` is not loading, make sure the TradingView watchlist panel is visible and the watchlist button is exposed in the UI. The latest version improves watchlist selector robustness for TradingView UI variations by matching more button and label variants.

While the scan runs, a status bar appears below the button showing:

- **elapsed time** — a live `M:SS` clock counting up from when the scan started
- **current watchlist** — the watchlist being scanned at that moment (e.g. `Swing 30min`)
- **symbol progress** — how many symbols in the current watchlist have completed (e.g. `6/8 symbols`)
- **watchlist index** — overall progress (e.g. `watchlist 2/5`)

The dashboard updates incrementally after each watchlist finishes (roughly every 60–90 seconds), so you can see results for completed watchlists while the scan is still running. The `Updated` pill changes to `Scanning (2/5 watchlists)` during this period. The button re-enables and the status bar disappears as soon as the full scan finishes. A regression pass runs automatically in the background after the scan and the dashboard refreshes once more when it completes.

A full forced scan covers all 5 watchlists and typically takes 4–7 minutes. The same button is also available in the Manual Scan Controls section below the fold.

### TradingView Status

At the top of the page you will see:

- TradingView Status: Connected
- TradingView Status: Disconnected

If disconnected, the scheduler will try to reconnect automatically by launching TradingView with the debug flag.

### Open Trades

This section shows all currently active positions detected in the strategy tester, across all timeframes and watchlists.

A position appears here when the strategy tester's most recent trade row has an exit Signal of "Open" — meaning no exit has fired yet. This applies to intraday setups entered today as well as swing positions on daily charts that were entered days or weeks ago.

**Net P&L** shows the current unrealized profit/loss in USD and as a percentage. Because the scan runs in `changed_signals_only` mode by default, only symbols that emitted a new signal are re-read from the chart on each cycle. For positions that did not change since the last scan, the dashboard shows the last-known P&L value from the previous read. "In progress" only appears on a position's very first scan cycle, before any strategy tester reading has been recorded.

During an incremental (partial) scan update, the dashboard shows the P&L values stored from the previous completed scan. The live values from the current scan are only written after `createExcursionAlerts` runs at the end of the full scan cycle.

The table includes three additional columns derived from the full trade history:

- **Hist. MFE avg / max** — the average and maximum favorable excursion percentage across all completed trades for that symbol and timeframe. These represent how far price typically moved in your favor before the trade closed.
- **Hist. MAE avg / max** — the average and maximum adverse excursion percentage. These represent how far price moved against you during historical trades.
- **Alert Levels (avg / max)** — four TradingView price alerts are created automatically after each scan for newly detected open positions:
  - Stop avg and Stop max — entry price minus avg/max MAE%
  - Target avg and Target max — entry price plus avg/max MFE%

  The status indicator shows:
  - **✓ Alerts set** — alerts have been created in TradingView
  - **Quota full (N/20 active)** — the TradingView Pro plan limit was reached; levels are shown but alerts were not created. They will be retried on the next scan if quota frees up.
  - **⏳ Pending** — not yet processed in the current cycle

Alerts are created via TradingView's internal price-alerts REST API and count against your plan's active alert limit. The Pro plan allows 20 active alerts, which supports up to 5 open trades with 4 alerts each. Alert creation is idempotent — once alerts are recorded for a `symbol|timeframe` key at a given entry price, subsequent scans skip that trade. If the entry price changes (a new trade on the same symbol), alerts are re-created.

If an expected open position is not visible:
- confirm TradingView is connected and the chart has finished loading
- run a manual scan: `node .\scripts\run_signal_job.js --force`
- refresh the browser page

### Strategy Tester Metrics

This card exports the Strategy Tester **Performance Summary** tab data for all watchlist symbols as a single CSV file. It reads aggregate backtest statistics directly from the live TradingView chart, not from the signal scan baseline.

**What is exported per symbol:**

| Column | Description |
|---|---|
| Net P&L % | Net profit as a percentage of initial capital |
| Max Drawdown % | Maximum equity drawdown percentage (absolute value) |
| Total Trades | Total number of closed trades |
| Profitable (count) | Winning trades / total trades (e.g. `6/9`) |
| Profitable % | Win rate as a percentage |
| Profit Factor | Gross profit ÷ gross loss |

**How to run an export:**

1. Make sure TradingView is connected (Status: Connected pill is green).
2. Click **⬇ Export Strategy Metrics**.
3. A progress bar appears showing elapsed time, current watchlist, and symbol count.
4. When the scan finishes, the CSV file downloads automatically. A **↓ Download CSV Again** button stays visible to re-download the same result.

**Timing:** the export navigates the live TradingView chart to every (symbol, timeframe) combination — 5 watchlists × however many symbols each contains. This typically takes 8–15 minutes for a full run. The export blocks and is blocked by the regular signal scan; you cannot run both simultaneously.

**Strategy mode:** the export works in any mode (Fast or sweep/IS-OOS). It reads the Performance Summary tab which is always populated by the strategy engine itself. In contrast, TA Metrics Preflight (below) requires sweep mode.

**If a row shows an error:** the strategy tester panel did not load data for that symbol within the timeout. This usually means no strategy is applied to the chart, or TradingView was still recalculating. Re-run the export to retry those symbols.

### Previous Signals

This section shows the latest resolved trade state for each symbol in a watchlist.

You may see:
- OPEN = still in progress
- EXIT = closed trade from the strategy table
- Unavailable = no confirmed prior trade metrics were available

Longer watchlists are collapsed by default to reduce scrolling.

---

## Normal daily workflow

### Before market open

1. Open TradingView Desktop
2. Make sure you are signed in
3. Leave at least one chart open
4. Start the dashboard if it is not already running

### During the session

- let the scheduled task run automatically
- monitor the local dashboard
- review the Open Trades and Previous Signals sections
- if TradingView had to be reopened, give the chart a moment to finish loading before expecting fresh data

### After hours

The dashboard still shows the latest saved state, but scans may report Outside market hours unless you force a manual run.

---

## Manual commands

Run these from the project folder.

### Start the dashboard server

```powershell
npm run dashboard
```

Optional custom port:

```powershell
$env:SIGNAL_DASHBOARD_PORT = 3040
npm run dashboard
```

### Run a manual signal job

```powershell
npm run signals
```

This is the normal manual scan. It returns only changed or newly detected signals and still respects the market-hours and timeframe schedule checks.

### Force a scan right now

```powershell
node .\scripts\run_signal_job.js --force
```

Use this when you want a fresh status write outside regular hours or you want to bypass the market-hours gate without changing the default changed-signals-only output.

You can also trigger a scan from the browser: click the `▶ Run Scan Now` button in the Current Signal card. The server accepts the request immediately and runs the scan in the background; the dashboard updates incrementally as each watchlist completes and the button re-enables when the full scan is done (typically 4–7 minutes).

### Seed a watchlist manually

```powershell
node src/cli/index.js watchlist seed "Swing 15m"
```

Reads the currently-visible TradingView watchlist panel and writes its symbols into the baseline for the named watchlist — without switching watchlists. Use this when the automatic `sync` fails to select a watchlist in TradingView's UI.

Make sure the correct watchlist is visible in TradingView before running. Omit the name to use whatever watchlist is currently active.

### Regression check

After the first successful scan of each trading day (or after a TradingView reconnection), the scan job automatically runs a regression pass that validates all open trades against stored prior-signal history. This catches stale positions that should have exited and updates the dashboard banner accordingly.

The regression also fires when you click `▶ Run Scan Now`, once per trading day, so a manual morning check is enough to confirm everything is consistent.

### Return all active signals

```powershell
node .\scripts\run_signal_job.js --all
```

`--all` does two things:

- bypasses the usual timing gate and scans all configured watchlists immediately
- returns all active signals, not only the ones that changed since the prior scan

### Run the scheduled PowerShell job manually

```powershell
.\scripts\run_signal_job.ps1
```

This scheduled script checks whether the current time is inside the weekday market-hours window, then checks the TradingView connection and attempts an automatic launch if the debug connection is missing. It also runs the scan with notifications enabled.

---

## Push notifications

This project can send push alerts when a new signal is found.

### Notification service

The current setup uses `ntfy`.

Your notification settings live in `rules.json` under the `ntfy` section.

Example:

```json
"ntfy": {
  "topic": "swing-signals-tsnat",
  "url": "https://ntfy.sh/swing-signals-tsnat",
  "priority": "high",
  "signal_format": "[{timeframe}] {symbol} → {direction} @ {price}"
}
```

### How to receive alerts

1. install the `ntfy` app on your phone, or use the web client
2. subscribe to your topic name
3. keep the scheduled scan running
4. when a new signal is detected for the first time that day, the job will post a notification automatically

The scheduled PowerShell job already runs the Node scan with `--notify`, so once `ntfy` is configured you usually do not need a separate notification process.

### How to test notification delivery

Run:

```powershell
node .\scripts\run_signal_job.js --notify
```

If a fresh signal is present and your `ntfy` block is configured correctly, a push message should be sent.

### Notes

- notifications are only sent when a signal is **new or changed** since the last scan — repeat scans on the same open signal do not re-notify
- no alert is expected when the result is `NO SIGNAL`
- if nothing arrives, confirm the topic name and URL in `rules.json`

---

## Reconnection recommendations

If the dashboard shows Disconnected:

1. open TradingView Desktop from the Start Menu
2. confirm you are signed in and a chart is visible
3. wait for the chart to finish loading fully
4. run the PowerShell job once manually if needed
5. refresh the dashboard page

If TradingView is open but still does not connect:
- close all TradingView windows completely
- reopen from the Start Menu
- wait for the chart to finish loading before re-running the job

### Automatic watchdog

A separate `TVWatchdog` scheduled task runs every 5 minutes during market hours and handles reconnection automatically.

What it does each run:

1. Checks whether the CDP debug port (9222) is reachable
2. If not reachable and TradingView is running without the debug flag, kills it and relaunches with `--remote-debugging-port=9222`
3. If TradingView is not running at all, launches it
4. Waits up to 30 seconds for the connection to come up
5. Tracks consecutive failures in `status/watchdog-state.json`
6. After 3 consecutive failures (~15 minutes), writes an error to the dashboard

When the watchdog has given up retrying, the dashboard shows a red banner below the status pills:

> ⚠ Watchdog: TradingView failed to reconnect after 3 retries (~15 min). Last check: HH:MM AM/PM ET

The banner clears automatically as soon as a successful scan writes fresh data.

To check watchdog health manually:

```powershell
Get-ScheduledTaskInfo -TaskName TVWatchdog | Select-Object LastRunTime, LastTaskResult, NextRunTime
```

`LastTaskResult: 0` means CDP was up on the last run. Any other value means CDP was unavailable.

To trigger the watchdog immediately:

```powershell
Start-ScheduledTask -TaskName TVWatchdog
```

### Note for Microsoft Store (MSIX) installs

TradingView installed from the Microsoft Store requires a specific launch method to enable the debug connection (Chrome DevTools Protocol on port 9222). The scheduled job handles this automatically using the Windows `IApplicationActivationManager` COM interface, which passes `--remote-debugging-port=9222` directly through the package activation broker.

**Important:** launching TradingView from the Start Menu does **not** enable the debug port. For the CDP connection to work, TradingView must be launched by the scheduled script (`run_signal_job.ps1`) or by running the PowerShell job manually. If TradingView is already open without the debug port, close it first, then let the script relaunch it.

The `ELECTRON_EXTRA_LAUNCH_ARGS` environment variable stored at `HKEY_CURRENT_USER\Environment` does **not** enable the debug port for MSIX installs and has no effect. It can be ignored.

---

## Important files

- `rules.json` — your watchlists and trading rules
- `rules.example.json` — template to copy for first-time setup
- `swing-signal-baseline.json` — saved signal and trade state
- `status/latest-signal-status.json` — dashboard data source
- `status/watchdog-state.json` — watchdog retry counter (auto-created)
- `status/watchlist-sync-state.json` — tracks which date's open/close watchlist sync already ran (auto-created)
- `signal-scan.log` — appended output from the scheduled PowerShell job
- `scripts/run_signal_job.ps1` — scheduled job entry point
- `scripts/tv_watchdog.ps1` — CDP watchdog (run by `TVWatchdog` task every 5 min)
- `scripts/serve_signal_status.js` — local dashboard server
- `scripts/toggle_scan.ps1` / `scripts/toggle_scan.bat` — flips both scheduled tasks between enabled/disabled; wired to the "Toggle TradingView Scan" Desktop shortcut

---

## Quick troubleshooting

### Dashboard opens but data looks stale

Check the status file timestamp at the top of the page ("Updated: …"). If it stopped updating during market hours, the scheduled task may be stalling before writing new data.

Run a manual scan to force a fresh write:

```powershell
node .\scripts\run_signal_job.js --force
```

Then refresh the browser page. If the timestamp updates, the dashboard server is fine and the issue is with the scheduled task. Check `signal-scan.log` for entries — if April-21 (or the current date) is missing, the task is exiting before running node.js.

To confirm the task is running and see its last result:

```powershell
Get-ScheduledTaskInfo -TaskName TradingViewSignalScan15m | Select-Object LastRunTime, LastTaskResult, NextRunTime
```

A `LastTaskResult` of `0x800710E0` means the scheduler tried to start a new instance while the previous one was still running. This usually means a prior scan stalled (most often a slow TradingView launch). The fix is already in place: the scheduled task now has a 3-second timeout on each CDP connection probe so a half-open TradingView socket cannot block the scan indefinitely.

### Browser page does not auto-refresh when a new scan runs

The dashboard uses Server-Sent Events (SSE) to push updates from the server to the browser. On Windows, the underlying file watcher can silently drop events. If you see "Waiting for the next scheduled scan update…" in the refresh note, the SSE stream lost its connection. Reload the page to reconnect — the latest data will load immediately, and SSE will resume.

### TradingView Status shows Disconnected

The app may not be signed in, the chart may still be loading, or the debug endpoint may not be ready yet.

### No signal is shown

That can be normal. It usually means no fresh setup was detected for the current scan.

### Open Trades is empty

That means no currently locked active trades were found in the latest saved state.
