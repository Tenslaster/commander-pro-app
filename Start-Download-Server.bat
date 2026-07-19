@echo off
setlocal EnableExtensions
title Commander PRO - downloads (crew.kingdom.forum/downloads)
color 0B
cd /d "%~dp0"

:: Public links people use
set "DOWNLOAD_PUBLIC_URL=https://crew.kingdom.forum/downloads"
set "DOWNLOAD_HOST=0.0.0.0"
set "DOWNLOAD_PORT=8787"

echo ========================================
echo  Commander PRO - Download Server
echo ========================================
echo  https://crew.kingdom.forum/downloads
echo  https://crew.kingdom.forum/downloads/apk
echo  https://crew.kingdom.forum/downloads/ipa
echo.
echo  Local: http://127.0.0.1:%DOWNLOAD_PORT%/downloads
echo  Keep this window open + Cloudflare Tunnel running.
echo ========================================
echo.

if not exist "dist\apk\CommanderPro.apk" echo [WARN] Missing dist\apk\CommanderPro.apk
if not exist "dist\ipa\CommanderPro.ipa" echo [WARN] Missing dist\ipa\CommanderPro.ipa

where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo ERROR: Python not found.
    pause
    exit /b 1
  )
  set "PY=py -3"
) else (
  set "PY=python"
)

echo Starting...
%PY% download_server.py
echo.
echo Stopped.
pause
endlocal
exit /b 0
