# Manual ledger with active TV-alert + ntfy exit signals

Implementation plan. Reviewed and amended 2026-08-04 against the four-line requirements list
(below) and against the live source of every function it calls.

## Source requirements

Verbatim from `Alpaca-Railway/requirement.txt` — note that file lives in the **executor** repo but
items 2-4 describe work that belongs here, which is why they are restated in full below. Do not
treat that file as the live spec for this work; this document is.

```
1. Ability to toggle ntfy alert for a given tf
2. ability to log a manual ledger entry for an open position that includes account, price, tf
3. ability to view the open ledger entry and close it with defualt date as today to capture exit price
4. on ledger entry, auto calculate stop and target based on the entry price and create live tv alert.
```

Housekeeping found while reviewing: `Alpaca-Railway/ALLOCATION_CONTRACT.md:52` cites
"`requirement.txt` item 5" for its manual phase-2 liquidation rationale. That file has since been
overwritten with the four lines above and has no item 5 — the citation is dangling and should be
replaced with the reasoning itself rather than a reference.

## Context

The user trades some accounts through the automated pipeline in this project (TradingView →
`src/core/trade_webhook.js` → the Railway-hosted Alpaca executor in the separate `Alpaca-Railway`
repo), and holds positions in **other** brokerage accounts that pipeline never touches. There's
currently no way to record those positions anywhere in this project.

First pass of this plan treated `ntfy` as a passive stored-text field ("paste the alert that
prompted this trade"). The user corrected that: ntfy must be **active**, reusing the exact
mechanism this project already uses for exit notifications (`pushNtfyLines`, the same function
behind "level-violation" and "cross-timeframe-exit" pushes), and there's no need to capture
anything on the buy/entry side — the whole point is the **exit** signal. Concretely: when a manual
ledger entry is created, the app should (1) set a real TradingView price alert as a backup/visible
notification inside TradingView itself, and (2) start watching that symbol on the regular
scheduled-scan cadence so that when price crosses the user's stop/target, it fires an ntfy push
through the existing send path — same as an automated position would get.

Research (see "Mechanism findings" below) confirmed this genuinely requires new plumbing: the
existing exit-push logic is 100% coupled to symbols already in the pine-strategy watchlist scan,
and there is no "TV alert fired → ntfy" path at all today. This plan adds a **parallel, lightweight
exit-check** that reuses the CDP quote-fetch and ntfy-send building blocks without dragging manual
positions through the full Swing Profile strategy scan (which would otherwise generate irrelevant
"new signal" noise and trade-log CSV rows for symbols that have nothing to do with that strategy).

This was originally started in the wrong repo (`Alpaca-Railway`, the Postgres-backed executor) and
rolled back there. It belongs in `tradingview-mcp-jackson` because that's where the dashboard and
the TradingView CDP connection actually live.

## Mechanism findings (why the design looks like this)

- **`src/core/alerts.js`**: `create({condition, price, message, symbol, timeframe})` (`alerts.js:36-123`)
  creates a real TradingView price alert via a `pricealerts.tradingview.com` REST call. Only
  `condition: 'cross'` is confirmed live-verified (`alerts.js:25-28`); `web_hook` is hardcoded
  `null` (`alerts.js:70-96`) — TradingView's own webhook alert action is not wired to anything in
  this codebase and nothing receives it. It's already called non-interactively today, from
  `createExcursionAlerts()` in `morning.js` during the regular scan — so calling it from a new,
  different code path is precedented, not novel.
- **`src/core/data.js:getQuote({symbol})`** does **not** fetch an arbitrary symbol's quote — it
  reads whatever is on the *currently active chart* (`data.js:952-985`). Getting a live quote for
  an ad hoc symbol requires navigating there first via **`src/core/chart.js:setSymbol({symbol})`**
  (`chart.js:31`), then calling `getQuote`.
- **The existing exit-push mechanism is pull-based, not alert-driven.**
  `processLevelViolationsAndCleanup()` (`morning.js:2701-2808`) compares `entry.quote.last` (from
  the *pine-strategy scan's* `result.all_scan_results`) against stop/target levels, only for
  symbols that are (a) in `rules.json`'s watchlist/watchlists and due for scan this cycle
  (`morning.js:2915-3020`, `buildScanTargets`/`dueScanTargets`) and (b) already a webhook-sent open
  position (`morning.js:2747-2754`, gated on `alreadySent(wKey)`). **A manual-ledger symbol is
  invisible to this path as-is** — it's not webhook-sent and isn't necessarily on any watchlist.
  Its push call: `pushNtfyLines(...)` inside `runSignalJob()` (`morning.js:3080-3086` region).
  `pushNtfyLines` is module-private (`morning.js:2880`, no `export`) — fine, because the new
  exit-check lives in the same file.
- **Dedup pattern to mirror**: once a level is hit, `stored.fired[check.name]` is set and never
  re-checked (`morning.js:2764-2790`) — without this, an exit push would repeat every ~15 min scan
  cycle for as long as price stays past the trigger. The manual ledger needs the equivalent.
- **Adding manual symbols into `buildScanTargets` was rejected as the mechanism**, despite matching
  the user's chosen "regular scheduled scan" option: that universe drives the actual Swing Profile
  **pine strategy backtest** per symbol/timeframe, not just a quote read — a manually-tracked
  position (e.g. a Fidelity IRA holding) has nothing to do with that strategy, and merging it in
  would generate irrelevant "new signal" ntfy pushes and `trade-log/*.csv` rows for it. Instead,
  this plan adds a **separate step inside the same `runSignalJob()` call** (same trigger, same
  Windows Task Scheduler cadence — satisfying "ride the regular scheduled scan" in spirit) that
  does its own lightweight `setSymbol` → `getQuote` loop over open manual-ledger positions only,
  fully independent of `buildScanTargets`.
- **`serve_signal_status.js` already drives CDP directly from HTTP handlers** — `ensureTradingViewConnection()`
  is called inline in `/api/run-symbol-scan` and elsewhere (`serve_signal_status.js:1441, 1610`),
  imported straight from `morning.js` (`serve_signal_status.js:6`). So the "create a TV alert
  synchronously when the ledger entry is created" handler has direct precedent.
- **`rules.ntfy.only_timeframes` already exists** (`morning.js:3060-3128`, added 2026-08-02) and
  gates all three push channels. It has **no API and no UI** — verified: zero `ntfy` matches in
  `serve_signal_status.js`. Requirement 1 is the missing half, not a new mechanism. The precedent
  to mirror exactly is `POST /api/webhook-toggle` (`serve_signal_status.js:1096-1136`), which does
  per-timeframe set-mutation into `rules.json` via `writeRulesFile()`.

### Traps confirmed by reading the source, each of which fails silently

Every one of these produces a **plausible-looking wrong answer** rather than an error. They are the
reason several code samples below differ from the obvious implementation.

1. **`getQuote({symbol})` echoes the symbol you passed while reading a different symbol's price.**
   `quote.symbol` comes from the argument (`data.js:956`), but `quote.last` comes from the active
   chart's bar data (`data.js:961-966`). Navigate to the wrong symbol, or read before navigation
   settles, and you get `{symbol: 'AAPL', last: <SOXL's price>}` — which then fires a stop-hit ntfy
   push against the wrong instrument. **Mitigation: call `getQuote()` with no argument.** With no
   symbol passed it falls through to `sym = api.symbol()` (`data.js:957`), reporting the chart's
   *actual* symbol, which can then be compared against what was requested.
2. **`setSymbol` never throws on failure.** It returns `{success: true, chart_ready: false}` when
   the readiness wait times out (`chart.js:51-52`), so a `try/catch` around it catches nothing.
   **Mitigation: always pass `wait_timeout` and branch on `chart_ready`.**
3. **`setSymbol`'s early return is a substring match** (`chart.js:40-42`): asking for `SLA` while
   the chart shows `NASDAQ:TSLA` returns `changed: false` and navigates nowhere. Harmless for
   curated watchlist symbols, real for hand-typed ledger entries.
4. **`alerts.create()` never throws either** — it returns `{success: false, error}`
   (`alerts.js:114-122`). A `try/catch` that sets status to `created` after the call records
   failures as successes.
5. **`alerts.create()` prefers the active chart's symbol over the one you pass.** It uses the
   chart's exchange-qualified `symbolExt()` when that matches the requested ticker, and only falls
   back to synthesizing `{symbol: "AAPL"}` from a bare string when it doesn't (`alerts.js:45-64`).
   A bare ticker on the fallback path resolves to whatever exchange TradingView prefers — possibly
   a foreign listing of the same ticker. **Mitigation: navigate to the symbol before creating the
   alert**, so the qualified path is taken. This is the same `setSymbol` call requirement 4's
   auto-calc needs, so the two requirements converge on one fix rather than each paying for it.

### Resolved: both of the original plan's open items

The first draft flagged two things as "confirm during implementation". Both are answerable from the
source and need no live testing:

- **The created alert's id field is `alert_id`.** `create()` returns a normalized object that has
  already unwrapped `data.r.alert_id` (`alerts.js:107`, surfaced at `alerts.js:119`). An
  `?? r?.id` fallback is dead code.
- **Use `condition: 'cross'` for both legs.** `alerts.js:25-34` documents `'greater'`/`'less'` as
  unverified guesses against the live endpoint. `'cross'` fires once regardless of approach
  direction, which is what a stop/target level wants anyway.

## Design decisions

- **No `side` field.** Every manual ledger entry represents a held position awaiting an exit
  (matches the user's "no need for buy side").
- **No passive `ntfy_ref` text field** — superseded by the active exit-push mechanism below.
- **`timeframe` is required, not defaulted.** The first draft made it nullable and silently
  substituted `rules.default_timeframe`. Requirement 2 names tf as part of the entry, and it is
  load-bearing twice over: it becomes the TV alert's `resolution`, and it is what any per-timeframe
  ntfy filtering would key on. A silent default would make both of those quietly wrong.
- **Stop/target are auto-suggested but user-editable, and at least one must end up set.** This is
  the reconciliation of requirement 4 against the first draft's flat rejection of auto-calculation.
  The draft's stated reason for rejecting it — that the excursion computation "assumes a scanned
  strategy context a manual position doesn't have" — is **factually wrong**: `createExcursionAlerts`
  reaches its stats by navigating with `setSymbol`/`setTimeframe` and then calling
  `getAllTradesExcursionStats()` (`morning.js:2429-2431`); nothing in that path requires watchlist
  membership, only that the strategy is attached to the chart. It works for any symbol.
  What *is* true is that those stats describe the Swing Profile strategy's own trades, not a
  discretionary entry — so they are a defensible starting point, not an authority. Hence: suggest,
  pre-fill, let the user overwrite, and keep the "at least one of stop/target" validation so a CDP
  failure degrades to hand-entry instead of blocking the save.
- **Level suggestion is its own endpoint, not part of the save.** Reading excursion stats costs
  ~22s (16s stats timeout at `morning.js:2431` plus two 3s navigations). Putting that inside
  `POST /api/manual-ledger` would make the form hang for 22 seconds on every entry. A separate
  `POST /api/manual-ledger/suggest-levels`, called on blur of the entry-price field, keeps the save
  fast and CDP-free apart from alert creation.
- **The level formula is extracted and shared, not copied.** `createExcursionAlerts` computes
  `entry × (1 ∓ pct/100)` inline (`morning.js:2461-2467`). The suggest endpoint uses the *same*
  exported helper. Two copies of one measurement drift silently, and the failure mode is the worst
  kind — the dashboard's Alert Levels column and the manual ledger's suggestion would disagree with
  nothing indicating which had gone stale. Same reasoning already applied to `sweet_spot.js` vs
  `sweep_portfolio_grid.mjs`.
- **TV alert creation is best-effort and never blocks saving the ledger entry** — same
  never-throw-on-notification-failure philosophy already used by `pushNtfyLines` and
  `sendTradeWebhook`. If TradingView Desktop isn't connected at that moment, the entry still saves;
  `tv_alert_status` records `created`/`partial`/`failed`/`skipped` so the dashboard can show it.
  `partial` exists because there are two alerts (stop and target) and one can succeed alone.
- **Exit-check runs as a new step inside `runSignalJob()`**, after the existing
  `processLevelViolationsAndCleanup` call, gated on the same `notify && rules.ntfy?.url` flag as
  every other push — so it fires on scheduled (`--notify`) runs, not on ad hoc dashboard-triggered
  re-scans, matching existing behavior exactly.
- **Manual-ledger exit pushes are deliberately EXEMPT from `rules.ntfy.only_timeframes`.** With the
  current transition setting of `["15"]`, filtering them would mean a hand-created 4H ledger entry
  silently never notifies — the feature would appear to work and do nothing, which is the exact
  failure mode this codebase keeps rediscovering. Creating the ledger entry *is* the opt-in, and it
  is finer-grained than a timeframe filter. This must stay a stated decision with a comment at the
  call site, not an omission that looks like one.
- **Closing an entry also attempts to delete its TV alerts** (`alerts.deleteAlerts`), best-effort,
  so backup alerts don't pile up in TradingView after a position is done.
- **SQLite file gitignored, `accounts.json` tracked** — a SQLite file is binary and undiffable
  (unlike the tracked `status/*.json`/`trade-log/*.csv`); `accounts.json` is small and hand-edited,
  and diffing which accounts changed is the point, like `rules.json`. Verified `node:sqlite`
  `DatabaseSync` works on the installed Node v24.16.0.
- **No auth on the new endpoints** — matches every existing route in this file (localhost-only
  assumption).

## Files to create

### 1. `src/core/manual_ledger.js` — pure SQLite logic module (no CDP, no HTTP)

Mirrors `src/core/trade_webhook.js`'s shape: exported functions, validation returns `{ok, error}`
instead of throwing.

```js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');
export const MANUAL_LEDGER_DB_PATH = join(PROJECT_ROOT, 'data', 'manual-ledger.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS manual_positions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account            TEXT NOT NULL,
  symbol             TEXT NOT NULL,
  qty                REAL NOT NULL,
  entry_price        REAL NOT NULL,
  stop_price         REAL,
  target_price       REAL,
  timeframe          TEXT NOT NULL,
  levels_source      TEXT,
  notes              TEXT,
  entered_at         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  exit_price         REAL,
  closed_at          TEXT,
  stop_alert_id      TEXT,
  target_alert_id    TEXT,
  tv_alert_status    TEXT,
  exit_alert_level   TEXT,
  exit_alert_fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_positions_status ON manual_positions(status);
`;

let db = null;
let dbPathOverride = null; // test-only

function getDb() {
  if (db) return db;
  const path = dbPathOverride || MANUAL_LEDGER_DB_PATH;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); // DatabaseSync does NOT create parent dirs
  db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  return db;
}

/** Test-only: fresh in-memory DB, drops the cached connection. Never called from production code. */
export function _resetManualLedgerForTests(path = ':memory:') {
  if (db) { try { db.close(); } catch {} }
  db = null;
  dbPathOverride = path;
}

function positive(n) { return Number.isFinite(Number(n)) && Number(n) > 0; }

export function validateManualPositionInput(body) {
  const account = String(body?.account ?? '').trim();
  const symbol = String(body?.symbol ?? '').trim().toUpperCase();
  const timeframe = String(body?.timeframe ?? '').trim();
  if (!account) return { ok: false, error: 'account is required' };
  if (!symbol) return { ok: false, error: 'symbol is required' };
  // Required, never defaulted: it becomes the TV alert's resolution and is what any per-timeframe
  // ntfy gate keys on, so a silent fallback would make both quietly wrong.
  if (!timeframe) return { ok: false, error: 'timeframe is required' };
  if (!positive(body?.qty)) return { ok: false, error: 'qty must be a positive number' };
  if (!positive(body?.entry_price)) return { ok: false, error: 'entry_price must be a positive number' };
  const stopPrice = body?.stop_price != null && body.stop_price !== '' ? Number(body.stop_price) : null;
  const targetPrice = body?.target_price != null && body.target_price !== '' ? Number(body.target_price) : null;
  if (stopPrice != null && !positive(stopPrice)) return { ok: false, error: 'stop_price must be a positive number' };
  if (targetPrice != null && !positive(targetPrice)) return { ok: false, error: 'target_price must be a positive number' };
  if (stopPrice == null && targetPrice == null) return { ok: false, error: 'at least one of stop_price or target_price is required' };
  const enteredAt = body?.entered_at ? new Date(body.entered_at).toISOString() : new Date().toISOString();
  return {
    ok: true,
    value: {
      account, symbol, timeframe,
      qty: Number(body.qty),
      entry_price: Number(body.entry_price),
      stop_price: stopPrice,
      target_price: targetPrice,
      // Records whether the saved levels came from the strategy's excursion stats, a percentage
      // fallback, or were typed by hand — so a later reader can tell a measured level from a guess.
      levels_source: body?.levels_source ? String(body.levels_source).trim() : 'manual',
      notes: body?.notes ? String(body.notes).trim().slice(0, 2000) : null,
      entered_at: enteredAt,
    },
  };
}

export function createManualPosition(value) {
  const info = getDb().prepare(`
    INSERT INTO manual_positions (account, symbol, qty, entry_price, stop_price, target_price, timeframe, levels_source, notes, entered_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(value.account, value.symbol, value.qty, value.entry_price, value.stop_price,
         value.target_price, value.timeframe, value.levels_source, value.notes, value.entered_at);
  return getManualPositionById(info.lastInsertRowid);
}

export function listManualPositions({ status = 'all' } = {}) {
  const d = getDb();
  if (status === 'open' || status === 'closed') {
    return d.prepare('SELECT * FROM manual_positions WHERE status = ? ORDER BY entered_at DESC').all(status);
  }
  return d.prepare('SELECT * FROM manual_positions ORDER BY entered_at DESC').all();
}

export function getManualPositionById(id) {
  return getDb().prepare('SELECT * FROM manual_positions WHERE id = ?').get(Number(id)) || null;
}

export function markManualPositionAlertCreated(id, { stop_alert_id = null, target_alert_id = null, tv_alert_status }) {
  getDb().prepare('UPDATE manual_positions SET stop_alert_id = ?, target_alert_id = ?, tv_alert_status = ? WHERE id = ?')
    .run(stop_alert_id, target_alert_id, tv_alert_status, Number(id));
  return getManualPositionById(id);
}

export function markManualPositionExitAlerted(id, { level, firedAt }) {
  getDb().prepare('UPDATE manual_positions SET exit_alert_level = ?, exit_alert_fired_at = ? WHERE id = ?')
    .run(level, firedAt, Number(id));
  return getManualPositionById(id);
}

export function validateManualCloseInput(body) {
  if (!positive(body?.exit_price)) return { ok: false, error: 'exit_price must be a positive number' };
  // Requirement 3: the dashboard pre-fills today's date, but it is editable, so a back-dated close
  // must be accepted. Only reject something that isn't a date at all.
  let closedAt;
  if (body?.closed_at) {
    const d = new Date(body.closed_at);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'closed_at is not a valid date' };
    closedAt = d.toISOString();
  } else {
    closedAt = new Date().toISOString();
  }
  return { ok: true, value: { exit_price: Number(body.exit_price), closed_at: closedAt } };
}

export function closeManualPosition(id, { exit_price, closed_at }) {
  const existing = getManualPositionById(id);
  if (!existing) return { ok: false, error: 'not found', status: 404 };
  if (existing.status === 'closed') return { ok: false, error: 'already closed', status: 409 };
  getDb().prepare('UPDATE manual_positions SET status = ?, exit_price = ?, closed_at = ? WHERE id = ?')
    .run('closed', exit_price, closed_at, existing.id);
  return { ok: true, value: getManualPositionById(existing.id) };
}
```

### 2. `accounts.json` (repo root, tracked) + `accounts.example.json` (template)

```json
{ "accounts": ["Fidelity IRA", "Schwab Taxable", "IBKR Margin"] }
```
Same load pattern as `rules.json` — read fresh per request, no caching.

### 3. `tests/manual_ledger.test.js`

Same shape as `tests/dashboard_status.test.js` — imports the core module directly, uses
`_resetManualLedgerForTests()` for a clean `:memory:` DB per test. Covers: rejects an entry with
neither stop nor target price; rejects an entry with no timeframe; creates an open entry; closes an
entry with an explicit back-dated `closed_at` and moves it out of "open"; defaults `closed_at` to
now when omitted; rejects a non-date `closed_at`; refuses to close an already-closed entry; 404 on
a nonexistent id; `markManualPositionExitAlerted` persists and is visible on a subsequent read.

### 4. `tests/manual_ledger_exits.test.js` — pure exit-evaluation logic

Tests `evaluateManualLedgerExits()` (see item 6 below) directly with fabricated `{id, symbol,
stop_price, target_price, exit_alert_fired_at}` rows and a fabricated `quotesById` map — no CDP,
no TradingView connection needed, matching how `processLevelViolationsAndCleanup`'s hit-detection
is exercised via plain `results` input. Cases: stop crossed below fires once; target crossed above
fires once; a position with `exit_alert_fired_at` already set is skipped (no re-fire); a quote
missing for a symbol is skipped without throwing; a position with only one of stop/target set only
checks that one.

## Files to modify

### 5. `src/core/morning.js` — export the shared level formula

Extract from `createExcursionAlerts` (`morning.js:2461-2467`) so the suggest-levels endpoint and
the scan path can never disagree, and have `createExcursionAlerts` call it:

```js
/**
 * Stop/target levels from an entry price and the strategy's historical excursion stats.
 * Shared by createExcursionAlerts (scan path) and /api/manual-ledger/suggest-levels — two copies of
 * this would drift silently and the dashboard would show one answer while the ledger showed another.
 */
export function computeExcursionLevels(entryNum, stats) {
  if (!Number.isFinite(entryNum) || entryNum <= 0 || !stats) return null;
  const round2 = n => Math.round(n * 100) / 100;
  return {
    stopAvg:   round2(entryNum * (1 - stats.avgAdversePct   / 100)),
    stopMax:   round2(entryNum * (1 - stats.maxAdversePct   / 100)),
    targetAvg: round2(entryNum * (1 + stats.avgFavorablePct / 100)),
    targetMax: round2(entryNum * (1 + stats.maxFavorablePct / 100)),
  };
}
```

### 6. `src/core/morning.js` — new exit-check step

Add near `processLevelViolationsAndCleanup` (`morning.js:2701-2808`):

```js
import {
  listManualPositions,
  markManualPositionExitAlerted,
} from './manual_ledger.js';
import { setSymbol } from './chart.js';
import { getQuote } from './data.js';

/**
 * CDP-driving: navigates the chart to each open manual-ledger symbol in turn and reads its quote.
 * Sequential (TradingView Desktop is a single chart) and per-symbol try/catch so one bad/delisted
 * symbol can't abort the rest.
 *
 * Three guards here are not optional — each covers a silent-wrong-price path (see "Traps" above):
 *  - `wait_timeout` + `chart_ready`, because setSymbol resolves successfully on a timed-out load.
 *  - `getQuote()` with NO argument, because passing one makes it echo the requested symbol back
 *    while still reading the active chart's bars.
 *  - comparing the chart's reported symbol against the requested ticker, because setSymbol's
 *    early-return is a substring match and may not have navigated at all.
 * Without them a stale price gets attributed to the wrong instrument and fires a real ntfy push.
 */
async function fetchManualLedgerQuotes(openPositions) {
  const quotesById = {};
  const bare = s => String(s || '').split(':').pop().toUpperCase();
  for (const pos of openPositions) {
    try {
      const nav = await setSymbol({ symbol: pos.symbol, wait_timeout: 4000 });
      if (!nav?.chart_ready) {
        console.error(`[manual-ledger-exit] chart not ready for ${pos.symbol}, skipping`);
        continue;
      }
      const q = await getQuote(); // no argument: reports the chart's ACTUAL symbol
      if (bare(q?.symbol) !== bare(pos.symbol)) {
        console.error(`[manual-ledger-exit] chart shows ${q?.symbol}, wanted ${pos.symbol}, skipping`);
        continue;
      }
      quotesById[pos.id] = Number(q?.last ?? q?.close);
    } catch (err) {
      console.error(`[manual-ledger-exit] quote fetch failed for ${pos.symbol}: ${err?.message || err}`);
    }
  }
  return quotesById;
}

// Pure: no CDP, no I/O. Mirrors the fired-once dedup pattern in processLevelViolationsAndCleanup
// (morning.js:2764-2790) — a position already alerted is never re-evaluated.
export function evaluateManualLedgerExits(openPositions, quotesById, { timezone = DEFAULT_MARKET_HOURS.timezone } = {}) {
  const hits = [];
  for (const pos of openPositions) {
    if (pos.exit_alert_fired_at) continue;
    const last = Number(quotesById[pos.id]);
    if (!Number.isFinite(last)) continue;
    let level = null;
    if (Number.isFinite(Number(pos.stop_price)) && last <= Number(pos.stop_price)) level = 'stop';
    else if (Number.isFinite(Number(pos.target_price)) && last >= Number(pos.target_price)) level = 'target';
    if (!level) continue;
    const triggerPrice = level === 'stop' ? pos.stop_price : pos.target_price;
    hits.push({
      id: pos.id,
      level,
      line: `${formatTimestamp(new Date(), timezone)} ET | MANUAL EXIT: ${pos.symbol} (${pos.account}) | ${level === 'stop' ? 'Stop' : 'Target'} ${triggerPrice} (last ${last}) | Entry ${pos.entry_price}`,
    });
  }
  return hits;
}
```

In `runSignalJob()`, right after the existing `levelCheck`/`processLevelViolationsAndCleanup` block
(`morning.js:3042-3052`):

```js
try {
  const openManual = listManualPositions({ status: 'open' });
  if (openManual.length > 0) {
    const quotesById = await fetchManualLedgerQuotes(openManual);
    const hits = evaluateManualLedgerExits(openManual, quotesById, { timezone: marketHours.timezone });
    for (const hit of hits) {
      markManualPositionExitAlerted(hit.id, { level: hit.level, firedAt: new Date().toISOString() });
    }
    // DELIBERATELY NOT filtered by rules.ntfy.only_timeframes, unlike the three pushes below.
    // Creating a manual ledger entry by hand IS the per-position opt-in, and it is finer-grained
    // than a timeframe allowlist. Filtering here would mean a 4H ledger entry created under the
    // current ["15"] transition setting silently never notifies — the feature would look wired up
    // and do nothing. If this ever needs to be mutable, give it its own switch rather than folding
    // it into only_timeframes.
    if (notify && rules.ntfy?.url && hits.length > 0) {
      await pushNtfyLines(hits.map(h => h.line), {
        url: rules.ntfy.url, title: 'Manual ledger exit', priority: 'high', logPrefix: '[manual-ledger-exit]',
      });
    }
  }
} catch (err) {
  console.error(`[manual-ledger-exit] check failed: ${err?.message || err}`);
}
```
Placed after the pine-strategy scan has already run for this cycle (not interleaved with it), so
there's only ever one chart navigation in flight at a time.

### 7. `scripts/serve_signal_status.js` — ntfy toggle (requirement 1)

Mirrors `/api/webhook-toggle` (`serve_signal_status.js:1096-1136`) exactly.

```js
if (req.url === '/api/ntfy-config' && req.method === 'GET') {
  try {
    const rules = loadRulesFile() || {};
    const onlyTimeframes = Array.isArray(rules.ntfy?.only_timeframes) ? rules.ntfy.only_timeframes : [];
    sendJson(res, 200, {
      success: true,
      configured: Boolean(rules.ntfy?.url),   // never return the URL itself
      onlyTimeframes,
      filtering: onlyTimeframes.length > 0,   // explicit, so the UI never has to infer it
      watchlists: rules.watchlists || {},
    });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err?.message || 'Failed to read ntfy config' });
  }
  return;
}

if (req.method === 'POST' && req.url === '/api/ntfy-toggle') {
  readJsonBody(req).then((body) => {
    const timeframe = String(body?.timeframe ?? '').trim();
    if (!timeframe) { sendJson(res, 400, { success: false, error: 'timeframe is required' }); return; }
    const rules = loadRulesFile();
    if (!rules) { sendJson(res, 500, { success: false, error: 'rules.json not found or invalid' }); return; }
    const set = new Set(Array.isArray(rules.ntfy?.only_timeframes) ? rules.ntfy.only_timeframes : []);
    if (body?.enabled) set.add(timeframe); else set.delete(timeframe);
    rules.ntfy = { ...(rules.ntfy || {}), only_timeframes: [...set] };
    writeRulesFile(rules);
    console.log(`[ntfy] only_timeframes now ${[...set].join(',') || 'EMPTY (no filter — all timeframes push)'}`);
    sendJson(res, 200, { success: true, onlyTimeframes: [...set], filtering: set.size > 0 });
  }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
  return;
}
```

**The semantics trap this UI must not hide.** An empty `only_timeframes` means *no filtering* —
every timeframe pushes — matching the "unset means disabled" convention every gate in this codebase
follows (`morning.js:2690-2694`). Do **not** change that. But it means a checkbox row where the
user unchecks the last remaining timeframe **widens** notifications from "only 15m" to "everything",
which reads as the exact opposite on screen. Two requirements on the dashboard side:

- Render the empty state as its own explicit banner ("No filter — every timeframe pushes"), never
  as a row of unchecked boxes.
- Confirm-gate the transition from one-remaining to zero, since it is a widening action. Consistent
  with the confirm-gating on webhook arming and every other outward-affecting toggle here.

### 8. `scripts/serve_signal_status.js` — manual ledger routes

- **Imports** (near the existing `trade_webhook.js` import block):
  ```js
  import {
    validateManualPositionInput, createManualPosition, listManualPositions,
    closeManualPosition, validateManualCloseInput, markManualPositionAlertCreated,
    getManualPositionById,
  } from '../src/core/manual_ledger.js';
  import { create as createTvAlert, deleteAlerts as deleteTvAlerts } from '../src/core/alerts.js';
  import { computeExcursionLevels } from '../src/core/morning.js';
  import * as chart from '../src/core/chart.js';
  import * as data from '../src/core/data.js';
  ```
  (`ensureTradingViewConnection` is already imported at line 6.)
- **`loadAccountsFile()`** — same `existsSync`/`JSON.parse`/try-catch-null shape as `loadRulesFile()`
  (`serve_signal_status.js:223-231`).
- **`GET /api/accounts`** — after the `/api/watchlists` block (`serve_signal_status.js:939-947`):
  ```js
  if (req.url === '/api/accounts') {
    try {
      const cfg = loadAccountsFile() || {};
      const accounts = Array.isArray(cfg.accounts) ? cfg.accounts.filter(a => typeof a === 'string' && a.trim()) : [];
      sendJson(res, 200, { success: true, accounts });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'Failed to read accounts' });
    }
    return;
  }
  ```
- **`POST /api/manual-ledger/suggest-levels`** (requirement 4). Separate from the save because it
  costs ~22s; returns a suggestion, never persists anything:
  ```js
  if (req.method === 'POST' && req.url === '/api/manual-ledger/suggest-levels') {
    readJsonBody(req).then(async (body) => {
      const symbol = String(body?.symbol ?? '').trim().toUpperCase();
      const timeframe = String(body?.timeframe ?? '').trim();
      const entryNum = Number(body?.entry_price);
      if (!symbol || !timeframe || !(entryNum > 0)) {
        sendJson(res, 400, { success: false, error: 'symbol, timeframe and a positive entry_price are required' });
        return;
      }
      const rules = loadRulesFile() || {};
      try {
        await ensureTradingViewConnection();
        const nav = await chart.setSymbol({ symbol, wait_timeout: 4000 });
        if (!nav?.chart_ready) throw new Error(`chart did not load ${symbol}`);
        await chart.setTimeframe({ timeframe, wait_timeout: 3000 });
        const stats = await data.getAllTradesExcursionStats({ timeout_ms: 16000 });
        const levels = computeExcursionLevels(entryNum, stats);
        if (!levels) throw new Error('no excursion stats available for this symbol/timeframe');
        // avg is the suggestion; max is returned so the form can show the wider pair as an option,
        // matching the four levels the Alert Levels column already shows for scanned positions.
        sendJson(res, 200, { success: true, source: 'strategy_excursion', levels, stats });
      } catch (err) {
        // Percentage fallback keeps the form usable with TradingView closed. Labelled distinctly so
        // levels_source records which one the saved entry actually used.
        const stopPct = Number(rules.manual_ledger?.default_stop_pct ?? 8);
        const targetPct = Number(rules.manual_ledger?.default_target_pct ?? 15);
        const round2 = n => Math.round(n * 100) / 100;
        sendJson(res, 200, {
          success: true,
          source: 'fallback_pct',
          reason: err?.message || String(err),
          levels: {
            stopAvg: round2(entryNum * (1 - stopPct / 100)),
            targetAvg: round2(entryNum * (1 + targetPct / 100)),
            stopMax: null, targetMax: null,
          },
        });
      }
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }
  ```
- **`GET /api/manual-ledger`** — after the `/api/webhook-ledger` block:
  ```js
  if (req.url.split('?')[0] === '/api/manual-ledger' && req.method === 'GET') {
    try {
      const status = new URL(req.url, 'http://localhost').searchParams.get('status') || 'all';
      const rows = listManualPositions({ status });
      sendJson(res, 200, { success: true, rows, open: rows.filter(r => r.status === 'open'), closed: rows.filter(r => r.status === 'closed') });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'could not read the manual ledger' });
    }
    return;
  }
  ```
- **`POST /api/manual-ledger`** — creates the row, then best-effort creates backup TV alert(s):
  ```js
  if (req.url === '/api/manual-ledger' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const parsed = validateManualPositionInput(body);
      if (!parsed.ok) { sendJson(res, 400, { success: false, error: parsed.error }); return; }
      const cfg = loadAccountsFile() || {};
      const knownAccounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
      if (!knownAccounts.includes(parsed.value.account)) {
        sendJson(res, 400, { success: false, error: `Unknown account "${parsed.value.account}" — add it to accounts.json first` });
        return;
      }
      const row = createManualPosition(parsed.value);

      // Backup native TV alert — best-effort, never blocks entry creation, same
      // never-throw philosophy as pushNtfyLines/sendTradeWebhook elsewhere in this app.
      //
      // Navigate FIRST: alerts.create() only produces an exchange-qualified symbol when the chart is
      // already on it (alerts.js:45-64). Skipping this leaves a bare ticker to resolve to whatever
      // exchange TradingView prefers, i.e. possibly a foreign listing of the same ticker.
      //
      // alerts.create() returns {success:false} instead of throwing (alerts.js:114-122), so status
      // is derived from the results, never assumed from "no exception was raised".
      const alertIds = {};
      const outcomes = [];
      try {
        await ensureTradingViewConnection();
        const nav = await chart.setSymbol({ symbol: row.symbol, wait_timeout: 4000 });
        if (!nav?.chart_ready) throw new Error(`chart did not load ${row.symbol}`);
        for (const leg of [
          { field: 'stop_alert_id', price: row.stop_price, label: 'stop' },
          { field: 'target_alert_id', price: row.target_price, label: 'target' },
        ]) {
          if (!Number.isFinite(leg.price)) continue;
          const r = await createTvAlert({
            condition: 'cross',                     // only condition verified live (alerts.js:25-28)
            price: leg.price,
            message: `Manual ledger ${leg.label}: ${row.symbol} (${row.account})`,
            symbol: row.symbol,
            timeframe: row.timeframe,
          });
          outcomes.push(r?.success === true);
          if (r?.success) alertIds[leg.field] = r.alert_id ?? null;   // alerts.js:107/119
          else console.error(`[manual-ledger] TV ${leg.label} alert failed for ${row.symbol}: ${r?.error || 'unknown'}`);
        }
      } catch (err) {
        console.error(`[manual-ledger] TV alert creation failed for ${row.symbol}: ${err?.message || err}`);
      }
      const tvAlertStatus = outcomes.length === 0 ? 'failed'
        : outcomes.every(Boolean) ? 'created'
        : outcomes.some(Boolean) ? 'partial'
        : 'failed';
      const updated = markManualPositionAlertCreated(row.id, { ...alertIds, tv_alert_status: tvAlertStatus });
      sendJson(res, 200, { success: true, row: updated || row });
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }
  ```
- **`POST /api/manual-ledger/:id/close`** — first regex-matched dynamic path segment in this file
  (the one existing precedent, `/api/paper-run/:action`, only works because its variable part is
  the *last* segment — worth calling out in the commit). Also best-effort deletes any TV alerts:
  ```js
  if (req.method === 'POST') {
    const closeMatch = req.url.split('?')[0].match(/^\/api\/manual-ledger\/(\d+)\/close$/);
    if (closeMatch) {
      readJsonBody(req).then(async (body) => {
        const parsed = validateManualCloseInput(body);
        if (!parsed.ok) { sendJson(res, 400, { success: false, error: parsed.error }); return; }
        const existing = getManualPositionById(closeMatch[1]);
        const result = closeManualPosition(closeMatch[1], parsed.value);
        if (!result.ok) { sendJson(res, result.status || 400, { success: false, error: result.error }); return; }
        const alertIds = [existing?.stop_alert_id, existing?.target_alert_id].filter(Boolean);
        if (alertIds.length > 0) {
          try { await ensureTradingViewConnection(); await deleteTvAlerts({ alert_ids: alertIds }); }
          catch (err) { console.error(`[manual-ledger] TV alert cleanup failed: ${err?.message || err}`); }
        }
        sendJson(res, 200, { success: true, row: result.value });
      }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
      return;
    }
  }
  ```

### 9. `dashboard/index.html`

- **Tab button** — after "Webhook Orders": `<button type="button" class="tabbtn" data-pane="pane-manual-ledger">Manual Ledger</button>`
- **Tab pane** — modeled on `pane-webhook`: summary card, an "Add entry" card, an "Open" table
  (columns: Account/Symbol/TF/Qty/Entry/Stop/Target/TV alert status/Exit-alert-fired/Close-action)
  and a "Closed" table (adds Exit price/Closed columns).
- **Add-entry form fields**: account `<select>` (from `/api/accounts`), symbol, **timeframe
  `<select>`** (required — populate from `rules.watchlists` values, same vocabulary the rest of the
  dashboard uses), qty, entry price, stop price, target price, notes. No side field.
  - On blur of entry price (with symbol + timeframe filled), call
    `POST /api/manual-ledger/suggest-levels` and **pre-fill** stop/target if the user hasn't typed
    into them. Show which source produced them (`strategy_excursion` vs `fallback_pct`) next to the
    fields, and send it back as `levels_source` on save. Suggestion is slow (~22s on the stats
    path) — show a spinner and never block typing.
  - Client-side check that at least one of stop/target ends up filled, mirroring the server
    validation rather than replacing it.
- **Close action**: a small inline form, not `prompt()` — exit price **and a date input pre-filled
  to today** (requirement 3), editable so a back-dated close is possible → `confirm()` →
  `POST /api/manual-ledger/${id}/close` → reload.
- **ntfy toggle card** (requirement 1) — put it on the Open Trades card next to the existing
  webhook arming toggles, since that is where per-timeframe switches already live. One checkbox per
  configured timeframe, `POST /api/ntfy-toggle` per change. Renders the "no filter" state as an
  explicit banner and confirm-gates the last-timeframe-off transition, per §7.
- **JS**: `loadManualLedgerTab()`, `renderMlOpen()`/`renderMlClosed()` (via the existing
  `escapeHtml()` helper), all matching the existing `pane-webhook` idioms exactly.
- **Tab-click wiring**: one line next to the `pane-webhook` line in the existing `.tabbtn` click
  handler: `if (btn.dataset.pane === 'pane-manual-ledger') loadManualLedgerTab();`

### 10. `package.json`

Append `tests/manual_ledger.test.js` and `tests/manual_ledger_exits.test.js` to both `test:unit`
and `test:all` (explicit space-separated lists, not a glob — silently skipped otherwise).

### 11. `.gitignore`

```
# Manual ledger SQLite file (data/manual-ledger.db) — local runtime state in a binary format, not
# diff-friendly. accounts.json (the picklist config half of this feature) IS tracked; this is not.
data/
```

## Sequencing

1. `src/core/manual_ledger.js` + `tests/manual_ledger.test.js` + `package.json` — verify in isolation.
2. `computeExcursionLevels()` extraction in `morning.js`, with `createExcursionAlerts` switched to
   call it — run the existing suite to confirm no behavior change before anything new consumes it.
3. `evaluateManualLedgerExits()` in `morning.js` + `tests/manual_ledger_exits.test.js` — pure logic,
   verify before wiring the CDP-driving `fetchManualLedgerQuotes()` around it.
4. `accounts.json` + `accounts.example.json`; `.gitignore` update.
5. `fetchManualLedgerQuotes()` + the `runSignalJob()` call site in `morning.js`.
6. `scripts/serve_signal_status.js` — ntfy toggle routes (independently useful, ships first).
7. `scripts/serve_signal_status.js` — manual ledger routes, including suggest-levels and
   TV-alert creation.
8. `dashboard/index.html`.

## Verification

1. `npm run test:unit` — new tests pass alongside the existing suite.
2. Restart the dashboard server before testing anything — it holds all of this in memory and does
   not hot-reload (see `CLAUDE.md`).
3. ntfy toggle: flip a timeframe off, confirm `rules.json` updates and the next `--notify` scan
   omits it. Uncheck the last one and confirm the UI shows the explicit "no filter" banner rather
   than an all-unchecked row.
4. `npm run dashboard`, open the new "Manual Ledger" tab: enter symbol + timeframe + entry price,
   confirm stop/target pre-fill and the source label reads `strategy_excursion` with TradingView
   connected. Close TradingView and confirm it degrades to `fallback_pct` rather than blocking.
5. Save the entry, confirm it appears in "Open", that a real alert shows up in TradingView's alert
   panel **on the expected exchange**, and that `tv_alert_status` reads `created`. Then deliberately
   break one leg (e.g. a stop price the endpoint rejects) and confirm it records `partial`, not
   `created`.
6. Trigger a scan (`POST /api/run-cron-now` or the scheduled job) with a stop price near the current
   quote — confirm an ntfy push arrives and `exit_alert_fired_at` is set so it doesn't repeat.
   Check the log for `[manual-ledger-exit] chart shows … wanted …` lines; any of those means the
   symbol form needs normalizing, not that the guard is wrong.
7. Close the entry with a back-dated date — confirm it moves to "Closed" with the date entered (not
   today), and that its alerts are removed from TradingView's alert panel.
8. `git status` — confirm `data/manual-ledger.db` is absent (gitignored) and `accounts.json` is
   tracked.
