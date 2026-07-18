@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Build Commander PRO APK (EAS)
color 0B
cd /d "%~dp0"

set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;%PATH%"

echo ========================================
echo  Commander PRO - Android APK build
echo ========================================
echo Uses Expo EAS cloud (needs free Expo account).
echo Profile: apk  (installable .apk, not Play Store AAB)
echo ========================================
echo.

where node >nul 2>&1 || (
  echo ERROR: Node.js not found.
  pause
  exit /b 1
)

echo [1/3] Checking Expo / EAS login...
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli whoami
if errorlevel 1 (
  echo.
  echo Not logged in. A browser will open - log in with your Expo account.
  echo Create one free at https://expo.dev if needed.
  echo.
  call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli login
  if errorlevel 1 (
    echo Login failed.
    pause
    exit /b 1
  )
)

echo.
echo [2/3] Starting Android APK build on EAS...
echo This takes ~10-20 minutes. Keep this window open.
echo API: EXPO_PUBLIC_API_URL=https://crew.kingdom.forum/api
echo.

set "EXPO_PUBLIC_API_URL=https://crew.kingdom.forum/api"
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli build -p android --profile apk --non-interactive
set "ERR=!ERRORLEVEL!"

echo.
echo [3/3] Done. Exit code: !ERR!
echo.
echo When finished, EAS prints a download URL for the .apk
echo Or open: https://expo.dev/accounts  -^> your project -^> Builds
echo.
echo Install on phone: download APK -^> allow Install unknown apps -^> open file
echo.
pause
endlocal
exit /b %ERR%
