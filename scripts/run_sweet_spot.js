/**
 * Child-process runner for the sweet-spot analysis, used by the dashboard's Sweet Spot tab.
 *
 *   node scripts/run_sweet_spot.js [--rule=flip-only] [--quick]
 *
 * Why a separate process rather than computing inside the dashboard server: the full sweep is
 * thousands of synchronous simulations and would peg the server's event loop for minutes, making
 * every other endpoint (including the Signals tab and the webhook Close buttons) unresponsive while
 * it ran. Same reasoning as /api/archive-orphans spawning the real CLI.
 *
 * Progress is emitted as one JSON line per update on stdout so the parent can drive a progress bar;
 * the final result is written to status/sweet-spot.json, which is what the GET endpoint serves. The
 * parent therefore does not need to parse a result off stdout — if this process dies mid-run the
 * previous result file is simply left intact.
 *
 * Reads trade-log CSVs only. No TradingView connection, no CDP socket, nothing to leak.
 */
import { writeFileSync, mkdirSync, renameSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSweetSpotAnalysis } from "../src/core/sweet_spot.js";
import { buildWatchlistMembership } from "../src/core/universe.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "status", "sweet-spot.json");

/**
 * Membership is rebuilt here rather than passed in from the server: it contains a Map, so it does
 * not survive a process boundary as JSON, and both sides read the same two files anyway.
 */
function loadMembership() {
  try {
    const rules = JSON.parse(readFileSync(join(ROOT, "rules.json"), "utf8"));
    const baseline = JSON.parse(readFileSync(join(ROOT, "swing-signal-baseline.json"), "utf8"));
    return buildWatchlistMembership(rules, baseline);
  } catch {
    // Unreadable config means membership is UNKNOWN, and the established convention for unknown is
    // to gate nothing rather than to silently sweep an empty universe.
    return null;
  }
}

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const quick = process.argv.includes("--quick");
// An explicit `--rule=all` pools every exit-rule variant; omitting the flag lets the core module's
// caller-side default (most-traded variant, resolved by the server) stand.
const ruleArg = arg("rule", null);
const ruleType = ruleArg === "all" ? null : ruleArg;

let lastEmit = 0;
const emit = (obj) => { try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch {} };

// Gated by default so the sweep describes a book that can actually be traded. `--no-membership`
// opts back into full logged history, which is the right lens for "what would this have returned".
const membership = process.argv.includes("--no-membership") ? null : loadMembership();

const result = runSweetSpotAnalysis({
  ruleType,
  quick,
  membership,
  onProgress: ({ phase, done, total, note }) => {
    // Thousands of ticks, so throttle: one line every 250 ms is enough to animate a bar and keeps
    // the pipe from becoming the bottleneck. The final 100% line is emitted below regardless.
    const now = Date.now();
    if (now - lastEmit < 250) return;
    lastEmit = now;
    emit({ type: "progress", phase, done, total, pct: Math.min(100, (done / total) * 100), note });
  },
});

if (!result.available) {
  emit({ type: "error", reason: result.reason || "unavailable" });
  process.exit(2);
}

// A quick run computes only the shortlist, so writing it plainly would discard the grid and
// walk-forward from a previous FULL run — trading four minutes of work for thirty seconds of it on
// a single button press. Instead the older grid is carried forward, stamped with `gridFrom` so the
// dashboard can label those sections with their real provenance. It is never presented as part of
// this run: mixing measurements without saying so is the failure mode this whole file guards
// against elsewhere.
//
// Carried forward ONLY when the exit-rule variant matches. Variants are different strategies, so a
// grid measured under one says nothing about another — there, dropping the stale grid is correct.
if (result.quick && existsSync(OUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    // Membership state is part of that identity for exactly the same reason as the rule variant: a
    // grid swept over all logged history and one swept over current watchlist members are measuring
    // different universes, and carrying one into the other would relabel it as the current run's.
    const sameUniverse =
      Boolean(prev?.membershipFilter?.applied) === Boolean(result.membershipFilter?.applied);
    if (prev?.grid && (prev.ruleType ?? null) === (result.ruleType ?? null) && sameUniverse) {
      result.grid = prev.grid;
      result.walkForward = prev.walkForward ?? null;
      result.gridFrom = {
        generatedAt: prev.generatedAt,
        tradeCount: prev.tradeCount,
        ruleType: prev.ruleType ?? null,
        membershipApplied: Boolean(prev.membershipFilter?.applied),
      };
    }
  } catch { /* an unreadable previous result is simply not carried forward */ }
}

// Write via a temp file + rename so a reader that polls this path can never observe a half-written
// document — the GET endpoint parses it on every request while this may be running.
mkdirSync(dirname(OUT_FILE), { recursive: true });
const tmp = `${OUT_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify(result, null, 2), "utf8");
renameSync(tmp, OUT_FILE);

emit({ type: "progress", phase: "done", done: 1, total: 1, pct: 100 });
emit({ type: "done", generatedAt: result.generatedAt, durationMs: result.durationMs, quick: result.quick, ruleType: result.ruleType });
process.exit(0);
