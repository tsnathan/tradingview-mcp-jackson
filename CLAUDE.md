# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

### "None of the tv_*/chart_*/data_* tools are available this session"
CDP connectivity and MCP tool registration are two independent things — don't assume one implies the other:

1. Check CDP is actually up: `Invoke-WebRequest http://127.0.0.1:9222/json/version` (PowerShell) — a 200 with a TradingView user-agent means the debug port is live, regardless of whether any MCP tools are loaded.
2. Check the server is actually registered where Claude Code reads it: `~/.claude.json` → `projects["c:/Users/tsnat/tradingview-mcp-jackson"].mcpServers` must have a `tradingview` entry with `args` pointing at the absolute path to this repo's `src/server.js`. Note the project key uses forward slashes and a lowercase drive letter — looking it up with the backslash/uppercase form (`C:\Users\...`) will silently miss it. `~/.claude/.mcp.json` (a different, sibling path — `.claude` folder, not `.claude.json` file) has been found orphaned/unread in this setup before; don't trust it as the source of truth without verifying against `~/.claude.json` first.
3. If both of the above are fine but the tools still aren't showing up, the MCP server was registered/edited **after** the current Claude Code session started — it only loads config at startup. Restart Claude Code (quit and reopen), then confirm with `tv_health_check`.

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## Automated Signal Scan — Status & Gotchas

This project also runs a separate Windows-scheduled signal scanner (`TradingViewSignalScan15m` every 15 min, `TVWatchdog` every 5 min) independent of interactive MCP tool use. Full operational docs (how to suspend/resume, holiday list, desktop toggle shortcut) live in `USER_GUIDE.md`. Two things worth knowing if you're asked to debug it:

1. **Two separate "off switches" exist and both must be checked.** The Windows Task Scheduler task can be Enabled while `rules.json` → `schedule.disabled: true` still silently no-ops every run ("Scheduled scanning disabled"). Always check both — `Get-ScheduledTaskInfo -TaskName TradingViewSignalScan15m` for the task, and `rules.json`'s `schedule.disabled` for the config gate.
2. **The dashboard server does not hot-reload code.** If you edit `src/core/morning.js` (or anything it imports) while `scripts/serve_signal_status.js` is already running, the running process keeps executing the *old* in-memory code until it's restarted. Compare the server process's start time (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) against the file's last-write time before trusting a scan result you just triggered.

### Open-trade detection reliability (do not assume the Pine label is ground truth)

The strategy's on-chart status label (`Mode: Fast (active bar)\nLast signal: X\nBars since signal: N\nPosition: Flat/Long/Short`) is **not** fully reliable evidence of a currently open position:

- `Position: Flat` is safe to trust unconditionally (`strategy.position_size == 0` is unambiguous).
- `Position: Long`/`Short` is computed on the **active, still-forming bar** and can run one bar ahead of the confirmed Strategy Tester "List of Trades" — e.g. a trailing-stop exit already closed the position in the trade list, but the label hasn't reset because no new opposite signal has fired yet. Treating `Long`/`Short` alone as confirmation of an open trade produces false positives.
- Symbols can also switch exchange prefix between scans for the same instrument (e.g. `AMEX:AGQ` vs `BATS:AGQ`) — match by ticker (strip the prefix) + timeframe when checking continuity of an existing position, not by exact symbol string.

**Ground truth now comes from the internal API, not the DOM.** `getLatestTradeFromTester()` in `src/core/data.js` no longer scrapes the rendered "List of Trades" panel as its primary source — it calls `getStrategyPositionState()`, which reads the strategy's own `reportData()` object directly off the chart's internal JS model (`chart.model().model().dataSources()` → the data source whose name matches `/strategy/i` → `.reportData()`). This is the same object the Strategy Tester UI renders from, so `performance.all.totalOpenTrades` and `performance.openPL` are authoritative and instant — no virtualized-list scrolling, no text parsing, no multi-second stability polling. The DOM scrape (`getLatestTradeFromTesterDom`, unexported) is now only used as:
  1. A full fallback when no strategy source can be found or matched at all.
  2. A narrow, capped (~5s) enrichment pass when a position is confirmed OPEN via the internal API but its entry timestamp isn't recoverable that way (`filledOrders` entries carry a sequence index, not a real timestamp — only paired, *closed* trades in `reportData().trades[]` carry real epoch-ms entry/exit times). A DOM failure in this enrichment pass never discards the open/flat status already established via the internal API.

Two non-obvious traps if you touch this code again:
- **Matching studies by name only, not by method presence.** `reportData`/`performance`/`ordersData` exist as methods on the generic Study base class too (confirmed live: a "Dividends" study matched this way) — filter candidates by `/strategy/i.test(name)` only, never `|| !!(s.reportData || ...)`.
- **Freshly-attached/just-switched studies can return a mid-recompute snapshot if read once, immediately.** `readStableStrategyReportData()` polls a few times (~350ms apart, bounded ~2s) and requires the trade-identity signature (open entry price/qty/id, or last closed trade's entry+exit price/time) to match twice in a row before trusting it. `openPL` is deliberately excluded from that signature — it fluctuates with every live tick for a genuinely open position, so comparing it would either false-negative on "stability" or force waiting out real market movement.

### Strategy-identity guard (suspend + flag on mismatch, no auto-repair)

`checkStrategyIdentity()` in `src/core/morning.js` runs at the start of every `runSignalJob()` call (scheduled and manual/dashboard-triggered alike) and compares the chart's currently attached indicator names (`chart.getState().studies`) against `rules.json`'s `strategy` field. This exists because it's normal to swap in a different strategy on the chart temporarily (testing, comparison) — if that's still attached when a scan fires, every trade/signal read for that run would silently come from the wrong script with no visible error.

- On mismatch, scanning is **suspended immediately** for that run (same `skipped: true` early-exit path as `schedule.disabled`/outside-market-hours) and the mismatch is written to the status JSON as `strategy_mismatch` (`{ expected, found, detected_at }`), surfaced as a banner in `dashboard/index.html` (`#strategy-mismatch-banner`).
- **There is deliberately no auto-repair.** This was tried and removed: `chart_manage_indicator`'s `add` action calls TradingView's `createStudy(name)`, which can only add **public/built-in** indicators by exact name — it cannot restore a private saved script. Live-tested against this project's real configured strategy (`"Swing Profile Strategy [BigBeluga]"`, a private script customized with a trailing-stop exit): `createStudy` silently returned zero studies added. An auto-repair attempt here would either fail silently (as observed) or, worse, resolve to some unrelated public script sharing the same title. Suspend-and-flag is the only safe automatic behavior; restoring the correct indicator is a manual step.
- **To manually restore a private/custom strategy** (this account has more than one saved script titled `"Swing Profile Strategy [BigBeluga]"` — check `pine_list_scripts` and match by `modified` timestamp / ask the user which is current before picking one): `pine_open({ name })` only loads the source into the Pine Editor, it does **not** add it to the chart. You then have to click the editor's **"Add to chart"** button specifically — it's a distinct button (`title="Add to chart"`) from "Save script" and "Share your script with community", positioned just right of the editor's script-name dropdown. `pine_smart_compile`'s auto-button-detection can pick "Pine Save" instead if the editor thinks the script is unmodified — don't trust `study_added` from that tool for this flow; verify with a follow-up `chart_get_state` instead. Find the exact button coordinates via `ui_evaluate` (query buttons by `title` attribute in the top ~200px of the editor pane) rather than guessing screenshot coordinates, since the DOM button positions are stable even when screenshot pixel-scaling isn't.

### Push notifications (ntfy) — gating and failure visibility

- Notifications only fire when `runSignalJob` runs with `notify: true`. Only the real scheduled path sets that (`run_signal_job.ps1` → `run_signal_job.js --notify`) — every manual/dashboard-triggered scan (`/api/run-cron-now`, direct `runBrief` calls) explicitly passes `notify: false`, so ad-hoc testing/debugging can never leak a push.
- Eligibility (`notify_signal_lines` in `src/core/morning.js`) requires `entry.trade?.signal === 'OPEN'` — the confirmed Strategy Tester trade-table read, not the unreliable `Position: Long/Short` label — plus `isRecentTradeSignal`/`isSameTradingDay` (same ET calendar day, entry within ~4 bars). This makes the notify path stricter than the raw Open Trades table, which is why the false-positive open-trade bug above never produced a spurious push.
- The POST to `rules.ntfy.url` logs on failure (non-2xx response or fetch error) instead of swallowing it — check the console output / `signal-scan.log`. `run_signal_job.ps1` captures the job's stderr into `signal-scan.log` via a temp-file redirect (`2>$stderrFile`), not `2>&1` — this script has `$ErrorActionPreference = 'Stop'`, and `2>&1` on a native exe in PS 5.1 can turn a stderr line into a terminating error that aborts the whole script.
- To validate the wiring live without waiting for a real signal: POST directly to `rules.ntfy.url` with `Content-Type: text/plain` and `Title`/`Priority` headers (same shape as the real call) and confirm HTTP 200.
