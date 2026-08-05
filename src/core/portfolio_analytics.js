/**
 * Portfolio analytics over the REAL book — positions actually held, as opposed to what the strategy
 * backtested.
 *
 * This is deliberately a different question from the one Edge Analysis / Portfolio Sim / Sweet Spot
 * answer. Those all read `trade-log/*.csv`, which is the Swing Profile strategy's own backtest
 * output: every signal it would have taken, at its prices, regardless of whether a single share was
 * ever bought. This module reads the two records of what was actually done — the manual ledger
 * (positions held in outside brokerage accounts) and the webhook ledger (orders sent to the
 * executor) — and never mixes the two families of number.
 *
 * ## The data constraint, and why the KPIs are shaped around it
 *
 * The two sources do not carry the same fields, and pretending otherwise would produce a confident
 * wrong answer:
 *
 *   | | manual ledger | webhook ledger |
 *   |---|---|---|
 *   | entry price | always | always |
 *   | exit price  | on close | only when a close recorded one — often null |
 *   | quantity    | always | NEVER (the executor sizes each account itself) |
 *   | side        | always (defaults LONG) | always |
 *
 * Two consequences drive everything below:
 *
 * 1. **Percent is the common currency; dollars are manual-only.** Without quantity a webhook row
 *    has no dollar P&L at all. So win rate / expectancy / profit factor are computed on PERCENT
 *    return, which both sources can produce, and realized USD is reported separately with its own
 *    count so its denominator is never confused with the percent one.
 * 2. **A closed row with no exit price is excluded from P&L but still counted, and the exclusion is
 *    reported.** Dropping it silently would shrink the denominator and quietly flatter every
 *    metric; treating a missing exit as break-even would invent a trade that never resolved.
 *    `excludedNoExit` exists so the caller can always state what was left out.
 *
 * Open positions never contribute to realized P&L — there is no exit to measure. They are reported
 * as exposure only.
 */

import { listManualPositions } from './manual_ledger.js';
import { readSentState, readSentArchive, timeframeTag } from './trade_webhook.js';

/** Account label for webhook rows. They are placed at the executor, which spreads them across the
 *  configured broker accounts — there is no single account to attribute one to. */
export const EXECUTOR_ACCOUNT = 'Executor (webhook)';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ms(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Percent return of a position, signed by direction. A SHORT that falls in price is a gain, so the
 * sign flips — without this a short book reads as an exactly inverted disaster.
 */
function signedPct(entry, exit, side) {
  if (!(entry > 0) || exit == null) return null;
  const raw = ((exit - entry) / entry) * 100;
  return String(side || '').toUpperCase() === 'SHORT' ? -raw : raw;
}

/**
 * Both ledgers reduced to one row shape.
 *
 * Timeframes are normalized through `timeframeTag()`, which is idempotent over its own output
 * ("1h" -> "1h") — so the manual ledger's raw resolutions ("45", "240", "D") and the webhook
 * ledger's tags ("45m", "4h", "1d") land on the same vocabulary and can actually be grouped
 * together. Without it the same timeframe would appear as two separate rows in every breakdown.
 */
export function normalizeBookRows({ manualRows = null, webhookSent = null, webhookArchive = null } = {}) {
  const out = [];

  const manual = manualRows ?? listManualPositions({ status: 'all' });
  for (const r of manual) {
    const entry = num(r.entry_price);
    const exit = num(r.exit_price);
    const qty = num(r.qty);
    const pnlPct = r.status === 'closed' ? signedPct(entry, exit, r.side) : null;
    out.push({
      source: 'manual',
      id: `manual:${r.id}`,
      symbol: r.symbol || null,
      timeframe: r.timeframe ? timeframeTag(r.timeframe) : null,
      account: r.account || null,
      side: String(r.side || 'LONG').toUpperCase(),
      qty,
      entryPrice: entry,
      exitPrice: exit,
      entryMs: ms(r.entered_at),
      exitMs: ms(r.closed_at),
      status: r.status === 'closed' ? 'closed' : 'open',
      pnlPct,
      // Dollars need quantity, which only this source has.
      pnlUsd: pnlPct != null && qty != null && entry != null ? (pnlPct / 100) * entry * qty : null,
    });
  }

  const sent = webhookSent ?? (readSentState().sent || {});
  const archive = webhookArchive ?? readSentArchive().rows ?? [];
  const archived = archive.filter((r) => r && r.key && !(r.key in sent)).map((r) => [r.key, r]);
  for (const [key, rec] of [...Object.entries(sent), ...archived]) {
    const parts = String(key).split('|');
    const entry = num(rec?.price);
    const exit = num(rec?.exit?.price);
    const closed = Boolean(rec?.exit);
    const side = String(rec?.side || '').toLowerCase() === 'sell' ? 'SHORT' : 'LONG';
    out.push({
      source: 'webhook',
      id: `webhook:${key}`,
      symbol: rec?.symbol || parts[0] || null,
      timeframe: (rec?.tag || parts[1]) ? timeframeTag(rec?.tag || parts[1]) : null,
      account: EXECUTOR_ACCOUNT,
      side,
      qty: null, // the executor sizes per account; never recorded here
      entryPrice: entry,
      exitPrice: exit,
      entryMs: ms(rec?.at || parts[2]),
      exitMs: ms(rec?.exit?.at),
      status: closed ? 'closed' : 'open',
      pnlPct: closed ? signedPct(entry, exit, side) : null,
      pnlUsd: null,
    });
  }

  return out;
}

/**
 * Filter by an ET-bounded window plus the usual facets.
 *
 * `from`/`to` are epoch ms computed by the caller (the dashboard derives them from ET wall-clock
 * boundaries, so they don't move when the user travels). A row matches if EITHER its entry or its
 * exit falls inside — a position opened last month and closed this morning is part of this month's
 * activity, and filtering on the entry alone would hide the close you came looking for.
 */
export function filterBookRows(rows, { from = null, to = null, timeframe = null, account = null, symbol = null } = {}) {
  const wantTf = timeframe ? timeframeTag(timeframe) : null;
  const wantSym = symbol ? String(symbol).trim().toUpperCase() : null;
  return rows.filter((r) => {
    if (wantTf && r.timeframe !== wantTf) return false;
    if (account && r.account !== account) return false;
    if (wantSym && !String(r.symbol || '').toUpperCase().includes(wantSym)) return false;
    if (from == null && to == null) return true;
    const stamps = [r.entryMs, r.exitMs].filter((t) => t != null);
    if (!stamps.length) return false;
    return stamps.some((t) => (from == null || t >= from) && (to == null || t < to));
  });
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * KPIs over already-filtered rows. Pure.
 *
 * Every metric here is on PERCENT return except `realizedUsd`, for the reason in the header: a
 * webhook row has no quantity, so it has no dollar P&L. `usdCount` is carried alongside so the two
 * denominators can never be read as one.
 */
export function computeKpis(rows) {
  const closed = rows.filter((r) => r.status === 'closed');
  const scored = closed.filter((r) => r.pnlPct != null);
  const excludedNoExit = closed.length - scored.length;
  const open = rows.filter((r) => r.status === 'open');

  const pcts = scored.map((r) => r.pnlPct);
  const wins = pcts.filter((p) => p > 0);
  const losses = pcts.filter((p) => p < 0);
  const grossGain = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const usdRows = scored.filter((r) => r.pnlUsd != null);
  const holds = scored
    .filter((r) => r.entryMs != null && r.exitMs != null && r.exitMs >= r.entryMs)
    .map((r) => (r.exitMs - r.entryMs) / 86400000);

  return {
    closedCount: closed.length,
    scoredCount: scored.length,
    // Closed, but no exit price was ever recorded — counted as activity, never as a P&L of zero.
    excludedNoExit,
    openCount: open.length,
    openBySource: {
      manual: open.filter((r) => r.source === 'manual').length,
      webhook: open.filter((r) => r.source === 'webhook').length,
    },
    winRatePct: scored.length ? (wins.length / scored.length) * 100 : null,
    expectancyPct: scored.length ? pcts.reduce((a, b) => a + b, 0) / scored.length : null,
    // Infinite profit factor is a real state (no losers yet), not an error — reported as null so a
    // caller renders it as "no losses" rather than "∞" or, worse, 0.
    profitFactor: grossLoss > 0 ? grossGain / grossLoss : null,
    avgWinPct: wins.length ? grossGain / wins.length : null,
    avgLossPct: losses.length ? -grossLoss / losses.length : null,
    totalReturnPct: pcts.reduce((a, b) => a + b, 0) || 0,
    realizedUsd: usdRows.length ? usdRows.reduce((a, r) => a + r.pnlUsd, 0) : null,
    usdCount: usdRows.length,
    // Mean and median together — hold-period distributions here are right-skewed enough that the
    // mean alone misleads, the same reason edge_analysis.js reports both.
    avgHoldDays: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    medianHoldDays: median(holds),
  };
}

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r) || '—';
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return [...out.entries()]
    .map(([key, group]) => ({ key, ...computeKpis(group) }))
    // Most-traded first: a breakdown row built from two positions should not outrank one built
    // from forty just because its expectancy happens to be higher.
    .sort((a, b) => b.closedCount - a.closedCount || b.openCount - a.openCount);
}

export function buildPortfolioAnalytics(opts = {}) {
  const all = normalizeBookRows(opts);
  const rows = filterBookRows(all, opts);
  return {
    filters: {
      from: opts.from ?? null,
      to: opts.to ?? null,
      timeframe: opts.timeframe ?? null,
      account: opts.account ?? null,
      symbol: opts.symbol ?? null,
    },
    totalRowsBeforeFilter: all.length,
    kpis: computeKpis(rows),
    byTimeframe: groupBy(rows, (r) => r.timeframe),
    byAccount: groupBy(rows, (r) => r.account),
    bySymbol: groupBy(rows, (r) => r.symbol),
    bySource: groupBy(rows, (r) => r.source),
    // Vocabularies for the tab's filter controls, taken from the UNFILTERED set so selecting one
    // facet can never empty the options of another.
    facets: {
      timeframes: [...new Set(all.map((r) => r.timeframe).filter(Boolean))].sort(),
      accounts: [...new Set(all.map((r) => r.account).filter(Boolean))].sort(),
      symbols: [...new Set(all.map((r) => r.symbol).filter(Boolean))].sort(),
    },
    rows,
  };
}
