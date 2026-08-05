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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const LOCAL_CONFIG_PATH = join(PROJECT_ROOT, "webhook.local.json");
export const WEBHOOK_STATE_PATH = join(PROJECT_ROOT, "status", "webhook-sent-state.json");
/**
 * Overflow from the live ledger, append-only, one JSON record per line.
 *
 * JSONL rather than CSV because a ledger record nests (`exit` is an object) and because appending
 * must never require parsing what is already there — the live file is rewritten in full on every
 * write, and that is exactly the property this file exists to stop growing.
 */
export const WEBHOOK_ARCHIVE_PATH = join(PROJECT_ROOT, "status", "webhook-sent-archive.jsonl");

/**
 * How many records stay in the live ledger. Every read path (`alreadySent`, the auto-close lookup,
 * alert-quota priority) parses this file, so it is kept small deliberately — but see
 * `persistSentState`: overflow is now ARCHIVED, never dropped, and an open position is never
 * evicted at all, so this is a working-set bound and not a history limit.
 */
const MAX_LIVE_LEDGER = 500;

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
  const enabledTimeframes = Array.isArray(w.enabled_timeframes) ? w.enabled_timeframes.map(String) : [];
  // Timeframes whose orders are placed by a TradingView watchlist alert POSTing to the executor
  // directly — the subscription only carries two of those, which is why this scanner exists at all.
  // The scanner must NEVER also send for these (that would double-order); it only records what it
  // observes into the ledger, so the ledger stays a complete picture of live positions regardless of
  // who placed the order. Mutually exclusive with enabledTimeframes: a timeframe appearing in both
  // resolves in favour of tv-alert and drops out of the armed list, because the failure mode of
  // guessing wrong here is a duplicate real order.
  const tvAlertTimeframes = Array.isArray(w.tv_alert_timeframes) ? w.tv_alert_timeframes.map(String) : [];
  const tvSet = new Set(tvAlertTimeframes);
  // Optional SYMBOL scope on top of the timeframe gate: names of watchlists whose members are the
  // ones TradingView actually alerts on. Needed when the alert list is a strict subset of the
  // scanned list — the common "scan broad, trade narrow" setup. Without it the ledger would claim
  // TradingView placed an order for every scanned symbol on that timeframe, and each phantom record
  // would render a Close button that sends a REAL order for a position that was never opened.
  // Empty/absent means no symbol scope, i.e. the whole timeframe — the original behaviour.
  const tvAlertWatchlists = Array.isArray(w.tv_alert_watchlists) ? w.tv_alert_watchlists.map(String) : [];
  return {
    group: w.group || "swing",
    // Timeframes are TradingView resolution strings ("30", "45", "D") to match rules.watchlists.
    enabledTimeframes: enabledTimeframes.filter((tf) => !tvSet.has(tf)),
    tvAlertTimeframes,
    tvAlertWatchlists,
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

/**
 * A caller-supplied `tag` override for the payload, validated rather than trusted.
 *
 * The tag is a ROUTING field at the executor (it selects the strategy group an order is filed
 * under), and the timeframe-derived default is only the convention — the dashboard lets a tag be
 * changed per position so one signal can be routed somewhere other than its own timeframe's bucket.
 *
 * Returns null for anything absent or unusable so the caller falls back to timeframeTag(); the
 * charset is deliberately narrow (the same shape timeframeTag itself emits) because this string is
 * echoed into the ledger, the console log and the executor's own records, and a tag carrying
 * whitespace or punctuation would silently fragment those.
 */
export function normalizeWebhookTag(tag) {
  const raw = String(tag ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9_-]{1,20}$/.test(raw)) return null;
  return raw;
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
 * Order-type / time-in-force vocabulary the Railway executor forwards to Alpaca.
 *
 * The executor validates neither field — both are lowercased and passed straight through as Alpaca's
 * `type` / `time_in_force`, so a typo fails at the broker rather than here, and a *missing required
 * price* is rejected up front with HTTP 400 having never reached Alpaca. That makes client-side
 * validation worth doing properly: the failure modes are a rejected order (noisy but safe) or a
 * silently wrong one (not safe). `validateOrderSpec` below is the single definition of "valid",
 * shared by the dashboard and re-run server-side on every send.
 */
export const ORDER_TYPES = ["market", "limit", "stop", "stop_limit", "trailing_stop"];
export const TIME_IN_FORCE = ["gtc", "day", "opg", "cls", "ioc", "fok"];

/** Price fields each order type requires. `trailing_stop` needs either one, not both. */
const REQUIRED_PRICE_FIELDS = {
  market: [],
  limit: ["limitPrice"],
  stop: ["stopPrice"],
  stop_limit: ["limitPrice", "stopPrice"],
  trailing_stop: [], // handled separately: trailPercent OR trailPrice
};

const positive = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0;

/**
 * Normalize + validate one order spec. Returns `{ ok: true, spec }` or `{ ok: false, error }`.
 *
 * Rules mirror the executor's documented contract exactly:
 *  - a priced order type without its price is a hard 400 there, so it's a hard refusal here;
 *  - `0` counts as missing, not as a price (an order at 0 would be a real, very wrong order);
 *  - `opg`/`cls` are only valid on market/limit at Alpaca, and TIF is force-set to `gtc` on every
 *    trailing stop regardless of what is sent — so pairing them is rejected rather than silently
 *    reinterpreted, which would leave the UI claiming something the broker never did.
 */
export function validateOrderSpec({ orderType, timeInForce, limitPrice, stopPrice, trailPercent, trailPrice } = {}) {
  const type = String(orderType || "market").toLowerCase().trim() || "market";
  if (!ORDER_TYPES.includes(type)) {
    return { ok: false, error: `Unsupported order_type "${orderType}" (expected one of: ${ORDER_TYPES.join(", ")})` };
  }
  const tif = timeInForce === null || timeInForce === undefined || timeInForce === ""
    ? null
    : String(timeInForce).toLowerCase().trim();
  if (tif && !TIME_IN_FORCE.includes(tif)) {
    return { ok: false, error: `Unsupported time_in_force "${timeInForce}" (expected one of: ${TIME_IN_FORCE.join(", ")})` };
  }
  if (tif && (tif === "opg" || tif === "cls") && type !== "market" && type !== "limit") {
    return { ok: false, error: `time_in_force "${tif}" is only valid on market or limit orders` };
  }

  for (const field of REQUIRED_PRICE_FIELDS[type]) {
    const value = field === "limitPrice" ? limitPrice : stopPrice;
    if (!positive(value)) {
      return { ok: false, error: `${type} orders require a positive ${field === "limitPrice" ? "limit_price" : "stop_price"}` };
    }
  }
  if (type === "trailing_stop" && !positive(trailPercent) && !positive(trailPrice)) {
    return { ok: false, error: "trailing_stop orders require a positive trail_percent or trail_price" };
  }

  return {
    ok: true,
    spec: {
      orderType: type,
      timeInForce: tif,
      limitPrice: positive(limitPrice) ? Number(limitPrice) : null,
      stopPrice: positive(stopPrice) ? Number(stopPrice) : null,
      trailPercent: positive(trailPercent) ? Number(trailPercent) : null,
      trailPrice: positive(trailPrice) ? Number(trailPrice) : null,
    },
  };
}

/**
 * `action`, when given, is sent as-is instead of being derived from `side` via orderAction() — used
 * by the exit dispatch path, which has already computed the closing action via exitOrderAction() and
 * would otherwise have it re-derived (wrongly, as an entry) from the position's original side.
 *
 * Order type / TIF / price fields are used only by the manual Send + Close flows (the dashboard's
 * order form), never by the automatic scheduled dispatch, which has no human present to pick a type
 * or a price and always sends a plain market order. Bid/ask aren't reliably available from a normal
 * scan (confirmed live: getQuote()'s bid/ask come from a DOM scrape of a panel that isn't part of
 * the standard chart layout), so no price is ever computed here — the caller supplies an
 * already-decided one. A `market` (or absent) order type omits `order_type` entirely, keeping the
 * original plain-market payload byte-for-byte identical to what TradingView's own alert sends.
 *
 * `price` keeps its TradingView meaning ("the order's price"), so for a priced type it carries the
 * limit price (or the stop price when there is no limit leg) rather than the stale reference quote —
 * while the executor's own required field (`limit_price` / `stop_price`) is always sent separately,
 * because that is the one it actually reads.
 */
export function buildWebhookPayload({
  symbol, side, action, timeframe, tag, price, group, secret,
  orderType, timeInForce, limitPrice, stopPrice, trailPercent, trailPrice,
}) {
  const check = validateOrderSpec({ orderType, timeInForce, limitPrice, stopPrice, trailPercent, trailPrice });
  if (!check.ok) throw new Error(check.error);
  const spec = check.spec;

  const effectivePrice = spec.limitPrice ?? spec.stopPrice ?? price;
  const payload = {
    symbol: bareTicker(symbol),
    side: action || orderAction(side),
    group: group || "swing",
    // Defaults to the timeframe's own tag; an explicit override is only honoured when it survives
    // normalizeWebhookTag, so a malformed one degrades to the default rather than going out. The
    // automatic dispatch paths never pass `tag`, so their payload is unchanged byte-for-byte.
    tag: normalizeWebhookTag(tag) || timeframeTag(timeframe),
    // Sent as a string because TradingView's own placeholder expansion produces a string, and the
    // Railway side is already parsing that shape.
    price: effectivePrice === null || effectivePrice === undefined ? "" : String(effectivePrice),
    secret,
  };
  if (spec.orderType !== "market") payload.order_type = spec.orderType;
  if (spec.limitPrice !== null && (spec.orderType === "limit" || spec.orderType === "stop_limit")) {
    payload.limit_price = String(spec.limitPrice);
  }
  if (spec.stopPrice !== null && (spec.orderType === "stop" || spec.orderType === "stop_limit")) {
    payload.stop_price = String(spec.stopPrice);
  }
  if (spec.orderType === "trailing_stop") {
    // trail_percent wins when both are given: it's the one that survives the executor's letf-routed
    // sell path, and sending both would leave which one Alpaca honours up to field ordering.
    if (spec.trailPercent !== null) payload.trail_percent = String(spec.trailPercent);
    else payload.trail_price = String(spec.trailPrice);
  }
  if (spec.timeInForce) payload.time_in_force = spec.timeInForce;
  return payload;
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

/**
 * Append records to the archive. Returns false if the write failed, so the caller can keep them in
 * the live ledger rather than deleting data it could not preserve.
 */
function archiveRecords(entries) {
  if (!entries.length) return true;
  try {
    const at = new Date().toISOString();
    const lines = entries.map(([key, rec]) => JSON.stringify({ key, ...rec, archived_at: at })).join("\n");
    mkdirSync(dirname(WEBHOOK_ARCHIVE_PATH), { recursive: true });
    appendFileSync(WEBHOOK_ARCHIVE_PATH, lines + "\n");
    return true;
  } catch (err) {
    console.error(`[webhook] could not archive ledger overflow: ${err?.message || err}`);
    return false;
  }
}

function persistSentState(state) {
  // Bound the live ledger's size — every read path parses this whole file — but two rules govern
  // what may leave it, and both were learned the hard way:
  //
  // 1. An OPEN record (no `.exit`) is NEVER evicted, no matter how old. The previous version sorted
  //    every key by entry time and deleted the oldest past the cap, open or not. That is a
  //    money-path bug, not a display one: an evicted open record means the auto-close stops seeing
  //    the position and the duplicate-send guard stops blocking a re-entry on it. At the measured
  //    ~540-650 positions/month (all timeframes armed), a position open longer than about four
  //    weeks would have been silently dropped. If open positions alone ever exceed the cap the file
  //    simply grows, which is the correct outcome — they are the working set by definition.
  // 2. Closed overflow is ARCHIVED, never deleted, and only deleted once the archive write is
  //    confirmed. The history view queries by period (YTD, last month, ...), so silently discarding
  //    old records would make those answers quietly wrong rather than visibly incomplete.
  //
  // Sorted by the ENTRY's `at` (top-level), so a position with a since-added `.exit` ages out as one
  // unit rather than the entry and exit halves drifting apart.
  const keys = Object.keys(state.sent);
  const overflow = keys.length - MAX_LIVE_LEDGER;
  if (overflow > 0) {
    const closed = keys
      .filter((k) => state.sent[k]?.exit)
      .sort((a, b) => String(state.sent[a].at).localeCompare(String(state.sent[b].at)))
      .slice(0, overflow);
    if (archiveRecords(closed.map((k) => [k, state.sent[k]]))) {
      for (const k of closed) delete state.sent[k];
    }
  }
  try {
    mkdirSync(dirname(WEBHOOK_STATE_PATH), { recursive: true });
    writeFileSync(WEBHOOK_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[webhook] could not persist sent-state: ${err?.message || err}`);
  }
}

/**
 * Read archived (closed, aged-out) records back for the history view.
 *
 * Deliberately NOT merged into `readSentState()`: that is the hot path every send, auto-close and
 * alert-priority check parses, and it answers "what is this system working on now". Archived records
 * are all closed by definition, so nothing in that path can need them.
 *
 * `limit` returns the most recent N and reports `truncated`, so a very large archive degrades into a
 * *labelled* partial answer rather than a silently short one — the same failure this whole change
 * exists to remove. A torn final line (a crash mid-append) is skipped and counted, not thrown.
 */
export function readSentArchive({ limit = 10000 } = {}) {
  if (!existsSync(WEBHOOK_ARCHIVE_PATH)) return { rows: [], total: 0, truncated: false, unreadable: 0 };
  let lines;
  try {
    lines = readFileSync(WEBHOOK_ARCHIVE_PATH, "utf8").split(/\r?\n/).filter((l) => l.trim());
  } catch (err) {
    console.error(`[webhook] could not read the ledger archive: ${err?.message || err}`);
    return { rows: [], total: 0, truncated: false, unreadable: 0 };
  }
  const total = lines.length;
  const slice = total > limit ? lines.slice(total - limit) : lines;
  const rows = [];
  let unreadable = 0;
  for (const line of slice) {
    try { rows.push(JSON.parse(line)); } catch { unreadable += 1; }
  }
  return { rows, total, truncated: total > limit, unreadable };
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
 * The full ledger record, for callers that need to know HOW the entry got there rather than just
 * that it did — specifically the exit dispatcher, which must not close a position whose entry was
 * placed by a TradingView alert (`source: "tv-alert"`) rather than by this system.
 */
export function getSentRecord(key) {
  if (!key) return null;
  return readSentState().sent[key] || null;
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

/**
 * How a ledger record came to be in its current state, for the Webhook Orders tab's Type column.
 *
 * The distinction that matters is "did an order actually go out from here", not "is there an exit
 * record" — a position closed by hand at the broker still gets an exit written (otherwise it would
 * sit in the open list forever, keep its alert-quota priority, and block a later real entry on the
 * same key), but nothing was sent. That case is marked `sent: false` on the exit, exactly as the
 * tv-alert path already marks records it merely observed. `sent` is absent on every exit written
 * before this existed, and every one of those WAS a real send, so absent must read as sent.
 */
export function ledgerRowType(rec) {
  const exit = rec?.exit;
  if (!exit) return rec?.source === "tv-alert" ? "TV Open" : "WH Open";
  if (exit.source === "tv-alert") return "TV Close";
  return exit.sent === false ? "Manual Close" : "WH Close";
}

/**
 * Record a close that this system did NOT send — the position was closed directly at the broker.
 * Merges onto the same key as any other exit (so `alreadyExitSent` and the open/closed split need no
 * special case) but is stamped `sent: false` so `ledgerRowType` can tell it apart from a real send
 * and no reader can mistake it for proof an order went out.
 */
export function recordManualClose(key, record) {
  if (!key) return;
  recordExitSent(key, { ...record, sent: false, source: "manual-close" });
}
