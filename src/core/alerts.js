/**
 * Core alert logic.
 *
 * The create/delete request schema below was reverse-engineered by capturing the real HTTP
 * traffic TradingView's own UI sends (CDP Network.requestWillBeSent on the Desktop app while
 * manually creating + deleting an alert, 2026-07-23) — the previously-shipped schema (flat
 * {symbol, resolution, type, value, message, email, popup}) always returned
 * {"s":"error","err":{"code":"invalid_request"}}. Two things were wrong: the endpoint wants a
 * `{"payload": {...}}` wrapper with a `conditions` array (not a flat `type`/`value` pair), and the
 * encoded symbol string needs a `session` key — omitting it was silently accepted by the encoder
 * but rejected server-side. Verified live end-to-end (create -> parse alert_id -> delete) against
 * pricealerts.tradingview.com, both returning HTTP 200 with `{"s":"ok",...}`.
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

// Only 'cross' has been verified against the live endpoint (it fires once regardless of
// approach direction, which is what stop/target level alerts need anyway). 'greater'/'less' are
// best-effort guesses based on TradingView's known alert-type vocabulary and are NOT confirmed —
// verify before relying on them for a one-directional alert.
function toConditionType(condition) {
  const c = String(condition || 'crossing').toLowerCase();
  if (c === 'greater_than' || c === 'greater') return 'greater';
  if (c === 'less_than' || c === 'less') return 'less';
  return 'cross';
}

export async function create({ condition = 'crossing', price, message, symbol, timeframe }) {
  const resolution = toResolution(timeframe || '60');
  const conditionType = toConditionType(condition);

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
            var sess = info.session || 'extended';
            encodedSymbol = '=' + JSON.stringify({ adjustment: adj, 'currency-id': cur, session: sess, symbol: proName });
          }
        } catch(e) {}

        // Fallback: build a minimal encoded symbol from the provided symbol string
        if (!encodedSymbol && ${JSON.stringify(symbol || '')}) {
          encodedSymbol = '=' + JSON.stringify({ adjustment: 'splits', 'currency-id': 'USD', session: 'extended', symbol: ${JSON.stringify(symbol || '')} });
        }

        if (!encodedSymbol) {
          return { success: false, error: 'Could not resolve encoded symbol for alert creation' };
        }

        var expiration = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

        var payload = {
          payload: {
            conditions: [{
              type: ${JSON.stringify(conditionType)},
              frequency: 'on_first_fire',
              series: [{ type: 'barset' }, { type: 'value', value: ${price} }],
              resolution: ${JSON.stringify(resolution)},
            }],
            symbol: encodedSymbol,
            resolution: ${JSON.stringify(resolution)},
            message: ${JSON.stringify(message || '')},
            sound_file: 'alert/fired',
            sound_duration: 3,
            popup: true,
            auto_deactivate: true,
            email: false,
            sms_over_email: false,
            mobile_push: false,
            web_hook: null,
            name: null,
            expiration: expiration,
            active: true,
            ignore_warnings: true,
          },
        };

        var resp = await fetch('https://pricealerts.tradingview.com/create_alert', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
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
    error: result?.error || (result?.success === false ? (result?.raw?.err?.code || 'unknown error') : null),
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

export async function deleteAlerts({ alert_ids, delete_all } = {}) {
  const ids = Array.isArray(alert_ids) ? alert_ids.map(Number).filter(Number.isFinite) : [];

  if (ids.length > 0) {
    const result = await evaluateAsync(`
      (async function() {
        try {
          var resp = await fetch('https://pricealerts.tradingview.com/delete_alerts', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }),
            signal: AbortSignal.timeout(10000),
          });
          var data = await resp.json();
          return { success: data.s === 'ok', raw: data };
        } catch(e) {
          return { success: false, error: e.message };
        }
      })()
    `);
    return {
      success: result?.success === true,
      deleted_ids: result?.success ? ids : [],
      error: result?.error || (result?.success === false ? (result?.raw?.err?.code || 'unknown error') : null),
      source: 'rest_api',
    };
  }

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
  throw new Error('deleteAlerts requires alert_ids (array of TradingView alert ids) or delete_all: true.');
}
