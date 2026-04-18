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
  for (const candidate of candidates) {
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
    lastSignal || {
      hasSignal: false,
      direction: null,
      price: null,
      source: null,
      study: null,
      text: null,
      labelCount,
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
  };
}

function updateBaselineEntry(signalMap, entry) {
  const key = `${entry.state?.symbol || entry.symbol}:${entry.timeframe}`;
  const previous = signalMap[key] || {};
  const hasSignal = Boolean(entry.signal?.hasSignal);
  const tradeSignal = normalizeTradeDisplay(entry.trade?.signal, '').toUpperCase();
  const hasTradeState = tradeSignal === 'OPEN' || tradeSignal === 'EXIT';
  const scannedAt = entry.scanned_at || new Date().toISOString();
  const entryPrice = normalizeTradeDisplay(
    entry.trade?.entryPrice ?? entry.signal?.price ?? entry.quote?.last ?? null,
    null,
  );
  const syntheticOpen = hasSignal && !hasTradeState && (
    hasSignalChanged(previous, entry.signal)
    || String(previous.signal_type || '').toUpperCase() === 'OPEN'
  );

  const nextSignalType = hasTradeState ? tradeSignal : syntheticOpen ? 'OPEN' : 'EXIT';

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
    entry_time: normalizeTradeDisplay(entry.trade?.entryTime, '') || ((hasSignal || syntheticOpen) ? scannedAt : previous.entry_time || previous.last_seen_at || null),
    entry_price: entryPrice ?? previous.entry_price ?? previous.last_price ?? entry.quote?.last ?? null,
    net_pnl: hasTradeState ? normalizeTradeDisplay(entry.trade?.netPnl) : syntheticOpen ? 'In progress' : previous.net_pnl ?? '—',
    favorable_excursion: hasTradeState ? normalizeTradeDisplay(entry.trade?.favorableExcursion) : syntheticOpen ? 'In progress' : previous.favorable_excursion ?? '—',
    adverse_excursion: hasTradeState ? normalizeTradeDisplay(entry.trade?.adverseExcursion) : syntheticOpen ? 'In progress' : previous.adverse_excursion ?? '—',
  };
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
    && lowered !== 'unavailable';
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

function isRecentTradeSignal(entryTime, scannedAt, timeframe, maxBars = 4) {
  const entryTs = parseEntryTimestamp(entryTime);
  const scanTs = parseEntryTimestamp(scannedAt || new Date().toISOString());
  const tfMinutes = timeframeToMinutes(timeframe);
  if (!entryTs || !scanTs || !tfMinutes) return false;
  const maxAgeMs = tfMinutes * maxBars * 60 * 1000 + 60 * 1000;
  return scanTs >= entryTs && (scanTs - entryTs) <= maxAgeMs;
}

function isScheduledRunMinute(date, marketHours = DEFAULT_MARKET_HOURS) {
  if (!shouldRunEquityScanNow(date, marketHours)) return false;
  const timezone = marketHours?.timezone || DEFAULT_MARKET_HOURS.timezone;
  const current = toTimeParts(date, timezone);
  const currentMinutes = current.hour * 60 + current.minute;
  const openMinutes = timeToMinutes(marketHours?.open || DEFAULT_MARKET_HOURS.open) + 1;
  return (currentMinutes - openMinutes) % 15 === 0;
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
          && isSameTradingDay(latestEntryTime, baselineUpdatedAt || new Date().toISOString(), timezone);
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
    const prefix = `${formatTimestamp(Date.now(), timezone)} ET | WATCHLIST: ${watchlistName} | SYMBOLS: ${displayedCount} | SCAN: ${formatDuration(summary.scan_duration_ms)}`;

    const recentOpenTrades = results
      .filter((entry) => entry.watchlist_name === watchlistName && !entry.error)
      .filter((entry) => String(entry.trade?.signal || '').toUpperCase() === 'OPEN')
      .filter((entry) => isRecentTradeSignal(entry.trade?.entryTime, entry.scanned_at, entry.timeframe))
      .sort(
        (a, b) => parseEntryTimestamp(b.trade?.entryTime) - parseEntryTimestamp(a.trade?.entryTime)
          || new Date(b.scanned_at || 0).getTime() - new Date(a.scanned_at || 0).getTime(),
      );

    const fallbackOpenTrades = (Array.isArray(priorSection?.trades) ? priorSection.trades : [])
      .filter((row) => String(row.signal || '').toUpperCase() === 'OPEN')
      .filter((row) => isRecentTradeSignal(row.entryTime, new Date().toISOString(), timeframe))
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
) {
  const rowsByKey = new Map();

  const addRow = (section, row) => {
    const signal = String(row?.signal || '—').toUpperCase();
    const symbol = row?.symbol || 'n/a';
    const entryTime = row?.entryTime || row?.entry_time || 'No prior trade recorded';
    if (signal !== 'OPEN') return;
    if (!hasMeaningfulTradeValue(entryTime) || !isSameTradingDay(entryTime, asOf, timezone)) return;

    const key = `${section?.watchlistName || section?.watchlist_name || 'Watchlist'}|${section?.timeframe || ''}|${normalizeSymbolForMatch(symbol)}`;
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

  for (const section of priorSignalsByWatchlist) {
    for (const row of (Array.isArray(section.trades) ? section.trades : [])) {
      addRow(section, row);
    }
  }

  for (const entry of Object.values(baselineSignals || {})) {
    const signalType = String(entry?.signal_type || '').toUpperCase();
    if (signalType !== 'OPEN') continue;

    const timeframe = String(entry?.timeframe || '');
    const symbol = entry?.symbol || 'n/a';
    const matchingSection = priorSignalsByWatchlist.find((section) => {
      if (String(section?.timeframe || '') !== timeframe) return false;
      const trades = Array.isArray(section?.trades) ? section.trades : [];
      return trades.some((row) => normalizeSymbolForMatch(row.symbol) === normalizeSymbolForMatch(symbol));
    }) || priorSignalsByWatchlist.find((section) => String(section?.timeframe || '') === timeframe) || {
      watchlistName: `Watchlist ${timeframe}`,
      timeframe,
      symbolCount: 0,
    };

    addRow(matchingSection, {
      symbol,
      timeframe,
      signal: 'OPEN',
      entryPrice: entry?.entry_price,
      entryTime: entry?.entry_time || entry?.last_seen_at,
      netPnl: entry?.net_pnl,
      favorableExcursion: entry?.favorable_excursion,
      adverseExcursion: entry?.adverse_excursion,
    });
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

function formatSignalLine(entry, timezone = DEFAULT_MARKET_HOURS.timezone) {
  const symbol = entry.state?.symbol || entry.symbol;
  const direction = entry.signal?.direction === "bullish" ? "LONG" : "SHORT";
  const price = entry.signal?.price ?? entry.quote?.last ?? "n/a";
  const note = entry.signal?.text || "Signal detected";
  const watchlistName = entry.watchlist_name || "Default";
  const symbolCount = entry.watchlist_symbol_count ?? "n/a";
  const stamp = formatTimestamp(entry.scanned_at || Date.now(), timezone);
  return `${stamp} ET | WATCHLIST: ${watchlistName} | SYMBOLS: ${symbolCount} | ${symbol} | SIGNAL: ${direction} | TF: ${entry.timeframe} | PRICE: ${price} | ${note}`;
}

export function createDashboardStatus(result = {}) {
  const lines = Array.isArray(result.watchlist_summary_lines) && result.watchlist_summary_lines.length > 0
    ? result.watchlist_summary_lines
    : Array.isArray(result.signal_lines) && result.signal_lines.length > 0
      ? result.signal_lines
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
    watchlistsChecked: Array.isArray(result.watchlists_checked) ? result.watchlists_checked : [],
    openTrades: Array.isArray(result.open_trades) ? result.open_trades : [],
    priorSignals,
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

  const latestTrade = await data.getLatestTradeFromTester({ timeout_ms: 8000 }).catch(() => ({ success: false, trade: null }));

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
} = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const { watchlist = [], default_timeframe = "240", watchlists = {} } = rules;
  const scanTargets = buildScanTargets({ watchlist, default_timeframe, watchlists });
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

  try {
    for (const target of scanTargets) {
      const startedAt = Date.now();
      const resolved = await resolveSymbolsForWatchlist(target, watchlist, {
        allowFallback: true,
        baselineWatchlists: baseline.watchlists,
        baselineSignals: baseline.signals,
      });
      const normalizedExpected = new Set(
        resolved.symbols.map((symbol) => String(symbol).split(':').pop()?.toUpperCase() || String(symbol).toUpperCase()),
      );

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
      });
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
      if (summary.source === 'tradingview_panel' && Array.isArray(summary.symbols) && summary.symbols.length > 0) {
        nextBaseline.watchlists[summary.watchlist_name] = {
          timeframe: summary.timeframe,
          symbols: summary.symbols,
          symbol_count: summary.symbol_count,
          updated_at: nextBaseline.last_updated,
        };
      }
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
  const timezone = (rules.market_hours || baseline.market_hours || DEFAULT_MARKET_HOURS).timezone || DEFAULT_MARKET_HOURS.timezone;
  const signalLines = signalEntries.map((entry) => {
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
  const openTrades = buildOpenTrades(priorSignalsByWatchlist, displayBaseline.signals, generatedAt, timezone);
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
    symbols_scanned: outputEntries,
    watchlists_checked: scanTargets.map((target) => target.watchlistName),
    watchlist_scan_summaries: watchlistSummaries,
    prior_signals_by_watchlist: priorSignalsByWatchlist,
    open_trades: openTrades,
    total_scan_count: results.length,
    signals_found: signalEntries.length,
    changed_signals: changedSignals.length,
    signal_lines: signalLines,
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

export async function runSignalJob({
  rules_path,
  changed_only = true,
  notify = false,
  force = false,
} = {}) {
  const { rules } = loadRules(rules_path);
  const baselinePath = resolve(rules.baseline_file || DEFAULT_BASELINE_PATH);
  const baseline = loadBaseline(baselinePath);
  const marketHours = rules.market_hours || baseline.market_hours || DEFAULT_MARKET_HOURS;
  const { watchlist = [], default_timeframe = '240', watchlists = {} } = rules;
  const scanTargets = buildScanTargets({ watchlist, default_timeframe, watchlists });
  const studyFilter = String(rules.strategy || 'Swing Profile').split('—')[0].trim();

  try {
    await ensureTradingViewConnection();
  } catch (error) {
    const errorResult = buildConnectionErrorResult({
      marketHours,
      scanTargets,
      baseline,
      reason: `TradingView connection unavailable. ${error?.message || String(error)}`,
    });
    writeLatestStatus(errorResult);
    return errorResult;
  }

  if (!force && !shouldRunEquityScanNow(new Date(), marketHours)) {
    const timezone = marketHours.timezone || DEFAULT_MARKET_HOURS.timezone;
    const skippedWatchlistSummaries = [];
    const skippedResults = [];
    for (const target of scanTargets) {
      const resolved = await resolveSymbolsForWatchlist(target, watchlist, {
        allowFallback: true,
        baselineWatchlists: baseline.watchlists,
        baselineSignals: baseline.signals,
      });
      skippedWatchlistSummaries.push({
        watchlist_name: target.watchlistName,
        timeframe: target.timeframe,
        symbol_count: resolved.count,
        symbols: resolved.symbols,
        source: resolved.source,
      });

      for (const symbol of resolved.symbols) {
        try {
          skippedResults.push(
            await scanSymbol({
              symbol,
              timeframe: target.timeframe,
              studyFilter,
              watchlistName: target.watchlistName,
              watchlistSymbolCount: resolved.count,
            }),
          );
        } catch {}
      }
    }

    const priorSignalsByWatchlist = buildPriorSignalsByWatchlist(
      skippedWatchlistSummaries,
      skippedResults,
      baseline.signals,
      timezone,
      baseline.last_updated,
      baseline.watchlists,
    );
    const skippedResult = {
      success: true,
      skipped: true,
      reason: "Outside market hours",
      signal_lines: [],
      watchlist_summary_lines: skippedWatchlistSummaries.map(
        (target) => `${formatTimestamp(new Date(), timezone)} ET | WATCHLIST: ${target.watchlist_name} | SYMBOLS: ${target.symbol_count} | SCAN: ${formatDuration(target.scan_duration_ms)} | NO SIGNAL | Outside market hours`,
      ),
      summary_line: `${formatTimestamp(new Date(), timezone)} ET | NO SIGNAL | Outside market hours`,
      generated_at: new Date().toISOString(),
      formatted_timestamp_et: formatTimestamp(new Date(), timezone),
      next_scheduled_run_et: getNextScheduledRunLabel(new Date(), marketHours),
      market_hours: marketHours,
      signals_found: 0,
      changed_signals: 0,
      symbols_scanned: [],
      open_trades: buildOpenTrades(priorSignalsByWatchlist, baseline.signals || {}, new Date().toISOString(), timezone),
      scan_mode: "signals_only",
      watchlists_checked: scanTargets.map((target) => target.watchlistName),
      prior_signals_by_watchlist: priorSignalsByWatchlist,
    };
    writeLatestStatus(skippedResult);
    return skippedResult;
  }

  const result = await runBrief({
    rules_path,
    signals_only: true,
    changed_only,
    update_baseline: true,
  });

  if (notify && result.signal_lines.length > 0 && rules.ntfy?.url) {
    await fetch(rules.ntfy.url, {
      method: "POST",
      body: result.signal_lines.join("\n"),
      headers: {
        Title: "TradingView signal scan",
        Priority: String(rules.ntfy.priority || "default"),
      },
    }).catch(() => null);
  }

  writeLatestStatus(result);
  return result;
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
