import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailySignalLinesFromLog,
  buildPriorSignalsByWatchlist,
  validateWatchlistRegression,
} from '../src/core/morning.js';
import { swing15mRegressionFixture } from './fixtures/swing15m_regression_fixture.js';

describe('Swing 15m regression gate', () => {
  it('matches the day log, count, and prior-trade quality rules before release', () => {
    const fixture = swing15mRegressionFixture;
    const priorSignals = buildPriorSignalsByWatchlist(
      fixture.watchlistSummaries,
      fixture.results,
      {},
      fixture.timezone,
      fixture.asOf,
      { 'Swing 15m': { symbols: fixture.watchlistSummaries[0].symbols, symbol_count: 3 } },
    );

    const topLines = buildDailySignalLinesFromLog(fixture.dayLogEvents, fixture.timezone);
    const check = validateWatchlistRegression({
      watchlistName: fixture.watchlistName,
      topLines,
      priorSignals,
      dayLogEvents: fixture.dayLogEvents,
      asOf: fixture.asOf,
      timezone: fixture.timezone,
    });

    assert.equal(check.ok, true, check.errors.join('\n'));
    assert.equal(check.section.symbolCount, 3);
    assert.equal(check.section.trades.length, 3);
    assert.deepEqual(
      check.section.trades.map((row) => row.symbol),
      ['BATS:ERX', 'BATS:USO', 'BATS:MEXX'],
    );
  });
});
