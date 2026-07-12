import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { runSignalJob } from '../src/core/morning.js';
import { runRegression } from '../src/core/regression.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_FILE = join(ROOT, 'status', 'latest-signal-status.json');
const REGRESSION_FILE = join(ROOT, 'status', 'regression-status.json');
const RULES_FILE = join(ROOT, 'rules.json');
const SYNC_STATE_FILE = join(ROOT, 'status', 'watchlist-sync-state.json');
const OPEN_PREFLIGHT_MINUTES = 9 * 60 + 15; // 9:15 ET

function etDateString(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD
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

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return hours * 60 + minutes;
}

function etMinutesNow(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function readSyncState() {
  if (!existsSync(SYNC_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SYNC_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSyncState(state) {
  writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

const notify = process.argv.includes('--notify');
const all = process.argv.includes('--all');
const force = process.argv.includes('--force') || all;

// Read previous connection state before scan so we can detect reconnection
let prevHadConnectionError = false;
if (existsSync(STATUS_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    prevHadConnectionError = !!(prev.connectionError || prev.watchdogError);
  } catch {}
}

// Watchlist symbol sync (switches TradingView's watchlist panel) only runs once at the
// first scan after 9:15 AM ET "preflight" and once at the first scan at/after market close.
// Any other run of the day skips it — use `tv watchlist sync` for an on-demand sync.
let marketHours = { timezone: 'America/New_York', open: '09:30', close: '16:00' };
if (existsSync(RULES_FILE)) {
  try {
    const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
    if (rules.market_hours) marketHours = { ...marketHours, ...rules.market_hours };
  } catch {}
}

const todayEt = etDateString(new Date());
const nowMinutes = etMinutesNow(marketHours.timezone);
const syncState = readSyncState();
const wantOpenSync = nowMinutes >= OPEN_PREFLIGHT_MINUTES && syncState.openSyncDate !== todayEt;
const wantCloseSync = nowMinutes >= timeToMinutes(marketHours.close) && syncState.closeSyncDate !== todayEt;
const syncWatchlists = wantOpenSync || wantCloseSync;

try {
  const result = await runSignalJob({ changed_only: !all, notify, force, syncWatchlists });

  if (!result.skipped && !result.connection_error) {
    if (wantOpenSync) syncState.openSyncDate = todayEt;
    if (wantCloseSync) syncState.closeSyncDate = todayEt;
    if (wantOpenSync || wantCloseSync) writeSyncState(syncState);
  }

  if (result.skipped) {
    console.log(result.reason || 'No signal');
    process.exit(0);
  }

  if ((result.signal_lines || []).length > 0) {
    console.log(result.signal_lines.join('\n'));
  } else {
    console.log(result.summary_line || 'NO SIGNAL');
  }

  // Trigger regression after the first successful scan following a connection error,
  // OR on the first successful scan of each trading day (to catch stale open trades early).
  const shouldRunRegression = !result.connection_error && (
    (prevHadConnectionError) ||
    (!regressionRanToday())
  );

  if (shouldRunRegression) {
    const reason = prevHadConnectionError ? 'post-reconnection' : 'first scan of day';
    console.log(`Running regression suite (${reason})...`);
    try {
      const reg = await runRegression();
      const label = reg.passed ? 'PASS' : 'FAIL';
      console.log(`Regression ${reg.formattedCheckedAt} ET — ${label} (${reg.checksPassed}/${reg.checksTotal} checks)`);
      if (reg.failures.length) {
        for (const f of reg.failures) console.log(`  - ${f}`);
      }
    } catch (err) {
      console.error('Regression error:', err?.message || String(err));
    }
  }

  process.exit(0);
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
