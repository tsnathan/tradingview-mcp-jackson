# User Guide

## Overview

This project watches your TradingView Desktop setup and updates a local dashboard with:

- current signal summary by watchlist
- open trades
- previous signals and trade history
- TradingView connection status

Main dashboard:
- http://127.0.0.1:3030

---

## What it does each day

During normal U.S. market hours, the scan is designed to run every 15 minutes:

- Monday through Friday
- from 9:31 AM ET until the close

It reads the watchlists configured in `rules.json`, checks the TradingView chart state, and writes the latest dashboard data to the local status file.

---

## What you need

1. TradingView Desktop installed
2. Node.js installed
3. This repository on your machine
4. Your rules filled in inside `rules.json`
5. TradingView signed in and able to open a chart

---

## How to use the dashboard

### Current Signal

This area shows the latest scan summary for each watchlist.

Common values:
- SIGNAL = an actionable current setup was found
- NO SIGNAL = nothing fresh at the moment
- Outside market hours = the scheduled scan did not run live logic

### TradingView Status

At the top of the page you will see:

- TradingView Status: Connected
- TradingView Status: Disconnected

If disconnected, the scheduler will try to reconnect automatically by launching TradingView with the debug flag.

### Open Trades

This section is reserved for currently active positions.

Right now it is intentionally locked to the active same-day positions so it stays clean and stable.

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

### After hours

The dashboard still shows the latest saved state, but scans may report Outside market hours unless you force a manual run.

---

## Manual commands

Run these from the project folder.

### Start the dashboard server

```powershell
npm run dashboard
```

### Run a manual signal job

```powershell
npm run signals
```

### Force a fuller manual scan

```powershell
node .\scripts\run_signal_job.js --all
```

### Run the scheduled PowerShell job manually

```powershell
.\scripts\run_signal_job.ps1
```

This scheduled script now checks the TradingView connection first and attempts an automatic launch if the debug connection is missing.

---

## Reconnection recommendations

If the dashboard shows Disconnected:

1. keep TradingView Desktop open
2. confirm you are signed in
3. leave a chart tab open
4. run the PowerShell job once manually if needed
5. refresh the dashboard page

If TradingView launches but still does not connect:
- close all TradingView windows completely
- rerun the scheduled job
- wait for the chart to finish loading

---

## Important files

- `rules.json` — your watchlists and trading rules
- `swing-signal-baseline.json` — saved signal and trade state
- `status/latest-signal-status.json` — dashboard data source
- `scripts/run_signal_job.ps1` — scheduled job entry point
- `scripts/serve_signal_status.js` — local dashboard server

---

## Quick troubleshooting

### Dashboard opens but data looks stale

Run:

```powershell
.\scripts\run_signal_job.ps1
```

Then refresh the browser page.

### TradingView Status shows Disconnected

The app may not be signed in, the chart may still be loading, or the debug endpoint may not be ready yet.

### No signal is shown

That can be normal. It usually means no fresh setup was detected for the current scan.

### Open Trades is empty

That means no currently locked active trades were found in the latest saved state.
