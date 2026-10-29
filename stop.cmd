@echo off
cd /d "%~dp0"
if not exist director.pid (
  echo [director] not running
  exit /b 0
)
set /p PID=<director.pid
taskkill /f /pid %PID% >nul 2>&1
del /q director.pid >nul 2>&1
echo [director] stopped
