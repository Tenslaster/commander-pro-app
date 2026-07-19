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
:: Fixed tunnel subdomain so Expo Go URL never rotates each launch
set "EXPO_TUNNEL_SUBDOMAIN=commanderpro"
set "PATH=%CD%\node_modules\.bin;%PATH%"

echo ============================================================
echo  IPhoneApp / Commander PRO
echo  Mode: TUNNEL + Expo Go  (friends outside your Wi-Fi)
echo ============================================================
echo.
echo  FIXED Expo Go URL (always the same):
echo     exp://commanderpro.ngrok.io:80
echo.
echo  Open that link ONLY in the Expo Go app (not Chrome/Safari).
echo  Opening in a browser causes platform header / middleware noise.
echo ============================================================
echo.

:: Kill stale Metro
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr ":8081" ^| findstr "LISTENING"') do (
  echo Killing old PID %%P on 8081...
  taskkill /F /PID %%P >nul 2>&1
)

:: Keep .expo\settings.json (fixed urlRandomness). Only drop devices list.
if exist ".expo\devices.json" del /q ".expo\devices.json" >nul 2>&1
if not exist ".expo" mkdir ".expo" >nul 2>&1
> ".expo\settings.json" (
  echo {
  echo   "hostType": "tunnel",
  echo   "lanType": "ip",
  echo   "dev": true,
  echo   "minify": false,
  echo   "urlRandomness": "commanderpro",
  echo   "https": false
  echo }
)

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
