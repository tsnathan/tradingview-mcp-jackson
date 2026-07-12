/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';

// Map internal timeframe strings to TradingView resolution strings for the REST API.
function toResolution(timeframe) {
  const tf = String(timeframe || '60');
  if (tf === 'D') return '1D';
  if (tf === 'W') return '1W';
  if (tf === 'M') return '1M';
  return tf; // '15', '60', '240', etc. are already correct
}

export async function create({ condition = 'crossing', price, message, symbol, timeframe }) {
  const resolution = toResolution(timeframe || '60');

  const result = await evaluateAsync(`
    (async function() {
      try {
        var encodedSymbol = null;

        // Try to build the encoded symbol from the active chart's symbolExt()
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var info = chart.symbolExt();
          var proName = info.pro_name || info.symbol || '';
          var providedSym = ${JSON.stringify(symbol || '')};

          // Accept the chart's symbol if it matches what we want (or no symbol was provided)
          if (!providedSym || proName.toUpperCase().includes(providedSym.split(':').pop().toUpperCase())) {
            var adj = info.adjustment || 'splits';
            var cur = info['currency-id'] || info.currency_id || info.currencyId || 'USD';
            encodedSymbol = '=' + JSON.stringify({ symbol: proName, adjustment: adj, 'currency-id': cur });
          }
        } catch(e) {}

        // Fallback: build a minimal encoded symbol from the provided symbol string
        if (!encodedSymbol && ${JSON.stringify(symbol || '')}) {
          encodedSymbol = '=' + JSON.stringify({ symbol: ${JSON.stringify(symbol || '')}, adjustment: 'splits', 'currency-id': 'USD' });
        }

        if (!encodedSymbol) {
          return { success: false, error: 'Could not resolve encoded symbol for alert creation' };
        }

        var payload = {
          symbol: encodedSymbol,
          resolution: ${JSON.stringify(resolution)},
          type: ${JSON.stringify(condition || 'crossing')},
          value: ${price},
          message: ${JSON.stringify(message || '')},
          email: false,
          popup: true,
        };

        var resp = await fetch('https://pricealerts.tradingview.com/create_alert', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });

        var data = await resp.json();
        return { success: data.s === 'ok', alert_id: (data.r && data.r.alert_id) || null, raw: data };
      } catch(e) {
        return { success: false, error: e.message };
      }
    })()
  `);

  return {
    success: result?.success === true,
    price,
    condition,
    message: message || '(none)',
    alert_id: result?.alert_id || null,
    error: result?.error || null,
    source: 'rest_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include', signal: AbortSignal.timeout(10000) })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
