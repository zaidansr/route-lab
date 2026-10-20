@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 or newer and reopen your terminal.
  pause
  exit /b 1
)
node.exe "%~dp0cli.mjs" games %*
if errorlevel 1 pause
