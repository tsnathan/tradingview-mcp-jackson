import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeAccounts, allocationQty, allocationNotional, MAX_ALLOC_PCT } from '../src/core/accounts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('allocationQty', () => {
  it('floors to whole shares', () => {
    // 50000 * 10% = 5000; 5000 / 144.36 = 34.63 -> 34
    assert.equal(allocationQty(50000, 10, 144.36), 34);
  });

  it('never rounds up, even a hair below the next share', () => {
    assert.equal(allocationQty(1000, 100, 100.01), 9);
  });

  it('survives binary float dust on an exact division', () => {
    // (50000 * 10) / 100 / 5 is exactly 1000 in decimal; a bare Math.floor on the binary result
    // is the classic way to hand back 999.
    assert.equal(allocationQty(50000, 10, 5), 1000);
    assert.equal(allocationQty(3000, 33.33, 9.999), 100);
  });

  it('returns 0 — a real answer — when the allocation cannot afford one share', () => {
    // Distinct from null: the caller shows "too small for this symbol" rather than "not configured".
    assert.equal(allocationQty(10000, 1, 500), 0);
  });

  it('returns null for unusable inputs rather than guessing', () => {
    assert.equal(allocationQty(null, 10, 100), null);
    assert.equal(allocationQty(50000, null, 100), null);
    assert.equal(allocationQty(50000, 10, null), null);
    assert.equal(allocationQty(50000, 10, 0), null);
    assert.equal(allocationQty(-5000, 10, 100), null);
    assert.equal(allocationQty(50000, 0, 100), null);
    assert.equal(allocationQty('abc', 10, 100), null);
    assert.equal(allocationQty(50000, 10, 'abc'), null);
  });

  it('refuses an allocation above 100% instead of sizing several times the account', () => {
    assert.equal(allocationQty(50000, MAX_ALLOC_PCT + 0.01, 100), null);
    assert.equal(allocationQty(50000, 5000, 100), null);
    assert.equal(allocationQty(50000, 100, 100), 500); // exactly 100% is fine
  });

  it('accepts numeric strings, since form values arrive as strings', () => {
    assert.equal(allocationQty('50000', '10', '144.36'), 34);
  });
});

describe('allocationNotional', () => {
  it('is the dollars committed to one position', () => {
    assert.equal(allocationNotional(50000, 10), 5000);
    assert.equal(allocationNotional(33333, 7.5), 2499.98);
  });

  it('is null when either half is missing or out of range', () => {
    assert.equal(allocationNotional(50000, null), null);
    assert.equal(allocationNotional(null, 10), null);
    assert.equal(allocationNotional(50000, 101), null);
  });
});

describe('normalizeAccounts', () => {
  it('accepts the legacy bare-string form with no sizing', () => {
    const { accounts, names, warnings } = normalizeAccounts({ accounts: ['Fidelity IRA', ' Schwab SN '] });
    assert.deepEqual(names, ['Fidelity IRA', 'Schwab SN']);
    assert.equal(accounts[0].equity, null);
    assert.equal(accounts[0].allocPct, null);
    assert.equal(accounts[0].sizing, false);
    assert.deepEqual(warnings, []);
  });

  it('reads equity and alloc_pct from the object form', () => {
    const { accounts, names } = normalizeAccounts({
      accounts: [{ name: 'Fidelity IRA', equity: 50000, alloc_pct: 10 }],
    });
    assert.deepEqual(names, ['Fidelity IRA']); // names stay bare — the save-time check compares them
    assert.deepEqual(accounts[0], {
      name: 'Fidelity IRA', equity: 50000, allocPct: 10, notional: 5000, sizing: true, defaultTemplate: null,
    });
  });

  it('mixes both forms in one file', () => {
    const { accounts, names } = normalizeAccounts({
      accounts: [{ name: 'A', equity: 1000, alloc_pct: 50 }, 'B'],
    });
    assert.deepEqual(names, ['A', 'B']);
    assert.equal(accounts[0].sizing, true);
    assert.equal(accounts[1].sizing, false);
  });

  it('also accepts allocPct as a camelCase alias', () => {
    const { accounts } = normalizeAccounts({ accounts: [{ name: 'A', equity: 1000, allocPct: 25 }] });
    assert.equal(accounts[0].allocPct, 25);
  });

  it('keeps an account offered when only one of the two sizing fields is set', () => {
    // Half-configured is not an error: the picklist must still list the account, it just
    // cannot auto-size. A missing equity is NOT 0 and a missing alloc_pct is NOT 100%.
    const { accounts, warnings } = normalizeAccounts({ accounts: [{ name: 'A', equity: 1000 }] });
    assert.equal(accounts[0].sizing, false);
    assert.equal(accounts[0].equity, 1000);
    assert.equal(accounts[0].allocPct, null);
    assert.deepEqual(warnings, []);
  });

  it('ignores an unusable equity or alloc_pct and says so', () => {
    const { accounts, warnings } = normalizeAccounts({
      accounts: [{ name: 'A', equity: 'lots', alloc_pct: -3 }],
    });
    assert.equal(accounts[0].sizing, false);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /equity must be a positive number/);
    assert.match(warnings[1], /alloc_pct must be a positive number/);
  });

  it('treats an alloc_pct above 100 as a typo, warns, and still offers the account', () => {
    const { accounts, names, warnings } = normalizeAccounts({
      accounts: [{ name: 'A', equity: 1000, alloc_pct: 1000 }],
    });
    assert.deepEqual(names, ['A']);
    assert.equal(accounts[0].allocPct, null);
    assert.equal(accounts[0].sizing, false);
    assert.match(warnings[0], /above 100%/);
  });

  it('skips nameless entries and duplicate names, reporting both', () => {
    const { names, warnings } = normalizeAccounts({
      accounts: [{ equity: 100, alloc_pct: 5 }, 'A', { name: 'a', equity: 1 }, '   '],
    });
    assert.deepEqual(names, ['A']);
    assert.equal(warnings.filter((w) => /no name/.test(w)).length, 2);
    assert.equal(warnings.filter((w) => /Duplicate/.test(w)).length, 1);
  });

  it('returns an empty list for a missing or malformed file rather than throwing', () => {
    for (const cfg of [null, undefined, {}, { accounts: 'nope' }, { accounts: [null, 42] }]) {
      const { accounts, names } = normalizeAccounts(cfg);
      assert.deepEqual(names, []);
      assert.deepEqual(accounts, []);
    }
  });
});

describe('normalizeAccounts: default_template', () => {
  it('captures a trimmed default_template, raw and unresolved', () => {
    // accounts.js has no reference to the templates module — resolving whether the short_desc
    // actually names a known, active template happens at the call site (serve_signal_status.js),
    // same boundary equity/alloc_pct validation already draws.
    const { accounts } = normalizeAccounts({
      accounts: [{ name: 'Fidelity IRA', default_template: '  30m45m1h10  ' }],
    });
    assert.equal(accounts[0].defaultTemplate, '30m45m1h10');
  });

  it('is null when absent, blank, or on the bare-string account form', () => {
    const { accounts } = normalizeAccounts({
      accounts: [
        { name: 'A', equity: 1000, alloc_pct: 10 },
        { name: 'B', default_template: '   ' },
        'C',
      ],
    });
    assert.equal(accounts[0].defaultTemplate, null);
    assert.equal(accounts[1].defaultTemplate, null);
    assert.equal(accounts[2].defaultTemplate, null);
  });
});

describe('the dashboard form and the module size identically', () => {
  /**
   * mlAllocQty is a deliberate second copy of allocationQty living in dashboard/index.html — the
   * Add-entry form re-sizes on every keystroke, which a server round trip cannot keep up with.
   * This test extracts the page's own copy and runs it against the module so the two cannot drift
   * apart silently, which is the failure mode CLAUDE.md keeps warning about for duplicated rules.
   */
  function loadPageCopy() {
    const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8');
    const start = html.indexOf('function mlAllocQty(');
    assert.notEqual(start, -1, 'mlAllocQty is missing from dashboard/index.html');
    let depth = 0;
    let end = -1;
    for (let i = html.indexOf('{', start); i < html.length; i += 1) {
      if (html[i] === '{') depth += 1;
      else if (html[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert.notEqual(end, -1, 'could not find the end of mlAllocQty');
    // eslint-disable-next-line no-new-func
    return new Function(`${html.slice(start, end)}; return mlAllocQty;`)();
  }

  it('agrees on every case the module is tested for', () => {
    const mlAllocQty = loadPageCopy();
    const cases = [
      [50000, 10, 144.36], [1000, 100, 100.01], [50000, 10, 5], [3000, 33.33, 9.999],
      [10000, 1, 500], [50000, 100, 100], [50000, 100.01, 100], [50000, 5000, 100],
      ['50000', '10', '144.36'], [null, 10, 100], [50000, null, 100], [50000, 10, null],
      [50000, 10, 0], [-5000, 10, 100], [50000, 0, 100], ['abc', 10, 100], [50000, 10, 'abc'],
      [1e9, 0.0001, 0.01], [7, 3, 1000],
    ];
    for (const [equity, alloc, price] of cases) {
      assert.equal(
        mlAllocQty(equity, alloc, price),
        allocationQty(equity, alloc, price),
        `mlAllocQty(${equity}, ${alloc}, ${price}) disagrees with allocationQty`,
      );
    }
  });
});

describe('the shipped config files parse', () => {
  it('accounts.example.json normalizes, exercising both entry forms', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'accounts.example.json'), 'utf8'));
    const { accounts, warnings } = normalizeAccounts(cfg);
    assert.equal(warnings.length, 0);
    assert.ok(accounts.some((a) => a.sizing), 'the example should show a sized account');
    assert.ok(accounts.some((a) => !a.sizing), 'the example should show the bare-name form too');
    assert.ok(accounts.some((a) => a.defaultTemplate), 'the example should show default_template');
  });
});
