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
