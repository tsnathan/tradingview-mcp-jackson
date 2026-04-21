# Changelog

## 2026-04-20

### Fixed — Push notifications firing on every scan

**File:** `src/core/morning.js`

Notifications were firing on every 15-minute scan whenever any signal was open, not just when a new signal appeared for the first time. This was because the notification checked `signal_lines` (all open signals) instead of `changedSignals` (signals that are new or changed since the last scan).

- Added `changedSignalLines` built from `changedSignals` only
- Notification condition and body now use `changedSignalLines`
- A push is sent only when a signal is newly detected or its entry price/time has changed

### Fixed — Push notification body sent as file attachment

**File:** `src/core/morning.js`

The `fetch` call to ntfy was missing `Content-Type: text/plain`, causing ntfy to treat the message body as a binary file attachment instead of readable text.

- Added `'Content-Type': 'text/plain'` to the ntfy request headers

### Fixed — Scheduled task stopping at 1:02 PM ET

**File:** Windows Task Scheduler — `\TradingViewSignalScan15m`

The repeat duration was set to 6 hours 31 minutes (6:31 AM → 1:02 PM ET), missing the entire afternoon session. Changed to 9 hours 45 minutes so the task fires through 4:16 PM ET, covering the full regular session.

### Fixed — TradingView MSIX auto-launch not enabling debug port

**Files:** `scripts/launch_tv_debug.vbs`, `scripts/run_signal_job.ps1`

TradingView Desktop is installed as a Microsoft Store (MSIX) package. Direct exe launch and the `ELECTRON_EXTRA_LAUNCH_ARGS` environment variable both fail to enable the Chrome DevTools Protocol port for MSIX-activated apps because the Windows package activation broker does not pass environment variables from the calling process.

Working solution: use the `IApplicationActivationManager` COM interface (`ActivateApplication`) with `--remote-debugging-port=9222` passed as the arguments parameter. This correctly starts TradingView with CDP enabled on port 9222.

- Updated `launch_tv_debug.vbs` to scan `C:\Program Files\WindowsApps` for the TradingView exe instead of relying on a hardcoded shell path
- Updated `run_signal_job.ps1` with `Start-TradingViewWithDebug` function and improved `Get-TradingViewExe` to detect MSIX installs via `Get-AppxPackage` and WindowsApps glob
