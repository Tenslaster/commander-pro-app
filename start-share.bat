@echo off
prompt $G
cd /d "%~dp0"
cls
color 0B
title Commander PRO - Share with friends (tunnel)

echo ============================================================
echo  Commander PRO - SHARE MODE (friends outside your Wi-Fi)
echo ============================================================
echo.
echo  Your friend must:
echo    1. Install "Expo Go" from App Store / Play Store
echo    2. Open Expo Go (NOT Safari / Chrome / Instagram)
echo    3. Scan the QR code OR paste the exp:// link in Expo Go
echo.
echo  If they open the link in a browser, YOUR terminal will show:
echo    "Must specify expo-platform header or platform query"
echo  That is normal browser noise - it does NOT load the app.
echo.
echo ============================================================
echo.

echo Stopping any old Expo/Metro on port 8081...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :8081 ^| findstr LISTENING') do (
  taskkill /F /PID %%P >nul 2>&1
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
echo Wait until you see a QR code and an "exp://" or "https://u.expo.dev" URL.
echo Then send that to your friend + the instructions above.
echo.
call npx expo start --tunnel --go --clear

echo.
echo Server stopped.
pause
