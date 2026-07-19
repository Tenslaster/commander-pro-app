@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Auto FCM setup (after firebase login)
cd /d "%~dp0.."
set "PATH=C:\Program Files\nodejs;%PATH%"
set "PKG=com.commanderpro.radios"
set "PROJECT_ID=commander-pro-radios"

echo ========================================
echo  Auto FCM for Commander PRO Android
echo ========================================
echo Package: %PKG%
echo Firebase project id: %PROJECT_ID%
echo.

echo [1/6] Checking Firebase login...
call npx --yes firebase-tools login:list 2>nul | findstr /I "@" >nul
if errorlevel 1 (
  echo Not logged in. Opening browser - sign in with tenslaster@gmail.com
  call npx --yes firebase-tools login
)
call npx --yes firebase-tools login:list
if errorlevel 1 (
  echo Login failed.
  pause
  exit /b 1
)

echo.
echo [2/6] Create Firebase project if missing...
call npx --yes firebase-tools projects:list 2>nul | findstr /I "%PROJECT_ID%" >nul
if errorlevel 1 (
  echo Creating project %PROJECT_ID% ...
  call npx --yes firebase-tools projects:create %PROJECT_ID% --display-name "Commander PRO"
  if errorlevel 1 (
    echo Create failed - project id may be taken. Trying list...
    call npx --yes firebase-tools projects:list
    echo.
    set /p PROJECT_ID=Enter existing project id to use: 
  )
)

echo Using PROJECT_ID=%PROJECT_ID%
call npx --yes firebase-tools use %PROJECT_ID%

echo.
echo [3/6] Add Android app + get google-services.json ...
echo (Firebase CLI apps:create)
call npx --yes firebase-tools apps:list --project %PROJECT_ID% 2>nul
call npx --yes firebase-tools apps:create android --project %PROJECT_ID% --package-name %PKG% --display-name "Commander PRO" 2>nul
if not exist "credentials" mkdir "credentials"

echo Downloading google-services.json via apps:sdkconfig ...
call npx --yes firebase-tools apps:sdkconfig android --project %PROJECT_ID% -o google-services.json
if not exist "google-services.json" (
  echo WARN: auto google-services.json failed.
  echo Download manually from Firebase Console and place as google-services.json
)

echo.
echo [4/6] Service account key for FCM V1 (needs gcloud)...
where gcloud >nul 2>&1
if errorlevel 1 (
  echo gcloud not installed. Skipping auto service-account.
  echo Do this once in browser:
  echo   Firebase Console -^> Project settings -^> Service accounts -^> Generate new private key
  echo   Save as credentials\fcm-service-account.json
  echo Then re-run this script OR: scripts\apply-fcm.bat
  goto :patch_app
)

call gcloud config set project %PROJECT_ID%
echo Creating service account for FCM...
call gcloud iam service-accounts create commander-fcm --display-name "Commander PRO FCM" 2>nul
set "SA=commander-fcm@%PROJECT_ID%.iam.gserviceaccount.com"
call gcloud projects add-iam-policy-binding %PROJECT_ID% --member="serviceAccount:%SA%" --role="roles/firebase.messagingAdmin" 2>nul
call gcloud iam service-accounts keys create credentials\fcm-service-account.json --iam-account=%SA%
if exist "credentials\fcm-service-account.json" (
  echo Service account key OK
) else (
  echo Key create failed - use Firebase Console Generate new private key
)

:patch_app
echo.
echo [5/6] Patch app.json ...
python -c "import json;from pathlib import Path;p=Path('app.json');d=json.loads(p.read_text(encoding='utf-8-sig'));
import os
if Path('google-services.json').is_file():
  d['expo']['android']['googleServicesFile']='./google-services.json'
  p.write_text(json.dumps(d,indent=2,ensure_ascii=False)+chr(10),encoding='utf-8')
  print('googleServicesFile wired')
else:
  print('skip googleServicesFile - file missing')
"

echo.
echo [6/6] Upload FCM key to EAS if present...
if exist "credentials\fcm-service-account.json" (
  echo Run interactively:
  echo   npx eas-cli credentials -p android
  echo Choose: Google Service Account -^> FCM V1 -^> Upload credentials\fcm-service-account.json
  call npx --yes eas-cli credentials -p android
) else (
  echo No service account key yet - complete Generate Key in Firebase Console first.
)

echo.
echo Then rebuild: scripts\build-apk.bat
echo.
pause
endlocal
exit /b 0
