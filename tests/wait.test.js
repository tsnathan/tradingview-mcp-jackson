import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForChartReady } from '../src/wait.js';

describe('waitForChartReady', () => {
  it('returns false when chart polling stalls', async () => {
    const start = Date.now();

    const result = await waitForChartReady(null, null, 100, {
      evalFn: () => new Promise(() => {}),
      pollInterval: 10,
      evalTimeout: 20,
    });

    const elapsed = Date.now() - start;
    assert.equal(result, false);
    assert.ok(elapsed < 1000, `expected fast timeout, got ${elapsed}ms`);
  });

  it('returns true when state becomes stable', async () => {
    let calls = 0;
    const result = await waitForChartReady('BTCUSD', null, 200, {
      evalFn: async () => {
        calls += 1;
        return { isLoading: false, barCount: calls < 3 ? calls : 5, currentSymbol: 'BTCUSD' };
      },
      pollInterval: 1,
      evalTimeout: 20,
    });

    assert.equal(result, true);
  });
});
