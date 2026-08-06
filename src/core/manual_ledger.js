/**
 * Manual ledger — positions held in brokerage accounts the automated pipeline never touches.
 *
 * The scanner (trade_webhook.js -> Railway executor) only knows about orders it placed itself.
 * This module records the rest: a hand-entered open position, its stop/target, and the account
 * holding it, so the same exit-notification machinery (a real TradingView price alert plus an
 * ntfy push when a level is crossed) can watch it.
 *
 * Pure SQLite + validation. No CDP, no HTTP — the alert creation and quote polling live in
 * serve_signal_status.js and morning.js respectively, matching how trade_webhook.js keeps its
 * ledger logic separate from the code that sends anything.
 *
 * Validation returns { ok, error } rather than throwing, same shape as validateOrderSpec in
 * trade_webhook.js, so an HTTP handler can turn a failure straight into a 400.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');
export const MANUAL_LEDGER_DB_PATH = join(PROJECT_ROOT, 'data', 'manual-ledger.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS manual_positions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account            TEXT NOT NULL,
  symbol             TEXT NOT NULL,
  qty                REAL NOT NULL,
  entry_price        REAL NOT NULL,
  stop_price         REAL,
  target_price       REAL,
  timeframe          TEXT NOT NULL,
  side               TEXT NOT NULL DEFAULT 'LONG' CHECK (side IN ('LONG','SHORT')),
  levels_source      TEXT,
  notes              TEXT,
  entered_at         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  exit_price         REAL,
  closed_at          TEXT,
  stop_alert_id      TEXT,
  target_alert_id    TEXT,
  tv_alert_status    TEXT,
  exit_alert_level   TEXT,
  exit_alert_fired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_positions_status ON manual_positions(status);
`;

let db = null;
let dbPathOverride = null; // test-only

/**
 * Extra schema statements contributed by sibling modules that live in this same database file.
 *
 * sim_templates.js registers its table here rather than opening a second DatabaseSync on the same
 * path: two connections to one SQLite file from a single process can collide on write locks, and a
 * separate file would put the template rows out of reach of a foreign key from manual_positions.
 * Registration must happen at import time (module top level), before the first getDb() call.
 */
const schemaExtensions = [];
export function registerLedgerSchema(sql) {
  schemaExtensions.push(sql);
  // If the connection is already open, apply immediately — the statements are all IF NOT EXISTS /
  // additive, so running them twice is a no-op and import order stops being load-bearing.
  if (db) db.exec(sql);
}

/**
 * The shared connection for every table in this database file. Exported so sim_templates.js can use
 * it without duplicating the open/migrate dance or the test-reset plumbing.
 */
export function getLedgerDb() {
  return getDb();
}

function getDb() {
  if (db) return db;
  const path = dbPathOverride || MANUAL_LEDGER_DB_PATH;
  // DatabaseSync does NOT create parent directories — it throws on a missing one.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  for (const sql of schemaExtensions) db.exec(sql);
  migrate(db);
  return db;
}

/**
 * Additive column migrations for a table created by an earlier version.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op once the file exists, so a column added to SCHEMA_SQL never
 * reaches an existing database on its own. Each entry is ADD COLUMN only — never a rewrite — so a
 * ledger recorded before the column existed keeps every row and picks up the default.
 */
function migrate(d) {
  const have = new Set(d.prepare('PRAGMA table_info(manual_positions)').all().map((c) => c.name));
  const additions = [
    // `side` arrived with Portfolio Analytics: without it a SHORT's realized P&L computes with the
    // sign of a long. Existing rows default to LONG, which is what they were recorded as.
    ["side", "ALTER TABLE manual_positions ADD COLUMN side TEXT NOT NULL DEFAULT 'LONG'"],
    // Which Sim Template this position was opened under, so a book can be attributed back to the
    // simulated configuration that justified it. Nullable and NOT back-filled: every row predating
    // templates was opened without one, and guessing which template "would have" produced it would
    // invent an attribution nobody made. No FK constraint — a template deleted after the fact must
    // not cascade into rewriting position history; the join is resolved in the reader instead.
    ["template_id", "ALTER TABLE manual_positions ADD COLUMN template_id INTEGER"],
  ];
  for (const [col, sql] of additions) {
    if (!have.has(col)) d.exec(sql);
  }
}

/** Test-only: fresh in-memory DB, drops the cached connection. Never called from production code. */
export function _resetManualLedgerForTests(path = ':memory:') {
  if (db) { try { db.close(); } catch {} }
  db = null;
  dbPathOverride = path;
}

function positive(n) { return Number.isFinite(Number(n)) && Number(n) > 0; }

/**
 * A template id from a request body: null when absent/blank/cleared, the number when usable, and
 * `false` — distinct from null — when present but unusable, so the caller can refuse rather than
 * silently storing an unattributed position under a value the user meant to set.
 */
function parseTemplateId(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.trunc(n) !== n) return false;
  return n;
}

export function validateManualPositionInput(body) {
  const account = String(body?.account ?? '').trim();
  const symbol = String(body?.symbol ?? '').trim().toUpperCase();
  const timeframe = String(body?.timeframe ?? '').trim();
  if (!account) return { ok: false, error: 'account is required' };
  if (!symbol) return { ok: false, error: 'symbol is required' };
  // Required, never defaulted: it becomes the TradingView alert's resolution and is what any
  // per-timeframe ntfy gate keys on, so a silent fallback would make both quietly wrong.
  if (!timeframe) return { ok: false, error: 'timeframe is required' };
  if (!positive(body?.qty)) return { ok: false, error: 'qty must be a positive number' };
  if (!positive(body?.entry_price)) return { ok: false, error: 'entry_price must be a positive number' };

  const stopPrice = body?.stop_price != null && body.stop_price !== '' ? Number(body.stop_price) : null;
  const targetPrice = body?.target_price != null && body.target_price !== '' ? Number(body.target_price) : null;
  if (stopPrice != null && !positive(stopPrice)) return { ok: false, error: 'stop_price must be a positive number' };
  if (targetPrice != null && !positive(targetPrice)) return { ok: false, error: 'target_price must be a positive number' };
  // At least one level must exist — they are the only thing the exit check and the backup
  // TradingView alert have to watch for. An entry with neither would silently never notify.
  if (stopPrice == null && targetPrice == null) {
    return { ok: false, error: 'at least one of stop_price or target_price is required' };
  }

  const enteredAt = body?.entered_at ? new Date(body.entered_at) : new Date();
  if (Number.isNaN(enteredAt.getTime())) return { ok: false, error: 'entered_at is not a valid date' };

  // Defaults to LONG — the overwhelmingly common case for a hand-recorded holding, and what every
  // row predating this field was. Only the sign of realized P&L depends on it.
  const side = String(body?.side ?? 'LONG').trim().toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';

  // Which Sim Template this position is being opened under. Optional — a hand-entered holding need
  // not belong to a simulated configuration. That the template EXISTS is checked by the caller, not
  // here: this module owns no reference to sim_templates.js (which imports this one for the shared
  // database connection), so the existence check lives at the HTTP layer alongside the account one.
  const templateId = parseTemplateId(body?.template_id);
  if (templateId === false) return { ok: false, error: 'template_id must be a positive whole number' };

  return {
    ok: true,
    value: {
      account,
      symbol,
      timeframe,
      side,
      template_id: templateId,
      qty: Number(body.qty),
      entry_price: Number(body.entry_price),
      stop_price: stopPrice,
      target_price: targetPrice,
      // Records whether the saved levels came from the strategy's excursion stats, a percentage
      // fallback, or were typed by hand — so a later reader can tell a measured level from a guess.
      levels_source: body?.levels_source ? String(body.levels_source).trim() : 'manual',
      notes: body?.notes ? String(body.notes).trim().slice(0, 2000) : null,
      entered_at: enteredAt.toISOString(),
    },
  };
}

export function createManualPosition(value) {
  const info = getDb().prepare(`
    INSERT INTO manual_positions
      (account, symbol, qty, entry_price, stop_price, target_price, timeframe, side, levels_source, notes, entered_at, template_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(
    value.account, value.symbol, value.qty, value.entry_price, value.stop_price,
    value.target_price, value.timeframe, value.side, value.levels_source, value.notes, value.entered_at,
    value.template_id ?? null,
  );
  return getManualPositionById(info.lastInsertRowid);
}

export function listManualPositions({ status = 'all' } = {}) {
  const d = getDb();
  if (status === 'open' || status === 'closed') {
    return d.prepare('SELECT * FROM manual_positions WHERE status = ? ORDER BY entered_at DESC').all(status);
  }
  return d.prepare('SELECT * FROM manual_positions ORDER BY entered_at DESC').all();
}

export function getManualPositionById(id) {
  return getDb().prepare('SELECT * FROM manual_positions WHERE id = ?').get(Number(id)) || null;
}

export function markManualPositionAlertCreated(id, { stop_alert_id = null, target_alert_id = null, tv_alert_status }) {
  getDb().prepare('UPDATE manual_positions SET stop_alert_id = ?, target_alert_id = ?, tv_alert_status = ? WHERE id = ?')
    .run(
      stop_alert_id == null ? null : String(stop_alert_id),
      target_alert_id == null ? null : String(target_alert_id),
      tv_alert_status ?? null,
      Number(id),
    );
  return getManualPositionById(id);
}

/**
 * Record the outcome of deleting a position's backup alerts at TradingView.
 *
 * The alert ids are cleared only on a confirmed delete. Leaving them on a FAILED delete is the
 * point: they are the only handle on an alert that is still live in TradingView, and clearing them
 * would strand it there with nothing left in this database able to name it. `tv_alert_status` then
 * carries `deleted` or `delete_failed`, so "the alerts are gone" and "we tried and could not" stay
 * distinguishable — a closed row still reading `created` cannot tell you which happened.
 */
export function markManualPositionAlertsDeleted(id, { ok, reason = null } = {}) {
  if (ok) {
    getDb().prepare(`
      UPDATE manual_positions
      SET stop_alert_id = NULL, target_alert_id = NULL, tv_alert_status = 'deleted'
      WHERE id = ?
    `).run(Number(id));
  } else {
    getDb().prepare("UPDATE manual_positions SET tv_alert_status = 'delete_failed' WHERE id = ?")
      .run(Number(id));
    if (reason) console.error(`[manual-ledger] alert delete failed for position ${id}: ${reason}`);
  }
  return getManualPositionById(id);
}

/**
 * Validate a PARTIAL edit of an open position. Only keys actually present in the body are changed,
 * so editing one field can never silently reset another to a default — the add form's validator
 * takes a whole entry and defaults what's missing, which is the wrong shape for a patch.
 *
 * `existing` is required because two of the rules are cross-field: "at least one of stop/target"
 * has to hold on the MERGED row, not on the patch, and a blank stop is only clearable when a target
 * survives it. Returns { ok, error } like every other validator here so a handler can 400 directly.
 */
export function validateManualPositionUpdate(body, existing) {
  if (!existing) return { ok: false, error: 'not found' };
  if (existing.status !== 'open') return { ok: false, error: 'only an open position can be edited' };

  const has = (k) => body != null && Object.prototype.hasOwnProperty.call(body, k);
  const patch = {};

  if (has('account')) {
    const account = String(body.account ?? '').trim();
    if (!account) return { ok: false, error: 'account is required' };
    patch.account = account;
  }
  if (has('symbol')) {
    const symbol = String(body.symbol ?? '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol is required' };
    patch.symbol = symbol;
  }
  if (has('timeframe')) {
    const timeframe = String(body.timeframe ?? '').trim();
    if (!timeframe) return { ok: false, error: 'timeframe is required' };
    patch.timeframe = timeframe;
  }
  if (has('side')) {
    patch.side = String(body.side ?? '').trim().toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  }
  if (has('qty')) {
    if (!positive(body.qty)) return { ok: false, error: 'qty must be a positive number' };
    patch.qty = Number(body.qty);
  }
  if (has('entry_price')) {
    if (!positive(body.entry_price)) return { ok: false, error: 'entry_price must be a positive number' };
    patch.entry_price = Number(body.entry_price);
  }
  // An empty string clears a level (the input was blanked); null/undefined never reaches here
  // because `has` gates on the key being present at all.
  for (const field of ['stop_price', 'target_price']) {
    if (!has(field)) continue;
    if (body[field] === '' || body[field] === null) { patch[field] = null; continue; }
    if (!positive(body[field])) return { ok: false, error: `${field} must be a positive number` };
    patch[field] = Number(body[field]);
  }
  if (has('entered_at')) {
    const d = new Date(body.entered_at);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'entered_at is not a valid date' };
    patch.entered_at = d.toISOString();
  }
  if (has('notes')) {
    const notes = String(body.notes ?? '').trim();
    patch.notes = notes ? notes.slice(0, 2000) : null;
  }
  if (has('levels_source')) {
    patch.levels_source = body.levels_source ? String(body.levels_source).trim() : 'manual';
  }
  if (has('template_id')) {
    // An empty string or null detaches the template — a position can legitimately stop belonging to
    // a configuration. `false` here means the caller sent something that isn't an id at all.
    const templateId = parseTemplateId(body.template_id);
    if (templateId === false) return { ok: false, error: 'template_id must be a positive whole number' };
    patch.template_id = templateId;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };

  const merged = { ...existing, ...patch };
  // Same invariant the add form enforces, checked on the merged row: the levels are the only thing
  // the exit check and the backup alert have to watch, so an edit must not be able to leave a
  // position with neither and silently stop notifying.
  if (merged.stop_price == null && merged.target_price == null) {
    return { ok: false, error: 'at least one of stop_price or target_price is required' };
  }

  // Whether the backup alerts still describe this position. Any of these four changing means the
  // live TradingView alerts are now watching the wrong instrument or the wrong level, so the caller
  // has to tear them down and recreate rather than leave a stale alert firing.
  const alertsAffected = ['symbol', 'timeframe', 'stop_price', 'target_price']
    .filter((f) => Object.prototype.hasOwnProperty.call(patch, f) && merged[f] !== existing[f]);

  return { ok: true, value: patch, alertsAffected };
}

export function updateManualPosition(id, patch) {
  const existing = getManualPositionById(id);
  if (!existing) return { ok: false, error: 'not found', status: 404 };
  if (existing.status !== 'open') return { ok: false, error: 'only an open position can be edited', status: 409 };
  const fields = Object.keys(patch);
  if (fields.length === 0) return { ok: false, error: 'nothing to update', status: 400 };
  // Column names come from the validator's own allowlist above, never from raw request keys, so the
  // interpolation here cannot carry anything the caller supplied.
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  getDb().prepare(`UPDATE manual_positions SET ${setClause} WHERE id = ?`)
    .run(...fields.map((f) => patch[f]), Number(existing.id));
  return { ok: true, value: getManualPositionById(existing.id) };
}

export function markManualPositionExitAlerted(id, { level, firedAt }) {
  getDb().prepare('UPDATE manual_positions SET exit_alert_level = ?, exit_alert_fired_at = ? WHERE id = ?')
    .run(level, firedAt, Number(id));
  return getManualPositionById(id);
}

export function validateManualCloseInput(body) {
  if (!positive(body?.exit_price)) return { ok: false, error: 'exit_price must be a positive number' };
  // The dashboard pre-fills today's date but leaves it editable, so a back-dated close must be
  // accepted. Only reject something that isn't a date at all.
  let closedAt;
  if (body?.closed_at) {
    const d = new Date(body.closed_at);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'closed_at is not a valid date' };
    closedAt = d.toISOString();
  } else {
    closedAt = new Date().toISOString();
  }
  return { ok: true, value: { exit_price: Number(body.exit_price), closed_at: closedAt } };
}

export function closeManualPosition(id, { exit_price, closed_at }) {
  const existing = getManualPositionById(id);
  if (!existing) return { ok: false, error: 'not found', status: 404 };
  if (existing.status === 'closed') return { ok: false, error: 'already closed', status: 409 };
  getDb().prepare('UPDATE manual_positions SET status = ?, exit_price = ?, closed_at = ? WHERE id = ?')
    .run('closed', exit_price, closed_at, existing.id);
  return { ok: true, value: getManualPositionById(existing.id) };
}
