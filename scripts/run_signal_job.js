import { runSignalJob } from '../src/core/morning.js';

const notify = process.argv.includes('--notify');
const all = process.argv.includes('--all');

try {
  const result = await runSignalJob({
    changed_only: !all,
    notify,
  });

  if (result.skipped) {
    console.log(result.reason || 'No signal');
    process.exit(0);
  }

  if ((result.signal_lines || []).length > 0) {
    console.log(result.signal_lines.join('\n'));
  } else {
    console.log(result.summary_line || 'NO SIGNAL');
  }

  process.exit(0);
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
