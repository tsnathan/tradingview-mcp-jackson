/**
 * CAGR-based edge analysis over the closed-trade log.
 *
 * Answers "which timeframe actually pays best" in a way raw totals cannot. TradingView loads a
 * bounded bar count, so each timeframe's history spans a different number of calendar years — a
 * 15m chart covers months where a 1D chart covers years. Comparing total return across
 * timeframes is therefore meaningless; annualizing is what makes them commensurable.
 *
 * Two deliberate methodology choices:
 *
 * 1. **Returns compound, they don't sum.** Equity multiple is the product of (1 + trade return).
 *    `tp.p` from reportData() is a fraction of *position value*, and this strategy sizes each
 *    position at ~100% of current equity (verified: DUSL position values track the running
 *    equity curve — 9937 → 9670 after a loss → 12790 after gains), so compounding them
 *    approximates the account curve rather than a fixed-notional series.
 *
 * 2. **Open positions are included as an unrealized drag.** Ranking on closed trades alone is
 *    exactly the survivorship bias that makes TradingView's own profitFactor useless here —
 *    winners close and count, losers stay open and don't. `openPct` is applied to the final
 *    equity multiple before annualizing.
 *
 * CAGR/DD is reported per symbol and is the right lens on a whole portfolio's equity path, but it
 * is NOT what symbols are ranked by — measured on this data it ranks them slightly *worse* than
 * random. See the sort in `buildEdgeAnalysis` for the walk-forward numbers. Expectancy per trade
 * is the ranking dimension; treat cagrDd as a diagnostic column, not a score.
 *
 * `expectedPct` is a second, deliberately non-compounding annualized figure alongside CAGR. CAGR
 * takes the observed calendar span (which, for a sparsely-traded symbol, is mostly idle time
 * waiting for the next signal) and compounds the return to the power of (1/years) — over a short
 * span that exponent inflates a modest run into a headline number that reads as far punchier than
 * the trade-by-trade record supports. `expectedPct` instead asks "if trades like this kept
 * arriving at the rate this symbol's own average hold period implies, what would a year of them
 * add up to, added not compounded": `expectancyPct * (365.25 / avgHoldDays)`. Example: 3 trades
 * averaging ~2.7%/trade (summing to 8%) that each hold ~30 days imply about 12 such trades/year,
 * so expected = 2.7% * 12 = ~32% — versus CAGR's compounded ~36% for the same sample. Neither
 * number is "the" truth; CAGR is the compounding portfolio-equity lens, expectedPct is the
 * trade-frequency lens, and they're shown side by side for that reason.
 */
import { readAllTradeLogs, listRuleTypes } from "./trade_log.js";
import { bareTicker, timeframeTag } from "./trade_webhook.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Minimum closed trades before a symbol's expectancy is trusted enough to rank or judge on.
 * Separate from `minTrades` (the display/`enoughData` gate) because ranking is a stronger claim
 * than showing a row: predictive power in the walk-forward test held at 6, 8 and 10, and 8 is the
 * point where per-symbol expectancy stops swinging on a single trade in this dataset.
 */
export const RANK_MIN_TRADES = 8;

export const TF_ORDER = ["1m", "3m", "5m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1d", "1w", "1mo"];
export const TF_DISPLAY = {
  "15m": "15m", "30m": "30m", "45m": "45m", "1h": "1H",
  "2h": "2H", "3h": "3H", "4h": "4H", "1d": "1D",
};

export function tfRank(label) {
  const i = TF_ORDER.indexOf(label);
  return i === -1 ? 999 : i;
}

/**
 * Compound a list of closed trades into an equity multiple, then annualize.
 *
 * `spanEndMs` lets a still-open position extend the measurement window to now — otherwise a
 * symbol whose last trade closed a year ago would report an inflated CAGR over a stale span.
 */
function annualize(trades, { openPct = 0, spanEndMs = null } = {}) {
  if (!trades.length) return null;

  let multiple = 1;
  for (const t of trades) multiple *= 1 + (t.pnl_pct || 0) / 100;

  // Unrealized P&L rides on top of the realized curve.
  const closedMultiple = multiple;
  multiple *= 1 + openPct / 100;

  const entries = trades.map((t) => t.entry_time_ms).filter(Boolean);
  const exits = trades.map((t) => t.exit_time_ms || t.entry_time_ms).filter(Boolean);
  if (!entries.length || !exits.length) return null;

  const startMs = Math.min(...entries);
  const endMs = Math.max(Math.max(...exits), spanEndMs || 0);
  const years = (endMs - startMs) / MS_PER_YEAR;
  // Under ~2 months of history can't support an annualized figure — raising a 3% gain to the
  // 6th power produces a headline number that is pure artifact.
  if (years < 0.16) return null;

  const cagr = (Math.pow(Math.max(multiple, 0.0001), 1 / years) - 1) * 100;
  const closedCagr = (Math.pow(Math.max(closedMultiple, 0.0001), 1 / years) - 1) * 100;

  return {
    years,
    startMs,
    endMs,
    totalReturnPct: (multiple - 1) * 100,
    closedReturnPct: (closedMultiple - 1) * 100,
    cagr,
    closedCagr,
    tradesPerYear: trades.length / years,
  };
}

// Calendar days held, not bars — bars_held isn't comparable across timeframes (60 bars is 15
// hours at 15m, 60 days at 1D), and "how long was capital tied up" is a calendar question. Not
// excluding margin-call rows here, same as every other stat in this function: they're a real
// (if degenerate) ~0-day holding, and this function doesn't special-case them anywhere else.
const holdDays = (t) => (t.entry_time_ms && t.exit_time_ms ? (t.exit_time_ms - t.entry_time_ms) / MS_PER_DAY : null);

function basicStats(trades) {
  const wins = trades.filter((t) => t.pnl_usd > 0);
  const losses = trades.filter((t) => t.pnl_usd <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_usd, 0));
  const avg = (arr, f) => (arr.length ? arr.reduce((s, t) => s + (f(t) || 0), 0) / arr.length : 0);
  const holds = trades.map(holdDays).filter((d) => d !== null && d >= 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    // Honest profit factor: every closed loser is in the denominator, unlike reportData()'s.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWinPct: avg(wins, (t) => t.pnl_pct),
    avgLossPct: avg(losses, (t) => t.pnl_pct),
    expectancyPct: avg(trades, (t) => t.pnl_pct),
    avgMfePct: avg(trades, (t) => t.mfe_pct),
    avgMaePct: avg(trades, (t) => t.mae_pct),
    avgBarsWin: avg(wins, (t) => t.bars_held),
    avgBarsLoss: avg(losses, (t) => t.bars_held),
    // Median alongside the mean because hold time is right-skewed: most trades exit on a quick
    // flip, but a handful of weak-signal positions ride for far longer and drag the mean up.
    avgHoldDays: holds.length ? holds.reduce((s, d) => s + d, 0) / holds.length : null,
    medianHoldDays: median(holds),
    avgHoldDaysWin: avg(wins, holdDays),
    avgHoldDaysLoss: avg(losses, holdDays),
    marginCalls: trades.filter((t) => /margin call/i.test(t.exit_signal || "")).length,
  };
}

/**
 * Build the full analysis.
 *
 * @param openBySymbolTf  Map of "TICKER|tflabel" -> { openPct, maxDDPct } sourced from the live
 *                        strategy read. Drawdown is not derivable from a trade list (it needs the
 *                        bar-by-bar equity curve), so it has to come from reportData().
 * @param ruleType        Exit-rule variant to analyse in isolation (see readAllTradeLogs). Required
 *                        for any performance claim once more than one variant has been logged;
 *                        `null` pools every variant and is only meaningful before an A/B run.
 *
 * Caveat that cannot be fixed here: `openBySymbolTf` comes from the *current* chart state, so its
 * openPct/maxDDPct reflect whatever variant is attached right now. Pairing it with a historical
 * variant's closed trades mixes regimes. The returned `ruleType` is reported back so the caller can
 * surface which variant the numbers describe.
 */
export function buildEdgeAnalysis({ openBySymbolTf = {}, minTrades = 4, ruleType = null } = {}) {
  const rows = readAllTradeLogs({ ruleType });
  const ruleTypes = listRuleTypes();
  if (!rows.length) {
    return {
      available: false,
      reason: ruleTypes.length ? "no_trades_for_rule_type" : "no_trades_logged",
      ruleType,
      ruleTypes,
      timeframes: [],
      symbols: [],
    };
  }

  const now = Date.now();
  const bySymbolTf = new Map();
  for (const r of rows) {
    const key = `${r.ticker}|${r.timeframe}`;
    if (!bySymbolTf.has(key)) bySymbolTf.set(key, []);
    bySymbolTf.get(key).push(r);
  }

  const symbols = [];
  for (const [key, trades] of bySymbolTf) {
    const [ticker, timeframe] = key.split("|");
    const live = openBySymbolTf[key] || {};
    const openPct = Number(live.openPct || 0);
    const hasOpen = Math.abs(openPct) > 0.0001;
    const ann = annualize(trades, { openPct, spanEndMs: hasOpen ? now : null });
    if (!ann) continue;
    const stats = basicStats(trades);
    const maxDDPct = Number(live.maxDDPct || 0);
    // Trades/year implied by how long this symbol's positions actually run, not by how much
    // history happened to be captured — see the module docstring for why this differs from CAGR.
    const expectedPct = stats.avgHoldDays && stats.avgHoldDays > 0
      ? stats.expectancyPct * (365.25 / stats.avgHoldDays)
      : null;
    symbols.push({
      key,
      ticker,
      timeframe,
      tfDisplay: TF_DISPLAY[timeframe] || timeframe,
      watchlist: trades[trades.length - 1]?.watchlist || "",
      ...stats,
      ...ann,
      openPct,
      maxDDPct,
      cagrDd: maxDDPct > 0 ? ann.cagr / maxDDPct : null,
      expectedPct,
      enoughData: trades.length >= minTrades,
      rankable: trades.length >= RANK_MIN_TRADES,
    });
  }

  // Timeframe rollup. Aggregating the *symbol* CAGRs (median + mean) rather than pooling all
  // trades together keeps one hyperactive symbol from dominating its timeframe's headline.
  const byTf = new Map();
  for (const s of symbols) {
    if (!byTf.has(s.timeframe)) byTf.set(s.timeframe, []);
    byTf.get(s.timeframe).push(s);
  }

  // Percentile of expectancy WITHIN each timeframe, which is what drives the Keep/Watch/Drop
  // verdict. Expectancy scales hard with timeframe (15m ~1.7%/trade against 4H ~7%), so an
  // absolute threshold would tag every fast-timeframe symbol weak and every slow one strong.
  // Ranking inside the timeframe matches how the watchlists are actually traded — one list, one
  // resolution — and it is the comparison the walk-forward test was run on.
  for (const [, list] of byTf) {
    const pool = list.filter((s) => s.rankable && Number.isFinite(s.expectancyPct))
      .sort((a, b) => a.expectancyPct - b.expectancyPct);
    for (const s of list) {
      // Under 4 ranked peers a percentile is noise dressed as precision; leave it null and let the
      // consumer fall back to a neutral verdict.
      const i = pool.indexOf(s);
      s.expPercentile = pool.length >= 4 && i >= 0 ? i / (pool.length - 1) : null;
    }
  }

  const timeframes = [];
  for (const [tf, list] of byTf) {
    const qualified = list.filter((s) => s.enoughData);
    const pool = qualified.length ? qualified : list;
    const allTrades = pool.flatMap((s) => bySymbolTf.get(s.key) || []);
    const stats = basicStats(allTrades);
    const cagrs = pool.map((s) => s.cagr).filter(Number.isFinite);
    const expecteds = pool.map((s) => s.expectedPct).filter(Number.isFinite);
    const ddRatios = pool.map((s) => s.cagrDd).filter((v) => v !== null && Number.isFinite(v));
    timeframes.push({
      timeframe: tf,
      tfDisplay: TF_DISPLAY[tf] || tf,
      rank: tfRank(tf),
      symbols: pool.length,
      ...stats,
      medianCagr: median(cagrs),
      meanCagr: cagrs.length ? cagrs.reduce((a, b) => a + b, 0) / cagrs.length : null,
      medianExpected: median(expecteds),
      meanExpected: expecteds.length ? expecteds.reduce((a, b) => a + b, 0) / expecteds.length : null,
      medianCagrDd: median(ddRatios),
      avgMaxDD: pool.reduce((s, x) => s + (x.maxDDPct || 0), 0) / (pool.length || 1),
      avgSpanYears: pool.reduce((s, x) => s + x.years, 0) / (pool.length || 1),
      profitableSymbols: pool.filter((s) => s.totalReturnPct > 0).length,
      openDragPct: pool.reduce((s, x) => s + (x.openPct || 0), 0),
    });
  }
  timeframes.sort((a, b) => a.rank - b.rank);

  // Exit-reason breakdown per timeframe — the direct evidence for whether a stop ever fires.
  const exitReasons = {};
  for (const r of rows) {
    const tf = r.timeframe;
    const reason = r.exit_signal || "(none)";
    exitReasons[tf] = exitReasons[tf] || {};
    exitReasons[tf][reason] = (exitReasons[tf][reason] || 0) + 1;
  }

  // Ranked by expectancy, NOT by cagrDd — measured, not assumed. Walk-forward test on 2H+4H
  // flip-only (rank each symbol on the first half of its history, score it on the second half,
  // Spearman): expectancy +0.38, totalReturn +0.23, cagr +0.09, winRate -0.02, sharpe -0.13,
  // cagrDd -0.15, profitFactor -0.17. Stable in sign across 9 combinations of min-trades
  // (6/8/10) and split point (0.4/0.5/0.6). The ratio metrics invert because max drawdown over
  // 5-12 trades is essentially the worst single trade — near-pure noise that mean-reverts, so
  // dividing by it ranks symbols by how lucky their worst trade was. cagrDd stays a displayed
  // column and is still the right lens on a whole PORTFOLIO's equity path; it is only unfit for
  // ranking individual symbols on a dozen trades. Symbols without enough history to rank sort to
  // the bottom rather than interleaving with established rows on a noisy estimate.
  symbols.sort((a, b) => {
    if (a.rankable !== b.rankable) return a.rankable ? -1 : 1;
    return (b.expectancyPct ?? -Infinity) - (a.expectancyPct ?? -Infinity);
  });

  // Pooled across every timeframe for the top-level summary — deliberately NOT comparable to any
  // single timeframe's own avgHoldDays (a 1D swing and a 15m scalp landing in the same average
  // means nothing); it exists only to answer "on the whole watchlist, how long is capital tied up
  // once a position opens." Per-timeframe figures for like-for-like comparison are on `timeframes`.
  const allHolds = rows.map(holdDays).filter((d) => d !== null && d >= 0);

  return {
    available: true,
    generated_at: new Date().toISOString(),
    totalClosedTrades: rows.length,
    avgHoldDays: allHolds.length ? allHolds.reduce((s, d) => s + d, 0) / allHolds.length : null,
    medianHoldDays: median(allHolds),
    minTrades,
    ruleType,
    ruleTypes,
    timeframes,
    symbols,
    exitReasons,
    windows: buildWindowComparison(rows),
    coverage: buildCoverage(rows),
  };
}

/**
 * Compare timeframes over identical calendar windows.
 *
 * This is the only fair timeframe comparison available. Each timeframe's own CAGR is measured
 * over a different span — 30m holds ~6 months of one market regime while 1D reaches back to 2016
 * across two bear markets — so a naive CAGR ranking mostly measures *which regime a timeframe
 * happened to sample*, not which timeframe is better. Restricting every timeframe to the same
 * trailing window removes that advantage.
 */
export function buildWindowComparison(rows, monthsList = [6, 12, 24]) {
  const now = Date.now();
  const out = {};
  for (const months of monthsList) {
    const cutoff = now - (months / 12) * MS_PER_YEAR;
    const years = months / 12;
    const byTf = new Map();
    for (const r of rows) {
      if (!r.entry_time_ms || r.entry_time_ms < cutoff) continue;
      if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []);
      byTf.get(r.timeframe).push(r);
    }
    const list = [];
    for (const [tf, trades] of byTf) {
      const bySym = new Map();
      for (const t of trades) {
        if (!bySym.has(t.ticker)) bySym.set(t.ticker, []);
        bySym.get(t.ticker).push(t);
      }
      // Median of per-symbol compounded returns: one hyperactive ticker shouldn't define a
      // timeframe's headline number.
      const rets = [];
      for (const [, ts] of bySym) {
        let m = 1;
        for (const t of ts) m *= 1 + (t.pnl_pct || 0) / 100;
        rets.push((m - 1) * 100);
      }
      rets.sort((a, b) => a - b);
      const med = rets.length % 2
        ? rets[(rets.length - 1) / 2]
        : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2;
      const wins = trades.filter((t) => t.pnl_usd > 0);
      const gp = wins.reduce((s, t) => s + t.pnl_usd, 0);
      const gl = Math.abs(trades.filter((t) => t.pnl_usd <= 0).reduce((s, t) => s + t.pnl_usd, 0));
      list.push({
        timeframe: tf,
        tfDisplay: TF_DISPLAY[tf] || tf,
        rank: tfRank(tf),
        symbols: bySym.size,
        trades: trades.length,
        medianReturnPct: med,
        annualizedPct: (Math.pow(Math.max(1 + med / 100, 0.0001), 1 / years) - 1) * 100,
        winRate: (wins.length / trades.length) * 100,
        profitFactor: gl > 0 ? gp / gl : null,
        profitableSymbols: rets.filter((r) => r > 0).length,
        marginCalls: trades.filter((t) => /margin call/i.test(t.exit_signal || "")).length,
      });
    }
    list.sort((a, b) => a.rank - b.rank);
    out[months] = list;
  }
  return out;
}

/**
 * Per symbol+timeframe edge score, for ranking OPEN positions against each other.
 *
 * The score is the symbol's **expectancy percentile within its own timeframe**, 0-100. Both halves
 * of that are load-bearing and neither is a free choice:
 *
 * - **Expectancy**, not any ratio. The walk-forward test on this exact data (rank each symbol on
 *   the first half of its own history, score it on the second half, Spearman rho, n≈48) put
 *   expectancy at +0.381 while profitFactor (-0.168), sharpe (-0.133), cagrDd (-0.145) and winRate
 *   (-0.018) all ranked at or *below* random. TradingView's own Key Stats panel shows the same
 *   family of numbers (Sharpe ratio, profit factor, win %, expected payoff) — of those, only
 *   "Expected payoff" (= expectancy) survives the test. The ratio metrics fail because max drawdown
 *   and worst-loss over a dozen trades are essentially one unlucky trade, which mean-reverts.
 * - **Percentile within timeframe**, not the raw value. Expectancy scales hard with timeframe
 *   (15m ~1.7%/trade vs 4H ~7%), so a raw-expectancy ranking is really a timeframe ranking; the
 *   percentile is also what makes rows comparable ACROSS timeframes for a whole-portfolio slot cap.
 *
 * Symbols under RANK_MIN_TRADES closed trades get `score: null` rather than a noisy estimate — an
 * unrankable symbol must read as "unknown", never as "weak", or the cap logic would evict positions
 * purely for having short history.
 */
export function buildSymbolEdgeScores({ ruleType = null } = {}) {
  const rows = readAllTradeLogs({ ruleType });
  const byKey = new Map();
  for (const r of rows) {
    const ticker = bareTicker(r.ticker).toUpperCase();
    const timeframe = String(r.timeframe || "").toLowerCase();
    if (!ticker || !timeframe) continue;
    const key = `${ticker}|${timeframe}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const scores = {};
  const byTf = new Map();
  for (const [key, trades] of byKey) {
    const [ticker, timeframe] = key.split("|");
    const stats = basicStats(trades);
    const entry = {
      key,
      ticker,
      timeframe,
      trades: stats.trades,
      expectancyPct: stats.expectancyPct,
      winRate: stats.winRate,
      avgWinPct: stats.avgWinPct,
      avgLossPct: stats.avgLossPct,
      profitFactor: stats.profitFactor,
      // TradingView's Key Stats "Average profit / Average loss" pair, as one number. Diagnostic
      // only — shown in the tooltip, never part of the score (see the docstring).
      payoffRatio: stats.avgLossPct < 0 ? stats.avgWinPct / Math.abs(stats.avgLossPct) : null,
      avgHoldDays: stats.avgHoldDays,
      medianHoldDays: stats.medianHoldDays,
      rankable: stats.trades >= RANK_MIN_TRADES,
      expPercentile: null,
      score: null,
    };
    scores[key] = entry;
    if (!byTf.has(timeframe)) byTf.set(timeframe, []);
    byTf.get(timeframe).push(entry);
  }

  for (const [, list] of byTf) {
    const pool = list
      .filter((s) => s.rankable && Number.isFinite(s.expectancyPct))
      .sort((a, b) => a.expectancyPct - b.expectancyPct);
    // Same 4-peer floor buildEdgeAnalysis uses: below that a percentile is noise dressed as
    // precision, and the consumer should show "n/a" instead of a confident-looking number.
    if (pool.length < 4) continue;
    pool.forEach((s, i) => {
      s.expPercentile = i / (pool.length - 1);
      s.score = s.expPercentile * 100;
    });
  }

  return { ruleType, scores, symbolCount: Object.keys(scores).length };
}

const rankDesc = (a, b) => {
  const as = a.edge?.score;
  const bs = b.edge?.score;
  const aHas = Number.isFinite(as);
  const bHas = Number.isFinite(bs);
  if (aHas !== bHas) return aHas ? -1 : 1;   // unscored rows sort last, never "worst"
  if (aHas && as !== bs) return bs - as;
  return String(a.symbol || "").localeCompare(String(b.symbol || ""));
};

/**
 * Attach edge scores and the org/new rank pair to a list of open-trade rows.
 *
 * Two ranks per row, both within the row's own timeframe:
 *  - `edgeRankOrg`  — rank among the positions that were ALREADY open before this scan's new
 *                     arrivals (`isNew` false). Null on a new arrival: it wasn't in that book.
 *  - `edgeRankNew`  — rank among every position now open on that timeframe, new arrivals included.
 *
 * The pair is what answers "should I liquidate something to make room for this?": a held position
 * whose rank slid from 3/10 to 9/13 has been displaced by better signals, and the newcomer sitting
 * at 2/13 with no org rank is what displaced it. One rank alone can't show that — the ranks only
 * move because the set changed, which is exactly the event being asked about.
 *
 * @param isNew  Predicate deciding "arrived in this scan". Passed in rather than computed here so
 *               the ET trading-day calendar stays in morning.js, which owns that logic.
 */
export function attachOpenTradeRanks(openTrades, { ruleType = null, isNew = () => false } = {}) {
  const rows = Array.isArray(openTrades) ? openTrades : [];
  if (!rows.length) return rows;

  const { scores, ruleType: resolvedRuleType } = buildSymbolEdgeScores({ ruleType });

  const enriched = rows.map((row) => {
    const key = `${bareTicker(row.symbol).toUpperCase()}|${timeframeTag(row.timeframe)}`;
    const s = scores[key] || null;
    return {
      ...row,
      isNewEntry: Boolean(isNew(row)),
      edge: s
        ? {
          ruleType: resolvedRuleType,
          trades: s.trades,
          expectancyPct: s.expectancyPct,
          winRate: s.winRate,
          payoffRatio: s.payoffRatio,
          profitFactor: s.profitFactor,
          avgHoldDays: s.avgHoldDays,
          rankable: s.rankable,
          score: s.score,
        }
        : null,
      edgeRankOrg: null,
      edgeRankOrgTotal: null,
      edgeRankNew: null,
      edgeRankNewTotal: null,
    };
  });

  const groups = new Map();
  for (const row of enriched) {
    const tf = timeframeTag(row.timeframe);
    if (!groups.has(tf)) groups.set(tf, []);
    groups.get(tf).push(row);
  }

  for (const [, list] of groups) {
    const all = [...list].sort(rankDesc);
    all.forEach((row, i) => {
      row.edgeRankNew = i + 1;
      row.edgeRankNewTotal = all.length;
    });
    const org = all.filter((row) => !row.isNewEntry);
    org.forEach((row, i) => {
      row.edgeRankOrg = i + 1;
      row.edgeRankOrgTotal = org.length;
    });
  }

  return enriched;
}

/** Per-timeframe data coverage — how far back the log actually reaches. */
export function buildCoverage(rows) {
  const byTf = new Map();
  for (const r of rows) {
    if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []);
    byTf.get(r.timeframe).push(r);
  }
  const out = [];
  for (const [tf, trades] of byTf) {
    const entries = trades.map((t) => t.entry_time_ms).filter(Boolean);
    const exits = trades.map((t) => t.exit_time_ms || t.entry_time_ms).filter(Boolean);
    if (!entries.length) continue;
    const from = Math.min(...entries);
    const to = Math.max(...exits);
    out.push({
      timeframe: tf,
      tfDisplay: TF_DISPLAY[tf] || tf,
      rank: tfRank(tf),
      trades: trades.length,
      from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10),
      spanYears: (to - from) / MS_PER_YEAR,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}
