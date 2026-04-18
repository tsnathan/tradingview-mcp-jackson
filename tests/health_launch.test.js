import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureTradingViewConnection } from '../src/core/morning.js';
import { buildTradingViewLaunchPlan } from '../src/core/health.js';

describe('TradingView auto-launch', () => {
  it('retries the connection after launching TradingView', async () => {
    let launched = false;
    let attempts = 0;

    const result = await ensureTradingViewConnection({
      getStateFn: async () => {
        attempts += 1;
        if (!launched) {
          throw new Error('fetch failed');
        }
        return { ok: true };
      },
      launchFn: async () => {
        launched = true;
        return { success: true };
      },
      waitMs: 0,
    });

    assert.equal(result.connected, true);
    assert.equal(result.launched, true);
    assert.equal(attempts, 2);
  });

  it('uses the Windows helper launcher for WindowsApps installs', () => {
    const plan = buildTradingViewLaunchPlan({
      platform: 'win32',
      tvPath: 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj\\TradingView.exe',
      cdpPort: 9222,
      projectRoot: process.cwd(),
    });

    assert.equal(plan.command, 'wscript.exe');
    assert.match(plan.args[0], /launch_tv_debug\.vbs$/i);
  });
});
