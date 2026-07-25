#!/usr/bin/env node
/**
 * Backfill trade-log/trades-<tf>.csv from every symbol currently in the baseline's watchlists.
 *
 * Scans populate the log incrementally from then on (see scanSymbol in src/core/morning.js);
 * this walks the whole universe once so the log starts out with full history instead of only
 * trades that close from today forward.
 *
 * Safe to re-run: rows are deduplicated by rule_type|ticker|timeframe|entry_time_ms|exit_time_ms,
 * so a second pass appends only trades that closed since the first. Because the exit-rule variant is
 * part of that identity, re-running with a different toggle set on the chart seeds that variant's
 * full history rather than colliding with the existing baseline.
 *
 * Usage:
 *   node scripts/backfill_trade_log.js              # all watchlists
 *   node scripts/backfill_trade_log.js --tf 15,240  # only these timeframes
 */
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "../src/core/chart.js";
import * as tradeLog from "../src/core/trade_log.js";
import { disconnect } from "../src/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

const tfFilter = arg("tf") ? new Set(arg("tf").split(",").map((s) => s.trim())) : null;

const rules = JSON.parse(readFileSync(join(PROJECT_ROOT, "rules.json"), "utf8"));
const studyFilter = String(rules.strategy || "Swing Profile").split("—")[0].trim();
const baseline = JSON.parse(readFileSync(join(PROJECT_ROOT, "swing-signal-baseline.json"), "utf8"));

const targets = [];
const seen = new Set();
for (const [name, w] of Object.entries(baseline.watchlists || {})) {
  const tf = String(w.timeframe);
  if (tfFilter && !tfFilter.has(tf)) continue;
  for (const symbol of w.symbols || []) {
    const key = `${symbol}|${tf}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ watchlist: name, symbol, tf });
  }
}

console.log(`Backfilling ${targets.length} symbol/timeframe combos...`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let totalAppended = 0;
let failures = 0;
let unstable = 0;

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  let result = null;
  // logClosedTrades verifies the chart really is on this symbol/timeframe before writing, so a
  // collision with the 15-minute scheduled scan produces a retry, never a mislabeled row.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chart.setSymbol({ symbol: t.symbol, wait_timeout: 4000 });
      await chart.setTimeframe({ timeframe: t.tf, wait_timeout: 4000 });
    } catch { /* verification below decides whether this mattered */ }
    await sleep(700);
    result = await tradeLog.logClosedTrades({
      symbol: t.symbol,
      timeframe: t.tf,
      watchlist_name: t.watchlist,
      study_filter: studyFilter,
    });
    if (result?.success) break;
    await sleep(1200);
  }

  if (result?.success) {
    totalAppended += result.appended;
    const flags = [];
    if (result.no_entry_time) flags.push(`no-entry-time:${result.no_entry_time}`);
    if (result.collapsed_identical) flags.push(`identical:${result.collapsed_identical}`);
    // A short read writes valid-looking rows that silently understate history, which is exactly how
    // the daily baseline got truncated. Count it so the summary can flag the run as suspect.
    if (result.unstable_history) { flags.push("UNSTABLE-HISTORY"); unstable++; }
    console.log(`[${i + 1}/${targets.length}] ${t.symbol}|${t.tf} +${result.appended} (of ${result.scanned})${flags.length ? "  [" + flags.join(" ") + "]" : ""}`);
  } else {
    failures++;
    console.log(`[${i + 1}/${targets.length}] ${t.symbol}|${t.tf} FAILED: ${result?.error || "unknown"}`);
  }
}

console.log(`\nDone. Appended ${totalAppended} trades, ${failures} failures.`);
if (unstable) {
  console.log(`WARNING: ${unstable} symbol(s) were still loading history when read — those row sets may be short. Re-run to top them up.`);
}
console.log(`Files in ${tradeLog.TRADE_LOG_DIR}`);

// The open CDP socket keeps the event loop alive forever, so without this the process finishes its
// work, prints the summary, and then hangs as a zombie holding a connection. Eight of those
// accumulated in one session and starved a later run of a usable CDP session — it produced no
// output at all until they were killed. Close explicitly, then force exit in case anything else
// (timers, listeners) is still registered.
try { await disconnect(); } catch { /* already gone */ }
process.exit(failures > 0 ? 1 : 0);
