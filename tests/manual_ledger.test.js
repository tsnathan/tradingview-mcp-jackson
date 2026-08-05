import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetManualLedgerForTests,
  validateManualPositionInput,
  createManualPosition,
  listManualPositions,
  getManualPositionById,
  markManualPositionAlertCreated,
  markManualPositionAlertsDeleted,
  markManualPositionExitAlerted,
  validateManualCloseInput,
  validateManualPositionUpdate,
  updateManualPosition,
  closeManualPosition,
} from '../src/core/manual_ledger.js';

const VALID = {
  account: 'Fidelity IRA',
  symbol: 'aapl',
  timeframe: '240',
  qty: 10,
  entry_price: 150,
  stop_price: 140,
  target_price: 175,
};

function create(overrides = {}) {
  const parsed = validateManualPositionInput({ ...VALID, ...overrides });
  assert.equal(parsed.ok, true, parsed.error);
  return createManualPosition(parsed.value);
}

describe('manual ledger validation', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('rejects an entry with neither stop nor target price', () => {
    const parsed = validateManualPositionInput({ ...VALID, stop_price: null, target_price: null });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at least one of stop_price or target_price/);
  });

  it('accepts an entry with only a stop price', () => {
    const parsed = validateManualPositionInput({ ...VALID, target_price: '' });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.stop_price, 140);
    assert.equal(parsed.value.target_price, null);
  });

  it('rejects an entry with no timeframe', () => {
    // Never defaulted: timeframe drives the TradingView alert resolution and any ntfy filtering.
    const parsed = validateManualPositionInput({ ...VALID, timeframe: '   ' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /timeframe is required/);
  });

  it('rejects non-positive qty and entry price', () => {
    assert.equal(validateManualPositionInput({ ...VALID, qty: 0 }).ok, false);
    assert.equal(validateManualPositionInput({ ...VALID, entry_price: -1 }).ok, false);
    assert.equal(validateManualPositionInput({ ...VALID, stop_price: 0 }).ok, false);
  });

  it('normalizes the symbol to uppercase and defaults levels_source to manual', () => {
    const parsed = validateManualPositionInput(VALID);
    assert.equal(parsed.value.symbol, 'AAPL');
    assert.equal(parsed.value.levels_source, 'manual');
  });

  it('keeps an explicit levels_source so a measured level is distinguishable from a guess', () => {
    const parsed = validateManualPositionInput({ ...VALID, levels_source: 'strategy_excursion' });
    assert.equal(parsed.value.levels_source, 'strategy_excursion');
  });

  it('rejects an unparseable entered_at rather than silently substituting now', () => {
    const parsed = validateManualPositionInput({ ...VALID, entered_at: 'not-a-date' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /entered_at is not a valid date/);
  });
});

describe('manual ledger persistence', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('creates an open entry that is visible in the open list', () => {
    const row = create();
    assert.equal(row.status, 'open');
    assert.equal(row.symbol, 'AAPL');
    assert.equal(row.timeframe, '240');
    assert.equal(listManualPositions({ status: 'open' }).length, 1);
    assert.equal(listManualPositions({ status: 'closed' }).length, 0);
    assert.equal(listManualPositions().length, 1);
  });

  it('closes an entry and moves it out of the open list', () => {
    const row = create();
    const parsed = validateManualCloseInput({ exit_price: 168.5 });
    assert.equal(parsed.ok, true);
    const result = closeManualPosition(row.id, parsed.value);
    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'closed');
    assert.equal(result.value.exit_price, 168.5);
    assert.equal(listManualPositions({ status: 'open' }).length, 0);
    assert.equal(listManualPositions({ status: 'closed' }).length, 1);
  });

  it('defaults closed_at to now when omitted', () => {
    const before = Date.now();
    const parsed = validateManualCloseInput({ exit_price: 10 });
    const closedMs = new Date(parsed.value.closed_at).getTime();
    assert.ok(closedMs >= before && closedMs <= Date.now());
  });

  it('accepts an explicit back-dated closed_at', () => {
    const row = create();
    const parsed = validateManualCloseInput({ exit_price: 10, closed_at: '2026-01-15' });
    assert.equal(parsed.ok, true);
    const result = closeManualPosition(row.id, parsed.value);
    assert.equal(result.ok, true);
    assert.match(result.value.closed_at, /^2026-01-15/);
  });

  it('rejects a closed_at that is not a date', () => {
    const parsed = validateManualCloseInput({ exit_price: 10, closed_at: 'yesterday-ish' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /closed_at is not a valid date/);
  });

  it('rejects a non-positive exit price', () => {
    assert.equal(validateManualCloseInput({ exit_price: 0 }).ok, false);
    assert.equal(validateManualCloseInput({}).ok, false);
  });

  it('refuses to close an already-closed entry', () => {
    const row = create();
    closeManualPosition(row.id, { exit_price: 10, closed_at: new Date().toISOString() });
    const second = closeManualPosition(row.id, { exit_price: 11, closed_at: new Date().toISOString() });
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.match(second.error, /already closed/);
  });

  it('returns 404 for a nonexistent id', () => {
    const result = closeManualPosition(9999, { exit_price: 10, closed_at: new Date().toISOString() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(getManualPositionById(9999), null);
  });

  it('persists alert ids and status', () => {
    const row = create();
    const updated = markManualPositionAlertCreated(row.id, {
      stop_alert_id: 12345, target_alert_id: null, tv_alert_status: 'partial',
    });
    assert.equal(updated.stop_alert_id, '12345');
    assert.equal(updated.target_alert_id, null);
    assert.equal(updated.tv_alert_status, 'partial');
    assert.equal(getManualPositionById(row.id).tv_alert_status, 'partial');
  });

  it('markManualPositionExitAlerted persists and is visible on a subsequent read', () => {
    const row = create();
    assert.equal(row.exit_alert_fired_at, null);
    const firedAt = new Date().toISOString();
    markManualPositionExitAlerted(row.id, { level: 'stop', firedAt });
    const reread = getManualPositionById(row.id);
    assert.equal(reread.exit_alert_level, 'stop');
    assert.equal(reread.exit_alert_fired_at, firedAt);
  });
});

describe('manual ledger update (editing an open position)', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('applies only the keys present, leaving every other field alone', () => {
    const row = create({ notes: 'original' });
    const parsed = validateManualPositionUpdate({ stop_price: 138.5 }, row);
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual(Object.keys(parsed.value), ['stop_price']);
    const updated = updateManualPosition(row.id, parsed.value);
    assert.equal(updated.ok, true);
    assert.equal(updated.value.stop_price, 138.5);
    // Untouched fields survive — a partial patch must never reset anything to a default.
    assert.equal(updated.value.target_price, 175);
    assert.equal(updated.value.qty, 10);
    assert.equal(updated.value.notes, 'original');
    assert.equal(updated.value.status, 'open');
  });

  it('reports which changes invalidate the live TradingView alerts', () => {
    const row = create();
    assert.deepEqual(validateManualPositionUpdate({ qty: 20 }, row).alertsAffected, []);
    assert.deepEqual(validateManualPositionUpdate({ notes: 'x' }, row).alertsAffected, []);
    assert.deepEqual(validateManualPositionUpdate({ stop_price: 130 }, row).alertsAffected, ['stop_price']);
    assert.deepEqual(validateManualPositionUpdate({ symbol: 'MSFT' }, row).alertsAffected, ['symbol']);
    assert.deepEqual(
      validateManualPositionUpdate({ symbol: 'MSFT', timeframe: '60', target_price: 200 }, row).alertsAffected,
      ['symbol', 'timeframe', 'target_price'],
    );
  });

  it('does not flag alerts when a level is resubmitted unchanged', () => {
    // The dashboard sends the whole row on save, so an untouched level arrives as a no-op patch.
    // Rebuilding alerts for that would delete and recreate a correct alert on every edit.
    const row = create();
    const parsed = validateManualPositionUpdate({ stop_price: 140, qty: 12 }, row);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.alertsAffected, []);
  });

  it('clears a level when sent as an empty string, but never both', () => {
    const row = create();
    const cleared = validateManualPositionUpdate({ target_price: '' }, row);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.value.target_price, null);
    assert.deepEqual(cleared.alertsAffected, ['target_price']);

    const both = validateManualPositionUpdate({ stop_price: '', target_price: '' }, row);
    assert.equal(both.ok, false);
    assert.match(both.error, /at least one of stop_price or target_price/);
  });

  it('rejects clearing the only remaining level, judged on the MERGED row', () => {
    // stop is already the only level; blanking it leaves nothing for the exit check to watch.
    const row = create({ target_price: '' });
    const parsed = validateManualPositionUpdate({ stop_price: '' }, row);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at least one of stop_price or target_price/);
  });

  it('rejects non-positive numbers and an unparseable date', () => {
    const row = create();
    assert.match(validateManualPositionUpdate({ qty: 0 }, row).error, /qty must be a positive number/);
    assert.match(validateManualPositionUpdate({ qty: -1 }, row).error, /qty must be a positive number/);
    assert.match(validateManualPositionUpdate({ entry_price: 'abc' }, row).error, /entry_price must be a positive number/);
    assert.match(validateManualPositionUpdate({ stop_price: -5 }, row).error, /stop_price must be a positive number/);
    assert.match(validateManualPositionUpdate({ entered_at: 'not-a-date' }, row).error, /not a valid date/);
    assert.match(validateManualPositionUpdate({ symbol: '  ' }, row).error, /symbol is required/);
    assert.match(validateManualPositionUpdate({ timeframe: '' }, row).error, /timeframe is required/);
  });

  it('normalizes symbol and side the same way the add form does', () => {
    const row = create();
    const parsed = validateManualPositionUpdate({ symbol: ' msft ', side: 'short' }, row);
    assert.equal(parsed.value.symbol, 'MSFT');
    assert.equal(parsed.value.side, 'SHORT');
    // Anything that isn't SHORT is LONG, matching validateManualPositionInput.
    assert.equal(validateManualPositionUpdate({ side: 'whatever' }, row).value.side, 'LONG');
  });

  it('refuses an empty patch rather than issuing a no-op UPDATE', () => {
    const row = create();
    assert.match(validateManualPositionUpdate({}, row).error, /nothing to update/);
    assert.equal(updateManualPosition(row.id, {}).status, 400);
  });

  it('refuses to edit a closed position, at both layers', () => {
    const row = create();
    closeManualPosition(row.id, { exit_price: 160, closed_at: new Date().toISOString() });
    const closed = getManualPositionById(row.id);
    assert.match(validateManualPositionUpdate({ qty: 5 }, closed).error, /only an open position/);
    // Enforced again in the writer, so a caller that skipped the validator cannot rewrite history.
    const direct = updateManualPosition(row.id, { qty: 5 });
    assert.equal(direct.ok, false);
    assert.equal(direct.status, 409);
    assert.equal(getManualPositionById(row.id).qty, 10);
  });

  it('returns 404 for a nonexistent id', () => {
    assert.match(validateManualPositionUpdate({ qty: 1 }, null).error, /not found/);
    assert.equal(updateManualPosition(9999, { qty: 1 }).status, 404);
  });
});

describe('manual ledger alert deletion bookkeeping', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('clears the alert ids only on a confirmed delete', () => {
    const row = create();
    markManualPositionAlertCreated(row.id, { stop_alert_id: 111, target_alert_id: 222, tv_alert_status: 'created' });
    const after = markManualPositionAlertsDeleted(row.id, { ok: true });
    assert.equal(after.stop_alert_id, null);
    assert.equal(after.target_alert_id, null);
    assert.equal(after.tv_alert_status, 'deleted');
  });

  it('KEEPS the alert ids on a failed delete — they are the only handle on a still-live alert', () => {
    const row = create();
    markManualPositionAlertCreated(row.id, { stop_alert_id: 111, target_alert_id: 222, tv_alert_status: 'created' });
    const after = markManualPositionAlertsDeleted(row.id, { ok: false, reason: 'TradingView unreachable' });
    assert.equal(after.stop_alert_id, '111');
    assert.equal(after.target_alert_id, '222');
    // 'created' would claim the alerts are fine; 'deleted' would claim they are gone. Neither is true.
    assert.equal(after.tv_alert_status, 'delete_failed');
  });
});
