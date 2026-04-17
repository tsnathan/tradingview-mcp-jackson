import {
  buildDailySignalLinesFromLog,
  buildPriorSignalsByWatchlist,
  validateWatchlistRegression,
} from '../src/core/morning.js';
import { swing15mRegressionFixture } from '../tests/fixtures/swing15m_regression_fixture.js';

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

if (!check.ok) {
  console.error('Swing 15m regression gate failed.');
  for (const error of check.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Swing 15m regression gate passed.');
console.log(`Validated ${check.section.trades.length} trades for ${check.section.watchlistName}.`);
