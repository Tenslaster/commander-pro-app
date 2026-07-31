@echo off
setlocal EnableExtensions
title Commander PRO - Download Server
color 0B
cd /d "%~dp0.."

set "DOWNLOAD_PUBLIC_URL=https://crew.kingdom.forum/downloads"
set "DOWNLOAD_HOST=0.0.0.0"
set "DOWNLOAD_PORT=8787"

echo ========================================
echo  Crew Download Server
echo  Commander PRO + WithYou
echo ========================================
echo  https://crew.kingdom.forum/downloads
echo  https://crew.kingdom.forum/downloads/apk
echo  https://crew.kingdom.forum/downloads/ipa
echo  https://crew.kingdom.forum/downloads/withyou
echo  https://crew.kingdom.forum/downloads/withyou/apk
echo  https://crew.kingdom.forum/downloads/withyou/ipa
echo  https://crew.kingdom.forum/download/pulse
echo  https://crew.kingdom.forum/download/pulse/apk
echo  https://crew.kingdom.forum/download/pulse/ipa
echo.
echo  Local: http://127.0.0.1:%DOWNLOAD_PORT%/downloads
echo  Needs Cloudflare Tunnel path /downloads -^> :8787
echo  Keep this window open.
echo ========================================
echo.

where python >nul 2>&1 || (
  echo ERROR: python not found.
  pause
  exit /b 1
)

python download_server.py
echo.
echo Server stopped.
pause
endlocal
exit /b %ERRORLEVEL%

