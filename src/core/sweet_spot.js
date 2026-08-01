/**
 * Sweet-spot analysis — which (timeframe set × max positions) configuration to actually run.
 *
 * This is the computation behind PORTFOLIO_RECKONER.md AND behind the dashboard's Sweet Spot tab.
 * It lives here, shared, for the same reason /api/archive-orphans shells out to the real CLI script
 * rather than reimplementing it: two implementations of the same measurement drift, and the failure
 * is silent — the doc would assert one ordering while the tab showed another, with no way to tell
 * which had gone stale. `scripts/sweep_portfolio_grid.mjs` is now a formatter over this module.
 *
 * Three passes, in increasing order of trustworthiness:
 *   1. IN-SAMPLE GRID — all 255 timeframe subsets × 7 slot counts. Kept for its *structure* (the
 *      per-timeframe and per-slot-count aggregates below are stable and genuinely informative), but
 *      its MAXIMUM is a selection artifact: best-of-1,785 on the data that produced the ranking is
 *      fitting, not measuring. Callers must label it as such.
 *   2. WALK-FORWARD — rank every combo on the first part of the log, score it on the rest, report
 *      Spearman rho between the two. Splits are on the TRADE-COUNT quantile, never the calendar:
 *      the log spans 2016-2026 but the overwhelming majority of trades are recent, so a calendar
 *      midpoint lands in a near-empty region and produces zero viable combos.
 *   3. SHORTLIST — score a fixed handful of candidate configs across every out-of-sample window and
 *      average. This is the pass recommendations come from, because a single grid maximum is
 *      unstable (rho 0.19-0.52 across splits) while an average over a shortlist is not.
 *
 * The symbol universe is re-picked inside each in-sample window. Picking it once over all history
 * and then walking forward would leak the answer into the question.
 */
import { readAllTradeLogs } from "./trade_log.js";
import { simulatePortfolio } from "./portfolio_sim.js";

export const SWEET_SPOT_TIMEFRAMES = ["15m", "30m", "45m", "1h", "2h", "3h", "4h", "1d"];
export const SWEET_SPOT_SLOTS = [3, 5, 8, 10, 15, 20, 30];
export const SWEET_SPOT_SPLITS = [0.5, 0.6, 0.7];
const CAPITAL = 100000;
const UNIVERSE_SIZE = 20;
const RANK_MIN_TRADES = 8;   // matches edge_analysis.js — a combo below this is unrankable, not weak
const MIN_TRADES_VIABLE = 20; // a combo that took <20 signals is noise, not a configuration

/**
 * The shortlist is deliberately FIXED rather than derived from the grid. Feeding the grid's own
 * winners back in would re-import the selection bias pass 3 exists to escape — and a per-window
 * winner cannot be averaged by label across windows anyway, because it is a different config each
 * time. Extend it by hand when a genuinely new hypothesis is worth carrying across every window.
 */
const FAST5 = ["15m", "30m", "45m", "1h", "2h"];
export const SWEET_SPOT_CANDIDATES = [
  { label: "15m+2h @ 5", timeframes: ["15m", "2h"], slots: 5 },
  { label: "15m+30m @ 3", timeframes: ["15m", "30m"], slots: 3 },
  { label: "15m+30m @ 5", timeframes: ["15m", "30m"], slots: 5 },
  { label: "30m+2h @ 5", timeframes: ["30m", "2h"], slots: 5 },
  { label: "15m+30m+45m @ 5", timeframes: ["15m", "30m", "45m"], slots: 5 },
  { label: "15m+30m+45m+2h @ 8", timeframes: ["15m", "30m", "45m", "2h"], slots: 8 },
  { label: "fast5 @ 10", timeframes: FAST5, slots: 10 },
  { label: "fast5 @ 15", timeframes: FAST5, slots: 15 },
  { label: "all 8 TF @ 10", timeframes: SWEET_SPOT_TIMEFRAMES, slots: 10 },
  { label: "all 8 TF @ 15", timeframes: SWEET_SPOT_TIMEFRAMES, slots: 15 },
  { label: "all-but-1d @ 15", timeframes: SWEET_SPOT_TIMEFRAMES.filter((t) => t !== "1d"), slots: 15 },
];

const mean = (arr, pick = (x) => x) => (arr.length ? arr.reduce((s, x) => s + pick(x), 0) / arr.length : NaN);

function subsets(arr) {
  const out = [];
  for (let m = 1; m < (1 << arr.length); m++) out.push(arr.filter((_, i) => m & (1 << i)));
  return out;
}

/** Spearman rank correlation. Returns null when there is nothing to correlate. */
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (a) => {
    const sorted = [...a].sort((p, q) => p - q);
    return a.map((v) => sorted.indexOf(v));
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

/**
 * The dashboard's Top-N symbol picker, restricted to a date window so walk-forward cannot leak.
 * Ranks on expectancy PERCENTILE WITHIN TIMEFRAME, never raw expectancy: expectancy scales hard
 * with timeframe (15m ~1.7%/trade vs 4H ~7%), so a raw ranking across timeframes is really just a
 * timeframe ranking. See CLAUDE.md, "Ranking symbols: use expectancy, never CAGR/DD".
 */
export function topTickers(rows, n = UNIVERSE_SIZE, { endMs = null } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    if (endMs && Number(r.entry_time_ms) >= endMs) continue;
    const k = `${r.ticker}|${r.timeframe}`;
    if (!byKey.has(k)) byKey.set(k, { ticker: r.ticker, tf: r.timeframe, pnls: [] });
    byKey.get(k).pnls.push(Number(r.pnl_pct));
  }
  const stats = [];
  for (const v of byKey.values()) {
    if (v.pnls.length < RANK_MIN_TRADES) continue;
    const exp = mean(v.pnls);
    if (exp > 0) stats.push({ ...v, exp });
  }
  const byTf = {};
  for (const s of stats) (byTf[s.tf] ||= []).push(s);
  for (const list of Object.values(byTf)) {
    list.sort((a, b) => a.exp - b.exp);
    list.forEach((s, i) => { s.pct = list.length > 1 ? (i / (list.length - 1)) * 100 : 50; });
  }
  // One timeframe per ticker — the same symbol appearing under three timeframes would consume three
  // of the twenty universe slots for what is one instrument.
  const best = new Map();
  for (const s of stats) {
    const prev = best.get(s.ticker);
    if (!prev || s.pct > prev.pct) best.set(s.ticker, s);
  }
  return [...best.values()].sort((a, b) => b.pct - a.pct).slice(0, n).map((s) => s.ticker);
}

/**
 * Run the whole analysis.
 *
 * `quick` skips passes 1 and 2 (the two that cost minutes) and returns the shortlist only. It is
 * the same shortlist either way — the fast path drops evidence, never changes the answer.
 *
 * `onProgress({phase, done, total, note})` is called throughout; a caller that wants a progress bar
 * needs it because the full run is thousands of simulations and gives no other sign of life.
 */
export function runSweetSpotAnalysis({
  ruleType = null,
  quick = false,
  timeframes = SWEET_SPOT_TIMEFRAMES,
  slots = SWEET_SPOT_SLOTS,
  splits = SWEET_SPOT_SPLITS,
  candidates = SWEET_SPOT_CANDIDATES,
  capital = CAPITAL,
  universeSize = UNIVERSE_SIZE,
  onProgress = null,
} = {}) {
  const startedAt = Date.now();
  const rows = readAllTradeLogs({ ruleType }).filter((r) => r.entry_time_ms && r.exit_time_ms);
  if (!rows.length) {
    return { available: false, reason: "no_trades", ruleType };
  }

  const entryTimes = rows.map((r) => Number(r.entry_time_ms)).sort((a, b) => a - b);
  const quantile = (q) => entryTimes[Math.min(entryTimes.length - 1, Math.floor(entryTimes.length * q))];
  const allSubsets = subsets(timeframes);

  // Progress accounting is an estimate, not a contract: the walk-forward's second half runs one OOS
  // simulation per VIABLE in-sample combo, and how many are viable is not known until the grid has
  // run. Over-reporting `total` and letting `done` land short would make the bar stall near the end,
  // so the estimate assumes every combo is viable and the bar is clamped at 100% instead.
  const gridSize = allSubsets.length * slots.length;
  const totalWork = (quick ? 0 : gridSize + splits.length * gridSize * 2) + splits.length * candidates.length;
  let done = 0;
  const tick = (phase, note, by = 1) => {
    done += by;
    if (onProgress) onProgress({ phase, done, total: totalWork, note });
  };

  const runOne = (tfs, maxPositions, tickers, startMs = null, endMs = null) => {
    const r = simulatePortfolio({
      capital, maxPositions, timeframes: tfs, tickers,
      priority: "chronological", ruleType, startMs, endMs,
    });
    return {
      cagr: r.available ? r.cagr : null,
      expectedPct: r.available ? r.expectedPct : null,
      dd: r.available ? r.maxDrawdownPct : null,
      cdd: r.available ? r.cagrDd : null,
      fill: r.available ? r.fillRate : null,
      n: r.available ? r.signalsTaken : 0,
    };
  };

  const buildGrid = (tickers, startMs, endMs, phase) => {
    const out = [];
    for (const tfs of allSubsets) {
      for (const s of slots) {
        const r = runOne(tfs, s, tickers, startMs, endMs);
        tick(phase, `${tfs.join("+")} @${s}`);
        // Both filters matter: a null CAGR means the window was too short to annualize, and <20
        // signals is a sample, not a configuration.
        if (Number.isFinite(r.cagr) && r.n >= MIN_TRADES_VIABLE) out.push({ timeframes: tfs, slots: s, ...r });
      }
    }
    return out.sort((a, b) => b.cagr - a.cagr);
  };

  const universe = topTickers(rows, universeSize);

  // ------------------------------------------------------------------ 1. in-sample grid
  let grid = null;
  if (!quick) {
    const g = buildGrid(universe, null, null, "grid");
    grid = {
      viable: g.length,
      total: gridSize,
      top: g.slice(0, 20).map((r) => ({ ...r, timeframes: [...r.timeframes] })),
      bySlots: slots.map((s) => {
        const grp = g.filter((r) => r.slots === s);
        return {
          slots: s,
          combos: grp.length,
          cagr: mean(grp, (r) => r.cagr),
          // Expected is CAGR's non-compounding sibling (mean per-trade return on the equity that
          // funded it × trades/year). Carried alongside CAGR everywhere because these windows are
          // months long with heavy compounding, which is exactly the regime where CAGR's exponent
          // inflates a modest run — Expected shows whether an ordering survives without it.
          expected: mean(grp.filter((r) => Number.isFinite(r.expectedPct)), (r) => r.expectedPct),
          dd: mean(grp, (r) => r.dd),
          fill: mean(grp, (r) => r.fill),
        };
      }).filter((x) => x.combos > 0),
      // The single cleanest signal in the whole grid: average CAGR of every combo containing a
      // timeframe against every combo without it. 1d's delta is enormous and negative.
      byTimeframe: timeframes.map((tf) => {
        const withIt = g.filter((r) => r.timeframes.includes(tf));
        const withoutIt = g.filter((r) => !r.timeframes.includes(tf));
        const a = mean(withIt, (r) => r.cagr), b = mean(withoutIt, (r) => r.cagr);
        return {
          timeframe: tf,
          withCagr: a,
          withoutCagr: b,
          delta: Number.isFinite(a) && Number.isFinite(b) ? a - b : null,
          combosWith: withIt.length,
        };
      }).sort((x, y) => (y.delta ?? -Infinity) - (x.delta ?? -Infinity)),
      byTfCount: Array.from({ length: timeframes.length }, (_, i) => i + 1).map((count) => {
        const grp = g.filter((r) => r.timeframes.length === count);
        return {
          count,
          combos: grp.length,
          cagr: mean(grp, (r) => r.cagr),
          expected: mean(grp.filter((r) => Number.isFinite(r.expectedPct)), (r) => r.expectedPct),
          dd: mean(grp, (r) => r.dd),
          fill: mean(grp, (r) => r.fill),
        };
      }).filter((x) => x.combos > 0),
    };
  }

  // ------------------------------------------------------------------ 2. walk-forward
  let walkForward = null;
  if (!quick) {
    walkForward = [];
    for (const q of splits) {
      const splitMs = quantile(q);
      const uni = topTickers(rows, universeSize, { endMs: splitMs });
      const isRows = buildGrid(uni, null, splitMs, "walk-forward");
      if (!isRows.length) {
        walkForward.push({ q, splitAt: new Date(splitMs).toISOString().slice(0, 10), combos: 0, rho: null, winner: null });
        continue;
      }
      const best = isRows[0];
      const paired = [];
      for (const r of isRows) {
        const oos = runOne(r.timeframes, r.slots, uni, splitMs, null);
        tick("walk-forward", `oos ${r.timeframes.join("+")} @${r.slots}`);
        if (Number.isFinite(oos.cagr)) paired.push({ is: r.cagr, oos: oos.cagr });
      }
      const oosBest = runOne(best.timeframes, best.slots, uni, splitMs, null);
      walkForward.push({
        q,
        splitAt: new Date(splitMs).toISOString().slice(0, 10),
        combos: paired.length,
        rho: spearman(paired.map((p) => p.is), paired.map((p) => p.oos)),
        winner: {
          label: `${best.timeframes.join("+")} @${best.slots}`,
          timeframes: [...best.timeframes],
          slots: best.slots,
          inSampleCagr: best.cagr,
          oosCagr: oosBest.cagr,
        },
      });
    }
  }

  // ------------------------------------------------------------------ 3. shortlist (the answer)
  const agg = new Map();
  const windows = [];
  for (const q of splits) {
    const splitMs = quantile(q);
    const uni = topTickers(rows, universeSize, { endMs: splitMs });
    const scored = candidates.map((c) => {
      const r = runOne(c.timeframes, c.slots, uni, splitMs, null);
      tick("shortlist", c.label);
      return { label: c.label, timeframes: [...c.timeframes], slots: c.slots, ...r };
    });
    // Rank within this window on BOTH axes. Unrankable rows (no CAGR/CDD) sort last rather than
    // being dropped, so a config that failed in one window carries that failure into its average.
    //
    // Two ranks because they answer different questions and routinely disagree: raw CAGR rewards
    // concentration, which is the position-size divisor rather than an edge (see the "max positions
    // is also your position size" section of PORTFOLIO_RECKONER.md), while CAGR/DD is the
    // risk-adjusted read. `rank` stays the pure CAGR rank so the reckoner's published column is
    // reproducible; `rankOverall` is the mean of the two and is what "best all-round" means here —
    // previously that call was made by eye from the table, which is not something a tab can do.
    const byCagr = [...scored].sort((a, b) => (b.cagr ?? -Infinity) - (a.cagr ?? -Infinity));
    const byCdd = [...scored].sort((a, b) => (b.cdd ?? -Infinity) - (a.cdd ?? -Infinity));
    for (const x of scored) {
      x.rank = byCagr.indexOf(x) + 1;
      x.rankCdd = byCdd.indexOf(x) + 1;
      x.rankOverall = (x.rank + x.rankCdd) / 2;
      if (!agg.has(x.label)) agg.set(x.label, []);
      agg.get(x.label).push(x);
    }
    windows.push({
      q,
      splitAt: new Date(splitMs).toISOString().slice(0, 10),
      universeSize: uni.length,
      scored,
    });
  }

  const averaged = [...agg.entries()].map(([label, runs]) => {
    const ok = runs.filter((r) => Number.isFinite(r.cagr));
    return {
      label,
      timeframes: runs[0].timeframes,
      slots: runs[0].slots,
      windows: runs.length,
      scoredWindows: ok.length,
      cagr: mean(ok, (r) => r.cagr),
      // Averaged over the windows that produced one, not over all windows — a window with no
      // Expected would otherwise drag the mean toward zero as if it had measured zero.
      expected: mean(ok.filter((r) => Number.isFinite(r.expectedPct)), (r) => r.expectedPct),
      dd: mean(ok, (r) => r.dd),
      cdd: mean(ok.filter((r) => Number.isFinite(r.cdd)), (r) => r.cdd),
      fill: mean(ok, (r) => r.fill),
      rank: mean(runs, (r) => r.rank),
      rankCdd: mean(runs, (r) => r.rankCdd),
      rankOverall: mean(runs, (r) => r.rankOverall),
      // Worst single-window CAGR rank. An average built from one dominant window and two poor ones
      // is not a finding, and the average alone cannot show that.
      worstRank: Math.max(...runs.map((r) => r.rank)),
    };
  }).sort((a, b) => (b.cagr ?? -Infinity) - (a.cagr ?? -Infinity));

  // Two different questions, so two different picks, and they routinely disagree — the highest
  // average CAGR is usually the most concentrated config, which is leverage rather than edge (see
  // "max positions is also your position size"). Best all-round is the one that keeps landing near
  // the top on BOTH return and risk-adjusted return across every window, which travels better.
  const bestReturn = averaged[0] ?? null;
  const bestAllRound = [...averaged].sort((a, b) => a.rankOverall - b.rankOverall)[0] ?? null;

  return {
    available: true,
    ruleType,
    quick,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    tradeCount: rows.length,
    capital,
    timeframes,
    slots,
    splits,
    universe,
    grid,
    walkForward,
    shortlist: { windows, averaged },
    bestReturn,
    bestAllRound,
  };
}
