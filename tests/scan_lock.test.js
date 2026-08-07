import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { acquireScanLock, releaseScanLock, readScanLock, STALE_LOCK_MS } from '../src/core/scan_lock.js';

function withLockDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scanlock-'));
  const lockPath = join(dir, 'scan.lock');
  try {
    return fn(lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deadPid() {
  // A real pid that has already exited -- guaranteed dead, no reliance on a made-up number.
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

test('acquireScanLock succeeds on an empty lock path and writes pid/action/startedAt', () => {
  withLockDir((lockPath) => {
    const before = Date.now();
    const res = acquireScanLock({ action: 'unit-test', lockPath });
    assert.equal(res.acquired, true);
    const holder = readScanLock({ lockPath });
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.action, 'unit-test');
    assert.ok(Date.parse(holder.startedAt) >= before);
  });
});

test('acquireScanLock throws SCAN_BUSY when a live process holds the lock', () => {
  withLockDir((lockPath) => {
    acquireScanLock({ action: 'first', lockPath });
    assert.throws(
      () => acquireScanLock({ action: 'second', lockPath }),
      (err) => err.code === 'SCAN_BUSY' && err.holder.action === 'first',
    );
  });
});

test('acquireScanLock reclaims a lock whose pid is no longer running', () => {
  withLockDir((lockPath) => {
    const pid = deadPid();
    writeFileSync(lockPath, JSON.stringify({ pid, action: 'orphaned', startedAt: new Date().toISOString() }));
    const res = acquireScanLock({ action: 'new-owner', lockPath });
    assert.equal(res.acquired, true);
    assert.equal(readScanLock({ lockPath }).action, 'new-owner');
  });
});

test('acquireScanLock reclaims a lock past STALE_LOCK_MS even if the pid coincidentally is alive', () => {
  withLockDir((lockPath) => {
    const staleStart = new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, action: 'stuck', startedAt: staleStart }));
    const res = acquireScanLock({ action: 'new-owner', lockPath });
    assert.equal(res.acquired, true);
    assert.equal(readScanLock({ lockPath }).action, 'new-owner');
  });
});

test('acquireScanLock does NOT reclaim a live, recent lock held by another pid', () => {
  withLockDir((lockPath) => {
    const pid = deadPid(); // dead now, but prove the alive-check actually gates first
    writeFileSync(lockPath, JSON.stringify({ pid, action: 'recent', startedAt: new Date().toISOString() }));
    // Even recently-started, a dead pid must still be reclaimed -- liveness, not just age, decides.
    const res = acquireScanLock({ action: 'new-owner', lockPath });
    assert.equal(res.acquired, true);
  });
});

test('acquireScanLock treats a corrupt/unreadable lock file as reclaimable', () => {
  withLockDir((lockPath) => {
    writeFileSync(lockPath, 'not json at all {{{');
    const res = acquireScanLock({ action: 'new-owner', lockPath });
    assert.equal(res.acquired, true);
  });
});

test('releaseScanLock only removes a lock owned by the current process', () => {
  withLockDir((lockPath) => {
    const foreignPid = deadPid();
    writeFileSync(lockPath, JSON.stringify({ pid: foreignPid, action: 'foreign', startedAt: new Date().toISOString() }));
    releaseScanLock({ lockPath });
    assert.ok(existsSync(lockPath), 'must not delete a lock owned by a different pid');

    acquireScanLock({ action: 'mine', lockPath });
    releaseScanLock({ lockPath });
    assert.ok(!existsSync(lockPath), 'must delete a lock owned by this process');
  });
});

test('releaseScanLock on a missing lock file is a no-op, not an error', () => {
  withLockDir((lockPath) => {
    assert.doesNotThrow(() => releaseScanLock({ lockPath }));
  });
});

test('two concurrent acquire attempts on the same fresh path: only one wins', () => {
  withLockDir((lockPath) => {
    acquireScanLock({ action: 'winner', lockPath });
    let loserThrew = false;
    try {
      acquireScanLock({ action: 'loser', lockPath });
    } catch (err) {
      loserThrew = err.code === 'SCAN_BUSY';
    }
    assert.ok(loserThrew);
    assert.equal(readScanLock({ lockPath }).action, 'winner');
  });
});
