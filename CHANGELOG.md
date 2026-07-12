# Changelog

## 2026-07-12

### Fixed — Scan/watchdog task could hang forever on a stuck alerts REST call

**Files:** `src/core/alerts.js`, `src/core/morning.js`

`alerts.list()`/`alerts.create()`'s `fetch()` calls to TradingView's price-alerts REST API had no timeout, unlike the equivalent CDP target lookup in `src/connection.js`. A single unresponsive request could block the entire scan indefinitely with no error surfaced anywhere — this is what caused the dashboard to show a stuck "Seeding watchlists…" state for 12+ minutes. Added a 10s `AbortSignal.timeout()` to both fetch calls, plus a 4-minute hard backstop around the whole `createExcursionAlerts` step in `runBrief` so a stuck call can never wedge the scan again.

### Fixed — False and stale entries in the Open Trades table

**Files:** `src/core/morning.js`

Two bugs were producing incorrect Open Trades rows once the scan pipeline actually completed a full run:

1. `detectSignalFromSnapshot` keyword-matched words like "Short"/"Long" anywhere in label text, including the strategy's own status label (`Mode: ... \nLast signal: Short\n...\nPosition: Flat`) — so a closed position could be misread as an active signal, and the label's incidental chart-anchor price got used as a fake entry price. Now `Position: Flat/Long/Short` is parsed explicitly; `Flat` is trusted to force a close, but `Long`/`Short` alone is no longer sufficient to *open* a new synthetic trade (that label is computed on the still-forming active bar and can run ahead of the confirmed Strategy Tester trade list) — it only confirms continuation of a position already known to be open.
2. The same instrument can be served under a different exchange prefix between scans (e.g. `AMEX:AGQ` vs `BATS:AGQ`), which broke entry-time continuity in `updateBaselineEntry`'s exact-symbol-keyed lookup. Added a ticker-normalized fallback match (mirroring what `createExcursionAlerts` already did for its own cache).

### Fixed — Watchlist symbol sync running on every scheduled scan cycle

**Files:** `scripts/run_signal_job.js`

The scheduled job defaulted `syncWatchlists: true` on every 15-minute run during market hours, re-syncing the TradingView watchlist panel far more often than needed. Now it only syncs once on the first run at/after 9:15 AM ET and once on the first run at/after market close, tracked in `status/watchlist-sync-state.json`. Manual sync (`tv watchlist sync`) and the dashboard's "Run Scan Now" button are unaffected.

### Added — Holiday list gating for the PowerShell-level scheduler

**Files:** `rules.json`, `rules.example.json`, `scripts/tv_watchdog.ps1`

`rules.json` → `market_hours.holidays` now lists this year's NYSE holidays so the PowerShell scheduler layer (which decides whether to launch TradingView at all) skips them, complementing the Node-side algorithmic holiday calculator that already existed in `morning.js`. `tv_watchdog.ps1` previously had no holiday or `schedule.disabled` awareness at all — it now shares the same gate logic as `run_signal_job.ps1`.

### Added — Desktop toggle for suspending/resuming the scheduled scan

**Files:** `scripts/toggle_scan.ps1`, `scripts/toggle_scan.bat`, `USER_GUIDE.md`

A "Toggle TradingView Scan" desktop shortcut flips both `TradingViewSignalScan15m` and `TVWatchdog` between Enabled/Disabled in one click, with a confirmation popup — the actual fix for the scheduled task spawning a process every 15 minutes even when there was nothing to do. Documented in `USER_GUIDE.md` alongside the two other ways to pause (manual PowerShell, or the `rules.json` config flag) and where to find the tasks in Task Scheduler.

### Fixed — Silent ntfy push failures

**Files:** `src/core/morning.js`, `scripts/run_signal_job.ps1`

The ntfy POST swallowed all failures (`.catch(() => null)`) with no record anywhere. Now logs the HTTP status or error on failure, and `run_signal_job.ps1` captures the job's stderr into `signal-scan.log` via a temp-file redirect (not `2>&1`, which risks aborting the whole script given its `$ErrorActionPreference = 'Stop'`). Verified the full notification path is otherwise correctly gated (only fires on a confirmed same-day Strategy Tester `OPEN` trade, never on the flaky Position label) and confirmed live delivery with a manual test push.

## 2026-05-04

### Added — Strategy Tester Metrics CSV export

**Files:** `src/core/data.js`, `src/core/morning.js`, `scripts/serve_signal_status.js`, `dashboard/index.html`

A new **Strategy Tester Metrics** card on the dashboard exports aggregate Performance Summary stats (Net P&L %, Max Equity Drawdown %, Total Trades, Profitable Trades count/%, Profit Factor) for every symbol in every configured watchlist as a single CSV file.

**How it works:**

1. Click **⬇ Export Strategy Metrics** in the new card.
2. The server navigates the live TradingView chart to each (symbol, timeframe) combination across all 5 watchlists, opens the Strategy Tester panel, and reads the Performance Summary tab.
3. A live progress bar shows elapsed time, the current watchlist name, and symbol count (e.g. `3/40 symbols`).
4. When the scan completes, the CSV downloads automatically. A **↓ Download CSV Again** button remains available to re-download the same result.

Works in any strategy mode (Fast or sweep/IS-OOS). The export is independent of the signal scan — both share the same exclusive-run gate so they cannot run simultaneously.

**New functions:**

- `parseStrategyMetricsText(text)` (`src/core/data.js`) — parses Performance Summary tab `innerText` into a structured metrics object. Uses a label-then-scan approach to handle TradingView's multi-line layout (USD value line skipped, % line picked up on the next line). Tries multiple tab names (`Performance Summary`, `Metrics`, `Overview`, `Summary`) to cover TradingView UI variants.
- `getStrategyMetricsFromDOM({ timeout_ms })` (`src/core/data.js`) — opens the strategy tester, clicks the summary tab, waits ≥3 s for two stable identical readings, then returns parsed metrics.
- `exportMetricsScan({ onProgress })` (`src/core/morning.js`) — iterates all watchlist targets and baseline-stored symbols, navigates to each, reads metrics, restores original chart state on completion.

**Server endpoints:**

- `POST /api/start-metrics-export` — starts the background scan, returns 202 immediately, pushes `metrics-started` / `metrics-progress` / `metrics-ready` / `metrics-failed` SSE events.
- `GET /api/metrics-csv` — serves the last generated CSV as a `Content-Disposition: attachment` download. Returns 404 if no export has run yet.

**CSV columns:** Watchlist, Timeframe, Symbol, Net P&L %, Max Drawdown %, Total Trades, Profitable (count), Profitable %, Profit Factor, Error.

### Added — `tv watchlist seed` CLI command

**Files:** `src/core/morning.js`, `src/cli/commands/watchlist.js`

Added a `seed` subcommand that reads the currently-visible TradingView watchlist panel and writes its symbols to the baseline — without switching watchlists. This is a reliable manual alternative when the auto-switching `sync` command cannot select a watchlist.

Usage:

```
node src/cli/index.js watchlist seed "Swing 15m"
```

The watchlist name is written to `baseline.watchlists[name].symbols` with `source: tradingview_panel`. Pass no name to use whatever watchlist TradingView is currently showing.

### Fixed — "Run Scan Now" now seeds watchlists first, always runs regression

**File:** `scripts/serve_signal_status.js`

The `/api/run-cron-now` endpoint (used by the dashboard "Run Scan Now" button) now:

1. Runs `syncWatchlistSymbolsFromTradingView()` first (the seeding step), showing "Seeding watchlists…" in the progress bar.
2. Then runs the full signal scan with `syncWatchlists: false` to avoid a double sync.
3. Always triggers `runRegression()` after a successful scan — the previous once-per-day gate (`!regressionRanToday()`) was removed so regression metrics are always fresh after a manual run.

### Fixed — TA Metrics always showing "No tables" even after a sweep-mode scan

**File:** `dashboard/index.html`

`renderTaMetrics` and `extractTaMetricsCsvRows` checked `Array.isArray(item.tables)` but `item.tables` is an object `{ success, study_count, studies: [] }`. Changed to `Array.isArray(item.tables?.studies)`.

### Fixed — Watchlist Symbols panel showing empty chips after seed

**File:** `dashboard/index.html`

The "Watchlist Symbols" panel now shows all configured watchlists with per-symbol chips and color-coded source badges (green = live from TradingView, yellow = fallback from rules.json, grey = cached). Previously only errors were surfaced; now symbol counts and names are always visible so you can confirm a seed worked.

### Fixed — watchlist selection robustness for TradingView UI variants

**File:** `src/core/watchlist.js`

The watchlist sync helper could fail to select configured watchlists such as `Swing 15m`, `Swing 30min`, `Swing 1H`, `Swing 4H`, and `Swing 1D` when TradingView changed the watchlist menu/button DOM structure. The selection logic now uses broader button and label selectors plus a fallback search, improving reliability across TradingView watchlist UI variants.

### Fixed — TA Metrics Preflight now preserves full scanned symbol results

**File:** `src/core/morning.js`

The dashboard TA Metrics Preflight panel now uses the full scanned symbol payload even when the latest scan ran in `signals_only` mode. This ensures per-symbol metric tables are available after a scan even if no active signals were found.

## 2026-05-01

### Added — Scan progress status bar with live clock, watchlist name, and symbol count

**File:** `dashboard/index.html`, `src/core/morning.js`, `scripts/serve_signal_status.js`

A status bar appears below the `▶ Run Scan Now` button while a scan is in progress. It shows:

- **Elapsed time** — counts up in `M:SS` format from when the scan started
- **Current watchlist** — the watchlist name actively being scanned (e.g. `Swing 30min`)
- **Symbol progress** — how many symbols in the current watchlist have completed (e.g. `6/8 symbols`)
- **Watchlist index** — overall progress across all watchlists (e.g. `watchlist 2/5`)

The bar is hidden when idle and clears automatically when the scan finishes or errors. If the SSE connection drops during a scan, the elapsed clock continues ticking; the bar clears as soon as the `cron-finished` event is received (even if the button had already been re-enabled by the HTTP error path).

Implementation: `runBrief` fires an `onProgress(data)` callback after each symbol scan. `serve_signal_status.js` converts this to a `scan-progress` SSE event. The dashboard SSE handler updates the status bar DOM elements without triggering a full refresh.

### Added — Incremental dashboard updates after each watchlist

**Files:** `src/core/morning.js`, `scripts/serve_signal_status.js`

Previously the dashboard only updated once, after all watchlists finished. A full forced scan (5 watchlists × 8 symbols) takes 4–7 minutes, leaving the dashboard stale throughout.

Now, after every watchlist completes, a partial result is assembled and written to the status file, and a `status-updated` SSE event is pushed to the browser. The dashboard refreshes with real signal data roughly every 60–90 seconds as each watchlist finishes.

The partial result uses the **original pre-scan baseline** (not a mid-scan write) so that stored Net P&L and excursion values from previous scans are shown correctly. The full baseline write and `createExcursionAlerts` still run at the end of the complete scan. The `Updated` pill reads `Scanning (2/5 watchlists)` while a partial scan is in progress and reverts to the normal timestamp on the final write.

Implementation: `onWatchlistComplete(partialResult)` callback added to `runBrief` and `runSignalJob`. In `serve_signal_status.js` the callback calls `writeStatus(partial)` and pushes `status-updated`.

### Fixed — watchlist selection robustness for TradingView UI variants

**File:** `src/core/watchlist.js`

The watchlist sync helper could fail to select configured watchlists such as `Swing 15m`, `Swing 30min`, `Swing 1H`, `Swing 4H`, and `Swing 1D` when TradingView changed the watchlist menu/button DOM structure. The selection logic now uses broader button and label selectors plus a fallback search, improving reliability across TradingView watchlist UI variants.

### Fixed — "Run Scan Now" button stays disabled after scan completes

**File:** `scripts/serve_signal_status.js`

After the scan loop finished, the `cron-finished` SSE event (which re-enables the button) was only pushed after `runRegression()` completed. Regression adds 30–90 seconds of extra wait time after the visual scan progress reaches 5/5 watchlists.

Fix: `cron-finished` is now pushed immediately after `writeStatus(result)`. Regression runs fire-and-forget in the background and pushes a `status-updated` SSE event when done so the dashboard still refreshes with regression results.

### Fixed — "Run Scan Now" timing out after 180 seconds

**Files:** `scripts/serve_signal_status.js`, `dashboard/index.html`

A forced full scan (5 watchlists × 8 symbols × ~8s per chart) takes 250–400 seconds, structurally over the previous 180-second hard limit in `runExclusive`.

Changes:
- `ACTION_TIMEOUT_MS` raised from `180 * 1000` to `600 * 1000` (10 minutes).
- `/api/run-cron-now` now responds with `202 Accepted` immediately instead of holding the HTTP connection open until the scan finishes. The dashboard button stays disabled and shows "Scan started — dashboard will refresh when complete…" until the `cron-finished` SSE event arrives.
- Busy check moved out of `runExclusive` (which is async) into a synchronous `scanState.running` guard before the 202 response, so a duplicate click still returns 409 without starting a second scan.
- `stopScanStatusBar()` is now called unconditionally on every `cron-finished` SSE event (removed the `&& actionInFlight` guard) so the elapsed clock stops even when the HTTP error path already cleared `actionInFlight`.

### Fixed — `Cannot access 'timezone' before initialization` in partial scan assembly

**File:** `src/core/morning.js`

The `timezone` constant was declared after the main scan loop (`const timezone = ...` at the start of the final result assembly block). The new `onWatchlistComplete` callback inside the loop referenced `timezone`, hitting a temporal dead zone error on the first watchlist completion.

Fix: moved `timezone` declaration to just before the loop (alongside `results`, `watchlistSummaries`, `dueTargetCount`) so it is in scope for both the mid-loop partial assembly and the final result assembly.

### Fixed — Dashboard server crashing and showing "site can't be reached"

**File:** `scripts/serve_signal_status.js`

An unhandled promise rejection in the scan (e.g. from a CDP call during `createExcursionAlerts`) could kill the Node.js process, taking the HTTP server down with it. The dashboard would show `ERR_CONNECTION_REFUSED` until the server was manually restarted.

Fix: added `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` handlers at the top of the server file. Unexpected errors are logged to the console but no longer crash the process.

### Fixed — Net P&L showing "In progress" for open trades not re-scanned today

**File:** `src/core/morning.js`

Trades entered on a previous day (e.g. TECS, USO) showed "In progress" for Net P&L even after a successful scan. This happened because `changed_signals_only` mode does not re-read the strategy tester for unchanged open positions. On the next scan after entry, a real P&L value was written to the baseline. On subsequent scans, `updateBaselineEntry` treated `syntheticOpen` paths as always "In progress", overwriting the previously stored real value.

Fixes:
- `hasMeaningfulTradeValue` now treats `"in progress"` as a non-meaningful value so it no longer blocks the fall-through to the stored previous value.
- `updateBaselineEntry` now preserves `previous.net_pnl` / `previous.favorable_excursion` / `previous.adverse_excursion` for `syntheticOpen` positions where a real value was already stored. "In progress" is only written when no prior meaningful value exists.
- `createExcursionAlerts` now also reads live P&L from the strategy tester while already navigated to a symbol's chart for excursion stats, and persists it back to `baseline.signals[key]`. This means newly-entered positions get a real P&L on their first chart visit, even if the main scan only runs in `changed_signals_only` mode afterwards.

### Fixed — Alert creation always failing (DOM approach replaced with REST API)

**File:** `src/core/alerts.js`

`alerts.create()` used a multi-step DOM automation approach: click the "Create Alert" button, fill in inputs, click the submit button. This approach was fragile against TradingView UI updates and was silently failing for all 62 baseline entries (`created: false`, no skip reason).

Fix: rewrote `alerts.create()` to use the same internal REST API that `alerts.list()` already uses (`pricealerts.tradingview.com/create_alert`). The symbol is encoded in TradingView's `={"symbol":...}` format, built from `chart.symbolExt().pro_name` when available (exact canonical name from the active chart), with a fallback to the symbol string from the caller. No DOM manipulation, no button clicking, no race conditions.

New signature: `create({ condition, price, message, symbol, timeframe })`. The `symbol` and `timeframe` parameters are now passed from `createExcursionAlerts` in `morning.js`.

### Fixed — Manual "Run Scan Now" timing out after 180 seconds

**File:** `src/core/morning.js`

After the REST alert rewrite, `createExcursionAlerts` had `chart.setSymbol/setTimeframe` moved outside the `!hasStoredData` guard. This caused the scan to navigate to every open trade's chart (all 28) even when excursion stats already existed in the baseline. At ~6–10s per chart switch, the total exceeded the 180-second server-side action timeout.

Fix: chart navigation is now strictly inside the `!hasStoredData` block. The REST alert creation call uses the symbol-string fallback and does not require the chart to be on the right symbol. Scans for trades with stored stats (the common case after the first full scan) proceed directly to REST alert creation with no chart switching.

### Added — Regression runs after first successful scan of each trading day

**Files:** `scripts/run_signal_job.js`, `scripts/serve_signal_status.js`

Previously, the regression suite (`runRegression`) only fired after a TradingView reconnection event. Stale open trades that survived from a prior day would not be caught until TradingView lost its connection.

Changes:
- `scripts/run_signal_job.js`: added `etDateString()` and `regressionRanToday()` helpers that check `status/regression-status.json`. The regression now triggers on: post-reconnection (existing) **or** first successful scan of the trading day (new). The console log identifies the reason: `Running regression suite (first scan of day)` or `Running regression suite (post-reconnection)`.
- `scripts/serve_signal_status.js`: the `/api/run-cron-now` endpoint (used by the dashboard "Run Scan Now" button) now also triggers the regression once per trading day after a successful manual scan. Fires an additional SSE `status-updated` event when the regression completes so the dashboard banner refreshes automatically.

### Added — "Run Scan Now" button at top of dashboard

**File:** `dashboard/index.html`

A `▶ Run Scan Now` button is now shown directly in the Current Signal card header, eliminating the need to scroll to the Manual Scan Controls section. Both buttons share the same `runCronNow()` handler and disable together while a scan is in progress. The action message appears inline next to the top button.

### Fixed — Wrong 1D symbols appearing in Open Trades

**File:** `src/core/morning.js`

Symbols from the Swing 1D watchlist (LABU, TMV, SOXL) were appearing in the Open Trades section even though they were not in the watchlist. `buildOpenTrades` was matching open baseline rows by timeframe only — not by symbol membership — so any symbol with a matching timeframe in the baseline could appear.

Fix: `buildOpenTrades` now builds a set of valid symbols from `priorSignalsByWatchlist` and skips baseline rows whose symbol is not in that set.

### Fixed — Stale OPEN rows not downgraded in Prior Signals display

**File:** `src/core/morning.js`

`buildPriorSignalsByWatchlist` was not applying a recency guard to OPEN baseline rows. A position that exited but had not yet been re-scanned would remain visually OPEN indefinitely.

Fix: OPEN baseline rows are now downgraded to EXIT in the Prior Signals display when `isSameOrPreviousTradingDay` returns false (i.e. the entry time is older than the previous trading day relative to `baselineUpdatedAt`).

### Fixed — Entry date drifting forward on each scan

**File:** `src/core/morning.js`

`updateBaselineEntry` was overwriting `entry_time` with the current scan timestamp whenever `syntheticOpen` was true. For a trade entered at 4:02 PM on Apr 30, each subsequent scan would advance the date to the scan time (e.g. May 1, 10:00 ET).

Fix: `nextEntryTime` now preserves `previousOpenEntryTime` (the entry time already stored in the baseline) for `syntheticOpen` paths. The scan timestamp is only used as the `entry_time` when no prior entry time exists.

## 2026-04-23

### Added — TV Watchdog: automatic CDP reconnection with dashboard error reporting

**Files:** `scripts/tv_watchdog.ps1`, `dashboard/index.html`

Added a dedicated watchdog that runs every 5 minutes via a new `TVWatchdog` Windows Task Scheduler task and automatically recovers the TradingView debug connection during market hours.

**Logic per run (`scripts/tv_watchdog.ps1`):**

1. Exits immediately outside weekday ET market hours (reuses `rules.json` schedule gate).
2. Checks `http://127.0.0.1:9222/json/version` — if CDP responds, resets the failure counter and exits cleanly.
3. If CDP is unavailable, increments a consecutive-failure counter persisted in `status/watchdog-state.json`.
4. If a TradingView process is found running (without the debug flag) and the launch cool-down has expired (>4 min since last launch attempt), kills all TradingView processes and relaunches with `--remote-debugging-port=9222` using the same MSIX/COM path (`IApplicationActivationManager`) as `run_signal_job.ps1`.
5. If TradingView is not running at all, launches it directly.
6. Waits up to 30 seconds (15 × 2 s polls) for CDP to come up after launch.
7. After 3 consecutive failures (~15 min), writes `watchdogError: true` and a timestamped message into `status/latest-signal-status.json` so the dashboard can surface the error.
8. Exits 0 on success, 1 on failure (allows Task Scheduler `LastTaskResult` to reflect health).

**State file (`status/watchdog-state.json`):** persists `failureCount`, `lastAttempt`, and `lastLaunchAttempt` across runs so the retry counter survives PowerShell process boundaries.

**Dashboard banner (`dashboard/index.html`):** added a red `watchdog-error` div beneath the status pills. It is hidden by default and populated with a `⚠` prefix + `watchdogMessage` when `watchdogError: true` is present in the status JSON. Clears automatically on the next successful scan.

**Task registration:**
```
TaskName: TVWatchdog
Trigger:  every 5 min, all day (00:01 repeat, 24-hour duration)
Action:   powershell.exe -NonInteractive -WindowStyle Hidden -File scripts\tv_watchdog.ps1
Settings: ExecutionTimeLimit 4 min, MultipleInstances IgnoreNew, StartWhenAvailable
```
The all-day trigger is intentional — the script's market-hours gate handles filtering so no timezone offset needs to be hardcoded in the trigger.

## 2026-04-22

### Added — Excursion stats and auto-alerts for open trades

**Files:** `src/core/data.js`, `src/core/morning.js`, `dashboard/index.html`

After each scan cycle, the system now computes historical excursion statistics for every open trade and creates TradingView price alerts at the derived stop and target levels.

**1. Historical excursion stats (`src/core/data.js`)**

Added `getAllTradesExcursionStats()` which opens the strategy tester's List of Trades tab, reads all completed trade blocks, and returns:

- `avgFavorablePct` / `maxFavorablePct` — average and maximum MFE across completed trades
- `avgAdversePct` / `maxAdversePct` — average and maximum MAE across completed trades

Open trades are excluded from the calculation. The function waits for two consecutive identical readings (`stableCount >= 2`) before parsing, matching the stability threshold used by `getLatestTradeFromTester`.

**2. Auto-alert creation (`src/core/morning.js`)**

Added `createExcursionAlerts(openTrades, baselinePath)`, called in `runSignalJob` after `runBrief` and before `writeLatestStatus`. For each open trade that does not already have alerts in the baseline:

1. Switches the chart to that symbol and timeframe
2. Reads excursion stats via `getAllTradesExcursionStats`
3. Computes four price levels: stop avg, stop max, target avg, target max
4. Creates four TradingView price alerts (crossing condition) with descriptive messages

**Idempotency:** once alerts are created for a `symbol|timeframe` key with a matching entry price, subsequent scans skip that trade. If the entry price changes (new trade on the same symbol), alerts are re-created.

**Alert quota tracking:** `alerts.list()` is called once per cycle to count active alerts. If creating four more alerts would exceed the 20-alert Pro plan limit, alert creation is skipped for that trade. The computed levels are still saved to the baseline and displayed in the dashboard. The next scan retries automatically if quota frees up.

**Stats and levels are always persisted** to `swing-signal-baseline.json` under `excursion_alerts[symbol|timeframe]`, even when alerts could not be created, so the dashboard can show the price levels regardless.

**3. Dashboard display (`dashboard/index.html`)**

The Open Trades table now has three additional columns:

- **Hist. MFE avg / max** — average and maximum favorable excursion % from completed trades
- **Hist. MAE avg / max** — average and maximum adverse excursion % from completed trades
- **Alert Levels (avg / max)** — stop and target prices, plus status:
  - Green "✓ Alerts set" — alerts created in TradingView
  - Orange "Quota full (N/20 active)" — levels shown, alerts skipped due to plan limit
  - Yellow "⏳ Pending" — not yet processed this cycle

## 2026-04-22

### Fixed — Excursion stats and alerts never ran on MCP / direct-call path

**File:** `src/core/morning.js`

`createExcursionAlerts` was originally called inside `runSignalJob`, so it only ran when the scheduled PS1 job executed. Direct MCP tool calls (`run_brief`) bypass `runSignalJob` entirely and call `runBrief` directly, meaning no excursion stats were ever computed or saved for those calls. The dashboard always showed "—" in the MFE / MAE / Alert Levels columns.

Fix: moved the `createExcursionAlerts` call into `runBrief` itself (after the finally block that writes watchlist summaries, before the return value is assembled). This ensures every code path — MCP tool, scheduled job, and CLI — runs the enrichment step.

Added `enrichOpenTradesFromBaseline(openTrades, excursionAlerts)` — a synchronous helper that attaches stored excursion stats, alert levels, and creation status from the baseline to open trades. Called on all three early-exit paths in `runSignalJob` (market-hours gate, no-target skip, CDP failure) so that previously computed stats appear in the status file even when a full scan is not warranted.

### Fixed — Alert quota graceful skip with dashboard message

**File:** `src/core/morning.js`, `dashboard/index.html`

When the 20-alert Pro plan limit was reached, `createExcursionAlerts` would silently fail to create alerts with no indication in the dashboard.

Fix: `alerts.list()` is called once per cycle to count currently active alerts. When creating four more would exceed 20, the trade is saved with `skip_reason: "Quota full (N/20 active)"` and alert creation is skipped — but stats and levels are still persisted. The dashboard now renders the skip reason in orange (instead of the green "✓ Alerts set" badge), with the computed price levels still visible. The next scan retries automatically if quota frees up.

### Fixed — Expensive chart re-read on every scan for already-skipped alerts

**File:** `src/core/morning.js`

`createExcursionAlerts` was switching the chart to each trade's symbol and calling `getAllTradesExcursionStats` on every scan cycle, even for trades where the quota was full and the data was already stored from the previous scan.

Fix: added a `hasStoredData` check — when `stored.entry_price === entryPrice` and both `stats` and `levels` are already in the baseline, the expensive chart switch and panel read are skipped. The function goes directly to the quota check and alert creation attempt.

### Added — Dashboard improvements

**File:** `dashboard/index.html`

- **Red font for negative values** — `colorVal(str)` wraps any value starting with "−" or "-" in a `#fca5a5` red span. Applied to Net P&L, MFE, and MAE cells.
- **Summary row in Prior Signals table** — a "Avg" row is inserted in `<thead>` (top of table, above data rows) showing column averages for Net P&L, MFE avg, MFE max, MAE avg, and MAE max across all exit signals in that watchlist.
- **Summary row in Open Trades table** — an "Avg" row is appended after all open trade rows showing average Net P&L, Hist. MFE avg/max, and Hist. MAE avg/max.
- **Per-watchlist scan timestamps** — each watchlist summary line now shows the actual time that watchlist was scanned (stored as `scanned_at` on each summary object), instead of a single render-time `Date.now()` shared by all watchlists.
- **Today's open trades in watchlist summary line** — `buildWatchlistSummaryLines` previously only showed trades within a 4-bar window. Now also shows trades entered on the same trading day (`isSameTradingDay` fallback), so positions opened at the daily open appear immediately.

### Fixed — Scheduled task skipping runs (`MultipleInstances: IgnoreNew`)

**Windows Task Scheduler — `TradingViewSignalScan15m`**

When a scan ran long (e.g. chart switching for excursion stats), the next 15-minute trigger fired while the previous instance was still alive. `MultipleInstances: IgnoreNew` silently dropped the new trigger. If the long run crossed a trigger boundary, one or more scan windows were lost entirely.

Fixes applied:
- **`MultipleInstances`** changed from `IgnoreNew` to `Queue` — new triggers queue and run after the previous instance completes.
- **`StartWhenAvailable`** changed from `False` to `True` — if a trigger fires while the machine is asleep or the task is queued, it runs as soon as the condition is met.
- **Repeat duration** adjusted from PT9H45M to PT6H45M so the final trigger stops at approximately 4:16 PM ET, matching market close.

### Fixed — Scan running outside market hours after `--force` was added

**Files:** `scripts/run_signal_job.ps1`

`--force` was added to bypass the market-hours gate while debugging, but was left in place. This caused the PS1 script to call node.js at any hour, including pre-market and overnight, because `Test-ShouldRunNow` was also removed in the same pass.

Fix: `Test-ShouldRunNow` restored as the first gate in the PS1 script (before the CDP check). `--force` removed from the node.js call. The market-hours window remains 9:31 AM – 4:15 PM ET on weekdays.

Also fixed: PowerShell's `$PID` is a built-in read-only automatic variable. The local variable that held the launched TradingView process ID was renamed from `$pid` to `$tvPid` to avoid a parse error.

### Restored — Timeframe-aware scheduling with jitter tolerance

**File:** `src/core/morning.js`

Removing `--force` from the node call restored TF-aware scheduling, but it broke for the first scan after startup because `last_scanned_at` was not stored in the baseline, so elapsed-time fallback had nothing to compare against.

Changes:
- `filterScanTargetsBySchedule` now accepts a `baselineWatchlists` parameter.
- If `isTimeframeDueNow` returns false, an elapsed-time fallback checks `baselineWatchlists[watchlistName].last_scanned_at`. If the elapsed time since last scan is ≥ 85% of the timeframe interval (e.g. ≥ 51 min for a 1H watchlist), the watchlist is included. The 0.85× threshold absorbs scheduler jitter without triggering scans too early.
- `runBrief` saves `last_scanned_at: scanned_at` per watchlist in the baseline whenever a watchlist is actually scanned (not on scheduled-skip paths).
- `runSignalJob` passes `baseline.watchlists` into `filterScanTargetsBySchedule`.

### Fixed — Open Trades missing swing positions entered on daily timeframe

**Files:** `src/core/data.js`, `src/core/morning.js`

Swing positions on the 1D watchlist (e.g. JNUG, NUGT, AGQ, MEXX) were not appearing in the Open Trades section of the dashboard even though the strategy tester showed them as open.

**1. OPEN detection wrong for daily charts (`src/core/data.js`)**

`parseLatestTradeFromTesterText` used `dateLines.length < 2` to decide whether the most recent trade is still open. On intraday charts this works because open trades only show one date (the entry). On daily charts TradingView shows two dates even for open positions: the current session date as a mark price row, plus the actual entry date. Both dates match the date regex, so `dateLines.length` is always 2 and the trade was always classified EXIT.

The correct indicator is the Signal column of the exit row. When a position is still open TradingView renders that cell as the literal string "Open". For a closed trade it shows the strategy's exit signal name (e.g. "Flip Short").

Fix: added `hasOpenExitSignal = lines.some(line => line === 'Open')`. `isOpenTrade` is now `!hasTwoDates || hasOpenExitSignal`. Also fixed the date and price index logic that was using `dateLines[0]` / `usdIndexes[0]` for open trades — on daily charts the mark/exit row appears first, so the entry date is `dateLines[1]` and the entry price is `usdIndexes[1]` in all cases where two dates are present.

**2. Date guard filtering out older open swing positions (`src/core/morning.js`)**

`buildOpenTrades` called `isSameOrPreviousTradingDay(entryTime, asOf)` on every OPEN row regardless of source. This was designed to suppress stale baseline entries, but it also discarded correctly-detected open positions entered days or weeks ago (which is normal for swing trades on daily/weekly timeframes).

Fix: the date guard now only applies when building from `baselineSignals` (potentially stale data). Rows sourced from a live strategy panel scan (`priorSignalsByWatchlist`) skip the date check and are trusted as-is.

**3. Strategy panel returning stale data from previous symbol (`src/core/data.js`)**

`getLatestTradeFromTester` required only one stable reading (two polls 300 ms apart) before returning. When processing symbols sequentially, the strategy panel from the previously-loaded chart would stabilize on stale data before the new chart's strategy finished loading, causing the wrong trade to be recorded for the current symbol.

Fix: raised the stability threshold from 1 to 2 consecutive identical readings, and increased the default `timeout_ms` from 8000 to 14000 to give the extra poll cycle room within the budget.

### Fixed — TradingView MSIX auto-launch not passing debug flag (`scripts/run_signal_job.ps1`)

`Start-TradingViewWithDebug` set `ELECTRON_EXTRA_LAUNCH_ARGS` and called `Start-Process`, which works for classic (non-MSIX) installs. For Microsoft Store (MSIX) installs the environment variable is not inherited through the package activation broker, so the debug port never opened.

Fix: when the detected exe path is under `WindowsApps`, the function now uses the `IApplicationActivationManager` COM interface (`ActivateApplication`) to pass `--remote-debugging-port=9222` as an argument directly to the app activation call. The correct AUMID format is `{PackageFamilyName}!TradingView.Desktop`. Classic installs continue to use `Start-Process` with the env var.

## 2026-04-21

### Fixed — Dashboard not updating during market hours

**Files:** `scripts/run_signal_job.ps1`, `scripts/serve_signal_status.js`, `src/connection.js`

Three separate bugs combined to prevent the dashboard from receiving fresh data.

**1. Scheduled task skipping node.js due to per-minute precision check (`run_signal_job.ps1`)**

`Test-ShouldRunNow` required the current minute to land exactly on the 15-minute mark from 9:31 AM ET (e.g. 9:31, 9:46, 10:01…). Windows Task Scheduler startup overhead of even one minute caused the check to return false, so the PS1 script exited before calling node.js. No status file was written and no log entry was recorded. The symptom was `LastTaskResult: 0x800710E0` (new instance ignored — a prior slow run had not finished) and zero April-21 entries in `signal-scan.log`.

Fix: replaced the per-minute filter with a market-hours window check only. Node.js already handles per-minute scan scheduling internally via `filterScanTargetsBySchedule`; even when no scan is due it writes a timestamped "no targets due" result to the status file, keeping the dashboard clock current.

**2. SSE file-watcher silently dropping events on Windows (`serve_signal_status.js`)**

`fs.watch` on Windows regularly reports `filename: null` for valid write events. The guard `if (!filename || ...)` discarded all such events, so the Server-Sent Events stream never notified the browser. The browser only updated on a hard page reload.

Fix: changed the guard to `if (filename && ...)` so that null-filename events (i.e. any change in the watched directory) still trigger the SSE push.

**3. `fetch()` in CDP discovery had no timeout (`src/connection.js`)**

`findChartTarget` fetched `http://127.0.0.1:9222/json/list` with no timeout. When TradingView is mid-launch and accepts the TCP connection but stalls on the HTTP response, the `fetch` call hangs indefinitely. This prevented `ensureTradingViewConnection` from throwing, which in turn prevented the connection-error result from being written to the status file.

Fix: added `AbortSignal.timeout(3000)` to cap each CDP probe at 3 seconds.

## 2026-04-20

### Fixed — Push notifications firing on every scan

**File:** `src/core/morning.js`

Notifications were firing on every 15-minute scan whenever any signal was open, not just when a new signal appeared for the first time. This was because the notification checked `signal_lines` (all open signals) instead of `changedSignals` (signals that are new or changed since the last scan).

- Added `changedSignalLines` built from `changedSignals` only
- Notification condition and body now use `changedSignalLines`
- A push is sent only when a signal is newly detected or its entry price/time has changed

### Fixed — Push notification body sent as file attachment

**File:** `src/core/morning.js`

The `fetch` call to ntfy was missing `Content-Type: text/plain`, causing ntfy to treat the message body as a binary file attachment instead of readable text.

- Added `'Content-Type': 'text/plain'` to the ntfy request headers

### Fixed — Scheduled task stopping at 1:02 PM ET

**File:** Windows Task Scheduler — `\TradingViewSignalScan15m`

The repeat duration was set to 6 hours 31 minutes (6:31 AM → 1:02 PM ET), missing the entire afternoon session. Changed to 9 hours 45 minutes so the task fires through 4:16 PM ET, covering the full regular session.

### Fixed — TradingView MSIX auto-launch not enabling debug port

**Files:** `scripts/launch_tv_debug.vbs`, `scripts/run_signal_job.ps1`

TradingView Desktop is installed as a Microsoft Store (MSIX) package. Direct exe launch and the `ELECTRON_EXTRA_LAUNCH_ARGS` environment variable both fail to enable the Chrome DevTools Protocol port for MSIX-activated apps because the Windows package activation broker does not pass environment variables from the calling process.

Working solution: use the `IApplicationActivationManager` COM interface (`ActivateApplication`) with `--remote-debugging-port=9222` passed as the arguments parameter. This correctly starts TradingView with CDP enabled on port 9222.

- Updated `launch_tv_debug.vbs` to scan `C:\Program Files\WindowsApps` for the TradingView exe instead of relying on a hardcoded shell path
- Updated `run_signal_job.ps1` with `Start-TradingViewWithDebug` function and improved `Get-TradingViewExe` to detect MSIX installs via `Get-AppxPackage` and WindowsApps glob
