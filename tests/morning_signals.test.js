import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLatestTradeFromTesterText } from '../src/core/data.js';
import {
  buildPriorSignalsByWatchlist,
  buildScanTargets,
  detectSignalFromSnapshot,
  formatPriorSignalForWatchlist,
  shouldRunEquityScanNow,
} from '../src/core/morning.js';

describe('signal detection', () => {
  it('finds bullish signal from Pine labels', () => {
    const result = detectSignalFromSnapshot({
      symbol: 'SOXL',
      timeframe: '30',
      labels: {
        studies: [
          {
            name: 'Swing Profile Strategy [BigBeluga]',
            labels: [
              { text: 'Noise', price: 80 },
              { text: 'Long ▲', price: 82.5 },
            ],
          },
        ],
      },
      tables: { studies: [] },
      indicators: { studies: [] },
    });

    assert.equal(result.hasSignal, true);
    assert.equal(result.direction, 'bullish');
    assert.equal(result.price, 82.5);
  });

  it('returns no signal when signal text is absent', () => {
    const result = detectSignalFromSnapshot({
      symbol: 'SOXL',
      timeframe: '30',
      labels: { studies: [] },
      tables: { studies: [] },
      indicators: { studies: [] },
    });

    assert.equal(result.hasSignal, false);
    assert.equal(result.direction, null);
  });
});

describe('trade table parsing', () => {
  it('extracts the latest EDC 1H trade row fields from Strategy Tester text', () => {
    const text = `Trade #
1Long
Exit
Entry
Jun 16, 2025, 09:00
Jun 16, 2025, 09:00
Margin call
Swing Low
37.02
USD
37.02
USD
1
37.02USD
−0.074
USD
−0.20%
0
USD
0.00%
−0.037
USD
−0.10%
−10.032
USD
−0.10%
9Long
Exit
Entry
Feb 02, 2026, 04:00
Jan 30, 2026, 13:00
Trail Long
Swing Low
65.52
USD
66.95
USD
143
9.57 KUSD
−223.433
USD
−2.33%
212.076
USD
2.21%
−214.064
USD
−2.23%
−448.147
USD
−4.48%`;
    const trade = parseLatestTradeFromTesterText(text);

    assert.equal(trade.signal, 'EXIT');
    assert.equal(trade.entryTime, 'Jan 30, 2026, 13:00');
    assert.equal(trade.entryPrice, '66.95 USD');
    assert.equal(trade.netPnl, '-223.433 USD | -2.33%');
    assert.equal(trade.favorableExcursion, '212.076 USD | 2.21%');
    assert.equal(trade.adverseExcursion, '-214.064 USD | -2.23%');
  });

  it('detects an OPEN trade when only entry data is present', () => {
    const text = `Trade #
10Long
Exit
Entry
Apr 17, 2026, 06:45
Trail Long
80.45
USD
159
12.79 KUSD
0
USD
0.00%
0
USD
0.00%`;
    const trade = parseLatestTradeFromTesterText(text);

    assert.equal(trade.signal, 'OPEN');
    assert.equal(trade.entryTime, 'Apr 17, 2026, 06:45');
    assert.equal(trade.entryPrice, '80.45 USD');
  });
});

describe('scan target building', () => {
  it('includes all configured watchlists', () => {
    const targets = buildScanTargets({
      watchlist: ['SOXL', 'BTCUSD'],
      default_timeframe: '30',
      watchlists: {
        'Swing 15m': { timeframe: '15', symbols: ['SOXL', 'BTCUSD'] },
        'Swing 30min': { timeframe: '30', symbols: ['SOXL'] },
        'Swing 1H': '60',
        'Swing 4H': '240',
        'Swing 1D': 'D',
      },
    });

    assert.equal(targets.length, 5);
    assert.deepEqual(targets.map((t) => t.watchlistName), ['Swing 15m', 'Swing 30min', 'Swing 1H', 'Swing 4H', 'Swing 1D']);
    assert.equal(targets[0].symbols.length, 2);
    assert.equal(targets[1].symbols.length, 1);
    assert.equal(targets[2].symbols.length, 2);
  });
});

describe('prior signal formatting', () => {
  it('returns a prior signal section when a watchlist has no current signal', () => {
    const text = formatPriorSignalForWatchlist(
      {
        watchlist_name: 'Swing 30min',
        timeframe: '30',
        symbols: ['SOXL', 'TQQQ'],
      },
      {
        'SOXL:30': {
          symbol: 'SOXL',
          timeframe: '30',
          last_signal: '▲',
          last_price: 82.5,
          last_seen_at: '2026-04-15T13:45:00.000Z',
        },
      },
      'America/New_York',
    );

    assert.match(text, /Prior Signal:/);
    assert.match(text, /SOXL/);
    assert.match(text, /LONG/);
  });
});

describe('prior signals by watchlist', () => {
  it('sorts OPEN rows first and then by newest entry time', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        { watchlist_name: 'Swing 1D', timeframe: 'D', symbols: ['BATS:BBB', 'BATS:AAA', 'BATS:CCC'], source: 'tradingview_panel' },
      ],
      [
        {
          symbol: 'BATS:AAA',
          timeframe: 'D',
          watchlist_name: 'Swing 1D',
          trade: {
            signal: 'EXIT',
            entryPrice: '100 USD',
            entryTime: 'Jan 01, 2026, 10:00',
            netPnl: '5 USD | 1%',
            favorableExcursion: '8 USD | 2%',
            adverseExcursion: '-2 USD | -0.5%',
          },
        },
        {
          symbol: 'BATS:BBB',
          timeframe: 'D',
          watchlist_name: 'Swing 1D',
          trade: {
            signal: 'OPEN',
            entryPrice: '90 USD',
            entryTime: 'Jan 02, 2026, 10:00',
            netPnl: '—',
            favorableExcursion: '—',
            adverseExcursion: '—',
          },
        },
        {
          symbol: 'BATS:CCC',
          timeframe: 'D',
          watchlist_name: 'Swing 1D',
          trade: {
            signal: 'EXIT',
            entryPrice: '110 USD',
            entryTime: 'Jan 03, 2026, 10:00',
            netPnl: '6 USD | 1.2%',
            favorableExcursion: '9 USD | 2.2%',
            adverseExcursion: '-1 USD | -0.2%',
          },
        },
      ],
      {},
      'America/New_York',
      '2026-04-15T19:48:22.000Z',
    );

    assert.deepEqual(sections[0].trades.map((row) => row.symbol), ['BATS:BBB', 'BATS:CCC', 'BATS:AAA']);
  });

  it('keeps the real trade row and reconciles unmatched symbols as no-data rows', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        { watchlist_name: 'Swing 1H', timeframe: '60', symbols: ['AMEX:QID', 'BATS:EDC'], source: 'tradingview_panel' },
      ],
      [
        {
          symbol: 'AMEX:QID',
          timeframe: '60',
          watchlist_name: 'Swing 1H',
          scanned_at: '2026-04-15T19:48:22.000Z',
          signal: { hasSignal: true, price: 82.33 },
          trade: null,
        },
        {
          symbol: 'BATS:EDC',
          timeframe: '60',
          watchlist_name: 'Swing 1H',
          scanned_at: '2026-04-15T19:48:22.000Z',
          signal: { hasSignal: false },
          trade: {
            signal: 'EXIT',
            entryPrice: '66.95 USD',
            entryTime: 'Jan 30, 2026, 13:00',
            netPnl: '-223.433 USD | -2.33%',
            favorableExcursion: '212.076 USD | 2.21%',
            adverseExcursion: '-214.064 USD | -2.23%',
          },
        },
      ],
      {},
      'America/New_York',
      '2026-04-15T19:48:22.000Z',
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].trades.length, 2);
    assert.equal(sections[0].trades[0].symbol, 'BATS:EDC');
    assert.equal(sections[0].trades[1].signal, '—');
  });

  it('downgrades stale baseline OPEN rows so old positions do not remain falsely open', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        { watchlist_name: 'Swing 15m', timeframe: '15', symbols: ['BATS:SOXL'], source: 'watchlist_unavailable' },
      ],
      [],
      {
        'BATS:SOXL:15': {
          symbol: 'BATS:SOXL',
          timeframe: '15',
          signal_type: 'OPEN',
          entry_price: '82.33 USD',
          entry_time: '2026-04-16T13:01:00.000Z',
          net_pnl: '—',
          favorable_excursion: '—',
          adverse_excursion: '—',
        },
      },
      'America/New_York',
      '2026-04-17T14:03:37.000Z',
      { 'Swing 15m': { symbols: ['BATS:SOXL'], symbol_count: 1 } },
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].trades.length, 1);
    assert.equal(sections[0].trades[0].signal, 'EXIT');
  });

  it('prefers saved EXIT history over synthetic OPEN rows for fast watchlists', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        {
          watchlist_name: 'Swing 15m',
          timeframe: '15',
          symbols: ['BATS:ERX'],
          source: 'tradingview_panel',
          symbol_count: 1,
        },
      ],
      [
        {
          symbol: 'BATS:ERX',
          timeframe: '15',
          watchlist_name: 'Swing 15m',
          scanned_at: '2026-04-17T14:15:00.000Z',
          signal: { hasSignal: true, price: 94.02 },
          trade: null,
        },
      ],
      {
        'BATS:ERX:15': {
          symbol: 'BATS:ERX',
          timeframe: '15',
          signal_type: 'EXIT',
          entry_price: '94.02 USD',
          entry_time: '2026-03-23T11:15:00.000Z',
          net_pnl: '+937.121 USD | +7.72%',
          favorable_excursion: '961.821 USD | 7.92%',
          adverse_excursion: '-250.779 USD | -2.07%',
        },
      },
      'America/New_York',
      '2026-04-17T14:20:00.000Z',
      { 'Swing 15m': { symbols: ['BATS:ERX'], symbol_count: 1 } },
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].trades.length, 1);
    assert.equal(sections[0].trades[0].signal, 'EXIT');
  });

  it('limits saved prior rows to symbols belonging to that watchlist', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        {
          watchlist_name: 'Swing 15m',
          timeframe: '15',
          symbols: ['BATS:SOXL', 'BTCUSD'],
          source: 'watchlist_unavailable',
          symbol_count: 2,
        },
      ],
      [],
      {
        'BATS:SOXL:15': {
          symbol: 'BATS:SOXL',
          timeframe: '15',
          signal_type: 'EXIT',
          entry_price: '47.88 USD',
          entry_time: '2026-04-02T08:15:00.000Z',
          net_pnl: '+777.723 USD | +9.33%',
          favorable_excursion: '894.729 USD | 10.73%',
          adverse_excursion: '-371.991 USD | -4.46%',
        },
        'AMEX:TZA:15': {
          symbol: 'AMEX:TZA',
          timeframe: '15',
          signal_type: 'OPEN',
          entry_price: '509.7',
          entry_time: '2026-04-16T14:21:28.000Z',
          net_pnl: '—',
          favorable_excursion: '—',
          adverse_excursion: '—',
        },
      },
      'America/New_York',
      '2026-04-16T18:47:06.258Z',
      {},
    );

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].trades.map((row) => row.symbol), ['BATS:SOXL', 'BTCUSD']);
    assert.equal(sections[0].trades[1].signal, '—');
    assert.equal(sections[0].symbolCount, 2);
  });

  it('keeps prior history available for a watchlist even when the live panel is unavailable', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        { watchlist_name: 'Swing 1D', timeframe: 'D', symbols: [], source: 'watchlist_unavailable' },
      ],
      [],
      {
        'BATS:GLD:D': {
          symbol: 'BATS:GLD',
          timeframe: 'D',
          signal_type: 'EXIT',
          entry_price: '305.26 USD',
          entry_time: '2026-04-10T14:00:00.000Z',
          last_seen_at: '2026-04-10T14:00:00.000Z',
          net_pnl: '272.482 USD | 2.23%',
          favorable_excursion: '340.590 USD | 2.79%',
          adverse_excursion: '-184.210 USD | -1.51%',
        },
      },
      'America/New_York',
      '2026-04-15T19:48:22.000Z',
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].trades.length, 1);
    assert.equal(sections[0].trades[0].symbol, 'BATS:GLD');
  });

  it('reconciles rows to the full watchlist count and preserves actual trade-date text', () => {
    const sections = buildPriorSignalsByWatchlist(
      [
        {
          watchlist_name: 'Swing 1H',
          timeframe: '60',
          symbols: ['BATS:AAA', 'BATS:BBB', 'BATS:CCC'],
          source: 'watchlist_unavailable',
          symbol_count: 3,
        },
      ],
      [],
      {
        'BATS:AAA:60': {
          symbol: 'BATS:AAA',
          timeframe: '60',
          signal_type: 'EXIT',
          entry_price: '100 USD',
          entry_time: 'Jan 30, 2026, 13:00',
          net_pnl: '5 USD | 1%',
          favorable_excursion: '8 USD | 2%',
          adverse_excursion: '-2 USD | -0.5%',
        },
      },
      'America/New_York',
      '2026-04-17T14:03:37.000Z',
      { 'Swing 1H': { symbols: ['BATS:AAA', 'BATS:BBB', 'BATS:CCC'], symbol_count: 3 } },
    );

    assert.equal(sections.length, 1);
    assert.equal(sections[0].trades.length, 3);
    assert.equal(sections[0].trades[0].entryTime.includes('Jan 30, 2026, 13:00'), true);
    assert.equal(sections[0].trades[1].symbol, 'BATS:BBB');
    assert.equal(sections[0].trades[1].signal, '—');
    assert.equal(sections[0].trades[1].entryTime, 'No prior trade recorded');
  });
});

describe('market hours gating', () => {
  const marketHours = {
    timezone: 'America/New_York',
    open: '09:30',
    close: '16:00',
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  };

  it('allows scans after 9:31 ET on weekdays', () => {
    const result = shouldRunEquityScanNow(new Date('2026-04-15T13:31:00.000Z'), marketHours);
    assert.equal(result, true);
  });

  it('blocks scans before 9:31 ET', () => {
    const result = shouldRunEquityScanNow(new Date('2026-04-15T13:29:00.000Z'), marketHours);
    assert.equal(result, false);
  });

  it('blocks scans after the close', () => {
    const result = shouldRunEquityScanNow(new Date('2026-04-15T20:05:00.000Z'), marketHours);
    assert.equal(result, false);
  });
});
