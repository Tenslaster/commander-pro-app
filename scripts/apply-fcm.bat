@echo off
setlocal EnableExtensions
title Apply FCM files to Commander PRO
cd /d "%~dp0.."

echo ========================================
echo  Apply Firebase / FCM to project
echo ========================================
echo Package: com.commanderpro.radios
echo.

if not exist "google-services.json" (
  echo MISSING: google-services.json in project root
  echo Download from Firebase Console -^> Project settings -^> Your apps -^> Android
  echo See scripts\setup-fcm.md
  pause
  exit /b 1
)

if not exist "credentials" mkdir "credentials"
if not exist "credentials\fcm-service-account.json" (
  echo MISSING: credentials\fcm-service-account.json
  echo From Firebase -^> Project settings -^> Service accounts -^> Generate new private key
  echo Save as: credentials\fcm-service-account.json
  echo See scripts\setup-fcm.md
  pause
  exit /b 1
)

echo [1/3] Patch app.json googleServicesFile...
python -c "import json;from pathlib import Path;p=Path('app.json');d=json.loads(p.read_text(encoding='utf-8-sig'));d['expo']['android']['googleServicesFile']='./google-services.json';p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+chr(10),encoding='utf-8');print('OK googleServicesFile set')"

echo.
echo [2/3] Ensure .gitignore ignores private key...
findstr /C:"credentials/" .gitignore >nul 2>&1 || (
  echo.>>.gitignore
  echo # FCM private keys>>.gitignore
  echo credentials/>>.gitignore
  echo *-firebase-adminsdk-*.json>>.gitignore
)

echo.
echo [3/3] Upload FCM V1 key to EAS (interactive - follow prompts):
echo   Platform: Android
echo   Build profile / production credentials
echo   Google Service Account -^> FCM V1 -^> Upload
echo   File: credentials\fcm-service-account.json
echo.
set "PATH=C:\Program Files\nodejs;%PATH%"
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli credentials -p android

echo.
echo Next: rebuild APK
echo   scripts\build-apk.bat
echo Then reinstall on phone and login again.
echo.
pause
endlocal
exit /b 0
