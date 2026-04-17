import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;
const EVAL_TIMEOUT = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT, options = {}) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;
  const pollInterval = options.pollInterval ?? POLL_INTERVAL;
  const evalTimeout = options.evalTimeout ?? EVAL_TIMEOUT;
  const evalFn = options.evalFn ?? evaluate;

  while (Date.now() - start < timeout) {
    const state = await withTimeout(evalFn(`
      (function() {
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        var barCount = -1;
        try {
          var bars = document.querySelectorAll('[class*="bar"]');
          barCount = bars.length;
        } catch {}

        var currentSymbol = '';
        try {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        } catch {}

        var currentResolution = '';
        try {
          currentResolution = window.TradingViewApi._activeChartWidgetWV.value().resolution() || '';
        } catch {}

        return {
          isLoading: !!isLoading,
          barCount: barCount,
          currentSymbol: currentSymbol,
          currentResolution: String(currentResolution || '')
        };
      })()
    `), evalTimeout);

    if (!state) {
      stableCount = 0;
      await sleep(pollInterval);
      continue;
    }

    if (state.isLoading) {
      stableCount = 0;
      await sleep(pollInterval);
      continue;
    }

    if (expectedSymbol && state.currentSymbol && !state.currentSymbol.toUpperCase().includes(String(expectedSymbol).toUpperCase())) {
      stableCount = 0;
      await sleep(pollInterval);
      continue;
    }

    if (expectedTf && state.currentResolution && String(state.currentResolution) !== String(expectedTf)) {
      stableCount = 0;
      await sleep(pollInterval);
      continue;
    }

    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await sleep(pollInterval);
  }

  return false;
}
