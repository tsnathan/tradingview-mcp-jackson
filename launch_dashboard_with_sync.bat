@echo off
setlocal

REM Set this to the repository root folder where this project is located.
REM If you place this shortcut on the Desktop, leave it set to the repo path below.
set "PROJECT_DIR=C:\Users\tsnat\tradingview-mcp-jackson"
set "PORT=3030"
set "URL=http://127.0.0.1:%PORT%/"
cd /d "%PROJECT_DIR%"

echo Syncing TradingView watchlists into the local baseline...
node src/cli/index.js watchlist sync
if %ERRORLEVEL% == 0 (
  echo Watchlist sync completed successfully.
) else (
  echo Warning: watchlist sync failed with error code %ERRORLEVEL%.
)

echo Initializing TA metrics with a full signal scan...
npm run signals -- --all
if %ERRORLEVEL% == 0 (
  echo TA metrics init scan completed successfully.
) else (
  echo Warning: TA metrics init scan failed with error code %ERRORLEVEL%.
)

echo Starting dashboard server...
if not exist "%PROJECT_DIR%" (
  echo ERROR: Project directory not found: "%PROJECT_DIR%"
  pause
  exit /b 1
)
set "PORT_IN_USE=0"
for /f "delims=" %%P in ('powershell -NoProfile -Command "if (Test-NetConnection -ComputerName 127.0.0.1 -Port %PORT% -InformationLevel Quiet) { Write-Output '1' } else { Write-Output '0' }"') do set "PORT_IN_USE=%%P"
if "%PORT_IN_USE%" == "1" (
  echo Dashboard port %PORT% is already in use. Skipping server start.
) else (
  start "Signal Dashboard" /d "%PROJECT_DIR%" cmd /k "npm run dashboard"
  timeout /t 3 >nul
)
echo Opening dashboard page...
start "" "%URL%"
endlocal
