import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardStatus } from '../src/core/morning.js';

describe('dashboard status payload', () => {
  it('surfaces TradingView connection errors for the top page banner', () => {
    const result = createDashboardStatus({
      generated_at: '2026-04-17T16:10:00.000Z',
      formatted_timestamp_et: '04/17/2026, 12:10:00 PM',
      connection_error: true,
      error_message: 'TradingView connection unavailable. CDP connection failed.',
      summary_line: 'TradingView connection unavailable. CDP connection failed.',
      watchlist_summary_lines: ['TradingView connection unavailable. CDP connection failed.'],
      prior_signals_by_watchlist: [],
    });

    assert.equal(result.connectionError, true);
    assert.match(result.errorMessage, /TradingView connection unavailable/);
    assert.equal(result.lines[0], 'TradingView connection unavailable. CDP connection failed.');
  });

  it('includes one summary line per watchlist for the latest output section', () => {
    const result = createDashboardStatus({
      generated_at: '2026-04-15T16:00:00.000Z',
      formatted_timestamp_et: '04/15/2026, 12:00:00 PM',
      scan_mode: 'signals_only',
      signals_found: 0,
      changed_signals: 0,
      signal_lines: [],
      watchlist_summary_lines: [
        '04/15/2026, 12:00:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 8.1s | NO SIGNAL',
        '04/15/2026, 12:00:00 PM ET | WATCHLIST: Swing 1H | SYMBOLS: 5 | SCAN: 7.4s | SIGNAL: OPEN | SOXL | LONG',
      ],
      summary_line: '04/15/2026, 12:00:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 8.1s | NO SIGNAL',
      symbols_scanned: [],
    });

    assert.equal(result.hasSignals, false);
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].includes('NO SIGNAL'), true);
    assert.equal(result.lines[1].includes('SIGNAL: OPEN'), true);
    assert.equal(typeof result.nextScheduledRunEt, 'string');
    assert.deepEqual(result.scanResults, []);
  });

  it('exposes watchlist sync diagnostics for the dashboard', () => {
    const result = createDashboardStatus({
      generated_at: '2026-04-15T16:02:00.000Z',
      formatted_timestamp_et: '04/15/2026, 12:02:00 PM',
      scan_mode: 'signals_only',
      signals_found: 0,
      changed_signals: 0,
      signal_lines: [],
      watchlist_summary_lines: ['04/15/2026, 12:02:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | NO SIGNAL'],
      summary_line: '04/15/2026, 12:02:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | NO SIGNAL',
      watchlist_sync: [
        { watchlistName: 'Swing 15m', symbols: [], source: 'watchlist_unavailable', activeWatchlistName: 'Swing 15m', selectError: 'Could not select watchlist' }
      ],
      symbols_scanned: [],
    });

    assert.ok(Array.isArray(result.watchlistSync));
    assert.equal(result.watchlistSync[0].watchlistName, 'Swing 15m');
    assert.equal(result.watchlistSync[0].selectError, 'Could not select watchlist');
  });

  it('passes through open trades and preserves watchlist row counts for previous signals', () => {
    const result = createDashboardStatus({
      generated_at: '2026-04-15T16:01:00.000Z',
      formatted_timestamp_et: '04/15/2026, 12:01:00 PM',
      scan_mode: 'signals_only',
      signals_found: 1,
      changed_signals: 1,
      signal_lines: ['04/15/2026, 12:01:00 PM ET | WATCHLIST: Swing 15m | SOXL | SIGNAL: LONG | TF: 15 | PRICE: 82.33'],
      watchlist_summary_lines: ['04/15/2026, 12:01:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | SIGNAL: OPEN | SOXL | LONG | PRICE: 82.33'],
      summary_line: '04/15/2026, 12:01:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | SIGNAL: OPEN | SOXL | LONG | PRICE: 82.33',
      open_trades: [
        {
          watchlistName: 'Swing 15m',
          timeframe: '15',
          symbol: 'SOXL',
          signal: 'OPEN',
          entryPrice: 82.33,
          entryTime: '04/15/2026, 12:01:00 PM ET',
          netPnl: '12.00 USD',
          favorableExcursion: '28.00 USD',
          adverseExcursion: '-4.00 USD',
        },
      ],
      prior_signals_by_watchlist: [
        {
          watchlistName: 'Swing 15m',
          timeframe: '15',
          symbolCount: 2,
          trades: [
            {
              symbol: 'SOXL',
              signal: 'OPEN',
              entryPrice: 82.33,
              entryTime: '04/15/2026, 12:01:00 PM ET',
              netPnl: '12.00 USD',
              favorableExcursion: '28.00 USD',
              adverseExcursion: '-4.00 USD',
            },
            {
              symbol: 'TQQQ',
              signal: '—',
              entryPrice: 'Unavailable',
              entryTime: 'No prior trade recorded',
              netPnl: 'Unavailable',
              favorableExcursion: 'Unavailable',
              adverseExcursion: 'Unavailable',
            },
          ],
        },
      ],
      symbols_scanned: [],
    });

    assert.equal(result.hasSignals, true);
    assert.equal(result.lines.length, 1);
    assert.equal(result.openTrades.length, 1);
    assert.equal(result.openTrades[0].symbol, 'SOXL');
    assert.equal(result.priorSignals.length, 1);
    assert.equal(result.priorSignals[0].watchlistName, 'Swing 15m');
    assert.equal(result.priorSignals[0].trades.length, 2);
    assert.equal(result.priorSignals[0].trades[0].signal, 'OPEN');
    assert.match(result.priorSignals[0].trades[0].entryTime, /2026/);
    assert.equal(result.priorSignals[0].trades[0].entryPrice, 82.33);
    assert.equal(result.priorSignals[0].trades[1].entryPrice, 'Unavailable');
    assert.equal(result.priorSignals[0].trades[1].entryTime, 'No prior trade recorded');
  });

  it('shows changed signal lines when no current open signals are present in watchlist summaries', () => {
    const result = createDashboardStatus({
      generated_at: '2026-04-15T16:05:00.000Z',
      formatted_timestamp_et: '04/15/2026, 12:05:00 PM',
      scan_mode: 'changed_signals_only',
      signals_found: 1,
      changed_signals: 1,
      signal_lines: ['04/15/2026, 12:05:00 PM ET | WATCHLIST: Swing 15m | SOXL | SIGNAL: EXIT | TF: 15 | PRICE: 82.33'],
      watchlist_summary_lines: ['04/15/2026, 12:05:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | NO SIGNAL'],
      summary_line: '04/15/2026, 12:05:00 PM ET | WATCHLIST: Swing 15m | SYMBOLS: 8 | SCAN: 6.2s | NO SIGNAL',
      symbols_scanned: [],
    });

    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0], '04/15/2026, 12:05:00 PM ET | WATCHLIST: Swing 15m | SOXL | SIGNAL: EXIT | TF: 15 | PRICE: 82.33');
  });
});

/**
 * Regression guard for the Edge/Org/New columns blanking on a skipped tick (2026-08-06).
 *
 * runBrief() ranked its open trades; the five skip/error paths did not. Because writeLatestStatus()
 * replaces the WHOLE status file on every path, a skipped tick — which fires far more often than a
 * real 15-minute scan — overwrote the ranked rows with unranked ones, blanking the columns and the
 * NEW badge on positions that had not changed at all.
 *
 * These assert the INVARIANT rather than any particular score: every status write emits open trades
 * carrying the ranking fields. Scores depend on the live trade log and must not be asserted here, or
 * the test would fail whenever real trading data moves. The fields being PRESENT is the contract —
 * their absence is precisely what the bug looked like on screen.
 */
describe('open-trade ranking is applied at the status-write chokepoint', () => {
  const ranked = (extra = {}) => createDashboardStatus({
    generated_at: '2026-08-06T16:05:00.000Z',
    market_hours: { timezone: 'America/New_York', open: '09:30', close: '16:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
    open_trades: [
      { symbol: 'BATS:ABNB', timeframe: '15', signal: 'OPEN', entryTimeRaw: '2026-08-06T14:30:00.000Z' },
      { symbol: 'BATS:SOXL', timeframe: '15', signal: 'OPEN', entryTimeRaw: '2026-08-03T14:30:00.000Z' },
    ],
    ...extra,
  }).openTrades;

  it('attaches the ranking fields on a normal scan write', () => {
    for (const row of ranked()) {
      assert.ok('edge' in row, `${row.symbol} lost its edge field`);
      assert.ok('isNewEntry' in row, `${row.symbol} lost its isNewEntry flag`);
      assert.ok('edgeRankNew' in row, `${row.symbol} lost its new-rank`);
      assert.ok('edgeRankOrg' in row, `${row.symbol} lost its org-rank`);
    }
  });

  // The actual bug: a status file written by a path where no scan ran at all.
  it('attaches them on a SKIPPED write too, not only when a scan ran', () => {
    for (const reason of ['Outside market hours', 'Scheduled scanning disabled', 'No watchlists are due for scan at this minute']) {
      for (const row of ranked({ skipped: true, reason })) {
        assert.ok('isNewEntry' in row, `${reason}: ${row.symbol} lost its isNewEntry flag`);
        assert.ok('edgeRankNew' in row, `${reason}: ${row.symbol} lost its new-rank`);
      }
    }
  });

  it('attaches them on a connection-error write', () => {
    for (const row of ranked({ skipped: true, connection_error: true, error_message: 'CDP connection failed.' })) {
      assert.ok('isNewEntry' in row, `${row.symbol} lost its isNewEntry flag`);
      assert.ok('edgeRankNew' in row, `${row.symbol} lost its new-rank`);
    }
  });

  // Drives the "NEW" badge under the symbol. Judged on the ET trading day, so 10:30 ET and the
  // 12:05 ET scan that observed it are the same day, while the 08-03 entry is not.
  it('flags only today\'s entries as new', () => {
    const rows = ranked();
    assert.equal(rows.find((r) => r.symbol === 'BATS:ABNB').isNewEntry, true);
    assert.equal(rows.find((r) => r.symbol === 'BATS:SOXL').isNewEntry, false);
  });

  // A new arrival was not in the pre-scan book, so it has no "org" standing to report. The dashboard
  // renders that as "new"; conflating it with a genuine null would mislabel the column.
  it('gives a new arrival no org rank, but a held position both ranks', () => {
    const rows = ranked();
    assert.equal(rows.find((r) => r.symbol === 'BATS:ABNB').edgeRankOrg, null);
    assert.ok(Number.isFinite(rows.find((r) => r.symbol === 'BATS:SOXL').edgeRankOrg));
    assert.ok(rows.every((r) => Number.isFinite(r.edgeRankNew)));
  });

  it('survives a status write with no open trades', () => {
    assert.deepEqual(createDashboardStatus({ generated_at: '2026-08-06T16:05:00.000Z' }).openTrades, []);
  });
});
