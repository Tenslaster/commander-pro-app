@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Finish GitHub + iOS Builder (one-time)
color 0B
cd /d "%~dp0"

set "PATH=C:\Program Files\Git\bin;C:\Program Files\GitHub CLI;%PATH%"
set "REPO_NAME=commander-pro-app"
set "PROJECT=%~dp0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"

echo ========================================
echo  ONE-TIME GitHub setup for ios-builder
echo ========================================
echo Project is already a git repo with a commit.
echo We need GitHub CLI login once (browser), then
echo this script creates the repo, pushes, and
echo runs builder init + build automatically.
echo ========================================
echo.

where gh >nul 2>&1 || (
  echo ERROR: gh not found. Install GitHub CLI first.
  pause
  exit /b 1
)
where git >nul 2>&1 || (
  echo ERROR: git not found.
  pause
  exit /b 1
)

gh auth status >nul 2>&1
if errorlevel 1 (
  echo.
  echo ========================================
  echo  LOG IN TO GITHUB CLI  (30 seconds)
  echo ========================================
  echo A code will appear. Then:
  echo   1. Open https://github.com/login/device
  echo   2. Paste the code
  echo   3. Approve access
  echo.
  echo Browser login to github.com alone is NOT enough.
  echo GitHub CLI needs its own token once.
  echo ========================================
  echo.
  gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 (
    echo Login failed.
    pause
    exit /b 1
  )
)

echo.
echo [OK] GitHub CLI authenticated.
for /f "delims=" %%U in ('gh api user -q .login') do set "GHUSER=%%U"
echo Logged in as: !GHUSER!
echo.

cd /d "%PROJECT%"
git config user.email "cedri@users.noreply.github.com" >nul 2>&1
git config user.name "!GHUSER!" >nul 2>&1

:: Create repo if missing
gh repo view "!GHUSER!/!REPO_NAME!" >nul 2>&1
if errorlevel 1 (
  echo Creating private repo !GHUSER!/!REPO_NAME! ...
  gh repo create "!REPO_NAME!" --private --source=. --remote=origin --description "Commander PRO Expo app"
  if errorlevel 1 (
    echo Create with remote failed, trying create then remote add...
    gh repo create "!REPO_NAME!" --private --description "Commander PRO Expo app"
    git remote remove origin 2>nul
    git remote add origin "https://github.com/!GHUSER!/!REPO_NAME!.git"
  )
) else (
  echo Repo already exists: !GHUSER!/!REPO_NAME!
  git remote remove origin 2>nul
  git remote add origin "https://github.com/!GHUSER!/!REPO_NAME!.git"
)

echo.
echo Pushing main...
git branch -M main
git push -u origin main
if errorlevel 1 (
  echo Push failed. Trying with gh as credential helper...
  gh auth setup-git
  git push -u origin main
  if errorlevel 1 (
    echo ERROR: push still failed.
    pause
    exit /b 1
  )
)

echo.
echo [OK] Code is on GitHub: https://github.com/!GHUSER!/!REPO_NAME!
echo.

:: builder init + build in WSL
set "WSL_PATH="
for /f "delims=" %%A in ('wsl wslpath -a "%PROJECT%" 2^>nul') do set "WSL_PATH=%%A"
if not defined WSL_PATH set "WSL_PATH=/mnt/c/Users/cedri/OneDrive/Bureau/RADIOS/AppIPhone/iphone-batch-manager"

echo Running builder init in WSL...
wsl -e bash -lc "cd '!WSL_PATH!' && builder auth github 2>/dev/null; builder init -v"
if errorlevel 1 (
  echo builder init failed - check builder auth github in WSL
  pause
  exit /b 1
)

echo Committing workflow files...
git add -A
git status --short
git diff --cached --quiet || git commit -m "Add ios-builder GitHub Actions workflow"
git push

echo.
echo Starting unsigned iOS build (may take several minutes)...
wsl -e bash -lc "cd '!WSL_PATH!' && builder ios build --unsigned"
set "ERR=!ERRORLEVEL!"

echo.
if "!ERR!"=="0" (
  echo ========================================
  echo  SUCCESS
  echo ========================================
  echo Repo: https://github.com/!GHUSER!/!REPO_NAME!
  echo Check GitHub Actions / dist for the IPA.
) else (
  echo ========================================
  echo  BUILD EXIT CODE !ERR!
  echo ========================================
  echo Repo is set up. Re-run build later with Ios-Builder.bat
  echo or: wsl -e bash -lc "cd '!WSL_PATH!' && builder ios build --unsigned"
)

echo.
echo Press any key to close...
pause >nul
endlocal
exit /b 0
