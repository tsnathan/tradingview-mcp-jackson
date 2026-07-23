/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import * as ui from './ui.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findWatchlistToggleButtonSelector() {
  return [
    '[data-name="base-watchlist-widget-button"]',
    '[data-name="watchlists-button"]',
    '[data-name="watchlist-button"]',
    '[aria-label*="Watchlists"]',
    '[aria-label*="Watchlist"]',
    '[title*="Watchlists"]',
    '[title*="Watchlist"]',
  ];
}

async function ensurePanelOpen() {
  const panelState = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="base-watchlist-widget-button"]',
        '[data-name="watchlists-button"]',
        '[data-name="watchlist-button"]',
        '[aria-label*="Watchlists"]',
        '[aria-label*="Watchlist"]',
        '[title*="Watchlists"]',
        '[title*="Watchlist"]'
      ];
      var btn = selectors.map(function(sel) { return document.querySelector(sel); }).find(function(el) { return el; });
      if (!btn) {
        btn = Array.from(document.querySelectorAll('button,div,span,a')).find(function(el) {
          var text = (el.textContent || '').trim();
          return /^Watchlists?$/.test(text);
        });
      }
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
      var selectors = [
        '[data-name="base-watchlist-widget-button"]',
        '[data-name="watchlists-button"]',
        '[data-name="watchlist-button"]',
        '[aria-label*="Watchlists"]',
        '[aria-label*="Watchlist"]',
        '[title*="Watchlists"]',
        '[title*="Watchlist"]'
      ];
      var btn = selectors.map(function(sel) { return document.querySelector(sel); }).find(function(el) { return el; });
      function getText(node) {
        return node && node.textContent ? String(node.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }
      var text = btn ? getText(btn) : '';
      if (!text) {
        var fallback = Array.from(document.querySelectorAll('button,div,span,a')).find(function(el) {
          var t = getText(el);
          return /^Watchlists?\s*[:\-]?\s*(.+)$/i.test(t);
        });
        if (fallback) {
          var match = getText(fallback).match(/^Watchlists?\s*[:\-]?\s*(.+)$/i);
          text = match ? match[1] : getText(fallback);
        }
      }
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

  // Atomic open→wait→click in ONE page-side async call. The legacy flow below spreads the
  // button click, the render wait, and the item match across separate CDP round-trips, and
  // the dropdown's open/closed state gets lost between them (toggle collisions) — that
  // failure mode silently froze watchlist membership at the baseline's stored lists (Issue 9).
  const atomic = await evaluateAsync(`
    (async function() {
      function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
      var wanted = ${JSON.stringify(wantedLower)};
      function normName(t) {
        return String(t || '').toLowerCase()
          .replace(/minutes?/g, 'm').replace(/mins?/g, 'm')
          .replace(/hours?/g, 'h').replace(/hrs?/g, 'h')
          .replace(/days?/g, 'd').replace(/daily/g, 'd')
          .replace(/[^a-z0-9]/g, '');
      }
      var wantedNorm = normName(wanted);
      function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent !== null) return true;
        try { return !!(el.getClientRects && el.getClientRects().length > 0); } catch (e) { return false; }
      }
      function getText(n) { return (n && n.textContent ? n.textContent : '').trim().replace(/\\s+/g, ' '); }
      function findItem() {
        var candidates = Array.from(document.querySelectorAll(
          '[role="menuitem"], [role="option"], ' +
          '[class*="menu"] span, [class*="menu"] div, [class*="menu"] a, [class*="menu"] li, ' +
          '[class*="popup"] span, [class*="popup"] div, [class*="dropdown"] span, [class*="dropdown"] div'
        ));
        var exact = [];
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          if (!isVisible(el)) continue;
          var t = getText(el);
          if (!t || t.length > 60) continue;
          if (t.toLowerCase() === wanted || normName(t) === wantedNorm) exact.push({ el: el, t: t });
        }
        if (exact.length === 0) return null;
        exact.sort(function(a, b) { return a.t.length - b.t.length; });
        return exact[0];
      }
      function rectOf(el) {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      // Synthetic MouseEvents do NOT activate TradingView's React list items (verified live) —
      // return the item's viewport coordinates instead so the caller can deliver a REAL mouse
      // click via CDP Input, the same approach that works for the Pine Editor buttons.
      // If the item is already visible (menu left open by an earlier attempt), use it directly —
      // clicking the toggle button first would close the menu.
      var pre = findItem();
      if (pre) { var pr = rectOf(pre.el); return { found: true, selected: pre.t, mode: 'atomic_preopen', x: pr.x, y: pr.y }; }
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[data-name="watchlists-button"]')
        || document.querySelector('[data-name="watchlist-button"]');
      if (!btn) return { found: false, error: 'watchlist button not found' };
      btn.click();
      for (var p = 0; p < 25; p++) {
        await sleep(120);
        var item = findItem();
        if (item) { var ir = rectOf(item.el); return { found: true, selected: item.t, mode: 'atomic', x: ir.x, y: ir.y }; }
      }
      // Close the dropdown we opened so it doesn't block later UI automation.
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
      return { found: false, error: 'item not found after opening menu' };
    })()
  `);
  if (atomic?.found && Number.isFinite(atomic.x) && Number.isFinite(atomic.y)) {
    await ui.mouseClick({ x: atomic.x, y: atomic.y });
    let activeAtomic = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(350);
      activeAtomic = await getActiveName();
      if (activeAtomic?.name && normalizeWatchlistName(activeAtomic.name) === wantedNormalized) {
        return { success: true, name: activeAtomic.name, changed: true };
      }
    }
    throw new Error(`Watchlist selection did not stick: ${name}`);
  }

  // The dropdown only shows "Recently used" lists — anything else lives behind the
  // "Open list…" dialog (Shift+W). Its "Search lists" input is auto-focused on open, so:
  // type the name (CDP insertText), ArrowDown to highlight the first match, Enter to
  // activate. The dialog's rows do NOT respond to coordinate clicks — synthetic or real
  // CDP mouse input alike (verified live 2026-07-23) — the keyboard path is the only
  // automation that reliably switches lists from this dialog.
  await ui.keyboard({ key: 'Escape' }).catch(() => null);
  await delay(250);
  await ui.keyboard({ key: 'W', modifiers: ['shift'] }).catch(() => null);
  await delay(900);
  const dialogReady = await evaluate(`
    (function() {
      var ae = document.activeElement;
      return { focusedSearch: !!(ae && ae.tagName === 'INPUT' && /search/i.test(ae.placeholder || '')) };
    })()
  `).catch(() => null);
  if (dialogReady?.focusedSearch) {
    const c = await getClient();
    await c.Input.insertText({ text: wantedName });
    await delay(600);
    await ui.keyboard({ key: 'ArrowDown' }).catch(() => null);
    await delay(250);
    await ui.keyboard({ key: 'Enter' }).catch(() => null);
    let activeDialog = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(350);
      activeDialog = await getActiveName();
      if (activeDialog?.name && normalizeWatchlistName(activeDialog.name) === wantedNormalized) {
        return { success: true, name: activeDialog.name, changed: true };
      }
    }
  }
  // Close any dialog we left open before falling through to the legacy flow.
  await ui.keyboard({ key: 'Escape' }).catch(() => null);

  const opened = await evaluate(`
    (function() {
      // base-watchlist-widget-button must be FIRST — it's the button that actually opens the
      // list-picker dropdown in current TradingView builds. Without it the aria-label/title
      // fallbacks click a different element, no dropdown appears, and every select fails —
      // which silently froze watchlist membership at the baseline's stored lists (Issue 9).
      var selectors = [
        '[data-name="base-watchlist-widget-button"]',
        '[data-name="watchlists-button"]',
        '[data-name="watchlist-button"]',
        '[aria-label*="Watchlists"]',
        '[aria-label*="Watchlist"]',
        '[title*="Watchlists"]',
        '[title*="Watchlist"]'
      ];
      var btn = selectors.map(function(sel) { return document.querySelector(sel); }).find(function(el) { return el; });
      if (!btn) {
        btn = Array.from(document.querySelectorAll('button,div,span,a')).find(function(el) {
          var text = (el.textContent || '').trim();
          return /^Watchlists?$/.test(text) || /^Watchlist$/.test(text);
        });
      }
      if (!btn) return { found: false };
      try {
        btn.click();
      } catch (e) {
        try {
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (e2) {}
      }
      return { found: true };
    })()
  `);
  if (!opened?.found) throw new Error('Watchlists selector button not found');

  // Poll for the dropdown overlay to appear (up to ~1.6s, 200ms intervals).
  // A fixed 400ms often fires before TradingView's React UI finishes rendering.
  let overlayVisible = false;
  for (let p = 0; p < 8; p++) {
    await delay(200);
    const check = await evaluate(`
      (function() {
        function isVisible(el) {
          if (!el) return false;
          if (el.offsetParent !== null) return true;
          try { return !!(el.getClientRects && el.getClientRects().length > 0); } catch (e) { return false; }
        }
        var roots = Array.from(document.querySelectorAll(
          '[role="dialog"],[role="listbox"],[class*="menu"],[class*="popup"],[class*="overlay"],[class*="dropdown"]'
        )).filter(function(el) { return el && isVisible(el); });
        return { open: roots.some(function(r) { return r.children.length > 2; }) };
      })()
    `);
    if (check?.open) { overlayVisible = true; break; }
  }

  // If the overlay never appeared the first click may have closed the panel
  // (toggle collision). Re-open the panel and click once more.
  if (!overlayVisible) {
    await ensurePanelOpen();
    await evaluate(`
      (function() {
        var selectors = [
          '[data-name="base-watchlist-widget-button"]',
          '[data-name="watchlists-button"]',
          '[data-name="watchlist-button"]',
          '[aria-label*="Watchlists"]',
          '[aria-label*="Watchlist"]',
          '[title*="Watchlists"]',
          '[title*="Watchlist"]'
        ];
        var btn = selectors.map(function(sel) { return document.querySelector(sel); }).find(function(el) { return el; });
        if (!btn) {
          btn = Array.from(document.querySelectorAll('button,div,span,a')).find(function(el) {
            var text = (el.textContent || '').trim();
            return /^Watchlists?$/.test(text) || /^Watchlist$/.test(text);
          });
        }
        if (!btn) return;
        try { btn.click(); } catch (e) {
          try {
            ['pointerdown','mousedown','mouseup','click'].forEach(function(type) {
              btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
          } catch (e2) {}
        }
      })()
    `);
    await delay(700);
  }

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
        var clickable = node.closest('[role="menuitem"], [role="option"], button, [data-name], li, a, div, span') || node;
        try { clickable.scrollIntoView({ block: 'center' }); } catch (e) {}
        try {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function(type) {
            clickable.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
          });
        } catch (e) {
          try { clickable.click(); } catch (e2) { return false; }
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
        var candidates = Array.from(scope.querySelectorAll('[role="menuitem"], [role="option"], button, li, a, div, span'));
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

      function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent !== null) return true;
        try {
          return !!(el.getClientRects && el.getClientRects().length > 0);
        } catch (e) {
          return false;
        }
      }

      function findWatchlistOverlayRoots() {
        var roots = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="menu"], [class*="popup"], [data-name*="menu"], [data-name*="popup"], [class*="overlay"], [class*="panel"], [class*="dropdown"], [aria-label*="watchlist"], [aria-labelledby*="watchlist"]'));
        return roots.filter(function(el) { return el && isVisible(el); });
      }

      var overlayRoots = findWatchlistOverlayRoots();
      for (var r = 0; r < overlayRoots.length; r++) {
        var direct = findMatch(overlayRoots[r]);
        if (direct) return direct;
      }

      for (var r = 0; r < overlayRoots.length; r++) {
        searchFullList(overlayRoots[r]);
      }
      overlayRoots = findWatchlistOverlayRoots();
      for (var r = 0; r < overlayRoots.length; r++) {
        var filtered = findMatch(overlayRoots[r]);
        if (filtered) return filtered;
      }
      // Try again with any visible root in case the dropdown was rendered outside the original overlay set.
      var fallbackRoots = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="menu"], [class*="popup"], [data-name*="menu"], [data-name*="popup"], [class*="overlay"], [class*="panel"], [class*="dropdown"], [aria-label*="watchlist"], [aria-labelledby*="watchlist"]')).filter(function(el) { return el && isVisible(el); });
      for (var r = 0; r < fallbackRoots.length; r++) {
        var filtered = findMatch(fallbackRoots[r]);
        if (filtered) return filtered;
      }

      var fallbackRoots = Array.from(document.querySelectorAll('button, li, a, div, span'));
      for (var k = 0; k < fallbackRoots.length; k++) {
        var item = fallbackRoots[k];
        var text = getText(item);
        var textNorm = norm(text);
        if (!text || text.length > 100) continue;
        if (text.toLowerCase() === wanted || textNorm === wantedNorm || textNorm.includes(wantedNorm)) {
          if (clickNode(item)) return { found: true, selected: text, mode: 'fallback' };
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

export async function getWatchlistOptions() {
  await ensurePanelOpen();
  const result = await evaluate(`
    (function() {
      function text(node) {
        return node && node.textContent ? String(node.textContent || '').trim().replace(/\s+/g, ' ') : '';
      }

      function normalize(text) {
        return String(text || '').trim();
      }

      var activeBtn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[data-name="watchlists-button"]')
        || document.querySelector('[data-name="watchlist-button"]')
        || document.querySelector('[aria-label*="Watchlists"]')
        || document.querySelector('[aria-label*="Watchlist"]')
        || document.querySelector('[title*="Watchlists"]')
        || document.querySelector('[title*="Watchlist"]');
      var activeName = text(activeBtn);
      if (activeBtn) {
        try { activeBtn.click(); } catch (e) {}
      }

      function isVisible(el) {
        if (!el) return false;
        if (el.offsetParent !== null) return true;
        try { return !!(el.getClientRects && el.getClientRects().length > 0); } catch (e) { return false; }
      }
      var roots = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [class*="menu"], [class*="popup"], [data-name*="menu"], [data-name*="popup"], [class*="overlay"], [class*="panel"], [class*="dropdown"], [aria-label*="watchlist"], [aria-labelledby*="watchlist"]'));
      var candidates = [];
      roots.forEach(function(root) {
        if (!root || !isVisible(root)) return;
        var items = Array.from(root.querySelectorAll('button, div, span, li, a'));
        items.forEach(function(item) {
          var t = text(item);
          if (!t) return;
          if (t.length > 2 && t.length < 100 && /[A-Za-z0-9]/.test(t)) {
            candidates.push(t);
          }
        });
      });

      var options = Array.from(new Set(candidates)).map(function(opt) { return normalize(opt); }).filter(Boolean);
      return { activeName, options };
      return { activeName, options };
    })()
  `);

  return { success: true, options: result?.options || [], activeName: result?.activeName || null };
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
