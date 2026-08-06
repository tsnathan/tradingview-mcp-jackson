import { readFileSync } from "node:fs";

/**
 * BOM-tolerant JSON reading.
 *
 * Any JSON file in this project can pick up a UTF-8 BOM. PowerShell is the source: `Out-File`,
 * `Set-Content` and `>` redirects all emit one by default on this machine (see CLAUDE.md's
 * PowerShell notes), so a hand-edit, a `ConvertTo-Json` round-trip, or a backup/restore through
 * PowerShell is enough to add one to a file Node wrote cleanly.
 *
 * The failure is silent and looks exactly like "nothing happened":
 *   - `readFileSync(p, 'utf8')` does NOT strip the BOM, and `JSON.parse` throws on it.
 *   - Every reader here wraps that parse in a `try { } catch { return fallback }`, so an
 *     unreadable file degrades to an empty object — an empty dashboard is indistinguishable
 *     from a genuinely quiet market.
 *   - `require()` of a `.json` path DOES strip it, so the same bytes parse fine in a quick
 *     `node -e "require('./status/...')"` check while the running server fails on them. That
 *     mismatch is what makes this cost a debugging cycle; it did on 2026-08-06, when a BOM on
 *     `status/latest-signal-status.json` blanked the Open Trades card while all 86 open trades
 *     sat intact in the file.
 *
 * Strip on READ rather than normalizing files on write: the BOM is introduced by PowerShell
 * writers outside this codebase (the two watchdog scripts, plus any manual edit), so a
 * write-side fix cannot cover the paths that actually cause it.
 */
export function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse that tolerates a leading UTF-8 BOM. Throws on genuinely malformed JSON. */
export function parseJsonText(text) {
  return JSON.parse(stripBom(text));
}

/** readFileSync + parseJsonText. Throws if the file is missing or malformed. */
export function readJsonFile(filePath) {
  return parseJsonText(readFileSync(filePath, "utf8"));
}
