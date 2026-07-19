@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Commander PRO - Build APK
color 0B
cd /d "%~dp0.."

set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\bin;%PATH%"
set "EXPO_PUBLIC_API_URL=https://crew.kingdom.forum/api"

echo ========================================
echo  Commander PRO - Android APK (EAS)
echo ========================================
echo  Output: dist\apk\CommanderPro.apk
echo  API:    %EXPO_PUBLIC_API_URL%
echo ========================================
echo.

where node >nul 2>&1 || (
  echo ERROR: Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)

echo [1/4] Expo login check...
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli whoami
if errorlevel 1 (
  call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli login
  if errorlevel 1 (
    echo Login failed.
    pause
    exit /b 1
  )
)

echo.
echo [2/4] Starting EAS APK build (10-20 min)...
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli build -p android --profile apk --non-interactive
if errorlevel 1 (
  echo BUILD FAILED
  pause
  exit /b 1
)

echo.
echo [3/4] Downloading latest APK into dist\apk\...
if not exist "dist\apk" mkdir "dist\apk"
call "%ProgramFiles%\nodejs\npx.cmd" --yes eas-cli build:list --platform android --limit 1 --json --non-interactive > "%TEMP%\eas-apk-last.json" 2>nul
python -c "import json,urllib.request,os,sys; raw=open(os.environ['TEMP']+r'\\eas-apk-last.json',encoding='utf-8').read(); i=raw.find('['); data=json.loads(raw[i:] if i>=0 else raw); b=data[0] if isinstance(data,list) else data; url=(b.get('artifacts') or {}).get('buildUrl') or (b.get('artifacts') or {}).get('applicationArchiveUrl');
assert url and b.get('status')=='FINISHED', b.get('status');
out=r'dist\\apk\\CommanderPro.apk';
req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'});
open(out,'wb').write(urllib.request.urlopen(req, timeout=300).read());
print('OK', out, os.path.getsize(out))"
if errorlevel 1 (
  echo WARN: auto-download failed. Get APK from https://expo.dev
  pause
  exit /b 1
)

echo.
echo [4/4] Done.
echo  File: dist\apk\CommanderPro.apk
echo  Page: https://crew.kingdom.forum/downloads
echo  Keep Start-Download-Server.bat running to serve it.
echo.
pause
endlocal
exit /b 0
