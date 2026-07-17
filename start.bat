@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:: Batch Manager MATCH = IPhoneApp
title IPhoneApp Server
prompt $G
color 0B

:: --- Force Expo Go (NOT custom dev client) + tunnel for friends off Wi-Fi ---
set "CI="
set "EXPO_NO_TELEMETRY=1"
set "EXPO_NO_DOTENV="
set "PATH=%CD%\node_modules\.bin;%PATH%"

echo ============================================================
echo  IPhoneApp / Commander PRO
echo  Mode: TUNNEL + Expo Go  (friends outside your Wi-Fi)
echo ============================================================
echo.
echo  After "Tunnel ready", look for a line with:
echo     exp://....   or   a QR code
echo.
echo  Friend: open that link ONLY in the Expo Go app.
echo  Opening in Chrome/Safari causes:
echo    - runtime custom / redirect middleware errors
echo    - Must specify expo-platform header
echo  Those lines are noise if someone used a browser — ignore them
echo  if Expo Go already loaded the app.
echo ============================================================
echo.

:: Kill stale Metro
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":8081" ^| findstr "LISTENING"') do (
  echo Killing old PID %%P on 8081...
  taskkill /F /PID %%P >nul 2>&1
)

:: Wipe stale Expo cache that can force "runtime custom"
if exist ".expo\devices.json" del /q ".expo\devices.json" >nul 2>&1
if exist ".expo\settings.json" del /q ".expo\settings.json" >nul 2>&1

echo Starting Metro + tunnel (Expo Go)...
echo.

if exist "%ProgramFiles%\nodejs\npx.cmd" (
  call "%ProgramFiles%\nodejs\npx.cmd" --yes expo start --tunnel --go
) else if exist "%LocalAppData%\Programs\nodejs\npx.cmd" (
  call "%LocalAppData%\Programs\nodejs\npx.cmd" --yes expo start --tunnel --go
) else (
  call npx --yes expo start --tunnel --go
)

set "ERR=%ERRORLEVEL%"
echo.
echo Expo exited code %ERR%
if not "%ERR%"=="0" (
  echo Fix tips:
  echo   1. Open cmd in this folder and run:  npx expo login
  echo   2. npm install
  echo   3. Restart IPhoneApp in Batch Manager
)

echo %CMDCMDLINE% | find /I "/c" >nul
if errorlevel 1 pause
endlocal & exit /b %ERR%
