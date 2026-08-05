import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateManualLedgerExits, computeExcursionLevels } from '../src/core/morning.js';

// Fabricated rows only — no CDP, no TradingView connection, matching how
// processLevelViolationsAndCleanup's hit-detection is exercised via plain `results` input.
function row(overrides = {}) {
  return {
    id: 1,
    account: 'Fidelity IRA',
    symbol: 'AAPL',
    entry_price: 150,
    stop_price: 140,
    target_price: 175,
    exit_alert_fired_at: null,
    ...overrides,
  };
}

describe('evaluateManualLedgerExits', () => {
  it('fires when price crosses below the stop', () => {
    const hits = evaluateManualLedgerExits([row()], { 1: 139.5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].level, 'stop');
    assert.equal(hits[0].id, 1);
    assert.equal(hits[0].triggerPrice, 140);
    assert.match(hits[0].line, /MANUAL EXIT: AAPL \(Fidelity IRA\)/);
    assert.match(hits[0].line, /Stop 140 \(last 139.5\)/);
  });

  it('fires when price crosses above the target', () => {
    const hits = evaluateManualLedgerExits([row()], { 1: 176 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].level, 'target');
    assert.equal(hits[0].triggerPrice, 175);
    assert.match(hits[0].line, /Target 175 \(last 176\)/);
  });

  it('fires exactly at the level, not only past it', () => {
    assert.equal(evaluateManualLedgerExits([row()], { 1: 140 })[0].level, 'stop');
    assert.equal(evaluateManualLedgerExits([row()], { 1: 175 })[0].level, 'target');
  });

  it('does not fire while price sits between the levels', () => {
    assert.deepEqual(evaluateManualLedgerExits([row()], { 1: 150 }), []);
  });

  it('skips a position that has already fired, so it cannot re-push every scan', () => {
    const fired = row({ exit_alert_fired_at: '2026-08-04T13:00:00.000Z' });
    assert.deepEqual(evaluateManualLedgerExits([fired], { 1: 100 }), []);
  });

  it('skips a position with no quote rather than treating it as a miss', () => {
    assert.deepEqual(evaluateManualLedgerExits([row()], {}), []);
    assert.deepEqual(evaluateManualLedgerExits([row()], { 1: null }), []);
    assert.deepEqual(evaluateManualLedgerExits([row()], { 1: NaN }), []);
    assert.deepEqual(evaluateManualLedgerExits([row()], { 1: 'n/a' }), []);
  });

  it('only checks the level that is set', () => {
    const stopOnly = row({ id: 2, target_price: null });
    assert.deepEqual(evaluateManualLedgerExits([stopOnly], { 2: 9999 }), []);
    assert.equal(evaluateManualLedgerExits([stopOnly], { 2: 139 })[0].level, 'stop');

    const targetOnly = row({ id: 3, stop_price: null });
    assert.deepEqual(evaluateManualLedgerExits([targetOnly], { 3: 1 }), []);
    assert.equal(evaluateManualLedgerExits([targetOnly], { 3: 180 })[0].level, 'target');
  });

  it('evaluates each position independently', () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, symbol: 'MSFT', stop_price: 300, target_price: 400 }),
      row({ id: 3, symbol: 'TSLA', exit_alert_fired_at: '2026-08-04T13:00:00.000Z' }),
    ];
    const hits = evaluateManualLedgerExits(rows, { 1: 139, 2: 350, 3: 1 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].symbol, 'AAPL');
  });

  it('tolerates empty and missing inputs without throwing', () => {
    assert.deepEqual(evaluateManualLedgerExits([], {}), []);
    assert.deepEqual(evaluateManualLedgerExits(null, null), []);
    assert.deepEqual(evaluateManualLedgerExits([null, undefined], { 1: 100 }), []);
  });
});

describe('computeExcursionLevels', () => {
  const stats = { avgAdversePct: 5, maxAdversePct: 12, avgFavorablePct: 8, maxFavorablePct: 20 };

  it('applies the excursion percentages to the entry price', () => {
    assert.deepEqual(computeExcursionLevels(100, stats), {
      stopAvg: 95, stopMax: 88, targetAvg: 108, targetMax: 120,
    });
  });

  it('rounds to two decimals', () => {
    const levels = computeExcursionLevels(150.55, stats);
    assert.equal(levels.stopAvg, 143.02);
    assert.equal(levels.targetAvg, 162.59);
  });

  it('returns null rather than NaN levels for unusable input', () => {
    assert.equal(computeExcursionLevels(0, stats), null);
    assert.equal(computeExcursionLevels(-5, stats), null);
    assert.equal(computeExcursionLevels(NaN, stats), null);
    assert.equal(computeExcursionLevels(100, null), null);
    assert.equal(computeExcursionLevels(100, {}), null);
  });
});
