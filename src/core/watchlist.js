/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensurePanelOpen() {
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]')
        || document.querySelector('[aria-label*="Watchlist, details, and news"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var rightArea = document.querySelector('[class*="layout__area--right"]');
      var sidebarOpen = !!(rightArea && rightArea.offsetWidth > 50);
      if (!sidebarOpen) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await delay(400);
  return { success: true };
}

export async function getActiveName() {
  await ensurePanelOpen();
  const result = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { name: null };
      var text = (btn.textContent || '').trim();
      return { name: text || null };
    })()
  `);
  return { success: true, name: result?.name || null };
}

function normalizeWatchlistName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/minutes?/g, 'm')
    .replace(/mins?/g, 'm')
    .replace(/hours?/g, 'h')
    .replace(/hrs?/g, 'h')
    .replace(/days?/g, 'd')
    .replace(/daily/g, 'd')
    .replace(/[^a-z0-9]/g, '');
}

export async function select({ name }) {
  await ensurePanelOpen();
  const wantedName = String(name).trim();
  const wantedLower = wantedName.toLowerCase();
  const wantedNormalized = normalizeWatchlistName(wantedName);
  const current = await getActiveName();
  if (current?.name && normalizeWatchlistName(current.name) === wantedNormalized) {
    return { success: true, name: current.name, changed: false };
  }

  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="watchlists-button"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!opened?.found) throw new Error('Watchlists selector button not found');
  await delay(300);

  const selected = await evaluate(`
    (function() {
      var wanted = ${JSON.stringify(wantedLower)};
      function normName(text) {
        return String(text || '')
          .toLowerCase()
          .replace(/minutes?/g, 'm')
          .replace(/mins?/g, 'm')
          .replace(/hours?/g, 'h')
          .replace(/hrs?/g, 'h')
          .replace(/days?/g, 'd')
          .replace(/daily/g, 'd')
          .replace(/[^a-z0-9]/g, '');
      }
      var wantedNorm = normName(wanted);

      function getText(node) {
        return (node && node.textContent ? node.textContent : '').trim().replace(/\s+/g, ' ');
      }

      function norm(text) {
        return normName(text);
      }

      function clickNode(node) {
        if (!node) return false;
        var clickable = node.closest('.item-jFqVJoPk, .accessible-NQERJsv9, [role="menuitem"], [role="option"], button, [data-name]') || node;
        try { clickable.scrollIntoView({ block: 'center' }); } catch (e) {}
        try {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function(type) {
            clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          });
        } catch (e) {
          clickable.click();
        }
        return true;
      }

      function searchFullList(root) {
        var scope = root || document;
        var input = scope.querySelector('input[type="text"], input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]');
        if (!input) return false;
        try {
          input.focus();
          input.value = wanted;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch (e) {
          return false;
        }
      }

      function findMatch(root) {
        var scope = root || document;
        var candidates = Array.from(scope.querySelectorAll('.item-jFqVJoPk, .accessible-NQERJsv9, [role="menuitem"], [role="option"], button, div, span'));
        for (var i = 0; i < candidates.length; i++) {
          var text = getText(candidates[i]);
          var textNorm = norm(text);
          if (!text || text.length > 100) continue;
          if (text.toLowerCase() === wanted || textNorm === wantedNorm) {
            if (clickNode(candidates[i])) return { found: true, selected: text, mode: 'exact' };
          }
        }
        for (var j = 0; j < candidates.length; j++) {
          var txt = getText(candidates[j]);
          var txtNorm = norm(txt);
          if (!txt || txt.length > 100) continue;
          var looksLikeWatchlist = /swing|watch|list/i.test(txt);
          if (
            txt.toLowerCase().includes(wanted) ||
            txtNorm.includes(wantedNorm) ||
            (looksLikeWatchlist && txtNorm.length >= 6 && wantedNorm.includes(txtNorm))
          ) {
            if (clickNode(candidates[j])) return { found: true, selected: txt, mode: 'partial' };
          }
        }
        return null;
      }

      var overlayRoots = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="menu"], [class*="popup"], [data-name*="menu"], [data-name*="popup"]'));
      for (var r = 0; r < overlayRoots.length; r++) {
        var direct = findMatch(overlayRoots[r]);
        if (direct) return direct;
      }

      var openListNodes = Array.from(document.querySelectorAll('button, div, span')).filter(function(el) {
        return /open\s+li/i.test(getText(el));
      });
      if (openListNodes.length) {
        clickNode(openListNodes[0]);
        overlayRoots = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="menu"], [class*="popup"], [data-name*="menu"], [data-name*="popup"]'));
        for (var s = 0; s < overlayRoots.length; s++) {
          searchFullList(overlayRoots[s]);
        }
        for (var o = 0; o < overlayRoots.length; o++) {
          var openMatch = findMatch(overlayRoots[o]);
          if (openMatch) {
            openMatch.mode = 'open-list';
            return openMatch;
          }
        }
      }

      var containers = overlayRoots.filter(function(el) { return el && el.scrollHeight > el.clientHeight; });
      for (var c = 0; c < containers.length; c++) {
        var container = containers[c];
        var step = Math.max(80, Math.floor(container.clientHeight * 0.8));
        for (var pos = 0; pos <= container.scrollHeight; pos += step) {
          container.scrollTop = pos;
          var match = findMatch(container);
          if (match) {
            match.scrolled = true;
            return match;
          }
        }
      }

      return { found: false };
    })()
  `);

  if (!selected?.found) throw new Error('Could not select watchlist: ' + name);
  let active = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await delay(350);
    active = await getActiveName();
    if (active?.name && normalizeWatchlistName(active.name) === wantedNormalized) {
      return { success: true, name: active.name, changed: true };
    }
  }

  throw new Error(`Watchlist selection did not stick: ${name}`);
}

export async function get() {
  // Try internal API first — reads from the active watchlist widget
  const symbols = await evaluate(`
    (function() {
      // Method 1: Try the watchlist widget's internal data
      try {
        var rightArea = document.querySelector('[class*="layout__area--right"]');
        if (!rightArea || rightArea.offsetWidth < 50) return { symbols: [], source: 'panel_closed' };
      } catch(e) {}

      // Method 2: Read data-symbol-full attributes from watchlist rows
      var results = [];
      var seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };

      // Find all elements with symbol data attributes
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;

        // Find the row and extract price data
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var nums = [];
        for (var j = 0; j < cells.length; j++) {
          var t = cells[j].textContent.trim();
          if (t && /^[\\-+]?[\\d,]+\\.?\\d*%?$/.test(t.replace(/[\\s,]/g, ''))) nums.push(t);
        }
        results.push({ symbol: sym, last: nums[0] || null, change: nums[1] || null, change_percent: nums[2] || null });
      }

      if (results.length > 0) return { symbols: results, source: 'data_attributes' };

      // Method 3: Scan for ticker-like text in the right panel
      var items = container.querySelectorAll('[class*="symbolName"], [class*="tickerName"], [class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }

      return { symbols: results, source: results.length > 0 ? 'text_scan' : 'empty' };
    })()
  `);

  return {
    success: true,
    count: symbols?.symbols?.length || 0,
    source: symbols?.source || 'unknown',
    symbols: symbols?.symbols || [],
  };
}

export async function add({ symbol }) {
  const c = await getClient();
  await ensurePanelOpen();

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}
