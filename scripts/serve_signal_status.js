import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDashboardStatus, ensureTradingViewConnection, exportMetricsScan, runBrief, runSignalJob, syncWatchlistSymbolsFromTradingView } from '../src/core/morning.js';
import { runRegression } from '../src/core/regression.js';

// Keep the server alive if the scan throws an unexpected error.
process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[server] unhandledRejection:', reason));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_FILE = join(ROOT, 'status', 'latest-signal-status.json');
const REGRESSION_FILE = join(ROOT, 'status', 'regression-status.json');

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

const server = http.createServer((req, res) => {
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

  if (req.url === '/api/watchlists') {
    try {
      const rules = loadRulesFile() || {};
      sendJson(res, 200, { success: true, watchlists: Object.keys(rules.watchlists || {}) });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err?.message || 'Failed to read rules' });
    }
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
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true,
        stdio: 'inherit',
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
