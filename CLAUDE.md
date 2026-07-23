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

**Ground truth now comes from the internal API, not the DOM — for everything.** `getLatestTradeFromTester()` in `src/core/data.js` no longer scrapes the rendered "List of Trades" panel as its primary source — it calls `getStrategyPositionState()`, which reads the strategy's own `reportData()` object directly off the chart's internal JS model (`chart.model().model().dataSources()` → the data source whose name matches `/strategy/i` → `.reportData()`). This is the same object the Strategy Tester UI renders from, so `performance.all.totalOpenTrades` and `performance.openPL` are authoritative and instant — no virtualized-list scrolling, no text parsing. **The still-open trade is included in `reportData().trades[]` as the LAST element** (when `totalOpenTrades > 0`), carrying its real epoch-ms entry timestamp (`e.tm`), entry price, side (`e.tp`: "le"/"se"), and live MFE/MAE (`rn`/`dd`) — plus a *synthesized mark-to-market exit row* that the UI renders as Exit "Open" (verified live 2026-07-23: `trades.length` 7 vs `performance.all.totalTrades` 6 with 1 open). Historical avg/max MFE/MAE (`getAllTradesExcursionStats`) is also computed from `trades[]` (`rn.p`/`dd.p` are *fractions* of position value — 0.038 = 3.8% — scale ×100 for the percent units the alert-level math uses). The DOM scrape (`getLatestTradeFromTesterDom` / `getAllTradesExcursionStatsDom`, both unexported) survives only as a full fallback when no strategy source can be found or matched internally at all — a `trade_source` of `"strategy_tester_dom"` in the status JSON is itself a red flag worth investigating.

Three non-obvious traps if you touch this code again:
- **Matching studies by name only, not by method presence.** `reportData`/`performance`/`ordersData` exist as methods on the generic Study base class too (confirmed live: a "Dividends" study matched this way) — filter candidates by `/strategy/i.test(name)` only, never `|| !!(s.reportData || ...)`.
- **Freshly-attached/just-switched studies can return a mid-recompute snapshot if read once, immediately.** `readStableStrategyReportData()` polls a few times (~350ms apart, bounded ~2s) and requires the trade-identity signature (open trade's entry time/price/qty, or last closed trade's entry+exit price/time) to match twice in a row before trusting it. `openPL` — and the open trade's synthesized *exit* row, which is mark-to-market and moves with every live bar — are deliberately excluded from that signature; comparing them would either false-negative on "stability" or force waiting out real market movement.
- **Never fabricate a missing entry time.** An earlier version substituted the scan timestamp when `entryTime` was null (`buildOpenTrades`'s `|| entry.scanned_at` fallback). That single fallback produced three simultaneous dashboard bugs: wrong entry dates on every open trade, silently dropped Current Signal/ntfy events (the recency gates parse null as epoch-0 → "not recent"), and unbounded accumulation of "open" rows all dated at scan time. If entry time is ever unknown again, it must surface as unknown — the recency gates excluding such rows is correct behavior, not a bug to patch around.

### Strategy-identity guard (suspend + flag on mismatch, no auto-repair)

`checkStrategyIdentity()` in `src/core/morning.js` runs at the start of every `runSignalJob()` call (scheduled and manual/dashboard-triggered alike) and compares the chart's currently attached indicator names (`chart.getState().studies`) against `rules.json`'s `strategy` field. This exists because it's normal to swap in a different strategy on the chart temporarily (testing, comparison) — if that's still attached when a scan fires, every trade/signal read for that run would silently come from the wrong script with no visible error.

- On mismatch, scanning is **suspended immediately** for that run (same `skipped: true` early-exit path as `schedule.disabled`/outside-market-hours) and the mismatch is written to the status JSON as `strategy_mismatch` (`{ expected, found, detected_at }`), surfaced as a banner in `dashboard/index.html` (`#strategy-mismatch-banner`).
- **There is deliberately no auto-repair.** This was tried and removed: `chart_manage_indicator`'s `add` action calls TradingView's `createStudy(name)`, which can only add **public/built-in** indicators by exact name — it cannot restore a private saved script. Live-tested against this project's real configured strategy (`"Swing Profile Strategy [BigBeluga]"`, a private script customized with a trailing-stop exit): `createStudy` silently returned zero studies added. An auto-repair attempt here would either fail silently (as observed) or, worse, resolve to some unrelated public script sharing the same title. Suspend-and-flag is the only safe automatic behavior; restoring the correct indicator is a manual step.
- **To manually restore a private/custom strategy** (this account has more than one saved script titled `"Swing Profile Strategy [BigBeluga]"` — check `pine_list_scripts` and match by `modified` timestamp / ask the user which is current before picking one): `pine_open({ name })` only loads the source into the Pine Editor, it does **not** add it to the chart. You then have to click the editor's **"Add to chart"** button specifically — it's a distinct button (`title="Add to chart"`) from "Save script" and "Share your script with community", positioned just right of the editor's script-name dropdown. `pine_smart_compile`'s auto-button-detection can pick "Pine Save" instead if the editor thinks the script is unmodified — don't trust `study_added` from that tool for this flow; verify with a follow-up `chart_get_state` instead. Find the exact button coordinates via `ui_evaluate` (query buttons by `title` attribute in the top ~200px of the editor pane) rather than guessing screenshot coordinates, since the DOM button positions are stable even when screenshot pixel-scaling isn't.

### Watchlist selection mechanics (why stale symbol lists happen)

Scans resolve each watchlist's members by selecting it in the TradingView panel and reading the rows; if that fails they **silently fall back to the baseline's stored symbol list** — so a broken `watchlist.select()` freezes memberships at whatever was last captured, with no visible error (this shipped alerts for symbols removed from the list weeks earlier). The full sync cadence is twice daily (first scheduled scan after 9:15 AM ET, first at/after close, tracked in `status/watchlist-sync-state.json`) plus a live per-watchlist read on every scan and a full seed on every dashboard "Run Scan Now". Hard-won mechanics in `src/core/watchlist.js` if this breaks again:

- The list-picker dropdown opens via `[data-name="base-watchlist-widget-button"]` — the older `watchlists-button`/aria-label selectors click the wrong element in current TV builds.
- The dropdown only shows **recently-used** lists. Items there don't respond to synthetic MouseEvents; measure the item's rect page-side and deliver a **real CDP mouse click** at its coordinates.
- Every other list is only reachable via the **Shift+W "Open list…" dialog**, whose "Search lists" input is auto-focused on open. Its rows respond to **neither synthetic nor real coordinate clicks** — the only working automation is keyboard: CDP `insertText(name)` to filter → `ArrowDown` → `Enter`.
- Verify success by polling `getActiveName()` (the widget button's text) — never trust that a click/Enter "worked".

### Push notifications (ntfy) — gating and failure visibility

- Notifications only fire when `runSignalJob` runs with `notify: true`. Only the real scheduled path sets that (`run_signal_job.ps1` → `run_signal_job.js --notify`) — every manual/dashboard-triggered scan (`/api/run-cron-now`, direct `runBrief` calls) explicitly passes `notify: false`, so ad-hoc testing/debugging can never leak a push.
- Eligibility (`notify_signal_lines` in `src/core/morning.js`) requires `entry.trade?.signal === 'OPEN'` — the confirmed Strategy Tester trade-table read, not the unreliable `Position: Long/Short` label — plus `isRecentTradeSignal`/`isSameTradingDay` (same ET calendar day, entry within ~4 bars). This makes the notify path stricter than the raw Open Trades table, which is why the false-positive open-trade bug above never produced a spurious push.
- The POST to `rules.ntfy.url` logs on failure (non-2xx response or fetch error) instead of swallowing it — check the console output / `signal-scan.log`. `run_signal_job.ps1` captures the job's stderr into `signal-scan.log` via a temp-file redirect (`2>$stderrFile`), not `2>&1` — this script has `$ErrorActionPreference = 'Stop'`, and `2>&1` on a native exe in PS 5.1 can turn a stderr line into a terminating error that aborts the whole script.
- To validate the wiring live without waiting for a real signal: POST directly to `rules.ntfy.url` with `Content-Type: text/plain` and `Title`/`Priority` headers (same shape as the real call) and confirm HTTP 200.

### TradingView price-alert create/delete — the real request schema (reverse-engineered)

`pricealerts.tradingview.com/create_alert` looks like a normal REST endpoint (it returns structured JSON, not a CORS failure, for almost any request body), which made a wrong payload shape look like an auth/transport problem for a long time. It is neither — it's a plain HTTPS POST from the page's own `fetch()`, not a WebSocket RPC (a private pub/sub WS channel does carry the resulting `alerts_created`/`alerts_updated` broadcast, which is a red herring if you go looking for the create request there instead). The real schema, captured 2026-07-23 via CDP `Network.requestWillBeSent` while manually creating+deleting one alert in the **Desktop app** (the CDP session only attaches to that target — testing in the TradingView web browser instead produces total silence, no events at all):

- **Create**: `POST https://pricealerts.tradingview.com/create_alert` — no query params needed. `Content-Type: text/plain;charset=UTF-8` (required — `application/json` triggers a CORS preflight the server rejects outright as "Failed to fetch"; `text/plain` is a simple request and skips preflight while the body is still parsed as JSON server-side). Body:
  ```json
  {"payload": {
    "conditions": [{"type": "cross", "frequency": "on_first_fire",
      "series": [{"type": "barset"}, {"type": "value", "value": 162.76}], "resolution": "1"}],
    "symbol": "={\"adjustment\":\"splits\",\"currency-id\":\"USD\",\"session\":\"extended\",\"symbol\":\"BATS:FAS\"}",
    "resolution": "1", "message": "...", "sound_file": "alert/fired", "sound_duration": 3,
    "popup": true, "auto_deactivate": true, "email": true, "sms_over_email": false,
    "mobile_push": true, "web_hook": null, "name": null, "expiration": "<ISO, ~30d out>",
    "active": true, "ignore_warnings": true
  }}
  ```
  Two things about this are non-obvious and are exactly what the old broken payload got wrong: (1) it's `{"payload": {...conditions array...}}`, not a flat `{type, value}` pair; (2) the encoded-symbol string needs a `session` key — the code that builds it was silently omitting one, and the server accepts the malformed symbol string without complaint but then rejects the whole request as `{"s":"error","err":{"code":"invalid_request"}}` with no indication which field was the problem. Response on success: `{"s":"ok","id":"...","r":{...,"alert_id":<number>,...}}` — `r.alert_id` is the real numeric id, needed for deletion later.
- **Delete**: `POST https://pricealerts.tradingview.com/delete_alerts`, same content-type, body `{"payload":{"alert_ids":[<number>,...]}}`. Response `{"s":"ok","r":null}`.
- Only the `"cross"` condition type is verified live (it fires once regardless of which direction price approaches from, which is exactly what a stop/target level alert wants). `toConditionType()` in `src/core/alerts.js` maps `greater_than`/`less_than` to `"greater"`/`"less"` as a best-effort guess based on TradingView's known alert vocabulary — **unconfirmed**, don't trust it without testing if a caller ever actually needs a one-directional condition.
- `alerts.list()`'s active-count filter (used by `createExcursionAlerts`'s `MAX_ALERTS` quota gate) already filters on `a.active` — long-expired/inactive manual alerts from months earlier don't count against the quota, only genuinely active ones do. Don't "fix" a seemingly-tight quota by raising `MAX_ALERTS` before checking `alerts.list()` output for this distinction.
- `morning.js`'s `drainPendingAlertCleanup()` drains `baseline.pending_alert_cleanup` (populated by `processLevelViolationsAndCleanup` when a trade's signal reads EXIT) by calling `alerts.deleteAlerts({ alert_ids })` for each queued batch — entries that fail to delete stay queued and retry on the next scan rather than being dropped.
