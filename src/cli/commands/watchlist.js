import { register } from '../router.js';
import * as core from '../../core/watchlist.js';
import { syncWatchlistSymbolsFromTradingView, seedCurrentWatchlistToBaseline } from '../../core/morning.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, sync)',
  subcommands: new Map([
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['sync', {
      description: 'Sync configured watchlists from TradingView into the local baseline',
      handler: async () => {
        const result = await syncWatchlistSymbolsFromTradingView();
        return { success: true, synced: result.synced };
      },
    }],
    ['seed', {
      description: 'Seed baseline from the currently-displayed TradingView watchlist (no switching). Usage: tv watchlist seed "Swing 15m"',
      handler: async (opts, positionals) => {
        const name = positionals[0] || null;
        return seedCurrentWatchlistToBaseline({ watchlistName: name });
      },
    }],
  ]),
});
