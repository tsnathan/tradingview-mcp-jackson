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

### "Signals Found" badge vs the Current Signal list disagreeing — fixed 2026-07-28

The dashboard's top badges (`Signals: N`, `Changed: N`) and the "Current Signal" list below them used to be built from **two different definitions of "signal"**, which could show a nonzero badge with nothing matching in the list. Root cause: `signals_found`/`changed_signals` (`runBrief()` in `morning.js`) counted an entry as a signal via `entry.signal?.hasSignal && hasSignalChanged(previous, entry.signal)` as a fallback whenever it wasn't a *recent* confirmed OPEN trade — and `entry.signal` is parsed from the strategy's on-chart label **text** (`evaluateSignalFromSnapshot`, around line 340), the same `Position: Long/Short` reading the section above already documents as unreliable/one-bar-ahead. `hasSignalChanged`'s price-comparison arm fires on ordinary price movement, so a position opened days ago with an active label could get counted as "changed" on nearly every scan with nothing new having actually happened. Verified live: 3 counted "signals" were `BATS:EWO`/`WTAI`/`EDC`, all 1–5 days old, none shown anywhere in the list — the list (`buildWatchlistSummaryLines`) only ever displayed *recent* (within ~4 bars, or same trading day) confirmed OPEN trades, correctly excluding them.

Fixed by making the counter match the list's own definition instead of the label-text path:
- `signalEntries` in `runBrief()` now only counts `trade.signal === 'OPEN'` or `'EXIT'` entries that are recent-bar-or-same-day, exactly `buildWatchlistSummaryLines`'s existing OPEN test, extended symmetrically to EXIT.
- EXIT needed a new field to do this correctly: `entry.trade.entryTime` on an EXIT is when the now-closed position originally *opened* (could be days earlier), not when it exited, so recency can't be judged from it. Added `exitTime` to the EXIT branch of `getStrategyPositionState()` in `data.js`, sourced from `reportData()`'s `lastClosedTrade.x.tm` (the same exit-epoch field `trade_log.js` already reads for the closed-trade log — see below). The DOM-scrape fallback path never populates it, so a DOM-sourced EXIT is simply never counted as recent rather than guessed at.
- `buildWatchlistSummaryLines` gained a parallel `recentExits` block and now emits `EXIT: SYMBOL | P&L: ... | AT: ...` rows alongside `OPEN: ...` rows — previously a same-day EXIT had **no display path at all** in this function, and the `createDashboardStatus()` fallback that was supposed to catch that case (`hasExitSignalLines`, checking `signalLines` for literal `SIGNAL: EXIT` text) was dead code: `formatSignalLine()` never actually emits that string (it maps a non-OPEN trade to its bias `direction` — LONG/SHORT/SIGNAL — never the word EXIT). `hasMeaningfulSummary`'s regex was extended to recognize the new `EXIT: \w` lines too.

Verified live post-fix on `Swing 15m`: badge read `Signals: 3, Changed: 0`, and the list showed exactly 3 `EXIT:` rows (`URTY`/`TNA`/`RY`, all same-day) — `Changed: 0` correctly reflects that these exits were already recorded as seen in an earlier scan today, not that nothing happened. This is cosmetic-only to fix — the ntfy push and trade-webhook auto-send paths already independently required `trade.signal === 'OPEN'` *and* same-trading-day (real ground truth) before this change, so nothing was ever mis-notified or mis-executed by the old counting logic; only the badge/list display disagreed.

### Strategy-identity guard (suspend + flag on mismatch, no auto-repair)

`checkStrategyIdentity()` in `src/core/morning.js` runs at the start of every `runSignalJob()` call (scheduled and manual/dashboard-triggered alike) and compares the chart's currently attached indicator names (`chart.getState().studies`) against `rules.json`'s `strategy` field. This exists because it's normal to swap in a different strategy on the chart temporarily (testing, comparison) — if that's still attached when a scan fires, every trade/signal read for that run would silently come from the wrong script with no visible error.

- On mismatch, scanning is **suspended immediately** for that run (same `skipped: true` early-exit path as `schedule.disabled`/outside-market-hours) and the mismatch is written to the status JSON as `strategy_mismatch` (`{ expected, found, detected_at }`), surfaced as a banner in `dashboard/index.html` (`#strategy-mismatch-banner`).
- **There is deliberately no auto-repair.** This was tried and removed: `chart_manage_indicator`'s `add` action calls TradingView's `createStudy(name)`, which can only add **public/built-in** indicators by exact name — it cannot restore a private saved script. Live-tested against this project's real configured strategy (`"Swing Profile Strategy [BigBeluga]"`, a private script customized with a trailing-stop exit): `createStudy` silently returned zero studies added. An auto-repair attempt here would either fail silently (as observed) or, worse, resolve to some unrelated public script sharing the same title. Suspend-and-flag is the only safe automatic behavior; restoring the correct indicator is a manual step.
- **To manually restore a private/custom strategy** (this account has more than one saved script titled `"Swing Profile Strategy [BigBeluga]"` — check `pine_list_scripts` and match by `modified` timestamp / ask the user which is current before picking one): `pine_open({ name })` only loads the source into the Pine Editor, it does **not** add it to the chart. You then have to click the editor's **"Add to chart"** button specifically — it's a distinct button (`title="Add to chart"`) from "Save script" and "Share your script with community", positioned just right of the editor's script-name dropdown. `pine_smart_compile`'s auto-button-detection can pick "Pine Save" instead if the editor thinks the script is unmodified — don't trust `study_added` from that tool for this flow; verify with a follow-up `chart_get_state` instead. Find the exact button coordinates via `ui_evaluate` (query buttons by `title` attribute in the top ~200px of the editor pane) rather than guessing screenshot coordinates, since the DOM button positions are stable even when screenshot pixel-scaling isn't.

### Closed-trade log (`src/core/trade_log.js`) — and why the Strategy Tester's headline stats lie

`scanSymbol()` calls `tradeLog.logClosedTrades()` on every scan, harvesting the full closed-trade history from `reportData().trades[]` into `trade-log/trades-<tf>.csv` (one file per timeframe, deduplicated by `ticker|tfLabel|entry_time_ms`). `scripts/backfill_trade_log.js` walks the whole watchlist universe for a one-time seed; `scripts/analyze_trade_log.js` reads it back.

**The reason this exists is a real measurement trap, not a nice-to-have.** `performance.all.profitFactor` and `percentProfitable` count only *closed* trades — a still-open loser contributes `$0` to `grossLoss`. Verified live on `BATS:WQTM|1D`: `profitFactor: 105.5`, `percentProfitable: 0.8`, `grossLoss: 34.79`, `numberOfLosingTrades: 1` — while that same symbol carried an open position at roughly **−$2,337**. Any strategy that exits winners and lets losers ride reads as near-perfect through this lens, and the distortion scales with how many positions are open. Never rank symbols or timeframes on `profitFactor`/`percentProfitable` straight from `reportData()`. Use either the CSV log (realized-only, honest denominator) or `netProfitPercent + openPLPercent` versus `maxStrategyDrawDownPercent`.

Trade-object field map (confirmed live 2026-07-24 on `AMEX:DUSL|60`), all of it now logged:

| Field | Meaning |
|---|---|
| `e` | entry — `{c: signal name, p: price, tm: epoch ms, b: bar index, tp: 'le'/'se'}` |
| `x` | exit — same shape, `tp: 'lx'/'sx'` |
| `q` | quantity · `v` position value at entry · `cm` commission |
| `tp` | trade profit `{v: USD, p: fraction}` · `cp` cumulative profit |
| `rn` | run-up / MFE `{v, p}` · `dd` drawdown / MAE `{v, p}` |

`e.c` / `x.c` are the strategy's own signal names (`"Swing Low"` → `"Flip Short"`) — the only available answer to "is the trailing stop actually firing, or does everything exit on a signal flip?". `x.b - e.b` gives exact bars held. All `.p` fields are **fractions** (0.0387 = 3.87%); `trade_log.js` scales them ×100 on write, so CSV percent columns are already in percent units.

Three invariants worth preserving if you touch this:
- **The open trade is never logged.** It's the last `trades[]` element when `totalOpenTrades > 0` and carries a synthesized mark-to-market exit row that moves with every bar — logging it would write a fabricated exit price, then never match on dedupe.
- **`rule_type` is part of the dedupe key, not just a column.** It records which exit-rule variant produced a trade (`flip-only`, `ts60`, `ts60-losing`, `sl-auto`, `sl12.0`, `ts60+sl-auto`, `unknown`), derived by `ruleTypeFromInputs()` from the strategy's **live input values** read off the chart — never from `rules.json`, because the toggles are set by hand on the chart and config would drift. If it were only a column, any trade a new rule did *not* alter would collide with its `flip-only` baseline row and be dropped on dedupe, leaving the comparison run holding only the trades that changed — the most biased possible sample. Because of this the logs are deliberately append-only across variants: one set of files holds every regime, separable by this column, and no separate directory per experiment is needed. Input titles carry leading spaces for indentation in TradingView's settings panel (`"    Bars in trade"` — confirmed live), so every lookup is trimmed; unreadable inputs yield `unknown` rather than a guess.
- **Nothing that varies with account state belongs in the key, and `existingKeys()` recomputes rather than reading the stored column.** Quantity used to be in the key (to separate margin-call rows sharing an entry timestamp). When `default_qty_value` went 100 → 95, sizing shifted qty on every trade, so every already-logged trade hashed differently and a single 4H watchlist rescan appended **285 duplicate rows** — verified identical trades, `pnl_pct` matching to 6 decimals, only qty differing by exactly 0.95. Exit time already separates margin calls without it (all 88 such rows have `entry_time_ms === exit_time_ms`, closing on their own entry bar), and all 1,485 rows were unique without qty. `existingKeys()` therefore derives each row's key from its own columns via the same `tradeKey()` the write path uses, so a future key-format change can never desync from stored rows or need a migration. Corollary worth its own line: **the CSV `trade_key` column is a convenience, not the source of truth for dedupe.**
- **Restart the dashboard server *before* scanning after touching `trade_log.js`, not after.** The server holds `trade_log.js` in memory (see the hot-reload note above). Normalizing the CSVs to a new key format and then triggering a scan against a server still running the old key code is the exact sequence that produced the 285 duplicates — the stale process wrote old-format keys against freshly normalized files, so every row missed. Scheduled scans are immune (`run_signal_job.js` is a fresh process each run); only the long-lived server is stale. Also note `/api/run-symbol-scan` seeds and sweeps the whole watchlist for that timeframe, not just the symbol named in the request.
- **`logClosedTrades()` verifies the chart's actual symbol/resolution before writing** (`verify: true` by default). A scheduled scan navigating the chart mid-call would otherwise file one symbol's trades under another's ticker, and bad rows are far harder to recover from than a skipped scan. Trades with no `e.tm` are skipped rather than given a substitute key.

**Every consumer of the log filters by variant, and pooling must stay opt-in.** `readAllTradeLogs({ ruleType })` is the chokepoint — `buildEdgeAnalysis`, `simulatePortfolio`/`sweepMaxPositions`, the `/api/edge-analysis` and `/api/portfolio-sim` endpoints (`?rule=<variant>`, `?rule=all`), the dashboard's Exit-rule chip row (shared state across both tabs, so they can never describe two strategies at once), and `analyze_trade_log.js` (`--rule`, `--rules`) all thread it through. Anything omitting the option pools every variant, which is right for inventory/coverage questions and wrong for every performance question; the default everywhere is therefore the **most-traded variant**, not `all`. `listRuleTypes()` is the inventory. One caveat that cannot be fixed inside the analysis layer: `openBySymbolTf` (open P&L, max drawdown) comes from `status/strategy-perf.json` written by the *current* chart state, so pairing it with a historical variant's closed trades mixes regimes — the resolved `ruleType` is surfaced in both tabs so the numbers are never unlabelled.

**Set exit-rule toggles in the settings dialog by hand — `indicator_set_inputs` does not reach the Pine engine, and the input properties are not proof of what ran.** Verified live 2026-07-25 on `AMEX:TMF|240`: `indicator_set_inputs({in_15:true})` (Time Stop) returned `updated_inputs:{in_15:true}`, and reading the property back through `metaInfo().inputs` → `properties().childs().inputs` confirmed `true` — while the strategy kept executing with it **false**. Proof it never took effect: 9 trades held past the 60-bar threshold (longest 236 bars) with zero `Time Stop` exits, and the script's own diagnostic label still reading `Exit rules: flip only`. A subsequent call setting it back to `false` matched nothing (`updated_inputs:{}`) even though the study resolved, so the state could not be reverted programmatically either. `indicators.js` uses the documented `study.getInputValues()`/`setInputValues()` pair, so this is not an obvious omission on our side. A symbol change — a full recompute — did not reconcile it.

Consequences, both important:
- **The on-chart diagnostic label is the only trustworthy record of the rule set in force**, because the script writes it during evaluation. `readAllTrades()` therefore also captures it (`runtimeExitRules`, parsed from `Exit rules: …`) and `reconcileRuleType()` compares the two on/off booleans against the property-derived rule type, downgrading to `unknown` with a console warning on disagreement rather than picking a side — a mislabelled variant silently merges two regimes inside what looks like a clean A/B sample, which nothing downstream could detect afterwards. Only the booleans are compared: the label prints the *effective* stop percent and cannot distinguish `sl-auto` from a manual level.
- Reading that label from the raw primitive map has **two traps**: `_primitivesDataById` is a `Map` (so `for..in` silently yields nothing), and the text is the **`t`** field — `text` exists only on the normalized shape the `data_get_pine_*` tools return. Both cost a debugging cycle here.

To confirm a toggle actually applied, read the label (`data_get_pine_labels`) and check the `Exit rules:` line — never the checkbox or the property.

Note that `flip-only` legitimately describes two builds: the pre-toggle script, and the toggled script with both switches off. Exit behaviour is identical, but the sizing fix that ships alongside the toggles (`default_qty_value` 100 → 95) makes post-deploy rows compound slightly slower than `pnl_pct` alone implies, and stops producing margin-call rows.

### Backfill hazards: leaked CDP sockets and partially-loaded history

Three failures found on 2026-07-25, each of which silently produced *plausible but wrong* data rather than an error:

- **`backfill_trade_log.js` leaked its CDP connection and never exited.** The script finished its walk, printed `Done.`, and the task runner reported exit 0 — but the open socket kept the event loop alive, so the process lived on as a zombie. Eight accumulated across one session; a later run then produced **no output at all** (not even its first log line) until they were killed, apparently starved of a usable CDP session. The script now calls `disconnect()` then `process.exit()`. If a backfill ever appears to hang with an empty output file, check `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` for stale `backfill_trade_log` processes first — and never run backfills in parallel, only sequentially.
- **Reads can land before TradingView finishes loading bars.** The strategy backtests whatever is loaded at that instant, so an early read returns a *truncated* history that writes as valid rows. Measured: the original daily seed captured `NVDA|1D` as **one trade spanning two weeks** where a later read returned **ten trades spanning seven years**; 11 of 26 daily tickers were short this way. This invalidated an entire variant comparison — the truncated baseline read as a strategy difference. `readStableTrades()` now polls (up to 6 × 900ms) until trade count and span endpoints repeat before writing, and sets `unstable_history` when they never settle. Daily needs far more wall-clock than intraday, so a flat sleep cannot be tuned once and trusted.
- **Suspect any variant comparison where position counts differ.** Under a pyramid variant each tranche is its own row in `trades[]`; under `flip-only` one position is one row. Comparing raw row counts conflates "more positions" with "more legs per position". Cross-check ticker sets *and* earliest-entry dates between variants before trusting any A/B result — a difference in either means you are measuring data capture, not strategy behaviour.

### Portfolio simulation: merge pyramid tranches before allocating slots

`simulatePortfolio()` calls `mergePositionTranches()` first, grouping rows by ticker + timeframe + exit timestamp (every leg is closed by the same flip). Without it each tranche consumed its own slot, which understated fill rate by ~10 points and doubled per-symbol concentration; it also misread returns badly — one real 4H position had a base leg at **−2.08%** and its add at **+18.84%**, a net winner scored as one loser plus one winner. Returns are notional-weighted (`qty × entry price`).

The other half is `sizeFactor`: the Pine script sizes the base leg at `95/(1+addFrac)` so base+add together reach the same ~95% a flip-only entry uses, meaning a position whose add never fires deploys only `1/(1+addFrac)` of its allotment. Since adds fire on only ~15% of positions, ~85% carry a dead 20% cash reserve — measured as an 8-point drop in average deployed capital, and the dominant reason pyramid loses at portfolio level despite winning on per-trade expectancy on some timeframes. Crediting those positions as fully deployed would invent returns on money never at risk.

### Pyramid add trigger: fixed pooled level vs per-symbol MAE

The add trigger has two modes, selected by the `Add trigger` input, and they are different enough that the mode is part of `rule_type` (`pyr25` vs `pyr25mae75`) — pooling them would average two regimes with a 3× difference in how often the add ever fires.

- **Fixed per timeframe** (original) reuses `autoStopPct()`, which is the **95th percentile of _winners'_ adverse excursion pooled across all symbols** — a tail level, not an average, and not per-symbol. Measured at 15m, per-symbol average MAE spans **0.75% (EWO) to 5.87% (MEXX)**, so a flat 6% sits beyond the entire MAE distribution of half the watchlist: only **15.2%** of positions ever touched it. The other ~85% carried the add's idle 20% cash reserve for nothing, which is the mechanism behind pyramid's portfolio-level loss.
- **% of symbol MAE** tracks each symbol's own realised MAE in-script and triggers at `pyrMaePct%` of it (default 75) → **50.7%** fill rate at 15m.

The tracker (`pyrMaeSum`/`pyrMaeCount` in `src/strategy.pine`) deliberately does **not** use `strategy.closedtrades.max_drawdown_percent()`. Three reasons, each of which silently corrupts the statistic:
- A flip goes long→short **without `position_size` ever reading 0 on a bar boundary**, and flips are this strategy's dominant exit — detecting position close by `position_size == 0` misses nearly every trade. Closes are detected by **sign change**.
- Closed-trade indices list each pyramid **tranche** separately, so a stat built from them mixes short-lived add legs into what is meant to be a base-entry statistic. Tracking the live position sidesteps it.
- Excursion is measured from the position's **first** entry price, not `position_avg_price` — an add moves the average, and measuring against a yardstick the add itself shifted understates the very dip that triggered it.

**Result (15m, 2026-07-25): the mechanism worked and the strategy still didn't.** Add fill rate went 19.9% → 41.6% exactly as designed, and average deployed capital rose ~1-2 points — but matched-ticker expectancy was 1.50% vs flip-only's 1.60% (pyr25 was 1.48%), and portfolio CAGR/DD stayed at 1.8-6.6 against flip-only's 7.4-15.2 with roughly 3× the max drawdown. The diagnostic that explains it: positions where the add **fired** returned **+0.10%** while positions where it did **not** returned **+3.21%** (under `pyr25`: −1.25% vs +2.80%). The adaptive trigger genuinely improved the fired cohort by ~1.35 points — adding on a shallower dip catches recoverable ones rather than only the deep ones — but it also doubled how many positions joined that cohort, so the two effects cancel. Adding size on an adverse move means adding size to the worse-selected half of the book; no trigger level fixes that, because a shallow enough trigger to escape the selection just makes the add unconditional (i.e. leverage, not pyramiding). Treat the pyramid family as closed unless the entry rule itself changes.

Only positions closed *before* the current bar contribute, so there is no lookahead; until `pyrMaeMinTrades` (default 3) have closed, the fixed level is used and the label prints `WARMUP`. Warmup is not free: 15m symbols carry only 9-22 closed trades in the backtest window, so a high threshold leaves most of the sample running the fixed rule and dilutes the comparison. Note also that the level is measured under the pyramid regime it controls — self-consistent, but it drifts as trades close, so the label's printed level is the *final* one, not the one every trade saw.

### Ranking symbols: use expectancy, never CAGR/DD (measured, not assumed)

Walk-forward test on 2H+4H `flip-only` (rank each symbol on the first half of its own history, score it on the second half, Spearman rho, n≈48 symbol-halves):

| in-sample metric | rho vs OOS expectancy | | rho vs OOS expectancy |
|---|---|---|---|
| **expectancy** | **+0.381** | winRate | −0.018 |
| totalReturn | +0.225 | sharpe | −0.133 |
| perDay | +0.139 | **cagrDd** | **−0.145** |
| cagr | +0.092 | profitFactor | −0.168 |

Signs held across all 9 combinations of min-trades (6/8/10) × split point (0.4/0.5/0.6). **The ratio metrics rank slightly worse than random.** Max drawdown over 5-12 trades is essentially the worst single trade — near-pure noise that mean-reverts — so dividing by it ranks symbols by how lucky their worst trade was. Same mechanism for profit factor and Sharpe. cagrDd remains correct for a whole **portfolio** equity path (`renderPsSweep`'s slot sweep still uses it, rightly); it is unfit only for ranking individual symbols on a dozen trades.

Two consequences wired into the code, both easy to undo by accident:
- `buildEdgeAnalysis` sorts by `expectancyPct` with unrankable symbols (`RANK_MIN_TRADES` = 8) pushed to the bottom, and the dashboard's Keep/Watch/Drop verdict is a **within-timeframe percentile** (`expPercentile`), not an absolute cutoff. Expectancy scales hard with timeframe (15m ~1.7%/trade vs 4H ~7%), so any fixed threshold tags all fast rows weak and all slow rows strong.
- Both biases are real and opposite: cagrDd's old top-10 was almost entirely 15m-1H (one pick earned 0.57%/trade), while raw expectancy would return an all-4H/1D list. Only **2 of 20** symbols overlapped between the old and new top-20. Anything ranking across timeframes (the Portfolio Sim "top 20" picker) must therefore use `expPercentile`, not raw expectancy.

**Ranking is a filter, not a priority.** Walk-forward on 2H+4H: reordering which signal to take when several fire barely moved anything (13.7→13.7, 37.1→39.3, 108.4→121.4 CAGR), because simultaneous signals are rare. Dropping the bottom half by past expectancy moved a lot — but only when capacity-constrained: at **5 slots** (fill 39-50%) it helped in **5 of 5** split points (+6.1 to +91.7 CAGR); at **10 slots** (fill 66-80%) it was 3 of 5, twice materially negative (−8.7, −38.7). Selection only pays when you are turning signals away; above ~65% fill it mostly just removes trades. Check fill rate in Portfolio Sim before filtering anything. (CAGR *levels* in that test run 100-200% — short windows, heavy compounding — so trust the deltas, not the magnitudes.)

### Hold period is calendar days, not bars — and always report median alongside mean

`edge_analysis.js` exposes `avgHoldDays`/`medianHoldDays` per symbol, per timeframe rollup, and pooled across the whole watchlist at the top level, all derived from `exit_time_ms - entry_time_ms`. Deliberately **not** based on `bars_held`: 60 bars is 15 hours at 15m and 60 calendar days at 1D, so a bar count answers a different question than "how long is capital tied up," which is the same question the portfolio simulator's time-weighted capital-utilization metric answers at the whole-portfolio level. Margin-call rows are left in, same as every other stat in `basicStats()` — they're a real (if degenerate) ~0-day holding, not filtered elsewhere in that function.

The distribution is right-skewed enough that mean alone misleads: on `flip-only|1D`, BE's winners average 64.9 days held against losers' 142.5 — no stop exists in the baseline, so losers ride far longer than winners, and a handful of those drag the mean well above the median. Always show both; the dashboard's `fmtHold()` switches units (hours under 1 day, days under 30, months beyond) because the range spans both ends across timeframes.

### `expectedPct`: CAGR's non-compounding sibling — added 2026-07-28

CAGR compounds the observed multiple to the power of `1/years`, where `years` is the calendar span from first entry to last exit (mostly idle time for a sparsely-traded symbol). Over a short or sparse span that exponent turns a modest run into a headline number the trade-by-trade record doesn't support — e.g. `KORU|3H` (flip-only) showed a CAGR of 3584.8% off 13 trades. The user's framing: "for a given timeframe, avg number of trades × a year factor will be a better measure" — i.e. use the symbol's own trade cadence, not compounding, to project a year.

`edge_analysis.js`'s `buildEdgeAnalysis()` now computes it per symbol as `expectancyPct * (365.25 / avgHoldDays)` — average return per trade × how many such trades would fit in a year back-to-back at this symbol's own average hold period. No compounding anywhere. Same `KORU|3H` row: CAGR 3584.8% vs Expected 422.4% — still a rich number, but one a reader can sanity-check against the 13 actual trades instead of an exponent. The two metrics are **not** a "toned down vs. real" pair — they can diverge in sign: `KORU|1D` showed CAGR ≈ −1% (a couple of bad losers crushed the compounded path) against Expected ≈ +47.6% (the average trade was solidly positive; Expected doesn't see path-dependency). Both numbers are real, they answer different questions — CAGR is the compounding-portfolio-equity lens, Expected is the trade-frequency lens — and the dashboard shows both side by side (Symbol Ranking table, Timeframe Comparison table, Symbol Lookup's per-timeframe stats) rather than picking one. `avgHoldDays == null` or `0` (no trades with a valid entry/exit pair) yields `expectedPct: null`, never a divide-by-zero.

### Watchlist selection: "drop symbols with DD > X%" doesn't work — tested and rejected 2026-07-25

A per-symbol max-drawdown cap (e.g. "keep only DD < 30%, rank survivors by CAGR/DD") looks like a sensible risk screen. Walk-forward tested (rank on first half of each symbol's history, score the second half, 2H+4H `flip-only`) and it fails on both halves independently:

- **In-sample maxDD does not predict out-of-sample maxDD** (Spearman rho 0.082 — noise). A symbol's historical DD over 6-12 trades is mostly its single worst trade, same defect as ranking by CAGR/DD (see above).
- **It actively inverts on expectancy** (rho +0.495): the highest-DD quartile *outearned* the lowest-DD quartile out-of-sample on both timeframes (4H: Q1 0.7%→OOS 4.54% vs Q4 39.6%→OOS 11.38%). This is a momentum strategy on leveraged/volatile instruments — the volatility that produces the drawdown is the same volatility that produces the edge, so screening one out screens out the other. Concretely, a DD<30% cap on 4H removes `SOXL, PILL, MEXX, TNA, MIDU, AMDL` — average expectancy of the removed group (7.11%/trade) is *higher* than the kept group (4.96%/trade).
- **At portfolio level it loses on both axes it's meant to protect**: walk-forward at 10 slots, the filtered portfolio returned *less* CAGR *and* higher max drawdown than trading the full watchlist (4H: 60.8%/3.4% filtered vs 112.3%/2.2% unfiltered). Portfolio drawdown is driven by how many positions lose *simultaneously*, which a per-symbol screen cannot see — cutting the watchlist only removes diversification.

Conclusion: don't screen the watchlist by any per-symbol drawdown or ratio metric. If capacity is genuinely constrained (fill rate materially under ~50%, check Portfolio Sim first), trim by **expectancy percentile within timeframe** — the same ranking `edge_analysis.js` already uses — not by a DD cap. At the fill rates this watchlist actually runs (73-96% across 2H/4H at 10 slots), there's no capacity problem to solve by trimming at all.

### Slot contention: evicting the worst open position for a new signal isn't buildable honestly, and the reason it looks good is the reason it wouldn't work

Tested 2026-07-25. At 15 slots on 2H+4H `flip-only`, **33% of signals are turned away for lack of a slot, and 96% of those would, in hindsight, have out-earned the single worst-held position** (`contention.wouldBeatPct` in `portfolio_sim.js` — a pure retrospective comparison of two already-known final outcomes, needs no fill simulation, always computed regardless of `evictPolicy`).

Acting on that requires knowing a position is a loser before it closes, which the trade log cannot supply — it stores each position's final entry/exit price and MAE/MFE only, no bar-by-bar path. `evictPolicy: "oracle-worst-final"` exists as upper-bound tooling to test whether the idea is even worth pursuing: it decides using the open position's already-known FINAL `pnl_pct` (available immediately since a position in this simulator IS its closed trade-log row from the moment it "opens") and fills the early exit via straight-line interpolation of that final result over elapsed calendar time — a stand-in for a real intrabar mark, verified by hand against a real MEXX/TNA overlap (a −12.2% eventual loss, evicted 30% of the way through its natural hold, correctly priced at −3.7%).

**The result is dramatic and specifically not real**: CAGR 29.6% → 77.2%, max drawdown 9.6% → 2.2% at 15 slots (bigger at fewer slots: 5-slot CAGR/DD goes 2.55 → 111.96). The oracle wins by cutting long losing trades short **before they finish losing** — exactly the mechanism the real Stop Loss variant already tried and lost with (see the Stop Loss section above): longs recover a long way from their worst point on average (13.4% adverse excursion vs. −2.5% final), so a rule that can't tell "temporarily down" from "doomed" cuts far more recoverable trades than terminal ones. The oracle's edge is entirely foreknowledge that has no honest equivalent. **Do not read the oracle CAGR as an achievable number**, and do not build the bar-level OHLCV engine a real version would need — the Stop Loss result is already strong evidence a realistic version fails the same way.

One caught-and-fixed bug worth remembering if this is touched again: `taken[]` (the record win rate/profit factor/per-symbol P&L are built from) is created at ENTRY time carrying the position's full final result. An eviction must overwrite that record (`pos.takenRef`, added for exactly this) with the interpolated partial actually realized — the cash/equity side already had it right, but the secondary stats didn't until this was found by reconciling `perSymbol` P&L against `finalEquity` by hand.

### Watchlist selection mechanics (why stale symbol lists happen)

Scans resolve each watchlist's members by selecting it in the TradingView panel and reading the rows; if that fails they **silently fall back to the baseline's stored symbol list** — so a broken `watchlist.select()` freezes memberships at whatever was last captured, with no visible error (this shipped alerts for symbols removed from the list weeks earlier). The full sync cadence is twice daily (first scheduled scan after 9:15 AM ET, first at/after close, tracked in `status/watchlist-sync-state.json`) plus a live per-watchlist read on every scan and a full seed on every dashboard "Run Scan Now". Hard-won mechanics in `src/core/watchlist.js` if this breaks again:

- The list-picker dropdown opens via `[data-name="base-watchlist-widget-button"]` — the older `watchlists-button`/aria-label selectors click the wrong element in current TV builds.
- The dropdown only shows **recently-used** lists. Items there don't respond to synthetic MouseEvents; measure the item's rect page-side and deliver a **real CDP mouse click** at its coordinates.
- Every other list is only reachable via the **Shift+W "Open list…" dialog**, whose "Search lists" input is auto-focused on open. Its rows respond to **neither synthetic nor real coordinate clicks** — the only working automation is keyboard: CDP `insertText(name)` to filter → `ArrowDown` → `Enter`.
- Verify success by polling `getActiveName()` (the widget button's text) — never trust that a click/Enter "worked".

### Dashboard "Watchlist Symbols" panel going blank is a display bug, not a seeding failure — fixed 2026-07-28

Diagnosed after the panel showed "0 watchlist(s) / No watchlist data available yet" the same day the user had edited a watchlist's membership in TradingView, which looked exactly like the seeding failure the section above describes. It wasn't: `swing-signal-baseline.json`'s `watchlists` had fresh, correct symbol lists (`source: "data_attributes"`, a genuine live read) from that morning's sync. The bug was purely in what the dashboard displayed.

Root cause: the full live resync (`syncWatchlistSymbolsFromTradingView()`) only runs once or twice a day (gated by `status/watchlist-sync-state.json`'s open/close dates — see above), so `result.watchlist_sync` was `[]` on every OTHER scan that day. `writeLatestStatus()` overwrites the *entire* status file every run, so that empty array clobbered whatever the sync scan had written minutes earlier. The panel showed real data for roughly the 15-minute window between a sync scan and the next regular one, then went blank for the rest of the day — every single day, for as long as this code existed, which is why it read as "seeding failed today" despite the underlying data being fine.

Fixed by `buildWatchlistSyncFromBaseline()` in `morning.js`: when the current scan didn't run a live resync, `result.watchlist_sync` is now built from the persisted `baseline.watchlists` instead of left empty — same data the "why stale symbol lists happen" section already establishes as the real source of truth, just also used for display now instead of only for scanning. Two smaller bugs fixed alongside it, both harmless but worth knowing: the live-sync path never included `timeframe` in its `synced` array (the panel always showed "TF ?" even when data was fresh), and the dashboard's `sourceLabel` map only recognized 3 old values (`tradingview_panel`/`rules_fallback`/`watchlist_unavailable`) — `data_attributes` and `text_scan` (the two `watchlist.js` actually returns on a successful live read, see below) fell through to an unstyled raw-string badge instead of the green "Live from TradingView" one.

**If the panel goes blank again, check `swing-signal-baseline.json`'s `watchlists` field directly before assuming a seeding failure** — that file is the ground truth; the dashboard is just a view over it.

### Trade-log orphan detection — bundled with reconciliation, archiving stays manual (2026-07-28)

`scripts/archive_trade_log.js --orphans` (see the "Closed-trade log" section above) already existed to move a dropped symbol's history into `trade-log/archive/` so it stops skewing Edge Analysis/Portfolio Sim — but nothing ever reminded anyone to run it, so orphans (e.g. `DXYZ`, fully removed from every watchlist) sat in the active log unnoticed.

`findWatchlistOrphans(baseline)` in `trade_log.js` is the read-only detection half: diffs tickers present in the active (non-archived) trade log against `baseline.watchlists` membership, exchange-prefix-insensitive. `morning.js`'s `runSignalJob()` calls it right after a **real** watchlist reconciliation (`syncResult.synced.length > 0` — the twice-daily open/close sync, not every 15-min scan) and persists the result onto `baseline.trade_log_orphans` via a direct field patch (same `parseJsonFile`/`writeJsonFile` pair `syncWatchlistSymbolsFromTradingView` already uses), then surfaces it as `result.trade_log_orphans` → `createDashboardStatus()`'s `tradeLogOrphans` field. **Deliberately persisted, not left empty on non-sync runs** — the exact same reasoning as `buildWatchlistSyncFromBaseline` above: `writeLatestStatus()` overwrites the whole status file every run, so an in-memory-only value would flicker to empty between reconciliations.

**Detection is automatic; archiving is not.** The dashboard (Open Trades card) shows a banner listing orphaned tickers with trade counts/timeframes and an "Archive Now" button, confirm-gated, that POSTs to `/api/archive-orphans` — which shells out to the *exact same* `archive_trade_log.js --orphans` CLI script via `spawn` rather than reimplementing its row-moving logic, guarded by the server's `runExclusive` lock (a live scan appends to the same CSVs this rewrites in full; overlapping read-modify-write could drop an appended row). On success the endpoint recomputes and directly patches both `baseline.trade_log_orphans` and the status file's `tradeLogOrphans` so the banner clears immediately rather than waiting for the next reconciliation.

This was a deliberate choice over full auto-archiving on the reconciliation path itself, even though the action is reversible (`--restore`): it mirrors the precedent already set by the strategy-identity guard above ("suspend and flag, no auto-repair") — an automated job silently rewriting trade-history CSVs off a watchlist read that has a documented history of occasionally failing/falling back (see "Watchlist selection mechanics" above) is a worse failure mode than a banner that's one confirm-click away from doing the same thing correctly. User confirmed this tradeoff explicitly when it was proposed.

### TradingView alert orphan cleanup — the `excursion_alerts` twin of the trade-log orphan check (2026-07-28)

Same root cause as the trade-log orphans above, different consequence: `createExcursionAlerts()` creates real TradingView price alerts (stop/target pairs) for open positions and records them in `baseline.excursion_alerts`; `processLevelViolationsAndCleanup()`'s EXIT-driven pass deletes them once a scan observes that position closing. But that pass only runs for entries actually present in a scan's `results` — a symbol/timeframe dropped from its watchlist before (or without) that ever happening leaves the alert with **no path back to cleanup at all**. It just sits active on TradingView until it self-fires or hits its ~30-day expiration.

Confirmed live before the fix (`baseline.pending_alert_cleanup` had never once been populated in this project's history): `TSLA|1D` and `USO|60`/`EDC|60` (dropped from their watchlists) carried 6 active, never-fired alerts with no way to ever clean them up, and `MU|30`'s stop-side alert had already self-fired hours earlier, completely unnoticed, because `MU|30` hadn't been scanned since dropping out of "Swing 30m".

`findOrphanedExcursionAlerts(baseline, watchlistNames)` in `morning.js` is the detection half — diffs `excursion_alerts` keys (`SYMBOL|rawTimeframe`) against current watchlist membership, exchange-prefix-insensitive, mirroring `findWatchlistOrphans`. Wired into `processLevelViolationsAndCleanup()`, which already runs unattended on every scan: orphans with a real `alert_ids` array get queued into the existing `pending_alert_cleanup` (the same mechanism the EXIT-driven pass uses) so `drainPendingAlertCleanup()` — already unconditional, no confirm-gate, since deleting a stale price alert touches no capital — deletes them for real on the same run. Local-only orphaned entries (no real alert, just bookkeeping) are deleted directly, nothing to queue.

**A bug in this very fix, caught before it shipped wrong:** `baseline.watchlists` accumulates dead entries under old names forever — nothing ever prunes them on a rename, since `syncWatchlistSymbolsFromTradingView()` only ever iterates `rules.json`'s *currently configured* names. Live example: `"Swing 30min"` (an old name) still sits in the baseline with real symbol data, superseded by `"Swing 30m"`. The first version of `findOrphanedExcursionAlerts` (and, it turns out, the pre-existing `findWatchlistOrphans` too) treated every `baseline.watchlists` key as equally valid — which meant `MU|30` (only ever present under the dead `"Swing 30min"` entry) read as "still in a watchlist" and would have been the one case this fix was built to catch that it *missed*. Both functions now take a `watchlistNames` allowlist (`Object.keys(rules.watchlists)`, threaded through from every call site) and ignore any `baseline.watchlists` entry whose name isn't in it. Verified the fix against real data before and after: pre-fix, `MU|30` was invisible to the orphan check; post-fix, it was correctly caught alongside `TSLA`/`USO`/`EDC`.

All four were drained for real 2026-07-28 (`alerts.deleteAlerts`), confirmed via a live `alert_list` before/after (47 → 39 active-eligible alerts, exactly the 8 alert_ids across the 4 positions). If this needs re-checking: `swing-signal-baseline.json`'s `pending_alert_cleanup` should be empty/absent in steady state — a nonzero, non-shrinking count across multiple scans means `drainPendingAlertCleanup` is failing (check for a `alerts.deleteAlerts` error in the console), not that nothing is orphaned.

### Webhook dedupe key format mismatch — manual Send and auto-dispatch silently used different keys (found + fixed 2026-07-28)

While building the webhook-priority feature below, checking "is this open position webhook-sent" surfaced a real, pre-existing bug: the manual Send button's dedupe key and the auto-dispatch path's dedupe key were built from **differently formatted** entry times for the exact same position, so they never matched each other.

- Manual Send (`dashboard/index.html`'s `webhookSentKey()`) sourced `entryTime` from `status.openTrades` rows — which `buildOpenTrades()` runs through `formatEntryTimeDisplay()` for human display, e.g. `"07/20/2026, 10:30:00 AM ET"`.
- Auto-dispatch (`dispatchTradeWebhooks`/`dispatchExitWebhooks`, fed by `notify_signal_events`) reads `entry.trade.entryTime` straight off the scan result — the raw ISO string from `data.js`, e.g. `"2026-07-20T14:30:00.000Z"`.

`sentKey()` builds `ticker|tag|entryTime` verbatim from whatever string it's given, so the *same logical position* produced two different keys depending on which path sent it. Confirmed live: `TSX_DLY:TD`'s manually-sent 30m position was recorded under the display-formatted key; the auto-exit dispatcher (which only ever computes the raw-ISO form) would never have found it, meaning **the exit side of the feature immediately below would have silently never fired for any manually-sent position** — exactly the case the user's own example (`TD`) is.

Fixed by threading a second, canonical field — `entryTimeRaw` — through every place an open-trade row is built (`buildOpenTrades()`'s three passes, all four row constructions in `buildPriorSignalsByWatchlist()`), carrying the untouched raw ISO value alongside the display-formatted `entryTime`. The dashboard's `webhookSentKey()`/`buildWebhookCell()` and `createExcursionAlerts()`'s webhook-sent check now key on `entryTimeRaw`, matching the auto-dispatch path exactly. The one pre-existing ledger entry recorded under the old display-formatted key (`TD`'s) was migrated by hand to the raw-ISO key so it isn't silently duplicated on a future manual re-send.

**If a webhook-sent check ever looks wrong again**, check whether the row it's reading came from `buildOpenTrades()`/`priorSignalsByWatchlist` (has `entryTimeRaw`) or was constructed some other way (might not) — a `null` `entryTimeRaw` is a real "no reliable key" case, not a bug to route around by falling back to the display string.

### Webhook-sent positions get alert-quota priority, with eviction (2026-07-28)

The account's TradingView alert quota (`MAX_ALERTS = 20` active alerts, in `createExcursionAlerts()`) is shared across every open position, allocated first-come in whatever order `openTrades` happens to iterate — with no relationship to which positions actually have real money on them via the trade-webhook. Confirmed live: `TSX_DLY:TD` had a webhook sent (a real order placed) but only local (scan-interval) monitoring, `"Local alert 15/64"`, because unrelated positions without any webhook activity had already consumed the quota by the time TD's turn came up in the loop.

Fixed with two additions to `createExcursionAlerts()`:
- **`webhookSentKeys`**: built once per call from `openTrades`, using each trade's `entryTimeRaw` (see the key-format fix above — this is precisely why that fix had to land first) through `sentKey()`/`alreadySent()`. `openTrades` is then stable-sorted webhook-sent-first, so those positions are attempted before quota fills up with lower-priority ones.
- **Eviction**: if a webhook-sent trade still hits the quota wall, `findEvictionCandidate()` picks the best non-webhook-sent `created:true` entry from `baseline.excursion_alerts` to sacrifice — **longest timeframe first** (via the existing `timeframeToMinutes()`), since a 1D/4H position loses the least by dropping to local-only monitoring (it was only ever going to be checked once per its own long scan interval anyway; a 15m position would lose far more precision for the same downgrade). The evicted entry's real alert is deleted (`alerts.deleteAlerts`), its baseline entry downgraded to `created:false` with an explanatory `skip_reason`, and `usedSlots` is **re-checked via a fresh `alerts.list()`** rather than assumed — one side of a stop/target pair can already be self-fired-and-inactive, so subtracting the full pair's length would overcount how many active slots the eviction actually freed. Never evicts another webhook-sent position (checked both raw and normalized-ticker key forms).

Verified 2026-07-28: `webhookSentKeys` correctly resolves `TD`'s entry (`alreadySent` → true post-fix), and `findEvictionCandidate`'s longest-timeframe selection picked `BSE_DLY:SBIN|240` (4H) as the top candidate over the remaining shorter-timeframe holders — both checked against real baseline data. Not yet witnessed live mid-eviction: the same-day orphan cleanup above freed enough quota (14/20 active afterward) that TD's next real alert creation won't need to evict anything to succeed.

Also marks the alert message itself: a webhook-sent position's stop/target alerts get `| Open Pos` inserted (e.g. `TD 30m | Open Pos | Stop avg MAE 8.79% | Entry 933.13`), computed from the same `isWebhookSent` check, so a real order is identifiable straight from the TradingView alert list/push notification without cross-referencing the dashboard. Confirmed nothing in this codebase parses alert `message` text back for logic (unlike Pine chart labels, which the signal-detection path does read) — purely a human-facing marker, safe to change format on freely.

**Historical view**: Symbol Lookup's Closed Trades table also shows a `webhook` column per row (`webhookStatusForRow()` in `symbol_lookup.js`), reusing the exact same `sentKey()` computation — trade-log rows already carry `ticker`/`timeframe` in the bare/label form `sentKey()`/`timeframeTag()`/`bareTicker()` are idempotent over, so only `entry_time_ms → ISO` needs converting. Verified the key this produces for a hypothetical closed TD 30m row matches the real, already-migrated ledger key exactly. Shows `✓ entry only` vs `✓ entry+exit` vs `—` (never sent) — a read of what the ledger recorded for that entry, not a live status.

### Push notifications (ntfy) — gating and failure visibility

- Notifications only fire when `runSignalJob` runs with `notify: true`. Only the real scheduled path sets that (`run_signal_job.ps1` → `run_signal_job.js --notify`) — every manual/dashboard-triggered scan (`/api/run-cron-now`, direct `runBrief` calls) explicitly passes `notify: false`, so ad-hoc testing/debugging can never leak a push.
- Eligibility (`notify_signal_lines` in `src/core/morning.js`) requires `entry.trade?.signal === 'OPEN'` — the confirmed Strategy Tester trade-table read, not the unreliable `Position: Long/Short` label — plus `isRecentTradeSignal`/`isSameTradingDay` (same ET calendar day, entry within ~4 bars). This makes the notify path stricter than the raw Open Trades table, which is why the false-positive open-trade bug above never produced a spurious push.
- The POST to `rules.ntfy.url` logs on failure (non-2xx response or fetch error) instead of swallowing it — check the console output / `signal-scan.log`. `run_signal_job.ps1` captures the job's stderr into `signal-scan.log` via a temp-file redirect (`2>$stderrFile`), not `2>&1` — this script has `$ErrorActionPreference = 'Stop'`, and `2>&1` on a native exe in PS 5.1 can turn a stderr line into a terminating error that aborts the whole script.
- To validate the wiring live without waiting for a real signal: POST directly to `rules.ntfy.url` with `Content-Type: text/plain` and `Title`/`Priority` headers (same shape as the real call) and confirm HTTP 200.

### Trade-execution webhook (`src/core/trade_webhook.js`) — the workaround for the 2-alert limit

The TradingView subscription only carries **two** watchlist alerts, and those already POST to the Railway executor directly. Every other timeframe would be ntfy-to-phone plus hand execution, which does not scale at 30m/45m cadence. This module lets the scanner emit the **same payload TradingView would have sent**, so the Railway side cannot tell the difference:

```json
{"symbol":"SOXL","side":"buy","group":"swing","tag":"15m","price":"42.105","secret":"..."}
```

Field semantics are copied from the alert template's placeholders, and getting any of them wrong produces a *valid-looking* order for the wrong thing: `symbol` is the **bare ticker** (`{{ticker}}` drops the exchange, so `BATS:SOXL` → `SOXL`), `side` is **lowercase buy/sell** (`{{strategy.order.action}}`) derived from the trade's own LONG/SHORT — never from `rules.chart.trade_direction`, which is a chart input that can change without this module knowing — and `price` is a **string**, because placeholder expansion produces strings and the receiver already parses that shape.

**Credentials never go in `rules.json` — that file is tracked in git.** URL and secret come from `TRADE_WEBHOOK_URL`/`TRADE_WEBHOOK_SECRET` or from `webhook.local.json` (gitignored); env wins. Only the non-sensitive switches (`webhook.group`, `webhook.enabled_timeframes`) live in rules.json, because the dashboard has to persist those. A missing secret is a hard refusal to send, never a send-without-auth. `/api/webhook-config` returns `hasSecret: true/false` and never the value.

**To configure:** edit `webhook.local.json` at the project root (create it if missing — it's gitignored, safe for secrets): `{"url": "https://your-railway-app.up.railway.app/webhook-path", "secret": "..."}`. Both fields are required — `configured` in `/api/webhook-config` is `Boolean(url && secret)`, so a filled secret with a blank `url` (or vice versa) still reads as unconfigured and every send is refused. Restart the dashboard server after editing (it holds config in memory, same as any other code/config change — see the hot-reload note above). Then arm the timeframes that should auto-send from the Open Trades card's per-watchlist-group header toggle (each one is a separate confirm dialog; arming is real-money-affecting once a scheduled scan with `--notify` runs). A manual per-row "Send" button also exists on any open trade regardless of arming, gated only by config + the dedupe ledger, with its own confirm dialog — useful for testing the wiring against one real position before arming a whole timeframe.

Three independent gates must all pass before an automatic order goes out, and each covers a different failure:
1. **`notify` is true** — only the real scheduled path (`run_signal_job.js --notify`) sets it, exactly as with ntfy, so no dashboard-triggered or ad-hoc debugging scan can ever place a live order.
2. **The timeframe is armed** in `webhook.enabled_timeframes` (per-timeframe opt-in, default empty, toggled from the Open Trades group header with a confirm dialog).
3. **`ticker|tag|entryTime` is not already in the ledger** (`status/webhook-sent-state.json`). This one is load-bearing: the same OPEN position is re-detected on *every* scan for as long as it stays open, so without it a 15-minute cadence would re-order the same entry all day. Entry time is in the key because it is precisely what changes when a genuinely new position opens on a symbol that already fired — keying on symbol+timeframe alone would suppress the next real entry forever. A **null entry time yields no key and is skipped**, never substituted (same reasoning as the open-trade `scanned_at` bug documented above).

Eligibility reuses the existing notify gating verbatim via `notify_signal_events` — a structured twin of `notify_signal_lines`, added because those lines are formatted for a phone lock screen and cannot be parsed back into fields. Same entries, same gates, never a looser set. Failed sends are deliberately **not** recorded as sent, so the next scan retries.

### Auto-exit dispatch — closes only positions this system itself opened via webhook (2026-07-28)

An entry sent via webhook (manual Send button *or* the auto-armed scheduled path — both write the same ledger record) does **not**, by itself, imply anything will fire when that position later closes. `dispatchTradeWebhooks()` only ever sends entry-side orders; there is no separate mechanism watching for the close. `dispatchExitWebhooks()` (`morning.js`, next to `dispatchTradeWebhooks`) adds that, deliberately scoped to **only close what this system knows it opened at the executor** — user-confirmed choice over the alternative (auto-exit on any EXIT signal on an armed timeframe, regardless of how the position was entered), because sending a close order for a position Railway was never told about could error out or, worse, open an unintended opposite position if the receiver doesn't validate.

- **Reuses the entry ledger as the "did we open this" signal**, rather than adding new state: `alreadySent(key)` (same `ticker|tag|entryTime` key an entry webhook was recorded under) must be true before an exit is even considered. `recordExitSent(key, ...)` in `trade_webhook.js` merges an `.exit` sub-object onto that *same* ledger entry (not a new key) — `alreadySent(key)` keeps meaning exactly "we sent the entry," `alreadyExitSent(key)` answers the paired question, and the two can never desync into separate records for one position.
- **A closed trade's `entryTime` is days-old by the time it exits** (it's when the position originally opened) — so recency has to be judged from a real exit timestamp instead. Added `exitTime`/`exitPrice` to the EXIT branch of `getStrategyPositionState()` in `data.js`, sourced from `reportData()`'s `lastClosedTrade.x.tm`/`x.p` (the same field `trade_log.js` already reads for `exit_time_ms`). The DOM-scrape fallback never populates these — a DOM-sourced EXIT is simply never treated as recent, not guessed at. This is also what fixed the "Signals Found" badge/list mismatch documented above; the two features share the same underlying field.
- **Side is inverted, not reused.** Closing a LONG is a *sell*; closing a SHORT is a *buy* (cover) — the opposite of what `orderAction()` computes for an entry with the same position side. `exitOrderAction()` in `trade_webhook.js` does the inversion; `buildWebhookPayload()` gained an `action` override parameter so the exit path can hand it a pre-resolved action without that action being re-run through the entry-side mapping a second time (which would have silently doubled the position instead of closing it).
- **Same four gates, one more than the entry side**: `notify:true`, timeframe armed, `alreadySent(key)` (we opened this), `!alreadyExitSent(key)` (haven't closed it yet). Failed sends are not recorded, same retry-on-next-scan behavior as the entry path.
- Verified 2026-07-28 against the real ledger/module code with a throwaway fake ticker (no network call): `alreadySent`/`alreadyExitSent` transition correctly, the entry record survives a merge untouched, `exitOrderAction('LONG'/'SHORT'/'SE')` → `sell`/`buy`/`buy`, and `buildWebhookPayload`'s `action` override bypasses `orderAction(side)` correctly. Not yet verified against a real scheduled `--notify` scan end-to-end.

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
