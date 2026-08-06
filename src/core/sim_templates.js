/**
 * Sim Templates — a Portfolio Sim configuration, frozen with the KPIs that justified it, tied to a
 * brokerage account, and carried on every order placed under it.
 *
 * The problem this solves: the Portfolio Sim answers "which timeframes, how many slots, which
 * universe" and the answer lives nowhere afterwards. A position opened on the strength of a
 * particular sweep row is indistinguishable a month later from one opened on a hunch, so a book can
 * never be attributed back to the configuration it was supposed to be running. A template records
 * the decision, and `short_desc` rides along in the webhook payload and the manual ledger so the
 * attribution survives at the executor too.
 *
 * TWO FIELDS ARE LOAD-BEARING AND THE REST IS DOCUMENTATION:
 *   - `short_desc` (<= 10 chars) is an IDENTIFIER, not a label. It goes into a real order payload,
 *     is echoed into the executor's records, and is what a human reads back off a fill. It is
 *     therefore charset-restricted and UNIQUE, for the same reasons normalizeWebhookTag() restricts
 *     the routing tag: a value carrying whitespace or punctuation silently fragments whatever groups
 *     by it, and a duplicate makes the attribution ambiguous exactly where it is needed.
 *   - `timeframes` + `max_positions` are what the template MEANS. Everything else in `config` is
 *     reproducibility detail.
 *
 * The KPI snapshot is stored VERBATIM as measured, never recomputed on read. The trade log grows
 * continuously, so recomputing would silently restate the numbers the decision was made on — the
 * template would then agree with today's data and disagree with its own history. Staleness is
 * reported (see `templateStaleness`), never repaired, matching how the Sweet Spot tab treats a
 * stored sweep.
 *
 * Storage is the manual-ledger SQLite file, via the shared connection registerLedgerSchema/
 * getLedgerDb expose — see the comment there for why this is not its own database.
 *
 * Validation returns { ok, error } rather than throwing, the shape every other validator in this
 * project uses, so an HTTP handler can turn a failure straight into a 400.
 */
import { getLedgerDb, registerLedgerSchema } from './manual_ledger.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sim_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  short_desc     TEXT NOT NULL,
  account        TEXT,
  timeframes     TEXT NOT NULL,
  max_positions  INTEGER NOT NULL,
  capital        REAL,
  universe       TEXT,
  tickers        TEXT,
  rule_type      TEXT,
  priority       TEXT,
  commission     REAL,
  membership     INTEGER NOT NULL DEFAULT 1,
  kpis           TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_templates_short_desc ON sim_templates(LOWER(short_desc));
CREATE INDEX IF NOT EXISTS idx_sim_templates_status ON sim_templates(status);
`;

registerLedgerSchema(SCHEMA_SQL);

/** Hard cap on `short_desc`. The user's spec, and it has to fit a fill confirmation legibly. */
export const SHORT_DESC_MAX = 10;

/**
 * KPI keys carried in the snapshot, in display order. Kept as an explicit list rather than "whatever
 * the caller sent" so the Templates tab can render a stable table, and so a KPI the sweep stops
 * producing shows as an em dash rather than silently vanishing from old rows.
 */
export const TEMPLATE_KPI_FIELDS = [
  { key: 'expectancyPct', label: 'exp %/trade', kind: 'pct2' },
  { key: 'winLossRatio', label: 'avg W/L', kind: 'mult' },
  { key: 'expectancyUsd', label: 'exp $/trade', kind: 'usd' },
  { key: 'avgWinUsd', label: 'avg win', kind: 'usd' },
  { key: 'avgLossUsd', label: 'avg loss', kind: 'usd' },
  { key: 'winRate', label: 'win%', kind: 'pct0' },
  { key: 'cagr', label: 'CAGR', kind: 'pct1' },
  { key: 'maxDrawdownPct', label: 'maxDD', kind: 'pct1' },
  { key: 'cagrDd', label: 'CAGR/DD', kind: 'num2' },
  { key: 'fillRate', label: 'fill%', kind: 'pct0' },
  { key: 'timeInMarketPct', label: 'in mkt%', kind: 'pct0' },
  { key: 'avgCapitalDeployedPct', label: 'deployed%', kind: 'pct0' },
  { key: 'signalsTaken', label: 'trades', kind: 'int' },
];

const KPI_KEYS = new Set(TEMPLATE_KPI_FIELDS.map((f) => f.key));

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Normalize `short_desc`. Lowercased and charset-restricted for the reasons in the module header —
 * this string is an identifier that leaves the process. Returns null for anything unusable so the
 * caller refuses rather than substituting; nothing here ever invents a value.
 */
export function normalizeShortDesc(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.length > SHORT_DESC_MAX) return null;
  if (!/^[a-z0-9_-]+$/.test(raw)) return null;
  return raw;
}

/**
 * A short_desc suggestion from a selection, for pre-filling the save form only. Never used as a
 * fallback on save: a template with an auto-generated identifier nobody chose would be unreadable on
 * the fill confirmation it exists to annotate.
 */
export function suggestShortDesc(timeframes, maxPositions) {
  const tfs = (Array.isArray(timeframes) ? timeframes : []).map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const slots = Number(maxPositions);
  const suffix = Number.isFinite(slots) && slots > 0 ? String(Math.trunc(slots)) : '';
  // Build up while it fits, then trim: a truncated middle timeframe ("15m3" from 15m+30m) would read
  // as a timeframe that was never selected, so whole segments are dropped instead.
  let out = '';
  for (const tf of tfs) {
    if (!tf) continue;
    const next = out ? `${out}${tf}` : tf;
    if (next.length + suffix.length > SHORT_DESC_MAX) break;
    out = next;
  }
  const joined = `${out}${suffix}`;
  return normalizeShortDesc(joined) || null;
}

/** Timeframes are stored as JSON; every read path goes through this so a torn value cannot throw. */
function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keep only recognised, finite KPI values. A KPI arriving as a string, NaN or Infinity is dropped
 * rather than stored: the snapshot is the evidence for a decision, and a stored "Infinity" would
 * render as a real number and sort above every honest row.
 */
function sanitizeKpis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KPI_KEYS.has(k)) continue;
    const n = finite(v);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate a new template. `knownAccounts` (from accounts.json) is required when an account is
 * given: a template naming an account that does not exist would size and attribute positions to
 * nothing, and the manual ledger's own save already refuses unknown accounts for the same reason.
 */
export function validateTemplateInput(body, { knownAccounts = null } = {}) {
  const name = String(body?.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 80) return { ok: false, error: 'name must be 80 characters or fewer' };

  const shortDesc = normalizeShortDesc(body?.short_desc);
  if (!shortDesc) {
    return {
      ok: false,
      error: `short_desc is required: up to ${SHORT_DESC_MAX} characters, letters/digits/dash/underscore only (it is sent with real orders)`,
    };
  }

  const timeframes = (Array.isArray(body?.timeframes) ? body.timeframes : [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (!timeframes.length) return { ok: false, error: 'at least one timeframe is required' };

  const maxPositions = Number(body?.max_positions);
  if (!Number.isFinite(maxPositions) || maxPositions < 1 || Math.trunc(maxPositions) !== maxPositions) {
    return { ok: false, error: 'max_positions must be a whole number of at least 1' };
  }

  let account = null;
  if (!isBlank(body?.account)) {
    account = String(body.account).trim();
    if (Array.isArray(knownAccounts) && !knownAccounts.includes(account)) {
      return { ok: false, error: `Unknown account "${account}" — add it to accounts.json first` };
    }
  }

  const tickers = Array.isArray(body?.tickers)
    ? body.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : null;

  return {
    ok: true,
    value: {
      name,
      short_desc: shortDesc,
      account,
      timeframes,
      max_positions: maxPositions,
      capital: finite(body?.capital),
      // Which universe rule produced `tickers` ("all" / "top20" / "blend" / "custom"). Recorded
      // because the ticker list alone cannot say whether it was a rule's output or hand-picked, and
      // re-deriving a Top-20 later would produce a different list against a grown trade log.
      universe: isBlank(body?.universe) ? null : String(body.universe).trim(),
      tickers: tickers && tickers.length ? tickers : null,
      rule_type: isBlank(body?.rule_type) ? null : String(body.rule_type).trim(),
      priority: isBlank(body?.priority) ? null : String(body.priority).trim(),
      commission: finite(body?.commission),
      membership: body?.membership === false ? 0 : 1,
      kpis: sanitizeKpis(body?.kpis),
      notes: isBlank(body?.notes) ? null : String(body.notes).trim().slice(0, 4000),
    },
  };
}

/** Shape a stored row for a caller: JSON columns parsed, integers back to booleans. */
function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    timeframes: parseJsonArray(row.timeframes),
    tickers: row.tickers ? parseJsonArray(row.tickers) : null,
    kpis: parseJsonObject(row.kpis),
    membership: row.membership !== 0,
  };
}

export function createTemplate(value) {
  const db = getLedgerDb();
  const now = new Date().toISOString();
  let info;
  try {
    info = db.prepare(`
      INSERT INTO sim_templates
        (name, short_desc, account, timeframes, max_positions, capital, universe, tickers,
         rule_type, priority, commission, membership, kpis, notes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      value.name, value.short_desc, value.account, JSON.stringify(value.timeframes),
      value.max_positions, value.capital, value.universe,
      value.tickers ? JSON.stringify(value.tickers) : null,
      value.rule_type, value.priority, value.commission, value.membership ? 1 : 0,
      value.kpis ? JSON.stringify(value.kpis) : null, value.notes, now,
    );
  } catch (err) {
    // The unique index is the enforcement point, not a pre-check: a read-then-write would race, and
    // short_desc's whole purpose is being an unambiguous identifier in someone else's records.
    if (String(err?.message || '').includes('UNIQUE')) {
      return { ok: false, error: `short_desc "${value.short_desc}" is already used by another template`, status: 409 };
    }
    throw err;
  }
  return { ok: true, value: getTemplateById(info.lastInsertRowid) };
}

export function listTemplates({ status = 'active' } = {}) {
  const db = getLedgerDb();
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM sim_templates ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM sim_templates WHERE status = ? ORDER BY created_at DESC').all(status);
  return rows.map(hydrate);
}

export function getTemplateById(id) {
  const row = getLedgerDb().prepare('SELECT * FROM sim_templates WHERE id = ?').get(Number(id));
  return hydrate(row) || null;
}

export function getTemplateByShortDesc(shortDesc) {
  const norm = normalizeShortDesc(shortDesc);
  if (!norm) return null;
  const row = getLedgerDb().prepare('SELECT * FROM sim_templates WHERE LOWER(short_desc) = ?').get(norm);
  return hydrate(row) || null;
}

/**
 * Validate a PARTIAL edit. Only keys present in the body change — same contract as
 * validateManualPositionUpdate, and for the same reason: the dashboard posts whole rows, so editing
 * the notes must not be able to reset the account to a default.
 *
 * The KPI snapshot is deliberately NOT editable here. It is the measurement that justified the
 * template; hand-editing it would turn the record of a decision into an assertion about one.
 * Re-measuring means running the sim and saving again.
 */
export function validateTemplateUpdate(body, existing, { knownAccounts = null } = {}) {
  if (!existing) return { ok: false, error: 'not found' };
  const has = (k) => body != null && Object.prototype.hasOwnProperty.call(body, k);
  const patch = {};

  if (has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (name.length > 80) return { ok: false, error: 'name must be 80 characters or fewer' };
    patch.name = name;
  }
  if (has('short_desc')) {
    const sd = normalizeShortDesc(body.short_desc);
    if (!sd) {
      return {
        ok: false,
        error: `short_desc must be 1-${SHORT_DESC_MAX} characters, letters/digits/dash/underscore only`,
      };
    }
    patch.short_desc = sd;
  }
  if (has('account')) {
    if (isBlank(body.account)) {
      patch.account = null;
    } else {
      const account = String(body.account).trim();
      if (Array.isArray(knownAccounts) && !knownAccounts.includes(account)) {
        return { ok: false, error: `Unknown account "${account}" — add it to accounts.json first` };
      }
      patch.account = account;
    }
  }
  if (has('notes')) {
    const notes = String(body.notes ?? '').trim();
    patch.notes = notes ? notes.slice(0, 4000) : null;
  }
  if (has('status')) {
    const status = String(body.status ?? '').trim().toLowerCase();
    if (status !== 'active' && status !== 'archived') {
      return { ok: false, error: "status must be 'active' or 'archived'" };
    }
    patch.status = status;
  }
  if (has('max_positions')) {
    const mp = Number(body.max_positions);
    if (!Number.isFinite(mp) || mp < 1 || Math.trunc(mp) !== mp) {
      return { ok: false, error: 'max_positions must be a whole number of at least 1' };
    }
    patch.max_positions = mp;
  }
  if (has('capital')) patch.capital = finite(body.capital);
  if (has('timeframes')) {
    const tfs = (Array.isArray(body.timeframes) ? body.timeframes : []).map((t) => String(t).trim()).filter(Boolean);
    if (!tfs.length) return { ok: false, error: 'at least one timeframe is required' };
    patch.timeframes = JSON.stringify(tfs);
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
  return { ok: true, value: patch };
}

export function updateTemplate(id, patch) {
  const existing = getTemplateById(id);
  if (!existing) return { ok: false, error: 'not found', status: 404 };
  const fields = Object.keys(patch);
  if (!fields.length) return { ok: false, error: 'nothing to update', status: 400 };
  // Column names come from the validator's own allowlist above, never from raw request keys, so the
  // interpolation cannot carry anything the caller supplied.
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  try {
    getLedgerDb().prepare(`UPDATE sim_templates SET ${setClause}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((f) => patch[f]), new Date().toISOString(), Number(existing.id));
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) {
      return { ok: false, error: `short_desc "${patch.short_desc}" is already used by another template`, status: 409 };
    }
    throw err;
  }
  return { ok: true, value: getTemplateById(existing.id) };
}

/**
 * Archive rather than delete, always.
 *
 * A template id is stamped on manual-ledger rows and on ledger records at the executor. Deleting the
 * row would strand every one of those pointing at nothing — the attribution the template exists to
 * provide would be destroyed precisely for the configurations that stopped being used, which is the
 * history most worth keeping. Archived templates disappear from the pickers and from auto-dispatch
 * resolution but still resolve by id and by short_desc.
 */
export function archiveTemplate(id) {
  return updateTemplate(id, { status: 'archived' });
}

/**
 * The template that applies to an automatically dispatched signal on `timeframe`, or null.
 *
 * Resolution is EXACT-ONE-MATCH among active templates, and deliberately refuses to guess:
 *   - no active template covers the timeframe -> null (the payload is unchanged from today);
 *   - exactly one covers it -> that template;
 *   - more than one covers it -> null, plus `ambiguous`, because there is no basis to pick between
 *     two configurations that both claim the same timeframe, and stamping the wrong template id on a
 *     real order is worse than stamping none. The Templates tab surfaces the collision so it is
 *     visible rather than a silent stop.
 *
 * Returns { template, ambiguous, candidates } so a caller can log why nothing was attached.
 */
export function resolveTemplateForTimeframe(timeframe, templates = null) {
  const tf = String(timeframe ?? '').trim();
  if (!tf) return { template: null, ambiguous: false, candidates: [] };
  const all = templates || listTemplates({ status: 'active' });
  const candidates = all.filter((t) => t.status === 'active' && t.timeframes.map(String).includes(tf));
  if (candidates.length === 1) return { template: candidates[0], ambiguous: false, candidates };
  return { template: null, ambiguous: candidates.length > 1, candidates };
}

/**
 * Every timeframe claimed by more than one active template, for the Templates tab's warning.
 * Ambiguity is not an error — two templates may legitimately cover 15m for different accounts — but
 * it does silently disable auto-dispatch tagging for that timeframe, so it has to be visible.
 */
export function findTimeframeCollisions(templates = null) {
  const all = (templates || listTemplates({ status: 'active' })).filter((t) => t.status === 'active');
  const byTf = new Map();
  for (const t of all) {
    for (const tf of t.timeframes.map(String)) {
      if (!byTf.has(tf)) byTf.set(tf, []);
      byTf.get(tf).push({ id: t.id, name: t.name, short_desc: t.short_desc });
    }
  }
  return [...byTf.entries()]
    .filter(([, ts]) => ts.length > 1)
    .map(([timeframe, ts]) => ({ timeframe, templates: ts }));
}

/**
 * The template fields that ride along on a webhook payload and a ledger record.
 *
 * Two fields only, both strings: the id for machine attribution and the short_desc for a human
 * reading a fill. `name` and the KPI snapshot are deliberately excluded — they are long, they change
 * when the template is edited, and a payload is not a place to duplicate a record that already
 * exists here under a stable id.
 */
export function templateStamp(template) {
  if (!template) return null;
  return { template_id: String(template.id), template: template.short_desc };
}

/**
 * Whether a stored KPI snapshot still describes the current trade log. Reported, never acted on —
 * the same rule the Sweet Spot tab follows for a stored sweep: nothing auto-reruns a measurement,
 * because a template that quietly restated itself would agree with today's data and disagree with
 * the decision it recorded.
 *
 * `currentTradeCount` is the number of rows the template's own selection covers today.
 */
export function templateStaleness(template, currentTradeCount) {
  const taken = template?.kpis?.signalsTaken;
  if (!Number.isFinite(taken) || !Number.isFinite(currentTradeCount)) {
    return { known: false, newTrades: null, stale: false };
  }
  const newTrades = Math.max(0, currentTradeCount - taken);
  // 50 matches the Sweet Spot tab's threshold, so "stale" means one thing across the dashboard.
  return { known: true, newTrades, stale: newTrades >= 50 };
}
