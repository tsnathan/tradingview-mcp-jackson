import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebhookPayload, normalizeWebhookTag, timeframeTag, sentKey } from '../src/core/trade_webhook.js';

const BASE = { symbol: 'BATS:SOXL', side: 'LONG', timeframe: '45', price: 42.1, group: 'swing', secret: 's3cr3t' };

describe('normalizeWebhookTag', () => {
  it('accepts the shapes timeframeTag itself emits', () => {
    for (const t of ['15m', '45m', '1h', '4h', '1d', '1w', '1mo']) {
      assert.equal(normalizeWebhookTag(t), t);
    }
  });

  it('trims and lowercases', () => {
    assert.equal(normalizeWebhookTag('  45M  '), '45m');
    assert.equal(normalizeWebhookTag('Swing_A'), 'swing_a');
  });

  it('rejects anything that would fragment a ledger key or a log line', () => {
    // The tag is echoed into the ledger, the console and the executor's own records; whitespace or
    // punctuation in it would silently split what should be one routing bucket.
    for (const bad of ['', '   ', null, undefined, 'a b', '45m!', 'tag/with/slash', 'x'.repeat(21), '45m|1d']) {
      assert.equal(normalizeWebhookTag(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe('buildWebhookPayload tag routing', () => {
  it('defaults to the timeframe tag when no override is given', () => {
    assert.equal(buildWebhookPayload(BASE).tag, '45m');
    assert.equal(buildWebhookPayload({ ...BASE, timeframe: 'D' }).tag, '1d');
  });

  it('leaves a plain market payload byte-for-byte unchanged', () => {
    // The armed auto-send path never passes `tag`, so its payload must be provably untouched by
    // this feature — same invariant the order-type work had to preserve.
    assert.deepEqual(buildWebhookPayload(BASE), {
      symbol: 'SOXL', side: 'buy', group: 'swing', tag: '45m', price: '42.1', secret: 's3cr3t',
    });
  });

  it('honours a valid override', () => {
    assert.equal(buildWebhookPayload({ ...BASE, tag: 'swing_b' }).tag, 'swing_b');
    assert.equal(buildWebhookPayload({ ...BASE, tag: '  1H ' }).tag, '1h');
  });

  it('falls back to the timeframe tag for an absent or malformed override', () => {
    for (const bad of [null, undefined, '', '   ', 'a b', 'x'.repeat(21)]) {
      assert.equal(buildWebhookPayload({ ...BASE, tag: bad }).tag, '45m');
    }
  });

  it('does not let the override touch any other field', () => {
    const withTag = buildWebhookPayload({ ...BASE, tag: 'swing_b' });
    const without = buildWebhookPayload(BASE);
    assert.deepEqual({ ...withTag, tag: null }, { ...without, tag: null });
  });
});

describe('the dedupe key is independent of the routing tag', () => {
  it('keys on the timeframe, so an override cannot orphan a position', () => {
    // sentKey takes no tag at all, by design: the key identifies the POSITION and must be
    // reproducible by the automatic dispatch and auto-close paths, which only ever see a timeframe.
    // A key that moved with the routing tag would silently defeat the duplicate-send guard and the
    // "did we open this" lookup a later close depends on.
    const args = { symbol: 'BATS:SOXL', timeframe: '45', entryTime: '2026-08-05T14:00:00.000Z' };
    assert.equal(sentKey(args), `SOXL|45m|${args.entryTime}`);
    assert.equal(sentKey({ ...args, timeframe: '45' }), sentKey(args));
    // And the tag the order actually went out under is still recoverable from the payload.
    assert.equal(buildWebhookPayload({ ...BASE, tag: 'swing_b' }).tag, 'swing_b');
    assert.equal(timeframeTag('45'), '45m');
  });

  it('still refuses a key when there is no entry time', () => {
    assert.equal(sentKey({ symbol: 'SOXL', timeframe: '45', entryTime: null }), null);
  });
});
