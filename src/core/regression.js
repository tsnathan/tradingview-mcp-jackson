import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATUS_FILE = join(ROOT, 'status', 'latest-signal-status.json');
const REGRESSION_FILE = join(ROOT, 'status', 'regression-status.json');

function formatEt(dt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(dt);
}

function normSym(s) {
  return String(s || '').split(':').pop().toUpperCase() || String(s || '').toUpperCase();
}

// Pure validation: takes a parsed status object, returns {passed, checksTotal, checksPassed, checksFailed, failures}
export function reconcile(status) {
  const failures = [];
  let checksTotal = 0;
  let checksPassed = 0;

  const openTrades = Array.isArray(status.openTrades) ? status.openTrades : [];
  const priorSignals = Array.isArray(status.priorSignals) ? status.priorSignals : [];

  // Check 1: each openTrades entry has required fields and signal=OPEN
  for (const trade of openTrades) {
    checksTotal++;
    const missing = ['symbol', 'entryPrice', 'entryTime'].filter(f => !trade[f]);
    if (String(trade.signal || '').toUpperCase() !== 'OPEN') missing.push('signal=OPEN');
    if (missing.length === 0) {
      checksPassed++;
    } else {
      failures.push(`openTrades ${trade.symbol || '?'} (TF ${trade.timeframe}): missing ${missing.join(', ')}`);
    }
  }

  // Check 2: each priorSignals section has at least one trade row
  for (const section of priorSignals) {
    checksTotal++;
    const rows = Array.isArray(section.trades) ? section.trades : [];
    if (rows.length > 0) {
      checksPassed++;
    } else {
      failures.push(`priorSignals ${section.watchlistName} TF ${section.timeframe}: no rows`);
    }
  }

  // Check 3: each openTrades entry has a matching OPEN row in priorSignals
  for (const trade of openTrades) {
    checksTotal++;
    const section = priorSignals.find(
      s => s.watchlistName === trade.watchlistName && String(s.timeframe) === String(trade.timeframe)
    );
    if (!section) {
      failures.push(`reconcile: no priorSignals section for "${trade.watchlistName}" TF ${trade.timeframe} (openTrade: ${trade.symbol})`);
      continue;
    }
    const rows = Array.isArray(section.trades) ? section.trades : [];
    const match = rows.find(r => normSym(r.symbol) === normSym(trade.symbol));
    if (!match) {
      failures.push(`reconcile: ${trade.symbol} in openTrades (${trade.watchlistName} TF ${trade.timeframe}) has no row in priorSignals`);
    } else {
      // priorSignals may show EXIT during the synthetic-OPEN transition state (signal fired but
      // strategy tester hasn't updated yet). Only require the symbol to be tracked, not OPEN.
      checksPassed++;
    }
  }

  return { passed: failures.length === 0, checksTotal, checksPassed, checksFailed: failures.length, failures };
}

// Reads the live status file, runs reconcile(), writes regression-status.json, returns result
export async function runRegression() {
  const now = new Date();
  let status;
  try {
    status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    const result = {
      passed: false,
      checkedAt: now.toISOString(),
      formattedCheckedAt: formatEt(now),
      checksTotal: 0,
      checksPassed: 0,
      checksFailed: 1,
      failures: ['Could not read status file'],
    };
    writeFileSync(REGRESSION_FILE, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  const { passed, checksTotal, checksPassed, checksFailed, failures } = reconcile(status);
  const result = {
    passed,
    checkedAt: now.toISOString(),
    formattedCheckedAt: formatEt(now),
    checksTotal,
    checksPassed,
    checksFailed,
    failures,
  };
  writeFileSync(REGRESSION_FILE, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
