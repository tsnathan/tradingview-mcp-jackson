#!/usr/bin/env node
/**
 * One-time migration: add the `rule_type` column to existing trade logs and rewrite `trade_key`
 * to the new `<rule>|<ticker>|<tf>|<entry>|<exit>|<qty>` format.
 *
 * Without this, the first scan after the rule_type change would treat all 1,485 existing rows as
 * new (their old keys no longer match the format `logClosedTrades` now generates) and append a
 * complete duplicate set.
 *
 * Every existing row predates the exit-rule toggles, so all of them are `flip-only` by definition.
 *
 * Safe to re-run: rows already carrying a rule_type column are left untouched. Writes a
 * `.pre-rule-type` backup of each file before modifying it.
 *
 * Usage:
 *   node scripts/migrate_trade_log_rule_type.js --dry-run
 *   node scripts/migrate_trade_log_rule_type.js
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { TRADE_LOG_DIR } from "../src/core/trade_log.js";

const DRY = process.argv.includes("--dry-run");
const DEFAULT_RULE = "flip-only";

function splitCsvLine(line) {
  const cells = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
const esc = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

if (!existsSync(TRADE_LOG_DIR)) {
  console.log("No trade-log directory — nothing to migrate.");
  process.exit(0);
}

const files = readdirSync(TRADE_LOG_DIR).filter((f) => /^trades-.*\.csv$/.test(f));
if (!files.length) {
  console.log("No trade log files found.");
  process.exit(0);
}

let totalRows = 0, totalFiles = 0;
for (const file of files) {
  const path = join(TRADE_LOG_DIR, file);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) { console.log(`  ${file.padEnd(20)} empty, skipped`); continue; }

  const header = splitCsvLine(lines[0]);
  if (header.includes("rule_type")) {
    console.log(`  ${file.padEnd(20)} already migrated, skipped`);
    continue;
  }

  const tickerIdx = header.indexOf("ticker");
  const tfIdx = header.indexOf("timeframe");
  const entryIdx = header.indexOf("entry_time_ms");
  const exitIdx = header.indexOf("exit_time_ms");
  const qtyIdx = header.indexOf("qty");
  if ([tickerIdx, tfIdx, entryIdx, qtyIdx].some((i) => i === -1)) {
    console.error(`  ${file.padEnd(20)} MISSING required columns, skipped`);
    continue;
  }

  // rule_type sits immediately after trade_key, matching COLUMNS in trade_log.js.
  const newHeader = [header[0], "rule_type", ...header.slice(1)];
  const out = [newHeader.join(",")];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const key = `${DEFAULT_RULE}|${c[tickerIdx]}|${c[tfIdx]}|${c[entryIdx]}|${c[exitIdx] || "open"}|${c[qtyIdx]}`;
    out.push([esc(key), esc(DEFAULT_RULE), ...c.slice(1).map(esc)].join(","));
  }

  console.log(`  ${file.padEnd(20)} ${lines.length - 1} rows -> rule_type=${DEFAULT_RULE}`);
  totalRows += lines.length - 1;
  totalFiles++;
  if (!DRY) {
    copyFileSync(path, `${path}.pre-rule-type`);
    writeFileSync(path, `${out.join("\n")}\n`, "utf8");
  }
}

console.log(`\n${DRY ? "[DRY RUN] Would migrate" : "Migrated"} ${totalRows} rows across ${totalFiles} file(s).`);
if (DRY) console.log("Re-run without --dry-run to apply.");
else if (totalFiles) console.log("Backups written alongside as *.pre-rule-type");
