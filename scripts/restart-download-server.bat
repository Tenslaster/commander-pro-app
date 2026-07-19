@echo off
cd /d "%~dp0.."
echo Stopping anything on port 8787...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /F /PID %%P 2>nul
timeout /t 2 /nobreak >nul
start "CommanderPRO-Downloads" /MIN python download_server.py
echo Restarted download_server.py
pause
