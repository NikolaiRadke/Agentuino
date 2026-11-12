@echo off
rem Agentuino: read the serial output of the board for a fixed time.
rem Runs serial-read.js with the Node runtime of the Arduino IDE (AGENTUINO_NODE).
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if "%AGENTUINO_NODE%"=="" (set "AGENTUINO_NODE=node")
"%AGENTUINO_NODE%" "%~dp0serial-read.js" %*
