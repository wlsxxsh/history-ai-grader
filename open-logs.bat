@echo off
setlocal

set "ROOT=%~dp0"
set "LOGDIR=%ROOT%logs"

if not exist "%LOGDIR%" (
  echo Logs folder does not exist yet.
  pause
  exit /b 0
)

if exist "%LOGDIR%\backend.log" start "" notepad "%LOGDIR%\backend.log"
if exist "%LOGDIR%\frontend.log" start "" notepad "%LOGDIR%\frontend.log"

endlocal
