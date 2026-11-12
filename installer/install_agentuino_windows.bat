@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

echo ================================
echo Agentuino Extension Installer
echo ================================
echo.

set "EXTENSIONS_DIR=%USERPROFILE%\.arduinoIDE\extensions"
set "DEPLOYED_DIR=%USERPROFILE%\.arduinoIDE\deployedPlugins"
set "SCRIPT_DIR=%~dp0"

REM Find VSIX file (versioned or not), newest name first
set "VSIX_FILE="
if exist "%SCRIPT_DIR%agentuino.vsix" (
    set "VSIX_FILE=%SCRIPT_DIR%agentuino.vsix"
) else (
    for /f "delims=" %%i in ('dir /b /o-n "%SCRIPT_DIR%agentuino-*.vsix" 2^>nul') do (
        set "VSIX_FILE=%SCRIPT_DIR%%%i"
        goto :found
    )
)
:found

if not defined VSIX_FILE (
    echo [Error] No agentuino*.vsix file found in folder:
    echo %SCRIPT_DIR%
    echo.
    echo Looking for: agentuino.vsix or agentuino-*.vsix
    echo Please put the file in the same folder as this installer.
    echo.
    pause
    exit /b 1
)

for %%F in ("%VSIX_FILE%") do set "VSIX_FILENAME=%%~nxF"
echo Found: %VSIX_FILENAME%
echo.

if not exist "%EXTENSIONS_DIR%" (
    echo Creating extension directory...
    mkdir "%EXTENSIONS_DIR%"
)

REM Remove old versions, the IDE would otherwise keep the old unpacked copy
echo Cleaning up old installations...
del /q "%EXTENSIONS_DIR%\agentuino*.vsix" 2>nul
for /d %%D in ("%DEPLOYED_DIR%\agentuino*") do (
    echo Removing old deployed extension: %%~nxD
    rmdir /s /q "%%D"
)

echo Installing Agentuino extension...
copy "%VSIX_FILE%" "%EXTENSIONS_DIR%\" >nul

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [Success] Extension installed successfully!
    echo.
    echo File: %VSIX_FILENAME%
    echo Location: %EXTENSIONS_DIR%
    echo.
    echo Restart the Arduino IDE to use Agentuino.
    echo Your agentuino project folders in the sketches are not touched.
) else (
    echo.
    echo [Error] Installation failed
)

echo.
pause
