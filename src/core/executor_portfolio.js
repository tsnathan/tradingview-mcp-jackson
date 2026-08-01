/**
 * Executor portfolio — read the Railway app's own positions and reconcile them against this
 * system's webhook ledger.
 *
 * WHY THIS IS THE SOURCE OF TRUTH: everything else here is inference. The scanner reads TradingView's
 * strategy output and records what it *sent*; the trade log records what the strategy *backtested*.
 * Neither knows what the broker actually holds or at what size. The executor does. So this module
 * treats the executor's response as authoritative and reports the *difference*, rather than trying to
 * decide which side is right.
 *
 * SHAPE-AGNOSTIC ON PURPOSE. The response schema wasn't known when this was written, so nothing here
 * requires a specific one: `pickArray` finds the positions list wherever it sits, and `pickField`
 * matches candidate key names after normalizing case/underscores/dashes. Anything that can't be
 * mapped is still returned verbatim in `raw` so the actual shape is visible in the UI — which is also
 * how you'd tighten this later. An unmapped field yields null; it is never guessed at from a
 * neighbouring field, because a wrong quantity or price reads as a real reconciliation break.
 *
 * SECRETS: same rule as the rest of the webhook code — URL and credential come from the environment
 * or the gitignored `webhook.local.json`, never `rules.json` (tracked in git), and never reach the
 * browser. The dashboard only ever sees the normalized result.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSentState, bareTicker, timeframeTag } from "./trade_webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const LOCAL_CONFIG_PATH = join(PROJECT_ROOT, "webhook.local.json");

/**
 * Portfolio endpoint config. Everything except the URL is optional with a defensible default, so the
 * common case is one line in `webhook.local.json`:
 *
 *   { "url": "...", "secret": "...", "portfolio_url": "https://app.up.railway.app/portfolio" }
 *
 * Auth mode defaults to `query` (`?secret=…`) because that's the GET analogue of how the webhook
 * already authenticates (a `secret` field in the POST body). If the endpoint wants something else,
 * set `portfolio_auth` to `bearer`, `header` (+ `portfolio_auth_header`), `body` (POST with a
 * `{secret}` JSON body, matching the webhook exactly), or `none`. A 401 is reported with its status
 * and body snippet rather than swallowed, so the right mode is one look away instead of a guess.
 */
export function loadPortfolioConfig() {
  let local = {};
  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      local = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, "utf8")) || {};
    } catch (err) {
      console.error(`[portfolio] ${LOCAL_CONFIG_PATH} is not valid JSON: ${err?.message || err}`);
    }
  }
  const url = process.env.TRADE_PORTFOLIO_URL || local.portfolio_url || null;
  // Falls back to the webhook secret: it's the same app and almost certainly the same credential.
  const secret = process.env.TRADE_PORTFOLIO_SECRET || local.portfolio_secret
    || process.env.TRADE_WEBHOOK_SECRET || local.secret || null;
  const auth = String(local.portfolio_auth || (secret ? "query" : "none")).toLowerCase();
  return {
    url,
    secret,
    auth,
    authHeader: local.portfolio_auth_header || "X-Api-Key",
    authParam: local.portfolio_auth_param || "secret",
    method: String(local.portfolio_method || (auth === "body" ? "POST" : "GET")).toUpperCase(),
    configured: Boolean(url),
  };
}

/** Normalize a key for matching: `avgEntryPrice`, `avg_entry_price`, `AVG-ENTRY-PRICE` all collide. */
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

/** First present, non-empty value among candidate key names. Never falls through to another field. */
function pickField(obj, candidates) {
  if (!obj || typeof obj !== "object") return null;
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(normKey(k), obj[k]);
  for (const cand of candidates) {
    const v = map.get(normKey(cand));
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Find the positions array wherever it lives: the top level, a named wrapper, or one level of
 * nesting. Deliberately does not recurse arbitrarily deep — a stray array of strings somewhere in a
 * bigger payload should not be mistaken for the position list.
 */
export function pickArray(payload) {
  if (Array.isArray(payload)) return { rows: payload, at: "$" };
  if (!payload || typeof payload !== "object") return { rows: [], at: null };
  const named = ["positions", "holdings", "portfolio", "openPositions", "open_positions", "data", "items", "results", "assets"];
  for (const key of Object.keys(payload)) {
    if (Array.isArray(payload[key]) && named.some((n) => normKey(n) === normKey(key))) {
      return { rows: payload[key], at: key };
    }
  }
  // Any array of objects at the top level, as a last resort before looking one level down.
  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") return { rows: v, at: key };
  }
  for (const key of Object.keys(payload)) {
    const v = payload[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = pickArray(v);
      if (inner.rows.length) return { rows: inner.rows, at: `${key}.${inner.at}` };
    }
  }
  return { rows: [], at: null };
}

/** One executor position, mapped as far as the response allows. `raw` always survives intact. */
export function normalizePosition(row) {
  if (!row || typeof row !== "object") return null;
  const symbolRaw = pickField(row, ["symbol", "ticker", "asset", "assetSymbol", "instrument", "sym", "name"]);
  const qty = num(pickField(row, ["qty", "quantity", "shares", "size", "positionSize", "position_qty", "amount", "units"]));
  const avgPrice = num(pickField(row, ["avgEntryPrice", "averageEntryPrice", "avgPrice", "averagePrice", "entryPrice", "costBasisPerShare", "basis", "price"]));
  const lastPrice = num(pickField(row, ["currentPrice", "lastPrice", "marketPrice", "last", "close"]));
  const marketValue = num(pickField(row, ["marketValue", "value", "notional", "positionValue", "equity"]));
  const unrealizedPl = num(pickField(row, ["unrealizedPl", "unrealizedPnl", "unrealizedProfit", "openPl", "openPnl", "pl", "pnl", "profit"]));
  const unrealizedPct = num(pickField(row, ["unrealizedPlpc", "unrealizedPlPct", "unrealizedPnlPct", "plPercent", "pnlPct", "returnPct"]));
  const sideRaw = pickField(row, ["side", "direction", "positionSide", "longShort"]);

  // Side from an explicit field when present, otherwise from the sign of the quantity — a negative
  // quantity is the near-universal encoding for a short, and it is not a guess about a *different*
  // field's meaning.
  let side = sideRaw ? String(sideRaw).toLowerCase() : null;
  if (!side && qty !== null) side = qty < 0 ? "short" : "long";
  if (side === "sell" || side === "sell_short") side = "short";
  if (side === "buy") side = "long";

  const value = marketValue !== null
    ? Math.abs(marketValue)
    : (qty !== null && (lastPrice ?? avgPrice) !== null ? Math.abs(qty) * (lastPrice ?? avgPrice) : null);

  return {
    symbol: symbolRaw ? String(symbolRaw) : null,
    ticker: symbolRaw ? bareTicker(symbolRaw).toUpperCase() : null,
    side,
    qty,
    avgPrice,
    lastPrice,
    marketValue: value,
    unrealizedPl,
    // Some APIs return a fraction (0.031), others a percent (3.1). Anything under ±1 in magnitude is
    // treated as a fraction — the alternative reading (a real ±0.03% move) is far less likely, and
    // both are labelled as percent in the UI so a wrong scale would be visible rather than silent.
    unrealizedPct: unrealizedPct === null ? null : (Math.abs(unrealizedPct) <= 1 ? unrealizedPct * 100 : unrealizedPct),
    raw: row,
  };
}

/** Open (entry recorded, no exit yet) ledger positions, grouped by bare ticker. */
export function openLedgerByTicker() {
  const sent = readSentState().sent || {};
  const byTicker = new Map();
  for (const [key, rec] of Object.entries(sent)) {
    if (rec?.exit) continue; // closed as far as this system knows
    // Key format is `TICKER|tag|entryTimeISO`; prefer the stored fields, fall back to the key.
    const parts = String(key).split("|");
    const ticker = bareTicker(rec?.symbol || parts[0] || "").toUpperCase();
    if (!ticker) continue;
    if (!byTicker.has(ticker)) byTicker.set(ticker, []);
    byTicker.get(ticker).push({
      key,
      ticker,
      tag: rec?.tag || parts[1] || null,
      side: rec?.side || null,
      price: rec?.price ?? null,
      source: rec?.source || null,
      at: rec?.at || null,
    });
  }
  return byTicker;
}

/**
 * Fetch the endpoint. Errors are returned, never thrown, and the HTTP status + body snippet come
 * back on failure — a 401 from the wrong auth mode has to be diagnosable from the dashboard, not
 * only from a server log.
 */
export async function fetchPortfolio(config, { timeoutMs = 10000 } = {}) {
  if (!config.configured) {
    return { success: false, error: 'No portfolio URL configured — add "portfolio_url" to webhook.local.json (or set TRADE_PORTFOLIO_URL)' };
  }
  let url;
  try {
    url = new URL(config.url);
  } catch {
    return { success: false, error: `portfolio_url is not a valid URL: ${config.url}` };
  }
  const headers = { Accept: "application/json" };
  let body;
  if (config.secret) {
    if (config.auth === "query") url.searchParams.set(config.authParam, config.secret);
    else if (config.auth === "bearer") headers.Authorization = `Bearer ${config.secret}`;
    else if (config.auth === "header") headers[config.authHeader] = config.secret;
    else if (config.auth === "body") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ secret: config.secret });
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: config.method, headers, body, signal: controller.signal });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      return {
        success: false,
        status: resp.status,
        error: `HTTP ${resp.status} ${resp.statusText}${resp.status === 401 || resp.status === 403 ? ` — try a different portfolio_auth (currently "${config.auth}")` : ""}`,
        bodySnippet: text.slice(0, 400),
      };
    }
    try {
      return { success: true, status: resp.status, payload: JSON.parse(text) };
    } catch {
      return { success: false, status: resp.status, error: "Response was not JSON", bodySnippet: text.slice(0, 400) };
    }
  } catch (err) {
    return { success: false, error: err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (err?.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reconcile executor positions against the ledger.
 *
 * The two sides are keyed differently and that is the whole subtlety: the ledger is per
 * ticker|timeframe (one record per signal), while the broker holds ONE position per ticker no matter
 * how many timeframes signalled it. So matching is by bare ticker with the ledger side aggregated,
 * and a matched row lists every timeframe that contributed. Matching per timeframe instead would
 * report a spurious break for every multi-timeframe symbol.
 *
 * Three buckets, and the naming is deliberately non-judgemental — neither side is assumed wrong:
 *   matched        — the executor holds it and the ledger has an open record.
 *   executorOnly   — the broker holds something no open ledger record covers. Either it was entered
 *                    outside this system, or its exit was recorded here while the broker still holds
 *                    it (a close that never filled). Worth looking at either way.
 *   ledgerOnly     — an open ledger record with no broker position. Either the entry never filled,
 *                    or it closed at the broker without this system seeing the EXIT yet.
 */
export function reconcilePortfolio(positions, { openTrades = [] } = {}) {
  const ledger = openLedgerByTicker();
  const scannerOpenByTicker = new Map();
  for (const t of (Array.isArray(openTrades) ? openTrades : [])) {
    const ticker = bareTicker(t?.symbol || "").toUpperCase();
    if (!ticker) continue;
    if (!scannerOpenByTicker.has(ticker)) scannerOpenByTicker.set(ticker, []);
    scannerOpenByTicker.get(ticker).push(timeframeTag(t?.timeframe));
  }

  const totalValue = positions.reduce((s, p) => s + (p.marketValue || 0), 0);
  const seen = new Set();

  const matched = [];
  const executorOnly = [];
  for (const p of positions) {
    const ledgerRows = p.ticker ? ledger.get(p.ticker) : null;
    seen.add(p.ticker);
    const row = {
      ...p,
      // Share of the book, which is the number that actually answers "is this position sized right"
      // relative to the others. Absolute size needs account equity, which this endpoint may not give.
      weightPct: totalValue > 0 && p.marketValue !== null ? (p.marketValue / totalValue) * 100 : null,
      ledgerTimeframes: ledgerRows ? ledgerRows.map((r) => r.tag).filter(Boolean) : [],
      ledgerSources: ledgerRows ? [...new Set(ledgerRows.map((r) => r.source).filter(Boolean))] : [],
      scannerTimeframes: p.ticker ? (scannerOpenByTicker.get(p.ticker) || []) : [],
    };
    if (ledgerRows && ledgerRows.length) matched.push(row);
    else executorOnly.push(row);
  }

  const ledgerOnly = [];
  for (const [ticker, rows] of ledger) {
    if (seen.has(ticker)) continue;
    ledgerOnly.push({
      ticker,
      timeframes: rows.map((r) => r.tag).filter(Boolean),
      sources: [...new Set(rows.map((r) => r.source).filter(Boolean))],
      sentAt: rows.map((r) => r.at).filter(Boolean).sort().pop() || null,
      prices: rows.map((r) => r.price).filter((v) => v !== null && v !== undefined && v !== ""),
    });
  }

  matched.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1) || String(a.ticker).localeCompare(String(b.ticker)));
  executorOnly.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1) || String(a.ticker).localeCompare(String(b.ticker)));
  ledgerOnly.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

  const weights = [...matched, ...executorOnly].map((p) => p.weightPct).filter((v) => v !== null);
  return {
    totalPositions: positions.length,
    totalValue: totalValue > 0 ? totalValue : null,
    totalUnrealizedPl: positions.some((p) => p.unrealizedPl !== null)
      ? positions.reduce((s, p) => s + (p.unrealizedPl || 0), 0)
      : null,
    // Concentration: an even book of N positions sits at 100/N each, so the largest weight against
    // that baseline is the quickest read on whether one position is oversized.
    evenWeightPct: positions.length ? 100 / positions.length : null,
    maxWeightPct: weights.length ? Math.max(...weights) : null,
    matched,
    executorOnly,
    ledgerOnly,
  };
}

/** Fetch + normalize + reconcile in one call. Never throws. */
export async function getExecutorPortfolio({ openTrades = [] } = {}) {
  const config = loadPortfolioConfig();
  const result = await fetchPortfolio(config);
  const base = {
    configured: config.configured,
    auth: config.auth,
    method: config.method,
    fetchedAt: new Date().toISOString(),
  };
  if (!result.success) return { ...base, available: false, ...result };

  const { rows, at } = pickArray(result.payload);
  const positions = rows.map(normalizePosition).filter((p) => p && p.ticker);
  const unmapped = rows.length - positions.length;
  return {
    ...base,
    available: true,
    success: true,
    positionsAt: at,
    // Kept so an unrecognized shape is diagnosable from the dashboard instead of needing a code
    // change to inspect — this is the intended path for tightening the field mapping later.
    rawSample: rows.length ? rows[0] : result.payload,
    rawRowCount: rows.length,
    unmappedRows: unmapped,
    positions,
    ...reconcilePortfolio(positions, { openTrades }),
  };
}
