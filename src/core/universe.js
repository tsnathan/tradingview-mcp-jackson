/**
 * Universe selection for a fixed-slot book — "which symbols should this portfolio be allowed to
 * trade", as opposed to `edge_analysis.js`'s "how good is each symbol", which it builds on.
 *
 * Three things here differ from the dashboard's original Top-20 picker, each for a measured reason:
 *
 * 1. **Ranked WITHIN the timeframes actually being traded.** The original picker took one timeframe
 *    per ticker across all eight, so a ticker could enter the universe on its 4h record and then be
 *    traded on 15m/30m signals that were never ranked. Measured on the real log, that put rows in
 *    the Top-20 whose ranking timeframe was not in the selection at all.
 *
 * 2. **Blended with a pooled all-timeframe percentile.** 30m history begins 2026-01-12, so a
 *    fast-timeframe-only expectancy rests on a handful of very recent trades and will churn on
 *    noise. Measured on this log, a ticker's expectancy on the slow timeframes predicts its fast
 *    expectancy at Spearman rho **0.686** — far stronger than expectancy predicts itself forward in
 *    time (~0.38) — so the pooled leg is measuring the same underlying symbol quality on 3-5x the
 *    sample. Selecting the top 20 on slow-timeframe data alone lifted mean fast expectancy from
 *    1.75% to 2.24%. The blend damps churn without abandoning the timeframes being traded.
 *
 *    Note the transfer figure is CONTEMPORANEOUS (both legs measured over all available history), so
 *    it says "good symbols are good on both" and not "the past predicts the future". It justifies
 *    pooling for a bigger sample; it is not itself an out-of-sample result.
 *
 * 3. **Hysteresis on re-picks.** A monthly re-pick adds only ~5 (15m) / ~3 (30m) trades per symbol,
 *    so ranks move on very little new information; measured month-over-month churn is ~25% even on
 *    an all-history lookback. A held name is therefore kept until it falls outside a wider band than
 *    the one required to enter, so the book is not rebuilt every month on noise.
 *
 * The lookback is deliberately ALL history by default. Measured: a trailing 30-day window leaves
 * 0-4 eligible symbols and a 90-day window churns 60% per month. Short lookbacks do not work here.
 */
import { readAllTradeLogs, listRuleTypes, timeframeLabel } from "./trade_log.js";

/**
 * Current, per-timeframe watchlist membership: which tickers are ACTUALLY scanned on each
 * timeframe right now.
 *
 * This exists because the trade log is append-only history: a symbol removed from a watchlist keeps
 * its rows forever and therefore keeps ranking forever. Measured live 2026-08-01, ranking without
 * this gate put 3 of 15 picks (KORU, MU, EWY on 30m) into a 15m+30m universe when none of them are
 * scanned on 30m any more — KORU was the top-ranked pick, so the best slot in the book was being
 * spent on a symbol that can never produce another 30m signal.
 *
 * **`watchlistNames` must come from `rules.json`'s configured names.** `baseline.watchlists`
 * accumulates dead entries under old names forever — nothing prunes them on a rename — and this
 * project has a live example: `"Swing 30min"` still holds 8 symbols including KORU, superseded by
 * `"Swing 30m"`. Reading the baseline without the allowlist would pass KORU as "still a member" and
 * defeat the whole check. Identical reasoning to `findWatchlistOrphans`, which needed the same fix.
 *
 * Note this is per (ticker, TIMEFRAME) — deliberately stricter than the orphan check, which is
 * ticker-level. KORU is legitimately still live on 3h, so it is correctly not an orphan; it is
 * still ineligible for a 30m slot.
 *
 * @returns {{ byTimeframe: Map<string, Set<string>>, timeframes: string[], names: string[], total: number }}
 *          Timeframes are LABEL form ("30m"), matching trade-log rows.
 */
export function buildWatchlistMembership(rules, baseline) {
  const allowed = new Set(Object.keys(rules?.watchlists || {}));
  const byTimeframe = new Map();
  for (const [name, w] of Object.entries(baseline?.watchlists || {})) {
    if (!allowed.has(name)) continue;
    const label = timeframeLabel(w?.timeframe);
    if (!label || label === "unknown") continue;
    if (!byTimeframe.has(label)) byTimeframe.set(label, new Set());
    const set = byTimeframe.get(label);
    for (const s of w?.symbols || []) {
      const t = String(s ?? "").split(":").pop().toUpperCase();
      if (t) set.add(t);
    }
  }
  let total = 0;
  for (const set of byTimeframe.values()) total += set.size;
  return { byTimeframe, timeframes: [...byTimeframe.keys()], names: [...allowed], total };
}

/** Closed trades a (ticker, timeframe) pair needs before it may be ranked at all. */
export const UNIVERSE_MIN_TRADES = 8;
/** Pair needs this many ranked peers on its timeframe before a percentile means anything. */
const MIN_PEERS = 4;
/**
 * A held symbol survives until it falls outside `size * HYSTERESIS`. 1.35 keeps a 15-name universe
 * stable unless a name drops past rank ~20 — wide enough to absorb a month of noise, tight enough
 * that a genuinely decayed symbol still leaves within a re-pick or two.
 */
export const HYSTERESIS = 1.35;

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** Percentile (0-100) of each item's value within `list`. Ties resolve by sort position. */
function percentiles(list, valueOf) {
  const ok = list.filter((x) => Number.isFinite(valueOf(x)));
  ok.sort((a, b) => valueOf(a) - valueOf(b));
  const out = new Map();
  ok.forEach((x, i) => out.set(x, ok.length > 1 ? (i / (ok.length - 1)) * 100 : 50));
  return out;
}

/**
 * Build the ranked universe.
 *
 * @param timeframes  Timeframes the book will actually trade. Required — this is the whole point.
 * @param size        Target universe size.
 * @param held        Tickers currently held in the universe, for hysteresis. Pass [] for a cold pick.
 * @param blend       Weight on the traded-timeframe percentile, 0..1. The remainder goes to the
 *                    pooled all-timeframe percentile. 0.5 is the measured-default compromise.
 * @param asOfMs      Only use trades CLOSED before this instant. Lets a caller reproduce a past
 *                    pick without lookahead; defaults to now.
 * @param membership  Result of `buildWatchlistMembership()`. When given, a (ticker, timeframe) pair
 *                    is eligible ONLY if that ticker is currently scanned on that timeframe — the
 *                    trade log alone would keep ranking symbols long after they were dropped.
 *                    Omitting it ranks over all logged history, which is right for analysing the
 *                    PAST (those trades genuinely happened) and wrong for picking a FORWARD
 *                    universe, where a dropped symbol can never produce another signal.
 */
export function buildUniverse({
  timeframes = [],
  size = 15,
  held = [],
  blend = 0.5,
  ruleType = null,
  minTrades = UNIVERSE_MIN_TRADES,
  asOfMs = null,
  hysteresis = HYSTERESIS,
  membership = null,
} = {}) {
  const ruleTypes = listRuleTypes();
  if (!timeframes.length) return { available: false, reason: "no_timeframes", ruleTypes };

  const cutoff = asOfMs ?? Date.now();
  const rows = readAllTradeLogs({ ruleType })
    .filter((r) => r.entry_time_ms && r.exit_time_ms && r.exit_time_ms < cutoff);
  if (!rows.length) return { available: false, reason: "no_trades", ruleType, ruleTypes };

  // --- traded-timeframe leg: percentile within each traded timeframe, best timeframe per ticker.
  const tradedRows = rows.filter((r) => timeframes.includes(r.timeframe));
  const byPair = new Map();
  for (const r of tradedRows) {
    const k = `${r.ticker}|${r.timeframe}`;
    if (!byPair.has(k)) byPair.set(k, { ticker: r.ticker, timeframe: r.timeframe, pnls: [] });
    byPair.get(k).pnls.push(r.pnl_pct);
  }
  // Membership gate. Applied BEFORE percentiles are computed, so a stale pair cannot shift the
  // ranking of the tradable ones — a symbol that can never signal again must not influence where
  // the symbols that can are placed.
  const excludedStale = [];
  const isScanned = (ticker, tf) => {
    if (!membership) return true;
    const set = membership.byTimeframe.get(tf);
    // An empty membership map means "unknown", not "nothing is tradable" — same reasoning as
    // findWatchlistOrphans, where treating unknown as empty would have offered to archive
    // everything. Refusing to rank anything here would be the equivalent failure.
    if (!membership.total) return true;
    return Boolean(set && set.has(ticker));
  };

  const pairs = [];
  for (const v of byPair.values()) {
    if (v.pnls.length < minTrades) continue;
    if (!isScanned(v.ticker, v.timeframe)) {
      excludedStale.push({ ticker: v.ticker, timeframe: v.timeframe, trades: v.pnls.length, exp: mean(v.pnls) });
      continue;
    }
    pairs.push({ ...v, exp: mean(v.pnls), n: v.pnls.length });
  }
  excludedStale.sort((a, b) => b.exp - a.exp);
  const byTf = new Map();
  for (const p of pairs) {
    if (!byTf.has(p.timeframe)) byTf.set(p.timeframe, []);
    byTf.get(p.timeframe).push(p);
  }
  for (const [, list] of byTf) {
    // Under a few peers a percentile is noise dressed as precision — same floor edge_analysis uses.
    const pcts = list.length >= MIN_PEERS ? percentiles(list, (x) => x.exp) : null;
    for (const p of list) p.pct = pcts ? pcts.get(p) : null;
  }
  // One timeframe per ticker: the same name twice is one instrument and two commissions.
  const bestTraded = new Map();
  for (const p of pairs) {
    if (p.pct === null) continue;
    const prev = bestTraded.get(p.ticker);
    if (!prev || p.pct > prev.pct) bestTraded.set(p.ticker, p);
  }

  // --- pooled leg: every timeframe's trades for the ticker, ranked against all other tickers.
  const pooledByTicker = new Map();
  for (const r of rows) {
    if (!pooledByTicker.has(r.ticker)) pooledByTicker.set(r.ticker, []);
    pooledByTicker.get(r.ticker).push(r.pnl_pct);
  }
  const pooled = [];
  for (const [ticker, pnls] of pooledByTicker) {
    if (pnls.length < minTrades) continue;
    pooled.push({ ticker, exp: mean(pnls), n: pnls.length });
  }
  const pooledPct = pooled.length >= MIN_PEERS ? percentiles(pooled, (x) => x.exp) : null;
  const pooledByName = new Map();
  for (const p of pooled) pooledByName.set(p.ticker, { ...p, pct: pooledPct ? pooledPct.get(p) : null });

  // --- blend. A ticker must qualify on the TRADED timeframes to be eligible at all; the pooled leg
  // only adjusts its position. Letting a ticker in on pooled evidence alone would reintroduce
  // exactly the defect this module exists to fix.
  const w = Math.min(1, Math.max(0, blend));
  const candidates = [];
  for (const [ticker, t] of bestTraded) {
    const p = pooledByName.get(ticker);
    const pooledScore = p && Number.isFinite(p.pct) ? p.pct : null;
    // With no usable pooled percentile the traded percentile carries the full weight, rather than
    // being dragged toward zero by a missing value.
    const score = pooledScore === null ? t.pct : w * t.pct + (1 - w) * pooledScore;
    candidates.push({
      ticker,
      timeframe: t.timeframe,
      tradedExpPct: t.exp,
      tradedTrades: t.n,
      tradedPercentile: t.pct,
      pooledExpPct: p ? p.exp : null,
      pooledTrades: p ? p.n : 0,
      pooledPercentile: pooledScore,
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, i) => { c.rank = i + 1; });

  // --- hysteresis: take the top `size`, then let held names that merely slipped stay in, displacing
  // the weakest newcomers. Applied only when a previous universe was supplied.
  const heldSet = new Set((held || []).map((t) => String(t).split(":").pop().toUpperCase()));
  const keepBand = Math.max(size, Math.round(size * hysteresis));
  const selected = [];
  const reasons = new Map();
  for (const c of candidates) {
    if (selected.length >= size) break;
    if (c.rank <= size) { selected.push(c); reasons.set(c.ticker, heldSet.has(c.ticker) ? "held" : "new"); }
  }
  if (heldSet.size) {
    const inSel = new Set(selected.map((c) => c.ticker));
    const survivors = candidates.filter((c) => heldSet.has(c.ticker) && !inSel.has(c.ticker) && c.rank <= keepBand);
    for (const s of survivors) {
      // Displace the weakest CURRENTLY-SELECTED newcomer, never another held name.
      let worstIdx = -1;
      for (let i = selected.length - 1; i >= 0; i--) {
        if (!heldSet.has(selected[i].ticker)) { worstIdx = i; break; }
      }
      if (worstIdx === -1) break;
      if (selected[worstIdx].score >= s.score && selected.length >= size) {
        reasons.delete(selected[worstIdx].ticker);
        selected.splice(worstIdx, 1);
        selected.push(s);
        reasons.set(s.ticker, "held-hysteresis");
      }
    }
    selected.sort((a, b) => b.score - a.score);
  }

  const selectedSet = new Set(selected.map((c) => c.ticker));
  return {
    available: true,
    ruleType,
    ruleTypes,
    timeframes,
    size,
    blend: w,
    minTrades,
    hysteresis,
    asOf: new Date(cutoff).toISOString(),
    // Surfaced, not silently dropped: "this symbol ranks well but is no longer scanned on this
    // timeframe" is a fact worth seeing — it is usually either a deliberate removal or a watchlist
    // that needs re-adding, and the two look identical if the row just disappears.
    membershipApplied: Boolean(membership && membership.total),
    membershipTotal: membership?.total ?? null,
    excludedStale,
    eligible: candidates.length,
    universe: selected.map((c) => ({ ...c, status: reasons.get(c.ticker) || "new" })),
    candidates: candidates.slice(0, Math.max(size * 3, 40)),
    // What a re-pick would change, so the caller can show it before committing.
    added: selected.filter((c) => !heldSet.has(c.ticker)).map((c) => c.ticker),
    dropped: [...heldSet].filter((t) => !selectedSet.has(t)),
    kept: selected.filter((c) => heldSet.has(c.ticker)).map((c) => c.ticker),
  };
}
