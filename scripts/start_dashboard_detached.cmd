@echo off
REM Starts the signal dashboard server with stdout+stderr APPENDED to dashboard-server.log.
REM
REM This exists as a .cmd rather than living inline in dashboard_watchdog.ps1 because passing a
REM redirect through `Start-Process cmd.exe -ArgumentList '/c "..."'` depends on cmd's quote-
REM stripping rules, which proved unreliable here (cmd reported '"C"' is not recognized). A batch
REM file has no quoting layer to get wrong, and it can be run by hand to reproduce a startup
REM failure exactly as the watchdog sees it.
REM
REM Output must go to a FILE, never an inherited pipe: nothing would drain the pipe once the
REM launching process exits, and the server's next console.log would block its event loop forever.
REM See the /api/restart comment in serve_signal_status.js for the diagnosis of that failure.

setlocal
cd /d "%~dp0.."

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "scripts\serve_signal_status.js" >> "dashboard-server.log" 2>&1
