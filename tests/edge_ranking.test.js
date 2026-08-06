import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachOpenTradeRanks } from '../src/core/edge_analysis.js';

/**
 * Unit coverage for the open-trade Edge ranking. This had NONE before 2026-08-06 — no test file
 * referenced attachOpenTradeRanks, buildSymbolEdgeScores or any of the edgeRank* fields, which is
 * the direct reason the Edge/Org/New columns could blank on every skipped tick without a red test.
 *
 * These assert the ranking CONTRACT, not scores. Scores come from the live trade log via
 * buildSymbolEdgeScores(), so asserting a number here would make the suite fail whenever real
 * trading data moves. The symbols below are deliberately fictitious so they carry no trade history:
 * that pins the unscored path (edge: null), which is also the path a brand-new ticker takes.
 */
describe('attachOpenTradeRanks', () => {
  const row = (symbol, timeframe, entryTimeRaw) => ({ symbol, timeframe, entryTimeRaw, signal: 'OPEN' });

  it('adds every ranking field to every row', () => {
    const out = attachOpenTradeRanks([row('TEST:AAA', '15', '2026-08-06T14:30:00.000Z')], { isNew: () => false });
    const r = out[0];
    for (const field of ['isNewEntry', 'edge', 'edgeRankOrg', 'edgeRankOrgTotal', 'edgeRankNew', 'edgeRankNewTotal']) {
      assert.ok(field in r, `missing ${field}`);
    }
  });

  it('leaves the caller\'s original fields untouched', () => {
    const out = attachOpenTradeRanks([row('TEST:AAA', '15', '2026-08-06T14:30:00.000Z')], { isNew: () => false });
    assert.equal(out[0].symbol, 'TEST:AAA');
    assert.equal(out[0].timeframe, '15');
    assert.equal(out[0].signal, 'OPEN');
    assert.equal(out[0].entryTimeRaw, '2026-08-06T14:30:00.000Z');
  });

  it('returns an empty list unchanged rather than throwing', () => {
    assert.deepEqual(attachOpenTradeRanks([], { isNew: () => true }), []);
  });

  it('tolerates a non-array input', () => {
    assert.deepEqual(attachOpenTradeRanks(null, { isNew: () => true }), []);
  });

  // The isNew predicate is injected by morning.js (which owns the ET trading-day calendar), so the
  // ranker must take its answer verbatim rather than re-deriving "new" from the timestamp itself.
  it('takes isNewEntry from the injected predicate', () => {
    const rows = [row('TEST:AAA', '15', '2026-08-06T14:30:00.000Z'), row('TEST:BBB', '15', '2026-08-01T14:30:00.000Z')];
    const out = attachOpenTradeRanks(rows, { isNew: (r) => r.symbol === 'TEST:AAA' });
    assert.equal(out.find((r) => r.symbol === 'TEST:AAA').isNewEntry, true);
    assert.equal(out.find((r) => r.symbol === 'TEST:BBB').isNewEntry, false);
  });

  it('ranks every position in the new book, and excludes new arrivals from the org book', () => {
    const rows = [
      row('TEST:AAA', '15', '2026-08-06T14:30:00.000Z'),   // arrived today
      row('TEST:BBB', '15', '2026-08-01T14:30:00.000Z'),   // held
      row('TEST:CCC', '15', '2026-07-28T14:30:00.000Z'),   // held
    ];
    const out = attachOpenTradeRanks(rows, { isNew: (r) => r.symbol === 'TEST:AAA' });

    // "New" book = all three positions now open on this timeframe.
    assert.ok(out.every((r) => r.edgeRankNew >= 1 && r.edgeRankNew <= 3));
    assert.ok(out.every((r) => r.edgeRankNewTotal === 3));
    assert.equal(new Set(out.map((r) => r.edgeRankNew)).size, 3, 'new-ranks must be distinct');

    // "Org" book = the two that were already held. A new arrival has no standing in it.
    const arrival = out.find((r) => r.symbol === 'TEST:AAA');
    assert.equal(arrival.edgeRankOrg, null);
    assert.equal(arrival.edgeRankOrgTotal, null);
    const held = out.filter((r) => r.symbol !== 'TEST:AAA');
    assert.ok(held.every((r) => r.edgeRankOrgTotal === 2));
    assert.equal(new Set(held.map((r) => r.edgeRankOrg)).size, 2, 'org-ranks must be distinct');
  });

  // Expectancy scales hard with timeframe (15m ~1.7%/trade vs 4H ~7%), so ranking pools timeframes
  // separately — a cross-timeframe pool would rank the timeframe, not the symbol.
  it('ranks each timeframe as its own book', () => {
    const rows = [
      row('TEST:AAA', '15', '2026-08-01T14:30:00.000Z'),
      row('TEST:BBB', '15', '2026-08-01T14:30:00.000Z'),
      row('TEST:CCC', '240', '2026-08-01T14:30:00.000Z'),
    ];
    const out = attachOpenTradeRanks(rows, { isNew: () => false });
    assert.ok(out.filter((r) => r.timeframe === '15').every((r) => r.edgeRankNewTotal === 2));
    assert.equal(out.find((r) => r.timeframe === '240').edgeRankNewTotal, 1);
    assert.equal(out.find((r) => r.timeframe === '240').edgeRankNew, 1);
  });

  // A symbol with no logged history must read as "unknown", never as "weak" — the portfolio cap
  // treats an unscored row as un-flaggable, so scoring it 0 would recommend liquidating new names.
  it('scores an unknown symbol as null rather than zero', () => {
    const out = attachOpenTradeRanks([row('TEST:NOSUCHTICKER', '15', '2026-08-06T14:30:00.000Z')], { isNew: () => false });
    assert.equal(out[0].edge, null);
    assert.ok(Number.isFinite(out[0].edgeRankNew), 'an unscored row is still ranked, just last');
  });

  it('defaults isNewEntry to false when no predicate is supplied', () => {
    const out = attachOpenTradeRanks([row('TEST:AAA', '15', '2026-08-06T14:30:00.000Z')]);
    assert.equal(out[0].isNewEntry, false);
  });
});
