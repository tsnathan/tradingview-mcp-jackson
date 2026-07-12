@echo off
setlocal

set "PROJECT_DIR=C:\Users\tsnat\tradingview-mcp-jackson"
set "PORT=3030"
set "URL=http://127.0.0.1:%PORT%/"
cd /d "%PROJECT_DIR%"

echo Checking dashboard at %URL%
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"
if %ERRORLEVEL% == 0 (
  echo Dashboard already running.
  start "" "%URL%"
  exit /b 0
)

echo Dashboard is not reachable. Syncing watchlists first...
cd /d "%PROJECT_DIR%"
node src/cli/index.js watchlist sync
if %ERRORLEVEL% NEQ 0 (
  echo Warning: watchlist sync failed, continuing to start dashboard.
)
echo Starting dashboard server...
start "Signal Dashboard" /d "%PROJECT_DIR%" cmd /k "npm run dashboard"
timeout /t 3 >nul
echo Opening dashboard page...
start "" "%URL%"
endlocal
