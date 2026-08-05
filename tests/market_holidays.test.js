import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isMarketHoliday,
  buildMarketHolidayCalendar,
  syncMarketHolidayCalendar,
} from '../src/core/morning.js';

const MH = { timezone: 'America/New_York', open: '09:30', close: '16:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], holidays: [] };

// 17:00Z is 12:00/13:00 ET year-round, so the ET calendar date always equals the intended one.
const at = (iso) => new Date(`${iso}T17:00:00.000Z`);

function computedFor(year, marketHours = MH) {
  const out = [];
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 1; d <= 31; d += 1) {
      const dt = new Date(Date.UTC(year, m - 1, d, 17));
      if (dt.getUTCMonth() !== m - 1) continue;
      const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (isMarketHoliday(dt, marketHours)) out.push(iso);
    }
  }
  return out;
}

describe('computed NYSE holidays', () => {
  it('matches the ten regular 2026 closures', () => {
    assert.deepEqual(computedFor(2026), [
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
      '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ]);
  });

  it('matches 2027, including Good Friday and the two weekend-shifted dates', () => {
    // Juneteenth 2027-06-19 is a Saturday -> Fri 06-18; Independence Day 07-04 is a Sunday -> Mon 07-05.
    const days = computedFor(2027);
    for (const iso of ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
      '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']) {
      assert.ok(days.includes(iso), `expected ${iso}`);
    }
    assert.ok(!days.includes('2027-06-19'), 'Saturday itself is not the observed holiday');
    assert.ok(!days.includes('2027-07-04'), 'Sunday itself is not the observed holiday');
  });

  it('observes a Saturday New Year on the PREVIOUS December 31', () => {
    // Regression: getObservedDate() used `day - 1` and produced "2028-01-00", a string that can
    // never equal a real market date, so this closure silently vanished from every gate.
    assert.equal(isMarketHoliday(at('2027-12-31'), MH), true);
    assert.ok(!computedFor(2028).includes('2028-01-00'), 'no malformed date string is emitted');
    // Jan 1 2028 itself is a Saturday, so isMarketHoliday() is correctly false for it — the market
    // is shut that day by the weekday gate, which is a separate check. Only the observed weekday
    // closure belongs in the holiday set.
    assert.equal(isMarketHoliday(at('2028-01-01'), MH), false);
  });

  it('does not treat an ordinary trading day as closed', () => {
    for (const iso of ['2026-08-05', '2027-01-04', '2027-12-30', '2028-03-01']) {
      assert.equal(isMarketHoliday(at(iso), MH), false, iso);
    }
  });
});

describe('buildMarketHolidayCalendar', () => {
  it('purges past dates and keeps today', () => {
    const cal = buildMarketHolidayCalendar({ marketHours: MH, now: at('2026-07-03') });
    assert.ok(cal.holidays.includes('2026-07-03'), 'today is still a holiday today');
    assert.ok(!cal.holidays.some((d) => d < '2026-07-03'), 'no elapsed dates');
  });

  it('always covers next year, so a cross-year observed closure is never missed', () => {
    // 2027-12-31 is emitted by the 2028 generator. A list holding "2027 only" would miss it.
    const cal = buildMarketHolidayCalendar({ marketHours: MH, now: at('2027-06-01') });
    assert.deepEqual(cal.coversYears, [2027, 2028]);
    assert.ok(cal.holidays.includes('2027-12-31'));
  });

  it('rolls forward once December has passed without needing a trigger date', () => {
    const cal = buildMarketHolidayCalendar({ marketHours: MH, now: at('2026-12-26') });
    assert.equal(cal.holidays.length, 10);
    assert.ok(cal.holidays.every((d) => d.startsWith('2027')));
  });

  it('recovers if the machine was off across the new year', () => {
    const cal = buildMarketHolidayCalendar({ marketHours: MH, now: at('2027-01-05') });
    assert.ok(cal.holidays.includes('2027-01-18'), 'current year is regenerated, not assumed present');
    assert.ok(!cal.holidays.includes('2027-01-01'), 'and the elapsed one is purged');
  });

  it('carries through ad-hoc closures that no rule can predict', () => {
    // A national day of mourning. Dropping it would silently reopen a day the exchange had closed.
    const mh = { ...MH, holidays: ['2026-12-01'] };
    const cal = buildMarketHolidayCalendar({ marketHours: mh, now: at('2026-08-05') });
    assert.ok(cal.holidays.includes('2026-12-01'));
    assert.deepEqual(cal.manual, ['2026-12-01']);
  });

  it('does not report a computed holiday as a manual extra', () => {
    const mh = { ...MH, holidays: ['2026-12-25'] };
    const cal = buildMarketHolidayCalendar({ marketHours: mh, now: at('2026-08-05') });
    assert.deepEqual(cal.manual, []);
    assert.equal(cal.holidays.filter((d) => d === '2026-12-25').length, 1, 'and is not duplicated');
  });

  it('purges an elapsed ad-hoc closure too', () => {
    const mh = { ...MH, holidays: ['2026-03-02'] };
    const cal = buildMarketHolidayCalendar({ marketHours: mh, now: at('2026-08-05') });
    assert.ok(!cal.holidays.includes('2026-03-02'));
  });

  it('returns dates sorted with no duplicates', () => {
    const cal = buildMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05') });
    assert.deepEqual(cal.holidays, [...cal.holidays].sort());
    assert.equal(new Set(cal.holidays).size, cal.holidays.length);
  });
});

describe('syncMarketHolidayCalendar', () => {
  const withTempFile = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'holiday-cal-'));
    try {
      fn(join(dir, 'market-holidays.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('creates the file, then reports no change on a second run', () => {
    withTempFile((path) => {
      const first = syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05'), path });
      assert.equal(first.changed, true);
      assert.equal(first.reason, 'created');
      assert.ok(existsSync(path));

      const second = syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05'), path });
      assert.equal(second.changed, false);
      assert.equal(second.reason, 'unchanged');
    });
  });

  it('reports what it added and purged when the year rolls', () => {
    withTempFile((path) => {
      syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-12-24'), path });

      // Christmas passes: it is purged, and nothing is added yet — 2028 only comes into range once
      // the current year is 2027, since coverage is always [currentYear, currentYear + 1].
      const rolled = syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-12-26'), path });
      assert.equal(rolled.changed, true);
      assert.deepEqual(rolled.removed, ['2026-12-25']);
      assert.deepEqual(rolled.added, []);

      // Crossing into 2027 pulls 2028 in, including the cross-year observed closure on 2027-12-31.
      const nextYear = syncMarketHolidayCalendar({ marketHours: MH, now: at('2027-01-05'), path });
      assert.equal(nextYear.changed, true);
      assert.ok(nextYear.added.includes('2028-01-17'));
      assert.ok(nextYear.added.includes('2027-12-31'));
      assert.deepEqual(nextYear.removed, ['2027-01-01'], 'and New Year is purged the day it passes');
    });
  });

  it('never writes an empty list over a good file', () => {
    withTempFile((path) => {
      syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05'), path });
      const good = JSON.parse(readFileSync(path, 'utf8')).holidays;
      assert.ok(good.length > 0);

      // yearsAhead: 0 with a date past the final holiday of the year generates nothing at all.
      // An empty file would read as "no holidays" to both PowerShell gates and open them on a
      // closed market, so the previous good file must survive untouched.
      const result = syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-12-26'), path, yearsAhead: 0 });
      assert.equal(result.changed, false);
      assert.equal(result.reason, 'generated_empty');
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).holidays, good);
    });
  });

  it('treats an unreadable file as absent rather than throwing', () => {
    withTempFile((path) => {
      writeFileSync(path, '{ this is not json');
      const result = syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05'), path });
      assert.equal(result.changed, true);
      assert.ok(JSON.parse(readFileSync(path, 'utf8')).holidays.length > 0);
    });
  });

  it('writes a list PowerShell can consume as plain strings', () => {
    withTempFile((path) => {
      syncMarketHolidayCalendar({ marketHours: MH, now: at('2026-08-05'), path });
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(Array.isArray(doc.holidays));
      for (const d of doc.holidays) {
        assert.equal(typeof d, 'string');
        assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });
});
