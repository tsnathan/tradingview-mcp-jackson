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
    return JSON.parse(readFileSync(filePath, "utf8"));
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
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
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
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) {
    return formatDateString(year, month, day - 1);
  }
  if (weekday === 0) {
    return formatDateString(year, month, day + 1);
  }
  return formatDateString(year, month, day);
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
  const watchlistEntries = Object.entries(rules.watchlists || {});
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
    && lowered !== 'unavailable'
    && lowered !== 'in progress';
}

function parseEntryTimestamp(value) {
  const cleaned = String(value || '')
    .replace(/\s+ET$/i, '')
    .trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const input = Date.parse(String(value || ''));
  const ref = Date.parse(String(reference || ''));
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
  const input = Date.parse(String(value || ''));
  const ref = Date.parse(String(reference || ''));
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

function isScheduledRunMinute(date, marketHours = DEFAULT_MARKET_HOURS) {
  return isTimeframeDueNow('15', date, marketHours);
}

function getNextScheduledRunLabel(from = new Date(), marketHours = DEFAULT_MARKET_HOURS) {
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  let candidate = new Date(new Date(from).getTime() + 60 * 1000);

  for (let i = 0; i < 60 * 24 * 7; i += 1) {
    if (isScheduledRunMinute(candidate, marketHours)) {
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
            entryPrice: normalizeTradeDisplay(tradeBackedEntry.trade.entryPrice),
            entryTime: formatEntryTimeDisplay(tradeBackedEntry.trade.entryTime, timezone),
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
            entryTime: formatEntryTimeDisplay(signalBackedEntry.scanned_at || baselineUpdatedAt || new Date().toISOString(), timezone),
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
            netPnl: 'Unavailable',
            favorableExcursion: 'Unavailable',
            adverseExcursion: 'Unavailable',
            wasOpen: false,
          };
        }

        const latestEntryTime = latest.entry_time || latest.last_seen_at || baselineUpdatedAt;
        const latestSignal = normalizeTradeDisplay(latest.signal_type || 'EXIT').toUpperCase();
        const keepOpenVisible = latestSignal === 'OPEN'
          && isSameOrPreviousTradingDay(latestEntryTime, baselineUpdatedAt || new Date().toISOString(), timezone);
        const resolvedSignal = keepOpenVisible ? 'OPEN' : (latestSignal === 'OPEN' ? 'EXIT' : latestSignal);
        const row = {
          symbol: latest.symbol || symbol,
          signal: resolvedSignal,
          wasOpen: latestSignal === 'OPEN',
          entryPrice: normalizeTradeDisplay(latest.entry_price ?? latest.last_price ?? 'n/a'),
          entryTime: formatEntryTimeDisplay(latest.entry_time || latest.last_seen_at || baselineUpdatedAt, timezone),
          netPnl: fillTradeMetric(latest.net_pnl, resolvedSignal),
          favorableExcursion: fillTradeMetric(latest.favorable_excursion, resolvedSignal),
          adverseExcursion: fillTradeMetric(latest.adverse_excursion, resolvedSignal),
        };

        return isRenderablePriorRow(row) ? row : {
          symbol: latest.symbol || symbol,
          signal: '—',
          entryPrice: hasMeaningfulTradeValue(latest.entry_price ?? latest.last_price) ? normalizeTradeDisplay(latest.entry_price ?? latest.last_price) : 'Unavailable',
          entryTime: hasMeaningfulTradeValue(latest.entry_time || latest.last_seen_at) ? formatEntryTimeDisplay(latest.entry_time || latest.last_seen_at || baselineUpdatedAt, timezone) : 'No prior trade recorded',
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

function buildWatchlistSummaryLines(
  watchlistSummaries = [],
  results = [],
  priorSignalsByWatchlist = [],
  timezone = DEFAULT_MARKET_HOURS.timezone,
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

    if (summary.skipped_due_schedule) {
      return `${prefix} | WAITING FOR NEXT ${timeframe || 'WATCHLIST'} BAR`;
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

    const fallbackOpenTrades = (Array.isArray(priorSection?.trades) ? priorSection.trades : [])
      .filter((row) => String(row.signal || '').toUpperCase() === 'OPEN')
      .filter((row) => isRecentTradeSignal(row.entryTime, scanTimestamp, timeframe)
        || isSameTradingDay(row.entryTime, scanTimestamp, timezone))
      .sort((a, b) => parseEntryTimestamp(b.entryTime) - parseEntryTimestamp(a.entryTime));

    const rowsToShow = recentOpenTrades.length > 0
      ? recentOpenTrades.map((entry) => ({
          symbol: entry.state?.symbol || entry.symbol || 'n/a',
          entryPrice: normalizeTradeDisplay(entry.trade?.entryPrice),
          entryTime: normalizeTradeDisplay(entry.trade?.entryTime),
        }))
      : fallbackOpenTrades;

    if (rowsToShow.length > 0) {
      const details = rowsToShow
        .map((row) => `  OPEN: ${row.symbol || 'n/a'} | ENTRY: ${normalizeTradeDisplay(row.entryPrice)} | AT: ${normalizeTradeDisplay(row.entryTime)}`)
        .join('\n');
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
        entryPrice: normalizeTradeDisplay(entry.trade?.entryPrice ?? entry.signal?.price ?? entry.quote?.last),
        entryTime: entry.trade?.entryTime || entry.scanned_at,
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
      entryPrice: normalizeTradeDisplay(row?.entryPrice ?? row?.entry_price),
      entryTime: formatEntryTimeDisplay(entryTime, timezone),
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
    addRow(matchingSection, {
      symbol,
      timeframe,
      signal: 'OPEN',
      entryPrice: entry?.entry_price,
      entryTime: entry?.entry_time || entry?.last_seen_at,
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
    /SIGNAL:\s*(OPEN|EXIT)\b/i.test(line) || /OPEN:\s*\w/i.test(line),
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
    openTrades: Array.isArray(result.open_trades) ? result.open_trades : [],
    priorSignals,
    isPartialScan: Boolean(result.is_partial_scan),
    scanProgress: result.scan_progress || null,
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

  const latestTrade = await data.getLatestTradeFromTester({ timeout_ms: 14000 }).catch(() => ({ success: false, trade: null }));

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
        const pSumLines = buildWatchlistSummaryLines(watchlistSummaries, results, pPrior, timezone);
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

  const signalEntries = results.filter((entry) => {
    const hasOpenTrade = String(entry.trade?.signal || '').toUpperCase() === 'OPEN'
      && isRecentTradeSignal(entry.trade?.entryTime, entry.scanned_at, entry.timeframe);
    if (hasOpenTrade) return true;

    const key = `${entry.state?.symbol || entry.symbol}:${entry.timeframe}`;
    const previous = baseline.signals[key] || {};
    return Boolean(entry.signal?.hasSignal) && hasSignalChanged(previous, entry.signal);
  });
  const changedSignals = signalEntries.filter((entry) => {
    const key = `${entry.state?.symbol || entry.symbol}:${entry.timeframe}`;
    const previous = baseline.signals[key] || {};
    if (String(entry.trade?.signal || '').toUpperCase() === 'OPEN') {
      return String(previous.signal_type || '').toUpperCase() !== 'OPEN'
        || normalizeTradeDisplay(previous.entry_time, '') !== normalizeTradeDisplay(entry.trade?.entryTime, '')
        || normalizeTradeDisplay(previous.entry_price, '') !== normalizeTradeDisplay(entry.trade?.entryPrice, '');
    }
    return hasSignalChanged(previous, entry.signal);
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
    createExcursionAlerts(openTrades, baselinePath),
    new Promise((resolve) => setTimeout(() => resolve(null), 4 * 60 * 1000)),
  ])
    .then((result) => result ?? enrichOpenTradesFromBaseline(openTrades, displayBaseline.excursion_alerts))
    .catch(() => enrichOpenTradesFromBaseline(openTrades, displayBaseline.excursion_alerts));
  const watchlistSummaryLines = buildWatchlistSummaryLines(
    watchlistSummaries,
    results,
    priorSignalsByWatchlist,
    timezone,
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

// Parse numeric entry price from strings like "159.53 USD" or "159.53".
function parseEntryPriceNum(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// For each open trade that does not yet have excursion alerts in the baseline:
//   1. Switch to that symbol + timeframe
//   2. Read all historical trades to compute avg/max excursion stats
//   3. Create 4 TradingView price alerts (avg stop, max stop, avg target, max target)
//   4. Mark as done in the baseline so subsequent scans skip this block
//
// Returns openTrades array augmented with excursionStats and alertLevels fields.
export async function createExcursionAlerts(openTrades, baselinePath) {
  if (!Array.isArray(openTrades) || openTrades.length === 0) return openTrades;

  const baseline = loadBaseline(baselinePath);
  const enriched = [];

  // Check current active alert count once upfront so we can gate each batch.
  const MAX_ALERTS = 20;
  let usedSlots = 0;
  try {
    const alertList = await alerts.list();
    usedSlots = (alertList.alerts || []).filter(a => a.active).length;
  } catch {}

  for (const trade of openTrades) {
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

      const round2 = n => Math.round(n * 100) / 100;
      levels = {
        stopAvg:    round2(entryNum * (1 - stats.avgAdversePct   / 100)),
        stopMax:    round2(entryNum * (1 - stats.maxAdversePct   / 100)),
        targetAvg:  round2(entryNum * (1 + stats.avgFavorablePct / 100)),
        targetMax:  round2(entryNum * (1 + stats.maxFavorablePct / 100)),
      };
    }

    if (!stats || !entryNum || !levels) {
      enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: false });
      continue;
    }

    const sym = symbol.replace(/^[^:]+:/, '');
    const tf  = timeframe === 'D' ? '1D' : timeframe === 'W' ? '1W' : `${timeframe}m`;
    const alertDefs = [
      { price: levels.stopAvg,   msg: `${sym} ${tf} | Stop avg MAE ${stats.avgAdversePct}% | Entry ${entryNum}` },
      { price: levels.stopMax,   msg: `${sym} ${tf} | Stop max MAE ${stats.maxAdversePct}% | Entry ${entryNum}` },
      { price: levels.targetAvg, msg: `${sym} ${tf} | Target avg MFE ${stats.avgFavorablePct}% | Entry ${entryNum}` },
      { price: levels.targetMax, msg: `${sym} ${tf} | Target max MFE ${stats.maxFavorablePct}% | Entry ${entryNum}` },
    ];

    // Respect alert quota — save levels to baseline so the dashboard can show
    // them even when alerts cannot be created yet.
    if (usedSlots + alertDefs.length > MAX_ALERTS) {
      const skipReason = `Quota full (${usedSlots}/${MAX_ALERTS} active)`;
      const raw = parseJsonFile(baselinePath, {});
      if (!raw.excursion_alerts) raw.excursion_alerts = {};
      raw.excursion_alerts[key] = { created: false, created_at: new Date().toISOString(), entry_price: entryNum, stats, levels, skip_reason: skipReason };
      writeJsonFile(baselinePath, raw);
      enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: false, alertsSkipReason: skipReason });
      continue;
    }

    let allCreated = true;
    for (const def of alertDefs) {
      try {
        const r = await alerts.create({ price: def.price, message: def.msg, symbol, timeframe });
        if (!r?.success) allCreated = false;
        await new Promise(res => setTimeout(res, 800));
      } catch {
        allCreated = false;
      }
    }

    if (allCreated) usedSlots += alertDefs.length;

    const raw = parseJsonFile(baselinePath, {});
    if (!raw.excursion_alerts) raw.excursion_alerts = {};
    raw.excursion_alerts[key] = { created: allCreated, created_at: new Date().toISOString(), entry_price: entryNum, stats, levels };
    writeJsonFile(baselinePath, raw);

    enriched.push({ ...trade, excursionStats: stats, alertLevels: levels, alertsCreated: allCreated });
  }

  return enriched;
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

  const syncResult = syncWatchlists
    ? await syncWatchlistSymbolsFromTradingView({ rules, baselinePath }).catch(() => null)
    : null;
  if (syncResult?.watchlists) {
    baseline.watchlists = syncResult.watchlists;
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

  result.watchlist_sync = Array.isArray(syncResult?.synced) ? syncResult.synced : [];
  result.watchlistOptions = Array.isArray(syncResult?.watchlistOptions) ? syncResult.watchlistOptions : [];
  result.activeWatchlistName = syncResult?.activeWatchlistName || null;

  if (notify && result.notify_signal_lines.length > 0 && rules.ntfy?.url) {
    try {
      const ntfyResponse = await fetch(rules.ntfy.url, {
        method: "POST",
        body: result.notify_signal_lines.join("\n"),
        headers: {
          "Content-Type": "text/plain",
          Title: "TradingView signal scan",
          Priority: String(rules.ntfy.priority || "default"),
        },
      });
      if (!ntfyResponse.ok) {
        console.error(`ntfy push failed: HTTP ${ntfyResponse.status} ${ntfyResponse.statusText}`);
      }
    } catch (err) {
      console.error(`ntfy push failed: ${err?.message || String(err)}`);
    }
  }

  writeLatestStatus(result);
  return result;
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
    ? JSON.parse(readFileSync(filePath, "utf8"))
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
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
