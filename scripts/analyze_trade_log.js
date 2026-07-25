#!/usr/bin/env node
/**
 * Read trade-log/*.csv back and report per-timeframe and per-symbol edge on CLOSED trades only.
 *
 * This is the honest counterpart to TradingView's Strategy Tester headline numbers, which
 * exclude still-open losers from grossLoss and therefore inflate profit factor on any strategy
 * that lets losers ride. Everything here is realized.
 *
 * Usage:
 *   node scripts/analyze_trade_log.js               # per-timeframe summary
 *   node scripts/analyze_trade_log.js --by symbol   # per symbol/timeframe ranking
 *   node scripts/analyze_trade_log.js --by exit     # what actually closes trades
 *   node scripts/analyze_trade_log.js --tf 15       # restrict to one timeframe
 *   node scripts/analyze_trade_log.js --min 5       # min closed trades to rank (default 4)
 *   node scripts/analyze_trade_log.js --rule ts60   # one exit-rule variant (default: most-traded)
 *   node scripts/analyze_trade_log.js --rule all    # pool every variant (rarely what you want)
 *   node scripts/analyze_trade_log.js --rules       # list logged variants and exit
 */
import * as tradeLog from "../src/core/trade_log.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const by = arg("by", "tf");
const tfArg = arg("tf");
const minTrades = Number(arg("min", "4"));

const variants = tradeLog.listRuleTypes();

if (process.argv.includes("--rules")) {
  if (!variants.length) console.log("No trades logged yet.");
  for (const v of variants) {
    const span = v.firstMs && v.lastMs
      ? `${new Date(v.firstMs).toISOString().slice(0, 10)} → ${new Date(v.lastMs).toISOString().slice(0, 10)}`
      : "unknown span";
    console.log(`${v.rule_type.padEnd(16)} ${String(v.trades).padStart(6)} trades  ${String(v.tickers).padStart(3)} tickers  ${span}  ${v.timeframes.join(",")}`);
  }
  process.exit(0);
}

// Default to the most-traded variant rather than pooling. Pooling averages two different exit rules
// into one number that describes neither, which is precisely what the rule_type column exists to
// prevent — so it has to be opted into explicitly.
const ruleArg = arg("rule");
const ruleType = ruleArg === "all" ? null : (ruleArg ?? variants[0]?.rule_type ?? null);

let rows = tradeLog.readAllTradeLogs({ ruleType });
if (tfArg) {
  const want = tradeLog.timeframeLabel(tfArg);
  rows = rows.filter((r) => r.timeframe === want);
}

if (!rows.length) {
  if (variants.length && ruleType) {
    console.log(`No trades for exit rule "${ruleType}". Logged variants: ${variants.map((v) => v.rule_type).join(", ")}`);
  } else {
    console.log("No trades logged yet. Run: node scripts/backfill_trade_log.js");
  }
  process.exit(0);
}

console.log(`Exit rule: ${ruleType ?? "ALL VARIANTS POOLED"}${variants.length > 1 ? `  (of ${variants.length}: ${variants.map((v) => v.rule_type).join(", ")})` : ""}`);

const TF_ORDER = ["1m", "3m", "5m", "15m", "30m", "45m", "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1d", "1w", "1mo"];
const tfRank = (t) => { const i = TF_ORDER.indexOf(t); return i === -1 ? 999 : i; };

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function stats(list) {
  const wins = list.filter((r) => r.pnl_usd > 0);
  const losses = list.filter((r) => r.pnl_usd <= 0);
  const grossProfit = wins.reduce((s, r) => s + r.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl_usd, 0));
  const avg = (a, f) => (a.length ? a.reduce((s, r) => s + (f(r) || 0), 0) / a.length : 0);
  const expectancyPct = avg(list, (r) => r.pnl_pct);

  // Timeframes cannot be compared on total return: TradingView loads a bounded bar count, so a
  // 15m chart's history spans months where a 1D chart's spans years. Normalizing by the actual
  // calendar span of the logged trades is what makes "which timeframe pays better" answerable.
  const entries = list.map((r) => r.entry_time_ms).filter(Boolean);
  const exits = list.map((r) => r.exit_time_ms || r.entry_time_ms).filter(Boolean);
  const spanMs = entries.length && exits.length ? Math.max(...exits) - Math.min(...entries) : 0;
  const spanYears = spanMs / MS_PER_YEAR;
  const sumPct = list.reduce((s, r) => s + (r.pnl_pct || 0), 0);

  return {
    spanYears,
    spanFrom: entries.length ? new Date(Math.min(...entries)).toISOString().slice(0, 10) : "",
    spanTo: exits.length ? new Date(Math.max(...exits)).toISOString().slice(0, 10) : "",
    sumPct,
    // Simple (non-compounded) return per year — comparable across timeframes.
    pctPerYear: spanYears > 0 ? sumPct / spanYears : 0,
    tradesPerYear: spanYears > 0 ? list.length / spanYears : 0,
    n: list.length,
    wins: wins.length,
    winRate: list.length ? (wins.length / list.length) * 100 : 0,
    netUsd: grossProfit - grossLoss,
    // Real profit factor: every closed loser is in the denominator.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    expectancyPct,
    avgWinPct: avg(wins, (r) => r.pnl_pct),
    avgLossPct: avg(losses, (r) => r.pnl_pct),
    avgMfePct: avg(list, (r) => r.mfe_pct),
    avgMaePct: avg(list, (r) => r.mae_pct),
    avgBars: avg(list, (r) => r.bars_held),
    avgBarsWin: avg(wins, (r) => r.bars_held),
    avgBarsLoss: avg(losses, (r) => r.bars_held),
  };
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "inf");
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

function groupBy(list, keyFn) {
  const m = new Map();
  for (const r of list) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

console.log(`\nClosed trades logged: ${rows.length}  (timeframes: ${[...new Set(rows.map((r) => r.timeframe))].sort((a, b) => tfRank(a) - tfRank(b)).join(", ")})`);

if (by === "tf") {
  const groups = [...groupBy(rows, (r) => r.timeframe)].sort((a, b) => tfRank(a[0]) - tfRank(b[0]));
  console.log(`\n=== PER-TIMEFRAME (closed trades only) ===`);
  console.log(`${pad("TF", 6)}${lpad("n", 5)}${lpad("win%", 7)}${lpad("PF", 7)}${lpad("expect%", 9)}${lpad("avgWin%", 9)}${lpad("avgLoss%", 10)}${lpad("MFE%", 7)}${lpad("MAE%", 7)}${lpad("edge", 6)}${lpad("barsW", 7)}${lpad("barsL", 7)}`);
  for (const [tf, list] of groups) {
    const s = stats(list);
    const edge = s.avgMaePct > 0 ? s.avgMfePct / s.avgMaePct : Infinity;
    console.log(
      pad(tf, 6) + lpad(s.n, 5) + lpad(fmt(s.winRate, 0), 7) + lpad(fmt(s.profitFactor), 7) +
      lpad(fmt(s.expectancyPct), 9) + lpad(fmt(s.avgWinPct), 9) + lpad(fmt(s.avgLossPct), 10) +
      lpad(fmt(s.avgMfePct), 7) + lpad(fmt(s.avgMaePct), 7) + lpad(fmt(edge), 6) +
      lpad(fmt(s.avgBarsWin, 0), 7) + lpad(fmt(s.avgBarsLoss, 0), 7)
    );
  }

  // The apples-to-apples view. Total return per timeframe is meaningless on its own because each
  // timeframe's loaded history spans a different number of calendar years.
  console.log(`\n=== TIME-NORMALIZED (same data, per calendar year) ===`);
  console.log(`${pad("TF", 6)}${lpad("span(y)", 9)}${lpad("from", 12)}${lpad("to", 12)}${lpad("sum%", 9)}${lpad("%/year", 9)}${lpad("trades/y", 10)}`);
  for (const [tf, list] of groups) {
    const s = stats(list);
    console.log(
      pad(tf, 6) + lpad(fmt(s.spanYears), 9) + lpad(s.spanFrom, 12) + lpad(s.spanTo, 12) +
      lpad(fmt(s.sumPct, 0), 9) + lpad(fmt(s.pctPerYear, 0), 9) + lpad(fmt(s.tradesPerYear, 0), 10)
    );
  }
  console.log(`\n  sum% is per-trade returns added, not compounded, and assumes one position at a time`);
  console.log(`  per symbol — treat %/year as a comparison ratio between timeframes, not a CAGR forecast.`);
}

if (by === "symbol") {
  const groups = [...groupBy(rows, (r) => `${r.ticker}|${r.timeframe}`)]
    .map(([k, list]) => ({ k, list, s: stats(list) }))
    .filter((g) => g.s.n >= minTrades)
    .sort((a, b) => b.s.expectancyPct - a.s.expectancyPct);
  console.log(`\n=== PER SYMBOL|TF (>= ${minTrades} closed trades), ranked by expectancy per trade ===`);
  console.log(`${pad("SYMBOL|TF", 16)}${lpad("n", 4)}${lpad("win%", 6)}${lpad("PF", 8)}${lpad("expect%", 9)}${lpad("netUSD", 10)}${lpad("MFE%", 7)}${lpad("MAE%", 7)}`);
  for (const g of groups) {
    console.log(
      pad(g.k, 16) + lpad(g.s.n, 4) + lpad(fmt(g.s.winRate, 0), 6) + lpad(fmt(g.s.profitFactor), 8) +
      lpad(fmt(g.s.expectancyPct), 9) + lpad(fmt(g.s.netUsd, 0), 10) +
      lpad(fmt(g.s.avgMfePct), 7) + lpad(fmt(g.s.avgMaePct), 7)
    );
  }
}

if (by === "exit") {
  // The question this answers: is the trailing stop firing at all, or does every trade exit on a
  // signal flip? rules.json says trail_pct 2.0 while open positions carry 17-19% MAE.
  const groups = [...groupBy(rows, (r) => `${r.timeframe} | ${r.exit_signal || "(none)"}`)].sort();
  console.log(`\n=== EXIT REASONS (what actually closes trades) ===`);
  console.log(`${pad("TF | EXIT SIGNAL", 34)}${lpad("n", 5)}${lpad("share", 8)}${lpad("win%", 7)}${lpad("avgPnL%", 9)}${lpad("avgMAE%", 9)}`);
  const perTf = groupBy(rows, (r) => r.timeframe);
  for (const [k, list] of groups) {
    const tf = k.split(" | ")[0];
    const s = stats(list);
    const share = (list.length / perTf.get(tf).length) * 100;
    console.log(
      pad(k, 34) + lpad(s.n, 5) + lpad(`${fmt(share, 0)}%`, 8) + lpad(fmt(s.winRate, 0), 7) +
      lpad(fmt(s.expectancyPct), 9) + lpad(fmt(s.avgMaePct), 9)
    );
  }
}

console.log("");
