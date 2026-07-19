@echo off
setlocal EnableExtensions EnableDelayedExpansion
title iOS IPA Builder - Commander PRO
color 0A
cd /d "%~dp0"

set "PATH=C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;%PATH%"

echo ========================================
echo  iOS IPA BUILDER - Commander PRO
echo ========================================
echo Repo: https://github.com/Tenslaster/commander-pro-app
echo Uses GitHub Actions (macOS) - no Mac needed.
echo ========================================
echo.

where gh >nul 2>&1 || (
  echo ERROR: GitHub CLI not found.
  echo Install: winget install GitHub.cli
  goto :end
)
where git >nul 2>&1 || (
  echo ERROR: git not found.
  echo Install: winget install Git.Git
  goto :end
)

gh auth status
if errorlevel 1 (
  echo.
  echo You must log in to GitHub CLI once:
  echo   gh auth login --web
  echo Then re-run this bat.
  goto :end
)

echo.
echo [1/4] Ensuring latest code is on GitHub...
git add -A
git status --short
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Update before iOS build"
)
git push origin main
if errorlevel 1 (
  echo Push failed.
  goto :end
)
echo [OK] Pushed.

echo.
echo [2/4] Starting GitHub Actions iOS build...
for /f %%I in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N').Substring(0,12)"') do set "BUILD_ID=%%I"
echo build_id=!BUILD_ID!

gh workflow run "ios-build.yml" -f "build_id=!BUILD_ID!" -f "ios_path=ios" -f "use_signing=false" -f "configuration=Release"
if errorlevel 1 (
  echo Failed to start workflow. Is ios-build.yml on main?
  goto :end
)

echo.
echo [3/4] Waiting for run to appear...
timeout /t 5 /nobreak >nul
for /f "delims=" %%R in ('gh run list --workflow=ios-build.yml --limit 1 --json databaseId -q ".[0].databaseId"') do set "RUN_ID=%%R"
echo Run ID: !RUN_ID!
echo URL: https://github.com/Tenslaster/commander-pro-app/actions/runs/!RUN_ID!
echo.

echo [4/4] Watching build (can take 10-20 min on free GitHub Actions)...
echo Close this window only if you want to stop watching (build keeps running on GitHub).
echo.
gh run watch !RUN_ID!
set "ERR=!ERRORLEVEL!"

echo.
if "!ERR!"=="0" (
  echo ========================================
  echo  BUILD FINISHED - downloading artifacts...
  echo ========================================
  if not exist dist mkdir dist
  gh run download !RUN_ID! -D dist
  echo.
  echo Files in dist\:
  dir /b dist 2>nul
  echo.
  echo Open Actions page if download is empty:
  echo https://github.com/Tenslaster/commander-pro-app/actions/runs/!RUN_ID!
) else (
  echo ========================================
  echo  BUILD FAILED OR CANCELLED
  echo ========================================
  echo See logs:
  echo https://github.com/Tenslaster/commander-pro-app/actions/runs/!RUN_ID!
  echo.
  gh run view !RUN_ID! --log-failed 2>nul | more
)

:end
echo.
echo Press any key to close...
pause >nul
endlocal
exit /b 0
