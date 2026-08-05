/**
 * Safe process teardown for CLI commands and one-shot scripts.
 *
 * **Do not call `process.exit()` straight after doing work.** Verified on Windows 2026-08-05:
 * forcing a teardown while network I/O is still settling aborts Node with
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * and exit code 0xC0000409 (-1073740791). Reproduced 3/3 through `tv pine check`, whose
 * `pine.check()` POSTs to pine-facade.tradingview.com with `fetch()`. The failure is nasty because
 * the command does its job first: a correct JSON result reaches stdout and the crash happens during
 * exit, so the output looks perfect while the exit code is garbage. That is how it sat unnoticed —
 * only `tests/cli.test.js`, which asserts on the exit code, ever saw it.
 *
 * Isolated by experiment rather than guessed at. The trigger is the forced exit itself:
 *
 * | after `pine.check()`            | exit code | wall time |
 * |---------------------------------|-----------|-----------|
 * | `process.exit(0)`               | crash 2/2 | ~1270 ms  |
 * | set `exitCode`, drain naturally | 0 2/2     | ~720 ms   |
 * | `Connection: close` + exit      | crash 2/2 | ~1240 ms  |
 *
 * So draining is not a reluctant trade-off — it is both correct and ~500 ms faster, because the
 * process no longer waits on a teardown it is simultaneously aborting. Neither stdin nor CDP is
 * involved: `pine check --file` (no stdin) still crashes and `quote get` (CDP, no fetch) does not.
 *
 * The unref'd timer preserves the one thing the bare `process.exit()` was genuinely there for. An
 * open CDP socket keeps the event loop alive indefinitely, and eight leaked `backfill_trade_log`
 * processes once accumulated and starved a later run of a usable CDP session (see the backfill notes
 * in CLAUDE.md). `unref()` means the timer never delays a process that is already free to exit, and
 * anything still holding the loop after the grace period gets a forced exit — safely, since by then
 * any in-flight teardown has long since settled.
 */
export async function finishProcess(code = 0, { graceMs = 2000, closeCdp = true } = {}) {
  process.exitCode = code;

  if (closeCdp) {
    try {
      // Imported lazily so a script with no CDP involvement does not pull the connection module in
      // just to shut down, and so a missing/failed import can never block an exit.
      const { disconnect } = await import("./connection.js");
      await disconnect();
    } catch {
      /* never connected, already closed, or the module is unavailable — nothing to close */
    }
  }

  setTimeout(() => process.exit(code), graceMs).unref();
}
