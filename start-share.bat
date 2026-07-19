@echo off
prompt $G
cd /d "%~dp0"
cls
color 0B
title Commander PRO - Share with friends (tunnel)

:: Fixed tunnel subdomain — same Expo Go URL every time
set "EXPO_TUNNEL_SUBDOMAIN=commanderpro"
set "EXPO_NO_TELEMETRY=1"

echo ============================================================
echo  Commander PRO - SHARE MODE (friends outside your Wi-Fi)
echo ============================================================
echo.
echo  FIXED Expo Go URL (always the same):
echo     exp://commanderpro.ngrok.io:80
echo.
echo  Your friend must:
echo    1. Install "Expo Go" from App Store / Play Store
echo    2. Open Expo Go (NOT Safari / Chrome / Instagram)
echo    3. Paste the FIXED link above (or scan QR)
echo.
echo  If they open the link in a browser, YOUR terminal will show:
echo    "Must specify expo-platform header or platform query"
echo  That is normal browser noise - it does NOT load the app.
echo ============================================================
echo.

echo Stopping any old Expo/Metro on port 8081...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :8081 ^| findstr LISTENING') do (
  taskkill /F /PID %%P >nul 2>&1
)

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

echo.
echo Checking Expo login (tunnel works better when logged in)...
call npx expo whoami
if errorlevel 1 (
  echo.
  echo Not logged in. Tunnel often fails without an Expo account.
  echo Creating / logging in now (free)...
  call npx expo login
)

echo.
echo Starting tunnel for Expo Go...
echo.
call npx expo start --tunnel --go

echo.
echo Server stopped.
pause
