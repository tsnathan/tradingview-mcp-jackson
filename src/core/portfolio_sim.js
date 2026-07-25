/**
 * Portfolio simulation over the closed-trade log.
 *
 * The per-symbol rankings answer "which candidates have an edge". They do NOT answer "what happens
 * to my account if I trade them with N position slots and X capital", which is a different question
 * with a different answer — because slots are a scarce resource. A symbol with a great CAGR is
 * worthless if its signals always arrive while every slot is already full, and a portfolio's
 * drawdown is driven by how many positions happen to be losing *at the same time*, which no
 * per-symbol statistic captures.
 *
 * Reads only `trade-log/*.csv` — no TradingView connection. That keeps this engine usable against
 * any future trade source with the same columns.
 *
 * Mechanics, and their limits:
 *
 * - **Slot allocation is chronological by default.** A signal takes a slot if one is free at its
 *   entry timestamp, otherwise it is skipped and counted. This is the honest simulation of a
 *   capacity limit; `priority: "rank"` instead lets higher-ranked symbols pre-empt nothing but
 *   does bias which signals win contention when several fire on the same bar.
 *
 * - **Position sizing is 1/N of portfolio value at entry**, where portfolio value is cash plus the
 *   cost basis of open positions. Cost basis rather than mark-to-market because the log stores
 *   entry price, exit price and excursions — not a bar-by-bar path — so intra-trade portfolio value
 *   is genuinely unknown. This makes sizing slightly conservative while positions are winning.
 *
 * - **Drawdown is measured on the realized equity curve** (equity is recorded at each exit). It
 *   therefore UNDERSTATES true drawdown, which would require intra-trade marks. `maeDrawdownEst`
 *   gives a worst-case companion figure using each trade's logged MAE, assuming concurrently-open
 *   positions hit their worst excursions together — a pessimistic bound, where the realized curve
 *   is an optimistic one. The truth is between them.
 *
 * - **Only closed trades exist in the log.** Positions still open are excluded entirely, so a
 *   simulation covering recent months omits exactly the losers that have not closed yet. Compare
 *   the returned `openExcluded` count against the total before trusting a short window.
 *
 * - **On contention (slots full), `contention.wouldBeatPct` reports how often the turned-away
 *   signal would, in hindsight, have out-earned the worst open position** — a real answer,
 *   available with no simulation of an eviction at all. `evictPolicy: "oracle-worst-final"`
 *   additionally SIMULATES evicting that worst position for the new signal, but it is upper-bound
 *   tooling, not a strategy: the decision uses each open position's already-known FINAL pnl_pct
 *   (this engine represents a position by its closed trade-log row from the moment it "opens," so
 *   the ending is baked in — nobody holding the position live would know it), and the evicted
 *   position's early-exit fill is a straight-line interpolation over elapsed time toward that same
 *   final result, since the log has no bar-by-bar price path to mark it against honestly. A real,
 *   tradeable version of this idea needs bar-level OHLCV per symbol/timeframe to (a) judge "worst
 *   open" from only past-known price action and (b) compute a real fill at the eviction instant —
 *   a materially bigger engine than this trade-list simulator. Treat its output as "is the ceiling
 *   worth that build," not as a return estimate.
 */
import { readAllTradeLogs } from "./trade_log.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Collapse pyramid tranches into the single position they actually are.
 *
 * Under a pyramid variant the strategy reports each tranche as its own row in `reportData().trades[]`
 * — a base leg and an "Pyramid Add" leg sharing one exit. Left unmerged they consume TWO position
 * slots and get sized independently, which both understates fill rate (measured: ~10 points on 4h)
 * and doubles per-symbol concentration. It also badly misstates the return: a real example is a base
 * leg at -2.08% alongside its add at +18.84%, which is a *positive* position scored as one loser and
 * one winner.
 *
 * Tranches are identified by sharing ticker + timeframe + exit timestamp, since every leg is closed
 * by the same flip signal. Returns are notional-weighted (qty x entry price), which is what the
 * blended cost basis actually earns.
 *
 * `sizeFactor` carries the other half of the story. The Pine script sizes the base leg at
 * 95/(1+addFrac) of equity so base+add together reach the same ~95% a flip-only entry uses. A
 * position whose add never fires therefore deploys only 1/(1+addFrac) of what it was allotted — real
 * idle capital that must not be silently credited as fully invested.
 */
function mergePositionTranches(rows, ruleType) {
  const m = /pyr(\d+(?:\.\d+)?)/.exec(String(ruleType || ""));
  const addFrac = m ? Number(m[1]) / 100 : 0;
  // Without a pyramid variant there are no tranches to merge; skip the work entirely.
  if (!addFrac) return { positions: rows.map((r) => ({ ...r, tranches: 1, sizeFactor: 1 })), merged: 0 };

  const byPos = new Map();
  for (const r of rows) {
    const k = `${r.ticker}|${r.timeframe}|${r.exit_time_ms}`;
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push(r);
  }

  const positions = [];
  let merged = 0;
  for (const tranches of byPos.values()) {
    if (tranches.length === 1) {
      // Base-only: the reserved add capital was never deployed.
      positions.push({ ...tranches[0], tranches: 1, sizeFactor: 1 / (1 + addFrac) });
      continue;
    }
    merged++;
    const notional = tranches.map((t) => Math.abs((t.qty || 0) * (t.entry_price || 0)));
    const total = notional.reduce((s, v) => s + v, 0);
    const wavg = (pick) => (total > 0
      ? tranches.reduce((s, t, i) => s + notional[i] * (pick(t) || 0), 0) / total
      : tranches.reduce((s, t) => s + (pick(t) || 0), 0) / tranches.length);
    // Slot is taken when the FIRST leg enters, and held until the shared exit.
    const base = tranches.reduce((a, b) => (a.entry_time_ms <= b.entry_time_ms ? a : b));
    positions.push({
      ...base,
      pnl_pct: wavg((t) => t.pnl_pct),
      mae_pct: wavg((t) => t.mae_pct),
      mfe_pct: wavg((t) => t.mfe_pct),
      qty: tranches.reduce((s, t) => s + (t.qty || 0), 0),
      tranches: tranches.length,
      sizeFactor: 1, // base + add together reach the full allotment
    });
  }
  return { positions, merged };
}

export function simulatePortfolio({
  capital = 100000,
  maxPositions = 5,
  timeframes = null,        // array of tf labels, or null for all
  tickers = null,           // array of tickers, or null for all
  priority = "chronological", // "chronological" | "rank"
  rankBy = {},              // { "TICKER|tf": score } used when priority === "rank"
  startMs = null,
  endMs = null,
  commissionPerTrade = 0,
  ruleType = null,          // exit-rule variant to simulate; null pools all (see readAllTradeLogs)
  // "oracle-worst-final" evicts the open position with the worst FINAL pnl_pct in favor of a
  // contending signal, IF that signal's own final pnl_pct is better. This is a deliberately
  // dishonest upper bound, not a tradeable policy — see the block comment above evictPolicy's use
  // below for why a real version cannot be built from this data model, and what would be needed.
  evictPolicy = null,
} = {}) {
  // Pooling variants here would be worse than in the edge analysis: the simulator allocates a
  // finite number of slots chronologically, so trades from two different exit rules would compete
  // for the same capital and produce a portfolio that never existed under either rule.
  let rows = readAllTradeLogs({ ruleType }).filter((r) => r.entry_time_ms && r.exit_time_ms);
  if (timeframes?.length) rows = rows.filter((r) => timeframes.includes(r.timeframe));
  if (tickers?.length) rows = rows.filter((r) => tickers.includes(r.ticker));
  if (startMs) rows = rows.filter((r) => r.entry_time_ms >= startMs);
  if (endMs) rows = rows.filter((r) => r.exit_time_ms <= endMs);

  if (!rows.length) {
    return { available: false, reason: "no_trades_in_selection" };
  }

  // Margin-call rows are artifacts of over-sizing on the live chart (token quantity liquidated on
  // the entry bar), not independent trading decisions. Including them would consume a slot for a
  // -0.2% non-event.
  const marginCalls = rows.filter((r) => /margin call/i.test(r.exit_signal || "")).length;
  rows = rows.filter((r) => !/margin call/i.test(r.exit_signal || ""));

  // Pyramid legs are one position, not two competing for slots and capital.
  const { positions, merged: trancheMerges } = mergePositionTranches(rows, ruleType);
  rows = positions;

  const sorted = [...rows].sort((a, b) => {
    if (a.entry_time_ms !== b.entry_time_ms) return a.entry_time_ms - b.entry_time_ms;
    if (priority === "rank") {
      const sa = rankBy[`${a.ticker}|${a.timeframe}`] ?? -Infinity;
      const sb = rankBy[`${b.ticker}|${b.timeframe}`] ?? -Infinity;
      if (sa !== sb) return sb - sa;
    }
    return 0;
  });

  let cash = capital;
  const open = [];           // { exitMs, cost, pnlPct, maePct, row }
  const equityCurve = [];    // { t, equity, openCount }
  // Every entry AND exit, in the order they actually change portfolio state — the basis for the
  // time-weighted capital-utilization stats below. equityCurve alone can't answer "what fraction of
  // the calendar were we invested" because it only records exit instants; the deployed-vs-cash split
  // is equally set (and holds constant) the moment an entry is taken, not just when it closes.
  const stateTimeline = [];
  const taken = [];
  let skipped = 0;
  const skippedByKey = {};
  let peak = capital;
  let maxDD = 0;
  // Diagnostic, collected regardless of evictPolicy: every time a signal is turned away for lack
  // of a slot, would it — in HINDSIGHT, comparing final outcomes — have beaten the worst
  // currently-open position? This answers "is contention ever costing us anything" without
  // needing to simulate a fill for an early exit, which the fields below cannot honestly do.
  let contentionEvents = 0;
  let contentionWouldBeat = 0;
  let evictions = 0;

  const openCost = () => open.reduce((s, p) => s + p.cost, 0);

  // Shared by a natural exit and a forced eviction: realize `pnlPct` on `p` (already removed from
  // `open`) at time `t`, and record the equity/timeline/drawdown events at that instant. Keeping
  // one path for both means an evicted position affects drawdown tracking exactly like a real
  // exit would, instead of the eviction silently skipping the accounting a normal close gets.
  function realizeClose(p, t, pnlPct) {
    const proceeds = p.cost * (1 + pnlPct / 100) - commissionPerTrade;
    cash += proceeds;
    const equity = cash + openCost();
    equityCurve.push({ t, equity, openCount: open.length });
    stateTimeline.push({ t, openCount: open.length, deployed: openCost(), cash });
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    p.result = { proceeds, equityAfter: equity };
  }

  // Close every position whose exit precedes `t`, in exit order, so cash is available to later
  // entries and the equity curve is recorded at the right instants.
  function closeUntil(t) {
    open.sort((a, b) => a.exitMs - b.exitMs);
    while (open.length && open[0].exitMs <= t) {
      const p = open.shift();
      realizeClose(p, p.exitMs, p.pnlPct);
    }
  }

  for (const r of sorted) {
    closeUntil(r.entry_time_ms);

    if (open.length >= maxPositions) {
      // "Worst" here means final pnlPct, which is only knowable because this simulator represents
      // a position by its already-closed trade-log row — the final outcome is baked in from the
      // moment it "opens" in this model. In reality nobody knows a position's eventual result
      // while it's still live; a genuine eviction rule would need bar-by-bar marks (current
      // unrealized P&L) to decide with, which trade-log CSVs of {entry, exit, final MAE/MFE} do
      // not carry — see the module doc's note on why drawdown itself is already an estimate for
      // the same reason. So this whole branch is upper-bound tooling, not a strategy.
      let worstIdx = -1, worstPnl = Infinity;
      for (let i = 0; i < open.length; i++) {
        if (open[i].pnlPct < worstPnl) { worstPnl = open[i].pnlPct; worstIdx = i; }
      }
      const wouldBeat = worstIdx !== -1 && (r.pnl_pct || 0) > worstPnl;
      contentionEvents++;
      if (wouldBeat) contentionWouldBeat++;

      if (evictPolicy === "oracle-worst-final" && wouldBeat) {
        const evicted = open[worstIdx];
        // The evicted position hasn't reached its real exit yet, so its full final pnlPct cannot
        // be realized now — that would credit it with P&L it hadn't earned at this point in time.
        // Straight-line interpolation over elapsed calendar time against its own eventual holding
        // period is a crude stand-in for a real intrabar mark (which this data model doesn't
        // have), not a claim that P&L actually moves linearly.
        const dur = evicted.exitMs - evicted.entryMs;
        const frac = dur > 0 ? Math.min(1, Math.max(0, (r.entry_time_ms - evicted.entryMs) / dur)) : 1;
        const interpPnlPct = evicted.pnlPct * frac;
        open.splice(worstIdx, 1);
        realizeClose(evicted, r.entry_time_ms, interpPnlPct);
        // Overwrite the bookkeeping record too — it was created at entry time carrying the FULL
        // final outcome, which is no longer what actually happened once cut short here. Without
        // this, win rate/profit factor/per-symbol P&L would keep crediting the un-evicted result.
        evicted.takenRef.pnlPct = interpPnlPct;
        evicted.takenRef.pnlUsd = evicted.cost * (interpPnlPct / 100);
        evicted.takenRef.exitMs = r.entry_time_ms;
        evicted.takenRef.exitSignal = "Evicted (oracle)";
        evicted.takenRef.evicted = true;
        evicted.takenRef.originalFinalPnlPct = evicted.pnlPct;
        evictions++;
        // Falls through to the normal entry logic below — the freed slot is taken immediately.
      } else {
        skipped++;
        const k = `${r.ticker}|${r.timeframe}`;
        skippedByKey[k] = (skippedByKey[k] || 0) + 1;
        continue;
      }
    }

    const portfolioValue = cash + openCost();
    // sizeFactor < 1 means a pyramid position whose add never fired, so its reserved add capital
    // stayed in cash. Crediting it as fully deployed would invent returns on money never at risk.
    let size = (portfolioValue / maxPositions) * (r.sizeFactor ?? 1);
    // Never allocate more than available cash — a slot being free does not mean capital is.
    if (size > cash) size = cash;
    if (size <= 0) {
      skipped++;
      const k = `${r.ticker}|${r.timeframe}`;
      skippedByKey[k] = (skippedByKey[k] || 0) + 1;
      continue;
    }

    cash -= size;
    const takenEntry = {
      ticker: r.ticker,
      timeframe: r.timeframe,
      entryMs: r.entry_time_ms,
      exitMs: r.exit_time_ms,
      size,
      pnlPct: r.pnl_pct || 0,
      pnlUsd: size * ((r.pnl_pct || 0) / 100),
      maePct: r.mae_pct || 0,
      exitSignal: r.exit_signal || "",
    };
    // `open`'s copy keeps a reference to its `taken` record so an eviction (below) can overwrite
    // the assumed final outcome with what was actually realized — without it, win rate/profit
    // factor/per-symbol P&L would silently keep crediting the FULL final result even for a
    // position closed early, while cash/equity correctly reflect only the interpolated partial.
    const pos = {
      entryMs: r.entry_time_ms,
      exitMs: r.exit_time_ms,
      cost: size,
      pnlPct: r.pnl_pct || 0,
      maePct: r.mae_pct || 0,
      row: r,
      takenRef: takenEntry,
    };
    open.push(pos);
    stateTimeline.push({ t: r.entry_time_ms, openCount: open.length, deployed: openCost(), cash });
    taken.push(takenEntry);
  }

  // Drain anything still open at the end of the data.
  closeUntil(Infinity);

  // Time-weighted capital utilization: integrate openCount and deployed% over the actual calendar,
  // not over the count of trade events. Two portfolios that are both "full 15/15" once — one for an
  // afternoon, one for six months — read identically under a plain event tally; only weighting each
  // state by how long it actually held answers "what ratio of time is my capital sitting in cash."
  stateTimeline.sort((a, b) => a.t - b.t);
  let occupiedMs = new Array(maxPositions + 1).fill(0);
  let weightedOpenMs = 0;
  let weightedDeployedPctMs = 0;
  let totalMs = 0;
  for (let i = 0; i < stateTimeline.length - 1; i++) {
    const cur = stateTimeline[i];
    const dt = stateTimeline[i + 1].t - cur.t;
    if (dt <= 0) continue;
    totalMs += dt;
    const k = Math.min(cur.openCount, maxPositions);
    occupiedMs[k] += dt;
    weightedOpenMs += cur.openCount * dt;
    const portfolioVal = cur.deployed + cur.cash;
    const deployedPct = portfolioVal > 0 ? (cur.deployed / portfolioVal) * 100 : 0;
    weightedDeployedPctMs += deployedPct * dt;
  }
  const avgPositionsOpen = totalMs > 0 ? weightedOpenMs / totalMs : 0;
  const avgCapitalDeployedPct = totalMs > 0 ? weightedDeployedPctMs / totalMs : 0;
  const capitalUtilization = {
    avgPositionsOpen,
    avgSlotUtilizationPct: maxPositions > 0 ? (avgPositionsOpen / maxPositions) * 100 : 0,
    avgCapitalDeployedPct,
    avgCashPct: 100 - avgCapitalDeployedPct,
    // % of total simulated time spent holding exactly k positions, k = 0..maxPositions.
    timeAtOccupancyPct: occupiedMs.map((ms) => (totalMs > 0 ? (ms / totalMs) * 100 : 0)),
    fullyIdlePct: totalMs > 0 ? (occupiedMs[0] / totalMs) * 100 : 0,
    fullyDeployedPct: totalMs > 0 ? (occupiedMs[maxPositions] / totalMs) * 100 : 0,
  };

  const finalEquity = cash;
  const startAt = Math.min(...sorted.map((r) => r.entry_time_ms));
  const endAt = Math.max(...sorted.map((r) => r.exit_time_ms));
  const years = (endAt - startAt) / MS_PER_YEAR;
  const totalReturnPct = ((finalEquity - capital) / capital) * 100;
  const cagr = years > 0.08 ? (Math.pow(Math.max(finalEquity / capital, 0.0001), 1 / years) - 1) * 100 : null;

  // Pessimistic companion to the realized-curve drawdown: assume every position open at the same
  // time simultaneously sits at its worst logged excursion. Real drawdown lies between the two.
  let maeDrawdownEst = 0;
  {
    const events = [];
    for (const t of taken) {
      events.push({ t: t.entryMs, d: 1, mae: t.maePct, size: t.size });
      events.push({ t: t.exitMs, d: -1, mae: t.maePct, size: t.size });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d);
    const live = new Map();
    let idx = 0;
    for (const e of events) {
      if (e.d === 1) live.set(idx++, e);
      else {
        for (const [k, v] of live) if (v.size === e.size && v.mae === e.mae) { live.delete(k); break; }
      }
      let hit = 0, base = 0;
      for (const [, v] of live) { hit += v.size * (v.mae / 100); base += v.size; }
      const eq = equityAt(equityCurve, e.t, capital);
      const pct = eq > 0 ? (hit / eq) * 100 : 0;
      if (pct > maeDrawdownEst) maeDrawdownEst = pct;
    }
  }

  const wins = taken.filter((t) => t.pnlUsd > 0);
  const losses = taken.filter((t) => t.pnlUsd <= 0);
  const gp = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));

  // Slot occupancy — the direct read on whether maxPositions is the binding constraint.
  const occupancy = {};
  for (const p of equityCurve) occupancy[p.openCount] = (occupancy[p.openCount] || 0) + 1;

  const perSymbol = {};
  for (const t of taken) {
    const k = `${t.ticker}|${t.timeframe}`;
    perSymbol[k] = perSymbol[k] || { ticker: t.ticker, timeframe: t.timeframe, trades: 0, pnlUsd: 0, wins: 0 };
    perSymbol[k].trades++;
    perSymbol[k].pnlUsd += t.pnlUsd;
    if (t.pnlUsd > 0) perSymbol[k].wins++;
  }

  return {
    available: true,
    inputs: { capital, maxPositions, priority, timeframes, tickers, commissionPerTrade, ruleType },
    startAt: new Date(startAt).toISOString().slice(0, 10),
    endAt: new Date(endAt).toISOString().slice(0, 10),
    years,
    finalEquity,
    totalReturnPct,
    cagr,
    maxDrawdownPct: maxDD,
    maeDrawdownEst,
    cagrDd: maxDD > 0 && cagr !== null ? cagr / maxDD : null,
    signalsAvailable: sorted.length,
    signalsTaken: taken.length,
    signalsSkipped: skipped,
    fillRate: sorted.length ? (taken.length / sorted.length) * 100 : 0,
    marginCallsExcluded: marginCalls,
    // Positions whose pyramid add fired, so base+add were merged into one slot.
    trancheMerges,
    winRate: taken.length ? (wins.length / taken.length) * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : null,
    avgWinUsd: wins.length ? gp / wins.length : 0,
    avgLossUsd: losses.length ? -gl / losses.length : 0,
    expectancyUsd: taken.length ? (gp - gl) / taken.length : 0,
    equityCurve: downsample(equityCurve, 400),
    occupancy,
    capitalUtilization,
    skippedByKey,
    perSymbol: Object.values(perSymbol).sort((a, b) => b.pnlUsd - a.pnlUsd),
    tradesPerYear: years > 0 ? taken.length / years : 0,
    // See evictPolicy's block comment above: "wouldBeat" compares FINAL outcomes, so it is a
    // hindsight diagnostic of whether contention ever costs anything — not evidence any of this
    // could be acted on live. evictions/evictPolicy are only non-zero when evictPolicy was passed.
    contention: {
      events: contentionEvents,
      wouldBeatWorstOpen: contentionWouldBeat,
      wouldBeatPct: contentionEvents ? (contentionWouldBeat / contentionEvents) * 100 : null,
      evictPolicy,
      evictions,
    },
  };
}

function equityAt(curve, t, fallback) {
  if (!curve.length) return fallback;
  let eq = fallback;
  for (const p of curve) {
    if (p.t > t) break;
    eq = p.equity;
  }
  return eq;
}

// Keep the payload small for the browser while preserving the shape of the curve, including its
// extremes — dropping a peak or trough would misrepresent drawdown visually.
function downsample(curve, maxPoints) {
  if (curve.length <= maxPoints) return curve;
  const step = curve.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(curve.length, Math.floor((i + 1) * step));
    let lo = curve[a], hi = curve[a];
    for (let j = a; j < b; j++) {
      if (curve[j].equity < lo.equity) lo = curve[j];
      if (curve[j].equity > hi.equity) hi = curve[j];
    }
    if (lo.t <= hi.t) { out.push(lo); if (hi !== lo) out.push(hi); }
    else { out.push(hi); if (hi !== lo) out.push(lo); }
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Run the same selection across several slot counts, to expose where capacity stops binding. */
export function sweepMaxPositions({ capital, timeframes, tickers, priority, rankBy, ruleType = null, evictPolicy = null, slots = [1, 2, 3, 5, 8, 10, 15, 20] } = {}) {
  const out = [];
  for (const maxPositions of slots) {
    const r = simulatePortfolio({ capital, maxPositions, timeframes, tickers, priority, rankBy, ruleType, evictPolicy });
    if (!r.available) continue;
    out.push({
      maxPositions,
      cagr: r.cagr,
      maxDrawdownPct: r.maxDrawdownPct,
      cagrDd: r.cagrDd,
      totalReturnPct: r.totalReturnPct,
      finalEquity: r.finalEquity,
      fillRate: r.fillRate,
      signalsTaken: r.signalsTaken,
      signalsSkipped: r.signalsSkipped,
      winRate: r.winRate,
      contentionPct: r.signalsAvailable ? (r.contention.events / r.signalsAvailable) * 100 : 0,
      contentionWouldBeatPct: r.contention.wouldBeatPct,
      evictions: r.contention.evictions,
    });
  }
  return out;
}
