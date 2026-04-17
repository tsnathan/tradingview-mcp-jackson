# User Guide

## What this does

This project scans your TradingView watchlist every 15 minutes during regular market hours and shows only actionable signals.

You can view results in two ways:
- terminal output
- local browser dashboard at http://127.0.0.1:3030

## What you need

- TradingView Desktop open with remote debugging enabled
- Windows machine running
- this repository installed
- the scheduled signal task enabled

## Daily behavior

The scan runs every 15 minutes and only acts during:
- 9:31 AM ET through 4:01 PM ET
- Monday through Friday

If there is a signal, you will see a line like:
- 04/15/2026, 01:01:00 PM ET | WATCHLIST: Swing 15m | SOXL | SIGNAL: LONG | TF: 15 | PRICE: 82.33 | Long ▲

If there is no signal, you will see:
- 04/15/2026, 01:01:00 PM ET | WATCHLIST: Swing 15m | NO SIGNAL

## How to use it

### 1. Start TradingView

Launch TradingView Desktop in debug mode before market hours.

### 2. Let the scheduled scan run

The Windows task named TradingViewSignalScan15m handles the recurring scans.

### 3. Open the browser dashboard

Open this in any browser:
- http://127.0.0.1:3030

The dashboard is also configured to start at Windows sign-in from your user Startup folder.

### 4. Read the output

Each line shows:
- timestamp in Eastern Time
- watchlist name
- symbol
- signal direction
- timeframe
- price
- note text from the chart

## Manual commands

From the repo folder:

- Run one signal scan:
  npm run signals

- Start the browser dashboard:
  npm run dashboard

## Troubleshooting

### No signal showing

This can simply mean there is no current setup.

### Dashboard does not open

Start the dashboard server manually:
- npm run dashboard

### Scan is not updating

Check that:
- TradingView Desktop is still open
- the scheduled task is enabled
- the chart connection is healthy

## Files used by the automation

- rules.json
- swing-signal-baseline.json
- status/latest-signal-status.json
- scripts/run_signal_job.ps1
- scripts/serve_signal_status.js
