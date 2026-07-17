@echo off
setlocal EnableExtensions EnableDelayedExpansion
title iOS IPA Builder - Commander PRO
color 0A
cd /d "%~dp0"

set "LOG=%~dp0ios-builder-last-run.log"
set "PROJECT_WIN=%~dp0"
if "%PROJECT_WIN:~-1%"=="\" set "PROJECT_WIN=%PROJECT_WIN:~0,-1%"

set "PROJECT_WSL="
for /f "delims=" %%A in ('wsl wslpath -a "%PROJECT_WIN%" 2^>nul') do set "PROJECT_WSL=%%A"
if not defined PROJECT_WSL set "PROJECT_WSL=/mnt/c/Users/cedri/OneDrive/Bureau/RADIOS/AppIPhone/iphone-batch-manager"

> "%LOG%" (
  echo ==== iOS Builder run %DATE% %TIME% ====
  echo PROJECT_WIN=%PROJECT_WIN%
  echo PROJECT_WSL=!PROJECT_WSL!
)

echo ========================================
echo  iOS IPA BUILDER - Commander PRO
echo ========================================
echo Project: %PROJECT_WIN%
echo WSL path: !PROJECT_WSL!
echo Log: %LOG%
echo.
echo ios-builder needs a GitHub repo with remote "origin".
echo Your project had NO .git folder — this script will create it.
echo ========================================
echo.

:: ---------- 0) WSL ----------
call :step "0/6" "Checking WSL..."
where wsl >nul 2>&1 || call :fail "WSL not found." "Install Ubuntu from Microsoft Store."
wsl -e true 1>>"%LOG%" 2>&1 || call :fail "WSL will not start." "Open Ubuntu once from the Start menu."
call :ok "WSL OK"

:: ---------- 1) builder CLI ----------
call :step "1/6" "Checking ios-builder..."
wsl -e bash -lc "command -v builder" 1>>"%LOG%" 2>&1
if errorlevel 1 (
  echo Installing ios-builder globally in WSL...
  wsl -e bash -lc "npm install -g ios-builder"
  if errorlevel 1 call :fail "npm install -g ios-builder failed." "Install Node.js in WSL first."
)
call :ok "builder CLI found"

:: ---------- 2) project path ----------
call :step "2/6" "Checking project in WSL..."
wsl -e bash -lc "test -d '!PROJECT_WSL!' && cd '!PROJECT_WSL!' && pwd" 1>>"%LOG%" 2>&1
if errorlevel 1 call :fail "Project folder missing in WSL." "Path: !PROJECT_WSL!"
call :ok "Project folder OK"

:: ---------- 3) GitHub auth (no fake "status" command) ----------
call :step "3/6" "GitHub auth for builder..."
echo If a browser opens, log in to GitHub and authorize.
echo (Safe to run even if already logged in.)
echo.
wsl -e bash -lc "cd '!PROJECT_WSL!' && builder auth github"
if errorlevel 1 (
  call :log "builder auth github failed (exit !errorlevel!)"
  echo.
  echo [WARNING] builder auth github returned an error.
  echo Continue only if you are sure you are logged in.
  choice /C YN /M "Continue anyway"
  if errorlevel 2 call :fail "Stopped: GitHub auth required." "Run in WSL: builder auth github"
)
call :ok "GitHub auth step done"

:: ---------- 4) Git repo + origin (REQUIRED) ----------
call :step "4/6" "Setting up Git + GitHub remote..."

wsl -e bash -lc "command -v git" 1>>"%LOG%" 2>&1
if errorlevel 1 call :fail "Git missing in WSL." "sudo apt update && sudo apt install -y git"

:: Always ensure .git exists (show live output)
echo.
echo --- git init ---
wsl -e bash -lc "cd '!PROJECT_WSL!' && if [ ! -d .git ]; then git init && echo 'git init OK'; else echo 'Already a git repo'; fi"
if errorlevel 1 call :fail "git init failed." "Check OneDrive/WSL permissions on the project folder."

:: Ensure .gitignore exists (node_modules must not be pushed)
if not exist "%PROJECT_WIN%\.gitignore" (
  echo [INFO] Creating .gitignore...
  (
    echo node_modules/
    echo .expo/
    echo dist/
    echo .env
    echo *.log
  ) > "%PROJECT_WIN%\.gitignore"
)

:: Ensure origin remote
echo.
echo --- git remote ---
wsl -e bash -lc "cd '!PROJECT_WSL!' && git remote get-url origin" 1>>"%LOG%" 2>&1
if errorlevel 1 (
  echo.
  echo ========================================
  echo  ACTION REQUIRED - create GitHub repo
  echo ========================================
  echo 1. Open: https://github.com/new
  echo 2. Repository name e.g. commander-pro-app
  echo 3. Public or Private - your choice
  echo 4. DO NOT add README / .gitignore / license
  echo 5. Click Create repository
  echo 6. Copy the HTTPS URL, example:
  echo    https://github.com/YOUR_NAME/commander-pro-app.git
  echo ========================================
  echo.
  set "GITHUB_URL="
  set /p "GITHUB_URL=Paste GitHub HTTPS URL here: "
  if "!GITHUB_URL!"=="" call :fail "No URL pasted." "Run again and paste the GitHub URL."

  :: trim spaces
  set "GITHUB_URL=!GITHUB_URL: =!"
  call :log "Adding origin !GITHUB_URL!"
  echo Adding remote origin...
  wsl -e bash -lc "cd '!PROJECT_WSL!' && git remote remove origin 2>/dev/null; git remote add origin '!GITHUB_URL!' && git remote -v"
  if errorlevel 1 call :fail "git remote add failed." "URL invalid? Use https://github.com/user/repo.git"
) else (
  echo Existing origin:
  wsl -e bash -lc "cd '!PROJECT_WSL!' && git remote -v"
)

:: user.name / email if missing (required for commit)
wsl -e bash -lc "cd '!PROJECT_WSL!' && git config user.email >/dev/null 2>&1 || git config user.email 'builder@local'"
wsl -e bash -lc "cd '!PROJECT_WSL!' && git config user.name >/dev/null 2>&1 || git config user.name 'iOS Builder'"

echo.
echo --- git commit ---
wsl -e bash -lc "cd '!PROJECT_WSL!' && git add -A && (git status --short | head -30) && (git diff --cached --quiet && git diff --quiet && echo 'Nothing new to commit' || git commit -m 'Setup for ios-builder / EAS IPA')"
if errorlevel 1 (
  echo [WARNING] commit step had issues - see above. Continuing...
)

echo.
echo --- git push ---
echo If asked for password: use a GitHub Personal Access Token (not account password).
echo Token: GitHub.com -^> Settings -^> Developer settings -^> Personal access tokens
echo.
wsl -e bash -lc "cd '!PROJECT_WSL!' && git branch -M main && git push -u origin main"
if errorlevel 1 (
  echo.
  echo ========================================
  echo  git push FAILED
  echo ========================================
  echo Common fixes:
  echo  - Create the empty repo on GitHub first
  echo  - Use a Personal Access Token as password
  echo  - Repo URL must match: git remote -v
  echo.
  echo Open WSL and run:
  echo   cd "!PROJECT_WSL!"
  echo   git remote -v
  echo   git push -u origin main
  echo.
  choice /C YN /M "Retry push now"
  if errorlevel 2 call :fail "Need a successful git push before builder init." "Push from WSL then re-run this bat."
  wsl -e bash -lc "cd '!PROJECT_WSL!' && git push -u origin main"
  if errorlevel 1 call :fail "git push failed again." "Fix credentials in WSL, then re-run."
)

:: Verify origin is a github.com URL
wsl -e bash -lc "cd '!PROJECT_WSL!' && git remote get-url origin | grep -qi github.com"
if errorlevel 1 (
  call :fail "origin is not a GitHub URL." "ios-builder only works with github.com remotes."
)
call :ok "Git repo + origin + push OK"

echo.
echo --- builder init ---
wsl -e bash -lc "cd '!PROJECT_WSL!' && builder init"
if errorlevel 1 (
  call :log "builder init failed"
  call :fail "builder init failed." "Ensure origin is GitHub and auth works: builder auth github"
)
call :ok "Workflow init OK"

:: Commit workflow files if builder created them
wsl -e bash -lc "cd '!PROJECT_WSL!' && git add -A && (git diff --cached --quiet || git commit -m 'Add ios-builder workflow') && git push" 1>>"%LOG%" 2>&1

:: ---------- 5) Build ----------
call :step "5/6" "Building unsigned IPA..."
echo This can take several minutes. Watch for errors below.
echo.
call :log "builder ios build --unsigned"
wsl -e bash -lc "cd '!PROJECT_WSL!' && builder ios build --unsigned"
set "BUILD_ERR=!ERRORLEVEL!"
call :log "build exit=!BUILD_ERR!"

if not "!BUILD_ERR!"=="0" (
  echo.
  echo ========================================
  echo  BUILD FAILED  (code !BUILD_ERR!)
  echo ========================================
  echo Log: %LOG%
  goto :end
)

echo.
echo ========================================
echo  BUILD COMMAND FINISHED
echo ========================================
echo Check GitHub Actions artifacts and/or dist\ folder.
if exist "%PROJECT_WIN%\dist" (
  choice /C YN /M "Open dist folder"
  if !errorlevel! equ 1 start "" "%PROJECT_WIN%\dist"
)

:end
echo.
echo [6/6] Done.
echo Log: %LOG%
echo.
echo ========================================
echo  Press any key to close...
echo ========================================
pause >nul
endlocal
exit /b 0

:: ========== helpers ==========
:step
echo.
echo ----------------------------------------
echo [%~1] %~2
echo ----------------------------------------
call :log "[%~1] %~2"
exit /b 0

:ok
echo [OK] %~1
call :log "[OK] %~1"
exit /b 0

:log
if not "%~1"=="" >>"%LOG%" echo %~1
exit /b 0

:fail
echo.
echo ========================================
echo  ERROR
echo ========================================
echo %~1
if not "%~2"=="" echo.
if not "%~2"=="" echo Fix: %~2
echo.
echo Log file: %LOG%
echo.
echo ========================================
echo  Press any key to close...
echo ========================================
pause >nul
endlocal
exit /b 1
