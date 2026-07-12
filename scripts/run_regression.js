import { runRegression } from '../src/core/regression.js';

try {
  const result = await runRegression();
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`Regression ${result.formattedCheckedAt} ET — ${status} (${result.checksPassed}/${result.checksTotal} checks)`);
  if (result.failures.length) {
    for (const f of result.failures) console.log(`  - ${f}`);
  }
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}
