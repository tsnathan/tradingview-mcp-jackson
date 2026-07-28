/**
 * Symbol lookup — "what do we know about SYMBOL right now", assembled purely from data already
 * produced elsewhere (baseline watchlist membership, the live open-trades snapshot, and the
 * closed-trade log). No TradingView connection here; this is a read-only join over existing state,
 * the same shape as `portfolio_sim.js`'s "reads only trade-log/*.csv" design.
 *
 * Ticker matching is exchange-prefix-insensitive throughout (BATS:SOXL / AMEX:SOXL / SOXL all match
 * "SOXL"), mirroring `normalizeSymbolForMatch` in morning.js — a symbol can trade under a different
 * prefix in different watchlists (documented gotcha: AMEX:AGQ vs BATS:AGQ for the same instrument).
 */
import { readAllTradeLogs, listRuleTypes } from "./trade_log.js";
import { buildEdgeAnalysis } from "./edge_analysis.js";
import { sentKey, readSentState } from "./trade_webhook.js";

/**
 * Webhook send status for one closed trade row, keyed exactly the way the webhook ledger is:
 * bareTicker|timeframeTag|rawEntryTimeISO. `row.ticker`/`row.timeframe` from the trade log are
 * already in bare/label form (idempotent through bareTicker()/timeframeTag()), so entry_time_ms
 * converted to ISO is the only transform needed — confirmed live against TD's real sent entry.
 */
function webhookStatusForRow(row, sentState) {
  if (!row.entry_time_ms) return { webhookSent: false, webhookExitSent: false };
  const key = sentKey({ symbol: row.ticker, timeframe: row.timeframe, entryTime: new Date(row.entry_time_ms).toISOString() });
  const sent = key ? sentState.sent[key] : null;
  return { webhookSent: Boolean(sent), webhookExitSent: Boolean(sent?.exit) };
}

export function normalizeTicker(value) {
  return String(value ?? "").trim().split(":").pop()?.toUpperCase() || "";
}

/**
 * @param query          Raw user input, any case, with or without exchange prefix.
 * @param baseline       Parsed swing-signal-baseline.json (for watchlist membership).
 * @param openTrades     The dashboard status's `openTrades` array (already-shaped rows).
 * @param openBySymbolTf Same shape `buildEdgeAnalysis` already takes — live openPct/maxDDPct per
 *                        "TICKER|tflabel", sourced from strategy-perf snapshots. Passed through so
 *                        this view's per-timeframe stats agree with the Edge Analysis tab exactly,
 *                        rather than recomputing a second, possibly-diverging version.
 * @param ruleType       Exit-rule variant to filter closed trades/stats by (see trade_log.js) —
 *                        pooling variants for one symbol would silently blend regimes, same reason
 *                        every other consumer of the trade log threads this through.
 */
export function lookupSymbol(query, { baseline = {}, openTrades = [], openBySymbolTf = {}, ruleType = null, closedTradeLimit = 100 } = {}) {
  const ticker = normalizeTicker(query);
  if (!ticker) {
    return { available: false, reason: "empty_query" };
  }

  const watchlists = [];
  for (const [watchlistName, w] of Object.entries(baseline.watchlists || {})) {
    const symbols = Array.isArray(w?.symbols) ? w.symbols : [];
    const match = symbols.find((s) => normalizeTicker(s) === ticker);
    if (match) {
      watchlists.push({
        watchlistName,
        timeframe: w.timeframe || null,
        matchedSymbol: match,
        symbolCount: symbols.length,
        updatedAt: w.updated_at || null,
      });
    }
  }

  const matchingOpenTrades = openTrades.filter((t) => normalizeTicker(t.symbol) === ticker);

  const edge = buildEdgeAnalysis({ openBySymbolTf, minTrades: 1, ruleType });
  const perTimeframeStats = edge.available
    ? edge.symbols.filter((s) => normalizeTicker(s.ticker) === ticker)
    : [];

  const allClosed = readAllTradeLogs({ ruleType }).filter((r) => normalizeTicker(r.ticker) === ticker);
  allClosed.sort((a, b) => (b.exit_time_ms || 0) - (a.exit_time_ms || 0));
  // Webhook status is only computed for the slice actually returned, not the full history —
  // no need to touch the ledger for rows that will never be displayed.
  const sentState = readSentState();
  const closedTrades = allClosed.slice(0, closedTradeLimit).map((row) => ({ ...row, ...webhookStatusForRow(row, sentState) }));

  return {
    available: true,
    query,
    ticker,
    ruleType: edge.ruleType ?? ruleType,
    ruleTypes: edge.available ? edge.ruleTypes : listRuleTypes(),
    watchlists,
    openTrades: matchingOpenTrades,
    perTimeframeStats,
    closedTrades,
    closedTradeCount: allClosed.length,
    isTruncated: allClosed.length > closedTradeLimit,
  };
}
