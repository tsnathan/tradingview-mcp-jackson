#!/usr/bin/env node
/**
 * Rolls status/market-holidays.json: computed NYSE holidays for the current and next year, purged
 * of past dates, plus any ad-hoc closures listed in rules.json market_hours.holidays.
 *
 * The scan job already does this on every run (see runSignalJob), so this script is for seeding the
 * file before the first scan, inspecting what would change, and checking a future date by hand.
 *
 *   node scripts/roll_holidays.js                  # roll now
 *   node scripts/roll_holidays.js --dry-run        # show what would change, write nothing
 *   node scripts/roll_holidays.js --as-of 2027-12-28   # pretend it is that date (implies --dry-run)
 *   node scripts/roll_holidays.js --years 3        # generate further ahead than the default 1
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMarketHolidayCalendar,
  syncMarketHolidayCalendar,
  MARKET_HOLIDAY_CALENDAR_PATH,
} from '../src/core/morning.js';
import { readJsonFile } from '../src/json_file.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const asOf = arg('as-of');
// --as-of forces a dry run: writing a calendar purged relative to a pretend date would drop
// holidays that have not actually happened yet, and the file feeds two live market-hours gates.
const dryRun = hasFlag('dry-run') || Boolean(asOf);
const yearsAhead = Number(arg('years') ?? 1);

if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`--as-of expects yyyy-mm-dd, got "${asOf}"`);
  process.exit(1);
}
if (!Number.isInteger(yearsAhead) || yearsAhead < 0 || yearsAhead > 20) {
  console.error('--years expects an integer between 0 and 20');
  process.exit(1);
}

let marketHours = { timezone: 'America/New_York', holidays: [] };
const rulesPath = join(ROOT, 'rules.json');
if (existsSync(rulesPath)) {
  try {
    const rules = readJsonFile(rulesPath);
    if (rules.market_hours) marketHours = rules.market_hours;
  } catch (error) {
    console.error(`Could not read rules.json (${error.message}) — using defaults.`);
  }
}

// Noon UTC keeps the ET calendar date unambiguous for any --as-of value.
const now = asOf ? new Date(`${asOf}T17:00:00.000Z`) : new Date();

const built = buildMarketHolidayCalendar({ marketHours, now, yearsAhead });
console.log(`Today (${built.timezone}): ${built.today}`);
console.log(`Covering years: ${built.coversYears.join('-')}`);
console.log(`Holidays (${built.holidays.length}):`);
for (const date of built.holidays) {
  const label = built.manual.includes(date) ? '  (manual extra)' : '';
  console.log(`  ${date}${label}`);
}

if (dryRun) {
  const existing = existsSync(MARKET_HOLIDAY_CALENDAR_PATH)
    ? readJsonFile(MARKET_HOLIDAY_CALENDAR_PATH).holidays ?? []
    : [];
  const added = built.holidays.filter((d) => !existing.includes(d));
  const removed = existing.filter((d) => !built.holidays.includes(d));
  console.log('\nDry run — nothing written.');
  console.log(`  would add:    ${added.length ? added.join(', ') : '(none)'}`);
  console.log(`  would purge:  ${removed.length ? removed.join(', ') : '(none)'}`);
  process.exit(0);
}

const result = syncMarketHolidayCalendar({ marketHours, now, yearsAhead });
if (!result.changed) {
  console.log(`\nNo change (${result.reason}).`);
} else {
  console.log(`\nWrote ${MARKET_HOLIDAY_CALENDAR_PATH} (${result.reason}).`);
  if (result.added.length) console.log(`  added:  ${result.added.join(', ')}`);
  if (result.removed.length) console.log(`  purged: ${result.removed.join(', ')}`);
}
