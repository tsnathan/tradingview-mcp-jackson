/**
 * Paper-run tracking: define a forward test once, then replay the SAME realized signal stream
 * through several slot counts.
 *
 * Why this exists rather than running two live arms: the executor is one account, so a 3-slot and a
 * 5-slot arm would both fire on the same symbols and collide. Fills in `simulatePortfolio` are
 * deterministic given the signal stream and the slot cap, so one live arm plus this replay yields
 * the whole slot sweep with no capital split and no second account.
 *
 * It deliberately does NOT record its own signal stream. `trade-log/*.csv` already captures every
 * closed trade the strategy produced, with entry/exit timestamps and prices — a parallel recorder
 * would be a second source of truth that could silently drift from it. This module is a *view* over
 * the trade log restricted to the run's universe, timeframes and start date.
 *
 * Two limitations that cannot be fixed here and are reported rather than hidden:
 *
 *  - **Closed trades only.** A position still open when the replay runs has no exit row yet, so it
 *    is invisible. Early in a run that is most of the book, which is why `openNow` is reported
 *    alongside every result — a 2-month replay showing 30 closed positions while 6 are still open is
 *    describing 30, not 36. Same limitation as `simulatePortfolio` generally.
 *  - **Universe epochs are chained, and a position open at a re-pick boundary is force-closed.**
 *    With median holds of ~2 days (15m) and ~4 days (30m) against monthly epochs this touches few
 *    positions, and it touches every slot variant identically, so the COMPARISON between slot counts
 *    stays fair even where an absolute figure is slightly off.
 */
import { simulatePortfolio } from "./portfolio_sim.js";
import { readAllTradeLogs, listRuleTypes, timeframeLabel } from "./trade_log.js";

export const DEFAULT_SLOT_VARIANTS = [1, 3, 5, 8, 10];

/**
 * Normalize the persisted config, filling defaults. Kept separate so both the replay and the API
 * validate against one definition.
 */
export function normalizePaperConfig(raw = {}) {
  const timeframes = Array.isArray(raw.timeframes) ? raw.timeframes.filter(Boolean) : [];
  const epochs = Array.isArray(raw.universeHistory) && raw.universeHistory.length
    ? raw.universeHistory
    : (Array.isArray(raw.universe) && raw.universe.length && raw.startedAt
      ? [{ committedAt: raw.startedAt, universe: raw.universe }]
      : []);
  return {
    startedAt: raw.startedAt || null,
    timeframes,
    capital: Number(raw.capital) > 0 ? Number(raw.capital) : 100000,
    slotVariants: Array.isArray(raw.slotVariants) && raw.slotVariants.length
      ? raw.slotVariants.map(Number).filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b)
      : DEFAULT_SLOT_VARIANTS,
    liveSlots: Number(raw.liveSlots) > 0 ? Number(raw.liveSlots) : null,
    ruleType: raw.ruleType ?? null,
    note: raw.note || "",
    universeHistory: epochs
      .map((e) => ({
        committedAt: e.committedAt,
        universe: Array.isArray(e.universe) ? e.universe : [],
        added: e.added || [],
        dropped: e.dropped || [],
      }))
      .filter((e) => e.committedAt && e.universe.length)
      .sort((a, b) => new Date(a.committedAt) - new Date(b.committedAt)),
  };
}

/** The universe epochs as [startMs, endMs) segments across the run. */
function epochSegments(cfg, endMs) {
  const eps = cfg.universeHistory;
  if (!eps.length) return [];
  const startMs = new Date(cfg.startedAt).getTime();
  const segs = [];
  for (let i = 0; i < eps.length; i++) {
    const from = Math.max(startMs, new Date(eps[i].committedAt).getTime());
    const to = i + 1 < eps.length ? new Date(eps[i + 1].committedAt).getTime() : endMs;
    if (to > from) segs.push({ from, to, universe: eps[i].universe, committedAt: eps[i].committedAt });
  }
  return segs;
}

/**
 * Replay one slot count across the run's epochs, chaining equity between them.
 * Returns null when the run produced no closed positions at all.
 */
function replaySlots(cfg, segments, slots) {
  let equity = cfg.capital;
  const perEpoch = [];
  let taken = 0, skipped = 0, wins = 0, grossProfit = 0, grossLoss = 0;
  let peak = cfg.capital, maxDD = 0;
  const curve = [];

  for (const seg of segments) {
    const r = simulatePortfolio({
      capital: equity,
      maxPositions: slots,
      timeframes: cfg.timeframes,
      tickers: seg.universe,
      priority: "chronological",
      ruleType: cfg.ruleType,
      startMs: seg.from,
      endMs: seg.to,
    });
    if (!r.available || !r.signalsTaken) {
      perEpoch.push({ committedAt: seg.committedAt, taken: 0, returnPct: 0, equityAfter: equity });
      continue;
    }
    taken += r.signalsTaken;
    skipped += r.signalsSkipped;
    // `simulatePortfolio` returns aggregates, not the per-trade array, so win/loss totals are
    // reconstructed from them. Counts are rounded because winRate is a percentage of an integer
    // count and can carry float error. `avgLossUsd` is returned NEGATIVE, hence the sign flip.
    const epochWins = Math.round(((r.winRate || 0) / 100) * r.signalsTaken);
    const epochLosses = r.signalsTaken - epochWins;
    wins += epochWins;
    grossProfit += (r.avgWinUsd || 0) * epochWins;
    grossLoss += -(r.avgLossUsd || 0) * epochLosses;
    // Equity curve points are absolute dollars already scaled by this epoch's starting equity, so
    // they concatenate directly into one continuous path.
    for (const p of r.equityCurve || []) {
      curve.push(p);
      if (p.equity > peak) peak = p.equity;
      const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    perEpoch.push({
      committedAt: seg.committedAt,
      taken: r.signalsTaken,
      returnPct: r.totalReturnPct,
      equityAfter: r.finalEquity,
    });
    equity = r.finalEquity;
  }

  if (!taken) return null;
  return {
    slots,
    finalEquity: equity,
    totalReturnPct: ((equity - cfg.capital) / cfg.capital) * 100,
    maxDrawdownPct: maxDD,
    returnDd: maxDD > 0 ? (((equity - cfg.capital) / cfg.capital) * 100) / maxDD : null,
    signalsTaken: taken,
    signalsSkipped: skipped,
    fillRate: taken + skipped > 0 ? (taken / (taken + skipped)) * 100 : null,
    winRate: taken > 0 ? (wins / taken) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    perEpoch,
    equityCurve: curve,
  };
}

/**
 * Replay the whole run.
 *
 * @param openTrades  The dashboard status's openTrades, used only to report how many positions are
 *                    still open and therefore missing from the closed-trade replay.
 */
export function replayPaperRun(rawConfig, { openTrades = [], nowMs = null } = {}) {
  const cfg = normalizePaperConfig(rawConfig);
  const ruleTypes = listRuleTypes();
  if (!cfg.startedAt) return { available: false, reason: "not_started", ruleTypes };
  if (!cfg.timeframes.length) return { available: false, reason: "no_timeframes", ruleTypes, config: cfg };
  if (!cfg.universeHistory.length) return { available: false, reason: "no_universe", ruleTypes, config: cfg };

  const end = nowMs ?? Date.now();
  const startMs = new Date(cfg.startedAt).getTime();
  const segments = epochSegments(cfg, end);
  if (!segments.length) return { available: false, reason: "no_epochs", ruleTypes, config: cfg };

  const variants = cfg.slotVariants.map((s) => replaySlots(cfg, segments, s)).filter(Boolean);

  // Positions the strategy currently holds inside this run's universe/timeframes — invisible to a
  // closed-trade replay, and the main reason an early-run result understates activity.
  const currentUniverse = new Set(segments[segments.length - 1].universe.map((t) => String(t).split(":").pop().toUpperCase()));
  const tfSet = new Set(cfg.timeframes);
  const openNow = (openTrades || []).filter((t) => {
    const tk = String(t.symbol || "").split(":").pop().toUpperCase();
    // Open-trade rows carry TradingView's RAW resolution ("120", "30"), not a label — comparing it
    // against label-form timeframes ("2h", "30m") silently matches nothing.
    const tf = t.timeframe === undefined || t.timeframe === null ? "" : timeframeLabel(t.timeframe);
    return currentUniverse.has(tk) && (!tf || tfSet.has(tf));
  });

  // How much of the closed-trade record actually falls inside the run — a sanity check that the
  // start date and universe are selecting anything at all.
  const inRun = readAllTradeLogs({ ruleType: cfg.ruleType }).filter(
    (r) => r.entry_time_ms >= startMs && cfg.timeframes.includes(r.timeframe) && currentUniverse.has(String(r.ticker).split(":").pop().toUpperCase())
  );

  return {
    available: variants.length > 0,
    reason: variants.length ? null : "no_closed_trades_yet",
    ruleType: cfg.ruleType,
    ruleTypes,
    config: cfg,
    startedAt: cfg.startedAt,
    asOf: new Date(end).toISOString(),
    daysElapsed: (end - startMs) / 864e5,
    epochs: segments.map((s) => ({
      committedAt: s.committedAt,
      from: new Date(s.from).toISOString(),
      to: new Date(Math.min(s.to, end)).toISOString(),
      universeSize: s.universe.length,
    })),
    variants,
    live: cfg.liveSlots ? variants.find((v) => v.slots === cfg.liveSlots) || null : null,
    closedInRun: inRun.length,
    openNow: openNow.length,
    openNowSymbols: openNow.map((t) => `${t.symbol}|${t.timeframe == null ? "?" : timeframeLabel(t.timeframe)}`),
  };
}
