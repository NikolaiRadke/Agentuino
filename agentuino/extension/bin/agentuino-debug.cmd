@echo off
rem Agentuino: debug the sketch with ArduDebug (breakpoints, variables).
rem Runs debug-run.js with the Node runtime of the Arduino IDE (AGENTUINO_NODE).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if "%AGENTUINO_NODE%"=="" (set "AGENTUINO_NODE=node")
"%AGENTUINO_NODE%" "%~dp0debug-run.js" %*
