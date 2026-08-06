/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, and can return signal-only results.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as alerts from "./alerts.js";
import { launch as launchTradingView } from "./health.js";
import * as watchlist from "./watchlist.js";
import * as tradeLog from "./trade_log.js";
import { attachOpenTradeRanks } from "./edge_analysis.js";
import {
  loadWebhookCredentials,
  loadWebhookSettings,
  buildWebhookPayload,
  sendTradeWebhook,
  sentKey,
  alreadySent,
  getSentRecord,
  recordSent,
  orderAction,
  exitOrderAction,
  alreadyExitSent,
  recordExitSent,
  readSentState,
  bareTicker,
  timeframeTag,
} from "./trade_webhook.js";
import { resolveTemplateForTimeframe, templateStamp, listTemplates } from "./sim_templates.js";
import {
  listManualPositions,
  markManualPositionExitAlerted,
} from "./manual_ledger.js";
import { readJsonFile } from "../json_file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");
const DEFAULT_BASELINE_PATH = join(PROJECT_ROOT, "swing-signal-baseline.json");
const LATEST_STATUS_PATH = join(PROJECT_ROOT, "status", "latest-signal-status.json");
const DEFAULT_MARKET_HOURS = {
  timezone: "America/New_York",
  open: "09:30",
  close: "16:00",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureTradingViewConnection({
  getStateFn = () => chart.getState(),
  launchFn = (options) => launchTradingView(options),
  waitMs = 5000,
} = {}) {
  try {
    await getStateFn();
    return { connected: true, launched: false };
  } catch (initialError) {
    try {
      await launchFn({ port: 9222, kill_existing: true });
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      await getStateFn();
      return {
        connected: true,
        launched: true,
        reason: initialError?.message || String(initialError),
      };
    } catch (launchError) {
      throw new Error(launchError?.message || initialError?.message || String(launchError || initialError));
    }
  }
}

function parseJsonFile(filePath, fallback = {}) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return readJsonFile(filePath);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadRules(rulesPath) {
  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: readJsonFile(p), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

function toTimeParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function toDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function formatDateString(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toMarketDateString(date, timezone) {
  const parts = toDateParts(date, timezone);
  return formatDateString(parts.year, parts.month, parts.day);
}

function parseHolidayDate(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [_, year, month, day] = match;
  return formatDateString(Number(year), Number(month), Number(day));
}

function getCustomHolidaySet(marketHours = {}) {
  const holidays = Array.isArray(marketHours.holidays) ? marketHours.holidays : [];
  const set = new Set();
  for (const holiday of holidays) {
    const parsed = parseHolidayDate(holiday);
    if (parsed) set.add(parsed);
  }
  return set;
}

function getNthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDow = first.getUTCDay();
  const delta = (weekday - firstDow + 7) % 7;
  return 1 + delta + (nth - 1) * 7;
}

function getLastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const lastDow = last.getUTCDay();
  return last.getUTCDate() - ((lastDow - weekday + 7) % 7);
}

function getObservedDate(year, month, day) {
  const iso = formatDateString(year, month, day);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  // Saturday holidays are observed the preceding Friday, Sunday holidays the following Monday.
  // Shift with addDays(), never `day ± 1`: New Year's Day on a Saturday is observed on Dec 31 of
  // the PREVIOUS year, and raw day arithmetic emitted "YYYY-01-00" — a well-formed string that can
  // never equal a real market date, so the closure silently disappeared instead of erroring. Next
  // occurrence is Fri 2027-12-31 (for Jan 1 2028, a Saturday); before this fix both the Node gate
  // and the PowerShell gates treated it as a normal trading day.
  if (weekday === 6) return addDays(iso, -1);
  if (weekday === 0) return addDays(iso, 1);
  return iso;
}

function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function addDays(dateString, offset) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return formatDateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function getUsMarketHolidayDates(year) {
  const holidays = new Set();
  holidays.add(getObservedDate(year, 1, 1));
  holidays.add(formatDateString(year, 1, getNthWeekday(year, 1, 1, 3)));
  holidays.add(formatDateString(year, 2, getNthWeekday(year, 2, 1, 3)));
  holidays.add(addDays(formatDateString(year, getEasterSunday(year).month, getEasterSunday(year).day), -2));
  holidays.add(formatDateString(year, 5, getLastWeekday(year, 5, 1)));
  if (year >= 2022) {
    holidays.add(getObservedDate(year, 6, 19));
  }
  holidays.add(getObservedDate(year, 7, 4));
  holidays.add(formatDateString(year, 9, getNthWeekday(year, 9, 1, 1)));
  holidays.add(formatDateString(year, 11, getNthWeekday(year, 11, 4, 4)));
  holidays.add(getObservedDate(year, 12, 25));
  return Array.from(holidays);
}

export const MARKET_HOLIDAY_CALENDAR_PATH = join(PROJECT_ROOT, "status", "market-holidays.json");

/**
 * Materialized holiday list for consumers that cannot run the generator above — specifically
 * `run_signal_job.ps1` and `tv_watchdog.ps1`, whose gates read a flat list out of JSON. Those two
 * are the only reason this exists: `isMarketHoliday()` computes holidays for any year, so the Node
 * scan has never needed a stored list, but the PowerShell gates read `rules.json` alone and were
 * therefore correct only as far as whatever year somebody last typed in by hand.
 *
 * Reimplementing the ten NYSE rules (and Easter) in PowerShell was the alternative and is rejected
 * for the reason `sweet_spot.js` gives for sharing its sweep: two implementations of one rule drift,
 * and the failure is silent — the gates would disagree about whether the market is open with nothing
 * indicating which one had gone stale.
 *
 * Always generates the current year AND next year rather than appending next year once December's
 * last holiday has passed. Two reasons, both load-bearing:
 *   - A cross-year observed holiday belongs to the FOLLOWING year's generator: Jan 1 2028 is a
 *     Saturday, so the closure lands on Fri 2027-12-31 and only `getUsMarketHolidayDates(2028)`
 *     emits it. A list holding "2027 only" would miss a 2027 trading day.
 *   - It does not depend on the machine being powered on during a particular week of December. If
 *     it is asleep from Dec 20 to Jan 5, the next run still produces a fully covered list.
 *
 * Past dates are dropped (`>= today`, so today itself survives while it is still today), which is
 * the purge. Manual entries in `rules.json` → `market_hours.holidays` that are not computed
 * holidays — ad-hoc closures like a national day of mourning, which no rule can predict — are
 * carried through, since discarding them would silently reopen a day the exchange had closed.
 */
export function buildMarketHolidayCalendar({
  marketHours = DEFAULT_MARKET_HOURS,
  now = new Date(),
  yearsAhead = 1,
} = {}) {
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  const today = toMarketDateString(now, timezone);
  const { year } = toDateParts(now, timezone);

  const computed = new Set();
  for (let y = year; y <= year + yearsAhead; y += 1) {
    for (const date of getUsMarketHolidayDates(y)) computed.add(date);
  }

  const manual = [];
  for (const date of getCustomHolidaySet(marketHours)) {
    if (!computed.has(date)) manual.push(date);
  }

  // ISO yyyy-mm-dd sorts and compares lexicographically in calendar order, so no date parsing here.
  const holidays = [...computed, ...manual].filter((date) => date >= today).sort();

  return {
    today,
    timezone,
    coversYears: [year, year + yearsAhead],
    holidays,
    manual: manual.filter((date) => date >= today).sort(),
  };
}

/**
 * Writes the calendar to `status/market-holidays.json`, but only when its contents actually change —
 * so the ~15-minute scan cadence costs one comparison of a ten-element array on all but the handful
 * of runs per year where a holiday has just passed.
 *
 * Never writes an empty list. An empty file would read as "no holidays" to both PowerShell gates,
 * which fails in the dangerous direction: scanning and driving TradingView on a closed market. If
 * generation somehow yields nothing, the previous good file is left exactly as it is.
 */
export function syncMarketHolidayCalendar({
  marketHours = DEFAULT_MARKET_HOURS,
  now = new Date(),
  path = MARKET_HOLIDAY_CALENDAR_PATH,
  yearsAhead = 1,
} = {}) {
  const built = buildMarketHolidayCalendar({ marketHours, now, yearsAhead });
  if (built.holidays.length === 0) {
    return { changed: false, reason: "generated_empty", holidays: [], added: [], removed: [] };
  }

  const existing = parseJsonFile(path, null);
  const previous = Array.isArray(existing?.holidays) ? existing.holidays : null;
  const unchanged =
    previous !== null &&
    previous.length === built.holidays.length &&
    previous.every((date, index) => date === built.holidays[index]);

  const added = built.holidays.filter((date) => !previous || !previous.includes(date));
  const removed = previous ? previous.filter((date) => !built.holidays.includes(date)) : [];

  if (unchanged) {
    return { changed: false, reason: "unchanged", holidays: built.holidays, added: [], removed: [] };
  }

  writeJsonFile(path, {
    generated_at: new Date().toISOString(),
    generated_by: "syncMarketHolidayCalendar",
    note:
      "Generated file — do not hand-edit. Computed NYSE holidays for the current and next year, " +
      "purged of past dates, plus any non-computable ad-hoc closures listed in rules.json " +
      "market_hours.holidays. Consumed by run_signal_job.ps1 and tv_watchdog.ps1.",
    today: built.today,
    timezone: built.timezone,
    covers_years: built.coversYears,
    holidays: built.holidays,
    manual_extras: built.manual,
  });

  return { changed: true, reason: previous === null ? "created" : "rolled", holidays: built.holidays, added, removed };
}

const MARKET_HOLIDAY_CACHE = new Map();

function getMarketHolidaySet(year) {
  if (MARKET_HOLIDAY_CACHE.has(year)) return MARKET_HOLIDAY_CACHE.get(year);
  const set = new Set(getUsMarketHolidayDates(year));
  MARKET_HOLIDAY_CACHE.set(year, set);
  return set;
}

export function isMarketHoliday(date = new Date(), marketHours = DEFAULT_MARKET_HOURS) {
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  const marketDate = toMarketDateString(date, timezone);
  const customHolidays = getCustomHolidaySet(marketHours);
  if (customHolidays.has(marketDate)) return true;

  const parts = toDateParts(date, timezone);
  for (const year of [parts.year - 1, parts.year, parts.year + 1]) {
    if (getMarketHolidaySet(year).has(marketDate)) return true;
  }

  return false;
}

export function isScheduleDisabled(rules = {}) {
  return Boolean(rules.schedule?.disabled);
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value || "00:00")
    .split(":")
    .map((part) => Number(part));
  return hours * 60 + minutes;
}

export function buildScanTargets(rules = {}) {
  const fallbackSymbols = Array.isArray(rules.watchlist) ? rules.watchlist : [];
  // `scan: false` keeps a watchlist in the config — so its membership is still synced live from
  // TradingView and still gates the tv-alert ledger — without adding it to the scan queue. The
  // top-pick alert lists are strict subsets of the full scanned lists, so scanning them too would
  // re-navigate the same symbol/timeframe pairs for signals the parent watchlist already produced.
  const watchlistEntries = Object.entries(rules.watchlists || {})
    .filter(([, config]) => !(typeof config === 'object' && config?.scan === false));
  if (watchlistEntries.length > 0) {
    return watchlistEntries.map(([watchlistName, config]) => ({
      watchlistName,
      timeframe: String(typeof config === 'object' ? (config.timeframe || rules.default_timeframe || '240') : config),
      symbols: Array.isArray(config?.symbols) ? config.symbols : fallbackSymbols,
    }));
  }

  return [
    {
      watchlistName: `Watchlist ${rules.default_timeframe || "240"}`,
      timeframe: String(rules.default_timeframe || "240"),
      symbols: fallbackSymbols,
    },
  ];
}

export function shouldRunEquityScanNow(
  now = new Date(),
  marketHours = DEFAULT_MARKET_HOURS,
) {
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  const current = toTimeParts(now, timezone);
  const allowedDays = marketHours?.days || DEFAULT_MARKET_HOURS.days;

  if (!allowedDays.includes(current.weekday)) return false;
  if (isMarketHoliday(now, marketHours)) return false;

  const openMinutes = timeToMinutes(marketHours?.open || DEFAULT_MARKET_HOURS.open) + 1;
  const closeMinutes = timeToMinutes(marketHours?.close || DEFAULT_MARKET_HOURS.close);
  const currentMinutes = current.hour * 60 + current.minute;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
}

function normalizePrice(value) {
  if (value == null) return null;
  const num = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

function extractPrice(text) {
  if (!text) return null;
  const matches = String(text).match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  return normalizePrice(matches[matches.length - 1]);
}

function signalDirection(text) {
  const value = String(text || "").toUpperCase();
  if (!value.trim()) return null;

  const bullish = /▲|\bLONG\b|\bBUY\b|\bBULL\w*\b/.test(value);
  const bearish = /▼|\bSHORT\b|\bSELL\b|\bBEAR\w*\b/.test(value);

  if (bullish && !bearish) return "bullish";
  if (bearish && !bullish) return "bearish";
  return null;
}

function directionMarker(direction) {
  if (direction === "bullish") return "▲";
  if (direction === "bearish") return "▼";
  return null;
}

// The strategy's own status label ("Mode: Fast (active bar)\nLast signal: Short\n
// Bars since signal: N\nPosition: Flat/Long/Short") reports the CURRENT strategy
// position explicitly. This is authoritative ground truth for open/closed state —
// unlike the generic bullish/bearish keyword scan below, which matches words like
// "Short" anywhere in the text and would misread "Last signal: Short" + "Position:
// Flat" as an active bearish signal even though the position is actually closed.
function parsePositionState(text) {
  const match = /Position:\s*(Flat|Long|Short)\b/i.exec(String(text || ""));
  return match ? match[1].toLowerCase() : null;
}

export function detectSignalFromSnapshot(snapshot = {}) {
  const candidates = [];
  let labelCount = 0;

  for (const study of snapshot.labels?.studies || []) {
    for (const label of study.labels || []) {
      labelCount += 1;
      candidates.push({
        source: "label",
        study: study.name,
        text: label.text || "",
        price: normalizePrice(label.price),
      });
    }
  }

  for (const study of snapshot.tables?.studies || []) {
    for (const table of study.tables || []) {
      for (const row of table.rows || []) {
        candidates.push({
          source: "table",
          study: study.name,
          text: row || "",
          price: extractPrice(row),
        });
      }
    }
  }

  for (const study of snapshot.indicators?.studies || []) {
    for (const [key, value] of Object.entries(study.values || {})) {
      const text = `${key}: ${value}`;
      candidates.push({
        source: "indicator",
        study: study.name,
        text,
        price: extractPrice(text),
      });
    }
  }

  let lastSignal = null;
  let positionState = null;
  for (const candidate of candidates) {
    const parsedPosition = parsePositionState(candidate.text);
    if (parsedPosition) positionState = parsedPosition;

    const direction = signalDirection(candidate.text);
    if (!direction) continue;
    lastSignal = {
      hasSignal: true,
      direction,
      price: candidate.price,
      source: candidate.source,
      study: candidate.study,
      text: candidate.text,
      labelCount,
    };
  }

  return (
    (lastSignal && { ...lastSignal, positionState }) || {
      hasSignal: false,
      direction: null,
      price: null,
      source: null,
      study: null,
      text: null,
      labelCount,
      positionState,
    }
  );
}

function loadBaseline(baselinePath) {
  const baseline = parseJsonFile(baselinePath, {});
  return {
    last_updated: baseline.last_updated || null,
    market_hours: baseline.market_hours || DEFAULT_MARKET_HOURS,
    signals: baseline.signals || {},
    watchlists: baseline.watchlists || {},
    excursion_alerts: baseline.excursion_alerts || {},
  };
}

export function updateBaselineEntry(signalMap, entry) {
  const symbol = entry.state?.symbol || entry.symbol;
  const key = `${symbol}:${entry.timeframe}`;
  let previous = signalMap[key];
  let previousKey = key;
  if (!previous) {
    // TradingView can serve the same instrument under a different exchange prefix
    // between scans (e.g. AMEX:AGQ vs BATS:AGQ). Match by ticker+timeframe against
    // any previously-OPEN entry so a prefix change doesn't look like a brand-new
    // position and reset its entry time/price. (createExcursionAlerts already does
    // the equivalent ticker-normalized match for its own excursion_alerts cache.)
    const ticker = String(symbol || '').split(':').pop()?.toUpperCase() || '';
    const altKey = Object.keys(signalMap).find((k) => {
      const pipe = k.lastIndexOf(':');
      if (pipe < 0) return false;
      const kTicker = k.slice(0, pipe).split(':').pop()?.toUpperCase();
      return kTicker === ticker
        && k.slice(pipe + 1) === String(entry.timeframe)
        && String(signalMap[k].signal_type || '').toUpperCase() === 'OPEN';
    });
    if (altKey) {
      previous = signalMap[altKey];
      previousKey = altKey;
    }
  }
  previous = previous || {};
  const hasSignal = Boolean(entry.signal?.hasSignal);
  const tradeSignal = normalizeTradeDisplay(entry.trade?.signal, '').toUpperCase();
  const hasTradeState = tradeSignal === 'OPEN' || tradeSignal === 'EXIT';
  const scannedAt = entry.scanned_at || new Date().toISOString();
  const previousWasOpen = String(previous.signal_type || '').toUpperCase() === 'OPEN';

  // The strategy's own status label ("Position: Flat/Long/Short") is computed from
  // strategy.position_size on the currently active (still-forming, unconfirmed) bar,
  // so "Long"/"Short" can run one bar ahead of what the confirmed strategy-tester
  // trade list shows (e.g. a trailing-stop exit already closed the position per the
  // trade list, but the live label hasn't reset because no new opposite signal has
  // fired yet). Only "Flat" is unambiguous ground truth (position size really is
  // zero) — it's safe to use for closing. "Long"/"Short" is NOT safe evidence to
  // open a brand-new trade when the real trade-table read fails; it can only
  // confirm continuation of a position we already independently know is open.
  const positionState = entry.signal?.positionState || null;
  const syntheticOpen = !hasTradeState && (
    positionState === 'flat' ? false : previousWasOpen
  );

  // Never trust the signal label's incidental price (it's the label's chart anchor
  // point, not necessarily a real traded price) as an open trade's entry price.
  // Prefer the real trade-table price, then the last known entry price for a
  // position we already knew was open, then the current quote as a last resort.
  const entryPrice = normalizeTradeDisplay(
    entry.trade?.entryPrice ?? (previousWasOpen ? previous.entry_price : null) ?? entry.quote?.last ?? null,
    null,
  );

  const nextSignalType = hasTradeState ? tradeSignal : syntheticOpen ? 'OPEN' : 'EXIT';
  const explicitEntryTime = normalizeTradeDisplay(entry.trade?.entryTime, '');
  const previousOpenEntryTime = previousWasOpen
    ? (hasMeaningfulTradeValue(previous.entry_time)
        ? previous.entry_time
        : hasMeaningfulTradeValue(previous.last_seen_at)
          ? previous.last_seen_at
          : null)
    : null;
  const nextEntryTime = explicitEntryTime
    || (nextSignalType === 'OPEN'
      ? previousOpenEntryTime || scannedAt
      : previous.entry_time || previous.last_seen_at || ((hasSignal || hasTradeState) ? scannedAt : null));

  signalMap[key] = {
    symbol: entry.state?.symbol || entry.symbol,
    timeframe: entry.timeframe,
    label_count: hasSignal ? entry.signal?.labelCount || 0 : Number(previous.label_count || 0),
    last_signal: hasSignal ? directionMarker(entry.signal?.direction) : previous.last_signal || null,
    last_price: hasSignal
      ? entry.signal?.price ?? entry.quote?.last ?? null
      : previous.last_price ?? entry.quote?.last ?? null,
    last_seen_at: (hasSignal || hasTradeState) ? scannedAt : previous.last_seen_at || null,
    signal_type: nextSignalType,
    entry_time: nextEntryTime,
    // Exit side of the record, added so the Current Signal log can restate TODAY's exits on a tick
    // where this watchlist wasn't due — EXIT rows are otherwise built only from a fresh scan's
    // results, so a 2H exit shown at 12:01 vanished at 12:16. Three rules here:
    //   - Nulled whenever the record is OPEN. A symbol that exits today and re-enters tomorrow would
    //     otherwise carry a stale exit and re-render as one.
    //   - Never carried forward from `previous`, and never substituted with the scan timestamp. The
    //     DOM-scrape fallback supplies no exitTime; null means the row simply doesn't render, which
    //     is the same "a DOM-sourced EXIT is never treated as recent rather than guessed at" rule
    //     the rest of this file already follows.
    //   - nextSignalType can be 'EXIT' with no real trade read at all (the syntheticOpen === false
    //     path), which the `|| null` covers.
    exit_time: nextSignalType === 'EXIT'
      ? (normalizeTradeDisplay(entry.trade?.exitTime, '') || null)
      : null,
    exit_price: nextSignalType === 'EXIT' ? (entry.trade?.exitPrice ?? null) : null,
    entry_price: entryPrice ?? previous.entry_price ?? previous.last_price ?? entry.quote?.last ?? null,
    net_pnl: hasTradeState ? (hasMeaningfulTradeValue(normalizeTradeDisplay(entry.trade?.netPnl)) ? normalizeTradeDisplay(entry.trade?.netPnl) : hasMeaningfulTradeValue(previous.net_pnl) ? previous.net_pnl : normalizeTradeDisplay(entry.trade?.netPnl)) : syntheticOpen ? (hasMeaningfulTradeValue(previous.net_pnl) ? previous.net_pnl : 'In progress') : previous.net_pnl ?? '—',
    favorable_excursion: hasTradeState ? (hasMeaningfulTradeValue(normalizeTradeDisplay(entry.trade?.favorableExcursion)) ? normalizeTradeDisplay(entry.trade?.favorableExcursion) : hasMeaningfulTradeValue(previous.favorable_excursion) ? previous.favorable_excursion : normalizeTradeDisplay(entry.trade?.favorableExcursion)) : syntheticOpen ? (hasMeaningfulTradeValue(previous.favorable_excursion) ? previous.favorable_excursion : 'In progress') : previous.favorable_excursion ?? '—',
    adverse_excursion: hasTradeState ? (hasMeaningfulTradeValue(normalizeTradeDisplay(entry.trade?.adverseExcursion)) ? normalizeTradeDisplay(entry.trade?.adverseExcursion) : hasMeaningfulTradeValue(previous.adverse_excursion) ? previous.adverse_excursion : normalizeTradeDisplay(entry.trade?.adverseExcursion)) : syntheticOpen ? (hasMeaningfulTradeValue(previous.adverse_excursion) ? previous.adverse_excursion : 'In progress') : previous.adverse_excursion ?? '—',
  };

  // Migrate rather than duplicate: the old exchange-prefix key's history now lives
  // under the current key.
  if (previousKey !== key) delete signalMap[previousKey];
}

function hasSignalChanged(previous, currentSignal) {
  if (!currentSignal?.hasSignal) return false;
  return (
    previous?.last_signal !== directionMarker(currentSignal.direction) ||
    normalizePrice(previous?.last_price) !== normalizePrice(currentSignal.price) ||
    Number(previous?.label_count || 0) !== Number(currentSignal.labelCount || 0)
  );
}

function formatTimestamp(value, timezone = DEFAULT_MARKET_HOURS.timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function formatDuration(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

export function formatPriorSignalForWatchlist(
  watchlistSummary = {},
  baselineSignals = {},
  timezone = DEFAULT_MARKET_HOURS.timezone,
) {
  const timeframe = String(watchlistSummary.timeframe || '');
  const symbolKeys = Array.isArray(watchlistSummary.symbols)
    ? watchlistSummary.symbols.map((symbol) => `${symbol}:${timeframe}`)
    : [];

  const candidates = symbolKeys
    .map((key) => ({ key, ...(baselineSignals[key] || {}) }))
    .filter((entry) => entry.last_signal);

  if (candidates.length === 0) {
    return 'Prior Signal: none recorded';
  }

  candidates.sort(
    (a, b) => new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime(),
  );

  const latest = candidates[0];
  const symbol = latest.symbol || String(latest.key || '').split(':')[0] || 'n/a';
  const direction = latest.last_signal === '▲' ? 'LONG' : latest.last_signal === '▼' ? 'SHORT' : latest.last_signal;
  const price = latest.last_price ?? 'n/a';
  const when = latest.last_seen_at ? `${formatTimestamp(latest.last_seen_at, timezone)} ET` : 'time n/a';

  return `Prior Signal: ${symbol} | ${direction} | PRICE: ${price} | AT: ${when}`;
}

function normalizeTradeDisplay(value, fallback = '—') {
  const cleaned = String(value ?? '')
    .replace(/â€”/g, '—')
    .replace(/âˆ’/g, '-')
    .trim();
  return cleaned || fallback;
}

function fillTradeMetric(value, signal = 'EXIT') {
  if (hasMeaningfulTradeValue(value)) return normalizeTradeDisplay(value);
  return String(signal || '').toUpperCase() === 'OPEN' ? 'In progress' : 'Unavailable';
}

function hasMeaningfulTradeValue(value) {
  const cleaned = normalizeTradeDisplay(value, '');
  if (!cleaned) return false;
  const lowered = cleaned.toLowerCase();
  return cleaned !== '—'
    && cleaned !== '-'
    && lowered !== 'n/a'
    && lowered !== 'no trade time'
    && lowered !== 'no prior trade recorded'
    && lowered !== 'unavailable'
    && lowered !== 'in progress';
}

function parseTimestamp(value) {
  const cleaned = String(value || '')
    .replace(/\s+ET$/i, '')
    .trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEntryTimestamp(value) {
  return parseTimestamp(value);
}

function parseUsdValue(value) {
  const match = String(value || '').match(/([-+]?\d[\d,\.]*?)\s*USD/i);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

// netPnl carries both units in one string ("+96.00 USD | +3.87%", built by usdPctText in data.js).
// Anchored on the trailing "%" so it can never pick up the USD figure when the percent half is
// missing — that case must read as "no percent available", not as a percent of the dollar amount.
function parsePctValue(value) {
  const match = String(value || '').match(/([-+]?\d[\d,\.]*)\s*%/);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function formatUsdValue(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} USD`;
}

function formatPctValue(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatPnlPercentOrUsd(value) {
  const pct = parsePctValue(value);
  if (Number.isFinite(pct)) return formatPctValue(pct);
  const usd = parseUsdValue(value);
  if (Number.isFinite(usd)) return formatUsdValue(usd);
  return normalizeTradeDisplay(value, '—');
}

/**
 * The exit block's header line, reported in PERCENT (user request 2026-08-05) rather than the USD
 * figures it previously carried — every EXIT row below it already shows its own percent, so the
 * summary now reads in the same unit as the rows it summarizes.
 *
 * NET is the sum and AVG the mean of the per-row percents, i.e. the identical arithmetic the USD
 * version used, only re-based on the other half of netPnl's "USD | PCT%" string. Keeping NET as the
 * plain sum preserves the NET = AVG x count relationship the line has always shown. It is a
 * position-weighted return only insofar as positions are equal-sized (which this book's
 * equity/maxPositions sizing makes roughly true) — it is not a portfolio return, and neither was
 * the dollar version.
 *
 * Falls back to the USD line when NOT ONE exit carries a percent (a DOM-sourced trade read, where
 * usdPctText had no pctFraction to work with) — a summary in the wrong unit is recoverable, a
 * summary of "—" is not.
 */
function buildExitSummary(recentExits) {
  const rows = Array.isArray(recentExits) ? recentExits : [];
  const percents = rows.map((row) => parsePctValue(row.netPnl)).filter(Number.isFinite);
  if (percents.length > 0) {
    const net = percents.reduce((sum, v) => sum + v, 0);
    const avg = net / percents.length;
    return `  EXIT SUMMARY: NET P&L: ${formatPctValue(net)} | AVG P&L: ${formatPctValue(avg)} (${percents.length} exits)`;
  }

  const amounts = rows.map((row) => parseUsdValue(row.netPnl)).filter(Number.isFinite);
  if (amounts.length === 0) return null;
  const net = amounts.reduce((sum, v) => sum + v, 0);
  const avg = net / amounts.length;
  return `  EXIT SUMMARY: NET P&L: ${formatUsdValue(net)} | AVG P&L: ${formatUsdValue(avg)} (${amounts.length} exits)`;
}

function formatEntryTimeDisplay(value, timezone = DEFAULT_MARKET_HOURS.timezone) {
  const cleaned = normalizeTradeDisplay(value, '').replace(/\s+ET$/i, '').trim();
  if (!cleaned) return 'No trade time';
  if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) return `${formatTimestamp(cleaned, timezone)} ET`;
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}$/.test(cleaned)) return `${cleaned} ET`;
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(cleaned)) return cleaned;
  if (/^\d{1,2}\/\d{1,2}\/\d{4},/.test(cleaned)) return `${cleaned} ET`;
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? `${formatTimestamp(cleaned, timezone)} ET` : cleaned;
}

function timeframeToMinutes(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (normalized === 'D' || normalized === '1D') return 1440;
  if (normalized === 'W' || normalized === '1W') return 10080;
  if (normalized === 'M' || normalized === '1M') return 43200;
  return null;
}

function isTimeframeDueNow(timeframe, date = new Date(), marketHours = DEFAULT_MARKET_HOURS) {
  if (!shouldRunEquityScanNow(date, marketHours)) return false;

  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  const current = toTimeParts(date, timezone);
  const currentMinutes = current.hour * 60 + current.minute;
  const openMinutes = timeToMinutes(marketHours?.open || DEFAULT_MARKET_HOURS.open);
  const tfMinutes = timeframeToMinutes(timeframe);

  if (currentMinutes < openMinutes + 1) return false;
  if (!tfMinutes) return true;
  if (tfMinutes >= 1440) return currentMinutes === openMinutes + 1;

  return currentMinutes % tfMinutes === 1;
}

export function filterScanTargetsBySchedule(
  scanTargets = [],
  now = new Date(),
  marketHours = DEFAULT_MARKET_HOURS,
  baselineWatchlists = {},
) {
  return scanTargets.filter((target) => {
    if (isTimeframeDueNow(target.timeframe, now, marketHours)) return true;
    // Fallback: if the task fired late (scheduler jitter or post-gap cold start),
    // scan if elapsed time since the last scan is at least 85% of the timeframe interval.
    const lastScanned = baselineWatchlists[target.watchlistName]?.last_scanned_at;
    if (!lastScanned || !shouldRunEquityScanNow(now, marketHours)) return false;
    const tfMinutes = timeframeToMinutes(target.timeframe);
    if (!tfMinutes) return false;
    const elapsedMs = now.getTime() - new Date(lastScanned).getTime();
    return elapsedMs >= tfMinutes * 0.85 * 60 * 1000;
  });
}

function isSameTradingDay(value, reference = new Date(), timezone = DEFAULT_MARKET_HOURS.timezone) {
  const input = parseTimestamp(value);
  const ref = parseTimestamp(reference);
  if (!Number.isFinite(input) || !Number.isFinite(ref)) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(input)) === fmt.format(new Date(ref));
}

function isSameOrPreviousTradingDay(value, reference = new Date(), timezone = DEFAULT_MARKET_HOURS.timezone) {
  const input = parseTimestamp(value);
  const ref = parseTimestamp(reference);
  if (!Number.isFinite(input) || !Number.isFinite(ref)) return false;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const entryDay = fmt.format(new Date(input));
  const referenceDate = new Date(ref);
  const referenceDay = fmt.format(referenceDate);
  if (entryDay === referenceDay) return true;

  const current = toTimeParts(referenceDate, timezone);
  const isWeekend = current.weekday === 'Sat' || current.weekday === 'Sun';
  const isPreMarket = (current.hour * 60 + current.minute) < (timeToMinutes(DEFAULT_MARKET_HOURS.open) + 1);
  if (!isWeekend && !isPreMarket) return false;

  let probe = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000);
  for (let i = 0; i < 3; i += 1) {
    const weekday = toTimeParts(probe, timezone).weekday;
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      return fmt.format(probe) === entryDay;
    }
    probe = new Date(probe.getTime() - 24 * 60 * 60 * 1000);
  }

  return false;
}

function isRecentTradeSignal(entryTime, scannedAt, timeframe, maxBars = 4) {
  const entryTs = parseEntryTimestamp(entryTime);
  const scanTs = parseEntryTimestamp(scannedAt || new Date().toISOString());
  const tfMinutes = timeframeToMinutes(timeframe);
  if (!entryTs || !scanTs || !tfMinutes) return false;
  const maxAgeMs = tfMinutes * maxBars * 60 * 1000 + 60 * 1000;
  return scanTs >= entryTs && (scanTs - entryTs) <= maxAgeMs;
}

// `timeframe` defaults to '15' (the scheduled task's own cadence) for the overall "Next run" badge;
// callers that want a specific watchlist's own next-due tick (e.g. a 30m watchlist skipped on a
// 15m-only tick) pass that watchlist's timeframe instead.
function getNextScheduledRunLabel(from = new Date(), marketHours = DEFAULT_MARKET_HOURS, timeframe = '15') {
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  let candidate = new Date(new Date(from).getTime() + 60 * 1000);

  for (let i = 0; i < 60 * 24 * 7; i += 1) {
    if (isTimeframeDueNow(timeframe, candidate, marketHours)) {
      return `${formatTimestamp(candidate, timezone)} ET`;
    }
    candidate = new Date(candidate.getTime() + 60 * 1000);
  }

  return 'n/a';
}

function isRenderablePriorRow(row = {}) {
  const signal = String(row.signal || '—').toUpperCase();
  const hasEntry = hasMeaningfulTradeValue(row.entryPrice) || hasMeaningfulTradeValue(row.entryTime);
  const hasPerformance = hasMeaningfulTradeValue(row.netPnl)
    || hasMeaningfulTradeValue(row.favorableExcursion)
    || hasMeaningfulTradeValue(row.adverseExcursion);
  const wasOpen = Boolean(row.wasOpen);

  if (signal === 'OPEN') return hasEntry;
  if (hasPerformance) return hasEntry;
  return hasEntry && wasOpen;
}

export function buildPriorSignalsByWatchlist(
  watchlistSummaries = [],
  results = [],
  baselineSignals = {},
  timezone = DEFAULT_MARKET_HOURS.timezone,
  baselineUpdatedAt = null,
  baselineWatchlists = {},
) {
  return watchlistSummaries.map((target) => {
    const watchlistName = target.watchlistName || target.watchlist_name;
    const timeframe = String(target.timeframe || '');
    const watchlistResults = results.filter(
      (entry) => entry.watchlist_name === watchlistName && !entry.error,
    );

    const symbolMap = new Map();
    const storedWatchlist = baselineWatchlists[watchlistName] || {};
    const baselineSymbols = Object.entries(baselineSignals)
      .map(([key, value]) => {
        const parts = String(key).split(':');
        const keyTimeframe = parts[parts.length - 1] || value?.timeframe || '';
        if (String(value?.timeframe || keyTimeframe) !== timeframe) return null;
        return value?.symbol || parts.slice(0, -1).join(':') || null;
      })
      .filter(Boolean);
    const preferredSymbols = (target.source || 'watchlist_unavailable') === 'tradingview_panel'
      ? (Array.isArray(target.symbols) ? target.symbols : [])
      : (Array.isArray(storedWatchlist.symbols) && storedWatchlist.symbols.length > 0)
        ? storedWatchlist.symbols
        : (Array.isArray(target.symbols) ? target.symbols : []);

    for (const rawSymbol of [
      ...preferredSymbols,
      ...watchlistResults.map((entry) => entry.state?.symbol || entry.symbol).filter(Boolean),
      ...(preferredSymbols.length === 0 ? baselineSymbols : []),
    ]) {
      const clean = String(rawSymbol || '').trim();
      if (!clean) continue;
      const normalized = clean.split(':').pop()?.toUpperCase() || clean.toUpperCase();
      if (!symbolMap.has(normalized)) symbolMap.set(normalized, clean);
    }
    const symbols = Array.from(symbolMap.values());

    const rows = symbols
      .map((symbol) => {
        const normalizedSymbol = String(symbol).split(':').pop()?.toUpperCase() || String(symbol).toUpperCase();
        const matchingEntries = watchlistResults
          .filter((entry) => String(entry.state?.symbol || entry.symbol).split(':').pop()?.toUpperCase() === normalizedSymbol)
          .sort((a, b) => new Date(b.scanned_at || 0).getTime() - new Date(a.scanned_at || 0).getTime());

        const tradeBackedEntry = matchingEntries.find((entry) => entry.trade && (
          hasMeaningfulTradeValue(entry.trade.entryPrice) ||
          hasMeaningfulTradeValue(entry.trade.entryTime) ||
          hasMeaningfulTradeValue(entry.trade.netPnl)
        ));
        if (tradeBackedEntry?.trade) {
          const liveSignal = normalizeTradeDisplay(tradeBackedEntry.trade.signal || 'EXIT').toUpperCase();
          const row = {
            symbol: tradeBackedEntry.state?.symbol || tradeBackedEntry.symbol || symbol,
            signal: liveSignal === 'OPEN' ? 'OPEN' : 'EXIT',
            wasOpen: liveSignal === 'OPEN',
            side: tradeBackedEntry.trade.side || null,
            entryPrice: normalizeTradeDisplay(tradeBackedEntry.trade.entryPrice),
            entryTime: formatEntryTimeDisplay(tradeBackedEntry.trade.entryTime, timezone),
            entryTimeRaw: tradeBackedEntry.trade.entryTime || null,
            // Only meaningful on an EXIT — an open position has not exited, and a non-null value
            // here would let it be rendered as one of today's closes.
            exitTime: liveSignal === 'EXIT' ? (tradeBackedEntry.trade.exitTime || null) : null,
            netPnl: fillTradeMetric(tradeBackedEntry.trade.netPnl, liveSignal),
            favorableExcursion: fillTradeMetric(tradeBackedEntry.trade.favorableExcursion, liveSignal),
            adverseExcursion: fillTradeMetric(tradeBackedEntry.trade.adverseExcursion, liveSignal),
          };
          return isRenderablePriorRow(row) ? row : null;
        }

        const signalBackedEntry = matchingEntries.find((entry) => entry.signal?.hasSignal);
        const isFastWatchlist = (timeframeToMinutes(timeframe) || 0) > 0 && (timeframeToMinutes(timeframe) || 0) <= 30;

        const priorCandidates = Object.entries(baselineSignals)
          .map(([key, value]) => {
            const parts = String(key).split(':');
            const keyTimeframe = parts[parts.length - 1] || value?.timeframe || '';
            const keySymbol = value?.symbol || parts[parts.length - 2] || '';
            const candidateSymbol = String(keySymbol).split(':').pop()?.toUpperCase() || '';
            return {
              key,
              symbol: keySymbol,
              timeframe: String(value?.timeframe || keyTimeframe),
              normalizedSymbol: candidateSymbol,
              ...value,
            };
          })
          .filter((entry) => entry.timeframe === timeframe)
          .filter((entry) => entry.normalizedSymbol === normalizedSymbol)
          .sort((a, b) => new Date(b.last_seen_at || baselineUpdatedAt || 0).getTime() - new Date(a.last_seen_at || baselineUpdatedAt || 0).getTime());

        const latest = priorCandidates[0];
        const latestSavedSignal = normalizeTradeDisplay(latest?.signal_type || '—').toUpperCase();
        const hasSavedHistory = Boolean(latest) && (
          latestSavedSignal === 'OPEN'
          || latestSavedSignal === 'EXIT'
          || hasMeaningfulTradeValue(latest?.entry_price ?? latest?.last_price)
          || hasMeaningfulTradeValue(latest?.entry_time || latest?.last_seen_at)
          || hasMeaningfulTradeValue(latest?.net_pnl)
          || hasMeaningfulTradeValue(latest?.favorable_excursion)
          || hasMeaningfulTradeValue(latest?.adverse_excursion)
        );

        if (signalBackedEntry?.signal?.hasSignal && isFastWatchlist && !hasSavedHistory) {
          return {
            symbol: signalBackedEntry.state?.symbol || signalBackedEntry.symbol || symbol,
            signal: 'OPEN',
            wasOpen: true,
            entryPrice: normalizeTradeDisplay(signalBackedEntry.signal?.price ?? signalBackedEntry.quote?.last, 'n/a'),
            // Label-only signal, no trade read — there is no entry time to show, and the scan
            // timestamp is not one (open_issues.txt Issue 7).
            entryTime: 'No trade time',
            entryTimeRaw: null,
            netPnl: 'In progress',
            favorableExcursion: 'In progress',
            adverseExcursion: 'In progress',
          };
        }

        if (!latest) {
          return {
            symbol,
            signal: '—',
            entryPrice: 'Unavailable',
            entryTime: 'No prior trade recorded',
            entryTimeRaw: null,
            netPnl: 'Unavailable',
            favorableExcursion: 'Unavailable',
            adverseExcursion: 'Unavailable',
            wasOpen: false,
          };
        }

        // Only a real recorded entry time counts here — last_seen_at and baselineUpdatedAt
        // are scan timestamps, and substituting them fabricates entry dates that break the
        // recency gates and mislabel Open Trades (open_issues.txt Issue 7).
        const latestEntryTime = latest.entry_time || null;
        const latestSignal = normalizeTradeDisplay(latest.signal_type || 'EXIT').toUpperCase();
        const keepOpenVisible = latestSignal === 'OPEN'
          && isSameOrPreviousTradingDay(latestEntryTime, baselineUpdatedAt || new Date().toISOString(), timezone);
        const resolvedSignal = keepOpenVisible ? 'OPEN' : (latestSignal === 'OPEN' ? 'EXIT' : latestSignal);
        const row = {
          symbol: latest.symbol || symbol,
          signal: resolvedSignal,
          wasOpen: latestSignal === 'OPEN',
          entryPrice: normalizeTradeDisplay(latest.entry_price ?? latest.last_price ?? 'n/a'),
          entryTime: formatEntryTimeDisplay(latest.entry_time, timezone),
          entryTimeRaw: latest.entry_time || null,
          // A stale OPEN that `keepOpenVisible` just relabelled to EXIT carries exit_time: null (it
          // never actually exited), so it is excluded from today's-exit rendering without a special
          // case. Records written before exit_time existed are null too and simply don't restate.
          exitTime: resolvedSignal === 'EXIT' ? (latest.exit_time || null) : null,
          netPnl: fillTradeMetric(latest.net_pnl, resolvedSignal),
          favorableExcursion: fillTradeMetric(latest.favorable_excursion, resolvedSignal),
          adverseExcursion: fillTradeMetric(latest.adverse_excursion, resolvedSignal),
        };

        return isRenderablePriorRow(row) ? row : {
          symbol: latest.symbol || symbol,
          signal: '—',
          entryPrice: hasMeaningfulTradeValue(latest.entry_price ?? latest.last_price) ? normalizeTradeDisplay(latest.entry_price ?? latest.last_price) : 'Unavailable',
          entryTime: hasMeaningfulTradeValue(latest.entry_time) ? formatEntryTimeDisplay(latest.entry_time, timezone) : 'No prior trade recorded',
          entryTimeRaw: latest.entry_time || null,
          netPnl: hasMeaningfulTradeValue(latest.net_pnl) ? normalizeTradeDisplay(latest.net_pnl) : 'Unavailable',
          favorableExcursion: hasMeaningfulTradeValue(latest.favorable_excursion) ? normalizeTradeDisplay(latest.favorable_excursion) : 'Unavailable',
          adverseExcursion: hasMeaningfulTradeValue(latest.adverse_excursion) ? normalizeTradeDisplay(latest.adverse_excursion) : 'Unavailable',
          wasOpen: latestSignal === 'OPEN',
        };
      })
      .filter(Boolean);

    rows.sort((a, b) => {
      const rank = { OPEN: 0, EXIT: 1, '—': 2 };
      return (rank[a.signal] ?? 9) - (rank[b.signal] ?? 9)
        || (parseEntryTimestamp(b.entryTime) - parseEntryTimestamp(a.entryTime))
        || String(a.symbol).localeCompare(String(b.symbol));
    });

    return {
      watchlistName,
      timeframe,
      source: target.source || 'watchlist_unavailable',
      symbolCount: Number(target.symbol_count || symbols.length || 0),
      trades: rows,
    };
  });
}

export function buildWatchlistSummaryLines(
  watchlistSummaries = [],
  results = [],
  priorSignalsByWatchlist = [],
  timezone = DEFAULT_MARKET_HOURS.timezone,
  marketHours = DEFAULT_MARKET_HOURS,
  openTrades = [],
) {
  return watchlistSummaries.map((summary) => {
    const watchlistName = summary.watchlist_name || summary.watchlistName || 'Watchlist';
    const timeframe = String(summary.timeframe || '');
    const priorSection = priorSignalsByWatchlist.find(
      (section) => section.watchlistName === watchlistName && String(section.timeframe || '') === timeframe,
    );
    const displayedCount = Number(summary.symbol_count || priorSection?.symbolCount || 0);
    const scanTimestamp = summary.scanned_at || Date.now();
    const prefix = `${formatTimestamp(scanTimestamp, timezone)} ET | WATCHLIST: ${watchlistName} | SYMBOLS: ${displayedCount} | SCAN: ${formatDuration(summary.scan_duration_ms)}`;

    // Still-open (recent-bar-or-same-day) positions from the baseline — the same fallback a scanned
    // watchlist with no fresh results already uses below. Computed before the skipped-schedule check
    // so a watchlist not due this tick can still restate what's open, instead of the log going quiet
    // about it until that timeframe's own bar comes due (user report 2026-07-29: a same-day 30m open
    // position looked "dropped" from the log after a 15m-only tick — the position itself was never
    // lost, buildOpenTrades already reconstructs it from baseline fine; only this line went silent).
    const fallbackOpenTrades = (Array.isArray(priorSection?.trades) ? priorSection.trades : [])
      .filter((row) => String(row.signal || '').toUpperCase() === 'OPEN')
      .filter((row) => isRecentTradeSignal(row.entryTime, scanTimestamp, timeframe)
        || isSameTradingDay(row.entryTime, scanTimestamp, timezone))
      .sort((a, b) => parseEntryTimestamp(b.entryTime) - parseEntryTimestamp(a.entryTime));

    // Positions that ENTERED TODAY (ET), restated on every tick until the date rolls over — whether
    // or not this watchlist was due. The log answers "what happened today"; the Open Trades table
    // remains the full holdings view, so a position entered on an earlier day is deliberately absent
    // here even while it is still held.
    //
    // Sourced from the open-trades list the Open Trades table renders, NOT from priorSection.trades,
    // for a reason that is easy to undo by accident: buildPriorSignalsByWatchlist's `keepOpenVisible`
    // relabels an OPEN as EXIT off `isSameOrPreviousTradingDay(entryTime, baselineUpdatedAt)`, so a
    // stale baselineUpdatedAt can hide a genuinely same-day entry before it ever reaches this
    // function. Reading the same list the table reads removes that dependency entirely.
    //
    // entryTimeRaw (ISO) is preferred over entryTime (ET display string) so a row restated from the
    // baseline prints in the same format as one read from a fresh scan — the two paths formatted it
    // differently before, so which format you saw depended on whether the watchlist was due.
    const todaysOpenRows = (Array.isArray(openTrades) ? openTrades : [])
      .filter((row) => row.watchlistName === watchlistName
        && String(row.timeframe || '') === timeframe
        && String(row.signal || 'OPEN').toUpperCase() === 'OPEN')
      .filter((row) => isSameTradingDay(row.entryTimeRaw || row.entryTime, scanTimestamp, timezone))
      .sort((a, b) => parseEntryTimestamp(b.entryTimeRaw || b.entryTime)
        - parseEntryTimestamp(a.entryTimeRaw || a.entryTime))
      .map((row) => ({
        symbol: row.symbol || 'n/a',
        entryPrice: row.entryPrice,
        entryTime: row.entryTimeRaw || row.entryTime,
      }));

    // Degrade to the old baseline-reconstructed rows when no open-trades list was supplied, so a
    // caller that predates this parameter keeps its previous behaviour instead of rendering nothing.
    const openRowsToShow = todaysOpenRows.length > 0 ? todaysOpenRows : fallbackOpenTrades;

    // Positions that EXITED TODAY, restated from the baseline's exit_time (see updateBaselineEntry).
    // Without this an exit was visible only on the tick that scanned it — a 2H exit shown at 12:01
    // was gone by 12:16, because the block is rewritten on every tick while EXIT rows came only from
    // a fresh scan's results. Keyed on exitTime, never entryTime: a closed trade's entry can be days
    // old, so it cannot tell a fresh close from an ancient one.
    const restatedExits = (Array.isArray(priorSection?.trades) ? priorSection.trades : [])
      .filter((row) => String(row.signal || '').toUpperCase() === 'EXIT')
      .filter((row) => row.exitTime && isSameTradingDay(row.exitTime, scanTimestamp, timezone))
      .map((row) => ({
        symbol: row.symbol || 'n/a',
        exitTime: row.exitTime,
        netPnl: row.netPnl,
      }));

    // Merge fresh-scan exits over restated ones, deduped by bare ticker so an exchange-prefix change
    // between scans (BATS:X vs AMEX:X — see updateBaselineEntry's altKey match) can't list one close
    // twice. A fresh read wins: it carries this scan's real netPnl rather than the stored one.
    const mergeExitRows = (fresh = [], restated = []) => {
      const byTicker = new Map();
      for (const row of restated) byTicker.set(normalizeSymbolForMatch(row.symbol), row);
      for (const row of fresh) byTicker.set(normalizeSymbolForMatch(row.symbol), row);
      return Array.from(byTicker.values())
        .sort((a, b) => parseEntryTimestamp(b.exitTime) - parseEntryTimestamp(a.exitTime));
    };

    if (summary.skipped_due_schedule) {
      const openDetails = openRowsToShow
        .map((row) => `  OPEN: ${row.symbol || 'n/a'} | ENTRY: ${normalizeTradeDisplay(row.entryPrice)} | AT: ${normalizeTradeDisplay(row.entryTime)}`);
      // A skipped watchlist has no fresh results, so its exits are entirely restated.
      const skippedExits = mergeExitRows([], restatedExits);
      const exitDetails = skippedExits
        .map((row) => `  EXIT: ${row.symbol || 'n/a'} | P&L: ${formatPnlPercentOrUsd(row.netPnl)} | AT: ${normalizeTradeDisplay(row.exitTime)}`);
      const exitGroup = exitDetails.length > 0
        ? [buildExitSummary(skippedExits), ...exitDetails].filter(Boolean)
        : [];
      const groups = [openDetails, exitGroup].filter((g) => g.length > 0);
      const suffix = groups.length > 0 ? `\n${groups.map((g) => g.join('\n')).join('\n\n')}` : '';
      const nextDueEt = getNextScheduledRunLabel(scanTimestamp, marketHours, timeframe);
      return `${prefix} | WAITING FOR NEXT ${timeframe || 'WATCHLIST'} BAR (next: ${nextDueEt})${suffix}`;
    }

    const recentOpenTrades = results
      .filter((entry) => entry.watchlist_name === watchlistName && !entry.error)
      .filter((entry) => String(entry.trade?.signal || '').toUpperCase() === 'OPEN')
      .filter((entry) => isRecentTradeSignal(entry.trade?.entryTime, entry.scanned_at, entry.timeframe)
        || isSameTradingDay(entry.trade?.entryTime, entry.scanned_at, timezone))
      .sort(
        (a, b) => parseEntryTimestamp(b.trade?.entryTime) - parseEntryTimestamp(a.trade?.entryTime)
          || new Date(b.scanned_at || 0).getTime() - new Date(a.scanned_at || 0).getTime(),
      );

    // todaysOpenRows already covers this watchlist's fresh OPEN reads — buildOpenTrades merges the
    // current scan's results with the baseline — so the fresh-results path below is only the degrade
    // route for a caller that supplied no open-trades list.
    const rowsToShow = todaysOpenRows.length > 0
      ? todaysOpenRows
      : recentOpenTrades.length > 0
        ? recentOpenTrades.map((entry) => ({
            symbol: entry.state?.symbol || entry.symbol || 'n/a',
            entryPrice: normalizeTradeDisplay(entry.trade?.entryPrice),
            entryTime: normalizeTradeDisplay(entry.trade?.entryTime),
          }))
        : fallbackOpenTrades;

    // Keyed on exitTime — entryTime on an EXIT trade is when the now-closed position originally
    // opened (possibly days earlier), not when it closed, so it can't tell a fresh exit apart from
    // an old one already shown on a prior scan.
    const recentExits = results
      .filter((entry) => entry.watchlist_name === watchlistName && !entry.error)
      .filter((entry) => String(entry.trade?.signal || '').toUpperCase() === 'EXIT')
      .filter((entry) => isRecentTradeSignal(entry.trade?.exitTime, entry.scanned_at, entry.timeframe)
        || isSameTradingDay(entry.trade?.exitTime, entry.scanned_at, timezone))
      .sort(
        (a, b) => parseEntryTimestamp(b.trade?.exitTime) - parseEntryTimestamp(a.trade?.exitTime)
          || new Date(b.scanned_at || 0).getTime() - new Date(a.scanned_at || 0).getTime(),
      )
      .map((entry) => ({
        symbol: entry.state?.symbol || entry.symbol || 'n/a',
        exitTime: normalizeTradeDisplay(entry.trade?.exitTime),
        netPnl: normalizeTradeDisplay(entry.trade?.netPnl),
      }));

    // Union with today's restated exits, so an earlier close on this watchlist stays visible on a
    // later scan of it rather than only on the tick that first read it.
    const exitsToShow = mergeExitRows(recentExits, restatedExits);
    const exitSummary = buildExitSummary(exitsToShow);

    if (rowsToShow.length > 0 || exitsToShow.length > 0) {
      const openDetails = rowsToShow
        .map((row) => `  OPEN: ${row.symbol || 'n/a'} | ENTRY: ${normalizeTradeDisplay(row.entryPrice)} | AT: ${normalizeTradeDisplay(row.entryTime)}`);
      const exitDetails = exitsToShow
        .map((row) => `  EXIT: ${row.symbol || 'n/a'} | P&L: ${formatPnlPercentOrUsd(row.netPnl)} | AT: ${normalizeTradeDisplay(row.exitTime)}`);
      const exitGroup = exitDetails.length > 0
        ? [exitSummary, ...exitDetails].filter(Boolean)
        : [];
      // Grouped OPEN-then-EXIT (never interleaved), with a blank line between the two groups when
      // both are present — so a busy block reads as two clearly separate lists rather than one
      // run-on block. The per-row "OPEN:"/"EXIT:" prefix is untouched so hasMeaningfulSummary's
      // /OPEN:\s*\w/i and /EXIT:\s*\w/i regex checks keep matching every row, not just a header.
      const groups = [openDetails, exitGroup].filter((g) => g.length > 0);
      const details = groups.map((g) => g.join('\n')).join('\n\n');
      return `${prefix} | SIGNAL\n${details}`;
    }

    return `${prefix} | NO SIGNAL`;
  });
}

export function buildOpenTrades(
  priorSignalsByWatchlist = [],
  baselineSignals = {},
  asOf = new Date().toISOString(),
  timezone = DEFAULT_MARKET_HOURS.timezone,
  results = [],
) {
  const rowsByKey = new Map();

  const openResultRows = Array.isArray(results)
    ? results
      .filter((entry) => String(entry.trade?.signal || '').toUpperCase() === 'OPEN')
      .filter((entry) => isRecentTradeSignal(entry.trade?.entryTime, entry.scanned_at, entry.timeframe)
        || isSameTradingDay(entry.trade?.entryTime, asOf, timezone))
      .map((entry) => ({
        watchlistName: entry.watchlist_name || 'Watchlist',
        timeframe: entry.timeframe,
        symbol: entry.state?.symbol || entry.symbol || 'n/a',
        signal: 'OPEN',
        // LONG/SHORT from the strategy's own trade read. The manual webhook Send derives buy/sell
        // from this; absent it the dashboard falls back to LONG, which is wrong on a short.
        side: entry.trade?.side || null,
        entryPrice: normalizeTradeDisplay(entry.trade?.entryPrice ?? entry.signal?.price ?? entry.quote?.last),
        // Never substitute the scan timestamp for a missing entry time — that fabrication
        // produced wrong dates in Open Trades and broke the recency-based signal/notify
        // gates (open_issues.txt Issue 7). Null means "entry time unknown", full stop.
        entryTime: entry.trade?.entryTime || null,
        entryTimeRaw: entry.trade?.entryTime || null,
        netPnl: normalizeTradeDisplay(entry.trade?.netPnl, 'In progress'),
        favorableExcursion: normalizeTradeDisplay(entry.trade?.favorableExcursion, 'In progress'),
        adverseExcursion: normalizeTradeDisplay(entry.trade?.adverseExcursion, 'In progress'),
      }))
    : [];

  const addRow = (section, row, { requireRecentEntry = false, overwrite = true } = {}) => {
    const signal = String(row?.signal || '—').toUpperCase();
    const symbol = row?.symbol || 'n/a';
    const entryTime = row?.entryTime || row?.entry_time || 'No prior trade recorded';
    if (signal !== 'OPEN') return;
    if (!hasMeaningfulTradeValue(entryTime)) return;
    if (requireRecentEntry && !isSameOrPreviousTradingDay(entryTime, asOf, timezone)) return;

    const key = `${section?.watchlistName || section?.watchlist_name || 'Watchlist'}|${section?.timeframe || ''}|${normalizeSymbolForMatch(symbol)}`;
    if (!overwrite && rowsByKey.has(key)) return;
    rowsByKey.set(key, {
      watchlistName: section?.watchlistName || section?.watchlist_name || 'Watchlist',
      timeframe: section?.timeframe || row?.timeframe || '—',
      symbolCount: Number(section?.symbolCount || section?.symbol_count || 0),
      symbol,
      signal: 'OPEN',
      wasOpen: true,
      side: row?.side || null,
      entryPrice: normalizeTradeDisplay(row?.entryPrice ?? row?.entry_price),
      entryTime: formatEntryTimeDisplay(entryTime, timezone),
      // Canonical (raw ISO) entry time, distinct from the display string above — the webhook
      // dedupe ledger keys on this, not the display format, so both the manual Send button and
      // the auto-dispatch path (which keys straight off entry.trade.entryTime) land on the same
      // key for the same position. Null when no raw source exists (label-only/no-history rows).
      entryTimeRaw: row?.entryTimeRaw || row?.entry_time_raw || null,
      netPnl: fillTradeMetric(row?.netPnl ?? row?.net_pnl, 'OPEN'),
      favorableExcursion: fillTradeMetric(row?.favorableExcursion ?? row?.favorable_excursion, 'OPEN'),
      adverseExcursion: fillTradeMetric(row?.adverseExcursion ?? row?.adverse_excursion, 'OPEN'),
    });
  };

  for (const row of openResultRows) {
    addRow({ watchlistName: row.watchlistName, timeframe: row.timeframe }, row, { requireRecentEntry: false });
  }

  for (const section of priorSignalsByWatchlist) {
    for (const row of (Array.isArray(section.trades) ? section.trades : [])) {
      addRow(section, row, { requireRecentEntry: false });
    }
  }

  // Second pass: fill in any OPEN trades from the baseline that the first pass missed
  // (e.g. symbols not in the currently scanned watchlists).
  //
  // Deduplicate by (normalizedSymbol, timeframe): use only the most recent baseline entry
  // per pair so that stale synthetic OPEN entries (different exchange prefix, no real trade
  // data) do not shadow a more recent EXIT written by an actual scan.
  const newestByNormKey = new Map();
  for (const entry of Object.values(baselineSignals || {})) {
    const nk = `${normalizeSymbolForMatch(entry?.symbol || '')}|${entry?.timeframe || ''}`;
    const ex = newestByNormKey.get(nk);
    if (!ex || new Date(entry?.last_seen_at || 0) > new Date(ex?.last_seen_at || 0)) {
      newestByNormKey.set(nk, entry);
    }
  }

  for (const entry of newestByNormKey.values()) {
    if (String(entry?.signal_type || '').toUpperCase() !== 'OPEN') continue;

    const timeframe = String(entry?.timeframe || '');
    const symbol = entry?.symbol || 'n/a';
    const matchingSection = priorSignalsByWatchlist.find(
      (section) => String(section?.timeframe || '') === timeframe,
    );

    if (!matchingSection) continue;

    // Only add if this symbol already appears in the section's trades (regardless of signal).
    // Symbols not in any watchlist's tracked set should not be resurrected from the baseline.
    const normalizedSymbol = normalizeSymbolForMatch(symbol);
    const sectionTrades = Array.isArray(matchingSection.trades) ? matchingSection.trades : [];
    const existingRow = sectionTrades.find(
      (r) => normalizeSymbolForMatch(r.symbol || '') === normalizedSymbol,
    );
    if (!existingRow) continue;

    // overwrite:false — the first pass (live scan data) takes priority over baseline values.
    // entry_time only: last_seen_at is a scan timestamp, not an entry time (Issue 7); a row
    // without a real entry time is skipped by addRow until the next scan records one.
    addRow(matchingSection, {
      symbol,
      timeframe,
      signal: 'OPEN',
      entryPrice: entry?.entry_price,
      entryTime: entry?.entry_time || null,
      entryTimeRaw: entry?.entry_time || null,
      netPnl: entry?.net_pnl,
      favorableExcursion: entry?.favorable_excursion,
      adverseExcursion: entry?.adverse_excursion,
    }, { requireRecentEntry: false, overwrite: false });
  }

  return Array.from(rowsByKey.values()).sort(
    (a, b) => parseEntryTimestamp(b.entryTime) - parseEntryTimestamp(a.entryTime)
      || String(a.watchlistName || '').localeCompare(String(b.watchlistName || ''))
      || String(a.symbol || '').localeCompare(String(b.symbol || '')),
  );
}

function sanitizePriorSignalsForDisplay(sections = []) {
  return (Array.isArray(sections) ? sections : []).map((section) => ({
    ...section,
    trades: (Array.isArray(section.trades) ? section.trades : []).map((row) => {
      const signal = String(row.signal || '—').toUpperCase();
      return {
        ...row,
        entryPrice: hasMeaningfulTradeValue(row.entryPrice)
          ? row.entryPrice
          : 'Unavailable',
        entryTime: hasMeaningfulTradeValue(row.entryTime)
          ? row.entryTime
          : 'No prior trade recorded',
        netPnl: hasMeaningfulTradeValue(row.netPnl)
          ? row.netPnl
          : signal === 'OPEN' ? 'In progress' : 'Unavailable',
        favorableExcursion: hasMeaningfulTradeValue(row.favorableExcursion)
          ? row.favorableExcursion
          : signal === 'OPEN' ? 'In progress' : 'Unavailable',
        adverseExcursion: hasMeaningfulTradeValue(row.adverseExcursion)
          ? row.adverseExcursion
          : signal === 'OPEN' ? 'In progress' : 'Unavailable',
      };
    }),
  }));
}

function normalizeSymbolForMatch(value) {
  return String(value || '').split(':').pop()?.toUpperCase() || String(value || '').toUpperCase();
}

export function buildDailySignalLinesFromLog(dayLogEvents = [], timezone = DEFAULT_MARKET_HOURS.timezone) {
  return dayLogEvents
    .map((event) => {
      const symbol = String(event.symbol || event.ticker || '').trim();
      if (!symbol) return null;

      const action = String(event.action || event.signal || event.direction || '').toUpperCase();
      const signal = /SELL|SHORT|EXIT/.test(action) ? 'EXIT' : 'OPEN';
      const direction = /SELL|SHORT/.test(action) ? 'SHORT' : /BUY|LONG/.test(action) ? 'LONG' : signal;
      const watchlistName = String(event.watchlistName || event.watchlist || 'Swing 15m').trim();
      const timestamp = event.timestamp || event.entryTime || event.at || event.time || '';
      const price = normalizeTradeDisplay(event.price, 'n/a');
      return `${formatEntryTimeDisplay(timestamp, timezone)} | WATCHLIST: ${watchlistName} | ${symbol} | SIGNAL: ${signal} ${direction} | PRICE: ${price}`;
    })
    .filter(Boolean);
}

export function validateWatchlistRegression({
  watchlistName = 'Swing 15m',
  topLines = [],
  priorSignals = [],
  dayLogEvents = [],
  asOf = new Date().toISOString(),
  timezone = DEFAULT_MARKET_HOURS.timezone,
} = {}) {
  const errors = [];
  const normalizedWatchlist = String(watchlistName || '').trim().toLowerCase();
  const section = (Array.isArray(priorSignals) ? priorSignals : []).find(
    (entry) => String(entry.watchlistName || '').trim().toLowerCase() === normalizedWatchlist,
  );

  if (!section) {
    return { ok: false, errors: [`Missing prior signal section for ${watchlistName}.`], section: null };
  }

  const trades = Array.isArray(section.trades) ? section.trades : [];
  if (Number(section.symbolCount || 0) !== trades.length) {
    errors.push(`Row count mismatch for ${watchlistName}: expected ${section.symbolCount || 0}, got ${trades.length}.`);
  }

  const todayLogEvents = (Array.isArray(dayLogEvents) ? dayLogEvents : []).filter((event) => {
    const eventWatchlist = String(event.watchlistName || event.watchlist || watchlistName).trim().toLowerCase();
    return eventWatchlist === normalizedWatchlist && isSameTradingDay(event.timestamp || event.entryTime || event.at || asOf, asOf, timezone);
  });

  for (const event of todayLogEvents) {
    const expectedSymbol = normalizeSymbolForMatch(event.symbol || event.ticker);
    const expectedStatus = /SELL|SHORT|EXIT/.test(String(event.action || event.signal || '').toUpperCase()) ? 'EXIT' : 'OPEN';
    const matched = (Array.isArray(topLines) ? topLines : []).some((line) => {
      const upper = String(line || '').toUpperCase();
      return upper.includes(expectedSymbol) && upper.includes(expectedStatus);
    });
    if (!matched) {
      errors.push(`Top section is missing today's ${expectedStatus} event for ${event.symbol}.`);
    }
  }

  for (const row of trades) {
    const signal = String(row.signal || '—').toUpperCase();
    const isOpenToday = signal === 'OPEN' && isSameTradingDay(row.entryTime, asOf, timezone);

    if (isOpenToday) continue;

    if (signal === '—') {
      errors.push(`${row.symbol || 'Unknown symbol'} is missing a resolved prior trade state.`);
      continue;
    }

    if (!hasMeaningfulTradeValue(row.entryTime) || String(row.entryTime).trim() === 'No trade time') {
      errors.push(`${row.symbol || 'Unknown symbol'} is missing a usable entry date.`);
      continue;
    }

    if (isSameTradingDay(row.entryTime, asOf, timezone)) {
      errors.push(`${row.symbol || 'Unknown symbol'} should only show today's date when the trade is still OPEN.`);
    }

    for (const [label, value] of [
      ['entry price', row.entryPrice],
      ['net pnl', row.netPnl],
      ['favorable excursion', row.favorableExcursion],
      ['adverse excursion', row.adverseExcursion],
    ]) {
      if (!hasMeaningfulTradeValue(value)) {
        errors.push(`${row.symbol || 'Unknown symbol'} is missing ${label}.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    section,
  };
}

async function resolveSymbolsForWatchlist(target, fallbackSymbols, options = {}) {
  const {
    allowFallback = true,
    baselineWatchlists = {},
    baselineSignals = {},
  } = options;

  try {
    await watchlist.select({ name: target.watchlistName });
    const current = await watchlist.get();
    if (current?.count > 0) {
      return {
        symbols: current.symbols.map((item) => item.symbol).filter(Boolean),
        count: current.count,
        source: 'tradingview_panel',
      };
    }
  } catch {}

  const storedSymbols = Array.isArray(baselineWatchlists?.[target.watchlistName]?.symbols)
    ? baselineWatchlists[target.watchlistName].symbols.filter(Boolean)
    : [];

  const historicalSymbols = Object.values(baselineSignals || {})
    .filter((entry) => String(entry?.timeframe || '') === String(target.timeframe || ''))
    .map((entry) => entry?.symbol)
    .filter(Boolean);

  const resolvedFallback = storedSymbols.length > 0
    ? storedSymbols
    : historicalSymbols.length > 0
      ? Array.from(new Set(historicalSymbols))
      : Array.isArray(target.symbols) && target.symbols.length > 0
        ? target.symbols
        : fallbackSymbols;

  if (!allowFallback && resolvedFallback.length === 0) {
    return {
      symbols: [],
      count: 0,
      source: 'watchlist_unavailable',
    };
  }

  return {
    symbols: resolvedFallback,
    count: resolvedFallback.length,
    source: storedSymbols.length > 0 ? 'baseline_watchlist' : historicalSymbols.length > 0 ? 'baseline_history' : 'rules_fallback',
  };
}

function normalizeWatchlistName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/minutes?/g, 'm')
    .replace(/mins?/g, 'm')
    .replace(/hours?/g, 'h')
    .replace(/hrs?/g, 'h')
    .replace(/days?/g, 'd')
    .replace(/daily/g, 'd')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Fallback for the dashboard's Watchlist Symbols panel on any scan that didn't itself run a live
 * TradingView resync.
 *
 * `syncWatchlistSymbolsFromTradingView()` only runs once or twice a day (gated by
 * `watchlist-sync-state.json`'s open/close dates), so on every OTHER scan `result.watchlist_sync`
 * was `[]` — and because `writeLatestStatus()` overwrites the whole status file every run, that
 * empty array clobbered whatever the sync scan had written minutes earlier. The panel showed real
 * data for the ~15 minutes between a sync scan and the next regular one, then went blank for the
 * rest of the day — read as "seeding failed" even though `baseline.watchlists` (the actual source
 * of truth, updated by the sync regardless of which scan triggered it) was fine the whole time.
 * This just re-derives the same display shape from that persisted baseline instead of from the
 * current scan's (usually empty) live-sync result.
 */
function buildWatchlistSyncFromBaseline(baseline, watchlistNames = null) {
  // `baseline.watchlists` accumulates dead entries under old names forever — nothing prunes them on
  // a rename, since syncWatchlistSymbolsFromTradingView only ever iterates rules.json's configured
  // names. Without this allowlist the panel reports a watchlist that is not being scanned as though
  // it were: observed live 2026-08-01 showing 9 watchlists, the extra one being a superseded
  // `"Swing 30min"` still listing KORU as a 30m member weeks after it was removed from the real
  // list. Same allowlist that findWatchlistOrphans and buildWatchlistMembership already require.
  const allowed = Array.isArray(watchlistNames) ? new Set(watchlistNames) : null;
  return Object.entries(baseline?.watchlists || {})
    .filter(([watchlistName]) => !allowed || allowed.has(watchlistName))
    .map(([watchlistName, w]) => ({
      watchlistName,
      timeframe: w?.timeframe || null,
      symbols: Array.isArray(w?.symbols) ? w.symbols : [],
      count: Array.isArray(w?.symbols) ? w.symbols.length : 0,
      source: w?.source || "watchlist_unavailable",
      selected: null,
      activeWatchlistName: null,
      selectError: null,
      cached: true,
    }));
}

export async function syncWatchlistSymbolsFromTradingView({
  rules,
  baselinePath = DEFAULT_BASELINE_PATH,
  allowFallback = true,
  watchlistModule = watchlist,
} = {}) {
  const actualRules = rules && Object.keys(rules).length > 0 ? rules : loadRules().rules;
  const { watchlist: fallbackSymbols = [], default_timeframe = '240', watchlists = {} } = actualRules;
  const watchlistNames = Object.keys(watchlists);
  if (!watchlistNames.length) {
    return { success: true, synced: [] };
  }

  const rawBaseline = parseJsonFile(baselinePath, {});
  rawBaseline.watchlists = rawBaseline.watchlists || {};

  const original = await watchlistModule.getActiveName?.().catch(() => ({ name: null })) || { name: null };
  const watchlistOptionsResult = await watchlistModule.getWatchlistOptions?.().catch(() => ({ options: [], activeName: null })) || { options: [], activeName: null };
  const synced = [];
  const now = new Date().toISOString();

  for (const watchlistName of watchlistNames) {
    const config = watchlists[watchlistName];
    const timeframe = typeof config === 'object'
      ? String(config.timeframe || default_timeframe)
      : String(config || default_timeframe);

    let symbols = [];
    let count = 0;
    let source = 'watchlist_unavailable';
    let selected = false;
    let activeWatchlistName = null;
    let selectError = null;

    try {
      const selectedResult = await watchlistModule.select({ name: watchlistName });
      selected = Boolean(selectedResult?.changed || selectedResult?.success);
      activeWatchlistName = selectedResult?.name || null;
      const current = await watchlistModule.get();
      if (current?.count > 0 && Array.isArray(current.symbols)) {
        symbols = current.symbols.map((item) => String(item?.symbol || item).trim()).filter(Boolean);
        count = current.count || symbols.length;
        source = current.source || 'tradingview_panel';
      }
    } catch (error) {
      selectError = String(error?.message || error);
      const currentActive = await watchlistModule.getActiveName().catch(() => ({ name: null }));
      activeWatchlistName = currentActive?.name || null;
      if (activeWatchlistName && normalizeWatchlistName(activeWatchlistName) === normalizeWatchlistName(watchlistName)) {
        try {
          const current = await watchlistModule.get();
          if (current?.count > 0 && Array.isArray(current.symbols)) {
            symbols = current.symbols.map((item) => String(item?.symbol || item).trim()).filter(Boolean);
            count = current.count || symbols.length;
            source = current.source || 'tradingview_panel';
            selected = false;
            selectError = `select failed but active watchlist matches (${activeWatchlistName})`;
          }
        } catch {
          source = 'watchlist_unavailable';
        }
      } else {
        source = 'watchlist_unavailable';
      }
    }

    const existing = rawBaseline.watchlists[watchlistName] || {};
    const resolvedSymbols = symbols.length > 0
      ? symbols
      : existing.symbols?.length > 0
        ? existing.symbols
        : (allowFallback && fallbackSymbols.length > 0 ? fallbackSymbols : []);
    const resolvedSource = symbols.length > 0
      ? source
      : existing.symbols?.length > 0
        ? existing.source || 'watchlist_unavailable'
        : (allowFallback && fallbackSymbols.length > 0 ? 'rules_fallback' : 'watchlist_unavailable');
    rawBaseline.watchlists[watchlistName] = {
      ...existing,
      timeframe,
      updated_at: now,
      symbols: resolvedSymbols,
      symbol_count: symbols.length > 0 ? count : resolvedSymbols.length,
      source: resolvedSource,
    };

    synced.push({
      watchlistName,
      timeframe,
      symbols: resolvedSymbols,
      count: resolvedSymbols.length,
      source: rawBaseline.watchlists[watchlistName].source,
      selected,
      activeWatchlistName,
      selectError,
    });
  }

  writeJsonFile(baselinePath, rawBaseline);

  if (original?.name) {
    try {
      await watchlistModule.select({ name: original.name });
    } catch {}
  }

  return {
    success: true,
    synced,
    watchlists: rawBaseline.watchlists,
    watchlistOptions: watchlistOptionsResult.options || [],
    activeWatchlistName: watchlistOptionsResult.activeName || null,
  };
}

export async function seedCurrentWatchlistToBaseline({
  watchlistName,
  baselinePath,
  watchlistModule = watchlist,
} = {}) {
  const { rules, path: rulesPath } = loadRules();
  const resolvedBaseline = baselinePath || resolve(rules.baseline_file || DEFAULT_BASELINE_PATH);
  const { watchlists = {}, default_timeframe = '240' } = rules;

  const activeName = await watchlistModule.getActiveName().catch(() => ({ name: null }));
  const name = watchlistName || activeName?.name;
  if (!name) throw new Error('Could not determine watchlist name. Pass a name explicitly or ensure TradingView watchlist panel is visible.');

  const config = watchlists[name];
  const timeframe = config
    ? String(typeof config === 'object' ? (config.timeframe || default_timeframe) : config)
    : default_timeframe;

  const current = await watchlistModule.get();
  if (!current?.count || !Array.isArray(current.symbols) || current.symbols.length === 0) {
    throw new Error(`No symbols visible in the watchlist panel (source: ${current?.source}). Make sure the right watchlist is open in TradingView.`);
  }
  const symbols = current.symbols.map((item) => String(item?.symbol || item).trim()).filter(Boolean);

  const rawBaseline = parseJsonFile(resolvedBaseline, {});
  rawBaseline.watchlists = rawBaseline.watchlists || {};
  rawBaseline.watchlists[name] = {
    ...(rawBaseline.watchlists[name] || {}),
    timeframe,
    updated_at: new Date().toISOString(),
    symbols,
    symbol_count: symbols.length,
    source: 'tradingview_panel',
  };
  writeJsonFile(resolvedBaseline, rawBaseline);

  return { success: true, watchlistName: name, symbols, count: symbols.length, timeframe };
}

export function formatSignalLine(entry, timezone = DEFAULT_MARKET_HOURS.timezone) {
  const symbol = entry.state?.symbol || entry.symbol;
  const tradeSignal = String(entry.trade?.signal || '').toUpperCase();
  const direction = tradeSignal === 'OPEN'
    ? 'OPEN'
    : entry.signal?.direction === 'bullish'
      ? 'LONG'
      : entry.signal?.direction === 'bearish'
        ? 'SHORT'
        : 'SIGNAL';
  const price = entry.signal?.price ?? entry.trade?.entryPrice ?? entry.quote?.last ?? 'n/a';
  const note = entry.signal?.text || (tradeSignal === 'OPEN' ? 'Open trade detected' : 'Signal detected');
  const watchlistName = entry.watchlist_name || 'Default';
  const symbolCount = entry.watchlist_symbol_count ?? 'n/a';
  const stamp = formatTimestamp(entry.scanned_at || Date.now(), timezone);
  return `${stamp} ET | WATCHLIST: ${watchlistName} | SYMBOLS: ${symbolCount} | ${symbol} | SIGNAL: ${direction} | TF: ${entry.timeframe} | PRICE: ${price} | ${note}`;
}

export function createDashboardStatus(result = {}) {
  const watchlistSummaryLines = Array.isArray(result.watchlist_summary_lines) ? result.watchlist_summary_lines : [];
  const signalLines = Array.isArray(result.signal_lines) ? result.signal_lines : [];
  const hasOpenSummary = watchlistSummaryLines.some((line) => /SIGNAL:\s*OPEN\b|OPEN:\s*/i.test(line));

  // Use watchlist summary lines when they contain meaningful signal content. Only fall
  // through to signal_lines if all summary lines say NO SIGNAL *and* signal_lines contains
  // an EXIT event — that means a position closed this scan and should be surfaced even when
  // the watchlist summary doesn't highlight it. OPEN/LONG signals in signal_lines should not
  // override a "NO SIGNAL" summary (they may reflect prior-day positions, not today's entry).
  const hasMeaningfulSummary = watchlistSummaryLines.some((line) =>
    /SIGNAL:\s*(OPEN|EXIT)\b/i.test(line) || /OPEN:\s*\w/i.test(line) || /EXIT:\s*\w/i.test(line),
  );
  const hasExitSignalLines = signalLines.some((line) => /SIGNAL:\s*EXIT\b/i.test(line));
  const lines = watchlistSummaryLines.length > 0 && (hasMeaningfulSummary || !hasExitSignalLines)
    ? watchlistSummaryLines
    : signalLines.length > 0
      ? signalLines
      : String(result.summary_line || "NO SIGNAL")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
  const marketHours = result.market_hours || DEFAULT_MARKET_HOURS;
  const priorSignals = sanitizePriorSignalsForDisplay(result.prior_signals_by_watchlist);

  return {
    updatedAt: result.generated_at || new Date().toISOString(),
    formattedTimestampEt: result.formatted_timestamp_et || formatTimestamp(result.generated_at || Date.now()),
    nextScheduledRunEt: result.next_scheduled_run_et || getNextScheduledRunLabel(result.generated_at || new Date(), marketHours),
    scanMode: result.scan_mode || "signals_only",
    hasSignals: Number(result.signals_found || 0) > 0,
    signalsFound: Number(result.signals_found || 0),
    changedSignals: Number(result.changed_signals || 0),
    lines,
    summary: result.summary_line || lines.join("\n") || "NO SIGNAL",
    skipped: Boolean(result.skipped),
    reason: result.reason || null,
    connectionError: Boolean(result.connection_error),
    errorMessage: result.error_message || null,
    symbolsScanned: Number(result.total_scan_count || 0),
    scheduleDisabled: Boolean(result.schedule_disabled),
    scanResults: Array.isArray(result.all_scan_results)
      ? result.all_scan_results
      : Array.isArray(result.symbols_scanned)
        ? result.symbols_scanned
        : [],
    watchlistsChecked: Array.isArray(result.watchlists_checked) ? result.watchlists_checked : [],
    watchlistSync: Array.isArray(result.watchlist_sync) ? result.watchlist_sync : [],
    watchlistSyncOptions: Array.isArray(result.watchlistOptions) ? result.watchlistOptions : [],
    watchlistSyncActiveName: result.activeWatchlistName || null,
    tradeLogOrphans: Array.isArray(result.trade_log_orphans) ? result.trade_log_orphans : [],
    webhookExitPending: Array.isArray(result.webhook_exit_pending) ? result.webhook_exit_pending : [],
    crossTfExits: Array.isArray(result.cross_tf_exits) ? result.cross_tf_exits : [],
    // Ranked HERE, at the single chokepoint every status write funnels through, rather than at each
    // producer. Both writers — writeLatestStatus() and the dashboard server's own writeStatus() —
    // call this function, and writeLatestStatus() overwrites the WHOLE file on every path, so a
    // producer that forgets to rank silently erases a previous write's ranks. That is exactly how
    // this broke: runBrief() ranked, but the five skip/error paths (schedule disabled, outside
    // hours, connection error, strategy mismatch, nothing due) did not, and a skipped tick — far
    // more frequent than a real scan — blanked the Edge/Org/New columns and the NEW badge.
    //
    // Third instance of this bug class here: buildWatchlistSyncFromBaseline (2026-07-28) and
    // trade_log_orphans (2026-07-29) were both "a value derivable from the baseline alone is
    // computed on one write path only". Ranking at the chokepoint makes a sixth path physically
    // unable to reintroduce it, instead of relying on remembering a call at each new site.
    openTrades: rankOpenTradesForStatus(
      Array.isArray(result.open_trades) ? result.open_trades : [],
      result.generated_at || new Date().toISOString(),
      marketHours.timezone || DEFAULT_MARKET_HOURS.timezone,
    ),
    priorSignals,
    isPartialScan: Boolean(result.is_partial_scan),
    scanProgress: result.scan_progress || null,
    strategyMismatch: result.strategy_mismatch || null,
    levelViolations: Array.isArray(result.level_violations) ? result.level_violations : [],
  };
}

export function buildOutsideHoursResult({
  marketHours = DEFAULT_MARKET_HOURS,
  scanTargets = [],
  baseline = {},
  reason = 'Outside market hours',
} = {}) {
  const generatedAt = new Date().toISOString();
  const timezone = marketHours.timezone || DEFAULT_MARKET_HOURS.timezone;
  const watchlistSummaries = scanTargets.map((target) => {
    const stored = baseline.watchlists?.[target.watchlistName] || {};
    const historicalSymbols = Object.values(baseline.signals || {})
      .filter((entry) => String(entry?.timeframe || '') === String(target.timeframe || ''))
      .map((entry) => entry?.symbol)
      .filter(Boolean);
    const symbols = Array.isArray(stored.symbols) && stored.symbols.length > 0
      ? stored.symbols
      : historicalSymbols.length > 0
        ? Array.from(new Set(historicalSymbols))
        : Array.isArray(target.symbols) ? target.symbols : [];

    return {
      watchlist_name: target.watchlistName,
      timeframe: target.timeframe,
      symbol_count: Number(stored.symbol_count || symbols.length || 0),
      symbols,
      source: Array.isArray(stored.symbols) && stored.symbols.length > 0 ? 'baseline_history' : 'rules_fallback',
      scan_duration_ms: 0,
    };
  });

  const priorSignalsByWatchlist = buildPriorSignalsByWatchlist(
    watchlistSummaries,
    [],
    baseline.signals || {},
    timezone,
    baseline.last_updated,
    baseline.watchlists || {},
  );

  return {
    success: true,
    skipped: true,
    reason,
    signal_lines: [],
    changed_signal_lines: [],
    notify_signal_lines: [],
    watchlist_summary_lines: watchlistSummaries.map(
      (target) => `${formatTimestamp(generatedAt, timezone)} ET | WATCHLIST: ${target.watchlist_name} | SYMBOLS: ${target.symbol_count} | SCAN: ${formatDuration(target.scan_duration_ms)} | NO SIGNAL | ${reason}`,
    ),
    summary_line: `${formatTimestamp(generatedAt, timezone)} ET | NO SIGNAL | ${reason}`,
    generated_at: generatedAt,
    formatted_timestamp_et: formatTimestamp(generatedAt, timezone),
    next_scheduled_run_et: getNextScheduledRunLabel(generatedAt, marketHours),
    market_hours: marketHours,
    signals_found: 0,
    changed_signals: 0,
    total_scan_count: 0,
    symbols_scanned: [],
    open_trades: buildOpenTrades(priorSignalsByWatchlist, baseline.signals || {}, generatedAt, timezone),
    scan_mode: 'signals_only',
    watchlists_checked: scanTargets.map((target) => target.watchlistName),
    prior_signals_by_watchlist: priorSignalsByWatchlist,
  };
}

function buildConnectionErrorResult({
  marketHours = DEFAULT_MARKET_HOURS,
  scanTargets = [],
  baseline = {},
  reason = 'TradingView connection unavailable. Open TradingView Desktop with remote debugging enabled.',
} = {}) {
  const generatedAt = new Date().toISOString();
  const timezone = marketHours.timezone || DEFAULT_MARKET_HOURS.timezone;
  const watchlistSummaries = scanTargets.map((target) => {
    const stored = baseline.watchlists?.[target.watchlistName] || {};
    const historicalSymbols = Object.values(baseline.signals || {})
      .filter((entry) => String(entry?.timeframe || '') === String(target.timeframe || ''))
      .map((entry) => entry?.symbol)
      .filter(Boolean);
    const symbols = Array.isArray(stored.symbols) && stored.symbols.length > 0
      ? stored.symbols
      : historicalSymbols.length > 0
        ? Array.from(new Set(historicalSymbols))
        : Array.isArray(target.symbols) ? target.symbols : [];

    return {
      watchlist_name: target.watchlistName,
      timeframe: target.timeframe,
      symbol_count: Number(stored.symbol_count || symbols.length || 0),
      symbols,
      source: 'connection_unavailable',
      scan_duration_ms: 0,
    };
  });

  const priorSignalsByWatchlist = buildPriorSignalsByWatchlist(
    watchlistSummaries,
    [],
    baseline.signals || {},
    timezone,
    baseline.last_updated,
    baseline.watchlists || {},
  );

  return {
    success: false,
    skipped: true,
    connection_error: true,
    reason,
    error_message: reason,
    signal_lines: [],
    changed_signal_lines: [],
    notify_signal_lines: [],
    watchlist_summary_lines: [reason],
    summary_line: reason,
    generated_at: generatedAt,
    formatted_timestamp_et: formatTimestamp(generatedAt, timezone),
    next_scheduled_run_et: getNextScheduledRunLabel(generatedAt, marketHours),
    market_hours: marketHours,
    signals_found: 0,
    changed_signals: 0,
    total_scan_count: 0,
    symbols_scanned: [],
    open_trades: buildOpenTrades(priorSignalsByWatchlist, baseline.signals || {}, generatedAt, timezone),
    scan_mode: 'signals_only',
    watchlists_checked: scanTargets.map((target) => target.watchlistName),
    prior_signals_by_watchlist: priorSignalsByWatchlist,
  };
}

function writeLatestStatus(result) {
  writeJsonFile(LATEST_STATUS_PATH, createDashboardStatus(result));
}

async function scanSymbol({ symbol, timeframe, studyFilter, watchlistName, watchlistSymbolCount }) {
  await chart.setSymbol({ symbol, wait_timeout: 1200 });
  await sleep(150);
  await chart.setTimeframe({ timeframe, wait_timeout: 1200 });
  await sleep(150);

  const [state, indicators, quote, labels, tables] = await Promise.all([
    chart.getState(),
    data.getStudyValues(),
    data.getQuote({}),
    data.getPineLabels({ study_filter: studyFilter, max_labels: 25 }),
    data.getPineTables({ study_filter: studyFilter }),
  ]);

  const latestTrade = await data.getLatestTradeFromTester({ timeout_ms: 14000, study_filter: studyFilter }).catch(() => ({ success: false, trade: null }));

  // Harvest closed-trade history into trade-log/trades-<tf>.csv. The chart is already parked on
  // this symbol/timeframe, so this costs one extra CDP read and nothing else. Deduplicated by
  // entry timestamp, so re-scanning appends only genuinely new closures. Never allowed to fail a
  // scan — the log is an analysis artifact, not part of the signal path.
  const tradeLogResult = await tradeLog
    .logClosedTrades({ symbol, timeframe, watchlist_name: watchlistName || "Default", study_filter: studyFilter })
    .catch((err) => ({ success: false, error: err?.message || String(err), appended: 0 }));
  if (tradeLogResult?.error) {
    console.error(`[trade-log] ${symbol}|${timeframe}: ${tradeLogResult.error}`);
  }

  const signal = detectSignalFromSnapshot({
    symbol: state?.symbol || symbol,
    timeframe,
    labels,
    tables,
    indicators,
  });

  return {
    symbol,
    timeframe,
    watchlist_name: watchlistName || "Default",
    watchlist_symbol_count: watchlistSymbolCount ?? null,
    scanned_at: new Date().toISOString(),
    state,
    indicators,
    quote,
    labels,
    tables,
    signal,
    trade: latestTrade?.trade || null,
    trade_source: latestTrade?.source || null,
    trade_log_appended: tradeLogResult?.appended ?? 0,
  };
}

export async function runBrief({
  rules_path,
  signals_only = false,
  changed_only = false,
  update_baseline = false,
  scan_targets = null,
  full_scan_targets = null,
  onProgress = null,
  onWatchlistComplete = null,
} = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const { watchlist = [], default_timeframe = "240", watchlists = {} } = rules;
  const allScanTargets = full_scan_targets || buildScanTargets({ watchlist, default_timeframe, watchlists });
  const scanTargets = Array.isArray(scan_targets) ? scan_targets : allScanTargets;
  const dueWatchlists = Array.isArray(scan_targets)
    ? new Set(scan_targets.map((target) => target.watchlistName))
    : null;
  const baselinePath = resolve(rules.baseline_file || DEFAULT_BASELINE_PATH);
  const baseline = loadBaseline(baselinePath);
  const studyFilter = String(rules.strategy || "Swing Profile").split("—")[0].trim();

  if (!watchlist.length) {
    throw new Error(
      "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
    );
  }

  let originalSymbol, originalTimeframe;
  let currentState;
  try {
    currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (error) {
    const err = new Error(`TradingView connection unavailable. ${error?.message || String(error)}`);
    err.code = 'TV_CONNECTION_UNAVAILABLE';
    throw err;
  }

  const results = [];
  const watchlistSummaries = [];
  const timezone = (rules.market_hours || baseline.market_hours || DEFAULT_MARKET_HOURS).timezone || DEFAULT_MARKET_HOURS.timezone;

  const dueTargetCount = dueWatchlists
    ? allScanTargets.filter(t => dueWatchlists.has(t.watchlistName)).length
    : allScanTargets.length;
  let dueWatchlistIndex = 0;

  try {
    for (const target of allScanTargets) {
      if (dueWatchlists && !dueWatchlists.has(target.watchlistName)) {
        const baselineWatchlist = baseline.watchlists?.[target.watchlistName] || {};
        const savedSymbols = Array.isArray(baselineWatchlist.symbols) && baselineWatchlist.symbols.length > 0
          ? baselineWatchlist.symbols
          : Array.isArray(target.symbols)
            ? target.symbols
            : watchlist;

        watchlistSummaries.push({
          watchlist_name: target.watchlistName,
          timeframe: target.timeframe,
          symbol_count: savedSymbols.length,
          scanned_count: 0,
          missing_symbols: [],
          symbols: savedSymbols,
          source: 'scheduled_skip',
          scan_duration_ms: 0,
          skipped_due_schedule: true,
        });
        continue;
      }

      dueWatchlistIndex++;
      const startedAt = Date.now();
      const resolved = await resolveSymbolsForWatchlist(target, watchlist, {
        allowFallback: true,
        baselineWatchlists: baseline.watchlists,
        baselineSignals: baseline.signals,
      });
      const normalizedExpected = new Set(
        resolved.symbols.map((symbol) => String(symbol).split(':').pop()?.toUpperCase() || String(symbol).toUpperCase()),
      );

      onProgress?.({
        watchlistName: target.watchlistName,
        watchlistIndex: dueWatchlistIndex,
        watchlistTotal: dueTargetCount,
        symbolsScanned: 0,
        symbolsTotal: resolved.symbols.length,
      });

      let symbolsScanned = 0;
      for (const symbol of resolved.symbols) {
        try {
          results.push(
            await scanSymbol({
              symbol,
              timeframe: target.timeframe,
              studyFilter,
              watchlistName: target.watchlistName,
              watchlistSymbolCount: resolved.count,
            }),
          );
        } catch (err) {
          results.push({
            symbol,
            timeframe: target.timeframe,
            watchlist_name: target.watchlistName,
            watchlist_symbol_count: resolved.count,
            scanned_at: new Date().toISOString(),
            error: err.message,
          });
        }
        symbolsScanned++;
        onProgress?.({
          watchlistName: target.watchlistName,
          watchlistIndex: dueWatchlistIndex,
          watchlistTotal: dueTargetCount,
          symbolsScanned,
          symbolsTotal: resolved.symbols.length,
        });
      }

      const scannedForWatchlist = results.filter((entry) => entry.watchlist_name === target.watchlistName);
      const normalizedScanned = new Set(
        scannedForWatchlist.map((entry) => String(entry.state?.symbol || entry.symbol).split(':').pop()?.toUpperCase() || String(entry.symbol).toUpperCase()),
      );
      const missingSymbols = resolved.symbols.filter((symbol) => {
        const normalized = String(symbol).split(':').pop()?.toUpperCase() || String(symbol).toUpperCase();
        return !normalizedScanned.has(normalized);
      });

      for (const symbol of missingSymbols) {
        results.push({
          symbol,
          timeframe: target.timeframe,
          watchlist_name: target.watchlistName,
          watchlist_symbol_count: resolved.count,
          scanned_at: new Date().toISOString(),
          error: 'Symbol was not fully scanned before watchlist rotation',
        });
      }

      watchlistSummaries.push({
        watchlist_name: target.watchlistName,
        timeframe: target.timeframe,
        symbol_count: resolved.count,
        scanned_count: normalizedScanned.size,
        missing_symbols: missingSymbols,
        symbols: resolved.symbols,
        source: resolved.source,
        scan_duration_ms: Date.now() - startedAt,
        scanned_at: new Date().toISOString(),
      });

      if (onWatchlistComplete) {
        const pGenAt = new Date().toISOString();
        // Use the original (pre-scan) baseline so stored net_pnl / excursion values are preserved.
        // updateBaselineEntry writes "In progress" for live OPEN trades (hasTradeState path), and
        // createExcursionAlerts (which restores real values) only runs after the full loop.
        // Writing a partial baseline here would lose stored P&L for the remainder of the scan.
        const pBase = baseline;
        const pSig = results.filter((e) => {
          const isOpen = String(e.trade?.signal || '').toUpperCase() === 'OPEN'
            && isRecentTradeSignal(e.trade?.entryTime, e.scanned_at, e.timeframe);
          if (isOpen) return true;
          const key = `${e.state?.symbol || e.symbol}:${e.timeframe}`;
          return Boolean(e.signal?.hasSignal) && hasSignalChanged(pBase.signals[key] || {}, e.signal);
        });
        const pChg = pSig.filter((e) => {
          const key = `${e.state?.symbol || e.symbol}:${e.timeframe}`;
          const prev = pBase.signals[key] || {};
          if (String(e.trade?.signal || '').toUpperCase() === 'OPEN') {
            return String(prev.signal_type || '').toUpperCase() !== 'OPEN'
              || normalizeTradeDisplay(prev.entry_time, '') !== normalizeTradeDisplay(e.trade?.entryTime, '')
              || normalizeTradeDisplay(prev.entry_price, '') !== normalizeTradeDisplay(e.trade?.entryPrice, '');
          }
          return hasSignalChanged(prev, e.signal);
        });
        const mkLine = (e) => {
          const sym = e.state?.symbol || e.symbol || 'n/a';
          return `${formatTimestamp(e.scanned_at || pGenAt, timezone)} ET | WATCHLIST: ${e.watchlist_name || 'Default'} | OPEN: ${sym} | ENTRY: ${normalizeTradeDisplay(e.trade?.entryPrice)} | AT: ${normalizeTradeDisplay(e.trade?.entryTime)}`;
        };
        const pPrior = buildPriorSignalsByWatchlist(watchlistSummaries, results, pBase.signals, timezone, pBase.last_updated, pBase.watchlists);
        let pTrades = buildOpenTrades(pPrior, pBase.signals, pGenAt, timezone, results);
        pTrades = enrichOpenTradesFromBaseline(pTrades, pBase.excursion_alerts);
        const pSumLines = buildWatchlistSummaryLines(watchlistSummaries, results, pPrior, timezone, rules.market_hours || DEFAULT_MARKET_HOURS, pTrades);
        const pNoSig = watchlistSummaries.map(
          (t) => `${formatTimestamp(pGenAt, timezone)} ET | WATCHLIST: ${t.watchlist_name} | SYMBOLS: ${t.symbol_count} | SCAN: ${formatDuration(t.scan_duration_ms)} | NO SIGNAL`,
        );
        onWatchlistComplete({
          success: true,
          is_partial_scan: true,
          scan_progress: { watchlistIndex: dueWatchlistIndex, watchlistTotal: dueTargetCount, watchlistName: target.watchlistName },
          generated_at: pGenAt,
          formatted_timestamp_et: formatTimestamp(pGenAt, timezone),
          rules_loaded_from: loadedFrom,
          baseline_path: baselinePath,
          scan_mode: signals_only ? (changed_only ? 'changed_signals_only' : 'signals_only') : 'full',
          rules: { bias_criteria: rules.bias_criteria || null, risk_rules: rules.risk_rules || null, notes: rules.notes || null },
          market_hours: rules.market_hours || DEFAULT_MARKET_HOURS,
          next_scheduled_run_et: getNextScheduledRunLabel(pGenAt, rules.market_hours || DEFAULT_MARKET_HOURS),
          symbols_scanned: signals_only ? (changed_only ? pChg : pSig) : results,
          watchlists_checked: scanTargets.map((t) => t.watchlistName),
          watchlist_scan_summaries: watchlistSummaries,
          prior_signals_by_watchlist: pPrior,
          open_trades: pTrades,
          total_scan_count: results.length,
          signals_found: pSig.length,
          changed_signals: pChg.length,
          signal_lines: pSig.map(mkLine),
          changed_signal_lines: pChg.map(mkLine),
          notify_signal_lines: [],
          all_scan_results: results,
        watchlist_summary_lines: pSumLines,
          summary_line: pSumLines.join('\n') || pNoSig.join('\n'),
          connection_error: false,
        });
      }
    }
  } finally {
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTimeframe) {
          await chart.setTimeframe({ timeframe: originalTimeframe });
        }
      } catch (_) {}
    }
  }

  // "Genuinely new" — matches exactly what buildWatchlistSummaryLines actually displays (recent-bar
  // or same-day OPEN/EXIT), not the older entry.signal?.hasSignal/hasSignalChanged path this used to
  // fall back to. That path reads the strategy's on-chart label text, the same "Position: Long/Short"
  // reading documented above as unreliable/one-bar-ahead — and its price-comparison arm fires on
  // ordinary price movement for any symbol with an active label, so a days-old open position could
  // inflate this count on nearly every scan with nothing new having actually happened (confirmed live
  // 2026-07-28: 3 counted "signals" were all 1-5 day old positions, none shown in the actual list).
  const signalEntries = results.filter((entry) => {
    const tradeSignal = String(entry.trade?.signal || '').toUpperCase();
    if (tradeSignal === 'OPEN') {
      return isRecentTradeSignal(entry.trade?.entryTime, entry.scanned_at, entry.timeframe)
        || isSameTradingDay(entry.trade?.entryTime, entry.scanned_at, timezone);
    }
    if (tradeSignal === 'EXIT') {
      // exitTime (added to getStrategyPositionState's EXIT branch), not entryTime — entryTime here
      // is when the now-closed position originally opened, which says nothing about how recently it
      // exited. A EXIT with no exitTime (DOM-fallback trade reads never carry one) is never counted.
      return isRecentTradeSignal(entry.trade?.exitTime, entry.scanned_at, entry.timeframe)
        || isSameTradingDay(entry.trade?.exitTime, entry.scanned_at, timezone);
    }
    return false;
  });
  const changedSignals = signalEntries.filter((entry) => {
    const key = `${entry.state?.symbol || entry.symbol}:${entry.timeframe}`;
    const previous = baseline.signals[key] || {};
    if (String(entry.trade?.signal || '').toUpperCase() === 'OPEN') {
      return String(previous.signal_type || '').toUpperCase() !== 'OPEN'
        || normalizeTradeDisplay(previous.entry_time, '') !== normalizeTradeDisplay(entry.trade?.entryTime, '')
        || normalizeTradeDisplay(previous.entry_price, '') !== normalizeTradeDisplay(entry.trade?.entryPrice, '');
    }
    // EXIT: a freshly-closed position's prior baseline entry still reads signal_type 'OPEN' (that's
    // what the scan before this one recorded while it was still open), so this also survives re-scans
    // of the same closed trade later the same day without re-counting it as newly changed.
    return String(previous.signal_type || '').toUpperCase() !== 'EXIT'
      || normalizeTradeDisplay(previous.entry_time, '') !== normalizeTradeDisplay(entry.trade?.entryTime, '');
  });

  let displayBaseline = baseline;
  if (update_baseline) {
    const nextBaseline = loadBaseline(baselinePath);
    nextBaseline.last_updated = new Date().toISOString();
    for (const entry of results) {
      if (!entry.error) updateBaselineEntry(nextBaseline.signals, entry);
    }
    for (const summary of watchlistSummaries) {
      const existing = nextBaseline.watchlists[summary.watchlist_name] || {};
      const scannedNow = !summary.skipped_due_schedule && summary.source !== 'scheduled_skip';
      nextBaseline.watchlists[summary.watchlist_name] = {
        ...existing,
        timeframe: summary.timeframe,
        ...(summary.source === 'tradingview_panel' && Array.isArray(summary.symbols) && summary.symbols.length > 0
          ? { symbols: summary.symbols, symbol_count: summary.symbol_count }
          : {}),
        updated_at: nextBaseline.last_updated,
        ...(scannedNow ? { last_scanned_at: summary.scanned_at || nextBaseline.last_updated } : {}),
      };
    }
    writeJsonFile(baselinePath, nextBaseline);
    displayBaseline = nextBaseline;
  }

  const outputEntries = signals_only
    ? changed_only
      ? changedSignals
      : signalEntries
    : results;

  const generatedAt = new Date().toISOString();
  const signalLines = signalEntries.map((entry) => formatSignalLine(entry, timezone));
  const changedSignalLines = changedSignals.map((entry) => formatSignalLine(entry, timezone));
  // Notification-eligible entries: must be OPEN and entered today (prevents re-alerting on
  // multi-day swings or closed trades whose indicators re-fired)
  const notifyEntries = changedSignals.filter((entry) =>
    String(entry.trade?.signal || '').toUpperCase() === 'OPEN'
    && isSameTradingDay(entry.trade?.entryTime, generatedAt, timezone)
  );
  // Same shape of gate as notifyEntries above, mirrored for EXIT: same-day, keyed on exitTime (not
  // entryTime — a closed trade's entryTime can be days old, exitTime is when it actually closed).
  // This only decides eligibility to be OFFERED to the webhook dispatcher; dispatchExitWebhooks adds
  // its own further gate (the matching entry must have been sent via webhook in the first place)
  // before anything actually goes out.
  const notifyExitEntries = changedSignals.filter((entry) =>
    String(entry.trade?.signal || '').toUpperCase() === 'EXIT'
    && isSameTradingDay(entry.trade?.exitTime, generatedAt, timezone)
  );
  const notifySignalLines = notifyEntries.map((entry) => {
    const symbol = entry.state?.symbol || entry.symbol || 'n/a';
    return `${formatTimestamp(entry.scanned_at || generatedAt, timezone)} ET | WATCHLIST: ${entry.watchlist_name || 'Default'} | OPEN: ${symbol} | ENTRY: ${normalizeTradeDisplay(entry.trade?.entryPrice)} | AT: ${normalizeTradeDisplay(entry.trade?.entryTime)}`;
  });
  const noSignalLines = watchlistSummaries.map(
    (target) => `${formatTimestamp(generatedAt, timezone)} ET | WATCHLIST: ${target.watchlist_name} | SYMBOLS: ${target.symbol_count} | SCAN: ${formatDuration(target.scan_duration_ms)} | NO SIGNAL`,
  );

  const priorSignalsByWatchlist = buildPriorSignalsByWatchlist(
    watchlistSummaries,
    results,
    displayBaseline.signals,
    timezone,
    displayBaseline.last_updated,
    displayBaseline.watchlists,
  );
  let openTrades = buildOpenTrades(priorSignalsByWatchlist, displayBaseline.signals, generatedAt, timezone, results);
  // Bounded: a stuck network/UI call inside createExcursionAlerts (e.g. TradingView's
  // alerts REST API not responding) must never block the whole scan indefinitely.
  openTrades = await Promise.race([
    createExcursionAlerts(openTrades, baselinePath, rules),
    new Promise((resolve) => setTimeout(() => resolve(null), 4 * 60 * 1000)),
  ])
    .then((result) => result ?? enrichOpenTradesFromBaseline(openTrades, displayBaseline.excursion_alerts))
    .catch(() => enrichOpenTradesFromBaseline(openTrades, displayBaseline.excursion_alerts));
  // NOTE: edge/org/new ranking is NOT applied here. It happens in createDashboardStatus(), the one
  // function every status write funnels through — see the comment there. Ranking at the producer is
  // what let five skip paths blank the columns by overwriting the file without it.
  const watchlistSummaryLines = buildWatchlistSummaryLines(
    watchlistSummaries,
    results,
    priorSignalsByWatchlist,
    timezone,
    rules.market_hours || DEFAULT_MARKET_HOURS,
    openTrades,
  );

  return {
    success: true,
    generated_at: generatedAt,
    formatted_timestamp_et: formatTimestamp(generatedAt, timezone),
    rules_loaded_from: loadedFrom,
    baseline_path: baselinePath,
    scan_mode: signals_only
      ? changed_only
        ? "changed_signals_only"
        : "signals_only"
      : "full",
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    market_hours: rules.market_hours || DEFAULT_MARKET_HOURS,
    next_scheduled_run_et: getNextScheduledRunLabel(generatedAt, rules.market_hours || DEFAULT_MARKET_HOURS),
    all_scan_results: results,
    symbols_scanned: outputEntries,
    watchlists_checked: scanTargets.map((target) => target.watchlistName),
    watchlist_scan_summaries: watchlistSummaries,
    prior_signals_by_watchlist: priorSignalsByWatchlist,
    open_trades: openTrades,
    total_scan_count: results.length,
    signals_found: signalEntries.length,
    changed_signals: changedSignals.length,
    signal_lines: signalLines,
    changed_signal_lines: changedSignalLines,
    notify_signal_lines: notifySignalLines,
    // Structured twin of notify_signal_lines. The lines are formatted for a phone lock screen and
    // can't be parsed back into fields reliably; the trade webhook needs real symbol/side/price, so
    // it consumes this instead. Same entries, same gating — never a looser set.
    notify_signal_events: notifyEntries.map((entry) => ({
      symbol: entry.state?.symbol || entry.symbol || null,
      timeframe: entry.timeframe,
      watchlist_name: entry.watchlist_name || null,
      side: entry.trade?.side || null,
      entry_price: entry.trade?.entryPrice ?? entry.signal?.price ?? entry.quote?.last ?? null,
      entry_time: entry.trade?.entryTime || null,
    })),
    // Exit-side twin. `entry_time` is carried through (not just exit_time) because it's what the
    // matching entry's webhook was keyed under — dispatchExitWebhooks needs it to look up whether
    // this exact position was ever opened via webhook in the first place.
    notify_exit_events: notifyExitEntries.map((entry) => ({
      symbol: entry.state?.symbol || entry.symbol || null,
      timeframe: entry.timeframe,
      watchlist_name: entry.watchlist_name || null,
      side: entry.trade?.side || null,
      exit_price: entry.trade?.exitPrice ?? null,
      entry_time: entry.trade?.entryTime || null,
      exit_time: entry.trade?.exitTime || null,
    })),
    watchlist_summary_lines: watchlistSummaryLines,
    summary_line: watchlistSummaryLines.join("\n") || noSignalLines.join("\n"),
    instruction: signals_only
      ? "Return only active signals. If none are present, say NO SIGNAL."
      : [
          "For each symbol in symbols_scanned, apply the bias_criteria from rules to the indicator readings.",
          "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price] | WATCH: [what to monitor]",
          "End with a one-sentence overall market read.",
          "Be direct. No preamble.",
        ].join(" "),
  };
}

// Attach stored excursion stats/levels/alertsCreated from baseline to open trade rows.
// Used for paths that skip the live CDP scan (outside hours, connection error, no-targets).
function enrichOpenTradesFromBaseline(openTrades, excursionAlerts = {}) {
  // Build a normalized lookup: ticker-only|timeframe → stored entry, so that
  // AMEX:TNA|15 matches a stored key of BATS:TNA|15 (exchange prefix may differ).
  const normMap = new Map();
  for (const [k, v] of Object.entries(excursionAlerts || {})) {
    const pipeIdx = k.lastIndexOf('|');
    if (pipeIdx < 0) continue;
    const sym = k.slice(0, pipeIdx);
    const tf = k.slice(pipeIdx + 1);
    const ticker = sym.split(':').pop()?.toUpperCase() || sym.toUpperCase();
    const normKey = `${ticker}|${tf}`;
    if (!normMap.has(k)) normMap.set(k, v);       // exact key
    if (!normMap.has(normKey)) normMap.set(normKey, v); // normalized fallback
  }

  return (Array.isArray(openTrades) ? openTrades : []).map((trade) => {
    const key = `${trade.symbol}|${trade.timeframe}`;
    const ticker = String(trade.symbol || '').split(':').pop()?.toUpperCase() || '';
    const normKey = `${ticker}|${trade.timeframe}`;
    const stored = normMap.get(key) || normMap.get(normKey);
    if (!stored) return trade;
    return {
      ...trade,
      excursionStats: stored.stats || null,
      alertLevels: stored.levels || null,
      alertsCreated: stored.created === true,
      alertsSkipReason: stored.skip_reason || null,
    };
  });
}

// Rank open trades against their timeframe peers (edge score, org/new rank pair).
//
// Called from EXACTLY ONE place — createDashboardStatus() — and it must stay that way. Ranking is a
// property of every status write, not of one producer: a value derivable from the baseline alone has
// to be recomputed on every write, because writeLatestStatus() replaces the whole file and the last
// write wins. Adding a call at a producer instead re-opens the bug for whichever producer is added
// next. See the comment at the call site for the three times that has happened here.
//
// Deliberately swallows: the edge/edgeRank* fields are purely additive, nothing downstream gates on
// them, and an unrankable trade log must cost a log line rather than the whole status write. Returns
// the input untouched on failure, so the rows themselves always survive.
function rankOpenTradesForStatus(openTrades, generatedAt, timezone) {
  try {
    return attachOpenTradeRanks(openTrades, {
      ruleType: tradeLog.listRuleTypes()[0]?.rule_type ?? null,
      isNew: (row) => isSameTradingDay(row.entryTimeRaw, generatedAt, timezone),
    });
  } catch (err) {
    console.error(`[edge] could not rank open trades: ${err?.message || err}`);
    return openTrades;
  }
}

// Parse numeric entry price from strings like "159.53 USD" or "159.53".
function parseEntryPriceNum(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// For each open trade that does not yet have excursion alerts in the baseline:
//   1. Switch to that symbol + timeframe
//   2. Read all historical trades to compute avg/max excursion stats
//   3. Create 2 TradingView price alerts (avg stop, avg target)
//   4. Mark as done in the baseline so subsequent scans skip this block
//
// Positions with a webhook already sent for them (manual Send or auto-armed — real money placed
// at the executor) get priority for the account's limited alert quota over positions that are
// only being tracked/monitored. When the quota is full, a webhook-sent trade may evict an existing
// alert pair belonging to a non-webhook-sent position, preferring the longest timeframe available
// (a 1D/4H position loses less by dropping to scan-interval-granularity local monitoring than a
// 15m one would) — see findEvictionCandidate below. User-confirmed design 2026-07-28, prompted by
// TSX_DLY:TD having a webhook sent but only local (no real TradingView alert) monitoring.
//
// Returns openTrades array augmented with excursionStats and alertLevels fields.

/**
 * Stop/target price levels from an entry price and the strategy's historical excursion stats.
 *
 * Shared by createExcursionAlerts (the scan path, which persists these into
 * baseline.excursion_alerts for the dashboard's Alert Levels column) and the manual ledger's
 * /api/manual-ledger/suggest-levels endpoint. Deliberately one implementation: two copies would
 * drift silently and the dashboard would show one set of levels while the ledger suggested another,
 * with nothing indicating which had gone stale — same reasoning as sweet_spot.js vs
 * sweep_portfolio_grid.mjs.
 *
 * Stats percentages are already in percent units (getAllTradesExcursionStats scales the raw
 * fractions). Returns null rather than NaN levels when either input is unusable.
 */
export function computeExcursionLevels(entryNum, stats) {
  const entry = Number(entryNum);
  if (!Number.isFinite(entry) || entry <= 0 || !stats) return null;
  const round2 = n => Math.round(n * 100) / 100;
  const levels = {
    stopAvg:   round2(entry * (1 - stats.avgAdversePct   / 100)),
    stopMax:   round2(entry * (1 - stats.maxAdversePct   / 100)),
    targetAvg: round2(entry * (1 + stats.avgFavorablePct / 100)),
    targetMax: round2(entry * (1 + stats.maxFavorablePct / 100)),
  };
  return Object.values(levels).every(Number.isFinite) ? levels : null;
}

export async function createExcursionAlerts(openTrades, baselinePath, rules = null) {
  if (!Array.isArray(openTrades) || openTrades.length === 0) return openTrades;

  const baseline = loadBaseline(baselinePath);
  const enriched = [];
  // Trades that hit the quota this run — labeled "Local alert i/n" only once the full
  // overflow set for this run is known (see after the loop), since n isn't known upfront.
  const quotaOverflow = [];

  // Check current active alert count once upfront so we can gate each batch.
  const MAX_ALERTS = 20;
  let usedSlots = 0;
  try {
    const alertList = await alerts.list();
    usedSlots = (alertList.alerts || []).filter(a => a.active).length;
  } catch {}

  // Which currently-open positions have a webhook actually sent for them. Keyed the same way
  // excursion_alerts is (`${symbol}|${timeframe}`, both raw form and normalized-ticker form,
  // matching the existing lookup pattern below) so eviction can check "is this candidate
  // webhook-sent" without re-deriving it per candidate. Requires entryTimeRaw (not the ET-display
  // entryTime) — see the sentKey format-mismatch fix this was built alongside.
  const webhookSentKeys = new Set();
  for (const t of openTrades) {
    if (!t?.entryTimeRaw) continue;
    const k = sentKey({ symbol: t.symbol, timeframe: t.timeframe, entryTime: t.entryTimeRaw });
    if (k && alreadySent(k)) {
      webhookSentKeys.add(`${t.symbol}|${t.timeframe}`);
      const ticker = String(t.symbol || '').split(':').pop()?.toUpperCase() || '';
      webhookSentKeys.add(`${ticker}|${t.timeframe}`);
    }
  }

  // Process webhook-sent trades first — they're the ones that should win a contested slot or an
  // eviction. Stable sort: relative order within each group is unchanged.
  const orderedOpenTrades = [...openTrades].sort((a, b) => {
    const aSent = webhookSentKeys.has(`${a.symbol}|${a.timeframe}`) ? 0 : 1;
    const bSent = webhookSentKeys.has(`${b.symbol}|${b.timeframe}`) ? 0 : 1;
    return aSent - bSent;
  });

  // Best non-webhook-sent, currently-real-alert candidate to evict to make room — longest
  // timeframe first, since that position loses the least precision falling back to local
  // monitoring (checked once per its own, already-long, scan interval either way).
  function findEvictionCandidate(rawExcursionAlerts) {
    let best = null;
    let bestMinutes = -1;
    for (const [key, entry] of Object.entries(rawExcursionAlerts || {})) {
      if (!entry?.created || !Array.isArray(entry.alert_ids) || entry.alert_ids.length === 0) continue;
      if (webhookSentKeys.has(key)) continue; // never evict another webhook-sent position
      const pipe = key.lastIndexOf('|');
      if (pipe < 0) continue;
      const tf = key.slice(pipe + 1);
      const ticker = key.slice(0, pipe).split(':').pop()?.toUpperCase() || '';
      if (webhookSentKeys.has(`${ticker}|${tf}`)) continue;
      const minutes = timeframeToMinutes(tf) || 0;
      if (minutes > bestMinutes) { bestMinutes = minutes; best = { key, entry, timeframe: tf }; }
    }
    return best;
  }

  for (const trade of orderedOpenTrades) {
    const { symbol, timeframe, entryPrice } = trade;
    const key = `${symbol}|${timeframe}`;
    const ticker = String(symbol || '').split(':').pop()?.toUpperCase() || '';
    const normKey = `${ticker}|${timeframe}`;
    const stored = baseline.excursion_alerts[key] || baseline.excursion_alerts[normKey]
      || Object.entries(baseline.excursion_alerts).find(([k]) => {
        const pipe = k.lastIndexOf('|');
        if (pipe < 0) return false;
        return k.slice(0, pipe).split(':').pop()?.toUpperCase() === ticker && k.slice(pipe + 1) === timeframe;
      })?.[1];
    const entryNum = parseEntryPriceNum(entryPrice);

    const baseStats = stored?.stats || null;
    const baseLevels = stored?.levels || null;

    // Skip entirely if alerts already created for this entry price.
    if (stored?.created && stored?.entry_price === entryNum) {
      enriched.push({ ...trade, excursionStats: baseStats, alertLevels: baseLevels, alertsCreated: true });
      continue;
    }

    // Reuse stored stats+levels if the entry price matches — skip the expensive chart read
    // and only retry alert creation. Re-read from the chart only when entry price changed
    // or no stored stats exist yet.
    let stats = baseStats;
    let levels = baseLevels;
    const hasStoredData = stored?.entry_price === entryNum && baseStats && baseLevels;

    if (!hasStoredData) {
      // Navigate to this symbol's chart to read historical excursion stats and
      // capture live P&L while we're there.
      try {
        await chart.setSymbol({ symbol, wait_timeout: 3000 });
        await chart.setTimeframe({ timeframe, wait_timeout: 3000 });
        stats = await data.getAllTradesExcursionStats({ timeout_ms: 16000 });

        // Grab live P&L while already on this chart and persist it so that
        // changed_signals_only scans can show real values instead of "In progress".
        // getLatestTradeFromTester returns { success, source, trade } — unwrap .trade.
        try {
          const liveTradeResult = await data.getLatestTradeFromTester({ timeout_ms: 10000 });
          const liveTrade = liveTradeResult?.trade;
          if (liveTrade && String(liveTrade.signal || '').toUpperCase() === 'OPEN'
              && hasMeaningfulTradeValue(liveTrade.netPnl)) {
            const raw = parseJsonFile(baselinePath, {});
            const sigKey = `${symbol}:${timeframe}`;
            if (raw.signals && raw.signals[sigKey]) {
              raw.signals[sigKey].net_pnl = normalizeTradeDisplay(liveTrade.netPnl);
              raw.signals[sigKey].favorable_excursion = normalizeTradeDisplay(liveTrade.favorableExcursion);
              raw.signals[sigKey].adverse_excursion = normalizeTradeDisplay(liveTrade.adverseExcursion);
              writeJsonFile(baselinePath, raw);
            }
          }
        } catch {}
      } catch {
        enriched.push({ ...trade, excursionStats: baseStats, alertLevels: baseLevels, alertsCreated: false, alertsSkipReason: stored?.skip_reason || null });
        continue;
      }

      if (!stats || !entryNum) {
        enriched.push({ ...trade, excursionStats: stats, alertLevels: null, alertsCreated: false });
        continue;
      }

      levels = computeExcursionLevels(entryNum, stats);
    }

    if (!stats || !entryNum || !levels) {
      enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: false });
      continue;
    }

    const sym = symbol.replace(/^[^:]+:/, '');
    const tf  = timeframe === 'D' ? '1D' : timeframe === 'W' ? '1W' : `${timeframe}m`;
    // Whether a webhook has actually been sent for this exact position — checked once here so it's
    // available both for the alert message marker below and the quota/eviction priority further
    // down, rather than recomputed in each place.
    const isWebhookSent = webhookSentKeys.has(key) || webhookSentKeys.has(normKey);

    // Auto-creating a real TradingView alert (or falling into local overflow monitoring) is now
    // scoped to webhook-sent positions only — user request 2026-07-29: with a much larger symbol
    // universe across timeframes, unmanaged alerts/local-monitor noise for positions with no real
    // money on them became unmanageable. Stats/levels are still computed and persisted above so the
    // dashboard's Alert Levels column keeps showing suggested stop/target for the user to act on
    // manually; only the TradingView-mutating/monitoring half stops. Pre-existing real alerts on a
    // non-webhook position (created before this policy) are untouched — the "already created" check
    // at the top of this loop already skipped this trade entirely if one exists.
    //
    // `webhook.auto_price_alerts_disabled` is a separate, blanket transition-mode switch (2026-08-02):
    // while the user is migrating watchlist alerts over to TradingView's own "Top" lists, NO position
    // should get a new real alert here regardless of webhook-sent status — TradingView is placing and
    // monitoring those orders itself now. Same skip path, distinct reason so the two causes stay
    // distinguishable in the baseline/dashboard.
    const autoAlertsDisabled = rules?.webhook?.auto_price_alerts_disabled === true;
    if (!isWebhookSent || autoAlertsDisabled) {
      const raw = parseJsonFile(baselinePath, {});
      if (!raw.excursion_alerts) raw.excursion_alerts = {};
      const skipReason = autoAlertsDisabled
        ? "Auto TV alert creation disabled (transition mode)"
        : "No webhook sent — auto-alert creation disabled, create manually if needed";
      raw.excursion_alerts[key] = {
        created: false,
        created_at: new Date().toISOString(),
        entry_price: entryNum,
        stats,
        levels,
        skip_reason: skipReason,
        ...(stored?.alert_ids ? { alert_ids: stored.alert_ids } : {}),
        ...(stored?.fired ? { fired: stored.fired } : {}),
      };
      writeJsonFile(baselinePath, raw);
      enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: false, alertsSkipReason: skipReason });
      continue;
    }

    // Two alerts per open trade (avg stop + avg target) — the max-MAE/max-MFE pair was
    // dropped to fit the account's alert quota (user decision 2026-07-23). All four levels
    // are still computed and stored in the baseline for the dashboard's Alert Levels column.
    // "Open Pos" marks a position with a real order placed at the executor (vs. just being
    // tracked/monitored) so it reads at a glance from the TradingView alert list/notification
    // itself, without cross-checking the dashboard.
    const posMarker = isWebhookSent ? ' | Open Pos' : '';
    const alertDefs = [
      { price: levels.stopAvg,   msg: `${sym} ${tf}${posMarker} | Stop avg MAE ${stats.avgAdversePct}% | Entry ${entryNum}` },
      { price: levels.targetAvg, msg: `${sym} ${tf}${posMarker} | Target avg MFE ${stats.avgFavorablePct}% | Entry ${entryNum}` },
    ];

    // Respect alert quota — save levels to baseline so the dashboard can show them even
    // when a real TradingView alert can't be created. These trades fall back to local-only
    // overflow monitoring (see processLevelViolationsAndCleanup), so the label is deferred
    // to "Local alert i/n" (computed after the loop) rather than exposing the raw quota math.
    if (usedSlots + alertDefs.length > MAX_ALERTS) {
      let evictedKey = null;
      if (isWebhookSent) {
        const rawForEviction = parseJsonFile(baselinePath, {});
        const candidate = findEvictionCandidate(rawForEviction.excursion_alerts);
        if (candidate) {
          try {
            await alerts.deleteAlerts({ alert_ids: candidate.entry.alert_ids });
            rawForEviction.excursion_alerts[candidate.key] = {
              ...candidate.entry,
              created: false,
              alert_ids: [],
              skip_reason: `Evicted for webhook-sent ${sym} ${tf}`,
            };
            writeJsonFile(baselinePath, rawForEviction);
            evictedKey = candidate.key;
            // Re-check the real count rather than assume both alert_ids in the pair were
            // still active — one side (typically the stop) may have already self-fired and
            // gone inactive, in which case it wasn't counted against usedSlots to begin with.
            try {
              const freshList = await alerts.list();
              usedSlots = (freshList.alerts || []).filter(a => a.active).length;
            } catch {
              usedSlots = Math.max(0, usedSlots - candidate.entry.alert_ids.length);
            }
          } catch {}
        }
      }
      if (!evictedKey) {
        const enrichedIndex = enriched.length;
        enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: false, alertsSkipReason: null });
        quotaOverflow.push({ enrichedIndex, key, entryNum, stats, levels, stored });
        continue;
      }
      // Eviction freed a slot — fall through to create this (higher-priority) trade's alerts below.
    }

    let allCreated = true;
    const createdIds = [];
    for (const def of alertDefs) {
      try {
        const r = await alerts.create({ price: def.price, message: def.msg, symbol, timeframe });
        if (r?.success) { if (r.alert_id != null) createdIds.push(r.alert_id); }
        else allCreated = false;
        await new Promise(res => setTimeout(res, 800));
      } catch {
        allCreated = false;
      }
    }

    if (allCreated) usedSlots += alertDefs.length;

    const raw = parseJsonFile(baselinePath, {});
    if (!raw.excursion_alerts) raw.excursion_alerts = {};
    // Preserve fired-level dedup flags and any previously created TradingView alert ids
    // across rewrites — this entry is rewritten on every retry while creation keeps
    // failing, and losing `fired` would re-push the same level violation every scan.
    raw.excursion_alerts[key] = {
      created: allCreated,
      created_at: new Date().toISOString(),
      entry_price: entryNum,
      stats,
      levels,
      alert_ids: [...new Set([...(stored?.alert_ids || []), ...createdIds])],
      ...(stored?.fired ? { fired: stored.fired } : {}),
    };
    writeJsonFile(baselinePath, raw);

    enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: allCreated });
  }

  if (quotaOverflow.length > 0) {
    const raw = parseJsonFile(baselinePath, {});
    if (!raw.excursion_alerts) raw.excursion_alerts = {};
    const n = quotaOverflow.length;
    quotaOverflow.forEach(({ enrichedIndex, key, entryNum, stats, levels, stored }, i) => {
      const skipReason = `Local alert ${i + 1}/${n}`;
      raw.excursion_alerts[key] = {
        created: false,
        created_at: new Date().toISOString(),
        entry_price: entryNum,
        stats,
        levels,
        skip_reason: skipReason,
        ...(stored?.alert_ids ? { alert_ids: stored.alert_ids } : {}),
        ...(stored?.fired ? { fired: stored.fired } : {}),
      };
      enriched[enrichedIndex].alertsSkipReason = skipReason;
    });
    writeJsonFile(baselinePath, raw);
  }

  return enriched;
}

// Local "overflow" level monitoring + lifecycle cleanup. Runs on every scan and consumes no
// TradingView alert quota. All four excursion levels are computed and stored in the baseline;
// only the avg pair is covered by real TradingView alerts (when creation works). This pass:
//   1. For each OPEN trade scanned this run, checks the fresh quote against its stored
//      levels — always the max pair (never TV-backed), plus the avg pair while no TV alert
//      exists for it — and emits a one-time notify line per level per trade entry
//      (deduplicated via a `fired` map on the baseline entry).
//   2. When a scanned symbol's trade reads EXIT (position closed), the stored entry is
//      removed so monitoring stops; any TradingView alert ids it carried are parked in
//      baseline.pending_alert_cleanup for deletion once the delete_alerts API schema is
//      captured (see open_issues.txt — create/delete REST schemas still unknown).
// Checks run at each watchlist's own scan cadence — a 15m trade is checked every 15 minutes,
// a 4H trade every 4 hours. That granularity (vs TradingView's tick-level alerts) is the
// accepted tradeoff for levels that don't fit the alert quota.
/**
 * excursion_alerts entries whose symbol/timeframe is no longer part of ANY current watchlist —
 * the TradingView-alert twin of findWatchlistOrphans() in trade_log.js. The EXIT-driven cleanup
 * below only fires for entries a scan actually observes reading EXIT, which requires that exact
 * symbol/timeframe to still be scanned at all. A symbol dropped from its watchlist (renamed
 * watchlist, removed symbol, or fully orphaned like KORU) leaves that path with nothing to ever
 * trigger it — the TradingView alert just sits active until it self-fires or hits its ~30-day
 * expiration. Verified live 2026-07-28: TSLA|1D, USO|60, EDC|60 all carried active, never-fired
 * alerts with no path back to cleanup; MU|30's stop-side alert had already self-fired hours
 * earlier, unnoticed, because MU|30 hadn't been scanned since it dropped out of "Swing 30m".
 */
function findOrphanedExcursionAlerts(baseline, watchlistNames = null) {
  // baseline.watchlists accumulates dead entries under old names forever — nothing ever deletes
  // them on a rename (confirmed live: "Swing 30min" still sits in the baseline, superseded by
  // "Swing 30m", but syncWatchlistSymbolsFromTradingView only ever iterates rules.json's
  // configured names). Treating every baseline.watchlists key as "real" would have missed exactly
  // the MU|30 case this function exists to catch: MU is only in the dead "Swing 30min" entry, not
  // the real "Swing 30m" one. When watchlistNames isn't given (no rules available), fall back to
  // trusting every baseline entry rather than risk flagging everything as orphaned.
  const allowedNames = Array.isArray(watchlistNames) ? new Set(watchlistNames) : null;
  const inWatchlists = new Set(); // "TICKER|rawTimeframe", e.g. "MU|30"
  for (const [name, w] of Object.entries(baseline?.watchlists || {})) {
    if (allowedNames && !allowedNames.has(name)) continue;
    const tf = String(w?.timeframe ?? '');
    for (const s of w?.symbols || []) {
      const ticker = String(s ?? '').split(':').pop()?.toUpperCase() || '';
      if (ticker) inWatchlists.add(`${ticker}|${tf}`);
    }
  }
  const orphans = [];
  for (const [key, entry] of Object.entries(baseline?.excursion_alerts || {})) {
    const pipe = key.lastIndexOf('|');
    if (pipe < 0) continue;
    const ticker = key.slice(0, pipe).split(':').pop()?.toUpperCase() || '';
    const tf = key.slice(pipe + 1);
    if (inWatchlists.has(`${ticker}|${tf}`)) continue;
    orphans.push({
      key,
      ticker,
      timeframe: tf,
      alert_ids: Array.isArray(entry?.alert_ids) ? entry.alert_ids : [],
      created: Boolean(entry?.created),
    });
  }
  return orphans;
}

// Transition-mode ntfy filter (2026-08-02): `rules.ntfy.only_timeframes` restricts every push
// channel to the listed timeframes, accepting either raw resolution ("15") or human tag ("15m") on
// either side so a caller doesn't have to know which form a given field carries. Empty/absent means
// no filtering — same "unset means disabled" convention every other gate in this codebase follows.
function timeframeMatchesAllowlist(tf, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/^(\d+)m$/, '$1');
  const want = norm(tf);
  return allowlist.some((a) => norm(a) === want);
}

/**
 * CDP half of the manual-ledger exit check: navigates the chart to each open manual-ledger symbol
 * in turn and reads its quote. Sequential (TradingView Desktop is one chart) with per-symbol
 * try/catch so a delisted or mistyped symbol can't abort the rest.
 *
 * Three guards here are load-bearing, not defensive padding — each covers a path that yields a
 * plausible WRONG price rather than an error, which would then fire a real ntfy push naming the
 * wrong instrument:
 *
 *  1. `wait_timeout` + `chart_ready`. setSymbol resolves `{success: true, chart_ready: false}` on a
 *     timed-out load (chart.js:51-52) — it never throws, so a try/catch alone catches nothing.
 *  2. `getQuote()` with NO argument. Passing one makes it echo that symbol back as `quote.symbol`
 *     (data.js:956) while `last` still comes from the active chart's bars (data.js:961-966); with
 *     no argument it reports the chart's actual symbol instead.
 *  3. Comparing the chart's reported symbol against the requested ticker, because setSymbol's
 *     early-return is a substring match (chart.js:40-42) and may not have navigated at all.
 */
async function fetchManualLedgerQuotes(openPositions) {
  const quotesById = {};
  const bare = (s) => String(s || '').split(':').pop().toUpperCase();
  for (const pos of openPositions) {
    try {
      const nav = await chart.setSymbol({ symbol: pos.symbol, wait_timeout: 4000 });
      if (!nav?.chart_ready) {
        console.error(`[manual-ledger-exit] chart not ready for ${pos.symbol}, skipping`);
        continue;
      }
      const q = await data.getQuote(); // no argument: reports the chart's ACTUAL symbol
      if (bare(q?.symbol) !== bare(pos.symbol)) {
        console.error(`[manual-ledger-exit] chart shows ${q?.symbol}, wanted ${pos.symbol}, skipping`);
        continue;
      }
      quotesById[pos.id] = Number(q?.last ?? q?.close);
    } catch (err) {
      console.error(`[manual-ledger-exit] quote fetch failed for ${pos.symbol}: ${err?.message || err}`);
    }
  }
  return quotesById;
}

/**
 * Manual-ledger exit detection. Pure: no CDP, no I/O — takes the open rows and a map of already
 * fetched quotes keyed by row id (see fetchManualLedgerQuotes for the CDP half).
 *
 * Mirrors the fired-once dedup pattern in processLevelViolationsAndCleanup below: a position whose
 * exit_alert_fired_at is set is never re-evaluated. Without that, a position sitting past its stop
 * would re-push on every ~15-minute scan for as long as it stayed there.
 *
 * A missing/unusable quote is skipped rather than treated as a level miss — silence is the correct
 * behaviour when the price could not be read, and fetchManualLedgerQuotes deliberately omits any
 * symbol it could not verify the chart had actually navigated to.
 */
export function evaluateManualLedgerExits(openPositions, quotesById, { timezone = DEFAULT_MARKET_HOURS.timezone } = {}) {
  // Number(null) is 0, and 0 is finite — so a plain Number() coercion turns an UNSET target_price
  // (SQLite NULL) into a level of 0 that every real price satisfies, firing a bogus "Target 0" exit
  // on the very first scan. Absent must stay absent.
  const price = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const hits = [];
  for (const pos of openPositions || []) {
    if (!pos || pos.exit_alert_fired_at) continue;
    const last = price(quotesById?.[pos.id]);
    if (last == null) continue;

    const stop = price(pos.stop_price);
    const target = price(pos.target_price);
    let level = null;
    if (stop != null && last <= stop) level = 'stop';
    else if (target != null && last >= target) level = 'target';
    if (!level) continue;

    const triggerPrice = level === 'stop' ? stop : target;
    hits.push({
      id: pos.id,
      level,
      symbol: pos.symbol,
      account: pos.account,
      last,
      triggerPrice,
      line: `${formatTimestamp(new Date(), timezone)} ET | MANUAL EXIT: ${pos.symbol} (${pos.account}) | `
        + `${level === 'stop' ? 'Stop' : 'Target'} ${triggerPrice} (last ${last}) | Entry ${pos.entry_price}`,
    });
  }
  return hits;
}

export function processLevelViolationsAndCleanup({ results = [], baselinePath, timezone = DEFAULT_MARKET_HOURS.timezone, watchlistNames = null } = {}) {
  const raw = parseJsonFile(baselinePath, {});
  if (!raw.excursion_alerts || Object.keys(raw.excursion_alerts).length === 0) {
    return { violation_lines: [], violations: [], cleaned: [] };
  }

  const findStored = (symbol, timeframe) => {
    const key = `${symbol}|${timeframe}`;
    if (raw.excursion_alerts[key]) return [key, raw.excursion_alerts[key]];
    const ticker = String(symbol || '').split(':').pop()?.toUpperCase() || '';
    const hit = Object.entries(raw.excursion_alerts).find(([k]) => {
      const pipe = k.lastIndexOf('|');
      if (pipe < 0) return false;
      return k.slice(0, pipe).split(':').pop()?.toUpperCase() === ticker && k.slice(pipe + 1) === String(timeframe);
    });
    return hit || [null, null];
  };

  const violations = [];
  const cleaned = [];
  let dirty = false;

  for (const entry of results) {
    if (!entry || entry.error) continue;
    const symbol = entry.state?.symbol || entry.symbol;
    const timeframe = String(entry.timeframe || '');
    const [key, stored] = findStored(symbol, timeframe);
    if (!key || !stored) continue;

    const signal = String(entry.trade?.signal || '').toUpperCase();

    // Position confirmed closed — release the overflow entry. A null/failed trade read is
    // NOT treated as closed; only an explicit EXIT is.
    if (signal === 'EXIT') {
      if (Array.isArray(stored.alert_ids) && stored.alert_ids.length > 0) {
        if (!Array.isArray(raw.pending_alert_cleanup)) raw.pending_alert_cleanup = [];
        raw.pending_alert_cleanup.push({ key, alert_ids: stored.alert_ids, closed_at: new Date().toISOString() });
      }
      delete raw.excursion_alerts[key];
      cleaned.push(key);
      dirty = true;
      continue;
    }

    if (signal !== 'OPEN') continue;

    // Local level-hit monitoring (and the ntfy noise it produces) is now scoped to webhook-sent
    // positions only — user request 2026-07-29: with far more symbols across timeframes, a
    // violation line for every monitored position regardless of whether any money is actually on
    // it became unmanageable noise. Checked fresh per scan (not read off `stored`) because
    // webhook-sent status can change after a position's excursion_alerts entry was first written.
    const entryTimeRaw = entry.trade?.entryTime || null;
    const wKey = entryTimeRaw ? sentKey({ symbol, timeframe, entryTime: entryTimeRaw }) : null;
    if (!wKey || !alreadySent(wKey)) continue;

    const last = Number(entry.quote?.last);
    const levels = stored.levels;
    if (!Number.isFinite(last) || !levels) continue;
    // Levels belong to a specific entry price — skip if the position was re-entered at a
    // different price and stats/levels haven't been recomputed for it yet.
    const currentEntry = parseEntryPriceNum(entry.trade?.entryPrice);
    if (currentEntry && stored.entry_price && Math.abs(currentEntry - stored.entry_price) > 0.005) continue;

    const fired = stored.fired || {};
    const tvCovered = stored.created === true;
    const checks = [
      { name: 'stopMax',   label: 'Stop max',   dir: 'below', level: levels.stopMax,   monitor: true },
      { name: 'targetMax', label: 'Target max', dir: 'above', level: levels.targetMax, monitor: true },
      { name: 'stopAvg',   label: 'Stop avg',   dir: 'below', level: levels.stopAvg,   monitor: !tvCovered },
      { name: 'targetAvg', label: 'Target avg', dir: 'above', level: levels.targetAvg, monitor: !tvCovered },
    ];

    for (const check of checks) {
      if (!check.monitor || fired[check.name] || !Number.isFinite(Number(check.level))) continue;
      const hit = check.dir === 'below' ? last <= check.level : last >= check.level;
      if (!hit) continue;
      fired[check.name] = new Date().toISOString();
      stored.fired = fired;
      dirty = true;
      violations.push({
        key,
        symbol,
        timeframe,
        level_name: check.name,
        level: check.level,
        last,
        entry_price: stored.entry_price,
        line: `${formatTimestamp(new Date(), timezone)} ET | LEVEL HIT: ${symbol} ${timeframe} | ${check.label} ${check.level} (last ${last}) | Entry ${stored.entry_price}`,
      });
    }
  }

  // Symbols/timeframes that dropped out of every watchlist entirely — see
  // findOrphanedExcursionAlerts for why the EXIT-driven pass above can never catch these.
  const orphaned = findOrphanedExcursionAlerts(raw, watchlistNames);
  for (const orphan of orphaned) {
    if (orphan.created && orphan.alert_ids.length > 0) {
      if (!Array.isArray(raw.pending_alert_cleanup)) raw.pending_alert_cleanup = [];
      raw.pending_alert_cleanup.push({ key: orphan.key, alert_ids: orphan.alert_ids, closed_at: new Date().toISOString(), reason: 'orphaned_from_watchlist' });
    }
    delete raw.excursion_alerts[orphan.key];
    cleaned.push(orphan.key);
    dirty = true;
  }

  if (dirty) writeJsonFile(baselinePath, raw);
  return { violation_lines: violations.map((v) => v.line), violations, cleaned, orphaned };
}

// Drains baseline.pending_alert_cleanup — TradingView alert ids left behind by trades that
// closed while carrying real TV alerts (see processLevelViolationsAndCleanup above). Runs on
// every scan; entries that fail to delete (e.g. transient network error) stay queued and are
// retried on the next call rather than being dropped.
export async function drainPendingAlertCleanup(baselinePath) {
  const raw = parseJsonFile(baselinePath, {});
  const pending = Array.isArray(raw.pending_alert_cleanup) ? raw.pending_alert_cleanup : [];
  if (pending.length === 0) return { drained: [], remaining: 0 };

  const stillPending = [];
  const drained = [];
  for (const item of pending) {
    try {
      const r = await alerts.deleteAlerts({ alert_ids: item.alert_ids });
      if (r?.success) drained.push(item.key);
      else stillPending.push(item);
    } catch {
      stillPending.push(item);
    }
  }
  raw.pending_alert_cleanup = stillPending;
  writeJsonFile(baselinePath, raw);
  return { drained, remaining: stillPending.length };
}

// Verifies the strategy indicator attached to the live chart matches rules.json's configured
// `strategy` name before trusting any trade/signal data read off of it. It's common to swap in
// a different strategy on the chart temporarily (testing, comparison) — if that's still attached
// when a scan runs, every trade/signal read for that run would silently come from the wrong
// script. There is deliberately no auto-repair: the configured strategy here is a private saved
// script, and TradingView's `createStudy(name)` API can only add public/built-in indicators by
// exact name — it can't restore a private script, so an "auto-repair" attempt would either fail
// silently or, worse, add an unrelated public script of the same name. On mismatch, scanning is
// suspended and flagged until the correct indicator is restored manually on the chart.
async function checkStrategyIdentity({ rules, studyFilter }) {
  let currentState;
  try {
    currentState = await chart.getState();
  } catch {
    // Connection issues are handled by the caller's own connection check; don't double-report.
    return { suspend: false, mismatch: null };
  }

  const attachedNames = (currentState.studies || []).map((s) => s.name);
  const expectedLower = studyFilter.toLowerCase();
  const hasExpected = attachedNames.some((n) => n.toLowerCase().includes(expectedLower));
  const unexpectedStrategyNames = attachedNames.filter(
    (n) => /strategy/i.test(n) && !n.toLowerCase().includes(expectedLower),
  );

  if (hasExpected || unexpectedStrategyNames.length === 0) {
    return { suspend: false, mismatch: null };
  }

  const mismatch = {
    expected: rules.strategy,
    found: unexpectedStrategyNames,
    detected_at: new Date().toISOString(),
  };

  return {
    suspend: true,
    reason: `Strategy mismatch: chart has "${unexpectedStrategyNames.join(', ')}" but rules.json expects "${rules.strategy}". Scanning suspended until this is fixed on the chart.`,
    mismatch,
  };
}

// Sends one ntfy push per line rather than joining them into a single multi-line body — a
// batch of several signals/violations in one notification renders as an unreadable wall of
// text on a phone lock screen, so each gets its own push instead.
async function pushNtfyLines(lines, { url, title, priority, logPrefix }) {
  for (const line of lines) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        body: line,
        headers: {
          'Content-Type': 'text/plain',
          Title: title,
          Priority: String(priority || 'default'),
        },
      });
      if (!resp.ok) {
        console.error(`${logPrefix} failed: HTTP ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      console.error(`${logPrefix} failed: ${err?.message || String(err)}`);
    }
  }
}

export async function runSignalJob({
  rules_path,
  changed_only = true,
  notify = false,
  force = false,
  watchlistNames = null,
  syncWatchlists = true,
  onProgress = null,
  onWatchlistComplete = null,
} = {}) {
  const { rules } = loadRules(rules_path);
  const baselinePath = resolve(rules.baseline_file || DEFAULT_BASELINE_PATH);
  const baseline = loadBaseline(baselinePath);
  const marketHours = rules.market_hours || baseline.market_hours || DEFAULT_MARKET_HOURS;
  const { watchlist = [], default_timeframe = '240', watchlists = {} } = rules;
  const scanTargets = buildScanTargets({ watchlist, default_timeframe, watchlists });
  const studyFilter = String(rules.strategy || 'Swing Profile').split('—')[0].trim();

  const now = new Date();

  // Roll the materialized holiday calendar before any gate runs. It is additive — nothing in this
  // function reads it, because isMarketHoliday() computes holidays directly — so a failure costs a
  // log line and never a scan. It exists for the PowerShell gates, which read the file.
  try {
    const rolled = syncMarketHolidayCalendar({ marketHours, now });
    if (rolled.changed) {
      const parts = [];
      if (rolled.added.length) parts.push(`added ${rolled.added.join(', ')}`);
      if (rolled.removed.length) parts.push(`purged ${rolled.removed.join(', ')}`);
      console.log(`[holidays] calendar ${rolled.reason}${parts.length ? ` — ${parts.join('; ')}` : ''}`);
    }
  } catch (error) {
    console.log(`[holidays] calendar sync failed: ${error?.message || error}`);
  }

  const scheduleDisabled = Boolean(rules.schedule?.disabled);
  if (!force && scheduleDisabled) {
    const skippedResult = buildOutsideHoursResult({
      marketHours,
      scanTargets,
      baseline,
      reason: 'Scheduled scanning disabled',
    });
    skippedResult.schedule_disabled = true;
    skippedResult.open_trades = enrichOpenTradesFromBaseline(skippedResult.open_trades, baseline.excursion_alerts);
    writeLatestStatus(skippedResult);
    return skippedResult;
  }

  if (!force && !shouldRunEquityScanNow(now, marketHours)) {
    const skippedResult = buildOutsideHoursResult({
      marketHours,
      scanTargets,
      baseline,
      reason: 'Outside market hours',
    });
    skippedResult.open_trades = enrichOpenTradesFromBaseline(skippedResult.open_trades, baseline.excursion_alerts);
    writeLatestStatus(skippedResult);
    return skippedResult;
  }

  try {
    await ensureTradingViewConnection();
  } catch (error) {
    const errorResult = buildConnectionErrorResult({
      marketHours,
      scanTargets,
      baseline,
      reason: `TradingView connection unavailable. ${error?.message || String(error)}`,
    });
    errorResult.open_trades = enrichOpenTradesFromBaseline(errorResult.open_trades, baseline.excursion_alerts);
    writeLatestStatus(errorResult);
    return errorResult;
  }

  const strategyCheck = await checkStrategyIdentity({ rules, studyFilter });
  if (strategyCheck.suspend) {
    const skippedResult = buildOutsideHoursResult({
      marketHours,
      scanTargets,
      baseline,
      reason: strategyCheck.reason,
    });
    skippedResult.strategy_mismatch = strategyCheck.mismatch;
    skippedResult.open_trades = enrichOpenTradesFromBaseline(skippedResult.open_trades, baseline.excursion_alerts);
    writeLatestStatus(skippedResult);
    return skippedResult;
  }

  const syncResult = syncWatchlists
    ? await syncWatchlistSymbolsFromTradingView({ rules, baselinePath }).catch(() => null)
    : null;
  if (syncResult?.watchlists) {
    baseline.watchlists = syncResult.watchlists;
  }

  // Recompute which logged tickers no longer belong to any watchlist, and persist it onto the
  // baseline (writeLatestStatus() overwrites the whole status file every run, so an in-memory-only
  // value would flicker to empty between runs). Detection only — nothing is archived automatically;
  // see the confirm-gated "Archive Now" flow this feeds on the dashboard.
  //
  // Runs on EVERY scan, not only after a live resync. It used to be gated on
  // `syncResult.synced.length > 0`, which is the exact mistake buildWatchlistSyncFromBaseline was
  // written to fix for the watchlist panel: the gate keys on the *sync event* while the data source
  // is `baseline.watchlists`, which is already the persisted source of truth and is equally valid on
  // a scan that didn't resync. Found 2026-07-29 with 12 real orphans present, fresh membership, and
  // `trade_log_orphans` still null — the card had been claiming "No orphaned symbols detected" for as
  // long as the feature had existed, because no run had ever satisfied the gate. The empty-membership
  // case is handled inside findWatchlistOrphans (returns [], never "everything is an orphan").
  try {
    const orphans = tradeLog.findWatchlistOrphans(baseline, Object.keys(rules.watchlists || {}));
    baseline.trade_log_orphans = orphans;
    const raw = parseJsonFile(baselinePath, {});
    raw.trade_log_orphans = orphans;
    writeJsonFile(baselinePath, raw);
  } catch (err) {
    console.error(`[orphans] could not recompute trade-log orphans: ${err?.message || err}`);
  }

  let dueScanTargets = force ? scanTargets : filterScanTargetsBySchedule(scanTargets, now, marketHours, baseline.watchlists);
  if (Array.isArray(watchlistNames) && watchlistNames.length > 0) {
    const filterSet = new Set(watchlistNames);
    dueScanTargets = dueScanTargets.filter(t => filterSet.has(t.watchlistName));
  }
  if (!force && dueScanTargets.length === 0) {
    const skippedResult = buildOutsideHoursResult({
      marketHours,
      scanTargets,
      baseline,
      reason: 'No watchlists are due for scan at this minute',
    });
    skippedResult.open_trades = enrichOpenTradesFromBaseline(skippedResult.open_trades, baseline.excursion_alerts);
    writeLatestStatus(skippedResult);
    return skippedResult;
  }

  const result = await runBrief({
    rules_path,
    signals_only: true,
    changed_only,
    update_baseline: true,
    scan_targets: dueScanTargets,
    full_scan_targets: scanTargets,
    onProgress,
    onWatchlistComplete,
  });

  result.watchlist_sync = Array.isArray(syncResult?.synced) && syncResult.synced.length > 0
    ? syncResult.synced
    : buildWatchlistSyncFromBaseline(baseline, Object.keys(rules.watchlists || {}));
  result.trade_log_orphans = Array.isArray(baseline.trade_log_orphans) ? baseline.trade_log_orphans : [];
  result.watchlistOptions = Array.isArray(syncResult?.watchlistOptions) ? syncResult.watchlistOptions : [];
  result.activeWatchlistName = syncResult?.activeWatchlistName || null;
  result.strategy_mismatch = strategyCheck.mismatch || null;

  // Local overflow-level monitoring + closed-trade cleanup (see processLevelViolationsAndCleanup).
  const levelCheck = processLevelViolationsAndCleanup({
    results: result.all_scan_results,
    baselinePath,
    timezone: marketHours.timezone || DEFAULT_MARKET_HOURS.timezone,
    watchlistNames: Object.keys(rules.watchlists || {}),
  });
  result.level_violations = levelCheck.violations;
  if (levelCheck.violation_lines.length > 0) {
    result.watchlist_summary_lines = [...(result.watchlist_summary_lines || []), ...levelCheck.violation_lines];
    result.summary_line = [result.summary_line, ...levelCheck.violation_lines].filter(Boolean).join('\n');
  }

  try {
    result.alert_cleanup = await drainPendingAlertCleanup(baselinePath);
  } catch {
    result.alert_cleanup = { drained: [], remaining: null };
  }

  // Manual-ledger exit check. Runs AFTER the pine-strategy scan has finished for this cycle rather
  // than interleaved with it, so only one chart navigation is ever in flight. Manual positions are
  // deliberately NOT added to buildScanTargets — that universe drives the actual Swing Profile
  // backtest per symbol, and a hand-tracked holding has nothing to do with that strategy; merging
  // it in would produce irrelevant "new signal" pushes and trade-log rows for it.
  //
  // Additive and wrapped: nothing downstream gates on these fields, so a failure costs a log line,
  // never the scan's own results.
  result.manual_ledger_exits = [];
  try {
    const openManual = listManualPositions({ status: 'open' });
    if (openManual.length > 0) {
      const quotesById = await fetchManualLedgerQuotes(openManual);
      const hits = evaluateManualLedgerExits(openManual, quotesById, {
        timezone: marketHours.timezone || DEFAULT_MARKET_HOURS.timezone,
      });
      for (const hit of hits) {
        markManualPositionExitAlerted(hit.id, { level: hit.level, firedAt: new Date().toISOString() });
      }
      result.manual_ledger_exits = hits;

      // DELIBERATELY NOT filtered by rules.ntfy.only_timeframes, unlike the three pushes below.
      // Creating a manual ledger entry by hand IS the per-position opt-in, and it is finer-grained
      // than a timeframe allowlist. Filtering here would mean a 4H ledger entry created under the
      // current ["15"] transition setting silently never notifies — the feature would look wired up
      // and do nothing. If this ever needs to be mutable, give it its own switch rather than
      // folding it into only_timeframes.
      if (notify && hits.length > 0 && rules.ntfy?.url) {
        await pushNtfyLines(hits.map((h) => h.line), {
          url: rules.ntfy.url,
          title: "Manual ledger exit",
          priority: rules.ntfy.priority || 'high',
          logPrefix: '[manual-ledger-exit]',
        });
      }
    }
  } catch (err) {
    console.error(`[manual-ledger-exit] check failed: ${err?.message || err}`);
  }

  // `rules.ntfy.only_timeframes` mutes the push side only — dashboard fields above
  // (result.notify_signal_lines, watchlist_summary_lines/summary_line) stay unfiltered, since muting
  // a phone push is not the same claim as hiding something from the dashboard.
  const ntfyOnlyTimeframes = rules.ntfy?.only_timeframes || null;
  const ntfySignalLines = result.notify_signal_lines.filter((_, i) =>
    timeframeMatchesAllowlist(result.notify_signal_events[i]?.timeframe, ntfyOnlyTimeframes));
  if (notify && ntfySignalLines.length > 0 && rules.ntfy?.url) {
    await pushNtfyLines(ntfySignalLines, {
      url: rules.ntfy.url,
      title: "TradingView signal scan",
      priority: rules.ntfy.priority,
      logPrefix: "ntfy push",
    });
  }

  // Level violations push separately with their own title so a stop/target hit is
  // distinguishable from a new-signal notification at a glance.
  const ntfyViolationLines = levelCheck.violations
    .filter((v) => timeframeMatchesAllowlist(v.timeframe, ntfyOnlyTimeframes))
    .map((v) => v.line);
  if (notify && ntfyViolationLines.length > 0 && rules.ntfy?.url) {
    await pushNtfyLines(ntfyViolationLines, {
      url: rules.ntfy.url,
      title: "TradingView level alert",
      priority: rules.ntfy.priority,
      logPrefix: "ntfy level-alert push",
    });
  }

  // Auto-fire the trade webhook for armed timeframes. Gated on `notify` for the same reason the
  // ntfy push is: only the real scheduled path (run_signal_job.js --notify) sets it, so no
  // dashboard-triggered or ad-hoc scan can ever place a live order while debugging.
  result.webhook_dispatch = notify
    ? await dispatchTradeWebhooks(result.notify_signal_events || [], rules)
    : { sent: [], skipped: [], failed: [], armed: [] };
  result.webhook_exit_dispatch = notify
    ? await dispatchExitWebhooks(result.notify_exit_events || [], rules)
    : { sent: [], skipped: [], failed: [], armed: [] };

  // Ledger-only recording for timeframes whose orders TradingView's own watchlist alert places.
  // Deliberately NOT gated on `notify`, unlike the two dispatchers above: this sends nothing, it
  // only writes down an order somebody else already placed. Gating it would leave the ledger with
  // holes on any day a manual scan was the one that first observed the position — and the ledger's
  // completeness is the whole point of this mode.
  // The baseline supplies the live-synced membership of the tv-alert watchlists, which scopes the
  // recording to the symbols TradingView actually alerts on (see recordTvAlertLedger).
  result.webhook_tv_alert_ledger = recordTvAlertLedger(
    result.notify_signal_events || [],
    result.notify_exit_events || [],
    rules,
    parseJsonFile(baselinePath, {}),
  );

  result.webhook_exit_pending = findUnclosedWebhookExits(result.all_scan_results);

  // Cross-timeframe exits on symbols held via webhook. Detection runs on every scan (the dashboard
  // half is free and must not depend on `notify`); only the push half is gated, exactly like the two
  // dispatchers above.
  try {
    result.cross_tf_exits = findCrossTimeframeExits(result.all_scan_results);
  } catch (err) {
    console.error(`[cross-tf] detection failed: ${err?.message || err}`);
    result.cross_tf_exits = [];
  }
  // Filtered on the HELD leg's timeframe, not the exit's — "mute except 15m" means "only tell me
  // about a position I actually hold on 15m," regardless of which slower timeframe's exit triggered
  // the notice. result.cross_tf_exits itself stays unfiltered (dashboard rows attach every entry).
  const ntfyCrossTfExits = result.cross_tf_exits.filter((x) =>
    timeframeMatchesAllowlist(x.held_timeframe, ntfyOnlyTimeframes));
  if (notify && ntfyCrossTfExits.length > 0 && rules.ntfy?.url) {
    try {
      // Dedupe state lives on the baseline alongside pending_alert_cleanup — a standing EXIT stays
      // the last closed trade for days, so without persistence every 15-minute scan would re-push it.
      const raw = parseJsonFile(baselinePath, {});
      const seen = Array.isArray(raw.cross_tf_notified) ? raw.cross_tf_notified : [];
      const { lines, keys } = crossTfExitNotifyLines(ntfyCrossTfExits, {
        alreadyNotified: new Set(seen),
        now,
        timezone: marketHours?.timezone,
      });
      if (lines.length > 0) {
        await pushNtfyLines(lines, {
          url: rules.ntfy.url,
          title: "TradingView cross-TF exit",
          priority: rules.ntfy.priority,
          logPrefix: "ntfy cross-tf push",
        });
        // Recorded only after the push is attempted, and trimmed to the most recent 500 so the
        // baseline can't grow without bound.
        raw.cross_tf_notified = [...seen, ...keys].slice(-500);
        writeJsonFile(baselinePath, raw);
        result.cross_tf_notified_lines = lines;
      }
    } catch (err) {
      console.error(`[cross-tf] push failed: ${err?.message || err}`);
    }
  }

  writeLatestStatus(result);
  return result;
}

/**
 * Positions this system opened via webhook whose strategy position has since closed, but for which
 * no close order was ever sent. Detection only — nothing is dispatched from here.
 *
 * This exists because the automatic exit path can miss an exit permanently, and silently. To be
 * dispatched, an EXIT has to be in `changedSignals` AND carry an `exitTime` on the same ET trading
 * day as the scan (see notifyExitEntries). Both are reasonable for the normal case and both fail the
 * same way: if no scan runs on the day a position exits — machine asleep, TradingView down, or an
 * earlier long-running scan still holding the Task Scheduler slot — the next day's scans see the exit
 * as neither changed nor same-day, and the close never goes out. The ledger keeps saying we hold a
 * position the strategy closed days ago, and nothing says otherwise.
 *
 * Deliberately NOT auto-dispatched despite that. Sending a close order off multi-day-old inferred
 * state is outward-facing and hard to reverse: if the position was closed at the broker some other
 * way, the order would try to sell something no longer held. Surfacing it with a one-click Close —
 * the same detect/surface/confirm shape as the trade-log orphan banner and the strategy-identity
 * guard — puts a human in front of the stale case while the fresh case still closes automatically.
 */
/**
 * EXIT signals on a DIFFERENT timeframe than one you hold a live webhook position on.
 *
 * The same ticker is routinely open on several timeframes — measured 2026-07-31, 47 of 86 open
 * tickers were, and 5 of 6 webhook-sent positions had other legs (TD alone had five). When one of
 * those other legs flips, that is information about a position with real money on it, and nothing
 * surfaced it: the ledger only knows the leg it sent, and the EXIT arrives under a timeframe whose
 * key isn't in the ledger at all, so every existing webhook path skips it.
 *
 * Scoped to webhook-held tickers ONLY, and that scoping is what makes it usable rather than noise:
 * unscoped it would fire on every EXIT across 47 tickers. Even scoped, expect ~34/month (~8/week) at
 * six positions — which is why the push half is narrower still (see `crossTfExitNotifyLines`).
 *
 * `relation` is the whole point of the record. An exit on a SLOWER timeframe than the one you hold
 * (hold 2h, the 4h turns) means the larger trend rolled over underneath you. An exit on a FASTER one
 * (hold 2h, the 45m turns) is a wiggle inside your own timeframe. Both are shown; only the first is
 * worth interrupting for.
 *
 * Detection only — this never closes anything. The held leg's own strategy has not signalled an
 * exit; another timeframe's has, and whether that means anything for your position is a judgement
 * call, so it surfaces next to the Close buttons and stops there.
 */
export function findCrossTimeframeExits(scanResults) {
  const state = readSentState().sent || {};
  // Open webhook positions, indexed by bare ticker — a ticker can hold more than one (different
  // timeframes), so this is a list per ticker, not a single record.
  const heldByTicker = new Map();
  for (const [key, rec] of Object.entries(state)) {
    if (rec?.exit) continue;
    const [ticker, tag] = String(key).split('|');
    if (!ticker || !tag) continue;
    if (!heldByTicker.has(ticker)) heldByTicker.set(ticker, []);
    heldByTicker.get(ticker).push({ key, tag, record: rec });
  }
  if (heldByTicker.size === 0) return [];

  const out = [];
  for (const entry of (Array.isArray(scanResults) ? scanResults : [])) {
    if (String(entry?.trade?.signal || "").toUpperCase() !== "EXIT") continue;
    const symbol = entry.state?.symbol || entry.symbol || null;
    if (!symbol) continue;
    const exitTag = timeframeTag(entry.timeframe);
    const held = heldByTicker.get(bareTicker(symbol)) || [];
    for (const h of held) {
      // Same timeframe is the ordinary exit — dispatchExitWebhooks and findUnclosedWebhookExits
      // already own that case, and reporting it here would double up on both.
      if (h.tag === exitTag) continue;
      const heldMin = timeframeToMinutes(tagToResolution(h.tag));
      const exitMin = timeframeToMinutes(entry.timeframe);
      out.push({
        ticker: bareTicker(symbol),
        symbol,
        held_key: h.key,
        held_timeframe: h.tag,
        held_side: h.record.side || null,
        held_entry_price: h.record.price ?? null,
        held_entry_time: String(h.key).split('|')[2] || null,
        held_sent_at: h.record.at || null,
        exit_timeframe: exitTag,
        exit_watchlist: entry.watchlist_name || null,
        exit_time: entry.trade?.exitTime || null,
        exit_price: entry.trade?.exitPrice ?? null,
        // Preformatted by data.js as "$123.45 | +4.50%" — kept as text rather than reparsed into a
        // number, since every consumer here only displays it.
        exit_pnl: entry.trade?.netPnl ?? null,
        // null when either timeframe can't be parsed — surfaced as unknown rather than guessed,
        // and the push gate treats unknown as not-slower (i.e. dashboard only).
        relation: heldMin && exitMin ? (exitMin >= heldMin ? "slower" : "faster") : null,
      });
    }
  }
  return out;
}

/**
 * Invert timeframeTag() back to a TradingView resolution so timeframeToMinutes can read it. The
 * ledger stores the human tag ("45m", "1d"); scan results carry the raw resolution ("45", "D").
 */
function tagToResolution(tag) {
  const t = String(tag || "").trim().toLowerCase();
  const m = /^(\d+)(m|h|d|w|mo)$/.exec(t);
  if (!m) return t;
  const n = Number(m[1]);
  if (m[2] === "m") return String(n);
  if (m[2] === "h") return String(n * 60);
  if (m[2] === "d") return n === 1 ? "D" : String(n * 1440);
  if (m[2] === "w") return "W";
  return "M";
}

/**
 * The push half, deliberately narrower than the dashboard half.
 *
 * Three gates, each removing a distinct kind of noise:
 *  - `relation === "slower"` — a faster leg turning is a wiggle inside the held timeframe, still
 *    visible on the dashboard but not worth an interrupt. This is the gate that takes ~8/week down
 *    to ~2-3.
 *  - same ET trading day as the scan, judged on the EXIT's own timestamp (never the held position's
 *    entry time, which is days old by definition — the same trap documented for dispatchExitWebhooks).
 *    A DOM-sourced EXIT has no exitTime and is therefore never pushed, rather than guessed at.
 *  - not already pushed, keyed `ticker|exitTf|exitTime`. Without this the same standing exit would
 *    re-push every 15 minutes for as long as it remained the last closed trade.
 */
export function crossTfExitNotifyLines(crossExits, { alreadyNotified = new Set(), now = new Date(), timezone } = {}) {
  const lines = [];
  const keys = [];
  for (const x of (Array.isArray(crossExits) ? crossExits : [])) {
    if (x.relation !== "slower") continue;
    if (!x.exit_time || !isSameTradingDay(x.exit_time, now, timezone)) continue;
    const dedupeKey = `${x.ticker}|${x.exit_timeframe}|${x.exit_time}`;
    if (alreadyNotified.has(dedupeKey)) continue;
    keys.push(dedupeKey);
    const pnl = x.exit_pnl && x.exit_pnl !== "—" ? ` (${x.exit_pnl})` : "";
    const px = x.exit_price && x.exit_price !== "—" ? x.exit_price : "?";
    lines.push(`CROSS-TF EXIT: ${x.ticker} ${x.exit_timeframe} exited @ ${px}${pnl} | you hold ${x.held_timeframe} via webhook | review`);
  }
  return { lines, keys };
}

export function findUnclosedWebhookExits(scanResults) {
  const out = [];
  for (const entry of (Array.isArray(scanResults) ? scanResults : [])) {
    if (String(entry?.trade?.signal || "").toUpperCase() !== "EXIT") continue;
    const symbol = entry.state?.symbol || entry.symbol || null;
    const entryTime = entry.trade?.entryTime || null;
    if (!symbol || !entryTime) continue;
    const key = sentKey({ symbol, timeframe: entry.timeframe, entryTime });
    const record = key ? getSentRecord(key) : null;
    // Only positions WE opened and never closed. tv-alert entries are excluded for the same reason
    // the dispatcher excludes them: TradingView sends their close.
    if (!record || record.exit || record.source === "tv-alert") continue;
    out.push({
      symbol,
      timeframe: entry.timeframe,
      watchlist_name: entry.watchlist_name || null,
      side: entry.trade?.side || null,
      entry_time: entryTime,
      entry_price: record.price ?? null,
      exit_time: entry.trade?.exitTime || null,
      exit_price: entry.trade?.exitPrice ?? null,
      sent_at: record.at || null,
      source: record.source || null,
    });
  }
  return out;
}

/**
 * Record OPEN/EXIT signals on TradingView-alert timeframes into the webhook ledger without sending
 * anything.
 *
 * The subscription only carries two watchlist alerts, and those POST to the Railway executor
 * directly — so for those timeframes a real order exists that this system never sent and therefore
 * had no record of. That hole had four consequences, all of them silent:
 *   - the dashboard offered a "Send" button on a position that was already filled (duplicate-order risk),
 *   - price-alert auto-creation and local level monitoring skipped it (both now scoped to
 *     webhook-sent positions), so a live-money position got no monitoring at all,
 *   - it never competed for the TradingView alert quota, losing to positions with no money on them,
 *   - and there was no single place to reconcile live positions against the executor's own portfolio.
 *
 * Writing the same ledger record the scanner would have written closes all four at once, because
 * every one of those paths already keys on `alreadySent(key)`.
 *
 * `sent: false` + `source: "tv-alert"` mark the record as observed-not-sent. Nothing branches on
 * those fields today — `alreadySent()` only tests for the record's existence — they exist so the UI
 * can label the row honestly and so a future reconciliation can tell the two origins apart.
 */
export function recordTvAlertLedger(entryEvents, exitEvents, rules, baseline = null) {
  const out = { recorded: [], recorded_exits: [], skipped: [], timeframes: [], scope: null };
  const settings = loadWebhookSettings(rules);
  out.timeframes = settings.tvAlertTimeframes;
  if (settings.tvAlertTimeframes.length === 0) return out;

  /**
   * Symbol scope: the (ticker, timeframe) pairs TradingView actually alerts on.
   *
   * Built from the named watchlists' live-synced membership, so it tracks whatever is really in the
   * TradingView list rather than a hand-maintained copy that silently drifts.
   *
   * **Fails CLOSED, deliberately inverting this project's usual "unknown membership gates nothing"
   * convention.** That convention is right for analysis, where over-including is harmless. Here
   * over-including writes a ledger record asserting a live broker position, which takes alert quota
   * from real positions and offers a Close button that sends a real order. When the scope is
   * configured but unresolvable, record nothing and say why.
   */
  let scopeSet = null;
  if (settings.tvAlertWatchlists.length) {
    scopeSet = new Set();
    const wl = baseline?.watchlists || {};
    for (const name of settings.tvAlertWatchlists) {
      const entry = wl[name];
      const tf = String(entry?.timeframe ?? rules?.watchlists?.[name]?.timeframe ?? "");
      for (const s of entry?.symbols || []) {
        const t = String(s ?? "").split(":").pop().toUpperCase();
        if (t && tf) scopeSet.add(`${t}|${tf}`);
      }
    }
    out.scope = { watchlists: settings.tvAlertWatchlists, pairs: scopeSet.size };
  }

  const inScope = (ev) => {
    if (!settings.tvAlertTimeframes.includes(String(ev.timeframe))) return false;
    if (!scopeSet) return true;
    const t = String(ev.symbol ?? "").split(":").pop().toUpperCase();
    return scopeSet.has(`${t}|${String(ev.timeframe)}`);
  };

  if (scopeSet && scopeSet.size === 0) {
    console.warn(
      `[webhook] tv_alert_watchlists is set (${settings.tvAlertWatchlists.join(", ")}) but resolved to 0 symbols — ` +
      "recording nothing this run rather than assuming every scanned symbol is traded by TradingView.",
    );
    out.skipped.push({ reason: "tv_alert_scope_unresolved", watchlists: settings.tvAlertWatchlists });
    return out;
  }

  const onTvAlertTimeframe = inScope;

  for (const ev of (Array.isArray(entryEvents) ? entryEvents : []).filter(onTvAlertTimeframe)) {
    const key = sentKey({ symbol: ev.symbol, timeframe: ev.timeframe, entryTime: ev.entry_time });
    // Same refusal as the send paths: an unknown entry time yields no stable key, and fabricating
    // one would corrupt every dedupe/recency check that reads it later.
    if (!key) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "no_entry_time" });
      continue;
    }
    if (alreadySent(key)) continue;
    recordSent(key, {
      symbol: bareTicker(ev.symbol),
      tag: timeframeTag(ev.timeframe),
      side: orderAction(ev.side),
      price: ev.entry_price === null || ev.entry_price === undefined ? "" : String(ev.entry_price),
      sent: false,
      source: "tv-alert",
    });
    out.recorded.push({ symbol: bareTicker(ev.symbol), tag: timeframeTag(ev.timeframe) });
    console.log(`[webhook] ledger-only ENTRY ${bareTicker(ev.symbol)} (${timeframeTag(ev.timeframe)}) — placed by TradingView alert`);
  }

  for (const ev of (Array.isArray(exitEvents) ? exitEvents : []).filter(onTvAlertTimeframe)) {
    const key = sentKey({ symbol: ev.symbol, timeframe: ev.timeframe, entryTime: ev.entry_time });
    if (!key) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "no_entry_time" });
      continue;
    }
    // Only close out a record whose entry this ledger actually holds. An EXIT for a position that
    // predates the toggle has no entry record, and inventing one would claim an entry order existed.
    if (!alreadySent(key)) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "entry_not_in_ledger" });
      continue;
    }
    if (alreadyExitSent(key)) continue;
    recordExitSent(key, {
      symbol: bareTicker(ev.symbol),
      tag: timeframeTag(ev.timeframe),
      side: exitOrderAction(ev.side),
      price: ev.exit_price === null || ev.exit_price === undefined ? "" : String(ev.exit_price),
      sent: false,
      source: "tv-alert",
    });
    out.recorded_exits.push({ symbol: bareTicker(ev.symbol), tag: timeframeTag(ev.timeframe) });
    console.log(`[webhook] ledger-only EXIT ${bareTicker(ev.symbol)} (${timeframeTag(ev.timeframe)}) — closed by TradingView alert`);
  }

  return out;
}

/**
 * Send the trade webhook for every eligible new OPEN signal whose timeframe is armed.
 *
 * Three independent gates have to pass, and each exists for its own reason:
 *   1. the caller passed `notify` (real scheduled scan only — see call site),
 *   2. the signal's timeframe is in `webhook.enabled_timeframes` (explicit per-timeframe opt-in),
 *   3. this exact ticker|tag|entryTime has not already been sent (survives restarts via the ledger).
 * Gate 3 is what makes re-scanning safe: the same OPEN position is re-detected on every scan for as
 * long as it stays open, so without it a 15-minute cadence would re-order the same entry all day.
 */
async function dispatchTradeWebhooks(events, rules) {
  const out = { sent: [], skipped: [], failed: [], armed: [] };
  if (!Array.isArray(events) || events.length === 0) return out;

  const settings = loadWebhookSettings(rules);
  out.armed = settings.enabledTimeframes;
  if (settings.enabledTimeframes.length === 0) return out;

  const creds = loadWebhookCredentials();
  if (!creds.configured) {
    console.error("[webhook] armed timeframes exist but URL/secret are not configured — nothing sent. Set TRADE_WEBHOOK_URL/TRADE_WEBHOOK_SECRET or fill webhook.local.json.");
    out.skipped.push({ reason: "not_configured", count: events.length });
    return out;
  }

  // Active templates, read ONCE per dispatch rather than per event: it is a small SQLite query, but
  // reading it per event would let the set change mid-batch and attribute two signals from the same
  // scan to different configurations. Failure is non-fatal — an unreadable templates table must cost
  // the attribution, never the order.
  let activeTemplates = [];
  try {
    activeTemplates = listTemplates({ status: "active" });
  } catch (err) {
    console.error(`[webhook] could not read sim templates, sending without attribution: ${err?.message || err}`);
  }

  for (const ev of events) {
    if (!settings.enabledTimeframes.includes(String(ev.timeframe))) continue;
    const key = sentKey({ symbol: ev.symbol, timeframe: ev.timeframe, entryTime: ev.entry_time });
    // A null key means the entry time is unknown; the notify gates should already have excluded it,
    // so treat it as a hard skip rather than sending something we cannot deduplicate later.
    if (!key) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "no_entry_time" });
      continue;
    }
    if (alreadySent(key)) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "already_sent" });
      continue;
    }

    // Exactly-one-match resolution: a timeframe claimed by two active templates attaches NOTHING
    // rather than picking one, because a wrong template id on a real order is worse than no id and
    // there is no basis to choose. The collision is surfaced in the Templates tab so this is a
    // visible stop rather than a silent one.
    const resolved = resolveTemplateForTimeframe(ev.timeframe, activeTemplates);
    if (resolved.ambiguous) {
      console.error(`[webhook] ${resolved.candidates.length} active templates claim timeframe ${ev.timeframe} (${resolved.candidates.map((t) => t.short_desc).join(", ")}) — sending ${ev.symbol} without template attribution`);
    }
    const payload = buildWebhookPayload({
      symbol: ev.symbol,
      side: ev.side,
      timeframe: ev.timeframe,
      price: ev.entry_price,
      group: settings.group,
      secret: creds.secret,
      template: templateStamp(resolved.template),
    });
    const res = await sendTradeWebhook({ url: creds.url, payload });
    if (res.success) {
      recordSent(key, {
        symbol: payload.symbol, tag: payload.tag, side: payload.side, price: payload.price, source: "auto",
        template_id: payload.template_id ?? null, template: payload.template ?? null,
      });
      out.sent.push({ symbol: payload.symbol, tag: payload.tag, side: payload.side });
      console.log(`[webhook] sent ${payload.side} ${payload.symbol} (${payload.tag}) @ ${payload.price}`);
    } else {
      // Deliberately NOT recorded as sent, so the next scan retries.
      out.failed.push({ symbol: payload.symbol, tag: payload.tag, error: res.error });
      console.error(`[webhook] FAILED ${payload.symbol} (${payload.tag}): ${res.error}`);
    }
  }
  return out;
}

/**
 * Send the trade webhook's closing order for every eligible EXIT whose matching entry was itself
 * sent via this webhook — never for a position this system doesn't know it opened at the executor,
 * even if the same symbol/timeframe genuinely closed today. That's a deliberate, narrower scope than
 * dispatchTradeWebhooks' entry side: sending a close order for a position Railway was never told
 * about could error out, or — worse, if the receiver doesn't validate — open an unintended opposite
 * position instead of closing anything.
 *
 * Gates, and note that "is the timeframe armed" is deliberately NOT one of them:
 *   1. notify (real scheduled scan only),
 *   2. an ENTRY for this exact ticker|tag|entryTime is in the ledger — i.e. we opened it,
 *   3. that entry was placed by US, not by a TradingView alert (`source: "tv-alert"`), which sends
 *      its own close,
 *   4. !alreadyExitSent(key) — this exit hasn't already gone out.
 *
 * **Arming gates opening, not closing** (changed 2026-07-31 after a real position hit this). It used
 * to require `webhook.enabled_timeframes` to contain the timeframe, which meant a position entered
 * with the MANUAL Send button — explicitly supported on any timeframe, armed or not — could never be
 * closed automatically. Live case: an AME 1H entry sent manually on 2026-07-29 flipped short on
 * 07-31 and no close order went out, because nothing was armed and this function returned at the
 * first line. That leaves a real position open at the broker with the system that opened it
 * declining to close it, which is strictly worse than the risk arming is there to control: arming
 * decides whether new capital gets committed without a human, while closing only ever unwinds a
 * position a human already committed to. The ledger record is the authorization.
 *
 * Side is inverted from the position's entry side via exitOrderAction (closing a LONG is a sell,
 * closing a SHORT is a buy) — passed as buildWebhookPayload's `action` override so it isn't re-run
 * through the entry-side mapping a second time.
 */
async function dispatchExitWebhooks(events, rules) {
  const out = { sent: [], skipped: [], failed: [], armed: [] };
  if (!Array.isArray(events) || events.length === 0) return out;

  const settings = loadWebhookSettings(rules);
  out.armed = settings.enabledTimeframes;

  const creds = loadWebhookCredentials();
  if (!creds.configured) {
    out.skipped.push({ reason: "not_configured", count: events.length });
    return out;
  }

  for (const ev of events) {
    // Keyed on entry_time, not exit_time — this must match the exact key the opening webhook (if
    // any) was recorded under, since that record's existence is the gate below.
    const key = sentKey({ symbol: ev.symbol, timeframe: ev.timeframe, entryTime: ev.entry_time });
    if (!key) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "no_entry_time" });
      continue;
    }
    const entryRecord = getSentRecord(key);
    if (!entryRecord) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "entry_not_sent_by_us" });
      continue;
    }
    // Checked on the RECORD, not the current tv_alert_timeframes config: the config can change after
    // a position is opened, and what matters is who actually placed this entry.
    if (entryRecord.source === "tv-alert") {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "entry_placed_by_tv_alert" });
      continue;
    }
    if (alreadyExitSent(key)) {
      out.skipped.push({ symbol: ev.symbol, timeframe: ev.timeframe, reason: "already_sent" });
      continue;
    }

    // Template read off the ENTRY record, never re-resolved from the current template set — the same
    // rule the manual close follows. Re-resolving would let a template edited or archived since the
    // entry attribute the close to a different configuration than the position was opened under.
    const payload = buildWebhookPayload({
      symbol: ev.symbol,
      action: exitOrderAction(ev.side),
      timeframe: ev.timeframe,
      price: ev.exit_price,
      group: settings.group,
      secret: creds.secret,
      template: entryRecord.template_id
        ? { template_id: entryRecord.template_id, template: entryRecord.template }
        : null,
    });
    const res = await sendTradeWebhook({ url: creds.url, payload });
    if (res.success) {
      recordExitSent(key, {
        symbol: payload.symbol, tag: payload.tag, side: payload.side, price: payload.price, source: "auto-exit",
        template_id: payload.template_id ?? null, template: payload.template ?? null,
      });
      out.sent.push({ symbol: payload.symbol, tag: payload.tag, side: payload.side });
      console.log(`[webhook] sent EXIT ${payload.side} ${payload.symbol} (${payload.tag}) @ ${payload.price}`);
    } else {
      // Deliberately NOT recorded as sent, so the next scan retries.
      out.failed.push({ symbol: payload.symbol, tag: payload.tag, error: res.error });
      console.error(`[webhook] EXIT FAILED ${payload.symbol} (${payload.tag}): ${res.error}`);
    }
  }
  return out;
}

export async function exportMetricsScan({ onProgress, baselinePath, scanTargets } = {}) {
  const { rules } = loadRules();
  const { watchlist: fallbackSymbols = [], default_timeframe = '240', watchlists = {} } = rules;
  const requestedTargets = Array.isArray(scanTargets) && scanTargets.length > 0
    ? scanTargets
    : buildScanTargets({ watchlist: fallbackSymbols, default_timeframe, watchlists });
  const resolvedBaselinePath = baselinePath || DEFAULT_BASELINE_PATH;
  const baseline = loadBaseline(resolvedBaselinePath);

  let currentState;
  try {
    currentState = await chart.getState();
  } catch (error) {
    const err = new Error(`TradingView connection unavailable. ${error?.message || String(error)}`);
    err.code = 'TV_CONNECTION_UNAVAILABLE';
    throw err;
  }

  const originalSymbol = currentState.symbol;
  const originalTimeframe = currentState.resolution;

  const allTasks = [];
  for (const target of requestedTargets) {
    const targetTimeframe = String(target.timeframe || default_timeframe);
    const stored = target.watchlistName ? baseline.watchlists?.[target.watchlistName] : undefined;
    const symbols = Array.isArray(target.symbols) && target.symbols.length > 0
      ? target.symbols
      : typeof target.symbols === 'string' && target.symbols.trim()
        ? [target.symbols.trim()]
        : Array.isArray(stored?.symbols) && stored.symbols.length > 0
          ? stored.symbols
          : fallbackSymbols;
    for (const symbol of symbols) {
      allTasks.push({
        watchlistName: target.watchlistName || 'Custom',
        timeframe: targetTimeframe,
        symbol,
      });
    }
  }

  const total = allTasks.length;
  const results = [];

  try {
    let done = 0;
    for (const { watchlistName, timeframe, symbol } of allTasks) {
      onProgress?.({ watchlistName, symbol, done, total });

      try {
        await chart.setSymbol({ symbol, wait_timeout: 1500 });
        await sleep(200);
        await chart.setTimeframe({ timeframe, wait_timeout: 1500 });
        await sleep(500);

        const metricsResult = await data.getStrategyMetricsFromDOM({ timeout_ms: 16000 });
        results.push({
          watchlistName,
          timeframe,
          symbol,
          success: metricsResult.success,
          metrics: metricsResult.metrics || null,
          error: metricsResult.error || null,
        });
      } catch (err) {
        results.push({
          watchlistName,
          timeframe,
          symbol,
          success: false,
          metrics: null,
          error: err.message,
        });
      }

      done++;
      onProgress?.({ watchlistName, symbol, done, total });
    }
  } finally {
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
      } catch (_) {}
    }
  }

  return results;
}

export function saveSession({ brief, date } = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? readJsonFile(filePath)
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...readJsonFile(filePath) };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...readJsonFile(yesterdayPath),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
