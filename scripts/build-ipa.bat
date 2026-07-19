@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Commander PRO - Build IPA
color 0A
cd /d "%~dp0.."

set "PATH=C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;%PATH%"

echo ========================================
echo  Commander PRO - iOS IPA (GitHub Actions)
echo ========================================
echo  Output: dist\ipa\CommanderPro.ipa
echo  Repo:   https://github.com/Tenslaster/commander-pro-app
echo ========================================
echo.

where gh >nul 2>&1 || (
  echo ERROR: GitHub CLI missing. winget install GitHub.cli
  pause
  exit /b 1
)
where git >nul 2>&1 || (
  echo ERROR: git missing. winget install Git.Git
  pause
  exit /b 1
)

gh auth status
if errorlevel 1 (
  echo Run: gh auth login --web
  pause
  exit /b 1
)

echo [1/5] Push latest code to GitHub...
git add -A
git status --short
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Update before iOS build"
)
git push origin main
if errorlevel 1 (
  echo Push failed.
  pause
  exit /b 1
)

echo.
echo [2/5] Start iOS workflow...
for /f %%I in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N').Substring(0,12)"') do set "BUILD_ID=%%I"
echo build_id=!BUILD_ID!
gh workflow run "ios-build.yml" -f "build_id=!BUILD_ID!" -f "ios_path=ios" -f "use_signing=false" -f "configuration=Release"
if errorlevel 1 (
  echo Failed to start workflow.
  pause
  exit /b 1
)

echo.
echo [3/5] Waiting for run...
timeout /t 6 /nobreak >nul
for /f "delims=" %%R in ('gh run list --workflow=ios-build.yml --limit 1 --json databaseId -q ".[0].databaseId"') do set "RUN_ID=%%R"
if "!RUN_ID!"=="" (
  echo Could not find run id.
  pause
  exit /b 1
)
echo Run: https://github.com/Tenslaster/commander-pro-app/actions/runs/!RUN_ID!

echo.
echo [4/5] Watching build...
gh run watch !RUN_ID! --exit-status
if errorlevel 1 (
  echo BUILD FAILED
  gh run view !RUN_ID! --log-failed 2>nul | more
  pause
  exit /b 1
)

echo.
echo [5/5] Download IPA to dist\ipa\...
if not exist "dist\ipa" mkdir "dist\ipa"
set "TMPDIR=%TEMP%\commander-ipa-!RUN_ID!"
if exist "!TMPDIR!" rmdir /s /q "!TMPDIR!"
mkdir "!TMPDIR!"
gh run download !RUN_ID! -D "!TMPDIR!" -n ipa
if errorlevel 1 (
  echo Download failed.
  pause
  exit /b 1
)

for /r "!TMPDIR!" %%F in (*.ipa) do (
  copy /y "%%F" "dist\ipa\CommanderPro.ipa" >nul
  if exist "ios-install" copy /y "%%F" "ios-install\CommanderPro.ipa" >nul
  echo OK dist\ipa\CommanderPro.ipa
  goto :copied
)
echo ERROR: no .ipa in artifacts
pause
exit /b 1

:copied
echo.
echo Done. Install with Sideloadly (USB + Apple ID).
echo Page: https://crew.kingdom.forum/downloads
echo.
pause
endlocal
exit /b 0
