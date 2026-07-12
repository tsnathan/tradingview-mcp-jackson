@echo off
setlocal

REM Replace this path if your repo is in a different folder.
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"
echo Syncing TradingView watchlists into the local baseline...
node src/cli/index.js watchlist sync
if %ERRORLEVEL% == 0 (
  echo Watchlist sync completed successfully.
) else (
  echo Watchlist sync failed with error code %ERRORLEVEL%.
)
endlocal
