/**
 * Trade-execution webhook — the escape hatch around TradingView's 2-watchlist-alert limit.
 *
 * TradingView itself can only carry two watchlist alerts on this subscription, and those already
 * POST to the Railway executor directly. Every other timeframe would otherwise be ntfy-to-phone and
 * hand-executed, which does not scale at 30m/45m cadence. This module lets the scanner send the
 * same payload shape TradingView would have sent, so the Railway app cannot tell the difference.
 *
 * Payload matches the TradingView alert message field-for-field. Where TradingView would expand
 * `{{ticker}}` / `{{strategy.order.action}}` / `{{strategy.order.price}}` server-side, we substitute
 * the scanner's own values — so `symbol` is the bare ticker (no exchange prefix, matching
 * `{{ticker}}`) and `side` is lowercase buy/sell (matching `{{strategy.order.action}}`).
 *
 * SECRETS: `rules.json` is tracked in git, so the URL and shared secret are deliberately NOT read
 * from it. They come from the environment (`TRADE_WEBHOOK_URL` / `TRADE_WEBHOOK_SECRET`) or from
 * `webhook.local.json`, which is gitignored. Only the non-sensitive switches (which timeframes are
 * armed, the `group` label) live in rules.json, because the dashboard has to persist those and they
 * leak nothing if committed. A missing secret is a hard refusal to send, never a send-without-auth.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const LOCAL_CONFIG_PATH = join(PROJECT_ROOT, "webhook.local.json");
export const WEBHOOK_STATE_PATH = join(PROJECT_ROOT, "status", "webhook-sent-state.json");

/**
 * Resolve credentials. Environment wins over the local file so a scheduled task can inject them
 * without anything touching disk.
 */
export function loadWebhookCredentials() {
  let local = {};
  if (existsSync(LOCAL_CONFIG_PATH)) {
    try {
      local = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, "utf8")) || {};
    } catch (err) {
      console.error(`[webhook] ${LOCAL_CONFIG_PATH} is not valid JSON: ${err?.message || err}`);
    }
  }
  const url = process.env.TRADE_WEBHOOK_URL || local.url || null;
  const secret = process.env.TRADE_WEBHOOK_SECRET || local.secret || null;
  return { url, secret, configured: Boolean(url && secret) };
}

/** Non-secret switches, safe to keep in the tracked rules.json. */
export function loadWebhookSettings(rules) {
  const w = rules?.webhook || {};
  return {
    group: w.group || "swing",
    // Timeframes are TradingView resolution strings ("30", "45", "D") to match rules.watchlists.
    enabledTimeframes: Array.isArray(w.enabled_timeframes) ? w.enabled_timeframes.map(String) : [],
  };
}

/**
 * Human-facing timeframe tag ("15m", "4h", "1d") for the payload's `tag` field, matching the
 * convention already used for trade-log filenames so the Railway side sees one vocabulary.
 */
const TAG_BY_RESOLUTION = {
  1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m",
  45: "45m", 60: "1h", 120: "2h", 180: "3h", 240: "4h",
  360: "6h", 480: "8h", 720: "12h",
};

export function timeframeTag(timeframe) {
  const raw = String(timeframe ?? "").trim();
  if (!raw) return "unknown";
  if (TAG_BY_RESOLUTION[raw]) return TAG_BY_RESOLUTION[raw];
  const upper = raw.toUpperCase();
  if (upper === "D" || upper === "1D") return "1d";
  if (upper === "W" || upper === "1W") return "1w";
  if (upper === "M" || upper === "1M") return "1mo";
  return raw.toLowerCase();
}

/** `{{ticker}}` expands without the exchange prefix, so BATS:SOXL must go out as SOXL. */
export function bareTicker(symbol) {
  const s = String(symbol ?? "").trim();
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * `{{strategy.order.action}}` is lowercase buy/sell. An OPEN on a short position is a "sell" entry,
 * so side is derived from the trade's own LONG/SHORT rather than assuming the Long-Only setting —
 * that setting is a chart input and can be changed without this module ever knowing.
 */
export function orderAction(side) {
  const s = String(side ?? "").toUpperCase();
  if (s === "SHORT" || s === "SELL" || s === "SE") return "sell";
  return "buy";
}

/**
 * Closing order action — the inverse of orderAction()'s entry mapping. Closing a LONG position is a
 * sell (give the shares back); closing a SHORT is a buy (cover). Reusing orderAction() unmodified for
 * an exit would send the same side as the entry, which reads to the receiver as adding to the
 * position rather than closing it.
 */
export function exitOrderAction(side) {
  const s = String(side ?? "").toUpperCase();
  if (s === "SHORT" || s === "SE") return "buy";
  return "sell";
}

/**
 * `action`, when given, is sent as-is instead of being derived from `side` via orderAction() — used
 * by the exit dispatch path, which has already computed the closing action via exitOrderAction() and
 * would otherwise have it re-derived (wrongly, as an entry) from the position's original side.
 */
export function buildWebhookPayload({ symbol, side, action, timeframe, price, group, secret }) {
  return {
    symbol: bareTicker(symbol),
    side: action || orderAction(side),
    group: group || "swing",
    tag: timeframeTag(timeframe),
    // Sent as a string because TradingView's own placeholder expansion produces a string, and the
    // Railway side is already parsing that shape.
    price: price === null || price === undefined ? "" : String(price),
    secret,
  };
}

/**
 * One send. Errors are returned, never thrown — a webhook failure must not abort the scan that
 * produced it, exactly as the ntfy push path already behaves.
 */
export async function sendTradeWebhook({ url, payload, timeoutMs = 10000 }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      return { success: false, status: resp.status, error: `HTTP ${resp.status} ${resp.statusText}`, body: text.slice(0, 300) };
    }
    return { success: true, status: resp.status, body: text.slice(0, 300) };
  } catch (err) {
    return { success: false, error: err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : (err?.message || String(err)) };
  }
}

/**
 * Sent-state ledger, keyed by ticker|tag|entryTime.
 *
 * Entry time is part of the key precisely because it is the thing that changes when a genuinely new
 * position opens on a symbol that already fired — keying on symbol+timeframe alone would suppress
 * the next real entry forever. A null entry time is never written: the notify gates already treat
 * unknown entry time as not-recent, and fabricating one here would reintroduce the exact bug the
 * open-trade code documents (a substituted timestamp silently corrupting recency logic).
 */
export function readSentState() {
  if (!existsSync(WEBHOOK_STATE_PATH)) return { sent: {} };
  try {
    const parsed = JSON.parse(readFileSync(WEBHOOK_STATE_PATH, "utf8"));
    return { sent: parsed?.sent && typeof parsed.sent === "object" ? parsed.sent : {} };
  } catch {
    return { sent: {} };
  }
}

export function sentKey({ symbol, timeframe, entryTime }) {
  if (!entryTime) return null;
  return `${bareTicker(symbol)}|${timeframeTag(timeframe)}|${entryTime}`;
}

function persistSentState(state) {
  // Keep the ledger from growing without bound; 500 entries is far more than any plausible
  // look-back and keeps the file small enough for the dashboard to fetch on every poll. Sorted by
  // the ENTRY's `at` (top-level), so a position with a since-added `.exit` still ages out as one
  // unit rather than the entry and exit halves drifting apart in the trim.
  const keys = Object.keys(state.sent);
  if (keys.length > 500) {
    keys.sort((a, b) => String(state.sent[a].at).localeCompare(String(state.sent[b].at)));
    for (const k of keys.slice(0, keys.length - 500)) delete state.sent[k];
  }
  try {
    mkdirSync(dirname(WEBHOOK_STATE_PATH), { recursive: true });
    writeFileSync(WEBHOOK_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[webhook] could not persist sent-state: ${err?.message || err}`);
  }
}

export function recordSent(key, record) {
  if (!key) return;
  const state = readSentState();
  state.sent[key] = { ...record, at: new Date().toISOString() };
  persistSentState(state);
}

export function alreadySent(key) {
  if (!key) return false;
  return Boolean(readSentState().sent[key]);
}

/**
 * Record that the paired EXIT for an already-sent entry has now also been sent. Merges onto the
 * SAME ledger key rather than writing a new one, so `alreadySent(key)` keeps meaning exactly "we
 * sent the entry" — the fact this exists at all is the auto-exit dispatcher's proof that this
 * position is one it opened at the executor, not a position it's guessing about.
 */
export function recordExitSent(key, record) {
  if (!key) return;
  const state = readSentState();
  const existing = state.sent[key] || {};
  state.sent[key] = { ...existing, exit: { ...record, at: new Date().toISOString() } };
  persistSentState(state);
}

/** Whether the paired EXIT for the entry recorded under `key` has already been sent. */
export function alreadyExitSent(key) {
  if (!key) return false;
  return Boolean(readSentState().sent[key]?.exit);
}
