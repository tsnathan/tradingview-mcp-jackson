import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDashboardStatus, ensureTradingViewConnection, exportMetricsScan, runBrief, runSignalJob, syncWatchlistSymbolsFromTradingView } from '../src/core/morning.js';
import { runRegression } from '../src/core/regression.js';
import { buildEdgeAnalysis } from '../src/core/edge_analysis.js';
import { readPerfSnapshots, listRuleTypes, findWatchlistOrphans, readAllTradeLogs } from '../src/core/trade_log.js';
import { simulatePortfolio, sweepMaxPositions, computeOpenPositionConcurrency } from '../src/core/portfolio_sim.js';
import { lookupSymbol } from '../src/core/symbol_lookup.js';
import { getExecutorPortfolio } from '../src/core/executor_portfolio.js';
import {
  loadWebhookCredentials,
  loadWebhookSettings,
  buildWebhookPayload,
  sendTradeWebhook,
  sentKey,
  alreadySent,
  recordSent,
  recordExitSent,
  recordManualClose,
  ledgerRowType,
  readSentArchive,
  bareTicker,
  timeframeTag,
  readSentState,
  validateOrderSpec,
  ORDER_TYPES,
  TIME_IN_FORCE,
} from '../src/core/trade_webhook.js';

// Keep the server alive if the scan throws an unexpected error.
process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[server] unhandledRejection:', reason));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Timeframe tags in chart order, for sorting filter dropdowns. Unknown tags sort last rather than
// being dropped — an unrecognized timeframe must stay selectable.
const TF_TAG_ORDER = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '1w', '1mo'];
const STATUS_FILE = join(ROOT, 'status', 'latest-signal-status.json');
const REGRESSION_FILE = join(ROOT, 'status', 'regression-status.json');
const SWEET_SPOT_FILE = join(ROOT, 'status', 'sweet-spot.json');

/**
 * Resolve the `rule` query param to a rule_type filter.
 *
 * Defaults to the most-traded variant rather than pooling everything, because pooling is only ever
 * correct before an A/B run exists and silently becomes wrong the moment one does. `rule=all` opts
 * into pooling explicitly.
 */
function resolveRuleType(q) {
  const asked = q.get('rule');
  if (asked === 'all') return null;
  if (asked) return asked;
  return listRuleTypes()[0]?.rule_type ?? null;
}

function etDateString(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function regressionRanToday() {
  if (!existsSync(REGRESSION_FILE)) return false;
  try {
    const reg = JSON.parse(readFileSync(REGRESSION_FILE, 'utf8'));
    return reg.checkedAt && etDateString(reg.checkedAt) === etDateString(new Date());
  } catch {
    return false;
  }
}
const HTML_FILE = join(ROOT, 'dashboard', 'index.html');
const PORT = Number(process.env.SIGNAL_DASHBOARD_PORT || 3030);
const MAX_JSON_BODY_BYTES = 16 * 1024;
const ACTION_TIMEOUT_MS = 600 * 1000;

const scanState = {
  running: false,
  action: null,
  startedAt: null,
};

const metricsState = { running: false, startedAt: null };
const reconcileState = { running: false, startedAt: null };
/**
 * Sweet-spot sweep state. Deliberately NOT behind runExclusive: the sweep is read-only over the
 * trade-log CSVs, runs in its own process, and needs minutes — holding the scan lock that long
 * would block dashboard-triggered scans for no safety benefit (scheduled scans are separate
 * processes and were never covered by that lock anyway). It has its own single-flight guard because
 * two concurrent sweeps would race to write the same result file, not because a scan conflicts.
 */
const sweetSpotState = { running: false, startedAt: null, quick: false, ruleType: null, phase: null, pct: 0, error: null, child: null };
let _lastMetricsCsvContent = null;

function metricsResultsToCsv(results) {
  const headers = ['Watchlist', 'Timeframe', 'Symbol', 'Net P&L %', 'Max Drawdown %', 'Total Trades', 'Profitable (count)', 'Profitable %', 'Profit Factor', 'Error'];
  const rows = results.map(r => {
    const m = r.metrics || {};
    return [
      r.watchlistName,
      r.timeframe,
      r.symbol,
      m.netProfitPct ?? '',
      m.maxDrawdownPct ?? '',
      m.totalTrades ?? '',
      m.profitableFrac ?? '',
      m.percentProfitable ?? '',
      m.profitFactor ?? '',
      r.error || '',
    ];
  });
  const escape = v => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
}

function defaultStatus() {
  return {
    updatedAt: new Date().toISOString(),
    formattedTimestampEt: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date()),
    scanMode: 'signals_only',
    hasSignals: false,
    signalsFound: 0,
    changedSignals: 0,
    lines: [],
    summary: 'NO SIGNAL',
    skipped: false,
    reason: null,
    connectionError: false,
    errorMessage: null,
    symbolsScanned: 0,
    scanResults: [],
    priorSignals: [],
  };
}

function getStatus() {
  let status;
  if (!existsSync(STATUS_FILE)) {
    status = defaultStatus();
  } else {
    try {
      status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    } catch {
      status = defaultStatus();
    }
  }
  if (existsSync(REGRESSION_FILE)) {
    try {
      status.regressionResult = JSON.parse(readFileSync(REGRESSION_FILE, 'utf8'));
    } catch {}
  }
  return status;
}

function writeStatus(result) {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(createDashboardStatus(result), null, 2), 'utf8');
  } catch {}
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function loadRulesFile() {
  const rulesPath = join(ROOT, 'rules.json');
  if (!existsSync(rulesPath)) return null;
  try {
    return JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeRulesFile(rules) {
  writeFileSync(join(ROOT, 'rules.json'), JSON.stringify(rules, null, 2), 'utf8');
}

// baseline.watchlists is the ground truth for symbol membership (see the "Watchlist Symbols panel"
// note in CLAUDE.md) — read directly from disk rather than through morning.js's unexported
// loadBaseline, same pattern scripts/backfill_trade_log.js already uses.
function baselineFilePath() {
  const rules = loadRulesFile() || {};
  return resolve(ROOT, rules.baseline_file || join(ROOT, 'swing-signal-baseline.json'));
}

function loadBaselineFile() {
  const baselinePath = baselineFilePath();
  if (!existsSync(baselinePath)) return {};
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return {};
  }
}

// Direct single-field patches to already-written status/baseline files — same technique used to
// fix the watchlist-sync display bug (see CLAUDE.md): a full scan is not required just to refresh
// one derived field after a side action like archiving completes.
function patchStatusFile(patch) {
  try {
    const current = existsSync(STATUS_FILE) ? JSON.parse(readFileSync(STATUS_FILE, 'utf8')) : {};
    writeFileSync(STATUS_FILE, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
  } catch {}
}

function patchBaselineFile(patch) {
  const baselinePath = baselineFilePath();
  try {
    const current = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
    writeFileSync(baselinePath, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
  } catch {}
}

function buildOpenBySymbolTf() {
  const snapshots = readPerfSnapshots();
  const openBySymbolTf = {};
  for (const [key, perf] of Object.entries(snapshots)) {
    openBySymbolTf[key] = {
      openPct: (perf.openPLPercent || 0) * 100,
      maxDDPct: (perf.maxDDPercent || 0) * 100,
    };
  }
  return openBySymbolTf;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeTimeframe(timeframe) {
  const raw = String(timeframe || '').trim().toUpperCase();
  if (!raw) return null;

  const aliasMap = {
    '1D': 'D',
    '1W': 'W',
    '1M': 'M',
    DAILY: 'D',
    WEEKLY: 'W',
    MONTHLY: 'M',
  };
  if (aliasMap[raw]) return aliasMap[raw];
  if (/^\d+$/.test(raw)) return String(Number(raw));

  const minuteMatch = raw.match(/^(\d+)\s*(M|MIN|MINS|MINUTE|MINUTES)$/);
  if (minuteMatch) return String(Number(minuteMatch[1]));

  return ['D', 'W', 'M'].includes(raw) ? raw : null;
}

async function runExclusive(actionName, fn) {
  if (scanState.running) {
    const err = new Error(`A scan is already running (${scanState.action || 'unknown'})`);
    err.code = 'SCAN_BUSY';
    throw err;
  }

  scanState.running = true;
  scanState.action = actionName;
  scanState.startedAt = new Date().toISOString();

  pushEvent({
    type: 'scan-started',
    action: actionName,
    startedAt: scanState.startedAt,
  });

  try {
    const operation = Promise.resolve().then(fn);
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`Scan timed out after ${Math.round(ACTION_TIMEOUT_MS / 1000)} seconds`);
        err.code = 'SCAN_TIMEOUT';
        reject(err);
      }, ACTION_TIMEOUT_MS);
    });
    return await Promise.race([operation, timeout]).finally(() => {
      clearTimeout(timeoutHandle);
    });
  } finally {
    const finishedAt = new Date().toISOString();
    pushEvent({
      type: 'scan-finished',
      action: actionName,
      startedAt: scanState.startedAt,
      finishedAt,
    });

    scanState.running = false;
    scanState.action = null;
    scanState.startedAt = null;
  }
}

const eventClients = new Set();

function pushEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(payload);
    } catch {
      eventClients.delete(client);
    }
  }
}

// fs.watch is a fast path but silently drops events on Windows after a while.
// The setInterval poll below is the reliable backstop.
try {
  watch(join(ROOT, 'status'), (eventType, filename) => {
    const f = filename ? String(filename) : '';
    if (f !== 'latest-signal-status.json' && f !== 'regression-status.json') return;
    pushEvent({ type: 'status-updated', eventType, updatedAt: new Date().toISOString() });
  });
} catch {}

// Reliable fallback: poll file mtimes every 10 s and push SSE if either file changed.
let _statusMtime = 0;
let _regressionMtime = 0;
setInterval(() => {
  try {
    const sm = existsSync(STATUS_FILE) ? statSync(STATUS_FILE).mtimeMs : 0;
    const rm = existsSync(REGRESSION_FILE) ? statSync(REGRESSION_FILE).mtimeMs : 0;
    if (sm !== _statusMtime || rm !== _regressionMtime) {
      _statusMtime = sm;
      _regressionMtime = rm;
      pushEvent({ type: 'status-updated', updatedAt: new Date().toISOString() });
    }
  } catch {}
}, 10_000);

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/scan-state') {
    sendJson(res, 200, {
      success: true,
      running: scanState.running,
      action: scanState.action,
      startedAt: scanState.startedAt,
    });
    return;
  }

  if (req.url === '/api/status') {
    sendJson(res, 200, { ...getStatus(), scanRunning: scanState.running });
    return;
  }

  if (req.url === '/api/edge-analysis' || req.url.startsWith('/api/edge-analysis?')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const minTrades = Number(url.searchParams.get('min') || 4);
      // Drawdown and open P&L come from the per-symbol snapshot written by each scan; the CSVs
      // hold closed trades only and cannot supply either.
      sendJson(res, 200, buildEdgeAnalysis({ openBySymbolTf: buildOpenBySymbolTf(), minTrades, ruleType: resolveRuleType(url.searchParams) }));
    } catch (err) {
      sendJson(res, 500, { available: false, error: err?.message || 'edge analysis failed' });
    }
    return;
  }

  if (req.url === '/api/open-position-concurrency' || req.url.startsWith('/api/open-position-concurrency?')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ruleType = resolveRuleType(url.searchParams);
      sendJson(res, 200, { ...computeOpenPositionConcurrency({ ruleType }), ruleTypes: listRuleTypes() });
    } catch (err) {
      sendJson(res, 500, { available: false, error: err?.message || 'concurrency analysis failed' });
    }
    return;
  }

  if (req.url === '/api/symbol-lookup' || req.url.startsWith('/api/symbol-lookup?')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const symbol = url.searchParams.get('symbol') || '';
      const baseline = loadBaselineFile();
      const status = getStatus();
      const result = lookupSymbol(symbol, {
        baseline,
        openTrades: Array.isArray(status.openTrades) ? status.openTrades : [],
        openBySymbolTf: buildOpenBySymbolTf(),
        ruleType: resolveRuleType(url.searchParams),
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { available: false, error: err?.message || 'symbol lookup failed' });
    }
    return;
  }

  /**
   * Manual orphan sweep — recompute which logged tickers are no longer in any watchlist, right now.
   *
   * Read-only over the trade log and the baseline, so it needs no TradingView connection and no
   * scan: `findWatchlistOrphans` diffs against `baseline.watchlists`, which is already the persisted
   * source of truth for membership. It finishes in well under a second, which is why it's a plain
   * button rather than a background job.
   *
   * It does NOT resync watchlist membership from TradingView. If a symbol was removed in TradingView
   * more recently than the last reconciliation, the baseline hasn't heard about it yet and no amount
   * of recomputing will surface it — so the response reports `membershipAsOf` and the per-watchlist
   * sync timestamps, letting the card say how current the answer is instead of implying it's live.
   * Nothing is archived here; that stays the separate confirm-gated action below.
   */
  if (req.method === 'POST' && req.url === '/api/detect-orphans') {
    try {
      const baseline = loadBaselineFile();
      const rules = loadRulesFile() || {};
      const names = Object.keys(rules.watchlists || {});
      const orphans = findWatchlistOrphans(baseline, names);
      patchBaselineFile({ trade_log_orphans: orphans });
      patchStatusFile({ tradeLogOrphans: orphans });
      // Only configured watchlists count: baseline.watchlists keeps dead entries under old names
      // forever (nothing prunes them on rename), and a stale entry's timestamp would misreport how
      // fresh the membership actually is — the same allowlist findWatchlistOrphans itself applies.
      const live = Object.entries(baseline.watchlists || {}).filter(([n]) => names.includes(n));
      const syncedAt = live.map(([, w]) => w?.updated_at).filter(Boolean).sort();
      console.log(`[orphans] manual sweep: ${orphans.length} orphan(s) across ${live.length} watchlist(s)`);
      sendJson(res, 200, {
        success: true,
        tradeLogOrphans: orphans,
        watchlistCount: live.length,
        symbolCount: live.reduce((s, [, w]) => s + (Array.isArray(w?.symbols) ? w.symbols.length : 0), 0),
        membershipAsOf: syncedAt.length ? syncedAt[syncedAt.length - 1] : null,
        membershipOldest: syncedAt.length ? syncedAt[0] : null,
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'orphan sweep failed' });
    }
    return;
  }

  // Orphan detection (which logged tickers are no longer in any watchlist) also runs automatically on
  // every scan — see findWatchlistOrphans in trade_log.js and its call site in morning.js. This
  // endpoint is the one-click ARCHIVE action the dashboard banner offers
  // instead of requiring `node scripts/archive_trade_log.js --orphans` by hand. It shells out to
  // that exact script (rather than reimplementing its row-moving logic here) so archiving always
  // goes through the one tested, byte-exact code path. Guarded by runExclusive against a scan
  // running concurrently: a live scan appends rows to the same trade-log CSVs this rewrites in
  // full, and an overlapping read-modify-write could drop an appended row.
  if (req.method === 'POST' && req.url === '/api/archive-orphans') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { success: false, error: err?.message || 'invalid request body' });
      return;
    }
    const args = [join(ROOT, 'scripts', 'archive_trade_log.js')];
    const symbols = Array.isArray(body.symbols)
      ? body.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
      : typeof body.symbols === 'string'
        ? body.symbols.split(',').map((s) => String(s).trim().toUpperCase()).filter(Boolean)
        : null;
    if (symbols && symbols.length) {
      args.push('--symbol', symbols.join(','));
    } else {
      args.push('--orphans');
    }
    if (body.tf) {
      args.push('--tf', String(body.tf));
    }
    runExclusive('archive-orphans', () => new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, args, { cwd: ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', rejectRun);
      child.on('close', (code) => {
        if (code === 0) resolveRun(stdout);
        else rejectRun(new Error(stderr.trim() || `archive script exited with code ${code}`));
      });
    }))
      .then((output) => {
        // Refresh the persisted orphan list immediately so the banner clears without waiting for
        // the next scheduled reconciliation — archived tickers' rows now live under trade-log/archive/,
        // which readAllTradeLogs() (and so findWatchlistOrphans) excludes automatically.
        const baseline = loadBaselineFile();
        const rules = loadRulesFile() || {};
        const orphans = findWatchlistOrphans(baseline, Object.keys(rules.watchlists || {}));
        patchBaselineFile({ trade_log_orphans: orphans });
        patchStatusFile({ tradeLogOrphans: orphans });
        sendJson(res, 200, { success: true, output, tradeLogOrphans: orphans });
      })
      .catch((err) => {
        sendJson(res, err?.code === 'SCAN_BUSY' ? 409 : 500, { success: false, error: err?.message || 'archive failed' });
      });
    return;
  }

  if (req.url.startsWith('/api/portfolio-sim')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams;
      const csv = (k) => {
        const v = q.get(k);
        return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
      };
      const capital = Number(q.get('capital') || 100000);
      const maxPositions = Number(q.get('maxPositions') || 5);
      const timeframes = csv('timeframes');
      const tickers = csv('tickers');
      const priority = q.get('priority') || 'chronological';
      const commissionPerTrade = Number(q.get('commission') || 0);
      const ruleType = resolveRuleType(q);

      // Rank priority needs a score per symbol/timeframe; reuse CAGR/DD from the edge analysis so
      // both tabs agree on what "better" means.
      let rankBy = {};
      if (priority === 'rank') {
        const snaps = readPerfSnapshots();
        const openBySymbolTf = {};
        for (const [key, perf] of Object.entries(snaps)) {
          openBySymbolTf[key] = {
            openPct: (perf.openPLPercent || 0) * 100,
            maxDDPct: (perf.maxDDPercent || 0) * 100,
          };
        }
        // Same variant as the simulation, or the ranking would order symbols by an edge measured
        // under a different exit rule than the one being simulated.
        const edge = buildEdgeAnalysis({ openBySymbolTf, minTrades: 4, ruleType });
        if (edge.available) {
          for (const s of edge.symbols) if (s.cagrDd !== null) rankBy[s.key] = s.cagrDd;
        }
      }

      const result = simulatePortfolio({ capital, maxPositions, timeframes, tickers, priority, rankBy, commissionPerTrade, ruleType });
      const sweep = q.get('sweep') === '1'
        ? sweepMaxPositions({ capital, timeframes, tickers, priority, rankBy, ruleType })
        : null;
      sendJson(res, 200, { ...result, sweep, ruleType, ruleTypes: listRuleTypes() });
    } catch (err) {
      sendJson(res, 500, { available: false, error: err?.message || 'portfolio sim failed' });
    }
    return;
  }

  // Sweet Spot — the on-demand twin of `node scripts/sweep_portfolio_grid.mjs`. GET serves the last
  // persisted result plus live progress; POST starts a run. The two are separate because the full
  // sweep takes minutes: answering the GET from a cached file means the tab renders instantly on
  // open and a run is an explicit act, never a side effect of viewing.
  if (req.url === '/api/sweet-spot' || req.url.startsWith('/api/sweet-spot?')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ruleType = resolveRuleType(url.searchParams);
      let result = null;
      if (existsSync(SWEET_SPOT_FILE)) {
        try {
          result = JSON.parse(readFileSync(SWEET_SPOT_FILE, 'utf8'));
        } catch (err) {
          // A torn/half-written file must not take the tab down — report it and offer a re-run.
          result = null;
          sweetSpotState.error = `Stored result unreadable: ${err?.message || 'parse failed'}`;
        }
      }
      // Staleness: the sweep is a snapshot of a log that grows on every scan, so a result is only
      // as good as the trade count it was computed from. Reported rather than acted on — nothing
      // auto-reruns a multi-minute job.
      let currentTradeCount = null;
      try {
        currentTradeCount = readAllTradeLogs({ ruleType: result?.ruleType ?? ruleType })
          .filter((r) => r.entry_time_ms && r.exit_time_ms).length;
      } catch {}
      sendJson(res, 200, {
        success: true,
        result,
        running: sweetSpotState.running,
        startedAt: sweetSpotState.startedAt,
        phase: sweetSpotState.phase,
        pct: sweetSpotState.pct,
        error: sweetSpotState.error,
        currentTradeCount,
        newTrades: result && Number.isFinite(currentTradeCount) ? currentTradeCount - result.tradeCount : null,
        ruleType,
        ruleTypes: listRuleTypes(),
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'sweet spot read failed' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sweet-spot/run') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { success: false, error: err?.message || 'invalid request body' });
      return;
    }
    if (sweetSpotState.running) {
      sendJson(res, 409, { success: false, error: 'A sweep is already running.', startedAt: sweetSpotState.startedAt });
      return;
    }
    const quick = body.quick === true;
    const rule = typeof body.rule === 'string' && body.rule ? body.rule : null;
    const args = [join(ROOT, 'scripts', 'run_sweet_spot.js')];
    if (quick) args.push('--quick');
    if (rule) args.push(`--rule=${rule}`);

    sweetSpotState.running = true;
    sweetSpotState.startedAt = new Date().toISOString();
    sweetSpotState.quick = quick;
    sweetSpotState.ruleType = rule;
    sweetSpotState.phase = 'starting';
    sweetSpotState.pct = 0;
    sweetSpotState.error = null;

    // stdio is piped (never 'inherit' — see the /api/restart note below for what inheriting a pipe
    // nobody drains does to this process). stdout carries the progress JSON lines this reads.
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    sweetSpotState.child = child;
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';   // keep the trailing partial line for the next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'progress') {
            sweetSpotState.phase = msg.phase;
            sweetSpotState.pct = msg.pct;
          } else if (msg.type === 'error') {
            sweetSpotState.error = msg.reason;
          }
        } catch { /* a non-JSON line is a stray log, not a failure */ }
      }
    });
    child.stderr.on('data', (d) => { stderrBuf += d; });
    child.on('error', (err) => {
      sweetSpotState.error = err?.message || 'failed to start sweep';
      sweetSpotState.running = false;
      sweetSpotState.child = null;
    });
    child.on('close', (code) => {
      if (code !== 0 && !sweetSpotState.error) {
        sweetSpotState.error = stderrBuf.trim().split('\n').slice(-3).join(' ') || `sweep exited with code ${code}`;
      }
      sweetSpotState.running = false;
      sweetSpotState.child = null;
      sweetSpotState.phase = code === 0 ? 'done' : 'failed';
      pushEvent({ type: 'sweet-spot-finished', ok: code === 0, error: sweetSpotState.error });
    });

    sendJson(res, 202, { success: true, started: true, quick, startedAt: sweetSpotState.startedAt });
    return;
  }

  if (req.url === '/api/watchlists') {
    try {
      const rules = loadRulesFile() || {};
      sendJson(res, 200, { success: true, watchlists: Object.keys(rules.watchlists || {}) });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'Failed to read rules' });
    }
    return;
  }

  // Webhook arming state + delivery ledger. The secret is never included in any response — only
  // whether one is configured — so the dashboard can show status without the browser ever holding
  // a credential that places live trades.
  /**
   * The webhook ledger, shaped for the Webhook Orders tab: what's still open, and the full history.
   *
   * Parsed from the ledger key (`TICKER|tag|entryTimeISO`) with the stored record's own fields
   * preferred — the key is the fallback, not the source, so a record written by a path that stores
   * richer fields keeps them. `tag` is passed straight back as the `timeframe` for the close call:
   * timeframeTag() is idempotent over its own output ("1h" -> "1h"), so the key the close endpoint
   * recomputes is byte-identical to the one the row came from. Getting that wrong would silently
   * fail the "did we open this" lookup rather than erroring.
   */
  if (req.url === '/api/webhook-ledger') {
    try {
      const sent = readSentState().sent || {};
      const archive = readSentArchive();
      // Archived records are closed overflow from the live ledger — same shape, plus the key they
      // were stored under. Live wins on the (impossible, but cheap to rule out) chance of a
      // collision, so a record can never appear twice in the history.
      const archivedEntries = archive.rows
        .filter((r) => r && r.key && !(r.key in sent))
        .map((r) => [r.key, r]);
      const rows = [...Object.entries(sent), ...archivedEntries].map(([key, rec]) => {
        const parts = String(key).split('|');
        return {
          key,
          archived: Boolean(rec?.archived_at),
          symbol: rec?.symbol || parts[0] || null,
          tag: rec?.tag || parts[1] || null,
          entryTime: parts[2] || null,
          side: rec?.side || null,
          price: rec?.price ?? null,
          orderType: rec?.order_type || 'market',
          timeInForce: rec?.time_in_force || null,
          source: rec?.source || null,
          sentAt: rec?.at || null,
          // Computed server-side from the same module that writes the records, so the tab's Type
          // column cannot drift from what "sent" actually means in the ledger.
          type: ledgerRowType(rec),
          exit: rec?.exit
            ? {
              side: rec.exit.side || null,
              price: rec.exit.price ?? null,
              orderType: rec.exit.order_type || 'market',
              timeInForce: rec.exit.time_in_force || null,
              source: rec.exit.source || null,
              // false only on a close this system recorded but did not send (closed at the broker
              // by hand, or placed by a TradingView alert). Absent on older records, all real sends.
              sent: rec.exit.sent !== false,
              note: rec.exit.note || null,
              at: rec.exit.at || null,
            }
            : null,
        };
      });
      // Newest first by when the ENTRY went out, so an open position and its later close stay
      // together as one row rather than the close re-sorting it to the top of the history.
      rows.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')));
      // Cross-timeframe exits are attached here rather than fetched separately by the tab: they are
      // a property of an open row ("another leg of this symbol just flipped"), and a second fetch
      // could resolve against a different scan than the rows were built from.
      let crossTfExits = [];
      try {
        crossTfExits = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))?.crossTfExits || [];
      } catch { /* the ledger is still fully usable without the last scan's cross-TF read */ }
      const crossByKey = {};
      for (const x of crossTfExits) {
        if (!x?.held_key) continue;
        (crossByKey[x.held_key] ||= []).push(x);
      }
      for (const r of rows) {
        // Only live open rows can have them — an archived/closed row's alerts are settled history.
        if (!r.exit && !r.archived && crossByKey[r.key]) r.crossTfExits = crossByKey[r.key];
      }

      const creds = loadWebhookCredentials();
      sendJson(res, 200, {
        success: true,
        configured: creds.configured,
        rows,
        // Open comes from the live ledger alone — an archived record is closed by definition, and an
        // archived row rendering a Close button would offer to act on something already settled.
        open: rows.filter((r) => !r.exit && !r.archived),
        closed: rows.filter((r) => r.exit),
        // Surfaced so the history can SAY when it is showing a partial window. Silently short
        // answers to "YTD" are exactly what archiving replaced.
        archive: { total: archive.total, truncated: archive.truncated, unreadable: archive.unreadable },
        // Filter vocabularies come from the data itself, so a filter can never offer a value that
        // matches nothing.
        symbols: [...new Set(rows.map((r) => r.symbol).filter(Boolean))].sort(),
        timeframes: [...new Set(rows.map((r) => r.tag).filter(Boolean))]
          .sort((a, b) => (TF_TAG_ORDER.indexOf(a) + 1 || 99) - (TF_TAG_ORDER.indexOf(b) + 1 || 99)),
        types: [...new Set(rows.map((r) => r.type).filter(Boolean))].sort(),
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'could not read the webhook ledger' });
    }
    return;
  }

  // Executor portfolio — the broker's own positions, reconciled against the webhook ledger. Fetched
  // server-side so the portfolio credential never reaches the browser, same rule as the webhook secret.
  if (req.url === '/api/executor-portfolio' || req.url.startsWith('/api/executor-portfolio?')) {
    (async () => {
      try {
        // Open trades come from the status file rather than a fresh scan: this endpoint must answer in
        // a second or two, and the reconciliation only needs "which tickers does the scanner think are
        // open", which the last scan already established.
        let openTrades = [];
        try {
          openTrades = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))?.openTrades || [];
        } catch { /* reconcile against the ledger alone if the status file isn't readable */ }
        sendJson(res, 200, await getExecutorPortfolio({ openTrades }));
      } catch (err) {
        sendJson(res, 500, { available: false, error: err?.message || 'portfolio fetch failed' });
      }
    })();
    return;
  }

  if (req.url === '/api/webhook-config') {
    try {
      const rules = loadRulesFile() || {};
      const settings = loadWebhookSettings(rules);
      const creds = loadWebhookCredentials();
      sendJson(res, 200, {
        success: true,
        configured: creds.configured,
        hasUrl: Boolean(creds.url),
        hasSecret: Boolean(creds.secret),
        group: settings.group,
        enabledTimeframes: settings.enabledTimeframes,
        tvAlertTimeframes: settings.tvAlertTimeframes,
        watchlists: rules.watchlists || {},
        sent: readSentState().sent,
        // Order vocabulary comes from the server so the dashboard's dropdowns can never offer a
        // value validateOrderSpec would then reject.
        orderTypes: ORDER_TYPES,
        timeInForce: TIME_IN_FORCE,
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'Failed to read webhook config' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/webhook-toggle') {
    readJsonBody(req).then((body) => {
      const timeframe = String(body?.timeframe ?? '').trim();
      if (!timeframe) {
        sendJson(res, 400, { success: false, error: 'timeframe is required' });
        return;
      }
      const rules = loadRulesFile();
      if (!rules) {
        sendJson(res, 500, { success: false, error: 'rules.json not found or invalid' });
        return;
      }
      // `mode` selects which list is being toggled: 'auto' = the scanner places the order itself,
      // 'tv-alert' = a TradingView watchlist alert places it and the scanner only records it. The two
      // are kept mutually exclusive HERE as well as in loadWebhookSettings, because enabling one
      // while the other is still set would mean two orders for one signal.
      const mode = String(body?.mode || 'auto');
      if (mode !== 'auto' && mode !== 'tv-alert') {
        sendJson(res, 400, { success: false, error: `Unknown mode "${mode}" (expected "auto" or "tv-alert")` });
        return;
      }
      const settings = loadWebhookSettings(rules);
      const armed = new Set(settings.enabledTimeframes);
      const tvAlert = new Set(settings.tvAlertTimeframes);
      const enable = Boolean(body?.enabled);
      const target = mode === 'auto' ? armed : tvAlert;
      const other = mode === 'auto' ? tvAlert : armed;
      if (enable) { target.add(timeframe); other.delete(timeframe); } else { target.delete(timeframe); }
      rules.webhook = {
        ...(rules.webhook || {}),
        group: rules.webhook?.group || 'swing',
        enabled_timeframes: [...armed],
        tv_alert_timeframes: [...tvAlert],
      };
      writeRulesFile(rules);
      const label = mode === 'auto' ? (enable ? 'ARMED auto-send' : 'disarmed auto-send') : (enable ? 'marked TV-ALERT (ledger only)' : 'cleared TV-alert');
      console.log(`[webhook] ${label} timeframe ${timeframe} (auto: ${[...armed].join(',') || 'none'} | tv-alert: ${[...tvAlert].join(',') || 'none'})`);
      sendJson(res, 200, { success: true, enabledTimeframes: [...armed], tvAlertTimeframes: [...tvAlert] });
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }

  // Manual one-off send for a single row. Goes through the same dedupe ledger as the auto path, so
  // clicking Send on a row the scheduled scan already fired is refused rather than double-ordering.
  if (req.method === 'POST' && req.url === '/api/send-webhook') {
    readJsonBody(req).then(async (body) => {
      const creds = loadWebhookCredentials();
      if (!creds.configured) {
        sendJson(res, 400, { success: false, error: 'Webhook URL/secret not configured (set TRADE_WEBHOOK_URL + TRADE_WEBHOOK_SECRET, or fill webhook.local.json)' });
        return;
      }
      const { symbol, side, timeframe, price, entryTime } = body || {};
      if (!symbol || !timeframe) {
        sendJson(res, 400, { success: false, error: 'symbol and timeframe are required' });
        return;
      }
      // Order type / TIF / prices come from the dashboard's manual order form, not an automatic
      // calc. Re-validated here, not just client-side: this places a real order, and a priced type
      // missing its price is a hard 400 at the executor rather than something it guesses at.
      const check = validateOrderSpec(body || {});
      if (!check.ok) {
        sendJson(res, 400, { success: false, error: check.error });
        return;
      }
      const rules = loadRulesFile() || {};
      const settings = loadWebhookSettings(rules);
      const key = sentKey({ symbol, timeframe, entryTime });
      if (key && alreadySent(key) && !body.force) {
        sendJson(res, 409, { success: false, error: 'Already sent for this entry', alreadySent: true });
        return;
      }
      const payload = buildWebhookPayload({
        symbol, side, timeframe, price, group: settings.group, secret: creds.secret, ...check.spec,
      });
      const result = await sendTradeWebhook({ url: creds.url, payload });
      if (result.success) {
        recordSent(key, {
          symbol: payload.symbol, tag: payload.tag, side: payload.side, price: payload.price,
          order_type: payload.order_type || 'market', time_in_force: payload.time_in_force || null, source: 'manual',
        });
        console.log(`[webhook] manual send ${payload.side} ${payload.symbol} (${payload.tag}) @ ${payload.price} [${payload.order_type || 'market'}${payload.time_in_force ? '/' + payload.time_in_force : ''}]`);
      } else {
        console.error(`[webhook] manual send FAILED ${payload.symbol}: ${result.error}`);
      }
      // Echo the payload back with the secret stripped so the UI can show exactly what went out.
      const { secret, ...safePayload } = payload;
      sendJson(res, result.success ? 200 : 502, { ...result, payload: safePayload });
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }

  /**
   * Manual CLOSE for a position this system already opened via webhook — the hand-operated twin of
   * dispatchExitWebhooks, for liquidating a weak position to free a portfolio slot.
   *
   * Scoped exactly like the automatic exit path and for the same reason: it will only close a
   * position whose ENTRY is in the ledger. Sending a close for a position the executor was never
   * told about could error out or, worse, open an unintended opposite position if the receiver
   * doesn't validate. The closing action is the inverse of the *recorded* entry action rather than
   * a re-derivation from the position's side — the ledger is the only record of what actually went
   * out, and it can't disagree with itself.
   */
  if (req.method === 'POST' && req.url === '/api/send-webhook-exit') {
    readJsonBody(req).then(async (body) => {
      const creds = loadWebhookCredentials();
      if (!creds.configured) {
        sendJson(res, 400, { success: false, error: 'Webhook URL/secret not configured' });
        return;
      }
      const { symbol, timeframe, price, entryTime } = body || {};
      if (!symbol || !timeframe) {
        sendJson(res, 400, { success: false, error: 'symbol and timeframe are required' });
        return;
      }
      const check = validateOrderSpec(body || {});
      if (!check.ok) {
        sendJson(res, 400, { success: false, error: check.error });
        return;
      }
      const key = sentKey({ symbol, timeframe, entryTime });
      if (!key) {
        sendJson(res, 400, { success: false, error: 'entryTime is required to identify the position to close' });
        return;
      }
      const entryRecord = readSentState().sent[key];
      if (!entryRecord) {
        sendJson(res, 409, { success: false, error: 'No webhook entry recorded for this position — refusing to close something the executor was never told about' });
        return;
      }
      if (entryRecord.exit && !body.force) {
        sendJson(res, 409, { success: false, error: 'Exit already sent for this position', alreadySent: true });
        return;
      }
      const rules = loadRulesFile() || {};
      const settings = loadWebhookSettings(rules);
      const closeAction = String(entryRecord.side || 'buy').toLowerCase() === 'sell' ? 'buy' : 'sell';
      const payload = buildWebhookPayload({
        symbol, timeframe, price, action: closeAction, group: settings.group, secret: creds.secret, ...check.spec,
      });
      const result = await sendTradeWebhook({ url: creds.url, payload });
      if (result.success) {
        recordExitSent(key, {
          symbol: payload.symbol, tag: payload.tag, side: payload.side, price: payload.price,
          order_type: payload.order_type || 'market', time_in_force: payload.time_in_force || null, source: 'manual-exit',
        });
        console.log(`[webhook] manual EXIT ${payload.side} ${payload.symbol} (${payload.tag}) @ ${payload.price} [${payload.order_type || 'market'}${payload.time_in_force ? '/' + payload.time_in_force : ''}]`);
      } else {
        console.error(`[webhook] manual EXIT FAILED ${payload.symbol}: ${result.error}`);
      }
      const { secret, ...safePayload } = payload;
      sendJson(res, result.success ? 200 : 502, { ...result, payload: safePayload });
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }

  /**
   * Close a ledger position WITHOUT sending anything — for a position already closed by hand at the
   * broker. Bookkeeping only, so it deliberately does not require webhook credentials: refusing to
   * record reality because a secret is missing would leave the ledger asserting a position that no
   * longer exists, which is the failure this endpoint exists to fix.
   *
   * Same "entry must be in the ledger" guard as the real close, for a different reason: there is no
   * position to reconcile if this system never recorded opening one, and inventing an entry to hang
   * the close off would claim an order that was never placed. The recorded exit side is the inverse
   * of the stored ENTRY side (closing a long is a sell) — derived from the ledger's own record, never
   * re-derived from the strategy's current view, which can disagree.
   */
  if (req.method === 'POST' && req.url === '/api/close-webhook-local') {
    readJsonBody(req).then((body) => {
      const { symbol, timeframe, price, entryTime, note } = body || {};
      if (!symbol || !timeframe) {
        sendJson(res, 400, { success: false, error: 'symbol and timeframe are required' });
        return;
      }
      const key = sentKey({ symbol, timeframe, entryTime });
      if (!key) {
        sendJson(res, 400, { success: false, error: 'entryTime is required to identify the position to close' });
        return;
      }
      const entryRecord = readSentState().sent[key];
      if (!entryRecord) {
        sendJson(res, 409, { success: false, error: 'No webhook entry recorded for this position — nothing to close in the ledger' });
        return;
      }
      if (entryRecord.exit && !body.force) {
        sendJson(res, 409, { success: false, error: 'A close is already recorded for this position', alreadySent: true });
        return;
      }
      const closeAction = String(entryRecord.side || 'buy').toLowerCase() === 'sell' ? 'buy' : 'sell';
      recordManualClose(key, {
        symbol: bareTicker(symbol),
        tag: timeframeTag(timeframe),
        side: closeAction,
        // Optional: whatever the position actually filled at, if the user supplied it. Never guessed
        // from a quote — an invented fill price would read exactly like a real one.
        price: price === undefined || price === null || price === '' ? null : String(price),
        note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null,
      });
      console.log(`[webhook] manual (no-send) close recorded ${bareTicker(symbol)} (${timeframeTag(timeframe)}) — closed at broker, nothing sent`);
      sendJson(res, 200, { success: true, key, sent: false });
    }).catch((err) => sendJson(res, 400, { success: false, error: err?.message || 'Invalid body' }));
    return;
  }

  if (req.url === '/api/schedule-status') {
    const rules = loadRulesFile() || {};
    sendJson(res, 200, {
      success: true,
      disabled: Boolean(rules.schedule?.disabled),
      marketHours: rules.market_hours || {},
      holidays: Array.isArray(rules.market_hours?.holidays) ? rules.market_hours.holidays : [],
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/disable-schedule') {
    const rules = loadRulesFile();
    if (!rules) {
      sendJson(res, 500, { success: false, error: 'rules.json not found or invalid' });
      return;
    }
    rules.schedule = { ...rules.schedule, disabled: true };
    writeRulesFile(rules);
    sendJson(res, 200, { success: true, disabled: true });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/enable-schedule') {
    const rules = loadRulesFile();
    if (!rules) {
      sendJson(res, 500, { success: false, error: 'rules.json not found or invalid' });
      return;
    }
    rules.schedule = { ...rules.schedule, disabled: false };
    writeRulesFile(rules);
    sendJson(res, 200, { success: true, disabled: false });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/run-cron-now') {
    readJsonBody(req)
      .then((body) => {
        if (scanState.running) {
          sendJson(res, 409, {
            success: false,
            error: `A scan is already running (${scanState.action || 'unknown'})`,
            runningAction: scanState.action,
            startedAt: scanState.startedAt,
          });
          return;
        }

        const watchlistName = body.watchlistName ? String(body.watchlistName).trim() : null;

        // Respond immediately — a full scan takes 4-7 min across all watchlists.
        // Completion is reported via SSE cron-finished event so the browser never times out.
        sendJson(res, 202, { success: true, action: 'cron-now', status: 'started' });

        runExclusive('cron-now', async () => {
          // Step 1: Seed — sync watchlist symbols from TradingView before scanning.
          // The status bar shows "Seeding watchlists…" during this step.
          pushEvent({
            type: 'scan-progress',
            watchlistName: 'Seeding watchlists…',
            symbolsScanned: 0,
            symbolsTotal: 0,
            watchlistIndex: 0,
            watchlistTotal: 0,
          });
          const seedResult = await syncWatchlistSymbolsFromTradingView().catch(() => null);

          // Step 2: Scan — skip internal sync since we just did it.
          const scanResult = await runSignalJob({
            force: true,
            changed_only: false,
            notify: false,
            syncWatchlists: false,
            watchlistNames: watchlistName ? [watchlistName] : null,
            onProgress: (p) => pushEvent({ type: 'scan-progress', ...p }),
            onWatchlistComplete: (partial) => {
              writeStatus(partial);
              pushEvent({ type: 'status-updated', source: 'partial-scan', updatedAt: new Date().toISOString() });
            },
          });

          // Attach seed info so the .then() handler can use it.
          scanResult._seedResult = seedResult;
          return scanResult;
        })
          .then(async (result) => {
            const seedResult = result._seedResult;
            delete result._seedResult;
            if (seedResult && !result.watchlist_sync?.length) {
              result.watchlist_sync = Array.isArray(seedResult.synced) ? seedResult.synced : [];
            }

            writeStatus(result);
            pushEvent({ type: 'status-updated', source: 'manual-cron', updatedAt: new Date().toISOString() });

            // Re-enable the button immediately — regression runs in background.
            pushEvent({
              type: 'cron-finished',
              success: true,
              summary: String(result.summary_line || '').trim(),
              signalsFound: Number(result.signals_found || 0),
              changedSignals: Number(result.changed_signals || 0),
            });

            // Always run regression on a manual "Run Scan Now" click so metrics
            // are always fresh, not just on the first scan of the day.
            if (!result.connection_error) {
              runRegression()
                .then(() => pushEvent({ type: 'status-updated', source: 'regression', updatedAt: new Date().toISOString() }))
                .catch(() => {});
            }
          })
          .catch((error) => {
            pushEvent({
              type: 'cron-finished',
              success: false,
              error: error?.message || 'Scan failed',
            });
          });
      })
      .catch((err) => {
        sendJson(res, 400, { success: false, error: err?.message || 'Bad request' });
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/run-symbol-scan') {
    readJsonBody(req)
      .then((body) => {
        const symbol = normalizeSymbol(body.symbol);
        const timeframe = normalizeTimeframe(body.timeframe);
        if (!symbol || !timeframe) {
          sendJson(res, 400, {
            success: false,
            error: 'Both symbol and timeframe are required',
          });
          return;
        }

        const watchlistName = String(body.watchlistName || `Manual ${timeframe}`).trim() || `Manual ${timeframe}`;
        return runExclusive('symbol-scan', async () => {
          await ensureTradingViewConnection();

          const scanTarget = {
            watchlistName,
            timeframe,
            symbols: [symbol],
          };

          return runBrief({
            signals_only: false,
            changed_only: false,
            update_baseline: false,
            scan_targets: [scanTarget],
            full_scan_targets: [scanTarget],
          });
        })
          .then((result) => {
            writeStatus(result);
            pushEvent({ type: 'status-updated', source: 'manual-symbol-scan', updatedAt: new Date().toISOString() });

            const scan = Array.isArray(result.symbols_scanned) ? result.symbols_scanned[0] || {} : {};
            sendJson(res, 200, {
              success: true,
              action: 'symbol-scan',
              generatedAt: result.generated_at,
              result: {
                symbol: scan.state?.symbol || scan.symbol || symbol,
                timeframe: scan.timeframe || timeframe,
                hasSignal: Boolean(scan.signal?.hasSignal),
                direction: scan.signal?.direction || null,
                price: scan.signal?.price ?? scan.quote?.last ?? null,
                tradeSignal: scan.trade?.signal || null,
                summary: String(result.summary_line || '').trim(),
                error: scan.error || null,
              },
            });
          });
      })
      .catch((error) => {
        if (error?.code === 'SCAN_BUSY') {
          sendJson(res, 409, {
            success: false,
            error: error.message,
            runningAction: scanState.action,
            startedAt: scanState.startedAt,
          });
          return;
        }
        if (error?.code === 'SCAN_TIMEOUT') {
          sendJson(res, 504, {
            success: false,
            error: error.message,
          });
          return;
        }
        if (error?.message === 'Request body too large' || error?.message === 'Invalid JSON body') {
          sendJson(res, 400, {
            success: false,
            error: error.message,
          });
          return;
        }
        if (String(error?.message || '').toLowerCase().includes('tradingview connection unavailable')) {
          sendJson(res, 503, {
            success: false,
            error: error.message,
          });
          return;
        }
        sendJson(res, 500, {
          success: false,
          error: error?.message || 'Failed to run symbol scan',
        });
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/start-metrics-export') {
    readJsonBody(req)
      .then((body) => {
        if (scanState.running || metricsState.running || reconcileState.running) {
          sendJson(res, 409, {
            success: false,
            error: scanState.running
              ? `A scan is already running (${scanState.action || 'unknown'})`
              : reconcileState.running
                ? 'A reconciliation is already running'
                : 'A metrics export is already running',
          });
          return;
        }

        let scanTargets;
        if (Array.isArray(body.scanTargets) && body.scanTargets.length > 0) {
          scanTargets = body.scanTargets.map((target) => {
            const watchlistName = target.watchlistName ? String(target.watchlistName).trim() : undefined;
            const timeframe = target.timeframe ? normalizeTimeframe(target.timeframe) : undefined;
            if (target.timeframe && !timeframe) {
              throw new Error('Invalid timeframe');
            }
            return { watchlistName, timeframe, symbols: target.symbols };
          });
        } else if (body.watchlistName || body.timeframe || body.symbol) {
          const watchlistName = body.watchlistName ? String(body.watchlistName).trim() : undefined;
          const timeframe = body.timeframe ? normalizeTimeframe(body.timeframe) : undefined;
          if (body.timeframe && !timeframe) {
            throw new Error('Invalid timeframe');
          }
          scanTargets = [{ watchlistName, timeframe, symbols: body.symbol }];
        }

        sendJson(res, 202, { success: true, action: 'metrics-export', status: 'started' });
        metricsState.running = true;
        metricsState.startedAt = new Date().toISOString();
        pushEvent({ type: 'metrics-started', startedAt: metricsState.startedAt });

        exportMetricsScan({
          onProgress: (p) => pushEvent({ type: 'metrics-progress', ...p }),
          scanTargets,
        })
          .then(results => {
            _lastMetricsCsvContent = metricsResultsToCsv(results);
            const successCount = results.filter(r => r.success).length;
            pushEvent({ type: 'metrics-ready', count: results.length, successCount });
          })
          .catch(err => {
            pushEvent({ type: 'metrics-failed', error: err?.message || 'Metrics export failed' });
          })
          .finally(() => {
            metricsState.running = false;
            metricsState.startedAt = null;
          });
      })
      .catch((error) => {
        if (error?.message === 'Request body too large' || error?.message === 'Invalid JSON body' || error?.message === 'Invalid timeframe') {
          sendJson(res, 400, {
            success: false,
            error: error.message,
          });
          return;
        }
        sendJson(res, 500, {
          success: false,
          error: error?.message || 'Failed to start metrics export',
        });
      });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/start-reconciliation') {
    if (scanState.running || metricsState.running || reconcileState.running) {
      sendJson(res, 409, {
        success: false,
        error: scanState.running
          ? `A scan is already running (${scanState.action || 'unknown'})`
          : metricsState.running
            ? 'A metrics export is already running'
            : 'A reconciliation is already running',
      });
      return;
    }

    sendJson(res, 202, { success: true, action: 'reconciliation', status: 'started' });
    reconcileState.running = true;
    reconcileState.startedAt = new Date().toISOString();
    pushEvent({ type: 'reconcile-started', startedAt: reconcileState.startedAt });

    Promise.resolve()
      .then(async () => {
        await ensureTradingViewConnection();
        const results = await exportMetricsScan({
          onProgress: (p) => pushEvent({ type: 'reconcile-metrics-progress', ...p }),
        });
        _lastMetricsCsvContent = metricsResultsToCsv(results);
        pushEvent({ type: 'reconcile-metrics-ready', count: results.length, successCount: results.filter(r => r.success).length });
        const regressionResult = await runRegression();
        pushEvent({ type: 'reconcile-complete', regressionResult });
      })
      .catch(err => {
        pushEvent({ type: 'reconcile-failed', error: err?.message || 'Reconciliation failed' });
      })
      .finally(() => {
        reconcileState.running = false;
        reconcileState.startedAt = null;
      });
    return;
  }

  if (req.url === '/api/metrics-csv') {
    if (!_lastMetricsCsvContent) {
      sendJson(res, 404, { success: false, error: 'No metrics export has been run yet. Click "Export Strategy Metrics" first.' });
      return;
    }
    const ts = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="strategy-metrics-${ts}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end(_lastMetricsCsvContent);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/restart') {
    sendJson(res, 200, { success: true, message: 'Restarting server...' });
    // Give the response time to transmit, then spawn a new server process and exit.
    setTimeout(() => {
      // stdio goes to a log FILE, never 'inherit'. With 'inherit' the restarted server writes to
      // whatever pipe the original process was launched with — and after this process exits there is
      // nothing draining it. The buffer fills after a handful of console.log calls and the next write
      // blocks the event loop forever, which presents as a server that answers GETs that happen not
      // to log while every logging route hangs with no error anywhere. Diagnosed the hard way
      // 2026-07-29: two successful POSTs were enough to wedge it.
      let out = 'ignore';
      try {
        out = openSync(join(ROOT, 'dashboard-server.log'), 'a');
      } catch { /* fall back to discarding output rather than refusing to restart */ }
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
        cwd: ROOT,
      });
      child.unref();
      process.exit(0);
    }, 400);
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    eventClients.add(res);
    req.on('close', () => eventClients.delete(res));
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(HTML_FILE, 'utf8'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Signal dashboard running at http://127.0.0.1:${PORT}`);
});
