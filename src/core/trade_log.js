/**
 * Closed-trade history log — one CSV per timeframe.
 *
 * Every scan already parks the chart on a symbol/timeframe with the strategy attached, so the
 * full closed-trade history is sitting right there in `reportData().trades[]`. This module
 * harvests it and appends new rows to `trade-log/trades-<tf>.csv`, deduplicated by
 * ticker|timeframe|entry_time_ms so re-scanning the same symbol never double-logs.
 *
 * Why a persistent log at all: TradingView's Strategy Tester only ever shows the trades that fit
 * in the *current* bar history for the *currently displayed* symbol. Once a bar scrolls out of
 * the loaded range, or the symbol changes, that history is gone. Worse, the headline
 * profitFactor/percentProfitable it reports exclude still-open losers entirely (an open -$2,337
 * position contributes $0 to grossLoss), so a strategy that lets losers ride reads as
 * near-perfect. A durable per-timeframe log of *closed* trades is the only way to compare
 * timeframes on equal footing over time.
 *
 * The two columns that matter most and exist nowhere else in this project:
 *   - exit_signal  (`x.c`) — the strategy's own name for why it exited ("Flip Short",
 *     "Trailing Stop", ...). This is how you tell whether the trailing stop is actually firing
 *     or whether every exit is a signal flip.
 *   - bars_held    (`x.b - e.b`) — exact bar count, not a wall-clock approximation.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { fileURLToPath } from "node:url";
import { evaluate, KNOWN_PATHS } from "../connection.js";
import { readJsonFile } from '../json_file.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
export const TRADE_LOG_DIR = join(PROJECT_ROOT, "trade-log");

const COLUMNS = [
  "trade_key",
  "rule_type",
  "ticker",
  "symbol",
  "timeframe",
  "watchlist",
  "side",
  "entry_signal",
  "entry_time_et",
  "entry_time_ms",
  "entry_price",
  "exit_signal",
  "exit_time_et",
  "exit_time_ms",
  "exit_price",
  "qty",
  "position_value",
  "bars_held",
  "pnl_usd",
  "pnl_pct",
  "mfe_usd",
  "mfe_pct",
  "mae_usd",
  "mae_pct",
  "commission",
  "logged_at",
];

// Timeframes arrive as TradingView resolution strings ("15", "240", "D"). Keep the filename
// human-readable so `trades-4h.csv` is obvious, but keep the mapping total — an unrecognized
// resolution still gets its own file rather than being silently dropped.
const TF_FILE_LABELS = {
  1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m",
  45: "45m", 60: "1h", 120: "2h", 180: "3h", 240: "4h",
  360: "6h", 480: "8h", 720: "12h",
};

export function timeframeLabel(timeframe) {
  const tf = String(timeframe || "").trim().toUpperCase();
  if (!tf) return "unknown";
  if (tf === "D" || tf === "1D") return "1d";
  if (tf === "W" || tf === "1W") return "1w";
  if (tf === "M" || tf === "1M") return "1mo";
  const label = TF_FILE_LABELS[Number(tf)];
  return label || tf.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function tradeLogPath(timeframe) {
  return join(TRADE_LOG_DIR, `trades-${timeframeLabel(timeframe)}.csv`);
}

function tickerOf(symbol) {
  return String(symbol || "").split(":").pop().toUpperCase();
}

/**
 * Compact identifier for the exit-rule configuration that produced a trade.
 *
 * Examples: `flip-only`, `ts60`, `ts60-losing`, `sl-auto`, `sl12.0`, `ts60+sl-auto`, `pyr25`,
 * `sl-auto+pyr25`.
 *
 * Derived from the strategy's live input values so it cannot disagree with what is actually set on
 * the chart. Input titles carry leading spaces for indentation in TradingView's settings panel, so
 * every lookup is trimmed. If the inputs can't be read the result is `unknown` rather than a guess
 * — mislabelling a variant would silently corrupt any A/B comparison built on this column.
 *
 * Pyramid Add is independent of Time Stop / Stop Loss (all three can combine), so its segment is
 * appended after whichever exit-rule segments are present rather than replacing them.
 */
export function ruleTypeFromInputs(inputs) {
  if (!inputs || typeof inputs !== "object") return "unknown";
  const get = (name) => {
    const key = Object.keys(inputs).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : inputs[key];
  };

  const useTimeStop = get("Time Stop");
  const useStopLoss = get("Stop Loss");
  const useDoPyramid = get("Pyramid Add");
  // All three absent means this build of the script predates the exit-rule toggles.
  if (useTimeStop === undefined && useStopLoss === undefined && useDoPyramid === undefined) return "flip-only";

  const parts = [];
  if (useTimeStop === true) {
    const bars = get("Bars in trade");
    const losingOnly = get("Only if position is losing") === true;
    parts.push(`ts${bars ?? "?"}${losingOnly ? "-losing" : ""}`);
  }
  if (useStopLoss === true) {
    const auto = get("Auto level per timeframe");
    parts.push(auto === false ? `sl${Number(get("Manual stop %") ?? 0).toFixed(1)}` : "sl-auto");
  }
  if (useDoPyramid === true) {
    const frac = get("Add size % of original");
    let seg = `pyr${Number.isFinite(Number(frac)) ? Number(frac).toFixed(0) : "?"}`;
    // The add trigger has two regimes that produce very different fill rates on the same toggle
    // (15% vs ~51% at 15m), so the mode has to reach rule_type or the two would pool into one
    // sample. Absent input = a build predating the mode, which behaved exactly as "Fixed", so it
    // deliberately produces the bare `pyr<N>` that already-logged rows carry.
    const mode = get("Add trigger");
    if (typeof mode === "string" && /mae/i.test(mode)) {
      const maePct = get("MAE trigger %");
      seg += `mae${Number.isFinite(Number(maePct)) ? Number(maePct).toFixed(0) : "?"}`;
    }
    parts.push(seg);
  }
  return parts.length ? parts.join("+") : "flip-only";
}

/**
 * Cross-check the property-derived rule type against the strategy's own runtime report.
 *
 * `runtimeExitRules` is the text the script writes into its "Exit rules:" diagnostic line ("flip
 * only", "TimeStop 60b (losing only) + SL 12.0%"); `runtimePyramid` is the separate "Pyramid:" line
 * ("off", "add 25% @ 6%"). Only on/off booleans are compared for each — the labels print effective
 * percentages, which can't distinguish e.g. auto-per-timeframe from a manual level, so the
 * properties remain the source for that detail.
 *
 * Returns `unknown` on disagreement rather than picking a side. A mislabelled variant is worse than
 * an unlabelled one: it silently merges two regimes inside what looks like a clean A/B sample, and
 * nothing downstream could detect it afterwards. Verified reachable — writing an input through the
 * properties API updates the cell without reaching the Pine engine, so the property read says the
 * rule is on while the strategy is still running without it.
 */
export function reconcileRuleType(ruleType, runtimeExitRules, runtimePyramid) {
  // No label at all (diagnostics switched off, or an older build) means no second opinion available.
  if (!runtimeExitRules && !runtimePyramid) return { ruleType, mismatch: null };

  const derivedTimeStop = /(^|\+)ts\d/.test(ruleType);
  const derivedStopLoss = /(^|\+)sl/.test(ruleType);
  const derivedPyramid = /(^|\+)pyr\d/.test(ruleType);

  let agree = true;
  if (runtimeExitRules) {
    const runtimeTimeStop = /time\s*stop/i.test(runtimeExitRules);
    const runtimeStopLoss = /\bSL\b/i.test(runtimeExitRules);
    agree = agree && runtimeTimeStop === derivedTimeStop && runtimeStopLoss === derivedStopLoss;
  }
  if (runtimePyramid) {
    const runtimePyrOn = /^add\b/i.test(runtimePyramid);
    agree = agree && runtimePyrOn === derivedPyramid;
    // The label prints "[mae ...]" or "[fixed]" for the add trigger. Checking it is the whole point
    // of this guard for the pyramid: the two modes share one checkbox, and a mode set through the
    // properties API that never reached the Pine engine would otherwise log a full run of
    // fixed-trigger trades under the adaptive variant's name — undetectable after the fact.
    if (runtimePyrOn) {
      agree = agree && /\[mae\b/i.test(runtimePyramid) === /pyr[\d.]+mae/i.test(ruleType);
    }
  }

  if (agree) return { ruleType, mismatch: null };
  return {
    ruleType: UNKNOWN_RULE_TYPE,
    mismatch: {
      derived_from_inputs: ruleType,
      strategy_reported: [runtimeExitRules, runtimePyramid].filter(Boolean).join(" | "),
      detected_at: new Date().toISOString(),
    },
  };
}

/** Best-effort timeframe label for warning text only, before the real one is resolved. */
function tfLabelForWarn(timeframe, rd) {
  try { return timeframeLabel(timeframe || rd?.actualRes); } catch { return String(timeframe || "?"); }
}

function sideFromEntryCode(tp) {
  if (tp === "le" || tp === "lx") return "LONG";
  if (tp === "se" || tp === "sx") return "SHORT";
  return "";
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function num(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number(Number(value).toFixed(digits));
}

// reportData()'s `.p` fields are fractions of position value (0.0387 = 3.87%).
function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number((Number(value) * 100).toFixed(4));
}

function etTimestamp(ms, timezone = "America/New_York") {
  if (!ms || !Number.isFinite(Number(ms))) return "";
  try {
    const d = new Date(Number(ms));
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return new Date(Number(ms)).toISOString();
  }
}

/**
 * Read every trade from the strategy currently on the chart.
 *
 * Returns the raw array plus totalOpenTrades so the caller can drop the trailing open row.
 * Deliberately does NOT reuse data.js's readStableStrategyReportData: that one polls for
 * stability against a *trade-identity* signature tuned for the latest trade only, and closed
 * history further back never changes mid-recompute the way the live row does.
 */
async function readAllTrades(studyFilter) {
  const filterLower = JSON.stringify(String(studyFilter || "").toLowerCase());
  return evaluate(`
    (function() {
      try {
        var w = ${KNOWN_PATHS.chartApi};
        var actualSymbol = '';
        var actualRes = '';
        try { actualSymbol = w.symbolExt().pro_name; } catch(e) {}
        try { actualRes = String(w.resolution()); } catch(e) {}
        var chart = w._chartWidget;
        var sources = chart.model().model().dataSources();
        var filterLower = ${filterLower};
        var candidates = [];
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var meta = null;
          try { meta = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
          var name = meta ? (meta.description || meta.shortDescription || meta.fullDescription || '') : '';
          if (/strategy/i.test(name)) candidates.push({ source: s, name: name });
        }
        if (candidates.length === 0) return { error: 'no_strategy_on_chart' };
        var matched = filterLower ? candidates.filter(function(c) { return c.name.toLowerCase().indexOf(filterLower) !== -1; }) : candidates;
        var chosen = matched.length > 0 ? matched[0] : candidates[0];
        var rd = typeof chosen.source.reportData === 'function' ? chosen.source.reportData() : chosen.source.reportData;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        if (!rd || !rd.performance) return { error: 'report_unavailable', studyName: chosen.name };
        var all = rd.performance.all || {};

        // Current values of the strategy's exit-rule inputs, so each logged trade records which
        // rule set produced it. Read from the study rather than from config: the toggles live on
        // the chart and can be changed by hand, so anything else would drift.
        var inputs = {};
        try {
          var mi = chosen.source.metaInfo ? chosen.source.metaInfo() : null;
          var ip = chosen.source.properties().childs().inputs;
          var pc = ip && ip.childs ? ip.childs() : null;
          if (mi && mi.inputs && pc) {
            for (var q = 0; q < mi.inputs.length; q++) {
              var def = mi.inputs[q];
              var nm = String(def.name || def.id || '').trim();
              var cell = pc[def.id];
              if (nm && cell && typeof cell.value === 'function') inputs[nm] = cell.value();
            }
          }
        } catch (e) { inputs = {}; }

        // The strategy's own runtime view of its exit rules, scraped from the diagnostic label it
        // draws ("Exit rules: TimeStop 60b" / "Exit rules: flip only"). The input *properties* above
        // can disagree with what the Pine engine actually executed — verified live: setting an input
        // through the properties API reported true on read-back while the script kept running with
        // it false, which would have tagged flip-only trades as ts60. This label is written by the
        // script itself during evaluation, so it is the authoritative record of the rule set in force.
        var runtimeExitRules = null;
        var runtimePyramid = null;
        try {
          var src2 = chosen.source._study || chosen.source;
          var g2 = src2._graphics || (src2._source && src2._source._graphics);
          var pc2 = g2 && g2._primitivesCollection;
          var lmap = pc2 && pc2.dwglabels ? pc2.dwglabels.get('labels') : null;
          var ldata = lmap ? lmap.get(false) : null;
          // Two traps here: _primitivesDataById is a Map, not a plain object (for..in yields
          // nothing), and in this raw primitive data the label text is the 't' field -- 'text'
          // exists only on the normalized shape the pine-label tools return.
          // (No backticks in this block: it lives inside a JS template literal.)
          if (ldata && ldata._primitivesDataById) {
            ldata._primitivesDataById.forEach(function (lbl) {
              if (!lbl) return;
              var t = String(lbl.t || lbl.text || '');
              // Both lines live in the same diagnostic label, so one match on 'Exit rules:'
              // confirms it's the right label and both extractions run against it.
              if (runtimeExitRules === null) {
                var m1 = t.match(/Exit rules:\s*(.+)$/m);
                if (m1) {
                  runtimeExitRules = m1[1].trim();
                  var m2 = t.match(/Pyramid:\s*(.+)$/m);
                  if (m2) runtimePyramid = m2[1].trim();
                }
              }
            });
          }
        } catch (e) { runtimeExitRules = null; runtimePyramid = null; }

        return {
          inputs: inputs,
          runtimeExitRules: runtimeExitRules,
          runtimePyramid: runtimePyramid,
          studyName: chosen.name,
          actualSymbol: actualSymbol,
          actualRes: actualRes,
          totalOpenTrades: all.totalOpenTrades || 0,
          trades: Array.isArray(rd.trades) ? rd.trades : [],
          // Max drawdown needs the bar-by-bar equity curve and cannot be reconstructed from a
          // trade list, so it has to be captured here while the strategy is on screen. Open P&L
          // likewise — the CSV holds closed trades only.
          perf: {
            maxDDPercent: rd.performance.maxStrategyDrawDownPercent || 0,
            openPLPercent: rd.performance.openPLPercent || 0,
            openPL: rd.performance.openPL || 0,
            netProfitPercent: all.netProfitPercent || 0,
            netProfit: all.netProfit || 0,
            totalTrades: all.totalTrades || 0,
            sharpe: rd.performance.sharpeRatio || 0,
            sortino: rd.performance.sortinoRatio || 0
          }
        };
      } catch(e) { return { error: e.message }; }
    })()
  `).catch((e) => ({ error: e?.message || String(e) }));
}

function ensureDir() {
  if (!existsSync(TRADE_LOG_DIR)) mkdirSync(TRADE_LOG_DIR, { recursive: true });
}

/**
 * Per-symbol/timeframe strategy performance snapshot, keyed "TICKER|tflabel".
 *
 * Separate from the CSVs because it is a *current state* snapshot that gets overwritten, not an
 * append-only history: max drawdown and open P&L describe the strategy as of the last read.
 * Kept as JSON next to the other status files so the dashboard can read it without CDP.
 */
export const PERF_SNAPSHOT_PATH = join(PROJECT_ROOT, "status", "strategy-perf.json");

export function readPerfSnapshots() {
  if (!existsSync(PERF_SNAPSHOT_PATH)) return {};
  try {
    return readJsonFile(PERF_SNAPSHOT_PATH);
  } catch {
    return {};
  }
}

/**
 * Perf snapshots reshaped into the "TICKER|tflabel" -> {openPct, maxDDPct} map buildEdgeAnalysis
 * expects. One implementation rather than one per call site — this exact transform used to be
 * copy-pasted in serve_signal_status.js (twice) before this existed, which is the same "two
 * implementations of one rule drift" failure mode documented throughout this project.
 */
export function buildOpenBySymbolTf() {
  const snapshots = readPerfSnapshots();
  const openBySymbolTf = {};
  for (const [key, perf] of Object.entries(snapshots)) {
    openBySymbolTf[key] = {
      openPct: (perf.openPLPercent || 0) * 100,
      maxDDPct: (perf.maxDDPercent || 0) * 100,
    };
  }
  return openBySymbolTf;
}

export function recordPerfSnapshot(ticker, tfLabel, perf) {
  if (!ticker || !tfLabel) return;
  try {
    const all = readPerfSnapshots();
    all[`${ticker}|${tfLabel}`] = perf;
    const dir = dirname(PERF_SNAPSHOT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PERF_SNAPSHOT_PATH, JSON.stringify(all, null, 2), "utf8");
  } catch (err) {
    // Never fail a scan over an analysis artifact.
    console.error(`[trade-log] perf snapshot write failed: ${err?.message || err}`);
  }
}

// Existing keys are read straight out of the CSV rather than kept in a side index, so the file
// stays the single source of truth — hand-editing or deleting it just works.
/**
 * Stable identity of one closed trade.
 *
 * Entry time alone is NOT unique: a margin call (and partial liquidation generally) splits one
 * position into multiple rows sharing an entry timestamp — keying on entry time alone silently
 * dropped 2 of MEXX|15m's 11 closed trades. Exit time separates them, because such a row closes on
 * its own entry bar (verified: all 88 margin-call rows in the log have entry_time_ms ===
 * exit_time_ms) while the real trade exits later. Both are frozen once a trade closes, so the key is
 * stable across rescans.
 *
 * `rule_type` is part of the identity, not just a label. The same entry under two exit-rule variants
 * is two distinct observations, and any trade a new rule did not alter would otherwise collide with
 * its baseline row and be dropped — leaving the comparison run holding only the trades that changed,
 * which is precisely the wrong sample.
 *
 * Quantity is deliberately NOT part of the key. It was, until `default_qty_value` changed from 100
 * to 95 to stop margin calls: position sizing shifts qty on every trade, so a qty-bearing key made
 * every already-logged trade look new and would have appended a near-complete duplicate of the
 * entire history on the next rescan. It was also redundant — all 1,485 rows were already unique
 * without it. Anything that varies with account state, rather than identifying the trade, must stay
 * out of this key.
 */
function tradeKey({ ruleType, ticker, tfLabel, entryMs, exitMs }) {
  return `${ruleType}|${ticker}|${tfLabel}|${entryMs}|${exitMs || "open"}`;
}

/**
 * Keys already present in a file, recomputed from each row's own columns rather than read out of the
 * stored `trade_key` cell. Deriving them means a change to the key format can never desync from
 * previously written rows and force a migration — the comparison is always like-for-like.
 */
function existingKeys(filePath) {
  const keys = new Set();
  if (!existsSync(filePath)) return keys;
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return keys;
  const header = splitCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const iRule = idx("rule_type"), iTicker = idx("ticker"), iTf = idx("timeframe");
  const iEntry = idx("entry_time_ms"), iExit = idx("exit_time_ms");
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = splitCsvLine(lines[i]);
    // A file predating any of these columns can't be re-keyed; fall back to its stored key so the
    // rows at least still count as present rather than being duplicated wholesale.
    if (iTicker === -1 || iTf === -1 || iEntry === -1) {
      if (c[0]) keys.add(c[0]);
      continue;
    }
    keys.add(tradeKey({
      ruleType: (iRule === -1 ? "" : c[iRule]) || UNKNOWN_RULE_TYPE,
      ticker: c[iTicker],
      tfLabel: c[iTf],
      entryMs: c[iEntry],
      exitMs: iExit === -1 ? "" : c[iExit],
    }));
  }
  return keys;
}

/**
 * Harvest closed trades for the symbol/timeframe currently displayed and append new ones.
 *
 * `verifySymbol`/`verifyTimeframe` guard against a scheduled scan navigating the chart out from
 * under us between the caller's setSymbol and this read — logging DUSL's trades under FAS's row
 * would quietly poison the dataset, and a skipped scan is recoverable where bad rows are not.
 */
/**
 * Read the trade list, waiting until it stops growing.
 *
 * TradingView loads bars progressively after a symbol/resolution change, and the strategy backtests
 * whatever is loaded *at that instant*. A single read taken too early silently returns a truncated
 * history — not an error, just fewer trades — and those rows look perfectly valid on disk.
 *
 * This was measured, not theorised: the original daily backfill captured NVDA|1D as ONE trade
 * spanning two weeks where a later read of the same symbol returned ten trades spanning seven years.
 * 11 of 26 daily tickers were short of history that way, which silently invalidated an entire
 * variant comparison — the truncated baseline looked like a strategy difference.
 *
 * Daily needs far more wall-clock to load than intraday, so a flat sleep can't be tuned once and
 * trusted. Instead poll until the trade count and the span endpoints repeat, which is the same
 * stability contract `readStableStrategyReportData` uses in data.js for the live trade.
 *
 * Growth is one-directional (bars only get added), so a repeat means loading has settled. Bounded so
 * a genuinely empty symbol doesn't stall the walk.
 */
async function readStableTrades(studyFilter, { attempts = 6, waitMs = 900 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const signature = (rd) => {
    const t = rd?.trades || [];
    if (!t.length) return "empty";
    const first = t[0]?.e?.tm ?? "?";
    const last = t[t.length - 1]?.e?.tm ?? "?";
    // Bar count matters as well as trade count: history can extend without adding a closed trade.
    return `${t.length}|${first}|${last}|${rd.totalOpenTrades ?? "?"}`;
  };

  let prev = await readAllTrades(studyFilter);
  if (prev?.error) return prev;
  let prevSig = signature(prev);

  for (let i = 1; i < attempts; i++) {
    await sleep(waitMs);
    const next = await readAllTrades(studyFilter);
    if (next?.error) return next;
    const nextSig = signature(next);
    if (nextSig === prevSig) return next;
    prev = next;
    prevSig = nextSig;
  }
  // Still moving after the last attempt: return the most recent (largest) read rather than an error,
  // and flag it so the caller can surface that this row set may be short.
  return { ...prev, unstableHistory: true };
}

export async function logClosedTrades({
  symbol,
  timeframe,
  watchlist_name = "",
  study_filter,
  timezone = "America/New_York",
  verify = true,
} = {}) {
  const rd = await readStableTrades(study_filter);
  if (rd?.error) return { success: false, error: rd.error, appended: 0 };

  if (verify) {
    if (symbol && tickerOf(rd.actualSymbol) !== tickerOf(symbol)) {
      return { success: false, error: `symbol_mismatch: chart=${rd.actualSymbol} want=${symbol}`, appended: 0 };
    }
    if (timeframe && timeframeLabel(rd.actualRes) !== timeframeLabel(timeframe)) {
      return { success: false, error: `timeframe_mismatch: chart=${rd.actualRes} want=${timeframe}`, appended: 0 };
    }
  }

  // Fall back to the chart's own resolution when the caller didn't pass one, and refuse to write
  // at all if neither resolves. Silently filing rows into trades-unknown.csv would strand them
  // outside every per-timeframe analysis while looking like a success.
  const effectiveTimeframe = timeframe || rd.actualRes;
  if (!effectiveTimeframe || timeframeLabel(effectiveTimeframe) === "unknown") {
    return { success: false, error: `unresolved_timeframe: want=${timeframe ?? "(none)"} chart=${rd.actualRes ?? "(none)"}`, appended: 0 };
  }

  // Persist the perf snapshot even when there are no closed trades to append — an all-open
  // symbol still has a drawdown and an unrealized loss the analysis needs.
  if (rd.perf) {
    recordPerfSnapshot(tickerOf(symbol || rd.actualSymbol), timeframeLabel(effectiveTimeframe), {
      ...rd.perf,
      symbol: symbol || rd.actualSymbol,
      watchlist: watchlist_name,
      updated_at: new Date().toISOString(),
    });
  }

  const trades = rd.trades || [];
  // The still-open position is appended as the LAST element with a synthesized mark-to-market
  // exit row. It is not a closed trade and must never be logged — it would be written with a
  // fabricated exit price that changes on every bar.
  const closed = rd.totalOpenTrades > 0 && trades.length > 0 ? trades.slice(0, -1) : trades;
  if (!closed.length) return { success: true, appended: 0, scanned: 0 };

  ensureDir();
  const filePath = tradeLogPath(effectiveTimeframe);
  // Keys already on disk and keys seen within THIS batch are tracked separately on purpose.
  // Re-encountering a row that is already in the file is the normal steady state of every rescan;
  // encountering the same key twice inside one read means the strategy emitted two indistinguishable
  // rows, which is the margin-call/partial-liquidation signal `collapsed_identical` exists to
  // surface. Sharing one set conflated the two and made the warning fire on every rescan.
  const preExisting = existingKeys(filePath);
  const batchSeen = new Set();
  const reconciled = reconcileRuleType(ruleTypeFromInputs(rd.inputs), rd.runtimeExitRules, rd.runtimePyramid);
  const ruleType = reconciled.ruleType;
  if (reconciled.mismatch) {
    console.warn(
      `[trade_log] exit-rule mismatch on ${symbol || rd.actualSymbol} ${tfLabelForWarn(timeframe, rd)}: ` +
      `inputs say "${reconciled.mismatch.derived_from_inputs}" but the strategy reports ` +
      `"${reconciled.mismatch.strategy_reported}". Logging as "${UNKNOWN_RULE_TYPE}" — ` +
      `set the toggle in the indicator's settings dialog (the properties API does not reach the Pine engine).`
    );
  }
  const ticker = tickerOf(symbol || rd.actualSymbol);
  const tfLabel = timeframeLabel(effectiveTimeframe);
  const loggedAt = new Date().toISOString();

  const rows = [];
  let noEntryTime = 0;
  let collapsed = 0;
  let alreadyLogged = 0;
  for (const t of closed) {
    const entryMs = t?.e?.tm;
    const exitMs = t?.x?.tm;
    // No entry timestamp means no stable identity — such a row could be appended again on every
    // future scan. Skip it rather than inventing a key (see CLAUDE.md: never fabricate times).
    if (!entryMs) { noEntryTime++; continue; }
    const key = tradeKey({ ruleType, ticker, tfLabel, entryMs, exitMs });
    if (preExisting.has(key)) { alreadyLogged++; continue; }
    if (batchSeen.has(key)) { collapsed++; continue; }
    batchSeen.add(key);

    const barsHeld = Number.isFinite(t?.x?.b) && Number.isFinite(t?.e?.b) ? t.x.b - t.e.b : "";
    rows.push([
      key,
      ruleType,
      ticker,
      symbol || rd.actualSymbol || "",
      tfLabel,
      watchlist_name,
      sideFromEntryCode(t?.e?.tp),
      t?.e?.c || "",
      etTimestamp(entryMs, timezone),
      entryMs,
      num(t?.e?.p),
      t?.x?.c || "",
      etTimestamp(exitMs, timezone),
      exitMs || "",
      num(t?.x?.p),
      num(t?.q, 6),
      num(t?.v, 2),
      barsHeld,
      num(t?.tp?.v, 2),
      pct(t?.tp?.p),
      num(t?.rn?.v, 2),
      pct(t?.rn?.p),
      num(t?.dd?.v, 2),
      pct(t?.dd?.p),
      num(t?.cm, 2),
      loggedAt,
    ].map(csvEscape).join(","));
  }

  if (!existsSync(filePath)) writeFileSync(filePath, `${COLUMNS.join(",")}\n`, "utf8");
  if (rows.length) appendFileSync(filePath, `${rows.join("\n")}\n`, "utf8");

  return {
    success: true,
    file: filePath,
    timeframe: tfLabel,
    scanned: closed.length,
    appended: rows.length,
    // True when the trade list was still growing when we gave up polling, i.e. this row set may be
    // short on history. Surfaced so a backfill can report it instead of writing silently.
    unstable_history: rd.unstableHistory === true,
    // Broken out rather than lumped into one "skipped" count: already_logged is the normal
    // steady state, but no_entry_time and collapsed_identical mean trades are being dropped, and
    // that needs to be visible rather than inferred from arithmetic.
    already_logged: alreadyLogged,
    no_entry_time: noEntryTime,
    collapsed_identical: collapsed,
  };
}

/**
 * Rows written before the `rule_type` column existed, or by a read where the strategy inputs
 * couldn't be resolved, must never compare equal to a real variant — they get an explicit label so
 * downstream filters can include or exclude them deliberately.
 */
export const UNKNOWN_RULE_TYPE = "unknown";

function normalizeRuleType(row) {
  if (!row.rule_type) row.rule_type = UNKNOWN_RULE_TYPE;
  return row;
}

/** Parse one timeframe's CSV back into objects (numbers coerced) for analysis. */
export function readTradeLog(timeframe) {
  const filePath = tradeLogPath(timeframe);
  if (!existsSync(filePath)) return [];
  return parseCsv(readFileSync(filePath, "utf8")).map(normalizeRuleType);
}

/**
 * Every timeframe's log, concatenated.
 *
 * `ruleType` (string or array) restricts the result to one or more exit-rule variants. This matters
 * because the logs are deliberately append-only across variants: once a run happens with a toggle
 * on, `flip-only` baseline trades and `ts60`/`sl-auto` trades coexist in the same files. Pooling
 * them would silently average two different strategies together and read as a single edge — the
 * exact comparison this column exists to make possible. Omitting the option keeps every row, which
 * is correct for inventory/coverage questions but wrong for performance ones.
 */
/**
 * Parse cache, keyed on every log file's size+mtime. Measured 2026-07-31: the full read is ~190 ms
 * for 2 MB / 7,481 rows and nothing cached it, so an Edge Analysis tab load (edge + concurrency +
 * sim) re-parsed the same bytes three times for ~500 ms of pure overhead. Parameter sweeps make that
 * pathological — a few thousand simulations would spend minutes re-reading identical files.
 *
 * Invalidation is by content signature, not by time: a scan appends to these files while the
 * dashboard server is long-lived, so an interval-based cache would serve a stale log after a scan.
 * The signature costs one stat() per file (microseconds) and cannot go stale, because the very act
 * that would invalidate it — an append — changes both size and mtime.
 */
let tradeLogCache = { signature: null, rows: null };

function tradeLogSignature(files) {
  return files.map((f) => {
    const s = statSync(join(TRADE_LOG_DIR, f));
    return `${f}:${s.size}:${s.mtimeMs}`;
  }).join("|");
}

/**
 * Is this row's (ticker, timeframe) pair still scanned today?
 *
 * The pair granularity is the whole point and cannot be expressed by `simulatePortfolio`'s existing
 * ticker-level `tickers` option: a symbol dropped from the 30m watchlist while still live on 3h is
 * a member as a *ticker* and a non-member as a *pair*. Measured 2026-08-01, filtering by ticker
 * changed nothing at all (all 133 logged tickers remain a member somewhere) while the pair filter
 * removes 321 rows.
 */
function isActiveMember(row, membership) {
  const set = membership.byTimeframe.get(timeframeLabel(row.timeframe));
  if (!set) return false;
  return set.has(String(row.ticker ?? "").split(":").pop().toUpperCase());
}

/**
 * @param membership  Result of `buildWatchlistMembership()` (universe.js). When given, only trades
 *                    whose (ticker, timeframe) pair is STILL in a configured watchlist are returned,
 *                    so analysis describes a book that can actually be traded rather than one
 *                    containing symbols that can never signal again.
 *
 *                    An empty membership map means "unknown", not "nothing is tradable", and is
 *                    ignored — the same convention `buildUniverse` and `findWatchlistOrphans` use,
 *                    and for the same reason: a failed watchlist read must not silently empty every
 *                    analysis on the dashboard.
 *
 *                    Note this is a FORWARD-looking lens. Those trades genuinely happened while the
 *                    symbol was scanned, so excluding them is survivorship filtering by
 *                    construction. Measured on the real log it is a mild one — the excluded rows
 *                    average 3.31%/trade against 3.74% for the kept ones, moving pooled expectancy
 *                    by +0.03pp, and the per-timeframe tilt changes sign (1d and 4h get *worse*) —
 *                    but a caller asking "what would this config have returned historically" should
 *                    still omit this option.
 */
export function readAllTradeLogs({ ruleType = null, membership = null } = {}) {
  if (!existsSync(TRADE_LOG_DIR)) return [];
  // Non-recursive by design: this is what keeps `trade-log/archive/` out of every analysis. The
  // `.csv` anchor likewise drops the `.pre-*-key` migration backups sitting next to the live files.
  const files = readdirSync(TRADE_LOG_DIR).filter((f) => /^trades-.*\.csv$/.test(f)).sort();

  let all;
  let signature = null;
  try {
    signature = tradeLogSignature(files);
  } catch { /* a file vanishing mid-stat just means no caching this call */ }
  if (signature && tradeLogCache.signature === signature) {
    all = tradeLogCache.rows;
  } else {
    all = [];
    for (const file of files) {
      all.push(...parseCsv(readFileSync(join(TRADE_LOG_DIR, file), "utf8")).map(normalizeRuleType));
    }
    if (signature) tradeLogCache = { signature, rows: all };
  }

  // Callers mutate rows in places (normalizeRuleType, and analysis code that annotates), so the
  // cached array is never handed out directly — a filtered copy is, and the unfiltered case gets a
  // shallow copy of the array. Rows themselves are shared; treat them as read-only, which every
  // current consumer already does.
  const gate = membership && membership.total ? membership : null;
  if (ruleType == null) return gate ? all.filter((r) => isActiveMember(r, gate)) : all.slice();
  const wanted = new Set((Array.isArray(ruleType) ? ruleType : [ruleType]).map(String));
  return all.filter((r) => wanted.has(r.rule_type) && (!gate || isActiveMember(r, gate)));
}

/**
 * What the membership gate is actually removing, for display.
 *
 * Every gated surface reports this rather than quietly returning a smaller number: a config whose
 * CAGR moved because six symbols left the watchlist looks identical to one whose CAGR moved because
 * the strategy changed, and only this distinguishes them.
 */
export function summarizeMembershipFilter(membership, { ruleType = null } = {}) {
  if (!membership || !membership.total) {
    return { applied: false, reason: membership ? "empty_membership" : "not_requested", pairs: 0, excludedRows: 0, excludedPairs: [] };
  }
  const all = readAllTradeLogs({ ruleType });
  const byPair = new Map();
  for (const r of all) {
    if (isActiveMember(r, membership)) continue;
    const key = `${String(r.ticker ?? "").split(":").pop().toUpperCase()}|${timeframeLabel(r.timeframe)}`;
    byPair.set(key, (byPair.get(key) || 0) + 1);
  }
  const excludedPairs = [...byPair.entries()]
    .map(([pair, trades]) => ({ pair, ticker: pair.split("|")[0], timeframe: pair.split("|")[1], trades }))
    .sort((a, b) => b.trades - a.trades);
  return {
    applied: true,
    pairs: membership.total,
    totalRows: all.length,
    excludedRows: excludedPairs.reduce((s, p) => s + p.trades, 0),
    excludedPairs,
  };
}

/**
 * Inventory of the exit-rule variants present in the logs, most-traded first.
 *
 * Drives the dashboard's variant selector, and answers "has the A/B run actually produced data
 * yet?" without loading every row into the caller.
 */
export function listRuleTypes() {
  const byRule = new Map();
  for (const r of readAllTradeLogs()) {
    let e = byRule.get(r.rule_type);
    if (!e) {
      e = { rule_type: r.rule_type, trades: 0, tickers: new Set(), timeframes: new Set(), firstMs: null, lastMs: null };
      byRule.set(r.rule_type, e);
    }
    e.trades++;
    if (r.ticker) e.tickers.add(r.ticker);
    if (r.timeframe) e.timeframes.add(r.timeframe);
    // Span is measured on entries so a still-running variant reads as ongoing rather than complete.
    if (r.entry_time_ms) {
      if (e.firstMs === null || r.entry_time_ms < e.firstMs) e.firstMs = r.entry_time_ms;
      if (e.lastMs === null || r.entry_time_ms > e.lastMs) e.lastMs = r.entry_time_ms;
    }
  }
  return [...byRule.values()]
    .map((e) => ({
      ...e,
      tickers: e.tickers.size,
      timeframes: [...e.timeframes].sort((a, b) => tfSortRank(a) - tfSortRank(b)),
    }))
    .sort((a, b) => b.trades - a.trades);
}

const TF_SORT_ORDER = ["15m", "30m", "45m", "1h", "2h", "3h", "4h", "1d"];
function tfSortRank(label) {
  const i = TF_SORT_ORDER.indexOf(label);
  return i === -1 ? 999 : i;
}

/**
 * Tickers with active (non-archived) closed-trade history that are no longer a member of ANY
 * current watchlist. Read-only inventory — nothing is moved here. See
 * `scripts/archive_trade_log.js` for the actual archive action, which this is meant to make
 * discoverable without remembering to run `--dry-run`: `morning.js` calls this right after a live
 * watchlist reconciliation (the twice-daily sync, not every scan) and persists the result onto the
 * baseline so a symbol that drops out of every watchlist shows up on the dashboard on its own.
 */
export function findWatchlistOrphans(baseline, watchlistNames = null) {
  // baseline.watchlists accumulates dead entries under old names forever — nothing ever prunes
  // them on a rename, since syncWatchlistSymbolsFromTradingView only iterates rules.json's
  // currently-configured names. Without this filter, a ticker sitting only under a stale/renamed
  // watchlist name (never actually scanned) would read as "still in a watchlist" and never surface
  // here. When watchlistNames isn't given, fall back to trusting every baseline entry.
  const allowedNames = Array.isArray(watchlistNames) ? new Set(watchlistNames) : null;
  const inWatchlists = new Set();
  for (const [name, w] of Object.entries(baseline?.watchlists || {})) {
    if (allowedNames && !allowedNames.has(name)) continue;
    for (const s of w?.symbols || []) {
      const t = String(s ?? "").split(":").pop().toUpperCase();
      if (t) inWatchlists.add(t);
    }
  }
  // Empty membership cannot be distinguished from "every logged ticker is orphaned", and the wrong
  // reading of that would offer to archive the entire trade log. A baseline with no usable watchlist
  // data means "unknown", so report nothing rather than everything. This matters because the caller
  // no longer waits for a live resync before computing — see runSignalJob.
  if (inWatchlists.size === 0) return [];

  const byTicker = new Map();
  for (const r of readAllTradeLogs()) {
    const ticker = String(r.ticker ?? "").split(":").pop().toUpperCase();
    if (!ticker || inWatchlists.has(ticker)) continue;
    let e = byTicker.get(ticker);
    if (!e) {
      e = { ticker, trades: 0, timeframes: new Set(), lastTradeMs: null, lastTimeframe: null };
      byTicker.set(ticker, e);
    }
    e.trades++;
    if (r.timeframe) e.timeframes.add(r.timeframe);
    // "Last trade" is the most recent exit, not entry — an orphan's closed history is what's
    // sitting idle in Edge Analysis/Portfolio Sim, and exit is when it actually stopped mattering.
    if (r.exit_time_ms && (e.lastTradeMs === null || r.exit_time_ms > e.lastTradeMs)) {
      e.lastTradeMs = r.exit_time_ms;
      e.lastTimeframe = r.timeframe || e.lastTimeframe;
    }
  }
  return [...byTicker.values()]
    .map((e) => ({
      ticker: e.ticker,
      trades: e.trades,
      timeframes: [...e.timeframes].sort((a, b) => tfSortRank(a) - tfSortRank(b)),
      lastTimeframe: e.lastTimeframe,
      lastTradeAt: e.lastTradeMs ? new Date(e.lastTradeMs).toISOString() : null,
    }))
    .sort((a, b) => b.trades - a.trades);
}

const NUMERIC_COLUMNS = new Set([
  "entry_time_ms", "entry_price", "exit_time_ms", "exit_price", "qty",
  "position_value", "bars_held", "pnl_usd", "pnl_pct",
  "mfe_usd", "mfe_pct", "mae_usd", "mae_pct", "commission",
]);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    header.forEach((col, idx) => {
      const raw = cells[idx] ?? "";
      row[col] = NUMERIC_COLUMNS.has(col) ? (raw === "" ? null : Number(raw)) : raw;
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
