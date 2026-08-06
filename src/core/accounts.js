/**
 * Brokerage account config (`accounts.json`) — the Manual Ledger's picklist, plus the equity and
 * allocation percentage that size a position in it.
 *
 * Two shapes are accepted for each entry and both mean an account:
 *
 *   "Fidelity IRA"                                        -> name only, no sizing
 *   { "name": "Fidelity IRA", "equity": 50000, "alloc_pct": 10 }  -> sized
 *
 * The bare-string form is what this file held before sizing existed, so an untouched config keeps
 * working and simply offers no auto-qty. Sizing is opt-in per account: an account with no equity or
 * no alloc_pct is not an error, it just leaves Qty to be typed by hand.
 *
 * NOTHING here is ever defaulted. A missing equity is not 0 and a missing alloc_pct is not 100 —
 * either substitution would silently size a real position off a number nobody entered, and this
 * project has been bitten before by a fallback that looked like a value (see the `scanned_at` entry
 * time in CLAUDE.md). An unusable value yields null plus a warning that reaches the UI.
 */

/** Above this, an alloc_pct is treated as a typo rather than a margin instruction. See below. */
export const MAX_ALLOC_PCT = 100;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Shares to buy for one position in an account: floor(equity * alloc% / entry price).
 *
 * Floor, never round: rounding up buys more than the allocation allows, and a fractional share is
 * not orderable everywhere this ledger records fills. Returns 0 — a real answer, not an error —
 * when the allocation cannot afford a single share; callers must distinguish that from null
 * (inputs unusable / sizing not configured), because 0 is a "this account is too small for this
 * symbol" message while null is "nothing to say".
 *
 * The toFixed(10) is float-dust protection: (50000 * 10) / 100 / 5 is exactly 1000 shares in
 * decimal but can land a hair under it in binary, and a bare Math.floor would quietly return 999.
 */
export function allocationQty(equity, allocPct, entryPrice) {
  const e = finitePositive(equity);
  const a = finitePositive(allocPct);
  const p = finitePositive(entryPrice);
  if (e == null || a == null || p == null) return null;
  if (a > MAX_ALLOC_PCT) return null;
  const shares = (e * a) / 100 / p;
  if (!Number.isFinite(shares)) return null;
  return Math.floor(Number(shares.toFixed(10)));
}

/** Dollars this account commits to one position, or null when it isn't sized. */
export function allocationNotional(equity, allocPct) {
  const e = finitePositive(equity);
  const a = finitePositive(allocPct);
  if (e == null || a == null || a > MAX_ALLOC_PCT) return null;
  return Math.round(((e * a) / 100) * 100) / 100;
}

/**
 * Read `accounts.json`'s contents into a normalized list.
 *
 * Returns { accounts, names, warnings }. `names` is the plain string list every existing caller
 * already uses (the picklist, and the server's "is this a known account" check on save) — keeping
 * it means adding sizing changed no validation path. `warnings` carries anything that was dropped:
 * a typo'd equity must be visible, because the alternative is a picklist that silently stops
 * offering an account or an auto-qty computed from a number the user did not write.
 */
export function normalizeAccounts(cfg) {
  const raw = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
  const accounts = [];
  const warnings = [];
  const seen = new Set();

  for (const entry of raw) {
    let name = null;
    let equity = null;
    let allocPct = null;

    if (typeof entry === 'string') {
      name = entry.trim();
    } else if (entry && typeof entry === 'object') {
      name = typeof entry.name === 'string' ? entry.name.trim() : '';

      if (!isBlank(entry.equity)) {
        equity = finitePositive(entry.equity);
        if (equity == null) warnings.push(`"${name || '(unnamed)'}": equity must be a positive number — ignored, Qty stays manual.`);
      }

      const rawAlloc = !isBlank(entry.alloc_pct) ? entry.alloc_pct : entry.allocPct;
      if (!isBlank(rawAlloc)) {
        allocPct = finitePositive(rawAlloc);
        if (allocPct == null) {
          warnings.push(`"${name || '(unnamed)'}": alloc_pct must be a positive number — ignored, Qty stays manual.`);
        } else if (allocPct > MAX_ALLOC_PCT) {
          // Refused rather than honoured: alloc_pct is a share of the account, so anything over
          // 100 is far likelier a typo (a fraction entered as basis points, an extra digit) than a
          // deliberate margin instruction — and honouring it would size a position at several
          // times the account. Split the position across accounts instead.
          warnings.push(`"${name || '(unnamed)'}": alloc_pct ${allocPct} is above ${MAX_ALLOC_PCT}% — ignored as a likely typo, Qty stays manual.`);
          allocPct = null;
        }
      }
    }

    if (!name) {
      warnings.push('Skipped an account entry with no name.');
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Duplicate account "${name}" — only the first is offered.`);
      continue;
    }
    seen.add(key);

    accounts.push({
      name,
      equity,
      allocPct,
      notional: allocationNotional(equity, allocPct),
      // A single flag the UI can branch on, so "can this account auto-size" is decided here rather
      // than re-derived from two nullable fields at every call site.
      sizing: equity != null && allocPct != null,
    });
  }

  return { accounts, names: accounts.map((a) => a.name), warnings };
}
