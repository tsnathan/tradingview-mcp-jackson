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

The table includes these additional columns derived from the full trade history:

- **Edge** — a 0-100 quality score for the symbol on that timeframe. See "Ranking signals for a fixed-size portfolio" below.
- **Org / New** — the position's rank by Edge among its timeframe peers, before and after today's new signals arrived.
- **Hist. MFE avg / max** — the average and maximum favorable excursion percentage across all completed trades for that symbol and timeframe. These represent how far price typically moved in your favor before the trade closed.
- **Hist. MAE avg / max** — the average and maximum adverse excursion percentage. These represent how far price moved against you during historical trades.
- **Alert Levels (avg / max)** — all four levels are always computed and shown for context, on **every** open position:
  - Stop avg and Stop max — entry price minus avg/max MAE%
  - Target avg and Target max — entry price plus avg/max MFE%

  **Real price alerts are only created automatically for positions with a webhook entry in the ledger** — i.e. positions where an actual order was placed through the trade executor (sent by this scanner, or by a TradingView alert on a timeframe you've marked "TV alert → ledger"). Everything else shows its suggested stop/target for you to act on manually. This changed on 2026-07-29: as the watchlist universe grew, auto-creating alerts for every detected position both exhausted the 20-alert quota and pushed level-hit notifications for positions with no money on them.

  The status indicator shows:
  - **✓ Alerts set** — the avg-pair alerts (Stop avg + Target avg) have been created in TradingView
  - **No webhook sent — auto-alert creation disabled, create manually if needed** — the normal state for a position you haven't placed an order for
  - **Local alert N/20** — a webhook-sent position that still couldn't get a real alert slot; monitored locally instead (see below)
  - **⏳ Pending** — not yet processed in the current cycle

  Webhook-sent positions get **priority** for the alert quota, and if the quota is full a longer-timeframe non-webhook position's alert is evicted to make room (a 1D position loses the least from dropping to local monitoring, since it's only checked once per its own long scan interval anyway).

  For webhook-sent positions, the **max pair is monitored locally** — every scan checks the live quote against the stored max-MAE/max-MFE levels (and the avg pair too, until its real alert exists) and pushes an ntfy notification titled "TradingView level alert" the first time a level is hit. This runs at the watchlist's own scan cadence (e.g. every 15 minutes for a 15m trade), not tick-by-tick like a real TradingView alert.

  When a position closes, its real TradingView alerts are automatically deleted — no manual cleanup needed. Alerts for symbols dropped from a watchlist entirely are also cleaned up at the twice-daily watchlist reconciliation, which is the only path that would otherwise leave them stranded until they self-expire.

Alerts are created via TradingView's internal price-alerts REST API and count against your plan's active alert limit — only genuinely *active* alerts count, so old expired/inactive ones don't eat into the quota. Alert creation is idempotent — once alerts are recorded for a `symbol|timeframe` key at a given entry price, subsequent scans skip that trade. If the entry price changes (a new trade on the same symbol), alerts are re-created.

Pre-existing alerts created before the webhook-only policy are left alone, not torn down.

### Ranking signals for a fixed-size portfolio

If you can only hold N positions at once, the useful question is which of the available signals to take and which holding to give up. The **Edge** column answers it.

**Edge** is the symbol's *expectancy percentile within its own timeframe*, 0-100, computed from the closed-trade log. 100 means the best average trade of any symbol on that timeframe; 0 means the worst. Hover the cell for the underlying numbers (expectancy per trade, win rate, average win / average loss, profit factor, average hold, trade count, and which exit-rule variant it was measured on).

Why expectancy and not profit factor, Sharpe, or CAGR/drawdown — all of which TradingView's own Key Stats panel shows? Because those were tested on this data and **rank symbols slightly worse than random** out of sample. Ranking each symbol on the first half of its own history and scoring it on the second half gives a rank correlation of +0.38 for expectancy, but −0.17 for profit factor, −0.13 for Sharpe and −0.15 for CAGR/drawdown. The reason is that maximum drawdown over a dozen trades is essentially that symbol's single worst trade, which is noise and mean-reverts, so dividing by it ranks symbols by how lucky their worst trade happened to be. Those metrics are still shown as diagnostics — they're just not what the score is built from.

Percentile rather than the raw expectancy value because expectancy scales hard with timeframe (roughly 1.7%/trade at 15m against 7% at 4H), so a raw ranking would really just be a timeframe ranking. The percentile is also what makes rows from different timeframes comparable for the position cap.

**Org and New** are the same rank, computed over two different sets, both within the row's own timeframe:

- **Org** — rank among the positions that were already open *before* today's new signals arrived. A position opened today shows "new" here, because it wasn't in that book.
- **New** — rank among every position now open on that timeframe, today's entries included, with a ▼ / ▲ arrow when the two disagree.

Read together they show displacement. A holding that went from 3/10 to 9/13 has been pushed down by better signals that arrived today, and the newcomer sitting at 2/13 with no Org rank is what pushed it — that's the trade to consider swapping.

**Max positions** (top right of the card, default 15) pools *every* open position across all timeframes by Edge score and flags the ones ranked below the cap as over-cap liquidation candidates, naming the weakest three. It's stored in your browser, so changing it re-renders instantly with no scan or restart.

Two deliberate limits worth knowing:

- Symbols with fewer than 8 closed trades show **n/a** and are never flagged over-cap. "Not enough history to judge" must not read as "weak", or the cap would tell you to liquidate positions purely for being new to the log.
- Edge ignores the position's current unrealized P&L on purpose. Cutting positions that happen to be down was tested twice here (as a stop-loss variant, and as a best-case simulation that was allowed to cheat and look at each trade's final outcome) and lost both times, because long positions recover a long way from their worst point on average — roughly 13% adverse excursion against −2.5% final. Edge answers "is this symbol's average trade any good on this timeframe", which is a question the trade log can actually answer.

**Use it as a filter, not a priority order.** Testing on this data: changing *which* signal you take when several fire at once barely moved anything, because simultaneous signals are rare. Dropping the bottom half by past expectancy moved a lot — but only when you're genuinely turning signals away. At 5 slots it helped in all 5 test windows; at 10 slots only 3 of 5, and twice it hurt materially. Check the fill rate in the Portfolio Simulation tab before trimming anything. And don't add a drawdown screen on top of it — that was tested separately and loses on both return *and* portfolio drawdown, because on leveraged/volatile instruments the volatility that produces the drawdown is the same volatility that produces the edge.

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

### Trade execution webhook

Your TradingView subscription only carries **two** watchlist alerts, and those already POST to the Railway executor directly. Every other timeframe would otherwise mean reading an ntfy push and placing the order by hand, which doesn't scale at a 30m/45m cadence. This card's **Trade Webhook** column lets the scanner send the *same payload TradingView's own alert sends*, so the executor can't tell the difference.

#### One-time setup

Create `webhook.local.json` in the project root (it's gitignored — safe for secrets):

```json
{
  "url": "https://your-railway-app.up.railway.app/webhook-path",
  "secret": "your-shared-secret"
}
```

Both fields are required — a filled secret with a blank URL still reads as unconfigured and every send is refused. Alternatively set `TRADE_WEBHOOK_URL` and `TRADE_WEBHOOK_SECRET` as environment variables, which take precedence.

**Never put these in `rules.json`** — that file is tracked in git. Only the non-sensitive switches (`webhook.group`, `webhook.enabled_timeframes`, `webhook.tv_alert_timeframes`) live there, because the dashboard has to persist them.

Restart the dashboard server after editing (it holds config in memory).

#### Per-timeframe modes

Each watchlist group header has two mutually exclusive checkboxes. Enabling one clears the other, in the config and in the UI, because having both set would mean two orders for one signal.

| Mode | What it does |
|---|---|
| **auto-send** | The scheduled scan POSTs a real order automatically for every new OPEN signal on this timeframe, and the matching close when it exits. Confirmation dialog on arming; **this places real orders with no further prompting**. |
| **TV alert → ledger** | The scanner sends **nothing**. Use this on the one or two timeframes where a TradingView watchlist alert is already POSTing to the executor. Every OPEN/EXIT the scan detects is recorded in the ledger as if it had been sent. |

**Why the TV-alert mode matters.** Before it existed, a position opened by a TradingView alert was invisible to this system's bookkeeping, which caused four silent problems: the dashboard offered a "Send" button on a position that was already filled (duplicate-order risk), price alerts and level monitoring skipped it entirely because both are now scoped to webhook-sent positions, it lost the alert quota to positions with no money on them, and there was no single place to reconcile live positions. Recording the same ledger entry closes all four at once, because every one of those paths already keys on "is this position in the ledger".

Rows recorded this way are labelled **◆ via TV alert** rather than **✓ sent**, so "we placed this order" and "we observed this order" are never confused. Recording is not gated on the scheduled scan — a manual scan that first observes the position records it too, since the order was placed regardless of which scan noticed.

Auto-exit never fires for these positions: TradingView's own alert closes them, and the auto-exit path only runs on `auto-send` timeframes.

#### Manual Send and Close

Every open position gets a manual **Send** control regardless of arming — an order-type dropdown, a time-in-force dropdown, the price inputs the chosen type requires, and a Send button with a confirmation dialog. Useful for testing the wiring against one real position before arming a whole timeframe.

| `order_type` | Required |
|---|---|
| `market` (default) | — |
| `limit` | limit price |
| `stop` | stop price |
| `stop_limit` | limit price **and** stop price |
| `trailing_stop` | trail % **or** trail $ (time-in-force is forced to GTC by the executor) |

| `time_in_force` | Notes |
|---|---|
| `gtc` | the executor's default |
| `day` | regular-session day order |
| `opg` | at-the-open; an unfilled OPG order is resubmitted as a market order at 9:35 AM ET |
| `cls` | at-the-close |
| `ioc` / `fok` | forwarded to the broker, not used by any strategy path |

`opg` and `cls` are only valid on market and limit orders. A priced order type without its price, or an invalid combination, is refused before anything is sent — validated in the browser *and* again on the server, because this places a real order.

Prices are never computed for you. Bid/ask aren't available from a normal scan (the fields come from a panel that isn't part of this chart layout), so an "automatic midpoint" limit price would have silently fallen back to a market order nearly every time. You type the price.

Once a position's entry is in the ledger, the cell offers a **Close** control with the same order form. It only appears for positions this system knows were opened at the executor — closing something the executor was never told about could error out or, worse, open an unintended opposite position. This is the button to use when the Edge ranking says a holding should make room for a better signal.

#### Automatic closes

**Any position whose entry is in the ledger gets an automatic close order when the strategy exits it — whether or not its timeframe is armed.** Arming controls whether new orders are *opened* without you; it does not control closing. A position you sent by hand on an unarmed timeframe would otherwise sit open at the broker with the system that opened it declining to close it, which is worse than the risk arming exists to manage.

Two exceptions: positions recorded from a TradingView alert (that alert sends its own close), and positions you already closed manually.

The close fires on the first **scheduled** scan after the exit is detected, so it is not instant — at a 15-minute cadence it lands on the next tick, and a scan already in flight when the exit happens won't catch it until the following one. If you want out sooner, use the Close button.

**If no scan runs on the day a position exits, the automatic close is missed for good.** An exit only qualifies while it's still same-day; the next day's scans no longer recognize it. That happens when the machine is asleep, TradingView is down, or an earlier long-running scan is still holding the scheduler slot.

Those get caught rather than lost: the Open Trades card shows an orange banner listing any position opened by webhook whose strategy position has closed with no close order sent, each with a **Send close** button. It is not sent automatically, because by definition the state behind it is stale — check the broker still holds the position before clicking, since if it was closed some other way the order would try to sell what you no longer hold.

#### Safety gates

Three gates must all pass before an *automatic* order goes out, and each covers a different failure:

1. the scan was the real scheduled one (`run_signal_job.js --notify`) — no dashboard-triggered or ad-hoc scan can ever place a live order,
2. the timeframe is armed for auto-send,
3. this exact `ticker|timeframe|entryTime` isn't already in the ledger.

Gate 3 is load-bearing: the same OPEN position is re-detected on every scan for as long as it stays open, so without it a 15-minute cadence would re-order the same entry all day. Entry time is in the key because it's precisely what changes when a genuinely new position opens on a symbol that already fired. A position with an unknown entry time is skipped, never given a substitute.

Failed sends are deliberately **not** recorded as sent, so the next scan retries.

The ledger lives at `status/webhook-sent-state.json`. To check what's armed and what's been sent without opening the dashboard:

```powershell
Invoke-RestMethod http://127.0.0.1:3030/api/webhook-config | Select-Object configured, enabledTimeframes, tvAlertTimeframes
```

The secret is never included in any response, only whether one is configured.

### Webhook Orders tab

Every order this system sent to the trade executor, read straight from the ledger (`status/webhook-sent-state.json`). An entry stays **open** here until a matching close is sent — and that same record is what the auto-close, the price-alert priority and the duplicate-send guard all key on, so this is the definitive list of what the system believes it has working.

It is *not* a broker position report. The ledger records what was sent; whether the broker actually holds it is the Executor Portfolio card's job. A disagreement between the two is worth investigating, which is exactly why they're separate views.

**Open — sent, not yet closed** lists each open order with its symbol, timeframe, side, price, order type, when it went out, and where it came from (`manual` = the Send button, `auto` = an armed scheduled scan, `TV alert` = recorded from a TradingView watchlist alert). Each row carries the full order form — order type, time in force, and whatever price fields the type needs — so you can close with a limit, stop, or trailing stop rather than only at market. TV-alert rows show no Close button: TradingView's own alert sends their close, and sending a second one would double up.

**History** shows every order, open and closed, with both legs side by side — entry side/price/order type/time sent, and the same for the exit. Filter by:

- **Symbol** — substring match on the bare ticker, so `SOX` finds SOXL and pasting `BATS:SOXL` still matches.
- **Timeframe** — only values that actually appear in the ledger, so a filter can never return nothing by mistake.
- **Status** — all, open only, or closed only.

The tab reloads every time you open it rather than caching, because an order can be sent from anywhere — a scheduled scan, the Signals tab, or this tab — and a stale view could offer Close on a position that has already been closed.

### Executor Portfolio card

Reads the Railway app's own positions and reconciles them against the webhook ledger. This is the **only source of truth for what is actually held and at what size** — everything else on this dashboard is inference from TradingView's strategy output. Refresh is manual (it hits an external service), and it loads once when the page opens.

Add the endpoint to `webhook.local.json`:

```json
{
  "url": "https://your-app.up.railway.app/webhook-path",
  "secret": "your-shared-secret",
  "portfolio_url": "https://your-app.up.railway.app/portfolio"
}
```

Authentication defaults to `?secret=…` on the query string, reusing the webhook secret — the GET analogue of how the webhook already authenticates. If your endpoint wants something else, add `"portfolio_auth"`:

| Value | Sends |
|---|---|
| `query` (default) | `?secret=…` — rename the param with `portfolio_auth_param` |
| `bearer` | `Authorization: Bearer <secret>` |
| `header` | `X-Api-Key: <secret>` — rename with `portfolio_auth_header` |
| `body` | POST with `{"secret": "…"}`, identical to the webhook |
| `none` | no credential |

A 401/403 is reported in the card **with the status and response body**, so getting the mode wrong is a one-look fix rather than a guess. Set `portfolio_method` to override GET/POST independently.

**The response schema doesn't need to match anything.** The card finds the positions list wherever it sits (a bare array, or under `positions` / `holdings` / `data` / `openPositions` / one level of nesting) and matches field names ignoring case, underscores and dashes — so `avgEntryPrice`, `avg_entry_price` and `AVG-ENTRY-PRICE` all resolve. Symbol, side, quantity, average price, last price, market value and unrealized P&L are each matched against a list of common names; anything it can't map shows as `—` rather than being guessed from a neighbouring field. A negative quantity is read as a short. Unrealized-percent values are treated as a fraction when the magnitude is ≤1 (`0.0084` → `0.84%`).

Because it's shape-agnostic, the card also shows a collapsible **Raw response sample** of the first row. If a column reads `—` when your API clearly returns that value, that sample is what to look at — the field-name list can then be extended.

**What it tells you:**

- **Weight** — each position's share of total portfolio value, next to what an even split across N positions would be. Absolute position size needs account equity, which the endpoint may not return; relative weight is the practical read on whether one position is oversized.
- **Held vs cap** — position count against your Max positions setting, so an over-capacity book is obvious.
- **⚠ untracked** — the broker holds it but no open ledger record covers it. Either it was entered outside this system, or a close was recorded here while the broker still holds it (a close order that never filled).
- **Open ledger records with no broker position** — the mirror case: either the entry never filled, or it closed at the broker and no scan has seen the EXIT yet.

Matching is by ticker with the ledger side aggregated, because the broker holds one position per ticker no matter how many timeframes signalled it — the **Ledger TF** column lists which ones contributed, with a ◆ marking entries recorded from a TradingView alert. Matching per timeframe instead would report a false break for every multi-timeframe symbol.

Neither side is assumed to be wrong: the card reports the difference and leaves the call to you.

### Edge Analysis tab

Ranks and compares what the closed-trade log actually shows, per symbol and per timeframe. All of it respects the **Exit rule** chip row (see "Comparing exit rules" below) and defaults to the variant with the most trades, never a pool of all of them.

- **Symbol Ranking** — every symbol|timeframe sorted by expectancy, with a Keep / Watch / Drop verdict based on its percentile *within its timeframe*. Also shows CAGR and "Expected" side by side: CAGR compounds the observed result over the calendar span, while Expected multiplies the average trade by how many such trades fit in a year at that symbol's own hold period. They can disagree in sign, and both are real — CAGR is the compounding-equity lens, Expected is the trade-frequency lens.
- **Timeframe Comparison** — the same aggregated per timeframe, plus identical-calendar-window comparisons (6 / 12 / 24 months) so a timeframe with more loaded history doesn't win on span alone.
- **Open Position Concurrency** — least / average / max number of simultaneously open positions over the trailing 1, 2 and 3 months, per timeframe and pooled. The average is time-weighted, so a brief lull and an all-day stretch at the same level don't count equally. This is the number to check against your Max positions cap. It's historical and closed-trades-only: a position still open right now has no exit time yet, so the most recent slice reads a little low — the Open Trades count is the live figure.
- **Exit reasons** — what actually closes trades per timeframe. The direct evidence for whether a stop ever fires.

### Portfolio Simulation tab

Replays the closed-trade log as a single account with a fixed number of position slots, so you can see what a capacity limit really costs. Reports fill rate (what share of signals you'd have had room for), time-weighted capital utilization, CAGR, max drawdown and CAGR/drawdown, plus a sweep across slot counts.

**Check fill rate here before trimming a watchlist by Edge.** Selection only pays when you're turning signals away; above roughly 65% fill it mostly just removes trades.

### Symbol Lookup tab

Everything known about one ticker in one place: which watchlists hold it, any open position per timeframe, per-timeframe stats, and its closed-trade history. The closed-trade table includes a `webhook` column showing what the ledger recorded for each entry (`✓ entry only`, `✓ entry+exit`, or `—`).

### Trade Log Orphans card

Lists symbols that still have trade history in the active log but are no longer in any watchlist. Left alone they skew Edge Analysis and Portfolio Simulation, since their trades belong to a strategy you're no longer running on them. The card shows ticker, trade count, timeframes and last trade date, with an **Archive All** button (confirmation required) that moves those rows to `trade-log/archive/`.

The card also now supports row selection: you can choose one or more orphaned tickers and click **Archive selected** to move only those rows. A **Clear selection** button resets your choices without reloading the card.

**Sweep now** recomputes the list on demand. It's instant and needs no TradingView connection — it just diffs the active trade log against the watchlist membership already stored in the baseline. After sweeping, the card states what date that membership is from, and warns if it's more than a day old.

What Sweep does *not* do is re-read your watchlists from TradingView. So if you removed symbols more recently than the last watchlist reconciliation, they won't appear yet no matter how many times you sweep — resync membership first (a scan does this at market open and close, or run `node src/cli/index.js watchlist sync`), then sweep.

Detection also runs automatically on every scan. Archiving stays deliberately manual: an automated job silently rewriting trade-history CSVs off a watchlist read that can occasionally fall back to stale data is a worse failure mode than a banner one click away from doing it correctly. To reverse an archive:

```powershell
node .\scripts\archive_trade_log.js --restore
```

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

### Closed-trade log (per timeframe)

Every scan writes the strategy's closed trades to a CSV per timeframe under `trade-log/`:

```
trade-log/trades-15m.csv
trade-log/trades-30m.csv
trade-log/trades-1h.csv
trade-log/trades-3h.csv
trade-log/trades-4h.csv
trade-log/trades-1d.csv
```

Rows are deduplicated by exit rule + ticker + timeframe + entry timestamp + exit timestamp, so rescanning the same symbol never double-logs. Only **closed** trades are written — the still-open position is skipped, because its exit price is a live mark-to-market figure that changes on every bar.

**Why this exists:** TradingView's Strategy Tester only shows trades inside the currently-loaded bar history for the symbol on screen, and its headline Profit Factor / Percent Profitable exclude still-open losers entirely. A strategy that closes winners and lets losers ride therefore reads as near-perfect. The CSV log is durable and realized-only, so timeframes can be compared honestly over time.

Three columns exist nowhere else in the project:

- **`exit_signal`** — the strategy's own reason for exiting (`Flip Short`, `Trailing Stop`, …). This is how you tell whether a stop is actually firing or whether every trade exits on a signal flip.
- **`bars_held`** — exact bar count from the strategy's bar indices, not a wall-clock estimate.
- **`rule_type`** — which exit-rule variant produced the trade. See below.

#### Comparing exit rules (`rule_type`)

The strategy's exit-rule toggles (Time Stop, Stop Loss) live on the chart, and `rule_type` records what they were set to when each trade was logged — read from the chart itself, so it can't disagree with reality. Values look like `flip-only` (no stop of any kind), `ts60` (time stop at 60 bars), `ts60-losing`, `sl-auto` (stop loss, auto level per timeframe), `sl12.0` (manual 12%), or `ts60+sl-auto`.

**To A/B test a rule:** flip the toggle on the chart, run a scan, and the resulting trades are tagged with that variant automatically. Flip it back and the baseline resumes. Both sets accumulate side by side in the same files and never overwrite each other, so you can switch back and forth freely and still compare cleanly afterwards.

The Edge Analysis and Portfolio Simulation tabs both show an **Exit rule** chip row, and default to whichever variant has the most trades. The two tabs share one selection on purpose — otherwise one tab could report a baseline number next to the other's test number. Selecting **All pooled** averages the variants together, which describes no single strategy and is almost never what you want.

From the command line:

```powershell
node .\scripts\analyze_trade_log.js --rules            # what variants are logged
node .\scripts\analyze_trade_log.js --rule ts60        # analyse one variant
node .\scripts\analyze_trade_log.js --rule all         # pool everything (rarely useful)
```

Also logged per trade: side, entry/exit signal + price + ET timestamp, quantity, position value, net P&L in USD and %, MFE (run-up), MAE (drawdown), and commission.

**Backfill the full history once** (walks every watchlist symbol; safe to re-run, appends only new closures):

```powershell
node .\scripts\backfill_trade_log.js
node .\scripts\backfill_trade_log.js --tf 15,240   # only these timeframes
```

**Analyze it:**

```powershell
node .\scripts\analyze_trade_log.js                # per-timeframe summary
node .\scripts\analyze_trade_log.js --by symbol    # rank symbol|timeframe by expectancy
node .\scripts\analyze_trade_log.js --by exit      # what actually closes trades
node .\scripts\analyze_trade_log.js --tf 15 --min 6
```

The per-timeframe summary reports real Profit Factor (every closed loser in the denominator), expectancy per trade, average win/loss %, average MFE/MAE, and average bars held split by winners vs losers.

The CSVs are plain text — open them in Excel, or query them with anything that reads CSV.

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
- `webhook.local.json` — trade-executor URL and secret (**gitignored**, create it yourself; see "Trade execution webhook")
- `swing-signal-baseline.json` — saved signal and trade state
- `status/latest-signal-status.json` — dashboard data source
- `status/watchdog-state.json` — watchdog retry counter (auto-created)
- `status/watchlist-sync-state.json` — tracks which date's open/close watchlist sync already ran (auto-created)
- `status/webhook-sent-state.json` — the trade-webhook ledger: which entries/exits were sent or observed (auto-created)
- `status/strategy-perf.json` — live open P&L / max drawdown snapshots per symbol|timeframe
- `trade-log/trades-*.csv` — closed-trade history per timeframe; `trade-log/archive/` holds archived orphans
- `signal-scan.log` — appended output from the scheduled PowerShell job
- `dashboard-server.log` — appended output from the dashboard server when it was started by ▶ Restart Server
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

### The dashboard loads but a button does nothing (or a change to the code had no effect)

The dashboard server holds all its code and config in memory. Editing `rules.json`, `webhook.local.json`, or anything under `src/` has no effect on the running server until it restarts. The **scheduled scan is unaffected** — it's a fresh process every run — so this only bites things the dashboard server itself executes: ▶ Run Scan Now, manual webhook sends, the analysis tabs.

Restart it from the dashboard, or:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3030/api/restart
```

A restarted server writes its output to `dashboard-server.log`. If you ever see a server that answers some pages but hangs forever on others with no error anywhere, check that file — before 2026-07-29 the restart inherited a console pipe with nothing reading it, and once its buffer filled, every request that logged would block while requests that happened not to log kept working.

### TradingView Status shows Disconnected

The app may not be signed in, the chart may still be loading, or the debug endpoint may not be ready yet.

### No signal is shown

That can be normal. It usually means no fresh setup was detected for the current scan.

### Open Trades is empty

That means no currently locked active trades were found in the latest saved state.
