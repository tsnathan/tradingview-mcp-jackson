#!/usr/bin/env node
/**
 * Move a dropped symbol's closed-trade history out of the active log into trade-log/archive/.
 *
 * Nothing in this project ever deletes logged trades, so a symbol removed from a watchlist keeps
 * its rows forever — the history is safe either way. The problem archiving solves is different:
 * those rows keep appearing in the Edge Analysis rankings and the Portfolio Sim, so a symbol you
 * consciously stopped trading still influences which timeframe looks best and still consumes
 * simulated position slots. Archiving keeps the record while removing it from live analysis.
 *
 * `readAllTradeLogs()` globs `trades-*.csv` at the top level only, so files under `archive/` are
 * excluded from every analysis automatically — no filtering needed downstream.
 *
 * Rows are moved by raw line, never parsed and re-serialized, so archived history is byte-identical
 * to what was originally written (no float-formatting drift on a round trip).
 *
 * Usage:
 *   node scripts/archive_trade_log.js --dry-run              # preview orphans (default if no args)
 *   node scripts/archive_trade_log.js --orphans              # archive every ticker no longer in a watchlist
 *   node scripts/archive_trade_log.js --symbol DXYZ,TMF      # archive these tickers explicitly
 *   node scripts/archive_trade_log.js --symbol DXYZ --tf 45m # only that ticker's 45m rows
 *   node scripts/archive_trade_log.js --restore DXYZ         # move rows back into the active log
 *   node scripts/archive_trade_log.js --list                 # show what is archived
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TRADE_LOG_DIR, timeframeLabel, readPerfSnapshots, PERF_SNAPSHOT_PATH } from "../src/core/trade_log.js";
import { readJsonFile } from '../src/json_file.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const ARCHIVE_DIR = join(TRADE_LOG_DIR, "archive");
const ARCHIVE_PERF_PATH = join(ARCHIVE_DIR, "strategy-perf-archived.json");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);
const csvArg = (name) => {
  const v = arg(name);
  return v ? v.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
};

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function activeLogFiles() {
  if (!existsSync(TRADE_LOG_DIR)) return [];
  return readdirSync(TRADE_LOG_DIR).filter((f) => /^trades-.*\.csv$/.test(f));
}
function archivedLogFiles() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR).filter((f) => /^trades-.*\.csv$/.test(f));
}

function readParts(filePath) {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const header = lines[0];
  const tickerIdx = splitCsvLine(header).indexOf("ticker");
  const tfIdx = splitCsvLine(header).indexOf("timeframe");
  if (tickerIdx === -1) throw new Error(`${filePath}: no 'ticker' column in header`);
  const body = lines.slice(1).filter((l) => l.length > 0);
  return { header, body, tickerIdx, tfIdx };
}

function watchlistTickers() {
  const baselinePath = join(PROJECT_ROOT, "swing-signal-baseline.json");
  if (!existsSync(baselinePath)) return null;
  const b = readJsonFile(baselinePath);
  const set = new Set();
  for (const w of Object.values(b.watchlists || {})) {
    for (const s of w.symbols || []) set.add(String(s).split(":").pop().toUpperCase());
  }
  return set;
}

if (has("list")) {
  const files = archivedLogFiles();
  if (!files.length) { console.log("Nothing archived."); process.exit(0); }
  console.log(`Archived history in ${ARCHIVE_DIR}:\n`);
  let total = 0;
  for (const f of files) {
    const { body, tickerIdx } = readParts(join(ARCHIVE_DIR, f));
    const byTicker = {};
    for (const line of body) {
      const t = splitCsvLine(line)[tickerIdx];
      byTicker[t] = (byTicker[t] || 0) + 1;
    }
    total += body.length;
    const summary = Object.entries(byTicker).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}(${n})`).join(" ");
    console.log(`  ${f.padEnd(22)} ${String(body.length).padStart(4)} rows   ${summary}`);
  }
  console.log(`\n${total} archived rows total. These are excluded from Edge Analysis and Portfolio Sim.`);
  process.exit(0);
}

const restore = csvArg("restore");
const explicit = csvArg("symbol");
const tfFilter = arg("tf") ? timeframeLabel(arg("tf")) : null;
const wantOrphans = has("orphans");
// Default to a preview rather than mutating the log when invoked with no action.
const dryRun = has("dry-run") || (!restore && !explicit && !wantOrphans);

/* ---------- restore ---------- */
if (restore) {
  if (!existsSync(ARCHIVE_DIR)) { console.log("Nothing archived."); process.exit(0); }
  let moved = 0;
  for (const f of archivedLogFiles()) {
    const archPath = join(ARCHIVE_DIR, f);
    const { header, body, tickerIdx, tfIdx } = readParts(archPath);
    const keep = [];
    const back = [];
    for (const line of body) {
      const cells = splitCsvLine(line);
      const matches = restore.includes(cells[tickerIdx]) && (!tfFilter || cells[tfIdx] === tfFilter);
      (matches ? back : keep).push(line);
    }
    if (!back.length) continue;
    const activePath = join(TRADE_LOG_DIR, f);
    if (!existsSync(activePath)) writeFileSync(activePath, `${header}\n`, "utf8");
    appendFileSync(activePath, `${back.join("\n")}\n`, "utf8");
    writeFileSync(archPath, keep.length ? `${header}\n${keep.join("\n")}\n` : `${header}\n`, "utf8");
    moved += back.length;
    console.log(`  ${f}: restored ${back.length} rows`);
  }
  console.log(moved ? `\nRestored ${moved} rows to the active log.` : "No matching archived rows.");
  process.exit(0);
}

/* ---------- work out which tickers to archive ---------- */
let targets = explicit;
if (wantOrphans || (dryRun && !explicit)) {
  const inWatchlists = watchlistTickers();
  if (!inWatchlists) {
    console.error("Cannot determine watchlist membership (no swing-signal-baseline.json). Use --symbol instead.");
    process.exit(1);
  }
  const logged = new Set();
  for (const f of activeLogFiles()) {
    const { body, tickerIdx } = readParts(join(TRADE_LOG_DIR, f));
    for (const line of body) logged.add(splitCsvLine(line)[tickerIdx]);
  }
  const orphans = [...logged].filter((t) => !inWatchlists.has(t)).sort();
  if (explicit) targets = [...new Set([...explicit, ...orphans])];
  else targets = orphans;
  console.log(`Watchlist tickers: ${inWatchlists.size} · logged tickers: ${logged.size}`);
  console.log(`Orphans (logged but no longer in any watchlist): ${orphans.length}${orphans.length ? " — " + orphans.join(", ") : ""}`);
}

if (!targets || !targets.length) {
  console.log("\nNothing to archive.");
  process.exit(0);
}

/* ---------- move rows ---------- */
console.log(`\n${dryRun ? "[DRY RUN] Would archive" : "Archiving"}: ${targets.join(", ")}${tfFilter ? ` (timeframe ${tfFilter} only)` : ""}\n`);
if (!dryRun && !existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

let totalMoved = 0;
for (const f of activeLogFiles()) {
  const activePath = join(TRADE_LOG_DIR, f);
  const { header, body, tickerIdx, tfIdx } = readParts(activePath);
  const keep = [];
  const move = [];
  for (const line of body) {
    const cells = splitCsvLine(line);
    const matches = targets.includes(cells[tickerIdx]) && (!tfFilter || cells[tfIdx] === tfFilter);
    (matches ? move : keep).push(line);
  }
  if (!move.length) continue;
  totalMoved += move.length;
  console.log(`  ${f.padEnd(22)} ${String(move.length).padStart(4)} rows -> archive  (${keep.length} remain)`);
  if (dryRun) continue;

  const archPath = join(ARCHIVE_DIR, f);
  if (!existsSync(archPath)) writeFileSync(archPath, `${header}\n`, "utf8");
  appendFileSync(archPath, `${move.join("\n")}\n`, "utf8");
  // Rewrite the active file without the moved rows. Header is preserved even when empty so the
  // file stays valid and future scans append to it normally.
  writeFileSync(activePath, keep.length ? `${header}\n${keep.join("\n")}\n` : `${header}\n`, "utf8");
}

if (!totalMoved) {
  console.log("  (no matching rows found in the active log)");
  process.exit(0);
}

/* ---------- move the perf snapshots too ---------- */
// A dropped symbol never gets scanned again, so its drawdown/open-P&L snapshot would sit stale in
// status/strategy-perf.json forever. Park it alongside the archived rows so --restore is complete.
if (!dryRun) {
  const snaps = readPerfSnapshots();
  const archivedSnaps = existsSync(ARCHIVE_PERF_PATH) ? readJsonFile(ARCHIVE_PERF_PATH) : {};
  let movedSnaps = 0;
  for (const key of Object.keys(snaps)) {
    const [ticker, tf] = key.split("|");
    if (!targets.includes(ticker)) continue;
    if (tfFilter && tf !== tfFilter) continue;
    archivedSnaps[key] = snaps[key];
    delete snaps[key];
    movedSnaps++;
  }
  if (movedSnaps) {
    writeFileSync(ARCHIVE_PERF_PATH, JSON.stringify(archivedSnaps, null, 2), "utf8");
    writeFileSync(PERF_SNAPSHOT_PATH, JSON.stringify(snaps, null, 2), "utf8");
    console.log(`\n  moved ${movedSnaps} perf snapshot(s) to archive`);
  }
}

console.log(`\n${dryRun ? "Would move" : "Moved"} ${totalMoved} rows.`);
if (dryRun) console.log("Re-run with --orphans (or --symbol ...) to apply.");
else {
  console.log(`Archive: ${ARCHIVE_DIR}`);
  console.log("Archived rows are excluded from Edge Analysis and Portfolio Sim. Restore with --restore TICKER.");
}
