import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stripBom, parseJsonText, readJsonFile } from '../src/json_file.js';

const BOM = '﻿';

function withTempFile(name, contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jsonfile-'));
  const p = join(dir, name);
  writeFileSync(p, contents, 'utf8');
  try {
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stripBom removes a leading BOM and leaves everything else alone', () => {
  assert.equal(stripBom(BOM + '{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  // Only the LEADING BOM goes: a U+FEFF inside a string value is real data.
  assert.equal(stripBom('{"a":"x' + BOM + 'y"}'), '{"a":"x' + BOM + 'y"}');
  assert.equal(stripBom(''), '');
});

test('stripBom passes non-strings through untouched', () => {
  assert.equal(stripBom(null), null);
  assert.equal(stripBom(undefined), undefined);
  assert.equal(stripBom(42), 42);
});

test('the BOM is what breaks plain JSON.parse — this is the bug being guarded', () => {
  assert.throws(() => JSON.parse(BOM + '{"a":1}'));
  assert.deepEqual(parseJsonText(BOM + '{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
});

test('parseJsonText still throws on genuinely malformed JSON', () => {
  assert.throws(() => parseJsonText('{"a":'));
  assert.throws(() => parseJsonText(BOM + '{"a":'));
  assert.throws(() => parseJsonText('not json at all'));
});

test('readJsonFile reads a BOM-prefixed file that JSON.parse would reject', () => {
  withTempFile('bom.json', BOM + '{"openTrades":[1,2,3]}', (p) => {
    assert.deepEqual(readJsonFile(p), { openTrades: [1, 2, 3] });
  });
});

test('readJsonFile reads a clean file identically', () => {
  withTempFile('clean.json', '{"openTrades":[1,2,3]}', (p) => {
    assert.deepEqual(readJsonFile(p), { openTrades: [1, 2, 3] });
  });
});

test('readJsonFile throws on a missing file rather than returning a fallback', () => {
  // Callers decide what a missing file means; the reader must not silently invent an empty one.
  assert.throws(() => readJsonFile(join(tmpdir(), 'definitely-does-not-exist-9f3a2b.json')));
});

test('a real status-file shape survives the BOM round trip', () => {
  const status = {
    updatedAt: '2026-08-06T14:08:32.141Z',
    signalsFound: 6,
    openTrades: [{ symbol: 'BATS:DRN', signal: 'OPEN', entryPrice: '11.2' }],
    lines: ['08/05/2026, 03:10:13 PM ET | WATCHLIST: Swing 15m'],
  };
  withTempFile('status.json', BOM + JSON.stringify(status, null, 2), (p) => {
    const parsed = readJsonFile(p);
    assert.equal(parsed.openTrades.length, 1);
    assert.equal(parsed.openTrades[0].symbol, 'BATS:DRN');
    assert.equal(parsed.signalsFound, 6);
  });
});
