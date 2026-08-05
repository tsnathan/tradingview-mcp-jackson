import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBookRows,
  filterBookRows,
  computeKpis,
  buildPortfolioAnalytics,
  EXECUTOR_ACCOUNT,
} from '../src/core/portfolio_analytics.js';

const DAY = 86400000;
const T = (iso) => new Date(iso).getTime();

function manual(o = {}) {
  return {
    id: o.id ?? 1,
    account: o.account ?? 'Fidelity IRA',
    symbol: o.symbol ?? 'AAPL',
    timeframe: o.timeframe ?? '45',
    side: o.side ?? 'LONG',
    qty: o.qty ?? 10,
    entry_price: o.entry_price ?? 100,
    exit_price: o.exit_price ?? null,
    entered_at: o.entered_at ?? '2026-08-01T14:00:00.000Z',
    closed_at: o.closed_at ?? null,
    status: o.status ?? 'open',
  };
}

function webhook(o = {}) {
  return [o.key ?? 'AAPL|45m|2026-08-01T14:00:00.000Z', {
    symbol: o.symbol ?? 'AAPL',
    tag: o.tag ?? '45m',
    side: o.side ?? 'buy',
    price: o.price ?? 100,
    at: o.at ?? '2026-08-01T14:00:00.000Z',
    ...(o.exit ? { exit: o.exit } : {}),
  }];
}

function build(manualRows = [], sentPairs = []) {
  return normalizeBookRows({
    manualRows,
    webhookSent: Object.fromEntries(sentPairs),
    webhookArchive: [],
  });
}

describe('normalizeBookRows', () => {
  it('unifies the two ledgers onto one timeframe vocabulary', () => {
    // Manual stores a raw resolution, webhook stores a tag — they must group as ONE timeframe.
    const rows = build([manual({ timeframe: '45' })], [webhook({ tag: '45m' })]);
    assert.deepEqual(rows.map((r) => r.timeframe), ['45m', '45m']);

    const daily = build([manual({ timeframe: 'D' })], [webhook({ tag: '1d' })]);
    assert.deepEqual(daily.map((r) => r.timeframe), ['1d', '1d']);
  });

  it('never derives a dollar P&L for a webhook row, which has no quantity', () => {
    const rows = build([], [webhook({ exit: { price: 110, at: '2026-08-05T14:00:00.000Z' } })]);
    assert.equal(rows[0].qty, null);
    assert.equal(rows[0].pnlUsd, null);
    assert.equal(rows[0].pnlPct, 10); // percent still works
    assert.equal(rows[0].account, EXECUTOR_ACCOUNT);
  });

  it('computes manual dollar P&L from quantity', () => {
    const rows = build([manual({ status: 'closed', exit_price: 110, qty: 10, closed_at: '2026-08-05T14:00:00.000Z' })]);
    assert.equal(rows[0].pnlPct, 10);
    assert.equal(Math.round(rows[0].pnlUsd), 100); // 10% of 100 x 10 shares
  });

  it('flips the sign for a SHORT so a falling price is a gain', () => {
    const short = build([manual({ status: 'closed', side: 'SHORT', entry_price: 100, exit_price: 90, closed_at: '2026-08-05T14:00:00.000Z' })]);
    assert.equal(short[0].pnlPct, 10);
    assert.equal(Math.round(short[0].pnlUsd), 100);

    const long = build([manual({ status: 'closed', side: 'LONG', entry_price: 100, exit_price: 90, closed_at: '2026-08-05T14:00:00.000Z' })]);
    assert.equal(long[0].pnlPct, -10);
  });

  it('reads a webhook sell as SHORT', () => {
    const rows = build([], [webhook({ side: 'sell', exit: { price: 90, at: '2026-08-05T14:00:00.000Z' } })]);
    assert.equal(rows[0].side, 'SHORT');
    assert.equal(rows[0].pnlPct, 10);
  });

  it('leaves an open position unscored', () => {
    const rows = build([manual({ status: 'open' })], [webhook()]);
    assert.deepEqual(rows.map((r) => r.status), ['open', 'open']);
    assert.deepEqual(rows.map((r) => r.pnlPct), [null, null]);
  });
});

describe('computeKpis', () => {
  const closed = (pct, extra = {}) => manual({
    id: Math.random(), status: 'closed', entry_price: 100,
    exit_price: 100 * (1 + pct / 100), closed_at: '2026-08-05T14:00:00.000Z', ...extra,
  });
  // Exit prices are derived arithmetically in these fixtures, so they carry float noise
  // (100 * 1.1 !== 110 exactly). Compare to a tolerance rather than loosening the production code.
  const near = (actual, expected, msg) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} !~= ${expected}`);

  it('computes the percent-based metrics', () => {
    const rows = build([closed(10), closed(20), closed(-5), closed(-5)]);
    const k = computeKpis(rows);
    assert.equal(k.closedCount, 4);
    assert.equal(k.scoredCount, 4);
    assert.equal(k.winRatePct, 50);
    near(k.expectancyPct, 5, 'expectancy');   // (10+20-5-5)/4
    near(k.profitFactor, 3, 'profit factor'); // 30 / 10
    near(k.avgWinPct, 15, 'avg win');
    near(k.avgLossPct, -5, 'avg loss');
  });

  it('counts a closed row with no exit price but excludes it from P&L', () => {
    // The load-bearing case: dropping it silently would shrink the denominator and flatter every
    // metric; scoring it as 0 would invent a break-even trade that never happened.
    const rows = build([], [webhook({ key: 'A|45m|x', exit: { at: '2026-08-05T14:00:00.000Z' } })]);
    const k = computeKpis(rows);
    assert.equal(k.closedCount, 1);
    assert.equal(k.scoredCount, 0);
    assert.equal(k.excludedNoExit, 1);
    assert.equal(k.expectancyPct, null);
    assert.equal(k.winRatePct, null);
  });

  it('keeps the USD denominator separate from the percent one', () => {
    const rows = build(
      [closed(10)],                                                    // has qty -> USD
      [webhook({ exit: { price: 120, at: '2026-08-05T14:00:00.000Z' } })], // no qty -> percent only
    );
    const k = computeKpis(rows);
    assert.equal(k.scoredCount, 2);  // both score on percent
    assert.equal(k.usdCount, 1);     // only one has dollars
    assert.equal(Math.round(k.realizedUsd), 100);
  });

  it('reports profitFactor as null when there are no losses rather than Infinity', () => {
    const k = computeKpis(build([closed(10), closed(5)]));
    assert.equal(k.profitFactor, null);
    assert.equal(k.avgLossPct, null);
  });

  it('reports both mean and median hold', () => {
    const rows = build([
      manual({ id: 1, status: 'closed', exit_price: 110, entered_at: '2026-08-01T00:00:00.000Z', closed_at: '2026-08-03T00:00:00.000Z' }),
      manual({ id: 2, status: 'closed', exit_price: 110, entered_at: '2026-08-01T00:00:00.000Z', closed_at: '2026-08-05T00:00:00.000Z' }),
      manual({ id: 3, status: 'closed', exit_price: 110, entered_at: '2026-08-01T00:00:00.000Z', closed_at: '2026-08-31T00:00:00.000Z' }),
    ]);
    const k = computeKpis(rows);
    assert.equal(k.medianHoldDays, 4);
    assert.ok(k.avgHoldDays > k.medianHoldDays); // right-skewed, which is why both are reported
  });

  it('separates open exposure by source and never scores it', () => {
    const k = computeKpis(build([manual({ status: 'open' })], [webhook()]));
    assert.equal(k.openCount, 2);
    assert.deepEqual(k.openBySource, { manual: 1, webhook: 1 });
    assert.equal(k.closedCount, 0);
    assert.equal(k.realizedUsd, null);
  });

  it('handles an empty book without dividing by zero', () => {
    const k = computeKpis([]);
    assert.equal(k.closedCount, 0);
    assert.equal(k.winRatePct, null);
    assert.equal(k.expectancyPct, null);
    assert.equal(k.profitFactor, null);
    assert.equal(k.realizedUsd, null);
    assert.equal(k.avgHoldDays, null);
  });
});

describe('filterBookRows', () => {
  const rows = build([
    manual({ id: 1, symbol: 'AAPL', timeframe: '45', account: 'Fidelity IRA', entered_at: '2026-08-04T14:00:00.000Z' }),
    manual({ id: 2, symbol: 'TSLA', timeframe: '240', account: 'Schwab', status: 'closed', exit_price: 110,
             entered_at: '2026-06-10T14:00:00.000Z', closed_at: '2026-08-04T15:00:00.000Z' }),
    manual({ id: 3, symbol: 'MSFT', timeframe: '45', account: 'Fidelity IRA', entered_at: '2026-01-05T14:00:00.000Z' }),
  ]);

  it('matches on EITHER end of the window', () => {
    // TSLA opened in June and closed in August — an August window must still include it.
    const aug = filterBookRows(rows, { from: T('2026-08-01T00:00:00Z'), to: T('2026-09-01T00:00:00Z') });
    assert.deepEqual(aug.map((r) => r.symbol).sort(), ['AAPL', 'TSLA']);
  });

  it('filters by timeframe using the normalized tag', () => {
    assert.deepEqual(filterBookRows(rows, { timeframe: '240' }).map((r) => r.symbol), ['TSLA']);
    assert.deepEqual(filterBookRows(rows, { timeframe: '4h' }).map((r) => r.symbol), ['TSLA']);
  });

  it('filters by account and symbol substring', () => {
    assert.equal(filterBookRows(rows, { account: 'Fidelity IRA' }).length, 2);
    assert.deepEqual(filterBookRows(rows, { symbol: 'sl' }).map((r) => r.symbol), ['TSLA']);
  });

  it('returns everything when no window is given', () => {
    assert.equal(filterBookRows(rows, {}).length, 3);
  });
});

describe('buildPortfolioAnalytics', () => {
  it('builds facets from the UNFILTERED set so one filter cannot empty another', () => {
    const out = buildPortfolioAnalytics({
      manualRows: [
        manual({ id: 1, symbol: 'AAPL', timeframe: '45', account: 'Fidelity IRA' }),
        manual({ id: 2, symbol: 'TSLA', timeframe: '240', account: 'Schwab' }),
      ],
      webhookSent: {}, webhookArchive: [],
      timeframe: '45',
    });
    assert.equal(out.rows.length, 1);
    assert.deepEqual(out.facets.timeframes, ['45m', '4h']);
    assert.deepEqual(out.facets.accounts, ['Fidelity IRA', 'Schwab']);
    assert.equal(out.totalRowsBeforeFilter, 2);
  });

  it('orders breakdowns by activity, not by expectancy', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push(manual({ id: i, symbol: 'AAPL', timeframe: '45', status: 'closed', exit_price: 101, closed_at: '2026-08-05T14:00:00.000Z' }));
    }
    rows.push(manual({ id: 99, symbol: 'TSLA', timeframe: '240', status: 'closed', exit_price: 200, closed_at: '2026-08-05T14:00:00.000Z' }));
    const out = buildPortfolioAnalytics({ manualRows: rows, webhookSent: {}, webhookArchive: [] });
    // 4h has by far the better expectancy but only one trade — 45m must still lead.
    assert.equal(out.byTimeframe[0].key, '45m');
    assert.equal(out.byTimeframe[0].closedCount, 5);
  });
});
