/**
 * Sim Templates — the saved Portfolio Sim configuration, its frozen KPI snapshot, and the
 * attribution it stamps onto real orders.
 *
 * The tests worth having here are the ones guarding things that fail SILENTLY:
 *   - short_desc leaves this process (it goes out in a webhook payload), so its charset and
 *     uniqueness are enforcement, not cosmetics;
 *   - a market payload with no template must stay byte-for-byte identical to the pre-template one,
 *     because the armed auto-send path is live money and the executor's tolerance for unrecognised
 *     keys is undocumented;
 *   - auto-dispatch resolution must refuse to guess between two templates claiming one timeframe;
 *   - archiving must never destroy the attribution a position already carries.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetManualLedgerForTests, validateManualPositionInput, createManualPosition, validateManualPositionUpdate } from '../src/core/manual_ledger.js';
import {
  validateTemplateInput,
  validateTemplateUpdate,
  createTemplate,
  updateTemplate,
  archiveTemplate,
  listTemplates,
  getTemplateById,
  getTemplateByShortDesc,
  resolveTemplateForTimeframe,
  findTimeframeCollisions,
  templateStamp,
  templateStaleness,
  normalizeShortDesc,
  suggestShortDesc,
  SHORT_DESC_MAX,
} from '../src/core/sim_templates.js';
import { buildWebhookPayload, normalizeTemplateStamp } from '../src/core/trade_webhook.js';

const VALID = {
  name: '15m + 30m @ 3',
  short_desc: '15m30m3',
  account: 'Fidelity IRA',
  timeframes: ['15', '30'],
  max_positions: 3,
  capital: 100000,
  universe: 'top20',
  tickers: ['soxl', 'tna'],
  rule_type: 'flip-only',
  kpis: { expectancyPct: 2.71, winLossRatio: 2.89, cagr: 218.2, signalsTaken: 184 },
};

function make(overrides = {}) {
  const parsed = validateTemplateInput({ ...VALID, ...overrides });
  assert.equal(parsed.ok, true, parsed.error);
  const created = createTemplate(parsed.value);
  assert.equal(created.ok, true, created.error);
  return created.value;
}

describe('short_desc is an identifier, not a label', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('lowercases and accepts the allowed charset', () => {
    assert.equal(normalizeShortDesc('  SW_15M-3 '), 'sw_15m-3');
  });

  it('refuses whitespace and punctuation rather than stripping them', () => {
    // Stripping would silently produce a DIFFERENT identifier than the one typed, which then rides
    // along on real orders. Refusing surfaces the problem while it is still a form validation.
    for (const bad of ['15m 30m', '15m+30m', '15m/3', 'a.b', 'a:b', '']) {
      assert.equal(normalizeShortDesc(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });

  it(`refuses anything over ${SHORT_DESC_MAX} characters instead of truncating`, () => {
    assert.equal(normalizeShortDesc('a'.repeat(SHORT_DESC_MAX)), 'a'.repeat(SHORT_DESC_MAX));
    assert.equal(normalizeShortDesc('a'.repeat(SHORT_DESC_MAX + 1)), null);
  });

  it('is unique, enforced at the database rather than by a racy pre-check', () => {
    make();
    const dup = validateTemplateInput({ ...VALID, name: 'Another' });
    assert.equal(dup.ok, true);
    const created = createTemplate(dup.value);
    assert.equal(created.ok, false);
    assert.equal(created.status, 409);
    assert.match(created.error, /already used/);
  });

  it('treats uniqueness case-insensitively, matching how it is normalized', () => {
    make({ short_desc: 'abc' });
    const parsed = validateTemplateInput({ ...VALID, name: 'Other', short_desc: 'ABC' });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.short_desc, 'abc');
    assert.equal(createTemplate(parsed.value).ok, false);
  });

  it('suggests a code from whole timeframe segments, never a truncated one', () => {
    assert.equal(suggestShortDesc(['15m', '30m'], 3), '15m30m3');
    // "15m" + "240m" would overflow; the second segment is DROPPED rather than cut mid-way, which
    // would read as a timeframe that was never selected.
    const long = suggestShortDesc(['15m', '30m', '45m', '240m'], 5);
    assert.ok(long.length <= SHORT_DESC_MAX);
    assert.ok(!long.includes('24'), `expected no partial segment, got ${long}`);
  });

  it('never invents a code on save — it is required, not defaulted', () => {
    const parsed = validateTemplateInput({ ...VALID, short_desc: '' });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /short_desc is required/);
  });
});

describe('template validation', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('requires at least one timeframe and a whole slot count of 1 or more', () => {
    assert.equal(validateTemplateInput({ ...VALID, timeframes: [] }).ok, false);
    assert.equal(validateTemplateInput({ ...VALID, max_positions: 0 }).ok, false);
    assert.equal(validateTemplateInput({ ...VALID, max_positions: 2.5 }).ok, false);
    assert.equal(validateTemplateInput({ ...VALID, max_positions: 1 }).ok, true);
  });

  it('refuses an account that is not in accounts.json', () => {
    const parsed = validateTemplateInput(VALID, { knownAccounts: ['Schwab SN'] });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Unknown account/);
  });

  it('allows no account at all — a template need not be tied to one yet', () => {
    const parsed = validateTemplateInput({ ...VALID, account: '' }, { knownAccounts: ['Schwab SN'] });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.account, null);
  });

  it('drops non-finite and unrecognised KPIs rather than storing them', () => {
    // A stored Infinity would render as a real number and sort above every honest row.
    const parsed = validateTemplateInput({
      ...VALID,
      kpis: { expectancyPct: 2.5, winLossRatio: Infinity, cagr: NaN, bogus: 1, profitFactor: 3 },
    });
    assert.deepEqual(parsed.value.kpis, { expectancyPct: 2.5 });
  });

  it('stores no KPI snapshot at all when none survives, rather than an empty object', () => {
    assert.equal(validateTemplateInput({ ...VALID, kpis: {} }).value.kpis, null);
    assert.equal(validateTemplateInput({ ...VALID, kpis: null }).value.kpis, null);
  });

  it('round-trips timeframes and tickers through JSON storage, uppercasing tickers', () => {
    const t = make();
    assert.deepEqual(t.timeframes, ['15', '30']);
    assert.deepEqual(t.tickers, ['SOXL', 'TNA']);
    assert.equal(t.membership, true);
    assert.equal(t.status, 'active');
    assert.ok(t.created_at);
  });

  it('resolves by short_desc as well as by id', () => {
    const t = make();
    assert.equal(getTemplateByShortDesc('15M30M3').id, t.id);
    assert.equal(getTemplateByShortDesc('nope'), null);
  });
});

describe('template updates are partial and never rewrite the KPI snapshot', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('changes only the keys present in the body', () => {
    const t = make();
    const parsed = validateTemplateUpdate({ notes: 'watch fill rate' }, t);
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed.value), ['notes']);
    const updated = updateTemplate(t.id, parsed.value);
    assert.equal(updated.value.notes, 'watch fill rate');
    assert.equal(updated.value.short_desc, t.short_desc);
    assert.deepEqual(updated.value.kpis, t.kpis);
    assert.ok(updated.value.updated_at);
  });

  it('ignores a kpis key entirely — re-measuring means re-running the sim', () => {
    const t = make();
    const parsed = validateTemplateUpdate({ kpis: { expectancyPct: 99 }, notes: 'x' }, t);
    assert.equal(parsed.ok, true);
    assert.ok(!('kpis' in parsed.value));
    assert.deepEqual(updateTemplate(t.id, parsed.value).value.kpis, t.kpis);
  });

  it('rejects an empty patch instead of writing a no-op', () => {
    const t = make();
    assert.equal(validateTemplateUpdate({}, t).ok, false);
  });

  it('clears the account on an explicit blank but leaves it alone when the key is absent', () => {
    const t = make();
    assert.equal(validateTemplateUpdate({ account: '' }, t).value.account, null);
    assert.ok(!('account' in validateTemplateUpdate({ notes: 'x' }, t).value));
  });

  it('refuses a duplicate short_desc on update, same as on create', () => {
    make();
    const other = make({ name: 'Other', short_desc: 'other' });
    const parsed = validateTemplateUpdate({ short_desc: '15m30m3' }, other);
    assert.equal(parsed.ok, true);
    const updated = updateTemplate(other.id, parsed.value);
    assert.equal(updated.ok, false);
    assert.equal(updated.status, 409);
  });

  it('rejects an unknown status rather than coercing it', () => {
    const t = make();
    assert.equal(validateTemplateUpdate({ status: 'deleted' }, t).ok, false);
  });
});

describe('archiving preserves attribution', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('archives rather than deletes, and the row still resolves by id and short_desc', () => {
    const t = make();
    assert.equal(archiveTemplate(t.id).ok, true);
    const after = getTemplateById(t.id);
    assert.equal(after.status, 'archived');
    assert.equal(getTemplateByShortDesc('15m30m3').id, t.id);
  });

  it('drops out of the active list but stays in the all list', () => {
    const t = make();
    archiveTemplate(t.id);
    assert.equal(listTemplates({ status: 'active' }).length, 0);
    assert.equal(listTemplates({ status: 'all' }).length, 1);
  });

  it('leaves a position opened under it still pointing at it', () => {
    const t = make();
    const parsed = validateManualPositionInput({
      account: 'Fidelity IRA', symbol: 'aapl', timeframe: '15',
      qty: 10, entry_price: 150, stop_price: 140, template_id: t.id,
    });
    assert.equal(parsed.ok, true);
    const row = createManualPosition(parsed.value);
    assert.equal(row.template_id, t.id);
    archiveTemplate(t.id);
    assert.equal(getTemplateById(row.template_id).short_desc, '15m30m3');
  });
});

describe('manual_positions.template_id', () => {
  beforeEach(() => _resetManualLedgerForTests());

  const POS = { account: 'Fidelity IRA', symbol: 'aapl', timeframe: '15', qty: 10, entry_price: 150, stop_price: 140 };

  it('is optional — a hand-entered holding need not belong to a configuration', () => {
    const parsed = validateManualPositionInput(POS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.template_id, null);
    assert.equal(createManualPosition(parsed.value).template_id, null);
  });

  it('refuses a non-id rather than silently storing an unattributed position', () => {
    for (const bad of ['abc', 0, -1, 2.5]) {
      const parsed = validateManualPositionInput({ ...POS, template_id: bad });
      assert.equal(parsed.ok, false, `expected ${bad} to be refused`);
      assert.match(parsed.error, /template_id/);
    }
  });

  it('treats an empty string on UPDATE as a deliberate detach', () => {
    const t = make();
    const row = createManualPosition(validateManualPositionInput({ ...POS, template_id: t.id }).value);
    const parsed = validateManualPositionUpdate({ template_id: '' }, row);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.template_id, null);
  });

  it('leaves the stored value alone when the key is absent from the patch', () => {
    const t = make();
    const row = createManualPosition(validateManualPositionInput({ ...POS, template_id: t.id }).value);
    assert.ok(!('template_id' in validateManualPositionUpdate({ notes: 'x' }, row).value));
  });
});

describe('auto-dispatch resolution refuses to guess', () => {
  beforeEach(() => _resetManualLedgerForTests());

  it('resolves a timeframe claimed by exactly one active template', () => {
    const t = make();
    const r = resolveTemplateForTimeframe('15');
    assert.equal(r.template.id, t.id);
    assert.equal(r.ambiguous, false);
  });

  it('resolves nothing, and flags it, when two active templates claim the timeframe', () => {
    make();
    make({ name: 'Other', short_desc: 'other', timeframes: ['15', '45'] });
    const r = resolveTemplateForTimeframe('15');
    assert.equal(r.template, null);
    assert.equal(r.ambiguous, true);
    assert.equal(r.candidates.length, 2);
  });

  it('resolves nothing, without flagging, when no template covers the timeframe', () => {
    make();
    const r = resolveTemplateForTimeframe('240');
    assert.equal(r.template, null);
    assert.equal(r.ambiguous, false);
  });

  it('ignores archived templates, so archiving one RESOLVES a collision', () => {
    const a = make();
    make({ name: 'Other', short_desc: 'other', timeframes: ['15'] });
    assert.equal(resolveTemplateForTimeframe('15').ambiguous, true);
    archiveTemplate(a.id);
    assert.equal(resolveTemplateForTimeframe('15').template.short_desc, 'other');
  });

  it('reports every contested timeframe for the dashboard warning', () => {
    make();
    make({ name: 'Other', short_desc: 'other', timeframes: ['15', '30'] });
    const collisions = findTimeframeCollisions();
    assert.deepEqual(collisions.map((c) => c.timeframe).sort(), ['15', '30']);
    assert.equal(collisions[0].templates.length, 2);
  });

  it('returns no template for a blank timeframe rather than matching arbitrarily', () => {
    make();
    assert.equal(resolveTemplateForTimeframe('').template, null);
    assert.equal(resolveTemplateForTimeframe(null).template, null);
  });
});

describe('the payload stamp', () => {
  const BASE = { symbol: 'BATS:SOXL', side: 'LONG', timeframe: '15', price: 42.1, group: 'swing', secret: 's3cret' };

  it('leaves a market payload byte-for-byte unchanged when there is no template', () => {
    // The armed auto-send path never passes a template, and the executor's tolerance for
    // unrecognised keys is undocumented — an untagged order must never be what discovers it.
    assert.deepEqual(buildWebhookPayload(BASE), {
      symbol: 'SOXL', side: 'buy', group: 'swing', tag: '15m', price: '42.1', secret: 's3cret',
    });
    assert.deepEqual(buildWebhookPayload({ ...BASE, template: null }), buildWebhookPayload(BASE));
  });

  it('adds exactly two string fields when a template is attached', () => {
    const payload = buildWebhookPayload({ ...BASE, template: { template_id: 7, template: 'sw15m30' } });
    assert.equal(payload.template_id, '7');
    assert.equal(payload.template, 'sw15m30');
    // And nothing else moved.
    const { template_id, template, ...rest } = payload;
    assert.deepEqual(rest, buildWebhookPayload(BASE));
  });

  it('does NOT fold the template into the routing tag', () => {
    // tag selects the executor's strategy group; folding a template in would fragment one bucket
    // into one per template.
    const payload = buildWebhookPayload({ ...BASE, template: { template_id: 7, template: 'sw15m30' } });
    assert.equal(payload.tag, '15m');
  });

  it('accepts a raw template row as well as a prebuilt stamp', () => {
    const row = { id: 3, short_desc: 'abc', name: 'ignored', kpis: { cagr: 1 } };
    assert.deepEqual(normalizeTemplateStamp(row), { template_id: '3', template: 'abc' });
    const payload = buildWebhookPayload({ ...BASE, template: row });
    assert.equal(payload.template_id, '3');
    assert.equal(payload.template, 'abc');
    // The name and KPIs are deliberately NOT sent — a payload is not a place to duplicate a record
    // that already exists under a stable id.
    assert.ok(!('name' in payload));
    assert.ok(!('kpis' in payload));
  });

  it('emits nothing for a half-formed stamp rather than a partial one', () => {
    assert.equal(normalizeTemplateStamp(null), null);
    assert.equal(normalizeTemplateStamp({ template_id: 7 }), null);
    assert.equal(normalizeTemplateStamp({ template: 'abc' }), null);
    assert.equal(normalizeTemplateStamp({ template_id: '', template: 'abc' }), null);
  });

  it('templateStamp turns a stored row into the payload shape', () => {
    _resetManualLedgerForTests();
    const t = make();
    assert.deepEqual(templateStamp(t), { template_id: String(t.id), template: '15m30m3' });
    assert.equal(templateStamp(null), null);
  });
});

describe('staleness is reported, never repaired', () => {
  it('counts new trades against the snapshot and flags at the 50-trade threshold', () => {
    const t = { kpis: { signalsTaken: 184 } };
    assert.deepEqual(templateStaleness(t, 184), { known: true, newTrades: 0, stale: false });
    assert.deepEqual(templateStaleness(t, 233), { known: true, newTrades: 49, stale: false });
    assert.deepEqual(templateStaleness(t, 234), { known: true, newTrades: 50, stale: true });
  });

  it('never reports a negative drift when the log shrank (archived symbols)', () => {
    assert.deepEqual(templateStaleness({ kpis: { signalsTaken: 184 } }, 100), { known: true, newTrades: 0, stale: false });
  });

  it('reports unknown rather than guessing when either side is missing', () => {
    assert.equal(templateStaleness({ kpis: null }, 200).known, false);
    assert.equal(templateStaleness({ kpis: { signalsTaken: 10 } }, null).known, false);
  });
});
