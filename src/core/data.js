/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS } from '../connection.js';
import * as ui from './ui.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function combineUsdValue(lines, usdIndex) {
  if (usdIndex <= 0 || !lines[usdIndex - 1]) return '—';
  const value = `${lines[usdIndex - 1]} USD`;
  const pct = lines[usdIndex + 1] && /[%％]$/.test(lines[usdIndex + 1]) ? ` | ${lines[usdIndex + 1]}` : '';
  return value + pct;
}

export function parseLatestTradeFromTesterText(text) {
  const normalized = String(text || '')
    .replace(/\u202f/g, ' ')
    .replace(/−/g, '-')
    .replace(/−/g, '-')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!normalized.includes('Trade #')) return null;

  const body = normalized.slice(normalized.indexOf('Trade #') + 'Trade #'.length).trim();
  const blocks = body
    .split(/\n(?=\d+(?:Long|Short))/)
    .map(block => block.trim())
    .filter(block => /^\d+(?:Long|Short)/.test(block));

  if (blocks.length === 0) return null;

  const latestBlock = blocks[blocks.length - 1];
  const lines = latestBlock.split('\n').map(line => line.trim()).filter(Boolean);
  const usdIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'USD') usdIndexes.push(i);
  }

  const dateLines = lines.filter(line => /^[A-Z][a-z]{2} \d{1,2}, \d{4}(?:, \d{1,2}:\d{2})?$/.test(line));
  const firstLine = lines[0] || '';
  const tradeNumberMatch = firstLine.match(/^(\d+)/);
  const sideMatch = firstLine.match(/(Long|Short)$/);
  const hasTwoDates = dateLines.length >= 2;
  // On daily charts TradingView shows two dates even for open positions (mark date + entry date).
  // The exit Signal column literally reads "Open" when the position is still active.
  const hasOpenExitSignal = lines.some(line => line === 'Open');
  const isOpenTrade = !hasTwoDates || hasOpenExitSignal;
  // When two dates are present, the exit/mark date appears first and entry appears second.
  const entryUsdIndex = hasTwoDates
    ? (usdIndexes[1] ?? usdIndexes[0] ?? -1)
    : (usdIndexes[0] ?? -1);
  const pnlStartIndex = hasTwoDates ? 2 : 1;

  return {
    tradeNumber: tradeNumberMatch ? Number(tradeNumberMatch[1]) : null,
    side: sideMatch ? sideMatch[1].toUpperCase() : null,
    signal: isOpenTrade ? 'OPEN' : 'EXIT',
    entryTime: hasTwoDates ? (dateLines[1] || dateLines[0] || '—') : (dateLines[0] || '—'),
    entryPrice: entryUsdIndex >= 0 ? combineUsdValue(lines, entryUsdIndex).replace(/ \|.*$/, '') : '—',
    netPnl: usdIndexes.length >= (pnlStartIndex + 1) ? combineUsdValue(lines, usdIndexes[pnlStartIndex]) : '—',
    favorableExcursion: usdIndexes.length >= (pnlStartIndex + 2) ? combineUsdValue(lines, usdIndexes[pnlStartIndex + 1]) : '—',
    adverseExcursion: usdIndexes.length >= (pnlStartIndex + 3) ? combineUsdValue(lines, usdIndexes[pnlStartIndex + 2]) : '—',
    rawText: latestBlock,
  };
}

// Reads the Strategy Tester's underlying report object directly off the chart's internal
// JS model (strat.reportData()) instead of scraping the rendered "List of Trades" panel.
// This is the same object the DOM table is built from, so it reflects the true state
// immediately — no virtualized-list scrolling, no text parsing, no stability-polling.
async function readStrategyReportData(study_filter) {
  return evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var filterLower = ${JSON.stringify(String(study_filter || '').toLowerCase())};
        var candidates = [];
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var meta = null;
          try { meta = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
          var name = meta ? (meta.description || meta.shortDescription || meta.fullDescription || '') : '';
          // Name match is the reliable signal — reportData/performance/ordersData methods exist
          // on the generic Study base class too (e.g. "Dividends", "Splits"), not just strategies.
          if (/strategy/i.test(name)) candidates.push({ source: s, name: name });
        }
        if (candidates.length === 0) return { error: 'no_strategy_on_chart', attachedNames: [] };
        var matched = filterLower ? candidates.filter(function(c) { return c.name.toLowerCase().indexOf(filterLower) !== -1; }) : candidates;
        var chosen = matched.length > 0 ? matched[0] : candidates[0];
        var strat = chosen.source;
        var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
        if (rd && typeof rd.value === 'function') rd = rd.value();
        var attachedNames = candidates.map(function(c) { return c.name; });
        if (!rd || !rd.performance) {
          return { error: 'report_unavailable', studyName: chosen.name, matchedFilter: matched.length > 0, attachedNames: attachedNames };
        }

        var perf = rd.performance;
        var totalOpenTrades = (perf.all && typeof perf.all.totalOpenTrades === 'number') ? perf.all.totalOpenTrades : 0;
        var trades = Array.isArray(rd.trades) ? rd.trades : [];
        // When a position is open, TradingView appends it to trades[] as the LAST element,
        // with a real entry timestamp (e.tm, epoch ms) and a synthesized mark-to-market exit
        // row — the same row the Strategy Tester UI renders as Exit "Open". Verified live
        // 2026-07-23 on BATS:XRP (tradesCount 7 vs totalTrades 6 with 1 open).
        var openTrade = null;
        var closedTrades = trades;
        if (totalOpenTrades > 0 && trades.length > 0) {
          openTrade = trades[trades.length - 1];
          closedTrades = trades.slice(0, trades.length - 1);
        }
        var lastClosedTrade = closedTrades.length > 0 ? closedTrades[closedTrades.length - 1] : null;

        // Historical MFE/MAE across closed trades. rn.p / dd.p are fractions of position
        // value (0.038 = 3.8%), scaled x100 here to match the percent units the alert-level
        // math expects (entry * (1 +/- pct/100)).
        var favPcts = [], advPcts = [];
        for (var ct = 0; ct < closedTrades.length; ct++) {
          var tr = closedTrades[ct];
          var fav = tr && tr.rn && typeof tr.rn.p === 'number' ? tr.rn.p * 100 : null;
          var adv = tr && tr.dd && typeof tr.dd.p === 'number' ? Math.abs(tr.dd.p) * 100 : null;
          if (fav !== null && fav > 0) favPcts.push(fav);
          if (adv !== null) advPcts.push(adv);
        }
        var excursionStats = null;
        if (favPcts.length > 0) {
          var favSum = 0, advSum = 0, favMax = 0, advMax = 0;
          for (var fi = 0; fi < favPcts.length; fi++) { favSum += favPcts[fi]; if (favPcts[fi] > favMax) favMax = favPcts[fi]; }
          for (var ai = 0; ai < advPcts.length; ai++) { advSum += advPcts[ai]; if (advPcts[ai] > advMax) advMax = advPcts[ai]; }
          var r2 = function(n) { return Math.round(n * 100) / 100; };
          excursionStats = {
            totalTrades: trades.length,
            completedTrades: favPcts.length,
            avgFavorablePct: r2(favSum / favPcts.length),
            maxFavorablePct: r2(favMax),
            avgAdversePct: advPcts.length ? r2(advSum / advPcts.length) : 0,
            maxAdversePct: advPcts.length ? r2(advMax) : 0,
          };
        }

        return {
          studyName: chosen.name,
          matchedFilter: matched.length > 0,
          attachedNames: attachedNames,
          totalOpenTrades: totalOpenTrades,
          openPL: perf.openPL || 0,
          openPLPercent: perf.openPLPercent || 0,
          lastClosedTrade: lastClosedTrade,
          openTrade: openTrade,
          excursionStats: excursionStats,
        };
      } catch(e) { return { error: e.message, attachedNames: [] }; }
    })()
  `).catch((e) => ({ error: e.message, attachedNames: [] }));
}

function sideFromEntryCode(tp) {
  if (tp === 'le' || tp === 'lx') return 'LONG';
  if (tp === 'se' || tp === 'sx') return 'SHORT';
  return null;
}

function usdText(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const num = Number(n);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)} USD`;
}

// A strategy freshly (re)attached to a chart, or just switched to a new symbol/timeframe,
// takes a moment to finish recomputing across its whole bar history — reading reportData()
// mid-recompute can catch a stale/incomplete snapshot. Poll a few times and require the same
// trade identity twice in a row before trusting it. openPL is deliberately excluded from the
// stability signature: for a genuinely open position it fluctuates with every live price tick,
// so comparing it would either false-negative on stability or force waiting out real market
// movement. Bounded well under the DOM path's cost — each internal-API read is near-instant.
async function readStableStrategyReportData(study_filter, { maxAttempts = 6, intervalMs = 350 } = {}) {
  let last = null;
  let lastSignature = null;
  let stableCount = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rd = await readStrategyReportData(study_filter);
    last = rd;
    if (rd?.error) return rd;

    // Only the open trade's ENTRY side goes into the signature — its synthesized exit row
    // is mark-to-market and changes with every live bar, which would never read as stable.
    const o = rd.openTrade;
    const t = rd.lastClosedTrade;
    const signature = JSON.stringify({
      totalOpenTrades: rd.totalOpenTrades,
      open: o ? [o.e?.tm, o.e?.p, o.q] : null,
      closed: t ? [t.e?.tm, t.e?.p, t.x?.tm, t.x?.p] : null,
    });

    if (signature === lastSignature) {
      stableCount += 1;
      if (stableCount >= 1) return rd;
    } else {
      stableCount = 0;
    }
    lastSignature = signature;
    await sleep(intervalMs);
  }

  return last;
}

// Ground-truth open/flat detection and trade details straight from the strategy's internal
// report object. `totalOpenTrades`/`openPL` are authoritative (same source the Strategy Tester
// Overview tab reads) — no false positives from a lagging on-chart label, no false negatives
// from a DOM read that timed out.
export async function getStrategyPositionState({ study_filter } = {}) {
  const rd = await readStableStrategyReportData(study_filter);
  if (rd?.error) {
    return {
      success: false,
      source: 'strategy_internal_api',
      error: rd.error,
      studyName: rd.studyName || null,
      matchedFilter: Boolean(rd.matchedFilter),
      attachedNames: rd.attachedNames || [],
    };
  }

  const isOpen = rd.totalOpenTrades > 0;
  let trade;
  if (isOpen) {
    // The still-open position is the last trades[] element — real entry timestamp, entry
    // price, side, and live MFE (rn) / MAE (dd): the same data the Strategy Tester UI
    // renders for the row whose Exit column reads "Open".
    const t = rd.openTrade;
    trade = {
      tradeNumber: null,
      side: t ? sideFromEntryCode(t.e?.tp) : null,
      signal: 'OPEN',
      entryTime: t?.e?.tm ? new Date(t.e.tm).toISOString() : null,
      entryPrice: t?.e?.p != null ? String(t.e.p) : '—',
      netPnl: usdText(rd.openPL),
      favorableExcursion: usdText(t?.rn?.v),
      adverseExcursion: usdText(t?.dd?.v != null ? -Math.abs(t.dd.v) : null),
      rawText: null,
    };
  } else if (rd.lastClosedTrade) {
    const t = rd.lastClosedTrade;
    trade = {
      tradeNumber: null,
      side: sideFromEntryCode(t.e?.tp),
      signal: 'EXIT',
      entryTime: t.e?.tm ? new Date(t.e.tm).toISOString() : null,
      entryPrice: t.e?.p != null ? String(t.e.p) : '—',
      netPnl: usdText(t.tp?.v),
      favorableExcursion: usdText(t.rn?.v),
      adverseExcursion: usdText(t.dd?.v != null ? -Math.abs(t.dd.v) : t.dd?.v),
      rawText: null,
    };
  } else {
    trade = {
      tradeNumber: null, side: null, signal: 'EXIT', entryTime: null,
      entryPrice: '—', netPnl: '—', favorableExcursion: '—', adverseExcursion: '—', rawText: null,
    };
  }

  return {
    success: true,
    source: 'strategy_internal_api',
    studyName: rd.studyName,
    matchedFilter: Boolean(rd.matchedFilter),
    attachedNames: rd.attachedNames || [],
    totalOpenTrades: rd.totalOpenTrades,
    openPL: rd.openPL,
    excursionStats: rd.excursionStats || null,
    trade,
  };
}

async function getLatestTradeFromTesterDom({ timeout_ms = 14000 } = {}) {
  try {
    await ui.keyboard({ key: 'Escape' }).catch(() => null);
    await ui.openPanel({ panel: 'strategy-tester', action: 'open' }).catch(() => null);
  } catch {}

  const started = Date.now();
  let lastRaw = null;
  let stableCount = 0;

  while (Date.now() - started < timeout_ms) {
    await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtesting"]');
        if (!panel) return false;
        var tabs = Array.from(panel.querySelectorAll('[role="tab"], button, [role="button"]'));
        for (var i = 0; i < tabs.length; i++) {
          var text = (tabs[i].textContent || '').trim().toLowerCase();
          if (text.includes('list of trades')) { tabs[i].click(); return true; }
        }
        return false;
      })()
    `).catch(() => null);

    await sleep(500);

    // Scroll to the true bottom of the virtual trades list. Virtual lists
    // render new rows as you scroll, which increases scrollHeight — so we
    // keep scrolling until the max scrollTop position stops changing.
    let prevScrollTop = -1;
    for (let scrollPass = 0; scrollPass < 8; scrollPass++) {
      const newScrollTop = await evaluate(`
        (function() {
          var panel = document.querySelector('[data-name="backtesting"]')
            || document.querySelector('[class*="strategyReport"]')
            || document.querySelector('[class*="backtesting"]');
          if (!panel) return -1;
          var maxTop = -1;
          var els = panel.querySelectorAll('*');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.scrollHeight > el.clientHeight + 50) {
              el.scrollTop = el.scrollHeight;
              if (el.scrollTop > maxTop) maxTop = el.scrollTop;
            }
          }
          return maxTop;
        })()
      `).catch(() => -1);
      await sleep(250);
      if (newScrollTop !== -1 && newScrollTop === prevScrollTop) break;
      prevScrollTop = newScrollTop;
    }

    const panelText = await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtesting"]');
        if (!panel) return { text: '' };
        return { text: (panel.innerText || '').trim() };
      })()
    `).catch(() => ({ text: '' }));

    const trade = parseLatestTradeFromTesterText(panelText?.text || '');
    if (trade && trade.rawText) {
      if (trade.rawText === lastRaw) stableCount += 1;
      else stableCount = 0;
      lastRaw = trade.rawText;

      // Require at least 3 s before accepting a stable result. TradingView
      // shows the previous cached state immediately when a chart loads cold;
      // the 3 s window lets the strategy finish recalculating on fresh bars.
      if (stableCount >= 2 && Date.now() - started >= 3000) {
        return { success: true, source: 'strategy_tester_dom', trade };
      }
    }

    await sleep(300);
  }

  return { success: false, source: 'strategy_tester_dom', trade: null, error: 'Trade table did not finish loading in time.' };
}

// Primary entry point for reading the current trade/position state. The internal-API report
// object covers everything — open/flat status, entry time/price, side, P&L, and MFE/MAE —
// for both open and closed positions (the still-open trade is the last trades[] element).
// The DOM "List of Trades" scrape survives only as a full fallback for the case where no
// strategy source can be found or matched in the internal model at all.
export async function getLatestTradeFromTester({ timeout_ms = 14000, study_filter } = {}) {
  const apiResult = await getStrategyPositionState({ study_filter }).catch(() => null);

  if (apiResult?.success) {
    return { success: true, source: apiResult.source, trade: apiResult.trade };
  }

  return getLatestTradeFromTesterDom({ timeout_ms });
}

// Parse favorable/adverse excursion % from a single raw trade block.
// Returns absolute % values (both positive) so callers can do entry*(1±pct/100).
function parseTradeBlockStats(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const usdIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'USD') usdIdx.push(i);
  }
  const dateLinesCount = lines.filter(l =>
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}(?:, \d{1,2}:\d{2})?$/.test(l)
  ).length;
  const hasTwoDates = dateLinesCount >= 2;
  const hasOpenSignal = lines.some(l => l === 'Open');
  const isOpen = !hasTwoDates || hasOpenSignal;
  const pnlStart = hasTwoDates ? 2 : 1;

  function pctAt(idx) {
    const next = lines[idx + 1];
    if (!next || !/[%％]/.test(next)) return null;
    const n = parseFloat(next.replace(/[%％,\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : null;
  }

  return {
    isOpen,
    favorablePct: usdIdx[pnlStart + 1] !== undefined ? pctAt(usdIdx[pnlStart + 1]) : null,
    adversePct:   usdIdx[pnlStart + 2] !== undefined ? pctAt(usdIdx[pnlStart + 2]) : null,
  };
}

// Compute avg/max favorable and adverse excursion % from all COMPLETED trades (open trade
// excluded). Primary source is the internal reportData().trades[] read (rn/dd per trade) —
// instant, no panel navigation. The DOM scrape below survives only as a fallback for when
// no strategy source can be matched internally.
export async function getAllTradesExcursionStats({ timeout_ms = 14000, study_filter } = {}) {
  const rd = await readStableStrategyReportData(study_filter).catch(() => null);
  if (rd && !rd.error) return rd.excursionStats || null;
  return getAllTradesExcursionStatsDom({ timeout_ms });
}

// Legacy DOM path: read the full strategy tester panel text and parse per-trade excursions.
async function getAllTradesExcursionStatsDom({ timeout_ms = 14000 } = {}) {
  try {
    await ui.keyboard({ key: 'Escape' }).catch(() => null);
    await ui.openPanel({ panel: 'strategy-tester', action: 'open' }).catch(() => null);
  } catch {}

  const started = Date.now();
  let lastRaw = null;
  let stableCount = 0;
  let fullText = null;

  while (Date.now() - started < timeout_ms) {
    await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtesting"]');
        if (!panel) return false;
        var tabs = Array.from(panel.querySelectorAll('[role="tab"], button, [role="button"]'));
        for (var i = 0; i < tabs.length; i++) {
          var t = (tabs[i].textContent || '').trim().toLowerCase();
          if (t.includes('list of trades')) { tabs[i].click(); return true; }
        }
        return false;
      })()
    `).catch(() => null);

    await sleep(500);

    const panelText = await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtesting"]');
        if (!panel) return { text: '' };
        return { text: (panel.innerText || '').trim() };
      })()
    `).catch(() => ({ text: '' }));

    const raw = panelText?.text || '';
    if (raw.includes('Trade #')) {
      if (raw === lastRaw) stableCount++;
      else stableCount = 0;
      lastRaw = raw;
      if (stableCount >= 2) { fullText = raw; break; }
    }
    await sleep(300);
  }

  if (!fullText) return null;

  const normalized = String(fullText)
    .replace(/ /g, ' ')
    .replace(/−/g, '-')
    .replace(/−/g, '-')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const body = normalized.slice(normalized.indexOf('Trade #') + 'Trade #'.length).trim();
  const blocks = body
    .split(/\n(?=\d+(?:Long|Short))/)
    .map(b => b.trim())
    .filter(b => /^\d+(?:Long|Short)/.test(b));

  const favPcts = [];
  const advPcts = [];

  for (const block of blocks) {
    const { isOpen, favorablePct, adversePct } = parseTradeBlockStats(block);
    if (!isOpen) {
      if (favorablePct != null && favorablePct > 0) favPcts.push(favorablePct);
      if (adversePct != null) advPcts.push(adversePct);
    }
  }

  if (favPcts.length === 0) return null;

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const round2 = n => Math.round(n * 100) / 100;

  return {
    totalTrades: blocks.length,
    completedTrades: favPcts.length,
    avgFavorablePct: round2(avg(favPcts)),
    maxFavorablePct: round2(Math.max(...favPcts)),
    avgAdversePct:   round2(avg(advPcts)),
    maxAdversePct:   round2(Math.max(...advPcts)),
  };
}

// Parse key metrics from Strategy Tester Performance Summary tab innerText.
export function parseStrategyMetricsText(text) {
  const norm = String(text || '')
    .replace(/ /g, ' ')
    .replace(/−/g, '-')
    .replace(/–/g, '-')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const lines = norm.split('\n').map(l => l.trim()).filter(Boolean);

  function extractValue(candidate, valueType) {
    const text = candidate.replace(/,/g, '').trim();
    if (valueType === 'pct') {
      const match = text.match(/(-?\d+\.?\d*)\s*[%％]/);
      if (match) return parseFloat(match[1]);
    }
    if (valueType === 'frac') {
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) return `${match[1]}/${match[2]}`;
    }
    if (valueType === 'posint') {
      const match = text.match(/^(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
    if (valueType === 'float') {
      const match = text.match(/^-?\d+\.?\d*$/);
      if (match) return parseFloat(match[0]);
      if (text === '∞') return null;
    }
    return null;
  }

  function findAfterLabel(labelPatterns, valueType, windowSize = 6) {
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (labelPatterns.some(p => lower.includes(p))) {
        const sameLine = extractValue(lines[i], valueType);
        if (sameLine != null) return sameLine;
        for (let j = i + 1; j <= Math.min(i + windowSize, lines.length - 1); j++) {
          const candidate = lines[j];
          const extracted = extractValue(candidate, valueType);
          if (extracted != null) return extracted;
        }
      }
    }
    return null;
  }

  const netProfitPct = findAfterLabel(['net profit', 'net profit %', 'net profit pct'], 'pct');
  const maxDrawdownPct = findAfterLabel(['max drawdown', 'maximum drawdown'], 'pct');
  const totalTrades = findAfterLabel(['total closed trades', 'total trades', 'closed trades'], 'posint');
  const percentProfitable = findAfterLabel(['percent profitable', 'profitable trades', 'win rate'], 'pct');
  const profitFactor = findAfterLabel(['profit factor'], 'float');
  const winningTrades = findAfterLabel(['number winning trades', 'winning trades', 'winning trades'], 'posint');
  let profitableFrac = findAfterLabel(['percent profitable'], 'frac');
  if (!profitableFrac && winningTrades != null && totalTrades != null) {
    profitableFrac = `${winningTrades}/${totalTrades}`;
  }

  return {
    netProfitPct: netProfitPct != null ? Math.round(netProfitPct * 100) / 100 : null,
    maxDrawdownPct: maxDrawdownPct != null ? Math.round(Math.abs(maxDrawdownPct) * 100) / 100 : null,
    totalTrades: totalTrades ?? null,
    percentProfitable: percentProfitable != null ? Math.round(percentProfitable * 100) / 100 : null,
    profitableFrac: profitableFrac ?? null,
    profitFactor: profitFactor != null ? Math.round(profitFactor * 1000) / 1000 : null,
  };
}

export async function getStrategyMetricsFromDOM({ timeout_ms = 16000 } = {}) {
  try {
    await ui.keyboard({ key: 'Escape' }).catch(() => null);
    await ui.openPanel({ panel: 'strategy-tester', action: 'open' }).catch(() => null);
  } catch {}

  const started = Date.now();

  // Click Performance Summary / Metrics tab (NOT "List of Trades")
  await evaluate(`
    (function() {
      var panel = document.querySelector('[data-name="backtesting"]')
        || document.querySelector('[class*="strategyReport"]')
        || document.querySelector('[class*="backtesting"]');
      if (!panel) return false;
      var tabs = Array.from(panel.querySelectorAll('[role="tab"], button[class*="tab"], [class*="tabItem"]'));
      if (!tabs.length) tabs = Array.from(panel.querySelectorAll('button, [role="button"]'));
      var names = ['performance summary', 'metrics', 'overview', 'summary'];
      for (var ni = 0; ni < names.length; ni++) {
        for (var i = 0; i < tabs.length; i++) {
          var t = (tabs[i].textContent || '').trim().toLowerCase();
          if (t.includes(names[ni])) { tabs[i].click(); return true; }
        }
      }
      // Fallback: first tab that is NOT "list of trades" or "properties"
      for (var i = 0; i < tabs.length; i++) {
        var t = (tabs[i].textContent || '').trim().toLowerCase();
        if (!t.includes('list') && !t.includes('trades') && !t.includes('propert') && t.length > 2 && t.length < 30) {
          tabs[i].click();
          return true;
        }
      }
      return false;
    })()
  `).catch(() => null);

  await sleep(600);

  let lastText = null;
  let stableCount = 0;
  let panelText = null;

  while (Date.now() - started < timeout_ms) {
    const result = await evaluate(`
      (function() {
        var panel = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]')
          || document.querySelector('[class*="backtesting"]');
        if (!panel) return { text: '' };
        return { text: (panel.innerText || '').trim() };
      })()
    `).catch(() => ({ text: '' }));

    const text = result?.text || '';
    const hasData = text.length > 50 && (
      text.includes('Net Profit') ||
      text.includes('Total Closed') ||
      text.includes('Profit Factor') ||
      text.includes('Percent Profitable')
    );

    if (hasData) {
      if (text === lastText) stableCount++;
      else stableCount = 0;
      lastText = text;

      if (stableCount >= 2 && Date.now() - started >= 3000) {
        panelText = text;
        break;
      }
    }

    await sleep(400);
  }

  if (!panelText) {
    if (lastText && lastText.length > 50) {
      panelText = lastText;
    } else {
      return { success: false, error: 'Strategy Tester metrics did not load in time', metrics: null };
    }
  }

  const metrics = parseStrategyMetricsText(panelText);
  const hasAnyMetric = Object.values(metrics).some(v => v != null);
  if (!hasAnyMetric) {
    return { success: false, error: 'Could not parse metrics from Strategy Tester panel', metrics: null };
  }

  return { success: true, metrics };
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = '${filter}';
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById('${entity_id}');
      if (!study) return { error: 'Study not found: ${entity_id}' };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  const results = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var meta = null;
          try { meta = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
          var name = meta ? (meta.description || meta.shortDescription || meta.fullDescription || '') : '';
          // Name match is the reliable signal — reportData/performance/ordersData methods exist
          // on the generic Study base class too (e.g. "Dividends", "Splits"), not just strategies.
          if (/strategy/i.test(name)) { strat = s; break; }
        }
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) { var keys = Object.keys(rd); for (var k = 0; k < keys.length; k++) { var val = rd[keys[k]]; if (val !== null && val !== undefined && typeof val !== 'function') metrics[keys[k]] = val; } }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { var pval = perf[pkeys[p]]; if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval; } }
        }
        return {metrics: metrics, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var meta = null;
          try { meta = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
          var name = meta ? (meta.description || meta.shortDescription || meta.fullDescription || '') : '';
          if (/strategy/i.test(name)) { strat = s; break; }
        }
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'ordersData() returned non-array.'};
        var result = [];
        for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, trade_count: trades?.trades?.length || 0, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var meta = null;
          try { meta = s.metaInfo ? s.metaInfo() : null; } catch(e) {}
          var name = meta ? (meta.description || meta.shortDescription || meta.fullDescription || '') : '';
          // Name match is the reliable signal — reportData/performance/ordersData methods exist
          // on the generic Study base class too (e.g. "Dividends", "Splits"), not just strategies.
          if (/strategy/i.test(name)) { strat = s; break; }
        }
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

export async function getQuote({ symbol } = {}) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = '${symbol || ''}';
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
