/**
 * Portfolio configuration sweep — which (timeframe set x max positions) actually performs?
 *
 * Regenerates every number in PORTFOLIO_RECKONER.md. Run it after the trade log has grown
 * materially; the answers are measured, not derived, so they can move.
 *
 *   node scripts/sweep_portfolio_grid.mjs                  # full: grid + walk-forward + shortlist
 *   node scripts/sweep_portfolio_grid.mjs --quick          # shortlist + structure only (~30s)
 *   node scripts/sweep_portfolio_grid.mjs --no-membership  # over ALL logged history, not just
 *                                                          # symbols still in a watchlist
 *
 * This is a FORMATTER. All measurement lives in src/core/sweet_spot.js, shared with the dashboard's
 * Sweet Spot tab — see that module's header for why the two must not have separate implementations.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSweetSpotAnalysis } from "../src/core/sweet_spot.js";
import { buildWatchlistMembership } from "../src/core/universe.js";
import { readJsonFile } from '../src/json_file.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = process.env.SWEEP_RULE || "flip-only";
const QUICK = process.argv.includes("--quick");

/**
 * Gated on current watchlist membership by DEFAULT, matching the dashboard's Sweet Spot tab. The two
 * must agree: this file's whole premise is that it is a formatter over the same measurement, and a
 * universe difference between them would show up as the doc and the tab quietly disagreeing.
 * `--no-membership` sweeps the full logged history instead.
 */
const membership = process.argv.includes("--no-membership") ? null : (() => {
  try {
    return buildWatchlistMembership(
      readJsonFile(join(ROOT, "rules.json")),
      readJsonFile(join(ROOT, "swing-signal-baseline.json")),
    );
  } catch {
    return null;  // unknown membership gates nothing, per the established convention
  }
})();

const pct = (v, w = 6) => (Number.isFinite(v) ? v.toFixed(1) : "—").padStart(w);

// Progress goes to stderr so `node scripts/sweep_portfolio_grid.mjs > out.txt` still captures a
// clean report, and so the line can be rewritten in place without shredding the output.
let lastPhase = "";
const onProgress = ({ phase, done, total }) => {
  if (!process.stderr.isTTY) {
    if (phase !== lastPhase) { process.stderr.write(`  [${phase}]\n`); lastPhase = phase; }
    return;
  }
  const p = Math.min(100, (done / total) * 100);
  process.stderr.write(`\r  ${phase.padEnd(14)} ${p.toFixed(0).padStart(3)}%  (${done}/${total})   `);
};

const r = runSweetSpotAnalysis({ ruleType: RULE, quick: QUICK, membership, onProgress });
if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(60) + "\r");

if (!r.available) {
  console.error(`No trades for rule "${RULE}".`);
  process.exit(1);
}

console.log(`rule: ${r.ruleType} · ${r.tradeCount} closed trades · Top-${r.universe.length} universe: ${r.universe.join(", ")}\n`);

if (r.grid) {
  const g = r.grid;
  console.log(`=== 1. IN-SAMPLE GRID (${g.viable} viable of ${g.total}) — the MAXIMUM HERE IS NOT A RESULT ===`);
  g.top.slice(0, 10).forEach((x, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${x.timeframes.join("+").padEnd(26)} @${String(x.slots).padStart(2)}  CAGR ${pct(x.cagr, 7)}%  DD ${pct(x.dd, 5)}%  fill ${pct(x.fill, 4)}%  n=${x.n}`));

  console.log(`\n  by slot count (averaged over all ${g.total / r.slots.length} timeframe subsets):`);
  for (const s of g.bySlots) {
    console.log(`    ${String(s.slots).padStart(2)} slots  CAGR ${pct(s.cagr)}%  Exp ${pct(s.expected)}%  DD ${pct(s.dd, 5)}%  fill ${pct(s.fill, 4)}%`);
  }
  console.log("\n  by timeframe presence (avg CAGR with it vs without):");
  for (const t of g.byTimeframe) {
    console.log(`    ${t.timeframe.padEnd(4)} with ${pct(t.withCagr, 7)}%   without ${pct(t.withoutCagr, 7)}%   delta ${pct(t.delta, 7)}`);
  }
  console.log("\n  by number of timeframes combined:");
  for (const c of g.byTfCount) {
    console.log(`    ${c.count} TF  CAGR ${pct(c.cagr)}%  Exp ${pct(c.expected)}%  DD ${pct(c.dd, 5)}%  fill ${pct(c.fill, 4)}%`);
  }
}

if (r.walkForward) {
  console.log("\n\n=== 2. WALK-FORWARD (does an in-sample winner survive?) ===");
  for (const w of r.walkForward) {
    if (!w.winner) { console.log(`  q${w.q}: no viable in-sample combos`); continue; }
    console.log(`  split q${w.q} (${w.splitAt}): IS winner ${w.winner.label} (IS ${pct(w.winner.inSampleCagr)}%) -> OOS ${pct(w.winner.oosCagr)}%   rho(IS,OOS) = ${w.rho === null ? "—" : w.rho.toFixed(3)} over ${w.combos} combos`);
  }
}

console.log("\n\n=== 3. SHORTLIST, scored out-of-sample in every window (THIS is the answer) ===");
for (const w of r.shortlist.windows) {
  console.log(`\n  --- OOS after ${w.splitAt} (universe picked only on earlier data) ---`);
  for (const x of w.scored) {
    console.log(`    ${x.label.padEnd(22)} CAGR ${pct(x.cagr, 7)}%  Exp ${pct(x.expectedPct, 7)}%  DD ${pct(x.dd, 5)}%  C/DD ${pct(x.cdd, 6)}  fill ${pct(x.fill, 4)}%  n=${x.n}`);
  }
}

console.log("\n  ============ AVERAGED ACROSS ALL OUT-OF-SAMPLE WINDOWS ============");
console.log("  config                 avgCAGR  avgExpect   avgDD  avgC/DD   avg rank   both-axes rank");
for (const x of r.shortlist.averaged) {
  console.log(`  ${x.label.padEnd(22)} ${pct(x.cagr, 7)}%  ${pct(x.expected, 8)}%  ${pct(x.dd, 5)}%  ${pct(x.cdd, 7)}      ${x.rank.toFixed(1).padStart(4)}        ${x.rankOverall.toFixed(2).padStart(5)}`);
}
if (r.bestReturn) console.log(`\n  Highest average CAGR:                    ${r.bestReturn.label}`);
if (r.bestAllRound) console.log(`  Best all-round (CAGR and CAGR/DD rank):  ${r.bestAllRound.label}`);
console.log("\n  Magnitudes are not forecasts — short windows with heavy compounding. Read the ORDERING.");

// Pass 4 — the only section comparing every config over the SAME calendar. Everything above scores
// each config over its own span, which differs by years between timeframes.
const mw = r.matchedWindow;
console.log("\n\n=== 4. MATCHED WINDOW (same calendar for every config) ===");
if (!mw?.available) {
  console.log(`  unavailable: ${mw?.reason || "not computed"}`);
} else {
  console.log(`  Shared window ${mw.commonStartAt} -> ${mw.endAt} (${mw.commonYears.toFixed(2)}y), bound by ${mw.binding.timeframe}.`);
  console.log(`  Re-ranked across ${mw.windows.length} rolling starts, universe picked only on pre-window data${mw.anyLookahead ? " (SOME WINDOWS FELL BACK TO FULL-HISTORY — lookahead)" : ""}.`);
  console.log("\n  logged span per timeframe:");
  for (const s of mw.spans) {
    console.log(`    ${s.timeframe.padEnd(4)} ${new Date(s.firstMs).toISOString().slice(0, 10)} -> ${new Date(s.lastMs).toISOString().slice(0, 10)}  ${s.years.toFixed(2)}y  n=${s.trades}${s.timeframe === mw.binding.timeframe ? "   <- binds the window" : ""}`);
  }
  console.log("\n  config                 avgRank  worst   return    maxDD   ret/DD   fill");
  for (const c of mw.configs) {
    console.log(`  ${c.label.padEnd(22)} ${c.avgRank.toFixed(2).padStart(6)}  ${String(c.worstRank).padStart(5)}  ${pct(c.ret, 7)}%  ${pct(c.dd, 5)}%  ${pct(c.retDd, 6)}  ${pct(c.fill, 4)}%`);
  }
  if (mw.best) console.log(`\n  Most stable ordering: ${mw.best.label} (avg rank ${mw.best.avgRank.toFixed(2)}, worst ${mw.best.worstRank})`);
  console.log("\n  Ranked on TOTAL RETURN over the window, not CAGR — the shared window is short and the");
  console.log("  exponent would inflate it. The rolling windows all end on the same date and overlap");
  console.log("  heavily, so this is a consistency check on the ordering, not N independent trials.");
}
