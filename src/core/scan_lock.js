/**
 * Cross-process scan lock.
 *
 * The scheduled `run_signal_job.js` task and a dashboard-triggered scan (`/api/run-cron-now`,
 * "Run Scan Now") are separate OS processes with no shared memory -- the dashboard's own
 * in-process `scanState.running` boolean cannot see the scheduled task, and vice versa. Both
 * driving the same live TradingView chart and writing the same baseline/status JSON files at
 * once corrupts both: confirmed live 2026-08-07, a whole watchlist's open trades vanished from
 * the dashboard and a symbol's baseline records came back byte-identical across two different
 * timeframes, traced to a scheduled scan and a dashboard scan overlapping for several minutes.
 *
 * This is a plain lock FILE, not a database or OS mutex, on purpose -- consistent with every
 * other piece of cross-process state in this project (status/*.json, the webhook ledger).
 * Acquisition is atomic (O_EXCL create) so two processes racing to acquire can never both win.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCK_PATH = resolve(__dirname, '..', '..', 'status', 'scan.lock');

// Generously above the documented worst-case legitimate scan (a full watchlist walk has taken
// 35+ minutes here before) so a slow-but-real scan is never mistaken for a dead one.
export const STALE_LOCK_MS = 60 * 60 * 1000;

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but this user can't signal it -- still alive.
    return err?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function removeLockFile(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {}
}

/**
 * Throws an Error with .code === 'SCAN_BUSY' (and .holder describing who has it) if a live scan
 * already holds the lock. A holder whose pid is no longer running, or whose lock has sat past
 * STALE_LOCK_MS, is reclaimed automatically -- a crash that skips the release must not brick
 * every future scan.
 */
export function acquireScanLock({ action = 'scan', lockPath = DEFAULT_LOCK_PATH } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        action,
        startedAt: new Date().toISOString(),
      }), { flag: 'wx' });
      return { acquired: true, lockPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      const holder = readLock(lockPath);
      if (!holder) {
        // Unreadable/corrupt lock file can't be evidence anything is genuinely running.
        removeLockFile(lockPath);
        continue;
      }

      const ageMs = Date.now() - Date.parse(holder.startedAt || 0);
      const stale = !isPidAlive(holder.pid) || !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS;
      if (stale) {
        removeLockFile(lockPath);
        continue;
      }

      const busyErr = new Error(
        `A scan is already running (${holder.action || 'unknown'}, pid ${holder.pid}, started ${holder.startedAt})`,
      );
      busyErr.code = 'SCAN_BUSY';
      busyErr.holder = holder;
      throw busyErr;
    }
  }

  const err = new Error('Failed to acquire scan lock after clearing a stale holder.');
  err.code = 'SCAN_LOCK_ERROR';
  throw err;
}

/**
 * Only removes the lock if the CURRENT process still owns it. Without this check, a process
 * that got reclaimed as stale (see above) would have its delayed cleanup delete the NEW owner's
 * lock out from under it, opening the door for a third scan to start while the second is still
 * running.
 */
export function releaseScanLock({ lockPath = DEFAULT_LOCK_PATH } = {}) {
  const holder = readLock(lockPath);
  if (holder && holder.pid === process.pid) {
    removeLockFile(lockPath);
  }
}

export function readScanLock({ lockPath = DEFAULT_LOCK_PATH } = {}) {
  return readLock(lockPath);
}
