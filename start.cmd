@echo off
cd /d "%~dp0"
if exist director.pid (
  echo [director] already running - run stop.cmd first
  exit /b 1
)
start "" /min cmd /c "node director.mjs >> director.log 2>&1"
echo [director] started - log: %~dp0director.log
