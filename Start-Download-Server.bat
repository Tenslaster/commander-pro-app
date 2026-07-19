@echo off
REM Wrapper → scripts\start-download-server.bat
cd /d "%~dp0"
call "%~dp0scripts\start-download-server.bat"
exit /b %ERRORLEVEL%
