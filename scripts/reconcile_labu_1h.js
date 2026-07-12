import { runBrief } from '../src/core/morning.js';

const targets = [{ watchlistName: 'Swing 1H', timeframe: '60', symbols: ['BATS:LABU'] }];

const result = await runBrief({
  scan_targets: targets,
  full_scan_targets: targets,
  signals_only: true,
  changed_only: false,
  update_baseline: true,
});

const scanned = Array.isArray(result.symbols_scanned) ? result.symbols_scanned : [];
const opens = Array.isArray(result.open_trades) ? result.open_trades : [];
const row = scanned.find((s) => String(s.symbol || '').toUpperCase().includes('LABU'));
const open = opens.find((t) => String(t.symbol || '').toUpperCase().includes('LABU'));

console.log('=== LABU 1H RECONCILIATION ===');
if (row) {
  console.log('Scan row:', JSON.stringify(row, null, 2));
} else {
  console.log('No scan row found for LABU');
}
if (open) {
  console.log('\nOpen trade:', JSON.stringify(open, null, 2));
} else {
  console.log('No open trade for LABU 1H');
}
console.log('\nSummary:', result.summary_line || '(none)');
